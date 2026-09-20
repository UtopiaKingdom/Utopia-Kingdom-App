/**
 * node tools/test_hub_studio.js
 * Guard: Hub + Studio live in their own modules, not renderer.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const hubJs = fs.readFileSync(path.join(root, 'community-hub.js'), 'utf8');
const studioJs = fs.readFileSync(path.join(root, 'bot-studio.js'), 'utf8');
const tape = fs.readFileSync(path.join(root, 'BotsHub/pipeline/bot_tape_server.py'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', msg);
  } else {
    console.log('ok', msg);
  }
}

ok(/id="menu-hub"/.test(html) && /id="menu-studio"/.test(html), 'sidebar has Hub and Studio');
ok(/id="section-hub"/.test(html) && /id="section-studio"/.test(html), 'sections exist');
ok(/require\('\.\/community-hub\.js'\)/.test(html), 'index loads community-hub.js');
ok(/require\('\.\/bot-studio\.js'\)/.test(html), 'index loads bot-studio.js');
ok(/require\('\.\/studio-paper-local\.js'\)/.test(html), 'index loads local paper');
ok(/require\('\.\/bot-studio-desk\.js'\)/.test(html), 'index loads desk');
ok(/require\('\.\/studio-autotrade\.js'\)/.test(html), 'index loads studio autotrade');
ok(/href="community-hub\.css"/.test(html) && /href="bot-studio\.css"/.test(html), 'css linked');
ok(/href="bot-studio-desk\.css"/.test(html), 'desk css linked');
ok(/data-home-nav="hub"/.test(html) && /data-home-nav="studio"/.test(html), 'home tiles for hub and studio');
ok(!/id="section-hub"/.test(renderer) && !/community-hub/.test(renderer), 'renderer.js does not own hub');
ok(!/id="section-studio"/.test(renderer) && !/bot-studio/.test(renderer), 'renderer.js does not own studio');
ok(!/firebase\/firestore/.test(hubJs) && /169\.58\.151\.111:8788\/hub/.test(hubJs), 'hub client uses Contabo');
ok(/__utkCommunityHub/.test(studioJs), 'studio uses shared hub API');
ok(/community_hub_server/.test(tape) && /startswith\("\/hub"\)/.test(tape), 'tape server mounts /hub');
const files = (pkg.build && pkg.build.files) || [];
ok(files.includes('community-hub.js') && files.includes('bot-studio.js'), 'packaged js');
ok(files.includes('studio-paper-local.js'), 'packaged local paper');
ok(/__utkStudioPaper/.test(studioJs), 'studio can run paper locally');
ok(files.includes('bot-studio-desk.js') && files.includes('studio-autotrade.js'), 'packaged desk modules');
ok(files.includes('bot-studio-desk.css'), 'packaged desk css');
const hubPy = fs.readFileSync(path.join(root, 'BotsHub/pipeline/community_hub_server.py'), 'utf8');
ok(/paintStrategyPick/.test(studioJs) && /function pickStrategy/.test(studioJs), 'picking a style does not rebuild the wizard');
ok(/if \(rsi\) bot\.rules\.rsiLeave/.test(studioJs) && /if \(bb\) bot\.rules\.useBb/.test(studioJs), 'readForm does not wipe RSI/BB when those checkboxes are off-screen');
ok(/function commitNameFromInput/.test(studioJs), 'bot name commits on type and blur');
ok(/__utkStudioDialog/.test(fs.readFileSync(path.join(root, 'bot-studio-dialog.js'), 'utf8')), 'studio uses an app dialog, not window.confirm');
ok(!/window\.confirm/.test(studioJs), 'studio delete is not a Windows confirm');
ok(/require\('\.\/bot-studio-dialog\.js'\)/.test(html), 'index loads studio dialog');
ok(/bot-studio-skin\.css/.test(html) && files.includes('bot-studio-skin.css'), 'studio skin is packaged');
ok(/require\('\.\/bot-studio-name\.js'\)/.test(html), 'index loads name field module');
ok(/checking = false[\s\S]{0,220}renderEditor/.test(studioJs), 'Check unsticks the desk when it finishes');
const wizJs = fs.readFileSync(path.join(root, 'bot-studio-wizard.js'), 'utf8');
ok(/PAYOUT_OPTS = \[85, 88, 92\]/.test(wizJs), 'min payout chips stop at 92%');
ok(/Math\.min\(92,/.test(studioJs), 'studio clamps payout to 92');
ok(/min\(92, int\(value\)\)/.test(hubPy), 'hub clamps payout to 92');
const stratJs = fs.readFileSync(path.join(root, 'bot-studio-strategies.js'), 'utf8');
ok(/id: 'bollinger'[\s\S]*?rejectionWick: false/.test(stratJs), 'Bollinger bounce is BB + RSI, not an extra wick');
ok(!/studio-name-field"[^>]*data-tip/.test(studioJs), 'name field is not wrapped in a hold-tip');
ok(/Community/.test(studioJs) && /My bot/.test(studioJs), 'studio tabs are Community and My bot');
ok(!/Clone to Cook/.test(fs.readFileSync(path.join(root, 'studio-global-hub.js'), 'utf8')), 'feed has no clone');
ok(/clone_disabled/.test(hubPy) && /ideaLine/.test(hubPy) && /publish_gate/.test(hubPy), 'hub feed gate and idea cards');
ok(/Studio entitlements sync/.test(fs.readFileSync(path.join(root, 'BotsHub/hub/bots_hub.config.contabo.json'), 'utf8')), 'contabo entitlement sync job');
ok(files.includes('studio-global-hub.js') && files.includes('studio-global-hub.css'), 'packaged feed modules');
ok(files.includes('studio-feed-desk.js'), 'packaged feed desk');
ok(/require\('\.\/studio-feed-desk\.js'\)/.test(html), 'index loads feed desk');
ok(/bot-container/.test(fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8')), 'feed desk uses house bot layout');
ok(/__utkStudioDesk/.test(fs.readFileSync(path.join(root, 'bot-studio-desk.js'), 'utf8')), 'desk module exports');
ok(/__utkStudioAutotrade/.test(fs.readFileSync(path.join(root, 'studio-autotrade.js'), 'utf8')), 'autotrade module exports');
ok(/studio\/check/.test(hubPy) && /studio\/desk/.test(hubPy), 'hub studio check and desk routes');
ok(/CHECK_FETCH_MS/.test(hubJs) && /heavyStudio/.test(hubJs), 'studio check uses a long Contabo timeout');
ok(/wr1Wins/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_paper.py'), 'utf8')), 'paper scorecard tracks first-try wins');
ok(/Test past candles/.test(studioJs) && /studio-path/.test(studioJs), 'my bot has a clear path');
ok(/studio-room-ui\.js/.test(html), 'index loads studio room copy');
ok(files.includes('studio-room-ui.js'), 'packaged studio room');
ok(/POLL_MS/.test(fs.readFileSync(path.join(root, 'bot-studio-desk.js'), 'utf8')) && /!live/.test(fs.readFileSync(path.join(root, 'bot-studio-desk.js'), 'utf8')), 'idle desk does not keep redrawing');
ok(/#studioGlobalList/.test(fs.readFileSync(path.join(root, 'bot-studio-cook-bind.js'), 'utf8')), 'cook-bind does not steal Feed clicks');
ok(/studio-shell\.css/.test(html), 'index loads studio shell css');
ok(/id="studioDialog"/.test(html), 'studio confirm dialog in index html');
ok(/require\('\.\/bot-studio-stage\.js'\)/.test(html), 'index loads studio stage');
ok(files.includes('bot-studio-stage.js') && files.includes('bot-studio-stage.css'), 'packaged studio stage');
ok(/max_pairs: int = 0/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_paper.py'), 'utf8')), 'paper check walks the full OTC book');
ok(/TIMEOUT_MS = 900000/.test(fs.readFileSync(path.join(root, 'studio-paper-local.js'), 'utf8')), 'local paper can finish a 100-pack walk');
ok(/studio-check-window\.js/.test(html), 'index loads check lookback picker');
ok(files.includes('studio-check-window.js'), 'packaged check lookback');
ok(/__utkStudioOptionsModal/.test(fs.readFileSync(path.join(root, 'studio-options-modal.js'), 'utf8')), 'backtest options modal exports');
ok(/openBacktest/.test(studioJs) && /confirmThenGoLive/.test(studioJs), 'test opens options modal before check');
ok(!/studio-check-window-chips/.test(studioJs), 'lookback chips are not inline on the desk');
ok(/__utkStudioTakedown/.test(fs.readFileSync(path.join(root, 'studio-community-takedown.js'), 'utf8')), 'community takedown module exports');
ok(/global\/audience/.test(hubPy) && /need_reason/.test(hubPy), 'hub checks audience and reason on unpublish');
ok(/pickMaxAttempts/.test(studioJs) && /maxAttempts/.test(studioJs), 'user can pick retry count 1-5');
ok(/max_attempts/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_paper.py'), 'utf8')), 'paper honors max attempts');
ok(/max_attempts/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_runner.py'), 'utf8')), 'live runner honors max attempts');
ok(/SCAN_BARS/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_runner.py'), 'utf8')), 'live runner scans multiple bars');
ok(/liveMeta/.test(hubPy), 'desk returns live meta');
ok(/studio-bot-desk-layout/.test(html), 'desk layout css linked');
ok(/studio-live-status/.test(html), 'index loads live status module');
ok(/studio_runner_health/.test(hubPy), 'hub knows runner health module');
ok(/\/hub\/studio\/health/.test(hubPy), 'hub has studio health route');
ok(/overallOk/.test(hubPy) && /runnerOk/.test(hubPy), 'live meta includes health flags');
ok(/studio-health-list/.test(fs.readFileSync(path.join(root, 'studio-live-status.js'), 'utf8')), 'live status renders health checklist');
ok(/paintHealthChip/.test(fs.readFileSync(path.join(root, 'studio-room-ui.js'), 'utf8')), 'room ui patches health chip on poll');
ok(/__utkStudioBacktestProof/.test(fs.readFileSync(path.join(root, 'studio-backtest-proof.js'), 'utf8')), 'backtest proof panel exports');
ok(/What was tested/.test(fs.readFileSync(path.join(root, 'studio-backtest-proof.js'), 'utf8')), 'proof explains real replay');
ok(/GAP_OPTS/.test(fs.readFileSync(path.join(root, 'studio-check-window.js'), 'utf8')), 'wait chips exist');
ok(/signal_gap_seconds/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_paper.py'), 'utf8')), 'paper honors wait after a chain');
ok(/signal_gap_seconds/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_runner.py'), 'utf8')), 'live runner waits between chains');
ok(/How it would have done/.test(fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8')), 'backtest card is in plain English');
ok(/studio-backtest-pro/.test(fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8')), 'backtest card uses pro layout');
ok(/Ask AI what to improve/.test(fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8')), 'backtest card has AI improve button');
ok(/__utkStudioStrategyHints/.test(fs.readFileSync(path.join(root, 'bot-studio-strategy-hints.js'), 'utf8')), 'strategy hints module exports');
ok(/require\('\.\/bot-studio-strategy-hints\.js'\)/.test(html), 'index loads strategy hints');
ok(/__utkStudioStrategyPicker/.test(fs.readFileSync(path.join(root, 'bot-studio-strategy-picker.js'), 'utf8')), 'strategy picker module exports');
ok(/require\('\.\/bot-studio-strategy-picker\.js'\)/.test(html), 'index loads strategy picker');
ok(/bot-studio-strategy-picker\.css/.test(html), 'strategy picker css linked');
ok(/studio-backtest-card\.css/.test(html) && /studio-ai-panel\.css/.test(html), 'backtest and AI panel css linked');
ok(/studio-clarity/.test(fs.readFileSync(path.join(root, 'renderer-boot.js'), 'utf8')), 'boot loads studio clarity');
ok(/studio-clarity\.css/.test(html), 'index loads studio clarity css');
ok(/Past signal pace/.test(fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8')), 'backtest card shows honest past signal pace');
ok(/Stake ladder/.test(fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8')), 'private desk explains stake ladder');
ok(/duplicate/.test(fs.readFileSync(path.join(root, 'studio-room-ui.js'), 'utf8')), 'room ui has duplicate');
ok(/paintCheckProgress/.test(fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8')), 'check progress bar can paint');
ok(/studioCheckMeter/.test(fs.readFileSync(path.join(root, 'studio-feed-desk.js'), 'utf8')), 'checking card has a meter');
ok(!/Contabo live packs/.test(studioJs), 'check does not freeze the bar on a silent Contabo wait');
ok(/live OTC prices/.test(studioJs) || /BotsHub\/Prices\/candles/.test(studioJs), 'check toast describes the OTC replay');
ok(/def run_paper/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_paper.py'), 'utf8')), 'paper check exists');
ok(/studio_signals/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/studio_runner.py'), 'utf8')), 'private runner exists');
ok(/otc_files_for_bot/.test(fs.readFileSync(path.join(root, 'BotsHub/pipeline/global_studio_runner.py'), 'utf8')), 'global runner honors OTC pick');
ok(/Studio runner/.test(fs.readFileSync(path.join(root, 'BotsHub/hub/bots_hub.config.contabo.json'), 'utf8')), 'contabo job for runner');
ok(files.includes('community-hub-emotes.js'), 'packaged emotes module');
ok(files.includes('community-hub-msg-ui.js'), 'packaged msg-ui module');
ok(/require\('\.\/community-hub-emotes\.js'\)/.test(html), 'index loads emotes');
ok(/require\('\.\/community-hub-msg-ui\.js'\)/.test(html), 'index loads msg-ui');
ok(/id="hubEmoteBtn"/.test(html), 'emoji button exists');
const emotes = require(path.join(root, 'community-hub-emotes.js'));
ok(emotes.expand(':fire: up') === '🔥 up', 'short codes expand');
ok(files.includes('community-hub.css') && files.includes('bot-studio.css'), 'packaged css');
ok(/require\('\.\/community-hub-censor\.js'\)/.test(html), 'index loads censor first');
ok(/censorText/.test(hubJs) && /light=1/.test(hubJs), 'hub client censors and uses light poll');
const censor = require(path.join(root, 'community-hub-censor.js'));
ok(censor.censorText('hello') === 'hello', 'censor keeps clean words');
ok(!/shit/i.test(censor.censorText('this is shit')), 'censor masks swears');
ok(censor.censorText('cocktail') === 'cocktail', 'censor skips lookalikes');
ok(/id="hubJoinBtn"/.test(html) && /Create private chat/.test(html), 'private chat actions exist');
ok(/id="hubLeaveBtn"/.test(html), 'private chat can be left');
ok(!/World chat and private chats/.test(html), 'rail has no extra subtitle');
ok(/Join with a code/.test(html) && /Your private chats/.test(html), 'copy is easy to follow');
ok(!/New room/.test(html), 'old public room wording is gone');
ok(
  (html.match(/<div\b/g) || []).length === (html.match(/<\/div>/g) || []).length,
  'index.html divs are balanced'
);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('all ok');
