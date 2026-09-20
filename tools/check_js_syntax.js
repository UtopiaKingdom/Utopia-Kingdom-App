const fs = require('fs');
const path = require('path');

function walk(dir, files=[]) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(full, files);
    } else if (e.isFile() && full.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

const root = process.cwd();
const files = walk(root);
let failed = 0;
for (const file of files) {
  try {
    const code = fs.readFileSync(file, 'utf8');
    // Try to create a Function to parse
    new Function(code);
  } catch (err) {
    console.error('\n[SYNTAX ERROR] in', file, '\n', err && err.message);
    failed++;
  }
}
if (failed === 0) console.log('\nNo syntax errors found.'); else console.log('\nTotal files with syntax errors:', failed);