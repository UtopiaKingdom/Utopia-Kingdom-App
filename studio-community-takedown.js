/**
 * studio-community-takedown.js — Remove published tape (reason + zero viewers).
 * Load AFTER community-hub.js and bot-studio-dialog.js.
 */
(function () {
  'use strict';

  function hub() {
    return window.__utkCommunityHub || null;
  }

  function toast(msg, tone) {
    try {
      if (typeof window.showAppToast === 'function') {
        window.showAppToast(msg, { tone: tone || 'info' });
      }
    } catch (e) {}
  }

  function isPublished(bot) {
    return !!(bot && (bot.published || bot.globalId));
  }

  async function audience(gid) {
    const api = hub() && hub().api;
    if (!api || !gid) return { watching: 0, trading: 0 };
    const data = await api('GET', '/studio/global/audience?id=' + encodeURIComponent(gid));
    return {
      watching: Number(data.watching || 0),
      trading: Number(data.trading || 0)
    };
  }

  async function request(bot, opts) {
    opts = opts || {};
    if (!isPublished(bot)) return { ok: true, skipped: true };

    const gid = bot.globalId;
    const api = hub() && hub().api;
    if (!api) {
      toast('Server offline.', 'error');
      return { ok: false };
    }

    let counts = { watching: 0, trading: 0 };
    try {
      counts = await audience(gid);
    } catch (e) {
      toast('Could not check who is on your desk.', 'error');
      return { ok: false };
    }

    const active = counts.watching + counts.trading;
    if (active > 0) {
      const line = counts.watching > 0
        ? counts.watching + ' still on your tape'
        : counts.trading + ' with auto trade on';
      toast('Wait until no one is watching (' + line + ').', 'error');
      return { ok: false, active: active };
    }

    const dlg = window.__utkStudioDialog;
    let reason = '';
    if (dlg && typeof dlg.reason === 'function') {
      reason = await dlg.reason({
        kicker: 'Community',
        title: opts.title || 'Remove from Community',
        message: opts.message || 'Tell people why you are taking this tape down. Your recipe stays private.',
        label: 'Why are you taking it down?',
        ok: opts.ok || 'Remove from Feed',
        cancel: 'Keep sharing',
        minLength: 12,
        danger: !!opts.danger
      });
    } else {
      toast('Could not open the form.', 'error');
      return { ok: false };
    }
    if (!reason) return { ok: false };

    try {
      await api('POST', '/studio/unpublish', {
        id: bot.id,
        globalId: gid,
        reason: reason
      });
      bot.published = false;
      return { ok: true, reason: reason };
    } catch (err) {
      const msg = (err && err.body && err.body.message) || 'Could not remove from Community.';
      toast(String(msg).replace(/_/g, ' '), 'error');
      return { ok: false };
    }
  }

  window.__utkStudioTakedown = {
    isPublished: isPublished,
    audience: audience,
    request: request
  };
})();
