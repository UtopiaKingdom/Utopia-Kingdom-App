/**
 * Auto Trade toggle — requires an SSID saved via header Connect.
 * LUMIX and MIRAX may both run autotrade at the same time (shared SSID).
 *
 * Critical rule: once the user turns Auto Trade ON, do NOT silently turn it
 * off because a status poll blinked. Only the user (or a real expired/removed
 * SSID) should disable it.
 */

const { ipcRenderer } = require('electron');
try { require('./autotrade-chain-gate.js'); } catch (e) {}

const SHARED_BOTS = ['bot1', 'bot2', 'bot3'];
const BOT_KEY = { bot1: 'LUMIX', bot2: 'MIRAX', bot3: 'NYX' };

class ConnectionSystem {
  constructor() {
    this.bots = [
      { id: 'bot1', name: 'LUMIX' },
      { id: 'bot2', name: 'MIRAX' },
      { id: 'bot3', name: 'NYX' }
    ];
    this._arming = Object.create(null);
    this.init();
  }

  init() {
    this.attachBotHandlers();
  }

  setReason(botId, text) {
    try { window.setBotAutotradeReason?.(botId, text); } catch (e) {}
  }

  clearReason(botId) {
    try { window.clearBotAutotradeReason?.(botId); } catch (e) {}
  }

  refreshEmpty(botId) {
    const botKey = BOT_KEY[botId];
    try {
      if (botKey) window.updateBotEmptyState?.(botKey);
      else window.refreshAllBotEmptyStates?.();
    } catch (e) {}
  }

  isArming(botId) {
    return !!this._arming[botId];
  }

  pushEnabled(botId, enabled, extra = {}) {
    const on = !!enabled;
    const source = on
      ? (extra.source || 'user-toggle')
      : (extra.source || 'user-toggle');
    try {
      ipcRenderer.send('sync-autotrade-config', {
        botId,
        ...extra,
        enabled: on,
        source
      });
    } catch (e) {}
    try {
      const botKey = BOT_KEY[botId];
      if (botKey && typeof window.syncAutotradeConfigToMain === 'function') {
        window.syncAutotradeConfigToMain(botKey, { enabled: on, source, ...extra });
      }
    } catch (e) {}
  }

  /** True if Connect UI or main already knows an SSID is saved. */
  hasSavedSsidLocal(botId) {
    try {
      for (const id of SHARED_BOTS) {
        const s = window.ssidManager?.statusByBot?.[id];
        if (s && s.hasSsid && !s.expired) return true;
      }
    } catch (e) {}
    return false;
  }

  attachBotHandlers() {
    this.bots.forEach(({ id }) => {
      const toggle = document.getElementById(`autoTradeToggle-${id}`);
      if (!toggle) return;

      toggle.addEventListener('change', async () => {
        if (!toggle.checked) {
          if (this._arming[id]) return;
          try { window.setAutotradeWaitForChainEnd?.(id, false); } catch (e) {}
          try { window.markSavingLadderReset?.(BOT_KEY[id]); } catch (e) {}
          this.pushEnabled(id, false, { waitForChainEnd: false, historyNextAttempt: 1 });
          this.refreshEmpty(id);
          return;
        }

        this._arming[id] = true;
        let midChain = false;
        try {
          midChain = !!(typeof window.isSignalChainOngoing === 'function' && window.isSignalChainOngoing(id));
        } catch (e) {
          midChain = false;
        }
        const chainMsg = window.AUTO_TRADE_CHAIN_ONGOING_MSG
          || 'Chain ongoing — will place the next signal when a new chain starts';
        // Arm main immediately — never leave UI ON / main OFF.
        // Mid-chain: wait for a fresh 1x. Never jump into S2–S4.
        this.pushEnabled(id, true, { waitForChainEnd: midChain, joinMidChain: false });
        if (midChain) {
          try { window.applyAutotradeChainChoice?.(id, 'wait'); } catch (e) {}
          this.setReason(id, chainMsg);
        } else {
          this.clearReason(id);
        }
        try {
          window.setTradeStatus?.(
            BOT_KEY[id],
            midChain ? chainMsg : 'Ready for the next signal'
          );
        } catch (e) {}

        try {
          const ready = await this.verifySsidReady(id);
          if (!toggle.checked) return;

          if (!ready) {
            // Keep Auto Trade ON. Warn + open Connect — do not yank the toggle.
            // Yanking caused SignalHub "autotrade disabled" while the UI looked armed.
            this.setReason(id, 'Connect Pocket Option. Auto trade is on and waiting for SSID.');
            try {
              window.setTradeStatus?.(BOT_KEY[id], 'Connect Pocket Option to place trades');
            } catch (e) {}
            window.ssidManager?.hintConnect?.(id);
            this.refreshEmpty(id);
            return;
          }

          try {
            midChain = !!(typeof window.isSignalChainOngoing === 'function' && window.isSignalChainOngoing(id));
          } catch (e) {
            midChain = false;
          }

          if (midChain) {
            try { window.applyAutotradeChainChoice?.(id, 'wait'); } catch (e) {}
            this.pushEnabled(id, true, { waitForChainEnd: true, joinMidChain: false });
            this.setReason(id, chainMsg);
            try { window.setTradeStatus?.(BOT_KEY[id], chainMsg); } catch (e) {}
            this.refreshEmpty(id);
            return;
          }

          try { window.applyAutotradeChainChoice?.(id, 'jump'); } catch (e) {}
          this.pushEnabled(id, true, { waitForChainEnd: false, joinMidChain: false });
          try {
            const botKey = BOT_KEY[id];
            if (botKey && typeof window.syncSavingSignalStakeToMain === 'function') {
              window.syncSavingSignalStakeToMain(botKey, '');
            }
          } catch (eSave) {}
          this.clearReason(id);
          try { window.setTradeStatus?.(BOT_KEY[id], 'Ready for the next signal'); } catch (e) {}
          this.refreshEmpty(id);
        } finally {
          this._arming[id] = false;
        }
      });
    });
  }

