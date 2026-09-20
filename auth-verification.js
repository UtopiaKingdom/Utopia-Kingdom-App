  // console.log('auth-verification.js loaded');
const { initializeApp, getApps, getApp } = require("firebase/app");
const {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  setPersistence,
  browserSessionPersistence
} = require("firebase/auth");
const { getFirestore, initializeFirestore, persistentLocalCache, persistentSingleTabManager, doc, getDoc, setDoc, updateDoc, collection, addDoc, query, orderBy, limit, onSnapshot } = require("firebase/firestore");
const { getDatabase, ref: dbRef, runTransaction: rtdbRunTransaction, onDisconnect, remove, onValue, set } = require("firebase/database");
const { ipcRenderer } = require('electron');
const {
  isForeignActiveLock,
  isActiveElsewhereError,
  decideLockClaim,
  DEFAULT_STALE_MS
} = require('./session-lock-logic.js');

const firebaseConfig = {
    apiKey: "AIzaSyCQdYOL6Tng3GgpRtFEUE7uy3aypmh7cMU",
    authDomain: "utopiakingdom-c7d19.firebaseapp.com",
    projectId: "utopiakingdom-c7d19",
    storageBucket: "utopiakingdom-c7d19.appspot.com",
    messagingSenderId: "591024383099",
    appId: "1:591024383099:web:11229950759c753c722ede",
    measurementId: "G-KX1S4WPYPF"
};
// Reuse existing initialized app when possible to avoid multiple auth instances
const app = (getApps && getApps().length) ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
function makeDb() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentSingleTabManager()
      })
    });
  } catch (e) {
    return getFirestore(app);
  }
}
const db = makeDb();
// Use RTDB only if databaseURL is provided; otherwise rely on Firestore fallback
const hasRTDB = !!(firebaseConfig && firebaseConfig.databaseURL);
const rtdb = hasRTDB ? getDatabase(app) : null;

// PC "Remember me" only prefills email/password — do NOT stay logged in across restarts.
try {
  setPersistence(auth, browserSessionPersistence).catch(() => {});
} catch (e) {}

// --- Single-Session Enforcement (presence lock) ---
// One active device per account. Logout / app quit clears the lock + signs out.
// If a device dies without logout, lock goes stale after SESSION_STALE_MS
// so the other device (phone/PC) can sign in.
const SESSION_STALE_MS = DEFAULT_STALE_MS; // heartbeat is 30s → ~4 missed ticks
const SESSION_HEARTBEAT_MS = 30 * 1000;

let sessionState = {
  uid: null,
  sessionId: null,
  deviceId: null,
  lockType: null, // 'rtdb' | 'firestore' | 'disabled'
  heartbeatTimer: null,
  unsubscribeWatcher: null
};

