#!/usr/bin/env python3
"""
Live OTC forex prices via SSID → BotsHub/Prices/candles/1s/ (mitmproxy replacement).

Default mode is live WebSocket streams (~1 tick/sec per pair):
  PO's library allows 4 subscribe_symbol streams per connection, so we open
  enough parallel clients to cover every OTC forex pair.

Fallback `--mode poll` uses history() sweeps if streams are unavailable.
"""

from __future__ import annotations

import argparse
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

from BinaryOptionsToolsV2 import PocketOption
from BinaryOptionsToolsV2.config import Config

from po_ssid import (
    CANDLES_ROOT,
    asset_to_display_currency,
    display_to_base_upper,
    ensure_dirs,
    load_ssid,
)

ONE_SEC_DIR = CANDLES_ROOT / "1s"
MAX_LINES_1S = int(os.environ.get("PO_LIVE_MAX_LINES", "10000"))
STREAMS_PER_CLIENT = max(1, int(os.environ.get("PO_LIVE_STREAMS_PER_CLIENT", "4")))
# Hard cap: too many parallel SSID sockets can lock up Pocket Option in the browser.
MAX_STREAM_CLIENTS = max(1, int(os.environ.get("PO_LIVE_MAX_STREAM_CLIENTS", "1")))
POLL_WORKERS = max(1, int(os.environ.get("PO_LIVE_WORKERS", "1")))
ASSET_REFRESH_SEC = float(os.environ.get("PO_LIVE_ASSET_REFRESH_SEC", "120"))
STATUS_EVERY_SEC = float(os.environ.get("PO_LIVE_STATUS_SEC", "30"))
TRIM_EVERY_SEC = float(os.environ.get("PO_LIVE_TRIM_SEC", "60"))
CLIENT_STAGGER_SEC = float(os.environ.get("PO_LIVE_CLIENT_STAGGER_SEC", "0.35"))
STREAM_RECONNECT_SEC = float(os.environ.get("PO_LIVE_STREAM_RECONNECT_SEC", "3"))

FIAT_CODES = {
    "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD", "CNY", "HKD", "SGD",
    "NOK", "SEK", "DKK", "TRY", "ZAR", "MXN", "BRL", "INR", "IDR", "PHP", "THB",
    "MYR", "VND", "PKR", "EGP", "ARS", "CLP", "COP", "RUB", "UAH", "PLN", "HUF",
    "CZK", "RON", "AED", "SAR", "QAR", "OMR", "BHD", "JOD", "KWD", "MAD", "TND",
    "DZD", "NGN", "KES", "LBP", "IRR", "SYP", "YER", "BDT", "PEN", "UYU", "CRC",
    "GHS", "UGX", "TZS", "ETB",
}


def is_forex_otc(asset: str) -> bool:
    raw = str(asset or "").strip()
    if not raw or raw.startswith("#"):
        return False
    if not raw.lower().endswith("_otc"):
        return False
    base = raw[:-4]
    if len(base) != 6 or not base.isalpha():
        return False
    return base[:3].upper() in FIAT_CODES and base[3:].upper() in FIAT_CODES


def forex_assets_from_payout(payout_data: dict) -> list[str]:
    return sorted({str(a) for a in (payout_data or {}) if is_forex_otc(str(a))})


def _make_config(*, demo: bool = True) -> Config:
    # Optional URL override — leave empty to use library defaults (most reliable).
    raw = os.environ.get("PO_LIVE_URLS", "").strip()
    urls = [u.strip() for u in raw.split(",") if u.strip()] if raw else []
    _ = demo  # reserved for future demo/real URL presets via PO_LIVE_URLS
    return Config(
        connection_initialization_timeout_secs=int(os.environ.get("PO_LIVE_CONNECT_TIMEOUT", "60")),
        timeout_secs=int(os.environ.get("PO_LIVE_TIMEOUT", "30")),
        reconnect_time=int(os.environ.get("PO_LIVE_RECONNECT", "5")),
        urls=urls,
    )


