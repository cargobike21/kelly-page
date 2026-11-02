"""Checks for "Connect a phone" (GET /api/connect, --connect-qr) -- the address list as a unit, then a real bridge process.
Run: python3 bridge/test_kelly_connect.py  (stdlib only; prints RESULT: ALL PASS / FAIL)

Covers: the URL order (the address the request came in on, the rest of the LAN, <hostname>.local, Tailscale last;
https before http), virtual / loopback / link-local interfaces left out, a one-address --bind, base urls (no token in
them), the token only for a caller that sent it or a page on this machine (another web site's Origin gets none), CORS on
every answer, and --connect-qr's QR + its ?connect=ip&token= address line."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import types
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


# ---- unit: connect_urls / connect_info over a Pi with VLANs, docker and Tailscale
IFACES = [("lo", "127.0.0.1"), ("eth0.20", "192.168.20.2"), ("eth0.30", "10.0.30.50"), ("br-lab", "172.18.0.10"),
          ("docker0", "172.17.0.1"), ("wlan0", "169.254.3.4"), ("tailscale0", "100.64.0.20")]
real_ifaces = kb._ipv4_interfaces
kb._ipv4_interfaces = lambda: list(IFACES)
host = socket.gethostname()
A = lambda **k: types.SimpleNamespace(**{"port": 8025, "tls_port": 8443, "tls": "self", "tls_cert": None, "bind": "0.0.0.0", "token": "T0k", **k})

u = kb.connect_urls(A(), first="10.0.30.50")
check("order: request address first, https then http, LAN, .local, Tailscale",
      [x["url"] for x in u] == ["https://10.0.30.50:8443/", "http://10.0.30.50:8025/", "https://192.168.20.2:8443/", "http://192.168.20.2:8025/",
                                f"https://{host}.local:8443/", f"http://{host}.local:8025/", "https://100.64.0.20:8443/", "http://100.64.0.20:8025/"],
      [x["url"] for x in u])
check("kinds + labels", [(x["kind"], x["label"]) for x in u[::2]] == [("lan", "eth0.30"), ("lan", "eth0.20"), ("mdns", "mDNS"), ("tailscale", "Tailscale")],
      [(x["kind"], x["label"]) for x in u[::2]])
check("https flag", [x["https"] for x in u[:2]] == [True, False])
check("left out: lo, br-, docker, link-local", not any(h in x["url"] for x in u for h in ("127.0.0.1", "172.18.0.10", "172.17.0.1", "169.254")))
check("default-route order without a request address", kb.connect_urls(A())[0]["url"] == "https://192.168.20.2:8443/")
check("plain http only without TLS", kb.connect_urls(A(tls=None, tls_port=0))[0]["url"] == "http://192.168.20.2:8025/"
      and not any(x["https"] for x in kb.connect_urls(A(tls=None, tls_port=0))))
check("--tls without --tls-port: https on --port only", {x["url"].split(":")[0] for x in kb.connect_urls(A(tls_port=0))} == {"https"}
      and kb.connect_urls(A(tls_port=0))[0]["url"] == "https://192.168.20.2:8025/")
check("--bind one address: that address only", [x["url"] for x in kb.connect_urls(A(bind="10.0.30.50"))] == ["https://10.0.30.50:8443/", "http://10.0.30.50:8025/"])
check("a query (--connect-qr's) is added as given", kb.connect_urls(A(), "?connect=ip&token=x")[0]["url"].endswith("/?connect=ip&token=x"))

info = lambda peer, sock, tok="", origin="", **k: kb.connect_info(A(**k), (peer, 5), (sock, 8443), tok, origin)
out, trusted = info("127.0.0.1", "127.0.0.1")
check("this machine, no Origin: the token", trusted and out.get("token") == "T0k", out)
check("urls are base addresses (never a token in them)", not any("token" in x["url"] or "?" in x["url"] for x in out["urls"]), out["urls"][:2])
check("port / tlsPort / hasToken", (out["port"], out["tlsPort"], out["hasToken"]) == (8025, 8443, True), out)
check("this machine, file:// page (Origin null): the token", info("127.0.0.1", "127.0.0.1", origin="null")[0].get("token") == "T0k")
check("this machine, a localhost page: the token", info("127.0.0.1", "127.0.0.1", origin="http://localhost:8025")[0].get("token") == "T0k")
check("this machine, ANOTHER web site: no token", "token" not in info("127.0.0.1", "127.0.0.1", origin="https://evil.example")[0])
out, trusted = info("10.0.60.22", "10.0.30.50")
check("phone without token: none", not trusted and "token" not in out and out["hasToken"], out)
check("phone: its own address leads", out["urls"][0]["url"] == "https://10.0.30.50:8443/", out["urls"][0])
check("wrong token: none", "token" not in info("10.0.60.22", "10.0.30.50", "wrong")[0])
check("right token: back", info("10.0.60.22", "10.0.30.50", "T0k", origin="https://evil.example")[0].get("token") == "T0k")
out, trusted = info("10.0.60.22", "10.0.30.50", token="")
check("bridge without --token: hasToken false, no token field", trusted and not out["hasToken"] and "token" not in out, out)
out, _ = info("127.0.0.1", "127.0.0.1", bind="127.0.0.1")
check("--bind 127.0.0.1: no URLs, a note", out["urls"] == [] and "bind 0.0.0.0" in out.get("note", ""), out)
kb._ipv4_interfaces = real_ifaces


# ---- a real bridge: GET /api/connect over loopback and over this machine's LAN address
def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get(url, origin=None):
    req = urllib.request.Request(url, headers={"Origin": origin} if origin else {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, dict(r.headers), json.loads(r.read())


tmp = Path(tempfile.mkdtemp())
port = free_port()
p = subprocess.Popen([sys.executable, str(BRIDGE), "--bind", "0.0.0.0", "--port", str(port), "--token", "s3cret",
                      "--share-dir", str(tmp / "share"), "--mesh-outbox", str(tmp / "outbox.sqlite")],
                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            break
        except OSError:
            time.sleep(0.1)
    st, hd, js = get(f"http://127.0.0.1:{port}/api/connect")
    check("bridge, loopback: 200, token, CORS, no-store", st == 200 and js.get("token") == "s3cret" and hd.get("Access-Control-Allow-Origin") == "*"
          and hd.get("Cache-Control") == "no-store" and js["urls"] and not any("token" in x["url"] for x in js["urls"]), (st, hd, js))
    st, hd, js = get(f"http://127.0.0.1:{port}/api/connect", origin="https://evil.example")
    check("bridge, loopback from another web site: no token", "token" not in js, js)
    lan = ""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            lan = s.getsockname()[0]
    except OSError:
        pass
    if not lan or lan.startswith("127."):
        print("SKIP bridge over the LAN address: this machine has none")
    else:
        st, hd, js = get(f"http://{lan}:{port}/api/connect")
        check("bridge, LAN without token: no token, CORS", "token" not in js and hd.get("Access-Control-Allow-Origin") == "*", (js, hd))
        check("bridge, LAN: the address it was asked on leads", js["urls"] and js["urls"][0]["url"] == f"http://{lan}:{port}/", js["urls"][:1])
        st, hd, js = get(f"http://{lan}:{port}/api/connect?token=s3cret")
        check("bridge, LAN with token: token", js.get("token") == "s3cret", js)
finally:
    p.terminate()
    try:
        p.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()

# ---- --connect-qr: QR + the best address (settings on the command line; no service on this machine)
r = subprocess.run([sys.executable, str(BRIDGE), "--connect-qr", "--bind", "0.0.0.0", "--port", "8025", "--tls", "self", "--tls-port", "8443",
                    "--token", "s3cret"], capture_output=True, text=True, encoding="utf-8", timeout=30, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
lines = r.stdout.splitlines()
check("--connect-qr: exits 0", r.returncode == 0, r.stdout[-400:] + r.stderr[-400:])
check("--connect-qr: a QR code (half-blocks)", sum(1 for ln in lines if set(ln) <= set("█▀▄ ") and len(ln) > 20) >= 10)
best = next((ln.strip() for ln in lines if ln.strip().startswith("https://")), "")
check("--connect-qr: the best address, https, ?connect=ip&token=", best.startswith("https://") and ":8443/?connect=ip&token=s3cret" in best, best)
check("--connect-qr: self-signed hint", any("Proceed" in ln for ln in lines))
others = [ln.strip() for ln in lines if ln.startswith("  http") and ln.strip() != best]
check("--connect-qr: other addresses listed, without the token", others and all("token" not in ln for ln in others), others)

print("RESULT: " + ("FAIL " + ", ".join(fails) if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