function getOrCreateDeviceId(email) {
  const key = `uk_device_id_${email || 'global'}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(key, id);
  }
  return id;
}

function generateSessionId() {
  return Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

function startFirestoreHeartbeat(fsLockRef) {
  if (sessionState.heartbeatTimer) clearInterval(sessionState.heartbeatTimer);
  sessionState.heartbeatTimer = setInterval(async () => {
    try {
      await updateDoc(fsLockRef, { updatedAt: Date.now(), platform: 'desktop' });
    } catch (e) {}
  }, SESSION_HEARTBEAT_MS);
  // Immediate touch so other devices see us as active right away
  try { updateDoc(fsLockRef, { updatedAt: Date.now(), platform: 'desktop' }).catch(() => {}); } catch (e) {}
}

function watchFirestoreLock(fsLockRef) {
  if (sessionState.unsubscribeWatcher) {
    try { sessionState.unsubscribeWatcher(); } catch (e) {}
    sessionState.unsubscribeWatcher = null;
  }
  const unsubscribeFs = onSnapshot(fsLockRef, (snap) => {
    const data = snap.data();
    if (!data) return;
    try {
      if (
        data.sessionId &&
        sessionState.sessionId &&
        data.sessionId !== sessionState.sessionId &&
        data.deviceId &&
        data.deviceId !== sessionState.deviceId
      ) {
        forceLogout('Your account was signed in from another device.');
      }
    } catch (e) {}
  });
  sessionState.unsubscribeWatcher = unsubscribeFs;
}

/**
 * Claim the single-session lock.
 * - Same deviceId may reclaim (restart / crash recovery).
 * - Foreign live lock + !force → active_elsewhere (blocks login).
 * - Never bricks login on transient Firestore errors (fail-open → lockType disabled).
 * - force is reserved for rare admin/recovery; normal login does NOT kick other devices.
 */
async function acquirePresenceLock(uid, email, opts = {}) {
  const force = !!(opts && opts.force);
  const deviceId = getOrCreateDeviceId(email);
  if (!force && sessionState.uid === uid && sessionState.deviceId === deviceId && sessionState.sessionId) {
    return true;
  }

  const sessionId = generateSessionId();
  sessionState.uid = uid;
  sessionState.sessionId = sessionId;
  sessionState.deviceId = deviceId;

  if (rtdb) {
    const lockPath = `userPresence/${uid}`;
    const lockRef = dbRef(rtdb, lockPath);
    try {
      const trxResult = await rtdbRunTransaction(lockRef, (current) => {
        if (!current || !current.sessionId) {
          return {
            sessionId,
            deviceId,
            startedAt: Date.now(),
            lastActive: Date.now()
          };
        }
        if (current.deviceId === deviceId) {
          return {
            sessionId,
            deviceId,
            startedAt: current.startedAt || Date.now(),
            lastActive: Date.now()
          };
        }
        if (!force && isForeignActiveLock(current, deviceId, sessionId)) {
          return; // abort — live session elsewhere
        }
        return {
          sessionId,
          deviceId,
          startedAt: Date.now(),
          lastActive: Date.now()
        };
      }, { applyLocally: false });

      if (!trxResult.committed) {
        throw new Error('active_elsewhere');
      }

      try { onDisconnect(lockRef).remove(); } catch (e) {}

      if (sessionState.unsubscribeWatcher) {
        try { sessionState.unsubscribeWatcher(); } catch (e) {}
        sessionState.unsubscribeWatcher = null;
      }
      const unsubscribe = onValue(lockRef, (snap) => {
        const val = snap.val();
        if (!val) return;
        try {
          if (
            val.sessionId &&
            val.sessionId !== sessionState.sessionId &&
            val.deviceId &&
            val.deviceId !== sessionState.deviceId
          ) {
            forceLogout('Your account was signed in from another device.');
          }
        } catch (e) {}
      });
      sessionState.unsubscribeWatcher = () => unsubscribe();

      sessionState.lockType = 'rtdb';
      return true;
    } catch (err) {
      if (isActiveElsewhereError(err)) throw new Error('active_elsewhere');
    }
  }

  const fsLockRef = doc(db, 'userSessions', uid);
  const now = Date.now();
  try {
    let data = null;
    try {
      const snap = await getDoc(fsLockRef);
      data = snap.exists() ? snap.data() : null;
    } catch (readErr) {
      const msg = (readErr && (readErr.code || readErr.message || '')) + '';
      if (msg.includes('PERMISSION_DENIED') || msg.includes('permission-denied')) {
        sessionState.lockType = 'disabled';
        return true;
      }
      console.warn('[session] lock read failed — allowing login without enforcement', readErr);
      sessionState.lockType = 'disabled';
      return true;
    }

    if (decideLockClaim(data, deviceId, sessionId, { force, staleMs: SESSION_STALE_MS }) === 'active_elsewhere') {
      throw new Error('active_elsewhere');
    }

    const prevCreated = data && data.createdAt ? data.createdAt : now;
    await setDoc(fsLockRef, {
      sessionId,
      deviceId,
      createdAt: prevCreated,
      updatedAt: now,
      platform: 'desktop'
    });

    startFirestoreHeartbeat(fsLockRef);
    watchFirestoreLock(fsLockRef);
    sessionState.lockType = 'firestore';
    return true;
  } catch (err) {
    if (isActiveElsewhereError(err)) throw new Error('active_elsewhere');
    const msg = (err && (err.code || err.message || '')) + '';
    if (msg.includes('PERMISSION_DENIED') || msg.includes('permission-denied')) {
      sessionState.lockType = 'disabled';
      return true;
    }
    // Fail open: never block PC login with "Unable to verify session" for lock I/O glitches
    console.warn('[session] lock claim failed — allowing login without enforcement', err);
    sessionState.lockType = 'disabled';
    return true;
  }
}

async function releasePresenceLock() {
  const uid = sessionState.uid;
  const sessionId = sessionState.sessionId;
  const lockType = sessionState.lockType;
  try {
    if (sessionState.unsubscribeWatcher) {
      try { sessionState.unsubscribeWatcher(); } catch (e) {}
      sessionState.unsubscribeWatcher = null;
    }
    if (sessionState.heartbeatTimer) {
      clearInterval(sessionState.heartbeatTimer);
      sessionState.heartbeatTimer = null;
    }
    if (!uid) return;

    if (lockType === 'rtdb' && rtdb) {
      const lockRef = dbRef(rtdb, `userPresence/${uid}`);
      try { await remove(lockRef); } catch (e) {}
    } else {
      // Always clear Firestore lock when we own it (or when lockType unknown after crash recovery)
      const fsLockRef = doc(db, 'userSessions', uid);
      try {
        const snap = await getDoc(fsLockRef);
        const data = snap.data();
        if (!data || !data.sessionId || !sessionId || data.sessionId === sessionId || data.deviceId === sessionState.deviceId) {
          await setDoc(fsLockRef, {
            sessionId: null,
            deviceId: null,
            updatedAt: Date.now(),
            platform: 'desktop'
          }, { merge: true });
        }
      } catch (e) {}
    }
  } finally {
    sessionState.uid = null;
    sessionState.sessionId = null;
    sessionState.deviceId = null;
    sessionState.lockType = null;
  }
}

async function forceLogout(reason) {
  try { await releasePresenceLock(); } catch {}
  try { await signOut(auth); } catch {}

  // Ensure subscription overlay is not left open on forced sign-out
  try { if (typeof cancelWaitForConfirmation === 'function') cancelWaitForConfirmation(); } catch (e) {}
  try { hideSubscriptionOverlay(); } catch (e) {}

  // Clear any local device bypass (we were forced out)
  try { localStorage.removeItem('maintenanceBypass'); } catch (e) {}

  // Show a styled modal instead of alert
  try {
    const msg = reason || 'You have been signed out.';
    const sessionModal = document.getElementById('session-taken-modal');
    const sessionMsg = document.getElementById('sessionTakenMessage');
    if (sessionMsg) sessionMsg.textContent = msg;
    if (sessionModal) {
      sessionModal.classList.add('active');
      // Handler for close
      const closeBtn = document.getElementById('sessionTakenClose');
      const handleClose = () => {
        sessionModal.classList.add('closing');
        setTimeout(() => {
          sessionModal.classList.remove('active', 'closing');
        }, 220);
        closeBtn.removeEventListener('click', handleClose);
      };
      if (closeBtn) closeBtn.addEventListener('click', handleClose);
    }
  } catch (e) {
    try {
      if (typeof window.showAppToast === 'function') window.showAppToast(reason || 'You have been signed out.', { tone: 'error' });
    } catch {}
  }

  // Show auth screen again
  showAuthScreenAfterSignOut();
}

const MAX_CODE_ATTEMPTS = 3;

// Verification code storage
let verificationCodeData = {
  code: null,
  email: null,
  password: null,
  timestamp: null,
  mode: null, // 'register' or 'login'
  rememberMe: false,
  failedAttempts: 0
};

function resetVerificationCodeData(extra = {}) {
  verificationCodeData = {
    code: null,
    email: null,
    password: null,
    timestamp: null,
    mode: null,
    rememberMe: false,
    failedAttempts: 0,
    ...extra
  };
}

function setVerifyInputsLocked(locked) {
  const inputs = document.querySelectorAll('.code-input');
  inputs.forEach((input) => {
    input.disabled = !!locked;
    input.classList.toggle('is-locked', !!locked);
  });
  const verifyBtn = document.getElementById('verifyCodeBtn');
  if (verifyBtn) verifyBtn.disabled = !!locked;
}

function invalidateVerificationCode() {
  if (!verificationCodeData) return;
  verificationCodeData.code = null;
  verificationCodeData.timestamp = null;
  verificationCodeData.failedAttempts = MAX_CODE_ATTEMPTS;
  setVerifyInputsLocked(true);
}

// Send verification code via IPC to main process
async function sendVerificationCodeEmail(email, code) {
  try {
    const result = await ipcRenderer.invoke('send-verification-code', { email, code });
    if (result.success) {
      // console.log('✅ Verification code sent to:', email);
      return true;
    } else {
      throw new Error(result.error);
    }
  } catch (err) {
    // console.error('❌ Failed to send email:', err);
    throw err;
  }
}

async function showWelcomeBackNotification(_user) {
  // Intentionally quiet: welcome lives on the Home screen, not as a desktop toast.
  return;
}

function setAuthHeader(mode) {
  const titleEl = document.getElementById('auth-title');
  const subtitleEl = document.getElementById('auth-subtitle');
  const map = {
    login: {
      title: 'Welcome back',
      subtitle: 'Sign in to your kingdom'
    },
    register: {
      title: 'Create your account',
      subtitle: 'A few details and you are in'
    },
    verifyLogin: {
      title: 'Almost there',
      subtitle: 'Confirm it is you with the code we sent'
    },
    verifyRegister: {
      title: 'Check your inbox',
      subtitle: 'Enter the code we sent to finish signing up'
    }
  };
  const copy = map[mode] || map.login;
  if (titleEl) titleEl.textContent = copy.title;
  if (subtitleEl) subtitleEl.textContent = copy.subtitle;
}

function setupAuth() {
  const authModal = document.getElementById('auth-modal');
  const mainApp = document.querySelector('.app-container');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const verifyCodeForm = document.getElementById('verifyCodeForm');
  const showRegister = document.getElementById('showRegister');
  const showLogin = document.getElementById('showLogin');
  const loginError = document.getElementById('loginErrorMessage');
  const registerError = document.getElementById('registerErrorMessage');
  const codeErrorMessage = document.getElementById('codeErrorMessage');
  const logoutBtn = document.getElementById('logoutBtn');
  const rememberMeCheckbox = document.getElementById('rememberMe');

  // Load saved credentials if available
  const savedEmail = localStorage.getItem('savedEmail');
  const savedPassword = localStorage.getItem('savedPassword');
  if (savedEmail && savedPassword) {
    document.getElementById('loginEmail').value = savedEmail;
    document.getElementById('loginPassword').value = savedPassword;
    if (rememberMeCheckbox) rememberMeCheckbox.checked = true;
  }

  const showAuthScreen = () => {
    if (registerForm) registerForm.style.display = 'none';
    if (verifyCodeForm) verifyCodeForm.style.display = 'none';
    if (loginForm) loginForm.style.display = 'flex';
    setAuthHeader('login');
    loginError.textContent = '';
    registerError.textContent = '';
    if (authModal) {
      authModal.style.display = 'flex';
      authModal.style.removeProperty('z-index');
      authModal.classList.remove('hidden', 'closing');
    }
    if (mainApp) mainApp.style.display = 'none';
    document.body.classList.add('auth-visible');
    if (window.musicVisualizer && typeof window.musicVisualizer.refresh === 'function') {
      window.musicVisualizer.refresh();
    }
  };

  document.body.classList.add('auth-visible');

  if (showRegister) {
    showRegister.addEventListener('click', (e) => {
      e.preventDefault();
      if (loginForm) loginForm.style.display = 'none';
      if (verifyCodeForm) verifyCodeForm.style.display = 'none';
      if (registerForm) registerForm.style.display = 'flex';
      setAuthHeader('register');
    });
  }
  if (showLogin) {
    showLogin.addEventListener('click', (e) => {
      e.preventDefault();
      if (registerForm) registerForm.style.display = 'none';
      if (verifyCodeForm) verifyCodeForm.style.display = 'none';
      if (loginForm) loginForm.style.display = 'flex';
      setAuthHeader('login');
    });
  }

  // LOGIN FORM (2FA on first device login)
  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const rememberMe = rememberMeCheckbox ? rememberMeCheckbox.checked : false;
    const modalContainer = document.querySelector('.auth-modal-container');
    // console.log('Attempting login with:', email);

    const trustedKey = `trusted_login_${email}`;

    // If this device was trusted before, skip code
    if (localStorage.getItem(trustedKey) === '1') {
      try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        // Enforce single-session lock BEFORE proceeding
        try {
          await acquirePresenceLock(userCredential.user.uid, email);
        } catch (lockErr) {
          await signOut(auth);
          const msg = isActiveElsewhereError(lockErr)
            ? 'This account is already active on another device.'
            : 'Unable to verify session. Please try again later.';
          loginError.textContent = msg;
          return;
        }
        if (rememberMe) {
          localStorage.setItem('savedEmail', email);
          localStorage.setItem('savedPassword', password);
        } else {
          localStorage.removeItem('savedEmail');
          localStorage.removeItem('savedPassword');
        }
        await loadUserProfile(userCredential.user);
        try { showWelcomeBackNotification(userCredential.user); } catch (e) {}
        modalContainer.classList.remove('error-glow');
        modalContainer.classList.add('success');
        authModal.classList.add('closing');
        setTimeout(async () => {
          // Wait for maintenance check before hiding the auth UI to prevent flashes
          let allowed = true;
          try {
            if (typeof window.postLoginMaintenanceCheck === 'function') {
              allowed = await window.postLoginMaintenanceCheck();
            }
          } catch (e) { allowed = true; }

          authModal.style.display = 'none';
          authModal.style.removeProperty('z-index');
          modalContainer.classList.remove('success');
          authModal.classList.remove('closing');

          if (allowed) {
            try { document.body.classList.remove('auth-visible'); } catch (e) {}
            if (mainApp) {
              mainApp.style.display = '';
              mainApp.classList.add('app-fade-in');
              setTimeout(() => mainApp.classList.remove('app-fade-in'), 420);
              // show subscription prompt after app entrance animation
              setTimeout(() => { try { /* free app — no auto paywall */ } catch (e) {} }, 480);
            }
          } else {
            // Maintenance active: ensure overlay is applied before removing auth-visible
            try {
              const overlay = document.getElementById('maintenance-overlay');
              if (overlay && !(overlay.style.display === 'flex' || overlay.style.visibility === 'visible')) {
                setTimeout(() => { try { document.body.classList.remove('auth-visible'); } catch (e) {} }, 60);
              } else {
                try { document.body.classList.remove('auth-visible'); } catch (e) {}
              }
            } catch (e) { try { document.body.classList.remove('auth-visible'); } catch (e) {} }
          }


        }, 320);
        return;
      } catch (err) {
        // console.error('Login error:', err);
        modalContainer.classList.remove('success');
        modalContainer.classList.add('error-glow');
        if (err.code === 'auth/wrong-password') {
          loginError.textContent = 'Wrong password.';
        } else if (err.code === 'auth/user-not-found') {
          loginError.textContent = 'Email not in database.';
        } else if (err.code === 'auth/invalid-email') {
          loginError.textContent = 'Invalid email address.';
        } else if (err.code === 'auth/too-many-requests') {
          loginError.textContent = 'Too many failed attempts. Please try again later.';
        } else if (err.code === 'auth/invalid-credential') {
          loginError.textContent = 'Email or password is incorrect.';
        } else {
          loginError.textContent = 'Login failed: ' + (err.message || 'Unknown error');
        }
        return;
      }
    }

    // Not trusted yet: verify credentials, send code, then require code
    try {
      // Validate credentials first, then sign out to await code verification
      await signInWithEmailAndPassword(auth, email, password);
      await signOut(auth);

      const verificationCode = Math.floor(1000 + Math.random() * 9000).toString();

      verificationCodeData = {
        code: verificationCode,
        email,
        password,
        timestamp: Date.now(),
        mode: 'login',
        rememberMe,
        failedAttempts: 0
      };
      setVerifyInputsLocked(false);

      try {
        await sendVerificationCodeEmail(email, verificationCode);
      } catch (err) {
        const msg = (err && err.message) ? err.message : 'Failed to send verification email.';
        loginError.style.color = '#ff6b6b';
        loginError.textContent = msg;
        codeErrorMessage.style.color = '#ff6b6b';
        codeErrorMessage.textContent = msg;
        console.error('sendVerificationCodeEmail failed:', err);
        return;
      }

      // Show verification form for login
      loginForm.style.display = 'none';
      verifyCodeForm.style.display = 'flex';
      setAuthHeader('verifyLogin');
      codeErrorMessage.textContent = '';
      codeErrorMessage.style.color = '#9aa0a6';
      codeErrorMessage.textContent = '';
      setTimeout(() => {
        codeErrorMessage.textContent = '';
        codeErrorMessage.style.color = '';
      }, 4000);

      // Clear inputs
      document.getElementById('codeInput1').value = '';
      document.getElementById('codeInput2').value = '';
      document.getElementById('codeInput3').value = '';
      document.getElementById('codeInput4').value = '';
      document.getElementById('codeInput1').focus();
    } catch (err) {
      // console.error('Login (with code) error:', err);
      modalContainer.classList.remove('success');
      modalContainer.classList.add('error-glow');
      if (err.code === 'auth/wrong-password') {
        loginError.textContent = 'Wrong password.';
      } else if (err.code === 'auth/user-not-found') {
        loginError.textContent = 'Email not in database.';
      } else if (err.code === 'auth/invalid-email') {
        loginError.textContent = 'Invalid email address.';
      } else if (err.code === 'auth/too-many-requests') {
        loginError.textContent = 'Too many failed attempts. Please try again later.';
      } else if (err.code === 'auth/invalid-credential') {
        loginError.textContent = 'Email or password is incorrect.';
      } else {
        loginError.textContent = err.message || 'Login failed. Try again.';
      }
    }
  };

  // REGISTER FORM - generate code and show verification screen
  if (registerForm) {
    // mark handler attached for quick debugging
    registerForm.dataset.uHandler = 'attached';

    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        registerError.textContent = '';
        const submitBtn = registerForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        const emailEl = document.getElementById('registerEmail');
        const passEl = document.getElementById('registerPassword');
        const pass2El = document.getElementById('registerPassword2');
        const modalContainer = document.querySelector('.auth-modal-container');

        const email = emailEl ? String(emailEl.value || '').trim() : '';
        const password = passEl ? String(passEl.value || '') : '';
        const password2 = pass2El ? String(pass2El.value || '') : '';

        // immediate UI feedback
        registerError.textContent = '';
        codeErrorMessage.textContent = '';

        if (!email) {
          registerError.textContent = 'Please enter an email address.';
          throw new Error('validation');
        }

        if (password !== password2) {
          registerError.textContent = 'Passwords do not match.';
          if (modalContainer) modalContainer.classList.add('error-glow');
          setTimeout(() => { if (modalContainer) modalContainer.classList.remove('error-glow'); }, 400);
          throw new Error('validation');
        }

        if (password.length < 6) {
          registerError.textContent = 'Password must be at least 6 characters.';
          if (modalContainer) modalContainer.classList.add('error-glow');
          setTimeout(() => { if (modalContainer) modalContainer.classList.remove('error-glow'); }, 400);
          throw new Error('validation');
        }

        // Don't display the email/send status to the user
        registerError.style.color = '';
        registerError.textContent = '';

        // Generate 4-digit code and store locally for verification step
        const verificationCode = Math.floor(1000 + Math.random() * 9000).toString();
        verificationCodeData.code = verificationCode;
        verificationCodeData.email = email;
        verificationCodeData.password = password;
        verificationCodeData.timestamp = Date.now();
        verificationCodeData.mode = 'register';
        verificationCodeData.rememberMe = false;
        verificationCodeData.failedAttempts = 0;
        setVerifyInputsLocked(false);

        // attempt to send — surface any error message to the user (with timeout)
        try {
          const sendPromise = sendVerificationCodeEmail(email, verificationCode);
          // fail-fast after 15s if the main process is unresponsive
          await Promise.race([
            sendPromise,
            new Promise((_, rej) => setTimeout(() => rej(new Error('Email send timed out')), 15000))
          ]);
        } catch (err) {
          const msg = (err && err.message) ? err.message : 'Failed to send verification email.';
          codeErrorMessage.style.color = '#ff6b6b';
          codeErrorMessage.textContent = msg;
          // clear the interim register status so UI doesn't remain stuck
          try { registerError.style.color = '#ff4444'; registerError.textContent = msg; } catch (e) {}
          console.error('sendVerificationCodeEmail failed:', err);
          throw err;
        }

        // success → show verify UI
        registerForm.style.display = 'none';
        if (verifyCodeForm) verifyCodeForm.style.display = 'flex';
        setAuthHeader('verifyRegister');
        codeErrorMessage.style.color = '';
        codeErrorMessage.textContent = '';

        // Clear code inputs and focus
        const i1 = document.getElementById('codeInput1');
        if (i1) i1.value = '';
        const i2 = document.getElementById('codeInput2'); if (i2) i2.value = '';
        const i3 = document.getElementById('codeInput3'); if (i3) i3.value = '';
        const i4 = document.getElementById('codeInput4'); if (i4) i4.value = '';
        if (i1) i1.focus();

      } catch (err) {
        // Clear the 'Sending verification code…' placeholder and show a helpful message to the user
        try {
          if (codeErrorMessage && codeErrorMessage.textContent) {
            registerError.style.color = '#ff4444';
            registerError.textContent = codeErrorMessage.textContent;
          } else {
            const userMsg = (err && err.message && err.message !== 'validation') ? err.message : 'Failed to send verification code. Try again.';
            registerError.style.color = '#ff4444';
            registerError.textContent = (userMsg === 'validation') ? (registerError.textContent || 'Invalid input') : userMsg;
          }
        } catch (e) {
          registerError.style.color = '#ff4444';
          registerError.textContent = 'Failed to send verification code. Try again.';
        }

        // Log unexpected errors for diagnostics (keep validation quiet)
        if (err && err.message && err.message !== 'validation') {
          console.error('Register handler error:', err);
        }
      } finally {
        const submitBtn = registerForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // Code input auto-advance
  const codeInputs = document.querySelectorAll('.code-input');
  codeInputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/[^0-9]/g, '');
      if (e.target.value.length === 1 && index < codeInputs.length - 1) {
        codeInputs[index + 1].focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && input.value === '' && index > 0) {
        codeInputs[index - 1].focus();
      }
    });
  });

  // VERIFICATION CODE FORM
  verifyCodeForm.onsubmit = async (e) => {
    e.preventDefault();
    codeErrorMessage.style.color = '';
    codeErrorMessage.textContent = '';

    const attemptsUsed = Number(verificationCodeData.failedAttempts || 0);
    if (!verificationCodeData.code || attemptsUsed >= MAX_CODE_ATTEMPTS) {
      setVerifyInputsLocked(true);
      codeErrorMessage.style.color = '#ff6b6b';
      codeErrorMessage.textContent = 'Code invalid after too many attempts. Resend a new code.';
      return;
    }
    
    const enteredCode = [
      document.getElementById('codeInput1').value,
      document.getElementById('codeInput2').value,
      document.getElementById('codeInput3').value,
      document.getElementById('codeInput4').value
    ].join('');
    
    if (enteredCode.length !== 4) {
      codeErrorMessage.textContent = 'Please enter all 4 digits';
      return;
    }
    
    // Check expiration (10 minutes)
    const codeAge = Date.now() - verificationCodeData.timestamp;
    if (codeAge > 10 * 60 * 1000) {
      invalidateVerificationCode();
      codeErrorMessage.style.color = '#ff6b6b';
      codeErrorMessage.textContent = 'Code expired. Request a new one.';
      return;
    }
    
    // Verify code
    if (enteredCode !== verificationCodeData.code) {
      verificationCodeData.failedAttempts = attemptsUsed + 1;
      const left = Math.max(0, MAX_CODE_ATTEMPTS - verificationCodeData.failedAttempts);
      ['codeInput1', 'codeInput2', 'codeInput3', 'codeInput4'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      document.getElementById('codeInput1')?.focus();
      codeErrorMessage.style.color = '#ff6b6b';
      if (left <= 0) {
        invalidateVerificationCode();
        codeErrorMessage.textContent = 'Too many incorrect attempts. This code is now invalid. Resend a new one.';
      } else {
        codeErrorMessage.textContent = `Invalid code. ${left} attempt${left === 1 ? '' : 's'} left.`;
      }
      return;
    }
    
    try {
      if (verificationCodeData.mode === 'register') {
        // Create account
        const userCredential = await createUserWithEmailAndPassword(
          auth,
          verificationCodeData.email,
          verificationCodeData.password
        );
        try { await acquirePresenceLock(userCredential.user.uid, verificationCodeData.email); } catch (lockErr) {
          await signOut(auth);
          codeErrorMessage.textContent = isActiveElsewhereError(lockErr)
            ? 'This account is already active on another device.'
            : 'Unable to verify session. Please try again later.';
          return;
        }
        // Create user profile
        const userDoc = doc(db, 'users', userCredential.user.uid);
        await setDoc(userDoc, {
          username: verificationCodeData.email.split('@')[0],
          email: verificationCodeData.email,
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
          emailVerified: true
        });
        // Trust this device for this email
        localStorage.setItem(`trusted_login_${verificationCodeData.email}`, '1');
        // Clear data
        resetVerificationCodeData();
        setVerifyInputsLocked(false);
        // Load profile and close modal
        await loadUserProfile(userCredential.user);
        const modalContainer = document.querySelector('.auth-modal-container');
        modalContainer.classList.remove('error-glow');
        modalContainer.classList.add('success');
        authModal.classList.add('closing');
        setTimeout(async () => {
          // Wait for maintenance check to complete before showing app
          let allowed = true;
          try {
            if (typeof window.postLoginMaintenanceCheck === 'function') {
              allowed = await window.postLoginMaintenanceCheck();
            }
          } catch (e) { allowed = true; }

          authModal.style.display = 'none';
          authModal.style.removeProperty('z-index');
          modalContainer.classList.remove('success');
          authModal.classList.remove('closing');

          if (allowed) {
            try { document.body.classList.remove('auth-visible'); } catch (e) {}
            if (mainApp) {
              mainApp.style.display = '';
              mainApp.classList.add('app-fade-in');
              setTimeout(() => mainApp.classList.remove('app-fade-in'), 420);
              // show subscription prompt after app entrance animation
              setTimeout(() => { try { /* free app — no auto paywall */ } catch (e) {} }, 480);
            }
          } else {
            try {
              const overlay = document.getElementById('maintenance-overlay');
              if (overlay && !(overlay.style.display === 'flex' || overlay.style.visibility === 'visible')) {
                setTimeout(() => { try { document.body.classList.remove('auth-visible'); } catch (e) {} }, 60);
              } else {
                try { document.body.classList.remove('auth-visible'); } catch (e) {}
              }
            } catch (e) { try { document.body.classList.remove('auth-visible'); } catch (e) {} }
          }
        }, 320);
      } else if (verificationCodeData.mode === 'login') {
        // Sign in after code approval
        const userCredential = await signInWithEmailAndPassword(
          auth,
          verificationCodeData.email,
          verificationCodeData.password
        );
        try { await acquirePresenceLock(userCredential.user.uid, verificationCodeData.email); } catch (lockErr) {
          await signOut(auth);
          codeErrorMessage.textContent = isActiveElsewhereError(lockErr)
            ? 'This account is already active on another device.'
            : 'Unable to verify session. Please try again later.';
          return;
        }
        // Remember credentials if requested
        if (verificationCodeData.rememberMe) {
          localStorage.setItem('savedEmail', verificationCodeData.email);
          localStorage.setItem('savedPassword', verificationCodeData.password);
        } else {
          localStorage.removeItem('savedEmail');
          localStorage.removeItem('savedPassword');
        }
        // Trust this device for this email
        localStorage.setItem(`trusted_login_${verificationCodeData.email}`, '1');
        // Clear data
        resetVerificationCodeData();
        setVerifyInputsLocked(false);
        // Load profile and close modal
        const modalContainer = document.querySelector('.auth-modal-container');
        await loadUserProfile(userCredential.user);
        modalContainer.classList.remove('error-glow');
        modalContainer.classList.add('success');
        authModal.classList.add('closing');
        setTimeout(async () => {
          // Wait for maintenance check to finish before showing the app
          let allowed = true;
          try {
            if (typeof window.showMaintenanceCheckSpinner === 'function') window.showMaintenanceCheckSpinner();
            if (typeof window.postLoginMaintenanceCheck === 'function') {
              allowed = await window.postLoginMaintenanceCheck();
            }
          } catch (e) { allowed = true; }
          finally { if (typeof window.hideMaintenanceCheckSpinner === 'function') window.hideMaintenanceCheckSpinner(); }

          authModal.style.display = 'none';
          authModal.style.removeProperty('z-index');
          modalContainer.classList.remove('success');
          authModal.classList.remove('closing');

          if (allowed) {
            try { document.body.classList.remove('auth-visible'); } catch (e) {}
            if (mainApp) {
              mainApp.style.display = '';
              mainApp.classList.add('app-fade-in');
              setTimeout(() => mainApp.classList.remove('app-fade-in'), 420);
              // show subscription prompt after app entrance animation
              setTimeout(() => { try { /* free app — no auto paywall */ } catch (e) {} }, 480);
            }
          } else {
            try {
              const overlay = document.getElementById('maintenance-overlay');
              if (overlay && !(overlay.style.display === 'flex' || overlay.style.visibility === 'visible')) {
                setTimeout(() => { try { document.body.classList.remove('auth-visible'); } catch (e) {} }, 60);
              } else {
                try { document.body.classList.remove('auth-visible'); } catch (e) {}
              }
            } catch (e) { try { document.body.classList.remove('auth-visible'); } catch (e) {} }
          }
        }, 320);
      }
    } catch (err) {
      // console.error('Verification flow error:', err);
      if (verificationCodeData.mode === 'register' && err.code === 'auth/email-already-in-use') {
        codeErrorMessage.textContent = 'Email already registered. Sign in instead.';
      } else if (verificationCodeData.mode === 'login' && err.code === 'auth/wrong-password') {
        codeErrorMessage.textContent = 'Password changed. Please log in again.';
      } else {
        codeErrorMessage.textContent = 'Failed to complete verification. Try again.';
      }
    }
  };
  
  // Resend code
  document.getElementById('resendCodeLink').onclick = async (e) => {
    e.preventDefault();
    try {
      const newCode = Math.floor(1000 + Math.random() * 9000).toString();
      verificationCodeData.code = newCode;
      verificationCodeData.timestamp = Date.now();
      verificationCodeData.failedAttempts = 0;
      setVerifyInputsLocked(false);
      ['codeInput1', 'codeInput2', 'codeInput3', 'codeInput4'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      document.getElementById('codeInput1')?.focus();
      try {
        await sendVerificationCodeEmail(verificationCodeData.email, newCode);
        codeErrorMessage.style.color = '#00ff88';
        codeErrorMessage.textContent = 'Verification code resent';
      } catch (err) {
        codeErrorMessage.style.color = '#ff6b6b';
        codeErrorMessage.textContent = 'Could not send the code. Try again in a moment.';
        console.error('sendVerificationCodeEmail failed:', err);
        return;
      }
      setTimeout(() => {
        codeErrorMessage.style.color = '';
        codeErrorMessage.textContent = '';
      }, 3000);
    } catch (err) {
      codeErrorMessage.textContent = 'Failed to resend code';
    }
  };
  
  // Back to register/login depending on intent
  document.getElementById('backToRegisterLink').onclick = (e) => {
    e.preventDefault();
    verifyCodeForm.style.display = 'none';
    if (verificationCodeData.mode === 'login') {
      loginForm.style.display = 'flex';
      setAuthHeader('login');
    } else {
      registerForm.style.display = 'flex';
      setAuthHeader('register');
    }
    resetVerificationCodeData();
    setVerifyInputsLocked(false);
  };

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const logoutModal = document.getElementById('logout-modal');
      const confirmBtn = document.getElementById('confirmLogout');
      const cancelBtn = document.getElementById('cancelLogout');
      
      logoutModal.classList.add('active');
      
      const handleCancel = () => {
        logoutModal.classList.add('closing');
        setTimeout(() => {
          logoutModal.classList.remove('active', 'closing');
        }, 250);
        confirmBtn.removeEventListener('click', handleConfirm);
        cancelBtn.removeEventListener('click', handleCancel);
      };
      
      const handleConfirm = async () => {
        logoutModal.classList.add('closing');
        setTimeout(() => {
          logoutModal.classList.remove('active', 'closing');
        }, 250);
        
        logoutBtn.disabled = true;
        const original = logoutBtn.textContent;
        logoutBtn.textContent = 'Logging out...';
        try {
          try { await releasePresenceLock(); } catch {}
          await signOut(auth);
          showAuthScreen();
        } catch (err) {
          // console.error('Logout failed:', err);
        } finally {
          logoutBtn.disabled = false;
          logoutBtn.textContent = original;
        }
        
        confirmBtn.removeEventListener('click', handleConfirm);
        cancelBtn.removeEventListener('click', handleCancel);
      };
      
      confirmBtn.addEventListener('click', handleConfirm);
      cancelBtn.addEventListener('click', handleCancel);
      
      logoutModal.addEventListener('click', (e) => {
        if (e.target === logoutModal) {
          handleCancel();
        }
      }, { once: true });
    });
  }
  
  [loginForm, registerForm, verifyCodeForm].forEach(form => {
    if (form) {
      form.querySelectorAll('input').forEach(input => {
        input.addEventListener('focus', () => {
          const modalContainer = document.querySelector('.auth-modal-container');
          modalContainer.classList.remove('error-glow');
        });
      });
    }
  });

  // Ensure lock cleanup on app close (best-effort)
  window.addEventListener('beforeunload', () => {
    try { releasePresenceLock(); } catch (e) {}
  });

  // Main process asks us to free the lock before quit (more reliable than beforeunload).
  // Also sign out so PC "Remember me" only keeps email/password, not a live session.
  try {
    ipcRenderer.on('release-session-lock', async () => {
      try { await releasePresenceLock(); } catch (e) {}
      try { await signOut(auth); } catch (e) {}
      try { ipcRenderer.send('session-lock-released'); } catch (e) {}
    });
  } catch (e) {}
}

// Trial durations (ms)
const TRIAL_DURATION_MS = 60 * 60 * 1000; // 1 hour
const TRIAL_TEST_MS = 1 * 60 * 1000; // test override (used by trial button)

let trialCountdownTimer = null;
let userProfileUnsubscribe = null; // onSnapshot unsubscriber for user's doc
let lastTrialExpiresAt = null; // track last known trial expiration (ms) to detect expiry transitions

// Cache last-known entitlement to avoid flashing subscribe UI during transient auth/network issues
let entitlementCache = {
  subscriptionStatus: null,
  paidUntilRaw: null,
  paidUntilMs: null,
  trialExpiresAtRaw: null,
  trialExpiresAtMs: null,
  paidActive: false,
  trialActive: false,
  betaTester: false,
  updatedAt: 0
};

function updateEntitlementCache(next) {
  try {
    entitlementCache = Object.assign({}, entitlementCache, next || {}, { updatedAt: Date.now() });
    try { window.__utkEntitlementCache = entitlementCache; } catch (e) {}
  } catch (e) {}
}

function pillLabel(userData, paidActive) {
  try {
    const email = String(
      (userData && (userData.email || userData.Email)) ||
      (window.auth && window.auth.currentUser && window.auth.currentUser.email) ||
      ''
    ).trim().toLowerCase();
    if (email === 'kricoeasygame@gmail.com') return 'Owner';
  } catch (e) {}
  if (userData && (userData.role === 'owner' || userData.isOwner)) return 'Owner';
  if (userData && userData.betaTester) return 'Beta tester';
  if (paidActive) return 'Citizen';
  return 'Wanderer';
}

function canShowSubscriptionOverlayNow() {
  try {
    // Only show subscription UI when user is signed in and app UI is visible
    if (!auth || !auth.currentUser) return false;
    if (document && document.body && document.body.classList && document.body.classList.contains('auth-visible')) return false;
    return true;
  } catch (e) {
    return false;
  }
}

let subscriptionGateRefreshTimer = null;
function scheduleSubscriptionGateRefresh(delayMs = 200) {
  try {
    if (subscriptionGateRefreshTimer) clearTimeout(subscriptionGateRefreshTimer);
    subscriptionGateRefreshTimer = setTimeout(() => {
      subscriptionGateRefreshTimer = null;
      try { refreshSubscriptionGate(); } catch (e) {}
    }, delayMs);
  } catch (e) {}
}

async function refreshSubscriptionGate() {
  try {
    if (!auth || !auth.currentUser) {
      try { hideSubscriptionOverlay(true); } catch (e) {}
      return;
    }
    if (!canShowSubscriptionOverlayNow()) return;

    ensureSubscriptionOverlay();
    const ov = document.getElementById('subscription-overlay');
    if (!ov) return;

    const forceOpen = !!window.__utkForceSubscribe;
    try { window.__utkForceSubscribe = false; } catch (e) {}
    const waiting = ov.classList.contains('waiting') || ov.classList.contains('waiting-only');

    let allowed = true;
    if (typeof ov._updateSubscriptionUI === 'function') {
      try {
        allowed = await ov._updateSubscriptionUI();
      } catch (e) {
        allowed = false;
      }
    }

    // App is free — never auto-block. Only open when user taps Subscribe / lock CTA, or mid-checkout.
    if (!forceOpen && !waiting) {
      try { hideSubscriptionOverlay(true); } catch (e) {}
      return;
    }

    // Force-open from locked bot/studio: show unless entitlement update proves paid.
    if (!allowed && !forceOpen) {
      try { hideSubscriptionOverlay(true); } catch (e) {}
      return;
    }
    if (!allowed && forceOpen) {
      try {
        const c = window.__utkEntitlementCache || entitlementCache;
        if (c && c.paidActive) {
          hideSubscriptionOverlay(true);
          return;
        }
      } catch (e) {
        try { hideSubscriptionOverlay(true); } catch (e2) {}
        return;
      }
    }

    try {
      if (typeof window.__utkRestoreSubscriptionOverlayView === 'function') {
        window.__utkRestoreSubscriptionOverlayView('main');
      }
    } catch (e) {}

    try {
      const copy = window.__utkSubscribeCopy || {};
      const reason = String((copy && copy.reason) || window.__utkSubscribeReason || '');
      const titleEl = ov.querySelector('#subTitle');
      const sub = ov.querySelector('.sub-subtitle');
      if (titleEl && copy.title) titleEl.textContent = copy.title;
      else if (titleEl) titleEl.textContent = 'Go Beyond Wanderer';
      if (sub) {
        if (copy.subtitle) {
          sub.textContent = copy.subtitle;
        } else if (reason === 'studio') {
          sub.textContent = 'We can see you are only wandering here. Studio and Feed are for members. Chat and Strategies stay free. Subscribe when you want the full desk.';
        } else if (reason === 'house-bot') {
          sub.textContent = 'We can see you are only wandering here. Right now you can use the quietest house bot from the last day. Subscribe to unlock all three and a lot more.';
        } else {
          sub.textContent = 'Subscribe for all bots and Studio. Chat and Strategies stay free.';
        }
      }
    } catch (e) {}

    ov.style.removeProperty('opacity');
    ov.style.removeProperty('pointer-events');
    ov.style.display = 'flex';
    ov.classList.remove('closing', 'waiting', 'waiting-only');
    ov.classList.add('active', 'opening');

    const content = ov.querySelector('.sub-content');
    try {
      if (content) {
        content.classList.add('pulse');
        setTimeout(() => { try { content.classList.remove('pulse'); } catch (e) {} }, 760);
      }
    } catch (e) {}

    setTimeout(() => { try { ov.classList.remove('opening'); } catch (e) {} }, 1100);
  } catch (e) {}
}

try { window.__utkRefreshSubscriptionGate = refreshSubscriptionGate; } catch (e) {}

// If auth temporarily drops to signed-out, ensure subscribe overlay doesn't linger/flash.
try {
  if (!window.__utkSubOverlayAuthGuardAttached) {
    window.__utkSubOverlayAuthGuardAttached = true;
    if (auth && typeof auth.onAuthStateChanged === 'function') {
      auth.onAuthStateChanged((user) => {
        if (!user) {
          try { updateEntitlementCache({ paidActive: false, trialActive: false, subscriptionStatus: null, betaTester: false }); } catch (e) {}
          try { showAuthScreenAfterSignOut(); } catch (e) {}
        }
      });
    }
  }
} catch (e) {}

function clearTrialCountdown(preservePill) {
  try {
    try { console.debug('clearTrialCountdown called', new Date().toISOString(), { preservePill: !!preservePill }); } catch (dbgE) {}
    if (trialCountdownTimer) { clearInterval(trialCountdownTimer); trialCountdownTimer = null; }
    const subCountdown = document.getElementById('trialCountdown');
    if (subCountdown) { subCountdown.textContent = ''; subCountdown.style.display = 'none'; }
    const subDetail = document.getElementById('trialCountdownDetail');
    if (subDetail) { subDetail.style.display = 'none'; const t = document.getElementById('trialCountdownText'); if (t) t.textContent = ''; }
    const fill = document.getElementById('trialProgressFill'); if (fill) { try { fill.style.width = '0%'; fill.style.background = 'rgba(255,255,255,0.06)'; } catch (e) {} }
    const subPill = document.getElementById('subscriptionPill');
    if (subPill && !preservePill) { subPill.textContent = 'Free trial'; }
  } catch (e) {}
} 


// Helper to render a countdown given an ISO timestamp or ms
function renderTrialCountdown(trialExpiresAt) {
  try {
    if (!trialExpiresAt) { clearTrialCountdown(); return; }
    const expires = typeof trialExpiresAt === 'string' ? Date.parse(trialExpiresAt) : Number(trialExpiresAt);
    if (!expires || isNaN(expires)) { clearTrialCountdown(); return; }

    const subPill = document.getElementById('subscriptionPill');
    const subCountdown = document.getElementById('trialCountdown');
    const detailEl = document.getElementById('trialCountdownDetail');
    const detailText = document.getElementById('trialCountdownText');
    const progressFill = document.getElementById('trialProgressFill');
    // shimmer removed; no shine element

    const totalMs = 60 * 60 * 1000; // 1 hour trial duration

    const pad = (n) => String(n).padStart(2, '0');
    const formatHMS = (ms) => {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    };

    const update = () => {
      const rem = expires - Date.now();
      if (rem <= 0) {
        clearTrialCountdown();
        if (subPill) subPill.textContent = 'Trial ended';
        // Immediately show subscription overlay when trial expires (only if still signed in)
        try { /* free app — no forced paywall */ } catch (e) {}
        return;
      }
      const mm = Math.floor(rem / 60000);
      const ss = Math.floor((rem % 60000) / 1000);
      const txt = `${mm}m ${ss}s`;

      // percent remaining (clamped)
      const pct = Math.max(0, Math.min(100, Math.round((rem / totalMs) * 100)));

      // only show compact "Time left" detail (less prominent)
      if (subCountdown) { subCountdown.textContent = ''; subCountdown.style.display = 'none'; }
      if (detailEl) { detailEl.style.display = 'block'; detailEl.style.color = 'rgba(255,255,255,0.65)'; detailEl.style.fontSize = '12px'; }
      if (detailText) { detailText.textContent = formatHMS(rem); }
      if (progressFill) { try { progressFill.style.width = pct + '%'; progressFill.style.background = 'rgba(0,0,0,0.28)'; } catch (e) {} }
    };

    // previously had shimmer logic here; removed to disable shine entirely


    clearTrialCountdown();
    if (subPill) subPill.textContent = 'Free trial';
    update();
    trialCountdownTimer = setInterval(update, 1000);

    // ensure shine width initialization for first run
    try {
      if (shineEl && progressFill) {
        const containerInit = progressFill && progressFill.parentElement ? progressFill.parentElement : (progressFill || null);
        const fullWInit = containerInit ? containerInit.clientWidth : 180;
        const fillWInit = progressFill ? progressFill.clientWidth : fullWInit;
        const shineWpxInit = Math.max(8, Math.min(40, Math.round(fillWInit * 0.12)));
        shineEl.style.width = shineWpxInit + 'px';
        const targetPxInit = Math.max(0, fillWInit - shineWpxInit);
        shineEl.style.setProperty('--shine-target', targetPxInit + 'px');
        shineEl.style.transform = 'translateX(0px)';
      }
    } catch (e) {}
  } catch (e) {}
}

// Render a countdown for paid subscription (uses same UI as trial countdown)
function renderPaidCountdown(paidUntilRaw, lastPaidRaw) {
  try {
    if (!paidUntilRaw) { clearTrialCountdown(true); return; }
    const expires = typeof paidUntilRaw === 'string' ? Date.parse(paidUntilRaw) : Number(paidUntilRaw);
    try { console.debug('renderPaidCountdown called', { paidUntilRaw, expires, lastPaidRaw }); } catch (dbgE) { console.debug('renderPaidCountdown debug failed', dbgE); }
    if (!expires || isNaN(expires)) { clearTrialCountdown(true); return; }

    const lastPaid = lastPaidRaw ? (typeof lastPaidRaw === 'string' ? Date.parse(lastPaidRaw) : Number(lastPaidRaw)) : null;
    const subtotalMs = (lastPaid && lastPaid < expires) ? (expires - lastPaid) : (30 * 24 * 60 * 60 * 1000); // fallback to 30d

    const subPill = document.getElementById('subscriptionPill');
    const subCountdown = document.getElementById('trialCountdown');
    const detailEl = document.getElementById('trialCountdownDetail');
    const detailText = document.getElementById('trialCountdownText');
    const progressFill = document.getElementById('trialProgressFill');
    const paidPill = document.getElementById('paidUntilPill');



    const pad = (n) => String(n).padStart(2, '0');
    const formatHMS = (ms) => {
      const d = Math.floor(ms / (24 * 3600000));
      const h = Math.floor((ms % (24 * 3600000)) / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    };

    const update = () => {
      const rem = expires - Date.now();
      if (rem <= 0) {
        clearTrialCountdown(true);
        if (subPill) subPill.textContent = 'Wanderer';
        try { /* free app — soft CTA only */ } catch (e) {}
        return;
      }

      // percent remaining (clamped)
      const pct = Math.max(0, Math.min(100, Math.round((rem / subtotalMs) * 100)));

      if (subCountdown) { subCountdown.textContent = ''; subCountdown.style.display = 'none'; }
      if (detailEl) { detailEl.style.display = 'block'; detailEl.style.color = 'rgba(255,255,255,0.65)'; detailEl.style.fontSize = '12px'; }
      if (detailText) { detailText.textContent = formatHMS(rem); }
      if (progressFill) { try { progressFill.style.width = pct + '%'; progressFill.style.background = 'rgba(0,0,0,0.28)'; } catch (e) {} }
      if (subPill) {
        try {
          const cached = window.__utkEntitlementCache;
          subPill.textContent = pillLabel(
            { role: cached && cached.isOwner ? 'owner' : '', isOwner: !!(cached && cached.isOwner), betaTester: !!(cached && cached.betaTester) },
            true
          );
        } catch (e) {
          subPill.textContent = 'Citizen';
        }
      }
    };

    clearTrialCountdown();
    if (subPill) {
      try {
        const cached = window.__utkEntitlementCache;
        subPill.textContent = pillLabel(
          { role: cached && cached.isOwner ? 'owner' : '', isOwner: !!(cached && cached.isOwner), betaTester: !!(cached && cached.betaTester) },
          true
        );
      } catch (e) {
        subPill.textContent = 'Citizen';
      }
    }
    update();
    trialCountdownTimer = setInterval(update, 1000);
  } catch (e) {}
}

// duplicate clearTrialCountdown removed (consolidated above) 

// duplicate clearTrialCountdown removed (consolidated above) 

async function loadUserProfile(user) {
  try {
    // Clean up any previous listener
    try { if (userProfileUnsubscribe) { userProfileUnsubscribe(); userProfileUnsubscribe = null; } } catch (e) {}

    // Helper to update basic profile UI (username, email, avatars, memberSince, lastLogin)
    function updateBasicProfileUI(userData) {
      try {
        const username = (userData && userData.username) ? userData.username : (user && user.email ? user.email.split('@')[0] : '');
        const usernameEl = document.getElementById('usernameName'); if (usernameEl) usernameEl.textContent = username;
        const displayUsername = document.getElementById('displayUsername'); if (displayUsername) displayUsername.textContent = username;
        const sidebarUsername = document.getElementById('sidebarUsername'); if (sidebarUsername) sidebarUsername.textContent = username;

        const displayEmail = document.getElementById('displayEmail'); if (displayEmail) displayEmail.textContent = (user && user.email) ? user.email : (userData && userData.email) ? userData.email : '';

        // Avatar
        const profileAvatar = document.getElementById('profileAvatar');
        if (profileAvatar) {
          const avatarSpan = profileAvatar.querySelector('span');
          if (userData && userData.avatarUrl) {
            if (avatarSpan) avatarSpan.style.display = 'none';
            profileAvatar.style.backgroundImage = `url(${userData.avatarUrl})`;
            profileAvatar.style.backgroundSize = 'cover';
            profileAvatar.style.backgroundPosition = 'center';
            profileAvatar.classList.add('has-image');
          } else {
            if (avatarSpan) { avatarSpan.style.display = 'flex'; avatarSpan.textContent = username.charAt(0).toUpperCase(); }
            profileAvatar.style.backgroundImage = 'none';
            profileAvatar.classList.remove('has-image');
          }
        }

        // Sidebar avatar
        const sidebarAvatar = document.getElementById('sidebarAvatar');
        if (sidebarAvatar) {
          const sidebarAvatarSpan = sidebarAvatar.querySelector('span');
          if (userData && userData.avatarUrl) {
            if (sidebarAvatarSpan) sidebarAvatarSpan.style.display = 'none';
            sidebarAvatar.style.backgroundImage = `url(${userData.avatarUrl})`;
            sidebarAvatar.style.backgroundSize = 'cover';
            sidebarAvatar.style.backgroundPosition = 'center';
            sidebarAvatar.classList.add('has-image');
          } else {
            if (sidebarAvatarSpan) { sidebarAvatarSpan.style.display = 'flex'; sidebarAvatarSpan.textContent = username.charAt(0).toUpperCase(); }
            sidebarAvatar.style.backgroundImage = 'none';
            sidebarAvatar.classList.remove('has-image');
          }
        }

        // Member since
        if (userData && userData.createdAt) {
          const memberSince = document.getElementById('memberSince');
          if (memberSince) {
            const date = new Date(userData.createdAt);
            memberSince.textContent = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
          }
        }

        // Last login - use current time for display (like before)
        const lastLogin = document.getElementById('lastLogin');
        if (lastLogin) {
          const now = new Date();
          lastLogin.textContent = now.toLocaleString('en-US', { 
            month: 'short', 
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });
        }
      } catch (e) {}
    }

    // Realtime listener to keep the profile countdown accurate
    try {
      userProfileUnsubscribe = onSnapshot(doc(db, 'users', user.uid), (snap) => {
        const userData = snap.exists() ? snap.data() : {};
        try {
          // Always update basic profile UI from snapshot
          try { updateBasicProfileUI(userData); } catch (e) {}

          const now = Date.now();
          const trialExpiresAtRaw = userData && userData.trialExpiresAt ? userData.trialExpiresAt : null;
          const trialExpiresAt = trialExpiresAtRaw ? Date.parse(trialExpiresAtRaw) : null;
          const paidUntil = userData && userData.paidUntil ? Date.parse(userData.paidUntil) : null;
          const trialUsed = !!userData && (!!userData.trialUsed || !!userData.trialHasBeenUsed || !!userData.trial_used);

          const paidActive = ((paidUntil && paidUntil > now) || (userData && userData.subscriptionStatus === 'active'));
          const trialActive = (trialExpiresAt && trialExpiresAt > now);
          const prevTrialActive = !!(lastTrialExpiresAt && lastTrialExpiresAt > now);

          // Keep a cache so transient errors don't bounce users into subscription overlay
          try {
            updateEntitlementCache({
              subscriptionStatus: userData && userData.subscriptionStatus,
              paidUntilRaw: userData && userData.paidUntil,
              paidUntilMs: paidUntil || null,
              trialExpiresAtRaw,
              trialExpiresAtMs: trialExpiresAt || null,
              paidActive: !!paidActive || !!(userData && (userData.role === 'owner' || userData.isOwner)),
              trialActive: !!trialActive,
              betaTester: !!(userData && userData.betaTester),
              isOwner: !!(userData && (userData.role === 'owner' || userData.isOwner))
            });
          } catch (e) {}

          // DEBUG: Log snapshot values to diagnose why Free trial may show instead of Subscribed
          try {
            console.debug('profile snapshot', { uid: (user && user.uid), subscriptionStatus: userData && userData.subscriptionStatus, paidUntilRaw: userData && userData.paidUntil, paidUntilMs: paidUntil, nowMs: now, trialExpiresAtRaw, trialExpiresAt, trialUsed });
          } catch (dbgE) { console.debug('profile snapshot debug failed', dbgE); }




          const isOwnerUser = !!(userData && (userData.role === 'owner' || userData.isOwner));
          const effectivePaid = !!paidActive || isOwnerUser;

          // Free app: never auto-open paywall on profile sync
          try {
            if (effectivePaid) {
              try { hideSubscriptionOverlay(true); } catch (e) {}
            }
          } catch (e) {}

          // Update lastTrialExpiresAt
          lastTrialExpiresAt = trialExpiresAt || null;

          // If paid subscription active, show Member/Owner and render countdown
          if (effectivePaid) {
            try { console.debug('profile: taking paid branch', { subscriptionStatus: userData && userData.subscriptionStatus, paidUntilRaw: userData && userData.paidUntil, paidUntilMs: paidUntil, nowMs: now }); } catch (dbgE) { console.debug('profile paid-branch debug failed', dbgE); }
            const subPill = document.getElementById('subscriptionPill'); if (subPill) subPill.textContent = pillLabel(userData, true);
            // prefer top-level paidUntil, fallback to subscription.paidUntil
            const effectivePaidUntilRaw = userData && (userData.paidUntil || (userData.subscription && userData.subscription.paidUntil)) ? (userData.paidUntil || userData.subscription.paidUntil) : null;
            const effectivePaidUntilMs = effectivePaidUntilRaw ? Date.parse(effectivePaidUntilRaw) : null;
            // Hide the legacy 'Paid until' pill per user preference
            const paidPill = document.getElementById('paidUntilPill'); if (paidPill) { try { paidPill.style.display = 'none'; } catch (e) {} }
            // Render a paid subscription countdown similar to trial; preserve pill if countdown not available
            try { renderPaidCountdown(effectivePaidUntilRaw, userData && userData.subscription ? userData.subscription.last_paid : null); } catch (e) { try { clearTrialCountdown(true); } catch (e2) {} }
            return;
          }

          // Active trial: render countdown
          if (trialActive) {
            renderTrialCountdown(trialExpiresAtRaw);
            return;
          }

          // Trial consumed in past
          if (trialUsed) {
            const subPill = document.getElementById('subscriptionPill'); if (subPill) subPill.textContent = 'Wanderer';
            clearTrialCountdown();
            return;
          }

          // Default free tier
          try { console.debug('profile: wanderer (free)', { subscriptionStatus: userData && userData.subscriptionStatus }); } catch (dbgE) {}
          const subPill = document.getElementById('subscriptionPill'); if (subPill) subPill.textContent = 'Wanderer';
        } catch (e) {}
      });
    } catch (e) {
      // fallback: single-shot load if listener fails
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      const userData = (userDoc && userDoc.exists()) ? userDoc.data() : {};
      try {
        // Update basic profile fields from single-shot fetch as a fallback
        try { updateBasicProfileUI(userData); } catch (e) {}

        const subPill = document.getElementById('subscriptionPill');
        const paidPill = document.getElementById('paidUntilPill');
        if (subPill) subPill.textContent = pillLabel(userData, true);
        // Do not display the 'Paid until' pill (user requested removal)
        if (paidPill) { try { paidPill.style.display = 'none'; } catch (e) {} }
        // single-shot fallback: prefer subscription.paidUntil if top-level paidUntil missing
        const fallbackPaidUntilRaw = userData && (userData.paidUntil || (userData.subscription && userData.subscription.paidUntil)) ? (userData.paidUntil || userData.subscription.paidUntil) : null;
        if (fallbackPaidUntilRaw && Date.parse(fallbackPaidUntilRaw) > Date.now()) {
          try { renderPaidCountdown(fallbackPaidUntilRaw, userData.subscription && userData.subscription.last_paid); } catch (e) { try { clearTrialCountdown(true); } catch (e2) {} }
        } else if (userData && userData.trialExpiresAt) {
          // show the countdown using the same renderer
          try { renderTrialCountdown(userData.trialExpiresAt); } catch (e) {}
        } else {
          if (!userData.trialExpiresAt) { clearTrialCountdown(); }
        }
      } catch (e) {}
      const username = (userData && userData.username) ? userData.username : (user && user.email ? user.email.split('@')[0] : '');
      const usernameEl = document.getElementById('usernameName');
      if (usernameEl) usernameEl.textContent = username;
      
      const displayUsername = document.getElementById('displayUsername');
      if (displayUsername) displayUsername.textContent = username;
      
      // Update sidebar username
      const sidebarUsername = document.getElementById('sidebarUsername');
      if (sidebarUsername) sidebarUsername.textContent = username;
      
      // Update email
      const displayEmail = document.getElementById('displayEmail');
      if (displayEmail) displayEmail.textContent = user.email;
      
      // Update profile avatar
      const profileAvatar = document.getElementById('profileAvatar');
      if (profileAvatar) {
        const avatarSpan = profileAvatar.querySelector('span');
        if (userData.avatarUrl) {
          // Show image
          avatarSpan.style.display = 'none';
          profileAvatar.style.backgroundImage = `url(${userData.avatarUrl})`;
          profileAvatar.style.backgroundSize = 'cover';
          profileAvatar.style.backgroundPosition = 'center';
          profileAvatar.classList.add('has-image');
        } else {
          // Show initial
          avatarSpan.style.display = 'flex';
          avatarSpan.textContent = username.charAt(0).toUpperCase();
          profileAvatar.style.backgroundImage = 'none';
          profileAvatar.classList.remove('has-image');
        }
      }
      
      // Update sidebar avatar
      const sidebarAvatar = document.getElementById('sidebarAvatar');
      if (sidebarAvatar) {
        const sidebarAvatarSpan = sidebarAvatar.querySelector('span');
        if (userData.avatarUrl) {
          // Show image
          if (sidebarAvatarSpan) sidebarAvatarSpan.style.display = 'none';
          sidebarAvatar.style.backgroundImage = `url(${userData.avatarUrl})`;
          sidebarAvatar.style.backgroundSize = 'cover';
          sidebarAvatar.style.backgroundPosition = 'center';
          sidebarAvatar.classList.add('has-image');
        } else {
          // Show initial
          if (sidebarAvatarSpan) {
            sidebarAvatarSpan.style.display = 'flex';
            sidebarAvatarSpan.textContent = username.charAt(0).toUpperCase();
          }
          sidebarAvatar.style.backgroundImage = 'none';
          sidebarAvatar.classList.remove('has-image');
        }
      }
      
      // Update member since
      if (userData.createdAt) {
        const memberSince = document.getElementById('memberSince');
        if (memberSince) {
          const date = new Date(userData.createdAt);
          memberSince.textContent = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
        }
      }
      
      // Update last login
      const lastLogin = document.getElementById('lastLogin');
      if (lastLogin) {
        const now = new Date();
        lastLogin.textContent = now.toLocaleString('en-US', { 
          month: 'short', 
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      }

      // Subscription / trial UI
      try {
        const subPill = document.getElementById('subscriptionPill');
        const subCountdown = document.getElementById('trialCountdown');
        if (subPill) subPill.textContent = 'Free trial';
        if (subCountdown) { subCountdown.style.display = 'none'; subCountdown.textContent = ''; }

        const now = Date.now();
        const trialExpiresAt = userData && userData.trialExpiresAt ? Date.parse(userData.trialExpiresAt) : null;
        const paidUntil = userData && userData.paidUntil ? Date.parse(userData.paidUntil) : null;
        const trialUsed = !!userData && (!!userData.trialUsed || !!userData.trialHasBeenUsed || !!userData.trial_used);

        // If paid subscription active, show Member/Owner
        if ((paidUntil && paidUntil > now) || (userData && userData.subscriptionStatus === 'active') || (userData && (userData.role === 'owner' || userData.isOwner))) {
          if (subPill) subPill.textContent = pillLabel(userData, true);
          // Clear any timers/UI but preserve the pill text we just set
          clearTrialCountdown(true);
          return;
        }

        // Active trial
        if (trialExpiresAt && trialExpiresAt > now) {
          if (subPill) subPill.textContent = 'Free trial';
          try { renderTrialCountdown(userData.trialExpiresAt); } catch (e) {}
          return;
        }

        // Trial consumed in past
        if (trialUsed) {
          if (subPill) subPill.textContent = 'Trial used';
          if (subCountdown) { subCountdown.style.display = 'none'; subCountdown.textContent = ''; }
          return;
        }

        // Default: show free trial label (not active)
        if (subPill) subPill.textContent = 'Free trial';
      } catch (e) {}

    }
  } catch (err) {
    // console.error('Failed to load user profile:', err);
  }
}

// Setup username editor
function setupUsernameEditor() {
  const editUsernameBtn = document.getElementById('editUsernameBtn');
  const usernameModal = document.getElementById('username-modal');
  const saveUsernameBtn = document.getElementById('saveUsername');
  const cancelUsernameBtn = document.getElementById('cancelUsername');
  const newUsernameInput = document.getElementById('newUsername');
  const usernameError = document.getElementById('usernameError');
  
  if (!editUsernameBtn || !usernameModal) return;
  
  // Open modal
  editUsernameBtn.addEventListener('click', () => {
    const currentUsername = document.getElementById('displayUsername').textContent;
    newUsernameInput.value = currentUsername;
    usernameError.textContent = '';
    usernameModal.classList.add('active');
    newUsernameInput.focus();
  });
  
  // Close modal
  const closeModal = () => {
    usernameModal.classList.add('closing');
    setTimeout(() => {
      usernameModal.classList.remove('active', 'closing');
    }, 200);
  };
  
  cancelUsernameBtn.addEventListener('click', closeModal);
  
  // Close on background click
  usernameModal.addEventListener('click', (e) => {
    if (e.target === usernameModal) closeModal();
  });
  
  // Save username
  saveUsernameBtn.addEventListener('click', async () => {
    const newUsername = newUsernameInput.value.trim();
    
    // Validate
    if (!newUsername) {
      usernameError.textContent = 'Username cannot be empty';
      return;
    }
    if (newUsername.length < 3) {
      usernameError.textContent = 'Username must be at least 3 characters';
      return;
    }
    if (newUsername.length > 30) {
      usernameError.textContent = 'Username must be 30 characters or less';
      return;
    }
    
    try {
      saveUsernameBtn.disabled = true;
      saveUsernameBtn.textContent = 'Saving...';
      
      // Update Firestore
      const user = auth.currentUser;
      if (!user) throw new Error('No user logged in');
      
      const userDoc = doc(db, 'users', user.uid);
      await updateDoc(userDoc, {
        username: newUsername
      });
      
      // Update UI
      document.getElementById('displayUsername').textContent = newUsername;
      
      // Also update sidebar username
      const sidebarUsername = document.getElementById('sidebarUsername');
      if (sidebarUsername) sidebarUsername.textContent = newUsername;
      
      const avatarEl = document.getElementById('profileAvatar');
      const avatarSpan = avatarEl ? avatarEl.querySelector('span') : null;
      if (avatarEl && !avatarEl.classList.contains('has-image') && avatarSpan) {
        avatarSpan.textContent = newUsername[0].toUpperCase();
      }
      
      // Also update sidebar avatar initial
      const sidebarAvatar = document.getElementById('sidebarAvatar');
      const sidebarSpan = sidebarAvatar ? sidebarAvatar.querySelector('span') : null;
      if (sidebarAvatar && !sidebarAvatar.classList.contains('has-image') && sidebarSpan) {
        sidebarSpan.textContent = newUsername[0].toUpperCase();
      }
      
      closeModal();
    } catch (err) {
      // console.error('Error saving username:', err);
      usernameError.textContent = 'Failed to save username. Try again.';
    } finally {
      saveUsernameBtn.disabled = false;
      saveUsernameBtn.textContent = 'Save';
    }
  });

  // Save on Enter key
  newUsernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') saveUsernameBtn.click();
  });
}

// Setup avatar upload and save to Firestore
function setupAvatarUpload() {
  const changeAvatarBtn = document.getElementById('changeAvatarBtn');
  const avatarInput = document.getElementById('avatarInput');
  const profileAvatar = document.getElementById('profileAvatar');

  if (!changeAvatarBtn || !avatarInput || !profileAvatar) return;

  changeAvatarBtn.addEventListener('click', () => {
    avatarInput.click();
  });

  avatarInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Limit file size to ~200KB to keep Firestore payload small
    const maxSize = 200 * 1024;
    if (file.size > maxSize) {
      try {
        if (typeof window.showAppToast === 'function') window.showAppToast('Please choose an image under 200KB.', { tone: 'error' });
        else alert('Please choose an image under 200KB.');
      } catch (e) {}
      avatarInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      const dataUrl = event.target.result;

      try {
        const user = auth.currentUser;
        if (!user) throw new Error('No user logged in');

        const userDoc = doc(db, 'users', user.uid);
        await updateDoc(userDoc, {
          avatarUrl: dataUrl
        });

        // Update UI immediately
        profileAvatar.style.backgroundImage = `url('${dataUrl}')`;
        profileAvatar.classList.add('has-image');
        const avatarSpan = profileAvatar.querySelector('span');
        if (avatarSpan) avatarSpan.textContent = '';

        // Also update sidebar avatar
        const sidebarAvatar = document.getElementById('sidebarAvatar');
        if (sidebarAvatar) {
          sidebarAvatar.style.backgroundImage = `url('${dataUrl}')`;
          sidebarAvatar.classList.add('has-image');
          const sidebarSpan = sidebarAvatar.querySelector('span');
          if (sidebarSpan) sidebarSpan.textContent = '';
        }
      } catch (err) {
        try {
          if (typeof window.showAppToast === 'function') window.showAppToast('Could not save avatar. Try again.', { tone: 'error' });
          else alert('Failed to save avatar. Please try again.');
        } catch (e) {}
      } finally {
        avatarInput.value = '';
      }
    };

    reader.readAsDataURL(file);
  });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setupAuth();
    setupUsernameEditor();
    setupAvatarUpload();
  });
} else {
  setupAuth();
  setupUsernameEditor();
  setupAvatarUpload();
}

// Subscription overlay feature list (matches website pricing)
const SUBSCRIPTION_FEATURES_HTML = `
  <ul class="feature-list">
    <li style="--i:0"><span class="feature-icon"></span>All three house bots unlocked</li>
    <li style="--i:1"><span class="feature-icon"></span>Studio to cook and publish custom bots</li>
    <li style="--i:2"><span class="feature-icon"></span>Feed to follow community live tapes</li>
    <li style="--i:3"><span class="feature-icon"></span>Citizen mark in chat</li>
  </ul>
`;

// Subscription overlay helpers
function ensureSubscriptionOverlay() {
  const OVERLAY_VERSION = '10';
  const existing = document.getElementById('subscription-overlay');
  if (existing && existing.dataset.version === OVERLAY_VERSION) return;
  if (existing) existing.remove();
  const oldStyle = document.getElementById('subscription-overlay-style');
  if (oldStyle) oldStyle.remove();
  try {
    const style = document.createElement('style');
    style.id = 'subscription-overlay-style';
    style.textContent = `
#subscription-overlay {
  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  z-index: 2147483646; pointer-events: none; opacity: 0;
  background: #050607;
  transition: opacity 560ms cubic-bezier(.22,1,.36,1);
  overflow: hidden;
}
#subscription-overlay:not(.active) .sub-content {
  transform: translateY(36px) scale(0.985); opacity: 0;
}
#subscription-overlay.active {
  opacity: 1; pointer-events: auto;
}
#subscription-overlay.active .sub-content {
  transform: translateY(0) scale(1); opacity: 1;
  transition: transform 720ms cubic-bezier(.22,1,.36,1), opacity 520ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .sub-letterbox {
  position: absolute; left: 0; right: 0; height: 0;
  background: #000;
  pointer-events: none;
  z-index: 2;
  transition: height 720ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .sub-letterbox-top { top: 0; }
#subscription-overlay .sub-letterbox-bottom { bottom: 0; }
#subscription-overlay.active .sub-letterbox { height: 52px; }
#subscription-overlay .decor {
  position: absolute; inset: 0;
  pointer-events: none;
  overflow: hidden;
}
#subscription-overlay .decor::before {
  content: '';
  position: absolute; inset: -20%;
  background:
    radial-gradient(ellipse 50% 36% at 48% 22%, rgba(255,255,255,0.07), transparent 58%),
    radial-gradient(ellipse 42% 28% at 72% 68%, rgba(255,255,255,0.035), transparent 60%),
    radial-gradient(ellipse 70% 50% at 50% 100%, rgba(255,255,255,0.025), transparent 55%);
  animation: subDrift 16s ease-in-out infinite alternate;
}
#subscription-overlay .decor::after {
  content: '';
  position: absolute; inset: 0;
  background:
    linear-gradient(180deg, rgba(0,0,0,0.35) 0%, transparent 18%, transparent 82%, rgba(0,0,0,0.45) 100%),
    repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.012) 3px);
  opacity: 0.55;
  animation: subGrain 7s linear infinite;
  mix-blend-mode: soft-light;
}
@keyframes subDrift {
  from { transform: translate3d(-2%, -1%, 0) scale(1); }
  to { transform: translate3d(3%, 2%, 0) scale(1.06); }
}
@keyframes subGrain {
  from { transform: translateY(0); }
  to { transform: translateY(-12px); }
}
#subscription-overlay.active .decor {
  animation: subVeilIn 900ms cubic-bezier(.22,1,.36,1) both;
}
@keyframes subVeilIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes subRise {
  from { opacity: 0; transform: translateY(16px); filter: blur(4px); }
  to { opacity: 1; transform: translateY(0); filter: blur(0); }
}
#subscription-overlay .sub-content {
  position: relative; z-index: 3;
  color: rgba(255,255,255,0.92); text-align: left;
  transform: translateY(36px) scale(0.985); opacity: 0;
  transition: transform 720ms cubic-bezier(.22,1,.36,1), opacity 520ms cubic-bezier(.22,1,.36,1);
  max-width: 420px; width: calc(100% - 48px);
  padding: 40px 36px 32px;
  border-radius: 2px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(10,11,13,0.88);
  box-shadow: 0 40px 100px rgba(0,0,0,0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
#subscription-overlay.opening .sub-eyebrow,
#subscription-overlay.active.opening .sub-eyebrow {
  animation: subRise 680ms cubic-bezier(.22,1,.36,1) 90ms both;
}
#subscription-overlay.opening h1,
#subscription-overlay.active.opening h1 {
  animation: subRise 720ms cubic-bezier(.22,1,.36,1) 160ms both;
}
#subscription-overlay.opening .sub-subtitle,
#subscription-overlay.active.opening .sub-subtitle {
  animation: subRise 740ms cubic-bezier(.22,1,.36,1) 240ms both;
}
#subscription-overlay.opening .pay-card .price,
#subscription-overlay.active.opening .pay-card .price {
  animation: subRise 700ms cubic-bezier(.22,1,.36,1) 320ms both;
}
#subscription-overlay.opening .pay-card .features,
#subscription-overlay.active.opening .pay-card .features {
  animation: subRise 700ms cubic-bezier(.22,1,.36,1) 380ms both;
}
#subscription-overlay.opening .feature-list li,
#subscription-overlay.active.opening .feature-list li {
  animation: subRise 640ms cubic-bezier(.22,1,.36,1) calc(420ms + (var(--i, 0) * 70ms)) both;
}
#subscription-overlay.opening .sub-buttons,
#subscription-overlay.active.opening .sub-buttons {
  animation: subRise 700ms cubic-bezier(.22,1,.36,1) 700ms both;
}
#subscription-overlay .sub-close {
  position: absolute; top: 14px; right: 14px;
  width: 36px; height: 36px; border-radius: 2px;
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.4);
  font-size: 22px; line-height: 1; cursor: pointer;
  transition: color 160ms ease, background 160ms ease;
  z-index: 4;
}
#subscription-overlay .sub-close:hover { background: rgba(255,255,255,0.05); color: #fff; }
#subscription-overlay .sub-eyebrow {
  font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
  color: rgba(255,255,255,0.38); font-weight: 600; margin: 0 0 12px;
}
#subscription-overlay h1 {
  margin: 0 0 12px; font-size: 1.65rem; font-weight: 650; letter-spacing: -0.02em;
  color: #fff;
}
#subscription-overlay .sub-subtitle {
  margin: 0 0 28px; font-size: 0.95rem; line-height: 1.55;
  color: rgba(255,255,255,0.52);
}
#subscription-overlay .pay-card {
  border-radius: 2px; padding: 0 0 4px;
  background: transparent;
  border: none;
}
#subscription-overlay .pay-card .price {
  display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px;
}
#subscription-overlay .pay-card .price .amount {
  font-size: 2.1rem; font-weight: 650; color: #fff; letter-spacing: -0.03em;
}
#subscription-overlay .pay-card .price .period {
  color: rgba(255,255,255,0.4); font-size: 0.9rem;
}
#subscription-overlay .pay-card .features {
  font-size: 0.78rem; color: rgba(255,255,255,0.38); margin-bottom: 18px;
  letter-spacing: 0.04em;
}
#subscription-overlay .feature-list {
  list-style: none; margin: 0; padding: 0; display: grid; gap: 10px;
}
#subscription-overlay .feature-list li {
  display: flex; align-items: flex-start; gap: 12px;
  font-size: 0.88rem; color: rgba(255,255,255,0.72); line-height: 1.4;
}
#subscription-overlay .feature-list .feature-icon {
  width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-top: 7px;
  background: rgba(255,255,255,0.55);
}
#subscription-overlay .sub-buttons {
  display: flex; flex-direction: column; gap: 8px; margin-top: 28px;
}
#subscription-overlay button {
  border: none; border-radius: 2px; padding: 13px 16px;
  font-weight: 650; font-size: 0.82rem; letter-spacing: 0.08em;
  text-transform: uppercase; cursor: pointer;
  transition: background 180ms ease, color 180ms ease, border-color 180ms ease, opacity 160ms ease, transform 180ms ease;
}
#subscription-overlay button.primary {
  background: #fff;
  color: #0a0b0e;
}
#subscription-overlay button.primary:hover { background: rgba(255,255,255,0.92); transform: translateY(-1px); }
#subscription-overlay button.secondary {
  background: transparent; color: rgba(255,255,255,0.55);
  border: 1px solid rgba(255,255,255,0.12);
}
#subscription-overlay button.secondary:hover {
  color: #fff; border-color: rgba(255,255,255,0.28);
}
#subscription-overlay button:active { opacity: 0.9; }
#subscription-overlay .sub-message {
  margin-top: 14px; min-height: 1.2em; font-size: 0.82rem;
  color: rgba(255,255,255,0.55); text-align: center;
}
#subscription-overlay .sub-message.spinner::after {
  content: ''; display: inline-block; width: 12px; height: 12px; margin-left: 8px;
  border: 2px solid rgba(255,255,255,0.2); border-top-color: #fff;
  border-radius: 50%; animation: subSpin 0.7s linear infinite; vertical-align: -2px;
}
@keyframes subSpin { to { transform: rotate(360deg); } }
#subscription-overlay.waiting:not(.waiting-only) button { opacity: 0.6; pointer-events: none; }
#subscription-overlay.waiting-only .sub-content > :not(#waiting-only) { display: none !important; }
#subscription-overlay.waiting-only #waiting-only {
  display:flex !important; flex-direction:column; align-items:center; gap:14px;
  margin-top:8px; padding: 8px 0; text-align: center;
}
#subscription-overlay.waiting-only #waiting-only .waiting-title { color:#fff; font-size:1rem; font-weight:600; }
#subscription-overlay.waiting-only #waiting-only .waiting-hint { color:rgba(255,255,255,0.5); font-size:0.85rem; line-height:1.45; max-width:280px; }
#subscription-overlay.waiting-only #waitingReopenBtn { background:#fff; color:#0a0b0e; }
#subscription-overlay.waiting-only #waitingCancelBtn { background:transparent; color:#fff; border:1px solid rgba(255,255,255,0.2); }
#subscription-overlay .sub-content.pulse { animation: subPulse 720ms cubic-bezier(.22,1,.36,1); }
@keyframes subPulse {
  0% { transform: translateY(28px) scale(0.985); opacity: 0; }
  100% { transform: translateY(0) scale(1); opacity: 1; }
}
`;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'subscription-overlay';
    overlay.dataset.version = '10';
    overlay.innerHTML = `
      <div class="sub-letterbox sub-letterbox-top" aria-hidden="true"></div>
      <div class="sub-letterbox sub-letterbox-bottom" aria-hidden="true"></div>
      <div class="decor"></div>
      <div class="sub-content" role="dialog" aria-modal="true" aria-labelledby="subTitle">
        <button type="button" class="sub-close" id="subCloseBtn" aria-label="Close">×</button>
        <div class="sub-eyebrow">Citizen</div>
        <h1 id="subTitle">Go Beyond Wanderer</h1>
        <div class="sub-subtitle">Subscribe for all bots and Studio. Chat and Strategies stay free.</div>
        <div id="sub-main-section">
          <div class="pay-card">
            <div class="price"><span class="amount">€20</span><span class="period">/month</span></div>
            <div class="features">Card via Paddle. Cancel anytime.</div>
            ${SUBSCRIPTION_FEATURES_HTML}
          </div>
          <div class="sub-buttons">
            <button id="subPayBtn" class="primary">Subscribe with card</button>
            <button id="subCloseSoftBtn" class="secondary">Maybe later</button>
          </div>
        </div>
        <div id="waiting-only" class="waiting-only" style="display:none;">
          <div class="waiting-title">Waiting for payment…</div>
          <div class="waiting-hint">Checkout opened in your browser. This closes when payment confirms. If you closed checkout, tap Cancel.</div>
          <button id="waitingReopenBtn">Reopen checkout</button>
          <button id="waitingCancelBtn">Cancel</button>
        </div>
        <div id="subMessage" class="sub-message"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    try {
      const payBtn = document.getElementById('subPayBtn');
      const trialBtn = null;
      const logoutBtn = null;
      const SUB_PAY_LABEL = 'Subscribe with card';
      const closeBtn = document.getElementById('subCloseBtn');
      const closeSoft = document.getElementById('subCloseSoftBtn');
      const closePaywall = () => { try { hideSubscriptionOverlay(); } catch (e) {} };
      if (closeBtn) closeBtn.addEventListener('click', closePaywall);
      if (closeSoft) closeSoft.addEventListener('click', closePaywall);
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay && !overlay.classList.contains('waiting-only')) closePaywall();
      });
      const subMessageEl = document.getElementById('subMessage');

      let lastPaymentUrl = null;
      let paymentOpenInProgress = false;

