#!/usr/bin/env python3
"""
Build higher-timeframe OHLC candles (with wicks/shadows) from 5-second history.

Reads pipe-format files from fetch_currency_history.py and writes one file per timeframe.
"""

from __future__ import annotations

import argparse
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from po_ssid import OUTPUT_DIR

# pandas offset -> output filename suffix
TIMEFRAMES: dict[str, str] = {
    "15s": "15s",
    "30s": "30s",
    "1m": "1min",
    "3m": "3min",
    "5m": "5min",
    "10m": "10min",
    "15m": "15min",
    "30m": "30min",
    "1h": "1h",
    "1d": "1D",
}

DEFAULT_LABELS = list(TIMEFRAMES.keys())


def infer_asset_stem(input_path: Path) -> str:
    name = input_path.stem
    m = re.match(r"^(?P<asset>.+?)_\d+d_5s_history$", name)
    if m:
        return m.group("asset")
    if name.endswith("_5s_history"):
        return name[: -len("_5s_history")]
    return name


def load_5s_history(path: Path) -> pd.DataFrame:
    print(f"Loading 5s history: {path}")
    t0 = time.time()
    df = pd.read_csv(
        path,
        sep=r"\s*\|\s*",
        engine="python",
        skiprows=2,
        names=["ts", "datetime", "open", "high", "low", "close"],
        dtype={
            "ts": "int64",
            "open": "float64",
            "high": "float64",
            "low": "float64",
            "close": "float64",
        },
    )
    df = df.dropna(subset=["close"])
    df = df.sort_values("ts").drop_duplicates("ts", keep="last")
    df["dt"] = pd.to_datetime(df["ts"], unit="s", utc=True)
    df = df.set_index("dt")
    elapsed = time.time() - t0
    print(f"Loaded {len(df):,} x 5s candles in {elapsed:.1f}s")
    if df.empty:
        raise ValueError("No 5s candles found in input file")
    print(
        f"Range: {df.index.min()} -> {df.index.max()} "
        f"({(df.index.max() - df.index.min()).days} days)"
    )
    return df


def resample_ohlc(df: pd.DataFrame, pandas_rule: str) -> pd.DataFrame:
    """OHLC aggregation: open=first, high=max, low=min, close=last (full wicks)."""
    out = df.resample(pandas_rule, label="left", closed="left").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
        }
    )
    return out.dropna(subset=["close"])


def write_history(path: Path, resampled: pd.DataFrame) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = resampled.reset_index()
    rows["ts"] = (rows["dt"].astype("int64") // 10**9).astype(int)
    rows["datetime"] = rows["dt"].dt.strftime("%Y-%m-%d %H:%M:%S")

    with path.open("w", encoding="utf-8") as f:
        f.write("ts | datetime | open | high | low | close\n")
        f.write("-" * 90 + "\n")
        for _, r in rows.iterrows():
            f.write(
                f"{int(r['ts'])} | {r['datetime']} | "
                f"{r['open']:.5f} | {r['high']:.5f} | {r['low']:.5f} | {r['close']:.5f}\n"
            )
    return len(rows)


def index_to_unix(index: pd.DatetimeIndex) -> pd.Series:
    values = index.astype("int64")
    # Newer pandas uses datetime64[s] where int64 is already unix seconds.
    if len(values) == 0 or values.max() < 10_000_000_000:
        return values
    return values // 10**9


def write_history_fast(path: Path, resampled: pd.DataFrame) -> int:
    """Vectorized write for large outputs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    ts = index_to_unix(resampled.index)
    dt = resampled.index.strftime("%Y-%m-%d %H:%M:%S")
    body = (
        ts.astype(str)
        + " | "
        + dt
        + " | "
        + resampled["open"].map(lambda x: f"{x:.5f}")
        + " | "
        + resampled["high"].map(lambda x: f"{x:.5f}")
        + " | "
        + resampled["low"].map(lambda x: f"{x:.5f}")
        + " | "
        + resampled["close"].map(lambda x: f"{x:.5f}")
    )
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write("ts | datetime | open | high | low | close\n")
        f.write("-" * 90 + "\n")
        f.write("\n".join(body.tolist()))
        f.write("\n")
    return len(resampled)


def run(
    input_path: Path,
    output_dir: Path,
    labels: list[str],
    asset_stem: str | None,
) -> None:
    df = load_5s_history(input_path)
    stem = asset_stem or infer_asset_stem(input_path)
    out_root = output_dir / stem
    out_root.mkdir(parents=True, exist_ok=True)

    print(f"\nBuilding candles for: {stem}")
    print(f"Output folder: {out_root}\n")

    summary: list[tuple[str, int, Path]] = []
    for label in labels:
        if label not in TIMEFRAMES:
            print(f"Skipping unknown timeframe: {label}")
            continue
        rule = TIMEFRAMES[label]
        t0 = time.time()
        print(f"  {label:>4} ...", end="", flush=True)
        resampled = resample_ohlc(df, rule)
        out_path = out_root / f"{stem}_{label}_history.txt"
        count = write_history_fast(out_path, resampled)
        elapsed = time.time() - t0
        print(f" {count:,} candles -> {out_path.name} ({elapsed:.1f}s)")
        summary.append((label, count, out_path))

    print("\n" + "=" * 70)
    print("DONE - resampled OHLC candles (open/high/low/close with wicks)")
    for label, count, out_path in summary:
        print(f"  {label:>4}: {count:>8,} candles  {out_path}")
    print("=" * 70)
    print("\nUse any of these with BackTesting PO/pocket_option_strategy_finder.py --history <file>")


def find_latest_5s(output_dir: Path) -> Path | None:
    candidates = sorted(output_dir.glob("*_5s_history.txt"), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Resample 5s PO history into 30s, 1m, 5m, 10m, 15m, 30m, 1h, 1d OHLC candles"
    )
    parser.add_argument(
        "--input",
        type=Path,
        help="5s history file (default: newest in output/)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=OUTPUT_DIR,
        help="Base output directory (default: D:\\APP SAVE\\output)",
    )
    parser.add_argument(
        "--asset",
        help="Override asset stem used in output folder/file names",
    )
    parser.add_argument(
        "--timeframes",
        default=",".join(DEFAULT_LABELS),
        help=f"Comma-separated list from: {','.join(DEFAULT_LABELS)}",
    )
    args = parser.parse_args()

    input_path = args.input or find_latest_5s(args.output_dir)
    if not input_path or not input_path.exists():
        raise SystemExit(
            "No 5s history file found. Run fetch_currency_history.py first, or pass --input."
        )

    labels = [x.strip() for x in args.timeframes.split(",") if x.strip()]
    run(input_path, args.output_dir, labels, args.asset)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
