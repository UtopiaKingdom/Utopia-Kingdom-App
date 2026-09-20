/**
 * bot-studio-interactions.js — Studio rail, tabs, and fallback action clicks.
 * Load AFTER bot-studio.js / cook-bind.
 */
(function () {
  'use strict';

  function elFrom(t) {
    if (!t) return null;
    if (t.nodeType === 1) return t;
    return t.parentElement || null;
  }

  function cmd(action, a, b) {
    if (typeof window.__utkStudioCmd === 'function') {
      window.__utkStudioCmd(action, a, b);
      return;
    }
    var s = window.__utkBotStudio;
    if (s && typeof s.command === 'function') s.command(action, a, b);
  }

  function inStudio(target) {
    var root = document.getElementById('section-studio');
    return root && target && root.contains(target);
  }

  function handleClick(ev) {
    if (ev && ev.__utkStudioHandled) return;
    if (window.__utkStudioTips && typeof window.__utkStudioTips.blockEvent === 'function' && window.__utkStudioTips.blockEvent(ev)) return;
    var t = elFrom(ev && ev.target);
    if (!t || !t.closest || !inStudio(t)) return;
    if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (t.closest('#studioNameOverlay')) return;
    if (t.closest('#studioChart, #studioGlobalList, #studioGlobalDesk, #studioTipLayer')) return;

    var cmdEl = t.closest('[data-cmd]');
    if (cmdEl && inStudio(cmdEl)) {
      if (cmdEl.disabled || cmdEl.getAttribute('disabled') != null) return;
      ev.preventDefault();
      try { ev.__utkStudioHandled = true; } catch (e) {}
      var action = cmdEl.getAttribute('data-cmd');
      var arg = cmdEl.getAttribute('data-arg');
      cmd(action, arg == null || arg === '' ? undefined : arg);
      return;
    }

    var tab = t.closest('[data-studio-tab]');
    if (tab) {
      ev.preventDefault();
      cmd('tab', tab.getAttribute('data-studio-tab') || 'global');
      return;
    }

    var pick = t.closest('[data-studio-bot]');
    if (pick) {
      ev.preventDefault();
      cmd('selectBot', pick.getAttribute('data-studio-bot') || '');
      return;
    }

    if (t.closest('.studio-toggle')) {
      setTimeout(function () { cmd('formChange'); }, 0);
      return;
    }

    var btn = t.closest('button');
    var id = (btn && btn.id) || '';
    if (!id) {
      var hit = t.closest('[id]');
      id = (hit && hit.id) || '';
    }
    if (id === 'studioNewBtn' || id === 'studioEmptyNew' || id === 'studioHubNew') { ev.preventDefault(); cmd('newBot'); return; }
    if (id === 'studioEmptyGlobal') { ev.preventDefault(); cmd('tab', 'global'); return; }
    if (id === 'studioSave') { ev.preventDefault(); cmd('save'); return; }
    if (id === 'studioCheck' || id === 'studioDeskCheck') { ev.preventDefault(); cmd('check'); return; }
    if (id === 'studioGoLive') { ev.preventDefault(); cmd('goLive'); return; }
    if (id === 'studioPause') { ev.preventDefault(); cmd('pause'); return; }
    if (id === 'studioDuplicate') { ev.preventDefault(); cmd('duplicate'); return; }
    if (id === 'studioDelete') { ev.preventDefault(); cmd('delete'); return; }
    if (id === 'studioAiUpgrade') { ev.preventDefault(); cmd('aiUpgrade'); return; }
    if (id === 'studioPublish') { ev.preventDefault(); cmd('publish'); return; }
    if (id === 'studioUnpublish') { ev.preventDefault(); cmd('unpublish'); return; }
  }

  function handleChange(ev) {
    var t = elFrom(ev && ev.target);
    if (!t || !t.matches || !inStudio(t)) return;
    if (t.closest('#studioForm') && t.matches('input, select, textarea') && t.id !== 'studioName') {
      cmd('formChange');
    }
  }

  function bind() {
    if (document.documentElement.dataset.studioDocBound === '1') return;
    document.documentElement.dataset.studioDocBound = '1';
    document.addEventListener('click', handleClick, false);
    document.addEventListener('change', handleChange, false);
    document.addEventListener('input', handleChange, false);
    document.addEventListener('keydown', function (ev) {
      if (!ev || ev.key !== 'Escape') return;
      var page = document.getElementById('studioPage');
      if (!page || !page.classList.contains('is-cook-wizard')) return;
      var ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
      try { ev.preventDefault(); } catch (e) {}
      cmd('wizardCancel');
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
