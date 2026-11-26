'use strict';

// Run the actual page scripts against a small DOM and controlled network.
// No server, database, external browser or third-party DOM package is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

class Element {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.events = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.files = [];
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    const update = (values) => { this.className = [...values].join(' '); };
    this.classList = {
      add: (...names) => { const set = classes(); names.forEach(name => set.add(name)); update(set); },
      remove: (...names) => { const set = classes(); names.forEach(name => set.delete(name)); update(set); },
      contains: name => classes().has(name),
      toggle: (name, force) => {
        const set = classes();
        const enabled = force === undefined ? !set.has(name) : Boolean(force);
        if (enabled) set.add(name); else set.delete(name);
        update(set);
        return enabled;
      }
    };
  }
  set innerHTML(value) { this._innerHTML = value; this.children = []; }
  get innerHTML() { return this._innerHTML || ''; }
  get childElementCount() { return this.children.length; }
  appendChild(child) {
    if (child.isFragment) {
      const contents = child.children.slice();
      child.children = [];
      contents.forEach(item => this.appendChild(item));
    } else {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
    }
    return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(type, handler) {
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(handler);
  }
  setAttribute(name, value) { this.attributes[name] = value; this[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? this[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const match = /^([a-z]+)?(?:\.([a-z-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\])?$/i.exec(selector);
    return Boolean(match && (!match[1] || this.tagName === match[1].toUpperCase()) &&
      (!match[2] || this.classList.contains(match[2])) &&
      (!match[3] || (this.getAttribute(match[3]) !== null && (!match[4] || String(this.getAttribute(match[3])) === match[4]))));
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  scrollIntoView() {}
  click() {}
}

class FormDataFixture {
  constructor() { this.entries = []; }
  append(name, value, filename) { this.entries.push({ name, value, filename }); }
  get(name) { return this.entries.find(entry => entry.name === name)?.value ?? null; }
}

const reply = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' }
});
const preventDefault = () => {};
const image = id => ({
  id, filename: `image-${id}.png`, url: `https://images.fixture.test/i/${id}`,
  uploadedAt: '2026-11-26 01:02:03', sizeLabel: '1 KB', mime: 'image/png'
});
const listReply = images => reply({ ok: true, images, databaseAdminUrl: '/api/manage/database' });
const file = (name, type = 'image/png') => ({ name, type, size: 1024 });

function page(scriptName, network) {
  const elements = new Map();
  const requests = [];
  const windowEvents = new Map();
  const createdUrls = [];
  const revokedUrls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element('div', id));
    return elements.get(id);
  };
  const body = new Element('body');
  for (const id of ['code', 'slug', 'file', 'mcode']) element(id).tagName = 'INPUT';
  element('uploadForm').append(element('code'), element('slug'), element('file'), element('submitBtn'));
  element('uploadForm').reset = () => {
    for (const id of ['code', 'slug', 'file']) { element(id).value = ''; element(id).files = []; }
  };
  const loginButton = new Element('button', 'loginSubmit');
  elements.set(loginButton.id, loginButton);
  loginButton.type = 'submit';
  element('loginForm').append(element('mcode'), loginButton);
  element('deleteSelectedBtn').disabled = true;
  element('preview').style.display = 'none';
  class PageURL extends URL {}
  PageURL.createObjectURL = value => {
    const url = 'blob:fixture-' + (createdUrls.length + 1);
    createdUrls.push({ url, value });
    return url;
  };
  PageURL.revokeObjectURL = url => revokedUrls.push(url);
  const context = {
    document: {
      body, getElementById: element, createElement: tag => new Element(tag),
      createDocumentFragment: () => Object.assign(new Element(), { isFragment: true }),
      querySelectorAll: () => [], addEventListener() {}, execCommand: () => true
    },
    window: {
      isSecureContext: true, open() {}, scrollTo() {},
      addEventListener(type, handler) { windowEvents.set(type, handler); }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => 1, clearTimeout() {}, URL: PageURL, FormData: FormDataFixture,
    AbortController, Date, console,
    fetch(url, init = {}) {
      requests.push({ url, init });
      if (url === '/api/site-settings') return Promise.resolve(reply({ codeGeneratorUrl: null }));
      return Promise.resolve(network(url, init));
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public', scriptName), 'utf8'), context, { filename: scriptName });
  return {
    element, requests, createdUrls, revokedUrls, windowEvents,
    async fire(id, type, extra = {}) {
      const target = element(id);
      const event = { preventDefault, target, ...extra };
      for (const handler of target.events.get(type) || []) await handler(event);
    },
    async settle() {
      for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
    },
    async choose(value) {
      element('file').files = value ? [value] : [];
      await this.fire('file', 'change');
    }
  };
}

function managerNetwork(handlers) {
  return (url, init) => {
    if (url === '/api/manage/status') return reply({ ok: true, authenticated: true, databaseAdminUrl: '/api/manage/database' });
    if (url === '/api/manage/login') return reply({ ok: true, databaseAdminUrl: '/api/manage/database' });
    if (url === '/api/manage/logout') return reply({ ok: true });
    return handlers(url, init);
  };
}

async function selectAndDelete(ui) {
  await ui.fire('selectAllBtn', 'click');
  await ui.fire('deleteSelectedBtn', 'click');
  await ui.fire('confirmDelete', 'click');
  await ui.settle();
}

test('manager deletes a selection above 500 in sequential bounded batches and refreshes the gallery', async () => {
  let remaining = Array.from({ length: 1001 }, (_, index) => image(index + 1));
  const batches = [];
  let listingRequests = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const ui = page('manage.js', managerNetwork(async (url, init) => {
    if (url === '/api/manage/images') { listingRequests++; return listReply(remaining); }
    assert.equal(url, '/api/manage/delete');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
    const ids = JSON.parse(init.body).ids;
    batches.push(ids);
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(resolve => setImmediate(resolve));
    concurrent--;
    remaining = remaining.filter(item => !ids.includes(item.id));
    return reply({ ok: true, deleted: ids, notFound: [], orphanedFiles: [], message: `Deleted ${ids.length} images.` });
  }));
  await ui.settle();
  assert.equal(ui.element('grid').children.length, 1001);
  await selectAndDelete(ui);
  assert.deepEqual(batches.map(ids => ids.length), [500, 500, 1]);
  assert.deepEqual(batches.flat(), Array.from({ length: 1001 }, (_, index) => index + 1));
  assert.equal(maxConcurrent, 1);
  assert.equal(listingRequests, 2);
  assert.equal(ui.element('grid').children.length, 0);
  assert.equal(ui.element('deleteSelectedBtn').disabled, true);
  assert.equal(ui.element('confirmDelete').disabled, false);
  assert.match(ui.element('managerMsg').textContent, /Deleted 1001 images\./);
});

test('manager aggregates actual deletion counts and missing-file warnings across every batch', async () => {
  let remaining = Array.from({ length: 1001 }, (_, index) => image(index + 1));
  const batches = [];
  const ui = page('manage.js', managerNetwork((url, init) => {
    if (url === '/api/manage/images') return listReply(remaining);
    assert.equal(url, '/api/manage/delete');
    const ids = JSON.parse(init.body).ids;
    batches.push(ids);
    // One record disappeared before deletion. A missing file is still a
    // deleted database record and must not be subtracted a second time.
    const notFound = ids.filter(id => id === 1001);
    const deleted = ids.filter(id => id !== 1001);
    const orphanedFiles = ids.filter(id => id === 1 || id === 501);
    remaining = remaining.filter(item => !ids.includes(item.id));
    return reply({ ok: true, deleted, notFound, orphanedFiles, message: `Deleted ${deleted.length} images.` });
  }));
  await ui.settle();
  await selectAndDelete(ui);
  assert.deepEqual(batches.map(ids => ids.length), [500, 500, 1]);
  assert.match(ui.element('managerMsg').textContent, /Deleted 1000 images\./);
  assert.match(ui.element('managerMsg').textContent, /missing file|files?.*(?:missing|cleaned)/i);
  assert.equal(ui.element('grid').children.length, 0);
});

test('manager refreshes after a partially completed bulk delete and reports the failure', async () => {
  let remaining = Array.from({ length: 1001 }, (_, index) => image(index + 1));
  let batches = 0;
  let listingRequests = 0;
  const ui = page('manage.js', managerNetwork((url, init) => {
    if (url === '/api/manage/images') { listingRequests++; return listReply(remaining); }
    assert.equal(url, '/api/manage/delete');
    const ids = JSON.parse(init.body).ids;
    batches++;
    if (batches === 2) return reply({ ok: false, message: 'Simulated second-batch failure.' }, 500);
    remaining = remaining.filter(item => !ids.includes(item.id));
    return reply({ ok: true, deleted: ids, orphanedFiles: [], message: 'Deleted images.' });
  }));
  await ui.settle();
  await selectAndDelete(ui);
  assert.equal(batches, 2);
  assert.equal(listingRequests, 2);
  assert.equal(ui.element('grid').children.length, 501);
  assert.equal(ui.element('deleteSelectedBtn').disabled, true);
  assert.equal(ui.element('confirmDelete').disabled, false);
  assert.match(ui.element('managerMsg').textContent, /Simulated second-batch failure/);
  assert.equal(ui.element('modal').classList.contains('show'), false);
});

test('manager does not submit later delete batches after the first request fails', async () => {
  let batches = 0;
  const ui = page('manage.js', managerNetwork((url) => {
    if (url === '/api/manage/images') return listReply(Array.from({ length: 1001 }, (_, index) => image(index + 1)));
    assert.equal(url, '/api/manage/delete');
    batches++;
    return reply({ ok: false, message: 'Simulated first-batch failure.' }, 500);
  }));
  await ui.settle();
  await selectAndDelete(ui);
  assert.equal(batches, 1);
  assert.equal(ui.element('confirmDelete').disabled, false);
  assert.equal(ui.element('modal').classList.contains('show'), false);
  assert.match(ui.element('managerMsg').textContent, /Simulated first-batch failure/);
});

test('manager ignores a duplicate confirmation while deletion is pending', async () => {
  const deletions = [];
  let deleted = false;
  const ui = page('manage.js', managerNetwork((url) => {
    if (url === '/api/manage/images') return listReply(deleted ? [] : [image(1)]);
    assert.equal(url, '/api/manage/delete');
    return new Promise(resolve => { deletions.push(resolve); });
  }));
  await ui.settle();
  await ui.fire('selectAllBtn', 'click');
  await ui.fire('deleteSelectedBtn', 'click');
  const pending = ui.fire('confirmDelete', 'click');
  const duplicate = ui.fire('confirmDelete', 'click');
  const disabledWhilePending = ui.element('confirmDelete').disabled;
  deleted = true;
  deletions.forEach(complete => complete(reply({ ok: true, deleted: [1], message: 'Deleted 1 image.' })));
  await Promise.all([pending, duplicate]);
  assert.equal(deletions.length, 1);
  assert.equal(disabledWhilePending, true);
  assert.equal(ui.element('confirmDelete').disabled, false);
  assert.equal(ui.element('grid').children.length, 0);
});

test('manager stops bulk deletion and clears private gallery state when a later batch returns 401', async () => {
  let batches = 0;
  const ui = page('manage.js', managerNetwork((url, init) => {
    if (url === '/api/manage/images') return listReply(Array.from({ length: 1001 }, (_, index) => image(index + 1)));
    assert.equal(url, '/api/manage/delete');
    batches++;
    if (batches === 2) return reply({ ok: false }, 401);
    return reply({ ok: true, deleted: JSON.parse(init.body).ids, orphanedFiles: [], message: 'Deleted images.' });
  }));
  await ui.settle();
  await selectAndDelete(ui);
  assert.equal(batches, 2);
  assert.equal(ui.element('managerView').style.display, 'none');
  assert.equal(ui.element('grid').children.length, 0);
  assert.equal(ui.element('deleteSelectedBtn').disabled, true);
  await ui.fire('selectAllBtn', 'click');
  assert.equal(ui.element('grid').children.length, 0, 'selection cannot resurrect logged-out image metadata');
});

test('manager ignores a listing response arriving while logout is pending', async () => {
  let completeListing;
  let completeLogout;
  const ui = page('manage.js', (url) => {
    if (url === '/api/manage/status') return reply({ ok: true, authenticated: true, databaseAdminUrl: '/api/manage/database' });
    if (url === '/api/manage/logout') return new Promise(resolve => { completeLogout = resolve; });
    assert.equal(url, '/api/manage/images');
    return new Promise(resolve => { completeListing = resolve; });
  });
  await ui.settle();
  assert.equal(typeof completeListing, 'function');
  const logout = ui.fire('logoutLink', 'click');
  completeListing(listReply([image(1), image(2)]));
  await ui.settle();
  const whilePending = {
    managerHidden: ui.element('managerView').style.display,
    imageCount: ui.element('grid').children.length,
    deleteDisabled: ui.element('deleteSelectedBtn').disabled,
    databaseHidden: ui.element('databaseAdminBtn').hidden
  };
  completeLogout(reply({ ok: true }));
  await logout;
  assert.deepEqual(whilePending, {
    managerHidden: 'none', imageCount: 0, deleteDisabled: true, databaseHidden: true
  });
  assert.equal(ui.element('managerView').style.display, 'none');
  assert.equal(ui.element('grid').children.length, 0);
  assert.equal(ui.element('deleteSelectedBtn').disabled, true);
  assert.equal(ui.element('databaseAdminBtn').hidden, true);
});

test('manager ignores a restored session response arriving after logout', async () => {
  let completeStatus;
  let listingRequests = 0;
  const ui = page('manage.js', (url) => {
    if (url === '/api/manage/status') return new Promise(resolve => { completeStatus = resolve; });
    if (url === '/api/manage/logout') return reply({ ok: true });
    assert.equal(url, '/api/manage/images');
    listingRequests++;
    return listReply([image(1)]);
  });
  await ui.fire('logoutLink', 'click');
  completeStatus(reply({ ok: true, authenticated: true, databaseAdminUrl: '/api/manage/database' }));
  await ui.settle();
  assert.equal(listingRequests, 0);
  assert.equal(ui.element('managerView').style.display, 'none');
  assert.equal(ui.element('grid').children.length, 0);
  assert.equal(ui.element('databaseAdminBtn').hidden, true);
});

test('manager ignores a login response arriving after logout', async () => {
  let completeLogin;
  let listingRequests = 0;
  const ui = page('manage.js', (url) => {
    if (url === '/api/manage/status') return reply({ ok: true, authenticated: false });
    if (url === '/api/manage/login') return new Promise(resolve => { completeLogin = resolve; });
    if (url === '/api/manage/logout') return reply({ ok: true });
    assert.equal(url, '/api/manage/images');
    listingRequests++;
    return listReply([image(1)]);
  });
  await ui.settle();
  ui.element('mcode').value = 'ABCD-2345';
  const pending = ui.fire('loginForm', 'submit');
  await ui.fire('logoutLink', 'click');
  completeLogin(reply({ ok: true, databaseAdminUrl: '/api/manage/database' }));
  await pending;
  assert.equal(listingRequests, 0);
  assert.equal(ui.element('managerView').style.display, 'none');
  assert.equal(ui.element('grid').children.length, 0);
  assert.equal(ui.element('databaseAdminBtn').hidden, true);
  assert.equal(ui.element('loginSubmit').disabled, false);
});

test('a failed management reload cannot leave a stale gallery or old selection available', async () => {
  let listingRequests = 0;
  const ui = page('manage.js', managerNetwork((url) => {
    assert.equal(url, '/api/manage/images');
    listingRequests++;
    return listingRequests === 1 ? listReply([image(1), image(2)]) : reply({ ok: false, message: 'Simulated listing failure.' }, 500);
  }));
  await ui.settle();
  await ui.fire('selectAllBtn', 'click');
  assert.equal(ui.element('deleteSelectedBtn').disabled, false);
  ui.element('mcode').value = 'ABCD-2345';
  await ui.fire('loginForm', 'submit');
  await ui.settle();
  assert.equal(listingRequests, 2);
  assert.equal(ui.element('grid').children.length, 0);
  assert.equal(ui.element('deleteSelectedBtn').disabled, true);
  await ui.fire('deleteSelectedBtn', 'click');
  await ui.fire('confirmDelete', 'click');
  assert.equal(ui.requests.filter(request => request.url === '/api/manage/delete').length, 0);
  await ui.fire('selectAllBtn', 'click');
  assert.equal(ui.element('grid').children.length, 0, 'old images cannot reappear after a failed reload');
});

test('upload captures the submitted file/code/slug, blocks duplicate submit and authenticates multipart headers', async () => {
  const validations = [];
  let uploadRequest;
  const ui = page('upload.js', (url, init) => {
    if (url === '/api/upload/validate') return new Promise(resolve => { validations.push(resolve); });
    assert.equal(url, '/api/upload');
    uploadRequest = init;
    return reply({ ok: true, url: 'https://images.fixture.test/i/first', markdown: 'markdown', html: 'html' }, 201);
  });
  const originalFile = file('original.png');
  await ui.choose(originalFile);
  ui.element('code').value = ' ABCD-2345 ';
  ui.element('slug').value = ' original-slug ';
  const pending = ui.fire('uploadForm', 'submit');
  const duplicate = ui.fire('uploadForm', 'submit');
  await ui.choose(file('replacement.png'));
  ui.element('code').value = 'EFGH-6789';
  ui.element('slug').value = 'replacement-slug';
  const disabledWhilePending = ui.element('submitBtn').disabled;
  // Release every request even on the broken implementation, so a duplicate
  // submission produces an assertion failure rather than a hanging test.
  validations.forEach(complete => complete(reply({ ok: true })));
  await Promise.all([pending, duplicate]);
  assert.equal(disabledWhilePending, true);
  assert.equal(ui.requests.filter(request => request.url === '/api/upload/validate').length, 1);
  assert.equal(JSON.parse(ui.requests.find(request => request.url === '/api/upload/validate').init.body).code, 'ABCD-2345');
  assert.ok(uploadRequest);
  assert.equal(uploadRequest.body.get('image'), originalFile);
  assert.equal(uploadRequest.body.entries.find(entry => entry.name === 'image').filename, 'original.png');
  assert.equal(uploadRequest.body.get('code'), 'ABCD-2345');
  assert.equal(uploadRequest.body.get('slug'), 'original-slug');
  assert.equal(new Headers(uploadRequest.headers).get('X-Upload-Code'), 'ABCD-2345');
  assert.equal(ui.requests.filter(request => request.url === '/api/upload').length, 1);
  assert.equal(ui.element('submitBtn').disabled, false);
});

test('rejecting a new non-image cannot accidentally upload the previous image', async () => {
  const ui = page('upload.js', () => { throw new Error('Invalid selection must not send validation or image bytes'); });
  await ui.choose(file('original.png'));
  await ui.choose(file('not-image.txt', 'text/plain'));
  ui.element('code').value = 'ABCD-2345';
  await ui.fire('uploadForm', 'submit');
  assert.equal(ui.requests.filter(request => request.url !== '/api/site-settings').length, 0);
  assert.match(ui.element('msg').textContent, /choose|image/i);
  assert.equal(ui.element('preview').style.display, 'none');
  assert.deepEqual(ui.revokedUrls, [ui.createdUrls[0].url]);
  assert.ok(!ui.element('previewImg').getAttribute('src'));
});

test('upload without a selected file sends neither validation nor multipart requests', async () => {
  const ui = page('upload.js', () => { throw new Error('An empty selection must not send image bytes'); });
  ui.element('code').value = 'ABCD-2345';
  await ui.fire('uploadForm', 'submit');
  assert.equal(ui.requests.filter(request => request.url !== '/api/site-settings').length, 0);
  assert.match(ui.element('msg').textContent, /choose.*image/i);
  assert.equal(ui.element('submitBtn').disabled, false);
});

test('clearing the file input also releases the old preview and selected image', async () => {
  const ui = page('upload.js', () => { throw new Error('A cleared selection must not send image bytes'); });
  await ui.choose(file('cleared.png'));
  await ui.choose(null);
  ui.element('code').value = 'ABCD-2345';
  await ui.fire('uploadForm', 'submit');
  assert.equal(ui.requests.filter(request => request.url !== '/api/site-settings').length, 0);
  assert.deepEqual(ui.revokedUrls, [ui.createdUrls[0].url]);
  assert.ok(!ui.element('previewImg').getAttribute('src'));
  assert.equal(ui.element('preview').style.display, 'none');
});

test('upload validation failures do not send multipart bytes and allow an explicit retry', async () => {
  let validations = 0;
  let uploads = 0;
  const ui = page('upload.js', (url) => {
    if (url === '/api/upload/validate') {
      validations++;
      return validations === 1 ? reply({ ok: false, message: 'Code has expired.' }, 401) : reply({ ok: true });
    }
    assert.equal(url, '/api/upload');
    uploads++;
    return reply({ ok: true, url: 'https://images.fixture.test/i/retry', markdown: 'markdown', html: 'html' }, 201);
  });
  await ui.choose(file('retry.png'));
  ui.element('code').value = 'ABCD-2345';
  await ui.fire('uploadForm', 'submit');
  assert.equal(uploads, 0);
  assert.match(ui.element('msg').textContent, /Code has expired/);
  assert.equal(ui.element('submitBtn').disabled, false);
  ui.element('code').value = 'EFGH-6789';
  await ui.fire('uploadForm', 'submit');
  assert.equal(validations, 2);
  assert.equal(uploads, 1);
  assert.equal(ui.element('result').classList.contains('show'), true);
});

test('replacing an image and resetting after upload release both preview blob URLs', async () => {
  const ui = page('upload.js', (url) => {
    if (url === '/api/upload/validate') return reply({ ok: true });
    assert.equal(url, '/api/upload');
    return reply({ ok: true, url: 'https://images.fixture.test/i/photo', markdown: 'markdown', html: 'html' }, 201);
  });
  await ui.choose(file('first.png'));
  await ui.choose(file('second.png'));
  assert.deepEqual(ui.revokedUrls, [ui.createdUrls[0].url]);
  ui.element('code').value = 'ABCD-2345';
  await ui.fire('uploadForm', 'submit');
  await ui.fire('againBtn', 'click');
  assert.deepEqual(ui.revokedUrls, ui.createdUrls.map(entry => entry.url));
  assert.equal(ui.element('preview').style.display, 'none');
  assert.equal(ui.element('result').classList.contains('show'), false);
});
