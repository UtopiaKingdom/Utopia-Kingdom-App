/**
 * bot-history-ui.js — Quiet trade history: pair + result, open next to close.
 */
(function () {
  'use strict';

  const CHUNK = 20;
  let activeScrollHandler = null;
  let lastOpenBot = null;

  function escapeHtml(str) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(str);
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toMs(value) {
    try {
      if (typeof window.toEpochMs === 'function') return window.toEpochMs(value);
    } catch (e) {}
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'object') {
      try {
        if (typeof value.toMillis === 'function') return value.toMillis();
        if (typeof value.seconds === 'number') return value.seconds * 1000;
      } catch (e) {}
    }
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function formatTimeOnly(value, meta) {
    try {
      if (window.__utkTradeTime && typeof window.__utkTradeTime.formatTimeOnly === 'function') {
        return window.__utkTradeTime.formatTimeOnly(value, meta) || '';
      }
    } catch (e) {}
    const ms = toMs(value);
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (e) {
      return '';
    }
  }

  function formatDateOnly(item) {
    const meta = item && typeof item === 'object' ? item : null;
    let ms = null;
    try {
      if (window.__utkTradeTime && typeof window.__utkTradeTime.toDisplayEpochMs === 'function') {
        ms = window.__utkTradeTime.toDisplayEpochMs(
          (item && item.openedAtMs) || (item && item.timestamp) || (item && item.openingTime) || (item && item.closingTime),
          meta
        );
      }
    } catch (e) {}
    if (!ms) {
      ms =
        toMs(item && item.openedAtMs) ||
        toMs(item && item.timestamp) ||
        toMs(item && item.openingTime) ||
        toMs(item && item.closingTime);
    }
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function outcomeOf(raw) {
    try {
      if (window.__utkTradeNorm && typeof window.__utkTradeNorm.outcomeOf === 'function') {
        const n = window.__utkTradeNorm.outcomeOf(raw && raw.result != null ? raw.result : raw);
        if (n) return n;
      }
    } catch (e) {}
    const u = String(raw == null ? '' : (raw.result != null ? raw.result : raw)).trim().toUpperCase();
    if (u === 'WIN' || u === 'WON' || u === 'SUCCESS' || u === 'W') return 'WIN';
    if (u === 'LOSS' || u === 'LOSE' || u === 'LOST' || u === 'L') return 'LOSS';
    return '';
  }

  function pairOf(item) {
    try {
      if (window.__utkTradeNorm && typeof window.__utkTradeNorm.pairFrom === 'function') {
        const pretty = window.__utkTradeNorm.pairFrom(item);
        if (pretty) return pretty;
      }
    } catch (e) {}
    const cands = [item && item.selectedCurrency, item && item.symbol, item && item.currency, item && item.pair];
    for (let i = 0; i < cands.length; i++) {
      const s = String(cands[i] || '').trim();
      if (s && !/^n\/?a$/i.test(s)) return s;
    }
    return '';
  }

  function usablePrice(v) {
    if (v == null || v === '' || v === 'N/A') return '';
    return String(v);
  }

  function parsePrice(v) {
    const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
  }

  function priceDecimals(v) {
    const s = String(v == null ? '' : v).trim();
    const m = s.match(/\.(\d+)/);
    if (m) return Math.min(8, m[1].length);
    const n = parsePrice(s);
    if (n == null) return 5;
    const abs = Math.abs(n);
    if (abs >= 100) return 3;
    if (abs >= 10) return 4;
    return 5;
  }

  function formatDelta(openRaw, closeRaw) {
    const open = parsePrice(openRaw);
    const close = parsePrice(closeRaw);
    if (open == null || close == null) return null;
    const delta = close - open;
    const digits = Math.max(priceDecimals(openRaw), priceDecimals(closeRaw), 0);
    const scale = digits > 0 ? Math.pow(10, digits) : 1;
    const pips = Math.round(Math.abs(delta) * scale);
    const sign = delta > 0 ? '+' : (delta < 0 ? '-' : '');
    const dir = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
    return { text: `${sign}${pips}`, dir };
  }

  function isChainCompleteNoise(item) {
    if (!item) return true;
    if (item.chainComplete || item.chainReset) return true;
    const phase = String(item.phase || '').toLowerCase().trim();
    if (phase === 'chain complete' || phase === 'preparing' || phase === 'signal') return true;
    const result = String(item.result || '').toUpperCase().trim();
    return result === 'CHAIN_RESET' || result === 'CHAIN_LOSS' || result === 'N/A' || result === 'NA';
  }

  function isHistoryTrade(item) {
    if (isChainCompleteNoise(item)) return false;
    const r = outcomeOf(item.result);
    return r === 'WIN' || r === 'LOSS';
  }

  function legHtml(kind, time, price) {
    const t = time ? `<span class="hist-leg-time">${escapeHtml(time)}</span>` : '';
    const p = price ? `<span class="hist-leg-price">${escapeHtml(price)}</span>` : '';
    if (!t && !p) return '';
    return `<div class="hist-leg">
      <span class="hist-leg-label">${escapeHtml(kind)}</span>
      <span class="hist-leg-vals">${t}${p}</span>
    </div>`;
  }

  function makeItemHtml(item, annotated) {
    const result = outcomeOf(item.result);
    const tone = result === 'WIN' ? 'win' : (result === 'LOSS' ? 'loss' : '');
    const pair = pairOf(item);
    const actionRaw = String(item.action || item.side || '').toUpperCase().trim();
    const action = (actionRaw === 'BUY' || actionRaw === 'SELL') ? actionRaw : '';
    const actionClass = actionRaw === 'BUY' ? 'buy' : (actionRaw === 'SELL' ? 'sell' : '');
    const openPrice = usablePrice(item.openingPrice != null ? item.openingPrice : item.openPrice);
    const closePrice = usablePrice(item.closingPrice != null ? item.closingPrice : item.closePrice);
    const openTime = formatTimeOnly(item.openedAtMs || item.openingTime || item.timestamp, item);
    const closeTime = formatTimeOnly(item.closedAtMs || item.closingTime, item);
    const date = formatDateOnly(item);
    const openLeg = legHtml('Open', openTime, openPrice);
    const closeLeg = legHtml('Close', closeTime, closePrice);
    const move = formatDelta(openPrice, closePrice);
    const deltaHtml = move
      ? `<div class="hist-delta hist-delta-${move.dir}">
          <span class="hist-leg-label">Move</span>
          <span class="hist-delta-amt">${escapeHtml(move.text)}</span>
        </div>`
      : '';
    let saveMark = '';
    try {
      if (window.__utkSavingStep && typeof window.__utkSavingStep.historyBadge === 'function') {
        const row = window.__utkSavingStep.lookupAnnotation
          ? window.__utkSavingStep.lookupAnnotation(annotated, item)
          : ((annotated && item && item.id && annotated[item.id]) || null);
        saveMark = window.__utkSavingStep.historyBadge(item, row) || '';
      }
    } catch (e) {}
    const saving = saveMark
      ? `<span class="hist-save">${escapeHtml(saveMark)}</span>`
      : '';

    return `
      <article class="history-item${tone ? ` hist-${tone}` : ''}">
        <div class="hist-top">
          <span class="hist-result ${tone}">${escapeHtml(result || '—')}</span>
          <span class="hist-pair">${escapeHtml(pair)}</span>
          ${action ? `<span class="hist-action ${actionClass}">${escapeHtml(action)}</span>` : ''}
          ${saving}
          <span class="hist-date">${escapeHtml(date)}</span>
        </div>
        ${openLeg || closeLeg ? `<div class="hist-legs">${openLeg}${deltaHtml}${closeLeg}</div>` : ''}
      </article>`;
  }

  function historyItems(botKey) {
    let items = ((window.signalHistory && window.signalHistory[botKey]) || []).filter(isHistoryTrade);
    try {
      if (window.__utkPoAccountHistory && typeof window.__utkPoAccountHistory.historyForDisplay === 'function') {
        items = window.__utkPoAccountHistory.historyForDisplay(botKey, items);
      }
    } catch (e) {}
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.dedupeResultTrades === 'function') {
        items = window.__utkBotStats.dedupeResultTrades(items);
      }
    } catch (e) {}
    items.sort(function (a, b) {
      const da = toMs(a && (a.timestamp || a.openingTime || a.closingTime)) || 0;
      const db = toMs(b && (b.timestamp || b.openingTime || b.closingTime)) || 0;
      return db - da;
    });
    try {
      const dayKey = window.__utkBotStats && typeof window.__utkBotStats.getViewDayKey === 'function'
        ? window.__utkBotStats.getViewDayKey(botKey)
        : '';
      const api = window.__utkStatsDay;
      if (dayKey && api && typeof api.dayRange === 'function') {
        const range = api.dayRange(dayKey);
        if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
          const filtered = items.filter(function (item) {
            const ms = toMs(item && (item.closedAtMs || item.closingTime || item.timestamp || item.openedAtMs || item.openingTime));
            return !!ms && ms >= range.start && ms < range.end;
          });
          if (filtered.length || !items.length) items = filtered;
        }
      }
    } catch (e) {}
    return items;
  }

  function renderHistoryModal(botKey, opts) {
    opts = opts || {};
    const modal = document.getElementById('history-modal');
    const title = document.getElementById('historyModalTitle');
    const listEl = document.getElementById('historyList');
    if (!modal || !listEl || !title) return;

    const keepScroll = !!opts.keepScroll;
    const prevScroll = keepScroll ? listEl.scrollTop : 0;

    lastOpenBot = botKey;
    const customTitle = opts.title && String(opts.title).trim();
    const pretty = customTitle
      ? customTitle
      : (botKey === 'LUMIX' ? 'Lumix' : (botKey === 'MIRAX' ? 'Mirax' : (botKey === 'NYX' ? 'Nyx' : botKey)));
    let dayLabel = '';
    if (!Array.isArray(opts.items)) {
      try {
        const dayKey = window.__utkBotStats && typeof window.__utkBotStats.getViewDayKey === 'function'
          ? window.__utkBotStats.getViewDayKey(botKey)
          : '';
        if (dayKey && window.__utkStatsDay && typeof window.__utkStatsDay.formatLabel === 'function') {
          const todayKey = window.__utkStatsDay.dayKey(Date.now());
          dayLabel = dayKey === todayKey ? 'Today' : window.__utkStatsDay.formatLabel(dayKey);
        }
      } catch (e) {}
    }
    title.textContent = dayLabel ? `${pretty} history · ${dayLabel}` : `${pretty} history`;
    let items = Array.isArray(opts.items) ? opts.items.filter(isHistoryTrade) : historyItems(botKey);
    if (Array.isArray(opts.items)) {
      try {
        if (window.__utkBotStats && typeof window.__utkBotStats.dedupeResultTrades === 'function') {
          items = window.__utkBotStats.dedupeResultTrades(items);
        }
      } catch (e) {}
      items.sort(function (a, b) {
        const da = toMs(a && (a.timestamp || a.openingTime || a.closingTime || a.closedAtMs)) || 0;
        const db = toMs(b && (b.timestamp || b.openingTime || b.closingTime || b.closedAtMs)) || 0;
        return db - da;
      });
    }
    let annotated = Object.create(null);
    try {
      if (window.__utkSavingStep && typeof window.__utkSavingStep.annotateSaveSteps === 'function') {
        annotated = window.__utkSavingStep.annotateSaveSteps(items) || Object.create(null);
      }
    } catch (e) {}

    if (activeScrollHandler) {
      try { listEl.removeEventListener('scroll', activeScrollHandler); } catch (e) {}
      activeScrollHandler = null;
    }

    if (!items.length) {
      listEl.innerHTML = '<p class="history-empty">No trades yet</p>';
      modal.classList.add('active');
      return;
    }

    let rendered = 0;
    listEl.innerHTML = '';

    function appendChunk() {
      const slice = items.slice(rendered, rendered + CHUNK);
      if (!slice.length) return;
      listEl.insertAdjacentHTML('beforeend', slice.map(function (item) {
        return makeItemHtml(item, annotated);
      }).join(''));
      rendered += slice.length;
    }

    appendChunk();
    while (keepScroll && rendered < items.length && listEl.scrollHeight < prevScroll + listEl.clientHeight + 48) {
      appendChunk();
    }

    activeScrollHandler = () => {
      if (rendered < items.length && listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 48) {
        appendChunk();
      }
    };
    listEl.addEventListener('scroll', activeScrollHandler, { passive: true });
    modal.classList.add('active');
    if (keepScroll) listEl.scrollTop = prevScroll;
  }

  function wireClose() {
    const modal = document.getElementById('history-modal');
    if (!modal) return;
    modal.querySelectorAll('.history-close-btn, .modal-icon-close[data-close="history"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        modal.classList.remove('active');
      });
    });
  }

  function wireOpenButtons() {
    [
      { id: 'historyBtn-bot1', bot: 'LUMIX' },
      { id: 'historyBtn-bot2', bot: 'MIRAX' },
      { id: 'historyBtn-bot3', bot: 'NYX' },
    ].forEach(({ id, bot }) => {
      const btn = document.getElementById(id);
      if (!btn || btn.dataset.utkHistoryBound === '1') return;
      btn.dataset.utkHistoryBound = '1';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        renderHistoryModal(bot);
      });
    });
  }

  function install() {
    window.__utkRenderHistory = renderHistoryModal;
    window.renderHistoryModal = renderHistoryModal;
    window.__utkHistoryUi = {
      refresh: function (botKey) {
        const modal = document.getElementById('history-modal');
        if (!modal || !modal.classList.contains('active')) return;
        if (botKey && botKey === lastOpenBot) renderHistoryModal(botKey, { keepScroll: true });
        else if (lastOpenBot) renderHistoryModal(lastOpenBot, { keepScroll: true });
      }
    };
    wireClose();
    wireOpenButtons();
    try {
      if (window.__utkPoAccountHistory && typeof window.__utkPoAccountHistory.installHistoryHook === 'function') {
        window.__utkPoAccountHistory.installHistoryHook();
      }
    } catch (e) {}
    window.addEventListener('utk:stats-updated', function (e) {
      const modal = document.getElementById('history-modal');
      if (!modal || !modal.classList.contains('active')) return;
      const bot = e && e.detail && e.detail.bot;
      if (bot && bot === lastOpenBot) renderHistoryModal(bot, { keepScroll: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
