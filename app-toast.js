/**
 * Minimal in-app toast — compact top-right notices.
 */
(function () {
  'use strict';

  const MAX_VISIBLE = 4;
  let host = null;

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div');
    host.id = 'utk-toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
  }

  function trimStack(root) {
    const items = root.querySelectorAll('.utk-toast');
    if (items.length <= MAX_VISIBLE) return;
    for (let i = MAX_VISIBLE; i < items.length; i++) {
      try { items[i].remove(); } catch (e) {}
    }
  }

  function showToast(message, opts) {
    opts = opts || {};
    const text = String(message || '').trim();
    if (!text) return;
    const tone = opts.tone || 'info';
    const ms = Number(opts.durationMs) > 0
      ? Number(opts.durationMs)
      : (tone === 'error' ? 4200 : tone === 'success' ? 2400 : 3000);

    const el = document.createElement('div');
    el.className = 'utk-toast utk-toast--' + tone;
    el.textContent = text;

    const root = ensureHost();
    root.insertBefore(el, root.firstChild);
    trimStack(root);

    requestAnimationFrame(function () {
      el.classList.add('is-in');
    });

    const remove = function () {
      el.classList.remove('is-in');
      el.classList.add('is-out');
      setTimeout(function () {
        try { el.remove(); } catch (e) {}
      }, 180);
    };
    setTimeout(remove, ms);
  }

  window.showAppToast = showToast;
  try { module.exports = { showToast }; } catch (e) {}
})();
