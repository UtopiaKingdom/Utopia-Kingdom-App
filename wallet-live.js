/**
 * wallet-live.js — Real rails for Electron main process.
 * Cryptomus: live deposit addresses + crypto payouts (send to PO)
 * Bridge: KYC links + external bank accounts + transfers (when keyed)
 * Chain poll: TronGrid / Blockstream confirm deposits even before Worker webhooks
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { cryptomusSign, cryptomusVerifyWebhook } = require('./wallet-md5.js');

const CRYPTOMUS_BASE = 'https://api.cryptomus.com/v1';
const BRIDGE_BASE = 'https://api.bridge.xyz/v0';
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function loadCredentials(userDataPath, projectRoot) {
  const candidates = [
    path.join(userDataPath || '', 'wallet-credentials.json'),
    path.join(projectRoot || '', 'wallet-credentials.json'),
    path.join(projectRoot || '', 'config.json'),
  ];
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const merchant = String(j.cryptomusMerchantId || j.CRYPTOMUS_MERCHANT_ID || '').trim();
      const paymentKey = String(j.cryptomusPaymentKey || j.CRYPTOMUS_PAYMENT_KEY || '').trim();
      const payoutKey = String(j.cryptomusPayoutKey || j.CRYPTOMUS_PAYOUT_KEY || paymentKey).trim();
      const bridgeKey = String(j.bridgeApiKey || j.WALLET_BRIDGE_API_KEY || '').trim();
      if (merchant || paymentKey || bridgeKey) {
        return {
          path: p,
          cryptomusMerchantId: merchant,
          cryptomusPaymentKey: paymentKey,
          cryptomusPayoutKey: payoutKey,
          bridgeApiKey: bridgeKey,
          webhookBase: String(j.walletWebhookBase || j.WALLET_WEBHOOK_BASE || 'https://utkingdom.com/api/wallet/webhook').replace(/\/$/, ''),
        };
      }
    } catch (_) {}
  }
  return null;
}

function saveCredentials(userDataPath, data) {
  const p = path.join(userDataPath, 'wallet-credentials.json');
  const prev = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  const next = Object.assign({}, prev, {
    cryptomusMerchantId: data.cryptomusMerchantId != null ? String(data.cryptomusMerchantId).trim() : prev.cryptomusMerchantId,
    cryptomusPaymentKey: data.cryptomusPaymentKey != null ? String(data.cryptomusPaymentKey).trim() : prev.cryptomusPaymentKey,
    cryptomusPayoutKey: data.cryptomusPayoutKey != null ? String(data.cryptomusPayoutKey).trim() : prev.cryptomusPayoutKey,
    bridgeApiKey: data.bridgeApiKey != null ? String(data.bridgeApiKey).trim() : prev.bridgeApiKey,
    walletWebhookBase: data.walletWebhookBase != null ? String(data.walletWebhookBase).trim() : prev.walletWebhookBase,
    updatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return { ok: true, path: p };
}

function liveStatus(creds) {
  const c = creds || {};
  const cryptoOk = !!(c.cryptomusMerchantId && c.cryptomusPaymentKey);
  const bridgeOk = !!c.bridgeApiKey;
  return {
    ok: true,
    live: cryptoOk || bridgeOk,
    cryptomus: cryptoOk,
    bridge: bridgeOk,
    mode: cryptoOk ? (bridgeOk ? 'cryptomus+bridge' : 'cryptomus') : (bridgeOk ? 'bridge' : 'sandbox'),
    label: cryptoOk
      ? (bridgeOk ? 'Live: Cryptomus deposits + Bridge bank' : 'Live: Cryptomus deposits (bank needs Bridge key)')
      : (bridgeOk ? 'Bridge keyed (add Cryptomus for deposits)' : 'Sandbox — add API keys for real money'),
  };
}

async function cryptomusRequest(creds, apiPath, body, keyKind) {
  const key = keyKind === 'payout' ? creds.cryptomusPayoutKey : creds.cryptomusPaymentKey;
  if (!creds.cryptomusMerchantId || !key) {
    return { ok: false, error: 'cryptomus_not_configured' };
  }
  const payload = body || {};
  const sign = cryptomusSign(payload, key);
  const resp = await fetch(CRYPTOMUS_BASE + apiPath, {
    method: 'POST',
    headers: {
      merchant: creds.cryptomusMerchantId,
      sign,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || (json && json.state && Number(json.state) !== 0)) {
    return {
      ok: false,
      error: 'cryptomus_api_error',
      detail: (json && (json.message || json.errors)) || ('HTTP ' + resp.status),
      raw: json,
    };
  }
  return { ok: true, result: json.result || json };
}

async function createStaticWallet(creds, { uid, asset, network, callbackUrl }) {
  const currency = String(asset || 'USDT').toUpperCase();
  const net = String(network || 'TRC20').toUpperCase() === 'BTC' ? 'btc' : 'tron';
  const orderId = ('utk_' + String(uid).slice(0, 24) + '_' + currency + '_' + net).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  const body = {
    currency,
    network: net,
    order_id: orderId,
  };
  if (callbackUrl) body.url_callback = callbackUrl;
  const res = await cryptomusRequest(creds, '/wallet', body, 'payment');
  if (!res.ok) return res;
  const r = res.result || {};
  return {
    ok: true,
    asset: currency,
    network: String(network || (net === 'btc' ? 'BTC' : 'TRC20')),
    address: String(r.address || ''),
    uuid: r.uuid || null,
    walletUuid: r.wallet_uuid || null,
    orderId,
    payUrl: r.url || null,
    partner: 'cryptomus',
  };
}

async function createPayout(creds, { amount, asset, network, address, orderId, callbackUrl }) {
  const body = {
    amount: String(amount),
    currency: String(asset || 'USDT').toUpperCase(),
    network: String(network || 'TRC20').toUpperCase() === 'BTC' ? 'btc' : 'TRON',
    order_id: String(orderId).slice(0, 100),
    address: String(address),
    is_subtract: true,
  };
  if (callbackUrl) body.url_callback = callbackUrl;
  return cryptomusRequest(creds, '/payout', body, 'payout');
}

async function bridgeRequest(creds, method, apiPath, body, idemKey) {
  if (!creds.bridgeApiKey) return { ok: false, error: 'bridge_not_configured' };
  const headers = {
    'Api-Key': creds.bridgeApiKey,
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (idemKey) headers['Idempotency-Key'] = String(idemKey);
  const resp = await fetch(BRIDGE_BASE + apiPath, {
    method: method || 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return {
      ok: false,
      error: 'bridge_api_error',
      detail: (json && (json.message || json.code)) || ('HTTP ' + resp.status),
      raw: json,
      httpStatus: resp.status,
    };
  }
  return { ok: true, result: json };
}

async function bridgeCreateKycLink(creds, { email, fullName, country }) {
  const endorsements = [];
  const c = String(country || '').toUpperCase();
  if (['AT','BE','BG','CH','CZ','DE','DK','EE','ES','FI','FR','GB','GR','HR','HU','IE','IT','LT','LU','LV','NL','NO','PL','PT','RO','SE','SI','SK'].includes(c)) {
    endorsements.push('sepa');
  }
  const body = {
    full_name: String(fullName || email || 'Utopia User').slice(0, 80),
    email: String(email || '').trim(),
    type: 'individual',
  };
  if (endorsements.length) body.endorsements = endorsements;
  const idem = 'kyc_' + Buffer.from(String(email)).toString('hex').slice(0, 24) + '_' + Date.now().toString(36);
  const res = await bridgeRequest(creds, 'POST', '/kyc_links', body, idem);
  if (!res.ok) return res;
  const r = res.result || {};
  return {
    ok: true,
    customerId: r.customer_id || null,
    kycUrl: r.kyc_link || r.url || null,
    tosUrl: r.tos_link || null,
    kycStatus: r.kyc_status || r.status || 'pending',
  };
}

async function bridgeCreateExternalAccount(creds, { customerId, iban, accountName, country }) {
  const body = {
    currency: 'eur',
    account_type: 'iban',
    account: {
      account_number: String(iban || '').replace(/\s+/g, ''),
      bic: undefined,
      country: String(country || 'DE').toUpperCase(),
    },
    account_owner_name: String(accountName || 'Account Holder').slice(0, 80),
  };
  // Bridge IBAN shape varies; use documented IBAN fields
  const ibanBody = {
    currency: 'eur',
    bank_name: 'SEPA',
    account_owner_name: String(accountName || 'Account Holder').slice(0, 80),
    account: {
      account_number: String(iban || '').replace(/\s+/g, ''),
      bic: 'NWBKGB2L',
      country: String(country || 'DE').toUpperCase(),
    },
  };
  const idem = 'ea_' + String(customerId).slice(0, 12) + '_' + String(iban).slice(-8);
  const res = await bridgeRequest(creds, 'POST', `/customers/${encodeURIComponent(customerId)}/external_accounts`, ibanBody, idem);
  if (!res.ok) {
    // Retry minimal IBAN payload
    const res2 = await bridgeRequest(creds, 'POST', `/customers/${encodeURIComponent(customerId)}/external_accounts`, {
      currency: 'eur',
      account_type: 'iban',
      iban: String(iban || '').replace(/\s+/g, ''),
      account_owner_name: String(accountName || 'Account Holder').slice(0, 80),
    }, idem + '_b');
    if (!res2.ok) return res;
    return { ok: true, externalAccountId: (res2.result && (res2.result.id || res2.result.external_account_id)) || null, raw: res2.result };
  }
  return { ok: true, externalAccountId: (res.result && (res.result.id || res.result.external_account_id)) || null, raw: res.result };
}

async function bridgeCreateTransfer(creds, { onBehalfOf, amount, externalAccountId, idem }) {
  const body = {
    amount: String(Number(amount).toFixed(2)),
    on_behalf_of: onBehalfOf,
    source: { currency: 'usd', payment_rail: 'bridge_wallet', bridge_wallet_id: undefined },
    destination: {
      currency: 'eur',
      payment_rail: 'sepa',
      external_account_id: externalAccountId,
    },
  };
  // Prefer documented transfer shape; if bridge_wallet_id required, ops must set WALLET_BRIDGE_WALLET_ID in creds
  if (creds.bridgeWalletId) {
    body.source.bridge_wallet_id = creds.bridgeWalletId;
  }
  return bridgeRequest(creds, 'POST', '/transfers', body, idem || ('tr_' + Date.now()));
}

async function fetchTrc20Incoming(address, limit) {
  const url = `https://api.trongrid.io/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?only_to=true&limit=${limit || 25}&contract_address=${USDT_TRC20}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) return [];
  const json = await resp.json().catch(() => ({}));
  const rows = Array.isArray(json.data) ? json.data : [];
  return rows.map((t) => {
    const raw = String(t.value || '0');
    const decimals = Number(t.token_info && t.token_info.decimals != null ? t.token_info.decimals : 6);
    const amount = Number(raw) / Math.pow(10, decimals);
    return {
      chainTxId: String(t.transaction_id || t.txID || ''),
      asset: 'USDT',
      network: 'TRC20',
      amount,
      from: t.from || '',
      timestamp: t.block_timestamp || Date.now(),
    };
  }).filter((x) => x.chainTxId && x.amount > 0);
}

async function fetchBtcIncoming(address, limit) {
  const url = `https://blockstream.info/api/address/${encodeURIComponent(address)}/txs`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) return [];
  const rows = await resp.json().catch(() => []);
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const tx of rows.slice(0, limit || 20)) {
    let amountSats = 0;
    for (const vout of tx.vout || []) {
      if (vout && vout.scriptpubkey_address === address) amountSats += Number(vout.value || 0);
    }
    if (amountSats <= 0) continue;
    out.push({
      chainTxId: String(tx.txid || ''),
      asset: 'BTC',
      network: 'BTC',
      amount: amountSats / 1e8,
      timestamp: (tx.status && tx.status.block_time ? tx.status.block_time * 1000 : Date.now()),
      confirmed: !!(tx.status && tx.status.confirmed),
    });
  }
  return out;
}

async function pollAddressDeposits(addrRow) {
  if (!addrRow || !addrRow.address) return [];
  if (addrRow.asset === 'USDT' || addrRow.network === 'TRC20') {
    return fetchTrc20Incoming(addrRow.address);
  }
  if (addrRow.asset === 'BTC' || addrRow.network === 'BTC') {
    return fetchBtcIncoming(addrRow.address);
  }
  return [];
}

module.exports = {
  loadCredentials,
  saveCredentials,
  liveStatus,
  cryptomusSign,
  cryptomusVerifyWebhook,
  createStaticWallet,
  createPayout,
  bridgeCreateKycLink,
  bridgeCreateExternalAccount,
  bridgeCreateTransfer,
  pollAddressDeposits,
  fetchTrc20Incoming,
  fetchBtcIncoming,
};
