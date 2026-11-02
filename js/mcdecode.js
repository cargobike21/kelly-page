/* Kelly Page -- MeshCore packet decoder (2026-10-24), pure: no DOM, no storage. For the MeshCore Analyser
 * (js/mcanalyser.js) and the path hash size check (js/mchashcheck.js); tests: tests/mcdecode-tests.html.
 *
 * A raw packet is what a companion hands up in PUSH LOG_RX_DATA after snr and rssi = Packet::writeTo() bytes.
 * Every layout below follows the MeshCore firmware source, companion/repeater v1.18.0 (github.com/meshcore-dev/MeshCore,
 * tag companion-v1.18.0) -- the file and function are named beside each decoder. Nothing here is guessed: a payload
 * type the source doesn't lay out is shown as plain bytes.
 *
 * Encryption (src/Utils.cpp encryptThenMAC / MACThenDecrypt): AES-128 ECB with the first 16 bytes of the secret,
 * then a 2-byte MAC = HMAC-SHA256(secret as 32 bytes, ciphertext)[0..2]. Direct messages use an ECDH secret made
 * from the node's PRIVATE key, which never leaves the node -- so they stay "encrypted" here, as they should. Group
 * (channel) messages use the channel secret, which the companion gives us for OUR channels (CHANNEL_INFO): those,
 * and only those, are decrypted.
 *
 * KellyMcDecode.decode(bytes, opts) -> { ok, err?, header..., fields: [{ key, label, start, len, hex, value, explain,
 *   group, warn? }], info: {...}, summary }      opts: { channels: [{ name, secret }], expectHash: 1|2|3, names(hash) }
 * Also: sha256, hmacSha256, aesEcbDecrypt, aesEcbEncrypt, channelHash, encryptThenMac (tests + the guided tour),
 * hex, unhex, ROUTES, TYPES, GROUPS.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyMcDecode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- bytes
  const hex = b => Array.from(b || [], x => x.toString(16).padStart(2, '0')).join('');
  const unhex = s => { s = String(s || '').replace(/[^0-9a-f]/gi, ''); const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
  const u16 = (b, o) => b[o] | b[o + 1] << 8;
  const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  const i32 = (b, o) => b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24;
  const i8 = x => (x << 24) >> 24;
  const utf8 = b => { try { return new TextDecoder().decode(b); } catch { return String.fromCharCode(...b); } };
  const cstr = b => { const z = b.indexOf(0); return utf8(z < 0 ? b : b.subarray(0, z)); };
  const when = t => { try { return new Date(t * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'); } catch { return String(t); } };

  // ---------------------------------------------------------------- SHA-256 / HMAC (FIPS 180-4)
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
    0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(data) {
    const l = data.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
    m.set(data); m[l] = 0x80;
    const bits = l * 8; for (let i = 0; i < 4; i++) m[n - 1 - i] = (bits / 2 ** (8 * i)) & 255;
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    const r = (x, c) => (x >>> c) | (x << (32 - c));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = m[o + i * 4] << 24 | m[o + i * 4 + 1] << 16 | m[o + i * 4 + 2] << 8 | m[o + i * 4 + 3];
      for (let i = 16; i < 64; i++) { const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = w[i - 16] + s0 + w[i - 7] + s1; }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i] >>> 0, t2 = (r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        hh = g; g = f; f = e; e = d + t1 >>> 0; d = c; c = b; b = a; a = t1 + t2 >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32); for (let i = 0; i < 8; i++) { out[i * 4] = h[i] >>> 24; out[i * 4 + 1] = h[i] >>> 16; out[i * 4 + 2] = h[i] >>> 8; out[i * 4 + 3] = h[i]; }
    return out;
  }
  function hmacSha256(key, data) {
    let k = key.length > 64 ? sha256(key) : key; const kp = new Uint8Array(64); kp.set(k);
    const ip = kp.map(x => x ^ 0x36), op = kp.map(x => x ^ 0x5c), inner = new Uint8Array(64 + data.length);
    inner.set(ip); inner.set(data, 64);
    const ih = sha256(inner), outer = new Uint8Array(96); outer.set(op); outer.set(ih, 64);
    return sha256(outer);
  }

  // ---------------------------------------------------------------- AES-128 (FIPS 197), ECB as MeshCore uses it
  const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
  (() => {
    let p = 1, q = 1;
    do {
      p = p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0); p &= 255;
      q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 255; if (q & 0x80) q ^= 0x09;
      const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
      SBOX[p] = (x ^ 0x63) & 255;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
  })();
  const xt = x => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 255;
  const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
  function expand(key) {
    const w = new Uint8Array(176); w.set(key.subarray(0, 16));
    let rc = 1;
    for (let i = 16; i < 176; i += 4) {
      let t = w.slice(i - 4, i);
      if (i % 16 === 0) { t = Uint8Array.of(SBOX[t[1]] ^ rc, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]); rc = xt(rc); }
      for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
    }
    return w;
  }
  function encBlock(w, b) {
    const s = b.slice(); const ark = r => { for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; };
    ark(0);
    for (let r = 1; r <= 10; r++) {
      for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
      const t = s.slice(); for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) s[c * 4 + rr] = t[((c + rr) % 4) * 4 + rr];
      if (r < 10) for (let c = 0; c < 4; c++) { const a = s.slice(c * 4, c * 4 + 4); s[c * 4] = mul(a[0], 2) ^ mul(a[1], 3) ^ a[2] ^ a[3]; s[c * 4 + 1] = a[0] ^ mul(a[1], 2) ^ mul(a[2], 3) ^ a[3]; s[c * 4 + 2] = a[0] ^ a[1] ^ mul(a[2], 2) ^ mul(a[3], 3); s[c * 4 + 3] = mul(a[0], 3) ^ a[1] ^ a[2] ^ mul(a[3], 2); }
      ark(r);
    }
    return s;
  }
  function decBlock(w, b) {
    const s = b.slice(); const ark = r => { for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; };
    ark(10);
    for (let r = 9; r >= 0; r--) {
      const t = s.slice(); for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) s[((c + rr) % 4) * 4 + rr] = t[c * 4 + rr];
      for (let i = 0; i < 16; i++) s[i] = INV[s[i]];
      ark(r);
      if (r > 0) for (let c = 0; c < 4; c++) { const a = s.slice(c * 4, c * 4 + 4); s[c * 4] = mul(a[0], 14) ^ mul(a[1], 11) ^ mul(a[2], 13) ^ mul(a[3], 9); s[c * 4 + 1] = mul(a[0], 9) ^ mul(a[1], 14) ^ mul(a[2], 11) ^ mul(a[3], 13); s[c * 4 + 2] = mul(a[0], 13) ^ mul(a[1], 9) ^ mul(a[2], 14) ^ mul(a[3], 11); s[c * 4 + 3] = mul(a[0], 11) ^ mul(a[1], 13) ^ mul(a[2], 9) ^ mul(a[3], 14); }
    }
    return s;
  }
  const ecb = (f, key, data) => { const w = expand(key), out = new Uint8Array(data.length); for (let o = 0; o + 16 <= data.length; o += 16) out.set(f(w, data.subarray(o, o + 16)), o); return out; };
  const aesEcbEncrypt = (key, data) => ecb(encBlock, key, data);
  const aesEcbDecrypt = (key, data) => ecb(decBlock, key, data);
  const key32 = secret => { const k = new Uint8Array(32); k.set(secret.subarray(0, 32)); return k; };
  // src/Utils.cpp encryptThenMAC: zero-pad to 16, AES-ECB, MAC 2 bytes in front
  function encryptThenMac(secret, plain) {
    const p = new Uint8Array(Math.ceil(plain.length / 16) * 16 || 16); p.set(plain);
    const c = aesEcbEncrypt(secret.subarray(0, 16), p), out = new Uint8Array(2 + c.length);
    out.set(hmacSha256(key32(secret), c).subarray(0, 2)); out.set(c, 2);
    return out;
  }
  // src/Utils.cpp MACThenDecrypt -> plaintext or null (MAC wrong / not block-aligned)
  function macThenDecrypt(secret, macAndData) {
    if (macAndData.length <= 2 || (macAndData.length - 2) % 16) return null;
    const c = macAndData.subarray(2), mac = hmacSha256(key32(secret), c);
    if (mac[0] !== macAndData[0] || mac[1] !== macAndData[1]) return null;
    return aesEcbDecrypt(secret.subarray(0, 16), c);
  }
  // src/helpers/BaseChatMesh.cpp addChannel: hash = sha256(secret)[0] (the 16 bytes the companion gives us)
  const channelHash = secret => sha256(secret.subarray(0, 16))[0];

  // ---------------------------------------------------------------- names
  // src/Packet.h: header = route (2 bits) | payload type (4) << 2 | payload version (2) << 6
  const ROUTES = ['transport flood', 'flood', 'direct', 'transport direct'];
  const TYPES = { 0: 'REQ', 1: 'RESPONSE', 2: 'TXT_MSG', 3: 'ACK', 4: 'ADVERT', 5: 'GRP_TXT', 6: 'GRP_DATA', 7: 'ANON_REQ', 8: 'PATH', 9: 'TRACE', 10: 'MULTIPART', 11: 'CONTROL', 15: 'RAW_CUSTOM' };
  const FRIENDLY = { REQ: 'request', RESPONSE: 'response', TXT_MSG: 'direct message', ACK: 'acknowledgement', ADVERT: 'advert', GRP_TXT: 'channel message', GRP_DATA: 'channel data',
    ANON_REQ: 'anonymous request (login)', PATH: 'path return', TRACE: 'trace', MULTIPART: 'multipart', CONTROL: 'control / discover', RAW_CUSTOM: 'raw custom' };
  const ADV_TYPES = ['none', 'companion (chat)', 'repeater', 'room server', 'sensor'];   // src/helpers/AdvertDataHelpers.h
  // the strip's colour groups (css/mcanalyser.css .mca-g-*) and the legend
  const GROUPS = { header: 'Header', transport: 'Transport codes', pathlen: 'Path length', path: 'Path (hops)', addr: 'Addresses', key: 'Public key', time: 'Time',
    sig: 'Signature', flags: 'Flags', loc: 'Location', name: 'Name', mac: 'MAC (check)', cipher: 'Encrypted', plain: 'Decrypted', data: 'Data', snr: 'SNR' };

  // ---------------------------------------------------------------- decode
  function decode(bytes, opts = {}) {
    const b = bytes instanceof Uint8Array ? bytes : unhex(bytes);
    const fields = [], info = {};
    const out = { ok: false, len: b.length, fields, info, hex: hex(b), encrypted: false, decrypted: false, mismatch: false };
    const add = (key, label, start, len, group, value, explain, extra) => { const f = { key, label, start, len, hex: hex(b.subarray(start, start + len)), group, value: value == null ? '' : String(value), explain }; if (extra) Object.assign(f, extra); fields.push(f); return f; };
    if (b.length < 2) { out.err = 'too short to be a MeshCore packet (2 bytes at least)'; return out; }

    // header -- src/Packet.h, Packet::readFrom (src/Packet.cpp)
    const hdr = b[0], route = hdr & 3, type = (hdr >> 2) & 15, ver = hdr >> 6, tname = TYPES[type] || `type ${type}`;
    Object.assign(out, { route, routeName: ROUTES[route], flood: route <= 1, type, typeName: tname, friendly: FRIENDLY[tname] || tname, ver });
    add('header', 'Header', 0, 1, 'header', `${ROUTES[route]} · ${tname} · v${ver + 1}`,
      `One byte packed with three things: how the packet travels (${ROUTES[route]}), what it is (${FRIENDLY[tname] || tname}) and the payload version (v${ver + 1}; v1 = 1-byte addresses and a 2-byte MAC). Bits: route = the low 2, type = the next 4, version = the top 2. (src/Packet.h)`);
    let o = 1;
    // transport codes -- src/Packet.cpp writeTo/readFrom: two uint16 after the header on a TRANSPORT route
    if (route === 0 || route === 3) {
      if (b.length < 5) { out.err = 'cut short inside the transport codes'; return out; }
      out.transport = [u16(b, 1), u16(b, 3)];
      add('transport', 'Transport codes', 1, 4, 'transport', `${out.transport[0].toString(16).padStart(4, '0')} ${out.transport[1].toString(16).padStart(4, '0')}`,
        'Two 2-byte region (scope) codes. Repeaters use them to keep a flood inside one region; Brisbane/SEQ doesn\'t use regions yet, so most packets here have none. (src/Packet.cpp)');
      o = 5;
    }
    if (o >= b.length) { out.err = 'no path length byte'; return out; }
    // path length -- src/Packet.h getPathHashSize/Count: low 6 bits = count, top 2 = hash size - 1 (size 4 reserved)
    const pl = b[o], isTrace = type === 9;
    const sz = isTrace ? 1 : (pl >> 6) + 1, n = isTrace ? pl : pl & 63;
    out.hashSize = isTrace ? null : sz;   // out.hops: set below, only once the path checks out
    if (!isTrace && sz === 4) { out.err = 'path length uses the reserved hash size 4 (src/Packet.cpp isValidPathLen)'; add('pathlen', 'Path length', o, 1, 'pathlen', `0x${pl.toString(16)}`, 'Invalid: hash size 4 is reserved.', { warn: true }); return out; }
    const mismatch = !isTrace && out.flood && opts.expectHash && sz !== opts.expectHash;
    out.mismatch = !!mismatch;
    add('pathlen', 'Path length', o, 1, 'pathlen', isTrace ? `${n} SNR reading${n === 1 ? '' : 's'}` : `${n} hop${n === 1 ? '' : 's'} × ${sz}-byte hashes`,
      isTrace ? 'For a TRACE this byte is simply how many SNR readings follow: each repeater on the way adds one. (src/Mesh.cpp onRecvPacket, TRACE)'
        : `One byte, two numbers: the low 6 bits count the hops so far (${n}), the top 2 bits give each hop's hash size minus one (${sz}-byte). The sender picks the size (its "path hash size" setting); every repeater then adds its own hash at that size.${mismatch ? ` ⚠️ This network expects ${opts.expectHash}-byte hashes.` : ''} (src/Packet.h getPathHashSize)`,
      mismatch ? { warn: true } : null);
    o++;
    const pb = n * sz;
    // src/Packet.cpp isValidPathLen: hops x hash size must fit MAX_PATH_SIZE (64 bytes)
    if (!isTrace && pb > 64) { out.err = `the path is ${pb} bytes, more than the 64 MeshCore allows (src/Packet.cpp isValidPathLen)`; return out; }
    if (o + pb > b.length) { out.err = 'the path runs past the end of the packet'; return out; }
    // a garbled or non-MeshCore packet can carry any byte here: set before these checks, its 0x19 read as "25 hops"
    // in Packet Journey and the Analyser (2026-10-27 -- his node's own history never passed 10)
    out.hops = isTrace ? 0 : n;
    if (isTrace) {
      out.snrs = Array.from(b.subarray(o, o + n), x => i8(x) / 4);
      if (n) add('path', 'SNR readings', o, n, 'snr', out.snrs.map(x => `${x} dB`).join(', '), 'Each repeater the trace passed added the SNR it heard it at (×4, signed). This is how a trace measures every link. (src/Mesh.cpp: "append SNR (Not hash!)")');
    } else {
      out.path = []; for (let i = 0; i < n; i++) out.path.push(hex(b.subarray(o + i * sz, o + i * sz + sz)));
      if (n) add('path', 'Path', o, pb, 'path', out.path.join(' → '),
        `The repeaters this packet hopped through, first one first: the first ${sz} byte${sz > 1 ? 's' : ''} of each repeater's public key.${sz === 1 ? ' With 1-byte hashes there are only 256 possible IDs, so two repeaters can easily look the same -- that\'s why Brisbane/SEQ asks for 2-byte.' : ''}${mismatch ? ` ⚠️ ${sz}-byte hashes, but this network expects ${opts.expectHash}-byte.` : ''}`,
        mismatch ? { warn: true } : null);
    }
    o += pb;
    const pay = b.subarray(o), P = o;
    out.payloadLen = pay.length;
    if (!pay.length) { out.err = 'no payload'; return out; }
    out.ok = true;
    const rest = (label, group, explain, from = 0) => { if (from < pay.length) add(group + from, label, P + from, pay.length - from, group, `${pay.length - from} bytes`, explain); };
    const encExplain = 'Encrypted with AES-128. Only the two ends hold the key (made from their private keys), so nobody in between -- including this page -- can read it. Your own node decrypts the messages meant for you and hands them to Kelly separately.';

    switch (type) {
      case 4: {   // ADVERT -- src/Mesh.cpp onRecvPacket ADVERT + src/helpers/AdvertDataHelpers.h/.cpp
        if (pay.length < 101) { rest('Advert (cut short)', 'data', 'Too short for an advert (32 key + 4 time + 64 signature + 1 flags).'); break; }
        const key = hex(pay.subarray(0, 32)), ts = u32(pay, 32), flags = pay[100];
        const a = info.advert = { key, ts, role: ADV_TYPES[flags & 15] || `type ${flags & 15}`, roleId: flags & 15 };
        add('akey', 'Public key', P, 32, 'key', key.slice(0, 16) + '…', 'The node\'s identity: a 32-byte Ed25519 public key. Its first bytes are the node\'s "hash" -- the ID that shows up in paths.');
        add('ats', 'Timestamp', P + 32, 4, 'time', when(ts), 'When the node sent this advert (its own clock, seconds since 1970). Repeaters ignore adverts older than the last one they saw from this key.');
        add('asig', 'Signature', P + 36, 64, 'sig', '64 bytes', 'An Ed25519 signature over key + timestamp + the data after it. Proves the advert really came from the owner of the key, so nobody can fake it.');
        add('aflags', 'Flags', P + 100, 1, 'flags', `${a.role}${flags & 0x10 ? ' · location' : ''}${flags & 0x80 ? ' · name' : ''}`, 'Low 4 bits: what kind of node (1 companion, 2 repeater, 3 room server, 4 sensor). Then one bit each for "location follows" (0x10), two future fields (0x20, 0x40) and "name follows" (0x80).');
        let i = 101;
        if (flags & 0x10 && pay.length >= i + 8) { a.lat = i32(pay, i) / 1e6; a.lon = i32(pay, i + 4) / 1e6; add('aloc', 'Location', P + i, 8, 'loc', `${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}`, 'Latitude and longitude, each a signed 4-byte number in millionths of a degree. MeshCore sends exactly what the owner set -- Brisbane/SEQ asks for a rough location.'); i += 8; }
        if (flags & 0x20 && pay.length >= i + 2) { add('af1', 'Feature 1', P + i, 2, 'data', u16(pay, i), 'Reserved for the future (src/helpers/AdvertDataHelpers.h ADV_FEAT1_MASK).'); i += 2; }
        if (flags & 0x40 && pay.length >= i + 2) { add('af2', 'Feature 2', P + i, 2, 'data', u16(pay, i), 'Reserved for the future (ADV_FEAT2_MASK).'); i += 2; }
        if (flags & 0x80 && pay.length > i) { a.name = cstr(pay.subarray(i)); add('aname', 'Name', P + i, pay.length - i, 'name', a.name, 'The node\'s name, as its owner typed it.'); i = pay.length; }
        rest('Extra', 'data', 'Bytes after the advert data (not expected).', i);
        out.summary = `${a.role} advert from ${a.name || key.slice(0, 8)}`;
        break;
      }
      case 0: case 1: case 2: case 8: {   // REQ / RESPONSE / TXT_MSG / PATH -- src/Mesh.cpp onRecvPacket + createDatagram/createPathReturn
        if (pay.length <= 4) { rest('Payload (cut short)', 'data', 'Too short: 1 + 1 address bytes, a 2-byte MAC and some encrypted bytes (src/Mesh.cpp wants more than 4).'); break; }
        info.dest = hex(pay.subarray(0, 1)); info.src = hex(pay.subarray(1, 2));
        add('dest', 'To', P, 1, 'addr', info.dest, 'The first byte of the receiver\'s public key (payload v1: 1-byte addresses). Every node whose key starts with this byte tries to decrypt it; only the right one succeeds.');
        add('src', 'From', P + 1, 1, 'addr', info.src, 'The first byte of the sender\'s public key.');
        add('mac', 'MAC', P + 2, 2, 'mac', hex(pay.subarray(2, 4)), 'A 2-byte check (HMAC-SHA256, cut short) over the encrypted bytes, so the receiver can tell its key fits before decrypting. (src/Utils.cpp)');
        rest(tname === 'PATH' ? 'Encrypted path' : 'Encrypted', 'cipher', tname === 'PATH' ? 'Encrypted with the two ends\' shared key: the path back to the sender (so later messages can go direct), plus an extra field. ' + encExplain.split('. ').slice(1).join('. ') : encExplain, 4);
        out.encrypted = true;
        out.summary = `${FRIENDLY[tname]} ${info.src} → ${info.dest} (encrypted)`;
        break;
      }
      case 3: {   // ACK -- src/Mesh.cpp onRecvPacket ACK: a 4-byte CRC
        if (pay.length < 4) { rest('Payload (cut short)', 'data', 'An ACK carries 4 bytes.'); break; }
        info.ack = hex(pay.subarray(0, 4));
        add('ack', 'ACK code', P, 4, 'data', info.ack, 'A 4-byte checksum of the message being acknowledged. The sender matches it to the message it sent and shows ✓✓ "delivered".');
        rest('Extra', 'data', 'Bytes after the ACK code.', 4);
        out.summary = `ACK ${info.ack}`;
        break;
      }
      case 5: case 6: {   // GRP_TXT / GRP_DATA -- src/Mesh.cpp onRecvPacket GRP_*, src/helpers/BaseChatMesh.cpp sendGroupMessage/onGroupDataRecv
        if (pay.length < 3) { rest('Payload (cut short)', 'data', 'Too short for a channel message.'); break; }
        const ch = pay[0]; info.chHash = hex(pay.subarray(0, 1));
        let hit = null, plain = null;
        for (const c of opts.channels || []) {
          const sec = c.secret instanceof Uint8Array ? c.secret : unhex(c.secret);
          if (sec.length >= 16 && channelHash(sec) === ch) { const p = macThenDecrypt(sec, pay.subarray(1)); if (p) { hit = c; plain = p; break; } }
        }
        add('ch', 'Channel', P, 1, 'addr', hit ? `${info.chHash} = ${hit.name}` : info.chHash, 'The first byte of SHA-256 of the channel\'s secret key: which channel this is for, without saying its name.' + (hit ? ` It matches your channel "${hit.name}".` : ' None of your channels match it.'));
        add('mac', 'MAC', P + 1, 2, 'mac', hex(pay.subarray(1, 3)), 'A 2-byte check over the encrypted bytes; it proves the key fits before decrypting. (src/Utils.cpp MACThenDecrypt)');
        if (!plain) {
          rest('Encrypted', 'cipher', hit ? 'Encrypted with the channel key.' : 'Encrypted with a channel key you don\'t have, so it stays private -- exactly as intended.', 3);
          out.encrypted = true; info.channel = null;
          out.summary = `${FRIENDLY[tname]} on channel ${info.chHash} (not one of yours)`;
          break;
        }
        out.decrypted = true; info.channel = hit.name;
        if (type === 5) {
          const ts = u32(plain, 0);   // plaintext: timestamp 4, txt_type 1 (type << 2 | attempt), "name: message"
          const text = cstr(plain.subarray(5)), m = /^([^:]{1,32}): ([\s\S]*)$/.exec(text);
          info.ts = ts; info.text = m ? m[2] : text; info.sender = m ? m[1] : null;
          add('cipher', 'Decrypted with your key', P + 3, pay.length - 3, 'plain', `${info.sender ? info.sender + ': ' : ''}${info.text}`,
            `Encrypted (AES-128) with the "${hit.name}" channel key, which your node holds -- so Kelly can read it. Inside: a timestamp (${when(ts)}), a type byte, then "sender: message", padded with zeros to whole 16-byte blocks.`);
          out.summary = `${hit.name.startsWith("#") ? "" : "#"}${hit.name}: ${info.sender ? info.sender + ': ' : ''}${info.text}`;
        } else {
          // src/helpers/BaseChatMesh.cpp sendGroupData / onGroupDataRecv: data_type u16, data_len u8, the data (no timestamp)
          const dt = plain.length >= 3 ? u16(plain, 0) : null, dl = plain.length >= 3 ? Math.min(plain[2], plain.length - 3) : 0;
          info.dataType = dt; info.data = dt == null ? null : hex(plain.subarray(3, 3 + dl));
          add('cipher', 'Decrypted with your key', P + 3, pay.length - 3, 'plain', dt == null ? `${plain.length} bytes` : `data type 0x${dt.toString(16).padStart(4, '0')} · ${dl} bytes`,
            `Channel data, encrypted with the "${hit.name}" key. Inside: a 2-byte data type (which app it's for), a 1-byte length, then the data, padded with zeros to whole 16-byte blocks. (src/helpers/BaseChatMesh.cpp sendGroupData)`);
          out.summary = `channel data on ${hit.name}${dt == null ? '' : ` (type 0x${dt.toString(16).padStart(4, '0')}, ${dl} bytes)`}`;
        }
        break;
      }
      case 7: {   // ANON_REQ -- src/Mesh.cpp onRecvPacket ANON_REQ + createAnonDatagram
        if (pay.length < 35) { rest('Payload (cut short)', 'data', 'Too short: 1 + 32 + 2 bytes at least.'); break; }
        info.dest = hex(pay.subarray(0, 1)); info.ephKey = hex(pay.subarray(1, 33));
        add('dest', 'To', P, 1, 'addr', info.dest, 'The first byte of the receiver\'s public key -- usually a repeater or room server you\'re logging in to.');
        add('ekey', 'Sender\'s key', P + 1, 32, 'key', info.ephKey.slice(0, 16) + '…', 'The sender\'s public key in full, because the receiver may not know it yet. With it the receiver can work out the shared secret and decrypt the rest (a login password, for example).');
        add('mac', 'MAC', P + 33, 2, 'mac', hex(pay.subarray(33, 35)), 'A 2-byte check over the encrypted bytes. (src/Utils.cpp)');
        rest('Encrypted', 'cipher', encExplain, 35);
        out.encrypted = true; out.summary = `anonymous request to ${info.dest} (encrypted)`;
        break;
      }
      case 9: {   // TRACE -- src/Mesh.cpp onRecvPacket TRACE: tag 4, auth 4, flags 1 (low 2 bits: hash size = 1 << n), hashes
        if (pay.length < 9) { rest('Payload (cut short)', 'data', 'Too short for a trace.'); break; }
        const flags = pay[8], hs = 1 << (flags & 3), hs_n = Math.floor((pay.length - 9) / hs);
        info.trace = { tag: u32(pay, 0), hashSize: hs, hashes: [] };
        for (let i = 0; i < hs_n; i++) info.trace.hashes.push(hex(pay.subarray(9 + i * hs, 9 + i * hs + hs)));
        add('ttag', 'Trace tag', P, 4, 'data', info.trace.tag.toString(16), 'A random number the sender picked, to match the trace that comes back.');
        add('tauth', 'Auth code', P + 4, 4, 'data', hex(pay.subarray(4, 8)), 'Lets the far end check the trace is genuine.');
        add('tflags', 'Flags', P + 8, 1, 'flags', `${hs}-byte hashes`, 'Low 2 bits: the size of each hash below (1, 2, 4 or 8 bytes). (src/Mesh.cpp, "NEW v1.11+")');
        if (hs_n) add('thashes', 'Route to trace', P + 9, hs_n * hs, 'path', info.trace.hashes.join(' → '), 'The repeaters the trace must visit, in order. Each one that hears its own hash next passes it on and adds the SNR it heard it at (in the path field above).');
        rest('Extra', 'data', 'Bytes after the route.', 9 + hs_n * hs);
        out.summary = `trace via ${info.trace.hashes.join(' → ') || 'nobody'}`;
        break;
      }
      case 10: {   // MULTIPART -- src/Mesh.cpp onRecvPacket MULTIPART: byte 0 = remaining << 4 | inner type
        const remaining = pay[0] >> 4, inner = pay[0] & 15;
        info.multipart = { remaining, inner: TYPES[inner] || inner };
        add('mp', 'Part', P, 1, 'flags', `${remaining} more · ${TYPES[inner] || inner}`, 'High 4 bits: how many more packets of this set follow. Low 4 bits: the payload type inside (usually an ACK sent more than once for reliability).');
        if (inner === 3 && pay.length >= 5) { info.ack = hex(pay.subarray(1, 5)); add('ack', 'ACK code', P + 1, 4, 'data', info.ack, 'The 4-byte checksum of the message being acknowledged.'); rest('Extra', 'data', '', 5); }
        else rest('Inner payload', 'data', 'The inner packet\'s payload.', 1);
        out.summary = `multipart (${TYPES[inner] || inner}, ${remaining} more)`;
        break;
      }
      case 11: {   // CONTROL -- examples/simple_repeater/MyMesh.cpp onControlDataRecv: upper 4 bits = subtype
        const sub = pay[0] & 0xf0;
        if (sub === 0x80) {   // NODE_DISCOVER_REQ: [0x80 | prefix_only] filter tag [since]
          info.control = 'discover request';
          add('ctl', 'Control type', P, 1, 'flags', `discover request${pay[0] & 1 ? ' (key prefixes only)' : ''}`, '0x80 = "who\'s there?": repeaters in range answer with the SNR they heard it at. Zero-hop only.');
          if (pay.length >= 6) { add('cfilt', 'Filter', P + 1, 1, 'flags', `0x${pay[1].toString(16)}`, 'Which node types should answer (one bit per type).'); add('ctag', 'Tag', P + 2, 4, 'data', u32(pay, 2).toString(16), 'A number the answers repeat back, so the sender can match them.'); rest('Since', 'time', 'Only nodes changed since this time answer.', 6); }
        } else if (sub === 0x90) {   // NODE_DISCOVER_RESP: [0x90 | node type] snr tag pubkey
          info.control = 'discover answer';
          add('ctl', 'Control type', P, 1, 'flags', `discover answer from a ${ADV_TYPES[pay[0] & 15] || 'node'}`, '0x90 = an answer to "who\'s there?"; the low 4 bits say what kind of node answered.');
          if (pay.length >= 6) { add('csnr', 'SNR heard', P + 1, 1, 'snr', `${i8(pay[1]) / 4} dB`, 'How well the repeater heard the question (×4, signed).'); add('ctag', 'Tag', P + 2, 4, 'data', u32(pay, 2).toString(16), 'The tag from the question.'); rest('Public key', 'key', 'The answering node\'s public key (or just its first bytes).', 6); }
        } else rest('Control data', 'data', 'A control packet of a kind this decoder doesn\'t know.');
        out.summary = info.control || 'control packet';
        break;
      }
      default:
        rest(tname === 'RAW_CUSTOM' ? 'Raw custom data' : 'Payload', 'data', tname === 'RAW_CUSTOM' ? 'An application\'s own bytes, sent as-is (src/Packet.h RAW_CUSTOM).' : 'A payload type MeshCore v1.18.0 doesn\'t lay out yet.');
        out.summary = FRIENDLY[tname] || tname;
    }
    if (!out.summary) out.summary = out.friendly;
    return out;
  }

  return { decode, sha256, hmacSha256, aesEcbEncrypt, aesEcbDecrypt, encryptThenMac, macThenDecrypt, channelHash, hex, unhex, ROUTES, TYPES, FRIENDLY, GROUPS, ADV_TYPES };
});
