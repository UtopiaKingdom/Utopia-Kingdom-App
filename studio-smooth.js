/**
 * studio-smooth.js — Shared paint-key + adaptive poll helpers for Studio desks.
 * Load BEFORE bot-studio-desk.js / studio-global-hub.js.
 */
(function () {
  'use strict';

  function paintKey(parts) {
    return (parts || []).map(function (p) {
      return p == null ? '' : String(p);
    }).join('|');
  }

  function signalPaintBits(sig) {
    sig = sig || {};
    return [
      sig.signalId || '',
      sig.phase || '',
      sig.result || '',
      sig.side || '',
      sig.pair || sig.symbol || '',
      sig.openedAtMs || '',
      sig.closedAtMs || '',
      sig.attempt || ''
    ];
  }

  /** Slower polls when idle; snappier when a live signal/result is on screen. */
  function adaptivePollMs(sig, opts) {
    opts = opts || {};
    const phase = String((sig && sig.phase) || '').toLowerCase();
    if (phase === 'signal' || phase === 'preparing' || phase === 'result') {
      return opts.hot || 900;
    }
    return opts.idle || 1600;
  }

  function preferReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function scheduleFrame(fn) {
    if (preferReducedMotion()) {
      try { fn(); } catch (e) {}
      return;
    }
    try {
      requestAnimationFrame(function () { fn(); });
    } catch (e2) {
      try { fn(); } catch (e3) {}
    }
  }

  window.__utkStudioSmooth = {
    paintKey: paintKey,
    signalPaintBits: signalPaintBits,
    adaptivePollMs: adaptivePollMs,
    preferReducedMotion: preferReducedMotion,
    scheduleFrame: scheduleFrame
  };

  try { module.exports = window.__utkStudioSmooth; } catch (_) {}
})();
