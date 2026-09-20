// Popup script for WebSocket extension (simplified bot list view)
const bots = [
  { id: 'bot1', name: 'LUMIX' },
  { id: 'bot2', name: 'MIRAX' },
  { id: 'bot3', name: 'ARVION' }
];

document.addEventListener('DOMContentLoaded', () => {
  const indicator = document.getElementById('connIndicator');
  const connText = document.getElementById('connText');
  const refreshBtn = document.getElementById('refreshConn');
  const connectAllBtn = document.getElementById('connectAll');
  const botList = document.getElementById('botList');
  let ws;

  function setStatus(connected, text) {
    indicator.classList.toggle('online', connected);
    indicator.classList.toggle('offline', !connected);
    connText.textContent = text || (connected ? 'Connected' : 'Disconnected');
  }

  function showToast(message) {
    try {
      const t = document.createElement('div');
      t.className = 'toast';
      t.textContent = message;
      document.body.appendChild(t);
      setTimeout(() => { t.remove(); }, 2500);
    } catch (_) {}
  }

  async function loadBotStates() {
    const keys = bots.flatMap(b => [`utkBotCode_${b.id}`, `utkBotStatus_${b.id}`]);
    const data = await chrome.storage.local.get(keys);
    renderBotList(data);
  }

  function renderBotList(state) {
    botList.innerHTML = '';
    bots.forEach(b => {
      const code = state[`utkBotCode_${b.id}`] || 'Waiting for code (turn ON Auto Trade)';
      const status = state[`utkBotStatus_${b.id}`] || 'inactive';
      const card = document.createElement('div');
      card.className = 'bot-card';
      const meta = document.createElement('div');
      meta.className = 'bot-meta';
      const name = document.createElement('div');
      name.className = 'bot-name';
      name.textContent = b.name;
      const codeEl = document.createElement('div');
      codeEl.className = 'bot-code';
      codeEl.textContent = `Code: ${code}`;
      meta.appendChild(name);
      meta.appendChild(codeEl);

      const chip = document.createElement('span');
      chip.className = 'chip ' + (status === 'active' ? 'on' : 'off');
      chip.textContent = status === 'active' ? 'Connected' : 'Waiting';

      card.appendChild(meta);
      card.appendChild(chip);
      botList.appendChild(card);
    });
  }

  function connect() {
    try {
      ws = new WebSocket('ws://127.0.0.1:8765');
      ws.onopen = () => setStatus(true, 'Connected');
      ws.onclose = () => {
        setStatus(false, 'Disconnected');
        chrome.storage.local.set({ autotradeActive: false });
      };
      ws.onerror = () => setStatus(false, 'Error');
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'utk-connection-status') {
            if (msg.status === 'active') {
              setStatus(true, 'Connected');
              chrome.storage.local.set({ autotradeActive: true });
            } else if (msg.status === 'invalid-code') {
              setStatus(true, 'Connected (invalid code)');
              chrome.storage.local.set({ autotradeActive: false });
            }
            loadBotStates();
          } else if (msg.type === 'bot-active') {
            chrome.storage.local.set({ autotradeActive: true });
            loadBotStates();
          } else if (msg.type === 'bot-inactive') {
            chrome.storage.local.set({ autotradeActive: false });
            loadBotStates();
          }
        } catch (_) {
          console.log('Message from app:', evt.data);
        }
      };
    } catch (e) {
      console.error('WS connect error', e);
      setStatus(false, 'Error');
    }
  }

  refreshBtn.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    setStatus(false, 'Disconnected');
    connect();
  });

  connectAllBtn.addEventListener('click', async () => {
    const data = await chrome.storage.local.get(['utkBotCode_bot1','utkBotCode_bot2','utkBotCode_bot3']);
    const ordered = ['bot1','bot2','bot3'];
    const firstWithCode = ordered.find(bot => (data[`utkBotCode_${bot}`] || '').trim());
    if (firstWithCode) {
      const code = (data[`utkBotCode_${firstWithCode}`] || '').trim();
      chrome.runtime.sendMessage({ type: 'utk-send-handshake', bot: firstWithCode, code }, () => {});
    } else {
      setStatus(false, 'No bot code available');
    }
  });

  // Init
  loadBotStates();
  connect();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const keys = Object.keys(changes);
    const relevant = keys.some(k => k.startsWith('utkBotCode_') || k.startsWith('utkBotStatus_'));
    if (relevant) {
      loadBotStates();
    }
  });
});
