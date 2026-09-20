/**
 * bots-registry.js
 * Public bots including NYX. Load BEFORE renderer.js.
 */
(function (root) {
  'use strict';

  const PUBLIC = [
    { key: 'LUMIX', id: 'bot1', display: 'Lumix', expirySec: 180, expiryLabel: '3 minutes' },
    { key: 'MIRAX', id: 'bot2', display: 'Mirax', expirySec: 30, expiryLabel: '30 seconds' },
    { key: 'NYX', id: 'bot3', display: 'Nyx', expirySec: 60, expiryLabel: '20s–10m' }
  ];
  const PRIVATE = [];
  const ALL = PUBLIC.concat(PRIVATE);
  const byKey = Object.create(null);
  const byId = Object.create(null);
  ALL.forEach(function (b) {
    byKey[b.key] = b;
    byId[b.id] = b;
  });

  function wiredKeys() {
    return ALL.map(function (b) { return b.key; });
  }

  function visibleKeys() {
    return PUBLIC.map(function (b) { return b.key; });
  }

  function panelIds() {
    return ALL.map(function (b) { return b.id; });
  }

  function idOf(key) {
    const row = byKey[String(key || '').toUpperCase()];
    return row ? row.id : '';
  }

  function keyOf(id) {
    const row = byId[String(id || '').trim()];
    return row ? row.key : '';
  }

  function meta(key) {
    return byKey[String(key || '').toUpperCase()] || null;
  }

  function isWired(key) {
    return !!byKey[String(key || '').toUpperCase()];
  }

  root.__utkBots = {
    PUBLIC: PUBLIC,
    PRIVATE: PRIVATE,
    ALL: ALL,
    wiredKeys: wiredKeys,
    visibleKeys: visibleKeys,
    panelIds: panelIds,
    idOf: idOf,
    keyOf: keyOf,
    meta: meta,
    isWired: isWired
  };
})(typeof window !== 'undefined' ? window : globalThis);
