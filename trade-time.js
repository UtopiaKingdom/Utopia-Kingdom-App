/**
 * trade-time.js — Parse/display trade clocks in the device's local timezone
 * (Windows/macOS system setting — works for India, US, EU, etc.).
 * Load BEFORE renderer.js.
 *
 * Storage: real UTC epoch ms on the server (same instant for everyone).
 * Display: new Date(ms).toLocaleTimeString(undefined, …) — no fixed timeZone.
 *
 * Legacy Firebase rows used naive UTC wall stored as epoch; shouldUnshiftUtcWall
 * fixes those. Studio / time_v2 rows are true UTC epoch — pass through unchanged.
 */
(function (root) {
  'use strict';

  function escapeHtml(value) {
    try {
      if (typeof window !== 'undefined' && typeof window.escapeHtml === 'function') {
        return window.escapeHtml(value);
      }
    } catch (e) {}
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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
      const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
      if (naive) {
        const frac = naive[7] ? Number(String(naive[7]).slice(0, 3).padEnd(3, '0')) : 0;
        const ms = new Date(
          Number(naive[1]),
          Number(naive[2]) - 1,
          Number(naive[3]),
          Number(naive[4]),
          Number(naive[5]),
          Number(naive[6] || 0),
          Number.isFinite(frac) ? frac : 0
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

  function localeTimeOpts() {
    return { hour: '2-digit', minute: '2-digit', second: '2-digit' };
  }

  function utcWallToLocalMs(ms) {
    const d = new Date(ms);
    return new Date(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds()
    ).getTime();
  }

  function looksLikeUnixMs(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 1e11;
    if (typeof value === 'string' && /^\d{12,17}$/.test(value.trim())) return true;
    return false;
  }

  function shouldUnshiftUtcWall(meta, ms) {
    if (!meta || typeof meta !== 'object') return false;
    if (meta.clock === 'epoch' || meta.clockSource === 'epoch') return false;
    const created = toEpochMs(meta.createdAt);
    if (!created || !Number.isFinite(ms)) return false;
    const tzMs = -new Date(ms).getTimezoneOffset() * 60000;
    if (!tzMs) return false;
    const delta = ms - created;
    return delta > tzMs * 0.5 && Math.abs(delta - tzMs) < 15 * 60 * 1000;
  }

  function toDisplayEpochMs(value, meta) {
    const ms = toEpochMs(value);
    if (!Number.isFinite(ms) || ms <= 0) return ms;
    if (meta && (meta.clock === 'epoch' || meta.clockSource === 'epoch')) return ms;
    // Studio live trades store real UTC epoch ms (time_v2); do not utcWall-shift.
    if (meta && meta.source === 'studio') return ms;
    if (shouldUnshiftUtcWall(meta, ms) && looksLikeUnixMs(value)) {
      return utcWallToLocalMs(ms);
    }
    return ms;
  }

  function formatTimeOnly(value, meta) {
    const ms = toDisplayEpochMs(value, meta);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    try {
      return new Date(ms).toLocaleTimeString(undefined, localeTimeOpts());
    } catch (e) {
      return new Date(ms).toLocaleTimeString();
    }
  }

  function formatStamp(value, meta) {
    const item = meta || (value && typeof value === 'object' && !looksLikeUnixMs(value) ? value : null);
    const raw = item
      ? (item.openedAtMs || item.timestamp || item.openingTime || item.closingTime)
      : value;
    const ms = toDisplayEpochMs(raw, item);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    try {
      return new Date(ms).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (e) {
      return new Date(ms).toLocaleString();
    }
  }

  function formatTimePriceStack(timeValue, priceValue, meta) {
    const t = formatTimeOnly(timeValue, meta);
    const pRaw = (priceValue !== undefined && priceValue !== null && priceValue !== 'N/A')
      ? String(priceValue)
      : '';
    const p = escapeHtml(pRaw);
    if (t && p) {
      return `<span class="tp-stack"><span class="tp-time">${escapeHtml(t)}</span><span class="tp-price">${p}</span></span>`;
    }
    return escapeHtml(t || pRaw || '');
  }

  function openTimeOf(signal) {
    if (!signal || typeof signal !== 'object') return signal;
    return (
      signal.openedAtMs ??
      signal.opened_at_ms ??
      signal.openingTime ??
      signal.signalTime ??
      signal.signalTimestamp ??
      signal.time ??
      signal.timestamp
    );
  }

  function closeTimeOf(signal) {
    if (!signal || typeof signal !== 'object') return signal;
    return (
      signal.closedAtMs ??
      signal.closed_at_ms ??
      signal.closingTime ??
      signal.closeTime
    );
  }

  function formatSignalTimeDisplay(signal) {
    const raw = openTimeOf(signal);
    if (raw === undefined || raw === null || raw === '') return '';
    return formatTimeOnly(raw, signal) || '';
  }

  const api = {
    toEpochMs,
    toDisplayEpochMs,
    formatTimeOnly,
    formatStamp,
    formatTimePriceStack,
    formatSignalTimeDisplay,
    openTimeOf,
    closeTimeOf,
  };

  try {
    if (typeof window !== 'undefined') {
      window.__utkTradeTime = api;
      window.toEpochMs = toEpochMs;
      window.formatTimeOnly = formatTimeOnly;
      window.formatTimePriceStack = formatTimePriceStack;
      window.formatSignalTimeDisplay = formatSignalTimeDisplay;
    }
  } catch (e) {}

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  return api;
})(typeof window !== 'undefined' ? window : this);
