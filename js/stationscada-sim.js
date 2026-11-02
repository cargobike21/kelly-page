/* Kelly Page -- Station SCADA simulation (the default source). Pure (UMD): no DOM, no timers -- the page calls
 * step(now) from its frame loop; tests call it with a fake clock and a seeded random.
 *
 * It runs a believable home station on a sped-up day (cfg.sim.dayMin real minutes = 24 h): the solar curve follows
 * the sun, clouds cut it, the battery charges by day and drains at night. Traffic: adverts, channel and direct
 * messages, flood vs direct routes, repeater forwards, DM ACKs and retries, the occasional CRC failure; neighbours on
 * the horizon with SNR / RSSI from a link budget plus fading. Every output is a schema event (stationscada-core.js),
 * exactly what a live source sends, so the page can't tell the difference.
 *
 * StationScadaSim(cfg, emit, { rnd?, now? }) -> { step(now), inject(what), world, reconfig(cfg) }
 *   inject: 'lightning' | 'usb' (pull / replug the cable) | 'lowbatt' | 'crc' (a burst of bad packets) | 'burst' (busy channel) | 'heat'
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stationscada-core.js'));
  else root.StationScadaSim = factory(root.StationScadaCore);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  // the made-up neighbourhood (an Ipswich-ish horizon): hash = 2-byte path hash, az = where on the horizon (0 left .. 1 right)
  const NEIGHBOURS = [
    { id: 'n1', name: 'Flinders Peak RPT', hash: 'f1a7', role: 'repeater', km: 21.4, elevM: 679, hM: 6, az: 0.12, lat: -27.818, lon: 152.814 },
    { id: 'n2', name: 'Springfield RPT', hash: '5b20', role: 'repeater', km: 11.8, elevM: 140, hM: 12, az: 0.34, lat: -27.668, lon: 152.917 },
    { id: 'n3', name: 'Redbank Plains', hash: 'c04e', role: 'companion', km: 6.3, elevM: 45, hM: 4, az: 0.5, lat: -27.646, lon: 152.861 },
    { id: 'n4', name: 'Mt Coot-tha RPT', hash: '7e93', role: 'repeater', km: 27.9, elevM: 287, hM: 15, az: 0.72, lat: -27.475, lon: 152.954 },
    { id: 'n5', name: 'Marburg Hill RPT', hash: '29dd', role: 'repeater', km: 24.6, elevM: 410, hM: 8, az: 0.9, lat: -27.565, lon: 152.598 },
  ];
  const TEXTS = ['Morning all, good copy here', 'Anyone on #test?', 'QSL via Flinders', 'Testing the new solar node', '73 de mesh', 'Heading out on the bike, back at 4', 'Rain at Marburg now', 'Signal report please'];
  const mulberry = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

  return function StationScadaSim(cfg, emit, opt = {}) {
    const rnd = opt.rnd || (opt.seed != null ? mulberry(opt.seed) : Math.random);
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const pick = a => a[(rnd() * a.length) | 0];
    let t0 = opt.now != null ? opt.now : Date.now(), last = t0, seq = 1;
    const d0 = new Date(t0);
    const w = {   // the world (the page reads it for nothing but tests and the "World" readout)
      hour: d0.getHours() + d0.getMinutes() / 60, cloud: cfg.sim.cloudy, soc: 0.62, uptimeS: 3 * 86400 + 4000, hostUp: 9 * 86400 + 1200,
      serial: 'up', crcBurstUntil: 0, burstUntil: 0, heatUntil: 0, lowBattUntil: 0, nextPkt: t0 + 1500, nextTel: t0, nextAdvert: t0 + 20000, nextLightning: 0,
      counts: { rptRx: 18234, rptTx: 9120, rptFwd: 8702, cmpRx: 6411, cmpTx: 812, crc: 0 }, msgsHour: [], cpu: 12, neighbours: NEIGHBOURS.map(n => Object.assign({}, n)),
      lastRpt: { rssi: null, snr: null }, lastCmp: { rssi: null, snr: null, t: 0 }, ownHash: 'a3f0',
    };
    const q = [];   // scheduled events: { at, ev }
    const at = (ms, ev) => { q.push({ at: ms, ev }); };
    const R = () => cfg.radio;
    const air = len => C.airtimeMs(len, R());

    // what the mast hears from neighbour n (and what the shack hears from the mast, through the roof)
    function sig(n, toCmp) {
      const r = R(), a = cfg.ant;
      const km = toCmp ? 0.02 : n.km, gain = toCmp ? a.rpt.gainDbi + a.cmp.gainDbi : a.rpt.gainDbi + 2.5, cable = toCmp ? a.rpt.cableDb + a.cmp.cableDb : a.rpt.cableDb;
      const extra = toCmp ? a.extraLossDb : 14 + Math.max(0, 20 - n.elevM / 30);   // clutter, softened by height
      const noise = -116 + gauss() * 1.2;
      let rssi = r.txDbm + gain - cable - C.fsplDb(km, r.freqMHz) - extra + gauss() * 4;
      if (toCmp) rssi = Math.min(rssi, -38);
      const snr = Math.max(-19, Math.min(12.5, rssi - noise + gauss()));
      return { rssi: Math.round(rssi), snr: Math.round(snr * 4) / 4, noise };
    }
    function pkt(type, route, path, extra = {}) {
      const bytes = C.buildPacket(Object.assign({ type, route, path, len: extra.len }, extra), rnd);
      return { type, route, hops: path.length, path: path.slice(), len: bytes.length, crc: 'ok', hex: C.hexOf(bytes), from: extra.from, text: extra.text };
    }
    const ev = (o, t) => Object.assign({ v: 1, t }, o);
    const usb = (t, dir, bytes, frame) => { if (w.serial === 'up') at(t, ev({ type: 'usb', dir, bytes, frame }, t)); };
    const noteMsg = t => { w.msgsHour.push(t); };

    // a packet from neighbour n reaching the mast (maybe via other horizon repeaters first), forwarded, heard in the shack
    function inbound(t, n, type, route) {
      const others = w.neighbours.filter(x => x !== n && x.role === 'repeater');
      const via = route === 'flood' && rnd() < 0.55 ? [pick(others)] : [];
      if (via.length && rnd() < 0.35) { const v2 = pick(others.filter(x => x !== via[0])); if (v2) via.push(v2); }
      const last = via.length ? via[via.length - 1] : n;
      const path = route === 'flood' ? via.map(x => x.hash) : [];
      const text = type === 'GRP_TXT' || type === 'TXT' ? pick(TEXTS) : undefined;
      const p = pkt(type, route, path, { name: n.name, lat: n.lat, lon: n.lon, role: n.role === 'repeater' ? 2 : 1, from: n.name, text, len: type === 'ACK' ? 14 : type === 'ADVERT' ? null : 30 + ((rnd() * 60) | 0) });
      const id = `s${seq++}`, ta = air(p.len), bad = rnd() * 100 < cfg.sim.crcPct || t < w.crcBurstUntil && rnd() < 0.6;
      const s = sig(last);
      // the hop trace: each earlier hop on the horizon first (dev 'nbr' tx), then the last hop into the mast
      let tt = t;
      for (const hop of [n, ...via]) { at(tt, ev({ type: 'rf', dev: 'nbr', dir: 'tx', id, peer: hop.id, pkt: p }, tt)); tt += ta + 120 + rnd() * 300; }
      tt -= 120;
      const rx = Object.assign({}, p, { snr: s.snr, rssi: s.rssi, crc: bad ? 'fail' : 'ok' });
      at(tt, ev({ type: 'rf', dev: 'rpt', dir: 'rx', id, peer: last.id, pkt: rx }, tt));
      w.counts.rptRx++; w.lastRpt = { rssi: s.rssi, snr: s.snr };
      at(tt, ev({ type: 'neighbour', n: { id: last.id, name: last.name, hash: last.hash, role: last.role, snr: s.snr, rssi: s.rssi, hops: 0, lat: last.lat, lon: last.lon, distKm: last.km, elevM: last.elevM, hM: last.hM, az: last.az, lastHeard: tt } }, tt));
      if (via.length) at(tt, ev({ type: 'neighbour', n: { id: n.id, name: n.name, hash: n.hash, role: n.role, hops: via.length, lat: n.lat, lon: n.lon, distKm: n.km, elevM: n.elevM, hM: n.hM, az: n.az, lastHeard: tt } }, tt));
      if (bad) { w.counts.crc++; at(tt, ev({ type: 'log', level: 'warn', text: `CRC fail: ${type} from ${last.name} (SNR ${s.snr} dB)` }, tt)); return; }
      // repeat it (flood) after MeshCore's random tx delay; direct packets addressed through us are repeated too
      const fwd = route === 'flood' || rnd() < 0.3;
      let tc = tt + 30;
      if (fwd) {
        const tf = tt + 150 + rnd() * 500, fp = Object.assign({}, p, { path: route === 'flood' ? path.concat(w.ownHash) : path, hops: route === 'flood' ? path.length + 1 : path.length });
        at(tf, ev({ type: 'rf', dev: 'rpt', dir: 'tx', id, fwd: true, pkt: fp }, tf)); w.counts.rptTx++; w.counts.rptFwd++;
        tc = tf + ta;
      }
      // the shack hears the mast's repeat (or the original, weakly, through the roof)
      const c = sig(null, true);
      at(tc, ev({ type: 'rf', dev: 'cmp', dir: 'rx', id, peer: fwd ? 'rpt' : last.id, pkt: Object.assign({}, p, { snr: c.snr, rssi: c.rssi }) }, tc));
      w.counts.cmpRx++; w.lastCmp = { rssi: c.rssi, snr: c.snr, t: tc };
      usb(tc + 15, 'to_host', p.len + 6, 'LOG_RX_DATA');
      if (type === 'GRP_TXT' || type === 'TXT') { usb(tc + 60, 'to_host', 1, 'MSG_WAITING'); usb(tc + 140, 'to_node', 1, 'SYNC_NEXT_MESSAGE'); usb(tc + 190, 'to_host', 20 + (text || '').length, type === 'TXT' ? 'CONTACT_MSG' : 'CHANNEL_MSG'); noteMsg(tc); }
      if (type === 'ADVERT') usb(tc + 60, 'to_host', 148, 'NEW_ADVERT');
    }
    // the shack sends: up the USB, out the RAK's antenna, the mast repeats it; a DM wants an ACK back (retries without one)
    function outbound(t, type, tryNo = 0, id = `s${seq++}`, target) {
      const dm = type === 'TXT', n = target || (dm ? pick(w.neighbours) : null);
      const text = type === 'ADVERT' ? undefined : pick(TEXTS);
      const p = pkt(type, dm && rnd() < 0.6 ? 'direct' : 'flood', [], { name: 'VK4XXX', role: 1, from: 'this station', text, len: type === 'ADVERT' ? null : 28 + ((rnd() * 50) | 0) });
      const ta = air(p.len);
      usb(t, 'to_node', p.len + 8, type === 'ADVERT' ? 'SEND_SELF_ADVERT' : dm ? 'SEND_TXT_MSG' : 'SEND_CHANNEL_TXT');
      const tx = t + 40;
      at(tx, ev({ type: 'rf', dev: 'cmp', dir: 'tx', id, retry: tryNo, peer: 'rpt', pkt: p }, tx)); w.counts.cmpTx++;
      usb(tx + 10, 'to_host', 2, 'OK');
      const c = sig(null, true), tr = tx + ta;
      at(tr, ev({ type: 'rf', dev: 'rpt', dir: 'rx', id, peer: 'cmp', pkt: Object.assign({}, p, { snr: c.snr, rssi: c.rssi }) }, tr)); w.counts.rptRx++;
      const tf = tr + 150 + rnd() * 400, fp = p.route === 'flood' ? Object.assign({}, p, { path: [w.ownHash], hops: 1 }) : p;
      at(tf, ev({ type: 'rf', dev: 'rpt', dir: 'tx', id, fwd: true, pkt: fp }, tf)); w.counts.rptTx++; w.counts.rptFwd++;
      if (!dm) return;
      noteMsg(t);
      // the ACK: back from n via the mast -- or nothing, and a retry 4 s later (up to 3 tries, as meshcore.js)
      if (rnd() < 0.78 || tryNo >= 2) {
        if (tryNo >= 2 && rnd() < 0.4) { at(tf + 4000, ev({ type: 'log', level: 'warn', text: `DM to ${n.name}: no ACK after 3 tries` }, tf + 4000)); return; }
        const ta2 = tf + ta + 300 + rnd() * 900, s = sig(n), ap = pkt('ACK', 'direct', [], { len: 14 });
        at(ta2, ev({ type: 'rf', dev: 'nbr', dir: 'tx', id: `${id}a`, peer: n.id, pkt: ap }, ta2));
        const tra = ta2 + air(ap.len);
        at(tra, ev({ type: 'rf', dev: 'rpt', dir: 'rx', id: `${id}a`, peer: n.id, pkt: Object.assign({}, ap, { snr: s.snr, rssi: s.rssi }) }, tra)); w.counts.rptRx++;
        const tfa = tra + 120 + rnd() * 200;
        at(tfa, ev({ type: 'rf', dev: 'rpt', dir: 'tx', id: `${id}a`, fwd: true, pkt: ap }, tfa)); w.counts.rptTx++; w.counts.rptFwd++;
        const tca = tfa + air(ap.len), cc = sig(null, true);
        at(tca, ev({ type: 'rf', dev: 'cmp', dir: 'rx', id: `${id}a`, peer: 'rpt', pkt: Object.assign({}, ap, { snr: cc.snr, rssi: cc.rssi }) }, tca)); w.counts.cmpRx++;
        usb(tca + 20, 'to_host', 9, 'SEND_CONFIRMED');
        at(tca + 20, ev({ type: 'log', level: 'info', text: `DM to ${n.name} delivered${tryNo ? ` (try ${tryNo + 1})` : ''}` }, tca + 20));
      } else {
        const tn = tf + 4000;
        at(tn, ev({ type: 'log', level: 'warn', text: `DM to ${n.name}: no ACK, retrying (${tryNo + 2}/3)` }, tn));
        at(tn, { retryOf: { type, tryNo: tryNo + 1, id, n } });
      }
    }
    function traffic(t) {
      const r = rnd();
      if (r < 0.26) inbound(t, pick(w.neighbours), 'ADVERT', 'flood');
      else if (r < 0.55) inbound(t, pick(w.neighbours), 'GRP_TXT', 'flood');
      else if (r < 0.66) inbound(t, pick(w.neighbours), 'TXT', rnd() < 0.5 ? 'direct' : 'flood');
      else if (r < 0.74) inbound(t, pick(w.neighbours), pick(['PATH', 'RESPONSE', 'TRACE']), 'flood');
      else if (r < 0.82) inbound(t, pick(w.neighbours), 'REQ', 'direct');
      else if (r < 0.9) outbound(t, 'GRP_TXT');
      else if (r < 0.97) outbound(t, 'TXT');
      else outbound(t, 'ADVERT');
    }

    // ------------------------------------------------------------ the day: sun, cloud, battery, temperatures, the Pi
    function tel(t, dtMs) {
      const simH = dtMs / 60000 * (24 / Math.max(1, cfg.sim.dayMin)) ;   // sim hours that passed
      w.hour = (w.hour + simH) % 24; w.uptimeS += simH * 3600; w.hostUp += simH * 3600;
      const sunElev = 90 * Math.sin(Math.PI * (w.hour - 6) / 12), night = sunElev <= 0;
      w.cloud = Math.max(0, Math.min(1, w.cloud + (cfg.sim.cloudy - w.cloud) * 0.02 + gauss() * 0.04));
      const sol = cfg.solar, sun = Math.max(0, Math.sin(Math.max(0, sunElev) * Math.PI / 180));
      const solarW = sol.panelW * sun * (1 - 0.8 * w.cloud) * (0.92 + rnd() * 0.08);
      const vb0 = 3.3 + 0.9 * w.soc;
      const full = w.soc >= 0.995;
      const inMa = full ? Math.min(solarW * sol.chargeEff / vb0 * 1000, sol.loadMa) : solarW * sol.chargeEff / vb0 * 1000;
      const netMa = inMa - sol.loadMa * (t < w.lowBattUntil ? 60 : 1);
      w.soc = Math.max(0.02, Math.min(1, w.soc + netMa / 1000 * simH / sol.battAh));
      if (t < w.lowBattUntil) w.soc = Math.min(w.soc, 0.07);
      // resting voltage from SOC (the core's curve, inverted), plus charge lift
      let battV = 3.3; for (let v = 3.3; v <= 4.2; v += 0.005) if (C.battPct(v) >= w.soc * 100) { battV = v; break; }
      battV += netMa > 0 ? Math.min(0.06, netMa / 8000) : netMa / 40000;
      const charge = full && sun > 0.05 ? 'float' : netMa > 0.5 ? 'charging' : night ? 'night' : 'discharging';
      const amb = 19 + 7 * Math.sin(Math.PI * (w.hour - 9) / 12);
      const tempC = amb + 14 * sun * (1 - 0.6 * w.cloud) + gauss() * 0.3 + (t < w.heatUntil ? 34 : 0);
      w.cpu = Math.max(3, Math.min(100, w.cpu + (11 - w.cpu) * 0.2 + gauss() * 3 + (rnd() < 0.04 ? 30 : 0) + (t < w.heatUntil ? 20 : 0)));
      const cpuT = 44 + w.cpu * 0.28 + (amb - 19) * 0.6 + (t < w.heatUntil ? 30 : 0);
      w.msgsHour = w.msgsHour.filter(x => t - x < 3600000);
      if (t >= w.nextLightning && cfg.sim.lightning && w.cloud > 0.72 && rnd() < 0.015) { w.nextLightning = t + 45000; at(t, ev({ type: 'env', hour: w.hour, sunElev, cloud: w.cloud, night, lightning: true }, t)); at(t + 50, ev({ type: 'log', level: 'warn', text: 'Lightning nearby: surge arrestor operated' }, t + 50)); }
      emit(ev({ type: 'env', hour: w.hour, sunElev, cloud: w.cloud, night }, t));
      emit(ev({ type: 'telemetry', dev: 'rpt', data: { battV, battPct: C.battPct(battV), solarW, solarMa: inMa, loadMa: sol.loadMa, charge, tempC, uptimeS: Math.round(w.uptimeS), rssi: w.lastRpt.rssi, snr: w.lastRpt.snr,
        rx: w.counts.rptRx, tx: w.counts.rptTx, fwd: w.counts.rptFwd, noise: Math.round(-116 + gauss() * 1.5 + (t < w.burstUntil ? 6 : 0)), fw: 'v1.18.0', role: 'Repeater' } }, t));
      const r = R();
      emit(ev({ type: 'telemetry', dev: 'cmp', data: { rssi: w.lastCmp.rssi, snr: w.lastCmp.snr, lastRxT: w.lastCmp.t || null, rx: w.counts.cmpRx, tx: w.counts.cmpTx, fw: 'v1.18.0', role: 'Companion (USB)',
        freqMHz: r.freqMHz, bwKHz: r.bwKHz, sf: r.sf, cr: r.cr, txDbm: r.txDbm } }, t));
      emit(ev({ type: 'telemetry', dev: 'host', data: { cpuPct: w.cpu, cpuTempC: cpuT, memPct: 31 + gauss() * 0.4, memUsedMb: 1240, memTotalMb: 3888, diskPct: 41.3, uptimeS: Math.round(w.hostUp), serial: w.serial, msgsPerHour: w.msgsHour.length } }, t));
    }

    function step(now) {
      const t = now != null ? now : Date.now();
      if (t < last) { last = t; return; }
      // paused (tab hidden / another page): carry on from where it stopped, not with a backlog of packets all at once
      const gap = t - last - 250;
      if (gap > 5000) {
        q.forEach(x => { x.at += gap; });
        for (const key of ['nextPkt', 'nextTel', 'nextAdvert', 'lastTel', 'crcBurstUntil', 'burstUntil', 'heatUntil', 'lowBattUntil', 'nextLightning']) if (w[key]) w[key] += gap;
      }
      if (!w.started) {   // a running station already knows its neighbourhood (heard in the last few minutes)
        w.started = true;
        for (const n of w.neighbours) { const s = sig(n), via = n.role === 'repeater' || rnd() < 0.5 ? 0 : 1;
          emit(ev({ type: 'neighbour', n: { id: n.id, name: n.name, hash: n.hash, role: n.role, snr: via ? undefined : s.snr, rssi: via ? undefined : s.rssi, hops: via, lat: n.lat, lon: n.lon, distKm: n.km, elevM: n.elevM, hM: n.hM, az: n.az, lastHeard: t - (rnd() * 600000 | 0) } }, t)); }
      }
      if (t >= w.nextTel) { tel(t, t - (w.lastTel || t)); w.lastTel = t; w.nextTel = t + 2000; }
      if (w.serial === 'up' && t >= w.nextPkt) {
        traffic(t);
        const rate = cfg.sim.trafficPerMin * (t < w.burstUntil ? 6 : 1);
        w.nextPkt = t + Math.max(400, -Math.log(1 - rnd()) * 60000 / Math.max(0.5, rate));
      } else if (w.serial !== 'up' && t >= w.nextPkt) {   // the mast carries on without the shack
        inbound(t, pick(w.neighbours), pick(['ADVERT', 'GRP_TXT']), 'flood');
        w.nextPkt = t + 60000 / Math.max(0.5, cfg.sim.trafficPerMin);
      }
      if (t >= w.nextAdvert) {   // the mast's own flood advert (MBUG: flood.advert.interval -- shown faster here)
        const p = pkt('ADVERT', 'flood', [], { name: 'VK4XXX Rpt', role: 2, lat: -27.62, lon: 152.76 });
        emit(ev({ type: 'rf', dev: 'rpt', dir: 'tx', id: `s${seq++}`, pkt: p }, t)); w.counts.rptTx++;
        w.nextAdvert = t + 180000;
      }
      q.sort((a, b) => a.at - b.at);
      while (q.length && q[0].at <= t) {
        const x = q.shift();
        if (x.ev.retryOf) { const r = x.ev.retryOf; if (w.serial === 'up') outbound(x.at, r.type, r.tryNo, r.id, r.n); continue; }
        if (x.ev.type === 'usb' && w.serial !== 'up') continue;
        emit(x.ev);
      }
      last = t;
    }
    function inject(what, now = Date.now()) {
      const t = now;
      if (what === 'lightning') { at(t, ev({ type: 'env', hour: w.hour, cloud: Math.max(w.cloud, 0.85), night: false, lightning: true }, t)); at(t + 50, ev({ type: 'log', level: 'warn', text: 'Lightning nearby: surge arrestor operated' }, t + 50)); }
      else if (what === 'usb') {
        w.serial = w.serial === 'up' ? 'down' : 'up';
        at(t, ev({ type: 'link', serial: w.serial, note: w.serial === 'up' ? 'RAK4631 back on /dev/ttyACM0' : 'USB cable pulled (simulated)' }, t));
      } else if (what === 'lowbatt') w.lowBattUntil = t + 60000;
      else if (what === 'crc') w.crcBurstUntil = t + 45000;
      else if (what === 'burst') w.burstUntil = t + 60000;
      else if (what === 'heat') w.heatUntil = t + 45000;
      else if (what === 'traffic') traffic(t);
    }
    return { step, inject, world: w, reconfig: c => { cfg = c; }, NEIGHBOURS };
  };
});
