/**
 * app-section-preload.js — Warm Hub / Studio / section layout after login
 * so the smooth section wipe reveals ready panes (no Connecting flash).
 * Load last (after section-nav-fx + app-nav-smooth).
 */
(function () {
  'use strict';

  if (window.__utkSectionPreload) return;

  const WARM_SECTIONS = [
    'section-main',
    'section-bots',
    'section-bot1',
    'section-bot2',
    'section-bot3',
    'section-hub',
    'section-studio',
    'section-strategies',
    'section-profile'
  ];

  let started = false;
  let layoutWarmed = false;
  let dataWarmed = false;

  function scheduleIdle(fn, timeout) {
    try {
      if (window.__utkAppPerf && typeof window.__utkAppPerf.scheduleIdle === 'function') {
        return window.__utkAppPerf.scheduleIdle(fn, timeout || 1200);
      }
    } catch (e) {}
    try {
      if (typeof requestIdleCallback === 'function') {
        return requestIdleCallback(fn, { timeout: timeout || 1200 });
      }
    } catch (e2) {}
    return setTimeout(fn, 200);
  }

  function isAuthedUi() {
    try {
      if (document.body && document.body.classList.contains('auth-visible')) return false;
      if (document.body && document.body.classList.contains('maintenance-mode')) return false;
    } catch (e) {}
    try {
      const av = require('./auth-verification.js');
      const auth = (av && av.auth) || window.auth;
      if (auth && auth.currentUser) return true;
    } catch (e2) {}
    try {
      const auth = window.auth;
      if (auth && auth.currentUser) return true;
    } catch (e3) {}
    return false;
  }

  function warmLayoutOnce() {
    if (layoutWarmed) return;
    layoutWarmed = true;
    const host = document.querySelector('.main-content');
    if (!host) return;

    const active = document.querySelector('.section.active');
    const restored = [];

    for (let i = 0; i < WARM_SECTIONS.length; i++) {
      const el = document.getElementById(WARM_SECTIONS[i]);
      if (!el || el === active) continue;
      if (el.classList.contains('active')) continue;
      restored.push({
        el: el,
        display: el.style.display,
        visibility: el.style.visibility,
        position: el.style.position,
        pointerEvents: el.style.pointerEvents,
        left: el.style.left,
        top: el.style.top,
        width: el.style.width,
        height: el.style.height,
        zIndex: el.style.zIndex,
        opacity: el.style.opacity
      });
      el.classList.add('utk-section-warming');
      el.style.display = 'block';
      el.style.visibility = 'hidden';
      el.style.position = 'absolute';
      el.style.pointerEvents = 'none';
      el.style.left = '0';
      el.style.top = '0';
      el.style.width = '100%';
      el.style.height = 'auto';
      el.style.zIndex = '-1';
      el.style.opacity = '0';
      try {
        void el.offsetHeight;
      } catch (e) {}
    }

    // Yield a frame, then restore so we don't leave ghost panes in layout.
    requestAnimationFrame(function () {
      for (let j = 0; j < restored.length; j++) {
        const r = restored[j];
        try {
          r.el.classList.remove('utk-section-warming');
          r.el.style.display = r.display;
          r.el.style.visibility = r.visibility;
          r.el.style.position = r.position;
          r.el.style.pointerEvents = r.pointerEvents;
          r.el.style.left = r.left;
          r.el.style.top = r.top;
          r.el.style.width = r.width;
          r.el.style.height = r.height;
          r.el.style.zIndex = r.zIndex;
          r.el.style.opacity = r.opacity;
        } catch (e2) {}
      }
      try {
        if (window.__utkAppPerf && typeof window.__utkAppPerf.tagInactiveSections === 'function') {
          window.__utkAppPerf.tagInactiveSections();
        }
      } catch (e3) {}
    });
  }

  function warmHub() {
    try {
      const hub = window.__utkCommunityHub;
      if (!hub) return Promise.resolve();
      if (typeof hub.warm === 'function') return Promise.resolve(hub.warm());
      if (typeof hub.sync === 'function') return Promise.resolve(hub.sync({ light: false }));
    } catch (e) {}
    return Promise.resolve();
  }

  function warmStudio() {
    try {
      const studio = window.__utkBotStudio;
      if (studio && typeof studio.warm === 'function') {
        return Promise.resolve(studio.warm());
      }
    } catch (e) {}
    return Promise.resolve();
  }

  function warmFeed() {
    try {
      const g = window.__utkStudioGlobal;
      if (g && typeof g.refresh === 'function') {
        return Promise.resolve(g.refresh());
      }
    } catch (e) {}
    return Promise.resolve();
  }

  function runDataWarm() {
    if (dataWarmed) return;
    if (!isAuthedUi()) return;
    dataWarmed = true;

    warmHub()
      .then(function () { return warmStudio(); })
      .then(function () { return warmFeed(); })
      .catch(function () {})
      .then(function () {
        scheduleIdle(warmLayoutOnce, 800);
      });
  }

  function arm() {
    if (started) return;
    started = true;

    const tryWarm = function () {
      if (!isAuthedUi()) {
        scheduleIdle(tryWarm, 1500);
        return;
      }
      scheduleIdle(runDataWarm, 900);
    };

    // Auth modal close / sign-in
    try {
      const obs = new MutationObserver(function () {
        if (isAuthedUi()) {
          scheduleIdle(runDataWarm, 600);
        } else {
          dataWarmed = false;
        }
      });
      if (document.body) {
        obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      }
    } catch (e) {}

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && isAuthedUi() && !dataWarmed) {
        scheduleIdle(runDataWarm, 500);
      }
    });

    scheduleIdle(tryWarm, 400);
    setTimeout(tryWarm, 1800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm);
  } else {
    arm();
  }

  window.__utkSectionPreload = {
    warmNow: function () {
      dataWarmed = false;
      runDataWarm();
    },
    warmLayout: warmLayoutOnce,
    isAuthedUi: isAuthedUi
  };

  try { module.exports = window.__utkSectionPreload; } catch (_) {}
})();
