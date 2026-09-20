// Pocket Option SSID - demo + real slots. One connect applies to LUMIX + MIRAX + NYX.
const { ipcRenderer } = require('electron');

const SHARED_BOTS = ['bot1', 'bot2', 'bot3'];

const ACCOUNT_SLOTS = {
 demo: {
 input: 'ssidInputDemo',
 hint: 'ssidHintDemo',
 currency: 'ssidCurrencyDemo',
 balanceAmount: 'demoBalanceAmount',
 balanceTime: 'demoBalanceTime',
 panelStatus: 'demoPanelStatus',
 panelDot: 'demoPanelDot',
 connectBtn: 'connectDemoSSID',
 disconnectBtn: 'disconnectDemoSSID'
 },
 real: {
 input: 'ssidInputReal',
 hint: 'ssidHintReal',
 currency: 'ssidCurrencyReal',
 balanceAmount: 'realBalanceAmount',
 balanceTime: 'realBalanceTime',
 panelStatus: 'realPanelStatus',
 panelDot: 'realPanelDot',
 connectBtn: 'connectRealSSID',
 disconnectBtn: 'disconnectRealSSID'
 }
};

class SSIDManager {
 constructor() {
 this.modal = document.getElementById('ssid-modal');
 this.warningModal = document.getElementById('ssid-warning-modal');
 this.ssidError = document.getElementById('ssidError');
 this.balanceLoading = document.getElementById('balanceLoading');
 this.cancelBtn = document.getElementById('cancelSSID');
 this.autotradePicker = document.getElementById('ssidAutotradePicker');
 this.autotradeDemo = document.getElementById('ssidAutotradeDemo');
 this.autotradeReal = document.getElementById('ssidAutotradeReal');
 this.warningCancelBtn = document.getElementById('ssidWarningCancel');
 this.warningUnderstandBtn = document.getElementById('ssidWarningUnderstand');

 this.currentBotId = null;
 this._pendingWarningBotId = null;
 this.statusByBot = Object.create(null);
 this.statusPollTimer = null;
 this._modalBalanceTimer = null;
 this._connectInFlight = false;
 this._slotState = {
 demo: { full: '', editing: false },
 real: { full: '', editing: false }
 };

 this.initEventListeners();
 this.addBotButtons();
 this.startStatusPolling();
 this.listenForStatusUpdates();
 }

 el(id) {
 return document.getElementById(id);
 }

 slotEls(account) {
 const cfg = ACCOUNT_SLOTS[account];
 if (!cfg) return null;
 return {
 input: this.el(cfg.input),
 hint: this.el(cfg.hint),
 currency: this.el(cfg.currency),
 balanceAmount: this.el(cfg.balanceAmount),
 balanceTime: this.el(cfg.balanceTime),
 panelStatus: this.el(cfg.panelStatus),
 panelDot: this.el(cfg.panelDot),
 connectBtn: this.el(cfg.connectBtn),
 disconnectBtn: this.el(cfg.disconnectBtn)
 };
 }

 initEventListeners() {
 this.cancelBtn?.addEventListener('click', () => this.closeModal());
 this.warningCancelBtn?.addEventListener('click', () => this.closeSsidWarning());
 this.warningUnderstandBtn?.addEventListener('click', () => this.acceptSsidWarning());
 this.warningModal?.addEventListener('click', (e) => {
 if (e.target === this.warningModal) this.closeSsidWarning();
 });
 this.autotradeDemo?.addEventListener('change', () => this.onAutotradePickChange());
 this.autotradeReal?.addEventListener('change', () => this.onAutotradePickChange());

 for (const account of ['demo', 'real']) {
 const els = this.slotEls(account);
 els?.connectBtn?.addEventListener('click', () => this.saveSsid(account));
 els?.disconnectBtn?.addEventListener('click', () => this.disconnect(account));
 els?.input?.addEventListener('input', () => {
 this.onSsidInput(account);
 this.updateSlotVisibility(this.statusByBot[this.currentBotId] || null);
 });
 els?.input?.addEventListener('focus', () => this.onSsidFocus(account));
 els?.input?.addEventListener('blur', () => this.onSsidBlur(account));
 }
 }

