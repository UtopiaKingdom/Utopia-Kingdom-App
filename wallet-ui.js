/**
 * wallet-ui.js — Simple user wallet: Deposit + Withdraw (+ History).
 * Owner credentials live in wallet-credentials.json / Worker secrets — never shown here.
 */
(function () {
  'use strict';

  if (window.__utkWalletUi) return;
  window.__utkWalletUi = true;

  const { ipcRenderer } = require('electron');
  let WALLET_COUNTRIES = [];
  let WALLET_LIMITS = {};
  try {
    const cfg = require('./wallet-config.js');
    WALLET_COUNTRIES = cfg.WALLET_COUNTRIES || [];
    WALLET_LIMITS = cfg.WALLET_LIMITS || {};
  } catch (_) {}

  let lastStatus = null;
  let refreshing = false;
  let pollTimer = null;
  let ensuring = false;
  let activeTab = 'deposit';

  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg, kind) {
    try {
      if (window.utkToast) window.utkToast(msg, kind || 'info');
      else if (window.showToast) window.showToast(msg);
    } catch (_) {}
  }

  async function authContext() {
    try {
      const av = require('./auth-verification.js');
      const auth = (av && av.auth) || window.auth;
      const user = auth && auth.currentUser;
      if (!user) return { token: '', uid: '', email: '' };
      const token = typeof user.getIdToken === 'function' ? await user.getIdToken() : '';
      return {
        token: token || '',
        uid: String(user.uid || ''),
        email: String(user.email || ''),
      };
    } catch (_) {
      return { token: '', uid: '', email: '' };
    }
  }

  async function invoke(channel, payload) {
    const ctx = await authContext();
    return ipcRenderer.invoke(channel, Object.assign({}, payload || {}, {
      token: ctx.token,
      uid: ctx.uid,
      email: ctx.email,
    }));
  }

  function fmt(n, digits) {
    const x = Number(n);
    if (!Number.isFinite(x)) return '0';
    return x.toLocaleString(undefined, {
      minimumFractionDigits: digits === 2 ? 2 : 0,
      maximumFractionDigits: digits == null ? 6 : digits,
    });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function friendlyType(type) {
    const t = String(type || '');
    if (t === 'deposit') return 'Deposit';
    if (t === 'withdraw_bank') return 'Bank withdraw';
    if (t === 'send_po') return 'Sent to Pocket Option';
    if (t === 'adjust') return 'Adjustment';
    return t || 'Activity';
  }

  function friendlyStatus(s) {
    const m = {
      available: 'Complete',
      confirming: 'Confirming…',
      pending: 'Pending',
      payout_pending: 'On the way',
      settled: 'Complete',
      failed: 'Failed',
    };
    return m[s] || s || '—';
  }

  function setTab(name) {
    activeTab = name || 'deposit';
    document.querySelectorAll('.wallet-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-wallet-tab') === activeTab);
    });
    document.querySelectorAll('.wallet-pane').forEach((pane) => {
      pane.classList.toggle('is-active', pane.getAttribute('data-wallet-pane') === activeTab);
    });
  }

  function paintBalances(st) {
    const bals = (st && st.balances) || {};
    const usdt = bals.USDT || {};
    const btc = bals.BTC || {};
    const usd = bals.USD || {};
    const usdAvail = Number(usd.available || 0) + Number(usdt.available || 0);
    const usdPend = Number(usd.pending || 0) + Number(usdt.pending || 0) + Number(btc.pending || 0);

    if ($('walletAvailUsd')) $('walletAvailUsd').textContent = '$' + fmt(usdAvail, 2);
    if ($('walletPendingUsd')) $('walletPendingUsd').textContent = '$' + fmt(usdPend, 2);
    if ($('walletPendingRow')) $('walletPendingRow').hidden = usdPend <= 0;
    if ($('walletBalUsdt')) $('walletBalUsdt').textContent = fmt(usdt.available, 2) + ' USDT';
    if ($('walletBalBtc')) $('walletBalBtc').textContent = fmt(btc.available, 8) + ' BTC';

    const min = (st && st.limits && st.limits.minWithdrawUsd) || WALLET_LIMITS.minWithdrawUsd || 20;
    const fee = (st && st.limits && st.limits.feeWithdrawUsd) || WALLET_LIMITS.feeWithdrawUsd || 0;
    if ($('walletFeeHint')) {
      $('walletFeeHint').textContent = 'Minimum $' + min + (fee ? ('. Fee about $' + fee + ' + 1%.') : '.');
    }
  }

  function paintAddresses(st) {
    const box = $('walletAddressList');
    const loading = $('walletAddrLoading');
    if (!box) return;
    const addrs = (st && st.depositAddresses) || {};
    const keys = Object.keys(addrs);
    if (!keys.length) {
      box.innerHTML = '';
      if (loading) loading.hidden = false;
      return;
    }
    if (loading) loading.hidden = true;

    // Prefer USDT first for most PO users
    keys.sort((a, b) => (a.indexOf('USDT') >= 0 ? -1 : 1) - (b.indexOf('USDT') >= 0 ? -1 : 1));

    box.innerHTML = keys.map((k) => {
      const row = addrs[k] || {};
      const addr = String(row.address || '');
      const isUsdt = String(row.asset || '').toUpperCase() === 'USDT';
      const title = isUsdt ? 'USDT · TRC20 (recommended)' : (row.label || (row.asset + ' · ' + row.network));
      const how = isUsdt
        ? 'In Pocket Option pick USDT and network TRC20'
        : 'In Pocket Option pick Bitcoin (BTC)';
      return (
        '<div class="wallet-addr-card">' +
          '<div class="wallet-addr-head"><strong>' + escapeHtml(title) + '</strong></div>' +
          '<p class="wallet-how">' + escapeHtml(how) + '</p>' +
          '<code class="wallet-addr-value">' + escapeHtml(addr) + '</code>' +
          '<button type="button" class="btn-primary wallet-copy-btn" data-copy="' + escapeAttr(addr) + '">Copy address</button>' +
        '</div>'
      );
    }).join('');
  }

  function paintHistory(st) {
    const list = $('walletTxList');
    if (!list) return;
    const txs = (st && st.txs) || [];
    if (!txs.length) {
      list.innerHTML = '<p class="wallet-muted">No activity yet. Deposit from Pocket Option to get started.</p>';
      return;
    }
    list.innerHTML = txs.map((tx) => {
      const amt = fmt(tx.amount, tx.asset === 'BTC' ? 8 : 2);
      return (
        '<div class="wallet-tx-row">' +
          '<div class="wallet-tx-main">' +
            '<strong>' + escapeHtml(friendlyType(tx.type)) + '</strong>' +
            '<span>' + escapeHtml(amt + ' ' + (tx.asset || '')) + '</span>' +
          '</div>' +
          '<div class="wallet-tx-meta">' +
            '<span class="wallet-tx-status">' + escapeHtml(friendlyStatus(tx.status)) + '</span>' +
            '<span class="wallet-muted">' + escapeHtml(String(tx.createdAt || '').replace('T', ' ').slice(0, 16)) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function fillCountrySelect(st) {
    const sel = $('walletCountry');
    if (!sel) return;
    const countries = (st && st.countries) || WALLET_COUNTRIES;
    const cur = sel.value || (st && st.kycCountry) || '';
    const names = {
      DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands',
      PL: 'Poland', GB: 'United Kingdom', BR: 'Brazil', MX: 'Mexico', NG: 'Nigeria',
      AT: 'Austria', BE: 'Belgium', CH: 'Switzerland', CZ: 'Czechia', DK: 'Denmark',
      EE: 'Estonia', FI: 'Finland', GR: 'Greece', HU: 'Hungary', IE: 'Ireland',
      LT: 'Lithuania', LV: 'Latvia', NO: 'Norway', PT: 'Portugal', RO: 'Romania',
      SE: 'Sweden', SK: 'Slovakia', SI: 'Slovenia', HR: 'Croatia', BG: 'Bulgaria',
      LU: 'Luxembourg', ZA: 'South Africa',
    };
    sel.innerHTML = '<option value="">Select your country</option>' +
      countries.map((c) => {
        const label = names[c] ? (names[c] + ' (' + c + ')') : c;
        return '<option value="' + escapeAttr(c) + '"' + (c === cur ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      }).join('');
  }

  async function ensureAddressesQuiet() {
    if (ensuring) return;
    const addrs = lastStatus && lastStatus.depositAddresses;
    if (addrs && Object.keys(addrs).length) return;
    ensuring = true;
    if ($('walletAddrLoading')) $('walletAddrLoading').hidden = false;
    try {
      await invoke('wallet-ensure-addresses', {});
      await refresh(true);
    } catch (_) {
    } finally {
      ensuring = false;
    }
  }

  async function refresh(skipEnsure) {
    if (refreshing) return;
    refreshing = true;
    const errEl = $('walletError');
    try {
      const ctx = await authContext();
      if (!ctx.token && !ctx.uid) {
        if (errEl) errEl.textContent = 'Sign in to use your wallet.';
        return;
      }
      const st = await invoke('wallet-get-status', {});
      if (!st || !st.ok) {
        if (errEl) errEl.textContent = 'Couldn’t load your wallet. Pull to refresh in a moment.';
        return;
      }
      if (errEl) errEl.textContent = '';
      lastStatus = st;
      paintBalances(st);
      paintAddresses(st);
      paintHistory(st);
      fillCountrySelect(st);

      const gate = $('walletDisabledGate');
      const body = $('walletBody');
      const disabled = st.enabled === false;
      if (gate) gate.hidden = !disabled;
      if (body) body.hidden = !!disabled;

      if (!skipEnsure) await ensureAddressesQuiet();

      if (st.live || st.partner === 'cryptomus' || (st.liveMeta && st.liveMeta.live)) {
        try {
          if (ctx.uid) {
            const polled = await ipcRenderer.invoke('wallet-poll-deposits', { uid: ctx.uid });
            if (polled && polled.credited > 0) {
              toast('Deposit received — balance updated');
              const st2 = await invoke('wallet-get-status', {});
              if (st2 && st2.ok) {
                lastStatus = st2;
                paintBalances(st2);
                paintHistory(st2);
              }
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      if (errEl) errEl.textContent = 'Something went wrong loading your wallet.';
    } finally {
      refreshing = false;
    }
  }

  async function openPo() {
    try {
      await ipcRenderer.invoke('open-external-url', { url: 'https://pocketoption.com/' });
    } catch (_) {
      toast('Couldn’t open Pocket Option', 'error');
    }
  }

  async function withdrawBank() {
    const amount = Number($('walletWithdrawAmount') && $('walletWithdrawAmount').value);
    const country = ($('walletCountry') && $('walletCountry').value) || '';
    const iban = ($('walletIban') && $('walletIban').value) || '';
    const accountName = ($('walletAccountName') && $('walletAccountName').value) || '';
    const min = (lastStatus && lastStatus.limits && lastStatus.limits.minWithdrawUsd) || WALLET_LIMITS.minWithdrawUsd || 20;

    if (!country) return toast('Select your country', 'error');
    if (!accountName || accountName.length < 2) return toast('Enter the name on the bank account', 'error');
    if (!iban || iban.replace(/\s+/g, '').length < 8) return toast('Enter a valid IBAN or account number', 'error');
    if (!Number.isFinite(amount) || amount < min) return toast('Minimum withdraw is $' + min, 'error');

    const btn = $('walletWithdrawBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }

    try {
      // Auto KYC as part of withdraw — user never sees a separate KYC button
      if (!lastStatus || lastStatus.kycStatus !== 'verified') {
        const kyc = await invoke('wallet-kyc-start', { country });
        if (kyc && kyc.kycUrl) {
          try { await ipcRenderer.invoke('open-external-url', { url: kyc.kycUrl }); } catch (_) {}
          toast('Complete the quick identity check, then tap Withdraw again');
          await refresh(true);
          return;
        }
        if (!kyc || !kyc.ok) {
          if (kyc && kyc.error === 'country_unsupported') {
            toast('Bank withdrawals aren’t available in your country yet', 'error');
          } else if (kyc && kyc.error === 'bridge_required') {
            toast('Bank withdrawals are still being set up. Deposits already work.', 'error');
          } else {
            toast('Couldn’t start verification. Try again in a moment.', 'error');
          }
          return;
        }
      }

      const res = await invoke('wallet-withdraw-bank', { amount, country, iban, accountName });
      if (!res || !res.ok) {
        const err = (res && res.error) || '';
        if (err === 'kyc_required') toast('Finish the identity check, then try again', 'error');
        else if (err === 'bridge_required') toast('Bank withdrawals are still being set up on our side', 'error');
        else if (err === 'insufficient_balance') toast('Not enough available balance', 'error');
        else if (err === 'country_unsupported') toast('Not available in your country yet', 'error');
        else toast((res && res.message) || 'Withdraw didn’t go through. Try again.', 'error');
        return;
      }

      toast(res.status === 'settled' ? 'Withdraw complete' : 'Withdraw submitted — we’ll notify you when it lands');
      if ($('walletWithdrawAmount')) $('walletWithdrawAmount').value = '';
      await refresh(true);
      setTab('history');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Withdraw to bank'; }
    }
  }

  function onClick(ev) {
    const t = ev.target;
    if (!t) return;

    const tab = t.closest && t.closest('[data-wallet-tab]');
    if (tab) {
      setTab(tab.getAttribute('data-wallet-tab'));
      return;
    }

    const copy = t.closest && t.closest('[data-copy]');
    if (copy) {
      const val = copy.getAttribute('data-copy') || '';
      if (val && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val)
          .then(() => toast('Address copied — paste it in Pocket Option'))
          .catch(() => toast('Couldn’t copy — select the address manually', 'error'));
      }
      return;
    }

    const id = t.id;
    if (id === 'walletRefreshBtn') refresh();
    else if (id === 'walletOpenPoBtn') openPo();
    else if (id === 'walletWithdrawBtn') withdrawBank();
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(() => {
      const sec = $('section-wallet');
      if (sec && sec.classList.contains('active')) refresh(true);
    }, 15000);
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function bind() {
    document.addEventListener('click', onClick);
    const section = $('section-wallet');
    if (section) {
      const obs = new MutationObserver(() => {
        if (section.classList.contains('active')) {
          refresh();
          startPoll();
        } else stopPoll();
      });
      obs.observe(section, { attributes: true, attributeFilter: ['class'] });
    }
    try { document.addEventListener('utk-auth-ready', () => refresh()); } catch (_) {}
    setTab('deposit');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  window.utkWalletRefresh = refresh;
})();
