/**
 * studio-ux-polish.js
 * Centers Studio landing and hub; keeps desk chrome calm.
 * Load AFTER bot-studio.js / studio-room-ui.js.
 */
(function () {
  'use strict';

  function pageEl() {
    return document.getElementById('studioPage');
  }

  function syncEmptyMode() {
    const page = pageEl();
    if (!page) return;
    const botOpen = page.classList.contains('is-bot-open');
    const empty = !!page.querySelector(
      '.studio-room-empty, .studio-hub-empty, .studio-empty.studio-stage'
    );
    const landing = !botOpen && empty;
    page.classList.toggle('is-studio-landing', landing);
    try {
      const section = document.getElementById('section-studio');
      if (section) section.classList.toggle('is-studio-landing', landing);
    } catch (e) {}
  }

  function observe() {
    const page = pageEl();
    if (!page || page.dataset.utkStudioPolish === '1') return;
    page.dataset.utkStudioPolish = '1';
    const mo = new MutationObserver(function () { syncEmptyMode(); });
    mo.observe(page, { childList: true, subtree: true });
    syncEmptyMode();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }
  window.addEventListener('utk:studio-render', syncEmptyMode);
  window.__utkStudioUxPolish = { sync: syncEmptyMode };
})();
