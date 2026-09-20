#!/usr/bin/env python3
"""Place a Pocket Option trade via SSID (BinaryOptionsToolsV2)."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time

try:
    from BinaryOptionsToolsV2.pocketoption import PocketOption
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "BinaryOptionsToolsV2"])
    from BinaryOptionsToolsV2.pocketoption import PocketOption

from po_ssid import CURRENCIES_FILE, PAYOUTS_FILE, load_ssid, resolve_payout_asset

# Company / UI names -> PO ticker (stem without # / OTC).
CURRENCY_ALIASES = {
    "APPLE": "AAPL",
    "MICROSOFT": "MSFT",
    "GOOGLE": "GOOGL",
    "ALPHABET": "GOOGL",
    "AMAZON": "AMZN",
    "TESLA": "TSLA",
    "NVIDIA": "NVDA",
    "NETFLIX": "NFLX",
    "FACEBOOK": "FB",  # PO lists #FB, not META
    "META": "FB",
    "EXXON": "XOM",
    "MCDONALDS": "MCD",
    "MCDONALD": "MCD",
    "CISCO": "CSCO",
    "INTEL": "INTC",
    "JOHNSON": "JNJ",
    "BOEING": "BA",
    "AMERICANEXPRESS": "AXP",
}

_meta_index_cache: dict[str, str] | None = None
_meta_index_mtime: float | None = None


def _stem_key(value: str) -> str:
    s = str(value or "").strip().lower()
    if s.endswith("_otc"):
        s = s[:-4]
    if s.endswith(" otc"):
        s = s[:-4].strip()
    s = s.replace("/", "").replace(" ", "").replace("-", "").lstrip("#")
    return s


def _display_core_to_api(core: str) -> str:
    """'#AAPL' / 'EUR/USD' / 'ADA-USD' -> '#AAPL_otc' / 'EURUSD_otc' / 'ADA-USD_otc'.

    Keep hyphens: PO lists crypto as `BNB-USD_otc`, not `BNBUSD_otc`.
    Collapse FX slashes only (`EUR/USD` -> `EURUSD_otc`).
    """
    raw = str(core or "").strip()
    if not raw:
        return ""
    has_hash = raw.startswith("#")
    body = raw.lstrip("#").replace("/", "").replace(" ", "")
    if not body:
        return ""
    if body.lower().endswith("_otc"):
        api = body
    else:
        api = f"{body}_otc"
    if has_hash and not api.startswith("#"):
        api = f"#{api}"
    return api


def load_meta_asset_index() -> dict[str, str]:
    """stem (aapl/eurusd) -> preferred PO API key (#AAPL_otc / EURUSD_otc).

    Reads currencies_payouts.txt + currencies_from_po.txt. When both hashed and
    plain forms exist for a stem, the hashed form wins (required for AAPL/MSFT/…).
    """
    global _meta_index_cache, _meta_index_mtime
    try:
        mtimes = []
        for path in (PAYOUTS_FILE, CURRENCIES_FILE):
            if path.exists():
                mtimes.append(path.stat().st_mtime)
        stamp = max(mtimes) if mtimes else 0.0
        if _meta_index_cache is not None and _meta_index_mtime == stamp:
            return _meta_index_cache
    except Exception:
        stamp = 0.0

    # stem -> (api, prefer_hash_score)  score 2=hash from payouts, 1=hash from list, 0=plain
    best: dict[str, tuple[str, int]] = {}

    def consider(api: str, score: int) -> None:
        stem = _stem_key(api)
        if not stem or not api:
            return
        prev = best.get(stem)
        if prev is None or score > prev[1] or (score == prev[1] and api.startswith("#") and not prev[0].startswith("#")):
            best[stem] = (api, score)

    try:
        if PAYOUTS_FILE.exists():
            for line in PAYOUTS_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
                if "Currency:" not in line:
                    continue
                name = line.split("Currency:")[1].split(",")[0].strip()
                if not name:
                    continue
                core = name[:-4].strip() if name.upper().endswith(" OTC") else name
                api = _display_core_to_api(core)
                if not api:
                    continue
                score = 2 if api.startswith("#") or core.startswith("#") else 0
                consider(api, score)
    except Exception:
        pass

    try:
        if CURRENCIES_FILE.exists():
            for line in CURRENCIES_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
                if "Currency:" not in line:
                    continue
                part = line.split("Currency:")[1].split(",")[0].split("<--")[0].strip()
                if not part:
                    continue
                api = _display_core_to_api(part)
                if not api:
                    continue
                score = 1 if part.startswith("#") or api.startswith("#") else 0
                consider(api, score)
    except Exception:
        pass

    out = {stem: api for stem, (api, _score) in best.items()}
    _meta_index_cache = out
    _meta_index_mtime = stamp
    return out


def load_payout_asset_map() -> dict:
    """resolve_payout_asset-compatible map (keys only matter)."""
    out: dict = {}
    index = load_meta_asset_index()
    for stem, api in index.items():
        out[api] = True
        out[stem] = True
        out[stem.upper()] = True
        out[api.lstrip("#")] = True
        if api.startswith("#"):
            out[f"#{stem.upper()}"] = True
    # Also keep raw payout display lines for resolve_payout_asset exact hits.
    try:
        if PAYOUTS_FILE.exists():
            for line in PAYOUTS_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
                if "Currency:" not in line:
                    continue
                name = line.split("Currency:")[1].split(",")[0].strip()
                if name:
                    out[name] = True
    except Exception:
        pass
    return out


def currency_to_asset(currency: str, payout_data: dict | None = None) -> str:
    """Map display/signal currency (e.g. 'AAPL OTC', '#AAPL') to PO API asset key.

    Equity OTC tickers on Pocket Option often need a leading hash (`#AAPL_otc`).
    Crypto OTC often keeps hyphens (`BNB-USD_otc`); collapsing to `BNBUSD_otc` fails.
    """
    raw_in = str(currency or "").strip()
    if not raw_in:
        raise ValueError("currency is required")

    raw = raw_in.upper().strip()
    want_otc = bool(re.search(r"\bOTC\b", raw)) or raw.endswith("_OTC") or raw.lower().endswith("_otc")
    raw = re.sub(r"\s*OTC\s*$", "", raw, flags=re.I).strip()
    raw = re.sub(r"_OTC$", "", raw, flags=re.I).strip()
    has_hash = raw.startswith("#")
    # Keep hyphens for crypto (BNB-USD); only collapse FX slashes/spaces.
    body_hyphen = raw.lstrip("#").replace("/", "").replace(" ", "")
    body = body_hyphen.replace("-", "")
    if not body:
        raise ValueError(f"invalid currency: {currency!r}")
    aliased = CURRENCY_ALIASES.get(body, body)
    if aliased != body:
        body = aliased
        body_hyphen = aliased
    stem = body.lower()
    had_hyphen = "-" in body_hyphen and body_hyphen != body

    def _otc(name: str) -> str:
        return f"{name}_otc" if want_otc else name

    plain = _otc(body)
    hashed = f"#{_otc(body)}" if want_otc else f"#{body}"
    plain_hyphen = _otc(body_hyphen) if had_hyphen else None
    hashed_hyphen = f"#{plain_hyphen}" if plain_hyphen else None

    # Short crypto tickers: BNB-USD / ADAUSD → also try BNB / ADA.
    short = None
    if stem.endswith("usd") and len(stem) > 3:
        short = stem[:-3].upper()
    elif stem.endswith("usdt") and len(stem) > 4:
        short = stem[:-4].upper()

    candidates: list[str] = []
    for c in (
        hashed_hyphen if has_hash else plain_hyphen,
        hashed_hyphen,
        plain_hyphen,
        hashed if has_hash else plain,
        hashed,
        plain,
        body_hyphen if had_hyphen else None,
        body,
        f"#{body}",
        f"{body} OTC",
        f"#{body} OTC",
        f"{body_hyphen} OTC" if had_hyphen else None,
        _otc(short) if short else None,
        f"#{_otc(short)}" if short else None,
        short,
    ):
        if c and c not in candidates:
            candidates.append(c)

    # 1) Live payout map from PO session (most accurate).
    if isinstance(payout_data, dict) and payout_data:
        for candidate in candidates:
            hit = resolve_payout_asset(candidate, payout_data)
            if hit:
                return _normalize_api_asset(hit, want_otc=want_otc)

    # 2) Offline meta index (payouts + currencies_from_po) — prefers # when listed.
    meta = load_meta_asset_index()
    if stem in meta:
        api = meta[stem]
        if want_otc:
            return api if str(api).lower().endswith("_otc") else f"{api}_otc"
        return api[:-4] if str(api).lower().endswith("_otc") else api
    if short and short.lower() in meta:
        api = meta[short.lower()]
        if want_otc:
            return api if str(api).lower().endswith("_otc") else f"{api}_otc"
        return api[:-4] if str(api).lower().endswith("_otc") else api

    # Also allow resolve_payout_asset against synthesized meta keys.
    payout_map = load_payout_asset_map()
    for candidate in candidates:
        hit = resolve_payout_asset(candidate, payout_map)
        if hit:
            return _normalize_api_asset(str(hit), want_otc=want_otc)

    # 3) Heuristic fallback — prefer hyphenated crypto form when input had '-'.
    if want_otc:
        if had_hyphen and plain_hyphen:
            return hashed_hyphen if has_hash else plain_hyphen
        if has_hash:
            return hashed
        if len(body) == 6 and body.isalpha():
            return plain  # FX / BTCUSD-style
        return plain
    return f"#{body}" if has_hash else body


def _normalize_api_asset(asset: str, *, want_otc: bool) -> str:
    h = str(asset or "").strip()
    if not h:
        raise ValueError("empty asset")
    if h.upper().endswith(" OTC"):
        # Preserve hyphens (BNB-USD OTC -> BNB-USD_otc); only strip slash/space.
        core = h[:-4].strip().replace("/", "").replace(" ", "")
        return f"{core}_otc"
    if h.lower().endswith("_otc"):
        return h
    # Keep hyphens from live PO keys; only collapse slash/space.
    compact = h.replace("/", "").replace(" ", "")
    if want_otc and not compact.lower().endswith("_otc"):
        return f"{compact}_otc"
    return compact

def execute_trade(
    ssid: str,
    *,
    currency: str,
    side: str,
    amount: float,
    duration_sec: int,
) -> dict:
    asset = currency_to_asset(currency)
    side_norm = str(side or "").upper().strip()
    if side_norm not in {"BUY", "SELL"}:
        raise ValueError(f"invalid side: {side!r}")

    amount_f = float(amount)
    if amount_f <= 0:
        raise ValueError("amount must be > 0")

    duration_i = int(duration_sec)
    if duration_i <= 0:
        raise ValueError("duration_sec must be > 0")

    started = time.time()
    with PocketOption(ssid=ssid) as api:
        try:
            payout = api.payout() or {}
            asset = currency_to_asset(currency, payout_data=payout)
        except Exception:
            pass
        if side_norm == "BUY":
            deal_id, deal_data = api.buy(asset, amount_f, duration_i, check_win=False)
        else:
            deal_id, deal_data = api.sell(asset, amount_f, duration_i, check_win=False)

    elapsed_ms = int((time.time() - started) * 1000)
    return {
        "success": True,
        "deal_id": deal_id,
        "deal": deal_data if isinstance(deal_data, dict) else {"raw": deal_data},
        "asset": asset,
        "side": side_norm,
        "amount": amount_f,
        "duration_sec": duration_i,
        "latency_ms": elapsed_ms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Execute Pocket Option trade via SSID")
    parser.add_argument("--ssid", help="Complete Pocket Option SSID string")
    parser.add_argument("--ssid-file", help="Path to SSID file")
    parser.add_argument("--currency", required=True, help='e.g. "EUR/USD OTC" or AEDCNY_OTC')
    parser.add_argument("--side", required=True, choices=["BUY", "SELL", "buy", "sell"])
    parser.add_argument("--amount", type=float, required=True)
    parser.add_argument("--duration", type=int, required=True, help="Expiry in seconds")
    parser.add_argument("--json-only", action="store_true")
    args = parser.parse_args()

    try:
        if args.ssid:
            ssid = args.ssid.strip()
        else:
            ssid = load_ssid(args.ssid_file)

        result = execute_trade(
            ssid,
            currency=args.currency,
            side=args.side,
            amount=args.amount,
            duration_sec=args.duration,
        )
        print(json.dumps(result))
        return 0
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
