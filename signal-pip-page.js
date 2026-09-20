/**
 * Runs inside the frameless signal PiP window.
 * Renders a compact card from the in-app signal HTML clone.
 */
(function () {
  const { ipcRenderer } = require('electron');

  const params = new URLSearchParams(window.location.search);
  const botKey = String(params.get('bot') || 'LUMIX').toUpperCase();
  const TEXT_KEY = `utk_pip_text_${botKey}`;

  const shell = document.getElementById('pipShell');
  const body = document.getElementById('pipBody');
  const card = document.getElementById('pipCard');
  const botLabel = document.getElementById('pipBotLabel');
  const closeBtn = document.getElementById('pipCloseBtn');
  const minusBtn = document.getElementById('pipTextMinus');
  const plusBtn = document.getElementById('pipTextPlus');

  const GLOW = ['glow-preparing', 'glow-buy', 'glow-sell', 'glow-win', 'glow-loss', 'glow-cancelled'];
  const BASE_W = 300;
  const BASE_H = 210;
  const TEXT_MIN = 0.85;
  const TEXT_MAX = 1.5;
  const TEXT_STEP = 0.1;
  const MIN_W = 220;
  const MIN_H = 160;

  if (shell) shell.setAttribute('data-bot', botKey);
  if (botLabel) botLabel.textContent = botKey;

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadTextScale() {
    try {
      const n = Number(localStorage.getItem(TEXT_KEY));
      if (Number.isFinite(n) && n > 0) return clamp(n, TEXT_MIN, TEXT_MAX);
    } catch (e) {}
    return 1;
  }

  function saveTextScale(n) {
    try { localStorage.setItem(TEXT_KEY, String(n)); } catch (e) {}
  }

  let textScale = loadTextScale();

  function applyScales() {
    const w = Math.max(1, window.innerWidth || BASE_W);
    const h = Math.max(1, window.innerHeight || BASE_H);
    const scale = clamp(Math.min(w / BASE_W, h / BASE_H), 0.8, 1.7);
    document.documentElement.style.setProperty('--pip-scale', String(scale));
    document.documentElement.style.setProperty('--pip-text', String(textScale));
  }

  function rowMap(root) {
    const out = Object.create(null);
    root.querySelectorAll('.signal-row').forEach(function (row) {
      const label = String((row.querySelector('.label') || {}).textContent || '').trim().toLowerCase();
      const valueEl = row.querySelector('.value');
      if (!label || !valueEl) return;
      out[label] = {
        text: String(valueEl.textContent || '').trim(),
        className: String(valueEl.className || '')
      };
    });
    return out;
  }

  function prettySide(text) {
    const s = String(text || '').trim().toUpperCase();
    if (s === 'BUY' || s === 'CALL' || s === 'UP') return 'CALL';
    if (s === 'SELL' || s === 'PUT' || s === 'DOWN') return 'PUT';
    return String(text || '').trim();
  }

  function sideClass(text, className) {
    const s = String(text || '').toUpperCase();
    const c = String(className || '').toLowerCase();
    if (c.includes('buy') || c.includes('up') || s === 'CALL' || s === 'BUY' || s === 'UP') return 'is-call';
    if (c.includes('sell') || c.includes('down') || s === 'PUT' || s === 'SELL' || s === 'DOWN') return 'is-put';
    if (c.includes('win')) return 'is-call';
    if (c.includes('loss') || c.includes('lose')) return 'is-put';
    return 'is-neutral';
  }

  function pickNote(root) {
    const cancelled = root.querySelector('.signal-cancelled-banner');
    if (cancelled) {
      return { text: cancelled.textContent.trim(), kind: 'is-bad' };
    }
    const save = root.querySelector('.saving-signal-banner');
    if (save) {
      return { text: save.textContent.trim(), kind: 'is-save' };
    }
    const msg = root.querySelector('.saving-signal-message');
    if (msg) {
      return { text: msg.textContent.trim(), kind: 'is-warn' };
    }
    return null;
  }

  function parseSignalHtml(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '');
    const waiting = wrap.querySelector('.signal-card-waiting, .pip-empty, .signal-empty-title, .signal-empty');
    const hasRows = !!wrap.querySelector('.signal-row');
    if (!hasRows) {
      const waitText = (wrap.querySelector('.pip-empty, .signal-empty-title, .empty-title') || {}).textContent
        || 'Waiting for next signal';
      return { waiting: true, waitText: String(waitText).trim() || 'Waiting for next signal' };
    }

    const rows = rowMap(wrap);
    const countdownEl = wrap.querySelector('.countdown-value');
    const countdownLabel = String((wrap.querySelector('.countdown-label') || {}).textContent || '').trim() || 'Countdown';
    const phase = rows.phase ? rows.phase.text : '';
    const pair = rows.pair ? rows.pair.text : (rows.symbol ? rows.symbol.text : '');
    const action = rows.action || rows.side || rows.direction || null;
    const result = rows.result || null;
    const expiry = rows.expiry || rows.duration || null;
    const headline = result && result.text ? result : action;
    const note = pickNote(wrap);

    return {
      waiting: false,
      phase: phase,
      pair: pair,
      sideText: headline ? prettySide(headline.text) : '',
      sideClass: headline ? sideClass(headline.text, headline.className) : 'is-neutral',
      countdown: countdownEl ? String(countdownEl.textContent || '').trim() : '',
      countdownLabel: countdownLabel,
      expiry: expiry ? expiry.text : '',
      note: note
    };
  }

  function renderWait(text) {
    if (!card) return;
    card.className = 'pip-card is-wait';
    card.innerHTML = '<div class="pip-wait">' + esc(text || 'Waiting for next signal') + '</div>';
  }

  function renderSignal(data) {
    if (!card) return;
    if (!data || data.waiting) {
      renderWait(data && data.waitText);
      return;
    }

    const metaBits = [];
    if (data.phase) metaBits.push('<span>Phase <strong>' + esc(data.phase) + '</strong></span>');
    if (data.expiry) metaBits.push('<span>Expiry <strong>' + esc(data.expiry) + '</strong></span>');

    let html = '<div class="pip-top">';
    html += '<div class="pip-side ' + esc(data.sideClass || 'is-neutral') + '">' + esc(data.sideText || 'Signal') + '</div>';
    html += '<div class="pip-pair">' + esc(data.pair || '') + '</div>';
    html += '</div>';

    if (data.countdown) {
      html += '<div class="pip-countdown">';
      html += '<div class="pip-countdown-label">' + esc(data.countdownLabel || 'Countdown') + '</div>';
      html += '<div class="countdown-value pip-countdown-value">' + esc(data.countdown) + '</div>';
      html += '</div>';
    }

    if (metaBits.length) {
      html += '<div class="pip-meta">' + metaBits.join('') + '</div>';
    }

    if (data.note && data.note.text) {
      html += '<div class="pip-note ' + esc(data.note.kind || '') + '">' + esc(data.note.text) + '</div>';
    }

    card.className = 'pip-card';
    card.innerHTML = html;
  }

  function applyContent(payload) {
    payload = payload || {};
    if (payload.botKey && String(payload.botKey).toUpperCase() !== botKey) return;

    if (shell) {
      shell.classList.remove(...GLOW);
      if (payload.glowClass) shell.classList.add(payload.glowClass);
      shell.setAttribute('data-bot', botKey);
    }

    if (payload.countdownText != null && !payload.html) {
      const el = (card || body) && (card || body).querySelector('.countdown-value');
      if (el) {
        el.textContent = String(payload.countdownText);
        return;
      }
    }

    if (payload.html) {
      try {
        renderSignal(parseSignalHtml(payload.html));
      } catch (e) {
        renderWait('Waiting for next signal');
      }
    }
  }

  ipcRenderer.on('signal-pip-content', (_e, payload) => {
    try { applyContent(payload || {}); } catch (e) {}
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.invoke('signal-pip-close', { botKey }).catch(() => {});
    });
  }

  if (minusBtn) {
    minusBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      textScale = clamp(Math.round((textScale - TEXT_STEP) * 10) / 10, TEXT_MIN, TEXT_MAX);
      saveTextScale(textScale);
      applyScales();
    });
  }

  if (plusBtn) {
    plusBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      textScale = clamp(Math.round((textScale + TEXT_STEP) * 10) / 10, TEXT_MIN, TEXT_MAX);
      saveTextScale(textScale);
      applyScales();
    });
  }

  let resizing = null;

  function currentBounds() {
    return {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    };
  }

  function setBounds(bounds) {
    ipcRenderer.send('signal-pip-set-bounds', { botKey, bounds });
  }

  function applyResizeDelta(screenX, screenY) {
    if (!resizing) return;
    const dx = screenX - resizing.startX;
    const dy = screenY - resizing.startY;
    const b = Object.assign({}, resizing.startBounds);
    const edge = resizing.edge;

    if (edge.includes('e')) b.width = Math.max(MIN_W, resizing.startBounds.width + dx);
    if (edge.includes('s')) b.height = Math.max(MIN_H, resizing.startBounds.height + dy);
    if (edge.includes('w')) {
      const nextW = Math.max(MIN_W, resizing.startBounds.width - dx);
      b.x = resizing.startBounds.x + (resizing.startBounds.width - nextW);
      b.width = nextW;
    }
    if (edge.includes('n')) {
      const nextH = Math.max(MIN_H, resizing.startBounds.height - dy);
      b.y = resizing.startBounds.y + (resizing.startBounds.height - nextH);
      b.height = nextH;
    }
    setBounds(b);
  }

  function onResizeMove(e) {
    applyResizeDelta(e.screenX, e.screenY);
  }

  function onResizeEnd() {
    if (!resizing) return;
    resizing = null;
    document.body.classList.remove('is-resizing');
    window.removeEventListener('pointermove', onResizeMove, true);
    window.removeEventListener('pointerup', onResizeEnd, true);
    window.removeEventListener('pointercancel', onResizeEnd, true);
    emitBounds();
    applyScales();
  }

  document.querySelectorAll('.pip-resize').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      resizing = {
        edge: String(el.getAttribute('data-edge') || ''),
        startX: e.screenX,
        startY: e.screenY,
        startBounds: currentBounds(),
      };
      document.body.classList.add('is-resizing');
      window.addEventListener('pointermove', onResizeMove, true);
      window.addEventListener('pointerup', onResizeEnd, true);
      window.addEventListener('pointercancel', onResizeEnd, true);
    });
  });

  let boundsTimer = null;
  function emitBounds() {
    try {
      ipcRenderer.send('signal-pip-bounds', {
        botKey,
        bounds: currentBounds(),
      });
    } catch (e) {}
  }

  window.addEventListener('resize', () => {
    applyScales();
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(emitBounds, 250);
  });

  applyScales();
})();
