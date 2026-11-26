// Served as /app.js so CSP does not need unsafe-inline or external scripts.
export const APP_SCRIPT = String.raw`(() => {
  'use strict';
  const types = ['upload', 'management'];
  const state = { upload: {}, management: {} };
  const $ = id => document.getElementById(id);
  let busy = false;
  let activeRequest = null;

  function status(type, message, tone = '') {
    $(type + 'Status').textContent = message;
    $(type + 'Status').className = 'status ' + tone;
  }

  function clearResult(type) {
    delete state[type].result;
    $(type + 'Code').value = '';
    $(type + 'Result').hidden = true;
    $(type + 'Copy').disabled = true;
  }

  function resetButtons() {
    types.forEach(type => {
      $(type + 'Generate').disabled = false;
      $(type + 'Generate').textContent = state[type].requestId ? 'Retry request' : (state[type].result ? 'Generate new code' : 'Generate ' + (type === 'upload' ? 'upload' : 'management') + ' code');
    });
  }

  function updateExpiry(type) {
    const result = state[type].result;
    if (!result) return;
    if (result.expiresAt === null) {
      $(type + 'Expiry').textContent = 'No time expiry. Valid for one upload until replaced or revoked.';
      return;
    }
    const seconds = Math.max(0, Math.ceil((Date.parse(result.expiresAt) - Date.now()) / 1000));
    if (seconds === 0) {
      clearResult(type);
      status(type, 'This code has expired. Generate a new code.', 'error');
      return;
    }
    const minutes = Math.floor(seconds / 60);
    const remainder = String(seconds % 60).padStart(2, '0');
    $(type + 'Expiry').textContent = 'Expires in ' + minutes + ':' + remainder + ' · ' + new Date(result.expiresAt).toLocaleString();
  }

  async function generate(type) {
    if (busy) return;
    busy = true;
    const button = $(type + 'Generate');
    types.forEach(item => { $(item + 'Generate').disabled = true; });
    clearResult(type);
    status(type, 'Generating code…');
    button.textContent = 'Generating…';
    // A manual retry reuses this identifier; the origin refuses to issue twice.
    // A definitive response clears it so the next click starts a new request.
    state[type].requestId ||= crypto.randomUUID();
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch('/api/codes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, requestId: state[type].requestId }),
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal
      });
      const data = await res.json().catch(() => null);
      // A navigation can abort after the server has already issued a code.
      // Ignore that late result, including after a bfcache restore/new request.
      if (activeRequest !== controller) return;
      if (!res.ok || !data || data.ok !== true) {
        if (data && data.retryable === false) delete state[type].requestId;
        status(type, data?.message || 'Unable to complete the request. Reload if your Access session expired.', 'error');
        return;
      }
      delete state[type].requestId;
      state[type].result = data;
      $(type + 'Code').value = data.code;
      $(type + 'Result').hidden = false;
      $(type + 'Copy').disabled = false;
      status(type, 'Code generated. Copy it and open the ' + (type === 'upload' ? 'upload page.' : 'manager.'), 'success');
      updateExpiry(type);
    } catch {
      if (activeRequest === controller) status(type, 'The request was interrupted. Retry this request; if it already issued a code, you will be asked to generate a new one.', 'error');
    } finally {
      clearTimeout(timeout);
      if (activeRequest === controller) {
        activeRequest = null;
        busy = false;
        resetButtons();
      }
    }
  }

  async function copy(type) {
    updateExpiry(type);
    if (!state[type].result) return;
    try {
      await navigator.clipboard.writeText(state[type].result.code);
      status(type, 'Code copied.', 'success');
    } catch {
      $(type + 'Code').focus();
      $(type + 'Code').select();
      status(type, 'Select the code and copy it manually.');
    }
  }

  types.forEach(type => {
    $(type + 'Generate').addEventListener('click', () => generate(type));
    $(type + 'Copy').addEventListener('click', () => copy(type));
  });
  setInterval(() => types.forEach(updateExpiry), 1000);
  window.addEventListener('pagehide', () => {
    const pending = activeRequest;
    activeRequest = null;
    if (pending) pending.abort();
    busy = false;
    // Keep request IDs for an explicit retry: an aborted request may already
    // have issued a code, so returning to the page must not issue a second one.
    types.forEach(type => { clearResult(type); status(type, ''); });
    resetButtons();
  });
})();`;
