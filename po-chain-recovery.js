/**
 * po-chain-recovery.js
 * Mid-chain payout gate: only continue MG if a WIN at the live payout
 * would cover losses already on the table.
 *
 * Binary win profit ≈ stake * (payoutPct / 100). Stake itself is returned on win.
 * So we need: nextStake * payoutPct/100 >= lossesSoFar
 */
'use strict';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * @param {{ lossesSoFar: number, nextStake: number, payoutPct: number }} input
 */
function recoveryCheck(input = {}) {
  const lossesSoFar = Math.max(0, Number(input.lossesSoFar) || 0);
  const nextStake = Math.max(0, Number(input.nextStake) || 0);
  const payoutPct = Number(input.payoutPct);

  if (!Number.isFinite(payoutPct) || payoutPct < 0) {
    return {
      ok: false,
      covers: false,
      reason: 'invalid_payout',
      lossesSoFar: round2(lossesSoFar),
      nextStake: round2(nextStake),
      payoutPct: null,
      profitIfWin: null,
      minPayoutPct: null,
      shortfall: null
    };
  }

  if (lossesSoFar <= 0) {
    return {
      ok: true,
      covers: true,
      reason: 'no_losses',
      lossesSoFar: 0,
      nextStake: round2(nextStake),
      payoutPct: round2(payoutPct),
      profitIfWin: round2(nextStake * (payoutPct / 100)),
      minPayoutPct: 0,
      shortfall: 0
    };
  }

  if (nextStake <= 0) {
    return {
      ok: false,
      covers: false,
      reason: 'invalid_stake',
      lossesSoFar: round2(lossesSoFar),
      nextStake: 0,
      payoutPct: round2(payoutPct),
      profitIfWin: 0,
      minPayoutPct: null,
      shortfall: round2(lossesSoFar)
    };
  }

  const profitIfWin = nextStake * (payoutPct / 100);
  const minPayoutPct = (lossesSoFar / nextStake) * 100;
  const covers = profitIfWin + 1e-9 >= lossesSoFar;
  const shortfall = Math.max(0, lossesSoFar - profitIfWin);

  return {
    ok: true,
    covers,
    reason: covers ? 'covers' : 'insufficient_payout',
    lossesSoFar: round2(lossesSoFar),
    nextStake: round2(nextStake),
    payoutPct: round2(payoutPct),
    profitIfWin: round2(profitIfWin),
    minPayoutPct: round2(minPayoutPct),
    shortfall: round2(shortfall)
  };
}

/**
 * SSID-placed ladder step for the next ticket.
 * Account settle (waitChain / force 1x) always returns 1.
 * Confirmed SSID losses drive mid-chain size. Bot candle history is last resort.
 */
function nextSizeAttempt(input = {}) {
  if (input.waitChain || input.forceNextAttempt1) return 1;
  const confirmed = Math.max(0, Math.trunc(Number(input.confirmedLosses) || 0));
  if (confirmed >= 5) return 1;
  if (confirmed > 0) return Math.min(5, confirmed + 1);
  const fromBot = Math.min(5, Math.max(1, Math.trunc(Number(input.fromBot) || 1)));
  if (fromBot > 1) return fromBot;
  const fromHistory = Math.min(5, Math.max(1, Math.trunc(Number(input.fromHistory) || 1)));
  return fromHistory;
}

/** After a bot WIN / user stop, do not place 1x-sized tickets on leftover S2–S4. */
function shouldHoldForNewBotChain(waitChain, signalAttempt) {
  if (!waitChain) return false;
  return Math.max(1, Math.trunc(Number(signalAttempt) || 1)) > 1;
}

function createPoChainRecovery() {
  /** @type {Map<string, { currency: string|null, entries: object[] }>} */
  const byBot = new Map();

  function ensure(botId) {
    let row = byBot.get(botId);
    if (!row) {
      row = { currency: null, entries: [] };
      byBot.set(botId, row);
    }
    return row;
  }

  function clear(botId) {
    byBot.delete(botId);
  }

  function startChain(botId, currency) {
    byBot.set(botId, {
      currency: currency || null,
      entries: []
    });
  }

  function notePlaced(botId, info = {}) {
    if (!botId) return null;
    const attempt = Number(info.attempt) || 1;
    const amount = Number(info.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    if (attempt <= 1) {
      startChain(botId, info.currency || null);
    }
    const row = ensure(botId);
    if (info.currency) row.currency = info.currency;

    const existing = row.entries.find((e) => e.attempt === attempt);
    if (existing) {
      existing.amount = amount;
      existing.dealId = info.dealId || existing.dealId || null;
      if (!existing.outcome || existing.outcome === 'pending') {
        existing.outcome = 'pending';
      }
      return existing;
    }

    const entry = {
      attempt,
      amount,
      dealId: info.dealId || null,
      outcome: 'pending',
      at: Date.now()
    };
    row.entries.push(entry);
    row.entries.sort((a, b) => a.attempt - b.attempt);
    return entry;
  }

  function noteOutcome(botId, info = {}) {
    if (!botId) return null;
    const row = byBot.get(botId);
    if (!row) return null;

    const attempt = Number(info.attempt) || 0;
    const dealId = info.dealId ? String(info.dealId) : null;
    let entry = null;
    if (dealId) entry = row.entries.find((e) => e.dealId && String(e.dealId) === dealId);
    if (!entry && attempt > 0) entry = row.entries.find((e) => e.attempt === attempt);
    if (!entry) return null;

    const outcome = String(info.outcome || '').toLowerCase();
    if (outcome === 'win') {
      entry.outcome = 'win';
      // Chain recovered — drop ledger.
      clear(botId);
      return entry;
    }
    if (outcome === 'draw') {
      entry.outcome = 'draw';
      // Stake returned — not a loss.
      return entry;
    }
    if (outcome === 'loss') {
      entry.outcome = 'loss';
      return entry;
    }
    return entry;
  }

  function getConfirmedLossCount(botId) {
    const row = byBot.get(botId);
    if (!row) return 0;
    let n = 0;
    for (const e of row.entries) {
      if (e.outcome === 'loss') n += 1;
    }
    return n;
  }

  /**
   * Money still needing recovery before the next stake.
   * Only confirmed SSID losses count. Pending is not a loss yet (check_win
   * may still pay a WIN on a tiny candle LOSS). Draws do not count.
   */
  function getLossesSoFar(botId) {
    const row = byBot.get(botId);
    if (!row) return 0;
    let sum = 0;
    for (const e of row.entries) {
      if (e.outcome === 'loss') sum += Number(e.amount) || 0;
    }
    return round2(sum);
  }

  function getState(botId) {
    const row = byBot.get(botId);
    if (!row) return null;
    return {
      currency: row.currency,
      entries: row.entries.slice(),
      lossesSoFar: getLossesSoFar(botId),
      confirmedLossCount: getConfirmedLossCount(botId)
    };
  }

  return {
    clear,
    startChain,
    notePlaced,
    noteOutcome,
    getLossesSoFar,
    getConfirmedLossCount,
    getState,
    recoveryCheck
  };
}

module.exports = {
  createPoChainRecovery,
  recoveryCheck,
  nextSizeAttempt,
  shouldHoldForNewBotChain,
  round2
};
