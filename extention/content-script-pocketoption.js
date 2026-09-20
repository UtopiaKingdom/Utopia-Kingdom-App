// Content script for pocketoption.com - Auto trade execution
console.log('[PocketOption] Content script loaded');

// Inject overlay styles
const injectOverlayStyles = () => {
  if (document.getElementById('utk-overlay-styles')) return;
  const style = document.createElement('style');
  style.id = 'utk-overlay-styles';
  style.textContent = `
    .utk-autotrade-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(6px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      flex-direction: column;
      padding: 20px;
    }

    .utk-autotrade-overlay.active {
      display: flex;
    }

    .utk-autotrade-content {
      background: rgba(18, 20, 23, 0.9);
      border: 1px solid #2a2f36;
      border-radius: 14px;
      padding: 32px 36px;
      text-align: center;
      color: #e6e9ef;
      min-width: 240px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
    }

    .utk-autotrade-title {
      margin: 0 0 10px 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0.5px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }

    .utk-autotrade-sub {
      margin: 0;
      font-size: 14px;
      color: #9aa0a6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }

    .utk-autotrade-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #23d18b;
      margin: 14px auto 0;
      animation: utk-pulse 1.5s ease-in-out infinite;
    }

    @keyframes utk-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(1.2); }
    }

    .utk-autotrade-widget {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 1000000;
      display: none;
      gap: 8px;
      align-items: center;
      padding: 6px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(42, 47, 54, 0.9);
      backdrop-filter: blur(6px);
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      cursor: grab;
    }

    .utk-autotrade-widget.utk-dragging {
      cursor: grabbing;
    }

    .utk-autotrade-toggle {
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.6);
      color: #e6e9ef;
      border: 1px solid #2a2f36;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      backdrop-filter: blur(4px);
      transition: background 0.2s ease, transform 0.1s ease;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      white-space: nowrap;
    }

    .utk-autotrade-toggle:hover { background: rgba(255, 255, 255, 0.08); }
    .utk-autotrade-toggle:active { transform: translateY(1px); }
    
    .utk-autotrade-toggle:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      background: rgba(0, 0, 0, 0.3);
    }
    
    .utk-autotrade-toggle:disabled:hover {
      background: rgba(0, 0, 0, 0.3);
    }
  `;
  document.head.appendChild(style);
};

let utkOverlay;
let utkWidget;
let utkToggle;
let utkClickLockBtn;

let autotradeActive = false;
let suppressNextToggleClick = false;

let userClickLockEnabled = true;

const WIDGET_POS_KEY = 'utkWidgetPosition';
const USER_CLICK_LOCK_KEY = 'utkUserClickLockEnabled';

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const getViewport = () => {
  const w = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
  const h = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
  return { w, h };
};

const applyWidgetPosition = (pos) => {
  if (!utkWidget || !pos) return;

  const rect = utkWidget.getBoundingClientRect();
  const { w, h } = getViewport();
  const left = clamp(Number(pos.left) || 0, 0, Math.max(0, w - rect.width));
  const top = clamp(Number(pos.top) || 0, 0, Math.max(0, h - rect.height));

  utkWidget.style.left = `${left}px`;
  utkWidget.style.top = `${top}px`;
  utkWidget.style.right = 'auto';
  utkWidget.style.bottom = 'auto';
};

const restoreWidgetPosition = () => {
  if (!utkWidget) return;
  chrome.storage.local.get([WIDGET_POS_KEY], (data) => {
    const pos = data && data[WIDGET_POS_KEY];
    if (pos && typeof pos === 'object') {
      applyWidgetPosition(pos);
    }
  });
};

const persistWidgetPosition = () => {
  if (!utkWidget) return;
  const rect = utkWidget.getBoundingClientRect();
  chrome.storage.local.set({
    [WIDGET_POS_KEY]: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
    }
  });
};

const isWidgetElement = (el) => {
  try {
    if (!el) return false;
    if (utkWidget && (el === utkWidget || utkWidget.contains(el))) return true;
    return false;
  } catch {
    return false;
  }
};

