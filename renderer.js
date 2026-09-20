// Wire up the new Subscribe button to show the subscription overlay
document.addEventListener('DOMContentLoaded', () => {
  const openSubBtn = document.getElementById('openSubscriptionBtn');
  if (openSubBtn) {
    openSubBtn.addEventListener('click', () => {
      if (typeof showSubscriptionOverlay === 'function') {
        showSubscriptionOverlay();
      } else if (window.showSubscriptionOverlay) {
        window.showSubscriptionOverlay();
      }
    });
  }

  // Home page buttons + dynamic labels
  try {
    const homeWelcomeName = document.getElementById('homeWelcomeName');
    const sidebarUsername = document.getElementById('sidebarUsername');
    if (homeWelcomeName && sidebarUsername) {
      homeWelcomeName.textContent = sidebarUsername.textContent || 'Trader';
      // keep in sync if auth updates username later
      try {
        const obs = new MutationObserver(() => {
          homeWelcomeName.textContent = sidebarUsername.textContent || 'Trader';
        });
        obs.observe(sidebarUsername, { childList: true, subtree: true, characterData: true });
      } catch (e) {}
    }

    const homeSubscriptionStatus = document.getElementById('homeSubscriptionStatus');
    const subscriptionPill = document.getElementById('subscriptionPill');
    if (homeSubscriptionStatus && subscriptionPill) {
      homeSubscriptionStatus.textContent = subscriptionPill.textContent || '—';
      try {
        const obs2 = new MutationObserver(() => {
          homeSubscriptionStatus.textContent = subscriptionPill.textContent || '—';
        });
        obs2.observe(subscriptionPill, { childList: true, subtree: true, characterData: true });
      } catch (e) {}
    }

    const homeAccessText = document.getElementById('homeAccessText');
    const homeTrialCountdown = document.getElementById('homeTrialCountdown');
    const trialCountdownText = document.getElementById('trialCountdownText');
    const homeAccessBtn = document.getElementById('homeAccessBtn');

    // Home: Release notes (kept factual / based on changes in this build)
    try {
      const releaseList = document.getElementById('homeReleaseNotes');
      if (releaseList) {
        const items = [
          { tag: 'Fix', text: 'Resolved Subscribe → Cancel flow getting stuck after closing the payment window.' },
          { tag: 'UI', text: 'Subscription overlay resized for better readability on smaller windows.' },
          { tag: 'Home', text: 'Home redesigned into a clean hub with Market Pulse and release notes.' },
        ];

        releaseList.innerHTML = '';
        for (const item of items) {
          const li = document.createElement('li');
          li.innerHTML = `<span class="home-update-tag">${item.tag}</span><span>${item.text}</span>`;
          releaseList.appendChild(li);
        }
      }
    } catch (e) {}

    // Market Pulse (real data) - safe fallback if offline
    try {
      const elMarketCap = document.getElementById('homeMarketCap');
      const elMarketVolume = document.getElementById('homeMarketVolume');
      const elActiveCryptos = document.getElementById('homeActiveCryptos');
      const elBtcDomLine = document.getElementById('homeBtcDominanceLine');
      const elBtcPrice = document.getElementById('homeBtcPrice');
      const elBtcChange = document.getElementById('homeBtcChange');
      const elEthPrice = document.getElementById('homeEthPrice');
      const elEthChange = document.getElementById('homeEthChange');
      const elUpdated = document.getElementById('homeMarketLastUpdated');
      const elNote = document.getElementById('homeMarketNote');

      const fmtUsdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
      const fmtUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
      const fmtPct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 });

      function setChange(el, value) {
        if (!el) return;
        const n = Number(value);
        if (!Number.isFinite(n)) {
          el.textContent = '';
          el.classList.remove('positive', 'negative');
          return;
        }
        el.textContent = `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
        el.classList.toggle('positive', n > 0);
        el.classList.toggle('negative', n < 0);
      }

      // CoinGecko is frequently rate-limited (429) on shared IPs.
      // Keep a single poller, cache responses, and back off on 429.
      const MARKET_PULSE_INTERVAL_MS = 1000 * 60; // UI refresh cadence
      const GLOBAL_TTL_MS = 1000 * 60 * 10;       // global stats rarely change
      const PRICE_TTL_MS = 1000 * 60 * 2;         // keep this modest to avoid 429
      const marketPulseState = (window.__utkMarketPulseState ||= {
        inFlight: false,
        backoffUntil: 0,
        last429At: 0,
        global: { ts: 0, data: null },
        price: { ts: 0, data: null },
      });

      async function loadMarketPulse() {
        // Only run if the card exists on the current Home layout
        if (!elMarketCap && !elBtcPrice) return;

        // Avoid piling up concurrent requests.
        if (marketPulseState.inFlight) return;

        const nowMs = Date.now();
        // If we got rate-limited, pause requests for a bit.
        if (nowMs < marketPulseState.backoffUntil) {
          if (elNote) {
            elNote.style.display = 'block';
            elNote.textContent = 'Market data paused (rate-limited).';
          }
          return;
        }

        if (elNote) {
          elNote.style.display = 'none';
          elNote.textContent = '';
        }

        // Placeholders
        if (elMarketCap) elMarketCap.textContent = '—';
        if (elMarketVolume) elMarketVolume.textContent = '—';
        if (elActiveCryptos) elActiveCryptos.textContent = '—';
        if (elBtcDomLine) elBtcDomLine.textContent = '—';
        if (elBtcPrice) elBtcPrice.textContent = '—';
        if (elEthPrice) elEthPrice.textContent = '—';
        setChange(elBtcChange, NaN);
        setChange(elEthChange, NaN);

        try {
          marketPulseState.inFlight = true;

          const needGlobal = !marketPulseState.global.data || (nowMs - marketPulseState.global.ts > GLOBAL_TTL_MS);
          const needPrice = !marketPulseState.price.data || (nowMs - marketPulseState.price.ts > PRICE_TTL_MS);

          const globalPromise = needGlobal
            ? fetch('https://api.coingecko.com/api/v3/global')
            : Promise.resolve(null);
          const pricePromise = needPrice
            ? fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true')
            : Promise.resolve(null);

          const [globalRes, priceRes] = await Promise.all([globalPromise, pricePromise]);

          if (globalRes) {
            if (globalRes.status === 429) {
              marketPulseState.last429At = nowMs;
              marketPulseState.backoffUntil = nowMs + 1000 * 60 * 5;
              throw new Error('rate_limited');
            }
            if (!globalRes.ok) throw new Error('Market data request failed');
            marketPulseState.global.data = await globalRes.json();
            marketPulseState.global.ts = nowMs;
          }

          if (priceRes) {
            if (priceRes.status === 429) {
              marketPulseState.last429At = nowMs;
              marketPulseState.backoffUntil = nowMs + 1000 * 60 * 5;
              throw new Error('rate_limited');
            }
            if (!priceRes.ok) throw new Error('Market data request failed');
            marketPulseState.price.data = await priceRes.json();
            marketPulseState.price.ts = nowMs;
          }

          const globalJson = marketPulseState.global.data;
          const priceJson = marketPulseState.price.data;

          if (!globalJson || !priceJson) throw new Error('Market data request failed');

          const marketCapUsd = globalJson?.data?.total_market_cap?.usd;
          const marketVolUsd = globalJson?.data?.total_volume?.usd;
          const btcDomPct = globalJson?.data?.market_cap_percentage?.btc;
          const activeCryptos = globalJson?.data?.active_cryptocurrencies;
          const btcUsd = priceJson?.bitcoin?.usd;
          const btcCh = priceJson?.bitcoin?.usd_24h_change;
          const ethUsd = priceJson?.ethereum?.usd;
          const ethCh = priceJson?.ethereum?.usd_24h_change;

          if (elMarketCap && Number.isFinite(marketCapUsd)) elMarketCap.textContent = fmtUsdCompact.format(marketCapUsd);
          if (elMarketVolume && Number.isFinite(marketVolUsd)) elMarketVolume.textContent = fmtUsdCompact.format(marketVolUsd);
          if (elActiveCryptos && Number.isFinite(activeCryptos)) elActiveCryptos.textContent = new Intl.NumberFormat('en-US').format(activeCryptos);
          if (elBtcDomLine && Number.isFinite(btcDomPct)) elBtcDomLine.textContent = fmtPct.format(btcDomPct / 100);

          if (elBtcPrice && Number.isFinite(btcUsd)) elBtcPrice.textContent = fmtUsd.format(btcUsd);
          if (elEthPrice && Number.isFinite(ethUsd)) elEthPrice.textContent = fmtUsd.format(ethUsd);
          setChange(elBtcChange, btcCh);
          setChange(elEthChange, ethCh);

          if (elUpdated) {
            const now = new Date();
            elUpdated.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          }
        } catch (err) {
          if (elNote) {
            elNote.style.display = 'block';
            elNote.textContent = (err && err.message === 'rate_limited')
              ? 'Market data paused (rate-limited).'
              : 'Market data unavailable (offline or rate-limited).';
          }
          if (elUpdated) elUpdated.textContent = '—';
        } finally {
          marketPulseState.inFlight = false;
        }
      }

      loadMarketPulse();
      // Prevent duplicate intervals if renderer logic re-runs.
      try {
        if (window.__utkMarketPulseTimer) clearInterval(window.__utkMarketPulseTimer);
      } catch (e) {}
      window.__utkMarketPulseTimer = setInterval(loadMarketPulse, MARKET_PULSE_INTERVAL_MS);
    } catch (e) {}

    // Mirror update status text into Home (so Home feels like a hub)
    try {
      const homeUpdateStatus = document.getElementById('homeUpdateStatus');
      const updateStatus = document.getElementById('updateStatus');
      if (homeUpdateStatus && updateStatus) {
        const syncUpdateText = () => {
          const visible = updateStatus.style.display !== 'none' && (updateStatus.textContent || '').trim().length > 0;
          if (!visible) {
            homeUpdateStatus.style.display = 'none';
            homeUpdateStatus.textContent = '';
            homeUpdateStatus.style.color = '';
            return;
          }
          homeUpdateStatus.style.display = 'block';
          homeUpdateStatus.textContent = updateStatus.textContent;
          homeUpdateStatus.style.color = updateStatus.style.color || '';
        };
        syncUpdateText();
        const obsUpdate = new MutationObserver(() => syncUpdateText());
        obsUpdate.observe(updateStatus, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style'] });
      }
    } catch (e) {}

    function refreshHomeAccess() {
      try {
        const status = (subscriptionPill && subscriptionPill.textContent) ? subscriptionPill.textContent.trim() : '';
        const trialText = (trialCountdownText && trialCountdownText.textContent) ? trialCountdownText.textContent.trim() : '';

        if (homeTrialCountdown) {
          if (trialText) {
            homeTrialCountdown.style.display = '';
            homeTrialCountdown.textContent = `Trial: ${trialText}`;
          } else {
            homeTrialCountdown.style.display = 'none';
            homeTrialCountdown.textContent = '';
          }
        }

        if (homeAccessText) {
          if (/subscribed/i.test(status)) {
            homeAccessText.textContent = 'Subscription active. You have full access.';
          } else if (/trial used|subscription ended/i.test(status)) {
            homeAccessText.textContent = 'Trial ended. Subscribe to unlock premium features.';
          } else if (/free trial/i.test(status)) {
            homeAccessText.textContent = 'Free trial active. You’ll be prompted to subscribe when it ends.';
          } else {
            homeAccessText.textContent = 'Checking subscription…';
          }
        }

        if (homeAccessBtn) {
          if (/trial used|subscription ended/i.test(status)) {
            homeAccessBtn.textContent = 'Subscribe Now';
          } else {
            homeAccessBtn.textContent = 'Manage Subscription';
          }
        }
      } catch (e) {}
    }

    refreshHomeAccess();
    try {
      if (subscriptionPill) {
        const obs3 = new MutationObserver(() => refreshHomeAccess());
        obs3.observe(subscriptionPill, { childList: true, subtree: true, characterData: true });
      }
      if (trialCountdownText) {
        const obs4 = new MutationObserver(() => refreshHomeAccess());
        obs4.observe(trialCountdownText, { childList: true, subtree: true, characterData: true });
      }
    } catch (e) {}

    document.getElementById('homeGoProfile')?.addEventListener('click', () => navigateToSection('profile'));
    document.getElementById('homeAccessBtn')?.addEventListener('click', () => {
      if (typeof showSubscriptionOverlay === 'function') {
        showSubscriptionOverlay();
      } else if (window.showSubscriptionOverlay) {
        window.showSubscriptionOverlay();
      }
    });
    document.getElementById('homeCheckUpdates')?.addEventListener('click', () => {
      // Reuse the Profile screen's update button if available
      document.getElementById('checkUpdatesBtn')?.click();
    });
  } catch (e) {}

  // Responsive & DPI-aware scaling: compute CSS variables for layout
  function updateAppScale() {
    try {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(window.innerWidth, 320);
      const h = Math.max(window.innerHeight, 240);
      // Size scale relative to our base design (1280x720)
      const sizeScale = Math.min(Math.max(Math.min(w / 1280, h / 720), 0.7), 2.2);
      // Combine DPR and size scale, clamp to reasonable bounds
      let scale = Math.min(Math.max(dpr * sizeScale, 0.75), 2.5);
      // Derive font/spacing scales (slightly less aggressive than element scale)
      const fontScale = Math.min(Math.max(scale * 0.95, 0.8), 1.8);
      const spacingScale = Math.min(Math.max(scale * 0.98, 0.8), 1.8);

      // If active resizing, only apply a visual-only scale that uses CSS transform
      const isResizing = (typeof document !== 'undefined' && document.documentElement && document.documentElement.classList.contains('resizing')) || !!window.__isResizing || !!window.lowPowerResizeMode;
      if (isResizing) {
        // Visual-only scale applied via transform to avoid layout/reflow during drag
        document.documentElement.style.setProperty('--visual-scale', String(scale));
        // Do NOT change font-size or other layout CSS while resizing
      } else {
        // Normal mode: apply actual layout CSS variables
        document.documentElement.style.setProperty('--scale-factor', String(scale));
        document.documentElement.style.setProperty('--font-scale', String(fontScale));
        document.documentElement.style.setProperty('--spacing-scale', String(spacingScale));

        // Also set a CSS zoom fallback for small/legacy places that don't use vars
        try { document.body.style.zoom = String(scale); } catch (e) {}
        // Clear visual-scale in case it was set earlier
        try { document.documentElement.style.setProperty('--visual-scale', '1'); } catch (e) {}
      }
    } catch (e) {
      // ignore
    }
  }

  updateAppScale();

  // Smooth resize handling for responsive feel and minimal jank:
  (function setupSmoothResize(){
    let resizeTimer = null;
    let rafPending = false;
    let firstResized = false;

    function onResizeEvent() {
      if (!firstResized) {
        firstResized = true;
        // mark start; consumers can react (e.g., pause animations)
        window.dispatchEvent(new Event('app:resize-start'));
        try { window.__isResizing = true; } catch (e) {}
      }

      // Quick, rAF-driven light update to CSS variables for responsive scaling
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => { try { updateAppScale(); } catch (e) {} rafPending = false; });
      }

      // Add 'resizing' class to disable transitions during active resize
      try { document.documentElement.classList.add('resizing'); } catch (e) {}

      // Debounce final resize work
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { updateAppScale(); } catch (e) {}
        try { document.documentElement.classList.remove('resizing'); } catch (e) {}
        try { window.__isResizing = false; } catch (e) {}
        window.dispatchEvent(new Event('app:resize-finish'));
        firstResized = false;
      }, 160);
    }

    window.addEventListener('resize', onResizeEvent, { passive: true });

    // Listen for DPR changes and treat them like a resize
    if (window.matchMedia) {
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      try { mq.addEventListener('change', onResizeEvent); } catch (e) { try { mq.addListener(onResizeEvent); } catch (ee) {} }
    }
  })();

  // Expose for debugging
  window.__updateAppScale = updateAppScale;
  // Low-power resize mode (manual toggle for testing / low-end devices)
  window.lowPowerResizeMode = false;
  window.toggleLowPowerResizeMode = function(v) { window.lowPowerResizeMode = (typeof v === 'boolean') ? v : !window.lowPowerResizeMode; };
});
// console.log('renderer.js loaded'); // Production: disabled
require('./themeswitch.js');
require('./auth-verification.js');
require('./bot-manager.js');
require('./connection-system.js');

// Import Firebase for trading history
const { auth, db } = require('./auth-verification.js');
const { collection, query, orderBy, limit, onSnapshot, doc, setDoc, getDoc, updateDoc, deleteDoc, where, runTransaction } = require('firebase/firestore');

// Auto-update checker
const { checkForUpdates, showUpdateModal } = require('./update-checker.js');

// Check for updates when app loads (after auth completes)
async function initializeUpdateChecker() {
  // Wait a bit for app to be fully loaded
  setTimeout(async () => {
    const updateInfo = await checkForUpdates();
    if (updateInfo) {
      showUpdateModal(updateInfo);
    }
  }, 2000);
}

// Music Visualizer - 3D Smooth Wave Animation
class MusicVisualizer {
  constructor() {
    this.canvas = document.getElementById('musicVisualizer');
    if (!this.canvas) return;
    
    this.ctx = this.canvas.getContext('2d');
    this.animationId = null;
    this.bars = 50;
    this.smoothedData = new Array(50).fill(0);
    this.time = 0;
    this.wavePhases = new Array(50).fill(0);
    this.speedFactor = 1;
    this.speedTimer = 0;

    // Theme-aware base color (from CSS variable --viz-base-rgb)
    this.baseColor = this.getBaseVizColor();
    this.currentColor = [...this.baseColor];
    this.targetColor = [...this.baseColor];
    this.observeThemeChanges();
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
    
    this.resizeCanvas();

    // Do not resize canvas on every window resize event (expensive); instead pause animation while resizing and do full refresh when finished
    this._isResizing = false;
    window.addEventListener('app:resize-start', () => { try { this._isResizing = true; this.stopAnimation(); } catch (e) {} });
    window.addEventListener('app:resize-finish', () => { try { this._isResizing = false; this.resizeCanvas(); this.refresh(); this.startAnimation(); } catch (e) {} });

    this.startAnimation();
        // Expose for external refresh (e.g., after logout showing auth screen again)
        window.musicVisualizer = this;
  }
  
  resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
      this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
      // Render in CSS pixels with high-DPI backing store
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.imageSmoothingEnabled = true;
  }
  
  startAnimation() {
    if (this.animationId) return; // already running
    this.draw();
  }

  stopAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  refresh() {
    if (!this.canvas) return;
    this.resizeCanvas();
    this.smoothedData.fill(0);
    this.time = 0;
    this.wavePhases = new Array(this.bars).fill(0);
    this.targetColor = this.getBaseVizColor();
    // ensure animation continues
    if (!this.animationId) {
      this.startAnimation();
    }
  }
  
  draw = () => {
    const { ctx, canvas } = this;
      // Keep DPR in sync (handles zoom changes)
      const currentDpr = Math.max(1, window.devicePixelRatio || 1);
      if (currentDpr !== this.dpr) {
        this.dpr = currentDpr;
        this.resizeCanvas();
      }
    
    // Ultra-clean dark background
      ctx.fillStyle = 'rgba(10, 10, 20, 0.06)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Smoothly interpolate visualizer base color toward theme target
    this.updateColorLerp();

    this.updateRandomWaves();
    this.drawBars();
    
    // Schedule next frame (animation runs when not paused by resize logic)
    this.animationId = requestAnimationFrame(this.draw);
  }
  
  updateRandomWaves() {
    // Dynamic speed changes
    this.speedTimer += 0.001;
    const speedWave = Math.sin(this.speedTimer * 0.5) * 0.4 + 0.6;
    this.speedFactor = 0.4 + speedWave * 0.6;
    
    this.time += 0.015 * this.speedFactor;
    
    for (let i = 0; i < this.bars; i++) {
      // Smooth wave movement
      const wave = Math.sin((this.time + i * 0.12) * 2 + this.wavePhases[i]) * 0.4 + 0.4;
      const drift = Math.sin(this.time * 0.5 + i * 0.2) * 0.18 + 0.22;
      
      // Size variation - each bar has different amplitude
      const sizeVariation = Math.sin(i * 13.7) * 0.25 + 0.75; // Range: ~0.5 to 1.0
      
      const combined = (wave * 0.7 + drift * 0.3) * sizeVariation;
      
      // Heavy smoothing for butter-smooth motion
      this.smoothedData[i] = this.smoothedData[i] * 0.95 + combined * 0.05;
      
      // Reduce random jitter to avoid "fuzzy" motion on large screens
      this.wavePhases[i] += (Math.sin(this.time * 0.08 + i * 0.13) + 1) * 0.002;
    }
  }
  
  drawBars() {
    const { ctx, canvas } = this;
    const rect = this.canvas.getBoundingClientRect();
    const barWidth = rect.width / this.bars;
    const centerY = rect.height / 2;
    const maxHeight = canvas.height * 0.25; // Much smaller (was 0.5)
    const radius = barWidth * 0.15;
    const [baseR, baseG, baseB] = this.currentColor;
    
    for (let i = 0; i < this.bars; i++) {
      const x = i * barWidth;
      const height = Math.pow(this.smoothedData[i], 0.7) * maxHeight;
      
      // Very subtle, low opacity
      const intensity = 0.2 + this.smoothedData[i] * 0.3; // Lower range
      const glowIntensity = intensity * 0.3; // Much dimmer
      const r = Math.min(255, Math.round(baseR + intensity * 30));
      const g = Math.min(255, Math.round(baseG + intensity * 30));
      const b = Math.min(255, Math.round(baseB + intensity * 30));
      
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${glowIntensity * 0.5})`;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.12)`;
      ctx.shadowBlur = 2;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      
      const barThickness = barWidth * 0.55;
      const startX = x + (barWidth - barThickness) / 2;
      
      // Draw rounded top wave
      this.roundRect(ctx, startX, centerY - height, barThickness, height, [radius, radius, 0, 0]);
      ctx.fill();
      
      // Draw rounded bottom wave
      this.roundRect(ctx, startX, centerY, barThickness, height, [0, 0, radius, radius]);
      ctx.fill();
    }
    
    ctx.shadowBlur = 0;
  }
  
  // Helper to draw rounded rectangles
  roundRect(ctx, x, y, width, height, radii = 0) {
    if (typeof radii === 'number') {
      radii = [radii, radii, radii, radii];
    }
    
    ctx.beginPath();
    ctx.moveTo(x + radii[0], y);
    ctx.lineTo(x + width - radii[1], y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radii[1]);
    ctx.lineTo(x + width, y + height - radii[2]);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radii[2], y + height);
    ctx.lineTo(x + radii[3], y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radii[3]);
    ctx.lineTo(x, y + radii[0]);
    ctx.quadraticCurveTo(x, y, x + radii[0], y);
    ctx.closePath();
  }

  // Read CSS variable --viz-base-rgb and parse into [r, g, b]
  getBaseVizColor() {
    const styles = getComputedStyle(document.body);
    const raw = styles.getPropertyValue('--viz-base-rgb') || '0, 180, 255';
    const parts = raw.split(',').map(v => parseInt(v, 10));
    if (parts.length === 3 && parts.every(n => Number.isFinite(n))) {
      return parts;
    }
    return [0, 180, 255];
  }

  // Observe theme class changes to refresh the base color
  observeThemeChanges() {
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          this.targetColor = this.getBaseVizColor();
          break;
        }
      }
    });
    observer.observe(document.body, { attributes: true });
  }

  // Lerp currentColor toward targetColor for smooth theme transitions
  updateColorLerp() {
    const lerpFactor = 0.045; // slower for smoother transition
    for (let i = 0; i < 3; i++) {
      const diff = this.targetColor[i] - this.currentColor[i];
      if (Math.abs(diff) < 0.5) {
        this.currentColor[i] = this.targetColor[i];
      } else {
        this.currentColor[i] += diff * lerpFactor;
      }
    }
  }
}

// Initialize visualizer when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new MusicVisualizer();
  });
} else {
  new MusicVisualizer();
}

// --- IPC for updates ---
const { ipcRenderer } = require('electron');

const menuItems = document.querySelectorAll('.menu-item, .sub-menu-item');
const userCard = document.getElementById('userProfileCard');
const strategiesMenu = document.getElementById('menu-strategies');

function initHeroLogoSpin() {
  const logo = document.querySelector('.hero-logo-large');
  if (!logo) return;

  const spin = () => {
    logo.classList.remove('coin-spin');
    // Force reflow so repeated clicks retrigger the animation
    void logo.offsetWidth;
    logo.classList.add('coin-spin');
  };

  logo.setAttribute('tabindex', '0');
  logo.setAttribute('role', 'button');
  logo.setAttribute('aria-label', 'Spin logo');

  logo.addEventListener('click', spin);
  logo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      spin();
    }
  });

  logo.addEventListener('animationend', () => {
    logo.classList.remove('coin-spin');
  });
}

// Global app fade-in: ensure body becomes visible even if DOMContentLoaded already fired
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('app-loaded');
    initHeroLogoSpin();
    initializeUpdateChecker();
  });
} else {
  document.body.classList.add('app-loaded');
  initHeroLogoSpin();
  initializeUpdateChecker();
}

function navigateToSection(id, activeMenuItem = null) {
  const target = document.getElementById(`section-${id}`);
  if (!target) return;

  menuItems.forEach(i => i.classList.remove('active'));
  if (activeMenuItem) activeMenuItem.classList.add('active');

  if (userCard) {
    if (id === 'profile') userCard.classList.add('active');
    else userCard.classList.remove('active');
  }

  const current = document.querySelector('.section.active');
  if (current && current !== target) {
    current.classList.add('leaving');
    current.addEventListener('animationend', () => {
      current.classList.remove('leaving', 'active');
      if (target) {
        target.classList.add('active', 'entering');
        target.addEventListener('animationend', () => {
          target.classList.remove('entering');
        }, { once: true });
      }
    }, { once: true });
  } else if (target && !target.classList.contains('active')) {
    target.classList.add('active', 'entering');
    target.addEventListener('animationend', () => {
      target.classList.remove('entering');
    }, { once: true });
  }

  const scroller = document.querySelector('.main-content');
  if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
}

menuItems.forEach(item => {
  item.addEventListener('click', function(e) {
    if (item.classList.contains('locked')) {
      e.preventDefault();
      return;
    }
    const id = item.id.replace('menu-', '');
    navigateToSection(id, item);
  });
});

if (userCard) {
  const openProfile = () => navigateToSection('profile');
  userCard.addEventListener('click', e => {
    e.preventDefault();
    openProfile();
  });
  userCard.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openProfile();
    }
  });
}

// Logout handled in auth.js via Firebase signOut

// --- Strategy Card Navigation ---
document.querySelectorAll('.strategy-card').forEach(card => {
  card.addEventListener('click', function(e) {
    e.preventDefault();
    const strategyId = this.getAttribute('data-strategy');
    navigateToSection(strategyId, strategiesMenu);
  });
});

// --- Strategy Back Buttons ---
document.querySelectorAll('.strategy-back').forEach(btn => {
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    const backTo = this.getAttribute('data-back');
    navigateToSection(backTo, strategiesMenu);
  });
});

// --- Window Controls (Electron direct ipcRenderer) ---
document.querySelector('.window-min')?.addEventListener('click', () => {
  // Micro tap animation before minimize
  document.body.classList.add('app-tap');
  setTimeout(() => {
    ipcRenderer.send('window-minimize');
    document.body.classList.remove('app-tap');
  }, 120);
});
document.querySelector('.window-max')?.addEventListener('click', () => {
  // Micro tap animation before maximize/unmaximize
  document.body.classList.add('app-tap');
  setTimeout(() => {
    ipcRenderer.send('window-maximize');
    document.body.classList.remove('app-tap');
  }, 120);
});
document.querySelector('.window-close')?.addEventListener('click', () => {
  // Pre-close visual fade
  document.body.classList.add('app-closing');
  ipcRenderer.send('window-close');
});

// If main process asks to prepare closing (non-button paths)
ipcRenderer.on('prepare-close', () => {
  document.body.classList.add('app-closing');
});

// Smooth minimize/maximize/fullscreen orchestration
ipcRenderer.on('prepare-minimize', () => {
  document.body.classList.add('app-minimizing');
});
ipcRenderer.on('prepare-resize', () => {
  document.body.classList.add('app-resizing');
  setTimeout(() => {
    document.body.classList.remove('app-resizing');
  }, 300);
});

ipcRenderer.on('window-state', (event, state) => {
  if (state === 'restored' || state === 'normal' || state === 'fullscreen-leave') {
    // Fade back in when the window comes back
    document.body.classList.remove('app-minimizing');
    document.body.classList.add('app-restoring');
    setTimeout(() => {
      document.body.classList.remove('app-restoring');
    }, 220);
  }
  if (state === 'minimized') {
    // Ensure minimizing class is removed to avoid stale state
    setTimeout(() => document.body.classList.remove('app-minimizing'), 500);
  }
});


// Theme switching is handled in themeswitch.js to preserve body state classes

// --- Prevent default right-click context menu ---
window.addEventListener('contextmenu', e => {
  e.preventDefault();
  return false;
}, false);


// --- Dashboard Stats & Data ---
let dashboardStats = {
  totalTrades: 0,
  winRate: 0,
  activeBots: 0,
  profitLoss: 0
};

function updateDashboardStats() {
  const statTrades = document.getElementById('statTrades');
  const statWinRate = document.getElementById('statWinRate');
  const statActiveBots = document.getElementById('statActiveBots');
  const statPL = document.getElementById('statPL');
  
  if (statTrades) statTrades.textContent = dashboardStats.totalTrades;
  if (statWinRate) statWinRate.textContent = dashboardStats.winRate.toFixed(1) + '%';
  if (statActiveBots) statActiveBots.textContent = `${dashboardStats.activeBots}/3`;
  if (statPL) statPL.textContent = '$' + dashboardStats.profitLoss.toFixed(2);
}

// --- Bot activity badge helpers (history-driven) -----------------------
function getBotActiveWindowMs(botKey) {
  if (botKey === 'LUMIX') return 20 * 60 * 1000;   // 20 minutes
  if (botKey === 'MIRAX') return 10 * 60 * 1000;   // 10 minutes
  if (botKey === 'ARVION') return 60 * 60 * 1000;  // 1 hour
  return 0;
}

function getLatestHistorySignalTimeMs(botKey) {
  try {
    const list = signalHistory[botKey] || [];
    if (!list.length) return null;
    const entry = list[0]; // signalHistory is newest-first
    const ms = getTradeSortTimeMs(entry) || toEpochMs(entry.timestamp) || toEpochMs(entry.openingTime) || toEpochMs(entry.time);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch (e) {
    return null;
  }
}

function isBotActiveByRecentSignal(botKey) {
  // Prefer persisted history timestamp (survives restarts); fall back to local WS receipt time.
  const histMs = getLatestHistorySignalTimeMs(botKey);
  if (histMs) {
    const sinceMs = Date.now() - histMs;
    return sinceMs >= 0 && sinceMs <= getBotActiveWindowMs(botKey);
  }

  const lastSeenLocal = lastSignalSeenAtLocal[botKey] || 0;
  const lastServerMs = toEpochMs(lastSignalTime[botKey]) || 0;
  const lastSeen = lastSeenLocal || lastServerMs;
  if (!lastSeen) return false;
  const sinceMs = Date.now() - lastSeen;
  return sinceMs >= 0 && sinceMs <= getBotActiveWindowMs(botKey);
}

function updateBotActivityBadges() {
  let activeCount = 0;
  ['LUMIX','MIRAX','ARVION'].forEach(botKey => {
    try {
      const botId = botIdMap[botKey];
      const btn = botId ? document.getElementById(`menu-${botId}`) : null;
      let badge = btn?.closest('.card')?.querySelector('.badge');
      if (!badge && botId) {
        const idx = Number(String(botId).replace(/[^0-9]/g, '')) || 1;
        badge = document.querySelector(`#section-bots .card:nth-of-type(${idx}) .badge`);
      }

      const isActive = isBotActiveByRecentSignal(botKey);
      if (badge) {
        badge.textContent = isActive ? 'Active' : 'Inactive';
        badge.classList.toggle('active', isActive);
        badge.classList.toggle('inactive', !isActive);
      }
      if (isActive) activeCount++;
    } catch (e) {
      /* ignore UI errors */
    }
  });

  dashboardStats.activeBots = activeCount;
  updateDashboardStats();
}

