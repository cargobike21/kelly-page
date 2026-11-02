"""Checks for the /mesh private-key guard (PrivateKeyGuard): a bridge token must not be enough to copy or replace a
MeshCore node's identity (kelly-page/QR_REVIEW.md, bridge hole; review/qr-06-final-review.md F2).
Run: python3 bridge/test_kelly_mesh_guard.py  (stdlib only; prints RESULT: ALL PASS / FAIL)

Covers: CMD_EXPORT_PRIVATE_KEY (23) and CMD_IMPORT_PRIVATE_KEY (24) frames refused, alone, after other frames, after
junk bytes, and split across two WebSocket messages; the review's bypasses (an oversize frame, a non-zero high length
byte, a retry after a refusal) and random byte soup, each replayed through MeshCore's own frame parser
(ArduinoSerialInterface::checkRecvFrame, emulated in node_runs) to show the node never runs one; one guard shared by
two clients; the filler that squares a node and the guard up after a reopen; ordinary companion frames passed on;
Meshtastic (94 C3) and KISS (C0) streams passed on once the node has said what it is."""
import os
import random
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kelly_bridge as kb  # noqa: E402

passed = failed = 0


def t(name, ok):
    global passed, failed
    if ok:
        passed += 1
    else:
        failed += 1
        print(f"FAIL {name}")


def frame(payload: bytes) -> bytes:
    return b"<" + struct.pack("<H", len(payload)) + payload


def one(data: bytes) -> bool:
    return kb.PrivateKeyGuard().feed(data)


class Pass:
    def check(self, _):
        return True


def node_runs(chunks, guard=None):
    """What the guard lets through, into the firmware's parser (MAX_FRAME_SIZE 172: longer is cut and still run)
    -> the first byte of every frame the node would run."""
    g = guard or kb.PrivateKeyGuard()
    st = ln = rxl = 0
    buf, run = b"", []
    for m in chunks:
        if not g.check(m):
            continue
        for c in m:
            if st == 0:
                if c == 0x3C:
                    st = 1
            elif st == 1:
                ln, st = c, 2
            elif st == 2:
                ln |= c << 8
                rxl, buf, st = 0, b"", (3 if ln else 0)
            else:
                if rxl < 172:
                    buf += bytes([c])
                rxl += 1
                if rxl >= ln:
                    run.append(buf[:1])
                    st = 0
    return run


def safe(chunks):
    return not any(f in (b"\x17", b"\x18") for f in node_runs(chunks))


t("export private key refused", not one(frame(bytes([23]))))
t("import private key refused", not one(frame(bytes([24]) + os.urandom(64))))
t("after an ordinary frame", not one(frame(bytes([22, 3])) + frame(bytes([23]))))
t("after junk bytes", not one(b"\x00\xff junk" + frame(bytes([23]))))
t("a longer export frame", not one(frame(bytes([23, 0, 0]))))
g = kb.PrivateKeyGuard()
t("split: the header passes on its own", g.feed(b"<\x01"))
t("split: the command byte is caught", not g.feed(b"\x00\x17"))
g = kb.PrivateKeyGuard()
t("split 3+1", g.feed(b"<\x01\x00") and not g.feed(b"\x17"))
t("device query passes", one(frame(bytes([22, 3]))))
t("get channel passes", one(frame(bytes([31, 0]))))
t("set channel passes", one(frame(bytes([32, 1]) + b"#test".ljust(32, b"\0") + os.urandom(16))))
t("export contact passes", one(frame(bytes([17]))))
t("sign data passes", one(frame(bytes([20]) + bytes(range(100)))))
t("23 inside another frame's payload passes (the node never runs it)", one(frame(bytes([2, 0, 23, 24]))))

