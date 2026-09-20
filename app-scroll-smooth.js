/**
 * app-scroll-smooth.js — native scroll only.
 *
 * Previous versions hijacked wheel (preventDefault + rAF lerp) which felt
 * slow/laggy once Windows smooth scrolling was on. Leave Chromium alone.
 */
(function () {
  'use strict';

  if (window.__utkScrollSmooth && window.__utkScrollSmooth.__nativeV1) return;

  try {
    if (window.__utkScrollSmooth && typeof window.__utkScrollSmooth.stop === 'function') {
      window.__utkScrollSmooth.stop();
    }
  } catch (e) {}

  try {
    document.documentElement.classList.remove('utk-scrolling');
  } catch (e) {}

  window.__utkScrollSmooth = {
    __nativeV1: true,
    stop: function () {
      try { document.documentElement.classList.remove('utk-scrolling'); } catch (e) {}
    },
    isScrolling: function () { return false; },
    mark: function () {}
  };

  try { module.exports = window.__utkScrollSmooth; } catch (_) {}
})();
