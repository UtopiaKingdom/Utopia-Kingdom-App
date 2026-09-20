/**
 * wallet-cf.js — Custodial UtK wallet API on Cloudflare Worker.
 * Mounted at /api/wallet/*
 *
 * Ledger of record: R2 (DOWNLOADS) under wallet/{uid}.json + wallet/idem/{key}
 * Partner: sandbox by default; Bridge/BlindPay-class when WALLET_PARTNER_ID + keys set.
 */
const FIREBASE_WEB_API_KEY = 'AIzaSyCQdYOL6Tng3GgpRtFEUE7uy3aypmh7cMU';

const ASSETS = [
  { asset: 'USDT', network: 'TRC20', label: 'USDT (TRC20)', decimals: 6, confirmations: 20 },
  { asset: 'BTC', network: 'BTC', label: 'Bitcoin', decimals: 8, confirmations: 2 },
];

const COUNTRIES = [
  'AT', 'BE', 'BG', 'BR', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GB', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MX', 'NL', 'NO',
  'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'NG', 'ZA',
];

const DEFAULT_LIMITS = {
  dailyWithdrawUsd: 2000,
  perTxWithdrawUsd: 1000,
  minWithdrawUsd: 20,
  minDepositUsdt: 10,
  minDepositBtc: 0.0002,
  feeWithdrawUsd: 2.5,
  feeWithdrawPct: 0.01,
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wallet-Admin-Key, X-Wallet-Signature',
  'Cache-Control': 'no-store',
};

const tokenCache = new Map();

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function authFromRequest(request) {
  const header = request.headers.get('Authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return '';
}

async function verifyToken(raw) {
  const tok = String(raw || '').trim();
  if (!tok) return null;
  const cached = tokenCache.get(tok);
  if (cached && cached.exp > Date.now()) return cached.user;
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_WEB_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: tok }),
    }
  );
  const data = await res.json().catch(() => ({}));
  const row = data && data.users && data.users[0];
  const uid = row && row.localId ? String(row.localId) : '';
  if (!uid) return null;
  const user = { uid, email: String(row.email || '') };
  if (tokenCache.size > 400) tokenCache.clear();
  tokenCache.set(tok, { exp: Date.now() + 280000, user });
  return user;
}

function walletEnabled(env) {
  const v = String(env.WALLET_ENABLED || '1').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off';
}

function partnerId(env) {
  return String(env.WALLET_PARTNER_ID || 'sandbox').trim().toLowerCase() || 'sandbox';
}

function partnerMode(env) {
  const id = partnerId(env);
  if (String(env.CRYPTOMUS_MERCHANT_ID || env.WALLET_CRYPTOMUS_MERCHANT_ID || '').trim() &&
      String(env.CRYPTOMUS_PAYMENT_KEY || env.WALLET_CRYPTOMUS_PAYMENT_KEY || '').trim()) {
    return 'cryptomus';
  }
  if (id === 'bridge' && String(env.WALLET_BRIDGE_API_KEY || '').trim()) return 'bridge';
  if (id === 'blindpay' && String(env.WALLET_BLINDPAY_API_KEY || '').trim()) return 'blindpay';
  if (id === 'cryptomus') return 'cryptomus';
  return 'sandbox';
}

function limitsFor(wallet) {
  return Object.assign({}, DEFAULT_LIMITS, (wallet && wallet.limits) || {});
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
    kycUrl: null,
    balances: {
      USDT: { available: 0, pending: 0 },
      BTC: { available: 0, pending: 0 },
      USD: { available: 0, pending: 0 },
    },
    depositAddresses: {},
    limits: Object.assign({}, DEFAULT_LIMITS),
    dailyWithdrawUsd: 0,
    dailyWithdrawDay: '',
    partnerCustomerId: null,
    txs: [],
    updatedAt: nowIso(),
    createdAt: nowIso(),
  };
}

function walletKey(uid) {
  return 'wallet/users/' + String(uid) + '.json';
}

