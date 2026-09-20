/**
 * warnings-ui.js — Scam / fake-earn radar slideshow.
 */
(function () {
  'use strict';

  if (window.__utkWarningsUi) return;
  window.__utkWarningsUi = true;

  const AUTO_MS = 7500;
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

  function isActive() {
    const sec = $('section-warnings');
    return !!(sec && sec.classList.contains('active'));
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
    stage.style.setProperty('--warnings-auto-ms', AUTO_MS + 'ms');
    void stage.offsetWidth;
    if (!paused && !reduceMotion && index < slides.length - 1) {
      stage.classList.add('is-playing');
    }
  }

  function armTimer() {
    clearTimer();
    if (!isActive()) {
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
      if (!isActive() || paused) return;
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
      btn.className = 'warnings-dot' + (i === index ? ' is-active' : '');
      btn.setAttribute('aria-label', 'Slide ' + (i + 1));
      btn.addEventListener('click', () => {
        paused = false;
        go(i, true);
      });
      dotsHost.appendChild(btn);
    });
  }

  function go(next, user) {
    if (!slides.length) return;
    const n = ((next % slides.length) + slides.length) % slides.length;
    slides.forEach((el, i) => el.classList.toggle('is-active', i === n));
    index = n;
    syncDots();
    if (user) paused = false;
    if (index >= slides.length - 1) {
      clearTimer();
      if (stage) stage.classList.remove('is-playing');
      return;
    }
    armTimer();
  }

  function bindNav() {
    const prev = $('warningsPrev');
    const next = $('warningsNext');
    if (prev) {
      prev.addEventListener('click', () => {
        paused = false;
        go(index - 1, true);
      });
    }
    if (next) {
      next.addEventListener('click', () => {
        paused = false;
        go(index + 1, true);
      });
    }
  }

  function observeSection() {
    const sec = $('section-warnings');
    if (!sec || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => {
      if (isActive()) {
        paused = false;
        armTimer();
      } else {
        stopPlayback();
      }
    });
    mo.observe(sec, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    stage = $('warningsStage');
    dotsHost = $('warningsDots');
    if (!stage) return;
    slides = Array.prototype.slice.call(stage.querySelectorAll('.warnings-slide'));
    if (!slides.length) return;
    buildDots();
    bindNav();
    observeSection();
    go(0, false);
    if (isActive()) armTimer();

    stage.addEventListener('mouseenter', () => {
      paused = true;
      clearTimer();
      if (stage) stage.classList.remove('is-playing');
    });
    stage.addEventListener('mouseleave', () => {
      if (!isActive()) return;
      paused = false;
      armTimer();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
