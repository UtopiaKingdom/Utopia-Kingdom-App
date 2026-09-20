/**
 * community-hub.js — World chat + private chats on Contabo.
 * Load AFTER renderer.js.
 */
(function () {
  'use strict';

  const DEFAULT_CONTABO = [
    'http://169.58.151.111:8789/hub',
    'http://169.58.151.111:8788/hub'
  ];
  const DEFAULT_FALLBACK = 'https://utkingdom.com/api/hub';

  function loadHubBases() {
    let contabo = DEFAULT_CONTABO.slice();
    let fallback = DEFAULT_FALLBACK;
    try {
      const candidates = ['./config.json', './config.ship.json'];
      for (const rel of candidates) {
        try {
          const cfg = require(rel);
          if (cfg && Array.isArray(cfg.communityHubBases) && cfg.communityHubBases.length) {
            const bases = cfg.communityHubBases.map((b) => String(b || '').trim()).filter(Boolean);
            const https = bases.filter((b) => /^https:/i.test(b));
            const http = bases.filter((b) => /^http:/i.test(b) && !/^https:/i.test(b));
            if (http.length) contabo = http;
            if (https.length) fallback = https[0];
            break;
          }
        } catch (_) {}
      }
    } catch (_) {}
    return { contabo, fallback, bases: contabo.concat([fallback]) };
  }

  const hubCfg = loadHubBases();
  const CONTABO_BASES = hubCfg.contabo;
  const CHAT_FALLBACK_BASE = hubCfg.fallback;
  const BASES = hubCfg.bases;
  const BASE_CACHE_KEY = 'utk-hub-base-v1';
  const FETCH_MS = 3500;
  const CHECK_FETCH_MS = 900000;
  const CONNECT_SOFT_MS = 4500;
  const CONNECT_HARD_MS = 10000;
  const POLL_MS = 1200;
  const WORLD = 'lobby';
  const FULL_EVERY = 12;

  try { require('./community-hub-censor.js'); } catch (e) {}

  let chosen = '';
  try {
    const saved = localStorage.getItem(BASE_CACHE_KEY);
    // Never trust the thin Cloudflare chat fallback as the sticky base.
    if (saved && CONTABO_BASES.indexOf(saved) >= 0) chosen = saved;
    else if (saved) localStorage.removeItem(BASE_CACHE_KEY);
  } catch (e) {}
  let roomId = WORLD;
  let activeRoom = null;
  let afterId = 0;
  let pollTimer = null;
  let youUid = '';
  let youOwner = false;
  let sending = false;
  let modalMode = '';
  let currentInvite = '';
  let pollTick = 0;
  let roomsSig = '';
  let lastMsgUid = '';
  let tokenMemo = '';
  let tokenMemoAt = 0;
  let mutAfter = 0;
  let roomsCache = [];
  let connectSoftTimer = null;
  let connectHardTimer = null;
  let syncGen = 0;
  let roomSwitching = false;
  let lastSyncedAt = 0;
  const seen = Object.create(null);
  const lastSeenAt = Object.create(null);

  function focusComposer() {
    const input = document.getElementById('hubInput');
    if (input) setTimeout(function () { try { input.focus(); } catch (e) {} }, 20);
  }

  function showLeave(on) {
    const btn = document.getElementById('hubLeaveBtn');
    if (!btn) return;
    if (on) btn.removeAttribute('hidden');
    else btn.setAttribute('hidden', '');
  }

  function catchUp(id, lastAt) {
    const at = Number(lastAt || 0);
    if (!id) return;
    if (lastSeenAt[id] == null) lastSeenAt[id] = at;
    if (id === roomId && at > Number(lastSeenAt[id] || 0)) lastSeenAt[id] = at;
  }

  function hasUnread(id, lastAt) {
    if (!id || id === roomId) return false;
    const at = Number(lastAt || 0);
    const seenAt = lastSeenAt[id];
    if (seenAt == null) return false;
    return at > Number(seenAt);
  }

  function paintUnread(rooms) {
    const worldBtn = document.getElementById('hubWorldBtn');
    const list = rooms || [];
    const lobby = list.filter(function (r) { return r && r.id === WORLD; })[0];
    if (lobby) catchUp(WORLD, lobby.lastAt);
    if (worldBtn) worldBtn.classList.toggle('has-unread', hasUnread(WORLD, lobby && lobby.lastAt));
    document.querySelectorAll('#hubRoomList .hub-room-btn').forEach(function (btn) {
      const id = btn.getAttribute('data-hub-room');
      const row = list.filter(function (r) { return r && r.id === id; })[0];
      if (row) catchUp(id, row.lastAt);
      btn.classList.toggle('has-unread', hasUnread(id, row && row.lastAt));
    });
  }

  function censor(s) {
    try {
      const api = window.__utkHubCensor;
      if (api && typeof api.censorText === 'function') return api.censorText(s);
    } catch (e) {}
    return String(s == null ? '' : s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getAuth() {
    try {
      if (window.auth) return window.auth;
    } catch (e) {}
    try {
      return require('./auth-verification.js').auth;
    } catch (e2) {}
    return null;
  }

  function displayName() {
    const el = document.getElementById('displayUsername') || document.getElementById('sidebarUsername');
    const n = el && el.textContent ? el.textContent.trim() : '';
    if (n && n !== 'Utopia Trader') return n.slice(0, 30);
    try {
      const u = getAuth() && getAuth().currentUser;
      if (u && u.email) return String(u.email).split('@')[0].slice(0, 30);
    } catch (e) {}
    return 'Trader';
  }

  function selfUidNow() {
    try {
      const auth = getAuth();
      const u = auth && auth.currentUser;
      if (u && u.uid) return String(u.uid);
    } catch (e) {}
    return youUid ? String(youUid) : '';
  }

  async function idToken() {
    if (tokenMemo && (Date.now() - tokenMemoAt) < 90000) return tokenMemo;
    const auth = getAuth();
    const user = auth && auth.currentUser;
    if (!user || typeof user.getIdToken !== 'function') return '';
    try {
      tokenMemo = await user.getIdToken();
      tokenMemoAt = Date.now();
      return tokenMemo;
    } catch (e) {
      tokenMemo = '';
      tokenMemoAt = 0;
      return '';
    }
  }

  function setStatus(text, kind) {
    const el = document.getElementById('hubStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-err', 'is-ok');
    if (kind) el.classList.add(kind);
  }

  function friendlyError(code) {
    const map = {
      sign_in: 'Sign in to chat.',
      hub_unreachable: 'Chat is not available yet. Try again in a moment.',
      slow_down: 'Wait a second, then send again.',
      name_short: 'Give the chat a longer name.',
      room_limit: 'You already created the maximum number of private chats.',
      bad_code: 'That code did not match a chat. Ask your friend for the code again.',
      private: 'This chat is private. Join it with an invite code.',
      room_gone: 'This chat was deleted by the host.',
      forbidden: 'Only the host or owner can do that.',
      banned: 'You were removed from this chat.',
      timeout: 'You are timed out in this chat.',
      empty: 'Write a message first.',
      auth_required: 'Sign in to chat.',
      not_found: 'Chat is not available yet. Try again in a moment.',
      method_not_allowed: 'Chat is not available yet. Try again in a moment.',
      missing: 'That chat was not found.',
      busy: 'Chat is busy. Try again.',
      image_too_large: 'Image is too large. Try a smaller photo.',
      bad_image: 'Could not attach that image.'
    };
    if (code && String(code).indexOf(' ') >= 0) return String(code);
    return map[code] || 'Could not do that right now. Try again.';
  }

  function isContaboBase(base) {
    const b = String(base || '');
    return CONTABO_BASES.indexOf(b) >= 0 || b.indexOf('169.58.151.111') >= 0;
  }

  function needsFullHub(path) {
    const p = String(path || '');
    return (
      p.indexOf('/studio') === 0 ||
      p.indexOf('/timeout') === 0 ||
      p.indexOf('/kick') === 0 ||
      p.indexOf('/ban') === 0 ||
      p.indexOf('/messages/delete') === 0 ||
      p.indexOf('/messages/edit') === 0 ||
      p.indexOf('/messages/react') === 0 ||
      p.indexOf('/profile') === 0
    );
  }

  function heavyStudio(path) {
    const p = String(path || '');
    return p.indexOf('/studio/check') === 0 || p.indexOf('/studio/ai-upgrade') === 0;
  }

  function fetchMsFor(path) {
    return heavyStudio(path) ? CHECK_FETCH_MS : FETCH_MS;
  }

  function basesForPath(path) {
    if (needsFullHub(path)) return CONTABO_BASES.slice();
    return BASES.slice();
  }

  async function api(method, path, body) {
    const token = await idToken();
    if (!token) throw new Error('sign_in');
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    };
    try {
      if (typeof window.hasActiveAppAccess === 'function' && window.hasActiveAppAccess()) {
        headers['X-Utk-Entitled'] = '1';
      } else if (window.__utkAccessGate && typeof window.__utkAccessGate.isPaid === 'function' && window.__utkAccessGate.isPaid()) {
        headers['X-Utk-Entitled'] = '1';
      } else if (window.__utkEntitlementCache && (window.__utkEntitlementCache.paidActive || window.__utkEntitlementCache.trialActive || window.__utkEntitlementCache.isOwner)) {
        headers['X-Utk-Entitled'] = '1';
      }
    } catch (e) {}
    if (payload) headers['Content-Type'] = 'application/json';

    const pool = basesForPath(path);
    const order = [];
    if (chosen && pool.indexOf(chosen) >= 0) order.push(chosen);
    else if (chosen && needsFullHub(path) && !isContaboBase(chosen)) {
      chosen = '';
      try { localStorage.removeItem(BASE_CACHE_KEY); } catch (e2) {}
    }
    pool.forEach(function (b) {
      if (order.indexOf(b) < 0) order.push(b);
    });

    // Cold start: race live Contabo hubs so one blackholed IP cannot stall Connecting...
    let skipRaced = false;
    if (!chosen && method === 'GET' && String(path || '').indexOf('/sync') === 0) {
      try {
        const raced = await raceBases(order.filter(isContaboBase).slice(0, 2), method, path, headers, payload);
        if (raced) return raced;
        skipRaced = true;
      } catch (e) {}
    }

    let lastErr = null;
    const timeoutMs = fetchMsFor(path);
    for (let i = 0; i < order.length; i++) {
      if (skipRaced && isContaboBase(order[i]) && i < 2) continue;
      const base = order[i].replace(/\/$/, '');
      try {
        return await fetchHub(base, method, path, headers, payload, timeoutMs);
      } catch (err) {
        lastErr = err;
        const status = err && err.status;
        const deadHost = status === 404 || status === 405 || status === 501 ||
          (err && (err.message === 'not_found' || err.message === 'method_not_allowed' || err.message === 'hub_error'));
        const timedOut = !!(err && (err.name === 'AbortError' || err.message === 'timeout' || err.message === 'hub_timeout'));
        // Do not stampede the second Contabo IP with another 90s paper run.
        if (timedOut && heavyStudio(path)) {
          throw err;
        }
        if (deadHost || timedOut || !status) {
          if (chosen === base) {
            chosen = '';
            try { localStorage.removeItem(BASE_CACHE_KEY); } catch (e2) {}
          }
          continue;
        }
        if (status === 401 || status === 400 || status === 429 || status === 403) {
          throw err;
        }
      }
    }
    throw lastErr || new Error('hub_unreachable');
  }

  async function fetchHub(base, method, path, headers, payload, timeoutMs) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : FETCH_MS;
    const timer = setTimeout(function () {
      try { if (ctrl) ctrl.abort(); } catch (e) {}
    }, ms);
    try {
      const res = await fetch(base + path, {
        method: method,
        headers: headers,
        body: payload,
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      });
      const data = await res.json().catch(function () { return null; });
      if (!res.ok || !data || data.ok === false) {
        const err = new Error((data && (data.message || data.error)) || ('http_' + res.status));
        err.status = res.status;
        err.body = data;
        throw err;
      }
      chosen = base;
      // Prefer Contabo permanently; chat fallback stays ephemeral.
      if (isContaboBase(base)) {
        try { localStorage.setItem(BASE_CACHE_KEY, base); } catch (e) {}
      }
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const te = new Error('hub_timeout');
        te.status = 0;
        throw te;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function raceBases(bases, method, path, headers, payload) {
    if (!bases || !bases.length) return null;
    return await new Promise(function (resolve) {
      let left = bases.length;
      let done = false;
      bases.forEach(function (raw) {
        const base = String(raw || '').replace(/\/$/, '');
        fetchHub(base, method, path, headers, payload, FETCH_MS).then(function (data) {
          if (done) return;
          done = true;
          resolve(data);
        }).catch(function () {
          left -= 1;
          if (!done && left <= 0) resolve(null);
        });
      });
    });
  }

  function clock(ms) {
    const d = new Date(Number(ms) || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function isWorld(id) {
    return !id || id === WORLD;
  }

  function paintWorldActive() {
    const world = document.getElementById('hubWorldBtn');
    if (world) world.classList.toggle('is-on', isWorld(roomId));
    document.querySelectorAll('#hubRoomList .hub-room-btn').forEach(function (btn) {
      btn.classList.toggle('is-on', btn.getAttribute('data-hub-room') === roomId);
    });
  }

  function renderInvite(room) {
    const bar = document.getElementById('hubInviteBar');
    const codeEl = document.getElementById('hubInviteCode');
    if (!bar || !codeEl) return;
    const invite = room && room.kind === 'private' ? String(room.invite || '') : '';
    currentInvite = invite;
    if (!invite) {
      bar.setAttribute('hidden', '');
      return;
    }
    bar.removeAttribute('hidden');
    codeEl.textContent = invite;
  }

  function renderRooms(rooms) {
    const el = document.getElementById('hubRoomList');
    if (!el) return;
    const list = (rooms || []).filter(function (r) {
      return r && r.id && r.id !== WORLD && r.kind !== 'world';
    });
    const sig = list.map(function (r) {
      return String(r.id) + '|' + String(r.lastAt || '') + '|' + String(r.lastText || '');
    }).join('~') + '|' + roomId;
    if (sig === roomsSig && el.querySelector('.hub-room-btn, .hub-empty-rooms')) {
      paintWorldActive();
      paintUnread(rooms || []);
      return;
    }
    roomsSig = sig;
    if (!list.length) {
      el.innerHTML = '<p class="hub-empty-rooms">No private chats yet. Create one, or join with a code a friend sent you.</p>';
      paintUnread(rooms || []);
      return;
    }
    el.innerHTML = list.map(function (r) {
      catchUp(r.id, r.lastAt);
      const on = r.id === roomId ? ' is-on' : '';
      const unread = hasUnread(r.id, r.lastAt) ? ' has-unread' : '';
      const n = Number(r.memberCount || 0);
      const who = n <= 1 ? 'Just you' : (n + ' people');
      const preview = r.lastText
        ? esc((r.lastName ? r.lastName + ': ' : '') + censor(r.lastText)).slice(0, 42)
        : who;
      return (
        '<button type="button" class="hub-room-btn' + on + unread + '" data-hub-room="' + esc(r.id) + '">' +
          '<span class="hub-room-name">' + esc(censor(r.name || 'Private chat')) + '</span>' +
          '<span class="hub-room-meta">' + preview + '</span>' +
        '</button>'
      );
    }).join('');
    paintUnread(rooms || []);
  }

  function avatars() {
    return window.__utkHubAvatars || null;
  }

  function ownAvatar() {
    try {
      return (avatars() && avatars().getOwn) ? (avatars().getOwn() || '') : '';
    } catch (e) {
      return '';
    }
  }

  let lastProfilePush = 0;
  let lastAvatarPushed = '';

  async function pushProfile(force) {
    const a = ownAvatar();
    const now = Date.now();
    if (!force && a && a === lastAvatarPushed && (now - lastProfilePush) < 120000) return;
    if (!force && !a && (now - lastProfilePush) < 300000) return;
    lastProfilePush = now;
    lastAvatarPushed = a || '';
    try {
      await api('POST', '/profile', {
        name: displayName(),
        avatar: a || undefined
      });
      if (a && youUid && avatars() && avatars().remember) avatars().remember(youUid, a);
    } catch (e) {}
  }

  function msgNameBlock(m) {
    const name = esc(censor(m.name || 'Trader'));
    if (!m.isHost) {
      return '<span class="hub-msg-name">' + name + '</span>';
    }
    return (
      '<div class="hub-msg-identity">' +
        '<span class="hub-msg-name">' +
          '<span class="hub-host-gem" title="Host" aria-hidden="true"></span>' +
          name +
        '</span>' +
        '<span class="hub-host-tag">Host</span>' +
      '</div>'
    );
  }

  function bumpMut(m) {
    const stamps = [
      Number(m && m.editedAt || 0),
      Number(m && m.deletedAt || 0),
      Number(m && m.reactionsAt || 0)
    ];
    stamps.forEach(function (n) {
      if (n > mutAfter) mutAfter = n;
    });
  }

  function appendMessages(rows, reset) {
    const el = document.getElementById('hubMessages');
    if (!el) return;
    if (reset) {
      el.innerHTML = '';
      // Stay pinned for bottom snap — never force scrollTop=0 (that left users at top).
      el.classList.add('hub-messages--bulk');
      Object.keys(seen).forEach(function (k) { delete seen[k]; });
      lastMsgUid = '';
      mutAfter = 0;
      try {
        if (window.__utkHubMsgUi && window.__utkHubMsgUi.resetDayTrack) {
          window.__utkHubMsgUi.resetDayTrack();
        }
        if (window.__utkHubMsgUi && window.__utkHubMsgUi.resetUnread) {
          window.__utkHubMsgUi.resetUnread();
        }
      } catch (e) {}
    }
    const nearBottom = reset || (el.scrollHeight - el.scrollTop - el.clientHeight) < 140;
    const frag = document.createDocumentFragment();
    let added = 0;
    let foreignAdded = 0;
    try {
      if (avatars() && avatars().ingest) avatars().ingest(rows);
    } catch (e) {}
    const msgUi = window.__utkHubMsgUi;
    (rows || []).forEach(function (m) {
      if (!m || !m.id || seen[m.id]) return;
      seen[m.id] = true;
      const nid = Number(m.id);
      if (nid && nid > afterId) afterId = nid;
      bumpMut(m);
      const selfUid = selfUidNow();
      const mine = !!(m.uid && selfUid && String(m.uid) === String(selfUid));
      if (!mine && !m.tmp && !reset) foreignAdded += 1;
      const follow = !!(lastMsgUid && lastMsgUid === m.uid);
      lastMsgUid = m.uid || lastMsgUid;
      if (msgUi && typeof msgUi.beforeAppend === 'function') {
        try { msgUi.beforeAppend(el, m, { bulk: reset }); } catch (e) {}
      }
      let node;
      if (msgUi && typeof msgUi.buildNode === 'function') {
        node = msgUi.buildNode(m, { follow: follow, mine: mine, bulk: reset });
      } else {
        node = document.createElement('div');
        node.className = 'hub-msg' + (mine ? ' is-mine' : '') + (follow ? ' is-follow' : '');
        node.setAttribute('data-hub-mid', String(m.id));
        node.innerHTML = '<div class="hub-msg-row"><div class="hub-msg-bubble"><div class="hub-msg-text">' + esc(censor(m.text)) + '</div></div></div>';
      }
      frag.appendChild(node);
      added += 1;
    });
    if (added) el.appendChild(frag);
    if (!el.childElementCount && reset) {
      el.innerHTML = isWorld(roomId)
        ? '<p class="hub-empty-chat">Nobody has written yet. Say hello.</p>'
        : '<p class="hub-empty-chat">This chat is empty. Send the invite code, then start talking.</p>';
    } else if (el.querySelector('.hub-empty-chat') && el.querySelector('.hub-msg')) {
      try { el.querySelector('.hub-empty-chat').remove(); } catch (e) {}
    }
    if (reset) {
      el.classList.remove('hub-messages--bulk');
    }
    if ((reset || nearBottom) && (added || reset)) {
      scrollChatEnd(el);
      try {
        if (msgUi && msgUi.resetUnread) msgUi.resetUnread();
      } catch (e) {}
    } else if (!nearBottom && foreignAdded > 0) {
      try {
        if (msgUi && msgUi.noteUnread) msgUi.noteUnread(foreignAdded);
      } catch (e) {}
    }
  }

  function scrollChatEnd(el) {
    if (!el) el = document.getElementById('hubMessages');
    if (!el) return;
    try {
      if (window.__utkHubMsgUi && typeof window.__utkHubMsgUi.scrollToBottom === 'function') {
        window.__utkHubMsgUi.scrollToBottom(el);
        return;
      }
    } catch (e) {}
    const snap = function () { el.scrollTop = el.scrollHeight; };
    snap();
    requestAnimationFrame(function () {
      snap();
      requestAnimationFrame(snap);
    });
  }

  function dropTemp() {
    const el = document.getElementById('hubMessages');
    if (!el) return;
    el.querySelectorAll('[data-hub-tmp]').forEach(function (n) {
      try { n.remove(); } catch (e) {}
    });
    const last = el.querySelector('.hub-msg:last-child');
    lastMsgUid = last && !last.getAttribute('data-hub-tmp') ? '' : lastMsgUid;
  }

  function setRoom(id, title, meta) {
    syncGen += 1;
    roomSwitching = true;
    roomId = id || WORLD;
    afterId = 0;
    mutAfter = 0;
    roomsSig = '';
    lastMsgUid = '';
    try {
      if (window.__utkHubMsgUi && window.__utkHubMsgUi.clearComposeExtras) {
        window.__utkHubMsgUi.clearComposeExtras();
        window.__utkHubMsgUi.clearPendingImage();
      }
    } catch (e) {}
    const titleEl = document.getElementById('hubChatTitle');
    const metaEl = document.getElementById('hubChatMeta');
    const msgEl = document.getElementById('hubMessages');
    if (titleEl) titleEl.textContent = title || (isWorld(roomId) ? 'World' : 'Private chat');
    if (metaEl) metaEl.textContent = meta || (isWorld(roomId) ? '' : 'Invite friends with the code below.');
    if (msgEl) {
      try { msgEl.classList.add('is-switching'); } catch (e) {}
    }
    showLeave(!isWorld(roomId));
    paintWorldActive();
    appendMessages([], true);
    if (msgEl) {
      msgEl.innerHTML = '<p class="hub-empty-chat hub-empty-loading">Loading chat…</p>';
    }
    if (isWorld(roomId)) renderInvite(null);
    catchUp(roomId, Date.now());
    focusComposer();
  }

  function normalizeHubRoom(room) {
    if (!room) return room;
    if (room.createdBy && youUid && String(room.createdBy) === String(youUid)) {
      room.isHost = true;
    }
    if (Array.isArray(room.members)) {
      room.members.forEach(function (m) {
        const uid = String(m.uid || '');
        m.isYou = !!(youUid && uid === String(youUid));
        if (room.createdBy && uid === String(room.createdBy)) m.isHost = true;
        if ((!m.name || String(m.name).toLowerCase() === 'host') && m.isYou) {
          const dn = displayName();
          if (dn && dn.toLowerCase() !== 'host') m.name = dn;
        }
      });
    }
    try {
      if (window.__utkHubMembers && typeof window.__utkHubMembers.normalizeRoom === 'function') {
        return window.__utkHubMembers.normalizeRoom(room);
      }
    } catch (e) {}
    return room;
  }

  function applyRoom(room) {
    if (!room) return;
    room = normalizeHubRoom(room);
    activeRoom = room;
    const titleEl = document.getElementById('hubChatTitle');
    const metaEl = document.getElementById('hubChatMeta');
    if (titleEl) titleEl.textContent = room.name || (isWorld(room.id) ? 'World' : 'Private chat');
    if (metaEl) {
      if (isWorld(room.id)) metaEl.textContent = '';
      else {
        const members = Array.isArray(room.members) ? room.members : [];
        const hostMember = members.find(function (m) { return m.isHost; });
        const n = Number(room.memberCount || members.length || 0);
        let bits = [];
        if (room.isHost) bits.push('You are the host.');
        else if (hostMember && hostMember.name) bits.push(hostMember.name + ' is the host.');
        bits.push(n <= 1 ? 'Invite friends with the code below.' : (n + ' people in this chat.'));
        metaEl.textContent = bits.join(' ');
      }
    }
    showLeave(!isWorld(room.id));
    catchUp(room.id, room.lastAt);
    renderInvite(room);
    paintWorldActive();
    try {
      if (window.__utkHubMembers && typeof window.__utkHubMembers.render === 'function') {
        window.__utkHubMembers.render(room);
      }
    } catch (e) {}
  }

  async function sync(opts) {
    const light = !!(opts && opts.light);
    const requestedRoom = roomId;
    const gen = syncGen;
    const q = '/sync?room=' + encodeURIComponent(requestedRoom) +
      '&after=' + encodeURIComponent(String(afterId)) +
      '&mutAfter=' + encodeURIComponent(String(mutAfter || 0)) +
      '&name=' + encodeURIComponent(displayName()) +
      (light ? '&light=1' : '');
    let data;
    try {
      data = await api('GET', q);
    } catch (err) {
      if (gen !== syncGen || roomId !== requestedRoom) return null;
      const code = err && err.message;
      if (code === 'room_gone' || code === 'private' || code === 'banned') {
        setStatus(friendlyError(code), 'is-err');
        setRoom(WORLD, 'World');
        const fallbackGen = syncGen;
        data = await api('GET', '/sync?room=' + encodeURIComponent(WORLD) +
          '&after=0&mutAfter=0&name=' + encodeURIComponent(displayName()));
        if (fallbackGen !== syncGen || roomId !== WORLD) return null;
        // Adopt the new room generation after forced fallback.
        return await applySyncPayload(data, {
          light: false,
          requestedRoom: WORLD,
          gen: fallbackGen
        });
      }
      throw err;
    }
    return await applySyncPayload(data, { light: light, requestedRoom: requestedRoom, gen: gen });
  }

  async function applySyncPayload(data, ctx) {
    const light = !!(ctx && ctx.light);
    const requestedRoom = ctx && ctx.requestedRoom;
    const gen = ctx && ctx.gen;
    if (!data) return null;
    // Stale response from a previous room — never paint it into the new chat.
    if (gen !== syncGen || roomId !== requestedRoom) return null;
    if (data.room && data.room.id && String(data.room.id) !== String(roomId)) {
      return null;
    }
    try {
      const auth = getAuth();
      if (auth && auth.currentUser && auth.currentUser.uid) {
        youUid = String(auth.currentUser.uid);
      } else if (data.you && data.you.uid) {
        youUid = String(data.you.uid);
      }
    } catch (e) {
      if (data.you && data.you.uid) youUid = String(data.you.uid);
    }
    if (data.you) {
      youOwner = !!(data.you.owner || data.you.isOwner);
    }
    try {
      if (avatars() && avatars().ingest) {
        avatars().ingest(data.messages || []);
        if (data.room && data.room.members) avatars().ingest(data.room.members);
        if (data.presence) avatars().ingest(data.presence);
      }
    } catch (e) {}
    if (!light) {
      if (data.room && isWorld(data.room.id) && Array.isArray(data.presence)) {
        data.room.members = data.presence.map(function (p) {
          return {
            uid: p.uid,
            name: p.name || 'Trader',
            online: true,
            avatar: p.avatar || '',
            owner: !!p.owner,
            paid: !!(p.paid || p.member || p.owner),
            member: !!(p.paid || p.member || p.owner),
            isYou: !!(youUid && p.uid && String(p.uid) === String(youUid))
          };
        });
      }
      if (gen === syncGen && roomId === requestedRoom) {
        applyRoom(data.room);
        if (Array.isArray(data.rooms)) roomsCache = data.rooms;
        renderRooms(data.rooms);
        pushProfile(false);
      }
    } else if (Array.isArray(data.rooms) && gen === syncGen) {
      roomsCache = data.rooms;
      renderRooms(data.rooms);
    }
    if (gen !== syncGen || roomId !== requestedRoom) return null;
    const msgs = data.messages || [];
    if (afterId === 0) appendMessages(msgs, true);
    else if (msgs.length) appendMessages(msgs, false);
    const muts = data.mutations || [];
    if (muts.length) {
      try {
        if (window.__utkHubMsgUi && window.__utkHubMsgUi.applyMutations) {
          window.__utkHubMsgUi.applyMutations(muts);
        }
      } catch (e) {}
      muts.forEach(bumpMut);
    }
    if (msgs.length) catchUp(roomId, Date.now());
    roomSwitching = false;
    try {
      const msgEl = document.getElementById('hubMessages');
      if (msgEl) msgEl.classList.remove('is-switching');
    } catch (e) {}
    lastSyncedAt = Date.now();
    setStatus('', '');
    return data;
  }

  function hubIsWarm() {
    try {
      const msgEl = document.getElementById('hubMessages');
      const hasPaint = !!(msgEl && (
        msgEl.querySelector('.hub-msg') ||
        msgEl.querySelector('.hub-empty-chat:not(.hub-empty-loading)')
      ));
      if (!hasPaint) return false;
      return lastSyncedAt > 0 && (Date.now() - lastSyncedAt) < 90000;
    } catch (e) {
      return false;
    }
  }

  async function leaveChat() {
    if (isWorld(roomId)) return;
    try {
      const data = await api('POST', '/leave', { room: roomId });
      if (data && data.deleted) setStatus('Chat deleted for everyone.', 'is-ok');
      setRoom(WORLD, 'World');
      await sync();
    } catch (err) {
      setStatus(friendlyError(err && err.message), 'is-err');
    }
  }

  async function send(text) {
    if (sending) return;
    const msgUi = window.__utkHubMsgUi;
    const editId = msgUi && msgUi.getEditId ? msgUi.getEditId() : null;
    const trimmed = (function (raw) {
      let t = String(raw || '').trim().slice(0, 400);
      try {
        if (window.__utkHubEmotes && typeof window.__utkHubEmotes.expand === 'function') {
          t = window.__utkHubEmotes.expand(t).slice(0, 400);
        }
      } catch (e) {}
      return t;
    })(text);
    const image = (msgUi && msgUi.getPendingImage) ? (msgUi.getPendingImage() || '') : '';
    const replyTo = (msgUi && msgUi.getReplyTo) ? msgUi.getReplyTo() : 0;

    if (editId) {
      if (!trimmed) return;
      sending = true;
      setStatus('', '');
      try {
        const data = await api('POST', '/messages/edit', { id: Number(editId), text: trimmed });
        if (data && data.message && msgUi && msgUi.patchNode) msgUi.patchNode(data.message);
        if (msgUi && msgUi.clearEdit) msgUi.clearEdit();
        setStatus('', '');
      } catch (err) {
        setStatus(friendlyError(err && err.message), 'is-err');
      } finally {
        sending = false;
      }
      return;
    }

    if (!trimmed && !image) return;
    sending = true;
    setStatus('', '');
    const heldImage = image;
    const heldReply = replyTo;
    // Clear compose immediately so UI feels instant (keep held* for the request).
    if (msgUi) {
      if (msgUi.clearComposeExtras) msgUi.clearComposeExtras();
      if (msgUi.clearPendingImage) msgUi.clearPendingImage();
    }
    const tmpId = 'tmp-' + Date.now();
    appendMessages([{
      id: tmpId,
      uid: youUid || 'me',
      name: displayName(),
      text: censor(trimmed),
      image: heldImage || undefined,
      replyTo: heldReply || undefined,
      createdAt: Date.now(),
      isHost: !!(activeRoom && activeRoom.isHost),
      avatar: ownAvatar(),
      tmp: true
    }], false);
    try {
      const body = {
        room: roomId,
        text: trimmed || '',
        name: displayName(),
        avatar: ownAvatar() || undefined
      };
      if (heldReply) body.replyTo = Number(heldReply);
      if (heldImage) body.image = heldImage;
      const data = await api('POST', '/messages', body);
      dropTemp();
      lastMsgUid = youUid;
      if (data.message) appendMessages([data.message], false);
      setStatus('', '');
    } catch (err) {
      dropTemp();
      const input = document.getElementById('hubInput');
      if (input && !input.value && trimmed) input.value = trimmed;
      if (heldImage && msgUi && msgUi.setPendingImage) {
        try { msgUi.setPendingImage(heldImage); } catch (e) {}
      }
      if (heldReply && msgUi && msgUi.setReply) {
        try { msgUi.setReply({ id: heldReply, name: 'Trader', snip: '' }); } catch (e) {}
      }
      const code = err && err.message;
      if (code === 'empty' && heldImage) {
        setStatus('Could not send that photo. Try a smaller image.', 'is-err');
      } else {
        setStatus(friendlyError(code), 'is-err');
      }
    } finally {
      sending = false;
    }
  }

  async function createChat(name) {
    const data = await api('POST', '/rooms', {
      name: name,
      nameHost: displayName(),
      avatar: ownAvatar() || undefined
    });
    if (data.room && data.room.id) {
      setRoom(data.room.id, data.room.name);
      applyRoom(data.room);
      showInviteModal(data.room);
      try { await sync(); } catch (e) {}
    }
    return data;
  }

  async function joinChat(code) {
    const data = await api('POST', '/join', { code: code, name: displayName() });
    if (data.room && data.room.id) {
      setRoom(data.room.id, data.room.name);
      applyRoom(data.room);
      try { await sync(); } catch (e) {}
    }
    return data;
  }

  function modalEls() {
    return {
      modal: document.getElementById('hubModal'),
      title: document.getElementById('hubModalTitle'),
      text: document.getElementById('hubModalText'),
      input: document.getElementById('hubModalInput'),
      ok: document.getElementById('hubModalOk'),
      cancel: document.getElementById('hubModalCancel')
    };
  }

  function hideModal() {
    const els = modalEls();
    if (els.modal) els.modal.setAttribute('hidden', '');
    modalMode = '';
  }

  function showCreateModal() {
    const els = modalEls();
    if (!els.modal) return;
    modalMode = 'create';
    els.title.textContent = 'Create a private chat';
    els.text.textContent = 'Only people you invite can see this chat. You will get a code to share.';
    els.input.hidden = false;
    els.input.value = '';
    els.input.placeholder = 'Name this chat';
    els.ok.textContent = 'Create';
    els.cancel.hidden = false;
    els.cancel.textContent = 'Cancel';
    els.input.readOnly = false;
    els.modal.removeAttribute('hidden');
    setTimeout(function () { try { els.input.focus(); } catch (e) {} }, 30);
  }

  function showJoinModal() {
    const els = modalEls();
    if (!els.modal) return;
    modalMode = 'join';
    els.title.textContent = 'Join a private chat';
    els.text.textContent = 'Type the invite code your friend sent you.';
    els.input.hidden = false;
    els.input.value = '';
    els.input.placeholder = 'Invite code';
    els.ok.textContent = 'Join';
    els.cancel.hidden = false;
    els.cancel.textContent = 'Cancel';
    els.input.readOnly = false;
    els.modal.removeAttribute('hidden');
    setTimeout(function () { try { els.input.focus(); } catch (e) {} }, 30);
  }

  function showInviteModal(room) {
    const els = modalEls();
    if (!els.modal) return;
    modalMode = 'invite';
    const code = (room && room.invite) || currentInvite || '';
    els.title.textContent = 'Private chat is ready';
    els.text.textContent = 'Share this code with friends. Only people with the code can join.';
    els.input.hidden = false;
    els.input.value = code;
    els.input.readOnly = true;
    els.ok.textContent = 'Copy code';
    els.cancel.hidden = false;
    els.cancel.textContent = 'Done';
    els.modal.removeAttribute('hidden');
    try { els.input.select(); } catch (e) {}
  }

  async function copyInvite() {
    const code = currentInvite || (document.getElementById('hubInviteCode') && document.getElementById('hubInviteCode').textContent) || '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setStatus('Invite code copied. Send it to your friends.', 'is-ok');
    } catch (e) {
      setStatus('Code is ' + code + '. Copy it and send it to your friends.', 'is-ok');
    }
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (connectSoftTimer) {
      clearTimeout(connectSoftTimer);
      connectSoftTimer = null;
    }
    if (connectHardTimer) {
      clearTimeout(connectHardTimer);
      connectHardTimer = null;
    }
  }

  function start(opts) {
    opts = opts || {};
    const quiet = !!(opts.quiet || hubIsWarm());
    stop();
    if (!quiet) setStatus('Connecting...', '');
    let settled = false;
    if (!quiet) {
      connectSoftTimer = setTimeout(function () {
        if (!settled) setStatus('Still connecting…', '');
      }, CONNECT_SOFT_MS);
      connectHardTimer = setTimeout(function () {
        if (settled) return;
        chosen = '';
        try { localStorage.removeItem(BASE_CACHE_KEY); } catch (e) {}
        setStatus(friendlyError('hub_unreachable'), 'is-err');
      }, CONNECT_HARD_MS);
    }

    // Profile after first sync so a hung profile call cannot stall Connecting...
    sync({ light: quiet && afterId > 0 }).then(function () {
      settled = true;
      if (connectSoftTimer) {
        clearTimeout(connectSoftTimer);
        connectSoftTimer = null;
      }
      if (connectHardTimer) {
        clearTimeout(connectHardTimer);
        connectHardTimer = null;
      }
      pushProfile(true);
    }).catch(function (err) {
      settled = true;
      if (connectSoftTimer) {
        clearTimeout(connectSoftTimer);
        connectSoftTimer = null;
      }
      if (connectHardTimer) {
        clearTimeout(connectHardTimer);
        connectHardTimer = null;
      }
      const code = err && err.message;
      if (code === 'private') {
        setRoom(WORLD);
        sync().catch(function () {
          setStatus(friendlyError('hub_unreachable'), 'is-err');
        });
        return;
      }
      setStatus(friendlyError(code), 'is-err');
    });
    pollTick = 0;
    pollTimer = setInterval(function () {
      const section = document.getElementById('section-hub');
      if (!section || !section.classList.contains('active')) {
        stop();
        return;
      }
      if (roomSwitching) return;
      pollTick += 1;
      const light = afterId > 0 && (pollTick % FULL_EVERY !== 0);
      sync({ light: light }).catch(function (err) {
        if (err && err.message === 'private') {
          setRoom(WORLD);
        }
      });
    }, POLL_MS);
    if (!quiet) focusComposer();
    // Always land on newest messages when opening Hub
    try { scrollChatEnd(); } catch (eScroll) {}
    setTimeout(function () { try { scrollChatEnd(); } catch (e2) {} }, 40);
    setTimeout(function () { try { scrollChatEnd(); } catch (e3) {} }, 180);
  }

  /** Background warm: paint chat without starting the active poll loop. */
  function warm() {
    return sync({ light: afterId > 0 }).then(function (data) {
      try { pushProfile(false); } catch (e) {}
      return data;
    }).catch(function () {
      return null;
    });
  }

  async function onModalOk() {
    const els = modalEls();
    if (modalMode === 'invite') {
      currentInvite = String(els.input.value || currentInvite || '').trim();
      await copyInvite();
      return;
    }
    const value = String(els.input.value || '').trim();
    if (modalMode === 'create') {
      if (value.length < 2) {
        setStatus(friendlyError('name_short'), 'is-err');
        return;
      }
      try {
        await createChat(value);
        els.input.readOnly = false;
      } catch (err) {
        setStatus(friendlyError(err && err.message), 'is-err');
      }
      return;
    }
    if (modalMode === 'join') {
      if (!value) {
        setStatus(friendlyError('bad_code'), 'is-err');
        return;
      }
      try {
        await joinChat(value);
        hideModal();
        els.input.readOnly = false;
      } catch (err) {
        setStatus(friendlyError(err && err.message), 'is-err');
      }
    }
  }

  function bind() {
    const section = document.getElementById('section-hub');
    if (!section || section.__utkHubBound) return;
    section.__utkHubBound = true;

    const form = document.getElementById('hubComposer');
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        const input = document.getElementById('hubInput');
        const text = input ? input.value : '';
        if (input) input.value = '';
        send(text).then(function () {});
      });
    }

    section.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t || !t.closest) return;

      const roomBtn = t.closest('[data-hub-room]');
      if (roomBtn) {
        ev.preventDefault();
        const id = roomBtn.getAttribute('data-hub-room') || WORLD;
        const nameEl = roomBtn.querySelector('.hub-room-name');
        if (id === roomId && !roomSwitching && afterId > 0) {
          catchUp(id, Date.now());
          roomBtn.classList.remove('has-unread');
          return;
        }
        catchUp(id, Date.now());
        roomBtn.classList.remove('has-unread');
        setRoom(id, nameEl ? nameEl.textContent : '');
        sync({ light: false }).catch(function (err) {
          setStatus(friendlyError(err && err.message), 'is-err');
          roomSwitching = false;
        });
        return;
      }

      const hit = t.closest('[id]');
      const id = (hit && hit.id) || t.id || '';
      if (id === 'hubNewRoomBtn') {
        ev.preventDefault();
        showCreateModal();
        return;
      }
      if (id === 'hubJoinBtn') {
        ev.preventDefault();
        showJoinModal();
        return;
      }
      if (id === 'hubLeaveBtn') {
        ev.preventDefault();
        leaveChat();
        return;
      }
      if (id === 'hubCopyInvite') {
        ev.preventDefault();
        copyInvite();
        return;
      }
      if (id === 'hubModalCancel') {
        ev.preventDefault();
        const els = modalEls();
        if (els.input) els.input.readOnly = false;
        hideModal();
        return;
      }
      if (id === 'hubModalOk') {
        ev.preventDefault();
        onModalOk();
        return;
      }
      if (id === 'hubModal') hideModal();
    });

    const input = document.getElementById('hubModalInput');
    if (input) {
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          onModalOk();
        }
        if (ev.key === 'Escape') hideModal();
      });
    }

    const hubInput = document.getElementById('hubInput');
    if (hubInput) {
      hubInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          if (form) form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }
      });
    }
  }

  function scheduleSectionEnter(fn) {
    try {
      if (window.utkSectionFx && typeof window.utkSectionFx.afterReveal === 'function') {
        window.utkSectionFx.afterReveal(fn);
        return;
      }
    } catch (e) {}
    try {
      requestAnimationFrame(function () {
        try { fn(); } catch (e2) {}
      });
    } catch (e3) {
      try { fn(); } catch (e4) {}
    }
  }

  let hubEnterGen = 0;

  function enterHub() {
    const gen = ++hubEnterGen;
    scheduleSectionEnter(function () {
      if (gen !== hubEnterGen) return;
      const section = document.getElementById('section-hub');
      if (!section || !section.classList.contains('active')) return;
      start();
      setTimeout(function () { try { scrollChatEnd(); } catch (e) {} }, 0);
      setTimeout(function () { try { scrollChatEnd(); } catch (e2) {} }, 120);
    });
  }

  function leaveHub() {
    hubEnterGen += 1;
    stop();
  }

  function patchNavigate() {
    const orig = window.navigateToSection;
    if (typeof orig === 'function' && !orig.__utkHubPatched) {
      function wrapped(id) {
        const result = orig.apply(this, arguments);
        try {
          if (String(id) === 'hub') enterHub();
          else leaveHub();
        } catch (e) {}
        return result;
      }
      wrapped.__utkHubPatched = true;
      window.navigateToSection = wrapped;
    }
    const section = document.getElementById('section-hub');
    if (!section || section.__utkHubObserved) return;
    section.__utkHubObserved = true;
    let wasActive = section.classList.contains('active');
    const obs = new MutationObserver(function () {
      const now = section.classList.contains('active');
      if (now === wasActive) return;
      wasActive = now;
      // Navigate wrap already schedules enter/leave; observer covers raw class toggles.
      if (now) enterHub();
      else leaveHub();
    });
    obs.observe(section, { attributes: true, attributeFilter: ['class'] });
  }

  function init() {
    bind();
    patchNavigate();
    try {
      const auth = getAuth();
      if (auth && typeof auth.onAuthStateChanged === 'function' && !auth.__utkHubAuthWired) {
        auth.__utkHubAuthWired = true;
        auth.onAuthStateChanged(function (user) {
          tokenMemo = '';
          tokenMemoAt = 0;
          youUid = user && user.uid ? String(user.uid) : '';
          youOwner = false;
          afterId = 0;
          try {
            const el = document.getElementById('hubMessages');
            if (el) el.innerHTML = '';
          } catch (e) {}
          try {
            if (document.getElementById('section-hub') &&
                document.getElementById('section-hub').classList.contains('active')) {
              sync({ light: false }).catch(function () {});
            }
          } catch (e2) {}
        });
      }
    } catch (e) {}
    const hubSection = document.getElementById('section-hub');
    if (hubSection && hubSection.classList.contains('active')) {
      start();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__utkCommunityHub = {
    api: api,
    sync: sync,
    send: send,
    start: start,
    stop: stop,
    warm: warm,
    isWarm: hubIsWarm,
    setRoom: setRoom,
    setStatus: setStatus,
    friendlyError: friendlyError,
    getYouUid: function () { return selfUidNow(); },
    getRoomId: function () { return roomId || WORLD; },
    isHost: function () { return !!(activeRoom && activeRoom.isHost); },
    isOwner: function () { return !!youOwner; },
    getPrivateRooms: function () {
      return (roomsCache || []).filter(function (r) {
        return r && r.id && r.id !== WORLD && r.kind !== 'world';
      });
    },
    displayName: displayName,
    openWorld: function () {
      setRoom(WORLD, 'World');
      sync({ light: false }).catch(function () {});
    }
  };
})();
