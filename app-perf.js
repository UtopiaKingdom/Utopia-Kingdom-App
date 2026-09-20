/**
 * app-perf.js — App-wide smoothness: resize freeze, paint gates, idle budget.
 * Load early (after perf-boot). Does not touch trading / WS critical paths.
 */
(function () {
  'use strict';

  if (window.__utkAppPerf) return;

  const perf = window.utkPerf || (window.utkPerf = {});
  const root = document.documentElement;

  let resizing = false;
  let lastScaleWrite = 0;
  let autoClearTimer = null;
  const AUTO_CLEAR_MS = 220;

  function isHidden() {
    try {
      return !!(document.hidden || document.visibilityState === 'hidden');
    } catch (e) {
      return false;
    }
  }

  function isResizing() {
    return resizing || !!window.__isResizing || (root && root.classList.contains('resizing'));
  }

  function clearAutoClear() {
    if (autoClearTimer) {
      clearTimeout(autoClearTimer);
      autoClearTimer = null;
    }
  }

  function markResizing(on) {
    resizing = !!on;
    try { window.__isResizing = resizing; } catch (e) {}
    try {
      if (resizing) {
        root.classList.add('resizing');
        if (document.body) document.body.classList.add('app-resizing');
      } else {
        root.classList.remove('resizing');
        if (document.body) document.body.classList.remove('app-resizing');
      }
    } catch (e) {}
  }

  function beginResize() {
    markResizing(true);
    // Always auto-clear — maximize / will-move call begin without a matching
    // window resize finish, and a stuck .resizing class freezes pane animations
    // at opacity:0 (black Studio, broken theme menu / confirm buttons).
    clearAutoClear();
    autoClearTimer = setTimeout(function () {
      autoClearTimer = null;
      endResize();
    }, (perf && perf.resizeSettleMs) || AUTO_CLEAR_MS);
  }

  function endResize() {
    clearAutoClear();
    markResizing(false);
    // Critical: prepare-resize / will-move call beginResize without a matching
    // window "resize" event. Signal renders defer while .resizing is set and
    // only flush on app:resize-finish — so we must emit it here or cards vanish
    // while notifications still fire.
    try {
      window.dispatchEvent(new Event('app:resize-finish'));
    } catch (e) {}
  }

  /** Soft gate for decorative / secondary UI paints. Trading paths ignore this. */
  function shouldPaint(kind) {
    if (isResizing()) return false;
    if (isHidden() && kind !== 'critical') return false;
    if (perf.lowFx && kind === 'fx') return false;
    return true;
  }

  function scheduleIdle(fn, timeout) {
    try {
      if (typeof requestIdleCallback === 'function') {
        return requestIdleCallback(fn, { timeout: timeout || 800 });
      }
    } catch (e) {}
    return setTimeout(fn, 48);
  }

  function writeScaleVars(vars) {
    const t = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (isResizing() && t - lastScaleWrite < 32) return false;
    lastScaleWrite = t;
    try {
      const style = root.style;
      if (vars['--scale-factor'] != null) style.setProperty('--scale-factor', String(vars['--scale-factor']));
      if (vars['--font-scale'] != null) style.setProperty('--font-scale', String(vars['--font-scale']));
      if (vars['--spacing-scale'] != null) style.setProperty('--spacing-scale', String(vars['--spacing-scale']));
      if (vars['--ui-global-scale'] != null) style.setProperty('--ui-global-scale', String(vars['--ui-global-scale']));
      return true;
    } catch (e) {
      return false;
    }
  }

  function tagInactiveSections() {
    try {
      const sections = document.querySelectorAll('.section');
      for (let i = 0; i < sections.length; i++) {
        const el = sections[i];
        // Never leave idle/skip-paint on the active section.
        if (el.classList.contains('active')) el.classList.remove('utk-section-idle');
        else el.classList.add('utk-section-idle');
      }
    } catch (e) {}
  }

  document.addEventListener('visibilitychange', function () {
    try {
      root.classList.toggle('utk-bg-idle', isHidden());
      root.classList.toggle('utk-fg', !isHidden());
      if (!isHidden()) {
        // Coming back to foreground — never keep a stale resize freeze.
        endResize();
        tagInactiveSections();
      }
    } catch (e) {}
  });

  window.addEventListener('app:resize-finish', function () {
    endResize();
    scheduleIdle(tagInactiveSections, 300);
  });

  function arm() {
    tagInactiveSections();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', arm);
  } else {
    arm();
  }

  window.__utkAppPerf = {
    beginResize: beginResize,
    endResize: endResize,
    isResizing: isResizing,
    isHidden: isHidden,
    shouldPaint: shouldPaint,
    scheduleIdle: scheduleIdle,
    writeScaleVars: writeScaleVars,
    tagInactiveSections: tagInactiveSections
  };

  try { module.exports = window.__utkAppPerf; } catch (_) {}
})();
