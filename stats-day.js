/**
 * Shared stats calendar: Europe/Berlin, 00:00–24:00.
 * Every client and the signal-writer use this so "Today" is the same for everyone.
 */
(function (root) {
  'use strict';

  const TZ = 'Europe/Berlin';
  const LOOKBACK_MS = 36 * 60 * 60 * 1000;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function zonedParts(ms, timeZone) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    const parts = fmt.formatToParts(new Date(ms));
    const map = Object.create(null);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'literal') map[parts[i].type] = parts[i].value;
    }
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second)
    };
  }

  function dayKey(ms, timeZone) {
    const p = zonedParts(typeof ms === 'number' && ms > 0 ? ms : Date.now(), timeZone);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
  }

  function parseDateKey(dateKey) {
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(dateKey || '').trim());
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }

  /**
   * UTC epoch of 00:00:00.000 in Europe/Berlin for YYYY-MM-DD.
   * Two-pass wall-clock correction so DST days stay exact.
   */
  function dayStartMs(dateKey, timeZone) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) return null;
    const tz = timeZone || TZ;
    const wanted = Date.UTC(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0);
    let utc = wanted;
    for (let i = 0; i < 3; i++) {
      const p = zonedParts(utc, tz);
      const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      utc += wanted - asUtc;
    }
    return utc;
  }

  function dayRange(dateKey, timeZone) {
    const key = parseDateKey(dateKey) ? String(dateKey).trim() : dayKey(Date.now(), timeZone);
    const start = dayStartMs(key, timeZone);
    if (start == null) {
      const fallback = Date.now();
      return { key: dayKey(fallback, timeZone), start: fallback, end: fallback + 86400000 };
    }
    const nextKey = dayKey(start + 36 * 3600 * 1000, timeZone);
    let end = dayStartMs(nextKey, timeZone);
    if (end == null || end <= start) end = start + 86400000;
    return { key: key, start: start, end: end };
  }

  function rangeForMs(ms, timeZone) {
    return dayRange(dayKey(ms, timeZone), timeZone);
  }

  function lookbackStartMs(nowMs, timeZone) {
    const now = typeof nowMs === 'number' && nowMs > 0 ? nowMs : Date.now();
    const today = dayRange(dayKey(now, timeZone), timeZone);
    return Math.min(today.start - LOOKBACK_MS, now - LOOKBACK_MS);
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatLabel(dateKey) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) return String(dateKey || '');
    return MONTHS[parsed.month - 1] + ' ' + parsed.day + ', ' + parsed.year;
  }

  const api = {
    TZ: TZ,
    dayKey: dayKey,
    dayStartMs: dayStartMs,
    dayRange: dayRange,
    rangeForMs: rangeForMs,
    lookbackStartMs: lookbackStartMs,
    parseDateKey: parseDateKey,
    formatLabel: formatLabel
  };

  try { module.exports = api; } catch (e) {}
  try { root.__utkStatsDay = api; } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : this);
