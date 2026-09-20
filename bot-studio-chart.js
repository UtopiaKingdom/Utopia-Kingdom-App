/**
 * bot-studio-chart.js — Chart picker wiring + UX. Load AFTER bot-studio.js.
 */
(function () {
  'use strict';

  function studio() {
    return window.__utkBotStudio || null;
  }

  function wire(root) {
    if (!root) return;
    const mount = root.querySelector('#studioChart');
    if (!mount) return;

    mount.querySelectorAll('[data-chart-mode]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const s = studio();
        if (s && s.command) s.command('watchMode', btn.getAttribute('data-chart-mode') || 'single');
      });
    });

    mount.querySelectorAll('[data-chart-tf]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const s = studio();
        if (s && s.command) {
          s.command('timeframe', btn.getAttribute('data-chart-tf') || '1m', btn.getAttribute('data-chart-slot') || 'a');
        }
      });
    });
  }

  window.__utkStudioChart = { wire: wire };
})();
