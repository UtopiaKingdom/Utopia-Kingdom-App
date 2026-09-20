#!/usr/bin/env python3
"""Fetch Pocket Option account balance using SSID (BinaryOptionsToolsV2)."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

try:
    from BinaryOptionsToolsV2.pocketoption import PocketOption
except ImportError:
    print("BinaryOptionsToolsV2 not installed. Installing...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "BinaryOptionsToolsV2"])
    from BinaryOptionsToolsV2.pocketoption import PocketOption

from po_ssid import DEFAULT_SSID_FILE, load_ssid


def _parse_ssid_mode(ssid: str) -> bool:
    json_start = ssid.find("{")
    json_end = ssid.rfind("}") + 1
    if json_start != -1 and json_end > json_start:
        try:
            auth_data = json.loads(ssid[json_start:json_end])
            return bool(auth_data.get("isDemo", 1))
        except Exception:
            pass
    return False


def fetch_balance_from_ssid(ssid: str, *, verbose: bool = True) -> dict:
    if verbose:
        print(f"Loaded SSID (first 50 chars): {ssid[:50]}...")

    is_demo = _parse_ssid_mode(ssid)
    account_type = "DEMO" if is_demo else "REAL"

    if verbose:
        print(f"\nConnecting to {account_type} account...")

    try:
        with PocketOption(ssid=ssid) as api:
            if verbose:
                print(f"Connected to {account_type} account")
            time.sleep(2)

            balance_response = api.balance()
            if isinstance(balance_response, dict):
                balance_value = balance_response.get("balance", balance_response.get("amount", 0))
            elif isinstance(balance_response, (int, float)):
                balance_value = balance_response
            else:
                try:
                    balance_value = float(balance_response)
                except Exception:
                    balance_value = 0

            balance_value = float(balance_value) if balance_value else 0.0
            result = {
                "success": True,
                "balance": balance_value,
                "currency": "USD",
                "is_demo": is_demo,
                "connected": True,
            }
            if verbose:
                print(f"Balance: ${balance_value:.2f} ({account_type})")
            return result
    except Exception as e:
        error_msg = str(e)
        if verbose:
            print(f"Connection error: {error_msg}")
        return {"success": False, "error": error_msg, "connected": False}


def main() -> int:
    parser = argparse.ArgumentParser(description="Pocket Option balance fetcher")
    parser.add_argument("--ssid", help="Complete Pocket Option SSID string")
    parser.add_argument("--ssid-file", type=Path, help="Path to a file containing the SSID")
    parser.add_argument("--json-only", action="store_true", help="Print only final JSON output")
    args = parser.parse_args()

    verbose = not args.json_only
    if args.ssid:
        ssid = args.ssid.strip()
    else:
        try:
            ssid = load_ssid(args.ssid_file)
            if verbose:
                print(f"Loaded SSID from: {args.ssid_file or DEFAULT_SSID_FILE}")
        except Exception as e:
            result = {"success": False, "error": str(e)}
            print(json.dumps(result))
            return 1

    result = fetch_balance_from_ssid(ssid, verbose=verbose)
    if verbose:
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(result))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
