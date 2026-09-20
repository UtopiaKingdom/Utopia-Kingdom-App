import argparse
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional, Set, Tuple

from BinaryOptionsToolsV2 import PocketOption

from po_ssid import (
    CANDLES_ROOT,
    PAYOUTS_FILE,
    REPO_ROOT,
    base_to_display_currency,
    base_upper_to_asset_name,
    candle_file_stem,
    load_currency_bases_from_meta,
    load_ssid,
    resolve_payout_asset,
)

_PIPELINE = REPO_ROOT / "BotsHub" / "pipeline"
if str(_PIPELINE) not in sys.path:
    sys.path.insert(0, str(_PIPELINE))

from candle_file_lock import (  # noqa: E402
    LIVE_EXCLUSIVE_SEC,
    atomic_write_text,
    live_cutoff_start_ts,
    locked_candle_file,
)
from hub_live_status import clear_status, write_status  # noqa: E402

# Hub watches this file to unlock NewMirax / Lumix after pass 1.
PASS1_READY_FILE = REPO_ROOT / "BotsHub" / "Prices" / "meta" / "repair_pass1.ready"


def clear_pass1_ready() -> None:
    try:
        PASS1_READY_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _signal_pass1_done() -> None:
    """Tell Bots Hub that bots may start (pass 1 / single-pass finished)."""
    try:
        PASS1_READY_FILE.parent.mkdir(parents=True, exist_ok=True)
        PASS1_READY_FILE.write_text(
            f"pass1_done\nts={int(time.time())}\n",
            encoding="utf-8",
        )
        print(f"  [hub] wrote {PASS1_READY_FILE.name} — bots may start", flush=True)
    except Exception as e:
        print(f"  [hub] could not write pass1 ready file: {e}", flush=True)


# All timeframes built from 5s API history (matches pa_builder / NewMirax).
INTERVALS: Dict[int, str] = {
    5: "5s",
    15: "15s",
    30: "30s",
    60: "1m",
    180: "3m",
    300: "5m",
    900: "15m",
}

BASE_INTERVAL = 5
DERIVED_INTERVALS = (15, 30, 60, 180, 300, 900)

TIME_LABEL_MODE = "close"

DEFAULT_SKIP_CURRENCIES = {
    "LBPUSD_OTC",
}

LINE_RE = re.compile(
    r"^Currency:\s*(?P<currency>.+?),\s*Open:\s*(?P<o>[0-9.]+),\s*High:\s*(?P<h>[0-9.]+),\s*"
    r"Low:\s*(?P<l>[0-9.]+),\s*Close:\s*(?P<c>[0-9.]+),\s*Time:\s*(?P<t>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$"
)

OHLC = Tuple[float, float, float, float]


def bucket_start(ts: int, interval_sec: int) -> int:
    return ts - (ts % interval_sec)


def to_display_currency(base_upper: str) -> str:
    return base_to_display_currency(candle_file_stem(base_upper))


def _norm_po_asset_key(raw: str) -> str:
    """Normalize payout/display names to PO API keys, preserving leading '#'."""
    h = str(raw or "").strip()
    if not h:
        return h
    lead = h.startswith("#")
    body = h[1:].strip() if lead else h
    if body.upper().endswith(" OTC"):
        body = body[:-4].strip()
        if body.startswith("#"):
            lead = True
            body = body[1:].strip()
    body = body.replace("/", "").replace(" ", "")
    if not body.lower().endswith("_otc"):
        body = f"{body}_otc"
    body = body.lstrip("#")
    return f"#{body}" if lead else body


def _equity_needs_hash(body: str) -> bool:
    """Stocks/ETFs on PO need #AAPL_otc; forex (EURUSD) and hyphen crypto do not."""
    b = str(body or "").lstrip("#")
    if "-" in b or "/" in b:
        return False
    # Classic FX: exactly 6 letters (EURUSD). Crypto like BTCUSD is also 6 — plain key.
    if len(b) == 6 and b.isalpha():
        return False
    # Short alpha tickers: AAPL, BABA, CSCO, BITB, …
    return bool(b) and b.replace("_", "").isalpha()


def asset_name_candidates(asset_name: str) -> list[str]:
    """Try plain and # variants — payouts often omit '#' for equities."""
    n = str(asset_name or "").strip()
    if not n:
        return []
    if n.startswith("#"):
        alt = n[1:]
        return [n, alt] if alt and alt != n else [n]
    hashed = f"#{n}"
    # Prefer # first for equity-shaped keys so we don't burn retries on Invalid asset.
    body = n[:-4] if n.lower().endswith("_otc") else n
    if _equity_needs_hash(body):
        return [hashed, n]
    return [n, hashed]


