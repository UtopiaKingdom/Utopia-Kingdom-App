// Offscreen document keepalive pings for MV3 service worker.
const PING_INTERVAL_MS = 20000;

function sendPing() {
  try {
    chrome.runtime.sendMessage({ type: 'offscreen-keepalive', ts: Date.now() }, () => {
      // ignore response
    });
  } catch (e) {}
}

setInterval(sendPing, PING_INTERVAL_MS);
sendPing();
