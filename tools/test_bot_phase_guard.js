/**
 * Phase guard: after Result, attempt-1 of a new chain must be accepted.
 * Run: node tools/test_bot_phase_guard.js
 */
const assert = require('assert');
const path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'bot-phase-guard.js'));
const guard = global.window.BotPhaseGuard || global.BotPhaseGuard;

assert.ok(guard, 'BotPhaseGuard loaded');

guard.notePhaseAccepted('LUMIX', { phase: 'Trading Result', attempt: 5, signalId: 'a' });
let v = guard.shouldAcceptPhase('LUMIX', { phase: 'Preparing', attempt: 1, signalId: 'b' });
assert.strictEqual(v.ok, false, 'Preparing is ignored');
v = guard.shouldAcceptPhase('LUMIX', { phase: 'Signal', attempt: 1, signalId: 'b' });
assert.strictEqual(v.ok, true, 'attempt1 Signal after wipe Result must be accepted');
console.log('  ok  new chain after wipe');

guard.notePhaseAccepted('LUMIX', { phase: 'Trading Result', attempt: 2, result: 'WIN', signalId: 'c' });
v = guard.shouldAcceptPhase('LUMIX', { phase: 'Signal', attempt: 1, signalId: 'd' });
assert.strictEqual(v.ok, true, 'attempt1 Signal after win Result must be accepted');
console.log('  ok  new chain after win');

guard.notePhaseAccepted('LUMIX', { phase: 'Trading Result', attempt: 1, result: 'WIN', signalId: 'c2' });
v = guard.shouldAcceptPhase('LUMIX', { phase: 'Signal', attempt: 1, signalId: 'c3' });
assert.strictEqual(v.ok, true, 'attempt1 Signal after attempt1 WIN must be accepted');
console.log('  ok  same-attempt new chain after win');

guard.notePhaseAccepted('MIRAX', { phase: 'Signal', attempt: 2, signalId: 'e' });
v = guard.shouldAcceptPhase('MIRAX', { phase: 'Signal', attempt: 2, signalId: 'e', updateOnly: true });
assert.strictEqual(v.ok, true, 'same Signal price patch allowed');
console.log('  ok  signal update allowed');

guard.notePhaseAccepted('MIRAX', { phase: 'Trading Result', attempt: 2, signalId: 'g' });
v = guard.shouldAcceptPhase('MIRAX', { phase: 'Signal', attempt: 3, signalId: 'h' });
assert.strictEqual(v.ok, true, 'retry attempt 3 after loss Result allowed');
console.log('  ok  MG retry allowed');

guard.resetBot('LOCK');
guard.notePhaseAccepted('LOCK', { phase: 'Signal', attempt: 1, signalId: 'live1', symbol: 'EURUSD OTC' });
v = guard.shouldAcceptPhase('LOCK', { phase: 'Signal', attempt: 1, signalId: 'live2', symbol: 'USDJPY OTC' });
assert.strictEqual(v.ok, false, 'live Signal must not swap to another pair');
console.log('  ok  live signal locked');

v = guard.shouldAcceptPhase('LOCK', { phase: 'Trading Result', attempt: 1, signalId: 'live1', result: 'LOSS' });
assert.strictEqual(v.ok, true, 'matching Result for locked Signal allowed');
console.log('  ok  matching result allowed');

v = guard.shouldAcceptPhase('LOCK', { phase: 'Trading Result', attempt: 1, signalId: 'other', symbol: 'USDJPY OTC' });
assert.strictEqual(v.ok, false, 'Result for a different signal rejected');
console.log('  ok  foreign result rejected');

guard.resetBot('IDDRIFT');
guard.notePhaseAccepted('IDDRIFT', {
  phase: 'Signal', attempt: 1, signalId: 'MIRAX:GBPUSD:SELL:1:111', symbol: 'GBP/USD OTC',
});
v = guard.shouldAcceptPhase('IDDRIFT', {
  phase: 'Trading Result', attempt: 1, signalId: 'MIRAX:GBPUSD:SELL:1:222',
  symbol: 'GBP/USD OTC', result: 'LOSS',
});
assert.strictEqual(v.ok, true, 'Result with drifted signalId same pair+attempt allowed');
console.log('  ok  result id drift same pair');

guard.notePhaseAccepted('LOCK', { phase: 'Trading Result', attempt: 1, signalId: 'live1', result: 'LOSS' });
guard.markSettled('LOCK');
v = guard.shouldAcceptPhase('LOCK', { phase: 'Trading Result', attempt: 1, signalId: 'live1', result: 'LOSS' });
assert.strictEqual(v.ok, false, 'faded Result must not resurrect');
console.log('  ok  faded result stays gone');

v = guard.shouldAcceptPhase('LOCK', { phase: 'Signal', attempt: 2, signalId: 'next2', symbol: 'EURUSD OTC' });
assert.strictEqual(v.ok, true, 'next Signal after fade allowed');
console.log('  ok  next signal after fade');

console.log('\nAll bot-phase-guard tests passed.');
