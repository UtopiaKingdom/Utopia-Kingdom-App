/**
 * Read Edge/PO asset-list payout % (what the picker shows) from local meta files.
 * Used to correct SSID duration-bucket under-reports (UI 92, SSID 88/89).
 */
'use strict';

const fs = require('fs');
const path = require('path');

function _compact(s) {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/#/g, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '/')
    .replace(/_/g, '');
}

function _variants(currency) {
  const raw = String(currency || '').trim();
  const c = _compact(raw);
  const out = new Set([c, raw.toUpperCase()]);
  // ADA/USD OTC ↔ ADA-USD OTC ↔ ADAUSDOTC
  out.add(c.replace(/\//g, '-'));
  out.add(c.replace(/\//g, ''));
  out.add(c.replace(/OTC$/i, '_OTC'));
  if (!/OTC$/i.test(c)) out.add(`${c}OTC`);
  return [...out];
}

function _metaDirs() {
  const roots = [];
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      roots.push(app.getAppPath());
    }
  } catch (_) {}
  roots.push(process.cwd());
  roots.push(path.join(__dirname));
  const dirs = [];
  for (const r of roots) {
    dirs.push(path.join(r, 'BotsHub', 'Prices', 'meta'));
    dirs.push(path.join(r, '..', 'BotsHub', 'Prices', 'meta'));
  }
  return [...new Set(dirs)];
}

function _parseTxt(filePath) {
  const map = new Map();
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return map;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('Currency:') || !line.includes('Payout:')) continue;
    try {
      const cur = line.split('Currency:')[1].split(',')[0].trim();
      const pct = parseInt(line.split('Payout:')[1].replace('%', '').trim(), 10);
      if (!cur || !Number.isFinite(pct)) continue;
      for (const v of _variants(cur)) map.set(v, pct);
    } catch (_) {}
  }
  return map;
}

function _parseEdgeJson(filePath) {
  const map = new Map();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return map;
  }
  const body = raw && (raw.payouts || raw.map || raw);
  if (!body || typeof body !== 'object') return map;
  for (const [k, v] of Object.entries(body)) {
    const pct = Number(v);
    if (!Number.isFinite(pct)) continue;
    for (const variant of _variants(k)) map.set(variant, Math.round(pct));
  }
  return map;
}

let _cacheAt = 0;
let _cache = new Map();

function _loadMaps() {
  const now = Date.now();
  if (now - _cacheAt < 5000 && _cache.size) return _cache;
  const merged = new Map();
  for (const dir of _metaDirs()) {
    const txt = path.join(dir, 'currencies_payouts.txt');
    const edge = path.join(dir, 'edge_live_payouts.json');
    for (const [k, v] of _parseTxt(txt)) {
      // Prefer higher when merging (Edge DOM / fresher harvest may raise sticky MIN).
      const prev = merged.get(k);
      if (prev == null || v > prev) merged.set(k, v);
    }
    for (const [k, v] of _parseEdgeJson(edge)) {
      const prev = merged.get(k);
      if (prev == null || v > prev) merged.set(k, v);
    }
  }
  _cache = merged;
  _cacheAt = now;
  return merged;
}

/**
 * @returns {number|null} payout % from Edge/list files, or null
 */
function lookupEdgeListPayout(currency) {
  if (!currency) return null;
  const map = _loadMaps();
  for (const v of _variants(currency)) {
    const hit = map.get(v);
    if (Number.isFinite(hit) && hit >= 80 && hit <= 100) return hit;
  }
  return null;
}

module.exports = {
  lookupEdgeListPayout,
  _compact,
  _variants
};
