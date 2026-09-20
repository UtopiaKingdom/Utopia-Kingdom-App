/**
 * kingdom-marks-cf.js — Citizenship Marks on Cloudflare (server authority).
 * Mounted at /api/marks/*
 */
const FIREBASE_WEB_API_KEY = 'AIzaSyCQdYOL6Tng3GgpRtFEUE7uy3aypmh7cMU';

const WIN_MARKS = 3;
const STREAK5_BONUS = 2;
const DAILY_CAP = 100;
const CAP_HIT_BONUS = 15;
const WIPE_MARKS = 8;
const SEEN_CAP = 40;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DEPOSIT_DELTA = 25;
const HOUSE_BOTS = new Set(['bot1', 'bot2', 'bot3']);

const SECRETS = {
  'first-blood': { bonus: 5 },
  'night-owl': { bonus: 8 },
  'real-linked': { bonus: 20 },
  'bankroll-100': { bonus: 10 },
  'bankroll-500': { bonus: 25 },
  'bankroll-1k': { bonus: 40 },
  'deposit-boost': { bonus: 15 },
  'cap-crusher': { bonus: 0 },
  'wipe-survivor': { bonus: 0 },
};

const CATALOG = {
  'crest-badge': { cost: 40 },
  'signal-chime': { cost: 80 },
  'desk-skin': { cost: 100 },
  'hub-title': { cost: 120 },
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

const tokenCache = new Map();
let _accessToken = null;
let _accessTokenExp = 0;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function todayKey() {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function defaultMarks() {
  return {
    balance: 0,
    earnedToday: 0,
    earnDay: todayKey(),
    owned: [],
    winStreak: 0,
    seenWinKeys: [],
    capHitDay: '',
    wipeCount: 0,
    citizenWeekRedeems: 0,
    lastCitizenWeekAt: null,
    po: {
      realLinked: false,
      realBalance: null,
      realPeak: 0,
      demoBalance: null,
      lastDepositAt: null,
      updatedAt: null,
    },
    updatedAt: null,
  };
}

function normalize(raw) {
  const base = defaultMarks();
  if (!raw || typeof raw !== 'object') return base;
  const poIn = raw.po && typeof raw.po === 'object' ? raw.po : {};
  return {
    balance: Math.max(0, Math.floor(Number(raw.balance) || 0)),
    earnedToday: Math.max(0, Math.floor(Number(raw.earnedToday) || 0)),
    earnDay: String(raw.earnDay || ''),
    owned: Array.isArray(raw.owned) ? raw.owned.map(String) : [],
    winStreak: Math.max(0, Math.floor(Number(raw.winStreak) || 0)),
    seenWinKeys: Array.isArray(raw.seenWinKeys)
      ? raw.seenWinKeys.map(String).slice(-SEEN_CAP)
      : [],
    capHitDay: String(raw.capHitDay || ''),
    wipeCount: Math.max(0, Math.floor(Number(raw.wipeCount) || 0)),
    citizenWeekRedeems: Math.max(0, Math.floor(Number(raw.citizenWeekRedeems) || 0)),
    lastCitizenWeekAt: raw.lastCitizenWeekAt || null,
    po: {
      realLinked: !!poIn.realLinked,
      realBalance: poIn.realBalance == null ? null : Number(poIn.realBalance),
      realPeak: Math.max(0, Number(poIn.realPeak) || 0),
      demoBalance: poIn.demoBalance == null ? null : Number(poIn.demoBalance),
      lastDepositAt: poIn.lastDepositAt || null,
      updatedAt: poIn.updatedAt || null,
    },
    updatedAt: raw.updatedAt || null,
  };
}

function rollDay(state) {
  const day = todayKey();
  if (state.earnDay !== day) {
    state.earnDay = day;
    state.earnedToday = 0;
  }
  return state;
}

function unlockSecret(state, id) {
  const def = SECRETS[id];
  if (!def) return 0;
  if (state.owned.indexOf(id) !== -1) return 0;
  state.owned.push(id);
  const bonus = Math.max(0, Math.floor(Number(def.bonus) || 0));
  if (bonus > 0) state.balance += bonus;
  return bonus;
}

function applyCapHit(state) {
  const day = todayKey();
  if (state.earnedToday < DAILY_CAP) return 0;
  if (state.capHitDay === day) return 0;
  state.capHitDay = day;
  state.balance += CAP_HIT_BONUS;
  if (state.owned.indexOf('cap-crusher') === -1) state.owned.push('cap-crusher');
  return CAP_HIT_BONUS;
}

function rememberKey(state, key) {
  if (!key) return false;
  if (state.seenWinKeys.indexOf(key) !== -1) return false;
  state.seenWinKeys.push(String(key));
  if (state.seenWinKeys.length > SEEN_CAP) {
    state.seenWinKeys = state.seenWinKeys.slice(-SEEN_CAP);
  }
  return true;
}

function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { nullValue: null };
    if (Number.isInteger(v)) return { integerValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') {
    const fields = {};
    Object.keys(v).forEach((k) => {
      fields[k] = toFs(v[k]);
    });
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

function fromFs(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return String(v.stringValue);
  if ('timestampValue' in v) return String(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) {
    const out = {};
    const f = (v.mapValue && v.mapValue.fields) || {};
    Object.keys(f).forEach((k) => {
      out[k] = fromFs(f[k]);
    });
    return out;
  }
  return null;
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function base64UrlEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem) {
  const cleaned = String(pem || '')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function resolveSa(env) {
  const raw = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    try {
      const sa = JSON.parse(raw);
      if (sa && sa.private_key && sa.client_email) return sa;
    } catch (_) {}
  }
  const clientEmail = String(env.FIREBASE_CLIENT_EMAIL || '').trim();
  const projectId = String(env.FIREBASE_PROJECT_ID || 'utopiakingdom-c7d19').trim();
  let privateKey = String(env.FIREBASE_PRIVATE_KEY || '');
  if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) return null;
  return { client_email: clientEmail, private_key: privateKey, project_id: projectId };
}

async function getAccessToken(env) {
  const now = Date.now();
  if (_accessToken && now < _accessTokenExp - 60000) return _accessToken;
  const sa = resolveSa(env);
  if (!sa) throw new Error('Missing Firebase service account secrets');
  const iat = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  };
  const headerB64 = base64UrlEncode(utf8Bytes(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(utf8Bytes(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, utf8Bytes(signingInput));
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!tokenResp.ok) {
    const txt = await tokenResp.text();
    throw new Error('Firebase token exchange failed: ' + tokenResp.status + ' ' + txt);
  }
  const tokenJson = await tokenResp.json();
  _accessToken = tokenJson.access_token;
  _accessTokenExp = Date.now() + Number(tokenJson.expires_in || 3600) * 1000;
  return _accessToken;
}

function userDocName(env, uid) {
  const projectId = String(
    (resolveSa(env) && resolveSa(env).project_id) || env.FIREBASE_PROJECT_ID || 'utopiakingdom-c7d19'
  ).trim();
  return `projects/${projectId}/databases/(default)/documents/users/${uid}`;
}

async function verifyUser(request) {
  const header = request.headers.get('Authorization') || '';
  const tok = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!tok) return null;
  const cached = tokenCache.get(tok);
  if (cached && cached.exp > Date.now()) return cached.user;
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_WEB_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: tok }),
    }
  );
  const data = await res.json().catch(() => ({}));
  const row = data && data.users && data.users[0];
  const uid = row && row.localId ? String(row.localId) : '';
  if (!uid) return null;
  const user = { uid, email: String(row.email || '') };
  if (tokenCache.size > 400) tokenCache.clear();
  tokenCache.set(tok, { exp: Date.now() + 280000, user });
  return user;
}

