const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccountKey.json')) });

const uid = process.argv[2];
if (!uid) {
  console.error('Usage: node set-signal-writer.js <uid>');
  process.exit(1);
}

admin.auth().setCustomUserClaims(uid, { signal_writer: true })
  .then(() => {
    console.log('signal_writer claim set for', uid);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
