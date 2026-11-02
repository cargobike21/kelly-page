#!/usr/bin/env python3
"""Kelly BLE scanner node -- a Pi (or Pi Zero 2 W) somewhere else, scanning for one Kelly Page bridge.

  python3 kelly_ble_node.py --server HOST:8025 --node shed [--adapter hci0] [--db ~/.kelly-ble-node.db]
  token: KELLY_BLE_NODE_TOKEN in the environment (/etc/kelly-ble-node.env), from the bridge's
         kelly_bridge.py --ble-add-node shed --ble-zone "Shed"   (or the BLE page > Nodes > Add)

It scans, keeps what it hears in a small SQLite queue on disk, and sends it in order with the original
timestamps -- so a link that drops (4G, a Wi-Fi hop, a radio IP link) loses nothing; the backlog goes up when it's
back, and the bridge acks each batch before it's deleted here. A heartbeat every 15 s carries the backlog size,
this Pi's clock and its health (adapter, temperature, throttling, NTP), so the BLE page can tell "nobody's there"
from "the node's link is down" and won't call a departure on a node that's behind.

What it sends: only the registered devices' adverts (the bridge passes the page's list down, kept on disk here for a
cold start with no link), or everything for a few minutes when the page asks for discovery (to register a new
beacon). Passers-by's phones never leave the Pi otherwise.

Security: the bridge accepts a node only with its registered token (it keeps a hash). Over the internet, run the link
inside Tailscale (or a VPN) -- the tailnet already encrypts it -- or use wss:// through a TLS proxy (--cafile for a
private CA). The node takes no commands beyond the filter and discovery switch: nothing it receives can make it send
anything over the air.

Needs bleak (sudo apt install python3-bleak). --adapter sim needs nothing (testing).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kelly_ble as K  # noqa: E402

VERSION = "1.0"


class Store:
    """The send queue on disk: rows (seq, json), oldest first; capped (the oldest go first)."""

    def __init__(self, path: str, max_rows: int):
        self.path, self.max = Path(path).expanduser(), max_rows
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path))
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS q (seq INTEGER PRIMARY KEY AUTOINCREMENT, j TEXT NOT NULL)")
        self.db.commit()
        self.dropped = 0

    def add(self, recs: list):
        if not recs:
            return
        self.db.executemany("INSERT INTO q (j) VALUES (?)", [(json.dumps(r, separators=(",", ":")),) for r in recs])
        n = self.count()
        if n > self.max:
            cut = n - self.max
            self.db.execute("DELETE FROM q WHERE seq IN (SELECT seq FROM q ORDER BY seq LIMIT ?)", (cut,))
            self.dropped += cut
        self.db.commit()

    def take(self, n: int):
        rows = self.db.execute("SELECT seq, j FROM q ORDER BY seq LIMIT ?", (n,)).fetchall()
        return (rows[-1][0], [json.loads(j) for _, j in rows]) if rows else (0, [])

    def ack(self, seq: int):
        self.db.execute("DELETE FROM q WHERE seq <= ?", (seq,))
        self.db.commit()

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM q").fetchone()[0]


class Node:
    def __init__(self, args):
        self.args = args
        self.store = Store(args.db, args.max_rows)
        self.mem: list = []
        self.dedup = K.Dedup(args.dedup)
        self.filter_file = Path(args.db).expanduser().with_suffix(".filter.json")
        try:
            self.keys = set(json.loads(self.filter_file.read_text()))
        except (OSError, ValueError):
            self.keys = set()
        self.discover_until = 0.0
        self.sources = []
        self.link = None
        self.acked = asyncio.Event()
        self.waiting = 0
        self.clock_warned = False

    def log(self, s: str):
        print(f"[node] {s}", flush=True)

    def wants(self, r: dict) -> bool:
        if self.args.all or time.time() < self.discover_until:
            return True
        return any(k in self.keys for k in K.id_keys(r))

    def on_record(self, r: dict):
        if self.wants(r) and self.dedup.want(r):
            self.mem.append(r)

    async def flush_loop(self):
        while True:
            await asyncio.sleep(1)
            if self.mem:
                batch, self.mem = self.mem, []
                self.store.add(batch)

    async def run(self):
        for a in self.args.adapter.split(","):
            a = a.strip()
            src = K.SimSource(self.on_record, node=self.args.node, zone="", adapter="sim") if a == "sim" else \
                K.Scanner(a, self.on_record, node=self.args.node, zone="", mode=self.args.mode)
            self.sources.append((a, src))
            asyncio.ensure_future(src.run())
        asyncio.ensure_future(self.flush_loop())
        backoff = 5
        while True:
            try:
                await self.session()
                backoff = 5
            except (OSError, ConnectionError, asyncio.TimeoutError, asyncio.IncompleteReadError) as e:
                self.log(f"link: {e or type(e).__name__}; {self.store.count()} queued; retrying in {backoff} s")
            if self.link:
                self.link.close()
                self.link = None
            await asyncio.sleep(backoff)
            backoff = min(60, backoff * 2)

    def url(self) -> str:
        s = self.args.server.strip()
        if "://" not in s:
            s = "ws://" + s
        base = s.split("?")[0].rstrip("/")
        if not base.endswith("/ble-node"):
            base = base.rsplit("/ble", 1)[0].rsplit("/ws", 1)[0] + "/ble-node"
        from urllib.parse import quote
        return f"{base}?node={quote(self.args.node)}&token={quote(self.args.token)}"

    async def session(self):
        self.link = await K.WsClient.connect(self.url(), cafile=self.args.cafile)
        self.log(f"attached to {self.args.server} as {self.args.node}")
        await self.link.send({"t": "hello", "ver": VERSION, "adapter": self.args.adapter[:16], "now": K.now_ms()})
        reader = asyncio.ensure_future(self.read_loop())
        try:
            last_hb = 0.0
            while not reader.done():
                if time.time() - last_hb > 15:
                    last_hb = time.time()
                    await self.link.send({"t": "hb", "now": K.now_ms(), "buffered": self.store.count(), "health": await self.health()})
                seq, recs = self.store.take(500)
                if recs:
                    self.acked.clear()
                    self.waiting = seq
                    await self.link.send({"t": "advs", "seq": seq, "list": recs})
                    try:
                        await asyncio.wait_for(self.acked.wait(), 20)
                    except asyncio.TimeoutError:
                        raise ConnectionError("no ack in 20 s")
                    self.store.ack(seq)
                    if self.store.count():   # backlog: keep going, a little gently
                        await asyncio.sleep(0.2)
                        continue
                await asyncio.sleep(1)
            exc = reader.exception()
            if exc:
                raise exc
        finally:
            reader.cancel()

    async def read_loop(self):
        while True:
            m = await self.link.recv()
            if m is None:
                raise ConnectionError("the bridge closed the link")
            t = m.get("t")
            if t == "ack" and m.get("seq") == self.waiting:
                self.acked.set()
            elif t == "welcome":
                drift = K.now_ms() - int(m.get("now") or K.now_ms())
                if abs(drift) > 5000:
                    self.log(f"WARNING: this Pi's clock is {drift / 1000:+.1f} s off the bridge's -- fix NTP (timedatectl), or use GPS time "
                             "if there's no internet. The bridge corrects the timestamps meanwhile.")
            elif t == "filter" and isinstance(m.get("keys"), list):
                self.keys = set(str(k) for k in m["keys"][:500])
                try:
                    self.filter_file.write_text(json.dumps(sorted(self.keys)))
                except OSError:
                    pass
                self.log(f"forwarding {len(self.keys)} registered device key(s)")
            elif t == "discover":
                mins = max(0, min(30, int(m.get("min") or 0)))
                self.discover_until = time.time() + mins * 60
                self.log(f"discovery {'on for ' + str(mins) + ' min' if mins else 'off'}")

    async def health(self) -> dict:
        loop = asyncio.get_running_loop()
        out = {}
        for a, src in self.sources:
            h = await loop.run_in_executor(None, K.health, a)
            h.update(scanning=src.up, error=src.error, adverts=src.count)
            out = h if not out else out   # the first adapter's view; the rest only matter when one fails
            if not h.get("ok") or not src.up:
                out = h
        ntp = await loop.run_in_executor(None, K._run, ["timedatectl", "show", "-p", "NTPSynchronized", "--value"])
        if ntp:
            out["ntp"] = ntp == "yes"
            if ntp != "yes":
                out.setdefault("fix", []).append("The clock isn't NTP-synchronised: sudo timedatectl set-ntp true (or a GPS time source if there's no internet)")
        out["dropped"] = self.store.dropped
        return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True, help="the Kelly bridge: host:8025, ws://host:8025, or wss://... behind a TLS proxy")
    ap.add_argument("--node", required=True, help="this node's id, as registered on the bridge")
    ap.add_argument("--token", default=os.environ.get("KELLY_BLE_NODE_TOKEN", ""), help="(better: KELLY_BLE_NODE_TOKEN in the environment)")
    ap.add_argument("--adapter", default="hci0", help="hci0, hci0,hci1, or sim")
    ap.add_argument("--mode", choices=("active", "passive"), default="active")
    ap.add_argument("--dedup", type=float, default=2.0, metavar="SEC", help="an unchanged advert at most every SEC s per device (default 2)")
    ap.add_argument("--db", default="~/.kelly-ble-node.db", help="the store-and-forward queue")
    ap.add_argument("--max-rows", type=int, default=200000, help="queue cap; the oldest go first (default 200000, ~40 MB)")
    ap.add_argument("--all", action="store_true", help="send every advert, not just registered devices (busy -- and other people's devices)")
    ap.add_argument("--cafile", default="", help="wss:// with a private CA: its certificate")
    args = ap.parse_args()
    if not args.token:
        sys.exit("No token: set KELLY_BLE_NODE_TOKEN (the bridge prints one with --ble-add-node)")
    async def go():   # made inside the loop (Python 3.8/3.9 tie an Event to the loop that exists when it's made)
        await Node(args).run()
    try:
        asyncio.run(go())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
