/**
 * Europe/Berlin stats calendar.
 *   node tools/test_stats_day.js
 */
'use strict';

const path = require('path');
const statsDay = require(path.join(__dirname, '..', 'stats-day.js'));

let failed = 0;
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    failed += 1;
    console.error('FAIL', msg, { actual, expected });
  } else {
    console.log('ok', msg);
  }
}

assertEq(statsDay.TZ, 'Europe/Berlin', 'timezone');

const summer = Date.UTC(2026, 7, 19, 10, 0, 0); // 12:00 Berlin
assertEq(statsDay.dayKey(summer), '2026-08-19', 'summer day key at noon');
assertEq(new Date(statsDay.dayStartMs('2026-08-19')).toISOString(), '2026-08-18T22:00:00.000Z', 'CEST midnight is 22:00Z');

const summerRange = statsDay.dayRange('2026-08-19');
assertEq(summerRange.key, '2026-08-19', 'summer range key');
assertEq(summerRange.end - summerRange.start, 24 * 3600 * 1000, 'summer day is 24h');
assertEq(statsDay.dayKey(summerRange.start), '2026-08-19', 'range start is still that Berlin day');
assertEq(statsDay.dayKey(summerRange.end - 1), '2026-08-19', 'last ms belongs to that day');
assertEq(statsDay.dayKey(summerRange.end), '2026-08-20', 'end ms is next day');

const winter = Date.UTC(2026, 0, 15, 10, 0, 0); // 11:00 Berlin
assertEq(statsDay.dayKey(winter), '2026-01-15', 'winter day key');
assertEq(new Date(statsDay.dayStartMs('2026-01-15')).toISOString(), '2026-01-14T23:00:00.000Z', 'CET midnight is 23:00Z');

const late = Date.UTC(2026, 7, 18, 22, 30, 0); // 00:30 Berlin on the 19th
assertEq(statsDay.dayKey(late), '2026-08-19', '00:30 Berlin is the 19th, not the 18th');

const beforeMidnight = Date.UTC(2026, 7, 18, 21, 59, 0); // 23:59 Berlin on the 18th
assertEq(statsDay.dayKey(beforeMidnight), '2026-08-18', '23:59 Berlin is still the 18th');

assertEq(statsDay.formatLabel('2026-08-19'), 'Aug 19, 2026', 'label is the Berlin calendar date, not local Date(start)');

if (failed) {
  console.error('\n' + failed + ' failed');
  process.exit(1);
}
console.log('\nall passed');
