/**
 * Shared helpers for the always-on signal writer (must match renderer.js).
 */

function toEpochMs(value) {
  if (value == null || value === '' || value === 'N/A') return null;
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
      if (s.length === 10) return n * 1000;
      return n;
    }
    // Naive datetime = local wall clock. Do not Date.parse ISO-without-TZ (Safari = UTC).
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
    } catch (_) {}
  }
  return null;
}

function omitUndefinedFields(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

function canonCurrencyKey(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  const isOtc = /\bOTC\b/.test(upper);
  const base = upper
    .replace(/\bOTC\b/g, '')
    .replace(/[\s/\\_-]+/g, '')
    .trim();
  if (!base) return upper;
  return isOtc ? `${base}_OTC` : base;
}

function safeKey(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function prettyOtcPair(raw) {
  let s = String(raw || '').trim();
  if (!s || /^n\/?a$/i.test(s)) return '';
  s = s.replace(/_OTC$/i, '').replace(/\s*OTC\b/gi, '').replace(/[_-]/g, '/').trim();
  s = s.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (!s) return '';
  if (!s.includes('/') && /^[A-Za-z]{6}$/.test(s)) {
    s = s.slice(0, 3) + '/' + s.slice(3);
  }
  return s.toUpperCase() + ' OTC';
}

function resolveCurrency(signal) {
  if (!signal) return '';
  const bot = String(signal.bot || signal.botKey || '').toUpperCase();
  const raw = signal.selectedCurrency || signal.symbol || signal.currency || '';
  const rawStr = String(raw || '').trim();
  const looksOtc = !!(signal.isOtc || signal.otc || signal.is_otc || /\botc\b/i.test(rawStr));
  if (bot === 'LUMIX' || bot === 'MIRAX' || looksOtc) {
    return prettyOtcPair(rawStr) || '';
  }
  const rawHasOtc = /\botc\b/i.test(rawStr);
  const typeStr = String(signal.type || '').toLowerCase();
  const marketType = String(signal.marketType || signal.market_type || signal.instrumentType || signal.instrument || '').toLowerCase();
  const feedStr = String(signal.feed || signal.source || '').toLowerCase();
  const hasOtcFlag = !!(signal.isOtc || signal.otc || signal.is_otc || signal.isOtcCurrency || signal.is_otc_currency ||
    typeStr === 'otc' || marketType === 'otc' || feedStr === 'otc' ||
    (signal.market && String(signal.market).toLowerCase() === 'otc') ||
    (signal.exchange && String(signal.exchange).toLowerCase() === 'otc'));
  const base = rawStr.replace(/\s*OTC/ig, '').trim();
  if (!base) return rawStr;
  const needsOtc = hasOtcFlag || rawHasOtc;
  return needsOtc ? `${base} OTC` : base;
}

function normalizeResult(result) {
  const resultStr = String(result || '').trim().toUpperCase();
  if (resultStr === 'WON' || resultStr === 'SUCCESS' || resultStr === 'W') return 'WIN';
  if (resultStr === 'LOSE' || resultStr === 'LOST' || resultStr === 'L') return 'LOSS';
  return resultStr;
}

function getDefaultPrepareSeconds(botKey) {
  return String(botKey || '').toUpperCase() === 'MIRAX' ? 10 : 10;
}

function getDefaultTradeSeconds(botKey) {
  return String(botKey || '').toUpperCase() === 'MIRAX' ? 30 : 180;
}

function normalizeBotKey(bot) {
  const key = String(bot || '').trim().toUpperCase();
  if (key === 'LUMIX' || key === 'MIRAX') return key;
  return '';
}

function buildTradeIds(botKey, tradeData) {
  const openKey = toEpochMs(tradeData.openedAtMs) ?? toEpochMs(tradeData.openingTime) ?? toEpochMs(tradeData.timestamp) ?? Date.now();
  const timestamp = Math.trunc(Number(openKey) || Date.now());
  const closeKey = Math.trunc(Number(toEpochMs(tradeData.closingTime) || Date.now()));
  const incoming = String(tradeData.selectedCurrency || tradeData.symbol || tradeData.currency || '');
  const rawSymbol = prettyOtcPair(incoming) || incoming || 'N/A';
  const stableSymbolKey = canonCurrencyKey(rawSymbol);
  const attemptKey = tradeData.attempt != null && Number.isFinite(Number(tradeData.attempt))
    ? String(Number(tradeData.attempt))
    : 'na';
  const tradeId = `${safeKey(botKey)}__${safeKey(stableSymbolKey || rawSymbol)}__${timestamp}__${closeKey}`;
  const altTradeId = `${safeKey(botKey)}__${safeKey(stableSymbolKey || rawSymbol)}__${timestamp}__a${attemptKey}`;
  return { tradeId, altTradeId, timestamp, closeKey, rawSymbol };
}

module.exports = {
  toEpochMs,
  omitUndefinedFields,
  canonCurrencyKey,
  safeKey,
  prettyOtcPair,
  resolveCurrency,
  normalizeResult,
  getDefaultPrepareSeconds,
  getDefaultTradeSeconds,
  normalizeBotKey,
  buildTradeIds,
};
