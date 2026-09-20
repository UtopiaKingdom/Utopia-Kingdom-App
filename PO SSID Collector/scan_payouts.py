#!/usr/bin/env python3
"""Sync ALL Pocket Option OTC currencies + payouts from SSID into BotsHub meta.

Prefers the live Edge/Chrome SSID harvested by edge_price_feed (same browser
that never goes offline for ticks). Hot-reloads when that session rotates.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from BinaryOptionsToolsV2 import PocketOption

from po_ssid import (
    CURRENCIES_FILE,
    PAYOUTS_FILE,
    detect_account_from_ssid,
    ensure_dirs,
    load_ssid,
    write_meta_from_payouts,
)

# Write every OTC asset from SSID (bots filter by their own MIN_PAYOUT at runtime).
PAYOUT_MIN_WRITE = int(os.environ.get("PO_PAYOUT_MIN_WRITE", "0"))
HIGHLIGHT_MIN = int(os.environ.get("PO_PAYOUT_HIGHLIGHT_MIN", "88"))
REFRESH_SECONDS = float(os.environ.get("PO_PAYOUT_REFRESH_SEC", "10"))

REPO_ROOT = Path(__file__).resolve().parents[1]
PIPELINE = REPO_ROOT / "BotsHub" / "pipeline"
if str(PIPELINE) not in sys.path:
    sys.path.insert(0, str(PIPELINE))


def _load_edge_ssid() -> str | None:
    try:
        from edge_ssid_sync import load_live_ssid

        return load_live_ssid()
    except Exception:
        return None


def resolve_ssid(*, demo: bool | None, from_edge: bool) -> tuple[str, str]:
    """Return (ssid, account_label). demo=None means auto from frame."""
    if from_edge:
        edge = _load_edge_ssid()
        if edge:
            acct = detect_account_from_ssid(edge)
            return edge, acct.upper()
        print("Waiting for live Edge SSID (edge_price_feed must capture auth)…")
    if demo is None:
        edge = _load_edge_ssid()
        if edge:
            return edge, detect_account_from_ssid(edge).upper()
        # Fall back to real file, then demo.
        try:
            ssid = load_ssid(demo=False)
            return ssid, detect_account_from_ssid(ssid).upper()
        except Exception:
            ssid = load_ssid(demo=True)
            return ssid, detect_account_from_ssid(ssid).upper()
    ssid = load_ssid(demo=bool(demo))
    return ssid, ("DEMO" if demo else "REAL")


def run(*, demo: bool | None = True, once: bool = False, from_edge: bool = False) -> None:
    ensure_dirs()
    print("SSID currency sync running. Ctrl+C to stop.")
    print(f"Payouts -> {PAYOUTS_FILE}")
    print(f"Currencies -> {CURRENCIES_FILE}")
    print(
        f"Refresh: every {REFRESH_SECONDS}s | write all OTC with payout >= {PAYOUT_MIN_WRITE}% "
        f"| source={'edge-live' if from_edge else 'auto/file'}"
    )

    current_ssid = ""
    while True:
        try:
            ssid, acct = resolve_ssid(demo=demo, from_edge=from_edge)
        except Exception as e:
            if once:
                raise
            print(f"SSID not ready: {e}")
            time.sleep(5)
            continue

        if ssid != current_ssid:
            current_ssid = ssid
            print(f"Using {acct} SSID (live Edge preferred when present)")

        try:
            with PocketOption(ssid=ssid) as api:
                print(f"Connected to Pocket Option via {acct} SSID")
                while True:
                    # Hot-reload if Edge harvested a newer session.
                    try:
                        fresh, fresh_acct = resolve_ssid(demo=demo, from_edge=from_edge or demo is None)
                        if fresh and fresh != current_ssid:
                            print(f"SSID rotated ({fresh_acct}) — reconnecting")
                            current_ssid = fresh
                            break
                    except Exception:
                        pass

                    try:
                        from payout_truth_sync import (
                            DEFAULT_DURATION,
                            apply_duration_truth,
                            fetch_ssid_catalog,
                        )
                        from edge_payout_sync import save_edge_payouts

                        catalog = fetch_ssid_catalog(api, DEFAULT_DURATION)
                        payout_data = apply_duration_truth(catalog, DEFAULT_DURATION)
                        result = save_edge_payouts(payout_data, source="scan-ssid")
                        total_otc = len(payout_data)
                        n_pay = int(result.get("n_pay") or result.get("n") or 0)
                        n_cur = int(result.get("n_cur") or 0)
                        high = int(result.get("high92") or 0)
                    except Exception as sync_err:
                        payout_data = api.payout() or {}
                        total_otc = sum(1 for a in payout_data if "_otc" in str(a).lower())
                        n_pay, n_cur = write_meta_from_payouts(
                            payout_data,
                            min_payout_write=PAYOUT_MIN_WRITE,
                            highlight_min_payout=HIGHLIGHT_MIN,
                        )
                        high = sum(
                            1
                            for a, p in payout_data.items()
                            if "_otc" in str(a).lower()
                            and isinstance(p, (int, float))
                            and int(round(float(p))) >= HIGHLIGHT_MIN
                        )
                        print(f"payout_truth_sync fallback: {sync_err}")
                    print(
                        f"Saved {n_pay} payout rows + {n_cur} currencies "
                        f"({total_otc} OTC from SSID, {high} at >={HIGHLIGHT_MIN}%). "
                        f"Next update in {REFRESH_SECONDS}s"
                    )
                    if once:
                        return
                    time.sleep(REFRESH_SECONDS)
        except Exception as e:
            if once:
                raise
            print(f"Reconnecting after error: {e}")
            time.sleep(5)


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync all PO OTC currencies/payouts to BotsHub meta")
    grp = parser.add_mutually_exclusive_group()
    grp.add_argument(
        "--real",
        action="store_true",
        help="Prefer real SSID file when Edge live session is missing",
    )
    grp.add_argument(
        "--demo",
        action="store_true",
        help="Prefer demo SSID file when Edge live session is missing",
    )
    grp.add_argument(
        "--from-edge",
        action="store_true",
        help="Require live SSID harvested from Edge/Chrome on this machine",
    )
    grp.add_argument(
        "--auto",
        action="store_true",
        help="Prefer live Edge SSID; else fall back to files (recommended)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one sync and exit",
    )
    args = parser.parse_args()

    from_edge = bool(args.from_edge)
    if args.demo:
        demo: bool | None = True
    else:
        # --auto / --from-edge / --real / default: follow Edge when present.
        demo = None

    run(demo=demo, once=args.once, from_edge=from_edge)


if __name__ == "__main__":
    main()
