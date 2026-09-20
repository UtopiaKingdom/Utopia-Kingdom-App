#!/usr/bin/env node
/**
 * Always-on WS → Firebase signal writer.
 *
 * Listens to the public bot WebSocket and writes:
 *   Live cards + WIN/LOSS tape live on Contabo (bot_tape_server.py).
 *   This writer keeps Expo push + meta/signalWriter heartbeat.
 *   - meta/signalWriter heartbeat (so Electron clients skip racing writes)
 *
 * Env:
 *   WS_URL                         default wss://utkingdom.com/ws
 *   PORT                           health server (default 8080)
 *   FIREBASE_SERVICE_ACCOUNT_JSON  full JSON string (Railway)
 *   FIREBASE_CREDENTIAL_PATH       path to serviceAccountKey.json (local fallback)
 *   HEARTBEAT_MS                   default 20000
 *   RESULT_CLEAR_MS                default 15000
 *   SIGNAL_CLEAR_GRACE_MS          extra wait after Signal expiry if Result never arrives (default 6000)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const admin = require('firebase-admin');

const {
  toEpochMs,
  omitUndefinedFields,
  resolveCurrency,
  normalizeResult,
  getDefaultPrepareSeconds,
  getDefaultTradeSeconds,
  normalizeBotKey,
  buildTradeIds,
} = require('./signal-writer/helpers');
const botStore = require('./firebase-bot-paths');
const statsDay = require('./stats-day');
const { fanoutSignalPush } = require('./signal-writer/expoPush');

const WS_URL = (process.env.WS_URL || 'wss://utkingdom.com/ws').trim();
const PORT = Number(process.env.PORT || 8080) || 8080;
const HEARTBEAT_MS = Math.max(5000, Number(process.env.HEARTBEAT_MS || 20000) || 20000);
const RESULT_CLEAR_MS = Math.max(3000, Number(process.env.RESULT_CLEAR_MS || 10000) || 10000);
const SIGNAL_CLEAR_GRACE_MS = Math.max(3000, Number(process.env.SIGNAL_CLEAR_GRACE_MS || 6000) || 6000);
const VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

const lastCurrency = { LUMIX: '', MIRAX: '' };
const lastOpen = { LUMIX: { price: null, time: null, action: '' }, MIRAX: { price: null, time: null, action: '' } };
const clearTimers = { LUMIX: null, MIRAX: null };
const lastTradeKey = { LUMIX: '', MIRAX: '' };
const phaseChain = { LUMIX: Promise.resolve(), MIRAX: Promise.resolve() };

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastWsMessageAt = 0;
let wsState = 'starting';

function log(...args) {
  console.log(`[signal-writer ${new Date().toISOString()}]`, ...args);
}

function warn(...args) {
  console.warn(`[signal-writer ${new Date().toISOString()}]`, ...args);
}

function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  let credential = null;
  const rawB64 = (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '').trim();
  const rawJson = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();

  if (rawB64) {
    const decoded = Buffer.from(rawB64, 'base64').toString('utf8');
    credential = admin.credential.cert(JSON.parse(decoded));
  } else if (rawJson) {
    // Railway CLI sometimes strips quotes from JSON env values; reject clearly.
    if (!rawJson.startsWith('{') || !/"type"\s*:/.test(rawJson)) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON looks invalid (missing quotes). Prefer FIREBASE_SERVICE_ACCOUNT_BASE64.'
      );
    }
    credential = admin.credential.cert(JSON.parse(rawJson));
  } else {
    const credPath = (process.env.FIREBASE_CREDENTIAL_PATH || path.join(__dirname, 'serviceAccountKey.json')).trim();
    if (!fs.existsSync(credPath)) {
      throw new Error(
        'Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_BASE64 or place serviceAccountKey.json in project root.'
      );
    }
    credential = admin.credential.cert(require(credPath));
  }

  admin.initializeApp({ credential });
  return admin.firestore();
}

const db = initFirebase();

function cancelClear(botKey) {
  if (clearTimers[botKey]) {
    clearTimeout(clearTimers[botKey]);
    clearTimers[botKey] = null;
  }
}

function scheduleClear(botKey, ms = RESULT_CLEAR_MS) {
  cancelClear(botKey);
  clearTimers[botKey] = setTimeout(() => {
    clearActiveSignal(botKey).catch(() => {});
  }, ms);
}

async function writeHeartbeat() {
  try {
    await db.collection('meta').doc('signalWriter').set({
      online: true,
      updatedAt: Date.now(),
      version: VERSION,
      wsUrl: WS_URL,
      wsState,
      lastWsMessageAt: lastWsMessageAt || null,
      source: 'server-writer',
    }, { merge: true });
  } catch (e) {
    warn('heartbeat failed:', e && e.message ? e.message : e);
  }
}

async function saveActiveSignal(botKey, signalData) {
  // Live cards live on Contabo tape. Keep Expo push; do not write Firestore cards.
  return;
}

async function patchActiveSignal(botKey, patch) {
  return;
}

async function clearActiveSignal(botKey) {
  return;
}

async function saveTrade(botKey, tradeData) {
  // WIN/LOSS tape is Contabo SQLite. Do not write Firestore history.
  return { tradeId: null, created: false, skipped: 'contabo-tape' };
}

async function loadAllResults(botKey) {
  const col = db.collection(botStore.tradingResultsPathString(botKey));
  const all = [];
  let cursor = null;
  for (;;) {
    let q = col.orderBy('timestamp', 'asc').limit(400);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    snap.forEach((d) => all.push({ id: d.id, ...d.data() }));
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }
  return all;
}

async function replacePastStreaks(botKey, completed) {
  const col = db.collection(botStore.pastWinStreaksPathString(botKey));
  const keepIds = new Set();
  const rows = [];
  (completed || []).forEach((s) => {
    if (!s || !(Number(s.length) > 0)) return;
    const id = botStore.buildStreakDocId(s);
    keepIds.add(id);
    rows.push({ id, s });
  });
  const snap = await col.get();
  const toDelete = [];
  snap.forEach((d) => {
    if (!keepIds.has(d.id)) toDelete.push(d.ref);
  });
  for (let i = 0; i < toDelete.length; i += 400) {
    const batch = db.batch();
    toDelete.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  for (const row of rows) {
    await col.doc(row.id).set(omitUndefinedFields({
      bot: botKey,
      displayTitle: `${row.s.length} wins`,
      length: row.s.length,
      startedAt: row.s.startedAt != null ? row.s.startedAt : null,
      endedAt: row.s.endedAt,
      createdAt: Date.now(),
      source: 'server-writer-recount',
    }), { merge: true });
  }
}

async function recountBot(botKey) {
  const trades = await loadAllResults(botKey);
  const { board, completedStreaks } = botStore.recountFromHistory(botKey, trades);
  await db.doc(botStore.boardPathString(botKey)).set(omitUndefinedFields(board), { merge: true });
  await replacePastStreaks(botKey, completedStreaks);
  try {
    const todayKey = statsDay.dayKey(Date.now());
    const todayRange = statsDay.dayRange(todayKey);
    const yestKey = statsDay.dayKey(todayRange.start - 1000);
    for (const dateKey of [yestKey, todayKey]) {
      const range = statsDay.dayRange(dateKey);
      const daily = botStore.recountDailyStats(botKey, trades, dateKey, range);
      await db.doc(botStore.dailyStatsPathString(botKey, dateKey)).set(omitUndefinedFields(daily), { merge: true });
    }
  } catch (e) {
    warn(`daily stats recount failed ${botKey}:`, e && e.message ? e.message : e);
  }
  log(`recounted ${botKey} trades=${trades.length} live=${board.currentWinStreak} completed=${completedStreaks.length} last=${board.lastCompletedStreak || 0}`);
}

async function recountAllBots() {
  await recountBot('LUMIX');
  await recountBot('MIRAX');
}

const BOOT_RECOUNT = String(process.env.SIGNAL_WRITER_BOOT_RECOUNT || '').trim() === '1';
const recountDone = BOOT_RECOUNT
  ? recountAllBots().catch((e) => {
      warn('history recount failed:', e && e.message ? e.message : e);
    })
  : Promise.resolve();

async function handlePhase(signal) {
  const botKey = normalizeBotKey(signal.bot);
  if (!botKey) return;

  const phase = String(signal.phase || '').trim();
  const phaseLower = phase.toLowerCase();
  const pair = resolveCurrency(signal) || lastCurrency[botKey] || '';
  if (pair) lastCurrency[botKey] = pair;

  if (signal.clear) {
    cancelClear(botKey);
    await clearActiveSignal(botKey);
    return;
  }

  if (phaseLower === 'cancelled' || phaseLower === 'canceled') {
    cancelClear(botKey);
    await clearActiveSignal(botKey);
    return;
  }

  if (phaseLower === 'preparing') {
    // App is instant-trade — do not publish Preparing to activeSignals.
    cancelClear(botKey);
    return;
  }

  if (phaseLower === 'signal') {
    const isUpdateOnly = !!signal.updateOnly || String(signal.updateKind || '').toLowerCase() === 'openingprice';
    if (isUpdateOnly) {
      const updatedPrice = signal.price != null ? signal.price : (signal.openingPrice != null ? signal.openingPrice : null);
      if (updatedPrice != null) lastOpen[botKey].price = updatedPrice;
      const updatedOpenMs = toEpochMs(signal.openedAtMs) || toEpochMs(signal.openingTime);
      if (updatedOpenMs) lastOpen[botKey].time = updatedOpenMs;
      await patchActiveSignal(botKey, {
        phase: 'Signal',
        price: lastOpen[botKey].price ?? signal.price,
        openingPrice: signal.openingPrice ?? lastOpen[botKey].price ?? signal.price,
        ...(updatedOpenMs ? { time: signal.openingTime, openedAtMs: updatedOpenMs } : {}),
        updateOnly: true,
        updateKind: signal.updateKind || 'openingPrice',
      });
      return;
    }

    cancelClear(botKey);
    lastOpen[botKey].price = signal.price ?? signal.openingPrice ?? null;
    lastOpen[botKey].time = toEpochMs(signal.openedAtMs) || toEpochMs(signal.openingTime) || toEpochMs(signal.time) || toEpochMs(signal.timestamp) || Date.now();
    lastOpen[botKey].action = String(signal.action || signal.side || lastOpen[botKey].action || '').toUpperCase();
    const tradeDur = Number(signal.countdown) > 0
      ? Number(signal.countdown)
      : (Number(signal.duration) > 0 ? Number(signal.duration) : getDefaultTradeSeconds(botKey));
    const openMs =
      toEpochMs(signal.openedAtMs) ||
      toEpochMs(signal.openingTime) ||
      toEpochMs(signal.time) ||
      null;

    await saveActiveSignal(botKey, {
      phase: 'Signal',
      duration: tradeDur,
      countdown: tradeDur,
      openedAtMs: openMs || undefined,
      action: signal.action || signal.side,
      side: signal.side || signal.action,
      selectedCurrency: pair,
      symbol: signal.symbol || pair,
      currency: pair,
      price: signal.price ?? signal.openingPrice,
      openingPrice: signal.openingPrice ?? signal.price,
      openingTime: signal.openingTime || signal.time || signal.timestamp,
      time: signal.openingTime || signal.time || signal.timestamp,
      sl: signal.sl,
      tp: signal.tp,
      attempt: signal.attempt,
      payout: signal.payout,
      expiry: signal.expiry || (botKey === 'MIRAX' ? '1m' : '3m'),
      stakeMultiplier: signal.stakeMultiplier,
      signalId: signal.signalId,
    });

    // Closed-app mobile alerts (best-effort; never block signal write path)
    fanoutSignalPush(
      db,
      {
        bot: botKey,
        currency: pair,
        side: signal.side || signal.action,
      },
      { log, warn },
    ).catch((e) => warn('push fanout:', e && e.message ? e.message : e));
    // If Result never arrives, drop the live Signal so clients return to searching.
    scheduleClear(botKey, tradeDur * 1000 + SIGNAL_CLEAR_GRACE_MS);
    return;
  }

  if (phaseLower === 'trading result' || phaseLower === 'result') {
    const openingPrice =
      signal.openingPrice ??
      signal.opening_price ??
      signal.openPrice ??
      signal.open_price ??
      lastOpen[botKey].price ??
      signal.price;
    const openingTime =
      toEpochMs(signal.openedAtMs) ??
      toEpochMs(signal.opened_at_ms) ??
      toEpochMs(lastOpen[botKey].time) ??
      toEpochMs(signal.openingTime) ??
      toEpochMs(signal.opening_time) ??
      toEpochMs(signal.timestamp) ??
      toEpochMs(signal.time) ??
      Date.now();
    const resultAction = String(signal.action || signal.side || lastOpen[botKey].action || '').toUpperCase();
    if (resultAction === 'BUY' || resultAction === 'SELL') lastOpen[botKey].action = resultAction;
    const closingTime =
      toEpochMs(signal.closedAtMs) ??
      toEpochMs(signal.closed_at_ms) ??
      toEpochMs(signal.closingTime) ??
      toEpochMs(signal.closing_time) ??
      toEpochMs(signal.closeTime) ??
      toEpochMs(signal.time) ??
      toEpochMs(signal.timestamp) ??
      Date.now();
    const closingPrice =
      signal.closingPrice ??
      signal.closing_price ??
      signal.closePrice ??
      signal.close_price ??
      signal.price;

    await saveActiveSignal(botKey, {
      phase: 'Trading Result',
      duration: 10,
      result: signal.result,
      profit: signal.profit,
      selectedCurrency: pair,
      symbol: signal.symbol || pair,
      currency: pair,
      action: resultAction || signal.action || signal.side,
      side: resultAction || signal.side || signal.action,
      openingPrice,
      openingTime,
      closingPrice,
      closingTime,
      openedAtMs: openingTime,
      closedAtMs: closingTime,
      signalId: signal.signalId,
      attempt: signal.attempt,
    });

    await saveTrade(botKey, {
      ...signal,
      symbol: pair || signal.symbol || 'N/A',
      action: resultAction || signal.action || signal.side,
      openingPrice,
      openingTime,
      closingPrice,
      closingTime,
      result: signal.result,
      attempt: signal.attempt,
      stakeMultiplier: signal.stakeMultiplier,
    });

    scheduleClear(botKey, RESULT_CLEAR_MS);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempts, 5)));
  reconnectAttempts += 1;
  wsState = `reconnect_in_${delay}ms`;
  log(`WS reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, delay);
}

function connectWs() {
  try {
    if (ws) {
      try { ws.removeAllListeners(); } catch (_) {}
      try { ws.terminate(); } catch (_) {}
      ws = null;
    }
  } catch (_) {}

  wsState = 'connecting';
  log(`connecting to ${WS_URL}`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    reconnectAttempts = 0;
    wsState = 'online';
    log('WS online');
    writeHeartbeat().catch(() => {});
  });

  ws.on('message', (data) => {
    lastWsMessageAt = Date.now();
    let signal;
    try {
      signal = JSON.parse(String(data));
    } catch (_) {
      return;
    }
    if (!signal || typeof signal !== 'object') return;
    if (signal.type === 'pong' || signal.type === 'ping') return;
    if (!signal.phase && !signal.clear) return;

    const botKey = normalizeBotKey(signal.bot) || '_';
    phaseChain[botKey] = (phaseChain[botKey] || Promise.resolve())
      .then(() => handlePhase(signal))
      .catch((e) => {
        warn('handlePhase error:', e && e.message ? e.message : e);
      });
  });

  ws.on('close', () => {
    wsState = 'offline';
    warn('WS closed');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    wsState = 'error';
    warn('WS error:', err && err.message ? err.message : err);
    try { ws.close(); } catch (_) {}
  });
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/' || req.url === '/health') {
      const body = JSON.stringify({
        ok: true,
        service: 'signal-writer',
        version: VERSION,
        wsState,
        lastWsMessageAt,
        uptimeSec: Math.round(process.uptime()),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(PORT, () => log(`health listening on :${PORT}`));
}

function startHeartbeat() {
  writeHeartbeat().catch(() => {});
  heartbeatTimer = setInterval(() => {
    writeHeartbeat().catch(() => {});
  }, HEARTBEAT_MS);
}

startHealthServer();
startHeartbeat();
connectWs();

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
