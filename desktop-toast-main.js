/**
 * Custom desktop toasts — frameless always-on-top cards (Celestial-style).
 * Closing a toast must NEVER quit the main app or steal focus.
 */
const { BrowserWindow, ipcMain, screen, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const TOAST_W = 380;
const TOAST_H = 118;
const GAP = 8;
const MARGIN = 16;
const MAX_TOASTS = 4;
const DEFAULT_MS = 5200;

let toasts = []; // { id, win, payload }
let seq = 0;
let getIcon = () => undefined;
let getMainWindow = () => null;
let onClick = () => {};

function setToastDeps({ getMainWindow: gm, getBrowserWindowIcon, onToastClick } = {}) {
  if (typeof gm === 'function') getMainWindow = gm;
  if (typeof getBrowserWindowIcon === 'function') getIcon = getBrowserWindowIcon;
  if (typeof onToastClick === 'function') onClick = onToastClick;
}

/** Packaged relative logo.png often fails; prefer absolute file:// from resources. */
function resolveToastLogoUrl() {
  const candidates = [];
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'logo.png'));
      candidates.push(path.join(process.resourcesPath, 'icon.ico'));
    }
  } catch (e) {}
  try {
    if (app && typeof app.getAppPath === 'function') {
      candidates.push(path.join(app.getAppPath(), 'logo.png'));
    }
  } catch (e) {}
  candidates.push(path.join(__dirname, 'logo.png'));
  candidates.push(path.join(__dirname, 'build', 'icon.ico'));
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return pathToFileURL(path.resolve(p)).href;
    } catch (e) {}
  }
  return null;
}

function isToastWindow(win) {
  if (!win) return false;
  for (let i = 0; i < toasts.length; i++) {
    if (toasts[i].win === win) return true;
  }
  return false;
}

function workAreaFor() {
  try {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay();
    return display.workArea;
  } catch (e) {
    const display = screen.getPrimaryDisplay();
    return display.workArea;
  }
}

function boundsForIndex(index) {
  const area = workAreaFor();
  return {
    width: TOAST_W,
    height: TOAST_H,
    x: Math.round(area.x + area.width - TOAST_W - MARGIN),
    y: Math.round(area.y + area.height - ((index + 1) * (TOAST_H + GAP)) + GAP - MARGIN),
  };
}

function reflow() {
  toasts.forEach((t, i) => {
    if (!t.win || t.win.isDestroyed()) return;
    const b = boundsForIndex(i);
    try { t.win.setBounds(b, true); } catch (e) {}
  });
}

function destroyWin(win) {
  if (!win) return;
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch (e) {
    try { if (!win.isDestroyed()) win.close(); } catch (ee) {}
  }
}

function dismiss(id, animate) {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const t = toasts[idx];
  toasts.splice(idx, 1);
  if (t.timer) {
    try { clearTimeout(t.timer); } catch (e) {}
    t.timer = null;
  }
  if (t.win && !t.win.isDestroyed()) {
    if (animate) {
      try { t.win.webContents.send('desktop-toast-out'); } catch (e) {}
      setTimeout(() => {
        destroyWin(t.win);
        reflow();
      }, 240);
    } else {
      destroyWin(t.win);
      reflow();
    }
  } else {
    reflow();
  }
}

function pinOnTop(win) {
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {
    try { win.setAlwaysOnTop(true, 'pop-up-menu'); } catch (e2) {
      try { win.setAlwaysOnTop(true); } catch (e3) {}
    }
  }
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
}

function showToast(payload = {}) {
  while (toasts.length >= MAX_TOASTS) {
    dismiss(toasts[toasts.length - 1].id, false);
  }

  const id = ++seq;
  const durationMs = Number(payload.autoCloseMs);
  const holdMs = Number.isFinite(durationMs) && durationMs > 0
    ? Math.min(12000, Math.max(1400, durationMs))
    : DEFAULT_MS;

  const win = new BrowserWindow({
    width: TOAST_W,
    height: TOAST_H,
    x: boundsForIndex(0).x,
    y: boundsForIndex(0).y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: true,
    focusable: true,
    thickFrame: false,
    hasShadow: false,
    autoHideMenuBar: true,
    title: 'Utopia Kingdom',
    icon: getIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
      backgroundThrottling: false,
      sandbox: false,
    },
  });

  pinOnTop(win);
  try { win.setBackgroundColor('#00000000'); } catch (e) {}
  try { win.setMenuBarVisibility(false); } catch (e) {}
  try { win.setSkipTaskbar(true); } catch (e) {}

  const item = { id, win, payload: payload || {}, timer: null };
  toasts.unshift(item);
  reflow();

  const sendContent = () => {
    try {
      win.webContents.send('desktop-toast-content', Object.assign({}, payload, {
        id,
        durationMs: holdMs,
        logoUrl: resolveToastLogoUrl(),
      }));
    } catch (e) {}
  };

  win.once('ready-to-show', () => {
    try { win.showInactive(); } catch (e) {
      try { win.show(); } catch (e2) {}
    }
    pinOnTop(win);
    try { if (typeof win.blur === 'function') win.blur(); } catch (e) {}
    sendContent();
  });

  win.on('closed', () => {
    const i = toasts.findIndex((t) => t.win === win);
    if (i >= 0) {
      if (toasts[i].timer) {
        try { clearTimeout(toasts[i].timer); } catch (e) {}
      }
      toasts.splice(i, 1);
      reflow();
    }
  });

  win.webContents.on('did-finish-load', sendContent);

  win.loadFile(path.join(__dirname, 'desktop-toast.html')).catch(() => {});

  item.timer = setTimeout(() => dismiss(id, true), holdMs);
  return { success: true, id };
}

function closeAllToasts() {
  const ids = toasts.map((t) => t.id);
  ids.forEach((id) => dismiss(id, false));
}

function hasOpenToasts() {
  return toasts.some((t) => t.win && !t.win.isDestroyed());
}

function registerDesktopToastIpc() {
  ipcMain.on('desktop-toast-click', (_event, id) => {
    const t = toasts.find((x) => x.id === id);
    const payload = (t && t.payload) || {};
    dismiss(id, true);
    try { onClick(payload); } catch (e) {}
  });
  ipcMain.on('desktop-toast-dismiss', (_event, id) => {
    dismiss(id, true);
  });
}

module.exports = {
  setToastDeps,
  registerDesktopToastIpc,
  showToast,
  closeAllToasts,
  hasOpenToasts,
  isToastWindow,
  dismiss,
};
