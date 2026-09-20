#!/usr/bin/env node
/**
 * tools/sync_studio_entitlements.js
 *
 * Copies paidUntil / subscriptionStatus from Firestore users/{uid}
 * into community_hub.sqlite entitlements so Global listings stay live
 * without trusting the desktop client.
 *
 * Usage:
 *   node tools/sync_studio_entitlements.js           # once
 *   node tools/sync_studio_entitlements.js --loop 120 # every 2m
 *
 * Requires serviceAccountKey.json in project root (Contabo / ops box).
 */
'use strict';

const admin = require('firebase-admin');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SERVICE_ACCOUNT = path.join(ROOT, 'serviceAccountKey.json');
const PY = process.env.UTK_PYTHON
  || (fs.existsSync(path.join(ROOT, '.venv', 'Scripts', 'python.exe'))
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : (fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python'))
      ? path.join(ROOT, '.venv', 'bin', 'python')
      : 'python'));
const HELPER = path.join(ROOT, 'BotsHub', 'pipeline', 'studio_entitlements.py');

if (!fs.existsSync(SERVICE_ACCOUNT)) {
  console.error('serviceAccountKey.json not found. Cannot sync entitlements.');
  process.exit(2);
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require(SERVICE_ACCOUNT)) });
}
const db = admin.firestore();

function pyJson(args, stdin) {
  const r = spawnSync(PY, [HELPER].concat(args || []), {
    cwd: ROOT,
    input: stdin || undefined,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || 'python failed').trim());
  }
  const text = (r.stdout || '').trim();
  return text ? JSON.parse(text) : {};
}

function paidUntilMs(raw) {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (raw && typeof raw.toDate === 'function') {
    return raw.toDate().getTime();
  }
  if (raw && typeof raw._seconds === 'number') {
    return Math.round(raw._seconds * 1000);
  }
  const n = Date.parse(String(raw));
  return Number.isFinite(n) ? n : 0;
}

function isPaid(userData) {
  if (!userData || typeof userData !== 'object') return { paid: false, until: 0 };
  if (userData.betaTester) return { paid: true, until: 0 };
  const status = String(userData.subscriptionStatus || '').toLowerCase();
  const until = paidUntilMs(userData.paidUntil)
    || paidUntilMs(userData.subscription && userData.subscription.paidUntil);
  const now = Date.now();
  if (status === 'active') return { paid: true, until: until || 0 };
  if (until && until > now) return { paid: true, until };
  return { paid: false, until: until || 0 };
}

async function syncOnce() {
  const listed = pyJson(['uids']);
  const uids = Array.isArray(listed.uids) ? listed.uids : [];
  const rows = [];
  for (let i = 0; i < uids.length; i++) {
    const uid = String(uids[i] || '');
    if (!uid) continue;
    try {
      const snap = await db.collection('users').doc(uid).get();
      const data = snap.exists ? snap.data() : null;
      const info = isPaid(data || {});
      rows.push({ uid, paid: !!info.paid, paidUntil: info.until || 0 });
    } catch (e) {
      rows.push({ uid, paid: false, paidUntil: 0 });
    }
  }
  const out = pyJson(['upsert'], JSON.stringify(rows));
  console.log(
    `[studio-entitlements ${new Date().toISOString()}] synced ${rows.length} uids`
    + ` paid=${rows.filter((r) => r.paid).length}`
    + (out && out.n != null ? ` wrote=${out.n}` : '')
  );
}

async function main() {
  const loopIdx = process.argv.indexOf('--loop');
  const once = loopIdx < 0;
  const intervalSec = once ? 0 : Math.max(30, Number(process.argv[loopIdx + 1]) || 120);

  if (once) {
    await syncOnce();
    return;
  }

  console.log(`Syncing studio entitlements every ${intervalSec}s…`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await syncOnce();
    } catch (e) {
      console.error('sync failed:', e && e.message ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
