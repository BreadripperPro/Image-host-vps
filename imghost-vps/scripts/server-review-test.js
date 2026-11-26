'use strict';

// HTTP regressions for imported records and untrusted request bodies. All
// storage/database calls are replaced before creating the real Express app;
// no local configuration, credentials, session secret or database is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');

const db = require('../src/db');
const store = require('../src/store');
const logger = require('../src/logger');
const session = require('../src/session');
const { createApp } = require('../src/server');

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TEST_SECRET = 'server-review-test-secret-with-no-persistent-file';
const UPLOAD_CODE = 'TEST-UPLOAD';

async function fixture(t) {
  const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imghost-server-review-'));
  const state = {
    images: [], validations: [], consumed: [], selectedIds: [], deletedIds: [], logs: [], nextId: 1
  };
  const stub = (object, method, implementation) => t.mock.method(object, method, implementation);
  stub(db, 'query', async (sql, params = []) => {
    // Only the real management-session lookup is permitted. Any accidental
    // database dependency fails the request instead of connecting externally.
    assert.match(sql, /SELECT `id` FROM `tokens`/);
    assert.equal(params[0], 7);
    return [{ id: 7 }];
  });
  stub(store, 'utcNow', () => '2026-01-01 00:00:00');
  stub(store, 'findImageBySlug', async (slug) => state.images.find((row) => row.custom_slug === slug) || null);
  stub(store, 'findImageByPublicId', async (id) => state.images.find((row) => row.public_id === id) || null);
  stub(store, 'listImages', async () => state.images.slice());
  stub(store, 'getImagesByIds', async (ids) => {
    state.selectedIds.push(ids.slice());
    const keys = new Set(ids.map(String));
    return state.images.filter((row) => keys.has(String(row.id)));
  });
  stub(store, 'deleteImageRecords', async (ids) => {
    state.deletedIds.push(ids.slice());
    const keys = new Set(ids.map(String));
    const before = state.images.length;
    state.images = state.images.filter((row) => !keys.has(String(row.id)));
    return before - state.images.length;
  });
  stub(store, 'isTokenValid', async (type, code) => {
    state.validations.push({ type, code });
    return type === 'upload' && code === UPLOAD_CODE;
  });
  stub(store, 'consumeToken', async (type, code) => {
    state.consumed.push({ type, code });
    return type === 'upload' && code === UPLOAD_CODE ? { id: 8, expires_at: null } : null;
  });
  stub(store, 'slugExists', async (slug) => state.images.some((row) => row.custom_slug === slug || row.public_id === slug));
  stub(store, 'publicIdExists', async (id) => state.images.some((row) => row.public_id === id || row.custom_slug === id));
  stub(store, 'insertImage', async (image) => {
    const id = state.nextId++;
    state.images.push({
      id, public_id: image.publicId, original_filename: image.originalFilename,
      stored_filename: image.storedFilename, custom_slug: image.customSlug,
      mime_type: image.mimeType, byte_size: image.byteSize, upload_time: '2026-01-01 00:00:00'
    });
    return id;
  });
  for (const level of ['info', 'warn', 'error']) {
    stub(logger, level, (...args) => state.logs.push({ level, args }));
  }

  const config = {
    domain: 'http://images.example.test', uploadsDir,
    publicDir: path.join(__dirname, '..', 'public'), maxFileSizeBytes: 1024,
    allowSvg: false, publicIdLength: 6, trustProxy: false, phpMyAdminEnabled: false,
    codeGenerator: { enabled: false }
  };
  const server = createApp(config, TEST_SECRET).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${session.COOKIE_NAME}=${session.create(TEST_SECRET, { tokenId: 7, ttlSeconds: 60 })}`;
  const request = (route, options) => fetch(base + route, options);
  const postJson = (route, value) => request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(value)
  });
  const upload = (form, headers = {}) => request('/api/upload', { method: 'POST', headers, body: form });
  return { state, config, server, base, cookie, request, postJson, upload };
}

function imageRow(overrides = {}) {
  return {
    id: 1, public_id: 'Ab12Cd', original_filename: 'restored.png',
    stored_filename: 'a'.repeat(32) + '.png', custom_slug: null,
    mime_type: 'image/png', byte_size: PNG_BYTES.length, upload_time: '2026-01-01 00:00:00',
    ...overrides
  };
}

function imageForm({ code = UPLOAD_CODE, field = 'image', bytes = PNG_BYTES } = {}) {
  const form = new FormData();
  if (code !== null) form.append('code', code);
  form.append(field, new Blob([bytes], { type: 'image/png' }), 'test.png');
  return form;
}

async function expectJsonError(response, status, error) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, error);
  return body;
}

test('image delivery and snippets preserve imported records', async (t) => {
  await t.test('missing GET/HEAD files retain metadata and the same URL serves a later restore', async (t) => {
    const f = await fixture(t);
    const row = imageRow();
    f.state.images.push(row);
    for (const method of ['GET', 'HEAD']) {
      const response = await f.request('/i/' + row.public_id, { method });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('content-disposition'), null);
      await response.arrayBuffer();
      assert.equal(f.state.images[0], row);
      assert.deepEqual(f.state.deletedIds, []);
    }
    await fs.writeFile(path.join(f.config.uploadsDir, row.stored_filename), PNG_BYTES);
    const restored = await f.request('/i/' + row.public_id);
    assert.equal(restored.status, 200);
    assert.equal(restored.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await restored.arrayBuffer()), PNG_BYTES);
    assert.equal(f.state.images[0], row);
    assert.deepEqual(f.state.deletedIds, []);
  });

  await t.test('management listing escapes imported filenames in HTML and Markdown snippets', async (t) => {
    const f = await fixture(t);
    const filename = `photo["<&>'\\].png`;
    f.state.images.push(imageRow({ id: '18446744073709551615', original_filename: filename }));
    const response = await f.request('/api/manage/images', { headers: { Cookie: f.cookie } });
    assert.equal(response.status, 200);
    const { images } = await response.json();
    assert.equal(images.length, 1);
    assert.equal(images[0].id, '18446744073709551615');
    assert.equal(images[0].filename, filename);
    const url = f.config.domain + '/i/Ab12Cd';
    assert.equal(images[0].html, `<img src="${url}" alt="photo[&quot;&lt;&amp;&gt;&#39;\\].png">`);
    assert.equal(images[0].markdown, String.raw`![photo\["<&>'\\\].png](` + url + ')');
  });
});

