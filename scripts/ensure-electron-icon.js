#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const iconPath = path.join(root, 'build', 'icon.ico');
const logoPath = path.join(root, 'logo.png');
const markerPath = path.join(root, 'build', '.electron-icon-patched');

function runGenerateIcon() {
  const script = path.join(__dirname, 'generate-windows-icon.js');
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: root });
  if (result.status !== 0) process.exit(result.status || 1);
}

function getRceditExe() {
  const binDir = path.join(root, 'node_modules', 'rcedit', 'bin');
  const x64 = path.join(binDir, 'rcedit-x64.exe');
  const x86 = path.join(binDir, 'rcedit.exe');
  if (process.arch === 'x64' && fs.existsSync(x64)) return x64;
  if (fs.existsSync(x86)) return x86;
  return null;
}

let electronPath = '';
try {
  electronPath = require('electron');
} catch (e) {
  process.exit(0);
}

if (process.platform !== 'win32') {
  process.exit(0);
}

if (!fs.existsSync(logoPath)) {
  console.warn('[icon] logo.png missing; skipping electron.exe icon patch');
  process.exit(0);
}

if (!fs.existsSync(iconPath)) {
  runGenerateIcon();
}

if (!fs.existsSync(iconPath)) {
  console.warn('[icon] build/icon.ico missing; skipping electron.exe icon patch');
  process.exit(0);
}

const rceditExe = getRceditExe();
if (!rceditExe) {
  console.warn('[icon] rcedit binary missing; run npm install');
  process.exit(0);
}

const iconStamp = `${fs.statSync(iconPath).mtimeMs}:${fs.statSync(logoPath).mtimeMs}`;
let markerStamp = '';
try {
  markerStamp = fs.readFileSync(markerPath, 'utf8').trim();
} catch (e) {}

if (markerStamp === iconStamp) {
  process.exit(0);
}

console.log('[icon] Patching electron.exe taskbar icon for npm start...');
const patch = spawnSync(rceditExe, [electronPath, '--set-icon', iconPath], {
  stdio: 'inherit',
  cwd: root
});

if (patch.status !== 0) {
  console.warn('[icon] rcedit failed; taskbar may still show the Electron logo in dev mode');
  process.exit(0);
}

try {
  fs.writeFileSync(markerPath, iconStamp, 'utf8');
} catch (e) {}

console.log('[icon] electron.exe icon updated');
