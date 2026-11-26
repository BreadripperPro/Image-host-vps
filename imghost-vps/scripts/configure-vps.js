'use strict';

// Called by deploy/install.sh after Debian packages and the service user exist.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { normalizeDomain, resolvePort, ensureUploadsDir } = require('../src/config');

function deploymentOptions(domain, port = 3000, httpPort = 80, httpsPort = 443) {
  const url = new URL(normalizeDomain(domain));
  // Restrict template substitutions to DNS names / IPv4 and integer ports.
  if (!['https:', 'http:'].includes(url.protocol) || !/^[a-z0-9][a-z0-9.-]*$/i.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an HTTP(S) domain without a path or port, e.g. https://images.example.com');
  }
  const appPort = resolvePort(port).port;
  const http = resolvePort(httpPort).port;
  const https = resolvePort(httpsPort).port;
  if (new Set([appPort, http, https, 3306]).size !== 4) throw new Error('Node, Nginx HTTP, Nginx HTTPS and MariaDB must use different ports.');
  return { domain: url.origin, hostname: url.hostname, port: appPort, httpPort: http, httpsPort: https };
}

function renderNginx(template, options, maxFileSizeMb, tls = null) {
  if (!Number.isFinite(Number(maxFileSizeMb)) || Number(maxFileSizeMb) <= 0) throw new Error('maxFileSizeMb must be a positive number.');
  let tlsListen = '# HTTPS is enabled when certificate paths are configured.';
  if (tls) {
    for (const file of [tls.certificate, tls.key]) {
      if (typeof file !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(file)) throw new Error('Certificate paths must be absolute Linux paths without spaces or Nginx syntax.');
    }
    tlsListen = `listen ${options.httpsPort} ssl;\n    listen [::]:${options.httpsPort} ssl;\n    ssl_certificate ${tls.certificate};\n    ssl_certificate_key ${tls.key};\n    ssl_protocols TLSv1.2 TLSv1.3;`;
  }
  return template.replaceAll('SERVER_NAME', options.hostname)
    .replaceAll('APP_PORT', String(options.port))
    .replaceAll('HTTP_PORT', String(options.httpPort))
    .replaceAll('TLS_LISTEN', tlsListen)
    .replaceAll('BODY_LIMIT', String(Math.ceil(maxFileSizeMb) + 1));
}

function main() {
  const options = deploymentOptions(process.argv[2], process.argv[3], process.argv[4], process.argv[5]);
  const root = path.resolve(__dirname, '..');
  if (process.platform !== 'linux' || process.getuid() !== 0 || root !== '/opt/imagehost') {
    throw new Error('Run through deploy/install.sh as root in /opt/imagehost on Debian 13.');
  }
  for (const file of [path.join(root, 'config.json'), '/etc/nginx/sites-available/imagehost', '/etc/nginx/sites-enabled/imagehost', '/etc/phpmyadmin/conf.d/imagehost.php', '/etc/mysql/mariadb.conf.d/99-imagehost.cnf']) {
    if (fs.existsSync(file)) throw new Error(`Refusing to overwrite ${file}; see README for updates.`);
  }
  const password = crypto.randomBytes(32).toString('hex');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  Object.assign(config, { domain: options.domain, port: options.port, phpMyAdminEnabled: true });
  config.nginx = { httpPort: options.httpPort, httpsPort: options.httpsPort, sslCertificate: null, sslCertificateKey: null };
  config.database.password = password;

  // Fixed SQL identifiers and a generated hex password; never interpolate input.
  execFileSync('mariadb', ['--protocol=socket', '--user=root'], {
    input: `CREATE DATABASE IF NOT EXISTS imagehost CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'imagehost'@'localhost' IDENTIFIED BY '${password}';
GRANT ALL PRIVILEGES ON imagehost.* TO 'imagehost'@'localhost';
`, stdio: ['pipe', 'inherit', 'inherit']
  });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o640 });
  ensureUploadsDir(path.join(root, 'uploads'));
  // Root owns program code; the service can write only uploads and its secret.
  execFileSync('chown', ['-R', 'root:imagehost', root]);
  execFileSync('chmod', ['-R', 'g+rX,go-w', root]);
  fs.chmodSync(root, 0o750);
  fs.chmodSync(path.join(root, 'config.json'), 0o640);
  if (!fs.existsSync(path.join(root, '.session-secret'))) {
    fs.writeFileSync(path.join(root, '.session-secret'), crypto.randomBytes(48).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  execFileSync('chown', ['imagehost:imagehost', path.join(root, '.session-secret')]);
  fs.chmodSync(path.join(root, '.session-secret'), 0o600);
  execFileSync('chown', ['-R', 'imagehost:imagehost', path.join(root, 'uploads')]);
  fs.chmodSync(path.join(root, 'uploads'), 0o700);

  fs.writeFileSync('/etc/nginx/sites-available/imagehost', renderNginx(fs.readFileSync(path.join(root, 'deploy/nginx.conf'), 'utf8'), options, config.maxFileSizeMb), { flag: 'wx', mode: 0o644 });
  fs.writeFileSync('/etc/phpmyadmin/conf.d/imagehost.php', `<?php
// Local MariaDB only. The Nginx management-session gate is an additional layer.
$cfg['blowfish_secret'] = '${crypto.randomBytes(16).toString('hex')}';
$cfg['Servers'] = [];
$i = 1;
$cfg['Servers'][$i]['host'] = '127.0.0.1';
$cfg['Servers'][$i]['port'] = '3306';
$cfg['Servers'][$i]['auth_type'] = 'cookie';
$cfg['Servers'][$i]['AllowRoot'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['AllowArbitraryServer'] = false;
$cfg['PmaAbsoluteUri'] = '${options.domain}/phpmyadmin/';
`, { flag: 'wx', mode: 0o644 });
  fs.writeFileSync('/etc/mysql/mariadb.conf.d/99-imagehost.cnf', '[mysqld]\nbind-address = 127.0.0.1\n', { flag: 'wx', mode: 0o644 });
  console.log('Created local database and config.json. Credentials are not printed or sent to the browser.');
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { deploymentOptions, renderNginx };
