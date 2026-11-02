"""A simulated MeshCore companion node for the Kelly bridge (--mesh-sim). Nothing is transmitted. Stdlib only.

It speaks the companion protocol at FRAME level, byte for byte as firmware v1.18.0 does (examples/companion_radio/
MyMesh.cpp): '<' len u16 payload in from the app, '>' len u16 payload out. So Kelly's LoRa Mesh page (over the bridge's
/mesh WebSocket) and the bridge's own MeshCoreWatch (--mesh-gateway) both run their real code against it.
The same world and faults are in js/meshcoresim.js (the page's #mesh-demo-meshcore) -- keep the two in step.

The world: a home companion ("VK4XXX Kelly Sim") near Ipswich, the veranda Solar Node repeater ("VK4XXX Veranda Rptr",
admin password "password" as shipped) that answers login / status / telemetry / neighbours / remote CLI, a few
repeaters and companions around SEQ, a creek sensor, channels Public + P25X. The repeater answers as a real SenseCAP
Solar repeater (fw 1.18.0) did on the bench, 2026-10-21 (js/meshcoresim.js's header has the layouts): a wrong password
gets NO answer, LOGIN_SUCCESS is 14 bytes with the repeater's clock, status is 60 bytes, telemetry is voltage +
temperature + zero padding (no GPS), and the repeater's clock starts at 15 May 2024 until "time N" sets it.
A room server, "Ipswich Chat Room" (admin "roomadmin", guest "hello" = read + post, blank = read only), holds a few
posts and pushes the ones newer than the node's "sync since" after a login, as simple_room_server v1.18.0 does (type-2
contact messages [ts][author prefix 4][text]); a DM to it is a post (ACKed, kept, never echoed); keep-alive (binary
request 2) sent direct re-sends posts newer than `since`. Same as js/meshcoresim.js's header.
MeshPRS (MeshPRS/spec): VK4ZB Bravo Heltec beacons a MeshPRS Position frame as VK4ZB-7 (GRP_DATA 0xFF4D on #meshprs) every
5 min; the node passes it on as RESP 27 only when a slot holds the #meshprs key. CMD 62 / 64 / 54 as js/meshcoresim.js.

    python kelly_bridge.py --mesh-sim                         # a quiet node: answers, plus background traffic
    python kelly_bridge.py --mesh-sim --mesh-sim-faults ackloss=0.3,slow=500
    python kelly_bridge.py --mesh-sim --mesh-gateway          # the gateway session against it

Faults (--mesh-sim-faults, comma separated): ackloss=P (a DM/request answer is lost, 0..1), acklossfirst=N (the
first N DM ACKs are lost, then all arrive -- Kelly's retries), acklatefirst=N (the first N DM ACKs arrive acklatems late,
default 25000, after Kelly's wait -- as on long SEQ routes; checked before acklossfirst), hang=S (stop answering
commands S seconds after start -- the "stale node" case), slow=MS (extra delay on every reply), garble=P (ESP32 boot
text before a frame), full (the contact table is full: a new advert evicts the oldest, PUSH 0x8F), loginfail (the
repeater refuses every password), quiet (no background traffic).
"""
from __future__ import annotations

import asyncio
import random
import struct
import time

try:   # a REAL Ed25519 identity for this node, as js/meshcoresim.js has with TweetNaCl (optional: else unsigned)
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization as _ser
except Exception:   # pragma: no cover - the Pi may not have it
    Ed25519PrivateKey = None

SELF = {"name": "VK4XXX Kelly Sim", "lat": -27.6255, "lon": 152.7663, "freq": 923125, "bw": 62500, "sf": 8, "cr": 5, "tx": 22}
# type: 1 companion, 2 repeater, 3 room, 4 sensor. via: repeaters (by index) a packet from them passes, nearest them first
WORLD = [
    {"name": "VK4XXX Veranda Rptr", "type": 2, "lat": -27.6257, "lon": 152.7666, "via": [], "snr": 11.5, "rssi": -48, "admin": "password", "guest": ""},
    {"name": "VK4ZB Bravo Heltec", "type": 1, "lat": -27.6275, "lon": 152.7644, "via": [0], "snr": 7.25, "rssi": -71, "bot": True, "mprs": "VK4ZB-7"},
    {"name": "Mt Coot-tha Rptr", "type": 2, "lat": -27.4762, "lon": 152.9520, "via": [0], "snr": 3.5, "rssi": -96},
    {"name": "VK4ZR Romeo", "type": 1, "lat": -27.5560, "lon": 152.6870, "via": [2, 0], "snr": 5.0, "rssi": -88, "bot": True},
    {"name": "Springbrook Rptr", "type": 2, "lat": -28.2010, "lon": 153.2720, "via": [2, 0], "snr": -4.25, "rssi": -112},
    {"name": "Toowoomba Rptr", "type": 2, "lat": -27.5640, "lon": 151.9540, "via": [0], "snr": -7.5, "rssi": -118},
    {"name": "VK4ZQ Bunya", "type": 1, "lat": -26.8740, "lon": 151.5960, "via": [5, 0], "snr": 1.25, "rssi": -101},
    {"name": "Brisbane Bob", "type": 1, "lat": -27.4700, "lon": 153.0230, "via": [2, 0], "snr": 2.0, "rssi": -99, "hash_size": 1},   # on 1-byte: the hash size check's demo
    {"name": "Bremer Creek Sensor", "type": 4, "lat": -27.6405, "lon": 152.7363, "via": [0], "snr": 4.5, "rssi": -92},
    {"name": "Ipswich Chat Room", "type": 3, "lat": -27.6245, "lon": 152.7653, "via": [0], "snr": 6.0, "rssi": -84, "admin": "roomadmin", "guest": "hello", "read_only": True},
]
# the room's posts at start: (author name -- the room itself = its notices; one with no contact --, seconds ago, text)
ROOM_POSTS = [("Ipswich Chat Room", 7200, "Welcome! Keep posts short and friendly. Guests: password hello"),
              ("VK4ZB Bravo Heltec", 5400, "Anyone tried 2-byte path hashes yet? Working well here."), ("VK4ZR Romeo", 3600, "Mt Coot-tha repeater back up after the storm."),
              ("Gold Coast Gary", 2400, "First post from the Coast, hello Ipswich"), ("Brisbane Bob", 1200, "Testing from the CBD, 2 hops via Coot-tha."),
              ("VK4ZQ Bunya", 600, "Bunya node is on solar now.")]
