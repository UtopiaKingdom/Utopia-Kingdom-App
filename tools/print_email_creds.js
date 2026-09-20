// tools/print_email_creds.js
// Prints EMAIL_CLIENT_ID, EMAIL_CLIENT_SECRET and whether a refresh token is present.
const fs = require('fs');
const path = require('path');

function printEnv() {
  const id = process.env.EMAIL_CLIENT_ID || process.env.CLIENT_ID || '';
  const secret = process.env.EMAIL_CLIENT_SECRET || process.env.CLIENT_SECRET || '';
  const token = process.env.EMAIL_REFRESH_TOKEN || process.env.REFRESH_TOKEN || '';
  if (id || secret || token) {
    console.log('Found credentials in environment:');
    if (id) console.log('EMAIL_CLIENT_ID =', id);
    if (secret) console.log('EMAIL_CLIENT_SECRET =', secret);
    if (token) console.log('EMAIL_REFRESH_TOKEN =', token);
    return true;
  }
  return false;
}

function searchFiles() {
  const candidatePaths = [];
  if (process.env.EMAIL_CREDENTIALS_PATH) candidatePaths.push(process.env.EMAIL_CREDENTIALS_PATH);
  try {
    if (process.resourcesPath) {
      candidatePaths.push(path.join(process.resourcesPath, 'email-credentials.json'));
      candidatePaths.push(path.join(process.resourcesPath, 'app', 'email-credentials.json'));
    }
  } catch (e) {}
  candidatePaths.push(path.join(process.cwd(), 'email-credentials.json'));
  candidatePaths.push(path.join(__dirname, '..', 'email-credentials.json'));
  candidatePaths.push(path.join(__dirname, 'email-credentials.json'));

  for (const p of candidatePaths) {
    try {
      if (!p) continue;
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        const id = json.client_id || json.clientId || json.clientID || '';
        const secret = json.client_secret || json.clientSecret || json.clientSECRET || '';
        const refresh = json.refresh_token || json.refreshToken || json.refresh_token || '';
        console.log('\nFound credentials file at:', p);
        if (id) console.log('client_id =', id);
        if (secret) console.log('client_secret =', secret);
        if (refresh) console.log('refresh_token =', refresh);
        return true;
      }
    } catch (e) {
      // ignore parse errors
    }
  }
  return false;
}

if (!printEnv()) {
  const ok = searchFiles();
  if (!ok) {
    console.error('No client id/secret found in env or candidate credential files.');
    process.exit(2);
  }
}
else {
  // env printed; still attempt to show file locations with presence only
  try { searchFiles(); } catch (e) {}
}
