#!/usr/bin/env python3
"""Kelly Page BLE: scanning for the bridge's /ble WebSocket and for remote scanner nodes (kelly_ble_node.py).

The bridge only scans and carries; the page (js/ble.js + js/bleui.js) decodes, tracks presence, runs the rules
and sends the P25 alerts through the radio. One record per advertisement, the same from every source:

  {"n": node, "z": zone, "ad": adapter, "ts": ms (scanner clock), "a": "AA:BB:CC:DD:EE:FF", "at": "public"|"random"|null,
   "r": rssi, "tx": tx power|null, "nm": name|null, "m": {"<company id, decimal>": hex}, "s": {"<uuid>": hex}, "u": [uuids]}

  uuids: SIG 16-bit ones as 4 hex digits ("feaa", "fcd2", "181a"), anything else in full -- = ble.js uuidShort.

Bridge -> page messages (JSON text frames on /ble):
  {"t": "hello", "v": 1, "zone", "adapters": [..], "sim": bool, "nodes": [..]}   on attach
  {"t": "advs", "list": [record, ..]}                                           ~1 s batches, local and remote alike
  {"t": "health", "node", "h": {..}}                                            adapter + Pi health, every 30 s
  {"t": "nodes", "list": [{id, name, zone, up, clock, drift, buffered, ver, adapter, recs, dropped, since, addr}]}
Page -> bridge:
  {"t": "filter", "keys": [..]}      the registered devices' identity keys (ble.js filterKeys); passed on to nodes
  {"t": "discover", "node", "min"}   let a node send everything for a while, to register a new beacon

Remote nodes (/ble-node?node=ID&token=T): registered on the bridge first (kelly_bridge.py --ble-add-node ID --zone Z
prints the token; only its SHA-256 is kept, in --ble-nodes). The node says nothing about its own zone or id -- the
registry decides. Every record is checked and rate-limited, so a bad node can't flood the page (or, through the
page's rules, the air). Node -> bridge: {"t": "hello", "ver", "adapter", "now"}, {"t": "advs", "seq", "list"},
{"t": "hb", "now", "buffered", "health"}; bridge -> node: {"t": "welcome", "now"}, {"t": "ack", "seq"}, filter, discover.

Privacy: nothing here logs or stores an advertisement. The bridge's own adapter forwards everything it hears to the
page (live view only, never stored there either); nodes forward only registered devices unless discovery is on.

Needs bleak (apt install python3-bleak, or pip install bleak) for a real adapter; --ble sim needs nothing.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import os
import random
import re
import secrets
import struct
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs

VERSION = "1"
MAC_RE = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")
HEX_RE = re.compile(r"^[0-9a-f]{0,124}$")          # 62 bytes: the most an AD field (or an extended one we keep) carries
UUID_RE = re.compile(r"^([0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
SIG_BASE = "-0000-1000-8000-00805f9b34fb"


def now_ms() -> int:
    return int(time.time() * 1000)


def uuid_short(u: str) -> str:
    u = str(u).lower()
    if u.startswith("0000") and u.endswith(SIG_BASE) and len(u) == 36:
        return u[4:8]
    return u


def rotates(a: str, at) -> bool:
    """A resolvable / non-resolvable private address (phones, watches): never an identity. = ble.js addrKind."""
    top = int(a[:2], 16) >> 6
    if at == "random":
        return top in (0, 1)
    return at is None and top == 1


def normalise(device, adv, node: str, zone: str, adapter: str) -> dict:
    """bleak (device, AdvertisementData) -> the record above."""
    props = (getattr(device, "details", None) or {}).get("props", {}) if isinstance(getattr(device, "details", None), dict) else {}
    at = props.get("AddressType")
    tx = adv.tx_power if adv.tx_power is not None and -127 <= adv.tx_power <= 20 else None
    return {"n": node, "z": zone, "ad": adapter, "ts": now_ms(), "a": device.address.upper(), "at": at,
            "r": int(adv.rssi), "tx": tx, "nm": (adv.local_name or None),
            "m": {str(k): bytes(v).hex() for k, v in (adv.manufacturer_data or {}).items()},
            "s": {uuid_short(k): bytes(v).hex() for k, v in (adv.service_data or {}).items()},
            "u": [uuid_short(u) for u in (adv.service_uuids or [])][:8]}


def id_keys(r: dict) -> list:
    """The identity keys a record can match -- keep in step with ble.js idKeys / normKey (lower-case except mac)."""
    keys = []
    if r.get("a") and not rotates(r["a"], r.get("at")):
        keys.append("mac:" + r["a"].upper())
    ib = (r.get("m") or {}).get("76", "")
    if len(ib) >= 46 and ib.startswith("0215"):
        u = ib[4:36]
        uuid = f"{u[:8]}-{u[8:12]}-{u[12:16]}-{u[16:20]}-{u[20:]}"
        major, minor = int(ib[36:40], 16), int(ib[40:44], 16)
        keys += [f"ib:{uuid}:{major}:{minor}", f"ib:{uuid}:{major}", f"ib:{uuid}"]
    ed = (r.get("s") or {}).get("feaa", "")
    if len(ed) >= 36 and ed.startswith("00"):
        keys.append(f"ed:{ed[4:24]}:{ed[24:36]}")
    if r.get("nm"):
        keys.append("name:" + str(r["nm"]).strip().lower())
    return keys


def clean(r, node: str, zone: str) -> dict | None:
    """Validate a record from a node; the node's id and zone come from the registry, never from the node."""
    try:
        a = str(r["a"]).upper()
        if not MAC_RE.match(a):
            return None
        ts, rssi = int(r["ts"]), int(r["r"])
        if not -127 <= rssi <= 20 or ts > now_ms() + 300_000 or ts < now_ms() - 7 * 86400_000:
            return None
        m = {str(int(k)): v for k, v in (r.get("m") or {}).items() if isinstance(v, str) and HEX_RE.match(v)}
        s = {str(k).lower(): v for k, v in (r.get("s") or {}).items() if UUID_RE.match(str(k).lower()) and isinstance(v, str) and HEX_RE.match(v)}
        u = [str(x).lower() for x in (r.get("u") or []) if UUID_RE.match(str(x).lower())]
        nm = r.get("nm")
        nm = re.sub(r"[\x00-\x1f\x7f]", "", str(nm))[:32] if nm else None
        tx = r.get("tx")
        tx = int(tx) if isinstance(tx, (int, float)) and -127 <= tx <= 20 else None
        at = r.get("at") if r.get("at") in ("public", "random") else None
        if len(m) > 4 or len(s) > 6:
            return None
        return {"n": node, "z": zone, "ad": str(r.get("ad", ""))[:12], "ts": ts, "a": a, "at": at, "r": rssi, "tx": tx, "nm": nm, "m": m, "s": s, "u": u[:8]}
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


