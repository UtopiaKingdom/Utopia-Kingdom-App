const assert = require('assert');
const {
  getDefaultTradeSeconds,
  resolveTradeDurationSec,
  resolveLivePlaceDurationSec,
  snapPoPlaceDuration,
  formatExpiryLabel
} = require('../trade-duration');

assert.strictEqual(getDefaultTradeSeconds('MIRAX'), 30);
assert.strictEqual(getDefaultTradeSeconds('bot2'), 30);
assert.strictEqual(getDefaultTradeSeconds('LUMIX'), 180);

assert.strictEqual(resolveTradeDurationSec('MIRAX', { duration: 30 }), 30);
assert.strictEqual(resolveTradeDurationSec('MIRAX', { duration: 60 }), 30, 'stale 60s must not inflate MiraX');
assert.strictEqual(resolveTradeDurationSec('MIRAX', { countdown: 10 }, 60), 30);
assert.strictEqual(resolveTradeDurationSec('MIRAX', {}, 30), 30);
assert.strictEqual(resolveTradeDurationSec('LUMIX', { duration: 180 }), 180);
assert.strictEqual(resolveTradeDurationSec('LUMIX', {}), 180);

assert.strictEqual(getDefaultTradeSeconds('NYX'), 60);
assert.strictEqual(getDefaultTradeSeconds('bot3'), 60);
assert.strictEqual(resolveTradeDurationSec('NYX', { duration: 20 }), 20);
assert.strictEqual(resolveTradeDurationSec('NYX', { duration: 180 }), 180);
assert.strictEqual(resolveTradeDurationSec('NYX', { duration: 600 }), 600);
assert.strictEqual(resolveTradeDurationSec('NYX', { duration: 10 }), 60, 'below 20s falls back');
assert.strictEqual(resolveTradeDurationSec('NYX', { duration: 900 }), 60, 'above 10m falls back');
assert.strictEqual(resolveTradeDurationSec('NYX', { duration: 298 }), 300, 'snap leftover 5m remaining up to 5m');
assert.strictEqual(resolveTradeDurationSec('MIRAX', { duration: 180 }), 30, 'Mirax still clamped');

assert.strictEqual(snapPoPlaceDuration(60), 60);
assert.strictEqual(snapPoPlaceDuration(58), 45, '58 snaps to common OTC bucket');
assert.strictEqual(snapPoPlaceDuration(57), 45);
assert.strictEqual(snapPoPlaceDuration(47), 45);
assert.strictEqual(snapPoPlaceDuration(17), 15);
assert.strictEqual(snapPoPlaceDuration(179), 120, 'raw remain snaps down; near-open uses full via resolveLive');
assert.ok(86400 % snapPoPlaceDuration(58) === 0);
assert.notStrictEqual(snapPoPlaceDuration(58), 58);

assert.strictEqual(resolveLivePlaceDurationSec('MIRAX', { duration: 30, openedAtMs: Date.now() }), 30);
assert.strictEqual(
  resolveLivePlaceDurationSec('MIRAX', { duration: 30, openedAtMs: Date.now() - 13000 }),
  15,
  'mid-candle MiraX snaps to common OTC bucket'
);
assert.strictEqual(resolveLivePlaceDurationSec('MIRAX', { duration: 30, openedAtMs: Date.now() - 28000 }) >= 5, true);
assert.strictEqual(
  resolveLivePlaceDurationSec('NYX', { duration: 300, openedAtMs: Date.now() - 2000 }),
  300,
  'NYX 5m must not shrink to remaining turbo seconds'
);
assert.strictEqual(
  resolveLivePlaceDurationSec('NYX', { duration: 60, openedAtMs: Date.now() - 2000 }),
  60,
  'NYX 1m near open keeps full 60 (not 58)'
);
assert.strictEqual(
  resolveLivePlaceDurationSec('NYX', { duration: 60, openedAtMs: Date.now() - 13000 }),
  45,
  'NYX 1m mid-candle snaps remaining to PO-valid'
);

assert.strictEqual(resolveTradeDurationSec('studio', { duration: 60 }), 60);
assert.strictEqual(resolveTradeDurationSec('studio', { duration: 30 }), 30);

assert.strictEqual(formatExpiryLabel('MIRAX', { duration: 30 }), '30s');
assert.strictEqual(formatExpiryLabel('NYX', { duration: 180, expiry: '1m' }), '3m', 'NYX label follows duration, not stale 1m');
assert.strictEqual(formatExpiryLabel('NYX', { duration: 60 }), '1m');
assert.strictEqual(formatExpiryLabel('NYX', { duration: 20 }), '20s');
assert.strictEqual(formatExpiryLabel('NYX', { duration: 300 }), '5m');
assert.strictEqual(formatExpiryLabel('NYX', { duration: 600 }), '10m');
assert.strictEqual(formatExpiryLabel('LUMIX', { duration: 180, expiry: '3m' }), '3m');

console.log('test_trade_duration: OK');
