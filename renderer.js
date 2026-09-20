// Quiet renderer error logging — do not paint a full-screen black overlay for every glitch.
window.addEventListener('error', (e) => {
  try { console.error('Renderer uncaught error', e.error || e.message || e); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { console.error('Renderer unhandled rejection', e.reason || e); } catch {}
});

// ensure zoom-controls script loads so header buttons are interactive
try { require('./ui-scaling.js'); } catch (e) {}
try { require('./zoom-controls.js'); } catch (e) {}
try { require('./auth-visualizer.js'); } catch (e) {}
const { ipcRenderer } = require('electron');
let getBalanceSync = null;
try { ({ getBalanceSync } = require('./dashboard-balance-sync.js')); } catch (e) {}

function showCloseTrayModal() {
  try {
    require('./exit-tray-modal.js').show();
  } catch (e) {}
}


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
      homeSubscriptionStatus.textContent = subscriptionPill.textContent || '…';
      try {
        const obs2 = new MutationObserver(() => {
          homeSubscriptionStatus.textContent = subscriptionPill.textContent || '…';
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
          { tag: 'UI', text: 'Cleaner login and home experience across desktop.' },
          { tag: 'Auto Trade', text: 'Warns when a recovery chain is already running.' },
          { tag: 'Install', text: 'Installer can pick folder and always creates a desktop shortcut.' },
          { tag: 'Updates', text: 'Faster reopen after update, plus notification click opens the right bot.' },
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
        // Only run if Home price chips exist
        if (!elBtcPrice && !elEthPrice && !elMarketCap) return;

        // Avoid piling up concurrent requests.
        if (marketPulseState.inFlight) return;

        const nowMs = Date.now();
        // If we got rate-limited, pause requests for a bit.
        if (nowMs < marketPulseState.backoffUntil) {
          if (elNote) {
            elNote.style.display = 'block';
            elNote.textContent = 'Market data paused (rate limited).';
          }
          return;
        }

        if (elNote) {
          elNote.style.display = 'none';
          elNote.textContent = '';
        }

        // Placeholders
        if (elMarketCap) elMarketCap.textContent = '…';
        if (elMarketVolume) elMarketVolume.textContent = '…';
        if (elActiveCryptos) elActiveCryptos.textContent = '…';
        if (elBtcDomLine) elBtcDomLine.textContent = '…';
        if (elBtcPrice) elBtcPrice.textContent = '…';
        if (elEthPrice) elEthPrice.textContent = '…';
        setChange(elBtcChange, NaN);
        setChange(elEthChange, NaN);

        try {
          marketPulseState.inFlight = true;

          const needGlobal = !!(elMarketCap || elMarketVolume || elActiveCryptos || elBtcDomLine) &&
            (!marketPulseState.global.data || (nowMs - marketPulseState.global.ts > GLOBAL_TTL_MS));
          const needPrice = !!(elBtcPrice || elEthPrice) &&
            (!marketPulseState.price.data || (nowMs - marketPulseState.price.ts > PRICE_TTL_MS));

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

          if (!priceJson && !globalJson) throw new Error('Market data request failed');

          if (globalJson) {
            const marketCapUsd = globalJson?.data?.total_market_cap?.usd;
            const marketVolUsd = globalJson?.data?.total_volume?.usd;
            const btcDomPct = globalJson?.data?.market_cap_percentage?.btc;
            const activeCryptos = globalJson?.data?.active_cryptocurrencies;
            if (elMarketCap && Number.isFinite(marketCapUsd)) elMarketCap.textContent = fmtUsdCompact.format(marketCapUsd);
            if (elMarketVolume && Number.isFinite(marketVolUsd)) elMarketVolume.textContent = fmtUsdCompact.format(marketVolUsd);
            if (elActiveCryptos && Number.isFinite(activeCryptos)) elActiveCryptos.textContent = new Intl.NumberFormat('en-US').format(activeCryptos);
            if (elBtcDomLine && Number.isFinite(btcDomPct)) elBtcDomLine.textContent = fmtPct.format(btcDomPct / 100);
          }

          if (priceJson) {
            const btcUsd = priceJson?.bitcoin?.usd;
            const btcCh = priceJson?.bitcoin?.usd_24h_change;
            const ethUsd = priceJson?.ethereum?.usd;
            const ethCh = priceJson?.ethereum?.usd_24h_change;
            if (elBtcPrice && Number.isFinite(btcUsd)) elBtcPrice.textContent = fmtUsd.format(btcUsd);
            if (elEthPrice && Number.isFinite(ethUsd)) elEthPrice.textContent = fmtUsd.format(ethUsd);
            setChange(elBtcChange, btcCh);
            setChange(elEthChange, ethCh);
          }

          if (elUpdated) {
            const now = new Date();
            elUpdated.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          }
        } catch (err) {
          if (elNote) {
            elNote.style.display = 'block';
            elNote.textContent = (err && err.message === 'rate_limited')
              ? 'Market data paused (rate limited).'
              : 'Market data unavailable (offline or rate limited).';
          }
          if (elUpdated) elUpdated.textContent = '…';
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

  // ui-scaling.js owns resize + scale. Do not re-dispatch synthetic resize
  // events here (that freezes login bars and breaks layout during drag).
  function updateAppScale() {
    try {
      if (typeof window.__updateAppScale === 'function') window.__updateAppScale();
    } catch (e) {}
  }

  updateAppScale();
  window.lowPowerResizeMode = false;
  window.toggleLowPowerResizeMode = function(v) { window.lowPowerResizeMode = (typeof v === 'boolean') ? v : !window.lowPowerResizeMode; };
});
// console.log('renderer.js loaded'); // Production: disabled
require('./themeswitch.js');
require('./auth-verification.js');
require('./connection-system.js');

// Import Firebase for trading history
const { auth, db } = require('./auth-verification.js');
const { collection, query, orderBy, limit, onSnapshot, doc, setDoc, getDoc, updateDoc, deleteDoc, runTransaction, getDocsFromCache } = require('firebase/firestore');
const botStore = require('./firebase-bot-paths.js');

// Auto-update checker
const { checkForUpdates, showUpdateModal } = require('./update-checker.js');

function setForcedUpdateModalVisible(visible) {
  try {
    if (window.__utkUpdateUi && typeof window.__utkUpdateUi.setForcedUpdateModalVisible === 'function') {
      window.__utkUpdateUi.setForcedUpdateModalVisible(visible);
      return;
    }
  } catch (e) {}
  try {
    const modal = document.getElementById('update-modal');
    if (!modal) return;
    if (visible) modal.classList.add('active');
    else modal.classList.remove('active');
  } catch (e) {}
}

// Sidebar & Bot panel toggles
try {
  const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
  const toggleBotPanelBtn = document.getElementById('toggleBotPanelBtn');
  const sectionToggleButtons = document.querySelectorAll('.ui-section-toggle');
  let sidebarAnimationTimer = null;
  const sectionAnimationTimers = new Map();

  const applySidebarState = (collapsed, animate = true) => {
    try {
      const body = document.body;
      if (!animate) {
        body.classList.toggle('sidebar-collapsed', collapsed);
        body.classList.remove('sidebar-animating');
        return;
      }

      body.classList.add('sidebar-animating');
      window.requestAnimationFrame(() => {
        body.classList.toggle('sidebar-collapsed', collapsed);
      });

      if (sidebarAnimationTimer) {
        clearTimeout(sidebarAnimationTimer);
      }
      sidebarAnimationTimer = window.setTimeout(() => {
        try { body.classList.remove('sidebar-animating'); } catch (e) {}
      }, 360);
    } catch (e) {}
  };
  const applyBotPanelState = (hidden) => {
    try { if (hidden) document.body.classList.add('bot-panel-hidden'); else document.body.classList.remove('bot-panel-hidden'); } catch (e) {}
  };

  const applyBotSectionState = (sectionId, collapsed, animate = true) => {
    try {
      const section = document.getElementById(sectionId);
      if (!section) return;
      if (!animate) {
        section.classList.toggle('bot-section-collapsed', collapsed);
        section.classList.remove('bot-section-animating');
        return;
      }

      section.classList.add('bot-section-animating');
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          section.classList.toggle('bot-section-collapsed', collapsed);
        });
      });

      const prevTimer = sectionAnimationTimers.get(sectionId);
      if (prevTimer) {
        clearTimeout(prevTimer);
      }
      const nextTimer = window.setTimeout(() => {
        try { section.classList.remove('bot-section-animating'); } catch (e) {}
        try { sectionAnimationTimers.delete(sectionId); } catch (e) {}
      }, 420);
      sectionAnimationTimers.set(sectionId, nextTimer);
    } catch (e) {}
  };

  // Load persisted state
  try {
    const collapsed = localStorage.getItem('ui_sidebar_collapsed') === '1';
    applySidebarState(collapsed, false);
    if (toggleSidebarBtn) {
      try { toggleSidebarBtn.classList.toggle('active', collapsed); toggleSidebarBtn.setAttribute('aria-pressed', collapsed ? 'true' : 'false'); } catch (e) {}
    }
  } catch (e) {}
  try {
    const hidden = localStorage.getItem('ui_botpanel_hidden') === '1';
    applyBotPanelState(hidden);
    if (toggleBotPanelBtn) {
      try { toggleBotPanelBtn.classList.toggle('active', hidden); toggleBotPanelBtn.setAttribute('aria-pressed', hidden ? 'true' : 'false'); } catch (e) {}
    }
  } catch (e) {}

  try {
    sectionToggleButtons.forEach((button) => {
      const sectionId = button.getAttribute('data-target-section');
      if (!sectionId) return;
      const section = document.getElementById(sectionId);
      const collapsed = section ? section.classList.contains('bot-section-collapsed') : false;
      button.classList.toggle('active', collapsed);
      button.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      button.addEventListener('click', (e) => {
        try {
          const nextCollapsed = !(section && section.classList.contains('bot-section-collapsed'));
          applyBotSectionState(sectionId, nextCollapsed, true);
          button.classList.toggle('active', nextCollapsed);
          button.setAttribute('aria-pressed', nextCollapsed ? 'true' : 'false');
        } catch (err) {}
      });
    });
  } catch (e) {}

  if (toggleSidebarBtn) {
    toggleSidebarBtn.addEventListener('click', (e) => {
      try {
        const collapsed = !document.body.classList.contains('sidebar-collapsed');
        applySidebarState(collapsed, true);
        localStorage.setItem('ui_sidebar_collapsed', collapsed ? '1' : '0');
        try { toggleSidebarBtn.classList.toggle('active', collapsed); toggleSidebarBtn.setAttribute('aria-pressed', collapsed ? 'true' : 'false'); } catch (e) {}
      } catch (e) {}
    });
  }
  if (toggleBotPanelBtn) {
    toggleBotPanelBtn.addEventListener('click', (e) => {
      try {
        const hidden = !document.body.classList.contains('bot-panel-hidden');
        applyBotPanelState(hidden);
        localStorage.setItem('ui_botpanel_hidden', hidden ? '1' : '0');
        try { toggleBotPanelBtn.classList.toggle('active', hidden); toggleBotPanelBtn.setAttribute('aria-pressed', hidden ? 'true' : 'false'); } catch (e) {}
      } catch (e) {}
    });
  }
} catch (e) {}

function updateForcedUpdateModalUI({ version, message, percent } = {}) {
  try {
    if (window.__utkUpdateUi && typeof window.__utkUpdateUi.updateForcedUpdateModalUI === 'function') {
      window.__utkUpdateUi.updateForcedUpdateModalUI({ version, message, percent });
      return;
    }
  } catch (e) {}
  try {
    const modal = document.getElementById('update-modal');
    if (!modal) return;
    const versionText = version ? `v${String(version).replace(/^v/i, '')}` : '';
    try {
      const spans = modal.querySelectorAll('.update-version');
      spans.forEach((el) => { try { if (versionText) el.textContent = versionText; } catch (e) {} });
    } catch (e) {}

    const msgEl = document.getElementById('forcedUpdateMessage') || modal.querySelector('.confirm-message');
    if (msgEl && message) {
      try { msgEl.textContent = message; } catch (e) {}
    }

    if (typeof percent === 'number' && isFinite(percent)) {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      const fill = document.getElementById('forcedUpdateProgressFill');
      const text = document.getElementById('forcedUpdateProgressText');
      if (fill) fill.style.width = p + '%';
      if (text) text.textContent = p + '%';
    }
  } catch (e) {}
}

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

// Legacy visualizer disabled — live implementation is auth-visualizer.js
class MusicVisualizer {
  constructor() {
    // no-op stub to avoid double-init / black canvas paint
    if (window.musicVisualizer) return;
    try { require('./auth-visualizer.js'); } catch (e) {}
  }
  startAnimation() { try { window.musicVisualizer && window.musicVisualizer.startAnimation(); } catch (e) {} }
  stopAnimation() { try { window.musicVisualizer && window.musicVisualizer.stopAnimation(); } catch (e) {} }
  refresh() { try { window.musicVisualizer && window.musicVisualizer.refresh(); } catch (e) {} }
  resizeCanvas() {}
}

// Login atmosphere lives in auth-visualizer.js (WebGL silk).
window.enableMusicViz = window.enableMusicViz !== false;
function maybeInitVisualizer() {
  try {
    if (window.musicVisualizer && typeof window.musicVisualizer.refresh === 'function') {
      window.musicVisualizer.refresh();
    } else if (typeof require === 'function') {
      require('./auth-visualizer.js');
    }
  } catch (e) {}
}

// --- IPC for updates ---
// Wired in update-ui.js (loaded after renderer.js). Keep a no-op guard so
// older cached pages don't double-register if this block is ever reintroduced.
try {
  if (!window.__utk_update_ipc_wired) {
    // update-ui.js will set this flag when it attaches listeners.
  }
} catch (e) {}

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
    try { checkAndShowWelcomeUpdate(); } catch (e) {}
  });
} else {
  document.body.classList.add('app-loaded');
  initHeroLogoSpin();
    initializeUpdateChecker();
    try { checkAndShowWelcomeUpdate(); } catch (e) {}
}

  // Show a cinematic modal when the app version has changed since the last run
  async function checkAndShowWelcomeUpdate() {
    try {
      const res = await ipcRenderer.invoke('get-app-version');
      if (!res || !res.success) return;
      const current = String(res.version || '').trim();
      if (!current) return;
      const last = localStorage.getItem('utk:lastSeenVersion') || '';
      if (last && last !== current) {
        showWelcomeUpdateModal(current, last);
      }
      try { localStorage.setItem('utk:lastSeenVersion', current); } catch (e) {}
    } catch (e) {}
  }

  function showWelcomeUpdateModal(currentVersion, previousVersion) {
    try {
      const modal = document.getElementById('welcome-update-modal');
      const cta = document.getElementById('welcome-update-cta');
      const title = document.getElementById('welcome-update-title');
      const msg = document.getElementById('welcome-update-message');
      if (!modal) return;
      const cur = String(currentVersion || '').trim();
      const prev = String(previousVersion || '').trim();
      if (title) title.textContent = cur ? `You're on v${cur}` : "You're on the latest version";
      if (msg) {
        msg.textContent = prev && cur
          ? `You moved from v${prev} to v${cur}. Pocket Option connect is more portable, updates stay quiet until you restart, and the desk keeps the latest house-bot and Studio fixes.`
          : 'Pocket Option connect is more portable, updates stay quiet until you restart, and the desk keeps the latest house-bot and Studio fixes.';
      }

      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');

      function close() {
        try {
          modal.classList.remove('is-open');
          modal.setAttribute('aria-hidden', 'true');
        } catch (e) {}
      }

      if (cta) cta.onclick = () => {
        close();
        try {
          navigateToSection('main', document.getElementById('menu-main'));
        } catch (e) {}
      };
      const escHandler = (ev) => {
        if (ev.key === 'Escape') {
          close();
          window.removeEventListener('keydown', escHandler);
        }
      };
      window.addEventListener('keydown', escHandler);
    } catch (e) {}
  }

function navigateToSection(id, activeMenuItem = null) {
  const target = document.getElementById(`section-${id}`);
  if (!target) return;

  // Cancel in-flight LUMIX/MIRAX crossfade so it cannot re-activate a bot panel.
  try {
    if (window.utkBotTransitions && typeof window.utkBotTransitions.cancel === 'function') {
      window.utkBotTransitions.cancel();
    }
  } catch (e) {}

  menuItems.forEach(i => i.classList.remove('active'));
  if (activeMenuItem) activeMenuItem.classList.add('active');

  if (userCard) {
    if (id === 'profile') userCard.classList.add('active');
    else userCard.classList.remove('active');
  }

  // Hard swap under the section blackout (section-nav-fx). No leaving/entering
  // slide — that made text jump while both panels were visible.
  document.querySelectorAll('.section.active').forEach((el) => {
    if (el !== target) el.classList.remove('active', 'leaving', 'entering');
  });
  target.classList.add('active');
  target.classList.remove('leaving', 'entering');

  try {
    if (window.__utkAppPerf && typeof window.__utkAppPerf.tagInactiveSections === 'function') {
      window.__utkAppPerf.tagInactiveSections();
    }
  } catch (eTag) {}

  const scroller = document.querySelector('.main-content');
  if (scroller) scroller.scrollTop = 0;
}
try { window.navigateToSection = navigateToSection; } catch (e) {}

