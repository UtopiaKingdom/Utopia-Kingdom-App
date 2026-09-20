'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function resolveLogoPath() {
  const candidates = [path.join(__dirname, 'logo.png')];
  if (process.resourcesPath) {
    candidates.unshift(path.join(process.resourcesPath, 'logo.png'));
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return path.join(__dirname, 'logo.png');
}

function applyLogoAssetUrls() {
  const logoPath = resolveLogoPath();
  if (!fs.existsSync(logoPath)) return;
  const logoUrl = pathToFileURL(logoPath).href;

  document.querySelectorAll('img[src="logo.png"]').forEach((img) => {
    img.src = logoUrl;
  });

  let style = document.getElementById('utk-asset-logo-fix');
  if (!style) {
    style = document.createElement('style');
    style.id = 'utk-asset-logo-fix';
    document.head.appendChild(style);
  }
  style.textContent = `.hero-logo-large::after{background-image:url("${logoUrl}") !important;}`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyLogoAssetUrls, { once: true });
} else {
  applyLogoAssetUrls();
}
