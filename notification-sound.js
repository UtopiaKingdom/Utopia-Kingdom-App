const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SOUND_DIR = path.join(__dirname, 'assets', 'sounds');
const SOUND_CANDIDATES = ['signal.wav', 'signal.mp3', 'signal.ogg', 'signal.m4a', 'signal.aac'];
const CHIME_CANDIDATES = ['signal-chime.wav', 'signal-chime.mp3', 'signal-chime.ogg', 'signal-chime.m4a'];

let soundWindow = null;
let logFn = null;

function setNotificationSoundLogger(fn) {
  logFn = typeof fn === 'function' ? fn : null;
}

function soundLog(level, message, extra) {
  try {
    if (logFn) logFn(level, message, extra);
  } catch {}
}

function createSignalWavBuffer() {
  const sampleRate = 44100;
  const duration = 0.45;
  const samples = Math.floor(sampleRate * duration);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    let sample = 0;

    if (t < 0.12) {
      const env = Math.sin((Math.PI * t) / 0.12) * Math.exp(-t * 6);
      sample += Math.sin(2 * Math.PI * 880 * t) * env * 0.45;
    }
    if (t >= 0.15 && t < 0.38) {
      const localT = t - 0.15;
      const env = Math.sin((Math.PI * localT) / 0.23) * Math.exp(-localT * 5);
      sample += Math.sin(2 * Math.PI * 1174 * localT) * env * 0.4;
    }

    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.floor(clamped * 32767), 44 + i * 2);
  }

  return buffer;
}

function createChimeWavBuffer() {
  const sampleRate = 44100;
  const duration = 0.55;
  const samples = Math.floor(sampleRate * duration);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    let sample = 0;

    if (t < 0.1) {
      const env = Math.sin((Math.PI * t) / 0.1) * Math.exp(-t * 5);
      sample += Math.sin(2 * Math.PI * 1318 * t) * env * 0.42;
    }
    if (t >= 0.12 && t < 0.28) {
      const localT = t - 0.12;
      const env = Math.sin((Math.PI * localT) / 0.16) * Math.exp(-localT * 4);
      sample += Math.sin(2 * Math.PI * 1568 * localT) * env * 0.38;
    }
    if (t >= 0.3 && t < 0.5) {
      const localT = t - 0.3;
      const env = Math.sin((Math.PI * localT) / 0.2) * Math.exp(-localT * 3.5);
      sample += Math.sin(2 * Math.PI * 2093 * localT) * env * 0.32;
    }

    const clamped = Math.max(-1, Math.min(1, sample));
    buffer.writeInt16LE(Math.floor(clamped * 32767), 44 + i * 2);
  }

  return buffer;
}

function ensureDefaultSounds() {
  try {
    fs.mkdirSync(SOUND_DIR, { recursive: true });
    const signalPath = path.join(SOUND_DIR, 'signal.wav');
    if (!fs.existsSync(signalPath)) {
      fs.writeFileSync(signalPath, createSignalWavBuffer());
    }
    const chimePath = path.join(SOUND_DIR, 'signal-chime.wav');
    if (!fs.existsSync(chimePath)) {
      fs.writeFileSync(chimePath, createChimeWavBuffer());
    }
  } catch (e) {
    soundLog('warn', '[NotificationSound] Failed to ensure default sound', e && e.message);
  }
}

function detectAudioKind(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);

    if (header.slice(0, 4).toString('ascii') === 'RIFF' && header.slice(8, 12).toString('ascii') === 'WAVE') {
      return 'wav';
    }
    if (header.slice(0, 3).toString('ascii') === 'ID3') {
      return 'mp3';
    }
    if (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) {
      return 'mp3';
    }
    if (header.slice(0, 4).toString('ascii') === 'OggS') {
      return 'ogg';
    }
    if (header.slice(4, 8).toString('ascii') === 'ftyp') {
      return 'm4a';
    }
  } catch {}

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return 'mp3';
  if (ext === '.ogg') return 'ogg';
  if (ext === '.m4a' || ext === '.aac') return 'm4a';
  return 'wav';
}

function resolveSoundPath(preferred) {
  ensureDefaultSounds();

  const list = preferred === 'chime' ? CHIME_CANDIDATES.concat(SOUND_CANDIDATES) : SOUND_CANDIDATES;
  for (const fileName of list) {
    const candidate = path.join(SOUND_DIR, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getPlayableSoundPath(soundPath) {
  if (!soundPath || !fs.existsSync(soundPath)) return null;
  if (!soundPath.includes('.asar')) return soundPath;

  try {
    const { app } = require('electron');
    const tempDir = app && typeof app.getPath === 'function'
      ? path.join(app.getPath('temp'), 'utk-sounds')
      : path.join(require('os').tmpdir(), 'utk-sounds');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, path.basename(soundPath));
    const sourceStat = fs.statSync(soundPath);
    const tempStat = fs.existsSync(tempPath) ? fs.statSync(tempPath) : null;
    if (!tempStat || tempStat.mtimeMs < sourceStat.mtimeMs || tempStat.size !== sourceStat.size) {
      fs.copyFileSync(soundPath, tempPath);
    }
    return tempPath;
  } catch {
    return soundPath;
  }
}

function destroySoundWindow() {
  try {
    if (soundWindow && !soundWindow.isDestroyed()) {
      soundWindow.destroy();
    }
  } catch {}
  soundWindow = null;
}

function playWithElectron(filePath) {
  const { BrowserWindow } = require('electron');
  const src = pathToFileURL(path.resolve(filePath)).href;
  const playerHtml = path.join(__dirname, 'sound-player.html');
  if (!fs.existsSync(playerHtml)) {
    soundLog('error', '[NotificationSound] Missing sound-player.html');
    return false;
  }

  destroySoundWindow();

  soundWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    focusable: false,
    frame: false,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  soundWindow.on('closed', () => {
    soundWindow = null;
  });

  const cleanupTimer = setTimeout(() => {
    destroySoundWindow();
  }, 20000);

  soundWindow.once('closed', () => {
    clearTimeout(cleanupTimer);
  });

  soundWindow.loadFile(playerHtml, {
    hash: encodeURIComponent(src),
  }).catch((err) => {
    clearTimeout(cleanupTimer);
    soundLog('error', '[NotificationSound] Failed to load sound player', err && err.message);
    destroySoundWindow();
  });

  return true;
}

function playNotificationSound(preferred) {
  const soundPath = getPlayableSoundPath(resolveSoundPath(preferred));
  if (!soundPath) {
    soundLog('warn', '[NotificationSound] No sound file found');
    return false;
  }

  const kind = detectAudioKind(soundPath);
  soundLog('info', `[NotificationSound] Playing ${path.basename(soundPath)} (${kind})`);

  try {
    return playWithElectron(soundPath);
  } catch (e) {
    soundLog('error', '[NotificationSound] Playback failed', e && e.message);
    return false;
  }
}

module.exports = {
  ensureDefaultSounds,
  playNotificationSound,
  resolveSoundPath,
  setNotificationSoundLogger,
};
