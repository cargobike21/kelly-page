"""Kelly Page bridge -- a MeshCore companion node over Bluetooth LE (--mesh-ble ADDR), for a BLE-only node on a Pi.

The LoRa Mesh page and MeshCoreWatch speak the node's USB framing ('<' len u16 payload to the node, '>' len u16
payload from it). Over Bluetooth the companion has no length header: it is the Nordic UART service, one frame per
GATT write to 6e400002 and one frame per notification on 6e400003 (js/meshcore.js, "Bluetooth"). So this link
re-frames both ways and the rest of the bridge can't tell it from --mesh-serial:
  notification payload  -> '>' len payload  -> on_bytes (the /mesh clients + MeshCoreWatch)
  '<' len payload bytes -> payload          -> one GATT write each, one at a time (overlapping writes drop MeshCore)
Only MeshCore: a Meshtastic node's BLE service is a different one (toRadio / fromRadio / fromNum).

Pairing: the companion needs a bond, made with its 6-digit PIN (on its screen, else 123456). bleak 0.22 (Debian 13's
python3-bleak) has no pairing agent, so this registers its own BlueZ Agent1 (dbus-fast, which bleak already needs)
as the default agent and answers the PIN itself; then client.pair(). If that can't be done (no dbus-fast, another
default agent holds it), pair once by hand -- the bond is kept:
    bluetoothctl            then:  scan on / pair AA:BB:CC:DD:EE:FF / (type the PIN) / trust AA:BB:CC:DD:EE:FF / quit

A node that isn't there never stops the bridge: it looks again with a back-off (5 s doubling to 60 s), and a node
that drops (out of range, rebooted, the phone app took it) is reconnected the same way. The companion takes ONE
Bluetooth connection: while the bridge holds it the phone app can't connect, and the other way round.

With --ble scanning on the same adapter: BlueZ runs both, but the connection takes radio time from the scan (fewer
adverts heard, presence a little slower), and finding the node runs an active discovery alongside a passive scan.
A second adapter (--mesh-ble-adapter hci1, a USB dongle) keeps them apart.
"""
# no `from __future__ import annotations`: dbus-fast reads the Agent's D-Bus signatures from the annotations

import asyncio
import struct
import sys

NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"     # app -> node (write)
NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"     # node -> app (notify)
DEFAULT_PIN = 123456
MAX_FRAME = 300                                     # a MeshCore frame is <= 177 bytes; anything longer is garbage


def add_args(ap):
    ap.add_argument("--mesh-ble-adapter", default="hci0", metavar="HCI", help="with --mesh-ble: the Bluetooth adapter (default hci0)")
    ap.add_argument("--mesh-ble-pin", type=int, default=None, metavar="PIN",
                    help=f"with --mesh-ble: the node's 6-digit pairing PIN (default env KELLY_MESH_BLE_PIN, else {DEFAULT_PIN})")


class Deframer:
    """'<' len u16 payload (the USB framing the page and MeshCoreWatch send) -> payloads. Bytes that aren't a frame
    start are skipped up to the next '<'; returns (payloads, bytes skipped)."""

    def __init__(self):
        self.buf = bytearray()

    def push(self, data: bytes) -> tuple[list[bytes], int]:
        self.buf += data
        out, skipped = [], 0
        while self.buf:
            if self.buf[0] != 0x3C:
                i = self.buf.find(b"<")
                n = len(self.buf) if i < 0 else i
                del self.buf[:n]
                skipped += n
                continue
            if len(self.buf) < 3:
                break
            ln = struct.unpack_from("<H", self.buf, 1)[0]
            if ln == 0 or ln > MAX_FRAME:
                del self.buf[:1]
                skipped += 1
                continue
            if len(self.buf) < 3 + ln:
                break
            out.append(bytes(self.buf[3:3 + ln]))
            del self.buf[:3 + ln]
        return out, skipped


def frame_from_node(payload: bytes) -> bytes:
    return b">" + struct.pack("<H", len(payload)) + payload


class PinAgent:
    """A BlueZ Agent1 that answers the node's pairing with a fixed PIN (dbus-fast). start() -> '' or why not."""
    PATH = "/org/kelly/mesh_ble_agent"

    def __init__(self, pin: int, log):
        self.pin, self.log, self.bus = pin, log, None

    def interface(self):
        """The org.bluez.Agent1 object (dbus-fast ServiceInterface); ImportError without dbus-fast."""
        from dbus_fast.service import ServiceInterface, method
        pin, log = self.pin, self.log

        class Agent(ServiceInterface):
            def __init__(self):
                super().__init__("org.bluez.Agent1")

            @method()
            def Release(self):  # noqa: N802
                pass

            @method()
            def RequestPinCode(self, device: "o") -> "s":  # noqa: F821,N802
                log(f"pairing {device}: PIN asked, answered")
                return str(pin)

            @method()
            def RequestPasskey(self, device: "o") -> "u":  # noqa: F821,N802
                log(f"pairing {device}: passkey asked, answered")
                return pin

            @method()
            def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):  # noqa: F821,N802
                pass

            @method()
            def DisplayPinCode(self, device: "o", pincode: "s"):  # noqa: F821,N802
                pass

            @method()
            def RequestConfirmation(self, device: "o", passkey: "u"):  # noqa: F821,N802
                pass                                     # numeric comparison: accept

            @method()
            def RequestAuthorization(self, device: "o"):  # noqa: F821,N802
                pass

            @method()
            def AuthorizeService(self, device: "o", uuid: "s"):  # noqa: F821,N802
                pass

            @method()
            def Cancel(self):  # noqa: N802
                log("pairing cancelled by BlueZ")

        return Agent()

    async def start(self) -> str:
        try:
            from dbus_fast import BusType
            from dbus_fast.aio import MessageBus
            agent = self.interface()
        except ImportError as e:
            return f"dbus-fast missing ({e})"
        try:
            self.bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
            self.bus.export(self.PATH, agent)
            intro = await self.bus.introspect("org.bluez", "/org/bluez")
            mgr = self.bus.get_proxy_object("org.bluez", "/org/bluez", intro).get_interface("org.bluez.AgentManager1")
            await mgr.call_register_agent(self.PATH, "KeyboardOnly")
            await mgr.call_request_default_agent(self.PATH)
            return ""
        except Exception as e:                         # noqa: BLE001 -- e.g. another default agent, no D-Bus access
            if self.bus:
                self.bus.disconnect()
                self.bus = None
            return str(e)


