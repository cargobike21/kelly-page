/* Kelly Page -- Trace Route > Telemetry polling: grants + path trace test (Node).
 * Run: ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" tests/tr-grants-test.js
 * Prints RESULT: ALL PASS / RESULT: FAIL (n).
 */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '../js/tr-grants.js'));
const TR = require(path.join(__dirname, '../js/tr-core.js'));
const Engine = require(path.join(__dirname, '../js/tr-engine.js'));
const Sim = require(path.join(__dirname, '../js/tr-sim.js'));
const PJ = require(path.join(__dirname, '../js/pj-core.js'));

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log('  FAIL:', name); } };
const section = s => console.log('--', s);

const KA = 'a1'.repeat(32), KB = 'b2'.repeat(32), KX = 'c3'.repeat(32);

section('messages: encode / parse / verify');
{
  const t = G.encode({ op: 'REQ', id: 'abc123', from: KA, to: KB, offer: true });
  ok(t === `KT1 REQ abc123 ${KA.slice(0, 16)} ${KB.slice(0, 16)} 1`, 'REQ text');
  const m = G.parse(t);
  ok(m && m.op === 'REQ' && m.offer === true && m.from === KA.slice(0, 16), 'REQ parses');
  ok(G.parse(t + '\0\0') !== null, 'zero padding ignored');
  ok(G.parse('hello there') === null && G.parse('KT1 ZAP abc123') === null && G.parse('KT1 REQ abc123 short x 1') === null, 'junk refused');
  ok(G.parse('KT1 REQ abc123 ' + KA.slice(0, 16) + ' ' + KB.slice(0, 16) + ' 2') === null, 'bad offer flag refused');
  ok(G.encode({ op: 'ACK', id: 'abc123' }) === 'KT1 ACK abc123', 'ACK text');
  ok(G.encode({ op: 'OK', id: 'abc123', from: KB, to: KA }).length < 160, 'fits a MeshCore DM');
  ok(G.verify(m, KA, KB) === null, 'verify: right keys');
  ok(/sender/.test(G.verify(m, KX, KB)), 'verify: sender key mismatch');
  ok(/different key/.test(G.verify(m, KA, KX)), 'verify: receiver key mismatch');
  ok(G.verify(G.parse('KT1 REV abc123'), null, null) === null, 'REV needs no fingerprints');
  let threw = false; try { G.encode({ op: 'REQ', id: 'zz' }); } catch { threw = true; }
  ok(threw, 'bad id refused');
}

// two Kellys, each with its node's flag set (who may read MY telemetry) and its own grant records
function kelly(myKey) {
  return { myKey, grants: {}, flags: new Set(), mode: 2, sent: [], notes: [], polling: {} };
}
function run(k, peer, ev) {
  const g = k.grants[peer] || G.blank(peer, peer.slice(0, 4));
  const r = G.reduce(g, Object.assign({ id: G.newId(), now: 1 }, ev));
  k.grants[peer] = r.grant;
  for (const f of r.effects) {
    if (f.do === 'flag') f.on ? k.flags.add(peer) : k.flags.delete(peer);
    else if (f.do === 'mode') k.mode = 1;
    else if (f.do === 'send') k.sent.push({ to: peer, text: G.encode({ op: f.op, id: f.id, from: k.myKey, to: peer, offer: f.offer }) });
    else if (f.do === 'stop') k.polling[peer] = false;
    else if (f.do === 'note') k.notes.push(f.title);
  }
  return r;
}
// deliver everything a sent to b (b's node decrypted it, so it's from a's key)
function deliver(a, b) {
  for (const s of a.sent.splice(0)) {
    const m = G.parse(s.text); if (!m || m.op === 'ACK') continue;
    const bad = G.verify(m, a.myKey, b.myKey);
    if (bad) { b.notes.push('refused: ' + bad); continue; }
    run(b, a.myKey, { type: 'got', msg: m });
  }
}
// does b's node answer a's telemetry request? (MyMesh.cpp onContactRequest, base telemetry)
const answers = (b, aKey) => b.mode === 2 || (b.mode === 1 && b.flags.has(aKey));

