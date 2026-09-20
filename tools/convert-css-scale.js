// tools/convert-css-scale.js
// A conservative CSS scaler: replaces remaining px-based font-size, padding, margin, gap, border-radius,
// widths/heights in selected CSS files with calc(... * var(--...)) using --font-scale, --spacing-scale, --scale-factor.
// It avoids affecting values already using calc(), var(), rem, em, %, minmax(), or within functions like minmax.

const fs = require('fs');
const path = require('path');

const workspaceRoot = process.cwd();
const targets = [
  'style.css',
  'connection-styles.css',
  'bot-styles.css',
  'extention/styles.css',
  'website/style.css'
].map(p => path.join(workspaceRoot, p)).filter(fs.existsSync);

function safeReplace(content) {
  // Avoid touching lines already containing calc or var or rem/em/% or minmax
  // Replace font-size: Npx; -> font-size: calc(Npx * var(--font-scale));
  content = content.replace(/(^|\n)(\s*font-size:\s*)([0-9]+(?:\.[0-9]+)?)px(\s*;)/g, (m, p1, p2, p3, p4, offset, s) => {
    const line = m;
    if (/calc\(|var\(|rem\b|em\b|%|minmax\(|--font-scale/.test(line)) return m;
    // Keep tiny text but still scale
    return `${p1}${p2}calc(${p3}px * var(--font-scale))${p4}`;
  });

  // gap: Npx;
  content = content.replace(/(^|\n)(\s*gap:\s*)([0-9]+(?:\.[0-9]+)?)px(\s*;)/g, (m,p1,p2,p3,p4) => {
    if (/calc\(|var\(|%|minmax\(/.test(m)) return m;
    return `${p1}${p2}calc(${p3}px * var(--spacing-scale))${p4}`;
  });

  // padding: Npx Npx; (supports 1-4 values)
  content = content.replace(/(^|\n)(\s*padding:\s*)([0-9px\.\s,\-]+)(\s*;)/g, (m,p1,p2,p3,p4) => {
    const raw = p3.trim();
    if (/calc\(|var\(|rem\b|em\b|%|minmax\(/.test(raw)) return m;
    // Convert each numeric px to calc(... * spacing-scale)
    const converted = raw.replace(/([0-9]+(?:\.[0-9]+)?)px/g, (mm, num) => `calc(${num}px * var(--spacing-scale))`);
    return `${p1}${p2}${converted}${p4}`;
  });

  // margin: Npx Npx;
  content = content.replace(/(^|\n)(\s*margin:\s*)([0-9px\.\s,\-]+)(\s*;)/g, (m,p1,p2,p3,p4) => {
    const raw = p3.trim();
    if (/calc\(|var\(|rem\b|em\b|%|minmax\(/.test(raw)) return m;
    const converted = raw.replace(/([0-9]+(?:\.[0-9]+)?)px/g, (mm, num) => `calc(${num}px * var(--spacing-scale))`);
    return `${p1}${p2}${converted}${p4}`;
  });

  // border-radius: Npx;
  content = content.replace(/(^|\n)(\s*border-radius:\s*)([0-9]+(?:\.[0-9]+)?)px(\s*;)/g, (m,p1,p2,p3,p4) => {
    if (/calc\(|var\(|%|minmax\(/.test(m)) return m;
    return `${p1}${p2}calc(${p3}px * var(--scale-factor))${p4}`;
  });

  // width: Npx;  (careful to avoid minmax and inline use inside functions)
  content = content.replace(/(^|\n)(\s*width:\s*)([0-9]+(?:\.[0-9]+)?)px(\s*;)/g, (m,p1,p2,p3,p4) => {
    if (/minmax\(|calc\(|var\(|%/.test(m)) return m;
    return `${p1}${p2}calc(${p3}px * var(--scale-factor))${p4}`;
  });

  // height: Npx;
  content = content.replace(/(^|\n)(\s*height:\s*)([0-9]+(?:\.[0-9]+)?)px(\s*;)/g, (m,p1,p2,p3,p4) => {
    if (/minmax\(|calc\(|var\(|%/.test(m)) return m;
    return `${p1}${p2}calc(${p3}px * var(--scale-factor))${p4}`;
  });

  // small-case:  padding-left/right/top/bottom
  content = content.replace(/(^|\n)(\s*(?:padding|margin)-(?:left|right|top|bottom):\s*)([0-9]+(?:\.[0-9]+)?)px(\s*;)/g, (m,p1,p2,p3,p4)=>{
    if (/calc\(|var\(|%|minmax\(/.test(m)) return m; return `${p1}${p2}calc(${p3}px * var(--spacing-scale))${p4}`;
  });

  return content;
}

for (const f of targets) {
  try {
    const original = fs.readFileSync(f, 'utf8');
    const transformed = safeReplace(original);
    if (transformed !== original) {
      fs.writeFileSync(`${f}.bak`, original, 'utf8');
      fs.writeFileSync(f, transformed, 'utf8');
      console.log('[convert-css-scale] Updated', f);
    } else {
      console.log('[convert-css-scale] No changes for', f);
    }
  } catch (e) {
    console.error('[convert-css-scale] Failed', f, e.message);
  }
}

// Now also convert inline style attributes in HTML and JS files where safe
const inlineTargets = [
  'index.html',
  'renderer.js',
  'auth-verification.js'
].map(p => path.join(workspaceRoot, p)).filter(fs.existsSync);

function convertInlineStyles(content) {
  // Replace font-size: Npx inside style="..."
  return content.replace(/(style\s*=\s*"[^"]*?)(font-size:\s*)([0-9]+(?:\.[0-9]+)?)px(\b)/g, (m,prefix,prop,num) => {
    const ctx = m;
    if (/calc\(|var\(/.test(ctx)) return m;
    return `${prefix}${prop}calc(${num}px * var(--font-scale))`;
  });
}

for (const f of inlineTargets) {
  try {
    const original = fs.readFileSync(f, 'utf8');
    const converted = convertInlineStyles(original);
    if (converted !== original) {
      fs.writeFileSync(`${f}.bak`, original, 'utf8');
      fs.writeFileSync(f, converted, 'utf8');
      console.log('[convert-css-scale] Updated inline styles in', f);
    } else {
      console.log('[convert-css-scale] No inline changes for', f);
    }
  } catch (e) {
    console.error('[convert-css-scale] Inline update failed for', f, e.message);
  }
}

console.log('Done. Review .bak files if you want to revert specific changes.');
