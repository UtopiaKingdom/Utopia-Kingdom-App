/**
 * security-hardening.js — renderer-side abuse mitigations.
 * Load early from renderer-boot.js (before auth / renderer).
 *
 * Note: full Electron contextIsolation is a larger migration; this layer
 * blocks common client-side attack paths while that lands.
 */
(function () {
  'use strict';

  function openExternalSafe(href) {
    try {
      const { ipcRenderer } = require('electron');
      return ipcRenderer.invoke('open-external-url', { url: String(href || '') });
    } catch (_) {
      return Promise.resolve({ success: false });
    }
  }

  function hardenDocument() {
    try {
      // Block drag/drop of local files into the app (path to XSS / file exfil)
      window.addEventListener('dragover', (e) => { try { e.preventDefault(); } catch (_) {} }, true);
      window.addEventListener('drop', (e) => { try { e.preventDefault(); } catch (_) {} }, true);
    } catch (_) {}

    try {
      // Discourage casual DevTools use (main process also blocks shortcuts)
      document.addEventListener('contextmenu', (e) => {
        try {
          if (process.env.UTK_ALLOW_DEVTOOLS === '1') return;
          e.preventDefault();
        } catch (_) {}
      }, true);
    } catch (_) {}

    try {
      // Never allow navigating the main shell to an external URL
      window.addEventListener('click', (e) => {
        try {
          const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
          if (!a) return;
          const href = String(a.getAttribute('href') || '');
          if (/^https?:\/\//i.test(href)) {
            e.preventDefault();
            openExternalSafe(href);
          }
        } catch (_) {}
      }, true);
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hardenDocument, { once: true });
  } else {
    hardenDocument();
  }

  // Expose a tiny helper so other modules can refuse privileged actions
  window.__utkSecurity = {
    version: 2,
    isDevToolsAllowed: () => process.env.UTK_ALLOW_DEVTOOLS === '1',
    openExternal: openExternalSafe,
  };

  try { module.exports = window.__utkSecurity; } catch (_) {}
})();
