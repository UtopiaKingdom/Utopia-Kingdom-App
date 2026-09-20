// isolate zoom buttons and shortcuts in their own file
// this ensures the handlers run regardless of when renderer.js executes

(function() {
  // the UI scale is controlled via localStorage and ui-scaling.js helpers
  // delta is additive (e.g. 0.1 or -0.1). ensure bounds match updateAppScale.
  function changeZoom(delta) {
    try {
      // read current multiplier; default to 1.0
      let cur = parseFloat(window.localStorage.getItem('ui:globalScale'));
      if (!Number.isFinite(cur)) cur = 1.0;
      const next = Math.min(Math.max(cur + delta, 0.5), 3.0);
      window.setUiGlobalScale(next);
      console.log('[zoom-controls] changed scale', cur, '→', next);
    } catch (e) {
      console.warn('[zoom-controls] changeZoom failed', e);
    }
  }

  function init() {
    console.log('[zoom-controls] init');
    // remove any stray overlay element left over from previous runs
    const old = document.getElementById('size-debug-overlay');
    if (old) old.remove();
    // also drop any element with debug-style "w=..." text
    document.querySelectorAll('div,span').forEach(el => {
      if (el.textContent && /^w=\d+/.test(el.textContent.trim())) {
        el.remove();
      }
    });
    // resolution selector removed; window size is fixed at 40% of monitor.
    // const resSelect = document.getElementById('res-select');
    // (no longer needed)

    // attach click handlers via delegated listener so clicks work even inside
    // draggable titlebar areas or when elements are inserted later.
    document.addEventListener('click', (ev) => {
      try {
        const btn = ev.target && ev.target.closest && ev.target.closest('.zoom-btn, #zoom-minus, #zoom-plus');
        if (!btn) return;
        // ensure mouse events are allowed
        if (getComputedStyle(btn).pointerEvents === 'none') return;
        if (btn.id === 'zoom-minus' || (btn.classList && btn.classList.contains('zoom-btn') && btn.textContent && btn.textContent.trim() === '-')) {
          console.log('[zoom-controls] delegated click: minus');
          changeZoom(-0.1);
          ev.preventDefault();
          ev.stopPropagation();
        } else if (btn.id === 'zoom-plus' || (btn.classList && btn.classList.contains('zoom-btn') && btn.textContent && btn.textContent.trim() === '+')) {
          console.log('[zoom-controls] delegated click: plus');
          changeZoom(0.1);
          ev.preventDefault();
          ev.stopPropagation();
        }
      } catch (e) { console.warn('[zoom-controls] delegated click error', e); }
    }, true);

    // Also attach explicit handlers directly to the buttons to be extra reliable
    const minus = document.getElementById('zoom-minus');
    const plus = document.getElementById('zoom-plus');
    try {
      if (minus) {
        minus.style.pointerEvents = 'auto';
        minus.addEventListener('click', (ev) => { console.log('[zoom-controls] direct click: minus'); changeZoom(-0.1); ev.preventDefault(); ev.stopPropagation(); });
      }
      if (plus) {
        plus.style.pointerEvents = 'auto';
        plus.addEventListener('click', (ev) => { console.log('[zoom-controls] direct click: plus'); changeZoom(0.1); ev.preventDefault(); ev.stopPropagation(); });
      }
    } catch (e) { console.warn('[zoom-controls] direct attach failed', e); }

    // keep keyboard shortcuts too
    window.addEventListener('keydown', e => {
      try {
        if (e.ctrlKey || e.metaKey) {
          if (e.key === '-' || e.key === '_') {
            console.log('[zoom-controls] keyboard: minus');
            changeZoom(-0.1);
            e.preventDefault();
          } else if (e.key === '+' || e.key === '=' ) {
            console.log('[zoom-controls] keyboard: plus');
            changeZoom(0.1);
            e.preventDefault();
          }
        }
      } catch (e) { console.warn('[zoom-controls] keydown handler error', e); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // expose minimal API for other scripts or debugging
  try { window.zoomControls = { changeZoom }; } catch (e) {}
})();

/* Debug helper: create a small visible pill in titlebar-left that shows
   current scale and last event. Click the pill to cycle scale for testing.
   This helps when DevTools isn't convenient. */
(function() {
  try {
    function refresh() {
      const val = window.localStorage.getItem('ui:globalScale') || '1.0';
      const pill = document.getElementById('zoom-debug-pill');
      if (pill) pill.textContent = 'Scale: ' + parseFloat(val).toFixed(2);
    }
    function make() {
      const left = document.querySelector('.titlebar-left');
      if (!left) return;
      if (document.getElementById('zoom-debug-pill')) return;
      const p = document.createElement('button');
      p.id = 'zoom-debug-pill';
      p.className = 'zoom-btn';
      p.style.marginLeft = '8px';
      p.title = 'Debug: shows current UI scale. Click to increment.';
      p.addEventListener('click', (e) => {
        try {
          let cur = parseFloat(window.localStorage.getItem('ui:globalScale'));
          if (!Number.isFinite(cur)) cur = 1.0;
          const next = Math.min(Math.max(cur + 0.1, 0.5), 3.0);
          window.setUiGlobalScale(next);
          console.log('[zoom-controls][debug] pill click', cur, '→', next);
          refresh();
        } catch (err) { console.warn(err); }
      });
      left.appendChild(p);
      refresh();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', make);
    else make();
    // update when scale changes
    window.addEventListener('app:scale-changed', refresh);
  } catch (e) { /* ignore */ }
})();
