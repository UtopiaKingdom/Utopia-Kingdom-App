const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<!DOCTYPE html><body><div id="stat-total-wins-bot1"></div></body>`);
const window = dom.window;
const document = window.document;
global.window = window;
global.document = document;
window.botIdMap = { LUMIX: 'bot1' };
window.signalHistory = { LUMIX: [{result:'WIN'},{result:'loss'},{result:'w'}] };
// load stats-extra
require('./stats-extra.js');
// call manual update
window.__updateTotalWins('LUMIX');
console.log('DOM text after update:', document.getElementById('stat-total-wins-bot1').textContent);
