/**

 * community-hub-members.js — People panel, host gem, kick / timeout / ban.

 * Load AFTER community-hub.js.

 */

(function () {

  'use strict';



  let currentRoom = null;

  let profileUid = '';



  function esc(s) {

    return String(s == null ? '' : s)

      .replace(/&/g, '&amp;')

      .replace(/</g, '&lt;')

      .replace(/>/g, '&gt;')

      .replace(/"/g, '&quot;');

  }



  function hub() {

    return window.__utkCommunityHub || null;

  }



  function avatarApi() {

    return window.__utkHubAvatars || null;

  }



  function getYouUid() {

    try {

      if (hub() && typeof hub().getYouUid === 'function') return hub().getYouUid() || '';

    } catch (e) {}

    return '';

  }



  function toast(msg, tone) {

    try {

      if (typeof window.showAppToast === 'function') {

        window.showAppToast(msg, { tone: tone || 'info' });

        return;

      }

    } catch (e) {}

    try {

      const st = document.getElementById('hubStatus');

      if (st) {

        st.textContent = msg;

        st.className = 'hub-status' + (tone === 'error' ? ' is-err' : '');

      }

    } catch (e2) {}

  }



  function hostUid(room) {

    if (!room) return '';

    const members = Array.isArray(room.members) ? room.members : [];

    const hostMember = members.find(function (m) { return m.isHost; });

    if (hostMember && hostMember.uid) return String(hostMember.uid);

    return String(room.createdBy || room.created_by || '');

  }



  function roomIsHost(room) {

    if (!room) return false;

    if (room.isHost) return true;

    const you = getYouUid();

    const hid = hostUid(room);

    return !!(you && hid && String(you) === String(hid));

  }



  function isYouOwner() {

    try {

      const h = hub();

      return !!(h && h.isOwner && h.isOwner());

    } catch (e) {

      return false;

    }

  }



  function isWorldRoom(room) {

    if (!room) return true;

    return room.kind === 'world' || room.id === 'lobby' || !room.id;

  }



  function canUseModTools(room) {

    return !!(isYouOwner() || roomIsHost(room));

  }



  function normalizeMembers(room, members) {

    const you = getYouUid();

    const hid = hostUid(room);

    return (members || []).map(function (m) {

      const uid = String(m.uid || '');

      const copy = Object.assign({}, m);

      copy.isYou = !!(you && uid === String(you));

      copy.isHost = !!copy.isHost || (!!hid && uid === String(hid));
      copy.owner = !!copy.owner;
      copy.paid = !!copy.paid || !!copy.member || !!copy.owner;
      copy.member = !!copy.member || !!copy.paid || !!copy.owner;

      if (!copy.name || String(copy.name).toLowerCase() === 'host') {

        if (copy.isYou && hub() && typeof hub().displayName === 'function') {

          const dn = hub().displayName();

          if (dn && dn.toLowerCase() !== 'host') copy.name = dn;

        }

      }

      return copy;

    });

  }



  function dedupeMembers(members) {

    const byUid = new Map();

    (members || []).forEach(function (m) {

      const uid = String(m.uid || '');

      if (!uid) return;

      const prev = byUid.get(uid);

      if (!prev) {

        byUid.set(uid, m);

        return;

      }

      const prevBad = !prev.name || String(prev.name).toLowerCase() === 'host';

      const nextBad = !m.name || String(m.name).toLowerCase() === 'host';

      if (prevBad && !nextBad) byUid.set(uid, m);

      else if (!prev.avatar && m.avatar) byUid.set(uid, Object.assign({}, prev, { avatar: m.avatar }));

    });

    return Array.from(byUid.values());

  }



  function normalizeRoom(room) {

    if (!room) return room;

    const next = Object.assign({}, room);

    next.isHost = roomIsHost(next);

    next.members = dedupeMembers(normalizeMembers(next, next.members || []));

    return next;

  }



  function sortMembers(members) {

    return (members || []).slice().sort(function (a, b) {

      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;

      if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;

      if (a.online !== b.online) return a.online ? -1 : 1;

      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });

    });

  }



  function canModerate(room, member) {

    if (!member || member.isYou || member.owner) return false;

    if (isYouOwner()) return true;

    return !!(roomIsHost(room) && !member.isHost);

  }



  function memberRowHtml(m, room) {

    const you = m.isYou ? '<span class="hub-member-you">you</span>' : '';

    const statusClass = m.isHost ? 'is-host' : (m.online ? 'is-online' : 'is-offline');

    const statusLabel = m.isHost ? 'Host' : (m.online ? 'Online' : 'Offline');

    const mod = canModerate(room, m);

    let actions = '';

    if (mod) {

      const world = isWorldRoom(room);

      actions =

        '<div class="hub-member-actions">' +

          (world ? '' : '<button type="button" class="hub-mod-btn hub-mod-kick" data-hub-mod="kick" data-hub-uid="' + esc(m.uid) + '" title="Remove from chat">Kick</button>') +

          '<button type="button" class="hub-mod-btn hub-mod-timeout" data-hub-mod="timeout" data-hub-uid="' + esc(m.uid) + '" title="Timeout 10 minutes">10m</button>' +

          '<button type="button" class="hub-mod-btn hub-mod-ban" data-hub-mod="ban" data-hub-uid="' + esc(m.uid) + '" title="Ban from chat">Ban</button>' +

        '</div>';

    }

    const av = (avatarApi() && avatarApi().html)

      ? avatarApi().html({
        uid: m.uid,
        name: m.name || 'Trader',
        avatar: m.avatar,
        online: !!m.online,
        paid: !!(m.paid || m.member || m.owner),
        member: !!(m.paid || m.member || m.owner),
        owner: !!m.owner
      })

      : ('<span class="hub-avatar' + (m.online ? ' is-online' : ' is-offline') + '">' + esc(String(m.name || 'T').slice(0, 1).toUpperCase()) + '</span>');

    const roleTag = m.owner
      ? '<span class="hub-owner-tag">Owner</span>'
      : ((m.paid || m.member) ? '<span class="hub-member-tag">Citizen</span>' : '');

    return (

      '<div class="hub-member-row' + (m.isHost ? ' is-host-row' : '') + (m.isYou ? ' is-you-row' : '') + '" data-hub-member="' + esc(m.uid) + '">' +

        av +

        '<div class="hub-member-info">' +

          '<strong class="hub-member-name">' +

            (m.isHost ? '<span class="hub-host-gem" title="Host" aria-hidden="true"></span>' : '') +

            esc(m.name || 'Trader') +

            you +

            roleTag +

          '</strong>' +

          '<span class="hub-member-status ' + statusClass + '">' + esc(statusLabel) + '</span>' +

        '</div>' +

        actions +

      '</div>'

    );

  }



  function ensureUi() {

    const head = document.querySelector('#section-hub .hub-chat-head');

    if (head && !document.getElementById('hubPeopleBtn')) {

      const actions = document.createElement('div');

      actions.className = 'hub-head-actions';

      const leave = document.getElementById('hubLeaveBtn');

      actions.innerHTML =

        '<button type="button" id="hubPeopleBtn" class="hub-people" hidden>People</button>' +

        '<button type="button" id="hubDeleteRoomBtn" class="hub-delete-room" hidden>Delete chat</button>';

      if (leave && leave.parentNode === head) {

        head.insertBefore(actions, leave);

        actions.appendChild(leave);

      } else {

        head.appendChild(actions);

      }

    }

    if (!document.getElementById('hubMembersPanel')) {

      const chat = document.querySelector('#section-hub .hub-chat');

      if (chat) {

        const panel = document.createElement('aside');

        panel.id = 'hubMembersPanel';

        panel.className = 'hub-members';

        panel.hidden = true;

        panel.innerHTML =

          '<div class="hub-members-head">' +

            '<h3>People</h3>' +

            '<button type="button" id="hubMembersClose" class="hub-members-close">Close</button>' +

          '</div>' +

          '<div id="hubMembersList" class="hub-members-list"></div>';

        chat.appendChild(panel);

      }

    }

    if (!document.getElementById('hubMemberProfile')) {

      const el = document.createElement('div');

      el.id = 'hubMemberProfile';

      el.className = 'hub-member-profile';

      el.hidden = true;

      el.innerHTML =

        '<div class="hub-member-profile-card">' +

          '<div class="hub-member-profile-head">' +

            '<span class="hub-avatar is-offline hub-avatar-lg" id="hubMemberProfileAvatar">T</span>' +

            '<div>' +

              '<h3 id="hubMemberProfileName">Trader</h3>' +

              '<p id="hubMemberProfileMeta"></p>' +

              '<p id="hubMemberProfileHint" class="hub-member-profile-hint"></p>' +

            '</div>' +

          '</div>' +

          '<div class="hub-member-profile-actions">' +

            '<button type="button" id="hubMemberKick" class="hub-mod-btn hub-mod-kick" hidden>Kick</button>' +

            '<button type="button" id="hubMemberTimeout" class="hub-mod-btn hub-mod-timeout" hidden>Timeout 10m</button>' +

            '<button type="button" id="hubMemberBan" class="hub-mod-btn hub-mod-ban" hidden>Ban</button>' +

            '<button type="button" id="hubMemberProfileClose" class="hub-members-close">Close</button>' +

          '</div>' +

        '</div>';

      document.body.appendChild(el);

    }

  }



  function setPanelOpen(panel, open) {

    if (!panel) return;

    if (open) {

      panel.hidden = false;

      panel.classList.remove('is-closing');

      panel.classList.add('is-open');

    } else {

      if (panel.hidden) return;

      panel.classList.remove('is-open');

      panel.classList.add('is-closing');

      window.setTimeout(function () {

        panel.hidden = true;

        panel.classList.remove('is-closing');

      }, 180);

    }

  }



  function renderMembers(room) {

    ensureUi();

    currentRoom = normalizeRoom(room);

    room = currentRoom;

    const peopleBtn = document.getElementById('hubPeopleBtn');

    const deleteBtn = document.getElementById('hubDeleteRoomBtn');

    const panel = document.getElementById('hubMembersPanel');

    const list = document.getElementById('hubMembersList');

    const privateRoom = !!(room && room.kind === 'private' && room.id && room.id !== 'lobby');

    const worldPeople = !!(isWorldRoom(room) && isYouOwner());

    const showPeople = privateRoom || worldPeople;

    if (peopleBtn) {

      if (showPeople) peopleBtn.removeAttribute('hidden');

      else peopleBtn.setAttribute('hidden', '');

    }

    if (deleteBtn) {

      if (privateRoom && roomIsHost(room)) deleteBtn.removeAttribute('hidden');

      else deleteBtn.setAttribute('hidden', '');

    }

    if (!list) return;

    if (!showPeople) {

      if (panel) setPanelOpen(panel, false);

      list.innerHTML = '';

      return;

    }

    const members = sortMembers(room.members || []);

    try {

      if (avatarApi() && avatarApi().ingest) avatarApi().ingest(members);

    } catch (e) {}

    if (!members.length) {

      list.innerHTML = '<p class="hub-members-empty">No one here yet.</p>';

      return;

    }

    list.innerHTML = members.map(function (m) {

      return memberRowHtml(m, room);

    }).join('');

  }



  function memberByUid(uid) {

    if (!currentRoom || !Array.isArray(currentRoom.members)) return null;

    return currentRoom.members.find(function (x) { return String(x.uid) === String(uid); }) || null;

  }



  function openProfile(uid) {

    const room = currentRoom;

    const m = memberByUid(uid);

    if (!room || !m) return;

    profileUid = uid;

    ensureUi();

    const el = document.getElementById('hubMemberProfile');

    const avatar = document.getElementById('hubMemberProfileAvatar');

    const name = document.getElementById('hubMemberProfileName');

    const meta = document.getElementById('hubMemberProfileMeta');

    const hint = document.getElementById('hubMemberProfileHint');

    const kick = document.getElementById('hubMemberKick');

    const timeout = document.getElementById('hubMemberTimeout');

    const ban = document.getElementById('hubMemberBan');

    if (avatar) {

      if (avatarApi() && avatarApi().paint) {

        avatarApi().paint(avatar, {

          uid: m.uid,

          name: m.name || 'Trader',

          avatar: m.avatar,

          online: !!m.online

        });

        avatar.classList.add('hub-avatar-lg');

      } else {

        avatar.textContent = String(m.name || 'T').slice(0, 1).toUpperCase();

        avatar.className = 'hub-avatar hub-avatar-lg' + (m.online ? ' is-online' : ' is-offline');

      }

    }

    if (name) {

      name.innerHTML = (m.isHost ? '<span class="hub-host-gem" title="Host"></span>' : '') + esc(m.name || 'Trader');

    }

    if (meta) {

      const bits = [];

      if (m.isHost) bits.push('Host');

      if (m.isYou) bits.push('You');

      bits.push(m.online ? 'Online now' : 'Offline');

      meta.textContent = bits.join(' · ');

    }

    if (hint) {

      if (m.isYou) hint.textContent = 'This is your account in this chat.';

      else if (m.owner) hint.textContent = 'App owner. Cannot be moderated.';

      else if (m.isHost && !isYouOwner()) hint.textContent = 'Room host. Cannot be moderated.';

      else if (canModerate(room, m)) {
        hint.textContent = isWorldRoom(room)
          ? 'Timeout or ban this person from World chat.'
          : 'Remove, timeout, or ban this member.';
      }

      else if (canUseModTools(room)) hint.textContent = '';

      else hint.textContent = 'Only the host or owner can moderate members.';

    }

    const mod = canModerate(room, m);

    const world = isWorldRoom(room);

    if (kick) {

      if (mod && !world) kick.removeAttribute('hidden');

      else kick.setAttribute('hidden', '');

    }

    [timeout, ban].forEach(function (btn) {

      if (!btn) return;

      if (mod) btn.removeAttribute('hidden');

      else btn.setAttribute('hidden', '');

    });

    if (el) {

      el.hidden = false;

      el.classList.add('is-open');

    }

  }



  function closeProfile() {

    const el = document.getElementById('hubMemberProfile');

    if (el) {

      el.classList.remove('is-open');

      el.hidden = true;

    }

    profileUid = '';

  }



  async function refreshMembers() {

    try {

      if (hub() && typeof hub().sync === 'function') await hub().sync();

    } catch (e) {}

  }



  async function modAction(uid, path, extra, successMsg) {

    const api = hub() && hub().api;

    if (!api || !currentRoom || !uid) return null;

    if (!canUseModTools(currentRoom)) {

      toast('Only the host or owner can do that.', 'error');

      return null;

    }

    try {

      const body = Object.assign({ room: currentRoom.id, uid: uid }, extra || {});

      const data = await api('POST', path, body);

      closeProfile();

      if (data.members) {

        currentRoom.members = normalizeMembers(currentRoom, data.members);

        renderMembers(currentRoom);

      }

      await refreshMembers();

      if (successMsg) toast(successMsg, 'success');

      return data;

    } catch (err) {

      toast((err && err.message) || 'Could not do that.', 'error');

      return null;

    }

  }



  async function kickMember(uid) {

    uid = uid || profileUid;

    if (isWorldRoom(currentRoom)) {

      toast('Use timeout or ban in World chat.', 'error');

      return;

    }

    await modAction(uid, '/kick', null, 'Removed from chat.');

  }



  async function timeoutMember(uid) {

    uid = uid || profileUid;

    await modAction(uid, '/timeout', { minutes: 10 }, 'Timed out for 10 minutes.');

  }



  async function banMember(uid) {

    uid = uid || profileUid;

    const m = memberByUid(uid);

    const label = (m && m.name) ? m.name : 'this person';

    const world = isWorldRoom(currentRoom);

    const ok = window.confirm(
      world
        ? ('Ban ' + label + ' from World chat? They will not be able to send messages here.')
        : ('Ban ' + label + ' from the chat? They cannot rejoin with the invite code.')
    );

    if (!ok) return;

    await modAction(uid, '/ban', null, 'Banned from chat.');

  }



  async function deleteRoom() {

    const api = hub() && hub().api;

    if (!api || !currentRoom || !roomIsHost(currentRoom)) return;

    const ok = window.confirm('Delete this chat for everyone? This cannot be undone.');

    if (!ok) return;

    try {

      await api('POST', '/rooms/delete', { room: currentRoom.id });

      toast('Chat deleted for everyone.', 'success');

      closeProfile();

      const panel = document.getElementById('hubMembersPanel');

      if (panel) setPanelOpen(panel, false);

      if (hub() && typeof hub().openWorld === 'function') hub().openWorld();

      else if (hub() && typeof hub().setRoom === 'function') hub().setRoom('lobby', 'World');

      await refreshMembers();

    } catch (err) {

      toast((err && err.message) || 'Could not delete chat.', 'error');

    }

  }



  function bind() {

    document.addEventListener('click', function (ev) {

      const t = ev.target;

      if (!t) return;



      const modBtn = t.closest && t.closest('[data-hub-mod]');

      if (modBtn) {

        ev.preventDefault();

        ev.stopPropagation();

        const uid = modBtn.getAttribute('data-hub-uid') || profileUid;

        const action = modBtn.getAttribute('data-hub-mod');

        if (action === 'kick') kickMember(uid);

        else if (action === 'timeout') timeoutMember(uid);

        else if (action === 'ban') banMember(uid);

        return;

      }



      if (t.id === 'hubPeopleBtn') {

        ev.preventDefault();

        ensureUi();

        const panel = document.getElementById('hubMembersPanel');

        if (panel) setPanelOpen(panel, panel.hidden || panel.classList.contains('is-closing'));

        return;

      }

      if (t.id === 'hubMembersClose') {

        ev.preventDefault();

        const panel = document.getElementById('hubMembersPanel');

        if (panel) setPanelOpen(panel, false);

        return;

      }

      if (t.id === 'hubDeleteRoomBtn') {

        ev.preventDefault();

        deleteRoom();

        return;

      }

      const row = t.closest && t.closest('[data-hub-member]');

      if (row && !t.closest('.hub-member-actions')) {

        ev.preventDefault();

        openProfile(row.getAttribute('data-hub-member'));

        return;

      }

      if (t.id === 'hubMemberProfileClose' || (t.id === 'hubMemberProfile' && t === ev.target)) {

        ev.preventDefault();

        closeProfile();

      }

    });

  }



  function init() {

    ensureUi();

    bind();

  }



  if (document.readyState === 'loading') {

    document.addEventListener('DOMContentLoaded', init);

  } else {

    init();

  }



  window.__utkHubMembers = {

    render: renderMembers,

    closeProfile: closeProfile,

    normalizeRoom: normalizeRoom

  };

})();


