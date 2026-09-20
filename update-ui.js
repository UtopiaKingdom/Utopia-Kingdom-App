/**
 * update-ui.js — Quiet background updates with a minimal bottom banner.
 * Download in background. Refresh only when fully ready (user taps Refresh).
 * Never auto-install / auto-reopen.
 */
(function () {
  let ipcRenderer = null;
  try {
    ({ ipcRenderer } = require('electron'));
  } catch (e) {
    return;
  }

  const STATE = {
    version: '',
    percent: 0,
    phase: 'idle', // idle | downloading | ready | error | installing
  };

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function versionLabel(v) {
    const s = String(v || '').trim().replace(/^v/i, '');
    return s ? `v${s}` : '';
  }

  function openProfile() {
    try {
      if (typeof window.navigateToSection === 'function') {
        window.navigateToSection('profile');
        return;
      }
    } catch (e) {}
    try { $('userProfileCard') && $('userProfileCard').click(); } catch (e2) {}
  }

  function ensureBanner() {
    if ($('utkUpdateBanner')) return;
    const el = document.createElement('div');
    el.id = 'utkUpdateBanner';
    el.className = 'utk-update-banner';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="utk-update-banner-inner">' +
        '<div class="utk-update-banner-copy">' +
          '<span class="utk-update-banner-label" id="utkUpdateBannerLabel">Update</span>' +
          '<p class="utk-update-banner-text" id="utkUpdateBannerText"></p>' +
        '</div>' +
        '<div class="utk-update-banner-track" id="utkUpdateBannerTrack" hidden>' +
          '<div class="utk-update-banner-fill" id="utkUpdateBannerFill"></div>' +
        '</div>' +
        '<div class="utk-update-banner-actions" id="utkUpdateBannerActions" hidden>' +
          '<button type="button" class="utk-update-btn-ghost" id="utkUpdateBannerLater">Later</button>' +
          '<button type="button" class="utk-update-btn-primary" id="utkUpdateBannerRestart" disabled>Refresh</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    const later = $('utkUpdateBannerLater');
    const restart = $('utkUpdateBannerRestart');
    if (later && !later.__utkWired) {
      later.__utkWired = true;
      later.addEventListener('click', () => {
        setActions(false);
        const v = versionLabel(STATE.version);
        const msg = v
          ? `${v} is ready whenever you are. Open Profile → Refresh when you want it.`
          : 'Update ready whenever you are. Open Profile → Refresh when you want it.';
        syncBanner('', 'idle', false, false);
        syncSettingsStatus(msg, '#9aa0a6');
        setChip(v ? `${v} ready` : 'Update ready', 'ready');
      });
    }
    if (restart && !restart.__utkWired) {
      restart.__utkWired = true;
      restart.addEventListener('click', () => { restartNow().catch(() => {}); });
    }
  }

  function syncBanner(text, tone, showProgress, showActions) {
    ensureBanner();
    const banner = $('utkUpdateBanner');
    const label = $('utkUpdateBannerLabel');
    const copy = $('utkUpdateBannerText');
    const track = $('utkUpdateBannerTrack');
    const fill = $('utkUpdateBannerFill');
    const actions = $('utkUpdateBannerActions');
    const restart = $('utkUpdateBannerRestart');
    if (!banner || !copy) return;

    const active = !!(text && text.trim());
    banner.hidden = !active;
    banner.classList.toggle('is-ready', tone === 'ready');
    banner.classList.toggle('is-busy', tone === 'busy');
    banner.classList.toggle('is-error', tone === 'error');

    if (label) {
      if (tone === 'ready') label.textContent = 'Ready';
      else if (tone === 'error') label.textContent = 'Update';
      else if (STATE.phase === 'installing') label.textContent = 'Installing';
      else label.textContent = 'Downloading';
    }
    copy.textContent = text || '';

    if (track) track.hidden = !showProgress;
    if (fill && typeof STATE.percent === 'number') {
      fill.style.width = `${Math.max(0, Math.min(100, STATE.percent))}%`;
    }
    if (actions) actions.hidden = !showActions;
    if (restart) {
      const canRefresh = STATE.phase === 'ready' && showActions;
      restart.disabled = !canRefresh;
      restart.textContent = 'Refresh';
    }
  }

  function setChip(text, tone) {
    const chip = $('sidebarUpdateChip');
    if (!chip) return;
    if (!text) {
      chip.hidden = true;
      chip.textContent = '';
      chip.classList.remove('is-ready', 'is-busy', 'is-error');
      return;
    }
    chip.hidden = false;
    chip.textContent = text;
    chip.classList.toggle('is-ready', tone === 'ready');
    chip.classList.toggle('is-busy', tone === 'busy');
    chip.classList.toggle('is-error', tone === 'error');
  }

  function setActions(showRestart) {
    const canRefresh = !!showRestart && STATE.phase === 'ready';
    const actions = $('profileUpdateActions');
    if (actions) actions.hidden = !canRefresh;
    const restartBtn = $('profileUpdateRestartBtn');
    if (restartBtn) {
      restartBtn.disabled = !canRefresh;
      if (canRefresh) restartBtn.textContent = 'Refresh now';
    }
    const laterBtn = $('profileUpdateLaterBtn');
    if (laterBtn) laterBtn.hidden = !canRefresh;
    syncBanner(
      $('updateStatus') ? $('updateStatus').textContent : '',
      canRefresh ? 'ready' : (STATE.phase === 'error' ? 'error' : 'busy'),
      STATE.phase === 'downloading',
      canRefresh
    );
  }

  function syncSettingsStatus(text, color) {
    const el = $('updateStatus');
    if (!el) return;
    el.style.display = text ? 'block' : 'none';
    if (text) el.textContent = text;
    if (color) el.style.color = color;
  }

  function syncSettingsProgress(percent, visible) {
    const cont = $('updateProgressContainer');
    const fill = $('updateProgressFill');
    const text = $('updateProgressText');
    const retryBtn = $('retryUpdateBtn');
    if (cont) {
      cont.style.display = 'block';
      cont.style.opacity = visible === false ? '0.28' : '1';
    }
    if (typeof percent === 'number') {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      STATE.percent = p;
      if (fill) fill.style.width = `${p}%`;
      if (text) text.textContent = `${p}%`;
    }
    if (retryBtn) retryBtn.style.display = STATE.phase === 'error' ? 'inline-flex' : 'none';
  }

  function showDownloading(version) {
    STATE.phase = 'downloading';
    if (version) STATE.version = String(version).trim().replace(/^v/i, '');
    const v = versionLabel(STATE.version);
    setActions(false);
    syncSettingsProgress(0, true);
    const msg = v
      ? `Downloading ${v} in the background. Keep using the app — Refresh unlocks when it’s done.`
      : 'Downloading the update in the background. Keep using the app — Refresh unlocks when it’s done.';
    syncSettingsStatus(msg, '#c8d0d8');
    syncBanner(msg, 'busy', true, false);
    setChip(v ? `Update ${v}` : 'Updating', 'busy');
  }

  function showProgress(percent) {
    STATE.phase = 'downloading';
    setActions(false);
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    syncSettingsProgress(p, true);
    const msg = p >= 99
      ? 'Almost done. Finishing the download…'
      : `Downloading… ${p}% — Refresh will unlock when this finishes.`;
    syncSettingsStatus(msg, '#c8d0d8');
    syncBanner(msg, 'busy', true, false);
    setChip(p >= 99 ? 'Finishing' : `${p}%`, 'busy');
  }

  function showReady(version) {
    STATE.phase = 'ready';
    if (version) STATE.version = String(version).trim().replace(/^v/i, '');
    const v = versionLabel(STATE.version);
    setActions(true);
    syncSettingsProgress(100, true);
    const msg = v
      ? `${v} is ready. Tap Refresh when you want to switch — nothing happens until you do.`
      : 'Update is ready. Tap Refresh when you want to switch — nothing happens until you do.';
    syncSettingsStatus(msg, '#9fdab4');
    syncBanner(msg, 'ready', false, true);
    setChip(v ? `${v} ready` : 'Update ready', 'ready');
    const restartBtn = $('profileUpdateRestartBtn');
    if (restartBtn) {
      restartBtn.disabled = false;
      restartBtn.textContent = 'Refresh now';
    }
    const bannerRestart = $('utkUpdateBannerRestart');
    if (bannerRestart) {
      bannerRestart.disabled = false;
      bannerRestart.textContent = 'Refresh';
    }
  }

  function showError(message) {
    STATE.phase = 'error';
    setActions(false);
    syncSettingsProgress(STATE.percent, true);
    const msg = message && !/update failed/i.test(message)
      ? message
      : 'We could not download the update. Open Profile and try again.';
    syncSettingsStatus(msg, '#ff9a9a');
    syncBanner(msg, 'error', false, false);
    setChip('Update failed', 'error');
    const retryBtn = $('retryUpdateBtn');
    if (retryBtn) {
      retryBtn.style.display = 'inline-flex';
      retryBtn.disabled = false;
      retryBtn.textContent = 'Try again';
    }
  }

  function hide() {
    if (STATE.phase === 'ready') {
      setChip(versionLabel(STATE.version) ? `${versionLabel(STATE.version)} ready` : 'Update ready', 'ready');
      return;
    }
    setChip('');
    syncBanner('', 'idle', false, false);
  }

  async function restartNow() {
    const btn = $('profileUpdateRestartBtn');
    const bannerRestart = $('utkUpdateBannerRestart');

    if (STATE.phase === 'downloading' || STATE.phase === 'idle') {
      const msg = STATE.phase === 'downloading'
        ? 'Still downloading — Refresh unlocks when it hits 100%.'
        : 'No update ready yet. Tap Check for updates first.';
      syncSettingsStatus(msg, '#ffb347');
      syncBanner(msg, 'busy', STATE.phase === 'downloading', false);
      return;
    }

    if (STATE.phase === 'error') {
      try {
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Checking…';
        }
        await ipcRenderer.invoke('download-update');
      } catch (e) {
        showError((e && e.message) ? e.message : 'Download failed');
      }
      return;
    }

    if (STATE.phase !== 'ready') return;

    STATE.phase = 'installing';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Installing…';
    }
    if (bannerRestart) {
      bannerRestart.disabled = true;
      bannerRestart.textContent = 'Installing…';
    }
    const msg = 'Installing update… Utopia closes for a few seconds, then comes back on its own.';
    syncSettingsStatus(msg, '#9fdab4');
    syncBanner(msg, 'busy', false, false);
    setChip('Installing', 'busy');
    try {
      const res = await ipcRenderer.invoke('restart-app');
      if (res && res.success === false) {
        STATE.phase = 'ready';
        showError(res.error || 'Could not install the update.');
        setActions(true);
      }
    } catch (e) {
      STATE.phase = 'ready';
      showError((e && e.message) ? e.message : 'Could not install the update.');
      setActions(true);
    }
  }

  function wireButtons() {
    const restartBtn = $('profileUpdateRestartBtn');
    const laterBtn = $('profileUpdateLaterBtn');
    const chip = $('sidebarUpdateChip');
    if (restartBtn && !restartBtn.__utkWired) {
      restartBtn.__utkWired = true;
      restartBtn.addEventListener('click', () => { restartNow().catch(() => {}); });
    }
    if (laterBtn && !laterBtn.__utkWired) {
      laterBtn.__utkWired = true;
      laterBtn.addEventListener('click', () => {
        setActions(false);
        const v = versionLabel(STATE.version);
        const msg = v
          ? `${v} is ready whenever you are. Tap the chip or Profile → Refresh when you want it.`
          : 'Update ready whenever you are. Tap the chip or Profile → Refresh when you want it.';
        syncSettingsStatus(msg, '#9aa0a6');
        syncBanner('', 'idle', false, false);
        setChip(v ? `${v} ready` : 'Update ready', 'ready');
      });
    }
    if (chip && !chip.__utkWired) {
      chip.__utkWired = true;
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (STATE.phase === 'ready') {
          setActions(true);
          showReady(STATE.version);
          return;
        }
        openProfile();
      });
    }
  }

  function wireIpc() {
    if (window.__utk_update_ipc_wired) return;
    window.__utk_update_ipc_wired = true;

    ipcRenderer.on('update-available', (_event, version) => {
      const v = (version && typeof version === 'object') ? (version.version || '') : (version || '');
      showDownloading(v);
      try { ipcRenderer.invoke('download-update').catch(() => {}); } catch (e) {}
    });

    ipcRenderer.on('update-download-progress', (_event, progress) => {
      const percent = progress && typeof progress.percent === 'number' ? progress.percent : null;
      if (percent === null) return;
      showProgress(percent);
    });

    ipcRenderer.on('update-not-available', () => {
      if (STATE.phase === 'downloading') {
        STATE.phase = 'idle';
        setChip('');
        syncSettingsProgress(0, false);
        syncBanner('', 'idle', false, false);
      }
      syncSettingsStatus('You are on the latest version.', '#9fdab4');
      setTimeout(() => {
        if (STATE.phase === 'idle') syncSettingsStatus('', null);
      }, 4000);
    });

    ipcRenderer.on('update-error', (_event, payload) => {
      const msg = payload && payload.message ? payload.message : 'Update error';
      showError(msg.replace(/^Update error:\s*/i, ''));
    });

    ipcRenderer.on('update-downloaded', (_event, version) => {
      const v = (version && typeof version === 'object') ? (version.version || '') : (version || '');
      showReady(v);
    });
  }

  function setForcedUpdateModalVisible() {}

  function updateForcedUpdateModalUI(opts) {
    if (!opts) return;
    if (typeof opts.percent === 'number' && opts.percent >= 100 && /ready|restart/i.test(String(opts.message || ''))) {
      showReady(opts.version || STATE.version);
      return;
    }
    if (opts.message && /error/i.test(opts.message)) {
      showError(opts.message.replace(/^Update error:\s*/i, ''));
      return;
    }
    if (typeof opts.percent === 'number') showProgress(opts.percent);
    else showDownloading(opts.version || STATE.version);
  }

  function showUpdateModal(updateInfo) {
    if (!updateInfo || updateInfo.disabled || !updateInfo.hasUpdate) return;
    const latest = String(updateInfo.latestVersion || updateInfo.version || '').trim();
    showDownloading(latest);
    try { ipcRenderer.invoke('download-update').catch(() => {}); } catch (e) {}
  }

  function boot() {
    ensureBanner();
    try {
      const cur = $('profileAppVersion');
      if (cur && !cur.textContent.trim()) {
        const pkg = require('./package.json');
        cur.textContent = 'v' + String(pkg.version || '').replace(/^v/i, '');
      }
    } catch (e) {}
    wireButtons();
    wireIpc();
    // Keep Refresh locked until a real download finishes.
    setActions(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.__utkUpdateUi = {
    showDownloading,
    showProgress,
    showReady,
    showError,
    hide,
    showUpdateModal,
    setForcedUpdateModalVisible,
    updateForcedUpdateModalUI,
  };

  try {
    module.exports = window.__utkUpdateUi;
  } catch (e) {}
})();
