/**
 * Simulated autotrade MG gate timeline — no real PO money.
 * Run: node tools/test_po_deal_monitor_sim.js
 */
const assert = require('assert');
const { createPoDealMonitor } = require('../po-deal-monitor');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeScriptedWorker(script) {
  const queues = new Map();
  for (const [id, steps] of Object.entries(script)) {
    queues.set(id, steps.slice());
  }
  const calls = [];
  return {
    calls,
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal' || req.cmd === 'watch') {
        return { success: true, watching: true, deal_id: req.deal_id };
      }
      const id = String(req.deal_id || '');
      calls.push({ id, allow_block: !!req.allow_block, fast: !!req.fast, at: Date.now() });
      const q = queues.get(id) || [];
      if (!q.length) {
        return { success: true, pending: true, deal_id: id, source: 'pending' };
      }
      return q.shift();
    }
  };
}

async function scenarioAccountWinStopsMg() {
  const { requestWorker, calls } = makeScriptedWorker({
    'deal-win': [
      { success: true, pending: true, deal_id: 'deal-win', source: 'opened_deals' },
      { success: true, pending: false, deal_id: 'deal-win', outcome: 'win', profit: 1.84, source: 'get_closed_deal' }
    ]
  });
  const events = [];
  const mon = createPoDealMonitor({
    requestWorker,
    log: () => {},
    onResult: (p) => events.push(p)
  });

  mon.trackPlaced('bot1', {
    dealId: 'deal-win',
    ssid: 'fake',
    attempt: 1,
    durationSec: 1,
    placedAt: Date.now() - 1200
  });

  for (let i = 0; i < 6 && mon.get('bot1')?.pending; i++) {
    await mon.pollOnce('bot1');
    await sleep(20);
  }

  assert.strictEqual(mon.get('bot1').outcome, 'win');
  assert.strictEqual(mon.get('bot1').chainFreeze, true);
  assert.ok(events.some((e) => e.outcome === 'watching'));
  assert.ok(events.some((e) => e.chainFreeze === true));

  const gate = await mon.gateMartingale('bot1', { timeoutMs: 500 });
  assert.strictEqual(gate.allow, false);
  assert.ok(calls.length >= 2);
  console.log('  OK account WIN blocks attempt 2');
}

async function scenarioDraw1xStopsMg() {
  const { requestWorker } = makeScriptedWorker({
    'deal-d1': [
      { success: true, pending: false, deal_id: 'deal-d1', outcome: 'draw', profit: 0, source: 'check_win' }
    ]
  });
  const mon = createPoDealMonitor({ requestWorker, log: () => {}, onResult: () => {} });
  mon.trackPlaced('bot1', {
    dealId: 'deal-d1', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 2000
  });
  await mon.pollOnce('bot1');
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 300 });
  assert.strictEqual(gate.allow, false);
  assert.strictEqual(gate.reason, 'account_draw_1x');
  console.log('  OK DRAW on 1x blocks MG');
}

async function scenarioDraw2xContinues() {
  const { requestWorker } = makeScriptedWorker({
    'deal-d2': [
      { success: true, pending: false, deal_id: 'deal-d2', outcome: 'draw', profit: 0, source: 'check_win' }
    ]
  });
  const mon = createPoDealMonitor({ requestWorker, log: () => {}, onResult: () => {} });
  mon.trackPlaced('bot1', {
    dealId: 'deal-d2', ssid: 'fake', attempt: 2, durationSec: 1, placedAt: Date.now() - 2000
  });
  await mon.pollOnce('bot1');
  assert.strictEqual(mon.get('bot1').chainFreeze, false);
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 300 });
  assert.strictEqual(gate.allow, true);
  assert.strictEqual(gate.reason, 'account_draw_continue');
  console.log('  OK DRAW on 2x continues MG');
}

async function scenarioLossContinues() {
  const { requestWorker } = makeScriptedWorker({
    'deal-loss': [
      { success: true, pending: true, deal_id: 'deal-loss', source: 'opened_deals' },
      { success: true, pending: false, deal_id: 'deal-loss', outcome: 'loss', profit: -2, source: 'get_closed_deal' }
    ]
  });
  const mon = createPoDealMonitor({ requestWorker, log: () => {}, onResult: () => {} });
  mon.trackPlaced('bot1', {
    dealId: 'deal-loss', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 1500
  });
  for (let i = 0; i < 5 && mon.get('bot1')?.pending; i++) {
    await mon.pollOnce('bot1');
  }
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 500 });
  assert.strictEqual(gate.allow, true);
  assert.strictEqual(gate.reason, 'account_loss');
  console.log('  OK account LOSS allows attempt 2');
}

