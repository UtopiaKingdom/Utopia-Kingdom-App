/**
 * wallet-local-ledger.js — Dev/local custodial ledger when Worker wallet API is offline.
 * Persists under Electron userData. Same shapes as wallet-cf.js public responses.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WALLET_ASSETS, WALLET_COUNTRIES, WALLET_LIMITS } = require('./wallet-config.js');

function nowIso() {
  return new Date().toISOString();
}

function emptyWallet(uid, email) {
  return {
    uid,
    email: email || '',
    status: 'active',
    enabled: true,
    frozen: false,
    kycStatus: 'none',
    kycCountry: '',
    balances: {
      USDT: { available: 0, pending: 0 },
      BTC: { available: 0, pending: 0 },
      USD: { available: 0, pending: 0 },
    },
    depositAddresses: {},
    limits: Object.assign({}, WALLET_LIMITS),
    dailyWithdrawUsd: 0,
    dailyWithdrawDay: '',
    txs: [],
    updatedAt: nowIso(),
    createdAt: nowIso(),
  };
}

function createLocalLedger(userDataPath) {
  const dir = path.join(userDataPath, 'utk-wallet');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  function fileFor(uid) {
    return path.join(dir, String(uid || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  }

  function load(uid) {
    const f = fileFor(uid);
    if (!fs.existsSync(f)) return emptyWallet(uid, '');
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) {
      return emptyWallet(uid, '');
    }
  }

  function save(wallet) {
    wallet.updatedAt = nowIso();
    fs.writeFileSync(fileFor(wallet.uid), JSON.stringify(wallet, null, 2), 'utf8');
  }

  function ensureAddresses(wallet) {
    const out = Object.assign({}, wallet.depositAddresses || {});
    for (const row of WALLET_ASSETS) {
      const key = row.asset + ':' + row.network;
      if (out[key] && out[key].address) continue;
      const digest = crypto.createHmac('sha256', 'utk-local-wallet').update(wallet.uid + '|' + key).digest('hex');
      let address;
      if (row.asset === 'BTC') address = 'bc1q' + digest.slice(0, 38);
      else if (row.network === 'TRC20') address = 'T' + digest.slice(0, 33).toUpperCase();
      else address = '0x' + digest.slice(0, 40);
      out[key] = {
        asset: row.asset,
        network: row.network,
        label: row.label,
        address,
        confirmationsRequired: row.confirmations,
        partner: 'local-sandbox',
        createdAt: nowIso(),
      };
    }
    wallet.depositAddresses = out;
    return out;
  }

  function publicStatus(wallet, liveMeta) {
    const partner = wallet.partner || (liveMeta && liveMeta.mode) || 'local-sandbox';
    const live = !!(liveMeta && liveMeta.live) || partner === 'cryptomus' || partner === 'bridge';
    return {
      ok: true,
      enabled: true,
      frozen: !!wallet.frozen,
      status: wallet.status || 'active',
      kycStatus: wallet.kycStatus || 'none',
      kycCountry: wallet.kycCountry || '',
      kycUrl: wallet.kycUrl || null,
      partner,
      partnerName: live
        ? ((liveMeta && liveMeta.label) || (partner === 'cryptomus' ? 'Cryptomus (live)' : 'Live rails'))
        : 'UtK Local Sandbox',
      balances: wallet.balances,
      depositAddresses: wallet.depositAddresses || {},
      assets: WALLET_ASSETS,
      countries: WALLET_COUNTRIES,
      limits: Object.assign({}, WALLET_LIMITS, wallet.limits || {}),
      dailyWithdrawUsd: Number(wallet.dailyWithdrawUsd || 0),
      txs: Array.isArray(wallet.txs) ? wallet.txs.slice(0, 40) : [],
      updatedAt: wallet.updatedAt,
      local: !live,
      live: !!live,
      liveMeta: liveMeta || null,
      bridgeCustomerId: wallet.bridgeCustomerId || null,
    };
  }

  function pushTx(wallet, tx) {
    if (!Array.isArray(wallet.txs)) wallet.txs = [];
    wallet.txs.unshift(tx);
    if (wallet.txs.length > 200) wallet.txs.length = 200;
  }

  return {
    status(uid, email, liveMeta) {
      const w = load(uid);
      if (email) w.email = email;
      // Only synthesize fake addresses when not on live rails
      if (!(liveMeta && liveMeta.live) && !(w.partner === 'cryptomus' || w.partner === 'bridge')) {
        ensureAddresses(w);
      }
      save(w);
      return publicStatus(w, liveMeta);
    },
    ensureAddresses(uid) {
      const w = load(uid);
      if (w.frozen) return { ok: false, error: 'wallet_frozen' };
      const depositAddresses = ensureAddresses(w);
      save(w);
      return { ok: true, depositAddresses, partner: w.partner || 'local-sandbox' };
    },
    /** Replace/merge live partner addresses (Cryptomus). */
    setLiveAddresses(uid, rows, partner) {
      const w = load(uid);
      if (!w.depositAddresses) w.depositAddresses = {};
      for (const row of rows || []) {
        if (!row || !row.address) continue;
        const key = (row.asset || 'USDT') + ':' + (row.network || 'TRC20');
        w.depositAddresses[key] = Object.assign({}, w.depositAddresses[key] || {}, row, {
          partner: partner || 'cryptomus',
          createdAt: (w.depositAddresses[key] && w.depositAddresses[key].createdAt) || new Date().toISOString(),
        });
      }
      w.partner = partner || 'cryptomus';
      save(w);
      return { ok: true, depositAddresses: w.depositAddresses, partner: w.partner };
    },
    getRaw(uid) {
      return load(uid);
    },
    saveRaw(wallet) {
      save(wallet);
    },
    hasSeenTx(uid, chainTxId) {
      const w = load(uid);
      return (w.txs || []).some((t) => t && t.chainTxId && t.chainTxId === chainTxId);
    },
    setPartnerMeta(uid, meta) {
      const w = load(uid);
      Object.assign(w, meta || {});
      save(w);
      return w;
    },
    kycStart(uid, country) {
      const w = load(uid);
      const c = String(country || '').toUpperCase();
      if (!WALLET_COUNTRIES.includes(c)) return { ok: false, error: 'country_unsupported', countries: WALLET_COUNTRIES };
      w.kycCountry = c;
      w.kycStatus = 'verified';
      w.kycVerifiedAt = nowIso();
      save(w);
      return { ok: true, kycStatus: 'verified', kycCountry: c, kycUrl: null };
    },
    withdrawBank(uid, body) {
      const w = load(uid);
      if (w.frozen) return { ok: false, error: 'wallet_frozen' };
      if (w.kycStatus !== 'verified') return { ok: false, error: 'kyc_required' };
      const amount = Number(body.amount);
      const limits = Object.assign({}, WALLET_LIMITS, w.limits || {});
      if (!Number.isFinite(amount) || amount < limits.minWithdrawUsd) {
        return { ok: false, error: 'below_minimum', min: limits.minWithdrawUsd };
      }
      const fee = Math.round((amount * limits.feeWithdrawPct + limits.feeWithdrawUsd) * 100) / 100;
      const total = amount + fee;
      let usd = Number(w.balances.USD.available || 0);
      const usdt = Number(w.balances.USDT.available || 0);
      if (usd < total && usdt > 0) {
        const take = Math.min(total - usd, usdt);
        w.balances.USDT.available = usdt - take;
        usd += take;
        w.balances.USD.available = usd;
      }
      if (usd < total) return { ok: false, error: 'insufficient_balance', need: total, available: usd };
      w.balances.USD.available = usd - total;
      const txId = 'lwd_' + Date.now().toString(36);
      pushTx(w, {
        id: txId,
        type: 'withdraw_bank',
        asset: 'USD',
        amount,
        fee,
        status: 'settled',
        partnerRef: 'local_' + txId,
        country: String(body.country || w.kycCountry || ''),
        ibanLast4: String(body.iban || '').slice(-4) || null,
        accountName: body.accountName || null,
        createdAt: nowIso(),
        settledAt: nowIso(),
      });
      save(w);
      return { ok: true, txId, amount, fee, status: 'settled', eta: 'instant (local sandbox)' };
    },
    sendPo(uid, body) {
      const w = load(uid);
      if (w.frozen) return { ok: false, error: 'wallet_frozen' };
      if (w.kycStatus !== 'verified') return { ok: false, error: 'kyc_required' };
      const asset = String(body.asset || 'USDT').toUpperCase();
      const amount = Number(body.amount);
      const address = String(body.address || '').trim();
      if (!address || address.length < 10) return { ok: false, error: 'bad_address' };
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'bad_amount' };
      const avail = Number((w.balances[asset] && w.balances[asset].available) || 0);
      if (avail < amount) return { ok: false, error: 'insufficient_balance', available: avail };
      w.balances[asset].available = avail - amount;
      const txId = 'lpo_' + Date.now().toString(36);
      pushTx(w, {
        id: txId,
        type: 'send_po',
        asset,
        network: body.network || (asset === 'BTC' ? 'BTC' : 'TRC20'),
        amount,
        address,
        status: 'settled',
        chainTxId: 'local_' + txId,
        createdAt: nowIso(),
      });
      save(w);
      return { ok: true, txId, status: 'settled', chainTxId: 'local_' + txId };
    },
    /** Dev helper: credit a deposit without chain. */
    credit(uid, { asset, amount, chainTxId }) {
      const w = load(uid);
      const a = String(asset || 'USDT').toUpperCase();
      const amt = Number(amount);
      if (!w.balances[a]) w.balances[a] = { available: 0, pending: 0 };
      w.balances[a].available = Number(w.balances[a].available || 0) + amt;
      pushTx(w, {
        id: 'ldep_' + Date.now().toString(36),
        type: 'deposit',
        asset: a,
        amount: amt,
        status: 'available',
        chainTxId: chainTxId || ('local_dep_' + Date.now()),
        createdAt: nowIso(),
      });
      save(w);
      return { ok: true };
    },
  };
}

module.exports = { createLocalLedger };
