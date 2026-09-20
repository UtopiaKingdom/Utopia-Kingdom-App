#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  isAllowedInstallerUrl,
  isAllowedExternalUrl,
  isAllowedPaymentUrl,
} = require('../ipc-url-guards');

function ok(name) {
  console.log('  ok', name);
}

// Installer allowlist
assert.strictEqual(isAllowedInstallerUrl('https://utkingdom.com/updates/Utopia Kingdom-Setup-3.3.9.exe'), true);
ok('installer utkingdom.exe');
assert.strictEqual(isAllowedInstallerUrl('https://www.utkingdom.com/releases/v3.3.9/Setup.exe'), true);
ok('installer www releases');
assert.strictEqual(isAllowedInstallerUrl('https://utopia-kingdom.escapesvk.workers.dev/updates/latest.yml'), true);
ok('installer worker updates path');
assert.strictEqual(isAllowedInstallerUrl('https://evil.example/utk-installer.exe'), false);
ok('installer blocks foreign host');
assert.strictEqual(isAllowedInstallerUrl('http://utkingdom.com/updates/a.exe'), false);
ok('installer requires https');
assert.strictEqual(isAllowedInstallerUrl('file:///C:/temp/evil.exe'), false);
ok('installer blocks file');
assert.strictEqual(isAllowedInstallerUrl('Utopia Kingdom-Setup-3.3.9.exe'), false);
ok('installer rejects bare filename without host');

// External allowlist
assert.strictEqual(isAllowedExternalUrl('https://utkingdom.com/download'), true);
ok('external utkingdom');
assert.strictEqual(isAllowedExternalUrl('https://buy.paddle.com/checkout/xyz'), true);
ok('external paddle');
assert.strictEqual(isAllowedExternalUrl('http://169.58.151.111:8789/hub'), true);
ok('external contabo hub http');
assert.strictEqual(isAllowedExternalUrl('javascript:alert(1)'), false);
ok('external blocks javascript');
assert.strictEqual(isAllowedExternalUrl('https://evil.example/phish'), false);
ok('external blocks unknown https');

// Payment
assert.strictEqual(isAllowedPaymentUrl('https://buy.paddle.com/checkout/abc'), true);
ok('payment paddle');
assert.strictEqual(isAllowedPaymentUrl('https://evil.example/pay'), false);
ok('payment blocks foreign');

console.log('[test_ipc_url_guards] all passed');
