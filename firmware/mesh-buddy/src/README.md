# Mesh Buddy (RAK4631 + WisBlock GNSS)

A bike / walking tracker that sends **MeshPRS frames** (`MeshPRS/spec/MeshPRS-Spec.md`, 1.0 Candidate) on `#meshprs`,
so a MeshPRS iGate (Kelly's APRS iGate + LoRa Mesh > MeshPRS tab) can put it on aprs.fi. It is MeshCore
`companion-v1.18.0`'s own sensor firmware (`examples/simple_sensor`: never repeats other stations, USB + remote admin
CLI, GPS, live position in its advert) with `main.cpp` replaced to add the beacon, status, telemetry and repeater echo.

- **Public build:** no callsign and no password compiled in. It sends nothing until a callsign is set (`mprs call`);
  the admin password is MeshCore's default until Kelly's **LoRa Mesh > 🐕 Mesh Buddy** tab sets a random one. Kelly
  ships the build (`kelly-page/firmware/mesh-buddy/`, `firmware.json` = version + sha-256) and flashes it over Web Serial
  (`js/nrfdfu.js`); the guide for other hams is `kelly-page/mesh-buddy-guide.html`.
- **Defaults** for a new install: symbol `/b` (bicycle), smart beaconing (min 120 s), flooded, comment "MeshCore kellypage.app", status "Hop count" (sent with H: each iGate adds its hop count, `>Hop count 2`), telemetry on,
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
| `mprs retry`, `mprs retry on` / `off` | position retry (spec §5.7): show the counters / switch on or off (saved; on by default) |
| `mprs hist`, `mprs hist on` / `off` | track history (spec §5.8): show what is waiting and what was sent / switch on or off (saved; on by default) |

Settings persist in `/mprs` on the node. **Testing:** `every 30`, `zerohop` (the defaults). **For the ride:**
`mprs every 0` and `mprs route flood`.

## GPS quality gate (1.2; climb check 1.3)

The 2026-10-31 rides put a test tracker kilometres off when the sky view was poor. A position is used -- beacon, smart-beaconing
distance/course, and MeshCore's own advert -- only when there are >= 5 satellites and, on a RAK12500 (u-blox), the fix is 3D
with PDOP <= 5, HDOP <= 3 and the receiver's own horizontal accuracy estimate <= 50 m; no jump faster than 250 km/h between
samples; height changing no faster than 2.0 m/s over the last 30 s or more (`mprs climb <m/s>` or `off`; a bike can't
climb that fast for long, a drifting fix does); and all that has held for 3 samples in a row (6 s). Otherwise positions are
held: no beacon, and the advert keeps the last good position for 10 min (then none). Telemetry and status still go out; the Fix bit means a GOOD fix. A RAK1910
(NMEA) gets the satellite, jump and climb checks only. Changes to the USB log: `GPS poor -- positions held: PDOP, ...` / `GPS good`.
`build.sh` drops the `static` on MeshCore's `ublox_GNSS` and `i2cGPSFlag` so `main.cpp` can read the DOP.

## Position retry and track history (1.3; spec §5.7, §5.8, decision 0030)

Losses come in clusters (coverage holes), so each flooded position is checked for an **echo**: a repeater re-sending it,
heard within 20 s (the same check as the Echo% telemetry).
- **Retry:** a position that drew no echo in its full 20 s is sent once more, the same bytes and seq with retry field 1,
  20-30 s later (40-50 s after the original). Only when flooding; never within 5 s of another of its frames; skipped if a
  newer position has gone or the next beacon may be due within 10 s (moving, or `every`, and the minimum interval nearly
  up). The iGate collapses the two copies into one APRS-IS line. While a position's echo window is open, telemetry,
  status and the next beacon wait for it, so the window is never cut short.
- **Track history:** a position missed first time and on retry (or whose retry was skipped) is kept: up to 8, oldest
  dropped, nothing older than 30 min. When a later frame is echoed (back in coverage), they go out in one track history
  frame (subtype 0x0A, its own new seq): symbol, ALT flag, count, then per entry its age in seconds (this tracker's own
  uptime clock, so no time-of-day is needed), latitude, longitude and altitude. 8 entries = 97 bytes. A MeshPRS iGate
  gates each entry as a timestamped APRS position (`/DDHHMMz...`, receive time minus age).
