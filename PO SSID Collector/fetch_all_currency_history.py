#!/usr/bin/env python3
"""
Fetch 5s candle history for every currency in currencies_from_po.txt, then resample
to 15s, 30s, 1m, 3m, 5m, etc. (same pipeline as single-pair AEDCNY_otc).

Default: 30 days of 5-second candles, saved under D:\\APP SAVE\\output\\
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from BinaryOptionsToolsV2 import PocketOption

from fetch_currency_history import (
    asset_display_name,
    find_complete_history_file,
    is_history_complete,
    read_history_bounds,
    run as fetch_one,
)
from po_ssid import (
    CURRENCIES_FILE,
    DEFAULT_SSID_FILE,
    DEMO_SSID_FILE,
    OUTPUT_DIR,
    base_upper_to_asset_name,
    detect_account_from_ssid,
    display_to_base_upper,
    ensure_dirs,
    load_currencies_from_file,
    load_ssid,
)
from resample_candles import DEFAULT_LABELS, run as resample_one


def filter_assets(assets: list[str], only: str) -> list[str]:
    if not only.strip():
        return assets
    want = {
        base_upper_to_asset_name(display_to_base_upper(part.strip()))
        for part in only.split(",")
        if part.strip()
    }
    return [a for a in assets if a in want]


def verify_ssid(ssid: str, *, ssid_file: Path) -> None:
    try:
        with PocketOption(ssid=ssid) as api:
            api.payout()
    except Exception as e:
        raise SystemExit(
            "SSID connection failed.\n"
            f"  Error: {e}\n"
            f"  File : {ssid_file}\n\n"
            "Fix:\n"
            "  1. Open pocketoption.com -> DevTools -> Network -> WS -> copy the 42[\"auth\",...] frame\n"
            f"  2. Paste into {DEMO_SSID_FILE} (demo) or {DEFAULT_SSID_FILE} (real)\n"
            "  3. Test: python check_ssid.py --ssid-file ssid\\pocketoption_demo_ssid.txt\n"
            "  4. Re-run (demo is default): python fetch_all_currency_history.py"
        ) from e


def is_resample_complete(output_dir: Path, asset: str, labels: list[str]) -> tuple[bool, str]:
    root = output_dir / asset
    missing = [label for label in labels if not (root / f"{asset}_{label}_history.txt").exists()]
    if missing:
        return False, f"missing {', '.join(missing)}"
    return True, f"{len(labels)} timeframes present"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch 5s history for all currencies in currencies_from_po.txt and resample"
    )
    parser.add_argument(
        "--currencies-file",
        type=Path,
        default=CURRENCIES_FILE,
        help="Currency list file (default: BotsHub/Prices/meta/currencies_from_po.txt)",
    )
    parser.add_argument("--days", type=int, default=30, help="Days of 5s history per pair (default: 30)")
    parser.add_argument("--timeframe", type=int, default=5, help="Candle size in seconds (default: 5)")
    parser.add_argument("--batch-size", type=int, default=1200, help="Candles per API request")
    parser.add_argument("--sleep", type=float, default=0.0, help="Pause between fetch batches")
    parser.add_argument(
        "--sleep-between",
        type=float,
        default=0.25,
        help="Pause between currencies in seconds (default: 0.25)",
    )
    parser.add_argument(
        "--fast",
        action="store_true",
        help="Max speed: batch-size 1500, no sleep, 45s timeout",
    )
    parser.add_argument(
        "--matched-only",
        action="store_true",
        help="Only currencies tagged with <-- MATCHED in the list file",
    )
    parser.add_argument(
        "--only",
        default="",
        help='Comma-separated filter, e.g. "AED/CNY,EUR/USD OTC"',
    )
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        help="Only resample existing 5s files (skip API download)",
    )
    parser.add_argument(
        "--skip-resample",
        action="store_true",
        help="Only download 5s files (skip building 15s/30s/1m/...)",
    )
    parser.add_argument(
        "--timeframes",
        default=",".join(DEFAULT_LABELS),
        help=f"Resample targets (default: {','.join(DEFAULT_LABELS)})",
    )
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR, help="Base output directory")
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
        "--force",
        action="store_true",
        help="Re-download and re-resample even when complete files already exist",
    )
    parser.add_argument("--timeout", type=float, default=30.0, help="Seconds per fetch batch")
    args = parser.parse_args()

    batch_size = args.batch_size
    sleep_between_batches = args.sleep
    timeout = args.timeout
    if args.fast:
        batch_size = max(batch_size, 1500)
        sleep_between_batches = 0.0
        timeout = max(timeout, 45.0)

    ensure_dirs()
    assets = load_currencies_from_file(args.currencies_file, matched_only=args.matched_only)
    assets = filter_assets(assets, args.only)
    if not assets:
        raise SystemExit(f"No currencies found in {args.currencies_file}")

    labels = [x.strip() for x in args.timeframes.split(",") if x.strip()]

    if args.ssid:
        ssid = args.ssid.strip()
        ssid_source = Path("(inline --ssid)")
    elif args.real:
        ssid_source = args.ssid_file or DEFAULT_SSID_FILE
        ssid = load_ssid(ssid_source, demo=False)
    else:
        ssid_source = args.ssid_file or DEMO_SSID_FILE
        ssid = load_ssid(ssid_source, demo=True)

    print("BATCH POCKET OPTION HISTORY DOWNLOADER")
    print(f"Currencies  : {len(assets)} from {args.currencies_file}")
    print(f"Period      : {args.days} days x {args.timeframe}s candles")
    print(f"Output      : {args.output_dir}")
    print(f"Resample    : {', '.join(labels) if not args.skip_resample else 'skipped'}")
    print("=" * 80)

    ok_fetch = 0
    ok_resample = 0
    skipped_fetch = 0
    skipped_resample = 0
    skipped_invalid = 0
    failed: list[str] = []

    def process_asset(api: PocketOption | None, asset: str, index: int) -> None:
        nonlocal ok_fetch, ok_resample, skipped_fetch, skipped_resample, skipped_invalid
        label = asset_display_name(asset)
        print(f"\n[{index}/{len(assets)}] {label} ({asset})")

        history_file = args.output_dir / f"{asset}_{args.days}d_{args.timeframe}s_history.txt"
        row_count = 0
        need_fetch = not args.skip_fetch
        need_resample = not args.skip_resample

        if need_fetch and not args.force:
            existing = find_complete_history_file(
                args.output_dir,
                asset,
                target_days=args.days,
                timeframe_sec=args.timeframe,
            )
            if existing is not None:
                history_file = existing
                _oldest, _newest, row_count = read_history_bounds(history_file)
                _ok, reason = is_history_complete(
                    history_file,
                    target_days=args.days,
                    timeframe_sec=args.timeframe,
                )
                print(f"  skip fetch: already complete ({reason})")
                print(f"  file: {history_file.name}")
                skipped_fetch += 1
                need_fetch = False

        if need_fetch and args.skip_fetch:
            if not history_file.exists():
                print("  skip: no existing 5s file")
                failed.append(asset)
                return
            _oldest, _newest, row_count = read_history_bounds(history_file)
        elif need_fetch:
            try:
                history_file, row_count = fetch_one(
                    asset=asset,
                    timeframe_sec=args.timeframe,
                    target_days=args.days,
                    batch_size=batch_size,
                    sleep_between=sleep_between_batches,
                    output_file=history_file,
                    ssid=ssid,
                    request_timeout_sec=timeout,
                    api=api,
                    compact=True,
                    progress_prefix=f"[{index}/{len(assets)}]",
                )
            except Exception as e:
                print(f"  fetch failed: {e}")
                failed.append(asset)
                return

        if row_count <= 0:
            _oldest, _newest, row_count = read_history_bounds(history_file)
        if row_count <= 0:
            print("  fetch: no candles saved (skipped or failed)")
            skipped_invalid += 1
            return

        if need_fetch:
            ok_fetch += 1
            print(f"  fetch: {row_count:,} candles -> {history_file.name}")

        if not need_resample:
            return

        if not args.force:
            resample_ok, resample_reason = is_resample_complete(args.output_dir, asset, labels)
            if resample_ok:
                print(f"  skip resample: {resample_reason}")
                skipped_resample += 1
                return

        try:
            print(f"  resampling -> {args.output_dir / asset} ...", flush=True)
            resample_one(history_file, args.output_dir, labels, asset_stem=asset)
            ok_resample += 1
            print(f"  resample: done -> {args.output_dir / asset}")
        except Exception as e:
            print(f"  resample failed: {e}")
            failed.append(asset)

    if args.skip_fetch:
        for i, asset in enumerate(assets, 1):
            process_asset(None, asset, i)
            if args.sleep_between > 0 and i < len(assets):
                time.sleep(args.sleep_between)
    else:
        account = detect_account_from_ssid(ssid)
        print(f"Connecting via SSID ({account} account, {ssid_source.name})...")
        verify_ssid(ssid, ssid_file=ssid_source)
        with PocketOption(ssid=ssid) as api:
            print(f"Connected ({account}). Starting batch download...\n")
            for i, asset in enumerate(assets, 1):
                process_asset(api, asset, i)
                if args.sleep_between > 0 and i < len(assets):
                    time.sleep(args.sleep_between)

    print("\n" + "=" * 80)
    print("BATCH SUMMARY")
    print(f"  Total currencies : {len(assets)}")
    print(f"  Fetched OK       : {ok_fetch}")
    print(f"  Skipped fetch    : {skipped_fetch} (already had full month)")
    print(f"  Resampled OK     : {ok_resample}")
    print(f"  Skipped resample : {skipped_resample}")
    print(f"  Skipped invalid  : {skipped_invalid} (not on PO API / no history)")
    print(f"  Failed           : {len(failed)}")
    if failed:
        print(f"  Failed list      : {', '.join(failed[:20])}" + (" ..." if len(failed) > 20 else ""))
    print("=" * 80)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
