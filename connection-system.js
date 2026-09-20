/**
 * Connection System for Auto Trading Extension
 * Manages:
 * - Code generation and storage
 * - Bot-to-code mapping
 * - Extension connection validation
 */

const { ipcRenderer } = require('electron');

class ConnectionSystem {
  constructor() {
    this.bots = [
      { id: 'bot1', name: 'LUMIX' },
      { id: 'bot2', name: 'MIRAX' },
      { id: 'bot3', name: 'ARVION' }
    ];
    this.shutdownHandled = false;
    this.appConnected = false;
    this.init();
  }

  init() {
    this.attachGlobalButtons();
    this.buildStatusRows();
    this.attachBotHandlers();
    this.listenForExtensionConnection();
    this.restoreCodesToUI();
    this.attachShutdownHandler();
  }

  buildStatusRows() {
    this.bots.forEach(({ id }) => {
      const statusEl = document.getElementById(`connStatus-${id}`);
      if (!statusEl) return;
      statusEl.innerHTML = '';

      const appRow = this.createStatusRow(`app-${id}`, 'App ↔ Extension');
      const botRow = this.createStatusRow(`bot-${id}`, 'Bot ↔ App');

      statusEl.appendChild(appRow);
      statusEl.appendChild(botRow);
    });
  }

  createStatusRow(rowId, label) {
    const row = document.createElement('div');
    row.className = 'status-row';
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.style.marginBottom = '6px';

    const indicator = document.createElement('div');
    indicator.className = 'status-indicator offline';
    indicator.dataset.rowId = rowId;

    const text = document.createElement('span');
    text.dataset.rowId = `${rowId}-text`;
    text.textContent = `${label}: Disconnected`;

    row.appendChild(indicator);
    row.appendChild(text);
    return row;
  }

  setAppStatusUI(connected) {
    this.appConnected = !!connected;
    this.bots.forEach(({ id }) => {
      const indicator = document.querySelector(`#connStatus-${id} .status-indicator[data-row-id="app-${id}"]`);
      const text = document.querySelector(`#connStatus-${id} span[data-row-id="app-${id}-text"]`);
      if (indicator) {
        indicator.classList.toggle('online', this.appConnected);
        indicator.classList.toggle('offline', !this.appConnected);
      }
      if (text) {
        text.textContent = `App ↔ Extension: ${this.appConnected ? 'Connected' : 'Disconnected'}`;
      }
    });
    if (!this.appConnected) {
      this.bots.forEach(({ id }) => this.setBotStatusUI(id, 'Disconnected', false));
    } else {
      // Refresh bot rows when app reconnects
      this.bots.forEach(({ id }) => {
        const toggle = document.getElementById(`autoTradeToggle-${id}`);
        if (toggle && toggle.checked) {
          this.setBotStatusUI(id, 'Awaiting handshake', false);
        }
      });
    }
  }

  setBotStatusUI(botId, label, connected) {
    const indicator = document.querySelector(`#connStatus-${botId} .status-indicator[data-row-id="bot-${botId}"]`);
    const text = document.querySelector(`#connStatus-${botId} span[data-row-id="bot-${botId}-text"]`);
    const appMissing = !this.appConnected;
    if (indicator) {
      indicator.classList.toggle('online', !!connected && !appMissing);
      indicator.classList.toggle('offline', !connected || appMissing);
    }
    if (text) {
      if (appMissing) {
        text.textContent = 'Bot ↔ App: Waiting for app connection';
      } else {
        text.textContent = `Bot ↔ App: ${label || (connected ? 'Connected' : 'Disconnected')}`;
      }
    }
    const banner = document.getElementById(`botConnectedBanner-${botId}`);
    if (banner) banner.style.display = connected && !appMissing ? 'flex' : 'none';
  }

  // Global install/guide buttons placed in Trading Bots section
  attachGlobalButtons() {
    const { shell } = require('electron');
    const downloadBtn = document.getElementById('downloadExtensionBtnBots');
    const guideBtn = document.getElementById('installationGuideBtnBots');
    const closeGuideBtn = document.getElementById('closeGuideBtn');
    const guideIconButtons = document.querySelectorAll('.autoTradeHelpBtn');

    if (downloadBtn) downloadBtn.addEventListener('click', () => shell.openExternal('https://utkingdom.com/releases/UtK-AT-Extension.zip'));
    if (guideBtn) guideBtn.addEventListener('click', () => this.showInstallationGuide());
    if (closeGuideBtn) closeGuideBtn.addEventListener('click', () => this.closeGuide());
    guideIconButtons.forEach(btn => btn.addEventListener('click', () => this.showInstallationGuide()));
  }

  attachBotHandlers() {
    this.bots.forEach(({ id, name }) => {
      const toggle = document.getElementById(`autoTradeToggle-${id}`);

      if (toggle) {
        toggle.addEventListener('change', () => {
          if (toggle.checked) {
            // Generate if missing
            let code = this.getBotCode(id);
            if (!code) {
              code = this.generateBotCode(id);
            }
            this.updateBotCodeUI(id, code);
            // Inform extension about active bot (optional broadcast)
            this.sendToExtension({ type: 'bot-active', bot: id, code });
            this.setBotStatusUI(id, 'Awaiting handshake', false);
          } else {
            // Clearing code on OFF
            this.clearBotCode(id);
            this.updateBotCodeUI(id, null);
            this.setBotStatusUI(id, 'Disconnected', false);
            this.sendToExtension({ type: 'bot-inactive', bot: id });
          }
        });
      }
    });
  }

