#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
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

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function parseLatestYmlForPath(latestYmlText) {
  // Minimal parser: look for a top-level `path:` line.
  // electron-builder emits: `path: Utopia Kingdom Setup 3.0.9.exe`
  const match = latestYmlText.match(/^path:\s*(.+)\s*$/m);
  if (!match) return null;
  const raw = (match[1] || '').trim();
  // strip surrounding quotes if present
  return raw.replace(/^['\"]|['\"]$/g, '');
}

async function putObject(client, { bucket, key, filePath, contentType, cacheControl }) {
  const body = fs.createReadStream(filePath);
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
  });
  await client.send(cmd);
}

function putFileWithWrangler(bucket, key, filePath, contentType, cacheControl) {
  const wranglerCacheControl = String(cacheControl || '').replace(/\s+/g, '');
  const wranglerContentType = String(contentType || 'application/octet-stream').replace(/\s+/g, '');
  const objectPath = `${bucket}/${key}`;
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
  const cmd = [
    'npx --yes wrangler r2 object put',
    q(objectPath),
    '--file', q(filePath),
    '--remote',
    '--content-type', wranglerContentType,
    '--cache-control', wranglerCacheControl,
  ].join(' ');
  const result = spawnSync(cmd, { stdio: 'inherit', shell: true, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler upload failed for ${key}`);
  }
}

async function main() {
  const workspaceRoot = path.join(__dirname, '..');
  const pkg = require(path.join(workspaceRoot, 'package.json'));

  const version = (process.env.RELEASE_VERSION || pkg.version || '').trim();
  if (!version) die('Could not determine version. Set RELEASE_VERSION or package.json version.');

  // Default to the electron-builder output directory used in package.json.
  const configuredOutDir = (pkg && pkg.build && pkg.build.directories && pkg.build.directories.output)
    ? String(pkg.build.directories.output)
    : '';
  const defaultOutDir = configuredOutDir || 'C:\\eb\\out';
  const buildOutDir = (process.env.BUILD_OUT_DIR || defaultOutDir).trim();

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = (process.env.R2_BUCKET || process.env.UPDATES_BUCKET || 'utopia-downloads').trim();
  const useWrangler = !endpoint || !accessKeyId || !secretAccessKey;

  if (useWrangler) {
    console.log('R2 S3 creds not found; using Wrangler auth for upload.');
  }

  const latestPath = path.join(buildOutDir, 'latest.yml');
  if (!exists(latestPath)) {
    die(`latest.yml not found at: ${latestPath}\nBuild first (npm run build:win) or set BUILD_OUT_DIR.`);
  }

  const latestText = readText(latestPath);
  const installerFileName = parseLatestYmlForPath(latestText);
  if (!installerFileName) {
    die('Could not parse installer filename from latest.yml (missing `path:`).');
  }

  const installerPath = path.join(buildOutDir, installerFileName);
  if (!exists(installerPath)) {
    die(`Installer not found: ${installerPath}`);
  }

  const blockmapPath = `${installerPath}.blockmap`;
  if (!exists(blockmapPath)) {
    console.warn('Warning: blockmap not found (differential updates may be disabled):', blockmapPath);
  }

  const zipName = `Utopia Kingdom-${version}-win.zip`;
  const zipPath = path.join(buildOutDir, zipName);
  const setupZipName = `Utopia Kingdom-Setup-${version}.zip`;
  const setupZipPath = path.join(buildOutDir, setupZipName);

  const uploadPrefix = (process.env.UPLOAD_PREFIX || `releases/v${version}`).replace(/^\/+|\/+$/g, '');

  const client = useWrangler ? null : new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });

  const uploads = [];
  // Put latest.yml under the version folder
  uploads.push({
    key: `${uploadPrefix}/latest.yml`,
    filePath: latestPath,
    contentType: 'text/yaml; charset=utf-8',
    cacheControl: 'no-store',
  });

  // Put the installer exe under the version folder with the *exact* filename
  uploads.push({
    key: `${uploadPrefix}/${installerFileName}`,
    filePath: installerPath,
    contentType: 'application/vnd.microsoft.portable-executable',
    cacheControl: 'public, max-age=31536000, immutable',
  });

  if (exists(blockmapPath)) {
    uploads.push({
      key: `${uploadPrefix}/${path.basename(blockmapPath)}`,
      filePath: blockmapPath,
      contentType: 'application/octet-stream',
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  // Optional portable zip (skip by default; set UPLOAD_ZIP=1 to include)
  if (process.env.UPLOAD_ZIP === '1') {
    const zipToUpload = exists(zipPath) ? { name: zipName, path: zipPath }
      : (exists(setupZipPath) ? { name: setupZipName, path: setupZipPath } : null);
    if (zipToUpload) {
      uploads.push({
        key: `${uploadPrefix}/${zipToUpload.name}`,
        filePath: zipToUpload.path,
        contentType: 'application/zip',
        cacheControl: 'public, max-age=31536000, immutable',
      });
    }
  }

  // Mirror the updater files to the stable /updates/ path consumed by app-update.yml.
  uploads.push({
    key: 'updates/latest.yml',
    filePath: latestPath,
    contentType: 'text/yaml; charset=utf-8',
    cacheControl: 'no-store',
  });
  uploads.push({
    key: `updates/${installerFileName}`,
    filePath: installerPath,
    contentType: 'application/vnd.microsoft.portable-executable',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  if (exists(blockmapPath)) {
    uploads.push({
      key: `updates/${path.basename(blockmapPath)}`,
      filePath: blockmapPath,
      contentType: 'application/octet-stream',
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  console.log(`Uploading to bucket: ${bucket}`);
  console.log(`Prefix: ${uploadPrefix}`);

  for (const u of uploads) {
    console.log('→', u.key);
    if (useWrangler) {
      putFileWithWrangler(bucket, u.key, u.filePath, u.contentType, u.cacheControl);
    } else {
      await putObject(client, { bucket, ...u });
    }
  }

  console.log('Upload complete.');
  console.log('Tip: your worker serves assets at /releases/... so the EXE URL will be like:');
  console.log(`  https://utkingdom.com/releases/v${version}/${encodeURIComponent(installerFileName).replace(/%2F/g, '/')}`);
}

main().catch((err) => {
  console.error('Upload failed:', err && err.message ? err.message : err);
  process.exit(3);
});
