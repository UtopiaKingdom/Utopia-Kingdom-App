/**
 * app-nav-smooth.js — Snappier section switching + background idle.
 * Load after section-nav-fx.js.
 */
(function () {
  'use strict';

  function activeSectionId() {
    try {
      const el = document.querySelector('.section.active');
      if (!el || !el.id) return '';
      return String(el.id).replace(/^section-/, '');
    } catch (e) {
      return '';
    }
  }

  function isHidden() {
    try {
      return !!(document.hidden || document.visibilityState === 'hidden');
    } catch (e) {
      return false;
    }
  }

  function bumpNotifyPoll() {
    try {
      if (window.__utkSignalNotify && typeof window.__utkSignalNotify.syncPollTimer === 'function') {
        window.__utkSignalNotify.syncPollTimer();
      }
    } catch (e) {}
  }

  // Avoid forced reflow in section wipe when possible.
  try {
    const fx = window.utkSectionFx;
    if (fx && typeof fx.run === 'function' && !fx.run.__utkNavSmooth) {
      const prev = fx.run.bind(fx);
      async function runFast(swapFn) {
        if (isHidden() || (window.utkPerf && window.utkPerf.reducedMotion)) {
          try { if (typeof swapFn === 'function') swapFn(); } catch (e) {}
          return;
        }
        return prev(swapFn);
      }
      runFast.__utkNavSmooth = true;
      fx.run = runFast;
    }
  } catch (e) {}

  document.addEventListener('visibilitychange', function () {
    try {
      document.documentElement.classList.toggle('utk-bg-idle', isHidden());
    } catch (e) {}
    bumpNotifyPoll();
  });

  // After section swaps, mark idle panes + clear any stuck resize freeze.
  // Also nudge preload if login just finished and warm never ran.
  try {
    const _nav = document.querySelector('.sidebar') || document.body;
    if (_nav) {
      _nav.addEventListener('click', function (ev) {
        const item = ev.target && ev.target.closest && ev.target.closest('.menu-item');
        if (!item) return;
        setTimeout(function () {
          try {
            if (window.__utkAppPerf) {
              if (typeof window.__utkAppPerf.endResize === 'function') window.__utkAppPerf.endResize();
              if (typeof window.__utkAppPerf.tagInactiveSections === 'function') {
                window.__utkAppPerf.tagInactiveSections();
              }
            }
          } catch (e) {}
        }, 0);
      }, true);
    }
  } catch (e) {}

  // Hover intent: warm Hub/Studio a beat before click when still cold.
  let hoverWarmStudioAt = 0;
  try {
    document.addEventListener('pointerenter', function (ev) {
      const item = ev.target && ev.target.closest && ev.target.closest('.menu-item');
      if (!item || item.classList.contains('locked')) return;
      const id = item.id === 'menu-bots' ? 'bot1' : String(item.id || '').replace('menu-', '');
      if (id === 'hub') {
        try {
          const hub = window.__utkCommunityHub;
          if (hub && typeof hub.warm === 'function') {
            if (typeof hub.isWarm !== 'function' || !hub.isWarm()) hub.warm();
          }
        } catch (e) {}
      } else if (id === 'studio') {
        try {
          const now = Date.now();
          if (now - hoverWarmStudioAt < 8000) return;
          hoverWarmStudioAt = now;
          const studio = window.__utkBotStudio;
          if (studio && typeof studio.warm === 'function') studio.warm();
        } catch (e2) {}
      }
    }, true);
  } catch (eHover) {}

  window.__utkAppSmooth = {
    activeSectionId: activeSectionId,
    isHidden: isHidden,
    notifyPollMs: function () {
      return isHidden() ? 3200 : 1400;
    }
  };

  try { module.exports = window.__utkAppSmooth; } catch (_) {}
})();