def to_asset_name(base_upper: str) -> str:
    """PO API asset key. Equity tickers on PO use a leading '#' (#AAPL_otc)."""
    stem = candle_file_stem(base_upper)
    body = stem[:-4] if stem.endswith("_OTC") else stem
    body = body.lstrip("#")
    plain = f"{body}_otc"
    hashed = f"#{body}_otc"

    # Build a key set from payouts so resolve_payout_asset can pick #AAPL_otc.
    payout_keys: dict = {}
    try:
        if PAYOUTS_FILE.exists():
            for line in PAYOUTS_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
                if "Currency:" not in line:
                    continue
                name = line.split("Currency:")[1].split(",")[0].strip()
                # "#AAPL OTC" / "EUR/USD OTC" -> API-like keys
                key = _norm_po_asset_key(name)
                if not key:
                    continue
                payout_keys[key] = True
                payout_keys[key.lstrip("#")] = True
                payout_keys[name] = True
    except Exception:
        pass

    # Prefer hashed lookup first so #AAPL_otc wins when both exist.
    hit = resolve_payout_asset(hashed, payout_keys) or resolve_payout_asset(plain, payout_keys)
    if hit:
        out = _norm_po_asset_key(hit)
        if out and not out.startswith("#") and _equity_needs_hash(body):
            return f"#{out.lstrip('#')}"
        return out or (hashed if _equity_needs_hash(body) else plain)

    return hashed if _equity_needs_hash(body) else plain



