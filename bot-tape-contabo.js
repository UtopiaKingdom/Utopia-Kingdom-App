/**
 * bot-tape-contabo.js
 * Shared WIN/LOSS tape over https://utkingdom.com/api/bot-tape (Cloudflare → Contabo).
 * Load after renderer.js. Do not talk to Firestore for history.
 */
(function () {
  'use strict';

  const BASES = [
    'https://utkingdom.com/api/bot-tape',
    'http://169.58.151.111:8788'
  ];
  let chosen = '';

  function getHistoryStore() {
    try {
      if (typeof window !== 'undefined' && window.signalHistory) return window.signalHistory;
    } catch (e) {}
    try {
      if (typeof signalHistory !== 'undefined' && signalHistory) return signalHistory;
    } catch (e2) {}
    return null;
  }

  function normalizeRow(row) {
    const item = row && typeof row === 'object' ? Object.assign({}, row) : row;
    try {
      if (window.__utkTradeNorm && typeof window.__utkTradeNorm.normalizeRow === 'function') {
        return window.__utkTradeNorm.normalizeRow(item) || item;
      }
    } catch (e) {}
    return item;
  }

  function mergeRows(botKey, rows) {
    const store = getHistoryStore();
    if (!store) return 0;
    if (!store[botKey]) store[botKey] = [];
    const extras = [];
    const byId = Object.create(null);
    store[botKey].forEach(function (t) {
      if (!t) return;
      if (t.id && !t.optimistic && !(t.localOnly && t.chainReset)) {
        byId[t.id] = t;
        return;
      }
      extras.push(t);
    });
    (rows || []).forEach(function (raw) {
      const t = normalizeRow(raw);
      if (t && t.id) byId[t.id] = t;
    });
    const confirmed = Object.keys(byId).map(function (k) { return byId[k]; });
    const fillOf = function (t) {
      try {
        if (window.__utkBotStats && typeof window.__utkBotStats.tradeFillIdentity === 'function') {
          return window.__utkBotStats.tradeFillIdentity(t);
        }
      } catch (e) {}
      const open = Number((t && (t.openedAtMs || t.openingTime || t.timestamp)) || 0) || 0;
      const sym = String((t && (t.symbol || t.selectedCurrency || t.currency)) || '')
        .toUpperCase().replace(/[^A-Z0-9]/g, '');
      return String(botKey || '') + '|' + sym + '|' + open;
    };
    const confirmedFill = Object.create(null);
    confirmed.forEach(function (t) { confirmedFill[fillOf(t)] = true; });
    const keptExtras = extras.filter(function (t) {
      if (!t) return false;
      if (t.localOnly && t.chainReset) return true;
      if (!t.optimistic) return true;
      return !confirmedFill[fillOf(t)];
    });
    store[botKey] = keptExtras.concat(confirmed);
    try { window.signalHistory = store; } catch (e) {}
    return Object.keys(byId).length;
  }

  function recompute(botKey) {
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.recompute === 'function') {
        window.__utkBotStats.recompute(botKey);
      }
    } catch (e) {}
  }

  async function getJson(path) {
    let lastErr = null;
    const order = [];
    if (chosen) order.push(chosen);
    BASES.forEach(function (b) {
      if (order.indexOf(b) < 0) order.push(b);
    });
    for (let i = 0; i < order.length; i++) {
      const base = order[i];
      try {
        const res = await fetch(base + path, { method: 'GET', cache: 'no-store' });
        if (!res.ok) throw new Error('tape http ' + res.status);
        const data = await res.json();
        if (!data || data.ok === false) throw new Error((data && data.error) || 'tape error');
        chosen = base;
        return data;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('tape unreachable');
  }

  async function fetchTape(botKey, extra) {
    const q = extra || '';
    return getJson('/tape?bot=' + encodeURIComponent(botKey) + q);
  }

  async function fetchStreaks(botKey) {
    return getJson('/streaks?bot=' + encodeURIComponent(botKey));
  }

  async function fetchLive(botKey) {
    const q = botKey ? ('?bot=' + encodeURIComponent(botKey)) : '';
    return getJson('/live' + q);
  }

  async function fetchTrade(botKey, id) {
    return getJson(
      '/trade?bot=' + encodeURIComponent(botKey) + '&id=' + encodeURIComponent(id)
    );
  }

  async function fetchSignal(botKey) {
    const q = botKey ? ('?bot=' + encodeURIComponent(botKey)) : '';
    return getJson('/signal' + q);
  }

  async function fetchNyxMind() {
    return getJson('/nyx/mind');
  }

  async function fetchMind(botKey) {
    const key = String(botKey || 'NYX').toUpperCase();
    if (key === 'NYX') {
      try {
        return await getJson('/mind?bot=NYX');
      } catch (e) {
        return fetchNyxMind();
      }
    }
    return getJson('/mind?bot=' + encodeURIComponent(key));
  }

  window.__utkBotTape = {
    BASE: BASES[0],
    mergeRows: mergeRows,
    recompute: recompute,
    getHistoryStore: getHistoryStore,
    fetchTape: fetchTape,
    fetchStreaks: fetchStreaks,
    fetchLive: fetchLive,
    fetchTrade: fetchTrade,
    fetchSignal: fetchSignal,
    fetchNyxMind: fetchNyxMind,
    fetchMind: fetchMind
  };
})();
