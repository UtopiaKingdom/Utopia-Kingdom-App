// Utopia Kingdom extension bridge (clean + minimal)

const APP_WS_URL = 'ws://localhost:8765';
const BOT_KEYS = { LUMIX: 'bot1', MIRAX: 'bot2', ARVION: 'bot3' };

// MV3 service workers can be suspended when idle.
// Keep a lightweight alarm running to periodically wake the worker,
// ensure the WS connection stays up, and prevent the extension from
// going "inactive" while the app is still running.
const KEEPALIVE_ALARM = 'utk_keepalive';

let ws = null;
let reconnectTimer = null;
let connected = false;
let tradeLock = false;

const log = (...args) => console.log('[Extension]', ...args);
const warn = (...args) => console.warn('[Extension]', ...args);
const err = (...args) => console.error('[Extension]', ...args);

function sendToApp(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

async function setAllBotsInactive() {
  try {
    const updates = {
      appConnected: false,
      autotradeActive: false,
      autotradeOverlayVisible: false,
      utkBotStatus_bot1: 'inactive',
      utkBotStatus_bot2: 'inactive',
      utkBotStatus_bot3: 'inactive',
      utkSelectedBot: null,
      utkBotCode: ''
    };
    await chrome.storage.local.set(updates);
  } catch (e) {
    // ignore
  }
}

function handleAppDisconnected() {
  connected = false;
  tradeLock = false;
  try { setAllBotsInactive(); } catch (_) {}
}

async function setActiveBot(botId, code) {
  const ids = ['bot1', 'bot2', 'bot3'];
  const updates = { autotradeActive: !!botId };

  ids.forEach(id => {
    updates[`utkBotStatus_${id}`] = id === botId ? 'active' : 'inactive';
    updates[`utkBotCode_${id}`] = id === botId ? (code || '') : '';
  });

  updates.utkSelectedBot = botId || null;
  updates.utkBotCode = botId ? (code || '') : '';
  updates.autotradeOverlayVisible = !!botId;
  if (!botId) tradeLock = false;

  await chrome.storage.local.set(updates);
}

async function handleBotActive(msg) {
  const botId = BOT_KEYS[msg.bot] || msg.bot;
  await setActiveBot(botId, (msg.code || '').trim());
}

async function handleBotInactive(msg) {
  const botId = BOT_KEYS[msg.bot] || msg.bot;
  const base = await chrome.storage.local.get(['utkBotStatus_bot1', 'utkBotStatus_bot2', 'utkBotStatus_bot3']);
  base[`utkBotStatus_${botId}`] = 'inactive';
  const stillActive = Object.values(base).some(v => v === 'active');

  const updates = {
    [`utkBotStatus_${botId}`]: 'inactive',
    [`utkBotCode_${botId}`]: '',
    autotradeActive: stillActive,
    autotradeOverlayVisible: stillActive,
  };
  if (!stillActive) {
    updates.utkSelectedBot = null;
    updates.utkBotCode = '';
    tradeLock = false;
  }
  await chrome.storage.local.set(updates);
}

async function findTradeTab() {
  let tabs = await chrome.tabs.query({ url: ['*://pocketoption.com/*', '*://*.pocketoption.com/*'] });
  if (!tabs.length) {
    const active = await chrome.tabs.query({ active: true, currentWindow: true });
    tabs = active;
  }
  return tabs.length ? tabs[0] : null;
}

async function handleCurrencySelection(data) {
  console.log('[Extension] Selecting currency:', data);

  // Block if app disconnected
  if (!connected) {
    warn('Currency selection blocked: app disconnected');
    return;
  }

  // Block if autotrade or target bot not active
  const state = await chrome.storage.local.get([
    'autotradeActive',
    'utkSelectedBot',
    'utkBotStatus_bot1',
    'utkBotStatus_bot2',
    'utkBotStatus_bot3'
  ]);
  const targetBot = BOT_KEYS[data.bot] || data.bot || state.utkSelectedBot;
  const status = targetBot ? (state[`utkBotStatus_${targetBot}`] || 'inactive') : 'inactive';
  if (!state.autotradeActive || status !== 'active') {
    warn('Currency selection blocked: bot inactive or autotrade off');
    return;
  }
  
  // Find pocketoption.com tab
  let tabs = await chrome.tabs.query({ url: ['*://pocketoption.com/*', '*://*.pocketoption.com/*'] });
  if (tabs.length === 0) {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs.length) tabs = activeTabs;
  }
  
  if (tabs.length === 0) {
    console.error('[Extension] No pocketoption.com tab found');
    return;
  }
  
  const tab = tabs[0];
  const currency = (data.currency || '').trim();
  const betSizeNum = Number(data && data.betSize);
  const betSize = Number.isFinite(betSizeNum) && betSizeNum > 0 ? betSizeNum : null;
  
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (currencyArg, betSizeArg) => {
        console.log('[Trade] SCRIPT STARTED');
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        
        // Helper function to add simple grey waves on click
        const addClickMarker = (element, label = '') => {
          if (!element) return;
          const rect = element.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          
          // Create grey wave
          const wave = document.createElement('div');
          wave.style.cssText = `
            position: fixed;
            left: ${centerX}px;
            top: ${centerY}px;
            width: 1px;
            height: 1px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(150, 150, 150, 0.8) 0%, rgba(150, 150, 150, 0) 70%);
            z-index: 999999;
            pointer-events: none;
            transform: translate(-50%, -50%);
            animation: greyWave 1.2s ease-out forwards;
          `;
          wave.id = `wave-${Math.random().toString(36).substring(7)}`;
          document.body.appendChild(wave);
          console.log('[Trade] 〰️ Grey wave at:', label);
          
          // Create animation style if not exists
          if (!document.getElementById('grey-wave-style')) {
            const style = document.createElement('style');
            style.id = 'grey-wave-style';
            style.textContent = `
              @keyframes greyWave {
                0% { width: 1px; height: 1px; opacity: 1; }
                100% { width: 80px; height: 80px; opacity: 0; }
              }
            `;
            document.head.appendChild(style);
          }
          
          // Remove wave after animation
          setTimeout(() => wave.remove(), 1200);
        };
        
        try {
          console.log('[Trade] Selecting currency:', currencyArg);
          console.log('[Trade] Document ready, body exists:', !!document.body);
          
          // Use CSS selectors instead of XPath for better compatibility
          let dropdownEl = null;
          
          // Try to find the currency pair selector - look for clickable link
          const currencySelectors = [
            '.pair-number-wrap a',              // Direct link to pair
            '.currencies-block__in a',          // Currency block link
            '.pair-number-wrap',                // Pair wrapper
            '[data-toggle-dropdown]'            // Dropdown trigger
          ];
          
          for (const sel of currencySelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              console.log('[Trade] ✓ Found currency selector with:', sel);
              dropdownEl = el;
              break;
            }
          }
          
          if (dropdownEl) {
            console.log('[Trade] Clicking currency dropdown');
            console.log('[Trade] Element tag:', dropdownEl.tagName);
            console.log('[Trade] Element classes:', dropdownEl.className);
            console.log('[Trade] Element text:', (dropdownEl.textContent || '').substring(0, 50));
            
            const rect = dropdownEl.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            
            addClickMarker(dropdownEl, 'Currency Dropdown');
            
            // Click to open dropdown
            try {
              dropdownEl.click();
              console.log('[Trade] ✓ Dropdown clicked');
            } catch (e) {
              console.warn('[Trade] Click failed:', e.message);
            }
            
            await sleep(800);
            console.log('[Trade] After click, waiting for dropdown modal...');

            // Find currency in the modal using CSS selectors
            const currencyUpperRaw = currencyArg.toUpperCase();
            const wantOtc = currencyUpperRaw.includes('OTC');
            const currencyUpper = currencyUpperRaw.replace(/OTC/g, '').replace(/\s+/g, '').replace('/', '');
            console.log('[Trade] Looking for currency:', currencyUpperRaw, 'wantOtc:', wantOtc);
            
            // Find currency list items using CSS selector
            const currencyItems = Array.from(document.querySelectorAll('li.alist__item'));
            console.log('[Trade] Found', currencyItems.length, 'currency options in dropdown');
            
            let found = false;
            for (let i = 0; i < currencyItems.length; i++) {
              const item = currencyItems[i];
              
              // Get the label text using the CSS class
              const labelEl = item.querySelector('span.alist__label');
              if (labelEl) {
                const txtRaw = (labelEl.textContent || '').toUpperCase().trim();
                const isOtc = txtRaw.includes('OTC');
                const txt = txtRaw.replace(/OTC/g, '').replace(/\s+/g, '').replace('/', '');
                
                console.log(`[Trade] Option ${i}:`, txtRaw, `(OTC: ${isOtc})`);                
                // Check OTC matching
                if (wantOtc !== isOtc) {
                  console.log('[Trade] Skipping due to OTC mismatch');
                  continue;
                }
                
                // Check currency matching
                if (txt === currencyUpper) {
                  console.log('[Trade] ✓ Found matching currency:', txtRaw);
                  
                  // Click the link inside the list item
                  const link = item.querySelector('a.alist__link');
                  if (link) {
                    link.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await sleep(100);
                    addClickMarker(link, `Currency: ${txtRaw}`);
                    link.click();
                    console.log('[Trade] ✓ Currency clicked');
                    await sleep(500);
                    found = true;
                    break;
                  }
                }
              }
            }
            
            if (!found) {
              console.warn('[Trade] ✗ Currency not found:', currencyArg);
            }
          } else {
            console.warn('[Trade] ✗ Currency dropdown not found at any XPath');
          }
          
          // Step 2: Set bet amount
          if (betSizeArg != null) {
            console.log('[Trade] Setting bet size to:', betSizeArg);
            await sleep(500);
            
            // Use CSS selectors for bet input
            let betInput = null;
            const betSelectors = [
              'input[autocomplete="off"]',      // Input with autocomplete=off (should be bet)
              '.value__val input',              // Input inside value element
              'input[type="text"]',
              'input[type="number"]'
            ];
            
            for (const sel of betSelectors) {
              const els = Array.from(document.querySelectorAll(sel));
              // Skip timer inputs (they show time like "00:01:00")
              for (const el of els) {
                if (el.offsetParent !== null) {
                  const val = el.value || '';
                  // Timer format is "HH:MM:SS" (contains colons), bet is just numbers
                  if (!val.includes(':')) {
                    console.log('[Trade] ✓ Found bet input with selector:', sel, 'value:', el.value);
                    betInput = el;
                    break;
                  }
                }
              }
              if (betInput) break;
            }
            
            if (betInput) {
              console.log('[Trade] ✓ Bet input found');
              console.log('[Trade] Input type:', betInput.type);
              
              const rect = betInput.getBoundingClientRect();
              const centerX = rect.left + rect.width / 2;
              const centerY = rect.top + rect.height / 2;
              
              addClickMarker(betInput, 'Bet Amount Input');
              
              // Click input
              betInput.click();
              await sleep(100);
              
              // Focus and clear
              betInput.focus();
              betInput.select();
              await sleep(50);
              
              const intended = String(betSizeArg);

              // Prefer setting the full value at once (more reliable than fast typing).
              betInput.value = intended;
              betInput.dispatchEvent(new Event('input', { bubbles: true }));
              await sleep(80);
              betInput.dispatchEvent(new Event('change', { bubbles: true }));
              await sleep(80);

              // Verify; if the site only took the first digit, fall back to slower typing.
              const got = String(betInput.value || '').trim();
              if (got !== intended) {
                console.warn('[Trade] Bet size verify failed (got=' + got + ', want=' + intended + '), retrying with slower typing');

                betInput.click();
                await sleep(80);
                betInput.focus();
                try { betInput.select(); } catch (e) {}
                await sleep(80);

                betInput.value = '';
                betInput.dispatchEvent(new Event('input', { bubbles: true }));
                await sleep(120);

                for (const char of intended) {
                  betInput.value += char;
                  betInput.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
                  betInput.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
                  betInput.dispatchEvent(new Event('input', { bubbles: true }));
                  await sleep(90);
                }

                betInput.dispatchEvent(new Event('change', { bubbles: true }));
              }

              betInput.dispatchEvent(new Event('blur', { bubbles: true }));

              console.log('[Trade] ✓ Bet size set to:', betInput.value);
              await sleep(200);
            } else {
              console.warn('[Trade] ✗ Bet input not found');
            }
          }
        } catch (e) {
          console.error('[Trade] Currency selection error:', e.message);
        }
      },
      args: [currency, betSize]
    });
  } catch (e) {
    console.error('[Extension] Currency selection failed:', e);
  }
}

