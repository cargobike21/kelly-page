"""Checks for the APRS iGate's APRS-IS connection (kelly_igate.py, /api/igate).
Run: python3 bridge/test_kelly_igate.py  (stdlib only; prints RESULT: ALL PASS / FAIL)

Covers: the shared vectors in igate_vectors.json (js/igate.js runs the same ones, tests/igate-tests.html), the token
bucket and the backoff on fake clocks, the login reply. Then a fake APRS-IS server on localhost: a verified login sends
exactly the qAO packet; the bucket drops the excess; a bad callsign / position is refused; an unverified passcode sends
nothing and waits; dry run never connects; a dropped connection comes back after the backoff; keepalive + status line.
Then a real bridge (--token): /api/igate from this machine, refused from the LAN without the token."""
import asyncio
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import os
import tempfile

os.environ["KELLY_IGATE_PRIVACY_FILE"] = os.path.join(tempfile.mkdtemp(), "privacy.json")   # never the real one
os.environ["KELLY_IGATE_RX_FILE"] = os.path.join(tempfile.mkdtemp(), "rx.jsonl")            # never the real one
sys.path.insert(0, str(Path(__file__).parent))
import kelly_igate as ki  # noqa: E402

HERE = Path(__file__).parent
MPRS_VEC = next((p for p in (HERE.parents[1] / "MeshPRS" / "test-vectors", HERE.parent / "MeshPRS" / "test-vectors") if p.is_dir()), HERE.parents[1] / "MeshPRS" / "test-vectors")
fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


# ---- the shared vectors
V = json.loads((HERE / "igate_vectors.json").read_text(encoding="utf-8"))
for c, want in V["passcode"]:
    check(f"passcode {c}", ki.passcode(c) == want, ki.passcode(c))
for c, want in V["base"]:
    check(f"callsign {c!r} {'ok' if want else 'refused'}", ki.valid_base(c) == want)
for c, s, want in V["full"]:
    check(f"CALL-SSID {c} {s}", ki.full_call(c, s) == want, ki.full_call(c, s))
for s, want in V["symbol"]:
    check(f"symbol {s!r}", ki.valid_symbol(s) == want)
for v, amb, want in V["lat"]:
    check(f"lat {v} amb {amb}", ki.fmt_lat(v, amb) == want, ki.fmt_lat(v, amb))
for v, amb, want in V["lon"]:
    check(f"lon {v} amb {amb}", ki.fmt_lon(v, amb) == want, ki.fmt_lon(v, amb))
for p, want in V["packet"]:
    got = ki.packet(p["src"], p["igate"], p["lat"], p["lon"], p.get("sym", "/>"), p.get("comment", ""), p.get("amb", 0))
    check(f"packet {p['src']}", got == want, got)
for c, t, want in V["status"]:
    check("status line", ki.status_packet(c, t) == want, ki.status_packet(c, t))
for c in V["telemetry"]:
    check(f"telemetry ok: {c['name']}", ki.telemetry_ok(c["src"], c["body"]) and all(ki.telemetry_ok(c["src"], d) for d in c["defs"]), c)
for name, want in V["from_name"]:
    r = ki.call_from_name(name)
    got = (r[0] + (f"-{r[1]}" if r[1] else "")) if r else None
    check(f"callsign at the start of {name!r} -> {want}", got == want, got)
for src, name, want in V["ham_node"]:
    check(f"ham node {src} named {name!r} -> {want}", ki.ham_node(src, name) == want)
for src, body in V["telemetry_bad"]:
    check(f"telemetry refused: {body!r}", not ki.telemetry_ok(src, body))
check("tocall APZKPG", ki.TOCALL == "APZKPG")
check("CALL-SSID for the page's src: VK4XXX-9 ok, VK4XXX / -0 / -16 refused",
      ki.valid_call_ssid("VK4XXX-9") and not ki.valid_call_ssid("VK4XXX") and not ki.valid_call_ssid("VK4XXX-0") and not ki.valid_call_ssid("VK4XXX-16"))

