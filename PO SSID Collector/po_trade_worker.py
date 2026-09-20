#!/usr/bin/env python3
"""Long-lived Pocket Option trade worker — avoids Python cold-start per signal.

Stdin is processed one request at a time, so concurrent LUMIX + MIRAX trades
sharing one SSID are naturally serialized. Each trade re-primes its own asset
so a warm for bot A cannot leave bot B on the wrong pair.

Peaceful browser mode:
  - status without a currency never calls subscribe_symbol.
  - warm WITH a currency primes/subscribes that pair (SSID autotrade).
  - trade still re-primes so a warm for bot A cannot leave bot B on the wrong pair.
"""

from __future__ import annotations

import json
import logging
import math
import re
import sys
import threading
import time
import traceback

# Some BinaryOptionsToolsV2 builds call logger.warn (removed alias) and crash.
if not hasattr(logging.Logger, "warn"):
    logging.Logger.warn = logging.Logger.warning  # type: ignore[attr-defined]
else:
    try:
        logging.Logger.warn = logging.Logger.warning  # type: ignore[method-assign]
    except Exception:
        pass

try:
    from BinaryOptionsToolsV2.pocketoption import PocketOption
except ImportError:
    from BinaryOptionsToolsV2.pocketoption import PocketOption  # type: ignore

from execute_trade import currency_to_asset
from po_ssid import detect_account_from_ssid, parse_balance_response, resolve_payout_asset
from po_ssid_closed_feed import (
    ensure_closed_feed,
    kick_closed_refresh,
    list_closed_deals,
    peek_closed_deal,
    stop_closed_feed,
)
import po_payout_truth as payout_truth


def _normalize_ssid(raw: str) -> str:
    """Accept messy pastes (smart quotes, wrappers, leading junk) for BOTV2."""
    s = str(raw or "").strip()
    if not s:
        return s
    # Normalize fancy quotes copied from Discord/browsers.
    s = (
        s.replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("'", '"')
    )
    # Extract the auth frame if the user pasted surrounding text.
    idx = s.find('42["auth"')
    if idx == -1:
        idx = s.find("42[\"auth\"")
    if idx > 0:
        s = s[idx:]
    # If they pasted only the JSON object, wrap it.
    if s.startswith("{") and '"session"' in s and '"isDemo"' in s:
        s = f'42["auth",{s}]'
    return s.strip()

_sessions: dict[str, PocketOption] = {}
_session_ssids: dict[str, str] = {}
_subscribed_asset: dict[str, str] = {}
_session_locks: dict[str, threading.Lock] = {}
_session_last_ok: dict[str, float] = {}
_global_lock = threading.Lock()
_payout_cache: dict[str, dict] = {}
# Never let PO sockets go quiet while autotrade is armed.
_KEEPALIVE_SEC = 8.0
_payout_cache_at: dict[str, float] = {}
_balance_cache: dict[str, tuple[float, float]] = {}
_stdout_lock = threading.Lock()
_watch_lock = threading.Lock()
_watch_alive: dict[str, threading.Event] = {}


def _on_ssid_closed(deal_id: str, raw: dict, source: str) -> None:
    """PO just pushed this ticket closed — emit instantly if we are watching it."""
    needle = str(deal_id or "").strip()
    if not needle:
        return
    watched = None
    with _watch_lock:
        if needle in _watch_alive:
            watched = needle
        else:
            for wid in _watch_alive:
                if wid.startswith(needle[:8]) or needle.startswith(wid[:8]):
                    watched = wid
                    break
    if not watched:
        return
    outcome, profit, deal = _classify_outcome(raw)
    if not outcome:
        return
    try:
        _learn_payout_from_settle(outcome, profit, deal if isinstance(deal, dict) else raw)
    except Exception:
        pass
    _write_json({
        "event": "deal_settled",
        "success": True,
        "pending": False,
        "deal_id": watched,
        "outcome": outcome,
        "profit": profit,
        "deal": deal if isinstance(deal, dict) else raw,
        "source": source or "ssid_closed",
    })


def _ensure_closed_feed(ssid: str) -> None:
    try:
        ensure_closed_feed(ssid, on_closed=_on_ssid_closed)
    except Exception:
        pass


def _write_json(obj: dict) -> None:
    """Thread-safe one-JSON-object-per-line stdout (stdin replies + settle events)."""
    line = json.dumps(obj, ensure_ascii=True)
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _as_unix_seconds(value, fallback: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n) or n <= 0:
        return fallback
    if n > 1e12:
        n = n / 1000.0
    return n


def _session_key(ssid: str) -> str:
    return str(hash(ssid.strip()))


def _remember_balance(ssid: str, balance_value) -> None:
    try:
        bal = float(balance_value)
    except (TypeError, ValueError):
        return
    if math.isfinite(bal) and bal > 0:
        _balance_cache[_session_key(ssid)] = (bal, time.time())


def _lock_for(ssid: str) -> threading.Lock:
    key = _session_key(ssid)
    with _global_lock:
        lock = _session_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _session_locks[key] = lock
        return lock


def _get_api(ssid: str) -> PocketOption:
    key = _session_key(ssid)
    api = _sessions.get(key)
    if api is None:
        api = PocketOption(ssid=ssid.strip())
        api.__enter__()
        _sessions[key] = api
        _session_ssids[key] = ssid.strip()
    _ensure_closed_feed(ssid)
    return api


def _mark_session_ok(ssid: str) -> None:
    _session_last_ok[_session_key(ssid)] = time.time()


def _refresh_session(ssid: str) -> None:
    """Heal a half-dead PO socket before the next buy (prefer reconnect)."""
    key = _session_key(ssid)
    with _lock_for(ssid):
        _subscribed_asset.pop(key, None)
        api = _sessions.get(key)
        if api is not None:
            try:
                api.reconnect()
                _mark_session_ok(ssid)
                return
            except Exception:
                pass
            try:
                _close_session(ssid)
            except Exception:
                pass
        _get_api(ssid)
        _mark_session_ok(ssid)


