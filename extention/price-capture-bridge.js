/**

 * Isolated-world bridge: page hook ↔ extension background.

 * Injects the MAIN-world hook and relays ticks + keepalive commands.

 */

(function () {

  if (window.__utkPriceBridgeLoaded) return;

  window.__utkPriceBridgeLoaded = true;



  function injectHook() {

    try {

      if (document.documentElement.querySelector("script[data-utk-price-hook]")) return;

      const s = document.createElement("script");

      s.src = chrome.runtime.getURL("price-capture-hook.js");

      s.async = false;

      s.dataset.utkPriceHook = "1";

      s.onload = () => {

        try {

          s.remove();

        } catch (_) {}

      };

      (document.documentElement || document.head || document.body).appendChild(s);

    } catch (_) {}

  }



  injectHook();

  if (document.readyState === "loading") {

    document.addEventListener("DOMContentLoaded", injectHook, { once: true });

  }



  function postToPage(payload) {

    try {

      window.postMessage({ source: "utk-price-capture-cmd", ...payload }, "*");

    } catch (_) {}

  }



  window.addEventListener("message", (ev) => {

    try {

      const data = ev && ev.data;

      if (!data || data.source !== "utk-price-capture") return;

      if (data.type === "ticks" && Array.isArray(data.ticks) && data.ticks.length) {

        chrome.runtime.sendMessage({ type: "price-capture-ticks", ticks: data.ticks }).catch(() => {});

      } else if (data.type === "hook-ready") {

        chrome.runtime.sendMessage({ type: "price-capture-hook-ready" }).catch(() => {});

      } else if (data.type === "keepalive-status" || data.type === "hook-status") {

        chrome.runtime.sendMessage({ type: "price-capture-hook-event", event: data }).catch(() => {});

      }

    } catch (_) {}

  });



  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (!msg || !msg.type) return;

    if (msg.type === "price-capture-set-assets") {

      postToPage({ type: "set-assets", assets: msg.assets || [] });

      sendResponse({ ok: true });

      return true;

    }

    if (msg.type === "price-capture-set-keepalive") {

      postToPage({ type: "set-keepalive", enabled: !!msg.enabled });

      sendResponse({ ok: true });

      return true;

    }

    if (msg.type === "price-capture-resub-dead") {

      postToPage({ type: "resub-dead", assets: msg.assets || [] });

      sendResponse({ ok: true });

      return true;

    }

    if (msg.type === "price-capture-ping-hook") {

      postToPage({ type: "ping-hook" });

      sendResponse({ ok: true });

      return true;

    }

  });

})();

