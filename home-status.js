/**
 * home-status.js — Minimal Home strip: free today / member + live streaks.
 */
(function () {
  'use strict';

  if (window.__utkHomeStatus) return;
  window.__utkHomeStatus = true;

  const NUDGE_PREFIX = 'utk-home-nudge-seen-';
  const BOTS = [
    { id: 'bot1', key: 'LUMIX' },
    { id: 'bot2', key: 'MIRAX' },
    { id: 'bot3', key: 'NYX' }
  ];

  function isPaid() {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.isPaid === 'function') {
        return !!window.__utkAccessGate.isPaid();
      }
    } catch (_) {}
    return false;
  }

  function freeBotName() {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.freeBotName === 'function') {
        return window.__utkAccessGate.freeBotName();
      }
    } catch (_) {}
    return "today's free bot";
  }

  function freeBotId() {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.freeBotId === 'function') {
        return window.__utkAccessGate.freeBotId();
      }
    } catch (_) {}
    return 'bot3';
  }

  function uidKey() {
    try {
      const av = require('./auth-verification');
      const u = av && av.auth && av.auth.currentUser;
      if (u && u.uid) return NUDGE_PREFIX + u.uid;
    } catch (_) {}
    try {
      if (window.auth && window.auth.currentUser && window.auth.currentUser.uid) {
        return NUDGE_PREFIX + window.auth.currentUser.uid;
      }
    } catch (_) {}
    return NUDGE_PREFIX + 'local';
  }

  function nudgeSeen() {
    try {
      return localStorage.getItem(uidKey()) === '1';
    } catch (_) {
      return true;
    }
  }

  function markNudgeSeen() {
    try {
      localStorage.setItem(uidKey(), '1');
    } catch (_) {}
  }

  function streakOf(botId) {
    const el = document.getElementById('winStreakValue-' + botId);
    if (!el) return 0;
    const n = parseInt(String(el.textContent || '0').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function lastOf(botId) {
    const el = document.getElementById('bestStreakValue-' + botId);
    if (!el) return 0;
    const n = parseInt(String(el.textContent || '0').replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function paintAccess() {
    const el = document.getElementById('homeStatusAccess');
    if (!el) return;
    if (isPaid()) {
      el.innerHTML = '<span class="home-status-label">Desk</span><span class="home-status-value">All house bots · Studio open</span>';
      el.classList.add('is-paid');
      el.classList.remove('is-free');
      return;
    }
    const name = freeBotName();
    el.innerHTML =
      '<span class="home-status-label">Free today</span>' +
      '<span class="home-status-value">' + escapeHtml(name) + '</span>' +
      '<span class="home-status-sep">·</span>' +
      '<button type="button" class="home-status-link" id="homeStatusSubscribe">Subscribe for all bots + Studio</button>';
    el.classList.add('is-free');
    el.classList.remove('is-paid');
    const btn = document.getElementById('homeStatusSubscribe');
    if (btn && !btn.__utkBound) {
      btn.__utkBound = true;
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        try {
          if (window.__utkAccessGate && typeof window.__utkAccessGate.openSubscribe === 'function') {
            window.__utkAccessGate.openSubscribe('studio', 'bot1');
          } else if (typeof window.showSubscriptionOverlay === 'function') {
            window.showSubscriptionOverlay({ reason: 'studio' });
          }
        } catch (_) {}
      });
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function paintStreaks() {
    const el = document.getElementById('homeStatusStreaks');
    if (!el) return;
    const parts = BOTS.map(function (b) {
      const cur = streakOf(b.id);
      const last = lastOf(b.id);
      return (
        '<span class="home-status-bot">' +
          '<span class="home-status-bot-name">' + b.key + '</span>' +
          '<span class="home-status-bot-streak">' + cur + '</span>' +
          (last > 0 ? '<span class="home-status-bot-last">last ' + last + '</span>' : '') +
        '</span>'
      );
    });
    el.innerHTML =
      '<span class="home-status-label">Streaks</span>' +
      '<span class="home-status-streak-row">' + parts.join('') + '</span>';
  }

  function openFreeBot() {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.openFreeBot === 'function') {
        window.__utkAccessGate.openFreeBot();
        return;
      }
    } catch (_) {}
    try {
      const id = freeBotId();
      if (window.utkBotTransitions && typeof window.utkBotTransitions.goTo === 'function') {
        window.utkBotTransitions.goTo(id);
      }
    } catch (_) {}
  }

  function paintNudge(forceShow) {
    const el = document.getElementById('homeStatusNudge');
    if (!el) return;
    if (isPaid() || (nudgeSeen() && !forceShow)) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    let tourDone = false;
    try {
      tourDone = !!(window.__utkOnboardingApi && window.__utkOnboardingApi.isDone && window.__utkOnboardingApi.isDone());
    } catch (_) {}
    if (!forceShow && !tourDone) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const name = freeBotName();
    el.hidden = false;
    el.innerHTML =
      '<span class="home-status-nudge-text">Start here — today’s free bot is <strong>' +
      escapeHtml(name) +
      '</strong>.</span>' +
      '<button type="button" class="home-status-nudge-go" id="homeStatusNudgeGo">Open ' +
      escapeHtml(name) +
      '</button>' +
      '<button type="button" class="home-status-nudge-dismiss" id="homeStatusNudgeDismiss" aria-label="Dismiss">Got it</button>';
    const go = document.getElementById('homeStatusNudgeGo');
    const dismiss = document.getElementById('homeStatusNudgeDismiss');
    if (go && !go.__utkBound) {
      go.__utkBound = true;
      go.addEventListener('click', function (ev) {
        ev.preventDefault();
        markNudgeSeen();
        el.hidden = true;
        openFreeBot();
      });
    }
    if (dismiss && !dismiss.__utkBound) {
      dismiss.__utkBound = true;
      dismiss.addEventListener('click', function (ev) {
        ev.preventDefault();
        markNudgeSeen();
        el.hidden = true;
        el.innerHTML = '';
      });
    }
  }

  function paint() {
    paintAccess();
    paintStreaks();
    paintNudge(false);
  }

  function bind() {
    paint();
    setInterval(paint, 4000);
    try {
      const obs = new MutationObserver(function () {
        paintStreaks();
      });
      BOTS.forEach(function (b) {
        const a = document.getElementById('winStreakValue-' + b.id);
        const c = document.getElementById('bestStreakValue-' + b.id);
        if (a) obs.observe(a, { characterData: true, childList: true, subtree: true });
        if (c) obs.observe(c, { characterData: true, childList: true, subtree: true });
      });
    } catch (_) {}
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) paint();
    });
    window.addEventListener('utk-onboarding-done', function () {
      paintNudge(true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