menuItems.forEach(item => {
  item.addEventListener('click', function(e) {
    if (item.classList.contains('locked')) {
      e.preventDefault();
      return;
    }
    const id = item.id === 'menu-bots' ? 'bot1' : item.id.replace('menu-', '');
    const go = (typeof window.navigateToSection === 'function')
      ? window.navigateToSection
      : navigateToSection;
    go(id, item);
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

// Strategy card / back navigation is owned by strategies-ui.js

// --- Window Controls (Electron direct ipcRenderer) ---
// Window controls: minimize, maximize, close
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
  showCloseTrayModal();
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
  try {
    if (window.__utkAppPerf && typeof window.__utkAppPerf.beginResize === 'function') {
      window.__utkAppPerf.beginResize();
    } else {
      document.documentElement.classList.add('resizing');
      document.body.classList.add('app-resizing');
      setTimeout(() => {
        try {
          document.documentElement.classList.remove('resizing');
          document.body.classList.remove('app-resizing');
        } catch (e2) {}
      }, 220);
    }
  } catch (e) {
    try { document.body.classList.add('app-resizing'); } catch (e2) {}
  }
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

ipcRenderer.on('notification-clicked', (_event, payload = {}) => {
  try {
    const go = (typeof window.navigateToSection === 'function')
      ? window.navigateToSection
      : navigateToSection;
    const studioId = payload.studioId ? String(payload.studioId) : '';
    if (studioId) {
      const menuItem = document.getElementById('menu-studio') || document.getElementById('menu-bots');
      if (typeof go === 'function') {
        go('studio', menuItem);
      }
      try {
        if (window.__utkStudioGlobalHub && typeof window.__utkStudioGlobalHub.open === 'function') {
          window.__utkStudioGlobalHub.open(studioId);
          return;
        }
      } catch (e) {}
      try {
        const studio = window.__utkBotStudio;
        if (studio && typeof studio.openBot === 'function') {
          studio.openBot(studioId);
          return;
        }
        if (window.__utkStudioBotHub && typeof window.__utkStudioBotHub.openBot === 'function') {
          window.__utkStudioBotHub.openBot(studioId);
        }
      } catch (e2) {}
      return;
    }

    const bot = String(payload.botName || '').toUpperCase();
    const botId = utkBotIdOf(bot) || 'bot1';
    const menuItem = document.getElementById('menu-' + botId)
      || document.getElementById('menu-bots');
    if (typeof go === 'function') {
      go(botId, menuItem);
    }
    const switchBtn = document.querySelector(`.bot-switch-btn[data-target="${botId}"]`);
    if (switchBtn && !switchBtn.classList.contains('is-active')) {
      switchBtn.click();
    }
  } catch (e) {}
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
function utkWiredBots() {
  return ['LUMIX', 'MIRAX', 'NYX'];
}
function utkBotPanelIds() {
  return ['bot1', 'bot2', 'bot3'];
}
function utkCanFollowBot(botKey) {
  const k = String(botKey || '').toUpperCase();
  return k === 'LUMIX' || k === 'MIRAX' || k === 'NYX';
}
function utkBotIdOf(botKey) {
  const k = String(botKey || '').toUpperCase();
  if (k === 'LUMIX') return 'bot1';
  if (k === 'MIRAX') return 'bot2';
  if (k === 'NYX') return 'bot3';
  return '';
}

function getBotActiveWindowMs(botKey) {
  if (botKey === 'LUMIX') return 10 * 60 * 1000;   // 10 minutes
  if (botKey === 'MIRAX') return 10 * 60 * 1000;   // 10 minutes
  if (botKey === 'NYX') return 15 * 60 * 1000;
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
  utkWiredBots().forEach(botKey => {
    try {
      const botId = botIdMap[botKey];
      const btn = botId ? document.getElementById(`menu-${botId}`) : null;
      let badge = btn?.closest('.card')?.querySelector('.badge');
      if (!badge && botId) {
        const idx = Number(String(botId).replace(/[^0-9]/g, '')) || 1;
        badge = document.querySelector(`#section-bots .card:nth-of-type(${idx}) .badge`);
      }

      // Prefer server-published activity flag when available; otherwise fall back to history/WS heuristics
      let isActive = false;
      const srv = window.serverBotStatus && window.serverBotStatus[botKey];
      if (srv && typeof srv.active === 'boolean') {
        isActive = !!srv.active;
      } else {
        isActive = isBotActiveByRecentSignal(botKey);
      }

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
  // Low-graphics / potato mode is decided in perf-boot.js
  window.lowGraphicsMode = window.lowGraphicsMode || (window.process && window.process.env && window.process.env.UTK_LOW_GRAPHICS === '1');
  if (window.lowGraphicsMode) {
    try { document.documentElement.classList.add('utk-low-fx'); } catch (e) {}
  }

  document.addEventListener('visibilitychange', () => {
    // visualizer pause/resume handled in MusicVisualizer
  });
  
  const quickLaunchBot = document.getElementById('quickLaunchBot');
  const quickViewStrategies = document.getElementById('quickViewStrategies');
  const quickSettings = document.getElementById('quickSettings');
  const historyButtons = [
    { id: 'historyBtn-bot1', bot: 'LUMIX' },
    { id: 'historyBtn-bot2', bot: 'MIRAX' },
    { id: 'historyBtn-bot3', bot: 'NYX' },
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
      btn.addEventListener('click', () => (window.renderHistoryModal || renderHistoryModal)(bot));
    }
  });

  // History modal close handlers
  const historyModal = document.getElementById('history-modal');
  const historyCloseBtn = document.querySelector('#history-modal .modal-icon-close, #history-modal .history-close-btn');
  const closeHistoryModal = () => {
    try { historyModal?.classList.remove('active'); } catch (e) {}
  };
  if (historyCloseBtn) {
    historyCloseBtn.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch {}
      closeHistoryModal();
    });
  }
  if (historyModal) {
    historyModal.addEventListener('click', (e) => {
      // Click outside dialog closes
      if (e && e.target === historyModal) closeHistoryModal();
    });
  }

  const infoModal = document.getElementById('info-modal');
  const closeInfoModal = () => {
    try { infoModal?.classList.remove('active'); } catch (e) {}
  };
  const infoCloseBtn = document.querySelector('#info-modal .modal-icon-close, #info-modal .info-close-btn');
  if (infoCloseBtn) {
    infoCloseBtn.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch {}
      closeInfoModal();
    });
  }
  if (infoModal) {
    infoModal.addEventListener('click', (e) => {
      if (e && e.target === infoModal) closeInfoModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (!e || e.key !== 'Escape') return;
    if (historyModal?.classList.contains('active')) closeHistoryModal();
    if (infoModal?.classList.contains('active')) closeInfoModal();
  });

  // Ensure stats are computed from any loaded history on startup
  utkWiredBots().forEach(bot => { try { computeStatsFromHistory(bot); } catch (e) {} });

  // Initialize bot activity badges and keep them in sync (uses history + WS fallback)
  try { updateBotActivityBadges(); } catch (e) {}
  if (!window.__utkBotActivityTimer) window.__utkBotActivityTimer = setInterval(() => { try { updateBotActivityBadges(); } catch (e) {} }, 60000);

  // Info buttons
  const infoButtons = [
    { id: 'infoBtn-bot1', bot: 'LUMIX' },
    { id: 'infoBtn-bot2', bot: 'MIRAX' },
    { id: 'infoBtn-bot3', bot: 'NYX' },
  ];
  infoButtons.forEach(({ id, bot }) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', () => renderInfoModal(bot));
  });

  // Bot switching is handled by `bot-switch-fx.js` in capture phase.
  // Keeping a second handler here causes double-swaps and transition glitches.

  // Info modal renderer — friendly product explanation (no strategy secrets).
  function renderInfoModal(botKey) {
    const modal = document.getElementById('info-modal');
    const title = document.getElementById('infoModalTitle');
    const body = document.getElementById('infoModalBody');
    if (!modal || !title || !body) return;

    const key = String(botKey || '').toUpperCase();
    const profiles = {
      LUMIX: {
        kicker: '3 minute signals',
        lead: 'LUMIX posts a trade idea the moment a rejection hammer prints. There is no waiting phase on screen. You get the signal, then the result.',
        pace: 'Each idea lasts about 3 minutes. Auto Trade helps if you want entries without clicking every time.',
        focus: 'Built for short windows. Turn on Saving Signals if you want the recovery chain to retry the same idea right away.',
      },
      MIRAX: {
        kicker: '30 second signals',
        lead: 'MIRAX posts short trade ideas the moment the entry is ready. There is no waiting phase on screen. You just get the signal, then the result.',
        pace: 'Each idea lasts about 30 seconds. Things move quickly, so Auto Trade helps if you want entries without clicking every time.',
        focus: 'Built for short windows. Turn on Saving Signals if you want the recovery chain to retry the same idea right away.',
      },
      NYX: {
        kicker: '20s–10m signals',
        lead: 'NYX picks the pair and expiry. Auto Trade uses your Pocket Option SSID: it switches to that pair, puts NYX timeframe, and places the sized amount on the click.',
        pace: 'Each idea lasts whatever NYX chose (20 seconds up to 10 minutes). Saving Signals sizes the recovery chain the same way as Lumix and Mirax.',
        focus: 'Built for mixed windows. Turn on Saving Signals if you want the recovery chain to retry the same idea right away. Signals tagged NYX never show on Lumix or Mirax.',
      },
    };
    const profile = profiles[key] || {
      kicker: 'Live signals',
      lead: 'This bot posts live trade ideas into the panel. Use History for past results and Stats to track how the day is going.',
      pace: 'Timing depends on which bot you are using.',
      focus: 'Use Auto Trade and Saving Signals if you want the app to size and place trades for you.',
    };

    title.textContent = `${key}: How it works`;
    body.innerHTML = `
      <div class="bot-info-hero">
        <div class="bot-info-kicker">${profile.kicker}</div>
        <p class="bot-info-lead">${profile.lead}</p>
      </div>
      <div class="bot-info-grid">
        <div class="bot-info-card">
          <h4>Timing</h4>
          <p>${profile.pace}</p>
        </div>
        <div class="bot-info-card">
          <h4>Style</h4>
          <p>${profile.focus}</p>
        </div>
      </div>
      <ol class="bot-info-steps">
        <li>
          <span class="bot-info-step-num">1</span>
          <div>
            <strong>Signal</strong>
            <span>The trade opens instantly. You see the direction, pair, and open price, with a countdown until it expires.</span>
          </div>
        </li>
        <li>
          <span class="bot-info-step-num">2</span>
          <div>
            <strong>Result</strong>
            <span>Win or loss stays on screen for a few seconds, then is saved in History and Stats.</span>
          </div>
        </li>
      </ol>
      <div class="bot-info-grid">
        <div class="bot-info-card">
          <h4>Auto Trade</h4>
          <p>When this is on and Pocket Option is connected, the app can place the trade for you at your bet size.</p>
        </div>
        <div class="bot-info-card">
          <h4>Saving Signals</h4>
          <p>Optional recovery mode. After a loss it raises the stake for a few tries, then goes back to normal after a win or a full chain.</p>
        </div>
      </div>
      <p class="bot-info-note">Signals are tools, not financial advice. Only trade money you can afford to lose. Results can change quickly.</p>
    `;
    modal.classList.add('active');
  }

  // Saving signal and Auto-Trade visibility
  const botIdToKey = { bot1: 'LUMIX', bot2: 'MIRAX', bot3: 'NYX' };
  const savingPrefBackup = { bot1: false, bot2: false, bot3: false };
  utkBotPanelIds().forEach(botId => {
    const botKey = botIdToKey[botId];
    const autoTradeToggle = document.getElementById(`autoTradeToggle-${botId}`);
    const enableToggle = document.getElementById(`savingSignalEnabled-${botId}`);
    const optionsDiv = document.getElementById(`savingSignalOptions-${botId}`);
    const modeToggle = document.getElementById(`savingSignalToggle-${botId}`);
    
    if (!autoTradeToggle || !enableToggle || !optionsDiv) return;
    
    // Find the form-group container that holds both label and toggle for Saving Signals
    const savingSignalsContainer = enableToggle.closest('.form-group');
    
    const updateVisibility = () => {
      const isAutoTradeOn = autoTradeToggle.checked;
      
      // Show/hide entire Saving Signals form-group based on Auto Trade
      if (savingSignalsContainer) {
        savingSignalsContainer.style.display = isAutoTradeOn ? 'block' : 'none';
      }
      
      if (!isAutoTradeOn) {
        // Remember preference only while it is still on (avoid wiping on repeat calls).
        if (enableToggle.checked) savingPrefBackup[botId] = true;
        enableToggle.checked = false;
        optionsDiv.style.display = 'none';
      } else {
        // Restore previous Saving preference when Auto Trade turns back on.
        if (savingPrefBackup[botId] && !enableToggle.checked) {
          enableToggle.checked = true;
        }
        optionsDiv.style.display = enableToggle.checked ? 'block' : 'none';
      }
      try { updateBetChainHint(botId); } catch (e) {}
      try { updateBotEmptyState(botKey); } catch (e) {}
    };
    
    // Initialize visibility on load
    restoreSavingSignalMode(botId);
    updateVisibility();
    syncAutotradeConfigToMain(botKey, {
      enabled: autoTradeToggle.checked,
      source: 'user-toggle'
    });
    
    // When Auto Trade toggle changes
    // Chain gate + SSID ready live in connection-system.js (single modal).
    autoTradeToggle.addEventListener('change', () => {
      if (!autoTradeToggle.checked) {
        // connection-system may briefly uncheck while aborting a failed arm — ignore that.
        try {
          if (window.connectionSystem && typeof window.connectionSystem.isArming === 'function'
            && window.connectionSystem.isArming(botId)) {
            return;
          }
        } catch (e) {}
        try { window.setAutotradeWaitForChainEnd?.(botId, false); } catch (e) {}
        updateVisibility();
        syncAutotradeConfigToMain(botKey, { enabled: false, source: 'user-toggle' });
        try { updateBotEmptyState(botKey); } catch (e) {}
        return;
      }
      // Restore Saving checkbox BEFORE syncing — otherwise main gets saving=off
      // and sizes every ticket at 1x (S1–S4 never follow 2x/4x/custom).
      updateVisibility();
      syncAutotradeConfigToMain(botKey, { enabled: true, source: 'user-toggle' });
      try {
        syncSavingSignalStakeToMain(botKey, lastSignalCurrency[botKey] || '');
      } catch (eSync) {}
      try { clearBotAutotradeReason(botId); } catch (e) {}
      try { updateBotEmptyState(botKey); } catch (e) {}
    });
    
    // When Saving Signals enabled checkbox changes
    enableToggle.addEventListener('change', () => {
      if (autoTradeToggle.checked) {
        savingPrefBackup[botId] = !!enableToggle.checked;
      }
      optionsDiv.style.display = enableToggle.checked ? 'block' : 'none';
      try { updateBetChainHint(botId); } catch (e) {}
      syncSavingSignalStakeToMain(botKey, lastSignalCurrency[botKey] || '');
    });

    if (modeToggle) {
      modeToggle.addEventListener('change', () => {
        persistSavingSignalMode(botId, modeToggle.checked ? '4x' : '2x');
        try { updateBetChainHint(botId); } catch (e) {}
        syncSavingSignalStakeToMain(botKey, lastSignalCurrency[botKey] || '');
      });
      persistSavingSignalMode(botId, modeToggle.checked ? '4x' : '2x');
    }

    const modeRoot = document.getElementById(`savingSignalMode-${botId}`);
    const customRow = document.getElementById(`savingLadderCustom-${botId}`);
    const paintSavingLadderUi = (mode) => {
      const m = mode === '4x' || mode === 'custom' ? mode : '2x';
      if (modeRoot) {
        modeRoot.querySelectorAll('[data-saving-mode]').forEach((btn) => {
          btn.classList.toggle('is-on', btn.getAttribute('data-saving-mode') === m);
        });
      }
      if (customRow) {
        const open = m === 'custom';
        customRow.classList.toggle('is-open', open);
        if (open) {
          customRow.hidden = false;
          customRow.removeAttribute('hidden');
          customRow.style.display = 'block';
        } else {
          customRow.hidden = true;
          customRow.setAttribute('hidden', '');
          customRow.style.display = 'none';
        }
      }
    };
    if (modeRoot && !modeRoot.__utkModeWired) {
      modeRoot.__utkModeWired = true;
      modeRoot.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('[data-saving-mode]') : null;
        if (!btn || !modeRoot.contains(btn)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const mode = btn.getAttribute('data-saving-mode') || '2x';
        try {
          if (window.__utkSavingLadder && typeof window.__utkSavingLadder.setMode === 'function') {
            window.__utkSavingLadder.setMode(botId, mode);
          } else {
            persistSavingSignalMode(botId, mode);
            paintSavingLadderUi(mode);
            syncSavingSignalStakeToMain(botKey, lastSignalCurrency[botKey] || '');
          }
        } catch (e) {
          paintSavingLadderUi(mode);
        }
        try { updateBetChainHint(botId); } catch (e2) {}
      });
    }
    try {
      const savedMode = (window.__utkSavingLadder && window.__utkSavingLadder.getMode)
        ? window.__utkSavingLadder.getMode(botKey)
        : (window.localStorage.getItem(`savingSignalMode:${botId}`) || '2x');
      paintSavingLadderUi(savedMode);
    } catch (e3) {
      paintSavingLadderUi('2x');
    }

    const emptyCta = document.getElementById(`signalEmptyCta-${botId}`);
    if (emptyCta) {
      emptyCta.addEventListener('click', () => {
        try { window.ssidManager?.hintConnect?.(botId); } catch (e) {}
        try { window.ssidManager?.requestOpenModal?.(botId); } catch (e) {}
      });
    }
  });

  try { refreshAllBotEmptyStates(); } catch (e) {}
  // One-time terms modal
  initTermsModal();

  setupBetSizeControls();
});


// --- LUMIX Bot Signal Card Logic ---
const lumixSignalList = document.querySelector('#section-bot2 .bot-signal-list');
const wsStatusEl = document.getElementById('ws-status');
const signalDisplays = {
  LUMIX: document.getElementById('signalDisplay-bot1'),
  MIRAX: document.getElementById('signalDisplay-bot2'),
  NYX: document.getElementById('signalDisplay-bot3'),
};
const signalEmptyStates = {
  LUMIX: document.getElementById('signalEmpty-bot1'),
  MIRAX: document.getElementById('signalEmpty-bot2'),
  NYX: document.getElementById('signalEmpty-bot3'),
};
const botContainers = {
  LUMIX: document.querySelector('#section-bot1 .bot-signal-area'),
  MIRAX: document.querySelector('#section-bot2 .bot-signal-area'),
  NYX: document.querySelector('#section-bot3 .bot-signal-area'),
};
const botIdMap = {
  LUMIX: 'bot1',
  MIRAX: 'bot2',
  NYX: 'bot3',
};
const signalHistory = {
  LUMIX: [],
  MIRAX: [],
  NYX: [],
};
try { window.signalHistory = signalHistory; } catch (e) {}
try { window.botIdMap = botIdMap; } catch (e) {}
const TERMS_KEY = 'utk_terms_v1_1_0';

// Real-time listeners for each bot
const historyListeners = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

// Active signal listeners
const activeSignalListeners = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

// Track countdown sync
const countdownSync = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

function historyLookbackStartMs() {
  try {
    if (window.__utkStatsDay && typeof window.__utkStatsDay.rangeForMs === 'function') {
      const range = window.__utkStatsDay.rangeForMs(Date.now());
      if (range && Number.isFinite(range.start)) return range.start - (6 * 60 * 60 * 1000);
    }
  } catch (e) {}
  return Date.now() - (36 * 60 * 60 * 1000);
}

function toEpochMs(value) {
  try {
    if (window.__utkTradeTime && typeof window.__utkTradeTime.toEpochMs === 'function') {
      return window.__utkTradeTime.toEpochMs(value);
    }
  } catch (e) {}
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e9 && value < 1e12) return value * 1000;
    return value;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || /^n\/?a$/i.test(s)) return null;
    if (/^\d{10,17}$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      if (s.length === 10) return n * 1000;
      return n;
    }
    const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
    if (naive) {
      const ms = new Date(
        Number(naive[1]), Number(naive[2]) - 1, Number(naive[3]),
        Number(naive[4]), Number(naive[5]), Number(naive[6] || 0)
      ).getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    const parsed = Date.parse(s);
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
try { window.toEpochMs = toEpochMs; } catch (e) {}

function getTradeSortTimeMs(data) {
  return (
    toEpochMs(data?.timestamp) ??
    toEpochMs(data?.openingTime) ??
    toEpochMs(data?.closingTime) ??
    toEpochMs(data?.time) ??
    toEpochMs(data?.createdAt) ??
    0
  );
}

/** Prefer close time for "which day does this result belong to". */
function getTradeStatsDayMs(data) {
  return (
    toEpochMs(data?.closedAtMs) ??
    toEpochMs(data?.closingTime) ??
    toEpochMs(data?.timestamp) ??
    toEpochMs(data?.openedAtMs) ??
    toEpochMs(data?.openingTime) ??
    toEpochMs(data?.createdAt) ??
    toEpochMs(data?.time) ??
    0
  );
}

function isTradeResultEntry(trade) {
  const phase = String(trade?.phase || '').trim().toLowerCase();
  if (phase === 'trading result' || phase === 'result') return true;
  const res = String(trade?.result || '').trim().toLowerCase();
  return ['win', 'won', 'success', 'w', 'loss', 'lose', 'lost', 'l'].includes(res);
}

function parseTradeOutcome(trade) {
  const resultUpper = String(trade?.result || '').trim().toUpperCase();
  const isWin = resultUpper === 'WIN' || resultUpper === 'WON' || resultUpper === 'SUCCESS' || resultUpper === 'W';
  const isLoss = resultUpper === 'LOSS' || resultUpper === 'LOSE' || resultUpper === 'LOST' || resultUpper === 'L';
  return { isWin, isLoss };
}

function getSavingSignalLossesFromHistory(botKey, _opts = {}) {
  let trades = signalHistory[botKey] || [];
  try {
    if (window.__utkPoAccountHistory && typeof window.__utkPoAccountHistory.historyForSaving === 'function') {
      trades = window.__utkPoAccountHistory.historyForSaving(botKey, trades);
    }
  } catch (e) {}
  try {
    if (window.__utkSavingHistory && typeof window.__utkSavingHistory.getLossesFromHistory === 'function') {
      const pair = _opts && (_opts.symbol || _opts.pair || _opts.selectedCurrency);
      return window.__utkSavingHistory.getLossesFromHistory(trades, pair);
    }
  } catch (e) {}
  // Fallback: consecutive losses on the whole tape (newest fill first).
  const ordered = trades.slice().sort(function (a, b) {
    const da = toEpochMs(a && (a.closedAtMs || a.closingTime || a.openedAtMs || a.openingTime || a.timestamp)) || 0;
    const db = toEpochMs(b && (b.closedAtMs || b.closingTime || b.openedAtMs || b.openingTime || b.timestamp)) || 0;
    return db - da;
  });
  let streak = 0;
  for (const trade of ordered) {
    if (trade && trade.ladderReset) break;
    if (trade && (trade.chainComplete || trade.chainReset) && !trade.ladderReset) continue;
    if (!isTradeResultEntry(trade)) continue;
    const { isWin, isLoss } = parseTradeOutcome(trade);
    if (isWin) break;
    if (isLoss) {
      streak += 1;
      if (streak >= 5) {
        streak = 0;
        break;
      }
    } else {
      break;
    }
  }
  return Math.min(streak, 4);
}

/**
 * Attempt (1–5) for live saving: whole WIN/LOSS tape until a WIN or 5-loss wipe.
 * Strategy may hop after 2 clicks; the save ladder still continues (1x then S1–S4).
 */
function resolveSavingAttempt(botKey, signal) {
  let trades = signalHistory[botKey] || [];
  try {
    if (window.__utkPoAccountHistory && typeof window.__utkPoAccountHistory.historyForSaving === 'function') {
      trades = window.__utkPoAccountHistory.historyForSaving(botKey, trades);
    }
  } catch (e) {}
  try {
    if (window.__utkSavingHistory && typeof window.__utkSavingHistory.resolveAttempt === 'function') {
      return window.__utkSavingHistory.resolveAttempt(trades, signal);
    }
  } catch (e) {}
  const histAttempt = Math.min(5, getSavingSignalLossesFromHistory(botKey, signal) + 1);
  const raw = Number(signal && signal.attempt);
  const fromBot = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.trunc(raw), 5) : null;
  if (fromBot != null && fromBot > 1) {
    if (!trades.length) return fromBot;
    if (histAttempt > 1) return Math.max(fromBot, histAttempt);
  }
  return histAttempt;
}

function resolveSavingLossesFromSignal(botKey, signal, _opts = {}) {
  return Math.max(0, resolveSavingAttempt(botKey, signal) - 1);
}

function syncHistorySavingAttemptToMain(botKey, currency) {
  if (!botKey) return;
  syncSavingSignalStakeToMain(botKey, currency || lastSignalCurrency[botKey] || '');
}
try { window.resolveSavingAttempt = resolveSavingAttempt; } catch (e) {}

function markSavingLadderReset(botKey, tradeSymbol) {
  if (!botKey) return;
  if (!signalHistory[botKey]) signalHistory[botKey] = [];
  const head = signalHistory[botKey][0];
  if (!(head && head.localOnly && head.ladderReset)) {
    signalHistory[botKey].unshift({
      bot: botKey,
      phase: 'Chain Complete',
      result: 'PAYOUT_STOP',
      symbol: tradeSymbol || '',
      currency: tradeSymbol || '',
      selectedCurrency: tradeSymbol || '',
      chainComplete: true,
      chainReset: true,
      ladderReset: true,
      localOnly: true,
      timestamp: Date.now(),
      attempt: 0,
      stakeMultiplier: 1,
    });
  }
  syncHistorySavingAttemptToMain(botKey, tradeSymbol || lastSignalCurrency[botKey] || '');
}
try { window.markSavingLadderReset = markSavingLadderReset; } catch (e) {}

function markLocalChainReset(botKey, tradeSymbol) {
  if (!signalHistory[botKey]) signalHistory[botKey] = [];
  // Avoid stacking identical resets.
  const head = signalHistory[botKey][0];
  if (head && head.localOnly && head.chainReset) return;
  signalHistory[botKey].unshift({
    bot: botKey,
    phase: 'Chain Complete',
    result: 'CHAIN_RESET',
    symbol: tradeSymbol || '',
    currency: tradeSymbol || '',
    selectedCurrency: tradeSymbol || '',
    chainComplete: true,
    chainReset: true,
    localOnly: true,
    timestamp: Date.now(),
    attempt: 0,
    stakeMultiplier: 1,
  });
  const resets = signalHistory[botKey].filter((t) => t && t.localOnly && t.chainReset);
  if (resets.length > 8) {
    const drop = new Set(resets.slice(8));
    signalHistory[botKey] = signalHistory[botKey].filter((t) => !drop.has(t));
  }
}

function getSavingSignalLosses(botKey) {
  return getSavingSignalLossesFromHistory(botKey);
}
try { window.getSavingSignalLosses = getSavingSignalLosses; } catch (e) {}

function syncSavingSignalStateFromHistory(botKey) {
  return getSavingSignalLossesFromHistory(botKey);
}

function getSyncedAccountBalance(botKey) {
  try {
    const botId = botIdMap[botKey];
    if (!botId) return null;
    const status = window.ssidManager?.statusByBot?.[botId];
    const fromSsid = status?.balance;
    if (Number.isFinite(Number(fromSsid)) && Number(fromSsid) > 0) {
      return Number(fromSsid);
    }
    if (typeof getBalanceSync !== 'function') return null;
    const sync = getBalanceSync();
    if (!sync || typeof sync.getBalance !== 'function') return null;
    const balanceData = sync.getBalance(botId);
    if (!balanceData) return null;
    const active = status?.activeAccount === 'real' ? balanceData.realBalance : balanceData.demoBalance;
    if (Number.isFinite(Number(active)) && Number(active) > 0) return Number(active);
    const balances = [Number(balanceData.realBalance), Number(balanceData.demoBalance)].filter(value => Number.isFinite(value) && value > 0);
    if (balances.length === 0) return null;
    return Math.max(...balances);
  } catch (e) {
    return null;
  }
}

function normalizeTradeSide(raw) {
  const s = String(raw || '').toUpperCase().trim();
  if (s === 'BUY' || s === 'CALL' || s === 'UP' || s === 'LONG') return 'BUY';
  if (s === 'SELL' || s === 'PUT' || s === 'DOWN' || s === 'SHORT') return 'SELL';
  return '';
}

function getStakeMultiplierFromHistory(botKey) {
  try {
    const trades = signalHistory[botKey] || [];
    const latest = trades.find(trade => Number.isFinite(Number(trade?.stakeMultiplier)));
    const value = Number(latest?.stakeMultiplier);
    return Number.isFinite(value) && value > 0 ? value : 1;
  } catch (e) {
    return 1;
  }
}

// Setup real-time Firebase history listeners
function setupFirebaseHistoryListeners() {
  utkWiredBots().forEach(botKey => {
    attachFirebaseHistoryListener(botKey);
    setupActiveSignalListener(botKey);
  });
}

const FIREBASE_TRADE_FETCH_LIMIT_PER_BOT = 80;

function normalizeHistoryDoc(docSnap) {
  const data = (docSnap && typeof docSnap.data === 'function') ? (docSnap.data() || {}) : {};
  const row = { id: docSnap && docSnap.id, ...data };
  try {
    if (window.__utkTradeNorm && typeof window.__utkTradeNorm.normalizeRow === 'function') {
      return window.__utkTradeNorm.normalizeRow(row) || row;
    }
  } catch (e) {}
  return row;
}

