/**
 * Run: node tools/test_po_deal_resume.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickOpenedDeal, createPoDealResume } = require('../po-deal-resume');
const { createPoDealWatchStore } = require('../po-deal-watch-store');
const { createPoDealMonitor } = require('../po-deal-monitor');

const one = pickOpenedDeal(
  [{ id: 'a', asset: 'EURUSD_otc', side: 'buy' }],
  { currency: 'EUR/USD OTC' },
  new Set()
);
assert.strictEqual(one.id, 'a');

const claimed = pickOpenedDeal(
  [{ id: 'a', asset: 'EURUSD_otc' }],
  {},
  new Set(['a'])
);
assert.strictEqual(claimed, null);

const leftover = pickOpenedDeal(
  [{ id: 'leftover', asset: 'USDCOP_otc', side: 'sell' }],
  { currency: 'EUR/JPY OTC', side: 'SELL' },
  new Set()
);
assert.strictEqual(leftover, null);

const noHint = pickOpenedDeal(
  [{ id: 'random', asset: 'USDCOP_otc' }],
  {},
  new Set()
);
assert.strictEqual(noHint, null);

const best = pickOpenedDeal(
  [
    { id: 'x', asset: 'GBPUSD_otc', side: 'sell' },
    { id: 'y', asset: 'USDJPY_otc', side: 'buy' }
  ],
  { currency: 'USD/JPY OTC', side: 'BUY' },
  new Set()
);
assert.strictEqual(best.id, 'y');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po-watch-'));
const store = createPoDealWatchStore({ dir: () => dir });
assert.ok(store.save({
  botId: 'bot1',
  dealId: 'deal-1',
  currency: 'EUR/USD OTC',
  attempt: 1,
  durationSec: 60,
  placedAt: Date.now(),
  settleAt: Date.now() + 60000,
  pending: true
}));
const loaded = store.load('bot1');
assert.strictEqual(loaded.dealId, 'deal-1');
assert.strictEqual(loaded.pending, true);
store.clear('bot1');
assert.strictEqual(store.load('bot1'), null);

(async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'po-watch-stale-'));
  const store2 = createPoDealWatchStore({ dir: () => dir2 });
  const monitor = createPoDealMonitor({
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal') return { success: true, watching: true };
      return { success: true, deals: [] };
    },
    log: () => {},
    onResult: () => {}
  });
  store2.save({
    botId: 'bot1',
    dealId: '0930bb22-dead',
    durationSec: 180,
    placedAt: Date.now() - 36 * 60 * 1000,
    settleAt: Date.now() + 86 * 60 * 1000,
    pending: true,
    attempt: 1
  });
  const resume = createPoDealResume({
    monitor,
    store: store2,
    requestWorker: async () => ({ success: true, deals: [] }),
    getSsid: () => ({ ssid: 'fake' }),
    log: () => {}
  });
  await resume.resume('bot1');
  assert.strictEqual(monitor.get('bot1'), null, 'must not restore a dead 86-minute ticket');
  assert.strictEqual(store2.load('bot1'), null);

  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'po-watch-adopt-'));
  const store3 = createPoDealWatchStore({ dir: () => dir3 });
  const monitor3 = createPoDealMonitor({
    requestWorker: async () => ({ success: true, watching: true }),
    log: () => {},
    onResult: () => {}
  });
  const leftoverEnd = Math.floor(Date.now() / 1000) + 6119;
  const resume3 = createPoDealResume({
    monitor: monitor3,
    store: store3,
    requestWorker: async () => ({
      success: true,
      deals: [{ id: '336f35f2-leftover', asset: 'USDCOP_otc', side: 'sell', end_time: leftoverEnd }]
    }),
    getSsid: () => ({ ssid: 'fake' }),
    log: () => {}
  });
  await resume3.resume('bot2', { currency: 'USD/COP OTC', side: 'SELL', attempt: 1 });
  assert.strictEqual(monitor3.get('bot2'), null, 'must not adopt a leftover PO ticket');

  const now = Date.now();
  store3.save({
    botId: 'bot2',
    dealId: 'ours-1',
    currency: 'USD/COP OTC',
    attempt: 1,
    durationSec: 60,
    placedAt: now,
    settleAt: now + 60000,
    pending: true,
    placedByUs: true
  });
  await resume3.resume('bot2');
  assert.ok(monitor3.get('bot2'), 'must resume a ticket we placed');
  assert.strictEqual(monitor3.get('bot2').dealId, 'ours-1');
  assert.strictEqual(monitor3.get('bot2').placedByUs, true);
  monitor3.clear('bot2');
  monitor.clear('bot1');

  console.log('test_po_deal_resume: OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
