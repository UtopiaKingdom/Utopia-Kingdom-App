/**
 * po-deal-monitor.js
 * After SSID autotrade places a deal, poll Pocket Option for the REAL win/loss
 * of THAT deal (not an older one). Candle-based bot results can disagree
 * (late fill, 30s vs 1m, Move -2 still paid).
 *
 * While the PO ticket is still open: never use the bot candle for MG.
 * After expiry, read THIS ticket from the SSID closed-deal feed (account money).
 * Tiny OTC moves (SELL +3) often disagree with the bot candle — never use
 * candle LOSS to continue MG. Candle WIN after expiry only freezes SSID if
 * the account feed is still silent. Confirmed PO WIN / DRAW@1x → skip saves.
 */
'use strict';

function normalizeOutcome(raw) {
  const s = String(raw || '').trim().toLowerCase();
  // Never map API "success" / "ok" — those are request status, not a trade win.
  if (s === 'win' || s === 'won' || s === 'w') return 'win';
  if (s === 'loss' || s === 'lose' || s === 'lost' || s === 'loose' || s === 'l' || s === 'fail') return 'loss';
  if (s === 'draw' || s === 'tie' || s === 'equal' || s === 'refund') return 'draw';
  return null;
}

function outcomeFromResult(res) {
  if (!res || typeof res !== 'object') return null;
  const profit = res.profit != null ? Number(res.profit) : NaN;
  const labeled = normalizeOutcome(res.outcome);
  // Money on THIS payload wins. Do not treat $0 as a win.
  if (Number.isFinite(profit) && profit > 0) return 'win';
  if (Number.isFinite(profit) && profit < 0) return 'loss';
  if (Number.isFinite(profit) && profit === 0) {
    if (labeled === 'loss') return 'loss';
    return 'draw';
  }
  const src = String(res.source || '');
  // PO check_win / SSID closed-deal feed is the account. Candle expiry_hint WIN only freezes MG.
  if (src === 'check_win' || src === 'ssid_closed' || src === 'updateClosedDeals' || src === 'successcloseOrder') {
    return labeled;
  }
  if (src === 'expiry_hint' && labeled === 'win') return 'win';
  if (labeled === 'win') return null;
  if (src === 'trading_result' || src === 'expiry_hint') return null;
  return labeled;
}

/** Only a confirmed LOSS (or DRAW after 1x) may continue MG. Unknown freezes. */
function shouldFreezeMartingale(outcome, attempt) {
  const o = normalizeOutcome(outcome);
  if (o === 'loss') return false;
  if (o === 'draw') return (Number(attempt) || 1) <= 1;
  return true;
}

/**
 * Pocket Option get_deal_end_time is often hours off (local time stored as UTC).
 * Duration from the signal is the real expiry — only keep PO's time if it is close.
 */
function normalizeSettleAt(placedAt, durationSec, explicitSettle) {
  const placed = Number(placedAt) || Date.now();
  const durMs = Math.max(1000, Math.round(Number(durationSec) || 60) * 1000);
  const fromDuration = placed + durMs;
  const explicit = Number(explicitSettle);
  if (!Number.isFinite(explicit) || explicit <= 0) return fromDuration;
  const skew = Math.abs(explicit - fromDuration);
  if (skew > Math.max(20000, durMs * 0.35 + 5000)) return fromDuration;
  return explicit;
}

/** Seconds past settle before a pending watch is treated as leftover (must not block the next 1x).
 *  check_win often takes 8–20s; 2.5s used to drop the live ticket before PO answered. */
const LEFTOVER_PAST_SETTLE_MS = 35000;
/** After expiry, same-ticket candle WIN can freeze SSID if PO is still silent. */
const HINT_AFTER_SETTLE_MS = 1500;
/** After account WIN, ignore pair-switch 1x until at least this long after settle. */
const WIN_FREEZE_HOLD_AFTER_SETTLE_MS = 8000;

