/**
 * kingdom-marks.js — Citizen Marks (Firebase per-user + real redeem).
 */
(function () {
  'use strict';

  if (window.__utkKingdomMarks) return;
  window.__utkKingdomMarks = true;

  const WIN_MARKS = 3;
  const STREAK5_BONUS = 2;
  const DAILY_CAP = 100;
  const CAP_HIT_BONUS = 15;
  const WIPE_MARKS = 8;
  const SEEN_CAP = 40;
  const LEGACY_KEY = 'utk-kingdom-marks-v1';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const DEPOSIT_DELTA = 25;

  /** Secret achievements, hidden until unlocked. */
  const SECRETS = {
    'first-blood': {
      name: 'First Blood',
      blurb: 'Bank your first Auto Trade win.',
      icon: '⚔',
      bonus: 5
    },
    'night-owl': {
      name: 'Night Owl',
      blurb: 'Pick up Marks after midnight, before 5am.',
      icon: '🦉',
      bonus: 8
    },
    'real-linked': {
      name: 'Real Wire',
      blurb: 'Hook up a live Pocket Option account.',
      icon: '🔗',
      bonus: 20
    },
    'bankroll-100': {
      name: 'Triple Digits',
      blurb: 'Your real balance hits $100.',
      icon: '💵',
      bonus: 10
    },
    'bankroll-500': {
      name: 'High Roller',
      blurb: 'Your real balance hits $500.',
      icon: '💎',
      bonus: 25
    },
    'bankroll-1k': {
      name: 'Four Figures',
      blurb: 'Your real balance hits $1000.',
      icon: '👑',
      bonus: 40
    },
    'deposit-boost': {
      name: 'Topped Up',
      blurb: 'We spotted a real deposit bump.',
      icon: '⬆',
      bonus: 15
    },
    'cap-crusher': {
      name: 'Cap Crusher',
      blurb: 'Fill today’s Marks goal.',
      icon: '🔥',
      bonus: 0
    },
    'wipe-survivor': {
      name: 'Wipe Survivor',
      blurb: 'Ride out a full five loss chain and keep going.',
      icon: '🛡',
      bonus: 0
    }
  };

  const SECRET_TOTAL = Object.keys(SECRETS).length;

  const CATALOG = [
    {
      id: 'crest-badge',
      name: 'Crest badge',
      blurb: 'A little crest on your profile that says you earned here.',
      cost: 40
    },
    {
      id: 'signal-chime',
      name: 'Signal chime',
      blurb: 'A softer chime when a new signal lands.',
      cost: 80
    },
    {
      id: 'desk-skin',
      name: 'Desk skin',
      blurb: 'Warm glow on the bot desk. Looks only.',
      cost: 100
    },
    {
      id: 'hub-title',
      name: 'Hub title color',
      blurb: 'Your name pops with color in Chat.',
      cost: 120
    },
    {
      id: 'citizen-week',
      name: 'Citizen week',
      blurb: 'Trade 500 Marks for seven days of Citizen access.',
      cost: 500,
      week: true
    }
  ];

  let paintedBalance = null;
  let balanceAnim = null;

  let auth = null;
  let db = null;
  let docFn = null;
  let getDocFn = null;
  let setDocFn = null;
  let runTransactionFn = null;
  let ipcRenderer = null;
  let memory = defaultState();
  let activeUid = null;
  let hydrating = false;
  let saveTimer = null;
  let redeemBusy = false;

  try {
    const av = require('./auth-verification');
    auth = av && av.auth;
    db = av && av.db;
  } catch (_) {}

  try {
    const fs = require('firebase/firestore');
    docFn = fs.doc;
    getDocFn = fs.getDoc;
    setDocFn = fs.setDoc;
    runTransactionFn = fs.runTransaction;
  } catch (_) {}

  try {
    ipcRenderer = require('electron').ipcRenderer;
  } catch (_) {
    ipcRenderer = null;
  }

  function defaultState() {
    return {
      balance: 0,
      earnedToday: 0,
      earnDay: '',
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
        updatedAt: null
      },
      updatedAt: null
    };
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

  function uid() {
    try {
      if (auth && auth.currentUser && auth.currentUser.uid) return String(auth.currentUser.uid);
    } catch (_) {}
    try {
      if (window.auth && window.auth.currentUser && window.auth.currentUser.uid) {
        return String(window.auth.currentUser.uid);
      }
    } catch (_) {}
    return null;
  }

  function cacheKey(id) {
    return 'utk-marks-' + id;
  }

  function normalize(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object') return base;
    const poIn = raw.po && typeof raw.po === 'object' ? raw.po : {};
    return {
      balance: Math.max(0, Math.floor(Number(raw.balance) || 0)),
      earnedToday: Math.max(0, Math.floor(Number(raw.earnedToday) || 0)),
      earnDay: String(raw.earnDay || ''),
      owned: Array.isArray(raw.owned) ? raw.owned.map(String).filter(Boolean) : [],
      winStreak: Math.max(0, Math.floor(Number(raw.winStreak) || 0)),
      seenWinKeys: Array.isArray(raw.seenWinKeys) ? raw.seenWinKeys.map(String).slice(-SEEN_CAP) : [],
      capHitDay: String(raw.capHitDay || ''),
      wipeCount: Math.max(0, Math.floor(Number(raw.wipeCount) || 0)),
      citizenWeekRedeems: Math.max(0, Math.floor(Number(raw.citizenWeekRedeems) || 0)),
      lastCitizenWeekAt: raw.lastCitizenWeekAt ? String(raw.lastCitizenWeekAt) : null,
      po: {
        realLinked: !!poIn.realLinked,
        realBalance: poIn.realBalance != null && Number.isFinite(Number(poIn.realBalance))
          ? Number(poIn.realBalance)
          : null,
        realPeak: Math.max(0, Number(poIn.realPeak) || 0),
        demoBalance: poIn.demoBalance != null && Number.isFinite(Number(poIn.demoBalance))
          ? Number(poIn.demoBalance)
          : null,
        lastDepositAt: poIn.lastDepositAt ? String(poIn.lastDepositAt) : null,
        updatedAt: poIn.updatedAt ? String(poIn.updatedAt) : null
      },
      updatedAt: raw.updatedAt ? String(raw.updatedAt) : null
    };
  }

  function fxCelebrate(opts) {
    try {
      if (window.utkMarksFx && typeof window.utkMarksFx.celebrate === 'function') {
        window.utkMarksFx.celebrate(opts);
      }
    } catch (_) {}
  }

  function fxPulse() {
    try {
      if (window.utkMarksFx && typeof window.utkMarksFx.pulseBalance === 'function') {
        window.utkMarksFx.pulseBalance();
      }
    } catch (_) {}
  }

  /**
   * Unlock a secret (or public) achievement once. Bonus Marks do not count toward daily goal.
   */
  function unlockSecret(state, id, extraSub) {
    const def = SECRETS[id];
    if (!def) return false;
    if (state.owned.indexOf(id) !== -1) return false;
    // Owned + bonus Marks are applied server-side only.
    return false;
  }

  function rollDay(state) {
    const day = todayKey();
    if (state.earnDay !== day) {
      state.earnDay = day;
      state.earnedToday = 0;
    }
    return state;
  }

  function readLocal(id) {
    if (!id) return null;
    try {
      const raw = localStorage.getItem(cacheKey(id));
      if (!raw) return null;
      return normalize(JSON.parse(raw));
    } catch (_) {
      return null;
    }
  }

  function writeLocal(id, state) {
    if (!id) return;
    try {
      localStorage.setItem(cacheKey(id), JSON.stringify(state));
    } catch (_) {}
  }

  function readLegacy() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      return normalize(JSON.parse(raw));
    } catch (_) {
      return null;
    }
  }

  function clearLegacy() {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch (_) {}
  }

  let lastPoStatus = null;
  let poTouchTimer = null;
  const HOUSE_BOTS = { bot1: true, bot2: true, bot3: true };

  function isHouseBot(botId) {
    return !!HOUSE_BOTS[String(botId || '')];
  }

  function isRealLive() {
    const st = lastPoStatus || {};
    const account = String(st.activeAccount || '').toLowerCase();
    const online = !!(st.activeOnline && st.hasSsid);
    return account === 'real' && online;
  }

  function marksCloud() {
    return window.utkMarksCloud || null;
  }

  function applyServerMarks(marks, opts) {
    if (!marks) return;
    memory = rollDay(normalize(marks));
    if (activeUid) writeLocal(activeUid, memory);
    paint();
    if (opts && opts.pulse) fxPulse();
  }

  async function verifyDealWithMain(payload) {
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') return { ok: false };
    try {
      return await ipcRenderer.invoke('marks-verify-deal', payload || {});
    } catch (_) {
      return { ok: false };
    }
  }

  function toast(text, kind) {
    const el = document.getElementById('marksToast');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-ok', 'is-err');
    if (kind) el.classList.add(kind);
  }

  function setShopEnabled(on) {
    const shop = document.getElementById('marksShop');
    const note = document.getElementById('marksLoggedOutNote');
    if (shop) shop.classList.toggle('is-disabled', !on);
    if (note) {
      if (on) note.setAttribute('hidden', '');
      else note.removeAttribute('hidden');
    }
  }

  function hasOwned(id) {
    return memory.owned.indexOf(id) !== -1;
  }

  function ensureOwned(state, id) {
    if (state.owned.indexOf(id) === -1) state.owned.push(id);
  }

  function applyOwnedEffects() {
    const crest = document.getElementById('marksCrestPill');
    if (crest) crest.hidden = !hasOwned('crest-badge');

    const capPill = document.getElementById('marksCapPill');
    if (capPill) capPill.hidden = !hasOwned('cap-crusher');

    const wipePill = document.getElementById('marksWipePill');
    if (wipePill) wipePill.hidden = !hasOwned('wipe-survivor');

    const realPill = document.getElementById('marksRealPill');
    if (realPill) realPill.hidden = !hasOwned('real-linked');

    try {
      window.__utkMarksSound = hasOwned('signal-chime') ? 'chime' : '';
    } catch (_) {}

    try {
      if (hasOwned('desk-skin')) {
        document.documentElement.setAttribute('data-marks-desk', 'ember');
      } else {
        document.documentElement.removeAttribute('data-marks-desk');
      }
    } catch (_) {}

    try {
      document.body.classList.toggle('marks-hub-title', hasOwned('hub-title'));
    } catch (_) {}

    try {
      document.dispatchEvent(new CustomEvent('utk-marks-fx', { detail: { owned: memory.owned.slice() } }));
    } catch (_) {}
  }

  function secretUnlockCount() {
    let n = 0;
    Object.keys(SECRETS).forEach((id) => {
      if (hasOwned(id)) n += 1;
    });
    return n;
  }

  function paintSecrets() {
    const host = document.getElementById('marksSecrets');
    const countEl = document.getElementById('marksSecretsCount');
    const unlocked = secretUnlockCount();
    if (countEl) countEl.textContent = unlocked + ' of ' + SECRET_TOTAL;
    if (!host) return;
    host.innerHTML = '';
    Object.keys(SECRETS).forEach((id) => {
      const def = SECRETS[id];
      const owned = hasOwned(id);
      const row = document.createElement('div');
      row.className = 'marks-secret' + (owned ? ' is-unlocked' : ' is-locked');
      if (owned) {
        row.innerHTML =
          '<span class="marks-secret-icon"></span>' +
          '<div class="marks-secret-copy"><strong></strong><p></p></div>';
        row.querySelector('.marks-secret-icon').textContent = def.icon || '★';
        row.querySelector('strong').textContent = def.name;
        row.querySelector('p').textContent = def.blurb;
      } else {
        row.innerHTML =
          '<span class="marks-secret-icon">?</span>' +
          '<div class="marks-secret-copy"><strong>Still locked</strong><p>Keep winning. It will turn up.</p></div>';
      }
      host.appendChild(row);
    });
  }

  function paintPoSnapshot() {
    const el = document.getElementById('marksPoSnap');
    if (!el) return;
    const po = memory.po || {};
    if (!po.realLinked && po.realBalance == null && po.demoBalance == null) {
      el.textContent = 'Connect Pocket Option to unlock account secrets.';
      return;
    }
    const bits = [];
    if (po.realLinked || po.realBalance != null) {
      bits.push(
        'Real ' +
          (po.realBalance != null ? '$' + Number(po.realBalance).toFixed(2) : 'linked') +
          (po.realPeak ? ', peak $' + Number(po.realPeak).toFixed(0) : '')
      );
    }
    if (po.demoBalance != null) {
      bits.push('Demo $' + Number(po.demoBalance).toFixed(2));
    }
    el.textContent = bits.length ? bits.join('  ·  ') : 'Account connected.';
  }

  function paintProgress() {
    const fill = document.getElementById('marksDailyFill');
    const label = document.getElementById('marksDailyLabel');
    const earned = Math.min(DAILY_CAP, memory.earnedToday || 0);
    const pct = Math.round((earned / DAILY_CAP) * 100);
    if (fill) fill.style.width = pct + '%';
    if (label) {
      if (earned >= DAILY_CAP) {
        label.textContent = 'Daily goal done. Bonus +' + CAP_HIT_BONUS + ' locked in today.';
      } else {
        label.textContent = 'Today ' + earned + ' of ' + DAILY_CAP;
      }
    }
  }

  function animateBalance(target) {
    const balEls = document.querySelectorAll('[data-marks-balance]');
    if (!balEls.length) return;
    const end = Math.max(0, Math.floor(Number(target) || 0));
    const start = paintedBalance == null ? end : paintedBalance;
    paintedBalance = end;
    if (balanceAnim) {
      try {
        cancelAnimationFrame(balanceAnim);
      } catch (_) {}
      balanceAnim = null;
    }
    if (start === end) {
      balEls.forEach((el) => {
        el.textContent = String(end);
      });
      return;
    }
    const from = start;
    const delta = end - from;
    const dur = 420;
    const t0 = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = Math.round(from + delta * eased);
      balEls.forEach((el) => {
        el.textContent = String(val);
      });
      if (t < 1) balanceAnim = requestAnimationFrame(frame);
      else balanceAnim = null;
    }
    balanceAnim = requestAnimationFrame(frame);
  }

  function paint() {
    const loggedIn = !!uid();
    setShopEnabled(loggedIn);

    animateBalance(memory.balance);

    paintProgress();
    paintSecrets();
    paintPoSnapshot();

    const shop = document.getElementById('marksShop');
    if (!shop) {
      applyOwnedEffects();
      return;
    }

    shop.innerHTML = '';
    CATALOG.forEach((item) => {
      const owned = hasOwned(item.id);
      const row = document.createElement('div');
      row.className = 'marks-item' + (owned && !item.week ? ' is-owned' : '');
      row.innerHTML =
        '<div class="marks-item-copy"><h4></h4><p></p></div>' +
        '<div class="marks-item-meta"><span class="marks-item-cost"></span><button type="button"></button></div>';
      row.querySelector('h4').textContent = item.name;
      row.querySelector('p').textContent = item.blurb;
      const costEl = row.querySelector('.marks-item-cost');
      costEl.textContent = owned && !item.week ? 'Yours' : item.cost + ' Marks';
      const btn = row.querySelector('button');
      if (!loggedIn) {
        btn.textContent = 'Sign in';
        btn.disabled = true;
      } else if (owned && !item.week) {
        btn.textContent = 'Yours';
        btn.disabled = true;
      } else {
        btn.textContent = item.week ? 'Get week' : 'Unlock';
        btn.disabled = redeemBusy || memory.balance < item.cost;
        btn.addEventListener('click', () => {
          redeem(item.id).catch(() => {});
        });
      }
      shop.appendChild(row);
    });

    applyOwnedEffects();
  }

  function scheduleCloudSave() {
    // Marks are written only by Cloud Functions.
  }

  async function pushCloud() {
    // Disabled. Client cannot raise Marks on Firestore.
  }

  async function pullCloud(id) {
    if (!id || !db || !docFn || !getDocFn) return null;
    const snap = await getDocFn(docFn(db, 'users', id));
    if (!snap || !snap.exists()) return null;
    const data = snap.data() || {};
    if (!data.marks) return null;
    return normalize(data.marks);
  }

  async function hydrateForUser(id) {
    if (!id) {
      activeUid = null;
      memory = defaultState();
      paint();
      return;
    }
    hydrating = true;
    activeUid = id;
    const local = readLocal(id);
    const legacy = readLegacy();
    memory = rollDay(local || legacy || defaultState());
    paint();

    try {
      const cloud = await pullCloud(id);
      memory = rollDay(cloud || local || legacy || defaultState());
      writeLocal(id, memory);
      if (legacy) clearLegacy();
    } catch (e) {
      toast('Marks are offline. Showing your last synced balance.', 'err');
    }

    hydrating = false;
    paint();
  }

  function commitMirror(state) {
    memory = rollDay(normalize(state));
    if (activeUid) writeLocal(activeUid, memory);
    paint();
  }

  function commitLocal(state) {
    commitMirror(state);
  }

  function autotradeOn(botId) {
    const toggle = document.getElementById('autoTradeToggle-' + botId);
    return !!(toggle && toggle.checked);
  }

  function award() {
    return false;
  }

  async function redeemCosmetic(item) {
    const cloud = marksCloud();
    if (!uid() || !cloud || typeof cloud.redeem !== 'function') {
      toast('Marks need a live Kingdom connection to unlock perks.', 'err');
      return;
    }
    redeemBusy = true;
    paint();
    try {
      const res = await cloud.redeem({ itemId: item.id });
      applyServerMarks(res.marks);
      toast('Nice. ' + item.name + ' is yours.', 'ok');
      fxCelebrate({
        kind: 'big',
        icon: '★',
        kicker: 'Unlocked',
        title: item.name,
        sub: item.blurb,
        amount: 0
      });
      try {
        document.dispatchEvent(new CustomEvent('utk-marks-redeemed', { detail: { id: item.id } }));
      } catch (_) {}
    } catch (e) {
      const msg = (e && (e.message || (e.details && e.details.message))) || 'Could not unlock that perk.';
      toast(String(msg), 'err');
    } finally {
      redeemBusy = false;
      paint();
    }
  }

  async function redeemCitizenWeek() {
    const cloud = marksCloud();
    if (!uid() || !cloud || typeof cloud.citizenWeek !== 'function') {
      toast('Sign in with a live connection to grab a Citizen week.', 'err');
      return;
    }
    redeemBusy = true;
    paint();
    try {
      const res = await cloud.citizenWeek({});
      applyServerMarks(res.marks);
      toast('Citizen week unlocked. Enjoy seven days.', 'ok');
      fxCelebrate({
        kind: 'secret',
        icon: '👑',
        kicker: 'Citizen week',
        title: '+7 days access',
        sub: '500 Marks exchanged',
        amount: -500
      });
      try {
        document.dispatchEvent(new CustomEvent('utk-marks-redeemed', { detail: { id: 'citizen-week' } }));
      } catch (_) {}
    } catch (e) {
      const msg = (e && (e.message || (e.details && e.details.message))) || 'Exchange failed.';
      toast(String(msg), 'err');
    } finally {
      redeemBusy = false;
      paint();
    }
  }

  async function redeem(itemId) {
    if (!uid()) {
      toast('Sign in so Marks can follow you.', 'err');
      return;
    }
    const item = CATALOG.find((c) => c.id === itemId);
    if (!item) return;
    if (item.week) {
      await redeemCitizenWeek();
      return;
    }
    await redeemCosmetic(item);
  }

  function isFiveLossWipe(data) {
    if (!data) return false;
    const outcome = String(data.outcome || '').toLowerCase();
    if (outcome !== 'loss' && outcome !== 'lose' && outcome !== 'lost' && outcome !== 'wipe') {
      return false;
    }
    if (data.wipe === true || String(data.source || '').toLowerCase().indexOf('wipe') !== -1) {
      return true;
    }
    const attempt = Number(data.attempt) || 0;
    return attempt >= 5;
  }

  function applyCapHitReward(state) {
    const day = todayKey();
    if (state.earnedToday < DAILY_CAP) return '';
    if (state.capHitDay === day) return '';
    state.capHitDay = day;
    state.balance += CAP_HIT_BONUS;
    const first = state.owned.indexOf('cap-crusher') === -1;
    if (first) state.owned.push('cap-crusher');
    fxCelebrate({
      kind: first ? 'secret' : 'big',
      icon: '🔥',
      kicker: first ? 'Secret unlocked' : 'Daily goal',
      title: first ? 'Cap Crusher' : 'Cap crushed',
      sub: 'Daily goal done. Bonus Marks added.',
      amount: CAP_HIT_BONUS
    });
    return 'Daily goal done! +' + CAP_HIT_BONUS + ' bonus Marks';
  }

  function maybeNightOwl(state) {
    const h = new Date().getHours();
    if (h >= 0 && h < 5) unlockSecret(state, 'night-owl');
  }

  function onPoStatus(status) {
    if (!status || !uid() || hydrating) return;
    if (!activeUid) return;
    lastPoStatus = status;

    const account = String(status.activeAccount || '').toLowerCase();
    const online = !!(status.activeOnline && status.hasSsid);
    const bal = Number(status.balance);
    const hasReal = !!(status.hasReal || account === 'real');
    const po = {
      realLinked: !!(hasReal || account === 'real' || (memory.po && memory.po.realLinked)),
      realBalance: null,
      demoBalance: null
    };
    if (account === 'real' && Number.isFinite(bal)) po.realBalance = bal;
    if (account === 'demo' && Number.isFinite(bal)) po.demoBalance = bal;
    const realBal = Number(status.realBalance != null ? status.realBalance : status.real && status.real.balance);
    if (Number.isFinite(realBal) && realBal >= 0) {
      po.realLinked = true;
      po.realBalance = realBal;
    }
    if (!po.realLinked && !online && po.realBalance == null && po.demoBalance == null) return;

    if (poTouchTimer) clearTimeout(poTouchTimer);
    poTouchTimer = setTimeout(() => {
      poTouchTimer = null;
      const cloud = marksCloud();
      if (!cloud || typeof cloud.touchPo !== 'function') return;
      cloud
        .touchPo({ po })
        .then((res) => {
          if (res && res.marks) applyServerMarks(res.marks);
        })
        .catch(() => {});
    }, 600);
  }

  function onDealResult(data) {
    if (!data || !data.botId) return;
    if (!uid() || hydrating) return;
    if (!isHouseBot(data.botId)) return;
    if (!autotradeOn(data.botId)) return;
    if (!isRealLive()) return;

    const outcome = String(data.outcome || '').toLowerCase();
    const cloud = marksCloud();
    if (!cloud || typeof cloud.grant !== 'function') {
      toast('Marks need a live Kingdom connection.', 'err');
      return;
    }

    const runGrant = async (kind, dedupeKey) => {
      const verified = await verifyDealWithMain({
        botId: data.botId,
        dealId: data.dealId || data.openId || null,
        attempt: data.attempt || null,
        outcome: data.outcome || null,
        dedupeKey
      });
      if (!verified || !verified.ok) return;

      try {
        const res = await cloud.grant({
          kind,
          dedupeKey,
          botId: data.botId,
          account: 'real',
          autotrade: true
        });
        if (res && res.marks) applyServerMarks(res.marks, { pulse: true });
        if (res && res.duplicate) return;
        if (res && res.message) {
          toast(res.message, res.grant > 0 ? 'ok' : 'err');
        }
        if (res && res.grant > 0) {
          fxCelebrate({
            kind: kind === 'wipe' ? 'marks' : res.grant >= 5 ? 'big' : 'marks',
            icon: kind === 'wipe' ? '🛡' : '+',
            kicker: kind === 'wipe' ? 'Wipe consolation' : 'Marks earned',
            title: kind === 'wipe' ? 'Still in the fight' : 'Kingdom Marks',
            sub: 'Real Auto Trade on a house bot',
            amount: res.grant
          });
        }
        try {
          document.dispatchEvent(
            new CustomEvent('utk-marks-changed', {
              detail: { balance: memory.balance, grant: res && res.grant, wipe: kind === 'wipe' }
            })
          );
        } catch (_) {}
      } catch (e) {
        const msg = (e && e.message) || 'Could not sync Marks.';
        toast(String(msg), 'err');
      }
    };

    if (isFiveLossWipe(data)) {
      const key =
        'wipe|' +
        String(data.botId) +
        '|' +
        String(data.dealId || data.openId || data.settleAt || '') +
        '|a' +
        String(data.attempt || 5);
      runGrant('wipe', key);
      return;
    }

    if (outcome === 'win') {
      const key =
        String(data.botId) +
        '|' +
        String(data.dealId || data.openId || data.settleAt || '') +
        '|' +
        String(data.attempt || 1);
      runGrant('win', key);
      return;
    }

    if (outcome === 'loss' || outcome === 'lose' || outcome === 'lost') {
      const key =
        'loss|' +
        String(data.botId) +
        '|' +
        String(data.dealId || data.openId || data.settleAt || '') +
        '|' +
        String(data.attempt || 1);
      runGrant('loss', key);
    }
  }

  function bindIpc() {
    if (!ipcRenderer) return;
    try {
      ipcRenderer.on('po-deal-result', (_event, data) => onDealResult(data));
    } catch (_) {}
    try {
      ipcRenderer.on('ssid-status-update', (_event, payload) => {
        if (payload && payload.status) onPoStatus(payload.status);
      });
    } catch (_) {}
  }

  function bindAuth() {
    if (!auth || typeof auth.onAuthStateChanged !== 'function') {
      hydrateForUser(uid());
      return;
    }
    auth.onAuthStateChanged((user) => {
      const id = user && user.uid ? String(user.uid) : null;
      hydrateForUser(id);
    });
  }

  function init() {
    paint();
    bindIpc();
    bindAuth();
    document.addEventListener('utk-auth-ready', () => {
      hydrateForUser(uid());
    });
  }

  window.utkMarks = {
    getBalance: function () {
      return memory.balance;
    },
    getOwned: function () {
      return memory.owned.slice();
    },
    has: function (id) {
      return hasOwned(id);
    },
    redeem: redeem,
    catalog: CATALOG.slice(),
    secrets: SECRETS,
    refresh: paint,
    hydrate: function () {
      return hydrateForUser(uid());
    },
    applyFx: applyOwnedEffects,
    onPoStatus: onPoStatus
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
