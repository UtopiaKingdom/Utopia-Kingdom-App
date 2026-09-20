/**
 * studio-paper-local.js — Honest Check on this PC (Contabo packs if present).
 * Load BEFORE bot-studio.js is not required; bot-studio calls window.__utkStudioPaper.
 */
(function () {
  'use strict';

  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');

  const TIMEOUT_MS = 900000;

  function repoRoot() {
    try {
      if (typeof __dirname === 'string' && __dirname) return __dirname;
    } catch (e) {}
    try {
      if (typeof process !== 'undefined' && process.cwd) return process.cwd();
    } catch (e2) {}
    return '.';
  }

  function pythonBin() {
    const root = repoRoot();
    const candidates = [
      path.join(root, '.venv', 'Scripts', 'python.exe'),
      path.join(root, '.venv', 'bin', 'python'),
    ];
    try {
      if (process.resourcesPath) {
        candidates.unshift(path.join(process.resourcesPath, 'venv', 'Scripts', 'python.exe'));
      }
    } catch (e) {}
    for (let i = 0; i < candidates.length; i++) {
      try {
        if (fs.existsSync(candidates[i])) return candidates[i];
      } catch (e2) {}
    }
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  function paperScript() {
    return path.join(repoRoot(), 'BotsHub', 'pipeline', 'studio_paper.py');
  }

  function candlesPresent() {
    try {
      const folder = path.join(repoRoot(), 'BotsHub', 'Prices', 'candles', '1m');
      return fs.existsSync(folder);
    } catch (e) {
      return false;
    }
  }

  function parseProgress(chunk, onProgress) {
    if (typeof onProgress !== 'function') return;
    const lines = String(chunk || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line[0] !== '{') continue;
      try {
        const row = JSON.parse(line);
        if (row && row.t === 'p') onProgress(row);
      } catch (e) {}
    }
  }

  function run(bot, onProgress) {
    return new Promise(function (resolve, reject) {
      const script = paperScript();
      if (!fs.existsSync(script)) {
        reject(new Error('paper_missing'));
        return;
      }
      if (!candlesPresent()) {
        reject(new Error('no_candles'));
        return;
      }
      const env = Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' });
      const child = spawn(pythonBin(), ['-u', script], {
        cwd: repoRoot(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env
      });
      let out = '';
      let err = '';
      let errBuf = '';
      let lastPct = 3;
      let lastProgressAt = Date.now();
      if (typeof onProgress === 'function') {
        onProgress({ t: 'p', i: 0, n: 18, pct: 3, label: 'Starting OTC packs' });
      }
      const beat = setInterval(function () {
        if (Date.now() - lastProgressAt < 900) return;
        lastPct = Math.min(88, lastPct + 0.6);
        if (typeof onProgress === 'function') {
          onProgress({ t: 'p', i: 0, n: 0, pct: lastPct, label: 'Reading OTC packs' });
        }
      }, 400);
      function stopChild() {
        try { clearInterval(beat); } catch (eBeat) {}
        try { clearTimeout(timer); } catch (eT) {}
      }
      const timer = setTimeout(function () {
        stopChild();
        try { child.kill(); } catch (e) {}
        reject(new Error('paper_timeout'));
      }, TIMEOUT_MS);
      function noteProgress(row) {
        lastProgressAt = Date.now();
        if (row && row.pct != null) lastPct = Number(row.pct) || lastPct;
      }
      child.stdout.on('data', function (buf) { out += String(buf || ''); });
      child.stderr.on('data', function (buf) {
        const text = String(buf || '');
        err += text;
        errBuf += text;
        const parts = errBuf.split(/\r?\n/);
        errBuf = parts.pop() || '';
        const chunk = parts.join('\n');
        if (chunk && chunk.indexOf('"t":"p"') >= 0) noteProgress({ pct: lastPct });
        parseProgress(chunk, function (row) {
          noteProgress(row);
          if (typeof onProgress === 'function') onProgress(row);
        });
      });
      child.on('error', function (e) {
        stopChild();
        reject(e || new Error('paper_spawn'));
      });
      child.on('close', function (code) {
        stopChild();
        if (code !== 0) {
          reject(new Error((err || out || 'paper_fail').slice(0, 180)));
          return;
        }
        const line = String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        try {
          const card = JSON.parse(line);
          if (!card || typeof card !== 'object') throw new Error('bad_card');
          if (typeof onProgress === 'function') {
            onProgress({ t: 'p', i: 1, n: 1, pct: 100, label: 'Done' });
          }
          resolve(card);
        } catch (e2) {
          reject(new Error('paper_parse'));
        }
      });
      try {
        child.stdin.write(JSON.stringify(bot || {}));
        child.stdin.end();
      } catch (e3) {
        try { child.kill(); } catch (e4) {}
        stopChild();
        reject(e3);
      }
    });
  }

  window.__utkStudioPaper = {
    run: run,
    available: function () {
      try { return fs.existsSync(paperScript()) && candlesPresent(); } catch (e) { return false; }
    }
  };
})();