const blockUserClicksWhileAutotrade = (() => {
  const events = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick', 'contextmenu'];
  let installed = false;

  function handler(e) {
    try {
      if (!autotradeActive) return;
      if (!userClickLockEnabled) return;

      // Only block real user input; allow programmatic clicks (bot automation).
      if (e && e.isTrusted !== true) return;

      // Allow interacting with the extension widget itself.
      if (isWidgetElement(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    } catch {}
  }

  return {
    install() {
      if (installed) return;
      installed = true;
      events.forEach((name) => {
        try { window.addEventListener(name, handler, true); } catch {}
      });
    }
  };
})();

const ensureOverlay = () => {
  injectOverlayStyles();
  if (!utkOverlay) {
    utkOverlay = document.createElement('div');
    utkOverlay.id = 'utk-autotrade-overlay';
    utkOverlay.className = 'utk-autotrade-overlay';
    utkOverlay.innerHTML = `
      <div class="utk-autotrade-content">
        <div class="utk-autotrade-title">Autotrade ON</div>
        <p class="utk-autotrade-sub">System is trading</p>
        <div class="utk-autotrade-indicator"></div>
      </div>
    `;
    document.body.appendChild(utkOverlay);
  }

  if (!utkWidget) {
    utkWidget = document.createElement('div');
    utkWidget.id = 'utk-autotrade-widget';
    utkWidget.className = 'utk-autotrade-widget';
    document.body.appendChild(utkWidget);
  }

  if (!utkToggle) {
    utkToggle = document.createElement('button');
    utkToggle.id = 'utk-autotrade-toggle';
    utkToggle.className = 'utk-autotrade-toggle';
    utkToggle.textContent = 'Minimize';
    utkToggle.disabled = true;
    utkToggle.addEventListener('click', () => {
      if (suppressNextToggleClick) {
        suppressNextToggleClick = false;
        return;
      }
      if (utkOverlay.classList.contains('active')) {
        setOverlayVisibility(false);
      } else {
        setOverlayVisibility(true);
      }
    });

    // Place inside widget
    try { utkWidget.appendChild(utkToggle); } catch { document.body.appendChild(utkToggle); }
  }

  if (!utkClickLockBtn) {
    utkClickLockBtn = document.createElement('button');
    utkClickLockBtn.id = 'utk-userclick-lock';
    utkClickLockBtn.className = 'utk-autotrade-toggle';
    utkClickLockBtn.textContent = 'User Clicks: ON';
    utkClickLockBtn.disabled = true;

    const setLabel = () => {
      if (!utkClickLockBtn) return;
      utkClickLockBtn.textContent = `User Clicks: ${userClickLockEnabled ? 'ON' : 'OFF'}`;
    };

    utkClickLockBtn.addEventListener('click', (e) => {
      try {
        if (suppressNextToggleClick) {
          suppressNextToggleClick = false;
          return;
        }
        e.stopPropagation();
        userClickLockEnabled = !userClickLockEnabled;
        chrome.storage.local.set({ [USER_CLICK_LOCK_KEY]: userClickLockEnabled });
        setLabel();
      } catch {}
    });

    setLabel();
    try { utkWidget.appendChild(utkClickLockBtn); } catch { document.body.appendChild(utkClickLockBtn); }

    // Install click-blocker once widget exists (so we can whitelist it)
    blockUserClicksWhileAutotrade.install();

    // Restore saved widget position after first paint
    setTimeout(restoreWidgetPosition, 0);

    // Draggable widget positioning (persisted)
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const moveThresholdPx = 4;

    const onPointerMove = (ev) => {
      if (!dragging) return;
      try {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && (Math.abs(dx) > moveThresholdPx || Math.abs(dy) > moveThresholdPx)) {
          moved = true;
        }

        const rect = utkWidget.getBoundingClientRect();
        const { w, h } = getViewport();
        const left = clamp(startLeft + dx, 0, Math.max(0, w - rect.width));
        const top = clamp(startTop + dy, 0, Math.max(0, h - rect.height));

        utkWidget.style.left = `${Math.round(left)}px`;
        utkWidget.style.top = `${Math.round(top)}px`;
        utkWidget.style.right = 'auto';
        utkWidget.style.bottom = 'auto';
      } catch {}
    };

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      try { utkWidget.classList.remove('utk-dragging'); } catch {}
      try { window.removeEventListener('pointermove', onPointerMove, true); } catch {}
      try { window.removeEventListener('pointerup', endDrag, true); } catch {}
      try { window.removeEventListener('pointercancel', endDrag, true); } catch {}

      if (moved) {
        suppressNextToggleClick = true;
        persistWidgetPosition();
      }
      moved = false;
    };

    utkWidget.addEventListener('pointerdown', (ev) => {
      try {
        // Don't start drag when interacting with buttons (let them click normally)
        const onButton = ev && ev.target && typeof ev.target.closest === 'function' && ev.target.closest('button');
        if (onButton) return;

        if (typeof ev.button === 'number' && ev.button !== 0) return;
        dragging = true;
        moved = false;
        startX = ev.clientX;
        startY = ev.clientY;
        const rect = utkWidget.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        utkWidget.classList.add('utk-dragging');
        try { utkWidget.setPointerCapture(ev.pointerId); } catch {}
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', endDrag, true);
        window.addEventListener('pointercancel', endDrag, true);
        ev.preventDefault();
      } catch {}
    });
  }
};