# the review's bypasses (F2), replayed through the node's own parser
t("F2a oversize frame (cut to 172, still run)", safe([b"<\xb1\x00\x17" + bytes(176)]))
t("F2b non-zero high length byte", safe([b"<\x01\x01\x17" + bytes(256)]))
t("F2c retry after a refusal", safe([b"<\x01", b"\x00\x17", b"\x00\x17"]))
t("F2c retry, import", safe([b"<\x41\x00", b"\x18" + bytes(64), b"\x18" + bytes(64)]))
t("refused again and again: the node's open frame stays guarded", safe([b"<\x01\x00", b"\x17", b"\x17", b"\x18"]))
t("header split byte by byte", safe([b"<", b"\x01", b"\x00", b"\x17"]))
t("hidden in another frame's payload: never run", safe([frame(b"\x02" + b"<\x01\x00\x17")]))
t("zero-length frame then export", safe([b"<\x00\x00<\x01\x00\x17"]))
t("'<' as a length byte", safe([b"<<\x00\x17" + bytes(60)]))
rnd = random.Random(11)
ok = True
for _ in range(3000):     # random byte soup cut at random places: the node never runs 23/24
    soup = bytes(rnd.choice([0x3C, 0x00, 0x01, 0x17, 0x18, rnd.randrange(256)]) for _ in range(rnd.randrange(1, 60)))
    cuts = sorted(rnd.sample(range(1, len(soup) + 1), min(3, len(soup))))
    ok = safe([soup[a:b] for a, b in zip([0] + cuts, cuts) if soup[a:b]] + [soup[cuts[-1]:]]) and ok
t("random streams: the node never runs a private-key command", ok)

# one guard for every client (MeshLink.key_guard): client A leaves a frame open, client B's byte is the command byte
g = kb.PrivateKeyGuard()
t("two clients share the node's parser", g.check(b"<\x01\x00") and not g.check(b"\x17"))

# filler: after a reopen the node and the guard agree on where the next frame starts, whatever the node kept
nxt = b"<\x02\x00\x16\x03"     # DEVICE_QUERY
for name, pre in (("after '<'", b"<"), ("after len lo", b"<\x05"), ("mid frame", b"<\x05\x00\x02\x00"),
                  ("idle", b""), ("big frame", b"<\x00\x01\x02")):
    g = kb.PrivateKeyGuard()
    g.check(pre)
    fill = g.filler()
    t(f"filler {name}: the guard is idle", g.state == 0)
    t(f"filler {name}: a node that kept its state reads the next frame", node_runs([pre, fill, nxt], guard=Pass())[-1:] == [b"\x16"])
    t(f"filler {name}: a rebooted node ignores it", node_runs([fill, nxt], guard=Pass()) == [b"\x16"])
    t(f"filler {name}: the filler runs nothing private", not any(f in (b"\x17", b"\x18") for f in node_runs([pre, fill], guard=Pass())))

# Meshtastic / KISS links
ok = True
for _ in range(2000):
    body = bytes(rnd.randrange(256) for _ in range(rnd.randrange(10, 200)))
    for hello in (b"\x94\xc3\x00\x02\x08\x01", b"\xc0\x00hello\xc0"):
        g = kb.PrivateKeyGuard()
        g.saw_node(hello)
        ok = g.off and g.check(b"\x94\xc3" + struct.pack(">H", len(body)) + body) and g.check(b"\xc0\x00" + body + b"\xc0") and ok
t("Meshtastic / KISS streams pass once the node has spoken", ok)
g = kb.PrivateKeyGuard()
g.saw_node(b">\x05\x00\x0d\x94\xc3\x00\x00")
t("94 C3 inside a MeshCore '>' frame keeps the guard on", not g.off and g.kind == "meshcore")
g = kb.PrivateKeyGuard()
t("a node that hasn't spoken yet is guarded", not g.check(frame(b"\x17")))
g = kb.PrivateKeyGuard(meshcore=True)
g.saw_node(b"\x94\xc3\x00\x02")
t("a known MeshCore link stays guarded", not g.off and not g.check(frame(b"\x17")))

print(f"{passed} passed, {failed} failed")
print("RESULT: ALL PASS" if not failed else "RESULT: FAIL")
sys.exit(1 if failed else 0)
