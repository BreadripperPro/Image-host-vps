import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.js';
import { renderPage } from '../src/ui.js';

const SECRET = 'a'.repeat(64);
const PUBLIC_ORIGIN = 'https://codes.example.com';
const IMAGEHOST_ORIGIN = 'https://images.example.com';
const ISSUE_ENDPOINT = `${IMAGEHOST_ORIGIN}/api/admin/codes`;
const REQUEST_ID = 'f03f85c4-44ca-4129-a28d-d0e98112dab6';
const ENV = { PUBLIC_ORIGIN, IMAGEHOST_ORIGIN, CODEGEN_SHARED_SECRET: SECRET };
const CTX = { access: { getIdentity: async () => ({ email: 'owner@example.net' }) } };
const validResult = type => ({ ok: true, type, code: 'ABCD-2345', expiresAt: type === 'upload' ? null : '2026-11-26T12:20:00.000Z', url: type === 'upload' ? `${IMAGEHOST_ORIGIN}/` : `${IMAGEHOST_ORIGIN}/manage` });
const jsonResponse = (value, status = 201, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function request(type = 'upload', extra = {}) {
  return new Request(PUBLIC_ORIGIN + '/api/codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ type, requestId: REQUEST_ID }),
    ...extra
  });
}
function assertPrivate(response) {
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
}
const neverFetch = () => { throw new Error('Origin must not be called for this request'); };

test('Access is enforced on every route and cannot be forged with headers', async () => {
  const handler = createHandler(neverFetch);
  for (const path of ['/', '/styles.css', '/app.js', '/api/codes', '/unknown']) {
    const req = new Request(PUBLIC_ORIGIN + path, { headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.net', 'Cf-Access-Jwt-Assertion': 'not-a-real-jwt' } });
    const result = await handler(req, ENV, {});
    assert.equal(result.status, 403);
    assertPrivate(result);
    assert.doesNotMatch(await result.text(), /ABCD-2345/);
  }
});

test('Access errors, missing identity and non-human identities fail closed', async () => {
  for (const context of [undefined, { access: {} }, { access: { getIdentity: async () => { throw new Error('not authenticated'); } } }, { access: { getIdentity: async () => null } }, { access: { getIdentity: async () => ({ email: '' }) } }]) {
    const response = await createHandler(neverFetch)(request(), ENV, context);
    assert.equal(response.status, 403);
  }
});

test('Optional exact email allowlist supplements Access', async () => {
  const handler = createHandler(neverFetch);
  assert.equal((await handler(new Request(PUBLIC_ORIGIN), { ...ENV, ALLOWED_EMAILS: 'other@example.net' }, CTX)).status, 403);
  assert.equal((await handler(new Request(PUBLIC_ORIGIN), { ...ENV, ALLOWED_EMAILS: '  OWNER@example.net , other@example.net ' }, CTX)).status, 200);
  assert.equal((await handler(new Request(PUBLIC_ORIGIN), { ...ENV, ALLOWED_EMAILS: ['owner@example.net'] }, CTX)).status, 403);
});

test('Only the intended HTTPS hostname is served', async () => {
  const handler = createHandler(neverFetch);
  for (const origin of ['https://example.workers.dev', 'http://codes.example.com', 'https://evil.example', 'https://codes.example.com:8443']) {
    assert.equal((await handler(new Request(origin), ENV, CTX)).status, 403);
  }
});

test('Missing or malformed deployment origins fail closed without reflecting their values', async () => {
  const invalid = [
    undefined, null, {}, '', 'not a URL', '//images.example.com',
    'http://images.example.com', 'ftp://images.example.com',
    'https://images.example.com/', 'https://images.example.com/api/admin/codes',
    'https://images.example.com?target=ignored', 'https://images.example.com#fragment',
    'https://images.example.com:8443', 'https://images.example.com:443',
    ' https://images.example.com', 'https://images.example.com\n',
    'https://images.example.com\\@evil.example',
    `https://${SECRET}@images.example.com`, `https://user:${SECRET}@images.example.com`
  ];
  const handler = createHandler(neverFetch);
  for (const key of ['PUBLIC_ORIGIN', 'IMAGEHOST_ORIGIN']) {
    for (const value of invalid) {
      const result = await handler(request(), { ...ENV, [key]: value }, CTX);
      assert.equal(result.status, 503, `${key} must reject ${String(value)}`);
      assertPrivate(result);
      assert.deepEqual(await result.json(), { ok: false, message: 'The generator has not been configured.', retryable: false });
    }
  }
  assert.equal((await handler(request(), { ...ENV, IMAGEHOST_ORIGIN: PUBLIC_ORIGIN }, CTX)).status, 503);
});

test('Validated deployment origins control the page links, request checks and sole upstream destination', async () => {
  const env = { ...ENV, PUBLIC_ORIGIN: 'https://generator.example.net', IMAGEHOST_ORIGIN: 'https://photos.example.net' };
  let calls = 0;
  const handler = createHandler(async (url, init) => {
    calls++;
    assert.equal(url, `${env.IMAGEHOST_ORIGIN}/api/admin/codes`);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
    const { type } = JSON.parse(init.body);
    return jsonResponse({ ...validResult(type), url: `${env.IMAGEHOST_ORIGIN}${type === 'management' ? '/manage' : '/'}` });
  });
  const page = await handler(new Request(env.PUBLIC_ORIGIN), env, CTX);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /href="https:\/\/photos\.example\.net\/"/);
  assert.match(html, /href="https:\/\/photos\.example\.net\/manage"/);
  assert.doesNotMatch(html, /images\.example\.com|generator\.example\.net|CODEGEN_SHARED_SECRET/);
  assert.doesNotMatch(html, new RegExp(SECRET));
  assert.equal(calls, 0);
  assert.equal((await handler(request(), env, CTX)).status, 403);
  for (const type of ['upload', 'management']) {
    const input = new Request(`${env.PUBLIC_ORIGIN}/api/codes`, {
      method: 'POST',
      headers: { Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'X-Upstream-Url': 'https://evil.example' },
      body: JSON.stringify({ type, requestId: REQUEST_ID })
    });
    const result = await handler(input, env, CTX);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).url, `${env.IMAGEHOST_ORIGIN}${type === 'management' ? '/manage' : '/'}`);
  }
  assert.equal(calls, 2);
  const wrongOrigin = new Request(`${env.PUBLIC_ORIGIN}/api/codes`, {
    method: 'POST', headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'upload', requestId: REQUEST_ID })
  });
  assert.equal((await handler(wrongOrigin, env, CTX)).status, 403);
  assert.equal(calls, 2);
});

