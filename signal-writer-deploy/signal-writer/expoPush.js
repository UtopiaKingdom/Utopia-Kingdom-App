/**
 * Expo Push fan-out for closed-app mobile alerts.
 * Called by signal-writer when a real Signal phase is published.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH = 100;

function userHasAccess(data) {
  if (!data || typeof data !== 'object') return false;
  const now = Date.now();
  if (String(data.subscriptionStatus || '') === 'active') return true;
  const paidUntil = data.paidUntil ? Date.parse(String(data.paidUntil)) : 0;
  if (paidUntil && paidUntil > now) return true;
  const trialUntil = data.trialExpiresAt ? Date.parse(String(data.trialExpiresAt)) : 0;
  if (trialUntil && trialUntil > now) return true;
  // Firestore Timestamp objects
  try {
    if (data.paidUntil && typeof data.paidUntil.toMillis === 'function' && data.paidUntil.toMillis() > now) {
      return true;
    }
    if (data.trialExpiresAt && typeof data.trialExpiresAt.toMillis === 'function' && data.trialExpiresAt.toMillis() > now) {
      return true;
    }
  } catch (_) {}
  return false;
}

function collectTokens(data) {
  const list = Array.isArray(data?.expoPushTokens) ? data.expoPushTokens : [];
  const out = [];
  for (const entry of list) {
    const token = entry && typeof entry === 'object' ? String(entry.token || '').trim() : String(entry || '').trim();
    if (token.startsWith('ExponentPushToken')) out.push(token);
  }
  return out;
}

async function postExpo(messages, log, warn) {
  if (!messages.length) return;
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        warn('expo push HTTP', res.status, body);
      } else if (log) {
        log(`expo push sent ${chunk.length}`);
      }
    } catch (e) {
      warn('expo push failed:', e && e.message ? e.message : e);
    }
  }
}

/**
 * Fan out a Signal-ready push to paid/trial mobile users with pushEnabled.
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ bot: string, currency?: string, side?: string }} opts
 * @param {{ log?: Function, warn?: Function }} sinks
 */
async function fanoutSignalPush(db, opts, sinks = {}) {
  const log = sinks.log || (() => {});
  const warn = sinks.warn || (() => {});
  const bot = String(opts.bot || '').toUpperCase();
  const currency = String(opts.currency || '').trim() || 'a pair';
  const side = String(opts.side || '').trim().toUpperCase() || 'SIGNAL';
  if (!bot) return;

  let snap;
  try {
    snap = await db.collection('users').where('pushEnabled', '==', true).limit(500).get();
  } catch (e) {
    warn('push query failed:', e && e.message ? e.message : e);
    return;
  }

  const messages = [];
  const seen = new Set();
  snap.forEach((docSnap) => {
    const data = docSnap.data() || {};
    if (!userHasAccess(data)) return;
    for (const token of collectTokens(data)) {
      if (seen.has(token)) continue;
      seen.add(token);
      messages.push({
        to: token,
        title: `${bot} Signal Ready`,
        body: `${currency} · ${side}`,
        sound: 'default',
        channelId: 'utk-signals',
        priority: 'high',
        data: { bot, currency, side, source: 'expo-push' },
      });
    }
  });

  if (!messages.length) {
    log(`expo push: no recipients for ${bot}`);
    return;
  }
  await postExpo(messages, log, warn);
}

module.exports = {
  fanoutSignalPush,
  userHasAccess,
  collectTokens,
};