function applyHistoryRows(botKey, trades) {
  if (!Array.isArray(trades) || !trades.length) return 0;
  trades.sort((a, b) => getTradeSortTimeMs(b) - getTradeSortTimeMs(a));
  const incomingIds = new Set(trades.map((t) => t && t.id).filter(Boolean));
  const olderKept = (signalHistory[botKey] || []).filter((t) =>
    t && t.id && !incomingIds.has(t.id) && !t.optimistic && !(t.localOnly && t.chainReset)
  );
  const localResets = (signalHistory[botKey] || []).filter((t) =>
    t && t.localOnly && t.chainReset && (Date.now() - Number(t.timestamp || 0)) < 30 * 60 * 1000
  );
  let keepOptimistic = [];
  try {
    if (window.__utkBotStats && typeof window.__utkBotStats.filterKeepOptimistic === 'function') {
      keepOptimistic = window.__utkBotStats.filterKeepOptimistic(
        signalHistory[botKey] || [],
        trades
      );
    } else {
      keepOptimistic = (signalHistory[botKey] || []).filter((t) =>
        t && t.optimistic &&
        (Date.now() - (toEpochMs(t.timestamp) || toEpochMs(t.openingTime) || 0)) < 2 * 60 * 1000
      );
    }
  } catch (e) {}
  signalHistory[botKey] = [...localResets, ...keepOptimistic, ...trades, ...olderKept]
    .sort((a, b) => getTradeSortTimeMs(b) - getTradeSortTimeMs(a));
  try {
    if (window.__utkBotStats && typeof window.__utkBotStats.dedupeResultTrades === 'function') {
      const resets = signalHistory[botKey].filter((t) => t && t.localOnly && t.chainReset);
      const rest = signalHistory[botKey].filter((t) => !(t && t.localOnly && t.chainReset));
      signalHistory[botKey] = [...resets, ...window.__utkBotStats.dedupeResultTrades(rest)]
        .sort((a, b) => getTradeSortTimeMs(b) - getTradeSortTimeMs(a));
    }
  } catch (e) {}
  try { window.signalHistory = signalHistory; } catch (e) {}
  try { computeStatsFromHistory(botKey); } catch (e) {}
  try { updateBotActivityBadges(); } catch (e) {}
  try { syncHistorySavingAttemptToMain(botKey, lastSignalCurrency[botKey] || ''); } catch (e) {}
  return trades.length;
}

function hydrateHistoryFromCache(botKey) {
  return Promise.resolve(0);
}

function attachFirebaseHistoryListener(botKey) {
  try {
    if (typeof historyListeners[botKey] === 'function') {
      historyListeners[botKey]();
    }
  } catch (e) {}

  historyListeners[botKey] = function () {};
  try {
    if (window.__utkResultsHistory && typeof window.__utkResultsHistory.load === 'function') {
      window.__utkResultsHistory.load(botKey);
    }
  } catch (e) {}
}

// Setup listener for active signals (live sync across all users)
const lastActiveSignalDoc = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

function setupActiveSignalListener(botKey) {
  // Check if user is authenticated
  if (!auth.currentUser) {
    return;
  }

  try {
    if (typeof activeSignalListeners[botKey] === 'function') {
      activeSignalListeners[botKey]();
    }
  } catch (e) {}

  const applyActiveSignalDoc = (data, { force = false } = {}) => {
    if (!data || typeof data !== 'object') return;
    const now = Date.now();
    const updatedAtMs = toEpochMs(data.updatedAt) || 0;
    // Only ignore Firebase when THIS client already applied a newer local WS phase.
    // Fresh connects have lastLocalPhaseUpdate=0 and must always hydrate.
    // force=true is used when user connects mid-phase / SSID refresh.
    if (!force && lastLocalPhaseUpdate[botKey] && updatedAtMs && updatedAtMs < lastLocalPhaseUpdate[botKey]) {
      return;
    }

    // WS already painted this phase — don't rebuild the card from Firebase (flicker).
    if (!force && lastLocalPhaseUpdate[botKey] && (now - lastLocalPhaseUpdate[botKey]) < 2500) {
      try {
        const prev = window.BotPhaseGuard?.getLast?.(botKey);
        const incoming = String(data.phase || '').trim();
        if (prev && prev.phase && incoming && prev.phase.toLowerCase() === incoming.toLowerCase()) {
          return;
        }
      } catch (e) {}
    }

    const phaseRaw = String(data.phase || '').trim();
    const phaseLower = phaseRaw.toLowerCase();
    if (phaseLower === 'preparing') {
      // Instant-trade app: never flash Preparing from Firebase.
      return;
    }

    try {
      const guard = window.BotPhaseGuard;
      if (guard && typeof guard.shouldAcceptPhase === 'function') {
        const verdict = guard.shouldAcceptPhase(botKey, data);
        if (verdict && verdict.ok === false) {
          return;
        }
      }
    } catch (e) {}

    const prevApplied = lastActiveSignalDoc[botKey];
    if (
      !force &&
      prevApplied &&
      prevApplied.updatedAt === data.updatedAt &&
      String(prevApplied.phase || '') === String(data.phase || '') &&
      String(prevApplied.signalId || '') === String(data.signalId || '')
    ) {
      return;
    }

    lastActiveSignalDoc[botKey] = data;

    // Countdown MUST use Firebase startTime (set when the phase was first published).
    const startTimeMs = toEpochMs(data.startTime) || updatedAtMs || now;
    const phase = (phaseLower === 'signal')
      ? 'Signal'
      : (phaseLower === 'trading result' || phaseLower === 'result')
        ? 'Trading Result'
        : (phaseLower === 'cancelled')
          ? 'Cancelled'
          : phaseRaw;

    const currency =
      resolveCurrency(data) ||
      String(data.selectedCurrency || data.symbol || data.currency || '').trim();
    if (currency) lastSignalCurrency[botKey] = currency;
    if (phase === 'Signal') {
      if (data.openingPrice != null || data.price != null) {
        lastSignalPrice[botKey] = data.openingPrice ?? data.price;
      }
      const act = normalizeTradeSide(data.action || data.side);
      if (act) lastSignalAction[botKey] = act;
    } else if (phase === 'Trading Result' && data.openingPrice != null && data.openingPrice !== 'N/A') {
      lastSignalPrice[botKey] = data.openingPrice;
      const act = normalizeTradeSide(data.action || data.side);
      if (act) lastSignalAction[botKey] = act;
    }
    if (data.openingTime || data.time || data.openedAtMs) {
      lastSignalTime[botKey] = toEpochMs(data.openedAtMs) || toEpochMs(data.openingTime) || toEpochMs(data.time) || data.openedAtMs;
    }
    try {
      if (SINGLE_ACTIVE_CHAIN_BOTS.has(botKey) && currency) {
        const symKey = canonChainSymbolKey(currency);
        if (symKey) activeChainSymbol[botKey] = symKey;
      }
    } catch (e) {}

    const hydrated = {
      ...data,
      bot: botKey,
      phase,
      selectedCurrency: currency || data.selectedCurrency,
      symbol: data.symbol || currency,
      currency: data.currency || currency,
      side: normalizeTradeSide(data.side || data.action) || lastSignalAction[botKey] || data.side,
      action: normalizeTradeSide(data.action || data.side) || lastSignalAction[botKey] || data.action,
      openingPrice: (data.openingPrice != null && data.openingPrice !== 'N/A')
        ? data.openingPrice
        : (phase === 'Trading Result' ? lastSignalPrice[botKey] : (data.price ?? lastSignalPrice[botKey])),
      price: data.price ?? data.openingPrice,
      openingTime: data.openedAtMs || data.openingTime || data.time,
    };

    if (phase === 'Cancelled') {
      if (!resultAutoClearTimers[botKey]) {
        showCancelledPhase(botKey, hydrated);
      }
      return;
    }

    if (phase === 'Signal') {
      try {
        if (window.shouldSuppressLeftoverSignalUi?.(botKey, hydrated)) {
          try { window.clearLeftoverSignalCard?.(botKey); } catch (e2) {}
          return;
        }
      } catch (e) {}
      // Stale Signal doc must never replace a live Result card (same attempt).
      try {
        if (isLiveCardProtected(botKey)) {
          const prev = window.BotPhaseGuard?.getLast?.(botKey);
          const incomingAttempt = Number(data.attempt) || 1;
          const prevAttempt = Number(prev && prev.attempt) || 1;
          if (prev && (prev.phase === 'Trading Result' || prev.phase === 'Chain Complete' || prev.phase === 'Settled') && incomingAttempt <= prevAttempt) {
            return;
          }
        }
      } catch (e) {}
      try {
        const prev = window.BotPhaseGuard?.getLast?.(botKey);
        const incomingId = String(data.signalId || '').trim();
        if (!force && prev && prev.phase === 'Signal' && incomingId && prev.signalId && incomingId === prev.signalId) {
          return;
        }
      } catch (e) {}
      cancelResultAutoClear(botKey);
      suppressPreparingUntilSignal[botKey] = false;
      const duration = resolveTradeDurationSec(botKey, data);
      // Prefer bot open clock over Firebase publish lag.
      const openAnchor =
        toEpochMs(data.openedAtMs) ||
        toEpochMs(data.openingTime) ||
        startTimeMs;
      const openElapsed = Math.max(0, (now - openAnchor) / 1000);
      const remaining = Math.max(0, Math.ceil(duration - openElapsed));
      try {
        const ttl = window.__utkSignalCardTtl;
        if (ttl && typeof ttl.isDeadSignal === 'function' && ttl.isDeadSignal(hydrated, now, duration)) {
          lastActiveSignalDoc[botKey] = null;
          try { window.BotPhaseGuard?.markSettled?.(botKey); } catch (e2) {}
          clearCountdown(botKey);
          try { resetTradeCard(botKey); } catch (e2) {}
          try { clearSignalUI(botKey); } catch (e2) {}
          return;
        }
      } catch (e) {}
      if (remaining > 0) {
        startCountdown(botKey, remaining, 'Trading');
        scheduleRenderSignal(botKey, { ...hydrated, countdown: remaining });
      } else {
        // Trade window ended — keep the card briefly, then return to searching if Result never comes.
        clearCountdown(botKey);
        scheduleRenderSignal(botKey, { ...hydrated, countdown: 0 });
        scheduleExpiredSignalClear(botKey, hydrated, duration);
      }
      applyPhaseGlow(botKey, { phase, action: hydrated.action });
      try { window.BotPhaseGuard?.notePhaseAccepted?.(botKey, hydrated); } catch (e) {}
      try { updateBotActivityBadges(); } catch (e) {}
      // Never delete Firebase from a viewer restore path (clock skew used to wipe live signals).
      return;
    }

    if (phase === 'Trading Result') {
      let acceptDuringCountdown = false;
      if (botCountdowns[botKey] || (botExpireAt[botKey] && Date.now() < botExpireAt[botKey])) {
        try {
          const prev = window.BotPhaseGuard?.getLast?.(botKey);
          const incomingId = String(data.signalId || '').trim();
          const sameId = !!(prev && incomingId && prev.signalId && incomingId === prev.signalId);
          const samePairAttempt = !!(
            prev &&
            prev.phase === 'Signal' &&
            prev.pair &&
            String(currency || '').replace(/[^A-Z0-9]/gi, '').toUpperCase() === prev.pair &&
            (Number(data.attempt) || 1) === (Number(prev.attempt) || 1)
          );
          acceptDuringCountdown = sameId || samePairAttempt;
        } catch (e) {
          acceptDuringCountdown = false;
        }
        if (!acceptDuringCountdown) return;
      }
      const resultWindow = 10;
      // Result hold is from when Result was written, not the Signal open clock.
      const resultStamp = updatedAtMs || startTimeMs;
      const resultElapsed = Math.max(0, (now - resultStamp) / 1000);
      // Leftover Result docs must not resurrect after the card already faded.
      if (resultElapsed >= resultWindow) {
        return;
      }
      clearCountdown(botKey);
      const resultAction = normalizeTradeSide(hydrated.action || hydrated.side) || lastSignalAction[botKey] || '';
      const resultOpenPrice = (hydrated.openingPrice != null && hydrated.openingPrice !== 'N/A')
        ? hydrated.openingPrice
        : lastSignalPrice[botKey];
      try { window.__utkSignalResultInstant?.paint?.(botKey, hydrated); } catch (e) {}
      if (!(window.__utkSignalResultInstant &&
        typeof window.__utkSignalResultInstant.wasPainted === 'function' &&
        window.__utkSignalResultInstant.wasPainted(botKey, hydrated))) {
        scheduleRenderSignal(botKey, {
          ...hydrated,
          action: resultAction,
          side: resultAction || hydrated.side,
          openingPrice: resultOpenPrice,
        });
      }
      applyPhaseGlow(botKey, { phase, result: data.result, action: resultAction });
      suppressPreparingUntilSignal[botKey] = true;
      try { window.BotPhaseGuard?.notePhaseAccepted?.(botKey, hydrated); } catch (e) {}
      // Do NOT ingest stats/history here — WS Result already did. Re-ingest
      // created a second History row (often with UTC vs local times).
      scheduleResultAutoClear(botKey, Math.max(500, (resultWindow - resultElapsed) * 1000));
    }
  };

  const applyMissingSignal = () => {
    lastActiveSignalDoc[botKey] = null;
    if (isLiveCardProtected(botKey)) {
      try { updateBotEmptyState(botKey); } catch (e) {}
      return;
    }
    try { window.BotPhaseGuard?.markSettled?.(botKey); } catch (e) {}
    try { resetTradeCard(botKey); } catch (e) {}
    try { clearSignalUI(botKey); } catch (e) {}
  };

  const pullTapeSignal = async (force) => {
    try {
      const api = window.__utkBotTape;
      if (!api || typeof api.fetchSignal !== 'function') return;
      const data = await api.fetchSignal(botKey);
      const sig = data && data.signal;
      if (!sig) {
        applyMissingSignal();
        return;
      }
      applyActiveSignalDoc(sig, { force: !!force });
    } catch (e) {}
  };

  void pullTapeSignal(true);
  const pollId = setInterval(function () {
    try {
      if (document.hidden || document.visibilityState === 'hidden') return;
      let sid = '';
      try {
        const reg = window.BotsRegistry || window.__utkBots;
        const row = reg && ((reg.byKey && reg.byKey(botKey)) || (reg.all && reg.all().find(function (b) { return b.key === botKey; })));
        if (row && row.id) sid = 'section-' + row.id;
      } catch (eMap) {}
      if (!sid) {
        if (botKey === 'LUMIX') sid = 'section-bot1';
        else if (botKey === 'MIRAX') sid = 'section-bot2';
        else if (botKey === 'NYX') sid = 'section-bot3';
      }
      const sec = sid ? document.getElementById(sid) : null;
      if (sec && !sec.classList.contains('active')) return;
    } catch (eSkip) {}
    void pullTapeSignal(false);
  }, 1000);
  activeSignalListeners[botKey] = function () {
    try { clearInterval(pollId); } catch (e) {}
  };

  try {
    window.__rehydrateActiveSignal = window.__rehydrateActiveSignal || {};
    window.__rehydrateActiveSignal[botKey] = () => {
      if (isLiveCardProtected(botKey)) return;
      try {
        const display = signalDisplays[botKey];
        if (display && display.querySelector && display.querySelector('.signal-card')) return;
      } catch (e) {}
      void pullTapeSignal(false);
    };
  } catch (e) {}
}

// Save active signal to Firebase for real-time sync
const pendingActiveSignals = {}; // store latest pending active signal per bot

async function flushPendingActiveSignals() {
  try {
    if (!auth || !auth.currentUser) return;
    const keys = Object.keys(pendingActiveSignals);
    if (!keys.length) return;
    console.debug('[Firebase] Flushing pending active signals:', keys);
    for (const k of keys) {
      try {
        const data = pendingActiveSignals[k];
        delete pendingActiveSignals[k];
        await saveActiveSignalToFirebase(k, data.payload || {});
        console.log(`[Firebase] Flushed pending active signal for ${k}`);
      } catch (e) {
        console.warn('[Firebase] Failed flushing active signal for', k, e);
      }
    }
  } catch (e) {
    console.error('[Firebase] flushPendingActiveSignals error', e);
  }
}

// Firestore rejects `undefined` — Mirax often omits sl/tp; strip those so setDoc succeeds.
function omitUndefinedFields(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

/** When always-on server heartbeat is fresh, Electron skips Firebase writes.
 *  Normal users never write shared signals — only signal_writer/admin fallback. */
function shouldSkipClientFirebaseWrites() {
  try {
    if (window.__utkSignalWriterGate && typeof window.__utkSignalWriterGate.shouldSkipClientFirebaseWrites === 'function') {
      return !!window.__utkSignalWriterGate.shouldSkipClientFirebaseWrites();
    }
    if (window.__utkSignalWriterGate && typeof window.__utkSignalWriterGate.isServerWriterOnline === 'function') {
      if (window.__utkSignalWriterGate.isServerWriterOnline()) return true;
    }
  } catch (e) {}
  // Fail closed: if gate is missing, do not let every client race-write Firebase.
  return true;
}

async function saveActiveSignalToFirebase(botKey, signalData) {
  // Live cards hydrate from Contabo tape. Do not write activeSignals.
  return;

  // If user not authenticated yet, queue the latest active signal for this bot and return.
  if (!auth || !auth.currentUser) {
    try {
      pendingActiveSignals[botKey] = {
        payload: signalData,
        queuedAt: Date.now(),
        startTime: Date.now()
      };
      console.warn(`[Firebase] Queued active signal for ${botKey} (auth unavailable).`);
    } catch (e) {}
    return;
  }

  try {
    const activeSignalRef = doc(db, 'activeSignals', botKey);
    const nextPhase = String(signalData?.phase || '').trim().toLowerCase();
    const dur = resolveTradeDurationSec(botKey, signalData);

    // Keep original phase startTime so users who join mid-signal get the real remaining countdown.
    // Only stamp a new startTime when the phase changes (or there is no doc yet).
    // Prefer bot openedAtMs so countdown end matches history Open+expiry (not receive lag).
    const botOpenMs =
      toEpochMs(signalData?.openedAtMs) ||
      toEpochMs(signalData?.startTime) ||
      toEpochMs(signalData?.openingTime) ||
      null;
    let startTime = (nextPhase === 'signal' && botOpenMs) ? botOpenMs : Date.now();
    let duration = dur;
    try {
      const existing = await getDoc(activeSignalRef);
      if (existing.exists()) {
        const prev = existing.data() || {};
        const prevPhase = String(prev.phase || '').trim().toLowerCase();
        const prevStart = toEpochMs(prev.startTime);
        if (prevPhase && nextPhase && prevPhase === nextPhase && prevStart) {
          startTime = prevStart;
          const prevDur = Number(prev.duration || prev.countdown);
          if (Number.isFinite(prevDur) && prevDur > 0) duration = prevDur;
        }
      }
    } catch (e) {}

    const { startTime: _ignoredStart, endAtMs: _ignoredEnd, ...rest } = signalData || {};
    const payload = omitUndefinedFields({
      ...rest,
      bot: botKey,
      duration,
      countdown: Number(signalData?.countdown) > 0 ? Number(signalData.countdown) : duration,
      startTime,
      updatedAt: Date.now()
    });
    await setDoc(activeSignalRef, payload);
  } catch (error) {
    if (error.code === 'permission-denied') {
      console.warn(`[Firebase] Permission denied saving ${botKey} - check Firebase rules / signal_writer claim`);
      try {
        pendingActiveSignals[botKey] = {
          payload: signalData,
          queuedAt: Date.now(),
          startTime: Date.now()
        };
      } catch (e) {}
    } else {
      console.error(`[Firebase] Error saving active signal for ${botKey}:`, error);
      try {
        pendingActiveSignals[botKey] = {
          payload: signalData,
          queuedAt: Date.now(),
          startTime: Date.now()
        };
      } catch (e) {}
    }
  }
}

// Queue for trades that couldn't be saved immediately (e.g. no auth)
const pendingTradeSaves = [];


// Patch active signal in Firebase without resetting `startTime`.
// Used for small updates (e.g., delayed opening price) where we must not restart countdown across users.
async function patchActiveSignalInFirebase(botKey, patch) {
  if (shouldSkipClientFirebaseWrites()) return;
  if (!auth.currentUser) return;
  try {
    const activeSignalRef = doc(db, 'activeSignals', botKey);
    const updatedAt = Date.now();
    const clean = omitUndefinedFields({ ...patch, updatedAt });
    // Never let a patch rewrite startTime / endAtMs (would desync countdown).
    delete clean.startTime;
    delete clean.endAtMs;
    try {
      await updateDoc(activeSignalRef, clean);
    } catch (e) {
      // If the doc doesn't exist yet (race), fall back to merge write without setting startTime.
      await setDoc(activeSignalRef, clean, { merge: true });
    }
  } catch (error) {
    // Silent failure is OK here; this is a best-effort sync optimization.
  }
}

// Clear active signal from Firebase
async function clearActiveSignalFromFirebase(botKey) {
  return;
  try {
    const activeSignalRef = doc(db, 'activeSignals', botKey);
    await deleteDoc(activeSignalRef);
    // console.log(`[Firebase] Cleared active signal for ${botKey}`);
  } catch (error) {
    // console.error(`[Firebase] Error clearing active signal for ${botKey}:`, error);
  }
}

// Save trade result to Firebase (global collection for all users) - only once per trade.
// Returns { tradeId, created, payload } on success, or null on failure.
async function saveTradeToFirebase(botKey, tradeData) {
  try {
    // History lives on Contabo tape. Do not write tradingResults / dailyStats / board.
    return null;
    if (shouldSkipClientFirebaseWrites()) return null;
    const user = auth && auth.currentUser;
    const prettySymbol = (window.__utkTradeNorm && typeof window.__utkTradeNorm.prettyOtcPair === 'function')
      ? window.__utkTradeNorm.prettyOtcPair(tradeData.symbol || tradeData.selectedCurrency || tradeData.currency)
      : '';
    const rawSymbol = prettySymbol || String(tradeData.symbol || '').trim();
    if (!rawSymbol || /^n\/?a$/i.test(rawSymbol)) {
      console.warn(`[Firebase] Skip trade save — missing pair for ${botKey}`);
      return null;
    }
    const openKey = toEpochMs(tradeData.openedAtMs) ?? toEpochMs(tradeData.openingTime) ?? toEpochMs(tradeData.timestamp) ?? Date.now();
    const timestamp = Math.trunc(Number(openKey) || Date.now());
    const closeKey = Math.trunc(Number(toEpochMs(tradeData.closingTime) || Date.now()));
    const resultStr = String(tradeData.result || '').trim().toUpperCase();
    const normalizedResult = (resultStr === 'WON' || resultStr === 'SUCCESS' || resultStr === 'W')
      ? 'WIN'
      : (resultStr === 'LOSE' || resultStr === 'LOST' || resultStr === 'L')
        ? 'LOSS'
        : resultStr;
    const attempt = tradeData.attempt != null && Number.isFinite(Number(tradeData.attempt))
      ? Number(tradeData.attempt)
      : 1;
    const tradeId = botStore.buildReadableTradeId({
      openMs: timestamp,
      pair: rawSymbol,
      result: normalizedResult,
      attempt,
    });
    const altTradeId = botStore.buildAltTradeId({
      openMs: timestamp,
      pair: rawSymbol,
      attempt,
    });
    const resultsCol = collection(db, ...botStore.tradingResultsPath(botKey));
    const tradeRef = doc(resultsCol, tradeId);
    const altTradeRef = doc(resultsCol, altTradeId);
    const boardRef = doc(db, ...botStore.boardPath(botKey));

    if (!user) {
      pendingTradeSaves.push({ botKey, tradeData, tradeId, enqueueAt: Date.now() });
      console.warn(`[Firebase] No user logged in — queued trade for ${botKey}: ${rawSymbol} (${timestamp})`);
      return null;
    }

    if (normalizedResult !== 'WIN' && normalizedResult !== 'LOSS') {
      console.warn(`[Firebase] Skip trade save — invalid result "${tradeData.result}"`);
      return null;
    }

    let created = false;
    let usedId = tradeId;
    const payload = {
      bot: botKey,
      displayTitle: botStore.tradeDisplayTitle(rawSymbol, normalizedResult, attempt),
      timestamp,
      phase: 'Trading Result',
      result: normalizedResult,
      symbol: rawSymbol,
      selectedCurrency: rawSymbol,
      currency: rawSymbol,
      isOtc: true,
      marketType: 'otc',
      action: tradeData.action,
      openingPrice: tradeData.openingPrice,
      closingPrice: tradeData.closingPrice,
      openingTime: timestamp,
      closingTime: closeKey,
      openedAtMs: timestamp,
      closedAtMs: closeKey,
      savingSignal: !!tradeData.savingSignal,
      savingSignalText: tradeData.savingSignalText || null,
      attempt: tradeData.attempt != null ? Number(tradeData.attempt) : null,
      stakeMultiplier: tradeData.stakeMultiplier != null ? Number(tradeData.stakeMultiplier) : null,
      savingStreakAtTrade: tradeData.savingStreakAtTrade != null ? Number(tradeData.savingStreakAtTrade) : null,
      userId: user.uid || null,
      source: 'electron-client',
      createdAt: Date.now()
    };

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(tradeRef);
      if (snap.exists()) {
        usedId = tradeId;
        return;
      }
      const altSnap = await tx.get(altTradeRef);
      if (altSnap.exists()) {
        usedId = altTradeId;
        return;
      }
      const boardSnap = await tx.get(boardRef);
      const prev = boardSnap.exists() ? (boardSnap.data() || {}) : botStore.emptyLiveBoard(botKey);
      const { board, completedStreak } = botStore.applyResultToBoard(prev, {
        bot: botKey,
        result: normalizedResult,
        endedAt: closeKey,
        startedAt: timestamp,
        pair: rawSymbol,
        tradeId,
        attempt,
      });
      created = true;
      usedId = tradeId;
      tx.set(tradeRef, payload);
      tx.set(boardRef, omitUndefinedFields(board), { merge: true });
      if (completedStreak && completedStreak.length > 0) {
        const streakId = botStore.buildStreakDocId(completedStreak);
        const streakRef = doc(db, ...botStore.pastWinStreaksPath(botKey), streakId);
        tx.set(streakRef, omitUndefinedFields({
          bot: botKey,
          displayTitle: `${completedStreak.length} wins`,
          length: completedStreak.length,
          startedAt: completedStreak.startedAt,
          endedAt: completedStreak.endedAt,
          createdAt: Date.now(),
          source: 'electron-client',
        }));
      }
    });

    console.log(`[Firebase] Trade ${created ? 'created' : 'already exists'} for ${botKey}: ${rawSymbol} - ${normalizedResult} (${timestamp}) id=${usedId}`);
    return { tradeId: usedId, created, payload };
  } catch (error) {
    console.error('[Firebase] Error saving trade:', error);
    if (error?.code !== 'permission-denied') {
      try { pendingTradeSaves.push({ botKey, tradeData, enqueueAt: Date.now(), err: String(error) }); } catch (e) {}
    }
    return null;
  }
}

