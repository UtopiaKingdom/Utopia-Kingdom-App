/**
 * ENTRY, then S1–S4 after the first LOSS. 5-loss wipe / WIN resets to ENTRY.
 * Run: node tools/test_saving_step_label.js
 */
const assert = require('assert');
const step = require('../saving-step-label.js');

assert.strictEqual(step.stepOfAttempt(1), 'ENTRY');
assert.strictEqual(step.stepOfAttempt(2), 'S1');
assert.strictEqual(step.stepOfAttempt(3), 'S2');
assert.strictEqual(step.stepOfAttempt(4), 'S3');
assert.strictEqual(step.stepOfAttempt(5), 'S4');
assert.strictEqual(step.badgeFor(1, 'WIN'), 'ENTRY', 'first-try win is ENTRY');
assert.strictEqual(step.badgeFor(1, 'LOSS'), 'ENTRY', 'first loss is ENTRY');
assert.strictEqual(step.badgeFor(2, 'LOSS'), 'S1', 'second step is S1');
assert.strictEqual(step.badgeFor(5, 'WIN'), 'S4', 'win on 5th step is S4');
assert.strictEqual(step.formatStepLabel(1), 'ENTRY');
assert.strictEqual(step.formatStepLabel(1, { result: 'LOSS' }), 'ENTRY');
assert.strictEqual(step.formatStepLabel(2), 'S1');
assert.strictEqual(step.formatStepLabel(2, { showMultiplier: true, mode: '2x' }), 'S1 · 2x');
assert.strictEqual(step.formatStepLabel(2, { showMultiplier: true, mode: '4x' }), 'S1 · 4x');
assert.strictEqual(step.formatStepLabel(5, { showMultiplier: true, mode: '2x' }), 'S4 · 20x');
assert.strictEqual(step.formatStepLabel(5, { showMultiplier: true, mode: '4x' }), 'S4 · 44x');

{
  const trades = [
    { result: 'LOSS', timestamp: 3, symbol: 'AUD/CHF OTC' },
    { result: 'WIN', timestamp: 2, symbol: 'USD/CHF OTC' },
    { result: 'LOSS', timestamp: 1, symbol: 'USD/CHF OTC' }
  ];
  assert.strictEqual(step.displayAttempt(trades, { attempt: 1, symbol: 'AUD/CHF OTC' }), 2, 'same pair after 1 loss is step 2');
}

{
  const otherPair = [
    { result: 'LOSS', timestamp: 4, symbol: 'USD/CHF OTC' },
    { result: 'LOSS', timestamp: 3, symbol: 'USD/CHF OTC' },
    { result: 'LOSS', timestamp: 2, symbol: 'USD/CHF OTC' },
    { result: 'LOSS', timestamp: 1, symbol: 'USD/CHF OTC' }
  ];
  assert.strictEqual(
    step.displayAttempt(otherPair, { attempt: 1, symbol: 'AUD/CHF OTC' }),
    5,
    'hop after 4 losses is step 5 (S4), not a fresh chain'
  );
}

{
  const wipe = [5, 4, 3, 2, 1].map(function (n) {
    return { result: 'LOSS', timestamp: n, symbol: 'USD/CHF OTC' };
  });
  assert.strictEqual(
    step.displayAttempt(wipe, { attempt: 1, symbol: 'USD/CHF OTC' }),
    1,
    'after 5-loss wipe next same-pair signal is a fresh chain'
  );
}

{
  const trades = [
    { result: 'WIN', timestamp: 2, attempt: 2, symbol: 'EUR/USD OTC' },
    { result: 'LOSS', timestamp: 1, symbol: 'EUR/USD OTC' }
  ];
  assert.strictEqual(
    step.displayAttempt(trades, { attempt: 1, symbol: 'EUR/USD OTC' }),
    1,
    'after a win the next signal is a fresh chain'
  );
}

{
  const items = [
    { id: 'a', result: 'LOSS', timestamp: 1, symbol: 'USD/CHF OTC' },
    { id: 'b', result: 'LOSS', timestamp: 2, symbol: 'USD/CHF OTC' },
    { id: 'c', result: 'LOSS', timestamp: 3, symbol: 'USD/CHF OTC' },
    { id: 'd', result: 'LOSS', timestamp: 4, symbol: 'USD/CHF OTC' },
    { id: 'e', result: 'LOSS', timestamp: 5, symbol: 'USD/CHF OTC' }
  ];
  const ann = step.annotateSaveSteps(items);
  assert.strictEqual(ann.a.step, 'ENTRY', '1st loss is ENTRY');
  assert.strictEqual(ann.b.step, 'S1', '2nd loss S1');
  assert.strictEqual(ann.c.step, 'S2', '3rd loss S2');
  assert.strictEqual(ann.d.step, 'S3', '4th loss S3');
  assert.strictEqual(ann.e.step, 'S4', '5th loss S4 then wipe');
}