# ---------------------------------------------------------------------------------------------- health
def _run(cmd: list, timeout: float = 4) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


THROTTLE_BITS = {0: "under-voltage now", 1: "ARM frequency capped now", 2: "throttled now", 3: "soft temperature limit now",
                 16: "under-voltage has occurred", 17: "frequency capping has occurred", 18: "throttling has occurred", 19: "soft temperature limit has occurred"}


def health(adapter: str) -> dict:
    """Adapter + host health, with fixes for anything wrong. Linux (BlueZ) checks; elsewhere just 'ok'."""
    h = {"adapter": adapter, "ok": True, "fix": []}
    if adapter == "sim":
        h["note"] = "simulated adapter"
        return h
    if not sys.platform.startswith("linux"):
        h["note"] = f"{sys.platform}: adapter checks are Linux (BlueZ) only"
        return h
    h["present"] = os.path.exists(f"/sys/class/bluetooth/{adapter}")
    h["bluez"] = _run(["systemctl", "is-active", "bluetooth"]) or "unknown"
    soft = hard = False
    for rf in Path("/sys/class/rfkill").glob("rfkill*"):
        try:
            if (rf / "type").read_text().strip() == "bluetooth" and (rf / "name").read_text().strip() == adapter:
                soft, hard = (rf / "soft").read_text().strip() == "1", (rf / "hard").read_text().strip() == "1"
        except OSError:
            pass
    h["blocked"] = "hard" if hard else "soft" if soft else ""
    pw = _run(["busctl", "get-property", "org.bluez", f"/org/bluez/{adapter}", "org.bluez.Adapter1", "Powered"])
    h["powered"] = pw.endswith("true") if pw else None
    if not h["present"]:
        h["fix"].append(f"No {adapter}. Pi onboard: check dtoverlay isn't disabling Bluetooth in /boot/firmware/config.txt "
                        "(dtoverlay=disable-bt), then reboot. USB dongle: replug it; 'dmesg | grep -i bluetooth' for firmware errors "
                        "(Realtek UB5A needs firmware-realtek).")
    if h["bluez"] != "active":
        h["fix"].append("BlueZ isn't running: sudo systemctl enable --now bluetooth")
    if soft:
        h["fix"].append(f"{adapter} is soft-blocked: sudo rfkill unblock bluetooth (apt install rfkill if missing)")
    if hard:
        h["fix"].append(f"{adapter} is hard-blocked (a switch or the firmware) -- rfkill can't clear it")
    if h["present"] and h["powered"] is False:
        h["fix"].append(f"{adapter} is off: bluetoothctl power on (or: sudo btmgmt -i {adapter} power on)")
    h["ok"] = not h["fix"]
    # the Pi itself (useful on a remote site)
    try:
        h["tempC"] = round(int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000, 1)
    except (OSError, ValueError):
        pass
    th = _run(["vcgencmd", "get_throttled"])
    if th.startswith("throttled="):
        v = int(th.split("=")[1], 16)
        h["throttled"] = hex(v)
        h["throttle"] = [t for b, t in THROTTLE_BITS.items() if v >> b & 1]
    try:
        h["uptime"] = int(float(Path("/proc/uptime").read_text().split()[0]))
        h["model"] = Path("/proc/device-tree/model").read_text().strip("\0\n")
    except (OSError, ValueError):
        pass
    return h


