#!/usr/bin/env python3
"""Live Pocket Option closed-ticket feed via the same SSID socket.

BinaryOptionsToolsV2 closed_deals() stays empty. The website History tab is
updateClosedDeals / successcloseOrder on demo-api-eu.po.market (binary JSON).
This process keeps that socket open and caches W/L so MG can continue or stop
the instant the user's ticket settles.

Never logs the SSID/session.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Callable, Optional

try:
    import websockets
except ImportError:
    websockets = None  # type: ignore

DEMO_URLS = (
    "wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket",
    "wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket",
    "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket",
)
LIVE_URLS = (
    "wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket",
    "wss://api-spb.po.market/socket.io/?EIO=4&transport=websocket",
    "wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket",
)

_CLOSED_EVENTS = {
    "updateClosedDeals",
    "successcloseOrder",
    "updateClosedExpresses",
}

_feeds: dict[str, "ClosedFeed"] = {}
_feeds_lock = threading.Lock()

OnClosed = Callable[[str, dict, str], None]


def parse_auth(ssid: str) -> dict:
    s = str(ssid or "").strip()
    idx = s.find('42["auth"')
    if idx >= 0:
        s = s[idx:]
    if s.startswith("42"):
        data = json.loads(s[2:])
        if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], dict):
            return data[1]
    if s.startswith("{"):
        return json.loads(s)
    data = json.loads(s)
    if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], dict):
        return data[1]
    if isinstance(data, dict):
        return data
    raise ValueError("unrecognized ssid")


def auth_frame(auth: dict) -> str:
    payload = {
        "session": auth.get("session"),
        "isDemo": auth.get("isDemo"),
        "uid": auth.get("uid"),
        "platform": auth.get("platform", 9),
    }
    for k in ("isFastHistory", "isOptimized"):
        if k in auth:
            payload[k] = auth[k]
    return "42" + json.dumps(["auth", payload], separators=(",", ":"))


def event_name(text: str) -> str:
    s = (text or "").strip()
    if s.startswith("451-"):
        s = s[4:]
    elif s.startswith("42"):
        s = s[2:]
    if s.startswith("["):
        try:
            data = json.loads(s)
            if isinstance(data, list) and data:
                return str(data[0])
        except Exception:
            pass
    return ""


def deals_from_obj(data) -> list[dict]:
    if data is None:
        return []
    rows: list = []
    if isinstance(data, list):
        if data and isinstance(data[0], str):
            return deals_from_obj(data[1] if len(data) > 1 else None)
        rows = data
    elif isinstance(data, dict):
        inner = data.get("deals") or data.get("data") or data.get("items")
        if isinstance(inner, list):
            rows = inner
        elif data.get("id") or data.get("asset") or data.get("amount") is not None:
            rows = [data]
    out: list[dict] = []
    for item in rows:
        if isinstance(item, dict) and (
            item.get("id") or item.get("asset") or item.get("amount") is not None
        ):
            out.append(item)
    return out


def deal_id_of(item: dict) -> str:
    if not isinstance(item, dict):
        return ""
    for key in ("id", "deal_id", "ticket", "openTradeId", "requestId"):
        val = str(item.get(key) or "").strip()
        if val:
            return val
    return ""


def _ids_match(stored: str, needle: str) -> bool:
    a = str(stored or "").strip().lower()
    b = str(needle or "").strip().lower()
    if not a or not b:
        return False
    return a == b or a.startswith(b) or b.startswith(a)


class ClosedFeed:
    def __init__(self, ssid: str, on_closed: Optional[OnClosed] = None):
        self._ssid = ssid
        self._on_closed = on_closed
        self._deals: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._refresh = threading.Event()
        self._ready = threading.Event()
        self._thread = threading.Thread(
            target=self._thread_main, name="po-ssid-closed-feed", daemon=True
        )

    def start(self) -> None:
        if not self._thread.is_alive():
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._refresh.set()

    def kick_refresh(self) -> None:
        self._refresh.set()

    def peek(self, deal_id: str) -> Optional[dict]:
        needle = str(deal_id or "").strip()
        if not needle:
            return None
        with self._lock:
            hit = self._deals.get(needle)
            if hit:
                return dict(hit)
            for key, rec in self._deals.items():
                if _ids_match(key, needle):
                    return dict(rec)
        return None

    def list_closed(self, limit: int = 40) -> list[dict]:
        with self._lock:
            rows = list(self._deals.values())
        rows.sort(key=lambda r: float(r.get("closeTimestamp") or r.get("close_time") or 0), reverse=True)
        if limit > 0:
            rows = rows[:limit]
        return rows

    def ingest(self, items: list[dict], source: str) -> int:
        added = 0
        for item in items:
            deal_id = deal_id_of(item)
            if not deal_id:
                continue
            with self._lock:
                prev = self._deals.get(deal_id)
                self._deals[deal_id] = item
                if len(self._deals) > 250:
                    oldest = sorted(
                        self._deals.items(),
                        key=lambda kv: float(kv[1].get("closeTimestamp") or 0),
                    )[:50]
                    for key, _ in oldest:
                        self._deals.pop(key, None)
            added += 1
            if prev is None or prev.get("profit") != item.get("profit"):
                cb = self._on_closed
                if cb:
                    try:
                        cb(deal_id, item, source)
                    except Exception:
                        pass
        return added

    def _thread_main(self) -> None:
        try:
            asyncio.run(self._run())
        except Exception:
            pass

    async def _run(self) -> None:
        if websockets is None:
            return
        try:
            auth = parse_auth(self._ssid)
        except Exception:
            return
        is_demo = auth.get("isDemo") in (1, True, "1")
        urls = list(DEMO_URLS if is_demo else LIVE_URLS)
        frame = auth_frame(auth)
        backoff = 1.0
        while not self._stop.is_set():
            connected = False
            for url in urls:
                if self._stop.is_set():
                    return
                try:
                    await self._session(url, frame)
                    connected = True
                    backoff = 1.0
                    break
                except Exception:
                    continue
            if self._stop.is_set():
                return
            if not connected:
                self._stop.wait(min(20.0, backoff))
                backoff = min(20.0, backoff * 1.7)

    async def _session(self, url: str, frame: str) -> None:
        async with websockets.connect(
            url,
            origin="https://pocketoption.com",
            extra_headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
            max_size=8 * 1024 * 1024,
            ping_interval=None,
            close_timeout=3,
            open_timeout=12,
        ) as ws:
            hello = await asyncio.wait_for(ws.recv(), timeout=8)
            if isinstance(hello, bytes):
                hello = hello.decode("utf-8", "replace")
            await ws.send("40")
            try:
                await asyncio.wait_for(ws.recv(), timeout=8)
            except asyncio.TimeoutError:
                pass
            await ws.send(frame)
            expecting = None
            last_ps = time.time()
            requested = False
            auth_at = time.time()
            while not self._stop.is_set():
                if not requested and (time.time() - auth_at) >= 0.4:
                    requested = True
                    await ws.send('42["updateClosedDeals"]')
                if self._refresh.is_set():
                    self._refresh.clear()
                    await ws.send('42["updateClosedDeals"]')
                if time.time() - last_ps >= 15:
                    last_ps = time.time()
                    await ws.send('42["ps"]')
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.4)
                except asyncio.TimeoutError:
                    continue
                if isinstance(msg, str):
                    if msg == "2":
                        await ws.send("3")
                        continue
                    name = event_name(msg)
                    if name in _CLOSED_EVENTS:
                        expecting = name
                        try:
                            raw = msg
                            if raw.startswith("451-"):
                                raw = raw[4:]
                            elif raw.startswith("42"):
                                raw = raw[2:]
                            deals = deals_from_obj(json.loads(raw))
                            if deals:
                                self.ingest(deals, name or "ssid_closed")
                                self._ready.set()
                        except Exception:
                            pass
                else:
                    src = expecting
                    expecting = None
                    if src not in _CLOSED_EVENTS:
                        continue
                    try:
                        data = json.loads(msg.decode("utf-8"))
                        deals = deals_from_obj(data)
                        if deals:
                            self.ingest(deals, src)
                            self._ready.set()
                    except Exception:
                        pass


def _feed_key(ssid: str) -> str:
    return str(hash(str(ssid or "").strip()))


def ensure_closed_feed(ssid: str, on_closed: Optional[OnClosed] = None) -> Optional[ClosedFeed]:
    raw = str(ssid or "").strip()
    if not raw or websockets is None:
        return None
    key = _feed_key(raw)
    with _feeds_lock:
        feed = _feeds.get(key)
        if feed is None:
            feed = ClosedFeed(raw, on_closed=on_closed)
            _feeds[key] = feed
            feed.start()
        elif on_closed is not None:
            feed._on_closed = on_closed
        return feed


def stop_closed_feed(ssid: str) -> None:
    key = _feed_key(ssid)
    with _feeds_lock:
        feed = _feeds.pop(key, None)
    if feed is not None:
        feed.stop()


def peek_closed_deal(ssid: str, deal_id: str) -> Optional[dict]:
    key = _feed_key(ssid)
    with _feeds_lock:
        feed = _feeds.get(key)
    if feed is None:
        return None
    return feed.peek(deal_id)


def list_closed_deals(ssid: str, limit: int = 40) -> list[dict]:
    key = _feed_key(ssid)
    with _feeds_lock:
        feed = _feeds.get(key)
    if feed is None:
        return []
    return feed.list_closed(limit=limit)


def kick_closed_refresh(ssid: str) -> None:
    key = _feed_key(ssid)
    with _feeds_lock:
        feed = _feeds.get(key)
    if feed is not None:
        feed.kick_refresh()
