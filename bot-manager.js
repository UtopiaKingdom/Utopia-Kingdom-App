// Bot UI and Auto-Trade Logic
// console.log('bot-manager.js loaded'); // Production: disabled
const { ipcRenderer } = require('electron');

class BotManager {
  constructor(botId) {
    this.botId = botId;
    this.botName = botId === 'bot1' ? 'LUMIX' : botId === 'bot2' ? 'MIRAX' : 'ARVION';
    this.signalHistory = [];
    this.currentSignal = null;
    this.autoTradeEnabled = false;
    this.betSize = 10;
    this.extensionConnected = false;
    
    this.initElements();
    this.initEventListeners();
    this.setupExtensionConnection();
  }
  
  initElements() {
    this.signalEmpty = document.getElementById(`signalEmpty-${this.botId}`);
    this.signalDisplay = document.getElementById(`signalDisplay-${this.botId}`);
    this.autoTradeToggle = document.getElementById(`autoTradeToggle-${this.botId}`);
    this.betSizeInput = document.getElementById(`betSize-${this.botId}`);
    this.connStatus = document.getElementById(`connStatus-${this.botId}`);
    this.installBtn = document.getElementById(`installExtBtn-${this.botId}`);
    this.historyBtn = document.getElementById(`historyBtn-${this.botId}`);
  }
  
