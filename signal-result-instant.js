/**
 * signal-result-instant.js
 * Paint Trading Result immediately (before phase queue / Firebase).
 * Poll Contabo /signal when expiry hits so results never vanish silently.
 * Load AFTER renderer.js and signal-card-ttl.js.
 */
(function () {
  'use strict';

  const paintedAt = Object.create(null);
  const paintedKey = Object.create(null);
  const expiryPoll = Object.create(null);

  function hooks() {
    try { return window.__utkSignalHooks || null; } catch (e) { return null; }
  }

  function normPhase(raw) {
    const p = String(raw || '').trim().toLowerCase();
    if (p === 'trading result' || p === 'result') return 'Trading Result';
    return String(raw || '').trim();
  }

  function isResultPhase(signal) {
    return normPhase(signal && signal.phase) === 'Trading Result';
  }

  function paintKeyOf(botKey, signal) {
    const id = String((signal && (signal.signalId || signal.signal_id)) || '').trim();
    const open = Number(signal && (signal.openedAtMs || signal.openingTime)) || 0;
    const attempt = Number(signal && signal.attempt) || 1;
    return String(botKey || '') + '|' + id + '|' + open + '|a' + attempt;
  }

  function wasPainted(botKey, signal) {
    const key = paintKeyOf(botKey, signal);
    const at = paintedAt[botKey] || 0;
    return paintedKey[botKey] === key && (Date.now() - at) < 15000;
  }

  function consumePainted(botKey, signal) {
    if (!wasPainted(botKey, signal)) return false;
    return true;
  }

  function resolveSide(signal, botKey) {
    const h = hooks();
    const norm = h && typeof h.normalizeTradeSide === 'function'
      ? h.normalizeTradeSide
      : function (raw) {
        const u = String(raw || '').trim().toUpperCase();
        return u === 'BUY' || u === 'SELL' ? u : '';
      };
    let action = norm(signal.action || signal.side);
    if (!action && h && h.lastSignalAction) {
      action = h.lastSignalAction[botKey] || '';
    }
    return action;
  }

  function resolvePair(signal, botKey) {
    try {
      if (typeof window.resolveCurrency === 'function') {
        const c = window.resolveCurrency(signal);
        if (c) return c;
      }
    } catch (e) {}
    const h = hooks();
    if (h && h.lastSignalCurrency && h.lastSignalCurrency[botKey]) {
      return h.lastSignalCurrency[botKey];
    }
    return signal.selectedCurrency || signal.symbol || signal.currency || '';
  }

  function toMs(v) {
    try {
      if (typeof window.toEpochMs === 'function') return window.toEpochMs(v);
    } catch (e) {}
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    return null;
  }

  function buildResultPayload(botKey, signal) {
    const h = hooks();
    const action = resolveSide(signal, botKey);
    const pair = resolvePair(signal, botKey);
    let openingPrice =
      signal.openingPrice ?? signal.opening_price ?? signal.openPrice ?? signal.open_price ??
      (h && h.lastSignalPrice ? h.lastSignalPrice[botKey] : null);
    if (openingPrice != null && openingPrice !== 'N/A' && h && h.lastSignalPrice) {
      h.lastSignalPrice[botKey] = openingPrice;
    }
    const openingTime =
      toMs(signal.openedAtMs) ?? toMs(signal.openingTime) ?? toMs(signal.opening_time) ??
      toMs(signal.startTime) ?? (h && h.lastSignalTime ? toMs(h.lastSignalTime[botKey]) : null) ??
      toMs(signal.time) ?? Date.now();
    const closingTime =
      toMs(signal.closedAtMs) ?? toMs(signal.closingTime) ?? toMs(signal.closing_time) ??
      toMs(signal.closeTime) ?? toMs(signal.endTime) ?? Date.now();
    const closingPrice =
      signal.closingPrice ?? signal.closing_price ?? signal.closePrice ??
      signal.close_price ?? signal.price ?? null;

    const out = Object.assign({}, signal, {
      bot: botKey,
      phase: 'Trading Result',
      action: action,
      side: action || signal.side,
      selectedCurrency: pair || signal.selectedCurrency,
      symbol: signal.symbol || pair,
      currency: signal.currency || pair,
      openingPrice: openingPrice,
      openingTime: openingTime,
      closingPrice: closingPrice,
      closingTime: closingTime,
      openedAtMs: toMs(signal.openedAtMs) || openingTime,
      closedAtMs: toMs(signal.closedAtMs) || closingTime,
      countdown: null
    });
    if (pair && h && h.lastSignalCurrency) h.lastSignalCurrency[botKey] = pair;
    if (action && h && h.lastSignalAction) h.lastSignalAction[botKey] = action;
    return out;
  }

  function paint(botKey, signal) {
    if (!botKey || !signal || !isResultPhase(signal)) return false;
    const h = hooks();
    if (!h) return false;

    try {
      const guard = window.BotPhaseGuard;
      if (guard && typeof guard.shouldAcceptPhase === 'function') {
        const verdict = guard.shouldAcceptPhase(botKey, signal);
        if (verdict && verdict.ok === false) return false;
      }
    } catch (e) {}

    const payload = buildResultPayload(botKey, signal);
    if (typeof h.cancelResultAutoClear === 'function') h.cancelResultAutoClear(botKey);
    if (typeof h.clearCountdown === 'function') h.clearCountdown(botKey);
    stopExpiryPoll(botKey);

    if (typeof h.scheduleRenderSignal === 'function') {
      h.scheduleRenderSignal(botKey, payload);
    }
    if (typeof h.applyPhaseGlow === 'function') {
      h.applyPhaseGlow(botKey, { phase: 'Trading Result', result: payload.result, action: payload.action });
    }
    if (typeof h.setTradeStatus === 'function') {
      h.setTradeStatus(botKey, 'Result: ' + (payload.result || ''));
    }
    try { window.BotPhaseGuard?.notePhaseAccepted?.(botKey, payload); } catch (e2) {}
    if (h.suppressPreparingUntilSignal) h.suppressPreparingUntilSignal[botKey] = true;
    if (typeof h.scheduleResultAutoClear === 'function') {
      h.scheduleResultAutoClear(botKey, 10000);
    }

    paintedAt[botKey] = Date.now();
    paintedKey[botKey] = paintKeyOf(botKey, signal);
    try {
      window.dispatchEvent(new CustomEvent('utk:signal-result-painted', { detail: { bot: botKey } }));
    } catch (e3) {}
    return true;
  }

  function paintFromWs(signal) {
    const botKey = String((signal && signal.bot) || '').toUpperCase();
    if (!botKey) return false;
    return paint(botKey, signal);
  }

  function showSettling(botKey) {
    const h = hooks();
    if (!h || typeof h.scheduleRenderSignal !== 'function') return;
    const pair = (h.lastSignalCurrency && h.lastSignalCurrency[botKey]) || '';
    const action = (h.lastSignalAction && h.lastSignalAction[botKey]) || '';
    h.scheduleRenderSignal(botKey, {
      bot: botKey,
      phase: 'Signal',
      selectedCurrency: pair,
      symbol: pair,
      currency: pair,
      action: action,
      side: action,
      countdown: 0,
      settling: true,
      statusText: 'Settling…'
    });
    if (typeof h.setTradeStatus === 'function') h.setTradeStatus(botKey, 'Settling…');
  }

  function stopExpiryPoll(botKey) {
    const st = expiryPoll[botKey];
    if (!st) return;
    if (st.timer) {
      try { clearInterval(st.timer); } catch (e) {}
    }
    if (st.deadlineTimer) {
      try { clearTimeout(st.deadlineTimer); } catch (e) {}
    }
    delete expiryPoll[botKey];
  }

  function startExpiryPoll(botKey) {
    if (!botKey || expiryPoll[botKey]) return;
    showSettling(botKey);

    const started = Date.now();
    const maxMs = 20000;
    const poll = async function () {
      if (wasPainted(botKey, { attempt: 1 }) && paintedAt[botKey] && (Date.now() - paintedAt[botKey]) < 3000) {
        return;
      }
      try {
        const api = window.__utkBotTape;
        if (!api || typeof api.fetchSignal !== 'function') return;
        const data = await api.fetchSignal(botKey);
        const sig = data && data.signal;
        if (sig && isResultPhase(sig)) {
          if (paint(botKey, sig)) return;
        }
      } catch (e) {}
      try {
        if (typeof window.__rehydrateActiveSignal === 'object' &&
            typeof window.__rehydrateActiveSignal[botKey] === 'function') {
          window.__rehydrateActiveSignal[botKey]();
        }
      } catch (e2) {}
    };

    void poll();
    const timer = setInterval(function () {
      if (Date.now() - started > maxMs) {
        stopExpiryPoll(botKey);
        return;
      }
      void poll();
    }, 300);

    const deadlineTimer = setTimeout(function () {
      stopExpiryPoll(botKey);
    }, maxMs + 500);

    expiryPoll[botKey] = { timer: timer, deadlineTimer: deadlineTimer, started: started };
  }

  function onExpiry(botKey) {
    if (!botKey) return;
    if (wasPainted(botKey, { attempt: 1 }) && (Date.now() - (paintedAt[botKey] || 0)) < 5000) return;
    startExpiryPoll(botKey);
  }

  window.__utkSignalResultInstant = {
    paint: paint,
    paintFromWs: paintFromWs,
    onExpiry: onExpiry,
    wasPainted: wasPainted,
    consumePainted: consumePainted,
    isResultPhase: isResultPhase,
    stopExpiryPoll: stopExpiryPoll
  };
})();
