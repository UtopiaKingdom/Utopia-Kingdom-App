/**
 * kingdom-marks-fx.js — game-like Marks / achievement celebrations.
 */
(function () {
  'use strict';

  if (window.__utkMarksFx) return;
  window.__utkMarksFx = true;

  const QUEUE = [];
  let busy = false;
  let host = null;

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.getElementById('marksFxHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'marksFxHost';
      host.className = 'marks-fx-host';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  function spawnParticles(card, kind) {
    const n = kind === 'secret' ? 18 : kind === 'big' ? 14 : 8;
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      p.className = 'marks-fx-particle';
      const angle = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      const dist = 40 + Math.random() * 70;
      p.style.setProperty('--fx-x', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--fx-y', Math.sin(angle) * dist + 'px');
      p.style.setProperty('--fx-delay', Math.random() * 120 + 'ms');
      p.style.setProperty('--fx-hue', kind === 'secret' ? String(280 + Math.random() * 40) : String(35 + Math.random() * 50));
      card.appendChild(p);
    }
  }

  function playOne(item) {
    return new Promise((resolve) => {
      const root = ensureHost();
      const card = document.createElement('div');
      const kind = item.kind || 'marks';
      card.className = 'marks-fx-card marks-fx-' + kind;
      card.innerHTML =
        '<div class="marks-fx-glow"></div>' +
        '<div class="marks-fx-badge"></div>' +
        '<div class="marks-fx-copy">' +
        '<p class="marks-fx-kicker"></p>' +
        '<h3 class="marks-fx-title"></h3>' +
        '<p class="marks-fx-sub"></p>' +
        '</div>' +
        (item.amount ? '<div class="marks-fx-amount"></div>' : '');

      card.querySelector('.marks-fx-badge').textContent = item.icon || (kind === 'secret' ? '?' : '+');
      card.querySelector('.marks-fx-kicker').textContent = item.kicker || (kind === 'secret' ? 'Secret unlocked' : 'Marks');
      card.querySelector('.marks-fx-title').textContent = item.title || 'Reward';
      card.querySelector('.marks-fx-sub').textContent = item.sub || '';
      if (item.amount) {
        card.querySelector('.marks-fx-amount').textContent =
          (item.amount > 0 ? '+' : '') + item.amount + ' M';
      }

      root.appendChild(card);
      spawnParticles(card, kind);
      requestAnimationFrame(() => card.classList.add('is-in'));

      const hold = kind === 'secret' ? 3200 : kind === 'big' ? 2800 : 1800;
      setTimeout(() => {
        card.classList.remove('is-in');
        card.classList.add('is-out');
        setTimeout(() => {
          try {
            card.remove();
          } catch (_) {}
          resolve();
        }, 420);
      }, hold);
    });
  }

  async function drain() {
    if (busy) return;
    busy = true;
    while (QUEUE.length) {
      const next = QUEUE.shift();
      try {
        await playOne(next);
      } catch (_) {}
    }
    busy = false;
  }

  function celebrate(opts) {
    if (!opts) return;
    QUEUE.push({
      kind: opts.kind || 'marks',
      title: opts.title || '',
      sub: opts.sub || '',
      kicker: opts.kicker || '',
      icon: opts.icon || '',
      amount: opts.amount || 0
    });
    drain();
  }

  function pulseBalance() {
    document.querySelectorAll('[data-marks-balance]').forEach((el) => {
      el.classList.remove('marks-bal-pop');
      void el.offsetWidth;
      el.classList.add('marks-bal-pop');
    });
    const fill = document.getElementById('marksDailyFill');
    if (fill) {
      fill.classList.remove('marks-fill-flash');
      void fill.offsetWidth;
      fill.classList.add('marks-fill-flash');
    }
  }

  window.utkMarksFx = { celebrate, pulseBalance };

  document.addEventListener('utk-marks-changed', () => {
    try {
      pulseBalance();
    } catch (_) {}
  });
})();
