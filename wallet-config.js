/**
 * wallet-config.js — Shared country/asset matrix + partner defaults for UtK wallet.
 * Used by the desktop UI (and mirrored in wallet-cf.js for the Worker).
 */
'use strict';

const WALLET_ASSETS = [
  {
    asset: 'USDT',
    network: 'TRC20',
    label: 'USDT (TRC20)',
    decimals: 6,
    confirmations: 20,
    poHint: 'On Pocket Option choose USDT / TRC20 withdrawal to this address.',
  },
  {
    asset: 'BTC',
    network: 'BTC',
    label: 'Bitcoin',
    decimals: 8,
    confirmations: 2,
    poHint: 'On Pocket Option choose BTC withdrawal to this address.',
  },
];

/** ISO country codes supported for bank payouts in v1 (partner-gated). */
const WALLET_COUNTRIES = [
  'AT', 'BE', 'BG', 'BR', 'CH', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GB', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MX', 'NL', 'NO',
  'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'NG', 'ZA',
];

const WALLET_LIMITS = {
  dailyWithdrawUsd: 2000,
  perTxWithdrawUsd: 1000,
  minWithdrawUsd: 20,
  minDepositUsdt: 10,
  minDepositBtc: 0.0002,
  feeWithdrawUsd: 2.5,
  feeWithdrawPct: 0.01,
};

const WALLET_PARTNER = {
  id: 'sandbox',
  name: 'UtK Sandbox Rails',
  /** Swap to bridge/blindpay after KYB; Worker reads WALLET_PARTNER_ID. */
  kycHostAllow: [
    /(^|\.)utkingdom\.com$/i,
    /(^|\.)bridge\.xyz$/i,
    /(^|\.)withbridge\.com$/i,
    /(^|\.)blindpay\.com$/i,
  ],
};

module.exports = {
  WALLET_ASSETS,
  WALLET_COUNTRIES,
  WALLET_LIMITS,
  WALLET_PARTNER,
};
