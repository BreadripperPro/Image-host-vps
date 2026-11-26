'use strict';

// Read-only migration check. Inspects the original files directly and never
// changes files or rows.
const fs = require('fs/promises');
const path = require('path');
const db = require('../src/db');
const { load } = require('../src/config');

async function checkStorage(config, rows, output = console.log) {
  const referenced = new Set();
  let problems = 0;
  for (const row of rows) {
    const name = String(row.stored_filename);
    if (!/^[a-f0-9]{8,64}\.[a-z0-9]{2,5}$/.test(name)) {
      output(`INVALID stored filename for image #${row.id}: ${JSON.stringify(name)}`);
      problems++;
      continue;
    }
    referenced.add(name);
    try {
      const stat = await fs.lstat(path.join(config.uploadsDir, name));
      if (!stat.isFile() || stat.size !== Number(row.byte_size)) {
        output(`SIZE/TYPE mismatch for image #${row.id}: ${name} (DB ${row.byte_size}, disk ${stat.size})`);
        problems++;
      }
    } catch (err) {
      output(`${err.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE'} file for image #${row.id}: ${name}`);
      problems++;
    }
  }
  const files = await fs.readdir(config.uploadsDir);
  const unreferenced = files.filter((name) => /^[a-f0-9]{8,64}\.[a-z0-9]{2,5}$/.test(name) && !referenced.has(name));
  output(`Checked ${rows.length} database records: ${problems} problem(s), ${unreferenced.length} unreferenced image file(s).`);
  if (unreferenced.length) output('Unreferenced files were left untouched.');
  return problems;
}

async function main() {
  const config = load();
  try {
    await db.connect(config.database);
    const rows = await db.query('SELECT `id`, `stored_filename`, `byte_size` FROM `images`');
    if (await checkStorage(config, rows)) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (require.main === module) main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
module.exports = { checkStorage };
