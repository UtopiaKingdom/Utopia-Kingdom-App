"""Shared Pocket Option SSID helpers for the PO SSID Collector tools."""

from __future__ import annotations

import os
from pathlib import Path

COLLECTOR_ROOT = Path(__file__).resolve().parent
REPO_ROOT = COLLECTOR_ROOT.parent
SSID_DIR = COLLECTOR_ROOT / "ssid"
OUTPUT_DIR = Path(os.environ.get("PO_OUTPUT_DIR", r"D:\APP SAVE\output"))
CANDLES_ROOT = REPO_ROOT / "BotsHub" / "Prices" / "candles"
META_DIR = REPO_ROOT / "BotsHub" / "Prices" / "meta"

DEFAULT_SSID_FILE = SSID_DIR / "pocketoption_ssid.txt"
DEMO_SSID_FILE = SSID_DIR / "pocketoption_demo_ssid.txt"
PAYOUTS_FILE = META_DIR / "currencies_payouts.txt"
CURRENCIES_FILE = META_DIR / "currencies_from_po.txt"


def asset_to_display_currency(asset_name: str) -> str:
    """PO asset key -> display form used in meta files (e.g. EURUSD_otc -> EUR/USD OTC)."""
    raw = str(asset_name or "").strip()
    lower = raw.lower()
    is_otc = lower.endswith("_otc")
    base = raw[:-4] if is_otc else raw
    base = base.upper()
    suffix = " OTC" if is_otc else ""
    if base.startswith("#") or "/" in base or "-" in base:
        return f"{base}{suffix}"
    if len(base) >= 6 and base.isalpha():
        return f"{base[:3]}/{base[3:]}{suffix}"
    return f"{base}{suffix}"


def asset_to_base_currency(asset_name: str) -> str:
    """PO asset key -> base pair without OTC suffix (for currencies_from_po.txt)."""
    display = asset_to_display_currency(asset_name)
    return display.replace(" OTC", "").strip()


def display_to_base_upper(display: str) -> str:
    """Meta display name -> candle file stem (e.g. EUR/USD OTC -> EURUSD_OTC).

    Stock tickers from PO may include a leading '#'; candle files never do
    (#AAPL OTC -> AAPL_OTC), matching ws_capture / pa_builder.
    """
    import re

    s = re.sub(r"\s+OTC\s*$", "", str(display or "").strip(), flags=re.I).strip()
    s = s.split("<--")[0].strip()
    compact = s.replace("/", "").replace(" ", "").replace("-", "")
    if not compact:
        return ""
    compact = compact.lstrip("#")
    if compact.upper().endswith("_OTC"):
        return compact.upper()
    return f"{compact.upper()}_OTC"


def candle_file_stem(base_upper: str) -> str:
    """Normalize any stem to the on-disk candle name (strip leading '#')."""
    stem = str(base_upper or "").strip().upper()
    if stem.endswith("_OTC"):
        body, suf = stem[:-4], "_OTC"
    else:
        body, suf = stem, ""
    return f"{body.lstrip('#')}{suf}"


def base_upper_to_asset_name(base_upper: str) -> str:
    """Candle stem -> PO API asset (EURUSD_OTC -> EURUSD_otc, AAPL_OTC -> #AAPL_otc when needed).

    File stems never have '#'. API stock symbols often do. Callers that need the
    live PO key should prefer resolve_payout_asset(); this returns a best-effort
    API key with '#' preserved only if it was already on the stem.
    """
    stem = str(base_upper or "").strip().upper()
    if stem.endswith("_OTC"):
        stem = stem[:-4]
    # Keep explicit hash if caller passed it; otherwise plain (resolve_payout_asset adds #).
    return f"{stem}_otc"



def base_to_display_currency(base_upper: str) -> str:
    """Candle stem -> EUR/USD OTC (for OHLC file headers)."""
    return asset_to_display_currency(base_upper_to_asset_name(base_upper))


def _asset_stem_key(asset_name: str) -> str:
    """Normalize PO/meta asset names for matching (AAPL_otc and #AAPL_otc -> AAPL)."""
    stem = str(asset_name or "").strip().lower()
    if stem.endswith("_otc"):
        stem = stem[:-4]
    if stem.endswith(" otc"):
        stem = stem[:-4].strip()
    return stem.lstrip("#")


def _asset_compact_stem(asset_name: str) -> str:
    """Stem with separators removed so BNB-USD_otc and BNBUSD_otc match."""
    return _asset_stem_key(asset_name).replace("/", "").replace(" ", "").replace("-", "")


