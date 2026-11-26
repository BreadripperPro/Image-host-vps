'use strict';

const crypto = require('crypto');
const store = require('./store');

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const MAX_TRACKED_CLIENTS = 2000;
const REQUEST_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// The secret authenticates the Worker, independently of Cloudflare's browser
// Access policy. Never accept it from a query string, JSON body, or cookie.
function createCodegenHandler(config) {
  const settings = config.codeGenerator || {};
  const secret = settings.sharedSecret;
  const configured = settings.enabled === true && typeof secret === 'string' &&
    /^[a-f0-9]{64,128}$/i.test(secret);
  const expected = configured ? crypto.createHash('sha256').update(secret, 'utf8').digest() : null;
  const clients = new Map();
  const authenticated = Symbol('codegen-authenticated');

  function takeRequest(client, now) {
    let entry = clients.get(client);
    if (entry && now >= entry.expiresAt) {
      clients.delete(client);
      entry = null;
    }
    if (!entry) {
      // Keep anonymous/authentication-failure traffic from growing memory
      // without bounds. Do not evict live entries and reset their allowance.
      if (clients.size >= MAX_TRACKED_CLIENTS) {
        for (const [key, candidate] of clients) {
          if (now >= candidate.expiresAt) clients.delete(key);
        }
      }
      if (clients.size >= MAX_TRACKED_CLIENTS) return 60;
      entry = { count: 0, expiresAt: now + WINDOW_MS };
      clients.set(client, entry);
    }
    if (entry.count >= MAX_REQUESTS_PER_WINDOW) return Math.max(1, Math.ceil((entry.expiresAt - now) / 1000));
    entry.count++;
    return 0;
  }

  function reject(res, status, error, message, retryAfterSeconds) {
    if (retryAfterSeconds) res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(status).json({ ok: false, error, message });
  }

  function authenticate(req, res, next) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!configured) return reject(res, 404, 'not_found', 'Not found.');
    const retryAfter = takeRequest(String(req.ip || req.socket?.remoteAddress || 'unknown'), Date.now());
    if (retryAfter) return reject(res, 429, 'rate_limited', 'Too many requests. Try again later.', retryAfter);

    const authorization = req.get('Authorization');
    const match = typeof authorization === 'string' && /^Bearer ([^\s,]{1,512})$/i.exec(authorization);
    const presented = crypto.createHash('sha256').update(match ? match[1] : '', 'utf8').digest();
    const validSecret = crypto.timingSafeEqual(expected, presented);
    // Reject duplicate authorization headers even when a framework chooses the
    // first one. Do not trust any claimed Cloudflare identity at the origin.
    let authorizationCount = 0;
    if (Array.isArray(req.rawHeaders)) {
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (String(req.rawHeaders[i]).toLowerCase() === 'authorization') authorizationCount++;
      }
    }
    if (!match || !validSecret || authorizationCount > 1) {
      return reject(res, 401, 'unauthorized', 'Generator authentication required.');
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reject(res, 405, 'method_not_allowed', 'Use POST.');
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.get('Content-Type') || '')) {
      return reject(res, 415, 'unsupported_media_type', 'Use application/json.');
    }
    req[authenticated] = true;
    return next();
  }

  const handler = async function handleCodegen(req, res, next) {
    // Can be mounted as authenticate -> small JSON parser -> handler, rejecting
    // unauthenticated requests before parsing any body. Standalone callers also
    // authenticate here; the same request is never counted twice.
    if (!req[authenticated]) {
      let accepted = false;
      authenticate(req, res, () => { accepted = true; });
      if (!accepted) return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 2 || !Object.hasOwn(body, 'type') || !Object.hasOwn(body, 'requestId') ||
        !['upload', 'management'].includes(body.type) ||
        typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
      return reject(res, 400, 'invalid_request', 'Supply only a valid type and a UUID v4 requestId.');
    }

    const ttlMinutes = body.type === 'management'
      ? config.managementTokenTtlMinutes
      : (config.uploadTokenTtlHours ? config.uploadTokenTtlHours * 60 : 0);
    if (!Number.isFinite(ttlMinutes) || ttlMinutes < 0 || (body.type === 'management' && ttlMinutes <= 0)) {
      // Do not issue unexpectedly non-expiring management codes if runtime
      // configuration is malformed or a caller bypasses the config loader.
      return reject(res, 503, 'configuration_error', 'Code generation is not configured correctly.');
    }

    try {
      const details = await store.issueTokenDetails(body.type, ttlMinutes, body.requestId.toLowerCase());
      if (!details || typeof details.code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(details.code)) {
        return reject(res, 503, 'generation_failed', 'Code generation did not complete correctly.');
      }
      return res.status(201).json({
        ok: true,
        type: body.type,
        code: details.code,
        expiresAt: details.expiresAt ?? null,
        url: config.domain + (body.type === 'management' ? '/manage' : '/')
      });
    } catch (err) {
      if (err.code === 'CODEGEN_REQUEST_USED' || err.status === 409) {
        return reject(res, 409, 'request_already_used', 'This request was already processed. Generate a new code if its response was lost.');
      }
      if (err.code === 'CODEGEN_RATE_LIMITED' || err.status === 429) {
        const seconds = Math.min(3600, Math.max(1, Math.ceil(Number(err.retryAfterSeconds) || 5)));
        return reject(res, 429, 'rate_limited', 'Code generation is temporarily limited. Try again later.', seconds);
      }
      if (err.status === 503) {
        return reject(res, 503, 'temporarily_unavailable', 'Code generation is temporarily unavailable. Try again later.');
      }
      return next(err);
    }
  };
  handler.authenticate = authenticate;
  return handler;
}

module.exports = { createCodegenHandler };