function freezeHoldExpired(entry) {
  if (!entry || !entry.chainFreeze) return true;
  const settle = Number(entry.settleAt) || Number(entry.resolvedAt) || 0;
  if (!(settle > 0)) return false;
  const durMs = Math.max(0, Math.round(Number(entry.durationSec) || 0) * 1000);
  const hold = Math.max(WIN_FREEZE_HOLD_AFTER_SETTLE_MS, durMs);
  return Date.now() >= settle + hold;
}

/** True while the SSID ticket is still inside its own expiry (late fills lag the bot candle). */
function dealStillOpen(entry, now) {
  const t = Number(now) || Date.now();
  const settleAt = Number(entry && entry.settleAt) || 0;
  return settleAt > 0 && t < settleAt - 300;
}

/**
 * @param {object} deps
 * @param {(req: object, timeoutMs?: number) => Promise<object>} deps.requestWorker
 * @param {(level: string, msg: string) => void} [deps.log]
 * @param {(payload: object) => void} [deps.onResult]
 */
function createPoDealMonitor(deps = {}) {
  const requestWorker = deps.requestWorker;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const onResult = typeof deps.onResult === 'function' ? deps.onResult : () => {};

  /** @type {Map<string, object>} */
  const byBot = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();

  function clearTimer(botId) {
    const t = timers.get(botId);
    if (t) {
      try { clearTimeout(t); } catch (e) {}
      timers.delete(botId);
    }
  }

  const persistNow = (entry) => {
    if (!entry?.placedByUs) return;
    if (typeof deps.persist === 'function' && entry) {
      try { deps.persist(entry); } catch (e) {}
    }
  };
  const persistClear = (botId) => {
    if (typeof deps.clearPersist === 'function' && botId) {
      try { deps.clearPersist(botId); } catch (e) {}
    }
  };

  function get(botId) {
    return byBot.get(botId) || null;
  }

  function clear(botId) {
    clearTimer(botId);
    byBot.delete(botId);
  }

  function isLeftoverPending(entry, botId) {
    if (!entry || !entry.pending) return false;
    const remain = (Number(entry.settleAt) || 0) - Date.now();
    const capMs = ((botId === 'bot2' ? 60 : botId === 'bot3' ? 600 : 210) * 1000);
    // Insane future settle, or a few seconds past our own expiry → do not block the next 1x.
    if (remain > capMs || remain < -LEFTOVER_PAST_SETTLE_MS) return true;
    if (entry.placedByUs !== true) return true;
    return false;
  }

  function dropBlockingLeftover(botId) {
    const entry = byBot.get(botId);
    if (!isLeftoverPending(entry, botId)) return false;
    log('info', `[PO-Deal] ${botId} drop leftover deal=${entry.dealId} so a real 1x can place`);
    persistClear(botId);
    clear(botId);
    return true;
  }

  function trackPlaced(botId, info = {}) {
    const dealId = String(info.dealId || info.deal_id || '').trim();
    if (!botId || !dealId) return null;

    const existing = byBot.get(botId);
    if (
      existing &&
      existing.pending &&
      existing.placedByUs === true &&
      String(existing.dealId) !== dealId &&
      info.placedByUs !== true
    ) {
      log('info', `[PO-Deal] ${botId} keep live deal=${existing.dealId} (ignore ${dealId})`);
      return existing;
    }

    clearTimer(botId);
    const defaultDur = botId === 'bot2' ? 30 : (botId === 'bot3' ? 60 : 180);
    let durationSec = Math.max(1, Math.round(Number(info.durationSec || info.duration) || defaultDur));
    if (botId === 'bot3') {
      if (durationSec < 20 || durationSec > 600) durationSec = 60;
    } else if (durationSec > defaultDur + (botId === 'bot2' ? 5 : 30)) {
      durationSec = defaultDur;
    }
    const placedAt = Number(info.placedAt) || Date.now();
    const settleAt = normalizeSettleAt(placedAt, durationSec, info.settleAt);
    const alreadySettled = info.pending === false && info.outcome && info.outcome !== 'watching';
    const entry = {
      botId,
      dealId,
      ssid: info.ssid || null,
      currency: info.currency || null,
      side: info.side || null,
      amount: Number(info.amount) || null,
      attempt: Number(info.attempt) || 1,
      durationSec,
      placedAt,
      settleAt,
      outcome: alreadySettled ? String(info.outcome).toLowerCase() : null,
      profit: alreadySettled && info.profit != null ? Number(info.profit) : null,
      pending: !alreadySettled,
      openSeen: false,
      source: info.source || null,
      polls: 0,
      chainFreeze: alreadySettled ? !!info.chainFreeze : false,
      checkWinTried: false,
      placedByUs: info.placedByUs === true,
      generation: Date.now(),
      openedAtMs: Number(info.openedAtMs) || Number(info.signalAtMs) || placedAt,
      signalAttempt: Number(info.signalAttempt || info.attempt) || 1,
      hintLocked: false
    };
    byBot.set(botId, entry);
    if (entry.placedByUs) persistNow(entry);
    log(
      'info',
      `[PO-Deal] ${botId} tracking deal=${dealId} attempt=${entry.attempt}` +
        (alreadySettled ? ` settled=${entry.outcome}` : ` settleIn=${Math.max(0, Math.round((settleAt - Date.now()) / 1000))}s`)
    );

    try {
      onResult({
        botId,
        dealId: entry.dealId,
        outcome: alreadySettled ? entry.outcome : 'watching',
        pending: entry.pending,
        profit: entry.profit,
        attempt: entry.attempt,
        amount: entry.amount,
        currency: entry.currency,
        side: entry.side,
        chainFreeze: entry.chainFreeze,
        source: alreadySettled ? (entry.source || 'resume') : 'tracking',
        settleAt: entry.settleAt,
        durationSec: entry.durationSec
      });
    } catch (e) {}

    if (!alreadySettled) {
      if (entry.ssid && typeof requestWorker === 'function') {
        try {
          const p = requestWorker({
            cmd: 'watch_deal',
            ssid: entry.ssid,
            deal_id: dealId,
            settle_at: settleAt
          }, 2000);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (e) {}
      }
    }
    return entry;
  }

  function schedulePoll(botId, delayMs) {
    clearTimer(botId);
    timers.set(botId, setTimeout(() => {
      timers.delete(botId);
      pollOnce(botId).catch((e) => {
        log('warn', `[PO-Deal] ${botId} poll error: ${e && e.message ? e.message : e}`);
      });
    }, Math.max(0, delayMs)));
  }

  async function queryDeal(entry, { fast = false, timeoutMs, allowBlock = false, ignoreOpen = false } = {}) {
    if (!entry?.ssid || !entry?.dealId || !requestWorker) {
      return { success: false, pending: true, error: 'missing ssid/deal' };
    }
    try {
      const to = Number(timeoutMs);
      const blocking = !!allowBlock;
      return await requestWorker({
        cmd: 'check_deal',
        ssid: entry.ssid,
        deal_id: entry.dealId,
        allow_block: blocking,
        ignore_open: !!ignoreOpen,
        fast: !!fast
      }, Number.isFinite(to) && to > 0 ? to : (blocking ? 25000 : (fast ? 1500 : 2500)));
    } catch (e) {
      return {
        success: false,
        pending: true,
        deal_id: entry.dealId,
        error: e && e.message ? e.message : String(e)
      };
    }
  }

  function sameDeal(entry, res) {
    if (!entry || !res) return false;
    const rid = String(res.deal_id || res.dealId || '').trim();
    const want = String(entry.dealId || '').trim();
    if (rid) return rid === want;
    // No deal id on the payload: only accept a negative profit (real LOSS).
    // Never accept a WIN without matching this ticket — that was a previous fill.
    const profit = res.profit != null ? Number(res.profit) : NaN;
    return Number.isFinite(profit) && profit < 0;
  }

  function decideFromEntry(entry) {
    if (!entry) return { allow: false, reason: 'no-tracked-deal', entry: null };
    if (entry.chainFreeze) {
      return {
        allow: false,
        reason: entry.outcome === 'draw' ? 'account_draw_1x' : (entry.outcome === 'win' ? 'account_win' : 'chain_frozen'),
        entry
      };
    }
    if (shouldFreezeMartingale(entry.outcome, entry.attempt) && !entry.pending) {
      return {
        allow: false,
        reason: entry.outcome === 'draw' ? 'account_draw_1x' : (entry.outcome === 'win' ? 'account_win' : 'account_unknown'),
        entry
      };
    }
    if (!entry.pending && entry.outcome === 'loss') {
      return { allow: true, reason: 'account_loss', entry };
    }
    if (!entry.pending && entry.outcome === 'draw') {
      return { allow: true, reason: 'account_draw_continue', entry };
    }
    if (!entry.pending) {
      return { allow: false, reason: 'account_unknown', entry };
    }
    return null; // still pending — caller must wait or fail-closed
  }

  /**
   * True while SSID still owns this chain: ticket open, confirmed LOSS
   * waiting for S1–S4, or WIN freeze that has not cooled off.
   * Pair-switch bot attempt 1 must NOT start a new 1x in these states.
   */
  function isAccountChainOpen(botId) {
    dropBlockingLeftover(botId);
    const entry = byBot.get(botId) || null;
    if (!entry) return false;
    if (entry.pending) return true;
    if (String(entry.outcome || '').toLowerCase() === 'loss') return true;
    if (entry.chainFreeze && !freezeHoldExpired(entry)) return true;
    return false;
  }

  /** Attempt 1 may start a new chain unless the previous PO ticket is still live. */
  function canPlaceAttempt(botId, attempt) {
    const n = Math.max(1, Number(attempt) || 1);
    dropBlockingLeftover(botId);
    const entry = byBot.get(botId) || null;
    if (n <= 1) {
      if (entry && entry.pending && dealStillOpen(entry)) {
        return { allow: false, reason: 'previous_still_open', entry };
      }
      if (entry && entry.pending) {
        dropBlockingLeftover(botId);
        const live = byBot.get(botId);
        if (live && live.pending && dealStillOpen(live)) {
          return { allow: false, reason: 'previous_still_open', entry: live };
        }
        // Past expiry: a new 1x must fire now. Don't wait on check_win.
        persistClear(botId);
        clear(botId);
        return { allow: true, reason: 'expired_new_1x', entry: null };
      }
      if (entry && String(entry.outcome || '').toLowerCase() === 'loss') {
        return { allow: false, reason: 'account_loss_mg', entry };
      }
      // Account WIN freeze must not delay the next real 1x.
      if (entry && (entry.chainFreeze || entry.outcome)) {
        persistClear(botId);
        clear(botId);
        return { allow: true, reason: 'new_chain', entry: null };
      }
      return { allow: true, reason: entry ? 'new_chain' : 'no-tracked-deal', entry };
    }
    const decided = decideFromEntry(entry);
    if (decided) return decided;
    return { allow: false, reason: 'previous_still_open', entry };
  }

  function applyResult(botId, entry, res) {
    if (!entry || !res) return entry;
    const live = byBot.get(botId);
    if (!live || live.generation !== entry.generation || live.dealId !== entry.dealId) {
      return live || entry;
    }
    if (!sameDeal(entry, res)) return entry;
    if (!entry.pending && entry.outcome) return entry;

    entry.polls = (entry.polls || 0) + 1;

    const outcome = outcomeFromResult(res);
    if (!outcome) {
      if (res.source === 'opened_deals') entry.openSeen = true;
      entry.pending = true;
      byBot.set(botId, entry);
      return entry;
    }

    entry.pending = false;
    entry.outcome = outcome;
    entry.profit = res.profit != null ? Number(res.profit) : null;
    entry.source = res.source || null;
    entry.resolvedAt = Date.now();
    entry.chainFreeze = shouldFreezeMartingale(outcome, entry.attempt);
    byBot.set(botId, entry);
    clearTimer(botId);

    const freezeNote = entry.chainFreeze
      ? ' FREEZE_MG'
      : (outcome === 'draw' ? ' draw_midchain_continue' : '');
    log(
      'info',
      `[PO-Deal] ${botId} deal=${entry.dealId} outcome=${outcome}` +
        (entry.profit != null ? ` profit=${entry.profit}` : '') +
        ` attempt=${entry.attempt} via=${entry.source || '?'}${freezeNote}`
    );

    persistNow(entry);

    onResult({
      botId,
      dealId: entry.dealId,
      outcome,
      profit: entry.profit,
      attempt: entry.attempt,
      currency: entry.currency,
      side: entry.side,
      amount: entry.amount,
      chainFreeze: entry.chainFreeze,
      source: entry.source,
      placedAt: entry.placedAt,
      settleAt: entry.settleAt,
      durationSec: entry.durationSec,
      openedAtMs: entry.openedAtMs
    });
    return entry;
  }

  function nextPollDelay(entry) {
    const msToSettle = entry.settleAt - Date.now();
    if (msToSettle > 1500) return Math.min(msToSettle - 400, 8000);
    // After expiry the watch thread owns check_win — don't hammer stdin.
    if (msToSettle > -4000) return 80;
    return 800;
  }

  async function pollOnce(botId) {
    const entry = byBot.get(botId);
    if (!entry || !entry.pending) return entry;

    const settleAt = Number(entry.settleAt) || 0;
    const pastSettle = Date.now() >= settleAt - 200;
    const ripe = Date.now() >= settleAt + 200;
    const res = await queryDeal(entry, {
      fast: true,
      timeoutMs: pastSettle ? 800 : 1200,
      allowBlock: false,
      ignoreOpen: ripe
    });
    applyResult(botId, entry, res);

    const latest = byBot.get(botId);
    if (!latest || latest.generation !== entry.generation) return latest;
    if (!latest.pending) return latest;

    const waitStart = Number(latest.generation) || Number(latest.placedAt) || Date.now();
    const age = Date.now() - waitStart;
    const latestSettle = Number(latest.settleAt) || 0;
    const pastHintGrace = latestSettle > 0 && Date.now() >= latestSettle + HINT_AFTER_SETTLE_MS;
    // Only the FIRST candle for THIS ticket may freeze. A later S1 WIN must not.
    if (
      pastHintGrace &&
      latest.hintLocked &&
      normalizeOutcome(latest.hintOutcome) === 'win' &&
      !dealStillOpen(latest)
    ) {
      log(
        'info',
        `[PO-Deal] ${botId} PO silent after expiry — candle WIN freezes SSID MG`
      );
      return applyHint(botId, 'win', 'expiry_hint');
    }
    const maxWait = (Number(latest.durationSec) || 60) * 1000 + 90000;
    if (age > maxWait) {
      log('info', `[PO-Deal] ${botId} drop stale pending deal=${latest.dealId}`);
      persistClear(botId);
      clear(botId);
      try {
        onResult({
          botId,
          outcome: 'idle',
          source: 'give-up',
          chainFreeze: false
        });
      } catch (e) {}
      return null;
    }

    schedulePoll(botId, nextPollDelay(latest));
    return latest;
  }

  function rememberHint(entry, hintOutcome) {
    const outcome = normalizeOutcome(hintOutcome);
    if (!entry || !outcome) return entry;
    if (entry.hintLocked && entry.hintOutcome && entry.hintOutcome !== outcome) {
      log(
        'info',
        `[PO-Deal] ${entry.botId} ignore later candle ${outcome} (ticket hint already ${entry.hintOutcome})`
      );
      return entry;
    }
    if (!entry.hintLocked) {
      entry.hintOutcome = outcome;
      entry.hintLocked = true;
      entry.hintAt = Date.now();
    }
    return entry;
  }

  function applyHint(botId, hintOutcome, source) {
    const entry = byBot.get(botId);
    if (!entry || !entry.pending) return entry;
    rememberHint(entry, hintOutcome);
    byBot.set(botId, entry);
    const outcome = normalizeOutcome(entry.hintOutcome);
    if (!outcome) return entry;
    // Late SSID fill: bot candle can close while OUR ticket is still live.
    // Never steal that window (that placed a worthless 2x after an account WIN).
    if (dealStillOpen(entry)) {
      log(
        'info',
        `[PO-Deal] ${botId} candle hint=${outcome} stored only — PO deal still open`
      );
      return entry;
    }
    // Candle LOSS is not the account (tiny OTC moves often pay the other way).
    // Candle WIN after expiry freezes SSID so we do not stack a save.
    if (outcome === 'loss') {
      log(
        'info',
        `[PO-Deal] ${botId} candle LOSS ignored — waiting for PO SSID`
      );
      return entry;
    }
    log(
      'info',
      `[PO-Deal] ${botId} PO silent after expiry — candle WIN freezes SSID MG`
    );
    return applyResult(botId, entry, {
      success: true,
      pending: false,
      deal_id: entry.dealId,
      outcome,
      source: source || 'expiry_hint'
    });
  }

  /** Call the instant the bot trade ends (Trading Result) or PO expiry hits. */
  async function settleNow(botId, { hintOutcome } = {}) {
    const entry = byBot.get(botId);
    if (!entry || !entry.pending) return entry;
    if (hintOutcome) rememberHint(entry, hintOutcome);

    const settleAt = Number(entry.settleAt) || 0;
    const stillOpen = dealStillOpen(entry);
    const pastSettle = Date.now() >= settleAt - 300;
    const res = await queryDeal(entry, {
      fast: !pastSettle,
      timeoutMs: 900,
      allowBlock: false,
      ignoreOpen: Date.now() >= settleAt
    });
    applyResult(botId, entry, res);
    const latest = byBot.get(botId);
    // Late SSID fill: bot candle closed, but OUR PO ticket is still live.
    // Never steal that ticket with the bot WIN/LOSS (different time window).
    if (latest && latest.pending && stillOpen) {
      const left = Math.max(0, settleAt - Date.now());
      log(
        'info',
        `[PO-Deal] ${botId} bot result=${latest.hintOutcome || '?'} ` +
          `but PO deal still open ${left}ms — waiting for PO`
      );
      schedulePoll(botId, Math.min(800, Math.max(80, left)));
      return latest;
    }
    if (latest && latest.pending && latest.hintOutcome && !dealStillOpen(latest)) {
      return applyHint(botId, latest.hintOutcome, 'expiry_hint');
    }
    if (latest && latest.pending && latest.generation === entry.generation) {
      schedulePoll(botId, 80);
    }
    return latest;
  }

  /**
   * Before placing S1–S4:
   *  - confirmed account WIN / DRAW@1x → skip (user won that ticket)
   *  - ticket still inside its own expiry → skip (don't double-bet)
   *  - LOSS, or history not in yet → PLACE NOW
   */
  async function gateMartingale(botId, { timeoutMs = 500 } = {}) {
    const started = Date.now();
    const budget = Math.max(150, Math.min(2500, Number(timeoutMs) || 500));

    let entry = byBot.get(botId);
    if (!entry) return { allow: false, reason: 'no-tracked-deal', entry: null };

    let decided = decideFromEntry(entry);
    if (decided) return decided;

    const settleAt = Number(entry.settleAt) || 0;
    const untilOpen = settleAt - 80 - Date.now();
    if (untilOpen > 0) {
      const waitMs = Math.min(untilOpen + 50, budget);
      if (waitMs > 0) {
        log('info', `[PO-Deal] ${botId} MG gate waiting ${waitMs}ms for deal ${entry.dealId} to settle`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      entry = byBot.get(botId) || entry;
      if (dealStillOpen(entry)) {
        log('warn', `[PO-Deal] ${botId} MG gate block: previous deal still open (${entry.dealId})`);
        return { allow: false, reason: 'previous_still_open', entry };
      }
    }

    decided = decideFromEntry(entry);
    if (decided) return decided;

    // One cheap closed-history peek. Do not loop — that stalls the next buy.
    try {
      const res = await queryDeal(entry, {
        fast: false,
        timeoutMs: Math.min(400, Math.max(120, budget - (Date.now() - started))),
        allowBlock: false,
        ignoreOpen: true
      });
      applyResult(botId, entry, res);
      entry = byBot.get(botId) || entry;
      decided = decideFromEntry(entry);
      if (decided) return decided;
      if (res && (res.pending || !res.success) && (res.source || res.error || res.hint)) {
        log(
          'info',
          `[PO-Deal] ${botId} history peek source=${res.source || '?'} ` +
            `hint=${res.hint || res.error || ''} — placing unless WIN`
        );
      }
    } catch (e) {
      log('warn', `[PO-Deal] ${botId} history peek error: ${e && e.message ? e.message : e}`);
      entry = byBot.get(botId) || entry;
    }

    decided = decideFromEntry(entry);
    if (decided) return decided;

    // Bot/account WIN already locked on this ticket → skip saves.
    if (
      entry?.pending &&
      entry.hintLocked &&
      normalizeOutcome(entry.hintOutcome) === 'win' &&
      !dealStillOpen(entry)
    ) {
      applyHint(botId, 'win', 'expiry_hint');
      entry = byBot.get(botId) || entry;
      decided = decideFromEntry(entry);
      if (decided) return decided;
    }

    log(
      'info',
      `[PO-Deal] ${botId} MG gate allow after ${Date.now() - started}ms (no account WIN in history)`
    );
    return { allow: true, reason: 'history_no_win', entry };
  }

  function applyWorkerResult(req, res) {
    const dealId = String(req?.deal_id || req?.dealId || res?.deal_id || res?.dealId || '').trim();
    if (!dealId || !res) return null;
    if (res.pending && !outcomeFromResult(res)) return null;
    for (const [botId, entry] of byBot.entries()) {
      if (String(entry.dealId) === dealId) {
        log('info', `[PO-Deal] ${botId} late worker result for deal=${dealId} outcome=${res.outcome || '?'}`);
        return applyResult(botId, entry, res);
      }
    }
    return null;
  }

  /** New chain / attempt 1 — drop prior deal so old WIN cannot block a new MG. */
  function markChainIdle(botId) {
    persistClear(botId);
    clear(botId);
  }

  return {
    trackPlaced,
    gateMartingale,
    canPlaceAttempt,
    isAccountChainOpen,
    get,
    clear,
    markChainIdle,
    isLeftoverPending,
    dropBlockingLeftover,
    shouldFreezeMartingale,
    pollOnce,
    settleNow,
    applyWorkerResult
  };
}

module.exports = {
  createPoDealMonitor,
  normalizeOutcome,
  outcomeFromResult,
  shouldFreezeMartingale,
  normalizeSettleAt,
  dealStillOpen,
  freezeHoldExpired,
  LEFTOVER_PAST_SETTLE_MS,
  HINT_AFTER_SETTLE_MS,
  WIN_FREEZE_HOLD_AFTER_SETTLE_MS
};
