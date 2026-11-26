'use strict';

// Configuration tests use an in-memory filesystem so no real installation
// settings or credentials are read. HTTP probes target temporary local servers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { healthOnce } = require('./update-vps');

const CONFIG_SOURCE = fs.readFileSync(path.join(__dirname, '../src/config.js'), 'utf8');
function savedConfig(overrides = {}) {
  return {
    database: { host: '127.0.0.1', port: 3306, database: 'imagehost', user: 'imagehost', password: 'test-only-local-password' },
    domain: 'https://images.example.com', host: '127.0.0.1', port: 3000,
    maxFileSizeMb: 25, publicIdLength: 6, managementTokenTtlMinutes: 20, uploadTokenTtlHours: null,
    trustProxy: true,
    codeGenerator: { enabled: true, url: 'https://codes.example.com', sharedSecret: 'a'.repeat(64) },
    ...overrides
  };
}
function loadConfig(config, now = Date.now()) {
  const module = { exports: {} };
  vm.runInNewContext(CONFIG_SOURCE, {
    module,
    __dirname: path.join(__dirname, '../src'),
    URL,
    Date: class extends Date { static now() { return now; } },
    require(name) {
      if (name === 'fs') return { readFileSync: () => JSON.stringify(config) };
      if (name === 'path') return path;
      throw new Error(`Unexpected configuration dependency: ${name}`);
    }
  }, { filename: 'src/config.js' });
  return module.exports.load();
}

test('valid deployment settings retain their limits, ports and expiry behavior', () => {
  const config = loadConfig(savedConfig());
  assert.equal(config.domain, 'https://images.example.com');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.database.port, 3306);
  assert.equal(config.database.connectionLimit, 10);
  assert.equal(config.database.connectTimeout, 10000);
  assert.equal(config.maxFileSizeBytes, 25 * 1024 * 1024);
  assert.equal(config.publicIdLength, 6);
  assert.equal(config.managementTokenTtlMinutes, 20);
  assert.equal(config.uploadTokenTtlHours, null);
  assert.equal(config.codeGenerator.enabled, true);
});

test('unsafe numeric configuration fails before creating unlimited uploads or broken token expiry', () => {
  const cases = [
    ['maxFileSizeMb', 'Infinity'], ['maxFileSizeMb', -1], ['maxFileSizeMb', 0],
    ['maxFileSizeMb', Number.MAX_VALUE], ['maxFileSizeMb', 0.00000000001],
    ['uploadTokenTtlHours', 'not-a-number'], ['uploadTokenTtlHours', 'Infinity'],
    ['managementTokenTtlMinutes', 'Infinity'], ['managementTokenTtlMinutes', 'not-a-number'],
    ['publicIdLength', 6.25], ['publicIdLength', 'Infinity'],
    ['maxFileSizeMb', true], ['uploadTokenTtlHours', {}]
  ];
  for (const [name, value] of cases) {
    assert.throws(() => loadConfig(savedConfig({ [name]: value })), new RegExp(name), `${name}=${String(value)}`);
  }
});

test('invalid database ports, pool sizes and timeout overflows are rejected', () => {
  for (const [name, value] of [['port', 65536], ['port', -1], ['connectionLimit', -1],
    ['connectionLimit', 1.5], ['connectTimeout', 'Infinity'], ['connectTimeout', 2147483648]]) {
    const config = savedConfig();
    config.database[name] = value;
    assert.throws(() => loadConfig(config), new RegExp(`database\\.${name}`));
  }
});

test('token configuration rejects Date overflow and expanded years beyond MySQL DATETIME', () => {
  const now = Date.parse('2026-11-26T00:00:59Z');
  const maxExpiry = Date.parse('9999-12-31T23:59:59Z');
  const lastMinutes = (maxExpiry - now) / 60000;
  assert.equal(new Date(now + (lastMinutes + 1) * 60000).getUTCFullYear(), 10000);
  for (const [name, value] of [
    ['managementTokenTtlMinutes', Number.MAX_VALUE], ['uploadTokenTtlHours', Number.MAX_VALUE],
    ['managementTokenTtlMinutes', lastMinutes + 1], ['uploadTokenTtlHours', (lastMinutes + 1) / 60]
  ]) {
    assert.throws(() => loadConfig(savedConfig({ [name]: value }), now), new RegExp(`${name}.*9999-12-31`));
  }
  assert.equal(loadConfig(savedConfig({ managementTokenTtlMinutes: lastMinutes }), now).managementTokenTtlMinutes, lastMinutes);
  assert.equal(loadConfig(savedConfig({ uploadTokenTtlHours: lastMinutes / 60 }), now).uploadTokenTtlHours, lastMinutes / 60);
});

