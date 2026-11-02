/* Kelly Page -- LoRa Mesh > 🔭 Trace Route: tr-sim, a made-up SEQ MeshCore mesh for demo mode (2026-10-24, unreleased).
 * Coded against js/tr-core.js and the context `c` -- see TRACE_ROUTE_PLAN.md, row 1. It answers only through the
 * Driver interface the engine uses for a real companion:
 *
 * window.KellyTRSim(c, opts?) -> { via: 'demo', nodes() -> [StationNode], me(), trace(node, route), discover(node), ping(node),
 *   tracePath(node, route), telemetry(node), sendData(node, text), onData(fn(key, text)), myKey(), start(), stop(), destroy() }
 *   (the last five: Telemetry polling, js/tr-telem.js -- see "the far Kellys" below)
 * opts (tests): { timers: { now(), setTimeout, clearTimeout, setInterval, clearInterval }, seed, loss (0..1, default 0.1) }
 *
 * The world: our node at Ipswich, 13 stations around Ipswich / Brisbane / Toowoomba / the Gold and Sunshine Coasts,
 * real-looking 32-byte keys (seeded, so the same every load), mixed roles. Flinders Peak and Tamborine share a 1-byte
 * hash (so a hop on that hash is a nameless star); Bunya Mountains went quiet two days ago (unreachable); Romeo's
 * companion refuses telemetry (discovery stays silent); Buderim has no known route but we're logged in to it, so a
 * discovery answers and Auto then traces it. SNRs are a per-link base (-12..+12) plus jitter, RTT comes from the
 * airtime model (TR.hopMs) with the forwarding delay's randomness, ~10% of traces are lost, and now and then a station
 * with two ways in switches route (outPath / inbound follow, so the next trace shows "route changed").
 * Tamborine adverts with 1-byte path hashes and the Gold Coast companion sends 1-byte messages (StationNode.sends), as
 * Kelly's hash-size check would report them. A ping (DM + ACK) reaches a companion that's up along its route (by flood
 * when no route is known yet -- then it learns one).
 * Timings are real time (setTimeout): a few seconds per trace, like the real thing on a quiet SF8 mesh.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tr-core.js'), require('./tr-grants.js'));
  else root.KellyTRSim = factory(root.KellyTR || null, root.KellyTRGrants || null);
})(typeof self !== 'undefined' ? self : this, function (TR0, G0) {
  'use strict';

  // name, role, lat, lon, via (repeater indices from us outward), alt (another way in), snr (its last link), flags
  const WORLD = [
    ['VK4RBX Flinders Peak', 'repeater', -27.8140, 152.8120, [], null, 7.5, { learned: 1 }],
    ['Mt Coot-tha Rpt', 'repeater', -27.4752, 152.9490, [], null, 3.0, { learned: 1 }],
    ['Mt Glorious Rpt', 'repeater', -27.3330, 152.7650, [1], null, 5.5, { learned: 1 }],
    ['Toowoomba Picnic Pt', 'repeater', -27.5780, 151.9730, [1, 2], [0], -4.5, { inbound: 1 }],
    ['Springbrook Rpt', 'repeater', -28.2260, 153.2760, [0], null, 2.0, { learned: 1 }],
    ['Tamborine Mtn Rpt', 'repeater', -27.9220, 153.1900, [0], [1], -1.0, { learned: 1, collide: 0, sends: { size: 1, strength: 'certain' } }],
    ['Buderim SunCoast Rpt', 'repeater', -26.6840, 153.0500, [1, 2], null, -7.0, { login: 1 }],
    ['SEQ Chat Room', 'room', -27.4680, 153.0250, [1], null, 6.0, { inbound: 1 }],
    ['Bunya Mtns Rpt', 'repeater', -26.8750, 151.5980, [1, 2, 3], null, -10.5, { learned: 1, dead: 1 }],
    ['VK4ZB Bravo mobile', 'companion', -27.6400, 152.9000, [1], null, 1.5, { inbound: 1, tele: 1 }],
    ['VK4ZR Romeo', 'companion', -27.5600, 152.6200, [], null, 9.0, { inbound: 1 }],
    ['Gatton WX sensor', 'sensor', -27.5560, 152.2780, [1, 2], null, -3.0, { tele: 1 }],
    ['VK4ZQ Gold Coast', 'companion', -28.0000, 153.4300, [0, 4], null, -5.5, { inbound: 1, tele: 1, sends: { size: 1, strength: 'likely' } }],
  ];
  const ME = { lat: -27.6265, lon: 152.7663, name: 'VK4XXX Kelly (demo)' };
  const ROLE_ID = { companion: 1, repeater: 2, room: 3, sensor: 4 };

  function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const hex2 = n => n.toString(16).padStart(2, '0');
  function km(a, b) {
    const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(x)) * 10) / 10;
  }

  return function KellyTRSim(c, opts) {
    opts = opts || {};
    const TR = (c && c.TR) || TR0;
    if (!TR) return null;
    const T = opts.timers || { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h),
      setInterval: (f, ms) => setInterval(f, ms), clearInterval: h => clearInterval(h) };
    const keyRand = mulberry(opts.seed || 0x4b454c59), rand = opts.rand || mulberry((opts.seed || 0x4b454c59) ^ (Date.now() & 0xffff));
    const LOSS = opts.loss != null ? opts.loss : 0.1;
    const err = (code, msg) => Object.assign(new Error(msg), { code });
    const radio = () => { try { return c && c.radio ? c.radio() : null; } catch { return null; } };
    const jitter = (s = 1.2) => (rand() + rand() + rand() - 1.5) * s;   // ~normal, +-1.8 dB at most
    const now0 = T.now();

    // ---------------------------------------------------------------- stations (keys seeded: the same world every load)
    const used = new Set();
    const st = WORLD.map(([name, role, lat, lon, via, alt, snr, f], i) => {
      let key;
      do { key = Array.from({ length: 32 }, () => hex2(Math.floor(keyRand() * 256))).join(''); } while (f.collide == null && used.has(key.slice(0, 2)));
      used.add(key.slice(0, 2));
      return { i, name, role, lat, lon, via: via.slice(), alt: alt ? alt.slice() : null, snr, f: Object.assign({}, f), key,
        learned: !!f.learned, inboundKnown: !!(f.inbound || f.learned), lastHeard: f.dead ? now0 - 2 * 86400e3 - 3600e3 * (1 + i) : now0 - Math.round((20 + i * 37) * 1000 * (1 + keyRand() * 6)),
        heardSnr: snr };
    });
    st.forEach(s => { if (s.f.collide != null) { const o = st[s.f.collide]; s.key = o.key.slice(0, 2) + s.key.slice(2); } });
    const ME_KEY = Array.from({ length: 32 }, () => hex2(Math.floor(keyRand() * 256))).join('');

    // links: us <-> the first hop, along each via (and alt) chain, and the last hop <-> the station.
    // A link's SNR base is the station's own snr for its last hop, else seeded -6..+10; a little asymmetry each way.
    const linkBase = new Map(), lk = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;   // -1 = us
    function addChain(s, chain) {
      const seq = [-1, ...chain, s.i];
      for (let j = 1; j < seq.length; j++) {
        const k = lk(seq[j - 1], seq[j]);
        if (!linkBase.has(k)) linkBase.set(k, j === seq.length - 1 ? s.snr : Math.round((keyRand() * 16 - 6) * 2) / 2);
      }
    }
    st.forEach(s => { addChain(s, s.via); if (s.alt) addChain(s, s.alt); });
    const asym = (a, b) => ((a * 7 + b * 13 + 40) % 5 - 2) * 0.4;
    const up = (a, b) => linkBase.has(lk(a, b)) && !(a >= 0 && st[a].f.dead) && !(b >= 0 && st[b].f.dead);
    const heard = (from, to) => Math.max(-14, Math.min(13, linkBase.get(lk(from, to)) + asym(from, to) + jitter()));

    const sz1 = s => s.key.slice(0, 2);
    const hashOf = (s, sz) => s.key.slice(0, (sz || 1) * 2);
    function station(s) {
      const r = s.role, key = s.key, canTrace = r === 'repeater' || r === 'room';
      const known = s.learned || s.inboundKnown;
      return { id: key, num: parseInt(key.slice(0, 8), 16) >>> 0, key, name: s.name, role: r, roleId: ROLE_ID[r] || 0,
        lat: s.lat, lon: s.lon, lastHeard: s.lastHeard, snr: Math.round(s.heardSnr * 4) / 4, rssi: Math.round(-118 + s.heardSnr * 2.5 + 8),
        hops: known ? s.via.length : null, outPath: s.learned ? { sz: 1, h: s.via.map(j => sz1(st[j])) } : null,
        inbound: s.inboundKnown ? { sz: 1, h: s.via.map(j => sz1(st[j])).reverse(), t: s.lastHeard } : null, fav: s.i === 0 || s.i === 3,
        km: km(ME, s), canTrace, canDiscover: true, canPing: r === 'companion', sends: s.f.sends || null,
        why: canTrace ? null : r === 'companion' ? 'a companion can\'t be traced (it doesn\'t repeat). Discover only answers if its owner turned telemetry on (off by default) -- Ping sends a short message and waits for the ACK.'
          : 'not a repeater or room server: path discovery only (it must allow telemetry to you)' };
    }
    const byId = id => st.find(s => s.key === String(id || '').toLowerCase());

    // occasionally a station with two ways in swaps routes (outPath / inbound follow) -- the next trace says "route changed"
    function maybeReroute(p) {
      if (rand() >= p) return;
      const two = st.filter(s => s.alt && !s.f.dead);
      if (!two.length) return;
      const s = two[Math.floor(rand() * two.length)], v = s.via; s.via = s.alt; s.alt = v;
    }

    // ---------------------------------------------------------------- pending answers (stop / destroy reject them)
    const pend = new Set();
    function answer(ms, fn) {
      return new Promise((resolve, reject) => {
        const w = { reject, h: null };
        w.h = T.setTimeout(() => { pend.delete(w); try { const r = fn(); if (r instanceof Error) reject(r); else resolve(r); } catch (e) { reject(err('error', e.message)); } }, Math.max(0, Math.round(ms)));
        pend.add(w);
      });
    }
    function rejectAll(code, msg) { for (const w of [...pend]) { T.clearTimeout(w.h); pend.delete(w); w.reject(err(code, msg)); } }

    const traceBytes = (k, sz) => 11 + (2 * k + 1) * (sz + 1);
    const spread = () => 0.7 + rand() * 0.6;   // the forwarding node's random retransmit delay
    let discW = null;
    const q4 = x => Math.round(x * 4) / 4;   // the firmware's SNR*4 bytes
    // walk a hash list from us: the node with each hash that heard the one before (a 1-byte collision: whichever one is
    // in range) adds the SNR it heard; then we hear the last -> { ok, snrs, fin }
    function walk(list) {
      let prev = -1, ok = rand() >= LOSS;
      const snrs = [];
      for (let j = 0; ok && j < list.length; j++) {
        const cand = st.find(x => (x.role === 'repeater' || x.role === 'room') && x.key.startsWith(list[j]) && up(prev, x.i));
        if (!cand) { ok = false; break; }
        const v = heard(prev, cand.i); if (v < -12.5 && rand() < 0.6) { ok = false; break; }   // under the demod floor
        snrs.push(v); prev = cand.i;
      }
      if (ok && !up(prev, -1)) ok = false;
      return { ok, snrs, fin: ok ? heard(prev, -1) : 0 };
    }

    // ---------------------------------------------------------------- Telemetry polling (js/tr-telem.js): the far Kellys
    // VK4ZB Bravo runs Kelly: approves a request, and asks to poll us himself (offering his) 12 s into the demo. VK4ZQ runs
    // Kelly and declines. VK4ZR Romeo has no Kelly: grant messages go unanswered. A station answers a telemetry request only
    // once it has granted us -- as the firmware does with base mode 1 and our flag set.
    const G = G0;
    const allow = new Set(), kellys = { 'VK4ZB Bravo mobile': 'approve', 'VK4ZQ Gold Coast': 'decline' };
    let onData = null, offerTimer = null, offered = false;
    const batt = new Map(), timers = new Set();   // station index -> volts (a slow random walk); pending far-Kelly messages
    function deliver(s, msg, ms) { const h = T.setTimeout(() => { timers.delete(h); if (onData && G) try { onData(s.key, G.encode(msg)); } catch { /* */ } }, ms); timers.add(h); }
    function farKelly(s, text) {
      const how = kellys[s.name], m = G && G.parse(text);
      if (!how || !m || m.op === 'ACK' || s.f.dead) return;
      deliver(s, { op: 'ACK', id: m.id }, 900 + rand() * 900);
      if (m.op === 'REQ') {
        if (m.offer) allow.add(s.key);   // never polled back in the demo; the offer only shows
        if (how === 'approve') { allow.add(s.key); deliver(s, { op: 'OK', id: m.id, from: s.key, to: ME_KEY }, 3500 + rand() * 2500); }
        else deliver(s, { op: 'NO', id: m.id }, 4000 + rand() * 2500);
      } else if (m.op === 'DROP' || m.op === 'NO') allow.delete(s.key);   // NO to his swap request: he withdraws his offer
    }

    const sim = {
      via: 'demo',
      nodes: () => st.map(station),
      me: () => ({ id: 'me', name: ME.name, lat: ME.lat, lon: ME.lon, hashSize: 2, key: ME_KEY }),

      // direct along route.h, to the target, and back along the reverse: every listed node that hears the one before
      // forwards and adds the SNR it heard. Silence (reject 'timeout' after the wait) when any hop is missing.
      trace(node, route) {
        const s = node && byId(node.id || node.key);
        if (!s) return Promise.reject(err('error', 'the node no longer has that contact'));
        if (s.role !== 'repeater' && s.role !== 'room') return Promise.reject(err('error', 'MeshCore traces go through repeaters: pick a repeater or room server'));
        const sz = route && route.sz === 2 ? 2 : 1, out = (route && route.h ? route.h : []).map(h => String(h).toLowerCase().slice(0, sz * 2));
        const list = [...out, hashOf(s, sz), ...out.slice().reverse()], k = out.length;
        const per = TR.hopMs(traceBytes(k, sz), radio());
        maybeReroute(0.06);
        const { ok, snrs, fin } = walk(list);
        if (!ok) return answer(Math.min(9000, 5500 + 700 * k), () => err('timeout', `no trace answer from ${s.name} -- out of range, or a hop on its route is down`));
        let ms = 120; for (let j = 0; j < list.length + 1; j++) ms += per * spread();
        return answer(ms, () => {
          s.lastHeard = T.now(); s.heardSnr = snrs[k];
          return { out, back: out.slice().reverse(), snrTowards: snrs.slice(0, k + 1).map(q4), snrBack: [...snrs.slice(k + 1), fin].map(q4), ms: Math.round(ms) };
        });
      },

      // a companion's route, traced to its last repeater and back (it won't forward a trace itself)
      tracePath(node, route) {
        const s = node && byId(node.id || node.key);
        if (!s) return Promise.reject(err('error', 'the node no longer has that contact'));
        const sz = route && route.sz === 2 ? 2 : 1, out = (route && route.h ? route.h : []).map(h => String(h).toLowerCase().slice(0, sz * 2));
        if (!out.length) return Promise.reject(err('error', 'a direct neighbour: nothing to trace'));
        const list = TR.pathList(out), per = TR.hopMs(traceBytes(out.length - 1, sz), radio());
        const { ok, snrs, fin } = walk(list);
        if (!ok) return answer(Math.min(9000, 5000 + 700 * out.length), () => err('timeout', 'no trace answer -- out of range, or a hop on the route is down'));
        let ms = 120; for (let j = 0; j < list.length + 1; j++) ms += per * spread();
        return answer(ms, () => Object.assign(TR.pathShape(out, snrs.map(q4), q4(fin)), { ms: Math.round(ms) }));
      },

      // a base telemetry request (CMD 39): answered only by a station that granted us -> { lpp, rx: { snr, rssi, hops } }
      telemetry(node) {
        const s = node && byId(node.id || node.key);
        if (!s) return Promise.reject(err('error', 'the node no longer has that contact'));
        const k = s.via.length, per = TR.hopMs(40, radio());
        const answers = allow.has(s.key) && !s.f.dead && s.via.every(j => !st[j].f.dead) && rand() >= LOSS;
        const ms = answers ? 300 + (k + 1) * per * 2 * spread() : 9000;
        return answer(ms, () => {
          if (!answers) return err('timeout', 'no telemetry answer -- out of range, or it does not allow telemetry to you');
          s.learned = true; s.inboundKnown = true; s.lastHeard = T.now();
          const v = Math.max(3.45, Math.min(4.19, (batt.get(s.i) ?? 3.92 + rand() * 0.2) - 0.004 + jitter(0.006)));
          batt.set(s.i, v);
          const snr = q4(heard(s.via.length ? s.via[0] : s.i, -1));
          return { lpp: [{ ch: 1, type: 116, name: 'voltage', value: Math.round(v * 100) / 100, unit: 'V' }, { ch: 1, type: 103, name: 'temperature', value: Math.round((26 + jitter(2)) * 10) / 10, unit: '°C' }],
            rx: { snr, rssi: Math.round(-118 + snr * 2.5 + 8), hops: k }, ms: Math.round(ms) };
        });
      },
      // a CLI-data DM to a companion (grant messages): the far Kelly, if there is one, answers through onData(key, text)
      sendData(node, text) {
        const s = node && byId(node.id || node.key);
        if (!s) return Promise.reject(err('error', 'the node no longer has that contact'));
        farKelly(s, text);
        return answer(80, () => ({ flood: !s.learned }));
      },
      onData(fn) { onData = fn; },
      myKey: () => ME_KEY,

      // a flood base-telemetry request: answered (with both routes, no SNR) by stations that allow telemetry to us --
      // companions / sensors with it open, repeaters / rooms we're logged in to. One pending at a time.
      discover(node) {
        const s = node && byId(node.id || node.key);
        if (!s) return Promise.reject(err('error', 'the node no longer has that contact'));
        if (discW) { const w = discW; discW = null; T.clearTimeout(w.h); pend.delete(w); w.reject(err('cancelled', 'replaced by a newer discovery (the node keeps one at a time)')); }
        const answers = !s.f.dead && (s.f.tele || s.f.login) && s.via.every(j => !st[j].f.dead) && rand() >= LOSS / 2;
        const k = s.via.length, perF = TR.hopMs(48, radio()), perD = TR.hopMs(40, radio());
        const ms = answers ? 300 + (k + 1) * perF * 1.6 * spread() + (k + 1) * perD * spread() : 9000;
        const p = answer(ms, () => {
          if (!answers) return err('timeout', 'no answer -- out of reach, or it does not allow telemetry to you');
          s.learned = true; s.inboundKnown = true; s.lastHeard = T.now();
          const h = s.via.map(j => sz1(st[j])), back = (s.alt && rand() < 0.3 ? s.alt : s.via).map(j => sz1(st[j])).reverse();
          return { out: { sz: 1, h }, back: { sz: 1, h: back }, ms: Math.round(ms) };
        });
        discW = [...pend].pop();
        p.then(() => { discW = null; }, () => {});
        return p;
      },

      // a short DM + its ACK (companions): along its learned route, else by flood (which teaches the route)
      ping(node) {
        const s = node && byId(node.id || node.key);
        if (!s) return Promise.reject(err('error', 'the node no longer has that contact'));
        if (s.role !== 'companion') return Promise.reject(err('error', 'only companions take a ping'));
        const flood = !s.learned, k = s.via.length, per = TR.hopMs(60, radio());
        const answers = !s.f.dead && s.via.every(j => !st[j].f.dead) && rand() >= LOSS;
        const ms = answers ? 250 + (k + 1) * per * 2 * spread() : 9000;
        return answer(ms, () => {
          if (!answers) return err('timeout', 'no ACK');
          s.learned = true; s.inboundKnown = true; s.lastHeard = T.now();
          return { out: { sz: 2, h: s.via.map(j => hashOf(st[j], 2)) }, flood, ms: Math.round(ms) };
        });
      },

      // background life while demo is on: someone is heard every ~12 s, the odd route change
      start() {
        if (tick) return;
        const bravo = st.find(s => kellys[s.name] === 'approve');
        if (bravo && !offered && G) offerTimer = T.setTimeout(() => { offerTimer = null; offered = true; allow.add(bravo.key); deliver(bravo, { op: 'REQ', id: G.newId(rand), from: bravo.key, to: ME_KEY, offer: true }, 0); }, 12000);
        tick = T.setInterval(() => {
          const live = st.filter(s => !s.f.dead), s = live[Math.floor(rand() * live.length)];
          s.lastHeard = T.now(); s.heardSnr = Math.max(-14, Math.min(13, s.snr + jitter(1.5)));
          maybeReroute(0.04);
        }, 12000);
      },
      stop() { if (tick) T.clearInterval(tick); tick = null; rejectAll('cancelled', 'demo stopped'); discW = null;
        if (offerTimer) { T.clearTimeout(offerTimer); offerTimer = null; } for (const h of timers) T.clearTimeout(h); timers.clear(); },
      destroy() { sim.stop(); },
      _world: st,   // tests
    };
    let tick = null;
    return sim;
  };
});
