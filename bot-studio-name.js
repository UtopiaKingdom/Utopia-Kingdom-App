/**
 * bot-studio-name.js — Rename via Studio dialog. Load after dialog + bot-studio.js.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function html(bot) {
    var name = bot && bot.name ? String(bot.name) : 'My bot';
    return (
      '<div class="studio-name-row" id="studioNameRow">' +
        '<input type="hidden" id="studioName" value="' + esc(name) + '" />' +
        '<button type="button" class="studio-name-open" id="studioNameOpen" data-cmd="openName">' +
          '<span class="studio-name-kicker">Name</span>' +
          '<span class="studio-name-value" id="studioNameLabel">' + esc(name) + '</span>' +
        '</button>' +
      '</div>'
    );
  }

  function currentName() {
    var hidden = document.getElementById('studioName');
    var label = document.getElementById('studioNameLabel');
    if (hidden && hidden.value) return String(hidden.value);
    if (label) return String(label.textContent || '');
    return '';
  }

  function open() {
    var dlg = window.__utkStudioDialog;
    if (!dlg || typeof dlg.prompt !== 'function') return;
    dlg.prompt({
      kicker: 'Studio',
      title: 'Bot name',
      message: 'This is how it shows on your desk and in the list.',
      label: 'Name',
      value: currentName(),
      ok: 'Save',
      cancel: 'Cancel'
    }).then(function (next) {
      if (next == null) return;
      if (typeof window.__utkStudioCmd === 'function') window.__utkStudioCmd('saveName', next);
    });
  }

  function paint(name) {
    var hidden = document.getElementById('studioName');
    var label = document.getElementById('studioNameLabel');
    if (hidden) hidden.value = name || '';
    if (label) label.textContent = name || 'My bot';
  }

  function wire(root) {
    var scope = root && root.querySelector ? root : document;
    var btn = scope.querySelector ? scope.querySelector('#studioNameOpen') : document.getElementById('studioNameOpen');
    if (!btn || btn.getAttribute('data-utk-name-wire') === '1') return;
    btn.setAttribute('data-utk-name-wire', '1');
    btn.addEventListener('click', function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      open();
    });
  }

  window.__utkStudioName = { html: html, wire: wire, open: open, paint: paint };
})();
