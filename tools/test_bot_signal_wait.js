/**
 * Average wait between new signals (attempt 1) over a rolling 3h window.
 * Run: node tools/test_bot_signal_wait.js
 */
const wait = require('../bot-signal-wait.js');

function fail(msg) {
  console.error('FAIL', msg);
  process.exit(1);
}

const now = Date.parse('2026-09-18T18:00:00Z');
const hour = 60 * 60 * 1000;

const sparse = wait.fromTrades([
  { attempt: 1, openedAtMs: now - 4 * hour }
], now);
if (sparse.label !== '—') fail('old signal outside window should be ignored: ' + sparse.label);

const one = wait.fromTrades([
  { attempt: 1, openedAtMs: now - 20 * 60 * 1000 }
], now);
if (one.label !== '—') fail('single in-window signal cannot average: ' + one.label);
if (one.signals !== 1) fail('expected 1 signal');

const rows = [
  { attempt: 1, openedAtMs: now - 50 * 60 * 1000 },
  { attempt: 2, openedAtMs: now - 49 * 60 * 1000 },
  { attempt: 1, openedAtMs: now - 20 * 60 * 1000 },
  { attempt: 1, openedAtMs: now - 20 * 60 * 1000 + 4000 }, // twin
  { attempt: 1, openedAtMs: now - 5 * 60 * 1000 }
];
const avg = wait.fromTrades(rows, now);
if (avg.signals !== 3) fail('expected 3 clustered chain starts, got ' + avg.signals);
if (avg.gaps !== 2) fail('expected 2 gaps, got ' + avg.gaps);
// gaps: 30m then 15m → avg 22.5m → 23m or 22m depending on round
const mins = Math.round(avg.ms / 60000);
if (mins !== 23 && mins !== 22) fail('expected ~22.5m average, got ' + avg.label + ' (' + mins + 'm)');

if (wait.formatWait(12000) !== '12s') fail('12s format ' + wait.formatWait(12000));
if (wait.formatWait(180000) !== '3m') fail('3m format ' + wait.formatWait(180000));
if (wait.formatWait(90 * 60 * 1000) !== '1h 30m') fail('1h 30m format ' + wait.formatWait(90 * 60 * 1000));

const mgOnly = wait.fromTrades([
  { attempt: 2, openedAtMs: now - 10 * 60 * 1000 },
  { attempt: 3, openedAtMs: now - 9 * 60 * 1000 }
], now);
if (mgOnly.signals !== 0) fail('MG steps must not count as new signals');

console.log('PASS bot signal wait');
