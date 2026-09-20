#!/usr/bin/env node
/**
 * Replay MIRAX Firebase history with the same walk as bot-stats.js / the app UI.
 *   node tools/mirax_app_today_stats.js
 */
'use strict';

const path = require('path');
const admin = require('firebase-admin');
const hist = require('../saving-signal-history.js');

const ROOT = path.join(__dirname, '..');
admin.initializeApp({ credential: admin.credential.cert(require(path.join(ROOT, 'serviceAccountKey.json'))) });
const db = admin.firestore();

const WIN_BUCKETS = [
  'Entry', 'S1', 'S2', 'S3', 'S4'
];

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e9 && value < 1e12) return value * 1000;
    return value;
  }
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.seconds === 'number') return value.seconds * 1000;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (/^\d{10,17}$/.test(value.trim()) && Number.isFinite(n)) {
      return value.trim().length === 10 ? n * 1000 : n;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function tradeSortMs(t) {
  return (
    toEpochMs(t.timestamp) ??
    toEpochMs(t.openingTime) ??
    toEpochMs(t.closingTime) ??
    toEpochMs(t.createdAt) ??
    0
  );
}

function tradeDayMs(t) {
  return (
    toEpochMs(t.closingTime) ??
    toEpochMs(t.timestamp) ??
    toEpochMs(t.openingTime) ??
    toEpochMs(t.createdAt) ??
    0
  );
}

function tradeAttempt(t) {
  if (t && t.attempt != null && Number.isFinite(Number(t.attempt))) {
    return Math.min(5, Math.max(1, Math.trunc(Number(t.attempt))));
  }
  const id = String((t && t.id) || '');
  const m = /(?:^|__)a(\d+)(?:__|$)/.exec(id);
  if (m) return Math.min(5, Math.max(1, parseInt(m[1], 10) || 1));
  return 1;
}

function canonSymKey(s) {
  return String(s || '').toUpperCase().replace(/OTC/g, '').replace(/[^A-Z0-9]/g, '');
}

function priceKey(v) {
  if (v == null || v === '' || v === 'N/A') return '';
  const n = Number(v);
  if (Number.isFinite(n)) return String(n);
  return String(v);
}

function parseOutcome(t) {
  const res = String((t && t.result) || '').toLowerCase().trim();
  return {
    isWin: res === 'win' || res === 'won' || res === 'success' || res === 'w',
    isLoss: res === 'loss' || res === 'lose' || res === 'lost' || res === 'l'
  };
}

function isResultTrade(t) {
  if (!t) return false;
  const res = String(t.result || '').toLowerCase().trim();
  return ['win', 'won', 'success', 'w', 'loss', 'lose', 'lost', 'l'].indexOf(res) !== -1;
}

function localDayStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return d.getTime();
}

function berlin(ms) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'Europe/Berlin',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function walkStats(ordered, range) {
  const counts = { Entry: 0, S1: 0, S2: 0, S3: 0, S4: 0, Wipes: 0 };
  let winStreak = 0;
  let lossRun = 0;
  const completed = [];
  let streakStartMs = null;
  let dayWins = 0;
  let dayLosses = 0;

  ordered.forEach(function (t) {
    if (!isResultTrade(t)) return;
    const outcome = parseOutcome(t);
    const ts = tradeDayMs(t);
    const inDay = ts >= range.start && ts < range.end;

    if (outcome.isLoss) {
      if (inDay) dayLosses += 1;
      lossRun += 1;
      if (lossRun >= 5) {
        if (winStreak > 0) {
          completed.push({ length: winStreak, startedAt: streakStartMs, endedAt: ts || null });
        }
        if (inDay) counts.Wipes += 1;
        winStreak = 0;
        streakStartMs = null;
        lossRun = 0;
      }
      return;
    }

    if (outcome.isWin) {
      if (inDay) dayWins += 1;
      const derived = Math.min(5, lossRun + 1);
      const stored = tradeAttempt(t);
      const attempt = Math.max(stored, derived);
      lossRun = 0;
      const idx = Math.min(Math.max(0, attempt - 1), 4);
      if (inDay) counts[WIN_BUCKETS[idx]] += 1;
      if (winStreak === 0) streakStartMs = ts || null;
      winStreak += 1;
    }
  });

  return { counts, liveWinStreak: winStreak, completed, dayWins, dayLosses, lossRun };
}

async function loadAll() {
  const col = db.collection('bots/mirax/tradingResults');
  const rows = [];
  let cursor = null;
  for (;;) {
    let q = col.orderBy('timestamp', 'asc').limit(500);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach((doc) => {
      const d = doc.data() || {};
      rows.push({ ...d, id: doc.id });
    });
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }
  return rows;
}

function identityKey(t) {
  const open = Math.trunc(Number(toEpochMs(t.openingTime) || toEpochMs(t.timestamp) || 0));
  const sym = canonSymKey(t.symbol || t.currency || t.selectedCurrency);
  return 'MIRAX|' + sym + '|' + open + '|' + tradeAttempt(t);
}

