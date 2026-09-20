// Auto-update checker that monitors GitHub releases
const packageJson = require('./package.json');

// Keep any UI placeholders in sync with the actual app version
try {
  if (typeof document !== 'undefined') {
    const spans = document.querySelectorAll('.update-version');
    spans.forEach((el) => {
      try { el.textContent = `v${packageJson.version}`; } catch (e) {}
    });
  }
} catch (e) {
  // ignore (non-DOM context)
}

async function checkForUpdates() {
  // Force in-app check via main process
  try {
    const { ipcRenderer } = require('electron');
    const result = await ipcRenderer.invoke('check-for-updates');
    const currentVersion = (packageJson && packageJson.version) ? packageJson.version : '';
    if (result && result.disabled) {
      return { disabled: true, currentVersion };
    }
    let hasUpdate = false;
    let latestVersion = '';
    if (result && result.version) {
      latestVersion = result.version;
      // use semantic comparison to avoid false positives like matching current version
      if (isNewerVersion(latestVersion, currentVersion)) {
        hasUpdate = true;
      }
    }
    if (hasUpdate) {
      return {
        hasUpdate: true,
        latestVersion,
        currentVersion,
        installerUrl: result.installerUrl || ''
      };
    }
    return { hasUpdate: false, currentVersion };
  } catch (err) {
    // Silent error handling
  }
  return { error: true };
}

// Simple semantic version comparison
function isNewerVersion(latest, current) {
  const parseVersion = (v) => v.split('.').map(n => parseInt(n, 10));
  const latestParts = parseVersion(latest);
  const currentParts = parseVersion(current);
  
  for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
    const l = latestParts[i] || 0;
    const c = currentParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

function showUpdateModal() {
  try {
    const updateInfo = arguments && arguments.length ? arguments[0] : null;
    if (window.__utkUpdateUi && typeof window.__utkUpdateUi.showUpdateModal === 'function') {
      window.__utkUpdateUi.showUpdateModal(updateInfo);
      return;
    }
  } catch (e) {}

  // Fallback if update-ui.js is not loaded yet
  try {
    const updateInfo = arguments && arguments.length ? arguments[0] : null;
    if (!updateInfo || updateInfo.disabled || !updateInfo.hasUpdate) return;

    const latest = String(updateInfo.latestVersion || updateInfo.version || '').trim();
    const vText = latest ? `v${latest.replace(/^v/i, '')}` : '';
    const status = document.getElementById('updateStatus');
    if (status) {
      status.style.display = 'block';
      status.textContent = `Update ${vText || ''} downloading in the background.`.trim();
      status.style.color = '#23d18b';
    }
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.invoke('download-update').catch(() => {});
    } catch (e) {}
  } catch (e) {
    // ignore
  }
}

// Export for use in renderer
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkForUpdates, showUpdateModal };
}