CHANNELS = ["Public", "P25X"]
# Public = MeshCore's real Public secret (channel hash 0x11); P25X = a made-up private one (hash 0x5a). 8 slots, the rest empty.
# GET_CHANNEL 31 -> CHANNEL_INFO for idx 0..7, ERR 2 past the end; CMD_SET_CHANNEL 32 [idx][name 32][secret 16] -> OK, stored;
# ERR 2 idx out of range, ERR 1 shorter than 50 bytes. js/meshcoresim.js does the same.
CHANNEL_SECRETS = ["8b3387e9c5cdea6ac9e5edbaa115cd72", "725c27dec10b06cb92860845704102cc"]
MAX_CH = 8
CHAT = ["Morning all, anyone about?", "Testing from the car, 5/9 here", "Hello from Mt Coot-tha", "QRV on the mesh tonight",
        "Range test 3, can anyone hear?", "Good signal into Ipswich today", "Back online after a firmware update", "Who's on this evening?"]


def key_of(name: str) -> bytes:
    """A station's 32-byte "public key", made from its name (FNV-1a stream) -- the same as meshcoresim.js keyOf."""
    h, out = 0x811C9DC5, bytearray(32)
    for i in range(32):
        for c in f"{name}#{i}".encode():
            h = ((h ^ c) * 0x01000193) & 0xFFFFFFFF
        out[i] = h & 255
    return bytes(out)


def parse_faults(spec: str) -> dict:
    f = {"ackloss": 0.0, "acklossfirst": 0.0, "acklatefirst": 0.0, "acklatems": 25000.0, "hang": 0.0, "slow": 0.0, "garble": 0.0, "full": False, "loginfail": False, "quiet": False}
    for part in filter(None, (p.strip() for p in (spec or "").split(","))):
        k, _, v = part.partition("=")
        k = k.lower()
        if k not in f:
            raise ValueError(f"unknown --mesh-sim-faults entry {k!r} (have: {', '.join(f)})")
        f[k] = True if isinstance(f[k], bool) else float(v or 0)
    return f


def _s32(v: float) -> int:
    return int(round(v * 1e6))


MPRS_KEY, MPRS_TYPE = "650fa1fd5d2c0bc01449a964a130ea1c", 0xFF4D   # the #meshprs key (sha256('#meshprs')[0:16]); data type
_B40 = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/."


def _call40(c: str) -> bytes:
    v = 0
    for ch in reversed(c):
        v = v * 40 + _B40.index(ch)
    return v.to_bytes(6, "big")


def _deg24(x: float, span: int) -> bytes:
    v = int(abs(x) * 2 ** 23 / span + 0.5)
    v = min(v, 2 ** 23 - 1) if x >= 0 else -min(v, 2 ** 23)
    return v.to_bytes(3, "little", signed=True)


def _i8(v: int) -> int:
    return v & 0xFF


def _cstr(s: str, n: int) -> bytes:
    return s.encode()[:n].ljust(n, b"\0")


