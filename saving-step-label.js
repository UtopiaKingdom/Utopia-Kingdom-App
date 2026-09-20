/**
 * saving-step-label.js
 * ENTRY / S1–S4 labels for the live card and history.
 * Attempt 1 (first after a WIN or 5-loss wipe) is ENTRY.
 * After that first LOSS, the next four are S1–S4. S4 loss resets to ENTRY.
 */
(function (root) {
  'use strict';

  const STEP = [null, 'ENTRY', 'S1', 'S2', 'S3', 'S4'];
  const LADDERS = {
    '2x': [1, 2, 4, 10, 20],
    '4x': [1, 4, 7, 16, 44]
  };

  function clampAttempt(n) {
    const a = Math.trunc(Number(n) || 0);
    if (!Number.isFinite(a) || a < 1) return 1;
    return Math.min(5, a);
  }

  function stepOfAttempt(attempt) {
    return STEP[clampAttempt(attempt)] || null;
  }

  /** Attempt 1 = ENTRY. Attempts 2–5 = S1–S4. */
  function badgeFor(attempt) {
    return STEP[clampAttempt(attempt)] || null;
  }

  function multiplierOf(attempt, mode, ladderOverride) {
    const a = clampAttempt(attempt);
    if (a <= 1) return null;
    let ladder = LADDERS[mode === '4x' ? '4x' : '2x'];
    if (Array.isArray(ladderOverride) && ladderOverride.length >= 5) {
      ladder = ladderOverride;
    } else if (mode === 'custom') {
      ladder = LADDERS['2x'];
    }
    const mult = ladder[a - 1];
    return mult != null ? (mult + 'x') : null;
  }

  function parseOutcome(t) {
    const r = String((t && (t.result || t.outcome)) || '').trim().toUpperCase();
    if (r === 'WIN' || r === 'WON' || r === 'SUCCESS' || r === 'W') return 'WIN';
    if (r === 'LOSS' || r === 'LOSE' || r === 'LOST' || r === 'L') return 'LOSS';
    return '';
  }

  function tradeMs(t) {
    const keys = ['openedAtMs', 'openingTime', 'timestamp', 'closedAtMs', 'closingTime', 'createdAt'];
    for (let i = 0; i < keys.length; i++) {
      const n = Number(t && t[keys[i]]);
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    }
    return 0;
  }

  function storedAttempt(t) {
    if (t && t.attempt != null && Number.isFinite(Number(t.attempt))) {
      return clampAttempt(t.attempt);
    }
    const id = String((t && (t.id || t._id)) || '');
    const m = /(?:^|__)a(\d+)(?:__|$)/.exec(id);
    if (m) return clampAttempt(m[1]);
    return 1;
  }

  function pairKey(t) {
    return String(
      (t && (t.symbol || t.selectedCurrency || t.currency || t.pair)) || ''
    )
      .toUpperCase()
      .replace(/OTC/g, '')
      .replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Consecutive losses on the whole tape (newest-first).
   * A WIN, a payout-stop, or a 5-loss wipe starts a new 1x chain. Pair hops do not.
   */
  function consecutiveLosses(trades, signal) {
    const list = Array.isArray(trades) ? trades : [];
    let i = 0;
    const sigRes = parseOutcome(signal);
    if (sigRes === 'WIN' && list[0] && parseOutcome(list[0]) === 'WIN') i = 1;
    let n = 0;
    for (; i < list.length; i++) {
      const t = list[i];
      if (!t) continue;
      if (t.ladderReset) break;
      if (t.chainReset || t.chainComplete) continue;
      const phase = String(t.phase || '').toLowerCase();
      if (phase === 'chain complete') continue;
      const res = parseOutcome(t);
      if (res === 'WIN') break;
      if (res === 'LOSS') {
        n += 1;
        if (n >= 5) return 0;
        continue;
      }
    }
    return Math.min(4, n);
  }

  function displayAttempt(trades, signal) {
    try {
      if (root.__utkSavingHistory && typeof root.__utkSavingHistory.resolveAttempt === 'function') {
        return root.__utkSavingHistory.resolveAttempt(trades, signal);
      }
    } catch (e) {}
    const stored = storedAttempt(signal);
    if (stored > 1) return stored;
    return Math.min(5, consecutiveLosses(trades, signal) + 1);
  }

  function formatStepLabel(attempt, opts) {
    const step = badgeFor(attempt);
    if (!step) return null;
    const showX = !!(opts && opts.showMultiplier);
    const mode = opts && opts.mode;
    const ladder = opts && opts.ladder;
    const x = showX ? multiplierOf(attempt, mode, ladder) : null;
    return x ? (step + ' · ' + x) : step;
  }

  function annotationKey(t, idx) {
    return (
      pairKey(t) + '|' +
      tradeMs(t) + '|' +
      parseOutcome(t) + '|' +
      String((t && (t.id || t._id)) || (idx != null ? idx : ''))
    );
  }

  /**
   * Walk oldest→newest. Default: whole-tape save ladder.
   * opts.isolated: badge from the stored bot attempt (ENTRY, then S1–S4 on that chain).
   * Pair hops do not jump to S3–S4.
   */
  function annotateSaveSteps(items, opts) {
    const isolated = !!(opts && opts.isolated);
    let source = (items || []).filter(Boolean);
    try {
      if (root.__utkSavingHistory && typeof root.__utkSavingHistory.collapseOverlappingResults === 'function') {
        source = root.__utkSavingHistory.collapseOverlappingResults(source);
      }
    } catch (e) {}
    const rows = source.slice().sort(function (a, b) {
      const da = tradeMs(a) - tradeMs(b);
      if (da !== 0) return da;
      return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
    });
    const byId = Object.create(null);
    let lossRun = 0;
    rows.forEach(function (t, idx) {
      const res = parseOutcome(t);
      if (res !== 'WIN' && res !== 'LOSS') return;
      let attempt = 1;
      let step = null;
      if (isolated) {
        attempt = storedAttempt(t);
        step = badgeFor(attempt);
      } else if (res === 'LOSS') {
        lossRun += 1;
        attempt = Math.min(5, lossRun);
        step = badgeFor(attempt);
        if (lossRun >= 5) {
          lossRun = 0;
        }
      } else {
        attempt = Math.min(5, lossRun + 1);
        step = badgeFor(attempt);
        lossRun = 0;
      }
      const rec = {
        attempt: attempt,
        step: step,
        label: formatStepLabel(attempt, { result: res })
      };
      if (t && t.id) byId[t.id] = rec;
      byId[annotationKey(t, idx)] = rec;
    });
    return byId;
  }

  function lookupAnnotation(annotated, item) {
    if (!annotated || !item) return null;
    if (item.id && annotated[item.id]) return annotated[item.id];
    const stamp = annotationKey(item);
    if (annotated[stamp]) return annotated[stamp];
    return null;
  }

  function historyBadge(item, annotated) {
    const row = (annotated && typeof annotated === 'object' && Object.prototype.hasOwnProperty.call(annotated, 'step'))
      ? annotated
      : lookupAnnotation(annotated, item);
    if (!row || !Object.prototype.hasOwnProperty.call(row, 'step')) return '';
    const step = row.step;
    if (!step) return '';
    if (step === 'ENTRY') return step;
    const raw = String((item && item.savingSignalText) || '');
    const m = raw.match(/(\d+)\s*x/i);
    if (m && Number(m[1]) > 1) return step + ' · ' + m[1] + 'x';
    return step;
  }

  const api = {
    LADDERS: LADDERS,
    stepOfAttempt: stepOfAttempt,
    badgeFor: badgeFor,
    multiplierOf: multiplierOf,
    formatStepLabel: formatStepLabel,
    displayAttempt: displayAttempt,
    consecutiveLosses: consecutiveLosses,
    annotateSaveSteps: annotateSaveSteps,
    annotationKey: annotationKey,
    lookupAnnotation: lookupAnnotation,
    historyBadge: historyBadge,
    storedAttempt: storedAttempt
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  try { root.__utkSavingStep = api; } catch (e) {}
})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
