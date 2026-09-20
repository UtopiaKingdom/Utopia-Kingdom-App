/**
 * nyx-access.js
 * NYX is a public bot (same as Lumix / Mirax). This module still exposes
 * hasAccess() so older callers keep working; it always returns true.
 * Owner email is only used by the Mind debug notebook.
 * Load AFTER renderer.js.
 */
(function () {
  'use strict';

  const OWNER_EMAIL = 'kricoeasygame@gmail.com';

  function normEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function currentEmail() {
    try {
      if (typeof window !== 'undefined' && window.auth && window.auth.currentUser) {
        return normEmail(window.auth.currentUser.email);
      }
    } catch (e) {}
    try {
      const av = require('./auth-verification.js');
      const user = av && av.auth && av.auth.currentUser;
      return normEmail(user && user.email);
    } catch (e2) {}
    return '';
  }

  function hasAccess() {
    return true;
  }

  function isOwner() {
    return currentEmail() === OWNER_EMAIL;
  }

  function emit() {
    try {
      window.dispatchEvent(new CustomEvent('utk-nyx-access', { detail: { access: true, owner: isOwner() } }));
    } catch (e) {}
  }

  function apply() {
    document.querySelectorAll('.nyx-gated').forEach(function (el) {
      if (el.id === 'section-bot3' || el.id === 'nyxMindBtn') return;
      el.removeAttribute('hidden');
      el.classList.add('nyx-open');
    });
    emit();
  }

  function boot() {
    apply();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.__utkNyxAccess = {
    OWNER_EMAIL: OWNER_EMAIL,
    hasAccess: hasAccess,
    isOwner: isOwner,
    apply: apply
  };
})();