function addRecentActivity(bot, side, symbol, time) {
  const activityList = document.getElementById('recentActivity');
  if (!activityList) return;
  
  // Remove placeholder
  const placeholder = activityList.querySelector('.activity-item');
  const placeholderText = placeholder && placeholder.querySelector('.activity-text')?.textContent;
  if (placeholder && (placeholderText === 'No recent trades yet' || placeholderText === 'Waiting for next signal…')) {
    activityList.innerHTML = '';
  }
  
  const item = document.createElement('div');
  item.className = 'activity-item';
  const color = side === 'BUY' ? '#2ed573' : '#ff6b81';
  item.innerHTML = `
    <div class="activity-icon" style="background: rgba(90, 106, 255, 0.1); color: #5a6aff;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
      </svg>
    </div>
    <div class="activity-content">
      <p class="activity-text" style="color:${color};">${bot} ${side} ${symbol}</p>
      <p class="activity-time">${time}</p>
    </div>
  `;
  activityList.prepend(item);
  
  // Keep last 5
  while (activityList.children.length > 5) {
    activityList.removeChild(activityList.lastChild);
  }
}

function updateHealthWS(state) {
  const healthWS = document.getElementById('healthWS');
  const healthWSText = document.getElementById('healthWSText');
  if (!healthWS || !healthWSText) return;
  
  healthWS.classList.remove('online', 'offline', 'warning');
  if (state === 'online') {
    healthWS.classList.add('online');
    healthWSText.textContent = 'Connected';
  } else if (state === 'connecting') {
    healthWS.classList.add('warning');
    healthWSText.textContent = 'Connecting';
  } else {
    healthWS.classList.add('offline');
    healthWSText.textContent = 'Offline';
  }
}