def _ensure_session_ready(ssid: str) -> None:
    """Always prove the socket is live before buy — never place on a quiet pipe."""
    try:
        with _lock_for(ssid):
            api = _get_api(ssid)
            api.balance()
        _mark_session_ok(ssid)
        return
    except Exception:
        pass
    _refresh_session(ssid)
    with _lock_for(ssid):
        api = _get_api(ssid)
        api.balance()
    _mark_session_ok(ssid)


def _payout_for(ssid: str, api: PocketOption, *, fresh: bool = False) -> dict:
    key = _session_key(ssid)
    now = time.time()
    cached = _payout_cache.get(key)
    # Mid-chain recovery checks need fresher data than the 120s warm cache.
    ttl = 8.0 if fresh else 120.0
    if cached is not None and (now - _payout_cache_at.get(key, 0)) < ttl:
        return cached
    try:
        data = api.payout() or {}
        if isinstance(data, dict) and data:
            _payout_cache[key] = data
            _payout_cache_at[key] = now
            return data
    except Exception:
        pass
    return cached or {}


def _currency_payout(
    ssid: str,
    currency: str,
    *,
    fresh: bool = True,
    duration_sec: int | None = None,
) -> dict:
    """Live payout % for one display currency (e.g. EUR/USD OTC).

    Applies observed floors for this expiry bucket so catalog 92% cannot mask
    a known 78% 30s lock.
    """
    started = time.time()
    cur = str(currency or "").strip()
    if not cur:
        return {"success": False, "error": "missing currency"}

    with _lock_for(ssid):
        api = _get_api(ssid)
        payout_data = _payout_for(ssid, api, fresh=fresh)
        if not payout_data:
            return {
                "success": False,
                "error": "empty payout map",
                "currency": cur,
                "latency_ms": int((time.time() - started) * 1000),
            }
        try:
            asset = currency_to_asset(cur, payout_data=payout_data)
        except Exception as e:
            return {
                "success": False,
                "error": f"asset map failed: {e}",
                "currency": cur,
                "latency_ms": int((time.time() - started) * 1000),
            }

        raw = None
        if asset in payout_data:
            raw = payout_data.get(asset)
        else:
            hit = resolve_payout_asset(asset, payout_data) or resolve_payout_asset(cur, payout_data)
            if hit and hit in payout_data:
                asset = hit
                raw = payout_data.get(hit)

        try:
            payout_f = float(raw)
        except (TypeError, ValueError):
            return {
                "success": False,
                "error": f"no payout for {asset}",
                "currency": cur,
                "asset": asset,
                "latency_ms": int((time.time() - started) * 1000),
            }

        catalog_i = int(round(payout_f))
        effective = payout_truth.effective_payout(catalog_i, asset or cur, duration_sec)
        payout_i = int(effective if effective is not None else catalog_i)
        observed = payout_truth.get_observed(asset or cur, duration_sec)
        return {
            "success": True,
            "currency": cur,
            "asset": asset,
            "payout": payout_i,
            "catalog_payout": catalog_i,
            "observed_payout": observed,
            "duration_sec": int(duration_sec) if duration_sec else None,
            "latency_ms": int((time.time() - started) * 1000),
        }


def _prime_asset(ssid: str, currency: str) -> str:
    api = _get_api(ssid)
    payout = _payout_for(ssid, api)
    asset = currency_to_asset(currency, payout_data=payout)
    key = _session_key(ssid)
    prev = _subscribed_asset.get(key)
    if prev != asset:
        # Do not wait on unsubscribe — pair-switch saves were taking 7s+.
        api.subscribe_symbol(asset)
        _subscribed_asset[key] = asset
    return asset


def _close_session(ssid: str) -> None:
    key = _session_key(ssid)
    prev = _subscribed_asset.pop(key, None)
    _session_ssids.pop(key, None)
    _session_last_ok.pop(key, None)
    api = _sessions.pop(key, None)
    if api is not None:
        if prev:
            try:
                api.unsubscribe(prev)
            except Exception:
                pass
        try:
            api.__exit__(None, None, None)
        except Exception:
            pass


def _is_reconnectable_ws_error(exc_or_msg) -> bool:
    """Dead PO sockets must reconnect once — not skip the live signal."""
    msg = str(exc_or_msg or "").lower()
    needles = (
        "half closed",
        "half-closed",
        "connection closed",
        "connection is closed",
        "keepalive ping timeout",
        "sender error",
        "not connected",
        "connection reset",
        "broken pipe",
        "no close frame",
        "went away",
        "transfer_data",
        "websocket is closed",
        "websocket connection is closed",
        "cannot call send",
        "1006",
    )
    return any(n in msg for n in needles)


def _balance_only(ssid: str, *, currency_hint: str = "USD") -> dict:
    """Keep / probe the persistent session without touching chart subscriptions."""
    account = detect_account_from_ssid(ssid)
    default_currency = (currency_hint or ("USD" if account == "demo" else "EUR")).upper()
    started = time.time()

    def _probe() -> object:
        with _lock_for(ssid):
            api = _get_api(ssid)
            return api.balance()

    try:
        bal_raw = _probe()
    except Exception:
        # One reconnect — a dead socket must not flip the app to Offline.
        try:
            with _lock_for(ssid):
                _close_session(ssid)
        except Exception:
            pass
        bal_raw = _probe()
    balance_value, currency = parse_balance_response(
        bal_raw,
        default_currency=default_currency,
    )
    elapsed_ms = int((time.time() - started) * 1000)
    _remember_balance(ssid, balance_value)
    _mark_session_ok(ssid)
    return {
        "success": True,
        "online": True,
        "connected": True,
        "account": account,
        "is_demo": account == "demo",
        "balance": balance_value,
        "currency": currency,
        "latency_ms": elapsed_ms,
        "expired": False,
    }