# ---- bucket + backoff on fake clocks
t = [1000.0]
b = ki.TokenBucket(1, 10, clock=lambda: t[0])
check("bucket: burst of 10", all(b.take() for _ in range(10)) and not b.take())
t[0] += 0.9
check("bucket: none before 1 s", not b.take())
t[0] += 0.1
check("bucket: one after 1 s", b.take() and not b.take())
bo = ki.Backoff(30, 600, rand=lambda: 1.0)
steps = [bo.next() for _ in range(8)]
check("backoff: 30 s doubling to a 10 min cap", steps == [30, 60, 120, 240, 480, 600, 600, 600], steps)
bo = ki.Backoff(30, 600, rand=lambda: 0.0)
check("backoff: jitter never below half the step (no tight loop)", bo.next() == 15 and bo.next() == 30)
bo.reset()
check("backoff: reset starts again at 30 s", ki.Backoff(30, 600, rand=lambda: 1.0).next() == 30)
check("login: verified", ki.login_verified("# logresp VK4XXX-10 verified, server T2TEST"))
check("login: unverified refused", not ki.login_verified("# logresp VK4XXX-10 unverified, server T2TEST"))
check("login: a non-logresp line refused", not ki.login_verified("# aprsc 2.1.14 verified"))
# impossible jumps (a tracker that jumped 100 km north on the map)
jg = ki.JumpGuard()
check("jump: first fix accepted", jg.problem("VK4XXX-12", -27.4543, 152.9568, 1000) is None)
check("jump: riding 500 m in 60 s accepted", jg.problem("VK4XXX-12", -27.4500, 152.9568, 1060) is None)
why = jg.problem("VK4XXX-12", -26.40, 152.9568, 1120)
check("jump: 117 km north in 60 s refused", why is not None and "jumped" in why, why)
check("jump: the next fix back on the track accepted", jg.problem("VK4XXX-12", -27.4490, 152.9568, 1180) is None)
check("jump: other stations are separate", jg.problem("VK4ZB-7", -26.40, 152.9568, 1185) is None)
jg.problem("VK4XXX-12", -26.40, 152.9568, 1240)
check("jump: a move that the next fix agrees with wins (no stuck station)", jg.problem("VK4XXX-12", -26.4005, 152.9568, 1300) is None)
check("jump: a long gap (over an hour) isn't a jump", jg.problem("VK4XXX-12", -27.45, 152.95, 1300 + 3700) is None)
import meshprs as _mp
_f = {"subtype": _mp.POS, "lat": round(-27.4543 * 2 ** 23 / 90), "lon": round(152.9568 * 2 ** 23 / 180), "sym": "/b", "amb": 0}
check("jump: MeshPRS units -> degrees match what meshprs renders",
      _mp.fmt_lat(_f["lat"]) == ki.fmt_lat(_f["lat"] * 90 / 2 ** 23) and _mp.fmt_lon(_f["lon"]) == ki.fmt_lon(_f["lon"] * 180 / 2 ** 23),
      (_mp.fmt_lat(_f["lat"]), ki.fmt_lat(_f["lat"] * 90 / 2 ** 23)))


# ---- a fake APRS-IS server
class FakeIS:
    def __init__(self, good_pass=None, chatter=0.0):
        self.good, self.chatter, self.lines, self.conns, self.writers = good_pass or PC, chatter, [], 0, []

    async def start(self):
        self.srv = await asyncio.start_server(self.client, "127.0.0.1", 0)
        self.port = self.srv.sockets[0].getsockname()[1]

    async def client(self, r, w):
        self.conns += 1
        self.writers.append(w)
        w.write(b"# aprsc 2.1.14 fake\r\n")
        await w.drain()
        try:
            login = (await r.readline()).decode().strip()
            self.lines.append(login)
            parts = login.split()
            ok = len(parts) >= 4 and parts[3] == self.good
            w.write(f"# logresp {parts[1] if len(parts) > 1 else '?'} {'verified' if ok else 'unverified'}, server FAKE\r\n".encode())
            await w.drain()
            while True:
                if self.chatter:
                    try:
                        line = await asyncio.wait_for(r.readline(), self.chatter)
                    except asyncio.TimeoutError:
                        w.write(b"# server comment\r\n")
                        await w.drain()
                        continue
                else:
                    line = await r.readline()
                if not line:
                    break
                self.lines.append(line.decode().strip())
        except (ConnectionError, OSError):
            pass

    def kick(self):
        for w in self.writers:
            w.close()
        self.writers = []


async def wait_for(pred, secs=5.0):
    end = time.time() + secs
    while time.time() < end:
        if pred():
            return True
        await asyncio.sleep(0.05)
    return pred()


