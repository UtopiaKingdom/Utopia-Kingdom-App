/**
 * firebase-bot-paths.js
 * Shared Firestore layout + live win-streak board math.
 *
 * Console layout (easy to find):
 *   bots/lumix                         live win streak for Lumix
 *     tradingResults/{readableId}      that bot's WIN/LOSS history
 *     pastWinStreaks/{readableId}      completed streaks after a 5-loss wipe
 *     dailyStats/{YYYY-MM-DD}          Berlin-day Entry/S1–S4/Wipes/Wins
 *   bots/mirax                         same for Mirax
 *
 * Used by signal-writer (Admin SDK) and the Electron app (client SDK).
 */
'use strict';

const BOTS_COLLECTION = 'bots';
const TRADING_RESULTS = 'tradingResults';
const PAST_WIN_STREAKS = 'pastWinStreaks';
const DAILY_STATS = 'dailyStats';
const DAILY_BUCKETS = ['entry', 's1', 's2', 's3', 's4'];

const DISPLAY_NAME = { LUMIX: 'Lumix', MIRAX: 'Mirax', NYX: 'Nyx' };

function normalizeBotKey(bot) {
  const key = String(bot || '').trim().toUpperCase();
  if (key === 'LUMIX' || key === 'MIRAX' || key === 'NYX') return key;
  return '';
}

function botSlug(botKey) {
  const key = normalizeBotKey(botKey);
  return key ? key.toLowerCase() : '';
}

function isValidBotSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  return s === 'lumix' || s === 'mirax' || s === 'nyx';
}

function safeKey(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function canonCurrencyKey(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  const isOtc = /\bOTC\b/.test(upper);
  const base = upper.replace(/\bOTC\b/g, '').replace(/[\s/\\_-]+/g, '').trim();
  if (!base) return upper;
  return isOtc ? `${base}_OTC` : base;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** UTC stamp for readable, stable document ids: 20260815-001203Z */
function formatUtcStamp(ms) {
  const n = Math.trunc(Number(ms) || 0);
  const d = new Date(n > 0 ? n : Date.now());
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

function boardPath(botKey) {
  return [BOTS_COLLECTION, botSlug(botKey)];
}

function tradingResultsPath(botKey) {
  return [BOTS_COLLECTION, botSlug(botKey), TRADING_RESULTS];
}

function pastWinStreaksPath(botKey) {
  return [BOTS_COLLECTION, botSlug(botKey), PAST_WIN_STREAKS];
}

function dailyStatsPath(botKey, dateKey) {
  return [BOTS_COLLECTION, botSlug(botKey), DAILY_STATS, String(dateKey || '').trim()];
}

function boardPathString(botKey) {
  return boardPath(botKey).join('/');
}

function tradingResultsPathString(botKey) {
  return tradingResultsPath(botKey).join('/');
}

function pastWinStreaksPathString(botKey) {
  return pastWinStreaksPath(botKey).join('/');
}

function dailyStatsPathString(botKey, dateKey) {
  return dailyStatsPath(botKey, dateKey).join('/');
}

function emptyDailyStats(botKey, dateKey) {
  const bot = normalizeBotKey(botKey);
  return {
    bot: bot,
    date: String(dateKey || '').trim(),
    timezone: 'Europe/Berlin',
    entry: 0,
    s1: 0,
    s2: 0,
    s3: 0,
    s4: 0,
    wipes: 0,
    wins: 0,
    losses: 0,
    updatedAt: 0,
  };
}

function clampAttempt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, Math.trunc(n)));
}

function stepAttempt(lossRun, storedAttempt) {
  const derived = Math.min(5, Math.max(0, Number(lossRun) || 0) + 1);
  return Math.max(clampAttempt(storedAttempt), derived);
}

function stepAttemptFromBoard(prevBoard, result, storedAttempt) {
  if (String(result || '').toUpperCase() !== 'WIN') return clampAttempt(storedAttempt);
  return stepAttempt(Number(prevBoard && prevBoard.consecutiveLosses) || 0, storedAttempt);
}

function applyResultToDailyStats(prev, opts) {
  const bot = normalizeBotKey((prev && prev.bot) || (opts && opts.bot));
  const dateKey = String((opts && opts.dateKey) || (prev && prev.date) || '').trim();
  const stats = Object.assign(emptyDailyStats(bot, dateKey), prev || {});
  const result = String((opts && opts.result) || '').trim().toUpperCase();
  if (result === 'WIN') {
    stats.wins = (Number(stats.wins) || 0) + 1;
    const bucket = DAILY_BUCKETS[clampAttempt(opts && opts.attempt) - 1];
    if (bucket) stats[bucket] = (Number(stats[bucket]) || 0) + 1;
  } else if (result === 'LOSS') {
    stats.losses = (Number(stats.losses) || 0) + 1;
    if (opts && opts.wiped) stats.wipes = (Number(stats.wipes) || 0) + 1;
  }
  stats.bot = bot;
  stats.date = dateKey;
  stats.timezone = 'Europe/Berlin';
  stats.updatedAt = Date.now();
  return stats;
}

