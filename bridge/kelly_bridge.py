#!/usr/bin/env python3
"""Kelly Page IP bridge: WebSocket <-> radio (serial port or TCP), stdlib only.

Browsers can't open raw serial ports remotely or raw TCP sockets, so this sits
on the machine wired to the radio and relays bytes both ways. It also serves the
Kelly Page files, so one URL does everything:

  python kelly_bridge.py --serial COM5                 # radio on this PC's COM5
  python kelly_bridge.py --serial /dev/ttyUSB0 --baud 19200 --bind 0.0.0.0 --token s3cret
  python kelly_bridge.py --tcp 192.168.0.1:7131        # any TCP endpoint speaking CCDI
  python kelly_bridge.py                               # no radio: just the page + RadioID lookups
  python kelly_bridge.py --serial COM5 --mesh-serial COM7   # + a LoRa node (Meshtastic / MeshCore / LoRa APRS) for the LoRa Mesh page (/mesh)
  python kelly_bridge.py --mesh-ble AA:BB:CC:DD:EE:FF  # + a MeshCore companion over Bluetooth LE (kelly_mesh_ble.py; Linux / BlueZ)
  python kelly_bridge.py --serial /dev/ttyUSB0 --ble hci0   # + Bluetooth LE scanning for the BLE page (/ble; kelly_ble.py)
  python kelly_bridge.py --mesh-sim                    # a simulated MeshCore node for the LoRa Mesh page (kelly_mesh_sim.py; no hardware)

then open  http://localhost:8025/  (Admin > IP bridge > ws://localhost:8025/ws).
For https (GPS, camera, Bluetooth on a phone): --tls self, or --tls-cert/--tls-key -- see bridge/HTTPS.md.

It also proxies RadioID.net (GET /api/radioid?id=5050002 or ?callsign=VK4XXX,
cached a day) because RadioID sends no CORS header and the page can't call it.

With --keeper-local (the Raspberry Pi install) it also holds the keeper's log: the Pi's
headless Kelly (bridge/kelly_keeper.py) POSTs what it has logged to /api/keeper-store
(this machine only), and a PC Kelly taking the radio GETs it (same token as /ws) and
merges it -- calls, texts, statuses and alerts heard while every PC was off.

Several browsers may attach at once: radio output goes to all of them, input
from any of them goes to the radio. Default bind is 127.0.0.1; when binding
wider, use --token so only people with the token (ws://host:8025/ws?token=...)
can key your radio. --serial needs pyserial (the project venv has it).
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import datetime
import hashlib
import json
import mimetypes
import os
import re
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import kelly_ble  # noqa: E402  (BLE scanning + remote nodes for the BLE page)
except ImportError:      # an older release folder without it: everything else still works
    kelly_ble = None
import kelly_tls  # noqa: E402  (--tls / --tls-cert: https + wss, bridge/HTTPS.md)
import kelly_mesh_ble  # noqa: E402  (--mesh-ble: a MeshCore companion over Bluetooth LE)
import kelly_state  # noqa: E402  (/api/kelly-state: awards shared between a member's Kellys)
import kelly_igate  # noqa: E402  (/api/igate: the APRS iGate's APRS-IS connection)
import kelly_ent  # noqa: E402  (entitlements: the twin of js/entitlements.js)
import kelly_ident  # noqa: E402  (/api/ident: this bridge's device key + registration token)

# What a refused member feature does (the twin of js/entitlements.js REFUSAL; scripts/export_kelly_public.py sets "message"):
# "silent" drops it with a debug line, "message" also tells the page. Defence in depth only -- the page already gates these,
# and the real protection for Tait programming is that the add-on is not in the public tree.
REFUSAL = "message"
REFUSAL_TEXT = "Available to registered P25X members. Register at kellypage.app"
for _f, _tier in (("radio.testtx", "registered"), ("ccr.tx", "registered"), ("p25.transparent", "member"),
                  ("build.removed", "never")):     # never: a radio command this build doesn't have (= entitlements.js)
    kelly_ent.FEATURES.setdefault(_f, _tier)       # (kelly_ent.py lists only what the bridge itself used to gate)


def radio_feature(data: bytes) -> str | None:
    """The feature a write to the radio needs, or None (open). The bridge's twin of KellyEnt.ccdiFeature() for the
    features that don't depend on the gateway's ID (texts to the gateway are the page's gate), plus Tait programming
    mode, which is not CCDI: the bare '^' / '#' entry bytes the programmer writes (the 0x85 / 0x89 frames after them
    are binary, like an SSTV burst, so they are not classified -- without the entry bytes the radio never listens)."""
    if len(data) <= 4 and (b"^" in data or b"#" in data):   # the programmer writes them bare (maybe with a CR); an SSTV burst is longer
        return "tait.program"
    for frame in data.split(b"\r"):
        w = frame.decode("latin-1")
        try:                                           # only a well-formed CCDI frame counts: [ident][size][params][checksum]
            n = int(w[1:3], 16)
            if len(w) != 5 + n or int(w[3 + n:], 16) != (-sum(w[:3 + n].encode("latin-1"))) & 0xFF:
                continue
        except ValueError:
            continue
        p, c = w[3:3 + n], w[0]
        if c == "d":
            if p[:1] in ("0", "1"):
                return "radio.testtx"
            if p[:1] == "6" and p[1:].split(",")[0] in ("3", "4", "5"):   # = ccdiFeature: the service type is the text up to the comma
                return "build.removed"   # (unreachable in the members' build)
        elif c == "w" and p[:4] in ("0000", "0001"):
            return "radio.testtx"
        elif c in "TBD":
            return "ccr.tx"
        elif c == "S":
            return "radio.testtx"
        elif c == "U":
            u = p[:1]
            if u in ("A", "C", "E"):
                return "ccr.tx"
            if u == "Z":
                if p[1:2] == "A" and p[2:3] == "1":
                    return "ccr.tx"
                if p[1:2] in ("G", "H", "D"):
                    return "p25.transparent"
    return None


REV_URL = "https://kellypage.app/api/revoked"
_rev_seq = 0


def apply_revocation(doc: str) -> str | None:
    """Verify a /api/revoked document and apply it to this bridge's token. None = accepted, else the refusal reason."""
    global _rev_seq
    ok, why, payload, _stale = kelly_ent.verify_revocations(doc, min_seq=_rev_seq)
    if not ok:
        return why
    _rev_seq = payload["seq"]
    kelly_ent.set_revocations(payload)
    return None


async def revocation_loop(fetch=None, every: float = 3600.0):
    """Hourly, best effort, public build only: a revoked token / device loses its entitlements (ENT_REVOKED)."""
    def get():
        with urllib.request.urlopen(urllib.request.Request(REV_URL, headers={"User-Agent": "kelly-bridge"}), timeout=20) as r:
            return r.read().decode("utf-8")
    while True:
        try:
            doc = await to_thread(fetch or get)
            if doc:
                apply_revocation(doc)
        except Exception:                              # noqa: BLE001 -- offline, 404 (no list published): try again next hour
            pass
        await asyncio.sleep(every)


def note_radio_serial(data: bytes) -> None:
    """A CCDI serial reply ('n' frame, well formed) from the radio: the token's optional ser binding compares to it."""
    for frame in data.split(b"\r"):
        w = frame.decode("latin-1")
        try:
            n = int(w[1:3], 16)
            if w[:1] == "n" and n and len(w) == 5 + n and int(w[3 + n:], 16) == (-sum(w[:3 + n].encode("latin-1"))) & 0xFF:
                kelly_ent.set_serial(w[3:3 + n])
        except ValueError:
            continue


WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
ROOT = Path(__file__).resolve().parent.parent          # kelly-page/
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/manifest+json", ".webmanifest")


async def to_thread(fn, *args):
    """asyncio.to_thread is Python 3.9+; this works on 3.8 too (the last Python for Windows 7)."""
    return await asyncio.get_running_loop().run_in_executor(None, fn, *args)


class Hub:
    """Fans radio bytes out to every client; one shared radio link."""

    def __init__(self, args):
        self.args = args
        self.kstate = kelly_state.KellyState(getattr(args, "kelly_state", "") or None)   # /api/kelly-state
        self.igate = kelly_igate.Igate(verbose=getattr(args, "verbose", False))      # /api/igate (off until the page configures it)
        self.ident = kelly_ident.Ident(getattr(args, "ident_dir", "") or None)       # /api/ident (device key, registration)
        self.clients: set[asyncio.StreamWriter] = set()
        self.keepers: set[asyncio.StreamWriter] = set()   # --keeper-local: this machine's own Kelly (also in clients)
        self.ble: "kelly_ble.BleHub | None" = None         # --ble / registered remote nodes
        self.loop: asyncio.AbstractEventLoop | None = None
        self.serial = None
        self.tcp_writer: asyncio.StreamWriter | None = None
        self.target = (f"serial {args.serial} @ {args.baud}" if args.serial else f"tcp {args.tcp}" if args.tcp
                       else "no radio (page + RadioID lookups only)")
        self.up = False
        # --keeper-local: the headless Kelly's latest log (JSON bytes), when it last stood down for a person
        # (ms), and the file it's kept in so a bridge restart doesn't lose it (written at most every 5 min)
        self.keeper_store: bytes = b""
        self.handover = 0
        self.store_file = Path(args.keeper_store).expanduser() if args.keeper_local else None
        self.store_saved = 0.0
        if self.store_file and self.store_file.is_file():
            try:
                self.keeper_store = self.store_file.read_bytes()
            except OSError:
                pass

    def save_store(self, force: bool = False) -> None:
        if not self.store_file or not self.keeper_store or not force and time.time() - self.store_saved < 300:
            return
        self.store_saved = time.time()
        try:
            tmp = self.store_file.with_suffix(".tmp")
            tmp.write_bytes(self.keeper_store)
            os.replace(tmp, self.store_file)
        except OSError as e:
            print(f"[bridge] couldn't save the keeper's log to {self.store_file}: {e}", flush=True)

    # ---------------------------------------------------------------- radio
    async def start_radio(self):
        self.loop = asyncio.get_running_loop()
        if self.args.serial:
            try:
                import serial  # pyserial
            except ImportError:
                sys.exit("--serial needs pyserial:  py -3 -m pip install --user pyserial   (or start-kelly.bat, which installs it)")
            self._pyserial = serial
            threading.Thread(target=self._serial_reader, daemon=True).start()
        elif self.args.tcp:
            asyncio.create_task(self._tcp_loop())

    def _serial_reader(self):
        # Opens the radio's port, reads it, and on any error (unplugged, a USB glitch, the lead's chip resetting)
        # closes it and opens it again every 3 s until the radio is back -- like MeshLink's. Before 2026-10-26 one
        # error ended this thread and the radio stayed dead until the bridge restarted (the LoRa node came back).
        said = ""
        while True:
            if self.serial is None:
                try:
                    self.serial = self._pyserial.Serial(self.args.serial, self.args.baud, bytesize=8, parity="N",
                                                        stopbits=1, timeout=0.05, rtscts=self.args.rtscts)
                    self.up, said = True, ""
                    asyncio.run_coroutine_threadsafe(self.notice("radio connected"), self.loop)
                except Exception as e:                 # noqa: BLE001 -- not plugged in yet: try again shortly
                    if said != f"not opened: {e}":     # a radio that stays away: said once, not every retry
                        said = f"not opened: {e}"
                        asyncio.run_coroutine_threadsafe(self.notice(f"radio port not opened: {e} -- retrying"), self.loop)
                    time.sleep(3)
                    continue
            try:
                data = self.serial.read(512)
            except Exception as e:                     # noqa: BLE001 -- unplugged / reset: reopen
                self._serial_lost(e)
                time.sleep(2)
                continue
            if data:
                asyncio.run_coroutine_threadsafe(self.broadcast(data), self.loop)

    def _serial_lost(self, e):
        s, self.serial, self.up = self.serial, None, False
        if s is None:
            return
        try:
            s.close()
        except Exception:                              # noqa: BLE001
            pass
        asyncio.run_coroutine_threadsafe(self.notice(f"serial error: {e} -- reopening"), self.loop)

    def _serial_write(self, data: bytes):
        s = self.serial
        if s is None:
            return                                     # radio away: dropped, the reader is reopening it
        try:
            s.write(data)
        except Exception as e:                         # noqa: BLE001 -- never let it end the page's WebSocket
            if s is self.serial:
                self._serial_lost(e)

    async def _tcp_loop(self):
        host, port = self.args.tcp.rsplit(":", 1)
        while True:
            try:
                reader, writer = await asyncio.open_connection(host, int(port))
                self.tcp_writer, self.up = writer, True
                await self.notice("radio connected")
                while data := await reader.read(1024):
                    await self.broadcast(data)
            except OSError as e:
                await self.notice(f"tcp error: {e}")
            self.tcp_writer, self.up = None, False
            await asyncio.sleep(3)

    async def to_radio(self, data: bytes):
        need = radio_feature(data)
        if need and not kelly_ent.check(need, "to_radio"):
            if REFUSAL == "message":
                await self.notice(REFUSAL_TEXT)
            return
        if self.args.serial:
            await to_thread(self._serial_write, data)
        elif self.tcp_writer is not None:
            self.tcp_writer.write(data)
            await self.tcp_writer.drain()
        if self.args.verbose:
            print(f"  -> {data!r}", flush=True)

    # -------------------------------------------------------------- clients
    async def broadcast(self, data: bytes, opcode: int = 0x2):
        if self.args.verbose and opcode == 0x2:
            print(f"  <- {data!r}", flush=True)
        if opcode == 0x2 and kelly_ent.public():
            note_radio_serial(data)
        dead = []
        for w in self.clients:
            try:
                w.write(ws_frame(data, opcode))
                await w.drain()
            except (ConnectionError, RuntimeError):
                dead.append(w)
        for w in dead:
            self.clients.discard(w)

    async def notice(self, text: str):
        print(f"[bridge] {text}", flush=True)
        await self.broadcast(json.dumps({"bridge": text, "target": self.target}).encode(), opcode=0x1)


class MeshLink:
    """A LoRa node for Kelly's LoRa Mesh page (js/mesh.js): bytes relayed both ways between the node and every
    /mesh WebSocket client. The page does all the framing (Meshtastic 94 C3 len, MeshCore '<'/'>' len, KISS);
    this only carries bytes. --mesh-serial PORT (115200 8N1, the node's USB) or --mesh-tcp HOST[:PORT] (a WiFi
    node: Meshtastic 4403, MeshCore companion 5000 -- which takes ONE client, a new one drops the old -- or a
    LoRa APRS iGate's KISS 8001) or --mesh-ble ADDR (a MeshCore companion over Bluetooth LE: kelly_mesh_ble.py turns
    its one-frame-per-notification into the USB '>' framing and back, so nothing else can tell). Runs without a
    radio too (no --serial/--tcp): a mesh-only bridge, e.g. on the Ipswich NUC beside Bravo's MeshCore WiFi node.
    A node that isn't there never stops the radio side."""

    ble = None                                    # --mesh-ble: a kelly_mesh_ble.MeshBleLink (class default: tests build bare links)

    @property
    def key_guard(self) -> "PrivateKeyGuard":
        """Every byte written to the node goes through this one guard (no CMD 23/24 from a client). Lazy: tests build bare links."""
        if "_key_guard" not in self.__dict__:
            a = getattr(self, "args", None)
            self._key_guard = PrivateKeyGuard(meshcore=bool(getattr(self, "mc", None) or getattr(a, "mesh_ble", None)
                                                            or getattr(a, "mesh_sim", False)))
        return self._key_guard

    @property
    def wlock(self) -> asyncio.Lock:
        if "_wlock" not in self.__dict__:
            self._wlock = asyncio.Lock()
        return self._wlock

    def __init__(self, args):
        self.args = args
        self.clients: set[asyncio.StreamWriter] = set()
        self.keepers: set[asyncio.StreamWriter] = set()   # --keeper-local: the Pi's headless Kelly (also in clients)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.serial = None
        self.tcp_writer: asyncio.StreamWriter | None = None
        self.up = False
        self.target = (f"LoRa node on {args.mesh_serial}" if args.mesh_serial else
                       f"LoRa node at {args.mesh_tcp}" if args.mesh_tcp else
                       f"MeshCore node on Bluetooth {args.mesh_ble}" if getattr(args, "mesh_ble", None) else
                       "simulated MeshCore node (--mesh-sim)" if getattr(args, "mesh_sim", False) else "")
        self.sim = None                           # --mesh-sim: kelly_mesh_sim.MeshCoreSim in place of a real node
        # for /api/mesh-status (the P25X dashboard's LoRa Mesh page)
        self.opened_at = 0.0
        self.last_rx = 0.0
        self.rx_bytes = 0
        self.tx_bytes = 0
        self.errors: list[tuple[float, str]] = []
        self.reopen_wanted = False
        # --mesh-gateway (a MeshCore companion node): the bridge reads the node itself while no Kelly is attached,
        # and notes the messages that pass through to one that is -- /api/mesh-texts for the P25X gateway
        self.mc = MeshCoreWatch(self) if getattr(args, "mesh_gateway", False) else None

    def _error(self, text: str):
        self.errors = (self.errors + [(time.time(), text)])[-10:]
        if self.loop:
            asyncio.run_coroutine_threadsafe(self.notice(text), self.loop)

    async def start(self):
        self.loop = asyncio.get_running_loop()
        if self.mc:
            asyncio.create_task(self.mc.run())
            asyncio.create_task(self.mc.watch_answers())
            if self.mc.hist:
                asyncio.create_task(self.mc.history_loop())
                if getattr(self.args, "mesh_history_upload", ""):
                    asyncio.create_task(self.mc.upload_loop())
        if self.args.mesh_serial:
            threading.Thread(target=self._serial_reader, daemon=True).start()
        elif self.args.mesh_tcp:
            asyncio.create_task(self._tcp_loop())
        elif getattr(self.args, "mesh_ble", None):
            pin = self.args.mesh_ble_pin if self.args.mesh_ble_pin is not None else int(os.environ.get("KELLY_MESH_BLE_PIN") or kelly_mesh_ble.DEFAULT_PIN)
            self.ble = kelly_mesh_ble.MeshBleLink(self.args.mesh_ble, self._ble_in, self._ble_state, adapter=self.args.mesh_ble_adapter, pin=pin)
            asyncio.create_task(self.ble.run())
        elif getattr(self.args, "mesh_sim", False):
            from kelly_mesh_sim import MeshCoreSim, parse_faults
            self.sim = MeshCoreSim(self._sim_out, parse_faults(getattr(self.args, "mesh_sim_faults", "") or ""), seed=int(time.time()))
            self.up, self.opened_at = True, time.time()
            asyncio.create_task(self.sim.run())

    def _sim_out(self, data: bytes):
        """The simulated node's output: the same path as bytes read from a real node's port."""
        self.rx_bytes += len(data)
        self.last_rx = time.time()
        asyncio.get_running_loop().create_task(self.broadcast(data))
        if self.mc:
            self.mc.feed(data)

    def _ble_in(self, data: bytes):
        """A frame from the Bluetooth node, already in the USB '>' framing: the same path as bytes off a port."""
        self.rx_bytes += len(data)
        self.last_rx = time.time()
        asyncio.get_running_loop().create_task(self.broadcast(data))
        if self.mc:
            self.mc.feed(data)

    def _ble_state(self, up: bool, text: str):
        if up:
            self.up, self.opened_at = True, time.time()
            asyncio.get_running_loop().create_task(self.notice(text))
        else:
            self.up = False
            if not self.errors or self.errors[-1][1] != text:   # a node that stays away: said once, not every retry
                self._error(text)

    def _serial_reader(self):
        # Opens the port, reads it, and on any error (a reset or a USB glitch -- "device reports readiness to
        # read but returned no data") closes it and opens it again, every 5 s until the node is back. Before
        # 2026-10-17 one error ended this thread and the node stayed dead until the service restarted.
        try:
            import serial  # pyserial
        except ImportError as e:
            self._error(f"LoRa node: pyserial missing ({e})")
            return
        while True:
            if self.serial is None:
                try:
                    self.serial = serial.Serial(self.args.mesh_serial, 115200, timeout=0.05)
                    if fill := self.key_guard.filler():
                        self.serial.write(fill)
                    self.up, self.opened_at, self.reopen_wanted = True, time.time(), False
                    if self.loop:
                        asyncio.run_coroutine_threadsafe(self.notice("LoRa node connected"), self.loop)
                except Exception as e:                 # noqa: BLE001 -- not plugged in yet: try again shortly
                    self.up = False
                    if not self.errors or self.errors[-1][1] != f"LoRa node not opened: {e}":
                        self._error(f"LoRa node not opened: {e}")
                    time.sleep(5)
                    continue
            try:
                if self.reopen_wanted:
                    raise OSError("reconnect asked for")
                data = self.serial.read(512)
            except Exception as e:                     # noqa: BLE001 -- unplugged / reset: reopen
                self.up = False
                self._error(f"LoRa node serial error: {e} -- reopening")
                try:
                    self.serial.close()
                except Exception:                      # noqa: BLE001
                    pass
                self.serial = None
                time.sleep(2)
                continue
            if data:
                self.rx_bytes += len(data)
                self.last_rx = time.time()
                self.key_guard.saw_node(data)
                asyncio.run_coroutine_threadsafe(self.broadcast(data), self.loop)
                if self.mc:
                    self.loop.call_soon_threadsafe(self.mc.feed, data)

    def status(self) -> dict:
        return {"target": self.target, "up": self.up, "clients": len(self.clients), "openedAt": int(self.opened_at * 1000),
                "lastRx": int(self.last_rx * 1000), "rxBytes": self.rx_bytes, "txBytes": self.tx_bytes,
                "errors": [[int(t * 1000), m] for t, m in self.errors],
                **({"node": self.mc.state(), "staleFor": round(self.mc.stale_for()), "lastAnswer": int(self.mc.answered_at * 1000),
                    "resets": self.mc.resets, "lastReset": int(self.mc.reset_at * 1000), "warnings": self.mc.warnings,
                    "prune": self.mc.prune_last, "rpt": self.mc.rpt_last,
                    "autoReset": getattr(self.args, "mesh_auto_reset", 0) or 0} if self.mc else {})}

    # nRF52840 boards with native USB (RAK4631, SenseCAP Solar / XIAO, Nordic): no auto-reset circuit, and opening the
    # port at 1200 baud drops them into the bootloader -- never do that here.
    NRF52_VIDS = {0x239A: "RAK / Adafruit nRF52", 0x2886: "Seeed nRF52", 0x1915: "Nordic nRF52"}

    def usb_vid(self) -> int | None:
        """The USB vendor ID behind --mesh-serial (follows /dev/serial/by-id links), or None."""
        try:
            from serial.tools import list_ports
            dev = os.path.realpath(self.args.mesh_serial)
            return next((p.vid for p in list_ports.comports() if os.path.realpath(p.device) == dev), None)
        except Exception:                              # noqa: BLE001
            return None

    async def reset_node(self) -> str:
        """Reboot a USB node. ESP32 boards (Heltec V3 etc., CP2102/CH9102): the way esptool does it -- the auto-reset
        circuit holds EN low while RTS is asserted with DTR not, then lets it go with IO0 high = a normal boot. Reopening
        the port doesn't do it (pyserial asserts both, which the circuit cancels out). nRF52 boards ignore RTS: they get
        MeshCore's own REBOOT command (CMD 19 "reboot"), which only works while the firmware still reads commands -- a
        truly hung nRF52 needs its power cycled. '' = done, else why not."""
        if self.sim is not None:                  # a simulated reboot: a hung sim answers again
            self.sim.born = time.time()
            return ""
        if self.ble is not None:                  # Bluetooth: MeshCore's own REBOOT command, then the link reconnects
            if not self.ble.up:
                return "the node isn't connected over Bluetooth"
            try:
                await self.ble.write(b"<\x07\x00\x13reboot")
                return ""
            except Exception as e:                     # noqa: BLE001
                return f"reboot command failed ({e}) -- power-cycle it"
        port = self.serial
        if port is None:
            return "only a node on USB (--mesh-serial) can be reset" if not self.args.mesh_serial else "the node's port isn't open"
        vid = await to_thread(self.usb_vid)
        if vid in self.NRF52_VIDS:
            if not self.mc:
                return f"{self.NRF52_VIDS[vid]}: no RTS reset on this board -- power-cycle it"

            fill = self.key_guard.filler()            # so the node reads the reboot as a frame of its own

            def reboot():
                port.write(fill + b"<\x07\x00\x13reboot")
            try:
                await to_thread(reboot)
                self.reopen_wanted = True             # its USB drops and comes back: reopen cleanly
                return ""
            except Exception as e:                     # noqa: BLE001
                return f"{self.NRF52_VIDS[vid]}: reboot command failed ({e}) -- power-cycle it"

        def pulse():
            port.dtr = False
            port.rts = True
            time.sleep(0.2)
            port.rts = False
            if fill := self.key_guard.filler():   # rebooted: ignored; any half frame the guard held is closed off
                port.write(fill)
        try:
            await to_thread(pulse)
            return ""
        except Exception as e:                         # noqa: BLE001
            return f"reset failed: {e}"

    def reopen(self):
        """Drop and reopen the node's port (or TCP link) -- the dashboard's Reconnect button."""
        if self.args.mesh_serial:
            self.reopen_wanted = True
        elif self.ble is not None:
            asyncio.get_running_loop().create_task(self.ble.drop())
        elif self.tcp_writer is not None:
            self.tcp_writer.close()

    async def _tcp_loop(self):
        host, _, port = self.args.mesh_tcp.partition(":")
        while True:
            try:
                reader, writer = await asyncio.open_connection(host, int(port or 4403))
                if fill := self.key_guard.filler():
                    writer.write(fill)
                self.tcp_writer, self.up, self.opened_at = writer, True, time.time()
                await self.notice("LoRa node connected")
                while data := await reader.read(1024):
                    self.rx_bytes += len(data)
                    self.last_rx = time.time()
                    self.key_guard.saw_node(data)
                    await self.broadcast(data)
                    if self.mc:
                        self.mc.feed(data)
            except OSError as e:
                self.errors = (self.errors + [(time.time(), f"LoRa node tcp error: {e}")])[-10:]
                await self.notice(f"LoRa node tcp error: {e}")
            self.tcp_writer, self.up = None, False
            await asyncio.sleep(5)

    async def write(self, data: bytes) -> bool:
        """False (nothing sent): data would run a private-key command on the node (key_guard). One write at a time,
        so the node gets bytes in the order the guard checked them."""
        async with self.wlock:
            if not self.key_guard.check(data):
                return False
            port = self.serial
            try:
                if self.sim is not None:
                    self.sim.write(data)
                elif self.ble is not None:
                    await self.ble.write(data)
                elif port is not None:
                    await to_thread(port.write, data)
                elif self.tcp_writer is not None:
                    self.tcp_writer.write(data)
                    await self.tcp_writer.drain()
                else:
                    await self.notice("LoRa node not connected -- not sent")
                    return True                            # (the next connect's filler squares the guard up)
                self.tx_bytes += len(data)
                if self.mc:
                    self.mc.note_sent(data)
            except Exception as e:                         # noqa: BLE001 -- the reader reopens the port
                await self.notice(f"LoRa node write failed: {e}")
            return True

    async def broadcast(self, data: bytes, opcode: int = 0x2):
        dead = []
        for w in self.clients:
            try:
                w.write(ws_frame(data, opcode))
                await w.drain()
            except (ConnectionError, RuntimeError):
                dead.append(w)
        for w in dead:
            self.clients.discard(w)

    async def notice(self, text: str):
        print(f"[bridge] {text}", flush=True)
        await self.broadcast(json.dumps({"bridge": text, "target": self.target}).encode(), opcode=0x1)


MC_PRIVATE_KEY_CMDS = (23, 24)   # CMD_EXPORT_PRIVATE_KEY / CMD_IMPORT_PRIVATE_KEY
MC_MAX_FRAME = 172               # MeshCore MAX_FRAME_SIZE: a longer frame is cut to this and still run


class PrivateKeyGuard:
    """MeshCore companion frames that move the node's PRIVATE key (CMD 23 / 24) never reach the node from a /mesh
    client: a bridge token (in a Connect-a-phone or bridge-address QR) must not be enough to copy or replace a node's
    identity (kelly-page/QR_REVIEW.md, bridge hole; review/qr-06-final-review.md F2). Kelly itself never sends them.

    ONE per node link (MeshLink.key_guard), fed every byte written to the node -- clients' and the bridge's own --
    running the firmware's own parser (ArduinoSerialInterface::checkRecvFrame: '<', len lo, len hi, then len bytes,
    any length 1-65535, cut to 172), so a frame split across messages or clients, an oversize frame or a non-zero
    high length byte is seen exactly as the node will see it. check(data) -> True and the state moves on, or False
    and nothing of data is counted as sent (the caller drops it, and the client). `off` (a node that says it isn't
    MeshCore -- Meshtastic / KISS, see saw_node) passes everything: those don't know these commands."""

    def __init__(self, meshcore: bool = False):
        self.state, self.flen, self.rx = 0, 0, 0   # 0 idle, 1 '<' seen, 2 len lo seen, 3 in a frame
        self.kind = "meshcore" if meshcore else None   # None: not known yet -> checked as MeshCore

    @property
    def off(self) -> bool:
        return self.kind == "other"

    def saw_node(self, data: bytes):
        """Bytes from the node: a '>' frame says MeshCore (for good), a Meshtastic 94 C3 / KISS C0 start with no '>'
        before it says not. Undecided until then (checked as MeshCore)."""
        if self.kind is not None or not data:
            return
        gt = data.find(b">")
        other = min((i for i in (data.find(b"\x94\xc3"), 0 if data[0] == 0xC0 else -1) if i >= 0), default=-1)
        if other >= 0 and (gt < 0 or other < gt):
            self.kind = "other"
        elif gt >= 0:
            self.kind = "meshcore"

    def check(self, data: bytes) -> bool:
        if self.off:
            return True
        state, flen, rx = self.state, self.flen, self.rx
        for c in data:
            if state == 0:
                if c == 0x3C:
                    state = 1
            elif state == 1:
                flen, state = c, 2
            elif state == 2:
                flen |= c << 8
                rx, state = 0, (3 if flen else 0)
            else:
                if rx == 0 and c in MC_PRIVATE_KEY_CMDS:
                    return False
                rx += 1
                if rx >= flen:
                    state = 0
        self.state, self.flen, self.rx = state, flen, rx
        return True

    feed = check

    def filler(self) -> bytes:
        """Zero bytes that finish whatever frame the node may be part-way through, and the guard back to idle. Written
        before anything else after a reopen / reconnect / reboot: a node that kept its parser state runs one harmless
        frame (CMD 0, or a frame whose first byte was already checked), a rebooted one ignores them (idle: only '<'
        counts) -- so a node and a guard never disagree about where a frame starts."""
        n = {0: 0, 1: 2, 2: 1 + self.flen, 3: self.flen - self.rx}[self.state]
        self.state, self.flen, self.rx = 0, 0, 0
        return bytes(n)


class MeshCoreWatch:
    """The club MeshCore node, read by the bridge itself (--mesh-gateway). MeshCore companion protocol, as in
    kelly-page/js/meshcore.js: frames '<' len u16 payload (to the node) / '>' len u16 payload (from it), all LE.
    While no Kelly is attached it runs a minimal session -- DEVICE_QUERY, APP_START, GET_CONTACTS, GET_CHANNEL,
    then SYNC_NEXT_MESSAGE on every MSG_WAITING push and every 30 s. While a Kelly IS attached it only listens
    (Kelly's own session syncs the messages, and they pass through here). Texts + contacts -> /api/mesh-texts;
    /api/mesh-send posts on a channel, or with "to" sends a DM and waits for its delivery receipt (only while no Kelly
    is attached: one app at a time).
    Network statistics (/api/mesh-stats, for the P25X dashboard -> MQTT p25x/mesh/meshcore/stats -> Grafana): every
    packet the radio hears arrives as PUSH LOG_RX_DATA (snr*4, rssi, the raw packet: header, path, payload) whether a
    Kelly is attached or not, so the counts never stop; the node's own counters (CMD_GET_STATS core/radio/packets:
    battery, noise floor, TX/RX airtime, packets, CRC errors) are only asked for while no Kelly is attached."""
    CMD_APP_START, CMD_SEND_CHAN, CMD_GET_CONTACTS, CMD_SYNC, CMD_DEVICE_QUERY, CMD_GET_CHANNEL = 1, 3, 4, 10, 22, 31
    R_OK, R_ERR, R_CONTACT, R_END_CONTACTS, R_SELF, R_CONTACT_MSG, R_CHAN_MSG, R_NO_MORE = 0, 1, 3, 4, 5, 7, 8, 10
    R_DEVICE_INFO, R_CONTACT_MSG3, R_CHAN_MSG3, R_CHAN_INFO, R_STATS = 13, 16, 17, 18, 24
    R_SENT, R_CHAN_DATA = 6, 27            # R_CHAN_DATA: a queued channel datagram (fw >= 1.18) -- drained, not shown
    P_ADVERT, P_MSG_WAITING, P_NEW_ADVERT, P_LOG_RX = 0x80, 0x83, 0x8A, 0x88
    P_SEND_CONFIRMED, P_CONTACT_DELETED = 0x82, 0x8F
    P_STATUS = 0x87                        # a repeater's status answer (asked for by a Kelly or anyone): [0][prefix 6][RepeaterStats]
    CMD_SEND_TXT, CMD_GET_STATS = 2, 56
    CMD_GET_TIME, R_CURR_TIME, CMD_REMOVE_CONTACT, CMD_SET_TIME = 5, 9, 15, 6
    CLOCK_OK = 1_715_817_600   # 16 May 2024: a MeshCore clock restarts at 15 May 2024 after a power-off
    MAX_TEXT = 150                         # bytes; MeshCore's MAX_TEXT_LEN is 160 and a channel post carries "name: " too
    STALE_S = 20
    RESET_GAP_S = 600
    # payload types (Packet.h); route 0/3 carry 4 bytes of transport codes before path_len
    PTYPE = {0: "req", 1: "response", 2: "text", 3: "ack", 4: "advert", 5: "group_text", 6: "group_data", 7: "anon_req",
             8: "path", 9: "trace", 10: "multipart", 11: "control", 15: "raw"}
    NODE_TYPE = {1: "companion", 2: "repeater", 3: "room", 4: "sensor"}

    def __init__(self, mesh: "MeshLink"):
        self.mesh = mesh
        self.buf = bytearray()
        # texts heard and sent (each with a stable id), kept across restarts in --mesh-texts FILE -- a phone's Kelly
        # catches up from /api/mesh-texts on what the always-on Kelly / this session collected first
        self.texts_path = Path(mesh.args.mesh_texts).expanduser() if getattr(mesh.args, "mesh_texts", "") else None   # None: not kept (tests)
        self.texts: list[dict] = self._load_texts()
        self._texts_saved_at = 0.0
        self._texts_save_pending = False
        self.packets: list[dict] = []             # the last PACKETS_MAX packets heard over RF (the dashboard's live packet feed)
        self.radio: dict | None = None            # the node's radio settings, from SELF_INFO
        self.contacts: dict[str, dict] = {}       # 6-byte key prefix (hex) -> {name, lat, lon, type, hops}
        self.channels: dict[int, str] = {}
        self.self_name = ""
        self.waiters: list[tuple[set, asyncio.Future]] = []
        self.acks: dict[bytes, asyncio.Future] = {}   # a DM's expected ACK -> its SEND_CONFIRMED (round trip ms)
        self.sync_wanted = asyncio.Event()
        self.session_up = False
        self.idle_since = time.time()
        self.lock = asyncio.Lock()
        self.outbox_path = Path(getattr(mesh.args, "mesh_outbox", "") or "~/.kelly-mesh-outbox.sqlite").expanduser()
        self.db: sqlite3.Connection | None = None
        # Is the node answering? Every command to it ('<' frame, from us or from a Kelly) wants a reply (a frame
        # below 0x80; 0x80+ are unasked pushes). A command left unanswered STALE_S = stuck -- the serial port stays
        # open and the bridge looks fine, but nothing loads (2026-10-17 21:23 -> 05:13 overnight). Told to every
        # Kelly attached ({"node": "stale"}), on /api/mesh-status for p25x-alerts (watchdog:mesh).
        self.unanswered_since: float | None = None
        self.answered_at = 0.0
        self.node_state = "ok"
        # --mesh-auto-reset N: stale N minutes -> the bridge reboots the node itself (USB only, once per RESET_GAP_S)
        self.resets = 0
        self.reset_at = 0.0
        # network statistics
        self.self_pos = None                      # (lat, lon) from SELF_INFO
        self.manual_add = None                    # SELF_INFO [47], for --mesh-autoadd
        self.net = self._fresh()                  # this interval (reset by /api/mesh-stats?reset=1)
        self.stations: dict[str, dict] = {}       # advert senders by 6-byte key prefix: name, type, km, hops, snr, last, n
        self.node_stats: dict = {}                # CMD_GET_STATS, last answer
        self.stats_at = 0.0
        self.rx_total = 0
        # --mesh-history FILE (Phase 4): a SQLite time series of the above, sampled every minute (kelly_mesh_history.py)
        self.hist = None
        if getattr(mesh.args, "mesh_history", ""):
            from kelly_mesh_history import MeshHistory
            self.hist = MeshHistory(mesh.args.mesh_history)
        self.hmin = self._hfresh()                # this minute's counts, for the history
        self.dm_out: list[str] = []               # DMs written to the node (dest key prefix), waiting for their SENT
        self.dm_tags: dict[bytes, tuple[str, float]] = {}   # a sent DM's ACK tag -> (dest, when): resolved by SEND_CONFIRMED or DM_WAIT_S
        self.air_prev: tuple | None = None        # (tx_air_s, rx_air_s, at) last seen, for airtime %
        self.rpt_prev: dict[str, dict] = {}       # a repeater's last status counters, for its airtime / duplicate %
        self.warnings: dict[str, dict] = {}       # WARN id -> {text, since (ms), value}: on /api/mesh-status (p25x-alerts)
        # --mesh-prune-days N: stale contacts cleaned off the node daily (first run 5 min after start), see prune()
        self.prune_at = time.time() - self.PRUNE_EVERY_S + 300
        self.prune_last: dict = {}
        # --mesh-rpt PREFIX --mesh-rpt-poll MIN: this node's own repeater asked for its status every MIN minutes (first 2 min
        # after start), for its battery / noise / airtime history; see poll_repeater()
        self.rpt_poll_at = time.time() - 60 * (getattr(mesh.args, "mesh_rpt_poll", 0) or 0) + 120
        self.rpt_login_at = 0.0
        self.rpt_last: dict = {}

    @staticmethod
    def _fresh() -> dict:
        return {"t0": time.time(), "packets": 0, "flood": 0, "direct": 0, "types": {}, "hops": [0, 0, 0, 0, 0],
                "snr": [], "rssi": [], "senders": set(), "last_hops": set(), "direct_from": set(), "bytes": 0}

    @staticmethod
    def _hfresh() -> dict:
        return {"packets": 0, "flood": 0, "direct": 0, "bytes": 0, "adverts": 0, "hops_0": 0, "hops_1": 0, "hops_2": 0, "hops_3plus": 0}

    @staticmethod
    def _km(a, b) -> float:
        import math
        r = math.pi / 180
        h = math.sin((b[0] - a[0]) * r / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2
        return 12742 * math.asin(math.sqrt(h))

    PACKETS_MAX = 200

    def on_rx(self, f: bytes):
        """PUSH_CODE_LOG_RX_DATA: snr*4 (i8), rssi (i8), then Packet::writeTo bytes."""
        snr = struct.unpack_from("b", f, 1)[0] / 4; rssi = struct.unpack_from("b", f, 2)[0]; raw = f[3:]
        if len(raw) < 2:
            return
        route, typ = raw[0] & 3, (raw[0] >> 2) & 15
        o = 5 if route in (0, 3) else 1
        if o >= len(raw):
            return
        pl = raw[o]; o += 1
        sz, n = (pl >> 6) + 1, pl & 63
        if sz > 3 or o + n * sz > len(raw):
            return
        path = raw[o:o + n * sz]; pay = raw[o + n * sz:]
        flood = route in (0, 1)
        net = self.net; self.rx_total += 1
        net["packets"] += 1; net["bytes"] += len(raw); net["flood" if flood else "direct"] += 1
        name = self.PTYPE.get(typ, f"type{typ}"); net["types"][name] = net["types"].get(name, 0) + 1
        pk = {"at": int(time.time() * 1000), "snr": snr, "rssi": rssi, "route": "flood" if flood else "direct", "type": name,
              "hops": n if flood else None, "size": len(raw), "via": path[-sz:].hex() if flood and n else ""}
        self.packets = (self.packets + [pk])[-self.PACKETS_MAX:]
        net["snr"].append(snr); net["rssi"].append(rssi)
        if self.hist:
            h = self.hmin; h["packets"] += 1; h["bytes"] += len(raw); h["flood" if flood else "direct"] += 1
            if flood:
                h["hops_3plus" if n >= 3 else f"hops_{n}"] += 1
            self.hist.add("self", "snr", snr); self.hist.add("self", "rssi", rssi)
        if flood:
            net["hops"][min(n, 4)] += 1
            if n:
                net["last_hops"].add(path[-sz:].hex())     # the repeater we heard it from
        if typ == 4 and len(pay) >= 101:                  # an advert names its sender
            key = pay[:32].hex()[:12]; flags = pay[100]; i = 101
            st = self.stations.setdefault(key, {"n": 0, "first": time.time()})
            if flags & 0x10 and len(pay) >= i + 8:
                la, lo = struct.unpack_from("<ii", pay, i); i += 8
                if la or lo:
                    st.update(lat=la / 1e6, lon=lo / 1e6)
            if flags & 0x20: i += 2
            if flags & 0x40: i += 2
            if flags & 0x80 and len(pay) > i:
                st["name"] = pay[i:].split(b"\0")[0].decode("utf-8", "replace")
            ct = self.contacts.get(key, {})
            if st.get("lat") is None and ct.get("lat") is not None:
                st.update(lat=ct["lat"], lon=ct["lon"])
            st.update(type=self.NODE_TYPE.get(flags & 15, "node"), hops=n if flood else None, snr=snr, rssi=rssi, last=time.time(), n=st["n"] + 1)
            st.setdefault("name", ct.get("name") or key)
            pk.update(key=key, name=st["name"], node=st["type"])
            if self.self_pos and st.get("lat") is not None:
                st["km"] = round(self._km(self.self_pos, (st["lat"], st["lon"])), 2)
            net["senders"].add(key)
            if flood and n == 0:
                net["direct_from"].add(key)
            if self.hist:
                self.hmin["adverts"] += 1
                self.hist.add(key, "snr", snr); self.hist.add(key, "rssi", rssi)
                if flood:
                    self.hist.add(key, "hops", n)
                    if n == 0:                               # heard DIRECT: the station's own signal (coverage, Phase 4d)
                        self.hist.add(key, "snr0", snr)
                if st.get("km") is not None:
                    self.hist.add(key, "km", st["km"])
                self.hist.source(key, name=st["name"], type=st["type"], lat=st.get("lat"), lon=st.get("lon"))

    def on_stats(self, f: bytes):
        t = f[1] if len(f) > 1 else -1
        if t == 0 and len(f) >= 11:
            mv, up, err = struct.unpack_from("<HIH", f, 2)
            self.node_stats.update(batt_v=mv / 1000, uptime_s=up, err_flags=err, queue=f[10])
            if self.hist:
                self.hist.add("self", "batt_v", mv / 1000 if mv else None); self.hist.add("self", "queue", f[10])
        elif t == 1 and len(f) >= 14:
            nf, lr, ls, tx, rx = struct.unpack_from("<hbbII", f, 2)
            self.node_stats.update(noise_floor_dbm=nf, last_rssi=lr, last_snr=ls / 4, tx_air_s=tx, rx_air_s=rx)
            if self.hist:
                self.hist.add("self", "noise_floor", nf)
                now, prev = time.time(), self.air_prev
                if prev and now - prev[2] >= 10 and tx >= prev[0] and rx >= prev[1]:   # a reboot zeroes the counters: skip that one
                    self.hist.add("self", "tx_air_pct", round(100 * (tx - prev[0]) / (now - prev[2]), 3))
                    self.hist.add("self", "rx_air_pct", round(100 * (rx - prev[1]) / (now - prev[2]), 3))
                self.air_prev = (tx, rx, now)
        elif t == 2 and len(f) >= 30:
            v = struct.unpack_from("<7I", f, 2)
            self.node_stats.update(dict(zip(("recv", "sent", "sent_flood", "sent_direct", "recv_flood", "recv_direct", "recv_errors"), v)))

    async def poll_stats(self):
        for t in (0, 1, 2):
            f = await self.cmd(bytes([self.CMD_GET_STATS, t]), {self.R_STATS})
            if f[0] == self.R_STATS:
                self.on_stats(f)
        self.node_stats["at"] = int(time.time())

    def stats_snapshot(self, reset: bool = False) -> dict:
        """Flat numbers for MQTT/Telegraf, plus the stations heard this interval (farthest first)."""
        now = time.time(); net = self.net; secs = max(1.0, now - net["t0"])
        avg = lambda x: round(sum(x) / len(x), 2) if x else None
        out = {"interval_s": round(secs, 1), "packets": net["packets"], "packets_per_min": round(net["packets"] * 60 / secs, 2),
               "bytes": net["bytes"], "flood": net["flood"], "direct": net["direct"], "rx_total": self.rx_total,
               "snr_avg": avg(net["snr"]), "snr_min": min(net["snr"]) if net["snr"] else None, "snr_max": max(net["snr"]) if net["snr"] else None,
               "rssi_avg": avg(net["rssi"]), "rssi_min": min(net["rssi"]) if net["rssi"] else None, "rssi_max": max(net["rssi"]) if net["rssi"] else None,
               "senders": len(net["senders"]), "repeaters_heard": len(net["last_hops"]), "heard_direct": len(net["direct_from"]),
               "hops_0": net["hops"][0], "hops_1": net["hops"][1], "hops_2": net["hops"][2], "hops_3": net["hops"][3], "hops_4plus": net["hops"][4],
               "kelly_attached": 1 if self.kelly_on() else 0, "node_up": 1 if self.mesh.up else 0, "node_answering": 0 if self.stale_for() else 1, "node_resets": self.resets, "contacts": len(self.contacts),
               "contacts_with_pos": sum(1 for c in self.contacts.values() if c.get("lat") is not None)}
        for k, v in net["types"].items():
            out[f"type_{k}"] = v
        heard = [st for st in self.stations.values() if now - st.get("last", 0) < secs + 1]
        out["adv_km_max"] = max((st["km"] for st in heard if st.get("km") is not None), default=None)
        # the last 24 h: adverts this bridge heard itself, plus contacts the node says it heard (lastmod) -- so the counts
        # mean something straight after a bridge restart
        dayd = {k: st for k, st in self.stations.items() if now - st.get("last", 0) < 86400}
        for k, c in self.contacts.items():
            if k not in dayd and c.get("lastmod") and 0 <= now - c["lastmod"] + 600 and now - c["lastmod"] < 86400:
                km = round(self._km(self.self_pos, (c["lat"], c["lon"])), 2) if self.self_pos and c.get("lat") is not None else None
                dayd[k] = {"name": c.get("name") or k, "type": self.NODE_TYPE.get(c.get("type"), "node"), "km": km, "hops": c.get("hops")}
        day = list(dayd.values())
        out["stations_24h"] = len(day); out["repeaters_24h"] = sum(1 for st in day if st.get("type") == "repeater")
        out["stations_far_24h"] = sum(1 for st in day if (st.get("km") or 0) >= 20)
        far = max((st for st in day if st.get("km") is not None), key=lambda st: st["km"], default=None)
        out["farthest_24h_km"] = far["km"] if far else None
        out["farthest_24h_name"] = far["name"] if far else ""
        if self.node_stats and now - self.node_stats.get("at", 0) < 600:
            out.update({k: v for k, v in self.node_stats.items() if k != "at"})
        out = {k: v for k, v in out.items() if v is not None}
        # every station heard in 24 h, each minute (Grafana's table takes the latest per station); n = adverts this minute
        stations = sorted(({"key": k, **{x: st.get(x) for x in ("name", "type", "km", "hops", "snr", "rssi")},
                            "n": st.get("n", 0) if now - st.get("last", 0) < secs + 1 else 0} for k, st in dayd.items()), key=lambda x: -(x["km"] or 0))[:60]
        stations = [{k: v for k, v in x.items() if v is not None} for x in stations]
        if reset:
            self.net = self._fresh()
            for st in self.stations.values():
                st["n"] = 0
            for k in [k for k, st in self.stations.items() if now - st.get("last", 0) > 7 * 86400]:
                del self.stations[k]
        return {"stats": out, "stations": stations, "at": int(now * 1000)}

    # ---- frames from the node
    def feed(self, data: bytes):
        self.buf += data
        while True:
            i = self.buf.find(b">")
            if i < 0:
                self.buf.clear(); return
            del self.buf[:i]
            if len(self.buf) < 3:
                return
            n = self.buf[1] | self.buf[2] << 8
            if not n or n > 176:
                del self.buf[:1]; continue
            if len(self.buf) < 3 + n:
                return
            f = bytes(self.buf[3:3 + n]); del self.buf[:3 + n]
            try:
                self.on_frame(f)
            except Exception as e:                     # noqa: BLE001 -- a bad frame never stops the bridge
                print(f"[bridge] meshcore frame error: {e}", flush=True)

    TEXTS_MAX = 500
    TEXTS_SAVE_GAP_S = 5

    @staticmethod
    def text_id(m: dict) -> str:
        """A text's id, the same however often it's seen: sender | text | DM partner or channel | minute -> 12 hex."""
        where = (m.get("prefix") or m.get("to") or "") if m.get("dm") else f"c{m.get('ch')}"
        return hashlib.sha1(f"{m.get('sender', '')}|{m.get('text', '')}|{where}|{int(m.get('at', 0)) // 60000}".encode("utf-8")).hexdigest()[:12]

    def add_text(self, m: dict) -> bool:
        m.setdefault("at", int(time.time() * 1000))
        m["id"] = self.text_id(m)
        if any(x.get("id") == m["id"] for x in self.texts[-60:]):
            return False
        self.texts = (self.texts + [m])[-self.TEXTS_MAX:]
        self._save_texts_soon()
        return True

    def _load_texts(self) -> list[dict]:
        if not self.texts_path:
            return []
        try:
            got = json.loads(self.texts_path.read_text(encoding="utf-8"))
            got = [t for t in got if isinstance(t, dict) and "text" in t and "at" in t][-self.TEXTS_MAX:]
            for t in got:
                t.setdefault("id", self.text_id(t))
            return got
        except (OSError, ValueError):
            return []

    def _save_texts_soon(self):
        """Write the texts at most every TEXTS_SAVE_GAP_S (a busy channel doesn't rewrite the file on every message)."""
        wait = self.TEXTS_SAVE_GAP_S - (time.time() - self._texts_saved_at)
        if wait <= 0:
            self.save_texts()
        elif not self._texts_save_pending:
            with contextlib.suppress(RuntimeError):   # no running loop (a test): the next text saves it
                asyncio.get_running_loop().call_later(wait, self.save_texts)
                self._texts_save_pending = True

    def save_texts(self):
        self._texts_save_pending, self._texts_saved_at = False, time.time()
        if not self.texts_path:
            return
        try:
            tmp = self.texts_path.with_name(self.texts_path.name + ".tmp")
            tmp.write_text(json.dumps(self.texts), encoding="utf-8")
            with contextlib.suppress(OSError):
                os.chmod(tmp, 0o600)              # people's messages: this user only
            os.replace(tmp, self.texts_path)
        except OSError as e:
            print(f"[bridge] meshcore: can't keep the texts in {self.texts_path}: {e}", flush=True)

    def note_sent(self, data: bytes):
        if data[:1] == b"<" and self.unanswered_since is None:
            self.unanswered_since = time.time()
        i = 0   # texts going to the node (a Kelly's on /mesh, or ours): kept as sent, "out"
        while i + 3 <= len(data) and data[i] == 0x3C:
            n = struct.unpack_from("<H", data, i + 1)[0]
            if i + 3 + n > len(data):
                break
            self.note_sent_text(bytes(data[i + 3:i + 3 + n]))
            i += 3 + n
        if self.hist and data[:1] == b"<" and len(data) >= 16 and data[3] == self.CMD_SEND_TXT:   # a DM (ours or a Kelly's)
            self.dm_out = (self.dm_out + [data[10:16].hex()])[-8:]

    def note_sent_text(self, p: bytes):
        """SEND_TXT_MSG [2][type 0][attempt][ts u32][key 6][text] / SEND_CHANNEL_TXT_MSG [3][0][ch][ts u32][text] ->
        an "out" text (a DM's retries carry the same ts: one text). CLI commands (type 1) aren't messages."""
        dm = p[:1] == bytes([self.CMD_SEND_TXT]) and len(p) > 13 and p[1] == 0
        if not (dm or (p[:1] == bytes([self.CMD_SEND_CHAN]) and len(p) > 7 and p[1] == 0)):
            return
        ts = struct.unpack_from("<I", p, 3)[0]
        at = ts * 1000 if ts > self.CLOCK_OK else int(time.time() * 1000)
        m = {"sender": self.self_name or "P25X", "at": at, "out": True, "mine": True}
        if dm:
            key = p[7:13].hex()
            m.update(dm=True, ch=None, to=key, toName=self.contacts.get(key, {}).get("name") or key, text=p[13:].decode("utf-8", "replace"))
        else:
            m.update(dm=False, ch=p[2], chName=self.channels.get(p[2], "Public" if p[2] == 0 else f"Ch {p[2]}"), text=p[7:].decode("utf-8", "replace"))
        self.add_text(m)

    DM_WAIT_S = 60

    def on_repeater_status(self, f: bytes):
        """A repeater's status answer passing through (Kelly's Repeater management, Phase 2) -> its history, so its battery
        and load have trends without asking it anything more over the air (Phase 4). RepeaterStats from byte 8, as
        js/meshcore.js parseRepeaterStats: batt mV, tx queue, noise, rssi, recv, sent, tx air s, uptime s, sent flood /
        direct, recv flood / direct, errors, snr*4, dup direct / flood, rx air s."""
        key = f[2:8].hex(); b = f[8:]
        mv, queue, noise = struct.unpack_from("<HHh", b, 0)
        tx_air, uptime = struct.unpack_from("<II", b, 16)
        recv_flood = struct.unpack_from("<I", b, 32)[0]
        dup_flood = struct.unpack_from("<H", b, 46)[0]
        rx_air = struct.unpack_from("<I", b, 48)[0]
        h = self.hist
        h.add(key, "batt_v", mv / 1000 if mv else None); h.add(key, "noise_floor", noise); h.add(key, "queue", queue)
        h.add(key, "uptime_h", round(uptime / 3600, 2))
        p = self.rpt_prev.get(key)
        if p and uptime > p["uptime"] and tx_air >= p["tx"] and rx_air >= p["rx"]:          # same boot: rates since last time
            dt = uptime - p["uptime"]
            h.add(key, "tx_air_pct", round(100 * (tx_air - p["tx"]) / dt, 3)); h.add(key, "rx_air_pct", round(100 * (rx_air - p["rx"]) / dt, 3))
            if recv_flood > p["recv_flood"] and dup_flood >= p["dup"]:
                h.add(key, "dup_pct", round(100 * (dup_flood - p["dup"]) / (recv_flood - p["recv_flood"]), 2))
        self.rpt_prev[key] = {"uptime": uptime, "tx": tx_air, "rx": rx_air, "recv_flood": recv_flood, "dup": dup_flood}
        ct = self.contacts.get(key, {})
        h.source(key, name=ct.get("name"), type="repeater", lat=ct.get("lat"), lon=ct.get("lon"))

    def dm_result(self, dest: str, ok: bool, rtt=None):
        self.hist.add("self", "dm_ok", 1 if ok else 0); self.hist.add(dest, "dm_ok", 1 if ok else 0)
        if ok and rtt is not None:
            self.hist.add("self", "dm_rtt_ms", rtt); self.hist.add(dest, "dm_rtt_ms", rtt)

    def history_sample(self, now: float | None = None):
        """Once a minute: the minute's counts, the node's state, DMs that never got a receipt -- then write it."""
        h, now = self.hist, now or time.time()
        for k, v in self.hmin.items():
            h.add("self", k, v)
        self.hmin = self._hfresh()
        h.add("self", "node_up", 1 if self.mesh.up else 0)
        h.add("self", "node_answering", 0 if self.stale_for() else 1)
        h.add("self", "kelly_attached", 1 if self.kelly_on() else 0)
        h.add("self", "contacts", len(self.contacts))
        # one outcome per MESSAGE, not per attempt: Kelly retries a DM up to 3 times (route, route, flood), each with its own
        # ACK tag -- an attempt with a newer one to the same station pending isn't a failure, the retry speaks for it
        for tag, (dest, at) in list(self.dm_tags.items()):
            if now - at > self.DM_WAIT_S:
                del self.dm_tags[tag]
                if not any(d == dest and a > at for d, a in self.dm_tags.values()):
                    self.dm_result(dest, False)
        h.flush(now)
        self.check_warnings(now)

    # Threshold warnings (Phase 4e), checked each minute on the history: id -> (metric, window s, fewest samples, raise
    # when the window's average is past `on`, clear once back past `off` -- the gap stops it flapping), and the words.
    # "above" warnings raise when avg > on and clear when avg < off; "below" ones the other way round.
    WARN = {
        "battery": ("batt_v", 600, 3, "below", 3.55, 3.70, "battery low ({v:.2f} V)"),
        "busy": ("rx_air_pct", 900, 10, "above", 25.0, 15.0, "channel busy -- the node hears traffic {v:.0f} % of the time (15 min)"),
        "tx": ("tx_air_pct", 900, 10, "above", 10.0, 5.0, "transmitting {v:.1f} % of the time (15 min)"),
        "noise": ("noise_floor", 900, 10, "above", -95.0, -100.0, "noisy site -- noise floor {v:.0f} dBm (15 min)"),
        "dm": ("dm_ok", 3600, 4, "below", 0.5, 0.7, "DMs failing -- {v:.0%} delivered in the last hour"),
    }

    def check_warnings(self, now: float):
        for wid, (m, win, least, way, on, off, words) in self.WARN.items():
            pts = self.hist.query("self", [m], now - win, now, 60)["series"][m]
            n = sum(p[4] for p in pts)
            if n < least:
                continue                                           # too little to judge: leave it as it was
            v = sum(p[1] * p[4] for p in pts) / n
            bad = v < on if way == "below" else v > on
            good = v > off if way == "below" else v < off
            if bad and wid not in self.warnings:
                self.warnings[wid] = {"text": words.format(v=v), "since": int(now * 1000), "value": round(v, 3)}
                print(f"[bridge] meshcore warning: {self.warnings[wid]['text']}", flush=True)
            elif wid in self.warnings:
                if good:
                    print(f"[bridge] meshcore warning cleared: {self.warnings.pop(wid)['text']}", flush=True)
                else:
                    self.warnings[wid].update(text=words.format(v=v), value=round(v, 3))
        self.check_repeaters(now)

    # Repeaters (from their status answers -- on_repeater_status): one warning per kind naming every repeater past it.
    # Judged on each repeater's readings over RPT_WIN_S (status is only read now and then), same raise / clear gap.
    RPT_WARN = {"rptbatt": ("batt_v", "below", 3.55, 3.70, "repeater battery low: {list}", "{name} {v:.2f} V"),
                "rptbusy": ("rx_air_pct", "above", 25.0, 15.0, "repeater congested: {list}", "{name} hears traffic {v:.0f} % of the time")}
    RPT_WIN_S = 6 * 3600

    def check_repeaters(self, now: float):
        rpts = self.hist.db.execute("SELECT src, name FROM sources WHERE type = 'repeater' AND last >= ?", (now - self.RPT_WIN_S,)).fetchall()
        for wid, (m, way, on, off, words, each) in self.RPT_WARN.items():
            was = (self.warnings.get(wid) or {}).get("keys", [])
            bad = []
            for src, name in rpts:
                pts = self.hist.query(src, [m], now - self.RPT_WIN_S, now, 60)["series"][m]
                n = sum(p[4] for p in pts)
                if not n:
                    continue
                v = sum(p[1] * p[4] for p in pts) / n
                past_on = v < on if way == "below" else v > on
                past_off = v < off if way == "below" else v > off          # not yet back past the clear threshold
                if past_on or (src in was and past_off):
                    bad.append((src, each.format(name=name or src, v=v)))
            if bad:
                w = {"text": words.format(list="; ".join(b[1] for b in bad)), "keys": [b[0] for b in bad]}
                if wid not in self.warnings:
                    w["since"] = int(now * 1000)
                    print(f"[bridge] meshcore warning: {w['text']}", flush=True)
                self.warnings[wid] = {**self.warnings.get(wid, {}), **w}
            elif wid in self.warnings:
                print(f"[bridge] meshcore warning cleared: {self.warnings.pop(wid)['text']}", flush=True)

    # ---- the history's backlog to the P25X gateway (Phase 4b, --mesh-history-upload URL): every 5 min, the rows it
    # hasn't had yet (kelly_mesh_history.pending), as JSON to the gateway's /api/mesh-history-ingest, which puts them on
    # MQTT p25x/mesh/site/<site>/history -> InfluxDB with their own timestamps. A failed post keeps the watermark, so an
    # outage (this bridge's link, the NUC, the broker) is caught up afterwards, a full batch at a time.
    UPLOAD_EVERY_S = 300

    def upload_once(self, now: float | None = None) -> dict:
        """One batch, blocking (run in a thread). {sent, upto, more} or {error}."""
        url = getattr(self.mesh.args, "mesh_history_upload", "")
        rows, upto = self.hist.pending(now)
        if not rows:
            return {"sent": 0}
        site = (getattr(self.mesh.args, "mesh_history_site", "") or socket.gethostname()).lower()
        body = json.dumps({"site": site, "self": self.self_name, "rows": rows, "names": self.hist.names(r[2] for r in rows)}).encode()
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                ok = 200 <= r.status < 300
        except Exception as e:                         # noqa: BLE001 -- the gateway away: try again next time
            return {"error": str(e)}
        if not ok:
            return {"error": "the gateway refused it"}
        self.hist.meta("uploaded", upto)
        return {"sent": len(rows), "upto": upto, "more": len(rows) >= self.hist.UPLOAD_BATCH}

    async def upload_loop(self):
        await asyncio.sleep(60)
        failing = False
        while True:
            try:
                r = await asyncio.to_thread(self.upload_once)
            except Exception as e:                     # noqa: BLE001
                r = {"error": str(e)}
            if r.get("error"):
                if not failing:
                    print(f"[bridge] mesh history upload: {r['error']} -- will try again", flush=True)
                failing = True
            else:
                if failing or r.get("more"):
                    print(f"[bridge] mesh history upload: sent {r['sent']} rows" + (" (catching up)" if r.get("more") else ""), flush=True)
                failing = False
                if r.get("more"):
                    await asyncio.sleep(2); continue
            await asyncio.sleep(self.UPLOAD_EVERY_S)

    async def history_loop(self):
        while True:
            await asyncio.sleep(60 - time.time() % 60 + 1)       # just after each minute starts
            try:
                self.history_sample()
            except Exception as e:                     # noqa: BLE001 -- a full disk never stops the bridge
                print(f"[bridge] mesh history: {e}", flush=True)

    def stale_for(self) -> float:
        """Seconds the oldest unanswered command has waited, once past STALE_S (else 0)."""
        waited = time.time() - self.unanswered_since if self.unanswered_since else 0.0
        return waited if waited > self.STALE_S else 0.0

    def state(self) -> str:
        return "down" if not self.mesh.up else "stale" if self.stale_for() else "ok"

    async def watch_answers(self):
        """Tell every attached Kelly the moment the node goes stale / comes back (checked every 5 s)."""
        while True:
            await asyncio.sleep(5)
            auto = getattr(self.mesh.args, "mesh_auto_reset", 0) or 0
            if auto and self.state() == "stale" and self.stale_for() >= auto * 60 and time.time() - self.reset_at >= self.RESET_GAP_S:
                await self.reset(f"stuck {self.stale_for() / 60:.0f} min")
            now = self.state()
            if now == self.node_state or (self.node_state == "reset" and now == "ok" and self.unanswered_since):
                continue   # just reset: "ok" only once it has really answered
            self.node_state = now
            print(f"[bridge] meshcore: {self.state_text()}", flush=True)
            await self.mesh.broadcast(json.dumps(self.state_msg()).encode(), opcode=0x1)

    async def reset(self, why: str) -> str:
        """Reboot the node (auto or POST /api/mesh-reset), then let it boot before anyone asks it anything."""
        err = await self.mesh.reset_node()
        self.reset_at = time.time()
        if err:
            print(f"[bridge] meshcore: couldn't restart the node ({why}): {err}", flush=True)
            return err
        self.resets += 1
        self.session_up = False                                   # a fresh APP_START etc. after the boot
        self.idle_since = time.time()                             # run() waits 10 s from here
        self.unanswered_since = time.time() + 40                  # unproven until it answers; stale again 60 s on if not
        self.node_state = "reset"
        print(f"[bridge] meshcore: restarted the node ({why}) -- reset #{self.resets}", flush=True)
        await self.mesh.broadcast(json.dumps({"bridge": f"the node was {why} -- the bridge restarted it", "target": self.mesh.target,
                                              "node": "reset", "why": why}).encode(), opcode=0x1)
        return ""

    def state_text(self) -> str:
        if self.node_state == "stale":
            return f"the node has stopped answering (since {time.strftime('%H:%M', time.localtime(self.unanswered_since))})"
        return "the node's port is closed (unplugged?)" if self.node_state == "down" else "the node is answering again"

    def state_msg(self) -> dict:
        return {"bridge": self.state_text(), "target": self.mesh.target, "node": self.state(),
                "since": int(self.unanswered_since * 1000) if self.unanswered_since and self.state() == "stale" else None}

    def on_frame(self, f: bytes):
        c = f[0]
        if c < 0x80:
            self.answered_at, self.unanswered_since = time.time(), None
        for codes, fut in list(self.waiters):
            if c in codes and not fut.done():
                fut.set_result(f); self.waiters.remove((codes, fut)); break
        if c in (self.R_CONTACT, self.P_NEW_ADVERT) and len(f) >= 132:
            key = f[1:33]
            name = f[100:132].split(b"\0")[0].decode("utf-8", "replace")
            ct = {"name": name, "type": f[33], "hops": None if f[35] == 0xFF else f[35] & 0x3F, "pk": key.hex(), "flags": f[34]}
            if len(f) >= 144:
                la, lo = struct.unpack_from("<ii", f, 136)
                if la or lo:
                    ct.update(lat=la / 1e6, lon=lo / 1e6)
            if len(f) >= 148:
                ct["lastmod"] = struct.unpack_from("<I", f, 144)[0]   # by the node's clock: when it last heard them
            self.contacts[key[:6].hex()] = ct
        elif c == self.R_SELF and len(f) >= 58:
            self.self_name = f[58:].split(b"\0")[0].decode("utf-8", "replace")
            self.manual_add = f[47]                # bit 0 set = auto-add off (only the GET_AUTOADD_CONFIG types are saved)
            fq, bw = struct.unpack_from("<II", f, 48)
            self.radio = {"freq_mhz": fq / 1000, "bw_khz": bw / 1000, "sf": f[56], "cr": f[57], "tx_dbm": struct.unpack_from("b", f, 2)[0]}
            la, lo = struct.unpack_from("<ii", f, 36)
            if la or lo:
                self.self_pos = (la / 1e6, lo / 1e6)
        elif c == self.P_LOG_RX and len(f) > 4:
            self.on_rx(f)
        elif c == self.R_STATS and len(f) > 2:
            self.on_stats(f)
        elif c == self.R_CHAN_INFO and len(f) >= 34:
            name = f[2:34].split(b"\0")[0].decode("utf-8", "replace")
            if name or f[1] == 0:   # an unused slot has no name
                self.channels[f[1]] = name or "Public"
        elif c in (self.R_CONTACT_MSG, self.R_CONTACT_MSG3, self.R_CHAN_MSG, self.R_CHAN_MSG3):
            self.on_msg(f)
        elif c == self.P_MSG_WAITING:
            self.sync_wanted.set()
        elif c == self.P_SEND_CONFIRMED and len(f) >= 9:
            fut = self.acks.get(bytes(f[1:5]))
            if fut and not fut.done():
                fut.set_result(struct.unpack_from("<I", f, 5)[0])
            if self.hist and bytes(f[1:5]) in self.dm_tags:
                dest = self.dm_tags.pop(bytes(f[1:5]))[0]
                for t in [t for t, (d, _) in self.dm_tags.items() if d == dest]:   # its other attempts: delivered now
                    del self.dm_tags[t]
                self.dm_result(dest, True, struct.unpack_from("<I", f, 5)[0])
        elif c == self.R_SENT and self.hist and self.dm_out and len(f) >= 6:
            self.dm_tags[bytes(f[2:6])] = (self.dm_out.pop(0), time.time())
        elif c == self.P_STATUS and len(f) >= 60 and self.hist:
            self.on_repeater_status(f)
        elif c == self.P_CONTACT_DELETED and len(f) >= 7:   # the node overwrote its oldest contact to make room
            self.contacts.pop(f[1:7].hex(), None)

    def on_msg(self, f: bytes):
        c = f[0]; v3 = c in (self.R_CONTACT_MSG3, self.R_CHAN_MSG3); o = 3 if v3 else 0
        snr = (struct.unpack_from("b", f, 1)[0] / 4) if v3 else None
        if c in (self.R_CONTACT_MSG, self.R_CONTACT_MSG3):
            prefix = f[o + 1:o + 7].hex(); typ = f[o + 8]
            if typ == 1:   # a repeater's CLI answer (ours: "time N" after a login; or a Kelly's CLI) -- not a message
                print(f"[bridge] meshcore: repeater {prefix} CLI: {f[o + 13:].decode('utf-8', 'replace').rstrip(chr(0))}", flush=True)
                return
            text = f[o + 13 + (4 if typ == 2 else 0):].decode("utf-8", "replace")
            ct = self.contacts.get(prefix, {})
            m = {"dm": True, "ch": None, "sender": ct.get("name") or prefix, "prefix": prefix, "text": text, "hops": None if f[o + 7] == 0xFF else f[o + 7] & 0x3F}
        else:
            ch = f[o + 1]; t = f[o + 8:].decode("utf-8", "replace"); i = t.find(": ")
            sender, text = (t[:i], t[i + 2:]) if 0 < i < 40 else ("", t)
            m = {"dm": False, "ch": ch, "chName": self.channels.get(ch, "Public" if ch == 0 else f"Ch {ch}"), "sender": sender, "text": text,
                 "hops": None if f[o + 2] == 0xFF else f[o + 2] & 0x3F}
            ct = next((x for x in self.contacts.values() if x.get("name") == sender), {})
        if ct.get("lat") is not None:
            m.update(lat=ct["lat"], lon=ct["lon"])
        m.update(at=int(time.time() * 1000), snr=snr)
        if any(x["text"] == m["text"] and x["sender"] == m["sender"] and m["at"] - x["at"] < 120000 for x in self.texts[-20:]):
            return   # the same message seen twice (Kelly's sync + ours)
        self.add_text(m)

    # ---- our own session, only while no Kelly is attached
    def kelly_on(self) -> bool:
        return bool(self.mesh.clients)

    async def cmd(self, payload: bytes, expect: set, timeout: float = 6.0):
        if self.kelly_on() or not self.mesh.up:
            raise RuntimeError("a Kelly is using the node" if self.kelly_on() else "node not connected")
        fut = asyncio.get_running_loop().create_future()
        self.waiters.append((expect | {self.R_ERR}, fut))
        await self.mesh.write(b"<" + struct.pack("<H", len(payload)) + payload)
        try:
            f = await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self.waiters = [w for w in self.waiters if w[1] is not fut]
            raise RuntimeError("the node did not answer")
        if f[0] == self.R_ERR and self.R_ERR not in expect:
            raise RuntimeError(f"node error {f[1] if len(f) > 1 else '?'}")
        return f

    async def start_session(self):
        await self.cmd(bytes([self.CMD_DEVICE_QUERY, 3]), {self.R_DEVICE_INFO})
        await self.cmd(bytes([self.CMD_APP_START, 3, 0, 0, 0, 0, 0, 0]) + b"P25X", {self.R_SELF})
        await self.apply_autoadd()
        # The node's clock: a power-off restarts it at 15 May 2024 and every contact it then hears is stamped "890 days
        # ago". Set it from this machine (NTP) -- the node refuses to go backwards (node error 6), which is fine.
        try:
            await self.cmd(bytes([self.CMD_SET_TIME]) + struct.pack("<I", int(time.time())), {self.R_OK})
        except RuntimeError as e:
            if "Kelly" in str(e):
                raise
            print(f"[bridge] meshcore: node clock not set ({e}: it is ahead of this machine's)", flush=True)
        await self.cmd(bytes([self.CMD_GET_CONTACTS]), {self.R_END_CONTACTS}, 60)
        for i in range(8):
            try:
                await self.cmd(bytes([self.CMD_GET_CHANNEL, i]), {self.R_CHAN_INFO})
            except RuntimeError:
                break
        self.session_up = True
        print(f"[bridge] meshcore: gateway session up ({len(self.contacts)} contacts, {len(self.channels)} channels)", flush=True)

    # ---- auto-add rules (--mesh-autoadd, 2026-10-31). With the default (every advert heard is saved) a busy mesh fills the
    # 350-contact table in days, and a full table can't save a new station, so its DMs can't be read. This turns "save
    # everything" off and lets the node keep only the listed types, overwriting its oldest non-favourite when full -- the
    # firmware's own garbage collection. Checked at every session start, so a reflashed node gets it back.
    AUTOADD_BITS = {"overwrite": 0x01, "companion": 0x02, "repeater": 0x04, "room": 0x08, "sensor": 0x10}
    CMD_SET_OTHER_PARAMS, CMD_SET_AUTOADD, CMD_GET_AUTOADD, R_AUTOADD = 38, 58, 59, 25

    @classmethod
    def parse_autoadd(cls, spec: str):
        """'companion,repeater,overwrite[,hops=N]' -> (bits, max hops: 0 = any, 1 = direct only, N = up to N-1 hops)"""
        bits, hops = 0, 0
        for w in (x.strip().lower() for x in spec.split(",") if x.strip()):
            if w.startswith("hops="):
                hops = max(0, min(64, int(w[5:])))
            elif w in cls.AUTOADD_BITS:
                bits |= cls.AUTOADD_BITS[w]
            else:
                raise ValueError(f"--mesh-autoadd: unknown '{w}' (use {', '.join(cls.AUTOADD_BITS)}, hops=N)")
        return bits, hops

    async def apply_autoadd(self):
        spec = getattr(self.mesh.args, "mesh_autoadd", "") or ""
        if not spec or self.manual_add is None:
            return
        bits, hops = self.parse_autoadd(spec)
        try:
            f = await self.cmd(bytes([self.CMD_GET_AUTOADD]), {self.R_AUTOADD})
        except RuntimeError as e:
            if "Kelly" in str(e):
                raise
            print(f"[bridge] meshcore: auto-add rules not set ({e}: firmware before 1.18?)", flush=True)
            return
        if self.manual_add & 1 and len(f) >= 3 and f[1] == bits and f[2] == hops:
            return
        await self.cmd(bytes([self.CMD_SET_AUTOADD, bits, hops]), {self.R_OK})
        if not self.manual_add & 1:                # one byte: the telemetry settings stay as they are
            await self.cmd(bytes([self.CMD_SET_OTHER_PARAMS, self.manual_add | 1]), {self.R_OK})
            self.manual_add |= 1
        print(f"[bridge] meshcore: auto-add rules set -- {spec}", flush=True)

    async def sync(self):
        for _ in range(100):
            f = await self.cmd(bytes([self.CMD_SYNC]), {self.R_NO_MORE, self.R_CONTACT_MSG, self.R_CONTACT_MSG3, self.R_CHAN_MSG, self.R_CHAN_MSG3, self.R_CHAN_DATA})
            if f[0] == self.R_NO_MORE:
                return

    async def run(self):
        while True:
            try:
                await asyncio.wait_for(self.sync_wanted.wait(), 5 if self.outbox_count() else 30)   # quicker while messages wait
            except asyncio.TimeoutError:
                pass
            self.sync_wanted.clear()
            if self.kelly_on():
                self.session_up = False; self.idle_since = time.time(); continue
            if not self.mesh.up or time.time() - self.idle_since < 10:   # let a Kelly that just left settle
                continue
            async with self.lock:
                try:
                    if not self.session_up:
                        await self.start_session()
                    await self.sync()
                    if time.time() - self.stats_at >= 55:      # the node's own counters, once a minute
                        self.stats_at = time.time()
                        await self.poll_stats()
                    if self.prune_due():
                        await self.prune()
                    if self.rpt_due():
                        await self.poll_repeater()
                except RuntimeError as e:
                    self.session_up = False
                    if "Kelly" not in str(e):
                        print(f"[bridge] meshcore: {e}", flush=True)
            if self.session_up and self.outbox_count():
                await self.outbox_flush()

    # ---- own repeater's status on a timer (--mesh-rpt PREFIX --mesh-rpt-poll MIN, 2026-10-23: the owner chose every 15 min for
    # his solar veranda repeater). A repeater only answers a status request from a client it has logged in (its ACL), so
    # the bridge logs in first -- password from the environment, KELLY_MESH_RPT_PASS (/etc/kelly-bridge.env), never on
    # the command line -- and again every RPT_RELOGIN_S or after a status goes unanswered (a reboot empties its ACL).
    # The answer (PUSH 0x87) is stored by on_frame -> on_repeater_status like a Kelly's own. One login + one status
    # request ~1-2 s of airtime. Only while no Kelly is attached, as everything the bridge does to the node.
    CMD_SEND_LOGIN, CMD_SEND_STATUS_REQ, P_LOGIN_OK = 26, 27, 0x85
    RPT_RELOGIN_S, RPT_WAIT_S = 6 * 3600, 25

    def rpt_due(self) -> bool:
        mins = getattr(self.mesh.args, "mesh_rpt_poll", 0) or 0
        return bool(mins and getattr(self.mesh.args, "mesh_rpt", "") and time.time() - self.rpt_poll_at >= mins * 60)

    async def wait_push(self, code: int, send: bytes, expect: set, timeout: float) -> bytes:
        fut = asyncio.get_running_loop().create_future()
        self.waiters.append(({code}, fut))            # armed BEFORE the request goes out
        try:
            await self.cmd(send, expect)
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError("no answer over the air")
        finally:
            self.waiters = [w for w in self.waiters if w[1] is not fut]

    async def poll_repeater(self) -> dict:
        self.rpt_poll_at = time.time()
        prefix = self.mesh.args.mesh_rpt.lower()
        ct = next((c for c in self.contacts.values() if c.get("pk", "").startswith(prefix)), None)
        if not ct:
            self.rpt_last = {"at": int(time.time() * 1000), "error": f"repeater {prefix} isn't in the node's contacts"}
            print(f"[bridge] meshcore: repeater poll -- {self.rpt_last['error']}", flush=True)
            return self.rpt_last
        key, name = bytes.fromhex(ct["pk"]), ct.get("name") or prefix
        try:
            if time.time() - self.rpt_login_at > self.RPT_RELOGIN_S:
                pw = os.environ.get("KELLY_MESH_RPT_PASS", "").encode()[:15]
                lf = await self.wait_push(self.P_LOGIN_OK, bytes([self.CMD_SEND_LOGIN]) + key + pw, {self.R_SENT}, self.RPT_WAIT_S)
                self.rpt_login_at = time.time()
                print(f"[bridge] meshcore: logged in to repeater {name}", flush=True)
                # its clock (login reply [8:12]; fw >= 1.18) restarts at May 2024 after a power-off: set it when it's slow,
                # by its CLI as an admin ("time N"; it refuses to go backwards). Its answer is logged by on_msg.
                rc = struct.unpack_from("<I", lf, 8)[0] if len(lf) >= 12 else None
                if rc is not None and rc < time.time() - 120:
                    now = int(time.time())
                    await self.cmd(bytes([self.CMD_SEND_TXT, 1, 0]) + struct.pack("<I", now) + key[:6] + f"time {now}".encode(), {self.R_SENT})
                    print(f"[bridge] meshcore: repeater {name}'s clock was "
                          f"{'not set' if rc < self.CLOCK_OK else f'{(now - rc) // 60} min slow'}: setting it", flush=True)
            f = await self.wait_push(self.P_STATUS, bytes([self.CMD_SEND_STATUS_REQ]) + key, {self.R_SENT}, self.RPT_WAIT_S)
            mv = struct.unpack_from("<H", f, 8)[0] if len(f) >= 10 else 0
            self.rpt_last = {"at": int(time.time() * 1000), "name": name, "batt_v": mv / 1000 if mv else None}
        except RuntimeError as e:
            if "Kelly" in str(e):
                raise
            self.rpt_login_at = 0.0                      # log in again next time (it may have rebooted)
            self.rpt_last = {"at": int(time.time() * 1000), "name": name, "error": str(e)}
            print(f"[bridge] meshcore: repeater poll {name}: {e}", flush=True)
        return self.rpt_last

    # ---- stale contact cleanup (--mesh-prune-days N, 2026-10-21). A companion's contact table is capped (350 on the club
    # Heltec, which hit it: a new station's key couldn't be saved, so its DMs couldn't be read). Daily, and again if the
    # table passes PRUNE_HIGH: remove companions / rooms / sensors not heard for N days and repeaters for 2N (they're the
    # routes), oldest first, at most PRUNE_MAX a run. Never a favourite (flags bit 0) or a contact with no last-heard time.
    # Ages are by the NODE's clock (GET_DEVICE_TIME) against its own lastmod, so a wrong PC clock can't empty the table;
    # a node whose clock was never set (before 2024) is skipped. Only while no Kelly is attached (one app at a time).
    PRUNE_EVERY_S, PRUNE_HIGH, PRUNE_MAX = 86400, 330, 150

    def prune_due(self) -> bool:
        days = getattr(self.mesh.args, "mesh_prune_days", 0) or 0
        since = time.time() - self.prune_at
        return bool(days) and (since >= self.PRUNE_EVERY_S or (len(self.contacts) >= self.PRUNE_HIGH and since >= 3600))

    async def prune(self) -> dict:
        days = getattr(self.mesh.args, "mesh_prune_days", 0) or 0
        self.prune_at = time.time()
        f = await self.cmd(bytes([self.CMD_GET_TIME]), {self.R_CURR_TIME})
        node_now = struct.unpack_from("<I", f, 1)[0] if len(f) >= 5 else 0
        if node_now < 1_704_067_200:                               # 1 Jan 2024: the clock was never set
            self.prune_last = {"at": int(time.time() * 1000), "skipped": "the node's clock isn't set"}
            print("[bridge] meshcore: contact cleanup skipped -- the node's clock isn't set", flush=True)
            return self.prune_last
        await self.cmd(bytes([self.CMD_GET_CONTACTS]), {self.R_END_CONTACTS}, 60)   # fresh last-heard times
        stale = []
        for prefix, ct in self.contacts.items():
            lm = ct.get("lastmod") or 0
            if not lm or not ct.get("pk") or ct.get("flags", 0) & 1:
                continue
            if node_now - lm > days * 86400 * (2 if ct.get("type") == 2 else 1):
                stale.append((lm, prefix, ct))
        stale.sort(key=lambda x: x[0])
        removed = []
        for lm, prefix, ct in stale[:self.PRUNE_MAX]:
            try:
                await self.cmd(bytes([self.CMD_REMOVE_CONTACT]) + bytes.fromhex(ct["pk"]), {self.R_OK})
            except RuntimeError as e:
                if "node error 2" in str(e):                       # not on the node (an advert it only announced)
                    self.contacts.pop(prefix, None); continue
                print(f"[bridge] meshcore: contact cleanup stopped: {e}", flush=True)
                break
            self.contacts.pop(prefix, None)
            removed.append(ct.get("name") or prefix)
            await asyncio.sleep(0.1)
        self.prune_last = {"at": int(time.time() * 1000), "days": days, "removed": len(removed), "names": removed[:20],
                           "stale_left": max(0, len(stale) - len(removed)), "table": len(self.contacts)}
        print(f"[bridge] meshcore: contact cleanup -- removed {len(removed)} not heard for {days}+ days "
              f"(repeaters {2 * days}+), {len(self.contacts)} left", flush=True)
        return self.prune_last

    async def send_channel(self, ch: int, text: str):
        async with self.lock:
            if not self.session_up:
                await self.start_session()
            body = self.fit(text)
            await self.cmd(bytes([self.CMD_SEND_CHAN, 0, ch & 0xFF]) + struct.pack("<I", int(time.time())) + body, {self.R_OK})
            # kept in self.texts by note_sent (out / mine), as a Kelly's sends are

    @classmethod
    def fit(cls, text: str) -> bytes:
        """UTF-8, cut to MAX_TEXT bytes on a character boundary (a cut mid-character garbles the end on every screen)."""
        return text.encode("utf-8")[:cls.MAX_TEXT].decode("utf-8", "ignore").encode("utf-8")

    async def send_dm(self, prefix: str, text: str, wait_s: float = 10.0) -> dict:
        """A DM to the contact whose key starts with prefix (12 hex digits, as in /api/mesh-texts' contacts). Waits up
        to wait_s for its delivery receipt (PUSH SEND_CONFIRMED): {delivered, rtt (ms), flood}."""
        key = bytes.fromhex(prefix)[:6] if len(prefix) >= 12 else b""
        if len(key) != 6:
            raise RuntimeError("need the contact's key (12 hex digits)")
        async with self.lock:
            if not self.session_up:
                await self.start_session()
            f = await self.cmd(bytes([self.CMD_SEND_TXT, 0, 0]) + struct.pack("<I", int(time.time())) + key + self.fit(text), {self.R_SENT})
            ack = bytes(f[2:6]) if len(f) >= 10 else b"\0\0\0\0"
            fut = asyncio.get_running_loop().create_future()
            if ack != b"\0\0\0\0":
                self.acks[ack] = fut
        rtt = None
        try:
            if ack != b"\0\0\0\0":
                rtt = await asyncio.wait_for(fut, wait_s)
        except asyncio.TimeoutError:
            pass
        finally:
            self.acks.pop(ack, None)
        return {"delivered": rtt is not None, "rtt": rtt, "flood": bool(f[1])}

    # ---- outbound store-and-forward (Phase 2, 2026-10-21). A gateway send the node can't take right now -- the node is
    # down, or a Kelly is attached and owns it -- is kept in a small SQLite file (--mesh-outbox) and sent, oldest first and
    # 3 s apart, once the bridge has the node again. Survives a bridge restart. Each row expires (ttl, default 12 h:
    # a stale alert is worse than none) and the box holds at most OUTBOX_MAX rows (the oldest go first).
    OUTBOX_MAX, OUTBOX_TTL_S, OUTBOX_GAP_S = 200, 12 * 3600, 3.0

    def outbox(self) -> sqlite3.Connection:
        if self.db is None:
            self.outbox_path.parent.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(str(self.outbox_path))
            self.db.execute("CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, at REAL, expires REAL, ch INTEGER, dest TEXT, text TEXT, tries INTEGER DEFAULT 0, error TEXT)")
            self.db.commit()
        return self.db

    def outbox_add(self, ch: int | None, dest: str | None, text: str, why: str, ttl: float | None = None) -> int:
        db, now = self.outbox(), time.time()
        cur = db.execute("INSERT INTO outbox (at, expires, ch, dest, text, error) VALUES (?, ?, ?, ?, ?, ?)",
                         (now, now + (ttl if ttl and ttl > 0 else self.OUTBOX_TTL_S), ch, dest, text, why))
        db.execute("DELETE FROM outbox WHERE id NOT IN (SELECT id FROM outbox ORDER BY id DESC LIMIT ?)", (self.OUTBOX_MAX,))
        db.commit()
        print(f"[bridge] meshcore: queued for later ({why}): {'DM ' + dest if dest else 'ch ' + str(ch)}", flush=True)
        return cur.lastrowid

    def outbox_count(self) -> int:
        return self.outbox().execute("SELECT COUNT(*) FROM outbox").fetchone()[0] if (self.db or self.outbox_path.exists()) else 0

    async def outbox_flush(self):
        """Send what's waiting while the bridge has the node; stops at the first failure (the node went again)."""
        db = self.outbox()
        db.execute("DELETE FROM outbox WHERE expires < ?", (time.time(),)); db.commit()
        for rid, ch, dest, text in db.execute("SELECT id, ch, dest, text FROM outbox ORDER BY id").fetchall():
            if self.kelly_on() or not self.mesh.up:
                return
            try:
                if dest:
                    r = await self.send_dm(dest, text)
                    note = "delivered" if r["delivered"] else "sent, no receipt"
                else:
                    await self.send_channel(int(ch or 0), text)
                    note = "sent"
            except Exception as e:                     # noqa: BLE001
                db.execute("UPDATE outbox SET tries = tries + 1, error = ? WHERE id = ?", (str(e), rid)); db.commit()
                return
            db.execute("DELETE FROM outbox WHERE id = ?", (rid,)); db.commit()
            print(f"[bridge] meshcore: queued message {rid} {note}", flush=True)
            await asyncio.sleep(self.OUTBOX_GAP_S)

    def status(self, since: int = 0) -> dict:
        return {"session": "kelly" if self.kelly_on() else "gateway" if self.session_up else "off", "self": self.self_name, "outbox": self.outbox_count(),
                "channels": self.channels, "texts": [t for t in self.texts if t["at"] > since],
                "contacts": [dict(key=k, **v) for k, v in self.contacts.items() if v.get("lat") is not None or v.get("type") == 1]}


def ws_frame(payload: bytes, opcode: int = 0x2) -> bytes:
    n = len(payload)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack("!H", n)
    else:
        head += bytes([127]) + struct.pack("!Q", n)
    return head + payload


async def read_frame(reader: asyncio.StreamReader):
    b1, b2 = await reader.readexactly(2)
    opcode, masked, n = b1 & 0x0F, b2 & 0x80, b2 & 0x7F
    if n == 126:
        n = struct.unpack("!H", await reader.readexactly(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if masked else b"\0\0\0\0"
    data = bytearray(await reader.readexactly(n))
    for i in range(n):
        data[i] ^= mask[i % 4]
    return opcode, bytes(data)


# Hard build expiry -- the same date as js/license.js EXPIRES_ON (keep them in step). After it the
# bridge still serves the page (so a user can open Kelly and save their config) but opens no radio
# port and refuses the radio WebSocket.
EXPIRES_ON = datetime.date(2027, 4, 30)   # the last day this build works


def expired() -> bool:
    return not kelly_ent.public() and datetime.date.today() > EXPIRES_ON   # the public build has no expiry


KEEPER_STORE_MAX = 16 * 1024 * 1024      # Kelly's whole browser storage is ~5 MB at most
SHARE_STORE_MAX = 21 * 1024 * 1024       # one Kelly Share file (the gateway's limit is 5 MB by default, 20 MB max)


_HOST_CPU = [0, 0]   # (idle, total) jiffies at the last /api/host read: CPU % is the difference


def host_stats() -> dict:
    """This machine's health for Kelly's Station SCADA tab (GET /api/host): CPU %, CPU temperature, RAM, disk, uptime.
    Linux (/proc, /sys -- a Raspberry Pi); elsewhere only what the standard library can see. CPU % is since the last
    call, so the first call has none."""
    out: dict = {"host": socket.gethostname()}
    try:
        with open("/proc/stat", encoding="ascii") as f:
            v = [int(x) for x in f.readline().split()[1:]]
        idle, total = v[3] + (v[4] if len(v) > 4 else 0), sum(v)
        if _HOST_CPU[1] and total > _HOST_CPU[1]:
            out["cpuPct"] = round(100 * (1 - (idle - _HOST_CPU[0]) / (total - _HOST_CPU[1])), 1)
        _HOST_CPU[:] = [idle, total]
    except (OSError, ValueError, IndexError):
        pass
    try:
        out["cpuTempC"] = round(int(Path("/sys/class/thermal/thermal_zone0/temp").read_text().strip()) / 1000, 1)
    except (OSError, ValueError):
        pass
    try:
        mem = {ln.split(":")[0]: int(ln.split()[1]) for ln in Path("/proc/meminfo").read_text().splitlines() if ln.split()[1:2]}
        tot, avail = mem["MemTotal"], mem.get("MemAvailable", mem.get("MemFree", 0))
        out.update(memTotalMb=round(tot / 1024), memUsedMb=round((tot - avail) / 1024), memPct=round(100 * (tot - avail) / tot, 1))
    except (OSError, ValueError, KeyError, ZeroDivisionError):
        pass
    try:
        du = shutil.disk_usage("/")
        out["diskPct"] = round(100 * du.used / du.total, 1)
    except OSError:
        pass
    try:
        out["uptimeS"] = int(float(Path("/proc/uptime").read_text().split()[0]))
    except (OSError, ValueError, IndexError):
        pass
    return out


def is_loopback(peer) -> bool:
    return bool(peer) and str(peer[0]) in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


# ---- "Connect a phone": the addresses a phone on the same network (or the tailnet) can open this Kelly at.
# GET /api/connect and --connect-qr. Virtual interfaces (docker, bridges, veth) and link-local are left out.
_SKIP_IFACE = re.compile(r"^(lo|docker|br-|veth|virbr|cni|flannel|kube|vmnet|vboxnet)")


def _ipv4_interfaces() -> list[tuple[str, str]]:
    """(interface, IPv4) of this machine in a useful order: the default route's interfaces first (lowest metric),
    then the rest as the kernel lists them. Linux via `ip`; elsewhere the hostname's addresses, labelled 'LAN'."""
    try:
        out = subprocess.run(["ip", "-4", "-o", "addr", "show"], capture_output=True, text=True, timeout=3).stdout
        found = [(m.group(1), m.group(2)) for m in re.finditer(r"^\d+:\s+(\S+)\s+inet\s+([\d.]+)/", out, re.M)]
        routes = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True, timeout=3).stdout
        metric = lambda line: int((re.search(r"\bmetric (\d+)", line) or [0, 0])[1])
        devs = [re.search(r"\bdev (\S+)", ln).group(1) for ln in sorted(routes.splitlines(), key=metric) if " dev " in ln]
        return sorted(found, key=lambda f: devs.index(f[0]) if f[0] in devs else len(devs)) if found else []
    except (OSError, subprocess.SubprocessError):
        pass
    ips = []
    with contextlib.suppress(OSError):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:   # the address the default route leaves from (sends nothing)
            s.connect(("192.0.2.1", 9))
            ips.append(s.getsockname()[0])
    with contextlib.suppress(OSError):
        ips += [a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    return [("LAN", ip) for ip in dict.fromkeys(ips)]


def connect_urls(args, query: str = "", first: str = "") -> list[dict]:
    """[{url, label, kind: lan | mdns | tailscale, https}] for Kelly on this bridge -- LAN first (`first`, the address a
    request came in on, leads), then <hostname>.local, then Tailscale 100.x; https before http when TLS is on. The urls
    are base addresses (Kelly adds ?connect=ip&token= itself); `query` is added as is (--connect-qr's)."""
    tls = kelly_tls.on(args)
    ports = ([("https", args.tls_port or args.port)] if tls else []) + ([("http", args.port)] if not tls or args.tls_port else [])
    q = query
    lan, ts = [], []
    for iface, ip in _ipv4_interfaces():
        a = [int(x) for x in ip.split(".")]
        if a[0] == 127 or a[:2] == [169, 254] or (_SKIP_IFACE.match(iface) and not iface.startswith("tailscale")):
            continue
        (ts if a[0] == 100 and 64 <= a[1] < 128 or iface.startswith("tailscale") else lan).append((iface, ip))
    if first and any(ip == first for _, ip in lan):
        lan.sort(key=lambda f: f[1] != first)
    if args.bind not in ("0.0.0.0", "", "::"):   # listening on one address only
        lan, ts = [f for f in lan if f[1] == args.bind], [f for f in ts if f[1] == args.bind]
        hosts = [("lan", iface, ip) for iface, ip in lan] + [("tailscale", iface, ip) for iface, ip in ts]
    else:
        hosts = [("lan", iface, ip) for iface, ip in lan] + [("mdns", "mDNS", f"{socket.gethostname()}.local")] + \
                [("tailscale", "Tailscale", ip) for _, ip in ts]
    return [{"url": f"{scheme}://{host}:{port}/{q}", "label": label, "kind": kind, "https": scheme == "https"}
            for kind, label, host in hosts for scheme, port in ports]


def connect_info(args, peer, sock, query_token: str, origin: str = "") -> tuple[dict, bool]:
    """The /api/connect answer, and whether the caller is trusted with the token: it sent the right one, or it's this
    machine and not another web site (no Origin, a file:// page's "null", or a localhost page) -- the answer carries
    CORS, so without the Origin check any page open in a browser here could read the token."""
    host = urlparse(origin).hostname or "" if origin not in ("", "null") else ""
    local_page = origin in ("", "null") or host in ("localhost", "127.0.0.1", "::1")
    trusted = not args.token or query_token == args.token or (is_loopback(peer) and local_page)
    first = str(sock[0]) if sock and not is_loopback(sock) else ""
    tok = args.token if trusted else ""
    out = {"urls": connect_urls(args, "", first), "port": args.port,
           "tlsPort": (args.tls_port or args.port) if kelly_tls.on(args) else None, "hasToken": bool(args.token)}
    if tok:
        out["token"] = tok
    if args.bind in ("127.0.0.1", "localhost", "::1"):
        out["note"] = "the bridge listens on this computer only -- run it with --bind 0.0.0.0 to reach it from a phone"
    return out, trusted


def _service_settings(args) -> None:
    """--connect-qr from a shell: fill in what wasn't given on the command line from the installed service (its
    ExecStart, drop-ins included, and /etc/kelly-bridge.env or ~/kelly-address.txt for the token)."""
    given = {a.split("=")[0] for a in sys.argv[1:] if a.startswith("--")}
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        ex = subprocess.run(["systemctl", "show", "-p", "ExecStart", "--value", "kelly-bridge.service"],
                            capture_output=True, text=True, timeout=5).stdout
        m = re.search(r"argv\[\]=([^;]*)", ex)
        argv = m.group(1).split() if m else []
        for flag, dest, conv in (("--port", "port", int), ("--tls-port", "tls_port", int), ("--bind", "bind", str),
                                 ("--tls", "tls", str), ("--tls-cert", "tls_cert", str), ("--tls-key", "tls_key", str)):
            if flag not in given and flag in argv and argv.index(flag) + 1 < len(argv):
                setattr(args, dest, conv(argv[argv.index(flag) + 1]))
    if not args.token:
        for f, rx in (("/etc/kelly-bridge.env", r"^KELLY_BRIDGE_TOKEN=(\S+)"), (str(Path.home() / "kelly-address.txt"), r"[?&]token=([\w-]+)")):
            with contextlib.suppress(OSError):
                m = re.search(rx, Path(f).read_text(encoding="utf-8"), re.M)
                if m:
                    args.token = m.group(1)
                    break


def connect_qr(args) -> None:
    """kelly_bridge.py --connect-qr: the best address to open Kelly at from a phone, as a terminal QR code."""
    import kelly_qr
    _service_settings(args)
    urls = connect_urls(args, f"?connect=ip&token={urllib.parse.quote(args.token)}" if args.token else "")
    if not urls:
        print("No address a phone could reach: the bridge listens on this computer only (--bind 127.0.0.1).")
        return
    best = urls[0]
    print("Open Kelly on your phone: on the same WiFi, point the camera at this code.\n")
    print(kelly_qr.terminal(best["url"]))
    print(f"\n  {best['url']}   ({best['label']})")
    if best["https"] and getattr(args, "tls", None) == "self":
        print("  The certificate is self-signed: tap Advanced > Proceed once on the phone.")
    if args.bind in ("0.0.0.0", "", "::") and not args.token and Path("/etc/kelly-bridge.env").exists():
        print("  (couldn't read the bridge's token -- run this with sudo to put it in the code)")
    others = urls[1:]
    if others:
        print(f"\nOther addresses{' (add the ?token=... from the line above)' if args.token else ''}:")
        for u in others:
            print(f"  {u['url'].split('?')[0]}   ({u['label']})")


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, hub: Hub):
    try:
        head = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        writer.close()
        return
    lines = head.decode("latin-1").split("\r\n")
    try:
        method, target, _ = lines[0].split(" ", 2)
    except ValueError:
        writer.close()
        return
    headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
    url = urlparse(target)

    # ---- Kelly Share station store (js/share.js): files fetched or queued for the night, shared by every Kelly on this
    # bridge -- the Pi's keeper takes the radio overnight with its own browser storage, so what it fetches at 2 am lands
    # here for the PC's Kelly in the morning, and what the PC queues to send is here for the keeper to answer the pulls.
    # GET /api/share-store = list; GET/PUT/DELETE /api/share-store/<key>. This machine, or the /ws token.
    if (url.path == "/api/share-store" or url.path.startswith("/api/share-store/")) and kelly_ent.check("p25.gateway", "/api/share-store"):
        cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, PUT, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
        if method == "OPTIONS":
            writer.write(f"HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\n\r\n".encode()); await writer.drain(); writer.close(); return
        allowed = is_loopback(writer.get_extra_info("peername")) or not hub.args.token or parse_qs(url.query).get("token", [""])[0] == hub.args.token
        root = Path(hub.args.share_dir).expanduser()
        key = url.path[len("/api/share-store/"):] if url.path.startswith("/api/share-store/") else ""
        status, body, ctype = "200 OK", b"", "application/json"
        if not allowed:
            status = "403 Forbidden"
        elif key and not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,119}", key):
            status = "400 Bad Request"
        else:
            try:
                root.mkdir(parents=True, exist_ok=True)
                f = root / key if key else None
                if not key and method == "GET":
                    items = [{"key": x.name, "size": x.stat().st_size, "at": int(x.stat().st_mtime * 1000)} for x in sorted(root.iterdir()) if x.is_file() and not x.name.endswith(".tmp")]
                    body = json.dumps(items).encode()
                elif key and method == "GET":
                    if f.is_file():
                        body, ctype = f.read_bytes(), "application/octet-stream"
                    else:
                        status = "404 Not Found"
                elif key and method == "PUT":
                    n = int(headers.get("content-length", "0") or 0)
                    if not 0 < n <= SHARE_STORE_MAX:
                        status = "413 Payload Too Large"
                    else:
                        data = await reader.readexactly(n)
                        free = shutil.disk_usage(root).free
                        if free - n < 200 * 1024 * 1024:
                            status = "507 Insufficient Storage"
                        else:
                            tmp = root / (key + ".tmp"); tmp.write_bytes(data); os.replace(tmp, f)
                            status = "204 No Content"
                elif key and method == "DELETE":
                    f.unlink(missing_ok=True); status = "204 No Content"
                else:
                    status = "405 Method Not Allowed"
            except (OSError, ValueError, asyncio.IncompleteReadError) as e:
                print(f"[bridge] share store: {e}", flush=True); status = "500 Internal Server Error"
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\n{cors}Cache-Control: no-cache\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain(); writer.close(); return

    if url.path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
        if expired():
            writer.write(b"HTTP/1.1 410 Gone\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        if hub.args.token and parse_qs(url.query).get("token", [""])[0] != hub.args.token:
            # logged (never the token) so a browser still holding an old token shows up (2026-10-23)
            print(f"[bridge] refused {url.path} from {writer.get_extra_info('peername')}: wrong or no token", flush=True)
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        peer = writer.get_extra_info("peername")
        # --keeper-local: a Kelly on this machine (the Pi's headless one, bridge/kelly_keeper.py) keeps the
        # radio while nobody else is connected. Two Kellys on one radio would both answer the gateway, so it
        # stands down the moment anyone else attaches and is refused while they're here.
        keeper = hub.args.keeper_local and is_loopback(peer)
        if keeper and hub.clients - hub.keepers:
            writer.write(b"HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + WS_GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        await writer.drain()
        if keeper:
            hub.keepers.add(writer)
        else:
            for k in list(hub.keepers):
                print("[bridge] keeper standing down -- someone else is using the radio", flush=True)
                hub.handover = int(time.time() * 1000)   # its page posts its log as it closes (js/app.js)
                hub.keepers.discard(k); hub.clients.discard(k)
                try:
                    k.write(ws_frame(b"\x03\xe8", 0x8))
                    k.close()
                except (ConnectionError, RuntimeError):
                    pass
        hub.clients.add(writer)
        print(f"[bridge] {'keeper' if keeper else 'client'} {peer} attached ({len(hub.clients)} total)", flush=True)
        writer.write(ws_frame(json.dumps({"bridge": "attached" if hub.up else "attached (radio not up yet)",
                                          "target": hub.target}).encode(), 0x1))
        try:
            while True:
                opcode, data = await read_frame(reader)
                if opcode == 0x8:                                   # close
                    writer.write(ws_frame(b"", 0x8))
                    break
                if opcode == 0x9:                                   # ping
                    writer.write(ws_frame(data, 0xA))
                    continue
                if opcode in (0x1, 0x2) and data:
                    await hub.to_radio(data)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            hub.clients.discard(writer); hub.keepers.discard(writer)
            print(f"[bridge] {'keeper' if keeper else 'client'} {peer} left ({len(hub.clients)} total)", flush=True)
            writer.close()
        return

    # ---- BLE (kelly_ble.py): /ble = Kelly's BLE page (same token as /ws), /ble-node = a registered remote scanner
    # (its own token), /api/ble-nodes = the page's node list (add / rotate / revoke; this machine or the /ws token)
    if url.path in ("/ble", "/ble-node") and headers.get("upgrade", "").lower() == "websocket":
        page = url.path == "/ble"
        refuse = (b"410 Gone" if expired() else b"404 Not Found" if not hub.ble
                  else b"403 Forbidden" if page and hub.args.token and parse_qs(url.query).get("token", [""])[0] != hub.args.token else None)
        if not refuse and not page:
            hub.ble.reg.load()
            q = parse_qs(url.query)
            if not hub.ble.reg.check(q.get("node", [""])[0], q.get("token", [""])[0]):
                refuse = b"403 Forbidden"
        if refuse:
            writer.write(b"HTTP/1.1 " + refuse + b"\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + WS_GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        await writer.drain()
        if page:
            await hub.ble.page_session(reader, writer)
        else:
            await hub.ble.node_session(reader, writer, url.query)
        return
    if url.path == "/api/ble-nodes":
        allowed = is_loopback(writer.get_extra_info("peername")) or not hub.args.token or parse_qs(url.query).get("token", [""])[0] == hub.args.token
        if method == "OPTIONS":
            status, out = "204 No Content", None
        elif not allowed:
            status, out = "403 Forbidden", {"error": "token"}
        elif not hub.ble:
            status, out = "404 Not Found", {"error": "BLE is off on this bridge"}
        else:
            n = int(headers.get("content-length", "0") or 0)
            status, out = await hub.ble.api(method, await reader.readexactly(min(n, 4096)) if n else b"")
        body = json.dumps(out).encode() if out is not None else b""
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n"
                     f"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
                     f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- the LoRa node (--mesh-serial / --mesh-tcp) for Kelly's LoRa Mesh page; same token as /ws
    if url.path == "/mesh" and headers.get("upgrade", "").lower() == "websocket":
        mesh = hub.mesh
        refuse = (b"410 Gone" if expired() else b"403 Forbidden" if hub.args.token and parse_qs(url.query).get("token", [""])[0] != hub.args.token
                  else b"404 Not Found" if not mesh.target else None)
        if refuse:
            if refuse.startswith(b"403"):
                print(f"[bridge] refused {url.path} from {writer.get_extra_info('peername')}: wrong or no token", flush=True)
            writer.write(b"HTTP/1.1 " + refuse + b"\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + WS_GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        peer = writer.get_extra_info("peername")
        # --keeper-local: the Pi's headless Kelly stays on the node while a person's Kelly uses it too, so the APRS
        # iGate keeps gating (2026-11-01: a PC tab held the node for 7 h and gated almost nothing). Two Kellys
        # driving one node would both send (syncs, polls, adverts, rule replies), so while anyone else is attached the
        # keeper only LISTENS: told {"watch": true}, and anything it writes is dropped here. {"watch": false} when the
        # last of them leaves -- it then starts its session again and takes the node back.
        # The keeper = this machine AND ?keeper=1 (js/mesh.js meshWsUrl): other programs here (a member's telemetry
        # poller) are ordinary clients, so their commands go through and the keeper listens meanwhile.
        keeper = hub.args.keeper_local and is_loopback(peer) and parse_qs(url.query).get("keeper", [""])[0] == "1"
        watching = lambda: bool(mesh.clients - mesh.keepers)   # noqa: E731
        hello = {"bridge": "attached" if mesh.up else "attached (node not up yet)", "target": mesh.target}
        if mesh.mc and mesh.mc.state() != "ok":
            hello = {**mesh.mc.state_msg(), "bridge": f"attached, but {mesh.mc.state_text()}"}
        if keeper:
            hello["watch"] = watching()
        writer.write(ws_frame(json.dumps(hello).encode(), 0x1))
        await writer.drain()

        def tell_keepers(on: bool):
            msg = ws_frame(json.dumps({"watch": on, "bridge": "listening only -- another Kelly is using the node" if on
                                       else "the node is yours again"}).encode(), 0x1)
            for k in list(mesh.keepers):
                try:
                    k.write(msg)
                except (ConnectionError, RuntimeError):
                    pass
            if mesh.keepers:
                print(f"[bridge] mesh keeper {'listening only (the iGate keeps running)' if on else 'takes the node back'}", flush=True)
        if not keeper and not watching():
            tell_keepers(True)
        mesh.clients.add(writer)
        if keeper:
            mesh.keepers.add(writer)
        print(f"[bridge] mesh {'keeper' if keeper else 'client'} {peer} attached ({len(mesh.clients)} total)", flush=True)
        dropped = 0
        try:
            while True:
                opcode, data = await read_frame(reader)
                if opcode == 0x8:
                    writer.write(ws_frame(b"", 0x8))
                    break
                if opcode == 0x9:
                    writer.write(ws_frame(data, 0xA))
                    continue
                if opcode in (0x1, 0x2) and data and keeper and watching():
                    dropped += 1          # listening only: never reaches the node (the page shouldn't send; this makes sure)
                    if dropped in (1, 10, 100) or dropped % 1000 == 0:
                        print(f"[bridge] dropped {dropped} frame(s) from the listening mesh keeper", flush=True)
                    continue
                if opcode in (0x1, 0x2) and data:
                    if not await mesh.write(data):     # a private-key command: refused, and the client dropped
                        print(f"[bridge] refused a private-key command from mesh client {peer} -- dropped it", flush=True)
                        writer.write(ws_frame(json.dumps({"bridge": "refused: the bridge never passes on a node's private key"}).encode(), 0x1))
                        writer.write(ws_frame(b"", 0x8))
                        break
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            was = watching()
            mesh.clients.discard(writer); mesh.keepers.discard(writer)
            if was and not watching():
                tell_keepers(False)
            print(f"[bridge] mesh {'keeper' if keeper else 'client'} {peer} left ({len(mesh.clients)} total)", flush=True)
            writer.close()
        return

    # ---- LoRa Mesh history (--mesh-history): this machine, or the /ws token. ?sources=1 lists stations + metrics;
    # ?src=self&m=snr,rssi&from=MS&to=MS[&res=60|900|3600] returns the series (res picked to fit, if not given)
    if url.path == "/api/mesh-history":
        cors = "Access-Control-Allow-Origin: *\r\n"
        q = parse_qs(url.query)
        mc = hub.mesh.mc
        allowed = is_loopback(writer.get_extra_info("peername")) or not hub.args.token or q.get("token", [""])[0] == hub.args.token
        status, out = "200 OK", {}
        if not allowed:
            status, out = "403 Forbidden", {"error": "token"}
        elif not mc or not mc.hist:
            status, out = "404 Not Found", {"error": "no history (start the bridge with --mesh-gateway --mesh-history)"}
        else:
            try:
                if q.get("coverage", ["0"])[0] == "1":      # stations heard direct, with positions (Kelly's coverage layer)
                    now = time.time()
                    to = float(q.get("to", [0])[0] or 0) / 1000 or now
                    out = {"stations": mc.hist.coverage(float(q.get("from", [0])[0] or 0) / 1000 or to - 30 * 86400, to), "selfPos": mc.self_pos}
                elif q.get("sources", ["0"])[0] == "1":
                    out = {"sources": mc.hist.sources(), "self": mc.self_name, "selfPos": mc.self_pos, "warnings": mc.warnings}
                else:
                    now = time.time()
                    to = float(q.get("to", [0])[0] or 0) / 1000 or now
                    frm = float(q.get("from", [0])[0] or 0) / 1000 or to - 86400
                    res = int(q.get("res", [0])[0] or 0) or None
                    mets = [m for m in q.get("m", [""])[0].split(",") if re.fullmatch(r"[a-z0-9_]{1,32}", m)][:12]
                    out = mc.hist.query(q.get("src", ["self"])[0][:40], mets, frm, to, res)
            except (ValueError, sqlite3.Error) as e:
                status, out = "400 Bad Request", {"error": str(e)}
        body = json.dumps(out).encode()
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{cors}Cache-Control: no-cache\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- this machine's health (Kelly > LoRa Mesh > Station SCADA, live): this machine, or the /ws token
    if url.path == "/api/host":
        q = parse_qs(url.query)
        allowed = is_loopback(writer.get_extra_info("peername")) or not hub.args.token or q.get("token", [""])[0] == hub.args.token
        status, out = ("200 OK", host_stats()) if allowed else ("403 Forbidden", {"error": "token"})
        body = json.dumps(out).encode()
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- "Connect a phone" (Kelly's QR code): the addresses this Kelly answers at (base urls). The token is in the
    # answer only for a caller that sent it, or a page on this machine (connect_info's Origin check)
    if url.path == "/api/connect":
        out, _ = connect_info(hub.args, writer.get_extra_info("peername"), writer.get_extra_info("sockname"),
                              parse_qs(url.query).get("token", [""])[0], headers.get("origin", ""))
        body = json.dumps(out).encode()
        writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\n"
                     f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- Kelly's awards, shared between a member's Kellys (the PC and the phone): GET the bridge's copy, POST to merge in
    # (never replaces; kelly_state.py). This machine, or the /ws token -- like /api/mesh-texts. CORS for a file:// Kelly.
    if url.path == "/api/kelly-state" and method in ("GET", "POST"):
        local = is_loopback(writer.get_extra_info("peername"))
        status, out = "200 OK", {}
        # the token in ?token= (a beacon, a file:// Kelly) or X-Kelly-Token (the page's own requests: a failed request's
        # address is printed in the browser console, so the token stays out of it)
        tok = parse_qs(url.query).get("token", [""])[0] or headers.get("x-kelly-token", "")
        if not local and hub.args.token and tok != hub.args.token:
            status, out = "403 Forbidden", {"error": "token"}
        elif method == "POST":
            n = int(headers.get("content-length", "0") or 0)
            if n > kelly_state.MAX_BODY:
                status, out = "413 Payload Too Large", {"error": f"over {kelly_state.MAX_BODY // 1024} KB"}
            else:
                try:
                    req = json.loads((await reader.readexactly(n)).decode("utf-8")) if n else {}
                    out = hub.kstate.put(req, asyncio.get_running_loop())
                except (ValueError, asyncio.IncompleteReadError) as e:
                    status, out = "400 Bad Request", {"error": str(e)}
        else:
            out = hub.kstate.state
        body = json.dumps(out).encode()
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\n"
                     f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- MeshCore texts + contacts the bridge has seen, and a channel post (--mesh-gateway; this machine only -- except
    # GET /api/mesh-texts, which a Kelly elsewhere (a phone) may read with the /ws token, to catch up on what it missed)
    remote_texts = url.path == "/api/mesh-texts" and method == "GET" and not is_loopback(writer.get_extra_info("peername"))
    if remote_texts and hub.args.token and parse_qs(url.query).get("token", [""])[0] != hub.args.token:
        body = json.dumps({"error": "token"}).encode()
        writer.write(f"HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n"
                     f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return
    if url.path in ("/api/mesh-texts", "/api/mesh-send", "/api/mesh-stats", "/api/mesh-packets") and (remote_texts or is_loopback(writer.get_extra_info("peername"))):
        mc = hub.mesh.mc
        status, out = "200 OK", {}
        if not mc:
            status, out = "404 Not Found", {"error": "the bridge isn't reading the node (start it with --mesh-gateway)"}
        elif url.path == "/api/mesh-send" and method == "POST":
            n = int(headers.get("content-length", "0") or 0)
            try:
                req = json.loads((await reader.readexactly(n)).decode("utf-8")) if n else {}
                try:
                    if req.get("to"):   # a DM: {to: contact key prefix, text} -> waits for its delivery receipt
                        out = {"ok": True, **await mc.send_dm(str(req["to"]), str(req.get("text", "")))}
                    else:
                        await mc.send_channel(int(req.get("ch", 0)), str(req.get("text", "")))
                        out = {"ok": True}
                except RuntimeError as e:
                    # the node isn't ours right now (down, a Kelly attached, not answering): keep it for later,
                    # unless the caller said {"queue": false}
                    if req.get("queue", True) is False or not re.search(r"Kelly|not connected|did not answer", str(e)):
                        raise
                    rid = mc.outbox_add(None if req.get("to") else int(req.get("ch", 0)), str(req["to"]) if req.get("to") else None,
                                        str(req.get("text", "")), str(e), float(req.get("ttl", 0) or 0))
                    out = {"ok": True, "queued": True, "id": rid, "why": str(e)}
            except Exception as e:                     # noqa: BLE001
                status, out = "409 Conflict", {"ok": False, "error": str(e)}
        elif url.path == "/api/mesh-stats":
            out = mc.stats_snapshot(reset=parse_qs(url.query).get("reset", ["0"])[0] == "1")
        elif url.path == "/api/mesh-packets":   # the dashboard's live packet feed: RF packets + decoded channel texts since <ms>
            since = int(parse_qs(url.query).get("since", ["0"])[0] or 0)
            out = {"radio": mc.radio, "self": mc.self_name, "channels": mc.channels,
                   "packets": [x for x in mc.packets if x["at"] > since], "texts": [t for t in mc.texts if t["at"] > since]}
        else:
            out = mc.status(int(parse_qs(url.query).get("since", ["0"])[0] or 0))
        cors = "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\n" if url.path == "/api/mesh-texts" else ""
        body = json.dumps(out).encode()
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{cors}Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- the LoRa node's state, and a reconnect, for the P25X dashboard's LoRa Mesh page (this machine only)
    if url.path in ("/api/mesh-status", "/api/mesh-reopen", "/api/mesh-reset") and is_loopback(writer.get_extra_info("peername")):
        if url.path == "/api/mesh-reopen" and method == "POST":
            hub.mesh.reopen()
        if url.path == "/api/mesh-reset" and method == "POST":
            err = await hub.mesh.mc.reset("restarted by hand") if hub.mesh.mc else await hub.mesh.reset_node()
            if err:
                print(f"[bridge] node reset refused: {err}", flush=True)
        body = json.dumps(hub.mesh.status()).encode()
        writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- who's connected, for bridge/kelly_keeper.py (this machine only)
    if url.path == "/api/clients" and is_loopback(writer.get_extra_info("peername")):
        body = json.dumps({"radio": hub.up, "clients": len(hub.clients - hub.keepers), "keeper": len(hub.keepers)}).encode()
        writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- the keeper's log (--keeper-local): POST from the Pi's headless Kelly (this machine only), GET from a
    # PC Kelly with the /ws token. `handover` lets the PC tell a log posted before the keeper stood down
    # from its last one (posted as its page closes) -- it asks again for a moment if it got the older.
    if url.path == "/api/keeper-store" and hub.args.keeper_local:
        cors = "Access-Control-Allow-Origin: *\r\n"
        peer = writer.get_extra_info("peername")
        if method == "POST" and is_loopback(peer):
            try:
                n = int(headers.get("content-length", "0"))
                if not 0 < n <= KEEPER_STORE_MAX:
                    raise ValueError(f"{n} bytes")
                body = await reader.readexactly(n)
                json.loads(body)
                hub.keeper_store = body
                hub.save_store()
                status = "204 No Content"
            except (ValueError, asyncio.IncompleteReadError) as e:
                print(f"[bridge] keeper's log refused: {e}", flush=True)
                status = "400 Bad Request"
            writer.write(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n".encode())
        elif method == "GET" and (not hub.args.token or parse_qs(url.query).get("token", [""])[0] == hub.args.token):
            body = b'{"handover":%d,"log":%s}' % (hub.handover, hub.keeper_store or b"null")
            writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{cors}Cache-Control: no-cache\r\n"
                         f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
            if hub.keeper_store:
                print(f"[bridge] keeper's log ({len(hub.keeper_store) // 1024} kB) handed to {peer}", flush=True)
        else:
            writer.write(f"HTTP/1.1 403 Forbidden\r\n{cors}Content-Length: 0\r\n\r\n".encode())
        await writer.drain()
        writer.close()
        return

    # ---- RadioID.net lookup proxy (RadioID sends no CORS header, so the page can't call it)
    # ---- APRS iGate (kelly_igate.py): ONE persistent receive-only APRS-IS connection the page's iGate sends through.
    # This machine, or the bridge token (?token= or X-Kelly-Token); it holds a passcode, so never open to the LAN.
    # ---- device identity + registration token (kelly_ident.py): this machine or the bridge token, like the iGate
    if url.path == "/api/ident" or url.path.startswith("/api/ident/"):
        tok = parse_qs(url.query).get("token", [""])[0] or headers.get("x-kelly-token", "")
        allowed = is_loopback(writer.get_extra_info("peername")) or not hub.args.token or tok == hub.args.token
        await kelly_ident.http(hub.ident, method, url.path, headers, reader, writer, allowed)
        return

    if url.path == "/api/igate" or url.path.startswith("/api/igate/"):
        tok = parse_qs(url.query).get("token", [""])[0] or headers.get("x-kelly-token", "")
        allowed = is_loopback(writer.get_extra_info("peername")) or not hub.args.token or tok == hub.args.token
        await kelly_igate.http(hub.igate, method, url.path, headers, reader, writer, allowed,
                               local=is_loopback(writer.get_extra_info("peername")), query=url.query)
        return

    # ---- APRS-IS beacon (browsers can't open TCP; the bridge builds the packet from checked fields)
    if url.path == "/api/aprs":
        cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n"
        if method == "OPTIONS":
            writer.write(f"HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\n\r\n".encode())
        else:
            try:
                n = int(headers.get("content-length", "0"))
                req = json.loads((await reader.readexactly(n)).decode("utf-8")) if 0 < n < 4096 else {}
                result = await aprs_beacon(req)
            except (ValueError, KeyError, asyncio.IncompleteReadError) as e:
                result = {"ok": False, "error": str(e)}
            body = json.dumps(result).encode()
            writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{cors}Content-Length: {len(body)}\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- page diagnostics (map status etc.): printed and appended to ~/.kelly-diag.log
    if url.path == "/api/diag" and method == "POST":
        try:
            n = int(headers.get("content-length", "0"))
            body = (await reader.readexactly(n)).decode("utf-8", "replace") if 0 < n < 65536 else ""
            # the page's URL rides along in some diags: keep the bridge token out of the journal and the log
            body = re.sub(r"(token=|\"token\"\s*:\s*\")[^&\s\"']+", r"\1…", body, flags=re.I)
            line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {body}"
            print(f"[bridge] diag: {body[:300]}", flush=True)
            log = Path.home() / ".kelly-diag.log"
            log.parent.mkdir(exist_ok=True)
            with open(log, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except (ValueError, asyncio.IncompleteReadError, OSError):
            pass
        writer.write(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()
        return

    if url.path == "/api/radioid":
        q = parse_qs(url.query)
        key = q.get("id", [""])[0] or q.get("callsign", [""])[0]
        field = "id" if q.get("id") else "callsign"
        if not (key.isdigit() and len(key) <= 8) and not (field == "callsign" and key.isalnum() and len(key) <= 10):
            status, body = "400 Bad Request", json.dumps({"error": "id (digits) or callsign required"}).encode()
        else:
            status, body = "200 OK", await radioid_lookup(field, key.upper())
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n"
                     "Access-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\n\r\n".encode() + body)
        await writer.drain()
        writer.close()
        return

    # ---- static files (GET only, confined to kelly-page/)
    rel = url.path.lstrip("/") or "index.html"
    path = (ROOT / rel).resolve()
    if method != "GET" or ROOT not in path.parents and path != ROOT or not path.is_file() or "bridge" in path.relative_to(ROOT).parts:
        writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found")
    else:
        body = path.read_bytes()
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\nCache-Control: no-cache\r\n\r\n".encode() + body)
    await writer.drain()
    writer.close()


APRS_IS = ("rotate.aprs2.net", 14580)
APRS_TOCALL = kelly_igate.TOCALL  # APZKPG: APZ = experimental software prefix (no registered tocall yet)
CALL_RE = re.compile(r"^[A-Z0-9]{3,7}(-([0-9]|1[0-5]))?$")
SYMBOLS = {"/-", "/>", "/[", "/r", "/y", "/k", "/u", "/j", "/v", "/<", "/s", "/'", "/#", "\\r"}


def aprs_passcode(call: str) -> int:
    """The standard APRS-IS passcode for a callsign (SSID ignored)."""
    base = call.split("-")[0].upper()
    h = 0x73E2
    for i in range(0, len(base), 2):
        h ^= ord(base[i]) << 8
        if i + 1 < len(base):
            h ^= ord(base[i + 1])
    return h & 0x7FFF


def aprs_position(lat: float, lon: float, sym: str, ambiguity: int) -> str:
    """Uncompressed APRS position 'DDMM.mmN/DDDMM.mmE-' with optional ambiguity
    (1-3: blank the last 1-3 digits of the minutes, ~180 m / 1.8 km / 18 km)."""
    def fmt(v, deg_w, hemis):
        a = abs(v)
        d = int(a)
        m = round((a - d) * 60, 2)
        if m >= 60:
            d, m = d + 1, 0.0
        s = f"{d:0{deg_w}d}{m:05.2f}"
        blank = {1: [-1], 2: [-2, -1], 3: [-4, -2, -1]}.get(ambiguity, [])
        s = list(s)
        for i in blank:
            s[i] = " "
        return "".join(s) + hemis[0 if v >= 0 else 1]
    return fmt(lat, 2, "NS") + sym[0] + fmt(lon, 3, "EW") + sym[1]


async def aprs_beacon(req: dict) -> dict:
    call = str(req.get("call", "")).strip().upper()
    if not CALL_RE.match(call):
        return {"ok": False, "error": "callsign must look like VK4XXX or VK4XXX-15"}
    lat, lon = float(req["lat"]), float(req["lon"])
    if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return {"ok": False, "error": "latitude/longitude out of range"}
    sym = str(req.get("symbol", "/-"))
    if sym not in SYMBOLS:
        sym = "/-"
    amb = int(req.get("ambiguity", 0)) if str(req.get("ambiguity", "0")).isdigit() else 0
    comment = "".join(c for c in str(req.get("comment", "")) if 32 <= ord(c) < 127)[:43]
    passcode = str(req.get("passcode", "")).strip() or str(aprs_passcode(call))
    packet = f"{call}>{APRS_TOCALL},TCPIP*:!{aprs_position(lat, lon, sym, min(max(amb, 0), 3))}{comment}"
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(*APRS_IS), 10)
        banner = (await asyncio.wait_for(r.readline(), 10)).decode("latin-1").strip()
        vers = re.sub(r"[^0-9A-Za-z.\-]", "", str(req.get("vers", "")))[:16] or "0"   # the page's KELLY_VERSION
        w.write(f"user {call} pass {passcode} vers {kelly_igate.SOFTWARE} {vers}\r\n".encode())
        await w.drain()
        logresp = (await asyncio.wait_for(r.readline(), 10)).decode("latin-1").strip()
        verified = " verified" in logresp and "unverified" not in logresp
        sent = False
        if verified and not req.get("dry"):
            w.write((packet + "\r\n").encode())
            await w.drain()
            await asyncio.sleep(0.6)
            sent = True
        w.close()
    except (OSError, asyncio.TimeoutError) as e:
        return {"ok": False, "error": f"APRS-IS unreachable: {e}", "packet": packet}
    print(f"[aprs] {logresp} -> {'sent ' + packet if sent else 'not sent'}", flush=True)
    return {"ok": verified, "sent": sent, "packet": packet, "server": banner, "logresp": logresp,
            "error": None if verified else "APRS-IS did not verify the passcode for this callsign"}


RADIOID_URL = "https://database.radioid.net/api/dmr/user/?{field}={key}"
_radioid_cache: dict[str, tuple[float, bytes]] = {}


async def radioid_lookup(field: str, key: str) -> bytes:
    """RadioID.net user record(s) as JSON bytes. Answers (found or not) are cached
    for a day; network/parse failures aren't cached so the next call retries."""
    ck = f"{field}:{key}"
    hit = _radioid_cache.get(ck)
    if hit and time.time() - hit[0] < 86400:
        return hit[1]

    def fetch():
        req = urllib.request.Request(RADIOID_URL.format(field=field, key=urllib.parse.quote(key)),
                                     headers={"User-Agent": "KellyPage/0.1"})
        with urllib.request.urlopen(req, timeout=6) as r:
            return r.read()
    try:
        raw = await to_thread(fetch)
        json.loads(raw)                                   # must be JSON to be worth caching
    except Exception as e:                                # noqa: BLE001 -- report any failure to the page
        return json.dumps({"error": f"RadioID lookup failed: {e}"}).encode()
    _radioid_cache[ck] = (time.time(), raw)
    return raw


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--serial", help="serial port, e.g. COM5 or /dev/ttyUSB0")
    src.add_argument("--tcp", help="host:port of a TCP endpoint speaking CCDI")
    ap.add_argument("--baud", type=int, default=19200)
    ap.add_argument("--rtscts", action="store_true", help="hardware flow control")
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8025)
    ap.add_argument("--token", default=os.environ.get("KELLY_BRIDGE_TOKEN", ""), help="require ?token=... on the WebSocket")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every byte relayed")
    ap.add_argument("--keeper-local", action="store_true",
                    help="a Kelly connecting from this machine (kelly_keeper.py) yields the radio to anyone else")
    ap.add_argument("--share-dir", default="~/.kelly-share",
                    help="Kelly Share's station store: files fetched overnight / queued to send, shared by every Kelly on this bridge")
    ap.add_argument("--keeper-store", default="~/.kelly-keeper-log.json",
                    help="with --keeper-local: where the keeper's log is kept across bridge restarts")
    mesh = ap.add_mutually_exclusive_group()
    mesh.add_argument("--mesh-serial", help="a LoRa node's USB port (Meshtastic, MeshCore companion, LoRa APRS iGate/KISS TNC; 115200) for Kelly's LoRa Mesh page, e.g. /dev/ttyACM0 or COM7")
    mesh.add_argument("--mesh-tcp", help="a WiFi LoRa node as host[:port] -- Meshtastic / meshtasticd 4403, MeshCore companion 5000, LoRa APRS iGate KISS 8001")
    mesh.add_argument("--mesh-ble", metavar="ADDR",
                      help="a MeshCore companion node over Bluetooth LE (its address, e.g. AA:BB:CC:DD:EE:FF; Linux / BlueZ + bleak). "
                           "Pairs with --mesh-ble-pin; MeshCore only (kelly_mesh_ble.py)")
    mesh.add_argument("--mesh-sim", action="store_true", help="a simulated MeshCore companion node (kelly_mesh_sim.py) -- no hardware, nothing transmitted")
    ap.add_argument("--mesh-sim-faults", default="", metavar="LIST",
                    help="with --mesh-sim: ackloss=P,hang=S,slow=MS,garble=P,full,loginfail,quiet (see kelly_mesh_sim.py)")
    ap.add_argument("--mesh-auto-reset", type=float, default=0, metavar="MIN",
                    help="with --mesh-serial (or --mesh-ble) --mesh-gateway: a node that hasn't answered for MIN minutes is rebooted over the USB "
                         "port's RTS line (ESP32 auto-reset; an nRF52 such as the RAK4631, or a node on Bluetooth, gets MeshCore's REBOOT command instead), "
                         "at most once per 10 min. 0 = off (default)")
    kelly_mesh_ble.add_args(ap)
    ap.add_argument("--mesh-outbox", default="~/.kelly-mesh-outbox.sqlite", metavar="FILE",
                    help="with --mesh-gateway: where /api/mesh-send keeps messages the node can't take yet (sent when it can; 12 h)")
    ap.add_argument("--mesh-history", nargs="?", const="~/.kelly-mesh-history.sqlite", default="", metavar="FILE",
                    help="with --mesh-gateway: keep a time series of what the node hears (SNR, RSSI, packets, battery, airtime, DM success, "
                         "per station) in FILE (default ~/.kelly-mesh-history.sqlite; 1 min for 48 h, 15 min for 35 days, 1 h for 400 days) "
                         "for Kelly's trend charts -- /api/mesh-history")
    ap.add_argument("--ident-dir", default="~/.kelly-ident", metavar="DIR",
                    help="this bridge's device key + registration token, made on first start ('' = none: "
                         "the page uses its own browser key; /api/ident)")
    ap.add_argument("--kelly-state", default="~/.kelly-state.json", metavar="FILE",
                    help="where the awards a member's Kellys share are kept (/api/kelly-state; '' = in memory only)")
    ap.add_argument("--mesh-texts", default="~/.kelly-mesh-texts.json", metavar="FILE",
                    help="with --mesh-gateway: where the texts heard and sent are kept across restarts (the last 500; /api/mesh-texts)")
    ap.add_argument("--mesh-history-upload", default="", metavar="URL",
                    help="with --mesh-history: send the history to the P25X gateway every 5 min, catching up after an outage "
                         "(e.g. http://100.64.0.10:3000/api/mesh-history-ingest?token=...)")
    ap.add_argument("--mesh-history-site", default="", metavar="NAME", help="with --mesh-history-upload: this site's name on the gateway (default: the hostname)")
    ap.add_argument("--mesh-prune-days", type=float, default=0, metavar="DAYS",
                    help="with --mesh-gateway: once a day, remove contacts the node hasn't heard for DAYS days (repeaters 2x DAYS; "
                         "never favourites) so its capped contact table keeps room for new stations. 0 = off (default)")
    ap.add_argument("--mesh-autoadd", default="", metavar="TYPES",
                    help="with --mesh-gateway: turn the node's 'save every advert' off and save only these types, e.g. "
                         "companion,repeater,overwrite (overwrite = replace the oldest non-favourite when full; also room, "
                         "sensor, hops=N: 0 any, 1 direct only, N up to N-1 hops). Set at every session start. '' = leave the node alone")
    ap.add_argument("--mesh-rpt", default="", metavar="PREFIX",
                    help="with --mesh-gateway and --mesh-rpt-poll: the key prefix (hex) of a repeater you admin; the bridge logs in "
                         "(password from env KELLY_MESH_RPT_PASS) and asks its status for the history")
    ap.add_argument("--mesh-rpt-poll", type=float, default=0, metavar="MIN",
                    help="with --mesh-rpt: ask that repeater's status every MIN minutes while no Kelly is attached. 0 = off (default)")
    ap.add_argument("--mesh-gateway", action="store_true", help="a MeshCore companion node: the bridge reads it itself while no Kelly is attached (/api/mesh-texts, /api/mesh-send for the P25X gateway)")
    if kelly_ble:
        kelly_ble.add_args(ap)
    kelly_tls.add_args(ap)
    ap.add_argument("--debug", action="store_true", help="debug logging (incl. entitlement decisions, logger kelly.ent)")
    ap.add_argument("--connect-qr", action="store_true",
                    help="print the address to open Kelly at from a phone, as a QR code, and exit (settings not given here come "
                         "from the installed kelly-bridge service; sudo to read its token)")
    args = ap.parse_args()
    if args.debug:
        import logging
        logging.basicConfig(level=logging.DEBUG, format="[%(name)s] %(message)s")
    # the club's services need svc.club (kelly_ent.py); without it the flag is simply not there
    if args.mesh_gateway and not kelly_ent.check("svc.club", "--mesh-gateway"):
        args.mesh_gateway = False
    if args.mesh_history_upload and not kelly_ent.check("svc.club", "--mesh-history-upload"):
        args.mesh_history_upload = ""
    if args.mesh_autoadd:
        try:
            MeshCoreWatch.parse_autoadd(args.mesh_autoadd)
        except ValueError as e:
            ap.error(str(e))
    if args.connect_qr:
        connect_qr(args)
        return
    tls = kelly_tls.context(args)   # None = plain http (the default); exits with the reason on a bad certificate
    if kelly_ble and kelly_ble.admin(args):
        return
    if args.bind not in ("127.0.0.1", "localhost") and not args.token:
        print("[bridge] WARNING: listening beyond localhost without --token -- anyone who can reach this port can key the radio.", flush=True)
    hub = Hub(args)
    hub.mesh = MeshLink(args)
    hub.igate.keeper = lambda: bool(hub.mesh.keepers)   # the keeper on the node owns the iGate (kelly_igate.http)
    # BLE: on with --ble ADAPTERS, or when remote scanner nodes are registered
    hub.ble = kelly_ble.BleHub(args, ws_frame, read_frame) if kelly_ble and (args.ble or kelly_ble.NodeRegistry(args.ble_nodes).nodes) else None
    if expired():
        print(f"[bridge] This version of Kelly Page expired after {EXPIRES_ON:%d %B %Y} -- the radio stays closed. "
              "The page is still served so you can save your config; get the latest version.", flush=True)
    else:
        await hub.start_radio()
        if kelly_ent.public():
            asyncio.ensure_future(revocation_loop())
        await hub.mesh.start()
        if hub.ble:
            await hub.ble.start()
    # TLS: --port goes https/wss, or with --tls-port that port is https and --port stays plain (keeper, localhost calls)
    servers = [await asyncio.start_server(lambda r, w: handle(r, w, hub), args.bind, args.port, ssl=None if args.tls_port else tls)]
    if tls and args.tls_port:
        servers.append(await asyncio.start_server(lambda r, w: handle(r, w, hub), args.bind, args.tls_port, ssl=tls))
    ws, port = ("wss", args.tls_port or args.port) if tls else ("ws", args.port)
    print(f"[bridge] {hub.target}  <->  {ws}://{args.bind}:{port}/ws{'?token=…' if args.token else ''}", flush=True)
    if hub.mesh.target:
        print(f"[bridge] {hub.mesh.target}  <->  {ws}://{args.bind}:{port}/mesh", flush=True)
    if hub.ble:
        print(f"[bridge] BLE {args.ble or '(remote nodes only)'}, zone {args.ble_zone}  <->  {ws}://{args.bind}:{port}/ble"
              f"{f'  + {len(hub.ble.reg.nodes)} remote node(s) on /ble-node' if hub.ble.reg.nodes else ''}", flush=True)
    host = 'localhost' if args.bind == '0.0.0.0' else args.bind
    if not tls or args.tls_port:
        print(f"[bridge] Kelly Page at http://{host}:{args.port}/", flush=True)
    if tls:
        print(f"[bridge] Kelly Page at https://{socket.gethostname() if args.bind == '0.0.0.0' else host}:{port}/"
              f"{'  (self-signed: accept the warning once per device)' if args.tls == 'self' else ''}", flush=True)
    # systemd stops it with SIGTERM: keep the keeper's log, the mesh texts and the shared awards first
    signal.signal(signal.SIGTERM, lambda *_: (hub.store_file and hub.save_store(force=True), hub.mesh.mc and hub.mesh.mc.save_texts(), hub.kstate.save(), os._exit(0)))
    async with contextlib.AsyncExitStack() as stack:
        for s in servers:
            await stack.enter_async_context(s)
        await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
