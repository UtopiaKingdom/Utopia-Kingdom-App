/**
 * bot-phase-guard.js
 * One live card at a time: Signal (locked) → Result → fade → wait.
 * Preparing is ignored. Blocks stale Firebase/WS replays and pair swaps.
 */
(function initBotPhaseGuard(global) {
  const RANK = {
    preparing: 1,
    signal: 2,
    cancelled: 2,
    'signal cancelled': 2,
    'trading result': 3,
    result: 3,
    'chain complete': 4,
    settled: 5,
  };

  /** @type {Record<string, { phase: string, attempt: number, signalId: string, openedAtMs: number, pair: string, settled: boolean, at: number }>} */
  const last = Object.create(null);

  function normPhase(raw) {
    const p = String(raw || '').trim().toLowerCase();
    if (p === 'preparing') return 'Preparing';
    if (p === 'signal') return 'Signal';
    if (p === 'trading result' || p === 'result') return 'Trading Result';
    if (p === 'chain complete') return 'Chain Complete';
    if (p === 'cancelled' || p === 'signal cancelled') return 'Cancelled';
    if (p === 'settled' || p === 'idle') return 'Settled';
    return String(raw || '').trim();
  }

  function attemptOf(signal) {
    const n = Number(signal && signal.attempt);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function signalIdOf(signal) {
    return String((signal && (signal.signalId || signal.signal_id)) || '').trim();
  }

  function pairOf(signal) {
    const raw = String(
      (signal && (signal.selectedCurrency || signal.symbol || signal.currency || signal.pair)) || ''
    ).trim().toUpperCase();
    return raw.replace(/[^A-Z0-9]/g, '');
  }

  function rankOf(phase) {
    return RANK[String(phase || '').toLowerCase()] || 0;
  }

  function openedAtOf(signal) {
    const v = signal && (signal.openedAtMs != null ? signal.openedAtMs : signal.opened_at_ms);
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e12) return n;
    if (Number.isFinite(n) && n > 1e9 && n < 1e12) return n * 1000;
    return 0;
  }

  function isSameLiveTrade(prev, signalId, openedAtMs, pair) {
    if (!prev) return false;
    if (signalId && prev.signalId && signalId === prev.signalId) return true;
    if (openedAtMs && prev.openedAtMs && Math.abs(openedAtMs - prev.openedAtMs) < 2000) return true;
    return false;
  }

  function isClearlyNewTrade(prev, signalId, openedAtMs, pair) {
    if (!prev) return true;
    if (signalId && prev.signalId && signalId !== prev.signalId) return true;
    if (openedAtMs && prev.openedAtMs && Math.abs(openedAtMs - prev.openedAtMs) > 2000) return true;
    if (pair && prev.pair && pair !== prev.pair) return true;
    return false;
  }

  function isTerminal(phase) {
    return phase === 'Trading Result' || phase === 'Chain Complete' || phase === 'Cancelled' || phase === 'Settled';
  }

  /**
   * @returns {{ ok: boolean, reason?: string }}
   */
  function shouldAcceptPhase(botKey, signal) {
    const key = String(botKey || '').toUpperCase();
    if (!key || !signal) return { ok: true };

    const phase = normPhase(signal.phase);
    if (phase === 'Preparing') {
      return { ok: false, reason: 'preparing ignored' };
    }

    const attempt = attemptOf(signal);
    const signalId = signalIdOf(signal);
    const openedAtMs = openedAtOf(signal);
    const pair = pairOf(signal);
    const updateOnly =
      !!signal.updateOnly || String(signal.updateKind || '').toLowerCase() === 'openingprice';
    const prev = last[key];
    const now = Date.now();

    if (!prev) {
      return { ok: true };
    }

    const same = isSameLiveTrade(prev, signalId, openedAtMs, pair);
    const different = isClearlyNewTrade(prev, signalId, openedAtMs, pair);

    // Same Signal price patch — never after that trade already settled.
    if (phase === 'Signal' && updateOnly) {
      if (prev.settled || prev.phase === 'Settled') {
        if (same || (!different && attempt <= prev.attempt)) {
          return { ok: false, reason: 'updateOnly after settled' };
        }
      }
      if (prev.phase === 'Trading Result' || prev.phase === 'Chain Complete') {
        if (attempt <= prev.attempt && (same || !different)) {
          return { ok: false, reason: 'updateOnly after result same attempt' };
        }
      }
      if (prev.phase === 'Signal' && different) {
        return { ok: false, reason: 'signal locked' };
      }
      return { ok: true };
    }

    // After fade: that trade is dead. Only a new identity may paint.
    if (prev.settled || prev.phase === 'Settled') {
      if (phase === 'Trading Result' || phase === 'Chain Complete') {
        if (same || (!different && attempt <= prev.attempt)) {
          return { ok: false, reason: 'stale Result after fade' };
        }
        return { ok: false, reason: 'result after empty' };
      }
      if (phase === 'Signal') {
        if (same) return { ok: false, reason: 'stale Signal after fade' };
        return { ok: true };
      }
      return { ok: true };
    }

    // Live Signal stays until ITS result. Never swap pair / id / attempt.
    if (prev.phase === 'Signal') {
      if (phase === 'Signal') {
        if (same) return { ok: true };
        return { ok: false, reason: 'signal locked' };
      }
      if (phase === 'Trading Result') {
        if (same) return { ok: true };
        // signalId can drift (open clock vs parsed open_time) — same pair+attempt is this trade.
        const samePairAttempt = !!(pair && prev.pair && pair === prev.pair && attempt === prev.attempt);
        if (samePairAttempt) return { ok: true };
        if (different && !same) return { ok: false, reason: 'result for other signal' };
        return { ok: true };
      }
      if (phase === 'Chain Complete' || phase === 'Cancelled') {
        return { ok: true };
      }
    }

    // Result on screen: keep it. Next MG Signal is a new identity / higher attempt.
    if (prev.phase === 'Trading Result' || prev.phase === 'Chain Complete' || prev.phase === 'Cancelled') {
      if (phase === 'Trading Result') {
        if (same || !different) return { ok: true };
        if (attempt < prev.attempt) return { ok: false, reason: 'older result' };
        return { ok: false, reason: 'result for other signal' };
      }
      if (phase === 'Signal') {
        if (same) return { ok: false, reason: 'stale Signal after Result' };
        if (attempt > prev.attempt) return { ok: true };
        if (attempt <= prev.attempt && different) return { ok: true };
        if (!different && now - prev.at < 12 * 1000) {
          return { ok: false, reason: 'stale Signal after Result' };
        }
        return { ok: true };
      }
      if (phase === 'Chain Complete') return { ok: true };
    }

    if (attempt > prev.attempt) {
      return { ok: true };
    }

    if (attempt === prev.attempt) {
      const prevRank = rankOf(prev.phase);
      const nextRank = rankOf(phase);
      if (nextRank < prevRank) {
        return { ok: false, reason: `phase regress ${prev.phase} -> ${phase}` };
      }
      if (phase === prev.phase && same && now - prev.at < 2000) {
        return { ok: false, reason: 'duplicate phase burst' };
      }
    }

    if (attempt < prev.attempt) {
      if (isTerminal(prev.phase) && phase === 'Signal' && different) {
        return { ok: true };
      }
      if (phase === 'Signal' && now - prev.at > 90 * 1000 && different) {
        return { ok: true };
      }
      return { ok: false, reason: 'older attempt' };
    }

    return { ok: true };
  }

  function notePhaseAccepted(botKey, signal) {
    const key = String(botKey || '').toUpperCase();
    if (!key || !signal) return;
    const phase = normPhase(signal.phase);
    if (!phase || phase === 'Preparing') return;
    const prev = last[key];
    const nextId = signalIdOf(signal);
    const nextOpened = openedAtOf(signal);
    const nextPair = pairOf(signal);
    const inherit = phase === 'Trading Result' || phase === 'Chain Complete' || phase === 'Cancelled';
    last[key] = {
      phase,
      attempt: attemptOf(signal),
      signalId: nextId || (inherit && prev && prev.signalId) || '',
      openedAtMs: nextOpened || (inherit && prev && prev.openedAtMs) || 0,
      pair: nextPair || (inherit && prev && prev.pair) || '',
      settled: false,
      at: Date.now(),
    };
  }

  function markSettled(botKey) {
    const key = String(botKey || '').toUpperCase();
    if (!key) return;
    const prev = last[key];
    if (!prev) {
      last[key] = { phase: 'Settled', attempt: 1, signalId: '', openedAtMs: 0, pair: '', settled: true, at: Date.now() };
      return;
    }
    last[key] = {
      ...prev,
      phase: 'Settled',
      settled: true,
      at: Date.now(),
    };
  }

  function resetBot(botKey) {
    const key = String(botKey || '').toUpperCase();
    if (key) delete last[key];
  }

  function canRehydrate(botKey, data) {
    const key = String(botKey || '').toUpperCase();
    if (!key || !data) return false;
    const phase = normPhase(data.phase);
    if (phase === 'Preparing') return false;
    const prev = last[key];
    if (prev && (prev.settled || prev.phase === 'Settled')) {
      if (phase === 'Trading Result' || phase === 'Chain Complete') return false;
      const verdict = shouldAcceptPhase(key, data);
      return !!(verdict && verdict.ok);
    }
    if (prev && prev.phase === 'Signal' && phase === 'Signal') {
      const verdict = shouldAcceptPhase(key, data);
      return !!(verdict && verdict.ok);
    }
    const verdict = shouldAcceptPhase(key, data);
    return !!(verdict && verdict.ok);
  }

  global.BotPhaseGuard = {
    shouldAcceptPhase,
    notePhaseAccepted,
    markSettled,
    resetBot,
    canRehydrate,
    normPhase,
    getLast(botKey) {
      const key = String(botKey || '').toUpperCase();
      return key ? last[key] || null : null;
    },
  };
})(typeof window !== 'undefined' ? window : global);