async function startPaddleCardCheckout() {
        try {
          if (!auth.currentUser) throw new Error('No user');

          const ov = document.getElementById('subscription-overlay');
          if (ov && ov.classList.contains('waiting') && lastPaymentUrl) {
            try {
              await ipcRenderer.invoke('open-payment-window', { url: lastPaymentUrl }).catch(() => null);
              showSubMessage('Reopened payment window...');
            } catch (e) { console.error('Reopen failed', e); showSubMessage('Unable to reopen payment.'); }
            return;
          }

          const email = auth.currentUser.email || '';
          const uid = auth.currentUser.uid || '';
          showSubMessage('Opening card checkout...', { persistent: true, spinner: true });
          const res = await ipcRenderer.invoke('get-paddle-checkout-url', { email, uid }).catch((err) => ({ success: false, error: String(err) }));
          if (!res || !res.success || !res.url) {
            showSubMessage((res && res.error) ? res.error : 'Could not start card checkout. Restart the app and try again.');
            return;
          }

          lastPaymentUrl = res.url;
          if (paymentOpenInProgress && lastPaymentUrl) {
            try {
              await ipcRenderer.invoke('open-payment-window', { url: lastPaymentUrl }).catch(() => null);
              showSubMessage('Reopened checkout...');
            } catch (e) { showSubMessage('Unable to reopen checkout.'); }
            return;
          }

          paymentOpenInProgress = true;
          const openRes = await ipcRenderer.invoke('open-payment-window', { url: lastPaymentUrl }).catch(() => null);
          if (!openRes || !openRes.success) {
            paymentOpenInProgress = false;
            showSubMessage('Could not open checkout.');
            return;
          }

          waitForSubscriptionConfirmation(auth.currentUser.uid);
          enterWaitingOnlyState();
          if (openRes.external) {
            showSubMessage('Checkout is in your browser. Use Cancel below if you closed it without paying.', { persistent: true, spinner: false });
          } else {
            showSubMessage('Waiting for payment confirmation...', { persistent: true, spinner: true });
          }
        } catch (e) {
          console.warn('Card payment handler failed:', e);
          showSubMessage('Payment not available.');
        }
      }

      if (payBtn) payBtn.addEventListener('click', () => { startPaddleCardCheckout(); });

      // Simulate button (dev) - call server to mark user as paid


      let countdownTimer = null;
      const clearCountdown = () => { try { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } } catch (e) {} };

      // Waiting-for-confirmation state
      let waitingListenerUnsub = null;
      let waitingTimeout = null;

      function clearPaymentWaitTimers() {
        try { if (waitingListenerUnsub) { try { waitingListenerUnsub(); } catch (e) {} waitingListenerUnsub = null; } } catch (e) {}
        try { if (waitingTimeout) { clearTimeout(waitingTimeout); waitingTimeout = null; } } catch (e) {}
        try { if (shortWaitTimeout) { clearTimeout(shortWaitTimeout); shortWaitTimeout = null; } } catch (e) {}
      }

      function cancelWaitForConfirmation() {
        clearPaymentWaitTimers();
        try { lastPaymentUrl = null; } catch (e) {}
        try { paymentOpenInProgress = false; } catch (e) {}
        try { const el = document.getElementById('subMessage'); if (el) { el.classList.remove('spinner'); el.style.opacity = '0'; } } catch (e) {}
        try { if (payBtn) payBtn.textContent = SUB_PAY_LABEL; } catch (e) {}
        try { if (payBtn) payBtn.disabled = false; } catch (e) {}
        try { if (trialBtn) trialBtn.disabled = false; } catch (e) {}
        try { if (logoutBtn) logoutBtn.disabled = false; } catch (e) {}
      }

      // Show subscription message, supports persistent display and optional spinner
      function showSubMessage(msg, opts = {}) { try { const el = document.getElementById('subMessage'); if (!el) return; el.textContent = msg || '';
          if (opts.spinner) el.classList.add('spinner'); else el.classList.remove('spinner');
          el.style.opacity = '1';
          if (!opts.persistent) { setTimeout(() => { try { el.style.opacity = '0'; el.classList.remove('spinner'); } catch (e) {} }, 3000); }
        } catch (e) {} }

      // Wait for Firestore to show subscription active; times out after timeoutMs
      let shortWaitTimeout = null;
      function waitForSubscriptionConfirmation(uid, timeoutMs = 1000 * 60 * 5) {
        try {
          clearPaymentWaitTimers();
          const uref = doc(db, 'users', uid);
          waitingListenerUnsub = onSnapshot(uref, (snap) => {
            try {
              const d = snap.exists() ? snap.data() : {};
              const now = Date.now();
              const paidUntil = d && d.paidUntil ? Date.parse(d.paidUntil) : null;
              const subs = d && d.subscription ? d.subscription : {};

              const currentPeriodEnd = subs && subs.current_period_end ? (typeof subs.current_period_end === 'number' ? subs.current_period_end * 1000 : Date.parse(subs.current_period_end)) : null;

              if ((paidUntil && paidUntil > now) || (d && d.subscriptionStatus === 'active') || (currentPeriodEnd && currentPeriodEnd > now)) {
                // success
                cancelWaitForConfirmation();
                try { showSubMessage('Payment confirmed! Thanks.', {}); } catch (e) {}
                try { setTimeout(() => { hideSubscriptionOverlay(); }, 900); } catch (e) {}
              }
            } catch (e) {}
          });

          // Setup timeout fallback (full timeout)
          waitingTimeout = setTimeout(() => {
            try {
              // Timeout: no confirmation received — cancel waiting state and restore UI so user can retry
              cancelWaitForConfirmation();
              try { paymentOpenInProgress = false; } catch (e) {}
              try { exitWaitingOnlyState(); } catch (e) {}
              try { showSubMessage('Payment not confirmed. Please try again.', {}); } catch (e) {}
              try { if (payBtn) { payBtn.disabled = false; payBtn.textContent = SUB_PAY_LABEL; } if (trialBtn) { trialBtn.disabled = false; trialBtn.textContent = '1 hour trial'; } if (logoutBtn) logoutBtn.disabled = false; } catch (e) {}
            } catch (e) {}
          }, timeoutMs);

          // NOTE: removed the short hint that suggested reopening the link or clicking "I completed payment" —
          // we keep the UI minimal while waiting and revert on timeout or cancel.
          

          // Add waiting UI state and disable buttons
          try { const ov = document.getElementById('subscription-overlay'); if (ov) ov.classList.add('waiting'); if (payBtn) payBtn.disabled = true; if (trialBtn) trialBtn.disabled = true; if (logoutBtn) logoutBtn.disabled = true; showSubMessage('Waiting for payment confirmation...', { persistent: true, spinner: true }); } catch (e) {}
        } catch (e) {}
      }

      function restoreSubscriptionOverlayView(view = 'main') {
        try {
          const ov = document.getElementById('subscription-overlay');
          if (!ov) return;
          ov.classList.remove('waiting', 'waiting-only');
          ov._waitingHidden = [];

          const content = ov.querySelector('.sub-content');
          if (content) {
            Array.from(content.children).forEach((child) => {
              try {
                if (child.id === 'waiting-only') {
                  child.style.setProperty('display', 'none', 'important');
                  child.style.removeProperty('visibility');
                  return;
                }
                child.style.removeProperty('display');
                child.style.removeProperty('visibility');
                child.style.removeProperty('opacity');
              } catch (e) {}
            });
          }

          const mainSection = document.getElementById('sub-main-section');
          if (mainSection) {
            mainSection.style.display = 'block';
            mainSection.style.opacity = '1';
            mainSection.style.transform = 'scale(1)';
          }
          if (payBtn) {
            payBtn.disabled = false;
            payBtn.textContent = SUB_PAY_LABEL;
          }
          if (trialBtn) trialBtn.disabled = false;
          if (logoutBtn) logoutBtn.disabled = false;
        } catch (e) {}
      }

      function enterWaitingOnlyState() {
        try {
          const ov = document.getElementById('subscription-overlay');
          if (!ov) return;
          try { ov.classList.add('active'); ov.style.pointerEvents = 'auto'; ov.style.opacity = '1'; } catch (e) {}

          ov._waitingHidden = ov._waitingHidden || [];
          const content = ov.querySelector('.sub-content');
          if (content) {
            Array.from(content.children).forEach((child) => {
              try {
                if (child && child.id === 'waiting-only') {
                  child.style.setProperty('display', 'flex', 'important');
                  child.style.flexDirection = 'column';
                  child.style.alignItems = 'center';
                  child.style.gap = '12px';
                  child.style.zIndex = '9999';
                  child.style.visibility = 'visible';
                  Array.from(content.children).forEach((sib) => {
                    if (sib !== child) {
                      sib.style.setProperty('display', 'none', 'important');
                      sib.style.setProperty('visibility', 'hidden', 'important');
                    }
                  });
                  return;
                }
                const prev = child.style.getPropertyValue('display') || '';
                ov._waitingHidden.push({ el: child, prev });
                child.style.setProperty('display', 'none', 'important');
              } catch (e) {}
            });
          }

          try { ov.classList.add('waiting-only'); ov.classList.remove('waiting'); } catch (e) {}

          try {
            const reopenBtn = document.getElementById('waitingReopenBtn');
            if (reopenBtn) {
              reopenBtn.onclick = async () => {
                try {
                  if (!lastPaymentUrl) return;
                  await ipcRenderer.invoke('open-payment-window', { url: lastPaymentUrl }).catch(() => null);
                  showSubMessage('Reopened checkout...');
                } catch (e) {
                  showSubMessage('Unable to reopen checkout.');
                }
              };
            }
            const waitingCancelBtn = document.getElementById('waitingCancelBtn');
            if (waitingCancelBtn) {
              waitingCancelBtn.onclick = () => {
                try { clearPaymentWaitTimers(); } catch (e) {}
                try { paymentOpenInProgress = false; } catch (e) {}
                try { lastPaymentUrl = null; } catch (e) {}
                try { restoreSubscriptionOverlayView('main'); } catch (e) {}
                try {
                  const el = document.getElementById('subMessage');
                  if (el) { el.classList.remove('spinner'); el.textContent = 'Payment cancelled'; el.style.opacity = '1'; }
                  setTimeout(() => { try { if (el) el.style.opacity = '0'; } catch (e) {} }, 2500);
                } catch (e) {}
              };
            }
          } catch (e) {}
        } catch (e) {}
      }

      function exitWaitingOnlyState() {
        restoreSubscriptionOverlayView('main');
      }

      if (!window.__utkPaymentWindowClosedListener) {
        window.__utkPaymentWindowClosedListener = true;
        ipcRenderer.on('payment-window-closed', () => {
          try {
            clearPaymentWaitTimers();
            paymentOpenInProgress = false;
            try { exitWaitingOnlyState(); } catch (e) {}
            showSubMessage('Payment window closed. You can try again.');
          } catch (e) {}
        });
      }

      // Plan selector and price fetch
      const planSelectorEl = document.getElementById('planSelector');
      let selectedPriceId = null; 
      function fmtPrice(p) {
        if (!p) return '';
        const amt = p.unit_amount != null ? (p.unit_amount / 100).toFixed(2) : '';
        const interval = p.interval ? `/${p.interval}` : '';
        return `${p.nickname || (amt ? ('$' + amt) : '')} ${interval}`.trim();
      }
      async function loadPlans() {
        try {
          if (planSelectorEl) planSelectorEl.textContent = 'Loading plans...';
          const res = await ipcRenderer.invoke('fetch-allowed-prices').catch(() => null);
          if (!res || !res.success || !Array.isArray(res.prices) || res.prices.length === 0) {
            // Fallback to a single default price. Use hardcoded price id if available for quick testing.
            const FALLBACK_PRICE_ID = 'price_1SuKpdQjiGVziimZ8JLiULXt';
            if (planSelectorEl) planSelectorEl.innerHTML = `<div class="plan-card selected" data-price="${FALLBACK_PRICE_ID}">Monthly</div>`;
            selectedPriceId = FALLBACK_PRICE_ID;
            if (payBtn) payBtn.textContent = SUB_PAY_LABEL;
            return;
          }

          const prices = res.prices;
          if (planSelectorEl) planSelectorEl.innerHTML = '';
          prices.forEach((p, idx) => {
            const el = document.createElement('div');
            el.className = 'plan-card' + (idx === 0 ? ' selected' : '');
            el.setAttribute('data-price', p.id);
            el.setAttribute('data-amount', p.unit_amount || '');
            el.setAttribute('data-interval', p.interval || '');
            el.textContent = fmtPrice(p) || p.id;
            el.addEventListener('click', () => {
              selectedPriceId = p.id;
              // toggle selected
              Array.from(planSelectorEl.children).forEach(c => c.classList.remove('selected'));
              el.classList.add('selected');
              if (payBtn) payBtn.textContent = SUB_PAY_LABEL;
            });
            if (planSelectorEl) planSelectorEl.appendChild(el);
            if (idx === 0) selectedPriceId = p.id;
            if (idx === 0 && payBtn) payBtn.textContent = SUB_PAY_LABEL;
          });
        } catch (e) {
          if (planSelectorEl) planSelectorEl.textContent = 'Plans unavailable';
          console.error('Failed to load plans:', e);
        }
      }

      // Update subscription UI state based on Firestore user doc
      async function updateSubscriptionUI() {
        try {
          const user = auth.currentUser;
          if (!user) {
            // Never show the subscription overlay when signed out
            try { clearCountdown(); } catch (e) {}
            try { hideSubscriptionOverlay(); } catch (e) {}
            try { if (trialBtn) { trialBtn.disabled = true; trialBtn.textContent = '1 hour trial'; } } catch (e) {}
            return false;
          }

          let data = null;
          try {
            const uDoc = await getDoc(doc(db, 'users', user.uid));
            data = uDoc.exists() ? uDoc.data() : {};
          } catch (fetchErr) {
            // If we can't fetch entitlement, fail-closed (avoid flashing subscribe UI)
            try {
              const cached = (typeof window !== 'undefined' && window.__utkEntitlementCache) ? window.__utkEntitlementCache : entitlementCache;
              if (cached && (cached.paidActive || cached.trialActive)) {
                try { clearCountdown(); } catch (e2) {}
                try { hideSubscriptionOverlay(); } catch (e2) {}
              }
            } catch (e2) {}
            try { if (trialBtn) { trialBtn.disabled = true; trialBtn.textContent = '1 hour trial'; } } catch (e2) {}
            return false;
          }

          const now = Date.now();
          const effectivePaidUntilRaw = data && (data.paidUntil || (data.subscription && data.subscription.paidUntil)) ? (data.paidUntil || data.subscription.paidUntil) : null;
          const paidUntil = effectivePaidUntilRaw ? Date.parse(effectivePaidUntilRaw) : null;
          const trialExpiresAtRaw = data && data.trialExpiresAt ? data.trialExpiresAt : null;
          const trialExpiresAt = trialExpiresAtRaw ? Date.parse(trialExpiresAtRaw) : null;
          const trialUsed = !!data && (!!data.trialUsed || !!data.trialHasBeenUsed || !!data.trial_used);

          const paidActive = ((paidUntil && paidUntil > now) || (data && data.subscriptionStatus === 'active'));
          const trialActive = (trialExpiresAt && trialExpiresAt > now);
          try {
            updateEntitlementCache({
              subscriptionStatus: data && data.subscriptionStatus,
              paidUntilRaw: effectivePaidUntilRaw,
              paidUntilMs: paidUntil || null,
              trialExpiresAtRaw,
              trialExpiresAtMs: trialExpiresAt || null,
              paidActive: !!paidActive || !!(data && (data.role === 'owner' || data.isOwner)),
              trialActive: !!trialActive,
              betaTester: !!(data && data.betaTester),
              isOwner: !!(data && (data.role === 'owner' || data.isOwner))
            });
          } catch (e) {}

          if (paidActive) {
            try { clearCountdown(); } catch (e) {}
            try { hideSubscriptionOverlay(); } catch (e) {}
            return false;
          }

          if (trialActive) {
            try { clearCountdown(); } catch (e) {}
            try { hideSubscriptionOverlay(); } catch (e) {}
            if (trialBtn) {
              trialBtn.disabled = true;
              const remaining = trialExpiresAt - now;
              const m = Math.floor(remaining / 60000);
              const s = Math.floor((remaining % 60000) / 1000);
              try { trialBtn.textContent = `Trial active (${m}m ${s}s)`; } catch (e) {}
              countdownTimer = setInterval(() => {
                const rem = (trialExpiresAt - Date.now());
                if (rem <= 0) { clearCountdown(); updateSubscriptionUI(); return; }
                const mm = Math.floor(rem / 60000);
                const ss = Math.floor((rem % 60000) / 1000);
                try { if (trialBtn) trialBtn.textContent = `Trial active (${mm}m ${ss}s)`; } catch (e) {}
              }, 1000);
            }
            return false;
          }

          if (trialUsed) {
            if (trialBtn) { trialBtn.disabled = true; trialBtn.textContent = 'Trial ended'; }
            try { clearCountdown(); } catch (e) {}
            return true;
          }

          if (trialBtn) { trialBtn.disabled = false; trialBtn.textContent = '1 hour trial'; }
          try { clearCountdown(); } catch (e) {}
          return true;
        } catch (e) {
          // Last resort: do not auto-show overlay
          try { if (trialBtn) { trialBtn.disabled = true; trialBtn.textContent = '1 hour trial'; } } catch (e2) {}
          return false;
        }
      }

      // Wire up buttons


      if (trialBtn) trialBtn.addEventListener('click', async () => {
        try {

          const user = auth.currentUser;
          if (!user) throw new Error('No user');

          // Re-check server state to avoid race conditions
          const uDoc = await getDoc(doc(db, 'users', user.uid));
          const data = uDoc.exists() ? uDoc.data() : {};
          const now = Date.now();
          const trialExpiresAt = data && data.trialExpiresAt ? Date.parse(data.trialExpiresAt) : null;
          const trialUsed = !!data && (!!data.trialUsed || !!data.trialHasBeenUsed || !!data.trial_used);

          if (trialExpiresAt && trialExpiresAt > now) { showSubMessage('Trial already active'); return; }
          if (trialUsed) { showSubMessage('You already used a trial'); return; }

          // Start trial for the configured trial duration (1 hour)
          const newExpires = new Date(now + TRIAL_DURATION_MS).toISOString();
          await updateDoc(doc(db, 'users', user.uid), { trialExpiresAt: newExpires, subscriptionStatus: 'trial', trialUsed: true });
          // Update local tracking so expiration can be detected
          try { lastTrialExpiresAt = Date.parse(newExpires); } catch (e) {}
          // Immediately update UI and ensure profile listener is set
          try { renderTrialCountdown(newExpires); } catch (e) {}
          try { await loadUserProfile(user); } catch (e) {}
          showSubMessage('Trial started for 1 hour');
          await updateSubscriptionUI();
          setTimeout(hideSubscriptionOverlay, 1200);
        } catch (e) {
          showSubMessage('Unable to start trial.');
        }
      });

      // Logout removed from subscribe scene — use profile logout instead.

      try {
        window.__utkCancelPaymentWait = cancelWaitForConfirmation;
        window.__utkRestoreSubscriptionOverlayView = restoreSubscriptionOverlayView;
      } catch (e) {}

      // Expose update function for when overlay is shown
      try { overlay._updateSubscriptionUI = updateSubscriptionUI; } catch (e) {}

      // Run initial update
      try { updateSubscriptionUI(); } catch (e) {}

      // Load available plans for the pay button
      try { loadPlans().catch(() => {}); } catch (e) {}

    } catch (e) {}
  } catch (e) {
    // Silent fail
  }
}

