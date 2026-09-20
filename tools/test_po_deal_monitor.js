/**
 * Quick unit checks for po-deal-monitor helpers.
 * Run: node tools/test_po_deal_monitor.js
 */
const assert = require('assert');
const {
  createPoDealMonitor,
  normalizeOutcome,
  outcomeFromResult,
  shouldFreezeMartingale,
  normalizeSettleAt
} = require('../po-deal-monitor');

assert.strictEqual(normalizeOutcome('WIN'), 'win');
assert.strictEqual(normalizeOutcome('loss'), 'loss');
assert.strictEqual(normalizeOutcome('draw'), 'draw');
assert.strictEqual(normalizeOutcome('nope'), null);

assert.strictEqual(shouldFreezeMartingale('win', 1), true);
assert.strictEqual(shouldFreezeMartingale('win', 4), true);
assert.strictEqual(shouldFreezeMartingale('draw', 1), true);
assert.strictEqual(shouldFreezeMartingale('draw', 2), false);
assert.strictEqual(shouldFreezeMartingale('draw', 5), false);
assert.strictEqual(shouldFreezeMartingale('loss', 1), false);
assert.strictEqual(shouldFreezeMartingale('loss', 3), false);
assert.strictEqual(shouldFreezeMartingale('nope', 1), true);
assert.strictEqual(shouldFreezeMartingale('', 1), true);

assert.strictEqual(normalizeOutcome('success'), null);
assert.strictEqual(normalizeOutcome('loose'), 'loss');

assert.strictEqual(outcomeFromResult({ outcome: 'loss', profit: 5 }), 'win');
assert.strictEqual(outcomeFromResult({ outcome: 'win', profit: -2 }), 'loss');
assert.strictEqual(outcomeFromResult({ outcome: 'win', profit: 0 }), 'draw');
assert.strictEqual(outcomeFromResult({ outcome: 'win' }), null);
assert.strictEqual(outcomeFromResult({ outcome: 'success', profit: 1.5 }), 'win');
assert.strictEqual(outcomeFromResult({ outcome: 'success' }), null);
assert.strictEqual(outcomeFromResult({ outcome: 'loss' }), 'loss');
assert.strictEqual(outcomeFromResult({ outcome: 'win', source: 'trading_result' }), null);
assert.strictEqual(outcomeFromResult({ outcome: 'loss', source: 'trading_result' }), null);
assert.strictEqual(outcomeFromResult({ outcome: 'loss', source: 'expiry_hint' }), null);
assert.strictEqual(outcomeFromResult({ outcome: 'win', source: 'expiry_hint' }), 'win');
assert.strictEqual(outcomeFromResult({ outcome: 'win', source: 'ssid_closed', profit: 4.6 }), 'win');
assert.strictEqual(outcomeFromResult({ outcome: 'loss', source: 'ssid_closed', profit: -5 }), 'loss');
assert.strictEqual(outcomeFromResult({ outcome: 'win', source: 'ssid_closed' }), 'win');
assert.strictEqual(outcomeFromResult({ outcome: 'loss', source: 'updateClosedDeals' }), 'loss');

{
  const placed = 1_786_630_194_233;
  const dur = 180;
  const fromDur = placed + dur * 1000;
  assert.strictEqual(normalizeSettleAt(placed, dur, null), fromDur);
  assert.strictEqual(normalizeSettleAt(placed, dur, fromDur + 2000), fromDur + 2000);
  // PO +2h timezone junk (the 86:06 bug)
  assert.strictEqual(normalizeSettleAt(placed, dur, 1_786_637_574_000), fromDur);
}

function settled(results) {
  return results.filter((p) => p && p.outcome !== 'watching' && p.source !== 'tracking');
}

