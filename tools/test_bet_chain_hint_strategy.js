/**
 * tools/test_bet_chain_hint_strategy.js — strategy chips must refresh Full chain $
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const ladder = fs.readFileSync(path.join(root, 'saving-signal-custom-ladder.js'), 'utf8');

assert.ok(
  /window\.updateBetChainHint\s*=\s*updateBetChainHint/.test(renderer),
  'updateBetChainHint must be exported on window'
);
assert.ok(
  /__utkSavingLadder\.getConfig/.test(renderer),
  'getSavingSignalModeConfig must use live ladder config'
);
assert.ok(
  /window\.updateBetChainHint/.test(ladder),
  'custom-ladder syncBot must call window.updateBetChainHint'
);
assert.ok(
  !/if \(typeof updateBetChainHint === 'function'\) updateBetChainHint\(botId\);\s*\} catch/.test(
    ladder.replace(/\s+/g, ' ')
  ) || /window\.updateBetChainHint/.test(ladder),
  'syncBot must not rely only on unbound updateBetChainHint'
);

console.log('ok: bet chain hint follows strategy');
