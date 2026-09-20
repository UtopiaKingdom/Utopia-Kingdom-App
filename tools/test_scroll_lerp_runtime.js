/**
 * tools/test_scroll_lerp_runtime.js — native scroll stub (no wheel hijack).
 */
'use strict';

const { JSDOM } = require('jsdom');
const path = require('path');
const fs = require('fs');

const html = `<!doctype html><html><body>
<main class="main-content" style="height:200px;overflow:auto">
  <div style="height:400px">outer</div>
</main>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

global.window = window;
global.document = window.document;

const src = fs.readFileSync(path.join(__dirname, '..', 'app-scroll-smooth.js'), 'utf8');
window.eval(src);

if (!window.__utkScrollSmooth || !window.__utkScrollSmooth.__nativeV1) {
  console.error('fail: native scroll stub not registered');
  process.exit(1);
}

const main = document.querySelector('.main-content');
main.scrollTop = 40;

const ev = new window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
const canceled = !document.dispatchEvent(ev);

if (canceled) {
  console.error('fail: wheel was canceled (scroll hijack still active)');
  process.exit(1);
}

if (main.scrollTop !== 40) {
  console.error('fail: JS mutated scrollTop on wheel', { top: main.scrollTop });
  process.exit(1);
}

if (document.documentElement.classList.contains('utk-scrolling')) {
  console.error('fail: utk-scrolling class should not be set');
  process.exit(1);
}

console.log('ok: native scroll — wheel left alone');
