/**
 * saving-signal-custom-ladder.js — 2x / 4x / Custom ladders for Saving Signals.
 * Load AFTER renderer.js + saving-signal-stake.js.
 */
(function () {
  'use strict';

  var FIXED = {
    '2x': [1, 2, 4, 10, 20],
    '4x': [1, 4, 7, 16, 44]
  };
  var DEFAULT_CUSTOM = [1, 2, 5, 10, 25];
  var STEP_NAMES = ['Entry', 'S1', 'S2', 'S3', 'S4'];
  var BOT_IDS = ['bot1', 'bot2', 'bot3', 'studio'];
  var BOT_KEYS = { bot1: 'LUMIX', bot2: 'MIRAX', bot3: 'NYX', studio: 'STUDIO' };
  var modeByBot = Object.create(null);
  var customByBot = Object.create(null);

  function normalizeLadder(arr) {
    var src = Array.isArray(arr) ? arr : DEFAULT_CUSTOM;
    var out = [];
    for (var i = 0; i < 5; i++) {
      var n = Math.round(Number(src[i]));
      if (!Number.isFinite(n) || n < 1) n = DEFAULT_CUSTOM[i];
      if (n > 500) n = 500;
      out.push(n);
    }
    return out;
  }

  function modeKey(botId) {
    return 'savingSignalMode:' + botId;
  }

  function ladderKey(botId) {
    return 'savingSignalCustomLadder:' + botId;
  }

  function normalizeMode(mode) {
    var m = String(mode || '2x').toLowerCase();
    if (m === '4x' || m === 'custom') return m;
    return '2x';
  }

  function readStoredMode(botId) {
    try {
      return normalizeMode(window.localStorage.getItem(modeKey(botId)));
    } catch (e) {
      return '2x';
    }
  }

  function readStoredCustom(botId) {
    try {
      var raw = window.localStorage.getItem(ladderKey(botId));
      if (!raw) return DEFAULT_CUSTOM.slice();
      return normalizeLadder(JSON.parse(raw));
    } catch (e) {
      return DEFAULT_CUSTOM.slice();
    }
  }

  function writeMode(botId, mode) {
    mode = normalizeMode(mode);
    modeByBot[botId] = mode;
    try { window.localStorage.setItem(modeKey(botId), mode); } catch (e) {}
  }

  function writeCustom(botId, ladder) {
    customByBot[botId] = normalizeLadder(ladder);
    try {
      window.localStorage.setItem(ladderKey(botId), JSON.stringify(customByBot[botId]));
    } catch (e) {}
  }

  function botIdOf(botKey) {
    try {
      if (typeof botIdMap !== 'undefined' && botIdMap[botKey]) return botIdMap[botKey];
    } catch (e) {}
    var k = String(botKey || '').toUpperCase();
    if (k === 'LUMIX') return 'bot1';
    if (k === 'MIRAX') return 'bot2';
    if (k === 'NYX') return 'bot3';
    if (k === 'STUDIO') return 'studio';
    if (BOT_IDS.indexOf(String(botKey || '').toLowerCase()) >= 0) return String(botKey || '').toLowerCase();
    return null;
  }

  function buildGridHtml(ladder) {
    var values = normalizeLadder(ladder);
    return (
      '<div class="saving-ladder-panel">' +
      '<div class="saving-ladder-grid" role="group" aria-label="Custom ladder">' +
      STEP_NAMES.map(function (name, i) {
        return (
          '<div class="saving-ladder-cell">' +
            '<div class="saving-ladder-cell-label">' + name + '</div>' +
            '<div class="saving-ladder-cell-input">' +
              '<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" data-saving-mg="' + i + '" value="' + values[i] + '" aria-label="' + name + '" />' +
              '<span class="saving-ladder-cell-x">×</span>' +
            '</div>' +
          '</div>'
        );
      }).join('') +
      '</div></div>'
    );
  }

  /** One clean row only — wipe duplicates / old markup. */
  function ensureCustomRow(botId) {
    var options = document.getElementById('savingSignalOptions-' + botId);
    var modeRoot = document.getElementById('savingSignalMode-' + botId);
    var host = (modeRoot && modeRoot.parentElement) || options;
    if (!host) return null;

    var rows = host.querySelectorAll('[id="savingLadderCustom-' + botId + '"], .saving-ladder-custom');
    var customRow = document.getElementById('savingLadderCustom-' + botId);
    if (!customRow) {
      customRow = document.createElement('div');
      customRow.id = 'savingLadderCustom-' + botId;
      host.appendChild(customRow);
    }
    // Remove any extra copies (invalid duplicate ids / leftover markup).
    Array.prototype.forEach.call(rows, function (el) {
      if (el !== customRow) el.parentNode && el.parentNode.removeChild(el);
    });
    Array.prototype.forEach.call(host.querySelectorAll('.saving-ladder-custom'), function (el) {
      if (el !== customRow && el.id === 'savingLadderCustom-' + botId) {
        el.parentNode && el.parentNode.removeChild(el);
      }
    });

    customRow.className = 'saving-ladder-custom';
    customRow.id = 'savingLadderCustom-' + botId;
    customRow.innerHTML = buildGridHtml(customByBot[botId] || readStoredCustom(botId));
    customRow.__utkLadderBound = false;
    return customRow;
  }

  function ladderForBotId(botId) {
    if (!botId) return FIXED['2x'].slice();
    var mode = modeByBot[botId] || readStoredMode(botId);
    if (mode === 'custom') {
      return (customByBot[botId] || readStoredCustom(botId)).slice();
    }
    return (FIXED[mode] || FIXED['2x']).slice();
  }

  function configForBotId(botId) {
    var ladder = ladderForBotId(botId);
    var labels = [null];
    for (var i = 1; i < 5; i++) labels.push(ladder[i] + 'x');
    return { multipliers: ladder, labels: labels, mode: modeByBot[botId] || '2x' };
  }

  function paintUi(botId) {
    var mode = modeByBot[botId] || '2x';
    var root = document.getElementById('savingSignalMode-' + botId);
    if (root) {
      root.querySelectorAll('[data-saving-mode]').forEach(function (btn) {
        btn.classList.toggle('is-on', btn.getAttribute('data-saving-mode') === mode);
      });
    }
    var customRow = document.getElementById('savingLadderCustom-' + botId);
    if (!customRow) customRow = ensureCustomRow(botId);
    if (!customRow) return;

    // Keep exactly one grid with 5 cells.
    var grids = customRow.querySelectorAll('.saving-ladder-grid, .ladder-grid, .saving-ladder-inputs');
    if (grids.length !== 1 || customRow.querySelectorAll('[data-saving-mg]').length !== 5) {
      customRow = ensureCustomRow(botId);
      bindCustomInputs(botId);
    }

    var open = mode === 'custom';
    customRow.classList.toggle('is-open', open);
    if (open) {
      customRow.hidden = false;
      customRow.removeAttribute('hidden');
      customRow.setAttribute('aria-hidden', 'false');
      customRow.style.cssText = '';
    } else {
      customRow.hidden = true;
      customRow.setAttribute('hidden', '');
      customRow.setAttribute('aria-hidden', 'true');
      customRow.style.cssText = '';
    }

    var ladder = customByBot[botId] || readStoredCustom(botId) || DEFAULT_CUSTOM;
    customRow.querySelectorAll('[data-saving-mg]').forEach(function (inp) {
      var idx = Number(inp.getAttribute('data-saving-mg'));
      if (Number.isFinite(idx) && ladder[idx] != null) inp.value = String(ladder[idx]);
    });
  }

  function readCustomInputs(botId) {
    var customRow = document.getElementById('savingLadderCustom-' + botId) || ensureCustomRow(botId);
    if (!customRow) return (customByBot[botId] || DEFAULT_CUSTOM).slice();
    var steps = [];
    for (var i = 0; i < 5; i++) {
      var inp = customRow.querySelector('[data-saving-mg="' + i + '"]');
      steps.push(inp ? Number(inp.value) : DEFAULT_CUSTOM[i]);
    }
    return normalizeLadder(steps);
  }

  function syncBot(botId) {
    var botKey = BOT_KEYS[botId];
    if (!botKey) return;
    try {
      // Capture-phase chip clicks stopPropagation, so renderer listeners never
      // refresh the calculator — always update via window export.
      if (window.updateBetChainHint) window.updateBetChainHint(botId);
      else if (typeof updateBetChainHint === 'function') updateBetChainHint(botId);
    } catch (e) {}
    try {
      if (window.syncSavingSignalStakeToMain) {
        window.syncSavingSignalStakeToMain(botKey, (typeof lastSignalCurrency !== 'undefined' && lastSignalCurrency[botKey]) || '');
      } else if (typeof syncSavingSignalStakeToMain === 'function') {
        syncSavingSignalStakeToMain(botKey, (typeof lastSignalCurrency !== 'undefined' && lastSignalCurrency[botKey]) || '');
      } else if (window.syncSavingSignalStakeToMainSafe) {
        window.syncSavingSignalStakeToMainSafe(botKey, '');
      } else if (window.__utkSavingStake && typeof window.__utkSavingStake.pushConfigToMain === 'function') {
        window.__utkSavingStake.pushConfigToMain(botKey, {
          currency: (typeof lastSignalCurrency !== 'undefined' && lastSignalCurrency[botKey]) || ''
        });
      }
    } catch (e2) {}
  }

  function setMode(botId, mode, opts) {
    opts = opts || {};
    writeMode(botId, mode);
    if (normalizeMode(mode) === 'custom') {
      writeCustom(botId, opts.ladder || readCustomInputs(botId));
    }
    paintUi(botId);
    if (!opts.silent) syncBot(botId);
  }

  function getMode(botKey) {
    var botId = botIdOf(botKey);
    if (!botId) return '2x';
    // Stored strategy only — never rewrite to 2x when Saving/AT look off (that
    // wiped 4x/custom every time Auto Trade armed).
    return modeByBot[botId] || readStoredMode(botId);
  }

  function getLadder(botKey) {
    return ladderForBotId(botIdOf(botKey));
  }

  function getConfig(botKey) {
    return configForBotId(botIdOf(botKey));
  }

  function persistMode(botId, mode) {
    setMode(botId, mode, { silent: true });
  }

  function restoreMode(botId) {
    modeByBot[botId] = readStoredMode(botId);
    customByBot[botId] = readStoredCustom(botId);
    ensureCustomRow(botId);
    paintUi(botId);
  }

  function bindCustomInputs(botId) {
    var customRow = document.getElementById('savingLadderCustom-' + botId) || ensureCustomRow(botId);
    if (!customRow || customRow.__utkLadderBound) return;
    customRow.__utkLadderBound = true;
    var saveCustom = function () {
      writeCustom(botId, readCustomInputs(botId));
      writeMode(botId, 'custom');
      syncBot(botId);
    };
    customRow.addEventListener('change', saveCustom);
    customRow.addEventListener('input', function () {
      if (customRow.__utkLadderTimer) clearTimeout(customRow.__utkLadderTimer);
      customRow.__utkLadderTimer = setTimeout(saveCustom, 350);
    });
  }

  function bindBot(botId) {
    restoreMode(botId);
    bindCustomInputs(botId);
  }

  function onDocClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var btn = t.closest('[data-saving-mode]');
    if (!btn) return;
    var modeRoot = btn.closest('[id^="savingSignalMode-"]');
    if (!modeRoot || !modeRoot.id) return;
    var botId = modeRoot.id.replace('savingSignalMode-', '');
    if (BOT_IDS.indexOf(botId) < 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    setMode(botId, btn.getAttribute('data-saving-mode') || '2x');
  }

  function installOverrides() {
    var g = typeof globalThis !== 'undefined' ? globalThis : window;
    g.getSavingSignalMode = getMode;
    g.getSavingSignalModeConfig = getConfig;
    g.getSavingSignalLadder = getLadder;
    g.persistSavingSignalMode = persistMode;
    g.restoreSavingSignalMode = restoreMode;
  }

  function init() {
    installOverrides();
    BOT_IDS.forEach(bindBot);
    if (document.documentElement.getAttribute('data-utk-saving-ladder') !== '1') {
      document.documentElement.setAttribute('data-utk-saving-ladder', '1');
      document.addEventListener('click', onDocClick, true);
    }
    installOverrides();
  }

  window.__utkSavingLadder = {
    getMode: getMode,
    getLadder: getLadder,
    getConfig: getConfig,
    setMode: setMode,
    bindBot: bindBot,
    FIXED: FIXED,
    DEFAULT_CUSTOM: DEFAULT_CUSTOM.slice()
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
