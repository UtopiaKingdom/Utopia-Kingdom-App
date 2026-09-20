document.addEventListener('DOMContentLoaded', () => {
  const openBtn = document.getElementById('openThemeBtn');
  const menu = document.getElementById('themeMenu');
  const options = menu.querySelectorAll('.theme-option');
  const customPrimaryPicker = document.getElementById('customPrimaryPicker');
  const customAccentPicker = document.getElementById('customAccentPicker');
  const applyCustomBtn = document.getElementById('applyCustomColor');
  const body = document.body;
  let menuOpen = false;

  function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return null;
    const h = hex.trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(h)) return null;
    const v = h.startsWith('#') ? h.slice(1) : h;
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return { r, g, b };
  }

  function relativeLuminance({ r, g, b }) {
    // WCAG relative luminance
    const srgb = [r, g, b].map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }

  function chooseOnColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#0b0b10';
    // If background is dark, use white text; else use near-black.
    const lum = relativeLuminance(rgb);
    return lum < 0.42 ? '#ffffff' : '#0b0b10';
  }

  function setComputedAccentContrast() {
    try {
      const computed = getComputedStyle(document.body);
      const accent = (computed.getPropertyValue('--accent-primary') || '').trim();
      if (!accent) return;
      const on = chooseOnColor(accent);
      document.documentElement.style.setProperty('--accent-on-primary', on);
    } catch (e) {}
  }

  // Toggle the menu on button click
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menuOpen = !menuOpen;
    if (menuOpen) {
      menu.classList.add('show');
      // Optionally, focus the first theme option for keyboard users
      setTimeout(() => options[0].focus(), 10);
    } else {
      menu.classList.remove('show');
    }
  });

  // Hide menu when clicking anywhere outside the menu or button
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== openBtn) {
      menu.classList.remove('show');
      menuOpen = false;
    }
  });

  // Also close on Escape key for accessibility
  document.addEventListener('keydown', (e) => {
    if (e.key === "Escape" && menuOpen) {
      menu.classList.remove('show');
      menuOpen = false;
      openBtn.focus();
    }
  });

  // Theme apply logic
  options.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent menu close event from bubbling
      // Remove existing theme classes
      body.className = body.className.replace(/theme-\S+/g, '').trim();
      options.forEach(b => b.classList.remove('active'));
      const chosen = btn.getAttribute('data-theme');
      if (chosen) {
        body.classList.add(chosen);
      }
      btn.classList.add('active');
      menu.classList.remove('show');
      menuOpen = false;
      localStorage.setItem('utk-theme', chosen || '');

      // Ensure readable text on accent-colored buttons for any theme
      setTimeout(setComputedAccentContrast, 0);
    });
  });

  // Custom theme (two-color) logic
  if (applyCustomBtn && customPrimaryPicker && customAccentPicker) {
    applyCustomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const primary = customPrimaryPicker.value;
      const accent = customAccentPicker.value;

      const prgb = hexToRgb(primary);
      const onPrimary = chooseOnColor(primary);

      // Set CSS custom properties
      document.documentElement.style.setProperty('--custom-accent-primary', primary);
      document.documentElement.style.setProperty('--custom-accent-secondary', accent);
      document.documentElement.style.setProperty('--custom-accent-hover', accent);
      document.documentElement.style.setProperty('--custom-accent-on-primary', onPrimary);
      if (prgb) {
        document.documentElement.style.setProperty('--custom-accent-primary-rgb', `${prgb.r}, ${prgb.g}, ${prgb.b}`);
      }
      
      // Apply theme-custom class
      body.className = body.className.replace(/theme-\S+/g, '').trim();
      body.classList.add('theme-custom');
      options.forEach(b => b.classList.remove('active'));
      
      menu.classList.remove('show');
      menuOpen = false;
      
      // Save custom theme
      localStorage.setItem('utk-theme', 'theme-custom');
      localStorage.setItem('utk-custom-primary', primary);
      localStorage.setItem('utk-custom-accent', accent);

      // Ensure readable text on accent-colored buttons
      setTimeout(setComputedAccentContrast, 0);
    });
  }

  // On load, restore theme
  const savedTheme = localStorage.getItem('utk-theme');
  if (savedTheme === 'theme-custom') {
    const savedPrimary = localStorage.getItem('utk-custom-primary') || localStorage.getItem('utk-custom-color');
    const savedAccent = localStorage.getItem('utk-custom-accent');
    if (savedPrimary && customPrimaryPicker) customPrimaryPicker.value = savedPrimary;
    if (savedAccent && customAccentPicker) customAccentPicker.value = savedAccent;

    // Re-apply custom colors
    if (savedPrimary) {
      const prgb = hexToRgb(savedPrimary);
      document.documentElement.style.setProperty('--custom-accent-primary', savedPrimary);
      document.documentElement.style.setProperty('--custom-accent-on-primary', chooseOnColor(savedPrimary));
      if (prgb) document.documentElement.style.setProperty('--custom-accent-primary-rgb', `${prgb.r}, ${prgb.g}, ${prgb.b}`);
    }
    if (savedAccent) {
      document.documentElement.style.setProperty('--custom-accent-secondary', savedAccent);
      document.documentElement.style.setProperty('--custom-accent-hover', savedAccent);
    } else if (savedPrimary) {
      // Reasonable fallback: use primary as accent if older config
      document.documentElement.style.setProperty('--custom-accent-secondary', savedPrimary);
      document.documentElement.style.setProperty('--custom-accent-hover', savedPrimary);
    }
    body.classList.add('theme-custom');
    setTimeout(setComputedAccentContrast, 0);
  } else if (savedTheme) {
    body.classList.add(savedTheme);
    options.forEach(b => {
      if (b.getAttribute('data-theme') === savedTheme) b.classList.add('active');
    });
    setTimeout(setComputedAccentContrast, 0);
  } else {
    options[0].classList.add('active');
    setTimeout(setComputedAccentContrast, 0);
  }
});