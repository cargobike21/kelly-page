"""Checks for the bridge's radio-write gate (kelly_bridge.radio_feature / Hub.to_radio) and the REFUSAL switch.
Run: python test_kelly_gate.py"""
import asyncio
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import kelly_ent  # noqa: E402
import kelly_bridge as kb  # noqa: E402

fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


def frame(ident, params=""):
    body = f"{ident}{len(params):02X}{params}"
    return (body + f"{(-sum(body.encode())) & 0xFF:02X}\r").encode()


F = kb.radio_feature
check("classifier: queries / local control / calls are open",
      all(F(frame(i, p)) is None for i, p in (("q", "01"), ("g", "05"), ("d", "5101"), ("d", "4123"))))
check("classifier: selcall / DTMF = radio.testtx", F(frame("d", "012345")) == "radio.testtx" and F(frame("d", "1abc")) == "radio.testtx")
check("a command left out of the build is refused in every build", kelly_ent.reason("build.removed") == "ENT_NOT_IN_BUILD")
check("classifier: emergency alarm service is never gated", F(frame("d", "69,1234")) is None)
check("classifier: CCR transmit = ccr.tx", F(frame("T", "4380000")) == "ccr.tx" and F(frame("U", "A1234567")) == "ccr.tx" and F(frame("U", "ZA1")) == "ccr.tx")
check("classifier: raw TSBK = p25.transparent", F(frame("U", "ZGabcd")) == "p25.transparent")
check("classifier: Tait programming entry bytes = tait.program", F(b"^") == "tait.program" and F(b"#") == "tait.program")
check("classifier: a frame with a bad checksum or size is not CCDI (an SSTV burst is never misread)",
      F(frame("T", "4380000")[:-3] + b"00\r") is None and F(b"T05abc\r") is None and F(bytes([0x85, 0x01, 0x0D])) is None and F(bytes(range(256))) is None)
check("classifier: escapes, CR and junk are open", all(F(b) is None for b in (b"\r", b"+++", b"", b"zzz", b"\x1b")))

# ---- the gate in Hub.to_radio
class Args:
    serial = None
    verbose = False
    tcp = None


class Writer:
    def __init__(self):
        self.out = []

    def write(self, d):
        self.out.append(d)

    async def drain(self):
        pass


class FakeHub:
    """Just enough of the Hub for to_radio: tcp_writer, args, notice."""
    def __init__(self):
        self.args, self.tcp_writer, self.notices = Args(), Writer(), []

    async def notice(self, text):
        self.notices.append(text)


def push(data):
    hub = FakeHub()
    asyncio.run(kb.Hub.to_radio(hub, data))
    return hub


tt = frame("d", "012345")                      # a selcall
kelly_ent.BUILD = "public"
kelly_ent.set_token(None)
kb.REFUSAL = "silent"
h = push(tt)
check("public + silent: refused write sends nothing and says nothing", h.tcp_writer.out == [] and h.notices == [], (h.tcp_writer.out, h.notices))
kb.REFUSAL = "message"
h = push(tt)
check("public + message: refused write sends nothing and tells the page", h.tcp_writer.out == [] and h.notices == [kb.REFUSAL_TEXT], (h.tcp_writer.out, h.notices))
check("the message is the page's text", kb.REFUSAL_TEXT == "Available to registered P25X members. Register at kellypage.app")
h = push(b"^")
check("public: Tait programming entry refused", h.tcp_writer.out == [])
h = push(frame("g", "05"))
check("public: an open command passes", h.tcp_writer.out == [frame("g", "05")], h.tcp_writer.out)
kelly_ent.set_token({"sub": "VK9TST", "feat": ["radio.testtx", "tait.program"], "exp": time.time() + 3600})
h = push(tt)
check("public + token naming radio.testtx: passes", h.tcp_writer.out == [tt])
h = push(b"^")
check("public + token naming tait.program: entry passes", h.tcp_writer.out == [b"^"])
h = push(frame("T", "4380000"))
check("public + token without ccr.tx: refused", h.tcp_writer.out == [])
kelly_ent.set_token(None)
kelly_ent.BUILD = "private"
kb.REFUSAL = "silent"
h = push(tt)
check("private build: everything passes", h.tcp_writer.out == [tt])

