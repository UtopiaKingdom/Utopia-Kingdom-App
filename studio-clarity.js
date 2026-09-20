/**
 * studio-clarity.js — Plain-English Studio helpers (pace, strictness, abandon hints).
 * Load BEFORE studio-live-status.js / studio-feed-desk.js.
 */
(function () {
  'use strict';

  const abandonByBot = Object.create(null);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function rulesOf(bot) {
    return (bot && bot.rules && typeof bot.rules === 'object') ? bot.rules : {};
  }

  function isStrictRecipe(bot) {
    const r = rulesOf(bot);
    const z = Number(r.zScore || 0);
    const vol = Number(r.volRankMin || 0);
    const combined = String((bot && bot.watchMode) || '').toLowerCase() === 'combined';
    const subMin = ['5s', '15s', '30s'].indexOf(String((bot && bot.timeframe) || '').toLowerCase()) >= 0;
    return z >= 2 || vol >= 40 || (combined && (z >= 1.5 || vol >= 30 || subMin));
  }

  function strictReasons(bot) {
    const r = rulesOf(bot);
    const bits = [];
    if (Number(r.zScore || 0) >= 2) bits.push('high stretch filter');
    if (Number(r.volRankMin || 0) >= 40) bits.push('high volume filter');
    if (String((bot && bot.watchMode) || '').toLowerCase() === 'combined') bits.push('two charts must agree');
    const tf = String((bot && bot.timeframe) || '').toLowerCase();
    if (tf === '30s' || tf === '15s' || tf === '5s') bits.push(tf + ' chart');
    return bits;
  }

  /** Honest pace copy from a backtest scorecard. */
  function paceCopy(card) {
    card = card || {};
    const live = String(card.liveGapLabel || '').trim();
    const avg = String(card.avgGapLabel || '').trim();
    if (!live && !avg) {
      return {
        title: '—',
        detail: 'Run a candle test to estimate pace',
        toast: 'typical wait unknown until you test'
      };
    }
    if (live && avg && live !== avg) {
      return {
        title: '~' + live,
        detail: 'Past packed average. Live is often closer to ' + avg + '.',
        toast: 'past average about ' + live + ' (live often slower, around ' + avg + ')'
      };
    }
    return {
      title: live ? ('~' + live) : ('~' + avg),
      detail: live
        ? 'Past average between packed signals. Live quiet stretches can run longer.'
        : ('Rough spacing about ' + avg + '.'),
      toast: 'typical wait about ' + (live || avg)
    };
  }

  function notePrepareDrop(botId, pair) {
    if (!botId) return;
    abandonByBot[botId] = {
      at: Date.now(),
      pair: String(pair || '').trim()
    };
  }

  function abandonHint(botId) {
    const row = abandonByBot[botId];
    if (!row) return '';
    if (Date.now() - row.at > 90000) {
      delete abandonByBot[botId];
      return '';
    }
    return row.pair
      ? ('Setup faded on ' + row.pair + ' — hunting again.')
      : 'Setup faded on the next candle — hunting again.';
  }

  function goLiveBulletsHtml(bot) {
    const strict = isStrictRecipe(bot);
    const reasons = strictReasons(bot);
    const tries = Math.max(1, Math.min(5, Math.round(Number((bot && bot.maxAttempts) || 5)) || 5));
    const lines = [
      '<li><strong>Runs 24/7 on our server</strong> even if you close this app. Pause anytime to stop.</li>',
      '<li><strong>Same pair up to ' + tries + ' tries</strong> on a loss streak, then a wipe if all lose.</li>',
      '<li><strong>Requires a finished candle test</strong> on this bot first.</li>',
      '<li>You are responsible for pausing or deleting when you are done.</li>'
    ];
    if (strict) {
      lines.unshift(
        '<li class="is-warn"><strong>Strict recipe</strong> — ' +
          esc(reasons.join(', ') || 'tight filters') +
          '. Expect longer quiet stretches between live signals than the backtest headline.</li>'
      );
    }
    return '<ul class="studio-options-bullets studio-golive-bullets">' + lines.join('') + '</ul>';
  }

  function checklistHtml(bot, liveMeta, opts) {
    opts = opts || {};
    const st = String((bot && bot.status) || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    if (!live) return '';
    liveMeta = liveMeta || {};
    const synced = liveMeta.synced !== false && live;
    const runnerOk = !!liveMeta.runnerOk;
    const scanOk = !!liveMeta.botScanOk;
    let atOn = false;
    try {
      const map = JSON.parse(localStorage.getItem('utk-studio-at-on') || '{}');
      atOn = !!(bot && bot.id && map[bot.id]);
    } catch (e) {}
    if (typeof opts.autotradeOn === 'boolean') atOn = opts.autotradeOn;
    function chip(ok, label) {
      return (
        '<span class="studio-clarity-chip' + (ok ? ' is-ok' : ' is-off') + '">' +
          '<span aria-hidden="true">' + (ok ? '✓' : '·') + '</span> ' + esc(label) +
        '</span>'
      );
    }
    return (
      '<div class="studio-clarity-check" role="status">' +
        chip(synced, 'Live on server') +
        chip(runnerOk, 'Runner') +
        chip(scanOk, 'Scanning') +
        chip(atOn, atOn ? 'Autotrade on' : 'Autotrade off') +
      '</div>'
    );
  }

  window.__utkStudioClarity = {
    isStrictRecipe: isStrictRecipe,
    strictReasons: strictReasons,
    paceCopy: paceCopy,
    notePrepareDrop: notePrepareDrop,
    abandonHint: abandonHint,
    goLiveBulletsHtml: goLiveBulletsHtml,
    checklistHtml: checklistHtml,
    esc: esc
  };
})();