test('Deployment origins accept DNS labels and punycode but reject punctuation and invalid label lengths', async () => {
  const handler = createHandler(neverFetch);
  const invalid = [
    'https://photo"s.example', 'https://photos.example&unused=1',
    "https://photo's.example", 'https://photos_example.com',
    'https://-photos.example', 'https://photos-.example',
    'https://photos..example', 'https://photos.example.', 'https://localhost',
    `https://${'a'.repeat(64)}.example`,
    `https://${Array(4).fill('a'.repeat(63)).join('.')}`
  ];
  for (const key of ['PUBLIC_ORIGIN', 'IMAGEHOST_ORIGIN']) {
    for (const value of invalid) {
      const result = await handler(request(), { ...ENV, [key]: value }, CTX);
      assert.equal(result.status, 503, `${key} must reject ${value}`);
      assert.deepEqual(await result.json(), { ok: false, message: 'The generator has not been configured.', retryable: false });
    }
  }
  const result = await handler(new Request(PUBLIC_ORIGIN), { ...ENV, IMAGEHOST_ORIGIN: 'https://xn--bcher-kva.example' }, CTX);
  assert.equal(result.status, 200);
  assert.match(await result.text(), /href="https:\/\/xn--bcher-kva\.example\/manage"/);
});

test('Page renderer escapes every HTML attribute delimiter when called directly', () => {
  const html = renderPage(`https://photos.example"><img src=x onerror='alert(1)'>&unused=1`);
  const escaped = 'https://photos.example&quot;&gt;&lt;img src=x onerror=&#39;alert(1)&#39;&gt;&amp;unused=1';
  assert.ok(html.includes(`href="${escaped}/"`));
  assert.ok(html.includes(`href="${escaped}/manage"`));
  assert.doesNotMatch(html, /<img|&unused=1/);
});

test('Missing, weak, malformed and control-character secrets fail closed', async () => {
  for (const secret of [undefined, '', 'a'.repeat(63), 'a'.repeat(129), 'g'.repeat(64), SECRET + '\n']) {
    assert.equal((await createHandler(neverFetch)(request(), { ...ENV, CODEGEN_SHARED_SECRET: secret }, CTX)).status, 503);
  }
});

