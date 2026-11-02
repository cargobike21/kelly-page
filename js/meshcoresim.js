/* Kelly Page -- a simulated MeshCore companion node, for the LoRa Mesh page's demo (index.html#mesh-demo with the
 * MeshCore device) and for tests/meshcore-tests.html. Nothing is transmitted.
 *
 * It answers js/meshcore.js's Session at FRAME level, byte for byte as companion firmware v1.18.0 does
 * (examples/companion_radio/MyMesh.cpp; layouts as in meshcore.js's own comments), so the real driver code runs
 * unchanged. The same world and faults are in bridge/kelly_mesh_sim.py (the bridge's --mesh-sim) -- keep in step.
 *
 * The world: a home companion ("VK4XXX Kelly Sim") near Ipswich, the veranda Solar Node repeater ("VK4XXX Veranda
 * Rptr", admin password "password" as shipped) that answers login / status / telemetry, a few repeaters and
 * companions around SEQ, a creek sensor, and channels Public + P25X. Every far station is reached through the veranda
 * repeater, so the path map has real hop chains.
 *
 * Repeater management -- as a real SenseCAP Solar repeater (fw 1.18.0) answered on the bench, 2026-10-21:
 *   CMD_SEND_LOGIN 26 [key 32][password]           -> SENT (tag = their key's first 4 bytes), then PUSH 0x85
 *                                                     [perms][prefix 6][their clock u32][acl perms][fw level 2].
 *                                                     A wrong password gets NO answer (no 0x86 from 1.18 repeaters).
 *   CMD_SEND_STATUS_REQ 27 [key 32]                -> SENT, then PUSH 0x87 [0][prefix 6][RepeaterStats, 60 bytes]
 *   CMD_SEND_TELEMETRY_REQ 39 [0 0 0][key 32]      -> SENT, then PUSH 0x8B [0][prefix 6][LPP voltage + temperature, 4 zero bytes]
 *   CMD_SEND_BINARY_REQ 50 [key 32][6 = neighbours ...] -> SENT, then PUSH 0x8C [0][tag 4][total u16][n u16][prefix 6, ago u32, snr*4]
 *   SEND_TXT_MSG txt_type 1 (CLI, admin only)      -> a type-1 contact message back through SYNC (MSG_WAITING first)
 *   CMD_GET_STATS 56 [0 core | 1 radio | 2 packets] -> RESP 24
 *   CMD_SEND_TRACE_PATH 36 [tag][auth][flags][hashes] -> SENT (tag), then PUSH 0x89 with an SNR per hop -- if every hash
 *   is a repeater and each hop can hear the last (in this world: on one another's via chains)
 * Channels: 8 slots (DEVICE_INFO [3]). Slot 0 Public with MeshCore's real Public secret (channel hash 0x11), slot 1 P25X
 * with a made-up private secret (hash 0x5a), the rest empty. GET_CHANNEL 31 [idx] -> CHANNEL_INFO [18][idx][name 32]
 * [secret 16] for idx 0..7 (an empty slot: no name, zero secret), ERR 2 past the end. CMD_SET_CHANNEL 32 [idx][name 32]
 * [secret 16] -> OK and stored (GET_CHANNEL returns it), ERR 2 for idx out of range, ERR 1 if shorter than 50 bytes (as
 * companion MyMesh.cpp, 16-byte secrets only). bridge/kelly_mesh_sim.py does the same.
 * The repeater's clock starts at 15 May 2024 (as the real one does after power-off) until "time N" sets it.
 * MeshPRS (MeshPRS/spec): VK4ZB Bravo Heltec beacons a MeshPRS Position frame as VK4ZB-7 (GRP_DATA type 0xFF4D, channel
 * #meshprs, hash 0xBA) every 5 min in the demo. The node hands it on as RESP 27 [27][snr*4][0][0][ch][path_len][type u16]
 * [len][blob] (+ MSG_WAITING) only when a slot holds the #meshprs key, as companion MyMesh.cpp onChannelDataRecv does.
 * CMD_SEND_CHANNEL_DATA 62 -> OK (ERR 6 short / type 0 / over 165 bytes, ERR 2 no such channel), kept in state().sentData;
 * CMD_GET_DEFAULT_FLOOD_SCOPE 64 -> [28] (none; opts.scope = [name, key hex] for one); CMD_SET_FLOOD_SCOPE_KEY 54 -> OK
 * ([54][1] = unscoped, state().unscoped). bridge/kelly_mesh_sim.py does the same.
 *
 * Room server "Ipswich Chat Room" (as simple_room_server v1.18.0; layouts in js/meshcore.js's header): admin password
 * "roomadmin", guest password "hello" (read + post), blank = read only. Its clock is right. It holds a few posts (one
 * from an author the node has no contact for) and, once you're logged in, pushes those newer than this node's "sync
 * since" as type-2 contact messages [ts][author prefix 4][text], one every ~1.2 s. A DM to it is a post: ACKed (not for
 * a read-only guest), kept, never echoed back. Binary request 2 (keep-alive) sent direct re-sends posts newer than `since`.
 * In the demo (auto) another station posts to it every few minutes.
 *
 * KellyMeshCoreSim.create(opts) -> sim
 *   opts: { auto: true = background traffic (adverts, channel chat, DMs to us), seed, sched(fn, ms) -> cancel,
 *           faults: { ackLoss 0..1, ackLossFirst n (the first n DM ACKs are lost, then all arrive -- retries),
 *           ackLateFirst n (the first n DM ACKs arrive ackLateMs late, default 25 s -- after Kelly's wait, as on long SEQ
 *           routes; checked before ackLossFirst, so both together = a late first ACK, the retries' lost),
 *           hangAfter ms (stop answering), slow ms (extra reply delay), garble 0..1 (junk
 *           bytes before a frame), full (the contact table is full: each new advert evicts the oldest, PUSH 0x8F),
 *           loginFail (the repeater refuses every password) } }
 *   a station with .moved = true (set it through sim.world): login / status by a stored route get no answer, a flood does
 *   sim.onFrame(cb)  cb(frame Uint8Array) for each frame the node sends (no '>' header)
 *   sim.onJunk(cb)   cb(bytes) for faults.garble's junk
 *   sim.write(payload)  a command from the app (no '<' header)
 *   sim.inject.{advert(i), channel(i, text, ch), dm(i, text), mprs(i, blob?)}  make a station do something now (tests,
 *                    demo buttons); mprs without a blob = that station's next Position frame
 *   sim.world, sim.state()  for tests
 *   sim.stop()
 */