 formatMoney(amount, currency) {
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) return null;
  const code = String(currency || 'USD').toUpperCase();
  try {
   return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
   }).format(Number(amount));
  } catch (e) {
   return `${Number(amount).toFixed(2)} ${code}`;
  }
 }

 formatPillLabel(status) {
  if (!status || !status.activeOnline) return null;
  if (!Number.isFinite(Number(status.balance)) || Number(status.balance) < 0) return null;
  const account = status.activeAccount === 'real' ? 'Real' : 'Demo';
  const money = this.formatMoney(status.balance, status.currency);
  if (!money) return null;
  return `${account} · ${money}`;
 }

 formatSsidMask(ssid, head = 16, tail = 12) {
 const s = String(ssid || '').trim();
 if (!s) return '';
 if (s.length <= head + tail + 3) {
 const h = Math.max(4, Math.floor(s.length * 0.35));
 const t = Math.max(4, Math.floor(s.length * 0.25));
 return `${s.slice(0, h)} ·  ·  · ${s.slice(-t)}`;
 }
 return `${s.slice(0, head)} ·  ·  · ${s.slice(-tail)}`;
 }

 getSsidValue(account) {
 const state = this._slotState[account];
 const input = this.slotEls(account)?.input;
 if (state?.editing) return (input?.value || '').trim();
 return (state?.full || (input?.value || '')).trim();
 }

 showSavedSsidMasked(account, full) {
 const state = this._slotState[account];
 const els = this.slotEls(account);
 if (!state || !els?.input) return;

 state.full = full || '';
 state.editing = false;

 if (full) {
 els.input.value = this.formatSsidMask(full);
 els.input.readOnly = true;
 els.input.classList.add('is-masked');
 els.input.rows = 2;
 } else {
 els.input.value = '';
 els.input.readOnly = false;
 els.input.classList.remove('is-masked');
 els.input.rows = 2;
 }
 }

 beginSsidEdit(account) {
 const state = this._slotState[account];
 const els = this.slotEls(account);
 if (!state || !els?.input) return;

 state.editing = true;
 els.input.readOnly = false;
 els.input.classList.remove('is-masked');
 els.input.rows = 2;
 els.input.value = '';
 els.input.placeholder = account === 'real'
 ? 'Paste real SSID (42["auth",{"session":"...","isDemo":0,...}])'
 : 'Paste demo SSID (42["auth",{"session":"...","isDemo":1,...}])';
 }

 onSsidFocus(account) {
 const state = this._slotState[account];
 if (!state?.editing && state?.full) this.beginSsidEdit(account);
 }

 onSsidBlur(account) {
 const state = this._slotState[account];
 const els = this.slotEls(account);
 if (!state?.editing || !els?.input) return;

 const value = (els.input.value || '').trim();
 if (!value) {
 if (state.full) this.showSavedSsidMasked(account, state.full);
 return;
 }
 if (value.includes(' ·  ·  · ')) return;
 state.full = value;
 this.showSavedSsidMasked(account, value);
 }

 onSsidInput(account) {
 if (!this._slotState[account]?.editing) return;
 this.clearError();

 const ssid = this.getSsidValue(account);
 const els = this.slotEls(account);
 if (!els?.hint) return;

 if (!ssid) {
 els.hint.style.display = 'none';
 return;
 }

 const detected = this.detectAccountFromSsid(ssid);
 if (!detected) return;

 if (detected !== account) {
 const want = account === 'demo' ? 'Demo' : 'Real';
 const got = detected === 'demo' ? 'Demo' : 'Real';
 els.hint.textContent = `SSID is ${got} - paste a ${want} token in this section`;
 els.hint.classList.add('is-warning');
 } else {
 els.hint.textContent = `Matches ${account === 'real' ? 'Real' : 'Demo'} account`;
 els.hint.classList.remove('is-warning');
 }
 els.hint.style.display = 'block';
 }

 async loadSlotFromDisk(account) {
 if (!this.currentBotId) return;
 const els = this.slotEls(account);
 try {
 const result = await ipcRenderer.invoke('load-pocket-option-ssids', { botId: this.currentBotId });
 const ssid = account === 'real' ? result?.realSsid : result?.demoSsid;
 const currency = account === 'real' ? result?.realCurrency : result?.demoCurrency;
 const hasSlot = account === 'real' ? !!result?.hasReal : !!result?.hasDemo;

 if (ssid) this.showSavedSsidMasked(account, ssid);
 else {
 this._slotState[account].full = '';
 this._slotState[account].editing = false;
 this.showSavedSsidMasked(account, '');
 }

 if (els?.currency && currency) els.currency.value = currency;
 if (els?.disconnectBtn) els.disconnectBtn.style.display = hasSlot ? 'inline-flex' : 'none';
 if (els?.hint) {
 if (ssid) {
 els.hint.textContent = `Saved ${account === 'real' ? 'Real' : 'Demo'} SSID · hidden for security (click field to replace)`;
 els.hint.classList.remove('is-warning');
 els.hint.style.display = 'block';
 } else {
 els.hint.style.display = 'none';
 }
 }
 } catch (e) {}
 }

 async loadAllSlots() {
 await Promise.all(['demo', 'real'].map((a) => this.loadSlotFromDisk(a)));
 }

 updateSlotBalance(account, slot, hasSaved) {
 const els = this.slotEls(account);
 if (!els) return;

 const botStatus = this.currentBotId ? this.statusByBot[this.currentBotId] : null;
 const isActiveAccount = botStatus && botStatus.activeAccount === account;
 const shouldShowOnline = !!(hasSaved && isActiveAccount && slot?.online);

 if (els.panelDot) {
 els.panelDot.classList.remove('is-online', 'is-saved');
 if (shouldShowOnline) els.panelDot.classList.add('is-online');
 else if (hasSaved) els.panelDot.classList.add('is-saved');
 }

 if (els.panelStatus) {
 if (!hasSaved) {
 els.panelStatus.textContent = 'Offline';
 els.panelStatus.className = 'ssid-slot-badge';
 } else if (shouldShowOnline) {
 els.panelStatus.textContent = 'Online';
 els.panelStatus.className = 'ssid-slot-badge is-online';
 } else {
 els.panelStatus.textContent = slot?.expired ? 'Expired' : 'Saved';
 els.panelStatus.className = 'ssid-slot-badge is-saved';
 }
 }

 if (els.balanceAmount) {
  const showBal = shouldShowOnline && Number.isFinite(Number(slot?.balance)) && Number(slot.balance) >= 0;
  if (showBal) {
   els.balanceAmount.textContent = this.formatMoney(slot.balance, slot.currency) || '';
   els.balanceAmount.classList.add('is-visible');
  } else if (hasSaved && isActiveAccount && shouldShowOnline && Number.isFinite(Number(botStatus?.balance)) && Number(botStatus.balance) >= 0) {
   els.balanceAmount.textContent = this.formatMoney(botStatus.balance, botStatus.currency) || '';
   els.balanceAmount.classList.add('is-visible');
  } else {
   els.balanceAmount.textContent = '';
   els.balanceAmount.classList.remove('is-visible');
  }
 }

 if (els.balanceTime) {
 if (hasSaved) {
 els.balanceTime.textContent = shouldShowOnline
 ? `Updated ${new Date().toLocaleTimeString()}`
 : (slot?.expired ? 'Session expired - paste new SSID' : 'Saved · not trading');
 els.balanceTime.style.display = 'block';
 } else {
 els.balanceTime.style.display = 'none';
 }
 }

 if (els.currency && slot?.currency) {
 try { els.currency.value = String(slot.currency).toUpperCase(); } catch (e) {}
 } else if (els.currency && isActiveAccount && botStatus?.currency) {
 try { els.currency.value = String(botStatus.currency).toUpperCase(); } catch (e) {}
 }
 }

 updateBalancesFromStatus(status) {
 if (!status) return;

 this.updateSlotVisibility(status);
 this.updateSlotBalance('demo', status.demo, !!status.hasDemo);
 this.updateSlotBalance('real', status.real, !!status.hasReal);
 this.highlightAutotradeSlot(status);

 const bothConnected = !!(status.hasDemo && status.hasReal);
 if (this.autotradePicker) {
 this.autotradePicker.style.display = bothConnected ? 'flex' : 'none';
 }

 if (bothConnected) {
 const active = status.activeAccount === 'real' ? 'real' : 'demo';
 if (this.autotradeDemo) this.autotradeDemo.checked = active === 'demo';
 if (this.autotradeReal) this.autotradeReal.checked = active === 'real';
 }
 }

 highlightAutotradeSlot(status) {
 const active = status?.activeAccount === 'real' ? 'real' : 'demo';
 for (const account of ['demo', 'real']) {
 const slotEl = document.querySelector(`.ssid-slot.is-${account}`);
 if (!slotEl) continue;
 const isActive = account === active && (status?.hasDemo || status?.hasReal);
 slotEl.classList.toggle('is-active-autotrade', isActive && !!(status?.hasDemo && status?.hasReal));
 }
 }

 slotHasSavedOrDraft(account, status) {
 if (account === 'demo') {
 return !!(status?.hasDemo || this._slotState.demo.full || String(this.slotEls('demo')?.input?.value || '').trim());
 }
 return !!(status?.hasReal || this._slotState.real.full || String(this.slotEls('real')?.input?.value || '').trim());
 }

 ensureShowAltSlotButton(account) {
 const btnId = `ssidShow${account === 'demo' ? 'Demo' : 'Real'}`;
 let btn = document.getElementById(btnId);
 if (!btn) {
 btn = document.createElement('button');
 btn.id = btnId;
 btn.type = 'button';
 btn.className = 'ssid-show-alt-slot';
 btn.addEventListener('click', () => {
 const slotEl = document.querySelector(`.ssid-slot.is-${account}`);
 if (slotEl) slotEl.style.display = '';
 btn.style.display = 'none';
 const input = this.slotEls(account)?.input;
 if (input) input.focus();
 });
 const body = document.querySelector('.ssid-modal-body');
 if (body) body.appendChild(btn);
 }
 btn.textContent = account === 'demo' ? '+ Add demo account' : '+ Add real account';
 return btn;
 }

 updateSlotVisibility(status) {
 const hasDemo = this.slotHasSavedOrDraft('demo', status);
 const hasReal = this.slotHasSavedOrDraft('real', status);
 const onlyOne = hasDemo !== hasReal;

 for (const account of ['demo', 'real']) {
 const slotEl = document.querySelector(`.ssid-slot.is-${account}`);
 if (!slotEl) continue;
 const hasThis = account === 'demo' ? hasDemo : hasReal;
 const show = !onlyOne || hasThis;
 slotEl.style.display = show ? '' : 'none';

 const btn = this.ensureShowAltSlotButton(account);
 btn.style.display = (!show && onlyOne) ? 'inline-flex' : 'none';
 }
 }

 formatOfflinePillLabel(status) {
 if (!status) return { text: 'Offline', title: 'Open Connect to link Pocket Option' };
 if (status.expired) {
 return {
 text: 'SSID expired',
 title: 'Paste a new Pocket Option SSID in Connect'
 };
 }
 const slot = status[status.activeAccount] || {};
 if (slot.expired) {
 return {
 text: 'SSID expired',
 title: 'Paste a new Pocket Option SSID in Connect'
 };
 }
 if (status.hasSsid) {
 const account = status.activeAccount === 'real' ? 'Real' : 'Demo';
 return {
 text: `${account} · reconnecting`,
 title: 'SSID saved - checking connection'
 };
 }
 return { text: 'Offline', title: 'Open Connect to link Pocket Option' };
 }

 async onAutotradePickChange() {
 if (!this.currentBotId) return;
 const account = this.autotradeReal?.checked ? 'real' : 'demo';
 const status = this.statusByBot[this.currentBotId];
 if (!status) return;
 if (account === 'real' && !status.hasReal) return;
 if (account === 'demo' && !status.hasDemo) return;
 if (status.activeAccount === account) return;

 this.clearError();
 try {
 for (const botId of SHARED_BOTS) {
 const res = await ipcRenderer.invoke('set-pocket-option-autotrade-account', {
 botId,
 account
 });
 if (res?.status) {
 this.statusByBot[botId] = res.status;
 this.updateBotStatusUI(botId, res.status);
 } else if (!res?.success) {
 throw new Error(res?.error || 'Switch failed');
 }
 }
 const next = this.statusByBot[this.currentBotId];
 if (next) this.updateBalancesFromStatus(next);
 } catch (e) {
 if (status) {
 this.updateBalancesFromStatus(status);
 if (this.autotradeDemo) this.autotradeDemo.checked = status.activeAccount === 'demo';
 if (this.autotradeReal) this.autotradeReal.checked = status.activeAccount === 'real';
 }
 this.showError(e.message || 'Could not switch trading account');
 }
 }

 addBotButtons() {
 // Only section-bot1 / section-bot2 - never the menu section-bots.
 document.querySelectorAll('section[id^="section-bot"]').forEach((section) => {
 const match = String(section.id || '').match(/^section-(bot\d+)$/);
 if (!match) return;
 const botId = match[1];
 if (!SHARED_BOTS.includes(botId)) return;

 const header = section.querySelector('.section-header');
 if (!header || header.querySelector('.ssid-connect-pill')) return;

 const btn = document.createElement('button');
 btn.type = 'button';
 btn.className = 'ssid-connect-pill offline';
 btn.dataset.botId = botId;
 btn.title = 'Connect Pocket Option for autotrade';
 btn.innerHTML = '<span class="ssid-connect-dot"></span><span class="ssid-connect-text">Connect</span>';
 btn.addEventListener('click', (e) => {
 e.preventDefault();
 this.requestOpenModal(botId);
 });

 const historyBtn = header.querySelector('[id^="historyBtn-"]');
 if (historyBtn) historyBtn.parentNode.insertBefore(btn, historyBtn.nextSibling);
 else header.appendChild(btn);

 this.updateBotStatusUI(botId, null);
 });
 }

 listenForStatusUpdates() {
 ipcRenderer.on('ssid-status-update', (_event, payload) => {
 if (!payload?.botId) return;
 this.statusByBot[payload.botId] = payload.status;
 this.updateBotStatusUI(payload.botId, payload.status);
 // Keep both bot pills in sync when they share one SSID session.
 if (payload.status?.activeOnline && payload.status?.hasSsid) {
 this.mirrorOnlineStatus(payload.botId, payload.status);
 }
 if (payload.botId === this.currentBotId && this.modal?.classList.contains('active')) {
 this.updateBalancesFromStatus(payload.status);
 }
 try { window.refreshAllBotEmptyStates?.(); } catch (e) {}
 // Expiry / hard offline must pause AT UI — not only block places in main.
 try {
   if (window.connectionSystem && typeof window.connectionSystem.onSsidConnected === 'function') {
     window.connectionSystem.onSsidConnected(payload.botId, payload.status);
   }
 } catch (eCs) {}
 });
 }

 mirrorOnlineStatus(sourceBotId, status) {
  if (!status?.activeOnline) return;
  if (!Number.isFinite(Number(status.balance)) || Number(status.balance) < 0) return;
  for (const id of SHARED_BOTS) {
   if (id === sourceBotId) continue;
   const other = this.statusByBot[id];
   if (!other?.hasSsid) continue;
   this.statusByBot[id] = {
    ...other,
    ...status,
    botId: id,
    hasSsid: true,
    hasDemo: other.hasDemo ?? status.hasDemo,
    hasReal: other.hasReal ?? status.hasReal,
    activeOnline: true,
    updatedAt: Date.now()
   };
   this.updateBotStatusUI(id, this.statusByBot[id]);
  }
 }

 startStatusPolling() {
 this.refreshAllStatuses();
 if (this.statusPollTimer) clearInterval(this.statusPollTimer);
 this.statusPollTimer = setInterval(() => this.refreshAllStatuses(), 60000);
 }

 async refreshAllStatuses() {
 try {
 const res = await ipcRenderer.invoke('get-pocket-option-ssid-status', {});
 if (res?.success && res.statuses) {
 Object.entries(res.statuses).forEach(([botId, status]) => {
 if (!status) return;
 this.statusByBot[botId] = status;
 this.updateBotStatusUI(botId, status);
 });
 }

 for (const botId of SHARED_BOTS) {
 const cached = this.statusByBot[botId];
 if (!cached?.hasSsid) continue;
 const age = cached.updatedAt ? (Date.now() - cached.updatedAt) : Infinity;
 const minAge = cached.activeOnline ? 90000 : 40000;
 if (age < minAge) continue;
 const statusRes = await ipcRenderer.invoke('refresh-pocket-option-ssid-status', {
 botId,
 maxAge: 25000
 });
 if (statusRes?.status) {
 this.statusByBot[botId] = statusRes.status;
 this.updateBotStatusUI(botId, statusRes.status);
 if (this.currentBotId === botId && this.modal?.classList.contains('active')) {
 this.updateBalancesFromStatus(statusRes.status);
 }
 }
 await new Promise((r) => setTimeout(r, 400));
 }
 } catch (e) {}
 }

 startModalBalanceRefresh() {
 this.stopModalBalanceRefresh();
 this.refreshModalBalance(true);
 this._modalBalanceTimer = setInterval(() => this.refreshModalBalance(false), 20000);
 }

 stopModalBalanceRefresh() {
 if (this._modalBalanceTimer) {
 clearInterval(this._modalBalanceTimer);
 this._modalBalanceTimer = null;
 }
 }

 async refreshModalBalance(force = false) {
 if (!this.currentBotId) return;
 const cached = this.statusByBot[this.currentBotId];
 if (cached) this.updateBalancesFromStatus(cached);

 const hasAny = cached?.hasDemo || cached?.hasReal || this._slotState.demo.full || this._slotState.real.full;
 if (!hasAny) return;

 try {
 if (force && this.balanceLoading) this.balanceLoading.style.display = 'block';
 const statusRes = await ipcRenderer.invoke('refresh-pocket-option-ssid-status', {
 botId: this.currentBotId,
 force,
 maxAge: force ? 0 : 15000
 });
 if (statusRes?.status) {
 this.statusByBot[this.currentBotId] = statusRes.status;
 this.updateBotStatusUI(this.currentBotId, statusRes.status);
 this.updateBalancesFromStatus(statusRes.status);
 for (const id of SHARED_BOTS) {
 if (id === this.currentBotId) continue;
 if (this.statusByBot[id]?.hasSsid) {
 this.statusByBot[id] = { ...statusRes.status, botId: id };
 this.updateBotStatusUI(id, this.statusByBot[id]);
 }
 }
 }
 } catch (e) {} finally {
 if (this.balanceLoading) this.balanceLoading.style.display = 'none';
 }
 }

 updateBotStatusUI(botId, status) {
  const btn = document.querySelector(`.ssid-connect-pill[data-bot-id="${botId}"]`);
  if (!btn) return;

  const textEl = btn.querySelector('.ssid-connect-text');
  const online = !!(status && status.activeOnline && Number.isFinite(Number(status.balance)) && Number(status.balance) >= 0);
  const hasSsid = !!(status && status.hasSsid);
  const pillLabel = this.formatPillLabel(status);

  btn.classList.toggle('online', online);
  btn.classList.toggle('offline', !online && !hasSsid);
  btn.classList.toggle('saved', hasSsid && !online);

  if (online && pillLabel) {
   if (textEl) textEl.textContent = pillLabel;
   btn.title = pillLabel;
  } else if (hasSsid) {
   const offline = this.formatOfflinePillLabel(status);
   if (textEl) textEl.textContent = offline.text;
   btn.title = offline.title;
  } else {
   if (textEl) textEl.textContent = 'Connect';
   btn.title = 'Link Pocket Option account';
  }
 }

 setPillConnecting(botId, account) {
  const btn = document.querySelector(`.ssid-connect-pill[data-bot-id="${botId}"]`);
  if (!btn) return;
  const textEl = btn.querySelector('.ssid-connect-text');
  const label = account === 'real' ? 'Real' : 'Demo';
  btn.classList.remove('online', 'saved');
  btn.classList.add('offline');
  if (textEl) textEl.textContent = `${label} · connecting…`;
  btn.title = 'Connecting to Pocket Option…';
 }

 hintConnect(botId) {
 const btn = document.querySelector(`.ssid-connect-pill[data-bot-id="${botId}"]`);
 if (!btn) return;
 btn.classList.add('hint-pulse');
 setTimeout(() => btn.classList.remove('hint-pulse'), 1600);
 btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
 try {
 window.setBotAutotradeReason?.(botId, 'Connect Pocket Option to enable autotrade');
 } catch (e) {}
 }

 requestOpenModal(botId) {
 this._pendingWarningBotId = botId;
 this.openSsidWarning();
 }

 openSsidWarning() {
 if (!this.warningModal) {
 this.openModal(this._pendingWarningBotId);
 return;
 }
 this.warningModal.classList.add('active');
 this.warningModal.style.display = 'flex';
 document.body.classList.add('modal-open');
 }

 closeSsidWarning() {
 this._pendingWarningBotId = null;
 if (!this.warningModal) return;
 this.warningModal.classList.remove('active');
 this.warningModal.style.display = 'none';
 if (!this.modal?.classList.contains('active')) {
 document.body.classList.remove('modal-open');
 }
 }

 acceptSsidWarning() {
 const botId = this._pendingWarningBotId;
 this._pendingWarningBotId = null;
 if (this.warningModal) {
 this.warningModal.classList.remove('active');
 this.warningModal.style.display = 'none';
 }
 if (botId) this.openModal(botId);
 }

 async openModal(botId) {
 this.currentBotId = botId;
 this._slotState.demo = { full: '', editing: false };
 this._slotState.real = { full: '', editing: false };
 this.clearError();
 if (this.balanceLoading) this.balanceLoading.style.display = 'none';

 for (const account of ['demo', 'real']) {
 const els = this.slotEls(account);
 if (els?.hint) els.hint.style.display = 'none';
 }

 await this.loadAllSlots();

 const cached = this.statusByBot[botId];
 if (cached) this.updateBalancesFromStatus(cached);
 else this.updateSlotVisibility(null);

 this.startModalBalanceRefresh();
 this.modal.classList.add('active');
 this.modal.style.display = 'flex';
 document.body.classList.add('modal-open');
 }

 closeModal() {
 this.stopModalBalanceRefresh();
 this.modal.classList.remove('active');
 this.modal.style.display = 'none';
 document.body.classList.remove('modal-open');
 }

 clearError() {
 if (!this.ssidError) return;
 this.ssidError.style.display = 'none';
 this.ssidError.textContent = '';
 }

 showError(message) {
 if (!this.ssidError) return;
 this.ssidError.textContent = message;
 this.ssidError.style.display = 'block';
 }

 getSelectedCurrency(account) {
 const els = this.slotEls(account);
 return (els?.currency?.value || 'USD').toUpperCase();
 }

 detectAccountFromSsid(ssid) {
 const raw = String(ssid || '').trim();
 if (!raw) return null;
 const start = raw.indexOf('{');
 const end = raw.lastIndexOf('}') + 1;
 if (start !== -1 && end > start) {
 try {
 const auth = JSON.parse(raw.slice(start, end));
 return auth.isDemo === 1 || auth.isDemo === true ? 'demo' : 'real';
 } catch (e) {}
 }
 if (raw.includes('"isDemo":1') || raw.includes('"isDemo": 1')) return 'demo';
 if (raw.includes('"isDemo":0') || raw.includes('"isDemo": 0')) return 'real';
 return null;
 }

 normalizeSsid(raw) {
 let s = String(raw || '').trim();
 if (!s) return s;
 s = s
 .replace(/[\u201C\u201D]/g, '"')
 .replace(/[\u2018\u2019]/g, "'")
 .replace(/'/g, '"');
 const idx = s.indexOf('42["auth"');
 if (idx > 0) s = s.slice(idx);
 if (s.startsWith('{') && s.includes('"session"') && s.includes('"isDemo"')) {
 s = `42["auth",${s}]`;
 }
 return s.trim();
 }

 validateSSID(ssid, expectedAccount) {
 const trimmed = this.normalizeSsid(ssid);
 if (!trimmed) return { valid: false, error: 'Paste your Pocket Option SSID' };
 if (!trimmed.startsWith('42["auth"')) {
 return { valid: false, error: 'Invalid format - must start with 42["auth"' };
 }
 if (!trimmed.includes('"session"') || !trimmed.includes('"isDemo"')) {
 return { valid: false, error: 'Missing session or isDemo field' };
 }
 const detected = this.detectAccountFromSsid(trimmed);
 if (!detected) return { valid: false, error: 'Could not read isDemo from SSID' };
 if (detected !== expectedAccount) {
 const want = expectedAccount === 'demo' ? 'Demo' : 'Real';
 const got = detected === 'demo' ? 'Demo' : 'Real';
 return { valid: false, error: `${got} SSID pasted in ${want} section - use the correct field` };
 }
 return { valid: true, account: detected, ssid: trimmed };
 }

 setConnectBusy(account, busy) {
 const els = this.slotEls(account);
 if (els?.connectBtn) els.connectBtn.disabled = busy;
 if (els?.disconnectBtn) els.disconnectBtn.disabled = busy;
 for (const other of ['demo', 'real']) {
 if (other === account) continue;
 const o = this.slotEls(other);
 if (o?.connectBtn) o.connectBtn.disabled = busy;
 }
 if (busy && this.balanceLoading) {
 this.balanceLoading.style.display = 'block';
 const span = this.balanceLoading.querySelector('span');
 if (span) span.textContent = 'Connecting...';
 } else if (this.balanceLoading) {
 this.balanceLoading.style.display = 'none';
 const span = this.balanceLoading.querySelector('span');
 if (span) span.textContent = 'Checking...';
 }
 }

 async saveSsid(account) {
 if (this._connectInFlight) return;

 const ssid = this.normalizeSsid(this.getSsidValue(account));
 const currency = this.getSelectedCurrency(account);
 const validation = this.validateSSID(ssid, account);

 if (!validation.valid) {
 this.showError(validation.error);
 return;
 }

 this._connectInFlight = true;
 this.setConnectBusy(account, true);
 this.clearError();
 for (const id of SHARED_BOTS) {
  this.setPillConnecting(id, account);
 }

 try {
 const result = await ipcRenderer.invoke('save-pocket-option-ssids', {
 botId: this.currentBotId || 'bot1',
 ssid: validation.ssid || ssid,
 account,
 currency,
 applyToAllBots: true
 });

 if (!result.success) throw new Error(result.error || 'Failed to connect');

 const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
 let onlineStatus = result.status || null;
 const applyStatus = (status) => {
 if (!status) return;
 for (const id of SHARED_BOTS) {
 this.statusByBot[id] = { ...status, botId: id };
 this.updateBotStatusUI(id, this.statusByBot[id]);
 window.connectionSystem?.onSsidConnected?.(id, this.statusByBot[id]);
 }
 if (status.activeOnline) onlineStatus = status;
 };

 applyStatus(onlineStatus);

 for (let i = 0; i < 4 && !onlineStatus?.activeOnline; i++) {
 await sleep(1500);
 const statusRes = await ipcRenderer.invoke('refresh-pocket-option-ssid-status', {
 botId: this.currentBotId || 'bot1',
 force: true
 });
 applyStatus(statusRes?.status);
 }

 if (onlineStatus) this.updateBalancesFromStatus(onlineStatus);

 const els = this.slotEls(account);
 if (els?.disconnectBtn) els.disconnectBtn.style.display = 'inline-flex';
 this.showSavedSsidMasked(account, ssid);

 if (onlineStatus?.activeOnline) {
 this.closeModal();
 } else {
 const raw = String(result.helperError || onlineStatus?.error || '');
        if (onlineStatus?.expired || /expired|unauthorized|invalid\s+(ssid|token)/i.test(raw)) {
          this.showError('SSID expired. Paste a fresh 42["auth",...] token');
        } else if (/ModuleNotFoundError|missing helper|missing script/i.test(raw)) {
          this.showError('Pocket Option helper is missing a file in this install. Update or reinstall the app, then connect again.');
        } else if (/python|spawn|ENOENT|helper|worker|missing/i.test(raw)) {
          this.showError('Pocket Option helper is starting. Keep the app open and click Connect again in a moment.');
        } else {
          this.showError('SSID saved. Pocket Option is still connecting. Keep the app open, it will retry. If it stays offline, paste a fresh token.');
        }
 }
 } catch (error) {
 this.showError(error.message || 'Could not connect');
 } finally {
 this._connectInFlight = false;
 this.setConnectBusy(account, false);
 }
 }

 async disconnect(account) {
  if (!this.currentBotId || this._connectInFlight) return;
  const els = this.slotEls(account);
  if (els?.disconnectBtn) els.disconnectBtn.disabled = true;
  this._connectInFlight = true;

  for (const id of SHARED_BOTS) {
   this.statusByBot[id] = null;
   this.updateBotStatusUI(id, null);
  }

  this._slotState[account].full = '';
  this._slotState[account].editing = false;
  this.showSavedSsidMasked(account, '');
  if (els?.disconnectBtn) els.disconnectBtn.style.display = 'none';
  if (els?.hint) els.hint.style.display = 'none';
  if (els?.balanceAmount) {
   els.balanceAmount.textContent = '';
   els.balanceAmount.classList.remove('is-visible');
  }
  if (els?.balanceTime) els.balanceTime.style.display = 'none';

  try {
   await ipcRenderer.invoke('disconnect-pocket-option-ssid', {
    botId: this.currentBotId,
    account,
    applyToAllBots: true
   });

   for (const id of SHARED_BOTS) {
    this.statusByBot[id] = null;
    this.updateBotStatusUI(id, null);

    const toggle = document.getElementById(`autoTradeToggle-${id}`);
    if (toggle) toggle.checked = false;
    try {
      if (window.connectionSystem && typeof window.connectionSystem.pushEnabled === 'function') {
        window.connectionSystem.pushEnabled(id, false, { source: 'hard-disconnect' });
      } else {
        ipcRenderer.send('sync-autotrade-config', {
          botId: id,
          enabled: false,
          source: 'hard-disconnect'
        });
      }
    } catch (eOff) {}
    try { window.setBotAutotradeReason?.(id, 'Disconnected. Auto trade paused.'); } catch (eR) {}
   }

   const status = this.statusByBot[this.currentBotId];
   this.updateBalancesFromStatus(status || null);
  } catch (e) {
   this.showError(e.message || 'Disconnect failed');
  } finally {
   this._connectInFlight = false;
   if (els?.disconnectBtn) els.disconnectBtn.disabled = false;
  }
 }

 isBotOnline(botId) {
 return !!(this.statusByBot[botId]?.activeOnline);
 }
}

if (document.readyState === 'loading') {
 document.addEventListener('DOMContentLoaded', () => { window.ssidManager = new SSIDManager(); });
} else {
 window.ssidManager = new SSIDManager();
}
