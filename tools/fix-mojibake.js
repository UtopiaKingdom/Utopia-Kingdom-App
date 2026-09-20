/**
 * Fix UTF-8 mojibake that leaked into UI strings.
 * Entire file is ASCII-safe (needles built from byte arrays).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  'renderer.js',
  'bot-stats.js',
  'auth-visualizer.js',
  'auth-verification.js',
  'home-hub.js',
  'ssid-manager.js',
  'signal-pip-ui.js',
  'bot-history-ui.js',
  'strategies-ui.js',
  'bot-signal-fx.js',
  'bot-switch-fx.js',
  'update-ui.js',
  'index.html',
];

const u = (bytes) => Buffer.from(bytes).toString('utf8');

// Mojibake needles (UTF-8 bytes of the corrupted sequences as they appear in files)
const REPLACEMENTS = [
  // "Â·" (U+00C2 U+00B7) middle-dot mojibake
  [u([0xC3, 0x82, 0xC2, 0xB7]), ' · '],
  // "â€¦" ellipsis mojibake
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC2, 0xA6]), '...'],
  // "â€”" em-dash mojibake
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xE2, 0x80, 0x9D]), ' - '],
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC2, 0x94]), ' - '],
  // "â€“" en-dash
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xE2, 0x80, 0x9C]), '-'],
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC2, 0x93]), '-'],
  // "â€™" right single quote
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xE2, 0x84, 0xA2]), "'"],
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC2, 0x99]), "'"],
  // "â€˜"
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xE2, 0x80, 0x98]), "'"],
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC2, 0x98]), "'"],
  // "â€œ" "â€"
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC5, 0x93]), '"'],
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC2, 0x9C]), '"'],
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC2, 0x9D]), '"'],
  // "â€¢"
  [u([0xC3, 0xA2, 0xE2, 0x82, 0xAC, 0xC2, 0xA2]), ' · '],
  // "Ã—" times
  [u([0xC3, 0x97]), 'x'],
  [u([0xC3, 0x83, 0xC2, 0x97]), 'x'],
  // triangles
  [u([0xC3, 0xA2, 0xC2, 0x96, 0xC2, 0xB2]), ''],
  [u([0xC3, 0xA2, 0xC2, 0x96, 0xC2, 0xBC]), ''],
];

function fixText(t) {
  let out = t;
  for (const [from, to] of REPLACEMENTS) {
    if (!from) continue;
    if (out.includes(from)) out = out.split(from).join(to);
  }

  // Also handle if file already decoded mojibake into separate chars matching Latin-1 misread
  // Scan for C2 B7 as middle dot that's fine, and C3 82 alone before punctuation

  out = out.replace(/\u2026/g, '...');
  out = out.replace(/\u2014/g, ' - ');
  out = out.replace(/\u2013/g, '-');
  out = out.replace(/[\u2018\u2019]/g, "'");
  out = out.replace(/[\u201C\u201D]/g, '"');
  out = out.replace(/\u00D7/g, 'x');
  out = out.replace(/\u00BD\s*x/gi, '1/2x');
  out = out.replace(/\u00BD/g, '1/2');
  // Keep a single middle dot, not spaced weirdly later
  out = out.replace(/\u00B7/g, '·');

  // Lone Â (U+00C2) before word chars
  out = out.replace(/\u00C2(?=[\w])/g, '');

  out = out.replace(/[^\S\n]{2,}/g, ' ');
  // Normalize " · " spacing around middle dots used as separators
  out = out.replace(/\s*·\s*/g, ' · ');
  return out;
}

let changed = 0;
for (const rel of files) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) {
    console.log('skip missing', rel);
    continue;
  }
  const buf = fs.readFileSync(p);
  const before = buf.toString('utf8');
  const after = fixText(before);
  if (after !== before) {
    fs.writeFileSync(p, after, 'utf8');
    changed += 1;
    console.log('fixed', rel);
  } else {
    console.log('ok', rel);
  }
}

// Report remaining suspicious sequences in renderer
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const suspects = [];
if (renderer.includes('\u00C2')) suspects.push('U+00C2 still present');
if (/â.?/.test(renderer)) suspects.push('a-circumflex sequences');
if (renderer.includes('Â')) suspects.push('literal Â');
console.log('done, changed', changed, 'suspects', suspects);
