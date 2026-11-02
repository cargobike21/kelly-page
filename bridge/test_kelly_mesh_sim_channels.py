"""Kelly Page -- bridge/kelly_mesh_sim.py channel slots: GET_CHANNEL 31 and CMD_SET_CHANNEL 32, byte for byte the same as
js/meshcoresim.js (tests/meshcore-tests.html makes the same checks against the JS sim). No network, no node.

    .venv\\Scripts\\python.exe kelly-page\\bridge\\test_kelly_mesh_sim_channels.py   -> RESULT: ALL PASS
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kelly_mesh_sim as ks  # noqa: E402

fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f": got {got!r}"))
    if not ok:
        fails.append(name)


def rig():
    frames = []

    def emit(b):
        i = 0
        while i + 3 <= len(b):
            if b[i] != 0x3E:
                i += 1; continue
            n = b[i + 1] | b[i + 2] << 8
            frames.append(bytes(b[i + 3:i + 3 + n])); i += 3 + n
    sim = ks.MeshCoreSim(emit, auto=False)
    return sim, frames


def cmd(sim, frames, payload):
    frames.clear()
    sim.write(b"<" + struct.pack("<H", len(payload)) + bytes(payload))
    return frames[0] if frames else b""


def setf(i, name: bytes, secret: bytes):
    b = bytearray(50); b[0] = 32; b[1] = i; b[2:2 + len(name)] = name; b[34:50] = secret
    return bytes(b)


sim, fr = rig()
g0 = cmd(sim, fr, [31, 0])
check("GET_CHANNEL 0: Public with the well-known secret", g0[:2] == bytes([18, 0]) and g0[2:8] == b"Public" and g0[34:50].hex() == "8b3387e9c5cdea6ac9e5edbaa115cd72", g0.hex())
g1 = cmd(sim, fr, [31, 1])
check("GET_CHANNEL 1: P25X, the sim's private secret", g1[2:6] == b"P25X" and g1[34:50].hex() == "725c27dec10b06cb92860845704102cc", g1.hex())
check("GET_CHANNEL 5: an empty slot -> no name, zero secret", cmd(sim, fr, [31, 5]) == bytes([18, 5]) + bytes(48))
check("GET_CHANNEL 8: past the 8 slots -> ERR 2", cmd(sim, fr, [31, 8]) == bytes([1, 2]))
sec = bytes(range(0xA0, 0xB0))
check("SET_CHANNEL 2 -> OK", cmd(sim, fr, setf(2, b"#test", sec)) == bytes([0]))
g2 = cmd(sim, fr, [31, 2])
check("GET_CHANNEL 2 after SET: name + secret stored", g2[:2] == bytes([18, 2]) and g2[2:7] == b"#test" and g2[7] == 0 and g2[34:50] == sec, g2.hex())
check("SET_CHANNEL 8 -> ERR 2", cmd(sim, fr, setf(8, b"#test", sec)) == bytes([1, 2]))
check("SET_CHANNEL short frame -> ERR 1", cmd(sim, fr, [32, 2, 0x41]) == bytes([1, 1]))
check("chans: names", [c["name"] for c in sim.chans[:3]] == ["Public", "P25X", "#test"], sim.chans[:3])

# ---- MeshPRS: RESP 27 only with the #meshprs key in a slot; CMD 62 / 64 / 54 (tests/meshprs-intake-test.js = the JS sim)
MPRS_POS = "50 00 26 00 21 4F 04 C7 8E 0E 86 7B E5 22 B5 D8 E9 A1 6C 2F 5B 00 4B 65 6C 6C 79 20 73 69 6D 20 74 72 61 63 6B 65 72"
sim, fr = rig()
pos = sim.mprs_position(sim.st[1])
check("MeshPRS: Bravo's first Position frame, byte for byte the JS sim's", pos.hex(" ").upper() == MPRS_POS, pos.hex(" "))
fr.clear(); sim.heard_data(sim.st[1], pos)
check("MeshPRS: no #meshprs slot -> only the raw log (0x88), no RESP 27", [f[0] for f in fr] == [0x88] and not sim.queue, [f[:1].hex() for f in fr])
check("MeshPRS: the raw log is a GRP_DATA flood on hash 0xBA", fr[0][3] == 0x01 | 6 << 2 and fr[0][5:7] == sim.st[0]["key"][:2] and fr[0][7] == 0xBA, fr[0][:8].hex())
cmd(sim, fr, setf(3, b"#meshprs", bytes.fromhex(ks.MPRS_KEY)))
fr.clear(); sim.heard_data(sim.st[1], pos)
check("MeshPRS: with the slot -> MSG_WAITING", [f[0] for f in fr] == [0x88, 0x83], [f[:1].hex() for f in fr])
q = cmd(sim, fr, [10])
check("MeshPRS: SYNC -> RESP 27 [27][snr*4][0][0][ch 3][path_len 0x41][4D FF][len][blob]",
      q[:9] == bytes([27, 29, 0, 0, 3, 0x41, 0x4D, 0xFF, len(pos)]) and q[9:] == pos, q[:9].hex())
check("CMD 64: no default scope -> [28]", cmd(sim, fr, [64]) == bytes([28]))
check("CMD 62: flood on #meshprs -> OK", cmd(sim, fr, bytes([62, 3, 0xFF, 0x4D, 0xFF]) + pos) == bytes([0]))
check("CMD 62: kept", sim.sent_data[-1] == {"ch": 3, "pathLen": 0xFF, "type": 0xFF4D, "data": pos.hex(), "unscoped": False}, sim.sent_data[-1:])
check("CMD 62: zero-hop -> OK, a direct send", cmd(sim, fr, bytes([62, 3, 0, 0x4D, 0xFF, 1])) == bytes([0]) and sim.c["sent_direct"] == 1)
check("CMD 62: an empty slot -> ERR 2", cmd(sim, fr, bytes([62, 6, 0xFF, 0x4D, 0xFF, 1])) == bytes([1, 2]))
check("CMD 62: data type 0 -> ERR 6", cmd(sim, fr, bytes([62, 3, 0xFF, 0, 0, 1])) == bytes([1, 6]))
check("CMD 62: 166 bytes -> ERR 6", cmd(sim, fr, bytes([62, 3, 0xFF, 0x4D, 0xFF]) + bytes(166)) == bytes([1, 6]))
check("CMD 62: too short -> ERR 6", cmd(sim, fr, [62, 3, 0xFF]) == bytes([1, 6]))
check("CMD 54 [1] -> OK, unscoped", cmd(sim, fr, [54, 1]) == bytes([0]) and sim.unscoped)
check("CMD 54 [0] -> OK, back to the default", cmd(sim, fr, [54, 0]) == bytes([0]) and not sim.unscoped)
sim2, fr2 = rig()
sim2.scope = ("#qld", "00112233445566778899aabbccddeeff")
r = cmd(sim2, fr2, [64])
check("CMD 64 on a node with a default scope -> [28][name 31][key 16]", r[:5] == b"\x1c#qld" and len(r) == 48 and r[32:].hex() == "00112233445566778899aabbccddeeff", r.hex())

print(f"RESULT: {'FAIL ' + ', '.join(fails) if fails else 'ALL PASS'}")
sys.exit(1 if fails else 0)
