/**
 * Shared URL allowlists for privileged Electron IPC.
 * Keep installer / openExternal from becoming remote-install primitives.
 */
'use strict';

const INSTALLER_HOSTS = [
  /(^|\.)utkingdom\.com$/i,
  /^utopia-kingdom\.escapesvk\.workers\.dev$/i,
];

const EXTERNAL_HOST_ALLOW = [
  /(^|\.)utkingdom\.com$/i,
  /^utopia-kingdom\.escapesvk\.workers\.dev$/i,
  /(^|\.)paddle\.com$/i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)coinbase\.com$/i,
  /(^|\.)firebase\.google\.com$/i,
  /(^|\.)google\.com$/i,
  /(^|\.)googleapis\.com$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)discord\.com$/i,
  /(^|\.)discord\.gg$/i,
  /(^|\.)t\.me$/i,
  /(^|\.)telegram\.org$/i,
  /(^|\.)pocketoption\.com$/i,
  /(^|\.)po\.market$/i,
];

function safeParseUrl(raw) {
  try {
    return new URL(String(raw || '').trim());
  } catch (_) {
    return null;
  }
}

function hostAllowed(hostname, patterns) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return patterns.some((re) => re.test(host));
}

function isHttpsUrl(u) {
  return !!(u && u.protocol === 'https:');
}

function isAllowedInstallerUrl(raw) {
  const u = safeParseUrl(raw);
  if (!u || !isHttpsUrl(u)) return false;
  if (u.username || u.password) return false;
  if (!hostAllowed(u.hostname, INSTALLER_HOSTS)) return false;
  const path = String(u.pathname || '');
  // Prefer .exe; also allow updater YAML-adjacent paths under /updates/ or /releases/
  if (/\.exe$/i.test(path)) return true;
  if (/^\/(updates|releases)\//i.test(path)) return true;
  return false;
}

function isAllowedExternalUrl(raw) {
  const u = safeParseUrl(raw);
  if (!u) return false;
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username || u.password) return false;
  // Block obviously dangerous schemes already filtered; still refuse file/data/etc.
  if (u.protocol === 'http:') {
    // Only Contabo hub IP is intentionally HTTP in this product.
    if (u.hostname === '169.58.151.111') return true;
    return false;
  }
  return hostAllowed(u.hostname, EXTERNAL_HOST_ALLOW);
}

function isAllowedPaymentUrl(raw) {
  const u = safeParseUrl(raw);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false;
  if (u.username || u.password) return false;
  if (u.protocol === 'http:') return false;
  return (
    /(^|\.)paddle\.com$/i.test(u.hostname) ||
    /(^|\.)utkingdom\.com$/i.test(u.hostname) ||
    !!u.searchParams.get('_ptxn')
  );
}

module.exports = {
  INSTALLER_HOSTS,
  EXTERNAL_HOST_ALLOW,
  safeParseUrl,
  isAllowedInstallerUrl,
  isAllowedExternalUrl,
  isAllowedPaymentUrl,
};
