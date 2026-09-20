/**
 * community-hub-cf.js — World + private chat on Cloudflare R2.
 * Mounted at /api/hub so chat works without waiting for Contabo tape restart.
 */
const FIREBASE_WEB_API_KEY = 'AIzaSyCQdYOL6Tng3GgpRtFEUE7uy3aypmh7cMU';
const STATE_KEY = 'hub/state.json';
const LOBBY = 'lobby';
const MAX_TEXT = 400;
const MAX_NAME = 30;
const MAX_ROOM_NAME = 40;
const MAX_ROOMS_PER_USER = 12;
const MAX_MESSAGES = 80;
const MSG_COOLDOWN_MS = 1200;
const ROOM_COOLDOWN_MS = 8000;
const PRESENCE_TTL_MS = 90000;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Cache-Control': 'no-store',
};

const tokenCache = new Map();
const lastMsgAt = new Map();
const lastRoomAt = new Map();

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function nowMs() {
  return Date.now();
}

function cleanText(value, maxLen) {
  return String(value || '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

const CENSOR_ROOTS = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cock', 'pussy',
  'cunt', 'slut', 'whore', 'nigger', 'nigga', 'retard', 'faggot', 'fag',
  'rape', 'rapist', 'twat', 'wank', 'wanker', 'bollocks', 'motherfucker',
  'blowjob', 'handjob', 'jerkoff', 'jackoff', 'cumshot', 'dildo',
  'penis', 'vagina', 'anus', 'anal', 'porn', 'porno', 'hentai',
  'nazi', 'kkk', 'pedo', 'paedo', 'paedophile', 'pedophile',
  'killyourself', 'kys', 'fuk', 'fck', 'fuq'
];
const CENSOR_BAD = new Set();
CENSOR_ROOTS.forEach((w) => {
  ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'ings', 'y', 'ty', 'ied'].forEach((s) => {
    CENSOR_BAD.add(w + s);
  });
});

function foldToken(tok) {
  return String(tok || '')
    .toLowerCase()
    .replace(/@/g, 'a').replace(/4/g, 'a').replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[$5]/g, 's').replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
}

function censorText(value) {
  return String(value || '').replace(/[^\s]+/g, (tok) => {
    if (!CENSOR_BAD.has(foldToken(tok))) return tok;
    const n = Math.max(3, tok.length);
    return '*'.repeat(n);
  });
}

function cleanChat(value, maxLen) {
  return censorText(cleanText(value, maxLen));
}

function emptyState() {
  const t = nowMs();
  return {
    nextId: 1,
    rooms: {
      [LOBBY]: {
        id: LOBBY,
        name: 'World',
        kind: 'world',
        createdBy: 'system',
        createdAt: t,
        lastAt: t,
        lastText: '',
        lastName: '',
        invite: '',
      },
    },
    messages: { [LOBBY]: [] },
    members: {},
    presence: {},
  };
}

