/* Kelly Page -- Trace Route engine + sim test (Node, virtual time).
 * Run: ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" tests/tr-engine-test.js
 * Prints RESULT: ALL PASS / RESULT: FAIL (n).
 */
'use strict';
const path = require('path');
const PJ = require(path.join(__dirname, '../js/pj-core.js'));
const TR = require(path.join(__dirname, '../js/tr-core.js'));
const Engine = require(path.join(__dirname, '../js/tr-engine.js'));
const Sim = require(path.join(__dirname, '../js/tr-sim.js'));

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log('  FAIL:', name); } };
const section = s => console.log('--', s);

// ------------------------------------------------------------ virtual clock
function clock(start = 1_800_000_000_000) {
  let now = start, seq = 0;
  const q = new Map();
  const T = {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; q.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; },
    clearTimeout(id) { q.delete(id); },
    setInterval(fn, ms) { const id = ++seq; const e = { at: now + ms, fn: () => { e.at = now + ms; q.set(id, e); fn(); }, every: ms }; q.set(id, e); return id; },
    clearInterval(id) { q.delete(id); },
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  async function advance(ms) {
    const end = now + ms;
    await flush();
    for (;;) {
      let best = null, bid = null;
      for (const [id, e] of q) if (e.at <= end && (!best || e.at < best.at)) { best = e; bid = id; }
      if (!best) break;
      q.delete(bid); now = Math.max(now, best.at); best.fn(); await flush();
    }
    now = end; await flush();
  }
  return { T, advance, flush, get now() { return now; } };
}

function memStore() { const m = new Map(); return { get: (k, d) => m.has(k) ? JSON.parse(m.get(k)) : d, set: (k, v) => m.set(k, JSON.stringify(v)), _m: m }; }

// a station list: repeaters r0..r39 (with routes), a companion, a keyless one, a repeater with no route
function mkNodes() {
  const key = i => (i.toString(16).padStart(2, '0') + 'ab').repeat(16);
  const out = [];
  for (let i = 0; i < 40; i++) out.push({ id: key(i), key: key(i), num: i, name: `R${i}`, role: 'repeater', lat: -27.5, lon: 152.9, hops: 2,
    outPath: { sz: 2, h: ['a1b1', 'b2c2'] }, inbound: null, canTrace: true, canDiscover: true, why: null });
  out.push({ id: key(200), key: key(200), name: 'Comp', role: 'companion', hops: 1, outPath: { sz: 2, h: ['a1b1'] }, canTrace: false, canDiscover: true, why: 'not a repeater' });
  out.push({ id: 'num:9', key: null, name: 'Nokey', role: 'repeater', hops: null, canTrace: false, canDiscover: false, why: 'only heard by name' });
  out.push({ id: key(201), key: key(201), name: 'Lost', role: 'repeater', hops: null, outPath: null, inbound: null, canTrace: true, canDiscover: true, why: null });
  out.push({ id: key(202), key: key(202), name: 'Rev', role: 'room', hops: 2, outPath: null, inbound: { sz: 2, h: ['c3e3', 'd4e4'], t: 0 }, canTrace: true, canDiscover: true, why: null });
  out.push({ id: key(203), key: key(203), name: 'Near', role: 'repeater', hops: 0, outPath: null, inbound: null, canTrace: true, canDiscover: true, why: null });
  return out;
}

// a controllable fake Driver
function fakeDriver(clk, via = 'live') {
  const d = {
    via, calls: [], plan: [],   // plan: queue of { kind: 'ok'|'timeout'|'never'|'error', ms }
    nodes: () => [], me: () => ({ id: 'me', name: 'Me', lat: -27.6, lon: 152.7, hashSize: 1 }),
    next() { return d.plan.length ? d.plan.shift() : { kind: 'ok', ms: 3000 }; },
    trace(node, route) {
      d.calls.push(['trace', node.id, route]);
      const p = d.next(), h = route && route.h ? route.h : [];
      return new Promise((res, rej) => {
        if (p.kind === 'never') return;
        clk.T.setTimeout(() => {
          if (p.kind === 'ok') res({ out: h.slice(), back: h.slice().reverse(), snrTowards: h.map((_, i) => 5 - i).concat([2]), snrBack: h.map((_, i) => 3 - i).concat([-4]), ms: p.ms });
          else rej(Object.assign(new Error(p.kind === 'timeout' ? 'no trace answer' : 'boom'), { code: p.kind }));
        }, p.ms);
      });
    },
    discover(node) {
      d.calls.push(['discover', node.id]);
      const p = d.next();
      return new Promise((res, rej) => {
        if (p.kind === 'never') return;
        clk.T.setTimeout(() => {
          if (p.kind === 'ok') res({ out: { sz: 2, h: ['e5e5', 'f6f6'] }, back: { sz: 2, h: ['f6f6', 'e5e5'] }, ms: p.ms });
          else rej(Object.assign(new Error('no answer'), { code: p.kind }));
        }, p.ms);
      });
    },
  };
  return d;
}

