'use strict';

/**
 * Development self-test. Boots the real Express app against an in-memory
 * stand-in for MySQL so the whole HTTP flow (auth separation, slug rules,
 * image serving, deletion) can be verified without real credentials.
 *
 * Run with:  node scripts/selftest.js
 * Never loaded by index.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../src/db');
const store = require('../src/store');
const session = require('../src/session');
const { createApp } = require('../src/server');
const { resolvePort } = require('../src/config');

/* ------------------------------------------------------------------ *
 * In-memory database stub matching the SQL used by src/store.js
 * ------------------------------------------------------------------ */
const TABLES = { images: [], tokens: [], code_requests: [] };
const missingTables = new Set();
let simulatedDatabaseError = null;
const executedSql = [];
let nextImagesId = 1;
let nextTokensId = 1;

const stamp = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

function assertTableAvailable(table) {
  if (simulatedDatabaseError) throw simulatedDatabaseError;
  if (missingTables.has(table)) {
    const err = new Error(`Table '${table}' doesn't exist`);
    err.code = 'ER_NO_SUCH_TABLE';
    err.errno = 1146;
    throw err;
  }
}

db.query = async function query(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  executedSql.push(s);
  if (simulatedDatabaseError) throw simulatedDatabaseError;
  for (const table of ['tokens', 'images', 'code_requests']) {
    if (s.includes('`' + table + '`')) assertTableAvailable(table);
  }

  if (s === 'SELECT 1 FROM `tokens` LIMIT 0') return [];
  if (s.startsWith('INSERT INTO `code_requests`')) {
    if (TABLES.code_requests.some((r) => r.request_id === params[0])) {
      throw Object.assign(new Error('Duplicate request'), { code: 'ER_DUP_ENTRY' });
    }
    TABLES.code_requests.push({ request_id: params[0], type: params[1] });
    return { affectedRows: 1 };
  }
  if (s.startsWith('SELECT `created_at` FROM `tokens`')) {
    const token = [...TABLES.tokens].reverse().find((r) => r.type === params[0]);
    return token ? [{ created_at: token.created_at }] : [];
  }

  if (/^INSERT INTO `tokens`/.test(s)) {
    const id = nextTokensId++;
    const hasExpiry = /expires_at/.test(s);
    TABLES.tokens.push({
      id,
      token_hash: params[0],
      type: params[1],
      created_at: stamp(),
      expires_at: hasExpiry ? params[2] : null,
      revoked_at: null,
      consumed_at: null,
      last_used_at: null
    });
    return { insertId: id, affectedRows: 1 };
  }

  if (/^UPDATE `tokens` SET `revoked_at`/.test(s)) {
    let n = 0;
    for (const t of TABLES.tokens) {
      if (t.type === params[0] && !t.revoked_at) { t.revoked_at = stamp(); n += 1; }
    }
    return { affectedRows: n };
  }

  if (/^UPDATE `tokens` SET `last_used_at`/.test(s)) {
    const t = TABLES.tokens.find((x) => x.id === Number(params[0]));
    if (t) t.last_used_at = stamp();
    return { affectedRows: t ? 1 : 0 };
  }

  if (/^UPDATE `tokens` SET `consumed_at`/.test(s)) {
    const t = TABLES.tokens.find(
      (x) => x.id === Number(params[0]) && x.token_hash === params[1] && x.type === params[2] &&
        !x.revoked_at && !x.consumed_at && (!x.expires_at || x.expires_at > params[3])
    );
    if (t) {
      t.consumed_at = stamp();
      t.last_used_at = stamp();
    }
    return { affectedRows: t ? 1 : 0 };
  }

  if (/^SELECT `id`, `token_hash`/.test(s)) {
    const now = params[2];
    const t = TABLES.tokens.find(
      (x) => x.token_hash === params[0] && x.type === params[1] && !x.revoked_at && !x.consumed_at && (!x.expires_at || x.expires_at > now)
    );
    return t ? [{ id: t.id, token_hash: t.token_hash, type: t.type, created_at: t.created_at, expires_at: t.expires_at }] : [];
  }

  if (/^SELECT `id`, `created_at`, `expires_at`/.test(s)) {
    const now = params[1];
    const t = [...TABLES.tokens].reverse().find(
      (x) => x.type === params[0] && !x.revoked_at && !x.consumed_at && (!x.expires_at || x.expires_at > now)
    );
    return t ? [{ id: t.id, created_at: t.created_at, expires_at: t.expires_at }] : [];
  }

  if (/^SELECT `id` FROM `tokens` WHERE `token_hash`/.test(s)) {
    const now = params[2];
    const t = TABLES.tokens.find(
      (x) => x.token_hash === params[0] && x.type === params[1] && !x.revoked_at && !x.consumed_at && (!x.expires_at || x.expires_at > now)
    );
    return t ? [{ id: t.id }] : [];
  }

  if (/^SELECT `id` FROM `tokens`/.test(s)) {
    const now = params[1];
    const t = TABLES.tokens.find(
      (x) => x.id === Number(params[0]) && x.type === 'management' && !x.revoked_at && (!x.expires_at || x.expires_at > now)
    );
    return t ? [{ id: t.id }] : [];
  }

  if (/^SELECT `id` FROM `images` WHERE `custom_slug`/.test(s)) {
    return TABLES.images.filter((r) => r.custom_slug === params[0] || (params.length > 1 && r.public_id === params[1])).slice(0, 1).map((r) => ({ id: r.id }));
  }

  if (/^SELECT `id` FROM `images` WHERE `public_id`/.test(s)) {
    return TABLES.images.filter((r) => r.public_id === params[0] || (params.length > 1 && r.custom_slug === params[1])).slice(0, 1).map((r) => ({ id: r.id }));
  }

  if (/^INSERT INTO `images`/.test(s)) {
    const id = nextImagesId++;
    TABLES.images.push({
      id,
      public_id: params[0],
      original_filename: params[1],
      stored_filename: params[2],
      custom_slug: params[3],
      mime_type: params[4],
      byte_size: Number(params[5]),
      upload_time: stamp()
    });
    return { insertId: id, affectedRows: 1 };
  }

  if (/WHERE `public_id` = \? LIMIT/.test(s)) {
    return TABLES.images.filter((r) => r.public_id === params[0]).slice(0, 1);
  }

  if (/WHERE `custom_slug` = \? LIMIT/.test(s)) {
    return TABLES.images.filter((r) => r.custom_slug === params[0]).slice(0, 1);
  }

  if (/^SELECT COUNT\(\*\)/.test(s)) {
    return [{ image_count: TABLES.images.length, total_bytes: TABLES.images.reduce((a, b) => a + b.byte_size, 0) }];
  }

  if (/^DELETE FROM `images`/.test(s)) {
    const ids = params.map(Number);
    const before = TABLES.images.length;
    TABLES.images = TABLES.images.filter((r) => !ids.includes(r.id));
    return { affectedRows: before - TABLES.images.length };
  }

  if (/WHERE `id` IN/.test(s)) {
    const ids = params.map(Number);
    return TABLES.images.filter((r) => ids.includes(r.id));
  }

  throw new Error('selftest: unhandled SQL -> ' + s);
};

