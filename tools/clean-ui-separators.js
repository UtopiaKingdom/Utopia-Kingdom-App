/**
 * Clean user-facing separators only. Never touch indentation/whitespace.
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'renderer.js');
let t = fs.readFileSync(file, 'utf8');
const before = t;

const swaps = [
  ['`Now ${tierLabel} · ${formatBetMoney(stake)} · full ${mode} chain ~${formatBetMoney(chainNeed)}`',
   '`Now ${tierLabel} | ${formatBetMoney(stake)} | full ${mode} chain ~${formatBetMoney(chainNeed)}`'],
  ['`${mode} mode · next bet ${formatBetMoney(base)} · full chain ~${formatBetMoney(chainNeed)}`',
   '`${mode} mode | next bet ${formatBetMoney(base)} | full chain ~${formatBetMoney(chainNeed)}`'],
  ['setTradeStatus(botKey, `${label} · ${mm}:${ss}`);',
   'setTradeStatus(botKey, `${label} | ${mm}:${ss}`);'],
  ["`Preparing time · ${currency}`",
   "`Preparing time | ${currency}`"],
  ["`SSID autotrade · ${currency}`",
   "`SSID autotrade | ${currency}`"],
  ["type === 'BUY' ? '▲' : '▼'",
   "type === 'BUY' ? 'UP' : 'DN'"],
  ["type === 'BUY' ? 'â-²' : 'â-¼'",
   "type === 'BUY' ? 'UP' : 'DN'"],
  ['aria-label="Close dialog">×</button>',
   'aria-label="Close dialog">x</button>'],
];

for (const [a, b] of swaps) {
  if (t.includes(a)) t = t.split(a).join(b);
}

// Any remaining middle-dot used as separator in template strings near UI labels
t = t.replace(/\$\{([^}]+)\} · \$\{/g, '${$1} | ${');
t = t.replace(/ · \$\{/g, ' | ${');
t = t.replace(/\} · `/g, '} | `');

if (t !== before) {
  fs.writeFileSync(file, t, 'utf8');
  console.log('renderer UI strings cleaned');
} else {
  console.log('no UI string changes needed');
}