def _warm(ssid: str, currency: str | None = None) -> dict:
    # Prefetch payout so the first trade after enable is not a 7s cold map.
    # If a currency is given (Preparing / incoming Signal), subscribe now so
    # buy/sell does not pay that cost at click time.
    started = time.time()
    asset = None
    with _lock_for(ssid):
        api = _get_api(ssid)
        _payout_for(ssid, api, fresh=False)
        if currency:
            try:
                asset = _prime_asset(ssid, currency)
            except Exception:
                asset = None
        bal_raw = api.balance()
    account = detect_account_from_ssid(ssid)
    default_currency = "USD" if account == "demo" else "EUR"
    balance_value, bal_cur = parse_balance_response(
        bal_raw, default_currency=default_currency
    )
    elapsed_ms = int((time.time() - started) * 1000)
    _remember_balance(ssid, balance_value)
    _mark_session_ok(ssid)
    return {
        "success": True,
        "warmed": True,
        "asset": asset,
        "latency_ms": elapsed_ms,
        "balance": balance_value,
        "currency": bal_cur,
        "online": True,
    }


def _status(ssid: str, currency_hint: str = "USD") -> dict:
    return _balance_only(ssid, currency_hint=currency_hint)


_TURBO_EXPIRIES = (5, 15, 20, 30, 60, 120, 180)
_BINARY_EXPIRIES = (180, 300, 600)


def _expiry_try_list(requested: int) -> list[int]:
    """Full 30s fails mid-candle (IncorrectExpTime). Retry remaining / 15 / 5.

    NYX 3m/5m/10m must stay that timeframe — never demote a 5m click into turbo.
    """
    req = max(5, int(requested or 0))
    out: list[int] = []
    if req >= 180:
        snapped = min(_BINARY_EXPIRIES, key=lambda a: abs(a - req))
        out.append(int(snapped))
        if req not in out:
            out.append(req)
        return out
    if req not in out:
        out.append(req)
    for a in reversed(_TURBO_EXPIRIES):
        if a <= req and a not in out:
            out.append(a)
    if 5 not in out:
        out.append(5)
    return out


def _open_order(api, side_norm: str, asset: str, amount_f: float, duration_i: int):
    last_err = None
    used = duration_i
    for dur in _expiry_try_list(duration_i):
        used = dur
        try:
            if side_norm == "BUY":
                deal_id, deal_data = api.buy(asset, amount_f, dur, check_win=False)
            else:
                deal_id, deal_data = api.sell(asset, amount_f, dur, check_win=False)
            if deal_id and str(deal_id).strip() not in {"", "None", "null"}:
                return deal_id, deal_data, dur, None
        except Exception as exc:
            last_err = exc
            if "IncorrectExpTime" not in str(exc):
                raise
            continue
    return None, None, used, last_err


def _trade(
    ssid: str,
    *,
    currency: str,
    side: str,
    amount: float,
    duration_sec: int,
    min_payout: int = 90,
    signal_payout: int | None = None,
    list_payout: int | None = None,
    gate_payout: int | None = None,
) -> dict:
    started = time.time()
    side_norm = str(side or "").upper().strip()
    amount_f = float(amount)
    duration_i = int(duration_sec)
    min_pay = payout_truth.parse_min_payout(min_payout, 90)

    if not math.isfinite(amount_f) or amount_f <= 0:
        return {"success": False, "error": "invalid amount"}

    # Hard floor in the worker — main.js bugs cannot bypass this.
    pay = _currency_payout(ssid, currency, fresh=True, duration_sec=duration_i)
    if not pay.get("success"):
        return {
            "success": False,
            "error": f"payout lookup failed: {pay.get('error') or 'unknown'}",
            "min_payout": min_pay,
            "latency_ms": int((time.time() - started) * 1000),
        }
    live_raw = int(pay.get("payout") or 0)
    catalog_pct = pay.get("catalog_payout")
    live_pct, pay_src = payout_truth.resolve_gate_payout(
        payout_pct=live_raw,
        catalog_pct=catalog_pct,
        signal_pay=signal_payout,
        list_pay=list_payout,
        gate_pay=gate_payout,
        abs_floor=min_pay,
    )
    if live_pct is None:
        live_pct = live_raw
    if live_pct < min_pay:
        return {
            "success": False,
            "error": f"payout {live_pct}% < {min_pay}%",
            "payout": live_pct,
            "catalog_payout": pay.get("catalog_payout"),
            "observed_payout": pay.get("observed_payout"),
            "signal_payout": signal_payout,
            "list_payout": list_payout,
            "gate_source": pay_src,
            "min_payout": min_pay,
            "currency": currency,
            "duration_sec": duration_i,
            "latency_ms": int((time.time() - started) * 1000),
        }

    # Heal quiet/dead sockets BEFORE buy — don't burn the live signal on a
    # half-closed channel (retry alone still races the entry window).
    try:
        _ensure_session_ready(ssid)
    except Exception as ready_err:
        try:
            _refresh_session(ssid)
            _ensure_session_ready(ssid)
        except Exception:
            return {
                "success": False,
                "error": f"session not ready: {ready_err}",
                "latency_ms": int((time.time() - started) * 1000),
            }

    last_err = None
    for attempt_i in range(2):
        try:
            out = _trade_once(
                ssid,
                currency=currency,
                side_norm=side_norm,
                amount_f=amount_f,
                duration_i=duration_i,
                started=started,
            )
            if (
                attempt_i == 0
                and not out.get("success")
                and _is_reconnectable_ws_error(out.get("error"))
            ):
                try:
                    _refresh_session(ssid)
                except Exception:
                    pass
                continue
            if out.get("success"):
                _mark_session_ok(ssid)
                out["payout"] = live_pct
                out["min_payout"] = min_pay
                # Learn from open payload if PO stamped a percent.
                deal = out.get("deal") if isinstance(out.get("deal"), dict) else None
                stamped = payout_truth.extract_pct_from_deal(deal) if deal else None
                if stamped is not None:
                    payout_truth.note_observed(
                        out.get("asset") or currency, duration_i, stamped, source="open"
                    )
            return out
        except Exception as exc:
            last_err = exc
            if attempt_i == 0 and _is_reconnectable_ws_error(exc):
                try:
                    _refresh_session(ssid)
                except Exception:
                    pass
                continue
            raise

    return {
        "success": False,
        "error": str(last_err) if last_err else "trade failed after reconnect",
        "latency_ms": int((time.time() - started) * 1000),
    }


