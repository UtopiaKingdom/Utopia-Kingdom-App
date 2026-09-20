/**
 * community-hub-censor.js — Clean chat text before it is shown or stored.
 * Load before community-hub.js.
 */
(function (root) {
  'use strict';

  const ROOTS = [
    'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cock', 'pussy',
    'cunt', 'slut', 'whore', 'nigger', 'nigga', 'retard', 'faggot', 'fag',
    'rape', 'rapist', 'twat', 'wank', 'wanker', 'bollocks', 'motherfucker',
    'blowjob', 'handjob', 'jerkoff', 'jackoff', 'cumshot', 'dildo',
    'penis', 'vagina', 'anus', 'anal', 'porn', 'porno', 'hentai',
    'nazi', 'kkk', 'pedo', 'paedo', 'paedophile', 'pedophile',
    'killyourself', 'kys', 'fuk', 'fck', 'fuq'
  ];
  const SUFFIX = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'ings', 'y', 'ty', 'ied'];
  const BAD = Object.create(null);
  ROOTS.forEach(function (w) {
    SUFFIX.forEach(function (s) { BAD[w + s] = 1; });
  });

  function foldToken(tok) {
    return String(tok || '')
      .toLowerCase()
      .replace(/@/g, 'a')
      .replace(/4/g, 'a')
      .replace(/0/g, 'o')
      .replace(/[1!|]/g, 'i')
      .replace(/3/g, 'e')
      .replace(/[$5]/g, 's')
      .replace(/7/g, 't')
      .replace(/[^a-z]/g, '');
  }

  function mask(tok) {
    const n = Math.max(3, String(tok).length);
    return new Array(n + 1).join('*').slice(0, n);
  }

  function isBad(norm) {
    return !!(norm && BAD[norm]);
  }

  function censorText(value) {
    const text = String(value == null ? '' : value);
    if (!text) return '';
    return text.replace(/[^\s]+/g, function (tok) {
      return isBad(foldToken(tok)) ? mask(tok) : tok;
    });
  }

  const api = { censorText: censorText };
  try { root.__utkHubCensor = api; } catch (e) {}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