// Quick Actions
document.addEventListener('DOMContentLoaded', () => {
  // Performance: Enable GPU acceleration for all interactive elements
  const style = document.createElement('style');
  style.textContent = `
    button, input, label, select, textarea {
      will-change: auto;
      transform: translateZ(0);
      -webkit-transform: translateZ(0);
    }
    .signal-card, .card, .menu-item {
      will-change: transform, opacity;
      transform: translateZ(0);
      -webkit-transform: translateZ(0);
    }
  `;
  document.head.appendChild(style);
  
  // Disable background throttling for smooth animations
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // console.log('[Performance] App backgrounded, reducing frame rate');
    } else {
      // console.log('[Performance] App foregrounded, full 300 FPS mode');
    }
  });
  
  const quickLaunchBot = document.getElementById('quickLaunchBot');
  const quickViewStrategies = document.getElementById('quickViewStrategies');
  const quickSettings = document.getElementById('quickSettings');
  const historyButtons = [
    { id: 'historyBtn-bot1', bot: 'LUMIX' },
    { id: 'historyBtn-bot2', bot: 'MIRAX' },
    { id: 'historyBtn-bot3', bot: 'ARVION' }
  ];
  
  if (quickLaunchBot) {
    quickLaunchBot.addEventListener('click', () => {
      document.getElementById('menu-bots')?.click();
    });
  }
  
  if (quickViewStrategies) {
    quickViewStrategies.addEventListener('click', () => {
      document.getElementById('menu-strategies')?.click();
    });
  }
  
  if (quickSettings) {
    quickSettings.addEventListener('click', () => {
      navigateToSection('profile');
    });
  }

  historyButtons.forEach(({ id, bot }) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener('click', () => renderHistoryModal(bot));
    }
  });

  // Ensure stats are computed from any loaded history on startup
  ['LUMIX','MIRAX','ARVION'].forEach(bot => { try { computeStatsFromHistory(bot); } catch (e) {} });

  // Initialize bot activity badges and keep them in sync (uses history + WS fallback)
  try { updateBotActivityBadges(); } catch (e) {}
  if (!window.__utkBotActivityTimer) window.__utkBotActivityTimer = setInterval(() => { try { updateBotActivityBadges(); } catch (e) {} }, 60000);

  // Info buttons
  const infoButtons = [
    { id: 'infoBtn-bot1', bot: 'LUMIX' },
    { id: 'infoBtn-bot2', bot: 'MIRAX' },
    { id: 'infoBtn-bot3', bot: 'ARVION' }
  ];
  infoButtons.forEach(({ id, bot }) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => renderInfoModal(bot));
  });

  // Info modal renderer
  function renderInfoModal(botKey) {
    const modal = document.getElementById('info-modal');
    const title = document.getElementById('infoModalTitle');
    const body = document.getElementById('infoModalBody');
    if (!modal || !title || !body) return;

    title.textContent = `${botKey} - Info`;
    let content = '';
    if (botKey === 'LUMIX') {
      content = `
        <p><strong>LUMIX</strong> — Fast scalping strategy. Uses 1-minute candles and quick expiration windows. Designed for volatility scalps and short-term momentum.</p>
        <ul>
          <li>Candles: 1-minute</li>
          <li>Expiration: 5 minutes</li>
          <li>Signals: MA crossover + RSI + volatility filter</li>
        </ul>`;
    } else if (botKey === 'MIRAX') {
      content = `
        <p><strong>MIRAX</strong> — Momentum breakout strategy optimized for short trends.</p>
        <ul>
          <li>Candles: short (3-minute) timeframe</li>
          <li>Expiration: 3 minutes</li>
          <li>Signals: breakout confirmation with volume and trend filters</li>
        </ul>`;
    } else if (botKey === 'ARVION') {
      content = `
        <p><strong>ARVION</strong> — News breakout hunter built for larger moves and longer expirations.</p>
        <ul>
          <li>Candles: 15-minute</li>
          <li>Expiration: 20–30 minutes</li>
          <li>Signals: event-based breakout + momentum confirmation</li>
        </ul>`;
    } else {
      content = '<p>No information available.</p>';
    }

    body.innerHTML = content;
    modal.classList.add('active');

    // Close button handler
    const closeBtn = modal.querySelector('.info-close-btn');
    if (closeBtn) {
      const handler = () => { modal.classList.remove('active'); closeBtn.removeEventListener('click', handler); };
      closeBtn.addEventListener('click', handler);
    }
  }

  // Saving signal and Auto-Trade visibility
  ['bot1', 'bot2', 'bot3'].forEach(botId => {
    const autoTradeToggle = document.getElementById(`autoTradeToggle-${botId}`);
    const enableToggle = document.getElementById(`savingSignalEnabled-${botId}`);
    const optionsDiv = document.getElementById(`savingSignalOptions-${botId}`);
    
    if (!autoTradeToggle || !enableToggle || !optionsDiv) return;
    
    // Find the form-group container that holds both label and toggle for Saving Signals
    const savingSignalsContainer = enableToggle.closest('.form-group');
    
    // Hide Saving Signals section initially if Auto Trade is off
    const updateVisibility = () => {
      const isAutoTradeOn = autoTradeToggle.checked;
      
      // Show/hide entire Saving Signals form-group based on Auto Trade
      if (savingSignalsContainer) {
        savingSignalsContainer.style.display = isAutoTradeOn ? 'block' : 'none';
      }
      
      // Reset options visibility when Auto Trade is OFF
      if (!isAutoTradeOn) {
        enableToggle.checked = false;
        optionsDiv.style.display = 'none';
      } else if (enableToggle.checked) {
        // Show options if Auto Trade is ON and checkbox is checked
        optionsDiv.style.display = 'block';
      }
    };
    
    // Initialize visibility on load
    updateVisibility();
    
    // When Auto Trade toggle changes
    autoTradeToggle.addEventListener('change', updateVisibility);
    
    // When Saving Signals enabled checkbox changes
    enableToggle.addEventListener('change', () => {
      optionsDiv.style.display = enableToggle.checked ? 'block' : 'none';
    });
  });

  // One-time terms modal
  initTermsModal();
});


// --- LUMIX 5 Bot Signal Card Logic ---
const lumixSignalList = document.querySelector('#section-bot2 .bot-signal-list');
const wsStatusEl = document.getElementById('ws-status');
const signalDisplays = {
  LUMIX: document.getElementById('signalDisplay-bot1'),
  MIRAX: document.getElementById('signalDisplay-bot2'),
  ARVION: document.getElementById('signalDisplay-bot3')
};
const signalEmptyStates = {
  LUMIX: document.getElementById('signalEmpty-bot1'),
  MIRAX: document.getElementById('signalEmpty-bot2'),
  ARVION: document.getElementById('signalEmpty-bot3')
};
const botContainers = {
  LUMIX: document.querySelector('#section-bot1 .bot-signal-area'),
  MIRAX: document.querySelector('#section-bot2 .bot-signal-area'),
  ARVION: document.querySelector('#section-bot3 .bot-signal-area')
};
const botIdMap = {
  LUMIX: 'bot1',
  MIRAX: 'bot2',
  ARVION: 'bot3'
};
const signalHistory = {
  LUMIX: [],
  MIRAX: [],
  ARVION: []
};
const TERMS_KEY = 'utk_terms_v1_1_0';

// Real-time listeners for each bot
const historyListeners = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};

// Active signal listeners
const activeSignalListeners = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};

// Track countdown sync
const countdownSync = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};

const FIREBASE_TRADE_FETCH_LIMIT_PER_BOT = 2000;
const HISTORY_KEEP_PER_BOT = 2000;

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: if the number looks like epoch seconds, convert to ms.
    // seconds ~ 1.7e9, ms ~ 1.7e12
    if (value > 1e9 && value < 1e12) return value * 1000;
    return value;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d{10,17}$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      // If it's 10 digits it's almost certainly seconds.
      if (s.length === 10) return n * 1000;
      // If it's 13 digits it's almost certainly ms. Otherwise keep as-is.
      return n;
    }
    // Handle formats like "2026-02-09 22:12:12" by converting to ISO-ish.
    const isoish = s.includes('T') ? s : s.replace(' ', 'T');
    const parsed = Date.parse(isoish);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'object') {
    try {
      if (typeof value.toMillis === 'function') return value.toMillis();
      if (typeof value.seconds === 'number') return value.seconds * 1000;
    } catch {}
  }
  return null;
}

function getTradeSortTimeMs(data) {
  return (
    toEpochMs(data?.timestamp) ??
    toEpochMs(data?.openingTime) ??
    toEpochMs(data?.time) ??
    toEpochMs(data?.createdAt) ??
    0
  );
}

