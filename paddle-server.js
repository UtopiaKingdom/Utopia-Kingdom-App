// paddle-server.js
// Minimal Express server to receive Paddle webhooks and update Firestore user documents.
//
// Env:
//   PADDLE_WEBHOOK_SECRET=... (required)
//   PADDLE_SERVER_PORT=5002 (optional)
//
// This server marks a user subscription active when Paddle confirms a transaction/subscription.
// It matches users by email (users/{uid}.email).

const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Load .env if present (developer convenience)
try { require('dotenv').config(); } catch (e) {}

const PORT = process.env.PADDLE_SERVER_PORT || 5002;
const WEBHOOK_SECRET = String(process.env.PADDLE_WEBHOOK_SECRET || '').trim();
const TOLERANCE_SEC = Number(process.env.PADDLE_WEBHOOK_TOLERANCE_SEC || 300);

if (!WEBHOOK_SECRET) {
  console.warn('Warning: PADDLE_WEBHOOK_SECRET not set. Webhook requests will be rejected.');
}

// Initialize Firebase Admin
const serviceAccountPath = path.join(process.cwd(), 'serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('Missing serviceAccountKey.json for Firebase Admin. Place it in project root.');
  process.exit(2);
}

admin.initializeApp({
  credential: admin.credential.cert(require(serviceAccountPath))
});
const db = admin.firestore();

const app = express();

// Paddle signature verification needs the RAW body
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

function parsePaddleSignatureHeader(headerValue) {
  const header = String(headerValue || '').trim();
  if (!header) return null;

  const parts = header.split(';').map((p) => p.trim()).filter(Boolean);
  const out = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = v;
  }

  if (!out.ts || !out.h1) return null;
  return { ts: out.ts, h1: out.h1 };
}

function verifyPaddleWebhook(rawBodyBuf, signatureHeader) {
  if (!WEBHOOK_SECRET) return { ok: false, error: 'missing_secret' };

  const parsed = parsePaddleSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, error: 'bad_signature_header' };

  const tsRaw = String(parsed.ts);
  let tsNum = Number(tsRaw);
  if (!Number.isFinite(tsNum)) return { ok: false, error: 'bad_timestamp' };

  // Paddle docs use seconds; tolerate ms if provided.
  const tsSec = tsNum > 1e12 ? Math.floor(tsNum / 1000) : tsNum;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsSec) > TOLERANCE_SEC) {
    return { ok: false, error: 'timestamp_out_of_tolerance' };
  }

  // IMPORTANT: signature is computed over the raw header timestamp value + ':' + raw body
  const signedPayload = Buffer.from(`${tsRaw}:${rawBodyBuf.toString('utf8')}`, 'utf8');
  const digest = crypto.createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');

  try {
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(String(parsed.h1), 'utf8');
    if (a.length !== b.length) return { ok: false, error: 'bad_signature' };
    const ok = crypto.timingSafeEqual(a, b);
    return ok ? { ok: true } : { ok: false, error: 'bad_signature' };
  } catch (e) {
    return { ok: false, error: 'verify_exception' };
  }
}

async function findUidByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const q = await db.collection('users').where('email', '==', normalized).limit(1).get();
  if (!q.empty) return q.docs[0].id;

  // fallback: try case-sensitive match (older docs might store original case)
  const q2 = await db.collection('users').where('email', '==', String(email || '').trim()).limit(1).get();
  if (!q2.empty) return q2.docs[0].id;

  return null;
}

function extractEmailFromPaddlePayload(payload) {
  try {
    const data = payload && payload.data ? payload.data : payload;
    return (
      (data && data.customer && data.customer.email) ||
      (data && data.customer_email) ||
      (data && data.email) ||
      (payload && payload.customer && payload.customer.email) ||
      null
    );
  } catch (e) {
    return null;
  }
}

function extractIds(payload) {
  const data = payload && payload.data ? payload.data : payload;
  return {
    transactionId: (data && (data.id || data.transaction_id)) || null,
    subscriptionId: (data && (data.subscription_id || (data.subscription && data.subscription.id))) || null,
    customerId: (data && (data.customer_id || (data.customer && data.customer.id))) || null
  };
}

function isActivationEvent(eventType) {
  const t = String(eventType || '').toLowerCase();
  return (
    t === 'transaction.completed' ||
    t === 'subscription.activated' ||
    t === 'subscription.updated' ||
    t === 'subscription.created'
  );
}

function isDeactivationEvent(eventType) {
  const t = String(eventType || '').toLowerCase();
  return (
    t === 'subscription.canceled' ||
    t === 'subscription.cancelled' ||
    t === 'subscription.paused' ||
    t === 'subscription.expired'
  );
}

app.get('/config', (req, res) => {
  res.json({
    ok: true,
    provider: 'paddle',
    webhookSecretConfigured: !!WEBHOOK_SECRET,
    toleranceSec: TOLERANCE_SEC
  });
});

app.post('/webhook', async (req, res) => {
  const sigHeader = req.headers['paddle-signature'] || req.headers['Paddle-Signature'];
  const raw = req.body;

  const verified = verifyPaddleWebhook(raw, sigHeader);
  if (!verified.ok) {
    console.warn('Paddle webhook signature verification failed:', verified.error);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let payload = null;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventType = payload.event_type || payload.type || payload.alert_name || '';
  console.log('Paddle webhook received:', eventType);

  try {
    const email = extractEmailFromPaddlePayload(payload);
    const ids = extractIds(payload);

    if (!email) {
      console.warn('No email found in Paddle event; cannot map to user.');
      return res.json({ received: true, note: 'no_email' });
    }

    const uid = await findUidByEmail(email);
    if (!uid) {
      console.warn('No matching uid found for Paddle event; skipping. email=', email);
      return res.json({ received: true, note: 'no_uid' });
    }

    const docRef = db.collection('users').doc(uid);

    if (isActivationEvent(eventType)) {
      const paidUntil = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();
      await docRef.set({
        subscription: {
          status: 'active',
          provider: 'paddle',
          paddle_event_type: eventType,
          paddle_transaction_id: ids.transactionId,
          paddle_subscription_id: ids.subscriptionId,
          paddle_customer_id: ids.customerId,
          last_paid: new Date().toISOString(),
          paidUntil
        },
        subscriptionStatus: 'active'
      }, { merge: true });
      console.log('Updated user', uid, 'subscription active via Paddle -> paidUntil', paidUntil);
      return res.json({ received: true });
    }

    if (isDeactivationEvent(eventType)) {
      await docRef.set({
        subscription: {
          status: 'inactive',
          provider: 'paddle',
          paddle_event_type: eventType,
          paddle_subscription_id: ids.subscriptionId,
          paddle_customer_id: ids.customerId,
          last_update: new Date().toISOString()
        },
        subscriptionStatus: 'inactive'
      }, { merge: true });
      console.log('Updated user', uid, 'subscription inactive via Paddle');
      return res.json({ received: true });
    }

    return res.json({ received: true, note: 'unhandled_event' });
  } catch (err) {
    console.error('Error handling Paddle webhook:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`Paddle webhook server listening on http://localhost:${PORT}`);
});
