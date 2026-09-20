/**
 * MAIN-world WebSocket hook (pocketoption.com).
 * Captures ticks + keeps OTC subs alive on the PO socket (no UI clicking).
 */
(function () {
  if (window.__utkPriceHookInstalled) return;
  window.__utkPriceHookInstalled = true;

  const TICK_RE = /\[\["#?([A-Za-z0-9\-]+)_otc",([\d.]+),([\d.]+)\]\]/g;
  const OriginalWebSocket = window.WebSocket;
  const poSockets = new Set();
  const seenCodes = new Set();

  let keepAliveAssets = [];
  let deadAssets = [];
  let keepAliveEnabled = false;
  let keepAliveTimer = null;
  let lastKeepAliveAt = 0;
  let lastSubCount = 0;
  let rotateIdx = 0;

  function isPoUrl(url) {
    try {
      return /po\.market|pocketoption\.com/i.test(String(url || ""));
    } catch (_) {
      return false;
    }
  }

  function emitTicks(text) {
    if (!text || typeof text !== "string") return;
    const ticks = [];
    TICK_RE.lastIndex = 0;
    let m;
    while ((m = TICK_RE.exec(text)) !== null) {
      const code = String(m[1] || "").toUpperCase();
      if (!code) continue;
      seenCodes.add(code);
      ticks.push({ code, price: Number(m[3]) });
    }
    if (!ticks.length) return;
    try {
      window.postMessage({ source: "utk-price-capture", type: "ticks", ticks }, "*");
    } catch (_) {}
  }

  function pickSocket() {
    let best = null;
    for (const ws of poSockets) {
      try {
        if (!ws || ws.readyState !== OriginalWebSocket.OPEN) continue;
        best = ws;
      } catch (_) {}
    }
    return best;
  }

  function assetCandidatesFromCode(code) {
    const c = String(code || "").trim();
    if (!c) return [];
    const body = c.toLowerCase().endsWith("_otc") ? c.slice(0, -4) : c;
    const bare = body.replace(/^#/, "");
    const out = [];
    const push = (a) => {
      if (a && !out.includes(a)) out.push(a);
    };
    push(`${bare}_otc`);
    push(`#${bare}_otc`);
    if (bare.includes("-")) {
      push(`${bare.replace(/-/g, "")}_otc`);
      push(`#${bare.replace(/-/g, "")}_otc`);
    }
    return out;
  }

  function buildFullAssetList() {
    const out = [];
    const seen = new Set();
    const add = (asset) => {
      const a = String(asset || "").trim();
      if (!a || seen.has(a)) return;
      seen.add(a);
      out.push(a);
    };
    for (const a of keepAliveAssets) add(a);
    for (const code of seenCodes) {
      for (const a of assetCandidatesFromCode(code)) add(a);
    }
    return out;
  }

  function sendSubfor(ws, assets) {
    let sent = 0;
    for (const asset of assets) {
      try {
        ws.send(`42["subfor","${asset}"]`);
        sent += 1;
      } catch (_) {}
    }
    try {
      ws.send('42["ps"]');
    } catch (_) {}
    return sent;
  }

  function postStatus(ok, reason, assets) {
    try {
      window.postMessage(
        {
          source: "utk-price-capture",
          type: "keepalive-status",
          ok: !!ok,
          reason: reason || "",
          assets: Number(assets || 0),
          at: Date.now(),
        },
        "*"
      );
    } catch (_) {}
  }

  /**
   * Prefer dead-only resubs. If none, gently rotate a small chunk of the full list
   * so quiet pairs don't go stale — never clicks the PO UI.
   */
  function runKeepAlive(forceAssets) {
    if (!keepAliveEnabled) return;
    const ws = pickSocket();
    if (!ws) {
      postStatus(false, "no_po_socket", 0);
      return;
    }

    let list = Array.isArray(forceAssets) ? forceAssets.filter(Boolean) : null;
    if (!list || !list.length) {
      if (deadAssets.length) {
        list = deadAssets.slice();
      } else {
        const all = buildFullAssetList();
        if (!all.length) return;
        // Light rotate: ~25 assets/sec instead of blasting 100+ every tick.
        const chunk = 25;
        if (rotateIdx >= all.length) rotateIdx = 0;
        list = all.slice(rotateIdx, rotateIdx + chunk);
        rotateIdx = (rotateIdx + chunk) % Math.max(all.length, 1);
      }
    }

    try {
      const sent = sendSubfor(ws, list);
      lastKeepAliveAt = Date.now();
      lastSubCount = sent;
      postStatus(true, forceAssets && forceAssets.length ? "dead_only" : "rotate", sent);
    } catch (e) {
      postStatus(false, (e && e.message) || "send_failed", 0);
    }
  }

  function scheduleKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (!keepAliveEnabled) return;
    runKeepAlive();
    keepAliveTimer = setInterval(() => runKeepAlive(), 1000);
  }

  function wrapSocket(ws, url) {
    try {
      if (isPoUrl(url)) {
        poSockets.add(ws);
        try {
          ws.addEventListener("open", () => {
            if (keepAliveEnabled) runKeepAlive();
          });
        } catch (_) {}
        ws.addEventListener("close", () => {
          try {
            poSockets.delete(ws);
          } catch (_) {}
          postStatus(false, "po_socket_closed", 0);
        });
      }
      ws.addEventListener("message", (ev) => {
        try {
          const data = ev && ev.data;
          if (typeof data === "string") emitTicks(data);
          else if (data instanceof ArrayBuffer) emitTicks(new TextDecoder().decode(data));
          else if (data && typeof Blob !== "undefined" && data instanceof Blob) {
            data.text().then(emitTicks).catch(() => {});
          }
        } catch (_) {}
      });
    } catch (_) {}
    return ws;
  }

  function PatchedWebSocket(url, protocols) {
    const ws =
      protocols !== undefined
        ? new OriginalWebSocket(url, protocols)
        : new OriginalWebSocket(url);
    return wrapSocket(ws, url);
  }

  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  Object.assign(PatchedWebSocket, OriginalWebSocket);
  try {
    Object.defineProperty(PatchedWebSocket, "CONNECTING", { value: OriginalWebSocket.CONNECTING });
    Object.defineProperty(PatchedWebSocket, "OPEN", { value: OriginalWebSocket.OPEN });
    Object.defineProperty(PatchedWebSocket, "CLOSING", { value: OriginalWebSocket.CLOSING });
    Object.defineProperty(PatchedWebSocket, "CLOSED", { value: OriginalWebSocket.CLOSED });
  } catch (_) {}

  window.WebSocket = PatchedWebSocket;

  window.addEventListener("message", (ev) => {
    try {
      const data = ev && ev.data;
      if (!data || data.source !== "utk-price-capture-cmd") return;

      if (data.type === "set-assets" && Array.isArray(data.assets)) {
        keepAliveAssets = data.assets.map((a) => String(a || "").trim()).filter(Boolean);
      } else if (data.type === "resub-dead" && Array.isArray(data.assets)) {
        deadAssets = data.assets.map((a) => String(a || "").trim()).filter(Boolean);
        if (keepAliveEnabled) runKeepAlive(deadAssets);
      } else if (data.type === "set-keepalive") {
        keepAliveEnabled = !!data.enabled;
        if (!keepAliveEnabled) deadAssets = [];
        scheduleKeepAlive();
      } else if (data.type === "ping-hook") {
        window.postMessage(
          {
            source: "utk-price-capture",
            type: "hook-status",
            sockets: poSockets.size,
            assets: keepAliveAssets.length,
            dead: deadAssets.length,
            seen: seenCodes.size,
            keepAlive: keepAliveEnabled,
            lastKeepAliveAt,
            lastSubCount,
          },
          "*"
        );
      }
    } catch (_) {}
  });

  window.postMessage({ source: "utk-price-capture", type: "hook-ready" }, "*");
})();