section('handshake: A asks (offering), B approves -- both ways granted, both nodes enforce');
{
  const A = kelly(KA), B = kelly(KB);
  run(A, KB, { type: 'ask', offer: true });
  ok(A.grants[KB].out === 'asking' && A.grants[KB].in === 'granted', 'A: asking, offer granted at once');
  ok(A.flags.has(KB) && A.mode === 1, 'A: flag set on A\'s node, mode lowered 2 -> 1');
  deliver(A, B);
  ok(B.grants[KA].in === 'pending' && B.grants[KA].out === 'granted' && B.grants[KA].theyOffered, 'B: pending, and may poll A (offered)');
  ok(B.grants[KA].mutual, 'B: keys confirmed');
  ok(!answers(B, KA) || B.mode === 2, 'B not yet granted A on the device (mode 2 = still open: the gap Kelly closes)');
  run(B, KA, { type: 'approve' });
  ok(B.flags.has(KA) && B.mode === 1, 'B: flag set, mode 1');
  ok(answers(B, KA) && !answers(B, KX), 'B\'s node answers A, refuses a stranger');
  deliver(B, A);
  ok(A.grants[KB].out === 'granted', 'A: may poll B');
  ok(answers(A, KB), 'A\'s node answers B');

  section('revoke either way');
  run(B, KA, { type: 'revokeIn' });
  ok(!B.flags.has(KA) && !answers(B, KA), 'B revokes: B\'s node stops answering A at once');
  deliver(B, A);
  ok(A.grants[KB].out === 'none' && A.polling[KB] === false, 'A stops polling B');
  ok(answers(A, KB) && A.grants[KB].in === 'granted', 'A\'s grant to B is separate and stays');
  run(A, KB, { type: 'revokeIn' });
  ok(!answers(A, KB), 'A revokes B too');
  deliver(A, B);
  ok(B.grants[KA].out === 'none', 'B: may no longer poll A');
}

section('decline: a swap offer is withdrawn');
{
  const A = kelly(KA), B = kelly(KB);
  run(A, KB, { type: 'ask', offer: true }); deliver(A, B);
  run(B, KA, { type: 'decline' });
  ok(B.grants[KA].in === 'none' && B.grants[KA].out === 'none', 'B declines: B drops A\'s offer too');
  deliver(B, A);
  ok(A.grants[KB].out === 'declined' && A.grants[KB].in === 'none' && !A.flags.has(KB), 'A: declined, offer withdrawn, flag cleared');
}

section('ask without offer; DROP clears the other node\'s flag');
{
  const A = kelly(KA), B = kelly(KB); B.mode = 0;
  run(A, KB, { type: 'ask', offer: false });
  ok(!A.flags.has(KB) && A.grants[KB].in === 'none', 'no offer: A\'s node unchanged');
  deliver(A, B);
  ok(B.grants[KA].out === 'none', 'B may not poll A');
  run(B, KA, { type: 'approve' });
  ok(B.mode === 1 && answers(B, KA), 'mode 0 raised to 1 for the grant');
  deliver(B, A);
  run(A, KB, { type: 'dropOut' });
  ok(A.grants[KB].out === 'none', 'A drops');
  deliver(A, B);
  ok(!B.flags.has(KA) && B.grants[KA].in === 'none', 'B\'s node flag cleared on DROP');
}