# ---------------------------------------------------------------------------------------------- sources
class Scanner:
    """One adapter, scanning for ever: restarts after an unplug / BlueZ restart. on_record(record) for each advert."""

    def __init__(self, adapter: str, on_record, node="local", zone="Home", mode="active", log=None):
        self.adapter, self.on_record, self.node, self.zone, self.mode = adapter, on_record, node, zone, mode
        self.log = log or (lambda s: print(s, flush=True))   # flushed: systemd holds unflushed stdout
        self.up, self.error, self.count = False, "", 0

    async def run(self):
        try:
            from bleak import BleakScanner
        except ImportError:
            self.error = "bleak isn't installed (sudo apt install python3-bleak, or pip install bleak)"
            self.log(f"[ble] {self.error}")
            return

        def cb(device, adv):
            self.count += 1
            try:
                self.on_record(normalise(device, adv, self.node, self.zone, self.adapter))
            except Exception as e:  # a bad advert never stops the scanner
                self.log(f"[ble] skipped an advert: {e}")

        while True:
            scanner = None
            kw = {"adapter": self.adapter} if sys.platform.startswith("linux") else {}
            bluez = {"filters": {"DuplicateData": True}}       # every advert, not just changes: presence needs the repeats
            mode = self.mode
            if mode == "passive" and sys.platform.startswith("linux"):
                try:   # BlueZ passive scanning goes through an advertisement monitor: needs bluetoothd --experimental
                    from bleak.assigned_numbers import AdvertisementDataType
                    from bleak.backends.bluezdbus.advertisement_monitor import OrPattern
                    bluez = {"or_patterns": [OrPattern(0, AdvertisementDataType.FLAGS, bytes([f])) for f in (0x02, 0x04, 0x05, 0x06, 0x1A, 0x18)]}
                except ImportError:
                    mode = "active"
            try:
                scanner = BleakScanner(detection_callback=cb, scanning_mode=mode, bluez=bluez, **kw) if sys.platform.startswith("linux") \
                    else BleakScanner(detection_callback=cb, scanning_mode=mode)
                await scanner.start()
                self.up, self.error = True, ""
                self.log(f"[ble] scanning on {self.adapter} ({mode})")
                last, quiet_since = -1, time.time()
                while True:   # every 20 s: is our scan still running? (bleak doesn't notice BlueZ restarting under it)
                    await asyncio.sleep(20)
                    if sys.platform.startswith("linux"):
                        if not os.path.exists(f"/sys/class/bluetooth/{self.adapter}"):
                            raise RuntimeError(f"{self.adapter} went away")
                        disc = await asyncio.get_running_loop().run_in_executor(None, _run, [
                            "busctl", "get-property", "org.bluez", f"/org/bluez/{self.adapter}", "org.bluez.Adapter1", "Discovering"])
                        if disc.endswith("false") or (not disc and _run(["systemctl", "is-active", "bluetooth"]) != "active"):
                            # seen 2026-10-19 on a Pi: systemctl restart bluetooth -> Discovering false, no error
                            raise RuntimeError("the scan stopped (BlueZ restarted?)")
                    if self.count != last:
                        last, quiet_since = self.count, time.time()
                    elif time.time() - quiet_since > 180:    # nothing at all for 3 min: start the scan afresh
                        raise RuntimeError("no adverts for 3 min; restarting the scan")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if mode == "passive" and self.mode == "passive":
                    self.log(f"[ble] passive scan refused ({e}) -- BlueZ needs --experimental for it; scanning actively")
                    self.mode = "active"
                self.up, self.error = False, str(e) or type(e).__name__
                self.log(f"[ble] {self.adapter}: {self.error}; retrying in 10 s")
                try:
                    if scanner:
                        await scanner.stop()
                except Exception:
                    pass
                await asyncio.sleep(10)