  initEventListeners() {
    // Back button
    document.querySelectorAll('.bot-back-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const target = btn.getAttribute('data-target');
        document.getElementById(`menu-${target}`)?.click();
      });
    });
    
    // Auto-trade toggle
    if (this.autoTradeToggle) {
      this.autoTradeToggle.addEventListener('change', (e) => {
        this.autoTradeEnabled = e.target.checked;
        // console.log(`[${this.botName}] Auto-trade: ${this.autoTradeEnabled ? 'ON' : 'OFF'}`);
      });
    }
    
    // Bet size input
    if (this.betSizeInput) {
      this.betSizeInput.addEventListener('change', (e) => {
        this.betSize = parseFloat(e.target.value) || 10;
        // console.log(`[${this.botName}] Bet size: $${this.betSize}`);
      });
    }
    
    // Install extension button
    if (this.installBtn) {
      this.installBtn.addEventListener('click', () => {
        const { shell } = require('electron');
        // Open Chrome extensions page with instructions
        const extensionPath = require('path').join(__dirname, 'extention');
        shell.openPath(extensionPath);
      });
    }
    
    // History button
    if (this.historyBtn) {
      this.historyBtn.addEventListener('click', () => {
        this.showHistory();
      });
    }
  }
  
  // Display a new signal (phase: preparing, signal, result)
  addSignal(signalData) {
    // Hide empty state
    if (this.signalEmpty) this.signalEmpty.style.display = 'none';
    if (this.signalDisplay) this.signalDisplay.style.display = 'flex';
    
    const { phase, currency, side, timestamp, result } = signalData;
    
    // Create signal card
    const card = document.createElement('div');
    card.className = 'signal-card';
    card.dataset.signalId = timestamp;
    
    let phaseClass = phase.toLowerCase();
    if (phase === 'result') {
      phaseClass = result && result.toLowerCase() === 'win' ? 'win' : 'loss';
    }
    
    const header = `
      <div class="signal-card-header">
        <span class="signal-phase ${phaseClass}">${phase.toUpperCase()}</span>
        <span class="signal-timestamp">${new Date(timestamp).toLocaleTimeString()}</span>
      </div>
    `;
    
    let dataHtml = '<div class="signal-data">';
    
    if (phase === 'preparing' || phase === 'signal') {
      if (currency) {
        dataHtml += `
          <div class="signal-field">
            <span class="signal-field-label">Currency</span>
            <strong class="signal-field-value">${currency}</strong>
          </div>
        `;
      }
      
      if (side) {
        dataHtml += `
          <div class="signal-field">
            <span class="signal-field-label">Side</span>
            <strong class="signal-field-value ${side.toLowerCase()}">${side}</strong>
          </div>
        `;
      }
    }
    
    if (phase === 'result') {
      dataHtml += `
        <div class="signal-field">
          <span class="signal-field-label">Result</span>
          <strong class="signal-field-value ${result.toLowerCase() === 'win' ? 'buy' : 'sell'}">${result.toUpperCase()}</strong>
        </div>
      `;
      
      if (currency) {
        dataHtml += `
          <div class="signal-field">
            <span class="signal-field-label">Currency</span>
            <strong class="signal-field-value">${currency}</strong>
          </div>
        `;
      }
    }
    
    dataHtml += '</div>';
    
    card.innerHTML = header + dataHtml;
    
    // Prepend to display (newest first)
    if (this.signalDisplay) {
      this.signalDisplay.insertBefore(card, this.signalDisplay.firstChild);
    }
    
    // Add to history
    this.signalHistory.unshift(signalData);
    
    // Limit displayed signals to last 10
    const cards = this.signalDisplay.querySelectorAll('.signal-card');
    if (cards.length > 10) {
      cards[cards.length - 1].remove();
    }
    
    // If auto-trade is on and phase is 'signal', send to extension
    if (this.autoTradeEnabled && phase === 'signal' && this.extensionConnected) {
      this.executeTrade(signalData);
    }
  }
  
  executeTrade(signalData) {
    // console.log(`[${this.botName}] Executing trade:`, signalData, `Bet: $${this.betSize}`);
    
    // Send trade to extension via IPC
    ipcRenderer.invoke('send-to-extension', {
      type: 'trade',
      bot: this.botName,
      currency: signalData.currency,
      side: signalData.side,
      betSize: this.betSize,
      timestamp: Date.now()
    }).then(result => {
      if (result.success) {
        // console.log(`[${this.botName}] Trade sent to extension`);
      } else {
        // console.error(`[${this.botName}] Failed to send trade:`, result.error);
      }
    });
  }
  
  setupExtensionConnection() {
    // Listen for extension connection status
    ipcRenderer.on('extension-connected', (event, connected) => {
      // console.log(`[${this.botName}] Extension connection:`, connected);
      this.setExtensionStatus(connected);
    });
  }
  
  showHistory() {
    const modal = document.getElementById('history-modal');
    const title = document.getElementById('historyModalTitle');
    const list = document.getElementById('historyList');
    
    if (title) title.textContent = `${this.botName} - Signal History`;
    
    if (list) {
      if (this.signalHistory.length === 0) {
        list.innerHTML = '<p style="color:#9aa0a6;text-align:center;padding:40px 0;">No history yet</p>';
      } else {
        list.innerHTML = this.signalHistory.map(signal => {
          const phaseClass = signal.phase === 'result' 
            ? (signal.result?.toLowerCase() === 'win' ? 'win' : 'loss')
            : signal.phase.toLowerCase();
          
          return `
            <div class="history-item">
              <div class="history-item-header">
                <span class="signal-phase ${phaseClass}">${signal.phase.toUpperCase()}</span>
                <span class="signal-timestamp">${new Date(signal.timestamp).toLocaleString()}</span>
              </div>
              <div class="signal-data">
                ${signal.currency ? `<div class="signal-field"><span class="signal-field-label">Currency</span><strong class="signal-field-value">${signal.currency}</strong></div>` : ''}
                ${signal.side ? `<div class="signal-field"><span class="signal-field-label">Side</span><strong class="signal-field-value ${signal.side.toLowerCase()}">${signal.side}</strong></div>` : ''}
                ${signal.result ? `<div class="signal-field"><span class="signal-field-label">Result</span><strong class="signal-field-value ${signal.result.toLowerCase() === 'win' ? 'buy' : 'sell'}">${signal.result.toUpperCase()}</strong></div>` : ''}
              </div>
            </div>
          `;
        }).join('');
      }
    }
    
    if (modal) modal.classList.add('active');
  }
  
  setExtensionStatus(connected) {
    this.extensionConnected = connected;
    if (!this.connStatus) return; // Guard against null element
    
    const indicator = this.connStatus.querySelector('.status-indicator');
    const text = this.connStatus.querySelector('span');
    
    if (indicator) {
      indicator.classList.remove('online', 'offline');
      indicator.classList.add(connected ? 'online' : 'offline');
    }
    
    if (text) {
      text.textContent = connected ? 'Connected' : 'Disconnected';
    }
    
    if (this.installBtn) {
      this.installBtn.textContent = connected ? 'Disconnect' : 'Install Extension';
      this.installBtn.style.display = connected ? 'none' : 'block';
    }
  }
}

// Initialize bot managers
const bot1Manager = new BotManager('bot1');
const bot2Manager = new BotManager('bot2');
const bot3Manager = new BotManager('bot3');

// History modal close
document.querySelector('.history-close-btn')?.addEventListener('click', () => {
  document.getElementById('history-modal').classList.remove('active');
});

// Close history modal on background click
document.getElementById('history-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'history-modal') {
    e.target.classList.remove('active');
  }
});

// Example: simulate receiving signals (for testing)
// Uncomment to test the UI
/*
setTimeout(() => {
  bot1Manager.addSignal({
    phase: 'preparing',
    currency: 'EUR/USD',
    timestamp: Date.now()
  });
  
  setTimeout(() => {
    bot1Manager.addSignal({
      phase: 'signal',
      currency: 'EUR/USD',
      side: 'BUY',
      timestamp: Date.now()
    });
    
    setTimeout(() => {
      bot1Manager.addSignal({
        phase: 'result',
        currency: 'EUR/USD',
        result: 'WIN',
        timestamp: Date.now()
      });
    }, 3000);
  }, 2000);
}, 3000);
*/

// Export managers for use in WebSocket handler
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { bot1Manager, bot2Manager, bot3Manager };
}
