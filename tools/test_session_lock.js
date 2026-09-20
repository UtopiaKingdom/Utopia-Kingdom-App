/**
 * Unit tests for session-lock-logic (no Firebase).
 * Run: node tools/test_session_lock.js
 */
const assert = require('assert');
const {
  isForeignActiveLock,
  decideLockClaim,
  isActiveElsewhereError,
  DEFAULT_STALE_MS
} = require('../session-lock-logic.js');

const now = 1_700_000_000_000;

function pass(name) {
  console.log('  ok  ' + name);
}

// empty / cleared lock → claim
assert.strictEqual(
  decideLockClaim(null, 'pc', 's1', { nowMs: now }),
  'claim'
);
pass('empty lock claims');

assert.strictEqual(
  decideLockClaim({ sessionId: null, deviceId: null }, 'pc', 's1', { nowMs: now }),
  'claim'
);
pass('cleared lock claims');

// same device reclaim
assert.strictEqual(
  decideLockClaim(
    { sessionId: 'old', deviceId: 'pc', updatedAt: now - 1000 },
    'pc',
    's2',
    { nowMs: now }
  ),
  'claim'
);
pass('same device reclaim');

// foreign live lock blocks
assert.strictEqual(
  decideLockClaim(
    { sessionId: 'phone-sess', deviceId: 'phone', updatedAt: now - 10_000 },
    'pc',
    's2',
    { nowMs: now }
  ),
  'active_elsewhere'
);
pass('foreign live lock blocks');

// stale foreign lock reclaimable
assert.strictEqual(
  decideLockClaim(
    {
      sessionId: 'phone-sess',
      deviceId: 'phone',
      updatedAt: now - DEFAULT_STALE_MS - 1
    },
    'pc',
    's2',
    { nowMs: now }
  ),
  'claim'
);
pass('stale foreign lock reclaimable');

// no timestamp → reclaimable
assert.strictEqual(
  isForeignActiveLock(
    { sessionId: 'x', deviceId: 'phone' },
    'pc',
    's2',
    now
  ),
  false
);
pass('missing timestamp not foreign-active');

// force overrides foreign live
assert.strictEqual(
  decideLockClaim(
    { sessionId: 'phone-sess', deviceId: 'phone', updatedAt: now },
    'pc',
    's2',
    { nowMs: now, force: true }
  ),
  'claim'
);
pass('force claims over foreign live');

assert.strictEqual(isActiveElsewhereError(new Error('active_elsewhere')), true);
assert.strictEqual(isActiveElsewhereError(new Error('Firebase: active_elsewhere')), true);
assert.strictEqual(isActiveElsewhereError(new Error('permission-denied')), false);
pass('active_elsewhere detection');

console.log('\nAll session lock logic tests passed.');
