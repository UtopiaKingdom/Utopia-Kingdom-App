/**
 * signal-notifications.js — Bell menu for bot signal notifications.
 * Respects subscription (free users: today's house bot only; studio: paid only).
 * Polls autotraded custom/Feed bots in the background.
 */
(function () {
  'use strict';

  const PREFS_KEY = 'utk-signal-notify-v1';
  const STUDIO_META_KEY = 'utk-notify-studio-meta';
  const STUDIO_AT_ON = 'utk-studio-at-on';
  const POLL_MS = 1400;

  function notifyPollMs() {
    try {
      if (window.__utkAppSmooth && typeof window.__utkAppSmooth.notifyPollMs === 'function') {
        return window.__utkAppSmooth.notifyPollMs();
      }
    } catch (e) {}
    try {
      if (document.hidden || document.visibilityState === 'hidden') return 3200;
    } catch (e2) {}
    return POLL_MS;
  }

  const HOUSE_BOTS = [
    { key: 'LUMIX', id: 'bot1', label: 'LUMIX' },
    { key: 'MIRAX', id: 'bot2', label: 'MIRAX' },
    { key: 'NYX', id: 'bot3', label: 'NYX' }
  ];

  let menuOpen = false;
  let pollTimer = null;
  const lastHouseNotifyKey = { LUMIX: '', MIRAX: '', NYX: '' };
  const lastStudioSignalId = Object.create(null);

  function defaultPrefs() {
    const house = {};
    HOUSE_BOTS.forEach(function (b) { house[b.key] = true; });
    return { enabled: true, mode: 'all', house: house, studio: {} };
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return defaultPrefs();
      const o = JSON.parse(raw);
      const base = defaultPrefs();
      return {
        enabled: o.enabled !== false,
        mode: o.mode === 'pick' ? 'pick' : 'all',
        house: Object.assign({}, base.house, o.house || {}),
        studio: Object.assign({}, o.studio || {})
      };
    } catch (e) {
      return defaultPrefs();
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {}
  }

  let prefs = loadPrefs();

  function readStudioMetaMap() {
    try {
      return JSON.parse(localStorage.getItem(STUDIO_META_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function writeStudioMetaMap(map) {
    try {
      localStorage.setItem(STUDIO_META_KEY, JSON.stringify(map || {}));
    } catch (e) {}
  }

  function readStudioAutotradeOn() {
    try {
      return JSON.parse(localStorage.getItem(STUDIO_AT_ON) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function studioAutotradeIds() {
    const on = readStudioAutotradeOn();
    return Object.keys(on).filter(function (id) { return !!on[id]; });
  }

  function hubApi() {
    try {
      const h = window.__utkCommunityHub;
      return h && typeof h.api === 'function' ? h.api.bind(h) : null;
    } catch (e) {
      return null;
    }
  }

  function isSubscriptionPayScreenVisible() {
    try {
      const overlay = document.getElementById('subscription-overlay');
      if (!overlay) return false;
      return overlay.classList.contains('active') || overlay.style.display === 'flex';
    } catch (e) {
      return false;
    }
  }

  function isPaid() {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.isPaid === 'function') {
        return !!window.__utkAccessGate.isPaid();
      }
    } catch (e) {}
    try {
      if (typeof window.hasActiveAppAccess === 'function') return !!window.hasActiveAppAccess();
    } catch (e2) {}
    return false;
  }

  function canAccessHouseBot(botKey) {
    const key = String(botKey || '').toUpperCase();
    const row = HOUSE_BOTS.find(function (b) { return b.key === key; });
    if (!row) return false;
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.canOpenHouseBot === 'function') {
        return !!window.__utkAccessGate.canOpenHouseBot(row.id);
      }
    } catch (e) {}
    return isPaid();
  }

  function canAccessStudio() {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.canOpenStudio === 'function') {
        return !!window.__utkAccessGate.canOpenStudio();
      }
    } catch (e) {}
    return isPaid();
  }

  function freeBotLabel() {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.freeBotName === 'function') {
        return window.__utkAccessGate.freeBotName();
      }
    } catch (e) {}
    return "today's free bot";
  }

  function prefsAllowHouse(botKey) {
    if (!prefs.enabled) return false;
    if (isSubscriptionPayScreenVisible()) return false;
    if (!canAccessHouseBot(botKey)) return false;
    if (prefs.mode === 'all') return true;
    return !!prefs.house[String(botKey || '').toUpperCase()];
  }

  function prefsAllowStudio(botId) {
    if (!prefs.enabled) return false;
    if (isSubscriptionPayScreenVisible()) return false;
    if (!canAccessStudio()) return false;
    const id = String(botId || '');
    if (!id) return false;
    // Explicit per-bot toggle (desk Alerts switch)
    if (prefs.studio[id] === false) return false;
    if (prefs.studio[id] === true) return true;
    // Legacy / unset: allow if registered in meta or autotrade is on
    if (readStudioMetaMap()[id]) return true;
    return !!readStudioAutotradeOn()[id];
  }

  function isStudioNotifyOn(botId) {
    const id = String(botId || '');
    if (!id) return false;
    // UI toggle state only — do not gate on master/subscription (that gates delivery).
    if (prefs.studio[id] === false) return false;
    if (prefs.studio[id] === true) return true;
    return !!readStudioMetaMap()[id] || !!readStudioAutotradeOn()[id];
  }

  function setStudioNotifyOn(botId, on, meta) {
    const id = String(botId || '');
    if (!id) return false;
    prefs.studio[id] = !!on;
    savePrefs(prefs);
    if (on) {
      registerStudioBot(id, (meta && meta.name) || undefined, { feed: !!(meta && meta.feed) });
    } else {
      syncPollTimer();
      renderMenu();
    }
    return !!on;
  }

  function studioWatchIds() {
    const ids = Object.create(null);
    const meta = readStudioMetaMap();
    Object.keys(meta).forEach(function (id) { ids[id] = true; });
    const at = readStudioAutotradeOn();
    Object.keys(at).forEach(function (id) {
      if (at[id]) ids[id] = true;
    });
    Object.keys(prefs.studio || {}).forEach(function (id) {
      if (prefs.studio[id] === true) ids[id] = true;
    });
    return Object.keys(ids);
  }

  function normalizeSide(signal) {
    const raw = signal && (signal.side || signal.action || '');
    const s = String(raw || '').trim().toUpperCase();
    if (s === 'CALL' || s === 'BUY' || s === 'UP') return 'CALL';
    if (s === 'PUT' || s === 'SELL' || s === 'DOWN') return 'PUT';
    return s || '';
  }

  function resolvePair(signal) {
    try {
      if (typeof window.resolveCurrency === 'function') {
        return window.resolveCurrency(signal) || '';
      }
    } catch (e) {}
    const raw = signal && (signal.pair || signal.symbol || signal.currency || signal.selectedCurrency || '');
    return String(raw || '').trim();
  }

  function readToastTheme() {
    try {
      const s = getComputedStyle(document.body);
      return {
        accent: (s.getPropertyValue('--accent-primary') || '').trim(),
        accentRgb: (s.getPropertyValue('--accent-rgb') || '').trim()
      };
    } catch (e) {
      return {};
    }
  }

  function showOsNotification(payload) {
    try {
      const { ipcRenderer } = require('electron');
      const theme = readToastTheme();
      let sound = payload && payload.sound;
      try {
        if (!sound && window.__utkMarksSound === 'chime') sound = 'chime';
        if (!sound && window.utkMarks && typeof window.utkMarks.has === 'function' && window.utkMarks.has('signal-chime')) {
          sound = 'chime';
        }
      } catch (e) {}
      ipcRenderer.invoke('show-notification', Object.assign({}, theme, payload, {
        sound: sound || undefined,
        autoCloseMs: payload && payload.autoCloseMs ? payload.autoCloseMs : 5200
      })).catch(function () {});
    } catch (e) {}
  }

  function resetHouseDedupe(botKey) {
    const k = String(botKey || '').toUpperCase();
    if (lastHouseNotifyKey[k] !== undefined) lastHouseNotifyKey[k] = '';
  }

  function isChainStartSignal(signal) {
    // Only alert on fresh ENTRY / 1x — not S1–S4 martingale steps.
    const attempt = Number(signal && signal.attempt);
    if (Number.isFinite(attempt) && attempt > 1) return false;
    const realLossStreak = Number(
      signal && (signal.realLossStreak ?? signal.real_loss_streak)
    );
    if (Number.isFinite(realLossStreak) && realLossStreak > 0) return false;
    try {
      if (typeof window.isChainRetrySignal === 'function' && window.isChainRetrySignal(signal)) {
        return false;
      }
    } catch (e) {}
    return true;
  }

  function showHouseSignal(botKey, signal) {
    const key = String(botKey || '').toUpperCase();
    if (!prefsAllowHouse(key)) return;
    if (!isChainStartSignal(signal)) return;

    const currency = resolvePair(signal);
    const side = normalizeSide(signal);
    const notifyKey = String(
      (signal && (signal.signalId || signal.openedAtMs)) ||
      (currency + '|' + side + '|' + ((signal && signal.openingTime) || ''))
    ).trim();
    if (notifyKey && lastHouseNotifyKey[key] === notifyKey) return;
    lastHouseNotifyKey[key] = notifyKey || (key + ':' + Date.now());

    const parts = [];
    if (side) parts.push(side);
    if (currency) parts.push(currency);
    const body = parts.length ? (parts.join(' · ') + ' · 1x entry') : 'Fresh 1x chain';

    // Custom desktop toast — no duplicate green in-app toast.
    showOsNotification({
      title: key + ' opened a chain',
      body: body,
      botName: key,
      currency: currency || undefined,
      side: side || undefined,
      playSound: true
    });
  }

  function showStudioSignal(botId, botName, signal) {
    if (!prefsAllowStudio(botId)) return;
    if (!isChainStartSignal(signal)) return;

    const sid = String((signal && signal.signalId) || '').trim();
    if (sid && lastStudioSignalId[botId] === sid) return;
    if (sid) lastStudioSignalId[botId] = sid;

    const currency = resolvePair(signal);
    const side = normalizeSide(signal);
    const parts = [];
    if (side) parts.push(side);
    if (currency) parts.push(currency);
    const name = String(botName || 'Custom bot').trim();
    const body = parts.length ? (parts.join(' · ') + ' · 1x entry') : 'Fresh 1x chain';

    showOsNotification({
      title: name + ' opened a chain',
      body: body,
      botName: name,
      studioId: botId,
      currency: currency || undefined,
      side: side || undefined,
      playSound: true
    });
  }

  function registerStudioBot(botId, botName, opts) {
    opts = opts || {};
    if (!botId) return;
    const map = readStudioMetaMap();
    map[botId] = {
      name: String(botName || map[botId]?.name || 'Custom bot'),
      feed: !!opts.feed,
      updatedAt: Date.now()
    };
    writeStudioMetaMap(map);
    if (prefs.studio[botId] === undefined) {
      prefs.studio[botId] = true;
      savePrefs(prefs);
    }
    syncPollTimer();
    renderMenu();
  }

  function unregisterStudioBot(botId) {
    if (!botId) return;
    delete lastStudioSignalId[botId];
    syncPollTimer();
    renderMenu();
  }

  async function pollStudioBot(botId, meta) {
    const api = hubApi();
    if (!api || !prefsAllowStudio(botId)) return;

    const path = (meta && meta.feed)
      ? '/studio/global/desk?id=' + encodeURIComponent(botId)
      : '/studio/desk?id=' + encodeURIComponent(botId);

    try {
      const data = await api('GET', path);
      const sig = data && data.signal;
      if (!sig) return;
      const phase = String(sig.phase || '').toLowerCase();
      if (phase !== 'signal' && phase !== 'trading') return;
      const sid = String(sig.signalId || '').trim();
      if (!sid || lastStudioSignalId[botId] === sid) return;

      const bot = (data && data.bot) || meta || {};
      showStudioSignal(botId, bot.name || meta.name, sig);

      try {
        if (window.__utkStudioAutotrade && typeof window.__utkStudioAutotrade.tryPlace === 'function') {
          window.__utkStudioAutotrade.tryPlace(bot, sig, { feed: !!(meta && meta.feed) });
        }
      } catch (e) {}
    } catch (e) {}
  }

  async function pollAllStudio() {
    if (!prefs.enabled || !canAccessStudio()) return;
    const ids = studioWatchIds();
    if (!ids.length) return;
    const metaMap = readStudioMetaMap();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!prefsAllowStudio(id)) continue;
      const meta = metaMap[id] || { name: 'Custom bot', feed: /^g_/.test(id) };
      await pollStudioBot(id, meta);
    }
  }

  function syncPollTimer() {
    const shouldRun = prefs.enabled && canAccessStudio() && studioWatchIds().some(function (id) {
      return prefsAllowStudio(id);
    });
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (shouldRun) {
      const ms = notifyPollMs();
      pollTimer = setInterval(function () { pollAllStudio().catch(function () {}); }, ms);
      pollAllStudio().catch(function () {});
    }
  }

  function updateBellState() {
    const btn = document.getElementById('openNotifyBtn');
    if (!btn) return;
    btn.classList.toggle('is-active', !!prefs.enabled);
    btn.setAttribute('aria-pressed', prefs.enabled ? 'true' : 'false');
    btn.title = prefs.enabled ? 'Signal notifications on' : 'Signal notifications off';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateMenuChrome() {
    const menu = document.getElementById('notifyMenu');
    const scope = document.getElementById('notifyScope');
    const pickBlock = document.getElementById('notifyPickBlock');
    const modeAll = document.getElementById('notifyModeAll');
    const modePick = document.getElementById('notifyModePick');
    const master = document.getElementById('notifyMasterToggle');
    const on = !!prefs.enabled;

    if (menu) menu.classList.toggle('is-off', !on);
    if (scope) scope.setAttribute('aria-disabled', on ? 'false' : 'true');
    if (master) master.checked = on;
    if (modeAll) {
      modeAll.checked = prefs.mode === 'all';
      modeAll.disabled = !on;
    }
    if (modePick) {
      modePick.checked = prefs.mode === 'pick';
      modePick.disabled = !on;
    }
    if (pickBlock) {
      pickBlock.classList.toggle('is-open', on && prefs.mode === 'pick');
    }
    updateBellState();
  }

  function renderMenu() {
    const houseRoot = document.getElementById('notifyHouseList');
    const studioRoot = document.getElementById('notifyStudioList');
    const studioSection = document.getElementById('notifyStudioSection');
    const master = document.getElementById('notifyMasterToggle');
    const modeAll = document.getElementById('notifyModeAll');
    const modePick = document.getElementById('notifyModePick');
    const pickBlock = document.getElementById('notifyPickBlock');
    if (!houseRoot) return;

    const paid = isPaid();
    houseRoot.innerHTML = HOUSE_BOTS.map(function (b) {
      const allowed = canAccessHouseBot(b.key);
      const locked = !allowed;
      const disabled = !prefs.enabled;
      const checked = !!prefs.house[b.key];
      const lockNote = locked
        ? (' title="Subscribe to unlock ' + esc(b.label) + '. Free today: ' + esc(freeBotLabel()) + '"')
        : '';
      return (
        '<label class="notify-bot-row' + (locked || disabled ? ' is-locked' : '') + '"' + lockNote + '>' +
          '<input type="checkbox" data-notify-house="' + esc(b.key) + '"' +
            (checked ? ' checked' : '') +
            ((locked || disabled) ? ' disabled' : '') + ' />' +
          '<span class="notify-bot-name">' + esc(b.label) + '</span>' +
          (locked ? '<span class="notify-bot-lock">Locked</span>' : '') +
        '</label>'
      );
    }).join('');

    const studioIds = studioWatchIds();
    const metaMap = readStudioMetaMap();
    const atMap = readStudioAutotradeOn();
    if (studioSection) studioSection.hidden = !studioIds.length;
    if (studioRoot) {
      if (!studioIds.length) {
        studioRoot.innerHTML = '';
      } else if (!canAccessStudio()) {
        studioRoot.innerHTML = '<p class="notify-studio-note">Studio bots need a subscription.</p>';
      } else {
        studioRoot.innerHTML = studioIds.map(function (id) {
          const meta = metaMap[id] || {};
          const name = meta.name || 'Custom bot';
          const checked = isStudioNotifyOn(id);
          const disabled = !prefs.enabled;
          const tag = atMap[id] ? 'Autotrade' : 'Alerts';
          return (
            '<label class="notify-bot-row notify-bot-row-studio' + (disabled ? ' is-locked' : '') + '">' +
              '<input type="checkbox" data-notify-studio="' + esc(id) + '"' +
                (checked ? ' checked' : '') +
                (disabled ? ' disabled' : '') + ' />' +
              '<span class="notify-bot-name">' + esc(name) + '</span>' +
              '<span class="notify-bot-tag">' + esc(tag) + '</span>' +
            '</label>'
          );
        }).join('');
      }
    }

    if (!paid) {
      const subNote = document.getElementById('notifySubNote');
      if (subNote) {
        subNote.textContent = 'Wanderer: notifications only from ' + freeBotLabel() + '. Subscribe for all house bots + Studio.';
        subNote.hidden = false;
      }
    } else {
      const subNote = document.getElementById('notifySubNote');
      if (subNote) subNote.hidden = true;
    }

    updateMenuChrome();
  }

  function closeMenu() {
    const menu = document.getElementById('notifyMenu');
    if (menu) menu.classList.remove('show');
    menuOpen = false;
  }

  function openMenu() {
    const menu = document.getElementById('notifyMenu');
    const themeMenu = document.getElementById('themeMenu');
    if (themeMenu) themeMenu.classList.remove('show');
    if (menu) menu.classList.add('show');
    menuOpen = true;
    renderMenu();
  }

  function bootstrapStudioFromStorage() {
    const on = readStudioAutotradeOn();
    const meta = readStudioMetaMap();
    let changed = false;
    Object.keys(on).forEach(function (id) {
      if (!on[id]) return;
      if (!meta[id]) {
        meta[id] = { name: 'Custom bot', feed: true, updatedAt: Date.now() };
        changed = true;
      }
      if (prefs.studio[id] === undefined) {
        prefs.studio[id] = true;
        changed = true;
      }
    });
    if (changed) {
      writeStudioMetaMap(meta);
      savePrefs(prefs);
    }
  }

  function bindUi() {
    const openBtn = document.getElementById('openNotifyBtn');
    const menu = document.getElementById('notifyMenu');
    const themeBtn = document.getElementById('openThemeBtn');
    if (!openBtn || !menu) return;

    openBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menuOpen) closeMenu();
      else openMenu();
    });

    if (themeBtn) {
      themeBtn.addEventListener('click', function () { closeMenu(); });
    }

    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target) && !openBtn.contains(e.target)) {
        closeMenu();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuOpen) {
        closeMenu();
        openBtn.focus();
      }
    });

    menu.addEventListener('click', function (e) {
      const preview = e.target && e.target.closest ? e.target.closest('#notifyPreviewBtn') : null;
      if (!preview) return;
      e.preventDefault();
      e.stopPropagation();
      showOsNotification({
        title: 'LUMIX started a trade',
        body: 'CALL • EURUSD-OTC',
        botName: 'LUMIX',
        currency: 'EURUSD-OTC',
        side: 'CALL',
        playSound: true,
        autoCloseMs: 5200
      });
    });

    menu.addEventListener('change', function (e) {
      const t = e.target;
      if (!t || !t.getAttribute) return;

      if (t.id === 'notifyMasterToggle') {
        prefs.enabled = !!t.checked;
        savePrefs(prefs);
        syncPollTimer();
        renderMenu();
        return;
      }

      if (t.name === 'notifyMode') {
        prefs.mode = t.value === 'pick' ? 'pick' : 'all';
        savePrefs(prefs);
        renderMenu();
        syncPollTimer();
        return;
      }

      const houseKey = t.getAttribute('data-notify-house');
      if (houseKey) {
        prefs.house[String(houseKey).toUpperCase()] = !!t.checked;
        savePrefs(prefs);
        return;
      }

      const studioId = t.getAttribute('data-notify-studio');
      if (studioId) {
        setStudioNotifyOn(studioId, !!t.checked, readStudioMetaMap()[studioId] || {});
      }
    });

    try {
      const pill = document.getElementById('subscriptionPill');
      if (pill && typeof MutationObserver !== 'undefined') {
        const obs = new MutationObserver(function () {
          renderMenu();
          syncPollTimer();
        });
        obs.observe(pill, { childList: true, characterData: true, subtree: true });
      }
    } catch (e) {}

    updateBellState();
    bootstrapStudioFromStorage();
    renderMenu();
    syncPollTimer();
  }

  window.__utkSignalNotify = {
    canNotifyHouseBot: prefsAllowHouse,
    showHouseSignal: showHouseSignal,
    resetHouseDedupe: resetHouseDedupe,
    registerStudioBot: registerStudioBot,
    unregisterStudioBot: unregisterStudioBot,
    refreshMenu: renderMenu,
    syncPollTimer: syncPollTimer,
    showStudioSignal: showStudioSignal,
    isStudioNotifyOn: isStudioNotifyOn,
    setStudioNotifyOn: setStudioNotifyOn,
    noteStudioSignalSeen: function (botId, signalId) {
      if (botId && signalId) lastStudioSignalId[botId] = String(signalId);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUi);
  } else {
    bindUi();
  }
})();
