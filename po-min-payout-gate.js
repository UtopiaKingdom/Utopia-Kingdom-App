/**
 * SSID autotrade payout rules:
 * - Live payout must be ≥ 90 (90 / 91 / 92 OK; never below 90).
 * - Bot/Contabo + Edge list stamps may correct classic SSID under-report
 *   (list/UI 92, SSID duration bucket 84/87/88).
 * - Never let a stamp override a clearly junk catalog (e.g. 23%).
 */
'use strict';

function resolveMinPayoutPct(raw, fallback = 90) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(50, Math.min(92, Math.round(n)));
}

function _num(v) {
  if (v == null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Catalog/SSID in the "near miss" band (e.g. 78–89) is under-report noise,
 * not junk like 23% / 45%. PO picker can sit at 92 while SSID duration
 * buckets print 84/87/88.
 */
function isNearFloorUnderReport(pct, absFloor = 90, maxDip = 12) {
  const floor = Math.max(50, Math.min(92, Math.round(Number(absFloor) || 90)));
  const n = _num(pct);
  const dip = Math.max(1, Math.round(Number(maxDip) || 12));
  return Number.isFinite(n) && n < floor && n >= floor - dip;
}

/**
 * When to trust Contabo/bot payout stamp over live SSID.
 * Allow classic under-report (SSID/catalog 78–89 with stamp ≥ floor).
 * Never when catalog is clearly junk (far below floor).
 */
function shouldPreferSignalPayout({
  signalPay,
  payoutPct,
  catalogPct,
  absFloor = 90,
  maxSsidDip = 12
} = {}) {
  const floor = Math.max(50, Math.min(92, Math.round(Number(absFloor) || 90)));
  const sig = _num(signalPay);
  const live = _num(payoutPct);
  const catalog = _num(catalogPct);
  const dip = Math.max(1, Math.round(Number(maxSsidDip) || 12));
  if (!Number.isFinite(sig) || sig < floor) return false;
  const ssidLow = !Number.isFinite(live) || live < floor;
  if (!ssidLow) return false;

  // Catalog clearly junk → never let bot stamp override.
  if (Number.isFinite(catalog) && catalog < floor - dip) return false;

  // Catalog ≥ floor → classic duration under-report vs list.
  if (Number.isFinite(catalog) && catalog >= floor) return true;

  // Catalog missing OR near-floor under-report (88/89) — trust stamp.
  if (!Number.isFinite(catalog) || isNearFloorUnderReport(catalog, floor, dip)) {
    if (!Number.isFinite(live) || isNearFloorUnderReport(live, floor, dip)) return true;
  }
  return false;
}

/**
 * Prefer Edge/PO-picker list % when SSID effective under-reports by a few points.
 */
function shouldPreferListPayout({
  listPay,
  payoutPct,
  catalogPct,
  absFloor = 90,
  maxSsidDip = 12
} = {}) {
  const floor = Math.max(50, Math.min(92, Math.round(Number(absFloor) || 90)));
  const list = _num(listPay);
  const live = _num(payoutPct);
  const catalog = _num(catalogPct);
  const dip = Math.max(1, Math.round(Number(maxSsidDip) || 12));
  if (!Number.isFinite(list) || list < floor) return false;
  // Don't override a clearly junk SSID with a stale high list file.
  if (Number.isFinite(catalog) && catalog < floor - dip) return false;
  if (Number.isFinite(live) && live < floor - dip && !isNearFloorUnderReport(live, floor, dip)) {
    return false;
  }
  if (Number.isFinite(live) && live >= floor) return false;
  return true;
}

/**
 * Resolve the % used for the ≥90 gate from SSID + optional list/signal.
 * Priority when SSID is a near-floor under-report: list → signal → catalog → ssid.
 */
function resolveGatePayoutPct({
  payoutPct,
  catalogPct,
  signalPay,
  listPay,
  absFloor = 90,
  maxSsidDip = 12
} = {}) {
  const floor = Math.max(50, Math.min(92, Math.round(Number(absFloor) || 90)));
  let pct = _num(payoutPct);
  let source = 'ssid';

  const catalog = _num(catalogPct);
  if (
    Number.isFinite(catalog) &&
    catalog >= floor &&
    Number.isFinite(pct) &&
    pct < floor &&
    catalog - pct <= Math.max(1, Math.round(Number(maxSsidDip) || 12))
  ) {
    pct = catalog;
    source = 'catalog';
  }

  if (
    shouldPreferListPayout({
      listPay,
      payoutPct: pct,
      catalogPct: catalog,
      absFloor: floor,
      maxSsidDip
    })
  ) {
    pct = _num(listPay);
    source = 'edge-list';
  }

  if (
    shouldPreferSignalPayout({
      signalPay,
      payoutPct: pct,
      catalogPct: catalog,
      absFloor: floor,
      maxSsidDip
    })
  ) {
    pct = _num(signalPay);
    source = 'signal';
  }

  return {
    payoutPct: Number.isFinite(pct) ? pct : null,
    source,
    preferSignal: source === 'signal',
    preferList: source === 'edge-list'
  };
}

/**
 * @param {{
 *   payoutPct: number|null|undefined,
 *   minPayoutPct?: number,
 *   absoluteFloor?: number,
 *   lookupOk?: boolean,
 *   enforceEntryFloor?: boolean,
 * }} input
 */
function assertMinLivePayout(input = {}) {
  // Hard floor 90 — 90/91/92 pass; anything under 90 is skipped.
  const minPayoutPct = 90;
  const absoluteFloor = 90;
  const lookupOk = input.lookupOk !== false;
  const enforceEntryFloor = input.enforceEntryFloor !== false;
  const payoutPct = Number(input.payoutPct);

  if (!lookupOk || !Number.isFinite(payoutPct)) {
    return {
      allow: false,
      reason: 'payout_unknown',
      payoutPct: Number.isFinite(payoutPct) ? payoutPct : null,
      minPayoutPct,
      absoluteFloor,
      enforceEntryFloor
    };
  }

  if (payoutPct + 1e-9 < minPayoutPct) {
    return {
      allow: false,
      reason: enforceEntryFloor ? 'below_min' : 'below_absolute',
      payoutPct,
      minPayoutPct,
      absoluteFloor,
      enforceEntryFloor
    };
  }

  return {
    allow: true,
    reason: enforceEntryFloor ? 'ok' : 'midchain_above_absolute',
    payoutPct,
    minPayoutPct,
    absoluteFloor,
    enforceEntryFloor
  };
}

module.exports = {
  assertMinLivePayout,
  resolveMinPayoutPct,
  shouldPreferSignalPayout,
  shouldPreferListPayout,
  resolveGatePayoutPct,
  isNearFloorUnderReport
};
