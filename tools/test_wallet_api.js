#!/usr/bin/env node
/**
 * tools/test_wallet_api.js — unit-ish checks for wallet-cf helpers via local import simulation.
 * Does not call production; validates config matrix + signature helpers used by the Worker.
 */
'use strict';

const assert = require('assert');
const cfg = require('../wallet-config.js');

assert.ok(Array.isArray(cfg.WALLET_ASSETS) && cfg.WALLET_ASSETS.length >= 2, 'assets');
assert.ok(cfg.WALLET_ASSETS.some((a) => a.asset === 'USDT' && a.network === 'TRC20'));
assert.ok(cfg.WALLET_ASSETS.some((a) => a.asset === 'BTC'));
assert.ok(Array.isArray(cfg.WALLET_COUNTRIES) && cfg.WALLET_COUNTRIES.includes('DE'));
assert.ok(cfg.WALLET_LIMITS.minWithdrawUsd >= 1);
assert.ok(cfg.WALLET_PARTNER && cfg.WALLET_PARTNER.id);

const guards = require('../ipc-url-guards.js');
assert.strictEqual(guards.isAllowedExternalUrl('https://bridge.xyz/kyc'), true);
assert.strictEqual(guards.isAllowedExternalUrl('https://api.blindpay.com/x'), true);
assert.strictEqual(guards.isAllowedPaymentUrl('https://checkout.bridge.xyz/x'), true);
assert.strictEqual(guards.isAllowedExternalUrl('https://evil.example/x'), false);

assert.strictEqual(guards.isAllowedExternalUrl('https://pay.cryptomus.com/wallet/x'), true);
assert.strictEqual(guards.isAllowedExternalUrl('https://cryptomus.com/'), true);

console.log('test_wallet_api: ok');
