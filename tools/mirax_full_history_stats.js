#!/usr/bin/env node
/**
 * Full MIRAX Firebase history stats.
 *   node tools/mirax_full_history_stats.js
 */
'use strict';

const path = require('path');
const admin = require('firebase-admin');
const botStore = require('../firebase-bot-paths.js');

const ROOT = path.join(__dirname, '..');
admin.initializeApp({ credential: admin.credential.cert(require(path.join(ROOT, 'serviceAccountKey.json'))) });
const db = admin.firestore();

const TZ = 2 * 3600 * 1000; // Europe/Berlin summer UTC+2
const PAGE = 500;

function toMs(t) {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t === 'object' && typeof t.seconds === 'number') return t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6);
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

function berlin(ms) {
  if (!ms) return 'n/a';
  return new Date(ms + TZ).toISOString().replace('T', ' ').slice(0, 19);
}

function berlinDay(ms) {
  return new Date(ms + TZ).toISOString().slice(0, 10);
}

function attOf(t) {
  if (t.attempt != null && Number.isFinite(Number(t.attempt))) {
    return Math.min(5, Math.max(1, Math.trunc(Number(t.attempt))));
  }
  const id = String(t._id || t.id || '');
  const m = /(?:^|__)a(\d+)(?:__|$)/.exec(id);
  if (m) return Math.min(5, Math.max(1, parseInt(m[1], 10) || 1));
  if (t.martingaleStep != null) return Math.min(5, Math.max(1, Number(t.martingaleStep)));
  if (t.stakeMultiplier != null) {
    const map = { 1: 1, 2: 2, 4: 3, 10: 4, 20: 5 };
    const n = Number(t.stakeMultiplier);
    if (map[n]) return map[n];
  }
  return 1;
}

function resultOf(t) {
  const r = String(t.result || t.outcome || '').toUpperCase().trim();
  if (r === 'WIN' || r === 'WON' || r === 'SUCCESS' || r === 'W') return 'WIN';
  if (r === 'LOSS' || r === 'LOST' || r === 'LOSE' || r === 'L' || r === 'FAIL') return 'LOSS';
  return '';
}

function pairOf(t) {
  return String(t.symbol || t.selectedCurrency || t.currency || t.pair || '?')
    .replace(/\s+/g, ' ')
    .trim() || '?';
}

function pairKey(p) {
  return String(p || '')
    .toUpperCase()
    .replace(/\bOTC\b/g, '')
    .replace(/[^A-Z0-9]/g, '') || '?';
}

function sideOf(t) {
  const s = String(t.action || t.side || t.direction || '').toUpperCase();
  if (s === 'BUY' || s === 'CALL' || s === 'UP') return 'BUY';
  if (s === 'SELL' || s === 'PUT' || s === 'DOWN') return 'SELL';
  return s || '?';
}

function tradeMs(t) {
  return (
    toMs(t.timestamp) ||
    toMs(t.openedAtMs) ||
    toMs(t.openingTime) ||
    toMs(t.closedAtMs) ||
    toMs(t.closingTime) ||
    toMs(t.createdAt) ||
    0
  );
}

function pct(w, n) {
  if (!n) return 'n/a';
  return `${((100 * w) / n).toFixed(1)}%`;
}

function fmt(n, d) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(d == null ? 1 : d);
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

async function loadAllResults() {
  const col = db.collection('bots/mirax/tradingResults');
  const rows = [];
  let cursor = null;
  for (;;) {
    let q = col.orderBy('timestamp', 'asc').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach((doc) => {
      const d = doc.data() || {};
      rows.push({ ...d, _id: doc.id, _ms: tradeMs({ ...d, id: doc.id }) });
    });
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }
  return rows;
}

async function loadBoard() {
  const snap = await db.doc('bots/mirax').get();
  return snap.exists ? snap.data() : null;
}

async function loadPastStreaks() {
  const snap = await db.collection('bots/mirax/pastWinStreaks').get();
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  return rows;
}

