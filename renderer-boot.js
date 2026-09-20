/**
 * renderer-boot.js — ordered module boot for the main window.
 * Failures always console.error; unpackaged/dev runs are louder.
 */
'use strict';

(function bootRenderer() {
  function isDevBoot() {
    try {
      if (process.env.UTK_DEV_MODE === '1') return true;
      if (process.env.UTK_BOOT_STRICT === '1') return true;
      // Unpackaged electron / project cwd run
      const p = String(process.execPath || '').toLowerCase();
      if (p.includes('electron')) return true;
      if (!/\.asar/i.test(String(__dirname || ''))) return true;
    } catch (_) {}
    return false;
  }

  const DEV = isDevBoot();
  const failed = [];

  function bootRequire(rel, opts) {
    const critical = !!(opts && opts.critical);
    try {
      require(rel);
      return true;
    } catch (e) {
      failed.push({ rel, error: e });
      try {
        console.error('[boot] failed loading', rel, e && e.stack ? e.stack : e);
      } catch (_) {}
      if (DEV && critical) throw e;
      return false;
    }
  }

  try { document.body.classList.add('app-loaded'); } catch (e) {}
  // Keep boot splash up until modules finish — do not mark ready here.

  bootRequire('./bots-registry.js');
  bootRequire('./asset-bootstrap.js');
  bootRequire('./security-hardening.js');
  bootRequire('./perf-boot.js');
  bootRequire('./app-perf.js');
  bootRequire('./app-scroll-smooth.js');
  bootRequire('./auth-visualizer.js');
  bootRequire('./update-ui.js');
  bootRequire('./app-toast.js');
  bootRequire('./bot-phase-guard.js');
  bootRequire('./signal-card-ttl.js');
  bootRequire('./bot-trade-normalize.js');
  bootRequire('./trade-time.js');
  bootRequire('./stats-day.js');
  bootRequire('./trade-duration.js');
  bootRequire('./saving-signal-history.js');
  bootRequire('./saving-step-label.js');
  bootRequire('./renderer.js', { critical: true });
  bootRequire('./signal-result-instant.js');
  bootRequire('./nyx-access.js');
  bootRequire('./autotrade-lifecycle.js');
  bootRequire('./signal-writer-gate.js');
  bootRequire('./saving-signal-stake.js');
  bootRequire('./saving-signal-custom-ladder.js');
  bootRequire('./autotrade-chain-gate.js');
  bootRequire('./signal-countdown-sync.js');
  bootRequire('./bot-signal-wait.js');
  bootRequire('./bot-stats.js');
  bootRequire('./bot-tape-contabo.js');
  bootRequire('./po-account-history.js');
  bootRequire('./bot-results-history.js');
  bootRequire('./bot-streak-persist.js');
  bootRequire('./bot-history-sync.js');
  bootRequire('./bot-streak-modal.js');
  bootRequire('./bot-switch-fx.js');
  bootRequire('./bot-signal-fx.js');
  bootRequire('./signal-pip-ui.js');
  bootRequire('./bot-mind-ui.js');
  bootRequire('./nyx-mind-ui.js');
  bootRequire('./ssid-manager.js');
  bootRequire('./po-deal-result-ui.js');
  bootRequire('./wait-new-1x-ui.js');
  bootRequire('./bot-history-ui.js');
  bootRequire('./strategies-data.js');
  bootRequire('./strategies-charts.js');
  bootRequire('./strategies-ui.js');
  bootRequire('./home-hub.js');
  bootRequire('./home-support.js');
  bootRequire('./home-status.js');
  bootRequire('./vision-ui.js');
  bootRequire('./warnings-ui.js');
  bootRequire('./kingdom-marks-fx.js');
  bootRequire('./kingdom-marks-cloud.js');
  bootRequire('./kingdom-marks.js');
  bootRequire('./app-onboarding.js');
  bootRequire('./community-hub-censor.js');
  bootRequire('./community-hub-avatars.js');
  bootRequire('./community-hub.js');
  bootRequire('./community-hub-msg-ui.js');
  bootRequire('./community-hub-emotes.js');
  bootRequire('./community-hub-members.js');
  bootRequire('./bot-studio-strategies.js');
  bootRequire('./bot-studio-strategy-hints.js');
  bootRequire('./bot-studio-strategy-picker.js');
  bootRequire('./studio-check-window.js');
  bootRequire('./studio-room-ui.js');
  bootRequire('./studio-paper-local.js');
  bootRequire('./bot-studio-stage.js');
  bootRequire('./bot-studio-dialog.js');
  bootRequire('./studio-options-modal.js');
  bootRequire('./studio-backtest-proof.js');
  bootRequire('./studio-clarity.js');
  bootRequire('./studio-live-status.js');
  bootRequire('./studio-bot-hub.js');
  bootRequire('./bot-studio.js');
  bootRequire('./studio-ux-polish.js');
  bootRequire('./bot-studio-name.js');
  bootRequire('./bot-studio-wizard.js');
  bootRequire('./bot-studio-cook-bind.js');
  bootRequire('./bot-studio-chart.js');
  bootRequire('./bot-studio-interactions.js');
  bootRequire('./studio-autotrade.js');
  bootRequire('./studio-desk-stats.js');
  bootRequire('./studio-streak-modal.js');
  bootRequire('./studio-signal-glow.js');
  bootRequire('./studio-smooth.js');
  bootRequire('./studio-feed-desk.js');
  bootRequire('./studio-signal-live.js');
  bootRequire('./studio-desk-parity.js');
  bootRequire('./bot-studio-desk.js');
  bootRequire('./bot-studio-ai.js');
  bootRequire('./studio-community-takedown.js');
  bootRequire('./studio-global-hub.js');
  bootRequire('./bot-studio-tips.js');
  bootRequire('./exit-tray-modal.js');
  bootRequire('./signal-notifications.js');
  bootRequire('./section-nav-fx.js');
  bootRequire('./app-nav-smooth.js');
  // Access gate must wrap AFTER section-nav-fx so paywall blocks run before the wipe.
  bootRequire('./access-gate.js');
  bootRequire('./app-section-preload.js');

  if (failed.length) {
    try {
      console.warn('[boot] ' + failed.length + ' module(s) failed to load', failed.map((f) => f.rel));
    } catch (_) {}
  }

  try {
    window.__utkBoot = { ok: failed.length === 0, failed: failed.map((f) => f.rel), dev: DEV };
  } catch (_) {}

  // Reveal app after heavy requires finish (splash fades out).
  function markBootReady() {
    try {
      document.documentElement.classList.remove('utk-boot-hold');
      document.documentElement.classList.add('utk-boot-ready');
      var splash = document.getElementById('utkBootSplash');
      if (splash) splash.setAttribute('aria-busy', 'false');
    } catch (_) {}
  }
  try {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () {
        requestAnimationFrame(markBootReady);
      });
    } else {
      setTimeout(markBootReady, 0);
    }
  } catch (_) {
    markBootReady();
  }
})();
