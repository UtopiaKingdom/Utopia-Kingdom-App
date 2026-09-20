#!/usr/bin/env node
/**
 * Live bot history: gap between chains + WR1 / chain WR for MIRAX + LUMIX.
 *   node tools/live_bot_gap_stats.js
 *   node tools/live_bot_gap_stats.js --hours 12
 */
const path = require('path');
const admin = require('firebase-admin');

const ROOT = path.join(__dirname, '..');
const keyPath = path.join(ROOT, 'serviceAccountKey.json');
const hours = (() => {
  const i = process.argv.indexOf('--hours');
  return i >= 0 ? Number(process.argv[i + 1]) || 24 : 24;
})();

if (!require('fs').existsSync(keyPath)) {
  console.error('missing serviceAccountKey.json');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const db = admin.firestore();

function toMs(t) {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

function botKey(t) {
  const b = String(t.bot || t.botKey || t.source || '').toUpperCase();
  if (b.includes('MIRAX')) return 'MIRAX';
  if (b.includes('LUMIX')) return 'LUMIX';
  return b || 'OTHER';
}

function isAtt1(t) {
  const a = Number(t.attempt || t.stakeMultiplier || t.martingaleStep || 1);
  // stakeMultiplier 1 = att1; attempt field preferred
  if (t.attempt != null) return Number(t.attempt) === 1;
  if (t.martingaleStep != null) return Number(t.martingaleStep) === 1;
  if (t.stakeMultiplier != null) return Number(t.stakeMultiplier) === 1;
  return true;
}

function won(t) {
  const r = String(t.result || t.outcome || t.status || '').toUpperCase();
  return r === 'WIN' || r === 'WON' || r === 'SUCCESS';
}

function lost(t) {
  const r = String(t.result || t.outcome || t.status || '').toUpperCase();
  return r === 'LOSS' || r === 'LOST' || r === 'FAIL' || r === 'WIPE';
}

async function loadTrades() {
  const since = Date.now() - hours * 3600 * 1000;
  const rows = [];
  for (const bot of ['lumix', 'mirax']) {
    const snap = await db.collection(`bots/${bot}/tradingResults`).orderBy('timestamp', 'desc').limit(1500).get();
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const ms = toMs(d.timestamp) || toMs(d.createdAt) || toMs(d.openTime) || toMs(d.updatedAt);
      if (!ms || ms < since) return;
      rows.push({ ...d, _ms: ms, _id: doc.id });
    });
  }
  rows.sort((a, b) => a._ms - b._ms);
  return rows;
}

function summarize(name, trades) {
  const att1 = trades.filter(isAtt1);
  const gaps = [];
  for (let i = 1; i < att1.length; i++) {
    gaps.push((att1[i]._ms - att1[i - 1]._ms) / 60000);
  }
  gaps.sort((a, b) => a - b);
  const mid = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);

  let wr1w = 0;
  let wr1n = 0;
  for (const t of att1) {
    if (won(t) || lost(t)) {
      wr1n += 1;
      if (won(t)) wr1w += 1;
    }
  }

  // crude chain: consecutive att1 until wipe (5 losses) is hard without chain id;
  // use all resolved trades win rate + wipe markers
  let allW = 0;
  let allN = 0;
  let wipes = 0;
  for (const t of trades) {
    if (won(t) || lost(t)) {
      allN += 1;
      if (won(t)) allW += 1;
    }
    const r = String(t.result || t.outcome || '').toUpperCase();
    const phase = String(t.phase || '').toUpperCase();
    if (r.includes('WIPE') || phase.includes('WIPE') || t.wipe === true) wipes += 1;
  }

  const pct = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
  const m = (x) => (x == null ? 'n/a' : `${x.toFixed(1)}m`);

  console.log(`\n=== ${name} | last ${hours}h | trades=${trades.length} att1=${att1.length} ===`);
  console.log(`  WR1 (att1): ${pct(wr1n ? wr1w / wr1n : null)}  (${wr1w}/${wr1n})`);
  console.log(`  All resolved WR: ${pct(allN ? allW / allN : null)}  (${allW}/${allN})`);
  console.log(`  Wipe markers: ${wipes}`);
  console.log(
    `  Gap att1→att1: avg=${m(avg(gaps))} median=${m(mid(gaps))} ` +
      `p90=${m(gaps.length ? gaps[Math.floor(gaps.length * 0.9)] : null)} ` +
      `min=${m(gaps[0])} max=${m(gaps[gaps.length - 1])}`
  );
  if (gaps.length) {
    const buckets = { '<5m': 0, '5-10m': 0, '10-20m': 0, '20-30m': 0, '>30m': 0 };
    for (const g of gaps) {
      if (g < 5) buckets['<5m'] += 1;
      else if (g < 10) buckets['5-10m'] += 1;
      else if (g < 20) buckets['10-20m'] += 1;
      else if (g < 30) buckets['20-30m'] += 1;
      else buckets['>30m'] += 1;
    }
    console.log('  Gap buckets:', buckets);
  }
  // last 15 att1 times
  const last = att1.slice(-12);
  if (last.length) {
    console.log('  Last att1 opens:');
    for (const t of last) {
      const ts = new Date(t._ms).toISOString().replace('T', ' ').slice(0, 19);
      const res = String(t.result || t.outcome || t.phase || '?');
      console.log(`    ${ts}  ${t.currency || t.pair || '?'}  att=${t.attempt ?? '?'}  ${res}`);
    }
  }
}

(async () => {
  const all = await loadTrades();
  const by = { MIRAX: [], LUMIX: [], OTHER: [] };
  for (const t of all) {
    const k = botKey(t);
    (by[k] || by.OTHER).push(t);
  }
  console.log(`Loaded ${all.length} trades in last ${hours}h`);
  summarize('MIRAX', by.MIRAX);
  summarize('LUMIX', by.LUMIX);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
