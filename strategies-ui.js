/**
 * strategies-ui.js — Quiet index + precise rules for each setup.
 */
(function () {
  'use strict';

  const KIND = {
    strategy1: 'Fade',
    strategy2: 'Break',
    strategy3: 'Trend',
    strategy4: 'Trap',
    strategy5: 'Impulse',
    strategy6: 'Range',
    strategy7: 'Flip',
    strategy8: 'Spike',
    strategy9: 'Squeeze',
  };

  let STRATEGIES = [];
  try {
    if (typeof window !== 'undefined' && Array.isArray(window.UTK_STRATEGIES)) {
      STRATEGIES = window.UTK_STRATEGIES;
    } else {
      STRATEGIES = require('./strategies-data.js');
    }
  } catch (e) {
    STRATEGIES = [];
  }

  let selectedId = '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function shortName(s) {
    return String((s && s.name) || '').replace(/\s+strategy$/i, '').trim() || (s && s.name) || '';
  }

  function renderChart(type) {
    try {
      if (window.utkStrategyCharts && typeof window.utkStrategyCharts.render === 'function') {
        return window.utkStrategyCharts.render(type, false);
      }
    } catch (e) {}
    return '';
  }

  function steps(arr) {
    return (arr || [])
      .map((t, i) => {
        const n = String(i + 1).padStart(2, '0');
        return `<li><span class="strat-step-n">${n}</span><span class="strat-step-t">${esc(t)}</span></li>`;
      })
      .join('');
  }

  function renderNavItem(s, index) {
    const on = s.id === selectedId ? ' is-on' : '';
    const n = String(index + 1).padStart(2, '0');
    return `
      <button type="button" class="strat-nav-item${on}" data-strategy="${esc(s.id)}" aria-current="${s.id === selectedId ? 'true' : 'false'}">
        <span class="strat-nav-n">${n}</span>
        <span class="strat-nav-copy">
          <span class="strat-nav-name">${esc(shortName(s))}</span>
          <span class="strat-nav-meta">${esc(KIND[s.id] || '')} · ${esc(s.timeframe)} · ${esc(s.expiry)}</span>
        </span>
      </button>`;
  }

  function renderDetail(s) {
    if (!s) {
      return '<p class="strat-empty">Pick a setup.</p>';
    }
    const notes = s.notes ? `<p class="strat-notes">${esc(s.notes)}</p>` : '';
    const indicators = (s.indicators || [])
      .map((t) => `<li>${esc(t)}</li>`)
      .join('');
    return `
      <div class="strat-detail-inner" data-strategy-detail="${esc(s.id)}">
        <div class="strat-detail-head">
          <p class="strat-kicker">${esc(KIND[s.id] || 'Setup')}</p>
          <h2>${esc(shortName(s))}</h2>
          <p class="strat-lead">${esc(s.tagline)}</p>
          <div class="strat-meta">
            <span><em>Candle</em> ${esc(s.timeframe)}</span>
            <span><em>Expiry</em> ${esc(s.expiry)}</span>
          </div>
        </div>
        <div class="strat-chart-wrap">${renderChart(s.chartType)}</div>
        <p class="strat-caption">${esc(s.chartCaption)}</p>
        <p class="strat-objective">${esc(s.objective)}</p>
        <div class="strat-rules">
          <section class="strat-col is-buy">
            <h3>Buy</h3>
            <ol>${steps(s.buy)}</ol>
          </section>
          <section class="strat-col is-sell">
            <h3>Sell</h3>
            <ol>${steps(s.sell)}</ol>
          </section>
        </div>
        <div class="strat-inds">
          <h3>Indicators</h3>
          <ul>${indicators}</ul>
        </div>
        ${notes}
        <div class="strat-cta">
          <button type="button" class="strat-link strategy-open-bot" data-bot="bot1">Open Lumix</button>
          <button type="button" class="strat-link strategy-open-bot" data-bot="bot2">Open Mirax</button>
        </div>
      </div>`;
  }

  function findById(id) {
    return STRATEGIES.find((s) => s.id === id) || STRATEGIES[0] || null;
  }

  function mountNav() {
    const nav = document.getElementById('strategiesNav');
    if (!nav) return;
    nav.innerHTML = STRATEGIES.map(renderNavItem).join('');
  }

  function mountDetail() {
    const pane = document.getElementById('strategiesDetail');
    if (!pane) return;
    pane.innerHTML = renderDetail(findById(selectedId));
  }

  function select(id, opts) {
    const next = findById(id);
    if (!next) return;
    selectedId = next.id;
    mountNav();
    mountDetail();
    if (opts && opts.scroll) {
      const pane = document.getElementById('strategiesDetail');
      if (pane) pane.scrollTop = 0;
    }
  }

  function openBot(botId) {
    try {
      if (window.utkBotTransitions && typeof window.utkBotTransitions.goTo === 'function') {
        window.utkBotTransitions.goTo(botId);
        return;
      }
    } catch (e) {}
    try {
      const menuBots = document.getElementById('menu-bots');
      if (typeof window.navigateToSection === 'function') {
        window.navigateToSection(botId, menuBots);
      }
    } catch (e) {}
  }

  function goStrategiesPage() {
    const menu = document.getElementById('menu-strategies');
    try {
      if (typeof window.navigateToSection === 'function') {
        window.navigateToSection('strategies', menu);
      }
    } catch (e) {}
  }

  function bindEvents() {
    document.addEventListener('click', (ev) => {
      const item = ev.target.closest && ev.target.closest('.strat-nav-item[data-strategy]');
      if (item) {
        ev.preventDefault();
        select(item.getAttribute('data-strategy'), { scroll: true });
        return;
      }
      const botBtn = ev.target.closest && ev.target.closest('.strategy-open-bot');
      if (botBtn) {
        ev.preventDefault();
        openBot(botBtn.getAttribute('data-bot') || 'bot1');
      }
    });
  }

  function patchNavigate() {
    const orig = window.navigateToSection;
    if (typeof orig !== 'function' || orig.__utkStratPatched) return;
    function wrapped(id, menu) {
      const key = String(id || '');
      if (/^strategy\d+$/.test(key)) {
        orig.call(this, 'strategies', menu || document.getElementById('menu-strategies'));
        select(key, { scroll: true });
        return;
      }
      return orig.apply(this, arguments);
    }
    wrapped.__utkStratPatched = true;
    window.navigateToSection = wrapped;
  }

  function init() {
    if (!STRATEGIES.length) {
      console.warn('strategies-ui: no strategy data');
      return;
    }
    selectedId = selectedId || STRATEGIES[0].id;
    mountNav();
    mountDetail();
    bindEvents();
    patchNavigate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.utkStrategiesUi = {
    refresh: init,
    openBot,
    select,
    goStrategiesPage,
  };
})();
