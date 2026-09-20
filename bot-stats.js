/**
 * bot-stats.js - Shared Contabo tape stats per bot.
 * Load AFTER renderer.js.
 *
 * Day view (same for every user):
 * - Calendar is Europe/Berlin 00:00–24:00
 * - Wins / S1-S4 / Wipes / trade history come from the selected day only
 * - Streak: consecutive WINs until a 5-loss wipe (live / all-time tape)
 * - Last + win-streak modal: full Contabo chain history from the start
 */
(function () {
  const BOT_IDS = { LUMIX: 'bot1', MIRAX: 'bot2', NYX: 'bot3' };
  const botStore = require('./firebase-bot-paths.js');
  /** Contabo /live poll is ~4s; board updatedAt within this window is treated as fresh. */
  const BOARD_FRESH_MS = 3 * 60 * 1000;

  const WIN_BUCKETS = [
    'stat-1x-wins',
    'stat-2x4x-wins',
    'stat-4x7x-wins',
    'stat-10x16x-wins',
    'stat-20x44x-wins'
  ];
  const streakHistoryByBot = { LUMIX: [], MIRAX: [], NYX: [] };
  const persistedHistoryByBot = { LUMIX: [], MIRAX: [], NYX: [] };
  const liveBoardByBot = { LUMIX: null, MIRAX: null, NYX: null };
  /** Last Contabo /live streak painted this session — avoid walk flashing wrong highs. */
  const lastKnownBoardStreakByBot = { LUMIX: null, MIRAX: null, NYX: null };
  const dailyByBot = { LUMIX: null, MIRAX: null, NYX: null };
  const dailyUnsub = { LUMIX: null, MIRAX: null, NYX: null };
  const dailyListenKey = { LUMIX: '', MIRAX: '', NYX: '' };
  const dayTapeByBot = { LUMIX: [], MIRAX: [], NYX: [] };
  const dayTapeUnsub = { LUMIX: null, MIRAX: null, NYX: null };
  const dayTapeListenKey = { LUMIX: '', MIRAX: '', NYX: '' };
  const dayTapeReady = { LUMIX: false, MIRAX: false, NYX: false };
  const viewDayKey = { LUMIX: '', MIRAX: '', NYX: '' };
  const todayFloorWins = { LUMIX: 0, MIRAX: 0, NYX: 0 };
  const todayFloorDay = { LUMIX: '', MIRAX: '', NYX: '' };
  const DAY_TAPE_PAD_BEFORE_MS = 6 * 60 * 60 * 1000;
  const DAY_TAPE_PAD_AFTER_MS = 2 * 60 * 60 * 1000;
  let statsDayApi = null;
  try { statsDayApi = require('./stats-day.js'); } catch (e) { statsDayApi = null; }

  function statsDay() {
    try {
      if (typeof window !== 'undefined' && window.__utkStatsDay) return window.__utkStatsDay;
    } catch (e) {}
    return statsDayApi;
  }

  function toEpochMs(value) {
    try {
      if (typeof window !== 'undefined' && window.__utkTradeTime && typeof window.__utkTradeTime.toEpochMs === 'function') {
        return window.__utkTradeTime.toEpochMs(value);
      }
    } catch (e) {}
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1e9 && value < 1e12) return value * 1000;
      return value;
    }
    if (typeof value === 'string') {
      const s = value.trim();
      if (!s || /^n\/?a$/i.test(s)) return null;
      if (/^\d{10,17}$/.test(s)) {
        const n = Number(s);
        if (!Number.isFinite(n)) return null;
        return s.length === 10 ? n * 1000 : n;
      }
      const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
      if (naive) {
        const ms = new Date(
          Number(naive[1]), Number(naive[2]) - 1, Number(naive[3]),
          Number(naive[4]), Number(naive[5]), Number(naive[6] || 0)
        ).getTime();
        return Number.isFinite(ms) ? ms : null;
      }
      const parsed = Date.parse(s);
      return Number.isNaN(parsed) ? null : parsed;
    }
    if (typeof value === 'object') {
      try {
        if (typeof value.toMillis === 'function') return value.toMillis();
        if (typeof value.seconds === 'number') return value.seconds * 1000;
      } catch (e) {}
    }
    return null;
  }

  function tradeSortMs(t) {
    try {
      if (typeof getTradeSortTimeMs === 'function') return getTradeSortTimeMs(t) || 0;
    } catch (e) {}
    return (
      toEpochMs(t && t.timestamp) ??
      toEpochMs(t && t.openingTime) ??
      toEpochMs(t && t.closingTime) ??
      toEpochMs(t && t.time) ??
      toEpochMs(t && t.createdAt) ??
      0
    );
  }

  function msFromReadableId(id) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z/.exec(String(id || ''));
    if (!m) return null;
    const utc = Date.UTC(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6])
    );
    return Number.isFinite(utc) ? utc : null;
  }

  function tradeDayMs(t) {
    try {
      if (typeof getTradeStatsDayMs === 'function') {
        const ms = getTradeStatsDayMs(t);
        if (ms) return ms;
      }
    } catch (e) {}
    return (
      toEpochMs(t && t.closedAtMs) ??
      toEpochMs(t && t.closingTime) ??
      toEpochMs(t && t.timestamp) ??
      toEpochMs(t && t.openedAtMs) ??
      toEpochMs(t && t.openingTime) ??
      toEpochMs(t && t.createdAt) ??
      toEpochMs(t && t.time) ??
      msFromReadableId(t && t.id) ??
      0
    );
  }

  function localDayKey(ms) {
    const api = statsDay();
    if (api && typeof api.dayKey === 'function') return api.dayKey(ms);
    const d = new Date(typeof ms === 'number' && ms > 0 ? ms : Date.now());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseDayStart(dateKey) {
    const api = statsDay();
    if (api && typeof api.dayStartMs === 'function') {
      const start = api.dayStartMs(dateKey);
      if (start != null) return start;
    }
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(dateKey || '').trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function getHistory(botKey) {
    let list = [];
    try {
      if (window.signalHistory && Array.isArray(window.signalHistory[botKey])) {
        list = window.signalHistory[botKey];
      }
    } catch (e) {}
    list = list.filter(function (t) {
      return !!(t && !t.optimistic && !t.localOnly);
    });
    try {
      if (window.__utkPoAccountHistory && typeof window.__utkPoAccountHistory.historyForDisplay === 'function') {
        list = window.__utkPoAccountHistory.historyForDisplay(botKey, list);
      }
    } catch (e2) {}
    return list;
  }

  /** Streak walk includes optimistic rows until Contabo confirms (dedupe drops twins). */
  function getStatsHistory(botKey) {
    let list = [];
    try {
      if (window.signalHistory && Array.isArray(window.signalHistory[botKey])) {
        list = window.signalHistory[botKey];
      }
    } catch (e) {}
    list = list.filter(function (t) {
      return !!(t && !t.localOnly);
    });
    try {
      if (window.__utkPoAccountHistory && typeof window.__utkPoAccountHistory.historyForDisplay === 'function') {
        list = window.__utkPoAccountHistory.historyForDisplay(botKey, list);
      }
    } catch (e2) {}
    return list;
  }

  function getSelectedDayKey(botKey) {
    try {
      if (typeof getSelectedStatsDateKey === 'function') {
        const key = getSelectedStatsDateKey(botKey);
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return key;
      }
    } catch (e) {}
    const botId = BOT_IDS[botKey];
    try {
      const input = botId && document.getElementById('statsDateInput-' + botId);
      const v = input && String(input.value || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    } catch (e) {}
    return localDayKey(Date.now());
  }

  function getDayRange(botKey) {
    const key = getSelectedDayKey(botKey);
    const api = statsDay();
    if (api && typeof api.dayRange === 'function') {
      const range = api.dayRange(key);
      if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) return range;
    }
    const start = parseDayStart(key) ?? (function () {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    return { key: key, start: start, end: start + 24 * 60 * 60 * 1000 };
  }

  function rangeForDateKey(dateKey) {
    const key = /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || '')) ? String(dateKey) : localDayKey(Date.now());
    const api = statsDay();
    if (api && typeof api.dayRange === 'function') {
      const range = api.dayRange(key);
      if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) return range;
    }
    const start = parseDayStart(key) || Date.now();
    return { key: key, start: start, end: start + 24 * 60 * 60 * 1000 };
  }

  function inDayCount(list, range) {
    let n = 0;
    (list || []).forEach(function (t) {
      if (!isResultTrade(t) || !range) return;
      const ts = tradeDayMs(t);
      if (ts >= range.start && ts < range.end) n += 1;
    });
    return n;
  }

  function newestResultDayKey(list) {
    let best = 0;
    (list || []).forEach(function (t) {
      if (!isResultTrade(t)) return;
      const ts = tradeDayMs(t);
      if (ts > best) best = ts;
    });
    return best > 0 ? localDayKey(best) : '';
  }

  /**
   * Auto/"Today" with no trades yet (just after Berlin midnight) keeps showing
   * the last Berlin day that actually has results, so stats match history.
   */
  function resolveViewRange(botKey, list) {
    let range = getDayRange(botKey);
    const todayKey = localDayKey(Date.now());
    const rows = list || getHistory(botKey);
    if (range.key === todayKey && inDayCount(rows, range) === 0) {
      const lastDay = newestResultDayKey(rows);
      if (lastDay && lastDay !== todayKey) range = rangeForDateKey(lastDay);
    }
    viewDayKey[botKey] = range.key;
    return range;
  }

  function getViewDayKey(botKey) {
    const key = String(botKey || '').toUpperCase();
    if (viewDayKey[key]) return viewDayKey[key];
    return resolveViewRange(key).key;
  }

  function canonSymKey(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/OTC/g, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  function fieldEmpty(v) {
    return v == null || v === '' || v === 'N/A' || /^n\/?a$/i.test(String(v));
  }

  function priceKey(v) {
    if (fieldEmpty(v)) return '';
    const n = Number(v);
    if (Number.isFinite(n)) return String(n);
    return String(v);
  }

  function completenessScore(t) {
    if (!t) return -1;
    let n = 0;
    const action = String(t.action || t.side || '').toUpperCase();
    if (action === 'BUY' || action === 'SELL') n += 3;
    if (!fieldEmpty(t.openingPrice != null ? t.openingPrice : t.openPrice)) n += 2;
    if (!fieldEmpty(t.closingPrice != null ? t.closingPrice : t.closePrice)) n += 2;
    const pair = String(t.selectedCurrency || t.symbol || t.currency || '').trim();
    if (pair && !/^n\/?a$/i.test(pair)) n += 3;
    if (!t.optimistic) n += 1;
    return n;
  }

  function fillMissingTradeFields(dst, src) {
    if (!dst || !src) return dst;
    ['action', 'side', 'symbol', 'selectedCurrency', 'currency',
      'openingPrice', 'closingPrice', 'openingTime', 'closingTime',
      'openPrice', 'closePrice'].forEach(function (k) {
      if (fieldEmpty(dst[k]) && !fieldEmpty(src[k])) dst[k] = src[k];
    });
    const dstPair = String(dst.selectedCurrency || dst.symbol || dst.currency || '').trim();
    if (!dstPair || /^n\/?a$/i.test(dstPair)) {
      if (!fieldEmpty(src.selectedCurrency)) dst.selectedCurrency = src.selectedCurrency;
      if (!fieldEmpty(src.symbol)) dst.symbol = src.symbol;
      if (!fieldEmpty(src.currency)) dst.currency = src.currency;
    }
    return dst;
  }

  function preferCompleteTrade(a, b) {
    let keep;
    let drop;
    if (a.optimistic && !b.optimistic) { keep = b; drop = a; }
    else if (!a.optimistic && b.optimistic) { keep = a; drop = b; }
    else if (completenessScore(b) > completenessScore(a)) { keep = b; drop = a; }
    else if (completenessScore(a) > completenessScore(b)) { keep = a; drop = b; }
    else if (stableTradeSort(b, a) > 0) { keep = b; drop = a; }
    else { keep = a; drop = b; }
    return fillMissingTradeFields(Object.assign({}, keep), drop);
  }

  function isSparseResult(t) {
    if (!t) return true;
    const action = String(t.action || t.side || '').toUpperCase();
    const hasAction = action === 'BUY' || action === 'SELL';
    const open = t.openingPrice != null ? t.openingPrice : t.openPrice;
    const close = t.closingPrice != null ? t.closingPrice : t.closePrice;
    const pair = String(t.selectedCurrency || t.symbol || t.currency || '').trim();
    const hasPair = !!(pair && !/^n\/?a$/i.test(pair));
    return !hasAction || fieldEmpty(open) || fieldEmpty(close) || !hasPair;
  }

  function tradeOpenParts(t) {
    const empty = { bot: '', open: 0, sym: '', id: '', idParts: [] };
    if (!t) return empty;
    let bot = String(t.bot || t.botKey || '').toUpperCase();
    const id = String(t.id || '').trim();
    let idParts = id ? id.split('__') : [];
    if (idParts[0] === 'optimistic') idParts = idParts.slice(1);
    if (!bot && idParts.length) bot = String(idParts[0] || '').toUpperCase();

    let open = toEpochMs(t.openedAtMs);
    if (open == null) open = toEpochMs(t.openingTime);
    if (open == null) open = toEpochMs(t.timestamp);
    if ((open == null || !open) && idParts.length >= 4) {
      const maybeOpen = idParts[idParts.length - 1];
      if (/^\d{10,}$/.test(maybeOpen)) open = Number(maybeOpen);
      else {
        const prev = idParts[idParts.length - 2];
        if (/^\d{10,}$/.test(prev)) open = Number(prev);
      }
    }
    open = Math.trunc(Number(open) || 0);

    let sym = canonSymKey(t.symbol || t.currency || t.selectedCurrency);
    if (!sym && idParts.length >= 4) {
      const pairPart = idParts.find(function (p) {
        return p && !/^(WIN|LOSS|W|L)$/i.test(p) && !/^a\d+$/i.test(p) && !/^\d{10,}$/.test(p) && !/^\d{8}-\d{6}Z$/.test(p);
      });
      if (pairPart) sym = canonSymKey(pairPart);
    }
    return { bot: bot, open: open, sym: sym, id: id, idParts: idParts };
  }

  /**
   * Same ticket even when live saving rewrites attempt (a1 tape vs a4 optimistic).
   */
  function tradeFillIdentity(t) {
    const p = tradeOpenParts(t);
    if (!p.open) return 'id|' + (p.id || String(tradeSortMs(t) || '') || 'na');
    return p.bot + '|' + p.sym + '|' + p.open;
  }

  /**
   * Stable identity for one MG step: bot + symbol + open ms + attempt.
   * Used to dedupe optimistic placeholders against Firebase rows
   * (Firebase ids end with close-ms, so id-parsing alone double-counts).
   */
  function tradeOpenIdentity(t) {
    const p = tradeOpenParts(t);
    if (!p.open) {
      return 'id|' + (p.id || String(tradeSortMs(t) || '') || 'na');
    }
    let attempt = null;
    if (t.attempt != null && Number.isFinite(Number(t.attempt))) {
      attempt = Math.max(1, Math.trunc(Number(t.attempt)));
    } else if (p.idParts.length) {
      const attPart = p.idParts.find(function (part) { return /^a\d+$/i.test(part); });
      const m = attPart && /^a(\d+)$/i.exec(attPart);
      if (m) attempt = Math.max(1, parseInt(m[1], 10) || 1);
    }
    if (attempt == null) attempt = 1;
    return p.bot + '|' + p.sym + '|' + p.open + '|' + attempt;
  }

  // Back-compat alias used by older call sites / tests.
  function tradeLogicKey(t) {
    return tradeOpenIdentity(t);
  }

  function stableTradeSort(a, b) {
    const da = tradeSortMs(a) - tradeSortMs(b);
    if (da !== 0) return da;
    const ca = toEpochMs(a && a.createdAt) || 0;
    const cb = toEpochMs(b && b.createdAt) || 0;
    if (ca !== cb) return ca - cb;
    return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
  }

  function priceFingerprint(t) {
    const sym = canonSymKey(t && (t.symbol || t.currency || t.selectedCurrency));
    const res = String((t && t.result) || '').toUpperCase();
    const open = priceKey(t && (t.openingPrice != null ? t.openingPrice : t.openPrice));
    const close = priceKey(t && (t.closingPrice != null ? t.closingPrice : t.closePrice));
    if (!open || !close) {
      return 'id|' + tradeLogicKey(t);
    }
    return sym + '|' + res + '|' + open + '|' + close;
  }

  function dedupeResultTrades(list) {
    const byKey = Object.create(null);
    const passthrough = [];
    list.forEach(function (t) {
      if (!isResultTrade(t)) {
        passthrough.push(t);
        return;
      }
      const key = tradeLogicKey(t);
      const prev = byKey[key];
      if (!prev) {
        byKey[key] = t;
        return;
      }
      byKey[key] = preferCompleteTrade(prev, t);
    });
    const byFill = Object.create(null);
    Object.keys(byKey).forEach(function (k) {
      const t = byKey[k];
      const fill = tradeFillIdentity(t);
      const prev = byFill[fill];
      if (!prev) {
        byFill[fill] = t;
        return;
      }
      byFill[fill] = preferCompleteTrade(prev, t);
    });
    const identityDeduped = passthrough.concat(Object.keys(byFill).map(function (k) { return byFill[k]; }));
    return collapseOverlaps(identityDeduped);
  }

  function collapseOverlaps(list) {
    try {
      if (window.__utkSavingHistory && typeof window.__utkSavingHistory.collapseOverlappingResults === 'function') {
        return window.__utkSavingHistory.collapseOverlappingResults(list);
      }
    } catch (e) {}
    return list;
  }

  function isResultTrade(t) {
    if (!t || t.localOnly) return false;
    // Optimistic results count for live UI; confirmed rows replace them via dedupe.
    const res = String(t.result || '').toLowerCase().trim();
    return ['win', 'won', 'success', 'w', 'loss', 'lose', 'lost', 'l'].indexOf(res) !== -1;
  }

  function parseOutcome(t) {
    const res = String((t && t.result) || '').toLowerCase().trim();
    return {
      isWin: res === 'win' || res === 'won' || res === 'success' || res === 'w',
      isLoss: res === 'loss' || res === 'lose' || res === 'lost' || res === 'l'
    };
  }

  function setText(id, value, opts) {
    const pulse = !opts || opts.pulse !== false;
    const el = document.getElementById(id);
    if (!el) return;
    const next = String(value);
    if (el.textContent === next) return;
    el.textContent = next;
    if (!pulse) return;
    try {
      const item = el.closest('.stat-item') || el.closest('.win-streak-badge') || el.closest('.best-streak-badge');
      if (!item) return;
      item.classList.remove('stat-pulse');
      void item.offsetWidth;
      item.classList.add('stat-pulse');
      clearTimeout(item._utkPulseTimer);
      item._utkPulseTimer = setTimeout(function () { item.classList.remove('stat-pulse'); }, 420);
    } catch (e) {}
  }

  function setWinStreak(botKey, value) {
    const botId = BOT_IDS[botKey];
    if (!botId) return;
    const streakValue = Math.max(0, parseInt(value, 10) || 0);
    setText('winStreakValue-' + botId, streakValue);
    const badge = document.getElementById('winStreakBadge-' + botId);
    const heat = Math.max(0, Math.min(1, streakValue / 10));
    if (badge) {
      badge.classList.toggle('is-hot', streakValue >= 3);
      badge.style.setProperty('--streak-heat-pct', Math.round(heat * 100) + '%');
      badge.style.setProperty('--streak-heat-n', String(heat));
      badge.title = 'Consecutive wins since last 5-loss wipe (MG losses do not reset)';
    }
  }

  function setBestStreak(botKey, value) {
    const botId = BOT_IDS[botKey];
    if (!botId) return;
    setText('bestStreakValue-' + botId, Math.max(0, parseInt(value, 10) || 0));
  }

  function paintAvgWait(botKey, trades) {
    const botId = BOT_IDS[botKey];
    if (!botId) return;
    let wait = { label: '—', title: 'Average wait between new signals over the last 3 hours' };
    try {
      if (window.__utkSignalWait && typeof window.__utkSignalWait.fromTrades === 'function') {
        wait = window.__utkSignalWait.fromTrades(trades) || wait;
      }
    } catch (e) {}
    const el = document.getElementById('stat-avg-wait-' + botId);
    if (el && el.textContent !== String(wait.label || '—')) {
      el.textContent = wait.label || '—';
    } else if (el && !el.textContent) {
      el.textContent = wait.label || '—';
    }
    const item = el && el.closest('.stat-item');
    if (item && wait.title) item.setAttribute('title', wait.title);
  }

  function refreshTotal(botId) {
    let total = 0;
    WIN_BUCKETS.forEach(function (k) {
      const n = parseInt((document.getElementById(k + '-' + botId) || {}).textContent || '', 10);
      if (Number.isFinite(n)) total += n;
    });
    setText('stat-total-wins-' + botId, total);
  }

  function syncDateButton(botKey, selectedKey) {
    try {
      const botId = BOT_IDS[botKey];
      if (!botId) return;
      const btn = document.getElementById('statsDateBtn-' + botId);
      if (!btn) return;
      const todayKey = localDayKey(Date.now());
      if (selectedKey === todayKey) {
        btn.textContent = 'Today';
      } else if (typeof formatStatsDateLabel === 'function') {
        btn.textContent = formatStatsDateLabel(selectedKey);
      } else {
        btn.textContent = selectedKey;
      }
      const todayBtn = document.getElementById('statsDateToday-' + botId);
      if (todayBtn) todayBtn.classList.toggle('is-active', selectedKey === todayKey);
    } catch (e) {}
  }

  function tradeAttempt(t) {
    if (t && t.attempt != null && Number.isFinite(Number(t.attempt))) {
      return Math.min(5, Math.max(1, Math.trunc(Number(t.attempt))));
    }
    const id = String((t && t.id) || '');
    const m = /(?:^|__)a(\d+)(?:__|$)/.exec(id);
    if (m) return Math.min(5, Math.max(1, parseInt(m[1], 10) || 1));
    return 1;
  }

  /**
   * Win streak counts consecutive WINs. It ends on a 5-loss wipe of the live
   * save ladder (pair hops keep the step). Win buckets use max(stored, loss run).
   */
  function walkStats(ordered, range) {
    const counts = {
      'stat-1x-wins': 0,
      'stat-2x4x-wins': 0,
      'stat-4x7x-wins': 0,
      'stat-10x16x-wins': 0,
      'stat-20x44x-wins': 0,
      'stat-losses': 0
    };

    let winStreak = 0;
    let lossRun = 0;
    let dayEndWinStreak = 0;
    let maxDayWinStreak = 0;
    const completed = [];
    let streakStartMs = null;

    ordered.forEach(function (t) {
      if (!isResultTrade(t)) return;
      const outcome = parseOutcome(t);
      const ts = tradeDayMs(t);
      const inDay = ts >= range.start && ts < range.end;
      const beforeDayEnd = ts < range.end;

      if (outcome.isLoss) {
        lossRun += 1;
        if (lossRun >= 5) {
          if (winStreak > 0) {
            completed.push({
              length: winStreak,
              startedAt: streakStartMs,
              endedAt: ts || null
            });
          }
          if (inDay) counts['stat-losses'] += 1;
          winStreak = 0;
          streakStartMs = null;
          lossRun = 0;
        }
        if (beforeDayEnd) dayEndWinStreak = winStreak;
        return;
      }

      if (outcome.isWin) {
        // MIRAX hops reset WS attempt to 1; the live save ladder does not.
        const stored = tradeAttempt(t);
        const derived = Math.min(5, lossRun + 1);
        const attempt = Math.max(stored, derived);
        lossRun = 0;
        const idx = Math.min(Math.max(0, attempt - 1), 4);
        if (inDay) {
          const bucket = WIN_BUCKETS[idx];
          if (bucket) counts[bucket] += 1;
        }
        if (winStreak === 0) streakStartMs = ts || null;
        winStreak += 1;
        if (inDay && winStreak > maxDayWinStreak) maxDayWinStreak = winStreak;
        if (beforeDayEnd) dayEndWinStreak = winStreak;
      }
    });

    return {
      counts: counts,
      liveWinStreak: winStreak,
      dayEndWinStreak: dayEndWinStreak,
      maxDayWinStreak: maxDayWinStreak,
      completed: completed
    };
  }

  function asStreakEntry(raw) {
    if (!raw) return null;
    const length = Math.max(0, parseInt(raw.length, 10) || 0);
    if (length <= 0) return null;
    const endedAt = raw.endedAt != null ? Number(raw.endedAt) : NaN;
    const startedAt = raw.startedAt != null ? Number(raw.startedAt) : NaN;
    return {
      id: raw.id || ('hist__' + length + '__' + (Number.isFinite(endedAt) ? endedAt : 0)),
      length: length,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      endedAt: Number.isFinite(endedAt) ? endedAt : null
    };
  }

  /**
   * Last / modal: rebuild from 5-loss wipes in the tape walk, then Contabo /streaks.
   * Board lastCompleted is only a fallback when both lists are empty.
   * Never trust Firebase pastWinStreaks (hop-fakes / truncated).
   */
  function mergeCompletedStreaks(persisted, walkedCompleted, board) {
    const out = [];
    const seen = Object.create(null);

    function dedupeKey(entry) {
      const ended = Number(entry.endedAt) || 0;
      const minute = ended > 0 ? Math.round(ended / 60000) : 0;
      return String(entry.length) + ':' + minute;
    }

    function add(raw) {
      const entry = asStreakEntry(raw);
      if (!entry) return;
      const key = dedupeKey(entry);
      if (seen[key]) return;
      seen[key] = 1;
      out.push(entry);
    }

    (walkedCompleted || []).forEach(add);
    (persisted || []).forEach(add);

    if (!out.length && board) {
      const boardLen = Math.max(0, parseInt(board.lastCompletedStreak, 10) || 0);
      if (boardLen > 0) {
        add({
          length: boardLen,
          endedAt: board.lastCompletedStreakEndedAt
        });
      }
    }

    out.sort(function (a, b) {
      return (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0);
    });
    return out;
  }

  function lastStreakForRange(merged, range) {
    if (!merged || !merged.length || !range) return 0;
    for (let i = 0; i < merged.length; i++) {
      const ended = Number(merged[i].endedAt);
      if (Number.isFinite(ended) && ended >= range.start && ended < range.end) {
        return Math.max(0, parseInt(merged[i].length, 10) || 0);
      }
    }
    return 0;
  }

  /**
   * Completed streak history for Last badge + modal: Contabo /streaks only.
   * Local tape walk must not change what everyone sees.
   */
  function completedStreaksFromContabo(persisted, board) {
    const out = [];
    const seen = Object.create(null);

    function add(raw) {
      const entry = asStreakEntry(raw);
      if (!entry) return;
      const key = String(entry.length) + ':' + (Math.round((Number(entry.endedAt) || 0) / 60000));
      if (seen[key]) return;
      seen[key] = 1;
      out.push(entry);
    }

    (persisted || []).forEach(add);
    if (!out.length && board) {
      const boardLen = Math.max(0, parseInt(board.lastCompletedStreak, 10) || 0);
      if (boardLen > 0) {
        add({
          length: boardLen,
          endedAt: board.lastCompletedStreakEndedAt
        });
      }
    }
    out.sort(function (a, b) {
      return (Number(b.endedAt) || 0) - (Number(a.endedAt) || 0);
    });
    return out;
  }

  /**
   * Last badge: always the newest completed wipe from full Contabo history.
   * Day picker only scopes trade history / daily win buckets, not win chains.
   */
  function lastStreakToShow(merged) {
    if (!merged || !merged.length) return 0;
    return Math.max(0, parseInt(merged[0].length, 10) || 0);
  }

  /**
   * Live streak: Contabo /live board is the single source of truth so every
   * client sees the same number.
   * Never paint today's streak from a local tape walk (partial history can
   * flash a high mid-chain number, then snap to Contabo after /live arrives —
   * e.g. 34 → 8). Offline: keep last known Contabo value, else 0 until /live.
   * MG losses 1–4 never reset; only a 5-loss wipe zeros the board.
   */
  function pickLiveStreak(walked, boardStreak, hasResults, opts) {
    const fromWalk = Math.max(0, parseInt(walked, 10) || 0);
    const fromBoard = Math.max(0, parseInt(boardStreak, 10) || 0);
    const boardPresent = !!(opts && opts.boardPresent);
    const botKey = String((opts && opts.botKey) || '').toUpperCase();

    if (boardPresent) {
      if (botKey && Object.prototype.hasOwnProperty.call(lastKnownBoardStreakByBot, botKey)) {
        lastKnownBoardStreakByBot[botKey] = fromBoard;
      }
      const optAhead = Math.max(0, parseInt(opts && opts.optimisticWinDelta, 10) || 0);
      // Allow at most a tiny optimistic lead from WINs that just hit the UI
      // before Contabo /live has caught up — never a full walk recount.
      if (optAhead > 0 && fromWalk > fromBoard) {
        return Math.min(fromWalk, fromBoard + optAhead);
      }
      return fromBoard;
    }

    if (botKey && lastKnownBoardStreakByBot[botKey] != null) {
      return Math.max(0, parseInt(lastKnownBoardStreakByBot[botKey], 10) || 0);
    }
    // Cold start: do not invent streak from walk.
    void fromWalk;
    void hasResults;
    return 0;
  }

  function countsFromDaily(daily) {
    return {
      'stat-1x-wins': Math.max(0, parseInt(daily && daily.entry, 10) || 0),
      'stat-2x4x-wins': Math.max(0, parseInt(daily && daily.s1, 10) || 0),
      'stat-4x7x-wins': Math.max(0, parseInt(daily && daily.s2, 10) || 0),
      'stat-10x16x-wins': Math.max(0, parseInt(daily && daily.s3, 10) || 0),
      'stat-20x44x-wins': Math.max(0, parseInt(daily && daily.s4, 10) || 0),
      'stat-losses': Math.max(0, parseInt(daily && daily.wipes, 10) || 0)
    };
  }

  function walkedWinTotal(counts) {
    let n = 0;
    WIN_BUCKETS.forEach(function (k) { n += Number(counts && counts[k]) || 0; });
    return n;
  }

  function getDb() {
    try {
      if (typeof db !== 'undefined' && db) return db;
      if (typeof window !== 'undefined' && window.db) return window.db;
    } catch (e) {}
    return null;
  }

  function stopDailyListen(botKey) {
    const key = String(botKey || '').toUpperCase();
    if (typeof dailyUnsub[key] === 'function') {
      try { dailyUnsub[key](); } catch (e) {}
    }
    dailyUnsub[key] = null;
    dailyListenKey[key] = '';
  }

  function listenDailyStats(botKey, dateKey) {
    const key = String(botKey || '').toUpperCase();
    dailyByBot[key] = null;
    dailyListenKey[key] = /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || '')) ? String(dateKey) : '';
    dailyUnsub[key] = null;
  }

  function stopDayTape(botKey) {
    const key = String(botKey || '').toUpperCase();
    if (typeof dayTapeUnsub[key] === 'function') {
      try { dayTapeUnsub[key](); } catch (e) {}
    }
    dayTapeUnsub[key] = null;
    dayTapeListenKey[key] = '';
    dayTapeReady[key] = false;
  }

  function listenDayTape(botKey) {
    const key = String(botKey || '').toUpperCase();
    if (!BOT_IDS[key]) return;
    dayTapeReady[key] = true;
  }

  function overlayOptimisticOnBoard(botKey, board) {
    return Object.assign({}, board || botStore.emptyLiveBoard(botKey));
  }

  function setLiveBoard(botKey, data) {
    const key = String(botKey || '').toUpperCase();
    if (!BOT_IDS[key]) return;
    liveBoardByBot[key] = data && typeof data === 'object' ? data : null;
  }

  function setPersistedHistory(botKey, list) {
    const key = String(botKey || '').toUpperCase();
    if (!BOT_IDS[key]) return;
    const rows = Array.isArray(list) ? list : [];
    persistedHistoryByBot[key] = rows.map(asStreakEntry).filter(Boolean);
  }

  function recompute(botKey) {
    const key = String(botKey || '').toUpperCase();
    const botId = BOT_IDS[key];
    if (!botId) return;

    try {
      if (typeof signalHistory !== 'undefined') window.signalHistory = signalHistory;
    } catch (e) {}

    listenDayTape(key);

    const hist = getStatsHistory(key);
    const tape = dayTapeByBot[key] || [];
    const source = tape.length ? tape.concat(hist) : hist;
    const all = dedupeResultTrades(source);
    const ordered = all.slice().sort(stableTradeSort);
    paintAvgWait(key, ordered);
    const range = resolveViewRange(key, ordered);
    try {
      if (window.__utkResultsHistory && typeof window.__utkResultsHistory.ensureDay === 'function') {
        window.__utkResultsHistory.ensureDay(key, range.key);
      }
    } catch (e) {}
    listenDailyStats(key, range.key);
    syncDateButton(key, range.key);
    try {
      const input = document.getElementById('statsDateInput-' + botId);
      if (input) input.value = range.key;
    } catch (e) {}

    if (todayFloorDay[key] !== range.key) {
      todayFloorWins[key] = 0;
      todayFloorDay[key] = range.key;
    }

    const result = walkStats(ordered, range);
    const hasTape = ordered.some(isResultTrade);
    const daily = dailyByBot[key];
    const dailyWins = daily ? Math.max(0, parseInt(daily.wins, 10) || 0) : 0;
    const walkedWins = walkedWinTotal(result.counts);
    const todayKey = localDayKey(Date.now());
    const isToday = range.key === todayKey;
    let stillLoading = false;
    try {
      stillLoading = !!(window.__utkResultsHistory && window.__utkResultsHistory.loading[key]);
    } catch (e) {}

    if (isToday && !dayTapeReady[key] && todayFloorWins[key] > walkedWins) {
      return;
    }
    if (stillLoading && walkedWins === 0 && !hasTape) {
      return;
    }

    let counts = result.counts;
    if (walkedWins === 0 && daily && String(daily.date || '') === range.key && dailyWins > 0 && !hasTape) {
      counts = countsFromDaily(daily);
    }

    if (isToday && walkedWins > (todayFloorWins[key] || 0)) {
      todayFloorWins[key] = walkedWins;
    }

    Object.keys(counts).forEach(function (k) {
      setText(k + '-' + botId, counts[k]);
    });
    refreshTotal(botId);

    const liveBoard = liveBoardByBot[key];

    const walked = isToday ? result.liveWinStreak : result.dayEndWinStreak;
    const hasResults = ordered.some(isResultTrade);
    let boardStreak = 0;
    const boardPresent = !!(
      isToday &&
      liveBoard &&
      (liveBoard.currentWinStreak != null || Number(liveBoard.updatedAt) > 0)
    );
    if (boardPresent) {
      try {
        const overlaid = overlayOptimisticOnBoard(key, liveBoard);
        boardStreak = Math.max(0, parseInt(overlaid.currentWinStreak, 10) || 0);
      } catch (e) {
        boardStreak = Math.max(0, parseInt(liveBoard.currentWinStreak, 10) || 0);
      }
    }

    let optimisticWinDelta = 0;
    if (isToday && boardPresent) {
      for (let i = 0; i < ordered.length; i++) {
        const t = ordered[i];
        if (!t || !t.optimistic || !isResultTrade(t)) continue;
        if (parseOutcome(t).isWin) optimisticWinDelta += 1;
      }
    }

    const lastWipeAt = Number(liveBoard && liveBoard.lastCompletedStreakEndedAt) || 0;
    const boardUpdatedAt = Number(liveBoard && liveBoard.updatedAt) || 0;
    const boardFresh = boardUpdatedAt > 0 && (Date.now() - boardUpdatedAt) < BOARD_FRESH_MS;

    // Historical day view: streak at end of that Berlin day from the tape walk.
    // Today / live: Contabo board (same for every user).
    const streakShown = isToday
      ? pickLiveStreak(walked, boardStreak, hasResults, {
          botKey: key,
          boardPresent: boardPresent,
          boardFresh: boardFresh,
          optimisticWinDelta: optimisticWinDelta,
          lastWipeAt: lastWipeAt,
          boardUpdatedAt: boardUpdatedAt
        })
      : walked;
    setWinStreak(key, streakShown);

    streakHistoryByBot[key] = completedStreaksFromContabo(
      persistedHistoryByBot[key] || [],
      liveBoard
    );

    const lastForDay = lastStreakToShow(streakHistoryByBot[key]);
    setBestStreak(key, lastForDay);

    try {
      if (typeof statsLossStreak !== 'undefined') statsLossStreak[key] = 0;
      if (typeof statsWinStreak !== 'undefined') statsWinStreak[key] = streakShown;
      if (typeof statsBestWinStreak !== 'undefined') statsBestWinStreak[key] = lastForDay;
    } catch (e) {}

    try {
      window.dispatchEvent(new CustomEvent('utk:stats-updated', { detail: { bot: key, source: 'recompute' } }));
    } catch (e) {}
  }

  function getWinStreakHistory(botKey) {
    const key = String(botKey || '').toUpperCase();
    const list = streakHistoryByBot[key];
    return Array.isArray(list) ? list.slice() : [];
  }

  function ensureHistory(botKey) {
    const key = String(botKey || '').toUpperCase();
    try {
      if (typeof signalHistory !== 'undefined') {
        if (!signalHistory[key]) signalHistory[key] = [];
        window.signalHistory = signalHistory;
        return signalHistory[key];
      }
    } catch (e) {}
    try {
      if (!window.signalHistory) window.signalHistory = {};
      if (!window.signalHistory[key]) window.signalHistory[key] = [];
      return window.signalHistory[key];
    } catch (e2) {}
    return [];
  }

  function normalizeLiveResult(data) {
    if (!data || typeof data !== 'object') return null;
    const res = String(data.result || '').toUpperCase().trim();
    let result = null;
    if (res === 'WIN' || res === 'WON' || res === 'SUCCESS' || res === 'W') result = 'WIN';
    else if (res === 'LOSS' || res === 'LOSE' || res === 'LOST' || res === 'L') result = 'LOSS';
    if (!result) return null;

    const openingTime =
      toEpochMs(data.openedAtMs) ??
      toEpochMs(data.opened_at_ms) ??
      toEpochMs(data.openingTime) ??
      toEpochMs(data.opening_time) ??
      toEpochMs(data.startTime) ??
      toEpochMs(data.timestamp) ??
      toEpochMs(data.time) ??
      Date.now();
    const closingTime =
      toEpochMs(data.closedAtMs) ??
      toEpochMs(data.closed_at_ms) ??
      toEpochMs(data.closingTime) ??
      toEpochMs(data.closing_time) ??
      toEpochMs(data.timestamp) ??
      Date.now();
    let symbol = String(
      data.selectedCurrency || data.symbol || data.currency || data.pair || ''
    ).trim();
    try {
      if (window.__utkTradeNorm && typeof window.__utkTradeNorm.prettyOtcPair === 'function') {
        symbol = window.__utkTradeNorm.prettyOtcPair(symbol) || symbol;
      }
    } catch (e) {}
    const attempt = Number.isFinite(Number(data.attempt)) ? Number(data.attempt) : 1;
    const actionRaw = String(data.action || data.side || '').toUpperCase().trim();
    const action = (actionRaw === 'BUY' || actionRaw === 'SELL') ? actionRaw : '';
    const openingPrice = (data.openingPrice != null && data.openingPrice !== 'N/A')
      ? data.openingPrice
      : (data.openPrice != null ? data.openPrice : null);
    const closingPrice = (data.closingPrice != null && data.closingPrice !== 'N/A')
      ? data.closingPrice
      : (data.closePrice != null ? data.closePrice : (data.price != null ? data.price : null));
    return {
      result: result,
      openingTime: openingTime,
      closingTime: closingTime,
      openedAtMs: openingTime,
      closedAtMs: closingTime,
      timestamp: openingTime || closingTime || Date.now(),
      symbol: symbol,
      currency: symbol,
      selectedCurrency: symbol,
      action: action,
      side: action,
      openingPrice: openingPrice,
      closingPrice: closingPrice,
      attempt: attempt,
      stakeMultiplier: data.stakeMultiplier != null ? Number(data.stakeMultiplier) : null,
      phase: 'Trading Result'
    };
  }

  /**
   * Inject a live WIN/LOSS into history immediately so streak/stats UI updates
   * before Firebase round-trip. Confirmed trades replace these via dedupe.
   */
  function applyOptimisticLiveResult(botKey, data) {
    const key = String(botKey || '').toUpperCase();
    if (key !== 'LUMIX' && key !== 'MIRAX' && key !== 'NYX') return false;
    const norm = normalizeLiveResult(data);
    if (!norm) return false;

    const hist = ensureHistory(key);
    const open = Math.trunc(Number(norm.openingTime) || Date.now());
    const attempt = Math.max(1, parseInt(norm.attempt, 10) || 1);
    const sym = String(norm.symbol || 'UNK').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'UNK';
    const optimisticId = 'optimistic__' + key + '__' + sym + '__' + open + '__a' + attempt;

    const row = {
      id: optimisticId,
      bot: key,
      optimistic: true,
      result: norm.result,
      phase: 'Trading Result',
      openingTime: norm.openingTime,
      closingTime: norm.closingTime,
      openedAtMs: norm.openedAtMs || norm.openingTime,
      closedAtMs: norm.closedAtMs || norm.closingTime,
      timestamp: norm.timestamp,
      createdAt: Date.now(),
      symbol: norm.symbol,
      currency: norm.currency,
      selectedCurrency: norm.selectedCurrency,
      action: norm.action || '',
      side: norm.side || norm.action || '',
      openingPrice: norm.openingPrice,
      closingPrice: norm.closingPrice,
      attempt: attempt,
      stakeMultiplier: norm.stakeMultiplier
    };

    const logicKey = tradeOpenIdentity(row);
    const fillKey = tradeFillIdentity(row);
    try {
      if (window.__utkSavingHistory && typeof window.__utkSavingHistory.overlapsAsGhost === 'function') {
        if (window.__utkSavingHistory.overlapsAsGhost(hist, row)) return false;
      }
      if (window.__utkSavingHistory && typeof window.__utkSavingHistory.pruneCoveredGhosts === 'function') {
        const pruned = window.__utkSavingHistory.pruneCoveredGhosts(hist, row);
        if (pruned !== hist) {
          hist.length = 0;
          for (let p = 0; p < pruned.length; p++) hist.push(pruned[p]);
        }
      }
    } catch (e) {}
    // Drop older optimistic / duplicate for same ticket (ignore attempt mismatch).
    for (let i = hist.length - 1; i >= 0; i--) {
      const t = hist[i];
      if (!t) continue;
      if (t.id === optimisticId || (t.optimistic && (tradeOpenIdentity(t) === logicKey || tradeFillIdentity(t) === fillKey))) {
        hist.splice(i, 1);
      }
    }
    // If a confirmed trade already exists for this ticket, skip optimistic.
    const hasConfirmed = hist.some(function (t) {
      return t && !t.optimistic && !t.localOnly && isResultTrade(t) &&
        (tradeOpenIdentity(t) === logicKey || tradeFillIdentity(t) === fillKey);
    });
    if (!hasConfirmed) hist.unshift(row);

    try { window.signalHistory = (typeof signalHistory !== 'undefined') ? signalHistory : window.signalHistory; } catch (e) {}
    recompute(key);
    try {
      window.dispatchEvent(new CustomEvent('utk:stats-updated', { detail: { bot: key, source: 'optimistic' } }));
    } catch (e) {}
    return true;
  }

  /**
   * Confirmed Pocket Option account fill (SSID autotrade). Replaces bot-candle tape
   * for history when Auto Trade is on.
   */
  function applyPoAccountResult(botKey, data) {
    const key = String(botKey || '').toUpperCase();
    if (key !== 'LUMIX' && key !== 'MIRAX' && key !== 'NYX') return false;
    const dealId = String(data.dealId || '').trim();
    if (!dealId) return false;
    const norm = normalizeLiveResult(data);
    if (!norm) return false;

    const hist = ensureHistory(key);
    const rowId = 'po__' + key + '__' + dealId;
    const placedAt = Math.trunc(Number(data.placedAt) || Number(data.openedAtMs) || Number(norm.openingTime) || Date.now());
    let settleAt = Math.trunc(Number(data.settleAt) || Number(data.closedAtMs) || Number(norm.closingTime) || 0);
    const durSec = Math.max(1, Number(data.durationSec) || 60);
    if (!settleAt || settleAt < placedAt) {
      settleAt = placedAt + durSec * 1000;
    }
    const attempt = Math.max(1, parseInt(data.attempt, 10) || parseInt(norm.attempt, 10) || 1);
    const sideRaw = String(data.side || norm.side || norm.action || '').toUpperCase();
    const action = (sideRaw === 'CALL' || sideRaw === 'UP' || sideRaw === '0') ? 'BUY'
      : ((sideRaw === 'PUT' || sideRaw === 'DOWN' || sideRaw === '1') ? 'SELL'
        : ((sideRaw === 'BUY' || sideRaw === 'SELL') ? sideRaw : norm.action));

    const row = {
      id: rowId,
      bot: key,
      poAccount: true,
      optimistic: false,
      dealId: dealId,
      result: norm.result,
      phase: 'Trading Result',
      openingTime: placedAt,
      closingTime: settleAt,
      openedAtMs: placedAt,
      closedAtMs: settleAt,
      timestamp: placedAt,
      symbol: norm.symbol,
      currency: norm.currency,
      selectedCurrency: norm.selectedCurrency,
      action: action,
      side: action || norm.side,
      openingPrice: norm.openingPrice,
      closingPrice: norm.closingPrice,
      attempt: attempt,
      stakeAmount: data.amount != null ? Number(data.amount) : null,
      profit: data.profit != null ? Number(data.profit) : null,
      stakeMultiplier: norm.stakeMultiplier
    };

    const idx = hist.findIndex(function (t) { return t && t.id === rowId; });
    if (idx >= 0) {
      hist[idx] = Object.assign({}, hist[idx], row);
    } else {
      hist.unshift(row);
    }

    try { window.signalHistory = (typeof signalHistory !== 'undefined') ? signalHistory : window.signalHistory; } catch (e) {}
    recompute(key);
    try {
      window.dispatchEvent(new CustomEvent('utk:stats-updated', { detail: { bot: key, source: 'po_account' } }));
    } catch (e2) {}
    return true;
  }

  /**
   * When a Firebase trade lands, drop matching optimistic placeholders so
   * streak/stats never double-count the same MG step.
   */
  function reconcileConfirmedTrade(botKey, tradeId, payload) {
    const key = String(botKey || '').toUpperCase();
    if (key !== 'LUMIX' && key !== 'MIRAX' && key !== 'NYX') return false;
    const hist = ensureHistory(key);
    const row = Object.assign({}, payload || {}, { id: tradeId, bot: key, optimistic: false });
    const logicKey = tradeOpenIdentity(row);
    const fillKey = tradeFillIdentity(row);
    let optimisticTwin = null;

    for (let i = hist.length - 1; i >= 0; i--) {
      const t = hist[i];
      if (!t) continue;
      if (t.optimistic && (tradeOpenIdentity(t) === logicKey || tradeFillIdentity(t) === fillKey)) {
        optimisticTwin = t;
        hist.splice(i, 1);
        continue;
      }
      if (tradeId && t.id === tradeId && t.optimistic) {
        if (!optimisticTwin) optimisticTwin = t;
        hist.splice(i, 1);
      }
    }
    if (optimisticTwin) fillMissingTradeFields(row, optimisticTwin);

    const idx = hist.findIndex(function (t) { return t && t.id === tradeId; });
    if (idx >= 0) {
      hist[idx] = Object.assign({}, hist[idx], row, { optimistic: false });
    } else {
      hist.unshift(row);
    }

    try { window.signalHistory = (typeof signalHistory !== 'undefined') ? signalHistory : window.signalHistory; } catch (e) {}
    recompute(key);
    return true;
  }

  /** Keep live optimistic rows that do not yet have a confirmed twin, or whose twin is incomplete. */
  function filterKeepOptimistic(pending, confirmedList) {
    const confirmedByKey = Object.create(null);
    const confirmedByFp = Object.create(null);
    (confirmedList || []).forEach(function (t) {
      if (!t || t.optimistic || t.localOnly || !isResultTrade(t)) return;
      confirmedByKey[tradeOpenIdentity(t)] = t;
      confirmedByKey[tradeFillIdentity(t)] = t;
      confirmedByFp[priceFingerprint(t)] = t;
    });
    return (pending || []).filter(function (t) {
      if (!t || !t.optimistic || !isResultTrade(t)) return false;
      const twin = confirmedByKey[tradeOpenIdentity(t)]
        || confirmedByKey[tradeFillIdentity(t)]
        || confirmedByFp[priceFingerprint(t)];
      if (!twin) return true;
      return isSparseResult(twin);
    });
  }

  function recomputeAll() {
    Object.keys(BOT_IDS).forEach(function (k) {
      try { recompute(k); } catch (e) {}
    });
  }

  function onLiveResult(botKey, data) {
    if (data && typeof data === 'object') {
      applyOptimisticLiveResult(botKey, data);
      return;
    }
    recompute(botKey);
  }

  function installHooks() {
    try {
      if (typeof signalHistory !== 'undefined') window.signalHistory = signalHistory;
    } catch (e) {}

    window.computeStatsFromHistory = function (botKey) { recompute(botKey); };
    window.updateBotStatsOnResult = function (botKey, data) { onLiveResult(botKey, data); };
    window.__utkBotStats = {
      recompute: recompute,
      recomputeAll: recomputeAll,
      onLiveResult: onLiveResult,
      applyOptimisticLiveResult: applyOptimisticLiveResult,
      applyPoAccountResult: applyPoAccountResult,
      reconcileConfirmedTrade: reconcileConfirmedTrade,
      filterKeepOptimistic: filterKeepOptimistic,
      dedupeResultTrades: dedupeResultTrades,
      tradeOpenIdentity: tradeOpenIdentity,
      tradeFillIdentity: tradeFillIdentity,
      getWinStreakHistory: getWinStreakHistory,
      setLiveBoard: setLiveBoard,
      setPersistedHistory: setPersistedHistory,
      mergeCompletedStreaks: mergeCompletedStreaks,
      lastStreakForRange: lastStreakForRange,
      lastStreakToShow: lastStreakToShow,
      pickLiveStreak: pickLiveStreak,
      getViewDayKey: getViewDayKey,
      resolveViewRange: resolveViewRange
    };
    window.__updateTotalWins = recomputeAll;
  }

  installHooks();
  recomputeAll();
  setTimeout(recomputeAll, 400);
  setTimeout(recomputeAll, 1600);
})();
