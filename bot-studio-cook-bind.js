/**
 * bot-studio-cook-bind.js — Studio Cook / Review clicks.
 * Document capture + post-render direct binds (Electron-safe).
 * Load after bot-studio.js.
 */
(function () {
  'use strict';

  var ID_CMDS = {
    studioDelete: 'delete',
    studioDuplicate: 'duplicate',
    studioPause: 'pause',
    studioSave: 'save',
    studioCheck: 'check',
    studioDeskCheck: 'check',
    studioAiUpgrade: 'aiUpgrade',
    studioBacktestAi: 'aiUpgrade',
    studioGoLive: 'goLive',
    studioPublish: 'publish',
    studioUnpublish: 'unpublish',
    studioNewBtn: 'newBot',
    studioEmptyNew: 'newBot',
    studioEmptyGlobal: 'tab',
    studioWizardNext: 'wizardNext',
    studioNameOpen: 'openName'
  };

  function elFrom(t) {
    if (!t) return null;
    if (t.nodeType === 1) return t;
    return t.parentElement || null;
  }

  function run(action, arg) {
    if (!action) return;
    try {
      if (typeof window.__utkStudioCmd === 'function') {
        window.__utkStudioCmd(action, arg);
        return;
      }
    } catch (err) {
      try { console.error('[Studio cook-bind]', action, err); } catch (e) {}
    }
    try {
      var s = window.__utkBotStudio;
      if (s && typeof s.command === 'function') s.command(action, arg);
    } catch (err2) {
      try { console.error('[Studio cook-bind]', action, err2); } catch (e2) {}
    }
  }

  function fireFromEl(el, ev) {
    if (!el) return false;
    var action = el.getAttribute('data-cmd');
    var arg = el.getAttribute('data-arg');
    if (!action) {
      var mapped = ID_CMDS[el.id || ''];
      if (!mapped) return false;
      action = mapped;
      arg = mapped === 'tab' ? 'global' : undefined;
    }
    if (ev) {
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopPropagation(); } catch (e2) {}
      try { ev.__utkStudioHandled = true; } catch (e3) {}
    }
    run(action, arg == null || arg === '' ? undefined : arg);
    return true;
  }

  function handle(ev) {
    if (ev && ev.__utkStudioHandled) return;
    if (window.__utkStudioTips && typeof window.__utkStudioTips.blockEvent === 'function' && window.__utkStudioTips.blockEvent(ev)) return;
    var t = elFrom(ev && ev.target);
    if (!t || !t.closest) return;
    var studio = document.getElementById('section-studio');
    if (!studio || !studio.contains(t)) return;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (t.closest('#studioNameOverlay')) return;
    if (t.closest('#studioChart, #studioGlobalList, #studioGlobalDesk, #studioTipLayer')) return;

    var cmdEl = t.closest('[data-cmd]');
    if (cmdEl && studio.contains(cmdEl)) {
      if (cmdEl.disabled || cmdEl.getAttribute('disabled') != null) return;
      fireFromEl(cmdEl, ev);
      return;
    }

    var btn = t.closest('button');
    if (!btn || !studio.contains(btn)) return;
    if (ID_CMDS[btn.id || '']) fireFromEl(btn, ev);
  }

  function wire(root) {
    var scope = root || document.getElementById('section-studio');
    if (!scope || !scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll(
      '.studio-form-actions [data-cmd], .studio-form-actions button[id],' +
      '#studioWizardNext, .cook-edit[data-cmd], .cook-btn[data-cmd],' +
      '.cook-review-top [data-cmd]'
    );
    for (var i = 0; i < nodes.length; i++) {
      (function (el) {
        if (el.getAttribute('data-utk-bound') === '1') return;
        el.setAttribute('data-utk-bound', '1');
        el.addEventListener('click', function (ev) {
          fireFromEl(el, ev);
        });
      })(nodes[i]);
    }
  }

  function bindDoc() {
    if (document.documentElement.getAttribute('data-utk-cook-bind') === '1') return;
    document.documentElement.setAttribute('data-utk-cook-bind', '1');
    document.addEventListener('click', handle, true);
  }

  window.__utkStudioCookBind = { wire: wire, run: run };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindDoc);
  } else {
    bindDoc();
  }
})();
