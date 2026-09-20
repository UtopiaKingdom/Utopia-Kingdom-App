// simple DOM stub for testing stats-extra.js
const els = {};
function stubEl(id, text) { els[id] = { id, textContent: text };
  return els[id]; }
// create sample stats
stubEl('stat-1x-wins-bot1', '5');
stubEl('stat-2x4x-wins-bot1', '3');
stubEl('stat-5x7x-wins-bot1', '2');
stubEl('stat-12x16x-wins-bot1', '1');
stubEl('stat-25x44x-wins-bot1', '4');
stubEl('stat-total-wins-bot1', '0');

// implement minimal DOM methods
global.document = {
  getElementById: id => els[id] || null,
  querySelectorAll: sel => {
    if (sel === '[id^="stat-total-wins-"]') {
      return Object.values(els).filter(e => e.id.startsWith('stat-total-wins-'));
    }
    return [];
  },
  addEventListener: (ev, fn) => {
    // immediately call for test
    if (ev === 'DOMContentLoaded') fn();
  }
};
global.window = {};

// load stats-extra and run tests
require('./stats-extra.js');
console.log('after load total element value:', document.getElementById('stat-total-wins-bot1').textContent);
// simulate later update
document.getElementById('stat-1x-wins-bot1').textContent = '10';
setTimeout(() => {
  console.log('after update total element value:', document.getElementById('stat-total-wins-bot1').textContent);
}, 3100);
