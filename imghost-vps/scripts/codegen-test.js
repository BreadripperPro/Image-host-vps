'use strict';

// Isolated handler regression tests; no DB connection or credentials required.
const assert = require('assert/strict');
const crypto = require('crypto');
const store = require('../src/store');
const { createCodegenHandler } = require('../src/codegen');

const sharedSecret = crypto.randomBytes(32).toString('hex');
const config = {
  domain: 'https://images.example.com',
  managementTokenTtlMinutes: 20,
  uploadTokenTtlHours: null,
  codeGenerator: { enabled: true, sharedSecret }
};
const originalIssue = store.issueTokenDetails;
let calls = [];
let passed = 0;

async function request(handler, override = {}, middlewareFirst = false) {
  const headers = { authorization: 'Bearer ' + sharedSecret, 'content-type': 'application/json', ...override.headers };
  const req = {
    method: 'POST', ip: '127.0.0.1', body: { type: 'upload', requestId: crypto.randomUUID() },
    get: name => headers[name.toLowerCase()], ...override
  };
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let error = null;
  if (middlewareFirst) {
    let proceed = false;
    handler.authenticate(req, res, () => { proceed = true; });
    if (!proceed) return { ...res, error };
  }
  await handler(req, res, err => { error = err; });
  return { ...res, error };
}

function check(name, assertion) {
  assertion();
  passed++;
  console.log('PASS ' + name);
}