async function scenarioOnlyLatestDeal() {
  const { requestWorker, calls } = makeScriptedWorker({
    'old-win': [
      { success: true, pending: false, deal_id: 'old-win', outcome: 'win', profit: 10, source: 'stale' }
    ],
    'new-loss': [
      { success: true, pending: false, deal_id: 'new-loss', outcome: 'loss', profit: -4, source: 'live' }
    ]
  });
  const mon = createPoDealMonitor({ requestWorker, log: () => {}, onResult: () => {} });
  mon.trackPlaced('bot1', {
    dealId: 'old-win', ssid: 'fake', attempt: 1, durationSec: 60, placedAt: Date.now()
  });
  mon.trackPlaced('bot1', {
    dealId: 'new-loss', ssid: 'fake', attempt: 2, durationSec: 1, placedAt: Date.now() - 2000
  });
  await mon.pollOnce('bot1');
  assert.strictEqual(mon.get('bot1').dealId, 'new-loss');
  assert.strictEqual(mon.get('bot1').outcome, 'loss');
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 300 });
  assert.strictEqual(gate.allow, true);
  assert.ok(calls.every((c) => c.id === 'new-loss'));
  console.log('  OK only latest deal is monitored');
}

async function scenarioGatePeekWinBlocks() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => ({
      success: true,
      pending: false,
      deal_id: req.deal_id,
      outcome: 'win',
      profit: 3.6,
      source: 'get_closed_deal'
    }),
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'late-win',
    ssid: 'fake',
    attempt: 1,
    durationSec: 1,
    placedAt: Date.now() - 900
  });
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 1500 });
  assert.strictEqual(gate.allow, false);
  console.log('  OK gate peek WIN blocks');
}

async function scenarioFailClosedWhenPending() {
  const t0 = Date.now();
  const mon = createPoDealMonitor({
    requestWorker: async (req) => ({
      success: true, pending: true, deal_id: req.deal_id, source: 'opened_deals'
    }),
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'stuck',
    ssid: 'fake',
    attempt: 1,
    durationSec: 60,
    placedAt: Date.now()
  });
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 400 });
  const elapsed = Date.now() - t0;
  assert.strictEqual(gate.allow, false);
  assert.ok(gate.reason === 'previous_still_open' || gate.reason === 'pending_fail_closed');
  assert.ok(elapsed < 2500, `still-open wait too slow: ${elapsed}ms`);
  console.log(`  OK still-open skip in ${elapsed}ms`);
  mon.clear('bot1');
}

async function scenarioBotLossWhileOpenDoesNotAllow() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal') return { success: true, watching: true };
      return { success: true, pending: true, deal_id: req.deal_id, source: 'opened_deals' };
    },
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'still-open',
    ssid: 'fake',
    attempt: 1,
    durationSec: 60,
    placedAt: Date.now()
  });
  await mon.settleNow('bot1', { hintOutcome: 'loss' });
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 400 });
  assert.strictEqual(gate.allow, false);
  assert.ok(gate.reason === 'previous_still_open' || gate.reason === 'pending_fail_closed');
  assert.notStrictEqual(mon.get('bot1')?.outcome, 'loss');
  console.log('  OK candle LOSS while PO still open does not allow MG');
  mon.clear('bot1');
}

async function scenarioBotLossAfterExpiryWaitsForPo() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal') return { success: true, watching: true };
      return { success: true, pending: true, deal_id: req.deal_id, source: 'pending', hint: 'not_in_opened_or_closed' };
    },
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'late-loss',
    ssid: 'fake',
    attempt: 1,
    durationSec: 1,
    placedAt: Date.now() - 2500
  });
  await mon.settleNow('bot1', { hintOutcome: 'loss' });
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 400 });
  assert.strictEqual(gate.allow, true);
  assert.ok(gate.reason === 'history_no_win' || gate.reason === 'account_loss');
  console.log('  OK candle LOSS after expiry places S1 unless history shows WIN');
  mon.clear('bot1');
}

async function scenarioCheckWinProfitWinFreezes() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal') return { success: true, watching: true };
      return {
        success: true,
        pending: false,
        deal_id: req.deal_id,
        outcome: 'win',
        profit: 0.18,
        source: 'check_win'
      };
    },
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'po-win',
    ssid: 'fake',
    attempt: 3,
    durationSec: 1,
    placedAt: Date.now() - 2500
  });
  await mon.settleNow('bot1', { hintOutcome: 'loss' });
  assert.strictEqual(mon.get('bot1').outcome, 'win');
  assert.strictEqual(mon.get('bot1').chainFreeze, true);
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 400 });
  assert.strictEqual(gate.allow, false);
  assert.strictEqual(gate.reason, 'account_win');
  console.log('  OK PO check_win profit WIN freezes MG even if candle was LOSS');
  mon.clear('bot1');
}

