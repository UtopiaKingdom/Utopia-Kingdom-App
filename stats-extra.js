// Deprecated: stats logic moved to bot-stats.js
// Kept as a no-op shim in case anything still requires this path.
(function () {
  if (window.__utkBotStats && typeof window.__utkBotStats.recomputeAll === 'function') {
    window.__updateTotalWins = window.__utkBotStats.recomputeAll;
  }
})();