(function (root) {
  'use strict';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const now = () => Math.floor(Date.now() / 1000);
  const le16 = v => [v & 255, v >>> 8 & 255];
  const le32 = v => [v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255];
  const i8 = v => (v + 256) & 255;
  const str = (s, n) => { const b = new Uint8Array(n); b.set(enc.encode(s).subarray(0, n)); return [...b]; };
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  // a station's 32-byte "public key", made from its name (FNV-1a stream) -- the same in kelly_mesh_sim.py
  function keyOf(name) {
    const out = new Uint8Array(32); let h = 0x811c9dc5;
    for (let i = 0; i < 32; i++) { for (const c of enc.encode(`${name}#${i}`)) h = Math.imul(h ^ c, 0x01000193) >>> 0; out[i] = h & 255; }
    return out;
  }
  function rng(seed) { let s = (seed >>> 0) || 0x2545f491; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  // type: 1 companion, 2 repeater, 3 room, 4 sensor. via: the repeaters (by index) a packet from them passes, nearest
  // them first -- flood path order. snr/rssi: as heard at our node (from the last hop). bot: answers a DM.
  const SELF = { name: 'VK4XXX Kelly Sim', lat: -27.6255, lon: 152.7663, freq: 923125, bw: 62500, sf: 8, cr: 5, tx: 22 };
  const WORLD = [
    { name: 'VK4XXX Veranda Rptr', type: 2, lat: -27.6257, lon: 152.7666, via: [], snr: 11.5, rssi: -48, admin: 'password', guest: '' },
    { name: 'VK4ZB Bravo Heltec', type: 1, lat: -27.6275, lon: 152.7644, via: [0], snr: 7.25, rssi: -71, bot: true, mprs: 'VK4ZB-7' },
    { name: 'Mt Coot-tha Rptr', type: 2, lat: -27.4762, lon: 152.9520, via: [0], snr: 3.5, rssi: -96 },
    { name: 'VK4ZR Romeo', type: 1, lat: -27.5560, lon: 152.6870, via: [2, 0], snr: 5.0, rssi: -88, bot: true },
    { name: 'Springbrook Rptr', type: 2, lat: -28.2010, lon: 153.2720, via: [2, 0], snr: -4.25, rssi: -112 },
    { name: 'Toowoomba Rptr', type: 2, lat: -27.5640, lon: 151.9540, via: [0], snr: -7.5, rssi: -118 },
    { name: 'VK4ZQ Bunya', type: 1, lat: -26.8740, lon: 151.5960, via: [5, 0], snr: 1.25, rssi: -101 },
    { name: 'Brisbane Bob', type: 1, lat: -27.4700, lon: 153.0230, via: [2, 0], snr: 2.0, rssi: -99, hashSize: 1 },   // on 1-byte path hashes: the hash size check's demo
    { name: 'Bremer Creek Sensor', type: 4, lat: -27.6405, lon: 152.7363, via: [0], snr: 4.5, rssi: -92 },
    { name: 'Ipswich Chat Room', type: 3, lat: -27.6245, lon: 152.7653, via: [0], snr: 6.0, rssi: -84, admin: 'roomadmin', guest: 'hello', readOnly: true },
  ];
  // the room's posts at start: [author name (the room itself = its notices; one with no contact), seconds ago, text]
  const ROOM_POSTS = [['Ipswich Chat Room', 7200, 'Welcome! Keep posts short and friendly. Guests: password hello'],
    ['VK4ZB Bravo Heltec', 5400, 'Anyone tried 2-byte path hashes yet? Working well here.'], ['VK4ZR Romeo', 3600, 'Mt Coot-tha repeater back up after the storm.'],
    ['Gold Coast Gary', 2400, 'First post from the Coast, hello Ipswich'], ['Brisbane Bob', 1200, 'Testing from the CBD, 2 hops via Coot-tha.'],
    ['VK4ZQ Bunya', 600, 'Bunya node is on solar now.']];
  const CHANNELS = ['Public', 'P25X'];
  const CHANNEL_SECRETS = ['8b3387e9c5cdea6ac9e5edbaa115cd72', '725c27dec10b06cb92860845704102cc'];   // Public (real); P25X (sim only)
  const MAX_CH = 8;
  // MeshPRS: the #meshprs key (sha256('#meshprs')[0:16]), the data type, and a small frame encoder (spec §4.1, §5.1)
  const MPRS_KEY = '650fa1fd5d2c0bc01449a964a130ea1c', MPRS_TYPE = 0xff4d, B40 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.';
  const call40 = c => { let v = 0n; for (const ch of [...c].reverse()) v = v * 40n + BigInt(B40.indexOf(ch)); return Array.from({ length: 6 }, (_, i) => Number((v >> BigInt(8 * (5 - i))) & 255n)); };
  const deg24 = (x, span) => { const v = Math.floor(Math.abs(x) * 2 ** 23 / span + 0.5); return x >= 0 ? Math.min(v, 2 ** 23 - 1) : -Math.min(v, 2 ** 23); };
  const i24 = v => [v & 255, v >> 8 & 255, v >> 16 & 255];
  const CHAT = ['Morning all, anyone about?', 'Testing from the car, 5/9 here', 'Hello from Mt Coot-tha', 'QRV on the mesh tonight',
    'Range test 3, can anyone hear?', 'Good signal into Ipswich today', 'Back online after a firmware update', 'Who\'s on this evening?'];

  function create(opts = {}) {
    const o = Object.assign({ auto: false, seed: 1, faults: {}, pathHashMode: 1 }, opts), F = Object.assign({ ackLoss: 0, ackLossFirst: 0, ackLateFirst: 0, ackLateMs: 25000, hangAfter: 0, slow: 0, garble: 0, full: false, loginFail: false }, o.faults);
    const rand = rng(o.seed);
    const timers = new Set();
    const sched = o.sched || ((fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return () => { clearTimeout(t); timers.delete(t); }; });
    let frameCb = () => {}, junkCb = () => {}, stopped = false;
    const born = Date.now();
    // with TweetNaCl on the page, this node's identity is a REAL Ed25519 key pair (seeded from its name, so stable): its
    // SIGN_* answers then verify like a real node's (Golden Packet hand-offs). Without it, the name hash as before.
    const NACL = root.nacl && root.nacl.sign ? root.nacl : null, idKeys = NACL ? NACL.sign.keyPair.fromSeed(Uint8Array.from(keyOf(SELF.name))) : null;
    const me = { ...SELF, key: idKeys ? Array.from(idKeys.publicKey) : keyOf(SELF.name), advLat: SELF.lat, advLon: SELF.lon };
    let signBuf = null;
    const unhexs = h => h.match(/../g).map(x => parseInt(x, 16));
    const chans = Array.from({ length: MAX_CH }, (_, i) => ({ name: CHANNELS[i] || '', secret: CHANNEL_SECRETS[i] ? unhexs(CHANNEL_SECRETS[i]) : new Array(16).fill(0) }));
    let manualAdd = 0, autoBits = 0x1e, autoHops = 0, telem = 0;   // SELF_INFO [47] + GET_AUTOADD_CONFIG: auto-add every advert (the firmware default)
    const TYPE_BIT = { 1: 0x02, 2: 0x04, 3: 0x08, 4: 0x10 };
    const st = WORLD.map((w, i) => ({ ...w, i, key: keyOf(w.name), lastAdvert: now() - 600 - i * 97, lastmod: now() - 300 - i * 61, outPath: null, known: true }));
    const queue = [];          // messages waiting for SYNC_NEXT_MESSAGE
    const sentData = []; let unscoped = false;   // CMD 62 sends (tests); CMD 54 [1]
    const counters = { recv: 0, sent: 0, sentFlood: 0, sentDirect: 0, recvFlood: 0, recvDirect: 0, recvErrors: 0, txAir: 0, rxAir: 0 };
    // the room server: posts (ts by its clock, author = 4-byte key prefix), our node's "sync since" for it (kept with the
    // contact, as the companion does), the room's own idea of it, and our ACL permissions once logged in
    st.filter(s => s.type === 3).forEach(s => { s.posts = ROOM_POSTS.map(([a, ago, text]) => ({ ts: now() - ago, author: [...keyOf(a).subarray(0, 4)], text })); s.syncSince = 0; s.roomSince = 0; s.perms = null; });
    let loggedIn = new Set(), lastRx = { snr: 0, rssi: -120 };
    // repeater clocks: 15 May 2024 + uptime, as after a real power-off, until "time N" sets one (index -> offset s)
    const clockOff = new Map(), BOOT_CLOCK = 1715770620;
    const clockOf = s => clockOff.has(s.i) ? now() + clockOff.get(s.i) : BOOT_CLOCK + Math.floor((Date.now() - born) / 1000);
    st.forEach(s => { if (s.type === 3) clockOff.set(s.i, 0); });   // the room server's clock was set by its owner
    const two = x => String(x).padStart(2, '0');
    const clockTxt = t => { const d = new Date(t * 1000); return two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()) + ' - ' + d.getUTCDate() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCFullYear() + ' UTC'; };
    const hashOf = s => s.key[0];
    const pathOf = s => s.via.map(j => hashOf(st[j]));   // flood path as collected: nearest-to-sender repeater first
    const hopsOf = s => s.via.length;
    // what a flood from s carries on air: path_len (top 2 bits = hash size - 1) + each repeater's first hashSize key bytes.
    // Stations send 2-byte hashes as Brisbane/SEQ asks; one (Brisbane Bob) is still on 1-byte (src/Packet.h, Mesh::sendFlood)
    const airPath = s => { const sz = s.hashSize || 2; return [((sz - 1) << 6) | s.via.length, ...s.via.flatMap(j => [...st[j].key.subarray(0, sz)])]; };

    const out = (f, ms = 0) => {
      const go = () => {
        if (stopped) return;
        if (F.garble && rand() < F.garble) junkCb(enc.encode('ets Jul 29 2019 12:21:46\r\n'));
        frameCb(Uint8Array.from(f));
      };
      const d = ms + (F.slow || 0);
      if (d > 0) sched(go, d); else go();
    };
    const hung = () => F.hangAfter > 0 && Date.now() - born >= F.hangAfter;
    // a station that has moved (s.moved, set by a test through sim.world): the route stored to it no longer arrives,
    // a flood still does -- a backpack node carried to work, its old "direct" route left behind (2026-10-29)
    const stale = s => !!(s.moved && s.outPath);
    const findKey = (b, o2, n = 32) => { const h = hex(b.subarray(o2, o2 + n)); return st.find(s => s.known && hex(s.key.subarray(0, n)) === h); };

    // ---- frames the node sends
    function contactFrame(s, code = 3) {
      const op = new Array(64).fill(0), p = s.outPath || null;
      if (p) p.forEach((b, i) => { op[i] = b; });
      return [code, ...s.key, s.type, s.fav ? 1 : 0, p ? p.length : 0xff, ...op, ...str(s.name, 32), ...le32(s.lastAdvert), ...le32(Math.round(s.lat * 1e6)), ...le32(Math.round(s.lon * 1e6)), ...le32(s.lastmod)];
    }
    // the raw advert as Packet::writeTo lays it out: header (flood | ADVERT<<2), path_len, path, key, ts, sig, flags, lat, lon, name
    function advertPacket(s) {
      const flags = 0x80 | 0x10 | s.type;
      return [0x01 | (4 << 2), ...airPath(s), ...s.key, ...le32(s.lastAdvert), ...new Array(64).fill(0), flags, ...le32(Math.round(s.lat * 1e6)), ...le32(Math.round(s.lon * 1e6)), ...enc.encode(s.name)];
    }
    const logRx = (s, pkt) => {
      counters.recv++; counters.recvFlood++; counters.rxAir += 1; lastRx = { snr: s.snr, rssi: s.rssi };
      return [0x88, i8(Math.round(s.snr * 4)), i8(s.rssi), ...pkt];
    };
    function heardAdvert(s) {
      s.lastAdvert = now(); s.lastmod = now();
      out(logRx(s, advertPacket(s)));
      if (!s.known && (manualAdd & 1) && !(autoBits & (TYPE_BIT[s.type] || 0))) { out(contactFrame(s, 0x8a)); return; }   // manual add: passed on, not kept
      if (!s.known) {
        if (F.full) {   // table full: the node overwrites its oldest contact (PUSH 0x8F CONTACT_DELETED) to make room
          const old = st.filter(x => x.known && x !== s).sort((a, b) => a.lastmod - b.lastmod)[0];
          if (old) { old.known = false; out([0x8f, ...old.key]); }
        }
        s.known = true; out(contactFrame(s, 0x8a));
      } else out([0x80, ...s.key]);
    }
    function heardChannel(s, text, ch = 0) {
      const body = enc.encode(`${s.name}: ${text}`);
      out(logRx(s, [0x01 | (5 << 2), ...airPath(s), ch === 0 ? 0x11 : 0x5a, ...new Array(Math.min(body.length + 2, 60)).fill(0)]));
      queue.push([17, i8(Math.round(s.snr * 4)), 0, 0, ch, hopsOf(s), 0, ...le32(now()), ...body]);
      out([0x83]);
    }
    function heardDm(s, text) {
      out(logRx(s, [0x01 | (2 << 2), ...airPath(s), me.key[0], s.key[0], ...new Array(20).fill(0)]));
      queue.push([16, i8(Math.round(s.snr * 4)), 0, 0, ...s.key.subarray(0, 6), hopsOf(s), 0, ...le32(now()), ...enc.encode(text)]);
      out([0x83]);
    }
    // ---- MeshPRS: a GRP_DATA heard; handed on as RESP 27 only if a slot holds the channel's key
    function heardData(s, blob, type = MPRS_TYPE) {
      out(logRx(s, [0x01 | (6 << 2), ...airPath(s), 0xba, 0, 0, ...new Array(16 * Math.ceil((blob.length + 3) / 16)).fill(0)]));
      const ch = chans.findIndex(c => c.name && hex(c.secret) === MPRS_KEY);
      if (ch < 0) return;
      queue.push([27, i8(Math.round(s.snr * 4)), 0, 0, ch, airPath(s)[0], type & 255, type >> 8, blob.length, ...blob]);
      out([0x83]);
    }
    // the station's next Position frame: K set, its key prefix, '/[' walker, a comment; seq per station
    function mprsPosition(s) {
      s.mprsSeq = ((s.mprsSeq === undefined ? s.i * 37 : s.mprsSeq) + 1) & 255;
      return [0x50, 0x00, s.mprsSeq, ...call40(s.mprs), ...s.key.subarray(0, 4), ...i24(deg24(s.lat, 90)), ...i24(deg24(s.lon, 180)), 0x2f, 0x5b, 0, ...enc.encode('Kelly sim tracker')];
    }
    // ---- the room server (simple_room_server's loop(): one post per client at a time, the next after its ACK, ~1.2 s)
    const myAuthor = () => hex(me.key.slice(0, 4));
    function roomPush(s, delay = 2000) {
      if (s.pushing || !loggedIn.has(s.i)) return;
      s.pushing = true;
      const step = () => {
        const p = loggedIn.has(s.i) && !stopped ? s.posts.find(x => x.ts > s.roomSince && hex(x.author) !== myAuthor()) : null;
        if (!p) { s.pushing = false; return; }
        s.roomSince = p.ts; s.syncSince = Math.max(s.syncSince, p.ts);   // our node ACKs it and keeps the newest time with the contact
        queue.push([16, i8(Math.round(s.snr * 4)), 0, 0, ...s.key.subarray(0, 6), s.roomDirect ? 0xff : hopsOf(s), 2, ...le32(p.ts), ...p.author, ...enc.encode(p.text)]);
        s.roomDirect = true;   // our ACK's path-return taught it the route: later pushes come direct
        out([0x83]);
        sched(step, 1200);
      };
      sched(step, delay + 600 * hopsOf(s));
    }
    function roomAdd(s, author, text) {
      const last = s.posts.length ? s.posts[s.posts.length - 1].ts : 0;
      s.posts.push({ ts: Math.max(clockOf(s), last + 1), author: [...author].slice(0, 4), text: String(text).slice(0, 151) });
      if (s.posts.length > 32) s.posts.shift();   // MAX_UNSYNCED_POSTS, a cyclic queue in RAM
      roomPush(s);
    }

    // ---- RepeaterStats (simple_repeater MyMesh.h) for STATUS_RESPONSE
    function repeaterStats(s) {
      const up = Math.floor((Date.now() - born) / 1000) + 86400 * 3 + 3600 * 7;
      return [...le16(4105), ...le16(0), ...le16(-118 & 0xffff), ...le16(-71 & 0xffff), ...le32(18234), ...le32(4411), ...le32(1873), ...le32(up),
        ...le32(3908), ...le32(503), ...le32(15520), ...le32(2714), ...le16(0), ...le16(Math.round(s.snr * 4) & 0xffff), ...le16(37), ...le16(1192), ...le32(9120),
        ...le32(52), 0, 0, 0, 0];   // fw 1.18: + n_recv_errors + 4 bytes we don't know (zero on the bench)
    }
    // CayenneLPP: channel, type, value -- voltage (116, 0.01 V), temperature (103, 0.1 C), then the firmware's zero padding.
    // No GPS: a repeater with a fixed position and its GPS off sends none (bench).
    function telemetry(s) {
      const t = 245 + Math.round(rand() * 30), v = 400 + Math.round(rand() * 16);
      return [1, 116, v >> 8 & 255, v & 255, 1, 103, t >> 8 & 255, t & 255, 0, 0, 0, 0];
    }
    // the repeaters a repeater hears directly (its zero-hop neighbours): in this world, those one hop out through it
    const neighboursOf = s => st.filter(x => x.type === 2 && x.via.length === 1 && x.via[0] === s.i);
    // a repeater's CLI (CommonCLI.cpp + simple_repeater, the answers the bench repeater gave)
    function cliAnswer(s, cmd) {
      if (cmd === 'ver') return 'v1.18.0-sim (Build: 15-Oct-2026)';
      if (cmd === 'clock') return clockTxt(clockOf(s));
      if (cmd.startsWith('time ')) {
        const t = parseInt(cmd.slice(5), 10) >>> 0;
        if (t > clockOf(s)) { clockOff.set(s.i, t - now()); return 'OK - clock set: ' + clockTxt(t); }
        return '(ERR: clock cannot go backwards)';
      }
      if (cmd === 'get name') return '> ' + s.name;
      if (cmd === 'get radio') return '> ' + (me.freq / 1000).toFixed(3) + ',' + me.bw / 1000 + ',' + me.sf + ',' + me.cr;
      if (cmd === 'get tx') return '> 22';
      if (cmd === 'get role') return '> repeater';
      if (cmd === 'neighbors') { const n = neighboursOf(s); return n.length ? n.map(x => hex(x.key.subarray(0, 4)) + ':' + (300 + x.i * 60) + ':' + Math.round(x.snr * 4)).join('\n') : '-none-'; }
      if (cmd === 'advert') return 'OK - Advert sent';
      if (cmd === 'reboot') { sched(() => loggedIn.delete(s.i), 100); return ''; }   // the real one reboots without answering
      if (cmd.startsWith('get ')) return '??: ' + cmd.slice(4);
      return 'Unknown command';
    }

    // ---- commands from the app
    function write(p) {
      if (stopped || !p || !p.length) return;
      if (hung()) return;   // a stuck node: the port is open, nothing comes back
      const c = p[0];
      const ok = () => out([0]), err = e => out([1, e]);
      const sent = (flood, tag, ms) => out([6, flood ? 1 : 0, ...le32(tag), ...le32(ms)]);
      switch (c) {
        // DEVICE_INFO as v1.18.0 sends it: 82 bytes, [80] client repeat, [81] path_hash_mode (companion MyMesh.cpp:1074)
        case 22: out([13, 8, 175, 8, ...le32(123456), ...str('15 Oct 2026', 12), ...str('Kelly MeshCore simulator', 40), ...str('v1.18.0-sim', 20), 0, o.pathHashMode]); break;
        case 38: if (p.length < 2) { err(6); break; } manualAdd = p[1]; if (p.length >= 3) telem = p[2] & 0x3f; ok(); break;   // CMD_SET_OTHER_PARAMS [manual_add_contacts][telemetry modes][..] (the rest ignored here)
        case 58: autoBits = p[1] & 0x1f; if (p.length >= 3) autoHops = Math.min(p[2], 64); ok(); break;   // CMD_SET_AUTOADD_CONFIG
        case 59: out([25, autoBits, autoHops]); break;   // CMD_GET_AUTOADD_CONFIG
        case 61: if (p[1] === 0 && p.length >= 3 && p[2] < 3) { o.pathHashMode = p[2]; out([0]); } else err(6); break;   // CMD_SET_PATH_HASH_MODE
        case 1: out([5, 1, me.tx, 30, ...me.key, ...le32(Math.round(me.advLat * 1e6)), ...le32(Math.round(me.advLon * 1e6)), 0, 0, telem, manualAdd,
          ...le32(me.freq), ...le32(me.bw), me.sf, me.cr, ...enc.encode(me.name)]); break;
        case 6: ok(); break;
        case 5: out([9, ...le32(now())]); break;
        case 4: {
          const since = p.length >= 5 ? u32(p, 1) : 0, list = st.filter(s => s.known && s.lastmod > since);
          out([2, ...le32(list.length)]); list.forEach(s => out(contactFrame(s)));
          out([4, ...le32(Math.max(0, ...st.map(s => s.lastmod)))]);
          break;
        }
        case 31: if (p.length > 1 && p[1] < MAX_CH) out([18, p[1], ...str(chans[p[1]].name, 32), ...chans[p[1]].secret]); else err(2); break;
        // CMD_SET_CHANNEL [32][idx][name 32][secret 16] (companion MyMesh.cpp; a 32-byte secret is not supported)
        case 32: if (p.length < 50) { err(1); break; } if (p[1] >= MAX_CH) { err(2); break; }
          { const nb = p.subarray(2, 34), z = nb.indexOf(0); chans[p[1]] = { name: new TextDecoder().decode(z < 0 ? nb : nb.subarray(0, z)), secret: Array.from(p.subarray(34, 50)) }; ok(); } break;
        case 20: out([12, ...le16(4012), ...le32(96), ...le32(1984)]); break;
        // CMD_SEND_CHANNEL_DATA [62][ch][path_len][path][data_type u16][data] (companion MyMesh.cpp ~L1198)
        case 62: {
          if (p.length < 4) { err(6); break; }
          const pl = p[2], at = 3 + (pl === 0xff ? 0 : (pl & 63) * ((pl >> 6) + 1));
          if ((pl !== 0xff && pl >> 6 > 2) || p.length < at + 2) { err(6); break; }
          const type = p[at] | p[at + 1] << 8, data = p.subarray(at + 2);
          if (p[1] >= MAX_CH || !chans[p[1]].name) { err(2); break; }
          if (!type || data.length > 165) { err(6); break; }
          sentData.push({ ch: p[1], pathLen: pl, type, data: hex(data), unscoped });
          counters.sent++; if (pl === 0xff) counters.sentFlood++; else counters.sentDirect++; counters.txAir += 1; ok(); break;
        }
        case 64: out(o.scope ? [28, ...str(o.scope[0], 31), ...unhexs(o.scope[1])] : [28]); break;   // the default flood scope
        case 54: if (p.length < 2) { err(1); break; } unscoped = p[1] === 1; ok(); break;             // [1] = send unscoped
        case 10: out(queue.length ? queue.shift() : [10]); break;
        case 7: ok(); counters.sent++; counters.sentFlood++; counters.txAir += 1; break;
        case 14: me.advLat = (u32(p, 1) | 0) / 1e6; me.advLon = (u32(p, 5) | 0) / 1e6; ok(); break;
        case 30: { const s = findKey(p, 1); if (s) out(contactFrame(s)); else err(2); break; }
        case 13: { const s = findKey(p, 1); if (s) { s.outPath = null; ok(); } else err(2); break; }
        case 9: {   // ADD_UPDATE_CONTACT: a known key -> its route; a new one (a QR contact, key/type/name only) -> added
          const s = findKey(p, 1); if (s) { s.fav = !!(p[34] & 1); const n = p[35]; s.outPath = n === 0xff ? null : [...p.subarray(36, 36 + (n & 63) * ((n >> 6) + 1))]; ok(); break; }
          if (p.length < 132) { err(2); break; }
          const key = p.subarray(1, 33), old = st.find(x => hex(x.key) === hex(key));
          if (old) { old.known = true; old.fav = !!(p[34] & 1); old.lastmod = now(); ok(); break; }
          st.push({ name: dec.decode(p.subarray(100, 132)).replace(/\0.*$/s, '') || 'Added', type: p[33], lat: 0, lon: 0, via: [0], snr: 0, rssi: -120, i: st.length,
            key: Uint8Array.from(key), lastAdvert: 0, lastmod: now(), outPath: p[35] === 0xff ? null : [...p.subarray(36, 36 + (p[35] & 63) * ((p[35] >> 6) + 1))], known: true });
          ok(); break;
        }
        case 42: { const s = findKey(p, 2); if (s) { const path = pathOf(s); out([22, ...le32(s.lastAdvert), path.length, ...path]); } else err(2); break; }
        case 2: {   // SEND_TXT_MSG [2][type][attempt][ts u32][prefix 6][text]
          const s = findKey(p, 7, 6); if (!s) { err(2); break; }
          if (p[1] === 1 && (s.type === 2 || s.type === 3)) {   // remote CLI: no ACK; an answer only for a logged-in admin
            counters.sent++; counters[s.outPath ? 'sentDirect' : 'sentFlood']++; counters.txAir += 1;
            sent(!s.outPath, 0, 2694);
            if (!loggedIn.has(s.i) || (F.ackLoss && rand() < F.ackLoss)) break;
            const reply = cliAnswer(s, dec.decode(p.subarray(13)).replace(/\0.*$/, '').trim());
            if (!reply) break;
            sched(() => { queue.push([16, i8(Math.round(s.snr * 4)), 0, 0, ...s.key.subarray(0, 6), 0xff, 1, ...le32(clockOf(s)), ...enc.encode(reply)]); out([0x83]); }, 1200 + 600 * hopsOf(s));
            break;
          }
          const flood = !s.outPath, tag = (Math.floor(rand() * 0xffffffff) >>> 0) || 1, ms = flood ? 4000 + 1500 * hopsOf(s) : 2500;
          counters.sent++; counters[flood ? 'sentFlood' : 'sentDirect']++; counters.txAir += 1;
          sent(flood, tag, ms);
          if (s.type === 3) {   // a post to the room server: ACKed only for a logged-in reader/writer, kept, never sent back to us
            if (!loggedIn.has(s.i) || !(s.perms & 3) || (F.ackLoss && rand() < F.ackLoss)) break;
            const rtt = 900 + 700 * hopsOf(s);
            out([0x82, ...le32(tag), ...le32(rtt)], rtt);
            roomAdd(s, me.key, dec.decode(p.subarray(13)).replace(/\0.*$/, ''));
            break;
          }
          if (s.type === 4 || (F.ackLoss && rand() < F.ackLoss)) break;   // a sensor never answers; ackLoss = lost on the way back
          let rtt = 900 + 700 * hopsOf(s) + Math.round(rand() * 600);
          if (F.ackLateFirst > 0) { F.ackLateFirst--; rtt = F.ackLateMs; }
          else if (F.ackLossFirst > 0) { F.ackLossFirst--; break; }
          out([0x82, ...le32(tag), ...le32(rtt)], rtt);
          if (flood) { s.outPath = s.via.slice().reverse().map(j => hashOf(st[j])); out([0x81, ...s.key], rtt + 50); }   // their path-return: route learned
          if (s.bot) { const text = dec.decode(p.subarray(13)); sched(() => heardDm(s, `Copy, ${text.length > 60 ? text.slice(0, 57) + '...' : text}`), rtt + 1500 + Math.round(rand() * 1500)); }
          break;
        }
        case 3: ok(); counters.sent++; counters.sentFlood++; counters.txAir += 1; break;   // channel text: no ACK exists
        case 52: {   // path discovery -> PUSH 0x8D with both routes, from stations that allow telemetry to us
          const s = findKey(p, 2); if (!s) { err(2); break; }
          const tag = (Math.floor(rand() * 0xffffffff) >>> 0) || 1; sent(true, tag, 6000);
          if (s.type === 4 || (F.ackLoss && rand() < F.ackLoss)) break;
          const back = pathOf(s), fwd = back.slice().reverse();
          out([0x8d, 0, ...s.key.subarray(0, 6), fwd.length, ...fwd, back.length, ...back], 1200 + 800 * hopsOf(s));
          break;
        }
        case 56: {   // GET_STATS
          const t = p[1];
          if (t === 0) out([24, 0, ...le16(4012), ...le32(Math.floor((Date.now() - born) / 1000) + 5000), ...le16(0), 0]);
          else if (t === 1) out([24, 1, ...le16(-117 & 0xffff), i8(lastRx.rssi), i8(Math.round(lastRx.snr * 4)), ...le32(counters.txAir), ...le32(counters.rxAir)]);
          else if (t === 2) out([24, 2, ...[counters.recv, counters.sent, counters.sentFlood, counters.sentDirect, counters.recvFlood, counters.recvDirect, counters.recvErrors].flatMap(le32)]);
          else err(6);
          break;
        }
        case 26: {   // login to a repeater / room server
          const s = findKey(p, 1); if (!s) { err(2); break; }
          if (s.type !== 2 && s.type !== 3) { err(6); break; }
          const pw = dec.decode(p.subarray(33)).replace(/\0.*$/, '');
          sent(!s.outPath, u32(s.key, 0), 8000 + 1500 * hopsOf(s));
          if ((F.ackLoss && rand() < F.ackLoss) || stale(s)) break;
          if (s.type === 3) {   // room server: admin 3, guest password 2 (read + post), blank 0 (read only) -- or what it already gave us
            const perm = F.loginFail ? -1 : pw === s.admin ? 3 : pw === s.guest ? 2 : pw === '' && s.perms != null ? s.perms : pw === '' && s.readOnly ? 0 : -1;
            if (perm < 0) break;   // wrong password: silence
            loggedIn.add(s.i); s.perms = perm; s.roomSince = s.syncSince; s.roomDirect = false;   // the login carries our node's "sync since"
            if (s.outPath == null) { s.outPath = s.via.slice().reverse().map(j => hashOf(st[j])); out([0x81, ...s.key], 700 + 600 * hopsOf(s)); }
            out([0x85, perm === 3 ? 1 : perm === 0 ? 2 : 0, ...s.key.subarray(0, 6), ...le32(clockOf(s)), perm, 1], 750 + 600 * hopsOf(s));
            roomPush(s, 2750);
            break;
          }
          const admin = !F.loginFail && pw === s.admin, guest = !F.loginFail && !admin && s.guest != null && pw === s.guest;
          if (!admin && !guest) break;   // a wrong password: the repeater stays silent
          loggedIn.add(s.i);
          if (s.outPath == null) { s.outPath = s.via.slice().reverse().map(j => hashOf(st[j])); out([0x81, ...s.key], 700 + 600 * hopsOf(s)); }   // the login taught the route
          out([0x85, admin ? 1 : 0, ...s.key.subarray(0, 6), ...le32(clockOf(s)), admin ? 3 : 1, 2], 750 + 600 * hopsOf(s));
          break;
        }
        case 27: {   // status request
          const s = findKey(p, 1); if (!s) { err(2); break; }
          const tag = (Math.floor(rand() * 0xffffffff) >>> 0) || 1; sent(!s.outPath, tag, 3000 + 1500 * hopsOf(s));
          if (s.type !== 2 || (F.ackLoss && rand() < F.ackLoss) || stale(s)) break;
          out([0x87, 0, ...s.key.subarray(0, 6), ...repeaterStats(s)], 800 + 600 * hopsOf(s));
          break;
        }
        case 39: {   // telemetry request [39][0 0 0][key 32]
          const s = findKey(p, 4); if (!s) { err(2); break; }
          const tag = (Math.floor(rand() * 0xffffffff) >>> 0) || 1; sent(!s.outPath, tag, 3000 + 1500 * hopsOf(s));
          if (F.ackLoss && rand() < F.ackLoss) break;
          out([0x8b, 0, ...s.key.subarray(0, 6), ...telemetry(s)], 900 + 600 * hopsOf(s));
          break;
        }
        case 36: {   // trace path [36][tag u32][auth u32][flags][hashes]
          const flags = p[9], psz = flags & 3, sz = 1 << psz, hs = p.subarray(10), n = hs.length >> psz;
          sent(false, u32(p, 1), 900 + 700 * n);
          const hops = []; for (let i = 0; i < n; i++) { const h = hex(hs.subarray(i * sz, (i + 1) * sz)); hops.push(st.find(s => (s.type === 2 || s.type === 3) && hex(s.key).startsWith(h))); }
          // each hop must hear the one before: us -> a station with an empty via, or along a via chain (either way)
          const near = (a, b) => !a ? b.via.length === 0 : (b.via.length && b.via[0] === a.i) || (a.via.length && a.via[0] === b.i) || (a.via.length === 0 && b.via.length === 0);
          let ok = hops.every(Boolean) && !(F.ackLoss && rand() < F.ackLoss);
          for (let i = 0; ok && i < n; i++) ok = near(i ? hops[i - 1] : null, hops[i]);
          if (!ok || !n || hops[n - 1].via.length) break;   // the last hop must reach us again
          const snrs = hops.map((s, i) => i ? Math.min(s.snr, hops[i - 1].snr) : s.snr);
          out([0x89, 0, hs.length, flags, ...p.subarray(1, 9), ...hs, ...snrs.map(v => i8(Math.round(v * 4))), i8(Math.round(hops[n - 1].snr * 4))], 700 + 500 * n);
          break;
        }
        case 15: { const s = findKey(p, 1); if (s) { s.known = false; ok(); } else err(2); break; }   // REMOVE_CONTACT
        // SIGN_START / SIGN_DATA / SIGN_FINISH, as MyMesh.cpp: 8 KB max, BAD_STATE (4) without a start, TABLE_FULL (3) past 8 KB
        case 33: signBuf = []; out([19, 0, ...le32(8192)]); break;
        case 34: if (!signBuf) err(4); else if (signBuf.length + p.length - 1 > 8192) err(3); else { signBuf.push(...p.subarray(1)); ok(); } break;
        case 35: if (!signBuf) { err(4); break; } out([20, ...(idKeys ? NACL.sign.detached(Uint8Array.from(signBuf), idKeys.secretKey) : new Array(64).fill(0))]); signBuf = null; break;
        case 16: { const s = findKey(p, 1); if (s) { counters.sent++; counters.txAir += 1; ok(); } else err(2); break; }   // SHARE_CONTACT (zero hop)
        case 17: {   // EXPORT_CONTACT: [17] = this node, [17][key] = that contact's advert packet
          if (p.length < 33) {   // our own advert, signed with this node's real key when TweetNaCl is here (Ham Contacts checks cards)
            const a = advertPacket({ ...me, type: 1, via: [], lastAdvert: now(), lat: me.advLat, lon: me.advLon });
            if (idKeys) { const o2 = 2, msg = Uint8Array.from([...a.slice(o2, o2 + 36), ...a.slice(o2 + 100)]); a.splice(o2 + 36, 64, ...NACL.sign.detached(msg, idKeys.secretKey)); }
            out([11, ...a]); break;
          }
          const s = findKey(p, 1); if (s) out([11, ...advertPacket({ ...s, via: [] })]); else err(2);
          break;
        }
        case 18: {   // IMPORT_CONTACT [packet]: header, path_len, path, key 32, ts, sig 64, flags, [lat lon], name
          const pl = p[2] & 63, o = 3 + pl * ((p[2] >> 6) + 1);
          if (p.length < o + 101) { err(6); break; }
          const key = p.subarray(o, o + 32), flags = p[o + 100];
          let s = st.find(x => hex(x.key) === hex(key));
          if (!s) {
            let i = o + 101, lat = 0, lon = 0;
            if (flags & 0x10) { lat = (u32(p, i) | 0) / 1e6; lon = (u32(p, i + 4) | 0) / 1e6; i += 8; }
            s = { name: dec.decode(p.subarray(i)) || 'Imported', type: flags & 15, lat, lon, via: [0], snr: 0, rssi: -120, i: st.length, key: Uint8Array.from(key), lastAdvert: u32(p, o + 32), lastmod: now(), outPath: null };
            st.push(s);
          }
          s.known = true; s.lastmod = now(); ok();
          break;
        }
        case 8: me.name = dec.decode(p.subarray(1)).replace(/\0.*$/, ''); ok(); break;   // SET_ADVERT_NAME
        case 50: {   // binary request [50][key 32][req type][...]: neighbours (6) only
          const s = findKey(p, 1); if (!s) { err(2); break; }
          const tag = (Math.floor(rand() * 0xffffffff) >>> 0) || 1; sent(!s.outPath, tag, 2694);
          if (p[33] === 2 && s.type === 3) {   // keep-alive to the room: active again; sent direct, `since` re-sends newer posts
            if (!loggedIn.has(s.i)) break;
            const since = p.length >= 38 ? u32(p, 34) : 0;
            if (since && s.outPath) s.roomSince = since;
            roomPush(s, 300);
            break;
          }
          if (p[33] !== 6 || s.type !== 2 || (F.ackLoss && rand() < F.ackLoss)) break;
          const want = p[35] || 0, plen = Math.min(p[39] || 6, 32), n = neighboursOf(s).sort((a, b) => b.snr - a.snr), list = n.slice(0, want);
          out([0x8c, 0, ...le32(tag), ...le16(n.length), ...le16(list.length), ...list.flatMap(x => [...x.key.subarray(0, plen), ...le32(300 + x.i * 60), i8(Math.round(x.snr * 4))])], 900 + 600 * hopsOf(s));
          break;
        }
        default: err(1);
      }
    }

    // ---- background traffic (demo)
    function autoTick() {
      if (stopped) return;
      const r = rand(), s = st[Math.floor(rand() * st.length)];
      if (r < 0.5) heardAdvert(s);
      else if (r < 0.85 && s.type === 1) heardChannel(s, CHAT[Math.floor(rand() * CHAT.length)], rand() < 0.8 ? 0 : 1);
      else if (r < 0.92 && s.bot) heardDm(s, 'G\'day, are you on the P25X net tonight?');
      else if (s.type === 2) heardAdvert(s);
      sched(autoTick, 15000 + Math.round(rand() * 25000));
    }
    if (o.auto) sched(autoTick, 4000);
    // a node that has just come up hears everyone's advert within a few seconds (the coverage and path maps fill in)
    if (o.auto) st.forEach((s, i) => { if (s.known) sched(() => heardAdvert(s), 1500 + i * 600); });
    // stations the node doesn't know yet show up later (fresh adverts -> NEW_ADVERT)
    if (o.auto) st.forEach(s => { if (s.name === 'Brisbane Bob' || s.name === 'Bremer Creek Sensor') s.known = false; });
    // someone posts to the room every few minutes (no rand(): the rest of the demo's traffic stays as it was)
    let roomN = 0;
    const roomTick = () => {
      if (stopped) return;
      const room = st.find(s => s.type === 3), who = st.filter(s => s.type === 1)[roomN % 4];
      if (room && who) roomAdd(room, who.key, CHAT[roomN % CHAT.length]);
      roomN++; sched(roomTick, 180000 + 60000 * (roomN % 3));
    };
    if (o.auto) sched(roomTick, 45000);
    // MeshPRS beacons every 5 min (no rand(): the rest of the demo's traffic stays as it was)
    const mprsTick = () => { if (stopped) return; st.filter(s => s.mprs).forEach(s => heardData(s, mprsPosition(s))); sched(mprsTick, 300000); };
    if (o.auto) sched(mprsTick, 30000);

    return {
      world: st, me, counters,
      onFrame(cb) { frameCb = cb; }, onJunk(cb) { junkCb = cb; },
      write,
      inject: {
        advert: i => heardAdvert(st[i]), channel: (i, text, ch = 0) => heardChannel(st[i], text, ch), dm: (i, text) => heardDm(st[i], text),
        mprs: (i, blob) => heardData(st[i], blob ? Array.from(blob) : mprsPosition(st[i])),
        forget: i => { st[i].known = false; },
        roomPost: (i, text, room) => { const r = room != null ? st[room] : st.find(s => s.type === 3); roomAdd(r, st[i].key, text); },   // station i posts to the room
      },
      state: () => ({ sentData, unscoped, channels: chans.map(c => c.name), queued: queue.length, loggedIn: [...loggedIn], hung: hung(),
        rooms: st.filter(s => s.type === 3).map(s => ({ posts: s.posts.length, perms: s.perms, syncSince: s.syncSince, last: (s.posts[s.posts.length - 1] || {}).text })), clocks: st.filter(s => s.type === 2 || s.type === 3).map(s => clockOf(s)) }),
      stop() { stopped = true; timers.forEach(t => clearTimeout(t)); timers.clear(); },
    };
  }

  root.KellyMeshCoreSim = { create, keyOf, WORLD, SELF, CHANNELS };
})(typeof window !== 'undefined' ? window : globalThis);
