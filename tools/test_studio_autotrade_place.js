/**
 * Studio autotrade donor + duration contract (no live PO calls).
 */
const assert = require('assert');
const { snapPoPlaceDuration, resolveLivePlaceDurationSec } = require('../trade-duration');

function isStudioTradeBotId(botId) {
  const id = String(botId || '').toLowerCase();
  return id === 'studio' || id.startsWith('studio:') || id.startsWith('studio-');
}

assert.strictEqual(isStudioTradeBotId('studio'), true);
assert.strictEqual(isStudioTradeBotId('studio:b_abc'), true);
assert.strictEqual(isStudioTradeBotId('bot1'), false);

// Exact failure from main.log 2026-08-30 — must place a valid PO duration.
assert.strictEqual(snapPoPlaceDuration(58), 45);
assert.strictEqual(snapPoPlaceDuration(57), 45);
assert.notStrictEqual(snapPoPlaceDuration(58), 58);
assert.ok(86400 % snapPoPlaceDuration(58) === 0);

// Near-open NYX/studio 1m must keep 60, not 58.
const near = resolveLivePlaceDurationSec('NYX', {
  duration: 60,
  openedAtMs: Date.now() - 2000
});
assert.strictEqual(near, 60);

const studioNear = resolveLivePlaceDurationSec('studio', {
  duration: 60,
  openedAtMs: Date.now() - 1500
});
assert.strictEqual(studioNear, 60);

console.log('test_studio_autotrade_place: OK');
