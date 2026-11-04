"""Kelly bridge: the APRS iGate's APRS-IS connection (2026-10-24, unreleased).

A browser can't open TCP, so the page's APRS iGate (js/igateui.js) decides WHAT to gate -- whitelist, valid position,
dedup, per-station interval (js/igate.js) -- and this keeps ONE persistent, receive-only APRS-IS connection and sends
it. It re-checks every field and keeps its own global token bucket (1 line per second, burst 10) as an abuse / runaway-bug guard.

  GET  /api/igate          status: state, server, verified, uptime, sent / dropped, retry, the last raw lines
  GET  /api/igate/rx?hours=24&src=CALL-SSID&format=json|kml
                           the received-packet log: every line the page offered in the last 24 h with its EXACT position
                           (before the privacy zone) and what happened to it -- sent, held, offline (no internet)...
                           Kept on disk (KELLY_IGATE_RX_FILE, mode 600), so an internet outage or a reload loses nothing;
                           nothing is ever re-sent late (APRS-IS would show an old position as current)
  POST /api/igate/config   {on, call: CALL-SSID, server, port, filter, dry, everyS, burst, vers, status, statusMin}
  POST /api/igate/send     {lines: [{src: CALL-SSID, lat, lon, sym, comment, amb} | {src, body: telemetry}
                                    | {mprs: hex, rxAt: ms, record?: {sender, id}}, ...]} -> {results: [...], status}
                           body = T#... or :SRC:PARM./UNIT./EQNS./BITS. for that station only. mprs = a MeshPRS frame the
                           page has gated (js/meshprs.js Gate): decoded and rendered AGAIN here with meshprs.py, so the
                           line is the spec's rendering of a real frame, never text from the page; record = the gated
                           message an ack answers (spec §6.2)
  (this machine, or the bridge token -- ?token= or X-Kelly-Token)

  login    user CALL-SSID pass N vers KellyPage x.y [filter F]; nothing is ever sent unless the reply says "verified"
  packet   SRC>APZKPG,qAO,IGATECALL:!DDMM.mmN/DDDMM.mmE>comment  (qAO = a receive-only iGate, aprs-is.net/q.aspx)
  keeps    a '#' keepalive every 2 min; 5 min without a byte from the server = dead, reconnect
  retry    exponential backoff with jitter, 30 s -> 10 min, never a tight loop (an unverified login waits the most)
  dry      logs what would be sent and never connects
  passcode the bridge's own (decision 0009): env KELLY_IGATE_PASS, else computed from the call. The page never sends one
  server   aunz.aprs2.net:14580; a connection that fails before it is verified sends the next try to rotate.aprs2.net,
           and back (spec §11). A drop after a good session retries the same server
  bind     env KELLY_IGATE_BIND = a local address the APRS-IS link leaves from (only that family is tried), e.g.
           192.168.1.50 when the machine's default route blocks TCP 14580 and a policy route sends traffic from
           that address out another router

The passcode, position format and packet rules = js/igate.js (bridge/igate_vectors.json, test_kelly_igate.py).
"""
from __future__ import annotations

import asyncio
import json
import math
import random
import re
import os
import socket
import time

from urllib.parse import parse_qs

import meshprs

TOCALL = "APZKPG"          # APZ = the experimental tocall range (no registered one yet); = js/igate.js TOCALL
SOFTWARE = "KellyPage"
DEFAULT_SERVER = ("aunz.aprs2.net", 14580)
FALLBACK_SERVER = "rotate.aprs2.net"
KEEPALIVE_S = 120
SILENCE_S = 300
LOG_MAX = 40

BASE_RE = re.compile(r"^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$")
CALL_SSID_RE = re.compile(r"^([A-Z0-9]{1,6})-([1-9]|1[0-5])$")
SYM_RE = re.compile(r"^[/\\0-9A-Z][\x21-\x7e]$")


def passcode(call: str) -> int:
    """The standard APRS-IS passcode for a callsign (SSID ignored)."""
    base = str(call).split("-")[0].upper()
    h = 0x73E2
    for i in range(0, len(base), 2):
        h ^= ord(base[i]) << 8
        if i + 1 < len(base):
            h ^= ord(base[i + 1])
    return h & 0x7FFF


def valid_base(c) -> bool:
    return isinstance(c, str) and len(c) <= 6 and bool(BASE_RE.match(c))


def full_call(base, ssid) -> str | None:
    b = str(base or "").strip().upper()
    try:
        s = float(ssid)
    except (TypeError, ValueError):
        return None
    return f"{b}-{int(s)}" if valid_base(b) and s.is_integer() and 1 <= s <= 15 else None


# HAM ONLY (2026-10-31: "we cannot gate non-ham station names into aprs.fi under any circumstance"). The page sends
# each line with the MeshCore node's name; the line goes out only when the FIRST or SECOND word of the name is a VK / ZL
# amateur callsign (VK or ZL, 1-2 digits, 1-4 letters, then the end, punctuation or -SSID 1-15; the first word wins)
# that is the line's own source callsign.
# = js/igate.js callFromName / hamCall / hamNode (vectors: from_name). This is the last check, independent of the page.
HAM_NAME_RE = re.compile(r"^\s*(?:\S+\s+)??((?:VK|ZL)[0-9]{1,2}[A-Z]{1,4})(?:-([0-9]{1,2}))?(?=$|[^A-Z0-9])", re.I)
HAM_CALL_RE = re.compile(r"^((?:VK|ZL)[0-9]{1,2}[A-Z]{1,4})(?:-([0-9]{1,2}))?$")


