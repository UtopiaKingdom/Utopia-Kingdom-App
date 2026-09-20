#!/usr/bin/env python3
"""
Download Pocket Option candle history for one asset via SSID (BinaryOptionsToolsV2).

For all currencies in currencies_from_po.txt use fetch_all_currency_history.py.

Put your SSID in: PO SSID Collector/ssid/pocketoption_ssid.txt
Or set env: POCKETOPTION_SSID / PO_SSID
"""

from __future__ import annotations

import argparse
import re
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from datetime import datetime
from pathlib import Path

from BinaryOptionsToolsV2 import PocketOption

from po_ssid import DEMO_SSID_FILE, DEFAULT_SSID_FILE, OUTPUT_DIR, ensure_dirs, load_ssid, resolve_payout_asset


def sanitize(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]+', "_", name)


def normalize_candle(c: dict):
    ts = c.get("timestamp") or c.get("time") or c.get("t")
    close = c.get("close") or c.get("c")
    if ts is None or close is None:
        return None
    try:
        ts = int(float(ts))
        return {
            "ts": ts,
            "dt": datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"),
            "o": float(c.get("open") or c.get("o")) if (c.get("open") or c.get("o")) is not None else None,
            "h": float(c.get("high") or c.get("h")) if (c.get("high") or c.get("h")) is not None else None,
            "l": float(c.get("low") or c.get("l")) if (c.get("low") or c.get("l")) is not None else None,
            "c": float(close),
        }
    except Exception:
        return None


def load_existing_data(path: Path):
    existing_ts = set()
    existing_rows = []
    if not path.exists() or path.stat().st_size == 0:
        return existing_ts, existing_rows

    try:
        with path.open("r", encoding="utf-8") as f:
            header_skipped = False
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("ts |") or line.startswith("-"):
                    header_skipped = True
                    continue
                if not header_skipped:
                    continue

                parts = [p.strip() for p in line.split("|")]
                if len(parts) >= 6:
                    try:
                        ts = int(parts[0])
                        dt = parts[1]
                        o = float(parts[2]) if parts[2] != "-" else None
                        h = float(parts[3]) if parts[3] != "-" else None
                        l = float(parts[4]) if parts[4] != "-" else None
                        c = float(parts[5])
                        existing_ts.add(ts)
                        existing_rows.append({"ts": ts, "dt": dt, "o": o, "h": h, "l": l, "c": c})
                    except Exception:
                        pass
    except Exception as e:
        print(f"Could not fully load existing file: {e}")
    return existing_ts, existing_rows


def read_history_bounds(path: Path) -> tuple[int | None, int | None, int]:
    """Return (oldest_ts, newest_ts, row_count) from a pipe-format history file."""
    if not path.exists() or path.stat().st_size == 0:
        return None, None, 0

    oldest: int | None = None
    newest: int | None = None
    count = 0
    header_done = False
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if not header_done:
                    if line.startswith("ts |") or line.startswith("-"):
                        header_done = True
                    continue
                parts = [p.strip() for p in line.split("|")]
                if len(parts) < 6:
                    continue
                try:
                    ts = int(parts[0])
                except ValueError:
                    continue
                count += 1
                if oldest is None:
                    oldest = ts
                newest = ts
    except Exception as e:
        print(f"Could not read history bounds from {path}: {e}")
    return oldest, newest, count


def is_history_complete(
    path: Path,
    *,
    target_days: int,
    timeframe_sec: int,
    min_coverage_ratio: float = 0.85,
    oldest_tolerance_hours: int = 30,
    max_stale_hours: int = 72,
) -> tuple[bool, str]:
    """True when an on-disk 5s file already covers the requested window."""
    oldest, newest, count = read_history_bounds(path)
    if count == 0 or oldest is None or newest is None:
        return False, "no data"

    now = int(time.time())
    target_ts = now - (target_days * 86400)
    oldest_limit = target_ts + (oldest_tolerance_hours * 3600)

    if oldest > oldest_limit:
        span_days = max(0.0, (newest - oldest) / 86400)
        return False, f"only {span_days:.1f}d saved (need ~{target_days}d)"

    span_days = (newest - oldest) / 86400
    if span_days < max(1.0, target_days - 2):
        return False, f"span {span_days:.1f}d < {target_days}d"

    expected_rows = int((target_days * 86400) / max(1, timeframe_sec))
    min_rows = int(expected_rows * min_coverage_ratio)
    if count < min_rows:
        return False, f"{count:,} rows < ~{min_rows:,} needed"

    if newest < now - (max_stale_hours * 3600):
        return False, f"stale through {datetime.fromtimestamp(newest).strftime('%Y-%m-%d %H:%M')}"

    return True, f"{count:,} rows, {span_days:.1f}d span"