// Simulate atomic transactions for the HTTP tests. Real connection/lock behavior
// and issuance races are covered separately in issuance-test.js.
let transactionQueue = Promise.resolve();
db.withTokenTransaction = async function withTokenTransaction(type, operation) {
  const predecessor = transactionQueue;
  let release;
  transactionQueue = new Promise((resolve) => { release = resolve; });
  await predecessor;
  const snapshot = structuredClone(TABLES);
  try { return await operation(db.query); }
  catch (err) { Object.assign(TABLES, snapshot); throw err; }
  finally { release(); }
};

// listImages() uses DATE_FORMAT(); the stub already stores "YYYY-MM-DD HH:MM:SS".
store.listImages = async function listImages() {
  assertTableAvailable('images');
  return [...TABLES.images].sort((a, b) => b.id - a.id);
};

/* ------------------------------------------------------------------ *
 * Test scaffolding
 * ------------------------------------------------------------------ */
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imghost-selftest-'));
const config = {
  domain: 'https://images.example.com',
  uploadsDir,
  publicDir: path.join(__dirname, '..', 'public'),
  maxFileSizeBytes: 25 * 1024 * 1024,
  allowSvg: false,
  publicIdLength: 6,
  managementTokenTtlMinutes: 20,
  uploadTokenTtlHours: null,
  trustProxy: true,
  phpMyAdminEnabled: true,
  codeGenerator: { enabled: true, sharedSecret: 'a'.repeat(64), url: 'https://codes.example.com' }
};

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name + (detail !== undefined ? ` -> ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n${t}`);
const lastImage = () => TABLES.images[TABLES.images.length - 1];

