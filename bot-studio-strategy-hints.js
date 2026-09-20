/**
 * bot-studio-strategy-hints.js — Pick-time guidance (pairs, WR notes, charts).
 * Load AFTER bot-studio-strategies.js, BEFORE bot-studio.js.
 */
(function () {
  'use strict';

  var BY_STYLE = {
    'mean-revert': {
      badge: 'Solid baseline',
      wrNote: 'Usually strong WR in choppy OTC when stretch + RSI stay on.',
      combine: ['pinbar', 'rsi-extreme'],
      combineNote: 'Pin bar or RSI extreme adds timing without changing the fade idea.',
      chart: '1m is the usual. Try 15s when you want more tries in the same range.'
    },
    'fade': {
      badge: 'Spike hunter',
      wrNote: 'Best after sharp spikes — volume filter keeps dead pairs out.',
      combine: ['mean-revert', 'pinbar'],
      combineNote: 'Mean reversion shares the same DNA with a softer stretch default.',
      chart: '1m. Combined 5s + 1m can filter fake spikes.'
    },
    'bollinger': {
      badge: 'Range favorite',
      wrNote: 'Higher WR when bands are respected — quiet OTC ranges.',
      combine: ['rsi-extreme', 'range'],
      combineNote: 'RSI is already on. Range style uses the same box logic.',
      chart: '1m on calm pairs. 15s in tight ranges.'
    },
    'rsi-extreme': {
      badge: 'Clean & simple',
      wrNote: 'Light filters = more trades. WR depends on RSI bands you set.',
      combine: ['bollinger', 'mean-revert'],
      combineNote: 'Bollinger adds a stretch meter; mean reversion adds wick discipline.',
      chart: '1m or 15s — fast enough for oscillator turns.'
    },
    'bollinger-squeeze': {
      badge: 'Breakout setup',
      wrNote: 'Waits for a squeeze — fewer trades, sharper moves.',
      combine: ['squeeze', 'impulse'],
      combineNote: 'Impulse family chases the break after the coil.',
      chart: '5s or 15s into a 1m expiry.'
    },
    'squeeze': {
      badge: 'Volatility coil',
      wrNote: 'Needs expansion — dead markets give zero entries.',
      combine: ['bollinger', 'macd'],
      combineNote: 'Bollinger finds the coil; MACD confirms the push.',
      chart: '15s or 1m when ATR wakes up.'
    },
    'ema-cross': {
      badge: 'Trend rider',
      wrNote: 'WR climbs on directional days — avoid chop.',
      combine: ['pullback', 'trend-follow'],
      combineNote: 'Pullback waits for a dip into the trend.',
      chart: '1m trend. Combined 1m + 5m for cleaner direction.'
    },
    'pinbar': {
      badge: 'Wick timing',
      wrNote: 'WR improves when highs and lows are obvious.',
      combine: ['mean-revert', 'hammer'],
      combineNote: 'Same rejection idea — hammer is the mirror pattern.',
      chart: '1m swings. 15s for faster wick entries.'
    },
    'stoch': {
      badge: 'Range oscillator',
      wrNote: 'Works in boxes — weak in one-way runs.',
      combine: ['rsi-extreme', 'range'],
      combineNote: 'Double oscillator — only use in quiet sessions.',
      chart: '1m range days.'
    },
    'scalp': {
      badge: 'High frequency',
      wrNote: 'More tries on fast charts — watch wipe rate on Check.',
      combine: ['rsi-extreme'],
      combineNote: 'Keep RSI on to avoid random noise entries.',
      chart: '5s or 15s watch with 1m expiry.'
    },
    'custom': {
      badge: 'Your recipe',
      wrNote: 'WR depends entirely on what you toggle on.',
      combine: ['mean-revert'],
      combineNote: 'Mean reversion is a proven starting point if you are unsure.',
      chart: 'Match chart speed to expiry.'
    }
  };

  var FAMILY_HINTS = {
    Reversal: {
      badge: 'Fade family',
      wrNote: 'Reversal styles like choppy OTC — avoid strong one-way trends.',
      combine: ['mean-revert', 'bollinger'],
      combineNote: 'Mean reversion and Bollinger bounce share range DNA.',
      chart: '1m default. 15s for more entries in the same range.'
    },
    Trend: {
      badge: 'Trend family',
      wrNote: 'Needs direction — EMA and MACD filters help WR on trend days.',
      combine: ['ema-cross', 'pullback'],
      combineNote: 'Pullback enters after a dip into the trend.',
      chart: '1m or combined 5s + 1m for agreement.'
    },
    Range: {
      badge: 'Range family',
      wrNote: 'Best when price bounces the same floor and ceiling.',
      combine: ['bollinger', 'rsi-extreme'],
      combineNote: 'Oscillators + bands = classic range toolkit.',
      chart: '1m on quiet pairs.'
    },
    Momentum: {
      badge: 'Momentum family',
      wrNote: 'WR rises when volatility expands — skip dead tapes.',
      combine: ['squeeze', 'impulse'],
      combineNote: 'Squeeze finds the coil; impulse rides the break.',
      chart: '5s or 15s into 1m expiry.'
    },
    Candle: {
      badge: 'Candle family',
      wrNote: 'WR depends on clean wick candles at obvious levels.',
      combine: ['pinbar', 'mean-revert'],
      combineNote: 'Add mean reversion stretch so you are not fading mid-air.',
      chart: '1m swing highs and lows.'
    },
    Custom: {
      badge: 'Build your own',
      wrNote: 'Start from mean reversion if you want a proven base.',
      combine: ['mean-revert'],
      combineNote: 'Copy a family style, then tweak filters.',
      chart: '1m until Check says otherwise.'
    }
  };

  function strategies() {
    return window.__utkStudioStrategies || null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function hintFor(styleId) {
    const api = strategies();
    const meta = api && api.byId ? api.byId(styleId) : null;
    const custom = BY_STYLE[styleId];
    if (custom) return custom;
    if (meta) {
      return {
        badge: meta.family + ' style',
        wrNote: meta.useWhen || meta.blurb,
        combine: [],
        combineNote: meta.explain || '',
        chart: 'Start with 1m. Run Check, then adjust the chart if you want more or fewer trades.'
      };
    }
    const fam = meta && meta.family ? FAMILY_HINTS[meta.family] : null;
    return fam || FAMILY_HINTS.Reversal;
  }

  function combineLabels(ids) {
    const api = strategies();
    if (!api || !api.labelOf || !ids || !ids.length) return '';
    return ids.map(function (id) { return api.labelOf(id); }).join(' · ');
  }

  function html(styleId) {
    const h = hintFor(styleId);
    if (!h) return '';
    const combo = h.combine && h.combine.length
      ? '<p class="studio-strat-hint-line"><span>Pairs well with</span> ' + esc(combineLabels(h.combine)) + '. ' + esc(h.combineNote || '') + '</p>'
      : '';
    return (
      '<aside class="studio-strat-hint" id="studioStratHint" aria-live="polite">' +
        '<span class="studio-strat-hint-badge">' + esc(h.badge || 'Tip') + '</span>' +
        '<p class="studio-strat-hint-line"><span>Win rate</span> ' + esc(h.wrNote || '') + '</p>' +
        combo +
        '<p class="studio-strat-hint-line"><span>Charts</span> ' + esc(h.chart || '') + '</p>' +
      '</aside>'
    );
  }

  window.__utkStudioStrategyHints = {
    hintFor: hintFor,
    html: html,
    combineLabels: combineLabels
  };
})();