async function handleBetSizeUpdate(data) {
  log('Updating bet size:', data && data.betSize);

  // Block if app disconnected
  if (!connected) {
    warn('Bet size update blocked: app disconnected');
    return;
  }

  const betSize = Number(data && data.betSize);
  if (!Number.isFinite(betSize) || betSize <= 0) {
    warn('Bet size update ignored: invalid betSize');
    return;
  }

  // Block if autotrade or target bot not active
  const state = await chrome.storage.local.get([
    'autotradeActive',
    'utkSelectedBot',
    'utkBotStatus_bot1',
    'utkBotStatus_bot2',
    'utkBotStatus_bot3'
  ]);
  const targetBot = BOT_KEYS[data.bot] || data.bot || state.utkSelectedBot;
  const status = targetBot ? (state[`utkBotStatus_${targetBot}`] || 'inactive') : 'inactive';
  if (!state.autotradeActive || status !== 'active') {
    warn('Bet size update blocked: bot inactive or autotrade off');
    return;
  }

  const tab = await findTradeTab();
  if (!tab) {
    err('Bet size update failed: no trading tab found');
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (betSizeArg) => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        try {
          await sleep(200);

          let betInput = null;
          const betSelectors = [
            'input[autocomplete="off"]',
            '.value__val input',
            'input[type="text"]',
            'input[type="number"]'
          ];

          for (const sel of betSelectors) {
            const els = Array.from(document.querySelectorAll(sel));
            for (const el of els) {
              if (el && el.offsetParent !== null) {
                const val = el.value || '';
                if (!String(val).includes(':')) {
                  betInput = el;
                  break;
                }
              }
            }
            if (betInput) break;
          }

          if (!betInput) {
            console.warn('[Trade] ✗ Bet input not found');
            return;
          }

          betInput.click();
          await sleep(60);
          betInput.focus();
          try { betInput.select(); } catch (e) {}
          await sleep(40);

          betInput.value = '';
          betInput.dispatchEvent(new Event('input', { bubbles: true }));

          const intended = String(betSizeArg);

          // Prefer full-value set first.
          betInput.value = intended;
          betInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(80);
          betInput.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(80);

          const got = String(betInput.value || '').trim();
          if (got !== intended) {
            console.warn('[Trade] Bet size verify failed (got=' + got + ', want=' + intended + '), retrying with slower typing');
            betInput.click();
            await sleep(80);
            betInput.focus();
            try { betInput.select(); } catch (e) {}
            await sleep(80);

            betInput.value = '';
            betInput.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(120);

            for (const char of intended) {
              betInput.value += char;
              betInput.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
              betInput.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
              betInput.dispatchEvent(new Event('input', { bubbles: true }));
              await sleep(90);
            }
            betInput.dispatchEvent(new Event('change', { bubbles: true }));
          }

          betInput.dispatchEvent(new Event('blur', { bubbles: true }));
          console.log('[Trade] ✓ Bet size set to:', betInput.value);
        } catch (e) {
          console.error('[Trade] Bet size update error:', e && e.message ? e.message : e);
        }
      },
      args: [betSize]
    });
  } catch (e) {
    err('Bet size update failed:', e);
  }
}

