#!/usr/bin/env python3
"""Station SCADA bridge (STUB) -- a MeshCore companion on a Pi's USB -> the Station SCADA JSON events -> WebSocket.

Kelly Page > LoRa Mesh > Station SCADA > Data source "Bridge WebSocket" connects to this. It sends the event schema in
kelly-page/js/stationscada-core.js (one JSON object per text frame):
    {"v":1,"type":"rf","t":ms,"dev":"cmp","dir":"rx","id":"b12","peer":null,"pkt":{"type":"ADVERT","route":"flood",
     "hops":1,"path":["a3f0"],"len":120,"snr":7.5,"rssi":-98,"crc":"ok","hex":"11..."}}
    {"v":1,"type":"telemetry","t":ms,"dev":"cmp"|"rpt"|"host","data":{...}}
    {"v":1,"type":"neighbour","t":ms,"n":{"id":"...","name":"...","snr":...,"hops":0,"lat":..,"lon":..,"lastHeard":ms}}
    {"v":1,"type":"link","t":ms,"serial":"up"|"down","note":"..."}     {"v":1,"type":"log","t":ms,"level":"info","text":"..."}

WHEN TO USE IT: only on a Pi that does NOT run the Kelly bridge. Kelly's own mesh link (Data source "Kelly's mesh
link") already taps the companion through the Kelly bridge, and two programs can't hold one serial port. Where
the Kelly bridge holds the node (e.g. /dev/ttyACM0), you want "Kelly's mesh link", not this.

Setup (Raspberry Pi OS):
    python3 -m venv ~/scada && ~/scada/bin/pip install meshcore websockets
    ~/scada/bin/python station_scada_bridge.py --serial /dev/ttyACM0 --port 8765 \\
        [--repeater "VK4XXX Rpt" --repeater-pass-env RPT_PASS --repeater-every 900] [--token SECRET]
    then in Kelly: Station SCADA > Data source "Bridge WebSocket" > ws://<pi>:8765/scada[?token=SECRET]
    nRF52 boards (RAK4631, SenseCAP P1): never open them at 1200 baud (that's the bootloader-reset rate).

STUB STATUS: written against meshcore (meshcore_py) 2.x -- EventType names and payload keys differ between versions,
so every payload is read with .get() and both spellings where they changed. Run it with --debug the first time and
check what your version sends. Repeater status costs ~1-2 s of airtime a time: keep --repeater-every at 15 min (MBUG:
keep floods low). Not deployed anywhere.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import socket
import time
from pathlib import Path

try:
    from meshcore import EventType, MeshCore
except ImportError:  # pragma: no cover -- the stub says what's missing instead of a traceback
    raise SystemExit("needs the meshcore library: pip install meshcore websockets")
try:
    import websockets
except ImportError:  # pragma: no cover
    raise SystemExit("needs websockets: pip install websockets")

TYPES = {0: "REQ", 1: "RESPONSE", 2: "TXT", 3: "ACK", 4: "ADVERT", 5: "GRP_TXT", 6: "GRP_DATA", 7: "ANON_REQ", 8: "PATH", 9: "TRACE", 10: "MULTIPART", 11: "CONTROL", 15: "RAW"}
CLIENTS: set = set()
SEQ = [0]
_CPU = [0, 0]


def now_ms() -> int:
    return int(time.time() * 1000)


def ev(**kw) -> dict:
    return {"v": 1, "t": now_ms(), **kw}


async def send(e: dict) -> None:
    msg = json.dumps(e, separators=(",", ":"))
    for ws in list(CLIENTS):
        try:
            await ws.send(msg)
        except Exception:  # a client that went away
            CLIENTS.discard(ws)


def decode_raw(b: bytes) -> dict | None:
    """MeshCore wire packet -> type / route / path (as js/meshcore.js decodeRaw and stationscada-core.js decodePacket)."""
    if len(b) < 2:
        return None
    hdr = b[0]
    route, ptype, o = hdr & 3, (hdr >> 2) & 15, 1
    if route in (0, 3):
        o += 4  # transport codes
    if o >= len(b):
        return None
    pl = b[o]
    o += 1
    sz, n = (pl >> 6) + 1, pl & 63
    path = [b[o + i * sz:o + (i + 1) * sz].hex() for i in range(n) if o + (i + 1) * sz <= len(b)]
    return {"type": TYPES.get(ptype, f"TYPE {ptype}"), "route": "flood" if route <= 1 else "direct", "hops": len(path), "path": path, "len": len(b), "crc": "ok", "hex": b.hex()}


def host_stats() -> dict:
    """The Pi itself (as the Kelly bridge's GET /api/host)."""
    out: dict = {"hostName": socket.gethostname()}
    try:
        v = [int(x) for x in Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
        idle, total = v[3] + v[4], sum(v)
        if _CPU[1] and total > _CPU[1]:
            out["cpuPct"] = round(100 * (1 - (idle - _CPU[0]) / (total - _CPU[1])), 1)
        _CPU[:] = [idle, total]
        out["cpuTempC"] = int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000
        mem = {ln.split(":")[0]: int(ln.split()[1]) for ln in Path("/proc/meminfo").read_text().splitlines() if ln.split()[1:2]}
        out["memPct"] = round(100 * (mem["MemTotal"] - mem["MemAvailable"]) / mem["MemTotal"], 1)
        out["uptimeS"] = int(float(Path("/proc/uptime").read_text().split()[0]))
    except (OSError, ValueError, KeyError, IndexError):
        pass
    du = shutil.disk_usage("/")
    out["diskPct"] = round(100 * du.used / du.total, 1)
    return out


class Bridge:
    def __init__(self, args):
        self.a = args
        self.mc = None
        self.msgs: list[float] = []
        self.rpt = None

    async def connect(self) -> None:
        while True:
            try:
                self.mc = await MeshCore.create_serial(self.a.serial, 115200, debug=self.a.debug)
                break
            except Exception as e:  # node unplugged / port busy (the Kelly bridge has it?)
                await send(ev(type="link", serial="down", note=f"{self.a.serial}: {e}"))
                await asyncio.sleep(10)
        mc = self.mc
        await send(ev(type="link", serial="up", note=self.a.serial))
        mc.subscribe(EventType.RX_LOG_DATA, self.on_rx)
        for name in ("CONTACT_MSG_RECV", "CHANNEL_MSG_RECV"):
            if hasattr(EventType, name):
                mc.subscribe(getattr(EventType, name), self.on_msg)
        if hasattr(EventType, "ADVERTISEMENT"):
            mc.subscribe(EventType.ADVERTISEMENT, self.on_advert)
        if hasattr(EventType, "DISCONNECTED"):
            mc.subscribe(EventType.DISCONNECTED, lambda e: asyncio.ensure_future(send(ev(type="link", serial="down", note="node disconnected"))))
        await mc.ensure_contacts()
        await mc.start_auto_message_fetching()
        await self.self_info()

    async def on_rx(self, event) -> None:
        p = event.payload or {}
        raw = p.get("payload") or p.get("raw_hex") or ""
        try:
            pkt = decode_raw(bytes.fromhex(raw)) if isinstance(raw, str) else decode_raw(bytes(raw))
        except ValueError:
            pkt = None
        if not pkt:
            return
        pkt.update(snr=p.get("snr"), rssi=p.get("rssi"))
        SEQ[0] += 1
        rid = f"b{SEQ[0]}"
        # through our own repeater? (the last hop's hash = the start of its public key)
        mine = self.rpt and pkt["path"] and self.rpt.get("public_key", "").startswith(pkt["path"][-1])
        if mine:
            await send(ev(type="rf", dev="rpt", dir="tx", id=rid, fwd=True, pkt=pkt))
        await send(ev(type="rf", dev="cmp", dir="rx", id=rid, peer="rpt" if mine else None, pkt=pkt))
        await send(ev(type="usb", dir="to_host", bytes=len(raw) // 2 + 3, frame="LOG_RX_DATA"))

    async def on_msg(self, event) -> None:
        self.msgs.append(time.time())
        await send(ev(type="usb", dir="to_host", bytes=20 + len((event.payload or {}).get("text", "")), frame="MSG"))

    async def on_advert(self, event) -> None:
        key = (event.payload or {}).get("public_key", "")
        c = self.mc.get_contact_by_key_prefix(key[:12]) if key and hasattr(self.mc, "get_contact_by_key_prefix") else None
        if c:
            await send(ev(type="neighbour", n={"id": key[:12], "name": c.get("adv_name"), "hash": key[:4], "role": "repeater" if c.get("type") == 2 else "companion",
                                                "hops": c.get("out_path_len"), "lat": c.get("adv_lat"), "lon": c.get("adv_lon"), "lastHeard": now_ms()}))

    async def self_info(self) -> None:
        si = getattr(self.mc, "self_info", None) or {}
        data = {"name": si.get("name"), "role": "Companion", "freqMHz": si.get("radio_freq"), "bwKHz": si.get("radio_bw"), "sf": si.get("radio_sf"), "cr": si.get("radio_cr"), "txDbm": si.get("tx_power")}
        try:
            bat = await self.mc.commands.get_bat()
            mv = (bat.payload or {}).get("level")
            if mv:
                data["battV"] = mv / 1000
        except Exception:
            pass
        await send(ev(type="telemetry", dev="cmp", data={k: v for k, v in data.items() if v is not None}))

    async def repeater(self) -> None:
        """Log in to your repeater and ask its status every --repeater-every s (airtime! keep it rare)."""
        if not self.a.repeater:
            return
        pw = os.environ.get(self.a.repeater_pass_env, "")
        while True:
            try:
                self.rpt = self.mc.get_contact_by_name(self.a.repeater)
                if self.rpt:
                    await self.mc.commands.send_login(self.rpt, pw)
                    await asyncio.sleep(3)
                    res = await self.mc.commands.send_statusreq(self.rpt)
                    if res.type == EventType.ERROR:
                        raise RuntimeError(res.payload)
                    st = await self.mc.wait_for_event(EventType.STATUS_RESPONSE, timeout=20)
                    s = (st.payload if st else {}) or {}
                    up = s.get("uptime") or 0
                    await send(ev(type="telemetry", dev="rpt", data={k: v for k, v in {
                        "name": self.a.repeater, "battV": (s.get("bat") or 0) / 1000 or None, "noise": s.get("noise_floor"), "rssi": s.get("last_rssi"), "snr": s.get("last_snr"),
                        "rx": s.get("nb_recv"), "tx": s.get("nb_sent"), "fwd": (s.get("sent_flood") or 0) + (s.get("sent_direct") or 0) or None, "uptimeS": up,
                        "dutyPct": 100 * (s.get("airtime") or 0) / up if up else None}.items() if v is not None}))
                else:
                    await send(ev(type="log", level="warn", text=f"repeater {self.a.repeater!r} is not in the node's contacts"))
            except Exception as e:
                await send(ev(type="log", level="warn", text=f"repeater status: {e}"))
            await asyncio.sleep(max(300, self.a.repeater_every))

    async def heartbeat(self) -> None:
        while True:
            self.msgs = [t for t in self.msgs if time.time() - t < 3600]
            h = host_stats()
            h.update(serial="up" if self.mc else "down", msgsPerHour=len(self.msgs))
            await send(ev(type="telemetry", dev="host", data=h))
            await asyncio.sleep(10)


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--serial", default="/dev/ttyACM0")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--token", default=os.environ.get("SCADA_TOKEN", ""), help="clients must add ?token=... (recommended off the LAN)")
    ap.add_argument("--repeater", default="", help="your repeater's name, to read its status over the air")
    ap.add_argument("--repeater-pass-env", default="RPT_PASS", help="env var holding its admin password (never on the command line)")
    ap.add_argument("--repeater-every", type=int, default=900)
    ap.add_argument("--debug", action="store_true")
    a = ap.parse_args()
    br = Bridge(a)

    async def handler(ws, path=None):
        req = getattr(ws, "request", None)
        p = path or (req.path if req else "/")
        if a.token and f"token={a.token}" not in p:
            await ws.close(code=4403, reason="token")
            return
        CLIENTS.add(ws)
        await ws.send(json.dumps(ev(type="link", serial="up" if br.mc else "down", note=a.serial)))
        try:
            async for _ in ws:  # nothing comes this way yet
                pass
        finally:
            CLIENTS.discard(ws)

    async with websockets.serve(handler, a.host, a.port):
        print(f"[scada] ws://{a.host}:{a.port}/scada  node {a.serial}", flush=True)
        await br.connect()
        await asyncio.gather(br.heartbeat(), br.repeater())


if __name__ == "__main__":
    asyncio.run(main())
