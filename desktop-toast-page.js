(function () {
  'use strict';

  const { ipcRenderer } = require('electron');
  const toast = document.getElementById('toast');
  const titleEl = document.getElementById('toastTitle');
  const bodyEl = document.getElementById('toastBody');
  const kickerEl = document.getElementById('toastKicker');
  const sideEl = document.getElementById('toastSide');
  const barEl = document.getElementById('toastBar');
  const closeEl = document.getElementById('toastClose');
  const logoEl = document.getElementById('toastLogo');
  let toastId = 0;

  const HOUSE = {
    LUMIX: { rgb: '122, 162, 255', hex: '#7aa2ff' },
    MIRAX: { rgb: '155, 123, 255', hex: '#9b7bff' },
    NYX: { rgb: '94, 225, 208', hex: '#5ee1d0' }
  };

  function apply(payload) {
    payload = payload || {};
    toastId = Number(payload.id) || 0;

    const bot = String(payload.botName || '').trim();
    const side = String(payload.side || '').trim().toUpperCase();
    const title = String(payload.title || (bot ? bot + ' started a trade' : 'Trading Signal'));
    const body = String(payload.body || 'New signal received');
    const dur = Number(payload.durationMs);
    const hold = Number.isFinite(dur) && dur > 0 ? dur : 5200;

    titleEl.textContent = title;
    bodyEl.textContent = body;
    kickerEl.textContent = bot || 'Utopia Kingdom';

    if (logoEl) {
      const logoUrl = String(payload.logoUrl || '').trim();
      if (logoUrl) logoEl.src = logoUrl;
    }

    const house = HOUSE[String(bot).toUpperCase()];
    const accent = house ? house.hex : String(payload.accent || '').trim() || '#5a6aff';
    const accentRgb = house ? house.rgb : String(payload.accentRgb || '').trim() || '90, 106, 255';
    document.documentElement.style.setProperty('--toast-accent', accent);
    document.documentElement.style.setProperty('--toast-accent-rgb', accentRgb);
    document.documentElement.style.setProperty('--dur', hold + 'ms');

    if (side === 'CALL' || side === 'PUT') {
      toast.setAttribute('data-side', side);
      sideEl.hidden = false;
      sideEl.textContent = side;
    } else {
      toast.setAttribute('data-side', '');
      sideEl.hidden = true;
      sideEl.textContent = '';
    }

    if (barEl) {
      barEl.style.animation = 'none';
      void barEl.offsetWidth;
      barEl.style.animation = '';
    }
  }

  ipcRenderer.on('desktop-toast-content', (_event, payload) => apply(payload));
  ipcRenderer.on('desktop-toast-out', () => {
    toast.classList.add('is-out');
  });

  toast.addEventListener('click', (e) => {
    if (closeEl.contains(e.target)) return;
    ipcRenderer.send('desktop-toast-click', toastId);
  });

  closeEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toast.classList.add('is-out');
    ipcRenderer.send('desktop-toast-dismiss', toastId);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ipcRenderer.send('desktop-toast-dismiss', toastId);
  });
})();
