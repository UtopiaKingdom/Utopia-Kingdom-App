/**
 * bot-streak-modal.js — Friendly popup listing completed win streaks.
 * Load AFTER bot-stats.js.
 */
(function () {
  const BOT_NAMES = { LUMIX: 'LUMIX', MIRAX: 'MIRAX', NYX: 'NYX' };
  let lastOpenBot = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

  function getHistory(botKey) {
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.getWinStreakHistory === 'function') {
        return window.__utkBotStats.getWinStreakHistory(botKey) || [];
      }
    } catch (e) {}
    return [];
  }

  function closeModal() {
    const modal = document.getElementById('streak-modal');
    if (modal) modal.classList.remove('active');
  }

  function openStreakModal(botKey) {
    try {
      if (window.__utkStudioStreakModal && typeof window.__utkStudioStreakModal.isOpen === 'function'
          && window.__utkStudioStreakModal.isOpen()) {
        return;
      }
      const modalGate = document.getElementById('streak-modal');
      if (modalGate && modalGate.getAttribute('data-studio-streak') === '1') return;
    } catch (eGate) {}
    const key = String(botKey || '').toUpperCase();
    lastOpenBot = key;

    const modal = document.getElementById('streak-modal');
    const title = document.getElementById('streakModalTitle');
    const lead = document.getElementById('streakModalLead');
    const listEl = document.getElementById('streakModalList');
    if (!modal || !listEl || !title) return;

    const label = BOT_NAMES[key] || key;
    title.textContent = `${label} · Win streaks`;
    if (lead) {
      lead.textContent = 'Counted from every saved result. A streak ends only after 5 losses in a row.';
    }

    const loading = !!(window.__utkResultsHistory && window.__utkResultsHistory.loading && window.__utkResultsHistory.loading[key]);
    const items = getHistory(key);
    if (!items.length) {
      listEl.innerHTML = loading
        ? '<p class="streak-modal-empty">Counting from full trade history…</p>'
        : '<p class="streak-modal-empty">No completed streaks yet. A streak ends after 5 losses in a row.</p>';
      modal.classList.add('active');
      return;
    }

    listEl.innerHTML = items.map((item, index) => {
      const length = Math.max(0, parseInt(item && item.length, 10) || 0);
      const when = formatWhen(item && item.endedAt);
      const latest = index === 0 ? '<span class="streak-modal-tag">Latest</span>' : '';
      const winWord = length === 1 ? 'win' : 'wins';
      return `
        <article class="streak-modal-row${index === 0 ? ' is-latest' : ''}">
          <div class="streak-modal-count">${escapeHtml(length)}</div>
          <div class="streak-modal-meta">
            <div class="streak-modal-title-row">
              <span class="streak-modal-wins">${escapeHtml(length)} ${winWord}</span>
              ${latest}
            </div>
            <span class="streak-modal-when">Ended ${escapeHtml(when)}</span>
          </div>
        </article>`;
    }).join('');

    modal.classList.add('active');
  }

  function bindBadge(el) {
    if (!el || el.dataset.streakWired === '1') return;
    el.dataset.streakWired = '1';
    const botKey = el.getAttribute('data-bot') || '';

    el.addEventListener('click', (e) => {
      e.preventDefault();
      openStreakModal(botKey);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openStreakModal(botKey);
      }
    });
  }

  function bindClose() {
    const modal = document.getElementById('streak-modal');
    if (!modal || modal.dataset.streakCloseWired === '1') return;
    modal.dataset.streakCloseWired = '1';

    modal.querySelectorAll('.modal-icon-close[data-close="streak"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        closeModal();
      });
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
    });
  }

  function install() {
    bindClose();
    bindBadge(document.getElementById('bestStreakBadge-bot1'));
    bindBadge(document.getElementById('bestStreakBadge-bot2'));
    bindBadge(document.getElementById('bestStreakBadge-bot3'));
    window.openWinStreakModal = openStreakModal;
    window.addEventListener('utk:stats-updated', function (e) {
      const modal = document.getElementById('streak-modal');
      if (!modal || !modal.classList.contains('active')) return;
      if (modal.getAttribute('data-studio-streak') === '1') return;
      try {
        if (window.__utkStudioStreakModal && window.__utkStudioStreakModal.isOpen()) return;
      } catch (e2) {}
      const bot = e && e.detail && e.detail.bot;
      if (bot && bot === lastOpenBot) openStreakModal(bot);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
