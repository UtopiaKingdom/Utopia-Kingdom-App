/**
 * Saving Signals follow the whole WIN/LOSS tape until WIN or 5 losses.
 * Run: node tools/test_saving_signal_history.js
 */
const hist = require('../saving-signal-history.js');

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
  console.log('  ok ', msg);
}

function row(result, extra) {
  return Object.assign({ phase: 'Trading Result', result: result }, extra || {});
}

{
  const trades = [
    row('WIN', { symbol: 'USD/IDR OTC' }),
    row('LOSS', { symbol: 'YER/USD OTC' }),
    row('LOSS', { symbol: 'AUD/CAD OTC' }),
    row('LOSS', { symbol: 'AUD/CAD OTC' }),
    row('LOSS', { symbol: 'USD/EGP OTC' })
  ];
  assertEq(hist.getLossesFromHistory(trades), 0, 'win at head resets ladder');
  assertEq(
    hist.resolveAttempt(trades.slice(1), { attempt: 1, symbol: 'EUR/JPY OTC' }),
    5,
    'new pair after 4 losses continues at S5'
  );
}

{
  const losses = [
    row('LOSS', { symbol: 'YER/USD OTC' }),
    row('LOSS', { symbol: 'AUD/CAD OTC' }),
    row('LOSS', { symbol: 'AUD/CAD OTC' }),
    row('LOSS', { symbol: 'USD/EGP OTC' })
  ];
  assertEq(hist.getLossesFromHistory(losses), 4, 'consecutive losses count across pair hops');
  assertEq(
    hist.getLossesFromHistory(losses, 'AUD/CAD OTC'),
    4,
    'pair argument does not cut the open loss run'
  );
  assertEq(
    hist.resolveAttempt(losses, { attempt: 1, symbol: 'CHF/JPY OTC' }),
    5,
    'hopped pair after 4 losses is S5, not a fresh 1x'
  );
  assertEq(
    hist.resolveAttempt(losses, { attempt: 4, symbol: 'CHF/JPY OTC' }),
    5,
    'stale bot attempt cannot shrink the open loss run'
  );
  assertEq(
    hist.resolveAttempt(losses, { attempt: 2, symbol: 'YER/USD OTC' }),
    5,
    'live attempt follows the whole-tape loss run'
  );
}

{
  const same = [
    row('LOSS', { symbol: 'EUR/JPY OTC' }),
    row('LOSS', { symbol: 'EUR/JPY OTC' }),
    row('LOSS', { symbol: 'EUR/JPY OTC' })
  ];
  assertEq(hist.getLossesFromHistory(same, 'EUR/JPY OTC'), 3, '3 same-pair losses');
  assertEq(
    hist.resolveAttempt(same, { attempt: 1, symbol: 'EUR/JPY OTC' }),
    4,
    'same pair continues the 5-step'
  );
  assertEq(hist.nextAttemptAfterResult(same, row('LOSS', { symbol: 'EUR/JPY OTC' })), 5, '4th loss → next is 5');
  assertEq(hist.nextAttemptAfterResult(same, row('WIN', { symbol: 'EUR/JPY OTC' })), 1, 'win → next 1x');
}

{
  const withReset = [
    { phase: 'Chain Complete', chainComplete: true, chainReset: true, result: 'CHAIN_LOSS', localOnly: true },
    row('LOSS', { symbol: 'AUD/CAD OTC' }),
    row('LOSS', { symbol: 'USD/EGP OTC' })
  ];
  assertEq(hist.getLossesFromHistory(withReset), 2, 'bot Chain Complete after a hop does not wipe the save ladder');
  assertEq(
    hist.resolveAttempt(withReset, { attempt: 1, symbol: 'USD/CLP OTC' }),
    3,
    'next signal after a hop continues the open loss run'
  );
}

{
  const wipe = [
    row('LOSS', { symbol: 'EUR/JPY OTC' }),
    row('LOSS', { symbol: 'EUR/JPY OTC' }),
    row('LOSS', { symbol: 'EUR/JPY OTC' }),
    row('LOSS', { symbol: 'EUR/JPY OTC' }),
    row('LOSS', { symbol: 'EUR/JPY OTC' })
  ];
  assertEq(hist.getLossesFromHistory(wipe), 0, '5-loss wipe resets to 1x');
}

{
  const t0 = Date.parse('2026-08-17T21:34:15Z');
  const overlapping = [
    row('LOSS', { symbol: 'AUD/USD OTC', openedAtMs: t0 + 61000, openingTime: t0 + 61000, closedAtMs: t0 + 91000, closingTime: t0 + 91000 }),
    row('WIN', { symbol: 'AUD/USD OTC', openedAtMs: t0 + 55000, openingTime: t0 + 55000, closedAtMs: t0 + 85000, closingTime: t0 + 85000 }),
    row('LOSS', { symbol: 'AUD/USD OTC', openedAtMs: t0, openingTime: t0, closedAtMs: t0 + 30000, closingTime: t0 + 30000 })
  ];
  assertEq(hist.getLossesFromHistory(overlapping), 0, 'overlapping later LOSS is a ghost; WIN resets ladder');
  const collapsed = hist.collapseOverlappingResults(overlapping);
  assertEq(collapsed.length, 2, 'collapse drops the nested 11:35:16 card');
  assertEq(hist.overlapsAsGhost([overlapping[1]], overlapping[0]), true, '11:35:16 is a ghost of 11:35:10');
}

