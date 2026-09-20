/**
 * studio-streak-modal.js — Past win streaks for custom bot desks.
 * Load AFTER studio-desk-stats.js and bot-streak-modal.js.
 *
 * Uses the shared #streak-modal chrome, but never lets house-bot (NYX/etc)
 * refresh overwrite a studio session.
 */
(function () {
  'use strict';

  var studioOpen = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatWhen(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return 'Unknown time';
    try {
      return new Date(n).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    } catch (e) {
      return 'Unknown time';
    }
  }

  function readCompleted(house) {
    try {
      const raw = house && house.getAttribute('data-studio-completed-streaks');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {}
    let history = [];
    try {
      history = JSON.parse(house.getAttribute('data-feed-history') || '[]');
    } catch (e2) {}
    if (!history.length) {
      try {
        history = JSON.parse(house.getAttribute('data-feed-history-full') || '[]');
      } catch (e3) {}
    }
    let dayKey = '';
    try {
      const input = house.querySelector('#studioStatsDateInput');
      if (input && input.value) dayKey = input.value;
      else if (window.__utkStatsDay && typeof window.__utkStatsDay.dayKey === 'function') {
        dayKey = window.__utkStatsDay.dayKey(Date.now());
      }
    } catch (e4) {}
    try {
      if (window.__utkStudioDeskStats && typeof window.__utkStudioDeskStats.computeDeskStats === 'function') {
        return window.__utkStudioDeskStats.computeDeskStats(history, dayKey).completedStreaks || [];
      }
    } catch (e5) {}
    return [];
  }

  function markStudioModal(on) {
    studioOpen = !!on;
    const modal = document.getElementById('streak-modal');
    if (!modal) return;
    if (on) modal.setAttribute('data-studio-streak', '1');
    else modal.removeAttribute('data-studio-streak');
  }

  function openStudioStreakModal(botName, items) {
    const modal = document.getElementById('streak-modal');
    const title = document.getElementById('streakModalTitle');
    const lead = document.getElementById('streakModalLead');
    const listEl = document.getElementById('streakModalList');
    if (!modal || !listEl || !title) return;

    markStudioModal(true);
    title.textContent = String(botName || 'Custom bot') + ' · Win streaks';
    if (lead) {
      lead.textContent = 'Each streak ended after a full 5 step loss chain on this bot.';
    }

    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      listEl.innerHTML = '<p class="streak-modal-empty">No completed streaks yet for this custom bot. A streak ends only after all 5 save steps lose.</p>';
      modal.classList.add('active');
      return;
    }

    listEl.innerHTML = list.map(function (item, index) {
      const length = Math.max(0, parseInt(item && item.length, 10) || 0);
      const when = formatWhen(item && item.endedAt);
      const latest = index === 0 ? '<span class="streak-modal-tag">Latest</span>' : '';
      const winWord = length === 1 ? 'win' : 'wins';
      return (
        '<article class="streak-modal-row' + (index === 0 ? ' is-latest' : '') + '">' +
          '<div class="streak-modal-count">' + esc(length) + '</div>' +
          '<div class="streak-modal-meta">' +
            '<div class="streak-modal-title-row">' +
              '<span class="streak-modal-wins">' + esc(length) + ' ' + winWord + '</span>' +
              latest +
            '</div>' +
            '<span class="streak-modal-when">Ended ' + esc(when) + '</span>' +
          '</div>' +
        '</article>'
      );
    }).join('');

    modal.classList.add('active');
  }

  function wireHouse(house, bot) {
    if (!house) return;
    const badge = house.querySelector('.best-streak-badge.is-clickable');
    if (!badge) return;
    const botId = bot && bot.id ? String(bot.id) : '';
    if (badge.dataset.studioStreakWired === '1' && badge.dataset.studioStreakBot === botId) return;
    badge.dataset.studioStreakWired = '1';
    badge.dataset.studioStreakBot = botId;
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.setAttribute('data-studio-bot-streak', '1');

    function openFromHouse(ev) {
      try {
        if (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
        }
      } catch (e) {}
      const name = (bot && bot.name) ? bot.name : 'Custom bot';
      openStudioStreakModal(name, readCompleted(house));
    }

    badge.addEventListener('click', openFromHouse, true);
    badge.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') openFromHouse(e);
    }, true);
  }

  // Clear studio flag when the shared modal closes.
  function watchClose() {
    const modal = document.getElementById('streak-modal');
    if (!modal || modal.dataset.utkStudioStreakWatch === '1') return;
    modal.dataset.utkStudioStreakWatch = '1';
    const obs = new MutationObserver(function () {
      if (!modal.classList.contains('active')) markStudioModal(false);
    });
    try {
      obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchClose);
  } else {
    watchClose();
  }

  window.__utkStudioStreakModal = {
    wireHouse: wireHouse,
    open: openStudioStreakModal,
    isOpen: function () { return studioOpen; }
  };
})();