PC = str(ki.passcode("VK4XXX"))   # computed, never written down: it is a real call's passcode
CFG = {"on": True, "call": "VK4XXX-10", "pass": "", "server": "127.0.0.1", "vers": "0.4.34"}
POS = {"src": "VK4XXX-9", "name": "VK4XXX Home", "lat": -27.4545, "lon": 152.9876, "sym": "/>", "comment": "MeshCore"}


async def live():
    srv = FakeIS(chatter=0.3)
    await srv.start()
    ig = ki.Igate(first_s=0.3, cap_s=1.0)
    r = ig.configure({**CFG, "port": srv.port, "status": "Kelly Page MeshCore iGate", "statusMin": 10})
    check("config accepted", r["ok"], r)
    check("verified login -> up", await wait_for(lambda: ig.state == "up"), ig.status())
    check("login line: user CALL-SSID pass (computed) vers KellyPage 0.4.34",
          srv.lines and srv.lines[0] == f"user VK4XXX-10 pass {PC} vers KellyPage 0.4.34", srv.lines[:1])
    check("the log never shows the passcode", all(PC not in line for _, line in ig.log), ig.log)
    check("status line sent once verified", await wait_for(lambda: "VK4XXX-10>APZKPG,TCPIP*:>Kelly Page MeshCore iGate" in srv.lines), srv.lines)
    res = await ig.send([POS])
    check("send: ok", res[0]["ok"], res)
    check("send: the exact qAO packet reached APRS-IS",
          await wait_for(lambda: "VK4XXX-9>APZKPG,qAO,VK4XXX-10:!2727.27S/15259.26E>MeshCore" in srv.lines), srv.lines)
    res = await ig.send([POS] * 12)
    check("bucket: burst 10 -- one used, nine more go, the rest dropped as rate", [x.get("reason") for x in res] == [None] * 9 + ["rate"] * 3, res)
    await asyncio.sleep(2.5)                        # let the bucket refill (1 s each)
    T = V["telemetry"][0]
    TN = T["src"].split("-")[0] + " node"
    res = await ig.send([{"src": T["src"], "name": TN, "body": T["body"]}, {"src": T["src"], "name": TN, "body": T["defs"][0]}])
    check("telemetry: T# and PARM go as qAO lines for that station",
          all(r["ok"] for r in res) and await wait_for(lambda: f"{T['src']}>APZKPG,qAO,VK4XXX-10:{T['body']}" in srv.lines
                                                       and f"{T['src']}>APZKPG,qAO,VK4XXX-10:{T['defs'][0]}" in srv.lines), (res, srv.lines[-3:]))
    res = await ig.send([{"src": "VK4XXX-12", "name": "VK4XXX Bike", "body": ":VK4XX-1  :Hi"}, {"src": "VK4XXX", "name": "VK4XXX Bike", "body": T["body"]}])
    check("telemetry: a message to someone else / no SSID refused", [x["reason"] for x in res] == ["invalid"] * 2, res)
    res = await ig.send([{**POS, "src": "VK4XXX"}, {**POS, "lat": 0, "lon": 0}, {**POS, "lat": 95}, "junk"])
    check("refused: no SSID, 0,0, out of range, not an object", [x["reason"] for x in res] == ["invalid"] * 3 + ["not an amateur station"], res)
    check("status counts", ig.status()["dropped"]["rate"] == 3 and ig.status()["dropped"]["invalid"] == 6, ig.status())
    res = await ig.send([{**POS, "lat": POS["lat"] + 2.0}])
    check("jump: an impossible position from a station is refused, nothing sent",
          res[0]["reason"] == "impossible position" and not any("2527.27S" in l for l in srv.lines), res)
    # HAM ONLY: the node's name must carry the line's own VK / ZL callsign as word 1 or 2, whatever the page sends
    res = await ig.send([{**POS, "name": "BARC club VK4XXX Repeater"}, {**POS, "name": "m3sh3dup r3p", "src": "R3P-1"},
                         {**POS, "name": "VK4ZB Home"}, {k: v for k, v in POS.items() if k != "name"},
                         {**POS, "name": "2E0ABC home", "src": "2E0ABC-9"},
                         {"src": T["src"], "name": "Pizza oven", "body": T["body"]}])
    check("ham only: a name without the source callsign as word 1 or 2 is refused (positions + telemetry), nothing sent",
          [x["reason"] for x in res] == ["not an amateur station"] * 6 and not any("R3P" in l or "2E0ABC" in l for l in srv.lines), res)
    # keepalive (made short for the test)
    ki.KEEPALIVE_S = 0.5
    check("keepalive comment sent", await wait_for(lambda: any(line.startswith("#keepalive") for line in srv.lines), 8), srv.lines[-5:])
    ki.KEEPALIVE_S = 120
    # the server drops us: waiting with a retry, then back up on a new connection
    conns = srv.conns
    srv.kick()
    check("disconnect noticed -> waiting with a retry time", await wait_for(lambda: ig.state == "waiting" or srv.conns > conns), ig.status())
    check("reconnected after the backoff", await wait_for(lambda: srv.conns > conns and ig.state == "up", 6), (srv.conns, ig.status()))
    # off
    ig.configure({**CFG, "on": False, "port": srv.port})
    check("off: state off, a send is refused", ig.state == "off" and not (await ig.send([POS]))[0]["ok"])
    srv.srv.close()


