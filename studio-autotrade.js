/**
 * studio-autotrade.js — Autotrade for Live Studio bots only.
 * Uses the same Pocket Option fast path as official bots.
 * Load AFTER bot-studio-desk.js.
 */
(function () {
  'use strict';

  const BET_KEY = 'utk-studio-bet';
  const ON_KEY = 'utk-studio-at-on';
  const lastSent = Object.create(null);
  let boundRoot = null;
  let boundOpts = null;
  let boundBot = null;

  function toast(msg, tone) {
    try {
      if (typeof window.showAppToast === 'function') {
        window.showAppToast(msg, { tone: tone || 'info' });
      }
    } catch (e) {}
  }

  function readOn(botId) {
    try {
      const map = JSON.parse(localStorage.getItem(ON_KEY) || '{}');
      return !!map[botId];
    } catch (e) {
      return false;
    }
  }

  function writeOn(botId, on) {
    try {
      const map = JSON.parse(localStorage.getItem(ON_KEY) || '{}');
      map[botId] = !!on;
      localStorage.setItem(ON_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function readBet(botId) {
    try {
      const map = JSON.parse(localStorage.getItem(BET_KEY) || '{}');
      const n = Number(map[botId]);
      return n > 0 ? n : 10;
    } catch (e) {
      return 10;
    }
  }

  function writeBet(botId, amount) {
    try {
      const map = JSON.parse(localStorage.getItem(BET_KEY) || '{}');
      map[botId] = Math.max(1, Number(amount) || 10);
      localStorage.setItem(BET_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function setStatus(text, root) {
    const scope = root || boundRoot || document;
    const el = (scope.querySelector && scope.querySelector('#studioAtStatus'))
      || document.getElementById('studioAtStatus');
    if (el) el.textContent = text || '';
  }

  /** Prefer bot1 (desk Connect anchor), else first live SSID. */
  function resolveDonorBotId() {
    try {
      const mgr = window.ssidManager;
      if (!mgr || !mgr.statusByBot) return null;
      const ids = ['bot1', 'bot2', 'bot3'];
      for (let i = 0; i < ids.length; i++) {
        const st = mgr.statusByBot[ids[i]];
        if (st && !st.expired && st.hasSsid) return ids[i];
      }
    } catch (e) {}
    return null;
  }

  function ssidReady() {
    return !!resolveDonorBotId();
  }

  function placeDuration(signal, bot) {
    try {
      const api = window.__utkTradeDuration;
      if (api && typeof api.snapPoPlaceDuration === 'function') {
        let duration = Number(signal.duration || 0);
        if (!(duration > 0)) {
          const exp = String(signal.expiry || (bot && bot.expiry) || '1m').toLowerCase();
          if (exp === '30s') duration = 30;
          else if (exp === '2m') duration = 120;
          else if (exp === '3m') duration = 180;
          else if (exp === '5m') duration = 300;
          else duration = 60;
        }
        const opened = Number(signal.openedAtMs || signal.sentAtMs || 0);
        if (opened > 0 && typeof api.resolveLivePlaceDurationSec === 'function') {
          return api.resolveLivePlaceDurationSec('studio', Object.assign({}, signal, { duration: duration }), duration);
        }
        return api.snapPoPlaceDuration(duration);
      }
    } catch (e) {}
    let duration = Number(signal.duration || 0);
    if (!(duration > 0)) {
      const exp = String(signal.expiry || '1m').toLowerCase();
      if (exp === '30s') duration = 30;
      else if (exp === '2m') duration = 120;
      else if (exp === '3m') duration = 180;
      else if (exp === '5m') duration = 300;
      else duration = 60;
    }
    return Math.max(5, Math.round(duration));
  }

  function studioSavingOn(bot, opts) {
    opts = opts || {};
    try {
      const el = document.getElementById('savingSignalEnabled-studio');
      if (el) return !!el.checked;
    } catch (e) {}
    if (typeof opts.savingOn === 'function') {
      try { return !!opts.savingOn(); } catch (e2) {}
    }
    try {
      if (typeof window.isSavingSignalsEnabled === 'function') {
        return !!window.isSavingSignalsEnabled('STUDIO') || !!window.isSavingSignalsEnabled('studio');
      }
    } catch (e3) {}
    return false;
  }

  function resolveStudioLadder(bot, opts) {
    opts = opts || {};
    // Prefer the Saving Signals UI strategy (2x / 4x / custom).
    try {
      if (window.getSavingSignalLadder) {
        const ui = window.getSavingSignalLadder('studio') || window.getSavingSignalLadder('STUDIO');
        if (Array.isArray(ui) && ui.length >= 5) return ui.slice(0, 5);
      }
    } catch (e) {}
    try {
      if (window.__utkSavingLadder && typeof window.__utkSavingLadder.getLadder === 'function') {
        const ui = window.__utkSavingLadder.getLadder('studio');
        if (Array.isArray(ui) && ui.length >= 5) return ui.slice(0, 5);
      }
    } catch (e2) {}
    if (Array.isArray(opts.ladder) && opts.ladder.length >= 1) {
      const pad = opts.ladder.slice();
      while (pad.length < 5) pad.push(pad[pad.length - 1] || 1);
      return pad.slice(0, 5);
    }
    if (Array.isArray(bot && bot.ladder) && bot.ladder.length >= 1) {
      const pad = bot.ladder.slice();
      while (pad.length < 5) pad.push(pad[pad.length - 1] || 1);
      return pad.slice(0, 5);
    }
    return [1, 2, 4, 10, 20];
  }

  function place(bot, signal, amount, opts) {
    if (!bot || !signal) return false;
    opts = opts || {};
    const sid = String(signal.signalId || '');
    if (!sid) return false;
    if (lastSent[sid]) return false;
    const opened = Number(signal.openedAtMs || 0);
    if (opened && Date.now() - opened > 45000) {
      setStatus('Signal too old to autotrade');
      return false;
    }
    const phase = String(signal.phase || 'signal').toLowerCase();
    if (phase === 'result' || phase === 'preparing') {
      return false;
    }
    if (!ssidReady()) {
      setStatus('Connect Pocket Option first');
      return false;
    }

    // Desktop notify is handled by desk / notify poll — not here (was double-firing).
    const attempt = Number(signal.attempt || 1);
    const maxAttempts = Math.max(
      1,
      Math.min(5, Math.round(Number((bot && bot.maxAttempts) || (signal && signal.maxAttempts) || 5)) || 5)
    );
    const savingOn = studioSavingOn(bot, opts);
    // Bot recipe "up to N tries" always places same-pair recovery steps when
    // autotrade is on. Saving toggle only controls stake multiplier, not whether
    // steps 2..N are skipped (that looked like chains dying at 4).
    if (attempt > maxAttempts) {
      setStatus('Past max tries for this bot');
      return false;
    }
    const ladder = savingOn
      ? resolveStudioLadder(bot, opts)
      : [1, 1, 1, 1, 1];
    const mult = ladder[Math.min(4, Math.max(0, attempt - 1))] || 1;
    const stake = Math.max(1, Number(amount) * mult);
    const side = String(signal.side || signal.action || '').toUpperCase();
    const currency = String(signal.pair || signal.symbol || '').replace(/\s+OTC$/i, ' OTC');
    const duration = placeDuration(signal, bot);
    const donor = resolveDonorBotId() || 'bot1';
    const payoutMin = Math.max(
      90,
      Math.min(92, Math.round(Number((bot && bot.payoutMin) || (signal && signal.payout) || 92)) || 92)
    );
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('fast-pocket-option-trade', {
        botId: 'studio',
        studioTrade: true,
        donorBotId: donor,
        side: side,
        currency: currency,
        amount: stake,
        duration: duration,
        signalAtMs: opened || Date.now(),
        signalId: sid,
        attempt: attempt,
        minPayout: payoutMin
      });
      lastSent[sid] = Date.now();
      const modeLabel = (function () {
        try {
          if (window.__utkSavingLadder && typeof window.__utkSavingLadder.getMode === 'function') {
            return window.__utkSavingLadder.getMode('studio') || '';
          }
        } catch (e) {}
        return '';
      })();
      setStatus(
        'Sent ' + side + ' ' + currency + ', stake ' + stake +
        (attempt > 1 ? ' (x' + mult + (modeLabel ? ' ' + modeLabel : '') + ')' : '')
      );
      return true;
    } catch (e) {
      setStatus('Could not send trade');
      return false;
    }
  }

  function setWatch(root, on, text) {
    const scope = root || boundRoot || document;
    const wrap = scope.querySelector && scope.querySelector('.autotrade-watch');
    if (!wrap) return;
    wrap.setAttribute('data-state', on ? 'watch' : 'off');
    const dot = wrap.querySelector('.autotrade-watch-dot');
    const txt = wrap.querySelector('.autotrade-watch-text');
    if (dot) dot.classList.toggle('is-on', !!on);
    if (txt) txt.textContent = text || '';
  }

  function bind(root, bot, signal, opts) {
    if (!root || !bot) return;
    boundRoot = root;
    boundBot = bot;
    boundOpts = opts || {};
    opts = boundOpts;
    const follow = !!opts.follow;
    const toggle = root.querySelector('#studioAutoTrade');
    const bet = root.querySelector('#studioBetSize');
    const half = root.querySelector('#studioBetHalf');
    const dbl = root.querySelector('#studioBetDouble');
    if (bet) {
      bet.value = String(readBet(bot.id));
      bet.onchange = function () {
        writeBet(bot.id, bet.value);
      };
    }
    if (half && bet) {
      half.onclick = function (ev) {
        ev.preventDefault();
        const n = Math.max(1, Math.floor(Number(bet.value || 10) / 2));
        bet.value = String(n);
        writeBet(bot.id, n);
      };
    }
    if (dbl && bet) {
      dbl.onclick = function (ev) {
        ev.preventDefault();
        const n = Math.max(1, Math.floor(Number(bet.value || 10) * 2));
        bet.value = String(n);
        writeBet(bot.id, n);
      };
    }
    const st = String(bot.status || '').toLowerCase();
    const live = st === 'live' || st === 'armed';
    if (live) {
      setWatch(root, false, '');
    } else {
      setWatch(root, false, '');
    }

    if (toggle) {
      toggle.checked = readOn(bot.id);
      toggle.onchange = function () {
        const stNow = String(bot.status || '').toLowerCase();
        const liveNow = stNow === 'live' || stNow === 'armed';
        if (toggle.checked && !liveNow) {
          toggle.checked = false;
          toast(follow ? 'This Feed bot is not live.' : 'Go live before turning autotrade on.', 'info');
          return;
        }
        if (toggle.checked && !ssidReady()) {
          toggle.checked = false;
          toast('Connect Pocket Option first.', 'info');
          try {
            if (window.ssidManager && typeof window.ssidManager.requestOpenModal === 'function') {
              window.ssidManager.requestOpenModal('bot1');
            }
          } catch (eOpen) {}
          return;
        }
        writeOn(bot.id, toggle.checked);
        setStatus(toggle.checked ? 'Waiting for a signal' : 'Off', root);
        try {
          if (window.__utkSignalNotify) {
            if (toggle.checked && typeof window.__utkSignalNotify.registerStudioBot === 'function') {
              window.__utkSignalNotify.registerStudioBot(bot.id, bot.name, { feed: follow });
            } else if (!toggle.checked && typeof window.__utkSignalNotify.unregisterStudioBot === 'function') {
              window.__utkSignalNotify.unregisterStudioBot(bot.id);
            }
            if (typeof window.__utkSignalNotify.syncPollTimer === 'function') {
              window.__utkSignalNotify.syncPollTimer();
            }
          }
        } catch (eReg) {}
        if (follow && typeof opts.onPresence === 'function') {
          try { opts.onPresence(!!toggle.checked); } catch (e) {}
        }
        if (toggle.checked) {
          place(bot, signal, readBet(bot.id), opts);
        }
      };
      if (toggle.checked) {
        setStatus('Waiting for a signal', root);
        try {
          if (window.__utkSignalNotify && typeof window.__utkSignalNotify.registerStudioBot === 'function') {
            window.__utkSignalNotify.registerStudioBot(bot.id, bot.name, { feed: follow });
          }
        } catch (eInit) {}
        place(bot, signal, readBet(bot.id), opts);
      } else {
        setStatus(follow ? 'Waiting for a signal' : 'Off', root);
      }
    }
  }

  function forceOff() {
    try {
      localStorage.setItem(ON_KEY, '{}');
    } catch (e) {}
    const toggle = document.getElementById('studioAutoTrade');
    if (toggle) toggle.checked = false;
    setStatus('Off');
  }

  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('autotrade-force-off', forceOff);
    ipcRenderer.on('prepare-close', forceOff);
    ipcRenderer.on('fast-pocket-option-trade-done', function (_ev, payload) {
      try {
        const result = payload && payload.result;
        if (!result) return;
        if (result.success) {
          setStatus('Trade placed');
        } else if (result.error && result.error !== 'duplicate' && result.error !== 'in-flight' && result.error !== 'in-flight shared ssid') {
          setStatus('Trade failed: ' + result.error);
          // Allow one retry on the same signal if SSID/balance was not ready yet.
          const sid = String((payload && payload.signalId) || '');
          if (sid && /ssid|balance unknown|not ready|disabled/i.test(String(result.error))) {
            delete lastSent[sid];
          }
        }
      } catch (e) {}
    });
  } catch (e) {}

  window.__utkStudioAutotrade = {
    bind: bind,
    forceOff: forceOff,
    isOn: readOn,
    tryPlace: function (bot, signal, opts) {
      if (!bot || !readOn(bot.id)) return false;
      const merged = Object.assign({}, boundOpts || {}, opts || {});
      return place(bot, signal, readBet(bot.id), merged);
    }
  };
})();
