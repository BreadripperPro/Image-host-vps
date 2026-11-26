'use strict';

// Prints a candidate configuration only. Never overwrites the active site,
// touches the database, or reloads services. See README for validation/install.
const fs = require('fs');
const path = require('path');
const { readConfigFile, CONFIG_PATH } = require('../src/config');
const { deploymentOptions, renderNginx } = require('./configure-vps');

function generate(config) {
  const nginx = config.nginx || {};
  const options = deploymentOptions(config.domain, config.port ?? 3000, nginx.httpPort ?? 80, nginx.httpsPort ?? 443);
  if (config.host && config.host !== '127.0.0.1') throw new Error('This Nginx template requires the app host to be 127.0.0.1.');
  if (Boolean(nginx.sslCertificate) !== Boolean(nginx.sslCertificateKey)) throw new Error('Configure both sslCertificate and sslCertificateKey, or neither.');
  const tls = nginx.sslCertificate ? { certificate: nginx.sslCertificate, key: nginx.sslCertificateKey } : null;
  return renderNginx(fs.readFileSync(path.join(__dirname, '../deploy/nginx.conf'), 'utf8'), options, config.maxFileSizeMb ?? 25, tls);
}

if (require.main === module) {
  try { process.stdout.write(generate(readConfigFile(CONFIG_PATH))); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { generate };
