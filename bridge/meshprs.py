"""MeshPRS frame codec and APRS-IS rendering (spec MeshPRS/spec/MeshPRS-Spec.md, 1.0 Candidate). Stdlib only.

Twin of js/meshprs.js: both run the shared vectors in MeshPRS/test-vectors/ (frames.json, gateway.json) -- one
protocol in two languages, keep them in step (test_meshprs.py, tests/meshprs-tests.html).

  decode(blob)          blob bytes -> frame dict, or raises Drop(reason) (spec §9.5 receive validation)
  encode(frame)         frame dict -> blob bytes (the inverse; stations and vectors)
  check(blob, cfg)      the STATELESS part of the spec §10.1 pipeline (steps 1-4: decode, loop/gating, trust, position
                        validity) then render (§10.3) -> the APRS-IS line, or raises Drop(reason). Replay, duplicates,
                        interval, queue and rate are stateful and belong to the gate that owns the clock.
  cfg = { igate: 'VK4XXX-10', bindings: [{call: 'VK4ABC', key: hex}], records: [ack records], rxAt: ms, testServer }

Implemented subtypes: the 1.0 required set (decision 0007) -- 0x00 position, 0x01 message, 0x02 ack, 0x03 telemetry,
0x05 object/item, 0x07 query (parsed, never gated), 0x09 status. 0x04 weather, 0x06 bulletin and 0x08 neighbour report
are optional and not implemented here, so they drop as 'unknown subtype' (decision 0007).
"""
import hashlib
import re
import time

TOCALL = "APZKPG"
DATA_TYPE = 0xFF4D                      # GRP_DATA data type (development value, decision 0012)
CHANNEL = "#meshprs"
ALPHA = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/."
MAX40 = 40 ** 9
POS, MSG, ACK, TLM, WX, OBJ, BLN, QRY, NBR, STA = range(10)
STATUS_NAMES = ["OFF DUTY", "EN ROUTE", "IN SERVICE", "RETURNING", "COMMITTED", "SPECIAL", "PRIORITY", "EMERGENCY",
                None, "EMERGENCY CANCELLED"]
TLM_KINDS = {1: "PARM", 2: "UNIT", 3: "EQNS", 4: "BITS"}
CALL_RE = re.compile(r"^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$")         # any APRS-IS source shape (G = 1 frames)
BASE_RE = re.compile(r"^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$")           # = igate.js validBase


