/**
 * Pure helpers for single-session presence locks (shared by PC + unit tests).
 * One live device per account. Stale locks are reclaimable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UtkSessionLockLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_STALE_MS = 2 * 60 * 1000;

  function lockTimestamp(data) {
    if (!data || typeof data !== 'object') return 0;
    const raw =
      data.updatedAt != null
        ? data.updatedAt
        : data.lastActive != null
          ? data.lastActive
          : data.startedAt;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  /** True when another live device currently owns the session. */
  function isForeignActiveLock(data, deviceId, sessionId, nowMs, staleMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const stale = Number.isFinite(staleMs) ? staleMs : DEFAULT_STALE_MS;
    if (!data) return false;
    const sid = data.sessionId != null ? String(data.sessionId) : '';
    if (!sid || sid === sessionId) return false;
    const did = data.deviceId != null ? String(data.deviceId) : '';
    if (!did || did === deviceId) return false;
    const ts = lockTimestamp(data);
    if (!ts) return false; // abandoned / never heartbeated → reclaimable
    return now - ts < stale;
  }

  function isActiveElsewhereError(err) {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return /active_elsewhere/i.test(msg);
  }

  /**
   * Decide claim outcome without I/O.
   * @returns {'claim'|'active_elsewhere'}
   */
  function decideLockClaim(existing, deviceId, sessionId, opts) {
    const force = !!(opts && opts.force);
    const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const staleMs = opts && Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
    if (!force && isForeignActiveLock(existing, deviceId, sessionId, nowMs, staleMs)) {
      return 'active_elsewhere';
    }
    return 'claim';
  }

  return {
    DEFAULT_STALE_MS,
    lockTimestamp,
    isForeignActiveLock,
    isActiveElsewhereError,
    decideLockClaim
  };
});
