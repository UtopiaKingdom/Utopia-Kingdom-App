/**
 * studio-feed-desk.js — Full-window house-bot layout for Feed.
 * Used by studio-global-hub.js. Load AFTER studio-autotrade.js.
 */
(function () {
  'use strict';

  const SAVE_KEY = 'utk-feed-saving-on';
  const DEFAULT_LADDER = [1, 2, 4, 10, 20];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ssidReady() {
    try {
      const mgr = window.ssidManager;
      if (!mgr || !mgr.statusByBot) return false;
      const ids = ['bot1', 'bot2', 'bot3'];
      for (let i = 0; i < ids.length; i++) {
        const st = mgr.statusByBot[ids[i]];
        if (st && !st.expired && st.hasSsid) return true;
      }
    } catch (e) {}
    return false;
  }

  function readSaving(botId) {
    try {
      const map = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
      return !!map[botId];
    } catch (e) {
      return false;
    }
  }

  function writeSaving(botId, on) {
    try {
      const map = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
      map[botId] = !!on;
      localStorage.setItem(SAVE_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function ladderOfBot(bot) {
    const raw = bot && Array.isArray(bot.ladder) ? bot.ladder
      : (bot && Array.isArray(bot.martingale) ? bot.martingale : DEFAULT_LADDER);
    const maxA = maxAttemptsOfBot(bot);
    if (raw.length !== 5) return DEFAULT_LADDER.slice(0, maxA);
    return raw.map(function (n, i) {
      const v = Math.round(Number(n));
      return v >= 1 && v <= 500 ? v : DEFAULT_LADDER[i];
    }).slice(0, maxA);
  }

  function maxAttemptsOfBot(bot) {
    const n = Math.round(Number(bot && bot.maxAttempts));
    if (!(n >= 1)) return 5;
    return Math.max(1, Math.min(5, n));
  }

  function privateLiveNoticeHtml(bot) {
    const pub = !!(bot && (bot.published || bot.globalId));
    const proofApi = window.__utkStudioBacktestProof;
    const last = bot && bot.lastCheck;
    let match = '';
    if (proofApi && typeof proofApi.liveMatchNote === 'function') {
      match = proofApi.liveMatchNote(bot, last);
    }
    return (
      '<div class="studio-live-notice" role="status">' +
        '<strong><i class="studio-live-dot"></i> Connected to the server</strong>' +
        'Runs 24/7 until you pause or delete it — even if this app is closed. You are responsible for taking it down.' +
        (pub ? ' On Community — removing it needs zero viewers and a reason.' : '') +
        (match ? '<span class="studio-live-match' + (match.indexOf('changed') >= 0 ? ' is-warn' : '') + '">' + esc(match) + '</span>' : '') +
      '</div>'
    );
  }

  function healthBannerHtml(bot, opts) {
    // Live checklist / runner detail lives in the Mind notebook — keep the desk clean.
    return '';
  }

  function signalAreaGlowClass(sig) {
    try {
      if (window.__utkStudioSignalGlow && typeof window.__utkStudioSignalGlow.glowClassForSignal === 'function') {
        return window.__utkStudioSignalGlow.glowClassForSignal(sig) || '';
      }
    } catch (e) {}
    return '';
  }

  function houseBodyHtml(bot, sig, stats, opts) {
    opts = opts || {};
    const st = String(bot.status || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    const glowCls = signalAreaGlowClass(sig);
    const signalAreaClass = 'bot-signal-area' + (glowCls ? (' ' + glowCls) : '');
    const statusLine = live && opts.mode !== 'private'
      ? '<span class="studio-live-banner"><i class="studio-live-dot"></i>24/7 live connected</span>'
      : (st === 'paused' && opts.mode !== 'private'
        ? '<span class="studio-paused-banner">Paused</span>'
        : '');

    return (
      '<div class="bot-container' + (opts.mode === 'private' ? '' : ' studio-feed-bot-container') + '">' +
        (opts.mode === 'private'
          ? ('<div class="' + signalAreaClass + '">' + signalAreaHtml(bot, sig, opts) + '</div>')
          : (
            (healthBannerHtml(bot, opts) ? ('<div class="studio-desk-health-slot">' + healthBannerHtml(bot, opts) + '</div>') : '') +
            '<div class="studio-signal-col">' +
              '<div class="' + signalAreaClass + '">' + signalAreaHtml(bot, sig, opts) + '</div>' +
            '</div>'
          )) +
        '<div class="bot-panels">' +
          '<div class="bot-auto-trade-panel">' +
            '<div class="card">' +
              '<div class="card-header autotrade-card-header">' +
                '<h3>Auto Trade</h3>' +
                '<label class="toggle-switch" title="Turn auto trade on">' +
                  '<input type="checkbox" id="studioAutoTrade"' + (live ? '' : ' disabled') + ' />' +
                  '<span class="toggle-slider"></span>' +
                '</label>' +
              '</div>' +
              '<div class="card-body autotrade-body">' +
                '<div class="autotrade-live">' +
                  (live && opts.mode !== 'private' ? statusLine : '') +
                  '<div class="autotrade-status" id="studioAtStatus" data-field="status" aria-live="polite">' +
                    (live ? 'Waiting for a signal' : 'Go live first') +
                  '</div>' +
                  '<div class="autotrade-watch" data-state="off" aria-live="polite">' +
                    '<span class="autotrade-watch-dot" aria-hidden="true"></span>' +
                    '<span class="autotrade-watch-text"></span>' +
                  '</div>' +
                '</div>' +
                (opts.mode === 'private'
                  ? '<div class="autotrade-reason" id="studioAutotradeReason" aria-live="polite" hidden></div>'
                  : '') +
                '<div class="form-group autotrade-stake">' +
                  '<label for="studioBetSize">Amount</label>' +
                  '<div class="bet-size-controls">' +
                    '<button type="button" class="btn-secondary bet-size-btn" id="studioBetHalf" title="Halve amount">½</button>' +
                    '<input type="number" id="studioBetSize" value="10" min="1" step="1" class="form-input bet-size-input" inputmode="numeric" />' +
                    '<button type="button" class="btn-secondary bet-size-btn" id="studioBetDouble" title="Double amount">×2</button>' +
                  '</div>' +
                  (opts.mode === 'private'
                    ? '<div class="bet-chain-hint" id="studioBetChainHint" aria-live="polite" hidden></div>'
                    : '') +
                '</div>' +
                savingBlockHtml(bot, live, opts.mode) +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="card stats-card compact">' +
            '<div class="card-header">' +
              '<div class="stats-header-row">' +
                '<h3>Stats</h3>' +
                '<div class="stats-date-controls">' +
                  '<div class="stats-date-wrap" aria-label="Choose stats date">' +
                    '<button class="stats-date-btn" id="studioStatsDateBtn" type="button">Today</button>' +
                    '<input id="studioStatsDateInput" class="stats-date-input" type="date" aria-label="Stats date" />' +
                  '</div>' +
                  '<button class="stats-date-today" id="studioStatsDateToday" type="button">Today</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="card-body">' +
              '<div class="streak-cluster" aria-label="Win streaks">' +
                '<div class="win-streak-badge" title="Wins in a row since the last wipe">' +
                  '<span class="win-streak-label">Streak</span>' +
                  '<span class="win-streak-value">' + esc(stats.streak || bot.streak || 0) + '</span>' +
                '</div>' +
                '<div class="best-streak-badge' + (opts.mode === 'private' ? ' is-clickable' : '') + '" title="' +
                  (opts.mode === 'private'
                    ? 'Tap to see past win streaks.'
                    : 'Best streak on this tape') + '">' +
                  '<span class="win-streak-label">' + (opts.mode === 'private' ? 'Last' : 'Best') + '</span>' +
                  '<span class="win-streak-value">' + esc(stats.bestStreak || bot.bestStreak || 0) + '</span>' +
                '</div>' +
              '</div>' +
              '<div class="stats-grid stats-grid--steps" role="list">' +
                '<div class="stat-item" title="Won on the first try"><span class="stat-label">Entry</span><span class="stat-value">' + esc(stats.entry || 0) + '</span></div>' +
                '<div class="stat-item" title="Won on save step 1"><span class="stat-label">S1</span><span class="stat-value">' + esc(stats.s1 || 0) + '</span></div>' +
                '<div class="stat-item" title="Won on save step 2"><span class="stat-label">S2</span><span class="stat-value">' + esc(stats.s2 || 0) + '</span></div>' +
                '<div class="stat-item" title="Won on save step 3"><span class="stat-label">S3</span><span class="stat-value">' + esc(stats.s3 || 0) + '</span></div>' +
                '<div class="stat-item" title="Won on save step 4"><span class="stat-label">S4</span><span class="stat-value">' + esc(stats.s4 || 0) + '</span></div>' +
              '</div>' +
              '<div class="stats-summary-row">' +
                '<div class="stat-item chains-lost" title="Full 5-loss wipe"><span class="stat-label">Wipes</span><span class="stat-value">' + esc(stats.wipes || 0) + '</span></div>' +
                '<div class="stat-item total-wins"><span class="stat-label">Wins</span><span class="stat-value">' + esc(stats.wins || 0) + '</span></div>' +
              '</div>' +
              '<div class="stats-wait-row">' +
                '<div class="stat-item signal-wait" title="Average wait between new signals over the last 3 hours">' +
                  '<span class="stat-label">Avg wait</span>' +
                  '<span class="stat-value">' + esc((stats.avgWaitLabel != null && stats.avgWaitLabel !== '') ? stats.avgWaitLabel : '—') + '</span>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function expiryLabel(bot, sig) {
    const raw = String((sig && sig.expiry) || (bot && bot.expiry) || (bot && bot.timeframe) || '1m').toLowerCase();
    const map = {
      '30s': '30 seconds',
      '1m': '1 minute',
      '2m': '2 minutes',
      '3m': '3 minutes',
      '5m': '5 minutes'
    };
    return map[raw] || raw;
  }

  function expiryMs(sig) {
    const dur = Number(sig && (sig.duration || 0));
    if (dur > 0) return dur * 1000;
    const exp = String((sig && sig.expiry) || '1m').toLowerCase();
    if (exp === '30s') return 30000;
    if (exp === '2m') return 120000;
    if (exp === '3m') return 180000;
    if (exp === '5m') return 300000;
    return 60000;
  }

  function statusLabel(st) {
    const v = String(st || '').toLowerCase();
    if (v === 'live') return 'Live';
    if (v === 'paused') return 'Paused';
    if (v === 'offline') return 'Offline';
    return 'Idle';
  }

  function todayLabel() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return mm + '/' + dd + '/' + d.getFullYear();
  }

  function tradeMeta(sig, bot) {
    const base = Object.assign({}, bot || {}, sig || {});
    base.source = base.source || 'studio';
    return base;
  }

  function clock(ms, meta) {
    const tt = window.__utkTradeTime;
    if (tt && typeof tt.formatTimeOnly === 'function') {
      return tt.formatTimeOnly(ms, meta);
    }
    const n = Number(ms);
    if (!(n > 0)) return '';
    const d = new Date(n);
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
  }

  function fmtPrice(v) {
    if (v == null || v === '' || v === 'N/A') return '';
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return String(v);
    let s = n.toFixed(5);
    s = s.replace(/\.?0+$/, '');
    return s;
  }

  function timePriceHtml(ms, price, meta) {
    const tt = window.__utkTradeTime;
    if (tt && typeof tt.formatTimePriceStack === 'function') {
      return tt.formatTimePriceStack(ms, price, meta);
    }
    const t = clock(ms, meta);
    const p = fmtPrice(price);
    if (t && p) return esc(t) + ', ' + esc(p);
    return esc(t || p || '');
  }

  function timePricePlain(ms, price, meta) {
    const t = clock(ms, meta);
    const p = fmtPrice(price);
    if (t && p) return t + ', ' + p;
    return t || p || '';
  }

  function deskStats(history, dayKey) {
    try {
      if (window.__utkStudioDeskStats && typeof window.__utkStudioDeskStats.computeDeskStats === 'function') {
        return window.__utkStudioDeskStats.computeDeskStats(history, dayKey);
      }
    } catch (e) {}
    return statsFromHistory({}, history);
  }

  function statsFromHistory(stats, history) {
    const out = Object.assign({
      entry: 0, s1: 0, s2: 0, s3: 0, s4: 0
    }, stats || {});
    (history || []).forEach(function (r) {
      if (String(r.result || '').toUpperCase() !== 'WIN') return;
      const a = Math.max(1, Math.min(5, Number(r.attempt || 1)));
      if (a === 1) out.entry += 1;
      else out['s' + (a - 1)] = (out['s' + (a - 1)] || 0) + 1;
    });
    return out;
  }

  function privateCheckingHtml() {
    const p = (typeof window !== 'undefined' && window.__utkStudioCheckProgress) || {};
    const pct = Math.max(0, Math.min(100, Number(p.pct) || 0));
    const n = Number(p.n) || 0;
    const i = Number(p.i) || 0;
    const label = p.label ? String(p.label) : 'Loading packs';
    const pairLine = n > 0 ? (Math.min(i || 1, n) + ' / ' + n) : '';
    return (
      '<div class="signal-empty studio-backtest-card studio-backtest-pro is-checking" id="feedSignalEmpty">' +
        '<p class="studio-backtest-kicker">Testing</p>' +
        '<p class="studio-backtest-note">Replaying real OTC prices. This does not place trades.</p>' +
        '<div class="studio-check-meter" id="studioCheckMeter">' +
          '<div class="studio-check-bar" aria-hidden="true">' +
            '<div class="studio-check-bar-fill' + (n <= 0 ? ' is-wait' : '') + '" id="studioCheckBarFill" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<div class="studio-check-meta">' +
            '<span id="studioCheckBarLabel">' + esc(label) + (pairLine ? ', ' + esc(pairLine) : '') + '</span>' +
            '<strong id="studioCheckBarPct">' + esc(Math.round(pct)) + '%</strong>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="signal-display" id="feedSignalDisplay" style="display:none;"></div>'
    );
  }

  function paintCheckProgress(row) {
    row = row || {};
    const pct = Math.max(0, Math.min(100, Number(row.pct) || 0));
    const n = Number(row.n) || 0;
    const i = Number(row.i) || 0;
    const label = row.label ? String(row.label) : 'Checking';
    try { window.__utkStudioCheckProgress = { pct: pct, i: i, n: n, label: label }; } catch (e) {}
    const fill = document.getElementById('studioCheckBarFill');
    const lab = document.getElementById('studioCheckBarLabel');
    const pctEl = document.getElementById('studioCheckBarPct');
    if (fill) {
      fill.style.width = pct + '%';
      if (n <= 0) fill.classList.add('is-wait');
      else fill.classList.remove('is-wait');
    }
    const pairLine = n > 0 ? (Math.min(i || 1, n) + ' / ' + n) : '';
    if (lab) lab.textContent = label + (pairLine ? ', ' + pairLine : '');
    if (pctEl) pctEl.textContent = Math.round(pct) + '%';
  }

  function fmtWr1(card) {
    const n = Number(card.wr1N != null ? card.wr1N : card.trades) || 0;
    const pct = card.wr1 != null ? card.wr1 : 0;
    if (!(n > 0)) return '—';
    return pct + '%';
  }

  function wrRingClass(pct) {
    const n = Number(pct) || 0;
    if (n >= 55) return '';
    if (n >= 45) return ' is-warn';
    return ' is-low';
  }

  function privateBacktestHtml(card) {
    const studio = window.__utkBotStudio;
    const norm = studio && typeof studio.normalizeScorecard === 'function'
      ? studio.normalizeScorecard(card)
      : card;
    const n0 = Number(norm && (norm.wr1N != null ? norm.wr1N : norm.trades)) || 0;
    const ready = !!(norm && (norm.ok || n0 > 0) && n0 > 0);
    if (!norm || !ready) {
      const why = (card && card.message) ? card.message : 'Tap Test past candles when the recipe is ready. This does not place trades.';
      const packN = card && (card.universe != null ? card.universe : card.pairs);
      return (
        '<div class="signal-empty studio-backtest-card studio-backtest-pro" id="feedSignalEmpty">' +
          '<header class="studio-backtest-head">' +
            '<p class="studio-backtest-kicker">Test result</p>' +
            '<p class="studio-backtest-note">Replay of real OTC prices. Nothing is sent to Pocket Option.</p>' +
            (packN ? '<p class="studio-backtest-meta">' + esc(packN) + ' OTC pairs checked</p>' : '') +
          '</header>' +
          '<p class="studio-backtest-go">' + esc(why) + '</p>' +
        '</div>' +
        '<div class="signal-display" id="feedSignalDisplay" style="display:none;"></div>'
      );
    }
    card = norm;
    const maxChain = card.maxChainWins != null ? card.maxChainWins : card.bestStreak;
    const totalWins = card.totalWins != null ? card.totalWins : card.wins;
    const wipeChains = card.wipeChains != null ? card.wipeChains : card.wipes;
    const n = Number(card.wr1N != null ? card.wr1N : card.trades) || 0;
    const wr1Wins = Number(card.wr1Wins != null ? card.wr1Wins : 0);
    const wrPct = card.wr1 != null ? Number(card.wr1) : 0;
    const thin = !!card.thin || n < 20;
    const look = card.windowLabel ? String(card.windowLabel) : '';
    const packs = Number(card.pairs || card.universe) || 0;
    const gapRest = card.signalGapLabel && card.signalGapLabel !== 'no wait'
      ? 'then ' + card.signalGapLabel + ' rest'
      : 'one at a time';
    const maxA = Number(card.maxAttempts != null ? card.maxAttempts : 5) || 5;
    const proofBlock = (window.__utkStudioBacktestProof && typeof window.__utkStudioBacktestProof.html === 'function')
      ? window.__utkStudioBacktestProof.html(card)
      : '';
    const tryLabel = maxA === 1 ? 'entry only' : ('try 1–' + maxA);
    const pace = (window.__utkStudioClarity && typeof window.__utkStudioClarity.paceCopy === 'function')
      ? window.__utkStudioClarity.paceCopy(card)
      : {
        title: card.liveGapLabel ? '~' + card.liveGapLabel : '—',
        detail: gapRest
      };
    return (
      '<div class="signal-empty studio-backtest-card studio-backtest-pro" id="feedSignalEmpty">' +
        '<header class="studio-backtest-head">' +
          '<p class="studio-backtest-kicker">How it would have done</p>' +
          '<p class="studio-backtest-note">Past prices only. Does not go live and does not show on Community.</p>' +
          (packs
            ? '<p class="studio-backtest-meta">' + esc(packs) + ' OTC pairs'
              + (look ? ', ' + esc(look) : '') + '</p>'
            : '') +
        '</header>' +
        proofBlock +
        '<div class="studio-backtest-wr-block">' +
          '<div class="studio-backtest-ring' + wrRingClass(wrPct) + '" style="--wr:' + esc(Math.max(0, Math.min(100, wrPct))) + '">' +
            '<div class="studio-backtest-ring-inner">' +
              '<span class="studio-backtest-wr-val">' + esc(fmtWr1(card)) + '</span>' +
              '<span class="studio-backtest-wr-label">First try</span>' +
            '</div>' +
          '</div>' +
          (n
            ? '<p class="studio-backtest-wr-sub">' + esc(wr1Wins) + ' won of ' + esc(n) + ' first tries</p>' +
              '<p class="studio-backtest-wr-note">Martingale recovery does not count here.</p>'
            : '') +
        '</div>' +
        '<div class="studio-backtest-tiles">' +
          '<div class="studio-backtest-tile">' +
            '<span class="studio-backtest-tile-label">Longest run on one pair</span>' +
            '<strong>' + esc(maxChain || 0) + '</strong>' +
          '</div>' +
          '<div class="studio-backtest-tile">' +
            '<span class="studio-backtest-tile-label">Chains that recovered</span>' +
            '<strong>' + esc(totalWins != null ? totalWins : 0) + '</strong>' +
            '<em>win on ' + esc(tryLabel) + '</em>' +
          '</div>' +
          '<div class="studio-backtest-tile">' +
            '<span class="studio-backtest-tile-label">Wiped</span>' +
            '<strong>' + esc(wipeChains || 0) + '</strong>' +
            '<em>' + esc(maxA === 1 ? 'lost entry' : (maxA + ' losses in a row')) + '</em>' +
          '</div>' +
          '<div class="studio-backtest-tile is-pace-honest">' +
            '<span class="studio-backtest-tile-label">Past signal pace</span>' +
            '<strong>' + esc(pace.title) + '</strong>' +
            '<em>' + esc(pace.detail || gapRest) + '</em>' +
          '</div>' +
        '</div>' +
        (thin ? '<p class="studio-backtest-thin">Not many trades yet. Treat this as a hint.</p>' : '') +
        '<footer class="studio-backtest-foot">' +
          '<button type="button" class="studio-backtest-ai-btn" id="studioBacktestAi" data-cmd="aiUpgrade">Ask AI what to improve</button>' +
          '<div id="studioDeskAiMount"></div>' +
          '<p class="studio-backtest-go">Like it? Press Go live 24/7. The server keeps scanning even if you close the app.</p>' +
        '</footer>' +
      '</div>' +
      '<div class="signal-display" id="feedSignalDisplay" style="display:none;"></div>'
    );
  }

  function displaySignal(bot, sig, opts) {
    opts = opts || {};
    const side = String(sig.side || sig.action || '').toUpperCase();
    const action = side === 'CALL' || side === 'BUY' ? 'BUY' : 'SELL';
    const phaseRaw = String(sig.phase || 'signal').toLowerCase();
    const isResult = phaseRaw === 'result';
    const isPreparing = phaseRaw === 'preparing';
    const phase = isResult ? 'Trading Result' : (isPreparing ? 'Preparing' : 'Signal');

    const meta = tradeMeta(sig, bot);
    const hold = expiryMs(sig);
    const left = (isResult || isPreparing)
      ? 0
      : Math.max(0, Math.ceil((hold - (Date.now() - Number(sig.openedAtMs || 0))) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    const attempt = Number(sig.attempt || 1);
    const stepLabel = attempt <= 1 ? 'Entry' : ('S' + (attempt - 1));
    const ladder = ladderOfBot(bot);
    const mult = ladder[Math.min(4, Math.max(0, attempt - 1))];
    const openPx = sig.openingPrice != null ? sig.openingPrice : sig.price;
    const closePx = sig.closingPrice;
    const openCombined = timePriceHtml(sig.openedAtMs || sig.openingTime, openPx, meta);
    const closeCombined = timePriceHtml(sig.closedAtMs || sig.closingTime, closePx, meta);
    const result = String(sig.result || '').toUpperCase();
    const actionCls = action === 'BUY' ? 'up' : 'down';
    const pair = sig.pair || sig.symbol || 'OTC';
    const expiry = sig.expiry || bot.expiry || '1m';
    const openTimeOnly = (function () {
      try {
        if (window.__utkTradeTime && typeof window.__utkTradeTime.formatSignalTimeDisplay === 'function') {
          return window.__utkTradeTime.formatSignalTimeDisplay(sig);
        }
      } catch (e) {}
      return '';
    })();

    const rows = [];
    rows.push({ label: 'Phase', value: phase });
    if (pair) rows.push({ label: 'Pair', value: pair });
    if (!isResult && action) {
      rows.push({ label: 'Action', value: action, cls: actionCls });
    }
    if (!isResult && openPx != null && openPx !== 'N/A') {
      rows.push({ label: 'Open Price', value: openPx });
    }
    if (!isResult) {
      rows.push({ label: 'Expiry', value: expiry });
    }
    if (!isResult && openTimeOnly) {
      rows.push({ label: 'Opens', value: openTimeOnly });
    }
    if (isResult && result) {
      const resultCls = result === 'WIN' ? 'win' : (result === 'LOSS' ? 'loss' : '');
      rows.push({ label: 'Result', value: result, cls: resultCls });
    }
    if (isResult && action) {
      rows.push({ label: 'Action', value: action, cls: actionCls });
    }
    if (isResult && openCombined) {
      rows.push({ label: 'Open', value: openCombined, html: true });
    }
    if (isResult && closeCombined) {
      rows.push({ label: 'Close', value: closeCombined, html: true });
    }

    const rowHtml = rows.map(function (row) {
      const cls = row.cls ? ('value ' + row.cls) : 'value';
      const val = row.html ? row.value : esc(row.value);
      return '<div class="signal-row"><span class="label">' + esc(row.label) +
        '</span><span class="' + cls + '">' + val + '</span></div>';
    }).join('');

    return (
      '<div class="signal-empty" id="feedSignalEmpty" style="display:none;"></div>' +
      '<div class="signal-display" id="feedSignalDisplay" style="display:block;">' +
        '<div class="signal-card" data-utk-phase="' + esc(phase) + '">' +
          (attempt > 1 && !isResult ? '<div class="saving-signal-banner">Saving ' + esc(stepLabel) + ' x' + esc(mult) + '</div>' : '') +
          (isResult || isPreparing
            ? ''
            : ('<div class="signal-countdown"><span class="countdown-label">' +
              (isPreparing ? 'Preparing' : 'Countdown') + '</span>' +
              '<span class="countdown-value">' + esc(isPreparing ? '…' : (mm + ':' + ss)) + '</span></div>')) +
          rowHtml +
        '</div>' +
      '</div>'
    );
  }

  function signalForDisplay(bot, sig) {
    if (!sig || !sig.side) return null;
    const phaseRaw = String(sig.phase || 'signal').toLowerCase();
    // Match house bots: never flash stale Preparing cards (MG recovery is silent in UI).
    if (phaseRaw === 'preparing') return null;
    if (phaseRaw !== 'result') return sig;

    const grace = (window.__utkSignalCardTtl && window.__utkSignalCardTtl.RESULT_GRACE_MS) || 6000;
    let closed = Number(sig.closedAtMs || sig.closingTime || 0);
    const opened = Number(sig.openedAtMs || sig.openingTime || 0);
    if (!closed && opened) {
      let dur = Number(sig.duration || 0);
      if (!(dur > 0)) {
        const exp = String(sig.expiry || (bot && bot.expiry) || '1m').toLowerCase();
        dur = exp === '30s' ? 30 : exp === '2m' ? 120 : exp === '3m' ? 180 : exp === '5m' ? 300 : 60;
      }
      closed = opened + dur * 1000;
    }
    const anchor = closed || opened;
    if (!anchor) return null;
    if (Date.now() - anchor > 300000) return null;
    if (closed && (Date.now() - closed) > grace) return null;
    if (!closed) return null;
    return sig;
  }

  function canonPairKey(v) {
    return String(v || '').toUpperCase().replace(/\s+/g, ' ').trim();
  }

  function sameStudioTrade(row, sig) {
    if (!row || !sig) return false;
    const o1 = Number(row.openedAtMs || row.openingTime || 0);
    const o2 = Number(sig.openedAtMs || sig.openingTime || 0);
    if (!o1 || !o2 || o1 !== o2) return false;
    const a1 = Number(row.attempt || 1);
    const a2 = Number(sig.attempt || 1);
    if (a1 !== a2) return false;
    return canonPairKey(row.pair) === canonPairKey(sig.pair || sig.symbol);
  }

  function dedupeStudioHistory(rows) {
    let list = Array.isArray(rows) ? rows.slice() : [];
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.dedupeResultTrades === 'function') {
        list = window.__utkBotStats.dedupeResultTrades(list);
      }
    } catch (e) {}
    const seen = Object.create(null);
    const out = [];
    list.forEach(function (r) {
      const key = [
        Number(r.openedAtMs || r.openingTime || 0),
        Number(r.attempt || 1),
        canonPairKey(r.pair),
        String(r.result || '').toUpperCase(),
        String(r.side || '').toUpperCase()
      ].join('|');
      if (seen[key]) return;
      seen[key] = true;
      out.push(r);
    });
    return out;
  }

  function historyForDesk(history, sig) {
    let rows = dedupeStudioHistory(history);
    if (!sig || !sig.side) return rows.slice(0, 60);
    const phase = String(sig.phase || '').toLowerCase();
    if (phase === 'signal' || phase === 'result' || phase === 'preparing') {
      rows = rows.filter(function (r) { return !sameStudioTrade(r, sig); });
    }
    return rows.slice(0, 60);
  }

  function houseSignalEmptyHtml(text, showCta, opts) {
    opts = opts || {};
    const body = opts.html
      ? String(opts.html)
      : ('<p data-empty-text>' + esc(text || 'Waiting for signals...') + '</p>');
    return (
      '<div class="signal-empty" id="feedSignalEmpty">' +
        '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">' +
          '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>' +
        '</svg>' +
        body +
        (showCta
          ? '<button type="button" class="btn-secondary signal-empty-cta" id="feedConnectCta">Connect Pocket Option</button>'
          : '') +
      '</div>' +
      '<div class="signal-display" id="feedSignalDisplay" style="display:none;"></div>'
    );
  }

  function preparingWaitLine(sig) {
    const attempt = Number(sig && sig.attempt || 1);
    const maxA = Math.max(1, Math.min(5, Math.round(Number((sig && sig.maxAttempts) || 5)) || 5));
    if (attempt <= 1) return 'Locking entry on this pair…';
    return 'Same pair try ' + attempt + ' of ' + maxA + ' — waiting for next candle…';
  }

  function liveWaitEmptyHtml(bot, opts, connected) {
    // Keep the signal card clean — full live thinking is in the Mind button.
    return houseSignalEmptyHtml('Waiting for signals...', !connected);
  }

  function signalAreaHtml(bot, sig, opts) {
    opts = opts || {};
    const st = String(bot.status || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    const connected = ssidReady();
    const rawSig = sig;
    const rawPhase = String((rawSig && rawSig.phase) || '').toLowerCase();

    if (opts.mode === 'private' && !live) {
      if (st === 'checking') {
        return privateCheckingHtml();
      }
      const card = opts.scorecard || bot.lastCheck || null;
      if (card && (card.ok || card.trades != null || card.wr1N != null || card.message)) {
        return privateBacktestHtml(card);
      }
      if (st === 'paused') {
        return houseSignalEmptyHtml('Paused. Go live to reconnect 24/7.', false);
      }
      return houseSignalEmptyHtml('Test past candles first, then go live.', false);
    }

    if (!live) {
      const why = st === 'offline'
        ? 'Publisher subscription ended.'
        : (st === 'paused' ? 'Paused for quality.' : 'Not live right now.');
      return (
        '<div class="signal-empty" id="feedSignalEmpty">' +
          '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">' +
            '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>' +
          '</svg>' +
          '<p data-empty-text>' + esc(statusLabel(st)) + '. ' + esc(why) + '</p>' +
        '</div>' +
        '<div class="signal-display" id="feedSignalDisplay" style="display:none;"></div>'
      );
    }

    if (!sig || !sig.side) {
      return liveWaitEmptyHtml(bot, opts, !connected);
    }

    sig = signalForDisplay(bot, rawSig);
    if (!sig || !sig.side) {
      return liveWaitEmptyHtml(bot, opts, !connected && live && rawPhase !== 'preparing');
    }

    const card = displaySignal(bot, sig, opts);
    if (card) return card;

    return houseSignalEmptyHtml('Waiting for signals...', false);
  }

  function savingBlockHtml(bot, live, mode) {
    if (mode === 'private') {
      const on = readSaving(bot.id);
      const maxA = Math.max(1, Math.min(5, Math.round(Number((bot && bot.maxAttempts) || 5)) || 5));
      return (
        '<div class="form-group form-group-last autotrade-save">' +
          '<div class="form-row-toggle">' +
            '<label>Stake ladder</label>' +
            '<label class="toggle-switch">' +
              '<input type="checkbox" id="savingSignalEnabled-studio"' + (live ? '' : ' disabled') + (on ? ' checked' : '') + ' />' +
              '<span class="toggle-slider"></span>' +
            '</label>' +
          '</div>' +
          '<p class="studio-saving-hint">On = raise stake on same-pair tries 2–' + maxA + '. Off = flat stake. Tries still run either way.</p>' +
          '<div id="savingSignalOptions-studio" class="saving-signal-options"' + (on ? '' : ' style="display:none;"') + '>' +
            '<div class="saving-signal-strategy-block">' +
              '<label class="saving-signal-strategy-label">Ladder</label>' +
              '<div class="saving-signal-mode" id="savingSignalMode-studio" role="group" aria-label="Stake ladder">' +
                '<button type="button" class="saving-ladder-chip is-on" data-saving-mode="2x" data-bot-id="studio">2x</button>' +
                '<button type="button" class="saving-ladder-chip" data-saving-mode="4x" data-bot-id="studio">4x</button>' +
                '<button type="button" class="saving-ladder-chip" data-saving-mode="custom" data-bot-id="studio">Custom</button>' +
              '</div>' +
              '<div class="saving-ladder-custom" id="savingLadderCustom-studio" hidden aria-hidden="true"></div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }
    const ladder = ladderOfBot(bot);
    const on = readSaving(bot.id);
    const chips = ladder.map(function (m, i) {
      const chipLabel = i === 0 ? 'Entry' : ('S' + i);
      return '<span class="saving-ladder-chip is-on" title="' + esc(chipLabel) + '">×' + esc(m) + '</span>';
    }).join('');
    const ladderNote = mode === 'private'
      ? ''
      : ('<p class="studio-feed-ladder-note">Multipliers used after a loss: ' +
          esc(ladder.join(' → ')) + '</p>');
    return (
      '<div class="form-group form-group-last autotrade-save">' +
        '<div class="form-row-toggle">' +
          '<label>Saving Signals</label>' +
          '<label class="toggle-switch">' +
            '<input type="checkbox" id="feedSavingToggle"' + (live ? '' : ' disabled') + (on ? ' checked' : '') + ' />' +
            '<span class="toggle-slider"></span>' +
          '</label>' +
        '</div>' +
        '<div id="feedSavingOptions" class="saving-signal-options"' + (on ? '' : ' style="display:none;"') + '>' +
          '<div class="saving-signal-strategy-block">' +
            '<label class="saving-signal-strategy-label">Strategy</label>' +
            '<div class="saving-signal-mode" role="group" aria-label="Saving ladder">' + chips + '</div>' +
            ladderNote +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function render(data, opts) {
    opts = opts || {};
    const mode = opts.mode || 'feed';
    const bot = (data && data.bot) || {};
    const sig = (data && data.signal) || null;
    const history = Array.isArray(data.history) ? data.history : [];
    let dayKey = '';
    try {
      const api = window.__utkStatsDay;
      dayKey = api && typeof api.dayKey === 'function' ? api.dayKey(Date.now()) : '';
    } catch (eDay) {}
    const stats = deskStats(history, dayKey);
    const st = String(bot.status || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    const elite = !!bot.elite || Number(bot.bestStreak || stats.bestStreak || 0) >= 50;
    const name = bot.name || (mode === 'private' ? 'My bot' : 'Feed bot');
    const idea = bot.ideaLine || bot.summary || 'Community live tape';
    const ladder = ladderOfBot(bot);
    const renderOpts = {
      mode: mode,
      scorecard: opts.scorecard || data.scorecard || bot.lastCheck || null,
      liveMeta: opts.liveMeta || data.liveMeta || null,
      skipInlineHealth: !!opts.skipInlineHealth
    };
    const meta = JSON.stringify({
      idea: idea,
      family: bot.family || bot.style || '',
      timeframe: bot.timeframe || '',
      expiry: bot.expiry || (sig && sig.expiry) || '1m',
      ladder: ladder,
      elite: elite,
      bestStreak: Number(bot.bestStreak || stats.bestStreak || 0),
      status: st,
      watching: Number(bot.watching || 0),
      trading: Number(bot.trading || 0)
    });

    const watchN = Number(bot.watching || 0);
    const tradeN = Number(bot.trading || 0);
    const presenceLabel = watchN <= 0
      ? 'No one here'
      : (watchN === 1 ? '1 watching' : watchN + ' watching') +
        (tradeN > 0 ? ', ' + tradeN + ' auto' : '');

    let headerLeft = '';
    if (mode === 'feed') {
      headerLeft =
        '<button type="button" class="studio-feed-back" id="feedBackBtn" aria-label="Back to Feed" title="Back">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
            '<polyline points="15 18 9 12 15 6"></polyline>' +
          '</svg>' +
        '</button>' +
        '<div class="studio-feed-title-block">' +
          '<h1>' + esc(name) + '</h1>' +
          (elite ? '<span class="badge is-elite" title="Best live streak reached 50+">50+</span>' : '') +
          '<span class="studio-feed-presence" title="People on this desk right now">' + esc(presenceLabel) + '</span>' +
        '</div>';
    } else {
      headerLeft =
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<button type="button" class="studio-feed-back" id="studioBotBackBtn" aria-label="Back to your bots" title="Back">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
              '<polyline points="15 18 9 12 15 6"></polyline>' +
            '</svg>' +
          '</button>' +
          '<div style="display:flex;flex-direction:column;">' +
            '<h1>' + esc(name) + '</h1>' +
          '</div>' +
          (elite ? '<span class="badge is-elite" title="Best live streak reached 50+">50+</span>' : '') +
        '</div>';
    }

    const notifyOn = (function () {
      try {
        if (window.__utkSignalNotify && typeof window.__utkSignalNotify.isStudioNotifyOn === 'function') {
          return !!window.__utkSignalNotify.isStudioNotifyOn(bot.id);
        }
      } catch (e) {}
      return true;
    }());
    const bellSvg = notifyOn
      ? '<svg class="studio-notify-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
      : '<svg class="studio-notify-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    const headerRightPrivate =
      '<div class="studio-desk-header-right">' +
        '<span class="bot-expiry">' + esc(expiryLabel(bot, sig)) + '</span>' +
        '<button type="button" class="studio-notify-bell' + (notifyOn ? ' is-on' : ' is-off') + '"' +
          ' id="studioNotifyToggle"' +
          (live ? '' : ' disabled') +
          ' aria-pressed="' + (notifyOn ? 'true' : 'false') + '"' +
          ' title="' + (notifyOn ? 'Alerts on — click to mute' : 'Alerts off — click to unmute') + '">' +
          bellSvg +
        '</button>' +
        (live ? '<button type="button" class="btn-secondary" id="studioPauseHeader">Pause</button>' : '') +
        '<button type="button" class="btn-secondary" id="feedInfoBtn">Info</button>' +
        '<button type="button" class="btn-secondary" id="feedHistoryBtn">History</button>' +
      '</div>';

    return (
      '<div class="studio-feed-house studio-desk-' + esc(mode) + ' house-bot-layout' + (mode === 'private' ? ' studio-desk-private' : '') + '" data-follow-bot="' + esc(bot.id) + '"' +
        ' data-feed-history-full="' + esc(JSON.stringify(history)) + '"' +
        ' data-feed-history="' + esc(JSON.stringify(historyForDesk(history, sig))) + '"' +
        ' data-feed-meta="' + esc(meta) + '">' +
        '<div class="section-header studio-feed-header">' +
          (mode === 'private'
            ? (headerLeft + headerRightPrivate)
            : ('<div class="studio-feed-header-left">' + headerLeft + '</div>' +
               '<div class="studio-feed-header-right">' +
                 '<span class="bot-expiry">' + esc(expiryLabel(bot, sig)) + '</span>' +
                 '<button type="button" class="btn-secondary" id="feedInfoBtn">Info</button>' +
                 '<button type="button" class="btn-secondary" id="feedHistoryBtn">History</button>' +
               '</div>')) +
        '</div>' +
        houseBodyHtml(bot, sig, stats, renderOpts) +
      '</div>'
    );
  }

  function openInfo(root) {
    let meta = {};
    try {
      meta = JSON.parse((root && root.getAttribute('data-feed-meta')) || '{}');
    } catch (e) {
      meta = {};
    }
    const title = document.getElementById('infoModalTitle');
    const body = document.getElementById('infoModalBody');
    const modal = document.getElementById('info-modal');
    const name = (root && root.querySelector('h1') && root.querySelector('h1').textContent) || 'Feed bot';
    if (title) title.textContent = name;
    const ladder = Array.isArray(meta.ladder) ? meta.ladder.join(' → ') : '1 → 2 → 4 → 10 → 20';
    if (body) {
      body.innerHTML =
        '<p class="bot-info-blurb">' + esc(meta.idea || 'Community live tape') + '</p>' +
        '<ul class="bot-info-facts">' +
          '<li><span>Style</span><strong>' + esc(meta.family || 'Custom') + '</strong></li>' +
          '<li><span>Chart</span><strong>' + esc(meta.timeframe || '1m') + '</strong></li>' +
          '<li><span>Expiry</span><strong>' + esc(meta.expiry || '1m') + '</strong></li>' +
          '<li><span>Ladder</span><strong>×' + esc(ladder) + '</strong></li>' +
          '<li><span>Best streak</span><strong>' + esc(meta.bestStreak || 0) +
            (meta.elite ? ' (50+ badge)' : '') + '</strong></li>' +
        '</ul>' +
        '<p class="bot-info-note">Basic idea only. Exact filters stay private. Follow CALL / PUT on the tape.</p>';
    }
    if (modal) modal.classList.add('active');
  }

  function normalizeHistoryRow(r) {
    const side = String((r && r.side) || '').toUpperCase();
    let action = side;
    if (side === 'CALL') action = 'BUY';
    else if (side === 'PUT') action = 'SELL';
    return Object.assign({}, r, {
      action: action,
      timestamp: (r && (r.closedAtMs || r.createdAt || r.closingTime)) || null,
      openingPrice: r && r.openingPrice != null ? r.openingPrice : (r && r.openPrice),
      closingPrice: r && r.closingPrice != null ? r.closingPrice : (r && r.closePrice),
      source: r && r.source ? r.source : 'studio',
      clock: (r && r.clock) ? r.clock : 'epoch'
    });
  }

  function openHistory(root) {
    let rows = [];
    try {
      rows = JSON.parse((root && root.getAttribute('data-feed-history')) || '[]');
    } catch (e) {
      rows = [];
    }
    const botName = (root && root.querySelector('h1') && root.querySelector('h1').textContent) || 'My bot';
    const botId = (root && root.getAttribute('data-follow-bot')) || 'studio';
    const items = dedupeStudioHistory(rows.map(normalizeHistoryRow));
    const render = window.__utkRenderHistory || window.renderHistoryModal;
    if (typeof render === 'function') {
      render('studio:' + botId, { title: botName, items: items });
      return;
    }
    const title = document.getElementById('historyModalTitle');
    const list = document.getElementById('historyList');
    const modal = document.getElementById('history-modal');
    if (title) title.textContent = botName + ' history';
    if (list) {
      list.innerHTML = !items.length
        ? '<p class="history-empty">No history yet</p>'
        : '<p class="history-empty">History unavailable</p>';
    }
    if (modal) modal.classList.add('active');
  }

  function wire(root, bot, signal, opts) {
    if (!root) return;
    opts = opts || {};
    const house = root.querySelector('.studio-feed-house') || root;
    const info = house.querySelector('#feedInfoBtn');
    const hist = house.querySelector('#feedHistoryBtn');
    const back = house.querySelector('#feedBackBtn') || house.querySelector('#studioBotBackBtn');
    const pauseHdr = house.querySelector('#studioPauseHeader');
    const notifyToggle = house.querySelector('#studioNotifyToggle');
    const connect = house.querySelector('#feedConnectCta');
    const saving = house.querySelector('#feedSavingToggle') || house.querySelector('#savingSignalEnabled-studio');
    const savingOpts = house.querySelector('#feedSavingOptions') || house.querySelector('#savingSignalOptions-studio');

    if (back) {
      back.onclick = function (ev) {
        ev.preventDefault();
        try {
          if (back.id === 'studioBotBackBtn' && window.__utkStudioBotHub && typeof window.__utkStudioBotHub.backToHub === 'function') {
            window.__utkStudioBotHub.backToHub();
            return;
          }
          if (window.__utkStudioGlobal && typeof window.__utkStudioGlobal.backToList === 'function') {
            window.__utkStudioGlobal.backToList();
          }
        } catch (e) {}
      };
    }
    if (pauseHdr) {
      pauseHdr.onclick = function (ev) {
        ev.preventDefault();
        try {
          if (typeof window.__utkStudioCmd === 'function') {
            window.__utkStudioCmd('pause');
          }
        } catch (e) {}
      };
    }
    if (notifyToggle && bot && bot.id) {
      const paintBell = function (on) {
        const isOn = !!on;
        notifyToggle.classList.toggle('is-on', isOn);
        notifyToggle.classList.toggle('is-off', !isOn);
        notifyToggle.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        notifyToggle.title = isOn ? 'Alerts on — click to mute' : 'Alerts off — click to unmute';
        notifyToggle.innerHTML = isOn
          ? '<svg class="studio-notify-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
          : '<svg class="studio-notify-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
      };
      try {
        if (window.__utkSignalNotify && typeof window.__utkSignalNotify.registerStudioBot === 'function') {
          window.__utkSignalNotify.registerStudioBot(bot.id, bot.name, { feed: opts.mode === 'feed' });
        }
        if (window.__utkSignalNotify && typeof window.__utkSignalNotify.isStudioNotifyOn === 'function') {
          paintBell(window.__utkSignalNotify.isStudioNotifyOn(bot.id));
        }
      } catch (eReg) {}
      notifyToggle.onclick = function (ev) {
        ev.preventDefault();
        if (notifyToggle.disabled) return;
        try {
          const cur = !!(window.__utkSignalNotify && window.__utkSignalNotify.isStudioNotifyOn &&
            window.__utkSignalNotify.isStudioNotifyOn(bot.id));
          const next = !cur;
          if (window.__utkSignalNotify && typeof window.__utkSignalNotify.setStudioNotifyOn === 'function') {
            window.__utkSignalNotify.setStudioNotifyOn(bot.id, next, {
              name: bot.name,
              feed: opts.mode === 'feed'
            });
          }
          paintBell(next);
          if (typeof window.showAppToast === 'function') {
            window.showAppToast(
              next ? ('Alerts on · ' + (bot.name || 'bot')) : ('Alerts muted · ' + (bot.name || 'bot')),
              { tone: 'info', durationMs: 2000 }
            );
          }
        } catch (eN) {}
      };
    }
    if (info) {
      info.onclick = function (ev) {
        ev.preventDefault();
        openInfo(house);
      };
    }
    if (hist) {
      hist.onclick = function (ev) {
        ev.preventDefault();
        openHistory(house);
      };
    }
    if (connect) {
      connect.onclick = function (ev) {
        ev.preventDefault();
        try {
          if (typeof window.navigateToSection === 'function') window.navigateToSection('profile');
        } catch (e) {}
        try {
          if (window.ssidManager && typeof window.ssidManager.openCollect === 'function') {
            window.ssidManager.openCollect();
          }
        } catch (e2) {}
      };
    }
    if (saving) {
      saving.onchange = function () {
        writeSaving(bot.id, saving.checked);
        if (savingOpts) savingOpts.style.display = saving.checked ? '' : 'none';
      };
    }

    try {
      if (opts.mode === 'private' && window.__utkStudioDeskParity && typeof window.__utkStudioDeskParity.rewireSaving === 'function') {
        window.__utkStudioDeskParity.rewireSaving(house);
      }
    } catch (eSave) {}

    const follow = opts.mode !== 'private';
    const followBot = Object.assign({}, bot, { ladder: ladderOfBot(bot) });
    try {
      if (window.__utkStudioAutotrade && typeof window.__utkStudioAutotrade.bind === 'function') {
        window.__utkStudioAutotrade.bind(house, followBot, signal, {
          follow: follow,
          ladder: ladderOfBot(bot),
          savingOn: function () { return readSaving(bot.id); },
          onPresence: follow ? function (autoOn) {
            try {
              const hubApi = window.__utkCommunityHub;
              if (hubApi && typeof hubApi.api === 'function') {
                hubApi.api('POST', '/studio/global/presence', {
                  id: bot.id,
                  autotrade: !!autoOn
                });
              }
            } catch (e) {}
          } : undefined
        });
      }
    } catch (e3) {}

    try {
      if (window.__utkStudioDeskParity && typeof window.__utkStudioDeskParity.afterWire === 'function') {
        window.__utkStudioDeskParity.afterWire(root, bot, signal, opts);
      }
    } catch (e4) {}

    try {
      if (window.__utkBotMind && typeof window.__utkBotMind.syncStudio === 'function') {
        window.__utkBotMind.syncStudio(house, bot, {
          liveMeta: (opts && opts.liveMeta) || (bot && bot.liveMeta) || null
        });
      }
    } catch (eMind) {}

    if (opts.mode === 'private') {
      try {
        if (window.__utkStudioStreakModal && typeof window.__utkStudioStreakModal.wireHouse === 'function') {
          window.__utkStudioStreakModal.wireHouse(house, bot);
        }
      } catch (e5) {}
    }

    try {
      const displaySig = typeof signalForDisplay === 'function'
        ? signalForDisplay(bot, signal)
        : signal;
      if (window.__utkStudioSignalGlow && typeof window.__utkStudioSignalGlow.apply === 'function') {
        window.__utkStudioSignalGlow.apply(house, displaySig);
      } else if (!displaySig && window.__utkStudioSignalGlow && typeof window.__utkStudioSignalGlow.clear === 'function') {
        window.__utkStudioSignalGlow.clear(house);
      }
    } catch (eGlow) {}
  }

  window.__utkStudioFeedDesk = {
    render: render,
    wire: wire,
    paintCheckProgress: paintCheckProgress,
    signalForDisplay: signalForDisplay
  };
})();
