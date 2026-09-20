/**
 * In-app Picture-in-Picture controls for LUMIX / MIRAX / NYX signal cards.
 * Pop-out hides the in-app card; mini window shows live updates.
 */
(function () {
 const { ipcRenderer } = require('electron');

 const BOTS = ['LUMIX', 'MIRAX', 'NYX'];
 const botIdMap = { LUMIX: 'bot1', MIRAX: 'bot2', NYX: 'bot3' };
 const openByBot = Object.create(null);
 const lastHtmlByBot = Object.create(null);
 const lastGlowByBot = Object.create(null);
 const BOUNDS_KEY = 'utk_signal_pip_bounds_v1';

 const PIP_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12zm-6-7h4v2h-4v-2z"/></svg>`;

 function areaEl(botKey) {
 const id = botIdMap[botKey];
 return id ? document.querySelector(`#section-${id} .bot-signal-area`) : null;
 }

 function displayEl(botKey) {
 const id = botIdMap[botKey];
 return id ? document.getElementById(`signalDisplay-${id}`) : null;
 }

 function emptyEl(botKey) {
 const id = botIdMap[botKey];
 return id ? document.getElementById(`signalEmpty-${id}`) : null;
 }

 function loadBounds(botKey) {
 try {
 const all = JSON.parse(localStorage.getItem(BOUNDS_KEY) || '{}');
 return all[botKey] || null;
 } catch (e) {
 return null;
 }
 }

 function saveBounds(botKey, bounds) {
 try {
 const all = JSON.parse(localStorage.getItem(BOUNDS_KEY) || '{}');
 all[botKey] = bounds;
 localStorage.setItem(BOUNDS_KEY, JSON.stringify(all));
 } catch (e) {}
 }

 function detectGlow(botKey) {
 const area = areaEl(botKey);
 if (!area) return null;
 for (const c of ['glow-preparing', 'glow-buy', 'glow-sell', 'glow-win', 'glow-loss', 'glow-cancelled']) {
 if (area.classList.contains(c)) return c;
 }
 return null;
 }

 function ensureChrome(botKey) {
 const area = areaEl(botKey);
 if (!area) return null;

 let chrome = area.querySelector('.signal-pip-chrome');
 if (!chrome) {
 chrome = document.createElement('div');
 chrome.className = 'signal-pip-chrome';
 chrome.innerHTML = `
 <button type="button" class="signal-pip-btn" data-pip-bot="${botKey}" title="Pop out signal" aria-label="Pop out ${botKey} signal">
 ${PIP_ICON}
 </button>
 `;
 area.insertBefore(chrome, area.firstChild);
 const btn = chrome.querySelector('[data-pip-bot]');
 if (btn) {
 btn.addEventListener('click', (e) => {
 e.preventDefault();
 e.stopPropagation();
 togglePip(botKey);
 });
 }
 }

 let dock = area.querySelector('.signal-pip-dock');
 if (!dock) {
 dock = document.createElement('div');
 dock.className = 'signal-pip-dock';
 dock.hidden = true;
 dock.innerHTML = `
 <span class="signal-pip-dock-label">Open in mini player</span>
 <button type="button" class="signal-pip-dock-restore" data-pip-restore="${botKey}">Return</button>
 `;
 area.appendChild(dock);
 const restore = dock.querySelector('.signal-pip-dock-restore');
 if (restore) {
 restore.addEventListener('click', (e) => {
 e.preventDefault();
 restorePip(botKey);
 });
 }
 }

 return { area, chrome, dock };
 }

 function setInAppPipMode(botKey, active) {
 openByBot[botKey] = !!active;
 const parts = ensureChrome(botKey);
 if (!parts) return;
 const { area, chrome, dock } = parts;
 const display = displayEl(botKey);
 const empty = emptyEl(botKey);

 area.classList.toggle('signal-pip-active', !!active);
 if (chrome) {
 const btn = chrome.querySelector('[data-pip-bot]');
 if (btn) {
 btn.classList.toggle('is-active', !!active);
 btn.title = active ? 'Signal is in the mini player. Use Return below.' : 'Pop out signal';
 btn.disabled = !!active;
 }
 }

 if (dock) dock.hidden = !active;

 if (active) {
 if (display) {
 display.style.display = 'none';
 display.classList.add('utk-sig-hidden');
 }
 if (empty) {
 empty.style.display = 'none';
 empty.classList.add('utk-sig-hidden');
 }
 } else {
 // Let normal render/clear logic restore visibility on next update.
 if (dock) dock.hidden = true;
 // If a card exists, show it again; otherwise show empty.
 if (display && display.querySelector('.signal-card')) {
 display.style.display = '';
 display.classList.remove('utk-sig-hidden');
 if (empty) {
 empty.style.display = 'none';
 }
 } else if (empty) {
 empty.style.display = '';
 empty.classList.remove('utk-sig-hidden');
 if (display) {
 display.style.display = 'none';
 }
 }
 }
 }

 function waitingHtmlFor(botKey) {
 const empty = emptyEl(botKey);
 if (empty) {
 // Clone waiting UI into a compact card for the mini player.
 const clone = empty.cloneNode(true);
 clone.removeAttribute('id');
 clone.style.display = '';
 clone.classList.remove('utk-sig-hidden', 'utk-sig-out');
 const cta = clone.querySelector('.signal-empty-cta');
 if (cta) cta.remove();
 return `<div class="signal-card signal-card-waiting">${clone.innerHTML}</div>`;
 }
 return `<div class="signal-card signal-card-waiting"><div class="pip-empty">Waiting for next signal</div></div>`;
 }

 function cardHtmlFor(botKey) {
 const display = displayEl(botKey);
 const card = display && display.querySelector('.signal-card');
 if (card) return card.outerHTML;
 return waitingHtmlFor(botKey);
 }

 async function openPip(botKey) {
 ensureChrome(botKey);
 const html = cardHtmlFor(botKey);

 const glowClass = detectGlow(botKey);
 lastHtmlByBot[botKey] = html;
 lastGlowByBot[botKey] = glowClass;

 const bounds = loadBounds(botKey);
 let res = null;
 try {
 res = await ipcRenderer.invoke('signal-pip-open', {
 botKey,
 title: botKey,
 html,
 glowClass,
 bounds,
 });
 } catch (e) {
 res = { success: false, error: (e && e.message) || 'open_failed' };
 }
 if (res && res.success) {
 setInAppPipMode(botKey, true);
 return;
 }
 try {
 if (typeof window.showAppToast === 'function') {
 window.showAppToast('Could not open mini player for ' + botKey, 'error');
 } else if (window.appToast && typeof window.appToast.show === 'function') {
 window.appToast.show('Could not open mini player for ' + botKey, 'error');
 }
 } catch (e2) {}
 }

 async function restorePip(botKey) {
 try {
 await ipcRenderer.invoke('signal-pip-close', { botKey });
 } catch (e) {}
 setInAppPipMode(botKey, false);
 }

 function togglePip(botKey) {
 if (openByBot[botKey]) {
 restorePip(botKey);
 return;
 }
 openPip(botKey);
 }

 function pushUpdate(botKey, { countdownOnly = false, countdownText = null } = {}) {
 if (!openByBot[botKey]) return;
 const glowClass = detectGlow(botKey);
 lastGlowByBot[botKey] = glowClass;

 if (countdownOnly && countdownText != null) {
 ipcRenderer.invoke('signal-pip-update', {
 botKey,
 title: botKey,
 glowClass,
 countdownText,
 }).catch(() => {});
 return;
 }

 const html = cardHtmlFor(botKey);
 lastHtmlByBot[botKey] = html;
 ipcRenderer.invoke('signal-pip-update', {
 botKey,
 title: botKey,
 html,
 glowClass,
 }).catch(() => {});
 }

 function onRender(botKey, _signal) {
 ensureChrome(botKey);
 const display = displayEl(botKey);
 const card = display && display.querySelector('.signal-card');
 if (card) lastHtmlByBot[botKey] = card.outerHTML;

 // Button stays always visible (even while waiting).
 const chrome = areaEl(botKey) && areaEl(botKey).querySelector('.signal-pip-chrome');
 if (chrome) chrome.hidden = false;

 if (openByBot[botKey]) {
 // Stay hidden in-app while PiP owns the view.
 if (display) {
 display.style.display = 'none';
 display.classList.add('utk-sig-hidden');
 }
 const empty = emptyEl(botKey);
 if (empty) {
 empty.style.display = 'none';
 empty.classList.add('utk-sig-hidden');
 }
 pushUpdate(botKey);
 }
 }

 function onCountdown(botKey, seconds) {
 if (!openByBot[botKey]) return;
 let text = '';
 try {
 if (typeof seconds === 'string') {
 text = seconds;
 } else if (typeof window.formatCountdown === 'function') {
 text = window.formatCountdown(seconds);
 } else {
 const s = Math.max(0, Math.floor(Number(seconds) || 0));
 text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
 }
 } catch (e) {
 text = String(seconds);
 }
 pushUpdate(botKey, { countdownOnly: true, countdownText: text });
 }

 function onClear(botKey) {
 const chrome = areaEl(botKey) && areaEl(botKey).querySelector('.signal-pip-chrome');
 if (chrome) chrome.hidden = false;
 if (openByBot[botKey]) {
 // Keep miniplayer open - fall back to waiting state.
 lastHtmlByBot[botKey] = waitingHtmlFor(botKey);
 ipcRenderer.invoke('signal-pip-update', {
 botKey,
 title: botKey,
 html: lastHtmlByBot[botKey],
 glowClass: null,
 }).catch(() => {});
 }
 }

 ipcRenderer.on('signal-pip-closed', (_e, { botKey } = {}) => {
 const key = String(botKey || '').toUpperCase();
 if (!BOTS.includes(key)) return;
 setInAppPipMode(key, false);
 });

 ipcRenderer.on('signal-pip-restored', (_e, { botKey } = {}) => {
 const key = String(botKey || '').toUpperCase();
 if (!BOTS.includes(key)) return;
 setInAppPipMode(key, false);
 });

 ipcRenderer.on('signal-pip-bounds', (_e, { botKey, bounds } = {}) => {
 const key = String(botKey || '').toUpperCase();
 if (!BOTS.includes(key) || !bounds) return;
 saveBounds(key, bounds);
 });

 // Bounds come from PiP page via main - bridge if main forwards. Also listen local.
 // Main currently does not forward bounds; page sends to main only. Hook main→renderer:
 // already handled if we add forward; for now save from a custom channel if present.

 function boot() {
 BOTS.forEach((k) => {
 const parts = ensureChrome(k);
 if (parts && parts.chrome) parts.chrome.hidden = false;
 });
 }

 if (document.readyState === 'loading') {
 document.addEventListener('DOMContentLoaded', boot, { once: true });
 } else {
 boot();
 }

 window.__utkSignalPip = {
 onRender,
 onCountdown,
 onClear,
 open: openPip,
 restore: restorePip,
 isOpen: (botKey) => !!openByBot[botKey],
 };
})();
