"""Checks for kelly_ent.py's serial binding (`ser` claim) and the KPV1 revocation list -- the vectors in
ent_token_vectors.json that js/enttoken.js also runs (tests/enttoken-test.js) -- plus the pinned-key consistency check.
Run: python test_kelly_ent_rev.py"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import kelly_ent  # noqa: E402

fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


V = json.loads((HERE / "ent_token_vectors.json").read_text(encoding="utf-8"))
for c in V["cases"]:
    ok, why, _ = kelly_ent.verify_token(c["token"], dev=c["dev"], now=c["now"], keys=V["keys"])
    check(f"token vector: {c['name']}", why == c["reason"] and ok == (c["reason"] is None), why)
for c in V["serial"]:
    ok, why, p = kelly_ent.verify_token(c["token"], keys=V["keys"], now=V["cases"][0]["now"])
    check(f"serial vector: {c['name']}", ok and kelly_ent.serial_allowed(p, c["serial"]) == c["ok"], (why, p and p.get("ser")))
for c in V["revocations"]:
    ok, why, p, stale = kelly_ent.verify_revocations(c["doc"], min_seq=c["min_seq"], now=c["now"], keys=V["keys"])
    good = why == c["reason"] and ok == (c["reason"] is None) and (not ok or stale == c["stale"])
    if ok and c["revoked_jti"]:
        good = good and kelly_ent.is_revoked(p, jti=c["revoked_jti"]) and kelly_ent.is_revoked(p, dev=c["revoked_dev"]) \
            and not kelly_ent.is_revoked(p, jti="ffffffffffffffff", dev="nope")
    check(f"revocation vector: {c['name']}", good, (why, stale))
check("revocations: never raises on junk", kelly_ent.verify_revocations(None)[1] == "REV_FORMAT"
      and kelly_ent.verify_revocations("KPV1.a.b")[1] == "REV_FORMAT")
check("revocations: is_revoked with no list", kelly_ent.is_revoked(None, jti="x") is False)
check("serial: no payload -> not bound", kelly_ent.serial_allowed(None, "1") is True)

# the licence public key is pinned in three places; they must agree
root = HERE.parent.parent
js = (root / "kelly-page" / "js" / "enttoken.js").read_text(encoding="utf-8")
srv = (root / "tools" / "p25x-fault-finding-page" / "server.js")
m_js = re.search(r"'kp-2026a':\s*'([0-9a-f]{64})'", js)
m_srv = None
if srv.exists():
    with srv.open(encoding="utf-8") as f:
        for line in f:
            m_srv = re.match(r"const KELLY_REG_KEY = '([0-9a-f]{64})'", line)
            if m_srv:
                break
check("pinned kp-2026a: enttoken.js = kelly_ent.py = server.js KELLY_REG_KEY",
      m_js and m_srv and m_js.group(1) == kelly_ent.KEYS.get("kp-2026a") == m_srv.group(1),
      (m_js and m_js.group(1), kelly_ent.KEYS.get("kp-2026a"), m_srv and m_srv.group(1)))

print("RESULT: " + ("FAIL (" + ", ".join(fails) + ")" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
