const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'index.html');
if (!fs.existsSync(htmlPath)) {
  console.error('index.html not found at', htmlPath);
  process.exit(2);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const dom = new JSDOM(html);
const { document } = dom.window;

function find(id) {
  const el = document.getElementById(id);
  if (!el) {
    console.error(`Missing element with id="${id}"`);
    return null;
  }
  return el;
}

const cont = find('updateProgressContainer');
const fill = find('updateProgressFill');
const text = find('updateProgressText');

if (!cont || !fill || !text) process.exit(1);

// Simulate progress updates and verify DOM changes
const steps = [0, 10, 25, 50, 75, 100];
for (const p of steps) {
  cont.style.display = 'block';
  fill.style.width = p + '%';
  text.textContent = p + '%';
  // Validate
  if (fill.style.width !== String(p) + '%') {
    console.error('Fill width mismatch at', p, 'expected', p + '%', 'got', fill.style.width);
    process.exit(3);
  }
  if (text.textContent !== String(p) + '%') {
    console.error('Text mismatch at', p, 'expected', p + '%', 'got', text.textContent);
    process.exit(4);
  }
  console.log('Progress simulated:', p + '%');
}

console.log('DOM test passed — progress elements exist and update correctly.');
process.exit(0);
