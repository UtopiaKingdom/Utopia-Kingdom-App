/**
 * saving-signal-stake.js
 * Single policy for Saving Signals stake → Pocket Option amount.
 * Load AFTER renderer.js (needs getBetSize / toggles / ipc).
 *
 * Rules:
 * 1. Live PO amount = baseBet × ladder[attempt - 1] for the selected 2x/4x mode
 * 2. Never size a live trade from history / stale stakeAmount / bot 2x-only mult
 * 3. Missing attempt → 1× base (safe), never an inflated tier
 */
(function () {
  'use strict';

  const LADDERS = {
    '2x': [1, 2, 4, 10, 20],
    '4x': [1, 4, 7, 16, 44]
  };

  function botIdFor(botKey) {
    try {
      if (typeof botIdMap !== 'undefined' && botIdMap[botKey]) return botIdMap[botKey];
    } catch (e) {}
    const k = String(botKey || '').toUpperCase();
    if (k === 'LUMIX') return 'bot1';
    if (k === 'MIRAX') return 'bot2';
    if (k === 'NYX') return 'bot3';
    if (k === 'STUDIO') return 'studio';
    if (String(botKey || '').toLowerCase() === 'studio') return 'studio';
    return null;
  }

  function readMode(botKey) {
    try {
      if (typeof getSavingSignalMode === 'function') return getSavingSignalMode(botKey);
    } catch (e) {}
    try {
      if (window.__utkSavingLadder && typeof window.__utkSavingLadder.getMode === 'function') {
        return window.__utkSavingLadder.getMode(botKey);
      }
    } catch (e2) {}
    return '2x';
  }

  function ladderFor(mode, botKey) {
    try {
      if (window.getSavingSignalLadder) return window.getSavingSignalLadder(botKey);
    } catch (e) {}
    try {
      if (window.__utkSavingLadder && typeof window.__utkSavingLadder.getLadder === 'function') {
        return window.__utkSavingLadder.getLadder(botKey);
      }
    } catch (e2) {}
    if (mode === 'custom') return [1, 2, 5, 10, 25];
    return LADDERS[mode === '4x' ? '4x' : '2x'];
  }

  function autotradeOn(botKey) {
    try {
      if (typeof window !== 'undefined' && typeof window.isAutoTradeEnabled === 'function') {
        return !!window.isAutoTradeEnabled(botKey);
      }
    } catch (e) {}
    try {
      if (typeof isAutoTradeEnabled === 'function') return !!isAutoTradeEnabled(botKey);
    } catch (e2) {}
    const botId = botIdFor(botKey);
    const toggle = botId && document.getElementById('autoTradeToggle-' + botId);
    return !!(toggle && toggle.checked);
  }

  function savingOn(botKey) {
    try {
      if (typeof window !== 'undefined' && typeof window.isSavingSignalsEnabled === 'function') {
        return !!window.isSavingSignalsEnabled(botKey);
      }
    } catch (e) {}
    try {
      if (typeof isSavingSignalsEnabled === 'function') return !!isSavingSignalsEnabled(botKey);
    } catch (e2) {}
    const botId = botIdFor(botKey);
    const toggle = botId && document.getElementById('savingSignalEnabled-' + botId);
    return !!(toggle && toggle.checked);
  }

  function baseBet(botKey) {
    try {
      if (typeof getBetSize === 'function') {
        const n = Number(getBetSize(botKey));
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch (e) {}
    return null;
  }

  function parseAttempt(signalOrOpts) {
    const n = Number(signalOrOpts && signalOrOpts.attempt);
    if (Number.isFinite(n) && n >= 1) return Math.min(Math.trunc(n), 5);
    return null;
  }

  /**
   * Authoritative live stake. History is never used here.
   */
  function resolveLiveStake(botKey, signalOrOpts) {
    const currency =
      (signalOrOpts && (signalOrOpts.currency || signalOrOpts.selectedCurrency || signalOrOpts.symbol)) ||
      '';
    const base = baseBet(botKey);
    if (!(Number.isFinite(base) && base > 0)) {
      return { currency, amount: 0, mult: 1, attempt: parseAttempt(signalOrOpts) || 1, mode: '2x', source: 'missing-base' };
    }

    if (!savingOn(botKey)) {
      return { currency, amount: Math.round(base * 100) / 100, mult: 1, attempt: parseAttempt(signalOrOpts) || 1, mode: '2x', source: 'base' };
    }

    const mode = readMode(botKey);
    const ladder = ladderFor(mode, botKey);
    const attempt = parseAttempt(signalOrOpts);
    if (attempt != null) {
      const mult = ladder[Math.min(Math.max(0, attempt - 1), 4)] || 1;
      return {
        currency,
        amount: Math.round(base * mult * 100) / 100,
        mult,
        attempt,
        mode,
        ladder: ladder.slice(),
        source: 'attempt'
      };
    }

    // Missing attempt → never guess from history (that caused 2x→4x jumps).
    return {
      currency,
      amount: Math.round(base * 100) / 100,
      mult: 1,
      attempt: 1,
      mode,
      source: 'safe-base'
    };
  }

  function pushConfigToMain(botKey, opts) {
    const botId = botIdFor(botKey);
    if (!botId) return null;
    const resolved = resolveLiveStake(botKey, opts || {});
    const base = baseBet(botKey);
    const mode = readMode(botKey);
    const currency = (opts && opts.currency) || resolved.currency || '';
    const payload = {
      botId,
      savingSignalsEnabled: savingOn(botKey),
      savingSignalMode: mode,
      savingSignalLadder: ladderFor(mode, botKey),
      savingSignalMultiplier: resolved.mult,
      stakeAmount: resolved.amount,
      currency: currency || undefined,
      duration: opts && opts.duration != null ? Number(opts.duration) : undefined,
      // Clear stale pre-bump: main must not keep an old inflated amount.
      clearStaleStake: true
    };
    if (opts && opts.historyNextAttempt != null) {
      payload.historyNextAttempt = Number(opts.historyNextAttempt);
    }
    try {
      const el = document.getElementById('betSize-' + botId);
      if (el && el.dataset.hydrated === '1' && Number.isFinite(base) && base > 0) {
        payload.baseBet = base;
        payload.betFromInput = true;
      }
    } catch (e) {}
    // CRITICAL: only touch autotrade enabled when explicitly passed.
    // Otherwise stake sync was sending enabled:false (module scope couldn't see
    // isAutoTradeEnabled) and killed SignalHub placement within milliseconds.
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'enabled') && opts.enabled !== undefined) {
      payload.enabled = !!opts.enabled;
      payload.source = opts.source || 'user-toggle';
    }
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('sync-autotrade-config', payload);
      if (currency) {
        ipcRenderer.send('cache-trade-prep', {
          botId,
          currency,
          amount: resolved.amount,
          duration: payload.duration,
          savingSignalMode: mode,
          savingSignalLadder: payload.savingSignalLadder
        });
      }
    } catch (e) {}
    return resolved;
  }

  /** Full UI → main sync (call when enabling autotrade / toggling mode). */
  function syncAllToMain() {
    ['LUMIX', 'MIRAX', 'NYX', 'STUDIO'].forEach(function (k) {
      try { pushConfigToMain(k, {}); } catch (e) {}
    });
  }

  window.__utkSavingStake = {
    LADDERS: LADDERS,
    resolveLiveStake: resolveLiveStake,
    pushConfigToMain: pushConfigToMain,
    syncAllToMain: syncAllToMain
  };

  // Prefer this over older loose sync when present.
  window.syncSavingSignalStakeToMainSafe = function (botKey, currency, opts) {
    return pushConfigToMain(botKey, Object.assign({}, opts || {}, { currency: currency || (opts && opts.currency) || '' }));
  };
})();
