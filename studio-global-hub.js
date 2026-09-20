/**
 * studio-global-hub.js — Feed of community bots (follow tape only).
 * Load AFTER bot-studio.js / bot-studio-desk.js / community-hub.js / studio-autotrade.js.
 */
(function () {
  'use strict';

  let deskTimer = null;
  let openGlobalId = '';
  let cachedList = [];
  let listError = '';
  let lastDeskPaint = '';
  let lastDeskSig = null;
  let deskPullInFlight = false;
  let presenceTick = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, tone) {
    try {
      if (typeof window.showAppToast === 'function') {
        window.showAppToast(msg, { tone: tone || 'info' });
      }
    } catch (e) {}
  }

  function hub() {
    return window.__utkCommunityHub || null;
  }

  function entitledPaid() {
    try {
      const c = window.__utkEntitlementCache;
      if (c && c.paidActive) return true;
      if (c && String(c.subscriptionStatus || '').toLowerCase() === 'active') return true;
    } catch (e) {}
    try {
      const pill = document.getElementById('subscriptionPill');
      if (pill && /subscribed/i.test(pill.textContent || '')) return true;
    } catch (e2) {}
    return false;
  }

  function statusLabel(st) {
    const v = String(st || '').toLowerCase();
    if (v === 'live') return 'Live';
    if (v === 'paused') return 'Paused';
    if (v === 'offline') return 'Offline';
    return 'Idle';
  }

  function renderList(list) {
    const root = document.getElementById('studioGlobalList');
    if (!root) return;
    if (listError) {
      root.innerHTML = '<p class="studio-global-empty">' + esc(listError) + '</p>';
      return;
    }
    if (!list || !list.length) {
      root.innerHTML = '<p class="studio-global-empty">Nobody is live here yet. Make a bot, test it, go live, earn a streak, then share the tape. Your recipe stays private.</p>';
      return;
    }
    root.innerHTML = list.map(function (b) {
      const st = String(b.status || 'offline').toLowerCase();
      const live = st === 'live';
      const elite = !!b.elite || Number(b.bestStreak || 0) >= 50;
      const fam = String(b.family || 'Custom').toLowerCase().replace(/[^a-z]/g, '') || 'custom';
      return (
        '<button type="button" class="studio-global-card-btn' + (live ? ' is-live' : '') + ' studio-fam-' + esc(fam) + '" data-global-id="' + esc(b.id) + '">' +
          '<span class="studio-global-card-top">' +
            '<strong>' + esc(b.name) + '</strong>' +
            '<span class="studio-feed-badges">' +
              (elite ? '<span class="badge is-elite">50+</span>' : '') +
              '<span class="badge' + (live ? ' is-live' : (st === 'paused' ? ' is-paused' : ' is-off')) + '">' +
                (live ? '<i class="studio-live-dot"></i>' : '') +
                esc(statusLabel(st)) +
              '</span>' +
            '</span>' +
          '</span>' +
          '<span class="studio-global-author">' + esc(b.ideaLine || b.family || 'Community bot') + '</span>' +
          '<span class="studio-global-metrics">' +
            '<span><em>Streak</em><b>' + esc(b.streak || 0) + '</b></span>' +
            '<span><em>Best</em><b>' + esc(b.bestStreak || 0) + '</b></span>' +
            '<span title="People on this desk right now"><em>Here now</em><b>' + esc(b.watching || 0) + '</b></span>' +
          '</span>' +
        '</button>'
      );
    }).join('');
  }

  function setFeedImmersive(on) {
    try {
      const page = document.getElementById('studioPage');
      const section = document.getElementById('section-studio');
      const pane = document.getElementById('studioGlobalPane');
      if (page) page.classList.toggle('is-feed-open', !!on);
      if (section) section.classList.toggle('is-feed-open', !!on);
      if (pane) pane.classList.toggle('is-desk-open', !!on);
    } catch (e) {}
  }

  function showList() {
    openGlobalId = '';
    lastDeskPaint = '';
    lastDeskSig = null;
    if (deskTimer) { clearTimeout(deskTimer); deskTimer = null; }
    const list = document.getElementById('studioGlobalList');
    const host = document.getElementById('studioGlobalDeskHost');
    const head = document.querySelector('.studio-global-pane-head');
    const tabs = document.querySelector('#studioEditor .studio-tabs');
    const pane = document.getElementById('studioGlobalPane');
    if (list) {
      list.hidden = false;
      list.classList.remove('is-hiding');
    }
    if (host) {
      host.hidden = true;
      host.classList.remove('is-showing');
    }
    if (head) head.hidden = false;
    if (tabs) tabs.hidden = false;
    if (pane) pane.classList.remove('is-desk-open');
    setFeedImmersive(false);
  }

  function showDesk() {
    const list = document.getElementById('studioGlobalList');
    const host = document.getElementById('studioGlobalDeskHost');
    const head = document.querySelector('.studio-global-pane-head');
    const tabs = document.querySelector('#studioEditor .studio-tabs');
    const pane = document.getElementById('studioGlobalPane');
    if (list) {
      list.classList.add('is-hiding');
      list.hidden = true;
    }
    if (host) {
      host.hidden = false;
      host.classList.add('is-showing');
    }
    if (head) head.hidden = true;
    if (tabs) tabs.hidden = true;
    if (pane) pane.classList.add('is-desk-open');
    setFeedImmersive(true);
  }

  async function refreshList() {
    const api = hub() && hub().api;
    listError = '';
    if (!api) {
      cachedList = [];
      listError = 'Could not reach the hub. Sign in, then tap Refresh.';
      renderList([]);
      return cachedList;
    }
    try {
      const data = await api('GET', '/studio/global');
      cachedList = Array.isArray(data.bots) ? data.bots : [];
    } catch (e) {
      cachedList = [];
      listError = 'Could not load the Feed. Try Refresh in a moment.';
    }
    renderList(cachedList);
    return cachedList;
  }

  function communityDeskHtml(data) {
    if (window.__utkStudioFeedDesk && typeof window.__utkStudioFeedDesk.render === 'function') {
      return window.__utkStudioFeedDesk.render(data);
    }
    return '<p class="studio-global-empty">Feed desk unavailable.</p>';
  }

  async function pullDesk() {
    if (!openGlobalId || deskPullInFlight) return;
    const api = hub() && hub().api;
    const root = document.getElementById('studioGlobalDesk');
    if (!api || !root) return;
    deskPullInFlight = true;
    try {
      const data = await api('GET', '/studio/global/desk?id=' + encodeURIComponent(openGlobalId));
      const bot = (data && data.bot) || { id: openGlobalId, status: 'live' };
      const sig = (data && data.signal) || null;
      lastDeskSig = sig;
      const smooth = window.__utkStudioSmooth;
      const histLen = Array.isArray(data && data.history) ? data.history.length : 0;
      const stats = (data && data.stats) || {};
      const bits = [
        openGlobalId,
        bot.status || '',
        histLen,
        stats.streak || 0,
        stats.bestStreak || 0,
        data && data.watching
      ].concat(smooth && smooth.signalPaintBits ? smooth.signalPaintBits(sig) : [
        sig && sig.signalId,
        sig && sig.phase,
        sig && sig.result,
        sig && sig.side,
        sig && (sig.pair || sig.symbol)
      ]);
      const paintKey = smooth && smooth.paintKey ? smooth.paintKey(bits) : bits.join('|');
      const house = root.querySelector('.studio-feed-house');
      if (house && paintKey === lastDeskPaint) {
        try {
          if (sig && window.__utkStudioSignalLive && typeof window.__utkStudioSignalLive.update === 'function') {
            window.__utkStudioSignalLive.update(house, bot, sig, {
              onExpired: function () { pullDesk(); }
            });
          }
        } catch (eUp) {}
        try {
          if (sig && String(sig.phase || '').toLowerCase() === 'signal' &&
              window.__utkStudioAutotrade && typeof window.__utkStudioAutotrade.tryPlace === 'function') {
            window.__utkStudioAutotrade.tryPlace(bot, sig, { follow: true });
          }
        } catch (eAt) {}
      } else {
        lastDeskPaint = paintKey;
        root.innerHTML = communityDeskHtml(data);
        try {
          if (window.__utkStudioFeedDesk && typeof window.__utkStudioFeedDesk.wire === 'function') {
            window.__utkStudioFeedDesk.wire(root, bot, sig);
          } else if (window.__utkStudioAutotrade && typeof window.__utkStudioAutotrade.bind === 'function') {
            window.__utkStudioAutotrade.bind(root, bot, sig, { follow: true });
          }
        } catch (e2) {}
        try {
          const newHouse = root.querySelector('.studio-feed-house');
          if (newHouse && sig && window.__utkStudioSignalLive && typeof window.__utkStudioSignalLive.start === 'function') {
            window.__utkStudioSignalLive.start(newHouse, bot, sig, {
              onExpired: function () { pullDesk(); }
            });
          }
        } catch (eLive) {}
      }
      presenceTick += 1;
      if (presenceTick % 4 === 1) {
        try {
          let auto = false;
          if (window.__utkStudioAutotrade && typeof window.__utkStudioAutotrade.isOn === 'function') {
            auto = !!window.__utkStudioAutotrade.isOn(openGlobalId);
          }
          await api('POST', '/studio/global/presence', { id: openGlobalId, autotrade: auto });
        } catch (e3) {}
      }
    } catch (e) {
      root.innerHTML = '<p class="studio-global-empty">Could not load this desk.</p>';
      lastDeskPaint = '';
    } finally {
      deskPullInFlight = false;
    }
  }

  function armDeskTimer() {
    if (deskTimer) {
      clearTimeout(deskTimer);
      deskTimer = null;
    }
    if (!openGlobalId) return;
    const tick = function () {
      deskTimer = null;
      if (!openGlobalId) return;
      Promise.resolve(pullDesk()).finally(function () {
        if (!openGlobalId) return;
        const smooth = window.__utkStudioSmooth;
        const ms = smooth && typeof smooth.adaptivePollMs === 'function'
          ? smooth.adaptivePollMs(lastDeskSig, { idle: 1800, hot: 1000 })
          : 1600;
        deskTimer = setTimeout(tick, ms);
      });
    };
    deskTimer = setTimeout(tick, 200);
  }

  function openBot(id) {
    openGlobalId = id || '';
    if (!openGlobalId) return;
    lastDeskPaint = '';
    presenceTick = 0;
    showDesk();
    pullDesk();
    armDeskTimer();
  }

  function backToList() {
    showList();
    refreshList();
  }

  async function mountStudio() {
    if (openGlobalId) {
      showDesk();
      await pullDesk();
      armDeskTimer();
      return;
    }
    showList();
    await refreshList();
  }

  function gateHtml(gate, paid, paper) {
    gate = gate || {};
    paper = paper || {};
    const trades = Number(gate.trades || 0);
    const best = Number(gate.bestStreak || 0);
    const wipe = Number(gate.wipeRate || 0);
    const rows = [
      [paid, 'Paid subscription'],
      [trades >= 25, 'Live trades ' + trades + ' / 25'],
      [best >= 10, 'Live best streak ' + best + ' / 10'],
      [wipe <= 20 || trades === 0, 'Live wipe rate ' + wipe + '% (max 20%)']
    ];
    let paperBlock = '';
    if (paper && paper.ok) {
      const maxChain = paper.maxChainWins != null ? paper.maxChainWins : paper.bestStreak;
      const totalWins = paper.totalWins != null ? paper.totalWins : paper.wins;
      const wipeChains = paper.wipeChains != null ? paper.wipeChains : paper.wipes;
      paperBlock =
        '<div class="studio-gate-paper">' +
          '<h4>Backtest (info only)</h4>' +
          '<p>Max chain ' + esc(maxChain || 0) +
            ' · Wins ' + esc(totalWins != null ? totalWins : 0) +
            ' · 5-loss chains ' + esc(wipeChains || 0) + '</p>' +
          '<p class="studio-gate-paper-note">Does not count toward Feed publish.</p>' +
        '</div>';
    }
    return (
      '<p class="studio-gate-live-note">Publish uses the live desk tape only. Backtest never counts. Hold a line if you want it in plain words.</p>' +
      '<ul class="studio-gate-list">' +
        rows.map(function (r) {
          return '<li class="' + (r[0] ? 'is-ok' : 'is-no') + '">' + esc(r[1]) + '</li>';
        }).join('') +
      '</ul>' +
      paperBlock
    );
  }

  async function publish(bot) {
    if (!entitledPaid()) {
      toast('Paid subscription required to publish.', 'error');
      return;
    }
    const studio = window.__utkBotStudio;
    if (!bot && studio) bot = studio.selected && studio.selected();
    if (!bot) return;
    const api = hub() && hub().api;
    if (!api) {
      toast('Server offline.', 'error');
      return;
    }
    try {
      const data = await api('POST', '/studio/publish', { bot: bot });
      if (data.bot && studio && studio.saveBot) await studio.saveBot(data.bot);
      toast('Published to Feed.', 'success');
      refreshList();
      if (studio && studio.refresh) studio.refresh();
    } catch (err) {
      const msg = (err && err.body && err.body.message) || (err && err.message) || 'Publish failed.';
      toast(String(msg).replace(/_/g, ' '), 'error');
    }
  }

  async function unpublish(bot) {
    const studio = window.__utkBotStudio;
    if (!bot && studio) bot = studio.selected && studio.selected();
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
    bot.published = false;
    if (studio && studio.saveBot) await studio.saveBot(bot);
    toast('Removed from Community.', 'info');
    refreshList();
    if (studio && studio.refresh) studio.refresh();
  }

  function bind() {
    document.addEventListener('click', function (ev) {
      if (ev && ev.__utkStudioHandled) return;
      const t = ev.target;
      if (!t) return;
      if (t.id === 'studioGlobalRefresh') {
        ev.preventDefault();
        try { ev.__utkStudioHandled = true; } catch (e) {}
        refreshList();
        return;
      }
      if (t.id === 'studioGlobalBackList' || t.id === 'feedBackBtn') {
        ev.preventDefault();
        try { ev.__utkStudioHandled = true; } catch (e) {}
        backToList();
        return;
      }
      const card = t.closest && t.closest('.studio-global-card-btn');
      if (card) {
        ev.preventDefault();
        try { ev.__utkStudioHandled = true; } catch (e) {}
        openBot(card.getAttribute('data-global-id'));
      }
    });
  }

  function init() {
    document.querySelectorAll('.studio-global-stats-wrap').forEach(function (n) {
      try { n.remove(); } catch (e) {}
    });
    ['studioGlobalPicker', 'studioGlobalStrip', 'section-studio-global'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) try { el.remove(); } catch (e) {}
    });
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__utkStudioGlobal = {
    refresh: refreshList,
    publish: publish,
    unpublish: unpublish,
    open: openBot,
    backToList: backToList,
    mountStudio: mountStudio,
    gateHtml: gateHtml,
    entitledPaid: entitledPaid,
    isDeskOpen: function () { return !!openGlobalId; },
    getOpenId: function () { return openGlobalId; }
  };
})();
