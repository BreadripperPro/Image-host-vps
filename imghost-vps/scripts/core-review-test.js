'use strict';

// Focused regressions for malformed client cookies and imported Unicode names.
// These tests need no database, network access or deployed credentials.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const session = require('../src/session');
const { sanitizeOriginalFilename } = require('../src/images');
const SECRET = 'local-test-secret-only-'.repeat(3);

function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

test('malformed management cookies are unauthenticated instead of throwing', () => {
  for (const value of ['%', '%E0%A4%A', '%ED%A0%80', '%GG']) {
    assert.equal(session.readCookie({ headers: { cookie: `other=value; imgmgmt=${value}` } }), null);
  }
  assert.equal(session.readCookie({ headers: {} }), null);
  assert.equal(session.readCookie({ headers: { cookie: 'other=value' } }), null);
});

test('valid management cookies still round-trip with URL encoding and unrelated cookies', () => {
  const token = session.create(SECRET, { tokenId: 17, ttlSeconds: 60 });
  const decoded = session.readCookie({ headers: { cookie: `other=value; imgmgmt=${encodeURIComponent(token)}; last=value` } });
  assert.equal(decoded, token);
  assert.equal(session.verify(decoded, SECRET).tid, 17);
});

test('signed sessions reject extra segments and invalid or expired expiry values', () => {
  const valid = session.create(SECRET, { tokenId: 17, ttlSeconds: 60 });
  assert.equal(session.verify(valid + '.extra', SECRET), null);
  assert.equal(session.verify(valid + '.', SECRET), null);
  for (const exp of ['invalid', String(Date.now() + 60000), true, null, 0, Date.now() - 1000]) {
    assert.equal(session.verify(signPayload({ tid: 17, exp }), SECRET), null);
  }
  const now = Date.now();
  const originalNow = Date.now;
  try {
    Date.now = () => now;
    assert.equal(session.verify(signPayload({ tid: 17, exp: now }), SECRET), null);
    assert.equal(session.verify(signPayload({ tid: 17, exp: now + 1 }), SECRET).tid, 17);
  } finally { Date.now = originalNow; }
});

test('long imported Unicode filenames remain safe for HTTP filename encoding', () => {
  const filename = sanitizeOriginalFilename('a'.repeat(199) + '\u{1F600}.png');
  assert.doesNotThrow(() => encodeURIComponent(filename));
  assert.ok(filename.length <= 200);
  assert.equal(filename, 'a'.repeat(199));
  const completePair = 'a'.repeat(198) + '\u{1F600}';
  assert.equal(sanitizeOriginalFilename(completePair + '.png'), completePair);
  for (const malformed of ['a\uD800b.png', 'a\uDC00b.png', '\uD800']) {
    assert.doesNotThrow(() => encodeURIComponent(sanitizeOriginalFilename(malformed)));
  }
  assert.equal(sanitizeOriginalFilename('\u732B\u{1F600}.png'), '\u732B\u{1F600}.png');
  assert.equal(sanitizeOriginalFilename('folder\\normal image.png'), 'normal image.png');
  assert.equal(sanitizeOriginalFilename('<unsafe>\u0000.png'), '_unsafe_.png');
});
