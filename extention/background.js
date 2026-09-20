// background.js (MV3 service worker)
// - Accepts challenge from native host and stores pending challenge in storage
// - Accepts verify requests from popup (cmd: 'verify') and forwards {type:'verify', id, code} to native host
// - On native {type:'verified'} sets nativeHostConnected=true and clears pending challenge
// - Forwards native trade messages to allowed pocketoption tab (injects content script if needed)
// - FIREWALL: Only forwards trade messages if verified; blocks unverified trades

const HOST_NAME = "com.example_trading_host";
let nativePort = null;
let sessionStartTime = null;
const SESSION_TIMEOUT_MS = 3600000; // 1 hour = 3600000 ms

const allowedHosts = ["pocketoption.com"]; // keep whitelist

function setConnectedState(ok) {
  try { chrome.storage.local.set({ nativeHostConnected: !!ok }); console.log('[bg] nativeHostConnected ->', !!ok); } catch {}
}

function setPendingChallenge(ch) {
  try { chrome.storage.local.set({ nativeHostPending: !!ch, nativeHostPendingChallenge: ch || null }); console.log('[bg] pendingChallenge ->', !!ch, ch); } catch {}
}

function clearPendingChallenge() { setPendingChallenge(null); }

function setSessionStart() {
  sessionStartTime = Date.now();
  try { chrome.storage.local.set({ sessionStartTime: sessionStartTime }); console.log('[bg] Session started at', sessionStartTime); } catch {}
}

function clearSession() {
  sessionStartTime = null;
  try { chrome.storage.local.set({ sessionStartTime: null }); console.log('[bg] Session cleared'); } catch {}
}

function isSessionValid() {
  if (!sessionStartTime) return false;
  const elapsed = Date.now() - sessionStartTime;
  if (elapsed > SESSION_TIMEOUT_MS) {
    console.log('[bg] FIREWALL: Session expired after', Math.floor(elapsed / 1000), 'seconds');
    clearSession();
    setConnectedState(false);
    return false;
  }
  return true;
}

function connectNative() {
  console.log('[bg] Attempting connectNative() to', HOST_NAME);
  try {
    if (nativePort) {
      try { nativePort.disconnect(); } catch {}
      nativePort = null;
    }
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    console.log('[bg] Native port created successfully');
  } catch (err) {
    console.error('[bg] connectNative threw:', err);
    setConnectedState(false);
    clearPendingChallenge();
    setTimeout(connectNative, 2000);
    return;
  }

  setConnectedState(false);
  clearPendingChallenge();

  nativePort.onMessage.addListener((msg) => {
    try {
      console.log('[bg] native->ext received message:', JSON.stringify(msg));
      if (msg && msg.type === 'challenge') {
        // store pending challenge (id + code)
        const ch = { id: msg.id, code: msg.code, ts: Date.now() };
        console.log('[bg] Challenge received, storing:', ch);
        setPendingChallenge(ch);
        setConnectedState(false); // still not verified
      } else if (msg && msg.type === 'verified') {
        // Host confirmed verification; mark connected and clear pending
        console.log('[bg] Verification confirmed');
        setConnectedState(true);
        setSessionStart(); // FIREWALL: Start session timer on verification
        clearPendingChallenge();
      } else if (msg && msg.type === 'verify_failed') {
        console.warn('[bg] FIREWALL: Verification failed -', msg.reason);
        setConnectedState(false);
      } else if (msg && msg.type === 'trade_blocked') {
        console.warn('[bg] FIREWALL: Trade blocked by native host -', msg.reason);
      } else if (msg && msg.type === 'trade') {
        // FIREWALL: Only forward trade if session is valid
        if (!isSessionValid()) {
          console.error('[bg] FIREWALL: Trade rejected - invalid or expired session');
          return;
        }
        // Forward trade to allowed tabs
        forwardTradeMessage(msg);
      } else {
        console.log('[bg] Other message type:', msg.type);
        // other messages (echo) - ignore or log
      }
    } catch (e) {
      console.warn('[bg] error handling native message', e);
    }
  });

  nativePort.onDisconnect.addListener(() => {
    console.warn('[bg] nativePort.onDisconnect', chrome.runtime.lastError);
    setConnectedState(false);
    clearPendingChallenge();
    nativePort = null;
    setTimeout(connectNative, 2000);
  });

  // send initial ping to cause host to issue challenge (host will send the pre-generated code)
  try {
    console.log('[bg] Sending initial ping to native host...');
    nativePort.postMessage({ type: 'hello', ping: 'ping' });
    console.log('[bg] Ping sent successfully');
  } catch (e) {
    console.warn('[bg] postMessage threw', e);
  }
}

// Forwarding trades to allowed PocketOption tab; inject content_script.js if needed then retry
async function forwardTradeMessage(msg) {
  try {
    // FIREWALL: Double-check session before forwarding
    if (!isSessionValid()) {
      console.error('[bg] FIREWALL: forwardTradeMessage rejected - session invalid');
      return;
    }
    
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      try {
        if (!t.url) continue;
        const url = new URL(t.url);
        if (!allowedHosts.some(h => url.hostname.includes(h) || url.host.includes(h))) continue;

        // try send to tab
        chrome.tabs.sendMessage(t.id, { type: 'action', action: msg.action, id: msg.id, verified: true }, (res) => {
          if (chrome.runtime.lastError) {
            // inject then retry
            chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content_script.js'] })
              .then(() => chrome.tabs.sendMessage(t.id, { type: 'action', action: msg.action, id: msg.id, verified: true }))
              .catch((e) => console.warn('[bg] injection failed', e));
          } else {
            // delivered
          }
        });
        // stop after first matching tab attempted
        break;
      } catch (e) { /* skip invalid url */ }
    }
  } catch (e) {
    console.warn('[bg] forwardTradeMessage error', e);
  }
}

// Popup -> background verification handler
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req && req.cmd === 'verify') {
    const code = String(req.code || '').trim();
    // read stored pending challenge
    chrome.storage.local.get(['nativeHostPendingChallenge'], (res) => {
      const ch = res && res.nativeHostPendingChallenge;
      if (!ch) {
        sendResponse({ ok: false, reason: 'no_pending' });
        return;
      }
      // Compare input code with stored code
      if (ch.code !== code) {
        sendResponse({ ok: false, reason: 'mismatch' });
        return;
      }
      // forward verify to native host
      if (!nativePort) {
        sendResponse({ ok: false, reason: 'no_port' });
        return;
      }
      try {
        nativePort.postMessage({ type: 'verify', id: ch.id, code: ch.code });
        // host will respond with {type:'verified', id} when it accepts
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, reason: 'post_failed', error: String(e) });
      }
    });
    return true; // async
  }
});
 
// initialize
setConnectedState(false);
clearPendingChallenge();
// Delay connection slightly to let service worker fully initialize
setTimeout(connectNative, 500);