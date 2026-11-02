/* Kelly Page -- LoRa Mesh > 🔭 Trace Route tab (2026-10-24, unreleased): pick one station, trace the route to it and
 * back, watch the packet hop star to star (the "constellation" theme). Packet Journey's quieter sibling: only the
 * source, the destination and the path between them.
 * This file is the shell: layout, mount points, the shared context `c`, the live MeshCore adapter (the Driver the
 * engine uses), demo / full screen and visibility. The parts (one file each, coded against js/tr-core.js -- see
 * TRACE_ROUTE_PLAN.md):
 *   js/tr-engine.js   window.KellyTREngine(c)            sends traces / discoveries, rate limit, timeouts, retries -> bus
 *   js/tr-sim.js      window.KellyTRSim(c)               a made-up SEQ mesh: a Driver with no radio (demo mode)
 *   js/tr-picker.js   window.KellyTRPicker(mount, c)     station list, search, favourites, recent, map pick, Trace button
 *   js/tr-viz.js      window.KellyTRViz(mount, c)        the constellation canvas
 *   js/tr-sound.js    window.KellyTRSound(mount, c)      Web Audio sounds + the speaker controls
 *   js/tr-history.js  window.KellyTRHistory(mount, c)    past traces per station, RTT / SNR chart
 *   js/tr-telem.js    window.KellyTRTelem(mount, c)      telemetry polling: grants with other Kellys, periodic poll + route check
 *                     (pure part js/tr-grants.js; radio side c.telemFor(demo); grant DMs arrive as bus 'tdata' { key, text, demo })
 * Each returns { destroy?() }; a missing or failing part leaves its box empty.
 *
 * window.KellyTraceRouteUI(k) -> { init, shown(), hidden(), route(e), nodesChanged() }; k from mesh.js:
 *   { $, esc, store, toast, settings, audioCtx, fxLoop, fmtAgo, makeMap, myPos(), radio(), distKm(a, b),
 *     nodes() -> mesh.js nodes, myNum(), myName(), hashSize() 1|2|3, online(), isSimLink(), session(), inbound(num),
 *     noteTrace(tr) (feeds Mesh Paths + Mesh Quest, as mesh.js driverTrace does), sendDm(num, text) -> msg | null (one try,
 *     shown in the chat), sendsOf(key, name) -> { size, strength } | null (the hash size check's verdict on a station) }
 */