def find_complete_history_file(
    output_dir: Path,
    asset: str,
    *,
    target_days: int,
    timeframe_sec: int,
) -> Path | None:
    """Find any existing 5s history file for asset that already satisfies target_days."""
    candidates = sorted(
        output_dir.glob(f"{asset}_*d_{timeframe_sec}s_history.txt"),
        key=lambda p: p.stat().st_mtime if p.exists() else 0,
        reverse=True,
    )
    for path in candidates:
        ok, _reason = is_history_complete(
            path,
            target_days=target_days,
            timeframe_sec=timeframe_sec,
        )
        if ok:
            return path
    return None


def normalize_batch(batch: list) -> list[dict]:
    out: list[dict] = []
    for c in batch:
        row = normalize_candle(c)
        if row:
            out.append(row)
    return out


def fetch_batch_with_timeout(
    executor: ThreadPoolExecutor,
    api: PocketOption,
    asset: str,
    timeframe_sec: int,
    batch_size: int,
    end_ts: int,
    timeout_sec: float,
) -> list | None:
    future = executor.submit(api.get_candles_advanced, asset, timeframe_sec, batch_size, end_ts)
    try:
        data = future.result(timeout=max(1.0, timeout_sec))
        return data if isinstance(data, list) else None
    except FuturesTimeoutError:
        return None


def format_eta(seconds: float) -> str:
    if seconds <= 0 or seconds > 86400 * 7:
        return "?"
    if seconds >= 3600:
        return f"{seconds / 3600:.1f}h"
    if seconds >= 60:
        return f"{seconds / 60:.0f}m"
    return f"{seconds:.0f}s"


def ssid_account_label(ssid: str) -> str:
    if '"isDemo":1' in ssid or '"isDemo": 1' in ssid:
        return "DEMO"
    if '"isDemo":0' in ssid or '"isDemo": 0' in ssid:
        return "REAL"
    return "UNKNOWN"


def asset_display_name(asset: str) -> str:
    base = asset.replace("_otc", "").replace("#", "").upper()
    if len(base) >= 6:
        return f"{base[:3]}/{base[3:]} OTC"
    return f"{base} OTC"


def is_fatal_fetch_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(
        token in msg
        for token in (
            "invalid asset",
            "asset not found",
            "unknown asset",
            "not available",
        )
    )


