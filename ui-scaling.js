// scaling logic moved out of renderer.js per user request
// this file handles UI scaling, frozen-layout mode, and related helpers
// it attaches its own DOMContentLoaded listener so requiring it is enough.

document.addEventListener('DOMContentLoaded', () => {
  // Responsive & DPI-aware scaling: compute CSS variables for layout.
  function updateAppScale() {
    try {
      const raw = window.localStorage.getItem('ui:globalScale');
      if (raw === null) {
        try { window.localStorage.setItem('ui:globalScale', '1.0'); } catch (e) {}
      }
      let userMultiplier = 1.0;
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 3) {
        userMultiplier = parsed;
      }

      let authMultiplier = 1.0;
      let onAuth = false;
      try {
        onAuth = !!(document && document.body && document.body.classList && document.body.classList.contains('auth-visible'));
        if (onAuth) {
          const rawAuth = window.localStorage.getItem('ui:authScale');
          let a = parseFloat(rawAuth);
          if (!Number.isFinite(a) || a <= 0 || a > 2.0 || a >= 0.98) {
            a = 0.85;
            try { window.localStorage.setItem('ui:authScale', '0.85'); } catch (eA) {}
          }
          authMultiplier = a;
        }
      } catch (e) {}

      let scale = userMultiplier * authMultiplier;

      if (window.frozenLayout) {
        scale = Math.min(Math.max(scale, 0.6), 1.0);
      } else {
        scale = Math.min(Math.max(scale, 0.5), 3.0);
      }

      const fontScale = Math.min(Math.max(scale, 0.7), 2.6);
      const spacingScale = Math.min(Math.max(scale, 0.7), 2.6);

      // Always write scale on auth toggle — ignore resize paint gate here
      try {
        const style = document.documentElement.style;
        style.setProperty('--scale-factor', String(scale));
        style.setProperty('--font-scale', String(fontScale));
        style.setProperty('--spacing-scale', String(spacingScale));
        style.setProperty('--ui-global-scale', String(userMultiplier));
        style.setProperty('--auth-card-scale', String(authMultiplier));
      } catch (eW) {}

      try {
        document.documentElement.classList.toggle('utk-pre-auth-scale', onAuth);
      } catch (eC) {}

      try { document.body.style.zoom = ''; } catch (e) {}
      try { window.dispatchEvent(new Event('app:scale-changed')); } catch (e) {}
    } catch (e) {
      // ignore
    }
  }

  window.setUiGlobalScale = function(mult) {
    try {
      const n = Number(mult);
      if (!Number.isFinite(n) || n <= 0 || n > 3) return false;
      window.localStorage.setItem('ui:globalScale', String(n));
      updateAppScale();
      try { window.dispatchEvent(new Event('app:resize-finish')); } catch (e) {}
      return true;
    } catch (e) { return false; }
  };
  window.resetUiGlobalScale = function() {
    try { window.localStorage.removeItem('ui:globalScale'); updateAppScale(); try { window.dispatchEvent(new Event('app:resize-finish')); } catch (e) {} } catch (e) {}
  };
  window.setUiAuthScale = function(mult) {
    try {
      const n = Number(mult);
      if (!Number.isFinite(n) || n <= 0 || n > 2) return false;
      window.localStorage.setItem('ui:authScale', String(n));
      updateAppScale();
      try { window.dispatchEvent(new Event('app:resize-finish')); } catch (e) {}
      return true;
    } catch (e) { return false; }
  };
  window.resetUiAuthScale = function() { try { window.localStorage.removeItem('ui:authScale'); updateAppScale(); } catch (e) {} };

  window.frozenLayout = false;
  window.setFrozenLayout = function(enabled) {
    try {
      const on = Boolean(enabled);
      window.frozenLayout = on;
      if (on) {
        document.documentElement.classList.add('fixed-layout');
      } else {
        document.documentElement.classList.remove('fixed-layout');
      }
      window.localStorage.setItem('ui:frozenLayout', on ? '1' : '0');
      updateAppScale();
      return true;
    } catch (e) { return false; }
  };
  try {
    const stored = window.localStorage.getItem('ui:frozenLayout');
    if (stored === '1') {
      window.frozenLayout = true;
      document.documentElement.classList.add('fixed-layout');
    } else if (stored === '0') {
      window.frozenLayout = false;
      document.documentElement.classList.remove('fixed-layout');
    }
  } catch (e) {}

  updateAppScale();

  // Re-apply instantly when login gate opens/closes — no visible shrink/grow mid-frame.
  try {
    const mo = new MutationObserver(function () {
      updateAppScale();
    });
    if (document.body) {
      mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (eMo) {}

  // Single resize path — rAF coalesce + debounce finish (no duplicate listeners).
  (function setupSmoothResize(){
    let resizeTimer = null;
    let rafPending = false;
    let firstResized = false;
    const settleMs = (window.utkPerf && window.utkPerf.resizeSettleMs) || 120;

    function onResizeEvent() {
      if (!firstResized) {
        firstResized = true;
        window.dispatchEvent(new Event('app:resize-start'));
        try { window.__isResizing = true; } catch (e) {}
        try { document.documentElement.classList.add('resizing'); } catch (e) {}
        try {
          if (window.__utkAppPerf && typeof window.__utkAppPerf.beginResize === 'function') {
            window.__utkAppPerf.beginResize();
          }
        } catch (e) {}
      }

      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(function () {
          try { updateAppScale(); } catch (e) {}
          rafPending = false;
        });
      }

      try { document.documentElement.classList.add('resizing'); } catch (e) {}

      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        try { updateAppScale(); } catch (e) {}
        try { document.documentElement.classList.remove('resizing'); } catch (e) {}
        try { window.__isResizing = false; } catch (e) {}
        try {
          if (window.__utkAppPerf && typeof window.__utkAppPerf.endResize === 'function') {
            window.__utkAppPerf.endResize();
          }
        } catch (e) {}
        window.dispatchEvent(new Event('app:resize-finish'));
        firstResized = false;
      }, settleMs);
    }

    window.addEventListener('resize', onResizeEvent, { passive: true });

    if (window.matchMedia) {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      try { mq.addEventListener('change', onResizeEvent); } catch (e) { try { mq.addListener(onResizeEvent); } catch (ee) {} }
    }
  })();

  window.__updateAppScale = updateAppScale;
  window.lowPowerResizeMode = false;
  window.toggleLowPowerResizeMode = function(v) {
    window.lowPowerResizeMode = (typeof v === 'boolean') ? v : !window.lowPowerResizeMode;
  };
});
