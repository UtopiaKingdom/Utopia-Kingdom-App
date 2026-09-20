#!/usr/bin/env node
/**
 * Build a relocatable macOS Python tree into .venv/runtime for electron-builder.
 * Ships only what the Pocket Option SSID helper needs (BinaryOptionsToolsV2).
 *
 * Run on macOS only (GitHub Actions macos-latest).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const venvRoot = path.join(root, '.venv');
const runtimeRoot = path.join(venvRoot, 'runtime');

// Pinned relocatable CPython (install_only).
const PSA_TAG = '20250529';
const PY_VER = '3.12.10';

function die(msg) {
  console.error(`[prepare_mac_python] ${msg}`);
  process.exit(1);
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  });
  if (r.status !== 0) {
    die(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout || 'no output'}`);
  }
  return r;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, redirects = 0) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirects > 8) return reject(new Error('too many redirects'));
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          res.resume();
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', reject);
    };
    get(url);
  });
}

function archTriple() {
  const a = process.arch;
  if (a === 'arm64') return 'aarch64-apple-darwin';
  if (a === 'x64') return 'x86_64-apple-darwin';
  die(`unsupported arch: ${a}`);
}

function linkVenvBin(py) {
  const binDir = path.join(venvRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ['python3', 'python']) {
    const dest = path.join(binDir, name);
    try { fs.rmSync(dest, { force: true }); } catch (e) {}
    try {
      fs.symlinkSync(path.relative(binDir, py), dest);
    } catch (e) {
      try { fs.copyFileSync(py, dest); } catch (e2) {}
    }
    try { fs.chmodSync(dest, 0o755); } catch (e) {}
  }
  try { fs.chmodSync(py, 0o755); } catch (e) {}
}

async function main() {
  if (process.platform !== 'darwin') {
    die('macOS only — use scripts/bundle_python_runtime.js on Windows');
  }

  const triple = archTriple();
  const asset = `cpython-${PY_VER}+${PSA_TAG}-${triple}-install_only.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PSA_TAG}/${asset}`;
  const tgz = path.join(root, '.cache', asset);

  console.log(`[prepare_mac_python] arch=${process.arch} triple=${triple}`);
  console.log(`[prepare_mac_python] ${url}`);
  fs.mkdirSync(path.dirname(tgz), { recursive: true });
  if (!exists(tgz)) {
    await download(url, tgz);
  } else {
    console.log(`[prepare_mac_python] using cached ${tgz}`);
  }

  if (exists(venvRoot)) {
    fs.rmSync(venvRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });

  run('tar', ['-xzf', tgz, '-C', runtimeRoot, '--strip-components=1']);

  const py = path.join(runtimeRoot, 'bin', 'python3');
  if (!exists(py)) die(`missing ${py} after extract`);
  linkVenvBin(py);

  console.log('[prepare_mac_python] installing pip + SSID helper deps');
  run(py, ['-m', 'ensurepip', '--upgrade']);
  run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools']);

  // Only Pocket Option helper deps — do NOT install the full app requirements.txt
  // (selenium/flask/etc. are unused here and can soft-fail / bloat the DMG).
  const poReq = path.join(root, 'PO SSID Collector', 'requirements.txt');
  if (!exists(poReq)) die(`missing ${poReq}`);

  console.log(`[prepare_mac_python] pip install -r ${path.relative(root, poReq)}`);
  const pip = spawnSync(py, ['-m', 'pip', 'install', '-r', poReq], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (pip.status !== 0) {
    die(`pip failed for Pocket Option helper:\n${pip.stderr || pip.stdout || 'no output'}`);
  }
  console.log(String(pip.stdout || '').trim().split('\n').slice(-8).join('\n'));

  const botv2 = spawnSync(
    py,
    ['-c', 'from BinaryOptionsToolsV2.pocketoption import PocketOption; print("botv2-ok")'],
    { encoding: 'utf8' }
  );
  if (botv2.status !== 0) {
    die(`BinaryOptionsToolsV2 import failed:\n${botv2.stderr || botv2.stdout || 'import failed'}`);
  }
  console.log(`[prepare_mac_python] ${String(botv2.stdout).trim()}`);

  const collector = path.join(root, 'PO SSID Collector');
  const workerProbe = spawnSync(
    py,
    [
      '-c',
      [
        'import sys, os',
        `sys.path.insert(0, ${JSON.stringify(collector)})`,
        'import po_ssid',
        'import execute_trade',
        'print("worker-imports-ok")'
      ].join('; ')
    ],
    { encoding: 'utf8', cwd: collector }
  );
  if (workerProbe.status !== 0) {
    die(`SSID helper import probe failed:\n${workerProbe.stderr || workerProbe.stdout || 'failed'}`);
  }
  console.log(`[prepare_mac_python] ${String(workerProbe.stdout).trim()}`);

  fs.writeFileSync(
    path.join(venvRoot, 'pyvenv.cfg'),
    [
      `home = ${runtimeRoot.replace(/\\/g, '/')}`,
      'include-system-site-packages = false',
      `version = ${PY_VER}`,
      ''
    ].join('\n'),
    'utf8'
  );

  const probe = spawnSync(py, ['-c', 'import sys; print(sys.version)'], { encoding: 'utf8' });
  if (probe.status !== 0) die(`runtime probe failed: ${probe.stderr}`);
  console.log(`[prepare_mac_python] ready: ${String(probe.stdout).trim()}`);
  console.log('[prepare_mac_python] done');
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
