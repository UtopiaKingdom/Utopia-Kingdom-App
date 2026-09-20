/**
 * po-deal-result-ui.js
 * Live watcher line under Auto Trade: waiting → you won/lost → chain continues/stops.
 */
(() => {
  const { ipcRenderer } = require('electron');
  const ticks = Object.create(null);
  const live = Object.create(null);

  function botKeyFromId(botId) {
    try {
      if (typeof botIdMap === 'object' && botIdMap) {
        return Object.keys(botIdMap).find((k) => botIdMap[k] === botId) || null;
      }
    } catch (e) {}
    if (botId === 'bot1') return 'LUMIX';
    if (botId === 'bot2') return 'MIRAX';
    return null;
  }

  function watchEl(botId) {
    return document.getElementById(`autotradeWatch-${botId}`);
  }

  function autotradeOn(botId) {
    const toggle = document.getElementById(`autoTradeToggle-${botId}`);
    return !!(toggle && toggle.checked);
  }

  function stopTick(botId) {
    if (ticks[botId]) {
      try { clearInterval(ticks[botId]); } catch (e) {}
      ticks[botId] = null;
    }
  }

  function setWatch(botId, state, text) {
    const el = watchEl(botId);
    if (!el) return;
    const on = autotradeOn(botId);
    if (!on) {
      el.dataset.state = 'off';
      const textEl = el.querySelector('.autotrade-watch-text');
      if (textEl) textEl.textContent = '';
      return;
    }
    el.dataset.state = state || 'idle';
    const textEl = el.querySelector('.autotrade-watch-text');
    if (textEl) textEl.textContent = text || '';
    else el.textContent = text || '';
  }

  function formatClock(msLeft) {
    const sec = Math.max(0, Math.ceil(msLeft / 1000));
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function startTick(botId, settleAt, durationSec) {
    stopTick(botId);
    const durMs = Math.max(1000, (Number(durationSec) || 180) * 1000);
    const tick = () => {
      if (!autotradeOn(botId) || live[botId] !== 'watch') {
        stopTick(botId);
        return;
      }
      const leftRaw = Number(settleAt) - Date.now();
      if (!Number.isFinite(leftRaw) || leftRaw > durMs + 60000) {
        showIdle(botId);
        return;
      }
      if (leftRaw <= -8000) {
        showIdle(botId);
        return;
      }
      if (leftRaw <= 0) {
        setWatch(botId, 'watch', 'Checking result');
        return;
      }
      const left = Math.min(leftRaw, durMs + 15000);
      setWatch(botId, 'watch', `In trade  ${formatClock(left)}`);
    };
    tick();
    if (live[botId] !== 'watch') return;
    ticks[botId] = setInterval(tick, 250);
  }

  function showIdle(botId) {
    stopTick(botId);
    live[botId] = 'idle';
    setWatch(botId, 'idle', 'Listening');
  }

  function onDealResult(data) {
    if (!data || !data.botId) return;
    const botId = data.botId;
    const botKey = botKeyFromId(botId);
    const outcome = String(data.outcome || '').toLowerCase();
    const attempt = Number(data.attempt) || 1;
    const profit = data.profit != null && Number.isFinite(Number(data.profit))
      ? Number(data.profit)
      : null;
    const profitText = profit != null && Number.isFinite(profit)
      ? ` $${Math.abs(profit).toFixed(2)}`
      : '';

    if (!autotradeOn(botId)) {
      stopTick(botId);
      live[botId] = 'off';
      setWatch(botId, 'off', '');
      return;
    }

    if (!data.chainFreeze && (data.source === 'new-chain' || data.source === 'no-deal' || outcome === 'resume' || outcome === 'idle')) {
      try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
      stopTick(botId);
      live[botId] = 'idle';
      setWatch(
        botId,
        'idle',
        'Listening'
      );
      return;
    }

    if (outcome === 'watching' || data.source === 'tracking' || (data.pending && !data.chainFreeze)) {
      const remain = Number(data.settleAt) - Date.now();
      const capMs = (botId === 'bot2' ? 60 : botId === 'bot3' ? 600 : 210) * 1000;
      if (Number.isFinite(remain) && (remain > capMs || remain < -8000)) {
        showIdle(botId);
        return;
      }
      try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
      live[botId] = 'watch';
      if (data.settleAt) startTick(botId, data.settleAt, data.durationSec);
      else setWatch(botId, 'watch', 'In trade');
      return;
    }

    stopTick(botId);

    if (data.chainFreeze && (outcome === 'payout' || data.source === 'payout-recovery' || data.source === 'payout-floor' || data.source === 'worker-payout-floor')) {
      live[botId] = 'stop';
      const payout = Number(data.payoutPct);
      const need = Number(data.minPayoutPct);
      const text = Number.isFinite(payout) && Number.isFinite(need)
        ? `Payout ${payout}% < ${Math.round(need)}%. Skipped — waiting for next 1x.`
        : 'Payout too low. Skipped — waiting for next 1x.';
      setWatch(botId, 'stop', text);
      try { window.markSavingLadderReset?.(botKey, data.currency); } catch (e) {}
      try {
        window.setBotAutotradeReason?.(botId, text);
      } catch (e) {}
      if (botKey) console.log(`[${botKey}] SSID payout gate:`, data);
      return;
    }

    if (outcome === 'win') {
      live[botId] = 'win';
      setWatch(botId, 'win', `Won${profitText}. Saving stops.`);
      try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
      try { window.markSavingLadderReset?.(botKey, data.currency); } catch (e) {}
      if (botKey) console.log(`[${botKey}] SSID settle: win`);
      setTimeout(() => {
        if (live[botId] === 'win') showIdle(botId);
      }, 5000);
      return;
    }

    if (outcome === 'draw') {
      const stops = !!data.chainFreeze || attempt <= 1;
      live[botId] = stops ? 'stop' : 'loss';
      setWatch(
        botId,
        stops ? 'stop' : 'loss',
        stops ? 'Draw. Saving stops.' : 'Draw. Saving continues.'
      );
      try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
      if (stops) {
        try { window.markSavingLadderReset?.(botKey, data.currency); } catch (e) {}
      }
      if (botKey) console.log(`[${botKey}] SSID settle: draw`);
      return;
    }

    if (outcome === 'loss') {
      live[botId] = 'loss';
      setWatch(botId, 'loss', `Lost${profitText}. Saving continues.`);
      try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
      if (botKey) console.log(`[${botKey}] SSID settle: loss`);
      return;
    }

    if (data.waitingLoss) {
      live[botId] = 'watch';
      setWatch(botId, 'watch', 'Checking account result');
      return;
    }

    if (data.freezeReason === 'waiting_new_1x' || data.source === 'wait-chain') {
      live[botId] = 'stop';
      setWatch(botId, 'stop', 'Waiting for next 1x (chain stopped — ignore leftover S2–S4)');
      try {
        window.setBotAutotradeReason?.(botId, 'Waiting for next 1x');
      } catch (e) {}
      return;
    }

    showIdle(botId);
  }

  function onToggle(botId) {
    if (!autotradeOn(botId)) {
      stopTick(botId);
      live[botId] = 'off';
      setWatch(botId, 'off', '');
      return;
    }
    if (live[botId] === 'watch') return;
    showIdle(botId);
  }

  ['bot1', 'bot2', 'bot3'].forEach((botId) => {
    const toggle = document.getElementById(`autoTradeToggle-${botId}`);
    if (toggle) {
      toggle.addEventListener('change', () => {
        onToggle(botId);
        if (toggle.checked) hydrate();
      });
      if (toggle.checked) showIdle(botId);
    }
  });

  setInterval(() => {
    ['bot1', 'bot2', 'bot3'].forEach((botId) => {
      const on = autotradeOn(botId);
      if (!on) {
        if (live[botId] !== 'off') onToggle(botId);
        return;
      }
      if (!live[botId] || live[botId] === 'off') showIdle(botId);
    });
  }, 800);

  try {
    ipcRenderer.on('po-deal-result', (_event, data) => onDealResult(data));
  } catch (e) {}

  async function hydrate() {
    try {
      const states = await ipcRenderer.invoke('po-deal-watch-state');
      if (!states || typeof states !== 'object') return;
      for (const botId of ['bot1', 'bot2', 'bot3']) {
        if (states[botId]) onDealResult(states[botId]);
      }
    } catch (e) {}
  }

  setTimeout(hydrate, 400);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) hydrate();
  });

  window.__utkPoDealResultUi = { onDealResult };
})();
