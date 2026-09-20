/**
 * Cloudflare Worker for routing:
 * - / → Landing page (static site)
 * - /ws → WebSocket server (bridge to your Python server)
 * - /updates → Update server for Electron
 */
import { handleCommunityHub } from './community-hub-cf.js';

function applyR2HttpMetadata(headers, httpMetadata) {
  if (!httpMetadata) return;
  if (httpMetadata.contentType) headers.set('Content-Type', httpMetadata.contentType);
  if (httpMetadata.cacheControl) headers.set('Cache-Control', httpMetadata.cacheControl);
  if (httpMetadata.contentDisposition) headers.set('Content-Disposition', httpMetadata.contentDisposition);
  if (httpMetadata.contentEncoding) headers.set('Content-Encoding', httpMetadata.contentEncoding);
  if (httpMetadata.contentLanguage) headers.set('Content-Language', httpMetadata.contentLanguage);
}

function applyReleaseDownloadHeaders(headers, filename) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.apk')) {
    const safe = String(filename || 'app.apk').replace(/"/g, '');
    headers.set('Content-Type', 'application/vnd.android.package-archive');
    // filename + filename* — Android download managers often ignore redirects and
    // need a strong disposition; URL path should also already include this name.
    headers.set(
      'Content-Disposition',
      `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    headers.set('Pragma', 'no-cache');
    return;
  }
  if (lower.endsWith('.exe')) {
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return;
  }
  if (lower.endsWith('.dmg')) {
    const safe = String(filename || 'Utopia-Kingdom.dmg').replace(/"/g, '');
    headers.set('Content-Type', 'application/x-apple-diskimage');
    headers.set(
      'Content-Disposition',
      `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
    );
    headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return;
  }
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    headers.set('Content-Type', 'text/yaml; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
  }
}

function tapeCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

