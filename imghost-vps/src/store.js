'use strict';

const db = require('./db');
const { sha256 } = require('./security');
const MAX_TOKEN_EXPIRY_MS = Date.parse('9999-12-31T23:59:59Z');

/**
 * Current UTC time as a MySQL DATETIME string.
 *
 * Expiry is always compared against this JS-generated UTC value rather than
 * MySQL's NOW(), so token expiry stays correct regardless of the session
 * time_zone or the container's local timezone.
 */
function utcNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/* ---------------------------------------------------------------------------
 * Tokens
 * ------------------------------------------------------------------------ */

// Issuing a new token always revokes every previous token of the same type,
// so "code" replaces the old upload code and "manage" replaces the old
// management code. Only the SHA-256 hash is ever persisted.
async function issueToken(type, ttlMinutes) {
  return (await issueTokenDetails(type, ttlMinutes)).code;
}

function tokenExpiryTime(ttlMinutes) {
  if (ttlMinutes === null || ttlMinutes === undefined) return null;
  const minutes = (typeof ttlMinutes === 'number' || (typeof ttlMinutes === 'string' && ttlMinutes.trim()))
    ? Number(ttlMinutes) : NaN;
  const expiry = minutes > 0 ? Date.now() + Math.round(minutes) * 60000 : null;
  if (!Number.isFinite(minutes) || (expiry !== null && (!Number.isFinite(expiry) || expiry > MAX_TOKEN_EXPIRY_MS))) {
    const error = new Error('Token expiry configuration must be finite and end no later than 9999-12-31 23:59:59 UTC.');
    error.status = 503;
    throw error;
  }
  return expiry;
}

// A request ID is reserved in the same transaction as issuance. Retrying a
// remote request returns 409 instead of silently replacing the displayed code.
// Only request IDs/hashes are stored, never the plaintext code.
async function issueTokenDetails(type, ttlMinutes, requestId = null) {
  if (!['upload', 'management'].includes(type)) throw new Error('Invalid token type.');
  if (requestId !== null && (typeof requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId))) {
    throw new Error('Invalid code request ID.');
  }
  // Reject bad runtime settings before acquiring a connection or reserving an ID.
  tokenExpiryTime(ttlMinutes);
  const { generateCode } = require('./security');
  return db.withTokenTransaction(type, async (query) => {
    if (requestId) {
      try {
        await query('INSERT INTO `code_requests` (`request_id`, `type`) VALUES (?, ?)', [requestId.toLowerCase(), type]);
      } catch (err) {
        if (!db.isDuplicateKeyError(err)) throw err;
        const duplicate = new Error('This code request was already processed. Generate a new code if the response was lost.');
        duplicate.status = 409;
        throw duplicate;
      }
      const recent = await query('SELECT `created_at` FROM `tokens` WHERE `type` = ? ORDER BY `id` DESC LIMIT 1', [type]);
      if (recent[0]) {
        const elapsed = Date.now() - new Date(recent[0].created_at.replace(' ', 'T') + 'Z').getTime();
        // Legacy imports can contain timestamps shifted into the future by an
        // old timezone setting. They must not turn a 3-second cooldown into
        // an hours-long lockout; genuinely recent UTC issues are still gated.
        if (elapsed >= 0 && elapsed < 3000) {
          const limited = new Error('Wait a few seconds before generating another code.');
          limited.status = 429;
          limited.retryAfterSeconds = Math.max(1, Math.ceil((3000 - elapsed) / 1000));
          throw limited;
        }
      }
    }
    const plain = generateCode();
    // Start the lifetime when issuance actually runs, after any lock wait.
    const expiry = tokenExpiryTime(ttlMinutes);
    const expiresAt = expiry !== null
      ? new Date(expiry).toISOString().slice(0, 19).replace('T', ' ')
      : null;
    await query('UPDATE `tokens` SET `revoked_at` = NOW() WHERE `type` = ? AND `revoked_at` IS NULL', [type]);
    if (expiresAt) {
      await query('INSERT INTO `tokens` (`token_hash`, `type`, `expires_at`) VALUES (?, ?, ?)', [sha256(plain), type, expiresAt]);
    } else {
      await query('INSERT INTO `tokens` (`token_hash`, `type`) VALUES (?, ?)', [sha256(plain), type]);
    }
    return { code: plain, expiresAt: expiresAt ? expiresAt.replace(' ', 'T') + 'Z' : null };
  });
}

async function revokeToken(type) {
  const result = await db.withTokenTransaction(type, (query) => query(
    'UPDATE `tokens` SET `revoked_at` = NOW() WHERE `type` = ? AND `revoked_at` IS NULL',
    [type]
  ));
  return result.affectedRows || 0;
}

/**
 * Atomically validate and consume a plaintext code. The conditional update
 * prevents two simultaneous requests from spending the same code.
 * @returns {Promise<object|null>} the token row, or null when invalid or used.
 */
