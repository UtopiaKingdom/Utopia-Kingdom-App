#!/usr/bin/env python3
"""Payout truth for SSID autotrade.

Catalog api.payout() often shows the list/default TF (e.g. 92%) while a 30s
Mirax deal locks at 78%. We keep a conservative observed floor per asset+expiry
bucket from real closed wins, and the trade worker refuses to open below min.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

_LOCK = threading.Lock()
_META = Path(
    os.environ.get(
        "PO_OBSERVED_PAYOUTS",
        str(Path(__file__).resolve().parent / "observed_payouts.json"),
    )
)

# In-memory: "KESUSD_OTC@30" -> {"pct": 78, "at": ..., "n": 3}
_observed: dict[str, dict] = {}
_loaded = False


def _stem(asset_or_currency: str) -> str:
    s = str(asset_or_currency or "").strip().upper()
    s = s.replace("#", "").replace("/", "").replace(" ", "").replace("-", "")
    s = s.replace("_OTC", "OTC")
    if s.endswith("OTC") and "_" not in s[:-3]:
        s = s[:-3] + "_OTC" if not s.endswith("_OTC") else s
    # Normalize KESUSDOTC / KESUSD_OTC
    s = s.replace("OTC", "").rstrip("_")
    return f"{s}_OTC" if s else ""


def _bucket(duration_sec: int | float | None) -> int:
    try:
        n = int(round(float(duration_sec or 0)))
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        return 0
    if n <= 20:
        return 20
    if n <= 30:
        return 30
    if n <= 60:
        return 60
    if n <= 180:
        return 180
    if n <= 300:
        return 300
    return 600


def _key(asset_or_currency: str, duration_sec: int | float | None) -> str:
    return f"{_stem(asset_or_currency)}@{_bucket(duration_sec)}"


def _load() -> None:
    global _loaded, _observed
    if _loaded:
        return
    _loaded = True
    try:
        if _META.exists():
            raw = json.loads(_META.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                _observed = {str(k): v for k, v in raw.items() if isinstance(v, dict)}
    except Exception:
        _observed = {}


def _save() -> None:
    try:
        _META.parent.mkdir(parents=True, exist_ok=True)
        tmp = _META.with_suffix(".tmp")
        tmp.write_text(json.dumps(_observed, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(tmp, _META)
    except Exception:
        pass


def extract_pct_from_deal(deal) -> int | None:
    if not isinstance(deal, dict):
        return None
    for key in (
        "percent",
        "payout",
        "payoutPercent",
        "payout_percent",
        "profit_percent",
        "profitPercent",
        "coefficient",
    ):
        if key not in deal or deal[key] is None:
            continue
        try:
            n = float(deal[key])
        except (TypeError, ValueError):
            continue
        # coefficient sometimes 1.78
        if 1.0 < n <= 2.0:
            n = (n - 1.0) * 100.0
        n = int(round(n))
        if 50 <= n <= 100:
            return n
    return None


def infer_pct_from_profit(amount, profit) -> int | None:
    try:
        a = float(amount)
        p = float(profit)
    except (TypeError, ValueError):
        return None
    if not (a > 0 and p > 0):
        return None
    n = int(round((p / a) * 100.0))
    if 50 <= n <= 100:
        return n
    return None


def note_observed(
    asset_or_currency: str,
    duration_sec: int | float | None,
    pct: int,
    *,
    source: str = "deal",
) -> None:
    """Record a real locked payout. Keeps the MIN (most conservative) seen.

    Ignores payout-gate-skip — those were SSID under-reports and self-poisoned
    the floor (UI 92 → observed 88 forever).
    """
    src = str(source or "deal").strip().lower()
    if src in {"payout-gate-skip", "gate-skip", "payout_gate_skip"}:
        return
    try:
        n = int(pct)
    except (TypeError, ValueError):
        return
    if n < 50 or n > 100:
        return
    k = _key(asset_or_currency, duration_sec)
    if not k.startswith("_") and "@" in k:
        pass
    if k.startswith("@") or k == "@0":
        return
    with _LOCK:
        _load()
        prev = _observed.get(k) or {}
        prev_pct = prev.get("pct")
        try:
            prev_i = int(prev_pct) if prev_pct is not None else None
        except (TypeError, ValueError):
            prev_i = None
        new_pct = n if prev_i is None else min(prev_i, n)
        _observed[k] = {
            "pct": new_pct,
            "at": time.time(),
            "n": int(prev.get("n") or 0) + 1,
            "source": source,
            "last": n,
        }
        _save()


def get_observed(asset_or_currency: str, duration_sec: int | float | None) -> int | None:
    with _LOCK:
        _load()
        row = _observed.get(_key(asset_or_currency, duration_sec))
        if not row:
            # Fall back to same stem any bucket? No — duration matters.
            return None
        try:
            return int(row.get("pct"))
        except (TypeError, ValueError):
            return None


def effective_payout(
    catalog_pct: int | None,
    asset_or_currency: str,
    duration_sec: int | float | None,
) -> int | None:
    """Conservative payout: min(catalog, observed) when observed exists."""
    try:
        cat = int(catalog_pct) if catalog_pct is not None else None
    except (TypeError, ValueError):
        cat = None
    obs = get_observed(asset_or_currency, duration_sec)
    if cat is None:
        return obs
    if obs is None:
        return cat
    return min(cat, obs)


def parse_min_payout(raw, default: int = 90) -> int:
    try:
        n = int(round(float(raw)))
    except (TypeError, ValueError):
        n = default
    return max(50, min(92, n))


def _as_pct(raw) -> int | None:
    try:
        if raw is None or raw == "":
            return None
    except Exception:
        pass
    try:
        n = int(round(float(raw)))
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 100 else None


def is_near_floor_under_report(pct, abs_floor: int = 90, max_dip: int = 12) -> bool:
    floor = max(50, min(92, int(abs_floor or 90)))
    n = _as_pct(pct)
    dip = max(1, int(max_dip or 12))
    return n is not None and n < floor and n >= floor - dip


def resolve_gate_payout(
    *,
    payout_pct,
    catalog_pct=None,
    signal_pay=None,
    list_pay=None,
    gate_pay=None,
    abs_floor: int = 90,
    max_ssid_dip: int = 12,
) -> tuple[int | None, str]:
    """Match po-min-payout-gate.js: picker/signal 92 beats SSID 84/87/88.

    Never let a stamp override clearly junk catalog (23% / 32%).
    """
    floor = max(50, min(92, int(abs_floor or 90)))
    dip = max(1, int(max_ssid_dip or 12))
    live = _as_pct(payout_pct)
    catalog = _as_pct(catalog_pct)
    signal = _as_pct(signal_pay)
    listed = _as_pct(list_pay)
    gated = _as_pct(gate_pay)

    pct = live
    source = "ssid"

    if catalog is not None and catalog >= floor and pct is not None and pct < floor and catalog - pct <= dip:
        pct = catalog
        source = "catalog"

    def _prefer_list() -> bool:
        if listed is None or listed < floor:
            return False
        if catalog is not None and catalog < floor - dip:
            return False
        if pct is not None and pct < floor - dip and not is_near_floor_under_report(pct, floor, dip):
            return False
        if pct is not None and pct >= floor:
            return False
        return True

    def _prefer_signal() -> bool:
        if signal is None or signal < floor:
            return False
        ssid_low = pct is None or pct < floor
        if not ssid_low:
            return False
        if catalog is not None and catalog < floor - dip:
            return False
        if catalog is not None and catalog >= floor:
            return True
        if catalog is None or is_near_floor_under_report(catalog, floor, dip):
            if pct is None or is_near_floor_under_report(pct, floor, dip):
                return True
        return False

    if _prefer_list():
        pct = listed
        source = "edge-list"
    if _prefer_signal():
        pct = signal
        source = "signal"
    if gated is not None and gated >= floor:
        if pct is None or pct < floor:
            if pct is None or is_near_floor_under_report(pct, floor, dip):
                pct = gated
                source = "gate"
    return pct, source
