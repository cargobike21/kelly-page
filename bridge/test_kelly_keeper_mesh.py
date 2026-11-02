"""Checks for the Pi keeper staying on the LoRa node while a person's Kelly uses it (2026-11-01): a real bridge with
--mesh-sim --keeper-local, one /mesh client from this machine (the keeper) and one from the LAN (a PC).
Run: python3 bridge/test_kelly_keeper_mesh.py  (stdlib only; prints RESULT: ALL PASS / FAIL; needs a LAN address)

Covers: the keeper's hello says watch false on its own; told watch true when the PC attaches and false when it leaves;
what the keeper writes meanwhile never reaches the node (the PC's command is answered, to both); the iGate is the
keeper's while it's on the node with its iGate on -- the PC's config, sends and "New spot" refused, status keeper:
true -- and the PC's again once the keeper has gone."""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
TOKEN = "s3cret"
fails = []


def check(name, ok, got=None):
    print(f"{'PASS' if ok else 'FAIL'} {name}" + ("" if ok or got is None else f"  -- got {got!r}"))
    if not ok:
        fails.append(name)


class Ws:
    """A minimal WebSocket client: text frames are JSON from the bridge, binary frames are the node's bytes."""

    def __init__(self, host, port, path):
        self.s = socket.create_connection((host, port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.s.recv(1024)
        assert b" 101 " in head.split(b"\r\n", 1)[0], head
        self.buf = head.split(b"\r\n\r\n", 1)[1]

    def send(self, data: bytes):
        mask = os.urandom(4)
        n = len(data)
        hdr = bytes([0x82]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, timeout=3.0):
        """(opcode, payload) or None on timeout."""
        self.s.settimeout(timeout)
        try:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            n = struct.unpack(">H", self._read(2))[0] if n == 126 else struct.unpack(">Q", self._read(8))[0] if n == 127 else n
            return b0 & 0x0F, self._read(n)
        except (socket.timeout, TimeoutError):
            return None

    def texts_and_bytes(self, secs=2.0):
        """Everything that arrives within secs: ([json...], total binary bytes)."""
        texts, nbytes, end = [], 0, time.monotonic() + secs
        while (left := end - time.monotonic()) > 0:
            m = self.recv(left)
            if not m:
                break
            if m[0] == 0x1:
                texts.append(json.loads(m[1]))
            elif m[0] == 0x2:
                nbytes += len(m[1])
        return texts, nbytes

    def close(self):
        try:
            self.s.sendall(bytes([0x88, 0x80]) + os.urandom(4))
            self.s.close()
        except OSError:
            pass


def mc(payload: bytes) -> bytes:
    return b"<" + struct.pack("<H", len(payload)) + payload


def free_port() -> int:
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


lan = ""
try:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as so:
        so.connect(("192.0.2.1", 9))
        lan = so.getsockname()[0]
except OSError:
    pass
if not lan or lan.startswith("127."):
    print("SKIP: this machine has no LAN address (the PC's Kelly must not look like this machine)")
    print("RESULT: ALL PASS")
    sys.exit(0)

port = free_port()


def req(path, body=None, host="127.0.0.1"):
    sep = "&" if "?" in path else "?"
    url = f"http://{host}:{port}{path}" + ("" if host == "127.0.0.1" else f"{sep}token={TOKEN}")
    r = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                               headers={"Content-Type": "text/plain"}, method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(r, timeout=10) as x:
            return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


DEVICE_QUERY = mc(bytes([22, 3]))
POS = {"src": "VK4XXX-9", "name": "VK4XXX Test", "lat": -27.4545, "lon": 152.9876, "sym": "/>", "comment": "x"}
p = subprocess.Popen([sys.executable, str(HERE / "kelly_bridge.py"), "--bind", "0.0.0.0", "--port", str(port), "--token", TOKEN,
                      "--mesh-sim", "--keeper-local", "--keeper-store", str(HERE / f".test-keeper-{port}.json")],
                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
try:
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            break
        except OSError:
            time.sleep(0.1)
    time.sleep(1.0)

    keeper = Ws("127.0.0.1", port, f"/mesh?token={TOKEN}&keeper=1")
    t, _ = keeper.texts_and_bytes(1.0)
    check("keeper alone: hello says watch false", t and t[0].get("watch") is False, t)
    keeper.send(DEVICE_QUERY)
    _, n = keeper.texts_and_bytes(1.5)
    check("keeper alone: drives the node (its command is answered)", n > 0, n)

    st, js = req("/api/igate/config", {"on": True, "call": "VK4XXX-10", "dry": True, "vers": "t"})
    check("keeper turns the iGate on (this machine)", st == 200 and js.get("ok") and js["status"].get("keeper") is True, (st, js))

    pc = Ws(lan, port, f"/mesh?token={TOKEN}")
    t, _ = pc.texts_and_bytes(0.8)
    check("PC: an ordinary hello (no watch key)", t and "watch" not in t[0], t)
    t, _ = keeper.texts_and_bytes(1.0)
    check("PC attaches -> keeper told watch true", any(x.get("watch") is True for x in t), t)

    keeper.send(DEVICE_QUERY)
    _, kn = keeper.texts_and_bytes(1.5)
    _, pn = pc.texts_and_bytes(0.3)
    check("listening keeper's command never reaches the node (no answer to either)", kn == 0 and pn == 0, (kn, pn))
    pc.send(DEVICE_QUERY)
    _, pn = pc.texts_and_bytes(1.5)
    _, kn = keeper.texts_and_bytes(0.5)
    check("PC's command answered -- and the keeper hears it too", pn > 0 and kn == pn, (pn, kn))

    st, js = req("/api/igate/config", {"on": True, "call": "VK4XX-10", "dry": True, "vers": "t"}, host=lan)
    check("PC's iGate config refused while the keeper owns it", st == 200 and js.get("ok") is False and "keeper" in js.get("error", "")
          and js["status"]["call"] == "VK4XXX-10", (st, js))
    st, js = req("/api/igate/config", {"on": False}, host=lan)
    check("PC can't turn the keeper's iGate off", js.get("ok") is False and js["status"]["on"] is True, js)
    st, js = req("/api/igate/send", {"lines": [POS, POS]}, host=lan)
    check("PC's sends refused, one result per line, reason keeper", [r.get("reason") for r in js.get("results", [])] == ["keeper", "keeper"], js)
    st, js = req("/api/igate/privacy", {}, host=lan)
    check("PC's New spot refused (409)", st == 409, (st, js))
    st, js = req("/api/igate", host=lan)
    check("PC's status: keeper true", st == 200 and js.get("keeper") is True, js)
    st, js = req("/api/igate/send", {"lines": [POS]})
    check("keeper's sends still go (dry run packet)", js["results"][0].get("ok") and "VK4XXX-10" in js["results"][0].get("packet", ""), js)

    pc.close()
    t, _ = keeper.texts_and_bytes(1.5)
    check("PC leaves -> keeper told watch false", any(x.get("watch") is False for x in t), t)
    keeper.send(DEVICE_QUERY)
    _, n = keeper.texts_and_bytes(1.5)
    check("keeper drives the node again", n > 0, n)

    # another program on this machine (a member's telemetry poller, 2026-11-01) is NOT the keeper: no ?keeper=1
    poller = Ws("127.0.0.1", port, f"/mesh?token={TOKEN}")
    t, _ = poller.texts_and_bytes(0.8)
    t2, _ = keeper.texts_and_bytes(1.0)
    check("a local program without keeper=1: ordinary hello, and the keeper listens", t and "watch" not in t[0]
          and any(x.get("watch") is True for x in t2), (t, t2))
    poller.send(DEVICE_QUERY)
    _, pn = poller.texts_and_bytes(1.5)
    check("... and its command reaches the node", pn > 0, pn)
    poller.close()
    t, _ = keeper.texts_and_bytes(1.5)
    check("... it leaves -> keeper told watch false", any(x.get("watch") is False for x in t), t)

    keeper.close()
    time.sleep(0.8)
    st, js = req("/api/igate", host=lan)
    check("keeper gone -> status keeper false", js.get("keeper") is False, js)
    st, js = req("/api/igate/config", {"on": True, "call": "VK4XX-10", "dry": True, "vers": "t"}, host=lan)
    check("keeper gone -> the PC may configure the iGate", js.get("ok") is True and js["status"]["call"] == "VK4XX-10", js)
    st, js = req("/api/igate/config", {"on": True, "call": "VK4XXX-10", "dry": True, "vers": "t"})
    check("the keeper (this machine) can always take it back", js.get("ok") is True and js["status"]["call"] == "VK4XXX-10", js)
finally:
    p.terminate()
    try:
        out = p.communicate(timeout=10)[0]
    except subprocess.TimeoutExpired:
        p.kill()
        out = ""
    try:
        (HERE / f".test-keeper-{port}.json").unlink()
    except OSError:
        pass
    check("bridge logged the keeper listening + the dropped frame", "listening only" in out and "dropped 1 frame" in out,
          [x for x in out.splitlines() if "keeper" in x][-6:])

print(f"RESULT: {'FAIL (' + str(len(fails)) + ')' if fails else 'ALL PASS'}")
sys.exit(1 if fails else 0)
