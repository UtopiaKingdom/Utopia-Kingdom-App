/**
 * bot-studio.js — Cook recipes + Desk tabs. Load AFTER community-hub.js
 * and bot-studio-strategies.js.
 */
(function () {
  'use strict';

  try { require('./bot-studio-strategies.js'); } catch (e) {}

  const LOCAL_KEY = 'utk-studio-bots-v1';
  const MAX_LIVE_BOTS = 3;
  const STATUS_LABEL = {
    idle: 'Idle',
    checking: 'Checking',
    live: 'Live',
    paused: 'Paused',
    armed: 'Live'
  };

  let bots = [];
  let selectedId = '';
  let saving = false;
  let checking = false;
  let activeTab = 'global';
  let familyFilter = 'All';
  let studioOpenedOnce = false;
  let saveChain = Promise.resolve();
  let saveDebounceTimer = null;
  /** Latest pending save per bot id — cook spam must not overwrite a queued go-live. */
  const pendingSaves = Object.create(null);

  function strategiesApi() {
    return window.__utkStudioStrategies || null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** data-cmd attributes — handled by bot-studio-cook-bind.js */
  function cmdAttr(action, arg) {
    let html = ' data-cmd="' + esc(action) + '"';
    if (arg != null && arg !== '') html += ' data-arg="' + esc(String(arg)) + '"';
    return html;
  }

  window.__utkStudioCmdAttr = cmdAttr;
  window.__utkStudioCmd = function () {};

  function tipAttr(title, body, when) {
    let html = ' data-tip="1" data-tip-title="' + esc(title || '') + '" data-tip-body="' + esc(body || '') + '"';
    if (when) html += ' data-tip-when="' + esc(when) + '"';
    return html;
  }

  window.__utkStudioTipAttr = tipAttr;

  function famSlug(family) {
    const api = strategiesApi();
    if (api && typeof api.famSlug === 'function') return api.famSlug(family);
    const s = String(family || 'custom').toLowerCase().replace(/[^a-z]/g, '');
    return s || 'custom';
  }

  function stratMark() {
    return '<span class="studio-strat-mark" aria-hidden="true"><i></i><i></i><i></i></span>';
  }

  function toast(msg, tone) {
    try {
      if (typeof window.showAppToast === 'function') {
        window.showAppToast(msg, { tone: tone || 'info' });
        return;
      }
    } catch (e) {}
  }

  function hub() {
    return window.__utkCommunityHub || null;
  }

  function normalizeStatus(s) {
    const v = String(s || 'idle').toLowerCase();
    if (v === 'armed') return 'live';
    if (v === 'live' || v === 'paused' || v === 'checking' || v === 'idle') return v;
    return 'idle';
  }

  function countLiveBots(excludeId) {
    return bots.filter(function (b) {
      if (excludeId && b.id === excludeId) return false;
      return normalizeStatus(b.status) === 'live';
    }).length;
  }

  function isAtLiveLimit(excludeId) {
    return countLiveBots(excludeId) >= MAX_LIVE_BOTS;
  }

  function chartLabel(tf) {
    const s = String(tf || '1m').toLowerCase();
    if (s.endsWith('h')) return s.slice(0, -1) + ' hour' + (s === '1h' ? '' : 's');
    if (s.endsWith('m') && s !== '1m' && !/^\d+s$/.test(s)) {
      const n = s.slice(0, -1);
      return n + ' minute' + (n === '1' ? '' : 's');
    }
    if (s === '1m') return '1 minute';
    if (s.endsWith('s')) return s.slice(0, -1) + ' second' + (s === '1s' ? '' : 's');
    return s;
  }

  function parseTfSeconds(tf) {
    const s = String(tf || '1m').trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
    if (!m) return 60;
    const n = Number(m[1]);
    const u = m[2] || 's';
    let sec = n;
    if (u === 'm') sec = n * 60;
    else if (u === 'h') sec = n * 3600;
    else if (u === 'ms') sec = Math.max(1, Math.round(n / 1000));
    return Math.max(3, Math.min(14400, Math.round(sec)));
  }

  function secondsToTf(sec) {
    sec = Math.max(3, Math.min(14400, Number(sec) || 60));
    if (sec % 3600 === 0) return (sec / 3600) + 'h';
    if (sec % 60 === 0) return (sec / 60) + 'm';
    return sec + 's';
  }

  const EXPIRY_OPTS = ['30s', '1m', '2m', '3m', '5m'];
  const MG_DEFAULT = [1, 2, 4, 10, 20];

  function normalizeMartingale(mg) {
    if (!Array.isArray(mg) || mg.length !== 5) return MG_DEFAULT.slice();
    return mg.map(function (n, i) {
      const v = Math.round(Number(n));
      return v >= 1 && v <= 500 ? v : MG_DEFAULT[i];
    });
  }

  function normalizeMaxAttempts(raw) {
    const n = Math.round(Number(raw));
    if (!(n >= 1)) return 5;
    return Math.max(1, Math.min(5, n));
  }

  function normalizeTradeBot(bot) {
    bot = bot || {};
    const exp = String(bot.expiry || '1m').toLowerCase();
    bot.expiry = EXPIRY_OPTS.indexOf(exp) >= 0 ? exp : '1m';
    bot.payoutMin = Math.max(90, Math.min(92, Math.round(Number(bot.payoutMin) || 92)));
    bot.martingale = normalizeMartingale(bot.martingale);
    bot.maxAttempts = normalizeMaxAttempts(bot.maxAttempts);
    const lm = String(bot.ladderMode || '').toLowerCase();
    if (lm === 'custom' || lm === 'compact' || lm === 'standard') {
      bot.ladderMode = lm;
    } else {
      const a = bot.martingale.join(',');
      if (a === '1,2,4,8,16') bot.ladderMode = 'compact';
      else if (a === '1,2,4,10,20') bot.ladderMode = 'standard';
      else bot.ladderMode = 'custom';
    }
    bot.otcMode = String(bot.otcMode || 'all').toLowerCase() === 'pick' ? 'pick' : 'all';
    bot.otcPairs = Array.isArray(bot.otcPairs)
      ? bot.otcPairs.map(function (p) { return String(p || '').toUpperCase().replace(/\//g, ''); }).filter(Boolean).slice(0, 24)
      : [];
    if (typeof bot.cookStep !== 'number') bot.cookStep = bot.cookComplete === false ? 0 : 5;
    bot.cookStep = Math.max(0, Math.min(5, Math.round(Number(bot.cookStep))));
    bot.cookComplete = bot.cookStep >= 5;
    const winApi = (typeof window !== 'undefined' && window.__utkStudioCheckWindow) || null;
    bot.checkWindow = winApi && typeof winApi.normalize === 'function'
      ? winApi.normalize(bot.checkWindow)
      : (String(bot.checkWindow || '7d').toLowerCase() === '30d' ? '30d'
        : (String(bot.checkWindow || '7d').toLowerCase() === '14d' ? '14d' : '7d'));
    bot.signalGap = winApi && typeof winApi.normalizeGap === 'function'
      ? winApi.normalizeGap(bot.signalGap)
      : (String(bot.signalGap || '1m').toLowerCase() === '0' ? '0' : '1m');
    return bot;
  }

  function normalizeWatchBot(bot) {
    bot = bot || {};
    let mode = String(bot.watchMode || 'single').toLowerCase();
    if (mode !== 'combined') mode = 'single';
    let watch = Array.isArray(bot.watch) ? bot.watch.slice() : [];
    if (!watch.length) watch = [bot.timeframe || '1m'];
    watch = watch.map(function (t) { return secondsToTf(parseTfSeconds(t)); });
    if (mode === 'combined') {
      const uniq = [];
      watch.forEach(function (t) { if (uniq.indexOf(t) < 0) uniq.push(t); });
      if (uniq.length < 2) {
        const primary = uniq[0] || '1m';
        uniq.push(primary === '5s' ? '1m' : '5s');
      }
      watch = uniq.slice(0, 2);
    } else {
      watch = [watch[0] || '1m'];
    }
    bot.watchMode = mode;
    bot.watch = watch;
    bot.timeframe = watch[0];
    return normalizeTradeBot(bot);
  }

  function getCookStep(bot) {
    bot = normalizeTradeBot(Object.assign({}, bot || {}));
    return bot.cookStep;
  }

  function attemptsSummary(n) {
    n = normalizeMaxAttempts(n);
    if (n === 1) return 'entry only';
    if (n === 5) return 'up to 5 tries';
    return 'up to ' + n + ' tries';
  }

  function expiryLabel(exp) {
    const map = { '30s': '30 second', '1m': '1 minute', '2m': '2 minute', '3m': '3 minute', '5m': '5 minute' };
    return (map[exp] || '1 minute') + ' expiry';
  }

  function styleLabel(style) {
    const api = strategiesApi();
    if (api && typeof api.labelOf === 'function') return api.labelOf(style);
    return 'Mean reversion';
  }

  function statusLabel(st) {
    return STATUS_LABEL[normalizeStatus(st)] || 'Idle';
  }

  function strategyOf(id) {
    const api = strategiesApi();
    if (api && typeof api.byId === 'function') return api.byId(id);
    return null;
  }

  function readLocal() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map(function (b) {
        b = Object.assign({}, b);
        b.status = normalizeStatus(b.status);
        return normalizeWatchBot(b);
      });
    } catch (e) {
      return [];
    }
  }

  function writeLocal(list) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list || [])); } catch (e) {}
  }

  function localId() {
    let hex = '';
    while (hex.length < 12) hex += Math.floor(Math.random() * 16).toString(16);
    return 'b_' + hex.slice(0, 12);
  }

  function blankBot() {
    const meta = strategyOf('mean-revert');
    const defaults = (meta && meta.defaults) || {
      zScore: 1.5,
      rsiLeave: true,
      rsiLo: 35,
      rsiHi: 65,
      rejectionWick: true,
      volRankMin: 25
    };
    return normalizeWatchBot({
      id: localId(),
      name: 'My bot',
      status: 'idle',
      style: 'mean-revert',
      timeframe: '1m',
      watch: ['1m'],
      watchMode: 'single',
      expiry: '1m',
      payoutMin: 92,
      martingale: MG_DEFAULT.slice(),
      maxAttempts: 5,
      ladderMode: 'standard',
      otcMode: 'all',
      otcPairs: [],
      checkWindow: '7d',
      signalGap: '1m',
      cookStep: 0,
      cookComplete: false,
      rules: Object.assign({}, defaults),
      lastCheck: null,
      published: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  function selected() {
    return bots.find(function (b) { return b.id === selectedId; }) || null;
  }

  function ruleSummary(bot) {
    if (!bot) return '';
    bot = normalizeWatchBot(Object.assign({}, bot));
    const r = bot.rules || {};
    const bits = [];
    bits.push(styleLabel(bot.style));
    if (bot.watchMode === 'combined' && bot.watch.length > 1) {
      bits.push('Combined ' + chartLabel(bot.watch[0]) + ' + ' + chartLabel(bot.watch[1]));
    } else {
      bits.push(chartLabel(bot.timeframe) + ' charts');
    }
    bits.push(expiryLabel(bot.expiry || '1m'));
    if (Number(r.zScore) > 0) bits.push('stretch filter on');
    if (r.rsiLeave) bits.push('RSI ' + (r.rsiLo || 32) + ' / ' + (r.rsiHi || 68));
    if (r.rejectionWick) bits.push('rejection wick');
    if (Number(r.volRankMin) > 0) bits.push('volume filter');
    if (r.useBb) bits.push('Bollinger bands');
    if (r.useEma) bits.push('EMA trend');
    if (r.useStoch) bits.push('Stochastic');
    if (r.useMacd) bits.push('MACD');
    if (r.useCci) bits.push('CCI');
    if (r.useWilliams) bits.push('Williams');
    if (r.useDoji) bits.push('Doji');
    if (r.useAtr) bits.push('ATR');
    if (bot.otcMode === 'pick' && bot.otcPairs && bot.otcPairs.length) {
      const shown = bot.otcPairs.slice(0, 4).join(', ');
      bits.push('OTC: ' + shown + (bot.otcPairs.length > 4 ? '…' : ''));
    } else {
      bits.push('All OTC except indices');
    }
    bits.push('payout ' + (Number(bot.payoutMin) || 92) + '% or more');
    bits.push('ladder ' + (bot.martingale || MG_DEFAULT).slice(0, bot.maxAttempts || 5).join(' '));
    bits.push(attemptsSummary(bot.maxAttempts));
    return bits.join(' · ');
  }

  function applyStrategyDefaults(bot, styleId) {
    const meta = strategyOf(styleId);
    bot.style = styleId;
    if (meta && meta.defaults) {
      bot.rules = Object.assign({}, meta.defaults);
    }
    const nameEl = document.getElementById('studioName');
    if (nameEl) bot.name = String(nameEl.value || '').slice(0, 40) || bot.name;
    return bot;
  }

  function renderList() {
    const el = document.getElementById('studioBotList');
    if (el) {
      if (!bots.length) {
        el.innerHTML = '<p class="studio-empty-list">Start with a new bot</p>';
      } else {
        el.innerHTML = bots.map(function (b) {
          const on = b.id === selectedId ? ' is-on' : '';
          const st = normalizeStatus(b.status);
          return (
            '<button type="button" class="studio-bot-btn' + on + (st === 'live' ? ' is-live' : '') + '" data-studio-bot="' + esc(b.id) + '">' +
              '<span class="studio-bot-name">' + esc(b.name || 'Bot') + '</span>' +
              '<span class="studio-bot-meta">' +
                '<span class="studio-pill studio-pill-' + esc(st) + '">' +
                  (st === 'live' ? '<i class="studio-live-dot"></i>' : '') +
                  esc(statusLabel(st)) +
                '</span>' +
                '<span>' + esc(styleLabel(b.style)) + '</span>' +
                '<span>' + esc(chartLabel(b.timeframe)) + '</span>' +
              '</span>' +
            '</button>'
          );
        }).join('');
        wireRailInteractions();
      }
    }
    try {
      if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.renderHub === 'function') {
        window.__utkStudioBotHub.renderHub();
      }
    } catch (eHub) {}
  }

  function renderTabs(bot) {
    const cookStep = bot && (activeTab === 'cook' || activeTab === 'yours') ? getCookStep(bot) : 5;
    const immersive = activeTab === 'cook' && cookStep < 5;
    let body = '';
    if (activeTab === 'global') {
      body = renderGlobalPane();
    } else if (immersive) {
      body = renderCookPane(bot);
    } else if (!bot) {
      body = renderNeedBotPane('yours');
    } else if (window.__utkStudioBotHub && window.__utkStudioBotHub.isOpen()) {
      body = renderYoursPane(bot);
    } else {
      body = (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.hubPaneHtml === 'function')
        ? window.__utkStudioBotHub.hubPaneHtml()
        : renderNeedBotPane('yours');
    }
    const room = window.__utkStudioRoom;
    const tabs = immersive
      ? ''
      : (room && typeof room.tabsHtml === 'function'
        ? room.tabsHtml(activeTab)
        : (
          '<div class="studio-tabs" role="tablist">' +
            '<button type="button" class="studio-tab' + (activeTab === 'global' ? ' is-on' : '') + '" data-studio-tab="global" role="tab">Community</button>' +
            '<button type="button" class="studio-tab' + (activeTab === 'yours' || activeTab === 'cook' || activeTab === 'desk' ? ' is-on' : '') + '" data-studio-tab="yours" role="tab">My bot</button>' +
          '</div>'
        ));
    return tabs + '<div class="studio-tab-body">' + body + '</div>';
  }

  function renderNeedBotPane() {
    const room = window.__utkStudioRoom;
    if (room && typeof room.needBotHtml === 'function') return room.needBotHtml();
    return (
      '<div class="studio-empty studio-stage">' +
        '<p class="studio-stage-kicker">Studio</p>' +
        '<h2>Make a bot</h2>' +
        '<p>Name it, pick a recipe, then test on real past prices. Go live 24/7 when you like the result.</p>' +
        '<div class="studio-empty-actions">' +
          '<button type="button" class="studio-primary" id="studioEmptyNew">Make a bot</button>' +
          '<button type="button" class="studio-ghost" id="studioEmptyGlobal">See Community</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderGlobalPane() {
    const room = window.__utkStudioRoom;
    if (room && typeof room.globalPaneHtml === 'function') return room.globalPaneHtml();
    return (
      '<div class="studio-global-pane studio-stage" id="studioGlobalPane">' +
        '<div class="studio-global-pane-head">' +
          '<div class="studio-section-head-text">' +
            '<h2>Live tapes</h2>' +
            '<p class="studio-note">Live tapes you can follow. Recipes stay private.</p>' +
          '</div>' +
          '<button type="button" class="studio-ghost" id="studioGlobalRefresh">Refresh</button>' +
        '</div>' +
        '<div id="studioGlobalList" class="studio-global-list"></div>' +
        '<div id="studioGlobalDeskHost" class="studio-global-desk-host" hidden>' +
          '<div id="studioGlobalDesk" class="studio-global-desk"></div>' +
        '</div>' +
      '</div>'
    );
  }

  function normalizeScorecard(card) {
    if (!card || typeof card !== 'object') return null;
    const out = Object.assign({}, card);
    const n = Number(out.wr1N != null ? out.wr1N : out.trades);
    const hasTrades = Number.isFinite(n) && n > 0;
    const okRaw = out.ok;
    const okTrue = okRaw === true || okRaw === 1 || okRaw === 'true' || okRaw === '1';
    // Server/SQLite sometimes stores ok as 1 / "true"; treat finished paper as ready.
    out.ok = !!(okTrue || hasTrades);
    return out;
  }

  function preferScorecard(a, b) {
    const left = normalizeScorecard(a);
    const right = normalizeScorecard(b);
    if (!left) return right;
    if (!right) return left;
    const ln = Number(left.wr1N != null ? left.wr1N : left.trades) || 0;
    const rn = Number(right.wr1N != null ? right.wr1N : right.trades) || 0;
    if (rn > ln) return right;
    if (ln > rn) return left;
    if (right.ok && !left.ok) return right;
    return left;
  }

  function hasBacktest(bot) {
    const card = normalizeScorecard(bot && bot.lastCheck);
    if (!card) return false;
    if (card.ok === true) return true;
    const n = Number(card.wr1N != null ? card.wr1N : card.trades);
    return Number.isFinite(n) && n > 0;
  }

  function syncBotScorecard(bot, scorecard) {
    if (!bot || !bot.id) return bot;
    const next = preferScorecard(bot.lastCheck, scorecard);
    if (!next) return bot;
    const cur = normalizeScorecard(bot.lastCheck);
    const same = cur && next &&
      cur.ok === next.ok &&
      Number(cur.wr1N != null ? cur.wr1N : cur.trades) === Number(next.wr1N != null ? next.wr1N : next.trades) &&
      Number(cur.wr1) === Number(next.wr1);
    bot.lastCheck = next;
    if (same) return bot;
    bot.updatedAt = Date.now();
    upsertLocal(bot, { silent: true });
    try {
      const wrap = document.querySelector('.studio-zone-actions');
      if (wrap && window.__utkStudioBotHub && window.__utkStudioBotHub.isOpen()) {
        wrap.innerHTML = renderActionBar(bot);
      }
    } catch (ePaint) {}
    return bot;
  }

  function renderActionBar(bot) {
    const busy = checking || statusOfSafe(bot) === 'checking';
    const room = window.__utkStudioRoom;
    if (room && typeof room.actionHtml === 'function') {
      return '<div class="studio-actions-wrap">' + room.actionHtml(bot, busy) + '</div>';
    }
    const st = normalizeStatus(bot.status);
    const live = st === 'live';
    const atLiveLimit = !live && isAtLiveLimit(bot.id);
    const tested = hasBacktest(bot);
    const checkLabel = busy ? 'Testing…' : 'Test past candles';
    const liveBlocked = busy || atLiveLimit || (!live && !tested);
    const liveLabel = live ? 'Live now' : (atLiveLimit ? '3 live max' : (!tested ? 'Test first' : 'Go live 24/7'));
    const liveTitle = atLiveLimit
      ? 'Pause a live bot first. Max 3 at once.'
      : (!tested ? 'Run Test past candles before going live.' : '');
    return (
      '<div class="studio-actions">' +
        '<div class="studio-actions-main">' +
          '<button type="button" class="studio-ghost" id="studioCheck"' + cmdAttr('check') + (busy ? ' disabled' : '') + '>' + checkLabel + '</button>' +
          '<button type="button" class="studio-primary" id="studioGoLive"' + cmdAttr('goLive') + (liveBlocked ? ' disabled' : '') +
            (liveTitle ? ' title="' + esc(liveTitle) + '"' : '') + '>' + liveLabel + '</button>' +
        '</div>' +
        '<div class="studio-actions-more">' +
          (live
            ? '<button type="button" class="studio-ghost" id="studioPause"' + cmdAttr('pause') + '>Pause</button>'
            : '') +
          (bot.published
            ? '<button type="button" class="studio-ghost" id="studioUnpublish"' + cmdAttr('unpublish') + '>Stop sharing</button>'
            : '<button type="button" class="studio-ghost" id="studioPublish"' + cmdAttr('publish') + '>Share tape</button>') +
          '<button type="button" class="studio-ghost is-danger" id="studioDelete"' + cmdAttr('delete') + '>Delete</button>' +
        '</div>' +
      '</div>'
    );
  }

  function statusOfSafe(bot) {
    return normalizeStatus(bot && bot.status);
  }

  function renderPathGuide(bot) {
    const room = window.__utkStudioRoom;
    if (room && typeof room.pathHtml === 'function') return room.pathHtml(bot);
    const st = normalizeStatus(bot.status);
    if (st === 'live') return '';
    const checked = !!(bot.lastCheck && bot.lastCheck.ok);
    const paused = st === 'paused';
    return (
      '<ol class="studio-path" aria-label="What to do">' +
        '<li class="' + (checked ? 'is-done' : 'is-now') + '">' +
          '<b>Test it</b>' +
          '<span>Replay real past prices. Required before go live.</span>' +
        '</li>' +
        '<li class="' + (paused ? 'is-done' : (checked ? 'is-now' : '')) + '">' +
          '<b>Go live</b>' +
          '<span>Private 24/7 runner. Locked until the test finishes.</span>' +
        '</li>' +
        '<li>' +
          '<b>Share the tape</b>' +
          '<span>Optional. Recipe stays private.</span>' +
        '</li>' +
      '</ol>'
    );
  }

  function renderYoursPane(bot) {
    bot = normalizeWatchBot(Object.assign({}, bot));
    const st = normalizeStatus(bot.status);
    const live = st === 'live';
    const cookDone = getCookStep(bot) >= 5;
    const unlocked = cookDone || live || st === 'paused' || (bot.lastCheck && bot.lastCheck.ok) || checking;
    const room = window.__utkStudioRoom;
    const desk = unlocked
      ? '<div id="studioDeskRoot" class="studio-desk-root studio-house-desk" data-studio-desk-bot="' + esc(bot.id) + '"></div>'
      : (room && typeof room.emptyDeskHtml === 'function'
        ? room.emptyDeskHtml(bot, checking)
        : (
        '<div class="studio-desk-empty" id="studioDeskRoot">' +
          '<h2>' + esc(bot.name) + '</h2>' +
          '<p>Test walks real OTC prices. Then go live 24/7.</p>' +
          '<button type="button" class="studio-primary" id="studioDeskCheck"' + cmdAttr('check') + (checking ? ' disabled' : '') + '>' +
            (checking ? 'Testing…' : 'Test past candles') +
          '</button>' +
        '</div>'
      ));
    const gateApi = window.__utkStudioGlobal;
    const gateBlock = gateApi && typeof gateApi.gateHtml === 'function'
      ? '<details class="studio-gate-wrap studio-zone"><summary>Share on Community</summary><div class="studio-gate" id="studioGateMount"><p class="studio-note">Needs a real live streak. Recipe stays private.</p></div></details>'
      : '';
    const pathGuide = renderPathGuide(bot);
    return (
      '<div class="studio-yours-pane studio-bot-detail' + (live ? ' is-live-desk' : '') + '">' +
        '<div class="studio-zone studio-zone-desk">' + desk + '</div>' +
        (live ? '' : (
        '<div class="studio-bot-extras">' +
          '<div class="studio-zone studio-zone-actions">' + renderActionBar(bot) + '</div>' +
          (pathGuide ? '<div class="studio-zone-path">' + pathGuide + '</div>' : '') +
          gateBlock +
          '<details class="studio-zone studio-zone-recipe studio-yours-edit" id="studioForm">' +
            '<summary>Recipe · ' + esc(bot.name || 'Bot') + '</summary>' +
            renderCookNameField(bot) +
            '<div id="studioAiMount"></div>' +
            '<button type="button" class="studio-ghost studio-ai-btn" id="studioAiUpgrade"' + cmdAttr('aiUpgrade') + '>Ask AI what to improve</button>' +
            '<div class="studio-block"><div class="studio-block-label">Strategy</div>' + renderCookStrategySection(bot) + '</div>' +
            '<div class="studio-block"><div class="studio-block-label">Chart</div>' + renderCookChartSection(bot) + '</div>' +
            '<div class="studio-block"><div class="studio-block-label">Filters</div>' + renderCookFiltersSection(bot.rules || {}) + '</div>' +
            '<div class="studio-block"><div class="studio-block-label">Numbers</div>' + renderCookNumbersSection(bot.rules || {}) + '</div>' +
            renderCookSummary(bot) +
          '</details>' +
        '</div>'
        )) +
      '</div>'
    );
  }

  function renderCheckWindow(bot, busy) {
    return '';
  }

  function renderFamilyChips() {
    const api = strategiesApi();
    const families = (api && api.families) || ['All'];
    return (
      '<div class="studio-families" role="tablist" aria-label="Strategy family">' +
        families.map(function (f) {
          const on = familyFilter === f ? ' is-on' : '';
          const tip = api && typeof api.familyTip === 'function' ? api.familyTip(f) : null;
          const tips = tip ? tipAttr(tip.title, tip.body, tip.useWhen) : '';
          return '<button type="button" class="studio-family' + on + '"' + cmdAttr('family', f) + tips + ' data-studio-family="' + esc(f) + '">' + esc(f) + '</button>';
        }).join('') +
      '</div>'
    );
  }

  function renderStrategyGrid(bot) {
    const api = strategiesApi();
    const picker = window.__utkStudioStrategyPicker;
    const list = ((api && api.list) || []).filter(function (s) {
      return familyFilter === 'All' || s.family === familyFilter;
    });
    return (
      '<div class="studio-strat-grid">' +
        list.map(function (s) {
          const on = bot.style === s.id;
          const fam = ' studio-fam-' + famSlug(s.family);
          if (picker && typeof picker.cardHtml === 'function') {
            return picker.cardHtml(s, on, fam, cmdAttr, tipAttr);
          }
          return (
            '<button type="button" class="studio-strat-card' + (on ? ' is-on' : '') + fam + '"' + cmdAttr('strategy', s.id) + tipAttr(s.name, s.explain, s.useWhen) + ' data-studio-style="' + esc(s.id) + '">' +
              stratMark() +
              '<span class="studio-strat-family">' + esc(s.family) + '</span>' +
              '<span class="studio-strat-name">' + esc(s.name) + '</span>' +
              '<span class="studio-strat-blurb">' + esc(s.blurb) + '</span>' +
              '<span class="studio-strat-hold">Tap to pick</span>' +
            '</button>'
          );
        }).join('') +
      '</div>'
    );
  }

  function renderStrategyDetail(bot) {
    const meta = strategyOf(bot.style) || {};
    const fam = famSlug(meta.family);
    const hints = window.__utkStudioStrategyHints;
    const hintHtml = hints && typeof hints.html === 'function' ? hints.html(bot.style) : '';
    const picker = window.__utkStudioStrategyPicker;
    if (picker && typeof picker.detailHtml === 'function') {
      return picker.detailHtml(bot, meta, famSlug, hintHtml);
    }
    return (
      '<div class="studio-strat-detail studio-fam-' + esc(fam) + '">' +
        '<div class="studio-picked"' + tipAttr(meta.name, meta.explain, meta.useWhen) + '>' +
          stratMark() +
          '<div>' +
            '<strong>' + esc(meta.name || styleLabel(bot.style)) + '</strong>' +
            '<p>' + esc(meta.explain || 'Tap a card to pick it.') + '</p>' +
          '</div>' +
        '</div>' +
        hintHtml +
      '</div>'
    );
  }

  function renderChartPicks(bot) {
    bot = normalizeWatchBot(Object.assign({}, bot));
    const presets = ['5s', '15s', '30s', '1m', '5m', '15m', '1h', '4h'];
    const short = { '5s': '5s', '15s': '15s', '30s': '30s', '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h' };
    const mode = bot.watchMode;
    const w0 = bot.watch[0];
    const w1 = bot.watch[1] || '5s';
    const isCustom0 = presets.indexOf(w0) < 0;
    const isCustom1 = presets.indexOf(w1) < 0;
    const selectedLabel = mode === 'combined'
      ? chartLabel(w0) + ' + ' + chartLabel(w1)
      : chartLabel(w0);

    function tfBtn(which, tf, current, label, customOn) {
      const on = tf === 'custom' ? (customOn ? ' is-on is-custom' : '') : (current === tf ? ' is-on' : '');
      const tipTitle = tf === 'custom' ? 'Custom' : chartLabel(tf);
      const tipBody = tf === 'custom'
        ? 'Any length from 3 seconds to 4 hours, if a preset is not quite right.'
        : 'Candles this size. Smaller is faster and noisier. Bigger is slower and calmer.';
      return (
        '<button type="button" class="studio-chart-btn' + on + '" data-chart-tf="' + esc(tf) + '" data-chart-slot="' + which + '"' + tipAttr(tipTitle, tipBody) + '>' +
          esc(label) +
        '</button>'
      );
    }

    function row(which, current, customOn) {
      return (
        '<div class="studio-chart-row" data-chart-slot="' + which + '">' +
          presets.map(function (o) { return tfBtn(which, o, current, short[o] || o, false); }).join('') +
          tfBtn(which, 'custom', current, 'Custom', customOn) +
        '</div>'
      );
    }

    return (
      '<div class="studio-chart" id="studioChart">' +
        '<div class="studio-chart-selected">Selected: <strong>' + esc(selectedLabel) + '</strong></div>' +
        '<div class="studio-chart-mode" role="group" aria-label="Chart mode">' +
          '<button type="button" class="studio-chart-mode-btn' + (mode === 'single' ? ' is-on' : '') + '" data-chart-mode="single"' + tipAttr('Single chart', 'The bot watches one candle size. Simple and the usual way for new bots.') + '>Single chart</button>' +
          '<button type="button" class="studio-chart-mode-btn' + (mode === 'combined' ? ' is-on' : '') + '" data-chart-mode="combined"' + tipAttr('Two charts combined (advanced)', 'Both timeframes must agree before an entry. Much stricter — fewer live signals.') + '>Two charts <span class="studio-adv-tag">Advanced</span></button>' +
        '</div>' +
        '<p class="studio-hint">' + (mode === 'combined'
          ? 'Advanced: both charts must agree. Expect longer quiet stretches live than on a single 1m chart.'
          : 'Tap the candle size this bot watches. Hold one if you want it in plain words. Start with 1m.') + '</p>' +
        '<div class="studio-chart-row-label">' + (mode === 'combined' ? 'First chart' : 'Watch chart') + '</div>' +
        row('a', isCustom0 ? '' : w0, isCustom0) +
        '<label class="studio-field studio-custom-tf"' + (isCustom0 ? '' : ' hidden') + '>Custom seconds (3 to 14400)' +
          '<input id="studioCustomSecA" type="number" min="3" max="14400" step="1" value="' + esc(parseTfSeconds(w0)) + '" />' +
        '</label>' +
        (mode === 'combined'
          ? (
            '<div class="studio-chart-row-label">Second chart</div>' +
            row('b', isCustom1 ? '' : w1, isCustom1) +
            '<label class="studio-field studio-custom-tf"' + (isCustom1 ? '' : ' hidden') + '>Custom seconds (3 to 14400)' +
              '<input id="studioCustomSecB" type="number" min="3" max="14400" step="1" value="' + esc(parseTfSeconds(w1)) + '" />' +
            '</label>'
          )
          : '') +
        '<input type="hidden" id="studioTimeframe" value="' + esc(w0) + '" />' +
        '<input type="hidden" id="studioWatchMode" value="' + esc(mode) + '" />' +
        '<input type="hidden" id="studioWatchJson" value="' + esc(JSON.stringify(bot.watch)) + '" />' +
      '</div>'
    );
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function renderCookFormTop(bot, review) {
    const st = normalizeStatus(bot.status);
    const live = st === 'live';
    const paused = st === 'paused';
    const note = live
      ? 'Live. The private runner is on for this recipe only.'
      : (paused
        ? 'Paused. Go live when you want signals again.'
        : (review
          ? 'Recipe is ready. Check the past, then go live.'
          : 'Idle. Walk through each step. Hold anything that looks unclear.'));
    const actions = review ? renderActionBar(bot) : '';
    return (
      '<div class="studio-form-top">' +
        '<div>' +
          '<h2>' + esc(bot.name) + '</h2>' +
          '<p class="studio-note">' + esc(note) + '</p>' +
        '</div>' +
        actions +
      '</div>'
    );
  }

  function renderCookNameField(bot) {
    try {
      if (window.__utkStudioName && typeof window.__utkStudioName.html === 'function') {
        return window.__utkStudioName.html(bot);
      }
    } catch (e) {}
    return (
      '<div class="studio-name-row" id="studioNameRow">' +
        '<input type="hidden" id="studioName" value="' + esc(bot.name) + '" />' +
        '<button type="button" class="studio-name-open" id="studioNameOpen" data-cmd="openName">' +
          '<span class="studio-name-kicker">Name</span>' +
          '<span class="studio-name-value" id="studioNameLabel">' + esc(bot.name) + '</span>' +
        '</button>' +
      '</div>'
    );
  }

  function renderCookStrategySection(bot) {
    return (
      renderFamilyChips() +
      renderStrategyGrid(bot) +
      renderStrategyDetail(bot) +
      '<input type="hidden" id="studioStyle" value="' + esc(bot.style || 'mean-revert') + '" />'
    );
  }

  function renderCookChartSection(bot) {
    return renderChartPicks(bot);
  }

  function renderCookFiltersSection(r) {
    r = r || {};
    const styleMeta = strategyOf(selected() && selected().style) || {};
    const picker = window.__utkStudioStrategyPicker;
    const styleFilters = picker && typeof picker.activeFilters === 'function'
      ? picker.activeFilters(styleMeta)
      : [];
    const rec = function (name) {
      return styleFilters.indexOf(name) >= 0
        ? ' <span class="studio-filter-rec">From style</span>'
        : '';
    };
    const groups = [
      {
        title: 'Core checks',
        hint: 'These decide if price stretched enough and timing looks right.',
        rows: [
          ['studioStretch', Number(r.zScore) > 0, 'Stretch', 'Price must leave its average first',
            'How far price ran from its recent average. On means you wait for a stretch before fading or joining.', 'Choppy markets. Turn off if you want more trades.', 'Stretch'],
          ['studioRsi', !!r.rsiLeave, 'RSI', 'Enter when RSI leaves an extreme',
            'RSI is a heat meter from 0 to 100. You enter when it turns back out of oversold or overbought.', 'You want a clear oscillator rule.', 'RSI'],
          ['studioWick', !!r.rejectionWick, 'Rejection wick', 'Need a wick that rejects the move',
            'A long wick means price poked a level and got slapped back. That slap is the timing.', 'Obvious highs and lows, not messy noise.', 'Wick'],
          ['studioVolOn', Number(r.volRankMin) > 0, 'Volume', 'Skip dead markets',
            'Quiet pairs fake you out. Volume keeps the bot on pairs that are actually moving.', 'You hate empty tapes.', 'Volume']
        ]
      },
      {
        title: 'Indicators',
        hint: 'Optional tools that add confirmation. Turn on what matches your style.',
        rows: [
          ['studioBb', !!r.useBb, 'Bollinger', 'Use band touches and squeezes',
            'Bands around the average. A touch of the outer band is stretch. A squeeze is a coil before a move.', 'Ranges that respect the bands.', 'Bollinger'],
          ['studioEma', !!r.useEma, 'EMA trend', 'Fast and slow average must agree',
            'Two moving averages. Fast above slow is up. Fast below slow is down.', 'Days with a real direction.', 'EMA'],
          ['studioStoch', !!r.useStoch, 'Stochastic', 'Cross inside the extreme zone',
            'Another heat meter. You want a cross in the oversold or overbought zone.', 'Range sessions.', 'Stochastic'],
          ['studioMacd', !!r.useMacd, 'MACD', 'Need MACD histogram on your side',
            'MACD tracks whether momentum is with you.', 'Trend days.', 'MACD'],
          ['studioCci', !!r.useCci, 'CCI', 'Commodity Channel Index extremes',
            'CCI above plus 100 or below minus 100 is stretch.', 'You already like oscillator fades.', 'CCI'],
          ['studioWilliams', !!r.useWilliams, 'Williams %R', 'Flip out of the extreme zone',
            'Williams sits near 0 when overbought and near minus 100 when oversold.', 'Soft trends and ranges.', 'Williams'],
          ['studioAtr', !!r.useAtr, 'ATR expansion', 'Need volatility waking up',
            'ATR is how much price usually moves. Expansion means the market is waking up.', 'You want movement, not a dead tape.', 'ATR']
        ]
      },
      {
        title: 'Candle patterns',
        hint: 'Shape-based triggers. Best on clean highs and lows.',
        rows: [
          ['studioPin', !!r.usePinbar, 'Pin bar', 'Prefer long rejection wicks',
            'A pin is a candle with a long wick and a small body.', 'Clean swing highs and lows.', 'Pin bar'],
          ['studioEngulf', !!r.useEngulfing, 'Engulfing', 'Prefer full reverse candles',
            'This candle fully eats the last one. A strong reverse print.', 'You like candle language.', 'Engulfing'],
          ['studioDoji', !!r.useDoji, 'Doji', 'Prefer tiny indecision candles',
            'Open and close are almost the same. The market paused.', 'After a long run, not in the middle of chop.', 'Doji']
        ]
      }
    ];
    const onNow = styleFilters.length ? styleFilters : [];
    const lead = onNow.length
      ? '<p class="studio-filter-lead"><strong>' + esc(styleMeta.name || 'This style') + '</strong> starts with ' + esc(onNow.join(', ')) + '. Toggle anything below — hold a row for a plain English explanation.</p>'
      : '<p class="studio-filter-lead">Nothing is locked in yet. Turn on the filters you want, or go back and pick a style for smart defaults.</p>';
    function rowHtml(row) {
      const recName = row[6] || row[2];
      return (
        '<label class="studio-toggle"' + tipAttr(row[2], row[4], row[5]) + '>' +
          '<input id="' + row[0] + '" type="checkbox"' + (row[1] ? ' checked' : '') + ' />' +
          '<span><strong>' + esc(row[2]) + rec(recName) + '</strong><em>' + esc(row[3]) + '</em></span>' +
        '</label>'
      );
    }
    return (
      '<div class="studio-filter-groups">' +
        lead +
        groups.map(function (g) {
          return (
            '<section class="studio-filter-group">' +
              '<div class="studio-filter-group-head"><strong>' + esc(g.title) + '</strong><em>' + esc(g.hint) + '</em></div>' +
              '<div class="studio-toggles">' + g.rows.map(rowHtml).join('') + '</div>' +
            '</section>'
          );
        }).join('') +
      '</div>'
    );
  }

  function numberFieldVisible(id, r) {
    r = r || {};
    if (id === 'studioZ') return Number(r.zScore) > 0;
    if (id === 'studioRsiLo' || id === 'studioRsiHi') return !!r.rsiLeave;
    if (id === 'studioVol') return Number(r.volRankMin) > 0;
    if (id === 'studioBbPeriod' || id === 'studioBbDev') return !!r.useBb;
    if (id === 'studioEmaFast' || id === 'studioEmaSlow') return !!r.useEma;
    if (id === 'studioStochLo' || id === 'studioStochHi') return !!r.useStoch;
    return false;
  }

  function renderCookNumbersSection(r) {
    r = r || {};
    const fields = [
      ['studioZ', 'Stretch', num(r.zScore, 2), '0', '5', '0.1',
        'How far price must run from its average before we care. 2 is a solid stretch. 0 turns this off.'],
      ['studioRsiLo', 'RSI low', num(r.rsiLo, 32), '5', '50', '1',
        'Oversold wall. The bot waits for RSI to leave this zone, not to first touch it.'],
      ['studioRsiHi', 'RSI high', num(r.rsiHi, 68), '50', '95', '1',
        'Overbought wall. Same idea on the hot side.'],
      ['studioVol', 'Volume min', num(r.volRankMin, 40), '0', '100', '1',
        'Skip quiet pairs. 40 means volume in about the top 60 percent. 0 turns this off.'],
      ['studioBbPeriod', 'BB period', num(r.bbPeriod, 20), '10', '40', '1',
        'How many candles build the Bollinger bands. 20 is the usual.'],
      ['studioBbDev', 'BB width', num(r.bbDev, 2), '1', '3', '0.1',
        'How wide the bands sit from the middle. 2 is classic. Higher means rarer touches.'],
      ['studioEmaFast', 'EMA fast', num(r.emaFast, 10), '3', '50', '1',
        'The quicker average. It reacts first when the trend turns.'],
      ['studioEmaSlow', 'EMA slow', num(r.emaSlow, 20), '5', '200', '1',
        'The slower average. Fast above slow is up. Fast below slow is down.'],
      ['studioStochLo', 'Stoch low', num(r.stochLo, 20), '5', '40', '1',
        'Oversold line for Stochastic. Crosses below this, then back, are the usual fade.'],
      ['studioStochHi', 'Stoch high', num(r.stochHi, 80), '60', '95', '1',
        'Overbought line for Stochastic. Same idea on the hot side.']
    ];
    const visible = fields.filter(function (f) { return numberFieldVisible(f[0], r); });
    if (!visible.length) {
      return (
        '<p class="studio-numbers-lead">No number fields are active yet. Turn on Stretch, RSI, Bollinger, or other filters in the previous step, or pick a style that uses them.</p>' +
        '<div class="studio-grid studio-grid-3" hidden></div>'
      );
    }
    return (
      '<p class="studio-numbers-lead">Only showing numbers for filters that are on. Defaults are fine for most bots — tweak if you know what you want.</p>' +
      '<div class="studio-grid studio-grid-3">' +
        visible.map(function (f) {
          return (
            '<label class="studio-field"' + tipAttr(f[1], f[6]) + '>' +
              '<span class="studio-field-name">' + esc(f[1]) + '</span>' +
              '<input id="' + f[0] + '" type="number" min="' + f[3] + '" max="' + f[4] + '" step="' + f[5] + '" value="' + esc(f[2]) + '" />' +
            '</label>'
          );
        }).join('') +
      '</div>'
    );
  }

  function renderCookSummary(bot) {
    return '<p class="studio-summary">' + esc(ruleSummary(bot)) + '</p>';
  }

  function registerCookParts() {
    window.__utkBotStudioParts = {
      esc: esc,
      ruleSummary: ruleSummary,
      renderFormTop: renderCookFormTop,
      renderName: renderCookNameField,
      renderStrategy: renderCookStrategySection,
      renderChart: renderCookChartSection,
      renderFilters: renderCookFiltersSection,
      renderNumbers: renderCookNumbersSection,
      renderSummary: renderCookSummary
    };
  }

  function renderCookPane(bot) {
    bot = normalizeWatchBot(Object.assign({}, bot));
    registerCookParts();
    const wiz = window.__utkStudioWizard;
    if (wiz && typeof wiz.render === 'function') {
      return wiz.render(bot, getCookStep(bot));
    }
    const r = bot.rules || {};
    return (
      '<form id="studioForm" class="studio-form">' +
        renderCookFormTop(bot, true) +
        '<div id="studioAiMount"></div>' +
        renderCookNameField(bot) +
        '<div class="studio-block"><div class="studio-block-label">Strategy</div>' + renderCookStrategySection(bot) + '</div>' +
        '<div class="studio-block"><div class="studio-block-label">Chart</div>' + renderCookChartSection(bot) + '</div>' +
        '<div class="studio-block"><div class="studio-block-label">Filters</div>' + renderCookFiltersSection(r) + '</div>' +
        '<div class="studio-block"><div class="studio-block-label">Numbers</div>' + renderCookNumbersSection(r) + '</div>' +
        renderCookSummary(bot) +
      '</form>'
    );
  }

  function renderDeskPane(bot) {
    const st = normalizeStatus(bot.status);
    const unlocked = st === 'live' || st === 'paused' || (bot.lastCheck && bot.lastCheck.ok);
    if (!unlocked) {
      return (
        '<div class="studio-desk-empty" id="studioDeskRoot">' +
          '<h2>Desk</h2>' +
          '<p>Check this bot on past candles, then go live. The desk lights up with the signal, streak, history, and autotrade once it is running.</p>' +
          '<button type="button" class="studio-primary" id="studioDeskCheck">Check now</button>' +
        '</div>'
      );
    }
    return '<div id="studioDeskRoot" class="studio-desk-root" data-studio-desk-bot="' + esc(bot.id) + '"></div>';
  }

  function wireCookModules(root) {
    if (!root) return;
    try {
      if (window.__utkStudioChart && typeof window.__utkStudioChart.wire === 'function') {
        window.__utkStudioChart.wire(root);
      }
    } catch (e) {}
    try {
      if (window.__utkStudioCookBind && typeof window.__utkStudioCookBind.wire === 'function') {
        window.__utkStudioCookBind.wire(root);
      }
    } catch (e2) {}
    bindNameField(root);
  }

  function bindNameField(root) {
    try {
      if (window.__utkStudioName && typeof window.__utkStudioName.wire === 'function') {
        window.__utkStudioName.wire(root);
      }
    } catch (e) {}
  }

  function commitNameFromInput(opts) {
    opts = opts || {};
    const bot = selected();
    if (!bot) return false;
    const edit = document.getElementById('studioNameEdit');
    const hidden = document.getElementById('studioName');
    const raw = opts.value != null ? opts.value : (edit ? edit.value : (hidden ? hidden.value : bot.name));
    const next = String(raw || '').trim().slice(0, 40);
    if (next.length < 2) {
      if (opts.toast) toast('Type at least 2 letters, then tap Yes.', 'info');
      return false;
    }
    bot.name = next;
    bot.updatedAt = Date.now();
    upsertLocal(bot, { silent: true });
    renderList();
    document.querySelectorAll('.studio-form-top h2, .studio-desk-empty h2').forEach(function (h) {
      h.textContent = bot.name;
    });
    try {
      if (window.__utkStudioName && typeof window.__utkStudioName.paint === 'function') {
        window.__utkStudioName.paint(bot.name);
      }
    } catch (ePaint) {}
    scheduleSave(bot);
    if (opts.toast) toast('Name saved.', 'success');
    return true;
  }

  function commitBot(bot, opts) {
    opts = opts || {};
    bot = normalizeWatchBot(Object.assign({}, bot));
    bot.updatedAt = Date.now();
    selectedId = bot.id;
    const next = bots.filter(function (b) { return b.id !== bot.id; });
    next.unshift(bot);
    bots = next;
    writeLocal(bots);
    if (!opts.skipList) renderList();
    if (opts.render === 'cook') {
      if (getCookStep(bot) === 0 && document.getElementById('studioName')) paintStrategyPick(bot);
      else refreshCookPane();
    } else if (!opts.keepEditor) {
      renderEditor();
    }
    return bot;
  }

  function updateCookChrome(bot) {
    const page = document.getElementById('studioPage');
    const editor = document.getElementById('studioEditor');
    const cookStep = bot ? getCookStep(bot) : 5;
    const immersive = activeTab === 'cook' && cookStep < 5;
    if (page) {
      // Keep rail width stable between Feed / Yours so the tab switch does not jump.
      page.classList.remove('is-global-focus');
      page.classList.toggle('is-cook-wizard', immersive);
    }
    if (editor) {
      editor.classList.toggle('is-cook-immersive', immersive);
      const tabs = editor.querySelector('.studio-tabs');
      if (tabs) tabs.style.display = immersive ? 'none' : '';
    }
  }

  /** Patch Cook UI in place — avoids full editor flash. */
  function refreshCookPane() {
    const el = document.getElementById('studioEditor');
    let bot = selected();
    if (!el || activeTab !== 'cook' || !bot) return;

    const cookStep = getCookStep(bot);
    if (cookStep >= 5) {
      activeTab = 'yours';
      renderEditor();
      return;
    }

    updateCookChrome(bot);
    if (document.activeElement && document.activeElement.id === 'studioName') {
      paintStrategyPick(bot);
      return;
    }
    let tabBody = el.querySelector('.studio-tab-body');
    if (!tabBody) {
      renderEditor();
      return;
    }
    const focus = snapshotStudioFocus();
    tabBody.innerHTML = renderCookPane(bot);
    try {
      if (window.__utkStudioTips && typeof window.__utkStudioTips.hide === 'function') {
        window.__utkStudioTips.hide();
      }
    } catch (eTip) {}
    wireCookModules(el);
    restoreStudioFocus(focus);
    bot = selected();
  }

  function fillPublishGate(bot) {
    const mount = document.getElementById('studioGateMount');
    if (!mount || !bot) return;
    const wrap = mount.closest('details.studio-gate-wrap');
    const paintLocal = function () {
      const g = window.__utkStudioGlobal;
      const paid = g && typeof g.entitledPaid === 'function' ? g.entitledPaid() : false;
      const paper = bot.lastCheck || null;
      if (g && g.gateHtml) mount.innerHTML = g.gateHtml({}, paid, paper);
    };
    // Defer network until the share panel is opened — speeds bot open.
    if (wrap && !wrap.open) {
      paintLocal();
      if (wrap.dataset.utkGateWired === '1') return;
      wrap.dataset.utkGateWired = '1';
      wrap.addEventListener('toggle', function () {
        if (!wrap.open) return;
        fillPublishGate(bot);
      });
      return;
    }
    const api = hub() && hub().api;
    const g = window.__utkStudioGlobal;
    const paid = g && typeof g.entitledPaid === 'function' ? g.entitledPaid() : false;
    const paper = bot.lastCheck || null;
    if (!api) {
      paintLocal();
      return;
    }
    api('GET', '/studio/desk?id=' + encodeURIComponent(bot.id)).then(function (data) {
      if (!mount.isConnected) return;
      const gate = (data && data.gate) || {};
      const isPaid = data && data.paid != null ? !!data.paid : paid;
      const paperCard = (data && data.scorecard) || paper;
      try {
        if (window.__utkBotStudio && typeof window.__utkBotStudio.syncBotScorecard === 'function' && paperCard) {
          window.__utkBotStudio.syncBotScorecard(bot, paperCard);
        }
      } catch (eSync) {}
      if (g && g.gateHtml) {
        mount.innerHTML = g.gateHtml(gate, isPaid, paperCard);
      }
    }).catch(function () {
      if (g && g.gateHtml && mount.isConnected) {
        mount.innerHTML = g.gateHtml({}, paid, paper);
      }
    });
  }

  function paintStudioTabBody(bot) {
    const editor = document.getElementById('studioEditor');
    if (!editor) return false;
    const cookStep = bot ? getCookStep(bot) : 5;
    const immersive = activeTab === 'cook' && cookStep < 5;
    updateCookChrome(bot);

    if (immersive) {
      renderEditor();
      return true;
    }

    let tabs = editor.querySelector('.studio-tabs');
    if (!tabs) {
      tabs = document.createElement('div');
      tabs.className = 'studio-tabs';
      tabs.setAttribute('role', 'tablist');
      editor.insertBefore(tabs, editor.firstChild);
    }
    const room = window.__utkStudioRoom;
    tabs.className = 'studio-tabs' + (room ? ' studio-tabs-plain' : '');
    tabs.style.display = '';
    tabs.innerHTML = room && typeof room.tabsHtml === 'function'
      ? (function () {
          const wrap = document.createElement('div');
          wrap.innerHTML = room.tabsHtml(activeTab);
          const inner = wrap.querySelector('.studio-tabs');
          return inner ? inner.innerHTML : wrap.innerHTML;
        }())
      : (
        '<button type="button" class="studio-tab' + (activeTab === 'global' ? ' is-on' : '') + '" data-studio-tab="global" role="tab">Community</button>' +
        '<button type="button" class="studio-tab' + (activeTab === 'yours' || activeTab === 'cook' || activeTab === 'desk' ? ' is-on' : '') + '" data-studio-tab="yours" role="tab">My bot</button>'
      );

    let tabBody = editor.querySelector('.studio-tab-body');
    if (!tabBody) {
      tabBody = document.createElement('div');
      tabBody.className = 'studio-tab-body';
      editor.appendChild(tabBody);
    }

    let body = '';
    if (activeTab === 'global') body = renderGlobalPane();
    else if (!bot) body = renderNeedBotPane('yours');
    else if (window.__utkStudioBotHub && window.__utkStudioBotHub.isOpen()) body = renderYoursPane(bot);
    else body = (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.hubPaneHtml === 'function')
      ? window.__utkStudioBotHub.hubPaneHtml()
      : renderNeedBotPane('yours');

    tabBody.style.transition = '';
    tabBody.style.opacity = '1';
    tabBody.innerHTML = body;

    if ((activeTab === 'yours' || activeTab === 'desk') && bot &&
        (!window.__utkStudioBotHub || window.__utkStudioBotHub.isOpen())) {
      try {
        const desk = window.__utkStudioDesk;
        const root = document.getElementById('studioDeskRoot');
        if (desk && typeof desk.mount === 'function' && root && root.getAttribute('data-studio-desk-bot')) {
          desk.mount(root, bot);
        }
      } catch (e) {}
      fillPublishGate(bot);
    }
    if (activeTab === 'global') {
      try {
        const g = window.__utkStudioGlobal;
        if (g && typeof g.isDeskOpen === 'function' && g.isDeskOpen() && typeof g.getOpenId === 'function' && typeof g.open === 'function') {
          g.open(g.getOpenId());
        } else if (g && typeof g.mountStudio === 'function') {
          g.mountStudio();
        }
      } catch (e2) {}
    }
    wireStudioInteractions(editor);
    wireCookModules(editor);
    afterStudioPaint(tabBody);
    return true;
  }

  function switchStudioTab(next) {
    let tab = next || 'global';
    if (tab === 'desk' || tab === 'cook') tab = 'yours';
    if (tab === 'yours') {
      const curY = selected();
      if (curY && getCookStep(curY) < 5) tab = 'cook';
    }
    if (tab === activeTab) {
      const bot = selected();
      if (tab === 'cook' && bot && getCookStep(bot) < 5) {
        refreshCookPane();
      }
      return;
    }
    activeTab = tab;
    if (tab === 'global' && window.__utkStudioBotHub) {
      window.__utkStudioBotHub.backToHub({ silent: true });
    }
    if (activeTab === 'yours' && !selected() && bots.length) selectedId = bots[0].id;
    if (activeTab === 'cook' && !selected() && bots.length) selectedId = bots[0].id;
    if (activeTab === 'yours' && window.__utkStudioBotHub) {
      window.__utkStudioBotHub.backToHub({ silent: true });
    }
    renderList();
    paintStudioTabBody(selected());
  }

  function snapshotStudioFocus() {
    const a = document.activeElement;
    if (!a || !a.id) return null;
    const tag = String(a.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return null;
    if (!document.getElementById('section-studio') || !document.getElementById('section-studio').contains(a)) return null;
    return {
      id: a.id,
      value: a.value,
      start: a.selectionStart,
      end: a.selectionEnd
    };
  }

  function restoreStudioFocus(snap) {
    if (!snap || !snap.id) return;
    const el = document.getElementById(snap.id);
    if (!el) return;
    try {
      if (snap.value != null && el.value !== snap.value) el.value = snap.value;
      el.focus();
      if (typeof el.setSelectionRange === 'function' && snap.start != null) {
        el.setSelectionRange(snap.start, snap.end);
      }
    } catch (e) {}
  }

  function renderEditor(opts) {
    try {
      if (window.__utkStudioTips && typeof window.__utkStudioTips.hide === 'function') {
        window.__utkStudioTips.hide();
      }
    } catch (eTip) {}
    const el = document.getElementById('studioEditor');
    if (!el) return;
    if (!(opts && opts.force) && document.activeElement && document.activeElement.id === 'studioName') return;
    if (activeTab === 'desk') activeTab = 'yours';
    if (activeTab === 'cook') {
      if (!selected() && bots.length) selectedId = bots[0].id;
      if (!bots.length) {
        const draft = blankBot();
        draft.name = 'My bot 1';
        selectedId = draft.id;
        upsertLocal(draft, { silent: true });
      }
      const cur = selected();
      if (cur && getCookStep(cur) >= 5) activeTab = 'yours';
    }
    if (activeTab === 'yours') {
      // Only auto-pick a bot when immersing into detail — hub stays a list.
      if (!selected() && bots.length && window.__utkStudioBotHub && window.__utkStudioBotHub.isOpen()) {
        selectedId = bots[0].id;
      }
    }
    const bot = selected();
    const focus = snapshotStudioFocus();
    updateCookChrome(bot);
    el.innerHTML = renderTabs(bot);
    try {
      window.dispatchEvent(new CustomEvent('utk:studio-render', { detail: { tab: activeTab } }));
    } catch (eEv) {}
    if ((activeTab === 'yours' || activeTab === 'desk') && bot &&
        (!window.__utkStudioBotHub || window.__utkStudioBotHub.isOpen())) {
      try {
        const desk = window.__utkStudioDesk;
        const root = document.getElementById('studioDeskRoot');
        if (desk && typeof desk.mount === 'function' && root && root.getAttribute('data-studio-desk-bot')) {
          desk.mount(root, bot);
        }
      } catch (e) {}
      fillPublishGate(bot);
    }
    if (activeTab === 'global') {
      try {
        const g = window.__utkStudioGlobal;
        if (g && typeof g.isDeskOpen === 'function' && g.isDeskOpen() && typeof g.getOpenId === 'function' && typeof g.open === 'function') {
          g.open(g.getOpenId());
        } else if (g && typeof g.mountStudio === 'function') {
          g.mountStudio();
        }
      } catch (e2) {}
    }
    wireStudioInteractions(el);
    wireCookModules(el);
    if (!focus) afterStudioPaint(el);
    restoreStudioFocus(focus);
  }

  function afterStudioPaint(root) {
    try {
      if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.afterPaint === 'function') {
        window.__utkStudioBotHub.afterPaint();
      }
    } catch (eHub) {}
    try {
      if (window.__utkStudioStage && typeof window.__utkStudioStage.enter === 'function') {
        window.__utkStudioStage.enter(root);
      }
    } catch (e) {}
  }

  function wireRailInteractions() {
    /* clicks handled by bot-studio-interactions.js */
  }

  function wireStudioInteractions(root) {
    /* clicks handled by bot-studio-interactions.js */
  }

  function onStudioFormChange() {
    if (activeTab !== 'cook' && activeTab !== 'yours') return;
    const cur = selected();
    if (!cur || !document.getElementById('studioForm')) return;
    const ae = document.activeElement;
    if (ae && (ae.id === 'studioName' || (ae.closest && ae.closest('#studioNameRow')))) return;
    const bot = readForm(cur);
    bot.updatedAt = Date.now();
    upsertLocal(bot, { silent: true });
    scheduleSave(bot);
  }

  function readForm(base) {
    const bot = Object.assign({}, base || blankBot());
    bot.rules = Object.assign({}, bot.rules || {});
    const name = document.getElementById('studioName');
    const style = document.getElementById('studioStyle');
    const tf = document.getElementById('studioTimeframe');
    const stretch = document.getElementById('studioStretch');
    const z = document.getElementById('studioZ');
    const rsi = document.getElementById('studioRsi');
    const wick = document.getElementById('studioWick');
    const volOn = document.getElementById('studioVolOn');
    const vol = document.getElementById('studioVol');
    const rsiLo = document.getElementById('studioRsiLo');
    const rsiHi = document.getElementById('studioRsiHi');
    const bb = document.getElementById('studioBb');
    const ema = document.getElementById('studioEma');
    const stoch = document.getElementById('studioStoch');
    const pin = document.getElementById('studioPin');
    const engulf = document.getElementById('studioEngulf');
    const macd = document.getElementById('studioMacd');
    const cci = document.getElementById('studioCci');
    const williams = document.getElementById('studioWilliams');
    const doji = document.getElementById('studioDoji');
    const atr = document.getElementById('studioAtr');
    const bbPeriod = document.getElementById('studioBbPeriod');
    const bbDev = document.getElementById('studioBbDev');
    const emaFast = document.getElementById('studioEmaFast');
    const emaSlow = document.getElementById('studioEmaSlow');
    const stochLo = document.getElementById('studioStochLo');
    const stochHi = document.getElementById('studioStochHi');

    if (name) bot.name = String(name.value || '').slice(0, 40);
    if (style) bot.style = style.value;
    const modeEl = document.getElementById('studioWatchMode');
    const watchJson = document.getElementById('studioWatchJson');
    let watch = [];
    try {
      watch = watchJson ? JSON.parse(watchJson.value) : [];
    } catch (e) {
      watch = [];
    }
    const customA = document.getElementById('studioCustomSecA');
    const customB = document.getElementById('studioCustomSecB');
    if (customA) {
      const lab = customA.closest('.studio-field');
      if (lab && !lab.hasAttribute('hidden')) watch[0] = secondsToTf(Number(customA.value) || 60);
    }
    if (customB) {
      const lab = customB.closest('.studio-field');
      if (lab && !lab.hasAttribute('hidden')) watch[1] = secondsToTf(Number(customB.value) || 60);
    }
    bot.watchMode = modeEl ? modeEl.value : (bot.watchMode || 'single');
    bot.watch = watch.length ? watch : [tf ? tf.value : (bot.timeframe || '1m')];
    bot = normalizeWatchBot(bot);

    const expiryEl = document.getElementById('studioExpiry');
    const payoutEl = document.getElementById('studioPayoutMin');
    const otcModeEl = document.getElementById('studioOtcMode');
    const otcPairsEl = document.getElementById('studioOtcPairsJson');
    const mgJson = document.getElementById('studioMartingaleJson');
    const mgPreset = document.getElementById('studioMgPreset');
    if (expiryEl) bot.expiry = expiryEl.value;
    if (payoutEl) bot.payoutMin = Number(payoutEl.value);
    if (otcModeEl) bot.otcMode = otcModeEl.value;
    if (otcPairsEl) {
      try { bot.otcPairs = JSON.parse(otcPairsEl.value); } catch (e2) { bot.otcPairs = bot.otcPairs || []; }
    }
    if (mgPreset) bot.ladderMode = mgPreset.value === 'custom' || mgPreset.value === 'compact' ? mgPreset.value : 'standard';
    const maxAttemptsEl = document.getElementById('studioMaxAttempts');
    if (maxAttemptsEl) bot.maxAttempts = normalizeMaxAttempts(maxAttemptsEl.value);
    if (mgPreset && mgPreset.value === 'custom') {
      const steps = [];
      for (let i = 0; i < 5; i++) {
        const inp = document.getElementById('studioMg' + i);
        steps.push(inp ? Number(inp.value) : (bot.martingale || MG_DEFAULT)[i]);
      }
      bot.martingale = steps;
      bot.ladderMode = 'custom';
    } else if (mgJson) {
      try { bot.martingale = JSON.parse(mgJson.value); } catch (e3) { /* keep */ }
    }
    bot = normalizeTradeBot(bot);

    if (stretch) {
      let zVal = z ? Number(z.value) : Number(bot.rules.zScore || 0);
      if (!stretch.checked) zVal = 0;
      else if (!(zVal > 0)) zVal = 2;
      bot.rules.zScore = zVal;
    } else if (z) {
      bot.rules.zScore = Number(z.value);
    }
    if (rsi) bot.rules.rsiLeave = !!rsi.checked;
    if (wick) bot.rules.rejectionWick = !!wick.checked;
    if (volOn || vol) {
      let volVal = vol ? Number(vol.value) : Number(bot.rules.volRankMin || 0);
      if (volOn && !volOn.checked) volVal = 0;
      else if (volOn && volOn.checked && !(volVal > 0)) volVal = 40;
      bot.rules.volRankMin = volVal;
    }
    if (rsiLo) bot.rules.rsiLo = Number(rsiLo.value) || 32;
    if (rsiHi) bot.rules.rsiHi = Number(rsiHi.value) || 68;
    if (bb) bot.rules.useBb = !!bb.checked;
    if (ema) bot.rules.useEma = !!ema.checked;
    if (stoch) bot.rules.useStoch = !!stoch.checked;
    if (pin) bot.rules.usePinbar = !!pin.checked;
    if (engulf) bot.rules.useEngulfing = !!engulf.checked;
    if (macd) bot.rules.useMacd = !!macd.checked;
    if (cci) bot.rules.useCci = !!cci.checked;
    if (williams) bot.rules.useWilliams = !!williams.checked;
    if (doji) bot.rules.useDoji = !!doji.checked;
    if (atr) bot.rules.useAtr = !!atr.checked;
    if (bbPeriod) bot.rules.bbPeriod = Number(bbPeriod.value) || 20;
    if (bbDev) bot.rules.bbDev = Number(bbDev.value) || 2;
    if (emaFast) bot.rules.emaFast = Number(emaFast.value) || 10;
    if (emaSlow) bot.rules.emaSlow = Number(emaSlow.value) || 20;
    if (stochLo) bot.rules.stochLo = Number(stochLo.value) || 20;
    if (stochHi) bot.rules.stochHi = Number(stochHi.value) || 80;
    bot.status = normalizeStatus(bot.status);
    bot.updatedAt = Date.now();
    if (base && typeof base.cookStep === 'number') bot.cookStep = base.cookStep;
    if (base && base.cookComplete != null) bot.cookComplete = !!base.cookComplete;
    if (base && base.checkWindow) bot.checkWindow = base.checkWindow;
    if (base && base.signalGap != null) bot.signalGap = base.signalGap;
    return normalizeTradeBot(bot);
  }

  function mergeServerBot(sent, remote) {
    if (!remote) return sent;
    const merged = Object.assign({}, remote);
    merged.style = sent.style;
    merged.watch = sent.watch;
    merged.watchMode = sent.watchMode;
    merged.timeframe = sent.timeframe;
    merged.rules = Object.assign({}, sent.rules || {});
    merged.name = sent.name;
    merged.status = sent.status;
    merged.expiry = sent.expiry || '1m';
    merged.payoutMin = sent.payoutMin || 92;
    merged.martingale = sent.martingale || MG_DEFAULT.slice();
    merged.maxAttempts = normalizeMaxAttempts(sent.maxAttempts != null ? sent.maxAttempts : merged.maxAttempts);
    merged.ladderMode = sent.ladderMode || 'standard';
    merged.otcMode = sent.otcMode || 'all';
    merged.otcPairs = Array.isArray(sent.otcPairs) ? sent.otcPairs.slice() : [];
    merged.checkWindow = sent.checkWindow || '7d';
    merged.signalGap = sent.signalGap || '1m';
    merged.cookStep = typeof sent.cookStep === 'number' ? sent.cookStep : 5;
    merged.cookComplete = sent.cookComplete != null ? !!sent.cookComplete : true;
    if (remote.lastCheck || sent.lastCheck) {
      merged.lastCheck = preferScorecard(sent.lastCheck, remote.lastCheck);
    }
    if (remote.published != null) merged.published = remote.published;
    if (remote.globalId) merged.globalId = remote.globalId;
    merged.id = remote.id || sent.id;
    merged.updatedAt = Math.max(Number(sent.updatedAt) || 0, Number(remote.updatedAt) || 0);
    return normalizeWatchBot(merged);
  }

  function cloneBotSnapshot(bot) {
    const snapshot = Object.assign({}, bot || {});
    snapshot.rules = Object.assign({}, (bot && bot.rules) || {});
    snapshot.status = normalizeStatus(snapshot.status);
    return snapshot;
  }

  function mergeSaveJob(prev, bot, opts) {
    const nextBot = cloneBotSnapshot(bot);
    const nextOpts = Object.assign({}, (prev && prev.opts) || {}, opts || {});
    if ((prev && prev.opts && prev.opts.requireRemote) || (opts && opts.requireRemote)) {
      nextOpts.requireRemote = true;
    }
    const prevStatus = prev && prev.bot ? normalizeStatus(prev.bot.status) : '';
    const nextStatus = normalizeStatus(nextBot.status);
    // Never let a quiet autosave demote a queued / in-flight live bot to idle.
    if (nextStatus === 'paused') {
      nextBot.status = 'paused';
    } else if (
      prevStatus === 'live' ||
      nextStatus === 'live' ||
      nextOpts.requireRemote
    ) {
      if (nextStatus !== 'live' && nextStatus !== 'paused') {
        nextBot.status = 'live';
      }
    }
    return { bot: nextBot, opts: nextOpts };
  }

  function scheduleSave(bot) {
    if (!bot) return;
    const snapshot = cloneBotSnapshot(bot);
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(function () {
      saveDebounceTimer = null;
      enqueueSave(snapshot, { quiet: true, silentRender: true }).catch(function () {});
    }, 350);
  }

  function clearSaveDebounce() {
    if (!saveDebounceTimer) return;
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }

  /** Flush debounced saves then push this bot to the server immediately. */
  function flushSave(bot, opts) {
    clearSaveDebounce();
    return enqueueSave(bot, opts || {});
  }

  function enqueueSave(bot, opts) {
    opts = opts || {};
    const id = bot && bot.id ? String(bot.id) : '';
    if (id) {
      pendingSaves[id] = mergeSaveJob(pendingSaves[id], bot, opts);
    }
    saveChain = saveChain.then(function () {
      let jobBot = bot;
      let jobOpts = opts;
      if (id && pendingSaves[id]) {
        const job = pendingSaves[id];
        delete pendingSaves[id];
        jobBot = job.bot;
        jobOpts = job.opts || {};
      }
      return saveBotNow(jobBot, jobOpts).catch(function (err) {
        if (err && err.body && err.body.error === 'live_limit') throw err;
        if (jobOpts && jobOpts.requireRemote) throw err;
      });
    });
    return saveChain;
  }
  function upsertLocal(bot, opts) {
    bot.status = normalizeStatus(bot.status);
    if (!bot.id) bot.id = localId();
    const next = bots.filter(function (b) { return b.id !== bot.id; });
    next.unshift(bot);
    bots = next;
    writeLocal(bots);
    if (!(opts && opts.silent)) {
      renderList();
      renderEditor();
    }
  }

  /** Cook clicks need a bot; create one locally right away if missing. */
  function ensureBot() {
    const cur = selected();
    if (cur) return cur;
    const bot = blankBot();
    bot.name = 'My bot ' + (bots.length + 1);
    selectedId = bot.id;
    upsertLocal(bot);
    flushSave(bot, { quiet: true, silentRender: true }).catch(function () {});
    return bot;
  }

  async function saveBotNow(bot, opts) {
    opts = opts || {};
    const sent = Object.assign({}, bot);
    sent.rules = Object.assign({}, bot.rules || {});
    if (!sent.id) sent.id = localId();
    sent.status = normalizeStatus(sent.status);
    sent.updatedAt = Date.now();

    const api = hub() && hub().api;
    if (!api) {
      upsertLocal(sent, { silent: opts.silentRender });
      if (!opts.silentRender) {
        renderList();
        renderEditor();
      }
      if (opts.requireRemote) {
        const err = new Error('sign_in');
        err.code = 'not_synced';
        throw err;
      }
      if (!opts.quiet) toast('Saved on this PC.', 'info');
      return sent;
    }

    saving = true;
    try {
      const data = await api('POST', '/studio', { bot: sent });
      const newerLocal = bots.find(function (b) { return b.id === sent.id; });
      if (newerLocal && (Number(newerLocal.updatedAt) || 0) > (Number(sent.updatedAt) || 0)) {
        if (opts.requireRemote) {
          // Go-live / status push: never re-POST an idle snapshot that raced in mid-flight.
          // Call saveBotNow directly — flushSave would deadlock on saveChain.
          const keep = cloneBotSnapshot(newerLocal);
          const sentLive = normalizeStatus(sent.status) === 'live';
          const localStatus = normalizeStatus(keep.status);
          if (sentLive && localStatus !== 'live' && localStatus !== 'paused') {
            keep.status = 'live';
          }
          return saveBotNow(keep, {
            quiet: true,
            silentRender: true,
            requireRemote: true
          });
        }
        scheduleSave(newerLocal);
        return newerLocal;
      }
      if (data && data.bot) {
        let merged = mergeServerBot(sent, data.bot);
        merged.status = normalizeStatus(merged.status);
        if (selectedId === sent.id && merged.id !== sent.id) selectedId = merged.id;
        upsertLocal(merged, { silent: opts.silentRender });
        if (!opts.silentRender) {
          renderList();
          renderEditor();
        }
        merged.__utkSynced = true;
        return merged;
      }
      if (opts.requireRemote) {
        const err = new Error('not_synced');
        err.code = 'not_synced';
        throw err;
      }
    } catch (err) {
      if (err && err.body && err.body.error === 'live_limit') {
        const prev = bots.find(function (b) { return b.id === sent.id; });
        const reverted = Object.assign({}, sent, {
          status: normalizeStatus(prev && prev.status !== 'live' ? prev.status : 'idle')
        });
        upsertLocal(reverted, { silent: opts.silentRender });
        if (!opts.silentRender) {
          renderList();
          renderEditor();
        }
        if (!opts.quiet) toast('You can only run 3 bots live at once. Pause one first.', 'error');
        throw err;
      }
      if (err && err.body && err.body.error === 'need_backtest') {
        const prev = bots.find(function (b) { return b.id === sent.id; });
        const reverted = Object.assign({}, sent, {
          status: normalizeStatus(prev && prev.status !== 'live' ? prev.status : 'idle')
        });
        upsertLocal(reverted, { silent: opts.silentRender });
        if (!opts.silentRender) {
          renderList();
          renderEditor();
        }
        if (!opts.quiet) toast((err.body && err.body.message) || 'Run Test past candles before going live.', 'error');
        throw err;
      }
      if (opts.requireRemote) {
        upsertLocal(sent, { silent: opts.silentRender });
        throw err;
      }
      upsertLocal(sent, { silent: opts.silentRender });
      if (!opts.silentRender) {
        renderList();
        renderEditor();
      }
      if (!opts.quiet) {
        toast('Saved on this PC. Server did not take it yet.', 'info');
      }
    } finally {
      saving = false;
    }
    return sent;
  }

  async function saveBot(bot, opts) {
    opts = opts || {};
    if (!bot.id) bot.id = localId();
    bot.status = normalizeStatus(bot.status);
    bot.updatedAt = Date.now();
    upsertLocal(bot, { silent: true });
    if (!opts.silentRender) {
      renderList();
      renderEditor();
    }
    return enqueueSave(bot, opts);
  }

  async function loadRemote() {
    const api = hub() && hub().api;
    const memory = bots.slice();
    if (!api) {
      if (!memory.length) bots = readLocal();
      return;
    }
    try {
      const data = await api('GET', '/studio');
      const remote = Array.isArray(data.bots) ? data.bots : [];
      const byId = {};

      memory.forEach(function (b) {
        if (b && b.id) byId[b.id] = b;
      });
      readLocal().forEach(function (b) {
        if (!b || !b.id) return;
        const cur = byId[b.id];
        if (!cur) byId[b.id] = b;
        else if ((Number(b.updatedAt) || 0) > (Number(cur.updatedAt) || 0)) byId[b.id] = b;
      });

      remote.forEach(function (r) {
        r = normalizeWatchBot(r);
        r.status = normalizeStatus(r.status);
        const cur = byId[r.id];
        if (!cur) {
          byId[r.id] = r;
        } else if ((Number(r.updatedAt) || 0) > (Number(cur.updatedAt) || 0)) {
          byId[r.id] = r;
        }
      });

      bots = Object.keys(byId).map(function (k) { return byId[k]; });
      writeLocal(bots);
    } catch (e) {
      if (!bots.length) bots = memory.length ? memory : readLocal();
    }
  }

  async function newBot() {
    if (!requireStudioBuild()) return;
    const bot = blankBot();
    bot.name = 'My bot ' + (bots.length + 1);
    bot.cookStep = 0;
    bot.cookComplete = false;
    selectedId = bot.id;
    activeTab = 'cook';
    familyFilter = 'All';
    if (window.__utkStudioBotHub) window.__utkStudioBotHub.backToHub({ silent: true });
    upsertLocal(bot);
    toast('Let’s pick an idea. Hold a card if you want it explained.', 'success');
    flushSave(bot, { quiet: true, silentRender: true }).catch(function () {});
  }

  async function saveOnly() {
    const cur = selected();
    if (!cur) {
      toast('Pick a bot first.', 'error');
      return;
    }
    let bot = cur;
    try {
      bot = readForm(cur);
    } catch (e) {
      bot = Object.assign({}, cur);
    }
    if (!bot.name || bot.name.length < 2) {
      toast('Give the bot a name.', 'error');
      return;
    }
    await saveBot(bot);
    toast('Saved.', 'success');
  }

  async function setStatus(status) {
    if (checking) {
      toast('Wait for Check to finish.', 'info');
      return;
    }
    const cur = selected();
    if (!cur) {
      toast('Pick a bot first.', 'error');
      return;
    }
    if (normalizeStatus(status) === 'live') {
      if (isAtLiveLimit(cur.id)) {
        toast('You can only run 3 bots live at once. Pause one first.', 'error');
        return;
      }
      if (!hasBacktest(cur)) {
        toast('Run Test past candles first. Then you can go live.', 'error');
        try {
          activeTab = 'yours';
          if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.openBot === 'function') {
            window.__utkStudioBotHub.openBot(cur.id);
          }
          renderEditor({ force: true });
        } catch (eGate) {}
        return;
      }
      let ok = false;
      try {
        if (window.__utkAccessGate && typeof window.__utkAccessGate.isPaid === 'function') {
          ok = !!window.__utkAccessGate.isPaid();
        } else if (typeof window.hasActiveAppAccess === 'function') {
          ok = !!window.hasActiveAppAccess();
        } else if (window.__utkEntitlementCache && (window.__utkEntitlementCache.paidActive || window.__utkEntitlementCache.isOwner || window.__utkEntitlementCache.betaTester)) {
          ok = true;
        }
      } catch (e) {}
      if (!ok) {
        toast('Citizen subscription required to go live.', 'error');
        try {
          if (window.__utkAccessGate && typeof window.__utkAccessGate.openSubscribe === 'function') {
            window.__utkAccessGate.openSubscribe('studio');
          }
        } catch (e2) {}
        return;
      }
    }
    let bot = cur;
    try {
      bot = (activeTab === 'cook' || activeTab === 'yours') ? readForm(cur) : Object.assign({}, cur);
    } catch (e2) {
      bot = Object.assign({}, cur);
    }
    if (!bot.name || bot.name.length < 2) {
      toast('Give the bot a name.', 'error');
      return;
    }
    const prevStatus = normalizeStatus(cur.status);
    const wantLive = normalizeStatus(status) === 'live';
    bot.status = normalizeStatus(status);
    bot.updatedAt = Date.now();
    if (wantLive) {
      bot.lastCheck = normalizeScorecard(bot.lastCheck) || bot.lastCheck;
    }
    // Pin status locally before the network round-trip so cook/form autosaves
    // cannot snapshot idle while go-live is in flight.
    upsertLocal(bot, { silent: true });
    let saved = bot;
    try {
      saved = await flushSave(bot, {
        quiet: true,
        silentRender: true,
        requireRemote: wantLive || normalizeStatus(status) === 'paused'
      });
    } catch (errLive) {
      if (errLive && errLive.body && errLive.body.error === 'live_limit') {
        bot.status = prevStatus;
        upsertLocal(bot);
        renderEditor();
        return;
      }
      if (errLive && errLive.body && errLive.body.error === 'need_backtest') {
        bot.status = prevStatus;
        upsertLocal(bot, { silent: true });
        renderEditor({ force: true });
        toast((errLive.body && errLive.body.message) || 'Run Test past candles before going live.', 'error');
        return;
      }
      bot.status = prevStatus;
      upsertLocal(bot, { silent: true });
      renderEditor();
      toast(
        wantLive
          ? 'Could not go live on the server. Sign in and try again.'
          : 'Could not update bot status right now.',
        'error'
      );
      return;
    }
    bot = saved || bot;
    if (normalizeStatus(bot.status) === 'live') {
      toast('Live on server. Desk is connecting…', 'success');
      activeTab = 'yours';
      if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.openBot === 'function') {
        window.__utkStudioBotHub.openBot(bot.id);
      }
      try {
        if (window.__utkSignalNotify && typeof window.__utkSignalNotify.registerStudioBot === 'function') {
          window.__utkSignalNotify.registerStudioBot(bot.id, bot.name, { feed: false });
        }
      } catch (eN) {}
      renderEditor({ force: true });
      try {
        const desk = window.__utkStudioDesk;
        if (desk && typeof desk.refresh === 'function') {
          desk.refresh(bot);
        }
      } catch (eDesk) {}
      const liveStatus = window.__utkStudioLiveStatus;
      if (liveStatus && typeof liveStatus.verify === 'function') {
        const botId = bot.id;
        const verifyOnce = function (delayMs) {
          setTimeout(function () {
            liveStatus.verify({ id: botId, status: 'live' }).then(function (res) {
              if (!res) return;
              toast(res.message, res.ok ? 'success' : 'info');
            }).catch(function () {});
          }, delayMs);
        };
        verifyOnce(1500);
        verifyOnce(6000);
        verifyOnce(20000);
      }
    } else if (normalizeStatus(bot.status) === 'paused') {
      toast('Paused. It is no longer sending signals.', 'info');
      renderEditor({ force: true });
    } else {
      renderEditor({ force: true });
    }
  }

  async function duplicateSelected() {
    const cur = selected();
    if (!cur) {
      toast('Pick a bot first.', 'error');
      return;
    }
    const copy = Object.assign({}, cur);
    copy.id = localId();
    copy.name = String(cur.name || 'My bot').slice(0, 32) + ' copy';
    copy.status = 'idle';
    copy.published = false;
    copy.globalId = '';
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    copy.rules = Object.assign({}, cur.rules || {});
    copy.martingale = Array.isArray(cur.martingale) ? cur.martingale.slice() : MG_DEFAULT.slice();
    copy.watch = Array.isArray(cur.watch) ? cur.watch.slice() : [cur.timeframe || '1m'];
    copy.lastCheck = cur.lastCheck ? Object.assign({}, cur.lastCheck) : null;
    copy.cookComplete = true;
    copy.cookStep = 5;
    selectedId = copy.id;
    upsertLocal(copy);
    try {
      await flushSave(copy, { quiet: true, silentRender: true, requireRemote: true });
    } catch (e) {
      await flushSave(copy, { quiet: true, silentRender: true }).catch(function () {});
    }
    renderList();
    renderEditor({ force: true });
    toast('Duplicated. Test again if you change rules, then go live.', 'success');
  }

  async function confirmThenGoLive() {
    const cur = selected();
    if (!cur) {
      toast('Pick a bot first.', 'error');
      return;
    }
    const modal = window.__utkStudioOptionsModal;
    if (modal && typeof modal.confirmGoLive === 'function') {
      const ok = await modal.confirmGoLive(cur);
      if (!ok) return;
    }
    await setStatus('live');
  }

  async function pauseBot() {
    const cur = selected();
    if (!cur) return;
    const takedown = window.__utkStudioTakedown;
    if (takedown && typeof takedown.isPublished === 'function' && takedown.isPublished(cur)) {
      const res = await takedown.request(cur, {
        title: 'Pause and leave Community?',
        message: 'Pausing removes your tape from Community. Say why you are taking it down.',
        ok: 'Pause and remove tape'
      });
      if (!res || !res.ok) return;
      cur.published = false;
      await saveBot(Object.assign({}, cur, { status: 'paused', published: false }));
      toast('Paused and removed from Community.', 'info');
      renderEditor({ force: true });
      return;
    }
    await setStatus('paused');
  }

  async function runCheck() {
    if (checking) {
      toast('Already checking.', 'info');
      return;
    }
    const cur = selected();
    if (!cur) {
      toast('Pick a bot first.', 'error');
      return;
    }
    let bot = cur;
    try {
      bot = (activeTab === 'cook' || activeTab === 'yours') ? readForm(cur) : Object.assign({}, cur);
    } catch (e) {
      bot = Object.assign({}, cur);
    }
    if (!bot.name || bot.name.length < 2) {
      toast('Give the bot a name.', 'error');
      return;
    }
    const modal = window.__utkStudioOptionsModal;
    if (modal && typeof modal.openBacktest === 'function') {
      const picked = await modal.openBacktest(bot);
      if (!picked) return;
      bot.checkWindow = picked.checkWindow;
      bot.signalGap = picked.signalGap;
      try {
        bot = readForm(Object.assign({}, bot));
      } catch (eRead) {}
    }
    checking = true;
    bot.status = 'checking';
    let waitPulse = null;
    function stopWaitPulse() {
      if (!waitPulse) return;
      try { clearInterval(waitPulse); } catch (eW) {}
      waitPulse = null;
    }
    try {
      await saveBot(bot, { quiet: true, silentRender: true });
      activeTab = 'yours';
      if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.openBot === 'function') {
        window.__utkStudioBotHub.openBot(bot.id);
      }
      renderEditor();
      const winApi = window.__utkStudioCheckWindow;
      const look = (winApi && winApi.phrase) ? winApi.phrase(bot.checkWindow) : 'week';
      const wait = (winApi && winApi.phraseGap) ? winApi.phraseGap(bot.signalGap) : '1 minute';
      toast('Testing the newest ' + look + ' of live OTC prices, with ' + wait + ' rest after each chain. This can take a few minutes.', 'info');
      try { window.__utkStudioCheckProgress = { pct: 2, i: 0, n: 12, label: 'Loading packs' }; } catch (eProg) {}
      let data = null;
      const local = window.__utkStudioPaper;
      function onPaperProgress(row) {
        try {
          if (window.__utkStudioFeedDesk && typeof window.__utkStudioFeedDesk.paintCheckProgress === 'function') {
            window.__utkStudioFeedDesk.paintCheckProgress(row);
          }
        } catch (ePaint) {}
      }
      function startWaitPulse(label) {
        stopWaitPulse();
        const t0 = Date.now();
        onPaperProgress({ pct: 12, i: 0, n: 0, label: label });
        waitPulse = setInterval(function () {
          const sec = (Date.now() - t0) / 1000;
          // Keep moving slowly while the cloud test runs so it never looks stuck.
          const pct = Math.min(97, 12 + Math.log10(1 + sec) * 28);
          const mins = Math.floor(sec / 60);
          const rem = Math.max(1, Math.round(sec % 60));
          const timeLabel = mins > 0
            ? (mins + 'm ' + rem + 's')
            : (Math.max(1, Math.round(sec)) + 's');
          onPaperProgress({
            pct: pct,
            i: 0,
            n: 0,
            label: label + ', ' + timeLabel
          });
        }, 400);
      }
      if (local && typeof local.run === 'function' && (!local.available || local.available())) {
        try {
          const card = await local.run(bot, onPaperProgress);
          if (card && typeof card === 'object') data = { scorecard: card };
        } catch (eLocal) {
          try { console.warn('[studio] local paper failed, using cloud', eLocal && eLocal.message); } catch (eLog) {}
        }
      }
      if (!data) {
        startWaitPulse('Running your test');
        try {
          const api = hub() && hub().api;
          if (api) {
            const remote = await api('POST', '/studio/check', { bot: bot });
            if (remote) data = remote;
          } else {
            throw new Error('hub_unreachable');
          }
        } catch (eRemote) {
          stopWaitPulse();
          throw eRemote;
        }
        stopWaitPulse();
        onPaperProgress({ pct: 100, i: 1, n: 1, label: 'Done' });
      }
      if (!data) throw new Error('hub_unreachable');
      bot.lastCheck = normalizeScorecard(data.scorecard || data.check || null);
      bot.status = normalizeStatus(cur.status) === 'live' ? 'live' : 'idle';
      if (normalizeStatus(cur.status) === 'paused') bot.status = 'paused';
      await saveBot(bot, { quiet: true, silentRender: true });
      const card = bot.lastCheck || {};
      if (card.ok && card.trades) {
        toast('Test done. First tries ' + card.wr1 + '%. ' + (function () {
          const pace = window.__utkStudioClarity && window.__utkStudioClarity.paceCopy
            ? window.__utkStudioClarity.paceCopy(card)
            : null;
          if (pace && pace.toast) return 'Pace hint: ' + pace.toast + '.';
          return 'Typical wait between live signals about ' + (card.liveGapLabel || 'a few minutes') + '.';
        })(), 'success');
      } else if (card.ok) {
        toast(card.message || 'Test done. No entries on these rules.', 'info');
      } else {
        toast(card.message || 'Test done.', 'info');
      }
    } catch (err) {
      bot.status = normalizeStatus(cur.status) === 'live' ? 'live' : 'idle';
      try { await saveBot(bot, { quiet: true, silentRender: true }); } catch (eSave) {}
      const code = err && err.message;
      toast(code === 'hub_unreachable'
        ? 'Could not reach our servers. Try again in a moment.'
        : (code === 'hub_timeout'
          ? 'That test took too long. Try again while prices finish loading.'
          : 'Test failed. Try again.'), 'error');
    } finally {
      checking = false;
      stopWaitPulse();
      try { window.__utkStudioCheckProgress = null; } catch (eClear) {}
      activeTab = 'yours';
      try {
        renderList();
        renderEditor({ force: true });
        const desk = window.__utkStudioDesk;
        if (desk && typeof desk.refresh === 'function') {
          desk.refresh(bot);
        }
      } catch (ePaint) {}
    }
  }

  async function removeSelected() {
    const bot = selected();
    if (!bot) return;
    const dlg = window.__utkStudioDialog;
    let ok = false;
    if (dlg && typeof dlg.confirm === 'function') {
      ok = await dlg.confirm({
        kicker: 'Studio',
        title: 'Delete ' + (bot.name || 'this bot') + '?',
        message: 'It stops running for you. This cannot be undone.',
        ok: 'Delete',
        cancel: 'Keep it',
        danger: true
      });
    } else {
      toast('Could not open delete confirm.', 'error');
      return;
    }
    if (!ok) return;

    let removeFromFeed = false;
    const takedown = window.__utkStudioTakedown;
    if (takedown && typeof takedown.isPublished === 'function' && takedown.isPublished(bot)) {
      const res = await takedown.request(bot, {
        title: 'Delete and leave Community?',
        message: 'Deleting stops your bot and removes the tape from Community. Say why.',
        ok: 'Delete and remove tape',
        danger: true
      });
      if (!res || !res.ok) return;
      removeFromFeed = true;
      bot.published = false;
    } else if (bot.published || bot.globalId) {
      if (dlg && typeof dlg.confirm === 'function') {
        removeFromFeed = await dlg.confirm({
          kicker: 'Community',
          title: 'Remove the live tape too?',
          message: 'People following this bot would stop seeing new trades. The recipe stays private either way.',
          ok: 'Remove tape',
          cancel: 'Keep tape'
        });
      }
    }

    bot.status = 'idle';
    if (removeFromFeed) bot.published = false;

    const api = hub() && hub().api;
    try {
      if (api && bot.id) {
        const q = removeFromFeed ? '' : '&keepGlobal=1';
        await api('DELETE', '/studio?id=' + encodeURIComponent(bot.id) + q);
      }
    } catch (e) {
      toast('Server delete failed. Removed on this PC only.', 'info');
    }
    try {
      if (window.__utkStudioDesk && typeof window.__utkStudioDesk.stop === 'function') {
        window.__utkStudioDesk.stop();
      }
    } catch (e2) {}
    try {
      if (window.__utkStudioGlobal && typeof window.__utkStudioGlobal.refresh === 'function') {
        window.__utkStudioGlobal.refresh();
      }
    } catch (e3) {}
    bots = bots.filter(function (b) { return b.id !== bot.id; });
    writeLocal(bots);
    selectedId = '';
    activeTab = 'yours';
    try {
      if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.backToHub === 'function') {
        window.__utkStudioBotHub.backToHub({ silent: true });
      }
    } catch (eHub) {}
    renderList();
    renderEditor({ force: true });
    toast(removeFromFeed
      ? 'Bot deleted from studio and Feed.'
      : 'Bot deleted from studio. Feed listing kept running.', 'success');
  }

  async function openStudio(opts) {
    opts = opts || {};
    try {
      // Onboarding tour: show Studio UI, never paywall / bounce home.
      if (window.__utkOnboardingActive || window.__utkAccessBypass) {
        /* fall through to render */
      } else if (window.__utkAccessGate && typeof window.__utkAccessGate.canOpenStudio === 'function') {
        if (!window.__utkAccessGate.canOpenStudio()) {
          if (opts.warmOnly) return;
          window.__utkAccessGate.guardStudio();
          try {
            const home = document.getElementById('menu-main');
            if (typeof window.navigateToSection === 'function') {
              // bypass studio guard recursion: go home via DOM
              document.querySelectorAll('.section.active').forEach(function (el) {
                el.classList.remove('active');
              });
              const main = document.getElementById('section-main');
              if (main) main.classList.add('active');
              if (home) {
                document.querySelectorAll('.sidebar-item.active').forEach(function (el) {
                  el.classList.remove('active');
                });
                home.classList.add('active');
              }
            }
          } catch (e2) {}
          return;
        }
      }
    } catch (e) {}
    if (!selected() && bots.length) selectedId = bots[0].id;
    if (!studioOpenedOnce) {
      activeTab = 'global';
      studioOpenedOnce = true;
    }
    if (!opts.warmOnly && window.__utkStudioBotHub) {
      window.__utkStudioBotHub.backToHub({ silent: true });
    }
    renderList();
    if (!opts.warmOnly) renderEditor();
    else {
      try { renderEditor(); } catch (e3) {}
    }
    loadRemote().then(function () {
      if (!selected() && bots[0]) selectedId = bots[0].id;
      renderList();
      if (cookFormLive()) return;
      renderEditor();
    }).catch(function () {});
  }

  /** Idle preload: paint Studio list/editor without navigating. */
  function warm() {
    return openStudio({ warmOnly: true });
  }

  function wizardBotFromForm(fallback) {
    let bot = fallback || selected() || ensureBot();
    if (document.getElementById('studioForm')) {
      try { bot = readForm(bot); } catch (e) { bot = selected() || bot; }
    }
    return bot;
  }

  function wizardNext() {
    activeTab = 'cook';
    let bot = wizardBotFromForm();
    if (!bot) return;
    let step = getCookStep(bot);
    if ((bot.name || '').trim().length < 2) {
      bot.name = 'My bot ' + Math.max(1, bots.length);
    }
    if (step < 5) {
      bot.cookStep = step + 1;
      bot.cookComplete = bot.cookStep >= 5;
    }
    bot = commitBot(bot, { skipList: false });
    if (bot.cookStep >= 5) {
      toast('Recipe ready. Check the past, then go live.', 'success');
      activeTab = 'yours';
      if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.openBot === 'function') {
        window.__utkStudioBotHub.openBot(bot.id);
      }
      renderEditor();
      flushSave(bot, { quiet: true, silentRender: true }).then(function () {
        try {
          const desk = window.__utkStudioDesk;
          if (desk && typeof desk.refresh === 'function') desk.refresh(bot);
        } catch (e) {}
      }).catch(function () {});
    } else {
      scheduleSave(bot);
    }
  }

  function wizardRestart() {
    activeTab = 'cook';
    let bot = wizardBotFromForm();
    if (!bot) return;
    bot.cookStep = 0;
    bot.cookComplete = false;
    bot = commitBot(bot);
    scheduleSave(bot);
  }

  function wizardBack() {
    activeTab = 'cook';
    let bot = wizardBotFromForm();
    if (!bot) return;
    const step = getCookStep(bot);
    if (step > 0) bot.cookStep = step - 1;
    bot.cookComplete = false;
    bot = commitBot(bot, { skipList: true });
    scheduleSave(bot);
  }

  /** Leave cook wizard. Incomplete drafts are discarded; finished bots just exit. */
  async function wizardCancel() {
    const bot = selected() || wizardBotFromForm();
    if (!bot) {
      activeTab = 'yours';
      if (window.__utkStudioBotHub) window.__utkStudioBotHub.backToHub({ silent: true });
      renderList();
      renderEditor();
      return;
    }

    const incomplete = getCookStep(bot) < 5 && !bot.cookComplete && !hasBacktest(bot)
      && normalizeStatus(bot.status) !== 'live';

    if (incomplete) {
      const dlg = window.__utkStudioDialog;
      let ok = true;
      if (dlg && typeof dlg.confirm === 'function') {
        ok = await dlg.confirm({
          kicker: 'Studio',
          title: 'Cancel this bot?',
          message: 'Setup isn’t finished. This draft will be removed.',
          ok: 'Cancel setup',
          cancel: 'Keep editing',
          danger: true
        });
      }
      if (!ok) return;

      try {
        const api = hub() && hub().api;
        if (api && bot.id) {
          await api('DELETE', '/studio?id=' + encodeURIComponent(bot.id) + '&keepGlobal=1');
        }
      } catch (e) {}
      try {
        if (window.__utkStudioDesk && typeof window.__utkStudioDesk.stop === 'function') {
          window.__utkStudioDesk.stop();
        }
      } catch (e2) {}
      bots = bots.filter(function (b) { return b.id !== bot.id; });
      writeLocal(bots);
      selectedId = bots[0] ? bots[0].id : '';
      activeTab = bots.length ? 'yours' : 'global';
      if (window.__utkStudioBotHub) window.__utkStudioBotHub.backToHub({ silent: true });
      renderList();
      renderEditor();
      toast('Setup cancelled.', 'info');
      return;
    }

    // Finished recipe — just leave cook without deleting.
    activeTab = 'yours';
    if (window.__utkStudioBotHub) {
      if (typeof window.__utkStudioBotHub.openBot === 'function' && bot.id) {
        window.__utkStudioBotHub.openBot(bot.id);
      } else {
        window.__utkStudioBotHub.backToHub({ silent: true });
      }
    }
    renderList();
    renderEditor();
  }

  function wizardEdit(step) {
    activeTab = 'cook';
    let bot = wizardBotFromForm();
    if (!bot) return;
    bot.cookStep = Math.max(0, Math.min(4, Number(step) || 0));
    bot.cookComplete = false;
    bot = commitBot(bot, { skipList: true });
    scheduleSave(bot);
  }

  function applyTradePick(mutator, toastMsg) {
    activeTab = 'cook';
    let bot = wizardBotFromForm();
    if (!bot) bot = ensureBot();
    bot = Object.assign({}, bot, {
      rules: Object.assign({}, bot.rules || {}),
      otcPairs: Array.isArray(bot.otcPairs) ? bot.otcPairs.slice() : [],
      martingale: Array.isArray(bot.martingale) ? bot.martingale.slice() : MG_DEFAULT.slice()
    });
    mutator(bot);
    bot = normalizeTradeBot(bot);
    bot = commitBot(bot, { skipList: true, render: 'cook' });
    scheduleSave(bot);
    if (toastMsg) toast(toastMsg, 'info');
    return bot;
  }

  function pickSignalGap(id) {
    if (checking) return;
    const cur = selected();
    if (!cur) return;
    const api = window.__utkStudioCheckWindow;
    const next = api && typeof api.normalizeGap === 'function' ? api.normalizeGap(id) : '1m';
    const label = api && typeof api.phraseGap === 'function' ? api.phraseGap(next) : next;
    commitBot(Object.assign({}, cur, { signalGap: next }));
    scheduleSave(selected());
    toast('Wait between signals: ' + label + '.', 'info');
  }

  function pickCheckWindow(id) {
    if (checking) return;
    const cur = selected();
    if (!cur) return;
    const api = window.__utkStudioCheckWindow;
    const next = api && typeof api.normalize === 'function' ? api.normalize(id) : '7d';
    const label = api && typeof api.phrase === 'function' ? api.phrase(next) : next;
    commitBot(Object.assign({}, cur, { checkWindow: next }));
    scheduleSave(selected());
    toast('Check lookback: ' + label + '.', 'info');
  }

  function pickExpiry(exp) {
    applyTradePick(function (bot) {
      bot.expiry = EXPIRY_OPTS.indexOf(exp) >= 0 ? exp : '1m';
    }, 'Expiry: ' + (EXPIRY_OPTS.indexOf(exp) >= 0 ? exp : '1m'));
  }

  function pickPayout(val) {
    const n = Math.max(80, Math.min(92, Math.round(Number(val) || 92)));
    applyTradePick(function (bot) {
      bot.payoutMin = n;
    }, 'Min payout: ' + n + '%');
  }

  function pickOtcMode(mode) {
    applyTradePick(function (bot) {
      bot.otcMode = mode === 'pick' ? 'pick' : 'all';
      if (bot.otcMode === 'pick' && (!bot.otcPairs || !bot.otcPairs.length)) {
        bot.otcPairs = ['EURUSD', 'GBPUSD', 'USDJPY'];
      }
    }, mode === 'pick' ? 'Pick OTC pairs' : 'All OTC pairs');
  }

  function toggleOtcPair(pair) {
    pair = String(pair || '').toUpperCase().replace(/\//g, '');
    if (!pair) return;
    applyTradePick(function (bot) {
      const list = Array.isArray(bot.otcPairs) ? bot.otcPairs.slice() : [];
      const idx = list.indexOf(pair);
      if (idx >= 0) list.splice(idx, 1);
      else list.push(pair);
      bot.otcPairs = list.slice(0, 24);
      bot.otcMode = 'pick';
    });
  }

  function pickMaxAttempts(n) {
    applyTradePick(function (bot) {
      bot.maxAttempts = normalizeMaxAttempts(n);
    }, attemptsSummary(n));
  }

  function pickMartingale(key) {
    applyTradePick(function (bot) {
      if (key === 'compact') {
        bot.martingale = [1, 2, 4, 8, 16];
        bot.ladderMode = 'compact';
      } else if (key === 'custom') {
        bot.ladderMode = 'custom';
        const cur = (bot.martingale || []).join(',');
        if (cur === '1,2,4,10,20' || cur === '1,2,4,8,16' || !bot.martingale || bot.martingale.length !== 5) {
          bot.martingale = [1, 2, 5, 10, 25];
        } else {
          bot.martingale = normalizeMartingale(bot.martingale);
        }
      } else {
        bot.martingale = MG_DEFAULT.slice();
        bot.ladderMode = 'standard';
      }
    }, key === 'compact' ? 'Ladder: 1-2-4-8-16' : (key === 'custom' ? 'Custom ladder' : 'Ladder: 1-2-4-10-20'));
  }

  function paintStrategyPick(bot) {
    const root = document.getElementById('studioEditor');
    if (!root || !bot) return;
    const styleId = String(bot.style || '');
    root.querySelectorAll('.studio-strat-card').forEach(function (el) {
      const on = el.getAttribute('data-studio-style') === styleId;
      el.classList.toggle('is-on', on);
      const hold = el.querySelector('.studio-strat-hold');
      if (hold) hold.textContent = on ? 'Selected' : 'Tap to pick';
    });
    const hidden = document.getElementById('studioStyle');
    if (hidden) hidden.value = styleId;
    const tag = root.querySelector('.cook-bot-tag');
    if (tag && bot.name) tag.textContent = bot.name;
    const detail = root.querySelector('.studio-strat-detail');
    if (detail) {
      const next = renderStrategyDetail(bot);
      const wrap = document.createElement('div');
      wrap.innerHTML = next;
      const newDetail = wrap.querySelector('.studio-strat-detail');
      if (newDetail) detail.replaceWith(newDetail);
    } else {
      const picked = root.querySelector('.studio-picked');
      if (picked) {
        const next = renderStrategyDetail(bot);
        const wrap = document.createElement('div');
        wrap.innerHTML = next;
        const newDetail = wrap.querySelector('.studio-strat-detail');
        const newPicked = wrap.querySelector('.studio-picked');
        const newHint = wrap.querySelector('.studio-strat-hint');
        if (newDetail) {
          const oldHint = root.querySelector('.studio-strat-hint');
          if (oldHint && oldHint.parentNode) oldHint.remove();
          picked.replaceWith(newDetail);
        } else if (newPicked) {
          picked.replaceWith(newPicked);
          const oldHint = root.querySelector('.studio-strat-hint');
          if (newHint) {
            if (oldHint) oldHint.replaceWith(newHint);
            else if (newPicked.parentNode) newPicked.parentNode.insertBefore(newHint, newPicked.nextSibling);
          } else if (oldHint) oldHint.remove();
        }
      }
    }
  }

  function swapStrategyGrid(bot) {
    const root = document.getElementById('studioEditor');
    if (!root || !bot) return false;
    const nameEl = document.getElementById('studioName');
    const caret = nameEl ? { v: nameEl.value, s: nameEl.selectionStart, e: nameEl.selectionEnd, f: document.activeElement === nameEl } : null;
    const fam = root.querySelector('.studio-families');
    const grid = root.querySelector('.studio-strat-grid');
    if (!grid && !fam) return false;
    const wrap = document.createElement('div');
    if (fam) {
      wrap.innerHTML = renderFamilyChips();
      if (wrap.firstElementChild) fam.replaceWith(wrap.firstElementChild);
    }
    wrap.innerHTML = renderStrategyGrid(bot);
    const nextGrid = root.querySelector('.studio-strat-grid') || grid;
    if (grid && wrap.firstElementChild) grid.replaceWith(wrap.firstElementChild);
    paintStrategyPick(bot);
    const name = document.getElementById('studioName');
    if (name && caret) {
      name.value = caret.v;
      if (caret.f) {
        name.focus();
        try { name.setSelectionRange(caret.s, caret.e); } catch (e) {}
      }
    }
    bindNameField(root);
    return true;
  }

  function cookFormLive() {
    const form = document.getElementById('studioForm');
    if (!form) return false;
    const bot = selected();
    return activeTab === 'cook' && bot && getCookStep(bot) < 5;
  }

  function pickStrategy(styleId) {
    let bot = selected();
    if (!bot) {
      bot = ensureBot();
    } else {
      bot = Object.assign({}, bot, { rules: Object.assign({}, bot.rules || {}) });
    }
    if (getCookStep(bot) < 5) activeTab = 'cook';
    applyStrategyDefaults(bot, styleId);
    bot.updatedAt = Date.now();
    selectedId = bot.id;
    upsertLocal(bot, { silent: true });
    const filtersOnScreen = !!(document.getElementById('studioRsi') || document.getElementById('studioBb') || document.getElementById('studioStretch'));
    if (filtersOnScreen && getCookStep(bot) !== 0) {
      if (activeTab === 'cook') refreshCookPane();
      else renderEditor();
    } else {
      paintStrategyPick(bot);
    }
    scheduleSave(bot);
    toast('Strategy: ' + styleLabel(styleId), 'info');
  }

  function pickTimeframe(tf, slot) {
    let bot = selected();
    if (!bot) bot = ensureBot();
    else {
      bot = Object.assign({}, bot, {
        rules: Object.assign({}, bot.rules || {}),
        watch: (bot.watch || []).slice()
      });
    }
    const presets = ['5s', '15s', '30s', '1m', '5m', '15m', '1h', '4h'];
    if (tf === 'custom') {
      const sec = slot === 'b'
        ? (Number((document.getElementById('studioCustomSecB') || {}).value) || 90)
        : (Number((document.getElementById('studioCustomSecA') || {}).value) || 90);
      tf = secondsToTf(sec);
    } else if (presets.indexOf(tf) < 0) {
      tf = secondsToTf(parseTfSeconds(tf));
    }
    bot.watchMode = String(bot.watchMode || 'single').toLowerCase() === 'combined' ? 'combined' : 'single';
    if (!Array.isArray(bot.watch) || !bot.watch.length) bot.watch = [bot.timeframe || '1m'];
    if (bot.watchMode === 'combined') {
      if (slot === 'b') bot.watch[1] = tf;
      else bot.watch[0] = tf;
    } else {
      bot.watch = [tf];
    }
    bot = normalizeWatchBot(bot);
    bot.updatedAt = Date.now();
    selectedId = bot.id;
    upsertLocal(bot, { silent: true });
    refreshCookPane();
    scheduleSave(bot);
    toast('Chart: ' + chartLabel(bot.timeframe), 'info');
  }

  function pickWatchMode(mode) {
    let bot = selected();
    if (!bot) bot = ensureBot();
    else {
      bot = Object.assign({}, bot, {
        rules: Object.assign({}, bot.rules || {}),
        watch: (bot.watch || []).slice()
      });
    }
    bot.watchMode = mode === 'combined' ? 'combined' : 'single';
    bot = normalizeWatchBot(bot);
    bot.updatedAt = Date.now();
    selectedId = bot.id;
    upsertLocal(bot, { silent: true });
    refreshCookPane();
    scheduleSave(bot);
    toast(mode === 'combined' ? 'Two charts combined' : 'Single chart', 'info');
  }

  function bind() {
    /* clicks: bot-studio-interactions.js */
  }

  function isStudioPaid() {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.canOpenStudio === 'function') {
        return !!window.__utkAccessGate.canOpenStudio();
      }
    } catch (e) {}
    try {
      if (typeof window.hasActiveAppAccess === 'function') return !!window.hasActiveAppAccess();
    } catch (e2) {}
    try {
      const c = window.__utkEntitlementCache;
      if (c && (c.paidActive || c.isOwner || c.betaTester)) return true;
    } catch (e3) {}
    return false;
  }

  /** Tour peek / unpaid: look only — no create / save / live. */
  function canBuildStudioBots() {
    if (window.__utkOnboardingActive) return false;
    return isStudioPaid();
  }

  function requireStudioBuild() {
    if (canBuildStudioBots()) return true;
    if (window.__utkOnboardingActive) {
      toast('This is just a peek — Studio builds unlock with Citizen.', 'info');
      return false;
    }
    toast('Citizen subscription required to build bots.', 'error');
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.openSubscribe === 'function') {
        window.__utkAccessGate.openSubscribe('studio');
      }
    } catch (e) {}
    return false;
  }

  function studioCommand(action, a, b) {
    const act = String(action || '');
    // Read-ish navigation stays open for paid users; anything that creates or
    // edits a bot is blocked for tour / Wanderers.
    const buildActs = {
      newBot: 1,
      save: 1,
      saveName: 1,
      openName: 1,
      check: 1,
      goLive: 1,
      pause: 1,
      duplicate: 1,
      delete: 1,
      formChange: 1,
      wizardNext: 1,
      wizardBack: 1,
      wizardCancel: 1,
      wizardRestart: 1,
      pickStyle: 1,
      pickStrategy: 1,
      timeframe: 1,
      watchMode: 1,
      publish: 1,
      unpublish: 1,
      aiUpgrade: 1,
      selectBot: 1
    };
    if (buildActs[act] && !requireStudioBuild()) return;
    switch (action) {
      case 'strategy':
        pickStrategy(a || 'mean-revert');
        break;
      case 'family':
        ensureBot();
        familyFilter = a || 'All';
        activeTab = 'cook';
        const fb = selected();
        const cookStep = fb ? getCookStep(fb) : 0;
        if (cookStep >= 5) {
          activeTab = 'yours';
          renderList();
          renderEditor();
        } else {
          if (document.getElementById('studioForm') && fb) {
            try { upsertLocal(readForm(fb), { silent: true }); } catch (e) {}
          }
          if (!swapStrategyGrid(selected())) refreshCookPane();
        }
        break;
      case 'timeframe':
        pickTimeframe(a || '1m', b || 'a');
        break;
      case 'watchMode':
        pickWatchMode(a || 'single');
        break;
      case 'tab':
        switchStudioTab(a || 'global');
        break;
      case 'selectBot':
        selectedId = a || '';
        {
          const picked = selected();
          if (picked && getCookStep(picked) < 5) {
            activeTab = 'cook';
            if (window.__utkStudioBotHub) window.__utkStudioBotHub.backToHub({ silent: true });
          } else {
            activeTab = 'yours';
            if (window.__utkStudioBotHub) {
              if (picked) window.__utkStudioBotHub.openBot(picked.id);
              else window.__utkStudioBotHub.backToHub({ silent: true });
            }
          }
        }
        renderList();
        renderEditor();
        break;
      case 'newBot':
        newBot();
        break;
      case 'save':
        Promise.resolve(saveOnly()).catch(function (err) {
          try { console.error('[Studio] save', err); } catch (e) {}
          toast('Could not save.', 'error');
        });
        break;
      case 'saveName':
        commitNameFromInput({ toast: true, value: a });
        break;
      case 'openName':
        try {
          if (window.__utkStudioName && typeof window.__utkStudioName.open === 'function') {
            window.__utkStudioName.open();
          }
        } catch (eName) {}
        break;
      case 'check':
        Promise.resolve(runCheck()).catch(function (err) {
          try { console.error('[Studio] check', err); } catch (e) {}
          toast('Check failed. Try again.', 'error');
        });
        break;
      case 'goLive':
        Promise.resolve(confirmThenGoLive()).catch(function (err) {
          try { console.error('[Studio] goLive', err); } catch (e) {}
          toast('Could not go live.', 'error');
        });
        break;
      case 'pause':
        Promise.resolve(pauseBot()).catch(function (err) {
          try { console.error('[Studio] pause', err); } catch (e) {}
          toast('Could not pause.', 'error');
        });
        break;
      case 'duplicate':
        Promise.resolve(duplicateSelected()).catch(function (err) {
          try { console.error('[Studio] duplicate', err); } catch (e) {}
          toast('Could not duplicate.', 'error');
        });
        break;
      case 'delete':
        Promise.resolve(removeSelected()).catch(function (err) {
          try { console.error('[Studio] delete', err); } catch (e) {}
          toast('Could not delete.', 'error');
        });
        break;
      case 'formChange':
        onStudioFormChange();
        break;
      case 'wizardNext':
        wizardNext();
        break;
      case 'wizardBack':
        wizardBack();
        break;
      case 'wizardCancel':
        Promise.resolve(wizardCancel()).catch(function (err) {
          try { console.error('[Studio] wizardCancel', err); } catch (e) {}
          toast('Could not cancel setup.', 'error');
        });
        break;
      case 'wizardRestart':
        wizardRestart();
        break;
      case 'wizardEdit':
        wizardEdit(a);
        break;
      case 'pickExpiry':
        pickExpiry(a);
        break;
      case 'pickCheckWindow':
        pickCheckWindow(a);
        break;
      case 'pickSignalGap':
        pickSignalGap(a);
        break;
      case 'pickPayout':
        pickPayout(a);
        break;
      case 'pickOtcMode':
        pickOtcMode(a);
        break;
      case 'toggleOtcPair':
        toggleOtcPair(a);
        break;
      case 'pickMaxAttempts':
        pickMaxAttempts(a);
        break;
      case 'pickMartingale':
        pickMartingale(a);
        break;
      case 'aiUpgrade':
        try {
          const cur = selected();
          if (!cur) {
            toast('Pick a bot first.', 'error');
            break;
          }
          let bot = cur;
          try {
            if (document.getElementById('studioForm')) bot = readForm(cur);
          } catch (eRead) {}
          if (window.__utkStudioAi && typeof window.__utkStudioAi.run === 'function') {
            window.__utkStudioAi.run(bot);
          } else {
            toast('AI upgrades unavailable right now.', 'error');
          }
        } catch (e) {
          toast('AI check failed.', 'error');
        }
        break;
      case 'publish':
        try {
          const cur = selected();
          if (!cur) {
            toast('Pick a bot first.', 'error');
            break;
          }
          let bot = cur;
          try {
            if (document.getElementById('studioForm')) bot = readForm(cur);
          } catch (eRead2) {}
          if (window.__utkStudioGlobal && typeof window.__utkStudioGlobal.publish === 'function') {
            window.__utkStudioGlobal.publish(bot);
          } else {
            toast('Publish unavailable right now.', 'error');
          }
        } catch (e) {
          toast('Publish failed.', 'error');
        }
        break;
      case 'unpublish':
        Promise.resolve((async function () {
          const bot = selected();
          if (!bot) return;
          const td = window.__utkStudioTakedown;
          if (!td || typeof td.request !== 'function') {
            toast('Unpublish unavailable right now.', 'error');
            return;
          }
          const res = await td.request(bot, {
            title: 'Stop sharing on Community',
            message: 'Zero people must be on your desk. Tell them why you are removing the tape.',
            ok: 'Remove from Feed'
          });
          if (!res || !res.ok) return;
          const studio = window.__utkBotStudio;
          bot.published = false;
          if (studio && studio.saveBot) await studio.saveBot(bot);
          toast('Removed from Community.', 'info');
          if (window.__utkStudioGlobal && window.__utkStudioGlobal.refresh) window.__utkStudioGlobal.refresh();
          if (studio && studio.refresh) studio.refresh();
        })()).catch(function () {
          toast('Unpublish failed.', 'error');
        });
        break;
      default:
        break;
    }
  }

  function scheduleSectionEnter(fn) {
    try {
      if (window.utkSectionFx && typeof window.utkSectionFx.afterReveal === 'function') {
        window.utkSectionFx.afterReveal(fn);
        return;
      }
    } catch (e) {}
    try {
      requestAnimationFrame(function () {
        try { fn(); } catch (e2) {}
      });
    } catch (e3) {
      try { fn(); } catch (e4) {}
    }
  }

  let studioEnterGen = 0;

  function enterStudio() {
    const gen = ++studioEnterGen;
    scheduleSectionEnter(function () {
      if (gen !== studioEnterGen) return;
      const section = document.getElementById('section-studio');
      if (!section || !section.classList.contains('active')) return;
      openStudio();
    });
  }

  function leaveStudio() {
    studioEnterGen += 1;
    try {
      if (window.__utkStudioDesk && typeof window.__utkStudioDesk.stop === 'function') {
        window.__utkStudioDesk.stop();
      }
    } catch (e) {}
  }

  function patchNavigate() {
    const orig = window.navigateToSection;
    if (typeof orig === 'function' && !orig.__utkStudioPatched) {
      function wrapped(id) {
        const result = orig.apply(this, arguments);
        try {
          if (String(id) === 'studio') enterStudio();
          else leaveStudio();
        } catch (e) {}
        return result;
      }
      wrapped.__utkStudioPatched = true;
      window.navigateToSection = wrapped;
    }
    const section = document.getElementById('section-studio');
    if (!section || section.__utkStudioObserved) return;
    section.__utkStudioObserved = true;
    let wasActive = section.classList.contains('active');
    const obs = new MutationObserver(function () {
      const now = section.classList.contains('active');
      if (now === wasActive) return;
      wasActive = now;
      if (now) enterStudio();
      else leaveStudio();
    });
    obs.observe(section, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    bots = readLocal();
    bind();
    patchNavigate();
    const studioSection = document.getElementById('section-studio');
    if (studioSection && studioSection.classList.contains('active')) {
      openStudio();
    }
  }

  window.__utkStudioCmd = function (action, a, b) {
    try {
      studioCommand(action, a, b);
    } catch (err) {
      try {
        console.error('[Studio]', action, err);
      } catch (e2) {}
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__utkBotStudio = {
    open: openStudio,
    warm: warm,
    saveBot: saveBot,
    selected: selected,
    command: studioCommand,
    pickStrategy: pickStrategy,
    getCookStep: function (bot) { return getCookStep(bot || selected()); },
    bots: function () { return bots.slice(); },
    countLiveBots: countLiveBots,
    isAtLiveLimit: isAtLiveLimit,
    hasBacktest: hasBacktest,
    syncBotScorecard: syncBotScorecard,
    normalizeScorecard: normalizeScorecard,
    MAX_LIVE_BOTS: MAX_LIVE_BOTS,
    refresh: function () { renderList(); renderEditor(); },
    refreshHub: function () {
      if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.renderHub === 'function') {
        window.__utkStudioBotHub.renderHub();
      }
    },
    refreshCookPane: refreshCookPane
  };
})();