async function showSubscriptionOverlay(opts) {
  try {
    if (opts && typeof opts === 'object') {
      try {
        window.__utkSubscribeReason = opts.reason || window.__utkSubscribeReason || '';
        window.__utkSubscribeCopy = {
          reason: opts.reason || '',
          title: opts.title || '',
          subtitle: opts.subtitle || ''
        };
      } catch (e) {}
    }
    window.__utkForceSubscribe = true;
    await refreshSubscriptionGate();
  } catch (e) {}
}
try { window.showSubscriptionOverlay = showSubscriptionOverlay; } catch (e) {}

function hideSubscriptionOverlay(immediate = false) {
  try {
    try {
      if (typeof window.__utkCancelPaymentWait === 'function') window.__utkCancelPaymentWait();
    } catch (e) {}

    const ov = document.getElementById('subscription-overlay');
    if (!ov) return;

    ov.classList.remove('waiting', 'waiting-only', 'active', 'opening', 'closing');

    try {
      const ws = ov.querySelector('#waiting-only');
      if (ws) {
        ws.style.display = 'none';
        ws.style.removeProperty('visibility');
      }
    } catch (e) {}

    try {
      if (typeof window.__utkRestoreSubscriptionOverlayView === 'function') {
        window.__utkRestoreSubscriptionOverlayView('main');
      }
    } catch (e) {}

    const finishHide = () => {
      try {
        ov.style.display = 'none';
        ov.style.removeProperty('opacity');
        ov.style.removeProperty('pointer-events');
      } catch (e) {}
    };

    if (immediate) finishHide();
    else setTimeout(finishHide, 300);

    try { const payBtn = document.getElementById('subPayBtn'); if (payBtn) payBtn.textContent = SUB_PAY_LABEL; } catch (e) {}
  } catch (e) {}
}

