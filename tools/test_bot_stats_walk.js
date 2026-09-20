/**
 * Unit tests for win-streak walk + open-identity dedupe (no DOM / Firebase).
 * Run: node tools/test_bot_stats_walk.js
 */

function tradeOpenIdentity(t) {
  const bot = String((t && t.bot) || '').toUpperCase();
  const open = Math.trunc(Number((t && (t.openingTime || t.timestamp)) || 0) || 0);
  const sym = String((t && (t.symbol || t.currency || t.selectedCurrency)) || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  let attempt = 1;
  if (t && t.attempt != null && Number.isFinite(Number(t.attempt))) {
    attempt = Math.max(1, Math.trunc(Number(t.attempt)));
  } else {
    const m = String((t && t.id) || '').match(/__a(\d+)$/);
    if (m) attempt = Math.max(1, parseInt(m[1], 10) || 1);
  }
  return bot + '|' + sym + '|' + open + '|' + attempt;
}

function dedupeResultTrades(list) {
  const byKey = Object.create(null);
  list.forEach(function (t) {
    const res = String((t && t.result) || '').toUpperCase();
    if (res !== 'WIN' && res !== 'LOSS' && res !== 'W' && res !== 'L') return;
    const key = tradeOpenIdentity(t);
    const prev = byKey[key];
    if (!prev) {
      byKey[key] = t;
      return;
    }
    if (prev.optimistic && !t.optimistic) {
      byKey[key] = t;
      return;
    }
    if (!prev.optimistic && t.optimistic) return;
  });
  return Object.keys(byKey).map(function (k) { return byKey[k]; });
}

function walkStats(trades) {
  let winStreak = 0;
  let lossRun = 0;
  const completed = [];
  for (const t of trades) {
    const res = String(t.result || '').toUpperCase();
    if (res === 'LOSS' || res === 'L') {
      lossRun += 1;
      if (lossRun >= 5) {
        if (winStreak > 0) completed.push(winStreak);
        winStreak = 0;
        lossRun = 0;
      }
      continue;
    }
    if (res === 'WIN' || res === 'W') {
      lossRun = 0;
      winStreak += 1;
    }
  }
  return { liveWinStreak: winStreak, completed };
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
  console.log('  ok ', msg);
}

// MG losses do not break streak
{
  const r = walkStats([
    { result: 'WIN' },
    { result: 'LOSS' },
    { result: 'LOSS' },
    { result: 'WIN' },
  ]);
  assertEq(r.liveWinStreak, 2, 'MG losses do not reset win streak');
  assertEq(r.completed.length, 0, 'no completed streak without wipe');
}

// 5 losses end streak and record completed
{
  const r = walkStats([
    { result: 'WIN' },
    { result: 'WIN' },
    { result: 'WIN' },
    { result: 'LOSS', attempt: 1 },
    { result: 'LOSS', attempt: 2 },
    { result: 'LOSS', attempt: 3 },
    { result: 'LOSS', attempt: 4 },
    { result: 'LOSS', attempt: 5 },
  ]);
  assertEq(r.liveWinStreak, 0, 'wipe resets live streak');
  assertEq(r.completed[0], 3, 'completed length is pre-wipe wins');
}

// win after wipe starts fresh
{
  const r = walkStats([
    { result: 'WIN' },
    { result: 'LOSS', attempt: 1 },
    { result: 'LOSS', attempt: 2 },
    { result: 'LOSS', attempt: 3 },
    { result: 'LOSS', attempt: 4 },
    { result: 'LOSS', attempt: 5 },
    { result: 'WIN' },
  ]);
  assertEq(r.liveWinStreak, 1, 'fresh streak after wipe');
  assertEq(r.completed[0], 1, 'first streak completed at wipe');
}

{
  const r = walkStats([
    { result: 'WIN' }, { result: 'WIN' }, { result: 'WIN' },
    { result: 'WIN' }, { result: 'WIN' }, { result: 'WIN' },
    { result: 'LOSS', attempt: 1, symbol: 'EUR/USD' },
    { result: 'LOSS', attempt: 1, symbol: 'GBP/USD' },
    { result: 'LOSS', attempt: 1, symbol: 'AUD/USD' },
    { result: 'LOSS', attempt: 1, symbol: 'USD/CAD' },
    { result: 'LOSS', attempt: 1, symbol: 'USD/JPY' },
  ]);
  assertEq(r.liveWinStreak, 0, 'five save-ladder losses in a row end the streak');
  assertEq(r.completed[0], 6, 'completed length is wins before the 5-loss run');
}

{
  const r = walkStats([
    { result: 'WIN' }, { result: 'WIN' }, { result: 'WIN' },
    { result: 'LOSS' }, { result: 'LOSS' }, { result: 'LOSS' }, { result: 'LOSS' },
    { result: 'WIN' },
  ]);
  assertEq(r.liveWinStreak, 4, 'four losses do not end the win streak');
  assertEq(r.completed.length, 0, 'no completed streak without 5 in a row');
}

// Optimistic + Firebase close-id must share open identity
{
  const open = 1700000000000;
  const opt = {
    id: 'optimistic__LUMIX__EURUSDOTC__' + open + '__a1',
    bot: 'LUMIX',
    symbol: 'EURUSD_otc',
    openingTime: open,
    attempt: 1,
    result: 'WIN',
    optimistic: true,
  };
  const confirmed = {
    id: 'LUMIX__EURUSD_otc__' + open + '__' + (open + 60000),
    bot: 'LUMIX',
    symbol: 'EURUSD_otc',
    openingTime: open,
    attempt: 1,
    result: 'WIN',
    optimistic: false,
  };
  assertEq(tradeOpenIdentity(opt), tradeOpenIdentity(confirmed), 'optimistic matches confirmed open identity');
  const deduped = dedupeResultTrades([opt, confirmed]);
  assertEq(deduped.length, 1, 'dedupe keeps one row');
  assertEq(!!deduped[0].optimistic, false, 'dedupe prefers confirmed over optimistic');
}

// Same ticket with disagreeing attempts (live S3 vs tape Entry) must count once.
{
  const open = 1787353168000;
  const live = {
    id: 'optimistic__NYX__USDCHF__' + open + '__a4',
    bot: 'NYX',
    symbol: 'USD/CHF OTC',
    openedAtMs: open,
    openingTime: open,
    attempt: 4,
    result: 'WIN',
    optimistic: true,
  };
  const tape = {
    id: '20260821-225928Z__USDCHF_OTC__WIN__a1__' + open,
    bot: 'NYX',
    symbol: 'USD/CHF OTC',
    openedAtMs: open,
    openingTime: open,
    attempt: 1,
    result: 'WIN',
    optimistic: false,
  };
  function fillId(t) {
    const sym = String(t.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return t.bot + '|' + sym + '|' + t.openedAtMs;
  }
  function prefer(a, b) {
    if (a.optimistic && !b.optimistic) return b;
    if (!a.optimistic && b.optimistic) return a;
    return a;
  }
  function dedupeFill(list) {
    const byFill = Object.create(null);
    list.forEach(function (t) {
      const k = fillId(t);
      byFill[k] = byFill[k] ? prefer(byFill[k], t) : t;
    });
    return Object.keys(byFill).map(function (k) { return byFill[k]; });
  }
  const d = dedupeFill([live, tape]);
  assertEq(d.length, 1, 'a1 tape + a4 live collapse to one fill');
  assertEq(d[0].attempt, 1, 'confirmed tape attempt wins over live saving attempt');
}

// Double-count regression: without dedupe streak would be 2
{
  const open = 1700000001000;
  const opt = {
    bot: 'LUMIX',
    symbol: 'GBPUSD',
    openingTime: open,
    attempt: 1,
    result: 'WIN',
    optimistic: true,
  };
  const confirmed = {
    bot: 'LUMIX',
    symbol: 'GBPUSD',
    openingTime: open,
    attempt: 1,
    result: 'WIN',
    optimistic: false,
  };
  const r = walkStats(dedupeResultTrades([opt, confirmed]));
  assertEq(r.liveWinStreak, 1, 'streak counts once after optimistic+confirmed');
}

function walkWinBuckets(trades) {
  const buckets = [0, 0, 0, 0, 0];
  let lossRun = 0;
  for (const t of trades) {
    const res = String(t.result || '').toUpperCase();
    if (res === 'LOSS' || res === 'L') {
      lossRun += 1;
      if (lossRun >= 5) lossRun = 0;
      continue;
    }
    if (res === 'WIN' || res === 'W') {
      const stored = Number.isFinite(Number(t.attempt)) ? Math.max(1, Math.trunc(Number(t.attempt))) : 1;
      const derived = Math.min(5, lossRun + 1);
      const attempt = Math.max(stored, derived);
      buckets[Math.min(Math.max(0, attempt - 1), 4)] += 1;
      lossRun = 0;
    }
  }
  return buckets;
}

// Live saving: 4 losses then a hop win is S4 (1x + 4 saves).
{
  const b = walkWinBuckets([
    { result: 'LOSS', attempt: 1, symbol: 'USD/EGP OTC' },
    { result: 'LOSS', attempt: 1, symbol: 'AUD/CAD OTC' },
    { result: 'LOSS', attempt: 1, symbol: 'AUD/CAD OTC' },
    { result: 'LOSS', attempt: 1, symbol: 'YER/USD OTC' },
    { result: 'WIN', attempt: 1, symbol: 'USD/IDR OTC' }
  ]);
  assertEq(b[0], 0, 'pair-switch recovery is not an Entry win');
  assertEq(b[4], 1, 'win after 4 losses counts as S4');
}

{
  const b = walkWinBuckets([
    { result: 'WIN', attempt: 1 }
  ]);
  assertEq(b[0], 1, 'clean win is Entry');
}

console.log('\nAll bot-stats walk tests passed.');