function mkCtx(clk, opts = {}) {
  const bus = PJ.createBus(), store = opts.store || memStore();
  let nodes = opts.nodes || mkNodes(), demo = !!opts.demo, drv = opts.driver;
  const c = {
    bus, PJ, TR, store,
    nodes: () => nodes, node: id => nodes.find(n => n.id === id), me: () => (drv && drv.me ? drv.me() : { id: 'me', name: 'Me', hashSize: 1 }),
    resolveHash: h => nodes.find(n => n.key && n.key.startsWith(h) && n.role === 'repeater') || null,
    radio: () => ({ sf: 8, bwKHz: 62.5, cr: 5 }), demo: () => demo, driver: () => drv,
    link: () => ({ online: !!drv, via: drv ? drv.via : 'none', why: drv ? null : 'no link' }),
    _set(o) { if ('driver' in o) drv = o.driver; if ('demo' in o) demo = o.demo; if (o.nodes) nodes = o.nodes; },
  };
  const ev = [];
  bus.on('run', r => ev.push(['run', r])); bus.on('done', r => ev.push(['done', r])); bus.on('limit', l => ev.push(['limit', l]));
  return { c, ev, store };
}
const runs = (ev, id) => ev.filter(e => e[0] === 'run' && (!id || e[1].id === id)).map(e => e[1]);
const dones = (ev, id) => ev.filter(e => e[0] === 'done' && (!id || e[1].id === id)).map(e => e[1]);