async function scenarioOpenedListLossAllows() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => ({
      success: true,
      pending: false,
      outcome: 'loss',
      profit: -10,
      deal_id: req.deal_id,
      source: 'opened_deals'
    }),
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'open-loss',
    ssid: 'fake',
    attempt: 1,
    durationSec: 1,
    placedAt: Date.now() - 2500
  });
  await mon.pollOnce('bot1');
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 500 });
  assert.strictEqual(gate.allow, true);
  assert.strictEqual(gate.reason, 'account_loss');
  console.log('  OK opened-list LOSS (still listed open) allows attempt 2');
  mon.clear('bot1');
}

async function scenarioSettleNowWinAfterExpiryFreezes() {
  const t0 = Date.now();
  const mon = createPoDealMonitor({
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal') return { success: true, watching: true };
      return { success: true, pending: true, deal_id: req.deal_id, source: 'pending' };
    },
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'now-win',
    ssid: 'fake',
    attempt: 1,
    durationSec: 1,
    placedAt: Date.now() - 2500
  });
  await mon.settleNow('bot1', { hintOutcome: 'win' });
  const elapsed = Date.now() - t0;
  assert.strictEqual(mon.get('bot1').outcome, 'win');
  assert.strictEqual(mon.get('bot1').chainFreeze, true);
  assert.ok(elapsed < 1500, `settleNow too slow: ${elapsed}ms`);
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 400 });
  assert.strictEqual(gate.allow, false);
  console.log(`  OK settleNow candle WIN after expiry freezes MG (${elapsed}ms)`);
  mon.clear('bot1');
}

async function scenarioLatePoWinAfterBotLossFreezes() {
  const { requestWorker } = makeScriptedWorker({
    'deal-late-win': [
      { success: true, pending: true, deal_id: 'deal-late-win', source: 'opened_deals' },
      { success: true, pending: false, deal_id: 'deal-late-win', outcome: 'win', profit: 0.16, source: 'check_win' }
    ]
  });
  const events = [];
  const mon = createPoDealMonitor({
    requestWorker,
    log: () => {},
    onResult: (p) => events.push(p)
  });
  mon.trackPlaced('bot1', {
    dealId: 'deal-late-win',
    ssid: 'fake',
    attempt: 3,
    durationSec: 5,
    placedAt: Date.now() - 400
  });
  await mon.settleNow('bot1', { hintOutcome: 'loss' });
  assert.ok(mon.get('bot1')?.pending, 'bot LOSS must not confirm while PO is still open');
  for (let i = 0; i < 8 && mon.get('bot1')?.pending; i++) {
    await mon.pollOnce('bot1');
    await sleep(15);
  }
  assert.strictEqual(mon.get('bot1').outcome, 'win');
  assert.strictEqual(mon.get('bot1').chainFreeze, true);
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 400 });
  assert.strictEqual(gate.allow, false);
  assert.strictEqual(gate.reason, 'account_win');
  assert.ok(events.some((e) => e.chainFreeze === true));
  console.log('  OK late PO WIN after bot LOSS freezes MG');
  mon.clear('bot1');
}

async function scenarioLaterCandleWinDoesNotOverwriteLoss() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal') return { success: true, watching: true };
      return { success: true, pending: true, deal_id: req.deal_id, source: 'pending' };
    },
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'ticket-1x',
    ssid: 'fake',
    attempt: 1,
    durationSec: 1,
    placedAt: Date.now() - 2500
  });
  await mon.settleNow('bot1', { hintOutcome: 'loss' });
  assert.strictEqual(mon.get('bot1').hintOutcome, 'loss');
  assert.ok(mon.get('bot1').pending);
  await mon.settleNow('bot1', { hintOutcome: 'win' });
  assert.strictEqual(mon.get('bot1').hintOutcome, 'loss', 'S1 candle WIN must not overwrite 1x LOSS hint');
  assert.ok(mon.get('bot1').pending, 'must still wait for PO check_win');
  assert.notStrictEqual(mon.get('bot1').outcome, 'win');
  const gate = await mon.gateMartingale('bot1', { timeoutMs: 400 });
  assert.strictEqual(gate.allow, true, 'bot LOSS + no user WIN in history → place S1 now');
  assert.notStrictEqual(gate.reason, 'account_win');
  assert.notStrictEqual(mon.get('bot1')?.chainFreeze, true);
  mon.applyWorkerResult({ deal_id: 'ticket-1x' }, {
    success: true,
    pending: false,
    deal_id: 'ticket-1x',
    outcome: 'loss',
    profit: -5,
    source: 'check_win'
  });
  const gate2 = await mon.gateMartingale('bot1', { timeoutMs: 400 });
  assert.strictEqual(gate2.allow, true);
  assert.strictEqual(gate2.reason, 'account_loss');
  console.log('  OK later S1 candle WIN does not freeze; PO LOSS still places S1');
  mon.clear('bot1');
}

