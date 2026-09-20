const fs = require('fs');
const t = fs.readFileSync(require('path').join(__dirname, '..', 'renderer.js'), 'utf8');

const samples = [];
for (let i = 0; i < t.length; i++) {
  const code = t.charCodeAt(i);
  if (code === 0xC2 || code === 0xE2 || t[i] === '\u00C2' || t[i] === '\u00E2') {
    samples.push({
      i,
      hex: [...t.slice(i, i + 4)].map((ch) => ch.charCodeAt(0).toString(16)).join(' '),
      ctx: t.slice(Math.max(0, i - 12), i + 28),
    });
    if (samples.length >= 30) break;
  }
}
console.log(JSON.stringify(samples, null, 2));
const m = t.match(/mode[\s\S]{0,50}next bet[\s\S]{0,50}/);
console.log('bet hint', m && m[0]);
const m2 = t.match(/setTradeStatus\([^)]*Trading[^)]*\)/);
console.log('trade status', m2 && m2[0]);
