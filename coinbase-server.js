// coinbase-server.js
// Minimal Express server to receive Coinbase Commerce webhooks and update Firestore user documents.
// Usage: set COINBASE_WEBHOOK_SECRET=whsec_... and COINBASE_PAYMENT_LINK to your hosted payment link
// Run: node coinbase-server.js

const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Load .env if present (developer convenience)
try { require('dotenv').config(); } catch (e) {}

const PORT = process.env.COINBASE_SERVER_PORT || 5001;
const WEBHOOK_SECRET = process.env.COINBASE_WEBHOOK_SECRET || '';
let API_KEY = process.env.COINBASE_API_KEY || '';
let PAYMENT_LINK = process.env.CRYPTO_PAYMENT_LINK || process.env.COINBASE_PAYMENT_LINK || process.env.PAYMENT_LINK_URL || null;

// Fallback: try reading `config.json` in project root for convenience (supports `coinbaseApiKey` and `paymentLinkUrl`).
try {
  const cfgPath = path.join(process.cwd(), 'config.json');
  if (!API_KEY && fs.existsSync(cfgPath)) {
    const pj = require(cfgPath);
    if (pj && (pj.coinbaseApiKey || pj.COINBASE_API_KEY)) {
      API_KEY = pj.coinbaseApiKey || pj.COINBASE_API_KEY;
      console.log('[payments] Using COINBASE_API_KEY from config.json');
    }
  }
  if (!PAYMENT_LINK && fs.existsSync(cfgPath)) {
    const pj2 = pj || require(cfgPath);
    if (pj2 && (pj2.paymentLinkUrl || pj2.PAYMENT_LINK_URL)) {
      PAYMENT_LINK = pj2.paymentLinkUrl || pj2.PAYMENT_LINK_URL;
      console.log('[payments] Using PAYMENT_LINK from config.json');
    }
  }
} catch (e) {
  // ignore
}

if (!WEBHOOK_SECRET) {
  console.warn('Warning: COINBASE_WEBHOOK_SECRET not set. Webhook requests will be rejected.');
}
if (!API_KEY) {
  console.warn('Warning: COINBASE_API_KEY not set. Creating charges will fail until configured. See COINBASE_SETUP.md for steps.');
}
// If someone accidentally left a Stripe-hosted payment link in env, ignore it to avoid showing Stripe to users
try {
  if (PAYMENT_LINK && String(PAYMENT_LINK).toLowerCase().includes('stripe')) {
    console.warn('Detected a Stripe URL in PAYMENT_LINK/COINBASE_PAYMENT_LINK/CRYPTO_PAYMENT_LINK. Ignoring it to prevent Stripe showing up.');
    PAYMENT_LINK = null;
  }
} catch (e) {}

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

// Raw body parser for webhook verification
app.use('/webhook', express.raw({ type: 'application/json' }));
// Basic JSON for other endpoints
app.use(express.json());

function verifySignature(rawBody, signature) {
  if (!signature || !WEBHOOK_SECRET) return false;
  try {
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch (e) {
    return false;
  }
}

// Utility to find uid: prefer metadata.uid, else match by email
async function findUidFromAttributes(attrs) {
  try {
    if (!attrs) return null;
    const metadata = attrs.metadata || {};
    if (metadata && metadata.uid) return metadata.uid;
    // Try email in metadata or customer details
    const email = metadata.email || attrs.customer_email || attrs.email || null;
    if (email) {
      const q = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!q.empty) return q.docs[0].id;
    }
    return null;
  } catch (e) {
    return null;
  }
}

