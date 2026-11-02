/* Kelly Page -- LoRa APRS trackers / iGates, for the LoRa Mesh page (js/mesh.js).
 *
 * On air every LoRa APRS station sends "<\xff\x01" + TNC2 text ("CALL>DEST,PATH:payload", 433.775 MHz in VK).
 * The device turns that into something an app can read. From the firmware source (2026-10-17):
 *   CA2RXU LoRa_APRS_Tracker (T-Beam, Heltec, T-Deck... -- the one hams run now), Bluetooth, chosen in its WebUI:
 *     KISS:  service 00000001-ba2a-46c9-ae49-01b0961f68bb, notify ...0003, write ...0002 -- KISS frames of AX.25 UI
 *     TNC2:  service 6e400001-b5a3-f393-e0a9-e50e24dcca9e with the Nordic UART roles SWAPPED (notify 6e400002,
 *            write 6e400003) -- text, one byte per notification ending '\n'; a write is one packet, no newline
 *     No PIN. One packet held at a time (a second write before it's sent replaces it): Kelly sends one, waits 5 s.
 *     USB is log output only -- "LoRa Rx ---> <TNC2>" lines -- so over USB a tracker is receive-only.
 *     Classic-ESP32 boards default to Bluetooth Classic, which a browser can't use: set Type = BLE.
 *   CA2RXU LoRa_APRS_iGate: KISS (default) or TNC2 lines on USB (tnc.enableSerial) or TCP 8001 (Kelly bridge).
 *   DL9SAU T-Beam / sh123 esp32_loraprs ("LoRa KISS modem"): KISS on USB; loraprs also BLE KISS (same UUIDs, PIN 123456).
 * Characteristics are picked by property, not UUID (mesh.js bleLink), because of the swapped TNC2 roles.
 * KISS: C0 00 <AX.25> C0, FESC DB / TFEND DC / TFESC DD; exactly one leading C0 (a CA2RXU iGate drops C0 C0 00...).
 * AX.25 UI: DEST SRC DIGI.. (7 bytes each: call<<1 space-padded, SSID byte 0b0CC SSSS E, H = 0x80 on a digi = '*',
 * E = last address), 03 F0, info.
 * Kelly's station: Settings > LoRa APRS callsign (default your call -7; use a different SSID from the tracker,
 * which ACKs messages to its own call). Messages to it are DMs and Kelly ACKs them; other APRS messages heard,
 * statuses and bulletins go in the "APRS" channel. Positions parsed = the gateway's aprs-nearby.js parse().
 *
 * window.KellyLoraAprs = { DRIVER, ... } -- the same driver shape as js/meshcore.js.
 */
