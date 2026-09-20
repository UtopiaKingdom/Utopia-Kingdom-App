/**
 * app-onboarding.js — First-run tour after new account creation.
 * Smooth, professional section walkthrough. One time per device user.
 */
(function () {
  'use strict';

  if (window.__utkOnboarding) return;
  window.__utkOnboarding = true;

  const PENDING_KEY = 'utk-onboard-pending';
  const DONE_PREFIX = 'utk-onboard-done-';

  const STEPS = [
    {
      id: 'main',
      menu: 'menu-main',
      kicker: 'Home',
      title: 'Your launch pad',
      body: 'Live prices, today’s free bot, streaks, and every destination in one calm place.'
    },
    {
      id: 'bot1',
      menu: 'menu-bots',
      kicker: 'Trading bots',
      title: 'House desk',
      body: 'LUMIX, MIRAX, and NYX. Connect Pocket Option, follow the chain, watch the streak.'
    },
    {
      id: 'strategies',
      menu: 'menu-strategies',
      kicker: 'Strategies',
      title: 'Learn the setups',
      body: 'Entry ideas explained clearly so you know why a signal fired.'
    },
    {
      id: 'hub',
      menu: 'menu-hub',
      kicker: 'Chat',
      title: 'The room',
      body: 'Talk with traders around the world. Free for everyone.'
    },
    {
      id: 'studio',
      menu: 'menu-studio',
      kicker: 'Studio',
      title: 'Build your own',
      body: 'Peek at the builder — create, backtest, then go live when you subscribe.',
      note: 'Peek only · Citizen unlocks build + live'
    },
    {
      id: 'vision',
      menu: 'menu-vision',
      kicker: 'Vision',
      title: 'Where Utopia is going',
      body: 'More platforms, real markets, and ultra long streak research. Tell us what you want first.'
    }
  ];

  let host = null;
  let stepIndex = 0;
  let running = false;

  function uidKey() {
    try {
      const av = require('./auth-verification');
      const u = av && av.auth && av.auth.currentUser;
      if (u && u.uid) return DONE_PREFIX + u.uid;
    } catch (_) {}
    try {
      if (window.auth && window.auth.currentUser && window.auth.currentUser.uid) {
        return DONE_PREFIX + window.auth.currentUser.uid;
      }
    } catch (_) {}
    return DONE_PREFIX + 'local';
  }

  function isDone() {
    try {
      return localStorage.getItem(uidKey()) === '1';
    } catch (_) {
      return false;
    }
  }

  function markDone() {
    try {
      localStorage.setItem(uidKey(), '1');
      localStorage.removeItem(PENDING_KEY);
    } catch (_) {}
  }

  function markPending() {
    try {
      localStorage.setItem(PENDING_KEY, '1');
    } catch (_) {}
  }

  function isPending() {
    try {
      return localStorage.getItem(PENDING_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function goSection(step) {
    try {
      const menu = step.menu ? document.getElementById(step.menu) : null;
      // Keep both flags for the whole tour — Studio openStudio runs after the wipe.
      window.__utkOnboardingActive = true;
      window.__utkAccessBypass = true;
      if (typeof window.navigateToSection === 'function') {
        window.navigateToSection(step.id, menu);
      }
      // Kill any subscribe overlay that raced in before flags were set.
      try {
        if (typeof window.hideSubscriptionOverlay === 'function') {
          window.hideSubscriptionOverlay(true);
        } else {
          const ov = document.getElementById('subscription-overlay');
          if (ov) {
            ov.classList.remove('active', 'opening', 'waiting', 'waiting-only');
            ov.style.display = 'none';
          }
        }
      } catch (_) {}
    } catch (_) {}
  }

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.id = 'utkOnboard';
    host.className = 'utk-onboard';
    host.setAttribute('aria-hidden', 'true');
    host.innerHTML =
      '<div class="utk-onboard-veil" aria-hidden="true"></div>' +
      '<div class="utk-onboard-card" role="dialog" aria-modal="true" aria-labelledby="utkOnboardTitle">' +
        '<p class="utk-onboard-kicker" id="utkOnboardKicker"></p>' +
        '<h2 class="utk-onboard-title" id="utkOnboardTitle"></h2>' +
        '<p class="utk-onboard-body" id="utkOnboardBody"></p>' +
        '<p class="utk-onboard-note" id="utkOnboardNote" hidden></p>' +
        '<div class="utk-onboard-progress" id="utkOnboardProgress" aria-hidden="true"></div>' +
        '<div class="utk-onboard-actions">' +
          '<button type="button" class="utk-onboard-skip" id="utkOnboardSkip">Skip</button>' +
          '<button type="button" class="btn-primary utk-onboard-next" id="utkOnboardNext">Next</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(host);

    host.querySelector('#utkOnboardSkip').addEventListener('click', finish);
    host.querySelector('#utkOnboardNext').addEventListener('click', function () {
      if (stepIndex >= STEPS.length - 1) finish();
      else showStep(stepIndex + 1);
    });
    return host;
  }

  function paintProgress() {
    const root = document.getElementById('utkOnboardProgress');
    if (!root) return;
    root.innerHTML = STEPS.map(function (_, i) {
      return '<i class="' + (i === stepIndex ? 'is-on' : (i < stepIndex ? 'is-done' : '')) + '"></i>';
    }).join('');
  }

  function showStep(i) {
    stepIndex = i;
    const step = STEPS[i];
    if (!step) return finish();
    goSection(step);
    const card = host.querySelector('.utk-onboard-card');
    if (card) {
      card.classList.remove('is-enter');
      void card.offsetWidth;
      card.classList.add('is-enter');
    }
    const k = document.getElementById('utkOnboardKicker');
    const t = document.getElementById('utkOnboardTitle');
    const b = document.getElementById('utkOnboardBody');
    const note = document.getElementById('utkOnboardNote');
    const next = document.getElementById('utkOnboardNext');
    if (k) k.textContent = step.kicker;
    if (t) t.textContent = step.title;
    if (b) b.textContent = step.body;
    if (note) {
      if (step.note) {
        note.hidden = false;
        note.textContent = step.note;
      } else {
        note.hidden = true;
        note.textContent = '';
      }
    }
    if (next) next.textContent = i >= STEPS.length - 1 ? 'Start trading' : 'Next';
    paintProgress();
  }

  function finish() {
    running = false;
    window.__utkOnboardingActive = false;
    window.__utkAccessBypass = false;
    try { document.body.classList.remove('utk-onboarding'); } catch (_) {}
    markDone();
    if (host) {
      host.classList.remove('is-open');
      host.setAttribute('aria-hidden', 'true');
    }
    try {
      const menu = document.getElementById('menu-main');
      if (typeof window.navigateToSection === 'function') {
        window.navigateToSection('main', menu);
      }
    } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent('utk-onboarding-done'));
    } catch (_) {}
  }

  function start() {
    if (running) return;
    if (isDone()) {
      try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
      return;
    }
    if (document.body && document.body.classList.contains('auth-visible')) return;
    running = true;
    window.__utkOnboardingActive = true;
    try { document.body.classList.add('utk-onboarding'); } catch (_) {}
    ensureHost();
    host.classList.add('is-open');
    host.setAttribute('aria-hidden', 'false');
    showStep(0);
  }

  function tryStartPending() {
    if (!isPending() || isDone()) return;
    if (document.body && document.body.classList.contains('auth-visible')) return;
    setTimeout(start, 700);
  }

  window.__utkOnboardingApi = {
    markPending: markPending,
    start: start,
    isDone: isDone
  };

  function bind() {
    tryStartPending();
    try {
      const obs = new MutationObserver(function () {
        if (!document.body.classList.contains('auth-visible')) tryStartPending();
      });
      if (document.body) obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    } catch (_) {}
    window.addEventListener('utk-start-onboarding', function () {
      markPending();
      tryStartPending();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