class SimSource:
    """A pretend house for testing without a beacon: a keyring iBeacon (here 4 min of every 8), a pvvx thermometer, a
    BTHome go-box with a fading battery, and passers-by on rotating addresses. = ble.js Sim, roughly."""
    UUID = "f7826da64fa24e988024bc5b71e0893e"

    def __init__(self, on_record, node="local", zone="Home", adapter="sim"):
        self.on_record, self.node, self.zone, self.adapter = on_record, node, zone, adapter
        self.up, self.error, self.count = True, "", 0

    @staticmethod
    def _rpa() -> str:
        b = [0x40 | random.randrange(64)] + [random.randrange(256) for _ in range(5)]
        return ":".join(f"{x:02X}" for x in b)

    async def run(self):
        t0, seq, phones = time.time(), 0, [[self._rpa(), 0.0] for _ in range(3)]
        while True:
            el = time.time() - t0
            base = {"n": self.node, "z": self.zone, "ad": self.adapter, "ts": now_ms(), "at": "random", "tx": None, "nm": None, "m": {}, "s": {}, "u": []}
            ph = (el - 20) % 480
            if el > 20 and ph < 240 and random.random() < 0.9:
                edge = min(ph, 240 - ph)
                r = int(-88 + edge / 2) if edge < 20 else -62 - random.randrange(8)
                self.emit(dict(base, a=self._rpa(), r=r, m={"76": f"0215{self.UUID}00640001c5"}))
            if int(el) % 3 == 0:
                seq = (seq + 1) & 255
                temp, hum = int((24 + 3 * math.sin(el / 600)) * 100), 5500
                self.emit(dict(base, a="A4:C1:38:5E:22:01", at="public", r=-70 - random.randrange(6), nm="ATC_5E2201",
                               s={"181a": "01225e38c1a4" + temp.to_bytes(2, "little", signed=True).hex() + hum.to_bytes(2, "little").hex()
                                  + (2950).to_bytes(2, "little").hex() + f"5a{seq:02x}04"}))
            if int(el) % 5 == 0:
                batt = max(5, 25 - int(el / 60))
                self.emit(dict(base, a="E8:31:CD:00:B0:01", at="public", r=-75 - random.randrange(5), nm="Go-box",
                               s={"fcd2": f"4000{seq:02x}01{batt:02x}0c" + (12800 - (25 - batt) * 20).to_bytes(2, "little").hex()}))
            for p in phones:
                if time.time() > p[1]:
                    p[0], p[1] = self._rpa(), time.time() + 60 + random.random() * 600
                if random.random() < 0.5:
                    self.emit(dict(base, a=p[0], r=-85 - random.randrange(12), m={"76": "1005031c" + secrets.token_hex(3)}))
            await asyncio.sleep(1)

    def emit(self, r):
        self.count += 1
        self.on_record(r)


class Dedup:
    """Per address: pass a record on if its data changed or `sec` has gone by -- the rest are repeats."""

    def __init__(self, sec: float):
        self.sec, self.last = sec, {}

    def want(self, r: dict) -> bool:
        if self.sec <= 0:
            return True
        k, now = r["a"], time.time()
        sig = (r.get("nm"), json.dumps(r.get("m"), sort_keys=True), json.dumps(r.get("s"), sort_keys=True))
        old = self.last.get(k)
        if old and old[1] == sig and now - old[0] < self.sec:
            return False
        self.last[k] = (now, sig)
        if len(self.last) > 5000:   # drop the oldest half: passers-by on rotating addresses pile up
            for key in sorted(self.last, key=lambda x: self.last[x][0])[:2500]:
                del self.last[key]
        return True


class Bucket:
    """Token bucket: rate per second, burst."""

    def __init__(self, rate: float, burst: float):
        self.rate, self.burst, self.tokens, self.t = rate, burst, burst, time.time()

    def take(self, n: float = 1) -> bool:
        now = time.time()
        self.tokens = min(self.burst, self.tokens + (now - self.t) * self.rate)
        self.t = now
        if self.tokens >= n:
            self.tokens -= n
            return True
        return False


# ---------------------------------------------------------------------------------------------- raw HCI (Inspector)
CAP_NET_RAW = 13


def can_raw() -> bool:
    """CAP_NET_RAW in our effective set: without it a raw HCI socket opens fine but hears nothing."""
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("CapEff:"):
                return bool(int(line.split()[1], 16) >> CAP_NET_RAW & 1)
    except (OSError, ValueError):
        pass
    return False