def resolve_payout_asset(asset: str, payout_data: dict) -> str | None:
    """
    Map meta asset key to live PO API key.

    Meta files often omit '#' on stocks (AAPL -> AAPL_otc) while PO uses #AAPL_otc.
    Crypto may be listed as BNB-USD_otc while signals send BNBUSD / BNB-USD.
    """
    if not payout_data:
        return asset or None

    raw = str(asset or "").strip()
    if not raw:
        return None
    if raw in payout_data:
        return raw

    lower_map = {str(k).lower(): str(k) for k in payout_data}
    hit = lower_map.get(raw.lower())
    if hit:
        return hit

    want = _asset_stem_key(raw)
    matches = [str(k) for k in payout_data if _asset_stem_key(str(k)) == want]
    if not matches:
        want_c = _asset_compact_stem(raw)
        matches = [str(k) for k in payout_data if _asset_compact_stem(str(k)) == want_c]
        # Also try short crypto stem (BNBUSD -> BNB) when exact compact miss.
        if not matches and want_c.endswith("usd") and len(want_c) > 3:
            short = want_c[:-3]
            matches = [str(k) for k in payout_data if _asset_compact_stem(str(k)) == short]
        if not matches and want_c.endswith("usdt") and len(want_c) > 4:
            short = want_c[:-4]
            matches = [str(k) for k in payout_data if _asset_compact_stem(str(k)) == short]
    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]

    exact = [m for m in matches if m.lower() == raw.lower()]
    if exact:
        return exact[0]
    # Prefer hyphenated crypto keys when the signal/display had a hyphen.
    if "-" in want:
        hyph = [m for m in matches if "-" in m]
        if hyph:
            return hyph[0]
    hashed = [m for m in matches if m.startswith("#")]
    return hashed[0] if hashed else matches[0]


def load_currency_bases_from_meta() -> list[str]:
    """All OTC pair stems from SSID meta files (currencies_payouts + currencies_from_po)."""
    found: set[str] = set()
    for path in (PAYOUTS_FILE, CURRENCIES_FILE):
        found.update(_parse_currency_bases_from_file(path))
    return sorted(found)


def load_currencies_from_file(
    path: Path | None = None,
    *,
    matched_only: bool = False,
) -> list[str]:
    """PO API asset keys from a currencies_from_po-style file (e.g. AEDCNY_otc)."""
    file_path = path or CURRENCIES_FILE
    bases = _parse_currency_bases_from_file(file_path, matched_only=matched_only)
    return sorted(base_upper_to_asset_name(base) for base in bases)


def _parse_currency_bases_from_file(path: Path, *, matched_only: bool = False) -> set[str]:
    found: set[str] = set()
    if not path.exists():
        return found
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if "Currency:" not in line:
            continue
        if matched_only and "<-- MATCHED" not in line:
            continue
        part = line.split("Currency:")[1].split(",")[0].split("<--")[0].strip()
        if not part:
            continue
        if " OTC" not in part.upper():
            part = f"{part} OTC"
        base = display_to_base_upper(part)
        if base:
            found.add(base)
    return found


def load_currency_bases_from_ssid(*, demo: bool = True) -> list[str]:
    """Live fetch all OTC assets from PO API (fallback if meta files missing/stale)."""
    from BinaryOptionsToolsV2 import PocketOption

    ssid = load_ssid(demo=demo)
    with PocketOption(ssid=ssid) as api:
        payout_data = api.payout() or {}
    bases: set[str] = set()
    for asset in payout_data:
        if "_otc" not in str(asset).lower():
            continue
        base = display_to_base_upper(asset_to_display_currency(str(asset)))
        if base:
            bases.add(base)
    return sorted(bases)


