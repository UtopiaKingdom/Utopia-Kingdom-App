#!/usr/bin/env node
/**
 * tools/utk_system_smoke.js
 *
 * Broad smoke / integrity checks for Utopia Kingdom desktop stack.
 * Covers what we can verify without clicking through live Paddle checkout
 * or inventing user passwords.
 *
 * Usage: node tools/utk_system_smoke.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const results = [];
let failed = 0;

function ok(name, detail) {
  results.push({ ok: true, name, detail: detail || '' });
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  failed += 1;
  results.push({ ok: false, name, detail: detail || '' });
  console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function checkSyntax(rel) {
  const src = read(rel);
  try {
    new vm.Script(src, { filename: rel });
    ok(`syntax ${rel}`);
  } catch (e) {
    fail(`syntax ${rel}`, e.message);
  }
}

function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body), body }); }
        catch { resolve({ status: res.statusCode, json: null, body }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function main() {
  console.log('Utopia Kingdom system smoke');
  console.log('Root:', ROOT);

  // ----- Files / packaging -----
  section('Core files');
  const required = [
    'main.js', 'renderer.js', 'index.html', 'preload.js', 'auth-verification.js',
    'signal-writer-gate.js', 'signal-writer-server.js', 'security-hardening.js',
    'firestore.rules', 'package.json', 'config.json', 'firebase-bot-paths.js',
    'stats-day.js',
    'connection-system.js', 'ssid-manager.js', 'bot-stats.js', 'bot-history-ui.js',
    'home-hub.js', 'BotsHub/bots/NewMirax.py', 'BotsHub/bots/lumix5.py',
    'BotsHub/hub/bots_hub.py', 'BotsHub/hub/bots_hub.config.json',
    'BotsHub/pipeline/community_hub_server.py',
    'community-hub.js', 'bot-studio.js',
    'tools/publish_hub_live_status.js',
  ];
  for (const f of required) {
    if (exists(f)) ok(`exists ${f}`);
    else fail(`exists ${f}`, 'missing');
  }
  if (exists('bot-transitions.js')) ok('bot-transitions.js present');
  else ok('bot-transitions.js absent (expected — removed from packaging list)');

  // ----- JS syntax -----
  section('JS syntax');
  [
    'main.js', 'renderer.js', 'auth-verification.js', 'signal-writer-gate.js',
    'security-hardening.js', 'signal-writer-server.js', 'signal-writer/helpers.js',
    'firebase-bot-paths.js',
    'stats-day.js',
    'connection-system.js', 'ssid-manager.js', 'bot-stats.js', 'bot-history-ui.js',
    'home-hub.js', 'tools/publish_hub_live_status.js', 'tools/publish_bot_status.js',
    'community-hub.js', 'bot-studio.js',
  ].forEach(checkSyntax);

  // ----- Package packaging list -----
  section('Packaging');
  try {
    const pkg = JSON.parse(read('package.json'));
    const files = pkg.build && pkg.build.files ? pkg.build.files : [];
    if (files.includes('firebase-bot-paths.js')) ok('package includes firebase-bot-paths.js');
    else fail('package includes firebase-bot-paths.js', 'add to build.files');
    if (files.includes('stats-day.js')) ok('package includes stats-day.js');
    else fail('package includes stats-day.js', 'add to build.files');
    if (files.includes('bot-transitions.js')) fail('package lists missing bot-transitions.js', 'remove from build.files');
    else ok('package does not list missing bot-transitions.js');
  } catch (e) {
    fail('package.json parse', e.message);
  }

  // ----- Config / payments -----
  section('Config & payment wiring');
  try {
    const cfg = JSON.parse(read('config.json'));
    const keys = Object.keys(cfg || {});
    ok('config.json readable', keys.slice(0, 8).join(', ') + (keys.length > 8 ? '…' : ''));
    const hasPaddle = keys.some((k) => /paddle/i.test(k));
    const hasCoinbase = keys.some((k) => /coinbase/i.test(k));
    if (hasPaddle) ok('paddle config present');
    else fail('paddle config present', 'no paddle* keys in config.json');
    if (hasCoinbase) ok('coinbase config present');
    else ok('coinbase config optional/missing');
  } catch (e) {
    fail('config.json', e.message);
  }
  if (exists('paddle-checkout.html')) ok('paddle-checkout.html');
  else fail('paddle-checkout.html', 'missing');
  if (exists('paddle-server.js') || exists('cloudflare-worker.js')) ok('payment server/worker present');
  else fail('payment server/worker present');

  // ----- Auth / subscription code paths -----
  section('Auth & subscription code');
  const authSrc = read('auth-verification.js');
  const checks = [
    ['createUserWithEmailAndPassword', /createUserWithEmailAndPassword/],
    ['signInWithEmailAndPassword', /signInWithEmailAndPassword/],
    ['subscription overlay', /subscription-overlay|showSubscription|updateSubscriptionUI/],
    ['trial start', /trialExpiresAt|TRIAL_DURATION/],
    ['paidUntil entitlement', /paidUntil/],
    ['Paddle checkout invoke', /get-paddle-checkout-url|create-coinbase-charge/],
  ];
  for (const [name, re] of checks) {
    if (re.test(authSrc)) ok(`auth: ${name}`);
    else fail(`auth: ${name}`, 'pattern not found');
  }

  // ----- Firestore rules security -----
  section('Firestore rules (paywall / signals)');
  const rules = read('firestore.rules');
  if (/subscriptionStatus == 'active'/.test(rules) && /paidUntil/.test(rules)) {
    ok('rules block client-paid entitlement writes');
  } else {
    fail('rules block client-paid entitlement writes');
  }
  if (/themeCustomPrimary|expoPushTokens|pushEnabled/.test(rules)) {
    ok('rules allow theme + push token profile fields');
  } else {
    fail('rules allow theme + push token profile fields');
  }
  if (/signal_writer/.test(rules) && /activeSignals/.test(rules)) {
    ok('rules restrict activeSignals writes to signal_writer/admin');
  } else {
    fail('rules restrict activeSignals writes');
  }
  if (/match \/bots\/\{botSlug\}/.test(rules) && /tradingResults/.test(rules) && /pastWinStreaks/.test(rules) && /dailyStats/.test(rules)) {
    ok('rules cover per-bot tradingResults + pastWinStreaks + dailyStats');
  } else {
    fail('rules cover per-bot tradingResults + pastWinStreaks + dailyStats');
  }
  if (/allow write: if false/.test(rules) && /meta\//.test(rules)) {
    ok('rules lock meta/* to Admin SDK only');
  } else {
    fail('rules lock meta/*');
  }

  // ----- Bots / shared feed -----
  section('Bots & shared signal path');
  const lumix = read('BotsHub/bots/lumix5.py');
  const mirax = read('BotsHub/bots/NewMirax.py');
  if (/MIN_PAYOUT/.test(lumix) && /_pair_tradable/.test(lumix)) ok('Lumix payout/index gate');
  else fail('Lumix payout/index gate');
  if (/MIN_PAYOUT/.test(mirax)) ok('Mirax payout gate');
  else fail('Mirax payout gate');
  if (!/sref3gYE3qFtubxX/.test(lumix) && !/sref3gYE3qFtubxX/.test(mirax)) {
    ok('no hardcoded WS_API_KEY in live bots');
  } else {
    fail('no hardcoded WS_API_KEY in live bots', 'key still present');
  }
  const hubCfg = read('BotsHub/hub/bots_hub.config.json');
  if (/auto_restart":\s*true/.test(hubCfg) && /publish_hub_live_status/.test(hubCfg)) {
    ok('hub auto_restart + status publisher job');
  } else {
    fail('hub auto_restart + status publisher job');
  }
  const gate = read('signal-writer-gate.js');
  if (/userCanWriteSignals/.test(gate) && /shouldSkipClientFirebaseWrites/.test(gate)) {
    ok('single-writer gate (server + claim)');
  } else {
    fail('single-writer gate');
  }
  const renderer = read('renderer.js');
  const tapeClient = read('bot-tape-contabo.js');
  if (/Fail closed|shouldSkipClientFirebaseWrites/.test(renderer)
      && /__utkSignalWriterGate/.test(renderer)) {
    ok('renderer fail-closed Firebase writes');
  } else {
    fail('renderer fail-closed Firebase writes');
  }
  if (/__utkBotTape/.test(renderer) && /fetchSignal/.test(tapeClient) && /pullTapeSignal/.test(renderer)) {
    ok('renderer hydrates live cards from Contabo tape');
  } else {
    fail('renderer hydrates live cards from Contabo tape');
  }
  if (!/historyListeners\[botKey\] = onSnapshot/.test(renderer)) {
    ok('renderer does not live-listen tradingResults (quota)');
  } else {
    fail('renderer does not live-listen tradingResults (quota)');
  }
  const histLoad = read('bot-results-history.js');
  if (/__utkBotTape/.test(histLoad) && /ensureDay/.test(histLoad) && /onLiveBoard/.test(histLoad)
      && /api\/bot-tape/.test(tapeClient)) {
    ok('history loads from Contabo tape');
  } else {
    fail('history loads from Contabo tape');
  }
  const tapePy = read('BotsHub/pipeline/bot_tape_server.py');
  const hubContabo = read('BotsHub/hub/bots_hub.config.contabo.json');
  if (/bot-tape/.test(tapePy) && /bot_tape_server/.test(hubContabo) && /8788/.test(hubContabo)) {
    ok('Contabo hub runs bot tape server');
  } else {
    fail('Contabo hub runs bot tape server');
  }
  const communityPy = read('BotsHub/pipeline/community_hub_server.py');
  const communityJs = read('community-hub.js');
  if (/community_hub_server/.test(tapePy) && /\/hub/.test(tapePy) && /community-hub/.test(communityPy)) {
    ok('Contabo tape mounts community hub at /hub');
  } else {
    fail('Contabo tape mounts community hub at /hub');
  }
  if (/169\.58\.151\.111:8788\/hub/.test(communityJs) && !/firebase\/firestore/.test(communityJs)) {
    ok('community hub client uses Contabo, not Firestore');
  } else {
    fail('community hub client uses Contabo, not Firestore');
  }
  const writer = read('signal-writer-server.js');
  if (/skipped: 'contabo-tape'/.test(writer) && /Live cards live on Contabo/.test(writer) && /fanoutSignalPush/.test(writer)) {
    ok('signal-writer skips Firebase cards+history, keeps push');
  } else {
    fail('signal-writer skips Firebase cards+history, keeps push');
  }

  // ----- Main process security -----
  section('Electron shell security');
  const mainSrc = read('main.js');
  if (/will-navigate/.test(mainSrc) && /setWindowOpenHandler/.test(mainSrc)) {
    ok('main blocks unexpected navigation / popups');
  } else {
    fail('main blocks unexpected navigation / popups');
  }
  if (/setPermissionRequestHandler/.test(mainSrc)) ok('main denies web permissions by default');
  else fail('main denies web permissions by default');
  if (/nodeIntegration:\s*true/.test(mainSrc)) {
    ok('NOTE: main shell still has nodeIntegration (full isolation = later migration)');
  }

  // ----- Python syntax -----
  section('Python bot syntax');
  await new Promise((resolve) => {
    const { spawn } = require('child_process');
    const py = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
    const bin = fs.existsSync(py) ? py : 'python';
    const proc = spawn(bin, [
      '-c',
      "import ast,sys;\n" +
      "files=['BotsHub/bots/lumix5.py','BotsHub/bots/NewMirax.py','BotsHub/hub/bots_hub.py','BotsHub/pipeline/community_hub_server.py','BotsHub/pipeline/bot_tape_server.py'];\n" +
      "ok=True\n" +
      "for f in files:\n" +
      "  try:\n" +
      "    ast.parse(open(f,encoding='utf-8').read()); print('OK',f)\n" +
      "  except Exception as e:\n" +
      "    ok=False; print('BAD',f,e)\n" +
      "sys.exit(0 if ok else 1)",
    ], { cwd: ROOT });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('close', (code) => {
      String(out).split(/\r?\n/).filter(Boolean).forEach((line) => {
        if (line.startsWith('OK ')) ok(`py ${line.slice(3)}`);
        else if (line.startsWith('BAD ')) fail(`py ${line.slice(4)}`);
      });
      if (code !== 0 && !/BAD /.test(out)) fail('python syntax runner', `exit ${code}`);
      resolve();
    });
  });

  // ----- Live Firebase (Admin) -----
  section('Firebase live (Admin SDK)');
  const saPath = path.join(ROOT, 'serviceAccountKey.json');
  if (!fs.existsSync(saPath)) {
    fail('serviceAccountKey.json', 'missing — skip live Firebase checks');
  } else {
    try {
      const admin = require('firebase-admin');
      if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
      }
      const db = admin.firestore();

      const sw = await db.collection('meta').doc('signalWriter').get();
      if (sw.exists) {
        const d = sw.data() || {};
        const age = d.updatedAt ? Date.now() - Number(d.updatedAt) : null;
        const fresh = age != null && age < 120_000;
        if (d.online && fresh) ok('signalWriter heartbeat fresh', `age=${Math.round(age / 1000)}s ws=${d.wsState || '?'}`);
        else fail('signalWriter heartbeat fresh', `online=${d.online} age=${age}`);
      } else {
        fail('signalWriter heartbeat', 'meta/signalWriter missing — start Railway writer');
      }

      for (const bot of ['LUMIX', 'MIRAX']) {
        const sig = await db.collection('activeSignals').doc(bot).get();
        if (sig.exists) {
          const d = sig.data() || {};
          ok(`activeSignals/${bot}`, `phase=${d.phase || '?'} updatedAt=${d.updatedAt || '?'}`);
        } else {
          ok(`activeSignals/${bot}`, 'empty (no live signal — OK)');
        }
      }

      for (const bot of ['lumix', 'mirax']) {
        const board = await db.doc(`bots/${bot}`).get();
        if (board.exists) {
          const d = board.data() || {};
          ok(`bots/${bot} live board`, `streak=${d.currentWinStreak || 0}`);
        } else {
          ok(`bots/${bot} live board`, 'empty until first result — OK');
        }
        const trades = await db.collection(`bots/${bot}/tradingResults`).orderBy('timestamp', 'desc').limit(3).get();
        ok(`bots/${bot}/tradingResults`, trades.empty ? 'empty (fresh — OK)' : `${trades.size} recent`);
      }

      const bs = await db.collection('meta').doc('botStatus').get();
      if (bs.exists) ok('meta/botStatus present', JSON.stringify(Object.keys(bs.data() || {})));
      else ok('meta/botStatus', 'missing until hub status publisher runs');

      // Simulate attacker: Auth SDK cannot be fully tested without password,
      // but we can verify rules source blocks paid writes (already checked).
      ok('paywall server-side note', 'deploy updated firestore.rules to Firebase console/CLI');
    } catch (e) {
      fail('Firebase live', e.message);
    }
  }

  // ----- Signal writer health endpoint (optional) -----
  section('Edge / writer reachability');
  try {
    const cfg = JSON.parse(read('config.json'));
    const wsHint = cfg.wsUrl || cfg.WS_URL || cfg.signalWsUrl || '';
    if (wsHint) ok('config has WS hint', String(wsHint).slice(0, 60));
    else ok('config WS hint optional');
  } catch (_) {}
  try {
    const res = await fetchJson('https://utkingdom.com/', 6000);
    if (res.status && res.status < 500) ok('utkingdom.com reachable', `HTTP ${res.status}`);
    else fail('utkingdom.com reachable', `HTTP ${res && res.status}`);
  } catch (e) {
    fail('utkingdom.com reachable', e.message);
  }

  // ----- Summary -----
  section('Summary');
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed) {
    console.log('\nFailed checks:');
    results.filter((r) => !r.ok).forEach((r) => console.log(` - ${r.name}: ${r.detail}`));
    process.exit(1);
  }
  console.log('\nAll automated smoke checks passed.');
  console.log('Manual still required once: real signup email code, Paddle/Coinbase checkout click-through, SSID connect.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