const setOverlayVisibility = (show) => {
  ensureOverlay();
  if (show) {
    utkOverlay.classList.add('active');
    if (utkToggle) utkToggle.textContent = 'Minimize';
    chrome.storage.local.set({ autotradeOverlayVisible: true });
  } else {
    utkOverlay.classList.remove('active');
    if (utkToggle) utkToggle.textContent = 'Maximize';
    chrome.storage.local.set({ autotradeOverlayVisible: false });
  }
};

// Show/hide overlay
const showAutotradeOverlay = () => setOverlayVisibility(true);
const hideAutotradeOverlay = () => setOverlayVisibility(false);

// Listen for storage changes from popup and connection status
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  
  // Handle connection status - show/hide + disable minimize button
  if (changes.appConnected) {
    ensureOverlay();
    if (utkWidget && utkToggle && utkClickLockBtn) {
      const isConnected = changes.appConnected.newValue === true;
      utkWidget.style.display = isConnected ? 'flex' : 'none';
      utkToggle.disabled = !isConnected;
      utkClickLockBtn.disabled = !isConnected;
      console.log('[PocketOption] Toggle button state:', isConnected ? 'visible/enabled' : 'hidden/disabled');
    }
  }
  
  if (changes.autotradeActive) {
    const isOn = changes.autotradeActive.newValue;
    autotradeActive = !!isOn;
    if (isOn) {
      const overlayVisible = changes.autotradeOverlayVisible?.newValue;
      setOverlayVisibility(overlayVisible !== false);
      if (utkWidget && utkToggle && utkClickLockBtn) {
        chrome.storage.local.get(['appConnected'], (state) => {
          const connected = state.appConnected === true;
          utkWidget.style.display = connected ? 'flex' : 'none';
          utkToggle.disabled = !connected;
          utkClickLockBtn.disabled = !connected;
        });
      }
    } else {
      hideAutotradeOverlay();
      if (utkWidget && utkToggle && utkClickLockBtn) {
        utkToggle.textContent = 'Autotrade OFF';
        utkToggle.disabled = true; // not clickable when off
        utkClickLockBtn.disabled = true;
        utkWidget.style.display = 'flex';
      }
    }
  }

  if (changes[USER_CLICK_LOCK_KEY]) {
    userClickLockEnabled = changes[USER_CLICK_LOCK_KEY].newValue !== false;
    if (utkClickLockBtn) utkClickLockBtn.textContent = `User Clicks: ${userClickLockEnabled ? 'ON' : 'OFF'}`;
  }
  if (changes.autotradeOverlayVisible && changes.autotradeActive?.newValue) {
    setOverlayVisibility(changes.autotradeOverlayVisible.newValue !== false);
  }
});

// Check if autotrade is active on load
chrome.storage.local.get(['autotradeActive', 'autotradeOverlayVisible'], (data) => {
  autotradeActive = !!data.autotradeActive;
  if (data.autotradeActive) {
    const overlayVisible = data.autotradeOverlayVisible !== false;
    setOverlayVisibility(overlayVisible);
  } else {
    ensureOverlay();
    hideAutotradeOverlay();
    if (utkToggle) utkToggle.textContent = 'Autotrade OFF';
  }
});

// Initialize click lock setting (default ON)
chrome.storage.local.get([USER_CLICK_LOCK_KEY], (data) => {
  if (typeof data[USER_CLICK_LOCK_KEY] === 'boolean') {
    userClickLockEnabled = data[USER_CLICK_LOCK_KEY];
  } else {
    userClickLockEnabled = true;
    chrome.storage.local.set({ [USER_CLICK_LOCK_KEY]: true });
  }
  if (utkClickLockBtn) utkClickLockBtn.textContent = `User Clicks: ${userClickLockEnabled ? 'ON' : 'OFF'}`;
});

// Listen for trade commands from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'execute-trade') {
    console.log('[PocketOption] Executing trade:', message);
    executeTrade(message).then(result => {
      sendResponse(result);
    }).catch(err => {
      console.error('[PocketOption] Trade error:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open for async response
  }
});

async function executeTrade(tradeData) {
  const { currency, side, betSize } = tradeData;
  
  try {
    // Step 1: Select currency
    await selectCurrency(currency);
    
    // Step 2: Set bet size
    await setBetSize(betSize);
    
    // Step 3: Click Buy or Sell
    await clickTrade(side);
    
    console.log('[PocketOption] Trade executed successfully');
    return { success: true };
  } catch (err) {
    throw err;
  }
}

