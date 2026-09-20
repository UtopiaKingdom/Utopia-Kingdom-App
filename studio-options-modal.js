/**
 * studio-options-modal.js — Backtest picker + go-live confirm.
 * Load AFTER studio-check-window.js and bot-studio-dialog.js.
 */
(function () {
  'use strict';

  function ensure() {
    var el = document.getElementById('studioOptionsModal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'studioOptionsModal';
    el.className = 'confirm-modal studio-dialog studio-options-modal';
    el.innerHTML =
      '<div class="confirm-modal-content studio-dialog-card studio-options-card" role="dialog" aria-modal="true">' +
        '<p class="studio-dialog-kicker" id="studioOptKicker"></p>' +
        '<h3 class="confirm-title" id="studioOptTitle"></h3>' +
        '<p class="studio-options-note" id="studioOptNote"></p>' +
        '<div id="studioOptBody"></div>' +
        '<div class="confirm-actions">' +
          '<button type="button" class="btn-secondary" id="studioOptCancel">Cancel</button>' +
          '<button type="button" class="btn-primary" id="studioOptOk">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  function close(el) {
    if (!el) el = document.getElementById('studioOptionsModal');
    if (!el) return;
    el.classList.remove('active');
    el.classList.add('closing');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(function () {
      el.classList.remove('closing');
      el.style.display = 'none';
    }, 160);
    try { document.body.classList.remove('modal-open'); } catch (e) {}
  }

  function winApi() {
    return window.__utkStudioCheckWindow || null;
  }

  function pickerHtml(bot, state) {
    const api = winApi();
    if (!api) return '';
    state = state || {};
    const look = api.normalize(bot && bot.checkWindow);
    const gap = api.normalizeGap(bot && bot.signalGap);
    return (
      '<div class="studio-options-section">' +
        '<span class="studio-options-label">How far back</span>' +
        '<div class="studio-options-chips" data-opt-group="checkWindow">' +
          api.OPTS.map(function (opt) {
            return (
              '<button type="button" class="studio-options-chip' + (look === opt.id ? ' is-on' : '') + '"' +
                ' data-opt-val="' + opt.id + '">' + opt.label + '</button>'
            );
          }).join('') +
        '</div>' +
      '</div>' +
      '<div class="studio-options-section">' +
        '<span class="studio-options-label">Rest after each chain</span>' +
        '<div class="studio-options-chips" data-opt-group="signalGap">' +
          api.GAP_OPTS.map(function (opt) {
            return (
              '<button type="button" class="studio-options-chip' + (gap === opt.id ? ' is-on' : '') + '"' +
                ' data-opt-val="' + opt.id + '">' + opt.label + '</button>'
            );
          }).join('') +
        '</div>' +
      '</div>'
    );
  }

  function wireChips(body, state) {
    if (!body) return;
    body.querySelectorAll('.studio-options-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const group = btn.closest('[data-opt-group]');
        const key = group && group.getAttribute('data-opt-group');
        const val = btn.getAttribute('data-opt-val');
        if (!key || !val) return;
        state[key] = val;
        group.querySelectorAll('.studio-options-chip').forEach(function (b) {
          b.classList.toggle('is-on', b === btn);
        });
      });
    });
  }

  function showBacktest(bot) {
    const api = winApi();
    return new Promise(function (resolve) {
      const el = ensure();
      const kicker = el.querySelector('#studioOptKicker');
      const title = el.querySelector('#studioOptTitle');
      const note = el.querySelector('#studioOptNote');
      const body = el.querySelector('#studioOptBody');
      const cancel = el.querySelector('#studioOptCancel');
      const ok = el.querySelector('#studioOptOk');
      const state = {
        checkWindow: api ? api.normalize(bot && bot.checkWindow) : '7d',
        signalGap: api ? api.normalizeGap(bot && bot.signalGap) : '1m'
      };
      let done = false;

      kicker.textContent = 'Backtest';
      title.textContent = 'Test past candles';
      note.textContent = 'Replay real OTC prices on your rules. Nothing is sent to Pocket Option.';
      body.innerHTML = pickerHtml(bot, state);
      wireChips(body, state);
      ok.textContent = 'Start test';
      cancel.textContent = 'Cancel';

      function finish(val) {
        if (done) return;
        done = true;
        el.removeEventListener('click', onBg);
        document.removeEventListener('keydown', onKey, true);
        close(el);
        if (!val) {
          resolve(null);
          return;
        }
        resolve({
          checkWindow: api ? api.normalize(state.checkWindow) : state.checkWindow,
          signalGap: api ? api.normalizeGap(state.signalGap) : state.signalGap
        });
      }

      function onBg(ev) {
        if (ev.target === el) finish(null);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(null);
        } else if (ev.key === 'Enter' && document.activeElement !== cancel) {
          ev.preventDefault();
          finish(true);
        }
      }

      cancel.onclick = function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        finish(null);
      };
      ok.onclick = function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        finish(true);
      };

      el.addEventListener('click', onBg);
      document.addEventListener('keydown', onKey, true);
      el.classList.remove('closing');
      el.style.display = 'flex';
      el.classList.add('active');
      el.setAttribute('aria-hidden', 'false');
      try { document.body.classList.add('modal-open'); } catch (e2) {}
      setTimeout(function () {
        try { ok.focus(); } catch (e3) {}
      }, 40);
    });
  }

  function confirmGoLive(bot) {
    const el = ensure();
    return new Promise(function (resolve) {
      const kicker = el.querySelector('#studioOptKicker');
      const title = el.querySelector('#studioOptTitle');
      const note = el.querySelector('#studioOptNote');
      const body = el.querySelector('#studioOptBody');
      const cancel = el.querySelector('#studioOptCancel');
      const okBtn = el.querySelector('#studioOptOk');
      let done = false;
      const clarity = window.__utkStudioClarity;

      kicker.textContent = 'Go live';
      title.textContent = 'Run this bot 24/7 on the server?';
      note.textContent = 'You can close the app after this. Pause anytime to stop.';
      body.innerHTML = (clarity && typeof clarity.goLiveBulletsHtml === 'function')
        ? clarity.goLiveBulletsHtml(bot)
        : (
          '<ul class="studio-options-bullets">' +
            '<li><strong>Requires a finished candle test</strong> on this bot first.</li>' +
            '<li><strong>Runs 24/7</strong> on our server until you pause or delete it.</li>' +
            '<li><strong>You are responsible</strong> for taking it down when you are done.</li>' +
          '</ul>'
        );
      okBtn.textContent = 'Go live 24/7';
      cancel.textContent = 'Not yet';

      function finish(val) {
        if (done) return;
        done = true;
        el.removeEventListener('click', onBg);
        document.removeEventListener('keydown', onKey, true);
        close(el);
        resolve(!!val);
      }
      function onBg(ev) { if (ev.target === el) finish(false); }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        else if (ev.key === 'Enter' && document.activeElement !== cancel) { ev.preventDefault(); finish(true); }
      }
      cancel.onclick = function (e) { try { e.preventDefault(); } catch (x) {} finish(false); };
      okBtn.onclick = function (e) { try { e.preventDefault(); } catch (x) {} finish(true); };
      el.addEventListener('click', onBg);
      document.addEventListener('keydown', onKey, true);
      el.classList.remove('closing');
      el.style.display = 'flex';
      el.classList.add('active');
      el.setAttribute('aria-hidden', 'false');
      try { document.body.classList.add('modal-open'); } catch (e2) {}
      setTimeout(function () { try { okBtn.focus(); } catch (e3) {} }, 40);
    });
  }

  window.__utkStudioOptionsModal = {
    openBacktest: showBacktest,
    confirmGoLive: confirmGoLive
  };
})();
