/**
 * kingdom-marks-cloud.js — Calls Kingdom Marks API (utkingdom.com server authority).
 */
(function () {
  'use strict';

  if (window.__utkMarksCloud) return;
  window.__utkMarksCloud = true;

  const BASE = 'https://utkingdom.com/api/marks';

  function auth() {
    try {
      if (window.auth && window.auth.currentUser) return window.auth;
    } catch (_) {}
    try {
      const av = require('./auth-verification');
      if (av && av.auth) return av.auth;
    } catch (_) {}
    return null;
  }

  async function idToken() {
    const a = auth();
    const user = a && a.currentUser;
    if (!user || typeof user.getIdToken !== 'function') {
      const err = new Error('Sign in required.');
      err.code = 'marks/auth';
      throw err;
    }
    return user.getIdToken();
  }

  async function call(path, payload) {
    const token = await idToken();
    let res;
    try {
      res = await fetch(BASE + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token
        },
        body: JSON.stringify(payload || {})
      });
    } catch (_) {
      const err = new Error('Marks need a live Kingdom connection.');
      err.code = 'marks/offline';
      throw err;
    }
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Marks request failed.');
      err.code = 'marks/http';
      err.status = res.status;
      throw err;
    }
    return data;
  }

  window.utkMarksCloud = {
    ready: function () {
      return true;
    },
    grant: function (payload) {
      return call('/grant', payload);
    },
    redeem: function (payload) {
      return call('/redeem', payload);
    },
    citizenWeek: function (payload) {
      return call('/citizen-week', payload || {});
    },
    touchPo: function (payload) {
      return call('/touch-po', payload);
    }
  };
})();
