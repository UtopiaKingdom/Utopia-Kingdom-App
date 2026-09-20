#!/usr/bin/env node
/**
 * Make the packaged .venv relocatable for end-user machines.
 *
 * Windows venv Scripts\\python.exe is a stub that reads pyvenv.cfg `home=` and
 * refuses to start if that path (the build machine's Python) is missing.
 * Copy a minimal base runtime into .venv/runtime and point home there.
 * Electron will rewrite home to an absolute path at runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const venvRoot = path.join(root, '.venv');
const runtimeRoot = path.join(venvRoot, 'runtime');
const cfgPath = path.join(venvRoot, 'pyvenv.cfg');

function die(msg) {
  console.error(`[bundle_python_runtime] ${msg}`);
  process.exit(1);
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!exists(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) copyFile(from, to);
  }
}

function resolveBasePrefix() {
  const stubPy = path.join(venvRoot, 'Scripts', 'python.exe');
  const runtimePy = path.join(runtimeRoot, 'python.exe');
  if (!exists(stubPy) && !exists(runtimePy)) die(`Missing ${stubPy}`);

  // Prefer an already-bundled runtime (rebuilds), else the venv stub.
  const probes = [];
  if (exists(runtimePy)) probes.push(runtimePy);
  if (exists(stubPy)) probes.push(stubPy);

  let lastErr = '';
  for (const py of probes) {
    const probe = spawnSync(py, ['-c', 'import sys; print(sys.base_prefix)'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (probe.status === 0) {
      const base = String(probe.stdout || '').trim();
      if (base && exists(path.join(base, 'python.exe'))) return base;
    }
    lastErr = String(probe.stderr || probe.stdout || 'probe failed');
  }

  // Last resort: system Python used to create the venv (from old pyvenv.cfg).
  if (exists(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const m = raw.match(/^\s*home\s*=\s*(.+)\s*$/m);
      const home = m ? String(m[1] || '').trim() : '';
      if (home && exists(path.join(home, 'python.exe'))) return home;
    } catch (_) {}
  }
  die(`Failed to resolve base_prefix: ${lastErr}`);
}

function main() {
  if (!exists(venvRoot)) die(`Missing venv at ${venvRoot}`);
  const base = resolveBasePrefix();
  console.log(`[bundle_python_runtime] base Python: ${base}`);
  console.log(`[bundle_python_runtime] writing runtime → ${runtimeRoot}`);

  fs.mkdirSync(runtimeRoot, { recursive: true });
  const files = [
    'python.exe',
    'pythonw.exe',
    'python3.dll',
    'python314.dll',
    'python313.dll',
    'python312.dll',
    'python311.dll',
    'python310.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
  ];
  for (const name of files) {
    const src = path.join(base, name);
    if (exists(src)) copyFile(src, path.join(runtimeRoot, name));
  }
  copyDir(path.join(base, 'DLLs'), path.join(runtimeRoot, 'DLLs'));
  copyDir(path.join(base, 'Lib'), path.join(runtimeRoot, 'Lib'));

  // Drop stdlib bloat — keeps installer under Wrangler's 300 MiB R2 put limit.
  const pruneDirs = [
    'Lib/test',
    'Lib/idlelib',
    'Lib/turtledemo',
    'Lib/ensurepip',
    'Lib/tkinter',
    'Lib/site-packages',
    'Lib/pydoc_data',
    'Lib/venv',
    'Lib/distutils',
  ];
  for (const rel of pruneDirs) {
    const p = path.join(runtimeRoot, ...rel.split('/'));
    try {
      if (exists(p)) fs.rmSync(p, { recursive: true, force: true });
    } catch (_) {}
  }
  // Drop bytecode caches
  try {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === '__pycache__') {
            try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
          } else walk(full);
        }
      }
    };
    walk(runtimeRoot);
  } catch (_) {}

  if (!exists(path.join(runtimeRoot, 'python.exe'))) {
    die('runtime/python.exe missing after copy');
  }

  // Absolute home so local Scripts\\python.exe works from any cwd.
  // Electron rewrites this again for the installed resources path.
  const absHome = runtimeRoot.replace(/\\/g, '/');
  const cfg = [
    `home = ${absHome}`,
    'include-system-site-packages = false',
    `version = ${fs.existsSync(path.join(base, 'python314.dll')) ? '3.14.2' : '3'}`,
    '',
  ].join('\n');
  fs.writeFileSync(cfgPath, cfg, 'utf8');
  console.log(`[bundle_python_runtime] pyvenv.cfg updated (home=${absHome})`);
  console.log('[bundle_python_runtime] done');
}

main();
