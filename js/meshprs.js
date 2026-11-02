/* Kelly Page -- MeshPRS frame codec and APRS-IS rendering (pure, UMD; 2026-10-29, unreleased). Spec:
 * MeshPRS/spec/MeshPRS-Spec.md (1.0 Candidate). Twin of bridge/meshprs.py: both run the shared vectors in
 * MeshPRS/test-vectors/ (frames.json, gateway.json) -- one protocol in two languages, keep them in step
 * (tests/meshprs-tests.html, bridge/test_meshprs.py).
 *
 *   decode(blob)        Uint8Array -> frame object, or throws MeshPRS.Drop(reason) (spec §9.5 receive validation)
 *   encode(frame)       the inverse (stations, vectors)
 *   check(blob, cfg)    the STATELESS part of the spec §10.1 pipeline (decode, loop/gating, trust, position validity)
 *                       then render (§10.3) -> the APRS-IS line, or throws Drop. Replay, duplicates, interval, queue and
 *                       rate need a clock and belong to the gate.
 *   cfg = { igate: 'VK4XXX-10', bindings: [{call, key}], records: [ack records], rxAt: ms, testServer }
 *   Gate(cfg)         the whole spec §10.1 pipeline on a given clock (replay, duplicates, interval, queue, rate, expiry)
 *
 * Implemented subtypes: the 1.0 required set (decision 0007) -- position, message, ack, telemetry, object/item, query
 * (parsed, never gated), status. Weather, bulletin and neighbour report are optional and drop as 'unknown subtype'.
 * The ack 'to hash' needs SHA-256: js/mcdecode.js (KellyMcDecode) is loaded first.
 *
 * window.MeshPRS = { TOCALL, DATA_TYPE, CHANNEL, Drop, callEncode, callDecode, amateurCall, toHash, degToRaw, fmtLat,
 *   fmtLon, validSymbol, decode, encode, render, check }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mcdecode.js'));
  else root.MeshPRS = factory(root.KellyMcDecode);
})(typeof self !== 'undefined' ? self : this, function (MC) {
  'use strict';
  const TOCALL = 'APZKPG', DATA_TYPE = 0xFF4D, CHANNEL = '#meshprs';   // decision 0012 (development values)
  const CHANNEL_KEY = '650fa1fd5d2c0bc01449a964a130ea1c';              // sha256('#meshprs')[0:16], spec §12.1 (hash 0xBA)
  const ALPHA = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.', MAX40 = 40n ** 9n;
  const [POS, MSG, ACK, TLM, , OBJ, , QRY, NBR, STA] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const STATUS_NAMES = ['OFF DUTY', 'EN ROUTE', 'IN SERVICE', 'RETURNING', 'COMMITTED', 'SPECIAL', 'PRIORITY', 'EMERGENCY',
    null, 'EMERGENCY CANCELLED'];
  const TLM_KINDS = { 1: 'PARM', 2: 'UNIT', 3: 'EQNS', 4: 'BITS' };
  const CALL_RE = /^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$/;        // any APRS-IS source shape (G = 1 frames)
  const BASE_RE = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/;          // = igate.js validBase

  class Drop extends Error { constructor(reason) { super(reason); this.reason = reason; } }
  const drop = r => { throw new Drop(r); };
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  const unhex = h => Uint8Array.from(h.replace(/\s/g, '').match(/../g) || [], x => parseInt(x, 16));

  // ---------------------------------------------------------------- callsigns (§4.1, M17 base-40, big-endian)
  function callEncode(text) {
    text = String(text).toUpperCase();
    if (text.length < 1 || text.length > 9 || [...text].some(c => !ALPHA.includes(c))) throw new Error(`not encodable: ${text}`);
    let v = 0n;
    for (const c of [...text].reverse()) v = v * 40n + BigInt(ALPHA.indexOf(c));
    const out = new Uint8Array(6);
    for (let i = 5; i >= 0; i--) { out[i] = Number(v & 0xFFn); v >>= 8n; }
    return out;
  }
  function callDecode(b) {
    let v = 0n;
    for (const x of b) v = (v << 8n) | BigInt(x);
    if (v === 0n || v >= MAX40) drop('bad callsign');
    let s = '';
    while (v) { s += ALPHA[Number(v % 40n)]; v /= 40n; }
    return CALL_RE.test(s) ? s : drop('bad callsign');
  }
  // §4.2: an amateur base callsign (validBase), then optionally '-' and a 1-2 character alphanumeric SSID
  function amateurCall(c) {
    const [base, ssid, extra] = c.split('-');
    return extra === undefined && base.length <= 6 && BASE_RE.test(base) && (ssid === undefined || /^[A-Z0-9]{1,2}$/.test(ssid));
  }
  const toHash = call => hex(MC.sha256(callEncode(call)).subarray(0, 2));   // §6.2 ack 'to hash'

  // ---------------------------------------------------------------- positions (§5.1 encoding, §10.3 rendering)
  // stations: v = sign(x) * floor(|x| * 2^23 / span + 0.5), clamped to i24 (span 90 lat, 180 lon)
  function degToRaw(x, span) {
    const v = Math.floor(Math.abs(x) * 2 ** 23 / span + 0.5);
    return x >= 0 ? Math.min(v, 2 ** 23 - 1) : -Math.min(v, 2 ** 23);
  }
  function fmt(v, mul, width, hemis, amb) {      // integer arithmetic (BigInt), so no float rounding can differ
    const hm = Number((BigInt(Math.abs(v)) * BigInt(mul) * 2n + 2n ** 23n) / 2n ** 24n);
    const s = (String(Math.floor(hm / 6000)).padStart(width, '0') + String(Math.floor((hm % 6000) / 100)).padStart(2, '0')
      + '.' + String(hm % 100).padStart(2, '0')).split('');
    for (const i of [[], [-1], [-2, -1], [-4, -2, -1], [-5, -4, -2, -1]][amb]) s[s.length + i] = ' ';
    return s.join('') + hemis[v < 0 ? 1 : 0];
  }
  const fmtLat = (v, amb = 0) => fmt(v, 540000, 2, 'NS', amb);
  const fmtLon = (v, amb = 0) => fmt(v, 1080000, 3, 'EW', amb);
  const validSymbol = s => typeof s === 'string' && s.length === 2 && /^[/\\0-9A-Z]$/.test(s[0]) && s.charCodeAt(1) >= 0x21 && s.charCodeAt(1) <= 0x7E;

  // ---------------------------------------------------------------- text (§9.6)
  function text(b, forbid = '|~') {
    if (b.some(c => c < 0x20 || c > 0x7E)) drop('bad text');
    const t = String.fromCharCode(...b);
    return [...forbid].some(c => t.includes(c)) ? drop('bad text') : t;
  }
  const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));
  const i24 = b => { const v = b[0] | b[1] << 8 | b[2] << 16; return v & 0x800000 ? v - 0x1000000 : v; };
  const i24b = v => Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255);
  const le = (b, signed) => { let v = 0; for (let i = b.length - 1; i >= 0; i--) v = v * 256 + b[i]; return signed && b[b.length - 1] & 0x80 ? v - 256 ** b.length : v; };
  const leb = (v, n) => { const o = new Uint8Array(n); v = v < 0 ? v + 256 ** n : v; for (let i = 0; i < n; i++) { o[i] = v % 256; v = Math.floor(v / 256); } return o; };

  // a cursor over the blob; running past the end is 'short frame'
  function reader(b, i) {
    return {
      take(n) { if (i + n > b.length) drop('short frame'); const o = b.subarray(i, i + n); i += n; return o; },
      u8() { return this.take(1)[0]; },
      rest() { const o = b.subarray(i); i = b.length; return o; },
    };
  }
  function sym(b) { const s = String.fromCharCode(...b); return validSymbol(s) ? s : drop('bad field'); }

  // ---------------------------------------------------------------- decode (§9.3, §9.5 and the subtype layouts)
  function decode(blob) {
    blob = Uint8Array.from(blob);
    if (blob.length < 9) drop('short frame');
    const h = blob[0];
    const f = { version: h >> 6, g: (h >> 5) & 1, k: (h >> 4) & 1, gating: (h >> 2) & 3, retry: h & 3, subtype: blob[1], seq: blob[2] };
    if (f.k && blob.length < 13) drop('short frame');
    if (f.version > 1) drop('unknown version');   // 1 = 1.0 Candidate; 0 = Draft 0.1, same layout, accepted until 1.0 final
    f.src = callDecode(blob.subarray(3, 9));
    f.key = f.k ? hex(blob.subarray(9, 13)) : null;
    const st = f.subtype, r = reader(blob, f.k ? 13 : 9);
    if (st >= 0xE0 && st <= 0xFE) drop('experimental subtype');
    if (![POS, MSG, ACK, TLM, OBJ, QRY, STA].includes(st)) drop('unknown subtype');
    if (st === POS) {
      f.lat = i24(r.take(3)); f.lon = i24(r.take(3)); f.sym = sym(r.take(2));
      const pf = r.u8(), amb = (pf >> 3) & 7;
      if (amb > 4) drop('bad field');
      if (pf & 0x80) drop('unknown flag');
      f.amb = amb; f.msg = (pf >> 6) & 1;
      if (pf & 1) f.alt = le(r.take(2), true);
      if (pf & 2) { f.course = r.u8(); f.speed = r.u8(); }
      if (pf & 4) f.ts = le(r.take(4));
      f.comment = text(r.rest());
    } else if (st === MSG) {
      f.to = callDecode(r.take(6)); f.msgno = r.u8();
      if (f.msgno > 127) drop('bad field');
      f.text = text(r.rest(), '{|~');
      if (f.text.length < 1 || f.text.length > 67) drop('bad text');
    } else if (st === ACK) {
      f.ackSeq = r.u8(); const b = r.u8(); f.msgno = b & 0x7F; f.rej = b >> 7; f.toHash = hex(r.take(2));
      if (r.rest().length) drop('bad field');
    } else if (st === TLM) {
      const kind = f.kind = r.u8();
      if (kind === 0) {
        const mask = r.u8();
        if (mask & 0x60) drop('unknown flag');
        f.a = [0, 1, 2, 3, 4].map(i => mask & (1 << i) ? r.u8() : null);
        f.bits = mask & 0x80 ? r.u8().toString(2).padStart(8, '0') : null;
        if (r.rest().length) drop('bad field');
      } else if (TLM_KINDS[kind]) f.text = text(r.rest(), '{|~');
      else if (kind === 5) f.profile = le(r.take(2));
      else if (kind === 0x10) f.lpp = hex(r.rest());
      else drop('bad field');
    } else if (st === OBJ) {
      const of = r.u8(), n = of >> 4;
      if (of & 8) drop('unknown flag');
      f.live = of & 1; f.item = (of >> 1) & 1;
      if (n < 1 || n > 9 || (f.item && n < 3)) drop('bad field');
      f.name = text(r.take(n));
      f.lat = i24(r.take(3)); f.lon = i24(r.take(3)); f.sym = sym(r.take(2));
      if (of & 4) f.ts = le(r.take(4));
      f.comment = text(r.rest());
    } else if (st === QRY) {
      const q = r.u8(); f.qtype = q & 0x7F;
      if (q & 0x80) f.target = callDecode(r.take(6));
      if (f.qtype > 5 || r.rest().length) drop('bad field');
    } else if (st === STA) {
      const c = r.u8();
      if (c & 0x70) drop('unknown flag');
      f.code = c & 0x0F;
      if (f.code > 9) drop('bad field');
      if (c & 0x80) { f.lat = i24(r.take(3)); f.lon = i24(r.take(3)); }
      f.text = text(r.rest());
      if (f.text.length > 62) drop('bad text');
    }
    return f;
  }

  // ---------------------------------------------------------------- encode (the inverse)
  function encode(f) {
    const k = f.key ? 1 : 0, out = [];
    const put = b => { for (const x of b) out.push(x); };
    out.push(((f.version ?? 1) << 6) | ((f.g || 0) << 5) | (k << 4) | ((f.gating || 0) << 2) | (f.retry || 0), f.subtype, f.seq);
    put(callEncode(f.src));
    if (k) put(unhex(f.key));
    const st = f.subtype, has = x => f[x] !== undefined && f[x] !== null;
    if (st === POS) {
      put(i24b(f.lat)); put(i24b(f.lon)); put(ascii(f.sym));
      out.push((has('alt') ? 1 : 0) | (has('course') ? 2 : 0) | (has('ts') ? 4 : 0) | ((f.amb || 0) << 3) | ((f.msg || 0) << 6));
      if (has('alt')) put(leb(f.alt, 2));
      if (has('course')) out.push(f.course, f.speed);
      if (has('ts')) put(leb(f.ts, 4));
      put(ascii(f.comment || ''));
    } else if (st === MSG) { put(callEncode(f.to)); out.push(f.msgno); put(ascii(f.text)); }
    else if (st === ACK) { out.push(f.ackSeq, f.msgno | ((f.rej || 0) << 7)); put(unhex(f.toHash)); }
    else if (st === TLM) {
      out.push(f.kind);
      if (f.kind === 0) {
        out.push(f.a.reduce((m, a, i) => a === null ? m : m | (1 << i), 0) | (f.bits ? 0x80 : 0));
        for (const a of f.a) if (a !== null) out.push(a);
        if (f.bits) out.push(parseInt(f.bits, 2));
      } else if (TLM_KINDS[f.kind]) put(ascii(f.text));
      else if (f.kind === 5) put(leb(f.profile, 2));
      else put(unhex(f.lpp || ''));
    } else if (st === OBJ) {
      out.push((f.name.length << 4) | (has('ts') ? 4 : 0) | ((f.item || 0) << 1) | (f.live === undefined ? 1 : f.live));
      put(ascii(f.name)); put(i24b(f.lat)); put(i24b(f.lon)); put(ascii(f.sym));
      if (has('ts')) put(leb(f.ts, 4));
      put(ascii(f.comment || ''));
    } else if (st === QRY) { out.push(f.qtype | (f.target ? 0x80 : 0)); if (f.target) put(callEncode(f.target)); }
    else if (st === STA) {
      out.push(f.code | (has('lat') ? 0x80 : 0));
      if (has('lat')) { put(i24b(f.lat)); put(i24b(f.lon)); }
      put(ascii(f.text || ''));
    } else throw new Error(`subtype ${st} not implemented`);
    return Uint8Array.from(out);
  }

  // ---------------------------------------------------------------- render (§10.3)
  const fit = (t, limit) => t.trim().slice(0, limit).trimEnd();     // trim, truncate, trim trailing spaces again
  const p3 = n => String(n).padStart(3, '0');
  function posExt(f) {
    let ext = '';
    if (f.course !== undefined) ext += p3(Math.floor((f.course * 720 + 256) / 512) || 360) + '/' + p3(Math.floor((f.speed * 2000 + 1852) / 3704));
    if (f.alt !== undefined) {
      const ft = Math.floor((Math.abs(f.alt) * 20000 + 3048) / 6096);
      ext += '/A=' + (f.alt >= 0 ? String(ft).padStart(6, '0') : '-' + String(Math.min(ft, 99999)).padStart(5, '0'));
    }
    return ext;
  }
  const latlon = (lat, lon, s, amb = 0) => fmtLat(lat, amb) + s[0] + fmtLon(lon, amb) + s[1];
  const pad9 = c => c.padEnd(9, ' ');
  function ddhhmm(sec) {
    const d = new Date(sec * 1000), z = n => String(n).padStart(2, '0');
    return z(d.getUTCDate()) + z(d.getUTCHours()) + z(d.getUTCMinutes()) + 'z';
  }

  // the info field for a frame that passed the checks (§5.3, §6.5, §7.3, §8.2, §8.4, §10.3)
  function render(f, cfg) {
    const st = f.subtype;
    if (st === POS) {
      const ext = posExt(f), tail = ext ? fit(ext + f.comment.trim(), 43) : fit(f.comment, 43);
      return (f.msg ? '=' : '!') + latlon(f.lat, f.lon, f.sym, f.amb) + tail;
    }
    if (st === MSG) return `:${pad9(f.to)}:${f.text}` + (f.msgno ? `{${f.msgno}` : '');
    if (st === ACK) return `:${pad9(f._record.sender)}:${f.rej ? 'rej' : 'ack'}${f._record.id}`;
    if (st === TLM) {
      if (f.kind === 0) return `T#${p3(f.seq)},${f.a.map(v => v === null ? '' : p3(v)).join(',')},${f.bits || '00000000'}`;
      return `:${pad9(f.src)}:${TLM_KINDS[f.kind]}.${f.text}`;
    }
    if (st === OBJ) {
      const rx = Math.floor(cfg.rxAt / 1000), ts = f.ts !== undefined && Math.abs(f.ts - rx) <= 3600 ? f.ts : rx;
      const pos = latlon(f.lat, f.lon, f.sym), c = fit(f.comment, 43);
      if (f.item) return ')' + f.name + (f.live ? '!' : '_') + pos + c;
      return ';' + f.name.padEnd(9, ' ') + (f.live ? '*' : '_') + ddhhmm(ts) + pos + c;
    }
    if (st === STA) {
      if (f.code === 8) return '>' + fit(f.text, 62);
      const name = STATUS_NAMES[f.code];
      if (f.lat !== undefined) return '!' + latlon(f.lat, f.lon, '/>') + fit(`${name} ${f.text}`, 43);
      return '>' + fit(`${name} ${f.text}`, 62);
    }
    return drop('not gated');
  }

  // ---------------------------------------------------------------- the stateless gate (§10.1 steps 1-4)
  // cfg.adverts (optional, Kelly: decision 0015) = { fullKeyHex: last advert ms } and cfg.advertMaxMs: a binding counts
  // only when its key's advert was heard that recently (spec §4.3 item 5), else 'untrusted'.
  const check = (blob, cfg) => { const f = verify(blob, cfg); validity(f); return line(f, cfg); };
  const line = (f, cfg) => `${f.src}>${TOCALL},qAO,${cfg.igate}:${render(f, cfg)}`;
  function validity(f) { if (f.lat === 0 && f.lon === 0) drop('0,0'); }   // step 4 (the stateless part)
  function verify(blob, cfg) {
    const f = decode(blob);                                              // 1. decode and validate
    if (!f.g && !amateurCall(f.src)) drop('bad callsign');
    if (f.g) drop('looped');                                             // 2. loop and gating
    if (f.gating === 1 || f.gating === 3) drop('nogate');
    if (f.gating === 2 && !cfg.testServer) drop('test');
    if (f.subtype === QRY || f.subtype === NBR) drop('not gated');
    if (f.subtype === TLM && (f.kind === 5 || f.kind === 0x10)) drop('not gated');   // no profile registry yet (Q28)
    const base = f.src.split('-')[0];                                    // 3. trust
    const fresh = b => !cfg.adverts || cfg.now - (cfg.adverts[b.key.toLowerCase()] || -Infinity) <= cfg.advertMaxMs;
    const binds = (cfg.bindings || []).filter(b => b.call.toUpperCase() === base && fresh(b));
    if (!binds.length) drop('untrusted');
    const keyOk = () => binds.some(b => b.key.toUpperCase().startsWith(f.key));
    if (f.subtype === ACK) {
      const rec = (cfg.records || []).find(r => r.seq === f.ackSeq && r.msgno === f.msgno && r.toHash.toUpperCase() === f.toHash && r.addressee === f.src);
      if (!rec) drop('unknown ack');
      f._record = rec;
      if (f.k && !keyOk()) drop('key mismatch');
    } else {
      if (!f.k) drop('no key');
      if (!keyOk()) drop('key mismatch');
    }
    return f;
  }

  // ---------------------------------------------------------------- the gate (§10.1, all steps, on a given clock)
  // Gate(cfg) -> { offer(blob, rxAt), due(now), records, stats }. cfg = check()'s cfg (bindings, igate, adverts, ...) plus
  // the timings below; cfg.rng() for the jitter (tests pass () => 0). Bindings, adverts and records may be functions,
  // read on every offer, so the page's lists stay live.
  //   offer   steps 1-7: -> { verdict: 'queued', item } or { verdict: 'drop', reason, f? }
  //   due     steps 8-9 at `now`: -> { send: [item], drop: [{ item, reason }] }; an item = { f, line, rxAt, dueAt, prio }
  // A queued message is remembered (30 min) so the station's ack can be rendered (§6.2); the interval is taken when a
  // frame is queued, so a second frame waiting behind it is an 'interval' drop, not a second line.
  const GATE = { jitterS: 5, waitS: 10, holdS: 15, perStationS: 120, floorS: 30, moveM: 500, bucketS: 5, burst: 3, queueMax: 20,
    windowMs: 600000, recordMs: 1800000, advertMaxMs: 86400000 };
  const RAD = Math.PI / 180, deg = (v, span) => v * span / 2 ** 23;
  function distM(a, b) {
    const la1 = deg(a.lat, 90) * RAD, la2 = deg(b.lat, 90) * RAD, dla = la2 - la1, dlo = (deg(b.lon, 180) - deg(a.lon, 180)) * RAD;
    const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // the per-station interval key: one per service, so a station's PARM/UNIT/EQNS/BITS, or an owner's several objects,
  // aren't each other's interval drops
  const ivKey = f => [f.src, f.subtype, f.subtype === TLM ? f.kind : f.subtype === OBJ ? f.name : ''].join('|');
  const exempt = f => f.subtype === MSG || f.subtype === ACK || (f.subtype === STA && (f.code === 7 || f.code === 9));
  const sameBody = (a, b) => a.length === b.length && a.every((x, i) => i === 0 ? (x & 0xFC) === (b[0] & 0xFC) : x === b[i]);

  function Gate(cfg0) {
    const cfg = Object.assign({}, GATE, cfg0), rng = cfg.rng || Math.random;
    const val = x => typeof x === 'function' ? x() : x;
    const seqs = new Map(), dups = new Map(), last = new Map(), queue = [], records = [];
    const bucket = { tokens: cfg.burst, at: null };
    const stats = { heard: 0, queued: 0, sent: 0, drops: {} };
    const dropIt = (reason, f) => { stats.drops[reason] = (stats.drops[reason] || 0) + 1; return { verdict: 'drop', reason, f }; };
    function prune(now) {
      for (const [k, v] of dups) if (now - v > cfg.windowMs) dups.delete(k);
      for (let i = records.length - 1; i >= 0; i--) if (now - records[i].at > cfg.recordMs) records.splice(i, 1);
      if (last.size > 500) last.delete(last.keys().next().value);
      if (seqs.size > 500) seqs.delete(seqs.keys().next().value);
    }
    // §9.3.1: d = (seq - last) mod 256; newer accepted, older within 10 min 'replayed' -- unless it is the second of two
    // consecutive replayed drops and newer than the first (a reboot): then resync to it
    function replay(f, blob, now) {
      const id = f.key || f.src, s = seqs.get(id);
      if (!s || now - s.at >= cfg.windowMs) { seqs.set(id, { last: f.seq, at: now, body: blob, rep: null }); return null; }
      let d = (f.seq - s.last + 256) % 256;
      if (d === 0) { if (sameBody(blob, s.body)) return null; d = 128; }     // same seq, other body = older
      if (d <= 127) { Object.assign(s, { last: f.seq, at: now, body: blob, rep: null }); return null; }
      if (s.rep !== null) { const d2 = (f.seq - s.rep + 256) % 256; if (d2 >= 1 && d2 <= 127) { Object.assign(s, { last: f.seq, at: now, body: blob, rep: null }); return null; } }
      s.rep = f.seq;
      return 'replayed';
    }
    function offer(blob, rxAt) {
      const now = rxAt; stats.heard++; prune(now);
      const c = Object.assign({}, cfg, { igate: val(cfg.igate), bindings: val(cfg.bindings), adverts: val(cfg.adverts), now, rxAt,
        records: records.concat(val(cfg.records) || []) });
      let f;
      try { f = verify(blob, c); } catch (e) { if (e instanceof Drop) return dropIt(e.reason); throw e; }   // steps 1-3
      blob = Uint8Array.from(blob);
      const r = replay(f, blob, now); if (r) return dropIt(r, f);                                            // 4
      try { validity(f); } catch (e) { return dropIt(e.reason, f); }
      const dk = `${f.key || f.src}|${f.seq}`;                                                               // 5
      if (dups.has(dk)) return dropIt('duplicate', f);
      dups.set(dk, now);
      if (!exempt(f)) {                                                                                      // 6
        const k = ivKey(f), l = last.get(k);
        const moved = l && l.pos && f.lat !== undefined && distM(l.pos, f) > cfg.moveM;
        if (l && now - l.at < (moved ? cfg.floorS : cfg.perStationS) * 1000) return dropIt('interval', f);
      }
      const prio = exempt(f) && f.subtype === STA ? 1 : 0;                                                   // 7
      if (queue.length >= cfg.queueMax) {
        const low = prio ? queue.findIndex(q => !q.prio) : -1;    // an emergency pushes out a lower-priority frame
        if (low < 0) return dropIt('queue full', f);
        queue.splice(low, 1); stats.drops['queue full'] = (stats.drops['queue full'] || 0) + 1;
      }
      const item = { f, blob, line: line(f, c), rxAt, dueAt: rxAt + rng() * cfg.jitterS * 1000, prio };
      if (!exempt(f)) last.set(ivKey(f), { at: now, pos: f.lat !== undefined ? { lat: f.lat, lon: f.lon } : null });
      if (f.subtype === MSG && f.msgno) records.push({ seq: f.seq, msgno: f.msgno, toHash: toHash(f.src), addressee: f.to, sender: f.src, id: String(f.msgno), at: now });
      queue.push(item); queue.sort((a, b) => b.prio - a.prio || a.dueAt - b.dueAt); stats.queued++;
      return { verdict: 'queued', item };
    }
    function take(now) {          // token bucket: one per bucketS, up to burst
      if (bucket.at !== null) bucket.tokens = Math.min(cfg.burst, bucket.tokens + (now - bucket.at) / (cfg.bucketS * 1000));
      bucket.at = now;
      if (bucket.tokens < 1) return false;
      bucket.tokens--; return true;
    }
    function due(now) {
      const send = [], gone = [];
      for (let i = 0; i < queue.length;) {
        const q = queue[i];
        if (q.dueAt > now) { i++; continue; }
        if (take(now)) { send.push(queue.splice(i, 1)[0]); stats.sent++; continue; }
        const why = now > q.dueAt + cfg.waitS * 1000 ? 'rate' : now > q.rxAt + cfg.holdS * 1000 ? 'expired' : null;
        if (why) { gone.push({ item: queue.splice(i, 1)[0], reason: why }); stats.drops[why] = (stats.drops[why] || 0) + 1; } else i++;
      }
      for (let i = queue.length - 1; i >= 0; i--)                       // step 9 for frames still waiting on jitter
        if (now > queue[i].rxAt + cfg.holdS * 1000) { gone.push({ item: queue.splice(i, 1)[0], reason: 'expired' }); stats.drops.expired = (stats.drops.expired || 0) + 1; }
      return { send, drop: gone };
    }
    return { offer, due, records, stats, queue };
  }

  return { TOCALL, DATA_TYPE, CHANNEL, CHANNEL_KEY, GATE, Drop, hex, unhex, callEncode, callDecode, amateurCall, toHash, degToRaw, fmtLat,
    fmtLon, validSymbol, decode, encode, render, verify, check, Gate };
});