async function proxyBotTape(request, env) {
  const cors = tapeCorsHeaders();
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET, OPTIONS' },
    });
  }
  const origin = String(env.HISTORY_ORIGIN || '').trim().replace(/\/$/, '');
  if (!origin) {
    return new Response(JSON.stringify({ ok: false, error: 'history_origin_unset' }), {
      status: 503,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  const url = new URL(request.url);
  let rest = url.pathname.replace(/^\/api\/bot-tape/, '') || '/';
  if (rest === '/') rest = '/health';
  const target = origin + rest + url.search;
  // Workers cannot fetch a raw IP (CF 1003). Redirect to Contabo; the tape
  // server already sends CORS *. Electron/fetch follow this by default.
  return Response.redirect(target, 302);
}

/** Canonical Android APK URL: UtopiaKingdom-<version>.apk */
function androidApkUrl(env, requestUrl) {
  const version = String(env.MOBILE_APP_VERSION || '').trim();
  const configured = String(env.ANDROID_DOWNLOAD_URL || '').trim();
  // Prefer deriving from MOBILE_APP_VERSION so the path always contains the version.
  if (version) {
    const origin = requestUrl ? new URL(requestUrl).origin : 'https://utkingdom.com';
    return `${origin}/releases/mobile/UtopiaKingdom-${version}.apk`;
  }
  return configured;
}

/** Canonical macOS DMG URL: Utopia Kingdom-<version>-mac.dmg */
function macDmgUrl(env, requestUrl) {
  const configured = String(env.MAC_FILE_DOWNLOAD_URL || '').trim();
  if (configured) return configured;
  const version = String(env.APP_VERSION || '').trim();
  if (!version) return '';
  const origin = requestUrl ? new URL(requestUrl).origin : 'https://utkingdom.com';
  return `${origin}/releases/v${version}/Utopia%20Kingdom-${version}-mac.dmg`;
}

function androidApkFilename(env) {
  const version = String(env.MOBILE_APP_VERSION || '').trim() || 'latest';
  return `UtopiaKingdom-${version}.apk`;
}

function androidApkR2Key(env) {
  const version = String(env.MOBILE_APP_VERSION || '').trim();
  if (!version) return 'releases/mobile/UtopiaKingdom-android.apk';
  return `releases/mobile/UtopiaKingdom-${version}.apk`;
}

async function streamAndroidApk(env, request) {
  const filename = androidApkFilename(env);
  const key = androidApkR2Key(env);
  let obj = await env.DOWNLOADS.get(key);
  // Fallback to legacy object if versioned key missing
  if (!obj) obj = await env.DOWNLOADS.get('releases/mobile/UtopiaKingdom-android.apk');
  if (!obj) {
    return new Response('Android APK not found.', { status: 404 });
  }
  const headers = new Headers();
  // Do NOT copy R2 Content-Disposition — it may still say UtopiaKingdom-android.apk
  if (obj.httpMetadata) {
    if (obj.httpMetadata.contentType) headers.set('Content-Type', obj.httpMetadata.contentType);
    if (obj.httpMetadata.contentEncoding) headers.set('Content-Encoding', obj.httpMetadata.contentEncoding);
  }
  applyReleaseDownloadHeaders(headers, filename);
  return new Response(obj.body, { status: 200, headers });
}

function redirectToVersionedApk(env, request) {
  const target = androidApkUrl(env, request.url);
  if (!target) return new Response('Android download is not configured.', { status: 503 });
  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const pathname = (() => {
      try {
        return decodeURIComponent(url.pathname);
      } catch {
        return url.pathname;
      }
    })();

    // root page: serve the static site from R2 bucket binding (uploads under "site/")
    if (pathname === '/' || pathname === '/index.html') {
      const key = 'site/index.html';
      const obj = await env.DOWNLOADS.get(key, { type: 'stream' });
      if (obj) {
        const headers = new Headers(obj.httpMetadata || {});
        headers.set('Content-Type', 'text/html');
        return new Response(obj.body, { status: 200, headers });
      }
      return new Response('Not found', { status: 404 });
    }

    // Smart download routing from website buttons.
    if (pathname === '/download' || pathname === '/download/mac' || pathname === '/download/windows') {
      const ua = String(request.headers.get('user-agent') || '').toLowerCase();
      const iosUrl = String(env.IOS_DOWNLOAD_URL || '').trim();
      const windowsUrl = String(env.FILE_DOWNLOAD_URL || '').trim();
      const macUrl = macDmgUrl(env, request.url);
      const osParam = String(url.searchParams.get('os') || url.searchParams.get('platform') || '').toLowerCase();
      const forceWindows = pathname === '/download/windows' || osParam === 'windows' || osParam === 'win';
      const forceMac = pathname === '/download/mac' || osParam === 'mac' || osParam === 'macos' || osParam === 'darwin';

      // Phone builds are not public yet — send Android/iOS to the coming-soon page.
      if (!forceWindows && !forceMac && (/android/.test(ua) || /(iphone|ipad|ipod|ios)/.test(ua)) && iosUrl) {
        return Response.redirect(iosUrl, 302);
      }
      if (forceMac || (!forceWindows && /macintosh|mac os x/.test(ua))) {
        if (macUrl) return Response.redirect(macUrl, 302);
        return new Response('Mac download is not configured yet.', { status: 503 });
      }
      if (windowsUrl) {
        return Response.redirect(windowsUrl, 302);
      }
      return new Response('Download is not configured.', { status: 503 });
    }

    if (pathname === '/download/android') {
      // 302 to a URL whose path already ends with UtopiaKingdom-<ver>.apk
      // (Android DownloadManager names files from the URL path).
      return redirectToVersionedApk(env, request);
    }

    if (pathname === '/download/ios') {
      const iosUrl = String(env.IOS_DOWNLOAD_URL || '').trim();
      if (!iosUrl) return new Response('iOS install link is not configured.', { status: 503 });
      return Response.redirect(iosUrl, 302);
    }

    // Paddle default payment link target on approved domain.
    // Configure Paddle "Default payment link" as: https://utkingdom.com/paypaddle
    // Paddle appends _ptxn, and we forward to Paddle hosted checkout service.
    if (pathname === '/paypaddle') {
      const ptxn = (url.searchParams.get('_ptxn') || '').trim();
      if (!ptxn) {
        return new Response('Missing transaction token.', {
          status: 400,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      const target = `https://checkout-service.paddle.com/create/checkout?_ptxn=${encodeURIComponent(ptxn)}`;
      return Response.redirect(target, 302);
    }

    // Paddle.js checkout on approved domain (required for client-side token checkout).
    if (pathname === '/paddle/checkout') {
      return handlePaddleCheckoutPage(request, env);
    }

    // Public webhook endpoint reserved for Paddle.
    // This makes https://utkingdom.com/webhook exist now.
    // Later you can set PADDLE_WEBHOOK_TARGET to forward real webhook traffic
    // to your backend verifier (for example: https://api.utkingdom.com/webhook).
    if (pathname === '/webhook') {
      const method = (request.method || 'GET').toUpperCase();

      if (method === 'GET') {
        return new Response('Webhook endpoint is online.', {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      if (method !== 'POST') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { 'Allow': 'GET, POST' }
        });
      }

      try {
        const result = await handlePaddleWebhook(request, env);
        return new Response(JSON.stringify(result), {
          status: result && result.ok ? 200 : (result && result.statusCode ? result.statusCode : 400),
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'webhook_failed',
          message: e && e.message ? e.message : 'Unknown error'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    // Community chat (R2). Live now, no Contabo tape restart needed.
    if (pathname === '/api/hub' || pathname.startsWith('/api/hub/')) {
      return handleCommunityHub(request, env, pathname);
    }

    // Bot WIN/LOSS tape (Contabo SQLite via HISTORY_ORIGIN).
    if (pathname === '/api/bot-tape' || pathname.startsWith('/api/bot-tape/')) {
      return proxyBotTape(request, env);
    }

    // Public API endpoint for creating Paddle checkout links server-side.
    // Keeps Paddle API key in Worker secrets and works for all app users globally.
    if (pathname === '/api/paddle/checkout') {
      const method = (request.method || 'GET').toUpperCase();

      if (method === 'GET') {
        return new Response(JSON.stringify({ ok: true, online: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }

      if (method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Allow': 'GET, POST'
          }
        });
      }

      try {
        const result = await handlePaddleCheckoutCreate(request, env);
        return new Response(JSON.stringify(result), {
          status: result && result.ok ? 200 : (result && result.statusCode ? result.statusCode : 400),
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'checkout_create_failed',
          message: e && e.message ? e.message : 'Unknown error'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    // Mobile app: latest APK version for in-app update checks
    if (pathname === '/api/mobile/version') {
      const version = String(env.MOBILE_APP_VERSION || '1.0.0').trim();
      const versionCode = parseInt(String(env.MOBILE_VERSION_CODE || '1'), 10) || 1;
      const apkUrl = androidApkUrl(env, request.url);
      const notes = String(env.MOBILE_RELEASE_NOTES || '').trim();
      return new Response(JSON.stringify({
        ok: true,
        platform: 'android',
        version,
        versionCode,
        apkUrl: apkUrl || null,
        apkFilename: androidApkFilename(env),
        downloadPage: 'https://utkingdom.com/download/android',
        notes: notes || null,
        updatedAt: new Date().toISOString(),
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        }
      });
    }

    // App / website: user support message → inbox
    if (pathname === '/api/support/contact') {
      const method = (request.method || 'GET').toUpperCase();

      if (method === 'GET') {
        return new Response(JSON.stringify({ ok: true, online: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }

      if (method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Allow': 'GET, POST'
          }
        });
      }

      try {
        const result = await handleSupportContact(request, env);
        return new Response(JSON.stringify(result), {
          status: result && result.ok ? 200 : (result && result.statusCode ? result.statusCode : 400),
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'support_send_failed',
          message: e && e.message ? e.message : 'Unknown error'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    // Mobile app: send 4-digit verification code email (register/login)
    if (pathname === '/api/auth/send-verification-code') {
      const method = (request.method || 'GET').toUpperCase();

      if (method === 'GET') {
        return new Response(JSON.stringify({ ok: true, online: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }

      if (method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
          status: 405,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Allow': 'GET, POST'
          }
        });
      }

      try {
        const result = await handleSendVerificationCode(request, env);
        return new Response(JSON.stringify(result), {
          status: result && result.ok ? 200 : (result && result.statusCode ? result.statusCode : 400),
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'send_failed',
          message: e && e.message ? e.message : 'Unknown error'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    // Mobile OTP → Firebase custom token (avoids phone-side password-verify quota)
    if (pathname === '/api/auth/mobile-session') {
      if ((request.method || 'GET').toUpperCase() !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' }
        });
      }
      try {
        const result = await handleMobileSession(request, env);
        return new Response(JSON.stringify(result), {
          status: result && result.ok ? 200 : (result && result.statusCode ? result.statusCode : 400),
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (e) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'session_failed',
          message: e && e.message ? e.message : 'Unknown error'
        }), {
          status: 502,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    // WebSocket endpoint - proxy to your Python server
    if (pathname === '/ws' || pathname.startsWith('/ws/')) {
      return handleWebSocket(request, env);
    }
    
    // Update server endpoint for Electron auto-updates
    if (pathname.startsWith('/updates/')) {
      // Stream updater files directly from R2 using the stable /updates/ base.
      const key = pathname.slice(1); // remove leading slash
      const obj = await env.DOWNLOADS.get(key);
      if (!obj) {
        return new Response('Not found', { status: 404 });
      }

      const headers = new Headers();
      applyR2HttpMetadata(headers, obj.httpMetadata);

      const filename = key.split('/').pop() || 'download';
      applyReleaseDownloadHeaders(headers, filename);

      return new Response(obj.body, { status: obj.status || 200, headers });
    }
    
    // if requesting a release asset, just fetch it directly from the site (no proxy to Pages)
    if (pathname.startsWith('/releases/')) {
      // Legacy unversioned Android APK → redirect to UtopiaKingdom-<version>.apk
      // (Android names downloads from the final URL path; disposition alone is not enough.)
      if (
        pathname === '/releases/mobile/UtopiaKingdom-android.apk' ||
        pathname === '/releases/mobile/UtopiaKingdom.apk'
      ) {
        return redirectToVersionedApk(env, request);
      }

      // stream the object directly from R2 bucket binding
      const key = pathname.slice(1); // remove leading slash
      const obj = await env.DOWNLOADS.get(key);
      if (!obj) {
        return new Response('Not found', { status: 404 });
      }
      const headers = new Headers();
      // Skip R2 Content-Disposition — keep the URL basename / versioned name authoritative
      if (obj.httpMetadata) {
        if (obj.httpMetadata.contentType) headers.set('Content-Type', obj.httpMetadata.contentType);
        if (obj.httpMetadata.contentEncoding) headers.set('Content-Encoding', obj.httpMetadata.contentEncoding);
      }

      const filename = key.split('/').pop() || 'download';
      applyReleaseDownloadHeaders(headers, filename);

      return new Response(obj.body, { status: obj.status || 200, headers });
    }

    // Serve static content from R2 if file exists under "site/"
    const hasExtension = (() => {
      try {
        const last = pathname.split('/').filter(Boolean).pop() || '';
        return last.includes('.');
      } catch {
        return false;
      }
    })();

    const candidatePaths = [];
    if (pathname === '/' || pathname === '/index.html') {
      candidatePaths.push('/index.html');
    } else if (pathname.endsWith('/')) {
      candidatePaths.push(pathname + 'index.html');
    } else {
      candidatePaths.push(pathname);
      if (!hasExtension) candidatePaths.push(pathname + '/index.html');
    }

    let staticObj = null;
    let usedPath = null;
    for (const p of candidatePaths) {
      const key = `site${p}`;
      staticObj = await env.DOWNLOADS.get(key, { type: 'stream' });
      if (staticObj) {
        usedPath = p;
        break;
      }
    }

    if (staticObj) {
      const headers = new Headers(staticObj.httpMetadata || {});
      // simple content-type inference
      const path = usedPath || pathname;
      if (path.endsWith('.html')) headers.set('Content-Type', 'text/html; charset=utf-8');
      else if (path.endsWith('.js')) headers.set('Content-Type', 'application/javascript; charset=utf-8');
      else if (path.endsWith('.css')) headers.set('Content-Type', 'text/css; charset=utf-8');
      else if (path.endsWith('.json')) headers.set('Content-Type', 'application/json; charset=utf-8');
      else if (path.endsWith('.png')) headers.set('Content-Type', 'image/png');
      else if (path.endsWith('.jpg') || path.endsWith('.jpeg')) headers.set('Content-Type', 'image/jpeg');
      else if (path.endsWith('.svg')) headers.set('Content-Type', 'image/svg+xml');
      else if (path.endsWith('.woff2')) headers.set('Content-Type', 'font/woff2');
      else if (path.endsWith('.woff')) headers.set('Content-Type', 'font/woff');
      // Also add cache headers for assets
      if (path.startsWith('/assets/')) {
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return new Response(staticObj.body, { status: 200, headers });
    }
    // fallback to 404
    return new Response('Not found', { status: 404 });
  }
};

let _firebaseAccessToken = null;
let _firebaseAccessTokenExpMs = 0;

function base64UrlEncode(inputBytes) {
  let str = '';
  for (let i = 0; i < inputBytes.length; i++) str += String.fromCharCode(inputBytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8Bytes(str) {
  return new TextEncoder().encode(String(str || ''));
}

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function safeEqualStr(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function parsePaddleSignatureHeader(headerValue) {
  const header = String(headerValue || '').trim();
  if (!header) return null;
  const parts = header.split(';').map((p) => p.trim()).filter(Boolean);
  const out = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  if (!out.ts || !out.h1) return null;
  return { ts: out.ts, h1: out.h1 };
}

async function verifyPaddleWebhook(rawBodyText, signatureHeader, secret, toleranceSec = 300) {
  const webhookSecret = String(secret || '').trim();
  if (!webhookSecret) return { ok: false, error: 'missing_secret' };

  const parsed = parsePaddleSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, error: 'bad_signature_header' };

  const tsRaw = String(parsed.ts);
  const tsNum = Number(tsRaw);
  if (!Number.isFinite(tsNum)) return { ok: false, error: 'bad_timestamp' };

  const tsSec = tsNum > 1e12 ? Math.floor(tsNum / 1000) : tsNum;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsSec) > Number(toleranceSec || 300)) {
    return { ok: false, error: 'timestamp_out_of_tolerance' };
  }

  const signedPayload = `${tsRaw}:${rawBodyText}`;
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Bytes(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, utf8Bytes(signedPayload));
  const digestHex = bytesToHex(new Uint8Array(sigBuffer));

  return safeEqualStr(digestHex, String(parsed.h1 || '').toLowerCase())
    ? { ok: true }
    : { ok: false, error: 'bad_signature' };
}

function pemToArrayBuffer(pem) {
  const cleaned = String(pem || '')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getFirebaseAccessToken(env) {
  const now = Date.now();
  if (_firebaseAccessToken && now < (_firebaseAccessTokenExpMs - 60000)) return _firebaseAccessToken;

  const clientEmail = String(env.FIREBASE_CLIENT_EMAIL || '').trim();
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  let privateKeyPem = String(env.FIREBASE_PRIVATE_KEY || '');
  if (privateKeyPem.includes('\\n')) privateKeyPem = privateKeyPem.replace(/\\n/g, '\n');

  if (!clientEmail || !projectId || !privateKeyPem) {
    throw new Error('Missing FIREBASE_CLIENT_EMAIL/FIREBASE_PROJECT_ID/FIREBASE_PRIVATE_KEY secrets');
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp,
    scope: 'https://www.googleapis.com/auth/datastore'
  };

  const headerB64 = base64UrlEncode(utf8Bytes(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(utf8Bytes(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, utf8Bytes(signingInput));
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!tokenResp.ok) {
    const txt = await tokenResp.text();
    throw new Error(`Firebase token exchange failed: ${tokenResp.status} ${txt}`);
  }

  const tokenJson = await tokenResp.json();
  _firebaseAccessToken = tokenJson.access_token;
  _firebaseAccessTokenExpMs = Date.now() + (Number(tokenJson.expires_in || 3600) * 1000);
  return _firebaseAccessToken;
}

function extractEmailFromPaddlePayload(payload) {
  const data = payload && payload.data ? payload.data : payload;
  const custom = (data && data.custom_data) || (payload && payload.custom_data) || {};
  return (
    (data && data.customer && data.customer.email) ||
    (data && data.customer_email) ||
    custom.email ||
    custom.email_hint ||
    (data && data.email) ||
    (payload && payload.customer && payload.customer.email) ||
    null
  );
}

function extractUidFromPaddlePayload(payload) {
  const data = payload && payload.data ? payload.data : payload;
  const custom = (data && data.custom_data) || (payload && payload.custom_data) || {};
  const uid = custom.uid || custom.userId || custom.user_id || null;
  return uid ? String(uid).trim() : null;
}

function extractCustomerIdFromPaddlePayload(payload) {
  const data = payload && payload.data ? payload.data : payload;
  return (
    (data && data.customer_id) ||
    (data && data.customer && (data.customer.id || data.customer.customer_id)) ||
    (payload && payload.customer_id) ||
    null
  );
}

function firestoreUserDocName(env, uid) {
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  const id = String(uid || '').trim();
  if (!projectId || !id) return null;
  return `projects/${projectId}/databases/(default)/documents/users/${id}`;
}

async function resolvePaddleCustomerEmail(env, customerId) {
  const id = String(customerId || '').trim();
  const apiKey = String(env.PADDLE_API_KEY || '').trim();
  if (!id || !apiKey) return null;

  const resp = await fetch(`https://api.paddle.com/customers/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Paddle-Version': '1',
    },
  });
  if (!resp.ok) return null;
  const json = await resp.json().catch(() => null);
  const email = json && json.data && json.data.email ? String(json.data.email).trim() : '';
  return email || null;
}

function isActivationEvent(eventType) {
  const t = String(eventType || '').toLowerCase();
  return t === 'transaction.completed' || t === 'subscription.activated' || t === 'subscription.updated' || t === 'subscription.created';
}

function isDeactivationEvent(eventType) {
  const t = String(eventType || '').toLowerCase();
  return t === 'subscription.canceled' || t === 'subscription.cancelled' || t === 'subscription.paused' || t === 'subscription.expired';
}

async function findUserDocByEmail(env, accessToken, email) {
  const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
  if (!projectId) throw new Error('Missing FIREBASE_PROJECT_ID');

  const endpoint = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`;
  const queryBody = (mail) => ({
    structuredQuery: {
      from: [{ collectionId: 'users' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'email' },
          op: 'EQUAL',
          value: { stringValue: String(mail || '') }
        }
      },
      limit: 1
    }
  });

  const candidates = [String(email || '').trim(), String(email || '').trim().toLowerCase()].filter(Boolean);
  for (const candidate of candidates) {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(queryBody(candidate))
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Firestore runQuery failed: ${r.status} ${txt}`);
    }
    const rows = await r.json();
    const docRow = Array.isArray(rows) ? rows.find((x) => x && x.document && x.document.name) : null;
    if (docRow && docRow.document && docRow.document.name) return docRow.document.name;
  }
  return null;
}

async function patchUserSubscription(env, accessToken, docName, status) {
  const nowIso = new Date().toISOString();
  const patchFields = {
    subscriptionStatus: { stringValue: status === 'active' ? 'active' : 'inactive' },
    updatedAt: { timestampValue: nowIso }
  };

  if (status === 'active') {
    patchFields.paidUntil = { timestampValue: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() };
  }

  const updateMask = Object.keys(patchFields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const endpoint = `https://firestore.googleapis.com/v1/${docName}?${updateMask}`;

  const r = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ fields: patchFields })
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Firestore patch failed: ${r.status} ${txt}`);
  }
}

async function handlePaddleWebhook(request, env) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('paddle-signature') || request.headers.get('Paddle-Signature');
  const verified = await verifyPaddleWebhook(rawBody, sigHeader, env.PADDLE_WEBHOOK_SECRET, Number(env.PADDLE_WEBHOOK_TOLERANCE_SEC || 300));
  if (!verified.ok) return { ok: false, statusCode: 400, error: 'invalid_signature', detail: verified.error };

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, statusCode: 400, error: 'invalid_json' };
  }

  const eventType = payload.event_type || payload.type || payload.alert_name || '';
  if (!isActivationEvent(eventType) && !isDeactivationEvent(eventType)) {
    return { ok: true, received: true, note: 'unhandled_event', eventType };
  }

  let uid = extractUidFromPaddlePayload(payload);
  let email = extractEmailFromPaddlePayload(payload);
  const customerId = extractCustomerIdFromPaddlePayload(payload);

  if (!email && customerId) {
    try {
      email = await resolvePaddleCustomerEmail(env, customerId);
    } catch (e) {
      console.error('Paddle customer lookup failed:', e && e.message ? e.message : e);
    }
  }

  const accessToken = await getFirebaseAccessToken(env);
  let docName = uid ? firestoreUserDocName(env, uid) : null;
  if (!docName && email) {
    docName = await findUserDocByEmail(env, accessToken, email);
    if (docName) {
      // Recover uid from document name for logging
      const parts = String(docName).split('/');
      uid = parts[parts.length - 1] || uid;
    }
  }

  if (!docName) {
    return {
      ok: true,
      received: true,
      note: 'no_user',
      eventType,
      email: email || null,
      uid: uid || null,
      customerId: customerId || null,
    };
  }

  const status = isActivationEvent(eventType) ? 'active' : 'inactive';
  await patchUserSubscription(env, accessToken, docName, status);

  return {
    ok: true,
    received: true,
    eventType,
    email: email || null,
    uid: uid || null,
    status,
  };
}

function handlePaddleCheckoutPage(request, env) {
  const reqUrl = new URL(request.url);
  const token = String(env.PADDLE_CLIENT_TOKEN || '').trim();
  const priceId = String(reqUrl.searchParams.get('priceId') || reqUrl.searchParams.get('price_id') || env.PADDLE_DEFAULT_PRICE_ID || '').trim();
  const email = String(reqUrl.searchParams.get('email') || '').trim();
  const uid = String(reqUrl.searchParams.get('uid') || reqUrl.searchParams.get('userId') || '').trim();

  if (!token || !priceId) {
    return new Response('Paddle checkout is not configured on the server.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  const jsToken = JSON.stringify(token);
  const jsPriceId = JSON.stringify(priceId);
  const jsEmail = JSON.stringify(email);
  const jsUid = JSON.stringify(uid);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Utopia Kingdom — Subscribe</title>
  <script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0a0a14; color:#fff; font-family:Inter,Segoe UI,Arial,sans-serif; }
    .box { text-align:center; padding:24px; max-width:420px; }
    .muted { color:#9aa0a6; font-size:14px; margin-top:12px; line-height:1.5; }
    .err { color:#ff6b6b; margin-top:16px; font-size:14px; white-space:pre-wrap; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Opening secure checkout…</h1>
    <p class="muted">Complete payment below, then return to the Utopia Kingdom app. Access unlocks automatically after payment.</p>
    <p id="err" class="err" hidden></p>
  </div>
  <script>
    (async function () {
      const token = ${jsToken};
      const priceId = ${jsPriceId};
      const email = ${jsEmail};
      const uid = ${jsUid};
      const errEl = document.getElementById('err');
      const titleEl = document.querySelector('h1');
      const mutedEl = document.querySelector('.muted');

      function fail(msg) {
        errEl.hidden = false;
        errEl.textContent = msg || 'Could not open checkout.';
      }

      try {
        Paddle.Environment.set('production');
        Paddle.Initialize({
          token: token,
          eventCallback: function (data) {
            if (!data || !data.name) return;
            if (data.name === 'checkout.completed') {
              titleEl.textContent = 'Payment received';
              mutedEl.textContent = 'You can close this tab and return to the app.';
            }
            if (data.name === 'checkout.error') {
              const detail = data.data && (data.data.detail || data.data.message)
                ? String(data.data.detail || data.data.message)
                : 'Checkout error.';
              fail(detail);
            }
          }
        });

        const openPayload = {
          items: [{ priceId: priceId, quantity: 1 }],
          settings: { displayMode: 'overlay', theme: 'dark', locale: 'en' },
          customData: {
            source: 'utopia-kingdom-app',
            email: email || null,
            email_hint: email || null,
            uid: uid || null
          }
        };
        if (email) openPayload.customer = { email: email };

        await Paddle.Checkout.open(openPayload);
      } catch (e) {
        fail(e && e.message ? e.message : 'Failed to initialize Paddle.');
      }
    })();
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function handlePaddleCheckoutCreate(request, env) {
  let body = null;
  try {
    body = await request.json();
  } catch {
    return { ok: false, statusCode: 400, error: 'invalid_json' };
  }

  const priceId = String((body && (body.priceId || body.price_id)) || '').trim();
  const email = String((body && body.email) || '').trim();
  const uid = String((body && (body.uid || body.userId || body.user_id)) || '').trim();
  if (!priceId) return { ok: false, statusCode: 400, error: 'missing_price_id' };

  const apiKey = String(env.PADDLE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, statusCode: 500, error: 'missing_paddle_api_key' };

  const txPayload = {
    items: [{ price_id: priceId, quantity: 1 }],
    collection_mode: 'automatic',
    custom_data: {
      source: 'utopia-kingdom-app',
      email_hint: email || null,
      email: email || null,
      uid: uid || null
    }
  };

  if (email) {
    txPayload.customer = { email };
  }

  const resp = await fetch('https://api.paddle.com/transactions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Paddle-Version': '1'
    },
    body: JSON.stringify(txPayload)
  });

  let json = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }

  const checkoutUrl = json && json.data && json.data.checkout && json.data.checkout.url
    ? String(json.data.checkout.url).trim()
    : '';

  if (!resp.ok || !checkoutUrl) {
    const detail = json && json.error && (json.error.detail || json.error.code)
      ? String(json.error.detail || json.error.code)
      : `Paddle API error (${resp.status})`;
    return { ok: false, statusCode: 400, error: 'paddle_api_error', detail };
  }

  return {
    ok: true,
    url: checkoutUrl,
    priceId,
    email: email || null
  };
}

async function handleWebSocket(request, env) {
  // Only accept WebSocket upgrade requests
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Upgrade header required', { status: 400 });
  }

  // Create a WebSocketPair to handle the client
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Start server-side handler to proxy to upstream
  server.accept();
  handleServerSocket(server, env);

  // Return the client socket to the browser
  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

async function handleServerSocket(server, env) {
  // Convert wss:// to https:// for Cloudflare fetch, which handles WS upgrade
  const upstreamWss = env.WS_SERVER_URL + '/ws';
  const upstreamHttps = upstreamWss.replace(/^wss:/, 'https:');
  
  try {
    console.log('Connecting to upstream via https:', upstreamHttps);
    
    // Make fetch request with WebSocket upgrade header
    const upstream = await fetch(upstreamHttps, {
      headers: { 
        'Upgrade': 'websocket',
        'Connection': 'upgrade'
      }
    });
    
    const upstreamWs = upstream.webSocket;
    if (!upstreamWs) {
      console.error('No webSocket in response');
      server.send(JSON.stringify({ error: 'Upstream did not provide webSocket' }));
      server.close();
      return;
    }
    
    console.log('Upstream connected via https->wss conversion');
    upstreamWs.accept();

    // Pipe messages both ways
    server.addEventListener('message', (event) => {
      try {
        upstreamWs.send(event.data);
      } catch (e) {
        console.error('Error sending to upstream:', e);
      }
    });

    upstreamWs.addEventListener('message', (event) => {
      try {
        server.send(event.data);
      } catch (e) {
        console.error('Error sending to client:', e);
      }
    });

    server.addEventListener('close', () => {
      upstreamWs.close();
    });

    upstreamWs.addEventListener('close', () => {
      server.close();
    });

    server.addEventListener('error', (e) => {
      console.error('Client error:', e);
      upstreamWs.close();
    });

    upstreamWs.addEventListener('error', (e) => {
      console.error('Upstream error:', e);
      server.close();
    });
  } catch (err) {
    console.error('Upstream connection failed:', err);
    server.send(JSON.stringify({ error: 'Upstream connection failed: ' + err.message }));
    server.close();
  }
}

async function handleUpdates(request, env) {
  const url = new URL(request.url);

  // Keep APP_VERSION as the "pointer" to the latest published release.
  const version = (env.APP_VERSION || '').trim();
  if (!version) {
    return new Response('Update not configured', { status: 500 });
  }

  // Decode %20 etc so filenames with spaces work.
  const pathname = (() => {
    try { return decodeURIComponent(url.pathname); } catch { return url.pathname; }
  })();

  // /updates/latest.yml → serve the real builder-generated YAML from R2
  if (pathname === '/updates/latest.yml') {
    const key = `releases/v${version}/latest.yml`;
    const obj = await env.DOWNLOADS.get(key, { type: 'stream' });
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers(obj.httpMetadata || {});
    headers.set('Content-Type', headers.get('Content-Type') || 'text/yaml; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    return new Response(obj.body, { status: 200, headers });
  }

  // /updates/<asset> → serve matching asset from releases/v<version>/
  if (pathname.startsWith('/updates/')) {
    const assetName = pathname.slice('/updates/'.length);
    if (!assetName) return new Response('Not found', { status: 404 });
    const key = `releases/v${version}/${assetName}`;
    const obj = await env.DOWNLOADS.get(key, { type: 'stream' });
    if (!obj) return new Response('Not found', { status: 404 });

    const headers = new Headers(obj.httpMetadata || {});
    // Ensure executable downloads behave like downloads in browsers
    if (assetName.toLowerCase().endsWith('.exe')) {
      headers.set('Content-Type', headers.get('Content-Type') || 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename="${assetName}"`);
    }
    return new Response(obj.body, { status: 200, headers });
  }

  return new Response('Update not found', { status: 404 });
}

const SUPPORT_RATE = new Map();
const SUPPORT_RATE_WINDOW_MS = 3 * 60 * 1000;
/** Per-email OTP send throttle (Worker isolate memory — best-effort). */
const OTP_SEND_RATE = new Map();
const OTP_SEND_COOLDOWN_MS = 45 * 1000;
const OTP_SEND_HOUR_MS = 60 * 60 * 1000;
const OTP_SEND_MAX_PER_HOUR = 8;
/** email → { code, exp } best-effort cache (not relied on across isolates). */
const OTP_STORE = new Map();
const OTP_TTL_MS = 10 * 60 * 1000;
const FIREBASE_WEB_API_KEY_DEFAULT = 'AIzaSyCQdYOL6Tng3GgpRtFEUE7uy3aypmh7cMU';

async function otpHmacHex(env, message) {
  const secret = String(
    env.OTP_HMAC_SECRET || env.PADDLE_WEBHOOK_SECRET || env.FIREBASE_PROJECT_ID || 'utk-otp-fallback'
  );
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8Bytes(message));
  return bytesToHex(new Uint8Array(sig));
}

async function createOtpTicket(env, email, code, exp) {
  const payload = `${email}:${code}:${exp}`;
  const sig = await otpHmacHex(env, payload);
  return `${exp}.${sig}`;
}

async function verifyOtpTicket(env, email, code, ticket) {
  const raw = String(ticket || '');
  const dot = raw.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = await otpHmacHex(env, `${email}:${code}:${exp}`);
  return safeEqualStr(expected, String(sig || '').toLowerCase());
}

function supportClientKey(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  ).split(',')[0].trim();
}

function sanitizeEmailProviderError(errText, statusCode) {
  const raw = String(errText || '');
  if (/quota exceeded|resource.?exhausted|rateLimitExceeded|user-rate-limit/i.test(raw)) {
    return {
      ok: false,
      statusCode: 429,
      error: 'email_quota',
      message: 'Email sending is temporarily limited. Wait a minute and try again.',
    };
  }
  if (raw.trim().startsWith('{') || raw.length > 180) {
    return {
      ok: false,
      statusCode: statusCode || 502,
      error: 'email_provider_failed',
      message: 'Could not send verification email. Try again in a minute.',
    };
  }
  return {
    ok: false,
    statusCode: statusCode || 502,
    error: 'email_provider_failed',
    message: raw || 'Email provider failed',
  };
}

function checkOtpSendRate(email) {
  const key = String(email || '').toLowerCase();
  const now = Date.now();
  const prev = OTP_SEND_RATE.get(key) || { last: 0, hourStart: now, count: 0 };
  if (now - prev.hourStart > OTP_SEND_HOUR_MS) {
    prev.hourStart = now;
    prev.count = 0;
  }
  if (now - prev.last < OTP_SEND_COOLDOWN_MS) {
    return {
      ok: false,
      statusCode: 429,
      error: 'rate_limited',
      message: 'Please wait a moment before requesting another code.',
    };
  }
  if (prev.count >= OTP_SEND_MAX_PER_HOUR) {
    return {
      ok: false,
      statusCode: 429,
      error: 'rate_limited',
      message: 'Too many verification emails. Try again later.',
    };
  }
  prev.last = now;
  prev.count += 1;
  OTP_SEND_RATE.set(key, prev);
  return null;
}

function escapeHtmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function supportTopicLabel(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'problem') return 'Problem';
  if (k === 'beta') return 'Beta tester';
  return 'Support';
}

function normalizeSupportKind(kind) {
  const k = String(kind || 'support').trim().toLowerCase();
  return k === 'problem' || k === 'beta' ? k : 'support';
}

/** Free app access until this date. Override with Worker env BETA_ENDS_AT (ISO). */
function betaEndsIso(env) {
  const raw = String((env && env.BETA_ENDS_AT) || '2026-12-31T23:59:59.000Z').trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '2026-12-31T23:59:59.000Z';
}

async function grantBetaAccess(env, email) {
  const mail = String(email || '').trim().toLowerCase();
  if (!mail) return { ok: false, reason: 'no_email' };
  try {
    const accessToken = await getFirebaseAccessToken(env);
    const docName = await findUserDocByEmail(env, accessToken, mail);
    if (!docName) return { ok: false, reason: 'user_not_found' };

    const nowIso = new Date().toISOString();
    const untilIso = betaEndsIso(env);
    const patchFields = {
      betaTester: { booleanValue: true },
      betaRequestedAt: { timestampValue: nowIso },
      subscriptionStatus: { stringValue: 'active' },
      paidUntil: { timestampValue: untilIso },
      updatedAt: { timestampValue: nowIso },
    };
    const updateMask = Object.keys(patchFields)
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join('&');
    const endpoint = `https://firestore.googleapis.com/v1/${docName}?${updateMask}`;
    const r = await fetch(endpoint, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ fields: patchFields }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return { ok: false, reason: `firestore_${r.status}`, detail: txt.slice(0, 200) };
    }
    return { ok: true, until: untilIso };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'grant_failed' };
  }
}

async function handleSupportContact(request, env) {
  const key = supportClientKey(request);
  const now = Date.now();
  const last = SUPPORT_RATE.get(key) || 0;
  if (now - last < SUPPORT_RATE_WINDOW_MS) {
    return {
      ok: false,
      statusCode: 429,
      error: 'rate_limited',
      message: 'Please wait a few minutes before sending another message.',
    };
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return { ok: false, statusCode: 400, error: 'invalid_json', message: 'Invalid JSON body' };
  }

  const message = String(body.message || '').trim();
  const replyEmail = String(body.email || body.fromEmail || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 80);
  const kind = normalizeSupportKind(body.kind || body.topic || 'support');
  const topicLabel = supportTopicLabel(kind);

  if (message.length < 10) {
    return { ok: false, statusCode: 400, error: 'message_too_short', message: 'Message must be at least 10 characters.' };
  }
  if (message.length > 4000) {
    return { ok: false, statusCode: 400, error: 'message_too_long', message: 'Message is too long (max 4000 characters).' };
  }
  if (kind === 'beta' && !replyEmail) {
    return { ok: false, statusCode: 400, error: 'invalid_email', message: 'Sign in so we can unlock beta on your account.' };
  }
  if (replyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)) {
    return { ok: false, statusCode: 400, error: 'invalid_email', message: 'Valid email is required.' };
  }

  let betaGranted = false;
  let betaUntil = '';
  let betaGrantNote = '';
  if (kind === 'beta') {
    const grant = await grantBetaAccess(env, replyEmail);
    betaGranted = !!(grant && grant.ok);
    betaUntil = (grant && grant.until) || betaEndsIso(env);
    betaGrantNote = betaGranted
      ? `Beta access granted until ${betaUntil}.`
      : `Beta email received. Access not auto-granted (${(grant && grant.reason) || 'unknown'}).`;
  }

  const inbox = (env.SUPPORT_INBOX || env.EMAIL_FROM || 'utopiakingdomreal@gmail.com').trim();
  const fromEmail = (env.EMAIL_FROM || 'utopiakingdomreal@gmail.com').trim();
  const fromName = (env.EMAIL_FROM_NAME || 'Utopia Kingdom').trim();
  const subject = `[App ${topicLabel}] ${name || replyEmail || 'User'} - Utopia Kingdom`;
  const safeMessage = escapeHtmlText(message).replace(/\n/g, '<br>');
  const safeName = escapeHtmlText(name || '—');
  const safeEmail = escapeHtmlText(replyEmail || 'not provided');
  const betaLine = kind === 'beta'
    ? `<p style="color:#00ff88;margin:0 0 16px;"><strong>Beta:</strong> ${escapeHtmlText(betaGrantNote)}</p>`
    : '';
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0a0a14;color:#fff;">
<div style="max-width:640px;margin:0 auto;padding:20px;background:#121212;border-radius:10px;border:1px solid #333;">
<div style="font-size:20px;font-weight:bold;color:#00ff88;margin-bottom:16px;">UTOPIA KINGDOM · ${escapeHtmlText(topicLabel)}</div>
<p style="color:#9aa0a6;margin:0 0 8px;"><strong>From:</strong> ${safeName}</p>
<p style="color:#9aa0a6;margin:0 0 8px;"><strong>Reply email:</strong> ${safeEmail}</p>
<p style="color:#9aa0a6;margin:0 0 16px;"><strong>Source:</strong> Utopia Kingdom App</p>
${betaLine}
<div style="background:#1a1a24;border:1px solid #333;border-radius:8px;padding:16px;color:#fff;line-height:1.55;">${safeMessage}</div>
</div></body></html>`;

  const sendResult = await sendSupportMail(env, {
    fromEmail,
    fromName,
    toEmail: inbox,
    replyTo: replyEmail || null,
    subject,
    html,
  });

  if (!sendResult || !sendResult.ok) {
    return sendResult || {
      ok: false,
      statusCode: 503,
      error: 'email_not_configured',
      message: 'Support email is not configured on the server.',
    };
  }

  SUPPORT_RATE.set(key, now);
  const out = { ok: true };
  if (kind === 'beta') {
    out.betaGranted = betaGranted;
    if (betaUntil) out.betaUntil = betaUntil;
  }
  return out;
}

async function sendSupportMail(env, { fromEmail, fromName, toEmail, replyTo, subject, html }) {
  const resendKey = (env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    const payload = {
      from: `${fromName} <${fromEmail}>`,
      to: [toEmail],
      subject,
      html,
    };
    if (replyTo) payload.reply_to = replyTo;
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return {
        ok: false,
        statusCode: 502,
        error: 'email_provider_failed',
        message: errText || `Email provider returned ${resp.status}`,
      };
    }
    return { ok: true };
  }

  const gmailResult = await sendVerificationViaGmail(env, {
    fromEmail,
    fromName,
    toEmail,
    replyTo,
    subject,
    html,
  });
  if (gmailResult) return gmailResult;

  return null;
}

async function handleSendVerificationCode(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return { ok: false, statusCode: 400, error: 'invalid_json', message: 'Invalid JSON body' };
  }

  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, statusCode: 400, error: 'invalid_email', message: 'Valid email is required' };
  }
  if (!/^\d{4}$/.test(code)) {
    return { ok: false, statusCode: 400, error: 'invalid_code', message: '4-digit code is required' };
  }

  const rate = checkOtpSendRate(email);
  if (rate) return rate;

  // Remember code server-side (best-effort) + return signed ticket for cross-isolate verify.
  const exp = Date.now() + OTP_TTL_MS;
  OTP_STORE.set(email, { code, exp });
  const ticket = await createOtpTicket(env, email, code, exp);

  const fromEmail = (env.EMAIL_FROM || 'utopiakingdomreal@gmail.com').trim();
  const fromName = (env.EMAIL_FROM_NAME || 'Utopia Kingdom').trim();
  const subject = 'Your Utopia Kingdom Verification Code';
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#0a0a14;color:#fff;">
<div style="max-width:600px;margin:0 auto;padding:20px;background:#121212;border-radius:10px;border:1px solid #333;">
<div style="text-align:center;margin-bottom:24px;"><div style="font-size:24px;font-weight:bold;color:#00ff88;">UTOPIA KINGDOM</div></div>
<p style="color:#9aa0a6;">Your verification code:</p>
<div style="background:#1a1a24;border:2px solid #00ff88;border-radius:8px;padding:20px;text-align:center;margin:24px 0;">
<div style="font-size:48px;font-weight:bold;color:#00ff88;letter-spacing:10px;">${code}</div>
</div>
<p style="color:#9aa0a6;"><strong>Code expires in 10 minutes</strong></p>
</div></body></html>`;

  // Option 1: Resend API (set RESEND_API_KEY in Worker secrets)
  const resendKey = (env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: [email],
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return sanitizeEmailProviderError(errText, 502);
    }
    return { ok: true, ticket };
  }

  // Option 2: Gmail API via OAuth refresh (same account as desktop app)
  // Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (or EMAIL_*) as Worker secrets.
  const gmailResult = await sendVerificationViaGmail(env, {
    fromEmail,
    fromName,
    toEmail: email,
    subject,
    html,
  });
  if (gmailResult) {
    if (gmailResult.ok) return { ...gmailResult, ticket };
    return gmailResult;
  }

  // Option 3: Forward to custom backend (set AUTH_EMAIL_WEBHOOK)
  const webhook = (env.AUTH_EMAIL_WEBHOOK || '').trim();
  if (webhook) {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, subject, html }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return {
        ok: false,
        statusCode: 502,
        error: 'webhook_failed',
        message: errText || `Webhook returned ${resp.status}`,
      };
    }
    return { ok: true, ticket };
  }

  return {
    ok: false,
    statusCode: 503,
    error: 'email_not_configured',
    message: 'Verification email is not configured. Set GMAIL_REFRESH_TOKEN (or RESEND_API_KEY / AUTH_EMAIL_WEBHOOK) on the Worker.',
  };
}

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function getGmailAccessToken(env) {
  const clientId = (env.GMAIL_CLIENT_ID || env.EMAIL_CLIENT_ID || '').trim();
  const clientSecret = (env.GMAIL_CLIENT_SECRET || env.EMAIL_CLIENT_SECRET || '').trim();
  const refreshToken = (env.GMAIL_REFRESH_TOKEN || env.EMAIL_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) return null;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error('Gmail token refresh failed:', resp.status, errText);
    return null;
  }
  const data = await resp.json().catch(() => ({}));
  return data.access_token || null;
}

/** Returns a result object if Gmail creds are present; null if not configured. */
async function sendVerificationViaGmail(env, { fromEmail, fromName, toEmail, replyTo, subject, html }) {
  const clientId = (env.GMAIL_CLIENT_ID || env.EMAIL_CLIENT_ID || '').trim();
  const clientSecret = (env.GMAIL_CLIENT_SECRET || env.EMAIL_CLIENT_SECRET || '').trim();
  const refreshToken = (env.GMAIL_REFRESH_TOKEN || env.EMAIL_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) return null;

  const accessToken = await getGmailAccessToken(env);
  if (!accessToken) {
    return {
      ok: false,
      statusCode: 502,
      error: 'gmail_auth_failed',
      message: 'Could not refresh Gmail access token. Re-check GMAIL_* Worker secrets.',
    };
  }

  const mimeLines = [
    `From: ${fromName} <${fromEmail}>`,
    `To: ${toEmail}`,
  ];
  if (replyTo) mimeLines.push(`Reply-To: ${replyTo}`);
  mimeLines.push(
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  );
  const mime = mimeLines.join('\r\n');

  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: toBase64Url(mime) }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return sanitizeEmailProviderError(errText || `Gmail API returned ${resp.status}`, 502);
  }
  return { ok: true };
}

async function handleMobileSession(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return { ok: false, statusCode: 400, error: 'invalid_json', message: 'Invalid JSON body' };
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const code = String(body.code || '').trim();
  const mode = String(body.mode || 'login').trim().toLowerCase() === 'register' ? 'register' : 'login';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, statusCode: 400, error: 'invalid_email', message: 'Valid email is required' };
  }
  if (!password || password.length < 6) {
    return { ok: false, statusCode: 400, error: 'invalid_password', message: 'Password is required' };
  }
  if (!/^\d{4}$/.test(code)) {
    return { ok: false, statusCode: 400, error: 'invalid_code', message: '4-digit code is required' };
  }

  const stored = OTP_STORE.get(email);
  const ticket = String(body.ticket || '');
  const ticketOk = ticket ? await verifyOtpTicket(env, email, code, ticket) : false;
  const storeOk = !!(stored && stored.code && stored.exp && Date.now() <= stored.exp && String(stored.code) === code);
  if (!ticketOk && !storeOk) {
    if (stored && stored.code && String(stored.code) !== code) {
      return { ok: false, statusCode: 400, error: 'invalid_code', message: 'Invalid verification code.' };
    }
    return {
      ok: false,
      statusCode: 400,
      error: 'code_expired',
      message: 'Verification code expired. Request a new one.',
    };
  }

  const apiKey = String(env.FIREBASE_WEB_API_KEY || FIREBASE_WEB_API_KEY_DEFAULT).trim();
  let uid = null;
  let passwordOk = false;

  if (mode === 'register') {
    const signedUp = await firebasePasswordSignUp(apiKey, email, password);
    if (signedUp.ok) {
      uid = signedUp.localId;
      passwordOk = true;
    } else if (signedUp.exists) {
      // Existing account — continue as login below
    } else {
      // Client signup quota / other errors → create via Admin API (no password-verify quota)
      const created = await firebaseAdminCreateUser(env, email, password);
      if (created.ok) {
        uid = created.localId;
        passwordOk = true;
      } else if (created.exists) {
        // fall through to login
      } else {
        return {
          ok: false,
          statusCode: 400,
          error: 'register_failed',
          message: created.message || signedUp.message || 'Could not create account.',
        };
      }
    }
  }

  if (!uid) {
    // Prefer Admin lookup + custom token so phone/account password-verify quota cannot block login.
    // Still attempt password check when Firebase allows it, to reject wrong passwords.
    const signedIn = await firebasePasswordSignIn(apiKey, email, password);
    if (signedIn.invalid) {
      return {
        ok: false,
        statusCode: 401,
        error: 'invalid_credentials',
        message: 'Email or password is incorrect.',
      };
    }
    if (signedIn.ok) {
      uid = signedIn.localId;
      passwordOk = true;
    } else {
      const lookedUp = await firebaseAdminLookupUid(env, email);
      if (!lookedUp.ok || !lookedUp.localId) {
        return {
          ok: false,
          statusCode: signedIn.quota ? 429 : 400,
          error: signedIn.quota ? 'quota' : 'login_failed',
          message: lookedUp.message || signedIn.message || 'Login failed.',
        };
      }
      uid = lookedUp.localId;
      // Password API quota/unavailable — OTP + existing account is enough to mint session.
      passwordOk = false;
    }
  }

  const tokenResult = await mintFirebaseCustomToken(env, uid);
  if (!tokenResult.ok) {
    return tokenResult;
  }

  // One-time code
  OTP_STORE.delete(email);

  return {
    ok: true,
    customToken: tokenResult.customToken,
    uid,
    passwordVerified: passwordOk,
  };
}

async function firebasePasswordSignIn(apiKey, email, password) {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await resp.json().catch(() => ({}));
  if (resp.ok && data.localId) {
    return { ok: true, localId: String(data.localId) };
  }
  const msg = String((data.error && data.error.message) || '');
  if (/QUOTA_EXCEEDED|TOO_MANY_ATTEMPTS/i.test(msg)) {
    return { ok: false, quota: true, message: msg };
  }
  if (/INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|USER_DISABLED/i.test(msg)) {
    return { ok: false, invalid: true, message: msg };
  }
  return { ok: false, message: msg || `Auth failed (${resp.status})` };
}

async function firebasePasswordSignUp(apiKey, email, password) {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const data = await resp.json().catch(() => ({}));
  if (resp.ok && data.localId) {
    return { ok: true, localId: String(data.localId) };
  }
  const msg = String((data.error && data.error.message) || '');
  if (/EMAIL_EXISTS/i.test(msg)) {
    return { ok: false, exists: true, message: msg };
  }
  if (/QUOTA_EXCEEDED|TOO_MANY_ATTEMPTS/i.test(msg)) {
    return { ok: false, quota: true, message: msg };
  }
  return { ok: false, message: msg || `Signup failed (${resp.status})` };
}

function resolveFirebaseServiceAccount(env) {
  const raw = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    try {
      const sa = JSON.parse(raw);
      if (sa && sa.private_key && sa.client_email) return sa;
    } catch {
      /* fall through */
    }
  }
  const clientEmail = String(env.FIREBASE_CLIENT_EMAIL || '').trim();
  const projectId = String(env.FIREBASE_PROJECT_ID || 'utopiakingdom-c7d19').trim();
  let privateKey = String(env.FIREBASE_PRIVATE_KEY || '');
  if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) return null;
  return { client_email: clientEmail, private_key: privateKey, project_id: projectId };
}

async function getIdentityToolkitAccessToken(env) {
  const sa = resolveFirebaseServiceAccount(env);
  if (!sa) {
    return { ok: false, message: 'Missing Firebase service account secrets.' };
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/identitytoolkit',
  };
  const headerB64 = base64UrlEncode(utf8Bytes(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(utf8Bytes(JSON.stringify(claim)));
  const signingInput = `${headerB64}.${payloadB64}`;
  try {
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, utf8Bytes(signingInput));
    const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    const tokenJson = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok || !tokenJson.access_token) {
      return {
        ok: false,
        message: tokenJson.error_description || tokenJson.error || 'Failed to get Identity Toolkit token',
      };
    }
    return { ok: true, accessToken: String(tokenJson.access_token), projectId: String(sa.project_id || 'utopiakingdom-c7d19') };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'Token exchange failed' };
  }
}

async function firebaseAdminLookupUid(env, email) {
  const token = await getIdentityToolkitAccessToken(env);
  if (!token.ok) return { ok: false, message: token.message };

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${token.projectId}/accounts:lookup`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: [email] }),
    }
  );
  const data = await resp.json().catch(() => ({}));
  const user = data.users && data.users[0];
  if (!resp.ok || !user || !user.localId) {
    return { ok: false, message: 'Account not found for OTP fallback login.' };
  }
  return { ok: true, localId: String(user.localId) };
}

async function firebaseAdminCreateUser(env, email, password) {
  const token = await getIdentityToolkitAccessToken(env);
  if (!token.ok) return { ok: false, message: token.message };

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${token.projectId}/accounts`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        emailVerified: true,
      }),
    }
  );
  const data = await resp.json().catch(() => ({}));
  if (resp.ok && (data.localId || (data.user && data.user.localId))) {
    return { ok: true, localId: String(data.localId || data.user.localId) };
  }
  const msg = String((data.error && data.error.message) || data.error || '');
  if (/EMAIL_EXISTS|ALREADY_EXISTS/i.test(msg)) {
    return { ok: false, exists: true, message: msg };
  }
  return { ok: false, message: msg || `Admin create failed (${resp.status})` };
}

async function mintFirebaseCustomToken(env, uid) {
  const sa = resolveFirebaseServiceAccount(env);
  if (!sa || !sa.private_key || !sa.client_email) {
    return {
      ok: false,
      statusCode: 503,
      error: 'not_configured',
      message: 'Server session minting is not configured.',
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: String(uid),
  };

  try {
    const headerB64 = base64UrlEncode(utf8Bytes(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(utf8Bytes(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, utf8Bytes(signingInput));
    return { ok: true, customToken: `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}` };
  } catch (e) {
    return {
      ok: false,
      statusCode: 502,
      error: 'token_mint_failed',
      message: e && e.message ? e.message : 'Could not mint login token',
    };
  }
}
