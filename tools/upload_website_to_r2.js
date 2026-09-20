#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Allow credentials/config via a local .env file (optional)
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {}

function die(message) {
  console.error(message);
  process.exit(2);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml; charset=utf-8';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function cacheControlFor(key) {
  // Keep HTML fresh, cache assets aggressively.
  if (key === 'site/index.html' || key.endsWith('.html')) return 'no-store';
  return 'public, max-age=31536000, immutable';
}

function walkDir(rootDir) {
  const out = [];
  const skippedDirs = new Set(['node_modules', '.git', '.wrangler', 'dist', 'build']);
  function rec(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (skippedDirs.has(name)) continue;
        rec(full);
      }
      else if (st.isFile()) out.push(full);
    }
  }
  rec(rootDir);
  return out;
}

async function renderPageHtml(serverEntryPath, pathname) {
  const serverModule = await import(pathToFileURL(serverEntryPath).href);
  const server = serverModule.default;
  if (!server || typeof server.fetch !== 'function') {
    throw new Error(`Invalid server bundle: ${serverEntryPath}`);
  }

  const urlPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const response = await server.fetch(new Request(`https://utkingdom.com${urlPath}`));
  if (!response || !response.ok) {
    throw new Error(`Failed to render ${urlPath} from ${serverEntryPath} (status ${response && response.status})`);
  }

  return await response.text();
}

async function uploadRenderedHtml(opts) {
  const { useWrangler, client, bucket, workspaceRoot, key, html } = opts;
  if (useWrangler) {
    const tempPath = path.join(workspaceRoot, `.tmp-${key.replace(/[\\/]/g, '-')}`);
    fs.writeFileSync(tempPath, html, 'utf8');
    try {
      putFileWithWrangler(bucket, key, tempPath);
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  } else {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: html,
      ContentType: 'text/html; charset=utf-8',
      CacheControl: 'no-store',
    }));
  }
  console.log('→', key);
}

async function putFile(client, bucket, key, filePath) {
  const body = fs.createReadStream(filePath);
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentTypeFor(filePath),
    CacheControl: cacheControlFor(key),
  });
  await client.send(cmd);
}

function putFileWithWrangler(bucket, key, filePath) {
  const contentType = contentTypeFor(filePath);
  const cacheControl = cacheControlFor(key);
  const wranglerCacheControl = cacheControl.replace(/\s+/g, '');
  const wranglerContentType = contentType.replace(/\s+/g, '');
  const command = `npx --yes wrangler r2 object put ${bucket}/${key} --file ${filePath} --remote --content-type ${wranglerContentType} --cache-control ${wranglerCacheControl}`;
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', command], { stdio: 'inherit' })
    : spawnSync('npx', ['--yes', 'wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--file', filePath, '--remote', '--content-type', contentType, '--cache-control', cacheControl], { stdio: 'inherit' });

  if (result.status !== 0) {
    throw new Error(`Wrangler upload failed for ${key}`);
  }
}

async function main() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = (process.env.R2_BUCKET || 'utopia-downloads').trim();
  const useWrangler = !endpoint || !accessKeyId || !secretAccessKey;

  if (useWrangler) {
    console.log('R2 S3 creds not found; using Wrangler auth for upload.');
  }

  const workspaceRoot = path.join(__dirname, '..');
  const configuredSrcDir = process.env.SITE_SRC_DIR || 'website/dist/client';
  const srcDir = path.resolve(workspaceRoot, configuredSrcDir);
  if (!fs.existsSync(srcDir)) die(`Website folder not found: ${srcDir}`);

  const serverEntryPath = path.resolve(workspaceRoot, 'website/dist/server/server.js');
  const canRenderIndex = fs.existsSync(serverEntryPath);

  const client = useWrangler ? null : new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });

  const files = walkDir(srcDir);
  if (!files.length) die(`No files found under: ${srcDir}`);

  console.log(`Uploading website from ${srcDir} → r2://${bucket}/site/`);

  let hasIndexHtml = false;

  for (const filePath of files) {
    const rel = path.relative(srcDir, filePath).split(path.sep).join('/');
    if (rel === 'index.html') hasIndexHtml = true;
    // Skip obvious local-only files
    if (rel.endsWith('.ps1')) continue;
    if (rel.endsWith('.bak')) continue;
    // The Worker serves /updates/* dynamically; avoid publishing stale static metadata.
    if (rel === 'updates/latest.yml' || rel.startsWith('updates/')) continue;
    const key = `site/${rel}`;
    console.log('→', key);
    if (useWrangler) putFileWithWrangler(bucket, key, filePath);
    else await putFile(client, bucket, key, filePath);
  }

  // SSR pages the Worker can serve as site/<path>/index.html (or site/index.html).
  const pagesToRender = [
    { path: '/', key: 'site/index.html', skipIfPresent: hasIndexHtml },
    { path: '/windows-install', key: 'site/windows-install/index.html' },
    { path: '/mac-install', key: 'site/mac-install/index.html' },
    { path: '/ios-install', key: 'site/ios-install/index.html' },
  ];

  if (canRenderIndex) {
    for (const page of pagesToRender) {
      if (page.skipIfPresent) continue;
      const html = await renderPageHtml(serverEntryPath, page.path);
      await uploadRenderedHtml({
        useWrangler,
        client,
        bucket,
        workspaceRoot,
        key: page.key,
        html,
      });
    }
  } else if (!hasIndexHtml) {
    console.warn('No server bundle found; skipped SSR page render.');
  }

  console.log('Website upload complete.');
}

main().catch((err) => {
  console.error('Website upload failed:', err && err.message ? err.message : err);
  process.exit(3);
});
