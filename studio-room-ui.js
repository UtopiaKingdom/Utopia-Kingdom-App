/**
 * studio-room-ui.js — Plain-language Studio chrome (tabs, path, empty, actions).
 * Load BEFORE bot-studio.js.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cmd(action, arg) {
    const fn = window.__utkStudioCmdAttr;
    if (typeof fn === 'function') return fn(action, arg);
    let html = ' data-cmd="' + esc(action) + '"';
    if (arg != null && arg !== '') html += ' data-arg="' + esc(String(arg)) + '"';
    return html;
  }

  function statusOf(bot) {
    const v = String((bot && bot.status) || '').toLowerCase();
    if (v === 'live' || v === 'armed') return 'live';
    if (v === 'paused') return 'paused';
    if (v === 'checking') return 'checking';
    return 'idle';
  }

  function statusChipHtml(bot, liveMeta) {
    const st = statusOf(bot);
    const labels = { live: 'Live', paused: 'Paused', checking: 'Testing', idle: 'Ready' };
    const cls = st === 'live' ? ' is-live' : (st === 'checking' ? ' is-checking' : '');
    const health = window.__utkStudioLiveStatus;
    const pill = (st === 'live' && health && typeof health.healthChipHtml === 'function')
      ? health.healthChipHtml(liveMeta || (bot && bot.liveMeta))
      : '';
    return '<span class="studio-status-chip' + cls + '" id="studioStatusChip">' + esc(labels[st] || 'Ready') + '</span>' +
      '<span id="studioHealthChip">' + pill + '</span>';
  }

  function paintHealthChip(bot, liveMeta) {
    const chip = document.getElementById('studioStatusChip');
    const healthMount = document.getElementById('studioHealthChip');
    if (!chip || !healthMount) return;
    const st = statusOf(bot);
    const labels = { live: 'Live', paused: 'Paused', checking: 'Testing', idle: 'Ready' };
    const cls = st === 'live' ? ' is-live' : (st === 'checking' ? ' is-checking' : '');
    chip.className = 'studio-status-chip' + cls;
    chip.textContent = labels[st] || 'Ready';
    const health = window.__utkStudioLiveStatus;
    healthMount.innerHTML = (st === 'live' && health && typeof health.healthChipHtml === 'function')
      ? health.healthChipHtml(liveMeta || (bot && bot.liveMeta))
      : '';
  }

  function tabsHtml(activeTab) {
    const feedOn = activeTab === 'global' ? ' is-on' : '';
    const yoursOn = activeTab === 'yours' || activeTab === 'cook' || activeTab === 'desk' ? ' is-on' : '';
    return (
      '<div class="studio-tabs studio-tabs-plain" role="tablist">' +
        '<button type="button" class="studio-tab' + feedOn + '" data-studio-tab="global" role="tab">Community</button>' +
        '<button type="button" class="studio-tab' + yoursOn + '" data-studio-tab="yours" role="tab">My bot</button>' +
      '</div>'
    );
  }

  function needBotHtml() {
    return (
      '<div class="studio-empty studio-stage studio-room-empty">' +
        '<p class="studio-stage-kicker">Studio</p>' +
        '<h2>Build your own bot</h2>' +
        '<p class="studio-note">Pick a style, try it on real past prices, then go live when it feels right.</p>' +
        '<ol class="studio-room-list">' +
          '<li><b>Create</b>Choose a style, chart rules, filters, and your save ladder.</li>' +
          '<li><b>Test</b>Replay real OTC candles. Nothing is traded for real.</li>' +
          '<li><b>Go live</b>Your bot watches live prices around the clock.</li>' +
        '</ol>' +
        '<div class="studio-empty-actions">' +
          '<button type="button" class="studio-primary" id="studioEmptyNew">Make a bot</button>' +
          '<button type="button" class="studio-ghost" id="studioEmptyGlobal">Community</button>' +
        '</div>' +
      '</div>'
    );
  }

  function globalPaneHtml() {
    return (
      '<div class="studio-global-pane studio-stage" id="studioGlobalPane">' +
        '<div class="studio-global-pane-head">' +
          '<div class="studio-section-head-text">' +
            '<h2>Live tapes</h2>' +
            '<p class="studio-note">Follow live CALL and PUT ideas from other traders. Their recipes stay private.</p>' +
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

  function pathHtml(bot) {
    const st = statusOf(bot);
    if (st === 'live') return '';
    const checked = !!(window.__utkBotStudio && typeof window.__utkBotStudio.hasBacktest === 'function'
      ? window.__utkBotStudio.hasBacktest(bot)
      : (bot && bot.lastCheck && bot.lastCheck.ok));
    const paused = st === 'paused';
    return (
      '<ol class="studio-path studio-path-plain" aria-label="Steps">' +
        '<li class="' + (checked ? 'is-done' : 'is-now') + '">' +
          '<b>Test</b>' +
          '<span>Replay real OTC prices. Required before go live.</span>' +
        '</li>' +
        '<li class="' + (paused ? 'is-done' : (checked ? 'is-now' : '')) + '">' +
          '<b>Go live</b>' +
          '<span>Locked until your candle test finishes.</span>' +
        '</li>' +
        '<li>' +
          '<b>Share tape</b>' +
          '<span>Optional. Needs a live streak.</span>' +
        '</li>' +
      '</ol>'
    );
  }

  function actionHtml(bot, busy) {
    const st = statusOf(bot);
    const live = st === 'live';
    const studio = window.__utkBotStudio;
    const atLiveLimit = !live && studio && typeof studio.isAtLiveLimit === 'function' && studio.isAtLiveLimit(bot.id);
    const tested = !!(studio && typeof studio.hasBacktest === 'function'
      ? studio.hasBacktest(bot)
      : (bot && bot.lastCheck && (bot.lastCheck.ok || Number(bot.lastCheck.wr1N || bot.lastCheck.trades) > 0)));
    const checkLabel = busy ? 'Testing' : 'Test';
    const liveBlocked = busy || atLiveLimit || (!live && !tested);
    const liveLabel = live ? 'Live' : (atLiveLimit ? '3 live max' : (!tested ? 'Test first' : 'Go live'));
    const liveTitle = atLiveLimit
      ? 'Pause a live bot first. Max 3 at once.'
      : (!tested ? 'Run a candle test before going live.' : '');
    return (
      '<div class="studio-actions studio-actions-plain">' +
        '<div class="studio-actions-main">' +
          '<button type="button" class="studio-ghost" id="studioCheck"' + cmd('check') + (busy ? ' disabled' : '') + '>' + checkLabel + '</button>' +
          '<button type="button" class="studio-primary" id="studioGoLive"' + cmd('goLive') + (liveBlocked ? ' disabled' : '') +
            (liveTitle ? ' title="' + esc(liveTitle) + '"' : '') + '>' + liveLabel + '</button>' +
        '</div>' +
        '<div class="studio-actions-more">' +
          (live
            ? '<button type="button" class="studio-ghost" id="studioPause"' + cmd('pause') + '>Pause</button>'
            : '') +
          (bot.published
            ? '<button type="button" class="studio-ghost" id="studioUnpublish"' + cmd('unpublish') + '>Stop sharing</button>'
            : '<button type="button" class="studio-ghost" id="studioPublish"' + cmd('publish') + '>Share tape</button>') +
          '<button type="button" class="studio-ghost" id="studioDuplicate"' + cmd('duplicate') + '>Duplicate</button>' +
          '<button type="button" class="studio-ghost is-danger" id="studioDelete"' + cmd('delete') + '>Delete</button>' +
        '</div>' +
      '</div>'
    );
  }

  function emptyDeskHtml(bot, busy) {
    return (
      '<div class="studio-desk-empty studio-room-empty" id="studioDeskRoot">' +
        '<p class="studio-stage-kicker">Desk</p>' +
        '<h2>' + esc(bot && bot.name ? bot.name : 'Your bot') + '</h2>' +
        '<p>Run a quick test on real OTC candles. Nothing hits Pocket Option.</p>' +
        '<button type="button" class="studio-primary" id="studioDeskCheck"' + cmd('check') + (busy ? ' disabled' : '') + '>' +
          (busy ? 'Testing' : 'Start test') +
        '</button>' +
      '</div>'
    );
  }

  window.__utkStudioRoom = {
    tabsHtml: tabsHtml,
    needBotHtml: needBotHtml,
    globalPaneHtml: globalPaneHtml,
    pathHtml: pathHtml,
    actionHtml: actionHtml,
    emptyDeskHtml: emptyDeskHtml,
    statusChipHtml: statusChipHtml,
    paintHealthChip: paintHealthChip
  };
})();
