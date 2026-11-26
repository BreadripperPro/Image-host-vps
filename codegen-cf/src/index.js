import { renderPage, STYLES } from './ui.js';
import { APP_SCRIPT } from './script.js';

const MAX_REQUEST_BYTES = 1024;
const MAX_RESPONSE_BYTES = 8192;
const REQUEST_TIMEOUT_MS = 15000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const UPSTREAM_HINTS = Object.freeze({
  400: 'Check the request format and HTTPS origin routing.',
  404: 'Check that the VPS app is updated, codeGenerator.enabled is true, and the API route reaches it; restart imagehost after config changes.',
  405: 'The API did not accept POST. Check origin API routing.',
  413: 'Check the origin proxy request-size limit.',
  415: 'Check that origin routing preserves the JSON Content-Type.',
  500: 'Check the VPS application logs with journalctl -u imagehost.',
  502: 'Check Nginx and whether the imagehost service is running.',
  504: 'An upstream gateway timed out. Check the VPS app and database.',
  520: 'Cloudflare received an unexpected origin response. Check Nginx and application logs.',
  521: 'Check that Nginx is listening and the origin port rule and firewall allow the connection.',
  522: 'The origin connection timed out. Check port forwarding, firewall and the origin port rule.',
  523: 'Cloudflare could not reach the origin. Check origin DNS and networking.',
  524: 'The origin response timed out. Check the VPS app and database, then retry this request.',
  525: 'The origin TLS handshake failed. Check the Nginx HTTPS listener and certificate configuration.',
  526: 'The origin TLS certificate was rejected. Check its validity and hostname.'
});

function response(body, status = 200, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000',
    ...extraHeaders
  };
  return new Response(contentType.startsWith('application/json') ? JSON.stringify(body) : body, { status, headers });
}

function error(status, message, retryable = false, extraHeaders = {}) {
  return response({ ok: false, message, retryable }, status, undefined, extraHeaders);
}

