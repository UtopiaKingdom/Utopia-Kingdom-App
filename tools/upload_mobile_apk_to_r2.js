/**
 * Upload Android APK to R2 as UtopiaKingdom-<version>.apk
 * Also refreshes the legacy UtopiaKingdom-android.apk alias.
 *
 * Usage:
 *   node tools/upload_mobile_apk_to_r2.js [path-to-apk] [version]
 *
 * Version defaults to MOBILE_APP_VERSION from wrangler.toml
 */
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch {}

function die(msg) {
  console.error(msg);
  process.exit(2);
}

function readMobileVersionFromWrangler() {
  try {
    const toml = fs.readFileSync(path.join(__dirname, '..', 'wrangler.toml'), 'utf8');
    const m = toml.match(/MOBILE_APP_VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

async function putObject(client, bucket, key, filePath) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: 'application/vnd.android.package-archive',
      CacheControl: 'no-store',
      ContentDisposition: `attachment; filename="${path.basename(key)}"`,
    }),
  );
}

async function main() {
  const apkPath = path.resolve(
    process.argv[2] || path.join(__dirname, '..', '.tmp', 'mobile-release', 'UtopiaKingdom-android.apk'),
  );
  if (!fs.existsSync(apkPath)) die(`APK not found: ${apkPath}`);

  const version = String(process.argv[3] || readMobileVersionFromWrangler() || '').trim();
  if (!version) die('Missing version. Pass as arg or set MOBILE_APP_VERSION in wrangler.toml');

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = (process.env.R2_BUCKET || 'utopia-downloads').trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    die('Missing R2 creds. Set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.');
  }

  const versionedKey = `releases/mobile/UtopiaKingdom-${version}.apk`;
  const legacyKey = 'releases/mobile/UtopiaKingdom-android.apk';
  const client = new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });

  const size = fs.statSync(apkPath).size;
  console.log(`Uploading ${apkPath} (${size} bytes)`);
  console.log(` → s3://${bucket}/${versionedKey}`);
  await putObject(client, bucket, versionedKey, apkPath);
  console.log(` → s3://${bucket}/${legacyKey} (legacy alias)`);
  await putObject(client, bucket, legacyKey, apkPath);

  console.log('Upload complete.');
  console.log(`Public URL: https://utkingdom.com/releases/mobile/UtopiaKingdom-${version}.apk`);
  console.log(`Download page: https://utkingdom.com/download/android`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(3);
});
