/* Kelly Page -- Drive mode (wardriving) on the LoRa Mesh page (Phase 12 of docs/lora-mesh-gap-analysis.md, 2026-10-23).
 *
 * Drive around with a MeshCore node and the browser's GPS (navigator.geolocation.watchPosition, so a secure context:
 * https or localhost). Kelly pings the mesh no more often than every 500 m AND 60 s (2026-10-23) and logs which
 * repeaters heard each ping, at what SNR / RSSI.
 *
 * The ping (ms.drivePing) is a ZERO-HOP ADVERT by default (2026-10-23); a channel post is the other choice.
 *   advert   SEND_SELF_ADVERT with 0 = zero hop. Repeaters in range don't repeat it and don't answer it; MeshCore
 *            1.18.0's simple_repeater onAdvertRecv only puts a zero-hop advert's sender in its NEIGHBOURS table with
 *            the SNR it heard (readable later by logging in -- Repeater management). So for live attribution,
 *            "Ask who heard me" (ms.driveAsk, off) sends a zero-hop NODE DISCOVER request after each advert
 *            (CMD_SEND_CONTROL_DATA 55: [0x80][filter 1<<ADV_TYPE_REPEATER][tag u32]); each repeater in range answers
 *            zero-hop, after a random delay, with DISCOVER_RESP [0x92][the SNR it heard us x4][tag][its key 32]
 *            -> PUSH_CODE_CONTROL_DATA 0x8E [snr][rssi][path_len][payload] (meshcore.js route kind 'control').
 *            Repeaters rate-limit discovery to 4 per 2 minutes, well above our 1 a minute. The point's snr is the
 *            repeater's (how well it heard YOU), rxSnr ours (how well you heard it).
 *   channel  a flood post: each repeater that hears it repeats it, and the node hears the repeats as LOG_RX with the
 *            path so far -- the LAST hash in the path is the repeater it heard (mesh.js io.route -> rx()). A repeat of
 *            OUR ping is told from other traffic by time (WINDOW_MS after the send), packet type (GRP_TXT), the
 *            channel hash (learnt from the first repeat) and the payload: every repeat carries the same encrypted
 *            bytes, so the first repeat locks the payload and anything else is ignored.
 *   advert   a zero-hop advert: repeaters in range hear it but don't repeat it, so nothing comes back to attribute --
 *            the point is logged with no repeater (their neighbour lists, Repeater management, show who heard you).
 * Airtime: each ping goes through the Phase 3 limiter (js/mesh-bridge-rules.js Limiter) as ROUTINE traffic -- the
 * alert rules' own limiter when Alert rules are on (shared pool and pacing), else one of Drive mode's own with the
 * same budget figures. Its per-destination cap (6 an hour, meant for alerts to one recipient) isn't applied: every
 * ping is a new place, and the 500 m / 60 s gate already paces them.
 *
 * Each point {lat, lon, t, repeater, hash, key, snr, rssi, hops, km} goes into IndexedDB (kelly-drive, MAX_PTS, oldest
 * out) and shows on the Coverage layer as its own "driven" source (js/meshcoverage.js k.driven). GeoJSON export,
 * a session summary (km, pings, repeaters heard, best DX), a Mesh Quest hook (meshfun.js drive(): Wardriver trophy,
 * XP capped per day like send XP). The MeshCore demo drives a made-up track with made-up repeats (demo points are not
 * kept). Not built: posting points to the bridge history, upload to MeshMapper / EastMesh.
 *
 * window.KellyMeshDrive(k) -> { init, render, rx(e), points(), summary(), geojson() }
 * window.KellyMeshDrive.gate / capPoints / toGeoJSON / summarise / lastHash -- pure, for tests/meshdrive-tests.html.
 */
