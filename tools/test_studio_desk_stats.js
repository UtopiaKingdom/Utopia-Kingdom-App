const fs = require('fs');
const vm = require('vm');
const stats = fs.readFileSync(__dirname + '/../studio-desk-stats.js', 'utf8');
const ctx = { window: {}, module: { exports: {} }, require: () => null };
vm.createContext(ctx);
vm.runInContext(stats, ctx);
ctx.window.__utkStatsDay = {
  dayKey: () => '2026-08-30',
  dayRange: () => ({ key: '2026-08-30', start: 0, end: 9999999999999 })
};

// Bogus WIPE attempt 2 must not count.
const bogus = [
  { id: 1, result: 'WIN', pair: 'A', attempt: 1, closedAtMs: 1000 },
  { id: 2, result: 'WIPE', pair: 'B', attempt: 2, closedAtMs: 2000 }
];
const bogusStats = ctx.window.__utkStudioDeskStats.computeDeskStats(bogus, '2026-08-30');
if (bogusStats.wipes !== 0) {
  console.error('FAIL bogus WIPE attempt 2 counted as wipe', bogusStats.wipes);
  process.exit(1);
}

// Four MG losses then win on S4 — not a wipe.
const visa = [
  { id: 10, result: 'LOSS', pair: 'VISA OTC', attempt: 1, closedAtMs: 10000 },
  { id: 11, result: 'LOSS', pair: 'VISA OTC', attempt: 2, closedAtMs: 11000 },
  { id: 12, result: 'LOSS', pair: 'VISA OTC', attempt: 3, closedAtMs: 12000 },
  { id: 13, result: 'LOSS', pair: 'VISA OTC', attempt: 4, closedAtMs: 13000 },
  { id: 14, result: 'WIN', pair: 'VISA OTC', attempt: 5, closedAtMs: 14000 }
];
const visaStats = ctx.window.__utkStudioDeskStats.computeDeskStats(visa, '2026-08-30');
if (visaStats.wipes !== 0) {
  console.error('FAIL 4 losses + S4 win counted wipe', visaStats.wipes);
  process.exit(1);
}
if (visaStats.s4 !== 1) {
  console.error('FAIL expected s4 win', visaStats);
  process.exit(1);
}

// True wipe on attempt 5.
const wipe = [
  { id: 20, result: 'WIN', pair: 'X', attempt: 1, closedAtMs: 20000 },
  { id: 21, result: 'WIN', pair: 'Y', attempt: 1, closedAtMs: 21000 },
  { id: 22, result: 'LOSS', pair: 'Z', attempt: 5, closedAtMs: 22000 }
];
const wipeStats = ctx.window.__utkStudioDeskStats.computeDeskStats(wipe, '2026-08-30');
if (wipeStats.wipes !== 1) {
  console.error('FAIL expected 1 wipe', wipeStats);
  process.exit(1);
}
if (wipeStats.bestStreak !== 2) {
  console.error('FAIL expected last streak 2 before wipe', wipeStats.bestStreak);
  process.exit(1);
}

console.log('PASS studio desk stats');
