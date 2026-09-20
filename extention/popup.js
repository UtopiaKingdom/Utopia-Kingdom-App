// popup.js - always-show input + verify; Fill button copies stored challenge code (if present)

document.addEventListener('DOMContentLoaded', () => {
  const indicator = document.getElementById('indicator');
  const text = document.getElementById('text');
  const codeInput = document.getElementById('codeInput');
  const verifyBtn = document.getElementById('verifyBtn');
  const fillBtn = document.getElementById('fillBtn');

  function setDisconnected() {
    indicator.style.background = '#d9534f';
    text.textContent = 'Disconnected';
    verifyBtn.disabled = false;
    fillBtn.disabled = false;
  }

  function setPending() {
    indicator.style.background = '#f0ad4e';
    text.textContent = 'Pending verification';
    verifyBtn.disabled = false;
    fillBtn.disabled = false;
  }

  function setConnected() {
    indicator.style.background = '#28a745';
    text.textContent = 'Connected';
    verifyBtn.disabled = false;
    fillBtn.disabled = false;
  }

  async function fillFromStorage() {
    chrome.storage.local.get(['nativeHostPendingChallenge'], (res) => {
      const ch = res && res.nativeHostPendingChallenge;
      if (ch && ch.code) {
        codeInput.value = ch.code;
        codeInput.focus();
        codeInput.select();
      } else {
        // no pending challenge stored
        alert('No pending code found in extension storage.');
      }
    });
  }

  verifyBtn.addEventListener('click', () => {
    const code = codeInput.value.trim();
    if (!code) { alert('Enter the code printed by the native host'); return; }
    verifyBtn.disabled = true;
    chrome.runtime.sendMessage({ cmd: 'verify', code }, (resp) => {
      if (chrome.runtime.lastError) {
        alert('Verification error: ' + chrome.runtime.lastError.message);
        verifyBtn.disabled = false;
        return;
      }
      if (!resp || !resp.ok) {
        alert('Verification failed: ' + (resp && resp.reason ? resp.reason : 'unknown'));
        verifyBtn.disabled = false;
        return;
      }
      // verification request sent; wait for host to respond with {type:'verified'}
      text.textContent = 'Verification sent — waiting...';
    });
  });

  fillBtn.addEventListener('click', fillFromStorage);

  // initial read of stored state
  chrome.storage.local.get(['nativeHostConnected','nativeHostPending','nativeHostPendingChallenge'], (res) => {
    if (res && res.nativeHostConnected) setConnected();
    else if (res && res.nativeHostPending) setPending();
    else setDisconnected();

    // auto-prefill if there is a stored pending code
    if (res && res.nativeHostPending && res.nativeHostPendingChallenge && res.nativeHostPendingChallenge.code) {
      codeInput.value = res.nativeHostPendingChallenge.code;
    }
  });

  // watch for changes and update UI
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.nativeHostConnected) {
      if (changes.nativeHostConnected.newValue) setConnected();
      else setDisconnected();
    }
    if (changes.nativeHostPending) {
      if (changes.nativeHostPending.newValue) setPending();
      else {
        // pending cleared
        // keep input visible but clear if desired
      }
    }
    if (changes.nativeHostPendingChallenge && changes.nativeHostPendingChallenge.newValue) {
      // auto-fill the input with the new code so user can just press Verify
      const newCh = changes.nativeHostPendingChallenge.newValue;
      if (newCh && newCh.code) codeInput.value = newCh.code;
    }
  });
});