// Setup real-time Firebase history listeners
function setupFirebaseHistoryListeners() {
  ['LUMIX', 'MIRAX', 'ARVION'].forEach(botKey => {
    // Query per-bot trades. Previous approach queried the last N global trades
    // and then filtered locally, which can miss many entries for a given bot.
    const tradesRef = collection(db, 'trades');
    const q = query(
      tradesRef,
      where('bot', '==', botKey),
      limit(FIREBASE_TRADE_FETCH_LIMIT_PER_BOT)
    );
    
    // Listen for real-time updates
    historyListeners[botKey] = onSnapshot(q, (snapshot) => {
      // Debug: log snapshot and doc changes
      try {
        console.log(`[Firebase] History snapshot for ${botKey}: docs=${snapshot.size}, changes=${snapshot.docChanges().length}`);
        snapshot.docChanges().forEach((change) => {
          const d = change.doc.data();
          if (change.type === 'added' && d && d.bot === botKey) {
            console.log(`[Firebase] New trade added for ${botKey}:`, d);
          }
        });
      } catch (e) { console.warn('[Firebase] snapshot logging failed', e); }

      const trades = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        // Sort later; keep original payload intact.
        trades.push({ id: doc.id, ...data });
      });

      trades.sort((a, b) => getTradeSortTimeMs(b) - getTradeSortTimeMs(a));
      signalHistory[botKey] = trades.slice(0, HISTORY_KEEP_PER_BOT);
      // console.log(`[Firebase] Loaded ${trades.length} trades for ${botKey}`);
      try { computeStatsFromHistory(botKey); } catch (e) {}
      // Ensure UI badges reflect freshly-loaded history
      try { updateBotActivityBadges(); } catch (e) {}
    }, (error) => {
      console.error(`[Firebase] Error listening to ${botKey} trades:`, error);
    });
    
    // Setup active signal listener for real-time sync
    setupActiveSignalListener(botKey);
  });
}

// Setup listener for active signals (live sync across all users)
function setupActiveSignalListener(botKey) {
  // Check if user is authenticated
  if (!auth.currentUser) {
    // console.warn(`[Firebase] Skipping active signal listener for ${botKey} - user not authenticated`);
    return;
  }
  
  const activeSignalRef = doc(db, 'activeSignals', botKey);
  
  activeSignalListeners[botKey] = onSnapshot(activeSignalRef, (docSnap) => {
    if (docSnap.exists()) {
      const data = docSnap.data();
      const now = Date.now();
      const updatedAtMs = toEpochMs(data.updatedAt) || 0;
      if (lastLocalPhaseUpdate[botKey] && updatedAtMs && updatedAtMs <= lastLocalPhaseUpdate[botKey]) {
        return; // Ignore stale/stored state when we already handled fresher data locally
      }
      const startTimeMs = toEpochMs(data.startTime) || updatedAtMs || now;
      const elapsed = Math.max(0, (now - startTimeMs) / 1000); // seconds since signal started
      const defaultPrepare = getDefaultPrepareSeconds();
      const defaultTrade = getDefaultTradeSeconds(botKey);
      const phaseRaw = String(data.phase || '').trim();
      const phaseLower = phaseRaw.toLowerCase();
      const phase = (phaseLower === 'preparing')
        ? 'Preparing'
        : (phaseLower === 'signal')
          ? 'Signal'
          : (phaseLower === 'trading result' || phaseLower === 'result')
            ? 'Trading Result'
            : phaseRaw;
      
      // Only show if signal is still active (not expired)
      if (phase === 'Preparing') {
        // Always allow Preparing to show/update.
        // Suppressing it caused repeated Preparing (esp. currency changes) to never render
        // and prevented preselection in some sync flows.
        suppressPreparingUntilSignal[botKey] = false;
        cancelResultAutoClear(botKey);
        const duration = Math.max(data.duration || data.countdown || defaultPrepare, defaultPrepare);
        const remaining = Math.max(0, duration - elapsed);
        if (remaining > 0) {
          startCountdown(botKey, remaining, 'Preparing');
          scheduleRenderSignal(botKey, { ...data, phase, countdown: remaining });
          applyPhaseGlow(botKey, { phase });
        }
      } else if (phase === 'Signal') {
        cancelResultAutoClear(botKey);
        suppressPreparingUntilSignal[botKey] = false;
        const duration = Math.max(data.duration || data.countdown || defaultTrade, defaultTrade);
        const remaining = Math.max(0, duration - elapsed);
        if (remaining > 0) {
          startCountdown(botKey, remaining, 'Trading');
          scheduleRenderSignal(botKey, { ...data, phase, countdown: remaining });
          applyPhaseGlow(botKey, { phase, action: data.action });
        }
      } else if (phase === 'Trading Result' && elapsed < 15) {
        scheduleRenderSignal(botKey, { ...data, phase });
        applyPhaseGlow(botKey, { phase, result: data.result });
        suppressPreparingUntilSignal[botKey] = true;
        // Update stats based on the final trade result
        try { updateBotStatsOnResult(botKey, data); } catch (e) {}

        // Ensure the result doesn't hang around; clear back to empty state.
        scheduleResultAutoClear(botKey, (15 - elapsed) * 1000);

        // Do not persist from activeSignals when WS is online; it can double-save the same trade
        // with different timestamps (no reliable open/close linkage here).
        // The WS Trading Result path is the source of truth for saving trades.
      }
    }
  }, (error) => {
    // Only log if it's not a permission error (those are expected during rule propagation)
    if (error.code !== 'permission-denied') {
      // console.error(`[Firebase] Error listening to active signal for ${botKey}:`, error);
    } else {
      // console.warn(`[Firebase] Permission denied for ${botKey} activeSignals - check Firebase rules and wait for propagation`);
    }
  });
}

// Save active signal to Firebase for real-time sync
async function saveActiveSignalToFirebase(botKey, signalData) {
  // Check if user is authenticated
  if (!auth.currentUser) {
    // console.warn(`[Firebase] Cannot save active signal for ${botKey} - user not authenticated`);
    return;
  }
  
  try {
    const activeSignalRef = doc(db, 'activeSignals', botKey);
    await setDoc(activeSignalRef, {
      ...signalData,
      bot: botKey,
      startTime: Date.now(),
      updatedAt: Date.now()
    });
    // console.log(`[Firebase] Saved active signal for ${botKey}`);
  } catch (error) {
    if (error.code === 'permission-denied') {
      // console.warn(`[Firebase] Permission denied saving ${botKey} - check Firebase rules`);
    } else {
      // console.error(`[Firebase] Error saving active signal for ${botKey}:`, error);
    }
  }
}

// Patch active signal in Firebase without resetting `startTime`.
// Used for small updates (e.g., delayed opening price) where we must not restart countdown across users.
async function patchActiveSignalInFirebase(botKey, patch) {
  if (!auth.currentUser) return;
  try {
    const activeSignalRef = doc(db, 'activeSignals', botKey);
    const updatedAt = Date.now();
    try {
      await updateDoc(activeSignalRef, { ...patch, updatedAt });
    } catch (e) {
      // If the doc doesn't exist yet (race), fall back to merge write without setting startTime.
      await setDoc(activeSignalRef, { ...patch, updatedAt }, { merge: true });
    }
  } catch (error) {
    // Silent failure is OK here; this is a best-effort sync optimization.
  }
}

// Clear active signal from Firebase
async function clearActiveSignalFromFirebase(botKey) {
  try {
    const activeSignalRef = doc(db, 'activeSignals', botKey);
    await deleteDoc(activeSignalRef);
    // console.log(`[Firebase] Cleared active signal for ${botKey}`);
  } catch (error) {
    // console.error(`[Firebase] Error clearing active signal for ${botKey}:`, error);
  }
}

// Save trade result to Firebase (global collection for all users) - only once per trade
async function saveTradeToFirebase(botKey, tradeData) {
  const user = auth.currentUser;
  if (!user) {
    console.warn('[Firebase] No user logged in, cannot save trade');
    return;
  }

  try {
    const openKey = toEpochMs(tradeData.openingTime) ?? toEpochMs(tradeData.timestamp) ?? Date.now();
    const closeKey = toEpochMs(tradeData.closingTime) ?? 0;
    const timestamp = openKey;
    const rawSymbol = String(tradeData.symbol || 'N/A');
    const stableSymbolKey = canonCurrencyKey(rawSymbol);
    const safeKey = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);

    // Deterministic ID => all clients target the same document.
    // Using timestamp means multiple users won't create duplicates for the same trade.
    const tradeId = `${safeKey(botKey)}__${safeKey(stableSymbolKey || rawSymbol)}__${openKey}__${closeKey}`;
    const tradeRef = doc(db, 'trades', tradeId);

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(tradeRef);
      if (snap.exists()) {
        // Someone already saved it (could be another user).
        return;
      }
      tx.set(tradeRef, {
        bot: botKey,
        timestamp: timestamp,
        phase: tradeData.phase || 'Trading Result',
        result: tradeData.result,
        symbol: rawSymbol,
        action: tradeData.action,
        openingPrice: tradeData.openingPrice,
        closingPrice: tradeData.closingPrice,
        openingTime: tradeData.openingTime,
        closingTime: tradeData.closingTime,
        savingSignal: tradeData.savingSignal || false,
        savingSignalText: tradeData.savingSignalText || null,
        // Helpful metadata
        source: 'electron-client',
        createdAt: Date.now()
      });
    });

    console.log(`[Firebase] Trade ensured in global collection for ${botKey}: ${rawSymbol} - ${tradeData.result} (${timestamp})`);
  } catch (error) {
    console.error('[Firebase] Error saving trade:', error);
  }
}

// One-time terms modal handling
function initTermsModal() {
  const modal = document.getElementById('terms-modal');
  const checkbox = document.getElementById('terms-checkbox');
  const acceptBtn = document.getElementById('terms-accept-btn');
  if (!modal || !checkbox || !acceptBtn) return;

  const accepted = localStorage.getItem(TERMS_KEY) === 'accepted';
  if (accepted) {
    modal.classList.remove('active');
    return;
  }

  // Show modal and gate the button until the box is checked
  modal.classList.add('active');
  acceptBtn.disabled = true;
  checkbox.checked = false;

  checkbox.addEventListener('change', () => {
    acceptBtn.disabled = !checkbox.checked;
  });

  acceptBtn.addEventListener('click', () => {
    localStorage.setItem(TERMS_KEY, 'accepted');
    modal.classList.remove('active');
  });
}

// Add a result to history (saves to Firebase, real-time listener updates UI)
async function addToHistory(botKey, result) {
  if (!signalHistory[botKey]) return;

  // Only save Trading Result phase to Firebase (skip Preparing and Signal phases)   
  if (result.phase && result.phase !== 'Trading Result') {
    // console.log(`[Firebase] Skipping ${result.phase} phase - only Trading Result is saved`);
    return;
  }

  // Use a consistent timestamp for the OPENING moment.
  // Trading Result payloads often set `time` to the result/close moment;
  // using that as "openingTime" makes trades look like they lasted minutes.
  const openingTimeMs =
    toEpochMs(result.openingTime) ??
    toEpochMs(lastSignalTime[botKey]) ??
    toEpochMs(result.timestamp) ??
    null;
  const closingTimeMs =
    toEpochMs(result.closingTime) ??
    toEpochMs(result.time) ??
    Date.now();
  const signalTimestamp = openingTimeMs ?? closingTimeMs ?? Date.now();

  const symbolForKey = result.symbol || result.currency || result.selectedCurrency || 'N/A';
  const resultForKey = result.result || 'N/A';
  const tradeKey = `${botKey}-${symbolForKey}-${resultForKey}-${signalTimestamp}`;

  // Check if we've already processed this exact trade result
  if (lastTradeKey[botKey] === tradeKey) {
    console.log(`[Firebase] Trade already processed for ${botKey}, skipping duplicate`);
    return;
  }
  lastTradeKey[botKey] = tradeKey;

  // Saving signals now always show after losses (not gated by toggle)
  const losses = consecutiveLosses[botKey] || 0;
  const wasSavingSignal = losses > 0;

  const tradeData = {
    timestamp: signalTimestamp, // Opening time
    phase: 'Trading Result',
    result: result.result || result,
    symbol: symbolForKey,
    action: result.action || result.side || 'N/A',
    openingPrice:
      result.openingPrice ??
      result.opening_price ??
      result.openPrice ??
      result.open_price ??
      result.entryPrice ??
      result.entry_price ??
      lastSignalPrice[botKey] ??
      result.price ??
      'N/A',
    closingPrice:
      result.closingPrice ??
      result.closing_price ??
      result.closePrice ??
      result.close_price ??
      result.exitPrice ??
      result.exit_price ??
      result.price ??
      'N/A',
    openingTime: signalTimestamp,
    closingTime: closingTimeMs,
    savingSignal: wasSavingSignal,
    savingSignalText: wasSavingSignal ? getSavingSignalText(botKey) : null
  };

  // Save to Firebase (real-time listener will update signalHistory array)
  await saveTradeToFirebase(botKey, tradeData);
  console.log(`[App] Trade sent to Firebase for ${botKey}: ${tradeData.symbol} - ${tradeData.result}`);

  // Update local UI stats immediately (also deduped by lastResultKey)
  try { updateBotStatsOnResult(botKey, tradeData); } catch (e) {}
}

const lastHistoryKey = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};
const lastTradeKey = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};
const consecutiveLosses = {
  LUMIX: 0,
  MIRAX: 0,
  ARVION: 0
};
const lastLocalPhaseUpdate = {
  LUMIX: 0,
  MIRAX: 0,
  ARVION: 0
};

// Store opening price and time for each bot
const lastSignalPrice = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};

const lastSignalTime = {
  LUMIX: 0,
  MIRAX: 0,
  ARVION: 0
};

// Local receipt time of the last Signal phase (independent of server timestamps).
// Used to decide whether a Trading Result is part of the current in-session chain.
const lastSignalSeenAtLocal = {
  LUMIX: 0,
  MIRAX: 0,
  ARVION: 0
};

const lastResultKey = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};

// Stats-only streak: number of consecutive losses since last win / reset.
// This is used for UI bucketing and loss counting (a "Loss" is counted only
// when a full 5-step sequence fails with 5 losses in a row).
const statsLossStreak = {
  LUMIX: 0,
  MIRAX: 0,
  ARVION: 0
};

// UI-only win streak (consecutive WIN results).
// This is purely for display and does not affect trading logic.
const statsWinStreak = {
  LUMIX: 0,
  MIRAX: 0,
  ARVION: 0
};