def run(
    asset: str,
    timeframe_sec: int,
    target_days: int,
    batch_size: int,
    sleep_between: float,
    output_file: Path | None,
    ssid: str,
    request_timeout_sec: float,
    *,
    api: PocketOption | None = None,
    compact: bool = False,
    progress_prefix: str = "",
) -> tuple[Path, int]:
    ensure_dirs()
    history_file = output_file or (
        OUTPUT_DIR / f"{sanitize(asset)}_{target_days}d_{timeframe_sec}s_history.txt"
    )
    history_file.parent.mkdir(parents=True, exist_ok=True)

    if not compact:
        print("STARTING POCKET OPTION CANDLE HISTORY DOWNLOADER")
        print(f"Currency    : {asset_display_name(asset)} ({asset})")
        print(f"Timeframe   : {timeframe_sec}s")
        print(f"Period      : {target_days} days back")
        print(f"Output      : {history_file}")
        print(f"Batch size  : {batch_size} candles per request")
        print("=" * 80)

    def _download(connected_api: PocketOption) -> tuple[Path, int]:
        payout_data = connected_api.payout() or {}
        api_asset = resolve_payout_asset(asset, payout_data)
        if api_asset is None:
            msg = f"'{asset}' not on PO API (no payout match)"
            if compact:
                print(f"  skip: {msg}")
            else:
                print(f"Warning: {msg}")
            return history_file, 0
        if api_asset != asset:
            note = f"resolved API asset: {api_asset}"
            if compact:
                print(f"  {note}")
            else:
                print(note)

        if api_asset not in payout_data and not compact:
            print(f"Warning: '{api_asset}' not in available assets list.")
            similar = [
                a for a in payout_data if asset.replace("_otc", "").upper() in str(a).upper()
            ]
            if similar:
                print(f"Did you mean: {', '.join(str(s) for s in similar[:5])}")

        existing_ts, existing_rows = load_existing_data(history_file)
        if not compact:
            print(f"\nAlready saved: {len(existing_ts):,} candles")

        target_ts = int(time.time()) - (target_days * 24 * 3600)
        start_ts = int(time.time())
        total_span = max(1, start_ts - target_ts)
        est_candles = int(total_span / max(1, timeframe_sec))
        est_batches = max(1, est_candles // max(1, batch_size))
        if not compact:
            print(f"Stopping at: {datetime.fromtimestamp(target_ts).strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"Estimated   : ~{est_candles:,} candles (~{est_batches:,} batches)")
        else:
            prefix = f"{progress_prefix} " if progress_prefix else ""
            print(
                f"  {prefix}~{est_candles:,} candles, ~{est_batches:,} batches "
                f"(timeout {request_timeout_sec:.0f}s/batch)...",
                flush=True,
            )

        current_end_ts = start_ts + 3600
        oldest_ts = current_end_ts
        batch_num = 0
        total_fetched = 0
        new_rows = []
        last_print_time = 0.0
        loop_start = time.time()
        consecutive_errors = 0
        if not compact:
            print(f"Downloading (timeout {request_timeout_sec:.0f}s per batch, sleep {sleep_between}s)...")

        with ThreadPoolExecutor(max_workers=1) as executor:
            while oldest_ts > target_ts:
                batch_num += 1
                t0 = time.time()
                if compact and batch_num == 1:
                    print("  waiting for first API batch...", flush=True)
                try:
                    batch = fetch_batch_with_timeout(
                        executor,
                        connected_api,
                        api_asset,
                        timeframe_sec,
                        batch_size,
                        current_end_ts,
                        request_timeout_sec,
                    )
                    if batch is None:
                        consecutive_errors += 1
                        msg = f"Batch {batch_num}: timed out after {request_timeout_sec:.0f}s"
                        if compact:
                            print(f"\n  {msg}")
                            print("  Tip: try --fast or refresh SSID")
                        else:
                            print(f"\n{msg}")
                            print("Tip: refresh SSID from browser WS, or try --fast with smaller --batch-size.")
                        if consecutive_errors >= 3:
                            break
                        break
                    consecutive_errors = 0
                except Exception as e:
                    consecutive_errors += 1
                    if is_fatal_fetch_error(e):
                        if compact:
                            print(f"\n  skip: {e}")
                        else:
                            print(f"\nSkip: {e}")
                        break
                    if compact:
                        print(f"\n  batch {batch_num} error: {e}")
                    else:
                        print(f"\nBatch {batch_num} error: {e}")
                    if consecutive_errors >= 3:
                        if compact:
                            print("  too many errors, stopping this currency")
                        break
                    time.sleep(2)
                    continue

                total_fetched += len(batch)
                normalized = normalize_batch(batch)
                for n in normalized:
                    if n["ts"] not in existing_ts:
                        new_rows.append(n)
                        existing_ts.add(n["ts"])

                if normalized:
                    batch_oldest = min(n["ts"] for n in normalized)
                    if batch_oldest < oldest_ts:
                        oldest_ts = batch_oldest
                else:
                    if compact:
                        print(f"\n  batch {batch_num}: no valid candles")
                    else:
                        print(f"\nBatch {batch_num}: no valid candles")
                    break

                current_end_ts = oldest_ts - 1

                now = time.time()
                show_progress = (now - last_print_time >= 0.4) or batch_num <= 3
                if show_progress:
                    progress = max(0.0, min(100.0, ((start_ts - oldest_ts) / total_span) * 100))
                    elapsed = now - loop_start
                    rate = total_fetched / elapsed if elapsed > 0 else 0
                    eta = (elapsed / progress * (100 - progress)) if progress > 0.5 else 0
                    bar_length = 40
                    filled = int(bar_length * progress / 100)
                    bar = "#" * filled + "." * (bar_length - filled)
                    batch_sec = now - t0
                    lead = f"  {progress_prefix} " if progress_prefix else ""
                    print(
                        f"\r{lead}[{bar}] {progress:5.1f}% | batch {batch_num:,}/{est_batches:,} | "
                        f"new {len(new_rows):,} | {rate:,.0f}/s | {batch_sec:.1f}s/batch | ETA {format_eta(eta)} | "
                        f"oldest {datetime.fromtimestamp(oldest_ts).strftime('%Y-%m-%d %H:%M')}",
                        end="",
                        flush=True,
                    )
                    last_print_time = now

                if sleep_between > 0:
                    time.sleep(sleep_between)

        if batch_num > 0:
            print()
        if not compact:
            print("Sorting candles...")
        all_rows = existing_rows + new_rows
        all_rows.sort(key=lambda x: x["ts"])

        with history_file.open("w", encoding="utf-8") as f:
            f.write("ts | datetime | open | high | low | close\n")
            f.write("-" * 90 + "\n")
            for r in all_rows:
                o = f"{r['o']:.5f}" if r["o"] is not None else "-"
                h = f"{r['h']:.5f}" if r["h"] is not None else "-"
                l = f"{r['l']:.5f}" if r["l"] is not None else "-"
                c = f"{r['c']:.5f}"
                f.write(f"{r['ts']} | {r['dt']} | {o} | {h} | {l} | {c}\n")

        if not compact:
            print("\n" + "=" * 80)
            print("DONE")
            print(f"File        : {history_file}")
            print(f"Unique rows : {len(all_rows):,}")
            if all_rows:
                print(
                    f"Oldest      : {datetime.fromtimestamp(all_rows[0]['ts']).strftime('%Y-%m-%d %H:%M:%S')}"
                )
            print("=" * 80)
        return history_file, len(all_rows)

    if api is not None:
        return _download(api)

    account = ssid_account_label(ssid)
    print(f"Connecting to Pocket Option via SSID ({account} account)...")
    with PocketOption(ssid=ssid) as connected_api:
        print(f"CONNECTION SUCCESSFUL - Pocket Option API is ready ({account}).")
        print(f"Fetching history for: {asset_display_name(asset)} only")
        print("=" * 80)
        return _download(connected_api)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch PO currency candle history via SSID")
    parser.add_argument("--asset", default="AEDCNY_otc", help="Asset name, e.g. AEDCNY_otc (AED/CNY OTC)")
    parser.add_argument("--timeframe", type=int, default=5, help="Candle size in seconds")
    parser.add_argument("--days", type=int, default=365, help="How many days of history")
    parser.add_argument("--batch-size", type=int, default=1200, help="Candles per API request (default: 1200)")
    parser.add_argument("--sleep", type=float, default=0.0, help="Pause between batches in seconds (default: 0)")
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Max speed: batch-size 1500, no sleep, 45s timeout",
    )
    parser.add_argument("--output", type=Path, help="Output txt file path")
    parser.add_argument("--ssid", help="Raw SSID string (overrides file/env)")
    parser.add_argument("--ssid-file", type=Path, help="Path to SSID file")
    parser.add_argument(
        "--real",
        action="store_true",
        help="Use real SSID from pocketoption_ssid.txt (default: demo — works best for history)",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help=f"Use demo SSID from {DEMO_SSID_FILE.name} (default when --real is not set)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Seconds to wait per batch before giving up (default: 30)",
    )
    args = parser.parse_args()

    batch_size = args.batch_size
    sleep_between = args.sleep
    timeout = args.timeout
    if args.fast:
        batch_size = max(batch_size, 1500)
        sleep_between = 0.0
        timeout = max(timeout, 45.0)

    if args.ssid:
        ssid = args.ssid.strip()
    elif args.real:
        ssid = load_ssid(args.ssid_file, demo=False)
    else:
        ssid = load_ssid(args.ssid_file or DEMO_SSID_FILE, demo=True)

    run(
        asset=args.asset,
        timeframe_sec=args.timeframe,
        target_days=args.days,
        batch_size=batch_size,
        sleep_between=sleep_between,
        output_file=args.output,
        ssid=ssid,
        request_timeout_sec=timeout,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
