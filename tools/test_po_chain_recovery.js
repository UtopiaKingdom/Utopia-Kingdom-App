/**
 * Unit tests for mid-chain payout recovery math.
 * Run: node tools/test_po_chain_recovery.js
 */
const assert = require('assert');
const { recoveryCheck, createPoChainRecovery, nextSizeAttempt, shouldHoldForNewBotChain } = require('../po-chain-recovery');

// 1+2+4=7 lost, next 10 @ 92% → profit 9.2 covers
{
  const r = recoveryCheck({ lossesSoFar: 7, nextStake: 10, payoutPct: 92 });
  assert.strictEqual(r.covers, true);
  assert.strictEqual(r.profitIfWin, 9.2);
  assert.ok(r.minPayoutPct <= 70.01);
}

// same losses, 10 @ 50% → profit 5 does NOT cover
{
  const r = recoveryCheck({ lossesSoFar: 7, nextStake: 10, payoutPct: 50 });
  assert.strictEqual(r.covers, false);
  assert.strictEqual(r.profitIfWin, 5);
  assert.strictEqual(r.shortfall, 2);
  assert.strictEqual(r.minPayoutPct, 70);
}

// 80% can still cover small deficit: lost 3, next 4 @ 80% → 3.2 >= 3
{
  const r = recoveryCheck({ lossesSoFar: 3, nextStake: 4, payoutPct: 80 });
  assert.strictEqual(r.covers, true);
}

// 20% on 20x after big losses: lost 17, next 20 @ 20% → 4 < 17 stop
{
  const r = recoveryCheck({ lossesSoFar: 17, nextStake: 20, payoutPct: 20 });
  assert.strictEqual(r.covers, false);
  assert.strictEqual(r.profitIfWin, 4);
}

// 4x last step is 44x: lost 1+4+7+16=28 units, next 44 @ 92% → 40.48 covers
{
  const r = recoveryCheck({ lossesSoFar: 140, nextStake: 220, payoutPct: 92 });
  assert.strictEqual(r.covers, true);
  assert.strictEqual(r.profitIfWin, 202.4);
}

// old 20x last step on 4x does NOT cover 140 @ 92% (why 44x exists)
{
  const r = recoveryCheck({ lossesSoFar: 140, nextStake: 100, payoutPct: 92 });
  assert.strictEqual(r.covers, false);
  assert.strictEqual(r.profitIfWin, 92);
}

const ledger = createPoChainRecovery();
ledger.notePlaced('bot1', { attempt: 1, amount: 1, currency: 'EUR/USD OTC', dealId: 'a' });
ledger.notePlaced('bot1', { attempt: 2, amount: 2, dealId: 'b' });
assert.strictEqual(ledger.getLossesSoFar('bot1'), 0); // pending is not a loss
assert.strictEqual(ledger.getConfirmedLossCount('bot1'), 0);
ledger.noteOutcome('bot1', { dealId: 'a', attempt: 1, outcome: 'loss' });
ledger.noteOutcome('bot1', { dealId: 'b', attempt: 2, outcome: 'draw' });
assert.strictEqual(ledger.getLossesSoFar('bot1'), 1); // draw not counted
ledger.notePlaced('bot1', { attempt: 3, amount: 4, dealId: 'c' });
assert.strictEqual(ledger.getLossesSoFar('bot1'), 1); // pending 4x not counted
ledger.noteOutcome('bot1', { dealId: 'c', attempt: 3, outcome: 'win' });
assert.strictEqual(ledger.getLossesSoFar('bot1'), 0);
assert.strictEqual(ledger.getState('bot1'), null);

assert.strictEqual(nextSizeAttempt({ forceNextAttempt1: true, fromBot: 2, fromHistory: 4 }), 1);
assert.strictEqual(nextSizeAttempt({ waitChain: true, fromBot: 3, fromHistory: 3 }), 1);
assert.strictEqual(nextSizeAttempt({ confirmedLosses: 2, fromBot: 1, fromHistory: 1 }), 3);
assert.strictEqual(nextSizeAttempt({ confirmedLosses: 0, fromBot: 1, fromHistory: 2 }), 2);
assert.strictEqual(nextSizeAttempt({ confirmedLosses: 0, fromBot: 2, fromHistory: 1 }), 2);
assert.strictEqual(nextSizeAttempt({ confirmedLosses: 1, fromBot: 1, fromHistory: 1 }), 2);
assert.strictEqual(nextSizeAttempt({ confirmedLosses: 5, fromBot: 1, fromHistory: 3 }), 1);

assert.strictEqual(shouldHoldForNewBotChain(false, 4), false);
assert.strictEqual(shouldHoldForNewBotChain(true, 1), false);
assert.strictEqual(shouldHoldForNewBotChain(true, 2), true);
assert.strictEqual(shouldHoldForNewBotChain(true, 4), true);
assert.strictEqual(shouldHoldForNewBotChain(true, '3'), true);

console.log('test_po_chain_recovery: OK');
