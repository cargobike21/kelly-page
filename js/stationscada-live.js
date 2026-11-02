/* Kelly Page -- Station SCADA live adapters. Both turn real traffic into the schema events of stationscada-core.js,
 * so the page draws a live station exactly as it draws the simulation.
 *
 * KellyLink (recommended): Kelly's OWN LoRa Mesh link (USB / Bluetooth / Kelly bridge on the Pi). js/mesh.js hands it
 *   what its MeshCore session sees (feed(kind, ...)):
 *     'rx'    every packet the companion hears (PUSH LOG_RX_DATA: SNR, RSSI, route, path, raw bytes) -- a path ending in
 *             your repeater's hash means your mast heard it and repeated it, so the mast's hop is drawn too
 *     'tx'    a text / position / reaction this Kelly sent           'usb'  a serial frame to / from the node
 *     'status' the link state     'self' the node's own identity + radio     'rptStatus' / 'rptTel' / 'own'  the
 *             repeater card's over-the-air status / telemetry and the node's GET_STATS (no extra airtime: only what
 *             the Repeater management card -- or its "Status every 15 min" -- already asked for)
 *   The Pi's CPU / temperature / RAM / disk: the Kelly bridge's GET /api/host (bridge/kelly_bridge.py), every 15 s.
 * WebSocket: any bridge that pushes the schema as JSON text frames (one event, or an array of them), e.g.
 *   bridge/station_scada_bridge.py on a Pi WITHOUT the Kelly bridge (both can't hold the RAK's serial port at once).
 *
 * StationScadaLive.kelly(emit, k) -> { start(), stop(), feed(kind, ...a), name }
 * StationScadaLive.ws(emit, url)  -> { start(), stop(), name }
 */
