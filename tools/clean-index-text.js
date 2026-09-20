const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let t = fs.readFileSync(p, 'utf8');
t = t.replace(/placeholder="[^"]*"/g, (m) => {
  if (m.includes('codeInput') || m.includes('\u00B7') || m.includes('·')) return 'placeholder=""';
  return m;
});
// safer: fix the four code inputs specifically
t = t.replace(/id="codeInput([1-4])"([^>]*)placeholder="[^"]*"/g, 'id="codeInput$1"$2placeholder=""');
t = t.replace(/<\/a>\s*[\u00B7·]\s*3 attempts max/g, '</a> | 3 attempts max');
fs.writeFileSync(p, t, 'utf8');
console.log('index ok');
