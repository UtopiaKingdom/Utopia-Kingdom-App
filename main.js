const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, powerSaveBlocker } = require('electron');
const { ensureDefaultSounds, playNotificationSound, setNotificationSoundLogger } = require('./notification-sound');
ensureDefaultSounds();
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const poSsidVault = require('./po-ssid-vault');
const signalPip = require('./signal-pip-main');
const desktopToast = require('./desktop-toast-main');
const { resolveEnabledUpdate } = require('./autotrade-enable-guard');
const { createPoDealMonitor } = require('./po-deal-monitor');
const { createPoChainRecovery, recoveryCheck, nextSizeAttempt, shouldHoldForNewBotChain } = require('./po-chain-recovery');
const {
  assertMinLivePayout,
  resolveMinPayoutPct,
  resolveGatePayoutPct
} = require('./po-min-payout-gate');
const { lookupEdgeListPayout } = require('./po-edge-list-payout');
const { createPoDealWatchStore } = require('./po-deal-watch-store');
const { createPoDealResume } = require('./po-deal-resume');
const { resolveLivePlaceDurationSec, resolveTradeDurationSec, snapPoPlaceDuration } = require('./trade-duration');
const {
  isAllowedInstallerUrl,
  isAllowedExternalUrl,
  isAllowedPaymentUrl,
} = require('./ipc-url-guards');
try { require('./home-mover-ipc').registerHomeMoverIpc(); } catch (e) {}
try { signalPip.registerSignalPipIpc(); } catch (e) {}
try { desktopToast.registerDesktopToastIpc(); } catch (e) {}

const APP_USER_MODEL_ID = process.env.UTK_DEV_MODE === '1'
  ? 'com.utkingdom.trading.dev'
  : 'com.utkingdom.trading';

function firstExistingPath(candidates) {
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return null;
}

function venvPythonCandidates(venvRoot) {
  if (!venvRoot) return [];
  if (process.platform === 'win32') {
    return [
      path.join(venvRoot, 'Scripts', 'python.exe'),
      path.join(venvRoot, 'runtime', 'python.exe')
    ];
  }
  return [
    path.join(venvRoot, 'bin', 'python3'),
    path.join(venvRoot, 'bin', 'python'),
    path.join(venvRoot, 'runtime', 'bin', 'python3'),
    path.join(venvRoot, 'runtime', 'bin', 'python')
  ];
}

function venvBinDir(venvRoot) {
  return process.platform === 'win32'
    ? path.join(venvRoot, 'Scripts')
    : path.join(venvRoot, 'bin');
}

function venvRuntimeHome(venvRoot) {
  return path.join(venvRoot, 'runtime');
}

function venvRuntimePython(venvRoot) {
  if (process.platform === 'win32') {
    const p = path.join(venvRoot, 'runtime', 'python.exe');
    return fs.existsSync(p) ? p : null;
  }
  return firstExistingPath([
    path.join(venvRoot, 'runtime', 'bin', 'python3'),
    path.join(venvRoot, 'runtime', 'bin', 'python')
  ]);
}

function venvHomeLooksOk(home) {
  if (!home) return false;
  if (process.platform === 'win32') {
    return fs.existsSync(path.join(home, 'python.exe'));
  }
  return !!(
    firstExistingPath([
      path.join(home, 'bin', 'python3'),
      path.join(home, 'bin', 'python'),
      path.join(home, 'python3'),
      path.join(home, 'python')
    ])
  );
}

function isDevAppRun() {
  if (process.env.UTK_DEV_MODE === '1') return true;
  if (!app.isPackaged) return true;
  try {
    const pkg = path.join(process.cwd(), 'package.json');
    const venvPy = firstExistingPath(venvPythonCandidates(path.join(process.cwd(), '.venv')));
    if (fs.existsSync(pkg) && venvPy) return true;
  } catch (e) {}
  return false;
}

function getProjectRoots() {
  const roots = [];
  const push = (p) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  push(process.cwd());
  push(__dirname);
  try { push(app.getAppPath()); } catch (e) {}
  return roots;
}

function getDevVenvPython() {
  for (const root of getProjectRoots()) {
    const venvPy = firstExistingPath(venvPythonCandidates(path.join(root, '.venv')));
    if (venvPy) return path.resolve(venvPy);
  }
  return null;
}

// Global state for auth and tray
let userIsLoggedIn = false;
let appTray = null;

// One instance only — double-launch during NSIS update is what left people
// with a tray icon and no window (or a long "blank Electron" wait).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try { ensureMainWindowVisible(); } catch (e) {}
  });
}

function appendMainLog(line) {
  try {
    const userData = app && typeof app.getPath === 'function' ? app.getPath('userData') : null;
    if (!userData) return;
    const logsDir = path.join(userData, 'logs');
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
    const logPath = path.join(logsDir, 'main.log');
    fs.appendFileSync(logPath, String(line || '') + '\n');
  } catch {}
}

