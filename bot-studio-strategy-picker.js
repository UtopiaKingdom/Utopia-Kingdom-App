/**
 * bot-studio-strategy-picker.js — Strategy cards with chart art + detail panel.
 * Load AFTER bot-studio-strategies.js, BEFORE bot-studio.js.
 */
(function () {
  'use strict';

  var VISUAL = {
    'mean-revert': 'revert',
    'fade': 'revert',
    'fakeout': 'revert',
    'vwap': 'revert',
    'rsi-extreme': 'osc',
    'rsi-div': 'osc',
    'cci-revert': 'osc',
    'williams': 'osc',
    'bollinger': 'bands',
    'squeeze': 'squeeze',
    'pinbar': 'pin',
    'hammer': 'pin',
    'engulfing': 'engulf',
    'doji': 'doji',
    'morning-star': 'star',
    'stoch': 'osc',
    'macd': 'macd',
    'scalp': 'revert',
    'breakout': 'breakout',
    'impulse': 'trend',
    'pullback': 'trend',
    'ema-cross': 'trend',
    'trend-follow': 'trend',
    'atr-break': 'breakout',
    'heikin': 'trend',
    'range': 'range',
    'range-flip': 'range',
    'support-resist': 'range',
    'double-top': 'range',
    'custom': 'custom'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function visualOf(styleId) {
    return VISUAL[styleId] || 'revert';
  }

  function svgRevert() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<defs><linearGradient id="sg-rev" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="currentColor" stop-opacity="0.25"/>' +
          '<stop offset="100%" stop-color="currentColor" stop-opacity="0.9"/>' +
        '</linearGradient></defs>' +
        '<path d="M6 44 C22 44 28 18 44 20 S60 48 76 28 S92 12 114 24" fill="none" stroke="url(#sg-rev)" stroke-width="2.2" stroke-linecap="round"/>' +
        '<circle cx="76" cy="28" r="3.5" fill="currentColor" opacity="0.9"/>' +
        '<path d="M70 38 L76 28 L82 36" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.75"/>' +
      '</svg>'
    );
  }

  function svgBands() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<path d="M6 32 Q30 14 54 32 T102 32" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.4" stroke-dasharray="3 3"/>' +
        '<path d="M6 20 Q30 8 54 20 T102 20" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2"/>' +
        '<path d="M6 44 Q30 56 54 44 T102 44" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2"/>' +
        '<path d="M6 38 C24 38 30 22 48 24 S72 46 90 30 S100 18 114 26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '<circle cx="48" cy="24" r="3" fill="currentColor"/>' +
      '</svg>'
    );
  }

  function svgOsc() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<rect x="6" y="8" width="108" height="48" rx="6" fill="currentColor" fill-opacity="0.06"/>' +
        '<line x1="6" y1="20" x2="114" y2="20" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>' +
        '<line x1="6" y1="44" x2="114" y2="44" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>' +
        '<path d="M10 36 C22 36 26 18 38 18 S50 46 62 46 S74 22 86 22 S98 40 110 40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  function svgPin() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<line x1="60" y1="12" x2="60" y2="52" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/>' +
        '<rect x="52" y="28" width="16" height="18" rx="2" fill="currentColor" fill-opacity="0.35"/>' +
        '<line x1="60" y1="12" x2="60" y2="28" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
        '<circle cx="60" cy="12" r="2.5" fill="currentColor"/>' +
      '</svg>'
    );
  }

  function svgEngulf() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<rect x="38" y="26" width="14" height="22" rx="2" fill="currentColor" fill-opacity="0.3"/>' +
        '<rect x="58" y="18" width="22" height="30" rx="2" fill="currentColor" fill-opacity="0.75"/>' +
        '<path d="M52 48 L68 48" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.2"/>' +
      '</svg>'
    );
  }

  function svgDoji() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<line x1="60" y1="14" x2="60" y2="50" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.4"/>' +
        '<line x1="52" y1="32" x2="68" y2="32" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  function svgStar() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<rect x="30" y="30" width="12" height="20" rx="2" fill="currentColor" fill-opacity="0.35"/>' +
        '<rect x="52" y="28" width="10" height="6" rx="2" fill="currentColor" fill-opacity="0.5"/>' +
        '<rect x="70" y="22" width="16" height="28" rx="2" fill="currentColor" fill-opacity="0.85"/>' +
      '</svg>'
    );
  }

  function svgTrend() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<path d="M6 50 C28 50 34 38 52 36 S78 28 96 18 S108 14 114 10" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.6" stroke-dasharray="4 3"/>' +
        '<path d="M6 44 C30 44 38 32 58 28 S82 22 114 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '<circle cx="96" cy="18" r="3" fill="currentColor"/>' +
      '</svg>'
    );
  }

  function svgBreakout() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<path d="M6 40 L30 40 L54 40 L78 40 L102 40" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.2"/>' +
        '<path d="M6 38 C22 38 28 36 44 36 S60 36 76 36 S92 34 108 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '<path d="M88 24 L108 20 L104 32 Z" fill="currentColor" opacity="0.8"/>' +
      '</svg>'
    );
  }

  function svgSqueeze() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<path d="M6 24 Q30 20 54 24 T102 24" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.2"/>' +
        '<path d="M6 40 Q30 44 54 40 T102 40" fill="none" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.2"/>' +
        '<path d="M54 24 L54 40" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>' +
        '<path d="M58 32 C70 32 76 18 90 14 S104 28 114 22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  function svgMacd() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<line x1="6" y1="36" x2="114" y2="36" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>' +
        '<rect x="14" y="38" width="8" height="10" rx="1" fill="currentColor" fill-opacity="0.35"/>' +
        '<rect x="28" y="34" width="8" height="14" rx="1" fill="currentColor" fill-opacity="0.5"/>' +
        '<rect x="42" y="28" width="8" height="20" rx="1" fill="currentColor" fill-opacity="0.65"/>' +
        '<rect x="56" y="22" width="8" height="26" rx="1" fill="currentColor" fill-opacity="0.8"/>' +
        '<path d="M10 42 C30 40 50 30 70 28 S95 24 110 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  function svgRange() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<rect x="10" y="18" width="100" height="28" rx="4" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.4"/>' +
        '<path d="M14 32 C28 32 34 20 48 20 S68 44 82 44 S96 32 106 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
        '<line x1="10" y1="18" x2="110" y2="18" stroke="currentColor" stroke-opacity="0.5" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<line x1="10" y1="46" x2="110" y2="46" stroke="currentColor" stroke-opacity="0.5" stroke-width="1" stroke-dasharray="3 3"/>' +
      '</svg>'
    );
  }

  function svgCustom() {
    return (
      '<svg class="studio-strat-svg" viewBox="0 0 120 64" aria-hidden="true">' +
        '<rect x="14" y="16" width="36" height="10" rx="5" fill="currentColor" fill-opacity="0.2"/>' +
        '<rect x="70" y="16" width="36" height="10" rx="5" fill="currentColor" fill-opacity="0.45"/>' +
        '<rect x="14" y="34" width="36" height="10" rx="5" fill="currentColor" fill-opacity="0.35"/>' +
        '<rect x="70" y="34" width="36" height="10" rx="5" fill="currentColor" fill-opacity="0.2"/>' +
        '<circle cx="32" cy="21" r="4" fill="currentColor" opacity="0.5"/>' +
        '<circle cx="88" cy="39" r="4" fill="currentColor" opacity="0.5"/>' +
      '</svg>'
    );
  }

  var SVG = {
    revert: svgRevert,
    bands: svgBands,
    osc: svgOsc,
    pin: svgPin,
    engulf: svgEngulf,
    doji: svgDoji,
    star: svgStar,
    trend: svgTrend,
    breakout: svgBreakout,
    squeeze: svgSqueeze,
    macd: svgMacd,
    range: svgRange,
    custom: svgCustom
  };

  function artHtml(styleId) {
    var key = visualOf(styleId);
    var fn = SVG[key] || SVG.revert;
    return '<div class="studio-strat-art">' + fn() + '</div>';
  }

  function activeFilters(meta) {
    var d = (meta && meta.defaults) || {};
    var out = [];
    if (Number(d.zScore) > 0) out.push('Stretch');
    if (d.rsiLeave) out.push('RSI');
    if (d.rejectionWick) out.push('Wick');
    if (Number(d.volRankMin) > 0) out.push('Volume');
    if (d.useBb) out.push('Bollinger');
    if (d.useEma) out.push('EMA');
    if (d.useStoch) out.push('Stochastic');
    if (d.usePinbar) out.push('Pin bar');
    if (d.useEngulfing) out.push('Engulfing');
    if (d.useMacd) out.push('MACD');
    if (d.useCci) out.push('CCI');
    if (d.useWilliams) out.push('Williams');
    if (d.useDoji) out.push('Doji');
    if (d.useAtr) out.push('ATR');
    if (d.useRsiDiv) out.push('RSI divergence');
    if (d.useStar) out.push('Star pattern');
    if (d.useDouble) out.push('Double top/bottom');
    if (d.useVwap) out.push('VWAP');
    if (d.useHeikin) out.push('Heikin');
    return out;
  }

  function cardHtml(s, isOn, famClass, cmdAttr, tipAttr) {
    return (
      '<button type="button" class="studio-strat-card' + (isOn ? ' is-on' : '') + famClass + '"' +
        cmdAttr('strategy', s.id) + tipAttr(s.name, s.explain, s.useWhen) +
        ' data-studio-style="' + esc(s.id) + '">' +
        artHtml(s.id) +
        '<span class="studio-strat-family">' + esc(s.family) + '</span>' +
        '<span class="studio-strat-name">' + esc(s.name) + '</span>' +
        '<span class="studio-strat-blurb">' + esc(s.blurb) + '</span>' +
        '<span class="studio-strat-hold">' + (isOn ? 'Selected' : 'Tap to pick') + '</span>' +
      '</button>'
    );
  }

  function detailHtml(bot, meta, famSlug, hintHtml) {
    meta = meta || {};
    var styleId = meta.id || (bot && bot.style) || '';
    var fam = famSlug(meta.family);
    var filters = activeFilters(meta);
    var filterLine = filters.length
      ? '<p class="studio-picked-filters"><span>Uses</span> ' + esc(filters.join(' · ')) + '</p>'
      : '<p class="studio-picked-filters"><span>Uses</span> You pick every filter in the next step.</p>';
    return (
      '<div class="studio-strat-detail studio-fam-' + esc(fam) + '">' +
        '<div class="studio-picked"' +
          (meta.explain ? (' data-tip="1" data-tip-title="' + esc(meta.name) + '" data-tip-body="' + esc(meta.explain) + '" data-tip-when="' + esc(meta.useWhen || '') + '"') : '') + '>' +
          artHtml(styleId) +
          '<div class="studio-picked-copy">' +
            '<strong>' + esc(meta.name || 'Pick a style') + '</strong>' +
            '<p class="studio-picked-lead">' + esc(meta.explain || 'Choose a strategy card above. Each one sets smart defaults you can tweak next.') + '</p>' +
            (meta.useWhen ? '<p class="studio-picked-when"><span>Best when</span> ' + esc(meta.useWhen) + '</p>' : '') +
            filterLine +
          '</div>' +
        '</div>' +
        (hintHtml || '') +
      '</div>'
    );
  }

  window.__utkStudioStrategyPicker = {
    visualOf: visualOf,
    artHtml: artHtml,
    cardHtml: cardHtml,
    detailHtml: detailHtml,
    activeFilters: activeFilters
  };
})();
