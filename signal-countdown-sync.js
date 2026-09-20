/**
 * Anchor LUMIX/MIRAX Trading countdown to bot openedAtMs (not receive Date.now()).
 * Used by renderer handlePhaseMessage so UI Close matches history Open+expiry.
 */
(function () {
  function toMs(v) {
    try {
      if (typeof window !== 'undefined' && typeof window.toEpochMs === 'function') {
        return window.toEpochMs(v);
      }
    } catch (e) {}
    if (v == null || v === '' || v === 'N/A') return null;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
    }
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e11) return Math.round(n);
    const s = String(v).trim();
    const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?$/);
    if (naive) {
      const ms = new Date(
        Number(naive[1]), Number(naive[2]) - 1, Number(naive[3]),
        Number(naive[4]), Number(naive[5]), Number(naive[6] || 0)
      ).getTime();
      return Number.isFinite(ms) ? ms : null;
    }
    const d = Date.parse(s);
    return Number.isFinite(d) ? d : null;
  }

  function remainingFromOpen(signal, durationSec) {
    const dur = Math.max(0, Number(durationSec) || 0);
    if (!dur) return null;
    const openMs =
      toMs(signal && signal.openedAtMs) ||
      toMs(signal && signal.openingTime) ||
      toMs(signal && signal.time);
    if (!openMs) return null;
    const endMs = openMs + dur * 1000;
    return Math.max(0, Math.ceil((endMs - Date.now()) / 1000));
  }

  try {
    window.__utkRemainingFromOpen = remainingFromOpen;
  } catch (e) {}
})();
