/* Kelly Page -- Station SCADA core (LoRa Mesh > Station SCADA tab, 2026-10-23). Pure: no DOM, no timers (UMD, so the
 * Node / browser tests load it too).
 *
 * The station this page draws is the one ~99 % of MeshCore operators run (and the author's own):
 *   RPT-01  SenseCAP Solar Node P1 (nRF52840 + SX1262), MeshCore REPEATER firmware, solar + battery, up a mast
 *   CMP-01  RAK4631 WisBlock (nRF52840 + SX1262), MeshCore COMPANION (USB serial) firmware, in the shack
 *   HOST-01 Raspberry Pi 4 on the RAK's USB: the Kelly bridge (or bridge/station_scada_bridge.py) feeds this page
 *
 * Everything that reaches the UI is an EVENT in one JSON schema, whichever source made it (the simulation, Kelly's
 * own mesh link, or a WebSocket bridge) -- so the page behaves identically from any of them:
 *
 *   { v: 1, type: 'rf', t, dev: 'rpt'|'cmp'|'nbr', dir: 'tx'|'rx', id, peer?, retry?, fwd?,
 *     pkt: { type: 'ADVERT'|'TXT'|'GRP_TXT'|'ACK'|'PATH'|'REQ'|'RESPONSE'|'TRACE'|..., route: 'flood'|'direct',
 *            hops, path: ['a3f0', ...], len, snr?, rssi?, crc: 'ok'|'fail', hex?, from?, text? } }
 *       one packet on air. dev = whose antenna; peer = the neighbour id at the other end (nbr events: dev 'nbr', peer
 *       = which one). An id ties together the hops of one packet (the UI draws them as one story).
 *   { v: 1, type: 'usb', t, dir: 'to_host'|'to_node', bytes, frame? }      a serial frame on the RAK <-> Pi cable
 *   { v: 1, type: 'telemetry', t, dev: 'rpt'|'cmp'|'host', data: {...} }    fields: see FIELDS (any may be missing)
 *   { v: 1, type: 'neighbour', t, n: { id, name, hash, role, snr, rssi, hops, lat, lon, distKm, elevM, lastHeard } }
 *   { v: 1, type: 'link', t, serial: 'up'|'down', note? }                     the serial link to the companion
 *   { v: 1, type: 'env', t, hour, sunElev, cloud, night, lightning? }        sky (the simulation; a live source may skip)
 *   { v: 1, type: 'log', t, level: 'info'|'warn'|'alarm', text }
 *
 * window.StationScadaCore = { DEFAULTS, PRESETS, FIELDS, ALARMS, merge, airtimeMs, symbolMs, sensitivity, SNR_LIMIT,
 *   fsplDb, linkBudget, fresnel, level, evalAlarms, battPct, buildPacket, decodePacket, hexOf, ptName }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StationScadaCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Radio presets. They MUST match your actual nodes (a repeater on other settings hears nothing from you).
  // SEQ (MBUG wiki, 2026-10-22): 923.125 MHz, BW 62.5 kHz, SF8, CR 4/5 -- the author's veranda repeater and RAK run this.
  const PRESETS = {
    seq: { label: 'SEQ / MBUG (923.125 · 62.5 kHz · SF8)', freqMHz: 923.125, bwKHz: 62.5, sf: 8, cr: 5 },
    au915: { label: 'AU 915 wide (915.800 · 250 kHz · SF10)', freqMHz: 915.8, bwKHz: 250, sf: 10, cr: 5 },
    aunarrow: { label: 'AU narrow (916.575 · 62.5 kHz · SF7)', freqMHz: 916.575, bwKHz: 62.5, sf: 7, cr: 8 },
  };

  // Everything a member may want to change: Config box on the tab (saved in Kelly's settings, merged over these).
  const DEFAULTS = {
    // radio params -- must match the real nodes; preamble 16 is MeshCore's radio init (RadioLib begin(..., 16))
    radio: { preset: 'seq', freqMHz: 923.125, bwKHz: 62.5, sf: 8, cr: 5, preamble: 16, txDbm: 22 },
    // colours: one place (spec: TX amber/red, RX green/cyan, USB blue, errors magenta)
    colors: { tx: '#ffb020', txHot: '#ff5a36', rx: '#39ff88', rxAlt: '#00e5ff', usb: '#3d8bff', err: '#ff2bd6', idle: '#2c3e68' },
    colorsCrt: { tx: '#d8ff9a', txHot: '#f4ffd0', rx: '#4dff7a', rxAlt: '#2fd35a', usb: '#8dff9f', err: '#ffffff', idle: '#145a26' },
    // antennas: the mast node's and the shack node's (link budget, Fresnel)
    ant: {
      rpt: { gainDbi: 3, cableDb: 0.3, heightM: 10, label: 'P1 whip (on the node)' },
      cmp: { gainDbi: 2, cableDb: 0.5, heightM: 3, label: 'RAK stub (indoors)' },
      siteElevM: 30,           // ground at the mast, metres above sea level
      extraLossDb: 8,          // walls / roof for the indoor node's path to the mast
    },
    // between the mast and a neighbour: no elevation data in Kelly -- put your own obstacles in (km from the mast, m above ground)
    terrain: [{ atKm: 0.15, heightM: 9, label: 'rooftops' }, { atKm: 1.2, heightM: 22, label: 'trees' }],
    limits: {
      battV: { warnLo: 3.55, alarmLo: 3.4 }, tempC: { warnHi: 50, alarmHi: 60 }, cpuTempC: { warnHi: 70, alarmHi: 80 },
      cpuPct: { warnHi: 80, alarmHi: 95 }, memPct: { warnHi: 85, alarmHi: 95 }, diskPct: { warnHi: 85, alarmHi: 95 },
      dutyPct: { warnHi: 5, alarmHi: 10 },     // channel-busy share; AU LIPD has no duty limit, this is congestion
      noRxMin: 10, crcPer10Min: 5, snr: { warnLo: -5, alarmLo: -10 }, rssi: { warnLo: -115, alarmLo: -122 },
    },
    // P1-Pro: approximate -- check your unit. Draw is the whole node, averaged (repeater RX mostly).
    solar: { panelW: 5, battAh: 13.4, battNomV: 3.7, loadMa: 14, chargeEff: 0.8 },
    sim: { dayMin: 24, trafficPerMin: 9, crcPct: 3, cloudy: 0.3, lightning: true },
    sound: { tx: true, rx: true, usb: true, alarm: true },
    features: { waterfall: true, inspector: true, hoptrace: true, budget: true, fresnel: true, airtime: true, solar: true,
      swr: true, annunciator: true, trends: true, neighbours: true, weather: true, cwid: true },
    theme: 'control',          // 'control' | 'crt'
    source: 'sim',             // 'sim' | 'kelly' | 'ws'
    wsUrl: 'ws://raspberrypi.local:8765/scada',
    names: { rpt: 'RPT-01 SOLAR P1', cmp: 'CMP-01 RAK4631', host: 'HOST-01 RPI4' },
  };
  const merge = (base, over) => {
    if (Array.isArray(base) || base == null || typeof base !== 'object') return over === undefined ? base : over;
    const out = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(over || {})])) out[k] = over && k in over ? (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], over[k]) : over[k]) : base[k];
    return out;
  };

  // what each device reports (labels + units for the panels; a live source fills what it can)
  const FIELDS = {
    rpt: [['battV', 'Battery', 'V'], ['battPct', 'Battery', '%'], ['solarMa', 'Solar charge', 'mA'], ['solarW', 'Solar', 'W'], ['charge', 'Charging', ''],
      ['tempC', 'Enclosure', '°C'], ['uptimeS', 'Uptime', 's'], ['rssi', 'Last RSSI', 'dBm'], ['snr', 'Last SNR', 'dB'], ['rx', 'RX', ''], ['tx', 'TX', ''],
      ['fwd', 'Forwarded', ''], ['dutyPct', 'Airtime', '%'], ['noise', 'Noise floor', 'dBm']],
    cmp: [['rssi', 'RSSI', 'dBm'], ['snr', 'SNR', 'dB'], ['lastRxT', 'Last packet', ''], ['rx', 'RX', ''], ['tx', 'TX', ''], ['fw', 'Firmware', ''], ['role', 'Role', ''],
      ['freqMHz', 'Freq', 'MHz'], ['bwKHz', 'BW', 'kHz'], ['sf', 'SF', ''], ['cr', 'CR', ''], ['txDbm', 'TX power', 'dBm']],
    host: [['cpuPct', 'CPU', '%'], ['cpuTempC', 'CPU temp', '°C'], ['memPct', 'RAM', '%'], ['diskPct', 'Disk', '%'], ['uptimeS', 'Uptime', 's'], ['serial', 'Serial link', ''], ['msgsPerHour', 'Messages', '/h']],
  };

  // ---------------------------------------------------------------- LoRa maths (Semtech AN1200.13 / SX1262 datasheet)
  const symbolMs = r => Math.pow(2, r.sf) / (r.bwKHz * 1000) * 1000;
  // time on air of `len` payload bytes; cr 5..8 = 4/5..4/8; explicit header, CRC on; low data rate optimise when Tsym > 16 ms
  function airtimeMs(len, r) {
    const ts = symbolMs(r), de = ts > 16 ? 1 : 0, crIdx = Math.max(1, Math.min(4, (r.cr | 0) - 4));
    const pre = ((r.preamble == null ? 8 : r.preamble) + 4.25) * ts;
    const n = 8 + Math.max(Math.ceil((8 * len - 4 * r.sf + 28 + 16) / (4 * (r.sf - 2 * de))) * (crIdx + 4), 0);
    return pre + n * ts;
  }
  // demodulator SNR floor per SF (SX126x datasheet) and the resulting sensitivity (NF 6 dB)
  const SNR_LIMIT = { 5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };
  const sensitivity = r => -174 + 10 * Math.log10(r.bwKHz * 1000) + 6 + (SNR_LIMIT[r.sf] ?? -10);
  const fsplDb = (km, mhz) => 20 * Math.log10(Math.max(km, 0.001)) + 20 * Math.log10(mhz) + 32.44;
  // TX -> RX: what the far end should hear, and how far above its sensitivity that is
  function linkBudget({ txDbm, txGain, txCable, rxGain, rxCable, extraDb = 0, km, mhz, rssi, snr, radio }) {
    const fspl = fsplDb(km, mhz), eirp = txDbm - txCable + txGain;
    const predicted = eirp - fspl + rxGain - rxCable - extraDb, sens = sensitivity(radio);
    const measured = rssi == null ? null : rssi;
    return { eirp, fspl, predicted, sens, measured, margin: (measured ?? predicted) - sens, snrMargin: snr == null ? null : snr - (SNR_LIMIT[radio.sf] ?? -10) };
  }
  // first Fresnel zone + 4/3-earth bulge between the mast (h1 above ground at elev1) and a neighbour (h2 at elev2), km apart.
  // obstacles [{atKm, heightM}] are above the local ground (taken as the mast's). -> worst clearance as % of r1
  function fresnel({ km, mhz, h1, elev1, h2, elev2, obstacles = [], steps = 60 }) {
    const a = elev1 + h1, b = elev2 + h2, fG = mhz / 1000, pts = [];
    let worst = Infinity, worstAt = null;
    const chk = (x, gnd, label) => {
      const d1 = x, d2 = km - x; if (d1 <= 0 || d2 <= 0) return;
      const los = a + (b - a) * x / km, r1 = 17.32 * Math.sqrt(d1 * d2 / (fG * km)), bulge = d1 * d2 / (12.74 * 4 / 3);
      const top = gnd + bulge, clear = (los - top) / r1 * 100;
      pts.push({ x, los, r1, top, label });
      if (clear < worst) { worst = clear; worstAt = { x, label, r1, los, top }; }
    };
    for (let i = 1; i < steps; i++) chk(km * i / steps, elev1, null);   // flat ground at the mast's level between (no elevation data)
    for (const o of obstacles) if (o.atKm > 0 && o.atKm < km) chk(o.atKm, elev1 + o.heightM, o.label || 'obstacle');
    pts.sort((p, q) => p.x - q.x);
    return { pts, clearPct: worst === Infinity ? 100 : worst, worstAt, a, b, r1mid: 17.32 * Math.sqrt((km / 2) * (km / 2) / (fG * km)) };
  }

  // ---------------------------------------------------------------- limits and alarms
  // a value against { warnLo, alarmLo, warnHi, alarmHi } -> 'ok' | 'warn' | 'alarm' | '' (no value)
  function level(v, lim) {
    if (v == null || Number.isNaN(v) || !lim) return '';
    if ((lim.alarmLo != null && v <= lim.alarmLo) || (lim.alarmHi != null && v >= lim.alarmHi)) return 'alarm';
    if ((lim.warnLo != null && v <= lim.warnLo) || (lim.warnHi != null && v >= lim.warnHi)) return 'warn';
    return 'ok';
  }
  // annunciator tiles (spec order). Each: (s, lim) -> { on, level, why } from the UI's rolling state s
  const ALARMS = [
    { id: 'LOW_BATT', label: 'LOW BATT', test: (s, l) => { const v = s.rpt.battV, lv = level(v, l.battV); return { on: lv === 'warn' || lv === 'alarm', level: lv, why: v == null ? '' : `${v.toFixed(2)} V` }; } },
    { id: 'HIGH_TEMP', label: 'HIGH TEMP', test: (s, l) => { const a = level(s.rpt.tempC, l.tempC), b = level(s.host.cpuTempC, l.cpuTempC), lv = a === 'alarm' || b === 'alarm' ? 'alarm' : a === 'warn' || b === 'warn' ? 'warn' : 'ok';
      return { on: lv !== 'ok', level: lv, why: [s.rpt.tempC != null ? `node ${s.rpt.tempC.toFixed(0)} °C` : '', s.host.cpuTempC != null ? `Pi ${s.host.cpuTempC.toFixed(0)} °C` : ''].filter(Boolean).join(' · ') }; } },
    { id: 'SERIAL_LOST', label: 'SERIAL LOST', test: s => ({ on: s.serial === 'down', level: 'alarm', why: s.serial === 'down' ? 'no companion on the USB link' : '' }) },
    { id: 'NO_RX', label: 'NO RX 10 MIN', test: (s, l) => { const age = s.lastRxT ? (s.now - s.lastRxT) / 60000 : null; return { on: age != null && age >= l.noRxMin, level: 'warn', why: age == null ? '' : `${age.toFixed(0)} min` }; } },
    { id: 'HIGH_DUTY', label: 'HIGH DUTY CYCLE', test: (s, l) => { const lv = level(s.dutyPct, l.dutyPct); return { on: lv === 'warn' || lv === 'alarm', level: lv, why: s.dutyPct == null ? '' : `${s.dutyPct.toFixed(1)} %` }; } },
    { id: 'CRC', label: 'CRC ERRORS', test: (s, l) => ({ on: s.crc10 >= l.crcPer10Min, level: 'warn', why: `${s.crc10} in 10 min` }) },
  ];
  const evalAlarms = (s, lim) => ALARMS.map(a => Object.assign({ id: a.id, label: a.label }, a.test(s, lim)));
  // Li-ion resting voltage -> % (rough, single cell)
  const CURVE = [[3.3, 0], [3.5, 8], [3.6, 18], [3.7, 38], [3.8, 58], [3.9, 74], [4.0, 86], [4.1, 95], [4.2, 100]];
  function battPct(v) {
    if (v == null) return null;
    if (v <= CURVE[0][0]) return 0; if (v >= 4.2) return 100;
    for (let i = 1; i < CURVE.length; i++) if (v <= CURVE[i][0]) { const [x0, y0] = CURVE[i - 1], [x1, y1] = CURVE[i]; return y0 + (y1 - y0) * (v - x0) / (x1 - x0); }
    return 100;
  }

  // ---------------------------------------------------------------- MeshCore packets (wire format, as meshcore.js decodeRaw)
  // header: route (bits 0-1: 0 transport flood, 1 flood, 2 direct, 3 transport direct) | payload type (2-5) | version (6-7)
  const PT = { REQ: 0, RESPONSE: 1, TXT: 2, ACK: 3, ADVERT: 4, GRP_TXT: 5, GRP_DATA: 6, ANON_REQ: 7, PATH: 8, TRACE: 9, MULTIPART: 10, CONTROL: 11, RAW: 15 };
  const ptName = n => Object.keys(PT).find(k => PT[k] === n) || `TYPE ${n}`;
  const hexOf = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  // a believable packet: { type: 'ADVERT', route, path: ['a3f0'...] (2-byte hashes = MBUG's path.hash.mode 1), len?, name?, lat?, lon? }
  // rnd = a 0..1 source (seeded in tests) -> Uint8Array
  function buildPacket(p, rnd = Math.random) {
    const type = PT[p.type] ?? 0, route = p.route === 'direct' ? 2 : 1, path = p.path || [], sz = path.length ? path[0].length / 2 : 2;
    const bytes = [route | type << 2, ((sz - 1) << 6) | (path.length & 63)];
    for (const h of path) for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
    const r8 = () => (rnd() * 256) | 0;
    if (p.type === 'ADVERT') {
      for (let i = 0; i < 32; i++) bytes.push(p.key ? parseInt(p.key.slice(i * 2, i * 2 + 2) || '00', 16) : r8());
      const ts = Math.floor((p.ts || Date.now()) / 1000); bytes.push(ts & 255, ts >>> 8 & 255, ts >>> 16 & 255, ts >>> 24 & 255);
      for (let i = 0; i < 64; i++) bytes.push(r8());           // signature
      const role = p.role || 2, hasLoc = p.lat != null; bytes.push(role | (hasLoc ? 0x10 : 0) | 0x80);
      if (hasLoc) { for (const v of [Math.round(p.lat * 1e6), Math.round(p.lon * 1e6)]) bytes.push(v & 255, v >> 8 & 255, v >> 16 & 255, v >> 24 & 255); }
      for (const c of new TextEncoder().encode(p.name || 'node')) bytes.push(c);
    } else {
      const n = Math.max(p.type === 'ACK' ? 4 : 4, (p.len || 24) - bytes.length);
      for (let i = 0; i < n; i++) bytes.push(r8());
    }
    return Uint8Array.from(bytes);
  }
  // the inspector's view of a packet's bytes: { routeName, type, version, transport, hops, hashSize, path, payloadLen, advert? }
  function decodePacket(b) {
    if (!b || b.length < 2) return null;
    const hdr = b[0], route = hdr & 3, type = (hdr >> 2) & 15, ver = hdr >> 6;
    let o = 1; const transport = route === 0 || route === 3; if (transport) o += 4;
    const pl = b[o++], sz = (pl >> 6) + 1, n = pl & 63, path = [];
    for (let i = 0; i < n && o + sz <= b.length; i++, o += sz) path.push(hexOf(b.subarray(o, o + sz)));
    const out = { routeName: ['transport flood', 'flood', 'direct', 'transport direct'][route], route: route <= 1 ? 'flood' : 'direct', type: ptName(type), version: ver, transport, hops: n, hashSize: sz, path, payloadLen: Math.max(0, b.length - o), headerLen: o };
    if (type === PT.ADVERT && b.length - o >= 101) {
      const pay = b.subarray(o), flags = pay[100];
      out.advert = { key: hexOf(pay.subarray(0, 32)), role: ['node', 'companion', 'repeater', 'room server', 'sensor'][flags & 15] || `role ${flags & 15}` };
      let i = 101;
      const i32 = j => (pay[j] | pay[j + 1] << 8 | pay[j + 2] << 16 | pay[j + 3] << 24);
      if (flags & 0x10 && pay.length >= i + 8) { out.advert.lat = i32(i) / 1e6; out.advert.lon = i32(i + 4) / 1e6; i += 8; }
      if (flags & 0x20) i += 2; if (flags & 0x40) i += 2;
      if (flags & 0x80) out.advert.name = new TextDecoder().decode(pay.subarray(i)).replace(/\0.*$/, '');
    }
    return out;
  }

  return { DEFAULTS, PRESETS, FIELDS, ALARMS, PT, merge, airtimeMs, symbolMs, sensitivity, SNR_LIMIT, fsplDb, linkBudget, fresnel, level, evalAlarms, battPct, buildPacket, decodePacket, hexOf, ptName };
});
