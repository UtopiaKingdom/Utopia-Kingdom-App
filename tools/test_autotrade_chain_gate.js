/**
 * Unit tests for autotrade mid-chain detection helpers.
 * Run: node tools/test_autotrade_chain_gate.js
 */
const assert = require('assert');
const path = require('path');

global.window = {
  __liveChainMeta: Object.create(null),
  signalHistory: {
    LUMIX: [{ result: 'LOSS' }, { result: 'LOSS' }],
    MIRAX: []
  },
  // History losses must NOT force the modal while searching.
  getSavingSignalLosses: () => 2
};
global.document = {
  getElementById: () => null,
  querySelector: () => null,
  body: { appendChild() {}, classList: { add() {}, remove() {} } }
};

const gate = require(path.join(__dirname, '..', 'autotrade-chain-gate.js'));

assert.strictEqual(gate.isSignalChainOngoing('bot1'), false);
console.log('  ok  history losses alone = not ongoing (searching)');

global.window.__liveChainMeta.LUMIX = {
  attempt: 1,
  realLossStreak: 0,
  stakeMultiplier: 1,
  phase: 'preparing',
  at: Date.now()
};
assert.strictEqual(gate.isSignalChainOngoing('bot1'), false);
console.log('  ok  live attempt-1 preparing = not mid-chain');

global.window.__liveChainMeta.LUMIX = {
  attempt: 3,
  realLossStreak: 2,
  stakeMultiplier: 4,
  phase: 'signal',
  at: Date.now()
};
assert.strictEqual(gate.isSignalChainOngoing('bot1'), true);
console.log('  ok  live meta mid-chain');

global.window.__liveChainMeta.LUMIX = {
  attempt: 3,
  realLossStreak: 2,
  stakeMultiplier: 4,
  phase: 'idle',
  at: Date.now()
};
assert.strictEqual(gate.isSignalChainOngoing('bot1'), false);
console.log('  ok  idle phase = not ongoing');

global.window.__liveChainMeta.LUMIX = {
  attempt: 3,
  realLossStreak: 2,
  stakeMultiplier: 4,
  phase: 'signal',
  at: Date.now() - (7 * 60 * 1000)
};
assert.strictEqual(gate.isSignalChainOngoing('bot1'), false);
console.log('  ok  stale live meta = not ongoing');

gate.noteChainSignal('MIRAX', { attempt: 2, stakeMultiplier: 2, phase: 'Signal' });
assert.strictEqual(gate.isSignalChainOngoing('bot2'), true);
console.log('  ok  MIRAX attempt2 ongoing');

gate.markChainIdle('MIRAX');
assert.strictEqual(gate.isSignalChainOngoing('bot2'), false);
console.log('  ok  markChainIdle clears mid-chain');

global.window.__liveChainMeta.MIRAX = {
  attempt: 3,
  realLossStreak: 2,
  stakeMultiplier: 4,
  phase: 'trading result',
  result: 'LOSS',
  at: Date.now()
};
assert.strictEqual(gate.isSignalChainOngoing('bot2'), true);
assert.strictEqual(gate.getJoinAttempt('bot2'), 4);
console.log('  ok  result LOSS attempt 3 = ongoing, jump at 4 (10x)');

global.window.__liveChainMeta.MIRAX = {
  attempt: 1,
  realLossStreak: 0,
  stakeMultiplier: 1,
  phase: 'trading result',
  result: 'LOSS',
  at: Date.now()
};
assert.strictEqual(gate.isSignalChainOngoing('bot2'), true);
assert.strictEqual(gate.getJoinAttempt('bot2'), 2);
console.log('  ok  result LOSS attempt 1 = ongoing, jump at 2x');

global.window.__liveChainMeta.MIRAX = {
  attempt: 4,
  realLossStreak: 3,
  stakeMultiplier: 10,
  phase: 'signal',
  at: Date.now()
};
assert.strictEqual(gate.isSignalChainOngoing('bot2'), true);
assert.strictEqual(gate.getJoinAttempt('bot2'), 4);
console.log('  ok  live attempt 4 signal = jump at 10x');

global.window.__liveChainMeta.MIRAX = {
  attempt: 2,
  realLossStreak: 1,
  stakeMultiplier: 2,
  phase: 'trading result',
  result: 'WIN',
  at: Date.now()
};
assert.strictEqual(gate.isSignalChainOngoing('bot2'), false);
console.log('  ok  result WIN = not ongoing');

global.window.__liveChainMeta.MIRAX = {
  attempt: 5,
  realLossStreak: 4,
  stakeMultiplier: 20,
  phase: 'trading result',
  result: 'LOSS',
  at: Date.now()
};
assert.strictEqual(gate.isSignalChainOngoing('bot2'), false);
console.log('  ok  5-loss wipe = not ongoing');

(async () => {
  global.window.__liveChainMeta.LUMIX = {
    attempt: 3,
    realLossStreak: 2,
    stakeMultiplier: 4,
    phase: 'signal',
    at: Date.now()
  };
  assert.strictEqual(await gate.promptAutotradeChainChoice('bot1'), 'wait');
  console.log('  ok  mid-chain auto-waits (no jump popup)');

  global.window.__liveChainMeta.LUMIX = {
    attempt: 1,
    realLossStreak: 0,
    stakeMultiplier: 1,
    phase: 'preparing',
    at: Date.now()
  };
  assert.strictEqual(await gate.promptAutotradeChainChoice('bot1'), 'jump');
  console.log('  ok  idle starts on next 1x');
  assert.ok(String(gate.CHAIN_ONGOING_MSG).includes('Chain ongoing'));
  console.log('\nAll autotrade chain gate tests passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
