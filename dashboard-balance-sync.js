// Legacy stub — balances now come from ssid-manager status (trade-worker session).
// Kept so older require() sites do not crash. Does not open extra PO logins.

class DashboardBalanceSync {
  constructor() {
    this.bots = new Map();
    this.isRunning = false;
  }

  async init() {}
  startSync() {}
  stopSync() {}
  async syncAllBalances() {}
  async fetchBotBalances() {}
  updateUI() {}
  getBalance() {
    return null;
  }
  addBot() {}
  removeBot() {}
}

let balanceSync = null;

function getBalanceSync() {
  if (!balanceSync) balanceSync = new DashboardBalanceSync();
  return balanceSync;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DashboardBalanceSync, getBalanceSync };
}
