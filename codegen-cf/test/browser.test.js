import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APP_SCRIPT } from '../src/script.js';

function browser(fetch) {
  const elements = new Map();
  const handlers = {};
  const timers = [];
  let copied;
  let uuidCount = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: true, disabled: true, textContent: '', className: '', events: {},
      addEventListener(event, callback) { this.events[event] = callback; },
      focus() { this.focused = true; },
      select() { this.selected = true; }
    });
    return elements.get(id);
  };
  vm.runInNewContext(APP_SCRIPT, {
    document: { getElementById: element },
    window: { addEventListener(event, callback) { handlers[event] = callback; } },
    navigator: { clipboard: { writeText: async value => { copied = value; } } },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuidCount).padStart(12, '0')}` },
    setTimeout: () => 1, clearTimeout() {}, setInterval: callback => timers.push(callback),
    Date, AbortController, fetch
  });
  return { element, handlers, timers, copied: () => copied };
}

const success = type => ({ ok: true, type, code: 'ABCD-2345', expiresAt: '2099-01-01T00:00:00.000Z', url: type === 'upload' ? 'https://images.example.com/' : 'https://images.example.com/manage' });
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('UI generates only on click, copies code, and clears it when leaving the page', async () => {
  const requests = [];
  const ui = browser(async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return reply(success('upload'));
  });
  assert.equal(requests.length, 0);
  await ui.element('uploadGenerate').events.click();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/codes');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.cache, 'no-store');
  assert.equal(requests[0].body.type, 'upload');
  assert.equal(ui.element('uploadCode').value, 'ABCD-2345');
  assert.equal(ui.element('uploadResult').hidden, false);
  assert.equal(ui.element('uploadCopy').disabled, false);
  await ui.element('uploadCopy').events.click();
  assert.equal(ui.copied(), 'ABCD-2345');
  assert.equal(ui.element('uploadStatus').textContent, 'Code copied.');
  ui.handlers.pagehide();
  assert.equal(ui.element('uploadCode').value, '');
  assert.equal(ui.element('uploadResult').hidden, true);
  assert.equal(ui.element('uploadCopy').disabled, true);
});

test('UI requires explicit retry, retains the same request ID on interruption, then allows a new request after 409', async () => {
  const requests = [];
  const ui = browser(async (url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) throw new Error('network interrupted');
    if (requests.length === 2) return reply({ ok: false, retryable: false, message: 'That request can no longer be used. Generate a new code.' }, 409);
    return reply(success('management'));
  });
  await ui.element('managementGenerate').events.click();
  assert.equal(requests.length, 1);
  assert.equal(ui.element('managementGenerate').textContent, 'Retry request');
  assert.equal(ui.element('managementCode').value, '');
  await ui.element('managementGenerate').events.click();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(ui.element('managementGenerate').textContent, 'Generate management code');
  await ui.element('managementGenerate').events.click();
  assert.equal(requests.length, 3);
  assert.notEqual(requests[1].requestId, requests[2].requestId);
  assert.equal(ui.element('managementCode').value, 'ABCD-2345');
});

test('UI disables generation during an in-flight request and never displays an expired code', async () => {
  let complete;
  let calls = 0;
  const ui = browser(() => {
    calls++;
    return new Promise(resolve => { complete = resolve; });
  });
  const pending = ui.element('uploadGenerate').events.click();
  assert.equal(ui.element('uploadGenerate').disabled, true);
  assert.equal(ui.element('managementGenerate').disabled, true);
  await ui.element('managementGenerate').events.click();
  assert.equal(calls, 1);
  complete(reply({ ...success('upload'), expiresAt: '2000-01-01T00:00:00.000Z' }));
  await pending;
  assert.equal(ui.element('uploadGenerate').disabled, false);
  assert.equal(ui.element('managementGenerate').disabled, false);
  assert.equal(ui.element('uploadResult').hidden, true);
  assert.equal(ui.element('uploadCode').value, '');
  assert.match(ui.element('uploadStatus').textContent, /expired/);
});

test('Leaving the page aborts generation and a late response cannot redisplay the code', async () => {
  let complete;
  let signal;
  const ui = browser((url, init) => {
    signal = init.signal;
    return new Promise(resolve => { complete = resolve; });
  });
  const pending = ui.element('uploadGenerate').events.click();
  ui.handlers.pagehide();
  assert.equal(signal.aborted, true);
  assert.equal(ui.element('uploadGenerate').disabled, false);
  assert.equal(ui.element('uploadGenerate').textContent, 'Retry request');
  complete(reply(success('upload')));
  await pending;
  assert.equal(ui.element('uploadCode').value, '');
  assert.equal(ui.element('uploadResult').hidden, true);
  assert.equal(ui.element('uploadCopy').disabled, true);
  assert.equal(ui.element('uploadStatus').textContent, '');
});

test('Returning to the page retries the original ID and ignores stale results after a new code', async () => {
  let completeOriginal;
  const requests = [];
  const ui = browser((url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) return new Promise(resolve => { completeOriginal = resolve; });
    if (requests.length === 2) return Promise.resolve(reply({ ok: false, retryable: false, message: 'Request already processed.' }, 409));
    return Promise.resolve(reply({ ...success('upload'), code: 'EFGH-6789' }));
  });
  const original = ui.element('uploadGenerate').events.click();
  ui.handlers.pagehide();
  await ui.element('uploadGenerate').events.click();
  assert.equal(requests[0].requestId, requests[1].requestId);
  await ui.element('uploadGenerate').events.click();
  assert.notEqual(requests[1].requestId, requests[2].requestId);
  assert.equal(ui.element('uploadCode').value, 'EFGH-6789');
  completeOriginal(reply(success('upload')));
  await original;
  assert.equal(ui.element('uploadCode').value, 'EFGH-6789');
  assert.equal(ui.element('uploadGenerate').textContent, 'Generate new code');
  assert.equal(ui.element('uploadResult').hidden, false);
});
