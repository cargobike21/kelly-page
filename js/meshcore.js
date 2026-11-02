/* Kelly Page -- MeshCore companion-radio protocol, for the LoRa Mesh page (js/mesh.js).
 *
 * MeshCore (github.com/meshcore-dev/MeshCore) is a different LoRa mesh from Meshtastic: nothing on air in
 * common. Kelly talks to a node running the COMPANION firmware (the one its phone app uses) over USB, Bluetooth
 * or the Kelly bridge. Repeater / room-server firmware has no app protocol -- only companion works.
 *
 * Wire format, from the firmware source (examples/companion_radio/MyMesh.cpp, v1.18.0, 2026-10-15) and checked
 * against meshcore.js + meshcore_py (2026-10-17; companion_protocol.md is wrong in three places -- the source wins):
 *   every frame = [code u8][payload], all integers little-endian, max 176 bytes of payload
 *   USB / TCP 5000: app->radio '<' len u16 payload, radio->app '>' len u16 payload, 115200 8N1
 *   Bluetooth: Nordic UART service; write a frame to 6e400002, each notification on 6e400003 is one frame
 *     (no header). Needs pairing with the node's 6-digit PIN (on its screen, else 123456) -- the OS asks.
 *   One command at a time: replies carry no sequence number, so they're matched by code (Session.cmd).
 * Start-up: DEVICE_QUERY(3) [switches the node to V3 message frames, with SNR], APP_START, SET_DEVICE_TIME,
 * GET_CONTACTS, GET_CHANNEL 0..n, SYNC_NEXT_MESSAGE until NO_MORE. Then pushes: MSG_WAITING -> sync again,
 * ADVERT/PATH_UPDATED -> re-read that contact, SEND_CONFIRMED -> a DM's ACK (+ round trip ms).
 * Routes (io.route -> js/meshpaths.js): every packet the radio hears arrives as LOG_RX_DATA with its path (decodeRaw);
 * a contact frame carries the learned route TO them (outPath); PATH_UPDATED / an ACK / a path-discovery answer prove
 * a two-way link. GET_ADVERT_PATH gives the hops a contact's last advert took to reach us.
 * Channel messages carry no sender key: the text is "Name: message".
 * DM delivery (as MeshCore's own app does it): no ACK inside the node's own timeout -> send again with the attempt
 * number bumped (same timestamp, so the far end can tell it's a repeat; each attempt gets its own ACK hash), up to 3
 * tries. If the 2nd try on a learned route also fails, the route is forgotten (RESET_PATH) and the 3rd goes by flood,
 * which finds a fresh route. A repeated DM that arrives here twice is shown once. sendText(.., { tries: 1 }) = one go
 * (the golden-packet attempts test ONE chosen route and must not fall back). An ACK that comes after its attempt timed
 * out still counts for LATE_ACK_MS (2 min): long SEQ routes return ACKs well after the node's own timeout (18.7 s
 * seen between two companions, 2026-10-24, flood timeout 8.3 s), so the message turns 'delivered' and its retries stop.
 * Repeater management (a companion manages repeaters / room servers over the air; checked against a real SenseCAP
 * Solar repeater, fw 1.18.0, on the bench 2026-10-21 -- tests/meshcore-tests.html holds the captured frames):
 *   login 26 [key 32][password] -> SENT (tag = first 4 bytes of THEIR key), then PUSH 0x85 [permissions][prefix 6]
 *     [their clock u32][acl perms][fw level]. A WRONG PASSWORD GETS NO ANSWER AT ALL (the repeater stays silent; 0x86
 *     only comes from old firmware) -- so a timeout means "wrong password, or out of range".
 *   status 27 [key 32] -> PUSH 0x87 [0][prefix 6][RepeaterStats: 52 bytes, 1.18 sends 60 -- extras ignored]
 *   telemetry 39 [0 0 0][key 32] -> PUSH 0x8B [0][prefix 6][CayenneLPP, zero-padded; no GPS unless their GPS is on]
 *   binary request 50 [key 32][req...] -> SENT (tag), PUSH 0x8C [0][tag 4][reply]; neighbours = req type 6
 *   remote CLI = SEND_TXT_MSG with txt_type 1: the answer comes back as a contact message of type 1 (via SYNC).
 *     A repeater's clock restarts at 15 May 2024 after every power-off: after an admin login Kelly sets it ("time N").
 *   GET_STATS 56 [0 core | 1 radio | 2 packets] -> RESP 24 (this node's own counters)
 * Trace path (Mesh.cpp onRecvPacket, MyMesh onTraceRecv): CMD 36 [tag u32][auth u32][flags = hash size shift][hashes]
 *   is sent DIRECT along the hashes given. Each repeater whose hash is next adds the SNR it heard the packet at and
 *   passes it on; when the list is used up, whoever hears it reports PUSH 0x89 [0][path_len][flags][tag][auth][hashes]
 *   [one SNR*4 per hop][final SNR*4 = what we heard]. So tracing a repeater and back = [route out.., it, route back..].
 *   Only repeaters / room servers pass a trace on: a companion can't be traced to.
 * Room servers (MeshCore's BBS; js/meshrooms.js -- checked against simple_room_server + companion_radio v1.18.0, 2026-10-23):
 *   login = the repeater's SEND_LOGIN; the companion itself adds the room's "sync since" (the newest post it has had,
 *     kept per contact) to the request. The room's password = admin, its guest password = read + post, a blank one =
 *     read only (if the room allows that). Wrong password: no answer. PUSH 0x85 [1 admin | 2 read-only | 0][prefix 6]
 *     [their clock][acl perms: 0 read-only guest, 1 read-only, 2 read/write, 3 admin][fw level 1].
 *   posts come in pushed by the room, ONE AT A TIME (each waits for our node's ACK, ~1.2 s apart), as contact messages
 *     with txt_type 2 = signed plain: [ts = post time, by the room's clock][author key prefix 4][text]. The room's own
 *     notices carry its own key. It never sends you your own posts. It holds the last 32 posts, in RAM only.
 *   a post = an ordinary DM (txt_type 0) to the room, at most 151 bytes; the room ACKs it. A read-only guest gets no ACK.
 *   keep-alive = binary request type 2 [since u32]: the room counts you active again (3 missed pushes stop them until
 *     then) and, if the request came DIRECT, re-sends every post newer than `since` (0 = no change). Answered with a
 *     bare ACK the companion doesn't pass on, so Kelly can't see it arrive. The firmware's own keep-alive timer is off
 *     for 1.18 rooms (they ask for interval 0).
 *
 * window.KellyMeshCore = { DRIVER, ... } -- DRIVER is what mesh.js drives (same shape as js/loraaprs.js).
 */
