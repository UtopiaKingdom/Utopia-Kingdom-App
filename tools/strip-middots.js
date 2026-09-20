const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'renderer.js');
let t = fs.readFileSync(file, 'utf8');
const before = t;
// Only replace middle-dot character, leave spaces/indent alone
t = t.split('\u00B7').join('|');
if (t !== before) {
  fs.writeFileSync(file, t, 'utf8');
  console.log('replaced middle-dots with | count', before.split('\u00B7').length - 1);
} else {
  console.log('no middle-dots left');
}
