'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const MAX_TOKEN_EXPIRY_MS = Date.parse('9999-12-31T23:59:59Z');

const PLACEHOLDER_VALUES = new Set([
  'your_database_username',
  'your_database_password',
  'your_database_name',
  'your_password',
  'your_username',
  'password',
  'changeme',
  'change_me',
  'todo',
  ''
]);

class ConfigError extends Error {}

function looksLikePlaceholder(value) {
  if (typeof value !== 'string') return true;
  const v = value.trim().toLowerCase();
  if (PLACEHOLDER_VALUES.has(v)) return true;
  return v.includes('your_') || v.includes('xxx') || v.includes('<') || v.includes('example');
}

function normalizeDomain(domain) {
  if (!domain) return '';
  let d = String(domain).trim();
  if (!d) return '';
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
  return d.replace(/\/+$/, '');
}

function readConfigFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ConfigError(
        `Configuration file not found: ${filePath}\n` +
          `Create it by copying config.example.json -> config.json and filling in your\n` +
          `local database credentials (see README.md or deploy/install.sh).`
      );
    }
    throw new ConfigError(`Could not read ${filePath}: ${err.message}`);
  }

  try {
    // Strip a UTF-8 BOM if present (Windows editors add one silently).
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

function validate(fileConfig) {
  const errors = [];
  const db = fileConfig.database;
  const validateNumber = (value, name, { integer = false, min = -Infinity, max = Infinity } = {}) => {
    if (value === undefined || value === null) return undefined;
    const numeric = (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? Number(value) : NaN;
    if (!Number.isFinite(numeric) || (integer && !Number.isSafeInteger(numeric)) || numeric < min || numeric > max) {
      errors.push(`"${name}" must be a finite ${integer ? 'integer' : 'number'}${min > -Infinity ? ` >= ${min}` : ''}${max < Infinity ? ` and <= ${max}` : ''}.`);
      return undefined;
    }
    return numeric;
  };

  if (!db || typeof db !== 'object' || Array.isArray(db)) {
    errors.push('"database" section is missing.');
  } else {
    if (!db.host) errors.push('"database.host" is missing.');
    if (!db.database) errors.push('"database.database" is missing.');
    if (looksLikePlaceholder(db.user)) {
      errors.push('"database.user" still contains a placeholder value.');
    }
    if (looksLikePlaceholder(db.password)) {
      errors.push('"database.password" still contains a placeholder value.');
    }
    validateNumber(db.port, 'database.port', { integer: true, min: 1, max: 65535 });
    validateNumber(db.connectionLimit, 'database.connectionLimit', { integer: true, min: 1 });
    validateNumber(db.connectTimeout, 'database.connectTimeout', { integer: true, min: 1, max: 2147483647 });
  }

  const maxMb = validateNumber(fileConfig.maxFileSizeMb, 'maxFileSizeMb', { min: 0 });
  if (maxMb !== undefined && (!Number.isSafeInteger(Math.round(maxMb * 1024 * 1024)) || Math.round(maxMb * 1024 * 1024) < 1)) {
    errors.push('"maxFileSizeMb" must resolve to a positive, safely representable byte limit.');
  }
  validateNumber(fileConfig.publicIdLength, 'publicIdLength', { integer: true });
  const managementTtl = validateNumber(fileConfig.managementTokenTtlMinutes, 'managementTokenTtlMinutes');
  const uploadTtl = validateNumber(fileConfig.uploadTokenTtlHours, 'uploadTokenTtlHours');
  const validateExpiry = (ttlMinutes, name) => {
    const expiry = Date.now() + Math.round(ttlMinutes) * 60000;
    if (!Number.isFinite(expiry) || expiry > MAX_TOKEN_EXPIRY_MS) {
      errors.push(`"${name}" must produce an expiry no later than 9999-12-31 23:59:59 UTC.`);
    }
  };
  // Validate the same defaults/clamps and minute rounding used for issuance.
  if (managementTtl !== undefined) validateExpiry(Math.max(managementTtl || 20, 1), 'managementTokenTtlMinutes');
  if (uploadTtl !== undefined) validateExpiry(Math.max(uploadTtl, 1) * 60, 'uploadTokenTtlHours');

  try {
    const url = new URL(normalizeDomain(fileConfig.domain));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  } catch {
    errors.push('"domain" must be an HTTP(S) origin, for example https://images.your-domain.com.');
  }
  try { resolvePort(fileConfig.port); } catch (err) { errors.push(err.message); }
  if (fileConfig.host !== undefined && (typeof fileConfig.host !== 'string' || !fileConfig.host.trim())) {
    errors.push('"host" must be a non-empty listen address.');
  }
  if (fileConfig.phpMyAdminEnabled !== undefined && typeof fileConfig.phpMyAdminEnabled !== 'boolean') {
    errors.push('"phpMyAdminEnabled" must be true or false.');
  }
  try { normalizeCodeGenerator(fileConfig.codeGenerator); } catch (err) { errors.push(err.message); }
  if (fileConfig.codeGenerator?.enabled === true && (fileConfig.trustProxy !== true || (fileConfig.host && fileConfig.host !== '127.0.0.1'))) {
    errors.push('Remote code generation requires host "127.0.0.1" and trustProxy true behind the supplied HTTPS Nginx proxy.');
  }

  return errors;
}

function normalizeCodeGenerator(value) {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('"codeGenerator" must be an object.');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new ConfigError('"codeGenerator.enabled" must be true or false.');
  const enabled = value.enabled === true;
  const sharedSecret = value.sharedSecret === undefined ? '' : value.sharedSecret;
  if (typeof sharedSecret !== 'string' || (sharedSecret && !/^[a-f0-9]{64,128}$/i.test(sharedSecret)) || (enabled && !sharedSecret)) {
    throw new ConfigError('"codeGenerator.sharedSecret" must be 64–128 hex characters. Generate it with openssl rand -hex 32.');
  }
  const url = value.url === undefined ? 'https://codes.example.com' : value.url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
    return { enabled, sharedSecret, url: parsed.origin };
  } catch { throw new ConfigError('"codeGenerator.url" must be an HTTPS origin without credentials or a path.'); }
}

/**
 * Resolve the listening port.
 *
 * The VPS listen port is controlled by config.json. Environment variables
 * from an old hosting panel deliberately have no effect.
 */
function resolvePort(filePort) {
  if (filePort === null || filePort === undefined) return { port: 3000, source: 'default' };
  const port = Number(filePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('"port" must be an integer between 1 and 65535.');
  }
  return { port, source: 'config.json "port"' };
}

function load() {
  const fileConfig = readConfigFile(CONFIG_PATH);

  if (typeof fileConfig !== 'object' || fileConfig === null || Array.isArray(fileConfig)) {
    throw new ConfigError(`${CONFIG_PATH} must contain a JSON object.`);
  }

  const errors = validate(fileConfig);
  if (errors.length) {
    throw new ConfigError(
      `Invalid configuration in ${CONFIG_PATH}:\n` +
        errors.map((e) => `  - ${e}`).join('\n') +
        `\n\nFix config.json (see config.example.json) and restart the server.`
    );
  }

  const db = fileConfig.database;
  const uploadsDir = path.resolve(ROOT_DIR, fileConfig.uploadsDir || 'uploads');

  return {
    rootDir: ROOT_DIR,
    configPath: CONFIG_PATH,
    database: {
      host: db.host,
      port: Number(db.port) || 3306,
      database: db.database,
      user: db.user,
      password: db.password,
      connectionLimit: Number(db.connectionLimit) || 10,
      connectTimeout: Number(db.connectTimeout) || 10000
    },
    domain: new URL(normalizeDomain(fileConfig.domain)).origin,
    // Kept verbatim; index.js resolves the final value via resolvePort().
    port: fileConfig.port === undefined ? null : fileConfig.port,
    host: fileConfig.host || '127.0.0.1',
    phpMyAdminEnabled: fileConfig.phpMyAdminEnabled === true,
    codeGenerator: normalizeCodeGenerator(fileConfig.codeGenerator),
    uploadsDir,
    publicDir: path.join(ROOT_DIR, 'public'),
    maxFileSizeBytes: Math.round((Number(fileConfig.maxFileSizeMb) || 25) * 1024 * 1024),
    allowSvg: fileConfig.allowSvg === true,
    publicIdLength: Math.min(Math.max(Number(fileConfig.publicIdLength) || 6, 4), 16),
    managementTokenTtlMinutes: Math.max(Number(fileConfig.managementTokenTtlMinutes) || 20, 1),
    uploadTokenTtlHours:
      fileConfig.uploadTokenTtlHours === null || fileConfig.uploadTokenTtlHours === undefined
        ? null
        : Math.max(Number(fileConfig.uploadTokenTtlHours), 1),
    trustProxy: fileConfig.trustProxy === true,
    sessionSecretFile: path.join(ROOT_DIR, '.session-secret')
  };
}

function ensureUploadsDir(uploadsDir) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  // Extra protection for Apache users; Express serves files only via /i/:id.
  const guard = path.join(uploadsDir, '.htaccess');
  if (!fs.existsSync(guard)) {
    fs.writeFileSync(guard, 'Options -Indexes\nRemoveHandler .php .phtml .pl .py .cgi\n');
  }
  const readme = path.join(uploadsDir, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, 'Uploaded images are stored here. Files are served only via /i/:id.\n');
  }
}

module.exports = { load, ensureUploadsDir, normalizeDomain, resolvePort, readConfigFile, normalizeCodeGenerator, ConfigError, CONFIG_PATH, ROOT_DIR };
