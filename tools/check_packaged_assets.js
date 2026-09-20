#!/usr/bin/env node
/*
  Build-time guard: ensure every local require('./...') dependency used by
  packaged entrypoints is included by electron-builder's build.files allowlist.

  Why: missing local modules in build.files can crash the renderer at startup,
  causing a black screen in the installed app.
*/

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob) {
  // Minimal glob support: **, *, and ?
  // - ** matches any path segments
  // - * matches within a single segment
  // - ? matches a single character within a segment
  const g = toPosix(glob);
  let out = '^';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    const next = g[i + 1];
    if (ch === '*' && next === '*') {
      out += '.*';
      i++;
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += escapeRegex(ch);
  }
  out += '$';
  return new RegExp(out);
}

function matchesPattern(pattern, relPosixPath) {
  const p = toPosix(pattern).replace(/^\.\//, '');
  const rel = toPosix(relPosixPath).replace(/^\.\//, '');

  // Fast path for directory include like "src/**"
  if (p.endsWith('/**')) {
    const prefix = p.slice(0, -3); // remove /**
    return rel === prefix || rel.startsWith(prefix + '/');
  }

  if (p.includes('*') || p.includes('?')) {
    return globToRegex(p).test(rel);
  }

  return rel === p;
}

function resolveLocalRequire(fromFileAbs, request) {
  const baseDir = path.dirname(fromFileAbs);
  const raw = String(request || '').trim();
  const absBase = path.resolve(baseDir, raw);

  // If it already has an extension, try as-is.
  const hasExt = path.extname(absBase);
  const candidates = [];

  if (hasExt) {
    candidates.push(absBase);
  } else {
    candidates.push(absBase + '.js');
    candidates.push(absBase + '.json');
    candidates.push(absBase + '.node');
    candidates.push(absBase); // may be a directory
  }

  for (const c of candidates) {
    try {
      const stat = fs.statSync(c);
      if (stat.isFile()) return c;
      if (stat.isDirectory()) {
        const idx = path.join(c, 'index.js');
        if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function readText(fileAbs) {
  return fs.readFileSync(fileAbs, 'utf8');
}

function main() {
  if (!fs.existsSync(packageJsonPath)) {
    console.error('[packaging-guard] package.json not found:', packageJsonPath);
    process.exit(2);
  }

  const pkg = JSON.parse(readText(packageJsonPath));
  const buildFiles = (pkg && pkg.build && Array.isArray(pkg.build.files)) ? pkg.build.files : [];
  const includePatterns = [];
  const excludePatterns = [];
  const packagedAs = new Set(); // dest names produced by { from, to } entries

  for (const entry of buildFiles) {
    if (typeof entry === 'string') {
      if (entry.startsWith('!')) excludePatterns.push(entry.slice(1));
      else includePatterns.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const toName = toPosix(String(entry.to || '').replace(/^\.\//, ''));
      const fromName = toPosix(String(entry.from || '').replace(/^\.\//, ''));
      if (toName) packagedAs.add(toName);
      if (fromName) includePatterns.push(fromName);
      if (toName && toName !== fromName) includePatterns.push(toName);
    }
  }

  // Entry points: scan the JS files that are explicitly allowlisted at repo root.
  const entryFiles = includePatterns
    .filter((p) => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p && !p.includes('*') && !p.includes('/') && p.toLowerCase().endsWith('.js'))
    .map((p) => path.join(projectRoot, p))
    .filter((abs) => fs.existsSync(abs));

  // Always include core entrypoints if present.
  const mustScan = ['main.js', 'renderer.js', 'preload.js', 'email-service.js', 'update-checker.js', 'index.html']
    .map((p) => path.join(projectRoot, p))
    .filter((abs) => fs.existsSync(abs));

  const scanSet = new Set([...entryFiles, ...mustScan]);
  const scanList = Array.from(scanSet);

  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const hrefCssRe = /href\s*=\s*['"]([^'"]+\.css)['"]/gi;

  const requiredFiles = new Set();
  const unresolved = [];

  for (const fileAbs of scanList) {
    let text;
    try {
      text = readText(fileAbs);
    } catch (e) {
      console.error('[packaging-guard] failed reading', fileAbs, e && e.message);
      process.exit(2);
    }

    let m;
    while ((m = requireRe.exec(text))) {
      const req = m[1];
      if (!req || typeof req !== 'string') continue;
      if (!req.startsWith('.')) continue; // only local requires

      const resolved = resolveLocalRequire(fileAbs, req);
      if (!resolved) {
        unresolved.push({ from: path.relative(projectRoot, fileAbs), request: req });
        continue;
      }

      const rel = toPosix(path.relative(projectRoot, resolved));
      requiredFiles.add(rel);
    }

    // Also ensure local stylesheets referenced from HTML are packaged.
    if (path.basename(fileAbs).toLowerCase().endsWith('.html')) {
      let hm;
      while ((hm = hrefCssRe.exec(text))) {
        const href = String(hm[1] || '').trim();
        if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('data:')) continue;
        const resolvedCss = resolveLocalRequire(fileAbs, href.startsWith('.') ? href : `./${href}`);
        if (!resolvedCss) {
          unresolved.push({ from: path.relative(projectRoot, fileAbs), request: href });
          continue;
        }
        requiredFiles.add(toPosix(path.relative(projectRoot, resolvedCss)));
      }
    }
  }

  function isIncluded(relPosix) {
    if (packagedAs.has(relPosix)) return true;
    const inc = includePatterns.some((p) => matchesPattern(p, relPosix));
    if (!inc) return false;
    const exc = excludePatterns.some((p) => matchesPattern(p, relPosix));
    return !exc;
  }

  const missingFromAllowlist = [];
  for (const rel of requiredFiles) {
    if (!isIncluded(rel)) missingFromAllowlist.push(rel);
  }

  if (unresolved.length) {
    console.error('[packaging-guard] Unresolved local requires (cannot verify packaging):');
    for (const u of unresolved.slice(0, 50)) {
      console.error(`  - ${u.from}: require('${u.request}')`);
    }
    if (unresolved.length > 50) {
      console.error(`  ...and ${unresolved.length - 50} more`);
    }
    console.error('[packaging-guard] Fix the require path(s), or add explicit extensions.');
    process.exit(1);
  }

  if (missingFromAllowlist.length) {
    console.error('[packaging-guard] Missing from electron-builder build.files allowlist:');
    for (const f of missingFromAllowlist) console.error('  - ' + f);
    console.error('[packaging-guard] Add the file(s) or a matching folder glob to package.json build.files.');
    process.exit(1);
  }

  const collectorDir = path.join(projectRoot, 'PO SSID Collector');
  const pythonEntryRel = [
    'PO SSID Collector/po_trade_worker.py',
    'PO SSID Collector/check_ssid.py',
    'PO SSID Collector/execute_trade.py',
    'PO SSID Collector/po_ssid.py'
  ];
  const pythonImportRe = /^(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  const pythonNeeded = new Set();
  const pythonQueue = pythonEntryRel.filter((rel) => fs.existsSync(path.join(projectRoot, rel)));
  const pythonSeen = new Set(pythonQueue);

  while (pythonQueue.length) {
    const rel = pythonQueue.pop();
    pythonNeeded.add(rel);
    let pyText = '';
    try { pyText = readText(path.join(projectRoot, rel)); } catch { continue; }
    pythonImportRe.lastIndex = 0;
    let pm;
    while ((pm = pythonImportRe.exec(pyText))) {
      const mod = pm[1];
      if (!mod || mod === 'from') continue;
      const localRel = toPosix(path.join('PO SSID Collector', `${mod}.py`));
      const localAbs = path.join(projectRoot, localRel);
      if (!fs.existsSync(localAbs)) continue;
      if (pythonSeen.has(localRel)) continue;
      pythonSeen.add(localRel);
      pythonQueue.push(localRel);
    }
  }

  const missingPython = [...pythonNeeded].filter((rel) => !isIncluded(rel)).sort();
  if (missingPython.length) {
    console.error('[packaging-guard] Pocket Option Python helpers missing from build.files:');
    for (const f of missingPython) console.error('  - ' + f);
    console.error('[packaging-guard] SSID connect will fail in the installed app until these are packaged.');
    process.exit(1);
  }

  // Never ship OAuth mail secrets inside the installer resources.
  const extraResources = (pkg && pkg.build && Array.isArray(pkg.build.extraResources)) ? pkg.build.extraResources : [];
  for (const entry of extraResources) {
    const fromName = toPosix(String((entry && entry.from) || entry || '')).toLowerCase();
    const toName = toPosix(String((entry && entry.to) || '')).toLowerCase();
    if (fromName.includes('email-credentials') || toName.includes('email-credentials')) {
      console.error('[packaging-guard] Refusing to package email-credentials.json via build.extraResources.');
      console.error('[packaging-guard] Verification mail must go through the Worker API, not installer-bundled OAuth tokens.');
      process.exit(1);
    }
    if (/serviceaccountkey\.json$/i.test(fromName) || /serviceaccountkey\.json$/i.test(toName)) {
      console.error('[packaging-guard] Refusing to package serviceAccountKey.json via build.extraResources.');
      process.exit(1);
    }
  }

  console.log(`[packaging-guard] OK (${scanList.length} entry files scanned, ${requiredFiles.size} local requires resolved, ${pythonNeeded.size} PO Python helpers)`);
}

main();
