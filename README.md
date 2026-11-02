# Kelly Page

A web console for Tait P25 radios (TM9100, TM9400, TP9400) over Tait's CCDI radio API, by serial or IP:
radio control and telemetry, calls and texts, a live GPS map, LoRa mesh (MeshCore, Meshtastic, LoRa APRS),
an APRS iGate for MeshCore trackers, BLE presence, DNP3 / SCADA trainers, RTTY and more -- all in one page in
Chrome or Edge, with an optional Python bridge for IP and a Raspberry Pi install.

**Read `manual.html`** (open it in your browser) for set-up and everyday use. To run Kelly on a headless
Raspberry Pi beside the radio, follow **`install-pi.html`**. Try it with no radio: open `index.html?demo`.

## Network data services

Some features use a P25 data gateway (weather, cameras, bulletins, packet mail, file transfer, updates over
the air ...). They are available to registered stations of the network that runs the gateway; register at
https://kellypage.app. Without a registration those parts of Kelly are simply not shown -- everything that
works with your own radio, your own mesh node or your own internet connection is all there.

## Mesh Buddy firmware source

Kelly's LoRa Mesh page flashes the Mesh Buddy tracker firmware (a RAK4631 + GPS that beacons MeshPRS positions) from
`firmware/mesh-buddy/`. Its source is in **`firmware/mesh-buddy/src/`**: `main.cpp` replaces the `main.cpp` of MeshCore
companion-v1.18.0's `examples/simple_sensor`, and `build.sh` builds it with PlatformIO -- see the README there.
MIT, like MeshCore (`firmware/mesh-buddy/LICENSE-MeshCore.txt`).

## Not affiliated with Tait

Kelly Page is an independent project. It is not made, endorsed or supported by Tait Communications.
"Tait" and the radio model names are theirs, used here only to say which radios Kelly works with.

## Licence

The code is MIT licensed (see `LICENSE`). The name "Kelly Page" and the Kelly logo and artwork (`assets/`,
`brand/`) are not covered by the MIT licence: please don't use them for a fork. Third-party parts keep their own
licences, listed in `THIRD_PARTY.md` and shipped next to them.