def call_from_name(name):
    """The callsign in a node name's first or second word -> (base, ssid or None), or None."""
    m = HAM_NAME_RE.match(str(name or ""))
    if not m:
        return None
    base, ssid = m.group(1).upper(), (int(m.group(2)) if m.group(2) is not None else None)
    return (base, ssid) if valid_base(base) and (ssid is None or 1 <= ssid <= 15) else None


def ham_call(c) -> bool:
    m = HAM_CALL_RE.match(str(c or ""))
    return bool(m) and valid_base(m.group(1)) and (m.group(2) is None or 1 <= int(m.group(2)) <= 15)


def ham_node(src, name) -> bool:
    cs = call_from_name(name)
    return ham_call(src) and cs is not None and cs[0] == str(src).split("-")[0]


def valid_call_ssid(c) -> bool:
    m = CALL_SSID_RE.match(str(c or ""))
    return bool(m) and valid_base(m.group(1))


def valid_symbol(s) -> bool:
    return isinstance(s, str) and bool(SYM_RE.match(s))


# Impossible jumps (2026-10-31: a test tracker jumped a long way north on the map). A bad GPS fix, or a corrupted frame,
# can still be a valid position, so each station's fix is checked against its last good one: faster than a car = refused.
# Same rules as the P25 path's scripts/p25x_aprs.py position_problem (no service area here: Kelly iGates run anywhere in
# VK / ZL). A refused fix that the NEXT fix agrees with wins, so a real move (or a bad "last good") never sticks.
MAX_SPEED_KMH = 400.0          # faster than this between two fixes = a bad fix
SPEED_MIN_KM = 2.0             # GPS jitter is not "speed"
SPEED_WINDOW_S = 3600.0        # only compare against a fix this recent


def km_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 12742.0 * math.asin(min(1.0, math.sqrt(a)))


class JumpGuard:
    def __init__(self):
        self.good: dict[str, tuple[float, float, float]] = {}   # callsign -> (lat, lon, time) last accepted
        self.jump: dict[str, tuple[float, float, float]] = {}   # callsign -> the last fix refused as a jump

    @staticmethod
    def _bad(a, lat, lon, t):
        dt = abs(t - a[2])
        if dt > SPEED_WINDOW_S:
            return None
        km = km_between(a[0], a[1], lat, lon)
        kmh = km / max(dt, 1.0) * 3600
        return (km, kmh) if km > SPEED_MIN_KM and kmh > MAX_SPEED_KMH else None

    def problem(self, call: str, lat: float, lon: float, t: float) -> str | None:
        """Why this fix can't be real, or None -- and then it is the callsign's last good fix."""
        prev = self.good.get(call)
        if prev and prev[0] == lat and prev[1] == lon:
            return None
        refused = self.jump.pop(call, None)
        j = prev and self._bad(prev, lat, lon, t)
        if j and not (refused and self._bad(refused, lat, lon, t) is None and abs(t - refused[2]) <= SPEED_WINDOW_S):
            self.jump[call] = (lat, lon, t)
            return f"jumped {j[0]:.0f} km in {abs(t - prev[2]):.0f} s from its last good fix ({j[1]:.0f} km/h)"
        self.good[call] = (lat, lon, t)
        if len(self.good) > 2000:
            self.good.pop(next(iter(self.good)))
        return None


# ---------------------------------------------------------------- home privacy zone (the page's iGate privacy switch)
PRIVACY_ZONE_M = 250.0                # the zone's radius
PRIVACY_CENTRE_M = (75.0, 150.0)      # how far from home the zone's centre is (random, fixed)
PRIVACY_FILE = os.environ.get("KELLY_IGATE_PRIVACY_FILE") or "~/.kelly-igate-privacy.json"


def base_call(c) -> str:
    return str(c or "").strip().upper().split("-")[0]


def home_of(h) -> tuple[float, float] | None:
    """The page's [lat, lon] for home, or None."""
    try:
        lat, lon = float(h[0]), float(h[1])
    except (TypeError, ValueError, IndexError, KeyError):
        return None
    return (lat, lon) if -90 <= lat <= 90 and -180 <= lon <= 180 and not (abs(lat) < 1e-4 and abs(lon) < 1e-4) else None


def offset(lat: float, lon: float, bearing: float, m: float) -> tuple[float, float]:
    b = math.radians(bearing)
    dlat = m * math.cos(b) / 111320.0
    dlon = m * math.sin(b) / (111320.0 * max(0.01, math.cos(math.radians(lat))))
    return max(-90.0, min(90.0, lat + dlat)), (lon + dlon + 180) % 360 - 180


