#!/usr/bin/env node
/**
 * tools/publish_hub_live_status.js
 *
 * Publishes operator bot online/phase into Firestore meta/botStatus so every
 * UtK client can show the same "bots online / searching / preparing" state.
 *
 * Reads local hub_status JSON written by NewMirax / Lumix5, then merges with
 * recent trade activity windows.
 *
 * Usage:
 *   node tools/publish_hub_live_status.js           # once
 *   node tools/publish_hub_live_status.js --loop 15 # every 15s
 *
 * Requires serviceAccountKey.json in project root.
 */

const admin = require('firebase-admin');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SERVICE_ACCOUNT = path.join(ROOT, 'serviceAccountKey.json');
const STATUS_DIR = path.join(ROOT, 'BotsHub', 'Prices', 'meta', 'hub_status');

const BOTS = {
  LUMIX: {
    statusFile: 'lumix5.json',
    windowMs: 20 * 60 * 1000,
    staleMs: 90 * 1000,
    description: 'LUMIX 3m SNAP-DIG hammers (shared feed).',
  },
  MIRAX: {
    statusFile: 'newmirax.json',
    windowMs: 10 * 60 * 1000,
    staleMs: 90 * 1000,
    description: 'MIRAX 1m OTC scanner (shared feed).',
  },
};

if (!fs.existsSync(SERVICE_ACCOUNT)) {
  console.error('serviceAccountKey.json not found. Cannot publish hub status.');
  process.exit(2);
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require(SERVICE_ACCOUNT)) });
}
const db = admin.firestore();

function readHubStatus(fileName, staleMs) {
  try {
    const p = path.join(STATUS_DIR, fileName);
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ts = Number(data && data.ts) || 0;
    const ageMs = ts > 0 ? Date.now() - ts * 1000 : Infinity;
    if (!Number.isFinite(ageMs) || ageMs > staleMs) {
      return { online: false, stale: true, ageMs, raw: data || null };
    }
    return { online: true, stale: false, ageMs, raw: data };
  } catch (e) {
    return null;
  }
}

function tapeLiveJson(botKey) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: Number(process.env.BOT_TAPE_PORT || 8788) || 8788,
        path: '/live?bot=' + encodeURIComponent(botKey),
        timeout: 2500,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
  });
}

async function latestTradeMs(botKey) {
  try {
    const data = await tapeLiveJson(botKey);
    const board = data && data.board;
    const updated = Number(board && board.updatedAt) || 0;
    if (updated > 0) return updated;
  } catch (_) {}
  return null;
}

async function publishOnce() {
  const now = Date.now();
  const out = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'hub-live-status',
  };

  for (const [botKey, cfg] of Object.entries(BOTS)) {
    const hub = readHubStatus(cfg.statusFile, cfg.staleMs);
    const lastMs = await latestTradeMs(botKey);
    const recentTrade = lastMs ? (now - lastMs) <= cfg.windowMs : false;
    const online = !!(hub && hub.online);
    const phase = hub && hub.raw ? String(hub.raw.phase || hub.raw.status || '') : '';
    const symbol = hub && hub.raw
      ? String(hub.raw.symbol || hub.raw.currency || hub.raw.selectedCurrency || '')
      : '';

    out[botKey] = {
      online,
      active: online || recentTrade,
      phase: phase || (online ? 'searching' : 'offline'),
      symbol: symbol || null,
      lastSignalMs: lastMs || null,
      hubAgeMs: hub && Number.isFinite(hub.ageMs) ? Math.round(hub.ageMs) : null,
      description: cfg.description,
      updatedAtMs: now,
    };
  }

  // Also mirror signal-writer heartbeat freshness for UI
  try {
    const sw = await db.collection('meta').doc('signalWriter').get();
    if (sw.exists) {
      const d = sw.data() || {};
      const hb = Number(d.updatedAt) || 0;
      out.signalWriter = {
        online: !!(d.online && hb && (now - hb) < 60_000),
        updatedAt: hb || null,
        wsState: d.wsState || null,
      };
    }
  } catch (_) {}

  await db.collection('meta').doc('botStatus').set(out, { merge: true });
  const summary = Object.keys(BOTS)
    .map((k) => `${k}:${out[k].online ? 'online' : 'offline'}/${out[k].phase}`)
    .join(' ');
  console.log(`[hub-status ${new Date().toISOString()}] published ${summary}`);
}

async function main() {
  const loopIdx = process.argv.indexOf('--loop');
  const once = loopIdx < 0;
  const intervalSec = once ? 0 : Math.max(5, Number(process.argv[loopIdx + 1]) || 15);

  if (once) {
    await publishOnce();
    return;
  }

  console.log(`Publishing hub status every ${intervalSec}s…`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await publishOnce();
    } catch (e) {
      console.error('publish failed:', e && e.message ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
