/**
 * studio-check-window.js — Check lookback (1 week–1 month) and wait between signals.
 * Load BEFORE bot-studio.js.
 */
(function () {
  'use strict';

  const OPTS = [
    { id: '7d', label: '1 week', days: 7 },
    { id: '14d', label: '2 weeks', days: 14 },
    { id: '30d', label: '1 month', days: 30 }
  ];

  function normalize(raw) {
    const s = String(raw == null ? '7d' : raw).toLowerCase().trim();
    if (s === '14d' || s === '14' || s === '2w') return '14d';
    if (s === '30d' || s === '30' || s === '1mo' || s === 'month') return '30d';
    return '7d';
  }

  function daysOf(raw) {
    const id = normalize(raw);
    if (id === '14d') return 14;
    if (id === '30d') return 30;
    return 7;
  }

  function phrase(raw) {
    const id = normalize(raw);
    if (id === '14d') return '2 weeks';
    if (id === '30d') return '1 month';
    return '1 week';
  }

  const GAP_OPTS = [
    { id: '0', label: 'None', sec: 0 },
    { id: '30s', label: '30s', sec: 30 },
    { id: '1m', label: '1 min', sec: 60 },
    { id: '2m', label: '2 min', sec: 120 },
    { id: '5m', label: '5 min', sec: 300 },
    { id: '10m', label: '10 min', sec: 600 }
  ];

  function normalizeGap(raw) {
    const s = String(raw == null ? '1m' : raw).toLowerCase().trim();
    if (s === '0' || s === 'none' || s === 'off') return '0';
    if (s === '30s' || s === '30') return '30s';
    if (s === '2m' || s === '2' || s === '120') return '2m';
    if (s === '5m' || s === '5' || s === '300') return '5m';
    if (s === '10m' || s === '10' || s === '600') return '10m';
    return '1m';
  }

  function secondsOfGap(raw) {
    const id = normalizeGap(raw);
    for (let i = 0; i < GAP_OPTS.length; i++) {
      if (GAP_OPTS[i].id === id) return GAP_OPTS[i].sec;
    }
    return 60;
  }

  function phraseGap(raw) {
    const id = normalizeGap(raw);
    if (id === '0') return 'no wait';
    if (id === '30s') return '30 seconds';
    if (id === '2m') return '2 minutes';
    if (id === '5m') return '5 minutes';
    if (id === '10m') return '10 minutes';
    return '1 minute';
  }

  function html(bot, cmdAttr, busy) {
    const on = normalize(bot && bot.checkWindow);
    const gapOn = normalizeGap(bot && bot.signalGap);
    const cmd = typeof cmdAttr === 'function' ? cmdAttr : function () { return ''; };
    const dis = busy ? ' disabled' : '';
    return (
      '<div class="studio-check-window">' +
        '<div class="studio-check-window-row" role="group" aria-label="How far back to check">' +
          '<span class="studio-check-window-label">How far back</span>' +
          '<div class="studio-check-window-chips">' +
            OPTS.map(function (opt) {
              return (
                '<button type="button" class="studio-ghost studio-check-window-chip' +
                  (on === opt.id ? ' is-on' : '') + '"' +
                  cmd('pickCheckWindow', opt.id) + dis + '>' +
                  opt.label +
                '</button>'
              );
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="studio-check-window-row" role="group" aria-label="Wait between signals">' +
          '<span class="studio-check-window-label">Rest after</span>' +
          '<div class="studio-check-window-chips">' +
            GAP_OPTS.map(function (opt) {
              return (
                '<button type="button" class="studio-ghost studio-check-window-chip' +
                  (gapOn === opt.id ? ' is-on' : '') + '"' +
                  cmd('pickSignalGap', opt.id) + dis + '>' +
                  opt.label +
                '</button>'
              );
            }).join('') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  window.__utkStudioCheckWindow = {
    OPTS: OPTS,
    GAP_OPTS: GAP_OPTS,
    normalize: normalize,
    daysOf: daysOf,
    phrase: phrase,
    normalizeGap: normalizeGap,
    secondsOfGap: secondsOfGap,
    phraseGap: phraseGap,
    html: html
  };
})();
