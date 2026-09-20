/** Sync FILE_SIZE_BYTES + FILE_SHA512 in wrangler.toml from dist/latest.yml */
const fs = require('fs');
const path = require('path');
const yml = fs.readFileSync(path.join(__dirname, '..', 'dist', 'latest.yml'), 'utf8');
const sha = (yml.match(/^sha512:\s*(.+)$/m) || [])[1];
const size = (yml.match(/^\s+size:\s*(\d+)\s*$/m) || yml.match(/size:\s*(\d+)/) || [])[1];
if (!sha || !size) {
  console.error('Could not parse latest.yml', { sha: !!sha, size: !!size });
  process.exit(1);
}
const tomlPath = path.join(__dirname, '..', 'wrangler.toml');
let t = fs.readFileSync(tomlPath, 'utf8');
t = t.replace(/FILE_SIZE_BYTES = "[^"]+"/, 'FILE_SIZE_BYTES = "' + size + '"');
t = t.replace(/FILE_SHA512 = "[^"]+"/, 'FILE_SHA512 = "' + sha.trim() + '"');
fs.writeFileSync(tomlPath, t);
console.log('wrangler synced size=' + size);
