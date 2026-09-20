/**
 * home-mover-ipc.js — Main-process fetch for Today's market mover.
 * Packaged Electron builds cannot reliably hit RSS/CoinGecko from the renderer (CORS / net).
 */
'use strict';

const { ipcMain, net } = require('electron');

const FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' }
];

const COINGECKO =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false';

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `utk-home-mover-v2-${y}${m}${day}`;
}

function scoreStory(item) {
  const title = String(item.title || '').toLowerCase();
  const body = String(item.body || '').toLowerCase();
  const text = `${title} ${body}`;
  let score = 0;
  const keywords = [
    'bitcoin', 'btc', 'ethereum', 'eth', 'fed', 'rate', 'sec', 'etf',
    'crash', 'surge', 'rally', 'hack', 'ban', 'approval', 'inflation',
    'war', 'oil', 'cpi', 'jobs', 'treasury', 'market', 'price'
  ];
  keywords.forEach((k) => {
    if (text.includes(k)) score += 1.5;
  });
  if (/\b(soar|surge|plunge|crash|record|all.?time|breakthrough|rally|drops?|jumps?)\b/.test(text)) {
    score += 2;
  }
  return score;
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function tagText(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = String(block || '').match(re);
  if (!m) return '';
  return decodeXml(m[1].replace(/<[^>]+>/g, ' '));
}

function parseRssItems(xmlText, source) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let match;
  while ((match = re.exec(String(xmlText || ''))) && items.length < 40) {
    const block = match[0];
    const title = tagText(block, 'title');
    if (!title) continue;
    let url = tagText(block, 'link');
    if (!url) {
      const atom = block.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (atom) url = atom[1].trim();
    }
    const body = tagText(block, 'description') || tagText(block, 'summary');
    items.push({ title, url, body, source });
  }
  return items;
}

async function fetchText(url, accept) {
  const res = await net.fetch(url, {
    method: 'GET',
    headers: {
      Accept: accept || '*/*',
      'User-Agent': 'UtopiaKingdomApp/home-mover'
    }
  });
  if (!res.ok) throw new Error('http_' + res.status);
  return await res.text();
}

async function fetchJson(url) {
  const text = await fetchText(url, 'application/json');
  return JSON.parse(text);
}

async function fetchFromRss() {
  for (const feed of FEEDS) {
    try {
      const xml = await fetchText(
        feed.url,
        'application/rss+xml, application/xml, text/xml, */*'
      );
      const list = parseRssItems(xml, feed.source);
      if (!list.length) continue;
      const ranked = list.slice().sort((a, b) => scoreStory(b) - scoreStory(a));
      const top = ranked[0];
      return {
        title: top.title,
        url: top.url || feed.url,
        source: feed.source,
        day: todayKey()
      };
    } catch (e) {
      // try next feed
    }
  }
  return null;
}

async function fetchFromPriceMover() {
  const list = await fetchJson(COINGECKO);
  if (!Array.isArray(list) || !list.length) throw new Error('markets_empty');
  const ranked = list
    .slice()
    .filter((c) => typeof c.price_change_percentage_24h === 'number')
    .sort(
      (a, b) =>
        Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h)
    );
  const top = ranked[0];
  if (!top) throw new Error('markets_empty');
  const change = Number(top.price_change_percentage_24h);
  const direction = change >= 0 ? 'up' : 'down';
  const pct = Math.abs(change).toFixed(1);
  return {
    title: `${top.name} leads the board, ${direction} ${pct}% in 24h`,
    url: `https://www.coingecko.com/en/coins/${top.id}`,
    source: 'CoinGecko',
    day: todayKey()
  };
}

function registerHomeMoverIpc() {
  if (registerHomeMoverIpc._done) return;
  registerHomeMoverIpc._done = true;
  ipcMain.handle('fetch-home-mover', async () => {
    try {
      let story = await fetchFromRss();
      if (!story || !story.title) {
        story = await fetchFromPriceMover();
      }
      if (!story || !story.title) {
        return { ok: false, error: 'news_empty' };
      }
      return { ok: true, story };
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'fetch_failed' };
    }
  });
}

module.exports = { registerHomeMoverIpc };