{
  const items = [
    { id: 'l1', result: 'LOSS', timestamp: 1, symbol: 'AUD/NZD OTC' },
    { id: 'l2', result: 'LOSS', timestamp: 2, symbol: 'AUD/NZD OTC' },
    { id: 'l3', result: 'LOSS', timestamp: 3, symbol: 'AUD/NZD OTC' },
    { id: 'w1', result: 'WIN', timestamp: 4, symbol: 'AUD/NZD OTC' },
    { id: 'w2', result: 'WIN', timestamp: 5, symbol: 'AUD/NZD OTC' }
  ];
  const ann = step.annotateSaveSteps(items);
  assert.strictEqual(ann.l1.step, 'ENTRY');
  assert.strictEqual(ann.l2.step, 'S1');
  assert.strictEqual(ann.l3.step, 'S2');
  assert.strictEqual(ann.w1.step, 'S3', 'win after 3 losses is S3');
  assert.strictEqual(ann.w2.step, 'ENTRY', 'next signal after a win is ENTRY');
  assert.strictEqual(step.historyBadge(items[3], ann.w1), 'S3', 'win keeps its step badge');
}

{
  const items = [
    { id: 'l1', result: 'LOSS', timestamp: 1, symbol: 'EUR/GBP OTC' },
    { id: 'w1', result: 'WIN', timestamp: 2, symbol: 'EUR/GBP OTC' }
  ];
  const ann = step.annotateSaveSteps(items);
  assert.strictEqual(ann.l1.step, 'ENTRY', 'first loss is ENTRY');
  assert.strictEqual(ann.w1.step, 'S1', 'win after 1 loss is S1');
}

{
  const items = [
    { id: 'w1', result: 'WIN', timestamp: 1, symbol: 'CAD/CHF OTC' }
  ];
  const ann = step.annotateSaveSteps(items);
  assert.strictEqual(ann.w1.step, 'ENTRY', 'first-try win is ENTRY');
}

{
  const items = [
    { id: 'u1', result: 'LOSS', timestamp: 1, symbol: 'USD/CHF OTC' },
    { id: 'u2', result: 'LOSS', timestamp: 2, symbol: 'USD/CHF OTC' },
    { id: 'u3', result: 'LOSS', timestamp: 3, symbol: 'USD/CHF OTC' },
    { id: 'u4', result: 'LOSS', timestamp: 4, symbol: 'USD/CHF OTC' },
    { id: 'a1', result: 'LOSS', timestamp: 5, symbol: 'AUD/CHF OTC' },
    { id: 'a2', result: 'LOSS', timestamp: 6, symbol: 'AUD/CHF OTC' }
  ];
  const ann = step.annotateSaveSteps(items);
  assert.strictEqual(ann.u1.step, 'ENTRY', 'first loss is ENTRY');
  assert.strictEqual(ann.u4.step, 'S3', 'USD/CHF 4th loss is S3');
  assert.strictEqual(ann.a1.step, 'S4', 'hop after 4 losses is S4');
  assert.strictEqual(ann.a2.step, 'ENTRY', 'after a 5-loss wipe the next loss is ENTRY');
}

{
  const five = [1, 2, 3, 4, 5, 6].map(function (n) {
    return { id: 'x' + n, result: 'LOSS', timestamp: n, symbol: 'EUR/USD OTC' };
  });
  const ann = step.annotateSaveSteps(five);
  assert.strictEqual(ann.x1.step, 'ENTRY');
  assert.strictEqual(ann.x2.step, 'S1');
  assert.strictEqual(ann.x3.step, 'S2');
  assert.strictEqual(ann.x4.step, 'S3');
  assert.strictEqual(ann.x5.step, 'S4');
  assert.strictEqual(ann.x6.step, 'ENTRY', 'after 5 losses the next chain is ENTRY');
}

