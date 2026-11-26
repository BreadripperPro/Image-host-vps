'use strict';

// Run over SSH while the systemd service continues serving requests.
const { load } = require('../src/config');
const db = require('../src/db');
const { createConsoleHandler } = require('../src/console');

async function main() {
  const command = process.argv.slice(2).join(' ').trim().toLowerCase();
  if (!/^(code|manage|management|status|stats|help|revoke (upload|manage|management|all))$/.test(command)) {
    throw new Error('Usage: node scripts/admin.js code|manage|status|help|revoke upload|revoke manage|revoke all');
  }
  const config = load();
  config.port = require('../src/config').resolvePort(config.port).port;
  try {
    await db.connect(config.database);
    await createConsoleHandler(config).dispatch(command);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
