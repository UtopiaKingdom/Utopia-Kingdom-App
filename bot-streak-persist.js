/**
 * bot-streak-persist.js
 * Live win streak from Contabo (/live). Completed win chains from Contabo
 * /streaks + the tape walk in bot-stats.js (5 losses in a row ends a streak).
 * Do not paint Firebase pastWinStreaks.
 *
 * Load AFTER renderer.js / bot-stats.js / bot-tape-contabo.js.
 */
(function () {
  'use strict';

  const botStore = require('./firebase-bot-paths.js');
  const CACHE = { LUMIX: [], MIRAX: [], NYX: [] };
  const LIVE = { LUMIX: null, MIRAX: null, NYX: null };
  const SAVED = new Set();
  let unsubscribers = [];
  let wired = false;
  let pollTimer = null;
  let streakPollAt = 0;

  function getAuthUser() {
    try {
      if (typeof auth !== 'undefined' && auth && auth.currentUser) return auth.currentUser;
    } catch (e) {}
    return null;
  }

  function shouldSkipWrites() {
    try {
      if (window.__utkSignalWriterGate && typeof window.__utkSignalWriterGate.shouldSkipClientFirebaseWrites === 'function') {
        return !!window.__utkSignalWriterGate.shouldSkipClientFirebaseWrites();
      }
    } catch (e) {}
    return true;
  }

  function toMs(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 1e11) return n;
    if (Number.isFinite(n) && n > 1e9 && n < 1e12) return n * 1000;
    try {
      if (value && typeof value.toMillis === 'function') return value.toMillis();
      if (value && typeof value.seconds === 'number') return value.seconds * 1000;
    } catch (e) {}
    return null;
  }

  function normalizeEntry(raw, id) {
    if (!raw) return null;
    const bot = botStore.normalizeBotKey(raw.bot) || null;
    const length = Math.max(0, parseInt(raw.length, 10) || 0);
    if (length <= 0) return null;
    const endedAt = toMs(raw.endedAt);
    const startedAt = raw.startedAt != null ? toMs(raw.startedAt) : null;
    return {
      id: id || raw.id || botStore.buildStreakDocId({ length, endedAt }),
      bot: bot,
      length: length,
      startedAt: startedAt,
      endedAt: endedAt
    };
  }

  function sortNewestFirst(list) {
    return list.slice().sort(function (a, b) {
      const ae = Number(a.endedAt) || 0;
      const be = Number(b.endedAt) || 0;
      if (be !== ae) return be - ae;
      return (b.length || 0) - (a.length || 0);
    });
  }

  function setCache(bot, list) {
    const key = botStore.normalizeBotKey(bot);
    if (!key) return;
    (CACHE[key] || []).forEach(function (e) {
      if (e && e.id) SAVED.delete(e.id);
    });
    CACHE[key] = sortNewestFirst(list.filter(Boolean));
    CACHE[key].forEach(function (e) {
      if (e && e.id) SAVED.add(e.id);
    });
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.setPersistedHistory === 'function') {
        window.__utkBotStats.setPersistedHistory(key, CACHE[key]);
      }
    } catch (e) {}
  }

  function mergeIntoCache(bot, entry) {
    const key = botStore.normalizeBotKey(bot);
    if (!CACHE[key]) CACHE[key] = [];
    const id = entry.id || botStore.buildStreakDocId(entry);
    entry.id = id;
    const next = CACHE[key].filter(function (e) { return e && e.id !== id; });
    next.push(entry);
    setCache(key, next);
  }

  function setLive(bot, data) {
    const key = botStore.normalizeBotKey(bot);
    if (!key) return;
    LIVE[key] = data && typeof data === 'object' ? data : null;
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.setLiveBoard === 'function') {
        window.__utkBotStats.setLiveBoard(key, LIVE[key]);
      }
    } catch (e) {}
    try {
      if (window.__utkResultsHistory && typeof window.__utkResultsHistory.onLiveBoard === 'function') {
        window.__utkResultsHistory.onLiveBoard(key, LIVE[key]);
      }
    } catch (e) {}
  }

  function bumpStats(bot) {
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.recompute === 'function') {
        window.__utkBotStats.recompute(bot);
      }
    } catch (e) {}
  }

  async function loadContaboStreaks(botKey) {
    const bot = botStore.normalizeBotKey(botKey);
    if (!bot) return [];
    let api = null;
    try { api = window.__utkBotTape; } catch (e) {}
    if (!api || typeof api.fetchStreaks !== 'function') return CACHE[bot] || [];
    try {
      const data = await api.fetchStreaks(bot);
      const rows = (data && data.streaks) || [];
      const list = rows.map(function (raw) {
        return normalizeEntry(Object.assign({ bot: bot }, raw), raw && raw.id);
      }).filter(Boolean);
      setCache(bot, list);
      bumpStats(bot);
      return CACHE[bot].slice();
    } catch (err) {
      try { console.warn('[streaks] Contabo streaks failed', bot, err && err.message); } catch (e) {}
      return CACHE[bot] || [];
    }
  }

  async function loadAllContaboStreaks() {
    const bots = ['LUMIX', 'MIRAX', 'NYX'];
    for (let i = 0; i < bots.length; i++) {
      await loadContaboStreaks(bots[i]);
    }
    streakPollAt = Date.now();
  }

  async function saveCompletedStreak(botKey, streak) {
    const bot = botStore.normalizeBotKey(botKey);
    const length = Math.max(0, parseInt(streak && streak.length, 10) || 0);
    if (!bot || length <= 0) return null;

    const endedAt = Math.trunc(Number(streak.endedAt) || Date.now());
    const startedAt = streak.startedAt != null ? Math.trunc(Number(streak.startedAt)) : null;
    const id = botStore.buildStreakDocId({ length, endedAt });
    mergeIntoCache(bot, { id: id, bot: bot, length: length, startedAt: startedAt, endedAt: endedAt });
    SAVED.add(id);

    return id;
  }

  function getPersistedHistory(botKey) {
    const key = botStore.normalizeBotKey(botKey);
    return (CACHE[key] || []).slice();
  }

  function getLastPersistedLength(botKey) {
    const list = getPersistedHistory(botKey);
    return list.length ? Math.max(0, parseInt(list[0].length, 10) || 0) : 0;
  }

  function getLiveBoard(botKey) {
    const key = botStore.normalizeBotKey(botKey);
    return LIVE[key] || null;
  }

  /** Operator fallback only. Contabo /streaks owns completed chains for UI. */
  function syncComputedCompleted(botKey, completedOldestFirst) {
    if (shouldSkipWrites()) return;
    const bot = botStore.normalizeBotKey(botKey);
    const list = Array.isArray(completedOldestFirst) ? completedOldestFirst : [];
    list.forEach(function (s) {
      if (!s || !(s.length > 0)) return;
      void saveCompletedStreak(bot, s);
    });
  }

  async function pollLive(forceStreaks) {
    let api = null;
    try { api = window.__utkBotTape; } catch (e) {}
    if (!api || typeof api.fetchLive !== 'function') return;
    try {
      const data = await api.fetchLive();
      const boards = (data && data.boards) || {};
      ['LUMIX', 'MIRAX', 'NYX'].forEach(function (bot) {
        if (boards[bot]) {
          setLive(bot, boards[bot]);
          bumpStats(bot);
        }
      });
    } catch (err) {
      try { console.warn('[streaks] tape live poll failed', err && err.message); } catch (e) {}
    }
    if (forceStreaks || (Date.now() - streakPollAt) > 60000) {
      void loadAllContaboStreaks();
    }
  }

  function pollNow() {
    void pollLive(true);
  }

  function startListeners() {
    if (wired) return;
    if (!getAuthUser()) return;
    wired = true;
    void loadAllContaboStreaks();
    void pollLive();
    pollTimer = setInterval(function () { void pollLive(); }, 4000);
  }

  function stopListeners() {
    unsubscribers.forEach(function (u) {
      try { u(); } catch (e) {}
    });
    unsubscribers = [];
    if (pollTimer) {
      try { clearInterval(pollTimer); } catch (e) {}
      pollTimer = null;
    }
    wired = false;
  }

  window.__utkStreakPersist = {
    saveCompletedStreak: saveCompletedStreak,
    syncComputedCompleted: syncComputedCompleted,
    getPersistedHistory: getPersistedHistory,
    getLastPersistedLength: getLastPersistedLength,
    getLiveBoard: getLiveBoard,
    loadContaboStreaks: loadContaboStreaks,
    loadAllContaboStreaks: loadAllContaboStreaks,
    pollNow: pollNow,
    startListeners: startListeners,
    stopListeners: stopListeners
  };

  let tries = 0;
  const boot = setInterval(function () {
    tries += 1;
    startListeners();
    if (wired || tries > 80) clearInterval(boot);
  }, 250);

  try {
    if (typeof auth !== 'undefined' && auth && typeof auth.onAuthStateChanged === 'function') {
      auth.onAuthStateChanged(function (user) {
        if (user) startListeners();
        else stopListeners();
      });
    }
  } catch (e) {}
})();
