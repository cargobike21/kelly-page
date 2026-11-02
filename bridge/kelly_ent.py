"""Kelly bridge entitlements -- the bridge's twin of js/entitlements.js (same feature names, same reason codes).

BUILD = "private" (the members' build: everything allowed) or "public" (scripts/export_kelly_public.py rewrites this
one line). In the public build, member / registered features need a verified registration token naming them; until
token support lands there is none, so they are off. A refusal is silent: the feature simply isn't there (a flag is
ignored, an endpoint answers 404) and the reason goes to the debug log only (logger "kelly.ent", run with --debug).

The gateway, not this file, is the real enforcement: it answers only registered radios.
"""
from __future__ import annotations

import base64
import json
import logging
import time

try:   # Ed25519 for registration tokens (Debian: python3-cryptography); without it no token verifies -> member features off
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
except ImportError:  # pragma: no cover
    Ed25519PublicKey = None

BUILD = "public"

FEATURES = {
    "p25.gateway": "member",    # anything that only exists to serve P25 gateway traffic (the Share station store)
    "svc.club": "member",       # the club's services: --mesh-gateway role, --mesh-history-upload to the club ingest
    "tait.program": "registered",
}

# Registration tokens: the same format, keys and reason codes as js/enttoken.js (both run ent_token_vectors.json).
# token = seg "." b64u(sig); seg = b64u(JSON payload); sig = Ed25519 over b"KPT1." + seg by KEYS[payload.kid].
KEYS = {
    "kp-2026a": "d5ecbe1d7ec4e3147164a5c0be0da490e9ab7a87248b7f270f9e6e6d3d2e7781",
}
SKEW_S = 300
DOMAIN = b"KPT1."

log = logging.getLogger("kelly.ent")
_token: dict | None = None
_revoked = False            # this token / device is on the signed revocation list (the bridge's hourly pull sets it)
_serial: str | None = None  # the connected radio's serial (CCDI q4), for a token's optional ser binding


def set_token(payload: dict | None) -> None:
    """A verified registration token's payload (signature checked by the caller), or None."""
    global _token
    _token = payload
    set_revocations(_rev_list)             # a refreshed token has a new jti: check it against the list we hold


def reason(feature: str) -> str | None:
    """Why a feature is refused, or None when it is allowed."""
    tier = FEATURES.get(feature, "open")
    if tier == "never":                 # a radio command this build doesn't have (= entitlements.js)
        return "ENT_NOT_IN_BUILD"
    if tier == "open" or BUILD == "private":
        return None
    if not _token:
        return "ENT_NO_TOKEN"
    if _revoked:
        return "ENT_REVOKED"
    if _token.get("exp") and _token["exp"] < time.time():
        return "ENT_EXPIRED"
    if "ser" in _token and _serial and not serial_allowed(_token, _serial):
        return "ENT_SERIAL"
    if feature not in (_token.get("feat") or []):
        return "ENT_NO_FEATURE"
    return None


def allowed(feature: str) -> bool:
    return reason(feature) is None


def check(feature: str, where: str = "") -> bool:
    """allowed() with a debug line when refused -- use at a gate."""
    why = reason(feature)
    if why:
        log.debug("%s %s%s", why, feature, f" @{where}" if where else "")
    return why is None


def public() -> bool:
    return BUILD == "public"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def unb64u(s: str) -> bytes | None:
    s = str(s or "")
    if not all(c.isalnum() or c in "-_" for c in s) or len(s) % 4 == 1:
        return None
    try:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except ValueError:
        return None


def peek(token: str) -> dict | None:
    """The payload without checking anything (to show a refused token), or None."""
    parts = str(token or "").strip().split(".")
    raw = unb64u(parts[0]) if len(parts) == 2 else None
    if raw is None:
        return None
    try:
        p = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return p if isinstance(p, dict) else None


