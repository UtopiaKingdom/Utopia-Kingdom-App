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
    if (result && result.hasUpdate) {
      return {
        hasUpdate: true,
        latestVersion: result.version || '',
        currentVersion,
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
  // No-op: forced update flow does not present a dismissible modal
}

// Export for use in renderer
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkForUpdates, showUpdateModal };
}
