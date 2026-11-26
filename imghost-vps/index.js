'use strict';

/**
 * Personal image host for a VPS.
 *
 * Start with:  node index.js
 *
 * Configuration, including the listen address and port, comes from config.json.
 */

const configLoader = require('./src/config');
const logger = require('./src/logger');

function printFatal(title, message, extra) {
  const line = '='.repeat(64);
  console.error('');
  console.error(logger.paint('red', line));
  console.error(logger.paint('red', `  ${title}`));
  console.error(logger.paint('red', line));
  console.error(`  ${String(message).split('\n').join('\n  ')}`);
  if (extra) console.error(`\n${extra}`);
  console.error('');
}

async function main() {
  // ---- 1. Load configuration -------------------------------------------
  const config = configLoader.load();
  configLoader.ensureUploadsDir(config.uploadsDir);

  // ---- 2. Port ----------------------------------------------------------
  const resolvedPort = configLoader.resolvePort(config.port);
  config.port = resolvedPort.port;

  // Load these after config is available (they need the resolved port/domain).
  const db = require('./src/db');
  const session = require('./src/session');
  const { createApp } = require('./src/server');
  const { createConsoleHandler } = require('./src/console');

  // ---- 3. Connect to MySQL/MariaDB -------------------------------------
  try {
    await db.connect(config.database);
  } catch (err) {
    printFatal(
      'DATABASE CONNECTION FAILED',
      err.message,
      `Check config.json -> database.host / database.port / database.database /\n` +
        `database.user / database.password.\n` +
        `For the local database, check: systemctl status mariadb`
    );
    process.exit(1);
  }

  // ---- 4. Create / migrate tables --------------------------------------
  try {
    await db.initializeSchema();
  } catch (err) {
    printFatal(
      'DATABASE INITIALISATION FAILED',
      err.message,
      'The database user needs CREATE / ALTER permission on this database.'
    );
    await db.close().catch(() => {});
    process.exit(1);
  }

  // ---- 5. Start the web server ------------------------------------------
  const secret = session.loadOrCreateSecret(config.sessionSecretFile);
  const app = createApp(config, secret);

  const server = app.listen(config.port, config.host, () => {
    logger.info(`Web server running on ${config.host}:${config.port} (${resolvedPort.source}).`);
    logger.info(`Domain: ${config.domain}`);
    logger.info(`Uploads directory: ${config.uploadsDir}`);
    logger.info('Generate codes over SSH: node scripts/admin.js code | manage');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      printFatal('PORT ALREADY IN USE', `Port ${config.port} is already in use.`, 'Stop the other process or restart the server.');
    } else {
      printFatal('SERVER FAILED TO START', err.message);
    }
    process.exit(1);
  });

  // Keep-alive tweaks for reverse proxies / CDNs.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // ---- 6. Console commands ----------------------------------------------
  const consoleHandler = createConsoleHandler(config);
  consoleHandler.attach();

  // ---- 7. Graceful shutdown ---------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      db.close()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
    // Never hang the container stop.
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err && err.message ? err.message : err);
    // The process may be in an inconsistent state. Let systemd's existing
    // Restart=on-failure policy recover it instead of continuing to serve.
    process.exit(1);
  });
}

main().catch((err) => {
  printFatal('STARTUP FAILED', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
