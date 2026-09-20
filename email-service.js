// Email service for sending verification codes
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
let keytar = null;
let credFileHadRefresh = false;
try { keytar = require('keytar'); } catch (e) {}

// Load OAuth2 credentials from env vars or credentials file to avoid hard-coded secrets
let CLIENT_ID = process.env.EMAIL_CLIENT_ID || '';
let CLIENT_SECRET = process.env.EMAIL_CLIENT_SECRET || '';
let REFRESH_TOKEN = process.env.EMAIL_REFRESH_TOKEN || '';
let REDIRECT_URI = process.env.EMAIL_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

function isPackagedDesktop() {
  try {
    const electronApp = require('electron').app;
    return !!(electronApp && electronApp.isPackaged);
  } catch (_) {
    return false;
  }
}

const PACKAGED = isPackagedDesktop();

// Candidate paths to look for `email-credentials.json` in development setups only.
// Packaged installs must NEVER ship or hunt OAuth refresh tokens on disk.
const candidateCredPaths = [];
if (process.env.EMAIL_CREDENTIALS_PATH) candidateCredPaths.push(process.env.EMAIL_CREDENTIALS_PATH);

if (!PACKAGED) {
  // Dev / unpackaged: AppData + project paths are OK for local testing.
  try {
    let electronApp = null;
    try { electronApp = require('electron').app; } catch (e) { electronApp = null; }
    let appDataPath = process.env.APPDATA || (process.platform === 'win32' ? path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming') : null);
    let userDataPath = null;
    if (electronApp && typeof electronApp.getPath === 'function') {
      try { appDataPath = electronApp.getPath('appData') || appDataPath; } catch (e) {}
      try { userDataPath = electronApp.getPath('userData'); } catch (e) {}
    }
    if (appDataPath) candidateCredPaths.push(path.join(appDataPath, 'Utopia Kingdom', 'email-credentials.json'));
    if (userDataPath) candidateCredPaths.push(path.join(userDataPath, 'email-credentials.json'));
  } catch (e) {}

  candidateCredPaths.push(path.join(process.cwd(), 'email-credentials.json'));
  candidateCredPaths.push(path.join(__dirname, 'email-credentials.json'));
}

let CRED_PATH = null;
// Prefer an existing credentials file that contains a refresh_token
const existing = [];
for (const p of candidateCredPaths) {
  try { if (p && fs.existsSync(p)) existing.push(p); } catch (e) {}
}
for (const p of existing) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (data && (data.refresh_token || data.refreshToken)) { CRED_PATH = p; break; }
  } catch (e) { /* ignore parse errors here */ }
}
// If none with refresh_token found, fall back to the first existing path
if (!CRED_PATH && existing.length) CRED_PATH = existing[0];

// Do not copy OAuth credentials around (especially not into user AppData).

// Try to load credentials file if present (dev / unpackaged only)
try {
  if (CRED_PATH && !PACKAGED) {
    const raw = fs.readFileSync(CRED_PATH, 'utf8');
    const data = JSON.parse(raw);
    // file format from helper includes refresh_token, access_token, expiry_date
    CLIENT_ID = CLIENT_ID || data.client_id || data.clientId || '';
    CLIENT_SECRET = CLIENT_SECRET || data.client_secret || data.clientSecret || '';
    REFRESH_TOKEN = REFRESH_TOKEN || data.refresh_token || data.refreshToken || '';
    if (data.redirect_uri) REDIRECT_URI = data.redirect_uri;
    credFileHadRefresh = !!(data && (data.refresh_token || data.refreshToken));
    const hasRefresh = credFileHadRefresh;
    console.log('[Email] Credentials loaded from', CRED_PATH, hasRefresh ? '(refresh token ok)' : '(no refresh token)');
  }
} catch (err) {
  console.error('Failed to read email credentials file:', err.message || err);
}

