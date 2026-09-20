/**
 * autotrade-lifecycle.js
 * Full app quit turns Auto Trade OFF in the UI so the next launch starts disarmed.
 * Minimize-to-tray does not touch the toggles.
 */
(() => {
  const { ipcRenderer } = require('electron');

  function forceAutotradeOffUi() {
    for (const id of ['bot1', 'bot2', 'bot3']) {
      const toggle = document.getElementById(`autoTradeToggle-${id}`);
      if (!toggle || !toggle.checked) continue;
      toggle.checked = false;
      try { toggle.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    }
  }

  ipcRenderer.on('autotrade-force-off', forceAutotradeOffUi);
  ipcRenderer.on('prepare-close', forceAutotradeOffUi);
})();
