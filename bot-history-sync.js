/**
 * bot-history-sync.js
 * Keeps Contabo tape history + live streaks fresh while the app is open.
 * Load AFTER bot-results-history.js / bot-streak-persist.js.
 */
(function () {
  'use strict';

  let lastFocusReloadAt = 0;
  const FOCUS_RELOAD_GAP_MS = 12000;

  function refreshLive() {
    try {
      if (window.__utkStreakPersist && typeof window.__utkStreakPersist.pollNow === 'function') {
        void window.__utkStreakPersist.pollNow();
        return;
      }
    } catch (e) {}
    try {
      if (window.__utkStreakPersist && typeof window.__utkStreakPersist.loadAllContaboStreaks === 'function') {
        void window.__utkStreakPersist.loadAllContaboStreaks();
      }
    } catch (e2) {}
  }

  function refreshHistory(force) {
    try {
      if (window.__utkResultsHistory && typeof window.__utkResultsHistory.reloadAll === 'function') {
        window.__utkResultsHistory.reloadAll();
        return;
      }
      if (window.__utkResultsHistory && typeof window.__utkResultsHistory.load === 'function') {
        window.__utkResultsHistory.load(null, !!force);
      }
    } catch (e) {}
  }

  function onAppVisible() {
    const now = Date.now();
    if ((now - lastFocusReloadAt) < FOCUS_RELOAD_GAP_MS) {
      refreshLive();
      return;
    }
    lastFocusReloadAt = now;
    refreshHistory(true);
    refreshLive();
  }

  function wire() {
    try {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') onAppVisible();
      });
    } catch (e) {}
    try {
      window.addEventListener('focus', function () { onAppVisible(); });
    } catch (e2) {}
    try {
      window.addEventListener('online', function () { onAppVisible(); });
    } catch (e3) {}
    try {
      window.addEventListener('utk:auth-ready', function () { onAppVisible(); });
    } catch (e4) {}
  }

  wire();
  window.__utkHistorySync = {
    refresh: onAppVisible,
    refreshLive: refreshLive,
    refreshHistory: refreshHistory
  };
})();
