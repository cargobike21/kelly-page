"""Checks for kelly_ident.py (the bridge's device key + registration token). Run: python test_kelly_ident.py"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import kelly_ent  # noqa: E402
import kelly_ident  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey  # noqa: E402
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat  # noqa: E402


def make(payload, key):   # a token, as the registration service makes them (js/enttoken.js format)
    seg = kelly_ent.b64u(json.dumps(payload, separators=(",", ":")).encode())
    return f"{seg}.{kelly_ent.b64u(key.sign(kelly_ent.DOMAIN + seg.encode()))}"

fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


tmp = Path(tempfile.mkdtemp(prefix="kelly-ident-"))
d = tmp / "ident"
a = kelly_ident.Ident(str(d))
check("key made on first start", a.key is not None and (d / "device.key").stat().st_size == 32)
if os.name == "posix":
    check("device.key is 0600", (d / "device.key").stat().st_mode & 0o777 == 0o600)
check("public key is 43 b64u chars", len(a.pub) == 43 and len(kelly_ent.unb64u(a.pub)) == 32)
b = kelly_ident.Ident(str(d))
check("same key on the next start", b.pub == a.pub)
check("no folder = no identity", kelly_ident.Ident(None).key is None and kelly_ident.Ident("").key is None)

msg = b"P25X-AUTH|tid|5051234|29891666|nonce"
sig = a.sign(msg)
try:
    Ed25519PublicKey.from_public_bytes(kelly_ent.unb64u(a.pub)).verify(sig, msg)
    check("signs a P25X-AUTH message (verifies with its public key)", True)
except Exception as e:  # noqa: BLE001
    check("signs a P25X-AUTH message (verifies with its public key)", False, e)
for bad in (b"KPT1.anything", b"P25X-AUTHX", b"hello", b"P25X-AUTH|" + b"x" * 600):
    try:
        a.sign(bad)
        check(f"refuses to sign {bad[:12]!r}", False)
    except PermissionError:
        check(f"refuses to sign {bad[:12]!r}", True)

# a token for this device, signed by the test key (pinned for this test only)
TEST = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))       # = ent_token_vectors.json's test key
kelly_ent.KEYS["kp-test"] = TEST.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
import time  # noqa: E402
now = int(time.time())
pay = {"v": 1, "kid": "kp-test", "jti": "1", "sub": "VK4XYZ", "dev": a.pub, "llid": [5051234], "feat": ["svc.club"],
       "net": {"gw": [5059999]}, "iat": now, "nbf": now, "exp": now + 86400}
tok = make(pay, TEST)
other = make({**pay, "dev": kelly_ent.b64u(bytes(32))}, TEST)
try:
    a.set_token(other)
    check("a token for another device refused", False)
except ValueError as e:
    check("a token for another device refused", str(e) == "TOK_DEVICE", str(e))
kelly_ent.BUILD = "public"
check("public build, no token: svc.club off", not kelly_ent.allowed("svc.club"))
a.set_token(tok)
check("token kept + features on", a.token == tok and kelly_ent.allowed("svc.club") and not kelly_ent.allowed("p25.gateway"))
kelly_ent.set_token(None)
c = kelly_ident.Ident(str(d))
check("token comes back on the next start", c.token == tok and kelly_ent.allowed("svc.club"))
c.clear_token()
check("cleared: gone from disk and features off", not (d / "token.txt").exists() and not kelly_ent.allowed("svc.club"))
kelly_ent.BUILD = "private"


# ---- the HTTP side
class W:
    def __init__(self): self.buf = b""
    def write(self, b): self.buf += b
    async def drain(self): pass
    def close(self): pass


async def call(method, path, body=None, allowed=True, ident=a):
    r = asyncio.StreamReader()
    raw = json.dumps(body).encode() if body is not None else b""
    r.feed_data(raw); r.feed_eof()
    w = W()
    await kelly_ident.http(ident, method, path, {"content-length": str(len(raw))}, r, w, allowed)
    head, _, rest = w.buf.partition(b"\r\n\r\n")
    return head.split(b" ")[1].decode(), json.loads(rest)


async def http_checks():
    st, out = await call("GET", "/api/ident")
    check("GET /api/ident: the public key", st == "200" and out["pub"] == a.pub and out["kind"] == "bridge", (st, out))
    st, _ = await call("GET", "/api/ident", allowed=False)
    check("not this machine, no token: 403", st == "403", st)
    st, out = await call("POST", "/api/ident/sign", {"msg": kelly_ent.b64u(msg)})
    check("POST sign: a P25X-AUTH message signed", st == "200" and len(kelly_ent.unb64u(out["sig"])) == 64, (st, out))
    st, _ = await call("POST", "/api/ident/sign", {"msg": kelly_ent.b64u(b"KPT1.forged")})
    check("POST sign: anything else 403", st == "403", st)
    st, out = await call("POST", "/api/ident/token", {"token": other})
    check("POST token: another device's 400 TOK_DEVICE", st == "400" and out["error"] == "TOK_DEVICE", (st, out))
    st, out = await call("POST", "/api/ident/token", {"token": tok})
    check("POST token: kept", st == "200" and out["payload"]["sub"] == "VK4XYZ", (st, out))
    st, out = await call("GET", "/api/ident")
    check("GET shows the token", out.get("token") == tok)
    st, _ = await call("DELETE", "/api/ident/token")
    check("DELETE token", st == "200" and a.token == "")
    st, _ = await call("GET", "/api/ident", ident=kelly_ident.Ident(None))
    check("no identity: 404", st == "404", st)

asyncio.run(http_checks())
del kelly_ent.KEYS["kp-test"]

print("RESULT: " + ("FAIL (" + ", ".join(fails) + ")" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
