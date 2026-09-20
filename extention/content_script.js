// content_script.js
// Single-fire click implementation:
// - Instance guard to prevent duplicate instances
// - Per-page seen-ids dedupe
// - Per-element cooldown
// - Global action lock to prevent multiple actions in quick succession
// - Dispatches pointerdown/pointerup + a single 'click' MouseEvent (no el.click())

(function() {
  'use strict';

  // Instance guard
  if (window.__tradingExtInjected) {
    console.log('[trading-ext] content_script: already injected, exiting duplicate instance');
    return;
  }
  window.__tradingExtInjected = true;

  try { if (window.top !== window) { console.log('[trading-ext] in iframe, exiting'); return; } } catch (e) {}

  function xpathFirst(xpath) {
    try {
      const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r && r.singleNodeValue ? r.singleNodeValue : null;
    } catch (e) {
      return null;
    }
  }

  // PocketOption XPaths (keep your working ones)
  const BUY_XPATH = "/html/body/div[4]/div[2]/div[4]/div/div/div/div/div/div[5]/div/div/div[2]/div/div[2]/div[2]/div[1]/a";
  const SELL_XPATH = "/html/body/div[4]/div[2]/div[4]/div/div/div/div/div/div[5]/div/div/div[2]/div/div[2]/div[2]/div[2]/a";

  const buyRoot = xpathFirst(BUY_XPATH);
  const sellRoot = xpathFirst(SELL_XPATH);
  if (!buyRoot && !sellRoot) {
    console.log('[trading-ext] content_script: no target elements found, exiting');
    return;
  }

  // Per-element cooldown
  const CLICK_COOLDOWN_MS = 800;
  const lastClickAt = new WeakMap();

  // Per-page seen ids cache
  const ACTION_ID_TTL_MS = 5 * 60 * 1000; // 5 minutes
  if (!window.__tradingExtSeenIds) window.__tradingExtSeenIds = new Map();

  // Global action lock to avoid any overlapping actions on the page
  const GLOBAL_ACTION_LOCK_MS = 1200;
  if (!window.__tradingExtLastActionAt) window.__tradingExtLastActionAt = 0;

  // Periodic cleanup (on page)
  setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of window.__tradingExtSeenIds.entries()) {
      if ((now - ts) > ACTION_ID_TTL_MS) window.__tradingExtSeenIds.delete(id);
    }
    // No need to cleanup lastClickAt for WeakMap
  }, 60 * 1000);

  function findClickableDescendant(root) {
    if (!root) return null;
    const selectors = ['a[href]', 'button', '[role="button"]', '.btn', '.button', 'input[type="button"]', 'input[type="submit"]'];
    for (const sel of selectors) {
      try {
        const found = root.querySelector(sel);
        if (found) return found;
      } catch {}
    }
    if (root.tagName && /^(A|BUTTON|INPUT)$/i.test(root.tagName)) return root;
    return root;
  }

  function performSingleClick(el) {
    if (!el) return false;

    // element-level cooldown
    const last = lastClickAt.get(el);
    if (last && (Date.now() - last) < CLICK_COOLDOWN_MS) {
      console.log('[trading-ext] click suppressed by element cooldown');
      return false;
    }

    // global action lock
    const now = Date.now();
    if ((now - window.__tradingExtLastActionAt) < GLOBAL_ACTION_LOCK_MS) {
      console.log('[trading-ext] click suppressed by global action lock');
      return false;
    }
    window.__tradingExtLastActionAt = now;

    try { el.scrollIntoView({ block:'center', inline:'center' }); } catch {}
    try { el.focus && el.focus(); } catch {}

    try {
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width/2);
      const y = Math.round(rect.top + rect.height/2);

      // Dispatch pointer events then a single click event (no el.click())
      const pd = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed:true, pointerType:'mouse', clientX:x, clientY:y });
      const pu = new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed:true, pointerType:'mouse', clientX:x, clientY:y });
      el.dispatchEvent(pd);
      el.dispatchEvent(pu);

      const clickEv = new MouseEvent('click', { bubbles:true, cancelable:true, composed:true, clientX:x, clientY:y });
      el.dispatchEvent(clickEv);

      lastClickAt.set(el, Date.now());
      console.log('[trading-ext] single click attempted on', el.tagName, el.className || '');
      return true;
    } catch (e) {
      console.warn('[trading-ext] performSingleClick failed', e);
      try { lastClickAt.set(el, Date.now()); return true; } catch { return false; }
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      const action = (request && (request.action || request.type)) || '';
      const id = request && request.id ? String(request.id) : null;
      const verified = request && request.verified === true; // FIREWALL: Check verified flag
      
      if (!action) { sendResponse({ success: false, reason: 'no action' }); return true; }

      // FIREWALL: Block unverified requests
      if (!verified) {
        console.error('[trading-ext] FIREWALL: Trade request rejected - not verified');
        sendResponse({ success: false, reason: 'not_verified' });
        return true;
      }

      // If id present and seen, ignore
      if (id && window.__tradingExtSeenIds.has(id)) {
        console.log('[trading-ext] message id already processed on page, ignoring', id);
        sendResponse({ success: false, reason: 'id_seen' });
        return true;
      }

      // mark id as seen (so duplicates that arrive after will be ignored)
      if (id) window.__tradingExtSeenIds.set(id, Date.now());

      const act = String(action).toLowerCase();
      let root = null;
      if (act === 'buy') root = buyRoot || xpathFirst(BUY_XPATH);
      else if (act === 'sell') root = sellRoot || xpathFirst(SELL_XPATH);

      if (!root) {
        sendResponse({ success: false, reason: 'not found' });
        return true;
      }

      const clickable = findClickableDescendant(root);
      const ok = performSingleClick(clickable);
      sendResponse({ success: !!ok });
      return true;
    } catch (err) {
      console.error('[trading-ext] message handler error', err);
      try { sendResponse({ success: false, error: String(err) }); } catch {}
      return true;
    }
  });

  console.log('[trading-ext] content_script loaded and ready on this page');
})();