async function scenarioNewChainClearsOldWin() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => ({
      success: true, pending: false, deal_id: req.deal_id, outcome: 'win', profit: 1, source: 'test'
    }),
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot1', {
    dealId: 'old', ssid: 'fake', attempt: 1, durationSec: 1, placedAt: Date.now() - 2000
  });
  await mon.pollOnce('bot1');
  assert.strictEqual((await mon.gateMartingale('bot1')).allow, false);
  mon.markChainIdle('bot1');
  assert.strictEqual(mon.get('bot1'), null);
  assert.strictEqual((await mon.gateMartingale('bot1')).allow, false);
  console.log('  OK new chain clear drops old WIN freeze');
}

async function scenarioSsidClosedLossPlacesS1() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal') return { success: true, watching: true };
      return { success: true, pending: true, deal_id: req.deal_id, source: 'pending' };
    },
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot2', {
    dealId: 'e9cdf2de-3c6b-438c-b4b5-e85f2437aca7',
    ssid: 'fake',
    attempt: 1,
    durationSec: 1,
    placedAt: Date.now() - 2500
  });
  await mon.settleNow('bot2', { hintOutcome: 'loss' });
  assert.ok(mon.get('bot2').pending);
  mon.applyWorkerResult({ deal_id: 'e9cdf2de-3c6b-438c-b4b5-e85f2437aca7' }, {
    success: true,
    pending: false,
    deal_id: 'e9cdf2de-3c6b-438c-b4b5-e85f2437aca7',
    outcome: 'loss',
    profit: -5,
    source: 'ssid_closed'
  });
  const gate = await mon.gateMartingale('bot2', { timeoutMs: 400 });
  assert.strictEqual(gate.allow, true);
  assert.strictEqual(gate.reason, 'account_loss');
  console.log('  OK SSID closed LOSS places S1');
  mon.clear('bot2');
}

async function scenarioSsidClosedWinFreezes() {
  const mon = createPoDealMonitor({
    requestWorker: async (req) => {
      if (req.cmd === 'watch_deal') return { success: true, watching: true };
      return { success: true, pending: true, deal_id: req.deal_id, source: 'pending' };
    },
    log: () => {},
    onResult: () => {}
  });
  mon.trackPlaced('bot2', {
    dealId: 'e9cdf2de-3c6b-438c-b4b5-e85f2437aca7',
    ssid: 'fake',
    attempt: 1,
    durationSec: 1,
    placedAt: Date.now() - 2500
  });
  mon.applyWorkerResult({ deal_id: 'e9cdf2de-3c6b-438c-b4b5-e85f2437aca7' }, {
    success: true,
    pending: false,
    deal_id: 'e9cdf2de-3c6b-438c-b4b5-e85f2437aca7',
    outcome: 'win',
    profit: 4.6,
    source: 'ssid_closed'
  });
  const gate = await mon.gateMartingale('bot2', { timeoutMs: 400 });
  assert.strictEqual(gate.allow, false);
  assert.strictEqual(gate.reason, 'account_win');
  console.log('  OK SSID closed WIN freezes MG');
  mon.clear('bot2');
}

(async () => {
  console.log('po-deal-monitor simulation:');
  await scenarioAccountWinStopsMg();
  await scenarioDraw1xStopsMg();
  await scenarioDraw2xContinues();
  await scenarioLossContinues();
  await scenarioOnlyLatestDeal();
  await scenarioGatePeekWinBlocks();
  await scenarioFailClosedWhenPending();
  await scenarioBotLossWhileOpenDoesNotAllow();
  await scenarioBotLossAfterExpiryWaitsForPo();
  await scenarioCheckWinProfitWinFreezes();
  await scenarioOpenedListLossAllows();
  await scenarioSettleNowWinAfterExpiryFreezes();
  await scenarioLatePoWinAfterBotLossFreezes();
  await scenarioLaterCandleWinDoesNotOverwriteLoss();
  await scenarioNewChainClearsOldWin();
  await scenarioSsidClosedLossPlacesS1();
  await scenarioSsidClosedWinFreezes();
  console.log('test_po_deal_monitor_sim: OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