async function readLimitedJson(body, maxBytes) {
  if (!body) throw new Error('missing_body');
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Cancellation is cleanup, not part of accepting the payload. An
        // unresponsive source must not delay the size-limit response forever.
        reader.cancel().catch(() => {});
        throw new Error('body_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function authenticated(ctx, env) {
  // ctx.access is provided by Cloudflare, not derived from an HTTP header.
  // Failing closed also protects the Worker if Access is accidentally removed.
  if (!ctx?.access || typeof ctx.access.getIdentity !== 'function') return false;
  try {
    const identity = await ctx.access.getIdentity();
    if (typeof identity?.email !== 'string' || !identity.email.trim()) return false;
    if (typeof env.ALLOWED_EMAILS !== 'undefined' && typeof env.ALLOWED_EMAILS !== 'string') return false;
    const allowed = (env.ALLOWED_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
    return !allowed.length || allowed.includes(identity.email.trim().toLowerCase());
  } catch {
    return false;
  }
}

function configuredSecret(env) {
  // Match the VPS credential policy; never accept whitespace/header characters.
  return typeof env.CODEGEN_SHARED_SECRET === 'string' && /^[a-f0-9]{64,128}$/i.test(env.CODEGEN_SHARED_SECRET);
}

function configuredOrigin(value) {
  // Origins are deployment settings, never values supplied by the browser.
  // Require canonical HTTPS origin syntax. Reject normalization tricks,
  // credentials, paths and public port overrides before any fetch.
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const labels = url.hostname.split('.');
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash || value !== url.origin ||
        url.hostname.length > 253 || labels.length < 2 ||
        labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuration(env) {
  if (!configuredSecret(env)) return null;
  const publicOrigin = configuredOrigin(env.PUBLIC_ORIGIN);
  const imagehostOrigin = configuredOrigin(env.IMAGEHOST_ORIGIN);
  if (!publicOrigin || !imagehostOrigin || publicOrigin === imagehostOrigin) return null;
  return { publicOrigin, imagehostOrigin };
}

export function createHandler(fetchOrigin = fetch) {
  return async function handle(request, env = {}, ctx = {}) {
    let url;
    try { url = new URL(request.url); } catch { return error(400, 'Invalid request.'); }
    const config = configuration(env);
    if (!config) return error(503, 'The generator has not been configured.');
    if (url.origin !== config.publicOrigin) return error(403, 'Use the configured private generator domain.');
    if (!(await authenticated(ctx, env))) return error(403, 'Cloudflare Access sign-in is required. Reload this page after signing in.');
    if (url.search) return error(400, 'Query parameters are not supported.');

    if (request.method === 'GET') {
      if (url.pathname === '/') return response(renderPage(config.imagehostOrigin), 200, 'text/html; charset=utf-8');
      if (url.pathname === '/styles.css') return response(STYLES, 200, 'text/css; charset=utf-8');
      if (url.pathname === '/app.js') return response(APP_SCRIPT, 200, 'text/javascript; charset=utf-8');
      if (url.pathname === '/api/codes') return error(405, 'Generate a code using the buttons on the generator page.', false, { Allow: 'POST' });
      return error(404, 'Not found.');
    }
    if (url.pathname !== '/api/codes') return error(404, 'Not found.');
    if (request.method !== 'POST') return error(405, 'Method not allowed.', false, { Allow: 'POST' });
    if (request.headers.get('Origin') !== config.publicOrigin) return error(403, 'Requests must come from the generator page.');
    const fetchSite = request.headers.get('Sec-Fetch-Site');
    if (fetchSite && fetchSite !== 'same-origin') return error(403, 'Cross-site requests are not allowed.');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) {
      return error(415, 'A JSON request is required.');
    }
    let input;
    try { input = await readLimitedJson(request.body, MAX_REQUEST_BYTES); }
    catch (err) { return error(err.message === 'body_too_large' ? 413 : 400, 'Invalid request body.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['type', 'requestId'].includes(key)) ||
        !['upload', 'management'].includes(input.type) || typeof input.requestId !== 'string' || !UUID_V4.test(input.requestId)) {
      return error(400, 'Choose upload or management and include a valid request identifier.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      // Deployment-configured destination and fixed method. Never proxy browser credentials, Access
      // cookies or arbitrary headers, and never follow a secret-bearing redirect.
      const upstream = await fetchOrigin(`${config.imagehostOrigin}/api/admin/codes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CODEGEN_SHARED_SECRET}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({ type: input.type, requestId: input.requestId }),
        // Workers supports manual/follow, but not the Fetch-standard error
        // mode. Inspect redirects ourselves without forwarding the secret.
        redirect: 'manual',
        signal: controller.signal,
        cache: 'no-store'
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        return error(502, `The image host redirected the API request (HTTP ${upstream.status}). Check HTTPS, Access and redirect rules for /api/admin/codes.`);
      }
      if (upstream.status === 429) {
        const seconds = Number(upstream.headers.get('Retry-After'));
        const retryAfter = Number.isInteger(seconds) && seconds > 0 && seconds <= 3600 ? seconds : 30;
        return error(429, `Please wait ${retryAfter} seconds before trying again (HTTP 429).`, true, { 'Retry-After': String(retryAfter) });
      }
      if (upstream.status === 409) return error(409, 'That request can no longer be used (HTTP 409). Generate a new code.');
      if (upstream.status === 401 || upstream.status === 403) {
        // A 403 can be the app's HTTPS-origin guard or an edge Access/WAF
        // denial, not a bad secret. Only inspect bounded, known error codes;
        // never reflect upstream messages, HTML or credentials into the UI.
        let failure;
        try { failure = await readLimitedJson(upstream.body, MAX_RESPONSE_BYTES); } catch { failure = null; }
        if (upstream.status === 403 && failure?.error === 'https_required') {
          return error(502, 'The VPS rejected an HTTP origin connection (HTTP 403). Use Cloudflare Full (strict) SSL/TLS and route to the configured Nginx HTTPS port.');
        }
        if (upstream.status === 401 && failure?.error === 'unauthorized') {
          return error(502, 'The VPS rejected the generator credential (HTTP 401). Match the Worker runtime secret to codeGenerator.sharedSecret and restart imagehost after config changes.');
        }
        return error(502, `The generator request was blocked (HTTP ${upstream.status}). Check Cloudflare Access/WAF and origin API routing.`);
      }
      if (upstream.status === 503) return error(503, 'The image host is temporarily unavailable (HTTP 503). Try this request again later.', true);
      if (upstream.status !== 200 && upstream.status !== 201) {
        const hint = UPSTREAM_HINTS[upstream.status] || 'Check the origin application logs and Cloudflare routing.';
        return error(502, `The image host did not complete the request (HTTP ${upstream.status}). ${hint}`, upstream.status >= 500);
      }

      let data;
      try { data = await readLimitedJson(upstream.body, MAX_RESPONSE_BYTES); }
      catch { return error(502, `The image host returned an invalid response (HTTP ${upstream.status}). Retry this request.`, true); }
      const expectedUrl = input.type === 'management' ? `${config.imagehostOrigin}/manage` : `${config.imagehostOrigin}/`;
      if (data?.ok !== true || data.type !== input.type || typeof data.code !== 'string' || !CODE_PATTERN.test(data.code) ||
          data.url !== expectedUrl || (input.type === 'management' && data.expiresAt === null) ||
          (data.expiresAt !== null && (typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))))) {
        return error(502, `The image host returned an invalid response (HTTP ${upstream.status}). Retry this request.`, true);
      }
      // Explicit allowlist keeps internal metadata/credentials out of the UI.
      return response({ ok: true, type: data.type, code: data.code, expiresAt: data.expiresAt, url: expectedUrl, requestId: input.requestId });
    } catch {
      return error(504, 'The image host could not be reached. Retry this request to avoid issuing a duplicate code.', true);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export default { fetch: createHandler() };