function mainLog(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => {
      try {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`.trim();
        if (typeof a === 'string') return a;
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  const line = `[${ts}] [${String(level || 'info').toUpperCase()}] ${msg}`;
  appendMainLog(line);
  try {
    const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
    fn(line);
  } catch {}
}

setNotificationSoundLogger((level, message, extra) => {
  if (extra) mainLog(level, message, extra);
  else mainLog(level, message);
});

// main-process error logging
process.on('uncaughtException', err => {
  // Suppress noisy missing app-update.yml errors created by electron-updater when
  // the packaged app does not contain an update metadata file. These cause an
  // uncaught ENOENT on some installs but do not affect runtime update checks.
  try {
    if (err && err.code === 'ENOENT' && String(err.message || '').includes('app-update.yml')) {
      mainLog('warn', '[Main] suppressed missing app-update.yml error:', err.message || err);
      return;
    }
  } catch (e) {}
  mainLog('error', '[Main] uncaughtException', err);
  try { dialog.showErrorBox('Something went wrong', 'Utopia Kingdom hit an unexpected error. Please restart the app.'); } catch {}
});
process.on('unhandledRejection', err => {
  mainLog('error', '[Main] unhandledRejection', err);
});

app.on('gpu-process-crashed', (event, killed) => {
  mainLog('error', '[Main] GPU process crashed, killed=', killed);
  try { dialog.showErrorBox('Display issue', 'The graphics process crashed. Please restart Utopia Kingdom.'); } catch {}
});

if (process.platform === 'win32' && app.setAppUserModelId) {
  try { app.setAppUserModelId(APP_USER_MODEL_ID); } catch (e) { mainLog('warn', '[Main] Failed to set AppUserModelId', e); }
}

try {
  if (typeof app.setName === 'function') app.setName('Utopia Kingdom');
  if (typeof process !== 'undefined') process.title = 'Utopia Kingdom';
  if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
} catch (e) {
  mainLog('warn', '[Main] Failed to set app name', e);
}

function getRendererAssetPath(fileName) {
  if (app.isPackaged && process.resourcesPath) {
    const fromResources = path.join(process.resourcesPath, fileName);
    if (fs.existsSync(fromResources)) return fromResources;
  }
  const local = path.join(__dirname, fileName);
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, fileName);
}

function getWindowsIconPath() {
  const candidates = [];
  const push = (p) => { if (p) candidates.push(p); };

  if (app.isPackaged && process.resourcesPath) {
    push(path.join(process.resourcesPath, 'icon.ico'));
    push(path.join(process.resourcesPath, 'logo.png'));
  }

  push(path.join(__dirname, 'build', 'icon.ico'));
  push(path.join(__dirname, 'logo.png'));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return path.resolve(candidate);
    } catch (e) {}
  }
  return undefined;
}

function getTaskbarIconPath() {
  if (process.platform === 'win32') {
    const winIcon = getWindowsIconPath();
    if (winIcon) return winIcon;
  }
  if (app.isPackaged && process.resourcesPath) {
    const ico = path.join(process.resourcesPath, 'icon.ico');
    if (fs.existsSync(ico)) return ico;
  }
  return path.join(__dirname, 'build', 'icon.ico');
}

function getAppIconPath() {
  if (process.platform === 'win32') {
    const winIcon = getWindowsIconPath();
    if (winIcon) return winIcon;
  }

  const candidates = [];
  const push = (p) => { if (p) candidates.push(p); };

  if (app.isPackaged && process.resourcesPath) {
    push(path.join(process.resourcesPath, 'icon.ico'));
    push(path.join(process.resourcesPath, 'logo.png'));
  }

  const appPath = app.isPackaged ? app.getAppPath() : __dirname;
  push(path.join(appPath, 'build', 'icon.ico'));
  push(path.join(appPath, 'logo.png'));

  if (!app.isPackaged) {
    push(path.join(__dirname, 'build', 'icon.ico'));
    push(path.join(__dirname, 'logo.png'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return path.resolve(candidate);
    } catch (e) {}
  }
  return undefined;
}

function getBrowserWindowIcon() {
  if (process.platform === 'win32') {
    const iconPath = getWindowsIconPath();
    if (iconPath) return iconPath;
  }
  return resolveAppIconImage(256) || undefined;
}

async function patchRendererAssetUrls(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const logoPath = getRendererAssetPath('logo.png');
    if (!fs.existsSync(logoPath)) {
      mainLog('warn', '[Assets] logo.png not found for renderer patch:', logoPath);
      return;
    }
    const { pathToFileURL } = require('url');
    const logoUrl = pathToFileURL(logoPath).href;
    await win.webContents.executeJavaScript(`(function(){
      const u = ${JSON.stringify(logoUrl)};
      document.querySelectorAll('img[src="logo.png"]').forEach(function(img){ img.src = u; });
      var style = document.getElementById('utk-asset-logo-fix');
      if (!style) {
        style = document.createElement('style');
        style.id = 'utk-asset-logo-fix';
        document.head.appendChild(style);
      }
      style.textContent = '.hero-logo-large::after{background-image:url("' + u + '") !important;}';
    })();`);
  } catch (e) {
    mainLog('warn', '[Assets] Failed to patch logo urls:', e.message);
  }
}

function resolveAppIconImage(size) {
  const candidates = [];
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'icon.ico'));
    candidates.push(path.join(process.resourcesPath, 'logo.png'));
  }
  candidates.push(path.join(__dirname, 'build', 'icon.ico'));
  candidates.push(path.join(__dirname, 'logo.png'));

  for (const iconPath of candidates) {
    if (!iconPath || !fs.existsSync(iconPath)) continue;
    try {
      let image = nativeImage.createFromPath(iconPath);
      if (!image || image.isEmpty()) continue;
      if (size && Number.isFinite(size)) {
        const resized = image.resize({ width: size, height: size });
        if (resized && !resized.isEmpty()) image = resized;
      }
      return image;
    } catch (e) {}
  }
  return null;
}

function applyWindowBranding(win) {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'win32') {
    const iconPath = getWindowsIconPath();
    if (iconPath) {
      try { win.setIcon(iconPath); } catch (e) {}
      try { win.setSkipTaskbar(false); } catch (e) {}
      return;
    }
  }
  const icon = resolveAppIconImage(256);
  if (!icon) {
    mainLog('warn', '[Icon] Could not load app icon for window/taskbar');
    return;
  }
  try { win.setIcon(icon); } catch (e) {}
  try { win.setSkipTaskbar(false); } catch (e) {}
}

function loadNativeAppIcon(size) {
  return resolveAppIconImage(size);
}

function ensureWindowVisible(win) {
  if (!win || win.isDestroyed()) {
    try { createWindow(); } catch (e) {}
    return;
  }
  try { win.setSkipTaskbar(false); } catch (e) {}
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  try {
    const wc = win.webContents;
    if (wc && !wc.isDestroyed()) {
      if (typeof wc.isCrashed === 'function' && wc.isCrashed()) {
        wc.reload();
      } else if (typeof wc.getURL === 'function' && !wc.getURL()) {
        win.loadFile('index.html');
      } else {
        try { wc.send('window-state', 'restored'); } catch (e) {}
      }
    }
  } catch (e) {}
}

// Add this import to fix sendVerificationCodeEmail not defined
const { sendVerificationCodeEmail, sendSupportMessage } = require('./email-service');

// Ensure a placeholder app-update.yml exists in packaged resources to avoid
// electron-updater throwing ENOENT on startup when the file is missing.
try {
  if (app && app.isPackaged && !isDevAppRun()) {
    const updateYml = path.join(process.resourcesPath || process.execPath, 'app-update.yml');
    try {
      if (!fs.existsSync(updateYml)) {
        fs.writeFileSync(updateYml, '# autogenerated placeholder to avoid ENOENT\n');
        console.log('[Main] created placeholder', updateYml);
      }
    } catch (e) {
      // ignore write errors
    }
  }
} catch (e) {}

function isInstalledViaInnoSetup() {
  if (process.platform !== 'win32') return false;
  try {
    const markerPath = path.join(path.dirname(process.execPath), 'installer-type.txt');
    if (!fs.existsSync(markerPath)) return false;
    const text = fs.readFileSync(markerPath, 'utf8').toLowerCase();
    return text.includes('inno');
  } catch {
    return false;
  }
}

function updatesEnabled() {
  if (isDevAppRun()) return false;
  // If you ship using Inno Setup (Option B), electron-updater's NSIS flow is not compatible
  // by default we keep updates disabled for Inno-built installs to avoid confusing failures.
  // However, we allow forcing updates via env or enabling updates when a generic update
  // provider URL is configured so the app can download and run an installer itself.
  if (process.env.UTK_ENABLE_UPDATES === '1') return true;
  const provider = (process.env.UTK_UPDATE_PROVIDER || '').toLowerCase().trim();
  const updateUrl = (process.env.UTK_UPDATE_URL || '').trim();
  // Also detect a generic publish URL from package.json build.publish so we
  // can enable the Inno-friendly update flow without requiring env vars.
  try {
    const pkg = require('./package.json');
    const publish = pkg && pkg.build && pkg.build.publish;
    if (publish) {
      if (Array.isArray(publish)) {
        for (const p of publish) {
          try {
            if ((((p && p.provider) || '').toLowerCase() === 'generic') && (p && (p.url || '').trim())) return true;
            if ((((p && p.provider) || '').toLowerCase() === 'github') && p && p.owner && p.repo) return true;
          } catch (e) {}
        }
      } else if (typeof publish === 'object') {
        try {
          if ((((publish && publish.provider) || '').toLowerCase() === 'generic') && (publish && (publish.url || '').trim())) return true;
          if ((((publish && publish.provider) || '').toLowerCase() === 'github') && publish && publish.owner && publish.repo) return true;
        } catch (e) {}
      }
    }
  } catch (e) {}
  // If a generic provider URL is configured, enable updates so the app can download the
  // installer and run it (Inno-friendly fallback).
  if (provider === 'generic' && updateUrl) return true;
  if (isInstalledViaInnoSetup()) return false;
  return true;
}

// Track user auth state from renderer
try { ipcMain.removeHandler('set-user-auth-state'); } catch (e) {}
ipcMain.handle('set-user-auth-state', async (event, { isLoggedIn } = {}) => {
  userIsLoggedIn = isLoggedIn || false;
  mainLog('info', `[Auth] User logged in state updated: ${userIsLoggedIn}`);
  return { success: true };
});

function ensureMainWindowVisible() {
  let win = null;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) win = mainWindow;
  } catch (e) {}
  if (!win) {
    try {
      win = BrowserWindow.getAllWindows().find((w) => {
        if (!w || w.isDestroyed()) return false;
        try {
          if (signalPip.isPipWindow && signalPip.isPipWindow(w)) return false;
        } catch (e) {}
        try {
          if (desktopToast.isToastWindow && desktopToast.isToastWindow(w)) return false;
        } catch (e) {}
        try {
          const url = w.webContents && w.webContents.getURL ? w.webContents.getURL() : '';
          if (/sound-player\.html/i.test(String(url || ''))) return false;
          if (/signal-pip\.html/i.test(String(url || ''))) return false;
          if (/desktop-toast\.html/i.test(String(url || ''))) return false;
          if (/paddle-checkout\.html/i.test(String(url || ''))) return false;
        } catch (e) {}
        return true;
      }) || null;
    } catch (e) {}
  }
  if (!win || win.isDestroyed()) {
    try { createWindow(); } catch (e) {}
    win = mainWindow;
  }
  ensureWindowVisible(win);
  return win;
}

function restoreFromNotificationClick(payload = {}) {
  try {
    const win = ensureMainWindowVisible();
    try {
      if (win && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('notification-clicked', {
          botName: payload.botName || null,
          currency: payload.currency || null,
          side: payload.side || null,
          studioId: payload.studioId || null
        });
      }
    } catch (e) {}
  } catch (e) {
    mainLog('warn', `[Notification] click restore failed: ${e && e.message ? e.message : e}`);
  }
}

try {
  desktopToast.setToastDeps({
    getMainWindow: () => mainWindow,
    getBrowserWindowIcon,
    onToastClick: restoreFromNotificationClick,
  });
} catch (e) {}

function showNativeOsNotification({ notificationTitle, notificationBody, notificationIcon, botName, currency, side, studioId, autoCloseMs }) {
  const notification = new Notification({
    title: notificationTitle,
    body: notificationBody,
    icon: notificationIcon,
    timeoutType: 'default',
    silent: true,
  });
  notification.on('click', () => {
    restoreFromNotificationClick({ botName, currency, side, studioId });
  });
  notification.show();
  const closeMs = Number(autoCloseMs);
  if (Number.isFinite(closeMs) && closeMs > 0) {
    setTimeout(() => {
      try { notification.close(); } catch (e) {}
    }, Math.min(10000, Math.max(800, closeMs)));
  }
}

// Custom desktop toasts (Celestial-style). Falls back to native OS toasts.
try { ipcMain.removeHandler('show-notification'); } catch (e) {}
ipcMain.handle('show-notification', async (event, { title, body, botName, currency, side, playSound, sound, studioId, autoCloseMs, accent, accentRgb } = {}) => {
  try {
    if (!userIsLoggedIn) {
      mainLog('warn', `[Notification] Blocked: User not logged in`);
      return { success: false, error: 'User not logged in' };
    }

    let notificationTitle = title || 'Trading Signal';
    let notificationBody = body || 'New signal received';

    if ((!title && !body) && (botName || currency || side)) {
      notificationTitle = `${botName || 'Bot'} started a trade`;
      const parts = [];
      if (side) parts.push(`${String(side).toUpperCase()}`);
      if (currency) parts.push(`${currency}`);
      notificationBody = parts.length > 0 ? parts.join(' • ') : 'Live signal';
    }

    const notificationIcon = (() => {
      const icoPath = path.join(__dirname, 'build', 'icon.ico');
      const packagedIco = process.resourcesPath ? path.join(process.resourcesPath, 'icon.ico') : null;
      const pngPath = path.join(__dirname, 'logo.png');
      if (fs.existsSync(icoPath)) return icoPath;
      if (packagedIco && fs.existsSync(packagedIco)) return packagedIco;
      if (fs.existsSync(pngPath)) return pngPath;
      return undefined;
    })();

    if (playSound !== false) {
      const preferred = sound === 'chime' ? 'chime' : undefined;
      playNotificationSound(preferred);
    }

    const toastPayload = {
      title: notificationTitle,
      body: notificationBody,
      botName: botName || null,
      currency: currency || null,
      side: side ? String(side).toUpperCase() : null,
      studioId: studioId || null,
      autoCloseMs: autoCloseMs,
      accent: accent || null,
      accentRgb: accentRgb || null,
    };

    try {
      const shown = desktopToast.showToast(toastPayload);
      if (shown && shown.success) {
        mainLog('info', `[Notification] Toast: ${notificationTitle} - ${notificationBody}`);
        return { success: true, style: 'custom' };
      }
    } catch (toastErr) {
      mainLog('warn', `[Notification] Custom toast failed, using Windows toast: ${toastErr && toastErr.message ? toastErr.message : toastErr}`);
    }

    showNativeOsNotification({
      notificationTitle,
      notificationBody,
      notificationIcon,
      botName,
      currency,
      side,
      studioId,
      autoCloseMs,
    });
    mainLog('info', `[Notification] Shown: ${notificationTitle} - ${notificationBody}`);
    return { success: true, style: 'native' };
  } catch (e) {
    mainLog('error', '[Notification] Failed to show notification:', e);
    return { success: false, error: e.message };
  }
});

// Open payment link in a new window and notify renderer when closed
try { ipcMain.removeHandler('open-payment-window'); } catch (e) {}
ipcMain.handle('open-payment-window', async (event, { url } = {}) => {
  if (!url) return { success: false, error: 'Missing url' };
  try {
    if (!isAllowedPaymentUrl(url)) {
      return { success: false, error: 'Payment URL not allowed' };
    }
    let parsed = null;
    try { parsed = new URL(String(url)); } catch (e) { parsed = null; }

    // Paddle checkout is more reliable in the system browser than in an embedded window.
    // This avoids occasional in-app routing failures that show Paddle "Page Not Found".
    const shouldOpenExternal = !!(
      parsed && (
        /(^|\.)buy\.paddle\.com$/i.test(parsed.hostname) ||
        /(^|\.)pay\.paddle\.com$/i.test(parsed.hostname) ||
        /(^|\.)checkout-service\.paddle\.com$/i.test(parsed.hostname) ||
        (/(^|\.)utkingdom\.com$/i.test(parsed.hostname) && /\/paddle\/checkout/i.test(parsed.pathname || '')) ||
        parsed.searchParams.get('_ptxn')
      )
    );

    if (shouldOpenExternal) {
      await shell.openExternal(String(url));
      return { success: true, external: true };
    }

    const paymentWin = new BrowserWindow({
      width: 600,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
      title: 'Complete Payment',
      autoHideMenuBar: true,
      icon: getBrowserWindowIcon(),
    });
    paymentWin.loadURL(url);
    paymentWin.on('closed', () => {
      // Notify renderer process that payment window was closed
      try { event.sender.send('payment-window-closed'); } catch (e) {}
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to open payment window' };
  }
});

// Paddle: build hosted checkout URL (card payments)
// Env:
//   PADDLE_CHECKOUT_URL=https://pay.paddle.io/checkout/hsc_...
//   PADDLE_PRICE_ID=pri_... (works even without PADDLE_CHECKOUT_URL)
try { ipcMain.removeHandler('get-paddle-checkout-url'); } catch (e) {}
ipcMain.handle('get-paddle-checkout-url', async (event, { email, priceId, uid } = {}) => {
  try {
    let cfg = null;
    try {
      const cfgCandidates = [
        path.join(process.cwd(), 'config.json'),
        path.join(__dirname, 'config.json')
      ];
      for (const cfgPath of cfgCandidates) {
        if (fs.existsSync(cfgPath)) {
          cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          break;
        }
      }
    } catch (e) {
      cfg = null;
    }

    const base = String(
      process.env.PADDLE_CHECKOUT_URL ||
      (cfg && (cfg.paddleCheckoutUrl || cfg.PADDLE_CHECKOUT_URL || '')) ||
      ''
    ).trim();

    const resolvedPriceId = String(
      priceId ||
      process.env.PADDLE_PRICE_ID ||
      (cfg && (cfg.paddlePriceId || cfg.PADDLE_PRICE_ID || '')) ||
      'pri_01km1j1mhsbckjb95kxra7qkww'
    ).trim();

    // API key is NEVER required in the shipped app. Prefer Worker secrets.
    // Local/dev only: PADDLE_API_KEY env (not packaged config).
    const resolvedApiKey = String(process.env.PADDLE_API_KEY || '').trim();

    const clientToken = String(
      process.env.PADDLE_CLIENT_TOKEN ||
      (cfg && (cfg.paddleClientToken || cfg.PADDLE_CLIENT_TOKEN || '')) ||
      ''
    ).trim();

    const checkoutApiUrl = String(
      process.env.PADDLE_CHECKOUT_API_URL ||
      (cfg && (cfg.paddleCheckoutApiUrl || cfg.PADDLE_CHECKOUT_API_URL || '')) ||
      'https://utkingdom.com/api/paddle/checkout'
    ).trim();

    const hostedCheckoutBase = String(
      process.env.PADDLE_CHECKOUT_PAGE_URL ||
      (cfg && (cfg.paddleCheckoutPageUrl || cfg.PADDLE_CHECKOUT_PAGE_URL || '')) ||
      'https://utkingdom.com/paddle/checkout'
    ).trim();

    // Support three modes:
    // 1) Hosted Paddle.js checkout on utkingdom.com (Worker holds client token)
    // 2) Price-based checkout via online Worker Transaction API (Worker holds API key)
    // 3) Hosted checkout URL (hsc_...) via PADDLE_CHECKOUT_URL (legacy fallback)
    let u = null;

    // Preferred for every user install: open approved-domain checkout page.
    // Cloudflare Worker injects PADDLE_CLIENT_TOKEN — no secrets in the EXE.
    if (resolvedPriceId && hostedCheckoutBase) {
      const hosted = new URL(hostedCheckoutBase);
      hosted.searchParams.set('priceId', resolvedPriceId);
      const resolvedEmailEarly = (email || '').trim();
      const resolvedUidEarly = (uid || '').trim();
      if (resolvedEmailEarly) hosted.searchParams.set('email', resolvedEmailEarly);
      if (resolvedUidEarly) hosted.searchParams.set('uid', resolvedUidEarly);
      return { success: true, url: hosted.toString() };
    }

    if (resolvedPriceId) {
      // Preferred: create checkout URL via online Worker endpoint (global, no client-side API key).
      let remoteError = '';
      try {
        const remoteResp = await fetch(checkoutApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            priceId: resolvedPriceId,
            email: (email || '').trim() || undefined,
            uid: (uid || '').trim() || undefined
          })
        });

        let remoteJson = null;
        try { remoteJson = await remoteResp.json(); } catch (e) { remoteJson = null; }
        let remoteUrl = remoteJson && remoteJson.url ? String(remoteJson.url).trim() : '';

        if (remoteResp.ok && remoteJson && remoteJson.ok && remoteUrl) {
          u = new URL(remoteUrl);
        } else {
          remoteError = remoteJson && (remoteJson.detail || remoteJson.error) ? String(remoteJson.detail || remoteJson.error) : `Remote checkout API failed (${remoteResp.status})`;
        }
      } catch (e) {
        remoteError = e && e.message ? e.message : 'Remote checkout API unavailable';
      }

      // Fallback for local/dev setups that still use a local API key.
      if (!u && resolvedApiKey) {
      const https = require('https');
      const payloadObj = {
        items: [{ price_id: resolvedPriceId, quantity: 1 }],
        collection_mode: 'automatic',
        custom_data: {
          source: 'utopia-kingdom-app',
          email_hint: (email || '').trim() || null
        }
      };
      const payload = JSON.stringify(payloadObj);

      const opts = {
        hostname: 'api.paddle.com',
        path: '/transactions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resolvedApiKey}`,
          'Content-Type': 'application/json',
          'Paddle-Version': '1',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const apiRes = await new Promise((resolve, reject) => {
        const req = https.request(opts, (resp) => {
          let data = '';
          resp.on('data', (d) => { data += d; });
          resp.on('end', () => resolve({ statusCode: resp.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      let json = null;
      try { json = JSON.parse(apiRes.body || '{}'); } catch (e) { json = null; }

      const checkoutUrl = json && json.data && json.data.checkout && json.data.checkout.url ? String(json.data.checkout.url).trim() : '';
      if (checkoutUrl) {
        u = new URL(checkoutUrl);
      } else if (!remoteError) {
        const errMsg = json && json.error && json.error.detail ? json.error.detail : `Paddle API error (${apiRes.statusCode || 'unknown'})`;
        remoteError = errMsg;
      }
      }

      if (!u) {
        if (clientToken) {
          return {
            success: true,
            mode: 'client',
            clientToken,
            priceId: resolvedPriceId,
            email: (email || '').trim() || null
          };
        }
        return {
          success: false,
          error: remoteError || 'Could not create Paddle checkout URL'
        };
      }
    }

    if (!u && base) {
      u = new URL(base);
    }

    if (!u) {
      if (resolvedPriceId) {
        return { success: false, error: remoteError || 'Could not create Paddle checkout URL' };
      }
      return { success: false, error: 'Missing PADDLE_PRICE_ID or PADDLE_CLIENT_TOKEN' };
    }

    const resolvedEmail = (email || '').trim();
    const hasPtxnToken = !!u.searchParams.get('_ptxn');
    const isBuyPaddleCheckout = /(^|\.)buy\.paddle\.com$/i.test(u.hostname) && /\/checkout/i.test(u.pathname || '');

    // Do not alter transaction-token checkout URLs; Paddle resolves these server-side.
    if (!hasPtxnToken && !isBuyPaddleCheckout) {
      if (resolvedEmail) u.searchParams.set('user_email', resolvedEmail);
      if (resolvedPriceId) u.searchParams.set('price_id', resolvedPriceId);
    }

    try { console.log('[PADDLE] checkout_url', u.toString()); } catch (e) {}

    return { success: true, url: u.toString() };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : 'Failed to build checkout url' };
  }
});

try { ipcMain.removeHandler('open-paddle-client-checkout'); } catch (e) {}
ipcMain.handle('open-paddle-client-checkout', async (event, { email, priceId, clientToken } = {}) => {
  try {
    let cfg = null;
    try {
      const cfgCandidates = [
        path.join(process.cwd(), 'config.json'),
        path.join(__dirname, 'config.json')
      ];
      for (const cfgPath of cfgCandidates) {
        if (fs.existsSync(cfgPath)) {
          cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
          break;
        }
      }
    } catch (err) {
      cfg = null;
    }

    const resolvedToken = String(
      clientToken ||
      process.env.PADDLE_CLIENT_TOKEN ||
      (cfg && (cfg.paddleClientToken || cfg.PADDLE_CLIENT_TOKEN || '')) ||
      ''
    ).trim();

    const resolvedPriceId = String(
      priceId ||
      process.env.PADDLE_PRICE_ID ||
      (cfg && (cfg.paddlePriceId || cfg.PADDLE_PRICE_ID || '')) ||
      ''
    ).trim();

    if (!resolvedToken || !resolvedPriceId) {
      return { success: false, error: 'Missing PADDLE_CLIENT_TOKEN or PADDLE_PRICE_ID' };
    }

    const checkoutPath = path.join(__dirname, 'paddle-checkout.html');
    if (!fs.existsSync(checkoutPath)) {
      return { success: false, error: 'paddle-checkout.html not found' };
    }

    const paymentWin = new BrowserWindow({
      width: 720,
      height: 860,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
      title: 'Complete Payment',
      autoHideMenuBar: true,
      icon: getBrowserWindowIcon(),
    });

    await paymentWin.loadFile(checkoutPath, {
      query: {
        token: resolvedToken,
        priceId: resolvedPriceId,
        email: String(email || '').trim()
      }
    });

    paymentWin.on('closed', () => {
      try { event.sender.send('payment-window-closed'); } catch (err) {}
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : 'Failed to open Paddle checkout' };
  }
});

// TLS behavior
// Default is SECURE. To allow insecure TLS (NOT recommended), launch with:
//   `Utopia Kingdom.exe --insecure-tls`
// or set env var:
//   `UTK_INSECURE_TLS=1`
const INSECURE_TLS = process.argv.includes('--insecure-tls') || process.env.UTK_INSECURE_TLS === '1';

// Configure agents for main process
const https = require('https');
const http = require('http');
const WebSocket = require('ws');

if (INSECURE_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2'
  });
  https.globalAgent = httpsAgent;
}

const httpAgent = new http.Agent({ keepAlive: true });
http.globalAgent = httpAgent;

// IPC handler to send verification code email
ipcMain.handle('send-verification-code', async (event, { email, code }) => {
  try {
    const result = await sendVerificationCodeEmail(email, code);
    return { success: true, ...result };
  } catch (err) {
    // console.error('Failed to send verification email:', err);
    return { success: false, error: err.message };
  }
});

// IPC: home support / problem messages → utopiakingdomreal@gmail.com
ipcMain.handle('send-support-message', async (event, payload = {}) => {
  try {
    const result = await sendSupportMessage(payload);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

// Enable remote module
try {
  require('@electron/remote/main').initialize();
} catch (err) {
  // console.log('Remote module not available, using fallback');
}

// Enable GPU acceleration for smooth rendering unless explicitly disabled
// (some drivers can hang, causing a black window).
if (process.env.UTK_DISABLE_HWACCEL !== '1') {
  try { app.enableHardwareAcceleration(); } catch {}
  try {
    // Prefer GPU compositing / raster on Windows for snappier resize + scrolling.
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
    app.commandLine.appendSwitch('enable-smooth-scrolling');
    app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
  } catch {}
} else {
  try { app.disableHardwareAcceleration(); } catch {}
}

// Set high-DPI awareness for 4K displays
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('high-dpi-support', 'true');
  // Do not force device scale factor to 1 — let the OS handle DPI scaling
}

// Use a separate userData path in development to avoid cache issues
try {
  if (!app.isPackaged) {
    const devUserData = path.join(app.getPath('appData'), 'UtopiaKingdom-Dev');
    app.setPath('userData', devUserData);
  }
} catch {}

// Auto-updater configuration
autoUpdater.autoDownload = true;
// Only install when the user clicks Restart (auto-on-quit often leaves no relaunch).
autoUpdater.autoInstallOnAppQuit = false;
// NSIS runAfterFinish starts the app after files are in place. --force-run
// starts too early and can show the blank Electron shell for minutes.
try { autoUpdater.autoRunAppAfterInstall = true; } catch (e) {}
try { autoUpdater.disableWebInstaller = true; } catch (e) {}

let _installUpdateInFlight = false;
let _downloadedInstallerPath = null;
let _updateReadyToInstall = false;

function stopBackgroundProcessesForUpdate() {
  try { signalPip.closeAllPipWindows(); } catch (e) {}
  try { poTradeWorker.stop(); } catch (e) {}
  try {
    if (autotradePowerSaveId != null) {
      try { powerSaveBlocker.stop(autotradePowerSaveId); } catch (e) {}
      autotradePowerSaveId = null;
    }
  } catch (e) {}
  try {
    if (signalHubWs) {
      try { signalHubWs.removeAllListeners(); } catch (e) {}
      try { signalHubWs.close(); } catch (e) {}
      signalHubWs = null;
    }
  } catch (e) {}
  // Only unlock THIS app's bundled python — never taskkill every python.exe on the PC.
  try {
    if (process.platform === 'win32' && process.resourcesPath) {
      const { spawnSync } = require('child_process');
      const root = String(process.resourcesPath).replace(/'/g, "''");
      const ps =
        `$root = '${root}';` +
        `Get-Process python*,pythonw* -ErrorAction SilentlyContinue | ForEach-Object {` +
        `  try {` +
        `    $p = $_.Path;` +
        `    if ($p -and ($p.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase))) {` +
        `      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue` +
        `    }` +
        `  } catch {}` +
        `}`;
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        windowsHide: true,
        timeout: 2500,
        stdio: 'ignore'
      });
    }
  } catch (e) {}
}

/**
 * Safety-net relaunch after silent NSIS update.
 *
 * Important: never scan Win32_Process CommandLine for the setup filename —
 * the watchdog PowerShell itself embeds that string and looked "still installing"
 * for the full ~120s deadline (blank desktop, then late reopen).
 */
function schedulePostUpdateRelaunchWatchdog(installerPath) {
  if (process.platform !== 'win32') return;
  try {
    const exePath = process.execPath;
    const targetPid = process.pid;
    const exeEscaped = String(exePath).replace(/'/g, "''");
    const workDirEscaped = String(path.dirname(exePath)).replace(/'/g, "''");
    const setupBase = installerPath ? path.basename(installerPath) : '';
    const setupBaseEscaped = String(setupBase).replace(/'/g, "''");
    // Strip extension for Get-Process Name match (NSIS setup process name).
    const setupProcName = setupBase ? path.basename(setupBase, path.extname(setupBase)) : '';
    const setupProcEscaped = String(setupProcName).replace(/'/g, "''");

    const ps = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$selfPid = $PID`,
      `$targetPid = ${targetPid}`,
      `$exe = '${exeEscaped}'`,
      `$workDir = '${workDirEscaped}'`,
      `$setupProc = '${setupProcEscaped}'`,
      `$deadline = (Get-Date).AddSeconds(55)`,
      // 1) Wait for the old Utopia process to exit (fast PID check).
      `while (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {`,
      `  if ((Get-Date) -gt $deadline) { break }`,
      `  Start-Sleep -Milliseconds 150`,
      `}`,
      // 2) Wait for installer by process NAME only (never scan CommandLine —
      //    this PowerShell script embeds the setup filename and would match itself).
      `while ((Get-Date) -lt $deadline) {`,
      `  $setup = Get-Process -ErrorAction SilentlyContinue | Where-Object {`,
      `    $_.Id -ne $selfPid -and (`,
      `      ($setupProc -and ($_.ProcessName -eq $setupProc)) -or`,
      `      ($_.ProcessName -like 'Utopia*Setup*') -or`,
      `      ($_.ProcessName -like '*Kingdom-Setup*')`,
      `    )`,
      `  }`,
      `  if (-not $setup) { break }`,
      `  Start-Sleep -Milliseconds 200`,
      `}`,
      // 3) Brief grace for NSIS --force-run / runAfterFinish to open the app.
      `$graceUntil = (Get-Date).AddSeconds(6)`,
      `while ((Get-Date) -lt $graceUntil -and (Get-Date) -lt $deadline) {`,
      `  $alive = Get-Process -ErrorAction SilentlyContinue | Where-Object {`,
      `    $_.Id -ne $targetPid -and $_.Id -ne $selfPid -and $_.Path -and ($_.Path -ieq $exe)`,
      `  }`,
      `  if ($alive) { exit 0 }`,
      `  Start-Sleep -Milliseconds 200`,
      `}`,
      // 4) Only then start the app ourselves.
      `$alive2 = Get-Process -ErrorAction SilentlyContinue | Where-Object {`,
      `  $_.Id -ne $targetPid -and $_.Id -ne $selfPid -and $_.Path -and ($_.Path -ieq $exe)`,
      `}`,
      `if ($alive2) { exit 0 }`,
      `if (Test-Path -LiteralPath $exe) {`,
      `  Start-Process -FilePath $exe -WorkingDirectory $workDir -ArgumentList '--updated'`,
      `}`,
    ].join('\r\n');

    const { spawn } = require('child_process');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: app.getPath('temp')
      }
    );
    child.unref();
    mainLog('info', `[Updater] Relaunch watchdog armed for pid=${targetPid} setup=${setupBase || 'unknown'}`);
  } catch (e) {
    mainLog('warn', `[Updater] Could not arm relaunch watchdog: ${e && e.message ? e.message : e}`);
  }
}

function destroyTrayForUpdate() {
  try {
    if (appTray) {
      try { appTray.destroy(); } catch (e) {}
      appTray = null;
    }
  } catch (e) {}
}

function installDownloadedUpdate() {
  if (_installUpdateInFlight) return false;
  if (!_updateReadyToInstall && !_downloadedInstallerPath) {
    mainLog('warn', '[Updater] Install ignored — update not downloaded yet');
    return false;
  }
  _installUpdateInFlight = true;
  global.__utkInstallingUpdate = true;
  mainLog('info', '[Updater] Preparing silent quitAndInstall…');

  try { stopBackgroundProcessesForUpdate(); } catch (e) {}
  try { destroyTrayForUpdate(); } catch (e) {}
  const installerPath = _downloadedInstallerPath
    || (autoUpdater.downloadedUpdateHelper && autoUpdater.downloadedUpdateHelper.file)
    || null;
  try { schedulePostUpdateRelaunchWatchdog(installerPath); } catch (e) {}

  try {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.removeAllListeners('close'); } catch (e) {}
      // Destroy (don't just hide) so Windows doesn't leave a blank shell frame.
      try { win.destroy(); } catch (e) {
        try { win.hide(); } catch (e2) {}
      }
    }
  } catch (e) {}

  // Silent + --force-run: NSIS starts the app after files are written.
  // Watchdog is only a fast safety net if --force-run did not.
  setTimeout(() => {
    try {
      try { autoUpdater.autoRunAppAfterInstall = true; } catch (e) {}

      let started = false;
      try {
        autoUpdater.quitAndInstall(true, true);
        started = true;
      } catch (e) {
        mainLog('error', `[Updater] quitAndInstall failed: ${e && e.message ? e.message : e}`);
      }

      if (!started) {
        if (installerPath && fs.existsSync(installerPath)) {
          mainLog('info', `[Updater] Spawning installer fallback: ${installerPath}`);
          const { spawn } = require('child_process');
          spawn(installerPath, ['--updated', '/S', '--force-run'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }).unref();
          setTimeout(() => {
            try { app.exit(0); } catch (e) {}
          }, 150);
          return;
        }
        _installUpdateInFlight = false;
        global.__utkInstallingUpdate = false;
        sendUpdateEvent('update-error', { message: 'Could not start the installer. Please download from utkingdom.com.' });
      }
    } catch (e) {
      _installUpdateInFlight = false;
      global.__utkInstallingUpdate = false;
      mainLog('error', `[Updater] installDownloadedUpdate fatal: ${e && e.message ? e.message : e}`);
      try { sendUpdateEvent('update-error', { message: e && e.message ? e.message : 'Install failed' }); } catch (e2) {}
    }
  }, 40);
  return true;
}
// Feed configuration is provided by electron-builder via app-update.yml.
// Optionally override via env vars (useful when switching from generic hosting to GitHub Releases).
function configureAutoUpdaterFeed() {
  if (isDevAppRun()) return;
  if (!app.isPackaged) return;
  if (!updatesEnabled()) return;

  const provider = (process.env.UTK_UPDATE_PROVIDER || '').toLowerCase().trim();
  const updateUrl = (process.env.UTK_UPDATE_URL || '').trim();
  const ghOwner = (process.env.UTK_GITHUB_OWNER || '').trim();
  const ghRepo = (process.env.UTK_GITHUB_REPO || '').trim();
  const ghToken = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();

  try {
    if (provider === 'github' || (ghOwner && ghRepo)) {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: ghOwner,
        repo: ghRepo,
        token: ghToken || undefined,
      });
      return;
    }
    if (provider === 'generic' && updateUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });
      return;
    }
  } catch {
    // If setFeedURL fails, fall back to app-update.yml.
  }
}

function looksLikeWindowsPe(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf[0] === 0x4d && buf[1] === 0x5a; // MZ
  } catch (_) {
    return false;
  }
}

function normalizeInstallerUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    if (/^https?:\/\//i.test(s)) return s;
    // electron-updater sometimes returns a bare filename / relative path
    const base = 'https://utkingdom.com/updates/';
    return new URL(s.replace(/^\//, ''), base).toString();
  } catch (_) {
    return '';
  }
}

// Helper: download an allowlisted HTTPS installer URL to a temp file
async function downloadToTemp(url, filename, redirectLeft = 5) {
  const pinned = normalizeInstallerUrl(url);
  if (!isAllowedInstallerUrl(pinned)) {
    throw new Error('Installer URL not allowed');
  }
  const os = require('os');
  const dest = path.join(os.tmpdir(), filename || `utk-installer-${Date.now()}.exe`);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { file.close(() => fs.unlink(dest, () => {})); } catch (e) {}
      reject(err);
    };
    try {
      const req = https.get(pinned, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          try { file.close(() => fs.unlink(dest, () => {})); } catch (e) {}
          if (redirectLeft <= 0) return fail(new Error('Too many redirects'));
          let next = String(res.headers.location || '');
          try { next = new URL(next, pinned).toString(); } catch (e) {}
          return downloadToTemp(next, filename, redirectLeft - 1).then(resolve, fail);
        }
        if (code !== 200) {
          return fail(new Error('Download failed: ' + code));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            if (!looksLikeWindowsPe(dest)) {
              try { fs.unlinkSync(dest); } catch (e) {}
              return fail(new Error('Downloaded file is not a Windows installer'));
            }
            settled = true;
            resolve(dest);
          });
        });
      });
      req.on('error', fail);
    } catch (err) {
      fail(err);
    }
  });
}

// IPC: download a pinned installer and run it (Inno-friendly flow)
try { ipcMain.removeHandler('download-and-install-installer'); } catch (e) {}
ipcMain.handle('download-and-install-installer', async (event, { url } = {}) => {
  if (!url) return { success: false, error: 'Missing download URL' };
  const pinned = normalizeInstallerUrl(url);
  if (!isAllowedInstallerUrl(pinned)) {
    return { success: false, error: 'Installer URL not allowed' };
  }
  try {
    const tmp = await downloadToTemp(pinned, 'utk-installer.exe');
    const { spawn } = require('child_process');
    // Inno silent flags: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART
    spawn(tmp, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

function sendUpdateEvent(channel, payload) {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send(channel, payload);
  } catch {}
}

// When an update is available, download automatically (no prompt)
autoUpdater.on('update-available', (info) => {
  // console.log('Update available:', info?.version || 'unknown');
  sendUpdateEvent('update-available', { version: info?.version || '' });
  // autoUpdater.autoDownload=true already triggers the download internally.
  // Keep a defensive call in case config differs, but only invoke
  // downloadUpdate if updateInfoAndProvider is present to avoid
  // electron-updater "Please check" errors when provider info is missing.
  try {
    if (autoUpdater.updateInfoAndProvider) {
      autoUpdater.downloadUpdate();
    }
  } catch (e) { /* silent */ }
});

autoUpdater.on('download-progress', (progress) => {
  // progress: { percent, transferred, total, bytesPerSecond }
  sendUpdateEvent('update-download-progress', progress || {});
});

autoUpdater.on('update-not-available', (info) => {
  sendUpdateEvent('update-not-available', { version: info?.version || '' });
});

// After download, notify renderer. Closing/quitting with a ready update
// installs + relaunches so users never reopen into a half-old build.
autoUpdater.on('update-downloaded', (info) => {
  try {
    _downloadedInstallerPath = (autoUpdater.downloadedUpdateHelper && autoUpdater.downloadedUpdateHelper.file) || null;
  } catch (e) {
    _downloadedInstallerPath = null;
  }
  _updateReadyToInstall = true;
  try { autoUpdater.autoInstallOnAppQuit = true; } catch (e2) {}
  sendUpdateEvent('update-downloaded', { version: info?.version || '' });
});

autoUpdater.on('error', (err) => {
  // console.error('[autoUpdater] error:', err);
  const msg = (err && err.message) ? err.message : String(err || 'Update error');
  // If the updater failed due to a null provider access inside electron-updater,
  // attempt the worker fallback to determine latest release rather than surfacing
  // a confusing raw exception to the user.
  if (/reading 'provider'|Cannot read properties of null \(reading 'provider'\)/i.test(msg)) {
    // Try the same fallback used by manual checks
    (async () => {
      try {
        const https = require('https');
        const fallbackUrl = 'https://utopia-kingdom.escapesvk.workers.dev/updates/latest';
        let data = '';
        await new Promise((resolve, reject) => {
          const req = https.get(fallbackUrl, (res) => {
            if (res.statusCode && res.statusCode >= 400) return reject(new Error('Update server responded ' + res.statusCode));
            res.setEncoding('utf8');
            res.on('data', (c) => data += c);
            res.on('end', resolve);
          });
          req.on('error', reject);
        });
        const mVer = data.match(/^version:\s*(.+)$/m);
        const latestVersion = mVer ? (mVer[1] || '').trim() : '';
        if (latestVersion && isVersionNewer(latestVersion, app.getVersion())) {
          sendUpdateEvent('update-available', { version: latestVersion, fallback: true });
          return;
        }
      } catch (e) {
        // ignore fallback errors
      }
    })();
    // still send a sanitized update-error event
    sendUpdateEvent('update-error', { message: 'Update check failed (fallback attempted).' });
    return;
  }

  sendUpdateEvent('update-error', { message: msg });
});

// Create tray icon and menu
function createTray(mainWindow) {
  try {
    let trayIcon = resolveAppIconImage(16);
    if (!trayIcon || trayIcon.isEmpty()) {
      const winPath = getWindowsIconPath();
      if (winPath && fs.existsSync(winPath)) {
        try {
          trayIcon = nativeImage.createFromPath(winPath);
          if (trayIcon && !trayIcon.isEmpty()) {
            const resized = trayIcon.resize({ width: 16, height: 16 });
            if (resized && !resized.isEmpty()) trayIcon = resized;
          }
        } catch (e) {}
      }
    }
    // Never attach an empty image — Windows tray can fail silently / look broken.
    if (!trayIcon || trayIcon.isEmpty()) {
      trayIcon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVQ4T2NkYGD4z0ABYBw1gGE0DAB9yQMRXQn0YQAAAABJRU5ErkJggg=='
      );
    }

    appTray = new Tray(trayIcon);

    const trayMenu = Menu.buildFromTemplate([
      {
        label: 'Open Utopia Kingdom',
        click: () => {
          ensureWindowVisible(mainWindow);
        }
      },
      {
        label: 'Minimize to Tray',
        click: () => {
          if (!mainWindow) return;
          try { mainWindow.setSkipTaskbar(true); } catch (e) {}
          mainWindow.hide();
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        }
      }
    ]);
    appTray.setContextMenu(trayMenu);
    appTray.setToolTip('Utopia Kingdom');
    
    // Clicking tray icon restores window
    appTray.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isVisible()) {
        try { mainWindow.setSkipTaskbar(true); } catch (e) {}
        mainWindow.hide();
      } else {
        ensureWindowVisible(mainWindow);
      }
    });
    
    mainLog('info', '[Tray] Tray icon created');
  } catch (e) {
    mainLog('error', '[Tray] Failed to create tray:', e);
  }
}

function getWindowRefreshRateHz(win) {
  try {
    const { screen } = require('electron');
    if (!win || win.isDestroyed()) {
      const primary = screen.getPrimaryDisplay();
      return Math.max(30, Math.min(60, Math.round(primary.refreshRate || 60)));
    }
    const display = screen.getDisplayMatching(win.getBounds());
    return Math.max(30, Math.min(60, Math.round(display.refreshRate || 60)));
  } catch (e) {
    return 60;
  }
}

function applyWindowFrameRate(win) {
  if (!win || win.isDestroyed()) return 60;
  const PERF_MODE = process.env.UTK_PERFORMANCE_MODE === '1' || process.env.UTK_LOW_GRAPHICS === '1';
  let hz = PERF_MODE ? 30 : getWindowRefreshRateHz(win);
  try {
    // When minimized / hidden, drop compositor work — timers/WS stay alive
    // because backgroundThrottling stays false for autotrade.
    if (!PERF_MODE && (win.isMinimized() || !win.isVisible())) {
      hz = Math.min(hz, 30);
    }
  } catch (e) {}
  try {
    if (typeof win.webContents.setFrameRate === 'function') {
      win.webContents.setFrameRate(hz);
    }
    win.webContents.send('display-config', { refreshRate: hz });
  } catch (e) {}
  return hz;
}

function createWindow () {
  // allow disabling transparency when running in performance-critical mode
  const PERF_MODE = process.env.UTK_PERFORMANCE_MODE === '1';
  const win = new BrowserWindow({
    // start at 80% of the original 1280x720 baseline (1024x576)
    width: 1024,
    height: 576,
    resizable: true,
    frame: false,
    // Hide until first paint + scale are ready — no visible resize flash
    show: false,
    // On Windows a transparent, frameless window commonly prevents
    // native edge/corner resizing in newer Electron versions. Prefer
    // a non-transparent window on Windows to preserve resize behavior.
    transparent: (process.platform === 'win32') ? false : !PERF_MODE,
    backgroundColor: '#050508',
    title: 'Utopia Kingdom',
    icon: getBrowserWindowIcon(),

    enableLargerThanScreen: true,
    // On Windows a frameless window can become non-resizable; enable a
    // thick frame which keeps the frameless look but restores resizing.
    thickFrame: process.platform === 'win32',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      // GPU acceleration settings
      enableRemoteModule: true,
      offscreen: false,
      sandbox: false,
      // Keep timers/WS responsive when minimized — required for SSID autotrade
      backgroundThrottling: false,
      v8CacheOptions: 'bypassHeatCheck'
    }
  });
  try { win.webContents.setBackgroundThrottling(false); } catch (e) {}
  applyWindowBranding(win);

  const display = require('electron').screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor;
  applyWindowFrameRate(win);

  try {
    const { screen } = require('electron');
    screen.on('display-metrics-changed', () => {
      try { applyWindowFrameRate(win); } catch (e) {}
    });
  } catch (e) {}

  win.loadFile('index.html');
  mainWindow = win;
  try {
    signalPip.setPipDeps({
      getMainWindow: () => mainWindow,
      getBrowserWindowIcon,
    });
  } catch (e) {}
  try {
    desktopToast.setToastDeps({
      getMainWindow: () => mainWindow,
      getBrowserWindowIcon,
      onToastClick: restoreFromNotificationClick,
    });
  } catch (e) {}

  // --- Security: lock navigation / permissions on the main shell ---
  try {
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (isAllowedExternalUrl(url)) {
          shell.openExternal(String(url)).catch(() => {});
        }
      } catch (_) {}
      return { action: 'deny' };
    });
  } catch (e) {}
  try {
    win.webContents.on('will-navigate', (event, url) => {
      try {
        const target = String(url || '');
        // Allow only the local app shell (file:// index) — block injected remote nav.
        if (target.startsWith('file:') && target.includes('index.html')) return;
        if (target.startsWith('file:') && /paddle-checkout\.html/i.test(target)) return;
        event.preventDefault();
        if (isAllowedExternalUrl(target)) {
          shell.openExternal(target).catch(() => {});
        }
      } catch (_) {
        try { event.preventDefault(); } catch (__) {}
      }
    });
  } catch (e) {}
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      try { callback(false); } catch (_) {}
    });
  } catch (e) {}
  try {
    win.webContents.on('will-attach-webview', (event) => {
      try { event.preventDefault(); } catch (_) {}
    });
  } catch (e) {}

  const launchedAfterUpdate = process.argv.some((a) => String(a || '').toLowerCase() === '--updated');
  const forceShowAfterUpdate = () => {
    try {
      ensureWindowVisible(win);
      try { win.moveTop(); } catch (e) {}
      try { win.setAlwaysOnTop(true); } catch (e) {}
      setTimeout(() => {
        try { if (!win.isDestroyed()) win.setAlwaysOnTop(false); } catch (e) {}
      }, 800);
    } catch (e) {}
  };

  win.once('ready-to-show', () => {
    applyWindowBranding(win);
    if (process.platform === 'win32') {
      mainLog('info', '[Icon] Windows taskbar icon:', getWindowsIconPath(), 'execPath=', process.execPath);
    }
    try {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    } catch (e) {}
    if (launchedAfterUpdate) forceShowAfterUpdate();
  });

  // Safety: never leave the window invisible if ready-to-show is missed
  setTimeout(() => {
    try {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    } catch (e) {}
  }, 2500);

  win.webContents.on('did-finish-load', () => {
    try { applyWindowFrameRate(win); } catch (e) {}
    applyWindowBranding(win);
    patchRendererAssetUrls(win).catch(() => {});
    if (launchedAfterUpdate) {
      forceShowAfterUpdate();
      setTimeout(forceShowAfterUpdate, 600);
      setTimeout(forceShowAfterUpdate, 1800);
    }
  });
  
  // Create tray icon and menu
  createTray(win);
  
  // Block DevTools keyboard shortcuts and page reload
  win.webContents.on('before-input-event', (event, input) => {
    // Block F12
    if (input.key === 'F12') {
      event.preventDefault();
    }
    // Block Ctrl+Shift+I (DevTools)
    if (input.control && input.shift && input.key && input.key.toLowerCase() === 'i') {
      event.preventDefault();
    }
    // Block Ctrl+Shift+C (Inspect Element)
    if (input.control && input.shift && input.key && input.key.toLowerCase() === 'c') {
      event.preventDefault();
    }
    // Block Ctrl+Shift+J (Console)
    if (input.control && input.shift && input.key && input.key.toLowerCase() === 'j') {
      event.preventDefault();
    }
    // Block F5 and Ctrl+R (Refresh)
    if (input.key === 'F5' || (input.control && input.key && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
    }
  });
  
  startSignalHubWs();
  
  // Enable remote for this window
  try {
    require('@electron/remote/main').enable(win.webContents);
  } catch {}
  
  // TEMPORARY: Disable auto-close DevTools for debugging
  // win.webContents.on('devtools-opened', () => {
  //   try { win.webContents.closeDevTools(); } catch {}
  // });
  
  // Disable right-click context menu to prevent "Inspect Element"
  win.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });

  // Check for updates after window loads (in-app UI only — no OS toast).
  win.webContents.on('did-finish-load', () => {
    if (updatesEnabled()) {
      configureAutoUpdaterFeed();
      // Delay initial check slightly to avoid blocking startup/network bursts.
      try {
        setTimeout(() => {
          try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) {}
        }, 1000);
      } catch (e) {}
      // Periodic background checks (every 4 hours)
      try {
        setInterval(() => {
          try { autoUpdater.checkForUpdates().catch(() => {}); } catch (e) {}
        }, 1000 * 60 * 60 * 4);
      } catch (e) {}
    }
    try {
      // Do not open DevTools in packaged builds unless explicitly enabled
      if (!app.isPackaged || process.env.UTK_DEVTOOLS === '1') {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    } catch (e) {}
  });

  // Broadcast window state changes to renderer for smooth transitions
  win.on('maximize', () => {
    try { win.webContents.send('prepare-resize'); } catch {}
    try { win.webContents.send('window-state', 'maximized'); } catch {}
    try { applyWindowFrameRate(win); } catch {}
  });
  win.on('unmaximize', () => {
    try { win.webContents.send('prepare-resize'); } catch {}
    try { win.webContents.send('window-state', 'normal'); } catch {}
    try { applyWindowFrameRate(win); } catch {}
  });
  win.on('minimize', () => {
    try { win.webContents.send('window-state', 'minimized'); } catch {}
    try { applyWindowFrameRate(win); } catch {}
  });
  win.on('restore', () => {
    try { win.webContents.send('prepare-resize'); } catch {}
    try { win.webContents.send('window-state', 'restored'); } catch {}
    try { applyWindowFrameRate(win); } catch {}
  });
  win.on('enter-full-screen', () => {
    try { win.webContents.send('prepare-resize'); } catch {}
    try { win.webContents.send('window-state', 'fullscreen-enter'); } catch {}
  });
  win.on('leave-full-screen', () => {
    try { win.webContents.send('prepare-resize'); } catch {}
    try { win.webContents.send('window-state', 'fullscreen-leave'); } catch {}
  });
  try {
    win.on('will-resize', () => {
      try { win.webContents.send('prepare-resize'); } catch {}
    });
    win.on('will-move', () => {
      try { win.webContents.send('prepare-resize'); } catch {}
    });
  } catch (e) {}
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  await initSsidVault();
  createWindow();
});

// Restore window from tray click
try { ipcMain.removeHandler('restore-window-from-tray'); } catch (e) {}
ipcMain.handle('restore-window-from-tray', async () => {
  try { ensureMainWindowVisible(); } catch (e) {}
  return { success: true };
});

app.on('window-all-closed', () => {
  // PiP mini windows closing must never quit Utopia Kingdom while the main
  // window still exists (including when it is hidden to tray).
  try {
    if (mainWindow && !mainWindow.isDestroyed()) return;
  } catch (e) {}
  const stillOpen = BrowserWindow.getAllWindows().some((w) => {
    try {
      return w && !w.isDestroyed()
        && !signalPip.isPipWindow(w)
        && !(desktopToast.isToastWindow && desktopToast.isToastWindow(w));
    } catch (e) {
      return false;
    }
  });
  if (stillOpen) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (e) => {
  // During update install: quit immediately — never delay for session-lock.
  if (_installUpdateInFlight || global.__utkInstallingUpdate) {
    try { disableAllAutotradeOnQuit('update-install'); } catch (err) {}
    try { signalPip.closeAllPipWindows(); } catch (err) {}
    try { desktopToast.closeAllToasts(); } catch (err) {}
    try { destroyTrayForUpdate(); } catch (err) {}
    return;
  }

  try { disableAllAutotradeOnQuit('app-quit'); } catch (err) {}
  try { signalPip.closeAllPipWindows(); } catch (err) {}
  try { desktopToast.closeAllToasts(); } catch (err) {}

  // Ask renderer to clear the single-session lock so phone can log in after PC closes
  if (global.__utkSessionLockReleased) return;
  const wins = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed());
  if (!wins.length) {
    global.__utkSessionLockReleased = true;
    return;
  }
  e.preventDefault();
  global.__utkSessionLockReleased = true;
  let finished = false;
  const finishQuit = () => {
    if (finished) return;
    finished = true;
    try { ipcMain.removeListener('session-lock-released', onReleased); } catch (err) {}
    app.quit();
  };
  const onReleased = () => finishQuit();
  try { ipcMain.once('session-lock-released', onReleased); } catch (err) {}
  for (const win of wins) {
    try { win.webContents.send('release-session-lock'); } catch (err) {}
  }
  setTimeout(finishQuit, 1200);
});

app.on('will-quit', () => {
  try { flushConnectedSsidsToVault().catch(() => {}); } catch (e) {}
  try { signalPip.closeAllPipWindows(); } catch (e) {}
  try { desktopToast.closeAllToasts(); } catch (e) {}
  try { stopBackgroundProcessesForUpdate(); } catch (e) {}
});

// --- WINDOW CONTROL IPC HANDLERS ---
ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    try { win.webContents.send('prepare-minimize'); } catch {}
    setTimeout(() => {
      win.minimize();
    }, 180);
  }
});
ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    // Optionally allow a small delay for renderer to cue visual smoothing
    try { win.webContents.send('prepare-resize'); } catch {}
    setTimeout(() => {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }, 120);
  }
});
ipcMain.on('window-hide', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    try { win.webContents.send('prepare-minimize'); } catch {}
    setTimeout(() => {
      try { win.setSkipTaskbar(true); } catch (e) {}
      win.hide();
      mainLog('info', '[Window] Hidden to tray');
    }, 120);
  }
});
ipcMain.on('window-quit', (event) => {
  // Quit only — never auto-install. User must tap Refresh for updates.
  try { disableAllAutotradeOnQuit('window-quit'); } catch (e) {}
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    try { win.webContents.send('prepare-close'); } catch {}
    setTimeout(() => { app.quit(); }, 250);
  } else {
    app.quit();
  }
});
ipcMain.on('window-close', (event) => {
  // X hides to tray. Do not install updates here.
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    try { win.webContents.send('prepare-minimize'); } catch {}
    setTimeout(() => {
      try { win.setSkipTaskbar(true); } catch (e) {}
      win.hide();
      mainLog('info', '[Window] Hidden to tray from close button');
    }, 120);
  }
});

// --- UPDATE IPC HANDLERS ---
let mainWindow;

// Store reference to main window for updates
app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  mainWindow = BrowserWindow.getAllWindows()[0];
});

// Provide app version to renderer (some renderers call this IPC)
try { ipcMain.removeHandler('get-app-version'); } catch (e) {}
ipcMain.handle('get-app-version', async () => {
  try { return { success: true, version: app.getVersion() }; } catch (e) { return { success: false, error: String(e) }; }
});

ipcMain.handle('check-for-updates', async (event) => {
  if (!updatesEnabled()) {
    return { hasUpdate: false, disabled: true };
  }
  try {
    configureAutoUpdaterFeed();
    const result = await autoUpdater.checkForUpdates();
    const version = result && result.updateInfo && result.updateInfo.version ? result.updateInfo.version : '';
    // Try to locate a downloadable installer URL (generic provider usually exposes file URLs)
    let installerUrl = '';
    try {
      const files = result && result.updateInfo && result.updateInfo.files;
      if (files && Array.isArray(files)) {
        const exe = files.find(f => (f && (f.name || f.file) && /.exe$/i.test(f.name || f.file)) || (f && f.url && /.exe$/i.test(f.url)));
        if (exe) installerUrl = exe.url || exe.path || '';
      }
    } catch (e) {}
    // If we found a version from the autoUpdater, return it
    if (version) return { hasUpdate: Boolean(version), version, installerUrl };
  } catch (err) {
    // Handle provider-null errors gracefully: try worker fallback before
    // emitting any raw exception to the renderer UI.
    try {
      const msg = (err && err.message) ? err.message : String(err || 'Update error');
      if (/reading 'provider'|Cannot read properties of null \(reading 'provider'\)/i.test(msg)) {
        try {
          const https = require('https');
          const fallbackUrl = 'https://utopia-kingdom.escapesvk.workers.dev/updates/latest';
          let data = '';
          await new Promise((resolve, reject) => {
            const req = https.get(fallbackUrl, (res) => {
              if (res.statusCode && res.statusCode >= 400) return reject(new Error('Update server responded ' + res.statusCode));
              res.setEncoding('utf8');
              res.on('data', (c) => data += c);
              res.on('end', resolve);
            });
            req.on('error', reject);
          });
          const mVer = data.match(/^version:\s*(.+)$/m);
          const mUrl = data.match(/-\s*url:\s*(.+)$/m);
          const latestVersion = mVer ? (mVer[1] || '').trim() : '';
          const installerUrl = mUrl ? (mUrl[1] || '').trim() : '';
          if (latestVersion && isVersionNewer(latestVersion, app.getVersion())) {
            return { hasUpdate: true, version: latestVersion, installerUrl, fallback: true };
          }
        } catch (e) {
          // ignore fallback errors — we'll send a sanitized message below
        }

        try { sendUpdateEvent('update-error', { message: 'Update check failed (fallback attempted).' }); } catch (e) {}
        return { hasUpdate: false, version: '' };
      }

      try { sendUpdateEvent('update-error', { message: msg }); } catch (e) {}
    } catch (e) {}
  }

  // Fallback: attempt to fetch the latest release info from the public worker updates endpoint
  try {
    const https = require('https');
    const fallbackUrl = 'https://utopia-kingdom.escapesvk.workers.dev/updates/latest';
    const yaml = await new Promise((resolve, reject) => {
      let data = '';
      const req = https.get(fallbackUrl, (res) => {
        if (res.statusCode && res.statusCode >= 400) return reject(new Error('Update server responded ' + res.statusCode));
        res.setEncoding('utf8');
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', (e) => reject(e));
    });
    const mVer = yaml.match(/^version:\s*(.+)$/m);
    const mUrl = yaml.match(/-\s*url:\s*(.+)$/m);
    const latestVersion = mVer ? (mVer[1] || '').trim() : '';
    const installerUrl = mUrl ? (mUrl[1] || '').trim() : '';
    if (latestVersion) return { hasUpdate: isVersionNewer(latestVersion, app.getVersion()), version: latestVersion, installerUrl };
  } catch (e) {
    try { sendUpdateEvent('update-error', { message: (e && e.message) ? e.message : String(e || 'Update fallback error') }); } catch {}
  }

  return { hasUpdate: false, version: '' };
});

// Helper: simple semantic version comparison used by fallback
function isVersionNewer(latest, current) {
  const parse = (v) => String(v || '').split('.').map(n => parseInt(n, 10) || 0);
  const l = parse(latest);
  const c = parse(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] || 0;
    const cv = c[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

ipcMain.handle('download-update', async () => {
  if (!updatesEnabled()) {
    return { success: false, disabled: true };
  }
  try {
    configureAutoUpdaterFeed();
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    // console.error('Download update error:', err);
    throw err;
  }
});

ipcMain.handle('restart-app', () => {
  if (!updatesEnabled()) {
    return { success: false, disabled: true };
  }
  try {
    if (!_updateReadyToInstall) {
      return { success: false, error: 'Update is still downloading. Wait until it says Ready.' };
    }
    const ok = installDownloadedUpdate();
    if (!ok) return { success: false, error: 'Could not start the installer yet.' };
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
});

// Payment integrations removed: subscription checkout handlers have been disabled.
// Previously the app created Checkout sessions and fetched price lists from a local payments server.
// These handlers were removed because Stripe integration has been deprecated in this project.

// Open an allowlisted external URL in the user's default browser
try { ipcMain.removeHandler('open-external-url'); } catch(e) {}
ipcMain.handle('open-external-url', async (event, { url }) => {
  if (!url) return { success: false, error: 'Missing url' };
  if (!isAllowedExternalUrl(url)) {
    return { success: false, error: 'URL not allowed' };
  }
  try {
    await shell.openExternal(String(url));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to open URL' };
  }
});

// Crypto checkout disabled — card/Paddle only.
try { ipcMain.removeHandler('get-crypto-payment-link'); } catch (e) {}
ipcMain.handle('get-crypto-payment-link', async () => {
  return { success: false, error: 'Card payment only. Use Paddle checkout.' };
});

try { ipcMain.removeHandler('open-crypto-payment'); } catch (e) {}
ipcMain.handle('open-crypto-payment', async () => {
  return { success: false, error: 'Card payment only. Use Subscribe with card (Paddle).' };
});

try { ipcMain.removeHandler('open-subscription-payment'); } catch (e) {}
ipcMain.handle('open-subscription-payment', async () => {
  return { success: false, error: 'Card payment only. Use Subscribe with card (Paddle).' };
});

try { ipcMain.removeHandler('create-coinbase-charge'); } catch (e) {}
ipcMain.handle('create-coinbase-charge', async () => {
  return { success: false, error: 'Card payment only. Use Subscribe with card (Paddle).' };
});

try { ipcMain.removeHandler('probe-coinbase-server'); } catch (e) {}
ipcMain.handle('probe-coinbase-server', async () => {
  return { success: false, error: 'Crypto checkout disabled' };
});

try { ipcMain.removeHandler('simulate-charge'); } catch (e) {}
ipcMain.handle('simulate-charge', async () => {
  return { success: false, error: 'Crypto checkout disabled' };
});

// Provide a stub for fetch-allowed-prices so renderer won't throw noisy errors when payments are disabled
try { ipcMain.removeHandler('fetch-allowed-prices'); } catch (e) {}
ipcMain.handle('fetch-allowed-prices', async () => {
  return { success: false, error: 'Payments disabled' };
});

// --- POCKET OPTION SSID & BALANCE HANDLERS ---

let ssidStorage = new Map(); // botId -> stored SSID for quick access
let ssidVaultReady = false;

function removePlainSsidFilesForBot(botId) {
  const ssidDir = getPoSsidDir();
  const names = [
    `pocketoption_ssid_${botId}.txt`,
    `pocketoption_real_ssid_${botId}.txt`,
    `pocketoption_demo_ssid_${botId}.txt`
  ];
  for (const name of names) {
    try {
      const p = path.join(ssidDir, name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
  }
}

async function initSsidVault() {
  try {
    migratePoConfigFilesFromLegacyDirs();
    const dirsToScan = [...getLegacyPoSsidDirs(), getPoSsidDir()];
    let migrated = 0;
    const hydrated = {};
    for (const ssidDir of dirsToScan) {
      if (!fs.existsSync(ssidDir)) continue;
      const result = await poSsidVault.migratePlaintextFiles({
        ssidDir,
        readTextFileIfExists,
        detectAccountFromSsid,
        fs,
        log: mainLog
      });
      migrated += result.migrated || 0;
      for (const [botId, slots] of Object.entries(result.hydrated || {})) {
        if (!hydrated[botId]) hydrated[botId] = { realSsid: null, demoSsid: null };
        if (!hydrated[botId].realSsid && slots.realSsid) hydrated[botId].realSsid = slots.realSsid;
        if (!hydrated[botId].demoSsid && slots.demoSsid) hydrated[botId].demoSsid = slots.demoSsid;
      }
    }
    if (poSsidVault.isAvailable()) {
      const fromVault = await poSsidVault.loadAllFromVault(detectAccountFromSsid);
      for (const [botId, slots] of Object.entries(fromVault || {})) {
        if (!hydrated[botId]) hydrated[botId] = { realSsid: null, demoSsid: null };
        if (!hydrated[botId].realSsid && slots.realSsid) hydrated[botId].realSsid = slots.realSsid;
        if (!hydrated[botId].demoSsid && slots.demoSsid) hydrated[botId].demoSsid = slots.demoSsid;
      }
    }
    if (migrated > 0) {
      mainLog('info', `[SSID Vault] Migrated ${migrated} plaintext SSID file(s) into Windows Credential Manager`);
    }
    for (const [botId, slots] of Object.entries(hydrated)) {
      ssidStorageDual.set(botId, {
        realSsid: slots.realSsid || null,
        demoSsid: slots.demoSsid || null
      });
      if (slots.realSsid) ssidStorage.set(botId, slots.realSsid);
    }
    if (poSsidVault.isAvailable()) {
      mainLog('info', '[SSID Vault] Pocket Option SSIDs are stored in Windows Credential Manager');
    }
    const collectorDir = getPoCollectorDir();
    const checkScript = path.join(collectorDir, 'check_ssid.py');
    const bundledReady = ensurePortableBundledVenv(getBundledVenvRoot());
    _bundledVenvReady = bundledReady;
    const pythonExecutable = getPythonExecutable();
    if (app.isPackaged && bundledReady && !bundledReady.ok) {
      mainLog('error', `[SSID] Packaged Python is not portable (${bundledReady.reason}). Users will see connect failures until rebuild.`);
    }
    if (!fs.existsSync(checkScript)) {
      mainLog('error', `[SSID] Python helper missing: ${checkScript}`);
    } else {
      mainLog('info', `[SSID] Python helpers ready at ${collectorDir} via ${pythonExecutable}`);
    }
  } catch (e) {
    mainLog('error', '[SSID Vault] Initialization failed:', e.message);
  }
  ssidVaultReady = true;
  startSsidStatusPolling();
  setTimeout(() => {
    reconnectSavedSsidSessions().catch((e) => {
      mainLog('warn', `[SSID] startup reconnect failed: ${e && e.message ? e.message : e}`);
    });
  }, 500);
}

function migratePoConfigFilesFromLegacyDirs() {
  const active = getPoSsidDir();
  for (const legacyDir of getLegacyPoSsidDirs()) {
    if (!legacyDir || !fs.existsSync(legacyDir)) continue;
    try {
      for (const name of fs.readdirSync(legacyDir)) {
        if (!name.endsWith('.txt')) continue;
        if (/pocketoption_.*ssid/i.test(name)) continue;
        const src = path.join(legacyDir, name);
        const dest = path.join(active, name);
        if (!fs.existsSync(dest) && fs.existsSync(src)) {
          try { fs.copyFileSync(src, dest); } catch (e) {}
        }
      }
    } catch (e) {}
  }
}

function getPoSsidDir() {
  const ssidDir = (app.isPackaged && !isDevAppRun())
    ? path.join(app.getPath('userData'), 'po-ssid')
    : path.join(__dirname, 'PO SSID Collector', 'ssid');
  try { fs.mkdirSync(ssidDir, { recursive: true }); } catch (e) {}
  return ssidDir;
}

function getPoCollectorDir() {
  if (app.isPackaged && !isDevAppRun() && process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'PO SSID Collector');
    if (fs.existsSync(unpacked)) return unpacked;
    const extra = path.join(process.resourcesPath, 'PO SSID Collector');
    if (fs.existsSync(extra)) return extra;
  }
  for (const root of getProjectRoots()) {
    const collector = path.join(root, 'PO SSID Collector');
    if (fs.existsSync(path.join(collector, 'check_ssid.py'))) return collector;
  }
  return path.join(__dirname, 'PO SSID Collector');
}

function getLegacyPoSsidDirs() {
  const dirs = [];
  if (app.isPackaged) {
    dirs.push(path.join(app.getAppPath(), 'PO SSID Collector', 'ssid'));
    if (process.resourcesPath) {
      dirs.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'PO SSID Collector', 'ssid'));
    }
  } else {
    dirs.push(path.join(__dirname, 'PO SSID Collector', 'ssid'));
  }
  const active = getPoSsidDir();
  return dirs.filter((dir, idx, all) => dir && dir !== active && all.indexOf(dir) === idx);
}

function readTextFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  return null;
}

function readPoSsidFile(fileName) {
  const primary = path.join(getPoSsidDir(), fileName);
  const legacy = path.join(__dirname, 'BotsHub', 'Prices', 'meta', fileName);
  return readTextFileIfExists(primary) || readTextFileIfExists(legacy);
}

// Save SSID to Windows Credential Manager for a specific bot (legacy single-slot API)
try { ipcMain.removeHandler('save-pocket-option-ssid'); } catch (e) {}
ipcMain.handle('save-pocket-option-ssid', async (event, { botId, ssid } = {}) => {
  try {
    if (!botId || !ssid) {
      return { success: false, error: 'Missing botId or ssid' };
    }

    const trimmed = String(ssid).trim();
    const detected = detectAccountFromSsid(trimmed);
    if (!detected) {
      return { success: false, error: 'Could not read isDemo from SSID' };
    }

    await poSsidVault.setSsid(botId, detected, trimmed);
    ssidStorage.set(botId, trimmed);
    const prev = ssidStorageDual.get(botId) || {};
    ssidStorageDual.set(botId, {
      realSsid: detected === 'real' ? trimmed : (prev.realSsid || null),
      demoSsid: detected === 'demo' ? trimmed : (prev.demoSsid || null)
    });
    removePlainSsidFilesForBot(botId);

    mainLog('info', `[SSID] Saved ${detected} SSID for ${botId} (Windows Credential Manager)`);
    return { success: true };
  } catch (e) {
    mainLog('error', '[SSID] Failed to save SSID:', e.message);
    return { success: false, error: e.message };
  }
});

// Load SSID from file for a specific bot
try { ipcMain.removeHandler('load-pocket-option-ssid'); } catch (e) {}
ipcMain.handle('load-pocket-option-ssid', async (event, { botId } = {}) => {
  try {
    if (!botId) {
      return { success: false, error: 'Missing botId' };
    }

    // Try memory first
    let ssid = ssidStorage.get(botId);
    if (ssid) {
      return { success: true, ssid };
    }

    if (!ssid) {
      const all = loadAllSsidsForBot(botId);
      const active = loadAutotradeAccount(botId);
      ssid = active === 'real' ? all.realSsid : all.demoSsid;
      if (!ssid) ssid = all.realSsid || all.demoSsid;
    }

    return { success: true, ssid: ssid || null };
  } catch (e) {
    mainLog('error', '[SSID] Failed to load SSID:', e.message);
    return { success: false, error: e.message };
  }
});

// Fetch Pocket Option account balance and info using WebSocket
try { ipcMain.removeHandler('fetch-pocket-option-balance'); } catch (e) {}
ipcMain.handle('fetch-pocket-option-balance', async (event, { botId, ssid } = {}) => {
  try {
    if (!ssid && !botId) {
      return { success: false, error: 'Missing SSID or botId' };
    }

    // If only botId provided, load SSID from memory or file
    let targetSsid = ssid;
    if (!targetSsid && botId) {
      // Try memory first (fastest, most recent)
      targetSsid = ssidStorage.get(botId);
      mainLog('info', `[PO] Loaded SSID from memory for ${botId}: ${targetSsid ? 'found' : 'not found'}`);
      
      if (!targetSsid) {
        const all = loadAllSsidsForBot(botId);
        targetSsid = all.realSsid || all.demoSsid;
        if (targetSsid) mainLog('info', `[PO] Loaded SSID from secure store for ${botId}`);
      }
    }

    if (!targetSsid) {
      return { success: false, error: 'Could not find SSID' };
    }

    const { spawn } = require('child_process');
    const pythonExecutable = getPythonExecutable();
    const collectorDir = getPoCollectorDir();
    const pythonScript = path.join(collectorDir, 'fetch_balance.py');

    mainLog('info', `[PO] Fetching balance via Python helper for ${botId || 'default'} using python: ${pythonExecutable}`);

    return await new Promise((resolve) => {
      const child = spawn(pythonExecutable, [pythonScript, '--ssid', targetSsid, '--json-only'], {
        cwd: collectorDir,
        windowsHide: true,
        env: getPythonSpawnEnv()
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('error', (err) => {
        mainLog('error', `[PO] Python fetcher failed to start: ${err.message}`);
        resolve({ success: false, error: err.message });
      });

      child.on('close', (code) => {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith('{') && line.trim().endsWith('}'));

        if (jsonLine) {
          try {
            const result = JSON.parse(jsonLine);
            mainLog('info', `[PO] Python balance result: success=${result.success} balance=${result.balance ?? 'n/a'}`);
            resolve(result);
            return;
          } catch (parseErr) {
            mainLog('warn', `[PO] Failed to parse Python JSON: ${parseErr.message}`);
          }
        }

        if (stderr) {
          mainLog('warn', `[PO] Python stderr: ${stderr.substring(0, 500)}`);
        }

        resolve({
          success: false,
          error: `Python helper exited with code ${code}`,
          stderr: stderr ? stderr.substring(0, 500) : ''
        });
      });
    });
  } catch (e) {
    mainLog('error', '[PO] Failed to fetch balance:', e.message);
    return { success: false, error: e.message };
  }
});

// --- DUAL SSID HANDLERS (Real + Demo) ---

let ssidStorageDual = new Map(); // botId -> { realSsid, demoSsid }
/** Runtime session SSIDs — persisted to vault only on app quit while still connected. */
const ssidSessionDual = new Map(); // botId -> { realSsid, demoSsid }

// Save SSID for autotrade (single account — demo OR real, not both required)
try { ipcMain.removeHandler('save-pocket-option-ssids'); } catch (e) {}
ipcMain.handle('save-pocket-option-ssids', async (event, { botId, ssid, account, currency, applyToAllBots, autotradeAccount, realSsid, demoSsid } = {}) => {
  try {
    if (!botId) {
      return { success: false, error: 'Missing botId' };
    }

    let activeSsid = (ssid || '').trim();
    let activeAccount = account || autotradeAccount;
    let activeCurrency = currency;

    if (!activeSsid && (realSsid || demoSsid)) {
      if (realSsid && !demoSsid) {
        activeSsid = realSsid.trim();
        activeAccount = activeAccount || 'real';
      } else if (demoSsid && !realSsid) {
        activeSsid = demoSsid.trim();
        activeAccount = activeAccount || 'demo';
      } else if (realSsid && demoSsid) {
        activeAccount = activeAccount || 'demo';
        activeSsid = (activeAccount === 'real' ? realSsid : demoSsid).trim();
      }
    }

    if (!activeSsid) {
      return { success: false, error: 'Missing SSID' };
    }

    const detected = detectAccountFromSsid(activeSsid);
    if (!detected) {
      return { success: false, error: 'Could not read isDemo from SSID' };
    }
    if (activeAccount && detected !== activeAccount) {
      return { success: false, error: `SSID is ${detected} — switch to ${activeAccount === 'demo' ? 'Demo' : 'Real'} or paste the correct token` };
    }
    activeAccount = detected;

    // Always apply to LUMIX + MIRAX — one SSID session for the whole app.
    const targetBots = ['bot1', 'bot2', 'bot3'];
    let lastStatus = null;
    let lastAccount = activeAccount;

    for (const targetId of targetBots) {
      const saved = await writeSsidForBot(targetId, activeSsid, activeAccount, activeCurrency);
      lastAccount = saved.account;
      mainLog('info', `[SSID] Saved ${saved.account} SSID for ${targetId} (${saved.currency})`);
    }
    // Connect the live worker first so the first Pocket Option login is not
    // raced by a status poll timeout.
    const connected = await connectPoSsidSession(activeSsid, activeCurrency || '');
    for (const targetId of targetBots) {
      lastStatus = await refreshSsidStatusForBot(targetId, { force: true });
      if (lastStatus?.currency && lastStatus.activeAccount === activeAccount) {
        try { saveAccountCurrency(targetId, lastStatus.currency, activeAccount); } catch (e) {}
      }
    }

    if (lastStatus && !lastStatus.activeOnline && connected && connected.success) {
      const liveBalance = isValidDisplayBalance(connected.balance) ? connected.balance : null;
      lastStatus = {
        ...lastStatus,
        activeOnline: liveBalance != null,
        balance: liveBalance,
        currency: connected.currency || lastStatus.currency,
        error: liveBalance == null ? (connected.error || lastStatus.error) : null,
        lastOnlineAt: liveBalance != null ? Date.now() : 0
      };
      if (liveBalance != null) {
        const acc = lastStatus.activeAccount === 'real' ? 'real' : 'demo';
        if (lastStatus[acc]) {
          lastStatus[acc] = {
            ...lastStatus[acc],
            online: true,
            balance: liveBalance,
            currency: lastStatus.currency,
            error: null,
            expired: false
          };
        }
      }
      for (const targetId of targetBots) {
        const prev = ssidStatusByBot.get(targetId) || lastStatus;
        const next = { ...prev, ...lastStatus, botId: targetId, activeOnline: liveBalance != null };
        ssidStatusByBot.set(targetId, next);
        broadcastSsidStatus(targetId);
      }
    }

    return {
      success: true,
      account: lastAccount,
      status: lastStatus,
      helperError: (connected && !connected.success) ? (connected.error || 'helper failed') : null
    };
  } catch (e) {
    mainLog('error', '[SSID] Failed to save SSID:', e.message);
    return { success: false, error: e.message };
  }
});

// Load saved SSID for a bot
try { ipcMain.removeHandler('load-pocket-option-ssids'); } catch (e) {}
ipcMain.handle('load-pocket-option-ssids', async (event, { botId } = {}) => {
  try {
    if (!botId) {
      return { success: false, error: 'Missing botId' };
    }

    const { ssid, account, realSsid, demoSsid, currency, realCurrency, demoCurrency, hasReal, hasDemo } = loadSsidsForBot(botId);
    return {
      success: true,
      ssid: ssid || null,
      account: account || loadAutotradeAccount(botId),
      currency: currency || loadAccountCurrency(botId, account),
      realSsid: realSsid || null,
      demoSsid: demoSsid || null,
      realCurrency: realCurrency || loadAccountCurrency(botId, 'real'),
      demoCurrency: demoCurrency || loadAccountCurrency(botId, 'demo'),
      hasReal: !!hasReal,
      hasDemo: !!hasDemo
    };
  } catch (e) {
    mainLog('error', '[SSID] Failed to load SSID:', e.message);
    return { success: false, error: e.message };
  }
});

// Fetch balances from both Real and Demo accounts
try { ipcMain.removeHandler('fetch-pocket-option-balances'); } catch (e) {}
ipcMain.handle('fetch-pocket-option-balances', async (event, { botId, realSsid, demoSsid } = {}) => {
  try {
    if (!realSsid && !botId) {
      return { success: false, error: 'Missing SSIDs or botId' };
    }

    // If botId provided, load from memory/file
    let targetRealSsid = realSsid;
    let targetDemoSsid = demoSsid;

    if (!targetRealSsid && botId) {
      const all = loadAllSsidsForBot(botId);
      targetRealSsid = all.realSsid;
      targetDemoSsid = all.demoSsid;
    }

    if (!targetRealSsid && !targetDemoSsid && botId) {
      const active = getActiveSsidForBot(botId);
      if (active.ssid) {
        if (active.account === 'real') targetRealSsid = active.ssid;
        else targetDemoSsid = active.ssid;
      }
    }

    const hasSavedSsid = !!(targetRealSsid || targetDemoSsid);
    if (!hasSavedSsid) {
      return { success: false, error: 'No SSID saved for this bot' };
    }

    const { spawn } = require('child_process');
    const pythonExecutable = getPythonExecutable();

    mainLog('info', `[PO] Fetching balance(s) for ${botId || 'default'} using python: ${pythonExecutable}`);

    const skipBalance = { balance: 0, connected: false, success: false };

    // Fetch real account balance (if saved)
    const realBalance = targetRealSsid ? await new Promise((resolve) => {
      const collectorDir = getPoCollectorDir();
      const pythonScript = path.join(collectorDir, 'fetch_balance.py');
      const child = spawn(pythonExecutable, [pythonScript, '--ssid', targetRealSsid, '--json-only'], {
        cwd: collectorDir,
        windowsHide: true,
        timeout: 15000,
        env: getPythonSpawnEnv()
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 25000);

      child.stdout.on('data', (data) => { 
        stdout += data.toString();
      });
      
      child.stderr.on('data', (data) => { 
        stderr += data.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        mainLog('error', `[PO] Real balance fetch failed to spawn: ${err.message}`);
        resolve({ balance: 0, connected: false, success: false });
      });

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        
        if (timedOut) {
          mainLog('error', `[PO] Real: Process timed out`);
          resolve({ balance: 0, connected: false, success: false });
          return;
        }

        mainLog('info', `[PO] Real: Process exited with code ${code}, stdout length: ${stdout.length}`);
        
        if (stdout) {
          mainLog('debug', `[PO] Real stdout (last 500 chars): ${stdout.substring(Math.max(0, stdout.length - 500))}`);
        }
        
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith('{') && line.trim().endsWith('}'));

        if (jsonLine) {
          try {
            const result = JSON.parse(jsonLine);
            mainLog('info', `[PO] Real account response: success=${result.success}, balance=${result.balance}, connected=${result.connected}`);
            resolve(result);
            return;
          } catch (parseErr) {
            mainLog('warn', `[PO] Real: Failed to parse JSON: ${parseErr.message}, line was: ${jsonLine.substring(0, 100)}`);
          }
        }
        
        if (stderr) {
          mainLog('warn', `[PO] Real stderr: ${stderr.substring(0, 500)}`);
        }
        
        mainLog('warn', `[PO] Real: No valid JSON found in output`);
        resolve({ balance: 0, connected: false, success: false });
      });
    }) : skipBalance;

    // Fetch demo account balance (if saved)
    const demoBalance = targetDemoSsid ? await new Promise((resolve) => {
      const collectorDir = getPoCollectorDir();
      const pythonScript = path.join(collectorDir, 'fetch_balance.py');
      const child = spawn(pythonExecutable, [pythonScript, '--ssid', targetDemoSsid, '--json-only'], {
        cwd: collectorDir,
        windowsHide: true,
        timeout: 15000,
        env: getPythonSpawnEnv()
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 25000);

      child.stdout.on('data', (data) => { 
        stdout += data.toString();
      });
      
      child.stderr.on('data', (data) => { 
        stderr += data.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        mainLog('error', `[PO] Demo balance fetch failed to spawn: ${err.message}`);
        resolve({ balance: 0, connected: false, success: false });
      });

      child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        
        if (timedOut) {
          mainLog('error', `[PO] Demo: Process timed out`);
          resolve({ balance: 0, connected: false, success: false });
          return;
        }

        mainLog('info', `[PO] Demo: Process exited with code ${code}, stdout length: ${stdout.length}`);
        
        if (stdout) {
          mainLog('debug', `[PO] Demo stdout (last 500 chars): ${stdout.substring(Math.max(0, stdout.length - 500))}`);
        }
        
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith('{') && line.trim().endsWith('}'));

        if (jsonLine) {
          try {
            const result = JSON.parse(jsonLine);
            mainLog('info', `[PO] Demo account response: success=${result.success}, balance=${result.balance}, connected=${result.connected}`);
            resolve(result);
            return;
          } catch (parseErr) {
            mainLog('warn', `[PO] Demo: Failed to parse JSON: ${parseErr.message}, line was: ${jsonLine.substring(0, 100)}`);
          }
        }
        
        if (stderr) {
          mainLog('warn', `[PO] Demo stderr: ${stderr.substring(0, 500)}`);
        }
        
        mainLog('warn', `[PO] Demo: No valid JSON found in output`);
        resolve({ balance: 0, connected: false, success: false });
      });
    }) : skipBalance;

    const connected = realBalance.connected || demoBalance.connected;
    
    // Log final status
    mainLog('info', `[PO] Real: ${realBalance.connected ? '✅' : '❌'} balance=${realBalance.balance}, Demo: ${demoBalance.connected ? '✅' : '❌'} balance=${demoBalance.balance}`);
    
    return {
      success: true,
      connected,
      realBalance: parseFloat(realBalance.balance) || 0,
      demoBalance: parseFloat(demoBalance.balance) || 0,
      currency: realBalance.currency || demoBalance.currency || 'USD',
      trades: realBalance.trades || 0,
      note: connected ? '✅ Account connected' : '❌ Could not connect',
      realConnected: realBalance.connected,
      demoConnected: demoBalance.connected
    };
  } catch (e) {
    mainLog('error', '[PO] Failed to fetch dual balances:', e.message);
    return { success: false, error: e.message };
  }
});

// --- SSID AUTOTRADE (direct API — replaces extension execution) ---

const ssidAutotradeAccount = new Map(); // botId -> 'demo' | 'real'
const ssidStatusByBot = new Map(); // botId -> { autotradeAccount, real, demo, updatedAt }
const ssidCheckInFlight = new Map(); // botId -> Promise
let ssidStatusTimer = null;

// Status must reuse the long-lived trade worker — spawning check_ssid.py opens a
// fresh PO login and kicks / flickers the browser chart. Longer TTL is fine now
// because balance() hits an already-open socket instead of reconnecting.
const SSID_ONLINE_TTL_MS = 180 * 1000;
const SSID_OFFLINE_TTL_MS = 90 * 1000;
const SSID_BACKGROUND_POLL_MS = 120 * 1000;
const SSID_STICKY_ONLINE_MS = 0; // disabled — stale "online" hid disconnects in the pill UI
const SSID_BOT_STAGGER_MS = 1500;

function isValidDisplayBalance(balance) {
  const n = Number(balance);
  return Number.isFinite(n) && n >= 0;
}

function mergeSessionSsidsForBot(botId, base) {
  const session = ssidSessionDual.get(botId);
  if (!session) return base;
  return {
    realSsid: session.realSsid != null ? session.realSsid : base.realSsid,
    demoSsid: session.demoSsid != null ? session.demoSsid : base.demoSsid,
    hasReal: !!(session.realSsid != null ? session.realSsid : base.realSsid),
    hasDemo: !!(session.demoSsid != null ? session.demoSsid : base.demoSsid)
  };
}

function buildOfflineSsidStatus(botId) {
  return {
    botId,
    activeAccount: loadAutotradeAccount(botId),
    hasReal: false,
    hasDemo: false,
    hasSsid: false,
    activeOnline: false,
    balance: null,
    currency: loadAccountCurrency(botId, loadAutotradeAccount(botId)),
    error: null,
    expired: false,
    latency_ms: null,
    real: { online: false, balance: null, currency: loadAccountCurrency(botId, 'real'), error: null, expired: false, latency_ms: null },
    demo: { online: false, balance: null, currency: loadAccountCurrency(botId, 'demo'), error: null, expired: false, latency_ms: null },
    updatedAt: Date.now(),
    lastOnlineAt: 0
  };
}

function pushSsidOfflineInstant(botId) {
  const status = buildOfflineSsidStatus(botId);
  ssidStatusByBot.set(botId, status);
  broadcastSsidStatus(botId);
  return status;
}

async function flushConnectedSsidsToVault() {
  for (const botId of ['bot1', 'bot2', 'bot3']) {
    const session = ssidSessionDual.get(botId) || ssidStorageDual.get(botId);
    if (!session) continue;
    try {
      if (session.realSsid) await poSsidVault.setSsid(botId, 'real', session.realSsid);
      if (session.demoSsid) await poSsidVault.setSsid(botId, 'demo', session.demoSsid);
      mainLog('info', `[SSID] Persisted session for ${botId} on app quit`);
    } catch (e) {
      mainLog('warn', `[SSID] Could not persist ${botId} on quit: ${e.message}`);
    }
  }
}

function getBundledVenvRoot() {
  if (!app.isPackaged || !process.resourcesPath) return null;
  const root = path.join(process.resourcesPath, 'venv');
  return firstExistingPath(venvPythonCandidates(root)) ? root : null;
}

/**
 * Packaged venvs die if pyvenv.cfg `home=` still points at the build machine.
 * Point home at the shipped runtime folder (Windows + macOS).
 */
function ensurePortableBundledVenv(venvRoot) {
  if (!venvRoot) return { ok: false, reason: 'missing_venv' };
  const cfgPath = path.join(venvRoot, 'pyvenv.cfg');
  const runtimeHome = venvRuntimeHome(venvRoot);
  const runtimePy = venvRuntimePython(venvRoot);
  const stubPy = firstExistingPath(venvPythonCandidates(venvRoot));
  if (!stubPy) return { ok: false, reason: 'missing_stub' };

  const probePy = runtimePy || stubPy;

  let cfg = '';
  try { cfg = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { cfg = ''; }

  const homeMatch = cfg.match(/^\s*home\s*=\s*(.+)\s*$/m);
  const configuredHome = homeMatch ? String(homeMatch[1] || '').trim() : '';
  const homeLooksOk = venvHomeLooksOk(configuredHome);

  if (!homeLooksOk && fs.existsSync(cfgPath)) {
    if (!runtimePy) {
      mainLog('error', `[SSID] Packaged Python runtime missing at ${runtimeHome}. Rebuild with scripts/bundle_python_runtime.js (Windows) or scripts/prepare_mac_python.js (macOS).`);
      return { ok: false, reason: 'missing_runtime', home: configuredHome };
    }
    const absHome = runtimeHome.replace(/\\/g, '/');
    const nextCfg = [
      `home = ${absHome}`,
      'include-system-site-packages = false',
      'version = 3',
      ''
    ].join('\n');
    try {
      fs.writeFileSync(cfgPath, nextCfg, 'utf8');
      mainLog('info', `[SSID] Rewrote pyvenv.cfg home → ${absHome}`);
    } catch (e) {
      mainLog('error', `[SSID] Failed to rewrite pyvenv.cfg: ${e && e.message ? e.message : e}`);
      return { ok: false, reason: 'cfg_write_failed' };
    }
  }

  try {
    const { spawnSync } = require('child_process');
    const binDir = venvBinDir(venvRoot);
    const runtimeBin = process.platform === 'win32'
      ? runtimeHome
      : path.join(runtimeHome, 'bin');
    const pathPrefix = [binDir, runtimeBin].filter((p) => fs.existsSync(p)).join(path.delimiter);
    const probe = spawnSync(probePy, ['-c', 'import sys; print(sys.version.split()[0])'], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8',
      env: {
        ...process.env,
        VIRTUAL_ENV: venvRoot,
        PATH: `${pathPrefix}${path.delimiter}${process.env.PATH || ''}`,
        ...(runtimePy ? { PYTHONHOME: runtimeHome } : {})
      }
    });
    if (probe.status !== 0) {
      const err = String(probe.stderr || probe.stdout || 'python probe failed').trim();
      mainLog('error', `[SSID] Packaged Python probe failed: ${err}`);
      return { ok: false, reason: 'probe_failed', detail: err };
    }
  } catch (e) {
    return { ok: false, reason: 'probe_exception', detail: e && e.message ? e.message : String(e) };
  }
  return { ok: true };
}

let _bundledVenvReady = null;
function getReadyBundledVenvRoot() {
  const root = getBundledVenvRoot();
  if (!root) return null;
  if (!_bundledVenvReady) {
    _bundledVenvReady = ensurePortableBundledVenv(root);
  }
  return _bundledVenvReady.ok ? root : null;
}

function getPythonSpawnEnv() {
  const env = { ...process.env };
  const bundled = getReadyBundledVenvRoot() || getBundledVenvRoot();
  if (bundled) {
    const binDir = venvBinDir(bundled);
    const runtime = venvRuntimeHome(bundled);
    const runtimeBin = process.platform === 'win32' ? runtime : path.join(runtime, 'bin');
    env.VIRTUAL_ENV = bundled;
    env.PATH = [binDir, runtimeBin, env.PATH || ''].filter(Boolean).join(path.delimiter);
    if (venvRuntimePython(bundled)) {
      env.PYTHONHOME = runtime;
    }
    return env;
  }
  const devVenv = getDevVenvPython();
  if (devVenv) {
    const venvRoot = path.dirname(path.dirname(devVenv));
    env.VIRTUAL_ENV = venvRoot;
    env.PATH = `${venvBinDir(venvRoot)}${path.delimiter}${env.PATH || ''}`;
  }
  return env;
}

function getPythonExecutable() {
  const { spawnSync } = require('child_process');
  const bundled = getReadyBundledVenvRoot();
  if (bundled) {
    const runtimePy = venvRuntimePython(bundled);
    if (runtimePy) return runtimePy;
    const bundledPy = firstExistingPath(venvPythonCandidates(bundled));
    if (bundledPy) return bundledPy;
  }
  const rawBundled = getBundledVenvRoot();
  if (rawBundled) {
    const runtimePy = venvRuntimePython(rawBundled);
    if (runtimePy) return runtimePy;
  }
  if (process.env.PYTHON_EXECUTABLE && fs.existsSync(process.env.PYTHON_EXECUTABLE)) {
    return path.resolve(process.env.PYTHON_EXECUTABLE);
  }
  const devVenv = getDevVenvPython();
  if (devVenv) return devVenv;

  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const probe = spawnSync(c, ['--version'], {
        windowsHide: true,
        timeout: 5000,
        env: getPythonSpawnEnv()
      });
      if (probe && probe.status === 0) return c;
    } catch (e) {}
  }
  return devVenv || candidates[0] || 'python3';
}

function parsePythonJsonStdout(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.trim().startsWith('{') && line.trim().endsWith('}'));
  if (!jsonLine) return null;
  try { return JSON.parse(jsonLine); } catch (e) { return null; }
}

function runPythonJsonScript(scriptName, args = [], timeoutMs = 15000) {
  const { spawn } = require('child_process');
  const pythonExecutable = getPythonExecutable();
  const collectorDir = getPoCollectorDir();
  const pythonScript = path.join(collectorDir, scriptName);

  if (!fs.existsSync(pythonScript)) {
    mainLog('error', `[SSID] Missing Python script: ${pythonScript}`);
    return Promise.resolve({ success: false, error: `missing script: ${scriptName}` });
  }

  return new Promise((resolve) => {
    const child = spawn(pythonExecutable, [pythonScript, ...args], {
      cwd: collectorDir,
      windowsHide: true,
      env: getPythonSpawnEnv()
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (e) {}
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      resolve({ success: false, error: err.message, stderr });
    });

    child.on('close', () => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        resolve({ success: false, error: 'timeout', stderr });
        return;
      }
      const parsed = parsePythonJsonStdout(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }
      resolve({
        success: false,
        error: 'invalid python output',
        stderr: stderr ? stderr.substring(0, 500) : '',
        stdout: stdout ? stdout.substring(0, 500) : ''
      });
    });
  });
}

class PoTradeWorker {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.pending = new Map();
    this.seq = 0;
    this.starting = null;
    this.ready = false;
    this._stopped = false;
    this._restartDelayMs = 1500;
    this._restartTimer = null;
    this._errBuf = '';
    this.onLateResult = null;
  }

  _rejectAllPending(error) {
    for (const [, resolve] of this.pending.entries()) {
      try { resolve({ success: false, error: error || 'worker stopped' }); } catch (e) {}
    }
    this.pending.clear();
  }

  _killProc() {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    if (!proc) return;
    try {
      if (proc.stdin) proc.stdin.end();
    } catch (e) {}
    try {
      if (process.platform === 'win32' && proc.pid) {
        const { spawnSync } = require('child_process');
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 5000
        });
      } else {
        proc.kill();
      }
    } catch (e) {
      try { proc.kill(); } catch (e2) {}
    }
  }

  _scheduleRestart() {
    if (this._stopped) return;
    if (this._restartTimer) return;
    const delay = this._restartDelayMs;
    this._restartDelayMs = Math.min(15000, Math.round(this._restartDelayMs * 1.8));
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.ensureStarted().catch((e) => {
        mainLog('warn', `[PO-Worker] restart failed: ${e && e.message ? e.message : e}`);
      });
    }, delay);
  }

  _onStdout(chunk) {
    this.buf += chunk.toString();
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const id = msg.id;
        if (id != null && this.pending.has(id)) {
          const cb = this.pending.get(id);
          this.pending.delete(id);
          cb(msg);
        } else if (String(msg.event || '') === 'deal_settled' || (
          msg.deal_id && msg.pending === false && msg.outcome
        )) {
          if (typeof this.onLateResult === 'function') {
            try { this.onLateResult({ deal_id: msg.deal_id || msg.dealId }, msg); } catch (e) {}
          }
        } else if (this.onLateResult && (msg.online || msg.balance != null)) {
          try { this.onLateResult({ cmd: 'status' }, msg); } catch (e) {}
        }
      } catch (e) {}
    }
  }

  _send(payload, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed || !this.proc.stdin) {
        resolve({ success: false, error: 'worker not running' });
        return;
      }
      const id = ++this.seq;
      let timedOut = false;
      const timer = setTimeout(() => {
        if (!this.pending.has(id) || timedOut) return;
        timedOut = true;
        resolve({
          success: false,
          pending: true,
          error: 'worker timeout',
          deal_id: payload.deal_id || payload.dealId || null
        });
      }, timeoutMs);
      this.pending.set(id, (res) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (timedOut) {
          if (typeof this.onLateResult === 'function') {
            try { this.onLateResult(payload, res); } catch (e) {}
          }
          return;
        }
        resolve(res);
      });
      try {
        this.proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ success: false, error: e.message });
      }
    });
  }

  ensureStarted() {
    this._stopped = false;
    if (this.ready && this.proc && !this.proc.killed) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.proc && !this.proc.killed && !this.ready) {
      this._killProc();
    }
    this.starting = new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      const pythonExecutable = getPythonExecutable();
      const collectorDir = getPoCollectorDir();
      const script = path.join(collectorDir, 'po_trade_worker.py');
      if (!fs.existsSync(script)) {
        const err = new Error(`missing helper: ${script}`);
        this.starting = null;
        reject(err);
        return;
      }
      mainLog('info', `[PO-Worker] starting ${pythonExecutable}`);
      this._errBuf = '';
      this.ready = false;
      this.proc = spawn(pythonExecutable, [script], {
        cwd: collectorDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: getPythonSpawnEnv()
      });
      const child = this.proc;
      this.proc.stdout.on('data', (d) => this._onStdout(d));
      this.proc.stderr.on('data', (d) => {
        const text = String(d || '');
        this._errBuf = (this._errBuf + text).slice(-1200);
        const line = text.trim();
        if (line) mainLog('warn', `[PO-Worker] ${line.slice(0, 300)}`);
      });
      this.proc.on('error', (err) => {
        if (this.proc !== child) return;
        this.ready = false;
        this.starting = null;
        this.proc = null;
        this._rejectAllPending(err.message);
        reject(err);
        this._scheduleRestart();
      });
      this.proc.on('exit', (code) => {
        if (this.proc !== child && this.proc) return;
        const wasReady = this.ready;
        this.proc = null;
        this.ready = false;
        this.starting = null;
        this._rejectAllPending('worker exited');
        if (this._errBuf) mainLog('warn', `[PO-Worker] exit ${code}: ${this._errBuf.slice(0, 400)}`);
        else mainLog('warn', `[PO-Worker] exited code=${code}`);
        if (!this._stopped) this._scheduleRestart();
        if (!wasReady) reject(new Error(this._errBuf.trim() || `worker exited (${code})`));
      });
      this._send({ cmd: 'ping' }, 25000)
        .then((res) => {
          if (res && res.success) {
            this.ready = true;
            this._restartDelayMs = 1500;
            this.starting = null;
            mainLog('info', '[PO-Worker] ready');
            resolve();
            return;
          }
          const err = new Error((res && res.error) || 'worker ping failed');
          this._killProc();
          this.starting = null;
          reject(err);
          this._scheduleRestart();
        })
        .catch((err) => {
          this.ready = false;
          this.starting = null;
          reject(err);
          this._scheduleRestart();
        });
    });
    return this.starting;
  }

  request(payload, timeoutMs = 20000) {
    const cmd = String((payload && payload.cmd) || '');
    if (cmd === 'ping' && this.proc && !this.proc.killed) {
      return this._send(payload, timeoutMs);
    }
    return this.ensureStarted().then(() => this._send(payload, timeoutMs));
  }

  stop() {
    this._stopped = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._rejectAllPending('worker stopped');
    this.starting = null;
    this.ready = false;
    this.buf = '';
    this._killProc();
  }
}

const poTradeWorker = new PoTradeWorker();
const tradePrepByBot = new Map();
const lastFastTradeKeyByBot = new Map();
const inFlightTradeByBot = new Map(); // botId -> true while a PO trade call is running
/** Shared-SSID lock: one place at a time per wallet + reserved amounts. */
const inFlightTradeBySsid = new Map(); // ssidKey -> botId
const reservedStakeBySsid = new Map(); // ssidKey -> { amount, at }
const autotradeBetByBot = new Map();
const autotradeSavingByBot = new Map(); // botId -> { enabled, multiplier, stakeAmount, at }
// Don't place hub trades until the UI has synced toggles at least once this session.
const autotradeUiSyncedByBot = new Set();
const SIGNAL_ENTRY_MAX_AGE_MS = 15000; // refuse Signal older than this (stale / replay)

const BOT_NAME_TO_ID = { LUMIX: 'bot1', MIRAX: 'bot2', NYX: 'bot3' };
const autotradeEnabledByBot = new Map();
const autotradeWaitChainByBot = new Map(); // botId -> wait until fresh attempt 1
/** 2x skipped while PO result was pending — place it if a LOSS lands in time. */
const pendingMgRetryByBot = new Map();
/** User chose Jump into a live MG chain they did not start (no SSID 1x). */
const joinMidChainByBot = new Map(); // botId -> { at, attempt, until }
/** Last Signal-phase hub payload — replayed when the user jumps in mid-candle. */
const lastHubSignalByBot = new Map(); // botId -> { signal, at }

function isJoinMidChainActive(botId, attempt) {
  const join = joinMidChainByBot.get(botId);
  if (!join) return false;
  if (Date.now() > Number(join.until || 0)) {
    joinMidChainByBot.delete(botId);
    return false;
  }
  const liveAttempt = Number(attempt) || 0;
  if (liveAttempt <= 1) {
    joinMidChainByBot.delete(botId);
    return false;
  }
  return true;
}

function armJoinMidChain(botId, attempt) {
  const a = Math.min(Math.max(2, Math.trunc(Number(attempt) || 2)), 5);
  joinMidChainByBot.set(botId, {
    at: Date.now(),
    attempt: a,
    until: Date.now() + (8 * 60 * 1000)
  });
  autotradeWaitChainByBot.set(botId, false);
  mainLog('info', `[SignalHub] ${botId} jump-in armed at attempt=${a} (no prior SSID 1x required)`);
}

function tryPlaceJoinMidChain(botId) {
  const last = lastHubSignalByBot.get(botId);
  if (!last || !last.signal) {
    mainLog('info', `[SignalHub] ${botId} jump-in waiting for next live MG signal`);
    return;
  }
  const age = Date.now() - Number(last.at || 0);
  if (age > SIGNAL_ENTRY_MAX_AGE_MS) {
    mainLog(
      'info',
      `[SignalHub] ${botId} jump-in armed — last signal is ${age}ms old, will take the next MG step`
    );
    return;
  }
  const attempt = Number(last.signal.attempt) || 1;
  if (attempt <= 1) {
    mainLog('info', `[SignalHub] ${botId} jump-in armed — last signal was 1x, waiting for current MG step`);
    return;
  }
  const join = joinMidChainByBot.get(botId);
  if (join && join.replayed) return;
  if (join) join.replayed = true;
  mainLog('info', `[SignalHub] ${botId} jump-in placing live attempt=${attempt}`);
  handleSignalHubTrade(last.signal).catch((e) => {
    mainLog('warn', `[SignalHub] ${botId} jump-in place failed: ${e && e.message ? e.message : e}`);
  });
}

function flushMgRetryOnLoss(botId, payload) {
  const retry = pendingMgRetryByBot.get(botId);
  pendingMgRetryByBot.delete(botId);
  if (autotradeWaitChainByBot.get(botId)) {
    mainLog('info', `[SignalHub] ${botId} late LOSS — skip MG, waiting for new 1x`);
    return;
  }
  if (!retry || typeof retry.run !== 'function') return;
  if (retry.dealId && payload?.dealId && String(retry.dealId) !== String(payload.dealId)) return;
  if (Date.now() - Number(retry.at || 0) > 55000) {
    mainLog('info', `[SignalHub] ${botId} late LOSS — skipped ${retry.attempt}x is stale`);
    return;
  }
  mainLog('info', `[SignalHub] ${botId} late LOSS — placing skipped ${retry.attempt}x`);
  try { retry.run(); } catch (e) {
    mainLog('warn', `[SignalHub] ${botId} late MG retry failed: ${e && e.message ? e.message : e}`);
  }
}

/** Drop leftover S2–S4 so the next place is the bot's new 1x. */
function resetSsidLadderToStart(botId, reason, opts = {}) {
  if (!botId) return;
  pendingMgRetryByBot.delete(botId);
  joinMidChainByBot.delete(botId);
  autotradeWaitChainByBot.set(botId, opts.waitForNew1x === true);
  try { lockSavingTo1x(botId); } catch (e) {}
  try { poChainRecovery.clear(botId); } catch (e) {}
  if (opts.dropLive === true) {
    try { poDealMonitor.markChainIdle(botId); } catch (e) {}
  }
  mainLog('info', `[SignalHub] ${botId} saving reset to 1x (${reason || 'reset'})`);
  // Arm UI immediately so leftover Contabo S2–S4 cannot paint a ghost card
  // before the next Signal arrives and is skipped.
  if (opts.waitForNew1x === true) {
    notifyPoDealResult({
      botId,
      outcome: 'idle',
      chainFreeze: true,
      freezeReason: 'waiting_new_1x',
      source: 'wait-chain',
      reason: reason || 'reset'
    });
  }
}

/** Trusted Marks deals — only main-originated PO settles can mint Marks. */
const marksTrustedDeals = new Map();
const MARKS_TRUST_TTL_MS = 120000;
const MARKS_HOUSE_BOTS = new Set(['bot1', 'bot2', 'bot3']);

function marksDealKey(payload) {
  if (!payload || !payload.botId) return '';
  const outcome = String(payload.outcome || '').toLowerCase();
  const attempt = Number(payload.attempt) || 1;
  if (outcome === 'win') {
    return (
      String(payload.botId) +
      '|' +
      String(payload.dealId || payload.openId || payload.settleAt || '') +
      '|' +
      String(attempt)
    );
  }
  if (attempt >= 5 && (outcome === 'loss' || outcome === 'lose' || outcome === 'lost')) {
    return (
      'wipe|' +
      String(payload.botId) +
      '|' +
      String(payload.dealId || payload.openId || payload.settleAt || '') +
      '|a' +
      String(attempt)
    );
  }
  if (outcome === 'loss' || outcome === 'lose' || outcome === 'lost') {
    return (
      'loss|' +
      String(payload.botId) +
      '|' +
      String(payload.dealId || payload.openId || payload.settleAt || '') +
      '|' +
      String(attempt)
    );
  }
  return '';
}

function registerMarksTrustedDeal(payload) {
  if (!payload || !MARKS_HOUSE_BOTS.has(String(payload.botId || ''))) return;
  const st = ssidStatusByBot.get(payload.botId);
  const account = String((st && st.activeAccount) || loadAutotradeAccount(payload.botId) || '').toLowerCase();
  if (account !== 'real') return;
  const key = marksDealKey(payload);
  if (!key) return;
  marksTrustedDeals.set(key, { at: Date.now(), botId: payload.botId, account: 'real' });
  if (marksTrustedDeals.size > 200) {
    const now = Date.now();
    for (const [k, v] of marksTrustedDeals) {
      if (!v || now - Number(v.at || 0) > MARKS_TRUST_TTL_MS) marksTrustedDeals.delete(k);
    }
  }
}

ipcMain.handle('marks-verify-deal', async (_event, payload = {}) => {
  try {
    const key = String(payload.dedupeKey || marksDealKey(payload) || '');
    if (!key) return { ok: false, reason: 'missing-key' };
    const hit = marksTrustedDeals.get(key);
    if (!hit) return { ok: false, reason: 'untrusted' };
    if (Date.now() - Number(hit.at || 0) > MARKS_TRUST_TTL_MS) {
      marksTrustedDeals.delete(key);
      return { ok: false, reason: 'expired' };
    }
    // One-time consume so the same fake replay cannot farm Marks.
    marksTrustedDeals.delete(key);
    return { ok: true, botId: hit.botId, account: hit.account };
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
});

function notifyPoDealResult(payload) {
  try {
    registerMarksTrustedDeal(payload);
  } catch (e) {}
  BrowserWindow.getAllWindows().forEach((win) => {
    try { win.webContents.send('po-deal-result', payload); } catch (e) {}
  });
}

const poChainRecovery = createPoChainRecovery();

function patchSavingState(botId, patch) {
  if (!botId) return;
  const prev = autotradeSavingByBot.get(botId) || {};
  autotradeSavingByBot.set(botId, Object.assign({}, prev, patch, { at: Date.now() }));
}

/** After SSID WIN / DRAW / payout-stop, the next ticket is 1x — ignore bot candle history. */
function lockSavingTo1x(botId) {
  patchSavingState(botId, { historyNextAttempt: 1, forceNextAttempt1: true });
}

function clearSaving1xLock(botId) {
  const prev = autotradeSavingByBot.get(botId) || {};
  if (!prev.forceNextAttempt1) return;
  patchSavingState(botId, { forceNextAttempt1: false });
}

/**
 * Follow the Pocket Option ticket, not the bot card.
 * Pair-switch saves arrive as attempt 1 — those are still S1–S4 if the last
 * SSID fill is open, a LOSS, or a WIN freeze.
 */
function isSsidMartingaleFollowup(botId, sizeAttempt) {
  if (Number(sizeAttempt) > 1) return true;
  if (autotradeWaitChainByBot.get(botId)) return true;
  try {
    if (typeof poDealMonitor.isAccountChainOpen === 'function' && poDealMonitor.isAccountChainOpen(botId)) {
      return true;
    }
  } catch (e) {}
  try {
    if (poChainRecovery.getConfirmedLossCount(botId) > 0) return true;
  } catch (e2) {}
  return false;
}
const poWatchStore = createPoDealWatchStore({
  dir: () => getPoSsidDir(),
  log: (level, msg) => mainLog(level, msg)
});

const poDealMonitor = createPoDealMonitor({
  requestWorker: (req, timeoutMs) => poTradeWorker.request(req, timeoutMs),
  log: (level, msg) => mainLog(level, msg),
  persist: (entry) => poWatchStore.save(entry),
  clearPersist: (botId) => poWatchStore.clear(botId),
  onResult: (payload) => {
    try {
      const o = String(payload?.outcome || '').toLowerCase();
      if (payload?.botId && (o === 'win' || o === 'loss' || o === 'draw')) {
        poChainRecovery.noteOutcome(payload.botId, {
          dealId: payload.dealId,
          attempt: payload.attempt,
          outcome: payload.outcome
        });
      }
      if (payload?.botId && o === 'loss' && !payload.chainFreeze) {
        flushMgRetryOnLoss(payload.botId, payload);
      }
      if (payload?.botId && (o === 'win' || o === 'draw') && payload.chainFreeze) {
        pendingMgRetryByBot.delete(payload.botId);
      }
    } catch (e) {}
    if (payload?.chainFreeze && payload.botId) {
      const o = String(payload.outcome || '').toLowerCase();
      if (o === 'win' || o === 'draw' || o === 'payout') {
        autotradeWaitChainByBot.set(payload.botId, true);
        try { lockSavingTo1x(payload.botId); } catch (e) {}
        mainLog(
          'info',
          `[PO-Deal] ${payload.botId} account ${payload.outcome} — freezing MG autotrade until next chain`
        );
      }
    }
    notifyPoDealResult(payload);
  }
});

poTradeWorker.onLateResult = (req, res) => {
  try { poDealMonitor.applyWorkerResult(req, res); } catch (e) {}
  try {
    if (!res || res.success === false) return;
    if (res.online !== true && res.balance == null) return;
    if (!isValidDisplayBalance(res.balance)) return;
    for (const botId of ['bot1', 'bot2', 'bot3']) {
      const cur = ssidStatusByBot.get(botId);
      if (!cur || !cur.hasSsid) continue;
      if (cur.activeOnline && isValidDisplayBalance(cur.balance)) continue;
      const next = {
        ...cur,
        activeOnline: true,
        balance: res.balance,
        currency: res.currency || cur.currency,
        error: null,
        expired: false,
        lastOnlineAt: Date.now(),
        updatedAt: Date.now()
      };
      const acc = next.activeAccount === 'real' ? 'real' : 'demo';
      if (next[acc]) {
        next[acc] = {
          ...next[acc],
          online: true,
          balance: next.balance,
          currency: next.currency,
          error: null,
          expired: false
        };
      }
      ssidStatusByBot.set(botId, next);
      broadcastSsidStatus(botId);
    }
  } catch (e) {}
};

const poDealResume = createPoDealResume({
  monitor: poDealMonitor,
  store: poWatchStore,
  requestWorker: (req, timeoutMs) => poTradeWorker.request(req, timeoutMs),
  getSsid: (botId) => getActiveSsidForBot(botId),
  log: (level, msg) => mainLog(level, msg)
});

try {
  for (const id of ['bot1', 'bot2', 'bot3']) {
    const snap = poWatchStore.load(id);
    if (!snap) continue;
    const dur = Number(snap.durationSec) || 0;
    const cap = id === 'bot2' ? 90 : (id === 'bot3' ? 600 : 210);
    const remain = (Number(snap.settleAt) || 0) - Date.now();
    if (snap.placedByUs !== true || dur > cap || remain > cap * 1000 || remain < -120000) {
      mainLog('info', `[PO-Deal] ${id} purge leftover watch ${snap.dealId || '?'}`);
      poWatchStore.clear(id);
    }
  }
} catch (e) {}

async function fetchLivePayout(ssid, currency, durationSec) {
  if (!ssid || !currency) return { success: false, error: 'missing ssid/currency' };
  try {
    const req = {
      cmd: 'payout',
      ssid,
      currency: String(currency),
      fresh: true
    };
    const dur = Number(durationSec);
    if (Number.isFinite(dur) && dur > 0) req.duration = Math.round(dur);
    return await poTradeWorker.request(req, 5000);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Live SSID payout check.
 * - Fresh entry / mid-chain: never below 90 (90/91/92 OK).
 * - Mid-chain still runs recovery math after the absolute floor.
 */
async function assertLivePayoutFloor(
  botId,
  currency,
  minPayoutPct = 90,
  { enforceEntryFloor = true, absoluteFloor = 90, durationSec = null, signalPayoutPct = null } = {}
) {
  const entryMin = resolveMinPayoutPct(minPayoutPct, 90);
  const absFloor = Math.max(50, Math.min(entryMin, Math.round(Number(absoluteFloor) || 90)));
  const { ssid } = getActiveSsidForBot(botId);
  if (!ssid) {
    mainLog('warn', `[PO-Payout] ${botId} no ssid for min-payout gate — skip place`);
    return { allow: false, reason: 'no_ssid', payoutPct: null, minPayoutPct: entryMin };
  }

  const live = await fetchLivePayout(ssid, currency, durationSec);
  const ssidPct = Number(live?.payout);
  const catalogPct = Number(live?.catalog_payout);
  const signalPay = Number(signalPayoutPct);
  const listPay = lookupEdgeListPayout(currency);
  // Contabo Edge / bot list % matches the PO picker; SSID duration buckets
  // under-report (UI 92, SSID 84/87/88). Prefer list/signal over near-floor SSID.
  // Never override clearly junk catalog (e.g. 23%).
  const resolved = resolveGatePayoutPct({
    payoutPct: ssidPct,
    catalogPct,
    signalPay,
    listPay,
    absFloor
  });
  let payoutPct = resolved.payoutPct;
  if (resolved.source !== 'ssid') {
    mainLog(
      'info',
      `[PO-Payout] ${botId} ${currency} SSID=${Number.isFinite(ssidPct) ? ssidPct + '%' : '?'} ` +
        `catalog=${Number.isFinite(catalogPct) ? catalogPct + '%' : '?'} ` +
        `list=${Number.isFinite(listPay) ? listPay + '%' : '?'} ` +
        `signal=${Number.isFinite(signalPay) ? signalPay + '%' : '?'} ` +
        `— using ${resolved.source}=${payoutPct}%`
    );
  } else if (
    Number.isFinite(signalPay) &&
    signalPay >= absFloor &&
    (!Number.isFinite(payoutPct) || payoutPct < absFloor)
  ) {
    mainLog(
      'info',
      `[PO-Payout] ${botId} ${currency} ignore signal=${signalPay}% ` +
        `(SSID=${Number.isFinite(ssidPct) ? ssidPct + '%' : '?'} ` +
        `catalog=${Number.isFinite(catalogPct) ? catalogPct + '%' : '?'}) — account truth wins`
    );
  }

  const gate = assertMinLivePayout({
    payoutPct,
    minPayoutPct: entryMin,
    absoluteFloor: absFloor,
    lookupOk:
      !!(live?.success && Number.isFinite(payoutPct)) ||
      resolved.preferSignal ||
      resolved.preferList,
    enforceEntryFloor
  });

  if (!gate.allow) {
    mainLog(
      'info',
      `[PO-Payout] ${botId} ${currency} skip: live=${Number.isFinite(payoutPct) ? payoutPct + '%' : 'unknown'} ` +
        `ssid=${Number.isFinite(ssidPct) ? ssidPct + '%' : '?'} ` +
        `catalog=${live?.catalog_payout ?? '?'} list=${Number.isFinite(listPay) ? listPay + '%' : '?'} ` +
        `observed=${live?.observed_payout ?? 'none'} ` +
        `need>=${gate.minPayoutPct}% dur=${durationSec || '?'}s (${gate.reason}${live?.error ? ' ' + live.error : ''})`
    );
    // Do NOT note_observed on gate-skip — that self-poisons future gates
    // (SSID under-report 88 becomes a permanent observed floor).
    return { ...gate, asset: live?.asset || null, error: live?.error };
  }

  if (enforceEntryFloor) {
    mainLog(
      'info',
      `[PO-Payout] ${botId} ${currency} live=${payoutPct}% >= ${entryMin}% (entry) ` +
        `catalog=${live?.catalog_payout ?? payoutPct} observed=${live?.observed_payout ?? 'none'}`
    );
  } else {
    mainLog(
      'info',
      `[PO-Payout] ${botId} ${currency} live=${payoutPct}% mid-chain (>=${absFloor}% abs) — recovery next`
    );
  }
  return { ...gate, asset: live.asset || null };
}

/**
 * Mid-chain: live payout must still cover accumulated losses if this stake wins.
 * Absolute ≥90% is enforced by assertLivePayoutFloor (90/91/92 OK).
 */
async function assertPayoutRecoversLosses(botId, currency, nextStake, livePayoutPct) {
  const lossesSoFar = poChainRecovery.getLossesSoFar(botId);
  if (!(lossesSoFar > 0)) {
    return { allow: true, reason: 'no_losses', lossesSoFar: 0, payoutPct: livePayoutPct };
  }

  let payoutPct = Number(livePayoutPct);
  let asset = null;
  if (!Number.isFinite(payoutPct)) {
    const { ssid } = getActiveSsidForBot(botId);
    if (!ssid) {
      mainLog('warn', `[PO-Payout] ${botId} no ssid for recovery check — skip place`);
      return { allow: false, reason: 'no_ssid', lossesSoFar };
    }
    const live = await fetchLivePayout(ssid, currency);
    payoutPct = Number(live?.payout);
    asset = live?.asset || null;
    if (!live?.success || !Number.isFinite(payoutPct)) {
      mainLog(
        'warn',
        `[PO-Payout] ${botId} payout lookup failed (${live?.error || 'unknown'}) — skip place`
      );
      return { allow: false, reason: 'payout_unknown', lossesSoFar, error: live?.error };
    }
  }

  const check = recoveryCheck({
    lossesSoFar,
    nextStake,
    payoutPct
  });

  mainLog(
    'info',
    `[PO-Payout] ${botId} ${currency} payout=${payoutPct}% stake=$${Number(nextStake)} ` +
      `losses=$${lossesSoFar} winProfit=$${check.profitIfWin} need>=${check.minPayoutPct}% ` +
      `covers=${check.covers}`
  );

  if (!check.covers) {
    // 92% is the OTC cap. Never strand the last save when payout is already max.
    if (payoutPct + 1e-9 >= 92) {
      mainLog(
        'info',
        `[PO-Payout] ${botId} ${currency} payout=${payoutPct}% is max — placing anyway ` +
          `(win+$${check.profitIfWin} vs losses $${lossesSoFar})`
      );
      return { allow: true, reason: 'max_payout', ...check, asset };
    }
    return {
      allow: false,
      reason: 'insufficient_payout',
      ...check,
      asset
    };
  }
  return { allow: true, reason: 'covers', ...check, asset };
}

let signalHubWs = null;
let signalHubWsConnected = false;
let signalHubReconnectTimer = null;

function getWsServerUrl() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config && config.wsServer) return String(config.wsServer).trim();
  } catch (e) {}
  return 'wss://utkingdom.com/ws';
}

function getAutotradeEnabledFile(botId) {
  return path.join(getPoSsidDir(), `autotrade_enabled_${botId}.txt`);
}

function loadAutotradeEnabled(botId) {
  if (autotradeEnabledByBot.has(botId)) return autotradeEnabledByBot.get(botId);
  // Never auto-arm from last session. User must toggle Auto Trade on this launch.
  // Tray hide keeps the in-memory flag; full quit writes 0 and the process dies.
  autotradeEnabledByBot.set(botId, false);
  return false;
}

function saveAutotradeEnabled(botId, enabled) {
  const on = !!enabled;
  const prev = autotradeEnabledByBot.has(botId) ? autotradeEnabledByBot.get(botId) : null;
  autotradeEnabledByBot.set(botId, on);
  try {
    fs.writeFileSync(getAutotradeEnabledFile(botId), on ? '1' : '0', 'utf8');
  } catch (e) {}
  if (prev !== on) {
    mainLog('info', `[SignalHub] autotrade ${botId} ${on ? 'ENABLED' : 'disabled'}`);
  }
  syncAutotradePowerSave();
  return on;
}

let autotradeQuitLocked = false;

function disableAllAutotradeOnQuit(reason) {
  if (autotradeQuitLocked) return;
  autotradeQuitLocked = true;
  for (const id of ['bot1', 'bot2', 'bot3']) {
    try { saveAutotradeEnabled(id, false); } catch (e) {}
    try { resetSsidLadderToStart(id, reason || 'app-quit', { dropLive: true, waitForNew1x: false }); } catch (e) {}
  }
  BrowserWindow.getAllWindows().forEach((win) => {
    try { win.webContents.send('autotrade-force-off', { reason: reason || 'app-quit' }); } catch (e) {}
  });
  mainLog('info', `[SignalHub] autotrade OFF on ${reason || 'app-quit'}`);
}

let autotradePowerSaveId = null;
let autotradeKeepWarmTimer = null;

function anyAutotradeEnabled() {
  return ['bot1', 'bot2', 'bot3'].some((id) => loadAutotradeEnabled(id));
}

function warmAllActiveAutotradeSessions() {
  for (const botId of ['bot1', 'bot2', 'bot3']) {
    if (!loadAutotradeEnabled(botId)) continue;
    try {
      const { ssid } = getActiveSsidForBot(botId);
      if (!ssid) continue;
      warmPoTradeSession(ssid, '').catch(() => {});
    } catch (e) {}
  }
}

function syncAutotradeKeepWarm() {
  const on = anyAutotradeEnabled();
  if (on && !autotradeKeepWarmTimer) {
    // Never let the PO session go quiet while Auto Trade is armed.
    autotradeKeepWarmTimer = setInterval(warmAllActiveAutotradeSessions, 8000);
    warmAllActiveAutotradeSessions();
  } else if (!on && autotradeKeepWarmTimer) {
    clearInterval(autotradeKeepWarmTimer);
    autotradeKeepWarmTimer = null;
  }
}

function syncAutotradePowerSave() {
  try {
    if (anyAutotradeEnabled()) {
      if (autotradePowerSaveId == null || !powerSaveBlocker.isStarted(autotradePowerSaveId)) {
        autotradePowerSaveId = powerSaveBlocker.start('prevent-app-suspension');
        mainLog('info', '[SignalHub] powerSaveBlocker on (autotrade active)');
      }
    } else if (autotradePowerSaveId != null) {
      try { powerSaveBlocker.stop(autotradePowerSaveId); } catch (e) {}
      autotradePowerSaveId = null;
      mainLog('info', '[SignalHub] powerSaveBlocker off');
    }
  } catch (e) {}
  try { syncAutotradeKeepWarm(); } catch (e2) {}
}

function resolveCurrencyFromSignal(signal) {
  if (!signal) return '';
  const raw = String(signal.selectedCurrency || signal.symbol || signal.currency || '').trim();
  if (!raw) return '';
  const base = raw.replace(/\s*OTC/ig, '').trim();
  const hasOtc = /\botc\b/i.test(raw) || !!(signal.isOtc || signal.otc);
  return hasOtc ? `${base} OTC` : base;
}

function normalizePoTradeSide(side) {
  const s = String(side || '').toUpperCase().trim();
  if (s === 'BUY' || s === 'CALL') return 'BUY';
  if (s === 'SELL' || s === 'PUT') return 'SELL';
  return null;
}

function notifyFastTradeDone(botId, result, signalAtMs) {
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      win.webContents.send('fast-pocket-option-trade-done', { botId, result, signalAtMs });
    } catch (e) {}
  });
}

function parseOpeningTimeMs(value) {
  if (value == null || value === '' || value === 'N/A') return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 1e11) return Math.round(n);
  if (Number.isFinite(n) && n > 1e9) return Math.round(n * 1000);
  const s = String(value).trim();
  const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
  if (naive) {
    const ms = new Date(
      Number(naive[1]), Number(naive[2]) - 1, Number(naive[3]),
      Number(naive[4]), Number(naive[5]), Number(naive[6] || 0)
    ).getTime();
    return Number.isFinite(ms) ? Math.round(ms) : null;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stable signal identity for dedupe — never invent Date.now() as the identity. */
function resolveStableSignalIdentity(signal = {}) {
  const signalId = String(signal.signalId || '').trim();
  if (signalId) return { key: signalId, atMs: Number(signal.sentAtMs) || Number(signal.openedAtMs) || null };

  const sentAtMs = Number(signal.sentAtMs);
  if (Number.isFinite(sentAtMs) && sentAtMs > 0) {
    const attempt = Number(signal.attempt) || 1;
    return { key: `sent:${sentAtMs}:a${attempt}`, atMs: sentAtMs };
  }

  const openedAtMs = Number(signal.openedAtMs) || parseOpeningTimeMs(signal.openingTime);
  if (Number.isFinite(openedAtMs) && openedAtMs > 0) {
    const attempt = Number(signal.attempt) || 1;
    return { key: `open:${openedAtMs}:a${attempt}`, atMs: openedAtMs };
  }

  return { key: null, atMs: null };
}

/** True when this Trading Result belongs to the SSID ticket we are watching. */
function resultMatchesTrackedDeal(live, signal) {
  if (!live || !signal) return false;
  const sigAttempt = Number(signal.attempt || signal.sizeAttempt || 0);
  const liveAttempt = Number(live.signalAttempt || live.attempt) || 1;
  if (sigAttempt > 0 && liveAttempt > 0 && sigAttempt !== liveAttempt) return false;

  const openedAtMs = Number(signal.openedAtMs) || parseOpeningTimeMs(signal.openingTime);
  const settleAt = Number(live.settleAt) || 0;
  if (Number.isFinite(openedAtMs) && openedAtMs > 0 && settleAt > 0 && openedAtMs > settleAt + 2000) {
    return false;
  }
  return true;
}

function explainSsidTradeNotReady(botId) {
  if (!botId) return 'missing botId';
  if (!autotradeUiSyncedByBot.has(botId)) return 'UI not synced yet (toggle Auto Trade once)';
  if (!loadAutotradeEnabled(botId)) return 'autotrade disabled';
  const { ssid } = getActiveSsidForBot(botId);
  if (!ssid) return 'no SSID saved';
  const status = ssidStatusByBot.get(botId);
  if (status?.expired) return 'SSID expired';
  return null;
}

function isSsidTradeReady(botId) {
  return !explainSsidTradeNotReady(botId);
}

function isSsidSessionLikelyOnline(botId) {
  const status = ssidStatusByBot.get(botId);
  if (status?.activeOnline && !status?.expired) return true;
  const { ssid } = getActiveSsidForBot(botId);
  if (!ssid) return false;
  const needle = String(ssid).trim();
  for (const otherId of ['bot1', 'bot2', 'bot3']) {
    if (otherId === botId) continue;
    const other = getActiveSsidForBot(otherId);
    if (!other.ssid || String(other.ssid).trim() !== needle) continue;
    const otherStatus = ssidStatusByBot.get(otherId);
    if (otherStatus?.activeOnline && !otherStatus?.expired) return true;
  }
  // Have a live SSID and not marked expired — allow place (worker fails closed if dead).
  // Requiring activeOnline alone caused silent no-trades when status polls flickered.
  if (status && status.expired) return false;
  return !!ssid;
}

function getAutotradeBetFile(botId) {
  return path.join(getPoSsidDir(), `autotrade_bet_${botId}.txt`);
}

function saveAutotradeBet(botId, amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return;
  autotradeBetByBot.set(botId, n);
  try {
    fs.writeFileSync(getAutotradeBetFile(botId), String(n), 'utf8');
  } catch (e) {}
}

function loadAutotradeBet(botId) {
  const raw = readTextFileIfExists(getAutotradeBetFile(botId));
  const fromFile = parseFloat(raw);
  if (Number.isFinite(fromFile) && fromFile > 0) {
    autotradeBetByBot.set(botId, fromFile);
    return fromFile;
  }
  if (autotradeBetByBot.has(botId)) {
    const n = autotradeBetByBot.get(botId);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10;
}

async function readBetSizeFromUi(botId) {
  const id = JSON.stringify(`betSize-${botId}`);
  const script =
    `(() => { const el = document.getElementById(${id});` +
    ` if (!el) return null;` +
    ` if (el.dataset.hydrated !== '1' && el.dataset.touched !== '1') return null;` +
    ` const n = parseFloat(el.value);` +
    ` return (Number.isFinite(n) && n > 0) ? n : null; })()`;
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      const n = Number(await win.webContents.executeJavaScript(script, true));
      if (Number.isFinite(n) && n > 0) return n;
    } catch (e) {}
  }
  return null;
}

async function syncBetFromUi(botId) {
  const ui = await readBetSizeFromUi(botId);
  if (Number.isFinite(ui) && ui > 0) {
    saveAutotradeBet(botId, ui);
    return ui;
  }
  return loadAutotradeBet(botId);
}

const SAVING_SIGNAL_MODE_LADDERS = {
  '2x': [1, 2, 4, 10, 20],
  '4x': [1, 4, 7, 16, 44],
  custom: [1, 2, 5, 10, 25]
};

function normalizeSavingLadder(arr, mode) {
  const fallback = SAVING_SIGNAL_MODE_LADDERS[mode === '4x' ? '4x' : (mode === 'custom' ? 'custom' : '2x')]
    || SAVING_SIGNAL_MODE_LADDERS['2x'];
  if (!Array.isArray(arr) || arr.length < 5) return fallback.slice();
  return arr.slice(0, 5).map((n, i) => {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 1) return fallback[i];
    return Math.min(500, v);
  });
}

function resolveSavingMode(mode) {
  const m = String(mode || '2x').toLowerCase();
  if (m === '4x' || m === 'custom') return m;
  return '2x';
}

function resolveFastTradeAmount(botId, signal) {
  const base = loadAutotradeBet(botId);
  const saving = autotradeSavingByBot.get(botId) || { enabled: false, multiplier: 1, mode: '2x' };

  // When Saving Signals is OFF, always use the exact bet size — never follow
  // bot martingale stakeMultiplier (that was bumping $5 → $10 after a loss).
  if (!saving.enabled) {
    return { amount: Math.round(base * 100) / 100, sizeAttempt: 1 };
  }

  // UI strategy is source of truth (2x / 4x / custom ladder).
  const mode = resolveSavingMode(saving.mode);
  const ladder = normalizeSavingLadder(saving.ladder, mode);
  const botAttempt = Number(signal?.attempt);
  const fromBot = Number.isFinite(botAttempt) && botAttempt >= 1
    ? Math.min(Math.max(1, Math.trunc(botAttempt)), 5)
    : 1;
  // Same-pair MG: trust live attempt so a late retry cannot inherit the next
  // tier (old 2x→4x pre-bump). New-chain attempt 1 after a pair switch continues
  // the bot-wide loss ladder from history.
  const fromHistory = Math.min(5, Math.max(1, Math.trunc(Number(saving.historyNextAttempt) || 1)));
  const sizeAttempt = nextSizeAttempt({
    waitChain: !!autotradeWaitChainByBot.get(botId),
    forceNextAttempt1: !!saving.forceNextAttempt1,
    confirmedLosses: poChainRecovery.getConfirmedLossCount(botId),
    fromBot,
    fromHistory
  });
  const a = Math.min(Math.max(0, sizeAttempt - 1), 4);
  const mult = ladder[a] || 1;
  return { amount: Math.round(base * mult * 100) / 100, sizeAttempt };
}

function resolveFastTradeParams(botId, signal) {
  const prep = tradePrepByBot.get(botId);
  const signalCurrency = resolveCurrencyFromSignal(signal);
  // Always prefer the live signal pair. Prep can be stale when Preparing was
  // delayed/dropped (minimize) or when another bot warmed a different pair.
  const currency = signalCurrency || prep?.currency || '';
  if (prep?.currency && signalCurrency && prep.currency !== signalCurrency) {
    mainLog('warn', `[SignalHub] ${botId} prep currency stale (${prep.currency} -> ${signalCurrency})`);
  }
  const botKey = String(signal.bot || '').toUpperCase();
  const duration = resolveLivePlaceDurationSec(botKey, signal, prep?.duration);
  const sized = resolveFastTradeAmount(botId, signal);
  const amount = Number(sized && sized.amount);
  const sizeAttempt = Math.min(5, Math.max(1, Math.trunc(Number(sized && sized.sizeAttempt) || 1)));
  const botAttempt = Number(signal?.attempt);
  const gateAttempt = Number.isFinite(botAttempt) && botAttempt >= 1
    ? Math.min(Math.max(1, Math.trunc(botAttempt)), 5)
    : 1;
  try {
    const saving = autotradeSavingByBot.get(botId) || {};
    if (saving.enabled) {
      const histNext = Number(saving.historyNextAttempt) || 1;
      mainLog(
        'info',
        `[SignalHub] ${botId} saving mode=${resolveSavingMode(saving.mode)} ` +
          `botAttempt=${gateAttempt} save=${sizeAttempt} historyNext=${histNext} amount=$${amount}`
      );
    }
  } catch (e) {}
  return { currency, amount, duration, sizeAttempt, gateAttempt };
}

async function handleSignalHubTrade(signal) {
  const botKey = String(signal.bot || '').toUpperCase();
  const botId = BOT_NAME_TO_ID[botKey];
  if (!botId) {
    mainLog('warn', `[SignalHub] skip unknown bot=${botKey}`);
    return;
  }
  const notReady = explainSsidTradeNotReady(botId);
  if (notReady) {
    mainLog('warn', `[SignalHub] skip ${botId} Signal: ${notReady}`);
    return;
  }
  if (!isSsidSessionLikelyOnline(botId)) {
    mainLog('warn', `[SignalHub] skip ${botId} Signal: SSID session offline/expired`);
    return;
  }

  // Bot WIN / user stop / account freeze: skip leftover S2–S4. Next bot 1x places.
  if (shouldHoldForNewBotChain(autotradeWaitChainByBot.get(botId), signal.attempt)) {
    mainLog('info', `[SignalHub] skip ${botId}: waiting for new 1x (bot attempt=${signal.attempt || '?'})`);
    notifyPoDealResult({
      botId,
      outcome: 'idle',
      chainFreeze: true,
      skippedAttempt: Number(signal.attempt) || 0,
      freezeReason: 'waiting_new_1x',
      source: 'wait-chain'
    });
    return;
  }
  if (autotradeWaitChainByBot.get(botId)) {
    autotradeWaitChainByBot.set(botId, false);
    try { poDealMonitor.markChainIdle(botId); } catch (e) {}
    notifyPoDealResult({ botId, chainFreeze: false, outcome: 'resume', source: 'new-chain' });
  }

  const side = normalizePoTradeSide(signal.side || signal.action);
  if (!side) {
    mainLog('warn', `[SignalHub] skip ${botId}: missing side/action`);
    return;
  }

  // Don't await a renderer round-trip on the click path — that lagged SSID
  // Open ~1s behind the bot. Bet is already cached from toggle/input.
  syncBetFromUi(botId).catch(() => {});
  const { currency, amount, duration, sizeAttempt, gateAttempt } = resolveFastTradeParams(botId, signal);
  if (!currency || !Number.isFinite(amount) || amount <= 0 || duration <= 0) {
    mainLog('warn', `[SignalHub] skip ${botId}: missing trade params currency=${currency} amount=${amount} duration=${duration}`);
    return;
  }

  const identity = resolveStableSignalIdentity(signal);
  if (!identity.key) {
    mainLog('warn', `[SignalHub] skip ${botId}: missing stable signal id (no sentAtMs/signalId)`);
    return;
  }
  if (identity.atMs && (Date.now() - identity.atMs) > SIGNAL_ENTRY_MAX_AGE_MS) {
    mainLog('warn', `[SignalHub] skip ${botId}: stale signal age=${Date.now() - identity.atMs}ms`);
    return;
  }

  // Gate on the bot's chain attempt (pair-switch saves arrive as 1). Size/track with the history ladder.
  const attempt = gateAttempt;
  const joining = isJoinMidChainActive(botId, attempt);
  if (attempt > 5) {
    mainLog('warn', `[SignalHub] skip ${botId}: attempt=${attempt} over max 5 — not placing`);
    autotradeWaitChainByBot.set(botId, true);
    joinMidChainByBot.delete(botId);
    return;
  }

  let confirmedLosses = 0;
  try { confirmedLosses = poChainRecovery.getConfirmedLossCount(botId) || 0; } catch (e) {}
  if (confirmedLosses >= 5) {
    autotradeWaitChainByBot.set(botId, true);
    joinMidChainByBot.delete(botId);
    try { lockSavingTo1x(botId); } catch (e) {}
    try { poChainRecovery.clear(botId); } catch (e) {}
    try { poDealMonitor.markChainIdle(botId); } catch (e) {}
    mainLog('info', `[SignalHub] skip ${botId}: SSID 5-loss wipe — waiting for a new 1x`);
    return;
  }

  const followup = isSsidMartingaleFollowup(botId, sizeAttempt);
  if (attempt > 1 && !joining && !followup) {
    const live = poDealMonitor.get(botId);
    if (!live || live.placedByUs !== true) {
      mainLog(
        'info',
        `[SignalHub] skip ${botId} attempt=${attempt}: no SSID 1x was placed this chain`
      );
      return;
    }
  }
  if (joining) {
    mainLog(
      'info',
      `[SignalHub] ${botId} jump-in allowing attempt=${attempt} without a prior SSID 1x`
    );
  }
  const signalAtMs = identity.atMs || Date.now();
  const hubRecvMs = Date.now();
  let placeMinPayoutForWorker = 90;
  let approvedGatePayout = null;

  const liveSize = () => {
    const sized = resolveFastTradeAmount(botId, signal);
    return {
      amount: Number(sized && sized.amount),
      trackAttempt: Math.min(5, Math.max(1, Math.trunc(Number(sized && sized.sizeAttempt) || 1)))
    };
  };

  const place = () => {
    const sized = liveSize();
    const amountNow = sized.amount;
    const trackAttempt = sized.trackAttempt;
    if (!Number.isFinite(amountNow) || amountNow <= 0) {
      mainLog('warn', `[SignalHub] skip ${botId}: invalid sized amount=${amountNow}`);
      return Promise.resolve();
    }
    mainLog(
      'info',
      `[SignalHub] placing ${botId} ${side} ${currency} $${amountNow} ` +
        `save=${trackAttempt}x botAttempt=${attempt} dur=${duration}s base=$${loadAutotradeBet(botId)} ` +
        `minPay=${placeMinPayoutForWorker}%`
    );
    return runFastPoTrade({
      botId,
      side,
      currency,
      amount: amountNow,
      duration,
      signalAtMs,
      signalId: identity.key,
      attempt: trackAttempt,
      minPayout: placeMinPayoutForWorker,
      signalPayout: Number.isFinite(
        Number(signal && (signal.payout ?? signal.payoutPct ?? signal.payout_percent))
      )
        ? Math.round(Number(signal.payout ?? signal.payoutPct ?? signal.payout_percent))
        : null,
      listPayout: lookupEdgeListPayout(currency),
      gatePayout: Number.isFinite(Number(approvedGatePayout)) ? Math.round(Number(approvedGatePayout)) : null
    })
      .then((result) => {
        if (result?.success) {
          const hubLag = Date.now() - hubRecvMs;
          mainLog('info', `[SignalHub] ${botId} ${side} ${currency} $${amountNow} hub=${hubLag}ms signal_lag=${result.signal_lag_ms}ms`);
          try { joinMidChainByBot.delete(botId); } catch (e) {}
          try {
            poChainRecovery.notePlaced(botId, {
              attempt: trackAttempt,
              amount: amountNow,
              currency,
              dealId: result.deal_id || result.dealId || null
            });
          } catch (e) {}
          if (trackAttempt <= 1) {
            try { clearSaving1xLock(botId); } catch (e2) {}
          }
        } else if (result?.error && result.error !== 'duplicate' && result.error !== 'in-flight' && result.error !== 'in-flight shared ssid') {
          mainLog('warn', `[SignalHub] ${botId} trade skipped/failed: ${result.error}`);
          if (/payout\s+\d+%\s*<\s*\d+%/i.test(String(result.error)) || /payout lookup failed/i.test(String(result.error))) {
            autotradeWaitChainByBot.set(botId, true);
            try { poChainRecovery.clear(botId); } catch (e) {}
            try { lockSavingTo1x(botId); } catch (e) {}
            notifyPoDealResult({
              botId,
              outcome: 'payout',
              chainFreeze: true,
              skippedAttempt: trackAttempt,
              currency,
              payoutPct: result.payout,
              minPayoutPct: result.min_payout || placeMinPayoutForWorker,
              source: 'worker-payout-floor'
            });
          }
        }
        notifyFastTradeDone(botId, result, signalAtMs);
      })
      .catch((e) => notifyFastTradeDone(botId, { success: false, error: e.message }, signalAtMs));
  };

  const placeAfterPayoutGate = () => {
    const sized = liveSize();
    const amountNow = sized.amount;
    const trackAttempt = sized.trackAttempt;
    // Floor is 90 for entry and mid-chain (90/91/92 OK). Ignore stale signal 92 stamps.
    const signalFloor = 90;
    let lossesSoFar = 0;
    try { lossesSoFar = poChainRecovery.getLossesSoFar(botId) || 0; } catch (e) {}
    const enforceEntryFloor = !(lossesSoFar > 0);
    placeMinPayoutForWorker = 90;
    const signalPayRaw = Number(
      signal && (signal.payout ?? signal.payoutPct ?? signal.payout_percent)
    );
    assertLivePayoutFloor(botId, currency, signalFloor, {
      enforceEntryFloor,
      absoluteFloor: 90,
      durationSec: duration,
      signalPayoutPct: Number.isFinite(signalPayRaw) ? signalPayRaw : null
    })
      .then((floor) => {
        if (!floor?.allow) {
          autotradeWaitChainByBot.set(botId, true);
          try { poChainRecovery.clear(botId); } catch (e) {}
          try { lockSavingTo1x(botId); } catch (e) {}
          mainLog(
            'info',
            `[SignalHub] skip ${botId} attempt=${trackAttempt}: live payout ` +
              `${floor.payoutPct == null ? 'unknown' : floor.payoutPct + '%'} < ${floor.minPayoutPct}%`
          );
          notifyPoDealResult({
            botId,
            outcome: 'payout',
            chainFreeze: true,
            skippedAttempt: trackAttempt,
            currency,
            payoutPct: floor.payoutPct,
            minPayoutPct: floor.minPayoutPct,
            source: 'payout-floor'
          });
          return null;
        }
        return assertPayoutRecoversLosses(botId, currency, amountNow, floor.payoutPct);
      })
      .then((pay) => {
        if (!pay) return;
        if (!pay?.allow) {
          autotradeWaitChainByBot.set(botId, true);
          try { poChainRecovery.clear(botId); } catch (e) {}
          try { lockSavingTo1x(botId); } catch (e) {}
          mainLog(
            'info',
            `[SignalHub] skip ${botId} attempt=${trackAttempt}: payout ${pay.payoutPct}% ` +
              `win+$${pay.profitIfWin} < losses $${pay.lossesSoFar} (need >=${pay.minPayoutPct}%)`
          );
          notifyPoDealResult({
            botId,
            outcome: 'payout',
            chainFreeze: true,
            skippedAttempt: trackAttempt,
            currency,
            payoutPct: pay.payoutPct,
            profitIfWin: pay.profitIfWin,
            lossesSoFar: pay.lossesSoFar,
            minPayoutPct: pay.minPayoutPct,
            shortfall: pay.shortfall,
            nextStake: pay.nextStake,
            source: 'payout-recovery'
          });
          return;
        }
        approvedGatePayout = Number(pay.payoutPct);
        place();
      })
      .catch((e) => {
        mainLog('warn', `[SignalHub] ${botId} payout gate error (${e.message}) — skip place`);
        if (trackAttempt > 1) autotradeWaitChainByBot.set(botId, true);
      });
  };

  // Genuine new 1x only when the account chain is idle.
  // Pair-switch attempt 1 after a LOSS must wait for PO, then place S1.
  if (!followup && attempt <= 1) {
    const canPlace = poDealMonitor.canPlaceAttempt(botId, 1);
    if (!canPlace?.allow) {
      mainLog(
        'info',
        `[SignalHub] skip ${botId} attempt=1: ${canPlace?.reason || 'blocked'} — previous PO deal still open`
      );
      notifyPoDealResult({
        botId,
        outcome: 'idle',
        chainFreeze: false,
        skippedAttempt: 1,
        freezeReason: canPlace?.reason || 'previous_still_open',
        source: 'place-gate'
      });
      return;
    }
    autotradeWaitChainByBot.set(botId, false);
    pendingMgRetryByBot.delete(botId);
    joinMidChainByBot.delete(botId);
    try { poChainRecovery.clear(botId); } catch (e) {}
    placeAfterPayoutGate();
    return;
  }

  if (joining && !followup) {
    const live = poDealMonitor.get(botId);
    if (!live || live.placedByUs !== true) {
      mainLog(
        'info',
        `[SignalHub] ${botId} jump-in placing attempt=${attempt} at $${amount} (no tracked SSID 1x)`
      );
      placeAfterPayoutGate();
      return;
    }
  }

  const runMgGate = () => {
  // Place S1–S4 now unless user history shows a WIN on the last ticket
  // (bot lost, account paid). Do not wait 22s for check_win.
  const prev = poDealMonitor.get(botId);
  mainLog(
    'info',
    `[SignalHub] ${botId} MG gate start attempt=${attempt} timeout=500ms prev=${prev?.outcome || (prev?.pending ? 'pending' : 'none')}`
  );
  poDealMonitor.gateMartingale(botId, { timeoutMs: 500 })
    .then((gate) => {
      mainLog('info', `[SignalHub] ${botId} MG gate done allow=${!!gate?.allow} reason=${gate?.reason || '?'}`);
      if (!gate?.allow) {
        const out = String(gate?.entry?.outcome || '').toLowerCase();
        const confirmedStop = out === 'win' || out === 'draw'
          || gate?.reason === 'account_win' || gate?.reason === 'account_draw_1x';
        if (confirmedStop) {
          autotradeWaitChainByBot.set(botId, true);
          pendingMgRetryByBot.delete(botId);
          try { lockSavingTo1x(botId); } catch (e) {}
        } else {
          pendingMgRetryByBot.set(botId, {
            at: Date.now(),
            attempt,
            dealId: gate?.entry?.dealId || prev?.dealId || null,
            run: () => placeAfterPayoutGate()
          });
        }
        const why = gate?.reason === 'previous_still_open'
          ? 'previous PO deal still open'
          : gate?.reason === 'no-tracked-deal'
            ? 'no tracked PO deal'
            : gate?.reason === 'account_win'
              ? 'user history WIN'
            : `account ${gate?.entry?.outcome || gate?.reason || 'unknown'}`;
        mainLog(
          'info',
          `[SignalHub] skip ${botId} attempt=${attempt}: ${why} — not escalating MG`
        );
            notifyPoDealResult({
          botId,
          dealId: gate?.entry?.dealId,
          outcome: confirmedStop ? (gate?.entry?.outcome || 'win') : 'idle',
          freezeReason: gate?.reason || 'pending_fail_closed',
          profit: gate?.entry?.profit,
          attempt: gate?.entry?.attempt,
          currency: gate?.entry?.currency,
          chainFreeze: confirmedStop,
          skippedAttempt: attempt,
          waitingLoss: !confirmedStop,
          source: confirmedStop ? 'mg-gate' : 'new-chain'
        });
        return;
      }
      placeAfterPayoutGate();
    })
    .catch((e) => {
      mainLog('warn', `[SignalHub] ${botId} MG gate error (${e.message}) — skip place`);
      if (attempt > 1) autotradeWaitChainByBot.set(botId, true);
    });
  };

  const have = poDealMonitor.get(botId);
  const beginGate = () => {
    runMgGate();
  };
  if (have) {
    beginGate();
    return;
  }
  poDealResume.resume(botId, { currency, side, amount, attempt, duration })
    .catch((e) => {
      mainLog('warn', `[PO-Deal] ${botId} resume failed: ${e && e.message ? e.message : e}`);
    })
    .finally(() => beginGate());
}

function handleSignalHubMessage(text) {
  let signal;
  try { signal = JSON.parse(text); } catch (e) { return; }
  if (!signal || signal.type === 'pong') return;
  if (signal.clear) return;

  const phase = String(signal.phase || '').trim().toLowerCase();
  const botKey = String(signal.bot || '').toUpperCase();
  const botId = BOT_NAME_TO_ID[botKey];
  if (!botId) return;

  if (phase === 'chain complete') {
    const won = !!(signal.chainWon || String(signal.result || '').toUpperCase() === 'WIN');
    // Strategy may stop a pair after 2 clicks. Live saving still runs 5 steps
    // across hops — only a WIN (or a 5-wipe) resets to 1x.
    if (won) {
      resetSsidLadderToStart(botId, 'chain won — next place is 1x', { waitForNew1x: true });
    }
    return;
  }

  if (phase === 'preparing') {
    const currency = resolveCurrencyFromSignal(signal);
    if (currency && isSsidTradeReady(botId)) {
      // LUMIX/MIRAX expiry is fixed — Preparing countdown is the wait, not the trade.
      // NYX picks 20s–10m; cache that so SSID places the timeframe it chose.
      const duration = botKey === 'NYX' ? resolveTradeDurationSec(botKey, signal) : null;
      cacheTradePrep(botId, { currency, duration });
      const { ssid } = getActiveSsidForBot(botId);
      if (ssid) warmPoTradeSession(ssid, currency).catch(() => {});
    }
    return;
  }

  if (phase === 'trading result' || phase === 'result') {
    const raw = String(signal.result || signal.outcome || '').trim().toLowerCase();
    let hintOutcome = null;
    if (raw === 'win' || raw === 'won' || raw === 'w') hintOutcome = 'win';
    else if (raw === 'loss' || raw === 'lose' || raw === 'lost' || raw === 'l') hintOutcome = 'loss';
    else if (raw === 'draw' || raw === 'tie' || raw === 'equal') hintOutcome = 'draw';
    // Bot WIN ends the chain. Do not keep placing S2–S4 after the user stops.
    if (hintOutcome === 'win') {
      resetSsidLadderToStart(botId, 'bot WIN — next place is 1x', { waitForNew1x: true });
    }
    const live = poDealMonitor.get(botId);
    if (live && live.pending) {
      const sigCur = resolveCurrencyFromSignal(signal);
      if (live.currency && sigCur) {
        const a = String(live.currency).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const b = String(sigCur).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (a && b && !(a.includes(b) || b.includes(a))) {
          mainLog('info', `[PO-Deal] ${botId} ignore result ${sigCur} (watching ${live.currency})`);
          return;
        }
      }
      if (!resultMatchesTrackedDeal(live, signal)) {
        mainLog(
          'info',
          `[PO-Deal] ${botId} ignore later result attempt=${signal.attempt || '?'} ` +
            `(watching deal attempt=${live.signalAttempt || live.attempt} ${live.dealId})`
        );
        return;
      }
      mainLog('info', `[PO-Deal] ${botId} trade ended result=${hintOutcome || raw || '?'}`);
      poDealMonitor.settleNow(botId, { hintOutcome }).catch((e) => {
        mainLog('warn', `[PO-Deal] ${botId} settleNow failed: ${e && e.message ? e.message : e}`);
      });
    }
    return;
  }

  if (phase !== 'signal') return;
  if (signal.updateOnly || String(signal.updateKind || '').toLowerCase() === 'openingprice') return;
  lastHubSignalByBot.set(botId, { signal, at: Date.now() });
      handleSignalHubTrade(signal).catch((e) => {
        try { mainLog('warn', `[SignalHub] trade handler failed: ${e && e.message ? e.message : e}`); } catch (e2) {}
      });
}

function scheduleSignalHubReconnect() {
  signalHubWsConnected = false;
  if (signalHubReconnectTimer) return;
  signalHubReconnectTimer = setTimeout(() => {
    signalHubReconnectTimer = null;
    startSignalHubWs();
  }, 2500);
}

function startSignalHubWs() {
  const url = getWsServerUrl();
  try {
    if (signalHubWs) {
      try { signalHubWs.removeAllListeners(); signalHubWs.terminate(); } catch (e) {}
      signalHubWs = null;
    }
    signalHubWs = new WebSocket(url);
  } catch (e) {
    scheduleSignalHubReconnect();
    return;
  }

  signalHubWs.on('open', () => {
    signalHubWsConnected = true;
    mainLog('info', `[SignalHub] connected ${url}`);
    syncAutotradePowerSave();
    poTradeWorker.ensureStarted().catch(() => {});
    BrowserWindow.getAllWindows().forEach((win) => {
      try { win.webContents.send('signal-hub-status', { connected: true }); } catch (e) {}
    });
  });

  signalHubWs.on('message', (data) => {
    try {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      try {
        const peek = JSON.parse(text);
        const bot = String(peek && peek.bot || '').toUpperCase();
        const phase = String(peek && peek.phase || '');
        if (bot && phase && phase.toLowerCase() !== 'preparing') {
          mainLog(
            'info',
            `[SignalHub] recv ${bot} ${phase} ${peek.selectedCurrency || peek.symbol || ''} ` +
              `attempt=${peek.attempt || '?'} payout=${peek.payout ?? '?'}`
          );
        }
      } catch (_) {}
      handleSignalHubMessage(text);
    } catch (e) {}
  });

  signalHubWs.on('close', () => {
    signalHubWsConnected = false;
    BrowserWindow.getAllWindows().forEach((win) => {
      try { win.webContents.send('signal-hub-status', { connected: false }); } catch (e) {}
    });
    scheduleSignalHubReconnect();
  });

  signalHubWs.on('error', () => {});
}

async function executePoTradeFast({ ssid, currency, side, amount, duration, minPayout = 90, signalPayout = null, listPayout = null, gatePayout = null }) {
  // Prefer the long-lived worker. Never fall back after a timeout — that
  // double-places when the first buy already succeeded but the reply was late.
  try {
    await poTradeWorker.ensureStarted();
  } catch (e) {
    mainLog('warn', `[PO-Trade] worker start failed, one-shot fallback: ${e.message}`);
    return runPythonJsonScript('execute_trade.py', [
      '--ssid', ssid,
      '--currency', String(currency),
      '--side', String(side).toUpperCase(),
      '--amount', String(amount),
      '--duration', String(Math.round(duration)),
      '--json-only'
    ], 20000);
  }

  const workerReq = {
    cmd: 'trade',
    ssid,
    currency: String(currency),
    side: String(side).toUpperCase(),
    amount: Number(amount),
    duration: Math.round(Number(duration)),
    min_payout: Math.round(Number(minPayout) || 90)
  };
  const sig = Number(signalPayout);
  if (Number.isFinite(sig) && sig >= 50) workerReq.signal_payout = Math.round(sig);
  const list = Number(listPayout);
  if (Number.isFinite(list) && list >= 80) workerReq.list_payout = Math.round(list);
  const gated = Number(gatePayout);
  if (Number.isFinite(gated) && gated >= 50) workerReq.gate_payout = Math.round(gated);

  const workerResult = await poTradeWorker.request(workerReq, 8000);

  if (workerResult && workerResult.success) return workerResult;

  const err = String(workerResult?.error || 'trade failed');
  if (err === 'worker timeout' || err.includes('timeout')) {
    mainLog('warn', `[PO-Trade] worker timeout — NOT retrying (prevents double entry)`);
    return { success: false, error: 'worker timeout (not retried)' };
  }
  // Worker died mid-request: fail closed rather than risk a second place.
  if (!poTradeWorker.proc) {
    mainLog('warn', `[PO-Trade] worker dead after fail — NOT falling back: ${err}`);
    return { success: false, error: err };
  }
  // Dead PO socket: worker already closes+retries once; if it still failed, surface it.
  if (/half closed|connection closed|sender error|not connected|1006|websocket/i.test(err)) {
    mainLog('warn', `[PO-Trade] socket fail after reconnect attempt: ${err}`);
  }
  return workerResult || { success: false, error: err };
}

async function warmPoTradeSession(ssid, currency) {
  if (!ssid) return { success: false, error: 'missing ssid' };
  const cur = String(currency || '').trim();
  return poTradeWorker.request({
    cmd: 'warm',
    ssid,
    currency: cur
  }, 30000);
}

async function connectPoSsidSession(ssid, currency) {
  if (!ssid) return { success: false, error: 'missing ssid' };
  let last = { success: false, error: 'not started' };
  for (let i = 0; i < 2; i++) {
    try {
      await poTradeWorker.ensureStarted();
    } catch (e) {
      last = { success: false, error: (e && e.message) || 'Python helper failed to start' };
      mainLog('warn', `[SSID] helper start try ${i + 1}: ${last.error}`);
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      continue;
    }
    last = await warmPoTradeSession(ssid, currency || '');
    if (last && last.success && last.online !== false) {
      mainLog('info', `[SSID] worker session online (try ${i + 1})`);
      return last;
    }
    if (last && last.expired) return last;
    mainLog('warn', `[SSID] warm try ${i + 1} failed: ${(last && last.error) || 'unknown'}`);
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return last || { success: false, error: 'could not connect Pocket Option' };
}

async function reconnectSavedSsidSessions() {
  let found = null;
  for (const botId of ['bot1', 'bot2', 'bot3']) {
    const active = getActiveSsidForBot(botId);
    if (active && active.ssid) {
      found = { ...active, botId };
      break;
    }
  }
  if (!found) return;
  mainLog('info', `[SSID] reconnecting saved ${found.account || ''} session for ${found.botId}`);
  const connected = await connectPoSsidSession(found.ssid, found.currency || '');
  if (!connected || !connected.success) {
    mainLog('warn', `[SSID] saved session still offline: ${(connected && connected.error) || 'unknown'}`);
  }
  for (const botId of ['bot1', 'bot2', 'bot3']) {
    const active = getActiveSsidForBot(botId);
    if (!active || !active.ssid) continue;
    await refreshSsidStatusForBot(botId, { force: true });
  }
}

async function closePoTradeSession(ssid) {
  if (!ssid) return;
  try {
    await poTradeWorker.request({ cmd: 'close', ssid }, 8000);
  } catch (e) {}
}

function cacheTradePrep(botId, prep = {}) {
  const { ssid } = getActiveSsidForBot(botId);
  if (!ssid) return;
  tradePrepByBot.set(botId, {
    ssid,
    currency: prep.currency || null,
    amount: prep.amount || null,
    duration: prep.duration || null,
    at: Date.now()
  });
}

function ssidLockKey(ssid) {
  return String(ssid || '').trim().slice(0, 160);
}

/** Best-known Pocket Option balance for this bot (shared SSID uses sibling). */
function resolveKnownBalanceForBot(botId) {
  const status = ssidStatusByBot.get(botId);
  const direct = Number(status && status.balance);
  if (Number.isFinite(direct) && direct > 0) return direct;

  try {
    const { ssid } = getActiveSsidForBot(botId);
    if (!ssid) return null;
    const needle = String(ssid).trim();
    for (const otherId of ['bot1', 'bot2', 'bot3']) {
      if (otherId === botId) continue;
      const other = getActiveSsidForBot(otherId);
      if (!other.ssid || String(other.ssid).trim() !== needle) continue;
      const ob = Number(ssidStatusByBot.get(otherId)?.balance);
      if (Number.isFinite(ob) && ob > 0) return ob;
    }
  } catch (e) {}
  return null;
}

function maxAllowedStakeForBot(botId) {
  const base = loadAutotradeBet(botId);
  const saving = autotradeSavingByBot.get(botId) || { enabled: false, mode: '2x' };
  if (!saving.enabled) return Math.round(base * 100) / 100;
  const maxMult = Math.max.apply(null, normalizeSavingLadder(saving.ladder, resolveSavingMode(saving.mode)));
  return Math.round(base * maxMult * 100) / 100;
}

/**
 * Reject bets that would wipe / exceed the wallet.
 * Returns null if OK, or an error string.
 */
function assertTradeAmountSafe(botId, amount, ssid) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 'invalid amount';

  const maxStake = maxAllowedStakeForBot(botId);
  if (amt > maxStake * 1.001) {
    return `amount $${amt} exceeds max ladder $${maxStake}`;
  }

  const balance = resolveKnownBalanceForBot(botId);
  const key = ssidLockKey(ssid);
  const reserved = Number(reservedStakeBySsid.get(key)?.amount) || 0;
  if (Number.isFinite(balance) && balance > 0) {
    const available = balance - reserved;
    // Never allow amount >= full balance (would wipe wallet).
    if (amt >= balance) {
      return `insufficient balance: need $${amt} have $${balance} (refusing full-balance bet)`;
    }
    if (amt > available) {
      return `insufficient balance: need $${amt} available $${Math.max(0, available).toFixed(2)} (reserved $${reserved})`;
    }
  } else {
    // Soft: SSID connected but balance poll not ready yet — allow small stakes
    // so autotrade is not dead while the pill already shows connected.
    if (amt > 50) {
      return 'balance unknown (refusing trade)';
    }
  }
  return null;
}

function resolveStudioDonorBotId(preferred) {
  const prefer = String(preferred || '').trim();
  if (prefer && ['bot1', 'bot2', 'bot3'].includes(prefer)) {
    try {
      const { ssid } = getActiveSsidForBot(prefer);
      const status = ssidStatusByBot.get(prefer);
      if (ssid && !(status && status.expired)) return prefer;
    } catch (e) {}
  }
  for (const id of ['bot1', 'bot2', 'bot3']) {
    try {
      const { ssid } = getActiveSsidForBot(id);
      if (!ssid) continue;
      const status = ssidStatusByBot.get(id);
      if (status && status.expired) continue;
      return id;
    } catch (e) {}
  }
  return null;
}

function isStudioTradeBotId(botId) {
  const id = String(botId || '').toLowerCase();
  return id === 'studio' || id.startsWith('studio:') || id.startsWith('studio-');
}

async function runFastPoTrade(payload = {}) {
  let botId = payload.botId || payload.bot;
  const studioTrade = isStudioTradeBotId(botId) || payload.studioTrade === true;
  if (studioTrade) {
    const donor = resolveStudioDonorBotId(payload.donorBotId);
    if (!donor) {
      return { success: false, error: 'no SSID saved — connect Pocket Option first' };
    }
    botId = donor;
  }
  const side = String(payload.side || '').toUpperCase();
  const currency = String(payload.currency || '');
  const amount = Number(payload.amount);
  // Always snap — mid-candle remain (57/58s) was rejecting every NYX 1m place.
  const duration = snapPoPlaceDuration(Math.round(Number(payload.duration || payload.durationSec || 0)));
  const attempt = Number(payload.attempt) || 1;
  const signalId = String(payload.signalId || '').trim();
  const signalAtMs = Number(payload.signalAtMs) || Date.now();
  const minPayout = resolveMinPayoutPct(payload.minPayout ?? payload.min_payout, 90);
  const signalPayoutRaw = Number(payload.signalPayout ?? payload.signal_payout);
  const signalPayout = Number.isFinite(signalPayoutRaw) ? Math.round(signalPayoutRaw) : null;
  const listPayoutRaw = Number(payload.listPayout ?? payload.list_payout);
  const listPayout = Number.isFinite(listPayoutRaw) ? Math.round(listPayoutRaw) : lookupEdgeListPayout(currency);
  const gatePayoutRaw = Number(payload.gatePayout ?? payload.gate_payout);
  const gatePayout = Number.isFinite(gatePayoutRaw) ? Math.round(gatePayoutRaw) : null;

  if (!botId || !side || !currency || !Number.isFinite(amount) || amount <= 0 || duration <= 0) {
    return { success: false, error: 'invalid payload' };
  }

  // Studio borrows the donor SSID without requiring that house bot's Auto Trade toggle.
  if (studioTrade) {
    const { ssid: studioSsid } = getActiveSsidForBot(botId);
    if (!studioSsid) {
      return { success: false, error: 'no SSID saved — connect Pocket Option first' };
    }
    const st = ssidStatusByBot.get(botId);
    if (st && st.expired) {
      return { success: false, error: 'SSID expired' };
    }
  } else if (!isSsidTradeReady(botId) && payload.bypassReadyCheck !== true) {
    // Hard gate: UI synced + toggle on + SSID present (not expired).
    return { success: false, error: explainSsidTradeNotReady(botId) || 'ssid not ready' };
  }

  // Stable dedupe — never use bare Date.now() as identity.
  // Studio keys stay distinct from house so a shared donor doesn't drop studio fills.
  const identityKey = signalId || `fallback:${side}:${currency}:a${attempt}:${signalAtMs}`;
  const dedupeOwner = studioTrade ? (`studio:${botId}`) : botId;
  const dedupeKey = `${dedupeOwner}:${identityKey}`;
  if (lastFastTradeKeyByBot.get(dedupeOwner) === dedupeKey) {
    return { success: false, error: 'duplicate' };
  }
  if (inFlightTradeByBot.get(botId)) {
    return { success: false, error: 'in-flight' };
  }

  const { ssid, account } = getActiveSsidForBot(botId);
  if (!ssid) {
    return { success: false, error: `No ${account || 'demo'} SSID saved for ${botId}` };
  }
  const ssidKey = ssidLockKey(ssid);
  if (inFlightTradeBySsid.get(ssidKey)) {
    return { success: false, error: 'in-flight shared ssid' };
  }

  // Never force a status poll here — it shares the trade worker stdin with
  // buy(), so it delayed the PO fill vs the bot Open time.
  const safetyErr = assertTradeAmountSafe(botId, amount, ssid);
  if (safetyErr) {
    mainLog('warn', `[PO-Trade] ${botId} blocked: ${safetyErr}`);
    return { success: false, error: safetyErr };
  }

  // Reserve before await so concurrent hub+renderer / dual-bot calls collapse.
  lastFastTradeKeyByBot.set(dedupeOwner, dedupeKey);
  inFlightTradeByBot.set(botId, true);
  inFlightTradeBySsid.set(ssidKey, botId);
  reservedStakeBySsid.set(ssidKey, {
    amount: (Number(reservedStakeBySsid.get(ssidKey)?.amount) || 0) + amount,
    at: Date.now()
  });

  try {
    const prep = tradePrepByBot.get(botId);
    const status = ssidStatusByBot.get(botId);
    if (status && status.expired) {
      return { success: false, error: 'SSID expired' };
    }

    const tradeStarted = Date.now();
    const result = await executePoTradeFast({
      ssid,
      currency,
      side,
      amount,
      duration,
      minPayout,
      signalPayout,
      listPayout,
      gatePayout
    });
    const totalMs = Date.now() - tradeStarted;
    const signalLagMs = Date.now() - signalAtMs;

    if (result && result.success) {
      mainLog('info', `[PO-Trade] FAST ${botId} ${side} ${currency} $${amount} api=${result.latency_ms || '?'}ms total=${totalMs}ms lag=${signalLagMs}ms`);
      if (prep) {
        tradePrepByBot.set(botId, { ...prep, currency, at: Date.now() });
      }
      // Track deal so we can settle REAL account W/L via SSID (not candle guess).
      try {
        const dealId = result.deal_id || result.dealId;
        if (dealId) {
          poDealMonitor.trackPlaced(botId, {
            dealId,
            ssid,
            currency,
            side,
            amount,
            attempt,
            durationSec: duration,
            placedAt: Date.now(),
            settleAt: result.settle_at || result.settleAt || undefined,
            placedByUs: true,
            openedAtMs: signalAtMs,
            signalAttempt: attempt
          });
        }
      } catch (e) {}
      // Optimistically lower cached balance so a second bot can't race the same wallet.
      try {
        const bal = resolveKnownBalanceForBot(botId);
        if (Number.isFinite(bal) && bal > 0) {
          const nextBal = Math.max(0, bal - amount);
          const st = ssidStatusByBot.get(botId);
          if (st) ssidStatusByBot.set(botId, { ...st, balance: nextBal });
          for (const otherId of ['bot1', 'bot2', 'bot3']) {
            if (otherId === botId) continue;
            const other = getActiveSsidForBot(otherId);
            if (other.ssid && ssidLockKey(other.ssid) === ssidKey) {
              const ost = ssidStatusByBot.get(otherId);
              if (ost) ssidStatusByBot.set(otherId, { ...ost, balance: nextBal });
            }
          }
        }
      } catch (e) {}
      setTimeout(() => refreshSsidStatusForBot(botId, { force: true }).catch(() => {}), 45000);
    } else {
      mainLog('warn', `[PO-Trade] FAST fail ${botId}: ${result?.error || 'unknown'}`);
      // Transient socket fails should not permanently lock this signal id.
      try {
        if (lastFastTradeKeyByBot.get(dedupeOwner) === dedupeKey) {
          lastFastTradeKeyByBot.delete(dedupeOwner);
        }
      } catch (e) {}
    }

    return { ...(result || { success: false }), total_ms: totalMs, signal_lag_ms: signalLagMs };
  } finally {
    inFlightTradeByBot.delete(botId);
    if (inFlightTradeBySsid.get(ssidKey) === botId) inFlightTradeBySsid.delete(ssidKey);
    const reserved = reservedStakeBySsid.get(ssidKey);
    if (reserved) {
      const left = Math.max(0, Number(reserved.amount) - amount);
      if (left <= 0.0001) reservedStakeBySsid.delete(ssidKey);
      else reservedStakeBySsid.set(ssidKey, { amount: left, at: Date.now() });
    }
  }
}

function getAutotradeAccountFile(botId) {
  return path.join(getPoSsidDir(), `autotrade_account_${botId}.txt`);
}

function loadAutotradeAccount(botId) {
  if (ssidAutotradeAccount.has(botId)) {
    return ssidAutotradeAccount.get(botId);
  }
  const fromFile = readTextFileIfExists(getAutotradeAccountFile(botId));
  const mode = (fromFile === 'real') ? 'real' : 'demo';
  ssidAutotradeAccount.set(botId, mode);
  return mode;
}

function saveAutotradeAccount(botId, mode) {
  const normalized = mode === 'real' ? 'real' : 'demo';
  ssidAutotradeAccount.set(botId, normalized);
  try {
    fs.writeFileSync(getAutotradeAccountFile(botId), normalized, 'utf8');
  } catch (e) {}
  return normalized;
}

function detectAccountFromSsid(ssid) {
  if (!ssid || typeof ssid !== 'string') return null;
  const raw = ssid.trim();
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}') + 1;
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const auth = JSON.parse(raw.slice(jsonStart, jsonEnd));
      return auth.isDemo === 1 || auth.isDemo === true ? 'demo' : 'real';
    } catch (e) {}
  }
  if (raw.includes('"isDemo":1') || raw.includes('"isDemo": 1')) return 'demo';
  if (raw.includes('"isDemo":0') || raw.includes('"isDemo": 0')) return 'real';
  return null;
}

function getAccountCurrencyFile(botId, account) {
  const acc = account === 'real' ? 'real' : 'demo';
  return path.join(getPoSsidDir(), `account_currency_${botId}_${acc}.txt`);
}

function loadAccountCurrency(botId, account) {
  const acc = account === 'real' ? 'real' : 'demo';
  const fromFile = readTextFileIfExists(getAccountCurrencyFile(botId, acc))
    || readTextFileIfExists(path.join(getPoSsidDir(), `account_currency_${botId}.txt`));
  if (fromFile) return fromFile.toUpperCase();
  return acc === 'real' ? 'EUR' : 'USD';
}

function saveAccountCurrency(botId, currency, account) {
  const acc = account === 'real' ? 'real' : 'demo';
  const normalized = String(currency || 'USD').toUpperCase();
  try {
    fs.writeFileSync(getAccountCurrencyFile(botId, acc), normalized, 'utf8');
  } catch (e) {}
  return normalized;
}

function loadAllSsidsForBot(botId) {
  const stored = ssidStorageDual.get(botId);
  let realSsid = stored?.realSsid || null;
  let demoSsid = stored?.demoSsid || null;

  if (!realSsid && !demoSsid && !poSsidVault.isAvailable()) {
    const ssidDir = getPoSsidDir();
    realSsid = readTextFileIfExists(path.join(ssidDir, `pocketoption_real_ssid_${botId}.txt`));
    demoSsid = readTextFileIfExists(path.join(ssidDir, `pocketoption_demo_ssid_${botId}.txt`));
    if (!realSsid && !demoSsid) {
      const legacy = readTextFileIfExists(path.join(ssidDir, `pocketoption_ssid_${botId}.txt`));
      if (legacy) {
        const detected = detectAccountFromSsid(legacy);
        if (detected === 'real') realSsid = legacy;
        else if (detected === 'demo') demoSsid = legacy;
      }
    }
  }

  if (realSsid && detectAccountFromSsid(realSsid) === 'demo') realSsid = null;
  if (demoSsid && detectAccountFromSsid(demoSsid) === 'real') demoSsid = null;

  return mergeSessionSsidsForBot(botId, {
    realSsid: realSsid || null,
    demoSsid: demoSsid || null,
    hasReal: !!realSsid,
    hasDemo: !!demoSsid
  });
}

async function clearSsidForBotAccount(botId, account) {
  const acc = account === 'real' ? 'real' : 'demo';
  const prevSession = ssidSessionDual.get(botId) || {};
  const prevStored = ssidStorageDual.get(botId) || {};
  const closingSsid = acc === 'real'
    ? (prevSession.realSsid || prevStored.realSsid)
    : (prevSession.demoSsid || prevStored.demoSsid);
  if (closingSsid) await closePoTradeSession(closingSsid);

  await poSsidVault.deleteSsid(botId, acc);
  removePlainSsidFilesForBot(botId);

  const currencyFiles = acc === 'real'
    ? [`account_currency_${botId}_real.txt`]
    : [`account_currency_${botId}_demo.txt`];
  for (const name of currencyFiles) {
    try {
      const p = path.join(getPoSsidDir(), name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
  }

  const nextSlots = {
    realSsid: acc === 'real' ? null : (prevSession.realSsid || prevStored.realSsid || null),
    demoSsid: acc === 'demo' ? null : (prevSession.demoSsid || prevStored.demoSsid || null)
  };
  ssidSessionDual.set(botId, nextSlots);
  ssidStorageDual.set(botId, nextSlots);

  const all = loadAllSsidsForBot(botId);

  if (loadAutotradeAccount(botId) === acc) {
    if (acc === 'real' && all.demoSsid) saveAutotradeAccount(botId, 'demo');
    else if (acc === 'demo' && all.realSsid) saveAutotradeAccount(botId, 'real');
    else ssidAutotradeAccount.delete(botId);
  }
}

function clearSsidFilesForBot(botId) {
  poSsidVault.deleteAllForBot(botId).catch(() => {});
  removePlainSsidFilesForBot(botId);
  for (const acc of ['real', 'demo']) {
    try {
      const p = path.join(getPoSsidDir(), `account_currency_${botId}_${acc}.txt`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {}
  }
  try {
    const p = path.join(getPoSsidDir(), `autotrade_account_${botId}.txt`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
  ssidStorage.delete(botId);
  ssidStorageDual.delete(botId);
  ssidSessionDual.delete(botId);
  ssidAutotradeAccount.delete(botId);
  ssidStatusByBot.delete(botId);
}

async function writeSsidForBot(botId, ssid, account, currency) {
  const trimmed = String(ssid || '').trim();
  const detected = detectAccountFromSsid(trimmed);
  if (!detected) {
    throw new Error('Could not read isDemo from SSID');
  }
  if (detected !== account) {
    throw new Error(`SSID is ${detected} but ${account} was selected`);
  }

  const prevSession = ssidSessionDual.get(botId) || ssidStorageDual.get(botId) || {};
  const nextSlots = {
    realSsid: account === 'real' ? trimmed : (prevSession.realSsid || null),
    demoSsid: account === 'demo' ? trimmed : (prevSession.demoSsid || null)
  };
  ssidSessionDual.set(botId, nextSlots);
  ssidStorageDual.set(botId, nextSlots);
  if (account === 'real') ssidStorage.set(botId, trimmed);
  else if (account === 'demo') ssidStorage.set(botId, trimmed);
  removePlainSsidFilesForBot(botId);

  try {
    await poSsidVault.setSsid(botId, account, trimmed);
  } catch (eVault) {
    mainLog('warn', `[SSID] Vault write failed for ${botId}/${account}: ${eVault && eVault.message ? eVault.message : eVault}`);
  }

  const activeCurrency = saveAccountCurrency(botId, currency, account);

  // Always switch autotrade to the account the user just connected.
  saveAutotradeAccount(botId, account);

  return { account, currency: activeCurrency };
}

function loadSsidsForBot(botId, forAccount = null) {
  const all = loadAllSsidsForBot(botId);
  const activeAccount = forAccount || loadAutotradeAccount(botId);
  const ssid = activeAccount === 'real' ? all.realSsid : all.demoSsid;

  if (ssid) {
    const detected = detectAccountFromSsid(ssid);
    if (detected && detected !== activeAccount) {
      return {
        ...all,
        ssid: null,
        account: activeAccount,
        currency: loadAccountCurrency(botId, activeAccount)
      };
    }
  }

  return {
    ...all,
    ssid: ssid || null,
    account: activeAccount,
    currency: loadAccountCurrency(botId, activeAccount),
    realCurrency: loadAccountCurrency(botId, 'real'),
    demoCurrency: loadAccountCurrency(botId, 'demo')
  };
}

function getActiveSsidForBot(botId) {
  const loaded = loadSsidsForBot(botId);
  return {
    ssid: loaded.ssid,
    account: loaded.account || loadAutotradeAccount(botId),
    currency: loaded.currency || loadAccountCurrency(botId, loaded.account)
  };
}

function loadDualSsidsForBot(botId) {
  const loaded = loadSsidsForBot(botId);
  return { realSsid: loaded.realSsid, demoSsid: loaded.demoSsid };
}

function broadcastSsidStatus(botId) {
  const status = ssidStatusByBot.get(botId);
  if (!status) return;
  try {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('ssid-status-update', { botId, status });
    });
  } catch (e) {}
}

function rebindActiveAccountOnStatus(status, account) {
  if (!status) return null;
  const botId = status.botId;
  const acc = account === 'real' ? 'real' : 'demo';
  const slot = status[acc] || {};
  const slotOnline = !!(slot.online && isValidDisplayBalance(slot.balance));
  const next = {
    ...status,
    botId,
    activeAccount: acc,
    activeOnline: slotOnline,
    balance: slotOnline ? slot.balance : null,
    currency: slot.currency || loadAccountCurrency(botId, acc),
    error: slot.error || null,
    expired: !!slot.expired,
    latency_ms: slot.latency_ms != null ? slot.latency_ms : null,
    updatedAt: Date.now()
  };
  ssidStatusByBot.set(botId, next);
  broadcastSsidStatus(botId);
  return next;
}

async function checkSsidOnline(ssid, currencyHint = 'USD') {
  if (!ssid) return { online: false, success: false, error: 'missing ssid' };
  // Prefer the persistent trade-worker session. Never spawn check_ssid.py for
  // routine polls — each new login kicks the Pocket Option browser tab.
  try {
    const res = await poTradeWorker.request({
      cmd: 'status',
      ssid,
      currency: String(currencyHint || 'USD')
    }, 30000);
    if (res && res.success && (res.online !== false)) {
      return {
        success: true,
        online: true,
        connected: true,
        balance: res.balance != null ? res.balance : null,
        currency: res.currency || currencyHint,
        latency_ms: res.latency_ms != null ? res.latency_ms : null,
        account: res.account || null,
        expired: false,
        error: null
      };
    }
    return {
      success: false,
      online: false,
      connected: false,
      balance: null,
      currency: (res && res.currency) || currencyHint,
      latency_ms: (res && res.latency_ms) || null,
      error: (res && res.error) || 'status failed',
      expired: !!(res && res.expired)
    };
  } catch (e) {
    return {
      success: false,
      online: false,
      connected: false,
      currency: currencyHint,
      error: e.message || String(e),
      expired: false
    };
  }
}

async function refreshSsidStatusForBot(botId, options = {}) {
  const force = !!options.force;
  const existing = ssidStatusByBot.get(botId);
  const now = Date.now();

  if (!force && existing && existing.updatedAt) {
    const age = now - existing.updatedAt;
    const ttl = Number.isFinite(options.maxAge)
      ? options.maxAge
      : (existing.activeOnline ? SSID_ONLINE_TTL_MS : SSID_OFFLINE_TTL_MS);
    if (age < ttl) return existing;
  }

  if (ssidCheckInFlight.has(botId)) {
    return ssidCheckInFlight.get(botId);
  }

  const work = (async () => {
  const all = loadAllSsidsForBot(botId);
  let autotradeAccount = loadAutotradeAccount(botId);

  const emptySlot = (account) => ({
    online: false,
    balance: null,
    currency: loadAccountCurrency(botId, account),
    error: null,
    expired: false,
    latency_ms: null
  });

  const status = {
    botId,
    activeAccount: autotradeAccount,
    hasReal: all.hasReal,
    hasDemo: all.hasDemo,
    hasSsid: !!(all.hasReal || all.hasDemo),
    activeOnline: false,
    balance: null,
    currency: loadAccountCurrency(botId, autotradeAccount),
    error: null,
    expired: false,
    latency_ms: null,
    real: emptySlot('real'),
    demo: emptySlot('demo'),
    updatedAt: Date.now()
  };

  async function checkSlot(account, ssid) {
    if (!ssid) return;
    const detected = detectAccountFromSsid(ssid);
    if (detected && detected !== account) {
      status[account] = {
        ...status[account],
        error: `Saved ${account} slot contains ${detected} SSID`,
        online: false
      };
      return;
    }
    const currency = loadAccountCurrency(botId, account);
    const check = await checkSsidOnline(ssid, currency);
    const balOk = check && isValidDisplayBalance(check.balance);
    status[account] = {
      online: !!(check && check.online && balOk),
      balance: balOk ? check.balance : null,
      currency: (check && check.currency) || currency,
      error: (check && check.error) || null,
      expired: !!(check && check.expired),
      latency_ms: (check && check.latency_ms) || null
    };
  }

  // Only check the ACTIVE account to prevent browser session flicker.
  const activeSsid = autotradeAccount === 'real' ? all.realSsid : all.demoSsid;
  await checkSlot(autotradeAccount, activeSsid);

  if (autotradeAccount === 'real' && !all.hasReal && all.hasDemo) autotradeAccount = 'demo';
  if (autotradeAccount === 'demo' && !all.hasDemo && all.hasReal) autotradeAccount = 'real';
  if (!all.hasReal && !all.hasDemo) autotradeAccount = loadAutotradeAccount(botId);
  else if (all.hasReal && all.hasDemo) {
    if (autotradeAccount !== 'real' && autotradeAccount !== 'demo') autotradeAccount = 'demo';
  } else {
    autotradeAccount = all.hasReal ? 'real' : 'demo';
    saveAutotradeAccount(botId, autotradeAccount);
  }

  status.activeAccount = autotradeAccount;
  const activeSlot = status[autotradeAccount];
  if (activeSlot) {
    const slotOnline = !!(activeSlot.online && isValidDisplayBalance(activeSlot.balance));
    if (!slotOnline && activeSlot.online && !isValidDisplayBalance(activeSlot.balance)) {
      activeSlot.online = false;
      activeSlot.balance = null;
    }
    status.activeOnline = slotOnline;
    status.balance = slotOnline ? activeSlot.balance : null;
    status.currency = activeSlot.currency || loadAccountCurrency(botId, autotradeAccount);
    status.error = activeSlot.error;
    status.expired = !!activeSlot.expired;
    status.latency_ms = activeSlot.latency_ms;
    status.lastOnlineAt = status.activeOnline ? Date.now() : (Number(existing && existing.lastOnlineAt) || 0);
  }

  // Ensure the inactive slot is never reported as "online"
  if (autotradeAccount === 'real' && status.demo) status.demo.online = false;
  if (autotradeAccount === 'demo' && status.real) status.real.online = false;

  ssidStatusByBot.set(botId, status);
  broadcastSsidStatus(botId);
  return status;
  })();

  ssidCheckInFlight.set(botId, work);
  try {
    return await work;
  } finally {
    ssidCheckInFlight.delete(botId);
  }
}

async function refreshAllSsidStatuses() {
  const bots = ['bot1', 'bot2', 'bot3'].filter((botId) => {
    const all = loadAllSsidsForBot(botId);
    return !!(all.hasReal || all.hasDemo);
  });
  // One live status probe per unique active SSID — bots sharing an SSID
  // should not open/hammer parallel sessions.
  const statusBySsid = new Map(); // ssid -> status payload
  for (const botId of bots) {
    const { ssid } = getActiveSsidForBot(botId);
    const key = ssid ? ssid.trim() : '';
    if (key && statusBySsid.has(key)) {
      const donorStatus = statusBySsid.get(key);
      ssidStatusByBot.set(botId, { ...donorStatus, botId, updatedAt: Date.now() });
      broadcastSsidStatus(botId);
      continue;
    }
    const status = await refreshSsidStatusForBot(botId, { force: false });
    if (key && status) statusBySsid.set(key, status);
    await new Promise((r) => setTimeout(r, SSID_BOT_STAGGER_MS));
  }
}

function startSsidStatusPolling() {
  if (ssidStatusTimer) return;
  refreshAllSsidStatuses().catch(() => {});
  ssidStatusTimer = setInterval(() => {
    refreshAllSsidStatuses().catch(() => {});
  }, SSID_BACKGROUND_POLL_MS);
}

try { ipcMain.removeHandler('disconnect-pocket-option-ssid'); } catch (e) {}
ipcMain.handle('disconnect-pocket-option-ssid', async (_event, { botId, account, applyToAllBots } = {}) => {
  try {
    if (!botId && !applyToAllBots) {
      return { success: false, error: 'Missing botId' };
    }
    const targets = applyToAllBots !== false ? ['bot1', 'bot2', 'bot3'] : [botId];
    const acct = account || loadAutotradeAccount(botId);
    for (const id of targets) {
      pushSsidOfflineInstant(id);
      // Disconnect must disarm main-side autotrade — UI-only uncheck used to leave
      // SignalHub placing after reconnect.
      try {
        saveAutotradeEnabled(id, false);
        resetSsidLadderToStart(id, 'ssid disconnect', { dropLive: true, waitForNew1x: false });
      } catch (eOff) {}
    }
    for (const id of targets) {
      await clearSsidForBotAccount(id, acct);
      pushSsidOfflineInstant(id);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

try { ipcMain.removeHandler('set-pocket-option-autotrade-account'); } catch (e) {}
ipcMain.handle('set-pocket-option-autotrade-account', async (_event, { botId, account } = {}) => {
  try {
    if (!botId) return { success: false, error: 'Missing botId' };
    const prevMode = loadAutotradeAccount(botId);
    const nextMode = account === 'real' ? 'real' : 'demo';
    if (prevMode !== nextMode) {
      const all = loadAllSsidsForBot(botId);
      const prevSsid = prevMode === 'real' ? all.realSsid : all.demoSsid;
      if (prevSsid) await closePoTradeSession(prevSsid);
    }
    const mode = saveAutotradeAccount(botId, nextMode);
    const cached = ssidStatusByBot.get(botId);
    const status = cached
      ? rebindActiveAccountOnStatus(cached, mode)
      : await refreshSsidStatusForBot(botId, { force: false });

    const { ssid } = getActiveSsidForBot(botId);
    if (ssid) warmPoTradeSession(ssid, '').catch(() => {});

    return { success: true, account: mode, status };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

try { ipcMain.removeHandler('get-pocket-option-ssid-status'); } catch (e) {}
ipcMain.handle('get-pocket-option-ssid-status', async (_event, { botId } = {}) => {
  try {
    if (botId) {
      let status = ssidStatusByBot.get(botId);
      if (!status) status = await refreshSsidStatusForBot(botId, { force: true });
      return { success: true, status };
    }
    const all = {};
    for (const id of ['bot1', 'bot2', 'bot3']) {
      all[id] = ssidStatusByBot.get(id) || null;
    }
    return { success: true, statuses: all };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

try { ipcMain.removeHandler('refresh-pocket-option-ssid-status'); } catch (e) {}
ipcMain.handle('refresh-pocket-option-ssid-status', async (_event, { botId, force, maxAge } = {}) => {
  try {
    const shouldForce = force === true;
    const refreshOpts = { force: shouldForce };
    if (Number.isFinite(maxAge)) refreshOpts.maxAge = maxAge;
    if (botId) {
      const status = await refreshSsidStatusForBot(botId, refreshOpts);
      return { success: true, status };
    }
    const bots = ['bot1', 'bot2', 'bot3'];
    for (const id of bots) {
      const all = loadAllSsidsForBot(id);
      if (all.hasReal || all.hasDemo) {
        await refreshSsidStatusForBot(id, refreshOpts);
        await new Promise((r) => setTimeout(r, SSID_BOT_STAGGER_MS));
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

try { ipcMain.removeAllListeners('reset-saving-ladder'); } catch (e) {}
ipcMain.on('reset-saving-ladder', (_event, payload = {}) => {
  const botId = payload.botId || payload.bot;
  if (!botId) return;
  resetSsidLadderToStart(botId, payload.reason || 'reset-saving-ladder', { waitForNew1x: true });
});

try { ipcMain.removeAllListeners('set-autotrade-bet'); } catch (e) {}
ipcMain.on('set-autotrade-bet', (_event, payload = {}) => {
  const botId = payload.botId || payload.bot;
  const n = Number(payload.amount);
  if (!botId || !Number.isFinite(n) || n <= 0) return;
  saveAutotradeBet(botId, n);
});

try { ipcMain.removeHandler('get-autotrade-bets'); } catch (e) {}
ipcMain.handle('get-autotrade-bets', async () => ({
  bot1: loadAutotradeBet('bot1'),
  bot2: loadAutotradeBet('bot2'),
  bot3: loadAutotradeBet('bot3')
}));

try { ipcMain.removeHandler('get-autotrade-enabled'); } catch (e) {}
ipcMain.handle('get-autotrade-enabled', async () => ({
  bot1: loadAutotradeEnabled('bot1'),
  bot2: loadAutotradeEnabled('bot2'),
  bot3: loadAutotradeEnabled('bot3')
}));

try { ipcMain.removeHandler('po-fetch-wallet-history'); } catch (e) {}
ipcMain.handle('po-fetch-wallet-history', async (_event, { botId, limit } = {}) => {
  const id = String(botId || '').trim();
  if (!id) return { success: false, error: 'missing botId', closed: [] };
  const { ssid } = getActiveSsidForBot(id);
  if (!ssid) return { success: false, error: 'no ssid', closed: [] };
  try {
    const cap = Math.max(1, Math.min(200, Number(limit) || 80));
    const res = await poTradeWorker.request({ cmd: 'trade_history', ssid, limit: cap }, 18000);
    return {
      success: !!(res && res.success !== false),
      closed: (res && res.closed) || [],
      opened: (res && res.opened) || [],
      error: res && res.error
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : String(e), closed: [] };
  }
});

try { ipcMain.removeHandler('po-deal-watch-state'); } catch (e) {}
ipcMain.handle('po-deal-watch-state', async () => {
  return poDealResume.currentState();
});

try { ipcMain.removeHandler('po-account-trades-history'); } catch (e) {}
ipcMain.handle('po-account-trades-history', async () => {
  const out = {};
  for (const id of ['bot1', 'bot2', 'bot3']) {
    try {
      out[id] = poWatchStore.loadHistory(id) || [];
    } catch (e) {
      out[id] = [];
    }
  }
  return out;
});

try { ipcMain.removeHandler('warm-pocket-option-trade'); } catch (e) {}
ipcMain.handle('warm-pocket-option-trade', async (_event, { botId, currency, amount, duration } = {}) => {
  try {
    if (!botId) return { success: false, error: 'Missing botId' };
    const { ssid } = getActiveSsidForBot(botId);
    if (!ssid) return { success: false, error: 'No SSID saved' };
    if (currency) cacheTradePrep(botId, { currency, amount, duration });
    const result = await warmPoTradeSession(ssid, currency);
    return result || { success: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

try { ipcMain.removeAllListeners('sync-autotrade-config'); } catch (e) {}
ipcMain.on('sync-autotrade-config', (_event, payload = {}) => {
  const botId = payload.botId || payload.bot;
  if (!botId) return;
  if (autotradeQuitLocked) {
    saveAutotradeEnabled(botId, false);
    return;
  }
  autotradeUiSyncedByBot.add(botId);
  const prevEnabled = loadAutotradeEnabled(botId);
  const en = resolveEnabledUpdate(payload, prevEnabled);
  if (en.apply) {
    saveAutotradeEnabled(botId, en.value);
    if (en.value === false) {
      resetSsidLadderToStart(botId, 'autotrade off', { dropLive: true, waitForNew1x: false });
    } else if (prevEnabled === false) {
      // Fresh OFF→ON only. Heal syncs (already enabled) must NOT clear mid-chain wait.
      if (payload.waitForChainEnd !== true && payload.joinMidChain !== true) {
        autotradeWaitChainByBot.set(botId, false);
        pendingMgRetryByBot.delete(botId);
        try { clearSaving1xLock(botId); } catch (e) {}
        const lockedTo1x = !!(autotradeSavingByBot.get(botId) || {}).forceNextAttempt1;
        if (!lockedTo1x) {
          poDealResume.resume(botId).catch(() => {});
        }
      } else {
        const lockedTo1x = !!(autotradeSavingByBot.get(botId) || {}).forceNextAttempt1;
        if (!lockedTo1x) {
          poDealResume.resume(botId).catch(() => {});
        }
      }
    }
  } else if (en.reason === 'block-stake-disable') {
    mainLog('warn', `[SignalHub] ignored stake-sync disable for ${botId} (keep ENABLED)`);
  }
  if (payload.waitForChainEnd !== undefined) {
    if (payload.waitForChainEnd) {
      autotradeWaitChainByBot.set(botId, true);
    } else {
      const live = poDealMonitor.get(botId);
      if (live && (live.pending || live.chainFreeze)) {
        mainLog('info', `[SignalHub] keep ${botId} MG freeze (live PO deal ${live.outcome || 'pending'})`);
      } else {
        autotradeWaitChainByBot.set(botId, false);
      }
    }
  }

  if (payload.joinMidChain === true) {
    autotradeWaitChainByBot.set(botId, false);
    armJoinMidChain(botId, payload.joinAttempt);
    tryPlaceJoinMidChain(botId);
  } else if (payload.joinMidChain === false && payload.waitForChainEnd !== true) {
    joinMidChainByBot.delete(botId);
  }

  const baseBet = payload.baseBet != null ? Number(payload.baseBet) : null;
  if (Number.isFinite(baseBet) && baseBet > 0 && payload.betFromInput === true) {
    saveAutotradeBet(botId, baseBet);
  } else if (payload.amount != null && Number(payload.amount) > 0 && payload.isBaseBet && payload.betFromInput === true) {
    saveAutotradeBet(botId, Number(payload.amount));
  }

  if (
    payload.savingSignalsEnabled !== undefined
    || payload.savingSignalMultiplier != null
    || payload.stakeAmount != null
    || payload.savingSignalMode != null
    || payload.clearStaleStake
  ) {
    const prev = autotradeSavingByBot.get(botId) || {};
    const nextMode = payload.savingSignalMode === '4x' || payload.savingSignalMode === '2x' || payload.savingSignalMode === 'custom'
      ? payload.savingSignalMode
      : resolveSavingMode(prev.mode);
    const nextLadder = payload.savingSignalLadder
      ? normalizeSavingLadder(payload.savingSignalLadder, nextMode)
      : normalizeSavingLadder(prev.ladder, nextMode);
    autotradeSavingByBot.set(botId, {
      enabled: payload.savingSignalsEnabled !== undefined ? !!payload.savingSignalsEnabled : !!prev.enabled,
      mode: nextMode,
      ladder: nextLadder,
      multiplier: Number(payload.savingSignalMultiplier) > 0
        ? Number(payload.savingSignalMultiplier)
        : (payload.clearStaleStake ? 1 : (Number(prev.multiplier) || 1)),
      // Live trades size from attempt+mode only; keep stakeAmount as a hint for UI/logs.
      stakeAmount: Number(payload.stakeAmount) > 0
        ? Number(payload.stakeAmount)
        : (payload.clearStaleStake ? null : (prev.stakeAmount || null)),
      forceNextAttempt1: !!prev.forceNextAttempt1,
      historyNextAttempt: prev.forceNextAttempt1
        ? 1
        : (Number(payload.historyNextAttempt) >= 1
          ? Math.min(5, Math.trunc(Number(payload.historyNextAttempt)))
          : (Number(prev.historyNextAttempt) >= 1 ? prev.historyNextAttempt : 1)),
      at: Date.now()
    });
  }

  const stakeForPrep = Number(payload.stakeAmount) > 0
    ? Number(payload.stakeAmount)
    : (Number(payload.amount) > 0 && !payload.isBaseBet ? Number(payload.amount) : null);

  if (payload.currency) {
    cacheTradePrep(botId, {
      currency: payload.currency,
      amount: stakeForPrep,
      duration: payload.duration
    });
    if (payload.enabled !== false && payload.currency) {
      const { ssid } = getActiveSsidForBot(botId);
      if (ssid) warmPoTradeSession(ssid, payload.currency).catch(() => {});
    }
  }
});

try { ipcMain.removeHandler('get-signal-hub-status'); } catch (e) {}
ipcMain.handle('get-signal-hub-status', async () => ({
  connected: signalHubWsConnected
}));

try { ipcMain.removeAllListeners('cache-trade-prep'); } catch (e) {}
ipcMain.on('cache-trade-prep', (_event, payload = {}) => {
  const botId = payload.botId || payload.bot;
  if (!botId) return;
  cacheTradePrep(botId, payload);
  if (Number(payload.amount) > 0) {
    const base = loadAutotradeBet(botId);
    const mult = base > 0 ? Number(payload.amount) / base : 1;
    if (mult > 1) {
      const prev = autotradeSavingByBot.get(botId) || {};
      // Respect existing enabled flag — never force saving on from prep alone.
      // CRITICAL: keep strategy mode (2x/4x/custom). Dropping it made SSID always use 2x.
      const prevMode = resolveSavingMode(prev.mode);
      const nextMode = payload.savingSignalMode === '4x' || payload.savingSignalMode === '2x' || payload.savingSignalMode === 'custom'
        ? payload.savingSignalMode
        : prevMode;
      autotradeSavingByBot.set(botId, {
        enabled: !!prev.enabled,
        mode: nextMode,
        ladder: payload.savingSignalLadder
          ? normalizeSavingLadder(payload.savingSignalLadder, nextMode)
          : normalizeSavingLadder(prev.ladder, nextMode),
        multiplier: mult,
        stakeAmount: Number(payload.amount),
        historyNextAttempt: prev.forceNextAttempt1
          ? 1
          : (Number(prev.historyNextAttempt) >= 1 ? prev.historyNextAttempt : 1),
        forceNextAttempt1: !!prev.forceNextAttempt1,
        at: Date.now()
      });
    }
  }
  const { ssid } = getActiveSsidForBot(botId);
  if (ssid && payload.currency) {
    warmPoTradeSession(ssid, payload.currency).catch(() => {});
  }
});

try { ipcMain.removeAllListeners('fast-pocket-option-trade'); } catch (e) {}
ipcMain.on('fast-pocket-option-trade', (event, payload = {}) => {
  runFastPoTrade(payload).then((result) => {
    try {
      event.sender.send('fast-pocket-option-trade-done', {
        botId: payload.botId || payload.bot,
        result,
        signalAtMs: payload.signalAtMs
      });
    } catch (e) {}
  }).catch((e) => {
    try {
      event.sender.send('fast-pocket-option-trade-done', {
        botId: payload.botId || payload.bot,
        result: { success: false, error: e.message }
      });
    } catch (e2) {}
  });
});

try { ipcMain.removeHandler('execute-pocket-option-trade'); } catch (e) {}
ipcMain.handle('execute-pocket-option-trade', async (_event, payload = {}) => {
  try {
    const botId = payload.botId || payload.bot;
    const currency = payload.currency;
    const side = String(payload.side || '').toUpperCase();
    const amount = Number(payload.amount);
    const duration = Number(payload.duration || payload.durationSec || 0);

    if (!botId || !currency || !side || !Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: 'Missing botId, currency, side, or amount' };
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      return { success: false, error: 'Missing or invalid duration' };
    }

    const { ssid, account } = getActiveSsidForBot(botId);
    if (!ssid) {
      return { success: false, error: `No ${account} SSID saved for ${botId} — connect ${account} account first` };
    }

    const detected = detectAccountFromSsid(ssid);
    if (detected && detected !== account) {
      return { success: false, error: `Wrong SSID type for ${account} autotrade` };
    }

    const status = ssidStatusByBot.get(botId);
    if (status && status.expired) {
      return { success: false, error: `${account} SSID expired — paste a new token in Connect` };
    }
    if (status && !status.activeOnline) {
      return { success: false, error: `${account} SSID offline — reconnect in Connect` };
    }

    const safetyErr = assertTradeAmountSafe(botId, amount, ssid);
    if (safetyErr) {
      mainLog('warn', `[PO-Trade] ${botId} blocked: ${safetyErr}`);
      return { success: false, error: safetyErr };
    }

    const tradeStarted = Date.now();
    mainLog('info', `[PO-Trade] ${botId} ${side} ${currency} ${amount} ${duration}s (${account})`);

    const result = await executePoTradeFast({
      ssid,
      currency,
      side,
      amount,
      duration
    });

    if (result && result.success) {
      const totalMs = Date.now() - tradeStarted;
      mainLog('info', `[PO-Trade] OK deal=${result.deal_id} api=${result.latency_ms || '?'}ms total=${totalMs}ms`);
      refreshSsidStatusForBot(botId, { force: true }).catch(() => {});
    } else {
      mainLog('warn', `[PO-Trade] Failed: ${result?.error || 'unknown'}`);
    }

    return result || { success: false, error: 'trade failed' };
  } catch (e) {
    mainLog('error', '[PO-Trade] Error:', e.message);
    return { success: false, error: e.message };
  }
});