async function readUserDoc(env, uid) {
  const accessToken = await getAccessToken(env);
  const docName = userDocName(env, uid);
  const r = await fetch('https://firestore.googleapis.com/v1/' + docName, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (r.status === 404) {
    return { exists: false, fields: {}, updateTime: null, docName, accessToken };
  }
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Firestore get failed: ' + r.status + ' ' + txt.slice(0, 200));
  }
  const doc = await r.json();
  return {
    exists: true,
    fields: (doc && doc.fields) || {},
    updateTime: doc.updateTime || null,
    docName,
    accessToken,
  };
}

async function writeUserFields(env, docName, accessToken, fields, updatePaths, updateTime) {
  const mask = updatePaths.map((p) => 'updateMask.fieldPaths=' + encodeURIComponent(p)).join('&');
  let url = 'https://firestore.googleapis.com/v1/' + docName + '?' + mask;
  if (updateTime) {
    url += '&currentDocument.updateTime=' + encodeURIComponent(updateTime);
  } else {
    url += '&currentDocument.exists=false';
  }
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken,
    },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error('Firestore patch failed: ' + r.status + ' ' + txt.slice(0, 200));
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function withMarks(env, uid, mutator) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const snap = await readUserDoc(env, uid);
    const marksRaw = snap.fields.marks ? fromFs(snap.fields.marks) : null;
    let marks = rollDay(normalize(marksRaw));
    const userData = {};
    Object.keys(snap.fields).forEach((k) => {
      userData[k] = fromFs(snap.fields[k]);
    });
    const result = await mutator(marks, userData);
    marks.updatedAt = new Date().toISOString();
    const patchFields = { marks: toFs(marks) };
    const paths = ['marks'];
    if (result && result.userPatch) {
      Object.keys(result.userPatch).forEach((k) => {
        patchFields[k] = toFs(result.userPatch[k]);
        paths.push(k);
      });
    }
    try {
      await writeUserFields(
        env,
        snap.docName,
        snap.accessToken,
        patchFields,
        paths,
        snap.exists ? snap.updateTime : null
      );
      return Object.assign({}, result || {}, { marks });
    } catch (e) {
      if (e && (e.status === 409 || e.status === 412) && attempt < 3) continue;
      // First create when exists=false precondition fails because doc exists without updateTime
      if (!snap.exists && attempt < 3) {
        try {
          await writeUserFields(env, snap.docName, snap.accessToken, patchFields, paths, null);
          // retry without exists=false — use plain patch
        } catch (_) {}
        continue;
      }
      throw e;
    }
  }
  throw new Error('Could not save Marks. Try again.');
}