def _trade_once(
    ssid: str,
    *,
    currency: str,
    side_norm: str,
    amount_f: float,
    duration_i: int,
    started: float,
) -> dict:
    with _lock_for(ssid):
        # Always re-prime from the trade payload — never trust a prior warm
        # (dual-bot autotrade may have subscribed a different pair).
        asset = _prime_asset(ssid, currency)
        api = _get_api(ssid)

        # Live wallet gate — never place a bet that wipes / exceeds balance.
        # Reuse a fresh cache from warm/status so buy() is not a second round-trip
        # behind the bot Open clock.
        try:
            account = detect_account_from_ssid(ssid)
            default_currency = "USD" if account == "demo" else "EUR"
            key = _session_key(ssid)
            cached_bal, cached_at = _balance_cache.get(key, (None, 0.0))
            if (
                cached_bal is not None
                and (time.time() - cached_at) < 5.0
                and amount_f < float(cached_bal) * 0.9
            ):
                balance_value = float(cached_bal)
            else:
                bal_raw = api.balance()
                balance_value, _currency = parse_balance_response(
                    bal_raw,
                    default_currency=default_currency,
                )
                if balance_value is not None:
                    _balance_cache[key] = (float(balance_value), time.time())
            if balance_value is not None:
                bal_f = float(balance_value)
                if math.isfinite(bal_f) and bal_f > 0 and amount_f >= bal_f:
                    return {
                        "success": False,
                        "error": f"insufficient balance: {amount_f} >= {bal_f}",
                        "balance": bal_f,
                        "amount": amount_f,
                        "asset": asset,
                    }
                if not (math.isfinite(bal_f) and bal_f > 0):
                    return {"success": False, "error": "balance unavailable"}
            else:
                return {"success": False, "error": "balance unavailable"}
        except Exception as bal_err:
            if _is_reconnectable_ws_error(bal_err):
                raise
            return {"success": False, "error": f"balance probe failed: {bal_err}"}

        deal_id, deal_data, duration_i, open_err = _open_order(
            api, side_norm, asset, amount_f, duration_i
        )
        if open_err and (deal_id is None or str(deal_id).strip() in {"", "None", "null"}):
            if _is_reconnectable_ws_error(open_err):
                raise open_err if isinstance(open_err, Exception) else RuntimeError(str(open_err))
            return {
                "success": False,
                "error": str(open_err),
                "asset": asset,
                "side": side_norm,
                "amount": amount_f,
                "duration_sec": duration_i,
                "latency_ms": int((time.time() - started) * 1000),
            }

        if deal_id:
            try:
                cached = _balance_cache.get(key)
                if cached:
                    _balance_cache[key] = (max(0.0, float(cached[0]) - amount_f), cached[1])
            except Exception:
                pass

        if deal_id is None or str(deal_id).strip() in {"", "None", "null"}:
            return {
                "success": False,
                "error": "PO returned no deal id",
                "asset": asset,
                "side": side_norm,
                "amount": amount_f,
                "latency_ms": int((time.time() - started) * 1000),
            }

        end_ts = None
        try:
            end_ts = api.get_deal_end_time(str(deal_id))
        except Exception:
            end_ts = None

    elapsed_ms = int((time.time() - started) * 1000)
    settle_unix = _as_unix_seconds(end_ts, time.time() + max(1, duration_i))
    expected = time.time() + max(1, duration_i)
    # PO get_deal_end_time is often hours off (timezone). Duration is the real expiry.
    if abs(settle_unix - expected) > max(30.0, duration_i * 0.35 + 5.0):
        settle_unix = expected
    _start_deal_watch(ssid, str(deal_id), settle_unix)
    return {
        "success": True,
        "deal_id": deal_id,
        "deal": deal_data if isinstance(deal_data, dict) else {"raw": deal_data},
        "asset": asset,
        "side": side_norm,
        "amount": amount_f,
        "duration_sec": duration_i,
        "settle_at": int(settle_unix * 1000),
        "latency_ms": elapsed_ms,
    }