function makeInvite(state) {
  const used = new Set(
    Object.values(state.rooms || {})
      .map((r) => String(r && r.invite || ''))
      .filter(Boolean)
  );
  for (let i = 0; i < 24; i++) {
    let code = '';
    for (let j = 0; j < 6; j++) {
      code += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
    }
    if (!used.has(code)) return code;
  }
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function roomSlug() {
  return 'r_' + Math.random().toString(16).slice(2, 12);
}

async function verifyToken(raw) {
  const tok = String(raw || '').trim();
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
  const email = String(row.email || '');
  let name = cleanText(row.displayName || '', MAX_NAME);
  if (!name && email) name = cleanText(email.split('@')[0], MAX_NAME);
  const user = { uid, email, name: name || 'Trader' };
  if (tokenCache.size > 400) tokenCache.clear();
  tokenCache.set(tok, { exp: Date.now() + 280000, user });
  return user;
}

function authFromRequest(request) {
  const header = request.headers.get('Authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return '';
}

async function loadState(env) {
  const obj = await env.DOWNLOADS.get(STATE_KEY);
  if (!obj) return { state: emptyState(), etag: null };
  try {
    const state = await obj.json();
    if (!state || typeof state !== 'object') return { state: emptyState(), etag: obj.httpEtag || obj.etag || null };
    if (!state.rooms) state.rooms = emptyState().rooms;
    if (!state.messages) state.messages = { [LOBBY]: [] };
    if (!state.members) state.members = {};
    if (!state.presence) state.presence = {};
    if (!state.nextId) state.nextId = 1;
    if (!state.rooms[LOBBY]) state.rooms[LOBBY] = emptyState().rooms[LOBBY];
    return { state, etag: obj.httpEtag || obj.etag || null };
  } catch (e) {
    return { state: emptyState(), etag: null };
  }
}

async function saveState(env, state) {
  await env.DOWNLOADS.put(STATE_KEY, JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  return true;
}

async function withState(env, mutator) {
  const loaded = await loadState(env);
  const result = await mutator(loaded.state);
  if (result && result.skipSave) return result.response;
  await saveState(env, loaded.state);
  return result.response;
}

function isWorld(id) {
  return !id || id === LOBBY;
}

function isMember(state, roomId, uid) {
  if (isWorld(roomId)) return true;
  const list = state.members[roomId] || [];
  return list.some((m) => m && m.uid === uid);
}

function addMember(state, roomId, uid, name) {
  const list = Array.isArray(state.members[roomId]) ? state.members[roomId].slice() : [];
  const idx = list.findIndex((m) => m && m.uid === uid);
  const row = { uid, name: name || 'Trader', joinedAt: nowMs() };
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  state.members[roomId] = list;
}

function prunePresence(state, roomId) {
  const cut = nowMs() - PRESENCE_TTL_MS;
  const next = {};
  Object.keys(state.presence || {}).forEach((key) => {
    const p = state.presence[key];
    if (p && Number(p.at) >= cut) next[key] = p;
  });
  state.presence = next;
  return Object.values(next)
    .filter((p) => p.roomId === roomId)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function touchPresence(state, user, name, roomId) {
  const key = user.uid + ':' + roomId;
  state.presence[key] = {
    uid: user.uid,
    roomId,
    name: name || user.name || 'Trader',
    at: nowMs(),
  };
}

function listMembers(state, roomId) {
  if (isWorld(roomId)) return [];
  const online = new Set(
    Object.values(state.presence || {})
      .filter((p) => p.roomId === roomId && nowMs() - Number(p.at) < PRESENCE_TTL_MS)
      .map((p) => p.uid)
  );
  return (state.members[roomId] || []).map((m) => ({
    uid: m.uid,
    name: m.name,
    online: online.has(m.uid),
  }));
}

function roomPayload(state, room, uid, includeMembers) {
  const kind = room.id === LOBBY ? 'world' : (room.kind === 'world' ? 'world' : 'private');
  const members = kind === 'private' ? (state.members[room.id] || []) : [];
  const invite = kind === 'private' && isMember(state, room.id, uid) ? String(room.invite || '') : '';
  const payload = {
    id: room.id,
    name: room.name,
    kind,
    createdBy: room.createdBy,
    createdAt: room.createdAt,
    lastAt: room.lastAt,
    lastText: censorText(room.lastText || ''),
    lastName: censorText(room.lastName || ''),
    invite,
    memberCount: members.length,
  };
  if (includeMembers) {
    payload.members = listMembers(state, room.id);
    payload.presence = prunePresence(state, room.id);
  }
  return payload;
}

function listRooms(state, uid) {
  return Object.values(state.rooms || {})
    .filter((r) => r && (r.id === LOBBY || isMember(state, r.id, uid)))
    .sort((a, b) => Number(b.lastAt || 0) - Number(a.lastAt || 0))
    .slice(0, 40)
    .map((r) => roomPayload(state, r, uid, false));
}

function listMessages(state, roomId, afterId) {
  const rows = Array.isArray(state.messages[roomId]) ? state.messages[roomId] : [];
  const cut = afterId > 0
    ? rows.filter((m) => Number(m.id) > afterId).slice(0, MAX_MESSAGES)
    : rows.slice(-MAX_MESSAGES);
  return cut.map((m) => ({
    ...m,
    name: censorText(m.name),
    text: censorText(m.text),
  }));
}

function countUserRooms(state, uid) {
  return Object.values(state.rooms || {}).filter((r) => r && r.createdBy === uid && r.id !== LOBBY).length;
}

export async function handleCommunityHub(request, env, pathname) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const route = String(pathname || '').replace(/\/+$/, '') || '/api/hub';
  if (method === 'GET' && (route === '/api/hub' || route === '/api/hub/health' || route === '/api/hub/healthz')) {
    return json({ ok: true, service: 'community-hub', store: 'r2' });
  }

  const user = await verifyToken(authFromRequest(request));
  if (!user) return json({ ok: false, error: 'auth_required' }, 401);

  const url = new URL(request.url);
  let body = {};
  if (method === 'POST' || method === 'DELETE') {
    try { body = await request.json(); } catch (e) { body = {}; }
    if (!body || typeof body !== 'object') body = {};
  }

  if (method === 'GET' && route === '/api/hub/sync') {
    return withState(env, async (state) => {
      let roomId = cleanText(url.searchParams.get('room') || LOBBY, 24) || LOBBY;
      if (!state.rooms[roomId]) roomId = LOBBY;
      if (!isMember(state, roomId, user.uid)) {
        return { skipSave: true, response: json({ ok: false, error: 'private' }, 403) };
      }
      const afterId = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const name = cleanChat(url.searchParams.get('name') || user.name, MAX_NAME) || user.name;
      touchPresence(state, user, name, roomId);
      const room = state.rooms[roomId];
      return {
        response: json({
          ok: true,
          you: { uid: user.uid, name },
          room: roomPayload(state, room, user.uid, true),
          rooms: listRooms(state, user.uid),
          messages: listMessages(state, roomId, afterId),
          presence: prunePresence(state, roomId),
        }),
      };
    });
  }

  if (method === 'POST' && route === '/api/hub/messages') {
    return withState(env, async (state) => {
      const roomId = cleanText(body.room || LOBBY, 24) || LOBBY;
      const text = cleanChat(body.text, MAX_TEXT);
      const name = cleanChat(body.name || user.name, MAX_NAME) || user.name;
      if (!text) return { skipSave: true, response: json({ ok: false, error: 'empty' }, 400) };
      if (!state.rooms[roomId]) return { skipSave: true, response: json({ ok: false, error: 'missing' }, 404) };
      if (!isMember(state, roomId, user.uid)) return { skipSave: true, response: json({ ok: false, error: 'private' }, 403) };
      const last = lastMsgAt.get(user.uid) || 0;
      if (Date.now() - last < MSG_COOLDOWN_MS) {
        return { skipSave: true, response: json({ ok: false, error: 'slow_down' }, 429) };
      }
      const stamp = nowMs();
      const id = Number(state.nextId || 1);
      state.nextId = id + 1;
      if (!Array.isArray(state.messages[roomId])) state.messages[roomId] = [];
      const message = { id, uid: user.uid, name, text, createdAt: stamp, room: roomId };
      state.messages[roomId].push(message);
      if (state.messages[roomId].length > 400) {
        state.messages[roomId] = state.messages[roomId].slice(-300);
      }
      const room = state.rooms[roomId];
      room.lastAt = stamp;
      room.lastText = text.slice(0, 80);
      room.lastName = name;
      touchPresence(state, user, name, roomId);
      lastMsgAt.set(user.uid, Date.now());
      return { response: json({ ok: true, message }) };
    });
  }

  if (method === 'POST' && route === '/api/hub/rooms') {
    return withState(env, async (state) => {
      const name = cleanChat(body.name, MAX_ROOM_NAME);
      if (name.length < 2) return { skipSave: true, response: json({ ok: false, error: 'name_short' }, 400) };
      const last = lastRoomAt.get(user.uid) || 0;
      if (Date.now() - last < ROOM_COOLDOWN_MS) {
        return { skipSave: true, response: json({ ok: false, error: 'slow_down' }, 429) };
      }
      if (countUserRooms(state, user.uid) >= MAX_ROOMS_PER_USER) {
        return { skipSave: true, response: json({ ok: false, error: 'room_limit' }, 400) };
      }
      const id = roomSlug();
      const invite = makeInvite(state);
      const stamp = nowMs();
      const hostName = cleanChat(body.nameHost || user.name, MAX_NAME) || user.name;
      state.rooms[id] = {
        id,
        name,
        kind: 'private',
        createdBy: user.uid,
        createdAt: stamp,
        lastAt: stamp,
        lastText: '',
        lastName: '',
        invite,
      };
      state.messages[id] = [];
      addMember(state, id, user.uid, hostName);
      lastRoomAt.set(user.uid, Date.now());
      return { response: json({ ok: true, room: roomPayload(state, state.rooms[id], user.uid, true) }) };
    });
  }

  if (method === 'POST' && route === '/api/hub/join') {
    return withState(env, async (state) => {
      const code = String(body.code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (code.length < 4) return { skipSave: true, response: json({ ok: false, error: 'bad_code' }, 400) };
      const room = Object.values(state.rooms).find((r) => r && String(r.invite || '') === code);
      if (!room || isWorld(room.id)) return { skipSave: true, response: json({ ok: false, error: 'bad_code' }, 404) };
      const name = cleanChat(body.name || user.name, MAX_NAME) || user.name;
      addMember(state, room.id, user.uid, name);
      return { response: json({ ok: true, room: roomPayload(state, state.rooms[room.id], user.uid, true) }) };
    });
  }

  if (method === 'POST' && route === '/api/hub/leave') {
    return withState(env, async (state) => {
      const roomId = cleanText(body.room, 24);
      if (!roomId || isWorld(roomId)) {
        return { skipSave: true, response: json({ ok: false, error: 'private' }, 400) };
      }
      const list = Array.isArray(state.members[roomId]) ? state.members[roomId] : [];
      state.members[roomId] = list.filter((m) => m && m.uid !== user.uid);
      Object.keys(state.presence || {}).forEach((key) => {
        const p = state.presence[key];
        if (p && p.uid === user.uid && p.roomId === roomId) delete state.presence[key];
      });
      return { response: json({ ok: true, left: roomId }) };
    });
  }

  return json({ ok: false, error: 'not_found' }, 404);
}