class HciCapture:
    """The controller's own LE advertising report events, byte for byte (what btmon shows) -- for Kelly's packet
    Inspector. A raw HCI socket on the adapter, filtered to LE meta events; BlueZ keeps scanning as usual (bleak), this
    only listens. Needs CAP_NET_RAW (the installer gives the bridge service AmbientCapabilities=CAP_NET_RAW).
    on_event(adapter, ts_ms, bytes) gets the H4 event: 04 3E len subevent ..."""

    def __init__(self, adapter: str, on_event, log=None):
        self.adapter, self.on_event = adapter, on_event
        self.log = log or (lambda s: print(s, flush=True))
        self.state, self.count = "off", 0

    async def run(self):
        import socket as S
        m = re.fullmatch(r"hci(\d+)", self.adapter)
        if not m or not sys.platform.startswith("linux") or not hasattr(S, "BTPROTO_HCI"):
            self.state = "unsupported"
            return
        if not can_raw():
            self.state = "no-permission"
            self.log(f"[ble] raw HCI capture off on {self.adapter}: the bridge lacks CAP_NET_RAW (re-run install-pi.sh --ble)")
            return
        loop = asyncio.get_running_loop()
        while True:
            try:
                s = S.socket(S.AF_BLUETOOTH, S.SOCK_RAW, S.BTPROTO_HCI)
                s.bind((int(m.group(1)),))
                ev = [0, 0]
                ev[0x3E >> 5] |= 1 << (0x3E & 31)
                s.setsockopt(S.SOL_HCI, S.HCI_FILTER, struct.pack("<IIIH2x", 1 << 4, ev[0], ev[1], 0))
                s.setblocking(False)
                self.state = "raw"
                self.log(f"[ble] raw HCI capture on {self.adapter} (Inspector)")
                while True:
                    data = await loop.sock_recv(s, 1024)
                    if len(data) > 4 and data[0] == 4 and data[1] == 0x3E and data[3] in (0x02, 0x0D):
                        self.count += 1
                        self.on_event(self.adapter, now_ms(), data)
            except asyncio.CancelledError:
                raise
            except OSError as e:
                self.state = "error"
                self.log(f"[ble] raw HCI capture on {self.adapter}: {e}; retrying in 15 s")
                try:
                    s.close()
                except Exception:
                    pass
                await asyncio.sleep(15)