test('management deletion keeps decimal BIGINT IDs exact', async (t) => {
  await t.test('canonicalizes/deduplicates decimal strings and retains large IDs through the store and response', async (t) => {
    const f = await fixture(t);
    f.state.images.push(
      imageRow({ id: 42 }),
      imageRow({ id: '9007199254740992', stored_filename: 'b'.repeat(32) + '.png' }),
      imageRow({ id: '18446744073709551615', stored_filename: 'c'.repeat(32) + '.png' })
    );
    const response = await f.postJson('/api/manage/delete', { ids: [
      '00042', 42, ' 00042 ', '0009007199254740992', '9007199254740992',
      '18446744073709551615', '18446744073709551614', '18446744073709551616',
      9007199254740992, 1.2, -1, '0', '2e2', '2.0', null, {}
    ] });
    assert.equal(response.status, 200);
    const expectedIds = [42, '9007199254740992', '18446744073709551615', '18446744073709551614'];
    assert.deepEqual(f.state.selectedIds, [expectedIds]);
    assert.deepEqual(f.state.deletedIds, [expectedIds]);
    const body = await response.json();
    assert.deepEqual(body.deleted, [42, '9007199254740992', '18446744073709551615']);
    assert.deepEqual(body.notFound, ['18446744073709551614']);
    assert.equal(f.state.images.length, 0);
  });

  await t.test('unsafe JSON numbers and IDs outside uint64 cannot reach deletion', async (t) => {
    const f = await fixture(t);
    await expectJsonError(await f.postJson('/api/manage/delete', { ids: [
      9007199254740992, 18446744073709551615, '18446744073709551616',
      '-1', 0, 1.5, '1e3', '1.0', 'not-an-id', null, true, {}, []
    ] }), 400, 'no_ids');
    assert.deepEqual(f.state.selectedIds, []);
    assert.deepEqual(f.state.deletedIds, []);
  });

  await t.test('legacy single numeric ID deletion still works', async (t) => {
    const f = await fixture(t);
    f.state.images.push(imageRow({ id: 42 }));
    const response = await f.postJson('/api/manage/delete', { id: 42 });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).deleted, [42]);
    assert.deepEqual(f.state.deletedIds, [[42]]);
  });
});