section('crossing requests, repeats, wrong keys');
{
  const A = kelly(KA), B = kelly(KB);
  run(B, KA, { type: 'ask', offer: false }); deliver(B, A);
  ok(A.grants[KB].in === 'pending', 'A has B\'s request');
  run(A, KB, { type: 'ask', offer: true });
  ok(A.grants[KB].in === 'granted' && A.grants[KB].inReq === null, 'A offering answers B\'s pending request');
  ok(A.sent.some(s => s.text.startsWith('KT1 OK')), 'A sent OK for B\'s request');
  deliver(A, B);
  ok(B.grants[KA].out === 'granted', 'B may poll A');
  // B's Kelly forgot (a new browser) and asks again: A just says yes again
  B.grants = {}; run(B, KA, { type: 'ask', offer: false }); deliver(B, A);
  ok(A.sent.some(s => s.text.startsWith('KT1 OK')) && A.grants[KB].in === 'granted', 'repeat request: OK again, no new pending');
  // a REQ that names a different key for A is refused
  const C = kelly(KX);
  C.sent.push({ to: KA, text: G.encode({ op: 'REQ', id: 'aaaa', from: KX, to: KX, offer: false }) });
  deliver(C, A);
  ok(A.notes.some(n => /refused/.test(n)) && !A.grants[KX], 'wrong receiver fp: refused, no record');
}

section('summary, battery, schedule, health');
{
  const s = G.summary([{ ch: 1, name: 'voltage', value: 3.95, unit: 'V' }, { ch: 1, name: 'temperature', value: 27.5, unit: '°C' }, { ch: 2, name: 'humidity', value: 60, unit: '%' }]);
  ok(s.battV === 3.95 && s.tempC === 27.5 && s.extra.length === 1, 'summary picks channel 1');
  ok(s.pct > 75 && s.pct < 85, 'battery 3.95 V ~ 80%');
  ok(G.battPct(4.25) === 100 && G.battPct(3.2) === 0 && G.battPct(12.6) === null, 'battery bounds');
  const grants = { [KA]: { out: 'granted' }, [KB]: { out: 'asking' }, [KX]: { out: 'granted' } };
  const polls = { [KA]: { on: true, nextAt: 50 }, [KB]: { on: true, nextAt: 10 }, [KX]: { on: true, nextAt: 30 } };
  ok(G.due(polls, grants, 100) === KX, 'due: most overdue granted peer (never an ungranted one)');
  ok(G.due(polls, grants, 20) === null, 'due: nothing yet');
  polls[KX].on = false; ok(G.due(polls, grants, 100) === KA, 'due: stopped peer skipped');
  let h = []; for (let i = 0; i < 120; i++) h = G.pushHist(h, { t: i, ok: i % 4 !== 0, route: i < 60 ? 'aa' : 'bb', trace: { ok: true } });
  ok(h.length === G.HIST_CAP, 'history capped');
  const hl = G.health(h); ok(hl.changes === 1 && hl.answered === 72 && hl.traced === 96, 'health counts');
  ok(G.INTERVALS.every(m => m >= G.MIN_MIN) && G.INTERVALS.includes(G.DEFAULT_MIN), 'intervals respect the floor');
}

section('TR.pathShape / pathList');
{
  ok(TR.pathList(['aa', 'bb', 'cc']).join() === 'aa,bb,cc,bb,aa', 'list turns at the last repeater');
  ok(TR.pathList(['aa']).join() === 'aa', 'one repeater');
  const s = TR.pathShape(['aa', 'bb'], [5, 6, 7], 8);
  ok(s.snrTowards.join() === '5,6,' && s.snrBack.join() === ',7,8', 'snrs mapped; the companion hop unmeasured');
}

// ------------------------------------------------------------ engine 'path' + sim far Kellys (virtual clock)
function clock(start = 1_800_000_000_000) {
  let now = start, seq = 0; const q = new Map();
  const T = { now: () => now, setTimeout(fn, ms) { const id = ++seq; q.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; }, clearTimeout(id) { q.delete(id); },
    setInterval(fn, ms) { const id = ++seq; const e = { at: now + ms, fn: () => { e.at = now + ms; q.set(id, e); fn(); } }; q.set(id, e); return id; }, clearInterval(id) { q.delete(id); } };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  async function advance(ms) {
    const end = now + ms; await flush();
    for (;;) { let nx = null, nid = null; for (const [id, e] of q) if (e.at <= end && (!nx || e.at < nx.at)) { nx = e; nid = id; } if (!nx) break; q.delete(nid); now = nx.at; nx.fn(); await flush(); }
    now = end; await flush();
  }
  return { T, advance };
}

