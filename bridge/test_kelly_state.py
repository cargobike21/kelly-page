"""Checks for the awards a member's Kellys share through their bridge (kelly_state.py, /api/kelly-state).
Run: python3 bridge/test_kelly_state.py  (stdlib only; prints RESULT: ALL PASS / FAIL)

Covers: the merge vectors in kelly_state_vectors.json (js/statesync.js runs the same ones, tests/statesync-cdp.js),
merging is order-free for awards and never loses one, the store (unknown keys and oversize values left out, kept in
the file, read back after a restart). Then a real bridge (--token): two Kellys POST different badges and both GET
both; a remote caller is refused without the token (with CORS) and answered with it; the state is still there after
the bridge restarts."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kelly_state as ks  # noqa: E402

HERE = Path(__file__).parent
BRIDGE = HERE / "kelly_bridge.py"
fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


# ---- the merge rule, the same vectors as the page's
for v in json.loads((HERE / "kelly_state_vectors.json").read_text(encoding="utf-8")):
    got = ks.merge(v["a"], v["b"], tuple(v["path"]))
    check(f"merge: {v['name']}", got == v["want"], got)
a = {"badges": {"x": 1}, "xp": 10, "streak": {"n": 1, "best": 1, "last": "2026-10-01"}}
b = {"badges": {"y": 2}, "xp": 20, "streak": {"n": 3, "best": 3, "last": "2026-10-02"}}
check("merge: badges and xp the same either way round", ks.merge(a, b, ("meshQuest",)) == ks.merge(b, a, ("meshQuest",)))
m = ks.merge(a, b, ("meshQuest",))
check("merge: nothing earned is lost", set(m["badges"]) == {"x", "y"} and m["xp"] == 20 and m["streak"]["best"] == 3, m)
check("merge: a list stays at most 500", len(ks.merge(list(range(400)), list(range(300, 700)), ("issQuest", "passes"))) == 500)

# ---- the store
tmp = Path(tempfile.mkdtemp(prefix="kstate-"))
f = tmp / "state.json"
s = ks.KellyState(f)
out = s.put({"meshQuest": {"badges": {"a": 1}}, "settings": {"evil": 1}, "fireQuest": {"x": "y" * (ks.MAX_VALUE + 10)}})
check("store: only the award keys, oversize left out", list(out) == ["meshQuest"], list(out))
s.put({"meshQuest": {"badges": {"b": 2}}})
check("store: POST merges, never replaces", s.state["meshQuest"]["badges"] == {"a": 1, "b": 2}, s.state)
check("store: kept in the file", json.loads(f.read_text(encoding="utf-8"))["meshQuest"]["badges"] == {"a": 1, "b": 2})
if os.name == "posix":
    check("store: file 0600", (f.stat().st_mode & 0o777) == 0o600, oct(f.stat().st_mode))
check("store: read back", ks.KellyState(f).state == s.state)
check("store: '' = in memory only", ks.KellyState(None).put({"swQuest": {"xp": 1}}) == {"swQuest": {"xp": 1}})


# ---- a real bridge
def free_port() -> int:
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


port, sf = free_port(), tmp / "bridge-state.json"


def start():
    p = subprocess.Popen([sys.executable, str(BRIDGE), "--bind", "0.0.0.0", "--port", str(port), "--token", "s3cret", "--kelly-state", str(sf),
                          "--share-dir", str(tmp / "share"), "--mesh-outbox", str(tmp / "outbox.sqlite")],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            return p
        except OSError:
            time.sleep(0.1)
    return p


def stop(p):
    p.terminate()
    try:
        p.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()


def req(path, body=None, host="127.0.0.1", hdr=None):
    r = urllib.request.Request(f"http://{host}:{port}{path}", data=None if body is None else json.dumps(body).encode(),
                               headers={"Content-Type": "text/plain", **(hdr or {})}, method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(r, timeout=10) as x:
            return x.status, dict(x.headers), json.loads(x.read())
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), json.loads(e.read() or b"{}")


p = start()
try:
    st, hd, js = req("/api/kelly-state?token=s3cret", {"meshQuest": {"badges": {"pc-badge": 1}, "xp": 100}})
    check("bridge: the PC's POST answers the merged state", st == 200 and js["meshQuest"]["badges"] == {"pc-badge": 1}, (st, js))
    st, hd, js = req("/api/kelly-state?token=s3cret", {"meshQuest": {"badges": {"phone-badge": 2}, "xp": 40}})
    check("bridge: the phone's POST merges in", st == 200 and js["meshQuest"]["badges"] == {"pc-badge": 1, "phone-badge": 2} and js["meshQuest"]["xp"] == 100, js)
    st, hd, js = req("/api/kelly-state")
    check("bridge: GET (this machine) has both, with CORS", st == 200 and len(js["meshQuest"]["badges"]) == 2 and hd.get("Access-Control-Allow-Origin") == "*", (st, hd))
    st, hd, js = req("/api/kelly-state", {"meshQuest": {"badges": {"z": 1}}, "nope": 1})
    check("bridge: an unknown key left out", "nope" not in js, js)
    lan = ""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as so:
            so.connect(("192.0.2.1", 9))
            lan = so.getsockname()[0]
    except OSError:
        pass
    if not lan or lan.startswith("127."):
        print("SKIP remote /api/kelly-state: this machine has no LAN address")
    else:
        st, hd, js = req("/api/kelly-state", host=lan)
        check("bridge: remote without token -> 403 (CORS)", st == 403 and js.get("error") == "token" and hd.get("Access-Control-Allow-Origin") == "*", (st, js))
        st, hd, js = req("/api/kelly-state", {"meshQuest": {"badges": {"evil": 1}}}, host=lan)
        check("bridge: remote POST without token -> 403", st == 403, st)
        st, hd, js = req("/api/kelly-state?token=s3cret", host=lan)
        st, hd, js = req("/api/kelly-state", host=lan, hdr={"X-Kelly-Token": "s3cret"})
        check("bridge: remote with the token in X-Kelly-Token -> the state", st == 200 and "pc-badge" in js["meshQuest"]["badges"], st)
        st, hd, js = req("/api/kelly-state", host=lan, hdr={"X-Kelly-Token": "wrong"})
        check("bridge: remote with a wrong X-Kelly-Token -> 403", st == 403, st)
        st, hd, js = req("/api/kelly-state?token=s3cret", host=lan)
        check("bridge: remote with the token -> the state", st == 200 and "pc-badge" in js["meshQuest"]["badges"] and "evil" not in js["meshQuest"]["badges"], (st, js))
    time.sleep(ks.KellyState.SAVE_GAP_S + 0.5)   # the debounced save (Windows' terminate() is no SIGTERM; systemd's is)
finally:
    stop(p)
p = start()
try:
    st, hd, js = req("/api/kelly-state")
    check("bridge: still there after a restart", st == 200 and set(js.get("meshQuest", {}).get("badges", {})) == {"pc-badge", "phone-badge", "z"}, js)
finally:
    stop(p)

print(f"RESULT: {'FAIL (' + str(len(fails)) + ')' if fails else 'ALL PASS'}")
sys.exit(1 if fails else 0)
