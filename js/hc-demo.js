/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts: the demo backend (2026-10-24, unreleased). Nothing is transmitted.
 * A pretend companion node with the same backend shape as js/hc-service.js's live one (see its header), so every
 * button works with no radio. Each station has a REAL Ed25519 key pair (TweetNaCl, seeded from its name), so the cards
 * it exports are properly signed and HC.parseCard / HC.verifyEntry check them exactly as they check live ones.
 * The world: our node "VK4ZZA Kelly Demo" near Ipswich, a table of 32 contacts (small, so the "nearly full" warnings
 * show), 10 contacts on it (one of them yours), a handful of SEQ hams heard advertising but not added (auto-add is off, repeaters only), more
 * turning up now and then, and the odd answer that never comes (3 %, so the failure paths show too).
 * Handshakes (awards, review/07-build-contract.md): some hams are scripted to "have you" (ANSWERS): after a ping, a
 * message or an add, poke(key, how) makes one answer 3-6 s later through o.emit('mutual', { key, name, type: 1, how, at,
 * demo: true }) -- at most once a minute each. One extra station is YOURS: its name carries o.myCall (VK4XXX when there
 * is none), it is on the radio and answers too, so Mesh Quest shows the "your own station never scores" case.
 * Nothing is saved or sent.
 * window.KellyHamDemo({ nacl, myCall?, emit?(ev, payload) }) -> { backend, start(svc), stop(), stations, me,
 *   cardOf(name) -> 'meshcore://..', keyOf(name), sign(name, bytes), poke(key, how) -> { name, yours } | null }
 *   -- the directory / share demos use cardOf / sign for their made-up hams.
 */