function setWinStreakUI(botKey, value) {
  try {
    const botId = botIdMap[botKey];
    if (!botId) return;
    const streakValue = Math.max(0, parseInt(value, 10) || 0);
    const el = document.getElementById(`winStreakValue-${botId}`);
    if (el) el.textContent = String(streakValue);
    const badge = document.getElementById(`winStreakBadge-${botId}`);

    // Gradual heat-up: 0 -> silver, 10+ -> full accent.
    // Kept purely visual (does not affect trading logic).
    const heat = Math.max(0, Math.min(1, streakValue / 10));
    if (badge) {
      badge.classList.toggle('is-hot', streakValue >= 3);
      badge.style.setProperty('--streak-heat-pct', `${Math.round(heat * 100)}%`);
      badge.style.setProperty('--streak-heat-n', String(heat));
    }
  } catch (e) {}
}

// Win streak definition for UI:
// Count total wins since the last time the Stats "Losses" counter would increment.
// In this app, "Losses" increments only after 5 losses in a row.
function computeWinsSinceLastStatsLoss(trades) {
  try {
    const list = Array.isArray(trades) ? trades : [];
    // Process chronological (oldest -> newest)
    const ordered = list.slice().reverse();
    let lossChain = 0;
    let wins = 0;

    ordered.forEach((t) => {
      const res = String(t?.result || '').toLowerCase().trim();
      const isLoss = (res === 'loss' || res === 'lose' || res === 'lost' || res === 'l');
      const isWin = (res === 'win' || res === 'won' || res === 'success' || res === 'w');

      if (isWin) {
        wins += 1;
        lossChain = 0;
        return;
      }
      if (isLoss) {
        lossChain += 1;
        if (lossChain >= 5) {
          // This is where Stats "Losses" would increment.
          wins = 0;
          lossChain = 0;
        }
      }
      // ignore unknown/missing result rows
    });

    return wins;
  } catch (e) {
    return 0;
  }
}

function bumpStat(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const current = parseInt(el.textContent, 10) || 0;
  el.textContent = current + 1;
  try {
    const item = el.closest('.stat-item');
    if (item) {
      item.classList.add('stat-pulse');
      setTimeout(() => item.classList.remove('stat-pulse'), 500);
    }
  } catch (e) {}
}

function updateBotStatsOnResult(botKey, data) {
  try {
    const key = `${botKey}-${(data.result||'')}-${data.updatedAt||data.timestamp||Date.now()}`;
    if (lastResultKey[botKey] === key) return; // dedupe
    lastResultKey[botKey] = key;

    const botId = botIdMap[botKey];
    if (!botId) return;

    const result = (data.result || '').toString().toLowerCase().trim();
    const isLoss = (result === 'loss' || result === 'lose' || result === 'lost' || result === 'l');
    const isWin = (result === 'win' || result === 'won' || result === 'success' || result === 'w');

    // Losses are counted only when a full 5-step sequence fails (5 losses in a row).
    if (isLoss) {
      statsLossStreak[botKey] = (statsLossStreak[botKey] || 0) + 1;
      if (statsLossStreak[botKey] >= 5) {
        bumpStat(`stat-losses-${botId}`);
        statsLossStreak[botKey] = 0;

        // Reset Win Streak only when the Stats "Losses" counter increments.
        statsWinStreak[botKey] = 0;
        setWinStreakUI(botKey, 0);
      }
      return;
    }

    if (isWin) {
      const streak = statsLossStreak[botKey] || 0;
      let bucket = 'stat-1x-wins';
      if (streak === 0) bucket = 'stat-1x-wins';
      else if (streak === 1) bucket = 'stat-2x4x-wins';
      else if (streak === 2) bucket = 'stat-5x7x-wins';
      else if (streak === 3) bucket = 'stat-12x16x-wins';
      else bucket = 'stat-25x44x-wins';

      bumpStat(`${bucket}-${botId}`);
      statsLossStreak[botKey] = 0;

      // Update win streak for UI.
      statsWinStreak[botKey] = (statsWinStreak[botKey] || 0) + 1;
      setWinStreakUI(botKey, statsWinStreak[botKey]);
    }
  } catch (e) {
    // console.warn('Failed to update bot stats:', e);
  }
}

// Compute aggregated stats from historical trades and populate stat elements
function computeStatsFromHistory(botKey) {
  try {
    const trades = signalHistory[botKey] || [];
    console.log(`[Stats] Recomputing stats for ${botKey} from history (entries=${trades.length})`);

    const counts = {
      'stat-1x-wins': 0,
      'stat-2x4x-wins': 0,
      'stat-5x7x-wins': 0,
      'stat-12x16x-wins': 0,
      'stat-25x44x-wins': 0,
      'stat-losses': 0,
      'stat-saving-signals': 0
    };

    // Process trades in chronological order (oldest -> newest)
    const ordered = (trades || []).slice().reverse();
    let streak = 0; // consecutive losses since last win/reset

    ordered.forEach((t) => {
      const res = String(t.result || '').toLowerCase().trim();

      // Count saving signal if flagged
      if (t.savingSignal) counts['stat-saving-signals'] += 1;

      // Loss: increase streak, but only count a Loss when the full 5-step chain fails
      if (res === 'loss' || res === 'lose' || res === 'lost' || res === 'l') {
        streak += 1;
        if (streak >= 5) {
          counts['stat-losses'] += 1;
          streak = 0;
        }
        return;
      }

      // Win: bucket depends on how many losses preceded it
      if (res === 'win' || res === 'won' || res === 'success' || res === 'w') {
        if (streak === 0) counts['stat-1x-wins'] += 1;
        else if (streak === 1) counts['stat-2x4x-wins'] += 1;
        else if (streak === 2) counts['stat-5x7x-wins'] += 1;
        else if (streak === 3) counts['stat-12x16x-wins'] += 1;
        else counts['stat-25x44x-wins'] += 1;
        streak = 0;
        return;
      }

      // If result missing or unrecognized, ignore
    });

    // IMPORTANT:
    // History is global (shared across users). Do NOT drive live bet sizing / saving-signal
    // streaks from it, otherwise a user can start in 2x/4x mode just because the most recent
    // global trades were losses.
    // Live streak is tracked only from locally received Trading Result phases.

    const botId = botIdMap[botKey];
    if (!botId) return;

    Object.keys(counts).forEach((k) => {
      const el = document.getElementById(`${k}-${botId}`);
      if (el) el.textContent = counts[k];
    });

    // Keep stats streak aligned so the next live result buckets correctly.
    // This doesn't affect bet sizing; it's only for UI stats.
    statsLossStreak[botKey] = streak;

    // Compute and display win streak (wins since last Stats "Losses" increment)
    // Note: history is global/shared across users; this is a display-only metric.
    const winStreakNow = computeWinsSinceLastStatsLoss(trades);
    statsWinStreak[botKey] = winStreakNow;
    setWinStreakUI(botKey, winStreakNow);

    console.log(`[Stats] ${botKey} counts updated:`, counts);
  } catch (err) {
    console.warn('[Stats] computeStatsFromHistory failed', err);
  }
}

// Track processed phase messages to prevent duplicates
const processedPhaseMessages = {
  LUMIX: new Set(),
  MIRAX: new Set(),
  ARVION: new Set()
};

// Some bots (e.g., MIRAX) must treat signals/results as a single active-symbol chain.
// This prevents a loss on one pair from inflating the bet size of a different pair.
const SINGLE_ACTIVE_CHAIN_BOTS = new Set(['MIRAX']);
const activeChainSymbol = Object.create(null);

