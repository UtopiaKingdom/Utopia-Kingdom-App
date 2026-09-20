/**
 * access-gate.js — Free app + selective paywall.
 * Free: chat, strategies, one house bot/day (lowest WR @ 06:00 Berlin).
 * Paid: all house bots + Studio.
 * Locked bots → full subscribe scene (no sidebar badges, no mini cinema).
 */
(function () {
  'use strict';

  const HOUSE = ['bot1', 'bot2', 'bot3'];
  const NAMES = { bot1: 'LUMIX', bot2: 'MIRAX', bot3: 'NYX' };
  const TAPE_BASES = [
    'https://utkingdom.com/api/bot-tape',
    'http://169.58.151.111:8788'
  ];
  const CACHE_KEY = 'utk-free-unlock-v1';
  const ROLL_HOUR = 6;

  let unlockState = {
    freeBotId: 'bot3',
    dayKey: '',
    wr: {},
    fetchedAt: 0
  };

  function isSignedIn() {
    try {
      return !!(window.auth && window.auth.currentUser);
    } catch (e) {
      return false;
    }
  }

  function pillText() {
    try {
      const pill = document.getElementById('subscriptionPill');
      return ((pill && pill.textContent) || '').trim().toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function isPaid() {
    // Dev runs: don't brick Studio / house-bot switching while building.
    try {
      if (typeof process !== 'undefined' && process.env && process.env.UTK_DEV_MODE === '1') return true;
    } catch (e0) {}
    // Explicit locked labels
    const t = pillText();
    if (t === 'wanderer' || t === 'trial ended') return false;
    // Active free trial = full access (Studio + all house bots)
    if (t === 'free trial') return true;
    if (t === 'subscribed' || t === 'member' || t === 'citizen' || t === 'beta tester' || t === 'owner') return true;
    try {
      const c = window.__utkEntitlementCache;
      if (c) {
        if (c.paidActive === true || c.subscriptionStatus === 'active' || c.betaTester === true || c.isOwner === true) {
          return true;
        }
        if (c.trialActive === true) return true;
      }
    } catch (e) {}
    return false;
  }

  function berlinParts(ms) {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false
    });
    const parts = fmt.formatToParts(new Date(ms || Date.now()));
    const get = function (type) {
      const p = parts.find(function (x) { return x.type === type; });
      return p ? p.value : '00';
    };
    return { y: get('year'), m: get('month'), d: get('day'), h: Number(get('hour')) };
  }

  function rotationDayKey(ms) {
    const p = berlinParts(ms);
    let y = Number(p.y);
    let m = Number(p.m);
    let d = Number(p.d);
    if (p.h < ROLL_HOUR) {
      const utc = Date.UTC(y, m - 1, d) - 24 * 3600 * 1000;
      const q = berlinParts(utc);
      y = Number(q.y);
      m = Number(q.m);
      d = Number(q.d);
    }
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.dayKey || !o.freeBotId) return null;
      if (o.dayKey !== rotationDayKey()) return null;
      return o;
    } catch (e) {
      return null;
    }
  }

  function writeCache(state) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        freeBotId: state.freeBotId,
        dayKey: state.dayKey,
        wr: state.wr || {},
        fetchedAt: Date.now()
      }));
    } catch (e) {}
  }

  function applyUnlock(state) {
    unlockState = Object.assign({}, unlockState, state || {});
    writeCache(unlockState);
    clearBadgeJunk();
  }

  async function fetchUnlock() {
    const day = rotationDayKey();
    const cached = readCache();
    if (cached && cached.dayKey === day) {
      applyUnlock(cached);
      return unlockState;
    }
    for (let i = 0; i < TAPE_BASES.length; i++) {
      try {
        const url = TAPE_BASES[i].replace(/\/$/, '') + '/free-unlock';
        const res = await fetch(url, { method: 'GET', cache: 'no-store' });
        if (!res.ok) throw new Error('http ' + res.status);
        const data = await res.json();
        if (data && data.ok && data.freeBotId) {
          applyUnlock({
            freeBotId: String(data.freeBotId),
            dayKey: String(data.dayKey || day),
            wr: data.wr || {},
            fetchedAt: Date.now()
          });
          return unlockState;
        }
      } catch (e) {}
    }
    if (cached) applyUnlock(cached);
    else applyUnlock({ freeBotId: 'bot3', dayKey: day, wr: {}, fetchedAt: Date.now() });
    return unlockState;
  }

  function freeBotId() {
    const cached = readCache();
    if (cached && cached.freeBotId) return cached.freeBotId;
    return unlockState.freeBotId || 'bot3';
  }

  function freeBotName() {
    return NAMES[freeBotId()] || 'today\'s free bot';
  }

  function canOpenHouseBot(botId) {
    const id = String(botId || '').toLowerCase();
    if (HOUSE.indexOf(id) < 0) return true;
    if (isPaid()) return true;
    return id === freeBotId();
  }

  function canOpenStudio() {
    return isPaid();
  }

  function clearBadgeJunk() {
    try {
      document.querySelectorAll('.is-access-locked, .is-access-free').forEach(function (el) {
        el.classList.remove('is-access-locked', 'is-access-free');
        if (el.getAttribute('title') === 'Subscribe to unlock' ||
            (el.getAttribute('title') || '').indexOf('Free today') === 0 ||
            el.getAttribute('title') === 'Studio is for subscribers') {
          el.removeAttribute('title');
        }
      });
    } catch (e) {}
    try {
      const junk = document.getElementById('utkAccessCinema');
      if (junk) junk.remove();
    } catch (e2) {}
  }

  function subscribeCopy(botId, reason) {
    const freeName = freeBotName();
    if (reason === 'studio') {
      return {
        title: 'Go Beyond Wanderer',
        subtitle:
          'We can see you are only wandering here. Studio and Feed are for members. ' +
          'Chat and Strategies stay free. Subscribe when you want the full desk.'
      };
    }
    const name = NAMES[String(botId || '').toLowerCase()] || 'this bot';
    return {
      title: 'Go Beyond Wanderer',
      subtitle:
        'We can see you are only wandering here. Right now you can use ' + freeName +
        ', the quietest house bot from the last day. Subscribe to unlock all three, including ' +
        name + ', and a lot more.'
    };
  }

  function openSubscribeCheckout(reason, botId) {
    const copy = subscribeCopy(botId, reason);
    try {
      window.__utkSubscribeReason = reason || '';
      window.__utkSubscribeCopy = copy;
      if (typeof window.showSubscriptionOverlay === 'function') {
        window.showSubscriptionOverlay({
          reason: reason || 'house-bot',
          title: copy.title,
          subtitle: copy.subtitle
        });
        return;
      }
    } catch (e) {}
  }

  function openFreeBot() {
    const id = freeBotId();
    const menu = document.getElementById('menu-bots');
    try {
      if (window.utkBotTransitions && typeof window.utkBotTransitions.goTo === 'function') {
        window.__utkAccessBypass = true;
        window.utkBotTransitions.goTo(id);
        window.__utkAccessBypass = false;
        return;
      }
    } catch (e) {
      window.__utkAccessBypass = false;
    }
    try {
      if (typeof window.navigateToSection === 'function') {
        window.__utkAccessBypass = true;
        window.navigateToSection(id, menu);
        window.__utkAccessBypass = false;
      }
    } catch (e2) {
      window.__utkAccessBypass = false;
    }
  }

  function guardHouseBot(botId) {
    if (window.__utkAccessBypass) return true;
    if (canOpenHouseBot(botId)) return true;
    openSubscribeCheckout('house-bot', botId);
    return false;
  }

  function guardStudio() {
    if (canOpenStudio()) return true;
    openSubscribeCheckout('studio', 'bot1');
    return false;
  }

  function wrapNav() {
    try {
      const prev = window.navigateToSection;
      if (typeof prev !== 'function' || prev.__utkAccessWrapped) return;
      const wrapped = function (id, menu) {
        if (window.__utkAccessBypass) return prev.apply(this, arguments);
        const sid = String(id || '');
        const fromBotsMenu = !!(menu && menu.id === 'menu-bots');

        if (sid === 'studio' || sid === 'section-studio') {
          if (!guardStudio()) return;
          return prev.apply(this, arguments);
        }

        if (fromBotsMenu || sid === 'bots') {
          const target = isPaid() ? (HOUSE.indexOf(sid) >= 0 ? sid : freeBotId()) : freeBotId();
          return prev.call(this, target, menu || document.getElementById('menu-bots'));
        }

        if (HOUSE.indexOf(sid) >= 0) {
          if (!guardHouseBot(sid)) return;
        }
        return prev.apply(this, arguments);
      };
      wrapped.__utkAccessWrapped = true;
      window.navigateToSection = wrapped;
    } catch (e) {}

    try {
      const tx = window.utkBotTransitions;
      if (tx && typeof tx.goTo === 'function' && !tx.goTo.__utkAccessWrapped) {
        const prevGo = tx.goTo.bind(tx);
        const go = function (botId) {
          if (window.__utkAccessBypass) return prevGo(botId);
          if (!guardHouseBot(botId)) return;
          return prevGo(botId);
        };
        go.__utkAccessWrapped = true;
        tx.goTo = go;
      }
    } catch (e2) {}
  }

  function hasActiveAppAccessPaid() {
    return isPaid();
  }

  try {
    // Paid features (Studio live, hub entitlement) must not treat Wanderers as subscribed.
    window.hasActiveAppAccess = hasActiveAppAccessPaid;
  } catch (e) {}

  window.__utkAccessGate = {
    isPaid: isPaid,
    canOpenHouseBot: canOpenHouseBot,
    canOpenStudio: canOpenStudio,
    freeBotId: freeBotId,
    freeBotName: freeBotName,
    fetchUnlock: fetchUnlock,
    openSubscribe: openSubscribeCheckout,
    guardHouseBot: guardHouseBot,
    guardStudio: guardStudio,
    showCinema: function (botId, reason) { openSubscribeCheckout(reason || 'house-bot', botId); },
    hideCinema: function () {},
    openFreeBot: openFreeBot,
    rotationDayKey: rotationDayKey,
    paintHomeLocks: clearBadgeJunk,
    subscribeCopy: subscribeCopy
  };

  function boot() {
    clearBadgeJunk();
    wrapNav();
    fetchUnlock().then(clearBadgeJunk).catch(clearBadgeJunk);
    setInterval(function () {
      fetchUnlock().catch(function () {});
      clearBadgeJunk();
      wrapNav();
    }, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