async function consumeToken(type, plainCode) {
  const { normalizeCode } = require('./security');
  const normalized = normalizeCode(plainCode);
  if (!normalized) return null;
  const tokenHash = sha256(normalized);

  const rows = await db.query(
    `SELECT \`id\`, \`token_hash\`, \`type\`, \`created_at\`, \`expires_at\`
       FROM \`tokens\`
      WHERE \`token_hash\` = ? AND \`type\` = ? AND \`revoked_at\` IS NULL
        AND \`consumed_at\` IS NULL
        AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)
      LIMIT 1`,
    [tokenHash, type, utcNow()]
  );

  if (rows.length === 0) return null;

  const result = await db.query(
    `UPDATE \`tokens\`
        SET \`consumed_at\` = NOW(), \`last_used_at\` = NOW()
      WHERE \`id\` = ? AND \`token_hash\` = ? AND \`type\` = ?
        AND \`revoked_at\` IS NULL AND \`consumed_at\` IS NULL
        AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)`,
    [rows[0].id, tokenHash, type, utcNow()]
  );
  if (!result.affectedRows) return null;

  return rows[0];
}

/**
 * Check whether a plaintext code can still be used without consuming it.
 * This supports validating an upload code before the browser sends the image
 * bytes; consumeToken() remains the authoritative, atomic check on upload.
 */
async function isTokenValid(type, plainCode) {
  const { normalizeCode } = require('./security');
  const normalized = normalizeCode(plainCode);
  if (!normalized) return false;

  const rows = await db.query(
    `SELECT \`id\`
       FROM \`tokens\`
      WHERE \`token_hash\` = ? AND \`type\` = ? AND \`revoked_at\` IS NULL
        AND \`consumed_at\` IS NULL
        AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)
      LIMIT 1`,
    [sha256(normalized), type, utcNow()]
  );
  return rows.length > 0;
}

async function getActiveToken(type) {
  const rows = await db.query(
    `SELECT \`id\`, \`created_at\`, \`expires_at\`
       FROM \`tokens\`
      WHERE \`type\` = ? AND \`revoked_at\` IS NULL
        AND \`consumed_at\` IS NULL
        AND (\`expires_at\` IS NULL OR \`expires_at\` > ?)
      ORDER BY \`id\` DESC LIMIT 1`,
    [type, utcNow()]
  );
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
 * Images
 * ------------------------------------------------------------------------ */

async function slugExists(slug) {
  // Slugs and generated IDs share one public URL namespace. Protect imported
  // random-ID links from being shadowed by a newly chosen custom slug.
  const rows = await db.query('SELECT `id` FROM `images` WHERE `custom_slug` = ? OR `public_id` = ? LIMIT 1', [slug, slug]);
  return rows.length > 0;
}

async function publicIdExists(publicId) {
  const rows = await db.query('SELECT `id` FROM `images` WHERE `public_id` = ? OR `custom_slug` = ? LIMIT 1', [publicId, publicId]);
  return rows.length > 0;
}

async function insertImage({ publicId, originalFilename, storedFilename, customSlug, mimeType, byteSize }) {
  const result = await db.query(
    `INSERT INTO \`images\`
       (\`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`, \`mime_type\`, \`byte_size\`)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [publicId, originalFilename, storedFilename, customSlug || null, mimeType, byteSize]
  );
  return result.insertId;
}

async function findImageByPublicId(publicId) {
  const rows = await db.query(
    `SELECT \`id\`, \`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`,
            \`mime_type\`, \`byte_size\`, \`upload_time\`
       FROM \`images\`
      WHERE \`public_id\` = ?
      LIMIT 1`,
    [publicId]
  );
  return rows[0] || null;
}

async function findImageBySlug(slug) {
  const rows = await db.query(
    `SELECT \`id\`, \`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`,
            \`mime_type\`, \`byte_size\`, \`upload_time\`
       FROM \`images\`
      WHERE \`custom_slug\` = ?
      LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

async function listImages() {
  return db.query(
    `SELECT \`id\`, \`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`,
            \`mime_type\`, \`byte_size\`, DATE_FORMAT(\`upload_time\`, '%Y-%m-%d %H:%i:%s') AS \`upload_time\`
       FROM \`images\`
      ORDER BY \`upload_time\` DESC, \`id\` DESC`
  );
}

async function getImagesByIds(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.query(
    `SELECT \`id\`, \`public_id\`, \`original_filename\`, \`stored_filename\`, \`custom_slug\`,
            \`mime_type\`, \`byte_size\`
       FROM \`images\`
      WHERE \`id\` IN (${placeholders})`,
    ids
  );
}

async function deleteImageRecords(ids) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const result = await db.query(`DELETE FROM \`images\` WHERE \`id\` IN (${placeholders})`, ids);
  return result.affectedRows || 0;
}

async function getStats() {
  const rows = await db.query(
    `SELECT COUNT(*) AS \`image_count\`, COALESCE(SUM(\`byte_size\`), 0) AS \`total_bytes\`
       FROM \`images\``
  );
  return rows[0] || { image_count: 0, total_bytes: 0 };
}

module.exports = {
  utcNow,
  issueToken,
  issueTokenDetails,
  revokeToken,
  consumeToken,
  isTokenValid,
  getActiveToken,
  slugExists,
  publicIdExists,
  insertImage,
  findImageByPublicId,
  findImageBySlug,
  listImages,
  getImagesByIds,
  deleteImageRecords,
  getStats
};