class PrivacyZone:
    """With the switch on, the iGate owner's own stations (the iGate's base callsign, any SSID) are hidden only near
    home: a position inside the zone goes to APRS-IS as ONE fixed spot, the zone's centre; outside it, exact. The zone
    (PRIVACY_ZONE_M radius) is centred 75-150 m from home in a random direction, fixed and saved: tracks leaving and
    entering it over the weeks outline the zone's circle, so a zone centred ON home would give home away to anyone who
    plotted them -- this way they give away only the centre, and home is somewhere within 150 m of it (and always at
    least 100 m inside the edge). "New spot" (POST /api/igate/privacy) picks a new centre. The home position comes from
    the page (Kelly's own position) and is never saved here or sent anywhere."""

    def __init__(self, path=PRIVACY_FILE, rand=random.random):
        self.path, self.rand, self.bearing, self.dist = os.path.expanduser(path), rand, None, None
        try:
            with open(self.path, encoding="utf-8") as f:
                d = json.load(f)
            self.bearing, self.dist = float(d["bearing"]) % 360, float(d["dist"])   # a 1st-version file (no dist) is replaced
        except (OSError, ValueError, KeyError, TypeError):
            self.bearing = None

    def new(self):
        lo, hi = PRIVACY_CENTRE_M
        self.bearing = round(self.rand() * 360, 1) % 360
        self.dist = round(lo + self.rand() * (hi - lo), 1)
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"bearing": self.bearing, "dist": self.dist}, f)
            os.replace(tmp, self.path)
        except OSError:
            pass   # still fixed for as long as the bridge runs

    def centre(self, home) -> tuple[float, float]:
        if self.dist is None:
            self.new()
        return offset(home[0], home[1], self.bearing, self.dist)

    def place(self, lat: float, lon: float, home) -> tuple[float, float, bool] | None:
        """(lat, lon, inside the zone) to send, or None: no home known yet, so an own position can't be placed safely."""
        if not home:
            return None
        c = self.centre(home)
        if km_between(c[0], c[1], lat, lon) * 1000 <= PRIVACY_ZONE_M:
            return c[0], c[1], True
        return lat, lon, False


def _fmt(v: float, deg_w: int, hemis: str, amb: int) -> str:
    a = abs(v)
    d = math.floor(a)
    m = math.floor((a - d) * 6000 + 0.5) / 100     # = JS Math.round (half up), not Python's banker's round
    if m >= 60:
        d, m = d + 1, 0.0
    s = list(f"{d:0{deg_w}d}{m:05.2f}")
    for i in ([], [-1], [-2, -1], [-4, -2, -1], [-5, -4, -2, -1])[min(max(int(amb or 0), 0), 4)]:
        s[i] = " "
    return "".join(s) + hemis[1 if v < 0 else 0]


def fmt_lat(v, amb=0) -> str:
    return _fmt(float(v), 2, "NS", amb)


def fmt_lon(v, amb=0) -> str:
    return _fmt(float(v), 3, "EW", amb)


def position(lat, lon, sym="/>", amb=0) -> str:
    return fmt_lat(lat, amb) + sym[0] + fmt_lon(lon, amb) + sym[1]


def clean(t, n: int) -> str:
    s = "".join(c for c in str(t or "") if 32 <= ord(c) < 127).replace("|", "").replace("~", "")
    return s[:n].strip()


def packet(src, igate, lat, lon, sym="/>", comment="", amb=0) -> str:
    return f"{src}>{TOCALL},qAO,{igate}:!{position(lat, lon, sym if valid_symbol(sym) else '/>', amb)}{clean(comment, 43)}"


def status_packet(igate, text) -> str:
    return f"{igate}>{TOCALL},TCPIP*:>{clean(text, 62)}"


TLM_RE = re.compile(r"^T#[0-9]{3},((?:[0-9]{3})?,){5}[01]{8}$")
TDEF_RE = re.compile(r"^:([A-Z0-9-]{1,9}) *:(PARM|UNIT|EQNS|BITS)\.[\x20-\x7a\x7d]{0,120}$")   # no { (message id), | or ~


def telemetry_ok(src: str, body: str) -> bool:
    """A telemetry body the page may send for a tracker (= js/igate.js tlmBody / tlmDefs): its T# report, or a
    PARM/UNIT/EQNS/BITS definition addressed to that same station -- never a message to anyone else."""
    if TLM_RE.match(body):
        return all(int(v) <= 255 for v in body[6:].split(",")[:5] if v)
    m = TDEF_RE.match(body)
    return bool(m) and len(body) >= 11 and body[10] == ":" and m.group(1) == src and "|" not in body and "~" not in body


def login_verified(line: str) -> bool:
    """'# logresp VK4XXX-10 verified, server T2X' -> True; 'unverified' -> False."""
    return line.startswith("#") and "logresp" in line and " verified" in line and "unverified" not in line


class TokenBucket:
    def __init__(self, every_s: float, burst: int, clock=time.monotonic):
        self.every, self.burst, self.clock = float(every_s), int(burst), clock
        self.tokens, self.at = float(burst), clock()

    def _fill(self):
        t = self.clock()
        self.tokens = min(self.burst, self.tokens + (t - self.at) / self.every)
        self.at = t

    def take(self) -> bool:
        self._fill()
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False

    def set(self, every_s: float, burst: int):
        self._fill()
        self.every, self.burst = float(every_s), int(burst)
        self.tokens = min(self.tokens, self.burst)


class Backoff:
    """30 s, 60 s, 120 s ... capped at 10 min, each a random 50-100 % of the step (jitter, so iGates don't sync up)."""

    def __init__(self, first=30.0, cap=600.0, rand=random.random):
        self.first, self.cap, self.rand, self.n = first, cap, rand, 0

    def next(self) -> float:
        step = min(self.cap, self.first * (2 ** self.n))
        self.n += 1
        return step * (0.5 + 0.5 * self.rand())

    def worst(self) -> float:
        return self.cap * (0.5 + 0.5 * self.rand())

    def reset(self):
        self.n = 0


RX_FILE = os.environ.get("KELLY_IGATE_RX_FILE") or "~/.kelly-igate-rx.jsonl"
RX_KEEP_S = 24 * 3600
RX_MAX = 5000                              # ~1 MB at most; a busy iGate keeps its newest 5000 lines