app.post('/webhook', async (req, res) => {
  const sigHeader = req.headers['x-cc-webhook-signature'] || req.headers['x-cc-signature'] || '';
  const raw = req.body;

  if (!verifySignature(raw, sigHeader)) {
    console.warn('Coinbase webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let payload = null;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    console.error('Invalid JSON payload');
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    const evType = payload.type || (payload.event && payload.event.type) || '';
    const data = payload.data || (payload.event && payload.event.data) || {};
    const attrs = data && data.attributes ? data.attributes : data;

    console.log('Coinbase webhook received:', evType);

    // Handle confirmed/settled charges
    if (evType === 'charge:confirmed' || evType === 'charge:resolved' || evType === 'checkout:confirmed') {
      // Try to find uid
      const uid = await findUidFromAttributes(attrs);
      const chargeId = data && data.id ? data.id : (attrs && attrs.id ? attrs.id : null);
      const email = (attrs && (attrs.customer_email || attrs.metadata && attrs.metadata.email)) || null;

      if (!uid) {
        console.warn('No matching uid found for Coinbase event; skipping. email=', email);
        // Still return success so webhook won't be retried endlessly
        return res.json({ received: true, note: 'no uid' });
      }

      // Mark user subscription active and set a paidUntil (e.g., 30 days from now)
      const paidUntil = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();
      const docRef = db.collection('users').doc(uid);
      await docRef.set({
        subscription: {
          status: 'active',
          provider: 'coinbase',
          coinbase_charge_id: chargeId || null,
          last_paid: new Date().toISOString(),
          paidUntil: paidUntil
        },
        subscriptionStatus: 'active'
      }, { merge: true });

      console.log('Updated user', uid, 'subscription active via Coinbase -> paidUntil', paidUntil);
      return res.json({ received: true });
    }

    // Other event types can be handled as needed
    return res.json({ received: true, note: 'unhandled event' });
  } catch (err) {
    console.error('Error handling webhook:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
});

// Create a hosted Coinbase charge for a user (requires COINBASE_API_KEY)
app.post('/create-charge', async (req, res) => {
  try {
    const body = req.body || {};
    const idToken = body.idToken || null;
    const amount = body.amount || (body.price && body.price.amount) || null; // amount as string or number
    const currency = body.currency || 'USD';

    // Validate ID token
    let uid = null;
    let email = null;
    if (!idToken) {
      return res.status(400).json({ success: false, error: 'Missing idToken' });
    }

    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
      email = decoded.email;
    } catch (e) {
      return res.status(401).json({ success: false, error: 'Invalid ID token' });
    }

    // Need API key (support config.json fallback via outer API_KEY)
    if (!API_KEY) return res.status(500).json({ success: false, error: 'COINBASE_API_KEY not configured' });

    // Prepare charge payload
    const priceAmt = amount ? String(amount) : '19.99';
    const payload = {
      name: 'Subscription',
      description: 'Monthly subscription',
      local_price: { amount: priceAmt, currency: currency },
      pricing_type: 'fixed_price',
      metadata: { uid: uid, email: email }
    };

    // Post to Coinbase Commerce API
    const https = require('https');
    const postData = JSON.stringify(payload);

    const opts = {
      hostname: 'api.commerce.coinbase.com',
      path: '/charges',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Api-Key': API_KEY,
        'X-CC-Version': '2018-03-22',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const r = await new Promise((resolve, reject) => {
      const req2 = https.request(opts, (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          try { resolve({ statusCode: resp.statusCode, body: data }); } catch (e) { resolve({ statusCode: resp.statusCode, body: data }); }
        });
      });
      req2.on('error', (err) => reject(err));
      req2.write(postData);
      req2.end();
    });

    let json = {};
    try { json = JSON.parse(r.body); } catch (e) { json = { error: 'Invalid JSON from Coinbase', raw: r.body }; }
    if (r.statusCode >= 200 && r.statusCode < 300 && json && json.data && json.data.hosted_url) {
      return res.json({ success: true, url: json.data.hosted_url, id: json.data.id });
    }

    return res.status(502).json({ success: false, error: json.error || json || 'Coinbase API error', raw: json });
  } catch (err) {
    console.error('create-charge error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
});

// Test endpoint to simulate a confirmed charge for local testing (no webhook required)
app.post('/simulate-charge', async (req, res) => {
  try {
    const uid = req.body && req.body.uid ? String(req.body.uid) : null;
    if (!uid) return res.status(400).json({ error: 'Missing uid' });
    const paidUntil = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();
    const docRef = db.collection('users').doc(uid);
    await docRef.set({
      subscription: {
        status: 'active',
        provider: 'coinbase-sim',
        coinbase_charge_id: 'simulated',
        last_paid: new Date().toISOString(),
        paidUntil: paidUntil
      },
      subscriptionStatus: 'active'
    }, { merge: true });
    console.log('Simulated charge for', uid, '-> paidUntil', paidUntil);
    return res.json({ success: true, paidUntil });
  } catch (e) {
    console.error('simulate-charge error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/config', (req, res) => {
  try {
    return res.json({
      coinbaseApiConfigured: !!API_KEY,
      webhookConfigured: !!WEBHOOK_SECRET,
      paymentLinkConfigured: !!PAYMENT_LINK,
      paymentLinkUrl: PAYMENT_LINK ? PAYMENT_LINK : null
    });
  } catch (e) {
    return res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/payment-link', (req, res) => {
  if (!PAYMENT_LINK) return res.status(404).json({ error: 'No payment link configured' });
  return res.json({ url: PAYMENT_LINK });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Coinbase webhook server listening on port ${PORT}`);
  if (PAYMENT_LINK) console.log('Payment link configured:', PAYMENT_LINK);
});
