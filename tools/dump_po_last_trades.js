#!/usr/bin/env node
/**
 * Dump last 5 Pocket Option trades for bot2 demo SSID.
 * Does not print the SSID.
 */
const { spawnSync } = require('child_process');
const path = require('path');

(async () => {
  const keytar = require('keytar');
  const botId = process.env.PO_BOT || 'bot2';
  const account = process.env.PO_ACCOUNT || 'demo';
  const ssid = await keytar.getPassword('Utopia Kingdom', `po_ssid:${botId}:${account}`);
  if (!ssid) {
    console.log(`no SSID in vault for ${botId} ${account}`);
    process.exit(2);
  }
  const py = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  const script = path.join(__dirname, 'dump_po_last_trades.py');
  const env = {
    ...process.env,
    PO_SSID: ssid,
    PO_LIMIT: process.env.PO_LIMIT || '5',
    PO_DEAL_IDS: process.env.PO_DEAL_IDS || [
      'bae0f68e-b0de-4eb0-8644-ec6b5120d4a7',
      '1a505285-2bd7-4ff8-bb6a-0351fa78efc8',
      'cb92efea-0a08-4560-b9d3-762f6ac5727a',
      '59b8f408-3ed4-419a-933b-84a0b224d412',
      '8dd6a6e1-08b9-4c8d-9167-f6ba6d5a08de'
    ].join(',')
  };
  const r = spawnSync(py, [script], { env, encoding: 'utf8', windowsHide: true, timeout: 45000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr.replace(ssid, '[ssid]'));
  process.exit(r.status == null ? 1 : r.status);
})().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
