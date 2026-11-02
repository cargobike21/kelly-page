"""Checks for --mesh-ble (kelly_mesh_ble.py) against a fake Bluetooth client -- no adapter, no node, no bleak.
Run: python3 bridge/test_kelly_mesh_ble.py  (stdlib only; prints RESULT: ALL PASS / FAIL)

Covers: the USB '<' framing taken apart (split, joined, junk, a bad length), a notification framed as '>', one GATT
write per frame, a node that isn't there (said once, looked for again), a dropped link reconnected, a write with no
link, a refused bond. Last, the real MeshLink with --mesh-ble --mesh-gateway over a fake BLE client wrapped round the
simulated companion (kelly_mesh_sim.py): MeshCoreWatch's whole start-up and a DM with its receipt go over "Bluetooth"."""
import asyncio
import struct
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import kelly_mesh_ble as mb  # noqa: E402
import kelly_bridge as kb  # noqa: E402
import kelly_mesh_sim as ks  # noqa: E402

fails = []
REAL_LINK = mb.MeshBleLink   # the gateway test swaps mb.MeshBleLink for a factory of fakes


def check(name, ok, got=None):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  (got {got!r})"))
    if not ok:
        fails.append(name)


def usb(payload: bytes) -> bytes:
    return b"<" + struct.pack("<H", len(payload)) + payload


class FakeClient:
    """A BleakClient stand-in: records GATT writes; notify(payload) plays a notification; drop() = link lost."""

    def __init__(self, dev, on_disc, rig):
        self.dev, self.on_disc, self.rig, self.cb, self.writes = dev, on_disc, rig, None, []
        self.services = None

    async def connect(self):
        self.rig.connects += 1

    async def pair(self):
        if self.rig.refuse_bond:
            raise RuntimeError("org.bluez.Error.AuthenticationFailed")
        return True

    async def start_notify(self, uuid, cb):
        if self.rig.refuse_bond:
            raise RuntimeError("Insufficient authentication")
        assert uuid == mb.NUS_TX
        self.cb = cb

    async def write_gatt_char(self, uuid, data, response=True):
        assert uuid == mb.NUS_RX
        self.writes.append(bytes(data))
        if self.rig.on_write:
            self.rig.on_write(bytes(data))

    def notify(self, payload: bytes):
        self.cb(None, bytearray(payload))

    async def disconnect(self):
        self.on_disc(self)

    def drop(self):
        self.on_disc(self)


class Rig:
    def __init__(self, seen_after: int = 0):
        self.seen_after, self.finds, self.connects, self.refuse_bond, self.on_write = seen_after, 0, 0, False, None
        self.clients: list[FakeClient] = []

    async def find(self, addr):
        self.finds += 1
        return None if self.finds <= self.seen_after else types.SimpleNamespace(address=addr)

    def factory(self, dev, on_disc):
        c = FakeClient(dev, on_disc, self)
        self.clients.append(c)
        return c


class NoAgent:
    async def start(self):
        return ""


def link_for(rig, on_bytes, on_state):
    ln = REAL_LINK("aa:bb:cc:dd:ee:ff", on_bytes, on_state, client_factory=rig.factory, find_device=rig.find, agent=NoAgent(),
                        log=lambda t: None)
    ln.BACKOFF = (0.02,)
    return ln


async def wait_for(cond, s=2.0):
    for _ in range(int(s / 0.01)):
        if cond():
            return True
        await asyncio.sleep(0.01)
    return cond()


async def unit_tests():
    d = mb.Deframer()
    f1, f2 = usb(b"\x16\x03abc"), usb(b"\x01")
    out, sk = d.push(f1[:2])
    check("deframe: half a header waits", out == [] and sk == 0, (out, sk))
    out, sk = d.push(f1[2:] + f2)
    check("deframe: the rest + a second frame", out == [b"\x16\x03abc", b"\x01"] and sk == 0, (out, sk))
    out, sk = d.push(b"\x94\xc3junk" + f2)
    check("deframe: bytes that aren't a frame skipped", out == [b"\x01"] and sk == 6, (out, sk))
    out, sk = d.push(b"<\xff\xff" + f2)
    check("deframe: an impossible length skipped", out == [b"\x01"] and sk == 3, (out, sk))
    check("frame from node = USB '>' framing", mb.frame_from_node(b"\x05xy") == b">\x03\x00\x05xy")

    got, states = [], []
    rig = Rig(seen_after=2)
    ln = link_for(rig, got.append, lambda up, t: states.append((up, t)))
    task = asyncio.create_task(ln.run())
    await wait_for(lambda: ln.up)
    check("away node: looked for again until seen", ln.up and rig.finds == 3, rig.finds)
    check("away node: down reported, then up", [u for u, _ in states] == [False, False, True], states)
    c = rig.clients[-1]
    n = await ln.write(usb(b"\x16\x03") + usb(b"\x04"))
    check("write: one GATT write per frame, no header", n == 2 and c.writes == [b"\x16\x03", b"\x04"], c.writes)
    c.notify(b"\x05hello")
    check("notification -> '>' framed bytes", got == [b">\x06\x00\x05hello"], got)
    c.drop()
    await wait_for(lambda: not ln.up)
    await wait_for(lambda: ln.up and rig.clients[-1] is not c)
    check("dropped link reconnected", ln.up and rig.connects == 2 and states[-2][0] is False, (rig.connects, states[-2:]))
    await ln.stop()
    await asyncio.wait_for(task, 1)
    check("stop ends run()", task.done() and not ln.up)
    try:
        await ln.write(usb(b"\x01"))
        check("write with no link refused", False)
    except OSError:
        check("write with no link refused", True)

    states = []
    rig = Rig()
    rig.refuse_bond = True
    ln = link_for(rig, got.append, lambda up, t: states.append((up, t)))
    task = asyncio.create_task(ln.run())
    await wait_for(lambda: len(states) >= 2)
    check("refused bond: not up, said why, tries again", not ln.up and "authentication" in states[0][1].lower() and rig.connects >= 2, states[:2])
    await ln.stop()
    await asyncio.wait_for(task, 1)