class Drop(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


# ---------------------------------------------------------------- callsigns (§4.1, M17 base-40, big-endian)
def call_encode(text):
    text = text.upper()
    if not 1 <= len(text) <= 9 or any(c not in ALPHA for c in text):
        raise ValueError(f"not encodable: {text!r}")
    v = 0
    for c in reversed(text):
        v = v * 40 + ALPHA.index(c)
    return v.to_bytes(6, "big")


def call_decode(b):
    v = int.from_bytes(b, "big")
    if v == 0 or v >= MAX40:
        raise Drop("bad callsign")
    s = ""
    while v:
        v, r = divmod(v, 40)
        s += ALPHA[r]
    if not CALL_RE.match(s):
        raise Drop("bad callsign")
    return s


def amateur_call(c):
    """§4.2: an amateur base callsign (validBase), then optionally '-' and a 1-2 character alphanumeric SSID."""
    base, _, ssid = c.partition("-")
    return len(base) <= 6 and bool(BASE_RE.match(base)) and (not _ or bool(re.match(r"^[A-Z0-9]{1,2}$", ssid)))


def to_hash(call):
    """§6.2 ack 'to hash': the first 2 bytes of SHA-256 of the 6-byte encoded callsign."""
    return hashlib.sha256(call_encode(call)).digest()[:2]


# ---------------------------------------------------------------- positions (§5.1 encoding, §10.3 rendering)
def deg_to_raw(x, span):
    """Stations: v = sign(x) * floor(|x| * 2^23 / span + 0.5), clamped to i24 (span 90 lat, 180 lon)."""
    v = int(abs(x) * 2 ** 23 / span + 0.5)
    v = min(v, 2 ** 23 - 1) if x >= 0 else min(v, 2 ** 23)
    return v if x >= 0 else -v


def _fmt(v, mul, width, hemis, amb):
    hm = (abs(v) * mul * 2 + 2 ** 23) // 2 ** 24
    s = list(str(hm // 6000).zfill(width) + f"{(hm % 6000) // 100:02d}.{hm % 100:02d}")
    for i in [[], [-1], [-2, -1], [-4, -2, -1], [-5, -4, -2, -1]][amb]:
        s[len(s) + i] = " "
    return "".join(s) + hemis[1 if v < 0 else 0]


def fmt_lat(v, amb=0):
    return _fmt(v, 540000, 2, "NS", amb)


def fmt_lon(v, amb=0):
    return _fmt(v, 1080000, 3, "EW", amb)


def valid_symbol(s):
    return len(s) == 2 and (s[0] in "/\\" or s[0].isdigit() or "A" <= s[0] <= "Z") and 0x21 <= ord(s[1]) <= 0x7E


# ---------------------------------------------------------------- text (§9.6)
def _text(b, forbid="|~"):
    if any(c < 0x20 or c > 0x7E for c in b):
        raise Drop("bad text")
    t = b.decode("ascii")
    if any(c in t for c in forbid):
        raise Drop("bad text")
    return t


def _i24(b):
    return int.from_bytes(b, "little", signed=True)


class _R:
    """A cursor over the blob; running past the end is 'short frame'."""
    def __init__(self, b, i):
        self.b, self.i = b, i

    def take(self, n):
        if self.i + n > len(self.b):
            raise Drop("short frame")
        out = self.b[self.i:self.i + n]
        self.i += n
        return out

    def u8(self):
        return self.take(1)[0]

    def rest(self):
        out = self.b[self.i:]
        self.i = len(self.b)
        return out


# ---------------------------------------------------------------- decode (§9.3, §9.5 and the subtype layouts)
def decode(blob):
    blob = bytes(blob)
    if len(blob) < 9:
        raise Drop("short frame")
    h = blob[0]
    f = {"version": h >> 6, "g": (h >> 5) & 1, "k": (h >> 4) & 1, "gating": (h >> 2) & 3, "retry": h & 3,
         "subtype": blob[1], "seq": blob[2]}
    if f["k"] and len(blob) < 13:
        raise Drop("short frame")
    if f["version"] > 1:                     # 1 = 1.0 Candidate; 0 = Draft 0.1, same layout, accepted until 1.0 final
        raise Drop("unknown version")
    f["src"] = call_decode(blob[3:9])
    f["key"] = blob[9:13].hex().upper() if f["k"] else None
    st, r = f["subtype"], _R(blob, 13 if f["k"] else 9)
    if 0xE0 <= st <= 0xFE:
        raise Drop("experimental subtype")
    if st not in (POS, MSG, ACK, TLM, OBJ, QRY, STA):
        raise Drop("unknown subtype")
    if st == POS:
        f["lat"], f["lon"] = _i24(r.take(3)), _i24(r.take(3))
        f["sym"] = _sym(r.take(2))
        pf = r.u8()
        amb = (pf >> 3) & 7
        if amb > 4:
            raise Drop("bad field")
        if pf & 0x80:
            raise Drop("unknown flag")
        f["amb"], f["msg"] = amb, (pf >> 6) & 1
        if pf & 1:
            f["alt"] = int.from_bytes(r.take(2), "little", signed=True)
        if pf & 2:
            f["course"], f["speed"] = r.u8(), r.u8()
        if pf & 4:
            f["ts"] = int.from_bytes(r.take(4), "little")
        f["comment"] = _text(r.rest())
    elif st == MSG:
        f["to"] = call_decode(r.take(6))
        f["msgno"] = r.u8()
        if f["msgno"] > 127:
            raise Drop("bad field")
        f["text"] = _text(r.rest(), "{|~")
        if not 1 <= len(f["text"]) <= 67:
            raise Drop("bad text")
    elif st == ACK:
        f["ackSeq"] = r.u8()
        b = r.u8()
        f["msgno"], f["rej"] = b & 0x7F, b >> 7
        f["toHash"] = r.take(2).hex().upper()
        if r.rest():
            raise Drop("bad field")
    elif st == TLM:
        kind = f["kind"] = r.u8()
        if kind == 0:
            mask = r.u8()
            if mask & 0x60:
                raise Drop("unknown flag")
            f["a"] = [r.u8() if mask & (1 << i) else None for i in range(5)]
            f["bits"] = format(r.u8(), "08b") if mask & 0x80 else None
            if r.rest():
                raise Drop("bad field")
        elif kind in TLM_KINDS:
            f["text"] = _text(r.rest(), "{|~")
        elif kind == 5:
            f["profile"] = int.from_bytes(r.take(2), "little")
        elif kind == 0x10:
            f["lpp"] = r.rest().hex().upper()
        else:
            raise Drop("bad field")
    elif st == OBJ:
        of = r.u8()
        n = of >> 4
        if of & 8:
            raise Drop("unknown flag")
        f["live"], f["item"] = of & 1, (of >> 1) & 1
        if not 1 <= n <= 9 or (f["item"] and n < 3):
            raise Drop("bad field")
        f["name"] = _text(r.take(n))
        f["lat"], f["lon"] = _i24(r.take(3)), _i24(r.take(3))
        f["sym"] = _sym(r.take(2))
        if of & 4:
            f["ts"] = int.from_bytes(r.take(4), "little")
        f["comment"] = _text(r.rest())
    elif st == QRY:
        q = r.u8()
        f["qtype"] = q & 0x7F
        if q & 0x80:
            f["target"] = call_decode(r.take(6))
        if f["qtype"] > 5 or r.rest():
            raise Drop("bad field")
    elif st == STA:
        c = r.u8()
        if c & 0x70:
            raise Drop("unknown flag")
        f["code"] = c & 0x0F
        if f["code"] > 9:
            raise Drop("bad field")
        if c & 0x80:
            f["lat"], f["lon"] = _i24(r.take(3)), _i24(r.take(3))
        f["text"] = _text(r.rest())
        if len(f["text"]) > 62:
            raise Drop("bad text")
    return f


def _sym(b):
    s = b.decode("latin-1")
    if not valid_symbol(s):
        raise Drop("bad field")
    return s


# ---------------------------------------------------------------- encode (the inverse)
def _i24b(v):
    return int(v).to_bytes(3, "little", signed=True)


def encode(f):
    k = 1 if f.get("key") else 0
    out = bytearray([(f.get("version", 1) << 6) | (f.get("g", 0) << 5) | (k << 4) | (f.get("gating", 0) << 2)
                     | f.get("retry", 0), f["subtype"], f["seq"]])
    out += call_encode(f["src"])
    if k:
        out += bytes.fromhex(f["key"])
    st = f["subtype"]
    if st == POS:
        pf = (1 if "alt" in f else 0) | (2 if "course" in f else 0) | (4 if "ts" in f else 0) \
            | (f.get("amb", 0) << 3) | (f.get("msg", 0) << 6)
        out += _i24b(f["lat"]) + _i24b(f["lon"]) + f["sym"].encode("latin-1") + bytes([pf])
        if "alt" in f:
            out += int(f["alt"]).to_bytes(2, "little", signed=True)
        if "course" in f:
            out += bytes([f["course"], f["speed"]])
        if "ts" in f:
            out += int(f["ts"]).to_bytes(4, "little")
        out += f.get("comment", "").encode("ascii")
    elif st == MSG:
        out += call_encode(f["to"]) + bytes([f["msgno"]]) + f["text"].encode("ascii")
    elif st == ACK:
        out += bytes([f["ackSeq"], f["msgno"] | (f.get("rej", 0) << 7)]) + bytes.fromhex(f["toHash"])
    elif st == TLM:
        out.append(f["kind"])
        if f["kind"] == 0:
            mask = sum(1 << i for i, a in enumerate(f["a"]) if a is not None) | (0x80 if f.get("bits") else 0)
            out.append(mask)
            out += bytes(a for a in f["a"] if a is not None)
            if f.get("bits"):
                out.append(int(f["bits"], 2))
        elif f["kind"] in TLM_KINDS:
            out += f["text"].encode("ascii")
        elif f["kind"] == 5:
            out += int(f["profile"]).to_bytes(2, "little")
        else:
            out += bytes.fromhex(f.get("lpp", ""))
    elif st == OBJ:
        name = f["name"].encode("ascii")
        out.append((len(name) << 4) | (4 if "ts" in f else 0) | (f.get("item", 0) << 1) | f.get("live", 1))
        out += name + _i24b(f["lat"]) + _i24b(f["lon"]) + f["sym"].encode("latin-1")
        if "ts" in f:
            out += int(f["ts"]).to_bytes(4, "little")
        out += f.get("comment", "").encode("ascii")
    elif st == QRY:
        out.append(f["qtype"] | (0x80 if f.get("target") else 0))
        if f.get("target"):
            out += call_encode(f["target"])
    elif st == STA:
        pos = "lat" in f
        out.append(f["code"] | (0x80 if pos else 0))
        if pos:
            out += _i24b(f["lat"]) + _i24b(f["lon"])
        out += f.get("text", "").encode("ascii")
    else:
        raise ValueError(f"subtype {st} not implemented")
    return bytes(out)


# ---------------------------------------------------------------- render (§10.3)
def _fit(parts_text, limit):
    """Trim, truncate to the limit, trim trailing spaces again (§10.3 Text)."""
    return parts_text.strip()[:limit].rstrip()


def _pos_ext(f):
    ext = ""
    if "course" in f:
        c = (f["course"] * 720 + 256) // 512
        ext += f"{c or 360:03d}/{(f['speed'] * 2000 + 1852) // 3704:03d}"
    if "alt" in f:
        a = f["alt"]
        ft = (abs(a) * 20000 + 3048) // 6096
        ext += "/A=" + (f"{ft:06d}" if a >= 0 else "-" + f"{min(ft, 99999):05d}")
    return ext


def _latlon(lat, lon, sym, amb=0):
    return fmt_lat(lat, amb) + sym[0] + fmt_lon(lon, amb) + sym[1]


def _addressee(c):
    return c.ljust(9)


def _ddhhmm(sec):
    t = time.gmtime(sec)
    return f"{t.tm_mday:02d}{t.tm_hour:02d}{t.tm_min:02d}z"


def render(f, cfg):
    """The info field for a frame that passed the checks (§5.3, §6.5, §7.3, §8.2, §8.4, §10.3)."""
    st = f["subtype"]
    if st == POS:
        ext = _pos_ext(f)
        tail = _fit(ext + f["comment"].strip(), 43) if ext else _fit(f["comment"], 43)
        return ("=" if f["msg"] else "!") + _latlon(f["lat"], f["lon"], f["sym"], f["amb"]) + tail
    if st == MSG:
        return f":{_addressee(f['to'])}:{f['text']}" + (f"{{{f['msgno']}" if f["msgno"] else "")
    if st == ACK:
        rec = f["_record"]
        return f":{_addressee(rec['sender'])}:{'rej' if f['rej'] else 'ack'}{rec['id']}"
    if st == TLM:
        if f["kind"] == 0:
            a = ",".join("" if v is None else f"{v:03d}" for v in f["a"])
            return f"T#{f['seq']:03d},{a},{f['bits'] or '00000000'}"
        return f":{_addressee(f['src'])}:{TLM_KINDS[f['kind']]}.{f['text']}"
    if st == OBJ:
        rx = cfg["rxAt"] // 1000
        ts = f["ts"] if "ts" in f and abs(f["ts"] - rx) <= 3600 else rx
        pos = _latlon(f["lat"], f["lon"], f["sym"])
        c = _fit(f["comment"], 43)
        if f["item"]:
            return f")" + f["name"] + ("!" if f["live"] else "_") + pos + c
        return ";" + f["name"].ljust(9) + ("*" if f["live"] else "_") + _ddhhmm(ts) + pos + c
    if st == STA:
        if f["code"] == 8:
            return ">" + _fit(f["text"], 62)
        name = STATUS_NAMES[f["code"]]
        if "lat" in f:
            return "!" + _latlon(f["lat"], f["lon"], "/>") + _fit(f"{name} {f['text']}", 43)
        return ">" + _fit(f"{name} {f['text']}", 62)
    raise Drop("not gated")


# ---------------------------------------------------------------- the stateless gate (§10.1 steps 1-4)
def _binding(cfg, call):
    base = call.split("-")[0]
    return [b for b in cfg.get("bindings", []) if b["call"].upper() == base]


def check(blob, cfg):
    f = decode(blob)                                                   # 1. decode and validate
    if not f["g"] and not amateur_call(f["src"]):
        raise Drop("bad callsign")
    if f["g"]:                                                         # 2. loop and gating
        raise Drop("looped")
    if f["gating"] in (1, 3):
        raise Drop("nogate")
    if f["gating"] == 2 and not cfg.get("testServer"):
        raise Drop("test")
    if f["subtype"] in (QRY, NBR):
        raise Drop("not gated")
    if f["subtype"] == TLM and f["kind"] in (5, 0x10):
        raise Drop("not gated")                                        # no profile registry yet (Q28)
    binds = _binding(cfg, f["src"])                                    # 3. trust
    if not binds:
        raise Drop("untrusted")
    if f["subtype"] == ACK:
        rec = next((r for r in cfg.get("records", []) if r["seq"] == f["ackSeq"] and r["msgno"] == f["msgno"]
                    and r["toHash"].upper() == f["toHash"] and r["addressee"] == f["src"]), None)
        if not rec:
            raise Drop("unknown ack")
        f["_record"] = rec
        if f["k"] and not any(b["key"].upper().startswith(f["key"]) for b in binds):
            raise Drop("key mismatch")
    else:
        if not f["k"]:
            raise Drop("no key")
        if not any(b["key"].upper().startswith(f["key"]) for b in binds):
            raise Drop("key mismatch")
    if "lat" in f and f["lat"] == 0 and f["lon"] == 0:               # 4. validity (stateless part)
        raise Drop("0,0")
    return f"{f['src']}>{TOCALL},qAO,{cfg['igate']}:{render(f, cfg)}"