async function main() {
  const secret = session.loadOrCreateSecret(path.join(os.tmpdir(), 'selftest-secret'));
  const app = createApp(config, secret);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const uploadForm = (code, buffer, name, slug) => {
    const fd = new FormData();
    if (code !== undefined) fd.append('code', code);
    if (slug) fd.append('slug', slug);
    fd.append('image', new Blob([buffer], { type: 'image/png' }), name);
    return fetch(`${base}/api/upload`, { method: 'POST', body: fd });
  };

  const postJson = (route, body, cookie) =>
    fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body)
    });

  const validateUploadCode = (code) => postJson('/api/upload/validate', { code });

  console.log('Self-test: personal image host\n' + '='.repeat(62));

  /* ---------------- 0. port resolution ---------------- */
  section('0. VPS port resolution');
  check('config port wins over legacy PORT', resolvePort(9999, { PORT: '8080' }).port === 9999);
  check('legacy SERVER_PORT is ignored', resolvePort(null, { SERVER_PORT: '7777' }).port === 3000);
  check('config.json port used when no PORT in env', resolvePort(9999, {}).port === 9999);
  check('falls back to 3000 when nothing is set', resolvePort(null, {}).port === 3000);
  check('undefined config port falls back to 3000', resolvePort(undefined, {}).port === 3000);
  check('empty-string PORT is ignored', resolvePort(null, { PORT: '' }).port === 3000);
  check('non-numeric PORT is ignored', resolvePort(null, { PORT: 'abc' }).port === 3000);
  for (const port of [0, -1, 65536, 1.5, 'abc', '']) {
    let rejected = false;
    try { resolvePort(port); } catch { rejected = true; }
    check(`invalid configured port ${JSON.stringify(port)} is rejected`, rejected);
  }
  check('port 65535 is supported', resolvePort(65535).port === 65535);
  const { normalizeCodeGenerator } = require('../src/config');
  check('old configs leave remote code generation disabled', normalizeCodeGenerator().enabled === false);
  check('a strong secret enables the configured private generator', normalizeCodeGenerator({ enabled: true, sharedSecret: 'a'.repeat(64), url: 'https://codes.example.com' }).url === 'https://codes.example.com');
  for (const [label, value] of [
    ['weak secret', { enabled: true, sharedSecret: 'short' }],
    ['missing secret', { enabled: true }],
    ['nonboolean enabled flag', { enabled: 'true' }],
    ['HTTP URL', { url: 'http://codes.example.com' }],
    ['credential-bearing URL', { url: 'https://user:pass@codes.example.com' }],
    ['non-origin URL', { url: 'https://codes.example.com/path' }]
  ]) {
    let rejected = false;
    try { normalizeCodeGenerator(value); } catch { rejected = true; }
    check(`generator config rejects ${label}`, rejected);
  }
  const { deploymentOptions, renderNginx } = require('./configure-vps');
  const options = deploymentOptions('https://images.mydomain.net', '4123');
  const nginx = renderNginx(fs.readFileSync(path.join(__dirname, '../deploy/nginx.conf'), 'utf8'), options, 100);
  check('Nginx rendering uses the configured upstream port and upload allowance', nginx.includes('127.0.0.1:4123') && nginx.includes('client_max_body_size 101m;') && !/APP_PORT|SERVER_NAME|BODY_LIMIT|HTTP_PORT|TLS_LISTEN/.test(nginx));
  const { generate } = require('./nginx-config');
  const forwardedConfig = { domain: 'https://images.example.com', host: '127.0.0.1', port: 3000, maxFileSizeMb: 25, nginx: { httpPort: 8080, httpsPort: 8443 } };
  const forwardedHttp = generate(forwardedConfig);
  check('forwarded HTTP port is rendered for IPv4 and IPv6', forwardedHttp.includes('listen 8080;') && forwardedHttp.includes('listen [::]:8080;'));
  check('HTTP-only config does not create an invalid TLS listener', !forwardedHttp.includes(' ssl;') && !forwardedHttp.includes('ssl_certificate '));
  check('forwarded Nginx still routes phpMyAdmin through session gate', forwardedHttp.includes('location /phpmyadmin/') && forwardedHttp.includes('proxy_pass http://127.0.0.1:3000/api/manage/database-auth;'));
  check('redirects retain the browser-facing port behind origin rules', forwardedHttp.includes('absolute_redirect off;'));
  const tlsConfig = { ...forwardedConfig, nginx: { ...forwardedConfig.nginx, sslCertificate: '/etc/ssl/certs/imagehost.pem', sslCertificateKey: '/etc/ssl/private/imagehost.key' } };
  const forwardedTls = generate(tlsConfig);
  check('forwarded HTTPS port and certificate paths are rendered', forwardedTls.includes('listen 8443 ssl;') && forwardedTls.includes('listen [::]:8443 ssl;') && forwardedTls.includes('ssl_certificate /etc/ssl/certs/imagehost.pem;') && forwardedTls.includes('ssl_certificate_key /etc/ssl/private/imagehost.key;'));
  for (const [label, invalidConfig] of [
    ['app/public port collision', { ...forwardedConfig, port: 8080 }],
    ['HTTP/HTTPS port collision', { ...forwardedConfig, nginx: { httpPort: 8080, httpsPort: 8080 } }],
    ['invalid public port', { ...forwardedConfig, nginx: { httpPort: 70000 } }],
    ['partial certificate config', { ...forwardedConfig, nginx: { sslCertificate: '/etc/cert.pem' } }],
    ['certificate syntax injection', { ...tlsConfig, nginx: { ...tlsConfig.nginx, sslCertificate: '/etc/cert;injected.pem' } }]
  ]) {
    let rejected = false;
    try { generate(invalidConfig); } catch { rejected = true; }
    check(`Nginx generator rejects ${label}`, rejected);
  }
  for (const domain of ['https://host.test/evil', 'https://user:pass@host.test', 'https://host.test:123', 'https://host.test;injected']) {
    let rejected = false;
    try { deploymentOptions(domain); } catch { rejected = true; }
    check(`installer rejects unsafe/unsupported domain ${domain}`, rejected);
  }

  section('0b. Private Worker code issuance');
  const site = await (await fetch(base + '/api/site-settings')).json();
  check('public settings expose the generator link only', JSON.stringify(site) === JSON.stringify({ codeGeneratorUrl: config.codeGenerator.url }));
  check('code issuance requires POST', (await fetch(base + '/api/admin/codes')).status === 405);
  const issue = (body, authorization = 'Bearer ' + config.codeGenerator.sharedSecret) => fetch(base + '/api/admin/codes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify(body)
  });
  const { randomUUID } = require('crypto');
  check('HTTP origin connections cannot issue privileged codes', (await fetch(base + '/api/admin/codes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.codeGenerator.sharedSecret }, body: JSON.stringify({ type: 'upload', requestId: randomUUID() }) })).status === 403);
  check('code issuance rejects missing Worker credential', (await issue({ type: 'upload', requestId: randomUUID() }, '')).status === 401);
  check('code issuance rejects an upload token as Worker credential', (await issue({ type: 'upload', requestId: randomUUID() }, 'Bearer ABCD-EFGH')).status === 401);
  check('code issuance rejects unknown token types', (await issue({ type: 'root', requestId: randomUUID() })).status === 400);
  const requestId = randomUUID();
  const generated = await issue({ type: 'upload', requestId });
  const generatedBody = await generated.json();
  check('Worker can issue an ordinary upload code', generated.status === 201 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(generatedBody.code));
  check('upload code honors no-time-expiry and public URL config', generatedBody.expiresAt === null && generatedBody.url === config.domain + '/');
  check('generated codes are never cached', generated.headers.get('cache-control') === 'no-store');
  check('generated upload code passes real verification', await store.isTokenValid('upload', generatedBody.code));
  check('retrying the same request ID cannot replace its code', (await issue({ type: 'upload', requestId })).status === 409 && await store.isTokenValid('upload', generatedBody.code));
  check('rapid code replacement is blocked without consuming a request ID', (await issue({ type: 'upload', requestId: randomUUID() })).status === 429 && TABLES.code_requests.length === 1);
  const generatedManagement = await (await issue({ type: 'management', requestId: randomUUID() })).json();
  check('management code uses configured 20-minute expiry', generatedManagement.type === 'management' && Math.abs(Date.parse(generatedManagement.expiresAt) - Date.now() - 20 * 60000) < 2000);
  check('Worker management code logs in through existing route', (await postJson('/api/manage/login', { code: generatedManagement.code })).status === 200);
  missingTables.add('code_requests');
  check('missing issuance ledger returns a safe 503 during import', (await issue({ type: 'upload', requestId: randomUUID() })).status === 503);
  missingTables.delete('code_requests');
  const malformedAdmin = await fetch(base + '/api/admin/codes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.codeGenerator.sharedSecret, 'X-Forwarded-Proto': 'https' }, body: '{' });
  check('malformed authenticated code request returns 400', malformedAdmin.status === 400);
  const oversizedAdmin = await fetch(base + '/api/admin/codes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.codeGenerator.sharedSecret, 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ value: 'x'.repeat(3000) }) });
  check('code request body size is bounded', oversizedAdmin.status === 413);
  check('excessive code requests are rate limited', (await issue({ type: 'upload', requestId: randomUUID() })).status === 429);

  /* ---------------- 1. tokens ---------------- */
  section('1. Console commands and token generation');
  const firstCode = await store.issueToken('upload', 0);
  const mgmtCode = await store.issueToken('management', 20);
  check('`code` produces an XXXX-XXXX upload code', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(firstCode), firstCode);
  check('`manage` produces a different management code', mgmtCode !== firstCode, mgmtCode);

  let up = await store.issueToken('upload', 0);
  check('re-running `code` replaces the previous code', up !== firstCode);
  check('the replaced code cannot be consumed', (await store.consumeToken('upload', firstCode)) === null);
  check('the new code is consumed on first use', Boolean(await store.consumeToken('upload', up)));
  check('a consumed upload code cannot be used again', (await store.consumeToken('upload', up)) === null);
  check('only a 64-char hash is stored, never the plaintext', TABLES.tokens.every((t) => t.token_hash.length === 64 && !Object.values(t).includes(up)));
  check('management code cannot be consumed as an upload code', (await store.consumeToken('upload', mgmtCode)) === null);
  check('upload code cannot be consumed as a management code', (await store.consumeToken('management', up)) === null);

  /* ---------------- 2. upload auth ---------------- */
  section('2. Upload authentication (server-side)');
  check('invalid upload code is rejected before multipart upload -> 401', (await validateUploadCode('AAAA-BBBB')).status === 401);
  check('upload without a code -> 401', (await uploadForm(undefined, PNG_BYTES, 'a.png')).status === 401);
  check('upload with a wrong code -> 401', (await uploadForm('AAAA-BBBB', PNG_BYTES, 'a.png')).status === 401);
  check('management code cannot upload -> 401', (await uploadForm(mgmtCode, PNG_BYTES, 'a.png')).status === 401);

  const revokedCode = await store.issueToken('upload', 0);
  await store.revokeToken('upload');
  check('revoked upload code -> 401', (await uploadForm(revokedCode, PNG_BYTES, 'a.png')).status === 401);
  up = await store.issueToken('upload', 0);
  check('a fresh upload code can be issued after revocation', up !== revokedCode);
  check('valid upload code passes pre-upload validation -> 200', (await validateUploadCode(up)).status === 200);
  check('pre-upload validation does not consume the code', (await validateUploadCode(up)).status === 200);

  const emptyForm = new FormData();
  emptyForm.append('code', up);
  check('upload with a code but no file -> 400', (await fetch(`${base}/api/upload`, { method: 'POST', body: emptyForm })).status === 400);

  /* ---------------- 3. content validation ---------------- */
  section('3. Image content validation (magic bytes)');
  check('a shell script renamed .png -> 415', (await uploadForm(up, Buffer.from('#!/bin/sh\necho hacked\n'), 'evil.png', 'evil')).status === 415);

  const renamed = await uploadForm(up, PNG_BYTES, 'photo.jpg', 'renamed-jpeg');
  const renamedBody = await renamed.json();
  check('a PNG renamed .jpg is stored as its real type', renamedBody.mime === 'image/png', renamedBody.mime);

  /* ---------------- 4. successful upload ---------------- */
  section('4. Upload and direct URL generation');
  up = await store.issueToken('upload', 0);
  const r1 = await uploadForm(up, PNG_BYTES, 'cat.png');
  const b1 = await r1.json();
  const row1 = lastImage();
  check('upload succeeds -> 201', r1.status === 201, r1.status);
  check('url uses the configured domain', b1.url === `https://images.example.com/i/${row1.public_id}`, b1.url);
  check('random public id matches the a82KF2 format', /^[A-Za-z0-9]{6}$/.test(row1.public_id), row1.public_id);
  check('markdown snippet is correct', b1.markdown === `![cat.png](${b1.url})`, b1.markdown);
  check('html snippet is correct', b1.html === `<img src="${b1.url}" alt="cat.png">`, b1.html);
  check('internal filename is random hex + ext', /^[a-f0-9]{32}\.png$/.test(row1.stored_filename), row1.stored_filename);
  check('public id is NOT used as the filesystem name', row1.stored_filename !== row1.public_id);
  check('original filename kept as metadata', row1.original_filename === 'cat.png');
  check('file written to the uploads dir', fs.existsSync(path.join(uploadsDir, row1.stored_filename)));
  check('no binary image data stored in the DB', row1.byte_size === PNG_BYTES.length && !('data' in row1));

  up = await store.issueToken('upload', 0);
  const r2 = await uploadForm(up, PNG_BYTES, 'logo.jpg', 'summer2026');
  const b2 = await r2.json();
  check('custom slug produces /i/<slug>', b2.url === 'https://images.example.com/i/summer2026', b2.url);
  check('custom slug stored separately from the random id', lastImage().custom_slug === 'summer2026');

  /* ---------------- 5. slug safety ---------------- */
  section('5. Custom slug safety');
  up = await store.issueToken('upload', 0);
  const badSlugs = ['../etc/passwd', 'a/b', 'a\\b', '.hidden', 'has space', 'x'.repeat(65), 'manage', 'api'];
  const badResults = [];
  for (const s of badSlugs) {
    const res = await uploadForm(up, PNG_BYTES, 'x.png', s);
    if (res.status !== 400) badResults.push(`${s}->${res.status}`);
  }
  check('all unsafe / reserved slugs rejected with 400', badResults.length === 0, badResults.join(', '));
  check('duplicate custom slug -> 409', (await uploadForm(up, PNG_BYTES, 'x.png', 'summer2026')).status === 409);
  check('path traversal on /i/:id -> 404', (await fetch(`${base}/i/${encodeURIComponent('../../config.json')}`)).status === 404);
  up = await store.issueToken('upload', 0);
  check('empty slug falls back to a random id', (await uploadForm(up, PNG_BYTES, 'x.png', '')).status === 201);

  /* ---------------- 6. direct image route ---------------- */
  section('6. Direct image route /i/:id');
  const getRandom = await fetch(`${base}/i/${TABLES.images.find((x) => !x.custom_slug).public_id}`);
  const bytes = Buffer.from(await getRandom.arrayBuffer());
  check('GET /i/<id> -> 200', getRandom.status === 200, getRandom.status);
  check('Content-Type is image/png', getRandom.headers.get('content-type') === 'image/png', getRandom.headers.get('content-type'));
  check('bytes match the uploaded file exactly', bytes.equals(PNG_BYTES));
  check('served inline (not as an attachment)', (getRandom.headers.get('content-disposition') || '').startsWith('inline'));
  check('long-lived cache headers set', (getRandom.headers.get('cache-control') || '').includes('immutable'));
  check('X-Content-Type-Options: nosniff set', getRandom.headers.get('x-content-type-options') === 'nosniff');

  check('GET /i/<custom slug> -> 200', (await fetch(`${base}/i/summer2026`)).status === 200);
  check('HEAD /i/<slug> -> 200 (Discord-style checks)', (await fetch(`${base}/i/summer2026`, { method: 'HEAD' })).status === 200);
  check('unknown id -> 404', (await fetch(`${base}/i/doesnotexist`)).status === 404);
  check('malformed id -> 404 (no crash)', (await fetch(`${base}/i/..%2f..%2fconfig.json`)).status === 404);


  /* ---------------- 7. secret protection ---------------- */
  section('7. Secret exposure');
  for (const p of ['/config.json', '/config.example.json', '/.session-secret', '/package.json', '/src/server.js']) {
    const res = await fetch(base + p);
    check(`${p} is not publicly served`, res.status === 404, res.status);
  }
  const indexHtml = await (await fetch(`${base}/`)).text();
  check('index page contains no DB host', !indexHtml.includes('203.0.113.10'));
  check('index page contains no DB name', !indexHtml.includes('s48751_DATA'));
  check('/uploads/ is not browsable', (await fetch(`${base}/uploads/`)).status === 404);
  check('/manage serves the management page', (await fetch(`${base}/manage`)).status === 200);
  check('/api/health responds ok', (await (await fetch(`${base}/api/health`)).json()).ok === true);

  /* ---------------- 8. management auth ---------------- */
  section('8. Management authentication');
  check('listing without a session -> 401', (await fetch(`${base}/api/manage/images`)).status === 401);
  check('deleting without a session -> 401', (await postJson('/api/manage/delete', { ids: [1] })).status === 401);
  check('status without a session -> authenticated:false', (await (await fetch(`${base}/api/manage/status`)).json()).authenticated === false);
  check('phpMyAdmin gate without session -> 401', (await fetch(`${base}/api/manage/database-auth`)).status === 401);
  check('phpMyAdmin button target without session -> 401', (await fetch(`${base}/api/manage/database`, { redirect: 'manual' })).status === 401);

  check('upload code cannot log into the manager -> 401', (await postJson('/api/manage/login', { code: up })).status === 401);
  check('wrong management code -> 401', (await postJson('/api/manage/login', { code: 'ZZZZ-ZZZZ' })).status === 401);

  const login = await postJson('/api/manage/login', { code: mgmtCode });
  check('management code logs in -> 200', login.status === 200, login.status);
  const rawCookie = (login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')]).join(';');
  const cookie = rawCookie.split(';')[0];
  check('session cookie is HttpOnly', /HttpOnly/i.test(rawCookie), rawCookie);
  check('session cookie is SameSite=Strict', /SameSite=Strict/i.test(rawCookie), rawCookie);

  const list = await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } });
  const listBody = await list.json();
  check('authenticated listing -> 200', list.status === 200, list.status);
  check('listing has filename, url, upload time, size and type', Boolean(
    listBody.images[0] && listBody.images[0].filename && listBody.images[0].url &&
    listBody.images[0].uploadedAt && listBody.images[0].sizeLabel && listBody.images[0].mime
  ), JSON.stringify(listBody.images[0] || {}));
  check('listing exposes no internal stored_filename', !JSON.stringify(listBody).includes('stored_filename'));
  check('listing exposes no raw DB columns', !/"(public_id|token_hash|byte_size)"/.test(JSON.stringify(listBody)));
  check('authenticated listing supplies phpMyAdmin button URL', listBody.databaseAdminUrl === '/api/manage/database');
  const gate = await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: cookie } });
  check('phpMyAdmin gate with session -> 204 and no cache', gate.status === 204 && gate.headers.get('cache-control') === 'no-store');
  const databaseLink = await fetch(`${base}/api/manage/database`, { headers: { Cookie: cookie }, redirect: 'manual' });
  check('authenticated button redirects to local phpMyAdmin', databaseLink.status === 302 && databaseLink.headers.get('location') === '/phpmyadmin/');
  config.phpMyAdminEnabled = false;
  check('disabled phpMyAdmin gate -> 403 even with valid session', (await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: cookie } })).status === 403);
  check('disabled phpMyAdmin button target -> 404', (await fetch(`${base}/api/manage/database`, { headers: { Cookie: cookie }, redirect: 'manual' })).status === 404);
  config.phpMyAdminEnabled = true;
  check('forged management cookie cannot access phpMyAdmin', (await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: cookie + 'tampered' } })).status === 401);

  section('8b. Imported legacy metadata and stored files');
  const legacyName = '1234567890abcdef1234567890abcdef.png';
  const legacyRow = { id: 9001, public_id: 'OldId9', custom_slug: 'old-link', stored_filename: legacyName, original_filename: '旧照片.png', mime_type: 'image/png', byte_size: PNG_BYTES.length, upload_time: '2025-01-02 03:04:05' };
  TABLES.images.push(legacyRow);
  fs.writeFileSync(path.join(uploadsDir, legacyName), PNG_BYTES);
  const imported = await fetch(`${base}/i/old-link`);
  check('imported slug serves original file bytes', imported.status === 200 && Buffer.from(await imported.arrayBuffer()).equals(PNG_BYTES));
  check('imported Unicode filename has an encoded HTTP header', (imported.headers.get('content-disposition') || '').includes("filename*=UTF-8''%E6%97%A7"));
  check('imported public ID alias still works', (await fetch(`${base}/i/OldId9`)).status === 200);
  const importedList = await (await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } })).json();
  const oldImage = importedList.images.find((image) => image.id === 9001);
  check('import preserves ID, slug, filename and timestamp in manager', oldImage && oldImage.identifier === 'old-link' && oldImage.filename === '旧照片.png' && oldImage.uploadedAt === '2025-01-02 03:04:05');
  const { checkStorage } = require('./check-storage');
  check('migration checker accepts intact imported record', await checkStorage(config, [legacyRow], () => {}) === 0);
  const beforeCheck = fs.readFileSync(path.join(uploadsDir, legacyName));
  check('migration checker detects size mismatch', await checkStorage(config, [{ ...legacyRow, byte_size: 999 }], () => {}) === 1);
  check('migration checker detects missing file', await checkStorage(config, [{ ...legacyRow, stored_filename: 'b'.repeat(32) + '.png' }], () => {}) === 1);
  check('migration checker leaves rows and bytes untouched', TABLES.images.includes(legacyRow) && fs.readFileSync(path.join(uploadsDir, legacyName)).equals(beforeCheck));
  const migrationCode = await store.issueToken('upload', 0);
  check('new custom slug cannot shadow an imported public ID', (await uploadForm(migrationCode, PNG_BYTES, 'new.png', legacyRow.public_id)).status === 409);
  check('ID generator collision check also reserves imported slugs', await store.publicIdExists(legacyRow.custom_slug));
  const preserved = await fetch(`${base}/i/OldId9`);
  check('imported URL still returns original bytes after a conflicting upload', preserved.status === 200 && Buffer.from(await preserved.arrayBuffer()).equals(PNG_BYTES));

  section('8c. phpMyAdmin stays accessible while importing dropped tables');
  const beforeRecovery = executedSql.length;
  missingTables.add('images');
  check('dropped images table does not block phpMyAdmin', (await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: cookie } })).status === 204);
  const noImagesStatus = await (await fetch(`${base}/api/manage/status`, { headers: { Cookie: cookie } })).json();
  check('phpMyAdmin link is available before the gallery query', noImagesStatus.authenticated && noImagesStatus.databaseAdminUrl === '/api/manage/database');
  check('dropped images table returns a clear 503 for the gallery', (await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } })).status === 503);
  check('dropped images alone does not bypass management authentication', (await fetch(`${base}/api/manage/database-auth`)).status === 401);
  for (const imagesAlsoMissing of [false, true]) {
    if (imagesAlsoMissing) missingTables.add('images'); else missingTables.delete('images');
    missingTables.add('tokens');
    const label = imagesAlsoMissing ? 'both application tables dropped' : 'tokens table dropped';
    const recoveryGate = await fetch(`${base}/api/manage/database-auth`);
    check(`${label}: phpMyAdmin gate permits its own DB login`, recoveryGate.status === 204 && recoveryGate.headers.get('cache-control') === 'no-store');
    check(`${label}: an existing browser session can continue to phpMyAdmin`, (await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: cookie } })).status === 204);
    const recoveryLink = await fetch(`${base}/api/manage/database`, { redirect: 'manual' });
    check(`${label}: recovery link opens phpMyAdmin`, recoveryLink.status === 302 && recoveryLink.headers.get('location') === '/phpmyadmin/');
    const recoveryStatusResponse = await fetch(`${base}/api/manage/status`);
    const recoveryStatus = await recoveryStatusResponse.json();
    check(`${label}: status exposes recovery without granting app access`, recoveryStatusResponse.status === 200 && recoveryStatus.databaseRecovery === true && recoveryStatus.authenticated === false && recoveryStatus.databaseAdminUrl === '/api/manage/database');
    check(`${label}: image management stays locked`, (await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } })).status === 503);
    check(`${label}: management login reports unavailable tables`, (await postJson('/api/manage/login', { code: 'TEST-CODE' })).status === 503);
    config.phpMyAdminEnabled = false;
    check(`${label}: disabling phpMyAdmin still blocks recovery`, (await fetch(`${base}/api/manage/database-auth`)).status === 403);
    config.phpMyAdminEnabled = true;
  }
  check('recovery performs no table creation, schema repair, or data writes', executedSql.slice(beforeRecovery).every((sql) => sql.startsWith('SELECT ')));
  missingTables.clear();
  check('restoring tokens immediately reinstates the session gate', (await fetch(`${base}/api/manage/database-auth`)).status === 401);
  check('restored tables allow authenticated phpMyAdmin access', (await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: cookie } })).status === 204);
  check('restored tables load the gallery again', (await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } })).status === 200);
  const restoredStatus = await (await fetch(`${base}/api/manage/status`)).json();
  check('restoring tokens removes the recovery link', restoredStatus.databaseRecovery === false && restoredStatus.databaseAdminUrl === null);
  for (const errorCode of ['ECONNREFUSED', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_BAD_FIELD_ERROR']) {
    simulatedDatabaseError = Object.assign(new Error('Simulated database failure'), { code: errorCode });
    check(`${errorCode} fails closed instead of enabling phpMyAdmin recovery`, (await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: cookie } })).status === 403);
  }
  simulatedDatabaseError = null;

  /* ---------------- 9. deletion ---------------- */
  section('9. Deletion');
  const target = TABLES.images.find((x) => x.custom_slug === 'summer2026');
  const targetFile = path.join(uploadsDir, target.stored_filename);

  const del = await postJson('/api/manage/delete', { ids: [target.id] }, cookie);
  const delBody = await del.json();
  check('delete -> 200', del.status === 200, del.status);
  check('delete reports the removed id', delBody.deleted[0] === target.id);
  check('physical file removed from disk', !fs.existsSync(targetFile));
  check('database row removed', !TABLES.images.some((x) => x.id === target.id));
  check('public URL stops working -> 404', (await fetch(`${base}/i/summer2026`)).status === 404);

  const orphan = TABLES.images[0];
  fs.unlinkSync(path.join(uploadsDir, orphan.stored_filename));
  const delOrphan = await postJson('/api/manage/delete', { ids: [orphan.id] }, cookie);
  check('delete tolerates a missing physical file -> 200', delOrphan.status === 200, delOrphan.status);
  check('orphan DB row cleaned up instead of crashing', !TABLES.images.some((x) => x.id === orphan.id));

  check('invalid delete payload -> 400', (await postJson('/api/manage/delete', { ids: 'nope' }, cookie)).status === 400);

  const multiIds = TABLES.images.slice(0, 2).map((x) => x.id);
  const delMany = await postJson('/api/manage/delete', { ids: multiIds }, cookie);
  check('multi-image delete -> 200', delMany.status === 200, delMany.status);
  check('multi-image delete removed every selected id', (await delMany.json()).deleted.length === multiIds.length);

  /* ---------------- 10. revocation ---------------- */
  section('10. Revocation and expiry');
  await store.revokeToken('management');
  check('revoked session cannot access phpMyAdmin', (await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: cookie } })).status === 401);
  check('revoking the management code kills the session -> 401', (await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } })).status === 401);
  const mgmt2 = await store.issueToken('management', 20);
  const freshLogin = await postJson('/api/manage/login', { code: mgmt2 });
  check('a fresh management code can be issued after revocation', freshLogin.status === 200);
  const freshCookie = freshLogin.headers.get('set-cookie').split(';')[0];

  // Simulate the 20 minute TTL elapsing.
  TABLES.tokens.filter((t) => t.type === 'management' && !t.revoked_at).forEach((t) => { t.expires_at = '2000-01-01 00:00:00'; });
  check('expired token blocks phpMyAdmin despite signed cookie', (await fetch(`${base}/api/manage/database-auth`, { headers: { Cookie: freshCookie } })).status === 401);
  check('an expired management code cannot be consumed', (await store.consumeToken('management', mgmt2)) === null);
  check('an expired management code cannot log in -> 401', (await postJson('/api/manage/login', { code: mgmt2 })).status === 401);
  check('an expired management session is rejected -> 401', (await fetch(`${base}/api/manage/images`, { headers: { Cookie: cookie } })).status === 401);

  const mgmt3 = await store.issueToken('management', 20);
  check('an unexpired management code still works', (await postJson('/api/manage/login', { code: mgmt3 })).status === 200);

  const stats = await store.getStats();
  check('status stats work after deletes', typeof stats.image_count === 'number' && typeof stats.total_bytes === 'number');

  /* ---------------- summary ---------------- */
  console.log('\n' + '='.repeat(62));
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }

  await new Promise((r) => server.close(r));
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nSelf-test crashed:', err);
  process.exitCode = 1;
});