{
  const badge = step.historyBadge(
    { attempt: 1, savingSignalText: 'Saving Signal 4x' },
    { step: 'ENTRY', attempt: 1 }
  );
  assert.strictEqual(badge, 'ENTRY', 'ENTRY must not pick up a leftover 4x');
}

{
  const items = [
    { id: 'copW', result: 'WIN', openedAtMs: 1, symbol: 'USD/COP OTC' },
    { id: 'nzd1', result: 'LOSS', openedAtMs: 2, symbol: 'EUR/NZD OTC' },
    { id: 'nzd2', result: 'LOSS', openedAtMs: 3, symbol: 'EUR/NZD OTC' },
    { id: 'nzd3', result: 'LOSS', openedAtMs: 4, symbol: 'EUR/NZD OTC' },
    { id: 'copL', result: 'LOSS', openedAtMs: 5, symbol: 'USD/COP OTC' },
    { id: 'gbpW', result: 'WIN', openedAtMs: 6, symbol: 'GBP/AUD OTC' },
    { id: 'egpW', result: 'WIN', openedAtMs: 7, symbol: 'USD/EGP OTC' },
    { id: 'gbp1', result: 'LOSS', openedAtMs: 8, symbol: 'GBP/AUD OTC' },
    { id: 'gbp2', result: 'LOSS', openedAtMs: 9, symbol: 'GBP/AUD OTC' },
    { id: 'yerW', result: 'WIN', openedAtMs: 10, symbol: 'YER/USD OTC' },
    { id: 'chfW', result: 'WIN', openedAtMs: 11, symbol: 'CHF/JPY OTC' }
  ];
  const ann = step.annotateSaveSteps(items);
  assert.strictEqual(ann.copW.step, 'ENTRY', 'first after reset is ENTRY');
  assert.strictEqual(ann.nzd1.step, 'ENTRY', 'first after a win is ENTRY even on LOSS');
  assert.strictEqual(ann.nzd2.step, 'S1');
  assert.strictEqual(ann.nzd3.step, 'S2');
  assert.strictEqual(ann.copL.step, 'S3');
  assert.strictEqual(ann.gbpW.step, 'S4');
  assert.strictEqual(ann.egpW.step, 'ENTRY', 'next after a win is ENTRY');
  assert.strictEqual(ann.gbp1.step, 'ENTRY', 'first after a win is ENTRY even on LOSS');
  assert.strictEqual(ann.gbp2.step, 'S1');
  assert.strictEqual(ann.yerW.step, 'S2');
  assert.strictEqual(ann.chfW.step, 'ENTRY', 'next after a win is ENTRY');
}

{
  const items = [
    { id: 'chf1', result: 'LOSS', attempt: 1, openedAtMs: 1, symbol: 'CHF/JPY OTC' },
    { id: 'chf2', result: 'LOSS', attempt: 2, openedAtMs: 2, symbol: 'CHF/JPY OTC' },
    { id: 'yer1', result: 'LOSS', attempt: 1, openedAtMs: 3, symbol: 'YER/USD OTC' },
    { id: 'yer2', result: 'LOSS', attempt: 2, openedAtMs: 4, symbol: 'YER/USD OTC' },
    { id: 'qar1', result: 'LOSS', attempt: 1, openedAtMs: 5, symbol: 'QAR/CNY OTC' },
    { id: 'qar2', result: 'LOSS', attempt: 2, openedAtMs: 6, symbol: 'QAR/CNY OTC' },
    { id: 'cop1', result: 'WIN', attempt: 1, openedAtMs: 7, symbol: 'USD/COP OTC' }
  ];
  const ann = step.annotateSaveSteps(items, { isolated: true });
  assert.strictEqual(ann.chf1.step, 'ENTRY', 'CHF 1x loss is ENTRY');
  assert.strictEqual(ann.chf2.step, 'S1', 'CHF 2x loss is S1');
  assert.strictEqual(ann.yer1.step, 'ENTRY', 'YER hop is a new ENTRY, not S2');
  assert.strictEqual(ann.yer2.step, 'S1', 'YER 2x is S1, not S3');
  assert.strictEqual(ann.qar1.step, 'ENTRY', 'QAR hop is a new ENTRY');
  assert.strictEqual(ann.qar2.step, 'S1', 'QAR 2x is S1');
  assert.strictEqual(ann.cop1.step, 'ENTRY', 'COP first-try win is ENTRY');
}

console.log('test_saving_step_label: OK');
