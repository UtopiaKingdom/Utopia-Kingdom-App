#!/usr/bin/env node
/**
 * Post-packaging Mac SSID helper smoke test.
 * Fails the CI build if the DMG's .app cannot import BinaryOptionsToolsV2
 * or the PO SSID worker cannot answer ping.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, process.env.BUILD_OUT_DIR || 'dist');

function die(msg) {
  console.error(`[verify-mac-helper] ${msg}`);
  process.exit(1);
}

function findApp() {
  const candidates = [
    path.join(dist, 'mac-arm64', 'Utopia Kingdom.app'),
    path.join(dist, 'mac', 'Utopia Kingdom.app'),
    path.join(dist, 'mac-x64', 'Utopia Kingdom.app')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  if (!fs.existsSync(dist)) die(`dist missing: ${dist}`);
  for (const name of fs.readdirSync(dist)) {
    const app = path.join(dist, name, 'Utopia Kingdom.app');
    if (fs.existsSync(app)) return app;
  }
  die('Utopia Kingdom.app not found under dist/');
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function pingWorker(py, worker, collector, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(py, [worker], {
      cwd: collector,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch (e) {}
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`worker ping timeout\nstdout=${stdout.slice(0, 600)}\nstderr=${stderr.slice(0, 600)}`));
    }, 40000);

    child.stdout.on('data', (d) => {
      stdout += String(d || '');
      const lines = stdout.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          if (j && (j.pong === true || (j.success === true && j.id === 'ci-ping'))) {
            finish(null, j);
            return;
          }
        } catch (e) {}
      }
    });
    child.stderr.on('data', (d) => { stderr += String(d || ''); });
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => {
      if (!settled) {
        finish(new Error(`worker exited early code=${code}\nstdout=${stdout.slice(0, 600)}\nstderr=${stderr.slice(0, 600)}`));
      }
    });

    try {
      child.stdin.write(`${JSON.stringify({ id: 'ci-ping', cmd: 'ping' })}\n`);
    } catch (e) {
      finish(e);
    }
  });
}

async function main() {
  if (process.platform !== 'darwin') die('macOS only');

  const app = findApp();
  const res = path.join(app, 'Contents', 'Resources');
  const venv = path.join(res, 'venv');
  const py = firstExisting([
    path.join(venv, 'runtime', 'bin', 'python3'),
    path.join(venv, 'runtime', 'bin', 'python'),
    path.join(venv, 'bin', 'python3'),
    path.join(venv, 'bin', 'python')
  ]);
  if (!py) die(`bundled python missing under ${venv}`);

  try { fs.chmodSync(py, 0o755); } catch (e) {}
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', venv], { encoding: 'utf8' });

  const collector = firstExisting([
    path.join(res, 'app.asar.unpacked', 'PO SSID Collector'),
    path.join(res, 'PO SSID Collector')
  ]);
  if (!collector) die('PO SSID Collector missing from packaged app');

  const worker = path.join(collector, 'po_trade_worker.py');
  if (!fs.existsSync(worker)) die(`missing ${worker}`);

  const env = {
    ...process.env,
    PYTHONHOME: path.join(venv, 'runtime'),
    VIRTUAL_ENV: venv,
    PATH: `${path.dirname(py)}${path.delimiter}${process.env.PATH || ''}`
  };

  console.log(`[verify-mac-helper] app=${app}`);
  console.log(`[verify-mac-helper] python=${py}`);
  console.log(`[verify-mac-helper] collector=${collector}`);

  const botv2 = spawnSync(
    py,
    ['-c', 'from BinaryOptionsToolsV2.pocketoption import PocketOption; print("botv2-ok")'],
    { encoding: 'utf8', env }
  );
  if (botv2.status !== 0) {
    die(`BinaryOptionsToolsV2 failed in packaged app:\n${botv2.stderr || botv2.stdout}`);
  }
  console.log(`[verify-mac-helper] ${String(botv2.stdout).trim()}`);

  const imports = spawnSync(
    py,
    [
      '-c',
      [
        'import sys',
        `sys.path.insert(0, ${JSON.stringify(collector)})`,
        'import po_ssid',
        'import execute_trade',
        'print("ssid-modules-ok")'
      ].join('; ')
    ],
    { encoding: 'utf8', cwd: collector, env }
  );
  if (imports.status !== 0) {
    die(`SSID module import failed:\n${imports.stderr || imports.stdout}`);
  }
  console.log(`[verify-mac-helper] ${String(imports.stdout).trim()}`);

  try {
    const pong = await pingWorker(py, worker, collector, env);
    console.log(`[verify-mac-helper] worker ping ok: ${JSON.stringify(pong)}`);
  } catch (e) {
    die(e && e.message ? e.message : String(e));
  }

  console.log('[verify-mac-helper] PASS — Mac SSID helper is packaged correctly');
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