class RxLog:
    """The received-packet log (GET /api/igate/rx): one JSON line per offered packet, the last RX_KEEP_S, on disk so it
    survives an internet outage, a page reload and a bridge restart. Exact positions (the owner's own included), so the
    file is mode 600 and the endpoint wants the bridge token like the rest of /api/igate."""

    def __init__(self, path=RX_FILE, clock=time.time):
        self.path, self.clock, self.recs = os.path.expanduser(path), clock, []
        try:
            with open(self.path, encoding="utf-8") as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(r, dict) and isinstance(r.get("t"), (int, float)):
                        self.recs.append(r)
        except OSError:
            pass
        if self.recs:
            self._prune(rewrite=True)

    def _prune(self, rewrite=False):
        cut = self.clock() - RX_KEEP_S
        n = len(self.recs)
        self.recs = [r for r in self.recs if r["t"] >= cut][-RX_MAX:]
        if rewrite or len(self.recs) != n:
            self._rewrite()

    def _rewrite(self):
        try:
            tmp = self.path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.writelines(json.dumps(r, separators=(",", ":")) + "\n" for r in self.recs)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def add(self, rec: dict):
        rec = {"t": round(rec.get("t") or self.clock(), 1), **{k: v for k, v in rec.items() if k != "t" and v is not None}}
        self.recs.append(rec)
        if self.recs[0]["t"] < self.clock() - RX_KEEP_S - 600 or len(self.recs) > RX_MAX + 500:
            self._prune()                       # at most every ~10 min / 500 lines: one whole-file rewrite
            return
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        except OSError:
            pass

    def query(self, hours=24.0, src=None) -> list:
        cut = self.clock() - max(0.0, min(24.0, float(hours))) * 3600
        return [r for r in self.recs if r["t"] >= cut and (not src or r.get("src") == src)]


def rx_record(x: dict, r: dict) -> dict:
    """One /api/igate/send line + its result -> an RxLog record: src, kind, exact position, outcome."""
    rec = {"src": str(x.get("src", "")).strip().upper()[:12] or None, "k": "pos"}
    if "mprs" in x:
        rec["k"] = "mprs"
        try:
            f = meshprs.decode(bytes.fromhex(str(x.get("mprs", ""))))
            rec["src"] = f["src"]
            rec["k"] = {meshprs.POS: "pos", meshprs.STA: "sta", meshprs.TLM: "tlm", meshprs.MSG: "msg"}.get(f["subtype"], "mprs")
            if "lat" in f and not (f["lat"] == 0 and f["lon"] == 0):
                rec["lat"], rec["lon"] = round(f["lat"] * 90 / 2 ** 23, 5), round(f["lon"] * 180 / 2 ** 23, 5)
            if "course" in f:
                rec["crs"], rec["spd"] = round(f["course"] * 360 / 256), f["speed"]     # degrees, km/h
            if "alt" in f:
                rec["alt"] = f["alt"]
            rec["t"] = int(x.get("rxAt")) / 1000
        except (ValueError, TypeError, KeyError, meshprs.Drop):
            pass
    elif "body" in x:
        rec["k"] = "tlm"
    else:
        try:
            lat, lon = float(x.get("lat")), float(x.get("lon"))
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                rec["lat"], rec["lon"] = round(lat, 5), round(lon, 5)
        except (TypeError, ValueError):
            pass
    why = str(r.get("reason") or "")
    rec["r"] = ("dry" if r.get("dry") else "sent") if r.get("ok") else (
        "offline" if why.startswith("APRS-IS") else "held" if why.startswith("privacy") else "off" if "is off" in why
        else why if why in ("rate", "duplicate") else "refused")
    if not r.get("ok") and rec["r"] in ("refused", "offline"):
        rec["why"] = why[:60]
    return rec


def _esc(t) -> str:
    return str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _when(t: float) -> str:
    z = time.strftime("%z", time.localtime(t))
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t)) + z[:3] + ":" + z[3:]


def rx_kml(recs: list, title: str) -> str:
    """The positions in an RxLog query as KML: a folder per station with its track and one placemark per fix."""
    by: dict = {}
    for r in recs:
        if "lat" in r and "lon" in r:
            by.setdefault(r.get("src") or "?", []).append(r)
    folders = []
    for src, rs in sorted(by.items()):
        rs.sort(key=lambda r: r["t"])
        pts = []
        for r in rs:
            d = [time.strftime("%d %b %H:%M:%S", time.localtime(r["t"])), r.get("r", "")]
            if "spd" in r:
                d.append(f"{r['spd']} km/h {r.get('crs', 0)}°")
            if "alt" in r:
                d.append(f"alt {r['alt']} m")
            desc = " · ".join(x for x in d if x)
            style = "pt" if r.get("r") in ("sent", "dry") else "ptx"
            pts.append(f"<Placemark><name>{time.strftime('%H:%M', time.localtime(r['t']))}</name>"
                       f"<description>{_esc(desc)}</description><TimeStamp><when>{_when(r['t'])}</when></TimeStamp>"
                       f"<styleUrl>#{style}</styleUrl><Point><coordinates>{r['lon']},{r['lat']},0</coordinates></Point></Placemark>")
        line = " ".join(f"{r['lon']},{r['lat']},0" for r in rs)
        folders.append(f"<Folder><name>{_esc(src)} ({len(rs)})</name><Placemark><name>{_esc(src)} track</name>"
                       f"<styleUrl>#path</styleUrl><LineString><tessellate>1</tessellate><coordinates>{line}</coordinates>"
                       f"</LineString></Placemark>{''.join(pts)}</Folder>")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            f"<name>{_esc(title)}</name><description>Exact positions heard by this Kelly iGate. Green = sent to APRS-IS; "
            "grey = not sent (held, offline, refused).</description>"
            '<Style id="pt"><IconStyle><color>ff50d050</color><scale>0.8</scale></IconStyle></Style>'
            '<Style id="ptx"><IconStyle><color>ff9a9a9a</color><scale>0.7</scale></IconStyle></Style>'
            '<Style id="path"><LineStyle><color>ff00b4ff</color><width>3</width></LineStyle></Style>'
            f"{''.join(folders)}</Document></kml>\n")


