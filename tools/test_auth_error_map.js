/**
 * Quick unit checks for auth error mapping + OTP flow assumptions.
 * Run: node tools/test_auth_error_map.js
 */
function mapAuthErrorMessage(err) {
  const e = err || {};
  const code = String(e.code || '');
  const msg = String(e.message || '');
  const blob = `${code} ${msg}`.toLowerCase();
  if (
    code === 'auth/quota-exceeded' ||
    code === 'auth/too-many-requests' ||
    blob.includes('quota') ||
    blob.includes('too many requests') ||
    blob.includes('verifying password') ||
    blob.includes('resource-exhausted') ||
    blob.includes('resource_exhausted')
  ) {
    return 'Too many login attempts from Firebase. Wait 10–15 minutes, then try once.';
  }
  return msg || 'Login failed. Try again.';
}

const cases = [
  { code: 'auth/quota-exceeded', message: 'Quota exceeded.' },
  { message: 'Quota Exceeded' },
  { message: 'Firebase: Quota exceeded. (auth/quota-exceeded)' },
  { code: 'auth/too-many-requests', message: 'Too many requests' },
  { message: 'RESOURCE_EXHAUSTED: Quota exceeded.' },
];

let failed = 0;
for (const c of cases) {
  const out = mapAuthErrorMessage(c);
  const ok = out.includes('Wait 10');
  console.log(ok ? 'ok ' : 'FAIL', JSON.stringify(c), '=>', out);
  if (!ok) failed++;
}

// Live Identity Toolkit probe (project-level, not per-user)
async function probeFirebase() {
  const apiKey = 'AIzaSyCQdYOL6Tng3GgpRtFEUE7uy3aypmh7cMU';
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'quota-probe-utk-test@example.com',
        password: 'WrongPassword123!',
        returnSecureToken: true,
      }),
    },
  );
  const data = await resp.json();
  const msg = data?.error?.message || JSON.stringify(data);
  console.log('\nFirebase probe:', resp.status, msg);
  if (/QUOTA/i.test(msg)) {
    console.log('PROJECT is quota-blocked — all logins will fail until reset.');
    failed++;
  } else {
    console.log('Project auth endpoint OK (not globally quota-blocked).');
  }
}

probeFirebase()
  .then(() => {
    if (failed) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll auth mapping tests passed.');
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
