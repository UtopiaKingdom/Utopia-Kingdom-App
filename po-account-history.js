/**
 * po-account-history.js
 * Auto Trade ON: keep Contabo tape for rich history (prices, Move).
 * PO wallet fills are indexed separately — filter/enrich tape to autotraded
 * deals only; saving ladder uses PO outcomes when available.
 */
(function () {
  'use strict';

  const { ipcRenderer } = require('electron');

  const BOT_ID = { LUMIX: 'bot1', MIRAX: 'bot2', NYX: 'bot3' };
  const ID_TO_KEY = { bot1: 'LUMIX', bot2: 'MIRAX', bot3: 'NYX' };

  /** @type {Record<string, Record<string, object>>} botKey -> dealId -> po row */
  const poByBot = { LUMIX: Object.create(null), MIRAX: Object.create(null), NYX: Object.create(null) };

  const mainAtCache = { bot1: false, bot2: false, bot3: false, at: 0 };

  function botKeyFromId(botId) {
    return ID_TO_KEY[String(botId || '').trim()] || null;
  }

  function botIdFromKey(botKey) {
    try {
      if (typeof botIdMap === 'object' && botIdMap && botIdMap[botKey]) {
        return botIdMap[botKey];
      }
    } catch (e) {}
    return BOT_ID[String(botKey || '').toUpperCase()] || null;
  }

  function toggleOn(botId) {
    try {
      const toggle = document.getElementById('autoTradeToggle-' + botId);
      return !!(toggle && toggle.checked);
    } catch (e) {
      return false;
    }
  }

  async function refreshMainAtCache() {
    try {
      const st = await ipcRenderer.invoke('get-autotrade-enabled');
      if (st && typeof st === 'object') {
        ['bot1', 'bot2', 'bot3'].forEach(function (id) {
          mainAtCache[id] = st[id] === true;
        });
        mainAtCache.at = Date.now();
      }
    } catch (e) {}
  }

  function shouldUsePoHistory(botKey) {
    try {
      if (typeof window.isAutoTradeEnabled === 'function') {
        return !!window.isAutoTradeEnabled(botKey);
      }
    } catch (e) {}
    const botId = botIdFromKey(botKey);
    if (!botId) return false;
    if (toggleOn(botId)) return true;
    if (mainAtCache.at && (Date.now() - mainAtCache.at) < 60000) {
      return mainAtCache[botId] === true;
    }
    return false;
  }

  function toEpochMs(v) {
    if (v == null || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }

  function pairKey(raw) {
    return String(raw || '')
      .toUpperCase()
      .replace(/\bOTC\b/g, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  function tradeOpenMs(t) {
    return (
      toEpochMs(t && t.openedAtMs) ||
      toEpochMs(t && t.openingTime) ||
      toEpochMs(t && t.timestamp) ||
      0
    );
  }

  function normSide(raw) {
    const u = String(raw || '').trim().toUpperCase();
    if (u === 'BUY' || u === 'CALL' || u === 'UP' || u === '0') return 'BUY';
    if (u === 'SELL' || u === 'PUT' || u === 'DOWN' || u === '1') return 'SELL';
    return u === 'BUY' || u === 'SELL' ? u : '';
  }

  function outcomeToResult(outcome, profit) {
    const o = String(outcome || '').toLowerCase();
    if (o === 'win') return 'WIN';
    if (o === 'loss') return 'LOSS';
    if (o === 'draw') return 'LOSS';
    const p = profit != null ? Number(profit) : NaN;
    if (Number.isFinite(p) && p > 0) return 'WIN';
    if (Number.isFinite(p) && p < 0) return 'LOSS';
    return null;
  }

  function resolveResult(data) {
    const fromLabel = outcomeToResult(data.outcome, data.profit);
    if (fromLabel) return fromLabel;
    const r = String(data.result || '').trim().toUpperCase();
    if (r === 'WIN' || r === 'WON' || r === 'W') return 'WIN';
    if (r === 'LOSS' || r === 'LOSE' || r === 'LOST' || r === 'L') return 'LOSS';
    return null;
  }

  function resolveTimes(data) {
    const placedAt = toEpochMs(data.placedAt || data.open_time || data.openTime || data.openingTime || data.openedAtMs);
    let settleAt = toEpochMs(data.settleAt || data.close_time || data.closeTime || data.closingTime || data.closedAtMs);
    const durSec = Math.max(1, Number(data.durationSec) || Number(data.duration) || 60);
    const open = placedAt || Date.now();
    if (!settleAt || settleAt < open) settleAt = open + durSec * 1000;
    return { placedAt: open, settleAt: settleAt, durationSec: durSec };
  }

  function dealToRecord(deal, meta) {
    if (!deal) return null;
    const dealId = String(deal.dealId || deal.deal_id || deal.id || '').trim();
    if (!dealId) return null;
    const result = resolveResult(deal);
    if (!result) return null;
    const times = resolveTimes(deal);
    const side = normSide(deal.side || deal.direction || deal.action);
    let currency = deal.currency || deal.asset || deal.symbol || '';
    try {
      if (window.__utkTradeNorm && typeof window.__utkTradeNorm.prettyOtcPair === 'function') {
        currency = window.__utkTradeNorm.prettyOtcPair(currency) || currency;
      }
    } catch (e) {}
    return {
      dealId: dealId,
      result: result,
      currency: currency,
      side: side,
      amount: deal.amount,
      attempt: Math.max(1, parseInt(meta && meta.attempt, 10) || parseInt(deal.attempt, 10) || 1),
      profit: deal.profit,
      placedAt: times.placedAt,
      settleAt: times.settleAt,
      durationSec: times.durationSec
    };
  }

  function poList(botKey) {
    const key = String(botKey || '').toUpperCase();
    const map = poByBot[key] || Object.create(null);
    return Object.keys(map).map(function (k) { return map[k]; });
  }

  function upsertPo(botKey, record) {
    const key = String(botKey || '').toUpperCase();
    if (!poByBot[key]) poByBot[key] = Object.create(null);
    poByBot[key][record.dealId] = record;
  }

  function matchesTape(tape, po, loose) {
    if (!tape || !po) return false;
    const tp = pairKey(tape.symbol || tape.currency || tape.selectedCurrency);
    const pp = pairKey(po.currency);
    if (!tp || !pp || tp !== pp) return false;
    const tOpen = tradeOpenMs(tape);
    const pOpen = Number(po.placedAt) || 0;
    if (!tOpen || !pOpen) return !!loose;
    const slack = loose ? 120000 : 90000;
    if (Math.abs(tOpen - pOpen) > slack) return false;
    if (!loose) {
      const ta = Math.max(1, parseInt(tape.attempt, 10) || 1);
      const pa = Math.max(1, parseInt(po.attempt, 10) || 1);
      if (ta !== pa && Math.abs(tOpen - pOpen) > 8000) return false;
    }
    return true;
  }

  function enrichTape(tape, po) {
    return Object.assign({}, tape, {
      poAccount: true,
      poDealId: po.dealId,
      result: po.result || tape.result,
      attempt: po.attempt || tape.attempt,
      stakeAmount: po.amount != null ? po.amount : tape.stakeAmount
    });
  }

  function patchTapeMatch(botKey, po) {
    try {
      const hist = window.signalHistory && window.signalHistory[botKey];
      if (!hist || !Array.isArray(hist)) return false;
      for (let i = 0; i < hist.length; i++) {
        const t = hist[i];
        if (!t || t.localOnly) continue;
        if (matchesTape(t, po, false) || matchesTape(t, po, true)) {
          hist[i] = enrichTape(t, po);
          window.signalHistory = window.signalHistory;
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function applyPoDeal(botKey, data) {
    const record = dealToRecord(data, data);
    if (!record) return false;
    upsertPo(botKey, record);
    patchTapeMatch(botKey, record);
    return true;
  }

  function poToSavingRow(po) {
    return {
      id: 'po__' + String(po.dealId || ''),
      poAccount: true,
      result: po.result,
      attempt: po.attempt,
      symbol: po.currency,
      currency: po.currency,
      selectedCurrency: po.currency,
      action: po.side,
      side: po.side,
      openedAtMs: po.placedAt,
      closedAtMs: po.settleAt,
      openingTime: po.placedAt,
      closingTime: po.settleAt,
      timestamp: po.placedAt,
      phase: 'Trading Result'
    };
  }

  /**
   * History modal + stats display: tape rows with prices; when AT on, only
   * fills that match a PO deal (enriched with wallet result).
   */
  function historyForDisplay(botKey, list) {
    const rows = (list || []).slice();
    if (!shouldUsePoHistory(botKey)) return rows;
    const deals = poList(botKey);
    if (!deals.length) return rows;
    const used = Object.create(null);
    const out = [];
    rows.forEach(function (t) {
      if (!t) return;
      const po = deals.find(function (p) {
        return !used[p.dealId] && (matchesTape(t, p, false) || matchesTape(t, p, true));
      });
      if (po) {
        used[po.dealId] = true;
        out.push(enrichTape(t, po));
      }
    });
    deals.forEach(function (po) {
      if (used[po.dealId]) return;
      const twin = rows.find(function (t) { return matchesTape(t, po, true); });
      if (twin) out.push(enrichTape(twin, po));
    });
    if (!out.length) return rows;
    return out;
  }

  /** Saving ladder: PO deal sequence when AT on. */
  function historyForSaving(botKey, list) {
    if (!shouldUsePoHistory(botKey)) return list || [];
    const deals = poList(botKey).slice().sort(function (a, b) {
      return (Number(b.placedAt) || 0) - (Number(a.placedAt) || 0);
    });
    if (!deals.length) return historyForDisplay(botKey, list || []);
    return deals.map(poToSavingRow);
  }

  /** @deprecated use historyForDisplay */
  function filterTrades(botKey, list) {
    return historyForDisplay(botKey, list);
  }

  function refreshUi(botKey) {
    try {
      if (window.__utkHistoryUi && typeof window.__utkHistoryUi.refresh === 'function') {
        window.__utkHistoryUi.refresh(botKey);
      } else if (typeof window.__utkRenderHistory === 'function') {
        const modal = document.getElementById('history-modal');
        if (modal && modal.classList.contains('active')) {
          window.__utkRenderHistory(botKey, { keepScroll: true });
        }
      }
    } catch (e) {}
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.recompute === 'function') {
        window.__utkBotStats.recompute(botKey);
      }
    } catch (e2) {}
  }

  function onPoDealResult(data) {
    if (!data || !data.botId) return;
    const botKey = botKeyFromId(data.botId);
    if (!botKey) return;
    const outcome = String(data.outcome || '').toLowerCase();
    if (outcome !== 'win' && outcome !== 'loss' && outcome !== 'draw') return;
    applyPoDeal(botKey, data);
    refreshUi(botKey);
  }

  function removeOrphanPoRows(botKey) {
    try {
      const hist = window.signalHistory && window.signalHistory[botKey];
      if (!hist || !Array.isArray(hist)) return;
      const cleaned = hist.filter(function (t) {
        if (!t) return false;
        if (t.id && String(t.id).indexOf('po__') === 0) return false;
        return true;
      });
      if (cleaned.length !== hist.length) {
        window.signalHistory[botKey] = cleaned;
      }
    } catch (e) {}
  }

  async function hydrateBot(botKey, opts) {
    opts = opts || {};
    await refreshMainAtCache();
    if (!shouldUsePoHistory(botKey) && !opts.force) return;
    const botId = botIdFromKey(botKey);
    if (!botId) return;

    let localByDeal = Object.create(null);
    try {
      const all = await ipcRenderer.invoke('po-account-trades-history');
      ((all && all[botId]) || []).forEach(function (snap) {
        if (snap && snap.dealId) localByDeal[String(snap.dealId)] = snap;
      });
    } catch (e) {}

    let applied = 0;
    try {
      const wallet = await ipcRenderer.invoke('po-fetch-wallet-history', { botId: botId, limit: 120 });
      ((wallet && wallet.closed) || []).forEach(function (deal) {
        const id = String(deal.id || deal.deal_id || '').trim();
        const meta = localByDeal[id] || null;
        const rec = dealToRecord(Object.assign({}, deal, {
          dealId: id,
          currency: deal.asset || deal.currency,
          attempt: meta && meta.attempt
        }), meta);
        if (rec) {
          upsertPo(botKey, rec);
          if (patchTapeMatch(botKey, rec)) applied += 1;
        }
      });
    } catch (err) {
      try { console.warn('[po-account-history] wallet hydrate failed', botKey, err && err.message); } catch (e) {}
    }

    try {
      const all = await ipcRenderer.invoke('po-account-trades-history');
      ((all && all[botId]) || []).forEach(function (snap) {
        const rec = dealToRecord(snap, snap);
        if (rec) {
          upsertPo(botKey, rec);
          if (patchTapeMatch(botKey, rec)) applied += 1;
        }
      });
    } catch (e2) {}

    removeOrphanPoRows(botKey);

    try {
        window.__utkResultsHistory.load(botKey, true);
      }
    } catch (e3) {}

    refreshUi(botKey);
    try { console.log('[po-account-history]', botKey, 'PO index', poList(botKey).length, 'patched', applied); } catch (e4) {}
  }

  async function hydrateAll() {
    await refreshMainAtCache();
    await Promise.all(['LUMIX', 'MIRAX', 'NYX'].map(function (k) { return hydrateBot(k); }));
  }

  function wireAutotradeToggles() {
    ['bot1', 'bot2', 'bot3'].forEach(function (botId) {
      const toggle = document.getElementById('autoTradeToggle-' + botId);
      if (!toggle || toggle.dataset.poHistWired === '1') return;
      toggle.dataset.poHistWired = '1';
      toggle.addEventListener('change', function () {
        void refreshMainAtCache();
        const botKey = botKeyFromId(botId);
        if (!botKey) return;
        if (toggle.checked) {
          void hydrateBot(botKey, { force: true });
        } else {
          try {
            if (window.__utkResultsHistory && typeof window.__utkResultsHistory.reloadAll === 'function') {
              window.__utkResultsHistory.reloadAll();
            } else if (window.__utkResultsHistory && typeof window.__utkResultsHistory.load === 'function') {
              window.__utkResultsHistory.load(botKey, true);
            }
          } catch (e) {}
          refreshUi(botKey);
        }
      });
    });
  }

  function installHistoryHook() {
    const orig = window.__utkRenderHistory || window.renderHistoryModal;
    if (!orig || orig.__poPatched) return;
    function wrapped(botKey, opts) {
      const run = function () { orig.call(window, botKey, opts); };
      if (shouldUsePoHistory(botKey)) {
        void hydrateBot(botKey).then(run).catch(run);
      } else {
        run();
      }
    }
    wrapped.__poPatched = true;
    window.__utkRenderHistory = wrapped;
    window.renderHistoryModal = wrapped;
  }

  try {
    ipcRenderer.on('po-deal-result', function (_event, data) {
      onPoDealResult(data);
    });
  } catch (e) {}

  window.__utkPoAccountHistory = {
    shouldUsePoHistory: shouldUsePoHistory,
    historyForDisplay: historyForDisplay,
    historyForSaving: historyForSaving,
    filterTrades: filterTrades,
    hydrateAll: hydrateAll,
    hydrateBot: hydrateBot,
    applyPoDeal: applyPoDeal,
    refreshMainAtCache: refreshMainAtCache,
    installHistoryHook: installHistoryHook,
    poList: poList
  };

  setTimeout(function () {
    wireAutotradeToggles();
    installHistoryHook();
    void hydrateAll();
  }, 400);
  setTimeout(function () {
    wireAutotradeToggles();
    installHistoryHook();
  }, 2500);
  setInterval(refreshMainAtCache, 15000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) void hydrateAll();
  });
})();