function emptyLiveBoard(botKey) {
  const bot = normalizeBotKey(botKey);
  const name = DISPLAY_NAME[bot] || bot;
  return {
    bot,
    displayName: name,
    section: name,
    whatIsThis:
      `${name} live board. Subcollections: tradingResults (history) and pastWinStreaks (completed win streaks after a 5-loss wipe).`,
    currentWinStreak: 0,
    currentStreakStartedAt: null,
    consecutiveLosses: 0,
    lastCompletedStreak: 0,
    lastCompletedStreakEndedAt: null,
    lastResult: null,
    lastPair: null,
    lastTradeId: null,
    updatedAt: 0,
  };
}

/**
 * Win streak = consecutive WIN results.
 * It ends only after 5 LOSS results in a row. A WIN in between resets the loss run.
 */
function applyResultToBoard(prev, opts) {
  const bot = normalizeBotKey((prev && prev.bot) || (opts && opts.bot));
  const board = Object.assign(emptyLiveBoard(bot), prev || {});
  const result = String((opts && opts.result) || '').trim().toUpperCase();
  const endedAt = Math.trunc(Number(opts && opts.endedAt) || Date.now());
  const startedAt = Math.trunc(Number(opts && opts.startedAt) || endedAt);
  const pair = (opts && opts.pair) || board.lastPair || null;
  const tradeId = (opts && opts.tradeId) || board.lastTradeId || null;
  let completedStreak = null;
  let wiped = false;

  if (result === 'WIN') {
    board.consecutiveLosses = 0;
    if (!(Number(board.currentWinStreak) > 0)) {
      board.currentStreakStartedAt = startedAt;
    }
    board.currentWinStreak = (Number(board.currentWinStreak) || 0) + 1;
  } else if (result === 'LOSS') {
    board.consecutiveLosses = (Number(board.consecutiveLosses) || 0) + 1;
    if (board.consecutiveLosses >= 5) {
      wiped = true;
      const length = Number(board.currentWinStreak) || 0;
      if (length > 0) {
        completedStreak = {
          length,
          startedAt: board.currentStreakStartedAt != null ? Number(board.currentStreakStartedAt) : null,
          endedAt,
        };
        board.lastCompletedStreak = length;
        board.lastCompletedStreakEndedAt = endedAt;
      }
      board.currentWinStreak = 0;
      board.currentStreakStartedAt = null;
      board.consecutiveLosses = 0;
    }
  }

  board.bot = bot;
  board.displayName = DISPLAY_NAME[bot] || bot;
  board.section = board.displayName;
  board.lastResult = result || board.lastResult;
  board.lastPair = pair;
  board.lastTradeId = tradeId;
  board.updatedAt = Date.now();
  return { board, completedStreak, wiped };
}

function buildReadableTradeId(opts) {
  const openMs = Math.trunc(Number(opts && opts.openMs) || Date.now());
  const result = String((opts && opts.result) || 'NA').trim().toUpperCase();
  const pairKey = safeKey(canonCurrencyKey((opts && opts.pair) || '') || 'PAIR');
  const attempt = Number.isFinite(Number(opts && opts.attempt))
    ? Math.max(1, Math.trunc(Number(opts.attempt)))
    : 1;
  return `${formatUtcStamp(openMs)}__${pairKey}__${result}__a${attempt}__${openMs}`;
}

function buildAltTradeId(opts) {
  const openMs = Math.trunc(Number(opts && opts.openMs) || Date.now());
  const pairKey = safeKey(canonCurrencyKey((opts && opts.pair) || '') || 'PAIR');
  const attempt = Number.isFinite(Number(opts && opts.attempt))
    ? Math.max(1, Math.trunc(Number(opts.attempt)))
    : 1;
  return `${formatUtcStamp(openMs)}__${pairKey}__a${attempt}__${openMs}`;
}

function buildStreakDocId(streak) {
  const endedAt = Math.trunc(Number(streak && streak.endedAt) || Date.now());
  const length = Math.max(0, parseInt(streak && streak.length, 10) || 0);
  return `${formatUtcStamp(endedAt)}__${length}-wins`;
}

function tradeDisplayTitle(pair, result, attempt) {
  const p = String(pair || '').trim() || 'Pair';
  const r = String(result || '').trim().toUpperCase() || 'RESULT';
  const a = Number.isFinite(Number(attempt)) ? Math.max(1, Math.trunc(Number(attempt))) : 1;
  return `${p} · ${r} · attempt ${a}`;
}

