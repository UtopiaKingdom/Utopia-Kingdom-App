/**
 * bot-signal-wait.js — Average wait between new signals (attempt 1 / chain starts)
 * over a rolling 3-hour window. Used by house bots and Studio desks.
 */
(function (root) {
  'use strict';

  const WINDOW_MS = 3 * 60 * 60 * 1000;
  const CLUSTER_MS = 20 * 1000;

  function toMs(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 0 && value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'object') {
      try {
        if (typeof value.toMillis === 'function') return value.toMillis() || 0;
        if (typeof value.seconds === 'number') return value.seconds * 1000;
      } catch (e) {}
    }
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function tradeOpenMs(t) {
    if (!t || typeof t !== 'object') return 0;
    return (
      toMs(t.openedAtMs) ||
      toMs(t.openingTime) ||
      toMs(t.sentAtMs) ||
      toMs(t.timestamp) ||
      toMs(t.createdAt) ||
      toMs(t.closedAtMs) ||
      toMs(t.closingTime) ||
      0
    );
  }

  function tradeAttempt(t) {
    if (t && t.attempt != null && Number.isFinite(Number(t.attempt))) {
      return Math.min(5, Math.max(1, Math.trunc(Number(t.attempt))));
    }
    const id = String((t && t.id) || '');
    const m = /(?:^|__)a(\d+)(?:__|$)/.exec(id);
    if (m) return Math.min(5, Math.max(1, parseInt(m[1], 10) || 1));
    if (t && t.martingaleStep != null && Number.isFinite(Number(t.martingaleStep))) {
      return Math.min(5, Math.max(1, Math.trunc(Number(t.martingaleStep))));
    }
    if (t && t.stakeMultiplier != null && Number.isFinite(Number(t.stakeMultiplier))) {
      const sm = Number(t.stakeMultiplier);
      if (sm <= 1) return 1;
      if (sm <= 2) return 2;
      if (sm <= 4) return 3;
      if (sm <= 10) return 4;
      return 5;
    }
    return 1;
  }

  function isChainStart(t) {
    return tradeAttempt(t) === 1;
  }

  function formatWait(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 45000) return Math.max(1, Math.round(n / 1000)) + 's';
    const mins = Math.round(n / 60000);
    if (mins < 60) return Math.max(1, mins) + 'm';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? (h + 'h ' + m + 'm') : (h + 'h');
  }

  function clusterTimes(times) {
    const out = [];
    (times || []).forEach(function (ms) {
      if (!(ms > 0)) return;
      if (!out.length || ms - out[out.length - 1] >= CLUSTER_MS) out.push(ms);
    });
    return out;
  }

  function fromTrades(trades, nowMs) {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const start = now - WINDOW_MS;
    const times = [];
    (Array.isArray(trades) ? trades : []).forEach(function (t) {
      if (!isChainStart(t)) return;
      const ms = tradeOpenMs(t);
      if (ms >= start && ms <= now) times.push(ms);
    });
    times.sort(function (a, b) { return a - b; });
    const starts = clusterTimes(times);
    const gaps = [];
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      if (gap >= CLUSTER_MS) gaps.push(gap);
    }
    const n = starts.length;
    if (gaps.length < 1) {
      return {
        label: '—',
        ms: null,
        signals: n,
        gaps: 0,
        title: n < 1
          ? 'Average wait between new signals over the last 3 hours. No new signals in that window yet.'
          : 'Average wait between new signals over the last 3 hours. Need at least 2 new signals to measure.'
      };
    }
    const avg = gaps.reduce(function (s, g) { return s + g; }, 0) / gaps.length;
    const label = formatWait(avg);
    return {
      label: label,
      ms: avg,
      signals: n,
      gaps: gaps.length,
      title: 'Average wait between new signals over the last 3 hours (' +
        n + ' signal' + (n === 1 ? '' : 's') + ', ' +
        gaps.length + ' gap' + (gaps.length === 1 ? '' : 's') + ').'
    };
  }

  function applyToItem(item, wait) {
    if (!item) return wait;
    const valueEl = item.querySelector('.stat-value') || item;
    const next = (wait && wait.label) || '—';
    if (valueEl && valueEl.textContent !== next) valueEl.textContent = next;
    if (wait && wait.title) item.setAttribute('title', wait.title);
    return wait;
  }

  const api = {
    WINDOW_MS: WINDOW_MS,
    formatWait: formatWait,
    fromTrades: fromTrades,
    isChainStart: isChainStart,
    tradeOpenMs: tradeOpenMs,
    applyToItem: applyToItem
  };

  try { if (root) root.__utkSignalWait = api; } catch (e) {}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