(async () => {
  // WIN freezes
  {
    const results = [];
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({ success: true, pending: false, outcome: 'win', profit: 1.84, deal_id: 'd1', source: 'test' }),
      log: () => {},
      onResult: (p) => results.push(p)
    });
    monitor.trackPlaced('bot1', {
      dealId: 'd1', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 2000
    });
    await monitor.pollOnce('bot1');
    assert.strictEqual(settled(results)[0].chainFreeze, true);
    const gate = await monitor.gateMartingale('bot1', { timeoutMs: 300 });
    assert.strictEqual(gate.allow, false);
  }

  // DRAW on 1x freezes
  {
    const results = [];
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({ success: true, pending: false, outcome: 'draw', profit: 0, deal_id: 'd2', source: 'test' }),
      log: () => {},
      onResult: (p) => results.push(p)
    });
    monitor.trackPlaced('bot1', {
      dealId: 'd2', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 2000
    });
    await monitor.pollOnce('bot1');
    assert.strictEqual(settled(results)[0].chainFreeze, true);
    const gate = await monitor.gateMartingale('bot1', { timeoutMs: 300 });
    assert.strictEqual(gate.allow, false);
    assert.strictEqual(gate.reason, 'account_draw_1x');
  }

  // DRAW on 2x+ continues
  {
    const results = [];
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({ success: true, pending: false, outcome: 'draw', profit: 0, deal_id: 'd3', source: 'test' }),
      log: () => {},
      onResult: (p) => results.push(p)
    });
    monitor.trackPlaced('bot1', {
      dealId: 'd3', ssid: 'fake', attempt: 2, durationSec: 1, placedAt: Date.now() - 2000
    });
    await monitor.pollOnce('bot1');
    assert.strictEqual(settled(results)[0].chainFreeze, false);
    const gate = await monitor.gateMartingale('bot1', { timeoutMs: 300 });
    assert.strictEqual(gate.allow, true);
    assert.strictEqual(gate.reason, 'account_draw_continue');
  }

  // Newer deal replaces old — gate must not use stale deal
  {
    let calls = 0;
    const monitor = createPoDealMonitor({
      requestWorker: async (req) => {
        calls += 1;
        const id = String(req.deal_id || '');
        if (id === 'old') return { success: true, pending: false, outcome: 'win', deal_id: 'old', source: 'test' };
        return { success: true, pending: false, outcome: 'loss', profit: -4, deal_id: 'new', source: 'test' };
      },
      log: () => {},
      onResult: () => {}
    });
    monitor.trackPlaced('bot1', {
      dealId: 'old', ssid: 'fake', attempt: 1, durationSec: 60, placedAt: Date.now()
    });
    monitor.trackPlaced('bot1', {
      dealId: 'new', ssid: 'fake', attempt: 2, durationSec: 1, placedAt: Date.now() - 2000
    });
    await monitor.pollOnce('bot1');
    assert.strictEqual(monitor.get('bot1').dealId, 'new');
    assert.strictEqual(monitor.get('bot1').outcome, 'loss');
    const gate = await monitor.gateMartingale('bot1', { timeoutMs: 300 });
    assert.strictEqual(gate.allow, true);
    assert.ok(calls >= 1);
  }

  // Attempt 1 blocked while previous PO deal is still open
  {
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({ success: true, pending: true, deal_id: 'live', source: 'opened_deals' }),
      log: () => {},
      onResult: () => {}
    });
    monitor.trackPlaced('bot1', {
      dealId: 'live', ssid: 'fake', attempt: 1, durationSec: 180, placedAt: Date.now(), placedByUs: true
    });
    const gate = monitor.canPlaceAttempt('bot1', 1);
    assert.strictEqual(gate.allow, false);
    assert.strictEqual(gate.reason, 'previous_still_open');
    monitor.clear('bot1');
  }

  // Profit > 0 beats a "loss" label
  {
    const results = [];
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({
        success: true, pending: false, outcome: 'loss', profit: 18.4, deal_id: 'px', source: 'test'
      }),
      log: () => {},
      onResult: (p) => results.push(p)
    });
    monitor.trackPlaced('bot1', {
      dealId: 'px', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 2000
    });
    await monitor.pollOnce('bot1');
    assert.strictEqual(settled(results)[0].outcome, 'win');
    assert.strictEqual(settled(results)[0].chainFreeze, true);
    const gate = await monitor.gateMartingale('bot1', { timeoutMs: 300 });
    assert.strictEqual(gate.allow, false);
  }

  // WIN payload with no matching deal id must not be applied (stale previous fill).
  {
    const results = [];
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({
        success: true, pending: false, outcome: 'win', profit: 9, source: 'stale'
      }),
      log: () => {},
      onResult: (p) => results.push(p)
    });
    monitor.trackPlaced('bot1', {
      dealId: 'd-real', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 2000
    });
    await monitor.pollOnce('bot1');
    assert.strictEqual(settled(results).length, 0);
    assert.strictEqual(monitor.get('bot1').pending, true);
    assert.notStrictEqual(monitor.get('bot1').outcome, 'win');
    monitor.clear('bot1');
  }

  // settleNow must NOT treat bot candle LOSS as the account while the ticket is still open
  {
    const results = [];
    const monitor = createPoDealMonitor({
      requestWorker: async (req) => {
        if (req.cmd === 'watch_deal') return { success: true, watching: true };
        return { success: true, pending: true, deal_id: req.deal_id, source: 'opened_deals' };
      },
      log: () => {},
      onResult: (p) => results.push(p)
    });
    monitor.trackPlaced('bot1', {
      dealId: 'fast', ssid: 'fake', attempt: 1, durationSec: 60, placedAt: Date.now()
    });
    const t0 = Date.now();
    await monitor.settleNow('bot1', { hintOutcome: 'loss' });
    const elapsed = Date.now() - t0;
    assert.ok(monitor.get('bot1').pending, 'candle LOSS must keep watching PO while open');
    assert.notStrictEqual(monitor.get('bot1').outcome, 'loss');
    assert.ok(elapsed < 1500, `settleNow too slow: ${elapsed}ms`);
    assert.strictEqual(settled(results).length, 0);
    monitor.clear('bot1');
  }

  // After expiry, candle LOSS allows MG (PO check_win is often silent)
  {
    const monitor = createPoDealMonitor({
      requestWorker: async (req) => {
        if (req.cmd === 'watch_deal') return { success: true, watching: true };
        return { success: true, pending: true, deal_id: req.deal_id, source: 'pending' };
      },
      log: () => {},
      onResult: () => {}
    });
    monitor.trackPlaced('bot1', {
      dealId: 'expired-loss', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 2500
    });
    await monitor.settleNow('bot1', { hintOutcome: 'loss' });
    assert.ok(monitor.get('bot1').pending, 'candle LOSS must not confirm the account');
    const gate = await monitor.gateMartingale('bot1', { timeoutMs: 300 });
    assert.strictEqual(gate.allow, true);
    monitor.clear('bot1');
  }

  // Late SSID fill: bot candle closed but PO ticket is still open — do not steal it
  {
    const results = [];
    const monitor = createPoDealMonitor({
      requestWorker: async (req) => {
        if (req.cmd === 'watch_deal') return { success: true, watching: true };
        return { success: true, pending: true, deal_id: req.deal_id, source: 'opened_deals' };
      },
      log: () => {},
      onResult: (p) => results.push(p)
    });
    monitor.trackPlaced('bot2', {
      dealId: 'late-ngn',
      ssid: 'fake',
      attempt: 2,
      durationSec: 60,
      placedAt: Date.now(),
      placedByUs: true
    });
    await monitor.settleNow('bot2', { hintOutcome: 'win' });
    const live = monitor.get('bot2');
    assert.strictEqual(live.pending, true, 'must keep watching PO while deal is still open');
    assert.notStrictEqual(live.outcome, 'win');
    assert.ok(settled(results).length === 0, 'must not freeze MG on bot WIN while PO is open');
    monitor.clear('bot2');
  }

  // A later pending peek must not un-settle a confirmed result
  {
    const monitor = createPoDealMonitor({
      requestWorker: async (req) => {
        if (req.cmd === 'watch_deal') return { success: true, watching: true };
        return { success: true, pending: true, deal_id: req.deal_id, source: 'opened_deals' };
      },
      log: () => {},
      onResult: () => {}
    });
    monitor.trackPlaced('bot1', {
      dealId: 'stay', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 2000
    });
    await monitor.settleNow('bot1', { hintOutcome: 'win' });
    assert.strictEqual(monitor.get('bot1').outcome, 'win');
    assert.strictEqual(monitor.get('bot1').pending, false);
    monitor.applyWorkerResult(
      { deal_id: 'stay' },
      { success: true, pending: true, deal_id: 'stay', source: 'opened_deals' }
    );
    assert.strictEqual(monitor.get('bot1').outcome, 'win');
    assert.strictEqual(monitor.get('bot1').pending, false);
    monitor.clear('bot1');
  }

  // Never keep a 2-hour PO end-time as the live countdown
  {
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({ success: true, watching: true }),
      log: () => {},
      onResult: () => {}
    });
    const placedAt = Date.now();
    monitor.trackPlaced('bot2', {
      dealId: 'insane',
      ssid: 'fake',
      durationSec: 7200,
      placedAt,
      settleAt: placedAt + 7200 * 1000,
      placedByUs: false
    });
    const e = monitor.get('bot2');
    assert.ok(e.durationSec <= 45, `duration capped, got ${e.durationSec}`);
    assert.ok(e.settleAt - placedAt < 90000, 'settleAt must follow 30s expiry');
    assert.strictEqual(e.placedByUs, false);
    monitor.trackPlaced('bot2', {
      dealId: 'ours',
      ssid: 'fake',
      durationSec: 60,
      placedAt,
      placedByUs: true
    });
    assert.strictEqual(monitor.get('bot2').placedByUs, true);
    monitor.clear('bot2');
  }

  // Leftover unowned ticket must not block a new 1x, and must not overwrite ours
  {
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({ success: true, watching: true }),
      log: () => {},
      onResult: () => {}
    });
    const placedAt = Date.now();
    monitor.trackPlaced('bot1', {
      dealId: 'ours',
      ssid: 'fake',
      durationSec: 180,
      placedAt,
      placedByUs: true
    });
    monitor.trackPlaced('bot1', {
      dealId: 'leftover',
      ssid: 'fake',
      durationSec: 60,
      placedAt: placedAt - 400000,
      placedByUs: false
    });
    assert.strictEqual(monitor.get('bot1').dealId, 'ours');
    monitor.clear('bot2');
    monitor.trackPlaced('bot2', {
      dealId: 'ghost',
      ssid: 'fake',
      durationSec: 7200,
      placedAt: Date.now() - 36 * 60 * 1000,
      settleAt: Date.now() + 86 * 60 * 1000,
      placedByUs: false
    });
    const gate = monitor.canPlaceAttempt('bot2', 1);
    assert.strictEqual(gate.allow, true, 'leftover must not block 1x');
    assert.strictEqual(monitor.get('bot2'), null);
    monitor.clear('bot1');
  }

  // After expiry leftover, next 1x must not wait duration+90s (candle hint is not a settle)
  {
    const results = [];
    const monitor = createPoDealMonitor({
      requestWorker: async (req) => {
        if (req.cmd === 'watch_deal') return { success: true, watching: true };
        return { success: true, pending: true, deal_id: req.deal_id, source: 'opened_deals' };
      },
      log: () => {},
      onResult: (p) => results.push(p)
    });
    monitor.trackPlaced('bot2', {
      dealId: 'post-expiry',
      ssid: 'fake',
      attempt: 4,
      durationSec: 60,
      placedAt: Date.now(),
      placedByUs: true
    });
    await monitor.settleNow('bot2', { hintOutcome: 'win' });
    assert.strictEqual(monitor.get('bot2').pending, true, 'still open at settleNow');
    const live = monitor.get('bot2');
    live.settleAt = Date.now() - 3000;
    await monitor.pollOnce('bot2');
    const held = monitor.canPlaceAttempt('bot2', 1);
    assert.strictEqual(held.allow, true, 'new 1x must place immediately after account WIN');
    monitor.clear('bot2');
  }

  // ~30s past expiry leftover must not block a new 1x (the 18:29 skip)
  {
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({ success: true, watching: true }),
      log: () => {},
      onResult: () => {}
    });
    monitor.trackPlaced('bot2', {
      dealId: 'stale-4x',
      ssid: 'fake',
      durationSec: 60,
      placedAt: Date.now() - 90000,
      placedByUs: true
    });
    const gate = monitor.canPlaceAttempt('bot2', 1);
    assert.strictEqual(gate.allow, true, '30s-past leftover must not block 1x');
    assert.strictEqual(monitor.get('bot2'), null);
  }

  // Account LOSS: next bot attempt-1 (pair switch) is S1, not a new 1x
  {
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({
        success: true, pending: false, outcome: 'loss', profit: -5, deal_id: 'lost-1x', source: 'check_win'
      }),
      log: () => {},
      onResult: () => {}
    });
    monitor.trackPlaced('bot2', {
      dealId: 'lost-1x', ssid: 'fake', attempt: 1, durationSec: 30, placedAt: Date.now() - 40000, placedByUs: true
    });
    await monitor.pollOnce('bot2');
    assert.strictEqual(monitor.get('bot2').outcome, 'loss');
    assert.strictEqual(monitor.isAccountChainOpen('bot2'), true);
    const gate = monitor.canPlaceAttempt('bot2', 1);
    assert.strictEqual(gate.allow, false);
    assert.strictEqual(gate.reason, 'account_loss_mg');
    const mg = await monitor.gateMartingale('bot2', { timeoutMs: 300 });
    assert.strictEqual(mg.allow, true);
    assert.strictEqual(mg.reason, 'account_loss');
    monitor.clear('bot2');
  }

  // Account WIN: skip S1–S4, but a new 1x must place instantly
  {
    const monitor = createPoDealMonitor({
      requestWorker: async () => ({
        success: true, pending: false, outcome: 'win', profit: 4.6, deal_id: 'won-1x', source: 'check_win'
      }),
      log: () => {},
      onResult: () => {}
    });
    monitor.trackPlaced('bot2', {
      dealId: 'won-1x', ssid: 'fake', attempt: 1, durationSec: 30, placedAt: Date.now() - 40000, placedByUs: true
    });
    await monitor.pollOnce('bot2');
    assert.strictEqual(monitor.get('bot2').chainFreeze, true);
    const mg = await monitor.gateMartingale('bot2', { timeoutMs: 300 });
    assert.strictEqual(mg.allow, false);
    assert.ok(mg.reason === 'account_win' || mg.reason === 'chain_frozen');
    const gate = monitor.canPlaceAttempt('bot2', 1);
    assert.strictEqual(gate.allow, true, 'next 1x must not wait on WIN freeze');
    monitor.clear('bot2');
  }

  console.log('test_po_deal_monitor: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
