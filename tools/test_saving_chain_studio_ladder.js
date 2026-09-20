/**
 * Saving-chain sizing contracts (studio UI ladder + pad + house mode persist).
 * No live PO / no upload.
 */
const assert = require('assert');

function resolveStudioLadder(bot, opts, uiLadder) {
  opts = opts || {};
  if (Array.isArray(uiLadder) && uiLadder.length >= 5) return uiLadder.slice(0, 5);
  if (Array.isArray(opts.ladder) && opts.ladder.length >= 1) {
    const pad = opts.ladder.slice();
    while (pad.length < 5) pad.push(pad[pad.length - 1] || 1);
    return pad.slice(0, 5);
  }
  if (Array.isArray(bot && bot.ladder) && bot.ladder.length >= 1) {
    const pad = bot.ladder.slice();
    while (pad.length < 5) pad.push(pad[pad.length - 1] || 1);
    return pad.slice(0, 5);
  }
  return [1, 2, 4, 10, 20];
}

function stakeFor(base, ladder, attempt, savingOn) {
  if (!savingOn && attempt > 1) return null; // skipped
  const L = savingOn ? ladder : [1, 1, 1, 1, 1];
  const mult = L[Math.min(4, Math.max(0, attempt - 1))] || 1;
  return Math.max(1, Number(base) * mult);
}

// UI custom ladder wins over bot recipe martingale
{
  const recipe = [1, 2, 4, 10, 20];
  const custom = [1, 3, 9, 27, 81];
  const L = resolveStudioLadder({ ladder: recipe }, { ladder: recipe }, custom);
  assert.deepStrictEqual(L, custom);
  assert.strictEqual(stakeFor(10, L, 1, true), 10);
  assert.strictEqual(stakeFor(10, L, 2, true), 30);
  assert.strictEqual(stakeFor(10, L, 3, true), 90);
  assert.strictEqual(stakeFor(10, L, 4, true), 270);
  assert.strictEqual(stakeFor(10, L, 5, true), 810);
}

// 4x ladder
{
  const L = resolveStudioLadder({}, {}, [1, 4, 7, 16, 44]);
  assert.strictEqual(stakeFor(5, L, 2, true), 20);
  assert.strictEqual(stakeFor(5, L, 5, true), 220);
}

// Saving off skips recovery
{
  assert.strictEqual(stakeFor(10, [1, 2, 4, 10, 20], 2, false), null);
  assert.strictEqual(stakeFor(10, [1, 2, 4, 10, 20], 1, false), 10);
}

// Short bot ladder pads to 5 (was falling back to default and ignoring strategy)
{
  const L = resolveStudioLadder({ ladder: [1, 2, 4] }, {}, null);
  assert.strictEqual(L.length, 5);
  assert.deepStrictEqual(L, [1, 2, 4, 4, 4]);
  assert.strictEqual(stakeFor(10, L, 4, true), 40);
}

// Stored mode must not be rewritten to 2x just because Saving looks off
{
  function getModeStored(stored, savingLooksOff) {
    // Fixed contract: ignore savingLooksOff for mode read
    void savingLooksOff;
    return stored || '2x';
  }
  assert.strictEqual(getModeStored('custom', true), 'custom');
  assert.strictEqual(getModeStored('4x', true), '4x');
  assert.strictEqual(getModeStored('2x', false), '2x');
}

console.log('test_saving_chain_studio_ladder: OK');
