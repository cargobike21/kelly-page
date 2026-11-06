# Test vectors

One JSON file per area, as named in spec §15.1: `frames.json` (encode/decode), `gateway.json` (frame → APRS-IS line or drop), `inject.json` (APRS-IS → mesh), `text.json` (compact text profile). Profile 0 (advert) vectors stay in `kelly-page/bridge/igate_vectors.json`. Every implementation runs the same files. The model is `kelly-page/bridge/igate_vectors.json`, which `js/igate.js` and `bridge/kelly_igate.py` both pass.

Each vector:

```json
{
  "id": "pos-001",
  "spec": "§5.1",
  "about": "a fresh advert with a valid position from a trusted key is gated",
  "input": { "kind": "advert", "key": "…", "name": "VK4XXX Tracker", "lat": -27.6257, "lon": 152.7666, "rxAt": 1793255251994 },
  "config": { "trusted": ["…"], "igate": "VK4XXX-10" },
  "expect": { "out": "VK4XXX-7>APZKPG,qAO,VK4XXX-10:!2737.54S/15246.00E>…" }
}
```

A dropped input expects `{ "drop": "<reason>" }`, using the reason names from spec §15.2.

## Status

- `frames.json` (18 frames, 30 drops) and `gateway.json` (49 vectors, stateless pipeline steps 1-4 + rendering) are written, for header version 1. Every worked example in the spec is in them. A track history (subtype 0x0A) vector's `out` is a list of lines, one per entry gated.
- Implementations passing them: `kelly-page/js/meshprs.js` (`kelly-page/tests/meshprs-tests.html`) and `kelly-page/bridge/meshprs.py` (`kelly-page/bridge/test_meshprs.py`).
- The stateful steps (replay and reboot resync, duplicate, interval, queue and emergency priority, rate, expired) are tested in `kelly-page/tests/meshprs-tests.html` on a fake clock, not yet as shared JSON.
- Still to write: shared stateful gate vectors, `inject.json` (APRS-IS -> mesh), `text.json` (compact text), and the optional subtypes (weather, bulletin, neighbour report).
