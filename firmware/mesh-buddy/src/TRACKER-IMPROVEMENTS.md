# Mesh Buddy: tracker improvements

From the 2026-11-04 rides: about a third to half of positions heard while moving, with clustered loss (coverage
holes, not random collisions). On the 2026-10-31 ride, P(lost | previous lost) was 48 %. Raising the beacon rate is
not on this list: packets sent inside a hole are still lost, and every extra flood costs everyone airtime.

| # | Item | Where | Status |
| --- | --- | --- | --- |
| 1 | Log each MeshPRS frame's sequence number in the iGate's received-packet log, so a ride's true loss (per street) can be measured | `kelly-page/bridge/kelly_igate.py` (`RxLog`, KML export) | done 2026-11-04 |
| 2 | Backfill: the tracker keeps recent positions, marks the ones with no echo, and sends them later in one "track history" frame. The iGate gates them as timestamped APRS positions | MeshPRS decision 0030 + spec §5.8 (subtype 0x0A), `main.cpp`, Kelly iGate (`js/meshprs.js`, `bridge/meshprs.py`, `bridge/kelly_igate.py`) | decided 2026-11-04 (0030); spec, vectors and Kelly iGate written and tested; firmware written for Mesh Buddy 1.3, not yet built or flashed |
| 3 | Echo retry: no echo of a position within about 20 s means one resend after a random delay | `main.cpp`, spec §5.7 | decided 2026-11-04 (0030): one retry 40-50 s after the original; firmware written for 1.3, not yet built or flashed |
| 4 | Antenna and mounting: a better 915 MHz antenna mounted higher, compared on the same route | the tracker owner (hardware) | to do |
| 5 | More receivers on the weak north side: a repeater node, or another ham's Kelly iGate | the tracker owner (site) | to do |
| 6 | GPS climb-rate sanity check, so a fix climbing implausibly fast (2026-11-04 19:00: +1150 m in 9 min) is held | `main.cpp` (quality gate), Mesh Buddy 1.3 | written; not yet built or flashed |
| 7 | Hardware watchdog (nRF52840 WDT, 60 s, fed from `loop()`) so a hung tracker reboots itself (2026-11-04 19:09: silent until re-plugged), and the reset reason on USB at boot plus `RST=WATCHDOG` in the `mprs gps` / `mprs tlm` replies | `main.cpp`, Mesh Buddy 1.3 | written; not yet built or flashed |

Order: 1 first, because it gives hard numbers on the next ride. Then 6, 7, 3 and 2 in one firmware build (one reflash).
4 and 5 run alongside on the same route.
