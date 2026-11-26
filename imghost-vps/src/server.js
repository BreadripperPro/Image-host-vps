'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');
const multer = require('multer');

const db = require('./db');
const store = require('./store');
const session = require('./session');
const logger = require('./logger');
const { createCodegenHandler } = require('./codegen');
const { generatePublicId, generateHexId } = require('./security');
const { sniffImage, extensionForMime, sanitizeOriginalFilename, formatBytes } = require('./images');

// Slugs are deliberately restrictive: letters, digits, hyphen and underscore only.
// This makes path traversal, slash injection and extension tricks impossible.
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_SLUGS = new Set(['api', 'manage', 'i', 'uploads', 'public', 'admin', 'favicon.ico']);

// Second line of defence: a stored filename must look exactly like one we generate.
const STORED_NAME_PATTERN = /^[a-f0-9]{8,64}\.[a-z0-9]{2,5}$/;
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_IMAGE_ID = 18446744073709551615n;

function normalizeImageId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,64}$/.test(value.trim())) return null;
  const id = BigInt(value.trim());
  if (id < 1n || id > MAX_IMAGE_ID) return null;
  return id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : String(id);
}

function imageSnippets(filename, url) {
  const escapeAttribute = (value) => String(value).replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const markdownName = String(filename).replace(/([\\[\]])/g, '\\$1');
  return { markdown: `![${markdownName}](${url})`, html: `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(filename)}">` };
}

