/**
 * bot-mind-ui.js
 * Mind notebook next to Pop out on LUMIX / MIRAX / NYX and custom Studio desks.
 * House bots: thinking only (no runner/connected checklist).
 * Custom bots: full live status + pace + abandon hints.
 * Load after signal-pip-ui.js; studio sync is called from studio-feed-desk wire().
 */
(function () {
  'use strict';

  if (window.__utkBotMind) return;

  const HOUSE = [
    { key: 'LUMIX', section: 'section-bot1', emptyId: 'signalEmpty-bot1' },
    { key: 'MIRAX', section: 'section-bot2', emptyId: 'signalEmpty-bot2' },
    { key: 'NYX', section: 'section-bot3', emptyId: 'signalEmpty-bot3' }
  ];

  const MIND_ICON =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    'd="M9.4 4.6a4.4 4.4 0 0 1 5.7 4.1c1.6.3 2.9 1.8 2.9 3.6a3.7 3.7 0 0 1-3.5 3.7H9.3A4.3 4.3 0 0 1 5 12.1 4.1 4.1 0 0 1 8.1 8a4.4 4.4 0 0 1 1.3-3.4z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M10 13.2c.7.6 1.6.9 2.5.9s1.8-.3 2.5-.9"/>' +
    '</svg>';

  const CLOSE_ICON =
    '<svg width="14" height="14" viewBox="0 0 22 22" aria-hidden="true">' +
    '<line x1="6" y1="6" x2="16" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '<line x1="16" y1="6" x2="6" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
    '</svg>';

  let openKey = null;
  let studioCtx = null;
  let timer = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function areaForHouse(botKey) {
    const row = HOUSE.find(function (h) { return h.key === botKey; });
    return row ? document.querySelector('#' + row.section + ' .bot-signal-area') : null;
  }

  function ensureChrome(area) {
    if (!area) return null;
    let chrome = area.querySelector('.signal-pip-chrome');
    if (!chrome) {
      chrome = document.createElement('div');
      chrome.className = 'signal-pip-chrome';
      area.insertBefore(chrome, area.firstChild);
    }
    chrome.hidden = false;
    return chrome;
  }

  function ensureNote(area) {
    if (!area) return null;
    let note = area.querySelector('.bot-mind-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'bot-mind-note nyx-mind-note';
      note.setAttribute('hidden', '');
      note.innerHTML =
        '<div class="nyx-mind-note-head">' +
          '<h3>Mind</h3>' +
          '<span class="nyx-mind-meta bot-mind-meta"></span>' +
          '<button type="button" class="nyx-mind-note-close bot-mind-close" aria-label="Close mind" title="Close">' +
            CLOSE_ICON +
          '</button>' +
        '</div>' +
        '<div class="bot-mind-body"></div>';
      area.appendChild(note);
      note.addEventListener('click', function (e) { e.stopPropagation(); });
      const close = note.querySelector('.bot-mind-close');
      if (close) {
        close.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(null);
        });
      }
    }
    return note;
  }

  function mountBtn(area, key) {
    const chrome = ensureChrome(area);
    if (!chrome) return null;
    let btn = chrome.querySelector('.bot-mind-btn[data-mind-key="' + key + '"]');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'signal-pip-btn bot-mind-btn nyx-mind-btn';
    btn.dataset.mindKey = key;
    btn.title = 'Mind — what this bot is thinking';
    btn.setAttribute('aria-label', 'Mind');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = MIND_ICON;
    const pip = chrome.querySelector('.signal-pip-btn[data-pip-bot]');
    if (pip) chrome.insertBefore(btn, pip);
    else chrome.appendChild(btn);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(openKey === key ? null : key);
    });
    return btn;
  }

  function paintNote(note, payload) {
    if (!note) return;
    const meta = note.querySelector('.bot-mind-meta');
    const body = note.querySelector('.bot-mind-body');
    if (meta) meta.textContent = payload.meta || '';
    if (!body) return;
    if (payload.html) {
      body.innerHTML = payload.html;
      return;
    }
    const said = esc(payload.said || 'Waiting to look at the board.');
    const learned = Array.isArray(payload.learned) ? payload.learned : [];
    const skips = Array.isArray(payload.skips) ? payload.skips : [];
    const events = Array.isArray(payload.eventLines) ? payload.eventLines : [];
    const skipLines = skips.map(function (s) {
      if (typeof s === 'string') return s;
      const pair = s.pair || '';
      const setup = s.setup || '';
      const why = s.why || 'not a clean enough match';
      return 'Skipped ' + [pair, setup].filter(Boolean).join(' ') + ' — ' + why;
    });
    body.innerHTML =
      '<p class="nyx-mind-said">' + said + '</p>' +
      (learned.length
        ? '<ul class="nyx-mind-learned">' + learned.map(function (t) {
          return '<li>' + esc(t) + '</li>';
        }).join('') + '</ul>'
        : '') +
      (events.length
        ? '<ul class="nyx-mind-learned bot-mind-events">' + events.map(function (t) {
          return '<li>' + esc(t) + '</li>';
        }).join('') + '</ul>'
        : '') +
      (skipLines.length
        ? '<ul class="nyx-mind-skips">' + skipLines.map(function (t) {
          return '<li>' + esc(t) + '</li>';
        }).join('') + '</ul>'
        : '');
  }

  function houseFallback(botKey) {
    const row = HOUSE.find(function (h) { return h.key === botKey; });
    let emptyLine = 'Waiting for the next clean setup.';
    try {
      const empty = row && document.getElementById(row.emptyId);
      const p = empty && empty.querySelector('[data-empty-text]');
      if (p && p.textContent) emptyLine = String(p.textContent).trim();
    } catch (e) {}
    const name = botKey === 'LUMIX' ? 'Lumix' : (botKey === 'MIRAX' ? 'Mirax' : botKey);
    const tips = botKey === 'LUMIX'
      ? [
          'Looking for stretch → snap-back setups (mean-revert style).',
          'Quiet stretches are normal — only fires when the tape matches.'
        ]
      : botKey === 'MIRAX'
        ? [
            'Looking for clean OTC turns with strong payout.',
            'Quiet stretches are normal — patient when the board is messy.'
          ]
        : [
            emptyLine,
            'Quiet stretches are normal — filters only fire when the market matches.'
          ];
    return {
      meta: 'watching OTC',
      said: name + ' is scanning OTC for the next clean setup.',
      learned: tips,
      skips: [],
      eventLines: []
    };
  }

  async function housePayload(botKey) {
    try {
      const tape = window.__utkBotTape;
      if (tape && typeof tape.fetchMind === 'function') {
        const data = await tape.fetchMind(botKey);
        if (data && (data.said || data.learned || data.skips || data.eventLines)) {
          const bits = [];
          if (data.meta) {
            /* prefer server meta */
          } else {
            if (data.watching) bits.push(data.watching + ' pairs');
            if (data.everyMin) bits.push('~' + data.everyMin + 'm');
            if (data.reversalsHour != null) bits.push(data.reversalsHour + '/h');
            if (data.streak) bits.push('streak ' + data.streak);
            if (data.idleMin != null && data.phase === 'searching') bits.push('idle ' + Math.round(data.idleMin) + 'm');
          }
          return {
            meta: data.meta || bits.join(' · '),
            said: data.said || 'Waiting to look at the board.',
            learned: Array.isArray(data.learned) ? data.learned.slice(0, 7) : [],
            skips: Array.isArray(data.skips) ? data.skips.slice(0, 5) : [],
            eventLines: Array.isArray(data.eventLines) ? data.eventLines.slice(0, 5) : []
          };
        }
      }
    } catch (e) {}
    return houseFallback(botKey);
  }

  function studioPayload() {
    const ctx = studioCtx || {};
    const bot = ctx.bot || {};
    const liveMeta = ctx.liveMeta || bot.liveMeta || {};
    const liveStatus = window.__utkStudioLiveStatus;
    if (liveStatus && typeof liveStatus.mindPanelHtml === 'function') {
      return {
        meta: String(bot.name || 'My bot'),
        html: liveStatus.mindPanelHtml(bot, liveMeta)
      };
    }
    const clarity = window.__utkStudioClarity;
    const line = liveStatus && typeof liveStatus.waitingLine === 'function'
      ? liveStatus.waitingLine(bot, liveMeta)
      : 'Waiting for a setup…';
    const checklist = clarity && typeof clarity.checklistHtml === 'function'
      ? clarity.checklistHtml(bot, liveMeta)
      : '';
    const pace = clarity && typeof clarity.paceCopy === 'function'
      ? clarity.paceCopy((bot && bot.lastCheck) || {})
      : null;
    const abandon = clarity && bot.id && typeof clarity.abandonHint === 'function'
      ? clarity.abandonHint(bot.id)
      : '';
    return {
      meta: String(bot.name || 'My bot'),
      html:
        '<div class="bot-mind-studio">' +
          checklist +
          '<p class="nyx-mind-said">' + esc(line) + '</p>' +
          (abandon ? '<p class="studio-wait-abandon">' + esc(abandon) + '</p>' : '') +
          (pace && pace.detail
            ? '<p class="studio-wait-pace">Backtest pace ' + esc(pace.title) + '. ' + esc(pace.detail) + '</p>'
            : '') +
          '<p class="studio-wait-pace">App can stay closed — the server keeps scanning.</p>' +
        '</div>'
    };
  }

  function resolveArea(key) {
    if (key === 'studio') {
      const house = (studioCtx && studioCtx.house) ||
        document.querySelector('.studio-desk-private .bot-signal-area') ||
        document.querySelector('#section-studio .bot-signal-area');
      return house && house.classList && house.classList.contains('bot-signal-area')
        ? house
        : (house && house.querySelector ? house.querySelector('.bot-signal-area') : null);
    }
    return areaForHouse(key);
  }

  function setOpen(key) {
    document.querySelectorAll('.bot-mind-note').forEach(function (n) {
      n.setAttribute('hidden', '');
    });
    document.querySelectorAll('.bot-mind-btn').forEach(function (b) {
      b.classList.remove('is-open');
      b.setAttribute('aria-expanded', 'false');
    });
    openKey = key || null;
    if (!openKey) return;
    const area = resolveArea(openKey);
    if (!area) {
      openKey = null;
      return;
    }
    const note = ensureNote(area);
    const btn = area.querySelector('.bot-mind-btn[data-mind-key="' + openKey + '"]');
    if (btn) {
      btn.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
    }
    if (note) note.removeAttribute('hidden');
    refreshOpen();
  }

  async function refreshOpen() {
    if (!openKey) return;
    const area = resolveArea(openKey);
    const note = area && ensureNote(area);
    if (!note) return;
    let payload;
    if (openKey === 'studio') payload = studioPayload();
    else payload = await housePayload(openKey);
    paintNote(note, payload);
  }

  function mountHouse() {
    HOUSE.forEach(function (h) {
      const area = areaForHouse(h.key);
      if (!area) return;
      mountBtn(area, h.key);
      ensureNote(area);
    });
  }

  function syncStudio(house, bot, opts) {
    opts = opts || {};
    if (!house) return;
    const area = house.querySelector
      ? (house.classList.contains('bot-signal-area') ? house : house.querySelector('.bot-signal-area'))
      : null;
    if (!area) return;
    studioCtx = {
      house: house,
      bot: bot || {},
      liveMeta: (opts && opts.liveMeta) || (bot && bot.liveMeta) || null
    };
    mountBtn(area, 'studio');
    ensureNote(area);
    if (openKey === 'studio') refreshOpen();
  }

  function onDocClick(ev) {
    if (!openKey) return;
    const t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('.bot-mind-note') || t.closest('.bot-mind-btn')) return;
    setOpen(null);
  }

  function boot() {
    // Hide legacy static NYX note if present — dynamic notes replace it.
    const legacy = document.getElementById('nyxMindNote');
    if (legacy) {
      try { legacy.setAttribute('hidden', ''); } catch (e) {}
    }
    mountHouse();
    let n = 0;
    const retry = setInterval(function () {
      n += 1;
      mountHouse();
      if (n > 24) clearInterval(retry);
    }, 250);
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && openKey) setOpen(null);
    });
    document.addEventListener('click', function (ev) {
      const sw = ev.target && ev.target.closest && ev.target.closest('.bot-switch-btn');
      if (!sw) return;
      mountHouse();
      setTimeout(function () {
        mountHouse();
        if (openKey && openKey !== 'studio') refreshOpen();
      }, 200);
    });
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      try {
        if (window.__utkAppPerf && window.__utkAppPerf.isResizing && window.__utkAppPerf.isResizing()) return;
        if (document.hidden) return;
      } catch (e) {}
      mountHouse();
      if (openKey) refreshOpen();
    }, 12000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.__utkBotMind = {
    syncStudio: syncStudio,
    open: setOpen,
    refresh: refreshOpen,
    mountHouse: mountHouse
  };
})();
