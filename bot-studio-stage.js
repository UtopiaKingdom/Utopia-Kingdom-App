/**
 * bot-studio-stage.js — Smooth enter for Studio desks and cook.
 * Load AFTER bot-studio.js.
 */
(function () {
  'use strict';

  function enter(root) {
    const el = root || document.getElementById('studioEditor');
    if (!el) return;
    const stage = el.querySelector('.studio-stage, .studio-global-pane, .studio-empty, .cook-flow');
    const targets = stage ? [stage] : [el];
    targets.forEach(function (node) {
      if (!node || !node.classList) return;
      node.classList.remove('is-stage-in');
      try { void node.offsetWidth; } catch (e) {}
      node.classList.add('is-stage-in');
    });
    var yours = el.querySelector('.studio-yours-pane');
    if (yours) {
      yours.classList.remove('is-stage-in');
      try { void yours.offsetWidth; } catch (e2) {}
      yours.classList.add('is-stage-in');
    }
    const page = document.getElementById('studioPage');
    if (page) page.classList.add('is-stage-ready');
  }

  window.__utkStudioStage = { enter: enter };
})();