test('Page and assets are private, contain no credentials, and generate nothing on GET', async () => {
  const handler = createHandler(neverFetch);
  for (const [path, contentType] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css']]) {
    const res = await handler(new Request(PUBLIC_ORIGIN + path), ENV, CTX);
    assert.equal(res.status, 200);
    assertPrivate(res);
    assert.ok(res.headers.get('Content-Type').startsWith(contentType));
    const text = await res.text();
    assert.doesNotMatch(text, new RegExp(SECRET));
    assert.doesNotMatch(text, /CODEGEN_SHARED_SECRET/);
    if (path === '/') {
      assert.match(text, /Generate upload code/);
      assert.match(text, /Generate management code/);
      assert.match(text, /<script src="\/app.js" defer><\/script>/);
      assert.doesNotMatch(text, /<script>(?!<\/script>)/);
    }
  }
  const get = await handler(new Request(PUBLIC_ORIGIN + '/api/codes'), ENV, CTX);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
});

test('Unknown paths, query strings and unsupported methods are refused', async () => {
  const handler = createHandler(neverFetch);
  assert.equal((await handler(new Request(PUBLIC_ORIGIN + '/unknown'), ENV, CTX)).status, 404);
  assert.equal((await handler(new Request(PUBLIC_ORIGIN + '/?secret=ignored'), ENV, CTX)).status, 400);
  for (const method of ['PUT', 'DELETE', 'OPTIONS']) {
    const res = await handler(new Request(PUBLIC_ORIGIN + '/api/codes', { method }), ENV, CTX);
    assert.equal(res.status, 405);
    assertPrivate(res);
  }
});

test('POST rejects absent, same-site-subdomain and cross-site origins', async () => {
  const handler = createHandler(neverFetch);
  for (const origin of [null, 'null', IMAGEHOST_ORIGIN, 'https://evil.example']) {
    const headers = { 'Content-Type': 'application/json' };
    if (origin !== null) headers.Origin = origin;
    assert.equal((await handler(request('upload', { headers }), ENV, CTX)).status, 403);
  }
  const headers = { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' };
  assert.equal((await handler(request('upload', { headers }), ENV, CTX)).status, 403);
});

test('POST accepts only small strict JSON with a type and UUIDv4', async () => {
  const handler = createHandler(neverFetch);
  const invalidBodies = ['{', 'null', '[]', '{}', JSON.stringify({ type: 'admin', requestId: REQUEST_ID }), JSON.stringify({ type: 'upload', requestId: 'bad' }), JSON.stringify({ type: 'upload', requestId: REQUEST_ID, url: 'https://evil.example' }), JSON.stringify({ type: 'upload', requestId: REQUEST_ID, padding: 'x'.repeat(1200) })];
  for (const body of invalidBodies) {
    const res = await handler(request('upload', { body }), ENV, CTX);
    assert.ok([400, 413].includes(res.status));
    assertPrivate(res);
  }
  assert.equal((await handler(request('upload', { headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'text/plain' } }), ENV, CTX)).status, 415);
});

test('Oversized request and response rejection does not wait for failed or unresponsive cancellation', async () => {
  for (const [direction, rejects] of [['request', false], ['response', false], ['request', true], ['response', true]]) {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(direction === 'request' ? 2048 : 9000)); },
      cancel() { cancelled = true; return rejects ? Promise.reject(new Error('private cleanup failure')) : new Promise(() => {}); }
    });
    const handler = direction === 'request' ? createHandler(neverFetch) : createHandler(async () => new Response(stream, { status: 201 }));
    const input = direction === 'request' ? request('upload', { body: stream, duplex: 'half' }) : request();
    let timer;
    try {
      const result = await Promise.race([
        handler(input, ENV, CTX),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Size-limit rejection waited for cancellation')), 1000); })
      ]);
      assert.equal(result.status, direction === 'request' ? 413 : 502);
      assertPrivate(result);
      assert.equal(cancelled, true);
    } finally { clearTimeout(timer); }
  }
});

for (const type of ['upload', 'management']) {
  test(`Successful ${type} code is sanitized and sent only to fixed origin`, async () => {
    let calls = 0;
    const handler = createHandler(async (url, init) => {
      calls++;
      assert.equal(url, ISSUE_ENDPOINT);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer ' + SECRET);
      assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'Authorization', 'Content-Type']);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.cache, 'no-store');
      assert.ok(init.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(init.body), { type, requestId: REQUEST_ID });
      return jsonResponse({ ...validResult(type), password: 'origin-db-secret', internalId: 1 });
    });
    const res = await handler(request(type), ENV, CTX);
    assert.equal(res.status, 200);
    assertPrivate(res);
    assert.deepEqual(await res.json(), { ...validResult(type), requestId: REQUEST_ID });
    assert.equal(calls, 1);
  });
}

