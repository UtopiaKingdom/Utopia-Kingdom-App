/**
 * bot-studio-ai.js — Check AI for upgrades (accept / decline).
 * Load AFTER bot-studio.js.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, tone) {
    try {
      if (typeof window.showAppToast === 'function') {
        window.showAppToast(msg, { tone: tone || 'info' });
        return;
      }
    } catch (e) {}
  }

  function hub() {
    return window.__utkCommunityHub || null;
  }

  function mountEl(preferDesk) {
    if (preferDesk) {
      const desk = document.getElementById('studioDeskAiMount');
      if (desk) return desk;
    }
    return document.getElementById('studioAiMount') || document.getElementById('studioDeskAiMount');
  }

  function scoreSummary(bot) {
    const c = bot && bot.lastCheck;
    if (!c || !c.ok) {
      return 'Run Test past candles first so AI can read your scorecard.';
    }
    const wr = c.wr1 != null ? c.wr1 : '—';
    const n = Number(c.wr1N != null ? c.wr1N : c.trades) || 0;
    const wins = Number(c.wr1Wins != null ? c.wr1Wins : 0);
    const wipes = c.wipeChains != null ? c.wipeChains : c.wipes;
    return 'WR1 ' + wr + '% · ' + wins + '/' + n + ' first tries · ' + (wipes != null ? wipes : 0) + ' wipes.';
  }

  function renderProposals(list, bot, preferDesk) {
    const el = mountEl(preferDesk);
    if (!el) return;
    if (!list || !list.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML =
      '<div class="studio-ai-pro">' +
        '<div class="studio-ai-pro-head">' +
          '<div>' +
            '<p class="studio-ai-pro-kicker">What can improve</p>' +
            '<h3>AI suggestions</h3>' +
          '</div>' +
          '<button type="button" class="studio-ghost" id="studioAiClear">Close</button>' +
        '</div>' +
        '<p class="studio-ai-pro-summary">' + esc(scoreSummary(bot)) + '</p>' +
        '<p class="studio-ai-note">Accept applies the change into your recipe. Decline hides that idea. Re-test after you accept.</p>' +
        list.map(function (p, i) {
          return (
            '<div class="studio-ai-card" data-ai-idx="' + i + '">' +
              '<strong>' + esc(p.title) + '</strong>' +
              '<p>' + esc(p.why) + '</p>' +
              '<div class="studio-ai-actions">' +
                '<button type="button" class="studio-primary" data-ai-accept="' + i + '">Accept</button>' +
                '<button type="button" class="studio-ghost" data-ai-decline="' + i + '">Decline</button>' +
              '</div>' +
            '</div>'
          );
        }).join('') +
      '</div>';
    el.__utkAiList = list;
    el.__utkAiPreferDesk = !!preferDesk;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {}
  }

  function applyPatch(bot, patch) {
    bot = Object.assign({}, bot);
    bot.rules = Object.assign({}, bot.rules || {});
    if (!patch || typeof patch !== 'object') return bot;
    if (patch.rules && typeof patch.rules === 'object') {
      Object.keys(patch.rules).forEach(function (k) {
        bot.rules[k] = patch.rules[k];
      });
    }
    if (patch.watchMode) bot.watchMode = patch.watchMode;
    if (Array.isArray(patch.watch)) bot.watch = patch.watch.slice();
    if (patch.timeframe) bot.timeframe = patch.timeframe;
    return bot;
  }

  async function run(bot, opts) {
    opts = opts || {};
    const studio = window.__utkBotStudio;
    if (!bot && studio && typeof studio.selected === 'function') bot = studio.selected();
    if (!bot) {
      toast('Create a bot first.', 'error');
      return;
    }
    const preferDesk = opts.preferDesk !== false && !!document.getElementById('studioDeskAiMount');
    toast('Asking AI what can improve…', 'info');
    const api = hub() && hub().api;
    let proposals = [];
    try {
      if (!api) throw new Error('offline');
      const data = await api('POST', '/studio/ai-upgrade', { bot: bot });
      proposals = Array.isArray(data.proposals) ? data.proposals : [];
    } catch (e) {
      proposals = localFallback(bot);
    }
    renderProposals(proposals, bot, preferDesk);
    if (!proposals.length) toast('No upgrades suggested right now.', 'info');
  }

  function localFallback(bot) {
    const card = bot.lastCheck || {};
    const trades = Number(card.wr1N != null ? card.wr1N : card.trades) || 0;
    const wipe = Number(card.wipeRate || 0);
    const wr1 = Number(card.wr1 || 0);
    const out = [];
    if (trades === 0) {
      out.push({
        id: 'loosen_rsi',
        title: 'Widen RSI bands',
        why: 'Paper found zero entries. Softer RSI bands usually unlock a few tries.',
        patch: { rules: { rsiLo: 36, rsiHi: 64, rsiLeave: true } }
      });
    } else if (wipe > 25 || (card.wipeChains != null ? card.wipeChains : card.wipes) > trades * 0.08) {
      out.push({
        id: 'raise_stretch',
        title: 'Raise stretch filter',
        why: 'Wipe rate is high. A clearer stretch usually cuts bad chains.',
        patch: { rules: { zScore: 2.3 } }
      });
    } else if (wr1 < 50) {
      out.push({
        id: 'tighten_filters',
        title: 'Turn on volume + wick',
        why: 'First-try WR is under 50%. Volume and rejection wick often filter noise.',
        patch: { rules: { volRankMin: 40, rejectionWick: true } }
      });
    } else {
      out.push({
        id: 'combine_charts',
        title: 'Try combined 5s + 1m',
        why: 'Combined watch asks both charts to agree for cleaner entries.',
        patch: { watchMode: 'combined', watch: ['5s', '1m'], timeframe: '5s' }
      });
    }
    return out;
  }

  document.addEventListener('click', function (ev) {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'studioAiClear') {
      const desk = document.getElementById('studioDeskAiMount');
      const recipe = document.getElementById('studioAiMount');
      if (desk) desk.innerHTML = '';
      if (recipe) recipe.innerHTML = '';
      return;
    }
    const accept = t.closest && t.closest('[data-ai-accept]');
    if (accept) {
      const idx = Number(accept.getAttribute('data-ai-accept'));
      const el = accept.closest('#studioDeskAiMount, #studioAiMount') || mountEl(false);
      const list = (el && el.__utkAiList) || [];
      const item = list[idx];
      const studio = window.__utkBotStudio;
      if (!item || !studio) return;
      const cur = studio.selected && studio.selected();
      if (!cur) return;
      const next = applyPatch(cur, item.patch);
      next.updatedAt = Date.now();
      Promise.resolve(studio.saveBot(next)).then(function () {
        toast('Upgrade applied. Re-test when ready.', 'success');
        list.splice(idx, 1);
        renderProposals(list, next, el && el.__utkAiPreferDesk);
        if (typeof studio.refresh === 'function') studio.refresh();
      });
      return;
    }
    const decline = t.closest && t.closest('[data-ai-decline]');
    if (decline) {
      const idx = Number(decline.getAttribute('data-ai-decline'));
      const el = decline.closest('#studioDeskAiMount, #studioAiMount') || mountEl(false);
      const list = (el && el.__utkAiList) || [];
      const studio = window.__utkBotStudio;
      list.splice(idx, 1);
      renderProposals(list, studio && studio.selected && studio.selected(), el && el.__utkAiPreferDesk);
    }
  });

  window.__utkStudioAi = { run: run, render: renderProposals };
})();
