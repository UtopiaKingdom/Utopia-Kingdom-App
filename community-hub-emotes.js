/**
 * community-hub-emotes.js — Emoji picker + short codes for chat.
 * Load AFTER community-hub.js.
 */
(function () {
  'use strict';

  const EMOJIS = [
    '😀', '😂', '😍', '😎', '🤔', '😭', '😤', '🫡',
    '💀', '❤️', '🔥', '💯', '👀', '💪', '🤝', '🙏',
    '👑', '📈', '📉', '🚀', '💎', '⚡', '🎯', '💰',
    '🏆', '✅', '❌', '⚠️', '💤', '😈', '🫂', '🎉'
  ];
  const CODES = {
    fire: '🔥',
    lol: '😂',
    win: '✅',
    loss: '❌',
    up: '📈',
    down: '📉',
    rocket: '🚀',
    gem: '💎',
    crown: '👑',
    skull: '💀',
    heart: '❤️',
    wave: '👋',
    check: '✅',
    money: '💰',
    target: '🎯',
    zap: '⚡',
    eyes: '👀',
    strong: '💪',
    pray: '🙏',
    cool: '😎',
    think: '🤔',
    cry: '😭',
    king: '👑',
    party: '🎉'
  };
  const RECENTS_KEY = 'utkHubEmotes';

  function expand(text) {
    return String(text || '').replace(/:([a-z]{2,12}):/gi, function (all, code) {
      return CODES[String(code).toLowerCase()] || all;
    });
  }

  function recents() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (e) { return typeof e === 'string' && e; }).slice(0, 8);
    } catch (e) {
      return [];
    }
  }

  function remember(emo) {
    const next = [emo].concat(recents().filter(function (e) { return e !== emo; })).slice(0, 8);
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); } catch (e) {}
  }

  function insert(emo) {
    const input = document.getElementById('hubInput');
    if (!input) return;
    const start = input.selectionStart || input.value.length;
    const end = input.selectionEnd || input.value.length;
    const cur = input.value || '';
    const next = (cur.slice(0, start) + emo + cur.slice(end)).slice(0, 400);
    input.value = next;
    const pos = Math.min(start + emo.length, next.length);
    try { input.setSelectionRange(pos, pos); } catch (e) {}
    input.focus();
    remember(emo);
  }

  function closePanel() {
    const panel = document.getElementById('hubEmotePanel');
    const btn = document.getElementById('hubEmoteBtn');
    if (panel) panel.setAttribute('hidden', '');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function paintPanel() {
    const panel = document.getElementById('hubEmotePanel');
    if (!panel) return;
    const used = recents();
    const seen = Object.create(null);
    const row = used.concat(EMOJIS).filter(function (e) {
      if (seen[e]) return false;
      seen[e] = 1;
      return true;
    });
    panel.innerHTML = row.map(function (e) {
      return '<button type="button" class="hub-emote-pick" data-hub-emote="' + e + '">' + e + '</button>';
    }).join('');
  }

  function togglePanel() {
    const panel = document.getElementById('hubEmotePanel');
    const btn = document.getElementById('hubEmoteBtn');
    if (!panel) return;
    const open = panel.hasAttribute('hidden');
    if (open) {
      paintPanel();
      panel.removeAttribute('hidden');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    } else {
      closePanel();
    }
  }

  function bind() {
    const form = document.getElementById('hubComposer');
    const input = document.getElementById('hubInput');
    if (!form || form.__utkEmotes) return;
    form.__utkEmotes = true;

    form.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t) return;
      if (t.id === 'hubEmoteBtn' || (t.closest && t.closest('#hubEmoteBtn'))) {
        ev.preventDefault();
        togglePanel();
        return;
      }
      const pick = t.closest && t.closest('[data-hub-emote]');
      if (pick) {
        ev.preventDefault();
        insert(pick.getAttribute('data-hub-emote') || '');
        closePanel();
      }
    });

    document.addEventListener('click', function (ev) {
      const t = ev.target;
      const wrap = document.getElementById('hubComposeWrap');
      if (!wrap || !t) return;
      if (wrap.contains(t)) return;
      closePanel();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closePanel();
    });

    if (input) {
      input.addEventListener('input', function () {
        const next = expand(input.value);
        if (next !== input.value) {
          const delta = next.length - input.value.length;
          const pos = Math.max(0, (input.selectionStart || 0) + delta);
          input.value = next;
          try { input.setSelectionRange(pos, pos); } catch (e) {}
        }
      });
    }
  }

  function init() {
    if (typeof document === 'undefined') return;
    bind();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  const api = { expand: expand, insert: insert };
  try { window.__utkHubEmotes = api; } catch (e) {}
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