(function () {
  'use strict';
  const C = () => window.StationScadaCore;
  const ev = o => Object.assign({ v: 1, t: Date.now() }, o);

  function kelly(emit, k) {
    let on = false, hostTimer = 0, nbrTimer = 0, seq = 1, lastStatus = '', rxN = 0, txN = 0;   // rxN / txN: the node's RX / TX count (its own GET_STATS when read, then counted on)
    const radio = () => k.radio();
    // your own repeater: a MeshCore repeater with your callsign in its name (meshrepeaters.js's rule), else the nearest one
    function myRepeater() {
      const call = (k.myCall() || '').toUpperCase(), l = [...k.nodes()].filter(n => n.key && n.role === 2);
      return l.find(n => call && (n.longName || '').toUpperCase().includes(call)) || l.sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99))[0] || null;
    }
    const byHash = h => h ? [...k.nodes()].find(n => n.key && n.key.startsWith(h)) : null;
    const nbrId = n => n ? `k${n.num >>> 0}` : null;
    const NAMES = { 0: 'REQ', 1: 'RESPONSE', 2: 'TXT', 3: 'ACK', 4: 'ADVERT', 5: 'GRP_TXT', 6: 'GRP_DATA', 7: 'ANON_REQ', 8: 'PATH', 9: 'TRACE', 10: 'MULTIPART', 11: 'CONTROL', 15: 'RAW' };
    function onRx(e) {
      const p = e.pkt; if (!p) return;
      const hex = e.raw ? C().hexOf(e.raw) : undefined, path = (p.path && p.path.h) || [], rpt = myRepeater();
      const pk = { type: NAMES[p.type] || `TYPE ${p.type}`, route: p.route, hops: path.length, path, len: p.len || (e.raw ? e.raw.length : 0), snr: e.snr, rssi: e.rssi, crc: 'ok', hex,
        from: p.advert ? p.advert.name : undefined };
      const id = `k${seq++}`, viaMine = rpt && path.length && rpt.key.startsWith(path[path.length - 1]);
      // the hops before ours, as far as Kelly can name them (hop trace on the horizon)
      const hops = (viaMine ? path.slice(0, -1) : path).map(byHash);
      const origin = p.advert ? [...k.nodes()].find(n => n.num === p.advert.num) : null;
      [origin, ...hops].filter(Boolean).forEach(n => emit(ev({ type: 'rf', dev: 'nbr', dir: 'tx', id, peer: nbrId(n), pkt: pk })));
      if (viaMine) {
        const last = hops.filter(Boolean).pop() || origin;
        emit(ev({ type: 'rf', dev: 'rpt', dir: 'rx', id, peer: nbrId(last), pkt: Object.assign({}, pk, { snr: undefined, rssi: undefined, path: path.slice(0, -1), hops: path.length - 1 }) }));
        emit(ev({ type: 'rf', dev: 'rpt', dir: 'tx', id, fwd: true, pkt: pk }));
      }
      emit(ev({ type: 'rf', dev: 'cmp', dir: 'rx', id, peer: viaMine ? 'rpt' : nbrId(hops.filter(Boolean).pop() || origin), pkt: pk }));
      // the CMP-01 readouts: every packet the companion hears is its own last RSSI / SNR (the sim sends these itself)
      emit(ev({ type: 'telemetry', dev: 'cmp', data: { rssi: e.rssi, snr: e.snr, lastRxT: Date.now(), rx: ++rxN } }));
    }
    function nodeEv(n, mine) {
      const me = k.myPos(), dist = me && n.lat != null ? k.distKm(me, n) : null, brg = me && n.lat != null ? k.bearing(me, n) : null;
      return ev({ type: 'neighbour', n: { id: nbrId(n), name: n.longName || n.shortName || n.idLabel, hash: n.key ? n.key.slice(0, 4) : '', role: n.role === 2 ? 'repeater' : n.role === 3 ? 'room server' : 'companion',
        snr: n.snr, rssi: n.rssi, hops: n.hops, lat: n.lat, lon: n.lon, distKm: dist, az: brg == null ? null : ((brg * 180 / Math.PI + 360) % 360) / 360, lastHeard: n.lastHeard || null, mine } });
    }
    function sendNeighbours() {
      const rpt = myRepeater(), mine = k.myNum();
      [...k.nodes()].filter(n => n.num !== mine && n.lastHeard && Date.now() - n.lastHeard < 24 * 3600000 && n !== rpt)
        .sort((a, b) => b.lastHeard - a.lastHeard).slice(0, 30).forEach(n => emit(nodeEv(n, false)));
    }
    async function pollHost() {
      const url = k.hostUrl(); if (!url) return;
      try {
        const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) return;
        const h = await r.json();
        emit(ev({ type: 'telemetry', dev: 'host', data: { cpuPct: h.cpuPct, cpuTempC: h.cpuTempC, memPct: h.memPct, memUsedMb: h.memUsedMb, memTotalMb: h.memTotalMb, diskPct: h.diskPct, uptimeS: h.uptimeS, hostName: h.host } }));
      } catch { /* bridge without /api/host (older), or not on a bridge */ }
    }
    function cmpTel() {
      const r = radio() || {}, me = k.me();
      emit(ev({ type: 'telemetry', dev: 'cmp', data: Object.assign({ fw: k.fw() || undefined, role: 'Companion', name: me && me.longName }, r) }));
    }
    function feed(kind, a, b) {
      if (!on) return;
      try {
        if (kind === 'rx') onRx(a);
        else if (kind === 'usb') emit(ev({ type: 'usb', dir: a, bytes: b }));
        else if (kind === 'tx') {
          const pk = { type: a.type || 'TXT', route: a.route || 'flood', hops: 0, path: [], len: a.len || 0, crc: 'ok', text: a.text };
          const id = `k${seq++}`;
          emit(ev({ type: 'rf', dev: 'cmp', dir: 'tx', id, peer: 'rpt', pkt: pk }));
          emit(ev({ type: 'telemetry', dev: 'cmp', data: { tx: ++txN } }));
        } else if (kind === 'status') {
          const s = a === 'on' ? 'up' : a === 'off' ? 'down' : '';
          if (s && s !== lastStatus) { lastStatus = s; emit(ev({ type: 'link', serial: s, note: b || '' })); if (s === 'up') cmpTel(); }
        } else if (kind === 'self') cmpTel();
        else if (kind === 'rptStatus') {
          const n = a, s = b || {}, rpt = myRepeater(); if (rpt && n && n.key !== rpt.key) return;
          emit(ev({ type: 'telemetry', dev: 'rpt', data: { name: n && n.longName, battV: s.battV, battPct: C().battPct(s.battV), noise: s.noise, rssi: s.rssi, snr: s.snr, rx: s.recv, tx: s.sent,
            fwd: s.sentFlood != null ? s.sentFlood + (s.sentDirect || 0) : undefined, uptimeS: s.uptimeS, dutyPct: s.txAirS != null && s.uptimeS ? 100 * s.txAirS / s.uptimeS : undefined, fw: n && n.fw } }));
        } else if (kind === 'rptTel') {
          const n = a, list = b || [], rpt = myRepeater(); if (rpt && n && n.key !== rpt.key) return;
          const f = re => { const x = list.find(i => re.test(i.name || '')); return x ? +x.value : undefined; };
          const d = { tempC: f(/temp/i), battV: f(/volt/i), solarMa: (v => v == null ? undefined : v * 1000)(f(/current/i)) };
          if (d.battV != null) d.battPct = C().battPct(d.battV);
          emit(ev({ type: 'telemetry', dev: 'rpt', data: Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)) }));
        } else if (kind === 'own') {
          const s = a || {};
          if (s.recv != null) rxN = s.recv; if (s.sent != null) txN = s.sent;
          emit(ev({ type: 'telemetry', dev: 'cmp', data: { rssi: s.rssi, snr: s.snr, noise: s.noise, battV: s.battV, rx: s.recv, tx: s.sent } }));
        }
      } catch (e) { console.warn('Station SCADA live', kind, e); }
    }
    return {
      name: "Kelly's mesh link", feed,
      start() {
        on = true; lastStatus = ''; rxN = 0; txN = 0;
        const st = k.status();
        emit(ev({ type: 'link', serial: st === 'on' ? 'up' : 'down', note: st === 'on' ? 'Kelly mesh link' : 'Connect a MeshCore node above (Kelly bridge, USB or Bluetooth)' })); lastStatus = st === 'on' ? 'up' : 'down';
        cmpTel(); sendNeighbours(); pollHost();
        const rpt = myRepeater();
        if (rpt) emit(ev({ type: 'telemetry', dev: 'rpt', data: { name: rpt.longName } }));
        k.replay();   // the repeater card's last status / telemetry, if it has any
        hostTimer = setInterval(pollHost, 15000); nbrTimer = setInterval(sendNeighbours, 20000);
      },
      stop() { on = false; clearInterval(hostTimer); clearInterval(nbrTimer); },
    };
  }

  function ws(emit, url) {
    let sock = null, on = false, retry = 0, timer = 0;
    function open() {
      if (!on) return;
      try { sock = new WebSocket(url); } catch (e) { emit(ev({ type: 'link', serial: 'down', note: `Bad bridge address: ${e.message}` })); return; }
      sock.onopen = () => { retry = 0; emit(ev({ type: 'log', level: 'info', text: `Bridge connected: ${url}` })); };
      sock.onmessage = m => {
        let data; try { data = JSON.parse(m.data); } catch { return; }
        for (const e of Array.isArray(data) ? data : [data]) if (e && e.v === 1 && typeof e.type === 'string') emit(Object.assign({ t: Date.now() }, e));
      };
      sock.onclose = () => {
        if (!on) return;
        emit(ev({ type: 'link', serial: 'down', note: 'Bridge WebSocket closed' }));
        timer = setTimeout(open, Math.min(30000, 2000 * 2 ** retry++));
      };
    }
    return { name: 'Bridge WebSocket', start() { on = true; open(); }, stop() { on = false; clearTimeout(timer); if (sock) try { sock.close(); } catch { /* gone */ } sock = null; } };
  }

  window.StationScadaLive = { kelly, ws };
})();
