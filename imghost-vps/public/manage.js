/* Management page. The code is exchanged for an HttpOnly session cookie by the
   server; every subsequent action is authorised server-side. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const loginView = $('loginView');
  const managerView = $('managerView');
  const grid = $('grid');
  const modal = $('modal');
  const toast = $('toast');

  fetch('/api/site-settings', { cache: 'no-store', credentials: 'same-origin' })
    .then((res) => res.ok ? res.json() : null)
    .then((settings) => {
      if (!settings || !settings.codeGeneratorUrl) return;
      const url = new URL(settings.codeGeneratorUrl);
      if (url.protocol !== 'https:') return;
      $('codeGeneratorLink').href = url.href;
      $('codeGeneratorLink').hidden = false;
    }).catch(() => {});

  let images = [];
  let selected = new Set();
  let pendingDelete = [];
  let viewVersion = 0;
  let authenticated = false;
  let deleting = false;

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1600);
  }

  function setMsg(el, text, type) {
    el.textContent = text;
    el.className = 'msg show ' + (type || 'info');
  }

  function hideMsg(el) {
    el.className = 'msg';
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast('Copied to clipboard');
    } catch (err) {
      showToast('Copy failed - select and copy manually');
    }
  }

  function formatDate(value) {
    if (!value) return '';
    // MySQL returns "YYYY-MM-DD HH:MM:SS" in UTC.
    const d = new Date(value.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return value;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function setLoggedIn(state) {
    viewVersion += 1;
    authenticated = state;
    loginView.style.display = state ? 'none' : '';
    managerView.style.display = state ? '' : 'none';
    $('logoutLink').style.display = state ? '' : 'none';
    if (!state) {
      images = [];
      selected = new Set();
      closeModal();
      grid.innerHTML = '';
      $('countLabel').textContent = '';
      $('empty').style.display = 'none';
      $('deleteSelectedBtn').disabled = true;
      $('selectAllBtn').disabled = true;
      setDatabaseAccess({});
    }
  }

  function setDatabaseAccess(data) {
    // Keep database access independent of whether the images table can load.
    $('databaseAdminBtn').hidden = !data.databaseAdminUrl;
    $('databaseAdminHint').hidden = !data.databaseAdminUrl;
    $('databaseRecovery').hidden = !data.databaseRecovery;
  }

  async function loadImages() {
    const version = ++viewVersion;
    hideMsg($('managerMsg'));
    images = [];
    selected = new Set();
    $('deleteSelectedBtn').disabled = true;
    $('selectAllBtn').disabled = true;
    $('empty').style.display = 'none';
    $('countLabel').textContent = 'Loading…';
    grid.innerHTML = '';

    try {
      const res = await fetch('/api/manage/images', { credentials: 'same-origin' });
      if (version !== viewVersion) return false;
      if (res.status === 401) { setLoggedIn(false); return false; }
      const data = await res.json();
      if (version !== viewVersion) return false;
      if (!res.ok || !data.ok) throw new Error(data.message || 'Could not load images.');

      images = data.images;
      setDatabaseAccess(data);
      selected = new Set();
      render();
      return true;
    } catch (err) {
      if (version !== viewVersion) return false;
      setMsg($('managerMsg'), err.message, 'error');
      $('countLabel').textContent = '';
      return false;
    } finally {
      if (version === viewVersion) $('selectAllBtn').disabled = deleting || images.length === 0;
    }
  }

  function render() {
    grid.innerHTML = '';
    $('empty').style.display = images.length ? 'none' : '';
    $('countLabel').textContent =
      images.length + (images.length === 1 ? ' image' : ' images') +
      (selected.size ? ' · ' + selected.size + ' selected' : '');

    const fragment = document.createDocumentFragment();
    images.forEach((img) => {
      const el = document.createElement('div');
      el.className = 'item' + (selected.has(img.id) ? ' sel' : '');

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const im = document.createElement('img');
      im.src = img.url;
      im.alt = img.filename;
      im.loading = 'lazy';
      im.decoding = 'async';
      thumb.appendChild(im);

      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'pick';
      pick.checked = selected.has(img.id);
      pick.title = 'Select';
      pick.addEventListener('change', () => {
        if (deleting) return;
        if (pick.checked) selected.add(img.id); else selected.delete(img.id);
        el.classList.toggle('sel', pick.checked);
        $('deleteSelectedBtn').disabled = selected.size === 0;
        $('countLabel').textContent =
          images.length + (images.length === 1 ? ' image' : ' images') +
          (selected.size ? ' · ' + selected.size + ' selected' : '');
      });
      thumb.appendChild(pick);

      const body = document.createElement('div');
      body.className = 'body';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = img.filename;
      name.title = img.filename;

      const url = document.createElement('a');
      url.className = 'url';
      url.href = img.url;
      url.target = '_blank';
      url.rel = 'noopener noreferrer';
      url.textContent = img.url;
      url.title = 'Open in a new tab';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const m1 = document.createElement('span'); m1.textContent = formatDate(img.uploadedAt);
      const m2 = document.createElement('span'); m2.textContent = img.sizeLabel;
      const m3 = document.createElement('span'); m3.textContent = img.mime.replace('image/', '').toUpperCase();
      meta.append(m1, m2, m3);

      const ops = document.createElement('div');
      ops.className = 'ops';

      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => window.open(img.url, '_blank', 'noopener'));

      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy URL';
      copyBtn.addEventListener('click', () => copyText(img.url));

      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'danger';
      delBtn.addEventListener('click', () => askDelete([img.id]));

      ops.append(openBtn, copyBtn, delBtn);
      body.append(name, url, meta, ops);
      el.append(thumb, body);
      fragment.appendChild(el);
    });
    grid.appendChild(fragment);

    $('deleteSelectedBtn').disabled = deleting || selected.size === 0;
    $('selectAllBtn').disabled = deleting || images.length === 0;
  }


  /* ---------------- delete with confirmation ---------------- */
  function askDelete(ids) {
    if (deleting || !ids.length) return;
    pendingDelete = ids;
    const targetIds = new Set(ids);
    const targets = images.filter((i) => targetIds.has(i.id));
    $('modalTitle').textContent =
      ids.length === 1 ? 'Are you sure you want to delete this image?' : `Delete ${ids.length} selected images?`;
    $('modalList').innerHTML = '';
    targets.forEach((t) => {
      const row = document.createElement('div');
      row.textContent = t.filename;
      const u = document.createElement('div');
      u.className = 'u';
      u.textContent = t.url;
      row.appendChild(u);
      $('modalList').appendChild(row);
    });
    modal.classList.add('show');
  }

  function closeModal() {
    modal.classList.remove('show');
    pendingDelete = [];
  }

  $('cancelDelete').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  $('confirmDelete').addEventListener('click', async () => {
    const ids = pendingDelete.slice();
    if (deleting || !ids.length) return;
    deleting = true;
    const version = viewVersion;
    let deletedCount = 0;
    let orphanCount = 0;
    let completedBatches = 0;
    let lastMessage = '';
    $('deleteSelectedBtn').disabled = true;
    $('selectAllBtn').disabled = true;
    $('confirmDelete').disabled = true;
    $('confirmDelete').innerHTML = '<span class="spinner"></span>Deleting';

    try {
      // The API accepts at most 500 IDs per request. Keep batches sequential so
      // a failure stops further deletions and the displayed total stays honest.
      for (let offset = 0; offset < ids.length; offset += 500) {
        const res = await fetch('/api/manage/delete', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids.slice(offset, offset + 500) })
        });
        const data = await res.json().catch(() => ({}));
        if (version !== viewVersion) return;
        if (res.status === 401) { setLoggedIn(false); return; }
        if (!res.ok || !data.ok) throw new Error(data.message || 'Delete failed.');
        deletedCount += Array.isArray(data.deleted) ? data.deleted.length : 0;
        orphanCount += Array.isArray(data.orphanedFiles) ? data.orphanedFiles.length : 0;
        completedBatches += 1;
        lastMessage = data.message;
      }

      closeModal();
      if (!await loadImages()) return;
      let text = completedBatches === 1 && lastMessage ? lastMessage : `Deleted ${deletedCount} image${deletedCount === 1 ? '' : 's'}.`;
      if (orphanCount) text += ' (some files were already missing or unreadable)';
      setMsg($('managerMsg'), text, 'success');
    } catch (err) {
      if (version !== viewVersion) return;
      closeModal();
      if (completedBatches) {
        const refresh = loadImages();
        const refreshVersion = viewVersion;
        await refresh;
        if (refreshVersion !== viewVersion || !authenticated) return;
      }
      const progress = completedBatches ? `Deleted ${deletedCount} image${deletedCount === 1 ? '' : 's'} before the request stopped. ` : '';
      setMsg($('managerMsg'), progress + err.message, 'error');
    } finally {
      deleting = false;
      $('confirmDelete').disabled = false;
      $('confirmDelete').textContent = 'Delete';
      $('deleteSelectedBtn').disabled = !authenticated || selected.size === 0;
      $('selectAllBtn').disabled = !authenticated || images.length === 0;
    }
  });

  $('deleteSelectedBtn').addEventListener('click', () => askDelete([...selected]));

  $('selectAllBtn').addEventListener('click', () => {
    if (deleting) return;
    const all = selected.size === images.length && images.length > 0;
    selected = all ? new Set() : new Set(images.map((i) => i.id));
    render();
  });

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => copyText($(btn.getAttribute('data-copy')).value));
  });

  /* ---------------- login / logout ---------------- */
  $('mcode').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  });

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg($('loginMsg'));
    const btn = e.target.querySelector('button');
    if (btn.disabled) return;
    const version = ++viewVersion;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Checking';

    try {
      const res = await fetch('/api/manage/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: $('mcode').value.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (version !== viewVersion) return;
      if (!res.ok || !data.ok) throw new Error(data.message || 'Login failed.');

      $('mcode').value = '';
      setLoggedIn(true);
      setDatabaseAccess(data);
      await loadImages();
    } catch (err) {
      if (version !== viewVersion) return;
      setMsg($('loginMsg'), err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock Manager';
    }
  });

  $('logoutLink').addEventListener('click', async (e) => {
    e.preventDefault();
    setLoggedIn(false);
    await fetch('/api/manage/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  });

  // Restore an existing session on page load.
  (async function init() {
    const version = viewVersion;
    try {
      const res = await fetch('/api/manage/status', { credentials: 'same-origin' });
      const data = await res.json();
      if (version !== viewVersion) return;
      if (data && data.authenticated) {
        setLoggedIn(true);
        setDatabaseAccess(data);
        await loadImages();
      } else {
        setLoggedIn(false);
        setDatabaseAccess(data);
      }
    } catch (err) {
      if (version !== viewVersion) return;
      setLoggedIn(false);
    }
  })();
})();
