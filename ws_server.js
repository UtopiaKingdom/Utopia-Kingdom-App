// Minimal local WebSocket server for dev at ws://localhost:3000/ws
// Requires: npm install ws
// No auto-broadcast; messages sent via send_ws_message.js only

const http = require('http');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Utopia Kingdom WS dev server running.\n');
});

const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (data) => {
    try {
      const incoming = JSON.parse(data);
      if (incoming.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      // Broadcast any other JSON to all clients
      broadcast(incoming);
    } catch {
      // Non-JSON payloads ignored
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`WS dev server listening on http://localhost:${PORT}/ws`);
  console.log('Send messages via: node send_ws_message.js');
});