test('client parser failures return safe HTTP errors without leaking request fragments', async (t) => {
  const routes = [
    ['/api/upload/validate', 3 * 1024],
    ['/api/manage/login', 11 * 1024],
    ['/api/manage/delete', 33 * 1024]
  ];
  for (const [route, oversize] of routes) {
    await t.test(route, async (t) => {
      const f = await fixture(t);
      const secretFragment = 'PRIVATE-CODE-SHOULD-NOT-BE-LOGGED';
      const send = (body, headers = {}) => f.request(route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: f.cookie, ...headers }, body
      });
      const malformed = await expectJsonError(await send(`{"code":"${secretFragment}",`), 400, 'invalid_json');
      assert.ok(!JSON.stringify(malformed).includes(secretFragment));
      await expectJsonError(await send(JSON.stringify({ code: 'x'.repeat(oversize) })), 413, 'too_large');
      await expectJsonError(await send('{}', { 'Content-Encoding': 'unsupported-test-encoding' }), 415, 'unsupported_encoding');
      await expectJsonError(await send('{}', { 'Content-Type': 'application/json; charset=iso-8859-1' }), 415, 'unsupported_encoding');
      assert.deepEqual(f.state.validations, []);
      assert.deepEqual(f.state.consumed, []);
      assert.deepEqual(f.state.deletedIds, []);
      assert.deepEqual(f.state.logs.filter((entry) => entry.level === 'error'), []);
      assert.ok(!JSON.stringify(f.state.logs).includes(secretFragment));
    });
  }
});

test('multipart upload authentication and limits preserve normal uploads', async (t) => {
  await t.test('an invalid header rejects before parsing even a malformed multipart body', async (t) => {
    const f = await fixture(t);
    const response = await f.request('/api/upload', {
      method: 'POST', headers: { 'X-Upload-Code': 'INVALID-CODE', 'Content-Type': 'multipart/form-data' },
      body: 'not-a-multipart-body'
    });
    await expectJsonError(response, 401, 'invalid_code');
    assert.deepEqual(f.state.validations, [{ type: 'upload', code: 'INVALID-CODE' }]);
    assert.deepEqual(f.state.consumed, []);
    assert.deepEqual(f.state.logs, []);
  });

  await t.test('legacy body codes and header-only codes still upload actual image bytes', async (t) => {
    const f = await fixture(t);
    for (const headerOnly of [false, true]) {
      const response = await f.upload(imageForm({ code: headerOnly ? null : UPLOAD_CODE }), headerOnly ? { 'X-Upload-Code': UPLOAD_CODE } : {});
      assert.equal(response.status, 201);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.mime, 'image/png');
      assert.equal(result.size, PNG_BYTES.length);
      const row = f.state.images.find((image) => image.id === result.id);
      assert.ok(row);
      assert.deepEqual(await fs.readFile(path.join(f.config.uploadsDir, row.stored_filename)), PNG_BYTES);
      assert.equal(result.html, `<img src="${result.url}" alt="test.png">`);
      assert.equal(result.markdown, `![test.png](${result.url})`);
    }
    assert.equal(f.state.consumed.length, 2);
    assert.ok(f.state.consumed.every(({ type, code }) => type === 'upload' && code === UPLOAD_CODE));
  });

  await t.test('Multer field/count/size errors are safe and leave upload codes unconsumed', async (t) => {
    const f = await fixture(t);
    await expectJsonError(await f.upload(imageForm({ field: 'unexpected-field' })), 400, 'invalid_upload');
    const twoFiles = imageForm();
    twoFiles.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), 'second.png');
    await expectJsonError(await f.upload(twoFiles), 400, 'invalid_upload');
    const tooManyFields = imageForm();
    for (let index = 0; index < 11; index++) tooManyFields.append('field' + index, 'value');
    await expectJsonError(await f.upload(tooManyFields), 400, 'invalid_upload');
    const longField = imageForm();
    longField.append('slug', 'x'.repeat(8193));
    await expectJsonError(await f.upload(longField), 400, 'invalid_upload');
    await expectJsonError(await f.upload(imageForm({ bytes: Buffer.alloc(1025) })), 413, 'too_large');
    assert.deepEqual(f.state.consumed, []);
    assert.deepEqual(f.state.images, []);
    assert.deepEqual(await fs.readdir(f.config.uploadsDir), []);
    assert.deepEqual(f.state.logs.filter((entry) => entry.level === 'error'), []);
    // Error responses must also release their admission slot.
    const valid = await f.upload(imageForm());
    assert.equal(valid.status, 201);
    await valid.arrayBuffer();
  });
});