def verify_token(token: str, dev: str | None = None, now: float | None = None,
                 keys: dict | None = None) -> tuple[bool, str | None, dict | None]:
    """(ok, reason, payload) -- never raises. dev = this device's b64u public key (None = don't check the device)."""
    keys = KEYS if keys is None else keys
    parts = str(token or "").strip().split(".")
    payload = peek(token) if len(parts) == 2 else None
    if payload is None:
        return False, "TOK_FORMAT", None
    if payload.get("v") != 1:
        return False, "TOK_VERSION", payload
    key = keys.get(payload.get("kid")) if isinstance(payload.get("kid"), str) else None
    if not key or len(key) != 64:
        return False, "TOK_KID", payload
    sig = unb64u(parts[1])
    if Ed25519PublicKey is None:
        return False, "TOK_NO_CRYPTO", payload
    try:
        if not sig or len(sig) != 64:
            raise InvalidSignature
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(key)).verify(sig, DOMAIN + parts[0].encode())
    except (InvalidSignature, ValueError):
        return False, "TOK_SIG", payload
    num = (int, float)
    if (not isinstance(payload.get("sub"), str) or not isinstance(payload.get("dev"), str)
            or not isinstance(payload.get("feat"), list) or not isinstance(payload.get("exp"), num)
            or isinstance(payload.get("exp"), bool) or ("llid" in payload and not isinstance(payload["llid"], list))
            or ("ser" in payload and not (isinstance(payload["ser"], list) and all(isinstance(s, str) for s in payload["ser"])))):
        return False, "TOK_FORMAT", payload
    t = time.time() if now is None else now
    if isinstance(payload.get("nbf"), num) and t + SKEW_S < payload["nbf"]:
        return False, "TOK_NOT_YET", payload
    if t - SKEW_S >= payload["exp"]:
        return False, "TOK_EXPIRED", payload
    if dev is not None and payload["dev"] != dev:
        return False, "TOK_DEVICE", payload
    return True, None, payload


# ---- optional serial binding + the signed revocation list (= js/enttoken.js serialAllowed / verifyRevocations)

def serial_allowed(payload: dict | None, serial: str | None) -> bool:
    """True when the token has no `ser` claim, or names this radio's serial (CCDI q4)."""
    if not payload or "ser" not in payload:
        return True
    if not isinstance(payload["ser"], list):
        return False
    s = str(serial or "").strip().upper()
    return bool(s) and any(str(x).strip().upper() == s for x in payload["ser"])


REV_DOMAIN = b"KPV1."


def verify_revocations(doc: str, min_seq: int | None = None, now: float | None = None,
                       keys: dict | None = None) -> tuple[bool, str | None, dict | None, bool]:
    """(ok, reason, payload, stale) for a kellypage.app/api/revoked document -- never raises.

    doc = "KPV1." seg "." b64u(sig), sig over b"KPV1." + seg by KEYS[payload.kid]; payload {v: 1, kid, seq, at, next,
    jti: [...], dev: [...]}. min_seq = the highest seq accepted before (an older list is REV_OLD). stale = past `next`.
    """
    keys = KEYS if keys is None else keys
    s = str(doc or "").strip()
    parts = s[len(REV_DOMAIN):].split(".") if s.startswith(REV_DOMAIN.decode()) else []
    payload = None
    if len(parts) == 2:
        raw = unb64u(parts[0])
        try:
            payload = json.loads(raw.decode("utf-8")) if raw is not None else None
        except (ValueError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, dict):
            payload = None
    if payload is None:
        return False, "REV_FORMAT", None, False
    if payload.get("v") != 1:
        return False, "REV_VERSION", payload, False
    key = keys.get(payload.get("kid")) if isinstance(payload.get("kid"), str) else None
    if not key or len(key) != 64:
        return False, "REV_KID", payload, False
    if Ed25519PublicKey is None:
        return False, "REV_NO_CRYPTO", payload, False
    sig = unb64u(parts[1])
    try:
        if not sig or len(sig) != 64:
            raise InvalidSignature
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(key)).verify(sig, REV_DOMAIN + parts[0].encode())
    except (InvalidSignature, ValueError):
        return False, "REV_SIG", payload, False

    def strs(a):
        return isinstance(a, list) and all(isinstance(x, str) for x in a)
    num = (int, float)
    seq = payload.get("seq")
    if (not isinstance(seq, int) or isinstance(seq, bool) or not isinstance(payload.get("at"), num)
            or not isinstance(payload.get("next"), num) or not strs(payload.get("jti")) or not strs(payload.get("dev"))):
        return False, "REV_FORMAT", payload, False
    if min_seq is not None and seq < min_seq:
        return False, "REV_OLD", payload, False
    t = time.time() if now is None else now
    return True, None, payload, t - SKEW_S > payload["next"]


def is_revoked(rev: dict | None, jti: str | None = None, dev: str | None = None) -> bool:
    """Is this token ID or device key on a verified revocation list's payload?"""
    if not rev:
        return False
    return bool((jti and jti in (rev.get("jti") or [])) or (dev and dev in (rev.get("dev") or [])))


_rev_list: dict | None = None   # the last verified revocation list payload


def set_revocations(payload: dict | None) -> bool:
    """Keep a verified revocation list payload (verify_revocations) and re-evaluate this token against it."""
    global _rev_list, _revoked
    _rev_list = payload
    _revoked = bool(_token and is_revoked(payload, _token.get("jti"), _token.get("dev")))
    return _revoked


def set_revoked(on: bool) -> None:
    global _revoked
    _revoked = bool(on)


def set_serial(serial: str | None) -> None:
    global _serial
    _serial = str(serial) if serial else None