test('numeric strings and existing defaults and clamps stay compatible', () => {
  const config = savedConfig({ maxFileSizeMb: '1.5', publicIdLength: '99', managementTokenTtlMinutes: -1, uploadTokenTtlHours: '0' });
  config.database.port = '3307';
  config.database.connectionLimit = '12';
  config.database.connectTimeout = '15000';
  const loaded = loadConfig(config);
  assert.equal(loaded.maxFileSizeBytes, 1.5 * 1024 * 1024);
  assert.equal(loaded.publicIdLength, 16);
  assert.equal(loaded.managementTokenTtlMinutes, 1);
  assert.equal(loaded.uploadTokenTtlHours, 1);
  assert.equal(loaded.database.port, 3307);
  assert.equal(loaded.database.connectionLimit, 12);
  assert.equal(loaded.database.connectTimeout, 15000);
  assert.equal(loadConfig(savedConfig({ managementTokenTtlMinutes: 0 })).managementTokenTtlMinutes, 20);
});

test('validated public origins are canonicalized without accepting paths or credentials', () => {
  assert.equal(loadConfig(savedConfig({ domain: 'https://IMAGES.EXAMPLE.COM:443/' })).domain, 'https://images.example.com');
  for (const domain of ['https://images.example.com/path', 'https://user:secret@images.example.com', '[https://images.example.com](https://images.example.com)']) {
    assert.throws(() => loadConfig(savedConfig({ domain })), /domain/);
  }
});

async function localHealthServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { domain: 'https://images.example.com', host: '127.0.0.1', port: server.address().port };
}

test('updater accepts only a successful JSON health response', async (t) => {
  const config = await localHealthServer(t, (request, response) => {
    assert.equal(request.headers.host, 'images.example.com');
    response.end('{"ok":true}');
  });
  assert.equal(await healthOnce(config), true);
});

test('updater health deadline bounds continuously trickling incomplete responses', { timeout: 3000 }, async (t) => {
  const config = await localHealthServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"ok":');
    const trickle = setInterval(() => response.write(' '), 10);
    const end = setTimeout(() => response.end(), 900);
    response.once('close', () => { clearInterval(trickle); clearTimeout(end); });
  });
  const start = performance.now();
  assert.equal(await healthOnce(config, 100), false);
  assert.ok(performance.now() - start < 650, 'a response cannot extend the absolute probe deadline by sending bytes');
});

test('updater rejects truncated and oversized health responses', async (t) => {
  const truncated = await localHealthServer(t, (request, response) => {
    response.writeHead(200);
    response.write('{"ok":');
    setImmediate(() => response.destroy());
  });
  assert.equal(await healthOnce(truncated), false);
  const oversized = await localHealthServer(t, (request, response) => response.end(' '.repeat(1200)));
  assert.equal(await healthOnce(oversized), false);
});

async function bootstrap() {
  const handlers = new Map();
  const exits = [];
  const errors = [];
  const config = { database: {}, uploadsDir: 'virtual-uploads', port: 3000, host: '127.0.0.1', domain: 'https://images.example.com' };
  const logger = { paint: (color, text) => text, info() {}, error: (...args) => errors.push(args) };
  const server = { on() {}, close(callback) { callback(); } };
  const dependencies = {
    './src/config': { load: () => config, ensureUploadsDir() {}, resolvePort: () => ({ port: 3000, source: 'test' }) },
    './src/logger': logger,
    './src/db': { connect: async () => {}, initializeSchema: async () => {}, close: async () => {} },
    './src/session': { loadOrCreateSecret: () => 'test-only-session-secret' },
    './src/server': { createApp: () => ({ listen: () => server }) },
    './src/console': { createConsoleHandler: () => ({ attach() {} }) }
  };
  const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  await vm.runInNewContext(source, {
    console: { error() {} },
    process: { on: (event, handler) => handlers.set(event, handler), exit: (code) => exits.push(code) },
    setTimeout: () => ({ unref() {} }),
    require: (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected bootstrap dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename: 'index.js' });
  return { handlers, exits, errors };
}

test('fatal uncaught exceptions and unhandled rejections allow systemd to restart the application', async () => {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    const app = await bootstrap();
    assert.deepEqual(app.exits, [], 'normal startup remains running');
    assert.ok(app.handlers.has(event));
    app.handlers.get(event)(new Error('simulated fatal application failure'));
    assert.deepEqual(app.exits, [1], `${event} must not leave the broken service running`);
    assert.ok(app.errors.some((entry) => entry.includes('simulated fatal application failure')));
  }
});
