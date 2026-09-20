/**
 * saving-signal-history.js
 * Saving Signals ladder is the whole WIN/LOSS tape until a WIN or 5 losses.
 * Pair hops do not reset the step — only a WIN, a 5-loss wipe, or a payout-stop does.
 */
(function (root) {
  'use strict';

  function parseOutcome(trade) {
    const resultUpper = String((trade && trade.result) || '').trim().toUpperCase();
    return {
      isWin: resultUpper === 'WIN' || resultUpper === 'WON' || resultUpper === 'SUCCESS' || resultUpper === 'W',
      isLoss: resultUpper === 'LOSS' || resultUpper === 'LOSE' || resultUpper === 'LOST' || resultUpper === 'L'
    };
  }

  function isResultEntry(trade) {
    if (!trade) return false;
    const phase = String(trade.phase || '').trim().toLowerCase();
    if (phase === 'trading result' || phase === 'result') return true;
    const res = String(trade.result || '').trim().toLowerCase();
    return ['win', 'won', 'success', 'w', 'loss', 'lose', 'lost', 'l'].indexOf(res) !== -1;
  }

  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v <= 0) return 0;
      return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
    }
    const d = Date.parse(String(v));
    return Number.isFinite(d) ? d : 0;
  }

  function openMs(trade) {
    return (
      toMs(trade && trade.openedAtMs) ||
      toMs(trade && trade.openingTime) ||
      toMs(trade && trade.timestamp) ||
      0
    );
  }

  function closeMs(trade) {
    return (
      toMs(trade && trade.closedAtMs) ||
      toMs(trade && trade.closingTime) ||
      0
    );
  }

  function resultSortMs(trade) {
    return closeMs(trade) || openMs(trade) || toMs(trade && trade.createdAt) || 0;
  }

  /** Contabo tape is oldest-first. Live step labels must start at the newest fill. */
  function newestFirst(list) {
    const rows = Array.isArray(list) ? list.slice() : [];
    rows.sort(function (a, b) {
      const da = resultSortMs(a);
      const db = resultSortMs(b);
      if (da !== db) return db - da;
      return 0;
    });
    return rows;
  }

  function pairKey(trade) {
    return String(
      (trade && (trade.symbol || trade.currency || trade.selectedCurrency || trade.pair)) || ''
    )
      .toUpperCase()
      .replace(/OTC/g, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  function windowClose(trade, open) {
    const c = closeMs(trade);
    if (c > open) return c;
    const dur = Number(trade && (trade.durationSec || trade.duration));
    if (Number.isFinite(dur) && dur > 0) {
      return open + Math.min(210000, Math.round(dur * 1000));
    }
    return open + 30000;
  }

  const SAME_OPEN_GHOST_MS = 2500;

  /**
   * Incoming is a ghost if it opens while an earlier same-pair trade is still live.
   * (Bot double-print / overlapping 30s windows, e.g. 11:35:16 inside 11:35:10–11:35:40.)
   */
  function overlapsAsGhost(trades, incoming) {
    if (!incoming) return false;
    const incPair = pairKey(incoming);
    const incOpen = openMs(incoming);
    if (!incPair || !incOpen) return false;
    const list = Array.isArray(trades) ? trades : [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t || t.localOnly) continue;
      if (!isResultEntry(t)) continue;
      if (pairKey(t) !== incPair) continue;
      const tOpen = openMs(t);
      if (!tOpen) continue;
      if (Math.abs(incOpen - tOpen) < SAME_OPEN_GHOST_MS && incOpen >= tOpen) return true;
      if (incOpen > tOpen && incOpen < windowClose(t, tOpen)) return true;
    }
    return false;
  }

  /** Drop later same-pair results that opened inside incoming's live window. */
  function pruneCoveredGhosts(trades, incoming) {
    const list = Array.isArray(trades) ? trades.slice() : [];
    if (!incoming) return list;
    const incPair = pairKey(incoming);
    const incOpen = openMs(incoming);
    if (!incPair || !incOpen) return list;
    const incClose = windowClose(incoming, incOpen);
    return list.filter(function (t) {
      if (!t || t.localOnly || t === incoming) return true;
      if (!isResultEntry(t)) return true;
      if (pairKey(t) !== incPair) return true;
      const tOpen = openMs(t);
      if (!tOpen) return true;
      return !(tOpen > incOpen && tOpen < incClose) &&
        !(Math.abs(tOpen - incOpen) < SAME_OPEN_GHOST_MS && tOpen >= incOpen && t !== incoming);
    });
  }

  /**
   * Keep the earliest-open fill per overlapping same-pair window.
   * Preserves original order of the remaining rows.
   */
  function collapseOverlappingResults(trades) {
    const list = Array.isArray(trades) ? trades : [];
    const drop = new Set();
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!t || t.localOnly) continue;
      if (!isResultEntry(t)) continue;
      const outcome = parseOutcome(t);
      if (!outcome.isWin && !outcome.isLoss) continue;
      rows.push({ t: t, open: openMs(t), pair: pairKey(t) });
    }
    rows.sort(function (a, b) { return a.open - b.open; });
    const kept = [];
    for (let i = 0; i < rows.length; i++) {
      const cur = rows[i];
      if (!cur.pair || !cur.open) {
        kept.push(cur);
        continue;
      }
      let ghost = false;
      for (let k = 0; k < kept.length; k++) {
        const prev = kept[k];
        if (prev.pair !== cur.pair || !prev.open) continue;
        if (Math.abs(cur.open - prev.open) < SAME_OPEN_GHOST_MS) {
          ghost = true;
          break;
        }
        if (cur.open > prev.open && cur.open < windowClose(prev.t, prev.open)) {
          ghost = true;
          break;
        }
      }
      if (ghost) drop.add(cur.t);
      else kept.push(cur);
    }
    if (drop.size === 0) return list;
    return list.filter(function (t) { return !drop.has(t); });
  }

  /**
   * Newest-first trade list. Count consecutive losses across the whole tape.
   * A WIN, a payout-stop, or a 5-loss wipe resets to 0. Pair hops do not
   * unless opts.isolated (MIRAX: each bot chain is its own 1x).
   */
  function getLossesFromHistory(trades, pair, opts) {
    const isolated = !!(opts && opts.isolated);
    const wantPair = pairKey({ symbol: pair });
    let streak = 0;
    const list = newestFirst(collapseOverlappingResults(Array.isArray(trades) ? trades : []));
    for (let i = 0; i < list.length; i++) {
      const trade = list[i];
      if (trade && trade.ladderReset) break;
      if (trade && (trade.chainComplete || trade.chainReset)) {
        if (isolated) break;
        if (!trade.ladderReset) continue;
      }
      if (!isResultEntry(trade)) continue;
      if (isolated && wantPair) {
        const pk = pairKey(trade);
        if (pk && pk !== wantPair) continue;
      }
      const outcome = parseOutcome(trade);
      if (outcome.isWin) break;
      if (outcome.isLoss) {
        streak += 1;
        if (streak >= 5) {
          streak = 0;
          break;
        }
      } else {
        break;
      }
    }
    return Math.min(streak, 4);
  }

  /**
   * Attempt (1–5) for the next/current trade, from the whole WIN/LOSS tape.
   * Bot attempt is ignored after a WIN / wipe (stale 4/5 on a hop).
   * A WIN/LOSS result is labeled as THAT step (win after 3 losses = S4), not the next chain.
   */
  function lastResultPair(trades) {
    const list = newestFirst(Array.isArray(trades) ? trades : []);
    for (let i = 0; i < list.length; i++) {
      const trade = list[i];
      if (!trade || trade.localOnly) continue;
      if (!isResultEntry(trade)) continue;
      const pk = pairKey(trade);
      if (pk) return pk;
    }
    return '';
  }

  function sameOpen(a, b) {
    const oa = openMs(a);
    const ob = openMs(b);
    if (!oa || !ob) return !oa && !ob;
    return Math.abs(oa - ob) < SAME_OPEN_GHOST_MS;
  }

  function headIsSameResult(trades, signal, wantWin) {
    const list = Array.isArray(trades) ? trades : [];
    const head = list[0];
    if (!head || !signal) return false;
    const ho = parseOutcome(head);
    if (wantWin ? !ho.isWin : !ho.isLoss) return false;
    const sigPair = pairKey(signal);
    const headPair = pairKey(head);
    if (sigPair && headPair && sigPair !== headPair) return false;
    const sid = String((signal && (signal.id || signal._id || signal.tradeId)) || '');
    const hid = String((head && (head.id || head._id || head.tradeId)) || '');
    if (sid && hid) return sid === hid;
    if (openMs(signal) && openMs(head)) return sameOpen(head, signal);
    return true;
  }

  function resolveAttempt(trades, signal, opts) {
    const isolated = !!(opts && opts.isolated);
    const sigPair = pairKey(signal);
    const outcome = parseOutcome(signal);
    const list = newestFirst(Array.isArray(trades) ? trades : []);
    let working = list;
    if (outcome.isWin && headIsSameResult(list, signal, true)) {
      working = list.slice(1);
    }
    const histOpts = isolated ? { isolated: true } : undefined;
    let histAttempt = Math.min(5, getLossesFromHistory(working, sigPair, histOpts) + 1);
    if (outcome.isLoss && headIsSameResult(list, signal, false)) {
      histAttempt = Math.min(5, Math.max(1, getLossesFromHistory(list, sigPair, histOpts)));
    }
    if (isolated) {
      const raw = Number(signal && signal.attempt);
      const fromBot = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.trunc(raw), 5) : 1;
      const cap = Number(signal && signal.maxAttempts);
      const maxA = Number.isFinite(cap) && cap >= 1 ? Math.min(5, Math.trunc(cap)) : 2;
      if (outcome.isWin || outcome.isLoss) {
        return Math.min(maxA, Number.isFinite(raw) && raw >= 1 ? fromBot : histAttempt);
      }
      return Math.min(maxA, fromBot);
    }
    if (outcome.isWin || outcome.isLoss) return histAttempt;
    const raw = Number(signal && signal.attempt);
    const fromBot = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.trunc(raw), 5) : null;
    const lastPair = lastResultPair(trades);
    if (fromBot != null && fromBot > 1) {
      if (!lastPair) return fromBot;
      if (histAttempt > 1) return Math.max(fromBot, histAttempt);
    }
    return histAttempt;
  }

  function nextAttemptAfterResult(trades, result) {
    const outcome = parseOutcome(result || {});
    if (outcome.isWin) return 1;
    const pair = pairKey(result);
    const prev = getLossesFromHistory(trades, pair);
    if (!outcome.isLoss) return Math.min(5, prev + 1);
    const run = prev + 1;
    if (run >= 5) return 1;
    return Math.min(5, run + 1);
  }

  const api = {
    getLossesFromHistory: getLossesFromHistory,
    resolveAttempt: resolveAttempt,
    nextAttemptAfterResult: nextAttemptAfterResult,
    parseOutcome: parseOutcome,
    isResultEntry: isResultEntry,
    collapseOverlappingResults: collapseOverlappingResults,
    overlapsAsGhost: overlapsAsGhost,
    pruneCoveredGhosts: pruneCoveredGhosts
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  try { root.__utkSavingHistory = api; } catch (e) {}
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