{
  const t0 = Date.parse('2026-08-17T21:35:10Z');
  const twin = [
    row('LOSS', { symbol: 'AUD/USD OTC', openedAtMs: t0 + 800, openingTime: t0 + 800, closedAtMs: t0 + 30800 }),
    row('WIN', { symbol: 'AUD/USD OTC', openedAtMs: t0, openingTime: t0, closedAtMs: t0 + 30000 })
  ];
  assertEq(hist.getLossesFromHistory(twin), 0, 'same-second clone LOSS cannot bump the ladder after a WIN');
}

{
  const withPayoutStop = [
    { phase: 'Chain Complete', ladderReset: true, chainComplete: true, result: 'PAYOUT_STOP', localOnly: true },
    row('LOSS', { symbol: 'AUD/USD OTC' }),
    row('LOSS', { symbol: 'AUD/CAD OTC' })
  ];
  assertEq(hist.getLossesFromHistory(withPayoutStop), 0, 'payout-stop ladderReset zeros the save count');
}

{
  assertEq(hist.resolveAttempt([], { attempt: 1 }), 1, 'empty history + attempt 1 = 1x');
  assertEq(hist.resolveAttempt([], { attempt: 3 }), 3, 'empty history + live attempt 3 = 3');
  assertEq(hist.resolveAttempt([], {}), 1, 'empty history + missing attempt = 1x');
}

{
  const t0 = Date.parse('2026-08-19T07:28:15Z');
  const stepMs = 181000;
  const chain = [3, 2, 1, 0].map(function (i) {
    const open = t0 + i * stepMs;
    return row('LOSS', {
      symbol: 'AUD/NZD OTC',
      openedAtMs: open,
      openingTime: open,
      closedAtMs: open + 180000,
      closingTime: open + 180000
    });
  });
  assertEq(
    hist.resolveAttempt(chain, chain[0]),
    4,
    '4th loss already in history is S4, not S5'
  );
  const winOpen = t0 + 4 * stepMs;
  const win = row('WIN', {
    symbol: 'AUD/NZD OTC',
    openedAtMs: winOpen,
    openingTime: winOpen,
    closedAtMs: winOpen + 180000,
    closingTime: winOpen + 180000
  });
  assertEq(
    hist.resolveAttempt(chain.slice(1), win),
    4,
    'win after 3 losses (not yet in history) is S4'
  );
  const won = [win].concat(chain.slice(1));
  assertEq(
    hist.resolveAttempt(won, win),
    4,
    'win after 3 losses already in history stays S4'
  );
  assertEq(
    hist.resolveAttempt(won, { attempt: 1, symbol: 'AUD/NZD OTC' }),
    1,
    'next live signal after that win is a fresh 1x'
  );
}

{
  const losses = [
    row('LOSS', { symbol: 'YER/USD OTC' }),
    row('LOSS', { symbol: 'AUD/CAD OTC' }),
    row('LOSS', { symbol: 'USD/EGP OTC' })
  ];
  const iso = { isolated: true };
  assertEq(hist.getLossesFromHistory(losses, 'CHF/JPY OTC', iso), 0, 'isolated hop has no same-pair losses');
  assertEq(
    hist.resolveAttempt(losses, { attempt: 1, symbol: 'CHF/JPY OTC', maxAttempts: 2 }, iso),
    1,
    'MIRAX hop is a fresh 1x, not S4'
  );
  assertEq(
    hist.resolveAttempt(
      [row('LOSS', { symbol: 'EUR/JPY OTC' })],
      { attempt: 2, symbol: 'EUR/JPY OTC', maxAttempts: 2 },
      iso
    ),
    2,
    'MIRAX same-pair save is still 2x'
  );
  assertEq(
    hist.resolveAttempt(
      losses,
      { attempt: 4, symbol: 'CHF/JPY OTC', maxAttempts: 2 },
      iso
    ),
    2,
    'MIRAX cannot size past chain max'
  );
  const hopped = [
    { phase: 'Chain Complete', chainComplete: true, chainReset: true, result: 'CHAIN_LOSS', localOnly: true },
    row('LOSS', { symbol: 'EUR/JPY OTC' }),
    row('LOSS', { symbol: 'EUR/JPY OTC' })
  ];
  assertEq(hist.getLossesFromHistory(hopped, 'AUD/USD OTC', iso), 0, 'isolated Chain Complete resets');
}

{
  const t0 = 1787251831000;
  const tapeOldestFirst = [
    row('WIN', { symbol: 'EUR/CHF OTC', openedAtMs: t0, closedAtMs: t0 + 30000 }),
    row('WIN', { symbol: 'AED/CNY OTC', openedAtMs: t0 + 1200000, closedAtMs: t0 + 1230000 }),
    row('LOSS', { symbol: 'BHD/CNY OTC', openedAtMs: t0 + 2040000, closedAtMs: t0 + 2070000 })
  ];
  assertEq(hist.getLossesFromHistory(tapeOldestFirst), 1, 'oldest-first tape still counts the latest ENTRY loss');
  assertEq(
    hist.resolveAttempt(tapeOldestFirst, { attempt: 1, phase: 'Signal', symbol: 'AED/CNY OTC' }),
    2,
    'after ENTRY loss, next hop signal is S1 not ENTRY'
  );
}

console.log('\nAll saving-signal history tests passed.');