async function main() {
  store.issueTokenDetails = async (type, ttlMinutes, requestId) => {
    calls.push({ type, ttlMinutes, requestId });
    return { code: 'ABCD-EFGH', expiresAt: type === 'management' ? '2026-12-01T00:20:00.000Z' : null };
  };

  for (const value of [undefined, { enabled: false, sharedSecret }, { enabled: true }, { enabled: true, sharedSecret: 'short' }]) {
    const res = await request(createCodegenHandler({ ...config, codeGenerator: value }));
    check('missing/disabled/invalid configuration stays unavailable', () => { assert.equal(res.statusCode, 404); assert.equal(res.headers['cache-control'], 'no-store'); });
  }
  check('disabled routes perform no issuance', () => assert.equal(calls.length, 0));

  for (const authorization of [undefined, '', 'Bearer wrong', 'Basic ' + sharedSecret, 'Bearer ' + sharedSecret + ',other', 'Bearer ' + sharedSecret + ' extra']) {
    const res = await request(createCodegenHandler(config), { headers: { authorization } });
    check('bad/missing authorization does not issue a code', () => { assert.equal(res.statusCode, 401); assert.equal(calls.length, 0); assert.ok(!JSON.stringify(res.body).includes(sharedSecret)); });
  }
  const duplicateHeaders = await request(createCodegenHandler(config), { rawHeaders: ['Authorization', 'Bearer ' + sharedSecret, 'authorization', 'Bearer wrong'] });
  check('duplicate authorization headers are rejected', () => assert.equal(duplicateHeaders.statusCode, 401));

  for (const body of [undefined, null, [], {}, { type: 'upload' }, { type: 'upload', requestId: 'not-a-uuid' }, { type: 'admin', requestId: crypto.randomUUID() }, { type: 'upload', requestId: crypto.randomUUID(), extra: true }]) {
    const res = await request(createCodegenHandler(config), { body });
    check('invalid or overbroad request is rejected', () => { assert.equal(res.statusCode, 400); assert.equal(calls.length, 0); });
  }
  const badType = await request(createCodegenHandler(config), { headers: { 'content-type': 'text/plain' } });
  check('only JSON is accepted', () => assert.equal(badType.statusCode, 415));
  const badMethod = await request(createCodegenHandler(config), { method: 'GET' });
  check('non-POST requests cannot generate codes', () => { assert.equal(badMethod.statusCode, 405); assert.equal(badMethod.headers.allow, 'POST'); });

  const id = crypto.randomUUID();
  const upload = await request(createCodegenHandler(config), { body: { type: 'upload', requestId: id.toUpperCase() } });
  check('upload issuance returns only expected public fields', () => {
    assert.equal(upload.statusCode, 201);
    assert.deepEqual(upload.body, { ok: true, type: 'upload', code: 'ABCD-EFGH', expiresAt: null, url: 'https://images.example.com/' });
    assert.deepEqual(calls.at(-1), { type: 'upload', ttlMinutes: 0, requestId: id });
    assert.equal(upload.headers['cache-control'], 'no-store');
    assert.equal(upload.headers['referrer-policy'], 'no-referrer');
  });
  const timedUpload = await request(createCodegenHandler({ ...config, uploadTokenTtlHours: 2 }));
  check('configured upload expiry is converted to minutes', () => { assert.equal(timedUpload.statusCode, 201); assert.equal(calls.at(-1).ttlMinutes, 120); });
  const manage = await request(createCodegenHandler(config), { body: { type: 'management', requestId: crypto.randomUUID() } });
  check('management issuance keeps configured expiry and URL', () => { assert.equal(manage.statusCode, 201); assert.equal(calls.at(-1).ttlMinutes, 20); assert.equal(manage.body.url, 'https://images.example.com/manage'); assert.equal(manage.body.expiresAt, '2026-12-01T00:20:00.000Z'); });
  const noTtl = await request(createCodegenHandler({ ...config, managementTokenTtlMinutes: NaN }), { body: { type: 'management', requestId: crypto.randomUUID() } });
  check('invalid management expiry never creates a non-expiring code', () => assert.equal(noTtl.statusCode, 503));

  const limitedHandler = createCodegenHandler(config);
  const countBeforeLimit = calls.length;
  for (let i = 0; i < 10; i++) assert.equal((await request(limitedHandler)).statusCode, 201);
  const limited = await request(limitedHandler);
  check('per-client limiter blocks repeated issuance', () => { assert.equal(limited.statusCode, 429); assert.equal(calls.length - countBeforeLimit, 10); assert.ok(Number(limited.headers['retry-after']) > 0); });
  const anotherClient = await request(limitedHandler, { ip: '127.0.0.2' });
  check('another client gets a separate allowance', () => assert.equal(anotherClient.statusCode, 201));
  const chainedHandler = createCodegenHandler(config);
  for (let i = 0; i < 10; i++) assert.equal((await request(chainedHandler, {}, true)).statusCode, 201);
  const chainedLimit = await request(chainedHandler, {}, true);
  check('authenticate middleware and handler count each request only once', () => assert.equal(chainedLimit.statusCode, 429));
  const boundedHandler = createCodegenHandler(config);
  for (let i = 0; i < 2000; i++) {
    assert.equal((await request(boundedHandler, { ip: 'test-client-' + i, headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  }
  const saturated = await request(boundedHandler, { ip: 'one-more-client' });
  check('client tracking has a bounded size and fails closed when full', () => assert.equal(saturated.statusCode, 429));
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 61 * 1000;
    const afterWindow = await request(boundedHandler, { ip: 'one-more-client' });
    check('expired limiter entries are reclaimed for new clients', () => assert.equal(afterWindow.statusCode, 201));
  } finally { Date.now = originalNow; }

  for (const [code, expected, retryAfterSeconds] of [['CODEGEN_REQUEST_USED', 409], ['CODEGEN_RATE_LIMITED', 429, 8]]) {
    store.issueTokenDetails = async () => { throw Object.assign(new Error('internal details must not be exposed'), { code, retryAfterSeconds }); };
    const res = await request(createCodegenHandler(config));
    check('store rejection ' + code + ' returns a safe response', () => { assert.equal(res.statusCode, expected); assert.ok(!JSON.stringify(res.body).includes('internal details')); if (expected === 429) assert.equal(res.headers['retry-after'], '8'); });
  }
  const databaseError = new Error('Database unavailable');
  store.issueTokenDetails = async () => { throw databaseError; };
  const failure = await request(createCodegenHandler(config));
  check('unexpected database errors reach normal error middleware', () => { assert.equal(failure.error, databaseError); assert.equal(failure.body, null); });
  store.issueTokenDetails = async () => ({ code: 'invalid' });
  const malformed = await request(createCodegenHandler(config));
  check('malformed generation results are not reported as success', () => assert.equal(malformed.statusCode, 503));

  store.issueTokenDetails = async () => ({ code: 'ABCD-EFGH', expiresAt: null });
  const express = require('express');
  const app = express();
  const httpHandler = createCodegenHandler(config);
  app.post('/api/admin/codes', httpHandler.authenticate, express.json({ limit: '2kb' }), httpHandler);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ ok: false }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/admin/codes';
  try {
    const unauthorizedMalformed = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    check('HTTP authentication runs before parsing attacker JSON', () => assert.equal(unauthorizedMalformed.status, 401));
    const malformedJson = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + sharedSecret, 'Content-Type': 'application/json' }, body: '{' });
    check('authenticated malformed JSON is rejected as a client error', () => assert.equal(malformedJson.status, 400));
    const oversizedJson = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + sharedSecret, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'upload', requestId: 'x'.repeat(3000) }) });
    check('JSON request parser enforces the small size limit', () => assert.equal(oversizedJson.status, 413));
    const successfulHttp = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + sharedSecret, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'upload', requestId: crypto.randomUUID() }) });
    const successfulBody = await successfulHttp.json();
    check('authenticated HTTP request returns the generated code without caching', () => { assert.equal(successfulHttp.status, 201); assert.equal(successfulBody.code, 'ABCD-EFGH'); assert.equal(successfulHttp.headers.get('cache-control'), 'no-store'); });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(`${passed} code-generator handler checks passed.`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  if (originalIssue === undefined) delete store.issueTokenDetails;
  else store.issueTokenDetails = originalIssue;
});