function idemKey(key) {
  return 'wallet/idem/' + String(key).replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 180);
}

async function loadWallet(env, uid) {
  const obj = await env.DOWNLOADS.get(walletKey(uid));
  if (!obj) return null;
  try {
    return await obj.json();
  } catch (_) {
    return null;
  }
}

async function saveWallet(env, wallet) {
  wallet.updatedAt = nowIso();
  await env.DOWNLOADS.put(walletKey(wallet.uid), JSON.stringify(wallet), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

async function ensureWallet(env, user) {
  let w = await loadWallet(env, user.uid);
  if (!w) {
    w = emptyWallet(user.uid, user.email);
    await saveWallet(env, w);
  } else if (user.email && w.email !== user.email) {
    w.email = user.email;
  }
  return w;
}

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(message || '')));
  return bytesToHex(new Uint8Array(sig));
}

function sandboxAddress(asset, network, digestHex) {
  const h = String(digestHex || '').toLowerCase();
  if (asset === 'BTC') {
    return 'bc1q' + h.slice(0, 38);
  }
  if (network === 'TRC20') {
    return 'T' + h.slice(0, 33).toUpperCase();
  }
  return '0x' + h.slice(0, 40);
}

async function ensureAddresses(env, wallet) {
  const secret = String(env.WALLET_ADDRESS_SECRET || env.WALLET_WEBHOOK_SECRET || 'utk-wallet-dev').trim();
  const out = Object.assign({}, wallet.depositAddresses || {});
  for (const row of ASSETS) {
    const key = row.asset + ':' + row.network;
    if (out[key] && out[key].address) continue;
    const digest = await hmacHex(secret, wallet.uid + '|' + key);
    out[key] = {
      asset: row.asset,
      network: row.network,
      label: row.label,
      address: sandboxAddress(row.asset, row.network, digest),
      memo: null,
      confirmationsRequired: row.confirmations,
      partner: partnerMode(env),
      createdAt: nowIso(),
    };
  }
  wallet.depositAddresses = out;
  return out;
}

function publicWallet(wallet, env) {
  const bals = wallet.balances || {};
  const usdt = (bals.USDT && bals.USDT.available) || 0;
  const btc = (bals.BTC && bals.BTC.available) || 0;
  const usd = (bals.USD && bals.USD.available) || 0;
  const txs = Array.isArray(wallet.txs) ? wallet.txs.slice(0, 40) : [];
  return {
    ok: true,
    enabled: walletEnabled(env) && wallet.enabled !== false,
    frozen: !!wallet.frozen,
    status: wallet.status || 'active',
    kycStatus: wallet.kycStatus || 'none',
    kycCountry: wallet.kycCountry || '',
    kycUrl: wallet.kycUrl || null,
    partner: partnerMode(env),
    partnerName: partnerMode(env) === 'sandbox'
      ? 'UtK Sandbox Rails'
      : (partnerMode(env) === 'cryptomus' ? 'Cryptomus (live)' : String(partnerId(env))),
    balances: {
      USDT: {
        available: Number(bals.USDT && bals.USDT.available || 0),
        pending: Number(bals.USDT && bals.USDT.pending || 0),
      },
      BTC: {
        available: Number(bals.BTC && bals.BTC.available || 0),
        pending: Number(bals.BTC && bals.BTC.pending || 0),
      },
      USD: {
        available: Number(bals.USD && bals.USD.available || 0),
        pending: Number(bals.USD && bals.USD.pending || 0),
      },
    },
    displayUsd: Number(usd) + Number(usdt) + Number(btc) * 0, // BTC priced client-side if needed
    depositAddresses: wallet.depositAddresses || {},
    assets: ASSETS,
    countries: COUNTRIES,
    limits: limitsFor(wallet),
    dailyWithdrawUsd: Number(wallet.dailyWithdrawUsd || 0),
    txs,
    updatedAt: wallet.updatedAt,
  };
}