// Verbose credential diagnostics only when explicitly enabled
(function logCredentialDiagnostics() {
  if (process.env.UTK_EMAIL_DEBUG !== '1') return;
  try {
    const foundFiles = [];
    for (const p of candidateCredPaths) {
      try { if (p && fs.existsSync(p)) foundFiles.push(p); } catch (e) {}
    }
    console.log('[Email] Credential diagnostics:');
    console.log('  EMAIL_CREDENTIALS_PATH=', process.env.EMAIL_CREDENTIALS_PATH ? '(set)' : '(not set)');
    console.log('  Candidate paths:', candidateCredPaths.length);
    console.log('  Found files:', foundFiles.length ? foundFiles : '(none)');
    console.log('  keytar available=', !!keytar);
  } catch (e) {}
})();

// Warn if using hard-coded fallbacks (dev only — packaged builds use Worker mail)
if (!PACKAGED && (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN)) {
  console.warn('Warning: Local email credentials incomplete. Packaged builds send mail via Worker; for local fallback set EMAIL_* or email-credentials.json.');
}

// Normalize and trim the refresh token so empty/whitespace values are treated as missing
REFRESH_TOKEN = (REFRESH_TOKEN || '').toString().trim();

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
if (REFRESH_TOKEN) {
  oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
}

function collectCredentialVariants() {
  const variants = [];
  const seen = new Set();

  function addVariant(v) {
    if (!v) return;
    const clientId = String(v.clientId || '').trim();
    const clientSecret = String(v.clientSecret || '').trim();
    const refreshToken = String(v.refreshToken || '').trim();
    const redirectUri = String(v.redirectUri || REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob').trim();
    if (!clientId || !clientSecret || !refreshToken) return;
    const key = `${clientId}|${clientSecret}|${refreshToken}|${redirectUri}`;
    if (seen.has(key)) return;
    seen.add(key);
    variants.push({ source: v.source || 'unknown', clientId, clientSecret, refreshToken, redirectUri });
  }

  addVariant({
    source: 'active',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH_TOKEN,
    redirectUri: REDIRECT_URI,
  });

  const envClientId = String(process.env.EMAIL_CLIENT_ID || process.env.CLIENT_ID || '').trim();
  const envClientSecret = String(process.env.EMAIL_CLIENT_SECRET || process.env.CLIENT_SECRET || '').trim();
  const envRefresh = String(process.env.EMAIL_REFRESH_TOKEN || process.env.REFRESH_TOKEN || '').trim();
  const envRedirect = String(process.env.EMAIL_REDIRECT_URI || '').trim();
  addVariant({
    source: 'env',
    clientId: envClientId,
    clientSecret: envClientSecret,
    refreshToken: envRefresh,
    redirectUri: envRedirect || REDIRECT_URI,
  });

  for (const p of candidateCredPaths) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      const data = JSON.parse(raw);
      addVariant({
        source: p,
        clientId: data.client_id || data.clientId,
        clientSecret: data.client_secret || data.clientSecret,
        refreshToken: data.refresh_token || data.refreshToken,
        redirectUri: data.redirect_uri || REDIRECT_URI,
      });
    } catch (e) {
      // ignore unreadable credentials
    }
  }

  return variants;
}

