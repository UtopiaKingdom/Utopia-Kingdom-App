/**
 * bot-studio-tips.js — Hold or hover to learn. Load AFTER cook-bind.
 */
(function () {
  'use strict';

  var HOLD_MS = 420;
  var HOVER_MS = 520;
  var MOVE_PX = 10;

  var holdTimer = null;
  var hoverTimer = null;
  var holdEl = null;
  var hoverEl = null;
  var startX = 0;
  var startY = 0;
  var pinned = false;
  var suppressClick = false;
  var layer = null;
  var source = null;

  function closestTip(t) {
    if (!t || !t.closest) return null;
    if (t.closest('#studioTipLayer')) return null;
    return t.closest('[data-tip]');
  }

  function inStudio(t) {
    var root = document.getElementById('section-studio');
    return !!(root && t && root.contains(t));
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.getElementById('studioTipLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'studioTipLayer';
      layer.hidden = true;
      layer.setAttribute('role', 'dialog');
      document.body.appendChild(layer);
    }
    return layer;
  }

  function clearHold() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (holdEl) {
      try { holdEl.classList.remove('is-tip-hold'); } catch (e) {}
      holdEl = null;
    }
  }

  function clearHover() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hoverEl = null;
  }

  function hideTip(force) {
    if (pinned && !force) return;
    pinned = false;
    clearHold();
    clearHover();
    if (source) {
      try { source.classList.remove('is-tip-open'); } catch (e) {}
      source = null;
    }
    var el = ensureLayer();
    el.hidden = true;
    el.innerHTML = '';
    el.className = '';
    el.removeAttribute('data-pinned');
  }

  function placeLayer(anchor) {
    var el = ensureLayer();
    var r = anchor.getBoundingClientRect();
    var w = el.offsetWidth || 320;
    var h = el.offsetHeight || 160;
    var pad = 12;
    var left = r.left + (r.width / 2) - (w / 2);
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    var top = r.bottom + 10;
    if (top + h > window.innerHeight - pad) {
      top = r.top - h - 10;
    }
    if (top < pad) top = pad;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  function showTip(el, pin) {
    if (!el || !el.isConnected) return;
    var title = el.getAttribute('data-tip-title') || '';
    var body = el.getAttribute('data-tip-body') || '';
    var when = el.getAttribute('data-tip-when') || '';
    if (!title && !body) return;

    if (source && source !== el) {
      try { source.classList.remove('is-tip-open'); } catch (e) {}
    }
    source = el;
    el.classList.add('is-tip-open');
    pinned = !!pin;

    var node = ensureLayer();
    node.className = 'is-on' + (pinned ? ' is-pinned' : '');
    if (pinned) node.setAttribute('data-pinned', '1');
    else node.removeAttribute('data-pinned');
    node.innerHTML =
      '<p class="studio-tip-kicker">' + (pinned ? 'Hold to learn' : 'What this does') + '</p>' +
      (title ? '<h3 class="studio-tip-title"></h3>' : '') +
      (body ? '<p class="studio-tip-body"></p>' : '') +
      (when ? '<p class="studio-tip-when"></p>' : '') +
      (pinned ? '<p class="studio-tip-dismiss">Tap outside to close</p>' : '');
    var h = node.querySelector('.studio-tip-title');
    var b = node.querySelector('.studio-tip-body');
    var w = node.querySelector('.studio-tip-when');
    if (h) h.textContent = title;
    if (b) b.textContent = body;
    if (w) w.textContent = 'Best when  ' + when;
    node.hidden = false;
    placeLayer(el);
  }

  function onPointerDown(ev) {
    var t = ev.target;
    if (layer && !layer.hidden && layer.contains(t)) return;
    var el = closestTip(t);
    if (!el || !inStudio(el)) {
      if (pinned) hideTip(true);
      else if (layer && !layer.hidden && !(source && source.contains(t))) hideTip(true);
      return;
    }
    if (t && t.closest && t.closest('input, textarea, select, #studioName, .studio-name-field, #studioNameRow')) return;

    clearHold();
    holdEl = el;
    startX = ev.clientX || 0;
    startY = ev.clientY || 0;
    el.classList.add('is-tip-hold');
    holdTimer = setTimeout(function () {
      holdTimer = null;
      if (!holdEl || !holdEl.isConnected) return;
      showTip(holdEl, true);
      suppressClick = true;
      try { holdEl.classList.remove('is-tip-hold'); } catch (e) {}
    }, HOLD_MS);
  }

  function onPointerMove(ev) {
    if (!holdTimer || !holdEl) return;
    var dx = (ev.clientX || 0) - startX;
    var dy = (ev.clientY || 0) - startY;
    if ((dx * dx + dy * dy) > (MOVE_PX * MOVE_PX)) clearHold();
  }

  function onPointerUp() {
    clearHold();
  }

  function onPointerEnter(ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('input, textarea, select, #studioName, .studio-name-field, #studioNameRow')) return;
    var el = closestTip(t);
    if (!el || !inStudio(el)) return;
    if (pinned && source === el) return;
    if (hoverEl === el) return;
    clearHover();
    hoverEl = el;
    hoverTimer = setTimeout(function () {
      hoverTimer = null;
      if (pinned) return;
      if (hoverEl && hoverEl.isConnected) showTip(hoverEl, false);
    }, HOVER_MS);
  }

  function stillInside(rel) {
    if (!rel || !rel.nodeType) return false;
    if (source && (rel === source || (source.contains && source.contains(rel)))) return true;
    if (layer && layer.contains && layer.contains(rel)) return true;
    return false;
  }

  function onPointerLeave(ev) {
    if (pinned) return;
    if (stillInside(ev.relatedTarget)) return;
    var el = closestTip(ev.target);
    if (hoverEl === el) clearHover();
    if (source) hideTip(true);
  }

  function onKey(ev) {
    if (ev.key === 'Escape') hideTip(true);
  }

  function onScroll() {
    // Only work when a tip is open — document capture scroll used to fire
    // on every nested panel scroll and made the whole app feel laggy.
    if (!layer || layer.hidden) return;
    if (window.__utkScrollSmooth && window.__utkScrollSmooth.isScrolling && window.__utkScrollSmooth.isScrolling()) {
      hideTip(true);
      return;
    }
    hideTip(true);
  }

  function onWheel() {
    // Hover tips must not steal the wheel — dismiss and let the page scroll.
    if (!layer || layer.hidden) return;
    if (pinned) return;
    hideTip(true);
  }

  function onResize() {
    if (source && layer && !layer.hidden) placeLayer(source);
  }

  function blockEvent(ev) {
    if (!suppressClick) return false;
    suppressClick = false;
    try {
      ev.preventDefault();
      ev.stopPropagation();
      ev.__utkStudioHandled = true;
    } catch (e) {}
    return true;
  }

  function bind() {
    if (document.documentElement.getAttribute('data-utk-studio-tips') === '1') return;
    document.documentElement.setAttribute('data-utk-studio-tips', '1');
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    document.addEventListener('mouseover', onPointerEnter, true);
    document.addEventListener('mouseout', onPointerLeave, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.addEventListener('wheel', onWheel, { passive: true, capture: true });
    ensureLayer();
  }

  window.__utkStudioTips = {
    blockEvent: blockEvent,
    hide: function () { hideTip(true); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
