/**
 * tools/test_scroll_signal_fixes.js — regression checks for scroll + signal paint.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

// 1) Scroll must stay native — no wheel preventDefault / rAF lerp
{
  const src = read('app-scroll-smooth.js');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(src.includes('__nativeV1'), 'native scroll stub present');
  assert.ok(!/\bgetComputedStyle\s*\(/.test(stripped), 'scroll must not call getComputedStyle');
  assert.ok(!/\bpreventDefault\s*\(/.test(stripped), 'must not preventDefault wheel');
  assert.ok(!/addEventListener\s*\(\s*['"]wheel['"]/.test(stripped), 'must not listen to wheel');
  assert.ok(!/\brequestAnimationFrame\b/.test(stripped), 'must not rAF-lerp scrollTop');
  const css = read('perf-ui.css');
  assert.ok(!css.includes('html.utk-scrolling'), 'no scroll paint-freeze class');
}

// 2) Glow must not use a covering ::before layer
{
  const css = read('bot-minimal.css');
  assert.ok(/bot-signal-area::before[\s\S]*?display:\s*none\s*!important/.test(css), '::before disabled');
  assert.ok(css.includes('z-index: 5 !important'), 'signal display above chrome');
}

// 3) endResize must flush deferred signal paints
{
  const perf = read('app-perf.js');
  assert.ok(perf.includes("dispatchEvent(new Event('app:resize-finish'))"), 'endResize emits resize-finish');
  const ren = read('renderer.js');
  assert.ok(ren.includes('__renderQueueSafetyTimer'), 'safety flush timer for deferred signals');
}

console.log('ok: scroll + signal paint regression checks passed');