class LiveForexCollector:
    def __init__(self, *, demo: bool = True, mode: str = "stream", poll_workers: int = POLL_WORKERS):
        self.demo = demo
        self.mode = str(mode or "stream").strip().lower()
        self.poll_workers = max(1, int(poll_workers))
        self._lock = threading.Lock()
        self._ssid = ""
        self._assets: list[str] = []
        self._last_write_second: dict[str, datetime] = {}
        self._latest: dict[str, dict] = {}
        self._prev_price: dict[str, float] = {}
        self._tick_counts: dict[str, int] = {}
        self._stopping = False
        self._last_trim = 0.0
        self._last_status = 0.0
        self._started_at = 0.0
        self._mode_running = self.mode

        # poll mode
        self._poll_apis: list[PocketOption] = []
        self._sweep_n = 0
        self._last_sweep_dt = 0.0
        self._last_ok = 0

        # stream mode
        self._stream_threads: list[threading.Thread] = []
        self._stream_apis: list[PocketOption] = []
        self._live_assets: set[str] = set()
        self._stream_errors = 0

    def start(self) -> None:
        ensure_dirs()
        ONE_SEC_DIR.mkdir(parents=True, exist_ok=True)
        self._ssid = load_ssid(demo=self.demo)
        self._started_at = time.time()
        self._assets = self._fetch_assets()
        acct = "DEMO" if self.demo else "REAL"
        print("SSID live OTC forex collector (mitmproxy replacement). Ctrl+C to stop.")
        print(f"Account: {acct} | mode={self.mode} | out: {ONE_SEC_DIR}")
        print(f"Forex pairs: {len(self._assets)}")

        if self.mode == "poll":
            self._mode_running = "poll"
            self._connect_poll_workers()
            return

        # stream (default) — true ~1s WS candles
        self._mode_running = "stream"
        self._start_stream_farm()
        if self._stream_alive <= 0 and self.mode == "auto":
            print("Stream mode failed; falling back to poll.")
            self._mode_running = "poll"
            self._connect_poll_workers()

    def stop(self) -> None:
        self._stopping = True
        self._close_poll_workers()
        self._close_stream_apis()

    def _open_api(self) -> PocketOption:
        api = PocketOption(ssid=self._ssid, config=_make_config(demo=self.demo))
        api.__enter__()
        return api

    def _fetch_assets(self) -> list[str]:
        api = self._open_api()
        try:
            payout = api.payout() or {}
            assets = forex_assets_from_payout(payout)
            if not assets:
                raise RuntimeError("No OTC forex assets returned from payout()")
            return assets
        finally:
            try:
                api.__exit__(None, None, None)
            except Exception:
                pass

    # --- shared write / status -------------------------------------------------

    def _write_tick(self, asset: str, price: float) -> bool:
        try:
            price_f = float(price)
        except (TypeError, ValueError):
            return False

        now = datetime.now().replace(microsecond=0)
        code = display_to_base_upper(asset_to_display_currency(asset))
        if not code:
            return False
        file_stem = code if code.endswith("_OTC") else f"{code}_OTC"
        currency_code = file_stem.replace("_OTC", "")

        with self._lock:
            if self._last_write_second.get(currency_code) == now:
                return False
            self._last_write_second[currency_code] = now

        display = asset_to_display_currency(asset)
        line = f"Currency: {display}, {price_f} {now.strftime('%Y-%m-%d %H:%M:%S')}"
        path = ONE_SEC_DIR / f"{file_stem}.txt"
        with path.open("a", encoding="utf-8", buffering=1) as f:
            f.write(line + "\n")

        with self._lock:
            self._latest[currency_code] = {
                "name": display.replace(" OTC", ""),
                "price": price_f,
                "time": now.strftime("%Y-%m-%d %H:%M:%S"),
                "file": f"{file_stem}.txt",
            }
            self._tick_counts[currency_code] = self._tick_counts.get(currency_code, 0) + 1
            self._last_ok = sum(1 for t in self._latest.values() if t)
        return True

    def _write_candle(self, asset: str, candle: dict) -> bool:
        close = candle.get("close") if isinstance(candle, dict) else None
        if close is None:
            return False
        return self._write_tick(asset, close)

    def trim_files(self) -> None:
        if not ONE_SEC_DIR.exists():
            return
        for path in ONE_SEC_DIR.glob("*_OTC.txt"):
            try:
                lines = path.read_text(encoding="utf-8", errors="ignore").splitlines(True)
                if len(lines) <= MAX_LINES_1S:
                    continue
                path.write_text("".join(lines[-MAX_LINES_1S:]), encoding="utf-8")
            except Exception:
                pass

    def print_status(self) -> None:
        try:
            os.system("cls" if os.name == "nt" else "clear")
        except Exception:
            pass
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        uptime = int(time.time() - self._started_at) if self._started_at else 0
        with self._lock:
            items = sorted(self._latest.items(), key=lambda x: x[1]["file"])
            snapshot = [(code, dict(data), self._prev_price.get(code)) for code, data in items]
            for code, data, _ in snapshot:
                self._prev_price[code] = data["price"]
            alive = len(self._live_assets)
            errs = self._stream_errors

        # Age of freshest / stalest updates
        ages = []
        for _code, data, _prev in snapshot:
            try:
                ages.append(
                    (datetime.now() - datetime.strptime(data["time"], "%Y-%m-%d %H:%M:%S")).total_seconds()
                )
            except Exception:
                pass
        age_txt = ""
        if ages:
            age_txt = f" | age min/avg/max={min(ages):.0f}/{sum(ages)/len(ages):.1f}/{max(ages):.0f}s"

        print("=" * 100)
        print(
            f"SSID live forex | {now} | mode={self._mode_running} | pairs={len(self._assets)} "
            f"| live={len(snapshot)} | streams={alive} | errs={errs} | up={uptime}s{age_txt}"
        )
        if self._mode_running == "stream":
            print(f"stream clients≈{len(self._stream_threads)} | live_assets={alive} | errs={errs}")
        if self._mode_running == "poll":
            print(
                f"poll workers={self.poll_workers} | last_sweep={self._last_ok} in {self._last_sweep_dt:.2f}s "
                f"| sweeps={self._sweep_n}"
            )
        print("=" * 100)
        for i, (_code, data, prev) in enumerate(snapshot):
            status = "ACTIVE" if prev is None or prev != data["price"] else "FLAT"
            cell = f"{data['file']:<14} {data['name']:<10} {data['price']:<12.5f} {status:<6}"
            end = "\n" if (i + 1) % 3 == 0 else " | "
            print(cell, end=end)
        if snapshot and len(snapshot) % 3 != 0:
            print()
        print("=" * 100)

    def _maintenance_tick(self) -> None:
        now = time.time()
        if now - self._last_trim >= TRIM_EVERY_SEC:
            self.trim_files()
            self._last_trim = now
        if now - self._last_status >= STATUS_EVERY_SEC:
            self.print_status()
            self._last_status = now

    # --- stream mode (true ~1s) -----------------------------------------------

    def _close_stream_apis(self) -> None:
        for api in self._stream_apis:
            try:
                api.__exit__(None, None, None)
            except Exception:
                pass
        self._stream_apis = []

    def _start_stream_farm(self) -> None:
        assets = list(self._assets)
        if not assets:
            return
        chunks = [
            assets[i : i + STREAMS_PER_CLIENT]
            for i in range(0, len(assets), STREAMS_PER_CLIENT)
        ]
        if len(chunks) > MAX_STREAM_CLIENTS:
            covered = MAX_STREAM_CLIENTS * STREAMS_PER_CLIENT
            print(
                f"WARNING: capping stream clients at {MAX_STREAM_CLIENTS} "
                f"({covered}/{len(assets)} pairs) to avoid locking PO. "
                f"Rest stay cold — use mitm or raise PO_LIVE_MAX_STREAM_CLIENTS carefully."
            )
            chunks = chunks[:MAX_STREAM_CLIENTS]
        print(
            f"Starting stream farm: {len(chunks)} clients × up to {STREAMS_PER_CLIENT} "
            f"pairs (library limit)"
        )
        for idx, chunk in enumerate(chunks):
            if self._stopping:
                break
            t = threading.Thread(
                target=self._client_stream_loop,
                args=(idx, chunk),
                name=f"po-stream-{idx}",
                daemon=True,
            )
            self._stream_threads.append(t)
            t.start()
            time.sleep(CLIENT_STAGGER_SEC)

        # Wait briefly for first streams to come alive
        deadline = time.time() + 25
        while time.time() < deadline and not self._stopping:
            with self._lock:
                alive = len(self._live_assets)
            if alive >= min(4, len(assets)):
                break
            time.sleep(0.25)
        print(f"Stream farm live pairs: {len(self._live_assets)}/{len(assets)}")

    def _client_stream_loop(self, client_idx: int, chunk: list[str]) -> None:
        """One PO connection owning up to STREAMS_PER_CLIENT live 1s subscriptions."""
        while not self._stopping:
            api = None
            threads: list[threading.Thread] = []
            stop_local = threading.Event()
            started_assets: list[str] = []
            try:
                api = self._open_api()
                with self._lock:
                    self._stream_apis.append(api)

                for asset in chunk:
                    if self._stopping:
                        break
                    try:
                        stream = api.subscribe_symbol_timed(asset, timedelta(seconds=1))
                    except Exception as e:
                        print(f"[client {client_idx}] subscribe fail {asset}: {e}", flush=True)
                        with self._lock:
                            self._stream_errors += 1
                        continue
                    th = threading.Thread(
                        target=self._consume_stream,
                        args=(asset, stream, stop_local),
                        name=f"tick-{asset}",
                        daemon=True,
                    )
                    threads.append(th)
                    th.start()
                    started_assets.append(asset)
                    with self._lock:
                        self._live_assets.add(asset)

                while not self._stopping and not stop_local.is_set():
                    alive = sum(1 for th in threads if th.is_alive())
                    if alive == 0:
                        break
                    time.sleep(0.5)
            except Exception as e:
                with self._lock:
                    self._stream_errors += 1
                print(f"[client {client_idx}] stream error: {e}", flush=True)
            finally:
                stop_local.set()
                with self._lock:
                    for asset in started_assets:
                        self._live_assets.discard(asset)
                if api is not None:
                    try:
                        api.__exit__(None, None, None)
                    except Exception:
                        pass
                    with self._lock:
                        if api in self._stream_apis:
                            self._stream_apis.remove(api)
            if self._stopping:
                break
            time.sleep(STREAM_RECONNECT_SEC)

    def _consume_stream(self, asset: str, stream, stop_local: threading.Event) -> None:
        try:
            for candle in stream:
                if self._stopping or stop_local.is_set():
                    break
                if isinstance(candle, dict):
                    self._write_candle(asset, candle)
                elif isinstance(candle, (list, tuple)) and len(candle) >= 2:
                    # rare alternate shapes
                    self._write_tick(asset, candle[-1])
        except Exception as e:
            with self._lock:
                self._stream_errors += 1
            print(f"[stream {asset}] ended: {e}", flush=True)
            stop_local.set()

    # --- poll mode (fallback) -------------------------------------------------

    def _connect_poll_workers(self) -> None:
        self._close_poll_workers()
        apis: list[PocketOption] = []
        try:
            for _ in range(self.poll_workers):
                apis.append(self._open_api())
                time.sleep(CLIENT_STAGGER_SEC)
        except Exception:
            for api in apis:
                try:
                    api.__exit__(None, None, None)
                except Exception:
                    pass
            raise
        self._poll_apis = apis

    def _close_poll_workers(self) -> None:
        for api in self._poll_apis:
            try:
                api.__exit__(None, None, None)
            except Exception:
                pass
        self._poll_apis = []

    def _poll_chunk(self, api: PocketOption, chunk: list[str]) -> list[tuple[str, dict]]:
        out: list[tuple[str, dict]] = []
        for asset in chunk:
            if self._stopping:
                break
            try:
                hist = api.history(asset, 2)
            except Exception:
                continue
            if hist and isinstance(hist[-1], dict):
                out.append((asset, hist[-1]))
        return out

    def sweep_once(self) -> tuple[int, float]:
        if not self._poll_apis:
            self._connect_poll_workers()
        n = len(self._poll_apis) or 1
        chunks = [self._assets[i::n] for i in range(n)]
        t0 = time.time()
        wrote = 0
        with ThreadPoolExecutor(max_workers=n) as pool:
            futs = [
                pool.submit(self._poll_chunk, self._poll_apis[i], chunks[i])
                for i in range(n)
                if chunks[i]
            ]
            for fut in as_completed(futs):
                try:
                    rows = fut.result()
                except Exception:
                    continue
                for asset, candle in rows:
                    if self._write_candle(asset, candle):
                        wrote += 1
        return wrote, time.time() - t0

    # --- main loops -----------------------------------------------------------

    def run_forever(self) -> None:
        self.start()
        try:
            if self._mode_running == "stream":
                while not self._stopping:
                    self._maintenance_tick()
                    time.sleep(0.5)
            else:
                while not self._stopping:
                    try:
                        wrote, dt = self.sweep_once()
                        self._sweep_n += 1
                        self._last_ok = wrote
                        self._last_sweep_dt = dt
                    except Exception as e:
                        print(f"Reconnecting after poll error: {e}")
                        time.sleep(3)
                        try:
                            self._connect_poll_workers()
                        except Exception as e2:
                            print(f"Reconnect failed: {e2}")
                            time.sleep(5)
                        continue
                    self._maintenance_tick()
                    time.sleep(0.05)
        except KeyboardInterrupt:
            print("\nStopping…")
        finally:
            self.stop()

    def run_once_demo(self, seconds: float = 8.0) -> None:
        """Stream for a few seconds (or one poll sweep) then print status."""
        self.start()
        try:
            if self._mode_running == "stream":
                time.sleep(max(2.0, seconds))
            else:
                wrote, dt = self.sweep_once()
                self._sweep_n = 1
                self._last_ok = wrote
                self._last_sweep_dt = dt
                print(f"Wrote {wrote} ticks in {dt:.2f}s")
            self.print_status()
        finally:
            self.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description="Live OTC forex prices via SSID → 1s candle files")
    parser.add_argument("--real", action="store_true", help="Use real SSID (default: demo)")
    parser.add_argument(
        "--mode",
        choices=("stream", "poll", "auto"),
        default=os.environ.get("PO_LIVE_MODE", "poll"),
        help="poll=1-conn history (safe default), stream=WS ticks (capped clients), auto=stream then poll",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=POLL_WORKERS,
        help=f"Poll-mode parallel clients (default: {POLL_WORKERS})",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run briefly then exit (stream ~8s, poll one sweep)",
    )
    parser.add_argument(
        "--once-seconds",
        type=float,
        default=8.0,
        help="Seconds to run in --once stream mode (default: 8)",
    )
    args = parser.parse_args()

    collector = LiveForexCollector(
        demo=not args.real,
        mode=args.mode,
        poll_workers=args.workers,
    )
    if args.once:
        collector.run_once_demo(seconds=args.once_seconds)
        return
    collector.run_forever()


if __name__ == "__main__":
    main()