def ts_to_text(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def _label_ts(start_ts: int, interval_sec: int) -> int:
    return start_ts if TIME_LABEL_MODE == "start" else (start_ts + interval_sec)


def count_expected(start_ts: int, end_ts: int, interval_sec: int) -> int:
    if start_ts > end_ts:
        return 0
    return ((end_ts - start_ts) // interval_sec) + 1


def _parse_api_ts(ts_raw: object) -> Optional[int]:
    if ts_raw is None:
        return None
    try:
        if isinstance(ts_raw, str):
            s = ts_raw.strip()
            if not s:
                return None
            if s.isdigit() or (s.replace(".", "", 1).isdigit()):
                return int(float(s))
            if "T" in s:
                dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
                return int(dt.timestamp())
            return int(datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").timestamp())
        return int(float(ts_raw))
    except Exception:
        return None


def parse_existing_file(
    path: Path,
    interval_sec: int,
    start_ts: int = 0,
    end_ts: int = 2**62 - 1,
) -> Dict[int, OHLC]:
    candles: Dict[int, OHLC] = {}
    if not path.exists():
        return candles

    with path.open("r", encoding="utf-8") as f:
        for raw in f:
            m = LINE_RE.match(raw.strip())
            if not m:
                continue
            try:
                ts_raw = int(datetime.strptime(m.group("t"), "%Y-%m-%d %H:%M:%S").timestamp())
                candidate_starts = [bucket_start(ts_raw, interval_sec)]
                if ts_raw >= interval_sec:
                    candidate_starts.append(bucket_start(ts_raw - interval_sec, interval_sec))

                ts = None
                for candidate in candidate_starts:
                    if start_ts <= candidate <= end_ts:
                        ts = candidate
                        break
                if ts is None:
                    continue

                candles[ts] = (
                    float(m.group("o")),
                    float(m.group("h")),
                    float(m.group("l")),
                    float(m.group("c")),
                )
            except Exception:
                continue
    return candles


def merge_window_repair(
    full_existing: Dict[int, OHLC],
    window_start: int,
    window_end: int,
    window_data: Dict[int, OHLC],
) -> Dict[int, OHLC]:
    merged = {ts: ohlc for ts, ohlc in full_existing.items() if ts < window_start or ts > window_end}
    merged.update(window_data)
    return merged


def normalize_api_candle(c: dict, interval_sec: int) -> Optional[Tuple[int, OHLC]]:
    try:
        ts_raw = c.get("timestamp") or c.get("time") or c.get("t")
        ts_val = _parse_api_ts(ts_raw)
        if ts_val is None:
            return None
        ts = bucket_start(ts_val, interval_sec)

        o_raw = c.get("open") if c.get("open") is not None else c.get("o")
        h_raw = c.get("high") if c.get("high") is not None else c.get("h")
        l_raw = c.get("low") if c.get("low") is not None else c.get("l")
        c_raw = c.get("close") if c.get("close") is not None else c.get("c")
        if None in (o_raw, h_raw, l_raw, c_raw):
            return None

        return ts, (float(o_raw), float(h_raw), float(l_raw), float(c_raw))
    except Exception:
        return None


def _safe_close(api: PocketOption) -> None:
    try:
        api.close()
    except Exception:
        try:
            api.shutdown()
        except Exception:
            pass


def missing_slots(
    window_start: int,
    window_end: int,
    existing: Dict[int, OHLC],
) -> Set[int]:
    missing: Set[int] = set()
    ts = window_start
    while ts <= window_end:
        if ts not in existing:
            missing.add(ts)
        ts += BASE_INTERVAL
    return missing


def gap_ranges_from_missing(missing: Set[int]) -> list[Tuple[int, int]]:
    if not missing:
        return []
    sorted_ts = sorted(missing)
    ranges: list[Tuple[int, int]] = []
    gap_start = sorted_ts[0]
    prev = sorted_ts[0]
    for ts in sorted_ts[1:]:
        if ts - prev > BASE_INTERVAL:
            ranges.append((gap_start, prev))
            gap_start = ts
        prev = ts
    ranges.append((gap_start, prev))
    return ranges


def fetch_candles_simple(
    executor: ThreadPoolExecutor,
    api: PocketOption,
    asset_name: str,
    lookback_sec: int,
    start_ts: int,
    end_ts: int,
    timeout_sec: float,
    *,
    quiet: bool = False,
) -> Dict[int, OHLC]:
    data = None
    used = asset_name
    last_err: Exception | None = None
    for cand in asset_name_candidates(asset_name):
        used = cand

        def call(name: str = cand) -> list:
            return api.get_candles(name, BASE_INTERVAL, lookback_sec)

        try:
            data = executor.submit(call).result(timeout=max(5.0, timeout_sec))
            last_err = None
            break
        except FuturesTimeoutError:
            print(f"    [warn] {cand} get_candles(5s, {lookback_sec}s) timed out")
            return {}
        except Exception as e:
            last_err = e
            if "Invalid asset" in str(e):
                continue
            print(f"    [warn] {cand} get_candles(5s) failed: {e}")
            return {}
    if last_err is not None:
        print(f"    [warn] {asset_name} get_candles(5s) failed: {last_err}")
        return {}

    result: Dict[int, OHLC] = {}
    if not isinstance(data, list):
        return result

    for item in data:
        norm = normalize_api_candle(item, BASE_INTERVAL)
        if not norm:
            continue
        ts, ohlc = norm
        if start_ts <= ts <= end_ts:
            result[ts] = ohlc

    if not quiet:
        print(f"    {used} 5s quick fetch -> {len(result)} rows")
    return result


def fetch_candles_batched(
    executor: ThreadPoolExecutor,
    api: PocketOption,
    asset_name: str,
    start_ts: int,
    end_ts: int,
    chunk_sec: int,
    timeout_sec: float,
    max_batches: int,
    *,
    quiet: bool = False,
) -> Tuple[Dict[int, OHLC], int]:
    """Walk backwards with get_candles_advanced (1h chunks of 5s data)."""
    result: Dict[int, OHLC] = {}
    current_end = end_ts + BASE_INTERVAL
    batches = 0

    # Resolve working API key once (payouts often omit '#' on equities).
    resolved_name = asset_name
    while current_end > start_ts and batches < max_batches:
        batches += 1
        end_arg = current_end
        data = None
        last_err: Exception | None = None
        tried = asset_name_candidates(resolved_name)
        for cand in tried:
            def call(name: str = cand) -> list:
                return api.get_candles_advanced(name, BASE_INTERVAL, chunk_sec, end_arg)

            try:
                data = executor.submit(call).result(timeout=max(5.0, timeout_sec))
                resolved_name = cand
                last_err = None
                break
            except FuturesTimeoutError:
                print(f"\n    [warn] {cand} 5s batch {batches} timed out")
                return result, batches
            except Exception as e:
                last_err = e
                if "Invalid asset" in str(e):
                    continue
                print(f"\n    [warn] {cand} 5s batch {batches} failed: {e}")
                return result, batches
        if last_err is not None:
            print(f"\n    [warn] {asset_name} 5s batch {batches} failed: {last_err}")
            break

        if not isinstance(data, list) or not data:
            break

        oldest_seen = current_end
        added = 0
        for item in data:
            norm = normalize_api_candle(item, BASE_INTERVAL)
            if not norm:
                continue
            ts, ohlc = norm
            oldest_seen = min(oldest_seen, ts)
            if start_ts <= ts <= end_ts:
                if ts not in result:
                    added += 1
                result[ts] = ohlc

        if not quiet:
            print(
                f"\r    {asset_name} 5s batch {batches} +{added} total={len(result)}",
                end="",
                flush=True,
            )

        if oldest_seen <= start_ts:
            break
        if oldest_seen >= current_end:
            break
        current_end = oldest_seen - 1

    if not quiet:
        print()
    return result, batches


def fetch_one_gap_range(
    executor: ThreadPoolExecutor,
    api: PocketOption,
    asset_name: str,
    gap_start: int,
    gap_end: int,
    timeout_sec: float,
    max_batches: int,
) -> Tuple[Dict[int, OHLC], int]:
    gap_sec = gap_end - gap_start + BASE_INTERVAL
    lookback_sec = gap_sec + 60
    expected = count_expected(gap_start, gap_end, BASE_INTERVAL)
    result: Dict[int, OHLC] = {}
    calls = 0

    # get_candles(lookback) only returns *recent* history — skip for old gaps.
    now_ts = int(time.time())
    if gap_end >= now_ts - lookback_sec - 3600:
        calls += 1
        result = fetch_candles_simple(
            executor, api, asset_name, lookback_sec, gap_start, gap_end, timeout_sec, quiet=True
        )
        if len(result) >= expected:
            return result, calls

    chunk_sec = max(300, min(3600, gap_sec + 120))
    batched, batches = fetch_candles_batched(
        executor,
        api,
        asset_name,
        gap_start,
        gap_end,
        chunk_sec=chunk_sec,
        timeout_sec=timeout_sec,
        max_batches=max_batches,
        quiet=True,
    )
    result.update(batched)
    return result, calls + batches


def fetch_5s_gaps(
    executor: ThreadPoolExecutor,
    api: PocketOption,
    asset_name: str,
    window_start: int,
    window_end: int,
    existing: Dict[int, OHLC],
    timeout_sec: float,
    max_batches: int,
) -> Dict[int, OHLC]:
    merged = dict(existing)
    missing = missing_slots(window_start, window_end, merged)
    if not missing:
        return merged

    expected = count_expected(window_start, window_end, BASE_INTERVAL)
    # Contiguous holes only — never re-download candles already in the file.
    holes = gap_ranges_from_missing(missing)
    print(
        f"    {asset_name} 5s filling {len(missing)} missing "
        f"in {len(holes)} hole(s) (have {len(merged)}/{expected}, skip re-fetch)..."
    )

    batches_budget = max_batches
    for tight_start, tight_end in holes:
        if batches_budget <= 0:
            break
        gap_missing = {ts for ts in missing if tight_start <= ts <= tight_end}
        if not gap_missing:
            continue
        gap_data, batches_used = fetch_one_gap_range(
            executor, api, asset_name, tight_start, tight_end, timeout_sec, batches_budget
        )
        added = 0
        for ts, ohlc in gap_data.items():
            if ts in gap_missing:
                merged[ts] = ohlc
                missing.discard(ts)
                added += 1
        print(
            f"    {asset_name} 5s gap {_fmt_ts(tight_start)}-{_fmt_ts(tight_end)} "
            f"+{added}/{len(gap_missing)}"
        )
        batches_budget = max(0, batches_budget - batches_used)

    still = len(missing)
    if still:
        print(f"    {asset_name} 5s still missing {still} after gap fill")
    return merged


def fetch_5s_full_window(
    executor: ThreadPoolExecutor,
    api: PocketOption,
    asset_name: str,
    window_start: int,
    window_end: int,
    existing: Dict[int, OHLC],
    timeout_sec: float,
    max_batches: int,
) -> Dict[int, OHLC]:
    expected = count_expected(window_start, window_end, BASE_INTERVAL)
    print(f"    {asset_name} 5s fetching window ({len(existing)}/{expected})...")

    lookback_sec = max(BASE_INTERVAL, window_end - window_start + BASE_INTERVAL)
    merged = dict(existing)
    merged.update(
        fetch_candles_simple(
            executor, api, asset_name, lookback_sec, window_start, window_end, timeout_sec
        )
    )

    if expected > 0 and len(merged) < expected:
        print(f"    {asset_name} 5s fetching rest ({len(merged)}/{expected})...")
        batched, _ = fetch_candles_batched(
            executor,
            api,
            asset_name,
            window_start,
            window_end,
            chunk_sec=3600,
            timeout_sec=timeout_sec,
            max_batches=max_batches,
        )
        merged.update(batched)

    return merged


def fetch_5s_window(
    executor: ThreadPoolExecutor,
    api: PocketOption,
    asset_name: str,
    window_start: int,
    window_end: int,
    existing_in_window: Dict[int, OHLC],
    timeout_sec: float,
    max_batches: int,
) -> Dict[int, OHLC]:
    """Fetch only what's missing on disk. Full-window download only when the file is empty."""
    expected = count_expected(window_start, window_end, BASE_INTERVAL)
    have = len(existing_in_window)
    if expected > 0 and have >= expected:
        print(f"    {asset_name} 5s complete ({have}/{expected}) — skip fetch")
        return dict(existing_in_window)

    # Any existing candles: only hit the API for missing slots (saves hours vs re-fetch).
    if have > 0:
        return fetch_5s_gaps(
            executor, api, asset_name, window_start, window_end,
            existing_in_window, timeout_sec, max_batches,
        )

    return fetch_5s_full_window(
        executor, api, asset_name, window_start, window_end,
        existing_in_window, timeout_sec, max_batches,
    )


def aggregate_from_base(
    base_candles: Dict[int, OHLC],
    target_interval_sec: int,
    start_ts: int,
    end_ts: int,
) -> Dict[int, OHLC]:
    buckets: Dict[int, list[Tuple[int, OHLC]]] = {}

    for ts, ohlc in base_candles.items():
        if ts < start_ts or ts > end_ts:
            continue
        b = bucket_start(ts, target_interval_sec)
        if b < start_ts or b > end_ts:
            continue
        buckets.setdefault(b, []).append((ts, ohlc))

    out: Dict[int, OHLC] = {}
    for b, vals in buckets.items():
        vals.sort(key=lambda x: x[0])
        open_ = vals[0][1][0]
        high_ = max(v[1][1] for v in vals)
        low_ = min(v[1][2] for v in vals)
        close_ = vals[-1][1][3]
        out[b] = (open_, high_, low_, close_)

    return out


def _fmt_ohlc(v: float) -> str:
    av = abs(v)
    if av < 0.001:
        return f"{v:.8f}"
    if av < 0.01:
        return f"{v:.7f}"
    return f"{v:.5f}"


def _format_candles_text(
    display_currency: str,
    interval_sec: int,
    candles: Dict[int, OHLC],
) -> str:
    lines: list[str] = []
    for ts in sorted(candles.keys()):
        o, h, l, c = candles[ts]
        line_ts = _label_ts(ts, interval_sec)
        lines.append(
            f"Currency: {display_currency}, Open: {_fmt_ohlc(o)}, High: {_fmt_ohlc(h)}, "
            f"Low: {_fmt_ohlc(l)}, Close: {_fmt_ohlc(c)}, Time: {ts_to_text(line_ts)}"
        )
    return "\n".join(lines) + ("\n" if lines else "")


def _hash_sibling(path: Path) -> Path:
    """Legacy repair wrote #AAPL_OTC_5s.txt beside AAPL_OTC_5s.txt."""
    return path.with_name("#" + path.name) if not path.name.startswith("#") else path


def _load_candles_merged(path: Path, interval_sec: int) -> Dict[int, OHLC]:
    """Load plain file + legacy # sibling (hash files are merged into plain)."""
    merged = parse_existing_file(path, interval_sec)
    sib = _hash_sibling(path)
    if sib != path and sib.exists():
        for ts, ohlc in parse_existing_file(sib, interval_sec).items():
            merged.setdefault(ts, ohlc)
    return merged


def write_candles_file(
    path: Path,
    display_currency: str,
    interval_sec: int,
    candles: Dict[int, OHLC],
) -> None:
    """Rewrite HISTORY only. Live tip from pa_builder is copied through untouched.

    Strategy: keep every on-disk candle with start_ts >= live cutoff (and raw-append
    any tip lines we can't risk dropping). Never writes into the live zone from API.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cutoff = live_cutoff_start_ts(interval_sec=interval_sec)

    history = {ts: ohlc for ts, ohlc in candles.items() if ts < cutoff}

    # Include legacy # file history once, then always write the plain path.
    on_disk = _load_candles_merged(path, interval_sec)
    live = {ts: ohlc for ts, ohlc in on_disk.items() if ts >= cutoff}
    preserved_old = {
        ts: ohlc for ts, ohlc in on_disk.items() if ts < cutoff and ts not in history
    }

    # Second read — catch pa_builder appends during the first parse.
    on_disk2 = parse_existing_file(path, interval_sec)
    for ts, ohlc in on_disk2.items():
        if ts >= cutoff:
            live[ts] = ohlc
        elif ts not in history:
            preserved_old[ts] = ohlc

    merged = {}
    merged.update(preserved_old)
    merged.update(history)
    merged.update(live)
    with locked_candle_file(path, timeout_sec=90.0):
        # Re-read live tip under lock in case pa_builder appended during format.
        on_disk3 = parse_existing_file(path, interval_sec)
        for ts, ohlc in on_disk3.items():
            if ts >= cutoff:
                live[ts] = ohlc
        merged = {}
        merged.update(preserved_old)
        merged.update(history)
        merged.update(live)
        atomic_write_text(path, _format_candles_text(display_currency, interval_sec, merged))

    # Stop updating legacy # duplicates (bots/pa_builder use the plain name).
    sib = _hash_sibling(path)
    if sib != path and sib.exists():
        try:
            sib.unlink()
        except OSError:
            pass


def discover_currencies_from_1s() -> list[str]:
    """Only currencies that already have an active 1s candle file.

    Source of truth: BotsHub/Prices/candles/1s/*_OTC.txt
    """
    found: Set[str] = set()
    one_sec_dir = CANDLES_ROOT / "1s"
    if not one_sec_dir.exists():
        print(f"Currency discovery: 1s folder missing: {one_sec_dir}")
        return []

    for p in one_sec_dir.glob("*_OTC.txt"):
        # Skip empty / placeholder files that are not actually live feeds.
        try:
            if p.stat().st_size <= 0:
                continue
        except OSError:
            continue
        found.add(candle_file_stem(p.stem))

    print(f"Currency discovery: {len(found)} active from 1s ({one_sec_dir})")
    return sorted(found)


def discover_currencies(*, include_meta: bool = False, refresh_from_ssid: bool = False) -> list[str]:
    """Discover candle stems. Default = active 1s files only.

    Pass include_meta=True to also add SSID-meta pairs (old behavior).
    """
    found: Set[str] = set(discover_currencies_from_1s())
    if not include_meta and not refresh_from_ssid:
        return sorted(found)

    from_meta = 0
    meta_bases = load_currency_bases_from_meta()
    if not meta_bases and refresh_from_ssid:
        try:
            from po_ssid import load_currency_bases_from_ssid

            meta_bases = load_currency_bases_from_ssid()
            print(f"Loaded {len(meta_bases)} OTC pairs live from SSID (meta files empty).")
        except Exception as e:
            print(f"Warning: could not fetch currencies from SSID: {e}")
    for base in meta_bases:
        stem = candle_file_stem(base)
        if stem not in found:
            from_meta += 1
        found.add(stem)

    print(f"Currency discovery: {len(found)} total (+{from_meta} from SSID meta)")
    return sorted(found)


def _window_bounds(now_ts: int, lookback_hours: int, interval_sec: int) -> Tuple[int, int]:
    """Historical window only — ends before pa_builder's live exclusive zone."""
    live_cut = live_cutoff_start_ts(now_ts, interval_sec)
    # Last bucket repair may touch is the one fully before the live zone.
    end_ts = live_cut - interval_sec
    if end_ts < interval_sec:
        end_ts = bucket_start(now_ts, interval_sec) - interval_sec
    start_ts = end_ts - (lookback_hours * 3600) + interval_sec
    return start_ts, end_ts


def _derive_window_for_interval(start_ts: int, end_ts: int, interval_sec: int) -> Tuple[int, int]:
    """Map a 5s fetch window to aligned bounds for a higher timeframe."""
    out_start = start_ts if bucket_start(start_ts, interval_sec) == start_ts else (
        bucket_start(start_ts, interval_sec) + interval_sec
    )
    out_end = bucket_start(end_ts, interval_sec)
    return out_start, out_end


def _write_derived_tf(
    base_upper: str,
    display_currency: str,
    interval_sec: int,
    source_5s: Dict[int, OHLC],
    window_start: int,
    window_end: int,
    summary: Dict[int, int],
) -> None:
    label = INTERVALS[interval_sec]
    out_path = CANDLES_ROOT / label / f"{candle_file_stem(base_upper)}_{label}.txt"
    existing_full = _load_candles_merged(out_path, interval_sec)
    existing_in_window = {
        ts: ohlc for ts, ohlc in existing_full.items() if window_start <= ts <= window_end
    }
    expected = count_expected(window_start, window_end, interval_sec)
    # Already complete on disk — don't rewrite (PA owns live tip; save I/O).
    if expected > 0 and len(existing_in_window) >= expected:
        print(f"  {label}: complete ({len(existing_in_window)}/{expected}) — skip")
        return

    rebuilt = aggregate_from_base(source_5s, interval_sec, window_start, window_end)

    missing_before = max(0, expected - len(existing_in_window))
    missing_after = max(0, expected - len(rebuilt))
    summary[interval_sec] += max(0, missing_before - missing_after)

    merged = merge_window_repair(existing_full, window_start, window_end, rebuilt)
    write_candles_file(out_path, display_currency, interval_sec, merged)
    print(f"  {label}: rows={len(merged)} | filled~={max(0, missing_before - missing_after)}")


def repair_one_currency(
    executor: ThreadPoolExecutor,
    api: PocketOption,
    base_upper: str,
    fetch_start: int,
    fetch_end: int,
    derive_start: int,
    derive_end: int,
    timeout_sec: float,
    max_batches: int,
    summary: Dict[int, int],
) -> None:
    """Fetch missing 5s via SSID (history only), then derive higher TFs from 5s locally.

    Never writes into the live exclusive tip — that belongs to pa_builder (~15s).
    Does not fetch 15s/1m/3m/… from SSID — those are built from repaired 5s.
    """
    asset_name = to_asset_name(base_upper)
    display_currency = to_display_currency(base_upper)
    file_stem = candle_file_stem(base_upper)

    # Hard clamp: API/repair must stop before the live zone.
    live_cut = live_cutoff_start_ts(interval_sec=BASE_INTERVAL)
    fetch_end = min(fetch_end, live_cut - BASE_INTERVAL)
    derive_end = min(derive_end, live_cut - BASE_INTERVAL)
    if fetch_start > fetch_end:
        print(f"  skip: window is inside live exclusive zone ({LIVE_EXCLUSIVE_SEC}s)")
        return

    s5_path = CANDLES_ROOT / "5s" / f"{file_stem}_5s.txt"
    s5_full = _load_candles_merged(s5_path, BASE_INTERVAL)
    s5_in_fetch = {ts: ohlc for ts, ohlc in s5_full.items() if fetch_start <= ts <= fetch_end}

    expected_fetch = count_expected(fetch_start, fetch_end, BASE_INTERVAL)
    had_before = len(s5_in_fetch)

    s5_in_fetch = fetch_5s_window(
        executor, api, asset_name, fetch_start, fetch_end, s5_in_fetch,
        timeout_sec, max_batches,
    )

    missing_after = max(0, expected_fetch - len(s5_in_fetch))
    summary[BASE_INTERVAL] += max(0, expected_fetch - had_before - missing_after)

    s5_merged = merge_window_repair(s5_full, fetch_start, fetch_end, s5_in_fetch)
    # Only rewrite 5s file when we actually filled something (or file was empty).
    if len(s5_in_fetch) != had_before or had_before == 0:
        write_candles_file(s5_path, display_currency, BASE_INTERVAL, s5_merged)
    print(
        f"  5s: have={len(s5_in_fetch)}/{expected_fetch} "
        f"(+{max(0, len(s5_in_fetch) - had_before)} filled) | api={asset_name}"
    )

    s5_for_derive = {ts: ohlc for ts, ohlc in s5_merged.items() if derive_start <= ts <= derive_end}
    for interval_sec in DERIVED_INTERVALS:
        out_start, out_end = _derive_window_for_interval(derive_start, derive_end, interval_sec)
        if out_start > out_end:
            continue
        _write_derived_tf(
            file_stem, display_currency, interval_sec, s5_for_derive, out_start, out_end, summary
        )


def _run_pass(
    ssid: str,
    currencies: list[str],
    skip_currencies: Set[str],
    pass_label: str,
    fetch_start: int,
    fetch_end: int,
    derive_start: int,
    derive_end: int,
    timeout_sec: float,
    max_batches: int,
    summary: Dict[int, int],
) -> None:
    if fetch_start > fetch_end:
        print(f"{pass_label}: nothing to fetch (empty window)")
        return

    print(f"\n{'=' * 60}")
    print(pass_label)
    print(f"  Fetch 5s : {_fmt_ts(fetch_start)} -> {_fmt_ts(fetch_end)}")
    print(f"  Build TFs: {_fmt_ts(derive_start)} -> {_fmt_ts(derive_end)}")
    print(f"{'=' * 60}\n")

    pass_started = time.monotonic()
    pass_num = 2 if "PASS 2" in pass_label.upper() else 1
    total_n = max(1, len(currencies))
    api = None
    write_status(
        "repair",
        phase="running",
        pass_label=pass_label,
        pass_num=pass_num,
        idx=0,
        total=total_n,
        pct=0.0,
        current="",
    )

    for idx, base_upper in enumerate(currencies, start=1):
        asset_name = to_asset_name(base_upper)
        pct = round(100.0 * idx / total_n, 1)
        write_status(
            "repair",
            phase="running",
            pass_label=pass_label,
            pass_num=pass_num,
            idx=idx,
            total=total_n,
            pct=pct,
            current=asset_name,
        )
        print(f"[progress] pass={pass_num} {idx}/{total_n} {pct:.0f}% {asset_name}", flush=True)

        if asset_name.upper() in skip_currencies:
            print(f"[{idx}/{len(currencies)}] {asset_name} (skipped)")
            continue

        print(f"[{idx}/{len(currencies)}] {asset_name}")
        # Reuse one SSID connection across pairs (reconnect on failure).
        if api is None:
            api = PocketOption(ssid=ssid)
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                repair_one_currency(
                    executor=executor,
                    api=api,
                    base_upper=base_upper,
                    fetch_start=fetch_start,
                    fetch_end=fetch_end,
                    derive_start=derive_start,
                    derive_end=derive_end,
                    timeout_sec=timeout_sec,
                    max_batches=max_batches,
                    summary=summary,
                )
        except (PermissionError, OSError, TimeoutError) as e:
            print(f"  [ERROR] {asset_name}: {e} — skipping, continuing")
            _safe_close(api)
            api = None
        except Exception as e:
            print(f"  [ERROR] {asset_name}: {type(e).__name__}: {e} — skipping, continuing")
            _safe_close(api)
            api = None

    _safe_close(api)
    api = None

    write_status(
        "repair",
        phase="pass_done",
        pass_label=pass_label,
        pass_num=pass_num,
        idx=total_n,
        total=total_n,
        pct=100.0,
        current="",
    )
    print(f"\n{pass_label} finished in {int(time.monotonic() - pass_started)}s.")


def _fmt_ts(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def run_once(
    ssid: str,
    lookback_hours: int,
    timeout_sec: float,
    max_batches: int,
    skip_currencies: Set[str],
    only_currencies: Optional[Set[str]] = None,
    staged: bool = True,
    first_pass_hours: int = 24,
    refresh_from_ssid: bool = False,
) -> None:
    now_ts = int(time.time())
    summary = {k: 0 for k in INTERVALS.keys()}

    currencies = discover_currencies(
        include_meta=refresh_from_ssid,
        refresh_from_ssid=refresh_from_ssid,
    )
    if only_currencies:
        want = {c.upper() for c in only_currencies}
        currencies = [c for c in currencies if c in want or to_asset_name(c).upper() in want]

    if not currencies:
        print(f"No active currencies found in {CANDLES_ROOT / '1s'}.")
        return

    derived = ", ".join(INTERVALS[s] for s in DERIVED_INTERVALS)
    print(f"Discovered {len(currencies)} currencies.")
    print(f"Total window: {lookback_hours}h | Fetch 5s, build: {derived}")
    print(
        f"Live tip: pa_builder exclusive last {LIVE_EXCLUSIVE_SEC}s "
        "(repair never overwrites realtime candles)"
    )
    print(f"Timeout: {timeout_sec:.0f}s per API call")

    run_started = time.monotonic()

    use_staged = staged and lookback_hours > first_pass_hours

    if use_staged:
        backfill_hours = lookback_hours - first_pass_hours
        day1_start, day1_end = _window_bounds(now_ts, first_pass_hours, BASE_INTERVAL)
        full_start, full_end = _window_bounds(now_ts, lookback_hours, BASE_INTERVAL)

        _run_pass(
            ssid, currencies, skip_currencies,
            f"PASS 1 / 2 — last {first_pass_hours}h for ALL currencies (start bot after this)",
            fetch_start=day1_start, fetch_end=day1_end,
            derive_start=day1_start, derive_end=day1_end,
            timeout_sec=timeout_sec, max_batches=max_batches, summary=summary,
        )

        print("\n" + "*" * 60)
        print("  PASS 1 DONE — enough 3m/15s history to start NewMirax now.")
        print("  Pass 2 continues in background (older history)...")
        print("*" * 60)
        _signal_pass1_done()

        old_fetch_end = day1_start - BASE_INTERVAL
        old_fetch_start = full_start

        _run_pass(
            ssid, currencies, skip_currencies,
            f"PASS 2 / 2 — backfill older {backfill_hours}h, rebuild full {lookback_hours}h TFs",
            fetch_start=old_fetch_start, fetch_end=old_fetch_end,
            derive_start=full_start, derive_end=full_end,
            timeout_sec=timeout_sec, max_batches=max_batches, summary=summary,
        )
    else:
        fetch_start, fetch_end = _window_bounds(now_ts, lookback_hours, BASE_INTERVAL)
        _run_pass(
            ssid, currencies, skip_currencies,
            f"SINGLE PASS — last {lookback_hours}h",
            fetch_start=fetch_start, fetch_end=fetch_end,
            derive_start=fetch_start, derive_end=fetch_end,
            timeout_sec=timeout_sec, max_batches=max_batches, summary=summary,
        )
        # Single pass = bots can start when this finishes.
        print("\n  PASS 1 DONE — single-pass repair complete (bots can start).")
        _signal_pass1_done()

    elapsed_total = int(time.monotonic() - run_started)
    print(f"\nDone in {elapsed_total}s.")
    parts = " | ".join(f"{INTERVALS[k]}: {summary[k]}" for k in sorted(INTERVALS.keys()))
    print(f"Approx filled gaps | {parts}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Repair BotsHub candle HISTORY only: fetch 5s via demo SSID, fill gaps "
            "(pass1=24h, pass2=~1w), rebuild 15s/30s/1m/3m/5m/15m. "
            "Never touches the live tip owned by pa_builder."
        )
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=168,
        help="Lookback window in hours (default: 168 = 1 week)",
    )
    parser.add_argument(
        "--request-timeout",
        type=float,
        default=60.0,
        help="Seconds per API call (default: 60)",
    )
    parser.add_argument(
        "--max-batches",
        type=int,
        default=1200,
        help="Max 5s fetch batches per currency (default: 1200)",
    )
    parser.add_argument("--skip-currencies", type=str, default="")
    parser.add_argument("--only", type=str, default="", help="Comma-separated, e.g. AEDCNY_OTC")
    parser.add_argument(
        "--first-hours",
        type=int,
        default=24,
        help="Pass 1: fetch this many recent hours first (default: 24 = 1 day)",
    )
    parser.add_argument(
        "--no-staged",
        action="store_true",
        help="Fetch full window per currency in one go (no 1-day-first pass)",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Quick warmup: 6h single pass, no staging",
    )
    parser.add_argument(
        "--real",
        action="store_true",
        help="Use real SSID (default: demo — required for candle history)",
    )
    parser.add_argument(
        "--refresh-meta",
        action="store_true",
        help="Also include SSID-meta currencies (default: only pairs present in candles/1s)",
    )
    args = parser.parse_args()

    if args.fast:
        args.hours = 6
        args.no_staged = True

    cli_skip = {s.strip().upper() for s in args.skip_currencies.split(",") if s.strip()}
    skip_currencies = set(DEFAULT_SKIP_CURRENCIES)
    skip_currencies.update(cli_skip)

    only_currencies: Optional[Set[str]] = None
    if args.only.strip():
        only_currencies = {s.strip().upper() for s in args.only.split(",") if s.strip()}

    ssid = load_ssid(demo=not args.real)
    acct = "REAL" if args.real else "DEMO"
    clear_pass1_ready()
    clear_status("repair")
    print(f"SSID loaded ({acct}). Starting repair (fresh connection per currency)...")
    run_once(
        ssid=ssid,
        lookback_hours=args.hours,
        timeout_sec=args.request_timeout,
        max_batches=args.max_batches,
        skip_currencies=skip_currencies,
        only_currencies=only_currencies,
        staged=not args.no_staged,
        first_pass_hours=args.first_hours,
        refresh_from_ssid=args.refresh_meta,
    )


if __name__ == "__main__":
    main()
