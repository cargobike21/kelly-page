/* Kelly Page tests -- Packet Journey airtime (js/pj-air.js): the LoRa time-on-air formula against hand-worked Semtech
 * values, MeshCore's preamble rule, and the aggregator on real packets (tests/mcdecode-samples.json, incl. the real
 * 1-byte station) and on the demo mesh (~15% 1-byte traffic). The DOM side: tests/pj-air-tests.html.
 * Run (no system Node; VS Code's Electron works):
 *   ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" tests/pj-air-test.js
 * Prints RESULT: PASS / FAIL. */
'use strict';
const path = require('path');
const D = require(path.join(__dirname, '../js/mcdecode.js'));
const PJ = require(path.join(__dirname, '../js/pj-core.js'));
const HC = require(path.join(__dirname, '../js/mchashcheck.js'));
const Demo = require(path.join(__dirname, '../js/pj-demo.js'));
const Air = require(path.join(__dirname, '../js/pj-air.js'));
let fails = 0, n = 0;
const near = (name, got, want, tol = 0.01) => { n++; if (got == null || Math.abs(got - want) > tol) { fails++; console.log(`FAIL ${name}: got ${got}, want ${want}`); } };
const eq = (name, got, want) => { n++; if (JSON.stringify(got) !== JSON.stringify(want)) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };
const ok = (name, c) => eq(name, !!c, true);

// ---------------------------------------------------------------- formula (worked by hand from AN1200.13)
const T = Air.airtimeMs;
near('SF7 BW125 CR4/5 20 B pre 8', T(20, { sf: 7, bwKHz: 125, cr: 5 }, { preamble: 8 }), 56.576);
near('cr given as 1 == 5', T(20, { sf: 7, bwKHz: 125, cr: 1 }, { preamble: 8 }), 56.576);
near('SF8 BW62.5 CR4/5 20 B pre 8', T(20, { sf: 8, bwKHz: 62.5, cr: 5 }, { preamble: 8 }), 205.824);
near('SF8 BW62.5 CR4/5 20 B MeshCore pre 32', T(20, { sf: 8, bwKHz: 62.5, cr: 5 }), 304.128);
near('SF12 BW125 CR4/5 20 B pre 8 (LDRO on)', T(20, { sf: 12, bwKHz: 125, cr: 5 }, { preamble: 8 }), 1318.912);
near('SF10 BW62.5 Tsym 16.384 ms -> LDRO', T(20, { sf: 10, bwKHz: 62.5, cr: 5 }, { preamble: 8 }), (12.25 + 8 + Math.ceil((160 - 40 + 44) / 32) * 5) * 16.384);
near('SF11 BW250 Tsym 8.192 -> no LDRO', T(20, { sf: 11, bwKHz: 250, cr: 5 }, { preamble: 8 }), (12.25 + 8 + Math.ceil((160 - 44 + 44) / 44) * 5) * 8.192);
near('SF7 BW125 CR4/8 0 B pre 8', T(0, { sf: 7, bwKHz: 125, cr: 8 }, { preamble: 8 }), (12.25 + 8 + Math.ceil(16 / 28) * 8) * 1.024);
ok('longer packet takes longer', T(100, { sf: 8, bwKHz: 62.5, cr: 5 }) > T(50, { sf: 8, bwKHz: 62.5, cr: 5 }));
eq('preamble rule (MeshCore preambleLengthForSF)', [7, 8, 9, 12].map(Air.preambleFor), [32, 32, 16, 16]);
eq('bad input -> null', [T(null, {}), T(20, null), T(20, { sf: 8, bwKHz: 0, cr: 5 }), T(20, { sf: 8, bwKHz: 62.5, cr: 9 }), T(NaN, { sf: 8, bwKHz: 62.5, cr: 5 })], [null, null, null, null, null]);
eq('load levels', [Air.loadLevel(5), Air.loadLevel(10), Air.loadLevel(24.9), Air.loadLevel(25)], ['ok', 'warn', 'warn', 'bad']);

