/**
 * vision-ui.js — Vision slideshow + waitlist (nav-safe).
 */
(function () {
  'use strict';

  if (window.__utkVisionUi) return;
  window.__utkVisionUi = true;

  let ipcRenderer = null;
  try {
    ipcRenderer = require('electron').ipcRenderer;
  } catch (_) {
    ipcRenderer = null;
  }

  const AUTO_MS = 7000;
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let index = 0;
  let timer = null;
  let paused = false;
  let slides = [];
  let dotsHost = null;
  let stage = null;

  function $(id) {
    return document.getElementById(id);
  }

  function isVisionActive() {
    const sec = $('section-vision');
    return !!(sec && sec.classList.contains('active'));
  }

  function getUserContact() {
    let email = '';
    let name = '';
    try {
      const { auth } = require('./auth-verification');
      const user = auth && auth.currentUser;
      if (user) {
        email = String(user.email || '').trim();
        name = String(user.displayName || '').trim();
      }
    } catch (_) {}
    return { email, name };
  }

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-ok', 'is-err', 'is-busy');
    if (kind) el.classList.add(kind);
  }

  function selectedTracks() {
    const boxes = document.querySelectorAll('input[name="visionInterest"]:checked');
    const out = [];
    boxes.forEach((b) => out.push(String(b.value || '')));
    return out.filter(Boolean);
  }

  function syncInterestStyles() {
    document.querySelectorAll('.vision-wait-kind').forEach((label) => {
      const input = label.querySelector('input[type="checkbox"]');
      label.classList.toggle('is-on', !!(input && input.checked));
    });
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stopPlayback() {
    clearTimer();
    paused = true;
    if (stage) stage.classList.remove('is-playing');
  }

  function restartProgress() {
    if (!stage) return;
    stage.classList.remove('is-playing');
    stage.style.setProperty('--vision-auto-ms', AUTO_MS + 'ms');
    void stage.offsetWidth;
    if (!paused && !reduceMotion && index < slides.length - 1) {
      stage.classList.add('is-playing');
    }
  }

  function armTimer() {
    clearTimer();
    if (!isVisionActive()) {
      stopPlayback();
      return;
    }
    if (paused || reduceMotion) return;
    if (index >= slides.length - 1) {
      if (stage) stage.classList.remove('is-playing');
      return;
    }
    restartProgress();
    timer = setTimeout(() => {
      if (!isVisionActive() || paused) return;
      go(index + 1, false);
    }, AUTO_MS);
  }

  function syncDots() {
    if (!dotsHost) return;
    const kids = dotsHost.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('is-active', i === index);
    }
  }

  function buildDots() {
    if (!dotsHost) return;
    dotsHost.innerHTML = '';
    slides.forEach((_, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vision-dot' + (i === index ? ' is-active' : '');
      btn.setAttribute('aria-label', 'Go to slide ' + (i + 1));
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        go(i, true);
      });
      dotsHost.appendChild(btn);
    });
  }

  function go(next, userDriven) {
    if (!slides.length) return;
    const n = ((next % slides.length) + slides.length) % slides.length;
    if (n === index && !userDriven) return;
    slides.forEach((s, i) => s.classList.toggle('is-active', i === n));
    index = n;
    syncDots();
    if (userDriven) paused = false;
    if (isVisionActive()) armTimer();
    else stopPlayback();
  }

  function openHouseBot(botId) {
    try {
      if (window.__utkAccessGate && typeof window.__utkAccessGate.guardHouseBot === 'function') {
        if (!window.__utkAccessGate.guardHouseBot(botId)) return;
      }
    } catch (_) {}

    const current = document.querySelector('.section.active');
    const onHouseBot = !!(current && /^section-bot[123]$/.test(current.id));

    if (onHouseBot && window.utkBotTransitions && typeof window.utkBotTransitions.goTo === 'function') {
      window.__utkAccessBypass = true;
      try {
        window.utkBotTransitions.goTo(botId);
      } finally {
        window.__utkAccessBypass = false;
      }
      return;
    }

    try {
      if (typeof window.navigateToSection === 'function') {
        window.navigateToSection(botId, document.getElementById('menu-bots'));
      }
    } catch (_) {}
  }

  function bindBotCards() {
    document.querySelectorAll('.vision-bot-card[data-vision-bot]').forEach((btn) => {
      if (btn.__utkVisionBotBound) return;
      btn.__utkVisionBotBound = true;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const id = btn.getAttribute('data-vision-bot');
        if (id) openHouseBot(id);
      });
    });
  }

  function bindSlideshow() {
    stage = $('visionStage');
    slides = Array.prototype.slice.call(document.querySelectorAll('.vision-slide'));
    dotsHost = $('visionDots');
    if (!slides.length) return;

    buildDots();
    index = 0;
    slides.forEach((s, i) => s.classList.toggle('is-active', i === 0));
    syncDots();

    const prev = $('visionPrev');
    const next = $('visionNext');
    if (prev && !prev.__utkVisionBound) {
      prev.__utkVisionBound = true;
      prev.addEventListener('click', (ev) => {
        ev.preventDefault();
        go(index - 1, true);
      });
    }
    if (next && !next.__utkVisionBound) {
      next.__utkVisionBound = true;
      next.addEventListener('click', (ev) => {
        ev.preventDefault();
        go(index + 1, true);
      });
    }

    const form = $('visionWaitForm');
    if (form && !form.__utkVisionFocusBound) {
      form.__utkVisionFocusBound = true;
      form.addEventListener('focusin', () => {
        paused = true;
        clearTimer();
        if (stage) stage.classList.remove('is-playing');
      });
      form.addEventListener('focusout', () => {
        setTimeout(() => {
          if (form.contains(document.activeElement)) return;
          paused = false;
          if (isVisionActive()) armTimer();
        }, 0);
      });
      form.addEventListener('change', syncInterestStyles);
    }
    syncInterestStyles();

    const section = $('section-vision');
    if (section && !section.__utkVisionObs) {
      section.__utkVisionObs = true;
      const obs = new MutationObserver(() => {
        if (isVisionActive()) {
          paused = false;
          armTimer();
        } else {
          stopPlayback();
        }
      });
      obs.observe(section, { attributes: true, attributeFilter: ['class'] });
    }

    bindBotCards();
    if (isVisionActive()) armTimer();
    else stopPlayback();
  }

  function bindWaitlist() {
    const form = $('visionWaitForm');
    if (!form || form.__utkVisionSubmitBound) return;
    form.__utkVisionSubmitBound = true;

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const statusEl = $('visionWaitStatus');
      const noteEl = $('visionWaitNote');
      const sendBtn = $('visionWaitSend');
      const tracks = selectedTracks();
      const note = noteEl ? String(noteEl.value || '').trim() : '';

      if (!tracks.length) {
        setStatus(statusEl, 'Select what you care about so we know where to write.', 'is-err');
        return;
      }

      const { email, name } = getUserContact();
      if (!email) {
        setStatus(statusEl, 'Please sign in so we can find you when it launches.', 'is-err');
        return;
      }
      if (!ipcRenderer) {
        setStatus(statusEl, 'Could not send right now. Please try again.', 'is-err');
        return;
      }

      const message = [
        '[VISION WAITLIST]',
        'Tracks: ' + tracks.join(', '),
        note ? ('Note: ' + note) : 'Note: (none)',
        'Goal interest: house bots aiming for ultra long streaks (about 100 wins with rare losses).',
      ].join('\n');

      if (sendBtn) sendBtn.disabled = true;
      setStatus(statusEl, 'Sending…', 'is-busy');

      try {
        const result = await ipcRenderer.invoke('send-support-message', {
          kind: 'beta',
          message,
          email,
          name: name || 'Trader',
        });
        if (result && result.success) {
          setStatus(statusEl, 'You are on the list. We will write when your path opens.', 'is-ok');
          if (noteEl) noteEl.value = '';
        } else {
          setStatus(statusEl, (result && result.error) || 'Could not send. Please try again.', 'is-err');
        }
      } catch (e) {
        setStatus(statusEl, (e && e.message) || 'Could not send.', 'is-err');
      } finally {
        if (sendBtn) sendBtn.disabled = false;
      }
    });
  }

  function bind() {
    try {
      bindSlideshow();
      bindWaitlist();
    } catch (e) {
      try { console.error('[vision-ui]', e); } catch (_) {}
      stopPlayback();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
