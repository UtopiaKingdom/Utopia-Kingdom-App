#!/usr/bin/env python3
"""Scan all Pocket Option assets, balances, and payouts via SSID."""

from __future__ import annotations

import time

from BinaryOptionsToolsV2.pocketoption import PocketOption

from po_ssid import SSID_DIR, load_ssid

REFRESH_SECONDS = 10


def _read_ssid_file(name: str) -> str:
    path = SSID_DIR / name
    if path.exists():
        txt = path.read_text(encoding="utf-8").strip()
        if txt:
            return txt
    raise FileNotFoundError(path)


def main() -> None:
    print("Pocket Option - asset & balance scanner\n")

    try:
        demo_ssid = _read_ssid_file("pocketoption_demo_ssid.txt")
    except FileNotFoundError:
        demo_ssid = load_ssid()

    try:
        real_ssid = _read_ssid_file("pocketoption_ssid.txt")
    except FileNotFoundError:
        real_ssid = load_ssid()

    while True:
        try:
            with PocketOption(ssid=demo_ssid) as api:
                print("Connected to DEMO")
                time.sleep(2)
                demo_bal = api.balance()
                demo_val = demo_bal if isinstance(demo_bal, (int, float)) else demo_bal.get("balance", demo_bal)
                print(f"Demo balance: {demo_val} USD\n")

            with PocketOption(ssid=real_ssid) as api:
                print("Connected to REAL")
                time.sleep(2)
                real_bal = api.balance()
                real_val = real_bal if isinstance(real_bal, (int, float)) else real_bal.get("balance", real_bal)
                print(f"Real balance: {real_val} USD\n")

                payouts = api.payout() or {}
                print(f"Total assets: {len(payouts)}\n")
                rows = []
                for asset, payout in payouts.items():
                    try:
                        p = int(round(float(payout)))
                        name = str(asset).replace("_otc", " OTC").upper()
                        rows.append((name, p))
                    except Exception:
                        continue
                rows.sort(key=lambda x: -x[1])
                for name, payout in rows:
                    mark = "+" if payout >= 85 else "~"
                    print(f"  {mark} {name:<18} -> {payout}%")
                print(f"\nRefresh every {REFRESH_SECONDS}s\n")
                time.sleep(REFRESH_SECONDS)
        except Exception as e:
            print(f"Error: {e}")
            time.sleep(8)


if __name__ == "__main__":
    main()