async function handleTrade(tradeData) {
  log('Trade signal received:', tradeData.bot, tradeData.side);

  const state = await chrome.storage.local.get([
    'autotradeActive',
    'utkSelectedBot',
    'utkBotStatus_bot1',
    'utkBotStatus_bot2',
    'utkBotStatus_bot3'
  ]);

  if (!connected) {
    warn('Trade blocked: app disconnected');
    return;
  }

  const targetBot = BOT_KEYS[tradeData.bot] || tradeData.bot || state.utkSelectedBot;
  const status = targetBot ? (state[`utkBotStatus_${targetBot}`] || 'inactive') : 'inactive';

  if (!state.autotradeActive) {
    warn('Trade blocked: autotrade off');
    return;
  }

  if (status !== 'active') {
    warn('Trade blocked: bot not active (bot=' + targetBot + ', status=' + status + ')');
    return;
  }

  if (tradeLock) {
    warn('Trade blocked: already executing');
    return;
  }

  tradeLock = true;
  const unlockTimer = setTimeout(() => { tradeLock = false; }, 35000);

  try {
    const tab = await findTradeTab();
    if (!tab) {
      err('No trading tab found');
      return;
    }

    // Bring the trading tab to the foreground to reduce background throttling and missed clicks.
    // This can help reduce the consistent ~1s lag when the user is minimized.
    try {
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(tab.id, { active: true });
    } catch (e) {
      // Non-fatal: continue without focusing.
    }

    log('Executing trade on tab:', tab.id, 'side:', tradeData.side);
    const side = (tradeData.side || '').toUpperCase();
    const betSizeNum = Number(tradeData && tradeData.betSize);
    const betSize = (Number.isFinite(betSizeNum) && betSizeNum > 0) ? betSizeNum : null;
    const sentAt = Number(tradeData && tradeData.timestamp);
    const signalAt = Number(tradeData && (tradeData.signalTime || tradeData.signalTimestamp || tradeData.signalTs));

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sideArg, betSizeArg, sentAtArg, signalAtArg) => {
        const t0 = Date.now();
        const isBuy = sideArg === 'BUY';
        console.log('[Trade] 🎯 Finding', isBuy ? 'BUY' : 'SELL', 'button...');

        const sleep = (ms) => new Promise(r => setTimeout(r, ms));

        // Fast bet-size set (full value in one go), then verify.
        const setBetFast = async () => {
          if (betSizeArg == null) return;
          try {
            let betInput = null;
            const betSelectors = [
              'input[autocomplete="off"]',
              '.value__val input',
              'input[type="text"]',
              'input[type="number"]'
            ];
            for (const sel of betSelectors) {
              const els = Array.from(document.querySelectorAll(sel));
              for (const el of els) {
                if (el && el.offsetParent !== null) {
                  const val = el.value || '';
                  if (!String(val).includes(':')) { betInput = el; break; }
                }
              }
              if (betInput) break;
            }
            if (!betInput) return;

            const intended = String(betSizeArg);
            betInput.click();
            await sleep(40);
            betInput.focus();
            try { betInput.select(); } catch (e) {}
            await sleep(40);

            betInput.value = intended;
            betInput.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(40);
            betInput.dispatchEvent(new Event('change', { bubbles: true }));
            await sleep(40);

            const got = String(betInput.value || '').trim();
            if (got !== intended) {
              // Last resort: slower typing to avoid dropped digits.
              betInput.value = '';
              betInput.dispatchEvent(new Event('input', { bubbles: true }));
              await sleep(80);
              for (const ch of intended) {
                betInput.value += ch;
                betInput.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
                betInput.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
                betInput.dispatchEvent(new Event('input', { bubbles: true }));
                await sleep(80);
              }
              betInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) {
            // ignore
          }
        };

        const findButton = () => {
          // Use XPath (most reliable for exact position)
          const xpath = isBuy 
            ? '/html/body/div[4]/div[2]/div[4]/div/div/div/div/div/div[5]/div/div/div[2]/div/div[2]/div[2]/div[1]/a'
            : '/html/body/div[4]/div[2]/div[4]/div/div/div/div/div/div[5]/div/div/div[2]/div/div[2]/div[2]/div[2]/a';
          const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const node = result.singleNodeValue;
          if (node) return node;

          // Fallback: try common selectors
          const selectorGroups = isBuy
            ? ['.action-high-low.button-call-wrap a.btn.btn-call', 'a.btn.btn-call', 'a.btn-call', 'button.btn-call', '.btn-call']
            : ['.action-high-low.button-put-wrap a.btn.btn-put', 'a.btn.btn-put', 'a.btn-put', 'button.btn-put', '.btn-put'];
          for (const sel of selectorGroups) {
            const el = document.querySelector(sel);
            if (el) return el;
          }
          return null;
        };
        
        return (async () => {
          try {
            await setBetFast();
          } catch (e) {}

          const button = findButton();
        
          if (button) {
            console.log('[Trade] ✓ Button found');

            // The XPath often resolves to a container; click the actual inner button/link if present
            const clickable =
              (button.closest && button.closest('a,button,[role="button"]')) ||
              (button.querySelector && button.querySelector('a.btn, a, button, [role="button"]')) ||
              button;
          
            try { clickable.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}

            // Single click (only once)
            clickable.click();
            const t1 = Date.now();
            const lagFromSent = (Number.isFinite(sentAtArg) ? (t1 - sentAtArg) : null);
            const lagFromSignal = (Number.isFinite(signalAtArg) ? (t1 - signalAtArg) : null);
            console.log('[Trade] ✅', isBuy ? 'BUY' : 'SELL', 'CLICKED', { lagFromSentMs: lagFromSent, lagFromSignalMs: lagFromSignal, execMs: (t1 - t0) });
          
            return { clicked: true };
          } else {
            console.error('[Trade] ❌ Button not found');
            return { clicked: false, error: 'Button not found' };
          }
        })();
      },
      args: [side, betSize, sentAt, signalAt]
    });

    const ok = results.some(r => r?.result?.clicked);
    log('Trade execution result:', ok);
  } catch (e) {
    err('Trade execution failed', e.message);
  } finally {
    clearTimeout(unlockTimer);
    tradeLock = false;
    log('Trade unlock');
  }
}