/** Mirror a Firebase-confirmed trade into the in-memory history used by stats. */
function applyFirebaseTradeToHistory(botKey, tradeId, payload) {
  if (!botKey || !tradeId || !payload) return;
  let rowPayload = payload;
  try {
    if (window.__utkTradeNorm && typeof window.__utkTradeNorm.normalizeRow === 'function') {
      rowPayload = window.__utkTradeNorm.normalizeRow(payload) || payload;
    }
  } catch (e) {}
  try {
    if (window.__utkBotStats && typeof window.__utkBotStats.reconcileConfirmedTrade === 'function') {
      window.__utkBotStats.reconcileConfirmedTrade(botKey, tradeId, rowPayload);
      return;
    }
  } catch (e) {}
  if (!signalHistory[botKey]) signalHistory[botKey] = [];
  const row = { id: tradeId, ...payload, bot: botKey };
  const idx = signalHistory[botKey].findIndex((t) => t && t.id === tradeId);
  if (idx >= 0) {
    signalHistory[botKey][idx] = { ...signalHistory[botKey][idx], ...row };
  } else {
    signalHistory[botKey].unshift(row);
  }
  try { window.signalHistory = signalHistory; } catch (e) {}
}

// Attempt to flush any pending trade saves (called when auth becomes available)
async function flushPendingTradeSaves() {
  if (!pendingTradeSaves.length) return;
  if (!auth || !auth.currentUser) return;
  const pending = pendingTradeSaves.splice(0, pendingTradeSaves.length);
  for (const item of pending) {
    try {
      const saved = await saveTradeToFirebase(item.botKey, item.tradeData);
      if (!saved) {
        pendingTradeSaves.push(item);
      } else {
        console.log(`[Firebase] Flushed queued trade for ${item.botKey}`);
        try {
          applyFirebaseTradeToHistory(item.botKey, saved.tradeId, saved.payload);
          computeStatsFromHistory(item.botKey);
        } catch (e) {}
      }
    } catch (e) {
      pendingTradeSaves.push(item);
    }
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

  // Extract opening time with comprehensive fallback (handles cases where Signal phase was missed)
  const openingTimeMs =
    toEpochMs(result.openedAtMs) ??
    toEpochMs(result.opened_at_ms) ??
    toEpochMs(lastSignalTime[botKey]) ??
    toEpochMs(result.openingTime) ??
    toEpochMs(result.opening_time) ??
    toEpochMs(result.openTime) ??
    toEpochMs(result.open_time) ??
    toEpochMs(result.entryTime) ??
    toEpochMs(result.entry_time) ??
    toEpochMs(result.startTime) ??
    toEpochMs(result.start_time) ??
    toEpochMs(result.timestamp) ??
    null;
  
  const closingTimeMs =
    toEpochMs(result.closedAtMs) ??
    toEpochMs(result.closed_at_ms) ??
    toEpochMs(result.closingTime) ??
    toEpochMs(result.closing_time) ??
    toEpochMs(result.closeTime) ??
    toEpochMs(result.close_time) ??
    toEpochMs(result.exitTime) ??
    toEpochMs(result.exit_time) ??
    toEpochMs(result.endTime) ??
    toEpochMs(result.end_time) ??
    toEpochMs(result.time) ??
    Date.now();
  
  // Use opening time if available, otherwise use closing time (ensures we never end up with 0)
  const signalTimestamp = (openingTimeMs && openingTimeMs > 0) ? openingTimeMs : closingTimeMs;

  const symbolForKey =
    (window.__utkTradeNorm && window.__utkTradeNorm.pairFrom
      ? window.__utkTradeNorm.pairFrom(result, lastSignalCurrency[botKey])
      : '') ||
    resolveCurrency({ ...result, bot: botKey }) ||
    lastSignalCurrency[botKey] ||
    result.selectedCurrency ||
    result.symbol ||
    result.currency ||
    '';
  const resultForKey = (window.__utkTradeNorm && window.__utkTradeNorm.outcomeOf
    ? window.__utkTradeNorm.outcomeOf(result.result)
    : String(result.result || '').toUpperCase());
  if (resultForKey !== 'WIN' && resultForKey !== 'LOSS') {
    return;
  }
  if (!symbolForKey) {
    console.warn(`[Firebase] Skip trade save — missing pair for ${botKey}`);
    return;
  }

  // Whole-tape ladder: pair hops keep the step; WIN / 5-loss wipe starts a fresh 1x.
  const resolvedAttempt = resolveSavingAttempt(botKey, result);
  const losses = Number.isFinite(Number(result.savingStreakAtTrade))
    ? Number(result.savingStreakAtTrade)
    : Math.max(0, resolvedAttempt - 1);
  const wasSavingSignal = losses > 0;
  const savingLabel = getSavingSignalText(botKey, symbolForKey, Object.assign({}, result, { attempt: resolvedAttempt }));

  // Extract opening price with comprehensive fallback
  const extractedOpeningPrice =
    result.openingPrice ??
    result.opening_price ??
    result.openPrice ??
    result.open_price ??
    result.entryPrice ??
    result.entry_price ??
    result.openLevel ??
    result.open_level ??
    result.entryLevel ??
    result.entry_level ??
    lastSignalPrice[botKey] ??
    null;
  const openingPriceOut = (extractedOpeningPrice != null && extractedOpeningPrice !== 'N/A')
    ? extractedOpeningPrice
    : (lastSignalPrice[botKey] != null && lastSignalPrice[botKey] !== 'N/A' ? lastSignalPrice[botKey] : null);

  const extractedClosingPrice =
    result.closingPrice ??
    result.closing_price ??
    result.closePrice ??
    result.close_price ??
    result.exitPrice ??
    result.exit_price ??
    result.closeLevel ??
    result.close_level ??
    result.exitLevel ??
    result.exit_level ??
    result.price ??
    null;
  const closingPriceOut = (extractedClosingPrice != null && extractedClosingPrice !== 'N/A')
    ? extractedClosingPrice
    : null;

  const tradeKey = `${botKey}-${symbolForKey}-${resultForKey}-${signalTimestamp}`;
  const openFp = (openingPriceOut != null && openingPriceOut !== '' && openingPriceOut !== 'N/A')
    ? String(openingPriceOut)
    : '';
  const closeFp = (closingPriceOut != null && closingPriceOut !== '' && closingPriceOut !== 'N/A')
    ? String(closingPriceOut)
    : '';
  const hasPriceFp = !!(openFp && closeFp);
  const priceFp = `${botKey}-${symbolForKey}-${resultForKey}-${openFp}-${closeFp}`;

  if (
    lastTradeKey[botKey] === tradeKey
    || (hasPriceFp && lastTradeFp[botKey] && lastTradeFp[botKey].fp === priceFp
      && Math.abs((toEpochMs(signalTimestamp) || Date.now()) - Number(lastTradeFp[botKey].at || 0)) < 20000)
  ) {
    return;
  }
  try {
    if (window.__utkSavingHistory && typeof window.__utkSavingHistory.overlapsAsGhost === 'function') {
      const ghostOf = {
        result: resultForKey,
        phase: 'Trading Result',
        symbol: symbolForKey,
        currency: symbolForKey,
        selectedCurrency: symbolForKey,
        openedAtMs: signalTimestamp,
        openingTime: signalTimestamp,
        closedAtMs: closingTimeMs,
        closingTime: closingTimeMs
      };
      if (window.__utkSavingHistory.overlapsAsGhost(signalHistory[botKey], ghostOf)) {
        return;
      }
      if (typeof window.__utkSavingHistory.pruneCoveredGhosts === 'function') {
        signalHistory[botKey] = window.__utkSavingHistory.pruneCoveredGhosts(signalHistory[botKey], ghostOf);
      }
    }
  } catch (e) {}

  lastTradeKey[botKey] = tradeKey;
  if (hasPriceFp) lastTradeFp[botKey] = { fp: priceFp, at: toEpochMs(signalTimestamp) || Date.now() };

  const tradeData = {
    timestamp: signalTimestamp, // Opening time
    phase: 'Trading Result',
    result: resultForKey,
    symbol: symbolForKey,
    currency: symbolForKey,
    selectedCurrency: symbolForKey,
    isOtc: true,
    marketType: 'otc',
    action: normalizeTradeSide(result.action || result.side) || lastSignalAction[botKey] || '',
    openingPrice: openingPriceOut,
    closingPrice: closingPriceOut,
    openingTime: signalTimestamp,
    closingTime: closingTimeMs,
    openedAtMs: signalTimestamp,
    closedAtMs: closingTimeMs,
    savingSignal: wasSavingSignal,
    savingSignalText: savingLabel || null,
    saveStep: (window.__utkSavingStep && window.__utkSavingStep.badgeFor)
      ? window.__utkSavingStep.badgeFor(resolvedAttempt, resultForKey)
      : null,
    savingStreakAtTrade: losses,
    attempt: resolvedAttempt,
    stakeMultiplier: result.stakeMultiplier != null ? Number(result.stakeMultiplier) : undefined,
  };

  // Shared history only: write once to Firebase, then refresh stats from that history.
  try {
    console.debug(`[Firebase] addToHistory prepared tradeKey=${tradeKey} lastTradeKey=${lastTradeKey[botKey]} | openingTime=${signalTimestamp} openingPrice=${openingPriceOut}`);
    const saved = await saveTradeToFirebase(botKey, tradeData);
    if (saved && saved.tradeId) {
      console.log(`[App] Trade saved/ensured in Firebase for ${botKey}: ${tradeData.symbol} - ${tradeData.result} (ts=${signalTimestamp}, price=${openingPriceOut})`);
      applyFirebaseTradeToHistory(botKey, saved.tradeId, saved.payload);
      try { computeStatsFromHistory(botKey); } catch (e) {}
      try { updateBotActivityBadges(); } catch (e) {}
    } else {
      console.warn(`[App] Trade NOT saved immediately for ${botKey} (queued, denied, or failed): ${tradeData.symbol} - ${tradeData.result}`);
    }
  } catch (e) {
    console.error('[App] Unexpected error saving trade to Firebase:', e);
  }
}

const lastHistoryKey = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};
const lastTradeKey = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};
const lastTradeFp = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};
const lastLocalPhaseUpdate = {
  LUMIX: 0,
  MIRAX: 0,
  NYX: 0,
};

// Store opening price and time for each bot
const lastSignalPrice = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

const lastSignalAction = {
  LUMIX: '',
  MIRAX: '',
  NYX: '',
};

const lastSignalTime = {
  LUMIX: 0,
  MIRAX: 0,
  NYX: 0,
};

// Local receipt time of the last Signal phase (independent of server timestamps).
// Used to decide whether a Trading Result is part of the current in-session chain.
const lastSignalSeenAtLocal = {
  LUMIX: 0,
  MIRAX: 0,
  NYX: 0,
};

const lastResultKey = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

// Stats-only streak: number of consecutive losses since last win / reset.
// This is used for UI bucketing and loss counting (a "Loss" is counted only
// when a full 5-step sequence fails with 5 losses in a row).
const statsLossStreak = {
  LUMIX: 0,
  MIRAX: 0,
  NYX: 0,
};

// UI-only win streak (consecutive WIN results).
// This is purely for display and does not affect trading logic.
const statsWinStreak = {
  LUMIX: 0,
  MIRAX: 0,
  NYX: 0,
};

// Best win streak for the last 48 hours (rolling window).
const statsBestWinStreak = {
  LUMIX: 0,
  MIRAX: 0,
  NYX: 0,
};

// Daily stats reset (local time): stats should display only today's trades.
const statsDayKey = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

const STATS_MAX_DAYS_BACK = 30;

function formatLocalDateKey(ms) {
  return getLocalDayKey(ms);
}

