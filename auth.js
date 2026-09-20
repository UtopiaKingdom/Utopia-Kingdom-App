console.log('auth.js loaded');

// TLS verification is secure by default.
// If you must bypass TLS verification (NOT recommended), set `UTK_INSECURE_TLS=1`.
if (typeof process !== 'undefined' && process.env && process.env.UTK_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendEmailVerification } = require("firebase/auth");
const { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, query, orderBy, limit, onSnapshot } = require("firebase/firestore");

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

function setupAuth() {
  const authModal = document.getElementById('auth-modal');
  const mainApp = document.querySelector('.app-container');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const showRegister = document.getElementById('showRegister');
  const showLogin = document.getElementById('showLogin');
  const loginError = document.getElementById('loginErrorMessage');
  const registerError = document.getElementById('registerErrorMessage');
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
    // Refresh visualizer so waves return after logout
    if (window.musicVisualizer && typeof window.musicVisualizer.refresh === 'function') {
      window.musicVisualizer.refresh();
    }
  };

  // Mark auth visible so titlebar-left hides
  document.body.classList.add('auth-visible');

  showRegister.onclick = (e) => {
    e.preventDefault();
    loginForm.style.display = 'none';
    registerForm.style.display = 'flex';
    document.getElementById('auth-title').textContent = 'Register';
  };
  showLogin.onclick = (e) => {
    e.preventDefault();
    registerForm.style.display = 'none';
    loginForm.style.display = 'flex';
    document.getElementById('auth-title').textContent = 'Sign In';
  };

  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const rememberMe = rememberMeCheckbox ? rememberMeCheckbox.checked : false;
    const modalContainer = document.querySelector('.auth-modal-container');
    console.log('Attempting login with:', email);
    try {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      console.log('Login success!');
      
      // Check email verification if "remember me" is NOT checked
      if (!rememberMe && !userCredential.user.emailVerified) {
        await signOut(auth); // Sign them out
        modalContainer.classList.add('error-glow');
        loginError.innerHTML = 'Please verify your email address. <a href="#" id="resendVerificationLogin" style="color: #00d4ff; text-decoration: underline;">Resend verification email</a>';
        
        // Add resend handler
        setTimeout(() => {
          const resendLink = document.getElementById('resendVerificationLogin');
          if (resendLink) {
            resendLink.onclick = async (e) => {
              e.preventDefault();
              try {
                // Sign in temporarily to send verification
                const tempCred = await signInWithEmailAndPassword(auth, email, password);
                await sendEmailVerification(tempCred.user);
                await signOut(auth);
                loginError.textContent = 'Verification email sent! Please check your inbox.';
                modalContainer.classList.remove('error-glow');
                modalContainer.classList.add('success');
                setTimeout(() => modalContainer.classList.remove('success'), 3000);
              } catch (err) {
                loginError.textContent = 'Failed to send verification email. Try again later.';
              }
            };
          }
        }, 100);
        return;
      }
      
      // Save or clear credentials based on remember me checkbox
      if (rememberMe) {
        localStorage.setItem('savedEmail', email);
        localStorage.setItem('savedPassword', password);
      } else {
        localStorage.removeItem('savedEmail');
        localStorage.removeItem('savedPassword');
      }
      
      // Load user profile from Firestore
      await loadUserProfile(auth.currentUser);
      
      // Animate modal out (content scale + overlay fade)
      modalContainer.classList.remove('error-glow');
      modalContainer.classList.add('success');
      authModal.classList.add('closing');
      setTimeout(async () => {
        // Do not hide auth modal until maintenance check completes to avoid UI flashes
        let allowed = true;
        try {
          if (typeof window.showMaintenanceCheckSpinner === 'function') window.showMaintenanceCheckSpinner();
          if (typeof window.postLoginMaintenanceCheck === 'function') {
            allowed = await window.postLoginMaintenanceCheck();
          }
        } catch (e) { allowed = true; }
        finally { if (typeof window.hideMaintenanceCheckSpinner === 'function') window.hideMaintenanceCheckSpinner(); }
        authModal.classList.remove('closing');

        if (allowed) {
          try { document.body.classList.remove('auth-visible'); } catch (e) {}
          if (mainApp) {
            mainApp.style.display = '';
            mainApp.classList.add('app-fade-in');
            setTimeout(() => mainApp.classList.remove('app-fade-in'), 420);
          }
        } else {
          // maintenance active: ensure overlay is visible before removing auth-visible
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
    } catch (err) {
      console.error('Login error:', err);
      modalContainer.classList.remove('success');
      modalContainer.classList.add('error-glow');
      
      // Handle certificate-related errors
      if (err.message && (err.message.includes('certificate') || err.message.includes('CERT') || err.message.includes('ssl') || err.message.includes('SSL'))) {
        loginError.textContent = 'Network security issue. Please check your internet connection and try again. If this persists, try disabling VPN/proxy.';
      } else if (err.code === 'auth/wrong-password') {
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
    }
  };

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
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      
      // Send email verification
      await sendEmailVerification(userCredential.user);
      
      // Create user profile document in Firestore
      const userDoc = doc(db, 'users', userCredential.user.uid);
      await setDoc(userDoc, {
        username: email.split('@')[0], // Default username from email
        email: email,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        emailVerified: false
      });
      
      // Sign out user and show verification message
      await signOut(auth);
      
      // Show success message
      modalContainer.classList.remove('error-glow');
      modalContainer.classList.add('success');
      registerError.style.color = '#00ff88';
      registerError.innerHTML = '✅ Registration successful! Please check your email to verify your account. <a href="#" id="resendVerificationRegister" style="color: #00d4ff; text-decoration: underline;">Resend email</a>';
      
      // Add resend handler
      setTimeout(() => {
        const resendLink = document.getElementById('resendVerificationRegister');
        if (resendLink) {
          resendLink.onclick = async (e) => {
            e.preventDefault();
            try {
              // Sign in temporarily to send verification
              const tempCred = await signInWithEmailAndPassword(auth, email, password);
              await sendEmailVerification(tempCred.user);
              await signOut(auth);
              registerError.textContent = '✅ Verification email sent! Check your inbox.';
            } catch (err) {
              registerError.style.color = '#ff4444';
              registerError.textContent = 'Failed to send email. Try again later.';
            }
          };
        }
      }, 100);
      
      // Switch to login form after delay
      setTimeout(() => {
        registerError.textContent = '';
        registerError.style.color = '';
        modalContainer.classList.remove('success');
        registerForm.style.display = 'none';
        loginForm.style.display = 'flex';
        document.getElementById('auth-title').textContent = 'Sign In';
      }, 8000);
    } catch (err) {
      registerError.style.color = '#ff4444';
      
      // Handle certificate-related errors
      if (err.message && (err.message.includes('certificate') || err.message.includes('CERT') || err.message.includes('ssl') || err.message.includes('SSL'))) {
        registerError.textContent = 'Network security issue. Please check your internet connection and try again. If this persists, try disabling VPN/proxy.';
      } else if (err.code === 'auth/email-already-in-use') {
        registerError.textContent = 'Email already registered. Please sign in.';
      } else if (err.code === 'auth/weak-password') {
        registerError.textContent = 'Password is too weak. Use at least 6 characters.';
      } else if (err.code === 'auth/invalid-email') {
        registerError.textContent = 'Invalid email address.';
      } else {
        registerError.textContent = 'Registration failed: ' + (err.message || 'Unknown error');
      }
      modalContainer.classList.add('error-glow');
      setTimeout(() => modalContainer.classList.remove('error-glow'), 400);
    }
  };

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      
      // Show custom logout modal
      const logoutModal = document.getElementById('logout-modal');
      const confirmBtn = document.getElementById('confirmLogout');
      const cancelBtn = document.getElementById('cancelLogout');
      
      logoutModal.classList.add('active');
      
      // Handle cancel
      const handleCancel = () => {
        logoutModal.classList.add('closing');
        setTimeout(() => {
          logoutModal.classList.remove('active', 'closing');
        }, 250);
        confirmBtn.removeEventListener('click', handleConfirm);
        cancelBtn.removeEventListener('click', handleCancel);
      };
      
      // Handle confirm
      const handleConfirm = async () => {
        logoutModal.classList.add('closing');
        setTimeout(() => {
          logoutModal.classList.remove('active', 'closing');
        }, 250);
        
        logoutBtn.disabled = true;
        const original = logoutBtn.textContent;
        logoutBtn.textContent = 'Logging out...';
        try {
          await signOut(auth);
          showAuthScreen();
        } catch (err) {
          console.error('Logout failed:', err);
        } finally {
          logoutBtn.disabled = false;
          logoutBtn.textContent = original;
        }
        
        confirmBtn.removeEventListener('click', handleConfirm);
        cancelBtn.removeEventListener('click', handleCancel);
      };
      
      confirmBtn.addEventListener('click', handleConfirm);
      cancelBtn.addEventListener('click', handleCancel);
      
      // Close on background click
      logoutModal.addEventListener('click', (e) => {
        if (e.target === logoutModal) {
          handleCancel();
        }
      }, { once: true });
    });
  }
  
  // Remove error glow on input focus
  [loginForm, registerForm].forEach(form => {
    form.querySelectorAll('input').forEach(input => {
      input.addEventListener('focus', () => {
        const modalContainer = document.querySelector('.auth-modal-container');
        modalContainer.classList.remove('error-glow');
      });
    });
  });

  // Hide main app until login
  if (mainApp) mainApp.style.display = 'none';
  
  // Setup username editing
  setupUsernameEditor();
  
  // Setup avatar upload
  setupAvatarUpload();
}