async function selectCurrency(currency) {
  console.log('[PocketOption] Selecting currency:', currency);
  
  // Find and click currency selector
  // This will need to be customized based on PocketOption's actual UI
  const currencyButton = document.querySelector('[data-currency-selector]') || 
                        document.querySelector('.currency-selector') ||
                        document.querySelector('[class*="asset"]');
  
  if (currencyButton) {
    currencyButton.click();
    await sleep(500);
    
    // Find currency in dropdown
    const currencyOption = Array.from(document.querySelectorAll('[data-currency], .currency-item, [class*="asset-item"], [class*="asset-"], [class*="ticker"]'))
      .find(el => (el.textContent || '').toUpperCase().includes((currency || '').toUpperCase()));
    
    if (currencyOption) {
      currencyOption.click();
      await sleep(500);
    } else {
      console.warn(`[PocketOption] Currency ${currency} not found; proceeding with current selection`);
    }
  } else {
    console.warn('[PocketOption] Currency selector not found, currency may already be selected');
  }
}

async function setBetSize(amount) {
  console.log('[PocketOption] Setting bet size:', amount);
  
  // Find bet size input
  const betInput = document.querySelector('input[type="number"][class*="amount"]') ||
                   document.querySelector('input[placeholder*="amount"]') ||
                   document.querySelector('[data-bet-input]');
  
  if (betInput) {
    betInput.value = amount;
    betInput.dispatchEvent(new Event('input', { bubbles: true }));
    betInput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
  } else {
    console.warn('[PocketOption] Bet input not found, using default size');
  }
}

async function clickTrade(side) {
  console.log('[PocketOption] Clicking trade button:', side);
  const isBuy = side.toUpperCase() === 'BUY';

  const selectorGroups = isBuy
    ? [
        '.action-high-low.button-call-wrap a.btn.btn-call',
        'a.btn.btn-call',
        'a.btn-call',
        'button.btn-call',
        '.button-call-wrap a.btn',
        '.btn-call'
      ]
    : [
        '.action-high-low.button-put-wrap a.btn.btn-put',
        'a.btn.btn-put',
        'a.btn-put',
        'button.btn-put',
        '.button-put-wrap a.btn',
        '.btn-put'
      ];

  function findByText(label) {
    const candidates = Array.from(document.querySelectorAll('a, button, div'));
    const upper = label.toUpperCase();
    for (const el of candidates) {
      const txt = (el.textContent || '').toUpperCase().trim();
      if (txt.includes(upper)) {
        const clickable = el.closest('a, button') || el;
        return clickable;
      }
    }
    return null;
  }

  let button = null;
  for (const sel of selectorGroups) {
    const found = document.querySelector(sel);
    if (found) { button = found; break; }
  }
  if (!button) {
    button = findByText(isBuy ? 'BUY' : 'SELL');
  }

  if (button) {
    button.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(100);
    button.click();
    await sleep(150);
    console.log('[PocketOption] Clicked', isBuy ? 'BUY' : 'SELL');
    return;
  }

  throw new Error(`Trade button ${side} not found`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check initial connection status and set button visibility
const initializeButtonVisibility = () => {
  chrome.storage.local.get(['appConnected'], (data) => {
    ensureOverlay();
    if (utkWidget && utkToggle && utkClickLockBtn) {
      const isConnected = data.appConnected === true;
      utkWidget.style.display = isConnected ? 'flex' : 'none';
      utkToggle.disabled = !isConnected;
      utkClickLockBtn.disabled = !isConnected;
      console.log('[PocketOption] Toggle button initial state:', isConnected ? 'visible/enabled' : 'hidden/disabled');
    }

    // Clamp saved position if viewport changed
    try {
      chrome.storage.local.get([WIDGET_POS_KEY], (st) => {
        const pos = st && st[WIDGET_POS_KEY];
        if (pos && typeof pos === 'object') applyWidgetPosition(pos);
      });
    } catch {}
  });
};

// Keep draggable toggle on-screen if user resizes
window.addEventListener('resize', () => {
  try {
    if (!utkWidget) return;
    chrome.storage.local.get([WIDGET_POS_KEY], (st) => {
      const pos = st && st[WIDGET_POS_KEY];
      if (pos && typeof pos === 'object') {
        applyWidgetPosition(pos);
        // persist clamped value
        persistWidgetPosition();
      }
    });
  } catch {}
});

// Notify background that content script is ready
chrome.runtime.sendMessage({ type: 'content-script-ready' });

// Initialize button visibility when script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeButtonVisibility);
} else {
  initializeButtonVisibility();
}
