/**
 * community-hub-msg-ui.js — Discord-like reply / edit / delete / forward / copy / images.
 * Load AFTER community-hub.js.
 */
(function () {
  'use strict';

  const MAX_IMAGE_CHARS = 180000;
  const msgCache = Object.create(null);
  let replyTarget = null;
  let pendingImage = '';
  let editTargetId = null;
  let forwardMsgId = null;

  function hub() {
    return window.__utkCommunityHub || null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function censor(s) {
    try {
      const api = window.__utkHubCensor;
      if (api && typeof api.censorText === 'function') return api.censorText(s);
    } catch (e) {}
    return String(s == null ? '' : s);
  }

  function clock(ms) {
    const d = new Date(Number(ms) || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function formatStamp(ms) {
    const t = Number(ms) || Date.now();
    const d = new Date(t);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayMs = 86400000;
    const time = clock(t);
    if (startMsg === startToday) return 'Today · ' + time;
    if (startMsg === startToday - dayMs) return 'Yesterday · ' + time;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dateBit = d.getDate() + ' ' + months[d.getMonth()];
    if (d.getFullYear() !== now.getFullYear()) {
      return dateBit + ' ' + d.getFullYear() + ' · ' + time;
    }
    return dateBit + ' · ' + time;
  }

  function dayKey(ms) {
    const d = new Date(Number(ms) || 0);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function dayLabel(ms) {
    const t = Number(ms) || Date.now();
    const d = new Date(t);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayMs = 86400000;
    if (startMsg === startToday) return 'Today';
    if (startMsg === startToday - dayMs) return 'Yesterday';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const bit = d.getDate() + ' ' + months[d.getMonth()];
    return d.getFullYear() !== now.getFullYear() ? bit + ' ' + d.getFullYear() : bit;
  }

  function midSel(id) {
    return String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function findMsgNode(el, id) {
    if (!el) return null;
    return el.querySelector('.hub-msg[data-hub-mid="' + midSel(id) + '"]');
  }

  function youUid() {
    try {
      if (window.auth && window.auth.currentUser && window.auth.currentUser.uid) {
        return String(window.auth.currentUser.uid);
      }
    } catch (e) {}
    const h = hub();
    return (h && h.getYouUid && h.getYouUid()) || '';
  }

  function toast(text, kind) {
    const h = hub();
    if (h && h.setStatus) h.setStatus(text || '', kind || '');
  }

  function remember(m) {
    if (!m || m.id == null) return;
    const id = String(m.id);
    if (String(id).indexOf('tmp-') === 0) return;
    msgCache[id] = Object.assign({}, msgCache[id] || {}, m);
  }

  function getCached(id) {
    return msgCache[String(id)] || null;
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

  function msgNameBlock(m) {
    const name = esc(censor(m.name || 'Trader'));
    const owner = !!(m.owner);
    const member = !owner && !!(m.paid || m.member);
    const hostBit = m.isHost
      ? '<span class="hub-host-gem" title="Host" aria-hidden="true"></span>'
      : '';
    const tags =
      (m.isHost ? '<span class="hub-host-tag">Host</span>' : '') +
      (owner ? '<span class="hub-owner-tag" title="Owner">Owner</span>' : '') +
      (member ? '<span class="hub-member-tag" title="Citizen">Citizen</span>' : '');
    let marksName = false;
    try {
      const me = yourName();
      const isSelf = !!(m.isYou || (me && String(m.name || '').trim() === me));
      if (isSelf && window.utkMarks && typeof window.utkMarks.has === 'function' && window.utkMarks.has('hub-title')) {
        marksName = true;
      }
    } catch (e) {}
    const nameCls = 'hub-msg-name' + (marksName ? ' hub-msg-name--marks' : '');
    if (!tags) {
      return '<span class="' + nameCls + '">' + name + '</span>';
    }
    return (
      '<div class="hub-msg-identity">' +
        '<span class="' + nameCls + '">' + hostBit + name + '</span>' +
        tags +
      '</div>'
    );
  }

  const REACT_EMOJIS = ['👍', '🔥', '😂'];
  let unreadCount = 0;
  let lastAppendedDayKey = '';

  function isYouHost() {
    try {
      const h = hub();
      return !!(h && h.isHost && h.isHost());
    } catch (e) {
      return false;
    }
  }

  function isYouOwner() {
    try {
      const h = hub();
      return !!(h && h.isOwner && h.isOwner());
    } catch (e) {
      return false;
    }
  }

  function canModMessages() {
    return isYouHost() || isYouOwner();
  }

  function yourName() {
    try {
      const h = hub();
      if (h && h.displayName) return String(h.displayName() || '').trim();
    } catch (e) {}
    return '';
  }

  function formatMsgText(raw) {
    let s = esc(censor(raw));
    s = s.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      const clean = url.replace(/[),.]+$/g, '');
      const trail = url.slice(clean.length);
      return '<a class="hub-msg-link" href="' + clean + '" data-hub-act="open-link" data-hub-href="' + clean + '">' + clean + '</a>' + trail;
    });
    const me = yourName();
    if (me && me.length >= 2) {
      const re = new RegExp('(^|\\s)(@?' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=\\s|$)', 'gi');
      s = s.replace(re, function (_m, pre, hit) {
        return pre + '<span class="hub-msg-mention">' + hit + '</span>';
      });
    }
    return s;
  }

  function reactionsHtml(m) {
    if (m.deleted) return '';
    const id = esc(String(m.id));
    const list = Array.isArray(m.reactions) ? m.reactions : [];
    let chips = list.map(function (r) {
      if (!r || !r.emoji || !r.count) return '';
      return (
        '<button type="button" class="hub-react-chip' + (r.me ? ' is-me' : '') + '" data-hub-act="react" data-hub-mid="' + id + '" data-hub-emoji="' + esc(r.emoji) + '" title="React">' +
          '<span class="hub-react-emoji">' + esc(r.emoji) + '</span>' +
          '<span class="hub-react-count">' + esc(String(r.count)) + '</span>' +
        '</button>'
      );
    }).join('');
    const picks = REACT_EMOJIS.map(function (em) {
      return (
        '<button type="button" class="hub-react-add" data-hub-act="react" data-hub-mid="' + id + '" data-hub-emoji="' + esc(em) + '" title="' + esc(em) + '">' +
          esc(em) +
        '</button>'
      );
    }).join('');
    return (
      '<div class="hub-react-row">' +
        chips +
        '<div class="hub-react-picker">' + picks + '</div>' +
      '</div>'
    );
  }

  function actionsHtml(m, mine) {
    if (m.deleted) return '';
    const id = esc(String(m.id));
    const canDelete = mine || canModMessages();
    const canTimeout = !mine && isYouOwner() && !m.owner && m.uid;
    let html =
      '<div class="hub-msg-actions" role="toolbar">' +
        '<button type="button" class="hub-msg-act" data-hub-act="reply" data-hub-mid="' + id + '" title="Reply">Reply</button>' +
        '<button type="button" class="hub-msg-act" data-hub-act="forward" data-hub-mid="' + id + '" title="Forward">Forward</button>' +
        '<button type="button" class="hub-msg-act" data-hub-act="copy" data-hub-mid="' + id + '" title="Copy">Copy</button>';
    if (mine) {
      html += '<button type="button" class="hub-msg-act" data-hub-act="edit" data-hub-mid="' + id + '" title="Edit">Edit</button>';
    }
    if (canTimeout) {
      html += '<button type="button" class="hub-msg-act" data-hub-act="timeout" data-hub-mid="' + id + '" data-hub-uid="' + esc(String(m.uid)) + '" title="Timeout 10 minutes">Timeout</button>';
    }
    if (canDelete) {
      html += '<button type="button" class="hub-msg-act is-danger" data-hub-act="delete" data-hub-mid="' + id + '" title="Delete">Delete</button>';
    }
    html += '</div>';
    return html;
  }

  function bodyHtml(m) {
    if (m.deleted) {
      return '<div class="hub-msg-text is-deleted">Message deleted</div>';
    }
    let html = '';
    if (m.replyTo && m.reply) {
      html +=
        '<button type="button" class="hub-msg-reply" data-hub-act="jump" data-hub-mid="' + esc(String(m.replyTo)) + '">' +
          '<span class="hub-msg-reply-name">' + esc(censor(m.reply.name || 'Trader')) + '</span>' +
          '<span class="hub-msg-reply-text">' + esc(censor(m.reply.text || '')) + '</span>' +
        '</button>';
    }
    if (m.forwardOf) {
      const fwd = m.forward || {};
      const roomName = fwd.roomName || m.forwardRoomName || (m.forwardRoom === 'lobby' ? 'World' : 'Private chat');
      const kind = fwd.roomKind || (roomName === 'World' || m.forwardRoom === 'lobby' ? 'world' : 'private');
      const kindLabel = kind === 'world' ? 'World chat' : 'Private chat';
      const fromName = fwd.fromName || m.forwardFromName || '';
      const fromAt = fwd.fromAt || m.forwardFromAt || 0;
      const by = censor(m.name || 'Trader');
      let line = 'Forwarded by ' + by + ' · from ' + censor(roomName) + ' (' + kindLabel + ')';
      if (fromName) line += ' · originally ' + censor(fromName);
      if (fromAt) line += ' · ' + formatStamp(fromAt);
      html += '<div class="hub-msg-forwarded">' + esc(line) + '</div>';
    }
    if (m.image) {
      html +=
        '<button type="button" class="hub-msg-image-btn" data-hub-act="lightbox" data-hub-src="' + esc(m.image) + '">' +
          '<img class="hub-msg-image" src="' + esc(m.image) + '" alt="Photo" loading="lazy" />' +
        '</button>';
    }
    if (m.text) {
      html += '<div class="hub-msg-text">' + formatMsgText(m.text) + '</div>';
    }
    html += reactionsHtml(m);
    return html || '<div class="hub-msg-text"></div>';
  }

  function buildNode(m, opts) {
    opts = opts || {};
    remember(m);
    const self = youUid();
    const mine = !!(m.uid && self && String(m.uid) === String(self));
    const follow = !!opts.follow;
    const emoteOnly = (function (t) {
      if (m.image || m.deleted || m.replyTo) return false;
      const s = String(t || '').trim();
      return !!s && s.length <= 24 && !/[A-Za-z0-9]/.test(s);
    })(m.text);
    const node = document.createElement('div');
    node.className =
      'hub-msg' +
      (mine ? ' is-mine' : '') +
      (follow ? ' is-follow' : '') +
      (emoteOnly ? ' is-emote' : '') +
      (m.isHost ? ' is-host' : '') +
      (m.owner ? ' is-owner' : '') +
      (m.deleted ? ' is-deleted' : '');
    node.setAttribute('data-hub-mid', String(m.id));
    if (m.tmp) node.setAttribute('data-hub-tmp', '1');
    const avatarHtml = (avatars() && avatars().html)
      ? avatars().html({
        uid: m.uid,
        name: m.name || 'Trader',
        avatar: m.avatar || (mine ? ownAvatar() : ''),
        online: true,
        paid: !!(m.paid || m.member || m.owner),
        member: !!(m.paid || m.member || m.owner),
        owner: !!m.owner
      })
      : '';
    const timeBits = esc(formatStamp(m.createdAt)) + (m.editedAt && !m.deleted ? ' · edited' : '');
    node.innerHTML =
      '<div class="hub-msg-row">' +
        (follow ? '<div class="hub-msg-avatar-spacer" aria-hidden="true"></div>' : avatarHtml) +
        '<div class="hub-msg-bubble">' +
          actionsHtml(m, mine) +
          '<div class="hub-msg-meta">' +
            msgNameBlock(m) +
            '<span class="hub-msg-time" title="' + esc(new Date(Number(m.createdAt) || Date.now()).toLocaleString()) + '">' + timeBits + '</span>' +
          '</div>' +
          '<div class="hub-msg-body">' + bodyHtml(m) + '</div>' +
        '</div>' +
      '</div>';
    return node;
  }

  function ensureDaySep(el, ms) {
    if (!el) return;
    const key = dayKey(ms);
    if (key === lastAppendedDayKey) return;
    lastAppendedDayKey = key;
    const sep = document.createElement('div');
    sep.className = 'hub-day-sep';
    sep.setAttribute('data-hub-day', key);
    sep.innerHTML = '<span>' + esc(dayLabel(ms)) + '</span>';
    el.appendChild(sep);
  }

  function resetDayTrack() {
    lastAppendedDayKey = '';
  }

  function beforeAppend(el, m) {
    if (!el || !m || m.tmp) return;
    ensureDaySep(el, m.createdAt);
  }

  function patchNode(m) {
    remember(m);
    const el = document.getElementById('hubMessages');
    if (!el) return;
    const node = findMsgNode(el, m.id);
    if (!node) return;
    const follow = node.classList.contains('is-follow');
    const self = youUid();
    const fresh = buildNode(m, {
      follow: follow,
      mine: !!(m.uid && self && String(m.uid) === String(self))
    });
    node.className = fresh.className;
    node.innerHTML = fresh.innerHTML;
  }

  function applyMutations(rows) {
    (rows || []).forEach(function (m) {
      if (!m || m.id == null) return;
      patchNode(m);
    });
  }

  function paintReplyBar() {
    const bar = document.getElementById('hubReplyBar');
    if (!bar) return;
    if (editTargetId) {
      bar.removeAttribute('hidden');
      bar.innerHTML =
        '<div class="hub-reply-bar-inner">' +
          '<span class="hub-reply-bar-label">Editing message</span>' +
          '<button type="button" class="hub-reply-bar-cancel" data-hub-act="cancel-compose">Cancel</button>' +
        '</div>';
      return;
    }
    if (!replyTarget) {
      bar.setAttribute('hidden', '');
      bar.innerHTML = '';
      return;
    }
    bar.removeAttribute('hidden');
    bar.innerHTML =
      '<div class="hub-reply-bar-inner">' +
        '<div class="hub-reply-bar-text">' +
          '<span class="hub-reply-bar-label">Replying to ' + esc(censor(replyTarget.name || 'Trader')) + '</span>' +
          '<span class="hub-reply-bar-snip">' + esc(censor(replyTarget.snip || '')) + '</span>' +
        '</div>' +
        '<button type="button" class="hub-reply-bar-cancel" data-hub-act="cancel-compose">Cancel</button>' +
      '</div>';
  }

  function paintImagePreview() {
    const box = document.getElementById('hubImagePreview');
    if (!box) return;
    if (!pendingImage) {
      box.setAttribute('hidden', '');
      box.innerHTML = '';
      return;
    }
    box.removeAttribute('hidden');
    box.innerHTML =
      '<img src="' + esc(pendingImage) + '" alt="" />' +
      '<button type="button" class="hub-image-preview-x" data-hub-act="clear-image" title="Remove">×</button>';
  }

  function setReply(m) {
    editTargetId = null;
    if (!m || m.deleted) {
      replyTarget = null;
      paintReplyBar();
      return;
    }
    const snip = m.text || (m.image ? 'Photo' : '');
    replyTarget = { id: m.id, name: m.name || 'Trader', snip: String(snip).slice(0, 80) };
    paintReplyBar();
    const input = document.getElementById('hubInput');
    if (input) setTimeout(function () { try { input.focus(); } catch (e) {} }, 20);
  }

  function clearComposeExtras() {
    replyTarget = null;
    editTargetId = null;
    paintReplyBar();
  }

  function getReplyTo() {
    return replyTarget && replyTarget.id ? replyTarget.id : 0;
  }

  function getPendingImage() {
    return pendingImage || '';
  }

  function clearPendingImage() {
    pendingImage = '';
    paintImagePreview();
  }

  function setPendingImage(dataUrl) {
    pendingImage = String(dataUrl || '');
    paintImagePreview();
  }

  function getEditId() {
    return editTargetId;
  }

  function clearEdit() {
    editTargetId = null;
    paintReplyBar();
  }

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !String(file.type || '').startsWith('image/')) {
        reject(new Error('bad_image'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('bad_image')); };
      reader.onload = function () {
        const img = new Image();
        img.onerror = function () { reject(new Error('bad_image')); };
        img.onload = function () {
          const maxSide = 1280;
          let w = img.width || 1;
          let h = img.height || 1;
          const scale = Math.min(1, maxSide / Math.max(w, h));
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('bad_image'));
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          let quality = 0.82;
          let data = canvas.toDataURL('image/jpeg', quality);
          while (data.length > MAX_IMAGE_CHARS && quality > 0.4) {
            quality -= 0.08;
            data = canvas.toDataURL('image/jpeg', quality);
          }
          if (data.length > MAX_IMAGE_CHARS) {
            const shrink = Math.sqrt(MAX_IMAGE_CHARS / data.length) * 0.92;
            canvas.width = Math.max(1, Math.round(w * shrink));
            canvas.height = Math.max(1, Math.round(h * shrink));
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            data = canvas.toDataURL('image/jpeg', 0.7);
          }
          if (data.length > MAX_IMAGE_CHARS) {
            reject(new Error('image_too_large'));
            return;
          }
          resolve(data);
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  async function onPickImage(file) {
    try {
      pendingImage = await compressImage(file);
      paintImagePreview();
      toast('', '');
    } catch (err) {
      pendingImage = '';
      paintImagePreview();
      toast(err && err.message === 'image_too_large'
        ? 'Image is too large. Try a smaller photo.'
        : 'Could not attach that image.', 'is-err');
    }
  }

  function ensureForwardModal() {
    let modal = document.getElementById('hubForwardModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'hubForwardModal';
    modal.className = 'hub-modal';
    modal.setAttribute('hidden', '');
    modal.innerHTML =
      '<div class="hub-modal-card hub-forward-card">' +
        '<h3>Forward to private chat</h3>' +
        '<p>Pick a private chat you are in.</p>' +
        '<div id="hubForwardList" class="hub-forward-list"></div>' +
        '<div class="hub-modal-actions">' +
          '<button type="button" id="hubForwardCancel">Cancel</button>' +
        '</div>' +
      '</div>';
    const section = document.getElementById('section-hub');
    if (section) section.appendChild(modal);
    return modal;
  }

  function ensureLightbox() {
    let box = document.getElementById('hubLightbox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'hubLightbox';
      box.className = 'hub-lightbox';
      box.setAttribute('hidden', '');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.innerHTML =
        '<button type="button" class="hub-lightbox-x" id="hubLightboxClose" title="Close" aria-label="Close">×</button>' +
        '<img id="hubLightboxImg" alt="" />';
      document.body.appendChild(box);
    }
    if (!box.__utkLightboxBound) {
      box.__utkLightboxBound = true;
      box.addEventListener('click', function (ev) {
        const t = ev.target;
        if (t === box || (t && (t.id === 'hubLightboxClose' || (t.classList && t.classList.contains('hub-lightbox-x'))))) {
          ev.preventDefault();
          closeLightbox();
        }
      });
    }
    return box;
  }

  function openLightbox(src) {
    if (!src) return;
    const box = ensureLightbox();
    const img = document.getElementById('hubLightboxImg');
    if (img) img.src = src;
    box.removeAttribute('hidden');
    try { document.body.classList.add('hub-lightbox-open'); } catch (e) {}
  }

  function closeLightbox() {
    const box = document.getElementById('hubLightbox');
    if (!box) return;
    box.setAttribute('hidden', '');
    const img = document.getElementById('hubLightboxImg');
    if (img) img.removeAttribute('src');
    try { document.body.classList.remove('hub-lightbox-open'); } catch (e) {}
  }

  function showForwardPicker(msgId) {
    const h = hub();
    if (!h || !h.getPrivateRooms) {
      toast('No private chats to forward into.', 'is-err');
      return;
    }
    const rooms = h.getPrivateRooms() || [];
    const current = h.getRoomId ? h.getRoomId() : '';
    const list = rooms.filter(function (r) {
      return r && r.id && r.id !== current && r.id !== 'lobby';
    });
    if (!list.length) {
      toast('Join or create a private chat first.', 'is-err');
      return;
    }
    forwardMsgId = msgId;
    const modal = ensureForwardModal();
    const wrap = document.getElementById('hubForwardList');
    if (wrap) {
      wrap.innerHTML = list.map(function (r) {
        return (
          '<button type="button" class="hub-forward-room" data-hub-act="forward-to" data-hub-room="' + esc(r.id) + '">' +
            esc(censor(r.name || 'Private chat')) +
          '</button>'
        );
      }).join('');
    }
    modal.removeAttribute('hidden');
  }

  function hideForward() {
    forwardMsgId = null;
    const modal = document.getElementById('hubForwardModal');
    if (modal) modal.setAttribute('hidden', '');
  }

  async function doForward(toRoom) {
    const h = hub();
    const mid = forwardMsgId;
    hideForward();
    if (!h || !h.api || !mid || !toRoom) return;
    try {
      await h.api('POST', '/messages/forward', {
        id: Number(mid),
        toRoom: toRoom,
        name: h.displayName ? h.displayName() : undefined
      });
      toast('Forwarded.', 'is-ok');
    } catch (err) {
      toast((h.friendlyError && h.friendlyError(err && err.message)) || 'Could not forward.', 'is-err');
    }
  }

  let pendingDeleteId = null;
  let deleteBusy = false;

  function ensureDeleteModal() {
    let modal = document.getElementById('hubDeleteModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'hubDeleteModal';
    modal.className = 'hub-modal hub-delete-modal';
    modal.setAttribute('hidden', '');
    modal.innerHTML =
      '<div class="hub-modal-card hub-delete-card" role="dialog" aria-modal="true" aria-labelledby="hubDeleteTitle">' +
        '<div class="hub-delete-icon" aria-hidden="true">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">' +
            '<path d="M4 7h16"></path>' +
            '<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>' +
            '<path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"></path>' +
            '<path d="M10 11v6M14 11v6"></path>' +
          '</svg>' +
        '</div>' +
        '<h3 id="hubDeleteTitle">Delete message?</h3>' +
        '<p id="hubDeleteText">This removes it for everyone in the chat.</p>' +
        '<div id="hubDeletePreview" class="hub-delete-preview" hidden></div>' +
        '<div class="hub-modal-actions hub-delete-actions">' +
          '<button type="button" id="hubDeleteCancel" class="hub-delete-cancel">Cancel</button>' +
          '<button type="button" id="hubDeleteConfirm" class="hub-delete-confirm">Delete</button>' +
        '</div>' +
      '</div>';
    const section = document.getElementById('section-hub');
    if (section) section.appendChild(modal);
    return modal;
  }

  function hideDeleteModal() {
    pendingDeleteId = null;
    deleteBusy = false;
    const modal = document.getElementById('hubDeleteModal');
    if (!modal) return;
    modal.setAttribute('hidden', '');
    modal.classList.remove('is-busy');
    const btn = document.getElementById('hubDeleteConfirm');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  }

  function showDeleteModal(mid) {
    const m = getCached(mid);
    if (!m || m.deleted) return;
    pendingDeleteId = mid;
    const modal = ensureDeleteModal();
    const title = document.getElementById('hubDeleteTitle');
    const text = document.getElementById('hubDeleteText');
    const self = youUid();
    const mine = !!(m.uid && self && String(m.uid) === String(self));
    if (title) title.textContent = mine ? 'Delete message?' : 'Remove message?';
    if (text) {
      text.textContent = mine
        ? 'This removes it for everyone in the chat.'
        : 'Remove this message for everyone? They will see it as deleted.';
    }
    const preview = document.getElementById('hubDeletePreview');
    if (preview) {
      const bits = [];
      if (m.image) bits.push('Photo');
      if (m.text) bits.push(String(m.text).slice(0, 120));
      if (bits.length) {
        preview.textContent = bits.join(' · ');
        preview.removeAttribute('hidden');
      } else {
        preview.textContent = '';
        preview.setAttribute('hidden', '');
      }
    }
    const btn = document.getElementById('hubDeleteConfirm');
    if (btn) {
      btn.disabled = false;
      btn.textContent = mine ? 'Delete' : 'Remove';
    }
    modal.classList.remove('is-busy');
    modal.removeAttribute('hidden');
    setTimeout(function () {
      try {
        const c = document.getElementById('hubDeleteCancel');
        if (c) c.focus();
      } catch (e) {}
    }, 30);
  }

  async function confirmDelete() {
    const h = hub();
    const mid = pendingDeleteId;
    if (!h || !h.api || !mid || deleteBusy) return;
    deleteBusy = true;
    const modal = document.getElementById('hubDeleteModal');
    const btn = document.getElementById('hubDeleteConfirm');
    if (modal) modal.classList.add('is-busy');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Deleting…';
    }
    try {
      const data = await h.api('POST', '/messages/delete', { id: Number(mid) });
      hideDeleteModal();
      if (data && data.message) patchNode(data.message);
    } catch (err) {
      deleteBusy = false;
      if (modal) modal.classList.remove('is-busy');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
      toast((h.friendlyError && h.friendlyError(err && err.message)) || 'Could not delete.', 'is-err');
    }
  }

  function doDelete(mid) {
    showDeleteModal(mid);
  }

  async function doTimeout(uid, mid) {
    const h = hub();
    if (!h || !h.api || !uid || !isYouOwner()) return;
    const m = mid ? getCached(mid) : null;
    const label = (m && m.name) ? m.name : 'this person';
    const ok = window.confirm('Timeout ' + label + ' for 10 minutes in this chat?');
    if (!ok) return;
    try {
      const room = (h.getRoomId && h.getRoomId()) || 'lobby';
      await h.api('POST', '/timeout', { room: room, uid: uid, minutes: 10 });
      toast('Timed out for 10 minutes.', 'is-ok');
    } catch (err) {
      toast((h.friendlyError && h.friendlyError(err && err.message)) || 'Could not timeout.', 'is-err');
    }
  }

  async function toggleReact(mid, emoji) {
    const h = hub();
    if (!h || !h.api || !mid || !emoji) return;
    try {
      const data = await h.api('POST', '/messages/react', { id: Number(mid), emoji: emoji });
      if (data && data.message) patchNode(data.message);
    } catch (err) {
      toast((h.friendlyError && h.friendlyError(err && err.message)) || 'Could not react.', 'is-err');
    }
  }

  function openExternalLink(href) {
    const url = String(href || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    try {
      if (window.__utkSecurity && typeof window.__utkSecurity.openExternal === 'function') {
        window.__utkSecurity.openExternal(url);
        return;
      }
    } catch (e) {}
    try {
      const { ipcRenderer } = require('electron');
      ipcRenderer.invoke('open-external-url', { url });
      return;
    } catch (e) {}
  }

  function paintUnreadChip() {
    const chat = document.querySelector('#section-hub .hub-chat');
    if (!chat) return;
    let chip = document.getElementById('hubUnreadChip');
    if (unreadCount <= 0) {
      if (chip) chip.setAttribute('hidden', '');
      return;
    }
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.id = 'hubUnreadChip';
      chip.className = 'hub-unread-chip';
      chip.setAttribute('data-hub-act', 'jump-latest');
      chat.appendChild(chip);
    }
    chip.textContent = unreadCount === 1 ? '1 new message' : (unreadCount + ' new messages');
    chip.removeAttribute('hidden');
  }

  function noteUnread(n) {
    unreadCount += Math.max(0, Number(n) || 0);
    paintUnreadChip();
  }

  function resetUnread() {
    unreadCount = 0;
    paintUnreadChip();
  }

  function jumpLatest() {
    scrollToBottom();
    resetUnread();
  }

  function scrollToBottom(el) {
    if (!el) el = document.getElementById('hubMessages');
    if (!el) return;
    const snap = function () { el.scrollTop = el.scrollHeight; };
    snap();
    requestAnimationFrame(function () {
      snap();
      requestAnimationFrame(function () {
        snap();
        setTimeout(snap, 40);
      });
    });
  }

  function startEdit(mid) {
    const m = getCached(mid);
    if (!m || m.deleted) return;
    replyTarget = null;
    editTargetId = mid;
    pendingImage = '';
    paintImagePreview();
    paintReplyBar();
    const input = document.getElementById('hubInput');
    if (input) {
      input.value = m.text || '';
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 20);
    }
  }

  async function copyMsg(mid) {
    const m = getCached(mid);
    const text = (m && m.text) || '';
    if (!text) {
      toast('Nothing to copy.', 'is-err');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied.', 'is-ok');
    } catch (e) {
      toast('Could not copy.', 'is-err');
    }
  }

  function jumpTo(mid) {
    const el = document.getElementById('hubMessages');
    if (!el) return;
    const node = findMsgNode(el, mid);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('is-flash');
    setTimeout(function () { try { node.classList.remove('is-flash'); } catch (e) {} }, 900);
  }

  function ensureComposeChrome() {
    const wrap = document.getElementById('hubComposeWrap');
    const form = document.getElementById('hubComposer');
    if (!wrap || !form) return;

    if (!document.getElementById('hubReplyBar')) {
      const bar = document.createElement('div');
      bar.id = 'hubReplyBar';
      bar.className = 'hub-reply-bar';
      bar.setAttribute('hidden', '');
      wrap.insertBefore(bar, form);
    }
    if (!document.getElementById('hubImagePreview')) {
      const prev = document.createElement('div');
      prev.id = 'hubImagePreview';
      prev.className = 'hub-image-preview';
      prev.setAttribute('hidden', '');
      wrap.insertBefore(prev, form);
    }
    if (!document.getElementById('hubAttachBtn')) {
      const emo = document.getElementById('hubEmoteBtn');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'hubAttachBtn';
      btn.className = 'hub-emo-btn hub-attach-btn';
      btn.title = 'Attach image';
      btn.setAttribute('aria-label', 'Attach image');
      btn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">' +
          '<rect x="3" y="5" width="18" height="14" rx="2"></rect>' +
          '<circle cx="8.5" cy="10" r="1.5" fill="currentColor" stroke="none"></circle>' +
          '<path d="M21 16l-5.5-5.5L7 19"></path>' +
        '</svg>';
      if (emo && emo.parentNode) emo.parentNode.insertBefore(btn, emo.nextSibling);
      else form.insertBefore(btn, form.firstChild);
    }
    if (!document.getElementById('hubImageInput')) {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'hubImageInput';
      input.accept = 'image/*';
      input.hidden = true;
      wrap.appendChild(input);
    }
  }

  function closeMsgMenus(except) {
    const root = document.getElementById('hubMessages');
    if (!root) return;
    root.querySelectorAll('.hub-msg.is-menu-open').forEach(function (el) {
      if (except && el === except) return;
      el.classList.remove('is-menu-open');
    });
  }

  function bind() {
    const section = document.getElementById('section-hub');
    if (!section || section.__utkHubMsgUiBound) return;
    section.__utkHubMsgUiBound = true;
    ensureComposeChrome();

    section.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t || !t.closest) return;

      if (t.id === 'hubAttachBtn' || t.closest('#hubAttachBtn')) {
        ev.preventDefault();
        const file = document.getElementById('hubImageInput');
        if (file) file.click();
        return;
      }
      if (t.id === 'hubForwardCancel' || (t.id === 'hubForwardModal' && t === ev.target)) {
        ev.preventDefault();
        hideForward();
        return;
      }
      if (t.id === 'hubDeleteCancel' || (t.id === 'hubDeleteModal' && t === ev.target)) {
        ev.preventDefault();
        hideDeleteModal();
        return;
      }
      if (t.id === 'hubDeleteConfirm' || t.closest('#hubDeleteConfirm')) {
        ev.preventDefault();
        confirmDelete();
        return;
      }

      const actEl = t.closest('[data-hub-act]');
      const msgEl = t.closest('.hub-msg');

      if (!actEl) {
        if (msgEl && !msgEl.classList.contains('is-deleted')) {
          const skip = t.closest('a, .hub-msg-link, .hub-msg-image-btn, .hub-react-chip, input, textarea');
          if (!skip) {
            ev.preventDefault();
            const wasOpen = msgEl.classList.contains('is-menu-open');
            closeMsgMenus();
            if (!wasOpen) msgEl.classList.add('is-menu-open');
            return;
          }
        }
        if (!t.closest('.hub-msg-actions') && !t.closest('.hub-react-picker')) {
          closeMsgMenus();
        }
        return;
      }

      const act = actEl.getAttribute('data-hub-act');
      const mid = actEl.getAttribute('data-hub-mid');

      if (act === 'cancel-compose') {
        ev.preventDefault();
        const wasEdit = !!editTargetId;
        clearComposeExtras();
        clearPendingImage();
        const input = document.getElementById('hubInput');
        if (input && wasEdit) input.value = '';
        return;
      }
      if (act === 'clear-image') {
        ev.preventDefault();
        clearPendingImage();
        return;
      }
      if (act === 'lightbox') {
        ev.preventDefault();
        openLightbox(actEl.getAttribute('data-hub-src') || '');
        return;
      }
      if (act === 'react') {
        ev.preventDefault();
        toggleReact(actEl.getAttribute('data-hub-mid'), actEl.getAttribute('data-hub-emoji'));
        closeMsgMenus();
        return;
      }
      if (act === 'open-link') {
        ev.preventDefault();
        openExternalLink(actEl.getAttribute('data-hub-href') || actEl.getAttribute('href') || '');
        return;
      }
      if (act === 'jump-latest') {
        ev.preventDefault();
        jumpLatest();
        return;
      }
      if (act === 'jump' && mid) {
        ev.preventDefault();
        jumpTo(mid);
        return;
      }
      if (act === 'reply' && mid) {
        ev.preventDefault();
        setReply(getCached(mid));
        closeMsgMenus();
        return;
      }
      if (act === 'forward' && mid) {
        ev.preventDefault();
        showForwardPicker(mid);
        closeMsgMenus();
        return;
      }
      if (act === 'forward-to') {
        ev.preventDefault();
        doForward(actEl.getAttribute('data-hub-room') || '');
        return;
      }
      if (act === 'copy' && mid) {
        ev.preventDefault();
        copyMsg(mid);
        closeMsgMenus();
        return;
      }
      if (act === 'edit' && mid) {
        ev.preventDefault();
        startEdit(mid);
        closeMsgMenus();
        return;
      }
      if (act === 'delete' && mid) {
        ev.preventDefault();
        doDelete(mid);
        closeMsgMenus();
        return;
      }
      if (act === 'timeout') {
        ev.preventDefault();
        doTimeout(actEl.getAttribute('data-hub-uid') || '', mid);
        closeMsgMenus();
        return;
      }
    });

    const file = document.getElementById('hubImageInput');
    if (file && !file.__utkBound) {
      file.__utkBound = true;
      file.addEventListener('change', function () {
        const f = file.files && file.files[0];
        file.value = '';
        if (f) onPickImage(f);
      });
    }

    const msgs = document.getElementById('hubMessages');
    if (msgs && !msgs.__utkUnreadScroll) {
      msgs.__utkUnreadScroll = true;
      msgs.addEventListener('scroll', function () {
        const near = (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight) < 80;
        if (near) resetUnread();
      }, { passive: true });
    }

    const hubInput = document.getElementById('hubInput');
    if (hubInput && !hubInput.__utkPasteImg) {
      hubInput.__utkPasteImg = true;
      hubInput.addEventListener('paste', function (ev) {
        try {
          const items = ev.clipboardData && ev.clipboardData.items;
          if (!items) return;
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it && it.type && it.type.indexOf('image/') === 0) {
              const blob = it.getAsFile();
              if (blob) {
                ev.preventDefault();
                onPickImage(blob);
              }
              break;
            }
          }
        } catch (e) {}
      });
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        closeLightbox();
        hideForward();
        hideDeleteModal();
      }
    });
  }

  function init() {
    bind();
    try {
      const section = document.getElementById('section-hub');
      const h = hub();
      if (section && section.classList.contains('active') && h && typeof h.start === 'function') {
        // Hub may have painted bubbles before this module loaded — rebuild.
        h.start();
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__utkHubMsgUi = {
    buildNode: buildNode,
    applyMutations: applyMutations,
    remember: remember,
    beforeAppend: beforeAppend,
    formatStamp: formatStamp,
    getReplyTo: getReplyTo,
    getPendingImage: getPendingImage,
    clearPendingImage: clearPendingImage,
    setPendingImage: setPendingImage,
    clearComposeExtras: clearComposeExtras,
    getEditId: getEditId,
    clearEdit: clearEdit,
    patchNode: patchNode,
    setReply: setReply,
    noteUnread: noteUnread,
    resetUnread: resetUnread,
    jumpLatest: jumpLatest,
    scrollToBottom: scrollToBottom,
    resetDayTrack: resetDayTrack
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {};
}
