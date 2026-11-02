"""KPU1 signed release manifest: "KPU1." + b64url(JSON payload) + "." + b64url(Ed25519 signature over "KPU1." + payload segment).

Shared by the Pi updater (/usr/local/sbin/kellypage-autoupdate) and scripts/sign_release.py (offline signing, on the
club's PC). Only the python3-cryptography package is needed (the image already installs it). See RELEASE-SIGNING.md.
"""
import base64
import calendar
import hashlib
import json
import re
import time

PREFIX = "KPU1."
PRODUCTS = ("kellypage-pi", "kellypage-zip")
CHANNELS = ("stable", "beta")
MAX_MANIFEST = 64 * 1024


class ManifestError(Exception):
    """The manifest is not acceptable (bad shape, unknown key, bad signature)."""


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def unb64u(s: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]*", s):
        raise ManifestError("bad base64url")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def parse_version(v) -> tuple:
    if not isinstance(v, str) or not re.fullmatch(r"\d+(\.\d+){1,3}", v):
        raise ManifestError("bad version %r" % (v,))
    return tuple(int(x) for x in v.split("."))


def canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def sign(payload: dict, seed: bytes, kid: str = None) -> str:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    if len(seed) != 32:
        raise ManifestError("seed must be 32 bytes")
    if kid is not None and payload.get("kid") != kid:
        raise ManifestError("payload kid does not match signing kid")
    seg = PREFIX + b64u(canonical(payload))
    sig = Ed25519PrivateKey.from_private_bytes(seed).sign(seg.encode("ascii"))
    return seg + "." + b64u(sig)


def public_hex(seed: bytes) -> str:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization as s
    pub = Ed25519PrivateKey.from_private_bytes(seed).public_key()
    return pub.public_bytes(s.Encoding.Raw, s.PublicFormat.Raw).hex()


def load_keys(path: str) -> dict:
    """release-keys.json: {"keys": {"<kid>": "<64 hex raw Ed25519 public key>", ...}} -> {kid: bytes}."""
    with open(path, "r", encoding="utf-8") as f:
        d = json.load(f)
    keys = {}
    for kid, hx in (d.get("keys") or {}).items():
        if not re.fullmatch(r"[0-9a-fA-F]{64}", str(hx)):
            raise ManifestError("bad public key for %s" % kid)
        keys[kid] = bytes.fromhex(hx)
    return keys


MAX_AGE_NO_EXPIRY = 400 * 86400   # a manifest without `expires` is refused once its `at` is older than this


def check_fresh(p: dict, now: float = None) -> None:
    """Refuse an expired manifest (`expires`, unix seconds), or -- with no `expires` -- one signed over 400 days ago."""
    now = time.time() if now is None else now
    exp = p.get("expires")
    if exp is not None:
        if not isinstance(exp, int) or isinstance(exp, bool):
            raise ManifestError("bad expires")
        if now > exp:
            raise ManifestError("manifest expired")
        return
    try:
        at = calendar.timegm(time.strptime(str(p.get("at")), "%Y-%m-%dT%H:%M:%SZ"))
    except ValueError:
        raise ManifestError("bad at")
    if now - at > MAX_AGE_NO_EXPIRY:
        raise ManifestError("manifest is older than 400 days and has no expires")


def verify(token: str, keys: dict, fresh: bool = True, now: float = None) -> dict:
    """Returns the payload if the signature is valid under a pinned key and the payload is well-formed (and, unless
    fresh=False, not expired)."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    token = (token or "").strip()
    if len(token) > MAX_MANIFEST or not token.startswith(PREFIX):
        raise ManifestError("not a KPU1 manifest")
    parts = token.split(".")
    if len(parts) != 3:
        raise ManifestError("not a KPU1 manifest")
    seg = parts[0] + "." + parts[1]
    try:
        payload = json.loads(unb64u(parts[1]).decode("utf-8"))
        sig = unb64u(parts[2])
    except (ValueError, UnicodeDecodeError) as e:
        raise ManifestError("undecodable manifest: %s" % e)
    if not isinstance(payload, dict):
        raise ManifestError("payload is not an object")
    kid = payload.get("kid")
    if kid not in keys:
        raise ManifestError("unknown key id %r" % (kid,))
    try:
        Ed25519PublicKey.from_public_bytes(keys[kid]).verify(sig, seg.encode("ascii"))
    except (InvalidSignature, ValueError):
        raise ManifestError("bad signature")
    check_payload(payload)
    if fresh:
        check_fresh(payload, now)
    return payload


def check_payload(p: dict) -> None:
    if p.get("v") != 1:
        raise ManifestError("unsupported manifest version %r" % (p.get("v"),))
    if p.get("product") not in PRODUCTS:
        raise ManifestError("unknown product %r" % (p.get("product"),))
    if p.get("channel") not in CHANNELS:
        raise ManifestError("unknown channel %r" % (p.get("channel"),))
    parse_version(p.get("version"))
    if p.get("min_from") not in (None, ""):
        parse_version(p.get("min_from"))
    files = p.get("files")
    if not isinstance(files, list) or not files:
        raise ManifestError("no files")
    for f in files:
        if not isinstance(f, dict):
            raise ManifestError("bad file entry")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", str(f.get("name", ""))):
            raise ManifestError("bad file name")
        if not str(f.get("url", "")).startswith("https://"):
            raise ManifestError("file url must be https")
        if not re.fullmatch(r"[0-9a-f]{64}", str(f.get("sha256", ""))):
            raise ManifestError("bad sha256")
        if not isinstance(f.get("size"), int) or isinstance(f.get("size"), bool) or f["size"] <= 0:
            raise ManifestError("bad size")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
