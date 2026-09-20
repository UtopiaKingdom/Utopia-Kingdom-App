// revoke-admin.js
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });

const uid = process.argv[2];
if (!uid) { console.error('Usage: node revoke-admin.js <uid>'); process.exit(1); }

// Remove all custom claims for that user (or pass { admin: false } to keep others)
admin.auth().setCustomUserClaims(uid, null)
  .then(() => { console.log('Admin claim removed for', uid); process.exit(0); })
  .catch(err => { console.error(err); process.exit(1); });