// ---------------------------------------------------------------- aggregator on real packets
const S = require(path.join(__dirname, 'mcdecode-samples.json')).packets;
const te = s => new TextEncoder().encode(s);
const chans = [{ name: '#test', secret: D.sha256(te('#test')).subarray(0, 16) }];
const radio = { sf: 8, bwKHz: 62.5, cr: 5 };
{
  const A = Air.createAgg(PJ.KINDS), set = A.empty(), bus = PJ.createBus(), reg = PJ.createRegistry({});
  let sum = 0, t = Date.now() - 30000;
  for (const p of S) {
    const ev = PJ.ingest(bus, reg, { raw: p.hex, snr: p.snr, rssi: p.rssi, t: t += 500 }, { channels: chans });
    const ms = T(ev.size, radio); sum += ms;
    A.add(set, ev, ms, HC.evaluate(ev.d, 2, {}));
  }
  const V = A.view(set, id => reg.canonical(id), 2);
  near('real: total airtime = sum', V.ms, sum, 1e-6);
  near('real: last-60 s = all (heard in the last 30 s)', V.last60, sum, 1e-6);
  near('real: load % = airtime / 60 s', V.loadPct, sum / 600, 1e-9);
  near('real: kind split sums to total', V.kMs.reduce((a, b) => a + b, 0), sum, 1e-6);
  near('real: last minute bucket(s) hold it all', V.mins.reduce((a, b) => a + b, 0) * 600, sum, 1e-6);
  ok('real: top talkers sorted', V.talkers.every((x, i) => !i || V.talkers[i - 1].ms >= x.ms));
  ok('real: the 1-byte station (address 16) is flagged', V.wrong.some(w => w.size === 1 && /16/.test(w.name)));
  ok('real: 2-byte repeaters are not flagged', V.wrong.every(w => w.size !== 2));
  ok('real: wrong % in (0, 100)', V.wrongPct > 0 && V.wrongPct < 100);
  eq('real: wrong floods = 1-byte floods (expect 2)', V.wrongFloods, V.bySize[1] + V.bySize[3]);
  const V1 = A.view(set, null, 1);
  ok('expect 1 instead: the 2-byte stations become the wrong ones', V1.wrong.every(w => w.size !== 1) && V1.wrong.length > 0);
  // copies of one flood count once for the %
  const before = A.view(set, null, 2).floods, ev0 = PJ.ingest(bus, reg, { raw: S[0].hex, snr: 1, rssi: -90 }, { channels: chans });
  A.add(set, ev0, T(ev0.size, radio), HC.evaluate(ev0.d, 2, {}));
  eq('repeat of a heard flood (same pkey) does not count again for the %', A.view(set, null, 2).floods, before);
  // null-ish events never throw
  A.add(set, null, 1, null); A.add(set, { kind: null, src: null, t: null }, 10, null); A.add(set, {}, null, { size: 1, name: null });
  ok('null fields survive', A.view(set, null, 2).n === S.length + 2);
  // the 60-minute window
  const s2 = A.empty(), now = Date.now();
  A.add(s2, { t: now - 90 * 60000, kind: 'chat' }, 6000, null); A.add(s2, { t: now - 5 * 60000, kind: 'chat' }, 6000, null);
  const V2 = A.view(s2, null, 2, now);
  near('old minute dropped, 5-min-old kept as 10%', V2.mins.reduce((a, b) => a + b, 0), 10, 1e-9);
  near('nothing in the last 60 s -> 0% load', V2.loadPct, 0);
}

// ---------------------------------------------------------------- demo mesh: ~15% 1-byte traffic shows up
{
  const eng = Demo._engine(D, PJ.DEMO_CHANNEL, 777), A = Air.createAgg(PJ.KINDS), set = A.empty(), bus = PJ.createBus(), reg = PJ.createRegistry({});
  for (let i = 0; i < 600; i++) for (const p of eng.next()) {
    const ev = PJ.ingest(bus, reg, { raw: p.raw, snr: p.snr, rssi: p.rssi, demo: true }, { channels: [PJ.DEMO_CHANNEL] });
    A.add(set, ev, T(ev.size, radio), HC.evaluate(ev.d, 2, {}));
  }
  const V = A.view(set, id => reg.canonical(id), 2);
  ok(`demo: some wrong-size stations (${V.wrong.length})`, V.wrong.length > 0);
  ok(`demo: wrong % plausible (${V.wrongPct && V.wrongPct.toFixed(1)}%)`, V.wrongPct > 2 && V.wrongPct < 40);
  ok('demo: some "certain" evidence', V.wrong.some(w => w.strength === 'certain') || V.wrong.length < 3);
  ok('demo: talkers capped', V.talkers.length <= 8 && Object.keys(set.talk).length <= 200);
  ok('demo: per-packet airtime sane (avg 100-2000 ms)', V.ms / V.n > 100 && V.ms / V.n < 2000);
  ok('demo: recent capped', set.recent.length <= 5000);
}

console.log(`${n} checks`);
console.log(fails ? `RESULT: FAIL (${fails})` : 'RESULT: PASS');