// Leave a real HTTP multipart body unfinished so Multer must retain its slot.
// The server's request event runs after Express has synchronously admitted this
// body-only request, avoiding sleeps or assumptions about network timing.
async function openSlowUpload(t, f, sequence) {
  const boundary = 'server-review-boundary-' + sequence;
  let resolveIncoming;
  let resolveClosed;
  const incoming = new Promise((resolve) => { resolveIncoming = resolve; });
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const listener = (request, response) => {
    if (request.headers['x-test-stream'] !== String(sequence)) return;
    f.server.off('request', listener);
    response.once('close', resolveClosed);
    resolveIncoming(response);
  };
  f.server.on('request', listener);
  const request = http.request(f.base + '/api/upload', {
    method: 'POST', headers: {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'X-Test-Stream': String(sequence)
    }
  });
  const completed = new Promise((resolve, reject) => {
    request.once('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      response.once('error', reject);
    });
    request.once('error', reject);
  });
  // An intentional client abort rejects the response promise; retain that
  // rejection for callers without producing an unhandled-rejection failure.
  completed.catch(() => {});
  t.after(() => {
    f.server.off('request', listener);
    request.destroy();
  });
  request.write(`--${boundary}\r\nContent-Disposition: form-data; name="code"\r\n\r\n${UPLOAD_CODE}\r\n`);
  request.write(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="slow.png"\r\nContent-Type: image/png\r\n\r\n`);
  request.write(PNG_BYTES);
  const response = await incoming;
  assert.equal(response.headersSent, false, 'The streaming upload was admitted and is waiting for its final boundary');
  return {
    abort: async () => { request.destroy(); await closed; },
    finish: async () => { request.end(`\r\n--${boundary}--\r\n`); return completed; }
  };
}

test('four concurrent multipart bodies are bounded and slots release exactly once on finish/close', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const streams = [];
  for (let sequence = 0; sequence < 4; sequence++) streams.push(await openSlowUpload(t, f, sequence));

  const busy = await f.upload(imageForm());
  assert.equal(busy.headers.get('retry-after'), '1');
  await expectJsonError(busy, 503, 'upload_busy');
  assert.deepEqual(f.state.consumed, []);
  const health = await f.request('/api/health');
  assert.equal(health.status, 200);
  await health.arrayBuffer();

  // Header authentication runs before admission, including while saturated.
  await expectJsonError(await f.upload(imageForm(), { 'X-Upload-Code': 'INVALID-CODE' }), 401, 'invalid_code');

  assert.equal((await streams[0].finish()).status, 201);
  const afterFinish = await f.upload(imageForm());
  assert.equal(afterFinish.status, 201);
  await afterFinish.arrayBuffer();

  await streams[1].abort();
  await openSlowUpload(t, f, 4);
  await openSlowUpload(t, f, 5);
  // If both finish and close decrement the same slot, this request would slip
  // through; if an abort leaks a slot, the second new stream is rejected above.
  const busyAgain = await f.upload(imageForm());
  assert.equal(busyAgain.headers.get('retry-after'), '1');
  await expectJsonError(busyAgain, 503, 'upload_busy');
  assert.equal(f.state.consumed.length, 2);
});

test('disconnects cannot release parsed upload buffers while database validation remains pending', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const pending = [];
  let resolveAllEntered;
  const allEntered = new Promise((resolve) => { resolveAllEntered = resolve; });
  t.mock.method(store, 'isTokenValid', async (type, code) => {
    f.state.validations.push({ type, code });
    if (pending.length < 4) {
      await new Promise((resolve) => {
        pending.push(resolve);
        if (pending.length === 4) resolveAllEntered();
      });
    }
    return type === 'upload' && code === UPLOAD_CODE;
  });

  try {
    const streams = [];
    for (let sequence = 10; sequence < 14; sequence++) streams.push(await openSlowUpload(t, f, sequence));
    // Send every final multipart boundary. A validation call now proves that
    // Multer has already parsed the complete body and retains its image buffer.
    for (const stream of streams) stream.finish().catch(() => {});
    await allEntered;
    assert.equal(f.state.validations.length, 4);
    for (const stream of streams) await stream.abort();

    const busy = await f.upload(imageForm());
    assert.equal(busy.headers.get('retry-after'), '1');
    await expectJsonError(busy, 503, 'upload_busy');
    assert.equal(f.state.validations.length, 4, 'The fifth multipart body was rejected before handler validation');
    assert.deepEqual(f.state.consumed, []);

    for (const resolve of pending) resolve();
    // Drain the resumed validation/handler/finally microtasks, including
    // request-disconnect checks, before examining effects or opening a new body.
    await new Promise(setImmediate);
    assert.deepEqual(f.state.consumed, [], 'Aborted uploads must not consume a one-time code');
    assert.deepEqual(f.state.images, []);
    assert.deepEqual(await fs.readdir(f.config.uploadsDir), [], 'Aborted uploads must not write image files');

    const retry = await f.upload(imageForm());
    assert.equal(retry.status, 201, 'Validation completion must release the retained upload slots');
    const result = await retry.json();
    assert.equal(result.id, 1);
    assert.equal(f.state.consumed.length, 1);
    assert.equal(f.state.images.length, 1);
    assert.deepEqual(await fs.readFile(path.join(f.config.uploadsDir, f.state.images[0].stored_filename)), PNG_BYTES);
  } finally {
    // Never leave database stand-ins pending after an assertion failure.
    for (const resolve of pending) resolve();
    await new Promise(setImmediate);
  }
});