def _classify_outcome(payload) -> tuple[str | None, float | None, dict | None]:
    """Normalize PO deal payloads into (outcome, profit, deal_dict)."""
    deal = payload
    if isinstance(payload, str):
        try:
            deal = json.loads(payload)
        except Exception:
            return None, None, None
    if not isinstance(deal, dict):
        return None, None, None

    profit = None
    # Never use "income" / "amount" — those are the stake, not PnL.
    for key in ("profit", "pnl"):
        if key in deal and deal[key] is not None:
            try:
                profit = float(deal[key])
                break
            except (TypeError, ValueError):
                pass

    # Money first — a green profit is a WIN even if PO labels it "loss".
    if profit is not None and profit > 0:
        return "win", profit, deal
    if profit is not None and profit < 0:
        return "loss", profit, deal

    raw = str(deal.get("result") or deal.get("outcome") or "").strip().lower()
    status = str(deal.get("status") or "").strip().lower()
    if status in {"win", "won", "w", "loss", "lose", "lost", "loose", "l", "draw", "tie", "equal", "refund"}:
        if not raw:
            raw = status
    # API "success" / "ok" / "open" is NOT a trade win.
    if raw in {"win", "won", "w"}:
        outcome = "win"
    elif raw in {"loss", "lose", "lost", "loose", "l", "fail", "failed"}:
        outcome = "loss"
    elif raw in {"draw", "tie", "equal", "refund"}:
        outcome = "draw"
    else:
        outcome = None

    if profit is not None and profit == 0:
        if outcome == "loss":
            return "loss", profit, deal
        return "draw", profit, deal

    # Label-only WIN without profit is not proof — leave unknown.
    if outcome == "win":
        return None, profit, deal

    if outcome is None:
        for key in ("win", "is_win", "won"):
            if key in deal:
                val = deal.get(key)
                if val is True or val == 1 or str(val).lower() in {"true", "1", "yes"}:
                    # Boolean win with no profit: still unconfirmed.
                    return None, profit, deal
                if val is False or val == 0 or str(val).lower() in {"false", "0", "no"}:
                    outcome = "loss"
                    break

    return outcome, profit, deal


_DEAL_ID_KEYS = ("id", "deal_id", "ticket", "openTradeId", "open_trade_id", "requestId")


def _deal_id_of(item) -> str:
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return ""
    for key in _DEAL_ID_KEYS:
        val = str(item.get(key) or "").strip()
        if val:
            return val
    for nested_key in ("deal", "trade", "data"):
        inner = item.get(nested_key)
        if inner and inner is not item:
            nested = _deal_id_of(inner)
            if nested:
                return nested
    return ""


def _deal_matches_id(deal, deal_id: str) -> bool:
    needle = str(deal_id or "").strip()
    if not needle:
        return False
    if _deal_id_of(deal) == needle:
        return True
    if isinstance(deal, dict):
        for key in _DEAL_ID_KEYS:
            if str(deal.get(key) or "").strip() == needle:
                return True
    return False


def _payload_has_foreign_id(deal: dict, deal_id: str) -> bool:
    """True when the payload names a different ticket than the one we asked for."""
    needle = str(deal_id or "").strip()
    if not needle or not isinstance(deal, dict):
        return False
    found_other = False
    for key in _DEAL_ID_KEYS:
        val = str(deal.get(key) or "").strip()
        if not val:
            continue
        if val == needle:
            return False
        found_other = True
    return found_other


def _settled_payload(deal_id_s: str, outcome: str, profit, deal, source: str, started: float) -> dict:
    try:
        _learn_payout_from_settle(outcome, profit, deal)
    except Exception:
        pass
    return {
        "success": True,
        "pending": False,
        "deal_id": deal_id_s,
        "outcome": outcome,
        "profit": profit,
        "deal": deal,
        "source": source,
        "latency_ms": int((time.time() - started) * 1000),
    }


def _learn_payout_from_settle(outcome: str, profit, deal) -> None:
    if str(outcome or "").lower() != "win":
        return
    if not isinstance(deal, dict):
        deal = {}
    asset = (
        deal.get("asset")
        or deal.get("symbol")
        or deal.get("currency")
        or deal.get("pair")
        or ""
    )
    amount = deal.get("amount") or deal.get("value") or deal.get("sum")
    dur = (
        deal.get("duration")
        or deal.get("time")
        or deal.get("expiration")
        or deal.get("exp")
    )
    pct = payout_truth.extract_pct_from_deal(deal)
    if pct is None:
        pct = payout_truth.infer_pct_from_profit(amount, profit)
    if pct is None or not asset:
        return
    payout_truth.note_observed(str(asset), dur, pct, source="settle")


def _pending_payload(deal_id_s: str, source: str, started: float, **extra) -> dict:
    out = {
        "success": True,
        "pending": True,
        "deal_id": deal_id_s,
        "outcome": None,
        "source": source,
        "latency_ms": int((time.time() - started) * 1000),
    }
    out.update(extra)
    return out


def _opened_item_settled(item):
    """Opened-list rows can already be settled (PO keeps them listed after a loss).

    profit 0 on an open ticket is still running — not a draw.
    Only money or an explicit loss label counts as settled.
    """
    if not isinstance(item, dict):
        return None, None, None
    outcome, profit, deal = _classify_outcome(item)
    if profit is not None and profit > 0:
        return "win", profit, deal
    if profit is not None and profit < 0:
        return "loss", profit, deal
    if outcome == "loss":
        return "loss", profit, deal
    return None, None, None


def _classify_listed_deal(item, deal_id_s: str, api):
    if not _deal_matches_id(item, deal_id_s):
        return None, None, None
    deal_obj = item
    if isinstance(item, str):
        getter = getattr(api, "get_closed_deal", None)
        if callable(getter):
            try:
                fetched = getter(item.strip())
                if isinstance(fetched, dict) and not _payload_has_foreign_id(fetched, deal_id_s):
                    deal_obj = fetched
                else:
                    deal_obj = {"id": item}
            except Exception:
                deal_obj = {"id": item}
        else:
            deal_obj = {"id": item}
    return _classify_outcome(deal_obj if isinstance(deal_obj, dict) else {"id": deal_id_s})


