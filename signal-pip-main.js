/**
 * Picture-in-picture signal windows (LUMIX / MIRAX / NYX).
 * Frameless, always-on-top, resizable mini player.
 * Closing a PiP window must NEVER quit the main app.
 */
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const ALLOWED_BOTS = new Set(['LUMIX', 'MIRAX', 'NYX']);
const pipByBot = new Map(); // botKey -> BrowserWindow
let mainWindowRef = null;
let getIcon = () => undefined;

function setPipDeps({ getMainWindow, getBrowserWindowIcon } = {}) {
  if (typeof getMainWindow === 'function') {
    mainWindowRef = getMainWindow;
  }
  if (typeof getBrowserWindowIcon === 'function') {
    getIcon = getBrowserWindowIcon;
  }
}

function resolveMainWindow() {
  try {
    if (typeof mainWindowRef === 'function') return mainWindowRef();
  } catch (e) {}
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !isPipWindow(w)) || null;
}

function isPipWindow(win) {
  for (const w of pipByBot.values()) {
    if (w === win) return true;
  }
  return false;
}

function defaultBounds() {
  const display = screen.getPrimaryDisplay();
  const { width, height, x, y } = display.workArea;
  const w = 300;
  const h = 210;
  return {
    width: w,
    height: h,
    x: Math.round(x + width - w - 20),
    y: Math.round(y + height - h - 20),
  };
}

function broadcastToMain(channel, payload) {
  const main = resolveMainWindow();
  if (main && !main.isDestroyed()) {
    try { main.webContents.send(channel, payload); } catch (e) {}
  }
}

function closePip(botKey, { notify = true } = {}) {
  const key = String(botKey || '').toUpperCase();
  const win = pipByBot.get(key);
  if (!win) {
    if (notify) broadcastToMain('signal-pip-closed', { botKey: key });
    return;
  }
  pipByBot.delete(key);
  try {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  } catch (e) {
    try { if (!win.isDestroyed()) win.close(); } catch (ee) {}
  }
  if (notify) broadcastToMain('signal-pip-closed', { botKey: key });
}

function sendToPip(botKey, channel, payload) {
  const win = pipByBot.get(String(botKey || '').toUpperCase());
  if (!win || win.isDestroyed()) return false;
  try {
    win.webContents.send(channel, payload);
    return true;
  } catch (e) {
    return false;
  }
}

function openPip(payload = {}) {
  const botKey = String(payload.botKey || '').toUpperCase();
  if (!ALLOWED_BOTS.has(botKey)) {
    return { success: false, error: 'invalid bot' };
  }

  const existing = pipByBot.get(botKey);
  if (existing && !existing.isDestroyed()) {
    sendToPip(botKey, 'signal-pip-content', payload);
    try { existing.show(); existing.focus(); } catch (e) {}
    return { success: true, reused: true };
  }

  const bounds = payload.bounds && Number.isFinite(payload.bounds.width)
    ? payload.bounds
    : defaultBounds();

  const win = new BrowserWindow({
    width: Math.max(240, Number(bounds.width) || 300),
    height: Math.max(170, Number(bounds.height) || 210),
    x: Number.isFinite(bounds.x) ? bounds.x : undefined,
    y: Number.isFinite(bounds.y) ? bounds.y : undefined,
    minWidth: 220,
    minHeight: 160,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    thickFrame: false,
    hasShadow: false,
    autoHideMenuBar: true,
    title: `${botKey} Signal`,
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

  try { win.setAlwaysOnTop(true, 'floating'); } catch (e) {
    try { win.setAlwaysOnTop(true); } catch (ee) {}
  }
  try { win.setBackgroundColor('#00000000'); } catch (e) {}
  try { win.setResizable(true); } catch (e) {}
  try { win.webContents.setBackgroundThrottling(false); } catch (e) {}

  pipByBot.set(botKey, win);

  win.on('closed', () => {
    if (pipByBot.get(botKey) === win) pipByBot.delete(botKey);
    broadcastToMain('signal-pip-closed', { botKey });
  });

  win.on('close', () => {
    if (pipByBot.get(botKey) === win) pipByBot.delete(botKey);
  });

  win.once('ready-to-show', () => {
    try { win.show(); } catch (e) {}
    sendToPip(botKey, 'signal-pip-content', Object.assign({ botKey }, payload));
  });

  win.loadFile(path.join(__dirname, 'signal-pip.html'), {
    query: { bot: botKey },
  }).catch(() => {});

  return { success: true };
}

function updatePip(payload = {}) {
  const botKey = String(payload.botKey || '').toUpperCase();
  if (!pipByBot.has(botKey)) return { success: false, error: 'not open' };
  sendToPip(botKey, 'signal-pip-content', payload);
  return { success: true };
}

function registerSignalPipIpc() {
  ipcMain.handle('signal-pip-open', async (_event, payload) => openPip(payload || {}));
  ipcMain.handle('signal-pip-update', async (_event, payload) => updatePip(payload || {}));
  ipcMain.handle('signal-pip-close', async (_event, { botKey } = {}) => {
    closePip(botKey, { notify: true });
    return { success: true };
  });
  ipcMain.handle('signal-pip-is-open', async (_event, { botKey } = {}) => {
    const key = String(botKey || '').toUpperCase();
    const win = pipByBot.get(key);
    return { open: !!(win && !win.isDestroyed()) };
  });

  ipcMain.on('signal-pip-set-bounds', (_event, { botKey, bounds } = {}) => {
    const key = String(botKey || '').toUpperCase();
    const win = pipByBot.get(key);
    if (!win || win.isDestroyed() || !bounds) return;
    const next = {
      x: Math.round(Number(bounds.x)),
      y: Math.round(Number(bounds.y)),
      width: Math.max(220, Math.round(Number(bounds.width) || 0)),
      height: Math.max(160, Math.round(Number(bounds.height) || 0)),
    };
    if (![next.x, next.y, next.width, next.height].every(Number.isFinite)) return;
    try { win.setBounds(next, false); } catch (e) {}
  });

  ipcMain.on('signal-pip-bounds', (_event, { botKey, bounds } = {}) => {
    const key = String(botKey || '').toUpperCase();
    broadcastToMain('signal-pip-bounds', { botKey: key, bounds });
  });
}

function closeAllPipWindows() {
  for (const key of [...pipByBot.keys()]) {
    closePip(key, { notify: false });
  }
}

function hasOpenPipWindows() {
  for (const win of pipByBot.values()) {
    if (win && !win.isDestroyed()) return true;
  }
  return false;
}

module.exports = {
  setPipDeps,
  registerSignalPipIpc,
  closeAllPipWindows,
  hasOpenPipWindows,
  isPipWindow,
  openPip,
  updatePip,
  closePip,
  ALLOWED_BOTS,
};
