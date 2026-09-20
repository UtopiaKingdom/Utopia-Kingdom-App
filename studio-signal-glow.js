/**
 * studio-signal-glow.js — Buy/sell/win/loss outline on custom bot signal area (house-bot parity).
 */
(function () {
  'use strict';

  const GLOW_CLASSES = [
    'glow-preparing',
    'glow-buy',
    'glow-sell',
    'glow-win',
    'glow-loss',
    'glow-cancelled'
  ];

  const lastGlowByArea = new WeakMap();

  function normPhase(sig) {
    const p = String((sig && sig.phase) || '').toLowerCase();
    if (p === 'trading result') return 'result';
    return p;
  }

  function normAction(sig) {
    const raw = String((sig && (sig.side || sig.action)) || '').toLowerCase();
    if (raw === 'call' || raw === 'buy') return 'buy';
    if (raw === 'put' || raw === 'sell') return 'sell';
    return raw;
  }

  function normResult(sig) {
    const raw = String((sig && sig.result) || '').toLowerCase();
    if (raw === 'win') return 'win';
    if (raw === 'loss' || raw === 'lose') return 'loss';
    return raw;
  }

  function glowClassForSignal(sig) {
    if (!sig) return null;
    const phase = normPhase(sig);
    const action = normAction(sig);
    const result = normResult(sig);

    if (phase === 'preparing') return 'glow-preparing';
    if (phase === 'cancelled') return 'glow-cancelled';
    if (phase === 'signal') {
      if (action === 'buy') return 'glow-buy';
      if (action === 'sell') return 'glow-sell';
    }
    if (phase === 'result') {
      if (result === 'win') return 'glow-win';
      if (result === 'loss') return 'glow-loss';
    }
    return null;
  }

  function signalAreaEl(house) {
    if (!house) return null;
    return house.querySelector('.bot-signal-area');
  }

  function applyStudioGlow(house, sig) {
    const area = signalAreaEl(house);
    if (!area) return;
    const next = glowClassForSignal(sig);
    if (lastGlowByArea.get(area) === next) return;
    lastGlowByArea.set(area, next);
    area.classList.remove(...GLOW_CLASSES);
    if (next) {
      requestAnimationFrame(function () {
        try { area.classList.add(next); } catch (e) {}
      });
    }
  }

  function clearStudioGlow(house) {
    const area = signalAreaEl(house);
    if (!area) return;
    lastGlowByArea.delete(area);
    area.classList.remove(...GLOW_CLASSES);
  }

  window.__utkStudioSignalGlow = {
    glowClassForSignal: glowClassForSignal,
    apply: applyStudioGlow,
    clear: clearStudioGlow
  };
})();