  async verifySsidReady(botId) {
    try {
      if (this.hasSavedSsidLocal(botId)) return true;

      for (const id of SHARED_BOTS) {
        const cached = await ipcRenderer.invoke('get-pocket-option-ssid-status', { botId: id });
        if (cached?.status?.hasSsid && !cached?.status?.expired) return true;
        // Persist into ssidManager so next checks are instant.
        try {
          if (cached?.status && window.ssidManager) {
            window.ssidManager.statusByBot[id] = cached.status;
          }
        } catch (e) {}
      }

      const res = await ipcRenderer.invoke('refresh-pocket-option-ssid-status', {
        botId,
        force: true
      });
      if (res?.status?.hasSsid && !res?.status?.expired) return true;
      if (res?.status?.activeOnline) return true;

      for (const id of SHARED_BOTS) {
        if (id === botId) continue;
        const sibling = await ipcRenderer.invoke('get-pocket-option-ssid-status', { botId: id });
        if (sibling?.status?.hasSsid && !sibling?.status?.expired) return true;
      }
      return false;
    } catch (e) {
      // Soft-fail: keep autotrade armed; local cache may still be fine.
      return this.hasSavedSsidLocal(botId);
    }
  }

  onSsidConnected(botId, status) {
    const hasSsid = !!(status && status.hasSsid);
    const expired = !!(status && status.expired);

    // Only pause on hard disconnect (expired / SSID removed) — never on a blink.
    if (expired || !hasSsid) {
      const siblingAlive = SHARED_BOTS.some((id) => {
        if (id === botId) return false;
        const s = window.ssidManager?.statusByBot?.[id];
        return !!(s && s.hasSsid && !s.expired);
      });
      if (siblingAlive) {
        this.clearReason(botId);
        this.refreshEmpty(botId);
        return;
      }

      const toggle = document.getElementById(`autoTradeToggle-${botId}`);
      if (toggle?.checked) {
        this._arming[botId] = true;
        try {
          toggle.checked = false;
          this.pushEnabled(botId, false, { source: 'hard-disconnect' });
        } finally {
          this._arming[botId] = false;
        }
        this.setReason(botId, expired ? 'SSID expired. Auto trade paused.' : 'Disconnected. Auto trade paused.');
        try {
          window.setTradeStatus?.(
            BOT_KEY[botId],
            expired ? 'SSID expired. Auto trade paused.' : 'Disconnected. Auto trade paused.'
          );
        } catch (e) {}
        try {
          ipcRenderer.invoke('show-notification', {
            title: `${BOT_KEY[botId] || 'Bot'} autotrade paused`,
            body: expired
              ? 'Pocket Option SSID expired. Paste a new token to continue.'
              : 'Pocket Option disconnected. Reconnect to continue autotrade.'
          }).catch(() => {});
        } catch (e) {}
      }
    } else {
      this.clearReason(botId);
      // Re-affirm enabled if toggle is still on (heals any earlier desync).
      const toggle = document.getElementById(`autoTradeToggle-${botId}`);
      if (toggle?.checked) this.pushEnabled(botId, true);
    }
    this.refreshEmpty(botId);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { window.connectionSystem = new ConnectionSystem(); });
} else {
  window.connectionSystem = new ConnectionSystem();
}
