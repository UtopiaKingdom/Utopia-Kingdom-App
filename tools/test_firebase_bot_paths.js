/**
 * Unit tests for firebase-bot-paths live-board math (no Firebase).
 *   node tools/test_firebase_bot_paths.js
 */
'use strict';

const path = require('path');
const store = require(path.join(__dirname, '..', 'firebase-bot-paths.js'));

let failed = 0;
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    failed += 1;
    console.error('FAIL', msg, { actual, expected });
  } else {
    console.log('ok', msg);
  }
}

function play(results) {
  let board = store.emptyLiveBoard('LUMIX');
  const completed = [];
  results.forEach((r, i) => {
    const spec = typeof r === 'string' ? { result: r } : r;
    const out = store.applyResultToBoard(board, {
      result: spec.result,
      attempt: spec.attempt,
      endedAt: 1_000_000 + i * 1000,
      startedAt: 1_000_000,
      pair: spec.pair || 'EUR/USD OTC',
      tradeId: 't' + i,
    });
    board = out.board;
    if (out.completedStreak) completed.push(out.completedStreak.length);
  });
  return { board, completed };
}

assertEq(store.botSlug('NYX'), 'nyx', 'slug nyx');
assertEq(store.normalizeBotKey('nyx'), 'NYX', 'normalize nyx');
assertEq(store.boardPathString('MIRAX'), 'bots/mirax', 'mirax board path');
assertEq(store.tradingResultsPathString('LUMIX'), 'bots/lumix/tradingResults', 'lumix results path');
assertEq(store.pastWinStreaksPathString('MIRAX'), 'bots/mirax/pastWinStreaks', 'mirax streaks path');
assertEq(store.stepAttempt(2, 1), 3, 'hop after 2 losses is S2 not Entry');
assertEq(store.stepAttemptFromBoard({ consecutiveLosses: 4 }, 'WIN', 1), 5, 'board hop after 4 losses is S4');

let r = play(['WIN', 'WIN', { result: 'LOSS', attempt: 1 }, { result: 'LOSS', attempt: 2 }]);
assertEq(r.board.currentWinStreak, 2, 'MG losses do not reset win streak');
assertEq(r.board.consecutiveLosses, 2, 'loss streak counts MG steps');
assertEq(r.completed.length, 0, 'no completed streak before wipe');

r = play([
  'WIN', 'WIN', 'WIN',
  { result: 'LOSS', attempt: 1 },
  { result: 'LOSS', attempt: 2 },
  { result: 'LOSS', attempt: 3 },
  { result: 'LOSS', attempt: 4 },
  { result: 'LOSS', attempt: 5 },
]);
assertEq(r.board.currentWinStreak, 0, 'wipe resets live streak');
assertEq(r.board.consecutiveLosses, 0, 'wipe clears loss counter');
assertEq(r.completed.join(','), '3', 'wipe records completed streak of 3');
assertEq(r.board.lastCompletedStreak, 3, 'board lastCompletedStreak');

r = play([
  'WIN',
  { result: 'LOSS', attempt: 1 },
  { result: 'LOSS', attempt: 2 },
  { result: 'LOSS', attempt: 3 },
  { result: 'LOSS', attempt: 4 },
  { result: 'LOSS', attempt: 5 },
  'WIN',
]);
assertEq(r.board.currentWinStreak, 1, 'fresh streak after wipe');
assertEq(r.completed.join(','), '1', 'wipe saved the 1-win streak');

r = play(['WIN', 'WIN', 'WIN',
  { result: 'LOSS', attempt: 1, pair: 'EUR/USD OTC' },
  { result: 'LOSS', attempt: 1, pair: 'GBP/USD OTC' },
  { result: 'LOSS', attempt: 1, pair: 'USD/JPY OTC' },
  { result: 'LOSS', attempt: 1, pair: 'AUD/USD OTC' },
  { result: 'LOSS', attempt: 1, pair: 'NZD/USD OTC' },
]);
assertEq(r.board.currentWinStreak, 0, 'five losses in a row wipe the win streak');
assertEq(r.completed.join(','), '3', '5-loss run records the completed streak');

