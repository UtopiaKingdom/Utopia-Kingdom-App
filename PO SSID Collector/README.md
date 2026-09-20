# PO SSID Collector

Pocket Option tools that connect via **SSID** (session token) using `BinaryOptionsToolsV2`.

Everything for fetching history, balances, payouts, and candle repair lives here.

## Setup

```bash
pip install -r requirements.txt
```

Put your SSID in `ssid/pocketoption_ssid.txt`, or set env `POCKETOPTION_SSID` / `PO_SSID`.

Get SSID from browser DevTools → Network → WS frames on pocketoption.com (the `42["auth",...]` message).

## Scripts

| Script | What it does |
|--------|----------------|
| `fetch_currency_history.py` | Download candle history for one pair (e.g. EURUSD_otc) |
| `resample_candles.py` | Build 30s/1m/5m/10m/15m/30m/1h/1d OHLC from 5s history |
| `fetch_balance.py` | Check demo/real balance |
| `scan_assets_and_balance.py` | Live list of all assets + balances |
| `scan_payouts.py` | Sync **all** OTC pairs + payouts from SSID → `currencies_payouts.txt` + `currencies_from_po.txt` |
| `live_forex_prices.py` | Live OTC **forex** via SSID → `BotsHub/Prices/candles/1s/` (mitm replacement). Default `--mode stream` = true ~1s WebSocket ticks (4 streams × N clients). `--mode poll` = slower history sweeps. |
| `repair_candles.py` | Fetch 5s via SSID, build 15s/30s/1m/3m/5m into BotsHub candle files (all SSID meta pairs) |

Run `scan_payouts.py --once` first so repair sees the full currency list (~111 OTC pairs).

```bash
python scan_payouts.py --once
python repair_candles.py
```

## Examples

```bash
cd "PO SSID Collector"

# 1 year of 5-second EUR/USD OTC history
python fetch_currency_history.py --asset EURUSD_otc --timeframe 5 --days 365

# Build all higher timeframes (30s, 1m, 5m, 10m, 15m, 30m, 1h, 1d) with OHLC wicks
python resample_candles.py --input output/AEDCNY_otc_365d_5s_history.txt

# Only specific timeframes
python resample_candles.py --input output/AEDCNY_otc_365d_5s_history.txt --timeframes 30s,1m,5m,15m,1h

# Balance (JSON for apps)
python fetch_balance.py --json-only

# Default: 1 week staged (1 day all pairs first, then backfill 6 days)
python repair_candles.py

# Quick 6h single pass
python repair_candles.py --fast

# Full week in one pass per currency (slow to reach all pairs)
python repair_candles.py --no-staged
```

History files are saved to `output/` by default.

## Next step: backtesting

Use resampled files with scripts in `BackTesting PO/`:

```powershell
cd "..\BackTesting PO"
.\run.ps1 pocket_option_strategy_finder.py --history "..\PO SSID Collector\output\AEDCNY_otc\AEDCNY_otc_5m_history.txt"
```

## SSID files

- `ssid/pocketoption_ssid.txt` — main real account
- `ssid/pocketoption_demo_ssid.txt` — demo account
- `ssid/pocketoption_*_bot2.txt` — per-bot SSIDs (used by Utopia Kingdom app)
