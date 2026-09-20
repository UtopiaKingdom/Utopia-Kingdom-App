/**
 * bot-studio-dialog.js — App-native confirm / prompt. No window.confirm.
 * Uses #studioDialog from index.html when present.
 */
(function () {
  'use strict';

  function ensure() {
    var el = document.getElementById('studioDialog');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'studioDialog';
    el.className = 'confirm-modal studio-dialog';
    el.innerHTML =
      '<div class="confirm-modal-content studio-dialog-card" role="dialog" aria-modal="true">' +
        '<div class="studio-dialog-icon" hidden aria-hidden="true">!</div>' +
        '<p class="studio-dialog-kicker"></p>' +
        '<h3 class="confirm-title"></h3>' +
        '<p class="confirm-message"></p>' +
        '<label class="studio-dialog-field" hidden>' +
          '<span></span>' +
          '<input type="text" maxlength="40" autocomplete="off" spellcheck="false" />' +
          '<textarea maxlength="500" rows="4" autocomplete="off" spellcheck="true" hidden></textarea>' +
        '</label>' +
        '<div class="confirm-actions">' +
          '<button type="button" class="btn-secondary" data-studio-dlg="no"></button>' +
          '<button type="button" class="btn-primary" data-studio-dlg="yes"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  function close(el) {
    if (!el) el = document.getElementById('studioDialog');
    if (!el) return;
    el.classList.remove('active');
    el.classList.add('closing');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(function () {
      el.classList.remove('closing');
      el.style.display = 'none';
    }, 160);
    try { document.body.classList.remove('modal-open'); } catch (e) {}
    if (close._focus && close._focus.focus) {
      try { close._focus.focus(); } catch (e2) {}
    }
    close._focus = null;
  }

  function show(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var el = ensure();
      var card = el.querySelector('.studio-dialog-card');
      var icon = el.querySelector('.studio-dialog-icon');
      var title = el.querySelector('.confirm-title');
      var msg = el.querySelector('.confirm-message');
      var kicker = el.querySelector('.studio-dialog-kicker');
      var field = el.querySelector('.studio-dialog-field');
      var input = el.querySelector('input');
      var textarea = el.querySelector('textarea');
      var yes = el.querySelector('[data-studio-dlg="yes"]');
      var no = el.querySelector('[data-studio-dlg="no"]');
      var done = false;
      var useTextarea = !!opts.reason;

      close._focus = document.activeElement;
      if (card) card.classList.toggle('is-danger', !!opts.danger);
      if (icon) icon.hidden = !opts.danger;
      kicker.textContent = opts.kicker || 'Studio';
      kicker.hidden = !opts.kicker;
      title.textContent = opts.title || '';
      msg.textContent = opts.message || '';
      msg.hidden = !opts.message;
      yes.textContent = opts.ok || 'OK';
      no.textContent = opts.cancel || 'Cancel';
      no.hidden = !!opts.hideCancel;
      yes.classList.toggle('is-danger', !!opts.danger);
      if (opts.prompt || useTextarea) {
        field.hidden = false;
        field.querySelector('span').textContent = opts.label || (useTextarea ? 'Reason' : 'Name');
        input.hidden = !!useTextarea;
        textarea.hidden = !useTextarea;
        if (useTextarea) {
          textarea.value = opts.value || '';
          input.value = '';
        } else {
          input.value = opts.value || '';
          textarea.value = '';
        }
      } else {
        field.hidden = true;
        input.value = '';
        textarea.value = '';
        input.hidden = false;
        textarea.hidden = true;
      }

      function fieldValue() {
        if (useTextarea) return String(textarea.value || '').trim();
        return String(input.value || '').trim();
      }

      function finish(val) {
        if (done) return;
        done = true;
        el.removeEventListener('click', onBg);
        document.removeEventListener('keydown', onKey, true);
        close(el);
        resolve(val);
      }

      function onBg(ev) {
        if (ev.target === el) finish(opts.prompt || useTextarea ? null : false);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          finish(opts.prompt || useTextarea ? null : false);
        } else if (ev.key === 'Enter' && !useTextarea && document.activeElement !== no) {
          ev.preventDefault();
          finish(opts.prompt ? fieldValue() : true);
        }
      }

      yes.onclick = function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        if (useTextarea) {
          const val = fieldValue();
          const min = Number(opts.minLength || 12);
          if (val.length < min) {
            msg.hidden = false;
            msg.textContent = 'Please write at least ' + min + ' characters.';
            try { textarea.focus(); } catch (eMin) {}
            return;
          }
          finish(val);
          return;
        }
        finish(opts.prompt ? fieldValue() : true);
      };
      no.onclick = function (ev) {
        try { ev.preventDefault(); } catch (e) {}
        finish(opts.prompt ? null : false);
      };

      el.addEventListener('click', onBg);
      document.addEventListener('keydown', onKey, true);
      el.classList.remove('closing');
      el.style.display = 'flex';
      el.classList.add('active');
      el.setAttribute('aria-hidden', 'false');
      try { document.body.classList.add('modal-open'); } catch (e3) {}
      setTimeout(function () {
        try {
          if (useTextarea) { textarea.focus(); }
          else if (opts.prompt) { input.focus(); input.select(); }
          else yes.focus();
        } catch (e4) {}
      }, 40);
    });
  }

  window.__utkStudioDialog = {
    confirm: function (opts) { return show(opts); },
    prompt: function (opts) {
      return show(Object.assign({}, opts, { prompt: true }));
    },
    reason: function (opts) {
      return show(Object.assign({}, opts, { reason: true }));
    }
  };
})();
