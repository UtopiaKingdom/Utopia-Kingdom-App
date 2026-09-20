// tools/test_email.js
// Simple script to test email creds: fetch access token and attempt SMTP verify/send

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

(async () => {
  try {
    const CRED_PATH = process.env.EMAIL_CREDENTIALS_PATH || path.join(process.cwd(), 'email-credentials.json');
    if (!fs.existsSync(CRED_PATH)) {
      console.error('Credentials file not found at', CRED_PATH);
      process.exit(2);
    }
    const data = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    const CLIENT_ID = process.env.EMAIL_CLIENT_ID || data.client_id || '';
    const CLIENT_SECRET = process.env.EMAIL_CLIENT_SECRET || data.client_secret || '';
    const REFRESH_TOKEN = process.env.EMAIL_REFRESH_TOKEN || data.refresh_token || '';
    const REDIRECT_URI = data.redirect_uri || 'urn:ietf:wg:oauth:2.0:oob';

    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
      console.error('Missing client id/secret/refresh token - please ensure credentials are complete in', CRED_PATH);
      console.error({ CLIENT_ID: !!CLIENT_ID, CLIENT_SECRET: !!CLIENT_SECRET, REFRESH_TOKEN: !!REFRESH_TOKEN });
      process.exit(2);
    }

    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

    console.log('Requesting access token...');
    const res = await oauth2Client.getAccessToken();
    console.log('Access token response:', res);
    const accessToken = (res && res.token) ? res.token : (typeof res === 'string' ? res : null);
    if (!accessToken) {
      console.error('No access token returned. Full response above.');
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: 'utopiakingdomreal@gmail.com',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        accessToken: accessToken
      },
      logger: true,
      debug: true
    });

    console.log('Verifying transporter...');
    transporter.verify((err, success) => {
      if (err) {
        console.error('Transporter verify failed:');
        console.error(err);
        process.exit(1);
      } else {
        console.log('Transporter verified. Attempting to send test email...');
        transporter.sendMail({
          from: 'Utopia Kingdom <utopiakingdomreal@gmail.com>',
          to: 'utopiakingdomreal@gmail.com',
          subject: 'Test email from helper',
          text: 'This is a test email from tools/test_email.js'
        }, (err, info) => {
          if (err) {
            console.error('Send failed:');
            console.error(err);
            process.exit(1);
          }
          console.log('Send success:', info);
          process.exit(0);
        });
      }
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
})();