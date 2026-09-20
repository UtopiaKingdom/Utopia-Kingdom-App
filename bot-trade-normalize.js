/**
 * Shared LUMIX / MIRAX trade field helpers.
 * Pair is always pretty OTC. Result is only WIN/LOSS. Prices skip N/A.
 */
(function (global) {
  'use strict';

  function prettyOtcPair(raw) {
    let s = String(raw || '').trim();
    if (!s || /^n\/?a$/i.test(s)) return '';
    s = s.replace(/_OTC$/i, '').replace(/\s*OTC\b/gi, '').replace(/[_-]/g, '/').trim();
    s = s.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    if (!s) return '';
    if (!s.includes('/') && /^[A-Za-z]{6}$/.test(s)) {
      s = s.slice(0, 3) + '/' + s.slice(3);
    }
    return s.toUpperCase() + ' OTC';
  }

  function outcomeOf(raw) {
    const u = String(raw == null ? '' : raw).trim().toUpperCase();
    if (u === 'WIN' || u === 'WON' || u === 'SUCCESS' || u === 'W') return 'WIN';
    if (u === 'LOSS' || u === 'LOSE' || u === 'LOST' || u === 'L') return 'LOSS';
    return '';
  }

  function usablePrice(v) {
    if (v == null || v === '' || v === 'N/A') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }

  function pairFrom(signal, fallback) {
    const cands = [
      signal && signal.selectedCurrency,
      signal && signal.symbol,
      signal && signal.currency,
      signal && signal.pair,
      fallback,
    ];
    for (let i = 0; i < cands.length; i++) {
      const pretty = prettyOtcPair(cands[i]);
      if (pretty) return pretty;
    }
    return '';
  }

  function normalizeRow(item) {
    if (!item || typeof item !== 'object') return item;
    const rawResult = item.result && typeof item.result === 'object' ? item.result.result : item.result;
    const result = outcomeOf(rawResult);
    const pair = pairFrom(item);
    const actionRaw = String(item.action || item.side || '').toUpperCase().trim();
    const action = actionRaw === 'BUY' || actionRaw === 'SELL' ? actionRaw : '';
    const out = Object.assign({}, item);
    if (result) out.result = result;
    if (pair) {
      out.symbol = pair;
      out.selectedCurrency = pair;
      out.currency = pair;
      out.isOtc = true;
      out.marketType = 'otc';
    }
    if (action) {
      out.action = action;
      out.side = action;
    }
    const phase = String(out.phase || '').toLowerCase();
    if (!phase || phase === 'result') out.phase = 'Trading Result';
    return out;
  }

  global.__utkTradeNorm = {
    prettyOtcPair,
    outcomeOf,
    usablePrice,
    pairFrom,
    normalizeRow,
  };

  try {
    module.exports = global.__utkTradeNorm;
  } catch (e) {}
})(typeof window !== 'undefined' ? window : global);
