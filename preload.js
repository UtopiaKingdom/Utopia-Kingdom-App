// Preload — keep light. Heavy compositor hacks here make low-end PCs stutter.

// TLS verification is secure by default. If you must bypass TLS verification
// (NOT recommended), set `UTK_INSECURE_TLS=1` before launching the app.
if (typeof process !== 'undefined' && process.env && process.env.UTK_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    const style = document.createElement('style');
    style.textContent = `
      html, body {
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
    `;
    document.head.appendChild(style);
  } catch (e) {}
}, { once: true });
