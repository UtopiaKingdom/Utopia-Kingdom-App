#!/usr/bin/env node
'use strict';

/**
 * Fast dev launcher.
 * Cold start: copy Electron + brand once.
 * Warm start: stamp check + spawn (no asar/rcedit redo).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const root = path.join(__dirname, '..');
const iconPath = path.join(root, 'build', 'icon.ico');
const logoPath = path.join(root, 'logo.png');
const distSrc = path.join(root, 'node_modules', 'electron', 'dist');
const distDst = path.join(root, 'build', 'utopia-dev');
const stampPath = path.join(distDst, '.sync-stamp');
const brandStampPath = path.join(distDst, '.brand-stamp');
const brandedCache = path.join(root, 'build', 'default_app.branded.asar');
const devExeName = 'Utopia Kingdom.exe';
const devExePath = path.join(distDst, devExeName);

function mtime(p) {
  try { return String(fs.statSync(p).mtimeMs); } catch (e) { return '0'; }
}

function readStamp(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
}

function writeStamp(p, value) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, value, 'utf8');
  } catch (e) {}
}

function runGenerateIcon() {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'generate-windows-icon.js')], {
    stdio: 'inherit',
    cwd: root
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function ensureIconIco() {
  if (!fs.existsSync(iconPath)) {
    runGenerateIcon();
    return;
  }
  if (fs.existsSync(logoPath) && fs.statSync(logoPath).mtimeMs > fs.statSync(iconPath).mtimeMs) {
    console.log('[start] logo.png changed; regenerating icon.ico');
    runGenerateIcon();
  }
}

function getRceditExe() {
  const binDir = path.join(root, 'node_modules', 'rcedit', 'bin');
  const x64 = path.join(binDir, 'rcedit-x64.exe');
  const x86 = path.join(binDir, 'rcedit.exe');
  if (process.arch === 'x64' && fs.existsSync(x64)) return x64;
  if (fs.existsSync(x86)) return x86;
  return null;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const stat = fs.statSync(from);
    if (stat.isDirectory()) copyDir(from, to);
    else {
      try {
        fs.copyFileSync(from, to);
      } catch (e) {
        if (e && e.code === 'EBUSY' && fs.existsSync(to)) continue;
        throw e;
      }
    }
  }
}

function runtimeStamp() {
  const electronPkg = require(path.join(root, 'node_modules', 'electron', 'package.json'));
  return [electronPkg.version, mtime(iconPath), mtime(logoPath)].join(':');
}

function brandStamp() {
  return ['v2', mtime(logoPath), mtime(iconPath)].join(':');
}

function brandLooksReady() {
  const asarPath = path.join(distDst, 'resources', 'default_app.asar');
  const resIcon = path.join(distDst, 'resources', 'icon.png');
  return fs.existsSync(devExePath)
    && fs.existsSync(asarPath)
    && fs.existsSync(resIcon)
    && readStamp(brandStampPath) === brandStamp();
}

async function patchDefaultAppIcon(distDir) {
  const resourcesDir = path.join(distDir, 'resources');
  const asarPath = path.join(resourcesDir, 'default_app.asar');
  const leftoverPath = path.join(resourcesDir, 'default_app.asar.patched');
  const srcAsar = path.join(distSrc, 'resources', 'default_app.asar');

  if (!fs.existsSync(logoPath)) return false;

  // Warm path: cached branded asar still matches logo
  const cacheFresh = fs.existsSync(brandedCache)
    && fs.statSync(brandedCache).mtimeMs >= fs.statSync(logoPath).mtimeMs
    && fs.statSync(brandedCache).size > 100;

  if (!fs.existsSync(asarPath)) {
    if (fs.existsSync(leftoverPath)) {
      fs.copyFileSync(leftoverPath, asarPath);
    } else if (cacheFresh) {
      fs.mkdirSync(resourcesDir, { recursive: true });
      fs.copyFileSync(brandedCache, asarPath);
    } else if (fs.existsSync(srcAsar)) {
      fs.mkdirSync(resourcesDir, { recursive: true });
      fs.copyFileSync(srcAsar, asarPath);
    } else {
      console.warn('[start] default_app.asar missing and cannot restore');
      return false;
    }
  }

  try {
    if (cacheFresh && fs.existsSync(asarPath)
      && fs.statSync(asarPath).size === fs.statSync(brandedCache).size
      && fs.statSync(asarPath).mtimeMs >= fs.statSync(logoPath).mtimeMs) {
      // Already branded — just ensure resources/icon.png
      try { fs.copyFileSync(logoPath, path.join(resourcesDir, 'icon.png')); } catch (e) {}
      return true;
    }

    // Rebuild branded cache only when logo/asar changed
    if (!cacheFresh) {
      const asar = require('@electron/asar');
      const tmp = path.join(root, 'build', '_default_app_patch');
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });

      const extractFrom = fs.existsSync(srcAsar) ? srcAsar : asarPath;
      asar.extractAll(extractFrom, tmp);
      fs.copyFileSync(logoPath, path.join(tmp, 'icon.png'));

      fs.rmSync(brandedCache, { force: true });
      await asar.createPackage(tmp, brandedCache);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(leftoverPath, { force: true });
    }

    if (!fs.existsSync(brandedCache) || fs.statSync(brandedCache).size < 100) {
      throw new Error('failed to build branded default_app.asar');
    }

    fs.copyFileSync(brandedCache, asarPath);
    try { fs.copyFileSync(logoPath, path.join(resourcesDir, 'icon.png')); } catch (e) {}
    console.log('[start] Branded default_app icon');
    return true;
  } catch (e) {
    console.warn('[start] Could not patch default_app.asar:', e && e.message ? e.message : e);
    return false;
  }
}

function patchExeIcon(exePath, rceditExe) {
  if (!rceditExe || !fs.existsSync(exePath)) return false;
  const patch = spawnSync(rceditExe, [
    exePath,
    '--set-icon', iconPath,
    '--set-version-string', 'ProductName', 'Utopia Kingdom',
    '--set-version-string', 'FileDescription', 'Utopia Kingdom',
    '--set-version-string', 'InternalName', 'Utopia Kingdom',
    '--set-version-string', 'OriginalFilename', devExeName
  ], { stdio: 'ignore', cwd: root });
  return patch.status === 0;
}

async function brandRuntime() {
  const baseExe = path.join(distDst, 'electron.exe');
  if (!fs.existsSync(devExePath) && fs.existsSync(baseExe)) {
    try { fs.copyFileSync(baseExe, devExePath); } catch (e) {}
  }

  await patchDefaultAppIcon(distDst);

  const rceditExe = getRceditExe();
  if (!rceditExe) {
    console.warn('[start] rcedit missing; .exe icon may stay as Electron');
  } else {
    if (fs.existsSync(baseExe)) patchExeIcon(baseExe, rceditExe);
    if (fs.existsSync(devExePath)) patchExeIcon(devExePath, rceditExe);
  }

  writeStamp(brandStampPath, brandStamp());
}

async function ensureDevRuntime() {
  const t0 = Date.now();

  if (!fs.existsSync(distSrc)) {
    console.error('[start] electron dist missing. Run: npm install');
    process.exit(1);
  }
  if (!fs.existsSync(logoPath)) {
    console.error('[start] logo.png missing');
    process.exit(1);
  }

  ensureIconIco();

  const stamp = runtimeStamp();
  const currentStamp = readStamp(stampPath);
  const needsCopy = currentStamp !== stamp || !fs.existsSync(devExePath);

  if (needsCopy) {
    console.log('[start] Preparing branded dev runtime...');
    try {
      if (fs.existsSync(distDst)) {
        try { fs.rmSync(distDst, { recursive: true, force: true }); } catch (e) {}
      }
      copyDir(distSrc, distDst);
    } catch (e) {
      if (e && e.code === 'EBUSY' && fs.existsSync(distDst)) {
        console.warn('[start] Dev runtime is in use; refreshing icons in place');
      } else {
        throw e;
      }
    }
    writeStamp(stampPath, stamp);
    // Force rebrand after fresh copy
    try { fs.rmSync(brandStampPath, { force: true }); } catch (e) {}
    console.log('[start] Dev runtime ready');
  }

  if (needsCopy || !brandLooksReady()) {
    await brandRuntime();
  }

  const ms = Date.now() - t0;
  console.log(needsCopy ? `[start] Cold start ready (${ms}ms)` : `[start] Warm start (${ms}ms)`);
}

function launchApp() {
  const env = { ...process.env, UTK_DEV_MODE: '1' };
  const venvPy = path.join(root, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPy)) {
    env.PYTHON_EXECUTABLE = venvPy;
  }

  if (!fs.existsSync(devExePath)) {
    console.error('[start] Missing', devExePath);
    process.exit(1);
  }

  const child = spawn(devExePath, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code == null ? 1 : code);
  });
}

ensureDevRuntime()
  .then(() => launchApp())
  .catch((err) => {
    console.error('[start] Failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