test('Origin requests use the redirect mode supported by the Workers runtime', async () => {
  let originCalls = 0;
  const workersFetch = async (url, init) => {
    // Unlike Node's fetch, Workers rejects `error` before any origin request.
    // Model that runtime restriction so this regression cannot pass in Node
    // merely because its native Request accepts a mode Workers does not.
    if (!['follow', 'manual'].includes(init.redirect)) {
      throw new TypeError('The Workers runtime does not implement this redirect mode.');
    }
    assert.equal(init.redirect, 'manual');
    assert.equal(url, ISSUE_ENDPOINT);
    originCalls++;
    return jsonResponse(validResult('upload'));
  };
  const response = await createHandler(workersFetch)(request(), ENV, CTX);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...validResult('upload'), requestId: REQUEST_ID });
  assert.equal(originCalls, 1);
});

test('Every upstream redirect is refused without following Location or exposing credentials', async () => {
  for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
    let calls = 0;
    const handler = createHandler(async (url, init) => {
      calls++;
      assert.equal(url, ISSUE_ENDPOINT);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.Authorization, 'Bearer ' + SECRET);
      return new Response(status === 304 ? null : 'sensitive upstream response', {
        status,
        headers: { Location: `https://evil.example/collect?secret=${SECRET}` }
      });
    });
    const response = await handler(request(), ENV, CTX);
    assert.equal(response.status, 502, `HTTP ${status} must not be followed`);
    assertPrivate(response);
    assert.equal(response.headers.get('Location'), null);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(SECRET));
    assert.doesNotMatch(text, /evil\.example|sensitive upstream/);
    assert.equal(JSON.parse(text).retryable, false);
    assert.equal(calls, 1, `HTTP ${status} must make only the original fixed-origin call`);
  }
});

test('Each upstream failure is sanitized, private and never automatically retried', async () => {
  for (const [upstreamStatus, expectedStatus, retryable] of [[400, 502, false], [401, 502, false], [403, 502, false], [409, 409, false], [500, 502, true], [503, 503, true], [302, 502, false]]) {
    let calls = 0;
    const handler = createHandler(async () => { calls++; return new Response('sensitive SQL and credentials', { status: upstreamStatus }); });
    const res = await handler(request(), ENV, CTX);
    assert.equal(res.status, expectedStatus);
    assertPrivate(res);
    const body = await res.json();
    assert.equal(body.retryable, retryable);
    assert.equal(body.ok, false);
    assert.equal(body.code, undefined);
    assert.match(body.message, new RegExp(`HTTP ${upstreamStatus}\\b`));
    assert.doesNotMatch(body.message, /sensitive SQL/);
    assert.equal(calls, 1);
  }
});

test('Origin failures include safe status-specific diagnostics without forwarding response contents', async () => {
  const cases = [
    [400, /request format/], [404, /codeGenerator\.enabled/], [405, /POST/],
    [413, /size/], [415, /Content-Type/], [500, /journalctl/],
    [502, /Nginx/], [504, /timed out/], [520, /unexpected origin/],
    [521, /listening/], [522, /port forwarding/], [523, /DNS/],
    [524, /database/], [525, /TLS handshake/], [526, /TLS certificate/],
    [530, /Cloudflare routing/]
  ];
  for (const [status, hint] of cases) {
    let calls = 0;
    const response = await createHandler(async () => {
      calls++;
      return new Response(`private upstream HTML and secret ${SECRET}`, { status });
    })(request(), ENV, CTX);
    assert.equal(response.status, 502);
    assertPrivate(response);
    const data = await response.json();
    assert.match(data.message, new RegExp(`HTTP ${status}\\b`));
    assert.match(data.message, hint);
    assert.doesNotMatch(JSON.stringify(data), /private upstream HTML/);
    assert.doesNotMatch(JSON.stringify(data), new RegExp(SECRET));
    assert.equal(data.retryable, status >= 500);
    assert.equal(calls, 1);
  }
});

test('An origin HTTPS rejection is identified separately from a credential mismatch', async () => {
  let calls = 0;
  const handler = createHandler(async () => {
    calls++;
    return jsonResponse({ ok: false, error: 'https_required', message: `untrusted message ${SECRET}` }, 403);
  });
  const response = await handler(request(), ENV, CTX);
  assert.equal(response.status, 502);
  assertPrivate(response);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.retryable, false);
  assert.match(body.message, /HTTPS/);
  assert.doesNotMatch(body.message, /rejected.*credential|credential.*(?:mismatch|match)|untrusted message/);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET));
  assert.equal(calls, 1);
});

