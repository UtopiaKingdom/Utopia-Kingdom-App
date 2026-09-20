/**
 * studio-signal-live.js — Live signal card ticks + TTL (house-bot parity for custom bots).
 * Load AFTER studio-feed-desk.js and signal-card-ttl.js.
 */
(function () {
  'use strict';

  let tickTimer = null;
  let mountedHouse = null;
  let mountedBot = null;
  let mountedSig = null;
  let onExpired = null;

  function ttl() {
    return window.__utkSignalCardTtl || null;
  }

  function fmtCountdown(sec) {
    const s = Math.max(0, Math.ceil(Number(sec) || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return mm + ':' + ss;
  }

  function tickCountdown(house, bot, sig) {
    if (!house || !sig) return;
    const el = house.querySelector('.countdown-value');
    if (!el) return;
    const api = ttl();
    let left = null;
    if (api && typeof api.remainingSec === 'function') {
      left = api.remainingSec(sig, Date.now(), Number(sig.duration || 60));
    } else {
      const open = Number(sig.openedAtMs || 0);
      const dur = Number(sig.duration || 60) * 1000;
      if (open && dur) left = Math.max(0, Math.ceil((open + dur - Date.now()) / 1000));
    }
    if (left != null) el.textContent = fmtCountdown(left);
  }

  function isExpired(bot, sig) {
    if (!sig) return false;
    const phase = String(sig.phase || '').toLowerCase();
    if (phase === 'result') {
      const grace = (ttl() && ttl().RESULT_GRACE_MS) || 6000;
      const closed = Number(sig.closedAtMs || sig.closingTime || 0);
      if (closed && Date.now() - closed > grace) return true;
      return false;
    }
    if (phase !== 'signal') return false;
    const api = ttl();
    if (api && typeof api.isDeadSignal === 'function') {
      return api.isDeadSignal(sig, Date.now(), Number(sig.duration || 60));
    }
    return false;
  }

  function applyGlow(house, sig) {
    try {
      if (window.__utkStudioSignalGlow && typeof window.__utkStudioSignalGlow.apply === 'function') {
        window.__utkStudioSignalGlow.apply(house, sig);
      }
    } catch (e) {}
  }

  function stop() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    mountedHouse = null;
    mountedBot = null;
    mountedSig = null;
  }

  function start(house, bot, sig, opts) {
    opts = opts || {};
    stop();
    if (!house || !bot) return;
    mountedHouse = house;
    mountedBot = bot;
    mountedSig = sig || null;
    onExpired = typeof opts.onExpired === 'function' ? opts.onExpired : null;
    applyGlow(house, mountedSig);
    if (!mountedSig) return;

    tickCountdown(house, bot, mountedSig);
    tickTimer = setInterval(function () {
      if (!mountedHouse || !mountedSig) return;
      if (isExpired(mountedBot, mountedSig)) {
        if (onExpired) onExpired();
        stop();
        return;
      }
      tickCountdown(mountedHouse, mountedBot, mountedSig);
    }, 1000);
  }

  function update(house, bot, sig, opts) {
    if (!house || !bot) return;
    if (house !== mountedHouse) {
      start(house, bot, sig, opts);
      return;
    }
    mountedBot = bot;
    mountedSig = sig || null;
    if (opts && typeof opts.onExpired === 'function') onExpired = opts.onExpired;
    applyGlow(house, mountedSig);
    if (!mountedSig) {
      stop();
      return;
    }
    if (!tickTimer) {
      start(house, bot, sig, opts);
      return;
    }
    tickCountdown(house, bot, mountedSig);
  }

  window.__utkStudioSignalLive = {
    start: start,
    update: update,
    stop: stop,
    tickCountdown: tickCountdown,
    isExpired: isExpired
  };
})();
