# Mesh Buddy (RAK4631 + WisBlock GNSS)

A bike / walking tracker that sends **MeshPRS frames** (`MeshPRS/spec/MeshPRS-Spec.md`, 1.0 Candidate) on `#meshprs`,
so a MeshPRS iGate (Kelly's APRS iGate + LoRa Mesh > MeshPRS tab) can put it on aprs.fi. It is MeshCore
`companion-v1.18.0`'s own sensor firmware (`examples/simple_sensor`: never repeats other stations, USB + remote admin
CLI, GPS, live position in its advert) with `main.cpp` replaced to add the beacon, status, telemetry and repeater echo.

- **Public build:** no callsign and no password compiled in. It sends nothing until a callsign is set (`mprs call`);
  the admin password is MeshCore's default until Kelly's **LoRa Mesh > 🐕 Mesh Buddy** tab sets a random one. Kelly
  ships the build (`kelly-page/firmware/mesh-buddy/`, `firmware.json` = version + sha-256) and flashes it over Web Serial
  (`js/nrfdfu.js`); the guide for other hams is `kelly-page/mesh-buddy-guide.html`.
- **Defaults** for a new install: symbol `/b` (bicycle), smart beaconing (min 120 s), flooded, comment "Mesh Buddy", no status, telemetry on,
  name "Mesh Buddy" (Kelly sets "<CALL> <word>"). A saved `/mprs` config survives reflashing; the node NAME and admin
  password are MeshCore prefs and also survive once they've been set (a compiled-in default does not).
- **First unit:** a bike tracker, `<CALL>-12` `/b`, comment "LoRa MESHCORE", status "MeshPRS gateway via Kelly Page"; Mesh Buddy 1.0 flashed
  2026-10-31 by Kelly's own DFU code (71 s), name and admin password (`.env` `RAK_BIKE_ADMIN_PASS`) set over USB after.
- **GNSS:** RAK12500 (I2C) or RAK1910 (UART) -- MeshCore's `EnvironmentSensorManager` finds it at boot.
- **Radio:** SEQ / MBUG: 923.125 MHz, BW 62.5, SF8, CR 4/5, 2-byte path hashes, 22 dBm.

## Build (on a Linux box) and flash (on the PC)

```
# the build box: ~/pio-venv (PlatformIO), ~/mprs-tracker/MeshCore-companion-v1.18.0 (release tarball), git installed
bash build.sh                              # public -> .pio/build/RAK_4631_mesh_buddy/firmware.zip
MPRS_ADMIN_PASS=... bash build.sh          # private, that password compiled in
# PC: adafruit-nrfutil (pure Python). The 1200-baud touch moves it to a NEW COM port (bootloader PID 002A):
python -m nordicsemi dfu serial --package firmware.zip -p COM18 -b 115200 --singlebank --touch 1200   # fails to reopen
python -m nordicsemi dfu serial --package firmware.zip -p COM19 -b 115200 --singlebank                # the bootloader port
```

## USB CLI (115200, DTR on)

MeshCore's own commands work (`get name`, `get radio`, `gps`, `gps diag`, `get public.key` ...), plus:

| Command | |
|---|---|
| `mprs` | status: call, symbol, route, interval, fix, sats, frames sent, seq |
| `mprs every 30` / `mprs every 0` | a fixed interval in s (testing; never below 30, the spec floor) / smart beaconing (spec §5.5) |
| `mprs route zerohop` / `flood` | zero-hop (heard direct only) / unscoped flood through the repeaters |
| `mprs min` `max` `move` `turn` | smart beaconing: minimum s (>= 30, default 120), maximum s, metres moved, heading change ° (at >= 5 km/h) |
| `mprs call VK4XXX-12`, `mprs sym /b`, `mprs comment <text>` | the frame's identity; the comment goes in every 10th beacon |
| `mprs status <text>`, `mprs statusmin 720`, `mprs statusnow` | APRS status (`>text`, spec §8.4 code 8): once after the first fix, then every `statusmin` minutes (360-1440, default 720 = 12 h); a new status (boot, changed text, `statusnow`) is repeated 75 s later as a spec retry (§8.4: 60-90 s) (same seq, one APRS-IS line), a routine one isn't; empty text = none |
| `mprs on` / `off` / `now` | |
| `mprs gps` | the GPS quality gate: live sats, 3D or not, PDOP, HDOP, accuracy estimate against the limits; seconds held |
| `mprs pdop 5` `mprs hdop 3` `mprs hacc 50` `mprs sats 5` | the gate's limits (defaults shown); `0` = back to the default, `off` = that check off |
| `mprs tlm`, `mprs tlm on` / `off` / `now` / `defs` | telemetry: show the current values / switch on or off (saved; on by default) / send values now / send the four definitions now |

Settings persist in `/mprs` on the node. **Testing:** `every 30`, `zerohop` (the defaults). **For the ride:**
`mprs every 0` and `mprs route flood`.

## GPS quality gate (1.2)

The 2026-10-31 rides put a test tracker kilometres off when the sky view was poor. A position is used -- beacon, smart-beaconing
distance/course, and MeshCore's own advert -- only when there are >= 5 satellites and, on a RAK12500 (u-blox), the fix is 3D
with PDOP <= 5, HDOP <= 3 and the receiver's own horizontal accuracy estimate <= 50 m; no jump faster than 250 km/h between
samples; and all that has held for 3 samples in a row (6 s). Otherwise positions are held: no beacon, and the advert keeps
the last good position for 10 min (then none). Telemetry and status still go out; the Fix bit means a GOOD fix. A RAK1910
(NMEA) gets the satellite and jump checks only. Changes to the USB log: `GPS poor -- positions held: PDOP, ...` / `GPS good`.
`build.sh` drops the `static` on MeshCore's `ublox_GNSS` and `i2cGPSFlag` so `main.cpp` can read the DOP.

## Telemetry (spec §7, decision 0027's mobile layout)

Values every 10 min while moving, 30 min parked, and soon after LowBt or Hot changes; the four definitions (PARM, UNIT,
EQNS, BITS) a minute after boot and every 12 h. On aprs.fi: the station's telemetry page graphs A1-A5.

| Channel | Name | Scaling | Meaning |
|---|---|---|---|
| A1 | Battery | raw × 0.005 + 3 V | battery voltage (3.000-4.275 V) |
| A2 | EchoSNR | raw × 0.25 − 32 dB | best SNR of a repeater re-sending our last flooded frame; raw 0 = none heard |
| A3 | Echo% | raw % | of our last 10 flooded frames, how many a repeater re-sent (first-hop success) |
| A4 | Sats | raw | GPS satellites in use |
| A5 | Temp | raw × 0.5 − 40 °C | the nRF52 die, a little above the air in the case |
| B1-B8 | Charge, LowBt, Fix, Move, Echo, Fld, Rbt, Hot | | external power; < 3.50 V (clears > 3.60); GPS fix; ≥ 5 km/h; last frame echoed; flooding; booted < 10 min ago; > 50 °C (clears < 45) |

The echo is caught in `logRx` (MeshCore calls it for every packet BEFORE its duplicate check), matching the packet hash,
which covers the payload only, so a repeater's copy with a longer path matches. Zero-hop mode gets no echoes (Echo% 0).
