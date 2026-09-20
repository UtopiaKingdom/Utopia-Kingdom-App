/*
  perf-boot.js
  Detects machine class and enables a cheap / mid / full FX profile
  before the rest of the UI boots. Default still looks premium.
*/
(function () {
  'use strict';

  function envFlag(name) {
    try {
      return !!(typeof process !== 'undefined' && process.env && process.env[name] === '1');
    } catch (e) {
      return false;
    }
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function hw() {
    const cores = Number(navigator.hardwareConcurrency) || 4;
    const mem = navigator.deviceMemory != null ? Number(navigator.deviceMemory) : null;
    let dpr = 1;
    try { dpr = Number(window.devicePixelRatio) || 1; } catch (e) {}
    return { cores: cores, mem: mem, dpr: dpr };
  }

  /** low | mid | high */
  function classifyTier(info, forcedLow, reduced) {
    if (forcedLow || reduced) return 'low';
    // Explicit potato
    if (info.cores <= 2) return 'low';
    if (info.mem != null && info.mem <= 4) return 'low';
    // Mid laptops / integrated GPU class
    if (info.cores <= 4) return 'mid';
    if (info.mem != null && info.mem <= 8) return 'mid';
    // High DPR + weak cores still feel mid when resizing
    if (info.dpr >= 2 && info.cores <= 6) return 'mid';
    return 'high';
  }

  const forcedLow = envFlag('UTK_LOW_GRAPHICS') || envFlag('UTK_PERFORMANCE_MODE');
  const reduced = prefersReducedMotion();
  const info = hw();
  const tier = classifyTier(info, forcedLow, reduced);
  const lowFx = tier === 'low';
  const midFx = tier === 'mid';

  window.utkPerf = {
    tier: tier,
    lowFx: lowFx,
    midFx: midFx,
    reducedMotion: reduced,
    potato: lowFx,
    forcedLow: forcedLow,
    cores: info.cores,
    mem: info.mem,
    dpr: info.dpr,
    vizFps: lowFx ? 24 : (midFx ? 30 : 42),
    vizBarsMax: lowFx ? 28 : (midFx ? 40 : 56),
    resizeSettleMs: lowFx ? 160 : (midFx ? 130 : 110),
    // Login atmosphere stays on unless hard performance force
    enableMusicViz: !forcedLow
  };

  if (forcedLow) {
    window.utkPerf.enableMusicViz = false;
  }

  window.lowGraphicsMode = !!lowFx;
  window.enableMusicViz = window.utkPerf.enableMusicViz !== false;

  try {
    const root = document.documentElement;
    root.classList.add('utk-smooth');
    root.classList.add('utk-tier-' + tier);
    if (lowFx) root.classList.add('utk-low-fx');
    if (midFx) root.classList.add('utk-mid-fx');
    if (reduced) root.classList.add('utk-reduced-motion');
    root.classList.add('utk-fg');
  } catch (e) {}
})();
