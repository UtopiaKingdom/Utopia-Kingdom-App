/**
 * After app restart, re-attach a live Pocket Option ticket to LUMIX/MIRAX.
 */
'use strict';

const { normalizeSettleAt } = require('./po-deal-monitor');

function normAsset(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normSide(side) {
  const s = String(side || '').trim().toUpperCase();
  if (s === 'BUY' || s === 'CALL' || s === 'C' || s === '0') return 'BUY';
  if (s === 'SELL' || s === 'PUT' || s === 'P' || s === '1') return 'SELL';
  return '';
}

function pickOpenedDeal(deals, hint = {}, claimed = new Set()) {
  const open = (Array.isArray(deals) ? deals : []).filter((d) => {
    const id = String(d?.id || d?.dealId || '').trim();
    return id && !claimed.has(id);
  });
  if (!open.length) return null;

  const wantCur = normAsset(hint.currency);
  const wantSide = normSide(hint.side);
  if (!wantCur && !wantSide) return null;

  let best = null;
  let bestScore = -1;
  for (const d of open) {
    const a = normAsset(d.asset || d.currency);
    if (wantCur && !(a && (a.includes(wantCur) || wantCur.includes(a)))) continue;
    let score = 0;
    if (wantCur) score += 5;
    if (wantSide && normSide(d.side || d.direction) === wantSide) score += 3;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return bestScore > 0 ? best : null;
}

function endTimeMs(deal) {
  const t = Number(deal?.end_time || deal?.endTime || deal?.expiry || deal?.settleAt || 0);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t > 1e12 ? t : t * 1000;
}

function createPoDealResume(deps = {}) {
  const monitor = deps.monitor;
  const store = deps.store;
  const getSsid = deps.getSsid;
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  const inflight = new Map();

  async function resume(botId, _hint = {}) {
    if (!botId || !monitor) return null;
    if (inflight.get(botId)) return inflight.get(botId);
    const work = (async () => {
      const live = monitor.get(botId);
      if (live?.dealId && live.pending) return live;

      const { ssid } = (typeof getSsid === 'function' ? getSsid(botId) : {}) || {};
      const snap = store?.load?.(botId) || null;

      if (snap?.dealId && ssid) {
        const placedAt = Number(snap.placedAt) || Number(snap.savedAt) || 0;
        const cap = botId === 'bot2' ? 60 : (botId === 'bot3' ? 600 : 210);
        let durationSec = Number(snap.durationSec) || (botId === 'bot2' ? 30 : botId === 'bot3' ? 60 : 180);
        if (durationSec > cap) durationSec = botId === 'bot2' ? 30 : (botId === 'bot3' ? 60 : 180);
        const settleAt = normalizeSettleAt(placedAt || Date.now(), durationSec, snap.settleAt);
        const outcome = String(snap.outcome || '').toLowerCase();
        const settled = outcome === 'win' || outcome === 'loss' || outcome === 'draw';
        // Trust duration from the signal — PO end-time is often hours off.
        const stillOpen = !settled && placedAt && Date.now() < settleAt + 40000;
        const justExpired = !settled && placedAt && Date.now() < settleAt + 90000;
        const ours = snap.placedByUs === true;
        if (!ours) {
          log('info', `[PO-Deal] ${botId} drop unowned persisted deal=${snap.dealId}`);
          store.clear?.(botId);
        } else if (stillOpen || (settled && Date.now() - Number(snap.savedAt || placedAt || 0) < 3 * 60 * 1000)) {
          const liveNow = monitor.get(botId);
          if (liveNow?.pending && liveNow.placedByUs === true && String(liveNow.dealId) !== String(snap.dealId)) {
            log('info', `[PO-Deal] ${botId} keep live deal=${liveNow.dealId} (ignore persist ${snap.dealId})`);
            return liveNow;
          }
          log('info', `[PO-Deal] ${botId} resume persisted deal=${snap.dealId}`);
          return monitor.trackPlaced(botId, { ...snap, ssid, settleAt, placedAt, durationSec });
        } else if (justExpired) {
          log('info', `[PO-Deal] ${botId} resume just-expired deal=${snap.dealId} — settling now`);
          const entry = monitor.trackPlaced(botId, { ...snap, ssid, settleAt, placedAt, durationSec });
          if (typeof monitor.settleNow === 'function') {
            monitor.settleNow(botId).catch(() => {});
          }
          return entry;
        } else {
          log('info', `[PO-Deal] ${botId} drop stale persisted deal=${snap.dealId}`);
          store.clear?.(botId);
        }
      }

      // Never grab a leftover PO ticket. Restart mid-trade uses persist (placedByUs).
      return live || null;
    })();

    inflight.set(botId, work);
    try {
      return await work;
    } finally {
      inflight.delete(botId);
    }
  }

  function payloadFromEntry(botId, entry) {
    if (!entry) return null;
    return {
      botId,
      dealId: entry.dealId,
      outcome: entry.pending ? 'watching' : (entry.outcome || 'unknown'),
      pending: !!entry.pending,
      profit: entry.profit,
      attempt: entry.attempt,
      amount: entry.amount,
      currency: entry.currency,
      side: entry.side,
      chainFreeze: !!entry.chainFreeze,
      source: entry.pending ? 'tracking' : (entry.source || 'resume'),
      settleAt: entry.settleAt,
      durationSec: entry.durationSec
    };
  }

  function currentState() {
    const out = {};
    for (const id of ['bot1', 'bot2', 'bot3']) {
      const live = monitor.get(id);
      if (live) {
        if (typeof monitor.isLeftoverPending === 'function' && monitor.isLeftoverPending(live, id)) {
          monitor.dropBlockingLeftover?.(id);
        } else {
          out[id] = payloadFromEntry(id, live);
          continue;
        }
      }
      const snap = store?.load?.(id);
      if (!snap || snap.placedByUs !== true) continue;
      const remain = (Number(snap.settleAt) || 0) - Date.now();
      const capMs = (id === 'bot2' ? 90 : 210) * 1000;
      if (remain > capMs || remain < -120000) continue;
      out[id] = payloadFromEntry(id, snap);
    }
    return out;
  }

  return { resume, pickOpenedDeal, currentState, payloadFromEntry };
}

module.exports = { createPoDealResume, pickOpenedDeal, normAsset, normSide };
