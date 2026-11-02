/* Kelly Page -- LoRa Mesh > Packet Journey: pj-demo (2026-10-24, unreleased). Made-up MeshCore traffic for the tab.
 *
 * A pretend South-East-Queensland mesh (hill-top repeaters, callsign companions, a room server, a sensor) that
 * produces REAL MeshCore bytes -- the Packet::writeTo() layout js/mcdecode.js parses:
 *   header (route | type << 2 | ver << 6) [transport codes 2 x u16] path_len ((hashSize - 1) << 6 | hops) path payload
 * Every kind is made: ADVERT, GRP_TXT (on KellyPJ.DEMO_CHANNEL so it decrypts, plus some on a channel we don't hold),
 * GRP_DATA, TXT_MSG, ACK, MULTIPART, PATH, TRACE, REQ, RESPONSE, ANON_REQ, CONTROL, RAW_CUSTOM. Keys are fake (sha256 of
 * the node's name), signatures are filler -- nothing here is signed or would be accepted by a real node.
 * Fed through c.ingest({ raw, snr, rssi, demo: true }); paused while the tab is hidden (bus 'visible').
 *
 * window.KellyPJDemo(c) -> { start(), stop(), running() }
 * KellyPJDemo._engine(D, channel, seed) -> { nodes, next() -> [{ dt, raw, snr, rssi, type }] }   pure, for the tests
 * (UMD: require('./pj-demo.js') in Node gives the same function.)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KellyPJDemo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- the pretend mesh
  // role: 1 companion, 2 repeater, 3 room server, 4 sensor. gps: advertises its location. near: repeaters it reaches.
  const NODES = [
    { id: 'cootha', name: 'Mt Coot-tha Rptr', role: 2, lat: -27.4755, lon: 152.9580, gps: true },
    { id: 'glorious', name: 'Mt Glorious Rptr', role: 2, lat: -27.3330, lon: 152.7620, gps: true },
    { id: 'springbrook', name: 'Springbrook Rptr', role: 2, lat: -28.2180, lon: 153.2750, gps: true },
    { id: 'ipswich', name: 'Ipswich Rptr', role: 2, lat: -27.6265, lon: 152.7663, gps: true },
    { id: 'toowoomba', name: 'Toowoomba Rptr', role: 2, lat: -27.5600, lon: 151.9500, gps: true },
    { id: 'tamborine', name: 'Tamborine Rptr', role: 2, lat: -27.9700, lon: 153.1900, gps: true },
    { id: 'gravatt', name: 'Mt Gravatt Rptr', role: 2, lat: -27.5410, lon: 153.0790, gps: false },
    { id: 'abc', name: 'VK4ABC Mobile', role: 1, lat: -27.9980, lon: 153.4300, gps: true, home: 'springbrook' },
    { id: 'xyz', name: 'VK4XYZ Home', role: 1, lat: -27.4700, lon: 153.0200, gps: false, home: 'cootha' },
    { id: 'def', name: 'VK4DEF Portable', role: 1, lat: -27.3600, lon: 152.7900, gps: true, home: 'glorious' },
    { id: 'ghi', name: 'VK4GHI Shack', role: 1, lat: -27.5800, lon: 151.9600, gps: false, home: 'toowoomba' },
    { id: 'klm', name: 'VK4KLM Gold Coast', role: 1, lat: -28.0170, lon: 153.4000, gps: true, home: 'tamborine', hs: 1 },   // old firmware: 1-byte hashes
    { id: 'nop', name: 'VK4NOP Ipswich', role: 1, lat: -27.6205, lon: 152.7763, gps: false, home: 'ipswich' },
    { id: 'room', name: 'SEQ Mesh Room', role: 3, lat: -27.4800, lon: 152.9700, gps: true, home: 'cootha' },
    { id: 'sensor', name: 'Wivenhoe Weather Stn', role: 4, lat: -27.3940, lon: 152.6080, gps: true, home: 'glorious' },
  ];
  // repeater links (both ways). Our node (Ipswich-ish) hears Ipswich strong, Coot-tha fair, Mt Gravatt weak.
  const LINKS = [['toowoomba', 'ipswich'], ['toowoomba', 'glorious'], ['glorious', 'cootha'], ['glorious', 'ipswich'], ['ipswich', 'cootha'],
    ['springbrook', 'tamborine'], ['tamborine', 'gravatt'], ['tamborine', 'cootha'], ['gravatt', 'cootha']];
  const HEARD = { ipswich: { rssi: -64, snr: 10 }, cootha: { rssi: -91, snr: 4 }, gravatt: { rssi: -112, snr: -7 } };
  const CHAT = [
    'Morning all from the Gold Coast', 'Net check-in, VK4 mesh net, all welcome', 'Anyone copy from Toowoomba?', 'Good signal into Coot-tha this morning',
    'Storm cell coming over Mt Glorious, rain soon', '24 deg and sunny in Ipswich', 'Thanks for the relay!', 'QSL, 73 and good DX',
    'Testing new antenna on the roof, reports please', 'Heading up Springbrook for a portable session', 'Coffee at the club Saturday?',
    'Copy you 5 by 9 via Tamborine', 'Net closing, thanks everyone, 73', 'Battery on the solar node looks good today', 'Is the Ipswich repeater back up?',
    'Hearing you via 3 hops, nice', 'Fog on the range, visibility 50 m', 'Ham fest next month, who is going?', 'Just set up 2-byte path hashes, much better',
    'G\'day from the Bunya Mountains road', 'Wind picking up at Wivenhoe', 'SOTA activation on Mt Tamborine shortly', 'Signal report please, running 22 dBm',
  ];
  const OTHER_CHAT = ['(private channel)'];

  // ---------------------------------------------------------------- the engine (pure; D = KellyMcDecode)
  function engine(D, channel, seed) {
    let s = (seed >>> 0) || 1;
    const rnd = () => { s = s + 0x6D2B79F5 >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const pick = a => a[Math.floor(rnd() * a.length)];
    const bytes = n => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = ri(0, 255); return o; };
    const enc = t => new TextEncoder().encode(t);
    const u32 = (a, v) => { v = v | 0; a.push(v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255); };
    const now = () => Math.floor(Date.now() / 1000);

    const byId = {}, nodes = NODES.map(n => {
      const key = D.sha256(enc('pj-demo node ' + n.name));
      return byId[n.id] = Object.assign({}, n, { key, keyHex: D.hex(key) });
    });
    const reps = nodes.filter(n => n.role === 2), adj = {};
    for (const r of reps) adj[r.id] = [];
    for (const [a, b] of LINKS) { adj[a].push(b); adj[b].push(a); }
    const other = { name: '#seq-private', secret: D.sha256(enc('pj-demo private channel')).subarray(0, 16) };

    // a random shortest-ish route over repeaters from -> to (BFS with shuffled neighbours), ids inclusive
    function route(from, to) {
      const prev = { [from]: null }, q = [from];
      while (q.length) {
        const x = q.shift(); if (x === to) break;
        for (const y of adj[x].slice().sort(() => rnd() - 0.5)) if (!(y in prev)) { prev[y] = x; q.push(y); }
      }
      const out = []; for (let x = to; x != null; x = prev[x]) out.unshift(x);
      return out;
    }
    const hashOf = (id, hs) => byId[id].key.subarray(0, hs);
    // Packet::writeTo
    function pack(type, rt, pathBytes, pathLenByte, payload, transport) {
      const a = [(rt & 3) | (type & 15) << 2];
      if (rt === 0 || rt === 3) { const t = transport || [ri(0, 65535), ri(0, 65535)]; a.push(t[0] & 255, t[0] >> 8, t[1] & 255, t[1] >> 8); }
      a.push(pathLenByte); for (const b of pathBytes) a.push(b); for (const b of payload) a.push(b);
      return Uint8Array.from(a);
    }
    function withPath(type, flood, ids, hs, payload) {
      const pb = []; for (const id of ids) pb.push(...hashOf(id, hs));
      const rt = flood ? (rnd() < 0.04 ? 0 : 1) : 2;
      return pack(type, rt, pb, (hs - 1) << 6 | ids.length, payload);
    }
    const sig = (n, ts) => { const a = D.sha256(Uint8Array.from([...n.key, ts & 255, ts >> 8 & 255])), b = D.sha256(a), o = new Uint8Array(64); o.set(a); o.set(b, 32); return o; };
    const hsOf = n => n.hs || 2;
    const rssiSnr = last => {
      const h = HEARD[last] || { rssi: -100, snr: -2 };
      return { rssi: Math.max(-125, Math.min(-45, h.rssi + ri(-6, 6))), snr: Math.max(-16, Math.min(12, Math.round((h.snr + (rnd() * 4 - 2)) * 4) / 4)) };
    };
    const heardList = Object.keys(HEARD);

    // A flood from origin node n: copies heard via 1-3 of our repeaters, each with its own path. -> [{ dt, raw, ... }]
    function flood(type, n, payloadFn, opts = {}) {
      const hs = opts.hs || hsOf(n), out = [];
      const start = n.role === 2 ? n.id : n.home;
      const lasts = heardList.slice().sort(() => rnd() - 0.5).slice(0, opts.copies || ri(1, 3));
      let dt = 0;
      for (const last of lasts) {
        let ids = route(start, last);
        if (n.role === 2) ids = ids.slice(1);   // a repeater's own flood: the first hash is the next one to repeat it
        if (n.role === 2 && n.id === last) ids = [];
        const raw = withPath(type, true, ids, hs, payloadFn());
        out.push(Object.assign({ dt, raw, type: D.TYPES[type] }, rssiSnr(ids.length ? last : n.id === last ? last : start)));
        dt = ri(150, 900);
      }
      return out;
    }
    // A direct packet passing us: some hops still to go
    function direct(type, payload, hs = 2) {
      const a = pick(reps).id, b = pick(reps).id, ids = route(a, b).slice(1, 4);
      const raw = withPath(type, false, ids, hs, payload);
      return Object.assign({ dt: 0, raw, type: D.TYPES[type] }, rssiSnr(pick(heardList)));
    }
    const addr = (dst, src, mac = true) => [dst.key[0], src.key[0], ...(mac ? bytes(2) : [])];
    const companions = nodes.filter(n => n.role === 1);

    // ---- payloads
    function advertPayload(n) {
      const ts = now() - ri(0, 20), a = [...n.key]; u32(a, ts); a.push(...sig(n, ts));
      a.push(n.role | (n.gps ? 0x10 : 0) | 0x80);
      if (n.gps) { u32(a, Math.round(n.lat * 1e6)); u32(a, Math.round(n.lon * 1e6)); }
      a.push(...enc(n.name));
      return a;
    }
    function grpPayload(ch, plain) { return [D.channelHash(ch.secret), ...D.encryptThenMac(ch.secret, plain)]; }
    function chatPlain(n, text) { const p = []; u32(p, now()); p.push(0); p.push(...enc(`${n.name}: ${text}`)); return Uint8Array.from(p); }

    // ---- scenarios: each returns a list of packets with gaps (dt, ms after the previous one)
    const S = {
      advert() { const n = pick(nodes); return flood(4, n, () => advertPayload(n)); },
      chat() { const n = pick(companions.concat(byId.room)); const plain = chatPlain(n, pick(CHAT)); const pay = grpPayload(channel, plain); return flood(5, n, () => pay); },
      privateChat() { const n = pick(companions); const pay = grpPayload(other, chatPlain(n, pick(OTHER_CHAT) + ' ' + ri(1, 999))); return flood(5, n, () => pay); },
      grpData() { const n = byId.sensor; const d = bytes(ri(6, 20)), p = [0xff, 0xff, d.length, ...d];   /* BaseChatMesh.cpp sendGroupData: data_type u16 (0xffff = custom), data_len u8, data -- no timestamp */ const pay = grpPayload(channel, Uint8Array.from(p)); return flood(6, n, () => pay, { copies: 1 }); },
      dm() {
        const a = pick(companions), b = pick(companions.filter(x => x !== a));
        const out = flood(2, a, () => [...addr(b, a), ...bytes(16 * ri(1, 3))], { copies: ri(1, 2) });
        const ack = direct(3, bytes(4), hsOf(b)); ack.dt = ri(700, 2200); out.push(ack);
        if (rnd() < 0.3) { const m = direct(10, [0x13, ...bytes(4)]); m.dt = ri(200, 600); out.push(m); }
        return out;
      },
      dmDirect() { const a = pick(companions), b = pick(companions.filter(x => x !== a)); const p = direct(2, [...addr(b, a), ...bytes(16 * ri(1, 2))]); const ack = direct(3, bytes(4)); ack.dt = ri(600, 1800); return [p, ack]; },
      ack() { return rnd() < 0.5 ? [direct(3, bytes(4))] : flood(3, pick(companions), () => bytes(4), { copies: 1 }); },
      multipart() { return [direct(10, [(ri(0, 2) << 4) | 3, ...bytes(4)])]; },
      path() { const a = pick(companions), b = pick(companions.filter(x => x !== a)); return flood(8, b, () => [...addr(a, b), ...bytes(16 * ri(1, 2))], { copies: 1 }); },
      trace() {
        const ids = route(pick(['ipswich', 'cootha']), pick(reps).id).slice(0, 4), hs = rnd() < 0.85 ? 2 : 1;
        const hashes = []; for (const id of ids) hashes.push(...hashOf(id, hs));
        const pay = []; u32(pay, ri(0, 0x7fffffff)); pay.push(...bytes(4), hs === 2 ? 1 : 0, ...hashes);
        const nS = ri(1, ids.length), snr = []; for (let i = 0; i < nS; i++) snr.push(((ri(-40, 48)) & 255));
        return [Object.assign({ dt: 0, raw: pack(9, 2, snr, nS, pay), type: 'TRACE' }, rssiSnr(pick(heardList)))];
      },
      req() {
        const a = pick(companions), r = pick(reps.concat(byId.room, byId.sensor));
        const out = flood(0, a, () => [...addr(r, a), ...bytes(16)], { copies: 1 });
        const resp = direct(1, [...addr(a, r), ...bytes(16 * ri(1, 4))]); resp.dt = ri(500, 1600); out.push(resp);
        return out;
      },
      login() {
        const a = pick(companions), r = rnd() < 0.6 ? byId.room : pick(reps);
        const eph = D.sha256(enc('eph ' + a.name + ri(0, 1e6)));
        const out = flood(7, a, () => [r.key[0], ...eph, ...bytes(2), ...bytes(16)], { copies: 1 });
        const resp = direct(1, [...addr(a, r), ...bytes(16)]); resp.dt = ri(600, 1500); out.push(resp);
        return out;
      },
      discover() {
        const tag = ri(0, 0x7fffffff), q = [0x80, 0x04]; u32(q, tag); u32(q, now() - 86400);
        const out = [Object.assign({ dt: 0, raw: pack(11, 2, [], 0, q), type: 'CONTROL' }, rssiSnr('ipswich'))];
        for (const r of heardList.slice(0, ri(1, 3))) {
          const a = [0x90 | 2, (ri(-20, 40)) & 255]; u32(a, tag); a.push(...byId[r].key.subarray(0, 8));
          out.push(Object.assign({ dt: ri(200, 900), raw: pack(11, 2, [], 0, a), type: 'CONTROL' }, rssiSnr(r)));
        }
        return out;
      },
      raw() { return [direct(15, [0x4b, 0x50, ...bytes(ri(4, 24))])]; },   // Mesh.cpp takes RAW_CUSTOM on a direct route only ("don't flood route these")
    };
    const WEIGHTS = [['chat', 24], ['advert', 12], ['dm', 12], ['dmDirect', 5], ['ack', 7], ['privateChat', 7], ['req', 8], ['login', 4], ['path', 5],
      ['trace', 5], ['multipart', 3], ['discover', 3], ['grpData', 2], ['raw', 2]];
    const total = WEIGHTS.reduce((a, w) => a + w[1], 0);
    let warm = reps.length + 2;   // the first few: adverts from every repeater (+2), so names show up early

    function next() {
      if (warm > 0) { warm--; const n = warm >= 2 ? reps[warm - 2] : pick(companions); const o = flood(4, n, () => advertPayload(n), { copies: 1 }); o[0].dt = ri(250, 700); return o; }
      let x = rnd() * total, name = WEIGHTS[0][0];
      for (const [k, w] of WEIGHTS) { if ((x -= w) < 0) { name = k; break; } }
      const out = S[name]();
      out[0].dt = Math.round(Math.min(7000, 350 - Math.log(1 - rnd() * 0.999) * 2400));   // bursty: exponential gaps, ~2 s mean
      out.scenario = name;
      return out;
    }
    return { nodes, other, next, scenarios: S };
  }

  // ---------------------------------------------------------------- the player
  function KellyPJDemo(c) {
    let on = false, timer = null, queue = [], eng = null, unsub = null;
    const vis = () => { try { return !!c.visible(); } catch { return true; } };
    function clear() { if (timer) clearTimeout(timer); timer = null; }
    function pump() {
      clear();
      if (!on || !vis()) return;
      if (!queue.length) { try { queue = eng.next().slice(); } catch (e) { console.warn('pj-demo', e); queue = []; } }
      const p = queue.shift(); if (!p) { timer = setTimeout(pump, 1000); return; }
      timer = setTimeout(() => {
        timer = null;
        if (!on || !vis()) return;
        try { c.ingest({ raw: p.raw, snr: p.snr, rssi: p.rssi, demo: true }); } catch (e) { console.warn('pj-demo ingest', e); }
        pump();
      }, Math.max(0, p.dt || 0));
    }
    return {
      start() {
        if (on) return;
        if (!eng) eng = engine(c.D, c.PJ.DEMO_CHANNEL, Date.now() & 0x7fffffff);
        on = true;
        if (!unsub) unsub = c.bus.on('visible', v => { try { if (v) { if (on && !timer) pump(); } else { clear(); queue = []; } } catch (e) { console.warn('pj-demo', e); } });
        pump();
      },
      stop() { on = false; clear(); queue = []; if (unsub) { unsub(); unsub = null; } },
      running: () => on,
    };
  }
  KellyPJDemo._engine = engine;
  KellyPJDemo._NODES = NODES;
  return KellyPJDemo;
});
