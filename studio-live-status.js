/**
 * studio-live-status.js — Live pipeline health (runner + bot scan proof).
 * Load BEFORE studio-feed-desk.js.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function safeMs(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function formatAgo(ms) {
    const at = safeMs(ms);
    if (!at) return 'not yet';
    const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (sec < 8) return 'just now';
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return Math.floor(sec / 3600) + 'h ago';
  }

  function checkRow(ok, label, detail) {
    return (
      '<li class="studio-health-row' + (ok ? ' is-ok' : ' is-bad') + '">' +
        '<span class="studio-health-mark" aria-hidden="true">' + (ok ? '✓' : '!') + '</span>' +
        '<span><strong>' + esc(label) + '</strong>' +
          (detail ? '<em>' + esc(detail) + '</em>' : '') +
        '</span>' +
      '</li>'
    );
  }

  function pendingBannerHtml() {
    return (
      '<div class="studio-live-scan studio-live-health is-warn" role="status">' +
        '<div class="studio-live-health-head">' +
          '<strong>Checking live status</strong>' +
        '</div>' +
        '<p class="studio-health-pending">Hang tight, pulling runner info from the server.</p>' +
      '</div>'
    );
  }

  function compactChip(ok, label) {
    return (
      '<span class="studio-health-chip' + (ok ? ' is-ok' : ' is-bad') + '" title="' + esc(label) + '">' +
        '<span class="studio-health-chip-mark" aria-hidden="true">' + (ok ? '✓' : '!') + '</span>' +
        esc(label) +
      '</span>'
    );
  }

  /** Compact strip under signal — collapsible for details. */
  function scanBannerCompactHtml(bot, liveMeta) {
    const st = String((bot && bot.status) || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    if (!live) return '';
    if (!liveMeta || typeof liveMeta.overallOk !== 'boolean') {
      return (
        '<div class="studio-live-health-compact is-warn" role="status">' +
          '<span class="studio-health-pill is-warn">Checking</span>' +
          '<span class="studio-health-compact-note">Pulling live status</span>' +
        '</div>'
      );
    }
    const synced = !!liveMeta.synced;
    const runnerOk = !!liveMeta.runnerOk;
    const botScanOk = !!liveMeta.botScanOk;
    const overallOk = liveMeta.overallOk === true;
    const lastTrade = safeMs(liveMeta.lastTradeAt);
    const runnerAt = safeMs(liveMeta.runnerAt);
    const botAt = safeMs(liveMeta.botScannedAt);
    const pairs = Math.max(0, Math.round(Number(liveMeta.pairsChecked) || 0));
    const cls = overallOk ? ' is-ok' : (synced ? ' is-warn' : ' is-bad');
    const pillCls = overallOk ? ' is-ok' : (synced ? ' is-warn' : ' is-bad');
    const pill = overallOk ? 'All good' : (synced ? 'Warming up' : 'Starting');
    const chips =
      compactChip(synced, 'Saved') +
      compactChip(runnerOk, 'Runner') +
      compactChip(botScanOk, 'Scanning') +
      compactChip(true, 'Watching');
    const rows = [
      checkRow(synced, 'Saved and live', synced
        ? 'Your bot is on our server and marked live.'
        : 'Sign in and tap Go live again.'),
      checkRow(runnerOk, 'Always on runner', runnerOk
        ? ('Last ping ' + formatAgo(runnerAt) + '.')
        : (runnerAt
          ? ('Last ping ' + formatAgo(runnerAt) + '. Waking back up.')
          : 'Give it a minute right after you go live.')),
      checkRow(botScanOk, 'Scanning your bot', botScanOk
        ? ('Last look ' + formatAgo(botAt) + (pairs > 0 ? (', ' + pairs + ' pairs checked.') : '.'))
        : (botAt
          ? ('Last look ' + formatAgo(botAt) + '. Next pass coming soon.')
          : 'First scan happens right after go live.')),
          checkRow(true, 'Watching for a setup', lastTrade
        ? ('Last trade ' + formatAgo(lastTrade) + '. Quiet stretches are normal — backtest averages are not a live timer.')
        : 'No trade yet. That is okay; filters only fire when the market matches.')
    ];
    return (
      '<details class="studio-live-health-compact' + cls + '" role="status"' + (overallOk ? '' : ' open') + '>' +
        '<summary class="studio-health-compact-summary">' +
          '<span class="studio-health-pill' + pillCls + '">' + esc(pill) + '</span>' +
          '<span class="studio-health-compact-chips">' + chips + '</span>' +
        '</summary>' +
        '<ul class="studio-health-list studio-health-list-compact">' + rows.join('') + '</ul>' +
      '</details>'
    );
  }

  function scanBannerHtml(bot, liveMeta) {
    const st = String((bot && bot.status) || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    if (!live) return '';
    if (!liveMeta || typeof liveMeta.overallOk !== 'boolean') {
      return pendingBannerHtml();
    }
    const synced = !!liveMeta.synced;
    const runnerOk = !!liveMeta.runnerOk;
    const botScanOk = !!liveMeta.botScanOk;
    const overallOk = liveMeta.overallOk === true;
    const lastTrade = safeMs(liveMeta.lastTradeAt);
    const runnerAt = safeMs(liveMeta.runnerAt);
    const botAt = safeMs(liveMeta.botScannedAt);
    const pairs = Math.max(0, Math.round(Number(liveMeta.pairsChecked) || 0));
    const cls = overallOk ? ' is-ok' : (synced ? ' is-warn' : ' is-bad');
    const head = overallOk
      ? 'Everything looks good'
      : (synced ? 'Almost ready' : 'Still starting up');
    const rows = [
      checkRow(synced, 'Saved and live', synced
        ? 'Your bot is on our server and marked live.'
        : 'Sign in and tap Go live again.'),
      checkRow(runnerOk, 'Always on runner', runnerOk
        ? ('Last ping ' + formatAgo(runnerAt) + '.')
        : (runnerAt
          ? ('Last ping ' + formatAgo(runnerAt) + '. Waking back up.')
          : 'Give it a minute right after you go live.')),
      checkRow(botScanOk, 'Scanning your bot', botScanOk
        ? ('Last look ' + formatAgo(botAt) + (pairs > 0 ? (', ' + pairs + ' pairs checked.') : '.'))
        : (botAt
          ? ('Last look ' + formatAgo(botAt) + '. Next pass coming soon.')
          : 'First scan happens right after go live.')),
      checkRow(true, 'Watching for a setup', lastTrade
        ? ('Last trade ' + formatAgo(lastTrade) + '. Quiet stretches are normal — backtest averages are not a live timer.')
        : 'No trade yet. That is okay; filters only fire when the market matches.')
    ];
    return (
      '<div class="studio-live-scan studio-live-health' + cls + '" role="status">' +
        '<div class="studio-live-health-head">' +
          '<strong>' + esc(head) + '</strong>' +
          (overallOk ? '<span class="studio-health-pill is-ok">All good</span>' : '') +
        '</div>' +
        '<ul class="studio-health-list">' + rows.join('') + '</ul>' +
      '</div>'
    );
  }

  function healthChipHtml(liveMeta) {
    if (!liveMeta || typeof liveMeta.overallOk !== 'boolean') return '';
    if (!liveMeta.synced && liveMeta.status !== 'live' && liveMeta.status !== 'armed') return '';
    if (liveMeta.overallOk === true) {
      return '<span class="studio-health-pill is-ok" title="Your bot is being scanned">All good</span>';
    }
    if (liveMeta.runnerOk) {
      return '<span class="studio-health-pill is-warn" title="Runner is up, waiting for your bot scan">Warming up</span>';
    }
    return '<span class="studio-health-pill is-bad" title="Runner not detected yet">Starting</span>';
  }

  function waitingLine(bot, liveMeta) {
    liveMeta = liveMeta || (bot && bot.liveMeta) || {};
    const pairs = Math.max(0, Math.round(Number(liveMeta.pairsChecked) || 0));
    const last = safeMs(liveMeta.lastTradeAt);
    const botAt = safeMs(liveMeta.botScannedAt);
    const clarity = window.__utkStudioClarity;
    const strict = clarity && typeof clarity.isStrictRecipe === 'function'
      ? clarity.isStrictRecipe(bot)
      : (bot && bot.rules && (
        Number(bot.rules.zScore || 0) >= 2 ||
        Number(bot.rules.volRankMin || 0) >= 40
      ));
    let line = 'Waiting for a setup…';
    if (pairs > 0 && liveMeta.botScanOk !== false) {
      line = 'Scanning ' + pairs + ' OTC pairs';
      if (botAt) line += ' · last look ' + formatAgo(botAt);
      if (strict) line += ' · strict filters, quiet stretches are normal';
      else line += ' · waiting for your setup';
    } else if (liveMeta.botScanOk === false) {
      line = 'Going live — first scan coming up';
    }
    if (last) line += ' · last trade ' + formatAgo(last);
    const abandon = clarity && typeof clarity.abandonHint === 'function' && bot && bot.id
      ? clarity.abandonHint(bot.id)
      : '';
    if (abandon) line += ' · ' + abandon;
    return line;
  }

  function waitingPanelHtml(bot, liveMeta) {
    // Kept for callers; signal block stays clean — full detail lives in Mind.
    return (
      '<p data-empty-text>Waiting for signals...</p>'
    );
  }

  /** Full “what is my bot thinking” panel for the Mind notebook. */
  function mindPanelHtml(bot, liveMeta) {
    liveMeta = liveMeta || {};
    const clarity = window.__utkStudioClarity;
    const line = waitingLine(bot, liveMeta);
    const pairs = Math.max(0, Math.round(Number(liveMeta.pairsChecked) || 0));
    const botAt = safeMs(liveMeta.botScannedAt);
    const abandon = clarity && bot && bot.id ? clarity.abandonHint(bot.id) : '';
    const card = (bot && bot.lastCheck) || {};
    const pace = clarity && typeof clarity.paceCopy === 'function' ? clarity.paceCopy(card) : null;
    const checklist = clarity && typeof clarity.checklistHtml === 'function'
      ? clarity.checklistHtml(bot, liveMeta)
      : '';
    const st = String((bot && bot.status) || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    if (!live) {
      return (
        '<div class="bot-mind-studio">' +
          '<p class="nyx-mind-said">This bot is not live yet. Run a candle test, then Go live.</p>' +
        '</div>'
      );
    }
    return (
      '<div class="bot-mind-studio">' +
        checklist +
        '<p class="studio-wait-title">Watching live prices</p>' +
        '<p class="studio-wait-detail">' + esc(line) + '</p>' +
        (abandon ? '<p class="studio-wait-abandon">' + esc(abandon) + '</p>' : '') +
        (pace && pace.detail
          ? '<p class="studio-wait-pace">Backtest pace ' + esc(pace.title) + '. ' + esc(pace.detail) + '</p>'
          : '') +
        (pairs > 0 && botAt
          ? ''
          : '<p class="studio-wait-pace">App can stay closed — the server keeps scanning.</p>') +
      '</div>'
    );
  }

  async function verify(bot) {
    const hub = window.__utkCommunityHub;
    const api = hub && hub.api;
    if (!api || !bot || !bot.id) {
      return { ok: false, message: 'Sign in to check that your bot is live.' };
    }
    try {
      const data = await api('GET', '/studio/health?id=' + encodeURIComponent(bot.id));
      const h = (data && data.health) || (data && data.liveMeta) || {};
      return {
        ok: h.overallOk === true,
        health: h,
        message: h.overallOk === true
          ? 'Looks good. Your bot was scanned recently.'
          : 'You are live but still warming up. Give it up to 2 minutes.'
      };
    } catch (e) {
      return { ok: false, message: 'Could not reach the server right now.' };
    }
  }

  window.__utkStudioLiveStatus = {
    scanBannerHtml: scanBannerHtml,
    scanBannerCompactHtml: scanBannerCompactHtml,
    healthChipHtml: healthChipHtml,
    waitingLine: waitingLine,
    waitingPanelHtml: waitingPanelHtml,
    mindPanelHtml: mindPanelHtml,
    formatAgo: formatAgo,
    verify: verify
  };
})();
