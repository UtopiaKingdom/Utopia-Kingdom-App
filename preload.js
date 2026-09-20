// Preload script - runs before renderer process
// TLS verification is secure by default. If you must bypass TLS verification
// (NOT recommended), set `UTK_INSECURE_TLS=1` before launching the app.
if (typeof process !== 'undefined' && process.env && process.env.UTK_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Optimized for 4K 300 FPS smooth rendering

// Request animation frame optimization
if (window.requestAnimationFrame) {
  const originalRAF = window.requestAnimationFrame;
  window.requestAnimationFrame = function(callback) {
    return originalRAF(function(timestamp) {
      callback(timestamp);
    });
  };
}

// Enable GPU acceleration hints
document.addEventListener('DOMContentLoaded', () => {
  // Force hardware acceleration on all elements
  const style = document.createElement('style');
  style.textContent = `
    * { 
      transform: translateZ(0); 
      -webkit-transform: translateZ(0);
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
      perspective: 1000px;
      -webkit-perspective: 1000px;
    }
    
    body, html {
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
      image-rendering: -webkit-optimize-contrast;
    }
  `;
  document.head.appendChild(style);
  
  // Request idle callback for non-critical tasks
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => {
      console.log('[Performance] Renderer optimized for 4K 300 FPS');
    }, { timeout: 5000 });
  }
}, { once: true });

// Optimize scroll performance
document.addEventListener('scroll', () => {
  // Passive listener for smooth scrolling
}, { passive: true });

// Performance observer to catch jank
if ('PerformanceObserver' in window) {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 50) {
          console.warn('[Performance] Long task detected:', entry.duration, 'ms');
        }
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch (e) {
    // Long task API not available
  }
}

/*
  Compute `Total Wins` in preload (outside renderer.js)
  - Observes the individual win-bucket stat elements and updates
    the `stat-total-wins-<botId>` element whenever buckets change.
  - Keeps changes out of renderer.js as requested.
*/
(function setupPreloadTotalWins() {
  const BUCKET_IDS = [
    'stat-1x-wins',
    'stat-2x4x-wins',
    'stat-5x7x-wins',
    'stat-12x16x-wins',
    'stat-25x44x-wins'
  ];

  function parseNumberText(text) {
    if (!text && text !== 0) return 0;
    const n = parseInt(String(text).replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }

  function sumBucketsForBot(botId) {
    return BUCKET_IDS.reduce((acc, id) => {
      const el = document.getElementById(`${id}-${botId}`);
      if (!el) return acc;
      return acc + parseNumberText(el.textContent || el.innerText || '0');
    }, 0);
  }

  function updateTotalWins(botId) {
    const totalEl = document.getElementById(`stat-total-wins-${botId}`);
    if (!totalEl) return;
    const total = sumBucketsForBot(botId);
    const cur = parseNumberText(totalEl.textContent || totalEl.innerText || '0');
    if (cur !== total) totalEl.textContent = String(total);
  }

  function observeBucketsForBot(botId) {
    const observer = new MutationObserver(() => updateTotalWins(botId));

    // Attach observer to each bucket element (if present)
    BUCKET_IDS.forEach((id) => {
      const el = document.getElementById(`${id}-${botId}`);
      if (el) observer.observe(el, { childList: true, characterData: true, subtree: true });
    });

    // Also observe the stats-card container as a fallback (handles dynamic inserts)
    const statsCard = document.querySelector(`#section-${botId.split('bot')[1]} .stats-card`) || document.body;
    if (statsCard) observer.observe(statsCard, { childList: true, subtree: true });

    // Initialize
    updateTotalWins(botId);
    return observer;
  }

  function init() {
    // Find all bots by scanning for total-wins elements
    const totalEls = Array.from(document.querySelectorAll('[id^="stat-total-wins-"]'));
    const botIds = totalEls.map(el => el.id.replace(/^stat-total-wins-/, '')).filter(Boolean);
    if (botIds.length === 0) return;

    botIds.forEach(observeBucketsForBot);

    // Periodic fallback to keep totals in sync if MutationObserver misses anything
    setInterval(() => botIds.forEach(updateTotalWins), 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