async function createTransporter() {
  // Defensive: ensure OAuth credentials are present before attempting refresh
  // If keytar is available, try to obtain stored refresh token from OS keystore
  if (keytar && !REFRESH_TOKEN) {
    try {
      const stored = await keytar.getPassword('Utopia Kingdom', 'refresh_token');
      if (stored) {
        REFRESH_TOKEN = String(stored || '').trim();
        console.log('Loaded refresh token from OS keystore');
        try { oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN }); } catch (e) {}
      }
    } catch (e) { /* ignore */ }
  }

  // If keytar is not available, warn and continue using file-based token if present
  if (!keytar) {
    console.warn('keytar not available: will use credentials file if present (ensure email-credentials.json contains a refresh_token)');
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Email service not configured: missing EMAIL_CLIENT_ID / EMAIL_CLIENT_SECRET / EMAIL_REFRESH_TOKEN. To generate a refresh token run: node tools/get_gmail_refresh_token.js');
  }

  // Attempt to obtain an access token and provide a clearer error if OAuth is misconfigured
  let accessToken;
  try {
    accessToken = await oAuth2Client.getAccessToken();
  } catch (err) {
    // If OAuth fails due to invalid_client/invalid_grant, attempt dev-friendly fallbacks:
    const msg = String(err && err.message || err || '');
    if (/invalid_client|invalid_grant/i.test(msg)) {
      console.warn('Email OAuth invalid_client/invalid_grant:', msg);
      // Try alternate credential sources (env/file variants) before falling back.
      const variants = collectCredentialVariants();
      for (const v of variants) {
        try {
          if (
            v.clientId === String(CLIENT_ID || '').trim() &&
            v.clientSecret === String(CLIENT_SECRET || '').trim() &&
            v.refreshToken === String(REFRESH_TOKEN || '').trim() &&
            v.redirectUri === String(REDIRECT_URI || '').trim()
          ) {
            continue;
          }
          const altClient = new google.auth.OAuth2(v.clientId, v.clientSecret, v.redirectUri);
          altClient.setCredentials({ refresh_token: v.refreshToken });
          const altToken = await altClient.getAccessToken();
          const altAccessToken = altToken && altToken.token;
          if (!altAccessToken) continue;

          console.log('Recovered email OAuth using credential source:', v.source);
          CLIENT_ID = v.clientId;
          CLIENT_SECRET = v.clientSecret;
          REFRESH_TOKEN = v.refreshToken;
          REDIRECT_URI = v.redirectUri;
          try { oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN }); } catch (e) {}

          return nodemailer.createTransport({
            service: 'gmail',
            auth: {
              type: 'OAuth2',
              user: 'utopiakingdomreal@gmail.com',
              clientId: CLIENT_ID,
              clientSecret: CLIENT_SECRET,
              refreshToken: REFRESH_TOKEN,
              accessToken: altAccessToken,
            }
          });
        } catch (e) {
          // try next variant
        }
      }

      // If SMTP env vars are provided, use SMTP transport as a fallback
      const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_SMTP_HOST;
      const smtpPort = process.env.SMTP_PORT || process.env.EMAIL_SMTP_PORT;
      const smtpUser = process.env.SMTP_USER || process.env.EMAIL_SMTP_USER;
      const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_SMTP_PASS;
      if (smtpHost && smtpPort && smtpUser && smtpPass) {
        console.log('Using SMTP fallback for email via env SMTP_HOST');
        return nodemailer.createTransport({
          host: smtpHost,
          port: parseInt(smtpPort, 10) || 587,
          secure: (smtpPort === '465'),
          auth: { user: smtpUser, pass: smtpPass }
        });
      }
      // In development, allow a console/json transport so registration can proceed locally
      if (process.env.NODE_ENV !== 'production' || process.env.DEV_EMAIL_ALLOW_STUB === '1') {
        console.warn('Falling back to console/json email transport for development (emails will be logged, not sent).');
        return nodemailer.createTransport({ jsonTransport: true });
      }
    }
    // Otherwise rethrow original error with guidance
    if (err && /refresh token|No refresh token/i.test(msg)) {
      throw new Error('Email OAuth error: missing or invalid refresh token. Run `node tools/get_gmail_refresh_token.js` and set `EMAIL_REFRESH_TOKEN` or add `email-credentials.json` with `refresh_token`.');
    }
    throw err;
  }

  try {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: 'utopiakingdomreal@gmail.com',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken && accessToken.token
      }
    });
  } catch (err) {
    const msg = String(err && err.message || err || '');
    if (/No refresh token or refresh handler callback is set|missing refresh token/i.test(msg)) {
      throw new Error('Email OAuth error: missing refresh token. Generate one with `node tools/get_gmail_refresh_token.js` or add a `refresh_token` to `email-credentials.json`.');
    }
    throw err;
  }
} 

// After successful creation, attempt to migrate refresh token into OS keystore
async function migrateRefreshToKeystore() {
  if (!keytar) return;
  try {
    if (credFileHadRefresh && REFRESH_TOKEN) {
      await keytar.setPassword('Utopia Kingdom', 'refresh_token', REFRESH_TOKEN);
      console.log('Stored refresh token in OS keystore (keytar)');
      // NOTE: We intentionally do not remove refresh_token from the credentials file.
      // keytar can be unavailable in packaged apps (native module), and deleting the token
      // would break email sending entirely.
    }
  } catch (e) {
    console.warn('Failed to store refresh token in OS keystore:', e && e.message ? e.message : e);
  }
}