async function plainPatch(env, uid, marks, userPatch) {
  const snap = await readUserDoc(env, uid);
  marks.updatedAt = new Date().toISOString();
  const patchFields = { marks: toFs(marks) };
  const paths = ['marks'];
  if (userPatch) {
    Object.keys(userPatch).forEach((k) => {
      patchFields[k] = toFs(userPatch[k]);
      paths.push(k);
    });
  }
  const mask = paths.map((p) => 'updateMask.fieldPaths=' + encodeURIComponent(p)).join('&');
  const url = 'https://firestore.googleapis.com/v1/' + snap.docName + '?' + mask;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + snap.accessToken,
    },
    body: JSON.stringify({ fields: patchFields }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('Firestore patch failed: ' + r.status + ' ' + txt.slice(0, 200));
  }
  return marks;
}

async function handleGrant(env, uid, body) {
  const botId = String((body && body.botId) || '');
  if (!HOUSE_BOTS.has(botId)) {
    return json({ error: 'Marks only from house bots.' }, 400);
  }
  if (String((body && body.account) || '').toLowerCase() !== 'real') {
    return json({ error: 'Marks only on a live Real Pocket Option connection.' }, 400);
  }
  if (!(body && body.autotrade === true)) {
    return json({ error: 'Auto Trade must be on.' }, 400);
  }
  const kind = String((body && body.kind) || '').toLowerCase();
  const dedupeKey = String((body && body.dedupeKey) || '');
  if (!dedupeKey || dedupeKey.length > 180) {
    return json({ error: 'Missing deal key.' }, 400);
  }

  const out = await withMarks(env, uid, async (marks) => {
    if (!rememberKey(marks, dedupeKey)) {
      return { grant: 0, duplicate: true, message: 'Already counted.', unlocked: [] };
    }
    let grant = 0;
    let message = '';
    const unlocked = [];

    if (kind === 'wipe') {
      marks.winStreak = 0;
      marks.wipeCount = (marks.wipeCount || 0) + 1;
      if (unlockSecret(marks, 'wipe-survivor')) unlocked.push('wipe-survivor');
      const room = Math.max(0, DAILY_CAP - marks.earnedToday);
      grant = Math.min(WIPE_MARKS, room);
      if (grant > 0) {
        marks.balance += grant;
        marks.earnedToday += grant;
        message = '+' + grant + ' Marks. Wipe consolation.';
      } else message = 'Daily goal is full.';
    } else if (kind === 'win') {
      marks.winStreak = (marks.winStreak || 0) + 1;
      if (unlockSecret(marks, 'first-blood')) unlocked.push('first-blood');
      const h = new Date().getHours();
      if (h >= 0 && h < 5 && unlockSecret(marks, 'night-owl')) unlocked.push('night-owl');
      let amt = WIN_MARKS;
      let reason = 'an Auto Trade win';
      if (marks.winStreak % 5 === 0) {
        amt += STREAK5_BONUS;
        reason = 'a win plus streak bonus';
      }
      const room = Math.max(0, DAILY_CAP - marks.earnedToday);
      grant = Math.min(amt, room);
      if (grant > 0) {
        marks.balance += grant;
        marks.earnedToday += grant;
        message = '+' + grant + ' Marks for ' + reason;
      } else message = 'Daily goal is full.';
    } else if (kind === 'loss') {
      marks.winStreak = 0;
      message = 'Streak reset.';
    } else {
      throw Object.assign(new Error('Unknown grant kind.'), { http: 400 });
    }

    const capBonus = applyCapHit(marks);
    if (capBonus > 0) {
      message = 'Daily goal done! +' + capBonus + ' bonus Marks';
      unlocked.push('cap-crusher');
    }
    return { grant, message, unlocked, duplicate: false };
  });

  return json({
    marks: out.marks,
    grant: out.grant || 0,
    message: out.message || '',
    unlocked: out.unlocked || [],
    duplicate: !!out.duplicate,
  });
}