async def unverified():
    srv = FakeIS(good_pass="1")
    await srv.start()
    ig = ki.Igate(first_s=0.3, cap_s=1.0)
    ig.configure({**CFG, "port": srv.port})
    check("unverified passcode -> state unverified", await wait_for(lambda: ig.state == "unverified"), ig.status())
    check("unverified: retry waits (no tight loop)", ig.status()["retryIn"] >= 0 and srv.conns == 1, (ig.status(), srv.conns))
    res = await ig.send([POS])
    check("unverified: refuses to send", not res[0]["ok"] and "unverified" in res[0]["reason"], res)
    check("unverified: no packet reached APRS-IS", not any("APZKPG" in line for line in srv.lines), srv.lines)
    check("unverified: the error says so", "did not verify" in ig.status()["error"], ig.status())
    ig.configure({**CFG, "on": False})
    srv.srv.close()


async def dry():
    srv = FakeIS()
    await srv.start()
    ig = ki.Igate()
    ig.configure({**CFG, "port": srv.port, "dry": True})
    res = await ig.send([POS])
    await asyncio.sleep(0.3)
    check("dry run: answers the packet it would send", res[0]["ok"] and res[0]["dry"] and "qAO,VK4XXX-10" in res[0]["packet"], res)
    check("dry run: never connects", srv.conns == 0 and ig.state == "dry", (srv.conns, ig.state))
    check("dry run: logged", any("(dry run)" in line for _, line in ig.log))
    r = ig.configure({**CFG, "call": "VK4XXX"})
    check("config: an iGate call without SSID refused", not r["ok"], r)
    srv.srv.close()


