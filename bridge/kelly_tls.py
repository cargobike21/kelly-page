"""HTTPS for the Kelly bridge (Phase 8): serve the page + every WebSocket over TLS, stdlib ssl only.

Browsers only give GPS, the camera, Web Bluetooth and offline mode (service workers) to a "secure context":
https://, or http://localhost. A phone opening a Pi or another computer over plain http:// on the LAN or the
tailnet gets none of them. Two ways out (see HTTPS.md):

  --tls-cert FILE --tls-key FILE   a real certificate, e.g. from `tailscale cert <host>.<tailnet>.ts.net`
  --tls self                       a self-signed certificate made once (with the `openssl` program) and kept
                                   in --tls-dir; each device accepts the browser warning once

Plain http stays the default. With TLS on, --port serves https/wss only, unless --tls-port is given: then
--port stays plain http (the Pi's keeper and the gateway's localhost calls keep working) and --tls-port
serves the same thing over https.
"""
from __future__ import annotations

import ipaddress
import shutil
import socket
import ssl
import subprocess
import time
from pathlib import Path

SELF_DAYS = 825              # what browsers accept for a leaf certificate
RENEW_AFTER_DAYS = 800       # a kept self-signed certificate older than this is made again


def add_args(ap):
    g = ap.add_argument_group("HTTPS (secure context for GPS, camera, Bluetooth, offline mode -- see bridge/HTTPS.md)")
    g.add_argument("--tls", choices=["self"], help="serve over https with a self-signed certificate (made once with openssl, kept in --tls-dir)")
    g.add_argument("--tls-cert", metavar="FILE", help="serve over https with this certificate (PEM), e.g. from `tailscale cert`")
    g.add_argument("--tls-key", metavar="FILE", help="the private key (PEM) for --tls-cert")
    g.add_argument("--tls-dir", default="~/.kelly-tls", metavar="DIR", help="with --tls self: where the certificate is kept")
    g.add_argument("--tls-port", type=int, default=0, metavar="PORT",
                   help="serve https on this port as well, and keep --port plain http (default: --port itself goes https)")


def on(args) -> bool:
    return bool(getattr(args, "tls", None) or getattr(args, "tls_cert", None))


def _names(bind: str) -> tuple[list[str], list[str]]:
    """DNS names and IP addresses this machine answers to, for the self-signed certificate's subjectAltName."""
    host = socket.gethostname()
    dns = ["localhost", host] + ([host + ".local"] if "." not in host else [])
    ips = {"127.0.0.1", "::1"}
    try:
        ips.update(a[4][0] for a in socket.getaddrinfo(host, None) if a[0] in (socket.AF_INET, socket.AF_INET6))
    except OSError:
        pass
    try:   # the address used to reach the LAN (no packet is sent by a UDP connect)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1)); ips.add(s.getsockname()[0])
    except OSError:
        pass
    if bind not in ("0.0.0.0", "::", "localhost"):
        ips.add(bind)
    good = []
    for ip in ips:
        try:
            a = ipaddress.ip_address(ip.split("%")[0])
            if not a.is_unspecified and not a.is_link_local:
                good.append(str(a))
        except ValueError:
            pass
    return dns, sorted(good)


def self_signed(folder: Path, bind: str = "0.0.0.0") -> tuple[Path, Path]:
    """Make (or reuse) cert.pem + key.pem in folder. Raises SystemExit with a plain reason if it can't."""
    folder.mkdir(parents=True, exist_ok=True)
    cert, key = folder / "cert.pem", folder / "key.pem"
    if cert.is_file() and key.is_file() and time.time() - cert.stat().st_mtime < RENEW_AFTER_DAYS * 86400:
        return cert, key
    exe = shutil.which("openssl")
    if not exe:
        raise SystemExit("[bridge] --tls self needs the openssl program to make a certificate, and it isn't installed. "
                         "On a Pi: sudo apt install openssl. Or make one elsewhere and pass --tls-cert/--tls-key.")
    dns, ips = _names(bind)
    san = ",".join([f"DNS:{d}" for d in dns] + [f"IP:{i}" for i in ips])
    cmd = [exe, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", str(SELF_DAYS),
           "-keyout", str(key), "-out", str(cert), "-subj", f"/CN=Kelly Page {dns[1]}", "-addext", f"subjectAltName={san}"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise SystemExit(f"[bridge] --tls self: openssl didn't run ({e})")
    if r.returncode or not cert.is_file():
        raise SystemExit(f"[bridge] --tls self: openssl failed: {(r.stderr or r.stdout).strip()[-300:]}")
    try:
        key.chmod(0o600)
    except OSError:
        pass
    print(f"[bridge] made a self-signed certificate in {folder} for {', '.join(dns + ips)}", flush=True)
    return cert, key


def context(args) -> ssl.SSLContext | None:
    """The server SSLContext for the bridge's args, or None for plain http. SystemExit on a bad setup."""
    if not on(args):
        return None
    if args.tls == "self" and args.tls_cert:
        raise SystemExit("[bridge] use either --tls self or --tls-cert/--tls-key, not both")
    if args.tls == "self":
        cert, key = self_signed(Path(args.tls_dir).expanduser(), args.bind)
    else:
        if not args.tls_key:
            raise SystemExit("[bridge] --tls-cert needs --tls-key too (tailscale cert writes both: <host>.crt and <host>.key)")
        cert, key = Path(args.tls_cert).expanduser(), Path(args.tls_key).expanduser()
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    try:
        ctx.load_cert_chain(str(cert), str(key))
    except (OSError, ssl.SSLError) as e:
        raise SystemExit(f"[bridge] can't load the certificate {cert} / key {key}: {e}")
    return ctx
