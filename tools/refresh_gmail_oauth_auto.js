/**
 * Non-interactive Gmail OAuth refresh (uses existing client_id/secret).
 * Opens browser → waits for localhost callback → saves creds + keytar.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const PORT = Number(process.env.GMAIL_OAUTH_PORT || 7000);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const APPDATA_PATH = path.join(process.env.APPDATA || '', 'Utopia Kingdom', 'email-credentials.json');
const LOCAL_PATH = path.join(__dirname, '..', 'email-credentials.json');

function loadExisting() {
  for (const p of [APPDATA_PATH, LOCAL_PATH]) {
    try {
      if (fs.existsSync(p)) return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch (e) {}
  }
  return null;
}

async function openBrowser(url) {
  try {
    const open = require('open');
    await open(url);
    return;
  } catch (e) {}
  // Windows fallback
  require('child_process').exec(`start "" "${url}"`);
}

(async () => {
  const existing = loadExisting();
  if (!existing) {
    console.error('No email-credentials.json found with client_id/secret');
    process.exit(1);
  }
  const CLIENT_ID = existing.data.client_id || existing.data.clientId;
  const CLIENT_SECRET = existing.data.client_secret || existing.data.clientSecret;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing client_id/client_secret in', existing.path);
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  });

  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url || !req.url.startsWith('/callback')) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h2>Auth failed</h2><p>${err}</p>`);
          reject(new Error(err));
          server.close();
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400);
          res.end('Missing code');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Success</h2><p>You can close this tab and return to Cursor.</p>');
        server.close();
        resolve(code);
      } catch (e) {
        reject(e);
      }
    });
    server.listen(PORT, () => {
      console.log(`Listening on http://localhost:${PORT}/callback`);
      console.log('Opening browser — sign in as utopiakingdomreal@gmail.com and click Allow…');
      console.log(authUrl);
      openBrowser(authUrl).catch(() => {});
    });
    setTimeout(() => {
      try { server.close(); } catch (e) {}
      reject(new Error('timeout waiting for OAuth (3 minutes)'));
    }, 3 * 60 * 1000);
  });

  const code = await codePromise;
  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    console.error('No refresh_token returned. Revoke app access at https://myaccount.google.com/permissions and retry with prompt=consent.');
    process.exit(1);
  }

  const result = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope || null,
    expiry_date: tokens.expiry_date || null,
    access_token: tokens.access_token || null,
  };

  const targets = [APPDATA_PATH, LOCAL_PATH];
  for (const p of targets) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(result, null, 2), 'utf8');
      console.log('Saved:', p);
    } catch (e) {
      console.warn('Failed saving', p, e.message);
    }
  }

  try {
    const keytar = require('keytar');
    await keytar.setPassword('Utopia Kingdom', 'refresh_token', result.refresh_token);
    console.log('Stored refresh token in OS keystore');
  } catch (e) {
    console.warn('keytar store skipped:', e.message);
  }

  // Write a temp file for wrangler (caller deletes)
  const out = path.join(__dirname, '..', '.tmp-gmail-refresh.txt');
  fs.writeFileSync(out, result.refresh_token, 'utf8');
  console.log('READY');
})().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