async def privacy():
    """The privacy switch: the owner's own stations (the iGate's base call, any SSID) are hidden only near home -- inside
    the zone (250 m round a centre 75-150 m from home, fixed and saved) they go out as the zone's centre; outside it,
    exact. Everyone else, and every station with the switch off, goes out as received. No home known: own positions held."""
    path = os.environ["KELLY_IGATE_PRIVACY_FILE"]
    if os.path.exists(path):
        os.remove(path)
    home = (-27.4545, 152.9876)
    ig = ki.Igate()
    seq = iter([0.25, 1.0])                 # centre due east, 150 m from home
    ig.privacy.rand = lambda: next(seq)
    ig.configure({**CFG, "dry": True, "privacy": True, "home": list(home)})
    c = ki.offset(home[0], home[1], 90, 150)
    spot = ki.position(c[0], c[1], "/>")
    near = ki.offset(home[0], home[1], 300, 60)               # in the garden
    res = await ig.send([{**POS, "lat": home[0], "lon": home[1]}, {**POS, "src": "VK4XXX-12", "name": "VK4XXX Buddy", "lat": near[0], "lon": near[1]},
                         {**POS, "src": "VK4ZB-7", "name": "VK4ZB Car", "lat": home[0], "lon": home[1]}])
    check("privacy: own station at home goes out as the zone's centre", spot in res[0].get("packet", ""), (res[0], spot))
    check("privacy: the zone centre is 150 m from home (not on it)", abs(ki.km_between(*home, *c) * 1000 - 150) < 1)
    check("privacy: anywhere in the zone, any own SSID -> the same one spot", spot in res[1].get("packet", ""), res[1])
    check("privacy: someone else's station at the same place is untouched", "2727.27S/15259.26E" in res[2]["packet"], res[2])
    far = ki.offset(home[0], home[1], 270, 500)                # 500 m west: 650 m from the centre
    edge_in = ki.offset(c[0], c[1], 0, 240)                    # just inside the zone
    edge_out = ki.offset(c[0], c[1], 0, 262)                   # just outside
    r = await ig.send([{**POS, "lat": far[0], "lon": far[1]}, {**POS, "lat": edge_in[0], "lon": edge_in[1]},
                       {**POS, "lat": edge_out[0], "lon": edge_out[1]}])
    check("privacy: away from home the position is exact", ki.position(*far, "/>") in r[0]["packet"], r[0])
    check("privacy: just inside the zone -> the spot", spot in r[1]["packet"], r[1])
    check("privacy: just outside the zone -> exact", ki.position(*edge_out, "/>") in r[2]["packet"], r[2])
    ig2 = ki.Igate()
    ig2.configure({**CFG, "dry": True, "privacy": True, "home": list(home)})
    r3 = await ig2.send([{**POS, "lat": home[0], "lon": home[1]}])
    check("privacy: the same spot after a bridge restart (saved)", spot in r3[0].get("packet", ""), r3)
    check("privacy: the home position itself is never saved", str(home[0])[:7] not in open(path).read(), open(path).read())
    seq2 = iter([0.5, 0.0])                 # due south, 75 m
    ig2.privacy.rand = lambda: next(seq2)
    ig2.privacy.new()
    r4 = await ig2.send([{**POS, "lat": home[0], "lon": home[1]}])
    c2 = ki.offset(home[0], home[1], 180, 75)
    check("privacy: New spot moves the zone (now 75 m south)", ki.position(*c2, "/>") in r4[0]["packet"], r4)
    ig2.configure({**CFG, "dry": True, "privacy": True})
    r5 = await ig2.send([{**POS, "lat": far[0], "lon": far[1]}, {**POS, "src": "VK4ZB-7", "name": "VK4ZB Car", "lat": home[0], "lon": home[1]}])
    check("privacy: no home position known -> own positions held (even far away), others still go",
          r5[0] == {"ok": False, "reason": "privacy: no home position"} and r5[1]["ok"], r5)
    ig2.configure({**CFG, "dry": True, "privacy": False, "home": list(home)})
    r6 = await ig2.send([{**POS, "lat": home[0], "lon": home[1]}])
    check("privacy: switch off -> the real position", "2727.27S/15259.26E" in r6[0]["packet"], r6)
    st = ig2.status()["privacy"]
    check("privacy: status shows on / base / home known / zone, never the home position",
          st == {"on": False, "base": "VK4XXX", "zoneM": 250.0, "home": True, "bearing": 180.0, "dist": 75.0}, st)
    # MeshPRS: an own Position frame in the zone -> the spot with no course / speed; out of the zone -> as sent
    import meshprs as mp
    vec = json.loads((MPRS_VEC / "gateway.json").read_text(encoding="utf-8"))
    v = next((v for v in vec["vectors"] if "out" in v and "!" in v["out"] and mp.decode(bytes.fromhex(v["hex"]))["subtype"] == mp.POS
              and "course" in mp.decode(bytes.fromhex(v["hex"]))), None)
    if v:
        f = mp.decode(bytes.fromhex(v["hex"]))
        fl = (f["lat"] * 90 / 2 ** 23, f["lon"] * 180 / 2 ** 23)
        name = ki.base_call(f["src"]) + " Buddy"
        ig2.configure({**CFG, "call": ki.base_call(f["src"]) + "-10", "dry": True, "privacy": True, "home": list(fl)})
        rr = await ig2.send([{"mprs": v["hex"], "rxAt": int(time.time() * 1000), "name": name}])
        cz = ig2.privacy.centre(fl)
        exp = mp.fmt_lat(round(cz[0] * 2 ** 23 / 90))
        check("privacy: a MeshPRS frame from home -> the spot, no course/speed",
              rr[0].get("ok") and exp in rr[0].get("packet", "") and "090/032" in v["out"] and "090/032" not in rr[0]["packet"], (rr, exp))
        ig2.mprs_seen.clear()
        ig2.configure({**CFG, "call": ki.base_call(f["src"]) + "-10", "dry": True, "privacy": True, "home": list(ki.offset(*fl, 0, 3000))})
        rr = await ig2.send([{"mprs": v["hex"], "rxAt": int(time.time() * 1000), "name": name}])
        check("privacy: a MeshPRS frame 3 km from home -> exactly as rendered without privacy", rr[0].get("packet") == v["out"].replace("qAO," + vec["config"]["igate"] + ":", "qAO," + ki.base_call(f["src"]) + "-10:"), (rr, v["out"]))
    else:
        check("privacy: found a moving MeshPRS Position vector to test with", False)