(function (root) {
  'use strict';
  const FEND = 0xc0, FESC = 0xdb, TFEND = 0xdc, TFESC = 0xdd;
  const KISS_SVC = '00000001-ba2a-46c9-ae49-01b0961f68bb', NUS_SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const TOCALL = 'APZKLY', PATH = 'WIDE1-1', MAX_MSG = 67;
  const enc = new TextEncoder(), dec = new TextDecoder('latin1');

  // ---- KISS
  function kissWrap(data) {
    const out = [FEND, 0x00];
    for (const b of data) { if (b === FEND) out.push(FESC, TFEND); else if (b === FESC) out.push(FESC, TFESC); else out.push(b); }
    out.push(FEND); return Uint8Array.from(out);
  }
  function kissUnwrap(f) { const out = []; for (let i = 0; i < f.length; i++) { const b = f[i]; if (b === FESC && i + 1 < f.length) { out.push(f[++i] === TFEND ? FEND : FESC); } else out.push(b); } return Uint8Array.from(out); }

  // ---- AX.25 UI <-> TNC2
  function addr(call, flags) {
    const [base, ssid] = String(call).toUpperCase().split('-'), b = new Uint8Array(7);
    for (let i = 0; i < 6; i++) b[i] = (base.charCodeAt(i) || 0x20) << 1;
    b[6] = flags | ((Math.min(15, parseInt(ssid, 10) || 0)) << 1);
    return b;
  }
  function tnc2ToAx25(tnc2) {
    const gt = tnc2.indexOf('>'), colon = tnc2.indexOf(':', gt);
    const src = tnc2.slice(0, gt), [dest, ...digis] = tnc2.slice(gt + 1, colon).split(','), info = enc.encode(tnc2.slice(colon + 1));
    const parts = [addr(dest, 0xe0), addr(src, 0x60), ...digis.map(d => addr(d.replace('*', ''), 0x60 | (d.endsWith('*') ? 0x80 : 0)))];
    parts[parts.length - 1][6] |= 1;
    const out = new Uint8Array(parts.length * 7 + 2 + info.length);
    parts.forEach((p, i) => out.set(p, i * 7)); out[parts.length * 7] = 0x03; out[parts.length * 7 + 1] = 0xf0; out.set(info, parts.length * 7 + 2);
    return out;
  }
  function ax25ToTnc2(b) {
    const call = o => { let s = ''; for (let i = 0; i < 6; i++) { const c = b[o + i] >> 1; if (c !== 0x20) s += String.fromCharCode(c); } const ssid = (b[o + 6] >> 1) & 15; return ssid ? `${s}-${ssid}` : s; };
    const as = []; let o = 0;
    for (; o + 7 <= b.length && as.length < 10; o += 7) { as.push({ c: call(o), h: !!(b[o + 6] & 0x80) }); if (b[o + 6] & 1) { o += 7; break; } }
    if (as.length < 2 || o + 2 > b.length) return null;
    const lastH = as.map((a, i) => i >= 2 && a.h ? i : -1).reduce((m, v) => Math.max(m, v), -1);
    const path = as.slice(2).map((a, i) => a.c + (i + 2 === lastH ? '*' : ''));
    return `${as[1].c}>${[as[0].c, ...path].join(',')}:${dec.decode(b.subarray(o + 2))}`;
  }

  // ---- APRS positions (= gateway/aprs-nearby.js parse(), keep in step)
  function uncompressed(s) {
    const m = /^(\d{2})([\d ]{2}\.[\d ]{2})([NS])(.)(\d{3})([\d ]{2}\.[\d ]{2})([EW])(.)/.exec(s);
    if (!m) return null;
    const n = v => parseFloat(v.replace(/ /g, '5'));
    let lat = +m[1] + n(m[2]) / 60, lon = +m[5] + n(m[6]) / 60;
    if (m[3] === 'S') lat = -lat; if (m[7] === 'W') lon = -lon;
    const p = { lat, lon, table: m[4], code: m[8], rest: s.slice(19) };
    const cs = /^(\d{3})\/(\d{3})/.exec(p.rest);
    if (cs && p.code !== '_') { p.course = +cs[1] % 360; p.kmh = Math.round(+cs[2] * 1.852); p.rest = p.rest.slice(7); }
    return p;
  }
  function compressed(s) {
    if (s.length < 13 || !/^[\/\\A-Za-j]$/.test(s[0])) return null;
    const b91 = t => [...t].reduce((v, c) => v * 91 + c.charCodeAt(0) - 33, 0);
    if (![...s.slice(1, 9)].every(c => c >= '!' && c <= '{')) return null;
    const p = { lat: 90 - b91(s.slice(1, 5)) / 380926, lon: -180 + b91(s.slice(5, 9)) / 190463, table: s[0], code: s[9], rest: s.slice(13) };
    const c = s.charCodeAt(10) - 33, sp = s.charCodeAt(11) - 33;
    if (s[10] !== ' ' && c >= 0 && c <= 89) { p.course = c * 4; p.kmh = Math.round((1.08 ** sp - 1) * 1.852); }
    return p;
  }
  const position = s => /^\d/.test(s) ? uncompressed(s) : compressed(s);
  function micE(dest, info) {
    const d = dest.replace(/-.*$/, '');
    if (d.length < 6 || info.length < 9) return null;
    const digit = c => /[0-9]/.test(c) ? +c : /[A-J]/.test(c) ? c.charCodeAt(0) - 65 : /[P-Y]/.test(c) ? c.charCodeAt(0) - 80 : /[KLZ]/.test(c) ? 0 : NaN;
    const dg = [...d.slice(0, 6)].map(digit);
    if (dg.some(Number.isNaN)) return null;
    const north = /[P-Z]/.test(d[3]), lonOff = /[P-Z]/.test(d[4]) ? 100 : 0, west = /[P-Z]/.test(d[5]);
    let lat = dg[0] * 10 + dg[1] + (dg[2] * 10 + dg[3] + (dg[4] * 10 + dg[5]) / 100) / 60; if (!north) lat = -lat;
    const b = i => info.charCodeAt(i) - 28;
    let deg = b(1) + lonOff; if (deg >= 180 && deg <= 189) deg -= 80; else if (deg >= 190 && deg <= 199) deg -= 190;
    let min = b(2); if (min >= 60) min -= 60;
    let lon = deg + (min + b(3) / 100) / 60; if (west) lon = -lon;
    const sp = b(4), dc = b(5), se = b(6);
    let knots = sp * 10 + Math.floor(dc / 10); if (knots >= 800) knots -= 800;
    let course = (dc % 10) * 100 + se; if (course >= 400) course -= 400;
    return { lat, lon, table: info[8], code: info[7], course: course % 360, kmh: Math.round(knots * 1.852), rest: info.slice(9), mice: true };
  }
  // One TNC2 packet -> { from, dest, path, digis, info, pos?: {name, lat, lon, sym, comment, kmh, course}, msg?: {to, text, id, ack, rej}, status? }
  function parse(line, depth = 0) {
    const gt = line.indexOf('>'), colon = line.indexOf(':', gt);
    if (gt < 1 || colon < 0) return null;
    const from = line.slice(0, gt), path = line.slice(gt + 1, colon).split(','), info = line.slice(colon + 1), t = info[0];
    const r = { from, dest: path[0], path: path.slice(1), info, digis: path.slice(1).filter(x => x.endsWith('*')).length };
    if (t === '}' && depth < 2) { const inner = parse(info.slice(1), depth + 1); if (inner) inner.via = from; return inner; }
    if (t === ':' && info.length >= 11 && info[10] === ':') {
      const to = info.slice(1, 10).trim(), body = info.slice(11);
      const ack = /^ack([A-Za-z0-9]{1,5})/.exec(body), rej = /^rej([A-Za-z0-9]{1,5})/.exec(body);
      if (ack || rej) r.msg = { to, ack: ack && ack[1], rej: rej && rej[1] };
      else { const m = /^(.*?)(?:\{([A-Za-z0-9]{1,5})(?:\}.*)?)?$/.exec(body); r.msg = { to, text: m[1], id: m[2] || null }; }
      return r;
    }
    if (t === '>') { r.status = info.slice(1).replace(/[^\x20-\x7e]/g, ''); return r; }
    let p = null, name = from, killed = false;
    if (t === '!' || t === '=') p = position(info.slice(1));
    else if (t === '/' || t === '@') p = position(info.slice(8));
    else if (t === ';' && info.length > 18) { name = info.slice(1, 10).trim(); killed = info[10] === '_'; p = position(info.slice(18)); }
    else if (t === ')') { const m = /^\)([^!_]{3,9})([!_])/.exec(info); if (m) { name = m[1].trim(); killed = m[2] === '_'; p = position(info.slice(m[0].length)); } }
    else if (t === '`' || t === "'" || t === '\x1c' || t === '\x1d') p = micE(path[0] || '', info);
    if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && (p.lat || p.lon)) {
      let comment = String(p.rest || '').replace(/[^\x20-\x7e]/g, '');
      if (p.mice) comment = comment.replace(/^[`'">\]]?(.{3}\})?/, '').replace(/\|[!-{]{2,}\|/g, '').replace(/[_=^~`'"]?\d?$/, '');
      const alt = /\/A=(-?\d{6})/.exec(comment);
      comment = comment.replace(/\/A=-?\d{6}/, '').trim();
      r.pos = { name, lat: p.lat, lon: p.lon, sym: p.table + p.code, course: p.course, kmh: p.kmh, comment, killed, alt: alt ? Math.round(+alt[1] * 0.3048) : null };
    }
    return r;
  }
  const KIND = { APLRT1: 'LoRa tracker', APLRG1: 'LoRa iGate', APLRFD: 'LoRa digi', APZKLY: 'Kelly', APLETK: 'LoRa tracker', APLIGA: 'LoRa iGate' };
  const SYM = { '/[': 'Walker', '/>': 'Car', '/k': 'Truck', '/-': 'House', '/_': 'Weather', '/#': 'Digi', '/&': 'Gateway', '/b': 'Bike', '/<': 'Motorbike', '/v': 'Van', '/j': 'Jeep', '/r': 'Antenna', '/y': 'Yagi', '/s': 'Boat', '/O': 'Balloon', '/\'': 'Plane' };
  const hash = s => { let h = 0x811c9dc5; for (const c of enc.encode(s)) h = Math.imul(h ^ c, 0x01000193) >>> 0; return (h | 0x80000000) >>> 0; };

  // Byte stream from USB / the bridge / BLE: KISS frames, and any text outside them as lines (TNC2 lines from an
  // iGate in TNC2 mode or BLE TNC2 mode, a tracker's "LoRa Rx ---> TNC2" log lines, or plain logging).
  class Framer {
    constructor(onFrame, onLine) { this.onFrame = onFrame; this.onLine = onLine || (() => {}); this.k = null; this.t = []; }
    push(bytes) {
      for (const b of bytes) {
        if (b === FEND) { if (this.k && this.k.length > 1) this.done(); this.k = []; this.flush(); continue; }
        if (this.k && !this.k.length && b >= 0x20 && b !== FESC) this.k = null;   // text after a frame's closing C0, not a new frame
        if (this.k) { this.k.push(b); if (this.k.length > 600) this.k = null; continue; }
        if (b === 0x0a || b === 0x0d) this.flush(); else if (this.t.length < 400) this.t.push(b);
      }
    }
    done() { const f = Uint8Array.from(this.k); this.k = null; if (f[0] !== 0x00) return; const ax = kissUnwrap(f.subarray(1)); const t = ax25ToTnc2(ax); if (t) this.onFrame({ tnc2: t, kiss: true }); }
    flush() {
      if (!this.t.length) return;
      const s = dec.decode(Uint8Array.from(this.t)).trim(); this.t = [];
      if (!s) return;
      const m = /(?:Rx|RX)[^>]*--->\s*(\S+>\S+?:.*)$/.exec(s) || (/^[A-Z0-9]{3,7}(-\d{1,2})?>[A-Z0-9,*-]+:/.test(s) ? [0, s] : null);
      if (m) this.onFrame({ tnc2: m[1], kiss: false }); else this.onLine(s);
    }
  }

  // io as in meshcore.js; plus io.cfg() -> { call } (Kelly's own APRS callsign-SSID) and io.mode ('kiss' | 'tnc2' |
  // 'serial' -- serial = KISS unless the device only ever sent TNC2 lines)
  function Session(io) {
    const cfg = () => io.cfg(), mine = () => String(cfg().call || '').toUpperCase();
    let sawKiss = io.mode === 'kiss', sawText = io.mode === 'tnc2', msgNo = Math.floor(Math.random() * 900) + 100, lastTx = 0;
    const pend = new Map();   // msg id -> ref
    const outQ = []; let pumping = false;
    const wire = tnc2 => (io.mode === 'tnc2' || (io.mode === 'serial' && sawText && !sawKiss)) ? enc.encode(tnc2 + (io.mode === 'serial' ? '\n' : '')) : kissWrap(tnc2ToAx25(tnc2));
    function tx(tnc2) { return new Promise((resolve, reject) => { outQ.push({ tnc2, resolve, reject }); pump(); }); }
    async function pump() {
      if (pumping) return; pumping = true;
      while (outQ.length) {
        const j = outQ.shift(), wait = lastTx + 5000 - Date.now();   // the tracker holds ONE packet: space them
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try { await io.send(wire(j.tnc2)); lastTx = Date.now(); io.log(`TX ${j.tnc2}`); j.resolve(); } catch (e) { j.reject(e); }
      }
      pumping = false;
    }
    const nodeFor = (call, extra = {}) => ({ num: hash(call), idLabel: call, longName: call, shortName: call.replace(/-.*$/, '').slice(-4), licensed: true, lastHeard: Date.now(), ...extra });
    function onFrame({ tnc2, kiss }) {
      if (kiss) sawKiss = true; else sawText = true;
      const p = parse(tnc2);
      io.log(`RX ${tnc2}`);
      if (!p) return;
      const hops = p.digis;
      const base = { hwLabel: KIND[String(p.dest).replace(/-.*$/, '')] || 'APRS station', hops };
      if (p.pos) {
        const n = nodeFor(p.pos.name, { ...base, lat: p.pos.lat, lon: p.pos.lon, alt: p.pos.alt, speed: p.pos.kmh, comment: p.pos.comment });
        if (SYM[p.pos.sym]) n.hwLabel = `${SYM[p.pos.sym]} · ${n.hwLabel}`;
        if (p.pos.killed) return;
        io.node(n);
      } else io.node(nodeFor(p.from, base));
      if (p.status) io.text({ dm: false, ch: 0, num: hash(p.from), text: `[status] ${p.status}`, hops });
      if (!p.msg) return;
      const me = mine(), toMe = p.msg.to.toUpperCase() === me;
      if (p.msg.ack || p.msg.rej) { if (toMe) { const r = pend.get(p.msg.ack || p.msg.rej); if (r) { pend.delete(p.msg.ack || p.msg.rej); io.ack(r, p.msg.ack ? 'delivered' : 'failed', p.msg.rej ? 'rejected' : ''); } } return; }
      if (toMe) {
        io.text({ dm: true, num: hash(p.from), text: p.msg.text, hops, key: `${p.from}:${p.msg.id || p.msg.text}` });
        if (p.msg.id) tx(`${me}>${TOCALL},${PATH}::${p.from.padEnd(9)}:ack${p.msg.id}`).catch(() => {});
      } else if (/^BLN/i.test(p.msg.to)) io.text({ dm: false, ch: 0, num: hash(p.from), text: `[bulletin] ${p.msg.text}`, hops });
      else if (p.from.toUpperCase() !== me) io.text({ dm: false, ch: 0, num: hash(p.from), text: `→ ${p.msg.to}: ${p.msg.text}`, hops });
    }
    const latStr = v => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return `${String(d).padStart(2, '0')}${m.toFixed(2).padStart(5, '0')}${v < 0 ? 'S' : 'N'}`; };
    const lonStr = v => { const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60; return `${String(d).padStart(3, '0')}${m.toFixed(2).padStart(5, '0')}${v < 0 ? 'W' : 'E'}`; };
    return {
      onFrame,
      async start() {
        if (!/^[A-Z0-9]{3,6}(-([0-9]|1[0-5]))?$/.test(mine())) throw new Error('set your LoRa APRS callsign-SSID first (e.g. VK4XXX-7)');
        io.self(nodeFor(mine(), { hwLabel: 'Kelly · LoRa APRS' }));
        io.channels([{ index: 0, name: 'APRS' }]);
        io.status('on', io.mode === 'serial' ? 'Listening. A CA2RXU tracker\'s USB port only receives -- use Bluetooth to send.' : '');
      },
      async sendText(target, text, ref) {
        const me = mine(), clean = String(text).replace(/[|~{]/g, '').slice(0, MAX_MSG);
        if (target.dm) {
          const to = target.dm.idLabel;
          if (!to) throw new Error('that station has no callsign');
          const id = String(++msgNo % 100000);
          pend.set(id, ref);
          setTimeout(() => { if (pend.delete(id)) io.ack(ref, 'noack', 'no ack in 90 s'); }, 90000);
          await tx(`${me}>${TOCALL},${PATH}::${to.padEnd(9)}:${clean}{${id}`);
          return 'sent';
        }
        await tx(`${me}>${TOCALL},${PATH}:>${clean}`);   // the APRS channel: a status
        return 'sent';
      },
      async sharePosition(lat, lon) { await tx(`${mine()}>${TOCALL},${PATH}:!${latStr(lat)}/${lonStr(lon)}[Kelly P25 ${mine()}`); },
      heartbeat() {},
      maxText: () => MAX_MSG,
    };
  }

  const DRIVER = {
    id: 'aprs', label: 'LoRa APRS', baud: 115200,
    ble: { services: [KISS_SVC, NUS_SVC], modes: { [KISS_SVC]: 'kiss', [NUS_SVC]: 'tnc2' }, framed: false },
    caps: { trace: false, react: false, askPos: false, dm: true, channels: true, sharePos: true },
    hint: 'A CA2RXU LoRa APRS tracker over Bluetooth (its WebUI: Bluetooth on, Type BLE, Protocol KISS or TNC2), or an iGate / KISS TNC over USB. A tracker\'s USB port only listens.',
    Framer, Session,   // no wrap: the Session already writes KISS frames or TNC2 text
  };
  root.KellyLoraAprs = { DRIVER, parse, kissWrap, kissUnwrap, tnc2ToAx25, ax25ToTnc2, Framer };
})(typeof window !== 'undefined' ? window : globalThis);
