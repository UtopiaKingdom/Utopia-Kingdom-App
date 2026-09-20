/**
 * studio-bot-hub.js — Bot list hub + immersive detail (back arrow). Load BEFORE bot-studio.js.
 */
(function () {
  'use strict';

  let botDetailOpen = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function studio() {
    return window.__utkBotStudio || null;
  }

  function syncChrome() {
    const page = document.getElementById('studioPage');
    const section = document.getElementById('section-studio');
    const open = botDetailOpen;
    if (page) {
      page.classList.toggle('is-bot-open', open);
      page.classList.toggle('is-hub-view', !open);
    }
    if (section) section.classList.toggle('is-bot-open', open);
  }

  function isOpen() {
    return botDetailOpen;
  }

  function openBot(id) {
    botDetailOpen = !!id;
    syncChrome();
  }

  function backToHub(opts) {
    opts = opts || {};
    botDetailOpen = false;
    syncChrome();
    try {
      if (window.__utkStudioDesk && typeof window.__utkStudioDesk.stop === 'function') {
        window.__utkStudioDesk.stop();
      }
    } catch (e) {}
    if (!opts.silent) {
      const s = studio();
      if (s && typeof s.refresh === 'function') s.refresh();
      else renderHub();
    }
  }

  function styleLabel(style) {
    const api = window.__utkStudioStrategies;
    if (api && typeof api.label === 'function') return api.label(style);
    return style || 'Custom';
  }

  function chartLabel(tf) {
    const map = { '5s': '5 sec', '15s': '15 sec', '1m': '1 minute', '2m': '2 minutes', '3m': '3 minutes', '5m': '5 minutes' };
    return map[tf] || tf || '1 minute';
  }

  function statusLabel(st) {
    const labels = { idle: 'Ready', checking: 'Testing', live: 'Live', paused: 'Paused', armed: 'Live' };
    return labels[st] || 'Ready';
  }

  function normalizeStatus(st) {
    const v = String(st || 'idle').toLowerCase();
    if (v === 'armed') return 'live';
    if (v === 'live' || v === 'paused' || v === 'checking') return v;
    return 'idle';
  }

  function hubCardHtml(b) {
    const st = normalizeStatus(b.status);
    const live = st === 'live';
    return (
      '<button type="button" class="studio-hub-card' + (live ? ' is-live' : '') + '" data-studio-bot="' + esc(b.id) + '">' +
        '<div class="studio-hub-card-head">' +
          '<span class="studio-hub-card-name">' + esc(b.name || 'Bot') + '</span>' +
          '<span class="studio-pill studio-pill-' + esc(st) + '">' +
            (live ? '<i class="studio-live-dot"></i>' : '') +
            esc(statusLabel(st)) +
          '</span>' +
        '</div>' +
        '<p class="studio-hub-card-meta">' +
          esc(styleLabel(b.style)) + ', ' + esc(chartLabel(b.timeframe)) +
        '</p>' +
      '</button>'
    );
  }

  function renderHub() {
    const mount = document.getElementById('studioHubMount');
    if (!mount) return;
    const s = studio();
    const bots = s && typeof s.bots === 'function' ? s.bots() : [];
    const liveN = s && typeof s.countLiveBots === 'function' ? s.countLiveBots() : 0;
    const maxLive = s && s.MAX_LIVE_BOTS ? s.MAX_LIVE_BOTS : 3;
    if (!bots.length) {
      mount.innerHTML =
        '<div class="studio-hub studio-hub-empty">' +
          '<p class="studio-stage-kicker">Studio</p>' +
          '<h2>Your bots</h2>' +
          '<p class="studio-note">Build a bot, test on past candles, go live when you like it.</p>' +
          '<button type="button" class="studio-primary" id="studioHubNew">Make a bot</button>' +
        '</div>';
      return;
    }
    mount.innerHTML =
      '<div class="studio-hub">' +
        '<div class="studio-hub-head">' +
          '<div class="studio-hub-head-text">' +
            '<h2>Your bots</h2>' +
            '<p class="studio-note">' + esc(liveN) + ' of ' + esc(maxLive) + ' live · make as many as you like</p>' +
          '</div>' +
          '<button type="button" class="studio-primary" id="studioHubNew">Make a bot</button>' +
        '</div>' +
        '<div class="studio-hub-grid" role="list">' +
          bots.map(hubCardHtml).join('') +
        '</div>' +
      '</div>';
  }

  function hubPaneHtml() {
    return '<div id="studioHubMount" class="studio-hub-mount studio-stage"></div>';
  }

  function afterPaint() {
    if (!botDetailOpen) renderHub();
    try {
      if (window.__utkStudioUxPolish && typeof window.__utkStudioUxPolish.sync === 'function') {
        window.__utkStudioUxPolish.sync();
      }
    } catch (e) {}
  }

  window.__utkStudioBotHub = {
    isOpen: isOpen,
    openBot: openBot,
    backToHub: backToHub,
    renderHub: renderHub,
    hubPaneHtml: hubPaneHtml,
    afterPaint: afterPaint
  };
})();
