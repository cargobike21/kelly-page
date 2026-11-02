/* Kelly Page -- DNP3 (IEEE 1815) codec, pure (UMD: window.DNP3 in the page, module.exports under Node).
 *
 * The JS twin of scripts/dnp3.py (the P25X DNP3-over-P25 bench codec) -- keep the shared parts in step: the CRC,
 * build_frame's layout (ctrl 0xC4/0xC3 master->outstation, one transport segment), app_request's AC octet, the g12v1
 * CROB layout (qualifier 0x17, TRIP 0x81 / CLOSE 0x41) and the g60 integrity poll. tests/dnp3-tests.html checks this
 * file against frames made by dnp3.py. Everything past that is a superset dnp3.py doesn't have yet: analogs, counters,
 * BO status, time objects (g50/g51/g52), IIN writes (g80), link-layer service frames, multi-segment transport, and a
 * per-byte annotation map that drives the DNP3 Lab's packet inspector.
 *
 * Layers on the wire:
 *   data link  05 64 | LEN | CTRL | DEST(LE16) | SRC(LE16) | CRC(LE16)   then user data in 16-byte blocks, each + CRC
 *              CTRL = DIR(7) PRM(6) FCB(5) FCV(4) FC(3-0);  LEN counts CTRL+DEST+SRC (5) + user data, max 255
 *   transport  1 octet: FIN(7) FIR(6) SEQ(5-0); up to 249 octets of application data per segment
 *   app        AC = FIR(7) FIN(6) CON(5) UNS(4) SEQ(3-0) | FC | [IIN1 IIN2 in responses] | object headers + data
 * CRC: poly 0x3D65 (reflected 0xA6BC), init 0, final invert, sent little-endian. CRC of "123456789" = 0xEA82.
 * Time: DNP3 time is a 48-bit count of milliseconds since 1970-01-01 UTC, little-endian.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DNP3 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ CRC + bytes
  const CRC_T = (() => {
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xA6BC : c >>> 1; t[i] = c; }
    return t;
  })();
  function crc(b, s = 0, e = b.length) { let c = 0; for (let i = s; i < e; i++) c = (c >>> 8) ^ CRC_T[(c ^ b[i]) & 0xFF]; return (~c) & 0xFFFF; }
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = h => { h = String(h).replace(/[^0-9a-f]/gi, ''); const o = new Uint8Array(h.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const h2 = n => '0x' + (n & 0xFF).toString(16).padStart(2, '0');
  const h4 = n => '0x' + (n & 0xFFFF).toString(16).padStart(4, '0');

  // ------------------------------------------------------------------ tables
  const LINK_PRI = { 0: 'RESET LINK STATES', 2: 'TEST LINK STATES', 3: 'CONFIRMED USER DATA', 4: 'UNCONFIRMED USER DATA', 9: 'REQUEST LINK STATUS' };
  const LINK_SEC = { 0: 'ACK', 1: 'NACK', 11: 'LINK STATUS', 15: 'NOT SUPPORTED' };
  const FC = { CONFIRM: 0x00, READ: 0x01, WRITE: 0x02, SELECT: 0x03, OPERATE: 0x04, DIRECT_OPERATE: 0x05, DIRECT_OPERATE_NR: 0x06,
    COLD_RESTART: 0x0D, WARM_RESTART: 0x0E, ENABLE_UNSOLICITED: 0x14, DISABLE_UNSOLICITED: 0x15, DELAY_MEASURE: 0x17,
    RECORD_CURRENT_TIME: 0x18, RESPONSE: 0x81, UNSOLICITED_RESPONSE: 0x82 };
  const FC_NAMES = { 0x00: 'CONFIRM', 0x01: 'READ', 0x02: 'WRITE', 0x03: 'SELECT', 0x04: 'OPERATE', 0x05: 'DIRECT OPERATE',
    0x06: 'DIRECT OPERATE (no response)', 0x07: 'IMMEDIATE FREEZE', 0x0D: 'COLD RESTART', 0x0E: 'WARM RESTART',
    0x14: 'ENABLE UNSOLICITED', 0x15: 'DISABLE UNSOLICITED', 0x17: 'DELAY MEASURE', 0x18: 'RECORD CURRENT TIME',
    0x81: 'RESPONSE', 0x82: 'UNSOLICITED RESPONSE', 0x83: 'AUTHENTICATE RESPONSE' };
  const IIN1 = ['BROADCAST', 'CLASS 1 EVENTS', 'CLASS 2 EVENTS', 'CLASS 3 EVENTS', 'NEED TIME', 'LOCAL CONTROL', 'DEVICE TROUBLE', 'DEVICE RESTART'];
  const IIN2 = ['NO FUNC CODE SUPPORT', 'OBJECT UNKNOWN', 'PARAMETER ERROR', 'EVENT BUFFER OVERFLOW', 'ALREADY EXECUTING', 'CONFIG CORRUPT', 'RESERVED 2.6', 'RESERVED 2.7'];
  const IIN = { BROADCAST: 0, CLASS1: 1, CLASS2: 2, CLASS3: 3, NEED_TIME: 4, LOCAL_CONTROL: 5, DEVICE_TROUBLE: 6, DEVICE_RESTART: 7,
    NO_FUNC: 8, OBJECT_UNKNOWN: 9, PARAM_ERROR: 10, EVENT_OVERFLOW: 11, ALREADY_EXECUTING: 12, CONFIG_CORRUPT: 13 };
  // CROB control code = trip/close (bits 7-6: 01 CLOSE, 10 TRIP) | clear (5) | queue (4) | op type (3-0)
  const CROB = { NUL: 0x00, PULSE_ON: 0x01, PULSE_OFF: 0x02, LATCH_ON: 0x03, LATCH_OFF: 0x04, TRIP: 0x81, CLOSE: 0x41 };
  const CROB_NAMES = { 0x00: 'NUL', 0x01: 'PULSE ON', 0x02: 'PULSE OFF', 0x03: 'LATCH ON', 0x04: 'LATCH OFF', 0x81: 'TRIP (pulse)', 0x41: 'CLOSE (pulse)' };
  const CROB_STATUS = ['SUCCESS', 'TIMEOUT', 'NO SELECT', 'FORMAT ERROR', 'NOT SUPPORTED', 'ALREADY ACTIVE', 'HARDWARE ERROR', 'LOCAL',
    'TOO MANY OBJS', 'NOT AUTHORIZED', 'AUTOMATION INHIBIT', 'PROCESSING LIMITED', 'OUT OF RANGE', 'DOWNSTREAM LOCAL',
    'ALREADY COMPLETE', 'BLOCKED', 'CANCELLED', 'BLOCKED OTHER MASTER', 'DOWNSTREAM FAIL'];
  const BI_FLAGS = ['ONLINE', 'RESTART', 'COMM LOST', 'REMOTE FORCED', 'LOCAL FORCED', 'CHATTER FILTER', 'RESERVED', 'STATE'];
  const AI_FLAGS = ['ONLINE', 'RESTART', 'COMM LOST', 'REMOTE FORCED', 'LOCAL FORCED', 'OVER RANGE', 'REFERENCE ERR', 'RESERVED'];
  const QUAL = { 0x00: '8-bit start/stop', 0x01: '16-bit start/stop', 0x06: 'all objects', 0x07: '8-bit count', 0x08: '16-bit count',
    0x17: '8-bit count, 8-bit index prefix', 0x28: '16-bit count, 16-bit index prefix' };

  // Object library. d = data bytes per point (0 = packed bits); t = how the object carries time:
  //   'none' (instantaneous value, no timestamp), 'abs' (48-bit absolute UTC ms), 'rel' (16-bit ms after a g51 CTO),
  //   'is' (the object IS a time / delay value); kind drives which flag names apply and how the value reads.
  const OBJ = {};
  const def = (g, v, name, d, t, kind, cls) => { OBJ[g + '.' + v] = { g, v, name, d, t, kind, cls }; };
  def(1, 0, 'Binary Input - any variation', -1, 'none', 'req', 'static');
  def(1, 1, 'Binary Input - packed format', 0, 'none', 'bi', 'static');
  def(1, 2, 'Binary Input - with flags', 1, 'none', 'bi', 'static');
  def(2, 0, 'Binary Input Event - any variation', -1, 'none', 'req', 'event');
  def(2, 1, 'Binary Input Event - without time', 1, 'none', 'bi', 'event');
  def(2, 2, 'Binary Input Event - with absolute time', 7, 'abs', 'bi', 'event');
  def(2, 3, 'Binary Input Event - with relative time', 3, 'rel', 'bi', 'event');
  def(10, 0, 'Binary Output - any variation', -1, 'none', 'req', 'static');
  def(10, 2, 'Binary Output Status - with flags', 1, 'none', 'bi', 'static');
  def(12, 1, 'Control Relay Output Block (CROB)', 11, 'none', 'crob', 'command');
  def(20, 0, 'Counter - any variation', -1, 'none', 'req', 'static');
  def(20, 1, 'Counter - 32-bit with flag', 5, 'none', 'ctr32', 'static');
  def(22, 0, 'Counter Event - any variation', -1, 'none', 'req', 'event');
  def(22, 1, 'Counter Event - 32-bit with flag', 5, 'none', 'ctr32', 'event');
  def(22, 5, 'Counter Event - 32-bit with flag and time', 11, 'abs', 'ctr32', 'event');
  def(30, 0, 'Analog Input - any variation', -1, 'none', 'req', 'static');
  def(30, 1, 'Analog Input - 32-bit with flag', 5, 'none', 'ai32', 'static');
  def(30, 2, 'Analog Input - 16-bit with flag', 3, 'none', 'ai16', 'static');
  def(30, 3, 'Analog Input - 32-bit without flag', 4, 'none', 'ai32nf', 'static');
  def(30, 4, 'Analog Input - 16-bit without flag', 2, 'none', 'ai16nf', 'static');
  def(30, 5, 'Analog Input - single-precision float with flag', 5, 'none', 'aif', 'static');
  def(40, 0, 'Analog Output Status - any variation', -1, 'none', 'req', 'static');
  def(40, 1, 'Analog Output Status - 32-bit with flag', 5, 'none', 'ai32', 'static');
  def(40, 2, 'Analog Output Status - 16-bit with flag', 3, 'none', 'ai16', 'static');
  def(41, 1, 'Analog Output Block - 32-bit', 5, 'none', 'ao32', 'command');
  def(41, 2, 'Analog Output Block - 16-bit', 3, 'none', 'ao16', 'command');
  def(32, 0, 'Analog Input Event - any variation', -1, 'none', 'req', 'event');
  def(32, 1, 'Analog Input Event - 32-bit without time', 5, 'none', 'ai32', 'event');
  def(32, 2, 'Analog Input Event - 16-bit without time', 3, 'none', 'ai16', 'event');
  def(32, 3, 'Analog Input Event - 32-bit with time', 11, 'abs', 'ai32', 'event');
  def(32, 4, 'Analog Input Event - 16-bit with time', 9, 'abs', 'ai16', 'event');
  def(32, 5, 'Analog Input Event - float without time', 5, 'none', 'aif', 'event');
  def(32, 7, 'Analog Input Event - float with time', 11, 'abs', 'aif', 'event');
  def(50, 1, 'Time and Date - absolute time', 6, 'is', 'time', 'time');
  def(50, 3, 'Time and Date - last recorded time', 6, 'is', 'time', 'time');
  def(51, 1, 'Common Time of Occurrence - synchronised', 6, 'is', 'time', 'time');
  def(51, 2, 'Common Time of Occurrence - unsynchronised', 6, 'is', 'time', 'time');
  def(52, 1, 'Time Delay - coarse (seconds)', 2, 'is', 'delay', 'time');
  def(52, 2, 'Time Delay - fine (milliseconds)', 2, 'is', 'delay', 'time');
  def(60, 1, 'Class 0 data (all static)', -1, 'none', 'class', 'class');
  def(60, 2, 'Class 1 data (events)', -1, 'none', 'class', 'class');
  def(60, 3, 'Class 2 data (events)', -1, 'none', 'class', 'class');
  def(60, 4, 'Class 3 data (events)', -1, 'none', 'class', 'class');
  def(80, 1, 'Internal Indications (IIN) - packed', 0, 'none', 'iin', 'iin');
  const objName = (g, v) => (OBJ[g + '.' + v] || {}).name || `Group ${g} Var ${v} (not in Kelly's library)`;

  // ------------------------------------------------------------------ byte writer
  class W {
    constructor() { this.a = []; }
    u8(x) { this.a.push(x & 0xFF); return this; }
    u16(x) { this.a.push(x & 0xFF, (x >>> 8) & 0xFF); return this; }
    u32(x) { x >>>= 0; this.a.push(x & 0xFF, (x >>> 8) & 0xFF, (x >>> 16) & 0xFF, (x >>> 24) & 0xFF); return this; }
    i16(x) { return this.u16(Math.max(-32768, Math.min(32767, Math.round(x))) & 0xFFFF); }
    i32(x) { return this.u32(Math.max(-2147483648, Math.min(2147483647, Math.round(x))) | 0); }
    f32(x) { const b = new Uint8Array(new Float32Array([x]).buffer); this.a.push(...b); return this; }
    u48(ms) { ms = Math.max(0, Math.floor(ms)); const lo = ms % 4294967296, hi = Math.floor(ms / 4294967296); this.u32(lo); this.u16(hi); return this; }
    bytes(b) { for (const x of b) this.a.push(x & 0xFF); return this; }
    get length() { return this.a.length; }
    out() { return Uint8Array.from(this.a); }
  }
  const rd = {
    u16: (b, i) => b[i] | (b[i + 1] << 8),
    i16: (b, i) => { const v = b[i] | (b[i + 1] << 8); return v & 0x8000 ? v - 0x10000 : v; },
    u32: (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0,
    i32: (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24),
    f32: (b, i) => new DataView(Uint8Array.from(b.slice(i, i + 4)).buffer).getFloat32(0, true),
    u48: (b, i) => rd.u32(b, i) + rd.u16(b, i + 4) * 4294967296,
  };

  // ------------------------------------------------------------------ data link
  function frameLength(p) {   // = dnp3.py frame_length: total wire length from 05 64 LEN, or null
    if (!p || p.length < 3 || p[0] !== 0x05 || p[1] !== 0x64) return null;
    const user = Math.max(0, p[2] - 5);
    return 10 + user + 2 * Math.ceil(user / 16);
  }
  // One link frame. o: { dest, src, fn (default 4 unconfirmed user data / 0 ACK etc), dir (true = from master), prm, fcb, fcv, user }
  function buildLink(o) {
    const user = o.user || new Uint8Array(0);
    if (user.length > 250) throw new Error('link user data > 250 octets');
    const prm = o.prm !== false;
    const ctrl = (o.dir !== false ? 0x80 : 0) | (prm ? 0x40 : 0) | (o.fcb ? 0x20 : 0) | (o.fcv || o.dfc ? 0x10 : 0) | ((o.fn == null ? 4 : o.fn) & 0x0F);
    const w = new W().u8(0x05).u8(0x64).u8(5 + user.length).u8(ctrl).u16(o.dest).u16(o.src);
    w.u16(crc(w.a, 0, 8));
    for (let i = 0; i < user.length; i += 16) { const ch = user.subarray(i, i + 16); w.bytes(ch).u16(crc(ch)); }
    return w.out();
  }
  // = dnp3.py build_frame: master -> outstation, one transport segment (FIR+FIN), unconfirmed user data unless confirmed
  function buildFrame(dest, src, app, o = {}) {
    const user = new Uint8Array(app.length + 1); user[0] = 0xC0 | ((o.trSeq || 0) & 0x3F); user.set(app, 1);
    return buildLink({ dest, src, fn: o.confirmed ? 3 : 4, dir: o.dir !== false, user });
  }
  // Split an application fragment into transport segments, each a link frame. Returns [Uint8Array...].
  function buildFrames(dest, src, app, o = {}) {
    const out = []; let seq = (o.trSeq || 0) & 0x3F;
    for (let i = 0; i < app.length || i === 0; i += 249) {
      const part = app.subarray(i, i + 249), fir = i === 0, fin = i + 249 >= app.length;
      const user = new Uint8Array(part.length + 1); user[0] = (fin ? 0x80 : 0) | (fir ? 0x40 : 0) | seq; user.set(part, 1);
      out.push(buildLink({ dest, src, fn: o.confirmed ? 3 : 4, dir: o.dir !== false, user }));
      seq = (seq + 1) & 0x3F;
      if (!app.length) break;
    }
    return out;
  }
  // Parse one link frame. Returns { ok, error, ctrl..., user, userWire (wire offset of each user byte), blocks }
  function parseLink(b) {
    const r = { ok: false, len: b.length };
    if (b.length < 10 || b[0] !== 0x05 || b[1] !== 0x64) { r.error = 'bad start octets (want 05 64)'; return r; }
    r.lenField = b[2]; r.ctrl = b[3]; r.dest = rd.u16(b, 4); r.src = rd.u16(b, 6);
    r.dir = !!(b[3] & 0x80); r.prm = !!(b[3] & 0x40); r.fcb = !!(b[3] & 0x20); r.fcv = !!(b[3] & 0x10); r.fn = b[3] & 0x0F;
    r.fnName = (r.prm ? LINK_PRI : LINK_SEC)[r.fn] || `function ${r.fn}`;
    r.hcrc = rd.u16(b, 8); r.hcrcOk = crc(b, 0, 8) === r.hcrc;
    if (!r.hcrcOk) { r.error = 'header CRC error'; return r; }
    if (r.lenField < 5) { r.error = 'length field < 5'; return r; }
    const want = frameLength(b);
    if (b.length < want) { r.error = `short frame (${b.length} of ${want} octets)`; return r; }
    const userLen = r.lenField - 5, user = new Uint8Array(userLen), userWire = new Array(userLen);
    r.blocks = [];
    let w = 10, u = 0;
    while (u < userLen) {
      const n = Math.min(16, userLen - u);
      for (let j = 0; j < n; j++) { user[u + j] = b[w + j]; userWire[u + j] = w + j; }
      const got = rd.u16(b, w + n), ok = crc(b, w, w + n) === got;
      r.blocks.push({ at: w, n, crcAt: w + n, ok });
      if (!ok) r.blockError = true;
      w += n + 2; u += n;
    }
    r.user = user; r.userWire = userWire; r.wireLen = w;
    if (r.blockError) { r.error = 'user-data block CRC error'; return r; }
    r.ok = true;
    return r;
  }
  // Transport reassembly: feed() user-data octets of each frame, get a whole fragment back on FIN.
  class Reassembler {
    constructor() { this.buf = null; this.seq = -1; }
    feed(user) {
      if (!user || !user.length) return null;
      const th = user[0], fir = !!(th & 0x40), fin = !!(th & 0x80), seq = th & 0x3F, body = user.subarray(1);
      if (fir) { this.buf = Array.from(body); this.seq = seq; }
      else if (!this.buf || seq !== ((this.seq + 1) & 0x3F)) { this.buf = null; return null; }   // lost a segment: drop
      else { this.buf.push(...body); this.seq = seq; }
      if (fin) { const out = Uint8Array.from(this.buf); this.buf = null; return out; }
      return null;
    }
  }
  // Byte-stream framer (TCP / serial / transparent P25): validates the header CRC before trusting LEN, resyncs on junk.
  class Framer {
    constructor(onFrame) { this.b = []; this.onFrame = onFrame; }
    push(bytes) {
      for (const x of bytes) this.b.push(x);
      for (;;) {
        let i = 0; while (i + 1 < this.b.length && !(this.b[i] === 0x05 && this.b[i + 1] === 0x64)) i++;
        if (i) this.b.splice(0, i);
        if (this.b.length < 10) return;
        if (crc(this.b, 0, 8) !== rd.u16(this.b, 8)) { this.b.splice(0, 1); continue; }
        const n = frameLength(this.b);
        if (this.b.length < n) return;
        this.onFrame(Uint8Array.from(this.b.splice(0, n)));
      }
    }
  }

  // ------------------------------------------------------------------ application layer: building
  const ac = (o = {}) => (o.fir !== false ? 0x80 : 0) | (o.fin !== false ? 0x40 : 0) | (o.con ? 0x20 : 0) | (o.uns ? 0x10 : 0) | ((o.seq || 0) & 0x0F);
  // = dnp3.py app_request
  function appRequest(fc, objects, o = {}) { const w = new W().u8(ac(o)).u8(fc); if (objects) w.bytes(objects); return w.out(); }
  function appResponse(fc, iin, objects, o = {}) {
    const w = new W().u8(ac(o)).u8(fc).u8(iin & 0xFF).u8((iin >>> 8) & 0xFF);
    if (objects) w.bytes(objects);
    return w.out();
  }
  const cat = (...parts) => { const w = new W(); parts.forEach(p => p && w.bytes(p)); return w.out(); };
  // Requests
  const readClass = (cls = [0, 1, 2, 3]) => { const w = new W(); for (const c of cls) w.u8(60).u8(c === 0 ? 1 : c + 1).u8(0x06); return w.out(); };
  const readIntegrity = () => Uint8Array.from([60, 2, 0x06, 60, 3, 0x06, 60, 4, 0x06, 60, 1, 0x06]);   // = dnp3.py read_class_0123 (events first)
  const readGroup = (g, v = 0) => Uint8Array.from([g, v, 0x06]);
  // = dnp3.py crob (8-bit index, qualifier 0x17); a 16-bit index uses 0x28
  function crob(index, code, o = {}) {
    const w = new W().u8(12).u8(1);
    if (index < 256) w.u8(0x17).u8(1).u8(index); else w.u8(0x28).u16(1).u16(index);
    return w.u8(code).u8(o.count == null ? 1 : o.count).u32(o.onMs == null ? 100 : o.onMs).u32(o.offMs == null ? 100 : o.offMs).u8(o.status || 0).out();
  }
  // g41 analog output block (a setpoint): the value then a status octet (0 in a request, the outcome in the echo)
  function aoBlock(index, value, v = 2, status = 0) {
    const w = new W().u8(41).u8(v);
    if (index < 256) w.u8(0x17).u8(1).u8(index); else w.u8(0x28).u16(1).u16(index);
    if (v === 1) w.i32(value); else w.i16(value);
    return w.u8(status).out();
  }
  const timeWrite = ms => new W().u8(50).u8(1).u8(0x07).u8(1).u48(ms).out();            // WRITE g50v1 (absolute time)
  const lastRecordedTimeWrite = ms => new W().u8(50).u8(3).u8(0x07).u8(1).u48(ms).out(); // WRITE g50v3 (LAN procedure)
  const iinClear = (bit = 7) => new W().u8(80).u8(1).u8(0x00).u8(bit).u8(bit).u8(0x00).out();   // WRITE g80v1 idx 7 = 0
  const delayFine = ms => new W().u8(52).u8(2).u8(0x07).u8(1).u16(ms).out();             // g52v2 in a DELAY MEASURE reply

  // Response objects (outstation side)
  function range(w, start, stop) { if (stop < 256) w.u8(0x00).u8(start).u8(stop); else w.u8(0x01).u16(start).u16(stop); }
  function idxList(w, n, maxIdx) { if (maxIdx < 256 && n < 256) { w.u8(0x17).u8(n); return 1; } w.u8(0x28).u16(n); return 2; }
  const putIdx = (w, sz, i) => (sz === 1 ? w.u8(i) : w.u16(i));
  // Static points must be a contiguous index run start..stop: pts = [{ value, flags }] in index order from `start`
  function binaryStatic(pts, v = 2, start = 0) {
    if (!pts.length) return new Uint8Array(0);
    const w = new W().u8(1).u8(v); range(w, start, start + pts.length - 1);
    if (v === 1) { for (let i = 0; i < pts.length; i += 8) { let by = 0; for (let j = 0; j < 8 && i + j < pts.length; j++) if (pts[i + j].value) by |= 1 << j; w.u8(by); } }
    else pts.forEach(p => w.u8((p.flags == null ? 0x01 : p.flags) | (p.value ? 0x80 : 0)));
    return w.out();
  }
  function boStatus(pts, start = 0) {
    if (!pts.length) return new Uint8Array(0);
    const w = new W().u8(10).u8(2); range(w, start, start + pts.length - 1);
    pts.forEach(p => w.u8((p.flags == null ? 0x01 : p.flags) | (p.value ? 0x80 : 0)));
    return w.out();
  }
  function aiValue(w, kind, p) {
    const fl = p.flags == null ? 0x01 : p.flags;
    if (kind === 'ai32') w.u8(fl).i32(p.value);
    else if (kind === 'ai16') w.u8(fl).i16(p.value);
    else if (kind === 'ai32nf') w.i32(p.value);
    else if (kind === 'ai16nf') w.i16(p.value);
    else if (kind === 'aif') w.u8(fl).f32(p.value);
    else if (kind === 'ctr32') w.u8(fl).u32(p.value);
  }
  function analogStatic(pts, v = 1, start = 0, g = 30) {
    if (!pts.length) return new Uint8Array(0);
    const d = OBJ[g + '.' + v], w = new W().u8(g).u8(v); range(w, start, start + pts.length - 1);
    pts.forEach(p => aiValue(w, d.kind, p));
    return w.out();
  }
  const counterStatic = (pts, start = 0) => analogStatic(pts, 1, start, 20);
  // Events: evs = [{ index, value, flags, time }] -- one header, index-prefixed
  function events(g, v, evs) {
    if (!evs.length) return new Uint8Array(0);
    const d = OBJ[g + '.' + v]; if (!d) throw new Error(`no object g${g}v${v}`);
    const w = new W().u8(g).u8(v), sz = idxList(w, evs.length, Math.max(...evs.map(e => e.index)));
    for (const e of evs) {
      putIdx(w, sz, e.index);
      if (d.kind === 'bi') w.u8((e.flags == null ? 0x01 : e.flags) | (e.value ? 0x80 : 0));
      else aiValue(w, d.kind, e);
      if (d.t === 'abs') w.u48(e.time || 0);
      if (d.t === 'rel') w.u16(e.rel || 0);
    }
    return w.out();
  }
  const aoStatus = (pts, v = 2, start = 0) => analogStatic(pts, v, start, 40);
  const aoEcho = (objs, v = 2) => cat(...objs.map(o => aoBlock(o.index, o.value, v, o.status || 0)));   // SELECT/OPERATE echo of g41
  function crobEcho(objs) {   // SELECT/OPERATE replies echo the request's CROBs with their status
    const w = new W();
    for (const c of objs) {
      w.u8(12).u8(1); const sz = idxList(w, 1, c.index); putIdx(w, sz, c.index);
      w.u8(c.code).u8(c.count).u32(c.onMs).u32(c.offMs).u8(c.status || 0);
    }
    return w.out();
  }

  // ------------------------------------------------------------------ application layer: parsing (+ annotations)
  // Returns { ok, error, ac, fc, fcName, iin, iinSet:[names], objects:[...], ann:[{s, n, tag, label, value, note}] }
  // ann offsets are relative to the start of the fragment (the AC octet). A truncated fragment parses as far as it goes.
  function parseApp(b, opt = {}) {
    const r = { ok: true, objects: [], ann: [] };
    const A = (s, n, tag, label, value, note) => { r.ann.push({ s, n, tag, label, value: value == null ? '' : String(value), note: note || '' }); };
    if (b.length < 2) { r.ok = false; r.error = 'fragment shorter than AC + FC'; return r; }
    const a = b[0];
    r.ac = { fir: !!(a & 0x80), fin: !!(a & 0x40), con: !!(a & 0x20), uns: !!(a & 0x10), seq: a & 0x0F };
    A(0, 1, 'ac', 'Application Control', h2(a), `FIR=${+r.ac.fir} FIN=${+r.ac.fin} CON=${+r.ac.con} UNS=${+r.ac.uns} SEQ=${r.ac.seq}`);
    r.fc = b[1]; r.fcName = FC_NAMES[r.fc] || `function ${h2(r.fc)}`;
    A(1, 1, 'fc', 'Function Code', h2(r.fc), r.fcName);
    let i = 2;
    const resp = r.fc >= 0x81;
    if (resp) {
      if (b.length < 4) { r.ok = false; r.error = 'response without IIN'; return r; }
      r.iin = b[2] | (b[3] << 8);
      r.iinSet = [];
      for (let k = 0; k < 8; k++) { if (b[2] & (1 << k)) r.iinSet.push('IIN1.' + k + ' ' + IIN1[k]); if (b[3] & (1 << k)) r.iinSet.push('IIN2.' + k + ' ' + IIN2[k]); }
      A(2, 1, 'iin', 'IIN1', h2(b[2]), IIN1.filter((_, k) => b[2] & (1 << k)).join(', ') || 'none set');
      A(3, 1, 'iin', 'IIN2', h2(b[3]), IIN2.filter((_, k) => b[3] & (1 << k)).join(', ') || 'none set');
      i = 4;
    }
    let cto = null;
    while (i < b.length) {
      if (i + 3 > b.length) { A(i, b.length - i, 'err', 'Truncated object header', '', ''); r.ok = false; r.error = 'truncated object header'; break; }
      const g = b[i], v = b[i + 1], q = b[i + 2], d = OBJ[g + '.' + v];
      const o = { g, v, q, name: objName(g, v), time: d ? d.t : 'none', cls: d ? d.cls : '', points: [] };
      r.objects.push(o);
      A(i, 1, 'ohdr', 'Object Group', g, objName(g, v).split(' - ')[0]);
      A(i + 1, 1, 'ohdr', 'Variation', v, d ? d.name.split(' - ').slice(1).join(' - ') || d.name : 'unknown');
      A(i + 2, 1, 'qual', 'Qualifier', h2(q), QUAL[q] || 'not decoded');
      i += 3;
      let start = 0, count = 0, ixSize = 0;
      if (q === 0x06) { o.all = true; continue; }
      if (q === 0x00 || q === 0x01) {
        const w = q === 0x00 ? 1 : 2; if (i + 2 * w > b.length) { r.ok = false; r.error = 'truncated range'; break; }
        start = w === 1 ? b[i] : rd.u16(b, i); const stop = w === 1 ? b[i + w] : rd.u16(b, i + w);
        A(i, w, 'qual', 'Range start', start); A(i + w, w, 'qual', 'Range stop', stop);
        i += 2 * w; count = Math.max(0, stop - start + 1); o.start = start; o.stop = stop;
      } else if (q === 0x07 || q === 0x08 || q === 0x17 || q === 0x28) {
        const w = q === 0x07 || q === 0x17 ? 1 : 2; if (i + w > b.length) { r.ok = false; r.error = 'truncated count'; break; }
        count = w === 1 ? b[i] : rd.u16(b, i); A(i, w, 'qual', 'Count', count); i += w;
        if (q === 0x17) ixSize = 1; if (q === 0x28) ixSize = 2;
      } else { A(i, b.length - i, 'err', 'Qualifier not decoded', h2(q), 'Kelly stops decoding here'); r.ok = false; r.error = 'qualifier ' + h2(q) + ' not decoded'; break; }
      o.count = count;
      if (r.fc === FC.READ || (d && d.d < 0)) continue;   // a READ names points (range/count) but carries no values
      if (!d) { A(i, b.length - i, 'err', 'Object not in library', '', 'cannot size its data'); r.ok = false; r.error = `g${g}v${v} not decoded`; break; }
      if (d.d === 0) {   // packed bits, range qualifier
        const nb = Math.ceil(count / 8); if (i + nb > b.length) { r.ok = false; r.error = 'truncated packed data'; break; }
        for (let n = 0; n < count; n++) {
          const val = (b[i + (n >> 3)] >> (n & 7)) & 1;
          o.points.push({ index: start + n, value: val, name: d.kind === 'iin' ? iinName(start + n) : '' });
        }
        for (let n = 0; n < nb; n++) A(i + n, 1, 'val', 'Packed bits', h2(b[i + n]), `points ${start + n * 8}..${Math.min(start + count - 1, start + n * 8 + 7)}`);
        i += nb; continue;
      }
      for (let n = 0; n < count; n++) {
        let index = start + n;
        if (ixSize) { if (i + ixSize > b.length) { r.ok = false; r.error = 'truncated index'; break; } index = ixSize === 1 ? b[i] : rd.u16(b, i); A(i, ixSize, 'idx', 'Point index', index); i += ixSize; }
        if (i + d.d > b.length) { A(i, b.length - i, 'err', 'Truncated object', '', ''); r.ok = false; r.error = 'truncated object data'; i = b.length; break; }
        const p = { index };
        decodePoint(b, i, d, p, A, cto);
        if (d.g === 51) cto = p.time;
        o.points.push(p);
        i += d.d;
      }
    }
    return r;
  }
  const iinName = n => (n < 8 ? 'IIN1.' + n + ' ' + IIN1[n] : 'IIN2.' + (n - 8) + ' ' + IIN2[n - 8]);
  const flagStr = (f, names) => names.filter((_, k) => f & (1 << k) && k !== 7).join(', ') || 'none';
  const tstr = ms => { try { return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC'); } catch { return String(ms); } };
  function decodePoint(b, i, d, p, A, cto) {
    const k = d.kind;
    if (k === 'bi') {
      const f = b[i]; p.flags = f; p.value = f & 0x80 ? 1 : 0;
      A(i, 1, 'flags', 'Flags + state', h2(f), `STATE=${p.value}; ${flagStr(f, BI_FLAGS)}`);
      if (d.t === 'abs') { p.time = rd.u48(b, i + 1); A(i + 1, 6, 'time', 'Timestamp (48-bit ms)', p.time, tstr(p.time)); }
      if (d.t === 'rel') { p.rel = rd.u16(b, i + 1); p.time = cto != null ? cto + p.rel : null; A(i + 1, 2, 'time', 'Relative time (ms after CTO)', p.rel, cto != null ? tstr(p.time) : 'no CTO before it'); }
      return;
    }
    if (k === 'crob') {
      p.code = b[i]; p.count = b[i + 1]; p.onMs = rd.u32(b, i + 2); p.offMs = rd.u32(b, i + 6); p.status = b[i + 10];
      A(i, 1, 'crob', 'Control code', h2(p.code), CROB_NAMES[p.code] || ctrlCodeName(p.code));
      A(i + 1, 1, 'crob', 'Count', p.count); A(i + 2, 4, 'crob', 'On time (ms)', p.onMs); A(i + 6, 4, 'crob', 'Off time (ms)', p.offMs);
      A(i + 10, 1, 'crob', 'Status', p.status, CROB_STATUS[p.status] || 'unknown');
      return;
    }
    if (k === 'ao32' || k === 'ao16') {
      const n = k === 'ao32' ? 4 : 2; p.value = n === 4 ? rd.i32(b, i) : rd.i16(b, i); p.status = b[i + n];
      A(i, n, 'val', `Setpoint (int${n * 8})`, p.value); A(i + n, 1, 'crob', 'Status', p.status, CROB_STATUS[p.status] || 'unknown');
      return;
    }
    if (k === 'time') { p.time = rd.u48(b, i); A(i, 6, 'time', 'Time (48-bit ms since 1970 UTC)', p.time, tstr(p.time)); return; }
    if (k === 'delay') { p.value = rd.u16(b, i); A(i, 2, 'time', d.v === 1 ? 'Delay (s)' : 'Delay (ms)', p.value, 'outstation turnaround'); return; }
    let j = i;
    if (k !== 'ai32nf' && k !== 'ai16nf') { p.flags = b[j]; A(j, 1, 'flags', 'Flags', h2(b[j]), flagStr(b[j], AI_FLAGS)); j++; }
    if (k === 'ai32' || k === 'ai32nf') { p.value = rd.i32(b, j); A(j, 4, 'val', 'Value (int32)', p.value); j += 4; }
    else if (k === 'ai16' || k === 'ai16nf') { p.value = rd.i16(b, j); A(j, 2, 'val', 'Value (int16)', p.value); j += 2; }
    else if (k === 'aif') { p.value = rd.f32(b, j); A(j, 4, 'val', 'Value (float32)', +p.value.toPrecision(6)); j += 4; }
    else if (k === 'ctr32') { p.value = rd.u32(b, j); A(j, 4, 'val', 'Count (uint32)', p.value); j += 4; }
    if (d.t === 'abs') { p.time = rd.u48(b, j); A(j, 6, 'time', 'Timestamp (48-bit ms)', p.time, tstr(p.time)); }
  }
  function ctrlCodeName(c) {
    const tc = (c >> 6) & 3, op = c & 0x0F;
    return `${['', 'CLOSE ', 'TRIP ', '?? '][tc]}${CROB_NAMES[op] || 'op ' + op}${c & 0x20 ? ' CLEAR' : ''}${c & 0x10 ? ' QUEUE' : ''}`;
  }

  // ------------------------------------------------------------------ whole-frame decode for the inspector
  // Returns { ok, error, link, transport, app, fields:[{tag, layer, label, value, note}], byteField:[fieldIndex per wire byte], summary }
  function inspect(b) {
    if (typeof b === 'string') b = unhex(b);
    const fields = [], byteField = new Array(b.length).fill(-1);
    const F = (wires, tag, layer, label, value, note) => { const id = fields.length; fields.push({ tag, layer, label, value: value == null ? '' : String(value), note: note || '' }); wires.forEach(w => { if (w < b.length) byteField[w] = id; }); return id; };
    const seq = (s, n) => Array.from({ length: n }, (_, k) => s + k);
    const L = parseLink(b);
    const out = { ok: false, link: L, fields, byteField, bytes: b };
    if (b.length >= 2) F([0, 1], 'start', 'link', 'Start octets', '05 64', b[0] === 5 && b[1] === 0x64 ? 'every DNP3 frame begins 0x0564' : 'WRONG -- not a DNP3 frame');
    if (b.length >= 3) F([2], 'len', 'link', 'Length', b[2], `CTRL+DEST+SRC (5) + ${Math.max(0, b[2] - 5)} user octets; CRCs not counted`);
    if (b.length >= 4) F([3], 'ctrl', 'link', 'Link Control', h2(b[3]), `DIR=${b[3] >> 7 & 1} (${b[3] & 0x80 ? 'from master' : 'from outstation'}) PRM=${b[3] >> 6 & 1} ${b[3] & 0x40 ? 'FCB=' + (b[3] >> 5 & 1) + ' FCV=' : 'DFC='}${b[3] >> 4 & 1} FC=${b[3] & 15} ${L.fnName || ''}`);
    if (b.length >= 6) F([4, 5], 'addr', 'link', 'Destination', rd.u16(b, 4), 'little-endian');
    if (b.length >= 8) F([6, 7], 'addr', 'link', 'Source', rd.u16(b, 6), 'little-endian');
    if (b.length >= 10) F([8, 9], L.hcrcOk ? 'crc' : 'crcbad', 'link', 'Header CRC', h4(rd.u16(b, 8)), L.hcrcOk ? 'OK' : `BAD -- want ${h4(crc(b, 0, 8))}`);
    (L.blocks || []).forEach((bl, k) => F([bl.crcAt, bl.crcAt + 1], bl.ok ? 'crc' : 'crcbad', 'link', `Block ${k + 1} CRC`, h4(rd.u16(b, bl.crcAt)), bl.ok ? `OK (covers ${bl.n} octets)` : `BAD -- want ${h4(crc(b, bl.at, bl.at + bl.n))}`));
    if (!L.ok) { out.error = L.error; out.summary = 'Link error: ' + L.error; return out; }
    if (!L.user.length) { out.ok = true; out.summary = `${L.src} -> ${L.dest} link ${L.fnName}`; return out; }
    const th = L.user[0];
    out.transport = { fin: !!(th & 0x80), fir: !!(th & 0x40), seq: th & 0x3F };
    F([L.userWire[0]], 'th', 'transport', 'Transport header', h2(th), `FIN=${+out.transport.fin} FIR=${+out.transport.fir} SEQ=${out.transport.seq}`);
    if (!out.transport.fir) { seq(1, L.user.length - 1).forEach(u => F([L.userWire[u]], 'cont', 'app', 'Continuation segment', '', 'reassemble with the segments before it')); out.ok = true; out.summary = `${L.src} -> ${L.dest} transport continuation (seq ${out.transport.seq})`; return out; }
    const app = parseApp(L.user.subarray(1));
    out.app = app;
    for (const a of app.ann) F(seq(a.s + 1, a.n).map(u => L.userWire[u]), a.tag, 'app', a.label, a.value, a.note);
    out.ok = app.ok; out.error = app.error;
    out.summary = summary(L, app, out.transport);
    return out;
  }
  function summary(L, app, tr) {
    const objs = app.objects.map(o => {
      if (o.all) return `g${o.g}v${o.v} all`;
      if (o.g === 12) return o.points.map(p => `CROB[${p.index}] ${CROB_NAMES[p.code] || h2(p.code)}${app.fc >= 0x81 ? ' ' + (CROB_STATUS[p.status] || p.status) : ''}`).join(' ');
      if (o.g === 41) return o.points.map(p => `AO[${p.index}] = ${p.value}${app.fc >= 0x81 ? ' ' + (CROB_STATUS[p.status] || p.status) : ''}`).join(' ');
      if (o.g === 50 || o.g === 51) return `g${o.g}v${o.v} ${o.points[0] ? tstr(o.points[0].time) : ''}`;
      if (o.g === 52) return `delay ${o.points[0] ? o.points[0].value : '?'} ${o.v === 2 ? 'ms' : 's'}`;
      return `g${o.g}v${o.v}x${o.points.length}`;
    }).join(', ');
    const iin = app.iinSet && app.iinSet.length ? ' [' + app.iinSet.map(s => s.split(' ').slice(1).join(' ')).join(', ') + ']' : '';
    return `${L.src} -> ${L.dest} ${app.fcName}${app.ac.uns ? ' (UNS)' : ''}${app.ac.con ? ' CON' : ''} seq ${app.ac.seq}${objs ? ': ' + objs : ''}${iin}${tr && !tr.fin ? ' (first of several segments)' : ''}`;
  }

  // dnp3.py decode() compatible view (for the golden tests and anyone porting dashboard code)
  function decodePy(b) {
    const L = parseLink(b);
    if (!L.ok) return { ok: false, error: L.error };
    if (L.user.length < 2) return { ok: true, datalink: { dest: L.dest, src: L.src, function: L.fn } };
    const app = parseApp(L.user.subarray(1));
    return { ok: app.ok, datalink: { dir: L.dir, prm: L.prm, function: L.fn, dest: L.dest, src: L.src },
      transport: { fir: !!(L.user[0] & 0x40), fin: !!(L.user[0] & 0x80), seq: L.user[0] & 0x3F },
      application: { ...app.ac, function: app.fc, function_name: app.fcName, iin: app.iin == null ? undefined : '0x' + hex([app.iin & 0xFF, app.iin >> 8]) },
      objects: app.objects };
  }

  // Air-time estimate for the P25 bearer (TP9400 transparent measurements, NOTES/memory 2026-10-05): ~0.56 s radio
  // turnaround + key-up, then ~2.7 kbit/s of payload; frames over 28 B get split by the radio's serial packetiser.
  const airSeconds = n => 0.56 + (n * 8) / 2700;

  return { crc, hex, unhex, h2, h4, W, rd, frameLength, buildLink, buildFrame, buildFrames, parseLink, Reassembler, Framer,
    ac, appRequest, appResponse, cat, readClass, readIntegrity, readGroup, crob, timeWrite, lastRecordedTimeWrite, iinClear, delayFine,
    binaryStatic, boStatus, analogStatic, counterStatic, events, crobEcho, aoBlock, aoStatus, aoEcho, parseApp, inspect, decodePy, objName, ctrlCodeName, airSeconds,
    OBJ, FC, FC_NAMES, IIN, IIN1, IIN2, CROB, CROB_NAMES, CROB_STATUS, BI_FLAGS, AI_FLAGS, QUAL, LINK_PRI, LINK_SEC };
});