class MeshBleLink:
    """The node over Bluetooth. on_bytes(USB-framed bytes from the node); on_state(up: bool, text: str).
    client_factory / find_device / agent are for tests (a fake BleakClient); by default bleak's."""

    BACKOFF = (5, 10, 20, 40, 60)

    def __init__(self, addr: str, on_bytes, on_state, adapter: str = "hci0", pin: int | None = DEFAULT_PIN,
                 client_factory=None, find_device=None, agent=None, log=None):
        self.addr, self.adapter, self.pin = addr.upper(), adapter, pin
        self.on_bytes, self.on_state = on_bytes, on_state
        self.client_factory, self.find_device, self.agent = client_factory, find_device, agent
        self.log = log or (lambda t: print(f"[bridge] mesh ble: {t}", flush=True))
        self.client = None
        self.up = False
        self.deframer = Deframer()
        self.wlock = asyncio.Lock()
        self.lost = asyncio.Event()
        self.stopping = False
        self.write_response = True
        self.connects = 0

    # ---- bleak by default
    async def _find(self):
        if self.find_device:
            return await self.find_device(self.addr)
        from bleak import BleakScanner
        kw = {"bluez": {"adapter": self.adapter}} if sys.platform.startswith("linux") else {}
        return await BleakScanner.find_device_by_address(self.addr, timeout=20.0, **kw)

    def _client(self, dev):
        if self.client_factory:
            return self.client_factory(dev, self._disconnected)
        from bleak import BleakClient
        kw = {"adapter": self.adapter} if sys.platform.startswith("linux") else {}
        return BleakClient(dev, disconnected_callback=self._disconnected, timeout=20.0, **kw)

    def _disconnected(self, _client):
        self.lost.set()

    def _notify(self, _char, data: bytearray):
        if data:
            self.on_bytes(frame_from_node(bytes(data)))

    async def _session(self):
        dev = await self._find()
        if dev is None:
            raise OSError(f"{self.addr} not seen (off, out of range, or connected to a phone)")
        client = self._client(dev)
        await client.connect()
        try:
            try:
                await client.pair()                    # already bonded = returns at once; else the agent gives the PIN
            except Exception as e:                     # noqa: BLE001 -- some stacks pair on the first secure access instead
                self.log(f"pair: {e} (trying without -- pair by hand with bluetoothctl if it keeps failing)")
            ch = client.services.get_characteristic(NUS_RX) if getattr(client, "services", None) else None
            if ch is not None:
                self.write_response = "write" in ch.properties
            await client.start_notify(NUS_TX, self._notify)   # needs the bond: this is where an unpaired node refuses
        except BaseException:
            try:
                await client.disconnect()
            except Exception:                          # noqa: BLE001
                pass
            raise
        self.client, self.up = client, True
        self.connects += 1
        self.deframer = Deframer()
        self.on_state(True, "LoRa node connected (Bluetooth)")

    async def run(self):
        if self.agent is None and self.pin is not None:
            self.agent = PinAgent(self.pin, self.log)
        if self.agent is not None:
            why = await self.agent.start()
            if why:
                self.log(f"no pairing agent ({why}) -- pair the node once with bluetoothctl (see kelly_mesh_ble.py)")
        tries = 0
        while not self.stopping:
            self.lost.clear()
            try:
                await self._session()
                tries = 0
                await self.lost.wait()
                if not self.stopping:
                    self.on_state(False, "LoRa node Bluetooth link dropped -- reconnecting")
            except asyncio.CancelledError:
                raise
            except Exception as e:                     # noqa: BLE001 -- not there / refused: look again later
                self.on_state(False, f"LoRa node Bluetooth: {e}")
            self.client, self.up = None, False
            if self.stopping:
                break
            await asyncio.sleep(self.BACKOFF[min(tries, len(self.BACKOFF) - 1)])
            tries += 1

    async def write(self, data: bytes) -> int:
        """USB-framed bytes from the page / MeshCoreWatch -> one GATT write per frame. Returns frames written."""
        frames, skipped = self.deframer.push(data)
        keyed = [f for f in frames if f[:1] in (b"\x17", b"\x18")]   # private-key export/import: never (kelly_bridge PrivateKeyGuard)
        if keyed:
            frames = [f for f in frames if f not in keyed]
            self.log(f"dropped {len(keyed)} private-key command frame(s)")
        if skipped:
            self.log(f"dropped {skipped} bytes that aren't MeshCore frames (Bluetooth carries MeshCore only)")
        client = self.client
        if client is None:
            raise OSError("LoRa node not connected (Bluetooth)")
        n = 0
        for f in frames:
            async with self.wlock:
                await client.write_gatt_char(NUS_RX, f, response=self.write_response)
            n += 1
        return n

    async def drop(self):
        """Disconnect; run() reconnects (the dashboard's Reconnect button, a node reboot)."""
        c = self.client
        if c is not None:
            try:
                await c.disconnect()
            except Exception:                          # noqa: BLE001
                pass
        self.lost.set()

    async def stop(self):
        self.stopping = True
        await self.drop()

