/**
 * section-nav-fx.js
 * Clean black wipe between Home / Bots / Hub / Studio / Profile / etc.
 * Same feel as bot switch: fade to app bg → hard swap → fade back.
 * Load AFTER renderer.js, community-hub.js, bot-studio.js, bot-switch-fx.js.
 */
(function () {
  'use strict';

  // Soft wipe — quick enough to feel snappy, long enough to read as smooth.
  const FADE_OUT_MS = 48;
  const HOLD_MS = 0;
  const FADE_IN_MS = 96;
  const EASE = 'cubic-bezier(0.33, 0, 0.2, 1)';

  let running = null;
  let overlayEl = null;
  let afterRevealQueue = [];
  let afterRevealGen = 0;

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function getOverlay() {
    if (overlayEl && overlayEl.isConnected) return overlayEl;
    const host = document.querySelector('.main-content') || document.body;
    let el = host.querySelector('.utk-bot-blackout, .utk-section-blackout');
    if (!el) {
      el = document.createElement('div');
      el.className = 'utk-bot-blackout utk-section-blackout';
      el.setAttribute('aria-hidden', 'true');
      host.appendChild(el);
    } else {
      el.classList.add('utk-section-blackout');
    }
    overlayEl = el;
    return el;
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function setVeil(opacity, durationMs) {
    const el = getOverlay();
    el.style.transition = 'opacity ' + durationMs + 'ms ' + EASE;
    el.style.opacity = String(opacity);
    return wait(durationMs);
  }

  function clearVeil() {
    try {
      if (!overlayEl) return;
      overlayEl.style.transition = 'none';
      overlayEl.style.opacity = '0';
    } catch (e) {}
  }

  function cancel() {
    if (running && typeof running.cancel === 'function') {
      try { running.cancel(); } catch (e) {}
    }
    running = null;
    clearVeil();
    afterRevealGen += 1;
    afterRevealQueue = [];
  }

  /**
   * Run fn after the current section wipe finishes (or next frame if idle).
   * Use this for Hub start / Studio open so the blackout stays smooth.
   */
  function afterReveal(fn) {
    if (typeof fn !== 'function') return;
    if (running) {
      afterRevealQueue.push(fn);
      return;
    }
    try {
      requestAnimationFrame(function () {
        try { fn(); } catch (e) {}
      });
    } catch (e2) {
      try { fn(); } catch (e3) {}
    }
  }

  function flushAfterReveal() {
    const gen = afterRevealGen;
    const q = afterRevealQueue.splice(0);
    if (!q.length) return;
    // One frame after unveil so compositor can settle before heavy DOM work.
    try {
      requestAnimationFrame(function () {
        if (gen !== afterRevealGen) return;
        for (let i = 0; i < q.length; i++) {
          try { q[i](); } catch (e) {}
        }
      });
    } catch (e2) {
      for (let j = 0; j < q.length; j++) {
        try { q[j](); } catch (e3) {}
      }
    }
  }

  /**
   * Fade out → run sync swap → fade in → afterReveal.
   * Used by section nav and Studio Feed/Yours.
   */
  async function run(swapFn) {
    if (typeof swapFn !== 'function') return;

    if (running && typeof running.cancel === 'function') {
      try { running.cancel(); } catch (e) {}
    }

    afterRevealGen += 1;
    afterRevealQueue = [];

    let cancelled = false;
    const localCancel = function () {
      cancelled = true;
      clearVeil();
      running = null;
      afterRevealGen += 1;
      afterRevealQueue = [];
    };
    running = { cancel: localCancel };

    if (prefersReducedMotion()) {
      try { swapFn(); } catch (e) {}
      running = null;
      flushAfterReveal();
      return;
    }

    try {
      try {
        if (window.utkBotTransitions && typeof window.utkBotTransitions.cancel === 'function') {
          window.utkBotTransitions.cancel();
        }
      } catch (e) {}

      // Force a paint with veil at 0 before covering (avoids first-frame hitch).
      getOverlay();
      await setVeil(1, FADE_OUT_MS);
      if (cancelled) return;

      try { swapFn(); } catch (e) {}
      // One frame under veil so the new section shell can paint before reveal.
      await new Promise(function (resolve) {
        try { requestAnimationFrame(resolve); } catch (e2) { resolve(); }
      });
      if (cancelled) return;
      if (HOLD_MS) await wait(HOLD_MS);
      if (cancelled) return;

      await setVeil(0, FADE_IN_MS);
    } catch (e) {
      try { swapFn(); } catch (err) {}
      clearVeil();
    } finally {
      if (!cancelled) {
        running = null;
        flushAfterReveal();
      }
    }
  }

  function sectionIdFromNav(id) {
    return 'section-' + String(id || '');
  }

  function installNavigateWrap() {
    const orig = window.navigateToSection;
    if (typeof orig !== 'function' || orig.__utkSectionFx) return;

    function wrapped(id, activeMenuItem) {
      const target = document.getElementById(sectionIdFromNav(id));
      if (!target) {
        return orig(id, activeMenuItem);
      }
      const current = document.querySelector('.section.active');
      if (current === target) {
        return orig(id, activeMenuItem);
      }

      return run(function () {
        orig(id, activeMenuItem);
        try {
          const scroller = document.querySelector('.main-content');
          if (scroller) scroller.scrollTop = 0;
        } catch (e) {}
      });
    }

    wrapped.__utkSectionFx = true;
    window.navigateToSection = wrapped;
  }

  window.utkSectionFx = {
    run: run,
    cancel: cancel,
    afterReveal: afterReveal,
    isRunning: function () { return !!running; }
  };

  function boot() {
    installNavigateWrap();
    // Re-wrap after other modules that patch navigateToSection.
    setTimeout(installNavigateWrap, 0);
    setTimeout(installNavigateWrap, 400);
    setTimeout(installNavigateWrap, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