(function () {
  'use strict';
  const MIN_M = 500, MIN_S = 60, WINDOW_MS = 10000, MAX_PTS = 5000, MAX_ACC_M = 200, MAX_SESS = 20, DEMO_STEP_MS = 400, DEMO_DT_S = 20;
  const PING_TEXT = 'ping (drive test)';
  const km = (a, b) => { const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
  const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

  // ---- pure helpers
  // may we ping at fix {lat, lon} at time now (ms)? last = the previous ping {lat, lon, t} or null
  function gate(last, fix, now, minM = MIN_M, minS = MIN_S) {
    if (!fix || fix.lat == null || fix.lon == null) return { ok: false, why: 'no GPS fix' };
    if (!last) return { ok: true, m: 0, s: 0 };
    const m = km(last, fix) * 1000, s = (now - last.t) / 1000;
    if (m < minM || s < minS) return { ok: false, m, s, needM: Math.max(0, minM - m), needS: Math.max(0, minS - s), why: m < minM && s < minS ? 'distance and time' : m < minM ? 'distance' : 'time' };
    return { ok: true, m, s };
  }
  // keep the newest max points (sorted by t); -> { kept, dropped }
  function capPoints(list, max = MAX_PTS) {
    if (list.length <= max) return { kept: list, dropped: [] };
    const s = list.slice().sort((a, b) => a.t - b.t);
    return { kept: s.slice(s.length - max), dropped: s.slice(0, s.length - max) };
  }
  function toGeoJSON(points) {
    return { type: 'FeatureCollection', features: points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [+p.lon.toFixed(6), +p.lat.toFixed(6)] },
      properties: { time: new Date(p.t).toISOString(), ping: p.ping, repeater: p.repeater || null, hash: p.hash || null, snr: p.snr ?? null, rxSnr: p.rxSnr ?? null, rssi: p.rssi ?? null, hops: p.hops ?? null, km: p.km != null ? +p.km.toFixed(2) : null, via: p.via || null } })) };
  }
  // a session's points -> pings, repeaters heard, best DX (the farthest repeater from where you were)
  function summarise(points) {
    const pings = new Set(), rpt = new Map(); let best = null;
    for (const p of points) {
      pings.add(p.ping);
      if (!p.hash) continue;
      rpt.set(p.hash, p.repeater || `?${p.hash}`);
      if (p.km != null && (!best || p.km > best.km)) best = { km: p.km, repeater: p.repeater, snr: p.snr };
    }
    return { pings: pings.size, heard: points.filter(p => p.hash).length, repeaters: [...rpt.values()], best };
  }
  // the hash of the repeater a flood packet was heard from: the last one on its path
  const lastHash = path => path && path.h && path.h.length ? path.h[path.h.length - 1] : null;
  // the payload of a raw MeshCore packet (after header, transport codes, path) as hex
  function payloadHex(raw) {
    if (!raw || raw.length < 2) return '';
    const route = raw[0] & 3; let o = route === 0 || route === 3 ? 5 : 1;
    const pl = raw[o++], sz = (pl >> 6) + 1, n = pl & 63;
    return hex(raw.subarray ? raw.subarray(o + n * sz) : raw.slice(o + n * sz));
  }

  function KellyMeshDrive(k) {
    const { $, esc, ms } = k;
    if (!['advert', 'channel'].includes(ms.drivePing)) ms.drivePing = 'advert';   // zero-hop advert (2026-10-23)
    let pts = [], demoPts = [], idbOk = true, watch = null, run = null, open = null, ended = null, lim = null, demoT = null, sig = '', injected = false;
    const learntCh = {};   // channel index -> its channel hash (from the first repeat of our post)
    const P = () => k.isSim() ? demoPts : pts;

    // ---- IndexedDB (kelly-drive / pts), as share.js does it
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('kelly-drive', 1); r.onupgradeneeded = () => r.result.createObjectStore('pts', { keyPath: 'id', autoIncrement: true }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = async (mode, fn) => { if (!idbOk) return; try { const d = await db(); await new Promise((res, rej) => { const t = d.transaction('pts', mode); fn(t.objectStore('pts')); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch { idbOk = false; } };
    async function loadPts() {
      try { const d = await db(); pts = await new Promise((res, rej) => { const r = d.transaction('pts').objectStore('pts').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
      catch { idbOk = false; pts = []; }
      pts = capPoints(pts).kept; k.dirty('mesh');
    }
    function addPoint(p) {
      const list = P(); list.push(p);
      if (run) run.pts.push(p);
      if (k.isSim()) { const c = capPoints(demoPts); demoPts = c.kept; }
      else {
        tx('readwrite', s => { s.add(p).onsuccess = e => { p.id = e.target.result; }; });
        const c = capPoints(pts); if (c.dropped.length) { pts = c.kept; tx('readwrite', s => c.dropped.forEach(x => x.id != null && s.delete(x.id))); }
      }
      k.dirty('mesh');
    }

    // ---- the limiter (Phase 3 budget, routine class)
    function limiter() {
      const MBR = window.MeshBridgeRules; if (!MBR) return null;
      if (!k.isSim()) { const shared = k.rulesLimiter && k.rulesLimiter(); if (shared) return shared; }
      return lim || (lim = new MBR.Limiter({ ...MBR.DEFAULTS.budget }, MBR.DEFAULTS.radio));
    }
    function airOf(type) {
      const MBR = window.MeshBridgeRules; if (!MBR) return 0.5;
      const name = ((k.me() || {}).longName || '').length;
      return type === 'advert' ? MBR.timeOnAir(2 + 101 + name, MBR.DEFAULTS.radio) + (ms.driveAsk ? MBR.timeOnAir(8, MBR.DEFAULTS.radio) : 0) : MBR.timeOnAir(MBR.meshcoreAirBytes(new TextEncoder().encode(PING_TEXT).length, { nameLen: name }), MBR.DEFAULTS.radio);
    }

    // ---- what stops Drive mode (one sentence, or '')
    function gpsWhy() {
      if (k.isSim()) return '';
      if (window.KellySecure) return window.KellySecure.why('gps');
      return window.isSecureContext && navigator.geolocation ? '' : 'Drive mode needs GPS, and browsers only give it to https or localhost pages.';
    }
    function blocked() {
      if (k.dev() !== 'meshcore') return 'Drive mode needs a MeshCore node.';
      if (ms.drivePing === 'channel' && !chOk(ms.driveCh)) return 'Pick the channel to ping on (#wardriving or #ping, never Public).';
      if (!k.online()) return 'Connect your node first.';
      return gpsWhy();
    }
    function chans() { return (k.channels() || []).filter(c => c && c.index > 0 && !/^public$/i.test(c.name || '')); }
    const chOk = i => chans().some(c => c.index === +i);

    // ---- keep the screen on while driving (Screen Wake Lock, where the browser has it); the browser drops it when the
    // tab is hidden, so it's asked for again on coming back
    let lock = null;
    async function wake(on) {
      if (!on) { if (lock) { try { await lock.release(); } catch { /* */ } lock = null; } return; }
      if (!(window.KellySecure ? window.KellySecure.can('wakelock') : navigator.wakeLock)) return;
      try { lock = await navigator.wakeLock.request('screen'); } catch { lock = null; }
    }
    document.addEventListener('visibilitychange', () => { if (run && !run.demo && document.visibilityState === 'visible') wake(true); });

    // ---- a session
    const clock = () => run && run.demo ? run.vt : Date.now();
    const win = () => run && run.demo ? 1000 : WINDOW_MS;   // the demo's repeats all come within a second
    function start() {
      const why = blocked(); if (why) { k.toast('🚗', 'Drive mode', why, 'bad'); return; }
      run = { at: Date.now(), demo: k.isSim(), vt: Date.now(), km: 0, prev: null, last: null, fix: null, pings: 0, wait: '', pts: [] };
      if (run.demo && k.demoTrack !== false) demoDrive();   // tests drive it by hand (_fix)
      else { wake(true); watch = navigator.geolocation.watchPosition(p => fix({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
        e => { if (run) { run.wait = `GPS: ${e.message || 'no fix'}`; k.dirty('mesh'); } }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }); }
      k.addEvent('network', `Drive mode: started (${ms.drivePing === 'advert' ? 'zero-hop adverts' : `posts on ${chName(ms.driveCh)}`})`);
      k.dirty('mesh');
    }
    function stop() {
      if (!run) return;
      if (watch != null) { navigator.geolocation.clearWatch(watch); watch = null; }
      clearTimeout(demoT); demoT = null; wake(false);
      if (open) closePing();
      const s = { at: run.at, end: Date.now(), km: +run.km.toFixed(2), ...summarise(run.pts) };
      if (!run.demo) { const list = k.store.get('meshDrive.sessions', []) || []; list.unshift(s); k.store.set('meshDrive.sessions', list.slice(0, MAX_SESS)); }
      k.addEvent('network', `Drive mode: stopped -- ${s.km} km, ${s.pings} pings, ${s.repeaters.length} repeaters heard`);
      ended = s; run = null; k.dirty('mesh');
    }
    // a GPS fix
    function fix(f, vt) {
      if (!run) return;
      if (vt != null) run.vt = vt;
      if (f.acc != null && f.acc > MAX_ACC_M) { run.wait = `GPS too rough (±${Math.round(f.acc)} m)`; k.dirty('mesh'); return; }
      const now = clock();
      if (run.prev) { const d = km(run.prev, f), dt = (now - run.prev.t) / 1000; if (dt > 0 && d * 1000 / dt < 70) run.km += d; }   // a jump faster than 250 km/h is GPS noise
      run.prev = { lat: f.lat, lon: f.lon, t: now }; run.fix = { ...f, t: now };
      const g = gate(run.last, f, now);
      if (g.ok && !open) ping(f, now); else run.wait = g.ok ? 'listening for repeats' : `next ping in ${Math.ceil(g.needM)} m and ${Math.ceil(g.needS)} s`;
      k.dirty('mesh');
    }
    async function ping(f, now) {
      const why = blocked(); if (why) { run.wait = why; return; }
      const L = limiter(), air = airOf(ms.drivePing), n = run.pings + 1;
      if (L) { const c = L.check(now, 'routine', `drive:${run.at}:${n}`, air); if (!c.ok) { run.wait = `airtime: ${c.why}`; return; } }
      const s = k.session(); if (!s) return;
      open = { id: `${run.at}:${n}`, lat: f.lat, lon: f.lon, t: now, at: Date.now(), heard: new Map(), payload: null, ch: ms.drivePing === 'channel' ? +ms.driveCh : null, sent: false };
      try {
        if (ms.drivePing === 'advert') {
          await s.advert(false);
          if (ms.driveAsk) { open.tag = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1; if (run.demo && k.demoTrack !== false) demoAnswers(open); else await s.discoverNear(open.tag); }
        } else await s.sendText({ ch: open.ch }, PING_TEXT, {});
        if (L) L.take(now, 'routine', `drive:${run.at}:${n}`, air);
        open.sent = true; run.pings = n; run.last = { lat: f.lat, lon: f.lon, t: now }; run.wait = 'listening for repeats';
        k.sfx && k.sfx('tx');
        if (run.demo && k.demoTrack !== false && open.ch != null) demoRepeats(open);
        setTimeout(() => { if (open && open.id === `${run && run.at}:${n}`) closePing(); }, ms.drivePing === 'advert' && !open.tag ? 300 : win());
      } catch (e) { run.wait = `not sent: ${e.message}`; open = null; }
      k.dirty('mesh');
    }
    function closePing() {
      const o = open; open = null; if (!o || !o.sent) return;
      if (!o.heard.size) addPoint({ ping: o.id, lat: o.lat, lon: o.lon, t: o.t, repeater: null, hash: null, snr: null, rssi: null, hops: null, km: null, via: ms.drivePing === 'advert' ? 'advert' : 'channel' });
      k.F('drive', { heard: o.heard.size });
      if (run) run.wait = o.heard.size ? `last ping heard by ${o.heard.size}` : o.tag ? 'last ping: no repeater answered' : o.ch == null ? 'advert sent' : 'last ping: no repeats heard';
      k.dirty('mesh');
    }
    // the repeater a hash names: a repeater / room server contact with that key prefix, nearest the ping if several
    function repeaterOf(h, at) {
      const c = [...k.nodes()].filter(n => n.key && n.key.startsWith(h) && n.num !== k.myNum());
      const fwd = c.filter(n => n.role === 2 || n.role === 3), list = fwd.length ? fwd : c;
      if (!list.length) return null;
      return list.map(n => ({ n, d: n.lat != null ? km(at, n) : 1e9 })).sort((a, b) => a.d - b.d)[0].n;
    }
    // a node discover answer to our request (kind 'control'): [0x90 | node type][their SNR x4][tag u32][their key 32]
    function answer(e) {
      const o = open, d = e.data; if (!o || !o.sent || o.tag == null || Date.now() - o.at > win()) return;
      if (!d || d.length < 38 || (d[0] & 0xf0) !== 0x90 || (d[0] & 0x0f) !== 2) return;
      if (((d[2] | d[3] << 8 | d[4] << 16 | d[5] << 24) >>> 0) !== o.tag) return;   // someone else's discovery
      const key = hex(d.subarray(6, 38)), h = key.slice(0, 12);
      if (o.heard.has(h)) return;
      const n = [...k.nodes()].find(x => x.key && x.key.startsWith(h)), dk = n && n.lat != null ? km(o, n) : null;
      const pt = { ping: o.id, lat: o.lat, lon: o.lon, t: o.t, repeater: n ? (n.longName || n.shortName) : `?${key.slice(0, 8)}`, hash: h, key: h, snr: ((d[1] << 24) >> 24) / 4, rxSnr: e.snr, rssi: e.rssi, hops: 0, km: dk, via: 'discover' };
      o.heard.set(h, pt); addPoint(pt);
    }
    // a packet the node heard (mesh.js io.route): kind 'rx' (raw, LOG_RX) or 'control' (a discover answer)
    function rx(e) {
      if (e && e.kind === 'control') { answer(e); return; }
      const o = open; if (!o || !o.sent || !e || e.kind !== 'rx' || ms.drivePing !== 'channel' || Date.now() - o.at > win()) return;
      const p = e.pkt; if (!p || p.route !== 'flood' || p.type !== 5) return;
      const h = lastHash(p.path); if (!h) return;
      if (learntCh[o.ch] && p.ch && p.ch !== learntCh[o.ch]) return;
      const pay = payloadHex(e.raw);
      if (o.payload && pay && pay !== o.payload) return;   // someone else's post in the window
      if (!o.payload) { o.payload = pay; if (p.ch) learntCh[o.ch] = p.ch; }
      if (o.heard.has(h)) return;
      const n = repeaterOf(h, o), d = n && n.lat != null ? km(o, n) : null;
      const pt = { ping: o.id, lat: o.lat, lon: o.lon, t: o.t, repeater: n ? (n.longName || n.shortName) : `?${h}`, hash: h, key: n && n.key ? n.key.slice(0, 12) : null, snr: e.snr, rssi: e.rssi, hops: p.path.h.length, km: d, via: 'channel' };
      o.heard.set(h, pt); addPoint(pt);
    }

    // ---- the demo: a made-up drive from the sim's home towards Mt Coot-tha, with a stop, and made-up repeats
    const DEMO_TRACK = (() => {
      const t = [], a = { lat: -27.6255, lon: 152.7663 }, b = { lat: -27.4800, lon: 152.9450 }, steps = 34, stopAt = 9, stopFor = 6;
      for (let i = 0; i <= steps; i++) { const f = i / steps, p = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }; t.push(p); if (i === stopAt) for (let j = 0; j < stopFor; j++) t.push({ ...p }); }
      return t;
    })();
    function demoDrive() {
      let i = 0;
      const step = () => {
        if (!run || !run.demo) return;
        if (i >= DEMO_TRACK.length) { stop(); return; }
        run.vt += DEMO_DT_S * 1000; fix({ ...DEMO_TRACK[i++], acc: 8 });
        demoT = setTimeout(step, DEMO_STEP_MS);
      };
      step();
    }
    function demoRepeats(o) {
      const rpts = [...k.nodes()].filter(n => n.role === 2 && n.key && n.lat != null && n.num !== k.myNum());
      const pay = Array.from({ length: 24 }, () => Math.floor(Math.random() * 256)); pay[0] = 0x5a;
      const raw = h => Uint8Array.of(0x01 | (5 << 2), 1, parseInt(h, 16), ...pay);
      let delay = 80;
      for (const n of rpts) {
        const d = km(o, n), snr = Math.round((12 - 0.55 * d + (Math.random() * 4 - 2)) * 4) / 4;
        if (snr < -14 || d > 60) continue;
        const h = n.key.slice(0, 2);
        setTimeout(() => rx({ kind: 'rx', snr, rssi: Math.round(-50 - d * 1.6), raw: raw(h), pkt: { route: 'flood', type: 5, ch: '5a', path: { sz: 1, h: [h] } } }), delay);
        delay += 120;
      }
      // someone else's post inside the window: a different payload, must not count
      setTimeout(() => rx({ kind: 'rx', snr: 2, rssi: -90, raw: Uint8Array.of(0x15, 1, 0xee, 0x5a, 1, 2, 3), pkt: { route: 'flood', type: 5, ch: '5a', path: { sz: 1, h: ['ee'] } } }), delay + 40);
    }

    // the demo's discover answers: each repeater within range, with made-up SNRs both ways
    function demoAnswers(o) {
      const rpts = [...k.nodes()].filter(n => n.role === 2 && n.key && n.key.length >= 64 && n.lat != null && n.num !== k.myNum());
      let delay = 80;
      for (const n of rpts) {
        const d = km(o, n), up = Math.round((11 - 0.55 * d + (Math.random() * 4 - 2)) * 4) / 4, down = Math.round((12 - 0.55 * d + (Math.random() * 4 - 2)) * 4) / 4;
        if (up < -14 || d > 60) continue;
        const kb = n.key.slice(0, 64).match(/../g).map(x => parseInt(x, 16)), t = o.tag;
        setTimeout(() => rx({ kind: 'control', snr: down, rssi: Math.round(-50 - d * 1.6), pathLen: 0, data: Uint8Array.of(0x92, (Math.round(up * 4) + 256) & 255, t & 255, t >> 8 & 255, t >> 16 & 255, t >>> 24, ...kb) }), delay);
        delay += 120;
      }
      // another station's discovery in the window (a different tag): must not count
      setTimeout(() => rx({ kind: 'control', snr: 1, rssi: -95, pathLen: 0, data: Uint8Array.of(0x92, 8, 1, 2, 3, 4, ...new Array(32).fill(0xee)) }), delay + 40);
    }

    // ---- export
    function download(name, text, type) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    const geojson = () => toGeoJSON(P());
    function exportGeo() {
      const list = P(); if (!list.length) { k.toast('🚗', 'Nothing to export', 'Drive with Drive mode on first', 'bad'); return; }
      download(`kelly-drive-${new Date().toISOString().slice(0, 10)}.geojson`, JSON.stringify(geojson()), 'application/geo+json');
    }
    async function clearPts() {
      if (!window.confirm(`Delete all ${P().length} driven points?`)) return;
      if (k.isSim()) demoPts = []; else { pts = []; await tx('readwrite', s => s.clear()); }
      k.dirty('mesh');
    }

    // ---- UI
    const chName = i => { const c = (k.channels() || []).find(x => x && x.index === +i); return c ? c.name : `channel ${i}`; };
    function inject() {
      if (injected) return; injected = true;
      const cov = $('#ms-cov'), lab = cov && cov.closest('label');
      if (lab) lab.insertAdjacentHTML('afterend', '<label class="tog" title="Drive around with your node and GPS: Kelly pings the mesh at most every 500 m and 60 s and maps which repeaters heard you"><input type="checkbox" id="ms-drive"><i></i><span>🚗 Drive mode</span></label>');
      const d = $('#ms-drive'); if (d) d.onchange = () => { ms.drive = d.checked; if (!d.checked) stop(); k.save(); k.dirty('mesh'); };
      const mp = $('#mp-card');
      if (mp) mp.insertAdjacentHTML('beforebegin', `<div class="card md-card" id="md-card" hidden>
        <div class="card-h"><h2>🚗 Drive mode</h2><span class="tag" id="md-tag"></span></div>
        <p class="small dim">Drive around with your node. Kelly pings the mesh at most every ${MIN_M} m <b>and</b> ${MIN_S} s, logs which repeaters heard each ping and how well, and puts it on the Coverage map.</p>
        <div id="md-body"></div></div>`);
    }
    function init() { inject(); loadPts(); }
    function render() {
      inject();
      const card = $('#md-card'), tg = $('#ms-drive'); if (tg) tg.checked = !!ms.drive;
      if (!card) return;
      card.hidden = !ms.drive; if (!ms.drive || (k.currentPage && k.currentPage() !== 'mesh')) return;
      const why = blocked(), list = P(), r = run, sm = r ? summarise(r.pts) : ended, best = sm && sm.best;
      const s = JSON.stringify([ms.drivePing, ms.driveCh, !!ms.driveAsk, why, list.length, r && [r.pings, r.km.toFixed(2), r.wait, r.pts.length, r.fix && r.fix.t], ended && ended.end, chans().map(c => c.name), !!ms.coverage, k.isSim()]);
      if (s === sig) return; sig = s;
      $('#md-tag').textContent = r ? (r.demo ? 'DRIVING (DEMO)' : 'DRIVING') : `${list.length} points`;
      const gpsW = gpsWhy();
      const opt = (v, t) => `<option value="${v}"${ms.drivePing === v ? ' selected' : ''}>${t}</option>`;
      $('#md-body').innerHTML = `
        <div class="row gap wrap md-ctl">
          <label class="fld"><span>Ping type</span><select id="md-ping" ${r ? 'disabled' : ''}>${opt('advert', 'Zero-hop advert')}${opt('channel', 'Post on a channel')}</select></label>
          ${ms.drivePing === 'advert' ? `<label class="tog small" title="After each advert, a zero-hop discover request: repeaters in range answer with how well they heard you (one more short transmission per ping, and an answer from each repeater)"><input type="checkbox" id="md-ask" ${ms.driveAsk ? 'checked' : ''} ${r ? 'disabled' : ''}><i></i><span>Ask who heard me</span></label>` : ''}
          ${ms.drivePing === 'channel' ? `<label class="fld"><span>Channel</span><select id="md-ch" ${r ? 'disabled' : ''}><option value="">-- pick --</option>${chans().map(c => `<option value="${c.index}"${+ms.driveCh === c.index ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
          ${r ? '<button class="btn primary" id="md-stop">⏹ Stop</button>' : `<button class="btn primary" id="md-go" ${why ? 'disabled' : ''}>🚗 Start driving</button>`}
        </div>
        <p class="small dim md-help">A <b>zero-hop advert</b> reaches only the repeaters in range and none of them repeat it, so on its own it only logs where you pinged (those repeaters list you as a neighbour, see Repeater management). Tick <b>Ask who heard me</b> and the repeaters in range answer, each with how well it heard you. A <b>channel post</b> is repeated across the mesh -- check with MBUG before using one; never Public.</p>
        ${why && !r ? `<p class="small md-why">${esc(why)}</p>` : ''}
        ${gpsW && !r && !why.includes('GPS') ? `<p class="small md-why">${esc(gpsW)}</p>` : ''}
        ${r ? `<p class="small md-live">${r.fix ? `📍 ${r.fix.lat.toFixed(4)}, ${r.fix.lon.toFixed(4)}` : '📍 waiting for GPS'} · ${esc(r.wait || '')}</p>` : ''}
        ${sm ? `<div class="md-sum"><div><b>${(r ? r.km : ended.km).toFixed(1)}</b><small>km</small></div><div><b>${sm.pings}</b><small>pings</small></div><div><b>${sm.repeaters.length}</b><small>repeaters heard</small></div><div><b>${best ? `${best.km.toFixed(1)} km` : '--'}</b><small>best DX${best ? ` · ${esc(best.repeater || '')}` : ''}</small></div></div>
          ${sm.repeaters.length ? `<p class="small dim">Heard by: ${sm.repeaters.map(esc).join(', ')}</p>` : ''}` : ''}
        <div class="row gap wrap">
          <button class="btn ghost small" id="md-geo" ${list.length ? '' : 'disabled'}>⬇ GeoJSON (${list.length} points)</button>
          ${ms.coverage ? '' : '<button class="btn ghost small" id="md-cov">🗺️ Show on the Coverage map</button>'}
          <button class="btn ghost small" id="md-clear" ${list.length && !r ? '' : 'disabled'}>Clear points</button>
        </div>
        ${k.isSim() ? '<p class="small dim">Demo: a made-up drive towards Mt Coot-tha with made-up answers. Demo points are not kept.</p>' : ''}`;
      const b = id => $(id);
      b('#md-ping').onchange = e => { ms.drivePing = e.target.value; k.save(); k.dirty('mesh'); };
      if (b('#md-ask')) b('#md-ask').onchange = e => { ms.driveAsk = e.target.checked; k.save(); k.dirty('mesh'); };
      if (b('#md-ch')) b('#md-ch').onchange = e => { ms.driveCh = e.target.value === '' ? null : +e.target.value; k.save(); k.dirty('mesh'); };
      if (b('#md-go')) b('#md-go').onclick = start;
      if (b('#md-stop')) b('#md-stop').onclick = stop;
      b('#md-geo').onclick = exportGeo;
      if (b('#md-cov')) b('#md-cov').onclick = () => k.setCoverage(true);
      b('#md-clear').onclick = clearPts;
    }
    const inst = { init, render, rx, points: () => P(), summary: () => (run ? { ...summarise(run.pts), km: run.km, running: true } : ended), geojson, start, stop, running: () => !!run, _fix: fix, _close: () => closePing() };
    KellyMeshDrive._i = inst;   // tests
    return inst;
  }
  Object.assign(KellyMeshDrive, { gate, capPoints, toGeoJSON, summarise, lastHash, payloadHex, MIN_M, MIN_S, MAX_PTS });
  window.KellyMeshDrive = KellyMeshDrive;
})();
