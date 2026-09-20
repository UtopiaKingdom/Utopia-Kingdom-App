/*

 bot-switch-fx.js

 Fast app-colored wipe between LUMIX / MIRAX.

 Fade to app bg → swap section → fade back in.

*/

(function () {

 'use strict';



 const FADE_OUT_MS = 50;

 const HOLD_MS = 10;

 const FADE_IN_MS = 65;

 const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';



 let running = null;

 let overlayEl = null;



 function prefersReducedMotion() {

 try {

 return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

 } catch (e) {

 return false;

 }

 }



 function getOverlay() {

 if (overlayEl && overlayEl.isConnected) return overlayEl;

 const host = document.querySelector('.main-content') || document.body;

 const el = document.createElement('div');

 el.className = 'utk-bot-blackout';

 el.setAttribute('aria-hidden', 'true');

 host.appendChild(el);

 overlayEl = el;

 return el;

 }



 function hardSwap(currentEl, targetEl) {

 document.querySelectorAll('.section.active').forEach((el) => {

 if (el !== targetEl) el.classList.remove('active', 'leaving', 'entering');

 });

 if (targetEl) {

 targetEl.classList.add('active');

 targetEl.classList.remove('leaving', 'entering');

 }

 }



 function syncChrome(botId) {

 try {

 document.querySelectorAll('.menu-item').forEach((el) => el.classList.remove('active'));

 const menuBots = document.getElementById('menu-bots');

 if (menuBots) menuBots.classList.add('active');

 const userCard = document.getElementById('user-card') || document.querySelector('.user-card');

 if (userCard) userCard.classList.remove('active');

 } catch (e) {}



 try {

 document.querySelectorAll('.bot-switch-btn').forEach((btn) => {

 btn.classList.toggle('is-active', btn.getAttribute('data-target') === botId);

 });

 } catch (e) {}



 try {

 const scroller = document.querySelector('.main-content');

 if (scroller) scroller.scrollTop = 0;

 } catch (e) {}

 }



 function wait(ms) {

 return new Promise((resolve) => setTimeout(resolve, ms));

 }



 function setVeil(opacity, durationMs) {

 const el = getOverlay();

 el.style.pointerEvents = opacity > 0 ? 'auto' : 'none';

 el.style.transition = `opacity ${durationMs}ms ${EASE}`;

 el.style.opacity = String(opacity);

 return wait(durationMs);

 }



 async function animateSwap(currentEl, targetEl) {

 if (!targetEl || currentEl === targetEl) return;



 if (running && typeof running.cancel === 'function') {

 try { running.cancel(); } catch (e) {}

 }



 let cancelled = false;

 const cancel = () => {

 cancelled = true;

 try {

 if (overlayEl) {

 overlayEl.style.transition = 'none';

 overlayEl.style.opacity = '0';

 overlayEl.style.pointerEvents = 'none';

 }

 } catch (e) {}

 running = null;

 };

 running = { cancel };



 if (prefersReducedMotion()) {

 hardSwap(currentEl, targetEl);

 cancel();

 return;

 }



 try {

 await setVeil(1, FADE_OUT_MS);

 if (cancelled) return;



 hardSwap(currentEl, targetEl);

 await wait(HOLD_MS);

 if (cancelled) return;



 await setVeil(0, FADE_IN_MS);

 } catch (e) {

 hardSwap(currentEl, targetEl);

 try {

 if (overlayEl) {

 overlayEl.style.transition = 'none';

 overlayEl.style.opacity = '0';

 overlayEl.style.pointerEvents = 'none';

 }

 } catch (err) {}

 } finally {

 if (!cancelled) running = null;

 }

 }



 function onSwitchClick(ev) {

 const btn = ev.target && ev.target.closest ? ev.target.closest('.bot-switch-btn') : null;

 if (!btn) return;

 if (btn.hasAttribute('hidden')) return;

 const targetId = btn.getAttribute('data-target');

 if (!targetId) return;

 // Access gate must win over this capture listener (it registers first + stopImmediate).
 try {
   if (!window.__utkAccessBypass && window.__utkAccessGate &&
       typeof window.__utkAccessGate.guardHouseBot === 'function') {
     if (!window.__utkAccessGate.guardHouseBot(targetId)) {
       ev.preventDefault();
       ev.stopPropagation();
       if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
       return;
     }
   }
 } catch (e) {}

 ev.preventDefault();

 ev.stopPropagation();

 if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();



 const current = document.querySelector('.section.active');

 const target = document.getElementById('section-' + targetId);

 if (!target) return;



 syncChrome(targetId);

 if (current === target) return;



 animateSwap(current, target);

 }



 function resetBotSections() {

 ['section-bot1', 'section-bot2', 'section-bot3'].forEach((id) => {

 const el = document.getElementById(id);

 if (!el) return;

 el.style.visibility = '';

 el.style.opacity = '';

 el.style.transform = '';

 el.style.position = '';

 el.classList.remove(

 'utk-swap-layer',

 'utk-swap-out',

 'utk-swap-in',

 'cinema-leave',

 'cinema-enter',

 'cinema-leave-left',

 'cinema-leave-right',

 'cinema-enter-left',

 'cinema-enter-right',

 'entering',

 'leaving'

 );

 });

 try {

 document.querySelector('.main-content')?.classList.remove('utk-bot-swapping');

 } catch (e) {}

 try {

 if (overlayEl) {

 overlayEl.style.transition = 'none';

 overlayEl.style.opacity = '0';

 overlayEl.style.pointerEvents = 'none';

 }

 } catch (e) {}

 }



 function cancel() {

 if (running && typeof running.cancel === 'function') {

 try { running.cancel(); } catch (e) {}

 }

 running = null;

 resetBotSections();

 }



 document.addEventListener('click', onSwitchClick, true);



 window.utkBotTransitions = {

 goTo(botId) {

 const id = String(botId || '');

 if (!id) return;

 const target = document.getElementById('section-' + id);

 if (!target) return;

 try {
   if (!window.__utkAccessBypass && window.__utkAccessGate &&
       typeof window.__utkAccessGate.guardHouseBot === 'function') {
     if (!window.__utkAccessGate.guardHouseBot(id)) return;
   }
 } catch (e) {}

 try {
   if (window.utkSectionFx && typeof window.utkSectionFx.cancel === 'function') {
     window.utkSectionFx.cancel();
   }
 } catch (e2) {}

 const current = document.querySelector('.section.active');

 syncChrome(id);

 if (current === target) return;

 animateSwap(current, target);

 },

 cancel,

 resetBotSections

 };

})();


