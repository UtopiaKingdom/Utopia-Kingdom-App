/**
 * exit-tray-modal.js — clean close vs keep-in-tray prompt
 * Uses class-driven keyframe animations (reliable in Electron).
 */
'use strict';

(function () {
  const { ipcRenderer } = require('electron');

  const OVERLAY_ID = 'utk-exit-overlay';
  const CLOSE_MS = 340;
  let closeTimer = null;
  let actionLock = false;

  function clearCloseTimer() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function hide(then) {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      if (typeof then === 'function') then();
      return;
    }

    clearCloseTimer();
    actionLock = true;
    overlay.classList.remove('is-open');
    overlay.classList.add('is-closing');
    document.body.classList.remove('modal-open');

    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      try {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      } catch (e) {}
      actionLock = false;
      if (typeof then === 'function') then();
    }, CLOSE_MS);
  }

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'utk-exit-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'utk-exit-title');
    overlay.innerHTML = `
      <div class="utk-exit-card" role="document">
        <button class="utk-exit-dismiss" type="button" aria-label="Cancel" data-exit-action="cancel">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3 3l8 8M11 3L3 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>

        <div class="utk-exit-copy">
          <h2 id="utk-exit-title">Leaving?</h2>
          <p>Keep Utopia Kingdom in the tray to stay connected — or quit completely.</p>
        </div>

        <div class="utk-exit-choices">
          <button type="button" class="utk-exit-choice is-preferred" data-exit-action="tray">
            <span class="utk-exit-choice-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <rect x="3" y="4" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.4"/>
                <path d="M7 16h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
              </svg>
            </span>
            <span class="utk-exit-choice-text">
              <strong>Keep in tray</strong>
              <small>Signals &amp; alerts keep running</small>
            </span>
            <span class="utk-exit-choice-tag">Recommended</span>
          </button>

          <button type="button" class="utk-exit-choice is-danger" data-exit-action="quit">
            <span class="utk-exit-choice-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 3.5v7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <path d="M5.5 7.2a5.5 5.5 0 1 0 9 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </span>
            <span class="utk-exit-choice-text">
              <strong>Quit completely</strong>
              <small>Stops the app and background work</small>
            </span>
          </button>
        </div>

        <button type="button" class="utk-exit-cancel" data-exit-action="cancel">Cancel</button>
      </div>
    `;

    overlay.addEventListener('click', (event) => {
      if (actionLock) return;
      if (event.target === overlay) hide();
    });

    overlay.addEventListener('click', (event) => {
      if (actionLock) return;
      const btn = event.target.closest('[data-exit-action]');
      if (!btn || !overlay.contains(btn)) return;
      const action = btn.getAttribute('data-exit-action');
      if (action === 'tray') {
        hide(() => {
          try { ipcRenderer.send('window-hide'); } catch (e) {}
        });
      } else if (action === 'quit') {
        hide(() => {
          try { ipcRenderer.send('window-quit'); } catch (e) {}
        });
      } else {
        hide();
      }
    });

    return overlay;
  }

  function show() {
    clearCloseTimer();
    actionLock = false;

    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      try { overlay.remove(); } catch (e) {}
      overlay = null;
    }

    overlay = buildOverlay();
    document.body.appendChild(overlay);

    // Double rAF so the browser paints the pre-open state first
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(OVERLAY_ID);
        if (!el) return;
        el.classList.add('is-open');
        document.body.classList.add('modal-open');
        const preferred = el.querySelector('.utk-exit-choice.is-preferred');
        try { preferred && preferred.focus(); } catch (e) {}
      });
    });
  }

  window.addEventListener('keydown', (event) => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || !overlay.classList.contains('is-open') || overlay.classList.contains('is-closing')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
    }
  });

  window.showCloseTrayModal = show;

  try {
    module.exports = { show: show, hide: hide };
  } catch (e) {}
})();
