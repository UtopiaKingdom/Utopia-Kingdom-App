/*
 bot-signal-fx.js
 Smooth signal card appear / disappear / phase swap.
 Fast + clean (not instant, not sluggish).
*/
(function () {
 'use strict';

 const DURATION = 200;
 const timers = Object.create(null);
 const lastPhase = Object.create(null);
 const gen = Object.create(null);

 function bumpGen(botKey) {
  gen[botKey] = (gen[botKey] || 0) + 1;
  return gen[botKey];
 }

 function prefersReducedMotion() {
 return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 }

 function clearTimer(botKey) {
 if (timers[botKey]) {
 clearTimeout(timers[botKey]);
 timers[botKey] = null;
 }
 }

 function isShowing(display) {
 if (!display) return false;
 if (display.classList.contains('utk-sig-hidden')) return false;
 if (display.style.display === 'none') return false;
 return !!(display.innerHTML && display.innerHTML.trim());
 }

 function emptyVisible(empty) {
 if (!empty) return false;
 if (empty.classList.contains('utk-sig-hidden')) return false;
 if (empty.style.display === 'none') return false;
 return true;
 }

 function prepareVisible(el) {
 if (!el) return;
 el.classList.remove('utk-sig-hidden', 'utk-sig-out', 'utk-sig-in');
 el.style.display = '';
 el.style.visibility = 'visible';
 el.style.pointerEvents = '';
 el.classList.add('utk-sig-prep');
 void el.offsetWidth;
 el.classList.remove('utk-sig-prep');
 el.classList.add('utk-sig-in');
 }

 function prepareHidden(el, soft) {
 if (!el) return;
 el.classList.remove('utk-sig-in', 'utk-sig-prep');
 if (soft) {
 el.classList.add('utk-sig-out');
 } else {
 el.classList.add('utk-sig-hidden');
 el.classList.remove('utk-sig-out');
 el.style.display = 'none';
 }
 }

 function animateCardEnter(card) {
 if (!card || prefersReducedMotion()) return;
 card.classList.remove('utk-sig-card-enter', 'utk-sig-card-swap');
 void card.offsetWidth;
 card.classList.add('utk-sig-card-enter');
 }

 /**
 * @param {string} botKey
 * @param {HTMLElement} display
 * @param {HTMLElement|null} empty
 * @param {{ fromEmpty?: boolean, phase?: string }} [opts]
 */
 function reveal(botKey, display, empty, opts) {
 if (!display) return;
 bumpGen(botKey);
 const fromEmpty = !!(opts && opts.fromEmpty);
 const phase = String((opts && opts.phase) || '').trim();
 const prevPhase = lastPhase[botKey] || '';
 const phaseChanged = !!(phase && prevPhase && phase !== prevPhase);
 if (phase) lastPhase[botKey] = phase;

 // Same-phase tick (countdown): keep steady, no re-fade.
 if (!fromEmpty && !phaseChanged && isShowing(display) && !emptyVisible(empty)) {
 display.classList.remove('utk-sig-hidden', 'utk-sig-out', 'utk-sig-prep');
 display.style.display = '';
 display.style.visibility = 'visible';
 return;
 }

 clearTimer(botKey);

 if (prefersReducedMotion()) {
 if (empty) {
 empty.classList.add('utk-sig-hidden');
 empty.classList.remove('utk-sig-out', 'utk-sig-in');
 empty.style.display = 'none';
 }
 display.classList.remove('utk-sig-hidden', 'utk-sig-out', 'utk-sig-prep');
 display.style.display = '';
 display.style.visibility = 'visible';
 display.classList.add('utk-sig-in');
 const card = display.querySelector('.signal-card');
 if (card) card.classList.add('utk-sig-card-enter');
 return;
 }

 // Phase-to-phase: soft swap on the card (out then in feel via CSS class).
 if (phaseChanged && isShowing(display) && !fromEmpty) {
 display.classList.remove('utk-sig-hidden', 'utk-sig-out', 'utk-sig-prep');
 display.style.display = '';
 display.style.visibility = 'visible';
 display.classList.add('utk-sig-in');
 const card = display.querySelector('.signal-card');
 if (card) {
 card.classList.remove('utk-sig-card-enter');
 void card.offsetWidth;
 card.classList.add('utk-sig-card-swap');
 }
 if (empty) {
 empty.classList.add('utk-sig-hidden');
 empty.style.display = 'none';
 }
 return;
 }

 if (empty && emptyVisible(empty)) {
 prepareHidden(empty, true);
 timers[botKey] = setTimeout(() => {
 empty.classList.add('utk-sig-hidden');
 empty.classList.remove('utk-sig-out');
 empty.style.display = 'none';
 timers[botKey] = null;
 }, DURATION);
 } else if (empty) {
 empty.classList.add('utk-sig-hidden');
 empty.style.display = 'none';
 }

 display.style.display = '';
 display.style.visibility = 'visible';
 display.classList.remove('utk-sig-hidden');
 prepareVisible(display);
 animateCardEnter(display.querySelector('.signal-card'));
 }

 function hide(botKey, display, empty, done) {
 clearTimer(botKey);
 lastPhase[botKey] = '';
 const hideGen = bumpGen(botKey);

 const finish = () => {
 if (gen[botKey] !== hideGen) return;
 try {
 if (typeof done === 'function') done();
 } catch (e) {}
 if (empty) {
 empty.style.display = '';
 empty.classList.remove('utk-sig-hidden');
 if (!prefersReducedMotion()) prepareVisible(empty);
 else empty.classList.remove('utk-sig-out', 'utk-sig-in', 'utk-sig-prep');
 }
 timers[botKey] = null;
 };

 if (!display || prefersReducedMotion() || !isShowing(display)) {
 if (display) {
 display.classList.add('utk-sig-hidden');
 display.classList.remove('utk-sig-in', 'utk-sig-out');
 }
 finish();
 return;
 }

 prepareHidden(display, true);
 timers[botKey] = setTimeout(() => {
 if (gen[botKey] !== hideGen) {
 timers[botKey] = null;
 return;
 }
 display.classList.add('utk-sig-hidden');
 display.classList.remove('utk-sig-out', 'utk-sig-in');
 display.style.display = 'none';
 display.innerHTML = '';
 finish();
 }, DURATION);
 }

 window.utkSignalFx = {
 reveal,
 hide,
 isShowing,
 duration: DURATION,
 resetPhase(botKey) {
 lastPhase[botKey] = '';
 },
 };
})();
