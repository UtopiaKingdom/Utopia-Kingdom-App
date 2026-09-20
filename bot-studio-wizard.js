/**
 * bot-studio-wizard.js — minimal Cook wizard HTML.
 */
(function () {
  'use strict';

  var STEPS = [
    { title: 'Pick a style', hint: 'Each card shows what the bot looks for. Tap to select — hold any card for more detail.' },
    { title: 'Which chart?', hint: 'Candle size the bot watches. Combined means two charts must agree.' },
    { title: 'Extra filters', hint: 'Grouped by type. Items marked From style came with your pick — toggle freely. Hold any row for help.' },
    { title: 'Fine-tune', hint: 'Only numbers for filters that are on. Defaults are solid — change them if you know what you want.' },
    { title: 'How it bets', hint: 'How long each trade lasts, which pairs, payout floor, and the loss ladder.' },
    { title: 'Ready to test', hint: 'Next we replay last week of real prices. Going live is a later tap.' }
  ];

  var EXPIRY_OPTS = ['30s', '1m', '2m', '3m', '5m'];
  var PAYOUT_OPTS = [85, 88, 92];
  var MG_PRESETS = {
    standard: '1-2-4-10-20',
    compact: '1-2-4-8-16'
  };

  var OTC_PAIRS = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD',
    'EURGBP', 'EURJPY', 'GBPJPY', 'AUDCAD', 'AUDNZD', 'AUDCHF', 'CADCHF',
    'CADJPY', 'CHFJPY', 'EURNZD', 'EURCHF', 'NZDJPY', 'USDCNH'
  ];

  function parts() { return window.__utkBotStudioParts || null; }

  function esc(s) {
    var p = parts();
    if (p && p.esc) return p.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function cmd(action, arg) {
    var fn = window.__utkStudioCmdAttr;
    if (typeof fn === 'function') return fn(action, arg);
    var html = ' data-cmd="' + esc(action) + '"';
    if (arg != null && arg !== '') html += ' data-arg="' + esc(String(arg)) + '"';
    return html;
  }

  function mgKey(steps, ladderMode) {
    var mode = String(ladderMode || '').toLowerCase();
    if (mode === 'custom' || mode === 'compact' || mode === 'standard') return mode;
    if (!Array.isArray(steps) || steps.length !== 5) return 'standard';
    var a = steps.join(',');
    if (a === '1,2,4,10,20') return 'standard';
    if (a === '1,2,4,8,16') return 'compact';
    return 'custom';
  }

  function renderHeader(step, bot, meta) {
    var pct = Math.round(((step + 1) / STEPS.length) * 100);
    var nameHtml = '';
    try {
      if (window.__utkStudioName && typeof window.__utkStudioName.html === 'function') {
        nameHtml = window.__utkStudioName.html(bot);
      }
    } catch (e) {}
    if (!nameHtml) {
      nameHtml = '<span class="cook-bot-tag">' + esc(bot.name || 'My bot') + '</span>';
    }
    return (
      '<header class="cook-head">' +
        '<div class="cook-head-row">' +
        '<span class="cook-step-label">' + (step + 1) + ' of ' + STEPS.length + '</span>' +
          nameHtml +
          '<button type="button" class="cook-btn cook-btn-ghost cook-cancel-x" aria-label="Cancel setup" title="Cancel"' +
            cmd('wizardCancel') + '>Cancel</button>' +
        '</div>' +
        '<div class="cook-bar"><div class="cook-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<h2 class="cook-title">' + esc(meta.title) + '</h2>' +
        '<p class="cook-hint">' + esc(meta.hint) + '</p>' +
      '</header>'
    );
  }

  function tip(title, body, when) {
    var fn = window.__utkStudioTipAttr;
    if (typeof fn === 'function') return fn(title, body, when);
    return '';
  }

  function renderTradeRules(bot) {
    bot = bot || {};
    var expiry = bot.expiry || '1m';
    var payout = Math.max(90, Math.min(92, Math.round(Number(bot.payoutMin) || 92)));
    var otcMode = bot.otcMode === 'pick' ? 'pick' : 'all';
    var pairs = Array.isArray(bot.otcPairs) ? bot.otcPairs : [];
    var mg = Array.isArray(bot.martingale) && bot.martingale.length === 5
      ? bot.martingale : [1, 2, 4, 10, 20];
    var mgSel = mgKey(mg, bot.ladderMode);
    var maxA = Math.max(1, Math.min(5, Math.round(Number(bot.maxAttempts) || 5)));
    var stepNames = ['Entry', 'S1', 'S2', 'S3', 'S4'];
    var retryLabels = { 1: 'Entry only', 2: 'Up to 2', 3: 'Up to 3', 4: 'Up to 4', 5: 'Full 5-step' };

    function chip(label, action, arg, on) {
      return '<button type="button" class="cook-chip' + (on ? ' is-on' : '') + '"' + cmd(action, arg) + '>' + esc(label) + '</button>';
    }

    var expiryHtml = EXPIRY_OPTS.map(function (id) {
      return chip(id, 'pickExpiry', id, expiry === id);
    }).join('');

    var payHtml = PAYOUT_OPTS.map(function (p) {
      return chip(p + '%', 'pickPayout', String(p), payout === p);
    }).join('');

    var mgHtml = Object.keys(MG_PRESETS).map(function (k) {
      return chip(MG_PRESETS[k], 'pickMartingale', k, mgSel === k);
    }).join('') + chip('Custom', 'pickMartingale', 'custom', mgSel === 'custom');

    var retryHtml = [1, 2, 3, 4, 5].map(function (n) {
      return chip(retryLabels[n], 'pickMaxAttempts', String(n), maxA === n);
    }).join('');

    var pairHtml = OTC_PAIRS.map(function (pair) {
      return chip(pair, 'toggleOtcPair', pair, pairs.indexOf(pair) >= 0);
    }).join('');

    var mgInputs = mg.map(function (n, i) {
      return (
        '<div class="ladder-cell">' +
          '<div class="ladder-cell-label">' + esc(stepNames[i]) + '</div>' +
          '<div class="ladder-cell-input">' +
            '<input type="number" min="1" max="500" id="studioMg' + i + '" data-studio-mg-step="' + i + '" value="' + esc(n) + '" aria-label="' + esc(stepNames[i]) + '" />' +
            '<span class="ladder-cell-x">x</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<div class="studio-trade-grid">' +
        '<input type="hidden" id="studioExpiry" value="' + esc(expiry) + '" />' +
        '<input type="hidden" id="studioPayoutMin" value="' + esc(payout) + '" />' +
        '<input type="hidden" id="studioOtcMode" value="' + esc(otcMode) + '" />' +
        '<input type="hidden" id="studioOtcPairsJson" value="' + esc(JSON.stringify(pairs)) + '" />' +
        '<input type="hidden" id="studioMartingaleJson" value="' + esc(JSON.stringify(mg)) + '" />' +
        '<input type="hidden" id="studioMaxAttempts" value="' + esc(maxA) + '" />' +
        '<input type="hidden" id="studioMgPreset" value="' + esc(mgSel) + '" />' +
        '<div class="cook-field"' + tip('Expiry', 'How long the trade stays open after entry. 1 minute is the usual. Shorter is faster. Longer waits more.') + '><span class="cook-label">Expiry</span><div class="cook-chips">' + expiryHtml + '</div></div>' +
        '<div class="cook-field"' + tip('OTC pairs', 'All OTC watches every pair except indices. Pick pairs if you only want a short list.') + '><span class="cook-label">OTC</span><div class="cook-chips">' +
          chip('All OTC', 'pickOtcMode', 'all', otcMode === 'all') +
          chip('Pick pairs', 'pickOtcMode', 'pick', otcMode === 'pick') +
        '</div><div class="cook-pairs"' + (otcMode === 'pick' ? '' : ' hidden') + '>' + pairHtml + '</div></div>' +
        '<div class="cook-field"' + tip('Min payout', 'Skip a pair if the live payout is below this. 92% is the usual floor.') + '><span class="cook-label">Min payout</span><div class="cook-chips">' + payHtml + '</div></div>' +
        '<div class="cook-field"' + tip('Retries after a loss', 'How many times the bot can re-enter on the same setup. Entry only = one shot. Full 5-step = martingale until win or wipe.', 'You want recovery after a miss, or a flat one-and-done.') + '><span class="cook-label">Retries</span><div class="cook-chips cook-retries-chips">' + retryHtml + '</div></div>' +
        '<div class="cook-field"' + tip('Ladder', 'Stake multipliers for each try. Only the first ' + maxA + ' step(s) are used with your retry setting.', 'You want recovery after a miss, not a flat bet.') + '><span class="cook-label">Ladder</span><div class="cook-chips">' + mgHtml + '</div>' +
        '<div class="ladder-grid' + (mgSel === 'custom' ? ' is-open' : '') + '"' +
          (mgSel === 'custom' ? '' : ' hidden') + ' id="studioMgCustom">' + mgInputs + '</div></div>' +
      '</div>'
    );
  }

  function renderReview(bot, p) {
    return (
      '<div class="cook-review-top">' +
        '<button type="button" class="cook-btn cook-btn-ghost"' + cmd('wizardRestart') + '>Run setup again</button>' +
      '</div>' +
      p.renderFormTop(bot, true) +
      '<div id="studioAiMount"></div>' +
      p.renderName(bot) +
      '<section class="cook-review-section"><div class="cook-review-head"><span>Strategy</span><button type="button" class="cook-edit"' + cmd('wizardEdit', '0') + '>Edit</button></div>' + p.renderStrategy(bot) + '</section>' +
      '<section class="cook-review-section"><div class="cook-review-head"><span>Chart</span><button type="button" class="cook-edit"' + cmd('wizardEdit', '1') + '>Edit</button></div>' + p.renderChart(bot) + '</section>' +
      '<section class="cook-review-section"><div class="cook-review-head"><span>Filters</span><button type="button" class="cook-edit"' + cmd('wizardEdit', '2') + '>Edit</button></div>' + p.renderFilters(bot.rules || {}) + '</section>' +
      '<section class="cook-review-section"><div class="cook-review-head"><span>Numbers</span><button type="button" class="cook-edit"' + cmd('wizardEdit', '3') + '>Edit</button></div>' + p.renderNumbers(bot.rules || {}) + '</section>' +
      '<section class="cook-review-section"><div class="cook-review-head"><span>Trade rules</span><button type="button" class="cook-edit"' + cmd('wizardEdit', '4') + '>Edit</button></div>' + renderTradeRules(bot) + '</section>' +
      p.renderSummary(bot)
    );
  }

  function renderBody(bot, step, p) {
    if (step === 5) return renderReview(bot, p);
    var r = bot.rules || {};
    if (step === 0) return p.renderStrategy(bot);
    if (step === 1) return p.renderChart(bot);
    if (step === 2) return p.renderFilters(r);
    if (step === 3) return p.renderNumbers(r);
    if (step === 4) return renderTradeRules(bot);
    return '';
  }

  function renderNav(step) {
    if (step >= 5) return '';
    var label = step === 4 ? 'Open my desk' : 'Continue';
    return (
      '<footer class="cook-foot">' +
        '<div class="cook-foot-left">' +
          '<button type="button" class="cook-btn cook-btn-ghost"' + cmd('wizardCancel') + '>Cancel</button>' +
          (step > 0 ? '<button type="button" class="cook-btn cook-btn-ghost"' + cmd('wizardBack') + '>Back</button>' : '') +
          '<button type="button" class="cook-btn cook-btn-ghost"' + cmd('wizardRestart') + '>Start over</button>' +
        '</div>' +
        '<button type="button" class="cook-btn cook-btn-primary" id="studioWizardNext"' + cmd('wizardNext') + '>' + esc(label) + '</button>' +
      '</footer>'
    );
  }

  function render(bot, step) {
    var p = parts();
    if (!p) return '<form id="studioForm" class="studio-form"><p class="studio-note">Loading…</p></form>';
    step = Math.max(0, Math.min(5, step || 0));
    var meta = STEPS[step] || STEPS[0];
    var body = renderBody(bot, step, p);

    if (step >= 5) {
      return '<form id="studioForm" class="studio-form cook-review" onsubmit="return false">' + body + '</form>';
    }

    return (
      '<div class="cook-flow">' +
        renderHeader(step, bot, meta) +
        '<form id="studioForm" class="studio-form cook-flow-main" onsubmit="return false">' +
          '<div class="cook-body">' + body + '</div>' +
          renderNav(step) +
        '</form>' +
      '</div>'
    );
  }

  window.__utkStudioWizard = { render: render, renderTradeRules: renderTradeRules, STEPS: STEPS };
})();
