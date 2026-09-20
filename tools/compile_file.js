const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || 'auth-verification.js';
try {
  const code = fs.readFileSync(path, 'utf8');
  new vm.Script(code, {filename: path});
  console.log('Compiled OK:', path);
} catch (err) {
  console.error('Compile error:', err && err.stack);
}