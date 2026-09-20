/**
 * signal-card-ttl.js
 * Live Signal cards must not stay forever if Result never arrives.
 * After expiry + grace, UI returns to the searching empty scene.
 */
(function (root) {
  'use strict';

  /** After expiry, keep Signal visible while Result is in flight (server poll + WS). */
  const RESULT_GRACE_MS = 12000;

  function toMs(v) {
    if (v == null || v === '' || v === 'N/A') return 0;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e11) return Math.round(n);
    const d = Date.parse(String(v));
    return Number.isFinite(d) ? d : 0;
  }

  function signalOpenMs(data) {
    if (!data || typeof data !== 'object') return 0;
    return (
      toMs(data.openedAtMs) ||
      toMs(data.openingTime) ||
      toMs(data.startTime) ||
      toMs(data.time) ||
      0
    );
  }

  function durationSec(data, fallback) {
    const n = Number(data && (data.duration || data.countdown));
    if (Number.isFinite(n) && n > 0) return n;
    const fb = Number(fallback);
    return Number.isFinite(fb) && fb > 0 ? fb : 30;
  }

  function remainingSec(data, now, fallbackDur) {
    const open = signalOpenMs(data);
    const dur = durationSec(data, fallbackDur);
    const t = Number(now) || Date.now();
    if (!open) return null;
    return Math.max(0, Math.ceil((open + dur * 1000 - t) / 1000));
  }

  function deadAfterMs(data, fallbackDur) {
    const open = signalOpenMs(data);
    const dur = durationSec(data, fallbackDur);
    const stamp = open || toMs(data && (data.startTime || data.updatedAt));
    if (!stamp) return 0;
    return stamp + dur * 1000 + RESULT_GRACE_MS;
  }

  function isDeadSignal(data, now, fallbackDur) {
    const phase = String((data && data.phase) || '').trim().toLowerCase();
    if (phase && phase !== 'signal') return false;
    const until = deadAfterMs(data, fallbackDur);
    if (!until) return false;
    return (Number(now) || Date.now()) > until;
  }

  function graceLeftMs(data, now, fallbackDur) {
    const until = deadAfterMs(data, fallbackDur);
    if (!until) return RESULT_GRACE_MS;
    return Math.max(0, until - (Number(now) || Date.now()));
  }

  const api = {
    RESULT_GRACE_MS,
    toMs,
    signalOpenMs,
    durationSec,
    remainingSec,
    isDeadSignal,
    graceLeftMs,
    deadAfterMs,
  };

  try { root.__utkSignalCardTtl = api; } catch (e) {}
  try { module.exports = api; } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : this);