async def mprs():
    """MeshPRS frames (decision 0009/0010): decoded and rendered again here; the page's text is never sent."""
    vec = json.loads((MPRS_VEC / "gateway.json").read_text(encoding="utf-8"))
    ig = ki.Igate()   # the MeshPRS vectors (a separate, published standard) name their own iGate: run as that one
    ig.configure({**CFG, "call": vec["config"]["igate"], "dry": True, "pass": "99999"})
    check("passcode: the page's is ignored, the bridge computes its own", ig.cfg["pass"] == str(ki.passcode(vec["config"]["igate"])), ig.cfg["pass"])
    now = int(time.time() * 1000)
    for v in vec["vectors"]:
        if "out" not in v or v["id"] in ("gw-065", "gw-040", "gw-041", "gw-042", "gw-043"):
            continue                                  # objects take receive time; gw-065 is a test-server frame
        rec = vec["config"]["records"][0]
        src = v["out"].split(">")[0]
        ig.mprs_seen.clear()                          # each vector stands alone (they share seqs)
        r = (await ig.send([{"mprs": v["hex"], "rxAt": now, "name": src.split("-")[0] + " node", "record": {"sender": rec["sender"], "id": rec["id"]}}]))[0]
        if ki.ham_call(src):
            check(f"mprs {v['id']}: the bridge renders the same line", r.get("packet") == v["out"], r)
            r = (await ig.send([{"mprs": v["hex"], "rxAt": now, "name": "Club rpt " + src.split("-")[0], "record": {"sender": rec["sender"], "id": rec["id"]}}]))[0]
            check(f"mprs {v['id']}: refused when {src.split('-')[0]} is only the third word of the name", r == {"ok": False, "reason": "invalid"}, r)
        else:
            check(f"mprs {v['id']}: {src} is not a VK / ZL call -- refused", r == {"ok": False, "reason": "invalid"}, r)
    for name, hexs in [("G = 1", "60 01 A7 05 34 EB 0D B7 0E 00 00 12 9F 5D 8E 4B 53 65 65"),
                       ("gating 1 (NOGATE)", "54 00 2A 00 00 12 9F 5D 8E 02 F9 52 3D 35 EF D8 14 D1 6C 2F 3E 00"),
                       ("a query", "40 07 13 05 81 29 F1 B3 8E 02"), ("not hex", "zz"), ("too short", "50 00 2A")]:
        r = (await ig.send([{"mprs": hexs, "rxAt": now}]))[0]
        check(f"mprs refused: {name}", r == {"ok": False, "reason": "invalid"}, r)
    pos = "50 00 2A 00 00 12 9F 5D 8E 02 F9 52 3D 35 EF D8 14 D1 6C 2F 3E 00"
    r = (await ig.send([{"mprs": pos, "rxAt": now - 600000}]))[0]
    check("mprs refused: a receive time 10 min old", r == {"ok": False, "reason": "invalid"}, r)
    r = (await ig.send([{"mprs": "40 02 11 05 81 29 F1 B3 8E 2C 07 75 E7", "rxAt": now}]))[0]
    check("mprs refused: an ack without the message it answers", r == {"ok": False, "reason": "invalid"}, r)
    # spec 10.2 at the bridge: one line per (originator, seq) for 10 min, whatever the retry field -- a reloaded Kelly or a
    # second Kelly on the same bridge can't send a frame twice
    plain = next(v for v in vec["vectors"] if "out" in v and v["id"] not in ("gw-065", "gw-040", "gw-041", "gw-042", "gw-043") and ki.ham_call(v["out"].split(">")[0]))
    ps = plain["out"].split(">")[0]; ig.mprs_seen.clear()
    blob = bytes.fromhex(plain["hex"].replace(" ", ""))
    retry = (bytes([(blob[0] & 0xFC) | 1]) + blob[1:]).hex()
    first = (await ig.send([{"mprs": plain["hex"], "rxAt": now, "name": ps.split("-")[0] + " node", "record": {"sender": rec["sender"], "id": rec["id"]}}]))[0]
    again = (await ig.send([{"mprs": retry, "rxAt": now, "name": ps.split("-")[0] + " node", "record": {"sender": rec["sender"], "id": rec["id"]}}]))[0]
    check("mprs duplicate: the first copy goes", first.get("ok"), first)
    check("mprs duplicate: its retry (same seq) is dropped at the bridge", again == {"ok": False, "reason": "duplicate"} and ig.dropped["duplicate"] == 1, again)
    ig.mprs_seen = {k: t - 601 for k, t in ig.mprs_seen.items()}
    late = (await ig.send([{"mprs": plain["hex"], "rxAt": now, "name": ps.split("-")[0] + " node", "record": {"sender": rec["sender"], "id": rec["id"]}}]))[0]
    check("mprs duplicate: the same seq after 10 min is a new frame", late.get("ok"), late)
    obj = next(v for v in vec["vectors"] if v["id"] == "gw-040")
    r = (await ig.send([{"mprs": obj["hex"], "rxAt": vec["config"]["rxAt"] + 0}]))[0]
    check("mprs: an object's receive time must be now", r == {"ok": False, "reason": "invalid"}, r)