def write_meta_from_payouts(
    payout_data: dict,
    *,
    min_payout_write: int = 0,
    highlight_min_payout: int = 88,
) -> tuple[int, int]:
    """
    Write currencies_payouts.txt (all OTC with payout) and currencies_from_po.txt (SSID list).

    Returns (payout_rows_written, currency_rows_written).
    """
    ensure_dirs()
    rows: list[tuple[str, str, int]] = []
    for asset, payout in (payout_data or {}).items():
        asset_name = str(asset)
        if "_otc" not in asset_name.lower():
            continue
        if not isinstance(payout, (int, float)):
            continue
        payout_int = int(round(float(payout)))
        if payout_int < min_payout_write:
            continue
        display = asset_to_display_currency(asset_name)
        base = asset_to_base_currency(asset_name)
        rows.append((base, display, payout_int))

    rows.sort(key=lambda x: (-x[2], x[0]))

    payout_lines = [f"Currency: {display}, Payout: {pct}%" for _base, display, pct in rows]
    PAYOUTS_FILE.write_text("\n".join(payout_lines) + ("\n" if payout_lines else ""), encoding="utf-8")

    currency_lines = []
    for base, _display, pct in rows:
        tag = "  <-- MATCHED" if pct >= highlight_min_payout else ""
        currency_lines.append(f"Currency: {base}{tag}")
    CURRENCIES_FILE.write_text("\n".join(currency_lines) + ("\n" if currency_lines else ""), encoding="utf-8")

    return len(payout_lines), len(currency_lines)


def load_ssid(ssid_file: Path | str | None = None, *, demo: bool = False) -> str:
    """Load Pocket Option SSID from env var, live Edge harvest, or file."""
    env_ssid = os.environ.get("POCKETOPTION_SSID") or os.environ.get("PO_SSID")
    if env_ssid and env_ssid.strip():
        return env_ssid.strip()

    # Prefer SSID harvested from the always-on Edge/Chrome tab on Contabo.
    try:
        import sys

        pipeline = REPO_ROOT / "BotsHub" / "pipeline"
        if str(pipeline) not in sys.path:
            sys.path.insert(0, str(pipeline))
        from edge_ssid_sync import load_live_ssid, live_ssid_age_sec

        live = load_live_ssid()
        age = live_ssid_age_sec()
        # Use live Edge SSID when fresh enough (2h) — matches the open browser.
        if live and (age is None or age < 7200):
            live_demo = detect_account_from_ssid(live) == "demo"
            if live_demo == bool(demo) or os.environ.get("PO_SSID_PREFER_EDGE", "1").strip() not in (
                "0",
                "false",
                "no",
            ):
                # Prefer Edge regardless of demo flag unless caller forced a file path.
                if ssid_file is None:
                    return live
    except Exception:
        pass

    candidates: list[Path] = []
    if ssid_file:
        candidates.append(Path(ssid_file))
    default_file = DEMO_SSID_FILE if demo else DEFAULT_SSID_FILE
    candidates.extend(
        [
            META_DIR / "edge_live_ssid.txt",
            default_file,
            DEMO_SSID_FILE if demo else DEFAULT_SSID_FILE,
            META_DIR / ("pocketoption_demo_ssid.txt" if demo else "pocketoption_ssid.txt"),
            META_DIR / "pocketoption_ssid.txt",
        ]
    )

    for path in candidates:
        if path.exists():
            txt = path.read_text(encoding="utf-8").strip()
            if txt:
                return txt

    raise RuntimeError(
        "SSID not found. Set POCKETOPTION_SSID/PO_SSID, pass --ssid, "
        f"or create {DEFAULT_SSID_FILE} (or wait for Edge harvest)"
    )


def ensure_dirs() -> None:
    SSID_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    META_DIR.mkdir(parents=True, exist_ok=True)


def detect_account_from_ssid(ssid: str) -> str:
    """Return 'demo' or 'real' from SSID isDemo flag."""
    import json

    raw = str(ssid or "").strip()
    if not raw:
        return "demo"
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start != -1 and end > start:
        try:
            auth = json.loads(raw[start:end])
            return "demo" if bool(auth.get("isDemo", 1)) else "real"
        except Exception:
            pass
    if '"isDemo":1' in raw or '"isDemo": 1' in raw:
        return "demo"
    if '"isDemo":0' in raw or '"isDemo": 0' in raw:
        return "real"
    return "demo"


def parse_balance_response(balance_response: object, *, default_currency: str = "USD") -> tuple[float, str]:
    """Normalize Pocket Option balance + currency."""
    currency = default_currency or "USD"
    if isinstance(balance_response, dict):
        balance_value = balance_response.get("balance", balance_response.get("amount", 0))
        currency = (
            balance_response.get("currency")
            or balance_response.get("currencyCode")
            or balance_response.get("currency_code")
            or currency
        )
    elif isinstance(balance_response, (int, float)):
        balance_value = balance_response
    else:
        try:
            balance_value = float(balance_response)  # type: ignore[arg-type]
        except Exception:
            balance_value = 0.0
    return float(balance_value or 0.0), str(currency or "USD").upper()
