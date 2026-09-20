/**
 * signal-writer-gate.js
 * Listens to meta/signalWriter heartbeat. When the always-on server is online,
 * Electron clients skip writing activeSignals / bots tradingResults (server owns those writes).
 * Also caches whether the signed-in user has signal_writer/admin claim — normal
 * users must never write shared signals even if the server is briefly offline.
 *
 * Load AFTER renderer.js / auth-verification.js.
 */
(function () {
  const FRESH_MS = 60 * 1000;
  let lastHeartbeatAt = 0;
  let online = false;
  let unsub = null;
  let canWriteSignals = false;

  function isServerWriterOnline() {
    if (!online) return false;
    if (!lastHeartbeatAt) return false;
    return (Date.now() - lastHeartbeatAt) < FRESH_MS;
  }

  function userCanWriteSignals() {
    return !!canWriteSignals;
  }

  /** True when this Electron client must not touch activeSignals / bot tradingResults. */
  function shouldSkipClientFirebaseWrites() {
    // Shared board is owned by Railway signal-writer whenever it is healthy.
    if (isServerWriterOnline()) return true;
    // Even if the server is down, only operator accounts with the claim may backfill.
    if (!canWriteSignals) return true;
    return false;
  }

  function markFromDoc(data) {
    try {
      const updatedAt = Number(data && data.updatedAt) || 0;
      const flag = !!(data && data.online);
      lastHeartbeatAt = updatedAt || Date.now();
      online = flag && updatedAt > 0;
    } catch (e) {
      online = false;
    }
  }

  async function refreshWriteClaim(user) {
    canWriteSignals = false;
    if (!user || typeof user.getIdTokenResult !== 'function') return;
    try {
      const token = await user.getIdTokenResult();
      const claims = (token && token.claims) || {};
      canWriteSignals = !!(claims.signal_writer || claims.admin);
    } catch (e) {
      canWriteSignals = false;
    }
  }

  function start() {
    try {
      const { auth, db } = require('./auth-verification.js');
      const { doc, onSnapshot } = require('firebase/firestore');
      if (!db) return;

      const startListen = () => {
        if (unsub) return;
        try {
          const ref = doc(db, 'meta', 'signalWriter');
          unsub = onSnapshot(ref, (snap) => {
            if (!snap.exists()) {
              online = false;
              return;
            }
            markFromDoc(snap.data() || {});
          }, () => {
            online = false;
          });
        } catch (e) {
          online = false;
        }
      };

      if (auth && auth.currentUser) {
        startListen();
        refreshWriteClaim(auth.currentUser);
      }
      if (auth && typeof auth.onAuthStateChanged === 'function') {
        auth.onAuthStateChanged((user) => {
          if (user) {
            startListen();
            refreshWriteClaim(user);
          } else {
            online = false;
            canWriteSignals = false;
            if (typeof unsub === 'function') {
              try { unsub(); } catch (e) {}
              unsub = null;
            }
          }
        });
      }
    } catch (e) {
      online = false;
      canWriteSignals = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.__utkSignalWriterGate = {
    isServerWriterOnline,
    userCanWriteSignals,
    shouldSkipClientFirebaseWrites,
    getLastHeartbeatAt: () => lastHeartbeatAt,
  };

  try {
    module.exports = window.__utkSignalWriterGate;
  } catch (e) {}
})();
