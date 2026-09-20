/**
 * Auto Trade chain gate — if a recovery chain is already running LIVE,
 * keep Auto Trade on but wait for a new chain (attempt 1). Never jump in.
 *
 * Important: do NOT use trade-history loss streaks. Those stay while the bot
 * is only searching for the next signal and falsely look like a live chain.
 */
(function () {
  'use strict';

  const BOT_KEY = { bot1: 'LUMIX', bot2: 'MIRAX', bot3: 'NYX' };
  const STAKE_LADDERS = {
    '2x': [1, 2, 4, 10, 20],
    '4x': [1, 4, 7, 16, 44]
  };
  const CHAIN_ONGOING_MSG = 'Chain ongoing — will place the next signal when a new chain starts';
  /** Live mid-chain evidence older than this is treated as idle/searching. */
  const LIVE_META_MAX_AGE_MS = 6 * 60 * 1000;
  const waitByBot = Object.create(null);

  function botKeyOf(botId) {
    return BOT_KEY[botId] || String(botId || '').toUpperCase();
  }

  function botIdOfKey(botKey) {
    const key = String(botKey || '').toUpperCase();
    if (key === 'LUMIX') return 'bot1';
    if (key === 'MIRAX') return 'bot2';
    if (key === 'NYX') return 'bot3';
    if (key === 'BOT1' || key === 'BOT2' || key === 'BOT3') return key.toLowerCase();
    return null;
  }

  function readLiveMeta(botKey) {
    try {
      if (typeof window === 'undefined') return null;
      return (window.__liveChainMeta && window.__liveChainMeta[botKey]) || null;
    } catch (e) {
      return null;
    }
  }

  function isIdlePhase(phase) {
    const p = String(phase || '').trim().toLowerCase();
    return !p || p === 'idle' || p.includes('chain complete');
  }

  function isResultPhase(phase) {
    const p = String(phase || '').trim().toLowerCase();
    return p === 'trading result' || p === 'result';
  }

  function isActiveChainPhase(phase) {
    const p = String(phase || '').trim().toLowerCase();
    // Preparing / Signal / Result all count while a recovery chain is still open.
    // Empty "searching" is idle / chain complete only.
    return p === 'preparing' || p === 'signal' || p === 'trading result' || p === 'result';
  }

  function resultIsWin(result) {
    const r = String(result || '').trim().toUpperCase();
    return r === 'WIN' || r === 'WON' || r === 'W' || r === 'DRAW' || r === 'TIE';
  }

  function resultIsLoss(result) {
    const r = String(result || '').trim().toUpperCase();
    return r === 'LOSS' || r === 'LOSE' || r === 'LOST' || r === 'L';
  }

  function isMidChainNumbers(attempt, realLoss, mult) {
    const a = Number(attempt) || 1;
    const loss = Number(realLoss) || 0;
    const m = Number(mult) || 0;
    return a > 1 || loss > 0 || m > 1;
  }

  function readLiveAttemptFromDom(botKey) {
    try {
      const display = document.getElementById('signalDisplay-' + (botIdOfKey(botKey) || 'bot1'))
        || document.querySelector('[data-bot-key="' + botKey + '"] .signal-display')
        || null;
      // Prefer visible trade card attempt if present.
      const card = document.getElementById('tradeCard-' + botKey)
        || document.querySelector('[data-bot-key="' + botKey + '"]')
        || document.querySelector('.trade-card[data-bot="' + botKey + '"]');
      if (card) {
        const attemptEl = card.querySelector('[data-field="attempt"], .attempt-value, .chain-attempt');
        if (attemptEl) {
          const n = Number(String(attemptEl.textContent || '').replace(/[^\d]/g, ''));
          if (Number.isFinite(n) && n > 1) return n;
        }
      }
      // Saving badge "4x" alone is NOT proof of a live mid-chain (hint can linger).
      void display;
    } catch (e) {}
    return 0;
  }

  function readSavingMode(botId) {
    try {
      const botKey = botKeyOf(botId);
      if (typeof window !== 'undefined' && typeof window.getSavingSignalMode === 'function') {
        const mode = window.getSavingSignalMode(botKey);
        if (mode === '4x' || mode === '2x' || mode === 'custom') return mode;
      }
    } catch (e) {}
    return '2x';
  }

  function stakeLabelForAttempt(botId, attempt) {
    const a = Math.min(Math.max(1, Math.trunc(Number(attempt) || 1)), 5);
    let ladder = STAKE_LADDERS[readSavingMode(botId)] || STAKE_LADDERS['2x'];
    try {
      if (typeof window.getSavingSignalLadder === 'function') {
        ladder = window.getSavingSignalLadder(botKeyOf(botId)) || ladder;
      }
    } catch (e) {}
    return `${ladder[a - 1] || 1}x`;
  }

  /**
   * Stake step Auto Trade should use if the user jumps in now.
   * After a LOSS that is not a wipe, the next live attempt is attempt+1
   * (e.g. 1x just lost → jump at 2x; 4x just lost → jump at 10x).
   */
  function getJoinAttempt(botIdOrMeta, maybeMeta) {
    const meta = maybeMeta || (typeof botIdOrMeta === 'object' ? botIdOrMeta : readLiveMeta(botKeyOf(botIdOrMeta)));
    if (!meta) return 1;
    const attempt = Math.min(Math.max(1, Math.trunc(Number(meta.attempt) || 1)), 5);
    const maxAttempts = Math.min(5, Number(meta.maxAttempts) || 5);
    if (isResultPhase(meta.phase) && resultIsLoss(meta.result) && attempt < maxAttempts) {
      return attempt + 1;
    }
    if (isMidChainNumbers(attempt, meta.realLossStreak, meta.stakeMultiplier)) {
      return attempt;
    }
    return attempt;
  }

  function getLiveChainJoinInfo(botId) {
    const botKey = botKeyOf(botId);
    const meta = readLiveMeta(botKey) || {};
    const uiAttempt = readLiveAttemptFromDom(botKey);
    const attempt = Math.max(getJoinAttempt(botId, meta), uiAttempt > 1 ? uiAttempt : 1);
    return {
      botKey,
      attempt,
      stakeLabel: stakeLabelForAttempt(botId, attempt),
      currency: meta.currency || '',
      side: meta.side || '',
      duration: Number(meta.duration) || 0,
      signalId: meta.signalId || '',
      sentAtMs: Number(meta.sentAtMs) || 0,
      openedAtMs: Number(meta.openedAtMs) || 0,
      phase: meta.phase || ''
    };
  }

  /**
   * True when a recovery chain is still open (live trade or waiting on the
   * next MG retry). Idle "searching" after a WIN / wipe / chain complete = false.
   */
  function isSignalChainOngoing(botId) {
    const botKey = botKeyOf(botId);
    const now = Date.now();
    const meta = readLiveMeta(botKey);

    if (meta && Number(meta.at) > 0 && (now - Number(meta.at)) <= LIVE_META_MAX_AGE_MS) {
      if (isIdlePhase(meta.phase)) return false;
      if (!isActiveChainPhase(meta.phase)) return false;

      const attempt = Number(meta.attempt) || 1;
      const maxAttempts = Math.min(5, Number(meta.maxAttempts) || 5);
      if (isResultPhase(meta.phase)) {
        const resultUpper = String(meta.result || '').trim().toUpperCase();
        if (resultIsWin(meta.result) || resultUpper === 'CHAIN_LOSS') return false;
        if (resultIsLoss(meta.result) && attempt >= maxAttempts) return false;
        // LOSS on attempt 1–4: chain continues at the next ladder step.
        if (resultIsLoss(meta.result) && attempt < maxAttempts) return true;
      }

      if (isMidChainNumbers(meta.attempt, meta.realLossStreak, meta.stakeMultiplier)) {
        return true;
      }
      // Fresh attempt-1 Preparing/Signal = first entry, not mid-chain.
      return false;
    }

    // Last-resort: visible live attempt > 1 (meta missing but card still up).
    const uiAttempt = readLiveAttemptFromDom(botKey);
    if (uiAttempt > 1) return true;

    return false;
  }

  function setWaitForChainEnd(botId, on) {
    const id = botId;
    waitByBot[id] = !!on;
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.send('sync-autotrade-config', {
        botId: id,
        waitForChainEnd: !!on
      });
    } catch (e) {}
    try {
      const botKey = botKeyOf(id);
      if (on) {
        window.setBotAutotradeReason?.(id, CHAIN_ONGOING_MSG);
        window.setTradeStatus?.(botKey, CHAIN_ONGOING_MSG);
      }
    } catch (e) {}
  }

  function isWaitingForChainEnd(botIdOrKey) {
    const id = botIdOfKey(botIdOrKey) || botIdOrKey;
    return !!waitByBot[id];
  }

  function clearLiveMeta(botKey) {
    const key = String(botKey || '').toUpperCase();
    try {
      if (window.__liveChainMeta) delete window.__liveChainMeta[key];
    } catch (e) {}
  }

  /** Called from hub / renderer when signals update. Clears wait on a fresh chain. */
  function noteChainSignal(botKey, signal) {
    const key = String(botKey || '').toUpperCase();
    const botId = botIdOfKey(key);
    if (!botId) return;

    const attempt = Number(signal?.attempt) || 1;
    const realLoss = Number(signal?.realLossStreak ?? signal?.real_loss_streak) || 0;
    const stakeMultiplier = Number(signal?.stakeMultiplier) || 0;
    const phase = String(signal?.phase || '').toLowerCase();
    const result = String(signal?.result || signal?.outcome || '').trim();
    const side = String(signal?.side || signal?.action || '').trim();
    const currency = String(signal?.currency || signal?.symbol || signal?.pair || '').trim();
    const duration = Number(signal?.duration || signal?.countdown || 0) || 0;
    const signalId = String(signal?.signalId || '').trim();
    const sentAtMs = Number(signal?.sentAtMs) || 0;
    const openedAtMs = Number(signal?.openedAtMs) || 0;
    const maxAttempts = Math.min(5, Number(signal?.maxAttempts) || 5);

    if (typeof window !== 'undefined') {
      if (!window.__liveChainMeta) window.__liveChainMeta = Object.create(null);
      const prev = window.__liveChainMeta[key] || {};
      window.__liveChainMeta[key] = {
        attempt,
        realLossStreak: realLoss,
        stakeMultiplier,
        phase,
        result,
        side: side || prev.side || '',
        currency: currency || prev.currency || '',
        duration: duration || prev.duration || 0,
        signalId: signalId || prev.signalId || '',
        sentAtMs: sentAtMs || prev.sentAtMs || 0,
        openedAtMs: openedAtMs || prev.openedAtMs || 0,
        maxAttempts,
        at: Date.now()
      };
    }

    if (!waitByBot[botId]) return;

    const resultUpper = String(result || '').toUpperCase();
    const isResult = phase.includes('result');

    // Fresh attempt-1 while waiting → chain ended, start trading.
    if (!isResult && attempt <= 1 && realLoss <= 0 && stakeMultiplier <= 1) {
      setWaitForChainEnd(botId, false);
      try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
      return;
    }

    if (isResult) {
      if (resultUpper === 'WIN' || resultUpper === 'CHAIN_LOSS') {
        setWaitForChainEnd(botId, false);
        try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
      } else if (resultUpper === 'LOSS' && attempt >= maxAttempts) {
        setWaitForChainEnd(botId, false);
        try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
      }
    }

    if (phase.includes('chain complete')) {
      setWaitForChainEnd(botId, false);
      try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
    }
  }

  function markChainIdle(botKey) {
    const key = String(botKey || '').toUpperCase();
    clearLiveMeta(key);
    try {
      if (window.__liveChainMeta) {
        window.__liveChainMeta[key] = {
          attempt: 1,
          realLossStreak: 0,
          stakeMultiplier: 1,
          phase: 'idle',
          at: Date.now()
        };
      }
    } catch (e) {}
  }

  function shouldSkipTradeForWait(botKey, signal) {
    const key = String(botKey || '').toUpperCase();
    const botId = botIdOfKey(key);
    if (!botId || !waitByBot[botId]) return false;
    const attempt = Number(signal?.attempt) || 1;
    const realLoss = Number(signal?.realLossStreak ?? signal?.real_loss_streak) || 0;
    const stakeMultiplier = Number(signal?.stakeMultiplier) || 0;
    if (attempt > 1 || realLoss > 0 || stakeMultiplier > 1) return true;
    setWaitForChainEnd(botId, false);
    try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
    return false;
  }

  /**
   * No popup. Mid-chain → wait for a fresh 1x. Idle → start on the next signal.
   * @returns {Promise<'wait'|'jump'>}
   */
  async function promptAutotradeChainChoice(botId) {
    return isSignalChainOngoing(botId) ? 'wait' : 'jump';
  }

  function applyAutotradeChainChoice(botId, choice) {
    if (choice === 'wait') {
      setWaitForChainEnd(botId, true);
    } else {
      setWaitForChainEnd(botId, false);
    }
  }

  try {
    if (typeof window !== 'undefined') {
      window.promptAutotradeChainChoice = promptAutotradeChainChoice;
      window.applyAutotradeChainChoice = applyAutotradeChainChoice;
      window.isSignalChainOngoing = isSignalChainOngoing;
      window.isAutotradeWaitingForChain = isWaitingForChainEnd;
      window.noteAutotradeChainSignal = noteChainSignal;
      window.shouldSkipAutotradeForChainWait = shouldSkipTradeForWait;
      window.setAutotradeWaitForChainEnd = setWaitForChainEnd;
      window.markAutotradeChainIdle = markChainIdle;
      window.getLiveChainJoinInfo = getLiveChainJoinInfo;
      window.AUTO_TRADE_CHAIN_ONGOING_MSG = CHAIN_ONGOING_MSG;
    }
  } catch (e) {}

  try {
    module.exports = {
      promptAutotradeChainChoice,
      applyAutotradeChainChoice,
      isSignalChainOngoing,
      shouldSkipTradeForWait: shouldSkipTradeForWait,
      noteChainSignal,
      setWaitForChainEnd,
      markChainIdle,
      getJoinAttempt,
      getLiveChainJoinInfo,
      CHAIN_ONGOING_MSG,
      LIVE_META_MAX_AGE_MS
    };
  } catch (e) {}
})();
