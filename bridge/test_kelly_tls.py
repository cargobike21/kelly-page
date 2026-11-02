"""Checks for the bridge's HTTPS (kelly_tls.py, Phase 8) -- real bridge processes on free ports, no radio.
Run: python3 bridge/test_kelly_tls.py  (stdlib only; prints RESULT: ALL PASS / FAIL; skips if there's no openssl)

Covers: --tls self makes a certificate in --tls-dir (named for localhost / 127.0.0.1, so it verifies against itself),
the page over https, a wss handshake on /ws, the certificate kept on a second start, --tls-port (plain http on --port,
https beside it), the plain-English refusals (--tls-cert without --tls-key, a missing certificate file), and -- if
Chrome or Edge is installed -- tests/secure-tests.html served over https (js/secure.js + a real wss:// link)."""
import base64
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

BRIDGE = Path(__file__).parent / "kelly_bridge.py"
fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(*extra):
    return subprocess.Popen([sys.executable, str(BRIDGE), *extra], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def wait_up(port: int, p) -> bool:
    for _ in range(100):
        if p.poll() is not None:
            return False
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def stop(p) -> str:
    p.terminate()
    try:
        return p.communicate(timeout=10)[0]
    except subprocess.TimeoutExpired:
        p.kill(); return p.communicate()[0]


def https_get(port: int, ctx, path="/") -> tuple[int, bytes]:
    with urllib.request.urlopen(f"https://localhost:{port}{path}", context=ctx, timeout=10) as r:
        return r.status, r.read()


def wss_handshake(port: int, ctx, path="/ws") -> str:
    key = base64.b64encode(os.urandom(16)).decode()
    with socket.create_connection(("127.0.0.1", port), timeout=10) as raw, ctx.wrap_socket(raw, server_hostname="localhost") as s:
        s.sendall((f"GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        return s.recv(1024).decode(errors="replace").split("\r\n")[0]


def find_chrome() -> str:
    for c in (shutil.which("chrome"), shutil.which("google-chrome"), shutil.which("chromium"),
              r"C:\Program Files\Google\Chrome\Application\chrome.exe", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"):
        if c and Path(c).is_file():
            return c
    return ""


def main():
    if not shutil.which("openssl"):
        print("SKIP no openssl on this machine -- --tls self can't be tested here")
        print("RESULT: ALL PASS (skipped)")
        return
    tmp = Path(tempfile.mkdtemp())
    tdir = tmp / "tls"
    common = ["--share-dir", str(tmp / "share"), "--mesh-outbox", str(tmp / "outbox.sqlite")]

    # 1. --tls self on one port: https page + wss
    port = free_port()
    p = start("--port", str(port), "--tls", "self", "--tls-dir", str(tdir), *common)
    try:
        check("--tls self: bridge up", wait_up(port, p))
        cert = tdir / "cert.pem"
        check("--tls self: cert.pem + key.pem made in --tls-dir", cert.is_file() and (tdir / "key.pem").is_file())
        ctx = ssl.create_default_context(cafile=str(cert))      # verifies: the cert names localhost
        try:
            status, body = https_get(port, ctx)
            check("https GET /: 200 + the page", status == 200 and b"<html" in body.lower()[:2000], status)
        except Exception as e:
            check("https GET /: 200 + the page", False, e)
        try:
            check("wss /ws: 101 Switching Protocols", "101" in wss_handshake(port, ctx), None)
        except Exception as e:
            check("wss /ws: 101 Switching Protocols", False, e)
        chrome = find_chrome()
        if chrome:   # the Kelly side: tests/secure-tests.html served over https (secure.js + a real wss:// link)
            r = subprocess.run([chrome, "--headless=new", "--ignore-certificate-errors", f"--user-data-dir={tmp / 'chrome'}",
                                "--virtual-time-budget=8000", "--dump-dom", f"https://localhost:{port}/tests/secure-tests.html"],
                               capture_output=True, text=True, timeout=90)
            m = re.search(r'<pre id="out">(.*?)</pre>', r.stdout, re.S)
            res = m.group(1) if m else ""
            check(f"tests/secure-tests.html over https ({res.count('PASS ')} checks)", "RESULT: ALL PASS" in res and "FAIL " not in res, res[-400:] or f"no result; stdout {len(r.stdout)} chars, stderr: {r.stderr[-400:]}")
        else:
            print("SKIP no Chrome found -- tests/secure-tests.html not run")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5).read()
            check("plain http on a TLS port is refused", False)
        except Exception:
            check("plain http on a TLS port is refused", True)
    finally:
        out = stop(p)
    check("start-up prints the https URL", f":{port}/" in out and "https://" in out, out[-600:])
    first = cert.read_bytes() if cert.is_file() else b""

    # 2. a second start keeps the certificate (no new browser warning)
    port = free_port()
    p = start("--port", str(port), "--tls", "self", "--tls-dir", str(tdir), *common)
    try:
        check("--tls self again: bridge up", wait_up(port, p))
        check("--tls self again: same certificate kept", first and cert.read_bytes() == first)
    finally:
        stop(p)

    # 3. --tls-cert/--tls-key + --tls-port: plain http stays on --port, https beside it
    port, tport = free_port(), free_port()
    p = start("--port", str(port), "--tls-port", str(tport), "--tls-cert", str(cert), "--tls-key", str(tdir / "key.pem"), *common)
    try:
        check("--tls-port: both ports up", wait_up(port, p) and wait_up(tport, p))
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as r:
                check("--tls-port: --port still plain http", r.status == 200)
        except Exception as e:
            check("--tls-port: --port still plain http", False, e)
        try:
            ctx = ssl.create_default_context(cafile=str(cert))
            check("--tls-port: https on the TLS port", https_get(tport, ctx)[0] == 200)
            check("--tls-port: wss /ws on the TLS port", "101" in wss_handshake(tport, ctx))
        except Exception as e:
            check("--tls-port: https on the TLS port", False, e)
    finally:
        stop(p)

    # 4. refusals in plain English, nothing served
    r = subprocess.run([sys.executable, str(BRIDGE), "--port", str(free_port()), "--tls-cert", str(cert), *common],
                       capture_output=True, text=True, timeout=30)
    check("--tls-cert without --tls-key: exits with the reason", r.returncode != 0 and "--tls-key" in (r.stderr + r.stdout), r.stderr[-300:])
    r = subprocess.run([sys.executable, str(BRIDGE), "--port", str(free_port()), "--tls-cert", str(tmp / "nope.crt"),
                        "--tls-key", str(tmp / "nope.key"), *common], capture_output=True, text=True, timeout=30)
    check("missing certificate file: exits with the reason", r.returncode != 0 and "can't load the certificate" in (r.stderr + r.stdout), r.stderr[-300:])

    shutil.rmtree(tmp, ignore_errors=True)
    print("RESULT: " + ("ALL PASS" if not fails else f"FAIL ({len(fails)}): " + ", ".join(fails)))


if __name__ == "__main__":
    main()
