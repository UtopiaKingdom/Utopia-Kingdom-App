/**
 * node tools/test_nyx_ui.js
 * Guard: NYX is a public bot after Lumix and Mirax.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'bot-styles.css'), 'utf8');
const access = fs.readFileSync(path.join(root, 'nyx-access.js'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'bots-registry.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'bot-switch-fx.js'), 'utf8');

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', msg);
  } else {
    console.log('ok', msg);
  }
}

const dest = html.match(/id="section-main"[\s\S]*?id="section-bots"/);
ok(!!dest, 'home section captured');
const destBlock = dest ? dest[0] : '';
ok(/data-home-nav="bot3"/.test(destBlock), 'home grid has a NYX tile');
ok(
  /data-home-nav="bot1"[\s\S]*?data-home-nav="bot2"[\s\S]*?data-home-nav="bot3"[\s\S]*?data-home-nav="strategies"/.test(destBlock),
  'home order is Lumix, Mirax, NYX, Strategies'
);

ok(!/id="nyxUnlockCard"/.test(html), 'no public access-code card');

const botsPage = html.match(/id="section-bots"[\s\S]*?id="section-bot1"/);
ok(!!botsPage, 'bots listing captured');
const listing = botsPage ? botsPage[0] : '';
ok(
  /id="menu-bot1"[\s\S]*?id="menu-bot2"[\s\S]*?id="menu-bot3"/.test(listing),
  'listing order is Lumix, Mirax, then NYX'
);
ok(/id="menu-bot3"/.test(listing) && !/nyx-gated/.test(listing), 'NYX listing card is public');

function switchOrder(sectionId) {
  const re = new RegExp('id="' + sectionId + '"[\\s\\S]*?</div>\\s*<div style="display:flex;flex-direction:column;">');
  const m = html.match(re);
  return m ? m[0] : '';
}
['section-bot1', 'section-bot2', 'section-bot3'].forEach(function (id) {
  const block = switchOrder(id) || html;
  const lumix = block.indexOf('data-target="bot1"');
  const mirax = block.indexOf('data-target="bot2"');
  const nyx = block.indexOf('data-target="bot3"');
  ok(lumix >= 0 && mirax > lumix && nyx > mirax, id + ' switcher is Lumix then Mirax then NYX');
  ok(!/hidden>NYX</.test(block), id + ' NYX switcher is visible');
});

function sectionDivDelta(id) {
  const start = html.indexOf('id="' + id + '"');
  const secStart = html.lastIndexOf('<section', start);
  const secEnd = html.indexOf('</section>', start) + 10;
  const s = html.slice(secStart, secEnd);
  return (s.match(/<div\b/g) || []).length - (s.match(/<\/div>/g) || []).length;
}
ok(sectionDivDelta('section-bot3') === 0, 'NYX section divs are balanced (no extra close leaking out of main-content)');
ok(
  (html.match(/<div\b/g) || []).length === (html.match(/<\/div>/g) || []).length,
  'index.html divs are balanced'
);

ok(/id="section-bot3" class="section"/.test(html) && !/id="section-bot3" class="section nyx-gated"/.test(html), 'NYX panel is a normal section');
ok(/key: 'LUMIX'[\s\S]*key: 'MIRAX'[\s\S]*key: 'NYX'/.test(registry), 'NYX is a public bot after Lumix and Mirax');
ok(/const PRIVATE = \[\]/.test(registry), 'registry has no private bots');
ok(!/splice\(1, 0, 'NYX'\)/.test(registry), 'registry does not splice NYX between Lumix and Mirax');
ok(/hasAttribute\('hidden'\)/.test(sw), 'switcher still ignores hidden buttons');
ok(/section\.active/.test(sw), 'switcher clears extra active sections');
ok(/function hasAccess\(\) \{\s*return true;/.test(access), 'access module always grants NYX');
ok(!/nyxUnlockCard/.test(access), 'access module does not show a public unlock card');

ok(!/id="nyxMindCard"/.test(html), 'old Mind layout card is gone');
ok(/nyx-mind-skips/.test(css), 'skip list style exists');
ok(/nyx-mind-note/.test(css), 'mind note overlay style exists');
const mindUi = fs.readFileSync(path.join(root, 'bot-mind-ui.js'), 'utf8');
ok(/bot-mind-btn/.test(mindUi) && /signal-pip-chrome/.test(mindUi), 'Mind icon mounts next to Pop out');
ok(/LUMIX/.test(mindUi) && /MIRAX/.test(mindUi) && /NYX/.test(mindUi), 'Mind mounts on all three house bots');
ok(/syncStudio/.test(mindUi), 'Mind syncs custom Studio desks');
ok(!/isOwner\(\)/.test(mindUi), 'Mind is visible to everyone, not owner-only');
const pipMain = fs.readFileSync(path.join(root, 'signal-pip-main.js'), 'utf8');
ok(/ALLOWED_BOTS[\s\S]*NYX/.test(pipMain) || /'NYX'/.test(pipMain), 'signal PiP allows NYX pop-out');
ok(/LUMIX/.test(pipMain) && /MIRAX/.test(pipMain), 'signal PiP allows LUMIX and MIRAX');
const boot = fs.readFileSync(path.join(root, 'renderer-boot.js'), 'utf8');
ok(/bot-mind-ui\.js/.test(boot), 'Mind UI is booted');
const feedDesk = fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8');
ok(/Waiting for signals\.\.\./.test(feedDesk) && /__utkBotMind/.test(feedDesk), 'Studio signal stays clean; Mind holds status');
const liveStatus = fs.readFileSync(path.join(root, 'studio-live-status.js'), 'utf8');
ok(/mindPanelHtml/.test(liveStatus), 'Studio Mind panel HTML exists');

ok(/id="historyBtn-bot3"/.test(html), 'NYX history button exists');
ok(/id="bestStreakBadge-bot3"/.test(html), 'NYX last-streak badge exists');

const histUi = fs.readFileSync(path.join(root, 'bot-history-ui.js'), 'utf8');
ok(/id: 'historyBtn-bot3'/.test(histUi), 'history modal wires NYX');
ok(/annotateSaveSteps\(items\)/.test(histUi), 'NYX uses the same Entry/S1–S4 history ladder as Lumix and Mirax');

const streakModal = fs.readFileSync(path.join(root, 'bot-streak-modal.js'), 'utf8');
ok(/bestStreakBadge-bot3/.test(streakModal), 'last-streak popup wires NYX');
ok(/NYX: 'NYX'/.test(streakModal), 'streak popup names NYX');

const stats = fs.readFileSync(path.join(root, 'bot-stats.js'), 'utf8');
ok(/function lastStreakToShow/.test(stats), 'today Last falls back to the latest wipe');
ok(/board\.lastCompletedStreak/.test(stats), 'board lastCompletedStreak fills Last when the day walk has no wipe');
const stepSrc = fs.readFileSync(path.join(root, 'saving-step-label.js'), 'utf8');
ok(/'ENTRY', 'S1'/.test(stepSrc), 'attempt 1 is labeled ENTRY');

if (failed) process.exit(1);
console.log('nyx ui ok');