class Igate:
    def __init__(self, verbose=False, first_s=30.0, cap_s=600.0):
        self.verbose = verbose
        self.cfg: dict = {"on": False}
        self.state = "off"
        self.server = ""
        self.verified = False
        self.since = 0.0
        self.retry_at = 0.0
        self.last_error = ""
        self.sent = 0
        self.dropped = {"rate": 0, "offline": 0, "invalid": 0, "duplicate": 0}
        self.mprs_seen: dict = {}          # (originator, seq) -> unix s: MeshPRS frames sent in the last 10 min (spec 10.2)
        self.jumps = JumpGuard()           # impossible position jumps, per station (adverts and MeshPRS share it)
        self.privacy = PrivacyZone()       # the privacy switch: the owner's own stations hidden near home
        self.rx = RxLog()                  # the received-packet log, last 24 h (GET /api/igate/rx)
        self.log: list[list] = []          # [unix s, "> line" | "! reason"]
        self.bucket = TokenBucket(1, 10)
        self.backoff = Backoff(first_s, cap_s)
        self.task: asyncio.Task | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.last_rx = 0.0
        self.wake = asyncio.Event()
        self.alt = False                   # True: this try goes to FALLBACK_SERVER
        self.keeper = lambda: False        # set by the bridge (--keeper-local): the Pi's headless Kelly is on the node
        self.cfg_local = False             # the config in force came from this machine (the keeper)

    def keeper_owns(self) -> bool:
        """The keeper is on the node and its iGate is on: another Kelly stands by (see http())."""
        return bool(self.cfg_local and self.cfg.get("on") and self.keeper())

    # ---------------------------------------------------------------- logging
    def _log(self, line: str, debug=True):
        self.log.append([round(time.time()), line])
        del self.log[:-LOG_MAX]
        if self.verbose or not debug:
            print(f"[igate] {line}", flush=True)

    # ---------------------------------------------------------------- config
    def configure(self, c: dict) -> dict:
        call = str(c.get("call", "")).strip().upper()
        if c.get("on") and not valid_call_ssid(call):
            return {"ok": False, "error": "the iGate callsign must look like VK4XXX-10 (SSID 1-15)"}
        try:
            port = int(c.get("port") or DEFAULT_SERVER[1])
            every, burst = float(c.get("everyS") or 1), int(c.get("burst") or 10)
        except (TypeError, ValueError):
            return {"ok": False, "error": "port / rate must be numbers"}
        if not (1 <= port <= 65535) or not (1 <= every <= 3600) or not (1 <= burst <= 50):
            return {"ok": False, "error": "port 1-65535, one packet every 1-3600 s, burst 1-50"}
        server = re.sub(r"[^A-Za-z0-9.\-:]", "", str(c.get("server") or DEFAULT_SERVER[0]))[:100] or DEFAULT_SERVER[0]
        new = {"on": bool(c.get("on")), "call": call, "pass": re.sub(r"[^0-9-]", "", os.environ.get("KELLY_IGATE_PASS", ""))[:6] or str(passcode(call)),
               "server": server, "port": port, "filter": clean(c.get("filter", ""), 200), "dry": bool(c.get("dry")),
               "vers": re.sub(r"[^0-9A-Za-z.\-]", "", str(c.get("vers", "")))[:16] or "0",
               "status": clean(c.get("status", ""), 62), "statusMin": max(10, min(1440, int(c.get("statusMin") or 30))),
               "privacy": bool(c.get("privacy")), "home": home_of(c.get("home"))}
        live = ("status", "statusMin", "privacy", "home")   # changed without reconnecting
        restart = {k: v for k, v in new.items() if k not in live} != {k: v for k, v in self.cfg.items() if k not in live}
        self.cfg = new
        self.bucket.set(every, burst)
        if restart:
            self._restart()
        return {"ok": True}

    def _restart(self):
        if self.task:
            self.task.cancel()
            self.task = None
        self._close()
        self.verified, self.since, self.retry_at, self.last_error = False, 0.0, 0.0, ""
        self.backoff.reset()
        if not self.cfg.get("on"):
            self.state = "off"
        elif self.cfg.get("dry"):
            self.state = "dry"
            self._log(f"dry run: nothing goes to APRS-IS (as {self.cfg['call']})", debug=False)
        else:
            self.task = asyncio.get_event_loop().create_task(self._run())

    def _close(self):
        if self.writer:
            try:
                self.writer.close()
            except Exception:
                pass
        self.writer = None

    # ---------------------------------------------------------------- the connection
    async def _run(self):
        while self.cfg.get("on") and not self.cfg.get("dry"):
            wait = None
            try:
                wait = await self._session()
            except asyncio.CancelledError:
                self._close()
                raise
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, UnicodeError) as e:
                self.last_error = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
                if not self.since:
                    self.alt = not self.alt    # never got verified there: the next try goes to the other server
            self._close()
            if self.since and time.time() - self.since > 300:
                self.backoff.reset()    # it was up a good while: start again from 30 s
            self.verified, self.since = False, 0.0
            delay = wait if wait is not None else self.backoff.next()
            self.state, self.retry_at = ("unverified" if wait is not None else "waiting"), time.time() + delay
            self._log(f"! {self.last_error or 'disconnected'} -- retry in {round(delay)} s", debug=False)
            await asyncio.sleep(delay)

    async def _session(self) -> float | None:
        """One connection. Returns a delay when the login wasn't verified (retrying won't help soon), else None."""
        c = self.cfg
        host = FALLBACK_SERVER if self.alt and c["server"] != FALLBACK_SERVER else c["server"]
        self.state, self.server = "connecting", f"{host}:{c['port']}"
        bind = os.environ.get("KELLY_IGATE_BIND", "").strip()
        kw = {"local_addr": (bind, 0), "family": socket.AF_INET6 if ":" in bind else socket.AF_INET} if bind else {}
        r, w = await asyncio.wait_for(asyncio.open_connection(host, c["port"], **kw), 15)
        self.writer = w
        peer = w.get_extra_info("peername")
        banner = (await asyncio.wait_for(r.readline(), 15)).decode("latin-1").strip()
        self.server = f"{host}:{c['port']}" + (f" ({peer[0]})" if peer else "")
        login = f"user {c['call']} pass {c['pass']} vers {SOFTWARE} {c['vers']}" + (f" filter {c['filter']}" if c["filter"] else "")
        self.state = "verifying"
        w.write((login + "\r\n").encode("ascii", "replace"))
        await w.drain()
        self._log(f"> user {c['call']} pass **** vers {SOFTWARE} {c['vers']}{' filter ' + c['filter'] if c['filter'] else ''}  ({banner[:60]})")
        deadline = time.time() + 15
        resp = ""
        while time.time() < deadline:
            line = (await asyncio.wait_for(r.readline(), max(0.1, deadline - time.time()))).decode("latin-1").strip()
            if not line:
                raise ConnectionError("closed during login")
            if "logresp" in line:
                resp = line
                break
        self._log(f"< {resp or '(no logresp)'}")
        if not login_verified(resp):
            self.last_error = f"APRS-IS did not verify {c['call']} with that passcode" if resp else "no login reply"
            return self.backoff.worst() if resp else None
        self.verified, self.state, self.since, self.last_rx = True, "up", time.time(), time.time()
        self.last_error = ""
        self._log(f"verified as {c['call']} on {self.server}", debug=False)
        status_at = 0.0
        last_ka = time.time()
        while True:
            # receive-only: what the server sends is read and dropped (never gated to RF -- Kelly has no APRS RF side)
            try:
                line = await asyncio.wait_for(r.readline(), 5)
                if not line:
                    raise ConnectionError("the server closed the connection")
                self.last_rx = time.time()
            except asyncio.TimeoutError:
                pass
            now = time.time()
            if now - self.last_rx > SILENCE_S:
                raise ConnectionError(f"nothing from the server for {SILENCE_S} s")
            if now - last_ka > KEEPALIVE_S:
                w.write(f"#keepalive {SOFTWARE}\r\n".encode())
                await w.drain()
                last_ka = now
            if c["status"] and now - status_at > c["statusMin"] * 60:
                self._write(status_packet(c["call"], c["status"]))
                await w.drain()
                status_at = now

    def _write(self, line: str):
        self.writer.write((line + "\r\n").encode("ascii", "replace"))
        self.sent += 1
        self._log(f"> {line}")

    # ---------------------------------------------------------------- sending
    async def send(self, lines: list) -> list:
        out = []
        for x in lines[:20] if isinstance(lines, list) else []:
            x = x if isinstance(x, dict) else {}
            r = self._one(x)
            out.append(r)
            try:
                self.rx.add(rx_record(x, r))
            except Exception:  # noqa: BLE001 -- the log must never stop gating
                pass
        if self.writer:
            try:
                await self.writer.drain()
            except OSError:
                pass
        return out

    def _one(self, x: dict) -> dict:
        if "mprs" in x:
            return self._mprs(x)
        src = str(x.get("src", "")).strip().upper()
        if "body" in x:                                   # telemetry for a tracker (js/igate.js)
            body = str(x.get("body") or "")
            if not ham_node(src, x.get("name")):
                return self._not_ham(src, x.get("name"))
            if not valid_call_ssid(src) or not telemetry_ok(src, body):
                self.dropped["invalid"] += 1
                self._log(f"! refused telemetry for {src or '?'}: {body[:40]!r}")
                return {"ok": False, "reason": "invalid"}
            return self._out(f"{src}>{TOCALL},qAO,{self.cfg.get('call', '')}:{body}") if self.cfg.get("on") else self._off()
        try:
            lat, lon, amb = float(x.get("lat")), float(x.get("lon")), int(x.get("amb") or 0)
        except (TypeError, ValueError):
            lat = lon = float("nan")
            amb = 0
        if not ham_node(src, x.get("name")):
            return self._not_ham(src, x.get("name"))
        if not valid_call_ssid(src) or not (-90 <= lat <= 90 and -180 <= lon <= 180) or (abs(lat) < 1e-4 and abs(lon) < 1e-4):
            self.dropped["invalid"] += 1
            self._log(f"! refused {src or '?'}: bad callsign or position")
            return {"ok": False, "reason": "invalid"}
        jump = self.jumps.problem(src, lat, lon, time.time())
        if jump:
            return self._jumped(src, jump)
        if not self.cfg.get("on"):
            return self._off()
        if self._private(src):
            p = self.privacy.place(lat, lon, self.cfg.get("home"))
            if not p:
                return self._no_home(src)
            lat, lon = p[0], p[1]
        return self._out(packet(src, self.cfg["call"], lat, lon, str(x.get("sym", "/>")), x.get("comment", ""), amb))

    def _private(self, src) -> bool:
        """The privacy switch is on and this is one of the owner's own stations (the iGate's base callsign)."""
        return bool(self.cfg.get("privacy")) and base_call(src) == base_call(self.cfg.get("call"))

    def _no_home(self, src) -> dict:
        self.dropped["invalid"] += 1
        self._log(f"! held {src}: privacy is on but Kelly has no home position yet (GPS > Fixed position)", debug=False)
        return {"ok": False, "reason": "privacy: no home position"}

    def _mprs(self, x: dict) -> dict:
        """A MeshPRS frame: decoded and rendered again here (meshprs.py), refusing anything the spec never gates."""
        try:
            f = meshprs.decode(bytes.fromhex(str(x.get("mprs", ""))))
            rx = int(x.get("rxAt"))
            why = ("from APRS-IS (G = 1)" if f["g"] else "not to be gated" if f["gating"]
                   else "not an amateur callsign" if not meshprs.amateur_call(f["src"])
                   else "the node's name does not carry this amateur callsign (word 1 or 2)" if not ham_node(f["src"], x.get("name"))
                   else "never gated" if f["subtype"] in (meshprs.QRY, meshprs.NBR) or (f["subtype"] == meshprs.TLM and f["kind"] in (5, 0x10))
                   else "0,0" if f.get("lat") == 0 and f.get("lon") == 0
                   else "receive time is not now" if abs(rx - time.time() * 1000) > 120000 else "")
            if f["subtype"] == meshprs.ACK and not why:
                rec = x.get("record") or {}
                if not (meshprs.CALL_RE.match(str(rec.get("sender", ""))) and re.match(r"^[A-Za-z0-9]{1,5}$", str(rec.get("id", "")))):
                    why = "an ack needs the message it answers"
                f["_record"] = rec
            if not why and f["subtype"] in (meshprs.POS, meshprs.STA) and "lat" in f and self._private(f["src"]):
                p = self.privacy.place(f["lat"] * 90 / 2 ** 23, f["lon"] * 180 / 2 ** 23, self.cfg.get("home"))
                if not p:
                    return self._no_home(f["src"])
                if p[2]:                          # inside the zone: the fixed spot, parked (no course / speed)
                    f["lat"] = max(-2 ** 23, min(2 ** 23 - 1, round(p[0] * 2 ** 23 / 90)))
                    f["lon"] = max(-2 ** 23, min(2 ** 23 - 1, round(p[1] * 2 ** 23 / 180)))
                    f.pop("course", None)
                    f.pop("speed", None)
            info = "" if why else meshprs.render(f, {"rxAt": rx})
        except (ValueError, TypeError, meshprs.Drop) as e:
            why = getattr(e, "reason", None) or "not a MeshPRS frame"
        if why:
            self.dropped["invalid"] += 1
            self._log(f"! refused MeshPRS frame: {why}")
            return {"ok": False, "reason": "invalid"}
        if f["subtype"] in (meshprs.POS, meshprs.STA) and "lat" in f:   # the originator's own position (an object is elsewhere)
            jump = self.jumps.problem(f["src"], f["lat"] * 90 / 2 ** 23, f["lon"] * 180 / 2 ** 23, rx / 1000)
            if jump:
                return self._jumped(f["src"], jump)
        if not self.cfg.get("on"):
            return self._off()
        # spec 10.2: one APRS-IS line per (originator, seq), retries included, here as well as in each Kelly -- a reloaded
        # Kelly, or two Kellys on one bridge, would each send a frame once (2026-10-31: a status and its retry both gated)
        now = time.time()
        self.mprs_seen = {k: t for k, t in self.mprs_seen.items() if now - t < 600}
        dk = (f["key"] or f["src"], f["seq"])
        if dk in self.mprs_seen:
            self.dropped["duplicate"] += 1
            self._log(f"! MeshPRS duplicate (seq {f['seq']}, retry {f.get('retry', 0)}) from {f['src']} -- already sent")
            return {"ok": False, "reason": "duplicate"}
        r = self._out(f"{f['src']}>{TOCALL},qAO,{self.cfg['call']}:{info}")
        if r.get("ok"):
            self.mprs_seen[dk] = now
        return r

    def _not_ham(self, src, name) -> dict:
        self.dropped["invalid"] += 1
        self._log(f"! refused {src or '?'}: node name {str(name or '')[:32]!r} does not carry that amateur callsign as its first or second word")
        return {"ok": False, "reason": "not an amateur station"}

    def _jumped(self, src, why) -> dict:
        self.dropped["invalid"] += 1
        self._log(f"! refused {src}: impossible position, {why}", debug=False)
        return {"ok": False, "reason": "impossible position"}

    def _off(self) -> dict:
        self.dropped["offline"] += 1
        return {"ok": False, "reason": "the iGate is off"}

    def _out(self, line: str) -> dict:
        if self.cfg.get("dry"):
            self._log(f"> (dry run) {line}", debug=False)
            return {"ok": True, "dry": True, "packet": line}
        if not (self.verified and self.writer):
            self.dropped["offline"] += 1
            self._log(f"! not sent (APRS-IS {self.state}): {line}")
            return {"ok": False, "reason": f"APRS-IS {self.state}", "packet": line}
        if not self.bucket.take():
            self.dropped["rate"] += 1
            self._log(f"! rate-limited: {line}")
            return {"ok": False, "reason": "rate", "packet": line}
        self._write(line)
        return {"ok": True, "packet": line}

    def status(self) -> dict:
        now = time.time()
        return {"state": self.state, "on": bool(self.cfg.get("on")), "dry": bool(self.cfg.get("dry")), "call": self.cfg.get("call", ""),
                "server": self.server, "verified": self.verified, "since": self.since, "uptime": round(now - self.since) if self.since else 0,
                "retryIn": max(0, round(self.retry_at - now)) if self.state in ("waiting", "unverified") else 0,
                "error": self.last_error, "sent": self.sent, "dropped": dict(self.dropped), "log": self.log[-LOG_MAX:], "tocall": TOCALL,
                "keeper": self.keeper_owns(),
                "privacy": {"on": bool(self.cfg.get("privacy")), "base": base_call(self.cfg.get("call")), "zoneM": PRIVACY_ZONE_M,
                            "home": bool(self.cfg.get("home")), "bearing": self.privacy.bearing, "dist": self.privacy.dist}}


