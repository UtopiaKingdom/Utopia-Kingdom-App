/**
 * Run: node tools/test_signal_card_ttl.js
 */
const assert = require('assert');
const path = require('path');

const ttl = require(path.join(__dirname, '..', 'signal-card-ttl.js'));

assert.strictEqual(ttl.RESULT_GRACE_MS, 12000, 'grace ms');

const open = Date.parse('2026-08-18T22:12:42');
const signal = {
  phase: 'Signal',
  openedAtMs: open,
  duration: 30,
  selectedCurrency: 'GBP/USD OTC',
  action: 'SELL',
};

assert.strictEqual(ttl.isDeadSignal(signal, open + 10 * 1000, 30), false, 'live during expiry');
assert.strictEqual(ttl.isDeadSignal(signal, open + 30 * 1000, 30), false, 'just expired still waiting');
assert.strictEqual(ttl.isDeadSignal(signal, open + 40 * 1000, 30), false, 'inside grace');
assert.strictEqual(ttl.isDeadSignal(signal, open + 30 * 1000 + ttl.RESULT_GRACE_MS + 1, 30), true, 'dead after grace');

assert.ok(ttl.graceLeftMs(signal, open + 30 * 1000, 30) <= ttl.RESULT_GRACE_MS);
assert.ok(ttl.graceLeftMs(signal, open + 30 * 1000, 30) > 0);
assert.strictEqual(ttl.remainingSec(signal, open + 10 * 1000, 30), 20);
assert.strictEqual(ttl.remainingSec(signal, open + 40 * 1000, 30), 0);

assert.strictEqual(ttl.isDeadSignal({ phase: 'Trading Result', openedAtMs: open, duration: 30 }, open + 999999), false);

console.log('  ok  live / grace / dead windows');
console.log('\nAll signal-card-ttl tests passed.');