(async () => {
  section('engine path method + sim telemetry gated by grants');
  {
    const { T, advance } = clock();
    const bus = PJ.createBus(), store = new Map();
    const c = { bus, TR, store: { get: (k, d) => store.has(k) ? store.get(k) : d, set: (k, v) => store.set(k, v) }, radio: () => null };
    const sim = Sim(c, { timers: T, loss: 0, seed: 7 });
    Object.assign(c, { nodes: () => sim.nodes(), node: id => sim.nodes().find(n => n.id === id), me: () => sim.me(), resolveHash: () => null,
      driver: () => sim, link: () => ({ online: true, via: 'demo' }) });
    const eng = Engine(c, { timers: T, retryMs: 100 });
    const bravo = sim.nodes().find(n => n.name === 'VK4ZB Bravo mobile'), romeo = sim.nodes().find(n => n.name === 'VK4ZR Romeo');
    const rpt = sim.nodes().find(n => n.role === 'repeater');
    ok(/companions/.test(eng.canTrace(rpt.id, { method: 'path' }) || ''), 'path refuses a repeater');
    ok(/direct neighbour/.test(eng.canTrace(romeo.id, { method: 'path' }) || ''), 'path: a direct neighbour has nothing to trace');
    // Bravo's route is 1-byte hashes; the engine must upgrade them (they each match one repeater) or refuse
    const why = eng.canTrace(bravo.id, { method: 'path' });
    let done = null; bus.on('done', r => { done = r; });
    if (why) ok(false, 'path to Bravo should be possible: ' + why);
    else {
      const r = eng.trace(bravo.id, { method: 'path' }); ok(r.ok, 'path run starts');
      await advance(30000);
      ok(done && done.status === 'success' && done.method === 'path', 'path run succeeds');
      ok(done && done.out[done.out.length - 1].snr === null && done.out[1].snr != null, 'repeater hop has SNR, the companion hop none');
      ok(done && done.back[done.back.length - 1].snr != null, 'our node heard the return');
    }
    let tel = null, terr = null;
    sim.telemetry(bravo).then(x => { tel = x; }, e => { terr = e; });
    await advance(15000);
    ok(!tel && terr && terr.code === 'timeout', 'no grant: the sim node stays silent');
    const got = []; sim.onData((key, text) => got.push({ key, text: text }));
    const me = sim.me().key;
    sim.sendData(bravo, G.encode({ op: 'REQ', id: 'beef01', from: me, to: bravo.key, offer: false }));
    await advance(10000);
    const ms = got.map(x => G.parse(x.text));
    ok(ms.some(m => m.op === 'ACK' && m.id === 'beef01'), 'far Kelly ACKs');
    const okm = ms.find(m => m.op === 'OK');
    ok(okm && G.verify(okm, bravo.key, me) === null, 'far Kelly approves with the right fingerprints');
    tel = null; sim.telemetry(bravo).then(x => { tel = x; }, () => {});
    await advance(15000);
    ok(tel && G.summary(tel.lpp).battV > 3 && tel.rx && tel.rx.snr != null, 'granted: telemetry answers with battery + reply SNR');
    const gc = sim.nodes().find(n => n.name === 'VK4ZQ Gold Coast'); got.length = 0;
    sim.sendData(gc, G.encode({ op: 'REQ', id: 'beef02', from: me, to: gc.key, offer: false }));
    await advance(10000);
    ok(got.some(x => G.parse(x.text).op === 'NO'), 'the other far Kelly declines');
    got.length = 0; sim.sendData(romeo, G.encode({ op: 'REQ', id: 'beef03', from: me, to: romeo.key, offer: false }));
    await advance(10000);
    ok(!got.length, 'no Kelly there: silence');
    sim.stop(); eng.destroy && eng.destroy();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? `RESULT: FAIL (${fail})` : 'RESULT: ALL PASS');
})();
