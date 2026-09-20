#!/usr/bin/env node
/**
 * Upload macOS DMG (+ optional latest-mac.yml) to R2 for /download?os=mac
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

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

function parseLatestMacYmlForPath(text) {
  const match = String(text || '').match(/^path:\s*(.+)\s*$/m);
  if (!match) return null;
  return String(match[1] || '').trim().replace(/^['"]|['"]$/g, '');
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
  if (result.status !== 0) throw new Error(`Wrangler upload failed for ${key}`);
}

async function putObject(client, { bucket, key, filePath, contentType, cacheControl }) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

async function main() {
  const workspaceRoot = path.join(__dirname, '..');
  const pkg = require(path.join(workspaceRoot, 'package.json'));
  const version = (process.env.RELEASE_VERSION || pkg.version || '').trim();
  if (!version) die('Could not determine version.');

  const configuredOutDir = (pkg && pkg.build && pkg.build.directories && pkg.build.directories.output)
    ? String(pkg.build.directories.output)
    : 'dist';
  const buildOutDir = (process.env.BUILD_OUT_DIR || configuredOutDir).trim();

  const expectedName = `Utopia Kingdom-${version}-mac.dmg`;
  const latestMacPath = path.join(buildOutDir, 'latest-mac.yml');
  let dmgName = expectedName;
  if (exists(latestMacPath)) {
    const parsed = parseLatestMacYmlForPath(fs.readFileSync(latestMacPath, 'utf8'));
    if (parsed) dmgName = parsed;
  }

  let dmgPath = path.join(buildOutDir, dmgName);
  if (!exists(dmgPath)) {
    // Fallback: first .dmg in out dir
    const files = exists(buildOutDir) ? fs.readdirSync(buildOutDir) : [];
    const hit = files.find((f) => /\.dmg$/i.test(f));
    if (!hit) die(`DMG not found in ${buildOutDir}. Build first (npm run build:mac).`);
    dmgName = hit;
    dmgPath = path.join(buildOutDir, hit);
  }

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = (process.env.R2_BUCKET || process.env.UPDATES_BUCKET || 'utopia-downloads').trim();
  const useWrangler = !endpoint || !accessKeyId || !secretAccessKey;
  const uploadPrefix = (process.env.UPLOAD_PREFIX || `releases/v${version}`).replace(/^\/+|\/+$/g, '');

  const client = useWrangler ? null : new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });

  const uploads = [
    {
      key: `${uploadPrefix}/${dmgName}`,
      filePath: dmgPath,
      contentType: 'application/x-apple-diskimage',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  ];

  // Stable name so MAC_FILE_DOWNLOAD_URL / worker can use Utopia Kingdom-<ver>-mac.dmg
  if (dmgName !== expectedName) {
    uploads.push({
      key: `${uploadPrefix}/${expectedName}`,
      filePath: dmgPath,
      contentType: 'application/x-apple-diskimage',
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  if (exists(latestMacPath)) {
    uploads.push({
      key: `${uploadPrefix}/latest-mac.yml`,
      filePath: latestMacPath,
      contentType: 'text/yaml; charset=utf-8',
      cacheControl: 'no-store',
    });
    uploads.push({
      key: 'updates/latest-mac.yml',
      filePath: latestMacPath,
      contentType: 'text/yaml; charset=utf-8',
      cacheControl: 'no-store',
    });
  }

  console.log(`Uploading Mac DMG to bucket: ${bucket}`);
  for (const u of uploads) {
    console.log('→', u.key);
    if (useWrangler) {
      putFileWithWrangler(bucket, u.key, u.filePath, u.contentType, u.cacheControl);
    } else {
      await putObject(client, { bucket, ...u });
    }
  }

  const publicUrl = `https://utkingdom.com/releases/v${version}/${encodeURIComponent(expectedName)}`;
  console.log('Upload complete.');
  console.log('Mac download URL:');
  console.log(`  ${publicUrl}`);
  console.log('Set wrangler MAC_FILE_DOWNLOAD_URL (and APP_VERSION) then: npx wrangler deploy');
}

main().catch((err) => {
  console.error('Upload failed:', err && err.message ? err.message : err);
  process.exit(3);
});