async def gateway_test():
    """The real MeshLink + MeshCoreWatch over 'Bluetooth' = a fake client in front of the simulated companion."""
    tmp = tempfile.mkdtemp()
    args = types.SimpleNamespace(mesh_serial=None, mesh_tcp=None, mesh_ble="AA:BB:CC:DD:EE:FF", mesh_ble_pin=None, mesh_ble_adapter="hci0",
                                 mesh_sim=False, mesh_gateway=True, mesh_outbox=str(Path(tmp) / "outbox.sqlite"))
    rig = Rig()
    sim_holder = {}

    def sim_out(b: bytes):                         # the sim speaks USB framing: undo it into one notification per frame
        buf = sim_holder.setdefault("buf", bytearray())
        buf += b
        while len(buf) >= 3 and buf[0] == 0x3E:
            ln = struct.unpack_from("<H", buf, 1)[0]
            if len(buf) < 3 + ln:
                break
            payload = bytes(buf[3:3 + ln])
            del buf[:3 + ln]
            rig.clients[-1].notify(payload)

    sim = ks.MeshCoreSim(sim_out, ks.parse_faults(""), seed=5, auto=False, speed=50)
    rig.on_write = lambda payload: sim.write(usb(payload))   # what the node gets = the frame the bridge sent over GATT
    mb.MeshBleLink = lambda addr, on_b, on_s, adapter="hci0", pin=None: link_for(rig, on_b, on_s)
    try:
        ml = kb.MeshLink(args)
        check("gateway: target names Bluetooth", "Bluetooth AA:BB:CC:DD:EE:FF" in ml.target, ml.target)
        await ml.start()
        ok = await wait_for(lambda: ml.mc.session_up, 40)   # the watch waits 10 s after start-up for a Kelly to attach (slower on a Pi)
        check("gateway: MeshCoreWatch session up over Bluetooth", ok and len(ml.mc.contacts) == len(ks.WORLD), len(ml.mc.contacts))
        romeo = ks.key_of("VK4ZR Romeo")[:6].hex()
        r = await ml.mc.send_dm(romeo, "Hello over BLE", wait_s=3)
        check("gateway: DM delivered with its receipt", r["delivered"], r)
        check("gateway: rx/tx counted", ml.rx_bytes > 0 and ml.tx_bytes > 0, (ml.rx_bytes, ml.tx_bytes))
        check("gateway: reset = REBOOT command over GATT", await ml.reset_node() == "" and rig.clients[-1].writes[-1] == b"\x13reboot", rig.clients[-1].writes[-1:])
        await ml.ble.stop()
    finally:
        mb.MeshBleLink = REAL_LINK


def agent_test():
    """The pairing agent's D-Bus signatures (Linux with dbus-fast only; nothing is registered with BlueZ)."""
    try:
        ag = mb.PinAgent(123456, lambda t: None).interface()
    except ImportError:
        print("SKIP agent: no dbus-fast here")
        return
    sig = {m.name: (m.in_signature, m.out_signature) for m in ag.introspect().methods}
    check("agent: RequestPasskey o -> u", sig.get("RequestPasskey") == ("o", "u"), sig.get("RequestPasskey"))
    check("agent: RequestPinCode o -> s", sig.get("RequestPinCode") == ("o", "s"), sig.get("RequestPinCode"))
    check("agent: every Agent1 method", {"Release", "DisplayPasskey", "DisplayPinCode", "RequestConfirmation", "RequestAuthorization",
                                         "AuthorizeService", "Cancel"} <= set(sig), sorted(sig))


async def main():
    agent_test()
    await unit_tests()
    await gateway_test()
    print("RESULT: " + ("ALL PASS" if not fails else f"FAIL ({len(fails)}): " + ", ".join(fails)))
    for t in asyncio.all_tasks() - {asyncio.current_task()}:
        t.cancel()


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(1 if fails else 0)
