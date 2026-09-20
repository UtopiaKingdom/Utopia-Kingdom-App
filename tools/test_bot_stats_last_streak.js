/**
 * Last-streak + live streak: Contabo board is source of truth for live;
 * Contabo /streaks owns completed wipe history.
 * Run: node tools/test_bot_stats_last_streak.js
 */
const assert = require('assert');

function asStreakEntry(raw) {
  if (!raw) return null;
  const length = Math.max(0, parseInt(raw.length, 10) || 0);
  if (length <= 0) return null;
  const endedAt = raw.endedAt != null ? Number(raw.endedAt) : NaN;
  const startedAt = raw.startedAt != null ? Number(raw.startedAt) : NaN;
  return {
    id: raw.id || ('hist__' + length + '__' + (Number.isFinite(endedAt) ? endedAt : 0)),
    length: length,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    endedAt: Number.isFinite(endedAt) ? endedAt : null
  };
}

function completedStreaksFromContabo(persisted, board) {
  const out = [];
  const seen = Object.create(null);

  function add(raw) {
    const entry = asStreakEntry(raw);
    if (!entry) return;
    const key = String(entry.length) + ':' + (Math.round((Number(entry.endedAt) || 0) / 60000));
    if (seen[key]) return;
    seen[key] = 1;
    out.push(entry);
  }

  (persisted || []).forEach(add);
  // Always merge board last — /live updates on wipe faster than /streaks.
  if (board) {
    const boardLen = Math.max(0, parseInt(board.lastCompletedStreak, 10) || 0);
    if (boardLen > 0) {
      add({
        length: boardLen,
        endedAt: board.lastCompletedStreakEndedAt
      });
    }
  }
  out.sort(function (a, b) {
    return (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0);
  });
  return out;
}

function lastStreakToShow(merged) {
  if (!merged || !merged.length) return 0;
  return Math.max(0, parseInt(merged[0].length, 10) || 0);
}

/**
 * Contabo /live board is authoritative when present.
 * Optimistic wins may briefly lead until /live catches up.
 */
function pickLiveStreak(walked, boardStreak, hasResults, opts) {
  const fromWalk = Math.max(0, parseInt(walked, 10) || 0);
  const fromBoard = Math.max(0, parseInt(boardStreak, 10) || 0);
  const boardPresent = !!(opts && opts.boardPresent);

  if (!boardPresent) {
    if (!hasResults) return fromBoard > 0 ? fromBoard : fromWalk;
    return fromWalk;
  }

  const optAhead = Math.max(0, parseInt(opts && opts.optimisticWinDelta, 10) || 0);
  if (optAhead > 0 && fromWalk > fromBoard) {
    return Math.min(fromWalk, fromBoard + optAhead);
  }
  return fromBoard;
}

{
  const merged = completedStreaksFromContabo([{ id: 'server', length: 29, endedAt: 1000 }], null);
  assert.strictEqual(merged[0].length, 29);
  console.log('  ok  Contabo /streaks fills Last');
}

{
  const merged = completedStreaksFromContabo(
    [{ id: 'a', length: 3, endedAt: 2000 }],
    { lastCompletedStreak: 80, lastCompletedStreakEndedAt: 9000 }
  );
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].length, 80);
  console.log('  ok  newer board wipe paints Last before /streaks refresh');
}

{
  const merged = completedStreaksFromContabo([], { lastCompletedStreak: 80, lastCompletedStreakEndedAt: 9000 });
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].length, 80);
  console.log('  ok  board last works when Contabo list empty');
}

{
  const merged = completedStreaksFromContabo(
    [{ id: 'a', length: 80, endedAt: 9000 }],
    { lastCompletedStreak: 80, lastCompletedStreakEndedAt: 9000 }
  );
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].length, 80);
  console.log('  ok  board last dedupes against Contabo row');
}

{
  const merged = [
    { length: 20, endedAt: 5000 },
    { length: 4, endedAt: 15000 }
  ];
  assert.strictEqual(lastStreakToShow(merged), 20);
  console.log('  ok  Last badge always uses newest completed wipe from full history');
}

{
  assert.strictEqual(pickLiveStreak(3, 20, true, { boardPresent: true }), 20);
  console.log('  ok  Contabo board wins over truncated walk');
}

{
  assert.strictEqual(pickLiveStreak(15, 0, true, { boardPresent: true }), 0);
  console.log('  ok  wipe on board zeros lagging walk');
}

{
  assert.strictEqual(
    pickLiveStreak(22, 20, true, { boardPresent: true, optimisticWinDelta: 2 }),
    22
  );
  console.log('  ok  optimistic wins may briefly lead board');
}

{
  assert.strictEqual(
    pickLiveStreak(30, 20, true, { boardPresent: true, optimisticWinDelta: 1 }),
    21
  );
  console.log('  ok  optimistic lead is capped by pending win count');
}

{
  assert.strictEqual(pickLiveStreak(7, 0, true, {}), 7);
  console.log('  ok  walk used when board not present');
}

{
  assert.strictEqual(pickLiveStreak(0, 20, false, { boardPresent: true }), 20);
  console.log('  ok  board used before any local history exists');
}

console.log('all last-streak tests passed');