function pushTx(wallet, tx) {
  if (!Array.isArray(wallet.txs)) wallet.txs = [];
  wallet.txs.unshift(tx);
  if (wallet.txs.length > 200) wallet.txs.length = 200;
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyIfNeeded(wallet) {
  const d = dayKey();
  if (wallet.dailyWithdrawDay !== d) {
    wallet.dailyWithdrawDay = d;
    wallet.dailyWithdrawUsd = 0;
  }
}

function estimateWithdrawFee(amountUsd, limits) {
  const pct = Number(limits.feeWithdrawPct || 0) * Number(amountUsd);
  const flat = Number(limits.feeWithdrawUsd || 0);
  return Math.round((pct + flat) * 100) / 100;
}

async function readIdem(env, key) {
  const obj = await env.DOWNLOADS.get(idemKey(key));
  if (!obj) return null;
  try {
    return await obj.json();
  } catch (_) {
    return { seen: true };
  }
}

async function writeIdem(env, key, payload) {
  await env.DOWNLOADS.put(idemKey(key), JSON.stringify(payload || { seen: true, at: nowIso() }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
}

function adminOk(request, env) {
  const expected = String(env.WALLET_ADMIN_SECRET || '').trim();
  if (!expected) return false;
  const got = String(request.headers.get('X-Wallet-Admin-Key') || '').trim();
  return got && got === expected;
}

async function verifyWebhookSig(request, env, rawBody) {
  const secret = String(env.WALLET_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    // Sandbox without secret: allow only when partner is sandbox
    return partnerMode(env) === 'sandbox';
  }
  const header = String(request.headers.get('X-Wallet-Signature') || '').trim().toLowerCase();
  if (!header) return false;
  const digest = await hmacHex(secret, rawBody);
  return digest === header;
}

async function creditDeposit(env, wallet, evt) {
  const chainTxId = String(evt.chainTxId || evt.txid || '').trim();
  if (!chainTxId) return { ok: false, error: 'missing_chain_tx' };
  const idem = 'deposit:' + chainTxId;
  const prior = await readIdem(env, idem);
  if (prior) return { ok: true, duplicate: true };

  const asset = String(evt.asset || 'USDT').toUpperCase();
  const amount = Number(evt.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'bad_amount' };
  if (!wallet.balances[asset]) wallet.balances[asset] = { available: 0, pending: 0 };

  const confirming = !!evt.confirming;
  if (confirming) {
    wallet.balances[asset].pending = Number(wallet.balances[asset].pending || 0) + amount;
  } else {
    // Move from pending if present, else credit available
    const pend = Number(wallet.balances[asset].pending || 0);
    if (pend >= amount) wallet.balances[asset].pending = Math.round((pend - amount) * 1e8) / 1e8;
    wallet.balances[asset].available = Number(wallet.balances[asset].available || 0) + amount;
  }

  const txId = 'dep_' + chainTxId.slice(0, 24);
  pushTx(wallet, {
    id: txId,
    type: 'deposit',
    asset,
    network: String(evt.network || ''),
    amount,
    status: confirming ? 'confirming' : 'available',
    chainTxId,
    partnerRef: evt.partnerRef || null,
    createdAt: nowIso(),
  });

  await writeIdem(env, idem, { uid: wallet.uid, txId, at: nowIso() });
  await saveWallet(env, wallet);
  return { ok: true, txId };
}

async function applyPayoutUpdate(env, wallet, evt) {
  const partnerRef = String(evt.partnerRef || evt.payoutId || '').trim();
  const txId = String(evt.txId || '').trim();
  if (!partnerRef && !txId) return { ok: false, error: 'missing_ref' };

  const tx = (wallet.txs || []).find((t) =>
    (txId && t.id === txId) || (partnerRef && t.partnerRef === partnerRef)
  );
  if (!tx) return { ok: false, error: 'tx_not_found' };

  const status = String(evt.status || '').toLowerCase();
  if (status === 'settled' || status === 'complete' || status === 'completed') {
    tx.status = 'settled';
    tx.settledAt = nowIso();
  } else if (status === 'failed' || status === 'rejected') {
    tx.status = 'failed';
    tx.failedAt = nowIso();
    tx.failReason = String(evt.reason || 'payout_failed');
    // Refund available USD
    const amt = Number(tx.amount || 0);
    const fee = Number(tx.fee || 0);
    wallet.balances.USD.available = Number(wallet.balances.USD.available || 0) + amt + fee;
    if (wallet.balances.USD.pending >= amt + fee) {
      wallet.balances.USD.pending = Number(wallet.balances.USD.pending || 0) - (amt + fee);
    }
  } else {
    tx.status = 'payout_pending';
  }

  await saveWallet(env, wallet);
  return { ok: true, txId: tx.id, status: tx.status };
}

async function handleStatus(env, user) {
  const wallet = await ensureWallet(env, user);
  await ensureAddresses(env, wallet);
  await saveWallet(env, wallet);
  return publicWallet(wallet, env);
}

async function handleEnsureAddresses(env, user) {
  const wallet = await ensureWallet(env, user);
  if (wallet.frozen) return { ok: false, statusCode: 403, error: 'wallet_frozen' };
  const addresses = await ensureAddresses(env, wallet);
  await saveWallet(env, wallet);
  return { ok: true, depositAddresses: addresses, partner: partnerMode(env) };
}

async function handleKycStart(env, user, body) {
  const wallet = await ensureWallet(env, user);
  if (wallet.frozen) return { ok: false, statusCode: 403, error: 'wallet_frozen' };
  const country = String(body.country || '').trim().toUpperCase();
  if (!country || COUNTRIES.indexOf(country) < 0) {
    return { ok: false, statusCode: 400, error: 'country_unsupported', countries: COUNTRIES };
  }
  wallet.kycCountry = country;
  const mode = partnerMode(env);
  if (mode === 'sandbox') {
    wallet.kycStatus = 'verified';
    wallet.kycUrl = null;
    wallet.kycVerifiedAt = nowIso();
  } else {
    wallet.kycStatus = 'pending';
    const base = String(env.WALLET_KYC_BASE_URL || 'https://utkingdom.com/wallet/kyc').replace(/\/$/, '');
    wallet.kycUrl = base + '?uid=' + encodeURIComponent(user.uid) + '&country=' + encodeURIComponent(country);
  }
  await saveWallet(env, wallet);
  return {
    ok: true,
    kycStatus: wallet.kycStatus,
    kycUrl: wallet.kycUrl,
    kycCountry: wallet.kycCountry,
  };
}

async function handleWithdrawBank(env, user, body) {
  const wallet = await ensureWallet(env, user);
  if (!walletEnabled(env) || wallet.enabled === false) {
    return { ok: false, statusCode: 403, error: 'wallet_disabled' };
  }
  if (wallet.frozen) return { ok: false, statusCode: 403, error: 'wallet_frozen' };
  if (wallet.kycStatus !== 'verified') {
    return { ok: false, statusCode: 403, error: 'kyc_required', kycStatus: wallet.kycStatus };
  }
  const country = String(body.country || wallet.kycCountry || '').toUpperCase();
  if (!country || COUNTRIES.indexOf(country) < 0) {
    return { ok: false, statusCode: 400, error: 'country_unsupported' };
  }

  const amount = Number(body.amount);
  const limits = limitsFor(wallet);
  if (!Number.isFinite(amount) || amount < Number(limits.minWithdrawUsd)) {
    return { ok: false, statusCode: 400, error: 'below_minimum', min: limits.minWithdrawUsd };
  }
  if (amount > Number(limits.perTxWithdrawUsd)) {
    return { ok: false, statusCode: 400, error: 'above_per_tx', max: limits.perTxWithdrawUsd };
  }

  resetDailyIfNeeded(wallet);
  const fee = estimateWithdrawFee(amount, limits);
  const total = amount + fee;
  if (Number(wallet.dailyWithdrawUsd || 0) + amount > Number(limits.dailyWithdrawUsd)) {
    return { ok: false, statusCode: 400, error: 'daily_limit', remaining: Math.max(0, limits.dailyWithdrawUsd - wallet.dailyWithdrawUsd) };
  }

  // Prefer USD balance; allow auto-convert from USDT 1:1 for v1 sandbox
  let usdAvail = Number(wallet.balances.USD.available || 0);
  const usdtAvail = Number(wallet.balances.USDT.available || 0);
  if (usdAvail < total && usdtAvail > 0) {
    const need = total - usdAvail;
    const take = Math.min(need, usdtAvail);
    wallet.balances.USDT.available = usdtAvail - take;
    wallet.balances.USD.available = usdAvail + take;
    usdAvail = Number(wallet.balances.USD.available || 0);
  }
  if (usdAvail < total) {
    return { ok: false, statusCode: 400, error: 'insufficient_balance', need: total, available: usdAvail };
  }

  wallet.balances.USD.available = usdAvail - total;
  wallet.balances.USD.pending = Number(wallet.balances.USD.pending || 0) + total;
  wallet.dailyWithdrawUsd = Number(wallet.dailyWithdrawUsd || 0) + amount;

  const txId = 'wd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const partnerRef = 'po_' + txId;
  const iban = String(body.iban || body.accountNumber || '').trim().slice(0, 64);
  const accountName = String(body.accountName || '').trim().slice(0, 80);

  pushTx(wallet, {
    id: txId,
    type: 'withdraw_bank',
    asset: 'USD',
    amount,
    fee,
    status: 'payout_pending',
    partnerRef,
    country,
    ibanLast4: iban ? iban.slice(-4) : null,
    accountName: accountName || null,
    createdAt: nowIso(),
  });

  await saveWallet(env, wallet);

  // Sandbox auto-settle for demo unless body.hold === true
  if (partnerMode(env) === 'sandbox' && body.hold !== true) {
    wallet.balances.USD.pending = Math.max(0, Number(wallet.balances.USD.pending || 0) - total);
    const tx = wallet.txs.find((t) => t.id === txId);
    if (tx) {
      tx.status = 'settled';
      tx.settledAt = nowIso();
    }
    await saveWallet(env, wallet);
  }

  return {
    ok: true,
    txId,
    partnerRef,
    amount,
    fee,
    status: partnerMode(env) === 'sandbox' && body.hold !== true ? 'settled' : 'payout_pending',
    eta: partnerMode(env) === 'sandbox' ? 'instant (sandbox)' : '1–3 business days',
  };
}

async function handleSendPo(env, user, body) {
  const wallet = await ensureWallet(env, user);
  if (!walletEnabled(env) || wallet.enabled === false) {
    return { ok: false, statusCode: 403, error: 'wallet_disabled' };
  }
  if (wallet.frozen) return { ok: false, statusCode: 403, error: 'wallet_frozen' };
  if (wallet.kycStatus !== 'verified') {
    return { ok: false, statusCode: 403, error: 'kyc_required' };
  }

  const asset = String(body.asset || 'USDT').toUpperCase();
  const network = String(body.network || (asset === 'BTC' ? 'BTC' : 'TRC20')).toUpperCase();
  const address = String(body.address || '').trim();
  const amount = Number(body.amount);
  if (!address || address.length < 10) return { ok: false, statusCode: 400, error: 'bad_address' };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, statusCode: 400, error: 'bad_amount' };
  if (!wallet.balances[asset]) return { ok: false, statusCode: 400, error: 'unsupported_asset' };

  const avail = Number(wallet.balances[asset].available || 0);
  if (avail < amount) return { ok: false, statusCode: 400, error: 'insufficient_balance', available: avail };

  wallet.balances[asset].available = avail - amount;
  const txId = 'po_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const chainTxId = partnerMode(env) === 'sandbox'
    ? ('sandbox_' + txId)
    : null;

  pushTx(wallet, {
    id: txId,
    type: 'send_po',
    asset,
    network,
    amount,
    address,
    status: partnerMode(env) === 'sandbox' ? 'settled' : 'pending',
    chainTxId,
    createdAt: nowIso(),
  });
  await saveWallet(env, wallet);

  return {
    ok: true,
    txId,
    chainTxId,
    status: partnerMode(env) === 'sandbox' ? 'settled' : 'pending',
    note: 'Sent to your Pocket Option deposit address. Confirm on PO once credited.',
  };
}

async function handleCryptomusWebhook(env, request) {
  const rawBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_) {
    return { ok: false, statusCode: 400, error: 'invalid_json' };
  }
  const apiKey = String(env.CRYPTOMUS_PAYMENT_KEY || env.WALLET_CRYPTOMUS_PAYMENT_KEY || '').trim();
  if (apiKey) {
    const got = String(payload.sign || '');
    const clone = Object.assign({}, payload);
    delete clone.sign;
    // Cryptomus: md5(base64(json)+key) — use SubtleDigest isn't md5; skip strict verify if no md5,
    // rely on shared secret compare of merchant + known order_id prefix when key unset in edge.
    // Soft verify: require sign present when key configured (full md5 ported below).
    const expect = await cryptomusMd5Sign(clone, apiKey);
    if (got !== expect) return { ok: false, statusCode: 401, error: 'invalid_cryptomus_sign' };
  }

  const orderId = String(payload.order_id || '');
  // order_id format: utk_{uid}_{ASSET}_{net}
  let uid = '';
  if (orderId.startsWith('utk_')) {
    const parts = orderId.split('_');
    // utk + uid pieces + asset + net — uid may contain underscores truncated; we used uid.slice(0,24)
    if (parts.length >= 4) {
      uid = parts.slice(1, parts.length - 2).join('_');
    }
  }
  if (!uid) uid = String(payload.uid || '').trim();
  if (!uid) return { ok: false, statusCode: 400, error: 'missing_uid_in_order' };

  const status = String(payload.status || '').toLowerCase();
  if (!(status === 'paid' || status === 'paid_over' || status === 'wrong_amount')) {
    return { ok: true, ignored: true, status };
  }

  let wallet = await loadWallet(env, uid);
  if (!wallet) wallet = emptyWallet(uid, '');

  const amount = Number(payload.payment_amount || payload.merchant_amount || payload.amount || 0);
  const asset = String(payload.payer_currency || payload.currency || 'USDT').toUpperCase();
  const chainTxId = String(payload.txid || payload.uuid || ('cm_' + orderId + '_' + amount));
  const confirming = status === 'confirm_check' || status === 'process' || status === 'check';

  const r = await creditDeposit(env, wallet, {
    asset: asset === 'USDT' || asset === 'BTC' ? asset : 'USDT',
    amount,
    chainTxId,
    network: String(payload.network || ''),
    partnerRef: payload.uuid || null,
    confirming: false,
  });
  return Object.assign({ partner: 'cryptomus', status }, r);
}

/** Minimal MD5 for Cryptomus (Worker-safe, no Buffer). */
async function cryptomusMd5Sign(bodyObj, apiKey) {
  const json = JSON.stringify(bodyObj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return md5Hex(b64 + String(apiKey || ''));
}

function md5Hex(s) {
  // Compact MD5 — same algorithm as wallet-md5.js
  function add32(a, b) { return (a + b) & 0xffffffff; }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function md5cycle(x, k) {
    let [a, b, c, d] = x;
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function md5blk(str) {
    const md5blks = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = str.charCodeAt(i) + (str.charCodeAt(i + 1) << 8) + (str.charCodeAt(i + 2) << 16) + (str.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }
  const n = s.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
  s = s.substring(i - 64);
  const tail = new Array(16).fill(0);
  for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
  tail[14] = n * 8;
  md5cycle(state, tail);
  const hex = '0123456789abcdef';
  let out = '';
  for (let j = 0; j < 4; j++) {
    const n2 = state[j];
    for (let k = 0; k < 4; k++) out += hex.charAt((n2 >> (k * 8 + 4)) & 0x0f) + hex.charAt((n2 >> (k * 8)) & 0x0f);
  }
  return out;
}

async function handleWebhook(env, request, partner) {
  if (String(partner || '').toLowerCase() === 'cryptomus') {
    return handleCryptomusWebhook(env, request);
  }

  const rawBody = await request.text();
  const okSig = await verifyWebhookSig(request, env, rawBody);
  if (!okSig) return { ok: false, statusCode: 401, error: 'invalid_signature' };

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_) {
    return { ok: false, statusCode: 400, error: 'invalid_json' };
  }

  const uid = String(payload.uid || payload.userId || '').trim();
  if (!uid) return { ok: false, statusCode: 400, error: 'missing_uid' };

  let wallet = await loadWallet(env, uid);
  if (!wallet) {
    wallet = emptyWallet(uid, payload.email || '');
  }

  const event = String(payload.event || payload.type || '').toLowerCase();
  if (event === 'deposit.confirming' || event === 'deposit.pending') {
    const r = await creditDeposit(env, wallet, Object.assign({}, payload, { confirming: true }));
    return Object.assign({ event }, r);
  }
  if (event === 'deposit.confirmed' || event === 'deposit.credited' || event === 'deposit') {
    const r = await creditDeposit(env, wallet, Object.assign({}, payload, { confirming: false }));
    return Object.assign({ event, partner }, r);
  }
  if (event === 'payout.settled' || event === 'payout.failed' || event === 'payout.updated') {
    const r = await applyPayoutUpdate(env, wallet, Object.assign({}, payload, {
      status: event === 'payout.settled' ? 'settled' : (event === 'payout.failed' ? 'failed' : payload.status),
    }));
    return Object.assign({ event }, r);
  }
  if (event === 'kyc.verified') {
    wallet.kycStatus = 'verified';
    wallet.kycVerifiedAt = nowIso();
    await saveWallet(env, wallet);
    return { ok: true, event, kycStatus: 'verified' };
  }

  return { ok: true, received: true, note: 'unhandled_event', event };
}

async function handleAdminFreeze(env, body) {
  const uid = String(body.uid || '').trim();
  if (!uid) return { ok: false, statusCode: 400, error: 'missing_uid' };
  const wallet = (await loadWallet(env, uid)) || emptyWallet(uid, '');
  wallet.frozen = body.frozen !== false;
  wallet.status = wallet.frozen ? 'frozen' : 'active';
  await saveWallet(env, wallet);
  return { ok: true, uid, frozen: wallet.frozen };
}

async function handleAdminAdjust(env, body) {
  const uid = String(body.uid || '').trim();
  const asset = String(body.asset || 'USD').toUpperCase();
  const amount = Number(body.amount);
  const reason = String(body.reason || 'manual_adjust').slice(0, 120);
  if (!uid) return { ok: false, statusCode: 400, error: 'missing_uid' };
  if (!Number.isFinite(amount) || amount === 0) return { ok: false, statusCode: 400, error: 'bad_amount' };
  const wallet = (await loadWallet(env, uid)) || emptyWallet(uid, '');
  if (!wallet.balances[asset]) wallet.balances[asset] = { available: 0, pending: 0 };
  wallet.balances[asset].available = Number(wallet.balances[asset].available || 0) + amount;
  const txId = 'adj_' + Date.now().toString(36);
  pushTx(wallet, {
    id: txId,
    type: 'adjust',
    asset,
    amount,
    status: 'available',
    reason,
    createdAt: nowIso(),
  });
  await saveWallet(env, wallet);
  return { ok: true, txId, balances: wallet.balances };
}

async function handleReconcile(env, body) {
  const uid = String(body.uid || '').trim();
  if (!uid) return { ok: false, statusCode: 400, error: 'missing_uid' };
  const wallet = await loadWallet(env, uid);
  if (!wallet) return { ok: false, statusCode: 404, error: 'not_found' };
  const bals = wallet.balances || {};
  let credit = 0;
  let debit = 0;
  for (const tx of wallet.txs || []) {
    if (tx.type === 'deposit' && (tx.status === 'available' || tx.status === 'settled')) credit += Number(tx.amount || 0);
    if (tx.type === 'adjust' && Number(tx.amount) > 0) credit += Number(tx.amount || 0);
    if (tx.type === 'adjust' && Number(tx.amount) < 0) debit += Math.abs(Number(tx.amount || 0));
    if (tx.type === 'withdraw_bank' && tx.status !== 'failed') debit += Number(tx.amount || 0) + Number(tx.fee || 0);
    if (tx.type === 'send_po' && tx.status !== 'failed') {
      // tracked in asset units — skip USD rollup
    }
  }
  return {
    ok: true,
    uid,
    balances: bals,
    txCount: (wallet.txs || []).length,
    note: 'Ledger snapshot; partner chain balances must be checked in the BaaS dashboard after KYB.',
    rolledUsdApprox: { credit, debit },
  };
}

export async function handleWallet(request, env, pathname) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const path = String(pathname || '').replace(/\/+$/, '') || '/api/wallet';

  // Public health
  if ((path === '/api/wallet' || path === '/api/wallet/health') && method === 'GET') {
    return json({
      ok: true,
      online: true,
      enabled: walletEnabled(env),
      partner: partnerMode(env),
      assets: ASSETS.map((a) => ({ asset: a.asset, network: a.network })),
      countries: COUNTRIES.length,
    });
  }

  // Webhooks (no user bearer)
  if (path.startsWith('/api/wallet/webhook/') && method === 'POST') {
    const partner = path.split('/').pop() || 'sandbox';
    try {
      const result = await handleWebhook(env, request, partner);
      return json(result, result && result.statusCode ? result.statusCode : 200);
    } catch (e) {
      return json({ ok: false, error: 'webhook_failed', message: e && e.message ? e.message : 'error' }, 502);
    }
  }

  // Admin
  if (path.startsWith('/api/wallet/admin/') && method === 'POST') {
    if (!adminOk(request, env)) return json({ ok: false, error: 'admin_forbidden' }, 403);
    const body = await request.json().catch(() => ({}));
    const action = path.split('/').pop();
    let result;
    if (action === 'freeze') result = await handleAdminFreeze(env, body);
    else if (action === 'adjust') result = await handleAdminAdjust(env, body);
    else if (action === 'reconcile') result = await handleReconcile(env, body);
    else result = { ok: false, statusCode: 404, error: 'unknown_admin_action' };
    return json(result, result && result.statusCode ? result.statusCode : 200);
  }

  if (!walletEnabled(env) && path !== '/api/wallet/health') {
    return json({ ok: false, error: 'wallet_disabled' }, 503);
  }

  const user = await verifyToken(authFromRequest(request));
  if (!user) return json({ ok: false, error: 'auth_required' }, 401);

  try {
    if (path === '/api/wallet/status' && method === 'GET') {
      return json(await handleStatus(env, user));
    }
    if (path === '/api/wallet/addresses/ensure' && method === 'POST') {
      const result = await handleEnsureAddresses(env, user);
      return json(result, result.statusCode || 200);
    }
    if (path === '/api/wallet/kyc/start' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const result = await handleKycStart(env, user, body || {});
      return json(result, result.statusCode || 200);
    }
    if (path === '/api/wallet/withdraw/bank' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const result = await handleWithdrawBank(env, user, body || {});
      return json(result, result.statusCode || 200);
    }
    if (path === '/api/wallet/send-po' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const result = await handleSendPo(env, user, body || {});
      return json(result, result.statusCode || 200);
    }
    return json({ ok: false, error: 'not_found' }, 404);
  } catch (e) {
    return json({
      ok: false,
      error: 'wallet_error',
      message: e && e.message ? e.message : 'Unknown error',
    }, 502);
  }
}
