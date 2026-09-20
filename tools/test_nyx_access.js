/**
 * node tools/test_nyx_access.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'nyx-access.js'), 'utf8');
let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', msg);
  } else {
    console.log('ok', msg);
  }
}

ok(/kricoeasygame@gmail\.com/.test(src), 'owner email still used for Mind');
ok(/function hasAccess\(\) \{\s*return true;/.test(src), 'NYX access is always on');
ok(/function isOwner\(/.test(src), 'owner check exists for Mind');
ok(/nyx-gated/.test(src), 'still knows gated class for leftovers');
ok(/id === 'nyxMindBtn'/.test(src) || /bot-mind-btn/.test(fs.readFileSync(path.join(__dirname, '..', 'bot-mind-ui.js'), 'utf8')), 'Mind button is not gated away');
ok(/id === 'section-bot3'/.test(src), 'does not hide the NYX section itself');

const registry = fs.readFileSync(path.join(__dirname, '..', 'bots-registry.js'), 'utf8');
ok(/key: 'NYX'/.test(registry) && /id: 'bot3'/.test(registry), 'NYX is bot3');
ok(/key: 'LUMIX'[\s\S]*key: 'MIRAX'[\s\S]*key: 'NYX'/.test(registry), 'NYX is after Lumix and Mirax');
ok(/const PRIVATE = \[\]/.test(registry), 'NYX is not private');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok(/id="section-bot3"/.test(html), 'NYX section exists');
ok(/id="menu-bot3"/.test(html), 'NYX open button exists');
ok(/data-home-nav="bot3"/.test(html), 'home has NYX destination');
ok(/nyx-access\.js/.test(html) && /bots-registry\.js/.test(html), 'scripts wired in index.html');
ok(!/id="nyxUnlockCard"/.test(html), 'no public unlock card');
ok(!/hidden>NYX</.test(html), 'NYX switchers are not hidden');

const nyxPy = fs.readFileSync(path.join(__dirname, '..', 'BotsHub', 'bots', 'nyx.py'), 'utf8');
ok(/CHAIN START/.test(nyxPy) && /duration/.test(nyxPy), 'NYX bot emits timed chains');
ok(/def send_preparing_phase/.test(nyxPy) && /silentPreparing/.test(nyxPy), 'NYX publishes silent Preparing so SSID can prime');
ok(/send_preparing_phase\(/.test(nyxPy) && /wait_for_turn/.test(nyxPy), 'Preparing is sent before the entry wait');
ok(fs.existsSync(path.join(__dirname, '..', 'BotsHub', 'bots', 'nyx_mind.py')), 'NYX mind module exists');
ok(fs.existsSync(path.join(__dirname, '..', 'BotsHub', 'bots', 'nyx_memory.py')), 'NYX memory module exists');

const ssid = fs.readFileSync(path.join(__dirname, '..', 'ssid-manager.js'), 'utf8');
ok(/SHARED_BOTS = \['bot1', 'bot2', 'bot3'\]/.test(ssid), 'one SSID connect applies to NYX (bot3)');
ok(/LUMIX \+ MIRAX \+ NYX/.test(ssid), 'SSID comment names NYX');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(/NYX: 'bot3'/.test(main), 'SignalHub maps NYX to bot3');
ok(/botKey === 'NYX' \? resolveTradeDurationSec/.test(main), 'Preparing caches NYX-chosen duration');

if (failed) process.exit(1);
console.log('nyx access wiring ok');
