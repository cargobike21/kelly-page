"""Checks for the bridge's own MeshCore session (MeshCoreWatch in kelly_bridge.py) against a fake companion node --
no hardware, no serial port. Run: python3 bridge/test_kelly_mesh.py  (stdlib only; prints RESULT: ALL PASS / FAIL)

Covers: a DM (/api/mesh-send {to}) and its delivery receipt (SEND_CONFIRMED), a DM with no receipt, a queued
channel datagram (RESP 27) during sync, a contact the node deleted (PUSH 0x8F), and UTF-8 cuts on a character
boundary. Then the same session against the simulated node (kelly_mesh_sim.py, --mesh-sim): start-up, DMs and their
receipts, channel texts, adverts into the network statistics, GET_STATS, the repeater's login / status / telemetry
answers, and each fault (hang, ackloss, garble, full, slow). The history store (--mesh-history, kelly_mesh_history.py):
buckets, roll-ups, pruning, and what the sim session feeds it. Last, a real bridge process with --mesh-sim --mesh-gateway
on port 18026, driven over its HTTP API."""
import asyncio
import json
import re
import struct
import socket
import subprocess
import tempfile
import sys
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kelly_bridge as kb  # noqa: E402
import kelly_mesh_sim as ks  # noqa: E402
import kelly_mesh_history as kh  # noqa: E402

fails = []


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


KEY = bytes(range(1, 33))   # the contact's 32-byte public key
ACK = b"\xaa\xbb\xcc\xdd"


class FakeLink:
    """Stands in for MeshLink: a companion node answering the commands MeshCoreWatch sends."""

    def __init__(self, confirm: bool, queued: list[bytes]):
        self.up, self.clients, self.args, self.target = True, set(), types.SimpleNamespace(), "fake"
        self.confirm, self.queued, self.mc, self.sent = confirm, queued, None, []

    def reply(self, f: bytes, delay: float = 0.0):
        asyncio.get_running_loop().call_later(delay, self.mc.on_frame, f)

    async def write(self, data: bytes):
        self.mc.note_sent(data)   # as MeshLink.write does: the texts to the node are kept from here
        p = data[3:]
        self.sent.append(p)
        c = p[0]
        if c == 22:
            self.reply(bytes([13]) + b"\0" * 79)
        elif c == 1:
            self.reply(bytes([5]) + b"\0" * 57 + b"P25X")
        elif c == 4:
            ct = bytearray(148); ct[0] = 3; ct[1:33] = KEY; ct[33] = 1; ct[35] = 0xFF; ct[100:107] = b"VK4ZB-1"
            self.reply(bytes(ct)); self.reply(bytes([4, 0, 0, 0, 0]))
        elif c == 31:
            self.reply(bytes([18, p[1]]) + (b"Public" if p[1] == 0 else b"").ljust(32, b"\0")) if p[1] == 0 else self.reply(bytes([1, 2]))
        elif c == 10:
            self.reply(self.queued.pop(0) if self.queued else bytes([10]))
        elif c == 2:   # SEND_TXT_MSG -> SENT [6][flood][ack u32][timeout u32], then (maybe) SEND_CONFIRMED
            self.reply(bytes([6, 1]) + ACK + struct.pack("<I", 4000))
            if self.confirm:
                self.reply(bytes([0x82]) + ACK + struct.pack("<I", 1234), 0.2)
        elif c == 3:
            self.reply(bytes([0]))


async def main():
    # DM delivered
    link = FakeLink(confirm=True, queued=[]); mc = kb.MeshCoreWatch(link); link.mc = mc
    r = await mc.send_dm(KEY[:6].hex(), "[P25 VK4XXX] hello")
    check("DM: delivery receipt matched", r["delivered"] and r["rtt"] == 1234, r)
    dm = next(p for p in link.sent if p[0] == 2)
    check("DM: key prefix + text in the frame", dm[7:13] == KEY[:6] and dm[13:] == b"[P25 VK4XXX] hello", dm)
    check("DM: logged as ours", mc.texts[-1]["dm"] and mc.texts[-1]["mine"] and mc.texts[-1]["to"] == KEY[:6].hex() and mc.texts[-1]["toName"] == "VK4ZB-1", mc.texts[-1])
    check("DM: ack waiter cleaned up", not mc.acks, mc.acks)

    # DM with no receipt
    link = FakeLink(confirm=False, queued=[]); mc = kb.MeshCoreWatch(link); link.mc = mc
    r = await mc.send_dm(KEY[:6].hex(), "anyone?", wait_s=0.5)
    check("DM: no receipt -> not delivered", r["delivered"] is False and r["rtt"] is None, r)
    try:
        await mc.send_dm("abc", "x"); check("DM: bad key refused", False)
    except RuntimeError:
        check("DM: bad key refused", True)

    # sync drains a channel datagram (27) without stalling, then the text behind it
    chmsg = bytes([8, 0, 0xFF, 0]) + struct.pack("<I", 0) + b"VK4ZB: after the datagram"
    link = FakeLink(confirm=False, queued=[bytes([27, 0, 0, 0, 0, 0xFF, 1, 0, 2, 9, 9]), chmsg]); mc = kb.MeshCoreWatch(link); link.mc = mc
    await mc.start_session()
    await asyncio.wait_for(mc.sync(), 3)
    check("sync: past a channel datagram (27)", any(t["text"] == "after the datagram" for t in mc.texts), mc.texts)

    # contact deleted
    check("contacts loaded", KEY[:6].hex() in mc.contacts, mc.contacts)
    mc.on_frame(bytes([0x8F]) + KEY)
    check("contact deleted (0x8F) drops it", KEY[:6].hex() not in mc.contacts, list(mc.contacts))

    # UTF-8 cut on a character boundary
    b = kb.MeshCoreWatch.fit("x" * 149 + "é")
    check("fit: never cuts mid-character", b.decode("utf-8") == "x" * 149 and len(b) <= kb.MeshCoreWatch.MAX_TEXT, b[-3:])


# ---- the simulated node (kelly_mesh_sim.py)
class SimLink:
    """MeshLink with --mesh-sim, minus the WebSocket side: the sim's bytes go to MeshCoreWatch.feed."""

    def __init__(self, faults: str = "", auto: bool = False):
        self.up, self.clients, self.args, self.target = True, set(), types.SimpleNamespace(), "sim"
        self.mc = None
        self.sim = ks.MeshCoreSim(lambda b: self.mc.feed(b), ks.parse_faults(faults), seed=5, auto=auto, speed=50)

    async def write(self, data: bytes):
        self.mc.note_sent(data)
        self.sim.write(data)


def sim_rig(faults: str = ""):
    link = SimLink(faults); mc = kb.MeshCoreWatch(link); link.mc = mc
    return link, mc


W = {w["name"]: i for i, w in enumerate(ks.WORLD)}


