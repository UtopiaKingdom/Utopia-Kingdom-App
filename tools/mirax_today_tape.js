#!/usr/bin/env node
/**
 * Today's MIRAX tape from midnight Europe/Berlin.
 *   node tools/mirax_today_tape.js
 */
const path = require('path');
const admin = require('firebase-admin');

const ROOT = path.join(__dirname, '..');
admin.initializeApp({ credential: admin.credential.cert(require(path.join(ROOT, 'serviceAccountKey.json'))) });
const db = admin.firestore();

const TZ = 2 * 3600 * 1000; // Europe/Berlin summer UTC+2
const now = Date.now();
const local = new Date(now + TZ);
const startUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TZ;

function toMs(t) {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

function berlin(ms) {
  return new Date(ms + TZ).toISOString().replace('T', ' ').slice(0, 19);
}

function num(...xs) {
  for (const x of xs) {
    if (x == null || x === '') continue;
    const n = Number(x);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function attOf(t) {
  if (t.attempt != null) return Number(t.attempt);
  if (t.attempt_no != null) return Number(t.attempt_no);
  if (t.martingaleStep != null) return Number(t.martingaleStep);
  if (t.stakeMultiplier != null) return Number(t.stakeMultiplier);
  return 1;
}

function won(t) {
  return String(t.result || t.outcome || '').toUpperCase() === 'WIN';
}

function lost(t) {
  const r = String(t.result || t.outcome || '').toUpperCase();
  return r === 'LOSS' || r === 'LOST';
}

(async () => {
  const snap = await db.collection('bots/mirax/tradingResults').orderBy('timestamp', 'desc').limit(800).get();
  const rows = [];
  snap.forEach((doc) => {
    const d = doc.data() || {};
    const ms = toMs(d.timestamp) || toMs(d.createdAt) || toMs(d.openTime) || toMs(d.closeTime);
    if (!ms || ms < startUtc) return;
    rows.push({ ...d, _ms: ms, _id: doc.id });
  });
  rows.sort((a, b) => a._ms - b._ms);

  console.log(`MIRAX today Berlin 00:00 → now  (${berlin(startUtc)} → ${berlin(now)})`);
  console.log(`docs=${rows.length}`);
  if (rows[0]) {
    console.log('sample keys:', Object.keys(rows[0]).filter((k) => !k.startsWith('_')).sort().join(', '));
  }

  const att1 = [];
  let wr1w = 0;
  let wr1n = 0;
  let allW = 0;
  let allN = 0;
  let wipes = 0;
  const sides = { BUY: { w: 0, n: 0 }, SELL: { w: 0, n: 0 } };
  const pairs = {};
  let goodWay = 0;
  let badWay = 0;
  let tiny = 0;
  let agree = 0;
  let durs = [];
  let disagree = 0;

  console.log('\n#  berlin-open          pair         side att  result   entry            close            move');
  rows.forEach((t, i) => {
    const att = attOf(t);
    const side = String(t.side || t.action || t.direction || '?').toUpperCase();
    const pair = String(t.currency || t.pair || t.symbol || '?').replace(/\s+OTC/i, '');
    const entry = num(t.openingPrice, t.openPrice, t.entryPrice, t.entry, t.entry_price, t.open);
    const close = num(t.closingPrice, t.closePrice, t.close, t.close_price, t.exitPrice);
    const openMs = toMs(t.openedAtMs) || toMs(t.openingTime) || t._ms;
    const closeMs = toMs(t.closedAtMs) || toMs(t.closingTime);
    const dur = closeMs && openMs ? (closeMs - openMs) / 1000 : num(t.duration, t.expiry);
    const res = String(t.result || t.outcome || '?').toUpperCase();
    const move = entry != null && close != null ? close - entry : null;
    let way = '';
    if (move != null && (side === 'BUY' || side === 'SELL')) {
      const wantUp = side === 'BUY';
      const went = move === 0 ? 0 : move > 0 ? 1 : -1;
      const good = (wantUp && went > 0) || (!wantUp && went < 0);
      if (went === 0) tiny += 1;
      else if (good) goodWay += 1;
      else badWay += 1;
      way = went === 0 ? 'flat' : good ? 'good' : 'fade';
      if ((res === 'WIN' && good) || (res === 'LOSS' && !good && went !== 0)) agree += 1;
      else if (res === 'WIN' || res === 'LOSS') disagree += 1;
    }
    if (won(t) || lost(t)) {
      allN += 1;
      if (won(t)) allW += 1;
      if (!sides[side]) sides[side] = { w: 0, n: 0 };
      sides[side].n += 1;
      if (won(t)) sides[side].w += 1;
      if (!pairs[pair]) pairs[pair] = { w: 0, n: 0, att1w: 0, att1n: 0 };
      pairs[pair].n += 1;
      if (won(t)) pairs[pair].w += 1;
    }
    if (att === 1) {
      att1.push({ ...t, pair, side, att, res, entry, close, move, way });
      if (won(t) || lost(t)) {
        wr1n += 1;
        if (won(t)) wr1w += 1;
        if (pairs[pair]) {
          pairs[pair].att1n += 1;
          if (won(t)) pairs[pair].att1w += 1;
        }
      }
    }
    if (dur != null) durs.push(dur);
    const mv = move == null ? '' : (move >= 0 ? '+' : '') + move.toPrecision(6);
    console.log(
      `${String(i + 1).padStart(3)} ${berlin(t._ms)}  ${pair.padEnd(12)} ${side.padEnd(4)} ${String(att).padStart(2)}  ${res.padEnd(6)} ${String(entry ?? '').padEnd(16)} ${String(close ?? '').padEnd(16)} ${mv} ${way} ${dur != null ? dur + 's' : ''}`
    );
  });

  const gaps = [];
  for (let i = 1; i < att1.length; i++) gaps.push((att1[i]._ms - att1[i - 1]._ms) / 60000);
  const avg = gaps.length ? gaps.reduce((s, x) => s + x, 0) / gaps.length : null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const hours = (now - startUtc) / 3600000;

  // 5-loss chains: 5 consecutive losses on same chainId, else att==5 loss
  const byChain = {};
  for (const t of rows) {
    const id = t.chainId || t.chain_id || t._id;
    if (!byChain[id]) byChain[id] = [];
    byChain[id].push(t);
  }
  let fiveLoss = 0;
  let chains = 0;
  let chainWins = 0;
  if (Object.keys(byChain).length > att1.length * 0.3) {
    for (const xs of Object.values(byChain)) {
      xs.sort((a, b) => attOf(a) - attOf(b) || a._ms - b._ms);
      if (!xs.some((t) => attOf(t) === 1)) continue;
      chains += 1;
      if (xs.some(won)) chainWins += 1;
      else if (xs.filter(lost).length >= 5) fiveLoss += 1;
    }
  } else {
    // reconstruct: att1 starts a chain
    let losses = 0;
    chains = att1.length;
    for (const t of rows) {
      if (attOf(t) === 1) losses = 0;
      if (lost(t)) losses += 1;
      if (won(t)) losses = 0;
      if (lost(t) && attOf(t) >= 5) fiveLoss += 1;
    }
    chainWins = att1.filter(won).length; // underestimate if MG saves
  }

  console.log('\n=== summary ===');
  console.log(`hours=${hours.toFixed(1)}  clicks=${rows.length}  att1=${att1.length}  /d-pace=${((att1.length / hours) * 24).toFixed(0)}`);
  console.log(`WR1=${wr1n ? ((100 * wr1w) / wr1n).toFixed(1) : 'n/a'}%  (${wr1w}/${wr1n})`);
  console.log(`all WR=${allN ? ((100 * allW) / allN).toFixed(1) : 'n/a'}%  (${allW}/${allN})`);
  console.log(`gap att1 avg=${avg != null ? avg.toFixed(1) : 'n/a'}m  median=${mid != null ? mid.toFixed(1) : 'n/a'}m  min=${sorted[0] != null ? sorted[0].toFixed(1) : 'n/a'}m  max=${sorted.length ? sorted[sorted.length - 1].toFixed(1) : 'n/a'}m`);
  if (gaps.length) {
    const b = { '<2m': 0, '2-5m': 0, '5-15m': 0, '15-30m': 0, '>30m': 0 };
    for (const g of gaps) {
      if (g < 2) b['<2m'] += 1;
      else if (g < 5) b['2-5m'] += 1;
      else if (g < 15) b['5-15m'] += 1;
      else if (g < 30) b['15-30m'] += 1;
      else b['>30m'] += 1;
    }
    console.log('gap buckets', b);
    console.log('gaps(m)', gaps.map((g) => g.toFixed(1)).join(', '));
  }
  console.log(`price way: good=${goodWay} fade=${badWay} flat=${tiny}  result-agrees-move=${agree} disagrees=${disagree}`);
  if (durs.length) {
    const ds = [...durs].sort((a, b) => a - b);
    const avgD = durs.reduce((s, x) => s + x, 0) / durs.length;
    console.log(`open→close sec: avg=${avgD.toFixed(1)} median=${ds[Math.floor(ds.length / 2)].toFixed(1)} min=${ds[0].toFixed(1)} max=${ds[ds.length - 1].toFixed(1)}`);
  }
  console.log('sides', JSON.stringify(sides));
  console.log(`5-loss markers=${wipes} reconstructedFive=${fiveLoss} chains~${chains} chainWins~${chainWins}`);
  const top = Object.entries(pairs).sort((a, b) => b[1].n - a[1].n);
  console.log('pairs:');
  for (const [p, s] of top) {
    console.log(`  ${p.padEnd(12)} n=${s.n} wr=${s.n ? ((100 * s.w) / s.n).toFixed(0) : 0}%  att1=${s.att1n} wr1=${s.att1n ? ((100 * s.att1w) / s.att1n).toFixed(0) : 0}%`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
