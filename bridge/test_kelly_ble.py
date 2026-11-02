#!/usr/bin/env python3
"""Tests for the bridge's BLE side (kelly_ble.py, the /ble + /ble-node endpoints, kelly_ble_node.py). Stdlib only, no
Bluetooth needed (the sim adapter):  python3 bridge/test_kelly_ble.py

Starts a throwaway bridge on port 18025 (no radio, --ble sim), registers a remote node, runs the node agent (sim), and
checks: the page gets local + remote adverts in the record format; the node list; a wrong token / unregistered node is
refused; the backlog a node builds while the bridge is down arrives afterwards with its original timestamps; records
are validated (bad ones dropped, id/zone from the registry); the rate limiter; id_keys = ble.js idKeys.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import kelly_ble as K  # noqa: E402

PORT = 18025
fails: list = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""), flush=True)
    if not cond:
        fails.append(name)


def unit_tests():
    good = {"ts": K.now_ms(), "a": "a4:c1:38:5e:22:01", "at": "public", "r": -70, "m": {"76": "0215"}, "s": {"181a": "00ff"}, "n": "evil", "z": "Lounge"}
    c = K.clean(good, "shed", "Shed")
    check("clean: good record kept, id + zone from the registry", c and c["n"] == "shed" and c["z"] == "Shed" and c["a"] == "A4:C1:38:5E:22:01")
    check("clean: bad MAC dropped", K.clean(dict(good, a="nope"), "shed", "Shed") is None)
    check("clean: RSSI out of range dropped", K.clean(dict(good, r=99), "shed", "Shed") is None)
    check("clean: far-future timestamp dropped", K.clean(dict(good, ts=K.now_ms() + 3600_000), "shed", "Shed") is None)
    check("clean: non-hex data dropped", K.clean(dict(good, m={"76": "zz"}), "shed", "Shed")["m"] == {})
    check("clean: oversize data dropped", K.clean(dict(good, s={"feaa": "00" * 100}), "shed", "Shed")["s"] == {})
    check("clean: control chars stripped from names", K.clean(dict(good, nm="a\x1b[31mb"), "shed", "Shed")["nm"] == "a[31mb")
    b = K.Bucket(10, 5)
    check("bucket: burst then limited", [b.take() for _ in range(6)] == [True] * 5 + [False])
    ib = {"a": "4A:11:22:33:44:55", "at": "random", "m": {"76": "0215f7826da64fa24e988024bc5b71e0893e00640001c5"}, "s": {}, "nm": "Keys"}
    check("id_keys = ble.js idKeys (rotating address: no mac key)", K.id_keys(ib) == [
        "ib:f7826da6-4fa2-4e98-8024-bc5b71e0893e:100:1", "ib:f7826da6-4fa2-4e98-8024-bc5b71e0893e:100", "ib:f7826da6-4fa2-4e98-8024-bc5b71e0893e", "name:keys"], K.id_keys(ib))
    check("id_keys: static address gives a mac key", K.id_keys({"a": "C1:22:33:44:55:66", "at": "random", "m": {}, "s": {}})[0] == "mac:C1:22:33:44:55:66")
    check("id_keys: eddystone uid", "ed:0102030405060708090a:aabbccddeeff" in K.id_keys({"a": "4A:00:00:00:00:00", "at": "random", "m": {}, "s": {"feaa": "00e80102030405060708090aaabbccddeeff"}}))
    d = K.Dedup(2)
    r = {"a": "AA:BB:CC:DD:EE:FF", "m": {}, "s": {}, "nm": None}
    check("dedup: repeat inside the window dropped, changed data passes", [d.want(r), d.want(r), d.want(dict(r, s={"fcd2": "40"}))] == [True, False, True])


def bridge(tmp, extra=()):
    return subprocess.Popen([sys.executable, str(HERE / "kelly_bridge.py"), "--port", str(PORT), "--ble", "sim", "--ble-zone", "Home",
                             "--ble-nodes", str(tmp / "nodes.json"), *extra], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


async def collect(sec: float, path="/ble") -> list:
    ws = await K.WsClient.connect(f"ws://127.0.0.1:{PORT}{path}")
    out, end = [], time.time() + sec
    try:
        while time.time() < end:
            try:
                m = await asyncio.wait_for(ws.recv(), max(0.1, end - time.time()))
            except asyncio.TimeoutError:
                break
            if m is None:
                break
            out.append(m)
    finally:
        ws.close()
    return out


async def refused(url) -> str:
    try:
        ws = await K.WsClient.connect(url)
        ws.close()
        return ""
    except ConnectionError as e:
        return str(e)


async def wait_port():
    for _ in range(50):
        try:
            _, w = await asyncio.open_connection("127.0.0.1", PORT)
            w.close()
            return
        except OSError:
            await asyncio.sleep(0.2)


async def system_tests():
    tmp = Path(tempfile.mkdtemp(prefix="kbt"))
    add = subprocess.run([sys.executable, str(HERE / "kelly_bridge.py"), "--ble-nodes", str(tmp / "nodes.json"), "--ble-add-node", "shed",
                          "--ble-zone", "Shed", "--ble-node-name", "The shed"], capture_output=True, text=True)
    tok = [l.strip() for l in add.stdout.splitlines() if l.startswith("  ")][0]
    check("--ble-add-node prints a token, keeps only its hash", len(tok) > 20 and tok not in (tmp / "nodes.json").read_text())
    br = bridge(tmp)
    await wait_port()
    env = dict(os.environ, KELLY_BLE_NODE_TOKEN=tok)
    node = subprocess.Popen([sys.executable, str(HERE / "kelly_ble_node.py"), "--server", f"127.0.0.1:{PORT}", "--node", "shed",
                             "--adapter", "sim", "--all", "--db", str(tmp / "node.db")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        msgs = await collect(25)
        hello = [m for m in msgs if m.get("t") == "hello"]
        check("page: hello with adapters + zone", hello and hello[0]["adapters"] == ["sim"] and hello[0]["zone"] == "Home", hello[:1])
        recs = [r for m in msgs if m.get("t") == "advs" for r in m["list"]]
        zones = {r["z"] for r in recs}
        check("page: local (Home) and remote (Shed) adverts", {"Home", "Shed"} <= zones, zones)
        keys = {"n", "z", "ad", "ts", "a", "at", "r", "tx", "nm", "m", "s", "u"}
        check("page: record format", recs and all(keys <= set(r) for r in recs), recs[:1])
        nodes = [m for m in msgs if m.get("t") == "nodes"]
        up = [n for m in nodes for n in m["list"] if n["id"] == "shed" and n["up"]]
        check("page: node list shows shed up, its zone and clock", up and up[-1]["zone"] == "Shed" and up[-1]["ver"] == "1.0", nodes[-1:] if nodes else None)
        check("page: health message", any(m.get("t") == "health" for m in msgs))
        check("wrong token refused", "refused" in await refused(f"ws://127.0.0.1:{PORT}/ble-node?node=shed&token=nope"))
        check("unregistered node refused", "refused" in await refused(f"ws://127.0.0.1:{PORT}/ble-node?node=evil&token={tok}"))
        api = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/ble-nodes").read())
        check("/api/ble-nodes lists the node", [n["id"] for n in api["nodes"]] == ["shed"])
        # store and forward: bridge down 15 s, the node queues; back up, the backlog arrives with its old timestamps
        br.terminate()
        br.wait(5)
        down_at = K.now_ms()
        await asyncio.sleep(15)
        br = bridge(tmp)
        await wait_port()
        back_at = K.now_ms()
        msgs = await collect(40)
        late = [r for m in msgs if m.get("t") == "advs" for r in m["list"] if r["z"] == "Shed" and down_at < r["ts"] < back_at]
        check("store-and-forward: adverts from while the bridge was down arrive later", len(late) > 5, len(late))
        ts = [r["ts"] for m in msgs if m.get("t") == "advs" for r in m["list"] if r["z"] == "Shed"]
        check("store-and-forward: in order", ts == sorted(ts) or sum(1 for a, b in zip(ts, ts[1:]) if b < a - 2000) == 0)
        # rotate: the old token stops working
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/ble-nodes", data=json.dumps({"op": "rotate", "id": "shed"}).encode(), method="POST")
        new = json.loads(urllib.request.urlopen(req).read())
        check("rotate gives a new token", new.get("token") and new["token"] != tok)
        check("rotated: the old token is refused", "refused" in await refused(f"ws://127.0.0.1:{PORT}/ble-node?node=shed&token={tok}"))
    finally:
        node.terminate()
        br.terminate()
        for p in (node, br):
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
        if fails:
            print("--- bridge output ---\n" + (br.stdout.read() if br.stdout else "")[-3000:])
            print("--- node output ---\n" + (node.stdout.read() if node.stdout else "")[-3000:])


if __name__ == "__main__":
    unit_tests()
    asyncio.run(system_tests())
    print("RESULT: " + ("FAIL " + ", ".join(fails) if fails else "ALL PASS"))
    sys.exit(1 if fails else 0)