async def fallback():
    """aunz.aprs2.net first; after a failed connection the next try goes to rotate.aprs2.net (spec §11)."""
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        port = so.getsockname()[1]               # closed again: connecting fails at once
    ig = ki.Igate(first_s=60, cap_s=60)
    check("default server is aunz.aprs2.net", ki.DEFAULT_SERVER[0] == "aunz.aprs2.net")
    ig.configure({**CFG, "port": port})
    ok = await wait_for(lambda: ig.state == "waiting")
    check("a failed connection switches the next try to the fallback server", ok and ig.alt, (ig.state, ig.alt))
    ig.configure({**CFG, "on": False})


asyncio.run(live())
asyncio.run(unverified())
asyncio.run(dry())
asyncio.run(mprs())
asyncio.run(privacy())
asyncio.run(fallback())


# ---- the received-packet log (GET /api/igate/rx), on a fake clock
clk = [1_800_000_000.0]
rxf = os.path.join(tempfile.mkdtemp(), "rx.jsonl")
rl = ki.RxLog(rxf, clock=lambda: clk[0])
rl.add({"src": "VK4XXX-12", "k": "pos", "lat": -27.4, "lon": 153.0, "r": "held"})
clk[0] += 3600
rl.add({"src": "VK4XXX-12", "k": "pos", "lat": -27.5, "lon": 153.1, "r": "sent"})
rl.add({"src": "VK4XX-9", "k": "tlm", "r": "offline", "why": "APRS-IS waiting"})
check("rx log: query all / by station / by hours", (len(rl.query()), len(rl.query(src="VK4XXX-12")), len(rl.query(0.5))) == (3, 2, 2),
      (len(rl.query()), len(rl.query(src="VK4XXX-12")), len(rl.query(0.5))))