function priceFp(t) {
  const sym = canonSymKey(t.symbol || t.currency || t.selectedCurrency);
  const res = String(t.result || '').toUpperCase();
  const open = priceKey(t.openingPrice != null ? t.openingPrice : t.openPrice);
  const close = priceKey(t.closingPrice != null ? t.closingPrice : t.closePrice);
  if (!open || !close) return 'id|' + identityKey(t);
  return sym + '|' + res + '|' + open + '|' + close;
}

function dedupe(list) {
  const byKey = Object.create(null);
  list.forEach((t) => {
    if (!isResultTrade(t)) return;
    const key = identityKey(t);
    if (!byKey[key]) byKey[key] = t;
  });
  const identity = Object.keys(byKey).map((k) => byKey[k]);
  const byFp = Object.create(null);
  const extra = [];
  identity.forEach((t) => {
    const fp = priceFp(t);
    const prev = byFp[fp];
    if (!prev) {
      byFp[fp] = t;
      return;
    }
    const dt = Math.abs(tradeSortMs(t) - tradeSortMs(prev));
    if (dt > 20 * 1000) extra.push(t);
  });
  return extra.concat(Object.keys(byFp).map((k) => byFp[k]));
}

(async () => {
  const raw = await loadAll();
  const collapsed = hist.collapseOverlappingResults(dedupe(raw));
  collapsed.sort((a, b) => {
    const da = tradeSortMs(a) - tradeSortMs(b);
    if (da !== 0) return da;
    return String(a.id).localeCompare(String(b.id));
  });

  const now = new Date();
  const start = localDayStart(now);
  const range = { start, end: start + 24 * 60 * 60 * 1000 };
  const allRange = { start: 0, end: Number.MAX_SAFE_INTEGER };

  const today = walkStats(collapsed, range);
  const all = walkStats(collapsed, allRange);

  const todayStreaks = today.completed
    .filter((s) => s.endedAt >= range.start && s.endedAt < range.end)
    .slice()
    .reverse();

  console.log('raw Firebase docs:', raw.length);
  console.log('after app dedupe+ghost collapse:', collapsed.length);
  console.log('');
  console.log('=== TODAY (local, same walk as app) ===');
  console.log(`Entry ${today.counts.Entry}`);
  console.log(`S1    ${today.counts.S1}`);
  console.log(`S2    ${today.counts.S2}`);
  console.log(`S3    ${today.counts.S3}`);
  console.log(`S4    ${today.counts.S4}`);
  console.log(`Wipes ${today.counts.Wipes}`);
  console.log(`Wins  ${today.dayWins}  (bucket sum ${today.counts.Entry + today.counts.S1 + today.counts.S2 + today.counts.S3 + today.counts.S4})`);
  console.log(`day losses ${today.dayLosses}`);
  console.log(`live streak ${today.liveWinStreak}  openLossRun ${today.lossRun}`);
  const chains = today.counts.Entry + today.counts.S1 + today.counts.S2 + today.counts.S3 + today.counts.S4 + today.counts.Wipes;
  const wr1 = chains ? (100 * today.counts.Entry / chains) : 0;
  const chainWr = chains ? (100 * today.dayWins / chains) : 0;
  console.log(`resolved chains today ${chains}  WR1(Entry/chains)=${wr1.toFixed(1)}%  chain WR=${chainWr.toFixed(1)}%`);
  console.log('');
  console.log('today completed streaks (newest first):');
  todayStreaks.forEach((s, i) => {
    console.log(`  ${String(s.length).padStart(3)} wins  ended ${berlin(s.endedAt)}${i === 0 ? '  Latest' : ''}`);
  });
  const sumStreaks = todayStreaks.reduce((a, s) => a + s.length, 0);
  console.log(`streak sum ${sumStreaks} + live ${today.liveWinStreak} = ${sumStreaks + today.liveWinStreak}`);

  console.log('');
  console.log('=== ALL-TIME (same walk) ===');
  console.log(`Entry ${all.counts.Entry}  S1 ${all.counts.S1}  S2 ${all.counts.S2}  S3 ${all.counts.S3}  S4 ${all.counts.S4}`);
  console.log(`Wipes ${all.counts.Wipes}  Wins ${all.dayWins}  losses ${all.dayLosses}`);
  const allChains = all.counts.Entry + all.counts.S1 + all.counts.S2 + all.counts.S3 + all.counts.S4 + all.counts.Wipes;
  console.log(`chains ${allChains}  WR1=${allChains ? (100 * all.counts.Entry / allChains).toFixed(1) : 'n/a'}%  chain WR=${allChains ? (100 * all.dayWins / allChains).toFixed(1) : 'n/a'}%`);
  console.log(`live ${all.liveWinStreak}`);
  const lens = all.completed.map((s) => s.length).sort((a, b) => b - a);
  console.log(`completed streaks ${all.completed.length}  best ${lens[0] || 0}  median ${lens[Math.floor(lens.length / 2)] || 0}`);
  console.log('lengths:', lens.join(', '));

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