// Load user profile from Firestore
async function loadUserProfile(user) {
  if (!user) return;
  
  try {
    const userDoc = doc(db, 'users', user.uid);
    const docSnap = await getDoc(userDoc);
    
    if (docSnap.exists()) {
      const data = docSnap.data();
      
      // Update profile display
      const displayUsername = document.getElementById('displayUsername');
      const displayEmail = document.getElementById('displayEmail');
      const profileAvatar = document.getElementById('profileAvatar');
      const avatarSpan = profileAvatar ? profileAvatar.querySelector('span') : null;
      const sidebarName = document.getElementById('sidebarUsername');
      const sidebarAvatar = document.getElementById('sidebarAvatar');
      const sidebarSpan = sidebarAvatar ? sidebarAvatar.querySelector('span') : null;
      const memberSince = document.getElementById('memberSince');
      const lastLogin = document.getElementById('lastLogin');
      
      const usernameValue = data.username || user.email.split('@')[0];
      if (displayUsername) displayUsername.textContent = usernameValue;
      if (displayEmail) displayEmail.textContent = user.email;
      if (sidebarName) sidebarName.textContent = usernameValue;

      if (profileAvatar) {
        if (data.avatar) {
          profileAvatar.style.backgroundImage = `url('${data.avatar}')`;
          profileAvatar.classList.add('has-image');
          if (avatarSpan) avatarSpan.textContent = '';
        } else {
          profileAvatar.style.backgroundImage = '';
          profileAvatar.classList.remove('has-image');
          if (avatarSpan) avatarSpan.textContent = usernameValue[0].toUpperCase();
        }
      }

      if (sidebarAvatar) {
        if (data.avatar) {
          sidebarAvatar.style.backgroundImage = `url('${data.avatar}')`;
          sidebarAvatar.classList.add('has-image');
          if (sidebarSpan) sidebarSpan.textContent = '';
        } else {
          sidebarAvatar.style.backgroundImage = '';
          sidebarAvatar.classList.remove('has-image');
          if (sidebarSpan) sidebarSpan.textContent = usernameValue[0].toUpperCase();
        }
      }
      
      // Format dates
      if (memberSince && data.createdAt) {
        const date = new Date(data.createdAt);
        memberSince.textContent = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      }
      if (lastLogin) {
        const now = new Date();
        lastLogin.textContent = `Today, ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} UTC`;
      }
      
      // Update last login timestamp
      await updateDoc(userDoc, {
        lastLogin: new Date().toISOString()
      });
    } else {
      // Create profile if doesn't exist
      await setDoc(userDoc, {
        username: user.email.split('@')[0],
        email: user.email,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      });
      await loadUserProfile(user); // Reload
    }
  } catch (err) {
    console.error('Error loading user profile:', err);
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
      const sidebarName = document.getElementById('sidebarUsername');
      if (sidebarName) sidebarName.textContent = newUsername;
      const avatarEl = document.getElementById('profileAvatar');
      const avatarSpan = avatarEl ? avatarEl.querySelector('span') : null;
      if (avatarEl && !avatarEl.classList.contains('has-image') && avatarSpan) {
        avatarSpan.textContent = newUsername[0].toUpperCase();
      }
      const sidebarAvatar = document.getElementById('sidebarAvatar');
      const sidebarSpan = sidebarAvatar ? sidebarAvatar.querySelector('span') : null;
      if (sidebarAvatar && !sidebarAvatar.classList.contains('has-image') && sidebarSpan) {
        sidebarSpan.textContent = newUsername[0].toUpperCase();
      }
      
      closeModal();
    } catch (err) {
      console.error('Error saving username:', err);
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
  const sidebarAvatar = document.getElementById('sidebarAvatar');

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
          avatar: dataUrl
        });

        // Update UI immediately
        profileAvatar.style.backgroundImage = `url('${dataUrl}')`;
        profileAvatar.classList.add('has-image');
        const avatarSpan = profileAvatar.querySelector('span');
        if (avatarSpan) avatarSpan.textContent = '';

        if (sidebarAvatar) {
          sidebarAvatar.style.backgroundImage = `url('${dataUrl}')`;
          sidebarAvatar.classList.add('has-image');
          const sidebarSpan = sidebarAvatar.querySelector('span');
          if (sidebarSpan) sidebarSpan.textContent = '';
        }
      } catch (err) {
        console.error('Error saving avatar:', err);
        alert('Failed to save avatar. Please try again.');
      } finally {
        avatarInput.value = '';
      }
    };

    reader.readAsDataURL(file);
  });
}

// Export Firebase instances for trading history
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { auth, db };
}

// Initialize immediately if DOM is ready, otherwise after DOMContentLoaded
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', setupAuth);
} else {
  setupAuth();
}