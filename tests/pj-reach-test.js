/* Node test for js/pj-reach.js's pure aggregator (2026-10-24). No system Node here -- run with VS Code's:
 *   ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" tests/pj-reach-test.js
 * Prints RESULT: PASS / FAIL. */
'use strict';
const path = require('path'), fs = require('fs');
const J = f => path.join(__dirname, '..', 'js', f);
const D = require(J('mcdecode.js')), PJ = require(J('pj-core.js')), Demo = require(J('pj-demo.js')), Reach = require(J('pj-reach.js'));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const A = Reach.createAgg();

// ---- 1. synthetic events: repeaters, links, duplicates, null-safety
{
  const s = A.empty(), t = 1e12;
  const reg = { a: { lat: -27.5, lon: 153 }, b: { lat: -27.6, lon: 152.8 }, R1: { lat: -27.4755, lon: 152.958 }, far: { lat: -28.2, lon: 153.27 } };
  const ev = (o) => Object.assign({ t, route: 'flood', type: 'GRP_TXT', kind: 'chat', snr: null, snrs: [], heardFrom: 'unknown', pkey: null }, o);
  A.add(s, ev({ journey: ['a', 'R1', 'R2', 'me'], heardFrom: 'R2', snr: 5, pkey: 'p1' }));
  A.add(s, ev({ t: t + 1000, journey: ['a', 'R3', 'me'], heardFrom: 'R3', snr: -3, pkey: 'p1' }));
  A.add(s, ev({ t: t + 2000, journey: ['a', 'me'], heardFrom: 'a', snr: 1, pkey: 'p1' }));
  A.add(s, ev({ t: t + 3000, journey: ['far', 'R1', 'me'], heardFrom: 'R1', snr: 8, pkey: 'p2' }));
  A.add(s, ev({ t: t + 4000, journey: ['b', 'R1', 'R1', 'me'], heardFrom: 'R1', snr: 6, pkey: 'p3' }));   // R1 twice -> counted once
  A.add(s, ev({ t: t + 40000, journey: ['a', 'R1', 'me'], heardFrom: 'R1', snr: 7, pkey: 'p1' }));   // after the 30 s window -> new flood
  // trace: unknown -> T1 -> T2 -> me, snrs [T1 heard origin, T2 heard T1]
  A.add(s, ev({ t: t + 5000, route: 'direct', type: 'TRACE', journey: ['me', 'T1', 'T2', 'me'], snrs: [9, -12], heardFrom: 'T2', snr: 2 }));
  // junk
  for (const j of [null, undefined, 5, {}, { journey: null, snrs: null }, { route: 'flood', journey: [null, undefined, 'x'], pkey: 7 }, { type: 'TRACE', snrs: [1, 2, 3], journey: ['x'] }]) {
    try { A.add(A.empty(), j); A.add(s, j && typeof j === "object" ? Object.assign({}, j, { t: t + 6000 }) : j); } catch (e) { fails++; console.log('FAIL add threw on', j, e.message); }
  }
  const V = A.view(s, { get: id => reg[id] || null, now: t + 41000 });
  const r1 = V.reps.find(r => r.id === 'R1');
  ok(r1 && r1.origins === 3 && r1.pk === 4, 'R1: 3 origins, 4 packets ' + JSON.stringify(r1));
  ok(r1.first === 4 && r1.last === 3, 'R1 first hop 4, last hop 3');
  ok(r1.km > 80 && r1.km < 100 && r1.far === 'far', 'R1 farthest = far, ~' + (r1 && r1.km && r1.km.toFixed(1)) + ' km');
  ok(V.reps[0].id === 'R1', 'R1 leads the table');
  ok(V.reps.find(r => r.id === 'R2').km == null, 'R2 without GPS: no km');
  const lk = (f, to) => V.links.find(l => l.from === f && l.to === to);
  ok(lk('R1', 'me') && lk('R1', 'me').n === 3 && lk('R1', 'me').best === 8 && lk('R1', 'me').last === 7, 'R1->me 3 samples, best 8, latest 7');
  ok(lk('me', 'T1') && lk('me', 'T1').last === 9 && lk('T1', 'T2') && lk('T1', 'T2').last === -12, 'trace hops me->T1 9 dB, T1->T2 -12 dB');
  ok(!lk('T2', 'me') || lk('T2', 'me').last === 2, 'trace last hop from ev.snr');
  ok(!V.links.some(l => l.from === 'unknown' || l.to === 'unknown'), 'no unknown links');
  // floods: p1 (3 copies), p2, p3, p1 again, junk pkey 7 = 5 floods, 7 copies
  ok(V.floodsHr === 5 && V.copiesHr === 7, `floods 5 / copies 7 (got ${V.floodsHr}/${V.copiesHr})`);
  ok(Math.abs(V.ratio - 1.4) < 1e-9, 'ratio 1.4, got ' + V.ratio);
  ok(V.worst.length === 1 && V.worst[0].n === 3 && V.worst[0].pkey === 'p1', 'worst = p1 x3');
  ok(V.series.length === 60, '60-minute series');
}

