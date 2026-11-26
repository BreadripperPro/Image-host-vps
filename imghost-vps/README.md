# Image Host — VPS install and update

A self-hosted image service with single-use upload codes, direct image URLs,
custom names, and a management page. Files and MariaDB metadata stay on your VPS.
Generate codes over SSH or use the optional private web generator.

This quick start needs a **fresh Debian 13 VPS with root access**, a domain,
and a Cloudflare account. It installs Node.js, MariaDB, Nginx, PHP-FPM, phpMyAdmin,
and automatic startup. Already installed? See [Update an existing VPS](#6-update-an-existing-vps).

**Replace every example domain and `YOUR_SERVER_IP` with your own values.**
The examples use `images.example.com` and standard ports:

| Service | Port | Access |
| --- | --- | --- |
| SSH/SFTP | `22` | Server administration |
| Nginx HTTP / HTTPS | `80` / `443` | Public web traffic |
| Node app | `127.0.0.1:3000` | Local only |
| MariaDB | `127.0.0.1:3306` | Local only |

## 1. Upload and install

Point a proxied Cloudflare DNS record for `images.example.com` at your VPS.
Allow SSH and TCP `80`/`443` in any server/provider firewall. Keep the Node and
MariaDB ports private.

```bash
ssh root@YOUR_SERVER_IP
mkdir -p /opt/imagehost
```

Using SFTP on port `22`, upload the **contents of `imghost-vps/`** into
`/opt/imagehost`. `index.js` must be directly inside that directory. Include
the package files, `config.example.json`, `README.md`, and the `src/`, `public/`,
`scripts/`, and `deploy/` directories. Exclude local `config.json`,
`.session-secret`, `node_modules/`, `.npm/`, and `uploads/`.

```bash
cd /opt/imagehost
bash deploy/install.sh https://images.example.com 3000 80 443
curl -fsS -H 'Host: images.example.com' http://127.0.0.1/api/health
```

The health response should be `{"ok":true}`. The arguments are the public
domain, Node port, Nginx HTTP port, and Nginx HTTPS port. For custom origin
ports, change the last two arguments and match your firewall/proxy routing.
The installer creates database `imagehost` and a generated database password.
HTTP is ready now; complete HTTPS below before browser login. Use the updater,
not this fresh installer, on an existing installation.

## 2. Enable HTTPS

In Cloudflare, open **SSL/TLS → Origin Server** and create an Origin CA
certificate for your image hostname. Upload the certificate PEM and its matching
private key by root SFTP to these paths, then set permissions:

```bash
chown root:root /etc/ssl/certs/imagehost-origin.pem /etc/ssl/private/imagehost-origin.key
chmod 644 /etc/ssl/certs/imagehost-origin.pem
chmod 600 /etc/ssl/private/imagehost-origin.key
```

Keep the private key secret. Save these paths while preserving other settings:

```bash
cd /opt/imagehost
node <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
config.nginx.sslCertificate = '/etc/ssl/certs/imagehost-origin.pem';
config.nginx.sslCertificateKey = '/etc/ssl/private/imagehost-origin.key';
fs.writeFileSync('config.json', JSON.stringify(config, null, 2) + '\n');
NODE
```

Generate the Nginx site, keeping a backup and restoring it if validation fails:

```bash
cd /opt/imagehost
(
  set -e
  node scripts/nginx-config.js > /root/imagehost-nginx.candidate
  cp -a /etc/nginx/sites-available/imagehost /root/imagehost-nginx.backup
  install -m 644 /root/imagehost-nginx.candidate /etc/nginx/sites-available/imagehost
  if ! nginx -t; then
    cp -a /root/imagehost-nginx.backup /etc/nginx/sites-available/imagehost
    exit 1
  fi
  systemctl reload nginx
)
```

In Cloudflare, select **Full (strict)** and keep the DNS record proxied. The
HTTPS origin is port `443` here; any custom origin rule must match your saved
Nginx HTTPS port and retain your hostname as the Host header and TLS server
name. Keep `domain` in `config.json` as `https://images.example.com`, without
an origin port. Origin CA secures the Cloudflare-to-VPS connection; this setup
requires no Certbot command.

```bash
curl -fsS https://images.example.com/api/health
```

Continue when the public response is `{"ok":true}`.

## 3. Upload and manage images

Generate a single-use upload code over SSH:

```bash
cd /opt/imagehost
node scripts/admin.js code
```

Open `https://images.example.com/`, enter the code, and upload an image. To
manage images, run `node scripts/admin.js manage`, then enter that code at
`https://images.example.com/manage`. Management codes expire after 20 minutes
by default. Issuing a new code replaces the previous code of that type; a new
management code also invalidates the previous management session.

After management login, choose **Open phpMyAdmin**. Use database username
`imagehost` and the generated `database.password` from
`/opt/imagehost/config.json`, read privately over SSH/SFTP. phpMyAdmin also has
its own database login and uses the same web ports; it needs no extra port.
If an import removes the `tokens` table, `/manage` provides a recovery link to
phpMyAdmin. Restore the application tables and refresh the page.

## 4. Settings and optional code generator

Settings live in `/opt/imagehost/config.json`. Common settings include
`maxFileSizeMb` (default `25`), `allowSvg` (default `false`), code expiry, and
the public `domain`. Keep `host` as `127.0.0.1` and `trustProxy` as `true` behind
the supplied Nginx proxy. Restart after application setting changes:

```bash
systemctl restart imagehost
systemctl status imagehost --no-pager
journalctl -u imagehost -n 50 --no-pager
```

After changing Nginx ports, certificate paths, or the upload limit, regenerate
and validate the Nginx site with the block in step 2. Match any proxy rules.
The app, MariaDB, Nginx, and PHP-FPM start automatically after a VPS reboot.

For a private generator such as `https://codes.example.com`, follow the
[optional generator guide](../codegen-cf/README.md) for its shared secret and
Cloudflare Access setup. Protect its hostname while keeping image links public.

## 5. Restore or migrate existing images

Back up **both the database and the original upload files**. Restoring SQL
alone does not restore images. Import compatible records and copy the original
files into your configured `uploadsDir`, retaining their stored filenames and
giving the `imagehost` service user access. Review an import before replacing
existing tables; the installer/updater does not automatically overwrite them.
Avoid restarts or updates during imports: startup adds missing application tables.

```bash
cd /opt/imagehost
npm run check-storage
```

This check reports missing files and size mismatches without changing data.
A missing image file returns an uncached `404` and keeps its database record;
restoring the original file makes the same image URL usable again.

## 6. Update an existing VPS

Over root SSH, create a new, empty upload directory outside `/opt/imagehost`:

```bash
mkdir -m 700 /root/imagehost-update
```

Upload the complete new `imghost-vps/` contents there, using the file list in
step 1. Use a different empty directory if that path already exists. Then run:

```bash
bash /root/imagehost-update/deploy/update.sh
```

The updater prepares dependencies, backs up code, restarts, and checks health.
It preserves `config.json`, `.session-secret`, uploads, database records, and
custom service settings. Allow npm access, room for the release and backup, and
a brief restart interruption. Failed startup triggers an automatic restore
attempt. Add new feature settings yourself; example settings are not merged.

To also regenerate Nginx from your saved configuration, run the command with
`--refresh-nginx`; this replaces manual site edits after backing them up and
validating the candidate. The updater prints a backup path under
`/opt/imagehost-backups/`. To restore a selected code version:

```bash
bash /root/imagehost-update/deploy/update.sh --rollback /opt/imagehost-backups/BACKUP_NAME
```

Code backups and rollback do not restore database contents or deleted images.
Keep separate database-and-uploads backups, especially before schema changes.
The optional generator is updated separately using its linked guide.