(async () => {
  const [raw, board, pastStreaks] = await Promise.all([loadAllResults(), loadBoard(), loadPastStreaks()]);
  const rows = raw.filter((t) => resultOf(t) === 'WIN' || resultOf(t) === 'LOSS');
  rows.sort((a, b) => {
    if (a._ms !== b._ms) return a._ms - b._ms;
    return String(a._id).localeCompare(String(b._id));
  });

  const now = Date.now();
  const first = rows[0] ? rows[0]._ms : 0;
  const last = rows.length ? rows[rows.length - 1]._ms : 0;
  const spanH = first && last ? (last - first) / 3600000 : 0;
  const spanD = spanH / 24;

  let wins = 0;
  let losses = 0;
  const byAtt = { 1: { w: 0, n: 0 }, 2: { w: 0, n: 0 }, 3: { w: 0, n: 0 }, 4: { w: 0, n: 0 }, 5: { w: 0, n: 0 } };
  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const sides = { BUY: { w: 0, n: 0 }, SELL: { w: 0, n: 0 }, '?': { w: 0, n: 0 } };
  const pairs = {};
  const days = {};
  const att1 = [];

  for (const t of rows) {
    const res = resultOf(t);
    const att = attOf(t);
    const won = res === 'WIN';
    const pair = pairOf(t);
    const pk = pairKey(pair);
    const side = sideOf(t);
    const day = berlinDay(t._ms);

    if (won) wins += 1;
    else losses += 1;

    if (!byAtt[att]) byAtt[att] = { w: 0, n: 0 };
    byAtt[att].n += 1;
    if (won) byAtt[att].w += 1;
    if (won) buckets[att] += 1;

    if (!sides[side]) sides[side] = { w: 0, n: 0 };
    sides[side].n += 1;
    if (won) sides[side].w += 1;

    if (!pairs[pk]) pairs[pk] = { label: pair, w: 0, n: 0, att1w: 0, att1n: 0 };
    pairs[pk].n += 1;
    if (won) pairs[pk].w += 1;

    if (!days[day]) days[day] = { w: 0, n: 0, att1w: 0, att1n: 0, wipes: 0 };
    days[day].n += 1;
    if (won) days[day].w += 1;

    if (att === 1) {
      att1.push(t);
      if (!days[day]) days[day] = { w: 0, n: 0, att1w: 0, att1n: 0, wipes: 0 };
      days[day].att1n += 1;
      if (won) days[day].att1w += 1;
      pairs[pk].att1n += 1;
      if (won) pairs[pk].att1w += 1;
    }
  }

  // App streak model: consecutive WINs; 5 losses in a row = wipe, streak ends.
  const recounted = botStore.recountFromHistory('MIRAX', rows.map((t) => ({
    ...t,
    id: t._id,
    result: resultOf(t),
    timestamp: t._ms,
    openingTime: t._ms,
    openedAtMs: t._ms,
  })));

  let winStreak = 0;
  let lossRun = 0;
  let maxLive = 0;
  const completed = [];
  let streakStart = null;
  const chainLens = [];
  let chainWins = 0;
  let chainWipes = 0;
  let openChain = 0;
  let currentLossRun = 0;

  for (const t of rows) {
    const res = resultOf(t);
    if (res === 'LOSS') {
      lossRun += 1;
      currentLossRun += 1;
      if (lossRun >= 5) {
        if (winStreak > 0) {
          completed.push({ length: winStreak, startedAt: streakStart, endedAt: t._ms });
        }
        chainWipes += 1;
        chainLens.push(winStreak);
        const day = berlinDay(t._ms);
        if (days[day]) days[day].wipes += 1;
        winStreak = 0;
        streakStart = null;
        lossRun = 0;
        currentLossRun = 0;
        openChain = 0;
      }
      continue;
    }
    if (res === 'WIN') {
      lossRun = 0;
      currentLossRun = 0;
      if (winStreak === 0) streakStart = t._ms;
      winStreak += 1;
      if (winStreak > maxLive) maxLive = winStreak;
      chainWins += 1;
      chainLens.push(winStreak);
      openChain = winStreak;
    }
  }

  // Better chain reconstruction: att1 starts a chain; WIN ends it (saved); att5 LOSS = wipe.
  let mgChains = 0;
  let mgSaved = 0;
  let mgWipes = 0;
  let mgOpen = false;
  let mgLosses = 0;
  let mgAtt = 0;
  const mgSteps = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const t of rows) {
    const att = attOf(t);
    const res = resultOf(t);
    if (att === 1) {
      mgChains += 1;
      mgOpen = true;
      mgLosses = 0;
      mgAtt = 1;
    }
    if (!mgOpen && att > 1) {
      mgChains += 1;
      mgOpen = true;
      mgLosses = att - 1;
      mgAtt = att;
    }
    if (res === 'WIN') {
      const step = Math.min(5, Math.max(1, att));
      mgSteps[step] += 1;
      mgSaved += 1;
      mgOpen = false;
      mgLosses = 0;
    } else if (res === 'LOSS') {
      mgLosses += 1;
      if (att >= 5 || mgLosses >= 5) {
        mgWipes += 1;
        mgOpen = false;
        mgLosses = 0;
      }
    }
  }

  const wr1w = byAtt[1].w;
  const wr1n = byAtt[1].n;
  const allN = wins + losses;
  const resolvedChains = mgSaved + mgWipes;
  const gaps = [];
  for (let i = 1; i < att1.length; i++) gaps.push((att1[i]._ms - att1[i - 1]._ms) / 60000);
  const gapBuckets = { '<2m': 0, '2-5m': 0, '5-15m': 0, '15-30m': 0, '30-60m': 0, '>60m': 0 };
  for (const g of gaps) {
    if (g < 2) gapBuckets['<2m'] += 1;
    else if (g < 5) gapBuckets['2-5m'] += 1;
    else if (g < 15) gapBuckets['5-15m'] += 1;
    else if (g < 30) gapBuckets['15-30m'] += 1;
    else if (g < 60) gapBuckets['30-60m'] += 1;
    else gapBuckets['>60m'] += 1;
  }

  const streakLens = completed.map((s) => s.length).sort((a, b) => b - a);
  const streakBuckets = { '1-4': 0, '5-9': 0, '10-19': 0, '20-49': 0, '50-99': 0, '100+': 0 };
  for (const L of streakLens) {
    if (L >= 100) streakBuckets['100+'] += 1;
    else if (L >= 50) streakBuckets['50-99'] += 1;
    else if (L >= 20) streakBuckets['20-49'] += 1;
    else if (L >= 10) streakBuckets['10-19'] += 1;
    else if (L >= 5) streakBuckets['5-9'] += 1;
    else streakBuckets['1-4'] += 1;
  }

  console.log('========== MIRAX full Firebase history ==========');
  console.log(`docs (WIN/LOSS): ${rows.length}   raw fetched: ${raw.length}   skipped: ${raw.length - rows.length}`);
  console.log(`span: ${berlin(first)} → ${berlin(last)}  (${fmt(spanD, 2)} days / ${fmt(spanH, 1)} h)`);
  console.log(`now:  ${berlin(now)}`);
  console.log('');

  console.log('--- results ---');
  console.log(`trades: ${allN}   W ${wins} / L ${losses}   all WR ${pct(wins, allN)}`);
  console.log(`WR1 (attempt 1): ${pct(wr1w, wr1n)}  (${wr1w}/${wr1n})`);
  for (let a = 1; a <= 5; a++) {
    const s = byAtt[a];
    console.log(`  att${a}: ${pct(s.w, s.n)}  (${s.w}/${s.n})`);
  }
  console.log(`win buckets (S1..S5): S1=${buckets[1]}  S2=${buckets[2]}  S3=${buckets[3]}  S4=${buckets[4]}  S5=${buckets[5]}`);
  console.log('');

  console.log('--- chains / wipes (5-loss wipe, MG [1,2,4,10,20]) ---');
  console.log(`chains started (att1): ${att1.length}`);
  console.log(`resolved chains: ${resolvedChains}  saved=${mgSaved}  wipes=${mgWipes}  open=${mgOpen ? 1 : 0}`);
  console.log(`chain WR: ${pct(mgSaved, resolvedChains)}   wipe rate: ${pct(mgWipes, resolvedChains)}`);
  console.log(`wins by MG step: S1=${mgSteps[1]} S2=${mgSteps[2]} S3=${mgSteps[3]} S4=${mgSteps[4]} S5=${mgSteps[5]}`);
  console.log(`current consecutive losses (open MG): ${currentLossRun}`);
  console.log('');

  console.log('--- win streak (ends only after 5 losses in a row) ---');
  console.log(`live win streak (walk): ${winStreak}`);
  console.log(`live board (bots/mirax): currentWinStreak=${board && board.currentWinStreak}  consecLosses=${board && board.consecutiveLosses}  lastResult=${board && board.lastResult}  lastPair=${board && board.lastPair}`);
  console.log(`recountFromHistory live: ${recounted.board.currentWinStreak}  consecLosses=${recounted.board.consecutiveLosses}  last=${recounted.board.lastResult} ${recounted.board.lastPair || ''}`);
  console.log(`max live streak seen: ${maxLive}`);
  console.log(`completed streaks (wipes that had a streak): ${completed.length}`);
  if (streakLens.length) {
    console.log(`  last completed: ${streakLens[0] != null ? completed[completed.length - 1].length : 'n/a'} wins  ended ${berlin(completed[completed.length - 1].endedAt)}`);
    console.log(`  best completed: ${Math.max(...streakLens)}`);
    console.log(`  avg completed: ${fmt(avg(streakLens), 1)}  median ${fmt(median(streakLens), 1)}`);
    console.log('  buckets:', JSON.stringify(streakBuckets));
    console.log('  all completed lengths:', streakLens.join(', ') || '(none)');
  } else {
    console.log('  no completed (wiped) streaks in history');
  }
  console.log(`pastWinStreaks docs in Firebase: ${pastStreaks.length}`);
  if (pastStreaks.length) {
    const lens = pastStreaks.map((s) => Number(s.length) || 0).sort((a, b) => b - a);
    console.log(`  firebase past lengths: ${lens.join(', ')}`);
  }
  console.log('');

  console.log('--- cadence (att1 → att1) ---');
  console.log(`att1 count: ${att1.length}   avg gap ${fmt(avg(gaps))}m  median ${fmt(median(gaps))}m  min ${fmt(gaps.length ? Math.min(...gaps) : null)}m  max ${fmt(gaps.length ? Math.max(...gaps) : null)}m`);
  if (spanH > 0) {
    console.log(`pace: ${(att1.length / spanH).toFixed(2)} att1/h  →  ${(att1.length / Math.max(spanD, 1 / 24)).toFixed(1)} att1/day`);
  }
  console.log('gap buckets', gapBuckets);
  console.log('');

  console.log('--- sides ---');
  for (const [k, s] of Object.entries(sides)) {
    if (!s.n) continue;
    console.log(`  ${k.padEnd(5)} n=${s.n} wr=${pct(s.w, s.n)} (${s.w}/${s.n})`);
  }
  console.log('');

  const dayKeys = Object.keys(days).sort();
  console.log(`--- by day Europe/Berlin (${dayKeys.length} days) ---`);
  for (const d of dayKeys) {
    const s = days[d];
    console.log(
      `  ${d}  n=${String(s.n).padStart(3)}  wr=${pct(s.w, s.n).padStart(6)}  att1=${String(s.att1n).padStart(3)} wr1=${pct(s.att1w, s.att1n).padStart(6)}  wipes=${s.wipes}`
    );
  }
  console.log('');

  const top = Object.values(pairs).sort((a, b) => b.n - a.n);
  console.log(`--- pairs (${top.length}) ---`);
  for (const s of top) {
    console.log(
      `  ${String(s.label).padEnd(18)} n=${String(s.n).padStart(3)} wr=${pct(s.w, s.n).padStart(6)}  att1=${String(s.att1n).padStart(3)} wr1=${pct(s.att1w, s.att1n).padStart(6)}`
    );
  }

  console.log('\n--- last 15 trades ---');
  for (const t of rows.slice(-15)) {
    const att = attOf(t);
    const res = resultOf(t);
    console.log(
      `  ${berlin(t._ms)}  ${pairOf(t).padEnd(16)} ${sideOf(t).padEnd(4)} a${att}  ${res}`
    );
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
