// tools/print_email_client_id.js
// Prints the EMAIL_CLIENT_ID value found in env or email-credentials.json
const fs = require('fs');
const path = require('path');

const envId = process.env.EMAIL_CLIENT_ID || process.env.CLIENT_ID || process.env.GMAIL_CLIENT_ID || '';
if (envId) {
  console.log('Found EMAIL_CLIENT_ID in environment:');
  console.log(envId);
  process.exit(0);
}

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
      const id = json.client_id || json.clientId || json.clientID || json.CLIENT_ID || '';
      if (id) {
        console.log('Found client_id in', p + ':');
        console.log(id);
        process.exit(0);
      }
    }
  } catch (e) {
    // ignore
  }
}

console.error('No CLIENT_ID found in environment or candidate credential files.');
process.exit(2);