// ---- 2. canonical folding: a placeholder later explained by a key merges
{
  const s = A.empty(), t = 2e12;
  A.add(s, { t, route: 'flood', journey: ['o1', 'h:ab', 'me'], heardFrom: 'h:ab', snr: 3, pkey: 'x' });
  A.add(s, { t: t + 1, route: 'flood', journey: ['o2', 'abcdef', 'me'], heardFrom: 'abcdef', snr: 5, pkey: 'y' });
  const V = A.view(s, { canon: id => id === 'h:ab' ? 'abcdef' : id, now: t });
  ok(V.reps.length === 1 && V.reps[0].origins === 2 && V.reps[0].pk === 2, 'h:ab folded into abcdef');
  ok(V.links.length === 1 && V.links[0].n === 2 && V.links[0].last === 5, 'links folded, latest kept');
}

// ---- 3. caps under load
{
  const s = A.empty(); let t = 3e12;
  for (let i = 0; i < 5000; i++) {
    t += 50;
    A.add(s, { t, route: 'flood', journey: ['o' + (i % 700), 'r' + (i % 900), 'q' + (i % 450), 'me'], heardFrom: 'q' + (i % 450), snr: (i % 30) - 15,
      type: 'TRACE', snrs: [1, 2], pkey: 'k' + i });
  }
  ok(s.rpt.size <= 300, 'repeaters capped: ' + s.rpt.size);
  ok(s.links.size <= 300, 'links capped: ' + s.links.size);
  ok(s.dup.size <= 2000, 'pkey groups capped: ' + s.dup.size);
  ok(s.worst.length <= 20 && s.mins.size <= 60, 'worst / minutes capped');
  ok([...s.rpt.values()].every(r => r.orig.size <= 300), 'origins per repeater capped');
}

// ---- 4. demo engine through the real ingest
{
  const bus = PJ.createBus(), reg = PJ.createRegistry(), s = A.empty();
  bus.on('packet', ev => A.add(s, ev));
  const E = Demo._engine(D, PJ.DEMO_CHANNEL, 7); let t = Date.now(), n = 0;
  for (let i = 0; i < 400; i++) for (const p of E.next()) { t += (p.dt || 0); n++; PJ.ingest(bus, reg, { raw: p.raw, snr: p.snr, rssi: p.rssi, demo: true, t }, { channels: [PJ.DEMO_CHANNEL] }); }
  const t0 = Date.now(), V = A.view(s, { canon: reg.canonical, get: reg.get, now: t }), ms = Date.now() - t0;
  console.log(`  demo: ${n} packets, ${V.reps.length} repeaters, ${V.links.length} links, ratio ${V.ratio && V.ratio.toFixed(2)}, worst ${V.worst.map(w => w.n).join(',')}, view ${ms} ms`);
  const named = V.reps.slice(0, 5).map(r => (reg.get(r.id) || {}).name + ' ' + r.origins + 'o ' + (r.km == null ? '-' : r.km.toFixed(0) + 'km'));
  console.log('  top:', named.join(' | '));
  ok(V.reps.length > 3 && V.reps.some(r => r.km != null), 'demo: repeaters with distances');
  ok(V.links.some(l => l.to !== 'me'), 'demo: trace hop links present');
  ok(V.ratio > 1, 'demo: floods heard more than once');
  ok(ms < 200, 'view is cheap');
}

// ---- 5. real packets
{
  const f = path.join(__dirname, 'mcdecode-samples.json');
  if (fs.existsSync(f)) {
    const pk = JSON.parse(fs.readFileSync(f, 'utf8')).packets || [];
    const bus = PJ.createBus(), reg = PJ.createRegistry(), s = A.empty(); let thrown = 0;
    bus.on('packet', ev => { try { A.add(s, ev); } catch { thrown++; } });
    for (const p of pk) try { PJ.ingest(bus, reg, { raw: p.hex, snr: p.snr, rssi: p.rssi }, {}); } catch { /* decoder */ }
    const V = A.view(s, { canon: reg.canonical, get: reg.get });
    ok(!thrown, `real samples: ${pk.length} packets, ${V.reps.length} repeaters, ${V.links.length} links, no throw`);
  }
}

console.log('RESULT: ' + (fails ? 'FAIL (' + fails + ')' : 'PASS'));
