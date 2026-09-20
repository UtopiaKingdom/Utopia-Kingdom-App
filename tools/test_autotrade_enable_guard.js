/**
 * Stake sync must never kill autotrade enabled.
 */
const assert = require('assert');
const { resolveEnabledUpdate } = require('../autotrade-enable-guard');

function run() {
  assert.deepStrictEqual(
    resolveEnabledUpdate({}, true),
    { apply: false, reason: 'omitted' }
  );

  assert.deepStrictEqual(
    resolveEnabledUpdate({ clearStaleStake: true, stakeAmount: 20 }, true),
    { apply: false, reason: 'omitted' }
  );

  const blocked = resolveEnabledUpdate(
    { enabled: false, clearStaleStake: true, stakeAmount: 20 },
    true
  );
  assert.strictEqual(blocked.apply, false);
  assert.strictEqual(blocked.reason, 'block-stake-disable');

  const blockedMult = resolveEnabledUpdate(
    { enabled: false, savingSignalMultiplier: 2 },
    true
  );
  assert.strictEqual(blockedMult.apply, false);

  const userOff = resolveEnabledUpdate(
    { enabled: false, source: 'user-toggle' },
    true
  );
  assert.deepStrictEqual(userOff, { apply: true, value: false });

  const hardOff = resolveEnabledUpdate(
    { enabled: false, clearStaleStake: true, source: 'hard-disconnect' },
    true
  );
  assert.deepStrictEqual(hardOff, { apply: true, value: false });

  const userOn = resolveEnabledUpdate({ enabled: true, source: 'user-toggle' }, false);
  assert.deepStrictEqual(userOn, { apply: true, value: true });

  // Explicit enable with stake fields is fine (heal after arm).
  const heal = resolveEnabledUpdate(
    { enabled: true, clearStaleStake: true, stakeAmount: 10, source: 'user-toggle' },
    false
  );
  assert.deepStrictEqual(heal, { apply: true, value: true });

  console.log('test_autotrade_enable_guard: OK');
}

run();
