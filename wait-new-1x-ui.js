/**
 * wait-new-1x-ui.js
 * When Auto Trade freezes on "waiting for next 1x", Contabo can still publish
 * leftover S2–S4 Signals. Main skips place; this module must also refuse to
 * paint those cards (no ghost S3·10X countdown).
 *
 * Load AFTER renderer.js + po-deal-result-ui.js.
 */
(function () {
  'use strict';

  const waitNew1xByBot = Object.create(null);

  function botKeyOf(botIdOrKey) {
    const s = String(botIdOrKey || '').trim();
    if (!s) return null;
    const upper = s.toUpperCase();
    if (upper === 'LUMIX' || upper === 'MIRAX' || upper === 'NYX') return upper;
    if (s === 'bot1') return 'LUMIX';
    if (s === 'bot2') return 'MIRAX';
    if (s === 'bot3') return 'NYX';
    try {
      if (typeof window.utkBotKeyOf === 'function') {
        const k = window.utkBotKeyOf(s);
        if (k) return String(k).toUpperCase();
      }
    } catch (e) {}
    return upper;
  }

  function botIdOf(botKey) {
    const key = botKeyOf(botKey);
    if (key === 'LUMIX') return 'bot1';
    if (key === 'MIRAX') return 'bot2';
    if (key === 'NYX') return 'bot3';
    return null;
  }

  function isLeftoverAttempt(signal) {
    const attempt = Number(signal?.attempt) || 1;
    const realLoss = Number(signal?.realLossStreak ?? signal?.real_loss_streak) || 0;
    const stakeMultiplier = Number(signal?.stakeMultiplier) || 0;
    return attempt > 1 || realLoss > 0 || stakeMultiplier > 1;
  }

  function setWaitingNew1x(botIdOrKey, on) {
    const key = botKeyOf(botIdOrKey);
    if (!key) return;
    waitNew1xByBot[key] = !!on;
  }

  function isWaitingNew1x(botIdOrKey) {
    const key = botKeyOf(botIdOrKey);
    return !!(key && waitNew1xByBot[key]);
  }

  function hooks() {
    try { return window.__utkSignalHooks || {}; } catch (e) { return {}; }
  }

  function clearLeftoverSignalCard(botKeyOrId) {
    const botKey = botKeyOf(botKeyOrId);
    if (!botKey) return;
    const h = hooks();
    try {
      if (typeof h.purgeStaleActiveSignal === 'function') {
        h.purgeStaleActiveSignal(botKey);
        return;
      }
    } catch (e) {}
    try { if (typeof h.clearCountdown === 'function') h.clearCountdown(botKey); } catch (e) {}
    try { if (typeof h.resetTradeCard === 'function') h.resetTradeCard(botKey); } catch (e) {}
    try { if (typeof h.clearSignalUI === 'function') h.clearSignalUI(botKey); } catch (e) {}
    try {
      if (typeof h.clearActiveSignalFromFirebase === 'function') {
        h.clearActiveSignalFromFirebase(botKey);
      }
    } catch (e) {}
    try { window.BotPhaseGuard?.markSettled?.(botKey); } catch (e) {}
  }

  /**
   * True → do not paint / restore this Signal (or Preparing).
   * Fresh attempt-1 clears the freeze so the next chain can show.
   */
  function shouldSuppressLeftoverSignalUi(botKeyOrId, signal) {
    const key = botKeyOf(botKeyOrId);
    if (!key || !waitNew1xByBot[key]) return false;
    if (!isLeftoverAttempt(signal)) {
      setWaitingNew1x(key, false);
      return false;
    }
    return true;
  }

  function onPoDealResult(data) {
    if (!data || !data.botId) return;
    const botId = data.botId;
    const botKey = botKeyOf(botId);
    if (!botKey) return;

    if (data.chainFreeze === true) {
      setWaitingNew1x(botKey, true);
      // Leftover mid-chain paints (or the skipped Signal itself) must not linger.
      const skipped = Number(data.skippedAttempt) || 0;
      if (
        data.freezeReason === 'waiting_new_1x' ||
        data.source === 'wait-chain' ||
        skipped > 1
      ) {
        clearLeftoverSignalCard(botKey);
      }
      return;
    }

    if (
      data.chainFreeze === false ||
      data.source === 'new-chain' ||
      data.outcome === 'resume'
    ) {
      setWaitingNew1x(botKey, false);
    }
  }

  try {
    const { ipcRenderer } = require('electron');
    ipcRenderer.on('po-deal-result', (_event, data) => {
      try { onPoDealResult(data); } catch (e) {}
    });
  } catch (e) {}

  try {
    if (typeof window !== 'undefined') {
      window.__utkWaitNew1x = waitNew1xByBot;
      window.setWaitingNew1x = setWaitingNew1x;
      window.isWaitingNew1x = isWaitingNew1x;
      window.shouldSuppressLeftoverSignalUi = shouldSuppressLeftoverSignalUi;
      window.clearLeftoverSignalCard = clearLeftoverSignalCard;
    }
  } catch (e) {}

  try {
    module.exports = {
      setWaitingNew1x,
      isWaitingNew1x,
      shouldSuppressLeftoverSignalUi,
      clearLeftoverSignalCard,
      onPoDealResult
    };
  } catch (e) {}
})();