(async () => {
  // ---------------------------------------------------------------- 1. success, event order
  {
    section('success trace: event order');
    const clk = clock(), drv = fakeDriver(clk), { c, ev } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    const nodes = c.nodes(), r0 = nodes[0];
    ok(E.canTrace(r0.id, { method: 'auto' }) === null, 'canTrace null for a traceable repeater');
    const res = E.trace(r0.id, { method: 'auto' });
    ok(res.ok && res.id === 'tr-1', 'trace() ok with id');
    ok(E.current() && E.current().status === 'pending' && E.current().phase === 'queued', 'queued at once');
    await clk.advance(10000);
    const ph = runs(ev, res.id).map(r => r.phase);
    const order = ['queued', 'sending', 'outbound', 'returning', 'done'];
    ok(order.every((p, i) => ph.indexOf(p) >= 0 && (i === 0 || ph.indexOf(p) > ph.indexOf(order[i - 1]))), 'phases in order: ' + ph.join(','));
    const d = dones(ev, res.id);
    ok(d.length === 1 && d[0].status === 'success', 'done once, success');
    const r = d[0];
    ok(r.method === 'trace' && r.pathSource === 'learned' && r.tries === 2 && r.attempt === 1, 'method/source/tries');
    ok(r.out.length === 4 && r.out[0].id === 'me' && r.out[3].id === r0.id && r.back.length === 4 && r.back[3].id === 'me', 'out/back hops shape');
    ok(r.out[1].snr === 5 && r.out[3].snr === 2 && r.back[3].snr === -4 && r.out[0].snr === null, 'hop SNRs mapped');
    ok(r.out[1].known === false && r.out[1].id === 'h:a1b1', 'unresolved hash = nameless star');
    ok(r.snrMin === -4 && r.rttMs === 3000 && r.pathKey === 'a1b1.b2c2' && r.changed === null, 'snrMin/rtt/pathKey/changed null');
    ok(r.out[2].estMs > r.out[1].estMs && r.back[3].estMs > r.out[3].estMs, 'estMs increase along the route');
    ok(Object.isFrozen(r) && Object.isFrozen(r.out[0]), 'frozen runs');
    ok(E.current() === r, 'current() = the finished run');
    // same route again (after the gap): changed false; different route: changed true
    await clk.advance(61000);
    E.trace(r0.id, {}); await clk.advance(10000);
    ok(dones(ev).pop().changed === false, 'same route -> changed false');
    nodes[0].outPath = { sz: 2, h: ['a1b1'] };
    await clk.advance(61000);
    E.trace(r0.id, {}); await clk.advance(10000);
    ok(dones(ev).pop().changed === true, 'new route -> changed true');
    // reverse + direct route choice
    const rev = nodes.find(n => n.name === 'Rev'), near = nodes.find(n => n.name === 'Near');
    E.trace(rev.id, {}); await clk.advance(10000);
    let lr = dones(ev).pop();
    ok(lr.pathSource === 'reverse' && lr.pathKey === 'd4e4.c3e3', 'reverse of inbound: ' + lr.pathKey);
    E.trace(near.id, {}); await clk.advance(10000);
    lr = dones(ev).pop();
    ok(lr.pathSource === 'direct' && lr.out.length === 2 && lr.status === 'success', 'zero hops for a direct neighbour');
    ok(JSON.stringify(drv.calls[drv.calls.length - 1][2]) === JSON.stringify({ sz: 2, h: [] }), 'zero-hop route passed as h: [] (2-byte)');
    E.destroy();
  }

  // ---------------------------------------------------------------- 2. auto -> discover -> trace; companion; refusals
  {
    section('auto: discover then trace');
    const clk = clock(), drv = fakeDriver(clk), { c, ev } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    const lost = c.nodes().find(n => n.name === 'Lost');
    drv.plan = [{ kind: 'ok', ms: 4000 }, { kind: 'ok', ms: 2500 }];
    const res = E.trace(lost.id, { method: 'auto' });
    ok(res.ok && runs(ev, res.id)[0].method === 'discover', 'auto starts as a discovery');
    await clk.advance(30000);
    const rs = runs(ev, res.id), d = dones(ev, res.id);
    ok(rs.some(r => r.method === 'discover' && r.phase === 'sending') && rs.some(r => r.method === 'trace' && r.phase === 'sending'), 'method moves discover -> trace');
    ok(d.length === 1 && d[0].status === 'success' && d[0].method === 'trace' && d[0].pathSource === 'discovered', 'done success, traced the discovered route');
    ok(d[0].pathKey === 'e5e5.f6f6' && d[0].snrMin != null && drv.calls.map(x => x[0]).join() === 'discover,trace', 'traced e5e5.f6f6 with SNRs');
    ok(E.limits().used.flood10 === 1 && E.limits().used.tenMin === 1, 'counted once, one flood');
    // follow-up trace fails twice -> still success with the discovered route
    await clk.advance(310000);
    drv.plan = [{ kind: 'ok', ms: 4000 }, { kind: 'timeout', ms: 9000 }, { kind: 'timeout', ms: 9000 }];
    E.trace(lost.id, {}); await clk.advance(60000);
    const d2 = dones(ev).pop();
    ok(d2.status === 'success' && d2.method === 'discover' && d2.snrMin === null && /no answer/.test(d2.note), 'discovered route kept when its trace is lost');
    // discovery silent -> no-path, never retried
    const comp = c.nodes().find(n => n.name === 'Comp');
    ok(/repeater/.test(E.canTrace(comp.id, { method: 'trace' }) || ''), 'explicit trace on a companion refused');
    drv.plan = [{ kind: 'timeout', ms: 25000 }]; drv.calls.length = 0;
    const rc = E.trace(comp.id, { method: 'auto' });
    ok(rc.ok && runs(ev, rc.id)[0].method === 'discover', 'companion -> discover');
    await clk.advance(40000);
    const d3 = dones(ev, rc.id);
    ok(d3.length === 1 && d3[0].status === 'no-path' && drv.calls.length === 1, 'silent discovery -> no-path, no retry');
    ok(/name|advert/.test(E.canTrace('num:9', {}) || ''), 'no key -> refused with a reason');
    ok(E.trace('num:9', {}).ok === false, 'trace() refuses no-key');
    ok(/not in the list/.test(E.canTrace('nope', {})), 'unknown id refused');
    ok(/no route/.test(E.canTrace(lost.id, { method: 'trace' }) || 'x') || /once|every|again/.test(E.canTrace(lost.id, { method: 'trace' }) || ''), 'explicit trace with no route refused');
    c._set({ driver: null });
    ok(E.canTrace(c.nodes()[5].id, {}) === 'no link', 'no driver -> link().why');
    E.destroy();
  }

  // ---------------------------------------------------------------- 3. timeout + one retry
  {
    section('timeout and retry');
    const clk = clock(), drv = fakeDriver(clk), { c, ev } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    const n = c.nodes()[1];
    drv.plan = [{ kind: 'timeout', ms: 8000 }, { kind: 'ok', ms: 2000 }];
    const r = E.trace(n.id, {});
    await clk.advance(9000);
    const mid = E.current();
    ok(mid.status === 'pending' && mid.attempt === 2 && mid.phase === 'queued' && /again/.test(mid.note), 'retry announced: attempt 2');
    ok(drv.calls.length === 1, 'retry waits ~3 s');
    await clk.advance(3100);
    ok(drv.calls.length === 2, 'second try sent after 3 s');
    await clk.advance(5000);
    let d = dones(ev, r.id);
    ok(d.length === 1 && d[0].status === 'success' && d[0].attempt === 2, 'success on try 2');
    await clk.advance(61000);
    drv.plan = [{ kind: 'timeout', ms: 8000 }, { kind: 'timeout', ms: 8000 }, { kind: 'ok', ms: 100 }];
    const r2 = E.trace(n.id, {});
    await clk.advance(30000);
    d = dones(ev, r2.id);
    ok(d.length === 1 && d[0].status === 'timeout' && d[0].attempt === 2 && drv.calls.length === 4 && /lost somewhere/.test(d[0].error), 'two timeouts -> timeout, no third try');
    // a driver error: no retry
    await clk.advance(61000);
    drv.plan = [{ kind: 'error', ms: 500 }];
    const r3 = E.trace(n.id, {}); await clk.advance(5000);
    d = dones(ev, r3.id);
    ok(d.length === 1 && d[0].status === 'error' && d[0].error === 'boom' && drv.calls.length === 5, 'error -> settled, no retry');
    E.destroy();
  }

  // ---------------------------------------------------------------- 4. cancel mid-flight
  {
    section('cancel');
    const clk = clock(), drv = fakeDriver(clk), { c, ev } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    drv.plan = [{ kind: 'ok', ms: 5000 }];
    const r = E.trace(c.nodes()[2].id, {});
    await clk.advance(1500);
    ok(E.trace(c.nodes()[3].id, {}).ok === false, 'second run refused while one is pending');
    ok(E.cancel('tr-999') === false, 'cancel(other id) does nothing');
    ok(E.cancel() === true, 'cancel() true');
    let d = dones(ev, r.id);
    ok(d.length === 1 && d[0].status === 'cancelled' && E.current().status === 'cancelled', 'settled cancelled at once');
    const n0 = ev.length;
    await clk.advance(10000);
    ok(ev.filter(e => e[0] !== 'limit').length === n0 - ev.slice(0, n0).filter(e => e[0] === 'limit').length && dones(ev, r.id).length === 1, 'late driver answer ignored');
    ok(runs(ev, r.id).every(x => x.status !== 'success'), 'never success after cancel');
    // cancel during the retry wait
    drv.plan = [{ kind: 'timeout', ms: 8000 }];
    const r2 = E.trace(c.nodes()[3].id, {}); await clk.advance(9000);
    ok(E.current().attempt === 2, 'in retry wait');
    E.cancel(r2.id); await clk.advance(10000);
    ok(dones(ev, r2.id).length === 1 && drv.calls.length === 2, 'cancel in retry wait: no second send');
    E.destroy();
  }

  // ---------------------------------------------------------------- 5. guard timeout (driver never answers)
  {
    section('guard timeout');
    const clk = clock(), drv = fakeDriver(clk), { c, ev } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    drv.plan = [{ kind: 'never' }, { kind: 'never' }];
    const r = E.trace(c.nodes()[4].id, {});
    const g = runs(ev, r.id).find(x => x.phase === 'sending') || (await clk.advance(1), runs(ev, r.id).find(x => x.phase === 'sending'));
    ok(g && g.timeoutMs >= 13000 && g.timeoutMs <= 70000, 'guard = driver wait + 5 s, <= 70 s: ' + (g && g.timeoutMs));
    await clk.advance(150000);
    const d = dones(ev, r.id);
    ok(d.length === 1 && d[0].status === 'timeout' && d[0].attempt === 2, 'guard settled it (after one retry)');
    ok(d[0].endedAt - d[0].t0 <= 2 * 70000 + 3500, 'never longer than 2 guards + retry gap');
    ok(E.current().status !== 'pending', 'nothing left pending');
    // discovery guard
    drv.plan = [{ kind: 'never' }];
    const rd = E.trace(c.nodes().find(n => n.name === 'Lost').id, { method: 'discover' });
    await clk.advance(80000);
    const dd = dones(ev, rd.id);
    ok(dd.length === 1 && dd[0].status === 'no-path' && dd[0].timeoutMs <= 70000, 'discovery guard -> no-path');
    E.destroy();
  }

  // ---------------------------------------------------------------- 6. rate limits
  {
    section('rate limits (live)');
    const clk = clock(), drv = fakeDriver(clk), store = memStore(), { c, ev } = mkCtx(clk, { driver: drv, store }), E = Engine(c, { timers: clk.T });
    const N = c.nodes(), go = async (id, o) => { const r = E.trace(id, o || {}); await clk.advance(6000); return r; };
    drv.plan = Array(200).fill({ kind: 'ok', ms: 1000 });
    ok((await go(N[0].id)).ok, 'first trace ok');
    const again = E.trace(N[0].id, {});
    ok(!again.ok && /every 60 s/.test(again.reason), 'same target within 60 s refused: ' + again.reason);
    ok(ev.some(e => e[0] === 'limit' && e[1].perTarget[N[0].id] > clk.now), 'limit emitted with perTarget');
    await clk.advance(55000);
    ok((await go(N[0].id)).ok, 'same target ok after 60 s');
    for (let i = 1; i <= 8; i++) ok((await go(N[i].id)).ok, `run ${i + 2} of 10 ok`);
    const t11 = E.trace(N[9].id, {});
    ok(!t11.ok && /10 traces in the last 10 minutes/.test(t11.reason), '11th in 10 min refused: ' + t11.reason);
    ok(!E.limits().ok && E.limits().used.tenMin === 10 && E.limits().nextAt > clk.now, 'limits() blocked with nextAt');
    const nLim = ev.filter(e => e[0] === 'limit').length;
    await clk.advance(10000);
    ok(ev.filter(e => e[0] === 'limit').length >= nLim + 2, "'limit' re-emitted every 5 s while blocked");
    await clk.advance(600000);
    ok(E.limits().ok, 'free again after 10 min');
    // 30 per hour: 10 + 10 more spread out, then 10 more after the window -> 30th, 31st refused
    for (let i = 9; i < 19; i++) ok((await go(N[i].id)).ok, `hour run ${i + 2}`);
    await clk.advance(600000);
    for (let i = 19; i < 29; i++) { const r = await go(N[i].id); if (!r.ok) console.log('   ', r.reason); ok(r.ok, `hour run ${i + 2}`); }
    await clk.advance(600000);
    const h31 = E.trace(N[29].id, {});
    ok(!h31.ok && /30 traces in the last hour/.test(h31.reason), '31st in an hour refused: ' + h31.reason);
    // floods: 3 per 10 min (fresh store)
    section('flood limits');
    const clk2 = clock(), drv2 = fakeDriver(clk2), x = mkCtx(clk2, { driver: drv2 }), E2 = Engine(x.c, { timers: clk2.T });
    drv2.plan = Array(50).fill({ kind: 'ok', ms: 1000 });
    const M = x.c.nodes(), go2 = async (id, o) => { const r = E2.trace(id, o); await clk2.advance(6000); return r; };
    for (let i = 0; i < 3; i++) ok((await go2(M[i].id, { method: 'discover' })).ok, `flood ${i + 1} ok`);
    const f4 = E2.trace(M[3].id, { method: 'discover' });
    ok(!f4.ok && /3 path discoveries/.test(f4.reason), '4th flood in 10 min refused: ' + f4.reason);
    ok((await go2(M[3].id, { method: 'trace' })).ok, 'a trace still allowed while floods are capped');
    await clk2.advance(600000);
    ok((await go2(M[0].id, { method: 'discover' })).ok, 'flood ok after 10 min');
    await clk2.advance(70000);
    const f5 = E2.trace(M[0].id, { method: 'discover' });
    ok(!f5.ok && /one per station every 5 min/.test(f5.reason), 'same-target discovery within 5 min refused: ' + f5.reason);
    ok(!!E2.trace(M[0].id, { method: 'trace' }).ok, 'but a trace to it is fine after 60 s');
    await clk2.advance(10000);
    E2.destroy();

    section('limits persist across a new engine');
    E.destroy();
    const E3 = Engine(mkCtx(clk, { driver: drv, store }).c, { timers: clk.T });
    ok(E3.limits().used.hour === 30 && !E3.limits().ok, 'a new engine on the same store is still blocked');
    ok(/30 traces/.test(E3.canTrace(N[35].id, {}) || ''), 'canTrace gives the reason');
    ok(Array.isArray(store.get('trLimits').live) && store.get('trLimits').live.length <= 200, 'stored compact and capped');
    E3.destroy();

    section('demo limits are looser');
    const clk4 = clock(), drv4 = fakeDriver(clk4, 'demo'), y = mkCtx(clk4, { driver: drv4, demo: true, store }), E4 = Engine(y.c, { timers: clk4.T });
    drv4.plan = Array(80).fill({ kind: 'ok', ms: 1000 });
    ok(E4.limits().used.hour === 0 && E4.limits().mode === 'demo', 'demo counters are separate from live');
    let allOk = true; for (let i = 0; i < 15; i++) { const r = E4.trace(y.c.nodes()[i].id, {}); await clk4.advance(4000); if (!r.ok) allOk = false; }
    ok(allOk, '15 demo runs in a minute allowed');
    ok(E4.trace(y.c.nodes()[14].id, {}).ok === false, 'demo same-target gap still applies');
    await clk4.advance(9000);
    ok(E4.trace(y.c.nodes()[14].id, {}).ok, 'demo same-target ok after 8 s');
    await clk4.advance(5000);
    for (let i = 15; i < 30; i++) { E4.trace(y.c.nodes()[i].id, {}); await clk4.advance(3000); }
    const cap = E4.trace(y.c.nodes()[31].id, {});
    ok(!cap.ok && /30 traces in the last 10 minutes/.test(cap.reason), 'demo still capped (30 / 10 min): ' + cap.reason);
    E4.destroy();
  }

  // ---------------------------------------------------------------- 7. done exactly once, everywhere
  {
    section('done once per run, destroy');
    const clk = clock(), drv = fakeDriver(clk), { c, ev } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    drv.plan = [{ kind: 'never' }];
    const r = E.trace(c.nodes()[7].id, {});
    await clk.advance(1000);
    E.destroy();
    ok(dones(ev, r.id).length === 1 && dones(ev, r.id)[0].status === 'cancelled', 'destroy settles a pending run');
    ok(E.trace(c.nodes()[8].id, {}).ok === false, 'trace refused after destroy');
    await clk.advance(200000);
    ok(dones(ev, r.id).length === 1, 'no second done');
  }

  // ---------------------------------------------------------------- 8. the sim (Driver contract) + engine on it
  {
    section('sim');
    const clk = clock(), store = memStore();
    const x = mkCtx(clk, { store }), c = x.c;
    const S = Sim(c, { timers: clk.T, loss: 0, rand: (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })() });
    c._set({ driver: S, demo: true, nodes: S.nodes() });
    c.nodes = () => S.nodes(); c.node = id => S.nodes().find(n => n.id === id);
    c.resolveHash = h => { const all = S.nodes().filter(n => n.key.startsWith(h)), f = all.filter(n => n.role === 'repeater' || n.role === 'room'); return f.length === 1 ? f[0] : !f.length && all.length === 1 ? all[0] : null; };
    const N = S.nodes(), by = s => N.find(n => n.name.startsWith(s));
    ok(S.via === 'demo' && N.length >= 12 && N.every(n => /^[0-9a-f]{64}$/.test(n.key)), '12+ stations with 32-byte keys');
    ok(new Set(N.map(n => n.role)).size >= 4, 'mixed roles');
    const rp = N.filter(n => n.role === 'repeater' || n.role === 'room').map(n => n.key.slice(0, 2));
    ok(rp.length - new Set(rp).size === 1, 'exactly one 1-byte hash collision among repeaters');
    ok(N.every(n => n.lat < -26 && n.lat > -28.5 && n.lon > 151 && n.lon < 153.6 && n.km != null), 'all in SEQ with km');
    ok(N.some(n => n.outPath) && N.some(n => !n.outPath && n.inbound) && N.some(n => !n.outPath && !n.inbound), 'learned / inbound-only / unknown routes');
    const me = S.me(); ok(me.id === 'me' && me.hashSize === 2, 'me(): a 2-byte node (SEQ)');
    // a direct trace to Springbrook (via Flinders)
    const sb = by('Springbrook');
    let got = null; S.trace(sb, sb.outPath).then(r => got = r, e => got = e);
    await clk.advance(15000);
    ok(got && got.out && got.out.length === 1 && got.snrTowards.length === 2 && got.snrBack.length === 2 && got.ms > 500 && got.ms < 10000, 'sim trace shape, RTT ' + (got && got.ms) + ' ms');
    ok(got.snrTowards.concat(got.snrBack).every(v => v >= -14 && v <= 13), 'SNRs in range');
    // unreachable
    got = null; const bu = by('Bunya'); S.trace(bu, bu.outPath).then(r => got = r, e => got = e);
    await clk.advance(15000);
    ok(got instanceof Error && got.code === 'timeout', 'unreachable station: timeout');
    // companion refusing telemetry
    got = null; S.discover(by('VK4ZR')).then(r => got = r, e => got = e); await clk.advance(15000);
    ok(got instanceof Error && got.code === 'timeout', "Romeo's companion: silent discovery");
    // one discovery at a time
    let g1 = null, g2 = null; S.discover(by('VK4ZB')).then(r => g1 = r, e => g1 = e); S.discover(by('VK4ZQ')).then(r => g2 = r, e => g2 = e);
    await clk.advance(15000);
    ok(g1 instanceof Error && g1.code === 'cancelled' && g2 && g2.out && g2.out.h.length === 2, 'a second discovery replaces the first');
    ok(await S.trace(by('VK4ZB'), null).then(() => false, e => e.code === 'error'), 'trace to a companion rejected');
    // the engine on the sim: auto on Buderim (no route, logged in) -> discover -> trace
    const E = Engine(c, { timers: clk.T });
    const bd = by('Buderim'); ok(!bd.outPath && !bd.inbound, 'Buderim starts with no route');
    const r = E.trace(bd.id, { method: 'auto' });
    await clk.advance(60000);
    const d = dones(x.ev, r.id)[0];
    ok(d && d.status === 'success' && d.method === 'trace' && d.pathSource === 'discovered' && d.out.length === 4 && d.snrMin != null, 'engine+sim auto: discovered then traced, ' + (d && `${d.out.map(h => h.name).join(' > ')} rtt ${d.rttMs}`));
    ok(d.out[1].known && d.out[1].name === 'Mt Coot-tha Rpt', 'hops named via resolveHash');
    ok(S.nodes().find(n => n.id === bd.id).outPath, 'the discovery taught the sim its route');
    // collision: Tamborine's route goes through Flinders, which shares Tamborine's 1-byte hash -> Kelly won't guess: refused
    await clk.advance(10000);
    const tw = S._world.find(s => s.name.startsWith('Tamborine')); if (tw.via[0] !== 0) { const v = tw.via; tw.via = tw.alt; tw.alt = v; }
    const tb = by('Tamborine');
    const r2 = E.trace(tb.id, { method: 'trace' });
    ok(!r2.ok && /shared by 2 repeaters/.test(r2.reason || ''), 'colliding 1-byte hop -> trace refused: ' + r2.reason);
    // 10% loss default: over many traces some are lost, most not
    const S2 = Sim(c, { timers: clk.T });
    let lostN = 0, okN = 0; const fl = S2.nodes().find(n => n.name.startsWith('VK4RBX'));
    for (let i = 0; i < 100; i++) { S2.trace(fl, { sz: 1, h: [] }).then(() => okN++, () => lostN++); }
    await clk.advance(20000);
    ok(lostN + okN === 100 && lostN >= 3 && lostN <= 22, `~10% trace loss (${lostN}/100)`);
    // start / stop: background life, and stop rejects pending answers
    S2.start(); const lh0 = Math.max(...S2.nodes().map(n => n.lastHeard)); await clk.advance(30000);
    ok(Math.max(...S2.nodes().map(n => n.lastHeard)) > lh0, 'start(): stations are heard over time');
    let pr = null; S2.trace(fl, null).then(r => pr = r, e => pr = e); S2.stop(); await clk.flush();
    ok(pr instanceof Error && pr.code === 'cancelled', 'stop() rejects pending answers as cancelled');
    S2.destroy(); E.destroy(); S.destroy();
  }

  // ---------------------------------------------------------------- review fixes (2026-10-24)
  {
    section('storage that never saves: the caps still hold (in-memory log)');
    const clk = clock(), drv = fakeDriver(clk), dead = { get: (k, d) => d, set() {} }, { c, ev } = mkCtx(clk, { driver: drv, store: dead }), E = Engine(c, { timers: clk.T });
    const r0 = c.nodes()[0];
    let started = 0;
    for (let i = 0; i < 50; i++) { if (E.trace(r0.id, {}).ok) started++; await clk.advance(4000); }
    ok(started <= 4, `same station over 200 s with dead storage: ${started} runs (gap 60 s from each run's end)`);
    let n = 0; for (let i = 1; i < 30; i++) { if (E.trace(c.nodes()[i].id, {}).ok) n++; await clk.advance(5000); }
    ok(n + started <= 10 + 1, `10 per 10 min holds with dead storage (${n + started})`);
    E.destroy();
  }
  {
    section('per-station gap runs from the end of a slow run');
    const clk = clock(), drv = fakeDriver(clk), { c } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T, retryMs: 3000 });
    const r0 = c.nodes()[0];
    drv.plan.push({ kind: 'timeout', ms: 40000 }, { kind: 'timeout', ms: 40000 });
    E.trace(r0.id, {}); await clk.advance(90000);
    ok(E.current().status === 'timeout', 'slow run timed out after the retry');
    ok(!!E.canTrace(r0.id, {}), 'same station refused right after a slow run ends');
    await clk.advance(61000);
    ok(E.canTrace(r0.id, {}) === null, 'allowed 60 s after it ended');
    E.destroy();
  }
  {
    section('live traces: the guard waits for the driver (no retry while the first is in flight)');
    const clk = clock(), drv = fakeDriver(clk), { c } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    drv.plan.push({ kind: 'ok', ms: 50000 });
    E.trace(c.nodes()[0].id, {}); await clk.advance(55000);
    ok(drv.calls.length === 1 && E.current().status === 'success', `a 50 s answer is taken, not retried (${drv.calls.length} sends, ${E.current().status})`);
    E.destroy();
  }
  {
    section('sim-link runs use the demo budget');
    const clk = clock(), drv = fakeDriver(clk, 'sim-link'), store = memStore(), { c } = mkCtx(clk, { driver: drv, store }), E = Engine(c, { timers: clk.T });
    E.trace(c.nodes()[0].id, {}); await clk.advance(10000);
    const st = store.get('trLimits', {});
    ok(st.live.length === 0 && st.demo.length === 1, 'sim-link run logged under demo');
    ok(E.limits().mode === 'demo', 'limits() shows the demo caps on the sim link');
    E.destroy();
  }
  {
    section('claim(): the old Trace button + Mesh Paths share the budget');
    const clk = clock(), drv = fakeDriver(clk), { c } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    const r0 = c.nodes()[0], r1 = c.nodes()[1];
    ok(E.claim(r0.id, 'trace', 'live') === null, 'first claim allowed');
    ok(!!E.claim(r0.id, 'trace', 'live'), 'second claim for the same station refused');
    ok(!!E.canTrace(r0.id, {}), 'the tab sees the claim');
    ok(E.claim(r1.id, 'discover') === null && E.claim(c.nodes()[2].id, 'discover') === null && E.claim(c.nodes()[3].id, 'discover') === null, '3 floods allowed');
    ok(/discover/i.test(E.claim(c.nodes()[4].id, 'discover') || ''), '4th flood in 10 min refused');
    await clk.advance(700000);
    drv.plan.push({ kind: 'never' });
    E.trace(c.nodes()[5].id, { method: 'discover' }); await clk.advance(100);
    ok(/one at a time/.test(E.claim(c.nodes()[6].id, 'discover') || ''), 'no outside discovery while ours waits (one slot on the node)');
    E.destroy();
  }
  {
    section('cancel(id, reason): link lost settles as an error');
    const clk = clock(), drv = fakeDriver(clk), { c } = mkCtx(clk, { driver: drv }), E = Engine(c, { timers: clk.T });
    drv.plan.push({ kind: 'never' });
    E.trace(c.nodes()[0].id, {}); await clk.advance(500);
    ok(E.cancel(null, 'link lost') && E.current().status === 'error' && E.current().error === 'link lost', 'error "link lost"');
    E.destroy();
  }

  // ---------------------------------------------------------------- 1-byte hashes + ping (2026-10-24)
  {
    section('route2: 1-byte hops only when they name ONE known repeater');
    const ks = ['a1aa' + '0'.repeat(60), 'b2bb' + '0'.repeat(60), 'b2cc' + '0'.repeat(60)];
    const u = TR.route2({ sz: 1, h: ['a1'] }, ks);
    ok(u.route && u.route.sz === 2 && u.route.h[0] === 'a1aa' && u.upgraded === 1, 'unique 1-byte hop -> 2 bytes of its key');
    ok(/shared by 2/.test(TR.route2({ sz: 1, h: ['a1', 'b2'] }, ks).reason || ''), 'shared 1-byte hop refused');
    ok(/matches no repeater/.test(TR.route2({ sz: 1, h: ['c3'] }, ks).reason || ''), 'unknown 1-byte hop refused');
    ok(JSON.stringify(TR.route2({ sz: 3, h: ['a1aabb'] }, ks).route) === JSON.stringify({ sz: 2, h: ['a1aa'] }), '3-byte hop kept as its first 2 bytes');
    ok(JSON.stringify(TR.route2({ sz: 1, h: [] }, ks).route) === JSON.stringify({ sz: 2, h: [] }), 'zero hops -> 2-byte');
  }
  {
    section('engine: a guessed 1-byte route is never traced');
    const clk = clock(), drv = fakeDriver(clk), nodes = mkNodes(), { c, ev } = mkCtx(clk, { driver: drv, nodes }), E = Engine(c, { timers: clk.T });
    const t = nodes[0];
    t.outPath = { sz: 1, h: ['99'] };   // matches no known repeater
    ok(/can't be traced cleanly/.test(E.canTrace(t.id, { method: 'trace' }) || ''), 'Trace refused, with the reason');
    E.trace(t.id, { method: 'auto' }); await clk.advance(40000);
    ok(drv.calls[0] && drv.calls[0][0] === 'discover', 'Auto discovers a fresh route instead');
    ok(/known route not used/.test(runs(ev)[0].note || ''), 'the run says why');
    const nodes2 = mkNodes(), u = nodes2[1];
    u.outPath = { sz: 1, h: [nodes2[3].key.slice(0, 2)] };   // '03': only R3's key starts with it
    const clk2 = clock(), drv2 = fakeDriver(clk2), { c: c2 } = mkCtx(clk2, { driver: drv2, nodes: nodes2 }), E2 = Engine(c2, { timers: clk2.T });
    E2.trace(u.id, { method: 'trace' }); await clk2.advance(10000);
    ok(JSON.stringify(drv2.calls[0][2]) === JSON.stringify({ sz: 2, h: [nodes2[3].key.slice(0, 4)] }), 'a unique 1-byte hop is sent as 2 bytes');
    E.destroy(); E2.destroy();
  }
  {
    section('ping: companions only, DM + ACK, a flood ping counts as a flood');
    const clk = clock(), drv = fakeDriver(clk), nodes = mkNodes(), { c, ev, store } = mkCtx(clk, { driver: drv, nodes }), E = Engine(c, { timers: clk.T });
    const comp = nodes.find(n => n.name === 'Comp');
    ok(/companions/.test(E.canTrace(nodes[0].id, { method: 'ping' }) || ''), 'no ping to a repeater');
    ok(/post everyone sees/.test(E.canTrace(nodes.find(n => n.name === 'Rev').id, { method: 'ping' }) || ''), 'no ping to a room server');
    ok(E.trace(comp.id, { method: 'auto' }).ok && (await clk.advance(40000), drv.calls[0][0] === 'discover'), 'Auto never pings');
    await clk.advance(400000);
    drv.ping = () => new Promise(res => clk.T.setTimeout(() => res({ out: { sz: 2, h: ['a1b1'] }, flood: false, ms: 2500 }), 2500));
    const r = E.trace(comp.id, { method: 'ping' }); await clk.advance(5000);
    const d = dones(ev, r.id)[0];
    ok(d && d.status === 'success' && d.method === 'ping' && d.rttMs === 2500 && d.out.length === 3 && d.back.length === 0, 'ping success: route there, RTT, no back leg');
    ok(store.get('trLimits', {}).live.slice(-1)[0][2] === 0, 'a ping along a learned route is not a flood');
    comp.outPath = null; await clk.advance(400000);
    drv.ping = () => new Promise((res, rej) => clk.T.setTimeout(() => rej(Object.assign(new Error('no ACK'), { code: 'timeout' })), 9000));
    const r2 = E.trace(comp.id, { method: 'ping' }); await clk.advance(70000);
    const d2 = dones(ev, r2.id)[0];
    ok(d2 && d2.status === 'timeout' && /no ACK/.test(d2.error) && d2.tries === 1, 'ping timeout: no retry, plain reason');
    ok(store.get('trLimits', {}).live.slice(-1)[0][2] === 1, 'a ping with no route counts as a flood');
    E.destroy();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? `RESULT: FAIL (${fail})` : 'RESULT: ALL PASS');
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log(e && e.stack); console.log('RESULT: FAIL (exception)'); process.exitCode = 1; });
