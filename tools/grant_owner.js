#!/usr/bin/env node
/**
 * tools/grant_owner.js
 * Grant paid subscription + Owner role by email.
 *
 *   node tools/grant_owner.js kricoeasygame@gmail.com
 */
'use strict';

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVICE_ACCOUNT = path.join(ROOT, 'serviceAccountKey.json');
const email = String(process.argv[2] || '').trim().toLowerCase();

if (!email || email.indexOf('@') < 0) {
  console.error('Usage: node tools/grant_owner.js <email>');
  process.exit(1);
}
if (!fs.existsSync(SERVICE_ACCOUNT)) {
  console.error('Missing serviceAccountKey.json');
  process.exit(2);
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(require(SERVICE_ACCOUNT)) });
}

const PAID_UNTIL = '2099-12-31T23:59:59.000Z';
const PAID_UNTIL_MS = Date.parse(PAID_UNTIL);

async function main() {
  const user = await admin.auth().getUserByEmail(email);
  const uid = user.uid;
  console.log('uid', uid, 'email', user.email);

  const claims = Object.assign({}, user.customClaims || {}, { owner: true });
  await admin.auth().setCustomUserClaims(uid, claims);
  console.log('custom claims: owner=true');

  const ref = admin.firestore().collection('users').doc(uid);
  await ref.set(
    {
      email: user.email || email,
      subscriptionStatus: 'active',
      paidUntil: PAID_UNTIL,
      role: 'owner',
      isOwner: true,
      betaTester: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      subscription: {
        status: 'active',
        paidUntil: PAID_UNTIL,
        source: 'owner_grant',
        last_paid: new Date().toISOString()
      }
    },
    { merge: true }
  );
  console.log('firestore: active + owner + paidUntil', PAID_UNTIL);

  // Local sqlite entitlement (dev)
  try {
    const py = fs.existsSync(path.join(ROOT, '.venv', 'Scripts', 'python.exe'))
      ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
      : 'python';
    const helper = path.join(ROOT, 'BotsHub', 'pipeline', 'studio_entitlements.py');
    const payload = JSON.stringify([{ uid: uid, paid: true, paidUntil: PAID_UNTIL_MS }]);
    const r = spawnSync(py, [helper, 'upsert'], {
      cwd: ROOT,
      input: payload,
      encoding: 'utf8'
    });
    if (r.status === 0) console.log('local entitlements ok', (r.stdout || '').trim());
    else console.warn('local entitlements skip', (r.stderr || r.stdout || '').trim());
  } catch (e) {
    console.warn('local entitlements skip', e && e.message);
  }

  console.log(JSON.stringify({ ok: true, uid: uid, email: email, role: 'owner', paidUntil: PAID_UNTIL }));
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