(function (root) {
  'use strict';
  const CMD = { APP_START: 1, SEND_TXT_MSG: 2, SEND_CHANNEL_TXT_MSG: 3, GET_CONTACTS: 4, GET_DEVICE_TIME: 5, SET_DEVICE_TIME: 6,
    SEND_SELF_ADVERT: 7, SET_ADVERT_NAME: 8, ADD_UPDATE_CONTACT: 9, SYNC_NEXT_MESSAGE: 10, RESET_PATH: 13, SET_ADVERT_LATLON: 14,
    REMOVE_CONTACT: 15, SHARE_CONTACT: 16, EXPORT_CONTACT: 17, IMPORT_CONTACT: 18, GET_BATT_AND_STORAGE: 20,
    DEVICE_QUERY: 22, SEND_LOGIN: 26, SEND_TRACE_PATH: 36, SEND_STATUS_REQ: 27, GET_CONTACT_BY_KEY: 30, GET_CHANNEL: 31, SET_CHANNEL: 32, SEND_TELEMETRY_REQ: 39, GET_ADVERT_PATH: 42,
    SEND_BINARY_REQ: 50, SEND_PATH_DISCOVERY_REQ: 52, GET_STATS: 56, SET_OTHER_PARAMS: 38, SET_AUTOADD_CONFIG: 58, GET_AUTOADD_CONFIG: 59,
    // never sent: EXPORT_PRIVATE_KEY 23 / IMPORT_PRIVATE_KEY 24 -- Kelly has no use for the node's private key
    SIGN_START: 33, SIGN_DATA: 34, SIGN_FINISH: 35 };   // the node signs bytes with its own Ed25519 identity (Golden Packet hand-offs)
  const RESP = { OK: 0, ERR: 1, CONTACTS_START: 2, CONTACT: 3, END_OF_CONTACTS: 4, SELF_INFO: 5, SENT: 6, CONTACT_MSG: 7, CHANNEL_MSG: 8,
    CURR_TIME: 9, NO_MORE_MESSAGES: 10, EXPORT_CONTACT: 11, BATT_AND_STORAGE: 12, DEVICE_INFO: 13, CONTACT_MSG_V3: 16, CHANNEL_MSG_V3: 17, CHANNEL_INFO: 18, ADVERT_PATH: 22,
    STATS: 24, AUTOADD_CONFIG: 25, CHANNEL_DATA_RECV: 27, SIGN_START: 19, SIGNATURE: 20 };   // 27: a queued channel datagram (fw >= 1.18, CMD_SEND_CHANNEL_DATA) -- drained by sync, handed to io.chdata (MeshPRS)
  const PUSH = { ADVERT: 0x80, PATH_UPDATED: 0x81, SEND_CONFIRMED: 0x82, MSG_WAITING: 0x83, LOGIN_OK: 0x85, LOGIN_FAIL: 0x86, STATUS: 0x87,
    LOG_RX_DATA: 0x88, TRACE: 0x89, NEW_ADVERT: 0x8a, TELEMETRY: 0x8b, BINARY: 0x8c, PATH_DISCOVERY: 0x8d, CONTACT_DELETED: 0x8f };
  const TXT = { PLAIN: 0, CLI: 1, SIGNED: 2 };
  const REQ = { KEEP_ALIVE: 2, NEIGHBOURS: 6 };
  const MAX_POST = 151;   // a room server's MAX_POST_TEXT_LEN (160 - 9)
  const ERR = { 1: 'not supported', 2: 'not found', 3: 'table full', 4: 'busy', 5: 'storage error', 6: 'bad value' };
  const TYPE = { 0: 'Node', 1: 'Companion', 2: 'Repeater', 3: 'Room server', 4: 'Sensor' };
  const MAX_FRAME = 176, MAX_TEXT = 160;
  // framed: each notification is one frame (no '>' header)
  const BLE = { services: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'], framed: true };
  const enc = new TextEncoder(), dec = new TextDecoder();
  // a name -> at most 31 UTF-8 bytes, cut on a character boundary (js/meshqr.js fitName; the firmware cuts bytewise and
  // would leave half a character)
  function nameBytes(s) {
    const Q = typeof self !== 'undefined' ? self.KellyMeshQR : null;
    let n = Q ? Q.fitName(s).name : String(s == null ? '' : s).trim(), b = enc.encode(n);
    while (b.length > 31) { n = Array.from(n).slice(0, -1).join(''); b = enc.encode(n); }
    return b;
  }
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = h => Uint8Array.from((h.match(/../g) || []).map(x => parseInt(x, 16)));
  const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  const i32 = (b, o) => u32(b, o) | 0;
  const putU32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = v >>> 8 & 255; b[o + 2] = v >>> 16 & 255; b[o + 3] = v >>> 24 & 255; };
  const cstr = (b, o, n) => { const s = b.subarray(o, o + n), z = s.indexOf(0); return dec.decode(z < 0 ? s : s.subarray(0, z)); };
  const now = () => Math.floor(Date.now() / 1000);
  // Kelly's node numbers are u32: a MeshCore node's is the first 4 bytes of its public key (the 6-byte prefix
  // in messages starts with the same 4), a name-only channel sender's is a hash of its name.
  const keyNum = b => u32(b, 0);
  const nameNum = s => { let h = 0x811c9dc5; for (const c of enc.encode(s)) h = Math.imul(h ^ c, 0x01000193) >>> 0; return (h | 0x80000000) >>> 0; };
  const shortOf = name => { const w = String(name || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).filter(Boolean); return (w.length > 1 ? w.slice(0, 3).map(x => x[0]).join('') : (w[0] || '?').slice(0, 4)).toUpperCase(); };
  const looksHam = name => /\b[A-Z]{1,2}\d{1,2}[A-Z]{1,4}\b/i.test(name || '');
  const hops = pl => pl === 0xff ? null : pl & 0x3f;
  // A path: path_len's low 6 bits = hop count, top 2 = hash size - 1 (1-3 bytes: the first bytes of each repeater's
  // public key). Flood packets collect it as they go (first repeater first); a DIRECT route is used up from the front.
  // -> { sz, h: ['a3', '5f', ...], bytes } (hex hashes, in order) or null for "no path known" (0xff)
  function readPath(b, o, pl) {
    if (pl === 0xff || pl == null) return null;
    const sz = (pl >> 6) + 1, n = pl & 63, h = [];
    if (sz > 3 || o + n * sz > b.length) return null;
    for (let i = 0; i < n; i++) h.push(hex(b.subarray(o + i * sz, o + i * sz + sz)));
    return { sz, h, bytes: n * sz };
  }
  const pathLen = p => p ? (((p.sz - 1) << 6) | (p.h.length & 63)) : 0xff;
  const pathBytes = p => p ? unhex(p.h.join('')) : new Uint8Array(0);

  // A raw packet as the radio heard it (PUSH LOG_RX_DATA = snr*4, rssi, then Packet::writeTo bytes):
  //   header (route 2 bits | payload type 4 | version 2), [transport codes 4 if a transport route], path_len, path, payload
  // -> { route: 'flood' | 'direct', type, path, advert?, src?, dest?, ack?, ch? }
  const PT = { REQ: 0, RESPONSE: 1, TXT: 2, ACK: 3, ADVERT: 4, GRP_TXT: 5, GRP_DATA: 6, ANON_REQ: 7, PATH: 8, TRACE: 9, MULTIPART: 10, CONTROL: 11, RAW: 15 };
  function decodeRaw(b) {
    if (!b || b.length < 2) return null;
    const hdr = b[0], route = hdr & 3, type = (hdr >> 2) & 15;
    let o = 1;
    if (route === 0 || route === 3) o += 4;   // transport codes
    if (o >= b.length) return null;
    const pl = b[o++], path = readPath(b, o, pl);
    if (!path) return null;
    o += path.bytes;
    if (o > b.length) return null;
    const pay = b.subarray(o), r = { route: route <= 1 ? 'flood' : 'direct', type, path: { sz: path.sz, h: path.h }, len: b.length, payOff: o };   // payOff: js/igateui.js checks an advert's signature
    if (type === PT.ADVERT && pay.length >= 101) {
      const key = pay.subarray(0, 32), flags = pay[100];
      const a = { key: hex(key), num: keyNum(key), ts: u32(pay, 32), type: flags & 15 };
      let i = 101;
      if (flags & 0x10 && pay.length >= i + 8) { const la = i32(pay, i), lo = i32(pay, i + 4); i += 8; if (la || lo) { a.lat = la / 1e6; a.lon = lo / 1e6; } }
      if (flags & 0x20) i += 2;
      if (flags & 0x40) i += 2;
      if (flags & 0x80 && pay.length > i) a.name = cstr(pay, i, pay.length - i);
      r.advert = a;
    } else if ((type === PT.REQ || type === PT.RESPONSE || type === PT.TXT || type === PT.PATH) && pay.length >= 2) {
      r.dest = hex(pay.subarray(0, 1)); r.src = hex(pay.subarray(1, 2));   // payload version 1: 1-byte hashes
    } else if (type === PT.ACK && pay.length >= 4) r.ack = hex(pay.subarray(0, 4));
    else if ((type === PT.GRP_TXT || type === PT.GRP_DATA) && pay.length >= 1) r.ch = hex(pay.subarray(0, 1));
    else if (type === PT.ANON_REQ && pay.length >= 1) r.dest = hex(pay.subarray(0, 1));
    return r;
  }

  // '>' len u16 payload, from a USB / TCP byte stream
  class Framer {
    constructor(onFrame, onJunk) { this.buf = new Uint8Array(0); this.onFrame = onFrame; this.onJunk = onJunk || (() => {}); this.junk = []; }
    push(bytes) {
      const b = new Uint8Array(this.buf.length + bytes.length); b.set(this.buf); b.set(bytes, this.buf.length); this.buf = b;
      for (;;) {
        let i = 0; while (i < this.buf.length && this.buf[i] !== 0x3e) this.junk.push(this.buf[i++]);
        if (i) { this.buf = this.buf.subarray(i); this.flushJunk(); }
        if (this.buf.length < 3) return;
        const len = this.buf[1] | this.buf[2] << 8;
        if (!len || len > MAX_FRAME) { this.buf = this.buf.subarray(1); continue; }
        if (this.buf.length < 3 + len) return;
        const f = this.buf.slice(3, 3 + len); this.buf = this.buf.subarray(3 + len); this.onFrame(f);
      }
    }
    flushJunk() { const t = dec.decode(Uint8Array.from(this.junk)).split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 2 && /^[\x20-\x7e]+$/.test(s)); this.junk = []; t.forEach(this.onJunk); }
  }
  const frame = payload => { const b = new Uint8Array(3 + payload.length); b[0] = 0x3c; b[1] = payload.length & 255; b[2] = payload.length >> 8; b.set(payload, 3); return b; };

  function parseContact(f) {   // CONTACT (3) / NEW_ADVERT (0x8a): 148 bytes
    if (f.length < 132) return null;
    const key = f.subarray(1, 33), name = cstr(f, 100, 32);
    const c = { key: hex(key), num: keyNum(key), type: f[33], flags: f[34], hops: hops(f[35]), name, lastAdvert: f.length >= 136 ? u32(f, 132) : 0 };
    const op = readPath(f, 36, f[35]); c.outPath = op ? { sz: op.sz, h: op.h } : null;   // the route the node has learned TO them
    if (f.length >= 144) { const la = i32(f, 136), lo = i32(f, 140); if (la || lo) { c.lat = la / 1e6; c.lon = lo / 1e6; } }
    if (f.length >= 148) c.lastmod = u32(f, 144);
    return c;
  }
  // CONTACT_MSG 7 / V3 16 and CHANNEL_MSG 8 / V3 17 -> { dm, prefix | ch, hops, type, ts, text, snr }
  function parseMsg(f) {
    const c = f[0], v3 = c === RESP.CONTACT_MSG_V3 || c === RESP.CHANNEL_MSG_V3, o = v3 ? 3 : 0, m = { snr: v3 ? ((f[1] << 24) >> 24) / 4 : null };
    if (c === RESP.CONTACT_MSG || c === RESP.CONTACT_MSG_V3) {
      Object.assign(m, { dm: true, prefix: hex(f.subarray(o + 1, o + 7)), num: u32(f, o + 1), hops: hops(f[o + 7]), type: f[o + 8], ts: u32(f, o + 9) });
      m.text = dec.decode(f.subarray(o + 13 + (m.type === 2 ? 4 : 0)));
      if (m.type === 2) m.author = hex(f.subarray(o + 13, o + 17));   // signed plain (a room server's post): the author's key prefix
    } else {
      Object.assign(m, { dm: false, ch: f[o + 1], hops: hops(f[o + 2]), type: f[o + 3], ts: u32(f, o + 4) });
      const t = dec.decode(f.subarray(o + 8)), i = t.indexOf(': ');
      Object.assign(m, i > 0 && i < 40 ? { sender: t.slice(0, i), text: t.slice(i + 2) } : { sender: '', text: t });
    }
    return m;
  }
  // a room server's pushed post (CONTACT_MSG 7 / 16, txt_type 2) -> { room (its key prefix, 12 hex), authorPrefix (8 hex), ts, text } or null
  function parseRoomPost(f) {
    const m = parseMsg(f);
    return m.dm && m.type === TXT.SIGNED ? { room: m.prefix, authorPrefix: m.author, ts: m.ts, text: m.text.replace(/\0+$/, ''), snr: m.snr, hops: m.hops } : null;
  }

  // ---- repeater management frames (layouts from the bench capture, see the header)
  const i16 = (b, o) => ((b[o] | b[o + 1] << 8) << 16) >> 16, u16 = (b, o) => b[o] | b[o + 1] << 8, s8 = x => (x << 24) >> 24;
  // PUSH 0x85 -> { admin, perms, fwLevel, clock (their RTC, unix s) | null on old firmware }
  function parseLogin(f) {
    return { prefix: hex(f.subarray(2, 8)), admin: !!(f[1] & 1), perms: f.length >= 13 ? f[12] : (f[1] & 1 ? 3 : 1),
      fwLevel: f.length >= 14 ? f[13] : null, clock: f.length >= 12 ? u32(f, 8) : null };
  }
  // RepeaterStats (simple_repeater), after the 8-byte push header -> object, or null if short
  function parseRepeaterStats(b) {
    if (b.length < 52) return null;
    const r = { battV: u16(b, 0) / 1000, txQueue: u16(b, 2), noise: i16(b, 4), rssi: i16(b, 6), recv: u32(b, 8), sent: u32(b, 12),
      txAirS: u32(b, 16), uptimeS: u32(b, 20), sentFlood: u32(b, 24), sentDirect: u32(b, 28), recvFlood: u32(b, 32), recvDirect: u32(b, 36),
      errors: u16(b, 40), snr: i16(b, 42) / 4, dupDirect: u16(b, 44), dupFlood: u16(b, 46), rxAirS: u32(b, 48) };
    if (b.length >= 56) r.recvErrors = u32(b, 52);
    return r;
  }
  // CayenneLPP (big-endian, [channel][type][value]); stops at channel 0 = the firmware's zero padding
  const LPP = { 0: ['digital in', 1, 1, ''], 1: ['digital out', 1, 1, ''], 2: ['analog in', 2, 0.01, ''], 3: ['analog out', 2, 0.01, ''],
    101: ['illuminance', 2, 1, 'lx', true], 102: ['presence', 1, 1, ''], 103: ['temperature', 2, 0.1, '°C'], 104: ['humidity', 1, 0.5, '%', true],
    115: ['pressure', 2, 0.1, 'hPa', true], 116: ['voltage', 2, 0.01, 'V', true], 117: ['current', 2, 0.001, 'A', true], 120: ['percentage', 1, 1, '%', true],
    121: ['altitude', 2, 1, 'm'], 128: ['power', 2, 1, 'W', true], 132: ['direction', 2, 1, '°', true], 142: ['switch', 1, 1, '', true] };
  function parseLpp(b) {
    const out = [];
    for (let i = 0; i + 2 <= b.length;) {
      const ch = b[i], t = b[i + 1];
      if (!ch) break;
      if (t === 136) {   // GPS: 3 x 24-bit signed, 0.0001 deg, 0.0001 deg, 0.01 m
        if (i + 11 > b.length) break;
        const s24 = o => ((b[o] << 16 | b[o + 1] << 8 | b[o + 2]) << 8) >> 8;
        out.push({ ch, type: t, name: 'gps', lat: s24(i + 2) / 1e4, lon: s24(i + 5) / 1e4, alt: s24(i + 8) / 100 }); i += 11; continue;
      }
      const d = LPP[t]; if (!d || i + 2 + d[1] > b.length) break;
      let v = 0; for (let j = 0; j < d[1]; j++) v = v * 256 + b[i + 2 + j];
      if (!d[4] && d[1] === 2) v = (v << 16) >> 16;   // signed types
      out.push({ ch, type: t, name: d[0], value: Math.round(v * d[2] * 1000) / 1000, unit: d[3] });
      i += 2 + d[1];
    }
    return out;
  }
  // GET_NEIGHBOURS reply (after the 4-byte tag): total u16, count u16, then [prefix n][heard secs ago u32][snr*4 i8]
  function parseNeighbours(b, prefixLen = 6) {
    if (b.length < 4) return null;
    const total = u16(b, 0), n = u16(b, 2), list = [], sz = prefixLen + 5;
    for (let i = 0, o = 4; i < n && o + sz <= b.length; i++, o += sz) list.push({ prefix: hex(b.subarray(o, o + prefixLen)), ago: u32(b, o + prefixLen), snr: s8(b[o + prefixLen + 4]) / 4 });
    return { total, list };
  }
  // PUSH 0x89 TRACE_DATA -> { tag, hashes: ['a3', ..], snrs: [dB per hop], final dB }
  function parseTrace(f) {
    if (f.length < 13) return null;
    const pl = f[2], psz = f[3] & 3, sz = 1 << psz, n = pl >> psz, o = 12;
    if (o + pl + n + 1 > f.length) return null;
    const hashes = []; for (let i = 0; i < n; i++) hashes.push(hex(f.subarray(o + i * sz, o + (i + 1) * sz)));
    const snrs = Array.from(f.subarray(o + pl, o + pl + n), x => s8(x) / 4);
    return { tag: hex(f.subarray(4, 8)), hashes, snrs, final: s8(f[o + pl + n]) / 4 };
  }
  // RESP 24 STATS [type][...]
  function parseStats(f) {
    if (f[1] === 0 && f.length >= 11) return { type: 'core', battV: u16(f, 2) / 1000, uptimeS: u32(f, 4), errors: u16(f, 8), queue: f[10] };
    if (f[1] === 1 && f.length >= 14) return { type: 'radio', noise: i16(f, 2), rssi: s8(f[4]), snr: s8(f[5]) / 4, txAirS: u32(f, 6), rxAirS: u32(f, 10) };
    if (f[1] === 2 && f.length >= 30) { const k = ['recv', 'sent', 'sentFlood', 'sentDirect', 'recvFlood', 'recvDirect', 'recvErrors'], r = { type: 'packets' }; k.forEach((x, i) => { r[x] = u32(f, 2 + i * 4); }); return r; }
    return null;
  }

  // One connected companion node. io: { send(payload) -> Promise, node(n), self(n), text(msg), ack(ref, state, err),
  // channels(list), status(state, note), log(line), stat(key, value) }
  function Session(io) {
    const q = []; let cur = null, contactsSince = 0, maxCh = 8, myKey = null, myName = '', fw = '', hashMode = null;
    let maxContacts = null, manualAdd = null, telemModes = null, collect = null;   // DEVICE_INFO [2] * 2; SELF_INFO [47], [46]; a full GET_CONTACTS being gathered
    // contacts Kelly READS (a refresh, a check after a change) are not traffic: io.node gets { read: true } for them, so
    // mesh.js doesn't count them as heard (last heard, ripples, sounds, Mesh Quest)
    const quietKeys = new Set(); let quietAll = false;
    const advertKeys = new Set();   // keys of a PUSH_ADVERT (a known contact's own signed advert) whose re-read is pending
    const chKeys = new Map();   // channel index -> { index, name, secret } (never stored)
    const pend = new Map();   // expected ACK (hex) -> { ref, p, attempt, tries, flood, node, timer }
    const LATE_ACK_MS = 120000;
    const late = new Map();   // a timed-out attempt's ACK (hex) -> { c, until }: still counts if it turns up
    const acked = new Map();  // ref -> ms: delivered (maybe late) -- a retry still being sent is not waited on
    const prune = () => { const t = Date.now(); for (const [a, v] of late) if (v.until < t) late.delete(a); for (const [r, at] of acked) if (at + LATE_ACK_MS < t) acked.delete(r); };
    const seenDm = new Map();  // "prefix|ts|text" -> at: a retried DM is shown once
    // io.standby(): another Kelly is driving this node through the bridge (js/mesh.js setWatch) -- we only listen, so a
    // command fails at once instead of going out twice (or timing out after 6 s)
    const cmd = (payload, expect, ms = 6000) => io.standby && io.standby() ? Promise.reject(new Error('listening only -- another Kelly is using this node'))
      : new Promise((resolve, reject) => { q.push({ payload, expect, ms, resolve, reject }); pump(); });
    const quietRead = key => { key = String(key || '').toLowerCase(); quietKeys.add(key); return cmd(Uint8Array.of(CMD.GET_CONTACT_BY_KEY, ...unhex(key)), [RESP.CONTACT]).finally(() => quietKeys.delete(key)); };
    function pump() {
      if (cur || !q.length) return;
      cur = q.shift();
      cur.timer = setTimeout(() => { const c = cur; cur = null; c.reject(new Error('the node did not answer')); pump(); }, cur.ms);
      io.send(cur.payload).catch(e => { clearTimeout(cur.timer); const c = cur; cur = null; c.reject(e); pump(); });
    }
    function settle(f) {
      if (!cur) return;
      const code = f[0];
      if (code === RESP.ERR) { clearTimeout(cur.timer); const c = cur; cur = null; c.reject(new Error(ERR[f[1]] || `error ${f[1]}`)); pump(); return; }
      if (cur.expect.includes(code)) { clearTimeout(cur.timer); const c = cur; cur = null; c.resolve(f); pump(); }
    }
    const nodeOf = c => ({ num: c.num, key: c.key, idLabel: c.key.slice(0, 12), longName: c.name || c.key.slice(0, 8), shortName: shortOf(c.name), hwLabel: TYPE[c.type] || 'Node',
      role: c.type, hops: c.hops, licensed: looksHam(c.name), lat: c.lat, lon: c.lon, lastHeard: c.lastmod ? c.lastmod * 1000 : undefined, fav: !!(c.flags & 1), flags: c.flags, outPath: c.outPath,
      advertTs: c.lastAdvert || undefined });   // the sender's own clock: the APRS iGate's replay check
    const raw = new Map();   // key -> its CONTACT frame, so setPath can write the record back with only the route changed
    let discovery = null;     // the path discovery waiting for its answer: { num, at }
    // Repeater management: the answer comes later, as a push (or a CLI reply through SYNC). A waiter is registered
    // BEFORE the command goes out, armed for 60 s, then re-armed from the SENT frame's own timeout estimate.
    const waits = [];
    const drop = w => { const i = waits.indexOf(w); if (i >= 0) waits.splice(i, 1); clearTimeout(w.timer); };
    function waiter(test, what) {
      const w = { test, what }; w.p = new Promise((resolve, reject) => { w.resolve = resolve; w.reject = reject; });
      w.arm = ms => { clearTimeout(w.timer); w.timer = setTimeout(() => { drop(w); w.reject(new Error(w.what)); }, ms); };
      w.arm(60000); waits.push(w); return w;
    }
    // the companion tracks ONE pending login / status / telemetry / request at a time: run repeater calls in turn
    let rChain = Promise.resolve();
    const rOp = fn => { const p = rChain.then(fn); rChain = p.catch(() => {}); return p; };
    const keyOf = node => { if (!node || !node.key) throw new Error('that node has no MeshCore key'); return unhex(node.key); };
    const preOf = node => node.key.slice(0, 12);
    // send a request, wait for its answer: -> the answering frame
    async function ask(payload, test, what) {
      const w = waiter(test, what);
      try { const f = await cmd(payload, [RESP.SENT]); w.arm(Math.min(60000, Math.max(8000, u32(f, 6) * 1.5 + 4000))); w.tag = hex(f.subarray(2, 6)); }
      catch (e) { drop(w); throw e; }
      return w.p;
    }
    const fromIt = (node, code) => f => f[0] === code && hex(f.subarray(2, 8)) === preOf(node);
    // A CLI answer is one unacknowledged packet: on a busy repeater about 1 in 10 is lost (bench, 2026-10-21), so a
    // timeout is retried once. The companion stamps each send with a fresh time, so the repeater runs it again rather
    // than treating it as a replay (an exact repeat of the timestamp gets an empty answer).
    async function cliRaw(node, text, tries = 2) {
      const k = keyOf(node), body = enc.encode(text);
      if (!body.length || body.length > MAX_TEXT) throw new Error('command empty or too long');
      const p = new Uint8Array(13 + body.length); p[0] = CMD.SEND_TXT_MSG; p[1] = TXT.CLI; p.set(k.subarray(0, 6), 7); p.set(body, 13);
      for (let i = 1; ; i++) {
        putU32(p, 3, now());
        try {
          const f = await ask(p, f => (f[0] === RESP.CONTACT_MSG || f[0] === RESP.CONTACT_MSG_V3) && (m => m.type === TXT.CLI && m.prefix === preOf(node))(parseMsg(f)),
            'the repeater did not answer -- log in as admin first, or it is out of range');
          return parseMsg(f).text.replace(/\0+$/, '');
        } catch (e) { if (i >= tries || !/did not answer/.test(e.message)) throw e; io.log(`CLI "${text}": no answer, trying again`); }
      }
    }

    function onFrame(f) {
      if (!f.length) return;
      const code = f[0];
      for (const w of waits.slice()) if (w.test(f, w)) { drop(w); w.resolve(f); }
      switch (code) {
        case RESP.CONTACT: case PUSH.NEW_ADVERT: { const c = parseContact(f); if (c) { raw.set(c.key, f.slice()); if (collect && code === RESP.CONTACT) collect.push(nodeOf(c)); const quiet = code === RESP.CONTACT && (quietAll || quietKeys.delete(c.key)); const adv = code === RESP.CONTACT && advertKeys.delete(c.key); io.node(nodeOf(c), code === PUSH.NEW_ADVERT, quiet || adv ? { ...(quiet ? { read: true } : {}), ...(adv ? { advert: true } : {}) } : undefined); if (c.lastmod > contactsSince) contactsSince = c.lastmod; if (code === PUSH.NEW_ADVERT) route({ kind: 'advert', num: c.num, key: c.key }); } break; }
        case RESP.END_OF_CONTACTS: if (f.length >= 5) contactsSince = Math.max(contactsSince, u32(f, 1)); break;
        case RESP.SELF_INFO: {
          if (f.length < 58) break;
          myKey = f.subarray(4, 36); myName = dec.decode(f.subarray(58)); manualAdd = f[47]; telemModes = f[46];
          const la = i32(f, 36), lo = i32(f, 40);
          io.self({ num: keyNum(myKey), key: hex(myKey), idLabel: hex(myKey).slice(0, 12), longName: myName, shortName: shortOf(myName), hwLabel: 'Companion',
            licensed: looksHam(myName), ...(la || lo ? { lat: la / 1e6, lon: lo / 1e6 } : {}),
            radio: `${(u32(f, 48) / 1000).toFixed(3)} MHz · BW ${u32(f, 52) / 1000} kHz · SF${f[56]} · CR4/${f[57]} · ${(f[2] << 24) >> 24} dBm` });
          break;
        }
        case RESP.DEVICE_INFO: if (f.length >= 80) { fw = cstr(f, 60, 20); maxCh = f[3] || 8; maxContacts = f[2] ? f[2] * 2 : null; io.stat('fw', `${fw} · ${cstr(f, 20, 40)}`); }
          if (f.length > 81) { hashMode = f[81]; io.stat('hashMode', hashMode); }   // path_hash_mode, fw v10+ (companion MyMesh.cpp:1074): 0/1/2 = 1/2/3-byte
          break;
        case RESP.CHANNEL_INFO: break;   // read by readChannels
        case RESP.BATT_AND_STORAGE: if (f.length >= 3) io.stat('battery', (f[1] | f[2] << 8) / 1000); break;
        case RESP.CONTACT_MSG: case RESP.CONTACT_MSG_V3: case RESP.CHANNEL_MSG: case RESP.CHANNEL_MSG_V3: {
          const m = parseMsg(f);
          if (m.dm && (m.type === 0 || m.type === 2)) {
            const k = `${m.prefix}|${m.ts}|${m.text}`, t = Date.now();
            for (const [x, at] of seenDm) if (t - at > 15 * 60000) seenDm.delete(x);
            if (seenDm.has(k)) break;   // the sender's retry of one we already have
            seenDm.set(k, t);
          }
          if (m.type === 0 || m.type === 2) io.text(m);
          else if (m.type === TXT.CLI && io.cli) io.cli(m);   // a repeater's CLI answer (also read by cliRaw's waiter)
          break;
        }
        case RESP.SENT: break;           // read by sendText
        case PUSH.SEND_CONFIRMED: {
          const a = hex(f.subarray(1, 5)), c = pend.get(a), rtt = f.length >= 9 ? u32(f, 5) : null;
          if (c) { pend.delete(a); clearTimeout(c.timer); delivered(c, a, rtt, false); }
          else { prune(); const l = late.get(a); if (l && !acked.has(l.c.ref)) delivered(l.c, a, rtt, true); }
          break;
        }
        case PUSH.MSG_WAITING: sync(); break;
        // [27][snr*4 i8][0][0][channel idx][path_len, 0xFF = came direct][data_type u16 LE][len][blob] (companion-v1.18.0
        // MyMesh.cpp onChannelDataRecv). js/meshprs.js frames (type 0xFF4D on #meshprs) go to the APRS iGate via io.chdata
        case RESP.CHANNEL_DATA_RECV: {
          if (f.length < 9 || f.length < 9 + f[8]) break;
          const x = { snr: ((f[1] << 24) >> 24) / 4, ch: f[4], hops: hops(f[5]), type: f[6] | f[7] << 8, data: f.slice(9, 9 + f[8]), at: Date.now() };
          const c = chKeys.get(x.ch); x.chName = c ? c.name : '';
          if (io.chdata) io.chdata(x); else io.log(`channel data on ch ${x.ch} (type ${x.type}, ${x.data.length} bytes) -- not shown`);
          break;
        }
        case PUSH.CONTACT_DELETED:   // the node overwrote its oldest contact to make room
          if (f.length >= 33) { const key = f.subarray(1, 33); raw.delete(hex(key)); if (io.gone) io.gone(keyNum(key)); }
          break;
        case PUSH.ADVERT: case PUSH.PATH_UPDATED:
          if (f.length >= 33) {
            const key = f.subarray(1, 33);
            // PATH_UPDATED = the node just learned a route TO them from their path-return, which they only send after
            // OUR packet reached them -- so it proves the link both ways (BaseChatMesh::onContactPathRecv)
            route({ kind: code === PUSH.PATH_UPDATED ? 'path-updated' : 'advert', num: keyNum(key), key: hex(key) });
            if (code === PUSH.ADVERT) advertKeys.add(hex(key));   // its re-read below goes on as meta.advert (hc-service advertSeen)
            cmd(Uint8Array.of(CMD.GET_CONTACT_BY_KEY, ...key), [RESP.CONTACT]).catch(() => {});
          }
          break;
        case PUSH.LOG_RX_DATA: {
          const snr = f.length >= 2 ? ((f[1] << 24) >> 24) / 4 : null;
          io.stat('rx', snr);
          if (f.length > 4) { const pkt = decodeRaw(f.subarray(3)); if (pkt) route({ kind: 'rx', snr, rssi: (f[2] << 24) >> 24, pkt, raw: f.subarray(3) }); }
          break;
        }
        case 0x8e:   // PUSH_CODE_CONTROL_DATA: snr*4, rssi, path_len, payload (a node discover answer -> js/meshdrive.js)
          if (f.length >= 5) route({ kind: 'control', snr: ((f[1] << 24) >> 24) / 4, rssi: (f[2] << 24) >> 24, pathLen: f[3], data: f.subarray(4) });
          break;
        case PUSH.PATH_DISCOVERY: {   // reserved, pubkey prefix 6, out_path_len, out_path, in_path_len, in_path
          if (f.length < 9) break;
          const out = readPath(f, 9, f[8]); if (!out) break;
          const o2 = 9 + out.bytes, back = readPath(f, o2 + 1, f[o2]);
          const d = { kind: 'discovery', prefix: hex(f.subarray(2, 8)), num: u32(f, 2), out: { sz: out.sz, h: out.h }, back: back ? { sz: back.sz, h: back.h } : null };
          if (discovery && discovery.num === d.num) { d.rtt = Date.now() - discovery.at; discovery = null; }
          route(d);
          break;
        }
      }
      if (code < 0x80) settle(f);
    }
    function route(e) { if (io.route) try { io.route(e); } catch (err) { io.log(`paths: ${err.message}`); } }
    // a DM's ACK (on time, or late for an earlier attempt): delivered, and any other attempt of it stops waiting
    function delivered(c, ack, rtt, isLate) {
      acked.set(c.ref, Date.now());
      for (const [a, o] of pend) if (o.ref === c.ref) { clearTimeout(o.timer); pend.delete(a); }
      for (const [a, o] of late) if (o.c.ref === c.ref) late.delete(a);
      if (isLate) io.log(`DM to ${c.node.longName || c.node.key.slice(0, 8)}: its ACK came late${rtt ? ` (${(rtt / 1000).toFixed(1)} s)` : ''} -- delivered`);
      io.ack(c.ref, 'delivered');
      route({ kind: 'ack', ref: c.ref, ack, rtt, attempt: c.attempt, late: isLate });
    }
    // one DM attempt: send, then wait for its ACK; on a miss, the next attempt (see the header)
    async function dmTry(c) {
      c.p[2] = c.attempt;
      const f = await cmd(c.p, [RESP.SENT]);
      const ack = hex(f.subarray(2, 6)), ms = u32(f, 6);
      c.flood = !!f[1];
      route({ kind: 'sent', ref: c.ref, num: c.node.num, ack, flood: c.flood, timeout: ms, attempt: c.attempt });
      if (!u32(f, 2) || acked.has(c.ref)) return;   // no ACK to wait for / an earlier attempt's came in meanwhile
      const t = { ...c };
      pend.set(ack, t);
      t.timer = setTimeout(() => { if (pend.delete(ack)) { prune(); late.set(ack, { c: t, until: Date.now() + LATE_ACK_MS }); missed(t, ack); } }, Math.max(8000, Math.min(ms * 2, 60000)));
    }
    async function missed(c, ack) {
      if (acked.has(c.ref)) return;
      const next = c.attempt + 1;
      if (next >= c.tries) { io.ack(c.ref, 'failed', c.tries > 1 ? `no ACK after ${c.tries} tries` : 'no ACK'); route({ kind: 'noack', ref: c.ref, ack }); return; }
      try {
        if (next === c.tries - 1 && !c.flood && c.tries > 2) {   // the learned route failed twice: forget it, flood the last try
          await cmd(Uint8Array.of(CMD.RESET_PATH, ...unhex(c.node.key)), [RESP.OK]);
          io.log(`DM to ${c.node.longName || c.node.key.slice(0, 8)}: no ACK on its route twice -- route forgotten, trying by flood`);
          route({ kind: 'path-reset', num: c.node.num, key: c.node.key });
        }
        io.ack(c.ref, 'retry', `no ACK yet: try ${next + 1} of ${c.tries}`);
        await dmTry({ ...c, attempt: next });
      } catch (e) { io.ack(c.ref, 'failed', e.message); }
    }
    let syncing = false;
    async function sync() {
      if (syncing || (io.standby && io.standby())) return; syncing = true;   // listening only: the Kelly driving the node syncs, we hear it
      try { for (let i = 0; i < 300; i++) { const f = await cmd(Uint8Array.of(CMD.SYNC_NEXT_MESSAGE), [RESP.NO_MORE_MESSAGES, RESP.CONTACT_MSG, RESP.CONTACT_MSG_V3, RESP.CHANNEL_MSG, RESP.CHANNEL_MSG_V3, RESP.CHANNEL_DATA_RECV]); if (f[0] === RESP.NO_MORE_MESSAGES) break; } }
      catch (e) { io.log(`message sync: ${e.message}`); }
      syncing = false;
    }
    async function readContacts() {
      const p = new Uint8Array(contactsSince ? 5 : 1); p[0] = CMD.GET_CONTACTS; if (contactsSince) putU32(p, 1, contactsSince);
      await cmd(p, [RESP.END_OF_CONTACTS], 60000);
    }
    async function readChannels() {
      const list = [];
      for (let i = 0; i < Math.min(maxCh, 8); i++) {
        try { const f = await cmd(Uint8Array.of(CMD.GET_CHANNEL, i), [RESP.CHANNEL_INFO]); const name = cstr(f, 2, 32); if (name || i === 0) list[i] = { index: i, name: name || 'Public' };
          // [18][idx][name 32][secret 16] (companion MyMesh.cpp:1757): kept in memory only, for js/mcdecode.js to read OUR channels
          if ((name || i === 0) && f.length >= 50) chKeys.set(i, { index: i, name: name || 'Public', secret: f.slice(34, 50) }); }
        catch { break; }
      }
      io.channels(list);
    }
    return {
      onFrame,
      async start() {
        io.status('config', 'asking the node who it is');
        await cmd(Uint8Array.of(CMD.DEVICE_QUERY, 3), [RESP.DEVICE_INFO]).catch(e => io.log(`device query: ${e.message}`));
        const app = new Uint8Array(8 + 5); app[0] = CMD.APP_START; app[1] = 3; app.set(enc.encode('Kelly'), 8);
        await cmd(app, [RESP.SELF_INFO]);
        const t = new Uint8Array(5); t[0] = CMD.SET_DEVICE_TIME; putU32(t, 1, now());
        await cmd(t, [RESP.OK]).catch(() => {});   // ERR 6 = its clock is already ahead: fine
        io.status('config', 'reading its contacts');
        await readContacts();
        await readChannels();
        await cmd(Uint8Array.of(CMD.GET_BATT_AND_STORAGE), [RESP.BATT_AND_STORAGE]).catch(() => {});
        io.status('on');
        await sync();
      },
      // target: { dm: node } or { ch: index }. -> { ref } ; io.ack(ref, ...) follows for a DM
      async sendText(target, text, ref, opts = {}) {
        const body = enc.encode(text), ts = now();
        if (target.dm) {
          if (!target.dm.key) throw new Error('that node has no MeshCore key -- it was only heard by name');
          const p = new Uint8Array(13 + body.length); p[0] = CMD.SEND_TXT_MSG; p[1] = 0; p[2] = 0; putU32(p, 3, ts); p.set(unhex(target.dm.key).subarray(0, 6), 7); p.set(body, 13);
          await dmTry({ ref, p, attempt: 0, tries: Math.max(1, Math.min(3, opts.tries || 3)), node: target.dm });
          return 'sent';
        }
        const p = new Uint8Array(7 + body.length); p[0] = CMD.SEND_CHANNEL_TXT_MSG; p[1] = 0; p[2] = target.ch | 0; putU32(p, 3, ts); p.set(body, 7);
        await cmd(p, [RESP.OK]);
        return 'sent';   // a channel message gets no ACK -- sent is all we know
      },
      // MeshCore shares position in its advert: set it, then flood an advert
      async sharePosition(lat, lon) {
        const p = new Uint8Array(9); p[0] = CMD.SET_ADVERT_LATLON; putU32(p, 1, Math.round(lat * 1e6) | 0); putU32(p, 5, Math.round(lon * 1e6) | 0);
        await cmd(p, [RESP.OK]);
        await cmd(Uint8Array.of(CMD.SEND_SELF_ADVERT, 1), [RESP.OK]);
      },
      // the node's path hash size (CMD_SET_PATH_HASH_MODE 61 [0][mode], companion MyMesh.cpp:1504): saved, live at once
      async setPathHashMode(mode) { await cmd(Uint8Array.of(61, 0, mode & 3), [RESP.OK]); hashMode = mode & 3; io.stat('hashMode', hashMode); },
      pathHashMode: () => hashMode,
      channelKeys: () => [...chKeys.values()],
      // the channel slots Kelly reads (the first min(DEVICE_INFO[3], 8)) -> { max, list: [{ index, name, secretHex }] }.
      // secretHex is for comparing a scanned channel with ours only: never stored, shown, logged or synced.
      channelSlots: () => ({ max: Math.min(maxCh, 8), list: [...chKeys.values()].map(c => ({ index: c.index, name: c.name, secretHex: hex(c.secret) })) }),
      // CMD_SET_CHANNEL [32][idx][name 32, NUL padded][secret 16] (companion MyMesh.cpp ~L1769; 16-byte secrets only),
      // then the channels are read again. From a meshcore://channel/add QR (js/meshchannels.js); never overwrites a
      // slot in use unless replace is set (the UI asks first).
      async setChannel(index, name, secretHex, { replace = false } = {}) {
        const i = index | 0, h = String(secretHex || '').toLowerCase();
        if (i < 0 || i >= Math.min(maxCh, 8)) throw new Error(`the node has channel slots 0 to ${Math.min(maxCh, 8) - 1}`);
        if (!/^[0-9a-f]{32}$/.test(h)) throw new Error('a channel secret is 32 hex digits');
        if (chKeys.has(i) && !replace) throw new Error(`slot ${i} already holds ${chKeys.get(i).name} -- replace it on purpose, or pick a free slot`);
        const nb = nameBytes(name); if (!nb.length) throw new Error('a channel needs a name');
        const p = new Uint8Array(50); p[0] = CMD.SET_CHANNEL; p[1] = i; p.set(nb, 2); p.set(unhex(h), 34);
        await cmd(p, [RESP.OK]);
        await readChannels();
        return { index: i, name: dec.decode(nb) };
      },
      async advert(flood = true) { await cmd(Uint8Array.of(CMD.SEND_SELF_ADVERT, flood ? 1 : 0), [RESP.OK]); },
      // CMD_SEND_CHANNEL_DATA 62 [62][ch][path_len][path][data_type u16 LE][data] (companion-v1.18.0 MyMesh.cpp ~L1198):
      // flood = path_len 0xFF, zero-hop = 0. MeshPRS floods go UNSCOPED (spec §12.2): the companion scopes a flood with its
      // default scope key when one is set (MyMesh.cpp 502-522), so then CMD_SET_FLOOD_SCOPE_KEY [54][1] (send unscoped)
      // first and [54][0] after. CMD_GET_DEFAULT_FLOOD_SCOPE 64 -> [28] alone = none; older firmware errors = none either.
      async sendChannelData(index, type, data, { flood = true } = {}) {
        const d = Uint8Array.from(data), i = index | 0;
        if (!(type > 0 && type < 0x10000) || d.length > 165) throw new Error('channel data: a type 1-65535 and at most 165 bytes');
        let scoped = false;
        if (flood) try { scoped = (await cmd(Uint8Array.of(64), [28])).length > 1; } catch { scoped = false; }
        if (scoped) await cmd(Uint8Array.of(54, 1), [RESP.OK]);
        try { const p = new Uint8Array(5 + d.length); p.set([62, i, flood ? 0xff : 0, type & 255, type >> 8]); p.set(d, 5); await cmd(p, [RESP.OK]); }
        finally { if (scoped) try { await cmd(Uint8Array.of(54, 0), [RESP.OK]); } catch { /* the next session resets it */ } }
      },   // false = zero-hop (Drive mode)
      // Zero-hop node discover (CMD_SEND_CONTROL_DATA 55, repeaters only): each repeater in range answers DISCOVER_RESP
      // with the SNR it heard us and this tag, as PUSH 0x8E (route kind 'control'). Repeaters allow 4 per 2 min.
      async discoverNear(tag) { const p = new Uint8Array(7); p[0] = 55; p[1] = 0x80; p[2] = 1 << 2; putU32(p, 3, tag >>> 0); await cmd(p, [RESP.OK]); },
      // ---- routes (js/meshpaths.js): advertPath + setPath stay on this node; discover (and a DM after setPath) go on air
      // The path a contact's last advert took to reach this node -> { t, path } or null (the node keeps the last few dozen)
      async advertPath(key) {
        try { const f = await cmd(Uint8Array.of(CMD.GET_ADVERT_PATH, 0, ...unhex(key)), [RESP.ADVERT_PATH]); const p = readPath(f, 6, f[5]); return p ? { t: u32(f, 1) * 1000, path: { sz: p.sz, h: p.h } } : null; }
        catch { return null; }
      },
      // Path discovery: a flood request (base telemetry) they answer with BOTH routes -> PUSH 0x8d. Only nodes that
      // allow telemetry to us answer, so silence proves nothing. -> { flood, timeout ms }
      async discover(node) {
        if (!node || !node.key) throw new Error('that node has no MeshCore key');
        const f = await cmd(Uint8Array.of(CMD.SEND_PATH_DISCOVERY_REQ, 0, ...unhex(node.key)), [RESP.SENT]);
        discovery = { num: node.num, at: Date.now() };
        return { flood: !!f[1], timeout: u32(f, 6) };
      },
      // Set the route the node uses TO a contact (path = {sz, h}), or null to forget it (the next DM floods).
      // Writes the contact record back with only out_path changed (CMD_ADD_UPDATE_CONTACT), from the frame it sent us.
      async setPath(node, path) {
        if (!node || !node.key) throw new Error('that node has no MeshCore key');
        if (!path) { await cmd(Uint8Array.of(CMD.RESET_PATH, ...unhex(node.key)), [RESP.OK]); return; }
        const r = raw.get(node.key); if (!r || r.length < 136) throw new Error('Kelly has not read that contact from the node yet');
        const b = pathBytes(path); if (b.length > 64) throw new Error('route too long');
        const p = new Uint8Array(r.length); p.set(r); p[0] = CMD.ADD_UPDATE_CONTACT; p[35] = pathLen(path); p.fill(0, 36, 100); p.set(b, 36);
        await cmd(p.subarray(0, Math.min(p.length, 148)), [RESP.OK]);
        cmd(Uint8Array.of(CMD.GET_CONTACT_BY_KEY, ...unhex(node.key)), [RESP.CONTACT]).catch(() => {});
      },
      // ---- repeater management (js/meshrepeaters.js). Each rejects with a plain-English reason.
      // Log in (admin or guest password, max 15 chars). -> { admin, perms, fwLevel, clock, clockSet? }
      // An admin login sets the repeater's clock when it's more than 2 minutes slow (it restarts at May 2024).
      login: (node, password) => rOp(async () => {
        const k = keyOf(node), pw = enc.encode(password || '');
        if (pw.length > 15) throw new Error('MeshCore passwords are at most 15 characters');
        const f = await ask(Uint8Array.of(CMD.SEND_LOGIN, ...k, ...pw), f => (f[0] === PUSH.LOGIN_OK || f[0] === PUSH.LOGIN_FAIL) && hex(f.subarray(2, 8)) === preOf(node),
          'no answer: wrong password, or the repeater is out of range (a repeater stays silent on a wrong password)');
        if (f[0] === PUSH.LOGIN_FAIL) throw new Error('wrong password');
        const r = parseLogin(f);
        if (r.admin && r.clock != null && r.clock < now() - 120) {
          try { r.clockSet = await cliRaw(node, `time ${now()}`); } catch (e) { r.clockSet = `clock not set: ${e.message}`; }
        }
        return r;
      }),
      status: node => rOp(async () => parseRepeaterStats((await ask(Uint8Array.of(CMD.SEND_STATUS_REQ, ...keyOf(node)), fromIt(node, PUSH.STATUS), 'no status answer -- out of range?')).subarray(8))),
      telemetry: node => rOp(async () => parseLpp((await ask(Uint8Array.of(CMD.SEND_TELEMETRY_REQ, 0, 0, 0, ...keyOf(node)), fromIt(node, PUSH.TELEMETRY), 'no telemetry answer -- out of range?')).subarray(8))),
      // the stations the repeater hears directly (zero hop), strongest first -> { total, list: [{ prefix, ago s, snr }] }
      neighbours: node => rOp(async () => {
        const rnd = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
        const f = await ask(Uint8Array.of(CMD.SEND_BINARY_REQ, ...keyOf(node), REQ.NEIGHBOURS, 0, 40, 0, 0, 2, 6, ...rnd),
          (f, w) => f[0] === PUSH.BINARY && hex(f.subarray(2, 6)) === w.tag, 'no neighbours answer -- log in first, or out of range');
        return parseNeighbours(f.subarray(6));
      }),
      // Trace to a repeater / room server and back along its learned route (or straight to it when none is known).
      // -> { out: [hash], back: [hash], snrTowards: [dB at each hop out, then at it], snrBack: [dB at each hop back, then us], ms }
      async trace(node) {
        const k = keyOf(node);
        if (node.role !== 2 && node.role !== 3) throw new Error('MeshCore traces go through repeaters: pick a repeater or room server');
        const op = node.outPath && node.outPath.h || [], sz = node.outPath && node.outPath.sz === 2 ? 2 : 1;
        const out = op.map(h => h.slice(0, sz * 2)), me = hex(k.subarray(0, sz)), back = out.slice().reverse();
        const path = [...out, me, ...back], t0 = Date.now(), tag = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
        const f = await ask(Uint8Array.of(CMD.SEND_TRACE_PATH, ...tag, 0, 0, 0, 0, sz === 2 ? 1 : 0, ...unhex(path.join(''))),
          (f, w) => f[0] === PUSH.TRACE && hex(f.subarray(4, 8)) === w.tag, `no trace answer from ${node.longName || 'it'} -- out of range, or a hop on its route is down`);
        const r = parseTrace(f), n = out.length;
        return { out, back, snrTowards: r.snrs.slice(0, n + 1), snrBack: [...r.snrs.slice(n + 1), r.final], ms: Date.now() - t0 };
      },
      // A trace along exactly this hash list -- Telemetry polling's route check to a companion, which doesn't forward, so
      // the list turns round at the last repeater before it. -> { snrs: [dB at each listed hop], final (us), ms }
      async traceList(hashes, size) {
        const sz = size === 2 ? 2 : 1, list = (hashes || []).map(h => String(h).toLowerCase().slice(0, sz * 2));
        if (!list.length || list.some(h => !/^[0-9a-f]+$/.test(h) || h.length !== sz * 2)) throw new Error('a trace needs at least one repeater hash');
        const t0 = Date.now(), tag = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
        const f = await ask(Uint8Array.of(CMD.SEND_TRACE_PATH, ...tag, 0, 0, 0, 0, sz === 2 ? 1 : 0, ...unhex(list.join(''))),
          (f, w) => f[0] === PUSH.TRACE && hex(f.subarray(4, 8)) === w.tag, 'no trace answer -- out of range, or a hop on the route is down');
        const r = parseTrace(f);
        return { snrs: r.snrs, final: r.final, ms: Date.now() - t0 };
      },
      // a CLI-data message (txt_type 1) to a companion: the firmware gives it to the app there unACKed and out of the chat
      // (BaseChatMesh onPeerDataRecv) -- Kelly-to-Kelly control, which does its own ACKs. -> { flood }
      async sendData(node, text) {
        const k = keyOf(node), body = enc.encode(text);
        if (!body.length || body.length > MAX_TEXT) throw new Error('message empty or too long');
        const p = new Uint8Array(13 + body.length); p[0] = CMD.SEND_TXT_MSG; p[1] = TXT.CLI; p.set(k.subarray(0, 6), 7); p.set(body, 13);
        putU32(p, 3, now());
        const f = await cmd(p, [RESP.SENT]);
        return { flood: f[1] === 1 };
      },
      // a remote CLI command (admin login needed): -> the repeater's reply text
      cli: (node, text) => rOp(() => cliRaw(node, text)),
      // this node's own counters (GET_STATS core + radio + packets)
      async ownStats() {
        const r = {};
        for (const t of [0, 1, 2]) { try { Object.assign(r, parseStats(await cmd(Uint8Array.of(CMD.GET_STATS, t), [RESP.STATS])) || {}); } catch { /* older firmware */ } }
        delete r.type; return r;
      },
      // this node's own clock -> unix s. A power-off restarts it at 15 May 2024; Kelly sets it on connect.
      async ownClock() { return u32(await cmd(Uint8Array.of(CMD.GET_DEVICE_TIME), [RESP.CURR_TIME]), 1); },
      // set it to this PC's time -> the time set. ERR 6 = it's AHEAD: MeshCore never turns a clock back.
      async setOwnClock() {
        const t = new Uint8Array(5); t[0] = CMD.SET_DEVICE_TIME; putU32(t, 1, now());
        try { await cmd(t, [RESP.OK]); }
        catch (e) { throw /bad value/.test(e.message) ? new Error("its clock is ahead of this PC's and MeshCore never turns a clock back -- power it off and on, then set it") : e; }
        return now();
      },
      // a repeater's clock to this PC's time, by its CLI ("time N"; admin login first) -> its answer, "OK - clock set: ..."
      // or "ERR: clock cannot go backwards" (only a power-off brings a fast one back)
      setClock: node => rOp(() => cliRaw(node, `time ${now()}`)),
      // ---- room servers (js/meshrooms.js; frames in the header)
      // Log in: the guest password (read + post), blank (read only, where the room allows it) or the admin one. The
      // room then pushes the posts newer than the last one this node had. -> { admin, perms, canPost, fwLevel, clock }
      roomLogin: (node, password) => rOp(async () => {
        const k = keyOf(node), pw = enc.encode(password || '');
        if (pw.length > 15) throw new Error('MeshCore passwords are at most 15 characters');
        const f = await ask(Uint8Array.of(CMD.SEND_LOGIN, ...k, ...pw), f => (f[0] === PUSH.LOGIN_OK || f[0] === PUSH.LOGIN_FAIL) && hex(f.subarray(2, 8)) === preOf(node),
          'no answer: wrong password, or the room is out of range (a room stays silent on a wrong password)');
        if (f[0] === PUSH.LOGIN_FAIL) throw new Error('wrong password');
        const r = parseLogin(f);
        return { ...r, canPost: f.length >= 13 ? (f[12] & 3) !== 0 : !(f[1] & 2) };
      }),
      // A post = a DM to the room (normal retries; the room's ACK = it has the post). io.ack(ref, ...) follows.
      async roomPost(node, text, ref) {
        const body = enc.encode(String(text || ''));
        if (!body.length || body.length > MAX_POST) throw new Error(`a room post is 1 to ${MAX_POST} bytes`);
        const p = new Uint8Array(13 + body.length); p[0] = CMD.SEND_TXT_MSG; putU32(p, 3, now()); p.set(keyOf(node).subarray(0, 6), 7); p.set(body, 13);
        await dmTry({ ref, p, attempt: 0, tries: 3, node });
        return 'sent';
      },
      // Keep-alive: "still here" (the room resumes pushing after missed ACKs) and, sent direct, "re-send posts newer than
      // since" (unix s; 0 = no change, 1 = all it holds). No answer reaches the app. -> { flood }
      roomKeepAlive: (node, since = 0) => rOp(async () => {
        const p = Uint8Array.of(CMD.SEND_BINARY_REQ, ...keyOf(node), REQ.KEEP_ALIVE, 0, 0, 0, 0); putU32(p, 34, since >>> 0);
        const f = await cmd(p, [RESP.SENT]);
        return { flood: !!f[1] };
      }),
      maxPost: MAX_POST,
      // ---- contact management (js/meshcontacts.js)
      async removeContact(node) { await cmd(Uint8Array.of(CMD.REMOVE_CONTACT, ...keyOf(node)), [RESP.OK]); raw.delete(node.key); if (io.gone) io.gone(node.num); },
      // their advert, sent one hop over the air
      async shareContact(node) { await cmd(Uint8Array.of(CMD.SHARE_CONTACT, ...keyOf(node)), [RESP.OK]); },
      // -> "meshcore://<hex of the signed advert packet>" (node null = this node itself)
      async exportContact(node) {
        const f = await cmd(node ? Uint8Array.of(CMD.EXPORT_CONTACT, ...keyOf(node)) : Uint8Array.of(CMD.EXPORT_CONTACT), [RESP.EXPORT_CONTACT]);
        return `meshcore://${hex(f.subarray(1))}`;
      },
      // the node signs bytes with its own identity key (companion SIGN_START / SIGN_DATA / SIGN_FINISH; plain Ed25519,
      // checked against MeshCore's companion_radio source 2026-10-22) -> 64-byte signature. For Golden Packet hand-offs
      // (js/gold-token.js): signed by the RADIO, so a token is tied to a node, not to a browser.
      async sign(bytes) {
        const b = Uint8Array.from(bytes || []);
        if (!b.length || b.length > 8192) throw new Error('1 to 8192 bytes to sign');
        await cmd(Uint8Array.of(CMD.SIGN_START), [RESP.SIGN_START]);
        for (let i = 0; i < b.length; i += MAX_FRAME - 8) await cmd(Uint8Array.of(CMD.SIGN_DATA, ...b.subarray(i, i + MAX_FRAME - 8)), [RESP.OK]);
        const f = await cmd(Uint8Array.of(CMD.SIGN_FINISH), [RESP.SIGNATURE]);
        if (f.length < 65) throw new Error('the node sent a short signature');
        return f.slice(1, 65);
      },
      selfKey: () => myKey ? hex(myKey) : null,
      // a meshcore:// link (or bare hex) -> the node adds that contact (the advert is signed: a link can't fake a key)
      async importContact(text) {
        const h = String(text || '').trim().replace(/^meshcore:\/\//i, '').replace(/\s+/g, '');
        if (!/^([0-9a-f]{2}){100,}$/i.test(h)) throw new Error('that is not a MeshCore contact link (meshcore://...)');
        const b = unhex(h), pkt = decodeRaw(b);
        if (!pkt || !pkt.advert) throw new Error('that link holds no contact advert');
        if (b.length > MAX_FRAME - 1) throw new Error('that contact is too big for the node');
        const key = String(pkt.advert.key).toLowerCase(), byKey = () => quietRead(key);
        await cmd(Uint8Array.of(CMD.IMPORT_CONTACT, ...b), [RESP.OK]);
        // With auto-add off (manual contacts) the node only pushes the advert (NEW_ADVERT) and saves nothing: the app has
        // to write it with ADD_UPDATE_CONTACT, from that pushed record (bench, 2026-10-23: "imported" yet DMs said not found).
        if (!(await byKey().then(() => true, () => false))) {
          for (let i = 0; i < 30 && !raw.get(key); i++) await new Promise(r => setTimeout(r, 100));
          const r = raw.get(key);
          if (!r || r.length < 136) throw new Error('the node took the link but did not add the contact');
          const p = new Uint8Array(Math.min(r.length, 148)); p.set(r.subarray(0, p.length)); p[0] = CMD.ADD_UPDATE_CONTACT;
          await cmd(p, [RESP.OK]);
          await byKey().catch(() => { throw new Error('the node did not save the contact'); });
        }
        return { name: pkt.advert.name || '', key };
      },
      // a contact from the official app's QR code (meshcore://contact/add?name=&public_key=&type=, js/meshqr.js): just
      // key, type and name, no signed advert, so it's written with ADD_UPDATE_CONTACT (no route yet: out_path_len 0xff),
      // as the app does. A contact the node already has is left alone (its route and position stay). direct: true (an
      // in-person QR swap: they are in range) writes a zero-hop route instead, so the first DM isn't flooded.
      async addContact({ key, type, name, direct } = {}) {
        key = String(key || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('a contact needs a 64-digit public key');
        const byKey = () => quietRead(key);
        const had = await byKey().then(f => parseContact(f), () => null);
        if (had) return { name: had.name || '', key, already: true };
        const p = new Uint8Array(144); p[0] = CMD.ADD_UPDATE_CONTACT; p.set(unhex(key), 1); p[33] = type | 0; p[35] = direct ? 0 : 0xff;
        p.set(nameBytes(name), 100);
        await cmd(p, [RESP.OK]);
        await byKey().catch(() => { throw new Error('the node did not save the contact'); });
        return { name: String(name || ''), key };
      },
      // ---- Ham Contacts (js/hc-service.js; companion MyMesh.cpp v1.18.0, checked 2026-10-24)
      // the node's contact table size: DEVICE_INFO [2] = MAX_CONTACTS / 2 (350 on the common boards' builds, 100 when a
      // build doesn't set it), null before DEVICE_INFO
      maxContacts: () => maxContacts,
      // every contact the node holds, read afresh (GET_CONTACTS since 0) -> [node]
      async listContacts() {
        const got = []; collect = got; quietAll = true;
        try { await cmd(Uint8Array.of(CMD.GET_CONTACTS), [RESP.END_OF_CONTACTS], 60000); } finally { if (collect === got) collect = null; quietAll = false; }
        const seen = new Set(); return got.filter(n => !seen.has(n.key) && seen.add(n.key));
      },
      // is that key in the node's contacts? (GET_CONTACT_BY_KEY: ERR 2 = no)
      hasContact: key => quietRead(String(key || '').toLowerCase()).then(() => true, e => { if (/not found/.test(e.message)) return false; throw e; }),
      // Auto-add: SELF_INFO's manual_add_contacts bit 0 (0 = every advert heard is saved, the default) and, when that is
      // off, GET_AUTOADD_CONFIG's per-type bits (0x02 companion, 0x04 repeater, 0x08 room, 0x10 sensor; 0x01 = overwrite
      // the oldest non-favourite when full) + max hops (0 = any, 1 = direct only, N = up to N-1 hops).
      // -> { all, bits (null on firmware without it), maxHops }
      async autoAdd() {
        let bits = null, maxHops = null;
        try { const f = await cmd(Uint8Array.of(CMD.GET_AUTOADD_CONFIG), [RESP.AUTOADD_CONFIG]); bits = f[1]; maxHops = f[2]; } catch { /* older firmware */ }
        return { all: manualAdd == null ? null : !(manualAdd & 1), bits, maxHops };
      },
      // { all?, bits?, maxHops? }: all = SET_OTHER_PARAMS with ONE byte (so telemetry / location settings stay as they are;
      // fw 1.18 reads frame[2..] only when the frame is longer)
      async setAutoAdd(o = {}) {
        if (o.all != null) { const v = ((manualAdd || 0) & ~1) | (o.all ? 0 : 1); await cmd(Uint8Array.of(CMD.SET_OTHER_PARAMS, v), [RESP.OK]); manualAdd = v; }
        if (o.bits != null) await cmd(Uint8Array.of(CMD.SET_AUTOADD_CONFIG, o.bits & 0x1f, Math.max(0, Math.min(64, o.maxHops | 0))), [RESP.OK]);
      },
      // a contact's flags (ContactInfo.h): 0x01 favourite (never overwritten when the table is full), 0x02 base telemetry
      // allowed to them (what lets THEM run a path discovery to us, when our base mode is 1), 0x04 location, 0x08
      // environment, 0x10 remote CLI. Written back with only that bit changed.
      async setContactFlag(node, bit, on) {
        const r = node && raw.get(node.key); if (!r || r.length < 136) throw new Error('Kelly has not read that contact from the node yet');
        const p = new Uint8Array(Math.min(r.length, 148)); p.set(r.subarray(0, p.length)); p[0] = CMD.ADD_UPDATE_CONTACT; p[34] = on ? p[34] | bit : p[34] & ~bit;
        await cmd(p, [RESP.OK]);
        await quietRead(node.key).catch(() => {});
      },
      setFavourite(node, on) { return this.setContactFlag(node, 0x01, on); },
      // who may read this node's telemetry (SELF_INFO [46] = env << 4 | loc << 2 | base; each 0 deny -- the default --,
      // 1 = contacts whose flag allows it, 2 = anyone). A companion answers a path discovery only with base allowed.
      telemetryModes: () => (telemModes == null ? null : { base: telemModes & 3, loc: (telemModes >> 2) & 3, env: (telemModes >> 4) & 3 }),
      // base only; location / environment and manual-add are sent back as they were (SET_OTHER_PARAMS, 3 bytes)
      async setTelemetryBase(mode) {
        if (telemModes == null || manualAdd == null) throw new Error('Kelly has not read this node\'s settings yet');
        const v = (telemModes & ~3) | (mode & 3);
        await cmd(Uint8Array.of(CMD.SET_OTHER_PARAMS, manualAdd, v), [RESP.OK]); telemModes = v;
      },
      // save a station the node heard advertise but did not keep (auto-add off: PUSH_NEW_ADVERT only), from that pushed
      // record -- its name, type, position and the route its advert came by, as the official app does
      async addHeard(key) {
        key = String(key || '').toLowerCase();
        const byKey = () => quietRead(key);
        if (await byKey().then(() => true, () => false)) return { key, already: true };
        const r = raw.get(key); if (!r || r.length < 136) throw new Error('the node has not passed on an advert from that station since Kelly connected -- use their contact card, or ask them to advertise');
        const p = new Uint8Array(Math.min(r.length, 148)); p.set(r.subarray(0, p.length)); p[0] = CMD.ADD_UPDATE_CONTACT;
        await cmd(p, [RESP.OK]);
        await byKey().catch(() => { throw new Error('the node did not save the contact'); });
        return { key, name: cstr(r, 100, 32) };
      },
      // this node's advert name (max 31 bytes); SELF_INFO is read again so the page shows it
      async setName(name) {
        const b = nameBytes(name);
        if (!b.length) throw new Error('a name is needed');
        await cmd(Uint8Array.of(CMD.SET_ADVERT_NAME, ...b), [RESP.OK]);
        const app = new Uint8Array(8 + 5); app[0] = CMD.APP_START; app[1] = 3; app.set(enc.encode('Kelly'), 8);
        await cmd(app, [RESP.SELF_INFO]).catch(() => {});
      },
      // rejects if the node doesn't answer: mesh.js counts the misses and calls it stale
      heartbeat() { return cmd(Uint8Array.of(CMD.GET_BATT_AND_STORAGE), [RESP.BATT_AND_STORAGE]); },
      // a channel message from "Name": the contact of that name, else a name-only node
      senderNum: name => nameNum(name),
      maxText: (target) => target.dm ? MAX_TEXT : Math.max(40, MAX_TEXT - 2 - enc.encode(myName).length),
    };
  }

  const DRIVER = {
    id: 'meshcore', label: 'MeshCore', baud: 115200, ble: BLE, bleName: 'MeshCore-',
    caps: { trace: true, traceAny: false, react: false, askPos: false, dm: true, channels: true, sharePos: true, paths: true, repeaters: true, contacts: true },
    hint: 'A MeshCore node running COMPANION firmware (USB or BLE build to match the link). Bluetooth asks for the node\'s PIN: on its screen, else 123456.',
    Framer, Session, nameNum, shortOf, looksHam,
    wrap: (payload, transport) => transport === 'ble' ? payload : frame(payload),   // USB / bridge: '<' len u16
  };
  root.KellyMeshCore = { DRIVER, CMD, RESP, PUSH, PT, parseContact, parseMsg, decodeRaw, readPath, Framer, frame, nameNum, shortOf,
    parseLogin, parseRepeaterStats, parseLpp, parseNeighbours, parseStats, parseTrace, parseRoomPost };
})(typeof window !== 'undefined' ? window : globalThis);
