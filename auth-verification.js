  // console.log('auth-verification.js loaded');
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } = require("firebase/auth");
const { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, query, orderBy, limit, onSnapshot, runTransaction } = require("firebase/firestore");
const { getDatabase, ref: dbRef, runTransaction: rtdbRunTransaction, onDisconnect, remove, onValue, set } = require("firebase/database");
const { ipcRenderer } = require('electron');

const firebaseConfig = {
    apiKey: "AIzaSyCQdYOL6Tng3GgpRtFEUE7uy3aypmh7cMU",
    authDomain: "utopiakingdom-c7d19.firebaseapp.com",
    projectId: "utopiakingdom-c7d19",
    storageBucket: "utopiakingdom-c7d19.appspot.com",
    messagingSenderId: "591024383099",
    appId: "1:591024383099:web:11229950759c753c722ede",
    measurementId: "G-KX1S4WPYPF"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// Use RTDB only if databaseURL is provided; otherwise rely on Firestore fallback
const hasRTDB = !!(firebaseConfig && firebaseConfig.databaseURL);
const rtdb = hasRTDB ? getDatabase(app) : null;

// --- Single-Session Enforcement (presence lock) ---
let sessionState = {
  uid: null,
  sessionId: null,
  deviceId: null,
  lockType: null, // 'rtdb' | 'firestore'
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

async function acquirePresenceLock(uid, email) {
  sessionState.uid = uid;
  sessionState.sessionId = generateSessionId();
  sessionState.deviceId = getOrCreateDeviceId(email);

  // Try Realtime Database transactional lock first (only if configured)
  if (rtdb) {
    const lockPath = `userPresence/${uid}`;
    const lockRef = dbRef(rtdb, lockPath);
    try {
    const trxResult = await rtdbRunTransaction(lockRef, (current) => {
        if (!current) {
          return {
            sessionId: sessionState.sessionId,
            deviceId: sessionState.deviceId,
            startedAt: Date.now(),
            lastActive: Date.now()
          };
        }
        // Allow same-device takeover to recover from crashes
        if (current.deviceId === sessionState.deviceId) {
          return {
            sessionId: sessionState.sessionId,
            deviceId: sessionState.deviceId,
            startedAt: current.startedAt || Date.now(),
            lastActive: Date.now()
          };
        }
        // Someone else holds lock
        return; // abort write
    }, { applyLocally: false });

      if (!trxResult.committed) {
        throw new Error('active_elsewhere');
      }

      // Ensure cleanup on disconnect
      try { onDisconnect(lockRef).remove(); } catch {}

      // Watch for external takeover
      if (sessionState.unsubscribeWatcher) { sessionState.unsubscribeWatcher(); sessionState.unsubscribeWatcher = null; }
      const unsubscribe = onValue(lockRef, (snap) => {
        const val = snap.val();
        if (!val) return; // removed due to disconnect
        if (val.sessionId && val.sessionId !== sessionState.sessionId && val.deviceId !== sessionState.deviceId) {
          forceLogout('Your account was signed in from another device.');
        }
      });
      sessionState.unsubscribeWatcher = () => unsubscribe();

      sessionState.lockType = 'rtdb';
      return true;
    } catch (err) {
      if (err && err.message === 'active_elsewhere') throw err;
      // console.warn('[Presence] RTDB lock unavailable, falling back to Firestore:', err?.message || err);
    }
  }

  // Firestore fallback: transactional lock with soft TTL + heartbeat
  const fsLockRef = doc(db, 'userSessions', uid);
  const now = Date.now();
  const ttlMs = 2 * 60 * 1000; // 2 minutes TTL
  try {
    const committed = await runTransaction(db, async (trx) => {
      const snap = await trx.get(fsLockRef);
      if (snap.exists()) {
        const data = snap.data();
        const age = now - (data.updatedAt || 0);
        // Allow same-device takeover, block different device within TTL
        if (data.sessionId && data.sessionId !== sessionState.sessionId && age < ttlMs && data.deviceId !== sessionState.deviceId) {
          throw new Error('active_elsewhere');
        }
      }
      const prevCreated = snap && snap.exists() ? (snap.data().createdAt || now) : now;
      trx.set(fsLockRef, {
        sessionId: sessionState.sessionId,
        deviceId: sessionState.deviceId,
        createdAt: prevCreated,
        updatedAt: now
      });
      return true;
    });
    if (!committed) throw new Error('lock_failed');

    // Heartbeat to keep lock fresh
    if (sessionState.heartbeatTimer) clearInterval(sessionState.heartbeatTimer);
    sessionState.heartbeatTimer = setInterval(async () => {
      try { await updateDoc(fsLockRef, { updatedAt: Date.now() }); } catch {}
    }, 30 * 1000);

    // Watch for external takeover
    if (sessionState.unsubscribeWatcher) { sessionState.unsubscribeWatcher(); sessionState.unsubscribeWatcher = null; }
    const unsubscribeFs = onSnapshot(fsLockRef, (snap) => {
      const data = snap.data();
      if (!data) return;
      if (data.sessionId && data.sessionId !== sessionState.sessionId) {
        forceLogout('Your account was signed in from another device.');
      }
    });
    sessionState.unsubscribeWatcher = unsubscribeFs;

    sessionState.lockType = 'firestore';
    return true;
  } catch (err) {
    if (err && err.message === 'active_elsewhere') throw err;
    // If security rules block this (PERMISSION_DENIED), don't block login; just disable single-session temporarily
    const msg = (err && (err.code || err.message || '')) + '';
    if (msg.includes('PERMISSION_DENIED') || msg.includes('permission-denied')) {
      // console.warn('[Presence] Firestore lock denied by rules. Continuing without single-session enforcement.');
      sessionState.lockType = 'disabled';
      return true;
    }
    // console.error('[Presence] Firestore lock failed:', err);
    // Continue without blocking login
    sessionState.lockType = 'disabled';
    return true;
  }
}

async function releasePresenceLock() {
  try {
    if (!sessionState.uid || !sessionState.sessionId) return;
    if (sessionState.unsubscribeWatcher) { try { sessionState.unsubscribeWatcher(); } catch {} sessionState.unsubscribeWatcher = null; }
    if (sessionState.heartbeatTimer) { clearInterval(sessionState.heartbeatTimer); sessionState.heartbeatTimer = null; }
    if (sessionState.lockType === 'rtdb') {
      const lockRef = dbRef(rtdb, `userPresence/${sessionState.uid}`);
      try { await remove(lockRef); } catch {}
    } else if (sessionState.lockType === 'firestore') {
      const fsLockRef = doc(db, 'userSessions', sessionState.uid);
      try {
        const snap = await getDoc(fsLockRef);
        const data = snap.data();
        if (data && data.sessionId === sessionState.sessionId) {
          await setDoc(fsLockRef, { sessionId: null, updatedAt: Date.now() }, { merge: true });
        }
      } catch {}
    }
  } finally {
    sessionState.uid = null;
    sessionState.sessionId = null;
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
    // fallback to alert if modal fails
    try { alert(reason || 'You have been signed out.'); } catch {}
  }

  // Show auth screen again
  const authModal = document.getElementById('auth-modal');
  const mainApp = document.querySelector('.app-container');
  if (mainApp) mainApp.style.display = 'none';
  if (authModal) authModal.style.display = 'flex';
  document.body.classList.add('auth-visible');
}

// Verification code storage
let verificationCodeData = {
  code: null,
  email: null,
  password: null,
  timestamp: null,
  mode: null, // 'register' or 'login'
  rememberMe: false
};

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
    const authTitle = document.getElementById('auth-title');
    if (authTitle) authTitle.textContent = 'Sign In';
    loginError.textContent = '';
    registerError.textContent = '';
    if (authModal) {
      authModal.style.display = 'flex';
      authModal.classList.remove('hidden', 'closing');
    }
    if (mainApp) mainApp.style.display = 'none';
    document.body.classList.add('auth-visible');
    if (window.musicVisualizer && typeof window.musicVisualizer.refresh === 'function') {
      window.musicVisualizer.refresh();
    }
  };

  document.body.classList.add('auth-visible');

  showRegister.onclick = (e) => {
    e.preventDefault();
    loginForm.style.display = 'none';
    verifyCodeForm.style.display = 'none';
    registerForm.style.display = 'flex';
    document.getElementById('auth-title').textContent = 'Register';
  };
  
  showLogin.onclick = (e) => {
    e.preventDefault();
    registerForm.style.display = 'none';
    verifyCodeForm.style.display = 'none';
    loginForm.style.display = 'flex';
    document.getElementById('auth-title').textContent = 'Sign In';
  };

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
          const msg = lockErr && lockErr.message === 'active_elsewhere'
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
          modalContainer.classList.remove('success');
          authModal.classList.remove('closing');

          if (allowed) {
            try { document.body.classList.remove('auth-visible'); } catch (e) {}
            if (mainApp) {
              mainApp.style.display = '';
              mainApp.classList.add('app-fade-in');
              setTimeout(() => mainApp.classList.remove('app-fade-in'), 420);
              // show subscription prompt after app entrance animation
              setTimeout(() => { try { showSubscriptionOverlay(); } catch (e) {} }, 480);
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
        rememberMe
      };

      await sendVerificationCodeEmail(email, verificationCode);

      // Show verification form for login
      loginForm.style.display = 'none';
      verifyCodeForm.style.display = 'flex';
      document.getElementById('auth-title').textContent = 'Verify Your Login';
      codeErrorMessage.textContent = '';
      codeErrorMessage.style.color = '#9aa0a6';
      codeErrorMessage.textContent = `Code sent to ${email}`;
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
  registerForm.onsubmit = async (e) => {
    e.preventDefault();
    registerError.textContent = '';
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    const password2 = document.getElementById('registerPassword2').value;
    const modalContainer = document.querySelector('.auth-modal-container');
    
    if (password !== password2) {
      registerError.textContent = 'Passwords do not match.';
      modalContainer.classList.add('error-glow');
      setTimeout(() => modalContainer.classList.remove('error-glow'), 400);
      return;
    }
    
    if (password.length < 6) {
      registerError.textContent = 'Password must be at least 6 characters.';
      modalContainer.classList.add('error-glow');
      setTimeout(() => modalContainer.classList.remove('error-glow'), 400);
      return;
    }
    
    try {
      // Generate 4-digit code
      const verificationCode = Math.floor(1000 + Math.random() * 9000).toString();
      
      // Store data
      verificationCodeData.code = verificationCode;
      verificationCodeData.email = email;
      verificationCodeData.password = password;
      verificationCodeData.timestamp = Date.now();
      verificationCodeData.mode = 'register';
      verificationCodeData.rememberMe = false;
      
      // Send code to email
      await sendVerificationCodeEmail(email, verificationCode);
      
      // Show verification form
      registerForm.style.display = 'none';
      verifyCodeForm.style.display = 'flex';
      document.getElementById('auth-title').textContent = 'Verify Your Email';
      codeErrorMessage.textContent = '';
      
      // Clear inputs
      document.getElementById('codeInput1').value = '';
      document.getElementById('codeInput2').value = '';
      document.getElementById('codeInput3').value = '';
      document.getElementById('codeInput4').value = '';
      document.getElementById('codeInput1').focus();
      
    } catch (err) {
      registerError.style.color = '#ff4444';
      registerError.textContent = err.message || 'Failed to send verification code. Try again.';
      modalContainer.classList.add('error-glow');
      setTimeout(() => modalContainer.classList.remove('error-glow'), 400);
    }
  };

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
    codeErrorMessage.textContent = '';
    
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
      codeErrorMessage.textContent = 'Code expired. Request a new one.';
      return;
    }
    
    // Verify code
    if (enteredCode !== verificationCodeData.code) {
      codeErrorMessage.textContent = '❌ Invalid code. Try again.';
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
          codeErrorMessage.textContent = lockErr && lockErr.message === 'active_elsewhere'
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
        verificationCodeData = { code: null, email: null, password: null, timestamp: null, mode: null, rememberMe: false };
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
          modalContainer.classList.remove('success');
          authModal.classList.remove('closing');

          if (allowed) {
            try { document.body.classList.remove('auth-visible'); } catch (e) {}
            if (mainApp) {
              mainApp.style.display = '';
              mainApp.classList.add('app-fade-in');
              setTimeout(() => mainApp.classList.remove('app-fade-in'), 420);
              // show subscription prompt after app entrance animation
              setTimeout(() => { try { showSubscriptionOverlay(); } catch (e) {} }, 480);
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
          codeErrorMessage.textContent = lockErr && lockErr.message === 'active_elsewhere'
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
        verificationCodeData = { code: null, email: null, password: null, timestamp: null, mode: null, rememberMe: false };
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
          modalContainer.classList.remove('success');
          authModal.classList.remove('closing');

          if (allowed) {
            try { document.body.classList.remove('auth-visible'); } catch (e) {}
            if (mainApp) {
              mainApp.style.display = '';
              mainApp.classList.add('app-fade-in');
              setTimeout(() => mainApp.classList.remove('app-fade-in'), 420);
              // show subscription prompt after app entrance animation
              setTimeout(() => { try { showSubscriptionOverlay(); } catch (e) {} }, 480);
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
      await sendVerificationCodeEmail(verificationCodeData.email, newCode);
      codeErrorMessage.style.color = '#00ff88';
      codeErrorMessage.textContent = '✅ New code sent to ' + verificationCodeData.email;
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
      document.getElementById('auth-title').textContent = 'Sign In';
    } else {
      registerForm.style.display = 'flex';
      document.getElementById('auth-title').textContent = 'Register';
    }
    verificationCodeData = { code: null, email: null, password: null, timestamp: null, mode: null, rememberMe: false };
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

  // Ensure lock cleanup on app close (best-effort; RTDB will remove via onDisconnect)
  window.addEventListener('beforeunload', async () => {
    try { await releasePresenceLock(); } catch {}
  });
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
  updatedAt: 0
};

function updateEntitlementCache(next) {
  try {
    entitlementCache = Object.assign({}, entitlementCache, next || {}, { updatedAt: Date.now() });
    try { window.__utkEntitlementCache = entitlementCache; } catch (e) {}
  } catch (e) {}
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

// If auth temporarily drops to signed-out, ensure subscribe overlay doesn't linger/flash.
try {
  if (!window.__utkSubOverlayAuthGuardAttached) {
    window.__utkSubOverlayAuthGuardAttached = true;
    if (auth && typeof auth.onAuthStateChanged === 'function') {
      auth.onAuthStateChanged((user) => {
        if (!user) {
          try { updateEntitlementCache({ paidActive: false, trialActive: false, subscriptionStatus: null }); } catch (e) {}
          try { hideSubscriptionOverlay(); } catch (e) {}
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
        try { if (canShowSubscriptionOverlayNow()) showSubscriptionOverlay(); } catch (e) {}
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
        if (subPill) subPill.textContent = 'Subscription ended';
        try { if (canShowSubscriptionOverlayNow()) showSubscriptionOverlay(); } catch (e) {}
        return;
      }

      // percent remaining (clamped)
      const pct = Math.max(0, Math.min(100, Math.round((rem / subtotalMs) * 100)));

      if (subCountdown) { subCountdown.textContent = ''; subCountdown.style.display = 'none'; }
      if (detailEl) { detailEl.style.display = 'block'; detailEl.style.color = 'rgba(255,255,255,0.65)'; detailEl.style.fontSize = '12px'; }
      if (detailText) { detailText.textContent = formatHMS(rem); }
      if (progressFill) { try { progressFill.style.width = pct + '%'; progressFill.style.background = 'rgba(0,0,0,0.28)'; } catch (e) {} }
      if (subPill) subPill.textContent = 'Subscribed';
    };

    clearTrialCountdown();
    if (subPill) subPill.textContent = 'Subscribed';
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
              paidActive: !!paidActive,
              trialActive: !!trialActive
            });
          } catch (e) {}

          // DEBUG: Log snapshot values to diagnose why Free trial may show instead of Subscribed
          try {
            console.debug('profile snapshot', { uid: (user && user.uid), subscriptionStatus: userData && userData.subscriptionStatus, paidUntilRaw: userData && userData.paidUntil, paidUntilMs: paidUntil, nowMs: now, trialExpiresAtRaw, trialExpiresAt, trialUsed });
          } catch (dbgE) { console.debug('profile snapshot debug failed', dbgE); }




          // Detect transition: previously active trial -> now expired (but never override active paid)
          try {
            if (prevTrialActive && !trialActive && !paidActive && canShowSubscriptionOverlayNow()) {
              try { showSubscriptionOverlay(); } catch (e) {}
            }
          } catch (e) {}

          // Update lastTrialExpiresAt
          lastTrialExpiresAt = trialExpiresAt || null;

          // If paid subscription active, show Subscribed and render countdown
          if (paidActive) {
            try { console.debug('profile: taking paid branch', { subscriptionStatus: userData && userData.subscriptionStatus, paidUntilRaw: userData && userData.paidUntil, paidUntilMs: paidUntil, nowMs: now }); } catch (dbgE) { console.debug('profile paid-branch debug failed', dbgE); }
            const subPill = document.getElementById('subscriptionPill'); if (subPill) subPill.textContent = 'Subscribed';
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
            const subPill = document.getElementById('subscriptionPill'); if (subPill) subPill.textContent = 'Trial used';
            clearTrialCountdown();
            return;
          }

          // Default: show free trial label (not active)
          try { console.debug('profile: default branch - showing Free trial', { subscriptionStatus: userData && userData.subscriptionStatus, paidUntilRaw: userData && userData.paidUntil, trialExpiresAtRaw }); } catch (dbgE) { console.debug('profile default-branch debug failed', dbgE); }
          const subPill = document.getElementById('subscriptionPill'); if (subPill) subPill.textContent = 'Free trial';
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
        if (subPill) subPill.textContent = (userData && userData.subscriptionStatus === 'active') ? 'Subscribed' : 'Free trial';
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

        // If paid subscription active, show Subscribed
        if ((paidUntil && paidUntil > now) || (userData && userData.subscriptionStatus === 'active')) {
          if (subPill) subPill.textContent = 'Subscribed';
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
      alert('Please choose an image under 200KB.');
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
        // console.error('Error saving avatar:', err);
        alert('Failed to save avatar. Please try again.');
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

// Subscription overlay helpers
function ensureSubscriptionOverlay() {
  if (document.getElementById('subscription-overlay')) return;
  try {
    const style = document.createElement('style');
    style.id = 'subscription-overlay-style';
    style.textContent = `
/* Pure black/white premium SaaS overlay with smooth transitions */
#subscription-overlay {
  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  z-index: 2147483646; pointer-events: none; opacity: 0; background: #000 !important;
  transition: opacity 420ms cubic-bezier(.4,1,.4,1), background-color 420ms cubic-bezier(.4,1,.4,1);
}
#subscription-overlay:not(.active) .sub-content {
  transform: translateY(32px) scale(0.97); opacity: 0;
}
#subscription-overlay.active {
  opacity: 1; pointer-events: auto; background: #000 !important;
}
#subscription-overlay.active .sub-content {
  transform: translateY(0) scale(1); opacity: 1;
  transition: transform 480ms cubic-bezier(.22,1,.36,1), opacity 380ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .decor {
  display: none;
}
#subscription-overlay .sub-content {
  color: #fff; text-align: center;
  transform: translateY(32px) scale(0.97); opacity: 0;
  transition: transform 480ms cubic-bezier(.22,1,.36,1), opacity 380ms cubic-bezier(.22,1,.36,1);
  max-width: 340px; padding: 22px 16px 18px 16px; border-radius: 14px;
  width: 100%;
  box-shadow: 0 8px 32px #000a, 0 0 40px 0 #fff2;
  background: #111;
  border: 1.5px solid #222;
  font-family: 'Inter', 'Segoe UI', 'Montserrat', 'Arial', sans-serif;
  position: relative;
  z-index: 2;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  will-change: transform, opacity;
}
#subscription-overlay.active .sub-content {
  transform: translateY(0) scale(1); opacity: 1;
}
#subscription-overlay h1 {
  font-size: 1.7rem; letter-spacing: 2.2px; margin: 0 0 6px 0; text-transform: uppercase;
  color: #fff; font-family: 'Inter', 'Montserrat', 'Segoe UI', 'Arial', sans-serif;
  font-weight: 900;
  letter-spacing: 3px;
  text-shadow: 0 2px 12px #0008;
  transition: text-shadow 320ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .sub-subtitle {
  font-size: 0.9rem; color: #bbb; margin-bottom: 16px; font-weight: 400; letter-spacing: 0.4px;
  transition: color 320ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .pay-card {
  margin: 8px auto 14px; padding: 14px 10px 12px 10px; border-radius: 10px;
  background: #181818;
  border: 1.5px solid #222;
  box-shadow: 0 2px 16px #0006;
  max-width: 300px;
  position: relative;
  transition: box-shadow 320ms cubic-bezier(.22,1,.36,1), background 320ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .pay-card .price {
  font-size: 1.25rem; font-weight: 800; color: #fff;
  display:flex; align-items:baseline; justify-content:center; gap:8px;
  margin-bottom: 6px;
  transition: color 320ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .pay-card .price .amount {
  font-size: 1.7rem; color: #fff;
  transition: color 320ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .pay-card .features {
  font-size: 0.82rem; color: #bbb; margin-top:6px; letter-spacing: 0.4px;
  transition: color 320ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .feature-list {
  margin: 18px 0 0 0; padding: 0; list-style: none; text-align: left;
  border-top: 1px solid #222;
  border-bottom: 1px solid #222;
}
#subscription-overlay .feature-list li {
  color: #fff; font-size: 0.95rem; font-weight: 500; margin: 0; padding: 12px 0 12px 0; position: relative;
  border-bottom: 1px solid #222;
  display: flex; align-items: center; gap: 12px;
  opacity: 0.92;
  transition: color 320ms cubic-bezier(.22,1,.36,1), opacity 320ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .feature-list li:last-child {
  border-bottom: none;
}
#subscription-overlay .feature-list .feature-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; margin-right: 2px;
  opacity: 0.8;
  transition: opacity 320ms cubic-bezier(.22,1,.36,1);
}
#subscription-overlay .feature-list .feature-icon svg {
  display: block;
}
#subscription-overlay .sub-buttons {
  display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 18px;
}
#subscription-overlay button {
  background: #fff; color: #111; border: none;
  padding: 9px 18px; border-radius: 7px; cursor: pointer; font-weight: 700;
  font-size: 0.95rem; font-family: 'Inter', 'Segoe UI', 'Montserrat', 'Arial', sans-serif;
  transition: background 220ms cubic-bezier(.22,1,.36,1), color 220ms cubic-bezier(.22,1,.36,1), transform 180ms cubic-bezier(.22,1,.36,1), box-shadow 220ms cubic-bezier(.22,1,.36,1);
  box-shadow: 0 2px 8px #0002;
  letter-spacing: 0.5px;
  outline: none;
}
#subscription-overlay button.secondary {
  background: #181818; color: #fff; border: 1.5px solid #444;
  box-shadow: none;
}
#subscription-overlay button:hover {
  background: #222; color: #fff;
  transform: scale(1.03) translateY(-1px);
  box-shadow: 0 6px 24px #0006;
}
#subscription-overlay button:active {
  background: #fff; color: #111;
  transform: scale(0.98);
  box-shadow: 0 2px 8px #0002;
}
#subscription-overlay .sub-message {
  margin-top: 12px; opacity: 0; transition: opacity 300ms cubic-bezier(.22,1,.36,1); color: #fff; font-weight:600; font-size: 0.9rem;
}
#subscription-overlay .waiting-only { color: #fff; font-size: 0.95rem; }
#subscription-overlay .waiting-only button { color: #fff; background: transparent; border: none; cursor: pointer; font-weight:700; }
#subscription-overlay .sub-message.spinner::after {
  content: ''; display:inline-block; width:12px; height:12px; border-radius:50%; border:2px solid #fff2; border-top-color: #fff; margin-left:8px; animation: sub-spin 900ms linear infinite; vertical-align:middle;
}
@keyframes sub-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
#subscription-overlay.waiting button { opacity: 0.6; pointer-events: none; }
#subscription-overlay.waiting-only .sub-content > :not(#waiting-only) { display: none !important; }
#subscription-overlay.waiting-only { background: #000 !important; pointer-events: auto; }
#subscription-overlay.waiting-only #waiting-only { display:flex !important; flex-direction:column; align-items:center; gap:12px; margin-top:8px; }
#subscription-overlay.waiting-only #waiting-only button { display:inline-block; margin-top:8px; background:transparent;border:none;padding:8px 12px;border-radius:8px;color:#fff;font-weight:700; cursor:pointer; }
`;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'subscription-overlay';
    overlay.innerHTML = `
      <div class="decor"></div>
      <div class="sub-content">
        <h1>SUBSCRIPTION</h1>
        <div class="sub-subtitle">Unlock premium features for traders</div>
        <div id="sub-main-section">
          <div class="pay-card">
            <div class="price"><span class="amount">$19.99</span><span class="period">/month</span></div>
            <div class="features">Monthly access • Cancel anytime</div>
            <ul class="feature-list">
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Auto Pocket Option Bot</li>
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Small delay</li>
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Daily updates</li>
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Advanced strategies</li>
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Overall stats & analytics</li>
            </ul>
          </div>
          <hr style="border: none; border-top: 1px solid #222; margin: 22px 0 14px 0;">
          <div class="sub-buttons" style="margin-top:auto;">
            <button id="subPayBtn" class="primary">Subscribe</button>
            <button id="subTrialBtn">1 hour trial</button>
            <button id="subLogoutBtn">Logout</button>
          </div>
        </div>
        <div id="sub-payment-section" style="display:none;">
          <div class="pay-card">
            <img src="https://cryptologos.cc/logos/bitcoin-btc-logo.png?v=026" alt="Crypto" style="height:26px;margin-bottom:8px;filter: grayscale(1) brightness(1.2);" />
            <div class="price"><span class="amount">$19.99</span><span class="period">/month</span></div>
            <div class="features">Pay securely with crypto (Coinbase)</div>
            <ul class="feature-list">
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Auto Pocket Option Bot</li>
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Small delay</li>
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Daily updates</li>
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Advanced strategies</li>
              <li><span class="feature-icon"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#fff" stroke-width="2" fill="#181818"/><path d="M6 11l3 3 5-5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Overall stats & analytics</li>
            </ul>
          </div>
          <div class="sub-buttons">
            <button id="subConfirmPayBtn" class="primary">Pay $19.99</button>
            <button id="subCancelBtn" class="secondary" style="margin-left:12px;">Cancel</button>
          </div>
        </div>
        <div id="subMessage" class="sub-message"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    try {
      const payBtn = document.getElementById('subPayBtn');
      const trialBtn = document.getElementById('subTrialBtn');
      const logoutBtn = document.getElementById('subLogoutBtn');
      const confirmPayBtn = document.getElementById('subConfirmPayBtn');
      const cancelBtn = document.getElementById('subCancelBtn');
      const subMessageEl = document.getElementById('subMessage');
      // Subscribe button: show payment section
      if (payBtn) {
        payBtn.addEventListener('click', () => {
          const mainSection = document.getElementById('sub-main-section');
          const paymentSection = document.getElementById('sub-payment-section');
          if (mainSection && paymentSection) {
            mainSection.style.transition = 'opacity 320ms cubic-bezier(.22,1,.36,1), transform 320ms cubic-bezier(.22,1,.36,1)';
            paymentSection.style.transition = 'opacity 320ms cubic-bezier(.22,1,.36,1), transform 320ms cubic-bezier(.22,1,.36,1)';
            mainSection.style.opacity = '1';
            mainSection.style.transform = 'scale(1)';
            paymentSection.style.opacity = '0';
            paymentSection.style.transform = 'scale(0.97)';
            // Animate out main section
            setTimeout(() => {
              mainSection.style.opacity = '0';
              mainSection.style.transform = 'scale(0.97)';
              setTimeout(() => {
                mainSection.style.display = 'none';
                paymentSection.style.display = '';
                // Animate in payment section
                setTimeout(() => {
                  paymentSection.style.opacity = '1';
                  paymentSection.style.transform = 'scale(1)';
                }, 20);
              }, 320);
            }, 20);
          }
          // Keep overlay column size stable (do not stretch full-height)
          const ov = document.getElementById('subscription-overlay');
          if (ov) ov.style.alignItems = '';
        });
      }
      // Pay button: triggers payment flow
      if (confirmPayBtn) {
        confirmPayBtn.addEventListener('click', async () => {
          try {
            console.log('[DEBUG] subConfirmPayBtn (Pay $19.99) clicked');
            if (!auth.currentUser) throw new Error('No user');

            // If already waiting and we have a URL, reopen it
            const ov = document.getElementById('subscription-overlay');
            if (ov && ov.classList.contains('waiting') && lastPaymentUrl) {
              try {
                await ipcRenderer.invoke('open-payment-window', { url: lastPaymentUrl }).catch(() => null);
                showSubMessage('Reopened payment window...');
              } catch (e) { console.error('Reopen failed', e); showSubMessage('Unable to reopen payment.'); }
              return;
            }

            // Small click/pop animation
            try { confirmPayBtn.classList.add('pop'); setTimeout(() => confirmPayBtn.classList.remove('pop'), 420); } catch (e) {}

            // If server gave us a static payment link, open it directly as a reliable fallback
            try {
              const ovEl = document.getElementById('subscription-overlay');
              const staticLink = ovEl && ovEl._staticPaymentLink ? ovEl._staticPaymentLink : null;
              if (staticLink) {
                lastPaymentUrl = staticLink;
                if (paymentOpenInProgress) { try { enterWaitingOnlyState(); } catch (e) {} try { waitForSubscriptionConfirmation(auth.currentUser.uid); } catch (e) {} try { showSubMessage('Continue in your browser — waiting for confirmation...', { persistent: true, spinner: true }); } catch (e) {} return; }
                paymentOpenInProgress = true;
                try { enterWaitingOnlyState(); } catch (e) {}
                try { console.debug('[payments] opening payment window (static):', lastPaymentUrl); } catch (e) {}
                try { await ipcRenderer.invoke('open-payment-window', { url: lastPaymentUrl }).catch(() => null); } catch (e) {}
                try { waitForSubscriptionConfirmation(auth.currentUser.uid); } catch (e) { console.error('waitForSubscriptionConfirmation failed', e); }
                try { if (confirmPayBtn) confirmPayBtn.textContent = 'Reopen payment'; } catch (e) {}
                try { showSubMessage('Continue in your browser — waiting for confirmation...', { persistent: true, spinner: true }); } catch (e) {}
                return;
              }
            } catch (e) {}

            // Get a fresh ID token and selected price id, then ask main to open Checkout
            try {
              const idToken = await auth.currentUser.getIdToken(/* forceRefresh */ true);
              // Create a per-user Coinbase charge for $19.99/month and open the hosted checkout immediately
              const chargeRes = await ipcRenderer.invoke('create-coinbase-charge', { idToken, amount: 19.99, currency: 'USD' }).catch((err) => ({ success: false, error: String(err) }));

              // Success from create-coinbase-charge -> open hosted checkout
              if (chargeRes && chargeRes.success && chargeRes.url) {
                lastPaymentUrl = chargeRes.url;
                if (paymentOpenInProgress) { try { enterWaitingOnlyState(); } catch (e) {} try { waitForSubscriptionConfirmation(auth.currentUser.uid); } catch (e) {} try { showSubMessage('Continue in your browser — waiting for confirmation...', { persistent: true, spinner: true }); } catch (e) {} return; }
                paymentOpenInProgress = true;
                try { enterWaitingOnlyState(); } catch (e) {}
                try { console.debug('[payments] opening payment window (charge):', lastPaymentUrl); } catch (e) {}
                try { await ipcRenderer.invoke('open-payment-window', { url: lastPaymentUrl }).catch(() => null); } catch (e) {}
                try { waitForSubscriptionConfirmation(auth.currentUser.uid); } catch (e) { console.error('waitForSubscriptionConfirmation failed', e); }
                return;
              }

              // Fallback to older open-subscription-payment or static crypto link
              console.error('create-coinbase-charge failed:', chargeRes);
              // Helpful message if server side isn't configured
              try {
                if (chargeRes && chargeRes.error && String(chargeRes.error).toLowerCase().includes('coinbase_api_key')) {
                  showSubMessage('Payments are not configured on the server. Please set COINBASE_API_KEY and restart the payments server.');
                }
              } catch (e) {}

              try {
                const res2 = await ipcRenderer.invoke('open-subscription-payment', { idToken, priceId: selectedPriceId }).catch(() => null);
                if (res2 && res2.success && res2.url) {
                  lastPaymentUrl = res2.url;
                  if (paymentOpenInProgress) { try { enterWaitingOnlyState(); } catch (e) {} try { waitForSubscriptionConfirmation(auth.currentUser.uid); } catch (e) {} try { showSubMessage('Continue in your browser — waiting for confirmation...', { persistent: true, spinner: true }); } catch (e) {} return; }
                  paymentOpenInProgress = true;
                  try { enterWaitingOnlyState(); } catch (e) {}
                  try { console.debug('[payments] opening payment window (legacy):', lastPaymentUrl); } catch (e) {}
                  try { await ipcRenderer.invoke('open-payment-window', { url: lastPaymentUrl }).catch(() => null); } catch (e) {}
                  try { waitForSubscriptionConfirmation(auth.currentUser.uid); } catch (e) { console.error('waitForSubscriptionConfirmation failed', e); }
                  try { if (confirmPayBtn) confirmPayBtn.textContent = 'Reopen payment'; } catch (e) {}
                  try { showSubMessage('Continue in your browser — waiting for confirmation...', { persistent: true, spinner: true }); } catch (e) {}
                  return; 
                }

                const pl = await ipcRenderer.invoke('get-crypto-payment-link').catch(() => null);
                const link = pl && pl.success && pl.url ? pl.url : (pl && pl.url ? pl.url : null);
                if (link && auth.currentUser && auth.currentUser.email) {
                  const url = link + (link.includes('?') ? '&' : '?') + 'prefilled_email=' + encodeURIComponent(auth.currentUser.email);
                  await ipcRenderer.invoke('open-payment-window', { url }).catch(() => null);
                  lastPaymentUrl = url;
                  try { enterWaitingOnlyState(); } catch (e) {}
                  try { waitForSubscriptionConfirmation(auth.currentUser.uid); } catch (e) { console.error('waitForSubscriptionConfirmation failed', e); }
                  try { if (confirmPayBtn) confirmPayBtn.textContent = 'Reopen payment'; } catch (e) {}
                  try { showSubMessage('Continue in your browser — waiting for confirmation...', { persistent: true, spinner: true }); } catch (e) {}
                  return; 
                }

              } catch (e) {
                console.error('Payment fallback failed:', e);
                showSubMessage('Payment failed to open: ' + (chargeRes && chargeRes.error ? chargeRes.error : 'Unknown error'));
              }

              const detail = chargeRes && chargeRes.error ? chargeRes.error : 'Unknown error';
              showSubMessage('Payment failed: ' + detail + '. Crypto payment link not configured.');

            } catch (err) {
              console.error('Failed to get ID token for payment:', err);
              showSubMessage('Payment not available.');
            }
          } catch (e) {
            console.warn('Payment handler failed:', e);
            showSubMessage('Payment not available.');
          }
        });

        // Listen for payment window close to re-enable Pay button and reset UI
        ipcRenderer.on('payment-window-closed', () => {
          try {
            paymentOpenInProgress = false;
            // Remove waiting classes from overlay
            const ov = document.getElementById('subscription-overlay');
            if (ov) {
              ov.classList.remove('waiting');
              ov.classList.remove('waiting-only');
            }
            // Enable all relevant buttons
            if (confirmPayBtn) {
              confirmPayBtn.disabled = false;
              confirmPayBtn.textContent = 'Pay $19.99';
            }
            const cancelBtn = document.getElementById('subCancelBtn');
            if (cancelBtn) cancelBtn.disabled = false;
            const trialBtn = document.getElementById('subTrialBtn');
            if (trialBtn) trialBtn.disabled = false;
            const logoutBtn = document.getElementById('subLogoutBtn');
            if (logoutBtn) logoutBtn.disabled = false;
            // Exit waiting state if present
            try { exitWaitingOnlyState && exitWaitingOnlyState(); } catch (e) {}
            // Show payment section again so user can retry
            try {
              document.getElementById('sub-main-section').style.display = 'none';
              document.getElementById('sub-payment-section').style.display = '';
            } catch (e) {}
            showSubMessage('Payment window closed. You can try again.');
          } catch (e) {}
        });
      }
      // Cancel button: return to main section
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          // If we were waiting on payment confirmation, fully reset state so Subscribe works again.
          try { cancelWaitForConfirmation(); } catch (e) {}

          const mainSection = document.getElementById('sub-main-section');
          const paymentSection = document.getElementById('sub-payment-section');
          if (mainSection && paymentSection) {
            paymentSection.style.transition = 'opacity 320ms cubic-bezier(.22,1,.36,1), transform 320ms cubic-bezier(.22,1,.36,1)';
            mainSection.style.transition = 'opacity 320ms cubic-bezier(.22,1,.36,1), transform 320ms cubic-bezier(.22,1,.36,1)';
            paymentSection.style.opacity = '1';
            paymentSection.style.transform = 'scale(1)';
            mainSection.style.opacity = '0';
            mainSection.style.transform = 'scale(0.97)';
            // Animate out payment section
            setTimeout(() => {
              paymentSection.style.opacity = '0';
              paymentSection.style.transform = 'scale(0.97)';
              setTimeout(() => {
                paymentSection.style.display = 'none';
                mainSection.style.display = '';
                // Animate in main section
                setTimeout(() => {
                  mainSection.style.opacity = '1';
                  mainSection.style.transform = 'scale(1)';
                }, 20);
              }, 320);
            }, 20);
            // Restore overlay alignment to default (center)
            const ov = document.getElementById('subscription-overlay');
            if (ov) ov.style.alignItems = '';
          } else {
            // fallback
            document.getElementById('sub-main-section').style.display = '';
            document.getElementById('sub-payment-section').style.display = 'none';
            const ov = document.getElementById('subscription-overlay');
            if (ov) ov.style.alignItems = '';
          }
        });
      }

      // Simulate button (dev) - call server to mark user as paid


      let countdownTimer = null;
      const clearCountdown = () => { try { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } } catch (e) {} };

      // Waiting-for-confirmation state
      let waitingListenerUnsub = null;
      let waitingTimeout = null;
      let lastPaymentUrl = null; // remember last opened checkout URL so user can re-open if needed
      // Prevent duplicate opens while a payment window is already being opened
      let paymentOpenInProgress = false;
      function cancelWaitForConfirmation() {
        try { if (waitingListenerUnsub) { try { waitingListenerUnsub(); } catch (e) {} waitingListenerUnsub = null; } } catch (e) {}
        try { if (waitingTimeout) { clearTimeout(waitingTimeout); waitingTimeout = null; } } catch (e) {}
        try { if (shortWaitTimeout) { clearTimeout(shortWaitTimeout); shortWaitTimeout = null; } } catch (e) {}
        try { const ov = document.getElementById('subscription-overlay'); if (ov) { ov.classList.remove('waiting'); ov.classList.remove('waiting-only'); } } catch (e) {}
        try { const el = document.getElementById('subMessage'); if (el) { el.classList.remove('spinner'); el.style.opacity = '0'; } } catch (e) {}
        try { lastPaymentUrl = null; } catch (e) {}
        try { paymentOpenInProgress = false; } catch (e) {}
        try { if (payBtn) payBtn.textContent = 'Subscribe'; } catch (e) {}
        try { if (payBtn) payBtn.disabled = false; } catch (e) {}
        try { if (trialBtn) trialBtn.disabled = false; } catch (e) {}
        try { if (logoutBtn) logoutBtn.disabled = false; } catch (e) {}
        try { if (confirmPayBtn) { confirmPayBtn.disabled = false; confirmPayBtn.textContent = 'Pay $19.99'; } } catch (e) {}
        try { const cb = document.getElementById('subCancelBtn'); if (cb) cb.disabled = false; } catch (e) {}
        try { exitWaitingOnlyState(); } catch (e) {}
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
          cancelWaitForConfirmation();
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
              try { if (payBtn) { payBtn.disabled = false; payBtn.textContent = 'Subscribe'; } if (trialBtn) { trialBtn.disabled = false; trialBtn.textContent = '1 hour trial'; } if (logoutBtn) logoutBtn.disabled = false; } catch (e) {}
            } catch (e) {}
          }, timeoutMs);

          // NOTE: removed the short hint that suggested reopening the link or clicking "I completed payment" —
          // we keep the UI minimal while waiting and revert on timeout or cancel.
          

          // Add waiting UI state and disable buttons
          try { const ov = document.getElementById('subscription-overlay'); if (ov) ov.classList.add('waiting'); if (payBtn) payBtn.disabled = true; if (trialBtn) trialBtn.disabled = true; if (logoutBtn) logoutBtn.disabled = true; showSubMessage('Waiting for payment confirmation...', { persistent: true, spinner: true }); } catch (e) {}
        } catch (e) {}
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
      // Helper to toggle waiting-only UI
      function enterWaitingOnlyState() {
        try {
          const ov = document.getElementById('subscription-overlay');
          if (!ov) return;
          // Ensure overlay visible and interactive
          try { ov.classList.add('active'); ov.style.pointerEvents = 'auto'; ov.style.opacity = '1'; } catch (e) {}

          // store previous styles so we can restore them
          ov._waitingHidden = ov._waitingHidden || [];

          // hide everything inside .sub-content except the #waiting-only block (force with !important)
          const content = ov.querySelector('.sub-content');
          if (content) {
            Array.from(content.children).forEach((child) => {
              try {
                if (child && child.id === 'waiting-only') {
                  console.log('[DEBUG] Showing waiting-only block');
                  child.style.setProperty('display', 'flex', 'important');
                  child.style.flexDirection = 'column';
                  child.style.alignItems = 'center';
                  child.style.gap = '12px';
                  child.style.zIndex = '9999';
                  child.style.visibility = 'visible';
                  // Show cancel button row always in waiting state
                  const cancelRow = document.getElementById('cancel-payment-row');
                  if (cancelRow) {
                    cancelRow.style.display = 'block';
                  }
                  // Hide all siblings
                  Array.from(content.children).forEach((sib) => {
                    if (sib !== child) {
                      sib.style.setProperty('display', 'none', 'important');
                      sib.style.setProperty('visibility', 'hidden', 'important');
                    }
                  });
                  return;
                }
                // Hide all other blocks (including trial ended, subscribe, etc)
                const prev = child.style.getPropertyValue('display') || '';
                ov._waitingHidden.push({ el: child, prev });
                child.style.setProperty('display', 'none', 'important');
              } catch (e) {}
            });
          }

          // Mark waiting and show message (add waiting-only class to force-hide everything else)
          try { ov.classList.add('waiting'); ov.classList.add('waiting-only'); } catch (e) {}
          try { console.log('[payments] enterWaitingOnlyState'); } catch (e) {}
          try { showSubMessage('Continue in your browser — waiting for confirmation...', { persistent: true, spinner: true }); } catch (e) {}

          // Ensure Cancel button exists and works (create if missing)
          try {
            let cancelBtn = document.getElementById('subCancelBtn');
            const waitingBlock = document.getElementById('waiting-only');
            if (waitingBlock && !cancelBtn) {
              try {
                cancelBtn = document.createElement('button');
                cancelBtn.id = 'subCancelBtn';
                cancelBtn.textContent = 'Cancel payment';
                cancelBtn.style.background = 'transparent';
                cancelBtn.style.border = '1px solid #ffd27a';
                cancelBtn.style.padding = '8px 12px';
                cancelBtn.style.borderRadius = '8px';
                cancelBtn.style.color = '#ffd27a';
                cancelBtn.style.fontWeight = '700';
                cancelBtn.style.cursor = 'pointer';
                try { waitingBlock.appendChild(cancelBtn); } catch (e) {}
              } catch (e) {}
            }

            if (cancelBtn) {
              try { cancelBtn.style.display = 'inline-block'; } catch (e) {}
              // Remove any previous listener then attach fresh
              try { cancelBtn.replaceWith(cancelBtn.cloneNode(true)); } catch (e) {}
              try {
                const nb = document.getElementById('subCancelBtn');
                if (nb) nb.addEventListener('click', async () => {
                  try { console.log('[payments] Cancel clicked'); } catch (e) {}
                  try { cancelWaitForConfirmation(); } catch (e) {}
                  try { paymentOpenInProgress = false; } catch (e) {}
                  try { exitWaitingOnlyState(); } catch (e) {}
                  try { showSubMessage('Payment cancelled'); } catch (e) {}
                });
              } catch(e) {}
            }
          } catch (e) {}
        } catch (e) {}
      }

      function exitWaitingOnlyState() {
        try {
          const ov = document.getElementById('subscription-overlay'); if (!ov) return;
          // restore previously hidden elements
          try {
            if (ov._waitingHidden && Array.isArray(ov._waitingHidden)) {
              ov._waitingHidden.forEach((rec) => {
                try {
                  if (rec && rec.el) {
                    try { rec.el.style.removeProperty('display'); } catch (e) {}
                    try { if (rec.prev && rec.prev !== '') rec.el.style.setProperty('display', rec.prev); } catch (e) {}
                  }
                } catch (e) {}
              });
            }
            ov._waitingHidden = [];
            // Hide cancel button row when not waiting
            const cancelRow = document.getElementById('cancel-payment-row');
            if (cancelRow) cancelRow.style.display = 'none';
          } catch (e) {}

          // hide waiting block
          try { const ws = ov.querySelector('#waiting-only'); if (ws) ws.style.display = 'none'; } catch (e) {}

          try { ov.classList.remove('waiting'); ov.classList.remove('waiting-only'); } catch (e) {}
          try { console.log('[payments] exitWaitingOnlyState'); } catch (e) {}
          try { showSubMessage(''); } catch (e) {}
        } catch (e) {}
      }
          const res = await ipcRenderer.invoke('fetch-allowed-prices').catch(() => null);
          if (!res || !res.success || !Array.isArray(res.prices) || res.prices.length === 0) {
            // Fallback to a single default price. Use hardcoded price id if available for quick testing.
            const FALLBACK_PRICE_ID = 'price_1SuKpdQjiGVziimZ8JLiULXt';
            if (planSelectorEl) planSelectorEl.innerHTML = `<div class="plan-card selected" data-price="${FALLBACK_PRICE_ID}">Monthly</div>`;
            selectedPriceId = FALLBACK_PRICE_ID;
            if (payBtn) payBtn.textContent = 'Subscribe — $19.99 / month';
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
              if (payBtn) payBtn.textContent = `Subscribe — ${p.unit_amount ? '$' + (p.unit_amount/100).toFixed(2) : ''} ${p.interval || ''}`.trim();
            });
            if (planSelectorEl) planSelectorEl.appendChild(el);
            if (idx === 0) selectedPriceId = p.id;
            if (idx === 0 && payBtn) payBtn.textContent = `Subscribe — ${p.unit_amount ? '$' + (p.unit_amount/100).toFixed(2) : ''} ${p.interval || ''}`.trim();
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
              paidActive: !!paidActive,
              trialActive: !!trialActive
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
          console.log('[DEBUG] enterWaitingOnlyState called');
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

      if (logoutBtn) logoutBtn.addEventListener('click', async () => {
        let originalText = logoutBtn.textContent;
        try {
          logoutBtn.disabled = true;
          logoutBtn.textContent = 'Logging out...';
          try { cancelWaitForConfirmation(); } catch (e) {}
          try { await releasePresenceLock(); } catch (e) {}
          try { await signOut(auth); } catch (e) {}
          try { hideSubscriptionOverlay(); } catch (e) {}
          try {
            const authModal = document.getElementById('auth-modal');
            const mainApp = document.querySelector('.app-container');
            if (mainApp) mainApp.style.display = 'none';
            if (authModal) { authModal.style.display = 'flex'; authModal.classList.remove('hidden'); document.body.classList.add('auth-visible'); }
          } catch (e) {}
        } finally {
          try { logoutBtn.disabled = false; logoutBtn.textContent = originalText; } catch (e) {}
        }
      });

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

async function showSubscriptionOverlay() {
  try {
    if (!canShowSubscriptionOverlayNow()) return;
    ensureSubscriptionOverlay();
    const ov = document.getElementById('subscription-overlay');
    const content = ov ? ov.querySelector('.sub-content') : null;
    if (ov && typeof ov._updateSubscriptionUI === 'function') {
      try {
        const allowed = await ov._updateSubscriptionUI();
        if (!allowed) return;
      } catch (e) {}
    }
    if (ov) {
      ov.classList.remove('closing');
      ov.classList.add('active', 'opening');
      // small entrance flourish
      try { if (content) { content.classList.add('pulse'); setTimeout(() => { try { content.classList.remove('pulse'); } catch (e) {} }, 520); } } catch (e) {}

      // reveal pay card and animate pay button
      try {
        const payCard = ov.querySelector('.pay-card');
        const payBtn = document.getElementById('subPayBtn');
        if (payCard) { payCard.style.transform = 'translateY(8px)'; payCard.style.opacity = '0'; setTimeout(() => { try { payCard.style.transition = 'transform 420ms cubic-bezier(.2,.9,.2,1), opacity 360ms ease'; payCard.style.transform = 'translateY(0)'; payCard.style.opacity = '1'; } catch (e) {} }, 80); }
        if (payBtn) { setTimeout(() => { try { payBtn.classList.add('pop'); setTimeout(() => { try { payBtn.classList.remove('pop'); } catch (e) {} }, 480); } catch (e) {} }, 260); }
      } catch (e) {}

      // remove opening after animation
      setTimeout(() => { try { ov.classList.remove('opening'); } catch (e) {} }, 520);
    }
  } catch (e) {}
}

function hideSubscriptionOverlay() {
  try {
    // Ensure any pending payment listeners/timeouts are cancelled
    try { cancelWaitForConfirmation(); } catch (e) {}
    const ov = document.getElementById('subscription-overlay');
    if (!ov) return;
    ov.classList.add('closing');
    ov.classList.remove('opening');
    setTimeout(() => {
      try { ov.classList.remove('active', 'closing'); } catch (e) {}
    }, 420);
    try { const payBtn = document.getElementById('subPayBtn'); if (payBtn) payBtn.textContent = 'Subscribe'; } catch (e) {}
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
  auth.onAuthStateChanged((user) => {
    // mark auth initialized
    try { authInitialized = true; } catch (e) {}

    if (!firstAuthEventSeen) {
      firstAuthEventSeen = true;
      // Initial auth event: start listener only if user exists; otherwise keep overlay hidden to avoid startup flash
      if (user) {
        startMaintenanceListener();
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
      // If maintenance is enabled, apply immediately to avoid UI flash
      if (maintenanceState && maintenanceState.enabled) {
        applyMaintenance(maintenanceState);
      } else if (maintenanceState) {
        setTimeout(() => applyMaintenance(maintenanceState), 350);
      }
    } else {
      // user signed out: stop listener, clear trial countdown, unsubscribe user doc, and show maintenance if enabled for unauthenticated users
      try {
        stopMaintenanceListener();
        try { clearTrialCountdown(); } catch (e) {}
        try { if (userProfileUnsubscribe) { userProfileUnsubscribe(); userProfileUnsubscribe = null; } } catch (e) {}
        if (maintenanceState && maintenanceState.enabled) {
          applyMaintenance(maintenanceState);
        } else {
          setOverlay(false, (maintenanceState && maintenanceState.message) || '');
        }
      } catch (e) {}
    }
  });
} catch (e) {
  // console.warn('[Maintenance] init failed:', e);
}

module.exports = { auth, db };