// Attempt migration when module is loaded/used (non-blocking)
(async () => {
  try { await migrateRefreshToKeystore(); } catch (e) {}
})();

const DEFAULT_AUTH_EMAIL_API_URL = 'https://utkingdom.com/api/auth/send-verification-code';

/** Prefer Cloudflare Worker so packaged installs do not need local Gmail OAuth files. */
async function sendViaWorker(email, code) {
  const url = (process.env.AUTH_EMAIL_API_URL || DEFAULT_AUTH_EMAIL_API_URL).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code }),
      signal: controller.signal,
    });
    let data = {};
    try { data = await resp.json(); } catch (_) { data = {}; }
    if (!resp.ok || !data.ok) {
      const msg = (data && (data.message || data.error)) || `Worker email failed (${resp.status})`;
      throw new Error(msg);
    }
    console.log('✅ Verification code email sent via Worker to:', email);
    return { success: true, via: 'worker' };
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaLocalTransporter(email, code) {
  const transporter = await createTransporter();
  const mailOptions = {
    from: 'Utopia Kingdom <utopiakingdomreal@gmail.com>',
    to: email,
    subject: 'Your Utopia Kingdom Verification Code',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; background: #0a0a14; color: #fff; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; background: #121212; border-radius: 10px; border: 1px solid #333; }
          .header { text-align: center; margin-bottom: 30px; }
          .logo { font-size: 24px; font-weight: bold; color: #00ff88; }
          .code-box { background: #1a1a24; border: 2px solid #00ff88; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0; }
          .code { font-size: 48px; font-weight: bold; color: #00ff88; letter-spacing: 10px; }
          .text { font-size: 14px; color: #9aa0a6; line-height: 1.6; }
          .footer { text-align: center; font-size: 12px; color: #666; margin-top: 30px; border-top: 1px solid #333; padding-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">🚀 UTOPIA KINGDOM</div>
            <p style="color: #9aa0a6; margin: 5px 0;">Where Trading Meets Innovation</p>
          </div>
          
          <p class="text">Welcome to Utopia Kingdom!</p>
          <p class="text">Your verification code is ready. Enter this code in the app to complete your registration:</p>
          
          <div class="code-box">
            <div class="code">${code}</div>
          </div>
          
          <p class="text"><strong>Code expires in 10 minutes</strong></p>
          <p class="text">If you didn't request this code, please ignore this email.</p>
          
          <div class="footer">
            <p>© 2026 Utopia Kingdom. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  console.log('✅ Verification code email sent locally to:', email);
  return { success: true, via: 'local', messageId: info.messageId };
}

// Send verification code email (Worker first; local Gmail OAuth only in unpackaged/dev)
async function sendVerificationCodeEmail(email, code) {
  let workerError = null;
  try {
    return await sendViaWorker(email, code);
  } catch (err) {
    workerError = err;
    console.warn('Worker email send failed, trying local transporter:', err && err.message ? err.message : err);
  }

  if (PACKAGED) {
    throw new Error(
      (workerError && workerError.message)
        ? workerError.message
        : 'Failed to send verification email via server.'
    );
  }

  try {
    return await sendViaLocalTransporter(email, code);
  } catch (err) {
    console.error('❌ Failed to send email:', err);
    if (err && /No refresh token or refresh handler callback is set|missing refresh token|invalid_grant/i.test(String(err.message || err))) {
      const workerHint = workerError && workerError.message ? ` Worker error: ${workerError.message}` : '';
      throw new Error('Failed to send verification email: email OAuth not configured (missing/invalid refresh token).' + workerHint);
    }
    if (workerError) {
      throw new Error((err && err.message) || String(err) || 'Failed to send verification email.');
    }
    throw err;
  }
}

const DEFAULT_SUPPORT_EMAIL_API_URL = 'https://utkingdom.com/api/support/contact';
const SUPPORT_INBOX = 'utopiakingdomreal@gmail.com';

function escapeSupportHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeSupportKind(kind) {
  const k = String(kind || 'support').trim().toLowerCase();
  return k === 'problem' || k === 'beta' ? k : 'support';
}

function supportTopicLabel(kind) {
  const k = normalizeSupportKind(kind);
  if (k === 'problem') return 'Problem';
  if (k === 'beta') return 'Beta tester';
  return 'Support';
}

async function sendSupportViaWorker({ message, email, name, kind }) {
  const url = (process.env.SUPPORT_EMAIL_API_URL || DEFAULT_SUPPORT_EMAIL_API_URL).trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, email, name, kind }),
      signal: controller.signal,
    });
    let data = {};
    try { data = await resp.json(); } catch (_) { data = {}; }
    if (!resp.ok || !data.ok) {
      const msg = (data && (data.message || data.error)) || `Worker support email failed (${resp.status})`;
      const err = new Error(msg);
      err.statusCode = resp.status;
      err.code = data && data.error;
      throw err;
    }
    console.log('✅ Support message emailed via Worker');
    return { success: true, via: 'worker', betaGranted: !!data.betaGranted, betaUntil: data.betaUntil || null };
  } finally {
    clearTimeout(timer);
  }
}

async function sendSupportViaLocal({ message, email, name, kind }) {
  const transporter = await createTransporter();
  const topicLabel = supportTopicLabel(kind);
  const replyEmail = String(email || '').trim();
  const displayName = String(name || '').trim() || replyEmail || 'User';
  const safeMessage = escapeSupportHtml(message).replace(/\n/g, '<br>');
  const mailOptions = {
    from: 'Utopia Kingdom <utopiakingdomreal@gmail.com>',
    to: SUPPORT_INBOX,
    subject: `[App ${topicLabel}] ${displayName} - Utopia Kingdom`,
    replyTo: replyEmail || undefined,
    html: `
      <div style="font-family:Arial,sans-serif;background:#0a0a14;color:#fff;padding:20px;">
        <div style="max-width:640px;margin:0 auto;padding:20px;background:#121212;border-radius:10px;border:1px solid #333;">
          <div style="font-size:20px;font-weight:bold;color:#00ff88;margin-bottom:16px;">UTOPIA KINGDOM · ${topicLabel}</div>
          <p style="color:#9aa0a6;"><strong>From:</strong> ${escapeSupportHtml(displayName)}</p>
          <p style="color:#9aa0a6;"><strong>Reply email:</strong> ${escapeSupportHtml(replyEmail || 'not provided')}</p>
          <p style="color:#9aa0a6;"><strong>Source:</strong> Utopia Kingdom App (local mailer)</p>
          <div style="background:#1a1a24;border:1px solid #333;border-radius:8px;padding:16px;margin-top:12px;line-height:1.55;">${safeMessage}</div>
        </div>
      </div>
    `,
  };
  const info = await transporter.sendMail(mailOptions);
  console.log('✅ Support message emailed locally to:', SUPPORT_INBOX);
  return { success: true, via: 'local', messageId: info.messageId };
}

async function sendSupportMessage({ message, email, name, kind } = {}) {
  const text = String(message || '').trim();
  if (text.length < 10) throw new Error('Message must be at least 10 characters.');
  if (text.length > 4000) throw new Error('Message is too long (max 4000 characters).');

  const payload = {
    message: text,
    email: String(email || '').trim().toLowerCase() || undefined,
    name: String(name || '').trim().slice(0, 80) || undefined,
    kind: normalizeSupportKind(kind),
  };

  let workerError = null;
  try {
    return await sendSupportViaWorker(payload);
  } catch (err) {
    workerError = err;
    if (err && err.statusCode === 429) throw err;
    console.warn('Worker support send failed, trying local transporter:', err && err.message ? err.message : err);
  }

  if (PACKAGED) {
    if (workerError && workerError.statusCode === 429) throw workerError;
    throw new Error(
      (workerError && workerError.message)
        ? workerError.message
        : 'Failed to send support message via server.'
    );
  }

  try {
    return await sendSupportViaLocal(payload);
  } catch (err) {
    console.error('❌ Failed to send support email:', err);
    if (workerError && workerError.statusCode === 429) {
      throw workerError;
    }
    if (workerError) {
      throw new Error((err && err.message) || String(err) || 'Failed to send support message.');
    }
    throw err;
  }
}

module.exports = { sendVerificationCodeEmail, sendSupportMessage };