def _classify_check_win(raw, deal_id_s: str):
    """PO check_win payload → (outcome, profit, deal). Profit > 0 always wins."""
    if raw is None:
        return None
    if isinstance(raw, str):
        lab = raw.strip().lower()
        if lab in {"win", "won", "w"}:
            return "win", None, {"result": "win", "id": deal_id_s}
        if lab in {"loss", "lose", "lost", "loose", "l"}:
            return "loss", None, {"result": "loss", "id": deal_id_s}
        if lab in {"draw", "tie", "equal"}:
            return "draw", 0.0, {"result": "draw", "id": deal_id_s}
        try:
            raw = json.loads(raw)
        except Exception:
            return None
    outcome, profit, deal = _classify_outcome(raw)
    if profit is not None and profit > 0:
        return "win", profit, deal
    if profit is not None and profit < 0:
        return "loss", profit, deal
    if outcome:
        return outcome, profit, deal
    if isinstance(raw, dict):
        lab = str(raw.get("result") or raw.get("outcome") or "").strip().lower()
        if lab in {"win", "won", "w"}:
            return "win", profit, raw
        if lab in {"loss", "lose", "lost", "loose", "l"}:
            return "loss", profit, raw
    return None


def _check_deal(ssid: str, deal_id: str, *, allow_block: bool = False, fast: bool = False, ignore_open: bool = False) -> dict:
    """Resolve real account W/L for THIS ticket from the SSID closed-deal feed."""
    started = time.time()
    deal_id_s = str(deal_id or "").strip()
    if not deal_id_s:
        return {"success": False, "error": "missing deal_id", "pending": True}

    _ensure_closed_feed(ssid)
    hit = peek_closed_deal(ssid, deal_id_s)
    if isinstance(hit, dict):
        outcome, profit, deal = _classify_outcome(hit)
        if outcome:
            return _settled_payload(deal_id_s, outcome, profit, deal, "ssid_closed", started)

    with _lock_for(ssid):
        api = _get_api(ssid)

        getter = getattr(api, "get_closed_deal", None)
        if callable(getter):
            try:
                closed = getter(deal_id_s)
                if isinstance(closed, dict) and _payload_has_foreign_id(closed, deal_id_s):
                    closed = None
                outcome, profit, deal = _classify_outcome(closed)
                if outcome:
                    return _settled_payload(deal_id_s, outcome, profit, deal, "get_closed_deal", started)
            except Exception:
                pass

        opened_hit = False
        try:
            opened = api.opened_deals() or []
            for item in opened:
                if not _deal_matches_id(item, deal_id_s):
                    continue
                outcome, profit, deal = _opened_item_settled(item)
                if outcome:
                    return _settled_payload(deal_id_s, outcome, profit, deal, "opened_deals", started)
                opened_hit = True
                break
        except Exception:
            pass

        # Cheap peeks never call check_win (it can hold the session). After
        # expiry, MG/watch must — candle W/L is not the account on 2–3 pip OTC.
        if opened_hit and not ignore_open and not allow_block:
            return _pending_payload(deal_id_s, "opened_deals", started)

        if not fast:
            try:
                closed_list = api.closed_deals() or []
                for item in closed_list:
                    outcome, profit, deal = _classify_listed_deal(item, deal_id_s, api)
                    if outcome:
                        return _settled_payload(deal_id_s, outcome, profit, deal, "closed_deals", started)
            except Exception:
                pass

        # After expiry, ask PO for THIS ticket. Candle W/L disagrees on 2–3 pip OTC
        # moves (SELL +3 can still pay a WIN). Do not use the bot candle here.
        if allow_block and not fast:
            try:
                raw = api.check_win(deal_id_s)
                cw = _classify_check_win(raw, deal_id_s)
                if cw and cw[0]:
                    outcome, profit, deal = cw
                    return _settled_payload(deal_id_s, outcome, profit, deal, "check_win", started)
            except Exception:
                pass

        return _pending_payload(deal_id_s, "pending", started, hint="not_in_opened_or_closed")


def _list_opened(ssid: str) -> dict:
    """Live open tickets (no subscribe). Used to pick up a trade after app restart."""
    started = time.time()
    with _lock_for(ssid):
        api = _get_api(ssid)
        raw = []
        try:
            raw = api.opened_deals() or []
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "deals": [],
                "latency_ms": int((time.time() - started) * 1000),
            }
        deals = []
        for item in raw:
            rec: dict = {}
            if isinstance(item, str):
                rec["id"] = item.strip()
            elif isinstance(item, dict):
                rec["id"] = _deal_id_of(item)
                rec["asset"] = item.get("asset") or item.get("symbol") or item.get("currency")
                rec["currency"] = item.get("currency") or rec.get("asset")
                rec["amount"] = item.get("amount") or item.get("value")
                rec["side"] = item.get("direction") or item.get("action") or item.get("command")
                rec["profit"] = item.get("profit")
                rec["end_time"] = item.get("expiry") or item.get("closeTimestamp") or item.get("expired_at")
            else:
                continue
            if not rec.get("id"):
                continue
            try:
                end = api.get_deal_end_time(str(rec["id"]))
                if end:
                    rec["end_time"] = int(end)
            except Exception:
                pass
            deals.append(rec)
        return {
            "success": True,
            "deals": deals,
            "latency_ms": int((time.time() - started) * 1000),
        }


def _start_deal_watch(ssid: str, deal_id: str, settle_unix: float) -> bool:
    """Background settle: sleep until expiry, then read closed-trade history."""
    deal_id_s = str(deal_id or "").strip()
    if not ssid or not deal_id_s:
        return False
    settle = _as_unix_seconds(settle_unix, time.time() + 60.0)
    with _watch_lock:
        alive = _watch_alive.get(deal_id_s)
        if alive is not None and not alive.is_set():
            return False
        stop = threading.Event()
        _watch_alive[deal_id_s] = stop
    threading.Thread(
        target=_watch_until_settled,
        args=(ssid, deal_id_s, settle, stop),
        name=f"po-watch-{deal_id_s[:8]}",
        daemon=True,
    ).start()
    return True


