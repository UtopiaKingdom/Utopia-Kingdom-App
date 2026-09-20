/**
 * bot-results-history.js
 * Load AFTER renderer.js / bot-stats.js / bot-tape-contabo.js.
 *
 * Contabo tape is the only trade history source. Hydrate on auth, keep
 * in sync via live-board lastTradeId, and force-refresh on focus so the
 * UI never needs a manual app reload.
 */
(function () {
  'use strict';

  const STATE = {
    loading: { LUMIX: true, MIRAX: true, NYX: true },
    complete: { LUMIX: false, MIRAX: false, NYX: false }
  };
  let started = false;
  const inFlight = { LUMIX: false, MIRAX: false, NYX: false };
  const lastTradeId = { LUMIX: '', MIRAX: '', NYX: '' };
  const dayFetched = { LUMIX: Object.create(null), MIRAX: Object.create(null), NYX: Object.create(null) };
  const lastFullLoadAt = { LUMIX: 0, MIRAX: 0, NYX: 0 };

  function tape() {
    try { return window.__utkBotTape || null; } catch (e) { return null; }
  }

  function getAuthUser() {
    try {
      if (typeof auth !== 'undefined' && auth && auth.currentUser) return auth.currentUser;
    } catch (e) {}
    try {
      if (typeof window !== 'undefined' && window.auth && window.auth.currentUser) {
        return window.auth.currentUser;
      }
    } catch (e2) {}
    return null;
  }

  function statsDayApi() {
    try {
      if (window.__utkStatsDay) return window.__utkStatsDay;
    } catch (e) {}
    return null;
  }

  function markDayFetched(botKey, dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return;
    dayFetched[botKey][dateKey] = true;
  }

  function markDaysFromRows(botKey, rows) {
    const api = statsDayApi();
    (rows || []).forEach(function (t) {
      const id = String((t && t.id) || '');
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z/.exec(id);
      let ms = 0;
      if (m) {
        ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
      }
      if (!ms && t) {
        ms = Number(t.closedAtMs) || Number(t.closingTime) || Number(t.timestamp) || 0;
      }
      if (!ms || !api || typeof api.dayKey !== 'function') return;
      markDayFetched(botKey, api.dayKey(ms));
    });
  }

  /** Enough tape to cover long live streaks + Last wipe context. */
  const HISTORY_FROM_MS = 45 * 24 * 60 * 60 * 1000;
  const MIN_RELOAD_GAP_MS = 8000;

  async function loadBot(botKey, force) {
    const api = tape();
    if (!api || inFlight[botKey]) return;
    if (
      !force &&
      STATE.complete[botKey] &&
      lastFullLoadAt[botKey] &&
      (Date.now() - lastFullLoadAt[botKey]) < MIN_RELOAD_GAP_MS
    ) {
      return;
    }
    inFlight[botKey] = true;
    STATE.loading[botKey] = true;
    STATE.complete[botKey] = false;
    let loaded = 0;
    let ok = false;
    try {
      const from = Date.now() - HISTORY_FROM_MS;
      const data = await api.fetchTape(botKey, '&from=' + encodeURIComponent(String(from)));
      const rows = (data && data.trades) || [];
      loaded = api.mergeRows(botKey, rows);
      markDaysFromRows(botKey, rows);
      if (data && data.board && window.__utkBotStats && typeof window.__utkBotStats.setLiveBoard === 'function') {
        try { window.__utkBotStats.setLiveBoard(botKey, data.board); } catch (e) {}
      }
      try {
        if (window.__utkStreakPersist && typeof window.__utkStreakPersist.loadContaboStreaks === 'function') {
          await window.__utkStreakPersist.loadContaboStreaks(botKey);
        }
      } catch (e) {}
      try {
        const dayApi = statsDayApi();
        if (dayApi && typeof dayApi.dayKey === 'function') {
          markDayFetched(botKey, dayApi.dayKey(Date.now()));
          const today = dayApi.rangeForMs(Date.now());
          markDayFetched(botKey, dayApi.dayKey(today.start - 1000));
        }
      } catch (e) {}
      ok = !!(data && data.ok !== false);
      if (ok) lastFullLoadAt[botKey] = Date.now();
    } catch (err) {
      try { console.warn('[results-history] tape load failed', botKey, err && err.message); } catch (e) {}
    }
    STATE.loading[botKey] = false;
    STATE.complete[botKey] = ok;
    inFlight[botKey] = false;
    api.recompute(botKey);
    try { console.log('[results-history] tape', botKey, loaded, 'trades complete=' + ok); } catch (e2) {}
  }

  async function loadDay(botKey, dateKey) {
    const key = String(botKey || '').toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return;
    if (dayFetched[key][dateKey] === true || dayFetched[key][dateKey] === 'loading') return;
    const api = tape();
    if (!api) return;
    dayFetched[key][dateKey] = 'loading';
    try {
      const data = await api.fetchTape(key, '&day=' + encodeURIComponent(dateKey));
      const rows = (data && data.trades) || [];
      api.mergeRows(key, rows);
      markDaysFromRows(key, rows);
      dayFetched[key][dateKey] = true;
      api.recompute(key);
    } catch (err) {
      dayFetched[key][dateKey] = Date.now();
      try { console.warn('[results-history] loadDay failed', key, dateKey, err && err.message); } catch (e) {}
    }
  }

  function ensureDay(botKey, dateKey) {
    const key = String(botKey || '').toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return;
    const st = dayFetched[key][dateKey];
    if (st === true || st === 'loading') return;
    if (typeof st === 'number' && (Date.now() - st) < 60000) return;
    void loadDay(key, dateKey);
  }

  async function fetchOne(botKey, id) {
    const tradeId = String(id || '').trim();
    if (!tradeId) return;
    const api = tape();
    if (!api) return;
    const store = api.getHistoryStore();
    if (store && store[botKey] && store[botKey].some(function (t) { return t && t.id === tradeId; })) {
      return;
    }
    try {
      const data = await api.fetchTrade(botKey, tradeId);
      if (data && data.trade) {
        api.mergeRows(botKey, [data.trade]);
        try {
          if (window.__utkBotStats && typeof window.__utkBotStats.reconcileConfirmedTrade === 'function') {
            window.__utkBotStats.reconcileConfirmedTrade(botKey, tradeId, data.trade);
          } else {
            api.recompute(botKey);
          }
        } catch (e) {
          api.recompute(botKey);
        }
      }
    } catch (err) {
      try { console.warn('[results-history] fetchOne failed', botKey, err && err.message); } catch (e) {}
    }
  }

  function onLiveBoard(botKey, data) {
    const key = String(botKey || '').toUpperCase();
    const id = data && data.lastTradeId;
    if (!id || lastTradeId[key] === id) return;
    lastTradeId[key] = id;
    void fetchOne(key, id);
  }

  function followBots() {
    return ['LUMIX', 'MIRAX', 'NYX'];
  }

  function load(botKey, force) {
    const doForce = !!force;
    if (!botKey) {
      followBots().forEach(function (k) { void loadBot(k, doForce); });
      return;
    }
    const key = String(botKey || '').toUpperCase();
    if (inFlight[key]) return;
    if (!doForce && STATE.complete[key]) return;
    void loadBot(key, doForce);
  }

  function reloadAll() {
    followBots().forEach(function (k) { void loadBot(k, true); });
  }

  function start() {
    if (started) return;
    if (!tape() || !getAuthUser() || !tape().getHistoryStore()) return;
    started = true;
    followBots().forEach(function (k) { void loadBot(k, true); });
  }

  window.__utkResultsHistory = Object.assign(STATE, {
    load: load,
    reloadAll: reloadAll,
    onLiveBoard: onLiveBoard,
    ensureDay: ensureDay
  });

  let tries = 0;
  const boot = setInterval(function () {
    tries += 1;
    start();
    if (started || tries > 80) clearInterval(boot);
  }, 250);

  try {
    if (typeof auth !== 'undefined' && auth && typeof auth.onAuthStateChanged === 'function') {
      auth.onAuthStateChanged(function (user) {
        if (user) {
          started = false;
          start();
        } else {
          started = false;
        }
      });
    }
  } catch (e) {}
  try {
    window.addEventListener('utk-nyx-access', function (ev) {
      if (ev && ev.detail && ev.detail.access) void loadBot('NYX', true);
    });
  } catch (e2) {}
})();