  // Code management
  generateBotCode(botId) {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    const code = `${timestamp}-${random}`;
    localStorage.setItem(`utk-code-${botId}`, code);
    localStorage.setItem(`utk-code-${botId}-active`, '1');
    return code;
  }

  getBotCode(botId) {
    const active = localStorage.getItem(`utk-code-${botId}-active`) === '1';
    if (!active) return null;
    return localStorage.getItem(`utk-code-${botId}`);
  }

  clearBotCode(botId) {
    localStorage.removeItem(`utk-code-${botId}-active`);
    // Keep code value for user reference but mark inactive
  }

  updateBotCodeUI(botId, code) {
    const display = document.getElementById(`botCodeDisplay-${botId}`);
    if (!display) return;
    if (code) display.textContent = code;
    else display.textContent = 'Generate by turning Auto Trade ON';
  }

  restoreCodesToUI() {
    // Always start with Auto Trade toggles OFF on app launch.
    this.bots.forEach(({ id }) => {
      // Clear persisted "active" state so bots do not auto-reconnect after restart
      localStorage.removeItem(`utk-code-${id}-active`);

      // Reset UI elements
      const toggle = document.getElementById(`autoTradeToggle-${id}`);
      if (toggle) toggle.checked = false;
      this.updateBotCodeUI(id, null);
      this.setBotStatusUI(id, 'Disconnected', false);
    });
    this.setAppStatusUI(false);
  }

  // On app/window shutdown, notify extension all bots are offline (keep active flag for persistence)
  attachShutdownHandler() {
    const shutdown = () => {
      if (this.shutdownHandled) return;
      this.shutdownHandled = true;
      this.bots.forEach(({ id }) => {
        const active = localStorage.getItem(`utk-code-${id}-active`) === '1';
        if (active) {
          // Keep the code and active flag (for restart persistence)
          // But notify extension the bot is going offline
          this.sendToExtension({ type: 'bot-inactive', bot: id });
        }
      });
    };

    window.addEventListener('beforeunload', shutdown);
    window.addEventListener('unload', shutdown);
  }

  // On app startup, re-send bot-active for any saved codes to refresh extension state
  refreshSavedBotStates() {
    this.bots.forEach(({ id }) => {
      const code = this.getBotCode(id);
      if (code) {
        this.sendToExtension({ type: 'bot-active', bot: id, code });
      }
    });
  }

  // Guide modal
  showInstallationGuide() {
    const modal = document.getElementById('connection-guide-modal');
    if (modal) modal.style.display = 'flex';
  }

  closeGuide() {
    const modal = document.getElementById('connection-guide-modal');
    if (modal) modal.style.display = 'none';
  }

  // Toast helper
  showToast(message) {
    // Toasts disabled per UX request
    return;
  }

  // Extension connection listeners
  listenForExtensionConnection() {
    // Main process forwards raw extension messages via 'extension-message'
    ipcRenderer.on('extension-message', (event, msg) => {
      if (!msg || typeof msg !== 'object') return;
      // Handshake from extension carrying bot + code
      if (msg.type === 'utk-extension-handshake') {
        const bot = msg.bot;
        const code = (msg.code || '').trim();
        const localCode = this.getBotCode(bot);

        if (localCode && code && localCode === code) {
          // Valid match → mark connected
          this.setBotStatusUI(bot, 'Connected', true);
          // Notify extension of success
          this.sendToExtension({ type: 'utk-connection-status', bot, status: 'active' });
        } else {
          // Invalid or missing code → ensure disconnected UI
          this.setBotStatusUI(bot, 'Disconnected', false);
          // Notify extension of failure
          this.sendToExtension({ type: 'utk-connection-status', bot, status: 'invalid-code' });
        }
      }

      // Optional: react to extension status echoes
      if (msg.type === 'trade-result') {
        // Could surface trade outcomes per bot here if desired
      }
    });

    // App ↔ extension socket connection state
    ipcRenderer.on('extension-connected', (_event, connected) => {
      this.setAppStatusUI(connected);
      if (connected) {
        // On extension connect, resend any saved bot-active states immediately
        this.refreshSavedBotStates();
      } else {
        this.bots.forEach(({ id }) => this.setBotStatusUI(id, 'Disconnected', false));
      }
    });
  }

  // Send info to extension via IPC
  async sendToExtension(payload, retries = 2, delayMs = 300) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await ipcRenderer.invoke('send-to-extension', payload);
        if (!res || res.success === false) throw new Error(res?.error || 'send failed');
        return true;
      } catch (err) {
        if (attempt === retries) return false;
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return false;
  }
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { window.connectionSystem = new ConnectionSystem(); });
} else {
  window.connectionSystem = new ConnectionSystem();
}