KEEPER_HOLDS = "the Pi keeper is this station's iGate -- it gates while this Kelly uses the node"


async def http(ig: Igate, method: str, path: str, headers: dict, reader, writer, allowed: bool,
               local: bool = False, query: str = ""):
    """/api/igate[/config|/send] for kelly_bridge.handle(). local = from this machine; ig.keeper() = the Pi's headless
    Kelly (--keeper-local) is on the node. While it is, and it turned the iGate on, the iGate is ITS: another Kelly's
    config and sends are refused (two pages would fight over one connection's callsign / privacy, and gate twice);
    status "keeper": true tells that page to stand by. A page on this machine is the keeper."""
    cors = ("Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Content-Type, X-Kelly-Token\r\n")
    if method == "OPTIONS":
        writer.write(f"HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\n\r\n".encode())
        await writer.drain()
        writer.close()
        return
    status, out = "200 OK", {}
    if not allowed:
        status, out = "403 Forbidden", {"error": "token"}
    else:
        req = {}
        if method == "POST":
            try:
                n = int(headers.get("content-length", "0") or 0)
                req = json.loads((await reader.readexactly(n)).decode("utf-8")) if 0 < n < 16384 else {}
            except (ValueError, asyncio.IncompleteReadError):
                status, out = "400 Bad Request", {"error": "bad JSON"}
        held = not local and ig.keeper_owns()
        if status.startswith("200"):
            if path == "/api/igate/config" and method == "POST" and held:
                out = {"ok": False, "error": KEEPER_HOLDS, "status": ig.status()}
            elif path == "/api/igate/config" and method == "POST":
                out = ig.configure(req if isinstance(req, dict) else {})
                if out.get("ok"):
                    ig.cfg_local = local
                out = {**out, "status": ig.status()}
            elif path == "/api/igate/send" and method == "POST" and held:
                n = len(req.get("lines") or []) if isinstance(req, dict) and isinstance(req.get("lines"), list) else 0
                out = {"results": [{"ok": False, "reason": "keeper"}] * min(n, 20), "status": ig.status()}
            elif path == "/api/igate/send" and method == "POST":
                out = {"results": await ig.send(req.get("lines") if isinstance(req, dict) else []), "status": ig.status()}
            elif path == "/api/igate/privacy" and method == "POST" and held:
                status, out = "409 Conflict", {"error": KEEPER_HOLDS}
            elif path == "/api/igate/privacy" and method == "POST":     # "New spot": a new fixed direction
                ig.privacy.new()
                ig._log(f"privacy: new zone centre, {ig.privacy.dist:.0f} m from home at {ig.privacy.bearing:.0f} deg", debug=False)
                out = ig.status()
            elif path == "/api/igate" and method == "GET":
                out = ig.status()
            elif path == "/api/igate/rx" and method == "GET":
                q = {k: v[0] for k, v in parse_qs(query).items()}
                try:
                    hours = float(q.get("hours", 24))
                except ValueError:
                    hours = 24.0
                src = q.get("src", "").strip().upper() or None
                recs = ig.rx.query(hours, src)
                if q.get("format") == "kml":
                    body = rx_kml(recs, f"{src or 'Kelly iGate'} - last {hours:g} h").encode()
                    name = f"{(src or 'igate').lower()}-{time.strftime('%Y%m%d-%H%M')}.kml"
                    writer.write(f"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.google-earth.kml+xml\r\n{cors}"
                                 f"Content-Disposition: attachment; filename=\"{name}\"\r\nCache-Control: no-cache\r\n"
                                 f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
                    await writer.drain()
                    writer.close()
                    return
                out = {"hours": hours, "src": src, "count": len(recs), "recs": recs}
            else:
                status, out = "404 Not Found", {"error": "no such iGate call"}
    body = json.dumps(out).encode()
    writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{cors}Cache-Control: no-cache\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
    await writer.drain()
    writer.close()