(function () {
  'use strict';
  const HC = window.KellyHC;
  const STATIONS = [   // name, type, lat, lon, snr, hops, on the radio at start
    ['VK4ZZB Springfield', 1, -27.66, 152.91, 6.5, 0, true], ['VK4ZZC Mobile', 1, -27.55, 152.98, 2.0, 1, true],
    ['Ipswich Rptr', 2, -27.62, 152.76, 9.0, 0, true], ['Mt Cotton Rptr', 2, -27.63, 153.22, -1.5, 1, true],
    ['VK4ZZD Kenmore', 1, -27.50, 152.94, -4.0, 2, true], ['Ipswich Chat Room', 3, -27.61, 152.76, 7.5, 0, true],
    ['Bremer Creek Sensor', 4, -27.62, 152.73, 3.0, 1, true], ['VK4ZZE Toowoomba', 1, -27.56, 151.95, -9.5, 3, true],
    ['Bob in Brisbane', 1, -27.47, 153.02, -6.0, 2, true],
    ['VK4ZZF Redbank', 1, -27.60, 152.87, 4.0, 1, false], ['VK4ZZG Gold Coast', 1, -28.00, 153.40, -11.0, 3, false],
    ['VK4ZZH Logan', 1, -27.64, 153.10, -2.5, 2, false], ['Laidley Rptr', 2, -27.63, 152.39, 1.0, 1, false],
    ['VK4ZZJ Caboolture', 1, -27.08, 152.95, -7.0, 3, false], ['Mesh Tracker 7', 1, -27.58, 152.80, 0.5, 1, false],
    ['VK4ZZK Beaudesert', 1, -27.99, 152.99, -8.5, 3, false], ['VK4ZZL Bundamba', 1, -27.61, 152.81, 8.0, 0, false],
  ];
  const ME = { name: 'VK4ZZA Kelly Demo', lat: -27.615, lon: 152.86 };
  // the hams who "have you" as a contact, so a ping / message / add gets an answer (a demo Handshake)
  const ANSWERS = new Set(['VK4ZZB Springfield', 'VK4ZZC Mobile', 'VK4ZZD Kenmore', 'VK4ZZF Redbank', 'VK4ZZH Logan', 'VK4ZZL Bundamba']);

  window.KellyHamDemo = function (o = {}) {
    const nacl = o.nacl || window.nacl;
    const seed = name => { const b = new Uint8Array(32), t = HC.utf8(`hc-demo:${name}`); for (let i = 0; i < t.length; i++) b[i % 32] = (b[i % 32] * 31 + t[i]) & 255; return b; };
    const pair = name => nacl ? nacl.sign.keyPair.fromSeed(seed(name)) : { publicKey: seed(name), secretKey: null };
    const now = () => Math.floor(Date.now() / 1000);
    const me = { ...ME, kp: pair(ME.name) }; me.key = HC.hex(me.kp.publicKey);
    const yourCall = (HC.normCall(o.myCall) && HC.normCall(o.myCall) !== 'VK4ZZA') ? HC.normCall(o.myCall) : 'VK4XXX';
    const LIST = STATIONS.concat([[`${yourCall} Home node`, 1, -27.63, 152.84, 5.0, 0, true]]);   // yours: the no-score case
    const st = LIST.map(([name, type, lat, lon, snr, hops, on], i) => {
      const kp = pair(name), yours = i === LIST.length - 1;
      return { name, type, lat, lon, snr, hops, on, heard: false, fav: i === 2, key: HC.hex(kp.publicKey), kp, num: i + 1, lastHeard: Date.now() - (i * 7 + 2) * 60000,
        answers: yours || ANSWERS.has(name), yours,
        outPath: hops ? { sz: 2, h: Array.from({ length: hops }, (_, j) => HC.hex(pair(STATIONS[2 + (j % 2)][0]).publicKey.subarray(0, 2))) } : null };
    });
    const emit = typeof o.emit === 'function' ? o.emit : () => {};
    const lastAns = new Map();   // key -> ms: one answer a minute per station
    const MAX = 32;
    let removes = 0, epoch = 0;
    function restart() {
      epoch++;
      running = false; if (svc) svc._status('off');
      later(() => { running = true; if (!svc) return; svc._status('config'); st.filter(x => x.on).forEach(x => svc._node(nodeOf(x), false)); svc._status('on'); }, 4500);
    }
    let manual = 1, bits = 0x04, maxHops = 0, telem = 0, svc = null, timers = [], running = false;
    const rand = Math.random;
    const later = (fn, ms) => { const t = setTimeout(() => { timers = timers.filter(x => x !== t); fn(); }, ms); timers.push(t); };
    const wait = () => new Promise((res, rej) => { const ms = 250 + rand() * 450; later(() => (rand() < 0.03 ? rej(new Error('the node did not answer')) : res()), rand() < 0.03 ? 1500 : ms); });
    const byKey = key => st.find(s => s.key === String(key || '').toLowerCase());
    const nodeOf = s => ({ num: s.num, key: s.key, longName: s.name, role: s.type, hops: s.on ? s.hops : null, lat: s.lat, lon: s.lon, lastHeard: s.lastHeard,
      snr: s.snr, rssi: Math.round(-110 + s.snr * 2), fav: s.fav, flags: (s.fav ? 1 : 0) | (s.disc ? 2 : 0), outPath: s.on ? s.outPath : null, advertTs: Math.floor(s.lastHeard / 1000) });
    // a signed advert packet for station s (or our node): flood ADVERT, no path. With a position the firmware's 32-byte
    // app_data leaves 23 bytes for the name (AdvertDataBuilder::encodeTo), cut on a character boundary
    function advertOf(s) {
      let nm = String(s.name || ''); while (HC.utf8(nm).length > 23) nm = Array.from(nm).slice(0, -1).join('');
      const name = HC.utf8(nm), app = new Uint8Array(9 + name.length);
      app[0] = 0x80 | 0x10 | (s.type || 1);
      const dv = new DataView(app.buffer); dv.setInt32(1, Math.round(s.lat * 1e6), true); dv.setInt32(5, Math.round(s.lon * 1e6), true); app.set(name, 9);
      const key = s.kp.publicKey, ts = new Uint8Array(4); new DataView(ts.buffer).setUint32(0, now(), true);
      const msg = new Uint8Array(36 + app.length); msg.set(key); msg.set(ts, 32); msg.set(app, 36);
      const sig = nacl && s.kp.secretKey ? nacl.sign.detached(msg, s.kp.secretKey) : new Uint8Array(64);
      const p = new Uint8Array(2 + 100 + app.length); p[0] = 0x01 | (4 << 2); p[1] = 0; p.set(key, 2); p.set(ts, 34); p.set(sig, 38); p.set(app, 102);
      return `meshcore://${HC.hex(p)}`;
    }
    const count = () => st.filter(s => s.on).length;
    const typeBit = { 1: 0x02, 2: 0x04, 3: 0x08, 4: 0x10 };
    // a station advertises: saved (auto-add) or passed on only (manual: Heard)
    function heardAdvert(s) {
      s.lastHeard = Date.now();
      if (!s.on && (!(manual & 1) || bits & typeBit[s.type]) && count() < MAX) { s.on = true; s.outPath = null; }
      s.heard = true;
      if (svc) svc._node(nodeOf(s), true);
    }
    function tick() {
      if (!running) return;
      const off = st.filter(s => !s.on && !s.heard);
      if (off.length) heardAdvert(off[Math.floor(rand() * off.length)]);
      else { const on = st.filter(s => s.on); if (on.length) { const s = on[Math.floor(rand() * on.length)]; s.lastHeard = Date.now(); if (svc) svc._node(nodeOf(s), false); } }
      later(tick, 25000 + rand() * 25000);
    }
    const backend = {
      via: () => 'demo', online: () => running, why: () => 'Demo is off.',
      me: () => ({ key: me.key, name: me.name }),
      maxContacts: () => MAX,
      async autoAdd() { await wait(); return { all: !(manual & 1), bits, maxHops }; },
      async setAutoAdd(p) { await wait(); if (p.all != null) manual = p.all ? 0 : 1; if (p.bits != null) { bits = p.bits & 0x1f; maxHops = p.maxHops | 0; } },
      async hasContact(key) { const s = byKey(key); return !!(s && s.on); },
      async importAdvert(link) {
        await wait();
        const c = HC.parseCard(link, { ed: nacl ? HC.naclEd(nacl) : null });
        let s = byKey(c.key);
        if (!s) { s = { name: c.name, type: c.type, lat: c.lat, lon: c.lon, snr: null, hops: null, on: false, heard: false, fav: false, key: c.key, kp: { publicKey: HC.unhex(c.key) }, num: 900 + st.length, lastHeard: null, outPath: null }; st.push(s); }
        if (!s.on && count() >= MAX) throw new Error('table full');
        s.on = true; if (svc) svc._node(nodeOf(s), false);
      },
      async addKey({ key, type, name }) {
        await wait();
        let s = byKey(key); if (s && s.on) return { already: true };
        if (count() >= MAX) throw new Error('table full');
        if (!s) { s = { name, type, lat: null, lon: null, snr: null, hops: null, on: false, heard: false, fav: false, key, kp: { publicKey: HC.unhex(key) }, num: 900 + st.length, lastHeard: null, outPath: null }; st.push(s); }
        s.on = true; s.outPath = null; if (svc) svc._node(nodeOf(s), false);
        return { key };
      },
      async addHeard(key) {
        await wait();
        const s = byKey(key); if (!s) throw new Error('the node has not passed on an advert from that station since Kelly connected');
        if (count() >= MAX) throw new Error('table full');
        s.on = true; if (svc) svc._node(nodeOf(s), false);
        return { key, name: s.name };
      },
      // every third remove "restarts the radio" (as some firmwares do on a contact-file rewrite): it goes quiet, the
      // link drops for ~4 s, then the node is back with its contacts
      async remove(key) { await wait(); const s = byKey(key); if (!s || !s.on) throw new Error('not found'); s.on = false; s.heard = false; s.fav = false; if (++removes % 3 === 0) restart(); },
      async share(key) { await wait(); const s = byKey(key); if (!s || !s.on) throw new Error('not found'); },
      token: () => epoch,
      async alive() { if (!running) throw new Error('the node did not answer'); },
      async resetPath(key) { await wait(); const s = byKey(key); if (!s || !s.on) throw new Error('not found'); s.outPath = null; s.hops = null; },
      async setFav(key, on) { await wait(); const s = byKey(key); if (!s || !s.on) throw new Error('not found'); s.fav = !!on; },
      async setFlag(key, bit, on) { await wait(); const s = byKey(key); if (!s || !s.on) throw new Error('not found'); if (bit & 1) s.fav = !!on; if (bit & 2) s.disc = !!on; },
      telemetryModes: () => ({ base: telem & 3, loc: (telem >> 2) & 3, env: (telem >> 4) & 3 }),
      async setTelemetryBase(m) { await wait(); telem = (telem & ~3) | (m & 3); },
      async advert(flood) {
        await wait();
        // someone hears it and advertises back (a flood reaches further)
        const off = st.filter(s => !s.on && !s.heard && (flood || s.hops <= 1));
        off.slice(0, flood ? 2 : 1).forEach((s, i) => later(() => heardAdvert(s), 2500 + i * 2000));
      },
      async exportSelf() { await wait(); return advertOf({ ...me, type: 1 }); },
      async sign(bytes) { await wait(); if (!nacl) throw new Error('not supported'); return nacl.sign.detached(Uint8Array.from(bytes), me.kp.secretKey); },
      async listContacts() { await wait(); return st.filter(s => s.on).map(nodeOf); },
      nodeByKey: key => { const s = byKey(key); return s ? nodeOf(s) : null; },
      nodes: () => st.filter(s => s.on || s.heard).map(nodeOf),
    };
    return {
      backend, stations: st, me,
      start(s) {
        svc = s; running = true;
        st.forEach(x => { x.heard = false; });
        st.filter(x => x.on).forEach(x => svc._node(nodeOf(x), false));
        st.filter(x => !x.on).slice(0, 4).forEach(x => heardAdvert(x));
        svc._status('on');
        later(tick, 20000);
      },
      stop() { running = false; timers.forEach(clearTimeout); timers = []; lastAns.clear(); if (svc) svc._status('off'); },
      // a scripted station answers a ping ('ack') / a message or an add ('message'): null when it won't (not on our
      // radio, doesn't "have us", or answered under a minute ago)
      poke(key, how) {
        const s = byKey(key);
        if (!running || !s || !s.on || !s.answers || s.type !== 1) return null;
        if (Date.now() - (lastAns.get(s.key) || 0) < 60000) return null;
        lastAns.set(s.key, Date.now());
        later(() => {
          if (!running || !s.on) return;
          s.lastHeard = Date.now(); if (svc) svc._node(nodeOf(s), false);
          try { emit('mutual', { key: s.key, name: s.name, type: 1, how: how === 'ack' ? 'ack' : 'message', at: Date.now(), demo: true, ...(s.yours ? { yours: true } : {}) }); } catch { /* never throw */ }
        }, 3000 + rand() * 3000);
        return { name: s.name, yours: !!s.yours };
      },
      cardOf: name => { const s = st.find(x => x.name === name); return s ? advertOf(s) : null; },
      keyOf: name => HC.hex(pair(name).publicKey),
      // a made-up ham's signature over bytes (the directory demo's entries are signed by their own "node")
      sign: (name, bytes) => nacl ? nacl.sign.detached(Uint8Array.from(bytes), pair(name).secretKey) : new Uint8Array(64),
    };
  };
})();
