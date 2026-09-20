const fs = require('fs');
const s = fs.readFileSync('auth-verification.js','utf8');
let idx = 0;
const results = [];
while (true) {
  const i = s.indexOf('try', idx);
  if (i === -1) break;
  // ensure it's a word boundary
  const before = s[i-1];
  const after = s[i+3];
  if (before && /[A-Za-z0-9_$]/.test(before)) { idx = i+3; continue; }
  if (after && /[A-Za-z0-9_$]/.test(after)) { idx = i+3; continue; }
  // find opening brace
  let j = s.indexOf('{', i);
  if (j === -1) { results.push({pos:i, reason:'no opening brace'}); break; }
  // match braces
  let depth = 0;
  let k = j;
  let inSingle=false, inDouble=false, inBack=false, inRegex=false;
  while (k < s.length) {
    const ch = s[k];
    const prev = s[k-1];
    if (!inSingle && !inDouble && !inBack && ch === '/') {
      // naive detect comment or regex: if next is / or * it's comment
      const next = s[k+1];
      if (next === '/') { // line comment, skip to endline
        k = s.indexOf('\n', k+2);
        if (k === -1) k = s.length; continue;
      } else if (next === '*') { // block comment
        const end = s.indexOf('*/', k+2);
        if (end === -1) { k = s.length; break; } else { k = end+2; continue; }
      }
    }
    if (!inDouble && !inBack && ch === '\'') { inSingle = !inSingle; }
    else if (!inSingle && !inBack && ch === '\"') { inDouble = !inDouble; }
    else if (!inSingle && !inDouble && ch === '`') { inBack = !inBack; }
    if (!inSingle && !inDouble && !inBack) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { k++; break; }
      }
    }
    k++;
  }
  // skip whitespace/comments to find next token
  let m = k;
  while (m < s.length) {
    const ch = s[m];
    if (/\s/.test(ch)) { m++; continue; }
    // check for comments
    if (ch === '/') {
      const next = s[m+1];
      if (next === '/') { m = s.indexOf('\n', m+2); if (m === -1) m = s.length; continue; }
      if (next === '*') { const end = s.indexOf('*/', m+2); if (end === -1) { m = s.length; break;} m = end+2; continue; }
    }
    break;
  }
  const look = s.substring(m, m+10);
  const hasCatch = look.startsWith('catch');
  const hasFinally = look.startsWith('finally');
  if (!hasCatch && !hasFinally) {
    // record line number
    const lines = s.substring(0,i).split('\n').length;
    results.push({pos:i, line: lines, snippet: s.substring(i, m+30)});
  }
  idx = m;
}
console.log('Found', results.length, 'try blocks without catch/finally:');
for (const r of results) {
  console.log('----');
  console.log('line', r.line);
  const lines = s.split('\n');
  const start = Math.max(0, r.line - 4);
  const end = Math.min(lines.length, r.line + 3);
  for (let i=start;i<end;i++) console.log((i+1).toString().padStart(5)+':', lines[i]);
}