async def sim_tests():
    check("sim: key_of = meshcoresim.js keyOf", ks.key_of("VK4XXX Veranda Rptr").hex()[:16] == "3e08c379461c3bfd", ks.key_of("VK4XXX Veranda Rptr").hex()[:16])
    f = ks.parse_faults("ackloss=0.3,hang=5,full")
    check("sim: faults parsed", f["ackloss"] == 0.3 and f["hang"] == 5 and f["full"] is True and f["garble"] == 0, f)
    try:
        ks.parse_faults("explode=1"); check("sim: an unknown fault is refused", False)
    except ValueError:
        check("sim: an unknown fault is refused", True)

    link, mc = sim_rig()
    await mc.start_session()
    check("sim: session up, every contact", mc.session_up and len(mc.contacts) == len(ks.WORLD), len(mc.contacts))
    check("sim: channels", mc.channels == {0: "Public", 1: "P25X"}, mc.channels)
    check("sim: self + radio", mc.self_name == "VK4XXX Kelly Sim" and mc.radio == {"freq_mhz": 923.125, "bw_khz": 62.5, "sf": 8, "cr": 5, "tx_dbm": 22}, (mc.self_name, mc.radio))
    romeo = ks.key_of("VK4ZR Romeo")[:6].hex()
    check("sim: contact position + hops", mc.contacts[romeo]["lat"] == -27.556 and mc.contacts[romeo]["hops"] is None, mc.contacts[romeo])
    r = await mc.send_dm(romeo, "Hello Romeo", wait_s=3)
    check("sim: DM delivered with a round trip, by flood", r["delivered"] and r["rtt"] > 1000 and r["flood"], r)
    await asyncio.sleep(0.15)
    await mc.sync()
    check("sim: the bot's answer synced", any(t["text"] == "Copy, Hello Romeo" and t["dm"] and t["sender"] == "VK4ZR Romeo" for t in mc.texts), mc.texts[-2:])
    r = await mc.send_dm(romeo, "again", wait_s=3)
    check("sim: second DM goes direct (route learned from the path-return)", r["delivered"] and not r["flood"], r)
    r = await mc.send_dm(ks.key_of("Bremer Creek Sensor")[:6].hex(), "level?", wait_s=0.3)
    check("sim: a sensor never confirms", not r["delivered"], r)
    await mc.send_channel(1, "P25X net at 8")
    check("sim: channel post logged as ours", mc.texts[-1]["mine"] and mc.texts[-1]["chName"] == "P25X", mc.texts[-1])

    link.sim.heard_channel(link.sim.st[W["Brisbane Bob"]], "Morning all")
    check("sim: MSG_WAITING wakes the sync", mc.sync_wanted.is_set())
    await mc.sync()
    t = mc.texts[-1]
    check("sim: channel text split from its sender, V3 SNR + hops", (t["sender"], t["text"], t["ch"], t["snr"], t["hops"]) == ("Brisbane Bob", "Morning all", 0, 2.0, 2), t)
    for name in ("Toowoomba Rptr", "VK4ZQ Bunya", "VK4XXX Veranda Rptr"):
        link.sim.heard_advert(link.sim.st[W[name]])
    snap = mc.stats_snapshot()
    st = snap["stats"]
    check("sim: adverts counted (packets, adverts by type, senders)", st["packets"] >= 4 and st.get("type_advert") == 3 and st["senders"] == 3, st)
    check("sim: repeater heard direct (0 hops), Bunya 2 hops", st["heard_direct"] == 1 and st["hops_2"] >= 1, st)
    twb = next(x for x in snap["stations"] if x["name"] == "Toowoomba Rptr")
    check("sim: station km from our own position", 78 < twb["km"] < 84 and twb["type"] == "repeater", twb)
    await mc.poll_stats()
    ns = mc.node_stats
    check("sim: GET_STATS core/radio/packets", ns.get("batt_v") == 4.012 and ns.get("noise_floor_dbm") == -117 and ns.get("recv", 0) >= 4 and ns.get("sent", 0) >= 3, ns)

    # the repeater -- answering as the real SenseCAP Solar repeater did on the bench (2026-10-21)
    got = []
    link.mc = types.SimpleNamespace(feed=lambda b: got.append(b))
    vk = ks.key_of("VK4XXX Veranda Rptr")

    def send(payload):
        link.sim.write(b"<" + struct.pack("<H", len(payload)) + payload)

    def cli(text):
        return bytes([2, 1, 0]) + struct.pack("<I", int(time.time())) + vk[:6] + text.encode()

    send(cli("ver"))                                 # before any login: silence
    send(bytes([26]) + vk + b"wrong")                # a wrong password: silence too (no 0x86 from 1.18)
    await asyncio.sleep(0.1)
    check("sim: CLI before login and a wrong password get no answer", [g[3] for g in got] == [6, 6], [g[3:].hex() for g in got])
    login_sent = got[1][3:]
    check("sim: login SENT tag = the repeater key's first 4 bytes", login_sent[2:6] == vk[:4], login_sent.hex())
    got.clear()
    for payload in (bytes([26]) + vk + b"password", bytes([27]) + vk, bytes([39, 0, 0, 0]) + vk,
                    bytes([50]) + vk + bytes([6, 0, 20, 0, 0, 2, 6, 1, 2, 3, 4])):
        send(payload)
    await asyncio.sleep(0.1)
    frames = [g[3:] for g in got]
    codes = [hex(x[0]) for x in frames if x[0] != 6]
    check("sim: path learned, login ok, status, telemetry, neighbours pushes", codes == ["0x81", "0x85", "0x87", "0x8b", "0x8c"], codes)
    ok = next(x for x in frames if x[0] == 0x85)
    clock = struct.unpack_from("<I", ok, 8)[0]
    check("sim: LOGIN_SUCCESS 14 B: admin, prefix, clock (May 2024 after power-off), acl 3, fw level 2",
          len(ok) == 14 and ok[1] == 1 and ok[2:8] == vk[:6] and ok[12:14] == b"\x03\x02" and 1715770620 <= clock < 1715770620 + 600, ok.hex())
    stt = next(x for x in frames if x[0] == 0x87)
    v = struct.unpack_from("<HHhh4I", stt, 8)
    check("sim: STATUS_RESPONSE 68 B (60 B RepeaterStats on 1.18): batt, noise floor, airtime, recv errors",
          len(stt) == 68 and v[0] == 4105 and v[2] == -118 and v[6] == 1873 and struct.unpack_from("<I", stt, 60)[0] == 52, (len(stt), v))
    tel = next(x for x in frames if x[0] == 0x8B)
    check("sim: TELEMETRY voltage + temperature + zero padding, no GPS",
          len(tel) == 20 and tel[8:10] == b"\x01\x74" and 4.00 <= int.from_bytes(tel[10:12], "big") / 100 <= 4.16 and tel[12:14] == b"\x01\x67" and tel[16:] == bytes(4), tel.hex())
    nb = next(x for x in frames if x[0] == 0x8C)
    total, n = struct.unpack_from("<HH", nb, 6)
    names = [next(s["name"] for s in link.sim.st if s["key"][:6] == nb[10 + i * 11:16 + i * 11]) for i in range(n)]
    check("sim: neighbours = the repeaters one hop out, strongest first", (total, n, names) == (2, 2, ["Mt Coot-tha Rptr", "Toowoomba Rptr"]), (total, n, names))
    got.clear()
    for c in ("clock", f"time {int(time.time())}", "clock", "get name", "frobnicate"):
        send(cli(c))
    await asyncio.sleep(0.15)
    send(bytes([10])); send(bytes([10])); send(bytes([10])); send(bytes([10])); send(bytes([10]))
    await asyncio.sleep(0.05)
    msgs = [g[3:] for g in got if g[3] == 16]
    texts = [m[16:].decode() for m in msgs]
    check("sim: remote CLI answers as type-1 contact messages", len(msgs) == 5 and all(m[11] == 1 and m[4:10] == vk[:6] for m in msgs), [m.hex() for m in msgs])
    check("sim: CLI clock starts in 2024, 'time N' sets it, then 'clock' agrees",
          texts[0].endswith("/5/2024 UTC") and texts[1].startswith("OK - clock set:") and texts[2].endswith(time.strftime("/%Y UTC", time.gmtime()).replace("/0", "/")), texts)
    check("sim: CLI get name / unknown command", texts[3] == "> VK4XXX Veranda Rptr" and texts[4] == "Unknown command", texts)
    # contact management: export a contact, remove it, import the link back, export self, rename
    bob = ks.key_of("Brisbane Bob")
    got.clear(); send(bytes([17]) + bob); await asyncio.sleep(0.05)
    adv = got[-1][3:]
    check("sim: EXPORT_CONTACT -> RESP 11 with their advert (key, name)", adv[0] == 11 and adv[3:35] == bob and adv.endswith(b"Brisbane Bob"), adv[:40].hex())
    got.clear(); send(bytes([15]) + bob); send(bytes([18]) + adv[1:]); send(bytes([17])); send(bytes([8]) + b"VK4XXX Home"); send(bytes([1, 3]) + bytes(6) + b"t")
    await asyncio.sleep(0.05)
    fr = [g[3:] for g in got]
    check("sim: REMOVE, IMPORT the link back, EXPORT self, SET_ADVERT_NAME -> OK, OK, 11, OK", [x[0] for x in fr[:4]] == [0, 0, 11, 0], [x[:3].hex() for x in fr])
    check("sim: the imported contact is back; the new name shows in SELF_INFO", next(s for s in link.sim.st if s["key"] == bob)["known"] and fr[4].endswith(b"VK4XXX Home"), fr[4][-12:])

    # faults
    link, mc = sim_rig("hang=0.05")
    await asyncio.sleep(0.1)
    try:
        await mc.cmd(bytes([20]), {12}, timeout=0.3); check("sim fault hang: no answer", False)
    except RuntimeError as e:
        check("sim fault hang: no answer", "did not answer" in str(e), e)
    check("sim fault hang: the watch counts it as unanswered", mc.unanswered_since is not None)
    link.sim.born = time.time()   # what MeshLink.reset_node does for the sim
    f = await mc.cmd(bytes([20]), {12}, timeout=1)
    check("sim fault hang: a reset brings it back", f[0] == 12 and mc.unanswered_since is None)
    link, mc = sim_rig("ackloss=1")
    await mc.start_session()
    r = await mc.send_dm(romeo, "lost", wait_s=0.3)
    check("sim fault ackloss: never delivered", not r["delivered"], r)
    link, mc = sim_rig("garble=1")
    await mc.start_session()
    check("sim fault garble: session still comes up through the junk", mc.session_up and len(mc.contacts) == len(ks.WORLD))
    link, mc = sim_rig("full")
    await mc.start_session()
    s = link.sim.st[W["Bremer Creek Sensor"]]; s["known"] = False
    mc.contacts.pop(s["key"][:6].hex(), None)
    n0 = len(mc.contacts)
    link.sim.heard_advert(s)
    check("sim fault full: new contact in, oldest evicted (0x8F)", len(mc.contacts) == n0 and s["key"][:6].hex() in mc.contacts, len(mc.contacts))
    link, mc = sim_rig("slow=100")
    t0 = time.time(); await mc.cmd(bytes([20]), {12}); dt = time.time() - t0
    check("sim fault slow: replies delayed", dt >= 100 / 1000 / 50 * 0.9, dt)


