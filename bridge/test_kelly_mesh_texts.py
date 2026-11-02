"""Checks for the message sync a phone's Kelly catches up from (MeshCoreWatch texts, GET /api/mesh-texts).
Run: python3 bridge/test_kelly_mesh_texts.py  (stdlib only; prints RESULT: ALL PASS / FAIL)

Covers: stable ids, outgoing texts captured from what goes to the node (a channel post, a DM and its retries as one, a
CLI command left out, two frames in one write), incoming texts, the --mesh-texts file (saved, loaded with the same ids,
capped at 500). Then a real bridge (--mesh-sim --mesh-gateway --token): the bridge's own send and a Kelly's on /mesh
both kept as "out", ?since=, a remote caller refused without the token and answered (with CORS) with it, and the texts
still there after a restart."""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kelly_bridge as kb  # noqa: E402

BRIDGE = Path(__file__).parent / "kelly_bridge.py"
fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


def frame(payload: bytes) -> bytes:
    return b"<" + struct.pack("<H", len(payload)) + payload


TS = int(time.time())
KEY = bytes.fromhex("a1b2c3d4e5f6")
chan = lambda text, ch=0, ts=TS: frame(bytes([3, 0, ch]) + struct.pack("<I", ts) + text.encode())
dm = lambda text, typ=0, attempt=0, ts=TS: frame(bytes([2, typ, attempt]) + struct.pack("<I", ts) + KEY + text.encode())


def watch(path):
    mesh = types.SimpleNamespace(args=types.SimpleNamespace(mesh_texts=str(path)), clients=set(), up=True)
    mc = kb.MeshCoreWatch(mesh)
    mc.self_name, mc.channels = "VK4XXX Shack", {0: "Public", 1: "P25X"}
    mc.contacts[KEY.hex()] = {"name": "VK4ZB Bravo"}
    return mc


tmp = Path(tempfile.mkdtemp())
f1 = tmp / "texts.json"
mc = watch(f1)
mc.note_sent(chan("hello channel", 1))
t = mc.texts[-1] if mc.texts else {}
check("channel post kept as out", t.get("out") is True and t.get("mine") is True and t.get("dm") is False and t.get("ch") == 1
      and t.get("chName") == "P25X" and t.get("sender") == "VK4XXX Shack" and t.get("text") == "hello channel" and t.get("at") == TS * 1000, t)
check("id: 12 hex", len(t.get("id", "")) == 12 and all(c in "0123456789abcdef" for c in t.get("id", "")), t.get("id"))
check("id: stable", kb.MeshCoreWatch.text_id(dict(t)) == t["id"])
mc.note_sent(dm("hi bravo")); mc.note_sent(dm("hi bravo", attempt=1)); mc.note_sent(dm("hi bravo", attempt=2))
d = [x for x in mc.texts if x.get("dm")]
check("DM kept once (retries carry the same ts)", len(d) == 1 and d[0]["to"] == KEY.hex() and d[0]["toName"] == "VK4ZB Bravo" and d[0]["out"], d)
mc.note_sent(dm("get telemetry", typ=1))
check("CLI command (txt type 1) not kept", not any(x["text"] == "get telemetry" for x in mc.texts))
mc.note_sent(chan("first") + chan("second"))
check("two frames in one write: both", [x["text"] for x in mc.texts[-2:]] == ["first", "second"], [x["text"] for x in mc.texts])
mc.note_sent(frame(bytes([22, 3])))   # DEVICE_QUERY: not a text
check("other commands: nothing", len(mc.texts) == 4, len(mc.texts))
# incoming channel text (RESP CHANNEL_MSG_RECV_V3, as kelly_mesh_sim.py makes it)
mc.on_msg(bytes([17, 40, 0, 0, 0, 2, 0]) + struct.pack("<I", TS) + b"VK4XYZ: g'day")
t = mc.texts[-1]
check("incoming channel text: id, sender, text, snr, hops", t.get("sender") == "VK4XYZ" and t.get("text") == "g'day" and t.get("snr") == 10 and t.get("hops") == 2
      and len(t.get("id", "")) == 12 and not t.get("out"), t)
mc.on_msg(bytes([17, 40, 0, 0, 0, 2, 0]) + struct.pack("<I", TS) + b"VK4XYZ: g'day")
check("the same text twice: kept once", sum(1 for x in mc.texts if x["text"] == "g'day") == 1)
mc.save_texts()
saved = json.loads(f1.read_text(encoding="utf-8"))
check("saved to --mesh-texts", [x["id"] for x in saved] == [x["id"] for x in mc.texts], len(saved))
mc2 = watch(f1)
check("loaded again, same ids", [x["id"] for x in mc2.texts] == [x["id"] for x in mc.texts])
for i in range(600):
    mc2.add_text({"dm": False, "ch": 0, "sender": "s", "text": f"n{i}", "at": 1_700_000_000_000 + i})
