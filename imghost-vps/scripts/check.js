'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const files = ['index.js'];
for (const dir of ['src', 'public', 'scripts']) {
  for (const file of fs.readdirSync(path.join(root, dir))) {
    if (file.endsWith('.js')) files.push(path.join(dir, file));
  }
}
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
console.log(`Syntax checks passed for ${files.length} JavaScript files.`);
