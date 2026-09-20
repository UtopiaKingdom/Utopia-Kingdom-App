/**
 * trade-duration.js
 * Pocket Option expiry defaults: LUMIX 3 minutes, MIRAX 30 seconds.
 * NYX picks 20s / 30s / 1m / 3m / 5m / 10m per signal — SSID must place that.
 * Load before renderer.js. Also required by main.js for SSID place.
 */
(function (root) {
  'use strict';

  const NYX_DURATIONS = [20, 30, 60, 180, 300, 600];
  // Common OTC buckets + any other divisor of 86400 is accepted by PO.
  const PO_COMMON = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600];

  function botKeyOf(bot) {
    const s = String(bot || '').trim().toUpperCase();
    if (s === 'BOT2' || s === 'MIRAX') return 'MIRAX';
    if (s === 'BOT1' || s === 'LUMIX') return 'LUMIX';
    if (s === 'BOT3' || s === 'NYX') return 'NYX';
    return s;
  }

  function getDefaultTradeSeconds(bot) {
    const key = botKeyOf(bot);
    if (key === 'MIRAX') return 30;
    if (key === 'NYX') return 60;
    return 180;
  }

  function snapNyxDuration(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n)) return 60;
    if (n < 20 || n > 600) return 60;
    let best = 60;
    for (let i = 0; i < NYX_DURATIONS.length; i++) {
      const d = NYX_DURATIONS[i];
      if (Math.abs(d - n) < Math.abs(best - n)) best = d;
    }
    return best;
  }

  /**
   * Pocket Option rejects expiries that do not divide 86400
   * ("Time must be a divisor of 86400"). Prefer common OTC buckets —
   * odd divisors like 54s often still fail per-asset.
   */
  function snapPoPlaceDuration(sec) {
    let n = Math.round(Number(sec));
    if (!Number.isFinite(n) || n < 5) return 5;
    if (n > 86400) n = 86400;
    if (PO_COMMON.indexOf(n) >= 0) return n;
    if (86400 % n === 0 && NYX_DURATIONS.indexOf(n) >= 0) return n;
    for (let i = PO_COMMON.length - 1; i >= 0; i--) {
      if (PO_COMMON[i] <= n) return PO_COMMON[i];
    }
    return 5;
  }

  /**
   * SSID / countdown expiry. Never inflate MiraX 30s up to a stale 60s default.
   * Preparing countdowns must not win — only signal.duration in a sane band.
   */
  function resolveTradeDurationSec(bot, signal, extra) {
    const key = botKeyOf(bot);
    const def = getDefaultTradeSeconds(key);
    if (key === 'STUDIO' || key.indexOf('STUDIO') === 0) {
      const n = Number(signal && signal.duration);
      if (Number.isFinite(n) && n >= 5 && n <= 600) return Math.round(n);
      const e = Number(extra);
      if (Number.isFinite(e) && e >= 5 && e <= 600) return Math.round(e);
      return 60;
    }
    if (key === 'MIRAX') {
      const n = Number(signal && signal.duration);
      if (Number.isFinite(n) && n >= 15 && n <= 45) return Math.round(n);
      const e = Number(extra);
      if (Number.isFinite(e) && e >= 15 && e <= 45) return Math.round(e);
      return 30;
    }
    if (key === 'NYX') {
      const n = Number(signal && signal.duration);
      if (Number.isFinite(n) && n >= 20 && n <= 600) return snapNyxDuration(n);
      const e = Number(extra);
      if (Number.isFinite(e) && e >= 20 && e <= 600) return snapNyxDuration(e);
      return 60;
    }
    const n = Number(signal && signal.duration);
    if (Number.isFinite(n) && n >= 60 && n <= 210) return Math.round(n);
    const e = Number(extra);
    if (Number.isFinite(e) && e >= 60 && e <= 210) return Math.round(e);
    return def;
  }

  /**
   * Seconds left until this signal's candle expiry. PO rejects a full 30s
   * (IncorrectExpTime) when S1 arrives mid-candle — send remaining time.
   * Remaining must still divide 86400 (57/58s were rejecting every place).
   * NYX 3m/5m/10m stays the snapped timeframe (do not shrink 5m into turbo).
   */
  function resolveLivePlaceDurationSec(bot, signal, extra) {
    const key = botKeyOf(bot);
    const full = resolveTradeDurationSec(bot, signal, extra);
    if (key === 'NYX' && full >= 180) return full;
    if ((key === 'STUDIO' || key.indexOf('STUDIO') === 0) && full >= 180) return snapPoPlaceDuration(full);
    const opened = Number(signal && (signal.openedAtMs || signal.sentAtMs));
    if (!Number.isFinite(opened) || opened <= 0) return snapPoPlaceDuration(full);
    const remain = Math.floor((opened + full * 1000 - Date.now()) / 1000);
    if (remain >= full) return snapPoPlaceDuration(full);
    // Still near candle open — place the full timeframe (avoids 57/58 rejects).
    if (remain >= Math.floor(full * 0.9)) return snapPoPlaceDuration(full);
    if (remain < 5) return 5;
    return snapPoPlaceDuration(remain);
  }

  function formatExpiryLabel(bot, signal, extra) {
    const key = botKeyOf(bot);
    if (key === 'MIRAX') return '30s';
    const sec = resolveTradeDurationSec(bot, signal, extra);
    if (key === 'NYX') {
      if (sec >= 600) return '10m';
      if (sec >= 300) return '5m';
      if (sec >= 180) return '3m';
      if (sec >= 60) return '1m';
      if (sec >= 30) return '30s';
      return '20s';
    }
    const fromSig = signal && (signal.expiry || signal.expiration);
    if (fromSig != null && String(fromSig).trim()) return String(fromSig);
    if (sec >= 60 && sec % 60 === 0) return (sec / 60) + 'm';
    return String(sec);
  }

  const api = {
    botKeyOf,
    getDefaultTradeSeconds,
    snapNyxDuration,
    snapPoPlaceDuration,
    resolveTradeDurationSec,
    resolveLivePlaceDurationSec,
    formatExpiryLabel
  };
  try { root.__utkTradeDuration = api; } catch (e) {}
  try { module.exports = api; } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : this);
