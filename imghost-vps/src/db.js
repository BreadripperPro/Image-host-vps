'use strict';

const mysql = require('mysql2/promise');
const logger = require('./logger');

let pool = null;

const TABLE_DEFINITIONS = [
  `CREATE TABLE IF NOT EXISTS \`images\` (
    \`id\`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`public_id\`       VARCHAR(64)  NOT NULL,
    \`original_filename\` VARCHAR(255) NOT NULL,
    \`stored_filename\` VARCHAR(191) NOT NULL,
    \`custom_slug\`     VARCHAR(191) NULL DEFAULT NULL,
    \`mime_type\`       VARCHAR(100) NOT NULL,
    \`byte_size\`       BIGINT UNSIGNED NOT NULL DEFAULT 0,
    \`upload_time\`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uq_images_public_id\` (\`public_id\`),
    UNIQUE KEY \`uq_images_custom_slug\` (\`custom_slug\`),
    KEY \`idx_images_upload_time\` (\`upload_time\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS \`tokens\` (
    \`id\`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`token_hash\` CHAR(64)     NOT NULL,
    \`type\`       ENUM('upload','management') NOT NULL,
    \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`expires_at\` DATETIME     NULL DEFAULT NULL,
    \`revoked_at\` DATETIME     NULL DEFAULT NULL,
    \`consumed_at\` DATETIME    NULL DEFAULT NULL,
    \`last_used_at\` DATETIME   NULL DEFAULT NULL,
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uq_tokens_hash\` (\`token_hash\`),
    KEY \`idx_tokens_type\` (\`type\`, \`revoked_at\`),
    KEY \`idx_tokens_expires\` (\`expires_at\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS \`code_requests\` (
    \`request_id\` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    \`type\` ENUM('upload','management') NOT NULL,
    \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`request_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

/**
 * Additive, idempotent column migration. Runs after CREATE TABLE IF NOT EXISTS so
 * upgrades to older installs only ever ADD missing columns (never destructive).
 */
const EXPECTED_COLUMNS = {
  images: {
    byte_size: 'BIGINT UNSIGNED NOT NULL DEFAULT 0',
    custom_slug: 'VARCHAR(191) NULL DEFAULT NULL'
  },
  tokens: {
    consumed_at: 'DATETIME NULL DEFAULT NULL',
    last_used_at: 'DATETIME NULL DEFAULT NULL',
    expires_at: 'DATETIME NULL DEFAULT NULL',
    revoked_at: 'DATETIME NULL DEFAULT NULL'
  }
};

async function connect(dbConfig) {
  pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    waitForConnections: true,
    connectionLimit: dbConfig.connectionLimit,
    connectTimeout: dbConfig.connectTimeout,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    // Keep ordinary IDs numeric, but retain exact decimal strings for imported
    // BIGINT IDs beyond JavaScript's safe integer range instead of rounding.
    supportBigNumbers: true,
    bigNumberStrings: false,
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: 'Z'
  });

  // Pin every pooled connection to UTC so NOW(), DATE_ADD() and the
  // JS-computed datetimes all agree regardless of the container timezone.
  pool.pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });

  const connection = await pool.getConnection();
  try {
    await connection.query('SELECT 1');
  } finally {
    connection.release();
  }

  logger.info(`MySQL/MariaDB connected (${dbConfig.host}:${dbConfig.port}/${dbConfig.database}).`);
  return pool;
}

async function initializeSchema() {
  const connection = await pool.getConnection();
  try {
    for (const ddl of TABLE_DEFINITIONS) {
      await connection.query(ddl);
    }

    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const [existing] = await connection.query(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]
      );
      const present = new Set(existing.map((r) => r.COLUMN_NAME));
      for (const [name, definition] of Object.entries(columns)) {
        if (!present.has(name)) {
          await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`);
          logger.warn(`Migration: added missing column ${table}.${name}`);
        }
      }
    }
  } finally {
    connection.release();
  }
  logger.info('Database tables ready.');
}

async function query(sql, params = []) {
  if (!pool) throw new Error('Database pool is not initialised.');
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// Serialize issue/revoke operations across the HTTP service and SSH CLI. A
// connection-scoped named lock also protects the first issue into an empty DB.
async function withTokenTransaction(type, operation) {
  if (!pool) throw new Error('Database pool is not initialised.');
  const connection = await pool.getConnection();
  let locked = false;
  let reusable = true;
  const lockExpression = "SHA2(CONCAT(DATABASE(), ':imagehost-token:', ?), 256)";
  try {
    const [rows] = await connection.execute(`SELECT GET_LOCK(${lockExpression}, 5) AS acquired`, [type]);
    if (Number(rows[0]?.acquired) !== 1) {
      const err = new Error('Code issuance is busy. Please try again.');
      err.status = 503;
      throw err;
    }
    locked = true;
    try {
      await connection.beginTransaction();
    } catch (err) {
      // The server may have started the transaction before its response was
      // interrupted. Never return an uncertain transaction to another request.
      reusable = false;
      throw err;
    }
    try {
      const result = await operation(async (sql, params = []) => {
        const [resultRows] = await connection.execute(sql, params);
        return resultRows;
      });
      await connection.commit();
      return result;
    } catch (err) {
      try { await connection.rollback(); } catch { reusable = false; }
      throw err;
    }
  } finally {
    if (locked) {
      try {
        const [rows] = await connection.execute(`SELECT RELEASE_LOCK(${lockExpression}) AS released`, [type]);
        if (Number(rows[0]?.released) !== 1) reusable = false;
      } catch { reusable = false; }
    }
    if (reusable) connection.release();
    else connection.destroy();
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function isDuplicateKeyError(err) {
  return err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062);
}

function isMissingTableError(err) {
  return Boolean(err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146));
}

function getPool() {
  return pool;
}

module.exports = { connect, initializeSchema, query, withTokenTransaction, close, getPool, isDuplicateKeyError, isMissingTableError };
