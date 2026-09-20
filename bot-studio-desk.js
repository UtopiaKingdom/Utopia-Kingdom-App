/**
 * bot-studio-desk.js — Private desk uses the same house layout as Feed.
 * Load AFTER studio-feed-desk.js / studio-smooth.js.
 */
(function () {
  'use strict';

  const POLL_IDLE_MS = 1600;
  const POLL_HOT_MS = 900;
  let timer = null;
  let mountedBotId = '';
  let rootEl = null;
  let lastSig = null;
  let pullInFlight = false;

  function hub() {
    return window.__utkCommunityHub || null;
  }

  function smooth() {
    return window.__utkStudioSmooth || null;
  }

  function ladderOf(bot) {
    const raw = bot && Array.isArray(bot.martingale) ? bot.martingale
      : (bot && Array.isArray(bot.ladder) ? bot.ladder : [1, 2, 4, 10, 20]);
    if (raw.length !== 5) return [1, 2, 4, 10, 20];
    return raw.map(function (n, i) {
      const v = Math.round(Number(n));
      return v >= 1 && v <= 500 ? v : [1, 2, 4, 10, 20][i];
    });
  }

  function statsFromHistory(stats, history) {
    const out = Object.assign({
      entry: 0, s1: 0, s2: 0, s3: 0, s4: 0,
      wins: 0, losses: 0, wipes: 0, streak: 0, bestStreak: 0
    }, stats || {});
    (history || []).forEach(function (r) {
      const res = String(r.result || '').toUpperCase();
      if (res === 'WIN') {
        const a = Math.max(1, Math.min(5, Number(r.attempt || 1)));
        if (a === 1) out.entry += 1;
        else out['s' + (a - 1)] = (out['s' + (a - 1)] || 0) + 1;
      }
    });
    return out;
  }

  function adaptPayload(data, bot) {
    data = data || {};
    bot = Object.assign({}, bot || data.bot || {});
    bot.ladder = ladderOf(bot);
    try {
      const parts = window.__utkBotStudioParts;
      if (parts && typeof parts.ruleSummary === 'function') {
        bot.summary = parts.ruleSummary(bot);
        bot.ideaLine = bot.summary;
      }
    } catch (e) {}
    const history = Array.isArray(data.history) ? data.history : [];
    let dayKey = '';
    try {
      const api = window.__utkStatsDay;
      dayKey = api && typeof api.dayKey === 'function' ? api.dayKey(Date.now()) : '';
    } catch (eDay) {}
    let stats;
    try {
      if (window.__utkStudioDeskStats && typeof window.__utkStudioDeskStats.computeDeskStats === 'function') {
        stats = window.__utkStudioDeskStats.computeDeskStats(history, dayKey);
      } else {
        stats = statsFromHistory(data.stats, history);
      }
    } catch (eStats) {
      stats = statsFromHistory(data.stats, history);
    }
    let signal = data.signal ? Object.assign({ source: 'studio' }, data.signal) : null;
    return {
      bot: Object.assign({ source: 'studio' }, bot || data.bot || {}),
      signal: signal,
      stats: stats,
      history: history,
      scorecard: data.scorecard || bot.lastCheck || null,
      liveMeta: data.liveMeta || bot.liveMeta || null
    };
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      if (window.__utkStudioSignalLive && typeof window.__utkStudioSignalLive.stop === 'function') {
        window.__utkStudioSignalLive.stop();
      }
    } catch (e) {}
    mountedBotId = '';
    rootEl = null;
    lastSig = null;
    pullInFlight = false;
  }

  function nextPollMs() {
    const s = smooth();
    if (s && typeof s.adaptivePollMs === 'function') {
      return s.adaptivePollMs(lastSig, { idle: POLL_IDLE_MS, hot: POLL_HOT_MS });
    }
    return POLL_IDLE_MS;
  }

  function armTimer(bot) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const st = String((bot && bot.status) || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    if (!live || !mountedBotId) return;
    const tick = function () {
      timer = null;
      const studio = window.__utkBotStudio;
      const cur = studio && typeof studio.selected === 'function' ? studio.selected() : bot;
      if (!cur || cur.id !== mountedBotId) return;
      Promise.resolve(pull(cur)).finally(function () {
        if (!mountedBotId) return;
        timer = setTimeout(tick, nextPollMs());
      });
    };
    timer = setTimeout(tick, nextPollMs());
  }

  function paint(data, bot) {
    if (!rootEl) return;
    const st = String((bot && bot.status) || '').toLowerCase();
    const rawSig = (data && data.signal) || null;
    const sig = rawSig || {};
    lastSig = rawSig;
    const card = (data && data.scorecard) || (bot && bot.lastCheck) || {};
    const hist = (data && data.history) || [];
    const liveMeta = (data && data.liveMeta) || null;
    const feedDesk = window.__utkStudioFeedDesk;
    const payload = adaptPayload(data, bot);
    const displaySig = feedDesk && typeof feedDesk.signalForDisplay === 'function'
      ? feedDesk.signalForDisplay(payload.bot, payload.signal)
      : payload.signal;
    const s = smooth();
    const bits = [
      st,
      bot && bot.id,
      hist.length,
      card.wr1,
      card.wr1N,
      card.liveGapLabel || '',
      card.trades,
      // Stable health flags only — never churn timestamps (runnerAt/scannedAt)
      // or the whole desk rebuilds every poll and kills the Alerts toggle.
      liveMeta && liveMeta.runnerOk,
      liveMeta && liveMeta.botScanOk,
      liveMeta && liveMeta.overallOk
    ].concat(s && s.signalPaintBits ? s.signalPaintBits(sig) : [
      sig.signalId || '',
      sig.phase || '',
      sig.result || '',
      sig.side || '',
      sig.pair || sig.symbol || ''
    ]);
    const liveKey = s && s.paintKey ? s.paintKey(bits) : bits.join('|');
    const live = st === 'live' || st === 'armed';
    const house = rootEl.querySelector('.studio-feed-house');
    const prevPhase = rootEl.getAttribute('data-desk-phase') || '';
    const phase = String(sig.phase || '').toLowerCase();
    if (live && prevPhase === 'preparing' && !phase && bot && bot.id) {
      try {
        const clarity = window.__utkStudioClarity;
        if (clarity && typeof clarity.notePrepareDrop === 'function') {
          const prevPair = rootEl.getAttribute('data-desk-pair') || '';
          clarity.notePrepareDrop(bot.id, prevPair);
        }
      } catch (eDrop) {}
    }
    if (sig.pair || sig.symbol) {
      rootEl.setAttribute('data-desk-pair', String(sig.pair || sig.symbol || ''));
    }

    if (live && house && rootEl.getAttribute('data-desk-paint') === liveKey) {
      if (displaySig) {
        try {
          if (window.__utkStudioSignalLive && typeof window.__utkStudioSignalLive.update === 'function') {
            window.__utkStudioSignalLive.update(house, payload.bot, displaySig, {
              onExpired: function () { pull(bot); }
            });
          }
        } catch (eLive) {}
        try {
          if (window.__utkStudioSignalGlow && typeof window.__utkStudioSignalGlow.apply === 'function') {
            window.__utkStudioSignalGlow.apply(house, displaySig);
          }
        } catch (eGlow) {}
        // Retry place while signal is live (not only on phase edge) — first try may
        // have failed before SSID was ready; lastSent dedupes successful sends.
        if (phase === 'signal') {
          try {
            if (window.__utkStudioAutotrade && typeof window.__utkStudioAutotrade.tryPlace === 'function') {
              window.__utkStudioAutotrade.tryPlace(payload.bot, sig, { ladder: payload.bot.ladder });
            }
          } catch (eAt) {}
          try {
            if (window.__utkSignalNotify && typeof window.__utkSignalNotify.showStudioSignal === 'function') {
              window.__utkSignalNotify.showStudioSignal(payload.bot.id, payload.bot.name, sig);
            }
          } catch (eN) {}
        }
      }
      rootEl.setAttribute('data-desk-phase', phase);
      return;
    }

    if (!live && rootEl.getAttribute('data-desk-paint') === liveKey && rootEl.querySelector('.studio-feed-house, .studio-backtest-card')) {
      return;
    }
    rootEl.setAttribute('data-desk-paint', liveKey);
    rootEl.setAttribute('data-desk-phase', phase);

    if (feedDesk && typeof feedDesk.render === 'function') {
      rootEl.innerHTML = feedDesk.render(payload, { mode: 'private', skipInlineHealth: true });
      const newHouse = rootEl.querySelector('.studio-feed-house');
      try {
        if (typeof feedDesk.wire === 'function') {
          feedDesk.wire(rootEl, payload.bot, payload.signal, {
            mode: 'private',
            ladder: payload.bot.ladder,
            scorecard: payload.scorecard,
            liveMeta: payload.liveMeta
          });
        }
      } catch (e) {}
      try {
        if (newHouse && window.__utkStudioSignalLive && displaySig) {
          window.__utkStudioSignalLive.start(newHouse, payload.bot, displaySig, {
            onExpired: function () { pull(bot); }
          });
        } else if (window.__utkStudioSignalLive) {
          window.__utkStudioSignalLive.stop();
        }
      } catch (eLive2) {}
      if (phase === 'signal' && prevPhase !== 'signal') {
        try {
          if (window.__utkStudioAutotrade && typeof window.__utkStudioAutotrade.tryPlace === 'function') {
            window.__utkStudioAutotrade.tryPlace(payload.bot, sig, { ladder: payload.bot.ladder });
          }
        } catch (eAt2) {}
        try {
          if (window.__utkSignalNotify && typeof window.__utkSignalNotify.showStudioSignal === 'function') {
            window.__utkSignalNotify.showStudioSignal(payload.bot.id, payload.bot.name, sig);
          }
        } catch (eN2) {}
      }
      try {
        const studio = window.__utkBotStudio;
        const cur = studio && typeof studio.selected === 'function' ? studio.selected() : null;
        if (cur && payload.bot && cur.id === payload.bot.id && payload.liveMeta) {
          cur.liveMeta = payload.liveMeta;
        }
      } catch (eMeta) {}
      return;
    }
    rootEl.innerHTML = '<p class="studio-global-empty">Desk unavailable.</p>';
  }

  async function pull(bot) {
    if (pullInFlight) return;
    const st = String((bot && bot.status) || '').toLowerCase();
    if (st === 'checking' && rootEl && rootEl.querySelector('#studioCheckMeter')) {
      return;
    }
    const api = hub() && hub().api;
    if (!api || !bot || !bot.id) {
      paint({ scorecard: bot && bot.lastCheck, liveMeta: bot && bot.liveMeta }, bot);
      return;
    }
    pullInFlight = true;
    try {
      const data = await api('GET', '/studio/desk?id=' + encodeURIComponent(bot.id));
      try {
        const studio = window.__utkBotStudio;
        if (studio && typeof studio.syncBotScorecard === 'function' && data && data.scorecard) {
          bot = studio.syncBotScorecard(bot, data.scorecard) || bot;
        }
      } catch (eSync) {}
      paint(data, bot);
    } catch (e) {
      paint({ scorecard: bot.lastCheck, liveMeta: bot.liveMeta }, bot);
    } finally {
      pullInFlight = false;
    }
  }

  function mount(el, bot) {
    const id = bot && bot.id ? bot.id : '';
    const st = String((bot && bot.status) || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    const same = rootEl === el && mountedBotId === id;
    rootEl = el;
    mountedBotId = id;
    if (!rootEl || !mountedBotId) return;
    // Paint local scorecard immediately — do not wait on the network.
    try {
      paint({ scorecard: bot && bot.lastCheck, liveMeta: bot && bot.liveMeta }, bot);
    } catch (ePaint) {}
    Promise.resolve(pull(bot)).finally(function () {
      if (same && timer && live) return;
      armTimer(bot);
    });
  }

  window.__utkStudioDesk = {
    mount: mount,
    stop: stop,
    refresh: function (bot) { return pull(bot); },
    paintCommunity: paint
  };
})();
