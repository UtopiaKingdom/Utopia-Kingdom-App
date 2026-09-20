#!/usr/bin/env node
/**
 * Pull last Pocket Option trades via vault SSID. Does not print the SSID.
 */
const { spawnSync } = require('child_process');
const path = require('path');

(async () => {
  const keytar = require('keytar');
  const botId = process.env.PO_BOT || 'bot2';
  const account = process.env.PO_ACCOUNT || 'demo';
  const ssid = await keytar.getPassword('Utopia Kingdom', `po_ssid:${botId}:${account}`);
  if (!ssid) {
    console.log(JSON.stringify({ ok: false, error: `no SSID in vault for ${botId} ${account}` }));
    process.exit(2);
  }
  const py = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  const script = path.join(__dirname, 'pull_po_trades_via_ssid.py');
  const env = { ...process.env, PO_SSID: ssid };
  const r = spawnSync(py, [script], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(String(r.stderr).split(ssid).join('[ssid]'));
  process.exit(r.status == null ? 1 : r.status);
})().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
