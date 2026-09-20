/**

 * community-hub-avatars.js — Profile photos for hub chat / People panel.

 * Load BEFORE community-hub.js.

 */

(function () {

  'use strict';



  const CACHE_KEY = 'utkHubAvatarCache:v1';

  const MAX_AVATAR_CHARS = 160000;

  const cache = Object.create(null);



  function loadDisk() {

    try {

      const raw = window.localStorage.getItem(CACHE_KEY);

      if (!raw) return;

      const obj = JSON.parse(raw);

      if (!obj || typeof obj !== 'object') return;

      Object.keys(obj).forEach(function (uid) {

        if (typeof obj[uid] === 'string' && obj[uid]) cache[uid] = obj[uid];

      });

    } catch (e) {}

  }



  function saveDisk() {

    try {

      const keys = Object.keys(cache);

      if (keys.length > 80) {

        keys.slice(0, keys.length - 60).forEach(function (k) { delete cache[k]; });

      }

      window.localStorage.setItem(CACHE_KEY, JSON.stringify(cache));

    } catch (e) {}

  }



  function isSafeAvatar(url) {

    if (!url || typeof url !== 'string') return false;

    if (url.length > MAX_AVATAR_CHARS) return false;

    return (

      url.indexOf('data:image/') === 0 ||

      url.indexOf('https://') === 0 ||

      url.indexOf('http://') === 0

    );

  }



  function remember(uid, url) {

    if (!uid || !isSafeAvatar(url)) return;

    if (cache[uid] === url) return;

    cache[uid] = url;

    saveDisk();

  }



  function get(uid) {

    if (!uid) return '';

    return cache[uid] || '';

  }



  function readDomAvatarUrl() {

    const nodes = [

      document.getElementById('sidebarAvatar'),

      document.getElementById('profileAvatar')

    ];

    for (let i = 0; i < nodes.length; i++) {

      const el = nodes[i];

      if (!el) continue;

      const bg = (el.style && el.style.backgroundImage) || '';

      const m = bg.match(/url\(['"]?(.*?)['"]?\)/i);

      if (m && m[1] && isSafeAvatar(m[1])) return m[1];

      if (el.classList && el.classList.contains('has-image')) {

        const cs = window.getComputedStyle(el);

        const cbg = cs && cs.backgroundImage;

        const m2 = cbg && cbg.match(/url\(['"]?(.*?)['"]?\)/i);

        if (m2 && m2[1] && isSafeAvatar(m2[1])) return m2[1];

      }

    }

    return '';

  }



  function getOwnAvatar() {

    const url = readDomAvatarUrl();

    return isSafeAvatar(url) ? url : '';

  }



  function initialOf(name) {

    return String(name || 'T').trim().charAt(0).toUpperCase() || 'T';

  }



  function paint(el, opts) {

    if (!el) return;

    opts = opts || {};

    const name = opts.name || 'Trader';

    const uid = opts.uid || '';

    const online = !!opts.online;

    const url = isSafeAvatar(opts.avatar) ? opts.avatar : (uid ? get(uid) : '');

    const initial = initialOf(name);



    el.classList.add('hub-avatar');

    el.classList.toggle('is-online', online);

    el.classList.toggle('is-offline', !online);

    el.classList.toggle('has-photo', !!url);



    if (url) {

      el.innerHTML = '';

      el.style.backgroundImage = 'url("' + url.replace(/"/g, '') + '")';

      el.setAttribute('aria-label', name);

      if (uid) remember(uid, url);

    } else {

      el.style.backgroundImage = '';

      el.textContent = initial;

      el.setAttribute('aria-label', name);

    }

  }



  function avatarHtml(opts) {

    opts = opts || {};

    const name = opts.name || 'Trader';

    const uid = opts.uid || '';

    const online = !!opts.online;
    const url = isSafeAvatar(opts.avatar) ? opts.avatar : (uid ? get(uid) : '');
    const paid = !!opts.paid || !!opts.subscribed || !!opts.member || !!opts.owner;
    const owner = !!opts.owner;
    const cls = 'hub-avatar' +
      (online ? ' is-online' : ' is-offline') +
      (url ? ' has-photo' : '') +
      (owner ? ' is-owner' : (paid ? ' is-member' : ' is-wanderer'));
    if (url) {
      if (uid) remember(uid, url);
      return (
        '<span class="' + cls + '" style="background-image:url(\'' +
        String(url).replace(/'/g, '%27') +
        '\')" aria-label="' + String(name).replace(/"/g, '') + '"></span>'
      );
    }
    return (
      '<span class="' + cls + '" aria-label="' + String(name).replace(/"/g, '') + '">' +
        initialOf(name) +
      '</span>'
    );
  }



  function ingestList(rows) {

    (rows || []).forEach(function (r) {

      if (!r || !r.uid) return;

      if (r.avatar) remember(r.uid, r.avatar);

    });

  }



  loadDisk();



  window.__utkHubAvatars = {

    get: get,

    remember: remember,

    getOwn: getOwnAvatar,

    paint: paint,

    html: avatarHtml,

    ingest: ingestList,

    isSafe: isSafeAvatar,

    MAX: MAX_AVATAR_CHARS

  };

})();