# ---- parity with the page: the same table runs against js/entitlements.js ccdiFeature (tests/entitlements-test.js)
import json  # noqa: E402
RV = json.loads((HERE / "radio_feature_vectors.json").read_text(encoding="utf-8"))
bad = [c for c in RV["cases"] if F(frame(c[0], c[1])) != c[2]]
check("parity table: every case classifies as the page does", not bad, bad)
check("entry bytes: bare, with a CR, either one", F(b"^") == F(b"#") == F(b"^\r") == F(b"\r^") == "tait.program")
check("entry bytes: a long data burst containing '^' is not programming", F(b"x" * 20 + b"^") is None)

# ---- revocation list (kellypage.app/api/revoked) -> ENT_REVOKED; token serial binding -> ENT_SERIAL
V = json.loads((HERE / "ent_token_vectors.json").read_text(encoding="utf-8"))
kelly_ent.KEYS.update(V["keys"])
good = next(c for c in V["revocations"] if c["name"] == "good, first fetch")
kelly_ent.BUILD = "public"
kb._rev_seq = 0
tok = {"sub": "VK9TST", "jti": good["revoked_jti"], "dev": "devkey", "feat": ["tait.program", "radio.testtx"], "exp": time.time() + 3600}
kelly_ent.set_token(tok)
check("revocation: before the list, allowed", kelly_ent.allowed("radio.testtx"))
check("revocation: a good list that names this jti is accepted", kb.apply_revocation(good["doc"]) is None and kb._rev_seq == 7)
check("revocation: the feature is refused as ENT_REVOKED", kelly_ent.reason("radio.testtx") == "ENT_REVOKED", kelly_ent.reason("radio.testtx"))
check("revocation: and the bridge refuses the write", push(frame("d", "012345")).tcp_writer.out == [])
kelly_ent.set_token({**tok, "jti": "ffffffffffffffff"})
check("revocation: a refreshed token (new jti) is checked against the held list", kelly_ent.allowed("radio.testtx"))
kelly_ent.set_token({**tok, "jti": "x", "dev": good["revoked_dev"]})
check("revocation: a revoked device key counts too", kelly_ent.reason("radio.testtx") == "ENT_REVOKED")
older = [c for c in V["revocations"] if c.get("reason") == "REV_OLD"]
kb._rev_seq = 8                                # (the vector's list is seq 7: older than the 8 we have seen)
check("revocation: an older seq is refused and the held list stays", bool(older) and kb.apply_revocation(older[0]["doc"]) == "REV_OLD" and kb._rev_seq == 8)
check("revocation: junk is refused, never raises", kb.apply_revocation("nope") == "REV_FORMAT")
kelly_ent.set_revocations(None)
bound = {**tok, "jti": "ffffffffffffffff", "ser": ["12345678"]}
kelly_ent.set_token(bound)
check("serial: unknown serial is not checked yet", kelly_ent.allowed("radio.testtx"))
kb.note_radio_serial(frame("n", "99999999"))
check("serial: another radio's serial -> ENT_SERIAL", kelly_ent.reason("radio.testtx") == "ENT_SERIAL")
kb.note_radio_serial(frame("n", "12345678"))
check("serial: the bound radio -> allowed", kelly_ent.allowed("radio.testtx"))
kb.note_radio_serial(b"n08abcdefgh00\r")
check("serial: a reply with a bad checksum is ignored", kelly_ent.allowed("radio.testtx"))
kelly_ent.set_serial(None)
kelly_ent.set_token(None)
kelly_ent.BUILD = "private"

print("RESULT: " + ("FAIL (" + ", ".join(fails) + ")" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
