#!/usr/bin/env node
/*
  tools/publish_bot_status.js
  - Reads the latest saved trade for each bot from Firestore (bots/{lumix|mirax}/tradingResults)
  - Computes active/inactive using configured windows (LUMIX=20m, MIRAX=10m)
  - Publishes a single document at `meta/botStatus` with { LUMIX, MIRAX } objects

  Usage: node tools/publish_bot_status.js
  (Requires serviceAccountKey.json in project root)
*/

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const SERVICE_ACCOUNT = path.join(process.cwd(), 'serviceAccountKey.json');
if (!fs.existsSync(SERVICE_ACCOUNT)) {
  console.error('serviceAccountKey.json not found in project root. Cannot run publish_bot_status.js');
  process.exit(2);
}

admin.initializeApp({
  credential: admin.credential.cert(require(SERVICE_ACCOUNT))
});

const db = admin.firestore();

const BOTS = {
  LUMIX: { windowMs: 10 * 60 * 1000, description: '3-minute SNAP-DIG hammers; can route them to the extension.' },
  MIRAX: { windowMs: 10 * 60 * 1000, description: 'Quick 30-second signal scanner with quality/payout gates. Supports retries/locks when configured.' }
};

async function getLatestTradeMsForBot(botKey) {
  // Preferred (fast) query: trades where bot==botKey ordered by timestamp desc
  try {
    const q = await db.collection(`bots/${botKey.toLowerCase()}/tradingResults`)
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
    if (!q.empty) return Number(q.docs[0].data().timestamp) || null;
    return null;
  } catch (err) {
    console.warn('Primary query failed (will fallback to timestamp-scan). Error:', err.message || err);
    const scanLimit = 2000;
    const snap = await db.collection(`bots/${botKey.toLowerCase()}/tradingResults`).orderBy('timestamp', 'desc').limit(scanLimit).get();
    for (const docSnap of snap.docs) {
      const d = docSnap.data();
      if (d && d.bot === botKey) return Number(d.timestamp) || null;
    }
    return null;
  }
}

async function publishOnce() {
  const now = Date.now();
  const out = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

  for (const botKey of Object.keys(BOTS)) {
    const cfg = BOTS[botKey];
    const lastMs = await getLatestTradeMsForBot(botKey);
    const active = lastMs ? ((now - lastMs) <= cfg.windowMs) : false;

    out[botKey] = {
      active: !!active,
      lastSignalMs: lastMs || null,
      // include the short description so UI can show server-provided copy when desired
      description: cfg.description
    };
  }

  await db.collection('meta').doc('botStatus').set(out, { merge: true });
  console.log('Published meta/botStatus (LUMIX/MIRAX) ->', Object.keys(BOTS).map(k => `${k}:${out[k].active ? 'active' : 'inactive'}`).join(', '));
}

if (require.main === module) {
  publishOnce()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(3); });
}