def bridge_e2e():
    port = 18026
    outbox = Path(tempfile.mkdtemp()) / "outbox.sqlite"
    p = subprocess.Popen([sys.executable, str(Path(__file__).parent / "kelly_bridge.py"), "--port", str(port), "--mesh-sim", "--mesh-gateway",
                          "--mesh-sim-faults", "quiet", "--mesh-outbox", str(outbox),
                          "--mesh-history", str(outbox.parent / "history.sqlite"), "--mesh-texts", str(outbox.parent / "texts.json")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    base = f"http://127.0.0.1:{port}"

    def get(path):
        with urllib.request.urlopen(base + path, timeout=15) as r:
            return json.loads(r.read())

    def post(path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:            # a refusal (409) still carries its JSON body
            return json.loads(e.read())
    try:
        for _ in range(50):
            try:
                stt = get("/api/mesh-status"); break
            except OSError:
                time.sleep(0.2)
        else:
            check("bridge --mesh-sim: started", False); return
        check("bridge --mesh-sim: node up, target named", stt["up"] and "simulated" in stt["target"] and stt["node"] == "ok", stt)
        check("bridge --mesh-sim: channel post starts the gateway session", post("/api/mesh-send", {"ch": 0, "text": "sim check"}).get("ok"))
        tx = get("/api/mesh-texts")
        check("bridge --mesh-sim: contacts + channels over the API", tx["session"] == "gateway" and tx["channels"] == {"0": "Public", "1": "P25X"} and len(tx["contacts"]) >= 5, tx)
        r = post("/api/mesh-send", {"to": ks.key_of("VK4ZB Bravo Heltec")[:6].hex(), "text": "e2e dm"})
        check("bridge --mesh-sim: DM delivered (real-time sim: ~1.6-2.2 s)", r.get("ok") and r.get("delivered") and r.get("rtt", 0) > 1000, r)
        hs = get("/api/mesh-history?sources=1")
        hq = get("/api/mesh-history?src=self&m=snr,packets,bad-name")
        check("bridge --mesh-sim: /api/mesh-history answers (sources, series; bad metric names dropped)",
              "sources" in hs and hs["self"] and set(hq["series"]) == {"snr", "packets"} and hq["res"] == 60, (hs, hq))
        st = get("/api/mesh-status")
        check("bridge --mesh-sim: bytes counted both ways", st["rxBytes"] > 1000 and st["txBytes"] > 20, st)
        check("bridge --mesh-sim: reset is a simulated reboot", post("/api/mesh-reset", {}).get("up") is True)

        # store-and-forward: while a Kelly holds the node, a gateway send is queued (SQLite), then sent once it leaves
        ws = socket.create_connection(("127.0.0.1", port), timeout=5)
        ws.sendall(b"GET /mesh HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                   b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
        hs = ws.recv(1024)
        time.sleep(0.5)
        r = post("/api/mesh-send", {"ch": 1, "text": "while Kelly had it"})
        check("outbox: a send while a Kelly holds the node is queued, not refused", r.get("ok") and r.get("queued") and "Kelly" in r.get("why", ""), (hs[:12], r))
        r2 = post("/api/mesh-send", {"ch": 1, "text": "no queue please", "queue": False})
        check("outbox: {queue: false} still refuses", r2.get("ok") is False, r2)
        check("outbox: counted on /api/mesh-texts", get("/api/mesh-texts").get("outbox") == 1)
        ws.close()
        sent = False
        for _ in range(80):                          # the bridge waits 10 s after a Kelly leaves (checks every 5 s), then sends
            time.sleep(0.5)
            tx = get("/api/mesh-texts")
            if tx.get("outbox") == 0 and any(x["text"] == "while Kelly had it" and x.get("mine") for x in tx["texts"]):
                sent = True; break
        check("outbox: sent once the Kelly left, and the box is empty", sent, get("/api/mesh-texts").get("outbox"))
    finally:
        p.terminate()
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()


async def reset_tests():
    """reset_node: RTS pulse for an ESP32, MeshCore's REBOOT command for an nRF52 (never 1200 baud, never RTS)."""
    class Port:
        def __init__(self):
            self.ops = []
        def write(self, b):
            self.ops.append(("write", bytes(b)))
        def __setattr__(self, k, v):
            if k in ("rts", "dtr"):
                self.ops.append((k, v))
            object.__setattr__(self, k, v)

    def link(vid, mc=True):
        m = object.__new__(kb.MeshLink)
        m.sim, m.serial, m.mc, m.reopen_wanted = None, Port(), (object() if mc else None), False
        m.args = types.SimpleNamespace(mesh_serial="/dev/serial/by-id/x")
        m.usb_vid = lambda: vid
        return m
    m = link(0x239A)
    check("reset nRF52 (RAK4631): REBOOT command, no RTS/DTR, port reopened", (await m.reset_node()) == "" and m.serial.ops == [("write", b"<\x07\x00\x13reboot")] and m.reopen_wanted, m.serial.ops)
    m = link(0x2886, mc=False)
    err = await m.reset_node()
    check("reset nRF52 without a MeshCore session: says power-cycle, touches nothing", "power-cycle" in err and m.serial.ops == [], (err, m.serial.ops))
    m = link(0x10C4)
    check("reset ESP32 (CP2102): the RTS pulse", (await m.reset_node()) == "" and m.serial.ops == [("dtr", False), ("rts", True), ("rts", False)], m.serial.ops)


async def history_tests():
    # the store on its own: a fixed clock, three minutes of samples
    h = kh.MeshHistory(Path(tempfile.mkdtemp()) / "h.sqlite")
    t0 = 1_800_000_000 // 3600 * 3600            # an hour boundary
    h.minute = t0
    for i, v in enumerate((-5.0, 3.0, 8.0)):
        h.add("self", "snr", v, t0 + 10 + i)
    h.add("self", "snr", 1.0, t0 + 70)           # the next minute: writes the first
    h.add("abc123abc123", "snr", 4.0, t0 + 75); h.source("abc123abc123", name="Toowoomba Rptr", type="repeater", lat=-27.5, lon=151.9)
    h.flush(t0 + 125)
    rows = h.db.execute("SELECT res, t, avg, mn, mx, n FROM series WHERE src = 'self' AND m = 'snr' ORDER BY res, t").fetchall()
    check("history: 1-min rows avg/min/max/n", rows[:2] == [(60, t0, 2.0, -5.0, 8.0, 3), (60, t0 + 60, 1.0, 1.0, 1.0, 1)], rows)
    check("history: 15-min and hourly roll-ups weighted by n", (900, t0, 1.75, -5.0, 8.0, 4) in rows and (3600, t0, 1.75, -5.0, 8.0, 4) in rows, rows)
    q = h.query("self", ["snr", "nope"], t0, t0 + 3600, res=60)
    check("history: query by resolution, unknown metric empty", q["series"]["snr"][0] == [t0 * 1000, 2.0, -5.0, 8.0, 3] and q["series"]["nope"] == [], q)
    now = t0 + 200
    check("history: res picked to fit (1 day = 1 min, 7 days = 15 min, 60 days = 1 h)",
          (h.pick_res(now - 86400, now, now), h.pick_res(now - 7 * 86400, now, now), h.pick_res(now - 60 * 86400, now, now)) == (60, 900, 3600))
    src = h.sources()
    check("history: sources named, with metrics; self listed", any(x["src"] == "abc123abc123" and x["name"] == "Toowoomba Rptr" and x["metrics"] == ["snr"] for x in src)
          and any(x["src"] == "self" for x in src), src)
    h.flush(t0 + 3 * 86400)                       # nothing new: no write, no prune
    h.add("self", "snr", 0.0, t0 + 3 * 86400 + 5); h.flush(t0 + 3 * 86400 + 65)
    check("history: 1-min rows pruned after 48 h, roll-ups kept",
          h.db.execute("SELECT COUNT(*) FROM series WHERE res = 60 AND t < ?", (t0 + 86400,)).fetchone()[0] == 0
          and h.db.execute("SELECT COUNT(*) FROM series WHERE res = 3600 AND t = ?", (t0,)).fetchone()[0] == 2)
    kh.MAX_ROWS, cap = 5, kh.MAX_ROWS
    for i in range(6):
        h.add("self", f"m{i}", 1, t0 + 3 * 86400 + 65 + i)
    h.flush(t0 + 3 * 86400 + 130)
    check("history: the row cap drops the oldest 1-min rows", h.db.execute("SELECT COUNT(*) FROM series").fetchone()[0] <= 5,
          h.db.execute("SELECT COUNT(*) FROM series").fetchone()[0])
    kh.MAX_ROWS = cap

    # what a sim session feeds it
    link = SimLink(); link.args.mesh_history = str(Path(tempfile.mkdtemp()) / "mh.sqlite")
    mc = kb.MeshCoreWatch(link); link.mc = mc
    await mc.start_session()
    romeo = ks.key_of("VK4ZR Romeo")[:6].hex()
    sensor = ks.key_of("Bremer Creek Sensor")[:6].hex()
    await mc.send_dm(romeo, "history 1", wait_s=3)
    await mc.send_dm(sensor, "level?", wait_s=0.3)
    check("history: DMs tracked by ACK tag (one confirmed, one waiting)", len(mc.dm_tags) == 1 and list(mc.dm_tags.values())[0][0] == sensor, mc.dm_tags)
    for name in ("Toowoomba Rptr", "VK4ZQ Bunya"):
        link.sim.heard_advert(link.sim.st[W[name]])
    await mc.poll_stats()
    mc.air_prev = (mc.air_prev[0], mc.air_prev[1], mc.air_prev[2] - 60)
    await mc.poll_stats()
    mc.history_sample(time.time() + mc.DM_WAIT_S + 1)
    mc.hist.flush(time.time() + 120)
    q = mc.hist.query("self", ["dm_ok", "dm_rtt_ms", "packets", "adverts", "batt_v", "noise_floor", "tx_air_pct", "node_up", "snr"], time.time() - 600, time.time() + 600)
    v = {m: (x[-1][1] if x else None) for m, x in q["series"].items()}
    check("history: DM success 1 of 2 (the sensor's timed out), round trip kept", v["dm_ok"] == 0.5 and v["dm_rtt_ms"] > 1000, v)
    check("history: packets, adverts, battery, noise floor, airtime %, node up, SNR", v["packets"] >= 2 and v["adverts"] == 2 and v["batt_v"] == 4.012
          and v["noise_floor"] == -117 and v["tx_air_pct"] is not None and v["node_up"] == 1 and v["snr"] is not None, v)
    twb = ks.key_of("Toowoomba Rptr")[:6].hex()
    st = mc.hist.query(twb, ["snr", "hops", "km"], time.time() - 600, time.time() + 600)["series"]
    check("history: per station SNR, hops, km", st["snr"] and st["hops"] and 78 < st["km"][-1][1] < 84, st)
    check("history: per destination DM success", mc.hist.query(sensor, ["dm_ok"], time.time() - 600, time.time() + 600)["series"]["dm_ok"][-1][1] == 0)
    # Kelly's DM retries (route, route, flood): one message = one outcome, not one per attempt (bench 2026-10-23: "40%")
    dest, t0 = "a1b2c3d4e5f6", time.time()
    def outcomes():
        s = mc.hist.query(dest, ["dm_ok"], t0 - 600, t0 + 3600)["series"]["dm_ok"]; return [x[1] for x in s]
    mc.dm_tags = {b"\x01\x00\x00\x00": (dest, t0), b"\x02\x00\x00\x00": (dest, t0 + 5)}
    mc.history_sample(t0 + mc.DM_WAIT_S + 2); mc.hist.flush(t0 + 200)          # the 1st attempt timed out, the retry still waits
    check("history: a timed-out attempt with a retry pending isn't a failure", outcomes() == [] and list(mc.dm_tags) == [b"\x02\x00\x00\x00"], (outcomes(), mc.dm_tags))
    mc.dm_tags[b"\x03\x00\x00\x00"] = (dest, t0 + 9)
    mc.on_frame(bytes([mc.P_SEND_CONFIRMED]) + b"\x03\x00\x00\x00" + struct.pack("<I", 2400))
    mc.hist.flush(t0 + 300)
    check("history: an ACK on the last attempt = 1 delivered, the other attempts dropped", outcomes() == [1] and not any(d == dest for d, _ in mc.dm_tags.values()), (outcomes(), mc.dm_tags))
    # --mesh-rpt / --mesh-rpt-poll: the bridge logs in to its own repeater and asks its status on a timer (2026-10-23)
    import os
    rpt = ks.key_of("VK4XXX Veranda Rptr")[:6].hex()
    link.args.mesh_rpt, link.args.mesh_rpt_poll, mc.RPT_WAIT_S = rpt, 15, 4
    mc.rpt_poll_at = time.time() - 15 * 60 - 1
    check("repeater poll: due after MIN minutes", mc.rpt_due())
    os.environ["KELLY_MESH_RPT_PASS"] = "wrong"
    r = await mc.poll_repeater()
    check("repeater poll: a wrong password gets no answer -> error, logs in again next time", "error" in r and mc.rpt_login_at == 0 and not mc.rpt_due(), r)
    os.environ["KELLY_MESH_RPT_PASS"] = "password"
    r = await mc.poll_repeater()
    check("repeater poll: logs in, reads status (battery)", r.get("batt_v") and mc.rpt_login_at > 0, r)
    login_at = mc.rpt_login_at
    r = await mc.poll_repeater()
    check("repeater poll: the next one needs no new login", r.get("batt_v") and mc.rpt_login_at == login_at, r)
    mc.hist.flush(time.time() + 400)
    check("repeater poll: its battery goes in the history", mc.hist.query(rpt, ["batt_v"], time.time() - 600, time.time() + 900)["series"]["batt_v"])
    link.args.mesh_rpt = "ffffffffffff"
    check("repeater poll: an unknown repeater is reported, not an exception", "isn't in the node's contacts" in (await mc.poll_repeater()).get("error", ""))
    link.args.mesh_rpt_poll = 0
    nm = {x["src"]: x.get("name") for x in mc.hist.sources()}
    check("history: stations named from their adverts", nm.get(twb) == "Toowoomba Rptr", nm)
    link.sim.heard_advert(link.sim.st[W["VK4XXX Veranda Rptr"]])     # heard direct (0 hops) in the sim world
    mc.hist.flush(time.time() + 180)
    cov = {x["name"]: x for x in mc.hist.coverage(time.time() - 3600, time.time() + 600)}
    check("coverage: a station heard direct is in, with its position and SNR", "VK4XXX Veranda Rptr" in cov and cov["VK4XXX Veranda Rptr"]["lat"] and cov["VK4XXX Veranda Rptr"]["n"] >= 1, cov)
    check("coverage: stations only heard relayed are left out (Bunya, 2 hops)", "VK4ZQ Bunya" not in cov, list(cov))
    check("history: off without --mesh-history", kb.MeshCoreWatch(SimLink()).hist is None)

    # threshold warnings (Phase 4e): judged on the history each minute, with a gap between raise and clear
    link = SimLink(); link.args.mesh_history = str(Path(tempfile.mkdtemp()) / "w.sqlite")
    mc = kb.MeshCoreWatch(link); link.mc = mc
    t = time.time() // 60 * 60 - 1800
    mc.hist.minute = t
    for i in range(2):
        mc.hist.add("self", "batt_v", 3.40, t + i * 60 + 1)
    mc.hist.flush(t + 121); mc.check_warnings(t + 125)
    check("warnings: too few samples -> nothing said", "battery" not in mc.warnings, mc.warnings)
    mc.hist.add("self", "batt_v", 3.40, t + 125); mc.hist.flush(t + 181); mc.check_warnings(t + 185)
    check("warnings: battery low raised, with its value", mc.warnings.get("battery", {}).get("text") == "battery low (3.40 V)", mc.warnings)
    for i in range(10):
        mc.hist.add("self", "batt_v", 3.62, t + 185 + i * 60)
    mc.hist.flush(t + 785); mc.check_warnings(t + 785)
    check("warnings: 3.62 V is inside the gap -> still raised, value updated", "battery" in mc.warnings and mc.warnings["battery"]["value"] > 3.5, mc.warnings)
    for i in range(10):
        mc.hist.add("self", "batt_v", 4.0, t + 790 + i * 60)
    mc.hist.flush(t + 1390); mc.check_warnings(t + 1390)
    check("warnings: back above 3.70 V -> cleared", "battery" not in mc.warnings, mc.warnings)
    for i in range(12):
        mc.hist.add("self", "rx_air_pct", 40.0, t + 1390 + i * 60); mc.hist.add("self", "dm_ok", 0, t + 1391 + i * 60)
    mc.hist.flush(t + 1390 + 12 * 60); mc.check_warnings(t + 1390 + 12 * 60)
    check("warnings: busy channel and failing DMs", set(mc.warnings) == {"busy", "dm"} and "40 %" in mc.warnings["busy"]["text"] and "0%" in mc.warnings["dm"]["text"], mc.warnings)
    link.status = types.MethodType(kb.MeshLink.status, link); link.opened_at = link.last_rx = 0.0; link.rx_bytes = link.tx_bytes = 0; link.errors = []
    check("warnings: on /api/mesh-status", set(kb.MeshLink.status(link)["warnings"]) == {"busy", "dm"})

    # p25x-alerts: each warning is its own alarm, straight away; a failed fetch keeps the last status (the gateway's watchdog: only where its scripts are, i.e. the members' repo)
    if (Path(__file__).parents[2] / "scripts" / "p25x_alerts.py").exists():
        sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
        sys.modules.setdefault("p25x_mqtt", types.ModuleType("p25x_mqtt"))
        import p25x_alerts as pa
        check("p25x-alerts: a label per warning, no delay", pa.BASE_LABELS.get("watchdog:mesh-busy") == "LoRa mesh channel busy" and pa.ALARM_AFTER["watchdog:mesh-dm"] == 0)
        pa._mesh_status.update(up=True, node="ok", warnings={"busy": {"text": "channel busy -- 40 %"}})
        check("p25x-alerts: warning text is the alarm's reason", pa.mesh_warning("busy") == "channel busy -- 40 %" and pa.mesh_warning("battery") is None)
        pa.MESH_STATUS_URL = "http://127.0.0.1:1/api/mesh-status"
        pa.mesh_problem()
        check("p25x-alerts: bridge unreachable -> warnings kept (no false all-clear)", pa.mesh_warning("busy") == "channel busy -- 40 %")


async def repeater_history_tests():
    # a repeater's status answer passing through the bridge -> its own history (battery, noise, airtime %, duplicate %)
    link = SimLink(); link.args.mesh_history = str(Path(tempfile.mkdtemp()) / "r.sqlite")
    mc = kb.MeshCoreWatch(link); link.mc = mc
    await mc.start_session()
    vk = ks.key_of("VK4XXX Veranda Rptr")
    link.sim.write(b"<" + struct.pack("<H", 33) + bytes([27]) + vk)      # what Kelly's Status button sends
    await asyncio.sleep(0.3)
    key = vk[:6].hex()

    def stats(up, tx, rx, recv_flood, dup):
        return (bytes([0x87, 0]) + vk[:6] + struct.pack("<HHhhIIIIIIIIHhHHI", 3950, 2, -112, -70, 100, 50, tx, up, 10, 5, recv_flood, 20, 0, 40, 1, dup, rx)
                + struct.pack("<I", 0) + b"\0" * 4)
    mc.on_frame(stats(10000, 100, 1000, 5000, 400))
    mc.on_frame(stats(10600, 130, 1150, 5600, 460))                      # 10 min on: +30 s TX, +150 s RX, 600 floods, 60 dups
    mc.hist.flush(time.time() + 120)
    q = mc.hist.query(key, ["batt_v", "noise_floor", "tx_air_pct", "rx_air_pct", "dup_pct", "uptime_h"], time.time() - 600, time.time() + 600)["series"]
    v = {m: [round(p[1], 3) for p in x] for m, x in q.items()}
    check("repeater history: battery and noise from each answer (the sim's 4.105 V too)", 4.105 in [round(p[2], 3) for p in q["batt_v"]] + [round(p[3], 3) for p in q["batt_v"]] and v["noise_floor"], v)
    check("repeater history: TX 5 %, RX 25 %, duplicates 10 % between two answers", (q["tx_air_pct"][-1][1], q["rx_air_pct"][-1][1], q["dup_pct"][-1][1]) == (5.0, 25.0, 10.0), v)
    mc.on_frame(stats(300, 1, 2, 3, 0))                                  # rebooted: counters back at zero -> no bogus rate
    mc.hist.flush(time.time() + 240)
    check("repeater history: a reboot gives no rate", mc.hist.query(key, ["tx_air_pct"], time.time() - 600, time.time() + 900)["series"]["tx_air_pct"][-1][4] == 1)
    nm = {x["src"]: x for x in mc.hist.sources()}
    check("repeater history: named from the contact, typed repeater", nm[key].get("name") == "VK4XXX Veranda Rptr" and nm[key].get("type") == "repeater", nm.get(key))

    # repeater warnings: a low battery and a congested repeater, named; cleared once back past the gap
    def frame(mv, up, rx):
        return (bytes([0x87, 0]) + vk[:6] + struct.pack("<HHhhIIIIIIIIHhHHI", mv, 0, -112, -70, 100, 50, 0, up, 10, 5, 100, 20, 0, 40, 1, 0, rx)
                + struct.pack("<I", 0) + bytes(4))
    link2 = SimLink(); link2.args.mesh_history = str(Path(tempfile.mkdtemp()) / "rw.sqlite")
    mc2 = kb.MeshCoreWatch(link2); link2.mc = mc2
    mc2.contacts[key] = {"name": "VK4XXX Veranda Rptr", "type": 2}
    t = time.time() // 60 * 60
    mc2.hist.minute = t - 3600
    for i, (mv, up, rx) in enumerate([(3400, 1000, 0), (3420, 1600, 240)]):     # 10 min apart: RX 40 %
        mc2.hist.minute = t - 3600 + i * 600
        mc2.on_frame(frame(mv, up, rx)); mc2.hist.flush(t - 3600 + i * 600 + 61)
    mc2.check_warnings(t)
    w = mc2.warnings
    check("repeater warnings: battery low and congested, each naming the repeater",
          "rptbatt" in w and re.search(r"VK4XXX Veranda Rptr 3\.4\d V", w["rptbatt"]["text"]) and "rptbusy" in w and "40 %" in w["rptbusy"]["text"], w)
    mc2.hist.minute = t + 60
    for _ in range(30):
        mc2.on_frame(frame(3600, 5000, 2000))                               # 3.60 V: inside the gap; airtime figures need two reads
    mc2.hist.flush(t + 121); mc2.check_warnings(t + 125)
    check("repeater warnings: 3.60 V (inside the gap) keeps the battery warning", "rptbatt" in mc2.warnings, mc2.warnings)
    mc2.hist.minute = t + 180
    for _ in range(200):
        mc2.on_frame(frame(4100, 5000, 2000))
    mc2.hist.flush(t + 241); mc2.check_warnings(t + 245)
    check("repeater warnings: back to 4.1 V -> battery warning cleared", "rptbatt" not in mc2.warnings, mc2.warnings)


def upload_tests():
    # --mesh-history-upload: the watermark, whole minutes, the 15-minute gap fill, and a real POST to a local server
    import http.server, threading
    h = kh.MeshHistory(Path(tempfile.mkdtemp()) / "u.sqlite")
    now = time.time() // 60 * 60
    t0 = now - 3 * 3600
    h.minute = t0
    for i in range(120):                                      # 2 h of minutes, 3 metrics each
        for m in ("snr", "rssi", "packets"):
            h.add("self", m, float(i), t0 + i * 60 + 1)
    h.flush(t0 + 120 * 60 + 1)
    rows, upto = h.pending(now + 60, limit=100)
    check("upload: first use sends from 48 h back, whole minutes only", len(rows) <= 100 and len(rows) % 3 == 0 and upto == rows[-1][1] and all(r[0] == 60 for r in rows), (len(rows), upto))
    h.meta("uploaded", upto)
    rows2, upto2 = h.pending(now + 60, limit=100)
    check("upload: the next batch starts after the watermark", rows2[0][1] > upto and upto2 > upto, (rows2[0][1], upto))
    h.meta("uploaded", 0)
    total = 0; wm = None
    while True:
        rows, upto = h.pending(now + 60)
        if not rows:
            break
        total += len(rows); h.meta("uploaded", upto); wm = upto
    check("upload: everything goes, then nothing is pending", total == h.db.execute("SELECT COUNT(*) FROM series WHERE res = 60").fetchone()[0] and h.pending(now + 60)[0] == [], total)
    # a gap older than the 1-minute rows: 15-minute rows fill it
    h.db.execute("DELETE FROM series WHERE res = 60 AND t < ?", (t0 + 3600,)); h.db.commit()
    h.meta("uploaded", t0 - 60)
    rows, upto = h.pending(now + 60)
    check("upload: a gap past the 1-minute rows is filled from 15-minute rows first", rows[0][0] == 900 and any(r[0] == 60 for r in rows) and rows[0][1] >= t0 - 900, rows[:2])

    got = []
    class H(http.server.BaseHTTPRequestHandler):
        code = 200
        def do_POST(self):
            got.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(H.code); self.end_headers(); self.wfile.write(b"{}")
        def log_message(self, *a): pass
    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    link = SimLink(); link.args.mesh_history = str(Path(tempfile.mkdtemp()) / "w.sqlite")
    link.args.mesh_history_upload = f"http://127.0.0.1:{srv.server_port}/api/mesh-history-ingest?token=x"; link.args.mesh_history_site = "kellypi"
    mc = kb.MeshCoreWatch(link); link.mc = mc
    mc.hist.minute = t0
    for i in range(10):
        mc.hist.add("self", "snr", 5.0, t0 + i * 60 + 1); mc.hist.add("aabbccddeeff", "snr0", 3.0, t0 + i * 60 + 2)
    mc.hist.source("aabbccddeeff", name="Veranda", type="repeater")
    mc.hist.flush(t0 + 601)
    H.code = 503
    r = mc.upload_once(now + 60)
    check("upload: the gateway away -> error, watermark kept", r.get("error") and mc.hist.meta("uploaded") is None, r)
    H.code = 200
    r = mc.upload_once(now + 60)
    b = got[-1]
    check("upload: posted -> watermark moved, site + names sent", r.get("sent") == 20 and int(float(mc.hist.meta("uploaded"))) == t0 + 540
          and b["site"] == "kellypi" and b["names"]["aabbccddeeff"]["name"] == "Veranda" and len(b["rows"]) == 20, (r, {k: v for k, v in b.items() if k != "rows"}))
    check("upload: nothing new -> nothing posted", mc.upload_once(now + 60) == {"sent": 0} and len(got) == 2)
    srv.shutdown()


async def room_tests():
    # the room server (Phase 9), as simple_room_server + companion_radio v1.18.0 answer -- the same as js/meshcoresim.js
    def rig():
        link, got = SimLink(), []
        link.mc = types.SimpleNamespace(feed=lambda b: got.append(b))
        return link, got

    def send(link, payload):
        link.sim.write(b"<" + struct.pack("<H", len(payload)) + payload)

    async def posts(link, got):                  # SYNC until NO_MORE -> the room's pushed posts (type-2 contact messages)
        out = []
        for _ in range(40):
            got.clear(); send(link, bytes([10])); await asyncio.sleep(0.005)
            f = next((g[3:] for g in got if g[3] in (10, 16)), b"\x0a")
            if f[0] == 10:
                return out
            out.append(f)
        return out

    def post(link, text):
        return bytes([2, 0, 0]) + struct.pack("<I", int(time.time())) + ks.key_of("Ipswich Chat Room")[:6] + text.encode()

    rk = ks.key_of("Ipswich Chat Room")
    link, got = rig()
    send(link, post(link, "before login"))
    send(link, bytes([26]) + rk + b"nope")
    await asyncio.sleep(0.1)
    check("room: a post before login and a wrong password get SENT only (no ACK, no LOGIN_SUCCESS)", [g[3] for g in got] == [6, 6], [g[3:].hex() for g in got])
    got.clear(); send(link, bytes([26]) + rk + b"hello"); await asyncio.sleep(0.1)
    ok = next((g[3:] for g in got if g[3] == 0x85), b"")
    check("room: guest login -> LOGIN_SUCCESS 14 B, not admin, acl 2 (read + post), fw level 1",
          len(ok) == 14 and ok[1] == 0 and ok[2:8] == rk[:6] and ok[12:14] == b"\x02\x01" and abs(struct.unpack_from("<I", ok, 8)[0] - time.time()) < 5, ok.hex())
    await asyncio.sleep(0.4)
    ps = await posts(link, got)
    authors = [p[16:20] for p in ps]
    check("room: every post pushed, oldest first, as signed plain (type 2) from the room",
          len(ps) == 6 and all(p[0] == 16 and p[11] == 2 and p[4:10] == rk[:6] for p in ps) and [struct.unpack_from("<I", p, 12)[0] for p in ps] == sorted(struct.unpack_from("<I", p, 12)[0] for p in ps), [p[:20].hex() for p in ps])
    check("room: author prefixes -- the room's own notice, an author with no contact",
          authors[0] == rk[:4] and authors[3] == ks.key_of("Gold Coast Gary")[:4] and ps[1][20:].decode().startswith("Anyone tried"), [a.hex() for a in authors])
    check("room: the first push came by flood (1 hop), the rest direct", ps[0][10] == 1 and all(p[10] == 0xFF for p in ps[1:]), [p[10] for p in ps])
    got.clear(); send(link, post(link, "Hello room from Kelly")); await asyncio.sleep(0.15)
    room = next(s for s in link.sim.st if s["type"] == 3)
    check("room: a post is ACKed and kept, by us", [g[3] for g in got][:2] == [6, 0x82] and room["posts"][-1]["author"] == link.sim.me["key"][:4] and room["posts"][-1]["text"] == "Hello room from Kelly", [g[3:8].hex() for g in got])
    await asyncio.sleep(0.2)
    check("room: our own post is never pushed back", await posts(link, got) == [])
    link.sim.room_post(W["VK4ZB Bravo Heltec"], "Copy that Kelly"); await asyncio.sleep(0.2)
    ps = await posts(link, got)
    check("room: someone else's new post is pushed straight away", len(ps) == 1 and ps[0][16:20] == ks.key_of("VK4ZB Bravo Heltec")[:4] and ps[0][20:] == b"Copy that Kelly", [p.hex() for p in ps])
    got.clear(); send(link, bytes([26]) + rk); await asyncio.sleep(0.5)
    ok = next((g[3:] for g in got if g[3] == 0x85), b"")
    check("room: a blank-password login keeps the permissions it gave us, and nothing is re-sent (sync since)", ok[12:13] == b"\x02" and await posts(link, got) == [], ok.hex())
    send(link, bytes([50]) + rk + bytes([2]) + struct.pack("<I", 1)); await asyncio.sleep(0.5)
    ps = await posts(link, got)
    check("room: keep-alive since=1 (direct) re-sends all it holds but ours", len(ps) == 7 and link.sim.me["key"][:4] not in [p[16:20] for p in ps], len(ps))
    send(link, bytes([50]) + rk + bytes([2, 0, 0, 0, 0])); await asyncio.sleep(0.3)
    check("room: keep-alive since=0 changes nothing", await posts(link, got) == [])

    link, got = rig()
    send(link, bytes([26]) + rk); await asyncio.sleep(0.1)
    ok = next((g[3:] for g in got if g[3] == 0x85), b"")
    check("room: blank password = read-only guest (flag 2, acl 0)", ok[1] == 2 and ok[12] == 0, ok.hex())
    got.clear(); send(link, post(link, "can I post?")); await asyncio.sleep(0.15)
    check("room: a read-only guest's post gets no ACK and isn't kept", 0x82 not in [g[3] for g in got] and next(s for s in link.sim.st if s["type"] == 3)["posts"][-1]["text"] != "can I post?")
    got.clear(); send(link, bytes([26]) + rk + b"roomadmin"); await asyncio.sleep(0.1)
    ok = next((g[3:] for g in got if g[3] == 0x85), b"")
    check("room: admin login (flag 1, acl 3)", ok[1] == 1 and ok[12] == 3, ok.hex())


async def prune_tests():
    # --mesh-prune-days: stale contacts off the node, by the node's own clock; repeaters get twice as long
    link = SimLink(); link.args.mesh_prune_days = 30
    mc = kb.MeshCoreWatch(link); link.mc = mc
    await mc.start_session()
    now = int(time.time())
    old_c = next(s for s in link.sim.st if s["type"] == 1)
    old_r = next(s for s in link.sim.st if s["type"] == 2)
    very_old_r = next(s for s in link.sim.st if s["type"] == 2 and s is not old_r)
    old_c["lastmod"] = now - 40 * 86400; old_r["lastmod"] = now - 40 * 86400; very_old_r["lastmod"] = now - 70 * 86400
    before = sum(1 for s in link.sim.st if s["known"])
    check("prune: not due straight after start (waits 5 min)", not mc.prune_due())
    mc.prune_at -= 400
    check("prune: due 5 min after start", mc.prune_due())
    r = await mc.prune()
    gone = {s["name"] for s in link.sim.st if not s["known"]}
    check("prune: a companion 40 days silent and a repeater 70 days silent removed", gone == {old_c["name"], very_old_r["name"]}, (gone, r))
    check("prune: a repeater 40 days silent kept (repeaters get 60)", old_r["known"])
    check("prune: result on /api/mesh-status", r["removed"] == 2 and r["table"] == before - 2 and set(r["names"]) == gone and not mc.prune_due(), r)
    mc.contacts["ffffffffffff"] = {"name": "ghost", "type": 1, "lastmod": now - 99 * 86400, "pk": "ff" * 32, "flags": 0}   # announced, never saved
    fav = next(s for s in link.sim.st if s["known"] and s["type"] == 1)
    fav["lastmod"] = now - 90 * 86400
    fav_key = ks.key_of(fav["name"])[:6].hex()
    old_cmd = mc.cmd
    async def mark_fav(payload, expect, timeout=6.0):      # the sim sends flags 0: mark this one a favourite after each refresh
        f = await old_cmd(payload, expect, timeout)
        if payload[:1] == bytes([4]) and fav_key in mc.contacts:
            mc.contacts[fav_key]["flags"] = 1
        return f
    mc.cmd = mark_fav
    r = await mc.prune()
    mc.cmd = old_cmd
    check("prune: an entry the node never saved is skipped, not fatal", "ghost" not in r["names"] and "ffffffffffff" not in mc.contacts, r)
    check("prune: a favourite is never removed, however old", fav["known"] and fav["name"] not in r["names"], r)
    orig = link.sim.write
    def unset_clock(data):
        if data[3:4] == bytes([5]):
            return link.sim.out(bytes([9]) + struct.pack("<I", 1_600_000_000)) if hasattr(link.sim, "out") else orig(data)
        return orig(data)
    if hasattr(link.sim, "out"):
        link.sim.write = unset_clock
        r = await mc.prune()
        check("prune: skipped when the node's clock was never set", bool(r.get("skipped")), r)
        link.sim.write = orig
    check("prune: off by default", not kb.MeshCoreWatch(SimLink()).prune_due())


async def autoadd_tests():
    # --mesh-autoadd: "save every advert" off, only the listed types kept, set at session start
    link = SimLink(); link.args.mesh_autoadd = "companion,repeater,overwrite"
    mc = kb.MeshCoreWatch(link); link.mc = mc
    check("autoadd: node starts with save-everything", link.sim.manual_add & 1 == 0)
    await mc.start_session()
    check("autoadd: save-everything off", link.sim.manual_add & 1 == 1, link.sim.manual_add)
    check("autoadd: companion + repeater + overwrite, any hops", (link.sim.auto_bits, link.sim.auto_hops) == (0x07, 0), (link.sim.auto_bits, link.sim.auto_hops))
    sent = []
    old_cmd = mc.cmd
    async def spy(payload, expect, timeout=6.0):
        sent.append(payload[0]); return await old_cmd(payload, expect, timeout)
    mc.cmd = spy
    mc.session_up = False
    await mc.start_session()
    check("autoadd: already set -> nothing written again", 58 not in sent and 38 not in sent, sent)
    mc.cmd = old_cmd
    check("autoadd: hops parsed", kb.MeshCoreWatch.parse_autoadd("repeater, hops=3") == (0x04, 3))
    try:
        kb.MeshCoreWatch.parse_autoadd("companion,everyone"); check("autoadd: a bad word is refused", False)
    except ValueError:
        check("autoadd: a bad word is refused", True)
    link2 = SimLink(); mc2 = kb.MeshCoreWatch(link2); link2.mc = mc2
    await mc2.start_session()
    check("autoadd: off by default (node left alone)", link2.sim.manual_add == 0 and link2.sim.auto_bits == 0x1E)


asyncio.run(main())
asyncio.run(sim_tests())
asyncio.run(history_tests())
asyncio.run(prune_tests())
asyncio.run(autoadd_tests())
upload_tests()
asyncio.run(repeater_history_tests())
asyncio.run(reset_tests())
asyncio.run(room_tests())
if kb.kelly_ent.public():   # --mesh-gateway is a club service (kelly_ent svc.club): off in the public build
    print("SKIP the bridge --mesh-gateway end to end: a club service in the public build")
else:
    bridge_e2e()
print("RESULT:", "ALL PASS" if not fails else "FAIL " + ", ".join(fails))
sys.exit(1 if fails else 0)
