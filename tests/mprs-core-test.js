// Kelly Page -- js/mprs-core.js (the MeshPRS tab's tracker, dissector, sprites) in Node.
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" kelly-page/tests/mprs-core-test.js
'use strict';
const path = require('path');
const M = require(path.join(__dirname, '../js/meshprs.js'));
const P = require(path.join(__dirname, '../js/mprs-core.js'));
let pass = 0, fail = 0;
const ok = (name, c, extra) => { if (c) pass++; else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

// spec §5.2 worked examples
const EX1 = M.unhex('50 00 2A 00 00 12 9F 5D 8E 02 F9 52 3D 35 EF D8 14 D1 6C 2F 3E 00 4D 6F 62 69 6C 65');
const EX2 = M.unhex('50 00 2B 05 80 A6 53 5D 8E 02 F9 52 3D 35 EF D8 14 D1 6C 2F 3E 03 2D 00 40 3C');

// ---- dissect: every byte covered once, in order, and the decoded values
for (const [name, b] of [['example 1', EX1], ['example 2', EX2]]) {
  const d = P.dissect(b);
  ok(`${name} decodes`, d.f && !d.err, d.err);
  let o = 0; for (const x of d.fields) { ok(`${name} ${x.key} starts at ${o}`, x.start === o, x); o += x.len; }
  eq(`${name} covers every byte`, o, b.length);
}
const d1 = P.dissect(EX1), byKey = k => d1.fields.find(x => x.key === k);
eq('source', byKey('src').value, 'VK4ABC');
ok('latitude in degrees', /^-27\.46800/.test(byKey('lat').value), byKey('lat').value);
ok('longitude in degrees', /^153\.02350/.test(byKey('lon').value), byKey('lon').value);
eq('comment', byKey('text').value, '"Mobile"');
const d2 = P.dissect(EX2);
eq('example 2 altitude', d2.fields.find(x => x.key === 'alt').value, '45 m');
eq('example 2 course', d2.fields.find(x => x.key === 'crs').value, '90°');
eq('example 2 speed', d2.fields.find(x => x.key === 'spd').value, '60 km/h');
// a broken frame: header fields shown, the rest flagged with the reason
const bad = P.dissect(M.unhex('50 00 2A 00 00 12'));
eq('short frame reason', bad.err, 'short frame');
const badSub = P.dissect(M.unhex('40 7F 01 00 00 12 9F 5D 8E 00'));
eq('unknown subtype reason', badSub.err, 'unknown subtype');
ok('unknown subtype explained', badSub.fields.some(x => x.key === 'rest' && /service/.test(x.explain)));

// ---- TNC2 preview = the spec line
eq('example 1 TNC2', P.tnc2(M.decode(EX1), 'VK4XXX-10').line, 'VK4ABC>APZKPG,qAO,VK4XXX-10:!2728.08S/15301.41E>Mobile');
eq('example 2 TNC2', P.tnc2(M.decode(EX2), 'VK4XXX-10').line, 'VK4ABC-9>APZKPG,qAO,VK4XXX-10:!2728.08S/15301.41E>090/032/A=000148');

// ---- sprites (16 x 6 grid, code - 0x21)
eq('car /> sprite', P.sprite('/>'), { sheet: 0, col: 13, row: 1, overlay: null, ocol: null, orow: null });
eq('house /- sprite', [P.sprite('/-').sheet, P.sprite('/-').col, P.sprite('/-').row], [0, 12, 0]);
eq('alternate \\n sprite', [P.sprite('\\n').sheet, P.sprite('\\n').col, P.sprite('\\n').row], [1, 13, 4]);
const ov = P.sprite('3#');
eq('overlay 3# digi', [ov.sheet, ov.overlay, ov.ocol, ov.orow], [1, '3', 2, 1]);

// ---- tracker: position, missed frames from seq, duplicates, intervals
const T = P.Tracker({ expectS: 60 });
const frame = (seq, latDeg, lonDeg, extra = {}) => M.encode(Object.assign({ subtype: 0, seq, src: 'VK4ZB-7', key: '1ED69BD5', lat: M.degToRaw(latDeg, 90), lon: M.degToRaw(lonDeg, 180), sym: '/[', comment: 'walk' }, extra));
let t = 1_000_000;
T.frame({ at: t, blob: frame(10, -27.6, 152.75), via: 'node', snr: 7.5, hops: 1 });
t += 60000; T.frame({ at: t, blob: frame(11, -27.601, 152.751), via: 'node', snr: 6 });
t += 60000; const dup = T.frame({ at: t, blob: frame(11, -27.601, 152.751), via: 'raw log' });
t += 180000; T.frame({ at: t, blob: frame(14, -27.603, 152.755, { course: 64, speed: 30 }), via: 'node' });   // 12 and 13 missed
const s = T.station('VK4ZB-7');
ok('station made', !!s);
eq('frames heard (dup not counted)', s.frames, 3);
ok('duplicate flagged', dup.dup === true);
eq('duplicates counted', s.dups, 1);
eq('missed from seq', s.missed, 2);
eq('track points', s.track.length, 3);
ok('latest position', Math.abs(s.lat - -27.603) < 1e-4 && Math.abs(s.lon - 152.755) < 1e-4, [s.lat, s.lon]);
eq('course from the frame', s.heading, 90);
eq('intervals (s)', s.intervals, [60, 240]);
const b = P.beacon(s, t + 1000, 60);
eq('beacon heard / missed / pct', [b.heard, b.missed, b.pct], [3, 2, 60]);
eq('expected interval = median of intervals', b.expectS, 150);
ok('not overdue 1 s after', !b.overdue);
ok('overdue later', P.beacon(s, t + 400000, 60).overdue);
// a reboot (seq jumps back over 127) is never "missed"
t += 60000; T.frame({ at: t, blob: frame(200, -27.603, 152.755) });
eq('older seq not counted as missed', T.station('VK4ZB-7').missed, 2);

// ---- heading from movement when the frame has no course
const T2 = P.Tracker();
T2.frame({ at: 1, blob: frame(1, -27.0, 153.0) }); T2.frame({ at: 2, blob: frame(2, -26.99, 153.0) });
eq('heading north from two points', T2.station('VK4ZB-7').heading, 0);

// ---- gate verdicts land on the matching record and the station's counters
const rec = T.packets()[0];
T.gate({ t: 'offer', hex: rec.hex, at: rec.at, verdict: 'queued', line: 'x' });
eq('queued', rec.gate.st, 'queued');
T.gate({ t: 'sent', hex: rec.hex, at: rec.at, dry: true, packet: 'VK4ZB-7>APZKPG,qAO,VK4XXX-10:!...' });
eq('dry run', rec.gate.st, 'dry');
eq('station dry count', T.station('VK4ZB-7').dry, 1);
ok('unknown hex matches nothing', T.gate({ t: 'sent', hex: 'ABCD', at: rec.at }) === null);

// ---- adverts (profile 0) make their own station
T.advert({ at: t, key: 'a698' + '0'.repeat(60), call: 'VK4XXX-12', sym: '/>', lat: -27.55, lon: 152.9, name: 'VK4XXX Mobile', snr: 4 });
const a = T.station('VK4XXX-12');
eq('advert station kind', a.kind, 'advert');
eq('advert track', a.track.length, 1);

// ---- json round trip
const T3 = P.Tracker(); T3.load(JSON.parse(JSON.stringify(T.json())));
eq('stations restored', T3.stations().length, T.stations().length);
eq('track restored', T3.station('VK4ZB-7').track.length, 3);

// ---- objects keep their own station, no seq bookkeeping
const T4 = P.Tracker();
T4.frame({ at: 5, blob: M.encode({ subtype: 5, seq: 3, src: 'VK4XXX-10', key: '01020304', name: 'EOC', live: 1, item: 0, lat: M.degToRaw(-27.5, 90), lon: M.degToRaw(152.9, 180), sym: '/E', comment: 'open' }) });
const o = T4.station('obj:EOC');
ok('object station', o && o.kind === 'object' && o.call === 'EOC' && o.track.length === 1, o);

// ---- every drop reason the gate can give has an explanation
for (const r of ['short frame', 'unknown version', 'bad callsign', 'unknown subtype', 'bad field', 'experimental subtype', 'unknown flag', 'bad text',
  'looped', 'nogate', 'test', 'not gated', 'text profile', 'untrusted', 'no key', 'key mismatch', 'replayed', 'duplicate', 'interval', 'rate', 'expired'])
  ok(`explained: ${r}`, !!P.WHY[r]);

console.log(fail ? `RESULT: ${fail} FAILED, ${pass} passed` : `RESULT: ALL PASS (${pass})`);
process.exit(fail ? 1 : 0);
