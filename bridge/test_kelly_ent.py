"""Checks for kelly_ent.py (the bridge's entitlements) and the bridge's use of it. Run: python test_kelly_ent.py"""
import logging
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import kelly_ent  # noqa: E402
import kelly_bridge as kb  # noqa: E402

fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


# ---- private build (the members' build): everything allowed (set explicitly: the public export ships BUILD = "public")
kelly_ent.BUILD = "private"
check("private: club services allowed", kelly_ent.allowed("svc.club") and kelly_ent.allowed("p25.gateway"))
check("private: the build expiry still applies", kb.expired() == (kb.datetime.date.today() > kb.EXPIRES_ON))

# ---- public build
kelly_ent.BUILD = "public"
check("public: club services refused", not kelly_ent.allowed("svc.club") and not kelly_ent.allowed("p25.gateway"))
check("public: open / unknown features allowed", kelly_ent.allowed("mesh") and kelly_ent.allowed("anything.else"))
check("public: no build expiry", kb.expired() is False)
seen = []
h = logging.Handler(); h.emit = lambda r: seen.append(r.getMessage())
kelly_ent.log.addHandler(h); kelly_ent.log.setLevel(logging.DEBUG)
check("public: check() refuses quietly", kelly_ent.check("svc.club", "--mesh-gateway") is False)
check("public: the reason goes to the debug log only", seen == ["ENT_NO_TOKEN svc.club @--mesh-gateway"], seen)
kelly_ent.set_token({"sub": "VK9TST", "feat": ["svc.club"], "exp": time.time() + 3600})
check("public + token: a listed feature allowed", kelly_ent.allowed("svc.club"))
check("public + token: an unlisted one refused", kelly_ent.reason("p25.gateway") == "ENT_NO_FEATURE")
kelly_ent.set_token({"sub": "VK9TST", "feat": ["svc.club"], "exp": time.time() - 1})
check("public + expired token: refused", kelly_ent.reason("svc.club") == "ENT_EXPIRED")
kelly_ent.set_token(None)
kelly_ent.BUILD = "private"

# ---- registration tokens: the vectors js/enttoken.js also runs (tests/enttoken-test.js)
import json  # noqa: E402
V = json.loads((HERE / "ent_token_vectors.json").read_text(encoding="utf-8"))
for c in V["cases"]:
    ok, why, _ = kelly_ent.verify_token(c["token"], dev=c["dev"], now=c["now"], keys=V["keys"])
    check(f"token vector: {c['name']}", why == c["reason"] and ok == (c["reason"] is None), why)
check("token: the test key is never pinned", "kp-test" not in kelly_ent.KEYS and all(len(k) == 64 for k in kelly_ent.KEYS.values()))
check("token: verify never raises on junk", kelly_ent.verify_token(None)[1] == "TOK_FORMAT" and kelly_ent.verify_token("a.b")[1] == "TOK_FORMAT")

print("RESULT: " + ("FAIL (" + ", ".join(fails) + ")" if fails else "ALL PASS"))
sys.exit(1 if fails else 0)
