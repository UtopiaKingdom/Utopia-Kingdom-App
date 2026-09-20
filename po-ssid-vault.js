'use strict';

const path = require('path');

let keytar = null;
try {
  keytar = require('keytar');
} catch (e) {}

const SERVICE = 'Utopia Kingdom';
const BOT_IDS = ['bot1', 'bot2', 'bot3'];
const ACCOUNTS = ['real', 'demo'];

function accountKey(botId, account) {
  return `po_ssid:${botId}:${account}`;
}

function isAvailable() {
  return !!keytar;
}

async function getSsid(botId, account) {
  if (!keytar || !botId || !account) return null;
  try {
    const value = await keytar.getPassword(SERVICE, accountKey(botId, account));
    return value ? String(value).trim() : null;
  } catch {
    return null;
  }
}

async function setSsid(botId, account, ssid) {
  const trimmed = String(ssid || '').trim();
  if (!trimmed) throw new Error('Missing SSID');
  if (!keytar) throw new Error('Secure SSID storage is unavailable on this system');
  await keytar.setPassword(SERVICE, accountKey(botId, account), trimmed);
  return trimmed;
}

async function deleteSsid(botId, account) {
  if (!keytar || !botId || !account) return;
  try {
    await keytar.deletePassword(SERVICE, accountKey(botId, account));
  } catch {}
}

async function deleteAllForBot(botId) {
  for (const account of ACCOUNTS) {
    await deleteSsid(botId, account);
  }
}

function unlinkIfExists(fs, filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

async function migratePlaintextFiles({ ssidDir, readTextFileIfExists, detectAccountFromSsid, fs, log }) {
  const hydrated = {};
  let migrated = 0;

  for (const botId of BOT_IDS) {
    hydrated[botId] = { realSsid: null, demoSsid: null };

    const realPath = path.join(ssidDir, `pocketoption_real_ssid_${botId}.txt`);
    const demoPath = path.join(ssidDir, `pocketoption_demo_ssid_${botId}.txt`);
    const legacyPath = path.join(ssidDir, `pocketoption_ssid_${botId}.txt`);

    let vaultReal = keytar ? await getSsid(botId, 'real') : null;
    let vaultDemo = keytar ? await getSsid(botId, 'demo') : null;

    const fileReal = readTextFileIfExists(realPath);
    const fileDemo = readTextFileIfExists(demoPath);
    const fileLegacy = readTextFileIfExists(legacyPath);

    if (keytar) {
      if (!vaultReal && fileReal) {
        await setSsid(botId, 'real', fileReal);
        vaultReal = fileReal.trim();
        migrated += 1;
        unlinkIfExists(fs, realPath);
      }
      if (!vaultDemo && fileDemo) {
        await setSsid(botId, 'demo', fileDemo);
        vaultDemo = fileDemo.trim();
        migrated += 1;
        unlinkIfExists(fs, demoPath);
      }
      if (!vaultReal && !vaultDemo && fileLegacy) {
        const detected = detectAccountFromSsid(fileLegacy);
        if (detected === 'real') {
          await setSsid(botId, 'real', fileLegacy);
          vaultReal = fileLegacy.trim();
        } else if (detected === 'demo') {
          await setSsid(botId, 'demo', fileLegacy);
          vaultDemo = fileLegacy.trim();
        }
        if (detected) {
          migrated += 1;
          unlinkIfExists(fs, legacyPath);
        }
      }
    } else {
      vaultReal = fileReal;
      vaultDemo = fileDemo;
      if (!vaultReal && !vaultDemo && fileLegacy) {
        const detected = detectAccountFromSsid(fileLegacy);
        if (detected === 'real') vaultReal = fileLegacy;
        else if (detected === 'demo') vaultDemo = fileLegacy;
      }
      log?.('warn', '[SSID Vault] keytar unavailable — using plaintext SSID files (dev only)');
    }

    if (vaultReal && detectAccountFromSsid(vaultReal) === 'demo') vaultReal = null;
    if (vaultDemo && detectAccountFromSsid(vaultDemo) === 'real') vaultDemo = null;

    hydrated[botId].realSsid = vaultReal || null;
    hydrated[botId].demoSsid = vaultDemo || null;
  }

  return { migrated, hydrated };
}

async function loadAllFromVault(detectAccountFromSsid) {
  const out = {};
  for (const botId of BOT_IDS) {
    let realSsid = keytar ? await getSsid(botId, 'real') : null;
    let demoSsid = keytar ? await getSsid(botId, 'demo') : null;
    if (realSsid && detectAccountFromSsid(realSsid) === 'demo') realSsid = null;
    if (demoSsid && detectAccountFromSsid(demoSsid) === 'real') demoSsid = null;
    out[botId] = {
      realSsid: realSsid || null,
      demoSsid: demoSsid || null
    };
  }
  return out;
}

module.exports = {
  SERVICE,
  BOT_IDS,
  isAvailable,
  getSsid,
  setSsid,
  deleteSsid,
  deleteAllForBot,
  migratePlaintextFiles,
  loadAllFromVault
};