check("rx log: file is mode 600 (exact positions)", os.name == "nt" or (os.stat(rxf).st_mode & 0o777) == 0o600, oct(os.stat(rxf).st_mode))
rl2 = ki.RxLog(rxf, clock=lambda: clk[0])
check("rx log: survives a restart (reloaded from disk)", len(rl2.query()) == 3, len(rl2.query()))
clk[0] += 23.5 * 3600
rl3 = ki.RxLog(rxf, clock=lambda: clk[0])
check("rx log: older than 24 h dropped on load, file rewritten", len(rl3.query()) == 2 and sum(1 for _ in open(rxf)) == 2, len(rl3.query()))
r = ki.rx_record({"src": "vk4xxx-12", "lat": -27.45, "lon": 153.05, "name": "VK4XXX Buddy"}, {"ok": False, "reason": "privacy: no home position"})
check("rx record: advert position, held", (r["src"], r["k"], r["lat"], r["r"]) == ("VK4XXX-12", "pos", -27.45, "held"), r)
r = ki.rx_record({"src": "VK4XXX-12", "lat": 1, "lon": 2}, {"ok": False, "reason": "APRS-IS waiting", "packet": "x"})
check("rx record: internet down -> offline + why", r["r"] == "offline" and r["why"] == "APRS-IS waiting", r)
r = ki.rx_record({"src": "VK4XXX-12", "body": "T#001,1,2,3,4,5,00000000"}, {"ok": True, "packet": "x"})
check("rx record: telemetry sent, no position", r["k"] == "tlm" and r["r"] == "sent" and "lat" not in r, r)
k = ki.rx_kml([{"t": 1.8e9, "src": "VK4XXX-12", "lat": -27.4, "lon": 153.0, "r": "held"}, {"t": 1.8e9 + 60, "src": "VK4XXX-12", "lat": -27.5, "lon": 153.1, "r": "sent", "spd": 20, "crs": 90}, {"t": 1.8e9, "src": "VK4XX-9", "k": "tlm", "r": "sent"}], "VK4XXX-12 <test>")
check("rx kml: one folder, a track, a placemark per fix, title escaped",
      k.count("<Folder>") == 1 and k.count("<LineString>") == 1 and k.count("<Point>") == 2 and "&lt;test&gt;" in k and "<test>" not in k, k[:200])

# ---- a real bridge
def free_port() -> int:
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


port = free_port()


def req(path, body=None, host="127.0.0.1"):
    r = urllib.request.Request(f"http://{host}:{port}{path}", data=None if body is None else json.dumps(body).encode(),
                               headers={"Content-Type": "text/plain"}, method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(r, timeout=10) as x:
            return x.status, dict(x.headers), json.loads(x.read())
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), json.loads(e.read() or b"{}")


p = subprocess.Popen([sys.executable, str(HERE / "kelly_bridge.py"), "--bind", "0.0.0.0", "--port", str(port), "--token", "s3cret"],
                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
            break
        except OSError:
            time.sleep(0.1)
    st, hd, js = req("/api/igate")
    check("bridge: GET /api/igate (this machine) -> off, with CORS", st == 200 and js.get("state") == "off" and hd.get("Access-Control-Allow-Origin") == "*", (st, js))
    st, hd, js = req("/api/igate/config", {"on": True, "call": "VK4XXX-10", "dry": True, "vers": "0.4.34"})
    check("bridge: config dry run", st == 200 and js.get("ok") and js["status"]["state"] == "dry", (st, js))
    st, hd, js = req("/api/igate/send", {"lines": [POS]})
    check("bridge: send in dry run -> the packet", st == 200 and js["results"][0].get("packet") == "VK4XXX-9>APZKPG,qAO,VK4XXX-10:!2727.27S/15259.26E>MeshCore", js)
    st, hd, js = req("/api/igate/rx?src=VK4XXX-9")
    check("bridge: GET /api/igate/rx -> that send, logged as dry", st == 200 and js.get("count", 0) >= 1 and js["recs"][-1]["r"] == "dry", (st, js))
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/igate/rx?format=kml&hours=1", timeout=10) as x:
        kml = x.read().decode()
        check("bridge: GET /api/igate/rx?format=kml -> a KML download",
              "kml" in x.headers.get("Content-Type", "") and "attachment" in x.headers.get("Content-Disposition", "") and "<Point>" in kml, kml[:120])
    lan = ""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as so:
            so.connect(("192.0.2.1", 9))
            lan = so.getsockname()[0]
    except OSError:
        pass
    if not lan or lan.startswith("127."):
        print("SKIP remote /api/igate: this machine has no LAN address")
    else:
        st, hd, js = req("/api/igate", host=lan)
        check("bridge: from the LAN without the token -> 403", st == 403, st)
        st, hd, js = req("/api/igate/rx", host=lan)
        check("bridge: the rx log from the LAN without the token -> 403", st == 403, st)
        st, hd, js = req("/api/igate?token=s3cret", host=lan)
        check("bridge: from the LAN with the token -> status", st == 200 and js.get("state") == "dry", (st, js))
finally:
    p.terminate()
    try:
        p.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()

print(f"RESULT: {'FAIL (' + str(len(fails)) + ')' if fails else 'ALL PASS'}")
sys.exit(1 if fails else 0)
