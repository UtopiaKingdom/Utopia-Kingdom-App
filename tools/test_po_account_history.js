#!/usr/bin/env node
/**
 * PO history: tape stays primary; PO index filters/enriches when autotrade on.
 * Run: node tools/test_po_account_history.js
 */
'use strict';

const assert = require('assert');

function pairKey(raw) {
  return String(raw || '').toUpperCase().replace(/\bOTC\b/g, '').replace(/[^A-Z0-9]/g, '');
}

function toEpochMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function matchesTape(tape, po) {
  if (pairKey(tape.symbol) !== pairKey(po.currency)) return false;
  const tOpen = toEpochMs(tape.openedAtMs || tape.openingTime);
  const pOpen = Number(po.placedAt) || 0;
  return Math.abs(tOpen - pOpen) <= 90000;
}

function historyForDisplay(deals, tape) {
  if (!deals.length) return tape;
  const used = Object.create(null);
  const out = [];
  tape.forEach(function (t) {
    const po = deals.find(function (p) {
      return !used[p.dealId] && matchesTape(t, p);
    });
    if (po) {
      used[po.dealId] = true;
      out.push(Object.assign({}, t, { result: po.result, poAccount: true }));
    }
  });
  if (!out.length) return tape;
  return out;
}

const open = 1700000000000;
const tape = [
  { id: 't1', symbol: 'GBP/JPY OTC', result: 'LOSS', attempt: 1, openingPrice: 223.1, closingPrice: 223.2, openedAtMs: open },
  { id: 't2', symbol: 'UAH/USD OTC', result: 'WIN', attempt: 1, openingPrice: 0.024, closingPrice: 0.025, openedAtMs: open + 60000 }
];

const poDeals = [
  { dealId: 'd1', currency: 'GBP/JPY OTC', result: 'LOSS', attempt: 1, placedAt: open }
];

const filtered = historyForDisplay(poDeals, tape);
assert.strictEqual(filtered.length, 1);
assert.strictEqual(filtered[0].symbol, 'GBP/JPY OTC');
assert.strictEqual(filtered[0].openingPrice, 223.1);
assert.strictEqual(filtered[0].poAccount, true);

assert.strictEqual(historyForDisplay([], tape).length, 2);

console.log('All po-account-history tests passed.');