(function () {
  'use strict';

  window.KellyTraceRouteUI = function (k) {
    const PJ = window.KellyPJ, TR = window.KellyTR;
    if (!PJ || !TR) return null;
    const bus = PJ.createBus();
    let root = null, parts = {}, engine = null, sim = null, vis = false, demoOn = false, sel = null, linkSig = '', nodesSig = '';

    if (window.KellyAwards) window.KellyAwards.addDemo(() => demoOn);   // awards: the demo never scores
    const rmq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const reduced = () => !!(rmq && rmq.matches);

    // ------------------------------------------------------------ stations: mesh.js nodes -> StationNode
    // the callsign where Ham Contacts knows one (js/hc-calls.js)
    const hamLabel = (key, name) => { const H = window.KellyHamCalls; if (!H || !key) return name; try { return H.label(key, name) || name; } catch { return name; } };
    function station(n) {
      const role = TR.roleOf(n.role), key = n.key ? String(n.key).toLowerCase() : null;
      const me = k.myPos && k.myPos(), km = me && n.lat != null && n.lon != null && !(n.lat === 0 && n.lon === 0) && k.distKm ? k.distKm(me, n) : null;
      const canTrace = !!key && (role === 'repeater' || role === 'room'), canDiscover = !!key, canPing = !!key && role === 'companion';
      // a companion: MeshCore can't trace it, and its telemetry (which discovery needs) is off by default -- say so up front
      const why = !key ? 'only heard by name -- Kelly needs its advert' : canTrace ? null
        : role === 'companion' ? 'a companion can\'t be traced (it doesn\'t repeat). Discover only answers if its owner turned telemetry on (off by default) -- Ping sends a short message and waits for the ACK.'
          : 'not a repeater or room server: path discovery only (it must allow telemetry to you)';
      const sends = k.sendsOf ? k.sendsOf(key, n.longName || n.shortName || '') : null;
      const ib = k.inbound ? k.inbound(n.num) : null;
      return { id: key || `num:${n.num >>> 0}`, num: n.num >>> 0, key, name: hamLabel(key, n.longName || n.shortName || (key ? key.slice(0, 8) : String(n.num))), role, roleId: n.role ?? 0, nodeName: n.longName || n.shortName || '', flags: n.flags ?? null,
        lat: n.lat ?? null, lon: n.lon ?? null, lastHeard: n.lastHeard || null, snr: n.snr ?? null, rssi: n.rssi ?? null,
        hops: n.hops != null && n.hops >= 0 && n.hops < 64 ? n.hops : n.outPath && n.outPath.h ? n.outPath.h.length : null,
        outPath: n.outPath && n.outPath.h ? { sz: n.outPath.sz || 1, h: n.outPath.h.slice() } : null, inbound: ib, fav: !!n.fav,
        km: km != null && isFinite(km) ? km : null, canTrace, canDiscover, canPing, why, sends: sends && sends.size ? { size: sends.size, strength: sends.strength || 'likely' } : null };
    }
    function liveNodes() {
      const my = k.myNum && k.myNum(), out = [];
      for (const n of k.nodes()) if (n && (n.num >>> 0) !== my && (n.key || n.longName)) out.push(station(n));
      return out;
    }
    // memoised for 400 ms: every part reads the list, often several times a frame
    let memo = null;
    const nodes = () => { const t = Date.now(); if (!memo || t - memo.t > 400 || memo.demo !== demoOn) memo = { t, demo: demoOn, list: demoOn && sim ? sim.nodes() : liveNodes() }; return memo.list; };
    const node = id => id == null ? undefined : nodes().find(n => n.id === id || n.key === id || (n.num != null && `num:${n.num}` === id));
    function me() {
      if (demoOn && sim && sim.me) return sim.me();
      const p = k.myPos && k.myPos();
      return { id: 'me', name: (k.myName && k.myName()) || 'My node', lat: p ? p.lat : null, lon: p ? p.lon : null, hashSize: (k.hashSize && k.hashSize()) || 1 };
    }
    // a path hash -> the one station it can be (repeaters / rooms first: only they forward), else null
    function resolveHash(h) {
      h = String(h || '').toLowerCase(); if (!h) return null;
      const all = nodes().filter(n => n.key && n.key.startsWith(h)), fwd = all.filter(n => n.role === 'repeater' || n.role === 'room');
      return fwd.length === 1 ? fwd[0] : !fwd.length && all.length === 1 ? all[0] : null;
    }

    // ------------------------------------------------------------ the live Driver (a real companion, or the MeshCore Demo link)
    const discWait = [];   // { prefix, resolve, reject, timer }
    let pingWait = null;   // { num, ref, flood, resolve, reject, t0 }: one ping at a time (the engine runs one at a time)
    let telWait = null;    // { src, dest, rx }: the telemetry request in flight (the node keeps one at a time)
    const rawOf = n => [...k.nodes()].find(x => x.key && String(x.key).toLowerCase() === n.key);
    const myKey = () => { const my = k.myNum && k.myNum(), n = [...k.nodes()].find(x => (x.num >>> 0) === my); return n && n.key ? String(n.key).toLowerCase() : null; };
    const PING_TEXT = () => `🔭 Trace Route ping from ${(k.myName && k.myName()) || 'Kelly'} -- no reply needed`;
    const err = (code, msg) => Object.assign(new Error(msg), { code });
    const live = {
      get via() { return k.isSimLink && k.isSimLink() ? 'sim-link' : 'live'; },
      nodes: liveNodes, me,
      async trace(n, route) {
        if (route && route.sz === 3) throw err('error', '3-byte path hashes: Kelly traces only 1- and 2-byte routes -- use Discover');
        const s = k.session && k.session(); if (!s || !s.trace) throw err('error', 'not connected to a MeshCore node');
        const raw = [...k.nodes()].find(x => x.key && String(x.key).toLowerCase() === n.key); if (!raw) throw err('error', 'the node no longer has that contact');
        const t0 = Date.now();
        try {
          const r = await s.trace(Object.assign({}, raw, { outPath: route && route.h ? { sz: route.sz || 1, h: route.h.slice() } : null }));
          k.noteTrace && k.noteTrace(raw.num >>> 0, r, t0);
          return r;
        } catch (e) { throw err(/no trace answer|did not answer/.test(e.message) ? 'timeout' : 'error', e.message); }
      },
      // a short DM, one try, and its ACK (mesh.js route events 'sent' / 'ack' / 'noack') -> { out: { sz, h } | null, flood, ms }
      async ping(n) {
        if (!k.sendDm) throw err('error', 'this Kelly cannot send a ping');
        const raw = [...k.nodes()].find(x => x.key && String(x.key).toLowerCase() === n.key); if (!raw) throw err('error', 'the node no longer has that contact');
        if (pingWait) { pingWait.reject(err('cancelled', 'replaced by a newer ping')); pingWait = null; }
        const w = { num: raw.num >>> 0, ref: null, flood: false, t0: Date.now() };
        const p = new Promise((resolve, reject) => { w.resolve = resolve; w.reject = reject; });
        pingWait = w;
        const msg = await k.sendDm(raw.num >>> 0, PING_TEXT());
        if (!msg) { if (pingWait === w) pingWait = null; throw err('error', 'the message did not go out (see the chat)'); }
        if (!w.ref) w.ref = msg;
        return p;
      },
      // a companion's route to its last repeater and back (Telemetry polling): -> the trace answer's shape (TR.pathShape)
      async tracePath(n, route) {
        const s = k.session && k.session(); if (!s || !s.traceList) throw err('error', 'not connected to a MeshCore node');
        const sz = route && route.sz === 2 ? 2 : 1, out = (route && route.h ? route.h : []).map(h => String(h).toLowerCase().slice(0, sz * 2));
        try { const r = await s.traceList(TR.pathList(out), sz); return Object.assign(TR.pathShape(out, r.snrs, r.final), { ms: r.ms }); }
        catch (e) { throw err(/no trace answer|did not answer/.test(e.message) ? 'timeout' : 'error', e.message); }
      },
      // a base telemetry request (CMD 39) -> { lpp, rx: { snr, rssi, flood } | null (their answer as our radio heard it), ms }
      async telemetry(n) {
        const s = k.session && k.session(); if (!s || !s.telemetry) throw err('error', 'not connected to a MeshCore node');
        const raw = rawOf(n); if (!raw) throw err('error', 'the node no longer has that contact');
        const mk = myKey(), w = { src: n.key.slice(0, 2), dest: mk ? mk.slice(0, 2) : null, rx: null }, t0 = Date.now();
        telWait = w;
        try { const lpp = await s.telemetry(raw); return { lpp, rx: w.rx, ms: Date.now() - t0 }; }
        catch (e) { throw err(/no telemetry answer|did not answer/.test(e.message) ? 'timeout' : 'error', e.message); }
        finally { if (telWait === w) telWait = null; }
      },
      async sendData(n, text) {
        const s = k.session && k.session(); if (!s || !s.sendData) throw err('error', 'not connected to a MeshCore node');
        const raw = rawOf(n); if (!raw) throw err('error', 'the node no longer has that contact');
        return s.sendData(raw, text);
      },
      async discover(n) {
        const s = k.session && k.session(); if (!s || !s.discover) throw err('error', 'not connected to a MeshCore node');
        const raw = [...k.nodes()].find(x => x.key && String(x.key).toLowerCase() === n.key); if (!raw) throw err('error', 'the node no longer has that contact');
        const t0 = Date.now(), prefix = n.key.slice(0, 12);
        for (const w of discWait.splice(0)) { clearTimeout(w.timer); w.reject(err('cancelled', 'replaced by a newer discovery (the node keeps one at a time)')); }
        const p = new Promise((resolve, reject) => discWait.push({ prefix, resolve, reject, t0 }));
        let r; try { r = await s.discover(raw); } catch (e) { discWait.splice(0); throw err('error', e.message); }
        const w = discWait.find(x => x.prefix === prefix);
        if (w) w.timer = setTimeout(() => { const i = discWait.indexOf(w); if (i >= 0) discWait.splice(i, 1); w.reject(err('timeout', 'no answer -- out of reach, or it does not allow telemetry to you')); }, Math.min(60000, Math.max(25000, (r.timeout || 0) * 1.5)));
        return p;
      },
    };
    // mesh.js io.route events: a path-discovery answer settles the waiting discover()
    function route(e) {
      // a telemetry answer as the radio heard it: a RESPONSE (direct) or PATH (the path return of a flood) from them to us
      const tw = telWait, PT = window.KellyMeshCore && window.KellyMeshCore.PT;
      if (tw && e && e.kind === 'rx' && e.pkt && PT && (e.pkt.type === PT.RESPONSE || e.pkt.type === PT.PATH) && e.pkt.src === tw.src && (!tw.dest || e.pkt.dest === tw.dest))
        tw.rx = { snr: e.snr ?? null, rssi: e.rssi ?? null, flood: e.pkt.route === 'flood' };
      const pw = pingWait;
      if (pw && e && e.kind === 'sent' && (e.num >>> 0) === pw.num && !pw.ref) { pw.ref = e.ref; pw.flood = !!e.flood; }
      else if (pw && e && e.kind === 'sent' && e.ref === pw.ref) pw.flood = !!e.flood;
      if (pw && e && (e.kind === 'ack' || e.kind === 'noack') && e.ref && e.ref === pw.ref) {
        pingWait = null;
        if (e.kind === 'noack') return pw.reject(err('timeout', 'no ACK'));
        // after a flood DM the node re-reads the contact with the route it just learned: give it a moment
        setTimeout(() => { const raw = [...k.nodes()].find(x => (x.num >>> 0) === pw.num), o = raw && raw.outPath && raw.outPath.h ? { sz: raw.outPath.sz || 1, h: raw.outPath.h.slice() } : null;
          pw.resolve({ out: o, flood: pw.flood, ms: e.rtt ?? Date.now() - pw.t0 }); }, pw.flood ? 1500 : 0);
        return;
      }
      if (!e || e.kind !== 'discovery') return;
      const i = discWait.findIndex(w => e.prefix && e.prefix.toLowerCase() === w.prefix);
      if (i < 0) return;
      const [w] = discWait.splice(i, 1); clearTimeout(w.timer);
      w.resolve({ out: e.out, back: e.back, ms: e.rtt ?? Date.now() - w.t0 });
    }

    function link() {
      if (demoOn) return { online: !!sim, via: 'demo', why: sim ? null : 'demo not available' };
      const on = !!(k.online && k.online() && k.session && k.session() && k.session().trace);
      return { online: on, via: on ? live.via : 'none', why: on ? null : 'connect a MeshCore companion node (LoRa Mesh > Mesh tab), or turn on Demo' };
    }
    const driver = () => demoOn ? sim : link().online ? live : null;

    // Telemetry polling (js/tr-telem.js): the radio side of one world -- the demo sky or the real node. Both are kept, so
    // a real grant message that lands while the demo is on still reaches the real node's records.
    const demoFlags = new Map(); let demoBase = 1;
    function telemFor(demo) {
      const drv = () => demo ? sim : k.online && k.online() && k.session && k.session() ? live : null;
      const find = id => (demo ? (sim ? sim.nodes() : []) : liveNodes()).find(n => n.id === id || n.key === id);
      const need = id => { const d = drv(), n = find(id); if (!d) throw err('error', demo ? 'demo not available' : 'connect a MeshCore companion node first'); if (!n) throw err('error', 'that station is not a contact on your node any more'); return { d, n }; };
      const sess = () => { const s = k.session && k.session(); if (!s) throw err('error', 'connect a MeshCore companion node first'); return s; };
      return {
        demo, ready: () => { const d = drv(); return !!(d && d.telemetry && d.sendData); },
        nodes: () => (demo ? (sim ? sim.nodes() : []) : liveNodes()), node: find,
        myKey: () => demo ? (sim && sim.myKey ? sim.myKey() : null) : myKey(),
        request: async id => { const { d, n } = need(id); return d.telemetry(n); },
        send: async (id, text) => { const { d, n } = need(id); return d.sendData(n, text); },
        // flag 0x02 on OUR node for that contact: what lets them read our base telemetry (the device's allow-list)
        flag: id => { if (demo) return !!demoFlags.get(id); const n = find(id); return n && n.flags != null ? !!(n.flags & 2) : null; },
        flagged: () => demo ? [...demoFlags].filter(([, v]) => v).map(([id]) => id) : liveNodes().filter(n => n.flags != null && n.flags & 2).map(n => n.id),
        setFlag: async (id, on) => {
          if (demo) { demoFlags.set(id, !!on); return; }
          const s = sess(), n = find(id), raw = n && rawOf(n); if (!raw || !s.setContactFlag) throw err('error', 'Kelly has not read that contact from your node yet');
          await s.setContactFlag(raw, 0x02, !!on); memo = null;
        },
        base: () => { if (demo) return demoBase; const s = k.session && k.session(), t = s && s.telemetryModes ? s.telemetryModes() : null; return t ? t.base : null; },
        setBase: async m => { if (demo) { demoBase = m; return; } const s = sess(); if (!s.setTelemetryBase) throw err('error', 'this node cannot change its telemetry setting'); await s.setTelemetryBase(m); },
      };
    }

    const c = {
      bus, PJ, TR, $: k.$, esc: k.esc, store: k.store, toast: k.toast, fmtAgo: k.fmtAgo, fxLoop: k.fxLoop, audioCtx: k.audioCtx,
      fx: () => k.settings.fx !== false && !reduced(), reduced, visible: () => vis, root: () => root,
      radio: () => { const r = k.radio && k.radio(); return r && r.sf ? r : { freqMHz: 923.125, bwKHz: 62.5, sf: 8, cr: 5, demo: true }; },
      makeMap: k.makeMap || (() => null), myPos: () => { const m = me(); return m.lat != null ? { lat: m.lat, lon: m.lon } : null; },
      nodes, node, me, resolveHash, link, driver, demo: () => demoOn, setDemo: on => setDemo(!!on), selected: () => sel, telemFor,
      // the engine's API, forwarded (safe to call when the engine failed to load)
      trace: (id, opts) => engine ? engine.trace(id, opts || {}) : { ok: false, reason: 'the trace engine did not load' },
      cancel: id => engine && engine.cancel(id),
      canTrace: (id, opts) => engine ? engine.canTrace(id, opts || {}) : 'the trace engine did not load',
      limits: () => engine ? engine.limits() : null,
      current: () => engine ? engine.current() : null,
      claim: (id, method, via) => engine && engine.claim ? engine.claim(id, method, via) : null,   // the shared airtime budget
    };

    function make(factory, ...a) {
      if (typeof window[factory] !== 'function') return null;
      try { return window[factory](...a); } catch (e) { console.warn('Trace Route', factory, e); return null; }
    }

    function render() {
      root.innerHTML = `<div class="tr">
        <div class="card tr-head">
          <div class="tr-title"><h2>🔭 Trace Route</h2><span class="tr-mode" id="tr-modebadge">no node</span></div>
          <p class="dim small">Pick a station and trace the route to it and back. Each repeater on the way lights up as a star with the signal it heard; the brighter and thicker the beam, the stronger the hop.</p>
          <div class="tr-bar">
            <button class="btn" id="tr-demo-btn">🎲 Demo</button>
            <div id="tr-sound" class="tr-sound"></div>
            <span class="grow"></span>
            <button class="btn ghost" id="tr-fs" title="Full screen, for a projector or a club display">⛶ Full screen</button>
          </div>
        </div>
        <div class="tr-main">
          <div class="card tr-pick"><div id="tr-picker"></div></div>
          <div class="card tr-stage"><div id="tr-viz" class="tr-viz"></div><div id="tr-readout" class="tr-readout" role="status" aria-live="polite"></div></div>
        </div>
        <div id="tr-telem" class="tr-telem"></div>
        <div id="tr-history" class="tr-history"></div>
      </div>`;
      const $ = k.$;
      $('#tr-demo-btn').onclick = () => setDemo(!demoOn);
      $('#tr-fs').onclick = fullscreen;
      sim = make('KellyTRSim', c);
      if (!sim) $('#tr-demo-btn').hidden = true;
      else if (sim.onData) sim.onData((key, text) => bus.emit('tdata', { key, text, demo: true }));
      engine = make('KellyTREngine', c);
      parts.picker = make('KellyTRPicker', $('#tr-picker'), c);
      parts.viz = make('KellyTRViz', $('#tr-viz'), c);
      parts.sound = make('KellyTRSound', $('#tr-sound'), c);
      parts.telem = make('KellyTRTelem', $('#tr-telem'), c);
      parts.history = make('KellyTRHistory', $('#tr-history'), c);
      bus.on('select', s => { if (s && s.node) sel = s.node; });
      bus.on('run', readout); bus.on('done', readout);
      // a phone: the picker sits above the stage -- bring the stage into view when a trace starts
      bus.on('run', r => { if (r.phase === 'queued' && innerWidth < 900) { const s = root.querySelector('.tr-stage'); if (s && s.scrollIntoView) s.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); } });
      mode(); readout(null);
    }
    // the shell's own one-line status (screen readers; and the fallback if the canvas part is missing)
    function readout(r) {
      const el = root && root.querySelector('#tr-readout'); if (!el) return;
      if (!r) { const l = link(); el.textContent = l.online ? 'Pick a station to trace.' : l.why; return; }
      const hops = Math.max(0, r.out.length - 2), name = r.targetName || 'the station';
      el.textContent = r.status === 'pending' ? `${r.method === 'discover' ? 'Discovering a path' : r.method === 'ping' ? 'Pinging' : r.method === 'path' ? 'Checking the route' : 'Tracing'} to ${name}… (${r.phase}${r.tries > 1 ? `, try ${r.attempt} of ${r.tries}` : ''})`
        : r.status === 'success' && r.method === 'ping' ? `${name}: ACK back in ${(r.rttMs / 1000).toFixed(1)} s -- the message reached them${r.out.length > 2 ? ` (${hops} hop${hops === 1 ? '' : 's'} there)` : ''}`
        : r.status === 'success' && r.method === 'path' ? `${name}: ${hops} repeater${hops === 1 ? '' : 's'} on the way, ${(r.rttMs / 1000).toFixed(1)} s round trip${r.snrMin != null ? `, weakest hop ${r.snrMin.toFixed(1)} dB` : ''} (the last hop to them isn't measured)${r.changed ? ' -- the route changed' : ''}`
        : r.status === 'success' ? `${name}: ${hops} hop${hops === 1 ? '' : 's'} each way, ${(r.rttMs / 1000).toFixed(1)} s round trip${r.snrMin != null ? `, weakest hop ${r.snrMin.toFixed(1)} dB` : ''}${r.changed ? ' -- the route changed' : ''}`
          : `${name}: ${r.status === 'timeout' ? 'no answer (timed out)' : r.status === 'no-path' ? 'no path known' : r.status}${r.error ? ` -- ${r.error}` : ''}`;
      el.className = 'tr-readout ' + r.status;
    }
    function mode() {
      const m = root && root.querySelector('#tr-modebadge');   // not #tr-mode: that's the Transparent page's modulation select if (!m) return;
      const l = link();
      m.textContent = l.via === 'demo' ? 'demo' : l.via === 'sim-link' ? 'MeshCore Demo link' : l.online ? 'live' : 'no node';
      m.className = 'tr-mode ' + (l.via === 'demo' || l.via === 'sim-link' ? 'demo' : l.online ? 'live' : '');
      const b = root.querySelector('#tr-demo-btn'); if (b) { b.textContent = demoOn ? '⏹ Stop demo' : '🎲 Demo'; b.classList.toggle('primary', demoOn); }
      const sig = `${l.online}|${l.via}`;
      if (sig !== linkSig) {
        linkSig = sig; bus.emit('link', { online: l.online, via: l.via });
        // the node went away mid-run: end it now with the real reason (the driver would only time out later)
        if (!l.online && !demoOn) {
          for (const w of discWait.splice(0)) { clearTimeout(w.timer); w.reject(err('cancelled', 'link lost')); }
          if (pingWait) { pingWait.reject(err('cancelled', 'link lost')); pingWait = null; }
          const r = c.current(); if (r && r.status === 'pending' && r.via !== 'demo' && engine) engine.cancel(r.id, 'link lost -- the node disconnected');
        }
        if (!c.current()) readout(null);
      }
    }
    function setDemo(on) {
      if (!sim || on === demoOn) return;
      if (c.current() && c.current().status === 'pending') c.cancel();
      demoOn = !!on; sel = null; memo = null;
      if (sim.start && on) sim.start(); if (sim.stop && !on) sim.stop();
      bus.emit('demo', demoOn); nodesSig = ''; nodesChanged(); mode(); readout(null);
    }
    function nodesChanged() {
      // cheap signature: re-emit 'nodes' only when the list really changed (mesh.js dirties on every packet)
      const sig = nodes().map(n => `${n.id}:${n.lastHeard || 0}:${n.hops ?? ''}:${n.lat ?? ''}`).join(',');
      if (sig !== nodesSig) { nodesSig = sig; bus.emit('nodes'); }
    }
    function fullscreen() {
      const el = root.querySelector('.tr');
      if (document.fullscreenElement) return document.exitFullscreen();
      if (el.classList.contains('tr-fs')) { el.classList.remove('tr-fs'); return bus.emit('visible', vis); }
      const fallback = () => { el.classList.add('tr-fs'); bus.emit('visible', vis); };
      if (el.requestFullscreen) el.requestFullscreen().catch(fallback); else fallback();
    }
    function checkVis() {
      const v = !!(root && root.offsetParent !== null && !document.hidden);
      if (v !== vis) { vis = v; bus.emit('visible', v); if (v) nodesChanged(); }
    }

    return window.kellyTraceRoute = {   // for the console / test drivers, like window.kellyMeshPaths
      init() {
        root = document.getElementById('tr-root'); if (!root) return;
        render();
        document.addEventListener('visibilitychange', checkVis);
        document.addEventListener('fullscreenchange', () => setTimeout(() => bus.emit('visible', vis), 50));
        setInterval(() => { checkVis(); mode(); if (vis) nodesChanged(); }, 1000);
        if (/[?&#]tr-demo\b/.test(location.href)) setTimeout(() => setDemo(true), 400);   // index.html#tr-demo: club displays, tests
      },
      shown() { setTimeout(checkVis, 30); },
      hidden() { setTimeout(checkVis, 30); },
      route, nodesChanged,
      // mesh.js io.cli: a CLI-data DM -> the sender's contact key + text, for Telemetry polling's grant messages
      cli(m) {
        if (!m || !m.prefix || !/^KT1 /.test(String(m.text || ''))) return;
        const p = String(m.prefix).toLowerCase(), hits = liveNodes().filter(n => n.key && n.key.startsWith(p));
        if (hits.length === 1) bus.emit('tdata', { key: hits[0].key, text: m.text, demo: false });
      },
      // Ham Contacts' Trace / Ping buttons: select that station (live, not the demo sky) and, given a method, start the
      // run -- the engine's limits apply, and a live ping asks the same one-time consent the picker does -> { ok, reason? }
      focus(key, method) {
        if (demoOn) setDemo(false);
        memo = null;
        const n = node(String(key || '').toLowerCase());
        if (!n) return { ok: false, reason: 'that station is not in Trace Route\'s list yet -- it needs to be a contact your node has a key for' };
        sel = n.id; bus.emit('select', { node: n.id, from: 'contacts' });
        if (!method) return { ok: true };
        if (method === 'ping' && !k.store.get('trPingOk', false)) {
          if (!confirm(`Ping sends a short message to ${n.name}'s inbox ("Trace Route ping -- no reply needed") and waits for the ACK. It shows in your chat too.\n\nSend pings? (Kelly won't ask again.)`)) return { ok: false, reason: 'ping not sent' };
          k.store.set('trPingOk', true);
        }
        return c.trace(n.id, { method });
      },
      // the rest of Kelly (the node panel's Trace button, Mesh Paths) spends from the same airtime budget:
      // -> null (go, it's counted) or why not. key = the station's MeshCore key.
      claim: (key, method) => engine && engine.claim ? engine.claim(String(key || '').toLowerCase(), method, link().online ? live.via : 'live') : null,
      _c: c, _telem: () => parts.telem,   // tests
    };
  };
})();