function parseDateKeyToLocalStartMs(dateKey) {
  try {
    if (window.__utkStatsDay && typeof window.__utkStatsDay.dayStartMs === 'function') {
      const start = window.__utkStatsDay.dayStartMs(dateKey);
      if (start != null) return start;
    }
  } catch (e) {}
  const s = String(dateKey || '').trim();
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  // Use local time constructor (avoid Date('YYYY-MM-DD') which is UTC).
  const d = new Date(year, month - 1, day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatStatsDateLabel(dateKey) {
  try {
    const todayKey = formatLocalDateKey(Date.now());
    if (dateKey === todayKey) return 'Today';
    if (window.__utkStatsDay && typeof window.__utkStatsDay.formatLabel === 'function') {
      return window.__utkStatsDay.formatLabel(dateKey);
    }
    const start = parseDateKeyToLocalStartMs(dateKey);
    if (start == null) return '—';
    const d = new Date(start);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mon = months[d.getMonth()] || '';
    const day = String(d.getDate());
    return `${mon} ${day}, ${d.getFullYear()}`.trim();
  } catch (e) {
    return '—';
  }
}

function openNativeDatePicker(inputEl) {
  try {
    if (!inputEl) return;
    // Chromium/Electron supports showPicker on date inputs.
    if (typeof inputEl.showPicker === 'function') {
      inputEl.showPicker();
      return;
    }
  } catch (e) {}

  // Fallbacks
  try { inputEl.focus(); } catch (e) {}
  try { inputEl.click(); } catch (e) {}
}

function clampStatsDateKey(dateKey) {
  const now = Date.now();
  const todayKey = formatLocalDateKey(now);
  const todayStart = parseDateKeyToLocalStartMs(todayKey);
  const minStart = todayStart - (STATS_MAX_DAYS_BACK * 24 * 60 * 60 * 1000);

  const requestedStart = parseDateKeyToLocalStartMs(dateKey);
  if (requestedStart == null) return todayKey;
  if (requestedStart > todayStart) return todayKey;
  if (requestedStart < minStart) return formatLocalDateKey(minStart);
  return formatLocalDateKey(requestedStart);
}

function getStatsDateStorageKey(botKey) {
  return `stats:date:${botKey}`;
}

function getStatsDateModeStorageKey(botKey) {
  return `stats:date:mode:${botKey}`;
}

function getStatsDateMode(botKey) {
  try {
    return window.localStorage.getItem(getStatsDateModeStorageKey(botKey)) || 'auto';
  } catch (e) {
    return 'auto';
  }
}

function setStatsDateMode(botKey, mode) {
  try { window.localStorage.setItem(getStatsDateModeStorageKey(botKey), mode || 'auto'); } catch (e) {}
}

function getSelectedStatsDateKey(botKey) {
  try {
    const todayKey = formatLocalDateKey(Date.now());
    const mode = getStatsDateMode(botKey);
    if (mode !== 'fixed') return todayKey;
    const raw = window.localStorage.getItem(getStatsDateStorageKey(botKey));
    return clampStatsDateKey(raw || todayKey);
  } catch (e) {
    return formatLocalDateKey(Date.now());
  }
}

function setSelectedStatsDateKey(botKey, dateKey) {
  const todayKey = formatLocalDateKey(Date.now());
  const clamped = clampStatsDateKey(dateKey);
  setStatsDateMode(botKey, clamped === todayKey ? 'auto' : 'fixed');
  try { window.localStorage.setItem(getStatsDateStorageKey(botKey), clamped); } catch (e) {}
  return clamped;
}

function getSelectedStatsRangeMs(botKey) {
  const key = getSelectedStatsDateKey(botKey);
  const start = parseDateKeyToLocalStartMs(key) ?? getLocalDayStartMs(Date.now());
  const end = start + (24 * 60 * 60 * 1000);
  return { key, start, end };
}

function getLocalDayKey(ms) {
  try {
    if (window.__utkStatsDay && typeof window.__utkStatsDay.dayKey === 'function') {
      return window.__utkStatsDay.dayKey(ms);
    }
  } catch (e) {}
  const d = new Date(typeof ms === 'number' ? ms : Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLocalDayStartMs(ms) {
  try {
    if (window.__utkStatsDay && typeof window.__utkStatsDay.dayRange === 'function') {
      const range = window.__utkStatsDay.rangeForMs
        ? window.__utkStatsDay.rangeForMs(ms)
        : window.__utkStatsDay.dayRange(window.__utkStatsDay.dayKey(ms));
      if (range && Number.isFinite(range.start)) return range.start;
    }
  } catch (e) {}
  const d = new Date(typeof ms === 'number' ? ms : Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function resetBotStatsUI(botKey, preserveWinStreak = false) {
  try {
    lastResultKey[botKey] = null;
  } catch (e) {}
}

function ensureBotStatsDay(botKey, nowMs) {
  try {
    const dayKey = getSelectedStatsDateKey(botKey);
    if (statsDayKey[botKey] !== dayKey) {
      statsDayKey[botKey] = dayKey;
      const todayKey = formatLocalDateKey(Date.now());
      const preserveWinStreak = dayKey === todayKey;
      resetBotStatsUI(botKey, preserveWinStreak);
      return true;
    }
  } catch (e) {}
  return false;
}

let __dailyStatsResetTimer = null;
function scheduleDailyStatsReset() {
  try {
    if (__dailyStatsResetTimer) {
      clearTimeout(__dailyStatsResetTimer);
      __dailyStatsResetTimer = null;
    }

    const now = Date.now();
    let delay = 60 * 1000;
    try {
      if (window.__utkStatsDay && typeof window.__utkStatsDay.rangeForMs === 'function') {
        const range = window.__utkStatsDay.rangeForMs(now);
        delay = Math.max(1000, (range.end + 1000) - now);
      } else {
        const next = new Date(now);
        next.setDate(next.getDate() + 1);
        next.setHours(0, 0, 1, 0);
        delay = Math.max(1000, next.getTime() - now);
      }
    } catch (e) {
      const next = new Date(now);
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 1, 0);
      delay = Math.max(1000, next.getTime() - now);
    }

    __dailyStatsResetTimer = setTimeout(() => {
      try {
        // Only auto-roll stats forward if the user is viewing "Today".
        const todayKey = formatLocalDateKey(Date.now());
        utkWiredBots().forEach((b) => {
          try {
            const selected = getSelectedStatsDateKey(b);
            if (selected === todayKey) {
              // The meaning of "Today" changed; force refresh.
              statsDayKey[b] = null;
              ensureBotStatsDay(b, Date.now());
              try { computeStatsFromHistory(b); } catch (e) {}
              updateStatsDateUI(b);
            }
          } catch (e) {}
        });
      } catch (e) {}
      scheduleDailyStatsReset();
    }, delay);
  } catch (e) {}
}

function updateStatsDateUI(botKey) {
  try {
    const botId = botIdMap[botKey];
    if (!botId) return;
    const btn = document.getElementById(`statsDateBtn-${botId}`);
    const input = document.getElementById(`statsDateInput-${botId}`);
    if (!btn || !input) return;
    const todayKey = formatLocalDateKey(Date.now());
    let selectedKey = getSelectedStatsDateKey(botKey);
    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.getViewDayKey === 'function') {
        selectedKey = window.__utkBotStats.getViewDayKey(botKey) || selectedKey;
      }
    } catch (e) {}
    input.value = selectedKey;
    btn.textContent = formatStatsDateLabel(selectedKey);

    const todayBtn = document.getElementById(`statsDateToday-${botId}`);
    if (todayBtn) {
      const isToday = selectedKey === todayKey;
      todayBtn.classList.toggle('is-active', isToday);
    }
  } catch (e) {}
}

function initStatsDatePickers() {
  try {
    const bots = utkWiredBots();
    bots.forEach((botKey) => {
      const botId = botIdMap[botKey];
      if (!botId) return;
      const btn = document.getElementById(`statsDateBtn-${botId}`);
      const input = document.getElementById(`statsDateInput-${botId}`);
      if (!btn || !input) return;

      const wrap = btn.parentElement;

      const todayKey = formatLocalDateKey(Date.now());
      const todayStart = parseDateKeyToLocalStartMs(todayKey);
      const minStart = todayStart - (STATS_MAX_DAYS_BACK * 24 * 60 * 60 * 1000);
      const minKey = formatLocalDateKey(minStart);

      input.max = todayKey;
      input.min = minKey;

      updateStatsDateUI(botKey);

      const onOpen = (ev) => {
        try { ev && ev.preventDefault && ev.preventDefault(); } catch (e) {}
        openNativeDatePicker(input);
      };

      // Make the whole label clickable (not just the day/calendar hotspot)
      try { btn.addEventListener('click', onOpen); } catch (e) {}
      try { wrap && wrap.addEventListener('click', onOpen); } catch (e) {}

      input.addEventListener('change', () => {
        const newKey = setSelectedStatsDateKey(botKey, input.value);
        input.value = newKey;
        btn.textContent = formatStatsDateLabel(newKey);

        // Force a recompute for the selected day.
        statsDayKey[botKey] = null;
        try { ensureBotStatsDay(botKey, Date.now()); } catch (e) {}
        try { computeStatsFromHistory(botKey); } catch (e) {}
        updateStatsDateUI(botKey);
      });

      const todayBtn = document.getElementById(`statsDateToday-${botId}`);
      if (todayBtn) {
        todayBtn.addEventListener('click', (ev) => {
          try { ev && ev.preventDefault && ev.preventDefault(); } catch (e) {}
          const today = formatLocalDateKey(Date.now());
          setSelectedStatsDateKey(botKey, today);
          statsDayKey[botKey] = null;
          try { ensureBotStatsDay(botKey, Date.now()); } catch (e) {}
          try { computeStatsFromHistory(botKey); } catch (e) {}
          updateStatsDateUI(botKey);
        });
      }
    });
  } catch (e) {}
}

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

function setBestWinStreakUI(botKey, value) {
  try {
    const botId = botIdMap[botKey];
    if (!botId) return;
    const best = Math.max(0, parseInt(value, 10) || 0);
    const el = document.getElementById(`bestStreakValue-${botId}`);
    if (el) el.textContent = String(best);
  } catch (e) {}
}

function bumpBestWinStreak(botKey, current) {
  const cur = Math.max(0, Number(current) || 0);
  const best = Math.max(Number(statsBestWinStreak[botKey]) || 0, cur);
  statsBestWinStreak[botKey] = best;
  setBestWinStreakUI(botKey, best);
  return best;
}

// Win streak definition for UI:
// Count total wins since the last time the Stats "Chains lost" counter would increment.
// In this app, that increments only after 5 losses in a row.
function computeWinStreakStats(trades) {
  try {
    const list = Array.isArray(trades) ? trades : [];
    // Process chronological (oldest -> newest)
    const ordered = list.slice().reverse();
    let lossChain = 0;
    let wins = 0;
    let best = 0;

    ordered.forEach((t) => {
      const res = String(t?.result || '').toLowerCase().trim();
      const isLoss = (res === 'loss' || res === 'lose' || res === 'lost' || res === 'l');
      const isWin = (res === 'win' || res === 'won' || res === 'success' || res === 'w');

      if (isWin) {
        wins += 1;
        if (wins > best) best = wins;
        lossChain = 0;
        return;
      }
      if (isLoss) {
        lossChain += 1;
        if (lossChain >= 5) {
          // This is where Stats "Chains lost" would increment.
          wins = 0;
          lossChain = 0;
        }
      }
    });

    return { current: wins, best };
  } catch (e) {
    return { current: 0, best: 0 };
  }
}

function computeWinsSinceLastStatsLoss(trades) {
  return computeWinStreakStats(trades).current;
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

function computeStatsFromHistory(botKey) {
  try {
    if (window.__utkBotStats && typeof window.__utkBotStats.recompute === 'function') {
      return window.__utkBotStats.recompute(botKey);
    }
  } catch (e) {}
  // Fallback kept tiny — full logic lives in bot-stats.js
  try {
    if (window.__utkBotStats && typeof window.__utkBotStats.recomputeAll === 'function') {
      return window.__utkBotStats.recomputeAll();
    }
  } catch (e) {}
}

function updateBotStatsOnResult(botKey, data) {
  try {
    if (window.__utkBotStats && typeof window.__utkBotStats.onLiveResult === 'function') {
      return window.__utkBotStats.onLiveResult(botKey, data);
    }
  } catch (e) {}
  try {
    if (window.__utkBotStats && typeof window.__utkBotStats.recompute === 'function') {
      return window.__utkBotStats.recompute(botKey);
    }
  } catch (e) {}
}

// Track processed phase messages to prevent duplicates
const processedPhaseMessages = {
  LUMIX: new Set(),
  MIRAX: new Set(),
  NYX: new Set(),
};

// remember the most recent resolved currency for each bot; used when later
// phase updates omit the field entirely (which some bots do).  this ensures
// the "OTC" suffix sticks around through Signal/Trading Result phases.
const lastSignalCurrency = {
  LUMIX: '',
  MIRAX: '',
  NYX: '',
};

// Some bots must treat signals/results as a single active-symbol chain.
const SINGLE_ACTIVE_CHAIN_BOTS = new Set(['MIRAX', 'LUMIX', 'NYX']);
const activeChainSymbol = Object.create(null);

const SAVING_SIGNAL_MODES = {
  '2x': {
    multipliers: [1, 2, 4, 10, 20],
    labels: [null, '2x', '4x', '10x', '20x']
  },
  '4x': {
    multipliers: [1, 4, 7, 16, 44],
    labels: [null, '4x', '7x', '16x', '44x']
  }
};

const STATS_WIN_BUCKETS = [
  'stat-1x-wins',
  'stat-2x4x-wins',
  'stat-4x7x-wins',
  'stat-10x16x-wins',
  'stat-20x44x-wins'
];

function getSavingSignalTierIndex(losses) {
  return Math.min(Math.max(0, Number(losses) || 0), 4);
}

function getSavingSignalModeConfig(botKey) {
  try {
    if (window.__utkSavingLadder && typeof window.__utkSavingLadder.getConfig === 'function') {
      const cfg = window.__utkSavingLadder.getConfig(botKey);
      if (cfg && Array.isArray(cfg.multipliers) && cfg.multipliers.length >= 5) return cfg;
    }
  } catch (e) {}
  const mode = getSavingSignalMode(botKey);
  if (mode === 'custom') {
    const ladder = (typeof window.getSavingSignalLadder === 'function'
      ? window.getSavingSignalLadder(botKey)
      : null) || [1, 2, 5, 10, 25];
    const labels = [null];
    for (let i = 1; i < 5; i++) labels.push(String(ladder[i]) + 'x');
    return { multipliers: ladder.slice(0, 5), labels: labels };
  }
  return SAVING_SIGNAL_MODES[mode] || SAVING_SIGNAL_MODES['2x'];
}

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
  const bot = String(signal.bot || signal.botKey || '').toUpperCase();
  const raw = signal.selectedCurrency || signal.symbol || signal.currency || '';
  const rawStr = String(raw || '').trim();
  const looksOtc = !!(signal.isOtc || signal.otc || signal.is_otc || /\botc\b/i.test(rawStr));
  if (bot === 'LUMIX' || bot === 'MIRAX' || bot === 'NYX' || looksOtc) {
    try {
      if (window.__utkTradeNorm && typeof window.__utkTradeNorm.prettyOtcPair === 'function') {
        return window.__utkTradeNorm.prettyOtcPair(rawStr) || '';
      }
    } catch (e) {}
  }
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
try { window.resolveCurrency = resolveCurrency; } catch (e) {}

function formatCancelMessage(signal) {
  if (signal?.cancelMessage) return signal.cancelMessage;
  const reason = String(signal?.cancelReason || '').trim();
  if (reason === '15s_mom_entry' || reason === '15s_mom') {
    return 'Trade cancelled. Market momentum changed';
  }
  if (reason === 'no_entry_price') {
    return 'Trade cancelled. Could not confirm entry price';
  }
  if (reason.startsWith('15s_against')) {
    return 'Trade cancelled. Price moved against the signal';
  }
  if (reason.startsWith('15s_chase')) {
    return 'Trade cancelled. Price moved too far before entry';
  }
  return 'Trade cancelled. Market conditions changed';
}

const CANCELLED_DISPLAY_MS = 5000;

function showCancelledPhase(botKey, signal) {
  suppressPreparingUntilSignal[botKey] = false;
  delete activeChainSymbol[botKey];
  cancelResultAutoClear(botKey);
  clearCountdown(botKey);
  resetSignalStartNotification(botKey);

  const currency = resolveCurrency(signal) || lastSignalCurrency[botKey] || '';
  const cancelMessage = formatCancelMessage(signal);
  const side = String(signal.side || signal.action || '').toUpperCase();

  setTradeStatus(botKey, cancelMessage);
  scheduleRenderSignal(botKey, {
    ...signal,
    phase: 'Cancelled',
    cancelMessage,
    selectedCurrency: currency || signal.selectedCurrency,
    symbol: signal.symbol || currency,
    countdown: null,
    side,
    action: side,
  });

  try {
    saveActiveSignalToFirebase(botKey, {
      phase: 'Cancelled',
      cancelMessage,
      cancelReason: signal.cancelReason || '',
      selectedCurrency: currency,
      duration: 0,
    });
  } catch (e) {}

  scheduleResultAutoClear(botKey, CANCELLED_DISPLAY_MS);
}

function getDefaultPrepareSeconds(botKey) {
  // Keep in sync with bot dig/prepare waits (NewMirax PULSE=45 silent, Lumix SNAP=0).
  if (String(botKey || '').toUpperCase() === 'MIRAX') return 45;
  if (String(botKey || '').toUpperCase() === 'LUMIX') return 0;
  if (String(botKey || '').toUpperCase() === 'NYX') return 0;
  return 10;
}

function resetSignalStartNotification(botKey) {
  try {
    if (window.__utkSignalNotify && typeof window.__utkSignalNotify.resetHouseDedupe === 'function') {
      window.__utkSignalNotify.resetHouseDedupe(botKey);
    }
  } catch (e) {}
}

function canShowSignalStartNotification(botKey) {
  try {
    if (window.__utkSignalNotify && typeof window.__utkSignalNotify.canNotifyHouseBot === 'function') {
      return !!window.__utkSignalNotify.canNotifyHouseBot(botKey);
    }
  } catch (e) {}
  return false;
}

function showSignalStartNotification(botKey, signal) {
  try {
    if (window.__utkSignalNotify && typeof window.__utkSignalNotify.showHouseSignal === 'function') {
      window.__utkSignalNotify.showHouseSignal(botKey, signal);
    }
  } catch (e) {}
}

function getDefaultTradeSeconds(botKey) {
  try {
    if (window.__utkTradeDuration && typeof window.__utkTradeDuration.getDefaultTradeSeconds === 'function') {
      return window.__utkTradeDuration.getDefaultTradeSeconds(botKey);
    }
  } catch (e) {}
  if (String(botKey || '').toUpperCase() === 'MIRAX') return 30;
  if (String(botKey || '').toUpperCase() === 'NYX') return 60;
  if (String(botKey || '').toUpperCase() === 'LUMIX') return 180;
  return 180;
}

function resolveTradeDurationSec(botKey, signal, extra) {
  try {
    if (window.__utkTradeDuration && typeof window.__utkTradeDuration.resolveTradeDurationSec === 'function') {
      return window.__utkTradeDuration.resolveTradeDurationSec(botKey, signal, extra);
    }
  } catch (e) {}
  return getDefaultTradeSeconds(botKey);
}

function formatExpiryLabel(botKey, signal, extra) {
  try {
    if (window.__utkTradeDuration && typeof window.__utkTradeDuration.formatExpiryLabel === 'function') {
      return window.__utkTradeDuration.formatExpiryLabel(botKey, signal, extra);
    }
  } catch (e) {}
  if (String(botKey || '').toUpperCase() === 'MIRAX') return '30s';
  if (String(botKey || '').toUpperCase() === 'NYX') {
    const sec = resolveTradeDurationSec(botKey, signal, extra);
    if (sec >= 180) return '3m';
    if (sec >= 60) return '1m';
    return sec + 's';
  }
  return (signal && (signal.expiry || signal.expiration || signal.duration)) || '3m';
}

function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
try { window.formatCountdown = formatCountdown; } catch (e) {}

function formatTimeOnly(value) {
  try {
    if (window.__utkTradeTime && typeof window.__utkTradeTime.formatTimeOnly === 'function') {
      return window.__utkTradeTime.formatTimeOnly(value);
    }
  } catch (e) {}
  const ms = toEpochMs(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
try { window.escapeHtml = escapeHtml; } catch (e) {}

function formatTimePriceStack(timeValue, priceValue) {
  try {
    if (window.__utkTradeTime && typeof window.__utkTradeTime.formatTimePriceStack === 'function') {
      return window.__utkTradeTime.formatTimePriceStack(timeValue, priceValue);
    }
  } catch (e) {}
  const t = formatTimeOnly(timeValue);
  const pRaw = (priceValue !== undefined && priceValue !== null && priceValue !== 'N/A') ? String(priceValue) : '';
  const p = escapeHtml(pRaw);
  if (t && p) {
    return `<span class="tp-stack"><span class="tp-time">${escapeHtml(t)}</span><span class="tp-price">${p}</span></span>`;
  }
  return escapeHtml(t || pRaw || '');
}
try { window.formatTimePriceStack = formatTimePriceStack; } catch (e) {}

async function isSsidAutotradeReady(botKey) {
  return isSsidAutotradeReadySync(botKey);
}

async function executeSsidTrade(botKey, signal) {
  const botId = botIdMap[botKey];
  if (!botId) return { success: false, error: 'unknown bot' };

  // Main SignalHub owns SSID trades whenever it is connected.
  // Default __signalHubAutotrade=true prevents race doubles on startup.
  if (window.__signalHubAutotrade !== false) {
    return { success: false, error: 'hub owns trades' };
  }

  if (!isSsidAutotradeReadySync(botKey)) {
    const msg = 'SSID not connected — use Connect button';
    console.warn(`[${botKey}] SSID trade skipped: ${msg}`);
    try { setTradeStatus(botKey, msg); } catch (e) {}
    return { success: false, error: 'ssid offline' };
  }

  const side = normalizeTradeSide(signal.side || signal.action);
  const currency = resolveCurrency(signal) || lastSignalCurrency[botKey] || '';
  const { amount } = resolveTradeStakeAmount(botKey, signal);
  const duration = resolveTradeDurationSec(botKey, signal);

  if (!side || !currency || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    console.warn(`[${botKey}] SSID trade skipped: invalid params`, { side, currency, amount, duration });
    return { success: false, error: 'invalid trade params' };
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    console.warn(`[${botKey}] SSID trade skipped: invalid duration`, duration);
    return { success: false, error: 'invalid duration' };
  }

  const status = window.ssidManager?.statusByBot?.[botId];
  {
    const accountBalance = Number.isFinite(Number(status?.balance))
      ? Number(status.balance)
      : getSyncedAccountBalance(botKey);
    if (Number.isFinite(Number(accountBalance)) && Number(accountBalance) > 0 && Number(amount) >= Number(accountBalance)) {
      console.warn(`[${botKey}] SSID trade skipped: ${amount} >= balance ${accountBalance}`);
      try { setTradeStatus(botKey, 'Bet exceeds account balance'); } catch (e) {}
      return { success: false, error: 'insufficient balance' };
    }
  }

  const signalId = String(signal.signalId || '').trim()
    || (Number(signal.sentAtMs) > 0 ? `sent:${signal.sentAtMs}:a${Number(signal.attempt) || 1}` : '')
    || (Number(signal.openedAtMs) > 0 ? `open:${signal.openedAtMs}:a${Number(signal.attempt) || 1}` : '');
  if (!signalId) {
    console.warn(`[${botKey}] SSID trade skipped: missing stable signal id`);
    return { success: false, error: 'missing signal id' };
  }
  const signalAtMs = Number(signal.sentAtMs) || Number(signal.openedAtMs) || Date.now();
  if ((Date.now() - signalAtMs) > 15000) {
    console.warn(`[${botKey}] SSID trade skipped: stale signal`);
    return { success: false, error: 'stale signal' };
  }

  syncSavingSignalStakeToMain(botKey, currency, {
    duration,
    attempt: resolveSavingAttempt(botKey, signal),
    stakeMultiplier: signal?.stakeMultiplier
  });

  try {
    ipcRenderer.send('fast-pocket-option-trade', {
      botId,
      side,
      currency,
      amount: Number(amount),
      duration,
      signalAtMs,
      signalId,
      attempt: resolveSavingAttempt(botKey, signal)
    });
    return { success: true, queued: true };
  } catch (e) {
    console.warn(`[${botKey}] SSID trade send error:`, e.message);
    try { setTradeStatus(botKey, `Trade error: ${e.message}`); } catch (e2) {}
    return { success: false, error: e.message };
  }
}

// Set PocketOption stake before Signal so trade is ready when the signal arrives.
const ssidTradePrep = Object.create(null);

function isSsidAutotradeReadySync(botKey) {
  const botId = botIdMap[botKey];
  if (!botId) return false;
  const status = window.ssidManager?.statusByBot?.[botId];
  // Prefer live online, but do not treat a status blink as offline if SSID is still saved.
  if (status && !status.expired && status.hasSsid && status.activeOnline) return true;
  if (status && !status.expired && status.hasSsid) return true;
  try {
    for (const id of utkBotPanelIds()) {
      if (id === botId) continue;
      const sibling = window.ssidManager?.statusByBot?.[id];
      if (sibling && !sibling.expired && sibling.hasSsid) return true;
    }
  } catch (e) {}
  return false;
}

function syncAutotradeConfigToMain(botKey, opts = {}) {
  const botId = botIdMap[botKey];
  if (!botId) return;
  const prep = ssidTradePrep[botKey];
  const currency = opts.currency || prep?.currency || lastSignalCurrency[botKey] || '';
  const baseBet = getBetSize(botKey);
  const stakeAmount = opts.stakeAmount != null
    ? Number(opts.stakeAmount)
    : (currency ? resolveTradeStakeAmount(botKey, { currency, attempt: opts.attempt }).amount : baseBet);
  const multiplier = baseBet > 0 ? stakeAmount / baseBet : 1;
  const mode = getSavingSignalMode(botKey);
  try {
    const msg = {
      botId,
      savingSignalsEnabled: isSavingSignalsEnabled(botKey),
      savingSignalMode: mode,
      savingSignalLadder: (typeof window.getSavingSignalLadder === 'function'
        ? window.getSavingSignalLadder(botKey)
        : ((typeof getSavingSignalModeConfig === 'function' ? getSavingSignalModeConfig(botKey) : null)
          || SAVING_SIGNAL_MODES[mode]
          || SAVING_SIGNAL_MODES['2x']).multipliers),
      savingSignalMultiplier: multiplier,
      stakeAmount,
      currency: currency || undefined,
      duration: opts.duration != null ? Number(opts.duration) : (prep?.duration != null ? Number(prep.duration) : undefined)
    };
    const hydrated = document.getElementById(`betSize-${botId}`)?.dataset.hydrated === '1';
    if (hydrated && Number.isFinite(baseBet) && baseBet > 0) {
      msg.baseBet = baseBet;
      msg.betFromInput = true;
    }
    // Only touch autotrade enabled when caller is explicit (never infer here —
    // inferred false from other modules killed SignalHub placement).
    if (Object.prototype.hasOwnProperty.call(opts, 'enabled') && opts.enabled !== undefined) {
      msg.enabled = !!opts.enabled;
      msg.source = opts.source || 'user-toggle';
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'waitForChainEnd')) {
      msg.waitForChainEnd = !!opts.waitForChainEnd;
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'joinMidChain')) {
      msg.joinMidChain = !!opts.joinMidChain;
    }
    if (opts.joinAttempt != null && Number(opts.joinAttempt) > 0) {
      msg.joinAttempt = Number(opts.joinAttempt);
    }
    ipcRenderer.send('sync-autotrade-config', msg);
  } catch (e) {}
}

function syncAllAutotradeBetsToMain() {
  Object.entries(botIdMap).forEach(([botKey]) => {
    try {
      syncSavingSignalStakeToMain(botKey, lastSignalCurrency[botKey] || '');
      syncAutotradeConfigToMain(botKey, {
        enabled: isAutoTradeEnabled(botKey),
        source: 'user-toggle'
      });
    } catch (e) {}
  });
}
try {
  window.syncAutotradeConfigToMain = syncAutotradeConfigToMain;
  window.syncSavingSignalStakeToMain = syncSavingSignalStakeToMain;
  window.syncAllAutotradeBetsToMain = syncAllAutotradeBetsToMain;
  window.isAutoTradeEnabled = isAutoTradeEnabled;
} catch (e) {}

function prepareSsidTrade(botKey, signal) {
  if (!isAutoTradeEnabled(botKey) || !isSsidAutotradeReadySync(botKey)) return;
  try {
    if (window.shouldSkipAutotradeForChainWait?.(botKey, signal)) return;
  } catch (e) {}
  const botId = botIdMap[botKey];
  if (!botId) return;
  const currency = resolveCurrency(signal) || lastSignalCurrency[botKey] || '';
  if (!currency) return;
  const { amount, currency: cur } = resolveTradeStakeAmount(botKey, signal);
  const duration = resolveTradeDurationSec(botKey, signal) || getDefaultTradeSeconds(botKey);
  ssidTradePrep[botKey] = { currency: cur || currency, amount, duration, preparedAt: Date.now() };
  syncSavingSignalStakeToMain(botKey, currency, {
    duration,
    attempt: resolveSavingAttempt(botKey, signal),
    stakeMultiplier: signal?.stakeMultiplier
  });
}

function isChainRetrySignal(signal) {
  const attempt = Number(signal && signal.attempt) || 0;
  const realLossStreak = Number(
    signal && (signal.realLossStreak ?? signal.real_loss_streak)
  ) || 0;
  return attempt > 1 || realLossStreak > 0;
}

const botPhaseTail = Object.create(null);

function enqueueBotPhaseWork(botKey, work) {
  const key = botKey || '_global';
  const prev = botPhaseTail[key] || Promise.resolve();
  const next = prev.then(() => work()).catch((e) => console.warn('[PhaseQueue]', e));
  botPhaseTail[key] = next;
}

function isAutoTradeEnabled(botKey) {
  // Respect global forced-off flag and admin override
  if (window.autoTradesForcedOff && !window.adminAutoTradeOverride) return false;

  const botId = botIdMap[botKey];
  if (!botId) return false;
  const toggle = document.getElementById(`autoTradeToggle-${botId}`);
  return !!(toggle && toggle.checked);
}
try { window.isAutoTradeEnabled = isAutoTradeEnabled; } catch (e) {}

function hasActiveAppAccess() {
  try {
    if (window.__utkAccessGate && typeof window.__utkAccessGate.isPaid === 'function') {
      return !!window.__utkAccessGate.isPaid();
    }
  } catch (e) {}
  try {
    const cached = window.__utkEntitlementCache;
    if (cached && (cached.paidActive || cached.trialActive || cached.betaTester || cached.isOwner)) return true;
  } catch (e) {}

  try {
    const overlay = document.getElementById('subscription-overlay');
    if (overlay && overlay.classList.contains('active')) return false;
  } catch (e) {}

  const pill = document.getElementById('subscriptionPill');
  if (!pill) return false;
  const status = (pill.textContent || '').trim().toLowerCase();
  if (status === 'subscribed' || status === 'citizen' || status === 'member' || status === 'owner' || status === 'beta tester') return true;
  if (status === 'free trial') return true;
  if (status === 'wanderer' || /trial used|subscription ended|expired|trial ended/i.test(status)) return false;
  return false;
}

try { window.hasActiveAppAccess = hasActiveAppAccess; } catch (e) {}

function isSubscriptionPayScreenVisible() {
  try {
    const overlay = document.getElementById('subscription-overlay');
    if (!overlay) return false;
    return overlay.classList.contains('active') || overlay.style.display === 'flex';
  } catch (e) {
    return false;
  }
}

function isSavingSignalsEnabled(botKey) {
  let botId = null;
  try { botId = botIdMap[botKey]; } catch (e) {}
  if (!botId) {
    const k = String(botKey || '').toUpperCase();
    if (k === 'STUDIO') botId = 'studio';
    else if (String(botKey || '').toLowerCase() === 'studio') botId = 'studio';
  }
  if (!botId) return false;
  const enableToggle = document.getElementById(`savingSignalEnabled-${botId}`);
  if (botId === 'studio') {
    const auto = document.getElementById('studioAutoTrade');
    return !!(enableToggle && enableToggle.checked && auto && auto.checked);
  }
  return !!(enableToggle && enableToggle.checked && isAutoTradeEnabled(botKey));
}
try { window.isSavingSignalsEnabled = isSavingSignalsEnabled; } catch (e) {}

// Force-disable all auto-trades for the current user and persist a backup in Firestore
window.disableAllAutoTradesForUser = async function(opts = { persist: true }) {
  try {
    window.autoTradesForcedOff = true;
    const backup = {};
    utkWiredBots().forEach(botKey => {
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
  if (!botId) return null;
  const input = document.getElementById(`betSize-${botId}`);
  const val = parseFloat(input?.value);
  return Number.isFinite(val) && val > 0 ? val : null;
}

function setBetSizeValue(botId, value) {
  const input = document.getElementById(`betSize-${botId}`);
  if (!input) return;
  const min = parseFloat(input.min) || 1;
  const step = parseFloat(input.step) || 1;
  const rounded = step >= 1
    ? Math.round(value)
    : Math.round(value * 100) / 100;
  const next = Math.max(min, rounded);
  input.value = String(next);
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setupBetSizeControls() {
  utkBotPanelIds().forEach((botId) => {
    const input = document.getElementById(`betSize-${botId}`);
    const halfBtn = document.getElementById(`betSizeHalf-${botId}`);
    const doubleBtn = document.getElementById(`betSizeDouble-${botId}`);
    if (!input) return;

    if (halfBtn) {
      halfBtn.addEventListener('click', () => {
        const current = parseFloat(input.value) || 10;
        setBetSizeValue(botId, current / 2);
      });
    }

    if (doubleBtn) {
      doubleBtn.addEventListener('click', () => {
        const current = parseFloat(input.value) || 10;
        setBetSizeValue(botId, current * 2);
      });
    }

    const refreshHint = () => {
      updateBetChainHint(botId);
      const n = parseFloat(input.value);
      if (Number.isFinite(n) && n > 0 && (input.dataset.hydrated === '1' || input.dataset.touched === '1')) {
        try { ipcRenderer.send('set-autotrade-bet', { botId, amount: n }); } catch (e) {}
      }
      const botKey = Object.keys(botIdMap).find((k) => botIdMap[k] === botId);
      if (botKey) syncSavingSignalStakeToMain(botKey, lastSignalCurrency[botKey] || '');
    };

    input.addEventListener('input', () => {
      input.dataset.touched = '1';
      input.dataset.hydrated = '1';
      refreshHint();
    });
    input.addEventListener('change', refreshHint);
    updateBetChainHint(botId);
  });

  try {
    ipcRenderer.invoke('get-autotrade-bets').then((bets) => {
      utkBotPanelIds().forEach((id) => {
        const n = Number(bets && bets[id]);
        const el = document.getElementById(`betSize-${id}`);
        if (!el) return;
        el.dataset.hydrated = '1';
        if (Number.isFinite(n) && n > 0 && el.dataset.touched !== '1' && document.activeElement !== el) {
          el.value = String(n);
        }
        const live = parseFloat(el.value);
        if (Number.isFinite(live) && live > 0) {
          try { ipcRenderer.send('set-autotrade-bet', { botId: id, amount: live }); } catch (e) {}
        }
        updateBetChainHint(id);
      });
      try { syncAllAutotradeBetsToMain(); } catch (e) {}
    }).catch(() => {
      utkBotPanelIds().forEach((id) => {
        const el = document.getElementById(`betSize-${id}`);
        if (el) el.dataset.hydrated = '1';
      });
    });
  } catch (e) {}
}

function formatBetMoney(n) {
  const v = Math.round(Number(n) || 0);
  return `$${v}`;
}

function isSharedSsidOnline() {
  try {
    for (const id of utkBotPanelIds()) {
      const status = window.ssidManager?.statusByBot?.[id];
      if (status && status.hasSsid && status.activeOnline && !status.expired) return true;
    }
  } catch (e) {}
  return false;
}

function setBotAutotradeReason(botId, text) {
  const el = document.getElementById(`autotradeReason-${botId}`);
  if (!el) return;
  const msg = String(text || '').trim();
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function clearBotAutotradeReason(botId) {
  setBotAutotradeReason(botId, '');
}

function updateBotEmptyState(botKey) {
  const empty = signalEmptyStates[botKey];
  if (!empty) return;
  const display = signalDisplays[botKey];

  // PiP owns the signal block — don't flash empty under the dock strip.
  try {
    if (window.__utkSignalPip && typeof window.__utkSignalPip.isOpen === 'function' && window.__utkSignalPip.isOpen(botKey)) {
      return;
    }
  } catch (e) {}

  const hasCard = !!(display && display.querySelector && display.querySelector('.signal-card'));
  const showingSignal = hasCard || !!(window.utkSignalFx && typeof window.utkSignalFx.isShowing === 'function'
    ? window.utkSignalFx.isShowing(display)
    : (display && display.style.display !== 'none' && display.innerHTML.trim()));

  // Mid-connect / SSID refresh: if a live card exists, keep it visible always.
  if (hasCard && display) {
    display.style.display = '';
    display.classList.remove('utk-sig-hidden', 'utk-sig-out');
    empty.style.display = 'none';
    empty.classList.add('utk-sig-hidden');
  }

  // Keep empty node text fresh even while hidden so it is correct when cleared.
  const textEl = empty.querySelector('[data-empty-text]') || empty.querySelector('p');
  const botId = botIdMap[botKey];
  const cta = botId ? document.getElementById(`signalEmptyCta-${botId}`) : null;
  const wsOnline = !!window.__wsIsOnline;
  const autoOn = isAutoTradeEnabled(botKey);
  const ssidOnline = isSharedSsidOnline() || isSsidAutotradeReadySync(botKey);

  let text = 'Waiting for signals...';
  let showCta = false;
  if (!wsOnline) {
    text = 'Signal feed offline — reconnecting…';
  } else if (autoOn && !ssidOnline) {
    text = 'Connect Pocket Option to enable autotrade';
    showCta = true;
  } else if (suppressPreparingUntilSignal[botKey]) {
    text = 'Waiting for next signal…';
  } else if (autoOn) {
    text = 'Auto trade on. Waiting for a signal.';
  }

  if (textEl) textEl.textContent = text;
  if (cta) cta.hidden = !showCta || showingSignal;

  if (!showingSignal && empty.style.display === 'none' && !empty.classList.contains('utk-sig-out')) {
    empty.style.display = '';
    empty.classList.remove('utk-sig-hidden');
  }
}

function refreshAllBotEmptyStates() {
  utkWiredBots().forEach((botKey) => {
    try { updateBotEmptyState(botKey); } catch (e) {}
  });
  try {
    if (window.__utkStudioDeskParity && typeof window.__utkStudioDeskParity.refresh === 'function') {
      window.__utkStudioDeskParity.refresh();
    }
  } catch (e) {}
}

window.setBotAutotradeReason = setBotAutotradeReason;
window.clearBotAutotradeReason = clearBotAutotradeReason;
window.refreshAllBotEmptyStates = refreshAllBotEmptyStates;
window.updateBotEmptyState = updateBotEmptyState;

function updateBetChainHint(botId) {
  const hint = document.getElementById(`betChainHint-${botId}`);
  if (!hint) return;
  const botKey = Object.keys(botIdMap).find((k) => botIdMap[k] === botId)
    || (botId === 'studio' ? 'STUDIO' : null);
  if (!botKey || !isSavingSignalsEnabled(botKey)) {
    hint.hidden = true;
    hint.textContent = '';
    return;
  }

  const input = document.getElementById(`betSize-${botId}`);
  const base = Math.max(1, parseFloat(input?.value) || 10);
  const modeConfig = getSavingSignalModeConfig(botKey);
  const liveLadder = (modeConfig.multipliers || SAVING_SIGNAL_MODES['2x'].multipliers).slice(0, 5);
  const chainNeed = liveLadder.reduce((s, m) => s + base * Number(m || 0), 0);
  const currency = lastSignalCurrency[botKey] || '';
  const stake = getAdjustedBetSize(botKey, currency || undefined);
  const mult = base > 0 ? (stake / base) : 1;
  const losses = getSavingSignalLossesFromHistory(botKey);
  const tierLabel = modeConfig.labels?.[getSavingSignalTierIndex(losses)] || `${Math.round(mult)}x`;

  hint.hidden = false;
  hint.textContent = losses > 0
    ? `Now ${tierLabel} ${formatBetMoney(stake)}. Full chain ${formatBetMoney(chainNeed)}.`
    : `Next ${formatBetMoney(base)}. Full chain ${formatBetMoney(chainNeed)}.`;
}
try { window.updateBetChainHint = updateBetChainHint; } catch (eHint) {}

function getAdjustedBetSize(botKey, symbol, signal = null) {
  const baseBet = getBetSize(botKey);
  const botId = botIdMap[botKey];
  if (!botId) return baseBet;
  
  const autoTradeToggle = document.getElementById(`autoTradeToggle-${botId}`);
  if (!autoTradeToggle || !autoTradeToggle.checked) {
    return baseBet;
  }

  if (!isSavingSignalsEnabled(botKey)) {
    return baseBet;
  }

  const losses = signal
    ? resolveSavingLossesFromSignal(botKey, signal)
    : getSavingSignalLossesFromHistory(botKey);
  if (losses === 0) return baseBet;

  const modeConfig = getSavingSignalModeConfig(botKey);
  const idx = getSavingSignalTierIndex(losses);
  const multiplier = modeConfig.multipliers[idx];
  
  return baseBet * multiplier;
}

/**
 * Stake for autotrade under Saving Signals.
 * Uses the UI 2x/4x strategy ladder. Same-pair MG follows live attempt;
 * new-chain attempt 1 continues the bot-wide history ladder.
 */
function resolveTradeStakeAmount(botKey, signal) {
  try {
    if (window.__utkSavingStake && typeof window.__utkSavingStake.resolveLiveStake === 'function') {
      const r = window.__utkSavingStake.resolveLiveStake(botKey, Object.assign({}, signal || {}, {
        attempt: resolveSavingAttempt(botKey, signal || {})
      }));
      const currency = resolveCurrency(signal) || lastSignalCurrency[botKey] || r.currency || '';
      return { currency, amount: Number(r.amount) };
    }
  } catch (e) {}

  const currency = resolveCurrency(signal) || lastSignalCurrency[botKey] || '';
  const base = getBetSize(botKey);

  if (!isSavingSignalsEnabled(botKey)) {
    return { currency, amount: Number(base) };
  }

  const modeConfig = getSavingSignalModeConfig(botKey);
  const idx = Math.min(Math.max(0, resolveSavingAttempt(botKey, signal) - 1), 4);
  return { currency, amount: Number(base * (modeConfig.multipliers[idx] || 1)) };
}

function syncSavingSignalStakeToMain(botKey, currency, opts = {}) {
  const historyNext = Number(opts.historyNextAttempt) >= 1
    ? Math.min(5, Math.trunc(Number(opts.historyNextAttempt)))
    : Math.min(5, getSavingSignalLossesFromHistory(botKey) + 1);
  try {
    if (window.__utkSavingStake && typeof window.__utkSavingStake.pushConfigToMain === 'function') {
      const payload = {
        currency: currency || lastSignalCurrency[botKey] || '',
        attempt: opts.attempt,
        stakeMultiplier: opts.stakeMultiplier,
        duration: opts.duration,
        historyNextAttempt: historyNext
      };
      if (Object.prototype.hasOwnProperty.call(opts, 'enabled') && opts.enabled !== undefined) {
        payload.enabled = !!opts.enabled;
      }
      window.__utkSavingStake.pushConfigToMain(botKey, payload);
      return;
    }
  } catch (e) {}
  const botId = botIdMap[botKey];
  if (!botId) return;
  const cur = currency || lastSignalCurrency[botKey] || '';
  const baseBet = getBetSize(botKey);
  const { amount: stakeAmount } = resolveTradeStakeAmount(botKey, {
    currency: cur,
    attempt: opts.attempt,
    stakeMultiplier: opts.stakeMultiplier
  });
  const multiplier = baseBet > 0 ? stakeAmount / baseBet : 1;
  const mode = getSavingSignalMode(botKey);
  try {
    const msg = {
      botId,
      savingSignalsEnabled: isSavingSignalsEnabled(botKey),
      savingSignalMode: mode,
      savingSignalLadder: (typeof window.getSavingSignalLadder === 'function'
        ? window.getSavingSignalLadder(botKey)
        : ((typeof getSavingSignalModeConfig === 'function' ? getSavingSignalModeConfig(botKey) : null)
          || SAVING_SIGNAL_MODES[mode]
          || SAVING_SIGNAL_MODES['2x']).multipliers),
      savingSignalMultiplier: multiplier,
      stakeAmount,
      currency: cur || undefined,
      duration: opts.duration,
      clearStaleStake: true,
      historyNextAttempt: historyNext
    };
    const hydrated = document.getElementById(`betSize-${botId}`)?.dataset.hydrated === '1';
    if (hydrated && Number.isFinite(baseBet) && baseBet > 0) {
      msg.baseBet = baseBet;
      msg.betFromInput = true;
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'enabled') && opts.enabled !== undefined) {
      msg.enabled = !!opts.enabled;
      msg.source = opts.source || 'user-toggle';
    }
    ipcRenderer.send('sync-autotrade-config', msg);
    ipcRenderer.send('cache-trade-prep', {
      botId,
      currency: cur,
      amount: stakeAmount,
      duration: opts.duration,
      savingSignalMode: mode
    });
  } catch (e) {}
}

function getSavingSignalMode(botKey) {
  try {
    if (window.__utkSavingLadder && typeof window.__utkSavingLadder.getMode === 'function') {
      return window.__utkSavingLadder.getMode(botKey);
    }
  } catch (e) {}
  const botId = botIdMap[botKey] || (String(botKey || '').toLowerCase() === 'studio' ? 'studio' : null)
    || (String(botKey || '').toUpperCase() === 'STUDIO' ? 'studio' : null);
  if (!botId) return '2x';
  // Always return the stored strategy — never force 2x just because Saving looks off
  // (that wiped 4x/custom on every AT sync).
  try {
    const saved = window.localStorage.getItem(`savingSignalMode:${botId}`);
    if (saved === '4x' || saved === 'custom' || saved === '2x') return saved;
  } catch (e2) {}
  return '2x';
}

function getSavingSignalModeStorageKey(botId) {
  return `savingSignalMode:${botId}`;
}

function persistSavingSignalMode(botId, mode) {
  try {
    if (window.__utkSavingLadder && typeof window.__utkSavingLadder.setMode === 'function') {
      window.__utkSavingLadder.setMode(botId, mode, { silent: true });
      return;
    }
  } catch (e) {}
  try {
    const m = mode === '4x' || mode === 'custom' ? mode : '2x';
    window.localStorage.setItem(getSavingSignalModeStorageKey(botId), m);
  } catch (e2) {}
}

function restoreSavingSignalMode(botId) {
  try {
    if (window.__utkSavingLadder && typeof window.restoreSavingSignalMode === 'function') {
      window.restoreSavingSignalMode(botId);
      return;
    }
  } catch (e) {}
}

function getSavingSignalText(botKey, symbol, signal = null) {
  let attempt = 1;
  try {
    attempt = resolveSavingAttempt(botKey, signal || { symbol: symbol });
  } catch (e) {
    attempt = 1;
  }
  const showMultiplier = !!(isAutoTradeEnabled(botKey) && isSavingSignalsEnabled(botKey));
  const mode = showMultiplier ? getSavingSignalMode(botKey) : '2x';
  let ladder = null;
  try {
    if (showMultiplier && typeof window.getSavingSignalLadder === 'function') {
      ladder = window.getSavingSignalLadder(botKey);
    }
  } catch (e3) {}
  const resultU = String((signal && signal.result) || '').trim().toUpperCase();
  try {
    if (window.__utkSavingStep && typeof window.__utkSavingStep.formatStepLabel === 'function') {
      return window.__utkSavingStep.formatStepLabel(attempt, {
        showMultiplier: showMultiplier,
        mode: mode,
        ladder: ladder,
        result: resultU
      });
    }
  } catch (e2) {}
  if (attempt <= 1) return null;
  return 'S' + (attempt - 1);
}

function getSavingSignalMessage(botKey) {
  if (!isSavingSignalsEnabled(botKey)) return null;
  const losses = getSavingSignalLosses(botKey);
  if (losses >= 4) {
    return "We are sorry for the loss, let's try to fix that";
  }
  return null;
}


const lastAutoTradeKey = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

function attemptAutoTrade(botKey, signal) {
  if (!utkCanFollowBot(botKey)) return;
  if (!isAutoTradeEnabled(botKey)) return;
  try {
    if (window.shouldSkipAutotradeForChainWait?.(botKey, signal)) return;
  } catch (e) {}
  // Main-process SignalHub is the sole SSID trade owner while connected.
  // Default true until we explicitly hear hub is down — prevents double entries.
  if (window.__signalHubAutotrade !== false) return;

  const side = normalizeTradeSide(signal.side || signal.action);
  if (!side) return;
  const currency = resolveCurrency(signal) || lastSignalCurrency[botKey] || '';
  const attempt = Number(signal?.attempt) || 1;
  const identity = String(signal.signalId || '').trim()
    || (Number(signal.sentAtMs) > 0 ? `sent:${signal.sentAtMs}:a${attempt}` : '')
    || (Number(signal.openedAtMs) > 0 ? `open:${signal.openedAtMs}:a${attempt}` : '')
    || `${side}-${currency}-${signal.openingTime || signal.time || ''}-a${attempt}`;
  const key = `${botKey}:${identity}`;
  if (lastAutoTradeKey[botKey] === key) return;
  lastAutoTradeKey[botKey] = key;

  executeSsidTrade(botKey, signal).catch((e) => {
    console.warn(`[${botKey}] autotrade error:`, e.message || e);
  });
}

function botKeyToSwitchTarget(botKey) {
  return utkBotIdOf(botKey) || null;
}

const SWITCH_GLOW_CLASSES = [
  'switch-glow-preparing',
  'switch-glow-buy',
  'switch-glow-sell',
  'switch-glow-win',
  'switch-glow-loss',
  'switch-glow-cancelled'
];

function applySwitchBtnGlow(botKey, className) {
  const target = botKeyToSwitchTarget(botKey);
  if (!target) return;
  document.querySelectorAll(`.bot-switch-btn[data-target="${target}"]`).forEach((btn) => {
    btn.classList.remove(...SWITCH_GLOW_CLASSES);
    if (className) btn.classList.add(className);
  });
}

const lastAppliedGlow = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

function applyPhaseGlow(botKey, { phase, action, result }) {
  const container = botContainers[botKey];
  const classes = ['glow-preparing', 'glow-buy', 'glow-sell', 'glow-win', 'glow-loss', 'glow-cancelled'];

  const upperPhase = (phase || '').toLowerCase();
  const upperAction = (action || '').toLowerCase();
  const upperResult = (result || '').toLowerCase();

  let areaClass = null;
  let switchClass = null;

  if (upperPhase === 'preparing') {
    areaClass = 'glow-preparing';
    switchClass = 'switch-glow-preparing';
  } else if (upperPhase === 'cancelled') {
    areaClass = 'glow-cancelled';
    switchClass = 'switch-glow-cancelled';
  } else if (upperPhase === 'signal') {
    if (upperAction === 'buy') {
      areaClass = 'glow-buy';
      switchClass = 'switch-glow-buy';
    } else if (upperAction === 'sell') {
      areaClass = 'glow-sell';
      switchClass = 'switch-glow-sell';
    }
  } else if (upperPhase === 'trading result' || upperPhase === 'result') {
    if (upperResult === 'win') {
      areaClass = 'glow-win';
      switchClass = 'switch-glow-win';
    } else if (upperResult === 'loss' || upperResult === 'lose') {
      areaClass = 'glow-loss';
      switchClass = 'switch-glow-loss';
    }
  }

  // Skip forced reflow when glow is already correct — big jank saver on countdown ticks.
  if (lastAppliedGlow[botKey] === areaClass) {
    applySwitchBtnGlow(botKey, switchClass);
    return;
  }
  lastAppliedGlow[botKey] = areaClass;

  if (container) {
    container.classList.remove(...classes);
    if (areaClass) {
      requestAnimationFrame(() => {
        try { container.classList.add(areaClass); } catch (e) {}
      });
    }
  }
  applySwitchBtnGlow(botKey, switchClass);
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
  if (list.length > 5000) list.length = 5000;

  // Recompute stats whenever history changes so UI reflects stored data
  try { computeStatsFromHistory(botKey); } catch (e) {}
} 

function renderHistoryModal(botKey) {
  if (typeof window.__utkRenderHistory === 'function') {
    return window.__utkRenderHistory(botKey);
  }
}

try { window.renderHistoryModal = renderHistoryModal; } catch (e) {}

function setWsStatus(state) {
  if (!wsStatusEl) return;
  wsStatusEl.classList.remove('online', 'offline', 'connecting');
  wsStatusEl.classList.add(state);
  if (state === 'online') wsStatusEl.textContent = 'Live';
  else if (state === 'connecting') wsStatusEl.textContent = 'Connecting';
  else wsStatusEl.textContent = 'Offline';
  
  // Update dashboard health indicator
  updateHealthWS(state);
  try { refreshAllBotEmptyStates(); } catch (e) {}
}

// Coalesced scheduler for signal renders. Defers during resize and coalesces rapid updates using rAF
function scheduleRenderSignal(botKey, signal) {
  window.__renderQueue = window.__renderQueue || {};

  // If actively resizing, defer heavy renders — but ALWAYS arm a safety flush.
  // prepare-resize can set .resizing without a later resize event; without this,
  // notifications fire and the card never paints.
  const isResizing = (typeof document !== 'undefined' && document.documentElement && document.documentElement.classList.contains('resizing')) || !!window.__isResizing;
  if (isResizing) {
    window.__renderQueue[botKey] = signal;
    window.__pendingRenderDuringResize = true;
    if (!window.__renderQueueSafetyTimer) {
      window.__renderQueueSafetyTimer = setTimeout(function () {
        window.__renderQueueSafetyTimer = null;
        try {
          if (window.__utkAppPerf && typeof window.__utkAppPerf.endResize === 'function') {
            window.__utkAppPerf.endResize();
          } else {
            try { document.documentElement.classList.remove('resizing'); } catch (e) {}
            try { window.__isResizing = false; } catch (e2) {}
            window.dispatchEvent(new Event('app:resize-finish'));
          }
        } catch (e3) {
          try { window.dispatchEvent(new Event('app:resize-finish')); } catch (e4) {}
        }
      }, 280);
    }
    return;
  }

  // Normal path: coalesce with one rAF, then flush EVERY pending bot.
  // (Previously only the first botKey was rendered — Mirax often got glow from
  // the Firebase listener but an empty card when Lumix restored in the same frame.)
  const q = window.__renderQueue;
  q[botKey] = signal;
  if (window.__renderQueueTicking) return;
  window.__renderQueueTicking = true;
  requestAnimationFrame(() => {
    window.__renderQueueTicking = false;
    const pending = window.__renderQueue || {};
    const keys = Object.keys(pending).filter((k) => utkWiredBots().indexOf(k) >= 0);
    for (const k of keys) {
      const toRender = pending[k];
      delete pending[k];
      if (!toRender) continue;
      try {
        renderSignalCard(k, toRender);
      } catch (e) {
        try { renderSignalCard(k, toRender); } catch (ee) {}
      }
    }
  });
}

function formatSignalTimeDisplay(signal) {
  try {
    if (window.__utkTradeTime && typeof window.__utkTradeTime.formatSignalTimeDisplay === 'function') {
      return window.__utkTradeTime.formatSignalTimeDisplay(signal);
    }
  } catch (e) {}
  const raw = signal?.openedAtMs ?? signal?.openingTime ?? signal?.signalTime ?? signal?.signalTimestamp ?? signal?.time ?? signal?.timestamp;
  if (raw === undefined || raw === null || raw === '') return '';
  const local = formatTimeOnly(raw);
  if (local) return local;
  const ms = toEpochMs(raw);
  if (!ms) return String(raw);
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderSignalCard(botKey, signal) {
  // Defer heavy signal renders while user is actively resizing the window to avoid jank
  try {
    if (document && document.documentElement && document.documentElement.classList.contains('resizing')) {
      window.__renderQueue = window.__renderQueue || {};
      window.__renderQueue[botKey] = signal;
      window.__pendingRenderDuringResize = true;
      if (!window.__renderQueueSafetyTimer) {
        window.__renderQueueSafetyTimer = setTimeout(function () {
          window.__renderQueueSafetyTimer = null;
          try {
            if (window.__utkAppPerf && typeof window.__utkAppPerf.endResize === 'function') {
              window.__utkAppPerf.endResize();
            } else {
              window.dispatchEvent(new Event('app:resize-finish'));
            }
          } catch (e) {
            try { window.dispatchEvent(new Event('app:resize-finish')); } catch (e2) {}
          }
        }, 280);
      }
      return;
    }
  } catch (e) {}

  const display = signalDisplays[botKey];
  if (!display) return;
  const emptyState = signalEmptyStates[botKey];
  const wasHidden = display.style.display === 'none'
    || display.classList.contains('utk-sig-hidden')
    || display.classList.contains('utk-sig-out')
    || !display.innerHTML.trim();
  if (!window.utkSignalFx) {
    if (emptyState) emptyState.style.display = 'none';
    display.style.display = 'block';
  } else {
    display.style.display = '';
    display.classList.remove('utk-sig-hidden', 'utk-sig-out');
  }

  const phase = signal.phase || 'Signal';
  if (phase === 'Preparing') return;

  const currency = resolveCurrency({ ...signal, bot: botKey }) || lastSignalCurrency[botKey] || '';
  const action = normalizeTradeSide(signal.side || signal.action) || lastSignalAction[botKey] || '';
  const price = (signal.openingPrice != null && signal.openingPrice !== 'N/A')
    ? signal.openingPrice
    : (signal.price != null && signal.price !== 'N/A' ? signal.price : lastSignalPrice[botKey]);
  const expiry = formatExpiryLabel(botKey, signal);
  const openingTime = formatSignalTimeDisplay(signal);
  const resultNorm = (window.__utkTradeNorm && window.__utkTradeNorm.outcomeOf)
    ? window.__utkTradeNorm.outcomeOf(signal.result)
    : String(signal.result || '').toUpperCase();
  const result = (resultNorm === 'WIN' || resultNorm === 'LOSS') ? resultNorm : '';
  const countdownVal = (signal.countdown !== undefined && signal.countdown !== null)
    ? Math.max(0, Math.floor(signal.countdown))
    : null;
  const hideCountdownPhase =
    phase === 'Trading Result' ||
    phase === 'Cancelled' ||
    phase === 'Chain Complete';
  const preparingDone = phase === 'Preparing' && (countdownVal === 0 || signal.preparingDone) && signal.livePreparing;
  // Never show countdown on Result / Cancelled — was flashing 00:00 after clearCountdown.
  const countdownDisplay = (hideCountdownPhase || preparingDone)
    ? null
    : (countdownVal !== null && countdownVal > 0 ? formatCountdown(countdownVal) : null);
  const savingSignalText = getSavingSignalText(botKey, currency, signal);
  const savingMessage = getSavingSignalMessage(botKey);  // Show in all phases

  const rows = [];
  rows.push({ label: 'Phase', value: phase });
  if (currency) rows.push({ label: 'Pair', value: currency });
  
  if (phase !== 'Preparing') {
    if (action) {
      const valueClass = action === 'BUY' ? 'up' : (action === 'SELL' ? 'down' : '');
      rows.push({ label: 'Action', value: action, valueClass });
    }
    if (phase === 'Signal') {
      if (price !== undefined && price !== null && price !== 'N/A') {
        rows.push({ label: 'Open Price', value: price });
      }
      if (expiry) rows.push({ label: 'Expiry', value: expiry });
    }
  }

  if (phase === 'Cancelled') {
    const msg = signal.cancelMessage || formatCancelMessage(signal);
    rows.push({ label: 'Status', value: msg, valueClass: 'cancelled' });
  }

  if (phase === 'Signal' && signal.settling) {
    rows.push({ label: 'Status', value: signal.statusText || 'Settling…' });
  }
  if (phase === 'Signal' && openingTime) rows.push({ label: 'Opens', value: openingTime });
  if (phase === 'Trading Result' && result) rows.push({ label: 'Result', value: result });
  if (phase === 'Trading Result') {
    const openPriceRaw = (signal.openingPrice !== undefined && signal.openingPrice !== null && signal.openingPrice !== 'N/A')
      ? signal.openingPrice
      : lastSignalPrice[botKey];
    const closePriceRaw = (signal.closingPrice !== undefined && signal.closingPrice !== null && signal.closingPrice !== 'N/A')
      ? signal.closingPrice
      : (signal.price !== undefined && signal.price !== null && signal.price !== 'N/A' ? signal.price : '');
    const openPrice = (openPriceRaw !== undefined && openPriceRaw !== null && openPriceRaw !== 'N/A') ? String(openPriceRaw) : '';
    const closePrice = (closePriceRaw !== undefined && closePriceRaw !== null && closePriceRaw !== 'N/A') ? String(closePriceRaw) : '';
    const openCombined = formatTimePriceStack(
      signal.openedAtMs || signal.openingTime || lastSignalTime[botKey],
      openPrice,
      signal
    );
    const closeCombined = formatTimePriceStack(signal.closedAtMs || signal.closingTime, closePrice, signal);
    if (openCombined) rows.push({ label: 'Open', value: openCombined });
    if (closeCombined) rows.push({ label: 'Close', value: closeCombined });
  }

  // Skip full DOM rebuild when only the countdown tick changed.
  const structureKey = [
    phase,
    currency || '',
    action || '',
    String(price ?? ''),
    result || '',
    savingSignalText || '',
    savingMessage || '',
    preparingDone ? '1' : '0',
    countdownDisplay != null ? '1' : '0',
    rows.map((r) => `${r.label}:${r.value}:${r.valueClass || ''}`).join(';')
  ].join('|');

  const existingCard = display.querySelector('.signal-card');
  if (existingCard && existingCard.dataset.utkStructure === structureKey) {
    if (!hideCountdownPhase) {
      if (preparingDone) {
        updatePreparingWaitUI(botKey);
      } else if (countdownVal !== null && countdownVal > 0) {
        updateSignalCountdown(botKey, countdownVal);
      }
    }
    applyPhaseGlow(botKey, { phase, action, result });
    return;
  }

  const rowsHtml = rows.map(r => `
    <div class="signal-row"${r.kind ? ` data-kind="${r.kind}"` : ''}>
      <span class="label">${r.label}</span>
      <span class="value${r.valueClass ? ` ${r.valueClass}` : ''}">${r.value}</span>
    </div>`).join('');

  display.innerHTML = `
    <div class="signal-card">
      ${savingSignalText ? `<div class="saving-signal-banner">${savingSignalText}</div>` : ''}
      ${savingMessage ? `<div class="saving-signal-message">${savingMessage}</div>` : ''}
      ${phase === 'Cancelled' ? `<div class="signal-cancelled-banner">${signal.cancelMessage || formatCancelMessage(signal)}</div>` : ''}
      ${preparingDone ? `<div class="signal-countdown preparing-countdown"><span class="countdown-label">Status</span><span class="countdown-value" data-countdown="${botKey}">Checking entry…</span></div>` : ''}
      ${countdownDisplay ? `<div class="signal-countdown${phase === 'Preparing' ? ' preparing-countdown' : ''}"><span class="countdown-label">${phase === 'Preparing' ? 'Opens in' : 'Countdown'}</span><span class="countdown-value" data-countdown="${botKey}">${countdownDisplay}</span></div>` : ''}
      ${rowsHtml}
    </div>
  `;
  const newCard = display.querySelector('.signal-card');
  if (newCard) {
    newCard.dataset.utkStructure = structureKey;
    newCard.dataset.utkPhase = phase;
  }

  if (window.utkSignalFx && typeof window.utkSignalFx.reveal === 'function') {
    window.utkSignalFx.reveal(botKey, display, emptyState, { fromEmpty: wasHidden, phase });
  } else if (wasHidden && newCard) {
    newCard.classList.add('utk-sig-card-enter');
  }

  applyPhaseGlow(botKey, { phase, action, result });
  try {
    if (window.__utkSignalPip && typeof window.__utkSignalPip.onRender === 'function') {
      window.__utkSignalPip.onRender(botKey, signal);
    }
  } catch (e) {}
}

// Flush any deferred signal renders after resize finishes
window.addEventListener('app:resize-finish', () => {
  if (window.__renderQueueSafetyTimer) {
    try { clearTimeout(window.__renderQueueSafetyTimer); } catch (e) {}
    window.__renderQueueSafetyTimer = null;
  }
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
  try {
    if (window.__utkSignalPip && typeof window.__utkSignalPip.onCountdown === 'function') {
      window.__utkSignalPip.onCountdown(botKey, seconds);
    }
  } catch (e) {}
}
try { window.updateSignalCountdown = updateSignalCountdown; } catch (e) {}

// Example function to add a signal (call this when a new signal is received)
function addLumixSignal({ time, type, symbol, strength }) {
  if (!lumixSignalList) return;
  const li = document.createElement('li');
  li.className = 'bot-signal-item ' + (type === 'BUY' ? 'up' : 'down');
  li.innerHTML = `
    <span class="signal-time">${time}</span>
    <span class="signal-type">${type}</span>
    <span class="signal-symbol">${symbol}</span>
    <span class="signal-strength">${type === 'BUY' ? 'UP' : 'DN'} ${strength}</span>
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
  NYX: document.querySelector('#section-bot3 .trade-card'),
};

const botCountdowns = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

const botExpireAt = {
  LUMIX: 0,
  MIRAX: 0,
  NYX: 0,
};

// Auto-clear Trading Result after a short window so UI returns to the empty state.
const resultAutoClearTimers = {
  LUMIX: null,
  MIRAX: null,
  NYX: null,
};

const liveResultHoldUntil = {
  LUMIX: 0,
  MIRAX: 0,
  NYX: 0,
};

function isLiveCardProtected(botKey) {
  if (botCountdowns[botKey]) return true;
  if (botExpireAt[botKey] && Date.now() < botExpireAt[botKey]) return true;
  if (liveResultHoldUntil[botKey] && Date.now() < liveResultHoldUntil[botKey]) return true;
  return false;
}

// After a Trading Result, keep UI empty until the next Signal.
const suppressPreparingUntilSignal = {
  LUMIX: false,
  MIRAX: false,
  NYX: false,
};

function clearSignalUI(botKey) {
  liveResultHoldUntil[botKey] = 0;
  try {
    const botId = utkBotIdOf(botKey) || botIdMap[botKey];
    // Empty card is not "chain over" — a LOSS still waits on the next MG step.
    if (!window.isSignalChainOngoing?.(botId)) {
      window.markAutotradeChainIdle?.(botKey);
    }
  } catch (e) {}
  // Keep BotPhaseGuard identity so a delayed Signal for the settled trade
  // cannot resurrect after the Result card clears.
  try {
    if (window.utkSignalFx && typeof window.utkSignalFx.resetPhase === 'function') {
      window.utkSignalFx.resetPhase(botKey);
    }
  } catch (e) {}
  try {
    if (window.__utkSignalPip && typeof window.__utkSignalPip.isOpen === 'function' && window.__utkSignalPip.isOpen(botKey)) {
      const display = signalDisplays[botKey];
      if (display) display.innerHTML = '';
      if (typeof window.__utkSignalPip.onClear === 'function') window.__utkSignalPip.onClear(botKey);
      return;
    }
  } catch (e) {}

  const display = signalDisplays[botKey];
  const emptyState = signalEmptyStates[botKey];
  const container = botContainers[botKey];

  const finish = () => {
    if (display) {
      display.innerHTML = '';
      display.style.display = 'none';
      display.classList.add('utk-sig-hidden');
      display.classList.remove('utk-sig-in', 'utk-sig-out', 'utk-sig-prep');
    }
    // Restore CSS-defined empty state layout (centers the content).
    if (emptyState) {
      emptyState.style.display = '';
      emptyState.classList.remove('utk-sig-hidden', 'utk-sig-out');
    }

    // Remove glow overlay so empty state is dark/neutral again (not preparing tint).
    if (container) {
      container.classList.remove('glow-preparing', 'glow-buy', 'glow-sell', 'glow-win', 'glow-loss', 'glow-cancelled');
    }
    applyPhaseGlow(botKey, { phase: 'idle' });
    try { updateBotEmptyState(botKey); } catch (e) {}
  };

  if (window.utkSignalFx && typeof window.utkSignalFx.hide === 'function') {
    window.utkSignalFx.hide(botKey, display, emptyState, () => {
      if (display) {
        display.innerHTML = '';
        display.style.display = 'none';
        display.classList.add('utk-sig-hidden');
      }
      if (container) {
        container.classList.remove('glow-preparing', 'glow-buy', 'glow-sell', 'glow-win', 'glow-loss', 'glow-cancelled');
      }
      applyPhaseGlow(botKey, { phase: 'idle' });
      try { updateBotEmptyState(botKey); } catch (e) {}
    });
    return;
  }

  finish();
}

function purgeStaleActiveSignal(botKey) {
  try { clearActiveSignalFromFirebase(botKey); } catch (e) {}
  clearCountdown(botKey);
  resetTradeCard(botKey);
  clearSignalUI(botKey);
}

function scheduleResultAutoClear(botKey, delayMs) {
  try {
    if (resultAutoClearTimers[botKey]) {
      clearTimeout(resultAutoClearTimers[botKey]);
      resultAutoClearTimers[botKey] = null;
    }
  } catch (e) {}

  const wait = Math.max(0, Number(delayMs) || 0);
  liveResultHoldUntil[botKey] = Date.now() + wait;

  resultAutoClearTimers[botKey] = setTimeout(() => {
    liveResultHoldUntil[botKey] = 0;
    try { window.BotPhaseGuard?.markSettled?.(botKey); } catch (e) {}
    try { clearActiveSignalFromFirebase(botKey); } catch (e) {}
    try { resetTradeCard(botKey); } catch (e) {}
    try { clearSignalUI(botKey); } catch (e) {}
  }, wait);
}

function scheduleExpiredSignalClear(botKey, signal, durationSec) {
  if (resultAutoClearTimers[botKey]) return;
  let wait = 6000;
  try {
    const ttl = window.__utkSignalCardTtl;
    if (ttl && typeof ttl.graceLeftMs === 'function') {
      wait = ttl.graceLeftMs(signal, Date.now(), durationSec);
    } else if (ttl && ttl.RESULT_GRACE_MS) {
      wait = ttl.RESULT_GRACE_MS;
    }
  } catch (e) {}
  scheduleResultAutoClear(botKey, Math.max(500, wait));
}

function cancelResultAutoClear(botKey) {
  liveResultHoldUntil[botKey] = 0;
  try {
    if (resultAutoClearTimers[botKey]) {
      clearTimeout(resultAutoClearTimers[botKey]);
      resultAutoClearTimers[botKey] = null;
    }
  } catch (e) {}
}

function setTradeStatus(botKey, text) {
  const msg = text == null ? '' : String(text);
  const botId = botIdMap[botKey];
  const statusEl = botId ? document.getElementById(`autotradeStatus-${botId}`) : null;
  if (statusEl) statusEl.textContent = msg || 'Waiting for a signal';

  // Legacy trade-card (removed from HTML, kept for safety).
  const card = tradeCards[botKey];
  if (card) {
    const legacy = card.querySelector('[data-field="status"]');
    if (legacy) legacy.textContent = msg;
  }
}
window.setTradeStatus = setTradeStatus;

function resetToSearchingState(botKey) {
  resetSignalStartNotification(botKey);
  clearCountdown(botKey);
  try { clearActiveSignalFromFirebase(botKey); } catch (e) {}
  resetTradeCard(botKey);
  clearSignalUI(botKey);
  setTradeStatus(botKey, 'Waiting for a signal');
}

function resetTradeCard(botKey) {
  const card = tradeCards[botKey];
  if (!card) return;
  clearCountdown(botKey);
  card.classList.remove('pulse');
  setTradeStatus(botKey, 'Waiting for a signal');
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

function updatePreparingWaitUI(botKey) {
  const display = signalDisplays[botKey];
  if (!display) return;
  const labelEl = display.querySelector('.countdown-label');
  const valEl = display.querySelector('.countdown-value');
  if (labelEl) labelEl.textContent = 'Status';
  if (valEl) valEl.textContent = 'Checking entry…';
  try {
    if (window.__utkSignalPip && typeof window.__utkSignalPip.onCountdown === 'function') {
      window.__utkSignalPip.onCountdown(botKey, 'Checking entry…');
    }
  } catch (e) {}
}

function startCountdown(botKey, seconds, label) {
  clearCountdown(botKey);
  const end = Date.now() + (seconds * 1000);
  botExpireAt[botKey] = end;

  const tick = () => {
    const remaining = Math.max(0, Math.floor((end - Date.now()) / 1000));
    const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const ss = String(remaining % 60).padStart(2, '0');
    setTradeStatus(botKey, `${label} | ${mm}:${ss}`);
    if (label === 'Trading') updateSignalCountdown(botKey, remaining);
    if (label === 'Preparing') {
      if (remaining > 0) {
        updateSignalCountdown(botKey, remaining);
      } else {
        setTradeStatus(botKey, 'Waiting for a signal');
      }
    }
    if (remaining <= 0) {
      clearCountdown(botKey);
      if (label === 'Trading') {
        try { window.__utkSignalResultInstant?.onExpiry?.(botKey); } catch (e) {}
        try { scheduleExpiredSignalClear(botKey); } catch (e2) {}
      }
    }
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
  // if the supplied `symbol` was missing OTC and we have a cached version, use it
  if (symbol && !/\bOTC\b/i.test(symbol) && lastSignalCurrency[botKey]) {
    symbol = lastSignalCurrency[botKey];
  }
  scheduleRenderSignal(botKey, { bot, time, symbol, side, price, sl, tp, phase: 'Signal', countdown: remaining });

  dashboardStats.totalTrades++;
  addRecentActivity(botKey, side, symbol, time);
  updateDashboardStats();
}

async function handlePhaseMessage(signal) {
  if (!signal || !signal.phase || !signal.bot) return false;
  const botKey = (signal.bot || '').toUpperCase();

  const phasePeek = String(signal.phase || '').trim().toLowerCase();
  if (phasePeek === 'preparing') {
    // Instant-trade: never flash Preparing. Silent SSID warm only.
    try { window.noteAutotradeChainSignal?.(botKey, { ...signal, phase: 'Preparing' }); } catch (e) {}
    if (isAutoTradeEnabled(botKey)) {
      try { prepareSsidTrade(botKey, signal); } catch (e) {}
    }
    return true;
  }

  try {
    const guard = window.BotPhaseGuard;
    if (guard && typeof guard.shouldAcceptPhase === 'function') {
      const verdict = guard.shouldAcceptPhase(botKey, signal);
      if (verdict && verdict.ok === false) {
        return false;
      }
    }
  } catch (e) {}

  // capture any currency visible in this payload; we'll reuse it later if
  // subsequent messages for the same bot don't include currency info at all.
  // only overwrite the cache if (a) the resolved string explicitly includes
  // OTC (an indicator that we want the suffix), or (b) we don't yet have a
  // cached value at all.  this prevents later `Signal` updates that omit the
  // OTC flag from blowing away a previously‐observed OTC pair.
  try {
    const cur = resolveCurrency(signal);
    if (cur) {
      const hasOtcInResolved = /\bOTC\b/i.test(cur);
      if (hasOtcInResolved || !lastSignalCurrency[botKey]) {
        lastSignalCurrency[botKey] = cur;
      }
    }
  } catch(e) {}

  // Normalize common phase values (case-insensitive, supports "result")
  const phaseRaw = String(signal.phase || '').trim();
  const phaseLower = phaseRaw.toLowerCase();
  const phase = (phaseLower === 'preparing')
    ? 'Preparing'
    : (phaseLower === 'signal')
      ? 'Signal'
      : (phaseLower === 'trading result' || phaseLower === 'result')
        ? 'Trading Result'
        : (phaseLower === 'chain complete')
          ? 'Chain Complete'
          : (phaseLower === 'cancelled')
            ? 'Cancelled'
            : phaseRaw;
  // Mutate in-place so WS onmessage downstream checks see the canonical phase.
  if (phase && phase !== signal.phase) signal.phase = phase;

  try {
    window.BotPhaseGuard?.notePhaseAccepted?.(botKey, signal);
  } catch (e) {}

  lastLocalPhaseUpdate[botKey] = Date.now();
  const defaultTradeSeconds = getDefaultTradeSeconds(botKey);
  const tradeSeconds = phase === 'Signal' ? resolveTradeDurationSec(botKey, signal) : 0;

  // Set expiration/duration if provided
  const expiry = formatExpiryLabel(botKey, signal);
  const card = tradeCards[botKey];
  if (card && expiry) {
    const el = card.querySelector('[data-field="expiry"]');
    if (el) el.textContent = expiry;
  }

  if (phase === 'Cancelled') {
    showCancelledPhase(botKey, signal);
    return true;
  }

  if (phase === 'Signal') {
    // Main already skips leftover S2–S4 while waiting for next 1x — do not paint them.
    try {
      if (window.shouldSuppressLeftoverSignalUi?.(botKey, signal)) {
        try { window.clearLeftoverSignalCard?.(botKey); } catch (e2) {}
        return true;
      }
    } catch (e) {}
    cancelResultAutoClear(botKey);
    suppressPreparingUntilSignal[botKey] = false;
    // Track active symbol for single-active-chain bots.
    try {
      if (SINGLE_ACTIVE_CHAIN_BOTS.has(botKey)) {
        const symKey = canonChainSymbolKey(resolveCurrency(signal));
        if (symKey) {
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
      const updatedOpenMs = toEpochMs(signal.openedAtMs) || toEpochMs(signal.openingTime);
      const durSec = resolveTradeDurationSec(botKey, signal);
      if (updatedOpenMs && Number.isFinite(durSec) && durSec > 0) {
        lastSignalTime[botKey] = updatedOpenMs;
        const newEndMs = updatedOpenMs + (durSec * 1000);
        botExpireAt[botKey] = newEndMs;
        const remaining = Math.max(0, Math.ceil((newEndMs - Date.now()) / 1000));
        startCountdown(botKey, remaining, 'Trading');
      } else {
        if (!lastSignalTime[botKey] && (signal.time || signal.timestamp || signal.openedAtMs)) {
          lastSignalTime[botKey] = toEpochMs(signal.openedAtMs) || toEpochMs(signal.time) || toEpochMs(signal.timestamp);
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

      // Best-effort sync without resetting startTime (countdown stays locked to publish time).
      patchActiveSignalInFirebase(botKey, {
        phase: 'Signal',
        price: lastSignalPrice[botKey] ?? signal.price,
        openingPrice: signal.openingPrice ?? lastSignalPrice[botKey] ?? signal.price,
        ...(updatedOpenMs ? { time: signal.openingTime, openedAtMs: updatedOpenMs } : {}),
        updateOnly: true,
        updateKind: signal.updateKind || 'openingPrice'
      });

      return true;
    }

    showSignalStartNotification(botKey, signal);

    // Store opening price, action, and time for later use in Trading Result
    lastSignalPrice[botKey] = signal.openingPrice ?? signal.price;
    lastSignalTime[botKey] = toEpochMs(signal.openedAtMs) || toEpochMs(signal.openingTime) || toEpochMs(signal.time) || toEpochMs(signal.timestamp);
    lastSignalSeenAtLocal[botKey] = Date.now();
    const signalAction = normalizeTradeSide(signal.action || signal.side);
    if (signalAction) lastSignalAction[botKey] = signalAction;

    try { window.noteAutotradeChainSignal?.(botKey, { ...signal, phase: 'Signal' }); } catch (e) {}
    attemptAutoTrade(botKey, signal);

    try { updateBotActivityBadges(); } catch (e) {}

    {
      const fullDur = tradeSeconds || defaultTradeSeconds;
      let tradeRemain = fullDur;
      try {
        if (typeof window.__utkRemainingFromOpen === 'function') {
          const rem = window.__utkRemainingFromOpen(signal, fullDur);
          if (rem != null) tradeRemain = rem;
        }
      } catch (e) {}
      startCountdown(botKey, tradeRemain, 'Trading');
      if (!resolveCurrency(signal) && lastSignalCurrency[botKey]) {
        signal.selectedCurrency = lastSignalCurrency[botKey];
        signal.symbol = lastSignalCurrency[botKey];
        signal.currency = lastSignalCurrency[botKey];
      }
      scheduleRenderSignal(botKey, { ...signal, action: signalAction || signal.action, side: signalAction || signal.side, countdown: tradeRemain });
    }

    // Save active signal to Firebase (prefer bot openedAtMs so late joiners match history Open)
    const tradeDur = tradeSeconds || defaultTradeSeconds;
    const pair = resolveCurrency(signal) || lastSignalCurrency[botKey] || '';
    const openMs =
      toEpochMs(signal.openedAtMs) ||
      toEpochMs(signal.openingTime) ||
      toEpochMs(signal.time) ||
      null;
    saveActiveSignalToFirebase(botKey, {
      phase: 'Signal',
      duration: tradeDur,
      countdown: tradeDur,
      // Lock Firebase startTime to bot open so restore remaining matches history Close.
      ...(openMs ? { startTime: openMs } : {}),
      openedAtMs: openMs || undefined,
      action: signal.action || signal.side,
      side: signal.side || signal.action,
      selectedCurrency: pair,
      symbol: signal.symbol || pair,
      currency: pair,
      price: signal.price ?? signal.openingPrice,
      openingPrice: signal.openingPrice ?? signal.price,
      openingTime: signal.openingTime || signal.time || signal.timestamp,
      time: signal.openingTime || signal.time || signal.timestamp,
      sl: signal.sl,
      tp: signal.tp,
      attempt: signal.attempt,
      payout: signal.payout,
      expiry: formatExpiryLabel(botKey, signal),
      stakeMultiplier: signal.stakeMultiplier,
      signalId: signal.signalId,
    });

    return false; // let trade row update the card fields
  }

  if (phase === 'Chain Complete') {
    resetSignalStartNotification(botKey);
    suppressPreparingUntilSignal[botKey] = false;
    delete activeChainSymbol[botKey];
    try { window.noteAutotradeChainSignal?.(botKey, { ...signal, phase: 'Chain Complete' }); } catch (e) {}
    try { window.markAutotradeChainIdle?.(botKey); } catch (e) {}

    const tradeSymbol = resolveCurrency(signal) || signal.symbol || lastSignalCurrency[botKey] || '';
    const chainWon = !!(signal.chainWon || String(signal.result || '').toUpperCase() === 'WIN');

    // Completed streaks are written by the signal-writer onto bots/{bot}/pastWinStreaks.

    if (signalHistory[botKey]) {
      signalHistory[botKey].unshift({
        bot: botKey,
        phase: 'Chain Complete',
        result: chainWon ? 'WIN' : 'CHAIN_LOSS',
        symbol: tradeSymbol,
        currency: tradeSymbol,
        selectedCurrency: tradeSymbol,
        chainComplete: true,
        chainReset: true,
        localOnly: true,
        timestamp: Date.now(),
        attempt: 0,
        stakeMultiplier: 1,
      });
    }

    try {
      if (window.__utkBotStats && typeof window.__utkBotStats.recompute === 'function') {
        window.__utkBotStats.recompute(botKey);
      } else if (typeof computeStatsFromHistory === 'function') {
        computeStatsFromHistory(botKey);
      }
    } catch (e) {}

    if (isSavingSignalsEnabled(botKey) && isAutoTradeEnabled(botKey)) {
      if (chainWon) {
        syncSavingSignalStakeToMain(botKey, tradeSymbol, { historyNextAttempt: 1 });
        try { ipcRenderer.send('reset-saving-ladder', { botId: botIdMap[botKey], reason: 'chain-won' }); } catch (e) {}
      } else {
        // Pair hop / 2-step strategy stop: live saving stays on S1–S4.
        syncHistorySavingAttemptToMain(botKey, tradeSymbol);
      }
    }

    // Bookkeeping only — never steal the Trading Result card or cut its hold short.
    if (!isLiveCardProtected(botKey)) {
      const nextAttempt = getSavingSignalLossesFromHistory(botKey) + 1;
      setTradeStatus(
        botKey,
        chainWon
          ? 'Chain won — waiting for new signal'
          : (nextAttempt <= 1
            ? 'Chain lost (5 max) — reset to 1x'
            : `Pair switch — next save ${nextAttempt}x`)
      );
    }
    return true;
  }

  if (phase === 'Trading Result') {
    try { window.noteAutotradeChainSignal?.(botKey, { ...signal, phase: 'Trading Result' }); } catch (e) {}
    resetSignalStartNotification(botKey);
    suppressPreparingUntilSignal[botKey] = true;

    const alreadyPainted = !!(window.__utkSignalResultInstant &&
      typeof window.__utkSignalResultInstant.consumePainted === 'function' &&
      window.__utkSignalResultInstant.consumePainted(botKey, signal));

    // Ignore stale results for other symbols (prevents cross-symbol streak pollution and UI flicker).
    try {
      if (SINGLE_ACTIVE_CHAIN_BOTS.has(botKey)) {
        const symKey = canonChainSymbolKey(resolveCurrency(signal));
        if (symKey) activeChainSymbol[botKey] = symKey;
      }
    } catch (e) {}

    if (!alreadyPainted) {
      clearCountdown(botKey);
      setTradeStatus(botKey, `Result: ${signal.result || ''}`);
    }

    // Terminal result → not mid-chain for the autotrade popup / wait gate.
    try {
      const { isWin, isLoss } = parseTradeOutcome(signal);
      const attemptNow = Number(signal?.attempt) || 1;
      const maxAttempts = Math.min(5, Number(signal?.maxAttempts) || 5);
      if (isWin || (isLoss && attemptNow >= maxAttempts)) {
        window.markAutotradeChainIdle?.(botKey);
      }
    } catch (e) {}

    const resultAction = normalizeTradeSide(signal.action || signal.side) || lastSignalAction[botKey] || '';
    if (resultAction) lastSignalAction[botKey] = resultAction;
    const openingPriceRaw =
      signal.openingPrice ??
      signal.opening_price ??
      signal.openPrice ??
      signal.open_price ??
      signal.entryPrice ??
      signal.entry_price ??
      lastSignalPrice[botKey];
    const openingPrice = (openingPriceRaw != null && openingPriceRaw !== 'N/A')
      ? openingPriceRaw
      : lastSignalPrice[botKey];
    if (openingPrice != null && openingPrice !== 'N/A') lastSignalPrice[botKey] = openingPrice;
    const openingTime =
      toEpochMs(signal.openedAtMs) ??
      toEpochMs(signal.opened_at_ms) ??
      toEpochMs(signal.openingTime) ??
      toEpochMs(signal.opening_time) ??
      toEpochMs(signal.startTime) ??
      toEpochMs(lastSignalTime[botKey]) ??
      toEpochMs(signal.timestamp) ??
      toEpochMs(signal.time) ??
      lastSignalTime[botKey] ??
      signal.time;

    const closingTime =
      toEpochMs(signal.closedAtMs) ??
      toEpochMs(signal.closed_at_ms) ??
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

    if (!resolveCurrency(signal) && lastSignalCurrency[botKey]) {
      signal.selectedCurrency = lastSignalCurrency[botKey];
      signal.symbol = lastSignalCurrency[botKey];
      signal.currency = lastSignalCurrency[botKey];
    }

    const tradeSymbol = resolveCurrency(signal) || signal.symbol || signal.currency || lastSignalCurrency[botKey] || '';
    const { isWin, isLoss } = parseTradeOutcome(signal);

    if (signal.chainComplete || isWin) {
      delete activeChainSymbol[botKey];
    }

    if (isLoss) {
      const attempt = Number(signal?.attempt) || 0;
      const maxAttempts = Math.min(5, Number(signal?.maxAttempts) || 5);
      if (attempt >= 5 || (maxAttempts >= 5 && attempt >= maxAttempts)) {
        markLocalChainReset(botKey, tradeSymbol);
      }
    }

    const resolvedAttempt = resolveSavingAttempt(botKey, signal);
    const savingStreakAtTrade = Math.max(0, resolvedAttempt - 1);

    if (!alreadyPainted) {
      if (signalHistory[botKey]) {
        signalHistory[botKey] = signalHistory[botKey].filter((entry) => {
          if (!entry) return false;
          if (entry.id || entry.phase === 'Trading Result' || entry.phase === 'result') return true;
          if (entry.localOnly && entry.chainReset) return true;
          const ts = toEpochMs(entry.timestamp) || Number(entry.timestamp) || 0;
          return ts > Date.now() - 300000;
        });
      }

      scheduleRenderSignal(botKey, {
        ...signal,
        action: resultAction,
        side: resultAction || signal.side,
        openingPrice,
        openingTime,
        closingPrice,
        closingTime,
        countdown: null,
      });
      scheduleResultAutoClear(botKey, 10000);
    } else {
      try { window.__utkSignalResultInstant?.stopExpiryPoll?.(botKey); } catch (e2) {}
    }

    const statsPayload = {
      ...signal,
      result: signal.result,
      action: resultAction,
      side: resultAction,
      openingPrice,
      closingPrice,
      openingTime,
      closingTime,
      selectedCurrency: tradeSymbol,
      symbol: signal.symbol || tradeSymbol,
      currency: tradeSymbol,
      attempt: String(botKey || '').toUpperCase() === 'NYX'
        ? Math.max(1, Math.min(5, parseInt(signal.attempt, 10) || 1))
        : resolvedAttempt,
      stakeMultiplier: signal.stakeMultiplier,
    };

    // Bookkeeping after paint so the card updates first.
    setTimeout(function () {
      try { updateBotStatsOnResult(botKey, statsPayload); } catch (e) {}
      try {
        if (isWin) {
          syncSavingSignalStakeToMain(botKey, tradeSymbol, { historyNextAttempt: 1 });
        } else {
          syncHistorySavingAttemptToMain(botKey, tradeSymbol);
        }
      } catch (e2) {}
      const resultPair = tradeSymbol || '';
      saveActiveSignalToFirebase(botKey, {
        phase: 'Trading Result',
        duration: 10,
        countdown: 0,
        result: signal.result,
        profit: signal.profit,
        selectedCurrency: resultPair,
        symbol: signal.symbol || resultPair,
        currency: resultPair,
        action: resultAction || signal.action || signal.side,
        side: resultAction || signal.side || signal.action,
        openingPrice,
        openingTime,
        closingPrice,
        closingTime,
        openedAtMs: toEpochMs(signal.openedAtMs) || openingTime,
        closedAtMs: toEpochMs(signal.closedAtMs) || closingTime,
        signalId: signal.signalId,
        attempt: resolvedAttempt,
        stakeMultiplier: signal.stakeMultiplier,
      }).catch(function () {});
      void addToHistory(botKey, {
        ...signal,
        action: resultAction || signal.action || signal.side,
        side: resultAction || signal.side || signal.action,
        openingPrice,
        openingTime,
        closingPrice,
        closingTime,
        openedAtMs: toEpochMs(signal.openedAtMs) || openingTime,
        closedAtMs: toEpochMs(signal.closedAtMs) || closingTime,
        attempt: resolvedAttempt,
        savingStreakAtTrade: savingStreakAtTrade
      });
    }, 0);

    return true;
  }

  return false;
}



// --- Load runtime config (wsServer) ---
try {
  window.__utkSignalHooks = {
    scheduleRenderSignal: scheduleRenderSignal,
    applyPhaseGlow: applyPhaseGlow,
    clearCountdown: clearCountdown,
    clearSignalUI: clearSignalUI,
    resetTradeCard: resetTradeCard,
    clearActiveSignalFromFirebase: clearActiveSignalFromFirebase,
    purgeStaleActiveSignal: purgeStaleActiveSignal,
    cancelResultAutoClear: cancelResultAutoClear,
    scheduleResultAutoClear: scheduleResultAutoClear,
    setTradeStatus: setTradeStatus,
    normalizeTradeSide: normalizeTradeSide,
    lastSignalCurrency: lastSignalCurrency,
    lastSignalAction: lastSignalAction,
    lastSignalPrice: lastSignalPrice,
    lastSignalTime: lastSignalTime,
    suppressPreparingUntilSignal: suppressPreparingUntilSignal
  };
} catch (e) {}

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
    if (wsStatusEl) setWsStatus('online');
    // Assume hub owns trades until we know otherwise (prevents dual-fire race).
    try {
      ipcRenderer.invoke('get-signal-hub-status').then((st) => {
        window.__signalHubAutotrade = !!(st && st.connected);
      }).catch(() => {
        // Keep hub-owns default on invoke failure — safer than enabling renderer trades.
        window.__signalHubAutotrade = true;
      });
    } catch (e) {
      window.__signalHubAutotrade = true;
    }
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
      const signal = JSON.parse(event.data);

      const botKeyEarly = (signal.bot || '').toUpperCase();
      if (botKeyEarly && !utkCanFollowBot(botKeyEarly)) return;
      const phaseLowerEarly = String(signal.phase || '').trim().toLowerCase();
      const isSignalPhaseEarly = phaseLowerEarly === 'signal';
      const isPriceUpdateOnlyEarly = !!signal.updateOnly || String(signal.updateKind || '').toLowerCase() === 'openingprice';
      if (phaseLowerEarly === 'preparing' && botKeyEarly && isAutoTradeEnabled(botKeyEarly)) {
        // Heal UI↔main desync so SignalHub actually has autotrade enabled.
        // Do not send waitForChainEnd:false — main only clears wait on OFF→ON.
        try { syncAutotradeConfigToMain(botKeyEarly, { enabled: true, source: 'user-toggle' }); } catch (e) {}
        syncSavingSignalStakeToMain(botKeyEarly, resolveCurrency(signal), {
          attempt: resolveSavingAttempt(botKeyEarly, signal),
          stakeMultiplier: signal?.stakeMultiplier,
          duration: signal?.duration || signal?.countdown
        });
      }
      if (isSignalPhaseEarly && !isPriceUpdateOnlyEarly && botKeyEarly) {
        if (isAutoTradeEnabled(botKeyEarly)) {
          try { syncAutotradeConfigToMain(botKeyEarly, { enabled: true, source: 'user-toggle' }); } catch (e) {}
        }
        // Prep stake only — main SignalHub places the trade. Do NOT call
        // attemptAutoTrade here (that caused double entries with the hub path).
        syncSavingSignalStakeToMain(botKeyEarly, resolveCurrency(signal), {
          attempt: resolveSavingAttempt(botKeyEarly, signal),
          stakeMultiplier: signal?.stakeMultiplier,
          duration: signal?.duration || signal?.countdown
        });
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

      const botKey = (signal.bot || '').toUpperCase();
      const phaseLower = String(signal.phase || '').trim().toLowerCase();
      const isSignalPhase = phaseLower === 'signal';
      const isPriceUpdateOnly = !!signal.updateOnly || String(signal.updateKind || '').toLowerCase() === 'openingprice';

      // Trade already fired at top of handler for minimum latency.
      // Paint Trading Result immediately — do not wait behind Signal queue work.
      if (signal.phase) {
        const phaseLowerResult = String(signal.phase || '').trim().toLowerCase();
        if (phaseLowerResult === 'trading result' || phaseLowerResult === 'result') {
          try { window.__utkSignalResultInstant?.paintFromWs?.(signal); } catch (e) {}
        }
        enqueueBotPhaseWork(botKey, () => handlePhaseMessage(signal));
        return;
      }
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
        // Ensure activeSignals is updated even when a bot sends a compact trade-row
        try {
          const duration = resolveTradeDurationSec(botKey, signal);
          const pair = resolveCurrency(signal) || signal.symbol || signal.selectedCurrency || '';
          const openMs =
            toEpochMs(signal.openedAtMs) ||
            toEpochMs(signal.openingTime) ||
            toEpochMs(signal.time) ||
            null;
          saveActiveSignalToFirebase(botKey, {
            phase: 'Signal',
            duration,
            countdown: duration,
            openedAtMs: openMs || undefined,
            action: signal.action || signal.side,
            side: signal.side || signal.action,
            selectedCurrency: pair,
            symbol: signal.symbol || pair,
            currency: pair,
            price: signal.price,
            openingPrice: signal.openingPrice ?? signal.price,
            openingTime: signal.openingTime || signal.time,
            time: signal.time || signal.timestamp || signal.openingTime
          }).catch(() => {});
        } catch (e) {}
        if (!window.__signalHubAutotrade) {
          attemptAutoTrade((signal.bot || '').toUpperCase(), signal);
        }
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
    updateStatus.textContent = 'Checking for updates…';
    updateStatus.style.color = '#c8d0d8';

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
        updateStatus.textContent = `v${updateInfo.latestVersion} found. Downloading now.`;
        updateStatus.style.color = '#9fdab4';
        try { await ipcRenderer.invoke('download-update'); } catch (e) {}
      } else {
        updateStatus.textContent = 'You are on the latest version.';
        updateStatus.style.color = '#9fdab4';
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

// Settings-page update status is refreshed from update-ui.js IPC handlers.
// Retry button wiring (settings panel)
try {
  const retryBtn = document.getElementById('retryUpdateBtn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      try {
        retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying...';
        try {
          await ipcRenderer.invoke('download-update');
          retryBtn.style.display = 'none';
          return;
        } catch (e) {}
        const info = await ipcRenderer.invoke('check-for-updates');
        const installerUrl = info && info.installerUrl ? info.installerUrl : null;
        if (installerUrl) {
          await ipcRenderer.invoke('download-and-install-installer', { url: installerUrl });
        } else {
          try {
            if (typeof window.showAppToast === 'function') {
              window.showAppToast('No installer link available right now. Try again later.', { tone: 'error' });
            }
          } catch (e) {}
        }
      } catch (err) {
        try {
          if (typeof window.showAppToast === 'function') {
            window.showAppToast('Retry failed. ' + (err && err.message ? err.message : 'Try again later.'), { tone: 'error' });
          }
        } catch (e) {}
      } finally {
        try { retryBtn.disabled = false; retryBtn.textContent = 'Retry Download'; } catch (e) {}
      }
    });
  }
} catch (e) {}




auth.onAuthStateChanged((user) => {
  if (user) {
    // Notify main process that user is logged in
    try {
      ipcRenderer.invoke('set-user-auth-state', { isLoggedIn: true }).catch(err => {});
    } catch (e) {}

    // Pick up newly granted custom claims (e.g. signal_writer) without requiring re-login.
    try { user.getIdToken(true).catch(() => {}); } catch (e) {}
    
    // disable visualizer immediately when we have a logged in user
    window.enableMusicViz = false;
    try { window.musicVisualizer && window.musicVisualizer.stopAnimation(); } catch (e) {}

    // console.log('[App] User logged in, setting up Firebase listeners');
    setupFirebaseHistoryListeners();

    // Stats date picker (last 30 days)
    try { initStatsDatePickers(); } catch (e) {}

    // Ensure per-bot stats reset at local midnight (display only; does not delete Firestore data)
    try { scheduleDailyStatsReset(); } catch (e) {}

    // Server-side published bot status (optional). When present, UI will prefer these values
    function setupServerBotStatusListener() {
      try {
        const botStatusRef = doc(db, 'meta', 'botStatus');
        onSnapshot(botStatusRef, (snap) => {
          window.serverBotStatus = snap.exists() ? snap.data() : null;
          try { updateBotActivityBadges(); } catch (e) {}
        }, (err) => { console.warn('[Firebase] botStatus listener error', err); });
      } catch (e) {
        console.warn('[App] setupServerBotStatusListener failed', e);
      }
    }

    // begin listening (falls back to local history logic if doc missing)
    setupServerBotStatusListener();
    // Flush any trades that were queued while unauthenticated
    try { flushPendingTradeSaves(); } catch (e) {}
    // Flush any pending active signal writes queued while unauthenticated
    try { flushPendingActiveSignals(); } catch (e) {}

  } else {
    // Notify main process that user is logged out
    try {
      ipcRenderer.invoke('set-user-auth-state', { isLoggedIn: false }).catch(err => {});
    } catch (e) {}
    
    // if we are logged out, re-enable visualization for the login UI
    window.enableMusicViz = true;
    try {
      if (window.musicVisualizer && typeof window.musicVisualizer.refresh === 'function') {
        window.musicVisualizer.refresh();
      } else if (typeof require === 'function') {
        require('./auth-visualizer.js');
      }
    } catch (e) {}

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
    // Reflect cleared state in activity badges
    try { updateBotActivityBadges(); } catch (e) {}
  }
});

try {
  // Default: main SignalHub owns SSID trades. Prevents renderer dual-fire on startup race.
  window.__signalHubAutotrade = true;
  ipcRenderer.on('signal-hub-status', (_event, data) => {
    window.__signalHubAutotrade = !!(data && data.connected);
  });
  ipcRenderer.on('fast-pocket-option-trade-done', (_event, data) => {
    const botId = data?.botId;
    const botKey = Object.keys(botIdMap).find((k) => botIdMap[k] === botId);
    if (!botKey) return;
    const result = data?.result;
    if (!result) return;
    if (result.success) {
      const ms = result.total_ms || result.latency_ms || '?';
      const lag = result.signal_lag_ms;
      const lagText = Number.isFinite(lag) ? ` | lag ${lag}ms` : '';
      console.log(`[${botKey}] SSID trade OK total=${ms}ms${lagText}`);
      try { setTradeStatus(botKey, `Trade placed | ${ms}ms${lagText}`); } catch (e) {}
    } else if (result.error && result.error !== 'duplicate' && result.error !== 'in-flight' && result.error !== 'hub owns trades') {
      console.warn(`[${botKey}] SSID trade failed:`, result.error);
      try { setTradeStatus(botKey, `Trade failed: ${result.error}`); } catch (e) {}
    }
  });
} catch (e) {}

createWebSocket();