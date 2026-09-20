// Simple sender to push a test message into the app via WebSocket
// Usage: node send_ws_message.js
// Adjust targetUrl if needed.

const WebSocket = require('ws');

const targetUrl = 'ws://localhost:3000/ws';
const payload = {
  bot: 'LUMIX',
  time: new Date().toLocaleTimeString(),
  symbol: 'EURUSD',
  side: 'BUY',
  price: 1.10234,
  sl: 1.10000,
  tp: 1.10650
};

// console.log('[SENDER] Connecting to', targetUrl);
const ws = new WebSocket(targetUrl);

ws.on('open', () => {
  // console.log('[SENDER] ✓ Connected to', targetUrl);
  const json = JSON.stringify(payload);
  ws.send(json);
  // console.log('[SENDER] ✓ Sent payload (', json.length, 'bytes)');
  // console.log('[SENDER] Payload:', payload);
  setTimeout(() => {
    ws.close();
    // console.log('[SENDER] Connection closed.');
  }, 500);
});

ws.on('error', (err) => {
  // console.error('[SENDER] ✗ Error:', err.message || err);
  process.exit(1);
});

ws.on('close', () => {
  // console.log('[SENDER] Closed.');
});
