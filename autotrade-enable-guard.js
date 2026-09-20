/**
 * autotrade-enable-guard.js
 * Main-side safety: stake/config sync must never accidentally disable autotrade.
 * Load from main.js context (required by tests via extracting logic).
 */
(function (root) {
  'use strict';

  /**
   * Decide whether an incoming sync-autotrade-config payload may change `enabled`.
   * Returns { apply: boolean, value?: boolean, reason?: string }
   */
  function resolveEnabledUpdate(payload, prevEnabled) {
    if (!payload || typeof payload !== 'object') {
      return { apply: false, reason: 'no-payload' };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
      return { apply: false, reason: 'omitted' };
    }
    if (payload.enabled === undefined) {
      return { apply: false, reason: 'undefined' };
    }
    const next = !!payload.enabled;
    // Stake-only syncs used to send enabled:false and kill placement.
    // If this payload is clearly a stake refresh, never allow disable.
    if (
      next === false &&
      prevEnabled === true &&
      (payload.clearStaleStake === true ||
        payload.stakeAmount != null ||
        payload.savingSignalMultiplier != null)
    ) {
      // Allow disable only when explicitly marked as a user/toggle intent.
      if (payload.source !== 'user-toggle' && payload.source !== 'hard-disconnect') {
        return { apply: false, reason: 'block-stake-disable' };
      }
    }
    return { apply: true, value: next };
  }

  root.__utkAutotradeEnableGuard = { resolveEnabledUpdate };
  try {
    module.exports = { resolveEnabledUpdate };
  } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : this);
