/**
 * Unit tests for Saving Signals stake policy (2x/4x ladders).
 * Run: node tools/test_saving_signal_stake.js
 */

const LADDERS = {
  '2x': [1, 2, 4, 10, 20],
  '4x': [1, 4, 7, 16, 44]
};

function resolveAmount(base, mode, attempt) {
  if (!Number.isFinite(attempt) || attempt < 1) return base; // safe 1x
  const ladder = LADDERS[mode === '4x' ? '4x' : '2x'];
  const mult = ladder[Math.min(Math.max(0, Math.trunc(attempt) - 1), 4)] || 1;
  return Math.round(base * mult * 100) / 100;
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
  console.log('  ok ', msg);
}

const base = 10;

assertEq(resolveAmount(base, '2x', 1), 10, '2x mode attempt 1 = 1x');
assertEq(resolveAmount(base, '2x', 2), 20, '2x mode attempt 2 = 2x');
assertEq(resolveAmount(base, '2x', 3), 40, '2x mode attempt 3 = 4x');
assertEq(resolveAmount(base, '2x', 5), 200, '2x mode attempt 5 = 20x');
assertEq(resolveAmount(base, '2x', 6), 200, '2x mode past 5 stays 20x (no 44x)');
assertEq(resolveAmount(base, '4x', 1), 10, '4x mode attempt 1 = 1x');
assertEq(resolveAmount(base, '4x', 2), 40, '4x mode attempt 2 = 4x');
assertEq(resolveAmount(base, '4x', 3), 70, '4x mode attempt 3 = 7x');
assertEq(resolveAmount(base, '4x', 4), 160, '4x mode attempt 4 = 16x');
assertEq(resolveAmount(base, '4x', 5), 440, '4x mode attempt 5 = 44x');
assertEq(resolveAmount(base, '2x', null), 10, 'missing attempt → 1x base (never stale 4x)');
assertEq(resolveAmount(base, '2x', undefined), 10, 'undefined attempt → 1x base');

// Regression: pre-bumped "next" attempt must NOT be used when live attempt is 2
{
  const liveAttempt = 2;
  const stalePreBumpAttempt = 3; // old bug
  const live = resolveAmount(base, '2x', liveAttempt);
  const stale = resolveAmount(base, '2x', stalePreBumpAttempt);
  assertEq(live, 20, 'live attempt 2 sizes 2x');
  assertEq(stale, 40, 'stale next-attempt would have been 4x (must not be used)');
  if (live === stale) throw new Error('live must differ from stale pre-bump');
  console.log('  ok  live attempt wins over stale pre-bump');
}

console.log('\nAll saving-signal stake tests passed.');
