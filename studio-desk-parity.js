/**
 * studio-desk-parity.js — Custom bot desk matches house bots (SSID pill, empty state, autotrade hints).
 * Load AFTER studio-feed-desk.js and ssid-manager.js.
 */
(function () {
  'use strict';

  const SSID_ANCHOR = 'bot1';

  function ssidMgr() {
    try { return window.ssidManager || null; } catch (e) { return null; }
  }

  function sharedSsidOnline() {
    try {
      if (typeof window.isSharedSsidOnline === 'function') return !!window.isSharedSsidOnline();
    } catch (e) {}
    const mgr = ssidMgr();
    if (!mgr || !mgr.statusByBot) return false;
    const ids = ['bot1', 'bot2', 'bot3'];
    for (let i = 0; i < ids.length; i++) {
      const st = mgr.statusByBot[ids[i]];
      if (st && st.activeOnline && st.hasSsid && Number(st.balance) >= 0) return true;
    }
    return false;
  }

  function ssidHasSaved() {
    const mgr = ssidMgr();
    if (!mgr || !mgr.statusByBot) return false;
    return ['bot1', 'bot2', 'bot3'].some(function (id) {
      const st = mgr.statusByBot[id];
      return st && st.hasSsid;
    });
  }

  function studioAutotradeOn(house) {
    try {
      const toggle = house && house.querySelector('#studioAutoTrade');
      return !!(toggle && toggle.checked);
    } catch (e) { return false; }
  }

  function botIsLive(bot) {
    const st = String((bot && bot.status) || '').toLowerCase();
    return st === 'live' || st === 'armed';
  }

  function hasVisibleSignal(house) {
    if (!house) return false;
    const display = house.querySelector('#feedSignalDisplay');
    if (!display) return false;
    if (display.style.display === 'none') return false;
    return !!(display.querySelector('.signal-card') || (display.innerHTML && display.innerHTML.trim()));
  }

  function ensureSsidPill(house) {
    if (!house) return null;
    const headerRight = house.querySelector('.studio-feed-header-right')
      || house.querySelector('.section-header > div:last-child')
      || house.querySelector('.section-header');
    if (!headerRight) return null;
    let btn = headerRight.querySelector('.ssid-connect-pill[data-bot-id="studio"]');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ssid-connect-pill offline';
    btn.dataset.botId = 'studio';
    btn.title = 'Connect Pocket Option for autotrade';
    btn.innerHTML = '<span class="ssid-connect-dot"></span><span class="ssid-connect-text">Connect</span>';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      const mgr = ssidMgr();
      if (mgr && typeof mgr.requestOpenModal === 'function') {
        mgr.requestOpenModal(SSID_ANCHOR);
      }
    });

    const hist = headerRight.querySelector('#feedHistoryBtn');
    if (hist && hist.parentNode) {
      hist.parentNode.insertBefore(btn, hist.nextSibling);
    } else {
      headerRight.appendChild(btn);
    }
    return btn;
  }

  function updateSsidPill(house) {
    const btn = ensureSsidPill(house);
    if (!btn) return;
    const mgr = ssidMgr();
    const status = (mgr && mgr.statusByBot && mgr.statusByBot[SSID_ANCHOR])
      || (mgr && mgr.statusByBot && mgr.statusByBot.bot2)
      || (mgr && mgr.statusByBot && mgr.statusByBot.bot3)
      || null;
    if (mgr && typeof mgr.updateBotStatusUI === 'function') {
      const textEl = btn.querySelector('.ssid-connect-text');
      const online = !!(status && status.activeOnline && Number.isFinite(Number(status.balance)) && Number(status.balance) >= 0);
      const hasSsid = !!(status && status.hasSsid);
      const pillLabel = typeof mgr.formatPillLabel === 'function' ? mgr.formatPillLabel(status) : '';

      btn.classList.toggle('online', online);
      btn.classList.toggle('offline', !online && !hasSsid);
      btn.classList.toggle('saved', hasSsid && !online);

      if (online && pillLabel) {
        if (textEl) textEl.textContent = pillLabel;
        btn.title = pillLabel;
      } else if (hasSsid && typeof mgr.formatOfflinePillLabel === 'function') {
        const offline = mgr.formatOfflinePillLabel(status);
        if (textEl) textEl.textContent = offline.text;
        btn.title = offline.title;
      } else {
        if (textEl) textEl.textContent = 'Connect';
        btn.title = 'Link Pocket Option account';
      }
    }
  }

  function setReason(house, msg) {
    const el = house && house.querySelector('#studioAutotradeReason');
    if (!el) return;
    const text = String(msg || '').trim();
    if (text) {
      el.textContent = text;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  function setAtStatus(house, text) {
    const el = house && house.querySelector('#studioAtStatus');
    if (el && text) el.textContent = text;
  }

  function preparingWaitLine(sig) {
    return 'Waiting for signals...';
  }

  function wireStatsDate(house) {
    const btn = house && house.querySelector('#studioStatsDateBtn');
    const input = house && house.querySelector('#studioStatsDateInput');
    const todayBtn = house && house.querySelector('#studioStatsDateToday');
    if (!btn || !input || input.dataset.utkParityWired === '1') return;
    input.dataset.utkParityWired = '1';
    try {
      if (typeof formatLocalDateKey === 'function' && typeof formatStatsDateLabel === 'function') {
        const todayKey = formatLocalDateKey(Date.now());
        input.value = todayKey;
        input.max = todayKey;
        btn.textContent = formatStatsDateLabel(todayKey);
        if (todayBtn) todayBtn.classList.add('is-active');
      }
    } catch (e) {}
    const onOpen = function (ev) {
      try { ev && ev.preventDefault && ev.preventDefault(); } catch (e2) {}
      try {
        if (typeof openNativeDatePicker === 'function') openNativeDatePicker(input);
      } catch (e3) {}
    };
    btn.addEventListener('click', onOpen);
    try { btn.parentElement && btn.parentElement.addEventListener('click', onOpen); } catch (e4) {}
    input.addEventListener('change', function () {
      try {
        if (typeof formatStatsDateLabel === 'function') {
          btn.textContent = formatStatsDateLabel(input.value);
        }
      } catch (e5) {}
      if (todayBtn && typeof formatLocalDateKey === 'function') {
        todayBtn.classList.toggle('is-active', input.value === formatLocalDateKey(Date.now()));
      }
      try {
        if (window.__utkStudioDeskStats && typeof window.__utkStudioDeskStats.refreshHouseStats === 'function') {
          window.__utkStudioDeskStats.refreshHouseStats(house);
        }
      } catch (eStats) {}
    });
    if (todayBtn) {
      todayBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        try {
          const todayKey = formatLocalDateKey(Date.now());
          input.value = todayKey;
          btn.textContent = formatStatsDateLabel(todayKey);
          todayBtn.classList.add('is-active');
          if (window.__utkStudioDeskStats && typeof window.__utkStudioDeskStats.refreshHouseStats === 'function') {
            window.__utkStudioDeskStats.refreshHouseStats(house);
          }
        } catch (e6) {}
      });
    }
  }

  function wireSavingSignals(house) {
    if (!house) return;
    house.dataset.utkSavingWired = '0';
    const auto = house.querySelector('#studioAutoTrade');
    const enable = house.querySelector('#savingSignalEnabled-studio');
    const options = house.querySelector('#savingSignalOptions-studio');
    const container = enable && enable.closest('.form-group');
    if (!auto || !enable || !options) return;
    house.dataset.utkSavingWired = '1';
    if (!house.__utkSavingPref) house.__utkSavingPref = { on: !!enable.checked };
    const prefBackup = house.__utkSavingPref;
    const update = function () {
      const autoOn = auto.checked;
      if (container) container.style.display = autoOn ? 'block' : 'none';
      if (!autoOn) {
        if (enable.checked) prefBackup.on = true;
        enable.checked = false;
        options.style.display = 'none';
      } else {
        if (prefBackup.on && !enable.checked) {
          enable.checked = true;
          // Keep localStorage in sync — otherwise place() thinks Saving is off
          // and skips every S1–S4 while the UI checkbox looks ON.
          try { writeSavingViaFeed(house, true); } catch (eWrite) {}
        }
        options.style.display = enable.checked ? 'block' : 'none';
      }
    };
    update();
    auto.addEventListener('change', update);
    enable.addEventListener('change', function () {
      if (auto.checked) prefBackup.on = !!enable.checked;
      options.style.display = enable.checked ? 'block' : 'none';
      try { writeSavingViaFeed(house, enable.checked); } catch (e) {}
      try {
        if (typeof window.syncSavingSignalStakeToMain === 'function') {
          window.syncSavingSignalStakeToMain('STUDIO', '');
        } else if (window.syncSavingSignalStakeToMainSafe) {
          window.syncSavingSignalStakeToMainSafe('STUDIO', '');
        }
      } catch (e2) {}
    });
    try {
      if (typeof window.restoreSavingSignalMode === 'function') window.restoreSavingSignalMode('studio');
      if (window.__utkSavingLadder && typeof window.__utkSavingLadder.bindBot === 'function') {
        window.__utkSavingLadder.bindBot('studio');
      }
    } catch (e) {}
  }

  function writeSavingViaFeed(house, on) {
    try {
      const botId = house.getAttribute('data-follow-bot');
      if (!botId) return;
      const map = JSON.parse(localStorage.getItem('utk-feed-saving-on') || '{}');
      map[botId] = !!on;
      localStorage.setItem('utk-feed-saving-on', JSON.stringify(map));
    } catch (e) {}
  }

  function rewireSaving(house) {
    wireSavingSignals(house);
  }

  function refreshEmptyState(house, bot, signal) {
    if (!house || !bot) return;
    const empty = house.querySelector('#feedSignalEmpty');
    if (!empty) return;

    const textEl = empty.querySelector('[data-empty-text]') || empty.querySelector('p');
    const cta = house.querySelector('#feedConnectCta') || house.querySelector('#signalEmptyCta-studio');
    const live = botIsLive(bot);
    const showing = hasVisibleSignal(house);
    const autoOn = studioAutotradeOn(house);
    const ssidOn = sharedSsidOnline();

    let text = 'Waiting for signals...';
    let showCta = false;

    if (!live) {
      const st = String(bot.status || '').toLowerCase();
      if (st === 'checking') {
        text = 'Testing on past candles…';
      } else if (st === 'paused') {
        text = 'Paused. Go live to reconnect 24/7.';
      } else {
        text = 'Go live to start 24/7 scanning.';
      }
    } else if (autoOn && !ssidOn) {
      text = 'Connect Pocket Option to enable autotrade';
      showCta = true;
    } else {
      text = 'Waiting for signals...';
    }

    if (textEl) textEl.textContent = text;
    if (cta) cta.hidden = !showCta || showing;

    if (!showing) {
      empty.style.display = '';
      empty.classList.remove('utk-sig-hidden');
      const display = house.querySelector('#feedSignalDisplay');
      if (display && !display.querySelector('.signal-card')) {
        display.style.display = 'none';
      }
    } else {
      empty.style.display = 'none';
    }
  }

  function wireConnectCta(house) {
    const cta = house.querySelector('#feedConnectCta') || house.querySelector('#signalEmptyCta-studio');
    if (!cta || cta.dataset.utkParityWired === '1') return;
    cta.dataset.utkParityWired = '1';
    cta.addEventListener('click', function (ev) {
      ev.preventDefault();
      const mgr = ssidMgr();
      if (mgr && typeof mgr.requestOpenModal === 'function') {
        mgr.requestOpenModal(SSID_ANCHOR);
        return;
      }
      if (mgr && typeof mgr.openCollect === 'function') mgr.openCollect();
    });
  }

  function refreshAutotradeHints(house, bot, signal) {
    if (!house || !bot) return;
    const live = botIsLive(bot);
    const autoOn = studioAutotradeOn(house);
    const ssidOn = sharedSsidOnline();

    if (!live) {
      setAtStatus(house, 'Go live first');
      setReason(house, '');
      return;
    }

    if (autoOn && !ssidOn) {
      setAtStatus(house, 'Connect Pocket Option first');
      setReason(house, ssidHasSaved() ? 'SSID saved but offline. Reconnect to autotrade.' : 'Connect Pocket Option to autotrade.');
      return;
    }

    setAtStatus(house, autoOn ? 'Waiting for a signal' : 'Waiting for a signal');
    setReason(house, '');
  }

  function afterWire(root, bot, signal, opts) {
    opts = opts || {};
    if (opts.mode === 'feed') return;
    const house = (root && root.querySelector('.studio-feed-house')) || root;
    if (!house) return;

    ensureSsidPill(house);
    updateSsidPill(house);
    wireConnectCta(house);
    wireStatsDate(house);
    wireSavingSignals(house);
    refreshEmptyState(house, bot, signal);
    refreshAutotradeHints(house, bot, signal);

    const toggle = house.querySelector('#studioAutoTrade');
    if (toggle && toggle.dataset.utkParityWired !== '1') {
      toggle.dataset.utkParityWired = '1';
      toggle.addEventListener('change', function () {
        refreshEmptyState(house, bot, signal);
        refreshAutotradeHints(house, bot, signal);
      });
    }
  }

  function refreshAll() {
    document.querySelectorAll('.studio-desk-private .studio-feed-house, .studio-feed-house.studio-desk-private').forEach(function (house) {
      const botId = house.getAttribute('data-follow-bot');
      let bot = { id: botId, status: 'idle' };
      try {
        const meta = JSON.parse(house.getAttribute('data-feed-meta') || '{}');
        if (meta.status) bot.status = meta.status;
      } catch (e) {}
      try {
        const studio = window.__utkBotStudio;
        if (studio && typeof studio.selected === 'function') {
          const sel = studio.selected();
          if (sel && sel.id === botId) bot = sel;
        }
      } catch (e2) {}
      updateSsidPill(house);
      refreshEmptyState(house, bot);
      refreshAutotradeHints(house, bot);
    });
  }

  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('ssid-status-update', function () {
      setTimeout(refreshAll, 0);
    });
  } catch (e) {}

  window.__utkStudioDeskParity = {
    afterWire: afterWire,
    refresh: refreshAll,
    refreshEmptyState: refreshEmptyState,
    rewireSaving: rewireSaving
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(refreshAll, 400); });
  }
})();
