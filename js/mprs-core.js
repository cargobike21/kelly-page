/* Kelly Page -- LoRa Mesh > 📍 MeshPRS tab, the pure part (UMD; 2026-10-31, unreleased). No DOM: the station tracker,
 * the beacon-interval / missed-frame maths, the byte dissector, APRS symbol sprites and the TNC2 preview. The wire
 * format is js/meshprs.js (= MeshPRS/spec/MeshPRS-Spec.md, the 1.0 Candidate): this file never parses a frame itself,
 * it asks MeshPRS.decode and lays the bytes out beside the fields it returns. UI: js/mprs-ui.js. Tests:
 * tests/mprs-core-test.js (Node).
 *
 *   KellyMPRS.Tracker({ historyN, packetsN, expectS })  -> { frame(ev), advert(ev), gate(ev), stations(), station(id),
 *                       packets(), json(), load(j), clear() }
 *     frame(ev)   ev = { at, blob, via, snr, rssi, hops, path, raw }: one MeshPRS frame heard -> the packet record
 *     advert(ev)  ev = { at, key, call, sym, comment, lat, lon, name, snr, hops }: a profile-0 advert from a listed node
 *     gate(ev)    an APRS iGate verdict (js/igateui.js onMprs: { t, hex, at, verdict, reason, line, dry, packet })
 *   KellyMPRS.dissect(blob)   -> [{ key, label, start, len, hex, value, group, explain }] every byte of a frame, in order
 *   KellyMPRS.sprite(sym)     -> { sheet, col, row, overlay } for the hessu/aprs-symbols sheets (vendor/aprs-symbols-*)
 *   KellyMPRS.tnc2(f, igate, rxAt) -> { line } or { why }: what the spec §10.3 rendering makes of a decoded frame
 *   KellyMPRS.beacon(station, now) -> { expectS, lastS, avgS, overdue, missed, heard, pct }
 *
 * Missed frames come from seq (spec §9.3: one counter per originator for every subtype), so "missed" = frames that
 * station sent that this Kelly didn't hear -- any subtype, not just positions. A jump of 128 or more is a reboot or a
 * wrap, never counted as missed (spec §9.3.1).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./meshprs.js'));
  else root.KellyMPRS = factory(root.MeshPRS);
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  const SUB = { 0: 'Position', 1: 'Message', 2: 'Ack', 3: 'Telemetry', 4: 'Weather', 5: 'Object / Item', 6: 'Bulletin', 7: 'Query', 8: 'Neighbour report', 9: 'Emergency / Status', 10: 'Track history' };
  const GATING = ['may be gated', 'do not gate (NOGATE)', 'test only', 'reserved (= do not gate)'];
  const QUERIES = ['?APRS?', '?IGATE?', '?WX?', '?PING?', 'station position', 'station status'];
  // what each drop reason means, for people -- the reasons are the spec's (§15.2) and Kelly's own
  const WHY = {
    'short frame': 'The frame is shorter than its header and fixed fields -- cut short on air, or not MeshPRS at all.',
    'unknown version': 'The top two bits of byte 0 give a version this Kelly does not speak (it speaks 0 and 1).',
    'bad callsign': 'A callsign field is 0 or too big for base-40, or the source is not a valid amateur callsign.',
    'unknown subtype': 'Byte 1 names a service this Kelly does not decode yet (weather, bulletin and neighbour come later).',
    'experimental subtype': 'Subtypes 0xE0-0xFE are private experiments: never gated to APRS-IS.',
    'bad field': 'A field holds a value outside its defined range (ambiguity over 4, message number over 127, a bad name length...).',
    'unknown flag': 'A reserved flag bit is set, so the rest of the frame cannot be read safely: never gated.',
    'bad text': 'Text is not printable ASCII, or it has | or ~, or is too long. Gateways drop it rather than guess.',
    looped: 'G = 1: a gateway built this frame from APRS-IS. Gating it back would loop it.',
    nogate: 'The sender set "do not gate" -- the MeshPRS NOGATE.',
    test: 'A test frame: it may go to a private test server only, never to live APRS-IS.',
    'not gated': 'Queries and neighbour reports stay on the mesh by design.',
    'no position': 'Weather without a position cannot be gated.',
    'text profile': 'Compact text (GRP_TXT) frames are never gated in 1.0: anyone can type them.',
    untrusted: 'The callsign is not bound to a node key on your iGate list (or its advert is not recent). Add it on the APRS iGate page.',
    'no key': 'The frame has no key prefix (K = 0), so it is mesh-only and cannot be gated.',
    'key mismatch': "The frame's key prefix does not match the node key bound to that callsign: misconfigured or spoofed.",
    'unknown ack': 'An ack for a message this gateway never carried.',
    replayed: 'Its seq is older than the last one heard from this sender in the last 10 min: a replay.',
    duplicate: 'Already heard (the same sender and seq) in the last 10 min -- a retry or a second path.',
    interval: 'This station was gated less than its interval ago (5 s).',
    'queue full': 'The iGate queue is full.', rate: 'The global rate limit (one line per second, burst 10).',
    expired: 'Not sent within 15 s of hearing it, so APRS-IS could no longer merge it with other gateways\' copies.',
    'no fix': 'No GPS fix.', 'out of range': 'The position is outside the earth.', '0,0': 'Exactly 0,0: no real fix.', stale: 'The position is too old (a track history entry more than 30 min old, or every entry of one).',
  };

  // ---------------------------------------------------------------- symbols (hessu/aprs-symbols: 16 x 6 per sheet, code - 0x21)
  function sprite(sym) {
    const s = String(sym || '/.'), t = s[0], c = s.charCodeAt(1) || 0x2E, i = Math.max(0, Math.min(93, c - 33));
    const overlay = /[0-9A-Z]/.test(t) ? t : null;
    const o = overlay ? overlay.charCodeAt(0) - 33 : null;
    return { sheet: t === '/' ? 0 : 1, col: i % 16, row: Math.floor(i / 16), overlay, ocol: o === null ? null : o % 16, orow: o === null ? null : Math.floor(o / 16) };
  }

  // ---------------------------------------------------------------- the TNC2 line the spec renders (§10.3, the igate's own call)
  function tnc2(f, igate, rxAt) {
    if (!M) return { why: 'MeshPRS codec not loaded' };
    try {
      const info = M.render(f, { rxAt: rxAt || Date.now() });   // a track history renders one line per entry (spec §5.8)
      return { line: [].concat(info).map(i => `${f.src}>${M.TOCALL},qAO,${igate || 'N0CALL'}:${i}`).join('\n') };
    }
    catch (e) { return { why: (e && e.reason) || String(e && e.message || e) }; }
  }

  // ---------------------------------------------------------------- dissector: every byte of a frame, in order
  // decode() keeps lat / lon as the raw i24 (spec §10.3 renders from it); degrees only for people and maps
  const latDeg = v => v * 90 / 8388608, lonDeg = v => v * 180 / 8388608;
  const hx = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ').toUpperCase();
  function dissect(blob) {
    blob = Uint8Array.from(blob || []);
    const out = [], add = (key, label, start, len, value, group, explain) => out.push({ key, label, start, len, hex: hx(blob.subarray(start, start + len)), value, group, explain });
    let f = null, err = '';
    try { f = M.decode(blob); } catch (e) { err = (e && e.reason) || String(e && e.message || e); }
    if (blob.length < 1) return { fields: out, f, err: err || 'empty' };
    const h = blob[0], ver = h >> 6, g = (h >> 5) & 1, k = (h >> 4) & 1, gating = (h >> 2) & 3, retry = h & 3;
    add('hdr', 'Header', 0, 1, `v${ver} · G ${g} · K ${k} · ${GATING[gating]} · retry ${retry}`, 'hdr',
      `bits 7-6 version (${ver}), bit 5 G = from APRS-IS (${g}), bit 4 K = key prefix follows (${k}), bits 3-2 gating (${gating}), bits 1-0 retry (${retry}).`);
    if (blob.length > 1) add('sub', 'Subtype', 1, 1, `0x${blob[1].toString(16).padStart(2, '0')} ${SUB[blob[1]] || (blob[1] >= 0xE0 && blob[1] <= 0xFE ? 'experimental' : 'reserved')}`, 'hdr', 'Which service this frame is (spec §9.4).');
    if (blob.length > 2) add('seq', 'Seq', 2, 1, String(blob[2]), 'hdr', 'Per-sender counter, +1 for every new frame of any subtype; a retry keeps it. Duplicate key, replay check and telemetry T#.');
    if (blob.length >= 9) add('src', 'Source', 3, 6, f ? f.src : (() => { try { return M.callDecode(blob.subarray(3, 9)); } catch { return '?'; } })(), 'call',
      'The callsign, 6 bytes base-40 (the M17 address code), big-endian -- the one big-endian field.');
    let o = 9;
    if (k && blob.length >= 13) { add('key', 'Key prefix', 9, 4, hx(blob.subarray(9, 13)).replace(/ /g, ''), 'key', 'The first 4 bytes of the sender\'s node key. The gateway checks it against the key bound to that callsign.'); o = 13; }
    if (!f) { if (o < blob.length) add('rest', 'Body (not decoded)', o, blob.length - o, `${blob.length - o} bytes`, 'bad', err ? WHY[err] || err : ''); return { fields: out, f, err }; }
    const r = len => { const s = o; o += len; return s; };
    if (f.subtype === 0) {
      add('lat', 'Latitude', r(3), 3, `${latDeg(f.lat).toFixed(5)}° (raw ${f.lat})`, 'pos', 'i24 little-endian, degrees = v × 90 / 2²³ (about 1.2 m steps).');
      add('lon', 'Longitude', r(3), 3, `${lonDeg(f.lon).toFixed(5)}° (raw ${f.lon})`, 'pos', 'i24 little-endian, degrees = v × 180 / 2²³ (about 2.4 m steps at the equator).');
      add('sym', 'Symbol', r(2), 2, f.sym, 'sym', 'APRS symbol table (or overlay), then symbol code -- two ASCII characters, as in APRS.');
      const pf = blob[o];
      add('pf', 'Position flags', r(1), 1, [pf & 1 ? 'ALT' : '', pf & 2 ? 'CSE' : '', pf & 4 ? 'TS' : '', f.amb ? `ambiguity ${f.amb}` : '', f.msg ? 'MSG' : ''].filter(Boolean).join(' · ') || 'none', 'flags',
        'bit 0 altitude follows, bit 1 course + speed follow, bit 2 timestamp follows, bits 3-5 ambiguity, bit 6 can receive messages.');
      if (f.alt !== undefined) add('alt', 'Altitude', r(2), 2, `${f.alt} m`, 'pos', 'i16 little-endian, metres.');
      if (f.course !== undefined) { add('crs', 'Course', r(1), 1, `${Math.round(f.course * 360 / 256)}°`, 'pos', 'degrees = v × 360 / 256 (1.4° steps), 0 = north.'); add('spd', 'Speed', r(1), 1, `${f.speed} km/h`, 'pos', 'km/h; 255 = 255 or more.'); }
      if (f.ts !== undefined) add('ts', 'Timestamp', r(4), 4, new Date(f.ts * 1000).toISOString().replace('.000', ''), 'time', 'The sender\'s Unix time. Informative only: node clocks are often wrong, so gateways never use it.');
    } else if (f.subtype === 1) {
      add('to', 'To', r(6), 6, f.to, 'call', 'The addressee, base-40.'); add('no', 'Message no.', r(1), 1, String(f.msgno), 'flags', '0 = no ack wanted; 1-127 = ack me.');
    } else if (f.subtype === 2) {
      add('aseq', 'Acked seq', r(1), 1, String(f.ackSeq), 'hdr', 'The seq of the message frame being acked.');
      add('ano', 'Message no.', r(1), 1, `${f.msgno}${f.rej ? ' (reject)' : ''}`, 'flags', 'bit 7 = reject; bits 0-6 = the message number.');
      add('ath', 'To hash', r(2), 2, f.toHash, 'key', 'The first 2 bytes of SHA-256 of the original sender\'s callsign: tells whose message it acks.');
    } else if (f.subtype === 3) {
      add('kind', 'Kind', r(1), 1, ['values', 'PARM', 'UNIT', 'EQNS', 'BITS', 'profile'][f.kind] || `0x${f.kind.toString(16)}`, 'flags', 'Telemetry kind: 0 = values; 1-4 = the definition messages; 5 = profile; 0x10 = CayenneLPP.');
      if (f.kind === 0) { add('mask', 'Mask', r(1), 1, `analogs ${f.a.map((v, i) => v === null ? '' : i + 1).filter(Boolean).join(',') || 'none'}${f.bits ? ' + bits' : ''}`, 'flags', 'bits 0-4 which analog values follow, bit 7 a digital byte follows.');
        f.a.forEach((v, i) => { if (v !== null) add(`a${i}`, `A${i + 1}`, r(1), 1, String(v), 'pos', 'An 8-bit raw analog value (APRS T# style).'); });
        if (f.bits) add('bits', 'Digital bits', r(1), 1, f.bits, 'flags', 'Eight digital channels.'); }
    } else if (f.subtype === 5) {
      const n = blob[o] >> 4;
      add('of', 'Object flags', r(1), 1, `${f.item ? 'item' : 'object'} · ${f.live ? 'live' : 'killed'} · name ${n}`, 'flags', 'bits 7-4 name length, bit 2 timestamp follows, bit 1 item, bit 0 live.');
      add('name', 'Name', r(n), n, f.name, 'call', 'The object or item name, printable ASCII.');
      add('lat', 'Latitude', r(3), 3, `${latDeg(f.lat).toFixed(5)}°`, 'pos', 'As the position frame.'); add('lon', 'Longitude', r(3), 3, `${lonDeg(f.lon).toFixed(5)}°`, 'pos', 'As the position frame.');
      add('sym', 'Symbol', r(2), 2, f.sym, 'sym', 'APRS symbol table, then code.');
      if (f.ts !== undefined) add('ts', 'Timestamp', r(4), 4, new Date(f.ts * 1000).toISOString().replace('.000', ''), 'time', 'Used for the APRS object time when it is plausible.');
    } else if (f.subtype === 7) {
      add('q', 'Query', r(1), 1, QUERIES[f.qtype] || String(f.qtype), 'flags', 'bit 7 a target callsign follows; bits 0-6 the query type. Never gated.');
      if (f.target) add('tgt', 'Target', r(6), 6, f.target, 'call', 'The station asked about.');
    } else if (f.subtype === 9) {
      add('code', 'Status code', r(1), 1, String(f.code), 'flags', 'bits 0-3 the status (7 = EMERGENCY), bit 7 a position follows.');
      if (f.lat !== undefined) { add('lat', 'Latitude', r(3), 3, `${latDeg(f.lat).toFixed(5)}°`, 'pos', ''); add('lon', 'Longitude', r(3), 3, `${lonDeg(f.lon).toFixed(5)}°`, 'pos', ''); }
    } else if (f.subtype === 10) {
      add('sym', 'Symbol', r(2), 2, f.sym, 'sym', 'APRS symbol table (or overlay), then code -- one for every entry.');
      add('hf', 'History flags', r(1), 1, [blob[o - 1] & 1 ? 'ALT' : '', f.amb ? `ambiguity ${f.amb}` : '', f.msg ? 'MSG' : ''].filter(Boolean).join(' · ') || 'none', 'flags',
        'bit 0 each entry carries an altitude, bits 1-3 ambiguity, bit 4 can receive messages, bits 5-7 reserved.');
      add('cnt', 'Entries', r(1), 1, String(f.entries.length), 'flags', '1-8 positions the sender missed (no repeater echo, retry included), oldest first.');
      f.entries.forEach((e, i) => {
        add(`age${i}`, `#${i + 1} age`, r(2), 2, `${e.age} s ago`, 'time', 'Seconds before this frame was sent (the sender\'s own uptime clock). Gateways stamp it receive time - age, to the minute; over 1800 s is not gated.');
        add(`lat${i}`, `#${i + 1} latitude`, r(3), 3, `${latDeg(e.lat).toFixed(5)}°`, 'pos', 'As the position frame.');
        add(`lon${i}`, `#${i + 1} longitude`, r(3), 3, `${lonDeg(e.lon).toFixed(5)}°`, 'pos', 'As the position frame.');
        if (e.alt !== undefined) add(`alt${i}`, `#${i + 1} altitude`, r(2), 2, `${e.alt} m`, 'pos', 'i16 little-endian, metres.');
      });
    }
    if (o < blob.length) add('text', f.subtype === 0 || f.subtype === 5 ? 'Comment' : 'Text', o, blob.length - o, JSON.stringify(String.fromCharCode(...blob.subarray(o))), 'text', 'Printable ASCII to the end of the frame.');
    return { fields: out, f, err };
  }

  // ---------------------------------------------------------------- distance / bearing
  const R = 6371.0088, rad = d => d * Math.PI / 180;
  function distKm(a, b) {
    const dl = rad(b.lat - a.lat), dn = rad(b.lon - a.lon), x = Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat)), x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // ---------------------------------------------------------------- beacon interval
  const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length & 1 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function beacon(st, now, expectS0) {
    const iv = st.intervals || [], med = median(iv), expectS = st.expectS || (med && iv.length >= 2 ? Math.max(5, Math.round(med)) : expectS0 || 120);
    const lastS = iv.length ? iv[iv.length - 1] : null, avgS = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : null;
    const sinceS = (now - st.last) / 1000, heard = st.frames || 0, missed = st.missed || 0;
    return { expectS, lastS, avgS, sinceS, overdue: sinceS > expectS * 1.5, missed, heard, pct: heard + missed ? Math.round(100 * heard / (heard + missed)) : null };
  }

  // ---------------------------------------------------------------- the tracker
  function Tracker(o = {}) {
    const HIST = o.historyN || 500, PKTS = o.packetsN || 400, IV = 20;
    let stations = new Map(), packets = [], nextId = 1;
    const posOf = f => (f && f.lat !== undefined && (f.subtype === 0 || f.subtype === 5 || f.subtype === 9) && !(f.lat === 0 && f.lon === 0) ? { lat: latDeg(f.lat), lon: lonDeg(f.lon) } : null);
    const idOf = f => (f.subtype === 5 ? `obj:${f.name}` : f.src);
    function station(id, kind) {
      let s = stations.get(id);
      if (!s) { s = { id, call: id.replace(/^obj:/, ''), kind, first: 0, last: 0, count: 0, frames: 0, missed: 0, dups: 0, intervals: [], track: [], gated: 0, dry: 0, dropped: 0, lastGate: null, seq: null };
        stations.set(id, s); }
      return s;
    }
    function point(s, p, at, f) {
      const t = s.track, last = t[t.length - 1];
      const pt = { lat: p.lat, lon: p.lon, at, course: f && f.course !== undefined ? Math.round(f.course * 360 / 256) : null, speed: f ? f.speed ?? null : null, alt: f ? f.alt ?? null : null };
      if (last && last.lat === pt.lat && last.lon === pt.lon) { last.at = at; Object.assign(last, { course: pt.course ?? last.course, speed: pt.speed ?? last.speed, alt: pt.alt ?? last.alt }); }
      else { t.push(pt); if (t.length > HIST) t.splice(0, t.length - HIST); }
      // no course in the frame: the heading from the last two points, so the arrow still points the way it went
      const a = t[t.length - 2], b = t[t.length - 1];
      s.heading = b.course != null ? b.course : a && distKm(a, b) > 0.02 ? Math.round(bearing(a, b)) : s.heading ?? null;
      s.lat = p.lat; s.lon = p.lon;
    }
    // a track history's entries (spec §5.8) slot into the track at receive time - age; the current position, heading and
    // beacon interval stay the live ones
    function backfill(s, f, at) {
      const t = s.track;
      for (const e of f.entries) {
        if (e.age < 1 || e.age > 1800 || (e.lat === 0 && e.lon === 0)) continue;
        const pt = { lat: latDeg(e.lat), lon: lonDeg(e.lon), at: at - e.age * 1000, course: null, speed: null, alt: e.alt ?? null, hist: true };
        let i = t.length; while (i > 0 && t[i - 1].at > pt.at) i--;
        t.splice(i, 0, pt);
      }
      if (t.length > HIST) t.splice(0, t.length - HIST);
    }
    function frame(ev) {
      const at = ev.at || Date.now(), blob = Uint8Array.from(ev.blob || []), hex = M ? M.hex(blob) : '';
      let f = null, err = '';
      try { f = M.decode(blob); } catch (e) { err = (e && e.reason) || String(e && e.message || e); }
      const rec = { id: nextId++, at, kind: 'frame', hex, n: blob.length, f, err, via: ev.via || '', snr: ev.snr ?? null, rssi: ev.rssi ?? null, hops: ev.hops ?? null,
        path: ev.path || null, raw: ev.raw || null, gate: null, sid: null };
      if (f) {
        const s = station(idOf(f), f.subtype === 5 ? 'object' : 'frame'), wasLast = s.last;
        rec.sid = s.id;
        // missed frames from seq (spec §9.3.1 serial arithmetic); objects share their owner's counter, so only stations count
        if (f.subtype !== 5) {
          if (s.seq !== null) {
            const d = (f.seq - s.seq + 256) % 256;
            if (d === 0) { s.dups++; rec.dup = true; }
            else if (d < 128) { s.missed += d - 1; s.seq = f.seq; }
            else rec.older = true;
          } else s.seq = f.seq;
        }
        if (!rec.dup) {
          s.count++; s.frames++;
          if (f.subtype === 0 && wasLast && s.lastPosAt) { s.intervals.push(Math.round((at - s.lastPosAt) / 1000)); if (s.intervals.length > IV) s.intervals.shift(); }
          if (f.subtype === 0) s.lastPosAt = at;
        }
        s.first = s.first || at; s.last = at; s.lastRec = rec; s.key = f.key || s.key || null;
        if (ev.snr != null) s.snr = ev.snr; if (ev.rssi != null) s.rssi = ev.rssi; if (ev.hops != null) s.hops = ev.hops; if (ev.path) s.path = ev.path;
        if (f.sym) s.sym = f.sym; if (f.comment !== undefined) s.comment = f.comment; if (f.subtype === 0) { s.msg = !!f.msg; s.amb = f.amb; }
        if (f.subtype === 9) s.status = { code: f.code, text: f.text, at };
        if (f.subtype === 5) s.live = !!f.live;
        const p = posOf(f); if (p && !rec.dup) point(s, p, at, f);
        if (f.subtype === 10 && !rec.dup) backfill(s, f, at);
      }
      packets.unshift(rec); if (packets.length > PKTS) packets.length = PKTS;
      return rec;
    }
    function advert(ev) {
      const at = ev.at || Date.now(), id = ev.call || `key:${String(ev.key || '').slice(0, 8)}`;
      const s = station(id, 'advert');
      if (s.kind === 'frame') s.adverts = (s.adverts || 0) + 1; else { s.count++; s.frames++; }
      if (s.kind === 'advert' && s.lastPosAt) { s.intervals.push(Math.round((at - s.lastPosAt) / 1000)); if (s.intervals.length > IV) s.intervals.shift(); }
      if (s.kind === 'advert') s.lastPosAt = at;
      s.first = s.first || at; s.last = Math.max(s.last, at); s.key = s.key || ev.key; s.name = ev.name || s.name;
      if (s.kind === 'advert') { s.sym = ev.sym || s.sym || '/>'; if (ev.comment != null) s.comment = ev.comment; }
      if (ev.snr != null) s.snr = ev.snr; if (ev.hops != null) s.hops = ev.hops;
      const rec = { id: nextId++, at, kind: 'advert', key: ev.key, name: ev.name || '', call: ev.call || '', lat: ev.lat, lon: ev.lon, snr: ev.snr ?? null, hops: ev.hops ?? null, sid: s.id, gate: null };
      if (ev.lat != null && ev.lon != null && !(ev.lat === 0 && ev.lon === 0) && s.kind === 'advert') point(s, ev, at, null);
      if (s.kind === 'advert') s.lastRec = rec;
      packets.unshift(rec); if (packets.length > PKTS) packets.length = PKTS;
      return rec;
    }
    // an iGate verdict -> the newest matching frame record (same bytes, heard within 20 s of it)
    function gate(ev) {
      const rec = packets.find(p => p.kind === 'frame' && p.hex === ev.hex && Math.abs(p.at - (ev.at || p.at)) < 20000);
      if (!rec) return null;
      const g = ev.t === 'offer' ? (ev.verdict === 'queued' ? { st: 'queued', line: ev.line } : { st: 'drop', reason: ev.reason })
        : ev.t === 'sent' ? { st: ev.dry ? 'dry' : 'sent', line: ev.packet } : { st: 'drop', reason: ev.reason };
      const was = rec.gate && rec.gate.st;
      rec.gate = Object.assign({ at: Date.now() }, g);
      const s = rec.sid && stations.get(rec.sid);
      if (s && was !== g.st) { if (g.st === 'sent') s.gated++; else if (g.st === 'dry') s.dry++; else if (g.st === 'drop') s.dropped++; s.lastGate = rec.gate; }
      return rec;
    }
    // stored across reloads: the stations and their tracks (not the packet log, whose blobs are the bulk)
    function json() { return { v: 1, s: [...stations.values()].map(s => Object.assign({}, s, { lastRec: null, track: s.track.slice(-200) })) }; }
    function load(j) {
      if (!j || j.v !== 1 || !Array.isArray(j.s)) return;
      for (const s of j.s) if (s && s.id && !stations.has(s.id)) stations.set(s.id, Object.assign({ intervals: [], track: [] }, s, { lastRec: null }));
    }
    return { frame, advert, gate, stations: () => [...stations.values()].sort((a, b) => b.last - a.last), station: id => stations.get(id) || null,
      packets: () => packets, json, load, clear: () => { stations = new Map(); packets = []; }, forget: id => stations.delete(id) };
  }

  return { SUB, WHY, GATING, latDeg, lonDeg, sprite, tnc2, dissect, distKm, bearing, beacon, Tracker, median };
});