def _summarize_deal(item) -> dict:
    """Compact row for the user's PO trade list (this SSID session)."""
    deal = item if isinstance(item, dict) else {"id": item}
    outcome, profit, payload = _classify_outcome(deal) if isinstance(deal, dict) else (None, None, None)
    rec = payload if isinstance(payload, dict) else deal
    if not isinstance(rec, dict):
        rec = {"id": str(item)}
    return {
        "id": _deal_id_of(rec) or _deal_id_of(item),
        "asset": rec.get("asset") or rec.get("symbol") or rec.get("currency"),
        "amount": rec.get("amount") or rec.get("value"),
        "side": rec.get("direction") or rec.get("action") or rec.get("command"),
        "profit": profit if profit is not None else rec.get("profit"),
        "outcome": outcome,
        "close_time": rec.get("closeTimestamp") or rec.get("close_time") or rec.get("expired_at"),
        "open_time": rec.get("openTimestamp") or rec.get("open_time") or rec.get("created_at"),
    }


def _list_user_trades(ssid: str, limit: int = 40) -> dict:
    """Opened + closed tickets for THIS SSID (live closed-deal feed first)."""
    started = time.time()
    _ensure_closed_feed(ssid)
    cap = max(1, min(200, int(limit or 40)))
    closed = [_summarize_deal(x) for x in list_closed_deals(ssid, limit=cap) if x]
    opened_raw = []
    closed_raw = []
    with _lock_for(ssid):
        api = _get_api(ssid)
        try:
            opened_raw = api.opened_deals() or []
        except Exception:
            pass
        if not closed:
            try:
                closed_raw = api.closed_deals() or []
            except Exception:
                pass
    opened = [_summarize_deal(x) for x in opened_raw if x]
    if not closed:
        closed = [_summarize_deal(x) for x in closed_raw if x]
    if cap > 0:
        closed = closed[:cap]
        opened = opened[-cap:]
    return {
        "success": True,
        "opened": opened,
        "closed": closed,
        "opened_count": len(opened),
        "closed_count": len(closed),
        "latency_ms": int((time.time() - started) * 1000),
    }


def _peek_closed_history(ssid: str, deal_id_s: str) -> dict:
    """Read THIS ticket from the SSID closed-trade feed. Never calls check_win."""
    started = time.time()
    needle = str(deal_id_s or "").strip()
    if not needle:
        return {"success": False, "pending": True, "error": "missing deal_id"}
    _ensure_closed_feed(ssid)
    hit = peek_closed_deal(ssid, needle)
    if isinstance(hit, dict):
        outcome, profit, deal = _classify_outcome(hit)
        if outcome:
            return _settled_payload(needle, outcome, profit, deal, "ssid_closed", started)
    with _lock_for(ssid):
        api = _get_api(ssid)
        getter = getattr(api, "get_closed_deal", None)
        if callable(getter):
            try:
                closed = getter(needle)
                if isinstance(closed, dict) and not _payload_has_foreign_id(closed, needle):
                    outcome, profit, deal = _classify_outcome(closed)
                    if outcome:
                        return _settled_payload(needle, outcome, profit, deal, "get_closed_deal", started)
            except Exception:
                pass
        try:
            for item in api.closed_deals() or []:
                if not _deal_matches_id(item, needle):
                    continue
                outcome, profit, deal = _classify_listed_deal(item, needle, api)
                if outcome:
                    return _settled_payload(needle, outcome, profit, deal, "closed_deals", started)
        except Exception:
            pass
    return _pending_payload(needle, "closed_deals", started, hint="not_in_closed_history")


def _watch_until_settled(ssid: str, deal_id_s: str, settle_unix: float, stop: threading.Event) -> None:
    """When the ticket expires, read W/L from the SSID closed-deal feed instantly.

    PO pushes successcloseOrder / updateClosedDeals on the dedicated SSID socket.
    Do NOT call check_win — it holds the trade-session lock and stalls S1.
    """
    try:
        _ensure_closed_feed(ssid)
        while not stop.is_set():
            delay = settle_unix - 0.15 - time.time()
            if delay <= 0:
                break
            stop.wait(min(delay, 0.25))

        try:
            kick_closed_refresh(ssid)
        except Exception:
            pass
        deadline = max(time.time() + 12.0, settle_unix + 12.0)
        while not stop.is_set() and time.time() < deadline:
            res = _peek_closed_history(ssid, deal_id_s)
            if res.get("outcome") and not res.get("pending"):
                out = dict(res)
                out["event"] = "deal_settled"
                out["deal_id"] = deal_id_s
                _write_json(out)
                return
            stop.wait(0.05)
    except Exception as exc:
        try:
            _write_json({
                "event": "deal_watch_error",
                "deal_id": deal_id_s,
                "error": str(exc),
            })
        except Exception:
            pass
    finally:
        with _watch_lock:
            cur = _watch_alive.get(deal_id_s)
            if cur is stop:
                _watch_alive.pop(deal_id_s, None)