class MeshCoreSim:
    """emit(bytes) gets the node's output byte stream ('>' frames, plus garble junk). write(bytes) takes the app's
    stream ('<' frames, any chunking). auto=True runs background traffic once start() is awaited in a loop."""

    def __init__(self, emit, faults: dict | None = None, seed: int = 1, auto: bool = True, speed: float = 1.0, scope=None):
        self.scope = scope                     # (name, key hex): a node with a default flood scope (CMD 64)
        self.sent_data: list[dict] = []        # CMD 62 sends (tests)
        self.unscoped = False                  # CMD 54 [1]
        self.emit, self.f = emit, {**parse_faults(""), **(faults or {})}
        self.rand = random.Random(seed)
        self.auto = auto and not self.f["quiet"]
        self.speed = speed                     # tests: 50 = every delay 50x shorter
        self.born = time.time()
        self.chans = [{"name": CHANNELS[i] if i < len(CHANNELS) else "", "secret": bytes.fromhex(CHANNEL_SECRETS[i]) if i < len(CHANNEL_SECRETS) else bytes(16)} for i in range(MAX_CH)]
        self.path_hash_mode = 1                # DEVICE_INFO [81]: 2-byte path hashes, as Brisbane/SEQ asks (js/meshcoresim.js keeps the same)
        self.manual_add, self.auto_bits, self.auto_hops, self.telem = 0, 0x1E, 0, 0   # SELF_INFO [47] + GET_AUTOADD_CONFIG (js/meshcoresim.js keeps the same)
        self.buf = bytearray()
        # same seed as js/meshcoresim.js (nacl keyPair.fromSeed(keyOf(name))) -> the same public key
        self.id_key = Ed25519PrivateKey.from_private_bytes(key_of(SELF["name"])) if Ed25519PrivateKey else None
        my_key = self.id_key.public_key().public_bytes(_ser.Encoding.Raw, _ser.PublicFormat.Raw) if self.id_key else key_of(SELF["name"])
        self.me = dict(SELF, key=my_key, adv_lat=SELF["lat"], adv_lon=SELF["lon"])
        self.sign_buf = None
        now = int(time.time())
        self.st = [dict(w, i=i, key=key_of(w["name"]), last_advert=now - 600 - i * 97, lastmod=now - 300 - i * 61, out_path=None, known=True)
                   for i, w in enumerate(WORLD)]
        if self.auto:                           # two stations the node hasn't heard yet: they turn up as NEW_ADVERT
            for s in self.st:
                if s["name"] in ("Brisbane Bob", "Bremer Creek Sensor"):
                    s["known"] = False
        self.queue: list[bytes] = []
        self.c = dict(recv=0, sent=0, sent_flood=0, sent_direct=0, recv_flood=0, recv_direct=0, recv_errors=0, tx_air=0, rx_air=0)
        self.logged_in: set[int] = set()
        self.clock_off: dict[int, int] = {}     # repeater index -> clock offset once "time N" has set it
        # the room server: posts (ts by its clock -- set by its owner --, author = 4-byte key prefix), our node's "sync
        # since" for it (kept with the contact, as the companion does), the room's own idea of it, our ACL permissions
        for s in self.st:
            if s["type"] == 3:
                self.clock_off[s["i"]] = 0
                s.update(posts=[{"ts": now - ago, "author": key_of(a)[:4], "text": t} for a, ago, t in ROOM_POSTS],
                         sync_since=0, room_since=0, perms=None, pushing=False, room_direct=False)
        self.last_rx = (0.0, -120)
        self.tasks: set[asyncio.Task] = set()

    # ---- plumbing
    def later(self, ms: float, fn, *a):
        async def go():
            await asyncio.sleep(ms / 1000 / self.speed)
            fn(*a)
        t = asyncio.get_running_loop().create_task(go())
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)

    def out(self, f: bytes, ms: float = 0):
        def go():
            if self.f["garble"] and self.rand.random() < self.f["garble"]:
                self.emit(b"ets Jul 29 2019 12:21:46\r\n")
            self.emit(b">" + struct.pack("<H", len(f)) + bytes(f))
        d = ms + self.f["slow"]
        self.later(d, go) if d > 0 else go()

    def hung(self) -> bool:
        return self.f["hang"] > 0 and time.time() - self.born >= self.f["hang"]

    def find(self, b: bytes, o: int, n: int = 32):
        k = bytes(b[o:o + n])
        return next((s for s in self.st if s["known"] and s["key"][:n] == k), None) if len(k) == n else None

    def tag(self) -> int:
        return self.rand.randrange(1, 0xFFFFFFFF)

    @staticmethod
    def hops(s) -> int:
        return len(s["via"])

    @staticmethod
    def stale(s) -> bool:
        """A station that has moved (s["moved"]): the route stored to it no longer arrives, a flood still does."""
        return bool(s.get("moved") and s["out_path"] is not None)

    def path(self, s) -> bytes:
        return bytes(self.st[j]["key"][0] for j in s["via"])

    def air_path(self, s) -> bytes:
        """What a flood from s carries on air: path_len (top 2 bits = hash size - 1) + each repeater's first hash_size key
        bytes (src/Packet.h, Mesh::sendFlood). 2-byte, except a station on 1-byte (Brisbane Bob)."""
        sz = s.get("hash_size", 2)
        return bytes([(sz - 1) << 6 | len(s["via"])]) + b"".join(self.st[j]["key"][:sz] for j in s["via"])

    # ---- frames the node sends
    def contact_frame(self, s, code: int = 3) -> bytes:
        p = s["out_path"]
        return (bytes([code]) + s["key"] + bytes([s["type"], 1 if s.get("fav") else 0, len(p) if p is not None else 0xFF]) + (p or b"").ljust(64, b"\0")
                + _cstr(s["name"], 32) + struct.pack("<IiiI", s["last_advert"], _s32(s["lat"]), _s32(s["lon"]), s["lastmod"]))

    def advert_packet(self, s) -> bytes:
        return (bytes([0x01 | 4 << 2]) + self.air_path(s) + s["key"] + struct.pack("<I", s["last_advert"]) + b"\0" * 64
                + bytes([0x80 | 0x10 | s["type"]]) + struct.pack("<ii", _s32(s["lat"]), _s32(s["lon"])) + s["name"].encode())

    def log_rx(self, s, pkt: bytes) -> bytes:
        self.c["recv"] += 1; self.c["recv_flood"] += 1; self.c["rx_air"] += 1
        self.last_rx = (s["snr"], s["rssi"])
        return bytes([0x88, _i8(round(s["snr"] * 4)), _i8(s["rssi"])]) + pkt

    def heard_advert(self, s):
        s["last_advert"] = s["lastmod"] = int(time.time())
        self.out(self.log_rx(s, self.advert_packet(s)))
        if not s["known"] and self.manual_add & 1 and not self.auto_bits & {1: 0x02, 2: 0x04, 3: 0x08, 4: 0x10}.get(s["type"], 0):
            return self.out(self.contact_frame(s, 0x8A))   # manual add: passed on, not kept
        if not s["known"]:
            if self.f["full"]:
                old = min((x for x in self.st if x["known"] and x is not s), key=lambda x: x["lastmod"], default=None)
                if old:
                    old["known"] = False
                    self.out(bytes([0x8F]) + old["key"])
            s["known"] = True
            self.out(self.contact_frame(s, 0x8A))
        else:
            self.out(bytes([0x80]) + s["key"])

    def heard_channel(self, s, text: str, ch: int = 0):
        body = f"{s['name']}: {text}".encode()
        self.out(self.log_rx(s, bytes([0x01 | 5 << 2]) + self.air_path(s) + bytes([0x11 if ch == 0 else 0x5A]) + b"\0" * min(len(body) + 2, 60)))
        self.queue.append(bytes([17, _i8(round(s["snr"] * 4)), 0, 0, ch, self.hops(s), 0]) + struct.pack("<I", int(time.time())) + body)
        self.out(bytes([0x83]))

    def heard_data(self, s, blob: bytes, typ: int = MPRS_TYPE):
        """A GRP_DATA heard; handed on as RESP 27 only if a slot holds the channel's key (MyMesh.cpp onChannelDataRecv)."""
        self.out(self.log_rx(s, bytes([0x01 | 6 << 2]) + self.air_path(s) + bytes([0xBA, 0, 0]) + bytes(16 * -(-(len(blob) + 3) // 16))))
        ch = next((i for i, c in enumerate(self.chans) if c["name"] and c["secret"].hex() == MPRS_KEY), -1)
        if ch < 0:
            return
        self.queue.append(bytes([27, _i8(round(s["snr"] * 4)), 0, 0, ch, self.air_path(s)[0], typ & 255, typ >> 8, len(blob)]) + bytes(blob))
        self.out(bytes([0x83]))

    def mprs_position(self, s) -> bytes:
        """The station's next Position frame: K set, its key prefix, '/[' walker, a comment; seq per station."""
        s["mprs_seq"] = (s.get("mprs_seq", s["i"] * 37) + 1) & 255
        return (bytes([0x50, 0x00, s["mprs_seq"]]) + _call40(s["mprs"]) + s["key"][:4] + _deg24(s["lat"], 90) + _deg24(s["lon"], 180)
                + b"/[\0" + b"Kelly sim tracker")

    def heard_dm(self, s, text: str):
        self.out(self.log_rx(s, bytes([0x01 | 2 << 2]) + self.air_path(s) + bytes([self.me["key"][0], s["key"][0]]) + b"\0" * 20))
        self.queue.append(bytes([16, _i8(round(s["snr"] * 4)), 0, 0]) + s["key"][:6] + bytes([self.hops(s), 0]) + struct.pack("<I", int(time.time())) + text.encode())
        self.out(bytes([0x83]))

    # ---- the room server (simple_room_server's loop(): one post per client at a time, the next after its ACK, ~1.2 s)
    def room_push(self, s, delay: float = 2000):
        if s["pushing"] or s["i"] not in self.logged_in:
            return
        s["pushing"] = True
        mine = self.me["key"][:4]

        def step():
            p = next((x for x in s["posts"] if x["ts"] > s["room_since"] and x["author"] != mine), None) if s["i"] in self.logged_in else None
            if not p:
                s["pushing"] = False
                return
            s["room_since"] = p["ts"]; s["sync_since"] = max(s["sync_since"], p["ts"])   # our node ACKs it, keeps the newest time
            self.queue.append(bytes([16, _i8(round(s["snr"] * 4)), 0, 0]) + s["key"][:6] + bytes([0xFF if s["room_direct"] else self.hops(s), 2])
                              + struct.pack("<I", p["ts"]) + p["author"] + p["text"].encode())
            s["room_direct"] = True              # our ACK's path-return taught it the route: later pushes come direct
            self.out(bytes([0x83]))
            self.later(1200, step)
        self.later(delay + 600 * self.hops(s), step)

    def room_add(self, s, author: bytes, text: str):
        last = s["posts"][-1]["ts"] if s["posts"] else 0
        s["posts"].append({"ts": max(self.clock_of(s), last + 1), "author": bytes(author[:4]), "text": text[:151]})
        del s["posts"][:-32]                     # MAX_UNSYNCED_POSTS, a cyclic queue in RAM
        self.room_push(s)

    def room_post(self, i: int, text: str):
        """Station i posts to the room (tests; the demo's background traffic)."""
        self.room_add(next(s for s in self.st if s["type"] == 3), self.st[i]["key"], text)

    def repeater_stats(self, s) -> bytes:
        up = int(time.time() - self.born) + 86400 * 3 + 3600 * 7
        return (struct.pack("<HHhhIIIIIIIIHhHHI", 4105, 0, -118, -71, 18234, 4411, 1873, up, 3908, 503, 15520, 2714, 0, round(s["snr"] * 4), 37, 1192, 9120)
                + struct.pack("<I", 52) + b"\0" * 4)   # fw 1.18: + n_recv_errors + 4 bytes we don't know (zero on the bench)

    def telemetry(self, s) -> bytes:
        """CayenneLPP voltage (116) + temperature (103), then the firmware's zero padding. No GPS (fixed position, GPS off)."""
        t, v = 245 + round(self.rand.random() * 30), 400 + round(self.rand.random() * 16)
        return bytes([1, 116]) + v.to_bytes(2, "big") + bytes([1, 103]) + t.to_bytes(2, "big") + b"\0" * 4

    BOOT_CLOCK = 1715770620                      # 15 May 2024: where a real repeater's clock restarts after power-off

    def clock_of(self, s) -> int:
        if s["i"] in self.clock_off:
            return int(time.time()) + self.clock_off[s["i"]]
        return self.BOOT_CLOCK + int(time.time() - self.born)

    @staticmethod
    def clock_txt(t: int) -> str:
        g = time.gmtime(t)
        return f"{g.tm_hour:02d}:{g.tm_min:02d} - {g.tm_mday}/{g.tm_mon}/{g.tm_year} UTC"

    def neighbours_of(self, s) -> list:
        """The repeaters it hears directly: in this world, those one hop out through it."""
        return [x for x in self.st if x["type"] == 2 and x["via"] == [s["i"]]]

    def cli_answer(self, s, cmd: str) -> str:
        """A repeater's CLI (CommonCLI.cpp + simple_repeater), with the answers the bench repeater gave."""
        if cmd == "ver":
            return "v1.18.0-sim (Build: 15-Oct-2026)"
        if cmd == "clock":
            return self.clock_txt(self.clock_of(s))
        if cmd.startswith("time "):
            try:
                t = int(cmd[5:]) & 0xFFFFFFFF
            except ValueError:
                t = 0
            if t > self.clock_of(s):
                self.clock_off[s["i"]] = t - int(time.time())
                return "OK - clock set: " + self.clock_txt(t)
            return "(ERR: clock cannot go backwards)"
        if cmd == "get name":
            return "> " + s["name"]
        if cmd == "get radio":
            me = self.me
            return f"> {me['freq'] / 1000:.3f},{me['bw'] / 1000:g},{me['sf']},{me['cr']}"
        if cmd == "get tx":
            return "> 22"
        if cmd == "get role":
            return "> repeater"
        if cmd == "neighbors":
            n = self.neighbours_of(s)
            return "\n".join(f"{x['key'][:4].hex()}:{300 + x['i'] * 60}:{round(x['snr'] * 4)}" for x in n) if n else "-none-"
        if cmd == "advert":
            return "OK - Advert sent"
        if cmd == "reboot":                       # the real one reboots without answering
            self.later(100, self.logged_in.discard, s["i"])
            return ""
        if cmd.startswith("get "):
            return "??: " + cmd[4:]
        return "Unknown command"

    # ---- the app's byte stream
    def write(self, data: bytes):
        self.buf += data
        while True:
            i = self.buf.find(b"<")
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
            p = bytes(self.buf[3:3 + n]); del self.buf[:3 + n]
            self.command(p)

    def command(self, p: bytes):
        if not p or self.hung():
            return
        c, out = p[0], self.out
        ok = lambda: out(b"\0")
        err = lambda e: out(bytes([1, e]))
        sent = lambda flood, tag, ms: out(bytes([6, 1 if flood else 0]) + struct.pack("<II", tag, ms))
        lost = lambda: self.f["ackloss"] and self.rand.random() < self.f["ackloss"]
        me = self.me
        if c == 22:
            out(bytes([13, 8, 175, 8]) + struct.pack("<I", 123456) + _cstr("15 Oct 2026", 12) + _cstr("Kelly MeshCore simulator", 40) + _cstr("v1.18.0-sim", 20) + bytes([0, self.path_hash_mode]))
        elif c == 38:   # CMD_SET_OTHER_PARAMS [manual_add_contacts][telemetry..] (the rest ignored here)
            self.manual_add = p[1]
            if len(p) >= 3:
                self.telem = p[2] & 0x3F
            ok()
        elif c == 58:   # CMD_SET_AUTOADD_CONFIG [bits][max hops]
            self.auto_bits = p[1] & 0x1F
            if len(p) >= 3:
                self.auto_hops = min(p[2], 64)
            ok()
        elif c == 59:   # CMD_GET_AUTOADD_CONFIG
            out(bytes([25, self.auto_bits, self.auto_hops]))
        elif c == 61:   # CMD_SET_PATH_HASH_MODE [0][mode] (companion MyMesh.cpp:1504)
            if len(p) >= 3 and p[1] == 0 and p[2] < 3:
                self.path_hash_mode = p[2]; out(bytes([0]))
            else:
                out(bytes([1, 6]))
        elif c == 1:
            out(bytes([5, 1, me["tx"], 30]) + me["key"] + struct.pack("<ii", _s32(me["adv_lat"]), _s32(me["adv_lon"])) + bytes([0, 0, self.telem, self.manual_add])
                + struct.pack("<II", me["freq"], me["bw"]) + bytes([me["sf"], me["cr"]]) + me["name"].encode())
        elif c == 6:
            ok()
        elif c == 5:
            out(bytes([9]) + struct.pack("<I", int(time.time())))
        elif c == 4:
            since = struct.unpack_from("<I", p, 1)[0] if len(p) >= 5 else 0
            lst = [s for s in self.st if s["known"] and s["lastmod"] > since]
            out(bytes([2]) + struct.pack("<I", len(lst)))
            for s in lst:
                out(self.contact_frame(s))
            out(bytes([4]) + struct.pack("<I", max(s["lastmod"] for s in self.st)))
        elif c == 31:
            out(bytes([18, p[1]]) + _cstr(self.chans[p[1]]["name"], 32) + self.chans[p[1]]["secret"]) if len(p) > 1 and p[1] < MAX_CH else err(2)
        elif c == 32:                            # CMD_SET_CHANNEL [idx][name 32][secret 16]
            if len(p) < 50:
                err(1)
            elif p[1] >= MAX_CH:
                err(2)
            else:
                self.chans[p[1]] = {"name": bytes(p[2:34]).split(b"\0")[0].decode("utf-8", "replace"), "secret": bytes(p[34:50])}
                ok()
        elif c == 20:
            out(bytes([12]) + struct.pack("<HII", 4012, 96, 1984))
        elif c == 62:                            # CMD_SEND_CHANNEL_DATA [ch][path_len][path][data_type u16][data]
            pl = p[2] if len(p) >= 4 else 0
            at = 3 + (0 if pl == 0xFF else (pl & 63) * ((pl >> 6) + 1))
            if len(p) < 4 or (pl != 0xFF and pl >> 6 > 2) or len(p) < at + 2:
                err(6)
            elif p[1] >= MAX_CH or not self.chans[p[1]]["name"]:
                err(2)
            elif not (p[at] | p[at + 1] << 8) or len(p) - at - 2 > 165:
                err(6)
            else:
                self.sent_data.append({"ch": p[1], "pathLen": pl, "type": p[at] | p[at + 1] << 8, "data": p[at + 2:].hex(), "unscoped": self.unscoped})
                self.c["sent"] += 1; self.c["sent_flood" if pl == 0xFF else "sent_direct"] += 1; self.c["tx_air"] += 1
                ok()
        elif c == 64:                            # the default flood scope: [28] = none
            out(bytes([28]) + (_cstr(self.scope[0], 31) + bytes.fromhex(self.scope[1]) if self.scope else b""))
        elif c == 54:                            # CMD_SET_FLOOD_SCOPE_KEY: [1] = send unscoped, [0] = back to the default
            if len(p) < 2:
                err(1)
            else:
                self.unscoped = p[1] == 1
                ok()
        elif c == 10:
            out(self.queue.pop(0) if self.queue else bytes([10]))
        elif c in (7, 3):                        # self advert / channel text (no ACK exists for either)
            self.c["sent"] += 1; self.c["sent_flood"] += 1; self.c["tx_air"] += 1
            ok()
        elif c == 14:
            la, lo = struct.unpack_from("<ii", p, 1)
            me["adv_lat"], me["adv_lon"] = la / 1e6, lo / 1e6
            ok()
        elif c in (30, 13, 9):
            s = self.find(p, 1)
            if not s and c == 9 and len(p) >= 132:   # ADD_UPDATE_CONTACT, new key: a QR contact (key/type/name only) -> added
                key = bytes(p[1:33])
                s = next((x for x in self.st if x["key"] == key), None)
                if s is None:
                    s = dict(name=p[100:132].split(b"\0")[0].decode("utf-8", "replace") or "Added", type=p[33], lat=0.0, lon=0.0, via=[0], snr=0.0,
                             rssi=-120, i=len(self.st), key=key, last_advert=0, lastmod=int(time.time()),
                             out_path=None if p[35] == 0xFF else list(p[36:36 + (p[35] & 63) * ((p[35] >> 6) + 1)]))
                    self.st.append(s)
                s["fav"] = bool(p[34] & 1)
                s["known"] = True; s["lastmod"] = int(time.time())
                return ok()
            if not s:
                return err(2)
            if c == 30:
                out(self.contact_frame(s))
            elif c == 13:
                s["out_path"] = None; ok()
            else:
                s["fav"] = bool(p[34] & 1)
                n = p[35]
                s["out_path"] = None if n == 0xFF else bytes(p[36:36 + (n & 63) * ((n >> 6) + 1)])
                ok()
        elif c == 42:
            s = self.find(p, 2)
            if not s:
                return err(2)
            pt = self.path(s)
            out(bytes([22]) + struct.pack("<I", s["last_advert"]) + bytes([len(pt)]) + pt)
        elif c == 2:                             # SEND_TXT_MSG [2][type][attempt][ts u32][prefix 6][text]
            s = self.find(p, 7, 6)
            if not s:
                return err(2)
            if len(p) > 1 and p[1] == 1 and s["type"] in (2, 3):   # remote CLI: no ACK; an answer only for a logged-in admin
                flood = s["out_path"] is None
                self.c["sent"] += 1; self.c["sent_flood" if flood else "sent_direct"] += 1; self.c["tx_air"] += 1
                sent(flood, 0, 2694)
                if s["i"] not in self.logged_in or lost():
                    return
                reply = self.cli_answer(s, p[13:].split(b"\0")[0].decode("utf-8", "replace").strip())
                if reply:
                    def answer():
                        self.queue.append(bytes([16, _i8(round(s["snr"] * 4)), 0, 0]) + s["key"][:6] + bytes([0xFF, 1])
                                          + struct.pack("<I", self.clock_of(s)) + reply.encode())
                        self.out(bytes([0x83]))
                    self.later(1200 + 600 * self.hops(s), answer)
                return
            flood = s["out_path"] is None
            tag, ms = self.tag(), (4000 + 1500 * self.hops(s) if flood else 2500)
            self.c["sent"] += 1; self.c["sent_flood" if flood else "sent_direct"] += 1; self.c["tx_air"] += 1
            sent(flood, tag, ms)
            if s["type"] == 3:                   # a post to the room: ACKed only for a logged-in reader/writer, kept, never sent back
                if s["i"] not in self.logged_in or not (s["perms"] or 0) & 3 or lost():
                    return
                rtt = 900 + 700 * self.hops(s)
                out(bytes([0x82]) + struct.pack("<II", tag, rtt), rtt)
                return self.room_add(s, me["key"], p[13:].split(b"\0")[0].decode("utf-8", "replace"))
            if s["type"] == 4 or lost():
                return
            rtt = 900 + 700 * self.hops(s) + round(self.rand.random() * 600)
            if self.f["acklatefirst"] > 0:
                self.f["acklatefirst"] -= 1
                rtt = round(self.f["acklatems"])
            elif self.f["acklossfirst"] > 0:
                self.f["acklossfirst"] -= 1
                return
            out(bytes([0x82]) + struct.pack("<II", tag, rtt), rtt)
            if flood:                            # their path-return: the node learns the route to them
                s["out_path"] = bytes(self.st[j]["key"][0] for j in reversed(s["via"]))
                out(bytes([0x81]) + s["key"], rtt + 50)
            if s.get("bot"):
                text = p[13:].decode("utf-8", "replace")
                self.later(rtt + 1500 + round(self.rand.random() * 1500), self.heard_dm, s, f"Copy, {text if len(text) <= 60 else text[:57] + '...'}")
        elif c == 52:
            s = self.find(p, 2)
            if not s:
                return err(2)
            sent(True, self.tag(), 6000)
            if s["type"] == 4 or lost():
                return
            back = self.path(s)
            out(bytes([0x8D, 0]) + s["key"][:6] + bytes([len(back)]) + back[::-1] + bytes([len(back)]) + back, 1200 + 800 * self.hops(s))
        elif c == 56:
            t = p[1] if len(p) > 1 else 255
            if t == 0:
                out(bytes([24, 0]) + struct.pack("<HIHB", 4012, int(time.time() - self.born) + 5000, 0, 0))
            elif t == 1:
                out(bytes([24, 1]) + struct.pack("<hbbII", -117, self.last_rx[1], round(self.last_rx[0] * 4), self.c["tx_air"], self.c["rx_air"]))
            elif t == 2:
                k = ("recv", "sent", "sent_flood", "sent_direct", "recv_flood", "recv_direct", "recv_errors")
                out(bytes([24, 2]) + struct.pack("<7I", *(self.c[x] for x in k)))
            else:
                err(6)
        elif c == 26:                            # login [26][key 32][password]
            s = self.find(p, 1)
            if not s:
                return err(2)
            if s["type"] not in (2, 3):
                return err(6)
            pw = p[33:].split(b"\0")[0].decode("utf-8", "replace")
            sent(s["out_path"] is None, struct.unpack_from("<I", s["key"])[0], 8000 + 1500 * self.hops(s))   # tag = their key's first 4 bytes
            if lost() or self.stale(s):
                return
            if s["type"] == 3:                   # room: admin 3, guest password 2 (read + post), blank 0 (read only) -- or what it gave us before
                perm = (-1 if self.f["loginfail"] else 3 if pw == s["admin"] else 2 if pw == s["guest"]
                        else s["perms"] if pw == "" and s["perms"] is not None else 0 if pw == "" and s.get("read_only") else -1)
                if perm < 0:                     # wrong password: silence
                    return
                self.logged_in.add(s["i"])
                s["perms"], s["room_since"], s["room_direct"] = perm, s["sync_since"], False   # the login carries our "sync since"
                if s["out_path"] is None:
                    s["out_path"] = bytes(self.st[j]["key"][0] for j in reversed(s["via"]))
                    out(bytes([0x81]) + s["key"], 700 + 600 * self.hops(s))
                out(bytes([0x85, 1 if perm == 3 else 2 if perm == 0 else 0]) + s["key"][:6] + struct.pack("<I", self.clock_of(s)) + bytes([perm, 1]),
                    750 + 600 * self.hops(s))
                return self.room_push(s, 2750)
            admin = not self.f["loginfail"] and pw == s.get("admin")
            guest = not self.f["loginfail"] and not admin and s.get("guest") is not None and pw == s["guest"]
            if not (admin or guest):             # a wrong password: the repeater stays silent
                return
            self.logged_in.add(s["i"])
            if s["out_path"] is None:            # the login taught the route
                s["out_path"] = bytes(self.st[j]["key"][0] for j in reversed(s["via"]))
                out(bytes([0x81]) + s["key"], 700 + 600 * self.hops(s))
            out(bytes([0x85, 1 if admin else 0]) + s["key"][:6] + struct.pack("<I", self.clock_of(s)) + bytes([3 if admin else 1, 2]), 750 + 600 * self.hops(s))
        elif c == 27:                            # status request [27][key 32]
            s = self.find(p, 1)
            if not s:
                return err(2)
            sent(s["out_path"] is None, self.tag(), 3000 + 1500 * self.hops(s))
            if s["type"] != 2 or lost() or self.stale(s):
                return
            out(bytes([0x87, 0]) + s["key"][:6] + self.repeater_stats(s), 800 + 600 * self.hops(s))
        elif c == 39:                            # telemetry request [39][0 0 0][key 32]
            s = self.find(p, 4)
            if not s:
                return err(2)
            sent(s["out_path"] is None, self.tag(), 3000 + 1500 * self.hops(s))
            if lost():
                return
            out(bytes([0x8B, 0]) + s["key"][:6] + self.telemetry(s), 900 + 600 * self.hops(s))
        elif c == 15:                            # REMOVE_CONTACT
            s = self.find(p, 1)
            if not s:
                return err(2)
            s["known"] = False
            ok()
        elif c == 16:                            # SHARE_CONTACT (one hop over the air)
            if not self.find(p, 1):
                return err(2)
            self.c["sent"] += 1; self.c["tx_air"] += 1
            ok()
        elif c == 17:                            # EXPORT_CONTACT: [17] = this node, [17][key] = that contact
            if len(p) < 33:   # our own advert, signed when we have the key (Ham Contacts checks cards)
                a = bytearray(self.advert_packet(dict(me, type=1, via=[], last_advert=int(time.time()), lat=me["adv_lat"], lon=me["adv_lon"])))
                if self.id_key:
                    a[38:102] = self.id_key.sign(bytes(a[2:38]) + bytes(a[102:]))
                out(bytes([11]) + bytes(a))
            else:
                s = self.find(p, 1)
                if not s:
                    return err(2)
                out(bytes([11]) + self.advert_packet(dict(s, via=[])))
        elif c == 18:                            # IMPORT_CONTACT [advert packet]
            pl = p[2] & 63
            o = 3 + pl * ((p[2] >> 6) + 1)
            if len(p) < o + 101:
                return err(6)
            key, flags = p[o:o + 32], p[o + 100]
            s = next((x for x in self.st if x["key"] == key), None)
            if s is None:
                i, lat, lon = o + 101, 0.0, 0.0
                if flags & 0x10:
                    la, lo = struct.unpack_from("<ii", p, i); lat, lon = la / 1e6, lo / 1e6; i += 8
                s = dict(name=p[i:].decode("utf-8", "replace") or "Imported", type=flags & 15, lat=lat, lon=lon, via=[0], snr=0.0, rssi=-120,
                         i=len(self.st), key=bytes(key), last_advert=struct.unpack_from("<I", p, o + 32)[0], lastmod=int(time.time()), out_path=None)
                self.st.append(s)
            s["known"] = True; s["lastmod"] = int(time.time())
            ok()
        elif c == 33:                            # SIGN_START -> [19][0][max u32]
            self.sign_buf = bytearray(); out(bytes([19, 0]) + struct.pack("<I", 8192))
        elif c == 34:                            # SIGN_DATA [bytes]
            if self.sign_buf is None:
                return err(4)
            if len(self.sign_buf) + len(p) - 1 > 8192:
                return err(3)
            self.sign_buf += bytes(p[1:]); ok()
        elif c == 35:                            # SIGN_FINISH -> [20][signature 64]
            if self.sign_buf is None:
                return err(4)
            sig = self.id_key.sign(bytes(self.sign_buf)) if self.id_key else bytes(64)
            self.sign_buf = None; out(bytes([20]) + sig)
        elif c == 8:                             # SET_ADVERT_NAME
            me["name"] = p[1:].split(b"\0")[0].decode("utf-8", "replace")
            ok()
        elif c == 36:                            # trace path [36][tag u32][auth u32][flags][hashes] (as js/meshcoresim.js)
            if len(p) < 11:
                return err(6)
            flags = p[9]; psz = flags & 3; sz = 1 << psz; hs = p[10:]; n = len(hs) >> psz
            sent(False, struct.unpack_from("<I", p, 1)[0], 900 + 700 * n)
            hops = [next((s for s in self.st if s["type"] in (2, 3) and s["key"].hex().startswith(hs[i * sz:(i + 1) * sz].hex())), None) for i in range(n)]

            def near(a, b):
                if a is None:
                    return not b["via"]
                return (b["via"][:1] == [a["i"]]) or (a["via"][:1] == [b["i"]]) or (not a["via"] and not b["via"])
            ok = n > 0 and all(hops) and not lost()
            for i in range(n):
                ok = ok and near(hops[i - 1] if i else None, hops[i])
            if not ok or hops[-1]["via"]:
                return
            snrs = [s["snr"] if i == 0 else min(s["snr"], hops[i - 1]["snr"]) for i, s in enumerate(hops)]
            out(bytes([0x89, 0, len(hs), flags]) + p[1:9] + hs + bytes(_i8(round(v * 4)) for v in snrs) + bytes([_i8(round(hops[-1]["snr"] * 4))]), 700 + 500 * n)
        elif c == 50:                            # binary request [50][key 32][req type][...]: neighbours (6) only
            s = self.find(p, 1)
            if not s:
                return err(2)
            tag = self.tag()
            sent(s["out_path"] is None, tag, 2694)
            if len(p) > 33 and p[33] == 2 and s["type"] == 3:   # keep-alive: active again; sent direct, `since` re-sends newer posts
                if s["i"] not in self.logged_in:
                    return
                since = struct.unpack_from("<I", p, 34)[0] if len(p) >= 38 else 0
                if since and s["out_path"] is not None:
                    s["room_since"] = since
                return self.room_push(s, 300)
            if len(p) < 40 or p[33] != 6 or s["type"] != 2 or lost():
                return
            want, plen = p[35], min(p[39] or 6, 32)
            n = sorted(self.neighbours_of(s), key=lambda x: -x["snr"])
            lst = n[:want]
            body = b"".join(x["key"][:plen] + struct.pack("<I", 300 + x["i"] * 60) + bytes([_i8(round(x["snr"] * 4))]) for x in lst)
            out(bytes([0x8C, 0]) + struct.pack("<IHH", tag, len(n), len(lst)) + body, 900 + 600 * self.hops(s))
        else:
            err(1)

    # ---- background traffic
    async def room_traffic(self):
        """Someone posts to the room every few minutes (not from self.rand: the rest of the traffic stays as it was)."""
        await asyncio.sleep(45 / self.speed)
        n = 0
        while True:
            room, who = next(s for s in self.st if s["type"] == 3), [s for s in self.st if s["type"] == 1][n % 4]
            self.room_add(room, who["key"], CHAT[n % len(CHAT)])
            n += 1
            await asyncio.sleep((180 + 60 * (n % 3)) / self.speed)

    async def mprs_traffic(self):
        """MeshPRS beacons every 5 min (not from self.rand: the rest of the traffic stays as it was)."""
        await asyncio.sleep(30 / self.speed)
        while True:
            for s in self.st:
                if s.get("mprs"):
                    self.heard_data(s, self.mprs_position(s))
            await asyncio.sleep(300 / self.speed)

    async def run(self):
        if not self.auto:
            return
        t = asyncio.get_running_loop().create_task(self.room_traffic())
        self.tasks.add(t); t.add_done_callback(self.tasks.discard)
        t = asyncio.get_running_loop().create_task(self.mprs_traffic())
        self.tasks.add(t); t.add_done_callback(self.tasks.discard)
        await asyncio.sleep(4 / self.speed)
        while True:
            r, s = self.rand.random(), self.rand.choice(self.st)
            if r < 0.5:
                self.heard_advert(s)
            elif r < 0.85 and s["type"] == 1:
                self.heard_channel(s, self.rand.choice(CHAT), 0 if self.rand.random() < 0.8 else 1)
            elif r < 0.92 and s.get("bot"):
                self.heard_dm(s, "G'day, are you on the P25X net tonight?")
            elif s["type"] == 2:
                self.heard_advert(s)
            await asyncio.sleep((15 + self.rand.random() * 25) / self.speed)
