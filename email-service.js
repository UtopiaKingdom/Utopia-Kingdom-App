// Email service for sending verification codes
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Load OAuth2 credentials from env vars or credentials file to avoid hard-coded secrets
const CRED_PATH = process.env.EMAIL_CREDENTIALS_PATH || path.join(process.cwd(), 'email-credentials.json');
let CLIENT_ID = process.env.EMAIL_CLIENT_ID || '';
let CLIENT_SECRET = process.env.EMAIL_CLIENT_SECRET || '';
let REFRESH_TOKEN = process.env.EMAIL_REFRESH_TOKEN || '';
let REDIRECT_URI = process.env.EMAIL_REDIRECT_URI || 'urn:ietf:wg:oauth:2.0:oob';

// Try to load credentials file if present
try {
  if (fs.existsSync(CRED_PATH)) {
    const raw = fs.readFileSync(CRED_PATH, 'utf8');
    const data = JSON.parse(raw);
    // file format from helper includes refresh_token, access_token, expiry_date
    CLIENT_ID = CLIENT_ID || data.client_id || data.clientId || process.env.EMAIL_CLIENT_ID || '';
    CLIENT_SECRET = CLIENT_SECRET || data.client_secret || data.clientSecret || process.env.EMAIL_CLIENT_SECRET || '';
    REFRESH_TOKEN = REFRESH_TOKEN || data.refresh_token || data.refreshToken || process.env.EMAIL_REFRESH_TOKEN || '';
    // if file includes redirect override
    if (data.redirect_uri) REDIRECT_URI = data.redirect_uri;
    console.log('Loaded email credentials from', CRED_PATH);
  }
} catch (err) {
  console.error('Failed to read email credentials file:', err.message || err);
}

// Warn if using hard-coded fallbacks
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.warn('Warning: Email credentials incomplete. Ensure EMAIL_CLIENT_ID, EMAIL_CLIENT_SECRET, and EMAIL_REFRESH_TOKEN are set or email-credentials.json contains a refresh_token.');
}

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

async function createTransporter() {
  const accessToken = await oAuth2Client.getAccessToken();
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
}

// Send verification code email
async function sendVerificationCodeEmail(email, code) {
  const transporter = await createTransporter();
  try {
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
    console.log('✅ Verification code email sent to:', email);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('❌ Failed to send email:', err);
    throw err;
  }
}

module.exports = { sendVerificationCodeEmail };
