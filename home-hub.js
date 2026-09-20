/*
 home-hub.js
 Minimal home navigation + daily market mover headline.
*/
(function () {
 'use strict';

 const NEWS_CACHE_PREFIX = 'utk-home-mover-v2-';
 const NEWS_FEEDS = [
 { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
 { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' }
 ];

 function go(id, menuId) {
 try {
 const menu = menuId ? document.getElementById(menuId) : null;
 if (typeof window.navigateToSection === 'function') {
 window.navigateToSection(id, menu);
 return;
 }
 } catch (e) {}
 const target = document.getElementById('section-' + id);
 if (!target) return;
 document.querySelectorAll('.section.active').forEach((el) => el.classList.remove('active'));
 target.classList.add('active');
 }

 function openBot(botId) {
 try {
 if (window.__utkAccessGate && typeof window.__utkAccessGate.guardHouseBot === 'function') {
 if (!window.__utkAccessGate.guardHouseBot(botId)) return;
 }
 } catch (e) {}

 const current = document.querySelector('.section.active');
 const onHouseBot = !!(current && /^section-bot[123]$/.test(current.id));

 if (onHouseBot && window.utkBotTransitions && typeof window.utkBotTransitions.goTo === 'function') {
 window.__utkAccessBypass = true;
 try {
 window.utkBotTransitions.goTo(botId);
 } finally {
 window.__utkAccessBypass = false;
 }
 return;
 }

 go(botId, 'menu-bots');
 }

 function todayKey() {
 const d = new Date();
 const y = d.getFullYear();
 const m = String(d.getMonth() + 1).padStart(2, '0');
 const day = String(d.getDate()).padStart(2, '0');
 return `${NEWS_CACHE_PREFIX}${y}${m}${day}`;
 }

 function readCache() {
 try {
 const raw = localStorage.getItem(todayKey());
 if (!raw) return null;
 const parsed = JSON.parse(raw);
 if (!parsed || !parsed.title) return null;
 return parsed;
 } catch (e) {
 return null;
 }
 }

 function writeCache(payload) {
 try {
 localStorage.setItem(todayKey(), JSON.stringify(payload));
 // Drop older day keys so storage stays small.
 for (let i = localStorage.length - 1; i >= 0; i--) {
 const k = localStorage.key(i);
 if (k && k.startsWith(NEWS_CACHE_PREFIX) && k !== todayKey()) {
 localStorage.removeItem(k);
 }
 }
 } catch (e) {}
 }

 function paintMover(story) {
 const titleEl = document.getElementById('homeMoverTitle');
 const metaEl = document.getElementById('homeMoverMeta');
 if (!titleEl) return;
 if (!story || !story.title) {
 titleEl.textContent = 'Market news unavailable right now';
 titleEl.removeAttribute('href');
 if (metaEl) metaEl.textContent = '';
 return;
 }
 titleEl.textContent = story.title;
 if (story.url) {
 titleEl.href = story.url;
 } else {
 titleEl.removeAttribute('href');
 }
 if (metaEl) {
 const bits = [];
 if (story.source) bits.push(story.source);
 bits.push('Updates daily');
 metaEl.textContent = bits.join(' · ');
 }
 }

 function scoreStory(item) {
 const title = String(item.title || '').toLowerCase();
 const body = String(item.body || item.summary || '').toLowerCase();
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

 function parseRssItems(xmlText, source) {
 const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
 if (doc.querySelector('parsererror')) return [];
 return Array.from(doc.querySelectorAll('item')).map((item) => {
 const title = (item.querySelector('title')?.textContent || '').trim();
 const linkEl = item.querySelector('link');
 let url = (linkEl?.textContent || '').trim();
 if (!url && linkEl?.getAttribute('href')) url = linkEl.getAttribute('href').trim();
 const body = (
 item.querySelector('description')?.textContent ||
 item.querySelector('summary')?.textContent ||
 ''
 ).trim();
 return { title, url, body, source };
 }).filter((item) => item.title);
 }

 async function fetchFromRss() {
 for (const feed of NEWS_FEEDS) {
 try {
 const res = await fetch(feed.url, {
 method: 'GET',
 headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' }
 });
 if (!res.ok) continue;
 const xml = await res.text();
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
 const res = await fetch(
 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false',
 { method: 'GET', headers: { Accept: 'application/json' } }
 );
 if (!res.ok) throw new Error('markets_failed');
 const list = await res.json();
 if (!Array.isArray(list) || !list.length) throw new Error('markets_empty');

 const ranked = list
 .slice()
 .filter((c) => typeof c.price_change_percentage_24h === 'number')
 .sort((a, b) => Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h));
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

 async function fetchDailyMover() {
 const cached = readCache();
 if (cached) {
 paintMover(cached);
 return;
 }

 paintMover({ title: "Loading today's market mover..." });

 try {
 let story = null;
 try {
 if (typeof require === 'function') {
 const { ipcRenderer } = require('electron');
 if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
 const res = await ipcRenderer.invoke('fetch-home-mover');
 if (res && res.ok && res.story && res.story.title) {
 story = res.story;
 }
 }
 }
 } catch (e) {}
 if (!story || !story.title) {
 story = await fetchFromRss();
 }
 if (!story || !story.title) {
 story = await fetchFromPriceMover();
 }
 if (!story || !story.title) throw new Error('news_empty');
 writeCache(story);
 paintMover(story);
 } catch (e) {
 paintMover({ title: "Could not load today's market mover" });
 }
 }

 document.addEventListener('click', (ev) => {
 const link = ev.target.closest && ev.target.closest('[data-home-nav]');
 if (!link) return;
 ev.preventDefault();
 const nav = link.getAttribute('data-home-nav');
    if (nav === 'studio') {
      try {
        if (window.__utkAccessGate && !window.__utkAccessGate.guardStudio()) return;
      } catch (e) {}
    }
    if (nav === 'bot1' || nav === 'bot2' || nav === 'bot3') openBot(nav);
 else if (nav === 'strategies') go('strategies', 'menu-strategies');
 else if (nav === 'hub') go('hub', 'menu-hub');
 else if (nav === 'studio') go('studio', 'menu-studio');
 else if (nav === 'vision') go('vision', 'menu-vision');
 else if (nav === 'profile') go('profile');
 else if (nav === 'bots') {
      try {
        const freeId = (window.__utkAccessGate && window.__utkAccessGate.freeBotId)
          ? window.__utkAccessGate.freeBotId()
          : 'bot1';
        openBot(freeId);
      } catch (e) {
        go('bots', 'menu-bots');
      }
    }
 });

 function init() {
 fetchDailyMover();
 }

 if (document.readyState === 'loading') {
 document.addEventListener('DOMContentLoaded', init);
 } else {
 init();
 }
})();