function attachMessageHandlers() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'get-connection-status') {
      sendResponse({ connected });
    } else if (msg.type === 'content-script-ready') {
      sendResponse({ success: true });
    } else if (msg.type === 'utk-send-handshake') {
      const bot = msg.bot;
      const code = (msg.code || '').trim();
      if (bot && code && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'utk-extension-handshake', bot, code }));
        sendResponse({ success: true });
        return true;
      }
      sendResponse({ success: false });
    }
    return true;
  });
}

function attachStorageForwarder() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.utkSelectedBot && !changes.utkBotCode) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      chrome.storage.local.get(['utkSelectedBot', 'utkBotCode']).then(data => {
        const bot = data.utkSelectedBot;
        const code = (data.utkBotCode || '').trim();
        if (bot && code) {
          ws.send(JSON.stringify({ type: 'utk-extension-handshake', bot, code }));
        }
      }).catch(() => {});
    }
  });
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  try {
    ws = new WebSocket(APP_WS_URL);

    ws.onopen = () => {
      connected = true;
      log('Connected to app ✓');
      chrome.storage.local.set({ appConnected: true });
      ws.send(JSON.stringify({ type: 'connect', source: 'extension', ts: Date.now() }));
      chrome.storage.local.get(['utkSelectedBot', 'utkBotCode']).then(data => {
        const bot = data.utkSelectedBot;
        const code = (data.utkBotCode || '').trim();
        if (bot && code) {
          log('Sending handshake for bot:', bot);
          ws.send(JSON.stringify({ type: 'utk-extension-handshake', bot, code }));
        }
      }).catch(() => {});
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        log('Message received:', msg.type);
        if (msg.type === 'bot-active') return handleBotActive(msg);
        if (msg.type === 'bot-inactive') return handleBotInactive(msg);
        if (msg.type === 'select-currency') return handleCurrencySelection(msg);
        if (msg.type === 'set-bet-size') return handleBetSizeUpdate(msg);
        if (msg.type === 'trade') return handleTrade(msg);
      } catch (e) {
        err('Parse error', e);
      }
    };

    ws.onclose = () => {
      log('Disconnected. Reconnecting in 2s...');
      handleAppDisconnected();
      reconnectTimer = setTimeout(connect, 2000);
    };

    ws.onerror = (e) => err('WebSocket error', e);
  } catch (e) {
    err('Connection error', e);
    handleAppDisconnected();
    reconnectTimer = setTimeout(connect, 2000);
  }
}