def _handle(req: dict) -> dict:
    req_id = req.get("id")
    cmd = str(req.get("cmd") or "").strip().lower()
    ssid = _normalize_ssid(str(req.get("ssid") or ""))

    def wrap(payload: dict) -> dict:
        out = dict(payload)
        if req_id is not None:
            out["id"] = req_id
        return out

    try:
        if cmd == "ping":
            return wrap({"success": True, "pong": True})
        if not ssid:
            return wrap({"success": False, "error": "missing ssid"})
        if cmd == "warm":
            cur = str(req.get("currency") or "").strip() or None
            return wrap(_warm(ssid, cur))
        if cmd == "status":
            hint = str(req.get("currency") or "USD").strip() or "USD"
            return wrap(_status(ssid, hint))
        if cmd == "close":
            with _lock_for(ssid):
                _close_session(ssid)
            try:
                stop_closed_feed(ssid)
            except Exception:
                pass
            return wrap({"success": True, "closed": True})
        if cmd == "trade":
            min_pay = req.get("min_payout")
            if min_pay is None:
                min_pay = req.get("minPayout")
            if min_pay is None:
                min_pay = 90
            sig_pay = req.get("signal_payout")
            if sig_pay is None:
                sig_pay = req.get("signalPayout")
            try:
                sig_pay_i = int(sig_pay) if sig_pay is not None else None
            except (TypeError, ValueError):
                sig_pay_i = None
            list_pay = req.get("list_payout")
            if list_pay is None:
                list_pay = req.get("listPayout")
            gate_pay = req.get("gate_payout")
            if gate_pay is None:
                gate_pay = req.get("gatePayout")
            try:
                list_pay_i = int(list_pay) if list_pay is not None else None
            except (TypeError, ValueError):
                list_pay_i = None
            try:
                gate_pay_i = int(gate_pay) if gate_pay is not None else None
            except (TypeError, ValueError):
                gate_pay_i = None
            return wrap(
                _trade(
                    ssid,
                    currency=str(req.get("currency") or ""),
                    side=str(req.get("side") or ""),
                    amount=float(req.get("amount") or 0),
                    duration_sec=int(req.get("duration") or 0),
                    min_payout=int(min_pay),
                    signal_payout=sig_pay_i,
                    list_payout=list_pay_i,
                    gate_payout=gate_pay_i,
                )
            )
        if cmd in {"opened_deals", "live_deals"}:
            return wrap(_list_opened(ssid))
        if cmd in {"trade_history", "closed_deals", "user_trades"}:
            try:
                limit = int(req.get("limit") or 40)
            except (TypeError, ValueError):
                limit = 40
            return wrap(_list_user_trades(ssid, limit=max(1, min(200, limit))))
        if cmd in {"watch_deal", "watch"}:
            deal_id = str(req.get("deal_id") or req.get("dealId") or "")
            settle_unix = _as_unix_seconds(
                req.get("settle_at") or req.get("settleAt"),
                time.time() + 60.0,
            )
            started = _start_deal_watch(ssid, deal_id, settle_unix)
            return wrap({
                "success": True,
                "watching": True,
                "started": started,
                "deal_id": deal_id,
                "settle_at": int(settle_unix * 1000),
            })
        if cmd in {"check_deal", "check_win", "deal_result"}:
            allow_block = bool(req.get("allow_block") or req.get("allowBlock"))
            fast = bool(req.get("fast"))
            ignore_open = bool(req.get("ignore_open") or req.get("ignoreOpen"))
            return wrap(
                _check_deal(
                    ssid,
                    str(req.get("deal_id") or req.get("dealId") or ""),
                    allow_block=allow_block,
                    fast=fast,
                    ignore_open=ignore_open,
                )
            )
        if cmd in {"note_observed", "note_payout", "observe_payout"}:
            try:
                pct_i = int(round(float(req.get("pct") or req.get("payout") or 0)))
            except (TypeError, ValueError):
                pct_i = 0
            dur = req.get("duration")
            if dur is None:
                dur = req.get("duration_sec")
            try:
                dur_i = int(dur) if dur is not None else None
            except (TypeError, ValueError):
                dur_i = None
            asset = str(req.get("currency") or req.get("asset") or "")
            if asset and pct_i >= 50:
                payout_truth.note_observed(
                    asset,
                    dur_i,
                    pct_i,
                    source=str(req.get("source") or "app"),
                )
            return wrap({"success": bool(asset and pct_i >= 50)})
        if cmd in {"payout", "currency_payout", "asset_payout"}:
            fresh = req.get("fresh")
            if fresh is None:
                fresh = True
            dur = req.get("duration")
            if dur is None:
                dur = req.get("duration_sec")
            try:
                dur_i = int(dur) if dur is not None else None
            except (TypeError, ValueError):
                dur_i = None
            return wrap(
                _currency_payout(
                    ssid,
                    str(req.get("currency") or ""),
                    fresh=bool(fresh),
                    duration_sec=dur_i,
                )
            )
        return wrap({"success": False, "error": f"unknown cmd: {cmd}"})
    except Exception as e:
        msg = str(e)
        # "Invalid asset" must NOT tear down the shared session or mark SSID expired —
        # that was killing dual-bot autotrade after one bad crypto ticker.
        soft_fail = bool(re.search(r"invalid\s+asset|unknown\s+asset|asset\s+not\s+found", msg, re.I))
        expired = (not soft_fail) and bool(
            re.search(r"expired|unauthorized|auth|invalid\s+ssid|invalid\s+token", msg, re.I)
        )
        if ssid and not soft_fail:
            try:
                with _lock_for(ssid):
                    _close_session(ssid)
            except Exception:
                pass
        return wrap({
            "success": False,
            "online": not soft_fail,
            "connected": not soft_fail,
            "error": msg,
            "expired": expired,
            "trace": traceback.format_exc()[-400:],
        })


def _keepalive_loop() -> None:
    """Ping open SSIDs every few seconds so the socket never goes quiet."""
    while True:
        time.sleep(_KEEPALIVE_SEC)
        ssids = list(_session_ssids.values())
        for ssid in ssids:
            try:
                _balance_only(ssid)
                _mark_session_ok(ssid)
            except Exception:
                try:
                    _refresh_session(ssid)
                    _balance_only(ssid)
                    _mark_session_ok(ssid)
                except Exception:
                    try:
                        with _lock_for(ssid):
                            _close_session(ssid)
                    except Exception:
                        pass


def main() -> int:
    threading.Thread(target=_keepalive_loop, name="po-ssid-keepalive", daemon=True).start()
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception:
            _write_json({"success": False, "error": "invalid json"})
            continue
        _write_json(_handle(req))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