# ---------------------------------------------------------------------------------------------- WebSocket client
# (the node agent's side; stdlib only. Client frames are masked, server frames aren't -- RFC 6455 5.3.)
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WsClient:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer

    @classmethod
    async def connect(cls, url: str, timeout: float = 15, cafile: str = ""):
        import base64
        import ssl
        from urllib.parse import urlparse
        u = urlparse(url)
        secure = u.scheme == "wss"
        ctx = ssl.create_default_context(cafile=cafile or None) if secure else None
        reader, writer = await asyncio.wait_for(asyncio.open_connection(u.hostname, u.port or (443 if secure else 80), ssl=ctx), timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or "/") + (f"?{u.query}" if u.query else "")
        writer.write((f"GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        await writer.drain()
        head = (await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout)).decode("latin-1")
        status = head.split("\r\n", 1)[0]
        if " 101 " not in status + " ":
            writer.close()
            raise ConnectionError({"403": "the bridge refused this node (not registered, or wrong token)",
                                   "404": "the bridge has BLE off",
                                   "410": "the bridge's Kelly build has expired"}.get(status.split(" ")[1] if " " in status else "", status))
        want = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        if want not in head:
            writer.close()
            raise ConnectionError("bad WebSocket handshake")
        return cls(reader, writer)

    async def send(self, obj, opcode: int = 0x1):
        data = obj if isinstance(obj, bytes) else json.dumps(obj, separators=(",", ":")).encode()
        n, mask = len(data), os.urandom(4)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + n.to_bytes(2, "big")
        else:
            head += bytes([0x80 | 127]) + n.to_bytes(8, "big")
        self.writer.write(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        await self.writer.drain()

    async def recv(self):
        """-> a decoded JSON message, or None when the server closes."""
        while True:
            b1, b2 = await self.reader.readexactly(2)
            op, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = int.from_bytes(await self.reader.readexactly(2), "big")
            elif n == 127:
                n = int.from_bytes(await self.reader.readexactly(8), "big")
            mask = await self.reader.readexactly(4) if b2 & 0x80 else None
            data = await self.reader.readexactly(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 0x8:
                return None
            if op == 0x9:
                await self.send(data, 0xA)
                continue
            if op == 0x1:
                try:
                    return json.loads(data)
                except ValueError:
                    continue

    def close(self):
        try:
            self.writer.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------------------------- node registry
def token_hash(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


class NodeRegistry:
    """--ble-nodes FILE: {"nodes": {id: {"name", "zone", "hash", "added"}}}. Tokens are shown once, kept hashed."""

    def __init__(self, path: str):
        self.path = Path(path).expanduser()
        self.nodes: dict = {}
        self.load()

    def load(self):
        try:
            self.nodes = json.loads(self.path.read_text()).get("nodes", {})
        except (OSError, ValueError):
            self.nodes = {}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"nodes": self.nodes}, indent=1))
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def add(self, node_id: str, zone: str, name: str = "") -> str:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", node_id):
            raise ValueError("node id: lower-case letters, digits, - and _ (up to 32)")
        tok = secrets.token_urlsafe(24)
        self.nodes[node_id] = {"name": name or node_id, "zone": zone or node_id, "hash": token_hash(tok), "added": int(time.time())}
        self.save()
        return tok

    def revoke(self, node_id: str) -> bool:
        if self.nodes.pop(node_id, None) is None:
            return False
        self.save()
        return True

    def check(self, node_id: str, tok: str) -> dict | None:
        n = self.nodes.get(node_id)
        return n if n and tok and hmac.compare_digest(n["hash"], token_hash(tok)) else None


# ---------------------------------------------------------------------------------------------- the hub
class BleHub:
    """Local adapters + remote nodes -> every /ble page client. ws_frame / read_frame come from kelly_bridge.py."""
    BATCH_SEC = 1.0
    NODE_RATE, NODE_BURST = 30.0, 3000.0         # records/s sustained per node; burst covers a store-and-forward replay

    def __init__(self, args, ws_frame, read_frame):
        self.args, self.ws_frame, self.read_frame = args, ws_frame, read_frame
        self.adapters = [a.strip() for a in (args.ble or "").split(",") if a.strip()]
        self.zone = args.ble_zone
        self.sources: list = []
        self.pages: set = set()
        self.pending: list = []
        self.dedup = Dedup(args.ble_dedup)
        self.reg = NodeRegistry(args.ble_nodes)
        self.sessions: dict = {}                 # node id -> state
        self.keys: list = []                     # registered devices' identity keys (from the page)
        self.health: dict = {}
        self.captures: dict = {}                 # adapter -> HciCapture (raw bytes for the Inspector)
        self.inspectors: set = set()             # page writers with the Inspector open
        self.hci_pending: list = []
        self.hci_bucket = Bucket(40, 200)        # raw events/s to the Inspector, all pages together

    async def start(self):
        for a in self.adapters:
            src = SimSource(self.local, zone=self.zone) if a == "sim" else Scanner(a, self.local, zone=self.zone, mode=self.args.ble_mode)
            self.sources.append(src)
            asyncio.ensure_future(src.run())
            if a != "sim":
                cap = self.captures[a] = HciCapture(a, self.hci_event)
                asyncio.ensure_future(cap.run())
        asyncio.ensure_future(self._flush_loop())
        asyncio.ensure_future(self._health_loop())

    def hci_event(self, adapter: str, ts: int, data: bytes):
        """Only while someone has the Inspector open; never stored or logged."""
        if self.inspectors and self.hci_bucket.take():
            self.hci_pending.append([adapter, ts, data.hex()])

    def inspect_state(self) -> dict:
        return {a: c.state for a, c in self.captures.items()} or {a: "sim" for a in self.adapters if a == "sim"}

    def local(self, r: dict):
        if self.dedup.want(r):
            self.pending.append(r)

    async def _flush_loop(self):
        while True:
            await asyncio.sleep(self.BATCH_SEC)
            if self.pending:
                batch, self.pending = self.pending[:2000], self.pending[2000:]
                await self.to_pages({"t": "advs", "list": batch})
            if self.hci_pending:
                batch, self.hci_pending = self.hci_pending[:400], []
                await self.to_pages({"t": "hci", "list": batch}, only=self.inspectors)

    async def _health_loop(self):
        tick = 0
        while True:
            for a, src in zip(self.adapters, self.sources):
                h = await asyncio.get_running_loop().run_in_executor(None, health, a)
                h.update(scanning=src.up, error=src.error, adverts=src.count)
                self.health[a] = h
                await self.to_pages({"t": "health", "node": "local", "h": h})
            if tick % 6 == 0:
                await self.to_pages({"t": "nodes", "list": self.node_list()})
            tick += 1
            await asyncio.sleep(5 if tick < 3 else 30)

    async def to_pages(self, msg: dict, only: set | None = None):
        targets = self.pages if only is None else self.pages & only
        if not targets:
            return
        frame = self.ws_frame(json.dumps(msg, separators=(",", ":")).encode(), 0x1)
        for w in list(targets):
            try:
                w.write(frame)
                await asyncio.wait_for(w.drain(), 5)
            except Exception:
                self.pages.discard(w)

    async def to_node(self, node_id: str, msg: dict):
        s = self.sessions.get(node_id)
        if s and s.get("w"):
            try:
                s["w"].write(self.ws_frame(json.dumps(msg).encode(), 0x1))
                await s["w"].drain()
            except Exception:
                pass

    def node_list(self) -> list:
        out = []
        for nid, n in self.reg.nodes.items():
            s = self.sessions.get(nid, {})
            out.append({"id": nid, "name": n.get("name", nid), "zone": n.get("zone", nid), "up": bool(s.get("w")), "since": s.get("since"),
                        "lastHb": s.get("lastHb"), "clock": s.get("clock"), "drift": s.get("drift"), "buffered": s.get("buffered"),
                        "ver": s.get("ver"), "adapter": s.get("adapter"), "recs": s.get("recs", 0), "dropped": s.get("dropped", 0),
                        "addr": s.get("addr"), "health": s.get("health"), "discoverUntil": s.get("discoverUntil")})
        return out

    # ---- /ble: a page
    async def page_session(self, reader, writer):
        hello = {"t": "hello", "v": 1, "zone": self.zone, "adapters": self.adapters, "sim": "sim" in self.adapters,
                 "nodes": self.node_list(), "health": self.health, "inspect": self.inspect_state()}
        writer.write(self.ws_frame(json.dumps(hello).encode(), 0x1))
        await writer.drain()
        self.pages.add(writer)
        try:
            while True:
                op, data = await self.read_frame(reader)
                if op == 0x8:
                    writer.write(self.ws_frame(b"", 0x8))
                    break
                if op == 0x9:
                    writer.write(self.ws_frame(data, 0xA))
                    continue
                if op != 0x1:
                    continue
                try:
                    m = json.loads(data)
                except ValueError:
                    continue
                if m.get("t") == "inspect":      # the Inspector opened / closed on this page
                    (self.inspectors.add if m.get("on") else self.inspectors.discard)(writer)
                    writer.write(self.ws_frame(json.dumps({"t": "inspect", "state": self.inspect_state()}).encode(), 0x1))
                    await writer.drain()
                elif m.get("t") == "filter" and isinstance(m.get("keys"), list):
                    self.keys = [str(k)[:80] for k in m["keys"][:500]]
                    for nid in list(self.sessions):
                        await self.to_node(nid, {"t": "filter", "keys": self.keys})
                elif m.get("t") == "discover" and m.get("node") in self.sessions:
                    mins = max(0, min(30, int(m.get("min") or 0)))
                    self.sessions[m["node"]]["discoverUntil"] = now_ms() + mins * 60000 if mins else None
                    await self.to_node(m["node"], {"t": "discover", "min": mins})
                    await self.to_pages({"t": "nodes", "list": self.node_list()})
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            self.pages.discard(writer)
            self.inspectors.discard(writer)
            writer.close()

    # ---- /api/ble-nodes (the page's node list; the /ws token or this machine): GET = list,
    # POST {"op": "add", "id", "zone", "name"} / {"op": "rotate", "id"} -> {"token"} (shown once), {"op": "revoke", "id"}
    async def api(self, method: str, body: bytes) -> tuple:
        self.reg.load()
        if method == "GET":
            return "200 OK", {"nodes": self.node_list()}
        try:
            m = json.loads(body or b"{}")
            op, nid = m.get("op"), str(m.get("id", "")).strip().lower()
            if op == "add":
                if nid in self.reg.nodes:
                    return "409 Conflict", {"error": f"there's already a node '{nid}'"}
                tok = self.reg.add(nid, str(m.get("zone", "")).strip()[:32], str(m.get("name", "")).strip()[:40])
            elif op == "rotate":
                n = self.reg.nodes.get(nid)
                if not n:
                    return "404 Not Found", {"error": "no such node"}
                tok = self.reg.add(nid, n.get("zone", ""), n.get("name", ""))
            elif op == "revoke":
                if not self.reg.revoke(nid):
                    return "404 Not Found", {"error": "no such node"}
                tok = None
            else:
                return "400 Bad Request", {"error": "op: add, rotate or revoke"}
        except ValueError as e:
            return "400 Bad Request", {"error": str(e)}
        if op in ("rotate", "revoke") and self.sessions.get(nid, {}).get("w"):   # the old token's session ends now
            try:
                self.sessions[nid]["w"].close()
            except Exception:
                pass
        if op == "revoke":
            self.sessions.pop(nid, None)
        await self.to_pages({"t": "nodes", "list": self.node_list()})
        return "200 OK", {"ok": True, "token": tok, "nodes": self.node_list()}

    # ---- /ble-node: a remote scanner
    async def node_session(self, reader, writer, query: str):
        q = parse_qs(query)
        nid, tok = q.get("node", [""])[0], q.get("token", [""])[0]
        self.reg.load()                   # added from the command line while running: no restart needed
        reg = self.reg.check(nid, tok)
        if not reg:
            return False
        old = self.sessions.get(nid)
        if old and old.get("w"):          # a node reconnecting replaces its old session
            try:
                old["w"].close()
            except Exception:
                pass
        peer = writer.get_extra_info("peername")
        s = self.sessions[nid] = dict(old or {}, w=writer, since=now_ms(), addr=str(peer[0]) if peer else "", bucket=Bucket(self.NODE_RATE, self.NODE_BURST))
        s.setdefault("recs", 0)
        s.setdefault("dropped", 0)
        print(f"[ble] node {nid} ({reg.get('zone')}) attached from {s['addr']}", flush=True)
        writer.write(self.ws_frame(json.dumps({"t": "welcome", "now": now_ms(), "zone": reg.get("zone")}).encode(), 0x1))
        writer.write(self.ws_frame(json.dumps({"t": "filter", "keys": self.keys}).encode(), 0x1))
        await writer.drain()
        await self.to_pages({"t": "nodes", "list": self.node_list()})
        msgs = Bucket(20, 200)            # messages/s, whatever they hold
        try:
            while True:
                op, data = await self.read_frame(reader)
                if op == 0x8:
                    writer.write(self.ws_frame(b"", 0x8))
                    break
                if op == 0x9:
                    writer.write(self.ws_frame(data, 0xA))
                    continue
                if op != 0x1 or len(data) > 1_000_000 or not msgs.take():
                    s["dropped"] += 1
                    continue
                try:
                    m = json.loads(data)
                except ValueError:
                    s["dropped"] += 1
                    continue
                t = m.get("t")
                if t == "hello":
                    s["ver"], s["adapter"] = str(m.get("ver", ""))[:16], str(m.get("adapter", ""))[:16]
                    if isinstance(m.get("now"), (int, float)):
                        s["drift"] = int(m["now"]) - now_ms()
                elif t == "hb":
                    s["lastHb"] = now_ms()
                    if isinstance(m.get("now"), (int, float)):
                        s["drift"] = int(m["now"]) - now_ms()
                    s["buffered"] = int(m.get("buffered") or 0)
                    if not s["buffered"]:            # caught up: its zone's data reaches now
                        s["clock"] = now_ms()
                    if isinstance(m.get("health"), dict):
                        s["health"] = {k: v for k, v in m["health"].items() if isinstance(v, (str, int, float, bool, list, type(None)))}
                        s["health"]["fix"] = [str(x)[:300] for x in (s["health"].get("fix") or [])][:6]
                    await self.to_pages({"t": "nodes", "list": self.node_list()})
                elif t == "advs" and isinstance(m.get("list"), list):
                    good = []
                    for raw in m["list"][:2000]:
                        if not s["bucket"].take():
                            s["dropped"] += 1
                            continue
                        r = clean(raw, nid, reg.get("zone", nid))
                        if r is None:
                            s["dropped"] += 1
                            continue
                        # the node's clock may be off: put its timestamps on ours
                        if s.get("drift") is not None and abs(s["drift"]) > 2000:
                            r["ts"] -= s["drift"]
                        good.append(r)
                    s["recs"] += len(good)
                    if good:
                        s["clock"] = max(s.get("clock") or 0, max(r["ts"] for r in good))
                        self.pending.extend(good)
                    if isinstance(m.get("seq"), int):
                        writer.write(self.ws_frame(json.dumps({"t": "ack", "seq": m["seq"]}).encode(), 0x1))
                        await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            if self.sessions.get(nid, {}).get("w") is writer:
                self.sessions[nid]["w"] = None
            print(f"[ble] node {nid} left", flush=True)
            writer.close()
            await self.to_pages({"t": "nodes", "list": self.node_list()})
        return True


def add_args(ap):
    g = ap.add_argument_group("BLE (Kelly's BLE page; see bridge/kelly_ble.py)")
    g.add_argument("--ble", metavar="ADAPTERS", default="",
                   help="scan with these adapters for Kelly's BLE page: hci0 (Pi onboard), hci0,hci1 (+ a USB dongle), or sim (no hardware)")
    g.add_argument("--ble-zone", default="Home", help="the zone this bridge's own adapters stand for (default Home)")
    g.add_argument("--ble-mode", choices=("active", "passive"), default="active",
                   help="active scanning (default) asks for scan responses (names); passive only listens -- BlueZ needs --experimental")
    g.add_argument("--ble-dedup", type=float, default=2.0, metavar="SEC", help="pass an unchanged advert on at most every SEC s per device (default 2)")
    g.add_argument("--ble-nodes", default="~/.kelly-ble-nodes.json", help="registered remote scanner nodes (tokens kept hashed)")
    g.add_argument("--ble-add-node", metavar="ID", help="register a remote scanner node, print its token, and exit (with --ble-zone, --ble-node-name)")
    g.add_argument("--ble-node-name", default="", help="with --ble-add-node: a friendly name")
    g.add_argument("--ble-revoke-node", metavar="ID", help="remove a remote node (its token stops working) and exit")


def admin(args) -> bool:
    """--ble-add-node / --ble-revoke-node: done, then the bridge exits."""
    if args.ble_add_node:
        reg = NodeRegistry(args.ble_nodes)
        tok = reg.add(args.ble_add_node, args.ble_zone, args.ble_node_name)
        print(f"Node '{args.ble_add_node}' registered, zone '{args.ble_zone}'. Its token (shown once -- put it in the node's "
              f"/etc/kelly-ble-node.env as KELLY_BLE_NODE_TOKEN):\n\n  {tok}\n\nRestart the bridge to load it if it's running.")
        return True
    if args.ble_revoke_node:
        print("revoked" if NodeRegistry(args.ble_nodes).revoke(args.ble_revoke_node) else "no such node")
        return True
    return False
