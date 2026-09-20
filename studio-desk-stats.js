/**
 * studio-desk-stats.js — Custom bot desk stats match history badges.
 * Wipes only on attempt 5 (or WIPE row with attempt >= 5), not 5 random losses.
 */
(function () {
  'use strict';

  function statsDayApi() {
    try {
      if (typeof window !== 'undefined' && window.__utkStatsDay) return window.__utkStatsDay;
    } catch (e) {}
    try { return require('./stats-day.js'); } catch (e2) { return null; }
  }

  function toMs(t) {
    try {
      if (window.__utkTradeTime && typeof window.__utkTradeTime.toEpochMs === 'function') {
        const ms = window.__utkTradeTime.toEpochMs(
          (t && (t.closedAtMs || t.closingTime || t.createdAt || t.openedAtMs || t.openingTime))
        );
        if (ms) return ms;
      }
    } catch (e) {}
    const keys = ['closedAtMs', 'closingTime', 'createdAt', 'openedAtMs', 'openingTime', 'timestamp'];
    for (let i = 0; i < keys.length; i++) {
      const raw = t && t[keys[i]];
      if (raw == null || raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    }
    return 0;
  }

  function parseOutcome(t) {
    const r = String((t && t.result) || '').toUpperCase().trim();
    if (r === 'WIN' || r === 'WON' || r === 'SUCCESS' || r === 'W') return 'WIN';
    if (r === 'LOSS' || r === 'LOSE' || r === 'LOST' || r === 'L') return 'LOSS';
    if (r === 'WIPE') return 'WIPE';
    return '';
  }

  function tradeAttempt(t) {
    const n = Number(t && t.attempt);
    if (Number.isFinite(n) && n >= 1) return Math.min(5, Math.trunc(n));
    return 1;
  }

  /** Full 5-step MG wipe only — not five unrelated losses on different pairs. */
  function isWipeTrade(t) {
    const res = parseOutcome(t);
    const attempt = tradeAttempt(t);
    if (res === 'WIPE') return attempt >= 5;
    if (res === 'LOSS') return attempt >= 5;
    return false;
  }

  function canonPairKey(v) {
    return String(v || '').toUpperCase().replace(/\s+/g, ' ').trim();
  }

  function dedupeTrades(rows) {
    let list = Array.isArray(rows) ? rows.slice() : [];
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.dedupeResultTrades === 'function') {
        list = window.__utkBotStats.dedupeResultTrades(list);
      }
    } catch (e) {}
    const seen = Object.create(null);
    const out = [];
    list.forEach(function (r) {
      const key = [
        Number(r.openedAtMs || r.openingTime || 0),
        Number(r.attempt || 1),
        canonPairKey(r.pair),
        String(r.result || '').toUpperCase(),
        String(r.side || '').toUpperCase()
      ].join('|');
      if (seen[key]) return;
      seen[key] = true;
      out.push(r);
    });
    return out;
  }

  function dayRange(dayKey) {
    const api = statsDayApi();
    if (api && typeof api.dayRange === 'function') {
      return api.dayRange(dayKey || api.dayKey(Date.now()));
    }
    return { key: dayKey || '', start: 0, end: Number.MAX_SAFE_INTEGER };
  }

  function inRange(t, range) {
    if (!range) return true;
    const ts = toMs(t);
    if (!(ts > 0)) return false;
    return ts >= range.start && ts < range.end;
  }

  function winBucketFromAttempt(attempt) {
    const a = Math.max(1, Math.min(5, attempt));
    if (a === 1) return 'entry';
    if (a === 2) return 's1';
    if (a === 3) return 's2';
    if (a === 4) return 's3';
    if (a === 5) return 's4';
    return '';
  }

  function sortTape(rows) {
    return rows.slice().sort(function (a, b) {
      const da = toMs(a) - toMs(b);
      if (da !== 0) return da;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  }

  function walkTape(history) {
    const tapeRows = sortTape(dedupeTrades(history).filter(function (t) {
      const o = parseOutcome(t);
      if (o === 'WIN' || o === 'LOSS') return true;
      if (o === 'WIPE') return tradeAttempt(t) >= 5;
      return false;
    }));

    let winStreak = 0;
    let streakStartMs = null;
    const completed = [];

    tapeRows.forEach(function (t) {
      const res = parseOutcome(t);
      const ts = toMs(t);

      if (isWipeTrade(t)) {
        if (winStreak > 0) {
          completed.push({
            length: winStreak,
            startedAt: streakStartMs,
            endedAt: ts || null
          });
        }
        winStreak = 0;
        streakStartMs = null;
        return;
      }

      if (res === 'LOSS') {
        return;
      }

      if (res !== 'WIN') return;

      if (winStreak === 0) streakStartMs = ts || null;
      winStreak += 1;
    });

    return {
      tapeRows: tapeRows,
      liveStreak: winStreak,
      completed: completed
    };
  }

  function lastStreakForRange(completed, range) {
    if (!completed || !completed.length) return 0;
    for (let i = completed.length - 1; i >= 0; i--) {
      const ended = Number(completed[i].endedAt) || 0;
      if (!range || (ended >= range.start && ended < range.end)) {
        return Math.max(0, parseInt(completed[i].length, 10) || 0);
      }
    }
    return 0;
  }

  function computeDeskStats(history, dayKey) {
    const range = dayRange(dayKey);
    const walked = walkTape(history);
    const tapeRows = walked.tapeRows;

    const out = {
      entry: 0,
      s1: 0,
      s2: 0,
      s3: 0,
      s4: 0,
      wins: 0,
      wipes: 0,
      streak: walked.liveStreak,
      bestStreak: 0,
      completedStreaks: walked.completed.slice().reverse()
    };

    tapeRows.forEach(function (t) {
      const res = parseOutcome(t);
      const inDay = inRange(t, range);

      if (isWipeTrade(t)) {
        if (inDay) out.wipes += 1;
        return;
      }

      if (res !== 'WIN' || !inDay) return;

      out.wins += 1;
      const bucket = winBucketFromAttempt(tradeAttempt(t));
      if (bucket) out[bucket] += 1;
    });

    out.bestStreak = lastStreakForRange(walked.completed, range);
    if (!out.bestStreak && walked.completed.length) {
      out.bestStreak = Math.max(0, parseInt(walked.completed[walked.completed.length - 1].length, 10) || 0);
    }
    out.avgWaitLabel = '—';
    out.avgWaitTitle = 'Average wait between new signals over the last 3 hours';
    try {
      if (window.__utkSignalWait && typeof window.__utkSignalWait.fromTrades === 'function') {
        const wait = window.__utkSignalWait.fromTrades(history);
        if (wait) {
          out.avgWaitLabel = wait.label || '—';
          if (wait.title) out.avgWaitTitle = wait.title;
        }
      }
    } catch (eWait) {}
    return out;
  }

  function applyStatsToHouse(house, history, dayKey) {
    if (!house) return null;
    const stats = computeDeskStats(history, dayKey);
    const map = [
      ['entry', '.stat-item .stat-label', 'Entry'],
      ['s1', '.stat-item .stat-label', 'S1'],
      ['s2', '.stat-item .stat-label', 'S2'],
      ['s3', '.stat-item .stat-label', 'S3'],
      ['s4', '.stat-item .stat-label', 'S4'],
      ['wipes', '.stat-item.chains-lost .stat-value', null],
      ['wins', '.stat-item.total-wins .stat-value', null],
      ['streak', '.win-streak-badge .win-streak-value', null],
      ['bestStreak', '.best-streak-badge .win-streak-value', null]
    ];

    map.forEach(function (row) {
      const key = row[0];
      const val = String(stats[key] != null ? stats[key] : 0);
      if (row[2]) {
        house.querySelectorAll(row[1]).forEach(function (labelEl) {
          if (String(labelEl.textContent || '').trim() !== row[2]) return;
          const valueEl = labelEl.parentElement && labelEl.parentElement.querySelector('.stat-value');
          if (valueEl) valueEl.textContent = val;
        });
        return;
      }
      const el = house.querySelector(row[1]);
      if (el) el.textContent = val;
    });

    try {
      const waitItem = house.querySelector('.stat-item.signal-wait');
      if (waitItem) {
        const waitVal = waitItem.querySelector('.stat-value');
        if (waitVal) waitVal.textContent = stats.avgWaitLabel || '—';
        if (stats.avgWaitTitle) waitItem.setAttribute('title', stats.avgWaitTitle);
      }
    } catch (eWait) {}

    try {
      house.setAttribute('data-studio-completed-streaks', JSON.stringify(stats.completedStreaks || []));
    } catch (e) {}

    return stats;
  }

  function selectedDayKey(house) {
    const input = house && house.querySelector('#studioStatsDateInput');
    if (input && input.value) return input.value;
    const api = statsDayApi();
    return api && typeof api.dayKey === 'function' ? api.dayKey(Date.now()) : '';
  }

  function refreshHouseStats(house) {
    if (!house) return null;
    let history = [];
    let full = [];
    try {
      history = JSON.parse(house.getAttribute('data-feed-history') || '[]');
    } catch (e) {}
    try {
      full = JSON.parse(house.getAttribute('data-feed-history-full') || '[]');
    } catch (e2) {}
    if (!history.length && full.length) history = full;
    const stats = applyStatsToHouse(house, history, selectedDayKey(house));
    try {
      const waitSrc = full.length ? full : history;
      if (stats && window.__utkSignalWait && typeof window.__utkSignalWait.fromTrades === 'function') {
        const wait = window.__utkSignalWait.fromTrades(waitSrc);
        stats.avgWaitLabel = wait.label || '—';
        if (wait.title) stats.avgWaitTitle = wait.title;
        const waitItem = house.querySelector('.stat-item.signal-wait');
        if (waitItem) {
          const waitVal = waitItem.querySelector('.stat-value');
          if (waitVal) waitVal.textContent = stats.avgWaitLabel;
          if (stats.avgWaitTitle) waitItem.setAttribute('title', stats.avgWaitTitle);
        }
      }
    } catch (eWait) {}
    return stats;
  }

  window.__utkStudioDeskStats = {
    computeDeskStats: computeDeskStats,
    walkTape: walkTape,
    isWipeTrade: isWipeTrade,
    applyStatsToHouse: applyStatsToHouse,
    refreshHouseStats: refreshHouseStats,
    dedupeTrades: dedupeTrades
  };
})();