function showAuthScreenAfterSignOut() {
  try { hideSubscriptionOverlay(true); } catch (e) {}

  const authModal = document.getElementById('auth-modal');
  const mainApp = document.querySelector('.app-container');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const verifyCodeForm = document.getElementById('verifyCodeForm');
  const loginError = document.getElementById('loginErrorMessage');
  const registerError = document.getElementById('registerErrorMessage');
  const codeErrorMessage = document.getElementById('codeErrorMessage');

  if (registerForm) registerForm.style.display = 'none';
  if (verifyCodeForm) verifyCodeForm.style.display = 'none';
  if (loginForm) loginForm.style.display = 'flex';
  setAuthHeader('login');
  if (loginError) loginError.textContent = '';
  if (registerError) registerError.textContent = '';
  if (codeErrorMessage) codeErrorMessage.textContent = '';

  if (mainApp) mainApp.style.display = 'none';
  if (authModal) {
    authModal.style.display = 'flex';
    authModal.style.removeProperty('z-index');
    authModal.classList.remove('hidden', 'closing');
  }

  document.body.classList.add('auth-visible');
  try { window.__utkWelcomeBackShown = false; } catch (e) {}
  try {
    if (window.musicVisualizer && typeof window.musicVisualizer.refresh === 'function') {
      window.musicVisualizer.refresh();
    }
  } catch (e) {}
}

