#!/usr/bin/env node
/*
  tools/delete_trades_by_bot.js
  - Deletes all docs in bots/{lumix|mirax}/tradingResults
  - Resets that bot's live board (win streak) so it does not keep a stale count

  Usage:
    node tools/delete_trades_by_bot.js LUMIX --yes
    node tools/delete_trades_by_bot.js MIRAX --yes --streaks

  Options:
    --yes        Actually delete. Without this, dry-run.
    --limit N    Max tradingResults docs to process.
    --streaks    Also delete bots/{bot}/pastWinStreaks
    --daily      Also delete bots/{bot}/dailyStats
    --all        LUMIX and MIRAX

  Requires serviceAccountKey.json in project root.
*/

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const botStore = require('../firebase-bot-paths');

function parseArgs(argv) {
  const out = { bot: null, yes: false, limit: null, streaks: false, daily: false, all: false };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!out.bot && !a.startsWith('-')) {
      out.bot = a;
      continue;
    }
    if (a === '--yes') { out.yes = true; continue; }
    if (a === '--streaks') { out.streaks = true; continue; }
    if (a === '--daily') { out.daily = true; continue; }
    if (a === '--all') { out.all = true; continue; }
    if (a === '--limit') {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      i++;
      continue;
    }
  }
  return out;
}

async function deleteCollection(db, colPath, yes, limit) {
  let deleted = 0;
  let lastDoc = null;
  while (true) {
    let q = db.collection(colPath).orderBy(admin.firestore.FieldPath.documentId()).limit(450);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    lastDoc = snap.docs[snap.docs.length - 1];
    let docs = snap.docs;
    if (limit) {
      const remaining = Math.max(0, limit - deleted);
      docs = docs.slice(0, remaining);
    }
    if (!docs.length) break;
    if (!yes) {
      deleted += docs.length;
      if (limit && deleted >= limit) break;
      continue;
    }
    const batch = db.batch();
    docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    deleted += docs.length;
    console.log(`[delete_trades_by_bot] ${colPath} deleted so far: ${deleted}`);
    if (limit && deleted >= limit) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  return deleted;
}

async function purgeBot(db, botKey, yes, limit, streaks, daily) {
  const resultsPath = botStore.tradingResultsPathString(botKey);
  const streaksPath = botStore.pastWinStreaksPathString(botKey);
  const dailyPath = botStore.dailyStatsPathString(botKey, 'x').replace(/\/x$/, '');

  console.log(`[delete_trades_by_bot] bot=${botKey} mode=${yes ? 'DELETE' : 'DRY-RUN'}${limit ? ` limit=${limit}` : ''}${streaks ? ' +pastWinStreaks' : ''}${daily ? ' +dailyStats' : ''}`);

  const resultsDeleted = await deleteCollection(db, resultsPath, yes, limit);
  let streaksDeleted = 0;
  let dailyDeleted = 0;
  if (streaks) streaksDeleted = await deleteCollection(db, streaksPath, yes, null);
  if (daily) dailyDeleted = await deleteCollection(db, dailyPath, yes, null);

  if (yes) {
    await db.doc(botStore.boardPathString(botKey)).set(botStore.emptyLiveBoard(botKey), { merge: true });
    console.log(`[delete_trades_by_bot] reset live board ${botStore.boardPathString(botKey)}`);
  }

  const extra = (streaks ? `, ${streaksDeleted} pastWinStreaks` : '') + (daily ? `, ${dailyDeleted} dailyStats` : '');
  if (!yes) {
    console.log(`[delete_trades_by_bot] DRY-RUN ${botKey}: would delete ${resultsDeleted} tradingResults${extra}. Re-run with --yes to delete.`);
  } else {
    console.log(`[delete_trades_by_bot] DONE ${botKey}: deleted ${resultsDeleted} tradingResults${extra}.`);
  }
}

async function main() {
  const { bot, yes, limit, streaks, daily, all } = parseArgs(process.argv);
  const bots = all ? ['LUMIX', 'MIRAX'] : [botStore.normalizeBotKey(bot)];
  if (!bots[0] || bots.some((b) => !b)) {
    console.error('Usage: node tools/delete_trades_by_bot.js <LUMIX|MIRAX|--all> [--yes] [--limit N] [--streaks] [--daily]');
    process.exit(2);
  }

  const SERVICE_ACCOUNT = path.join(process.cwd(), 'serviceAccountKey.json');
  if (!fs.existsSync(SERVICE_ACCOUNT)) {
    console.error('serviceAccountKey.json not found in project root.');
    process.exit(3);
  }

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(require(SERVICE_ACCOUNT)) });
  }

  const db = admin.firestore();
  for (const botKey of bots) {
    await purgeBot(db, botKey, yes, limit, streaks, daily);
  }
}

main().catch((err) => {
  console.error('[delete_trades_by_bot] failed:', err);
  process.exit(5);
});
