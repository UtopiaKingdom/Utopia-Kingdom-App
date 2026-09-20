#!/usr/bin/env python3
"""Quick Pocket Option SSID connectivity check (BinaryOptionsToolsV2)."""

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

from po_ssid import detect_account_from_ssid, load_ssid, parse_balance_response


def check_ssid(ssid: str, *, currency_hint: str = "USD") -> dict:
    account = detect_account_from_ssid(ssid)
    is_demo = account == "demo"
    default_currency = (currency_hint or ("USD" if is_demo else "EUR")).upper()
    started = time.time()

    try:
        with PocketOption(ssid=ssid) as api:
            balance_response = api.balance()
            balance_value, currency = parse_balance_response(
                balance_response,
                default_currency=default_currency,
            )

            elapsed_ms = int((time.time() - started) * 1000)
            return {
                "success": True,
                "online": True,
                "connected": True,
                "account": account,
                "is_demo": is_demo,
                "balance": balance_value,
                "currency": currency,
                "latency_ms": elapsed_ms,
            }
    except Exception as e:
        elapsed_ms = int((time.time() - started) * 1000)
        msg = str(e)
        expired = bool(re.search(r"expired|invalid|unauthorized|auth", msg, re.I))
        return {
            "success": False,
            "online": False,
            "connected": False,
            "account": account,
            "is_demo": is_demo,
            "currency": default_currency,
            "error": msg,
            "expired": expired,
            "latency_ms": elapsed_ms,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Pocket Option SSID connectivity")
    parser.add_argument("--ssid", help="Complete Pocket Option SSID string")
    parser.add_argument("--ssid-file", help="Path to SSID file")
    parser.add_argument("--currency", default="USD", help="Balance currency hint (EUR, USD, ...)")
    parser.add_argument("--json-only", action="store_true")
    args = parser.parse_args()

    if args.ssid:
        ssid = args.ssid.strip()
    else:
        try:
            ssid = load_ssid(args.ssid_file)
        except Exception as e:
            print(json.dumps({"success": False, "online": False, "error": str(e)}))
            return 1

    result = check_ssid(ssid, currency_hint=args.currency)
    print(json.dumps(result))
    return 0 if result.get("online") else 1


if __name__ == "__main__":
    raise SystemExit(main())
