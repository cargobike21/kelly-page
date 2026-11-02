/* Kelly Page -- LoRa Mesh > 🔭 Trace Route: the trace engine (2026-10-24, unreleased). Coded against js/tr-core.js and
 * the context `c` from js/tr-ui.js -- see TRACE_ROUTE_PLAN.md, row 1.
 *
 * window.KellyTREngine(c, opts?) -> { trace(id, { method }) -> { ok, id?, reason? }, cancel(runId?) -> bool,
 *   canTrace(id, { method }) -> null | reason, limits() -> LimitState, current() -> TraceRun | null, destroy() }
 * opts (tests): { timers: { now(), setTimeout(fn, ms), clearTimeout(h) }, retryMs }
 *
 * One run at a time, on the Driver c.driver() returns when it starts (the sim in demo, the live adapter when online).
 *   method 'trace'    direct along a known route: the contact's outPath, else the reverse of how its packets last
 *                     reached us (inbound), else zero hops when it's a direct neighbour (hops === 0). Repeaters and
 *                     room servers only. A timeout retries once after 3 s (tries 2).
 *   method 'discover' a flood path-discovery request: hashes only, no SNR, never retried (it's a flood).
 *   method 'path'     a companion's known route, traced to its last repeater and back (driver.tracePath; Telemetry
 *                     polling's route check). Retried once like a trace; a direct neighbour has nothing to trace.
 *   method 'auto'     trace when possible, else discover; a discovered repeater / room is then traced along the
 *                     route it gave (same run; run.method changes 'discover' -> 'trace'). If that follow-up trace
 *                     gets no answer the run still succeeds with the discovered route (method 'discover', no SNRs).
 * Every change emits 'run' (a fresh frozen TraceRun from TR.runOf); 'done' fires exactly once per run. An outer guard
 * (the driver's own wait + 5 s, at most 70 s) settles any attempt the driver never answers; cancel() settles at once
 * as 'cancelled' and the late driver answer is ignored. Phases 'outbound' / 'returning' are estimates (TR.hopMs).
 *
 * Rate limits (shared airtime, good amateur practice), persisted in store('trLimits') so a reload doesn't reset them:
 *   live (a real companion): same target 60 s apart (a discovery 5 min), 10 runs / 10 min, 30 / hour, floods 3 / 10 min.
 *   demo + sim-link (the MeshCore Demo link is simulated too -- nothing goes on air): looser, still capped. A run counts once when it starts (an auto run's follow-up trace and a retry don't
 *   count again). 'limit' is emitted after each run starts and ends, on a demo toggle, and every 5 s while blocked.
 * The log lives in memory (storage is only its mirror, loaded once): a full or blocked localStorage can't lift the caps.
 * claim(id, method, via) lets the rest of Kelly (the node panel's old Trace button, Mesh Paths' go-for-gold) spend
 * from the same budget: -> null (counted) or the plain-English reason it can't go now.
 * store('trLast'): target -> last successful pathKey (cap 200), for run.changed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tr-core.js'));
  else root.KellyTREngine = factory(root.KellyTR || null);
})(typeof self !== 'undefined' ? self : this, function (TR0) {
  'use strict';

  const CAPS = {
    live: { tenMin: 10, hour: 30, flood10: 3, targetGapMs: 60e3, discoverGapMs: 300e3 },
    demo: { tenMin: 30, hour: 120, flood10: 10, targetGapMs: 8e3, discoverGapMs: 30e3 },
  };
  const TEN = 600e3, HOUR = 3600e3, LOG_CAP = 200, LAST_CAP = 200, GUARD_MAX = 70e3, RETRY_MS = 3000;

  function fmtWait(ms) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    if (s < 90) return `${s} s`;
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
  }

  return function KellyTREngine(c, opts) {
    opts = opts || {};
    const TR = (c && c.TR) || TR0;
    if (!c || !TR) return null;
    const T = opts.timers || { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h) };
    const retryMs = opts.retryMs != null ? opts.retryMs : RETRY_MS;
    const bus = c.bus;
    let seq = 0, cur = null, last = null, dead = false, limTimer = null;
    const unsub = [];

    const sget = (k, d) => { try { const v = c.store && c.store.get(k, d); return v == null ? d : v; } catch { return d; } };
    const sset = (k, v) => { try { c.store && c.store.set(k, v); } catch { /* storage off */ } };
    const emit = (name, x) => { try { bus && bus.emit(name, x); } catch { /* never throw out */ } };
    const safe = (f, d) => { try { return f(); } catch { return d; } };

    // ------------------------------------------------------------ rate limiter
    const modeOf = via => via === 'live' ? 'live' : 'demo';
    const curMode = () => { const v = safe(() => c.link().via, 'none'); return v === 'demo' || v === 'sim-link' ? 'demo' : 'live'; };
    let mem = null;   // { live: [[t, id, flood, end?]], demo: [...] } -- the truth; storage mirrors it
    function all() {
      if (!mem) { const a = sget('trLimits', null), ok = x => Array.isArray(x) ? x.filter(e => Array.isArray(e) && typeof e[0] === 'number').map(e => e.slice(0, 4)) : [];
        mem = { live: ok(a && a.live), demo: ok(a && a.demo) }; }
      return mem;
    }
    const mirror = () => sset('trLimits', { live: mem.live.slice(), demo: mem.demo.slice() });
    function logOf(mode) {
      const now = T.now(), m = all();
      m[mode] = m[mode].filter(e => now - e[0] < HOUR && e[0] <= now + 60e3).slice(-LOG_CAP);
      return m[mode].slice();
    }
    function record(mode, id, flood) { logOf(mode); all()[mode].push([T.now(), String(id), flood ? 1 : 0]); mirror(); }
    // a run ended: its entry gets the end time (4th field) -- the per-station gaps run from the END, so a slow run
    // (a timeout + retry is ~25 s) can't be followed at once by another to the same station
    function ended(mode, id) {
      const l = all()[mode];
      for (let i = l.length - 1; i >= 0; i--) if (l[i][1] === String(id)) { l[i][3] = T.now(); break; }
      mirror();
    }
    const lastAt = e => Math.max(e[0], typeof e[3] === 'number' ? e[3] : 0);
    // the n-th oldest entry in a window that is at its cap -> when one slot frees
    const freeAt = (w, cap, span) => { const s = w.map(e => e[0]).sort((a, b) => a - b); return s[s.length - cap] + span; };
    function globalBlock(mode, log) {
      const now = T.now(), cp = CAPS[mode], ten = log.filter(e => now - e[0] < TEN);
      if (log.length >= cp.hour) return { reason: `${cp.hour} traces in the last hour (the mesh's airtime is shared) -- the next one can go in ${fmtWait(freeAt(log, cp.hour, HOUR) - now)}`, nextAt: freeAt(log, cp.hour, HOUR) };
      if (ten.length >= cp.tenMin) return { reason: `${cp.tenMin} traces in the last 10 minutes (the mesh's airtime is shared) -- the next one can go in ${fmtWait(freeAt(ten, cp.tenMin, TEN) - now)}`, nextAt: freeAt(ten, cp.tenMin, TEN) };
      return null;
    }
    function check(mode, id, method) {
      const now = T.now(), cp = CAPS[mode], log = logOf(mode);
      const g = globalBlock(mode, log); if (g) return g;
      if (method === 'discover') {
        const fl = log.filter(e => e[2] && now - e[0] < TEN);
        if (fl.length >= cp.flood10) { const at = freeAt(fl, cp.flood10, TEN); return { reason: `${cp.flood10} path discoveries in the last 10 minutes -- each one floods the whole mesh. The next can go in ${fmtWait(at - now)}`, nextAt: at }; }
        const lf = log.filter(e => e[2] && e[1] === id).reduce((m, e) => Math.max(m, lastAt(e)), -Infinity);
        if (now - lf < cp.discoverGapMs) return { reason: `a path discovery floods the whole mesh: one per station every ${fmtWait(cp.discoverGapMs)} -- try again in ${fmtWait(lf + cp.discoverGapMs - now)}`, nextAt: lf + cp.discoverGapMs };
      }
      const lt = log.filter(e => e[1] === id).reduce((m, e) => Math.max(m, lastAt(e)), -Infinity);
      if (now - lt < cp.targetGapMs) return { reason: `one trace per station every ${fmtWait(cp.targetGapMs)} -- try this one again in ${fmtWait(lt + cp.targetGapMs - now)}`, nextAt: lt + cp.targetGapMs };
      return null;
    }
    function limits() {
      const mode = curMode(), now = T.now(), cp = CAPS[mode], log = logOf(mode), g = globalBlock(mode, log);
      const perTarget = {};
      for (const e of log) { const at = lastAt(e) + cp.targetGapMs; if (at > now && !(perTarget[e[1]] >= at)) perTarget[e[1]] = at; }
      return TR.freeze({ ok: !g, reason: g ? g.reason : null, nextAt: g ? g.nextAt : null, perTarget,
        used: { tenMin: log.filter(e => now - e[0] < TEN).length, hour: log.length, flood10: log.filter(e => e[2] && now - e[0] < TEN).length },
        caps: Object.assign({}, cp), mode });
    }
    function emitLimit() {
      if (dead) return;
      if (limTimer) { T.clearTimeout(limTimer); limTimer = null; }
      const s = limits(); emit('limit', s);
      if (!s.ok || Object.keys(s.perTarget).length) limTimer = T.setTimeout(() => { limTimer = null; emitLimit(); }, 5000);
    }

    // ------------------------------------------------------------ route choice
    const lc = h => String(h).toLowerCase();
    function routeFor(n, me) {
      const sz0 = (me && me.hashSize) || 1;
      if (n.outPath && Array.isArray(n.outPath.h)) return { route: { sz: n.outPath.sz || sz0, h: n.outPath.h.map(lc) }, source: n.outPath.h.length ? 'learned' : 'direct' };
      if (n.inbound && Array.isArray(n.inbound.h) && (n.inbound.h.length || n.hops === 0)) return { route: { sz: n.inbound.sz || sz0, h: n.inbound.h.map(lc).reverse() }, source: n.inbound.h.length ? 'reverse' : 'direct' };
      if (n.hops === 0) return { route: { sz: sz0, h: [] }, source: 'direct' };
      return null;
    }
    // the forwarding stations Kelly knows (their full keys): what a 1-byte hop may be (TR.route2)
    const fwdKeys = () => (safe(() => c.nodes(), null) || []).filter(x => x && x.key && (x.role === 'repeater' || x.role === 'room')).map(x => x.key);
    // a route Kelly will trace: every hop 2 bytes, never a guessed 1-byte hop -> { route } | { reason }
    const clean = route => TR.route2 ? TR.route2(route, fwdKeys()) : { route };
    // -> { method, route?, source?, follow, note? } | { reason }
    function plan(n, method) {
      const traceable = n.role === 'repeater' || n.role === 'room';
      if (!n.key) return { reason: n.why || 'Kelly has only heard this station by name -- it needs the station\'s advert (its key) first' };
      const m = method === 'trace' || method === 'discover' || method === 'ping' || method === 'path' ? method : 'auto';
      if (m === 'path') {   // a companion's route, traced to the last repeater before it (Telemetry polling)
        if (n.role !== 'companion') return { reason: 'a route check is for companions -- trace a repeater or room server instead' };
        const r0 = routeFor(n, safe(() => c.me(), null));
        if (!r0) return { reason: 'no route to it is known yet (a poll\'s answer teaches one)' };
        if (!r0.route.h.length) return { reason: 'a direct neighbour: there are no repeaters on the way to trace', direct: true };
        const q = clean(r0.route);
        if (q.reason) return { reason: `its route can't be traced cleanly: ${q.reason}` };
        return { method: 'path', route: q.route, source: r0.source, follow: false };
      }
      if (m === 'ping') return n.role === 'companion' ? { method: 'ping', follow: false }
        : { reason: n.role === 'room' ? 'a message to a room server is a post everyone sees -- trace it instead' : 'Ping is for companions (it sends a short message to their inbox) -- trace a repeater instead' };
      if (m === 'discover') return n.canDiscover === false ? { reason: n.why || 'this station cannot be discovered' } : { method: 'discover', follow: false };
      let r = traceable ? routeFor(n, safe(() => c.me(), null)) : null, bad = null;
      if (r) { const q = clean(r.route); if (q.reason) { bad = q.reason; r = null; } else r = Object.assign({}, r, { route: q.route }); }
      if (m === 'trace') {
        if (!traceable) return { reason: 'MeshCore traces go through repeaters: only a repeater or room server can be traced. For a companion try Ping (or Discover, if it allows telemetry to you).' };
        if (bad) return { reason: `its known route can't be traced cleanly: ${bad}. Use Discover (or Auto) to find a 2-byte route.` };
        if (!r) return { reason: 'no route to it is known yet -- use Discover (or Auto) to find one first' };
        return { method: 'trace', route: r.route, source: r.source, follow: false };
      }
      if (r) return { method: 'trace', route: r.route, source: r.source, follow: false };
      if (n.canDiscover === false) return { reason: n.why || 'this station cannot be traced or discovered' };
      return { method: 'discover', follow: traceable, note: bad ? `known route not used (${bad}) -- discovering a fresh one` : null };
    }
    function prepare(id, o) {
      if (dead) return { reason: 'the trace engine has stopped' };
      const d = safe(() => c.driver && c.driver(), null);
      if (!d) { const l = safe(() => c.link(), null); return { reason: (l && l.why) || 'no radio link -- connect a MeshCore companion node, or turn on Demo' }; }
      if (cur) return { reason: 'a trace is already running -- wait for it, or cancel it' };
      const n = id == null ? null : safe(() => c.node(id), null);
      if (!n) return { reason: 'that station is not in the list any more' };
      const p = plan(n, o && o.method);
      if (p.reason) return p;
      p.flood = p.method === 'discover' || (p.method === 'ping' && !(n.outPath && Array.isArray(n.outPath.h)));   // a ping with no route floods
      const blk = check(modeOf(d.via), n.id, p.flood ? 'discover' : 'trace');
      if (blk) return { reason: blk.reason, limited: true };
      return { d, n, p };
    }

    // ------------------------------------------------------------ hops
    const radio = () => safe(() => c.radio(), null);
    const perHop = bytes => TR.hopMs(bytes, radio());
    function meHop(me) { return { id: 'me', hash: null, name: (me && me.name) || 'My node', role: 'companion', lat: me ? me.lat ?? null : null, lon: me ? me.lon ?? null : null, known: true, snr: null, estMs: 0 }; }
    function hashHop(h, snr, estMs) {
      const s = safe(() => c.resolveHash(h), null);
      return s ? { id: s.id, hash: h, name: s.name, role: s.role, lat: s.lat ?? null, lon: s.lon ?? null, known: true, snr, estMs }
        : { id: `h:${h}`, hash: h, name: h.toUpperCase(), role: null, lat: null, lon: null, known: false, snr, estMs };
    }
    function targetHop(n, sz, snr, estMs) { return { id: n.id, hash: n.key ? n.key.slice(0, sz * 2) : null, name: n.name, role: n.role, lat: n.lat ?? null, lon: n.lon ?? null, known: true, snr, estMs }; }
    // out = me, route.., target; back = target, reverse.., me. snrs optional (trace answers).
    function hopsFor(n, outH, backH, sz, per, snrT, snrB) {
      const me = safe(() => c.me(), null), k = outH.length;
      const out = [meHop(me)].concat(outH.map((h, i) => hashHop(h, snrT ? snrT[i] ?? null : null, (i + 1) * per)), [targetHop(n, sz, snrT ? snrT[k] ?? null : null, (k + 1) * per)]);
      if (!backH) return { out, back: [] };
      const b = backH.length, back = [targetHop(n, sz, null, (k + 1) * per)].concat(backH.map((h, j) => hashHop(h, snrB ? snrB[j] ?? null : null, (k + 2 + j) * per)),
        [Object.assign(meHop(me), { snr: snrB ? snrB[b] ?? null : null, estMs: (k + b + 2) * per })]);
      return { out, back };
    }
    const traceBytes = (k, sz) => 11 + (2 * k + 1) * (sz + 1);
    function waits(method, k, sz, n) {
      const per = method === 'discover' ? perHop(48) : perHop(traceBytes(k, sz)), air = per / 3;
      let wait;
      if (method === 'discover') { const hg = n.hops != null ? n.hops : 4; wait = Math.max(25e3, Math.min(60e3, (500 + (air * 6 + 250) * (hg + 2) * 2) * 1.5)); }
      else { const est = 500 + (air * 6 + 250) * (2 * k + 2); wait = Math.max(8e3, Math.min(60e3, est * 1.5 + 4e3)); }
      return { per, guard: Math.min(GUARD_MAX, Math.round(wait + 5e3)), wait };
    }

    // ------------------------------------------------------------ last-route memory (run.changed)
    const lastKey = (via, id) => (via === 'demo' ? 'demo:' : '') + id;
    function changedFor(via, id, key) {
      const m = sget('trLast', null) || {}, k = lastKey(via, id), prev = m[k];
      const changed = prev && typeof prev[0] === 'string' ? prev[0] !== key : null;
      const o = Object.assign({}, m); o[k] = [key, T.now()];
      const ks = Object.keys(o);
      if (ks.length > LAST_CAP) ks.sort((a, b) => ((o[a] && o[a][1]) || 0) - ((o[b] && o[b][1]) || 0)).slice(0, ks.length - LAST_CAP).forEach(x => delete o[x]);
      sset('trLast', o);
      return changed;
    }

    // ------------------------------------------------------------ a run
    function push(R) { if (R.done) return; last = TR.runOf(Object.assign({}, R.p)); emit('run', last); }
    function later(R, ms, fn) { const h = T.setTimeout(() => { R.timers.delete(h); if (!R.done) fn(); }, ms); R.timers.add(h); return h; }
    function clearAll(R) { for (const h of R.timers) T.clearTimeout(h); R.timers.clear(); }
    function settle(R, status, extra) {
      if (R.done) return;
      clearAll(R); R.token++;
      Object.assign(R.p, { status, phase: 'done', endedAt: T.now() }, extra || {});
      last = TR.runOf(Object.assign({}, R.p));
      R.done = true; if (cur === R) cur = null;
      if (R.counted) ended(modeOf(R.p.via), R.p.target);
      emit('run', last); emit('done', last);
      emitLimit();
    }

    function send(R) {
      if (R.done) return;
      const p = R.p, n = R.n, isP = p.method === 'ping', isD = p.method === 'discover' || isP, route = R.route || { sz: p.hashSize, h: [] };
      const k = isD ? Math.max(0, n.hops || 0) : route.h.length, w = waits(isP ? 'discover' : p.method, k, p.hashSize, n);
      if (isP && p.via !== 'demo') w.guard = GUARD_MAX - 5e3;   // the node gives up on the ACK itself (meshcore.js: at most 60 s)
      // a real node times a trace out itself from the firmware's own estimate (meshcore.js ask(): at most 60 s) -- the guard
      // must not beat it, or the retry would go out while the first trace is still in flight
      if (p.via !== 'demo' && !isD) w.guard = GUARD_MAX - 5e3;
      const est = isD ? hopsFor(n, (n.outPath && n.outPath.h ? n.outPath.h.map(lc) : []), null, p.hashSize, w.per) : hopsFor(n, route.h, route.h.slice().reverse(), p.hashSize, w.per);
      const tok = ++R.token;
      Object.assign(p, { status: 'pending', phase: 'sending', sentAt: T.now(), timeoutMs: w.guard, out: est.out, back: isD ? [] : est.back,
        snrMin: null, snrAvg: null, rttMs: null });
      push(R);
      const tgtMs = est.out[est.out.length - 1].estMs;
      later(R, Math.min(300, Math.max(50, tgtMs / 4)), () => { if (tok === R.token && p.phase === 'sending') { p.phase = 'outbound'; push(R); } });
      later(R, Math.max(400, tgtMs), () => { if (tok === R.token && (p.phase === 'outbound' || p.phase === 'sending')) { p.phase = 'returning'; push(R); } });
      later(R, w.guard, () => { if (tok === R.token) fail(R, tok, Object.assign(new Error('no answer'), { code: 'timeout', guard: true })); });
      let pr;
      try {
        if (isP && typeof R.d.ping !== 'function') throw Object.assign(new Error('this link cannot send a ping'), { code: 'error' });
        if (p.method === 'path' && typeof R.d.tracePath !== 'function') throw Object.assign(new Error('this link cannot check a companion\'s route'), { code: 'error' });
        const rt = { sz: route.sz || p.hashSize, h: route.h.slice() };
        pr = Promise.resolve(isP ? R.d.ping(n) : isD ? R.d.discover(n) : p.method === 'path' ? R.d.tracePath(n, rt) : R.d.trace(n, rt));
      } catch (e) { pr = Promise.reject(e); }
      pr.then(r => { if (tok === R.token && !R.done) (isP ? gotPing : isD ? gotDiscovery : gotTrace)(R, r); },
        e => { if (tok === R.token && !R.done) fail(R, tok, e); });
    }

    function gotTrace(R, r) {
      const p = R.p, n = R.n;
      if (!r || !Array.isArray(r.out)) return fail(R, R.token, Object.assign(new Error('the node sent an answer Kelly could not read'), { code: 'error' }));
      const outH = r.out.map(lc), backH = Array.isArray(r.back) ? r.back.map(lc) : outH.slice().reverse();
      const per = perHop(traceBytes(outH.length, p.hashSize));
      const h = hopsFor(n, outH, backH, p.hashSize, per, r.snrTowards || [], r.snrBack || []);
      const snrs = h.out.concat(h.back).map(x => x.snr).filter(v => v != null && isFinite(v));
      const key = TR.pathKey(outH);
      Object.assign(p, { out: h.out, back: h.back, rttMs: r.ms != null ? Math.round(r.ms) : T.now() - p.sentAt, pathKey: key,
        snrMin: snrs.length ? Math.min(...snrs) : null, snrAvg: snrs.length ? Math.round(snrs.reduce((a, b) => a + b, 0) / snrs.length * 10) / 10 : null,
        changed: changedFor(p.via, n.id, key), error: null,
        note: p.method === 'path' ? `${outH.length} repeater${outH.length === 1 ? '' : 's'} on the way, each with its signal report -- the last hop to ${n.name || 'the companion'} isn't measured (a companion doesn't forward a trace)`
          : `${outH.length} hop${outH.length === 1 ? '' : 's'} each way${p.pathSource === 'discovered' ? ' (route from a path discovery)' : p.pathSource === 'reverse' ? ' (the reverse of how its packets reach us)' : ''}` });
      settle(R, 'success');
    }

    function gotDiscovery(R, r) {
      const p = R.p, n = R.n;
      if (!r || !r.out || !Array.isArray(r.out.h)) return fail(R, R.token, Object.assign(new Error('the node sent a discovery answer Kelly could not read'), { code: 'error' }));
      const sz = r.out.sz || p.hashSize, outH = r.out.h.map(lc), backH = r.back && Array.isArray(r.back.h) ? r.back.h.map(lc) : outH.slice().reverse();
      const per = perHop(48), h = hopsFor(n, outH, backH, sz, per);
      R.disc = { out: h.out, back: h.back, ms: r.ms != null ? Math.round(r.ms) : T.now() - p.sentAt, key: TR.pathKey(outH), sz };
      Object.assign(p, { hashSize: sz, pathSource: 'discovered', out: h.out, back: h.back, pathKey: R.disc.key });
      const q = R.follow ? clean({ sz, h: outH }) : null;
      if (q && q.reason) return discoveryDone(R, `route found, but not traced for signal reports: ${q.reason}`);
      if (R.follow) {   // auto: trace the discovered route for per-hop SNRs (same run; it doesn't count against the limits again)
        R.route = q.route;
        Object.assign(p, { method: 'trace', attempt: 1, tries: 2, phase: 'queued', note: `route found (${outH.length} hop${outH.length === 1 ? '' : 's'}) -- tracing it for signal reports` });
        push(R);
        later(R, 250, () => send(R));
        return;
      }
      discoveryDone(R, null);
    }
    function discoveryDone(R, note) {
      const p = R.p, d = R.disc;
      Object.assign(p, { method: 'discover', out: d.out, back: d.back, rttMs: d.ms, pathKey: d.key, snrMin: null, snrAvg: null, hashSize: d.sz,
        changed: changedFor(p.via, R.n.id, d.key), error: null,
        note: note || `route found: ${d.out.length - 2} hop${d.out.length === 3 ? '' : 's'} there, ${d.back.length - 2} back (a discovery gives no signal reports)` });
      settle(R, 'success');
    }

    // a ping's ACK: the message reached them. The route there is the contact's out path (none known: it went by flood).
    function gotPing(R, r) {
      const p = R.p, n = R.n, o = r && r.out && Array.isArray(r.out.h) ? r.out : null;
      const outH = o ? o.h.map(lc) : [], h = hopsFor(n, outH, null, (o && o.sz) || 2, perHop(60));
      const key = o ? TR.pathKey(outH) : '';
      Object.assign(p, { out: h.out, back: [], rttMs: r && r.ms != null ? Math.round(r.ms) : T.now() - p.sentAt, pathKey: key, snrMin: null, snrAvg: null,
        pathSource: o ? (r.flood ? 'discovered' : 'learned') : null, changed: o ? changedFor(p.via, n.id, key) : null, error: null,
        note: `ACK back -- the message reached ${n.name || 'them'}${o ? ` (${outH.length} hop${outH.length === 1 ? '' : 's'} there${r.flood ? ', route learned from its reply' : ''})` : ' (by flood: no route learned yet)'}; a ping gives no signal reports` });
      settle(R, 'success');
    }

    function fail(R, tok, e) {
      if (R.done || tok !== R.token) return;
      R.token++; clearAll(R);
      const p = R.p, code = e && e.code, msg = e && e.message ? String(e.message) : 'unknown error';
      if (code === 'cancelled') return settle(R, 'cancelled', { error: msg, note: msg });
      if (p.method === 'ping') return settle(R, code === 'timeout' ? 'timeout' : 'error', { error: code === 'timeout' ? 'no ACK -- the message did not reach them, or the ACK was lost on the way back' : msg, note: null });
      if (p.method === 'discover') {
        if (code === 'timeout') return settle(R, 'no-path', { error: 'no answer to the path discovery -- it may be out of reach, or not allow telemetry to you (silence proves nothing)', note: null });
        return settle(R, 'error', { error: msg, note: null });
      }
      // a trace
      if (code === 'timeout' && p.attempt < p.tries) {
        Object.assign(p, { attempt: p.attempt + 1, phase: 'queued', note: `no answer -- trying again in ${Math.round(retryMs / 1000)} s` });
        push(R);
        later(R, retryMs, () => send(R));
        return;
      }
      if (R.disc) return discoveryDone(R, `route found by discovery, but the trace along it got no answer -- no signal reports`);
      if (code === 'timeout') return settle(R, 'timeout', { error: `no answer after ${p.tries} tr${p.tries === 1 ? 'y' : 'ies'} -- lost somewhere after us (MeshCore doesn't say which hop dropped it)`, note: null });
      settle(R, 'error', { error: msg, note: null });
    }

    // ------------------------------------------------------------ API
    function trace(id, o) {
      try {
        const x = prepare(id, o);
        if (x.reason) { if (x.limited) emitLimit(); return { ok: false, reason: x.reason }; }
        const { d, n, p } = x, via = d.via || 'live', me = safe(() => c.me(), null);
        const sz = p.route ? p.route.sz : (me && me.hashSize) || 1;
        const R = { d, n, route: p.route || null, follow: p.follow, token: 0, timers: new Set(), done: false, disc: null,
          p: { id: `tr-${++seq}`, target: n.id, targetName: n.name || '', targetRole: n.role || null, method: p.method, via, demo: via !== 'live',
            status: 'pending', phase: 'queued', attempt: 1, tries: p.method === 'trace' || p.method === 'path' ? 2 : 1, hashSize: p.method === 'trace' || p.method === 'path' ? sz : 2,
            pathSource: p.method === 'trace' || p.method === 'path' ? p.source : null, out: [], back: [], t0: T.now(), sentAt: null, endedAt: null, rttMs: null,
            timeoutMs: 0, snrMin: null, snrAvg: null, pathKey: p.route ? TR.pathKey(p.route.h) : '', changed: null, error: null, note: p.note || null } };
        const est = hopsFor(n, p.route ? p.route.h : [], p.route ? p.route.h.slice().reverse() : null, sz, perHop(48));
        R.p.out = est.out; R.p.back = est.back;
        cur = R;
        record(modeOf(via), n.id, !!p.flood); R.counted = true;
        push(R);
        emitLimit();
        later(R, 0, () => send(R));
        return { ok: true, id: R.p.id };
      } catch (e) {
        return { ok: false, reason: `the trace could not start: ${e && e.message}` };
      }
    }
    function canTrace(id, o) { try { const x = prepare(id, o); return x.reason || null; } catch (e) { return String(e && e.message); } }
    // reason: a plain-English cause (e.g. 'link lost') settles it as an error instead of a user cancel
    function cancel(runId, reason) {
      if (!cur || (runId != null && runId !== cur.p.id)) return false;
      settle(cur, reason ? 'error' : 'cancelled', reason ? { error: reason, note: null } : { error: null, note: 'cancelled' });
      return true;
    }
    function claim(id, method, via) {
      if (dead) return null;
      const mode = modeOf(via || 'live'), m = method === 'discover' ? 'discover' : 'trace';
      if (m === 'discover' && cur && !cur.done && cur.p.method === 'discover') return 'Trace Route is waiting on a path discovery -- the node holds one at a time';
      const blk = check(mode, String(id), m); if (blk) { emitLimit(); return blk.reason; }
      record(mode, String(id), m === 'discover'); ended(mode, String(id)); emitLimit();
      return null;
    }
    if (bus && bus.on) unsub.push(bus.on('demo', () => emitLimit()));

    return {
      trace, cancel, canTrace, limits, claim, current: () => last,
      destroy() { if (dead) return; cancel(); dead = true; if (limTimer) T.clearTimeout(limTimer); limTimer = null; unsub.forEach(u => { try { u(); } catch { /* */ } }); },
    };
  };
});
