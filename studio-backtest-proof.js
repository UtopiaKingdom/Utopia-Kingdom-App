/**
 * studio-backtest-proof.js — Honest "what was tested" block on the backtest card.
 * Load BEFORE studio-feed-desk.js.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function styleLabel(id) {
    const api = window.__utkStudioStrategies;
    if (api && typeof api.labelOf === 'function') return api.labelOf(id);
    return id || 'Strategy';
  }

  function attemptsLabel(n) {
    n = Math.max(1, Math.min(5, Number(n) || 5));
    if (n === 1) return 'Entry only — no re-entry';
    if (n === 5) return 'Up to 5 tries (full ladder)';
    return 'Up to ' + n + ' tries per chain';
  }

  function html(card) {
    if (!card || !card.ok) return '';
    const proof = card.proof && typeof card.proof === 'object' ? card.proof : {};
    const styleId = proof.style || card.style || '';
    const maxA = card.maxAttempts != null ? card.maxAttempts : (proof.maxAttempts || 5);
    const mg = Array.isArray(proof.martingale) && proof.martingale.length
      ? proof.martingale.join(' → ')
      : '';
    const filters = Array.isArray(proof.filters) && proof.filters.length
      ? proof.filters.join(' · ')
      : 'Strategy defaults only';
    const watch = Array.isArray(proof.watch) ? proof.watch.join(' + ') : (card.timeframe || '1m');
    const mode = proof.watchMode === 'combined' ? ' (both must agree)' : '';
    const root = proof.candlesRoot || card.candlesRoot || 'BotsHub/Prices/candles';
    return (
      '<details class="studio-backtest-proof">' +
        '<summary>What was tested (real replay)</summary>' +
        '<ul class="studio-backtest-proof-list">' +
          '<li><span>Strategy</span><strong>' + esc(styleLabel(styleId)) + '</strong></li>' +
          '<li><span>Charts</span><strong>' + esc(watch) + esc(mode) + '</strong></li>' +
          '<li><span>Retries</span><strong>' + esc(attemptsLabel(maxA)) + '</strong></li>' +
          (mg ? '<li><span>Ladder</span><strong>' + esc(mg.split(' → ').map(function (x) { return '×' + x; }).join(' ')) + '</strong></li>' : '') +
          '<li><span>Filters</span><strong>' + esc(filters) + '</strong></li>' +
          '<li><span>Data</span><strong>' + esc(root) + '</strong></li>' +
          '<li><span>Engine</span><strong>Same code as live 24/7 runner</strong></li>' +
        '</ul>' +
        '<p class="studio-backtest-proof-note">Not random. Your rules ran on stored OTC candles — same signal function the live server uses.</p>' +
      '</details>'
    );
  }

  function liveMatchNote(bot, card) {
    if (!bot || !card || !card.ok || !card.proof) return '';
    const live = String(bot.status || '').toLowerCase() === 'live';
    if (!live) return '';
    const sameStyle = String(bot.style || '') === String(card.proof.style || card.style || '');
  const sameMax = Number(bot.maxAttempts || 5) === Number(card.maxAttempts || card.proof.maxAttempts || 5);
    if (!sameStyle || !sameMax) {
      return 'Recipe changed since last test — run Test again to confirm.';
    }
    return 'Live runner is using the same strategy and retry count as this backtest.';
  }

  window.__utkStudioBacktestProof = {
    html: html,
    liveMatchNote: liveMatchNote,
    attemptsLabel: attemptsLabel
  };
})();
