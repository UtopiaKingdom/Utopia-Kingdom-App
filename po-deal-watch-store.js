/**
 * Persist last PO ticket per bot so a restart can pick up a live trade.
 * Never stores SSID.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function snapshotOf(entry) {
  if (!entry || !entry.botId || !entry.dealId) return null;
  return {
    botId: entry.botId,
    dealId: String(entry.dealId),
    currency: entry.currency || null,
    side: entry.side || null,
    amount: Number.isFinite(Number(entry.amount)) ? Number(entry.amount) : null,
    attempt: Number(entry.attempt) || 1,
    durationSec: Number(entry.durationSec) || null,
    placedAt: Number(entry.placedAt) || null,
    settleAt: Number(entry.settleAt) || null,
    pending: entry.pending !== false,
    outcome: entry.outcome || null,
    profit: entry.profit != null ? Number(entry.profit) : null,
    chainFreeze: !!entry.chainFreeze,
    placedByUs: !!entry.placedByUs,
    savedAt: Date.now()
  };
}

function createPoDealWatchStore({ dir, log } = {}) {
  const writeLog = typeof log === 'function' ? log : () => {};

  function fileFor(botId) {
    return path.join(dir(), `po_watch_${botId}.json`);
  }

  function historyFile(botId) {
    return path.join(dir(), `po_account_trades_${botId}.json`);
  }

  function appendHistory(snap) {
    if (!snap || !snap.dealId) return;
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(historyFile(snap.botId), 'utf8'));
      if (!Array.isArray(list)) list = [];
    } catch (e) {
      list = [];
    }
    const row = {
      dealId: String(snap.dealId || ''),
      currency: snap.currency,
      side: snap.side,
      amount: snap.amount,
      attempt: snap.attempt,
      pending: snap.pending,
      outcome: snap.outcome,
      profit: snap.profit,
      placedAt: snap.placedAt,
      settleAt: snap.settleAt
    };
    list = list.filter((x) => x && x.dealId !== row.dealId);
    list.push(row);
    if (list.length > 200) list = list.slice(-200);
    try {
      fs.writeFileSync(historyFile(snap.botId), JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {}
  }

  function loadHistory(botId) {
    if (!botId) return [];
    try {
      const list = JSON.parse(fs.readFileSync(historyFile(botId), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function save(entry) {
    const snap = snapshotOf(entry);
    if (!snap) return false;
    try {
      fs.writeFileSync(fileFor(snap.botId), JSON.stringify(snap), 'utf8');
      appendHistory(snap);
      return true;
    } catch (e) {
      writeLog('warn', `[PO-Watch] save failed: ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  function load(botId) {
    if (!botId) return null;
    try {
      const raw = fs.readFileSync(fileFor(botId), 'utf8');
      const snap = JSON.parse(raw);
      if (!snap || !snap.dealId) return null;
      return snap;
    } catch (e) {
      return null;
    }
  }

  function clear(botId) {
    if (!botId) return;
    try { fs.unlinkSync(fileFor(botId)); } catch (e) {}
  }

  return { save, load, clear, loadHistory, snapshotOf };
}

module.exports = { createPoDealWatchStore, snapshotOf };
