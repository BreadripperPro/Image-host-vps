#!/bin/bash
# Fresh Debian 13 install, run as root from /opt/imagehost.
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
if [[ $EUID -ne 0 || $PWD != /opt/imagehost ]]; then
    echo 'Run as root from /opt/imagehost: bash deploy/install.sh https://images.example.com [app-port] [http-port] [https-port]' >&2
    exit 1
fi
if [[ $# -lt 1 || $# -gt 4 ]]; then
    echo 'Usage: bash deploy/install.sh https://images.example.com [app-port] [http-port] [https-port]' >&2
    exit 1
fi
if [[ -e config.json ]]; then
    echo 'config.json already exists. Use deploy/update.sh from a separate uploaded release directory; see README.' >&2
    exit 1
fi
. /etc/os-release
if [[ $ID != debian || $VERSION_ID != 13 ]]; then
    echo 'This installer targets Debian 13.' >&2
    exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
printf 'phpmyadmin phpmyadmin/reconfigure-webserver multiselect\nphpmyadmin phpmyadmin/dbconfig-install boolean false\n' | debconf-set-selections
apt-get install -y nodejs npm mariadb-server nginx php-fpm php-mysql php-mbstring php-xml php-curl php-zip php-gd phpmyadmin openssl ca-certificates certbot python3-certbot-nginx
systemctl enable --now mariadb php8.4-fpm
if ! id imagehost >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /opt/imagehost --shell /usr/sbin/nologin imagehost
fi
npm ci --omit=dev --no-audit --no-fund
node scripts/configure-vps.js "$@"
systemctl restart mariadb
install -o root -g root -m 644 deploy/imagehost.service /etc/systemd/system/imagehost.service
ln -s /etc/nginx/sites-available/imagehost /etc/nginx/sites-enabled/imagehost
nginx -t
systemctl daemon-reload
systemctl enable --now imagehost nginx
systemctl reload nginx
echo 'Installed. Configure DNS and HTTPS as described in README before browser login.'
echo 'Database login: user imagehost; password in /opt/imagehost/config.json (root-readable).'
echo 'Generate management code: cd /opt/imagehost && node scripts/admin.js manage'