// duplicate hideSubscriptionOverlay removed (consolidated above) 

// --- Real-time maintenance mode listener ---
// Listens to `config/maintenance` document for { enabled: boolean, message: string }
try {
  const maintenanceRef = doc(db, 'config', 'maintenance');
  let maintenanceState = null;
  let authInitialized = false; // wait until auth settles before showing overlay at startup

  // Smooth show/hide helper (fade + scale)
  const setOverlay = (enabled, message) => {
    const overlay = document.getElementById('maintenance-overlay');
    const msgEl = document.getElementById('maintenance-message');
    const titleEl = document.getElementById('maintenance-title');
    if (!overlay) return;
    if (msgEl) msgEl.textContent = message || 'App under construction';
    if (titleEl) titleEl.textContent = titleEl.textContent || 'App under construction';

    // Ensure overlay is top-most and interactive
    overlay.style.zIndex = String(2147483647);
    overlay.style.pointerEvents = enabled ? 'auto' : 'none';

    // Make sure text colors are explicit (prevent theme/parent overrides)
    try { if (titleEl) titleEl.style.color = '#ffffff'; if (msgEl) msgEl.style.color = '#ffffff'; } catch (e) {}

    overlay.style.transition = 'opacity 320ms ease, transform 320ms ease';

    const mainApp = document.querySelector('.app-container');

    // Remove any pending transition handlers to avoid stale callbacks
    try {
      if (overlay._maintenanceHandle) {
        overlay.removeEventListener('transitionend', overlay._maintenanceHandle);
        overlay._maintenanceHandle = null;
      }
    } catch (e) {}

    if (enabled) {
      // Hide main app to fully block access
      try { if (mainApp) mainApp.style.display = 'none'; } catch (e) {}

      // Force reflow/paint ordering then show overlay with fade+scale
      overlay.style.visibility = 'visible';
      overlay.style.display = 'flex';
      // Reset initial state
      overlay.style.opacity = '0';
      overlay.style.transform = 'scale(0.99)';
      document.body.classList.add('maintenance-mode');
      // Force a paint so animation isn't skipped
      void overlay.offsetWidth;
      requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        overlay.style.transform = 'scale(1)';
      });
    } else {
      // Hide overlay smoothly and reveal app
      overlay.style.opacity = '0';
      overlay.style.transform = 'scale(0.99)';
      document.body.classList.remove('maintenance-mode');

      const handle = () => {
        try { overlay.removeEventListener('transitionend', handle); } catch (e) {}
        overlay._maintenanceHandle = null;
        try { overlay.style.display = 'none'; overlay.style.visibility = 'hidden'; } catch (e) {}
        // Reveal main app when maintenance ends only if maintenance state is not enabled (avoid flash if re-enabled)
        try { if (!maintenanceState || !maintenanceState.enabled) { if (mainApp) mainApp.style.display = ''; } } catch (e) {}
      };
      overlay._maintenanceHandle = handle;
      overlay.addEventListener('transitionend', handle);
    }
  };

  const applyMaintenance = (data) => {
    maintenanceState = data;
    const enabled = data && !!data.enabled;
    const message = (data && data.message) || 'App under construction';

    const decide = async () => {
      // Defer until auth initialized to avoid popup at app startup
      if (!authInitialized) return;

      if (!enabled) {
        setOverlay(false, message);
        const ind = document.getElementById('maintenance-bypass-indicator');
        if (ind) ind.style.display = 'none';
        // Maintenance ended: restore any backed-up auto-trade settings for this user
        try {
          if (typeof window.restoreAllAutoTradesFromBackupForUser === 'function') {
            window.restoreAllAutoTradesFromBackupForUser();
          }
          // Hide admin debug UI
          const adminDebug = document.getElementById('maintenance-admin-debug');
          if (adminDebug) adminDebug.style.display = 'none';
        } catch (e) {}
        return;
      }

      // Local device bypass (set by admin on this machine)
      try {
        const bypass = (typeof localStorage !== 'undefined' && localStorage.getItem('maintenanceBypass') === '1');
        const ind = document.getElementById('maintenance-bypass-indicator');
        if (bypass) {
          if (ind) { ind.style.display = 'block'; ind.textContent = message ? 'Maintenance ON (hidden on this device)' : 'Maintenance hidden on this device'; }
          setOverlay(false, message);
          return;
        } else {
          if (ind) ind.style.display = 'none';
        }
      } catch (e) {
        // ignore localStorage errors
      }

      const user = auth.currentUser;
      if (!user) {
        // After auth initialized, show maintenance even for not-signed-in users
        setOverlay(true, message);
        return;
      }

      try {
        // Refresh token to get latest claims
        const t = await user.getIdTokenResult(true);
        const isAdmin = !!(t.claims && t.claims.admin);

        // Expose maintenance flags to renderer
        try { window.maintenanceActive = enabled; window.maintenanceMessage = message; } catch (e) {}

        if (isAdmin) {
          // Show admin debug controls even during maintenance
          try {
            const adminDebug = document.getElementById('maintenance-admin-debug');
            if (adminDebug) adminDebug.style.display = 'block';
            const adminCheckbox = document.getElementById('maintenance-admin-allow-autotrade');
            if (adminCheckbox) {
              adminCheckbox.checked = !!window.adminAutoTradeOverride;
              adminCheckbox.onchange = async (e) => {
                window.adminAutoTradeOverride = !!e.target.checked;
                if (window.adminAutoTradeOverride) {
                  try { if (typeof window.restoreAllAutoTradesFromBackupForUser === 'function') await window.restoreAllAutoTradesFromBackupForUser(); } catch (e2) {}
                } else {
                  try { if (typeof window.disableAllAutoTradesForUser === 'function') await window.disableAllAutoTradesForUser({ persist: true }); } catch (e2) {}
                }
              };
            }
          } catch (e) {}

          // Admins see the app (but have debug control available)
          setOverlay(false, message);
        } else {
          // For non-admins ensure overlay remains and force-disable auto-trades
          setOverlay(true, message);
          try { if (typeof window.disableAllAutoTradesForUser === 'function') window.disableAllAutoTradesForUser({ persist: true }); } catch (e) {}
          // Prevent accidental hide: do not auto-hide overlay anywhere else
        }
      } catch (err) {
        setOverlay(true, message);
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', decide, { once: true });
    } else {
      decide();
    }
  };

  // Start/stop maintenance listener on demand (do not subscribe at app startup)
  let unsubscribeMaintenance = null;
  function startMaintenanceListener() {
    if (unsubscribeMaintenance) return;
    unsubscribeMaintenance = onSnapshot(maintenanceRef, (snap) => {
      applyMaintenance(snap.exists() ? snap.data() : null);
    }, (err) => {
      // don't block app if rules deny access
      // console.warn('[Maintenance] snapshot error:', err);
    });
  }
  function stopMaintenanceListener() {
    if (!unsubscribeMaintenance) return;
    try { unsubscribeMaintenance(); } catch (e) {}
    unsubscribeMaintenance = null;
  }

  // Spinner helpers for maintenance verification
  window.showMaintenanceCheckSpinner = function() {
    try {
      const el = document.getElementById('maintenance-check-spinner');
      if (el) { el.style.display = 'flex'; el.classList.add('active'); }
    } catch (e) {}
  };
  window.hideMaintenanceCheckSpinner = function() {
    try {
      const el = document.getElementById('maintenance-check-spinner');
      if (el) { el.style.display = 'none'; el.classList.remove('active'); }
    } catch (e) {}
  };

  // Called by auth flow after successful login to decide whether to allow access
  window.postLoginMaintenanceCheck = async function() {
    try {
      const snap = await getDoc(doc(db, 'config', 'maintenance'));
      const data = snap.exists() ? snap.data() : null;
      const enabled = data && !!data.enabled;
      const message = (data && data.message) || '';

      // update local maintenanceState
      maintenanceState = data;

      if (!enabled) { setOverlay(false, message); return true; }

      try {
        const bypass = (typeof localStorage !== 'undefined' && localStorage.getItem('maintenanceBypass') === '1');
        if (bypass) { setOverlay(false, message); return true; }
      } catch (e) {}

      const user = auth.currentUser;
      if (!user) { setOverlay(true, message); return false; }

      const t = await user.getIdTokenResult(true);
      const isAdmin = !!(t.claims && t.claims.admin);
      if (isAdmin) { setOverlay(false, message); return true; }

      // Non-admin, block access
      setOverlay(true, message);
      return false;
    } catch (err) {
      // On error, be conservative: if we already know maintenance is enabled, keep overlay and block access.
      if (maintenanceState && maintenanceState.enabled) {
        try { setOverlay(true, (maintenanceState && maintenanceState.message) || 'App under construction'); } catch (e) {}
        return false;
      }
      // Unknown maintenance state: do not forcibly hide overlay. Allow access but avoid toggling overlay unexpectedly.
      return true;
    }
  };


  // Re-evaluate when auth state changes so admin gets immediate visibility of toggle effects
  let firstAuthEventSeen = false;
  auth.onAuthStateChanged(async (user) => {
    // mark auth initialized
    try { authInitialized = true; } catch (e) {}

    if (!firstAuthEventSeen) {
      firstAuthEventSeen = true;
      // Initial auth event: start listener only if user exists; otherwise keep overlay hidden to avoid startup flash
      if (user) {
        startMaintenanceListener();
        // Restore / cold start: claim single-session lock (or kick if phone already owns a live session)
        try {
          await acquirePresenceLock(user.uid, user.email || '');
        } catch (lockErr) {
          if (isActiveElsewhereError(lockErr)) {
            try {
              await forceLogout('This account is already active on another device.');
            } catch (e) {}
            return;
          }
        }
        try { await loadUserProfile(user); } catch (e) {}
        try { await showWelcomeBackNotification(user); } catch (e) {}
        scheduleSubscriptionGateRefresh(650);
        // If maintenance is currently enabled, apply immediately to avoid flashes during sign-in
        if (maintenanceState && maintenanceState.enabled) {
          applyMaintenance(maintenanceState);
        } else if (maintenanceState) {
          setTimeout(() => applyMaintenance(maintenanceState), 350);
        }
      } else {
        try { stopMaintenanceListener(); setOverlay(false, (maintenanceState && maintenanceState.message) || ''); } catch (e) {}
      }
      return;
    }

    // Subsequent auth events (e.g., sign-in or forced sign-out)
    if (user) {
      // user signed in: start listener and evaluate
      startMaintenanceListener();
      try { await loadUserProfile(user); } catch (e) {}
      try { await showWelcomeBackNotification(user); } catch (e) {}
      // Re-evaluate trial/subscription gate after every sign-in (covers logout → login)
      scheduleSubscriptionGateRefresh(650);
      // If maintenance is enabled, apply immediately to avoid UI flash
      if (maintenanceState && maintenanceState.enabled) {
        applyMaintenance(maintenanceState);
      } else if (maintenanceState) {
        setTimeout(() => applyMaintenance(maintenanceState), 350);
      }
    } else {
      // user signed out: always free the device lock so phone/PC can take over
      try { await releasePresenceLock(); } catch (e) {}
      // user signed out: stop listener, clear trial countdown, unsubscribe user doc, and show login
      try {
        stopMaintenanceListener();
        try { clearTrialCountdown(); } catch (e) {}
        try { if (userProfileUnsubscribe) { userProfileUnsubscribe(); userProfileUnsubscribe = null; } } catch (e) {}
        if (maintenanceState && maintenanceState.enabled) {
          applyMaintenance(maintenanceState);
        } else {
          setOverlay(false, (maintenanceState && maintenanceState.message) || '');
          try { showAuthScreenAfterSignOut(); } catch (e) {}
        }
      } catch (e) {}
    }
  });
} catch (e) {
  // console.warn('[Maintenance] init failed:', e);
}

try {
  if (typeof window !== 'undefined') {
    window.auth = auth;
    window.db = db;
  }
} catch (e) {}

module.exports = { auth, db, releasePresenceLock, acquirePresenceLock };