async function handleRedeem(env, uid, body) {
  const itemId = String((body && body.itemId) || '');
  const item = CATALOG[itemId];
  if (!item) return json({ error: 'Unknown perk.' }, 404);
  try {
    const out = await withMarks(env, uid, async (marks) => {
      if (marks.owned.indexOf(itemId) !== -1) {
        throw Object.assign(new Error('You already have this one.'), { http: 409 });
      }
      if (marks.balance < item.cost) {
        throw Object.assign(new Error('Not enough Marks yet.'), { http: 400 });
      }
      marks.balance -= item.cost;
      marks.owned.push(itemId);
      return { itemId };
    });
    return json({ marks: out.marks, itemId: out.itemId });
  } catch (e) {
    return json({ error: e.message || 'Redeem failed.' }, e.http || 400);
  }
}

async function handleCitizenWeek(env, uid) {
  const COST = 500;
  try {
    const out = await withMarks(env, uid, async (marks, userData) => {
      if (marks.balance < COST) {
        throw Object.assign(new Error('Not enough Marks yet.'), { http: 400 });
      }
      marks.balance -= COST;
      marks.citizenWeekRedeems = (marks.citizenWeekRedeems || 0) + 1;
      marks.lastCitizenWeekAt = new Date().toISOString();
      const now = Date.now();
      const currentPaid = userData.paidUntil ? Date.parse(userData.paidUntil) : NaN;
      const base = Number.isFinite(currentPaid) && currentPaid > now ? currentPaid : now;
      const paidUntil = new Date(base + WEEK_MS).toISOString();
      return {
        paidUntil,
        userPatch: {
          paidUntil,
          subscriptionStatus: 'active',
          subscription: Object.assign({}, userData.subscription || {}, {
            status: 'active',
            paidUntil,
            provider: (userData.subscription && userData.subscription.provider) || 'marks',
          }),
        },
      };
    });
    return json({ marks: out.marks, paidUntil: out.paidUntil });
  } catch (e) {
    return json({ error: e.message || 'Exchange failed.' }, e.http || 400);
  }
}

async function handleTouchPo(env, uid, body) {
  const poIn = (body && body.po) || {};
  const realLinked = !!poIn.realLinked;
  const realBalance =
    poIn.realBalance == null || !Number.isFinite(Number(poIn.realBalance))
      ? null
      : Number(poIn.realBalance);
  const demoBalance =
    poIn.demoBalance == null || !Number.isFinite(Number(poIn.demoBalance))
      ? null
      : Number(poIn.demoBalance);

  const out = await withMarks(env, uid, async (marks) => {
    const prev = marks.po || defaultMarks().po;
    const unlocked = [];
    if (realLinked || realBalance != null) {
      marks.po.realLinked = true;
      if (unlockSecret(marks, 'real-linked')) unlocked.push('real-linked');
    }
    if (realBalance != null) {
      const prevBal = prev.realBalance;
      marks.po.realBalance = realBalance;
      marks.po.realPeak = Math.max(prev.realPeak || 0, realBalance);
      if (realBalance >= 100 && unlockSecret(marks, 'bankroll-100')) unlocked.push('bankroll-100');
      if (realBalance >= 500 && unlockSecret(marks, 'bankroll-500')) unlocked.push('bankroll-500');
      if (realBalance >= 1000 && unlockSecret(marks, 'bankroll-1k')) unlocked.push('bankroll-1k');
      if (prevBal != null && realBalance >= prevBal + DEPOSIT_DELTA) {
        marks.po.lastDepositAt = new Date().toISOString();
        if (unlockSecret(marks, 'deposit-boost')) unlocked.push('deposit-boost');
      }
    }
    if (demoBalance != null) marks.po.demoBalance = demoBalance;
    marks.po.updatedAt = new Date().toISOString();
    return { unlocked };
  });
  return json({ marks: out.marks, unlocked: out.unlocked || [] });
}

export async function handleKingdomMarks(request, env, pathname) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const route = String(pathname || '').replace(/\/+$/, '') || '/api/marks';
  if (method === 'GET' && (route === '/api/marks' || route === '/api/marks/health')) {
    return json({ ok: true, service: 'kingdom-marks' });
  }

  if (method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const user = await verifyUser(request);
  if (!user || !user.uid) return json({ error: 'Sign in required.' }, 401);

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    body = {};
  }

  try {
    if (route === '/api/marks/grant') return await handleGrant(env, user.uid, body);
    if (route === '/api/marks/redeem') return await handleRedeem(env, user.uid, body);
    if (route === '/api/marks/citizen-week') return await handleCitizenWeek(env, user.uid);
    if (route === '/api/marks/touch-po') return await handleTouchPo(env, user.uid, body);
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    return json({ error: (e && e.message) || 'Marks failed.' }, e && e.http ? e.http : 500);
  }
}