test('Only the VPS unauthorized error identifies a rejected generator credential', async () => {
  let calls = 0;
  const handler = createHandler(async () => {
    calls++;
    return jsonResponse({ ok: false, error: 'unauthorized', message: `do not relay ${SECRET}` }, 401);
  });
  const response = await handler(request(), ENV, CTX);
  assert.equal(response.status, 502);
  assertPrivate(response);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.retryable, false);
  assert.match(body.message, /credential/i);
  assert.doesNotMatch(JSON.stringify(body), /do not relay/);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET));
  assert.equal(calls, 1);
});

test('HTML and unknown origin authentication failures are reported as blocked without reflecting content', async () => {
  for (const status of [401, 403]) {
    const upstreams = [
      new Response(`<html>private Access page ${SECRET}</html>`, { status, headers: { 'Content-Type': 'text/html' } }),
      jsonResponse({ ok: false, error: 'unknown_error', message: `private WAF reason ${SECRET}` }, status),
      // Error names are interpreted only for their matching VPS status code.
      jsonResponse({ error: status === 401 ? 'https_required' : 'unauthorized', message: SECRET }, status)
    ];
    for (const upstream of upstreams) {
      let calls = 0;
      const response = await createHandler(async () => { calls++; return upstream; })(request(), ENV, CTX);
      assert.equal(response.status, 502);
      assertPrivate(response);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.retryable, false);
      assert.match(body.message, /blocked/i);
      assert.doesNotMatch(body.message, /rejected the generator credential|private Access page|private WAF reason/);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET));
      assert.equal(calls, 1);
    }
  }
});

test('Malformed and oversized authentication errors stay bounded and sanitized', async () => {
  for (const status of [401, 403]) {
    let oversizedCancelled = false;
    const upstreams = [
      new Response(`not valid JSON ${SECRET}`, { status, headers: { 'Content-Type': 'application/json' } }),
      new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status, headers: { 'Content-Type': 'application/json' } }),
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: 'https_required', message: SECRET, padding: 'x'.repeat(9000) })));
        },
        cancel() { oversizedCancelled = true; }
      }), { status, headers: { 'Content-Type': 'application/json' } })
    ];
    for (const upstream of upstreams) {
      let calls = 0;
      const response = await createHandler(async () => { calls++; return upstream; })(request(), ENV, CTX);
      assert.equal(response.status, 502);
      assertPrivate(response);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.retryable, false);
      assert.match(body.message, /blocked/i);
      assert.doesNotMatch(JSON.stringify(body), /not valid JSON|padding/);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(SECRET));
      assert.equal(calls, 1);
    }
    assert.equal(oversizedCancelled, true, 'the oversized upstream response stream is cancelled');
  }
});

test('Rate limit delay is bounded and propagated', async () => {
  for (const [delay, expected] of [['3', '3'], ['bogus', '30'], ['9999999', '30']]) {
    const handler = createHandler(async () => new Response(null, { status: 429, headers: { 'Retry-After': delay } }));
    const response = await handler(request(), ENV, CTX);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), expected);
    assert.equal((await response.json()).retryable, true);
  }
});

test('Malformed, oversized or unexpected upstream success cannot become a code result', async () => {
  const invalid = [
    new Response('not-json', { status: 201 }),
    new Response('x'.repeat(9000), { status: 201 }),
    jsonResponse({ ...validResult('upload'), type: 'management' }),
    jsonResponse({ ...validResult('upload'), url: 'https://evil.example' }),
    jsonResponse({ ...validResult('upload'), expiresAt: 'not-a-date' }),
    jsonResponse({ ...validResult('upload'), code: '<script>' }),
    jsonResponse({ ok: true })
  ];
  for (const upstream of invalid) {
    const response = await createHandler(async () => upstream)(request(), ENV, CTX);
    assert.equal(response.status, 502);
    const value = await response.json();
    assert.equal(value.code, undefined);
    assert.equal(value.retryable, true);
  }
});

test('Network failures and redirects do not reveal errors or trigger retries', async () => {
  let calls = 0;
  const response = await createHandler(async (url, init) => {
    calls++;
    assert.equal(url, ISSUE_ENDPOINT);
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(JSON.parse(init.body), { type: 'upload', requestId: REQUEST_ID });
    throw new Error('secret URL with credentials');
  })(request(), ENV, CTX);
  assert.equal(response.status, 504);
  assertPrivate(response);
  const text = await response.text();
  assert.doesNotMatch(text, /secret URL/);
  assert.equal(JSON.parse(text).retryable, true);
  assert.equal(calls, 1);
});
