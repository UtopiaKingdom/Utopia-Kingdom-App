/**
 * home-support.js — Home support / problem message → support inbox
 */
(function () {
  'use strict';

  const { ipcRenderer } = require('electron');

  function getUserContact() {
    let email = '';
    let name = '';
    try {
      const { auth } = require('./auth-verification');
      const user = auth && auth.currentUser;
      if (user) {
        email = String(user.email || '').trim();
        name = String(user.displayName || '').trim();
      }
    } catch (e) {}

    if (!email) {
      const el = document.getElementById('displayEmail');
      const text = el && el.textContent ? el.textContent.trim() : '';
      if (text && text.includes('@') && text !== 'user@example.com') email = text;
    }
    if (!name) {
      const welcome = document.getElementById('homeWelcomeName');
      const text = welcome && welcome.textContent ? welcome.textContent.trim() : '';
      if (text && text.toLowerCase() !== 'trader') name = text;
    }
    return { email, name };
  }

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-ok', 'is-err', 'is-busy');
    if (kind) el.classList.add(kind);
  }

  function init() {
    const form = document.getElementById('homeSupportForm');
    const messageEl = document.getElementById('homeSupportMessage');
    const sendBtn = document.getElementById('homeSupportSend');
    const statusEl = document.getElementById('homeSupportStatus');
    if (!form || !messageEl || !sendBtn) return;

    form.addEventListener('change', (ev) => {
      if (!ev.target || ev.target.name !== 'homeSupportKind') return;
      if (ev.target.value === 'beta') {
        messageEl.placeholder = 'I want to be a beta tester. I’ll send a short note each week…';
      } else if (ev.target.value === 'problem') {
        messageEl.placeholder = 'What went wrong?';
      } else {
        messageEl.placeholder = 'Describe what you need help with...';
      }
    });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const message = String(messageEl.value || '').trim();
      if (message.length < 10) {
        setStatus(statusEl, 'Please write a bit more (at least 10 characters).', 'is-err');
        messageEl.focus();
        return;
      }

      const kindInput = form.querySelector('input[name="homeSupportKind"]:checked');
      const kindRaw = kindInput && kindInput.value ? String(kindInput.value) : 'support';
      const kind = kindRaw === 'problem' || kindRaw === 'beta' ? kindRaw : 'support';
      const { email, name } = getUserContact();

      if (kind === 'beta' && !email) {
        setStatus(statusEl, 'Sign in first so we can unlock beta on your account.', 'is-err');
        return;
      }

      sendBtn.disabled = true;
      setStatus(statusEl, 'Sending…', 'is-busy');

      try {
        const result = await ipcRenderer.invoke('send-support-message', {
          message,
          email,
          name,
          kind,
        });
        if (!result || !result.success) {
          throw new Error((result && result.error) || 'Could not send message.');
        }
        messageEl.value = '';
        setStatus(statusEl, 'Sent — we’ll reply by email.', 'is-ok');
      } catch (err) {
        setStatus(statusEl, (err && err.message) || 'Send failed. Try again later.', 'is-err');
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