function createApp(config, secret) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSizeBytes, files: 1, fields: 10, fieldSize: 8192, parts: 12 }
  });
  let activeUploads = 0;

  function receiveUpload(req, res, next) {
    if (req.aborted || res.destroyed) return;
    // Body-only clients remain supported, but anonymous multipart requests
    // cannot create an unbounded number of in-memory image buffers.
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
      res.setHeader('Retry-After', '1');
      return res.status(503).json({ ok: false, error: 'upload_busy', message: 'Uploads are busy. Wait a moment and retry with the same code.' });
    }
    activeUploads++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (req.file) delete req.file.buffer;
      activeUploads--;
    };
    // Keep the slot until parsing and processing actually settle. Closing the
    // connection alone does not free a parsed buffer held by a pending query.
    upload.single('image')(req, res, (err) => {
      if (err) {
        release();
        if (req.aborted || res.destroyed) return;
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            ok: false,
            error: 'too_large',
            message: `File is larger than the ${Math.round(config.maxFileSizeBytes / (1024 * 1024))} MB limit.`
          });
        }
        return next(err);
      }
      if (req.aborted || res.destroyed) { release(); return; }
      handleUpload(req, res).then(release, (failure) => {
        release();
        if (!req.aborted && !res.destroyed) next(failure);
      });
    });
  }

  const isHttps = config.domain.startsWith('https://');
  const uploadsRoot = path.resolve(config.uploadsDir);

  const publicUrl = (identifier) => `${config.domain}/i/${identifier}`;
  const codegenHandler = createCodegenHandler(config);

  /* ================================================================== *
   * GET /i/:id - serve the raw image bytes.
   * Works in <img>, Markdown, HTML, Discord, forums, etc.
   * ================================================================== */
  async function serveImage(req, res, next) {
    const raw = String(req.params.id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
      return res.status(404).type('text/plain').send('Not found');
    }

    const record = (await store.findImageBySlug(raw)) || (await store.findImageByPublicId(raw));
    if (!record) return res.status(404).type('text/plain').send('Not found');

    const stored = path.basename(String(record.stored_filename));
    if (!STORED_NAME_PATTERN.test(stored)) {
      logger.error(`Refusing to serve unexpected stored_filename: ${record.stored_filename}`);
      return res.status(500).type('text/plain').send('Server error');
    }

    const absolute = path.resolve(path.join(uploadsRoot, stored));
    if (absolute.indexOf(uploadsRoot) !== 0) {
      return res.status(400).type('text/plain').send('Bad request');
    }

    res.setHeader('Content-Type', record.mime_type);
    res.setHeader('Content-Length', String(record.byte_size));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    const originalName = sanitizeOriginalFilename(record.original_filename);
    const asciiName = originalName.replace(/[^\x20-\x7e]/g, '_');
    const encodedName = encodeURIComponent(originalName).replace(/['()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Disposition', `inline; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (record.mime_type === 'image/svg+xml') {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }

    res.sendFile(absolute, (err) => {
      if (!err) return;
      if (res.headersSent) return next(err);
      // Never retain the successful image's immutable cache policy on an
      // error response: a restored file must be reachable at this same URL.
      res.setHeader('Cache-Control', 'no-store');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      if (err.code === 'ENOENT') {
        // During restores/imports files may arrive after their records. A GET
        // must not permanently erase metadata because a file is not here yet.
        logger.warn(`File missing for image #${record.id} (${stored}); record retained.`);
        return res.status(404).type('text/plain').send('Not found');
      }
      return next(err);
    });
  }

  /* ================================================================== *
   * POST /api/upload - requires a valid, non-revoked UPLOAD code.
   * The check is server-side; the browser's code is never trusted.
   * ================================================================== */
  async function handleUpload(req, res) {
    const suppliedCode = (req.body && req.body.code) || req.get('X-Upload-Code') || '';
    const valid = await store.isTokenValid('upload', suppliedCode);
    if (req.aborted || res.destroyed) return;
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'invalid_code', message: 'Invalid, used, expired or revoked upload code.' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ ok: false, error: 'no_file', message: 'No image file was received.' });
    }

    // Trust the bytes, not the extension or the browser's Content-Type.
    const sniffed = sniffImage(file.buffer, { allowSvg: config.allowSvg });
    if (!sniffed) {
      return res.status(415).json({
        ok: false,
        error: 'unsupported_type',
        message: config.allowSvg
          ? 'Unsupported file type. Use JPG, PNG, GIF, WebP, BMP, AVIF or SVG.'
          : 'Unsupported file type. Use JPG, PNG, GIF, WebP, BMP or AVIF.'
      });
    }

    const rawSlug = String((req.body && req.body.slug) || '').trim();
    let customSlug = null;
    if (rawSlug) {
      if (!SLUG_PATTERN.test(rawSlug) || RESERVED_SLUGS.has(rawSlug.toLowerCase())) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_slug',
          message:
            'Custom link may only use letters, numbers, hyphens and underscores (max 64 characters) and cannot be a reserved word.'
        });
      }
      if (await store.slugExists(rawSlug)) {
        return res.status(409).json({ ok: false, error: 'slug_taken', message: 'That custom link is already in use.' });
      }
      customSlug = rawSlug;
    }

    // Random internal filename (32 hex chars) - never derived from user input.
    const storedFilename = `${generateHexId(16)}.${extensionForMime(sniffed.mime)}`;

    let publicId = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generatePublicId(config.publicIdLength);
      if (!(await store.publicIdExists(candidate))) {
        publicId = candidate;
        break;
      }
    }
    if (!publicId) {
      return res.status(503).json({ ok: false, error: 'id_exhausted', message: 'Could not allocate a unique id, please retry.' });
    }

    // Consume at the last possible point. This preserves the code after a
    // malformed request while ensuring concurrent valid uploads cannot both
    // write a file with the same one-time code.
    if (req.aborted || res.destroyed) return;
    const token = await store.consumeToken('upload', suppliedCode);
    if (!token) {
      return res.status(401).json({ ok: false, error: 'invalid_code', message: 'Invalid, used, expired or revoked upload code.' });
    }

    const absolute = path.join(uploadsRoot, storedFilename);
    await fsp.writeFile(absolute, file.buffer);

    let imageId;
    try {
      imageId = await store.insertImage({
        publicId,
        originalFilename: sanitizeOriginalFilename(file.originalname),
        storedFilename,
        customSlug,
        mimeType: sniffed.mime,
        byteSize: file.buffer.length
      });
    } catch (err) {
      await fsp.unlink(absolute).catch(() => {});
      if (db.isDuplicateKeyError(err)) {
        return res.status(409).json({ ok: false, error: 'slug_taken', message: 'That custom link is already in use.' });
      }
      throw err;
    }

    const url = publicUrl(customSlug || publicId);
    const name = sanitizeOriginalFilename(file.originalname);
    logger.info(`Upload #${imageId}: ${name} (${sniffed.mime}, ${formatBytes(file.buffer.length)}) -> ${url}`);

    return res.status(201).json({
      ok: true,
      id: imageId,
      url,
      ...imageSnippets(name, url),
      filename: name,
      mime: sniffed.mime,
      size: file.buffer.length,
      sizeLabel: formatBytes(file.buffer.length)
    });
  }

  // This check intentionally does not consume the code. The upload endpoint
  // consumes it atomically after the browser has passed this gate and sends
  // the multipart image request.
  async function handleUploadCodeValidation(req, res) {
    const valid = await store.isTokenValid('upload', (req.body && req.body.code) || '');
    if (!valid) {
      return res.status(401).json({
        ok: false,
        error: 'invalid_code',
        message: 'Invalid, used, expired or revoked upload code.'
      });
    }
    return res.json({ ok: true });
  }


  /* ================================================================== *
   * Management authentication.
   * An upload code can never delete, and a management code can never
   * upload: the two token types are stored and verified separately, and
   * the session is bound to the management token's row id so that
   * revoking (or expiring) it kills active sessions immediately.
   * ================================================================== */
  async function resolveManagementSession(req) {
    const raw = session.readCookie(req);
    if (!raw) return null;
    const payload = session.verify(raw, secret);
    if (!payload || !payload.tid) return null;

    const rows = await db.query(
      `SELECT \`id\` FROM \`tokens\`
        WHERE \`id\` = ? AND \`type\` = 'management' AND \`revoked_at\` IS NULL
          AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)
        LIMIT 1`,
      [payload.tid, store.utcNow()]
    );
    return rows.length ? payload : null;
  }

  async function resolveDatabaseAccess(req) {
    try {
      // Probe even without a cookie: a dropped tokens table makes management
      // login impossible. During recovery phpMyAdmin's own DB login protects
      // access. Do not recreate tables here or interfere with an SQL import.
      await db.query('SELECT 1 FROM `tokens` LIMIT 0');
      return { payload: await resolveManagementSession(req), recovery: false };
    } catch (err) {
      // This probe/session lookup touches only tokens. Connection failures,
      // permissions and other SQL errors must never enable recovery access.
      if (!db.isMissingTableError(err)) throw err;
      return { payload: null, recovery: true };
    }
  }

  async function requireDatabaseAccess(req, res, next) {
    if (!config.phpMyAdminEnabled) return res.sendStatus(403);
    try {
      const access = await resolveDatabaseAccess(req);
      if (!access.payload && !access.recovery) return res.sendStatus(401);
      return next();
    } catch (err) {
      // Nginx auth_request accepts only 2xx/401/403. Fail closed instead of
      // turning a database outage into an Nginx 500 or granting access.
      logger.error('Database administration access check failed:', err.message);
      return res.sendStatus(403);
    }
  }

  async function requireManagementSession(req, res, next) {
    try {
      const payload = await resolveManagementSession(req);
      if (!payload) {
        return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Management code required.' });
      }
      req.managementSession = payload;
      return next();
    } catch (err) {
      return next(err);
    }
  }

  async function handleManageLogin(req, res) {
    const token = await store.consumeToken('management', (req.body && req.body.code) || '');
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'invalid_code',
        message: 'Invalid, used, expired or revoked management code.'
      });
    }
    // A management session lasts only for the code's remaining lifetime. The
    // database expiry check in resolveManagementSession remains authoritative.
    const expiry = token.expires_at
      ? new Date(token.expires_at.replace(' ', 'T') + 'Z').getTime()
      : null;
    const remainingSeconds = expiry
      ? Math.max(1, Math.ceil((expiry - Date.now()) / 1000))
      : session.SESSION_TTL_MINUTES * 60;
    const value = session.create(secret, { tokenId: token.id, ttlSeconds: remainingSeconds });
    session.setCookie(res, value, { secure: isHttps, maxAgeSeconds: remainingSeconds });
    return res.json({ ok: true, databaseAdminUrl: config.phpMyAdminEnabled ? '/api/manage/database' : null });
  }

  function handleManageLogout(req, res) {
    session.clearCookie(res);
    return res.json({ ok: true });
  }

  async function handleManageStatus(req, res) {
    const { payload, recovery } = await resolveDatabaseAccess(req);
    return res.json({
      ok: true,
      authenticated: Boolean(payload),
      expiresAt: payload ? new Date(payload.exp).toISOString() : null,
      databaseRecovery: config.phpMyAdminEnabled && recovery,
      databaseAdminUrl: config.phpMyAdminEnabled && (payload || recovery) ? '/api/manage/database' : null
    });
  }

  /* ================================================================== *
   * Management listing / deletion
   * ================================================================== */
  function serializeImage(row) {
    const identifier = row.custom_slug || row.public_id;
    const url = publicUrl(identifier);
    return {
      id: row.id,
      identifier,
      filename: row.original_filename,
      mime: row.mime_type,
      size: Number(row.byte_size),
      sizeLabel: formatBytes(row.byte_size),
      uploadedAt: row.upload_time,
      url,
      ...imageSnippets(row.original_filename, url)
    };
  }

  async function handleListImages(req, res) {
    const rows = await store.listImages();
    return res.json({ ok: true, images: rows.map(serializeImage), databaseAdminUrl: config.phpMyAdminEnabled ? '/api/manage/database' : null });
  }


  async function handleDeleteImages(req, res) {
    const body = req.body || {};
    const rawIds = Array.isArray(body.ids) ? body.ids : [body.id];
    const ids = [...new Set(rawIds.map(normalizeImageId).filter((id) => id !== null))].slice(0, 500);
    if (!ids.length) {
      return res.status(400).json({ ok: false, error: 'no_ids', message: 'No valid image ids supplied.' });
    }

    const rows = await store.getImagesByIds(ids);
    const deleted = [];
    const missingFiles = [];

    // Step 1: remove the physical files. A file that is already gone is fine.
    for (const row of rows) {
      const stored = path.basename(String(row.stored_filename));
      if (STORED_NAME_PATTERN.test(stored)) {
        try {
          await fsp.unlink(path.join(uploadsRoot, stored));
        } catch (err) {
          if (err.code !== 'ENOENT') logger.warn(`Could not delete ${stored}: ${err.message}`);
          missingFiles.push(stored);
        }
      } else {
        missingFiles.push(stored);
      }
      deleted.push(row.id);
    }

    // Step 2: remove the DB rows -> the public URL stops resolving immediately.
    const removedRows = await store.deleteImageRecords(ids);

    logger.info(`Deleted ${deleted.length} image(s); ${removedRows} database row(s) removed.`);
    const deletedKeys = new Set(deleted.map(String));
    return res.json({
      ok: true,
      deleted,
      notFound: ids.filter((id) => !deletedKeys.has(String(id))),
      orphanedFiles: missingFiles,
      message: `Deleted ${deleted.length} image${deleted.length === 1 ? '' : 's'}.`
    });
  }

  /* ================================================================== *
   * Wiring
   * ================================================================== */
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Belt and braces: never serve secrets, even if a file ever lands in public/.
  app.use(['/config.json', '/config.example.json', '/.session-secret', '/package.json', '/src'], (req, res) =>
    res.status(404).type('text/plain').send('Not found')
  );

  // ---- API ----
  app.all('/api/admin/codes', (req, res, next) => {
    res.locals.privateCodegenRequest = true;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.sendStatus(405);
    }
    // With the supplied Nginx config this reflects the actual origin protocol,
    // not the visitor's Cloudflare edge connection. Reject Flexible/HTTP origin
    // routing so privileged codes are never returned over cleartext upstreams.
    if (!req.secure) return res.status(403).json({ ok: false, error: 'https_required', message: 'Code generation requires HTTPS to the VPS origin.' });
    return next();
  }, codegenHandler.authenticate, express.json({ limit: '2kb', strict: true }), codegenHandler);
  app.get('/api/site-settings', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ codeGeneratorUrl: config.codeGenerator?.enabled === true ? config.codeGenerator.url : null });
  });
  app.use('/api/manage', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Validate the code in a small request before the client begins uploading
  // multipart image data. /api/upload repeats the check and consumes the code.
  app.post('/api/upload/validate', express.json({ limit: '2kb' }), (req, res, next) =>
    handleUploadCodeValidation(req, res).catch(next)
  );

  app.post(
    '/api/upload',
    (req, res, next) => {
      // The current UI sends this header so stale/invalid codes are rejected
      // before buffering image bytes. Legacy multipart code fields still work.
      const code = req.get('X-Upload-Code');
      if (code === undefined) return next();
      store.isTokenValid('upload', code).then((valid) => {
        if (req.aborted || res.destroyed) return;
        if (!valid) return res.status(401).json({ ok: false, error: 'invalid_code', message: 'Invalid, used, expired or revoked upload code.' });
        return next();
      }).catch(next);
    },
    receiveUpload
  );

  app.post('/api/manage/login', express.json({ limit: '10kb' }), (req, res, next) =>
    handleManageLogin(req, res).catch(next)
  );
  app.post('/api/manage/logout', (req, res) => handleManageLogout(req, res));
  app.get('/api/manage/status', (req, res, next) => handleManageStatus(req, res).catch(next));
  // Nginx checks this on EVERY phpMyAdmin request, including PHP and assets.
  // Return a real 401 rather than the status endpoint's 200/authenticated:false.
  app.get('/api/manage/database-auth', requireDatabaseAccess, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.sendStatus(204);
  });
  app.get('/api/manage/database', (req, res, next) => {
    if (!config.phpMyAdminEnabled) return res.sendStatus(404);
    return requireDatabaseAccess(req, res, next);
  }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!config.phpMyAdminEnabled) return res.sendStatus(404);
    return res.redirect(302, '/phpmyadmin/');
  });
  app.get('/api/manage/images', requireManagementSession, (req, res, next) =>
    handleListImages(req, res).catch(next)
  );
  app.post(
    '/api/manage/delete',
    requireManagementSession,
    express.json({ limit: '32kb' }),
    (req, res, next) => handleDeleteImages(req, res).catch(next)
  );

  // ---- Direct image delivery ----
  app.get('/i/:id', (req, res, next) => serveImage(req, res, next).catch(next));
  app.head('/i/:id', (req, res, next) => serveImage(req, res, next).catch(next));

  // ---- Static frontend (public/ only) ----
  app.use(express.static(config.publicDir, { index: 'index.html', maxAge: '1h', etag: true }));
  app.get('/manage', (req, res) => res.sendFile(path.join(config.publicDir, 'manage.html')));

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Parser errors may embed fragments of submitted JSON. Never log request
    // body fragments or authorization data from this administrative endpoint.
    if (res.locals.privateCodegenRequest) {
      if (res.headersSent) return next(err);
      const status = db.isMissingTableError(err) || err.status === 503 ? 503
        : err.type === 'entity.too.large' ? 413
        : err.type === 'entity.parse.failed' ? 400 : 500;
      return res.status(status).json({ ok: false, error: status === 503 ? 'database_unavailable' : 'request_failed', message: status === 503 ? 'Code generation is unavailable. Check the server database and try again.' : status < 500 ? 'Invalid code generation request.' : 'Code generation failed.' });
    }
    if (res.headersSent) return next(err);
    // Bad client payloads are not internal failures, and parser messages may
    // contain fragments of a submitted management/upload code.
    if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid_json', message: 'Invalid JSON request body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'too_large', message: 'Request body is too large.' });
    if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') return res.status(415).json({ ok: false, error: 'unsupported_encoding', message: 'Unsupported request encoding.' });
    if (err instanceof multer.MulterError) return res.status(400).json({ ok: false, error: 'invalid_upload', message: 'Invalid multipart upload fields.' });
    logger.error('Unhandled request error:', err.message);
    if (db.isMissingTableError(err)) {
      return res.status(503).json({ ok: false, error: 'database_tables_missing', message: 'Application tables are missing. Restore them using phpMyAdmin, then refresh this page.' });
    }
    res.status(500).json({ ok: false, error: 'server_error', message: 'Something went wrong on the server.' });
  });

  return app;
}

module.exports = { createApp };
