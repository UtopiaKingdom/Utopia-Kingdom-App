'use strict';

const {
  assertMinLivePayout,
  resolveMinPayoutPct,
  shouldPreferSignalPayout,
  shouldPreferListPayout,
  resolveGatePayoutPct
} = require('../po-min-payout-gate');
const assert = require('assert');

{
  const r = assertMinLivePayout({ payoutPct: 82, minPayoutPct: 90 });
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.reason, 'below_min');
}
{
  const r = assertMinLivePayout({ payoutPct: 90, minPayoutPct: 90 });
  assert.strictEqual(r.allow, true);
}
{
  const r = assertMinLivePayout({ payoutPct: 91, minPayoutPct: 92 });
  assert.strictEqual(r.allow, true); // signal stamped 92, floor is still 90
}
{
  const r = assertMinLivePayout({ payoutPct: 88, minPayoutPct: 90 });
  assert.strictEqual(r.allow, false);
}
{
  const r = assertMinLivePayout({
    payoutPct: 90,
    minPayoutPct: 92,
    absoluteFloor: 90,
    enforceEntryFloor: false
  });
  assert.strictEqual(r.allow, true);
}
{
  const r = assertMinLivePayout({
    payoutPct: 78,
    minPayoutPct: 90,
    absoluteFloor: 90,
    enforceEntryFloor: false
  });
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.reason, 'below_absolute');
}
{
  const r = assertMinLivePayout({ lookupOk: false, minPayoutPct: 90 });
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.reason, 'payout_unknown');
}
{
  assert.strictEqual(resolveMinPayoutPct(95), 92);
  assert.strictEqual(resolveMinPayoutPct(80), 80);
  assert.strictEqual(resolveMinPayoutPct(undefined), 90);
}

// USD/COP case: SSID+catalog low, Mirax stamp 90 — must NOT prefer signal.
{
  assert.strictEqual(
    shouldPreferSignalPayout({
      signalPay: 90,
      payoutPct: 23,
      catalogPct: 23,
      absFloor: 90
    }),
    false
  );
}
// Classic under-report: catalog 92, SSID 89, signal 92.
{
  assert.strictEqual(
    shouldPreferSignalPayout({
      signalPay: 92,
      payoutPct: 89,
      catalogPct: 92,
      absFloor: 90
    }),
    true
  );
}
// Tiny SSID dip, no catalog.
{
  assert.strictEqual(
    shouldPreferSignalPayout({
      signalPay: 92,
      payoutPct: 88,
      catalogPct: null,
      absFloor: 90
    }),
    true
  );
}
// Junk SSID, no catalog — do not trust stamp.
{
  assert.strictEqual(
    shouldPreferSignalPayout({
      signalPay: 90,
      payoutPct: 31,
      catalogPct: null,
      absFloor: 90
    }),
    false
  );
}

// THE BUG from screenshots: catalog ALSO under-reports (88/89), signal 92.
// Old logic treated catalog<90 as "junk" and blocked the stamp.
{
  assert.strictEqual(
    shouldPreferSignalPayout({
      signalPay: 92,
      payoutPct: 88,
      catalogPct: 88,
      absFloor: 90
    }),
    true
  );
  assert.strictEqual(
    shouldPreferSignalPayout({
      signalPay: 90,
      payoutPct: 89,
      catalogPct: 89,
      absFloor: 90
    }),
    true
  );
}

// Edge list / PO picker 92 overrides SSID 88/89.
{
  assert.strictEqual(
    shouldPreferListPayout({
      listPay: 92,
      payoutPct: 88,
      catalogPct: 88,
      absFloor: 90
    }),
    true
  );
  assert.strictEqual(
    shouldPreferListPayout({
      listPay: 45,
      payoutPct: 88,
      catalogPct: 88,
      absFloor: 90
    }),
    false
  );
  assert.strictEqual(
    shouldPreferListPayout({
      listPay: 92,
      payoutPct: 23,
      catalogPct: 23,
      absFloor: 90
    }),
    false
  );
}

// Full resolve: ADA/CADJPY screenshot cases.
{
  const ada = resolveGatePayoutPct({
    payoutPct: 88,
    catalogPct: 88,
    signalPay: 92,
    listPay: 92,
    absFloor: 90
  });
  assert.strictEqual(ada.payoutPct, 92);
  assert.ok(ada.source === 'signal' || ada.source === 'edge-list');
  assert.strictEqual(assertMinLivePayout({ payoutPct: ada.payoutPct }).allow, true);
}
{
  const cad = resolveGatePayoutPct({
    payoutPct: 89,
    catalogPct: 89,
    signalPay: 92,
    listPay: 45, // sticky poisoned file must not win
    absFloor: 90
  });
  assert.strictEqual(cad.payoutPct, 92);
  assert.strictEqual(cad.source, 'signal');
}
{
  // No signal, good Edge list.
  const r = resolveGatePayoutPct({
    payoutPct: 88,
    catalogPct: 88,
    signalPay: null,
    listPay: 92,
    absFloor: 90
  });
  assert.strictEqual(r.payoutPct, 92);
  assert.strictEqual(r.source, 'edge-list');
}

// USD/INR screenshot: SSID+catalog 84, PO picker/signal 92, no list file.
{
  assert.strictEqual(
    shouldPreferSignalPayout({
      signalPay: 92,
      payoutPct: 84,
      catalogPct: 84,
      absFloor: 90
    }),
    true
  );
  const inr = resolveGatePayoutPct({
    payoutPct: 84,
    catalogPct: 84,
    signalPay: 92,
    listPay: null,
    absFloor: 90
  });
  assert.strictEqual(inr.payoutPct, 92);
  assert.strictEqual(inr.source, 'signal');
  assert.strictEqual(assertMinLivePayout({ payoutPct: inr.payoutPct }).allow, true);
}

// USD/CLP: SSID 87, list+signal 92.
{
  const clp = resolveGatePayoutPct({
    payoutPct: 87,
    catalogPct: 87,
    signalPay: 92,
    listPay: 92,
    absFloor: 90
  });
  assert.strictEqual(clp.payoutPct, 92);
  assert.ok(clp.source === 'signal' || clp.source === 'edge-list');
}

console.log('po-min-payout-gate ok');