check("capped at 500", len(mc2.texts) == 500 and mc2.texts[-1]["text"] == "n599", len(mc2.texts))
check("not kept without --mesh-texts", kb.MeshCoreWatch(types.SimpleNamespace(args=types.SimpleNamespace(), clients=set(), up=True)).texts_path is None)


# ---- a real bridge on the simulated node
def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


if kb.kelly_ent.public():   # the public build switches --mesh-gateway off (a club service, kelly_ent svc.club)
    print("SKIP the bridge end to end: --mesh-gateway is a club service in the public build")
    print("RESULT: " + ("FAIL " + ", ".join(fails) if fails else "ALL PASS"))
    sys.exit(1 if fails else 0)
port = free_port()
f2 = tmp / "texts-e2e.json"


def start():
    p = subprocess.Popen([sys.executable, str(BRIDGE), "--bind", "0.0.0.0", "--port", str(port), "--token", "s3cret", "--mesh-sim", "--mesh-gateway",
                          "--mesh-sim-faults", "quiet", "--mesh-texts", str(f2), "--share-dir", str(tmp / "share"), "--mesh-outbox", str(tmp / "outbox.sqlite")],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return p
        except OSError:
            time.sleep(0.1)
    return p


def stop(p):
    p.terminate()
    try:
        p.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()


def get(path, host="127.0.0.1"):
    try:
        with urllib.request.urlopen(f"http://{host}:{port}{path}", timeout=15) as r:
            return r.status, dict(r.headers), json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, dict(e.headers), json.loads(body or b"{}")
        except ValueError:   # not a JSON answer (the page server's 404)
            return e.code, dict(e.headers), {}


def post(path, body):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def ws_send(path, payload: bytes, hold: float = 1.5):
    """A minimal WebSocket client: handshake, one masked binary frame, wait, close."""
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    head = s.recv(1024).decode(errors="replace")
    mask = os.urandom(4)
    n = len(payload)
    hdr = bytes([0x82]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
    time.sleep(hold)
    s.close()
    return head.split("\r\n")[0]


p = start()
try:
    check("bridge: own channel post", post("/api/mesh-send", {"ch": 0, "text": "e2e from the bridge"}).get("ok"))
    st, hd, js = get("/api/mesh-texts")
    mine = [x for x in js.get("texts", []) if x["text"] == "e2e from the bridge"]
    check("bridge: its own send kept once, out, with an id", len(mine) == 1 and mine[0].get("out") and len(mine[0].get("id", "")) == 12, mine)
    check("bridge: self + channels in the answer", js.get("self") and "0" in js.get("channels", {}), (js.get("self"), js.get("channels")))
    since = max(x["at"] for x in js["texts"])
    check("?since=: nothing newer yet", get(f"/api/mesh-texts?since={since}")[2]["texts"] == [])
    line = ws_send("/mesh?token=s3cret", chan("e2e from a kelly on /mesh", 1, ts=int(time.time())))
    check("a Kelly on /mesh: 101", "101" in line, line)
    time.sleep(0.5)
    st, hd, js = get("/api/mesh-texts")
    k = [x for x in js["texts"] if x["text"] == "e2e from a kelly on /mesh"]
    check("a Kelly's channel post through the bridge: kept as out", len(k) == 1 and k[0].get("out") and k[0].get("ch") == 1, k)
    lan = ""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            lan = s.getsockname()[0]
    except OSError:
        pass
    if not lan or lan.startswith("127."):
        print("SKIP remote /api/mesh-texts: this machine has no LAN address")
    else:
        st, hd, js = get("/api/mesh-texts", host=lan)
        check("remote without token: 403", st == 403 and js.get("error") == "token", (st, js))
        st, hd, js = get("/api/mesh-texts?token=s3cret", host=lan)
        check("remote with token: the texts + CORS", st == 200 and hd.get("Access-Control-Allow-Origin") == "*" and any(x["text"] == "e2e from the bridge" for x in js["texts"]), (st, hd))
        st, hd, js = get("/api/mesh-send?token=s3cret", host=lan)
        check("remote: /api/mesh-send still this machine only", st != 200 or "ok" not in js, (st, js))
    time.sleep(kb.MeshCoreWatch.TEXTS_SAVE_GAP_S + 1)   # the file is written at most every 5 s (Windows: no SIGTERM save)
    ids = [x["id"] for x in get("/api/mesh-texts")[2]["texts"]]
finally:
    stop(p)
time.sleep(0.5)
p = start()
try:
    after = [x["id"] for x in get("/api/mesh-texts")[2]["texts"]]
    check("after a restart: the same texts, same ids", ids and after[:len(ids)] == ids, (ids, after))
finally:
    stop(p)

print("RESULT: " + ("FAIL " + ", ".join(fails) if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