function canonCurrencyKey(symbol) {
  const raw = String(symbol || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  const isOtc = /\bOTC\b/.test(upper);
  const base = upper
    .replace(/\bOTC\b/g, '')
    .replace(/[\s/\\_-]+/g, '')
    .trim();
  if (!base) return upper;
  return isOtc ? `${base}_OTC` : base;
}

// For "single active chain" bots (e.g., MIRAX), treat OTC vs non-OTC formatting as the same chain
// so loss streak doesn't reset just because one payload omitted "OTC".
function canonChainSymbolKey(symbol) {
  const key = canonCurrencyKey(symbol);
  return String(key || '').replace(/_OTC$/i, '');
}




function resolveCurrency(signal) {
  if (!signal) return '';
  const raw = signal.selectedCurrency || signal.symbol || signal.currency || '';
  const rawStr = String(raw || '').trim();
  const rawHasOtc = /\botc\b/i.test(rawStr);
  const typeStr = String(signal.type || '').toLowerCase();
  const marketType = String(signal.marketType || signal.market_type || signal.instrumentType || signal.instrument || '').toLowerCase();
  const feedStr = String(signal.feed || signal.source || '').toLowerCase();
  const hasOtcFlag = !!(signal.isOtc || signal.otc || signal.is_otc || signal.isOtcCurrency || signal.is_otc_currency ||
    typeStr === 'otc' || marketType === 'otc' || feedStr === 'otc' ||
    (signal.market && String(signal.market).toLowerCase() === 'otc') ||
    (signal.exchange && String(signal.exchange).toLowerCase() === 'otc'));
  const base = rawStr.replace(/\s*OTC/ig, '').trim();
  if (!base) return rawStr;
  const needsOtc = hasOtcFlag || rawHasOtc;
  return needsOtc ? `${base} OTC` : base;
}

function getDefaultPrepareSeconds() {
  return 10;
}

function getDefaultTradeSeconds(botKey) {
  return botKey === 'MIRAX' ? 60 : 300;
}

function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatTimeOnly(value) {
  const ms = toEpochMs(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const h24 = d.getHours();
  const h = h24 % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimePriceStack(timeValue, priceValue) {
  const t = formatTimeOnly(timeValue);
  const pRaw = (priceValue !== undefined && priceValue !== null && priceValue !== 'N/A') ? String(priceValue) : '';
  const p = escapeHtml(pRaw);
  if (t && p) {
    return `<span class="tp-stack"><span class="tp-time">${escapeHtml(t)}</span><span class="tp-price">${p}</span></span>`;
  }
  return escapeHtml(t || pRaw || '');
}

async function sendToExtensionReliable(message, retries = 2, delayMs = 400) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await ipcRenderer.invoke('send-to-extension', message);
      if (!res || res.success === false) {
        throw new Error(res?.error || 'send failed');
      }
      return true;
    } catch (err) {
      if (attempt === retries) return false;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}

function isAutoTradeEnabled(botKey) {
  // Respect global forced-off flag and admin override
  if (window.autoTradesForcedOff && !window.adminAutoTradeOverride) return false;

  const botId = botIdMap[botKey];
  if (!botId) return false;
  const toggle = document.getElementById(`autoTradeToggle-${botId}`);
  return !!(toggle && toggle.checked);
}

function isSavingSignalsEnabled(botKey) {
  const botId = botIdMap[botKey];
  if (!botId) return false;
  const enableToggle = document.getElementById(`savingSignalEnabled-${botId}`);
  return !!(enableToggle && enableToggle.checked && isAutoTradeEnabled(botKey));
}

// Force-disable all auto-trades for the current user and persist a backup in Firestore
window.disableAllAutoTradesForUser = async function(opts = { persist: true }) {
  try {
    window.autoTradesForcedOff = true;
    const backup = {};
    ['LUMIX','MIRAX','ARVION'].forEach(botKey => {
      const botId = botIdMap[botKey];
      const toggle = document.getElementById(`autoTradeToggle-${botId}`);
      const enableToggle = document.getElementById(`savingSignalEnabled-${botId}`);
      backup[botKey] = {
        autoTrade: !!(toggle && toggle.checked),
        savingSignal: !!(enableToggle && enableToggle.checked)
      };
      // Update UI immediately
      if (toggle) { toggle.checked = false; toggle.dispatchEvent(new Event('change')); }
      if (enableToggle) { enableToggle.checked = false; enableToggle.dispatchEvent(new Event('change')); }
      try { setTradeStatus(botKey, 'Auto-trades disabled for maintenance'); } catch (e) {}
    });

    const user = auth.currentUser;
    if (opts.persist && user) {
      try {
        const userDoc = doc(db, 'users', user.uid);
        await updateDoc(userDoc, { autoTradeBackup: backup, autoTradesForcedOff: true }, { merge: true });
      } catch (e) {
        // ignore persist errors
      }
    }
  } catch (e) {}
};

// Restore auto-trades from backup (if present in Firestore) or from local UI state
window.restoreAllAutoTradesFromBackupForUser = async function() {
  try {
    window.autoTradesForcedOff = false;
    const user = auth.currentUser;
    let backup = null;
    if (user) {
      try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (snap.exists()) {
          const data = snap.data();
          backup = data && data.autoTradeBackup ? data.autoTradeBackup : null;
        }
        // Clear persisted flags
        try { await updateDoc(doc(db, 'users', user.uid), { autoTradesForcedOff: false, autoTradeBackup: null }, { merge: true }); } catch(e){}
      } catch (e) {}
    }

    if (backup) {
      Object.keys(backup).forEach(botKey => {
        const botId = botIdMap[botKey];
        const toggle = document.getElementById(`autoTradeToggle-${botId}`);
        const enableToggle = document.getElementById(`savingSignalEnabled-${botId}`);
        const state = backup[botKey] || {};
        if (toggle) { toggle.checked = !!state.autoTrade; toggle.dispatchEvent(new Event('change')); }
        if (enableToggle) { enableToggle.checked = !!state.savingSignal; enableToggle.dispatchEvent(new Event('change')); }
      });
    }
  } catch (e) {}
};

function getBetSize(botKey) {
  const botId = botIdMap[botKey];
  if (!botId) return 10;
  const input = document.getElementById(`betSize-${botId}`);
  const val = parseFloat(input?.value || '10');
  return Number.isFinite(val) && val > 0 ? val : 10;
}

function getAdjustedBetSize(botKey) {
  const baseBet = getBetSize(botKey);
  const botId = botIdMap[botKey];
  if (!botId) return baseBet;
  
  // Check if AUTO TRADE is enabled (saving signals always active after losses)
  const autoTradeToggle = document.getElementById(`autoTradeToggle-${botId}`);
  if (!autoTradeToggle || !autoTradeToggle.checked) {
    return baseBet;
  }

  // If saving signals are off, never apply multipliers.
  if (!isSavingSignalsEnabled(botKey)) {
    return baseBet;
  }
  
  const losses = consecutiveLosses[botKey] || 0;
  if (losses === 0) return baseBet;
  
  const mode = getSavingSignalMode(botKey);
  
  // Get the multiplier based on mode and loss count
  const multipliers2x = [1, 2, 5, 12, 25];  // 0-4 losses (1 loss=2x, 2 losses=5x, 3 losses=12x, 4 losses=25x)
  const multipliers4x = [1, 4, 7, 16, 44]; // 0-4 losses
  
  const multipliers = mode === '2x' ? multipliers2x : multipliers4x;
  const idx = Math.min(losses, multipliers.length - 1);
  const multiplier = multipliers[idx];
  
  const adjustedBet = baseBet * multiplier;
  // console.log(`[App] ${botKey} bet adjustment: base=${baseBet}, losses=${losses}, mode=${mode}, multiplier=${multiplier}x, adjusted=${adjustedBet}`);
  
  return adjustedBet;
}

function getSavingSignalMode(botKey) {
  const botId = botIdMap[botKey];
  if (!botId || !isSavingSignalsEnabled(botKey)) return '2x';
  // Get mode from toggle - always available, not gated by enable checkbox
  const toggle = document.getElementById(`savingSignalToggle-${botId}`);
  return toggle?.checked ? '4x' : '2x';
}

function getSavingSignalText(botKey) {
  if (!isSavingSignalsEnabled(botKey)) return null;
  const botId = botIdMap[botKey];
  if (!botId) return null;
  
  // Show saving signal indicator for trades after any loss when enabled
  const losses = consecutiveLosses[botKey] || 0;
  if (losses === 0) return null;
  
  // Get the mode from toggle (if toggle is off, default to 2x)
  const toggleEl = document.getElementById(`savingSignalToggle-${botId}`);
  const mode = toggleEl?.checked ? '4x' : '2x';
  
  // 2x mode: 1 loss=2x, 2 losses=5x, 3 losses=12x, 4 losses=25x
  // 4x mode: 1 loss=4x, 2 losses=7x, 3 losses=16x, 4 losses=44x
  const multipliers2x = [
    null,           // 0 losses
    '2x',           // 1 loss
    '5x',           // 2 losses
    '12x',          // 3 losses
    '25x'           // 4 losses
  ];
  
  const multipliers4x = [
    null,           // 0 losses
    '4x',           // 1 loss
    '7x',           // 2 losses
    '16x',          // 3 losses
    '44x'           // 4 losses
  ];
  
  const multipliers = mode === '2x' ? multipliers2x : multipliers4x;
  const idx = Math.min(losses, multipliers.length - 1);
  return multipliers[idx] ? `Saving Signal ${multipliers[idx]}` : null;
}

function getSavingSignalMessage(botKey) {
  if (!isSavingSignalsEnabled(botKey)) return null;
  const losses = consecutiveLosses[botKey] || 0;
  if (losses >= 4) {
    return "We are sorry for the loss, let's try to fix that";
  }
  return null;
}

function updateLossStreak(botKey, result) {
  const resultUpper = (result || '').toString().trim().toUpperCase();
  const currentLosses = consecutiveLosses[botKey] || 0;
  
  const isWin = (resultUpper === 'WIN' || resultUpper === 'WON' || resultUpper === 'SUCCESS' || resultUpper === 'W');
  const isLoss = (resultUpper === 'LOSS' || resultUpper === 'LOSE' || resultUpper === 'LOST' || resultUpper === 'L');

  if (isWin) {
    consecutiveLosses[botKey] = 0;
    // console.log(`[App] ${botKey} won - reset loss streak`);
  } else if (isLoss) {
    // If we just completed the 4th saving signal (had 4 losses), reset regardless
    if (currentLosses >= 4) {
      consecutiveLosses[botKey] = 0;
      // console.log(`[App] ${botKey} completed final saving signal (4th loss) - resetting streak`);
    } else {
      consecutiveLosses[botKey] = currentLosses + 1;
      // console.log(`[App] ${botKey} lost - loss streak now: ${consecutiveLosses[botKey]}`);
    }
  }
}


function attemptAutoTrade(botKey, signal) {
  if (!isAutoTradeEnabled(botKey)) return;

  const side = (signal.side || signal.action || '').toUpperCase();
  if (!side) return;
  const currency = resolveCurrency(signal);
  const betSize = getAdjustedBetSize(botKey);  // Use adjusted bet (includes saving signal multiplier)
  const ts = signal.time || signal.openingTime || Date.now();
  const key = `${side}-${currency || ''}-${ts}`;
  if (lastTradeKey[botKey] === key) return;
  lastTradeKey[botKey] = key;

  // Send trade command immediately with zero latency
  sendToExtensionReliable({
    type: 'trade',
    bot: botKey,
    currency,
    side,
    betSize,
    timestamp: Date.now(),
    signalTime: ts
  }).catch(() => {});
}

function applyPhaseGlow(botKey, { phase, action, result }) {
  const container = botContainers[botKey];
  if (!container) return;
  const classes = ['glow-preparing', 'glow-buy', 'glow-sell', 'glow-win', 'glow-loss'];
  
  // Smooth transition: remove all classes first
  container.classList.remove(...classes);
  
  // Force reflow for smooth transition
  void container.offsetWidth;

  const upperPhase = (phase || '').toLowerCase();
  const upperAction = (action || '').toLowerCase();
  const upperResult = (result || '').toLowerCase();

  // Apply new glow class after micro-delay for smooth transition
  requestAnimationFrame(() => {
    if (upperPhase === 'preparing') {
      container.classList.add('glow-preparing');
      return;
    }
    if (upperPhase === 'signal') {
      if (upperAction === 'buy') container.classList.add('glow-buy');
      else if (upperAction === 'sell') container.classList.add('glow-sell');
      return;
    }
    if (upperPhase === 'trading result' || upperPhase === 'result') {
      if (upperResult === 'win') container.classList.add('glow-win');
      else if (upperResult === 'loss' || upperResult === 'lose') container.classList.add('glow-loss');
    }
  });
}

function addHistoryEntry(botKey, payload) {
  const list = signalHistory[botKey];
  if (!list) return;
  const ts = payload.timestamp || Date.now();
  const key = `${payload.phase || ''}-${payload.action || ''}-${ts}`;
  if (lastHistoryKey[botKey] === key) return; // prevent duplicates
  lastHistoryKey[botKey] = key;

  const entry = {
    ...payload,
    timestamp: ts
  };
  list.unshift(entry);
  if (list.length > 50) list.length = 50;

  // Recompute stats whenever history changes so UI reflects stored data
  try { computeStatsFromHistory(botKey); } catch (e) {}
} 

function renderHistoryModal(botKey) {
  const modal = document.getElementById('history-modal');
  const title = document.getElementById('historyModalTitle');
  const listEl = document.getElementById('historyList');
  if (!modal || !listEl || !title) return;

  title.textContent = `${botKey} - Signal History`;
  const items = signalHistory[botKey] || [];
  if (items.length === 0) {
    listEl.innerHTML = '<p style="color:#9aa0a6;text-align:center;padding:40px 0;">No history yet</p>';
  } else {
    listEl.innerHTML = items.map(item => {
      const phaseClass = (() => {
        const p = (item.phase || '').toLowerCase();
        if (p === 'signal') return item.action === 'BUY' ? 'buy' : 'sell';
        if (p === 'preparing') return 'preparing';
        if (p === 'trading result' || p === 'result') {
          if ((item.result || '').toLowerCase() === 'win') return 'win';
          if ((item.result || '').toLowerCase() === 'loss' || (item.result || '').toLowerCase() === 'lose') return 'loss';
        }
        return 'preparing';
      })();
      return `
        <div class="history-item">
          <div class="history-item-header">
            <span class="signal-phase ${phaseClass}">${(item.phase || '').toUpperCase()}</span>
            ${item.savingSignal ? `<span class="saving-signal-badge" style="background:#ff6b35;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;margin-left:8px;">${item.savingSignalText || 'SAVING SIGNAL'}</span>` : ''}
            <span class="signal-timestamp">${new Date(item.timestamp).toLocaleString()}</span>
          </div>
          <div class="signal-data">
            ${item.symbol || item.currency ? `<div class="signal-field"><span class="signal-field-label">Pair</span><strong class="signal-field-value">${item.symbol || item.currency}</strong></div>` : ''}
            ${item.action ? `<div class="signal-field"><span class="signal-field-label">Action</span><strong class="signal-field-value ${item.action.toLowerCase() === 'buy' ? 'buy' : 'sell'}">${item.action}</strong></div>` : ''}
            ${(() => {
              const openPrice = (item.openingPrice !== undefined && item.openingPrice !== null && item.openingPrice !== 'N/A') ? String(item.openingPrice) : '';
              const closePrice = (item.closingPrice !== undefined && item.closingPrice !== null && item.closingPrice !== 'N/A') ? String(item.closingPrice) : '';
              const openCombined = formatTimePriceStack(item.openingTime, openPrice);
              const closeCombined = formatTimePriceStack(item.closingTime, closePrice);
              return [
                openCombined ? `<div class="signal-field"><span class="signal-field-label">Open</span><strong class="signal-field-value">${openCombined}</strong></div>` : '',
                closeCombined ? `<div class="signal-field"><span class="signal-field-label">Close</span><strong class="signal-field-value">${closeCombined}</strong></div>` : ''
              ].join('');
            })()}
            ${item.result ? `<div class="signal-field"><span class="signal-field-label">Result</span><strong class="signal-field-value ${item.result.toLowerCase() === 'win' ? 'buy' : 'sell'}">${item.result}</strong></div>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  modal.classList.add('active');
}

function setWsStatus(state) {
  if (!wsStatusEl) return;
  wsStatusEl.classList.remove('online', 'offline', 'connecting');
  wsStatusEl.classList.add(state);
  if (state === 'online') wsStatusEl.textContent = 'WS Online';
  else if (state === 'connecting') wsStatusEl.textContent = 'WS Connecting';
  else wsStatusEl.textContent = 'WS Offline';
  
  // Update dashboard health indicator
  updateHealthWS(state);
}

// Coalesced scheduler for signal renders. Defers during resize and coalesces rapid updates using rAF
function scheduleRenderSignal(botKey, signal) {
  window.__renderQueue = window.__renderQueue || {};

  // If active resizing or low-power mode is enabled, defer heavy renders to the end of resize
  const isResizing = (typeof document !== 'undefined' && document.documentElement && document.documentElement.classList.contains('resizing')) || !!window.lowPowerResizeMode || !!window.__isResizing;
  if (isResizing) {
    window.__renderQueue[botKey] = signal;
    window.__pendingRenderDuringResize = true;
    return;
  }

  // Normal path: coalesce with rAF per-bot
  const q = window.__renderQueue;
  q[botKey] = signal;
  if (q._ticking) return;
  q._ticking = true;
  requestAnimationFrame(() => {
    try {
      const toRender = q[botKey];
      delete q[botKey];
      q._ticking = false;
      if (toRender) {
        try { renderSignalCard(botKey, toRender); } catch (e) { try { renderSignalCard(botKey, toRender); } catch (ee) {} }
      }
    } catch (e) { q._ticking = false; }
  });
}

function renderSignalCard(botKey, signal) {
  // Defer heavy signal renders while user is actively resizing the window to avoid jank
  try {
    if (document && document.documentElement && document.documentElement.classList.contains('resizing')) {
      window.__renderQueue = window.__renderQueue || {};
      window.__renderQueue[botKey] = signal;
      window.__pendingRenderDuringResize = true;
      return;
    }
  } catch (e) {}

  const display = signalDisplays[botKey];
  if (!display) return;
  const emptyState = signalEmptyStates[botKey];
  if (emptyState) emptyState.style.display = 'none';
  display.style.display = 'block';

  const phase = signal.phase || 'Signal';
  const currency = resolveCurrency(signal);
  const action = (signal.side || signal.action || '').toUpperCase();
  const price = signal.price ?? signal.openingPrice;
  const expiry = signal.expiry || signal.expiration || signal.duration;
  const openingTime = signal.openingTime || signal.time || '';
  const result = signal.result || '';
  const countdownVal = signal.countdown ? Math.max(0, Math.floor(signal.countdown)) : null;
  const countdownDisplay = countdownVal !== null ? formatCountdown(countdownVal) : null;
  const savingSignalText = getSavingSignalText(botKey);  // Show in all phases
  const savingMessage = getSavingSignalMessage(botKey);  // Show in all phases

  const rows = [];
  rows.push({ label: 'Phase', value: phase });
  if (currency) rows.push({ label: 'Pair', value: currency });
  
  if (phase !== 'Preparing') {
    if (action) {
      const valueClass = action === 'BUY' ? 'up' : (action === 'SELL' ? 'down' : '');
      rows.push({ label: 'Action', value: action, valueClass });
    }
    if (price !== undefined && price !== null && price !== 'N/A') rows.push({ label: 'Price', value: price });
    if (phase === 'Signal' && expiry) rows.push({ label: 'Expiry', value: expiry });
  }

  if (phase === 'Signal' && openingTime) rows.push({ label: 'Opens', value: openingTime });
  if (phase === 'Trading Result' && result) rows.push({ label: 'Result', value: result });
  if (phase === 'Trading Result') {
    const openPrice = (signal.openingPrice !== undefined && signal.openingPrice !== null && signal.openingPrice !== 'N/A') ? String(signal.openingPrice) : '';
    const closePrice = (signal.closingPrice !== undefined && signal.closingPrice !== null && signal.closingPrice !== 'N/A') ? String(signal.closingPrice) : '';
    const openCombined = formatTimePriceStack(signal.openingTime, openPrice);
    const closeCombined = formatTimePriceStack(signal.closingTime, closePrice);
    if (openCombined) rows.push({ label: 'Open', value: openCombined });
    if (closeCombined) rows.push({ label: 'Close', value: closeCombined });
  }

  const rowsHtml = rows.map(r => `
    <div class="signal-row"${r.kind ? ` data-kind="${r.kind}"` : ''}>
      <span class="label">${r.label}</span>
      <span class="value${r.valueClass ? ` ${r.valueClass}` : ''}">${r.value}</span>
    </div>`).join('');

  // Smooth transition: fade out old card before updating
  const existingCard = display.querySelector('.signal-card');
  if (existingCard) {
    existingCard.style.opacity = '0';
    existingCard.style.transform = 'translateY(-4px) scale(0.98)';
  }

  // Short delay for smooth transition
  setTimeout(() => {
    display.innerHTML = `
      <div class="signal-card">
        ${savingSignalText ? `<div class="saving-signal-banner">${savingSignalText}</div>` : ''}
        ${savingMessage ? `<div class="saving-signal-message">${savingMessage}</div>` : ''}
        ${countdownDisplay && phase !== 'Preparing' ? `<div class="signal-countdown"><span class="countdown-label">Countdown</span><span class="countdown-value" data-countdown="${botKey}">${countdownDisplay}</span></div>` : ''}
        ${rowsHtml}
      </div>
    `;
  }, existingCard ? 120 : 0);

  // History is sourced from Firestore 'trades' snapshots; avoid local duplicates here.

  // Apply localized glow on this bot container with smooth transition
  applyPhaseGlow(botKey, { phase, action, result });
}

// Flush any deferred signal renders after resize finishes
window.addEventListener('app:resize-finish', () => {
  if (!window.__pendingRenderDuringResize) return;
  const q = window.__renderQueue || {};
  Object.keys(q).forEach(k => {
    try {
      const s = q[k];
      if (s) renderSignalCard(k, s);
    } catch (e) {}
  });
  window.__renderQueue = {};
  window.__pendingRenderDuringResize = false;
});

function updateSignalCountdown(botKey, seconds) {
  const display = signalDisplays[botKey];
  if (!display) return;
  const el = display.querySelector('.countdown-value');
  if (el) el.textContent = formatCountdown(seconds);
}

// Example function to add a signal (call this when a new signal is received)
function addLumixSignal({ time, type, symbol, strength }) {
  if (!lumixSignalList) return;
  const li = document.createElement('li');
  li.className = 'bot-signal-item ' + (type === 'BUY' ? 'up' : 'down');
  li.innerHTML = `
    <span class="signal-time">${time}</span>
    <span class="signal-type">${type}</span>
    <span class="signal-symbol">${symbol}</span>
    <span class="signal-strength">${type === 'BUY' ? '▲' : '▼'} ${strength}</span>
  `;
  lumixSignalList.prepend(li);
  // Optionally limit to last 10 signals
  while (lumixSignalList.children.length > 10) {
    lumixSignalList.removeChild(lumixSignalList.lastChild);
  }
}


// --- Trade Console card wiring for bot detail views ---
const tradeCards = {
  LUMIX: document.querySelector('#section-bot1 .trade-card'),
  MIRAX: document.querySelector('#section-bot2 .trade-card'),
  ARVION: document.querySelector('#section-bot3 .trade-card')
};

const botCountdowns = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};

const botExpireAt = {
  LUMIX: 0,
  MIRAX: 0,
  ARVION: 0
};

// Auto-clear Trading Result after a short window so UI returns to the empty state.
const resultAutoClearTimers = {
  LUMIX: null,
  MIRAX: null,
  ARVION: null
};

// After a Trading Result, keep UI empty until the next Signal.
const suppressPreparingUntilSignal = {
  LUMIX: false,
  MIRAX: false,
  ARVION: false
};

function clearSignalUI(botKey) {
  const display = signalDisplays[botKey];
  const emptyState = signalEmptyStates[botKey];
  const container = botContainers[botKey];
  if (display) {
    display.innerHTML = '';
    display.style.display = 'none';
  }
  // Restore CSS-defined empty state layout (centers the content).
  if (emptyState) emptyState.style.display = '';

  // Remove any lingering glow overlay so the empty state looks like the offline view.
  if (container) {
    container.classList.remove('glow-preparing', 'glow-buy', 'glow-sell', 'glow-win', 'glow-loss');
  }
}

function scheduleResultAutoClear(botKey, delayMs) {
  try {
    if (resultAutoClearTimers[botKey]) {
      clearTimeout(resultAutoClearTimers[botKey]);
      resultAutoClearTimers[botKey] = null;
    }
  } catch (e) {}

  resultAutoClearTimers[botKey] = setTimeout(() => {
    try { clearActiveSignalFromFirebase(botKey); } catch (e) {}
    try { resetTradeCard(botKey); } catch (e) {}
    try { clearSignalUI(botKey); } catch (e) {}
  }, Math.max(0, Number(delayMs) || 0));
}

function cancelResultAutoClear(botKey) {
  try {
    if (resultAutoClearTimers[botKey]) {
      clearTimeout(resultAutoClearTimers[botKey]);
      resultAutoClearTimers[botKey] = null;
    }
  } catch (e) {}
}

function setTradeStatus(botKey, text) {
  const card = tradeCards[botKey];
  if (!card) return;
  const statusEl = card.querySelector('[data-field="status"]');
  if (statusEl) statusEl.textContent = text;
}

function resetTradeCard(botKey) {
  const card = tradeCards[botKey];
  if (!card) return;
  clearCountdown(botKey);
  card.classList.remove('pulse');
  setTradeStatus(botKey, 'Waiting for trades...');
  card.querySelectorAll('[data-field]').forEach(el => {
    if (el.dataset.field !== 'status') el.textContent = '--';
  });
}

function clearCountdown(botKey) {
  if (botCountdowns[botKey]) {
    clearInterval(botCountdowns[botKey]);
    botCountdowns[botKey] = null;
  }
  botExpireAt[botKey] = 0;
}

function startCountdown(botKey, seconds, label) {
  clearCountdown(botKey);
  const end = Date.now() + (seconds * 1000);
  botExpireAt[botKey] = end;

  const tick = () => {
    const remaining = Math.max(0, Math.floor((end - Date.now()) / 1000));
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    setTradeStatus(botKey, `${label} · ${mm}:${ss}`);
    if (label === 'Trading') updateSignalCountdown(botKey, remaining);
    if (remaining <= 0) clearCountdown(botKey);
  };

  tick();
  botCountdowns[botKey] = setInterval(tick, 1000);
}

function addTradeRow({ bot, time, symbol, side, price, sl, tp }) {
  const botKey = (bot || '').toUpperCase();
  const card = tradeCards[botKey];
  if (card) {
    const setField = (name, value) => {
      const el = card.querySelector(`[data-field="${name}"]`);
      if (el) el.textContent = value ?? '--';
    };

    setTradeStatus(botKey, 'Live signal');
    setField('time', time || '');
    setField('symbol', resolveCurrency({ symbol }));
    setField('side', (side || '').toUpperCase());
    setField('price', price != null ? price : '');
    setField('sl', sl != null ? sl : '');
    setField('tp', tp != null ? tp : '');
    setField('expiry', '');

    card.classList.remove('pulse');
    void card.offsetWidth;
    card.classList.add('pulse');
    setTimeout(() => card.classList.remove('pulse'), 1200);
  }

  // Also reflect in the signal card UI
  const remaining = Math.max(0, Math.floor((botExpireAt[botKey] - Date.now()) / 1000));
  scheduleRenderSignal(botKey, { bot, time, symbol, side, price, sl, tp, phase: 'Signal', countdown: remaining });

  dashboardStats.totalTrades++;
  addRecentActivity(botKey, side, symbol, time);
  updateDashboardStats();
}

function handlePhaseMessage(signal) {
  if (!signal || !signal.phase || !signal.bot) return false;
  const botKey = (signal.bot || '').toUpperCase();

  // Normalize common phase values (case-insensitive, supports "result")
  const phaseRaw = String(signal.phase || '').trim();
  const phaseLower = phaseRaw.toLowerCase();
  const phase = (phaseLower === 'preparing')
    ? 'Preparing'
    : (phaseLower === 'signal')
      ? 'Signal'
      : (phaseLower === 'trading result' || phaseLower === 'result')
        ? 'Trading Result'
        : phaseRaw;
  // Mutate in-place so WS onmessage downstream checks see the canonical phase.
  if (phase && phase !== signal.phase) signal.phase = phase;

  lastLocalPhaseUpdate[botKey] = Date.now();
  const defaultTradeSeconds = getDefaultTradeSeconds(botKey);
  const prepareDuration = phase === 'Preparing' ? (signal.countdown || signal.duration || getDefaultPrepareSeconds()) : 0;
  const prepareSeconds = phase === 'Preparing' ? Math.max(prepareDuration, getDefaultPrepareSeconds()) : 0;
  const tradeDuration = phase === 'Signal' ? (signal.duration || signal.countdown || defaultTradeSeconds) : 0;
  const tradeSeconds = phase === 'Signal' ? Math.max(tradeDuration, defaultTradeSeconds) : 0;

  // Set expiration/duration if provided
  const expiry = signal.expiry || signal.expiration || signal.duration;
  const card = tradeCards[botKey];
  if (card && expiry) {
    const el = card.querySelector('[data-field="expiry"]');
    if (el) el.textContent = expiry;
  }

  if (phase === 'Preparing') {
    // If the bot is switching to a new pair, reset the live loss streak so the new pair
    // starts from base bet (prevents cross-symbol saving-signal multipliers).
    try {
      if (SINGLE_ACTIVE_CHAIN_BOTS.has(botKey)) {
        const symKey = canonChainSymbolKey(resolveCurrency(signal));
        if (symKey) {
          const prevKey = activeChainSymbol[botKey];
          if (prevKey && prevKey !== symKey) consecutiveLosses[botKey] = 0;
          activeChainSymbol[botKey] = symKey;
        }
      }
    } catch (e) {}

    // Always allow Preparing UI updates (even right after a result).
    suppressPreparingUntilSignal[botKey] = false;

    // Normal Preparing behavior (not suppressed)
    cancelResultAutoClear(botKey);

    resetTradeCard(botKey);
    startCountdown(botKey, prepareSeconds || getDefaultPrepareSeconds(), 'Preparing');
    scheduleRenderSignal(botKey, { ...signal, countdown: null, openingTime: null, price: null });

    // Save active signal to Firebase for real-time sync across all users
    saveActiveSignalToFirebase(botKey, {
      phase: 'Preparing',
      duration: prepareSeconds || getDefaultPrepareSeconds(),
      selectedCurrency: resolveCurrency(signal)
    });

    // Send currency selection and bet size to extension only if auto-trade is enabled
    if (isAutoTradeEnabled(botKey)) {
      const currency = resolveCurrency(signal);
      const betSize = getAdjustedBetSize(botKey); // Use adjusted bet with saving signal multiplier
      if (currency) {
        // console.log(`[App] Sending currency selection for ${botKey}: ${currency}, bet size: ${betSize}`);
        sendToExtensionReliable({
          type: 'select-currency',
          bot: botKey,
          currency: currency,
          betSize: betSize,
          timestamp: Date.now()
        }).catch(() => {});
      }
    }

    return true; // handled; no trade row
  }

  if (phase === 'Signal') {
    cancelResultAutoClear(botKey);
    suppressPreparingUntilSignal[botKey] = false;
    // Track active symbol for single-active-chain bots; reset streak if symbol changed.
    try {
      if (SINGLE_ACTIVE_CHAIN_BOTS.has(botKey)) {
        const symKey = canonChainSymbolKey(resolveCurrency(signal));
        if (symKey) {
          const prevKey = activeChainSymbol[botKey];
          if (prevKey && prevKey !== symKey) consecutiveLosses[botKey] = 0;
          activeChainSymbol[botKey] = symKey;
        }
      }
    } catch (e) {}

    const isUpdateOnly = !!signal.updateOnly || String(signal.updateKind || '').toLowerCase() === 'openingprice';

    // Update-only Signal message: adjust opening price without restarting countdown / re-trading.
    if (isUpdateOnly) {
      const updatedPrice = (signal.price != null ? signal.price : (signal.openingPrice != null ? signal.openingPrice : null));
      if (updatedPrice != null) lastSignalPrice[botKey] = updatedPrice;
      // Do NOT bump lastSignalSeenAtLocal here; this is not a new signal.

      // If the bot provides an updated openingTime (execution moment), shift our stored opening time
      // and re-anchor the countdown so open->close duration stays consistent.
      const updatedOpenMs = toEpochMs(signal.openingTime);
      const durSec = Math.max(
        Number(signal.duration || signal.countdown || 0) || 0,
        Number(getDefaultTradeSeconds(botKey) || 0) || 0
      );
      if (updatedOpenMs && Number.isFinite(durSec) && durSec > 0) {
        lastSignalTime[botKey] = updatedOpenMs;
        const newEndMs = updatedOpenMs + (durSec * 1000);
        botExpireAt[botKey] = newEndMs;
        const remaining = Math.max(0, Math.ceil((newEndMs - Date.now()) / 1000));
        startCountdown(botKey, remaining, 'Trading');
      } else {
        if (!lastSignalTime[botKey] && (signal.time || signal.timestamp)) {
          lastSignalTime[botKey] = signal.time || signal.timestamp;
        }
      }

      // Keep current countdown; if missing, fall back to default duration.
      const remaining = botExpireAt[botKey]
        ? Math.max(0, Math.floor((botExpireAt[botKey] - Date.now()) / 1000))
        : (tradeSeconds || defaultTradeSeconds);
      if (!botExpireAt[botKey] && remaining > 0) startCountdown(botKey, remaining, 'Trading');

      scheduleRenderSignal(botKey, {
        ...signal,
        phase: 'Signal',
        price: lastSignalPrice[botKey] ?? signal.price,
        openingPrice: signal.openingPrice ?? lastSignalPrice[botKey] ?? signal.price,
        countdown: remaining
      });
      applyPhaseGlow(botKey, { phase: 'Signal', action: signal.action || signal.side });

      // Best-effort sync without resetting startTime.
      patchActiveSignalInFirebase(botKey, {
        phase: 'Signal',
        price: lastSignalPrice[botKey] ?? signal.price,
        openingPrice: signal.openingPrice ?? lastSignalPrice[botKey] ?? signal.price,
        // If provided, shift startTime so other users' countdown aligns with execution moment.
        ...(updatedOpenMs ? { startTime: updatedOpenMs, time: signal.openingTime } : {}),
        updateOnly: true,
        updateKind: signal.updateKind || 'openingPrice'
      });

      return true;
    }

    // Store opening price and time for later use in Trading Result
    lastSignalPrice[botKey] = signal.price;
    lastSignalTime[botKey] = signal.time || signal.timestamp;
    lastSignalSeenAtLocal[botKey] = Date.now();
    try { updateBotActivityBadges(); } catch (e) {}

    startCountdown(botKey, tradeSeconds || defaultTradeSeconds, 'Trading');
    scheduleRenderSignal(botKey, { ...signal, countdown: tradeSeconds || defaultTradeSeconds });

    // Save active signal to Firebase for real-time sync across all users
    saveActiveSignalToFirebase(botKey, {
      phase: 'Signal',
      duration: tradeSeconds || defaultTradeSeconds,
      action: signal.action || signal.side,
      currency: resolveCurrency(signal),
      price: signal.price,
      sl: signal.sl,
      tp: signal.tp,
      time: signal.time || signal.timestamp
    });

    // Always attempt auto-trade on Signal (some bots may omit trade-row fields like price)
    attemptAutoTrade(botKey, signal);

    return false; // let trade row update the card fields
  }

  if (phase === 'Trading Result') {
    suppressPreparingUntilSignal[botKey] = true;
    // Ignore stale results for other symbols (prevents cross-symbol streak pollution and UI flicker).
    try {
      if (SINGLE_ACTIVE_CHAIN_BOTS.has(botKey)) {
        const symKey = canonChainSymbolKey(resolveCurrency(signal));
        const activeKey = activeChainSymbol[botKey];
        if (symKey && !activeKey) activeChainSymbol[botKey] = symKey;
        if (activeKey && symKey && activeKey !== symKey) {
          return true;
        }
      }
    } catch (e) {}

    clearCountdown(botKey);
    setTradeStatus(botKey, `Result: ${signal.result || ''}`);

    // Use stored opening price/time from the Signal phase; use closing price/time from the Result payload.
    const openingPrice =
      lastSignalPrice[botKey] ??
      signal.openingPrice ??
      signal.opening_price ??
      signal.openPrice ??
      signal.open_price ??
      signal.entryPrice ??
      signal.entry_price ??
      signal.price;
    const openingTime =
      toEpochMs(lastSignalTime[botKey]) ??
      toEpochMs(signal.openingTime) ??
      toEpochMs(signal.opening_time) ??
      toEpochMs(signal.startTime) ??
      toEpochMs(signal.timestamp) ??
      toEpochMs(signal.time) ??
      lastSignalTime[botKey] ??
      signal.time;

    const closingTime =
      toEpochMs(signal.closingTime) ??
      toEpochMs(signal.closing_time) ??
      toEpochMs(signal.closeTime) ??
      toEpochMs(signal.close_time) ??
      toEpochMs(signal.closedAt) ??
      toEpochMs(signal.closed_at) ??
      toEpochMs(signal.endTime) ??
      toEpochMs(signal.end_time) ??
      toEpochMs(signal.time) ??
      toEpochMs(signal.timestamp) ??
      Date.now();
    const closingPrice =
      signal.closingPrice ??
      signal.closing_price ??
      signal.closePrice ??
      signal.close_price ??
      signal.exitPrice ??
      signal.exit_price ??
      signal.price;

    scheduleRenderSignal(botKey, {
      ...signal,
      openingPrice,
      openingTime,
      closingPrice,
      closingTime
    });

    // Remove previous Preparing and Signal phase entries from history when result arrives
    if (signalHistory[botKey]) {
      signalHistory[botKey] = signalHistory[botKey].filter(entry =>
        entry.phase === 'Trading Result' ||
        (entry.timestamp > Date.now() - 300000) // Keep entries from last 5 minutes as fallback
      );
    }

    // Save active result to Firebase temporarily (visible for 15 seconds)
    saveActiveSignalToFirebase(botKey, {
      phase: 'Trading Result',
      duration: 15,
      result: signal.result,
      profit: signal.profit,
      currency: signal.currency || signal.symbol
    });

    // Update *live* loss streak based on result.
    // IMPORTANT: Only do this when we have a matching Signal context in this session.
    // Otherwise, a stale/global result pushed on connect can incorrectly set the next
    // Signal as a "Saving Signal" for a brand-new session.
    try {
      const maxWindowMs = (getDefaultTradeSeconds(botKey) + 180) * 1000; // add grace
      const sinceSignalMs = Date.now() - (lastSignalSeenAtLocal[botKey] || 0);
      const hasRecentSignal = (lastSignalSeenAtLocal[botKey] || 0) > 0 && sinceSignalMs >= 0 && sinceSignalMs <= maxWindowMs;
      if (hasRecentSignal) {
        updateLossStreak(botKey, signal.result);
      }
    } catch (e) {}

    // MIRAX special-case: it may skip repeated Preparing phases after a loss.
    // Update bet size ("price") immediately after a LOSS so the extension has time
    // before the next Signal phase. Do NOT re-select currency for MIRAX.
    try {
      const r = String(signal.result || '').toLowerCase().trim();
      const isLoss = r === 'loss' || r === 'lose' || r === 'lost' || r === 'l';
      if (botKey === 'MIRAX' && isLoss && isAutoTradeEnabled(botKey)) {
        const betSize = getAdjustedBetSize(botKey);
        if (Number.isFinite(Number(betSize)) && Number(betSize) > 0) {
          sendToExtensionReliable({
            type: 'set-bet-size',
            bot: botKey,
            betSize: Number(betSize),
            timestamp: Date.now()
          }).catch(() => {});
        }
      }
    } catch (e) {}

    // Save to history
    addToHistory(botKey, {
      ...signal,
      openingPrice,
      openingTime,
      closingPrice,
      closingTime
    });

    // Keep Trading Result visible for up to 15 seconds, then clear back to the empty state.
    scheduleResultAutoClear(botKey, 15000);

    return false;
  }

  return false;
}



// --- Load runtime config (wsServer) ---
// Packaged builds do not ship with config.json (intentionally excluded),
// so default to the global hub WS endpoint.
let wsUrl = 'wss://utkingdom.com/ws';
let wsFallbackTried = false;
try {
  const config = require('./config.json');
  if (config && config.wsServer) wsUrl = config.wsServer;
} catch (e) {
  // console.warn('Could not load config.json, using default wss://utkingdom.com/ws');
}
// console.log('Connecting to WS server at', wsUrl);
if (wsStatusEl) setWsStatus('connecting');

// --- WebSocket for receiving signals from Python server ---
// Reconnect + heartbeat wrapper
let ws;
let reconnectAttempts = 0;
let heartbeatIntervalId = null;

function createWebSocket() {
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    // console.error('Failed to create WebSocket', e);
    if (wsStatusEl) setWsStatus('offline');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempts = 0;
    window.__wsIsOnline = true;
    console.log('WebSocket connected to', wsUrl);
    console.log('%cWS ONLINE', 'color:#23d18b;font-weight:bold;');
    if (wsStatusEl) setWsStatus('online');
    // start heartbeat (send ping every 30s to reduce traffic)
    if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (e) {
        // will trigger onerror/onclose and reconnect
      }
    }, 30000);
  };

  ws.onmessage = function(event) {
    try {
      console.log('%c[WS MSG]', 'color:#0ff;font-weight:bold;', event.data);
      const signal = JSON.parse(event.data);
      // Extra debug: highlight ARVION signals and missing bot/phase
      if (signal && signal.bot && String(signal.bot).toUpperCase() === 'ARVION') {
        console.log('%c[ARVION WS]', 'color:#ff0;font-weight:bold;', signal);
      } else if (signal && signal.bot) {
        console.log('%c[WS BOT]', 'color:#0f0;font-weight:bold;', signal.bot, signal);
      } else {
        console.log('%c[WS NO BOT]', 'color:#f00;font-weight:bold;', signal);
      }

      if (signal.clear) {
        if (lumixSignalList) lumixSignalList.innerHTML = '';
        if (signal.bot) {
          resetTradeCard((signal.bot || '').toUpperCase());
        } else {
          Object.keys(tradeCards).forEach(resetTradeCard);
        }
        return;
      }
      // ignore ping responses
      if (signal.type && signal.type === 'pong') return;
      // Handle phase-only messages (preparing / signal / result) - immediate processing
      const handledPhase = handlePhaseMessage(signal);
      if (handledPhase) return;
      // If we already handled a Trading Result phase, avoid trade-row overwrite
      if (signal.phase && signal.phase === 'Trading Result') {
        return;
      }

      // Trade row payload detection - immediate processing
      if (
        signal &&
        (signal.side || signal.action) &&
        signal.price !== undefined &&
        signal.bot
      ) {
        const botKey = (signal.bot || '').toUpperCase();
        if (SINGLE_ACTIVE_CHAIN_BOTS.has(botKey)) {
          const symKey = canonChainSymbolKey(resolveCurrency(signal));
          const activeKey = activeChainSymbol[botKey];
          if (symKey && !activeKey) {
            activeChainSymbol[botKey] = symKey;
          } else if (activeKey && symKey && activeKey !== symKey) {
            // Fallback: some feeds may jump straight to a signal row without a Preparing phase.
            // Treat this as a new chain start and reset the live loss streak.
            consecutiveLosses[botKey] = 0;
            activeChainSymbol[botKey] = symKey;
          }
        }
        addTradeRow({
          bot: signal.bot,
          time: signal.time,
          symbol: signal.symbol || signal.currency || signal.selectedCurrency,
          side: signal.side || signal.action,
          price: signal.price,
          sl: signal.sl,
          tp: signal.tp
        });
        attemptAutoTrade((signal.bot || '').toUpperCase(), signal);
        return;
      }
      // Fallback to LUMIX signal card list format
      addLumixSignal(signal);
    } catch (err) {
      // console.warn('Invalid WS message', event.data);
    }
  };

  ws.onerror = (err) => {
    // console.error('WebSocket error', err);
    // console.log('%cWS ERROR', 'color:#ffb347;font-weight:bold;');
    if (wsStatusEl) setWsStatus('offline');
  };

  ws.onclose = (ev) => {
    // console.log('WebSocket closed', ev && ev.code, ev && ev.reason);
    // console.log('%cWS OFFLINE', 'color:#ff6b6b;font-weight:bold;');
    if (wsStatusEl) setWsStatus('offline');
    window.__wsIsOnline = false;
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect(immediate) {
  reconnectAttempts++;
  const delay = immediate ? 0 : Math.min(30000, 1000 * Math.pow(1.5, reconnectAttempts)); // backoff up to 30s
  // console.log(`Reconnecting in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts})`);
  if (wsStatusEl) setWsStatus('connecting');
  setTimeout(() => {
    createWebSocket();
  }, delay);
}

// --- Update Button Handler ---
const checkUpdatesBtn = document.getElementById('checkUpdatesBtn');
const updateStatus = document.getElementById('updateStatus');

if (checkUpdatesBtn) {
  checkUpdatesBtn.addEventListener('click', async () => {
    checkUpdatesBtn.disabled = true;
    checkUpdatesBtn.textContent = 'Checking...';
    updateStatus.style.display = 'block';
    updateStatus.textContent = 'Checking for updates...';
    updateStatus.style.color = '#ffb347';

    try {
      const updateInfo = await checkForUpdates();
      checkUpdatesBtn.disabled = false;
      checkUpdatesBtn.textContent = 'Check for Updates';

      if (updateInfo && updateInfo.disabled) {
        updateStatus.textContent = 'Updates are disabled for this install.';
        updateStatus.style.color = '#ffb347';
        return;
      }

      if (updateInfo && updateInfo.hasUpdate) {
        updateStatus.textContent = `Update available: v${updateInfo.latestVersion}. Downloading...`;
        updateStatus.style.color = '#23d18b';
        try { await ipcRenderer.invoke('download-update'); } catch (e) {}
      } else {
        updateStatus.textContent = 'You are on the latest version.';
        updateStatus.style.color = '#23d18b';
        setTimeout(() => {
          updateStatus.style.display = 'none';
        }, 3000);
      }
    } catch (err) {
      checkUpdatesBtn.disabled = false;
      checkUpdatesBtn.textContent = 'Check for Updates';
      updateStatus.textContent = 'Update check failed: ' + err.message;
      updateStatus.style.color = '#ff6b6b';
    }
  });
}

// Listen for update-available event from main process
ipcRenderer.on('update-available', (event, version) => {
  // console.log('%cUPDATE AVAILABLE', 'color:#23d18b;font-weight:bold;', version);
  const v = (version && typeof version === 'object') ? (version.version || '') : (version || '');
  if (updateStatus) {
    updateStatus.style.display = 'block';
    updateStatus.textContent = `Update v${v} available. Downloading...`;
    updateStatus.style.color = '#23d18b';
  }
});

ipcRenderer.on('update-download-progress', (event, progress) => {
  if (!updateStatus) return;
  const percent = progress && typeof progress.percent === 'number' ? Math.round(progress.percent) : null;
  if (percent === null) return;
  updateStatus.style.display = 'block';
  updateStatus.textContent = `Downloading update... ${percent}%`;
  updateStatus.style.color = '#ffb347';
});

ipcRenderer.on('update-not-available', () => {
  if (!updateStatus) return;
  updateStatus.style.display = 'block';
  updateStatus.textContent = 'You are on the latest version.';
  updateStatus.style.color = '#23d18b';
  setTimeout(() => {
    updateStatus.style.display = 'none';
  }, 3000);
});

ipcRenderer.on('update-error', (event, payload) => {
  if (!updateStatus) return;
  const msg = payload && payload.message ? payload.message : 'Update error';
  updateStatus.style.display = 'block';
  updateStatus.textContent = `Update error: ${msg}`;
  updateStatus.style.color = '#ff6b6b';
});

ipcRenderer.on('update-downloaded', (event, version) => {
  // console.log('%cUPDATE DOWNLOADED', 'color:#23d18b;font-weight:bold;', version);
  const v = (version && typeof version === 'object') ? (version.version || '') : (version || '');
  if (updateStatus) {
    updateStatus.style.display = 'block';
    updateStatus.innerHTML = `Update v${v} downloaded. <a href="#" id="restartBtn" style="color:#0ff; text-decoration:underline;">Restart now</a>`;
    updateStatus.style.color = '#23d18b';

    const restartBtn = document.getElementById('restartBtn');
    if (restartBtn) {
      restartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        ipcRenderer.invoke('restart-app');
      });
    }
  }
});




auth.onAuthStateChanged((user) => {
  if (user) {
    // console.log('[App] User logged in, setting up Firebase listeners');
    setupFirebaseHistoryListeners();


  } else {


    // console.log('[App] User logged out, clearing history');
    // Clear history listeners
    Object.keys(historyListeners).forEach(botKey => {
      if (historyListeners[botKey]) {
        historyListeners[botKey]();
        historyListeners[botKey] = null;
      }
    });
    // Clear active signal listeners
    Object.keys(activeSignalListeners).forEach(botKey => {
      if (activeSignalListeners[botKey]) {
        activeSignalListeners[botKey]();
        activeSignalListeners[botKey] = null;
      }
    });
    // Clear history
    signalHistory.LUMIX = [];
    signalHistory.MIRAX = [];
    signalHistory.ARVION = [];
    // Reflect cleared state in activity badges
    try { updateBotActivityBadges(); } catch (e) {}
  }
});
createWebSocket();