"""Kelly bridge device identity (public release plan section 7.2, step 12): ONE Ed25519 key per bridge, so the Pi's
keeper, the PC and the phone that all use one bridge count as one registered device.

The key is made the first time the bridge starts with a writable --ident-dir (default ~/.kelly-ident: on the Pi image
that's the kellypage user's home, so it's made on the member's own Pi, never at image build time). device.key is the
raw 32-byte seed, mode 0600; it never leaves this machine and is never in a config export or /api/kelly-state.
The page asks the bridge to sign; it signs only messages with one of PREFIXES (registration, auth, refresh), so the
key can't be used to sign anything else. The bridge also keeps the station's registration token (token.txt, 0640),
verified against this key, and hands its payload to kelly_ent.

  GET    /api/ident          {pub, kind: "bridge", token}         (404 when there's no identity)
  POST   /api/ident/sign     {msg: b64u}  -> {sig: b64u}          (403 for any other prefix)
  POST   /api/ident/token    {token}      -> {ok, payload} / 400 {error: reason code}
  DELETE /api/ident/token                 -> {ok}
This machine, or the bridge token (?token= / X-Kelly-Token) -- like /api/igate.
Needs python3-cryptography; without it there's no bridge identity and the page uses its own browser key.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

import kelly_ent

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
except ImportError:  # pragma: no cover
    Ed25519PrivateKey = None

PREFIXES = (b"P25X-AUTH|", b"P25X-POP|", b"P25X-REFRESH|")
MAX_MSG = 512
log = logging.getLogger("kelly.ident")


class Ident:
    def __init__(self, folder: str | None):
        self.dir = Path(os.path.expanduser(folder)) if folder else None
        self.key = None
        self.pub = ""
        self.token = ""
        if not self.dir or Ed25519PrivateKey is None:
            if self.dir:
                log.info("no python3-cryptography: no bridge identity (the page uses its own key)")
            return
        f = self.dir / "device.key"
        try:
            if f.exists():
                seed = f.read_bytes()
            else:
                self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
                seed = os.urandom(32)
                fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as out:
                    out.write(seed)
                log.info("made this bridge's device key in %s", self.dir)
            if len(seed) != 32:
                raise ValueError(f"{f} is not a 32-byte key")
            self.key = Ed25519PrivateKey.from_private_bytes(seed)
            self.pub = kelly_ent.b64u(self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))
        except (OSError, ValueError) as e:
            log.warning("no bridge identity: %s", e)
            self.key = None
            return
        t = self.dir / "token.txt"
        if t.exists():
            try:
                self.set_token(t.read_text(encoding="utf-8").strip(), save=False)
            except (OSError, ValueError) as e:
                log.info("stored token not used: %s", e)

    def sign(self, msg: bytes) -> bytes:
        if not self.key:
            raise PermissionError("no identity")
        if len(msg) > MAX_MSG or not msg.startswith(PREFIXES):
            raise PermissionError("not a registration message")
        return self.key.sign(msg)

    def set_token(self, token: str, save: bool = True) -> dict:
        """Verify against this device and keep it; ValueError(reason code) when refused."""
        ok, why, payload = kelly_ent.verify_token(token, dev=self.pub)
        if not ok:
            raise ValueError(why)
        self.token = token
        kelly_ent.set_token(payload)
        if save:
            f = self.dir / "token.txt"
            f.write_text(token + "\n", encoding="utf-8")
            os.chmod(f, 0o640)
        log.info("registration token for %s, %d feature(s), until %s", payload.get("sub"), len(payload.get("feat") or []),
                 payload.get("exp"))
        return payload

    def clear_token(self) -> None:
        self.token = ""
        kelly_ent.set_token(None)
        if self.dir:
            (self.dir / "token.txt").unlink(missing_ok=True)


async def http(ident: Ident, method: str, path: str, headers: dict, reader, writer, allowed: bool):
    """/api/ident[/sign|/token] for kelly_bridge.handle(). Same-origin only (no CORS): only a page the bridge serves
    uses the bridge's identity."""
    status, out = "200 OK", {}
    req = {}
    if method == "POST":
        try:
            n = int(headers.get("content-length", "0") or 0)
            req = json.loads((await reader.readexactly(n)).decode("utf-8")) if 0 < n < 8192 else {}
        except (ValueError, asyncio.IncompleteReadError):
            status, out = "400 Bad Request", {"error": "bad JSON"}
    if not isinstance(req, dict):
        req = {}
    if not allowed:
        status, out = "403 Forbidden", {"error": "token"}
    elif not ident.key:
        status, out = "404 Not Found", {"error": "no identity"}
    elif status.startswith("200"):
        if path == "/api/ident" and method == "GET":
            out = {"pub": ident.pub, "kind": "bridge", "token": ident.token}
        elif path == "/api/ident/sign" and method == "POST":
            msg = kelly_ent.unb64u(req.get("msg", ""))
            try:
                out = {"sig": kelly_ent.b64u(ident.sign(msg or b""))}
            except PermissionError as e:
                status, out = "403 Forbidden", {"error": str(e)}
        elif path == "/api/ident/token" and method == "POST":
            try:
                out = {"ok": True, "payload": ident.set_token(str(req.get("token", "")))}
            except ValueError as e:
                status, out = "400 Bad Request", {"error": str(e)}
        elif path == "/api/ident/token" and method == "DELETE":
            ident.clear_token()
            out = {"ok": True}
        else:
            status, out = "404 Not Found", {"error": "no such endpoint"}
    body = json.dumps(out).encode()
    writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n"
                 f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    await writer.drain()
    writer.close()