function tradeTimeMs(t, keys) {
  for (let i = 0; i < keys.length; i++) {
    const n = Number(t && t[keys[i]]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** Replay every WIN/LOSS in time order. Source of truth for live streak + completed streaks. */
function recountFromHistory(botKey, trades) {
  const bot = normalizeBotKey(botKey);
  let state = emptyLiveBoard(bot);
  const completedStreaks = [];
  const list = (trades || []).slice().sort(function (a, b) {
    const ta = tradeTimeMs(a, ['timestamp', 'openingTime', 'openedAtMs', 'createdAt']);
    const tb = tradeTimeMs(b, ['timestamp', 'openingTime', 'openedAtMs', 'createdAt']);
    if (ta !== tb) return ta - tb;
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
  });
  list.forEach(function (t) {
    const result = String((t && t.result) || '').trim().toUpperCase();
    if (result !== 'WIN' && result !== 'LOSS') return;
    const startedAt = tradeTimeMs(t, ['openedAtMs', 'openingTime', 'timestamp']) || Date.now();
    const endedAt = tradeTimeMs(t, ['closedAtMs', 'closingTime', 'timestamp']) || startedAt;
    const out = applyResultToBoard(state, {
      bot: bot,
      result: result,
      endedAt: endedAt,
      startedAt: startedAt,
      pair: (t && (t.symbol || t.selectedCurrency || t.currency)) || null,
      tradeId: (t && t.id) || null,
      attempt: t && t.attempt,
    });
    state = out.board;
    if (out.completedStreak) completedStreaks.push(out.completedStreak);
  });
  return { board: state, completedStreaks: completedStreaks };
}

function tradeCloseMs(t) {
  return tradeTimeMs(t, ['closedAtMs', 'closingTime', 'timestamp', 'openedAtMs', 'openingTime', 'createdAt']);
}

function tradeAttemptOf(t) {
  if (t && t.attempt != null && Number.isFinite(Number(t.attempt))) {
    return clampAttempt(t.attempt);
  }
  const id = String((t && t.id) || '');
  const m = /(?:^|__)a(\d+)(?:__|$)/.exec(id);
  if (m) return clampAttempt(m[1]);
  return 1;
}

/**
 * Day buckets (Entry/S1–S4/Wipes/Wins) for one Berlin calendar day.
 * Walks the full tape so a wipe that started yesterday still counts today.
 */
function recountDailyStats(botKey, trades, dateKey, range) {
  const bot = normalizeBotKey(botKey);
  const stats = emptyDailyStats(bot, dateKey);
  const list = (trades || []).slice().sort(function (a, b) {
    const ta = tradeTimeMs(a, ['timestamp', 'openingTime', 'openedAtMs', 'createdAt']);
    const tb = tradeTimeMs(b, ['timestamp', 'openingTime', 'openedAtMs', 'createdAt']);
    if (ta !== tb) return ta - tb;
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
  });
  let lossRun = 0;
  const start = range && Number(range.start);
  const end = range && Number(range.end);
  list.forEach(function (t) {
    const result = String((t && t.result) || '').trim().toUpperCase();
    if (result !== 'WIN' && result !== 'LOSS') return;
    const ts = tradeCloseMs(t);
    const inDay = Number.isFinite(start) && Number.isFinite(end) ? (ts >= start && ts < end) : true;
    if (result === 'LOSS') {
      if (inDay) stats.losses += 1;
      lossRun += 1;
      if (lossRun >= 5) {
        if (inDay) stats.wipes += 1;
        lossRun = 0;
      }
      return;
    }
    const derived = Math.min(5, lossRun + 1);
    const attempt = Math.max(tradeAttemptOf(t), derived);
    lossRun = 0;
    if (inDay) {
      stats.wins += 1;
      const bucket = DAILY_BUCKETS[attempt - 1];
      if (bucket) stats[bucket] += 1;
    }
  });
  stats.updatedAt = Date.now();
  return stats;
}

module.exports = {
  BOTS_COLLECTION,
  TRADING_RESULTS,
  PAST_WIN_STREAKS,
  DAILY_STATS,
  DISPLAY_NAME,
  normalizeBotKey,
  botSlug,
  isValidBotSlug,
  boardPath,
  tradingResultsPath,
  pastWinStreaksPath,
  dailyStatsPath,
  boardPathString,
  tradingResultsPathString,
  pastWinStreaksPathString,
  dailyStatsPathString,
  emptyLiveBoard,
  emptyDailyStats,
  applyResultToBoard,
  applyResultToDailyStats,
  recountFromHistory,
  recountDailyStats,
  stepAttempt,
  stepAttemptFromBoard,
  buildReadableTradeId,
  buildAltTradeId,
  buildStreakDocId,
  tradeDisplayTitle,
  formatUtcStamp,
  canonCurrencyKey,
  safeKey,
};