{
  const trades = [];
  for (let i = 0; i < 22; i++) trades.push({ result: 'WIN', timestamp: 1000 + i, id: 'w' + i });
  for (let i = 0; i < 5; i++) trades.push({ result: 'LOSS', timestamp: 2000 + i, id: 'l' + i });
  trades.push({ result: 'WIN', timestamp: 3000, id: 'after' });
  const rec = store.recountFromHistory('MIRAX', trades);
  assertEq(rec.board.currentWinStreak, 1, 'recount live streak after wipe + 1 win');
  assertEq(rec.completedStreaks.length, 1, 'recount one completed streak');
  assertEq(rec.completedStreaks[0].length, 22, 'recount keeps the full 22-win run');
  assertEq(rec.board.lastCompletedStreak, 22, 'recount lastCompletedStreak');
}

const id = store.buildReadableTradeId({
  openMs: Date.UTC(2026, 7, 15, 0, 12, 3),
  pair: 'EUR/USD OTC',
  result: 'WIN',
  attempt: 1,
});
if (!/20260815-001203Z__EURUSD_OTC__WIN__a1__/.test(id)) {
  failed += 1;
  console.error('FAIL readable trade id', id);
} else {
  console.log('ok readable trade id', id);
}

const sid = store.buildStreakDocId({ endedAt: Date.UTC(2026, 7, 15, 3, 30, 0), length: 12 });
assertEq(sid, '20260815-033000Z__12-wins', 'readable streak id');

{
  let daily = store.emptyDailyStats('LUMIX', '2026-08-19');
  daily = store.applyResultToDailyStats(daily, { bot: 'LUMIX', dateKey: '2026-08-19', result: 'WIN', attempt: 1 });
  daily = store.applyResultToDailyStats(daily, { bot: 'LUMIX', dateKey: '2026-08-19', result: 'WIN', attempt: 2 });
  daily = store.applyResultToDailyStats(daily, { bot: 'LUMIX', dateKey: '2026-08-19', result: 'LOSS', wiped: false });
  daily = store.applyResultToDailyStats(daily, { bot: 'LUMIX', dateKey: '2026-08-19', result: 'LOSS', wiped: true });
  assertEq(daily.entry, 1, 'daily entry win');
  assertEq(daily.s1, 1, 'daily s1 win');
  assertEq(daily.wins, 2, 'daily wins');
  assertEq(daily.wipes, 1, 'daily wipe on 5th loss');
  assertEq(daily.losses, 2, 'daily losses');
}

{
  const start = Date.UTC(2026, 7, 18, 22, 0, 0);
  const end = start + 24 * 3600 * 1000;
  const trades = [
    { result: 'WIN', attempt: 1, timestamp: start - 1000, closedAtMs: start - 500, id: 'yest' },
    { result: 'WIN', attempt: 1, timestamp: start + 1000, closedAtMs: start + 2000, id: 'a' },
    { result: 'LOSS', attempt: 1, timestamp: start + 3000, closedAtMs: start + 4000, id: 'l0' },
    { result: 'LOSS', attempt: 1, timestamp: start + 5000, closedAtMs: start + 6000, id: 'l1' },
    { result: 'WIN', attempt: 1, timestamp: start + 7000, closedAtMs: start + 8000, id: 'hop' },
    { result: 'LOSS', timestamp: start + 9000, closedAtMs: start + 10000, id: 'w1' },
    { result: 'LOSS', timestamp: start + 11000, closedAtMs: start + 12000, id: 'w2' },
    { result: 'LOSS', timestamp: start + 13000, closedAtMs: start + 14000, id: 'w3' },
    { result: 'LOSS', timestamp: start + 15000, closedAtMs: start + 16000, id: 'w4' },
    { result: 'LOSS', timestamp: start + 17000, closedAtMs: start + 18000, id: 'w5' },
  ];
  const rec = store.recountDailyStats('MIRAX', trades, '2026-08-19', { start, end });
  assertEq(rec.entry, 1, 'recount ignores yesterday win');
  assertEq(rec.s2, 1, 'hop win after 2 losses is S2 even if stored attempt is 1');
  assertEq(rec.wins, 2, 'recount today wins');
  assertEq(rec.wipes, 1, 'recount today wipe');
}

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