function ensureKeepAlive() {
  try {
    // Minimum period is 1 minute in Chrome.
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  } catch (e) {
    // ignore
  }
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== KEEPALIVE_ALARM) return;
    try {
      // Reconnect if needed
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        handleAppDisconnected();
        connect();
        return;
      }
      // Light ping to keep traffic flowing (main process responds with pong)
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch (e) {
      handleAppDisconnected();
      try { connect(); } catch (_) {}
    }
  });
} catch (e) {
  // ignore
}

function attachMessageHandlers() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'get-connection-status') {
      sendResponse({ connected });
    } else if (msg.type === 'content-script-ready') {
      sendResponse({ success: true });
    } else if (msg.type === 'utk-send-handshake') {
      const bot = msg.bot;
      const code = (msg.code || '').trim();
      if (bot && code && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'utk-extension-handshake', bot, code }));
        sendResponse({ success: true });
        return true;
      }
      sendResponse({ success: false });
    }
    return true;
  });
}

function attachStorageForwarder() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.utkSelectedBot && !changes.utkBotCode) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      chrome.storage.local.get(['utkSelectedBot', 'utkBotCode']).then(data => {
        const bot = data.utkSelectedBot;
        const code = (data.utkBotCode || '').trim();
        if (bot && code) {
          ws.send(JSON.stringify({ type: 'utk-extension-handshake', bot, code }));
        }
      }).catch(() => {});
    }
  });
}

attachMessageHandlers();
attachStorageForwarder();
ensureKeepAlive();
connect();
chrome.runtime.onStartup.addListener(connect);