- **USB log:** `MeshPRS echo: none heard ...`, `MeshPRS position retry seq N (no echo in 20 s)`, `MeshPRS retry of seq N
  skipped: ...`, `MeshPRS seq N missed (no echo): kept for the track history (k waiting)`, `MeshPRS track history seq N
  N=97: 8 missed positions, oldest 1500s ago`.
- **Settings:** `mprs retry off` / `mprs hist off` (saved in `/mprs`, two bytes appended after the 1.2 fields; a config
  saved by 1.2 reads them as 0 = on). Zero-hop gets no echoes, so neither runs.
- **aprs.fi:** a timestamped position older than the station's latest is expected to show in the raw packet list but
  not on the map track (`MeshPRS/research/aprs-facts.md`; to check on a ride).

## Watchdog and reset reason (1.3)

2026-11-04 19:09 the tracker went silent after a bad GPS climb and only came back when re-plugged (USB showed the Rbt bit,
battery full): a hang, possibly the u-blox on I2C. 1.3 starts the nRF52840's hardware watchdog (60 s) first thing in
`setup()` and feeds it at the top of every `loop()`, so a hung tracker reboots itself within a minute.
- **Reset reason:** the boot log says `Mesh Buddy 1.3: last reset = WATCHDOG` (or power on, reset pin, soft reset
  (reboot / DFU), CPU lockup, wake from power off), read from `NRF_POWER->RESETREAS` before anything clears it, then
  cleared so the next boot's reason is its own. After a watchdog reset the `mprs gps` and `mprs tlm` replies end in
  `RST=WATCHDOG` (local or remote admin), and B7 Rbt is set for 10 min as after any boot.
- **MeshCore** companion-v1.18.0 starts no watchdog for the RAK4631 (only boards with `HAS_EXTERNAL_WATCHDOG`).
- **DFU still works.** The nRF52 WDT can't be stopped once started and survives a soft reset, including the 1200-baud
  touch into the bootloader. The Adafruit nRF52 bootloader feeds every enabled reload register in its DFU loop
  (Adafruit_nRF52_Bootloader `lib/sdk11/.../bootloader_dfu/bootloader.c`, "feed wdt in bootloader if enabled",
  2018-11-19), so serial and BLE DFU are unaffected. A long 60 s timeout leaves room for the bootloader's start-up and
  flash erases. Settings: runs while the CPU sleeps (a hang in a wait still trips it), pauses under a debugger.
- **Going back to 1.2:** a watchdog reset stops the WDT, so an older firmware flashed over 1.3 reboots once, about 60 s
  after it starts, then runs without it.

## Telemetry (spec §7, decision 0027's mobile layout; A2 per decision 0031, 1.4)

Values every 30 min while moving, 60 min parked (each flooded frame is re-sent by every repeater that hears it), and soon after LowBt or Hot changes; the four definitions (PARM, UNIT,
EQNS, BITS) a minute after boot and every 12 h. On aprs.fi: the station's telemetry page graphs A1-A5.

| Channel | Name | Scaling | Meaning |
|---|---|---|---|
| A1 | Battery | raw × 0.005 + 3 V | battery voltage (3.000-4.275 V) |
| A2 | Hops | raw | not sent: the frame sets H (mask bit 5) and each iGate fills in the repeater hops it heard the frame over (0 = direct); empty from an iGate without decision 0031 |
| A3 | Echo% | raw % | of our last 10 flooded frames, how many a repeater re-sent (first-hop success) |
| A4 | Sats | raw | GPS satellites in use |
| A5 | Temp | raw × 0.5 − 40 °C | the nRF52 die, a little above the air in the case |
| B1-B8 | Charge, LowBt, Fix, Move, Echo, Fld, Rbt, Hot | | external power; < 3.50 V (clears > 3.60); GPS fix; ≥ 5 km/h; last frame echoed; flooding; booted < 10 min ago; > 50 °C (clears < 45) |

The echo is caught in `logRx` (MeshCore calls it for every packet BEFORE its duplicate check), matching the packet hash,
which covers the payload only, so a repeater's copy with a longer path matches. Zero-hop mode gets no echoes (Echo% 0).
