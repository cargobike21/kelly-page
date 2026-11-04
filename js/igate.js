/* Kelly Page -- APRS iGate core (pure, UMD; 2026-10-24, unreleased). js/igateui.js drives it; tests/igate-tests.html
 * checks it against bridge/igate_vectors.json, which bridge/kelly_igate.py (the APRS-IS connection) runs too -- the
 * passcode, position format and packet rules are one protocol in two languages: keep them in step.
 *
 * MeshCore positions from WHITELISTED node keys (js/igate-wl.js) -> APRS-IS, receive-only: never APRS-IS -> RF, never
 * message text, channel data or anything encrypted -- a position is the only thing this module ever takes in.
 *
 *   packet   CALL-SSID>APZKPG,qAO,IGATECALL-SSID:!DDMM.mmN/DDDMM.mmE>comment
 *            qAO per aprs-is.net/q.aspx: "Receive-only IGates will use this exclusively for all packets gated to
 *            APRS-IS", and it names translated non-APRS sources (D-PRS) -- a MeshCore advert is one. '!' = no messaging.
 *   Gate     the decisions, in order: whitelist (default deny) -> valid position (0,0, range, no fix, stale by RECEIVE
 *            time, replay = an advert timestamp older than the last one from that key; MeshCore clocks are often wrong,
 *            so their own time never ages a fix out) -> duplicate (same station + position within 30 s) -> per-station
 *            interval (5 s per station) -> a bounded queue with a random delay
 *            (iGates hearing one advert don't all send at once) -> the global token bucket (1 per second, burst 10 -- an abuse / runaway-bug guard).
 *            Every drop is counted by reason, nothing queues without bound.
 *   Stats    the page's counters (heard, gated total / last hour / today, drops, last packet per station, own beacon, telemetry),
 *            JSON-able so the page keeps them across restarts.
 *
 *   tlm*     APRS telemetry for a tracker (T# + PARM/UNIT/EQNS/BITS to itself): readings() flattens a node's CayenneLPP
 *            telemetry and repeater status into ids ('lpp:<ch>:<type>', 'st:<field>'); a mapping (the owner's, per device;
 *            PRESETS = device types to start from) puts up to 5 of them in A1-A5 as 0-255 over min..max, and 8 rules in the bits.
 *   callFromName  a callsign in a MeshCore node's name ('VK4XXX Tracker') -- the page offers such nodes for the owner's list.
 *
 * window.KellyIgate = { TOCALL, SOFTWARE, passcode, validBase, fullCall, validSymbol, fmtLat, fmtLon, position, packet,
 *   statusPacket, checkPosition, distanceM, roundPos, aprsFiUrl, TokenBucket, Stats, Gate, DEFAULTS, OWN_MIN_MIN }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyIgate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TOCALL = 'APZKPG';            // APZ = the experimental tocall range (no registered one yet); bridge/kelly_igate.py has the same
  const SOFTWARE = 'KellyPage';
  const DEFAULTS = { maxAgeMin: 10, perStationS: 5, dedupS: 30, bucketS: 1, burst: 10, jitterS: 8, waitS: 10, queueMax: 20 };
  const OWN_MIN_MIN = { zero: 15, flood: 60 };   // own beacon over MeshCore: zero-hop / flood advert, minutes (MBUG: keep floods rare)

  // ------------------------------------------------------------------ callsigns
  function passcode(call) {          // the standard APRS-IS passcode (SSID ignored) = app.js aprsPasscode
    const base = String(call || '').split('-')[0].toUpperCase(); let h = 0x73E2;
    for (let i = 0; i < base.length; i += 2) { h ^= base.charCodeAt(i) << 8; if (i + 1 < base.length) h ^= base.charCodeAt(i + 1); }
    return h & 0x7FFF;
  }
  // an amateur callsign without SSID: 1-3 prefix characters, a digit, 1-4 letters, at most 6 in all (APRS source field)
  const BASE_RE = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/;
  const validBase = c => typeof c === 'string' && c.length <= 6 && BASE_RE.test(c);
  // CALL-SSID with SSID 1-15 (the page offers -1 .. -15); null if either is wrong
  function fullCall(base, ssid) {
    const b = String(base || '').trim().toUpperCase(), s = Number(ssid);
    return validBase(b) && Number.isInteger(s) && s >= 1 && s <= 15 ? `${b}-${s}` : null;
  }
  // a symbol: table '/' or '\' or an overlay 0-9 A-Z, then a printable code
  const validSymbol = s => typeof s === 'string' && s.length === 2 && /^[/\\0-9A-Z]$/.test(s[0]) && s.charCodeAt(1) > 32 && s.charCodeAt(1) < 127;

  // ------------------------------------------------------------------ positions
  // degrees -> DDMM.mm / DDDMM.mm + hemisphere; minutes that round to 60 carry into the degrees. ambiguity 1-4 blanks
  // the hundredths, tenths, minutes and tens of minutes (APRS 1.01 ch. 6: ~18 m, 185 m, 1.85 km, 18.5 km)
  function fmt(v, degW, hemis, amb) {
    const a = Math.abs(v); let d = Math.floor(a), m = Math.round((a - d) * 6000) / 100;
    if (m >= 60) { d += 1; m = 0; }
    const s = (String(d).padStart(degW, '0') + m.toFixed(2).padStart(5, '0')).split('');
    const blank = [[], [-1], [-2, -1], [-4, -2, -1], [-5, -4, -2, -1]][Math.min(Math.max(amb | 0, 0), 4)];
    for (const i of blank) s[s.length + i] = ' ';
    return s.join('') + hemis[v < 0 ? 1 : 0];
  }
  const fmtLat = (v, amb = 0) => fmt(v, 2, 'NS', amb);
  const fmtLon = (v, amb = 0) => fmt(v, 3, 'EW', amb);
  const position = (lat, lon, sym = '/>', amb = 0) => fmtLat(lat, amb) + sym[0] + fmtLon(lon, amb) + sym[1];
  const clean = (t, max) => String(t || '').replace(/[^\x20-\x7e]/g, '').replace(/[|~]/g, '').slice(0, max).trim();
  // the gated line: the TRACKER's call as source, qAO + the iGate's login call
  function packet({ src, igate, lat, lon, sym = '/>', comment = '', amb = 0 }) {
    const c = clean(comment, 43);
    return `${src}>${TOCALL},qAO,${igate}:!${position(lat, lon, validSymbol(sym) ? sym : '/>', amb)}${c}`;
  }
  // the iGate's own status line (its own packet, so TCPIP* and the server adds qAC)
  const statusPacket = (igate, text) => `${igate}>${TOCALL},TCPIP*:>${clean(text, 62)}`;

  const R = 6371008.8, rad = x => x * Math.PI / 180;
  function distanceM(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  // own beacon privacy: decimal places kept (5 ~1 m, 3 ~100 m, 2 ~1 km, 1 ~10 km)
  const roundPos = (lat, lon, places = 5) => { const f = 10 ** Math.min(Math.max(places | 0, 0), 6); return { lat: Math.round(lat * f) / f, lon: Math.round(lon * f) / f }; };
  const aprsFiUrl = call => `https://aprs.fi/#!call=a%2F${encodeURIComponent(call)}`;

  // p = {lat, lon, at (received, ms), ts (the sender's own clock, s; optional), fix (false = the sender says no fix)}
  // prev = the last valid position from this key ({ts}); -> null when good, else the reason
  function checkPosition(p, now, maxAgeMs, prev) {
    if (!p || p.fix === false || p.lat == null || p.lon == null) return 'no fix';
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return 'out of range';
    if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) return '0,0';
    if (!(p.at > 0) || now - p.at > maxAgeMs || p.at - now > 60000) return 'stale';
    if (prev && prev.ts && p.ts && p.ts < prev.ts) return 'replayed (older advert)';
    return null;
  }

  // ------------------------------------------------------------------ the global rate limit
  function TokenBucket(everyMs, burst, now = Date.now) {
    let tokens = burst, at = now();
    const fill = () => { const t = now(); tokens = Math.min(burst, tokens + (t - at) / everyMs); at = t; };
    return {
      take() { fill(); if (tokens >= 1) { tokens -= 1; return true; } return false; },
      peek() { fill(); return tokens; },
      set(e, b) { fill(); everyMs = e; burst = b; tokens = Math.min(tokens, b); },
    };
  }

  // ------------------------------------------------------------------ counters
  const DROPS = ['notListed', 'rate', 'duplicate', 'invalid', 'unsent'];
  const MAX_STATIONS = 200, MAX_RECENT = 1000;
  function Stats(saved, now = Date.now) {
    const day = () => { const d = new Date(now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const blank = () => ({ since: now(), heard: 0, gated: 0, drops: Object.fromEntries(DROPS.map(k => [k, 0])), recent: [], day: day(), today: 0, stations: {}, own: { at: 0, n: 0 }, tlm: { at: 0, n: 0 }, last: [] });
    let S = Object.assign(blank(), saved || {});
    S.drops = Object.assign(blank().drops, S.drops); S.tlm = Object.assign(blank().tlm, S.tlm);
    const roll = () => { if (S.day !== day()) { S.day = day(); S.today = 0; } const cut = now() - 3600000; while (S.recent.length && S.recent[0] < cut) S.recent.shift(); };
    return {
      heard() { S.heard++; },
      drop(reason, why, key) { if (reason in S.drops) S.drops[reason]++; S.last.unshift({ at: now(), reason, why: why || '', key: key ? key.slice(0, 12) : '' }); S.last.length = Math.min(S.last.length, 30); },
      gated(key, call, raw) {
        roll(); S.gated++; S.today++; S.recent.push(now()); if (S.recent.length > MAX_RECENT) S.recent.shift();
        const s = S.stations[key] || (S.stations[key] = { n: 0 }); Object.assign(s, { call, at: now(), raw, n: s.n + 1 });
        const keys = Object.keys(S.stations);
        if (keys.length > MAX_STATIONS) delete S.stations[keys.reduce((a, b) => (S.stations[a].at < S.stations[b].at ? a : b))];
      },
      own() { S.own.at = now(); S.own.n++; },
      // a telemetry line gated for a station (its T# report or a definition)
      tlm(key, call, raw) { S.tlm.at = now(); S.tlm.n++; const s = S.stations[key] || (S.stations[key] = { n: 0, at: now() }); Object.assign(s, { call, tlmAt: now(), tlmRaw: raw }); },
      view() { roll(); return { ...S, lastHour: S.recent.length }; },
      json() { return S; },
      reset() { S = blank(); },
    };
  }

  // ------------------------------------------------------------------ the decisions
  // opts: {lookup(key) -> whitelist entry (enabled) or null, cfg (DEFAULTS keys), now, rand, stats (saved JSON)}
  function Gate(opts = {}) {
    const now = opts.now || Date.now, rand = opts.rand || Math.random, lookup = opts.lookup || (() => null);
    let cfg = Object.assign({}, DEFAULTS, opts.cfg);
    const stats = Stats(opts.stats, now);
    const bucket = TokenBucket(cfg.bucketS * 1000, cfg.burst, now);
    const seen = new Map(), last = new Map(), queue = [];   // key -> last valid {ts, lat, lon} / last accepted {at, lat, lon}
    const samePos = (a, b) => position(a.lat, a.lon) === position(b.lat, b.lon);
    const drop = (reason, why, key) => { stats.drop(reason, why, key); return { verdict: 'drop', reason, why }; };

    // p = {key (64 hex), lat, lon, at, ts?, fix?, src ('advert' | 'raw' | 'telemetry')} -> {verdict, reason?, why?}
    function offer(p) {
      const key = String(p && p.key || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(key)) return { verdict: 'ignored' };
      const s = seen.get(key);
      // one advert reaches Kelly twice (the raw packet + the node's own advert push): hear it once
      if (s && p.ts && s.ts === p.ts && s.lat === p.lat && s.lon === p.lon && now() - s.at < cfg.dedupS * 1000) return { verdict: 'same' };
      stats.heard();
      const entry = lookup(key);
      if (!entry) return drop('notListed', 'not on the whitelist', key);
      const bad = checkPosition(p, now(), cfg.maxAgeMin * 60000, s);
      if (bad) return drop('invalid', bad, key);
      seen.set(key, { ts: p.ts || (s && s.ts) || 0, lat: p.lat, lon: p.lon, at: now() });
      if (seen.size > 500) seen.delete(seen.keys().next().value);
      const l = last.get(key), since = l ? now() - l.at : Infinity;
      if (l && since < cfg.dedupS * 1000 && samePos(l, p)) return drop('duplicate', 'same position within ' + cfg.dedupS + ' s', key);
      if (l && since < cfg.perStationS * 1000) return drop('rate', `per-station interval (${Math.round(since / 1000)} s)`, key);
      if (queue.some(q => q.key === key)) return drop('duplicate', 'one already waiting', key);
      if (queue.length >= cfg.queueMax) return drop('rate', 'queue full', key);
      last.set(key, { at: now(), lat: p.lat, lon: p.lon });
      if (last.size > 500) last.delete(last.keys().next().value);
      queue.push({ key, entry, p: { lat: +p.lat, lon: +p.lon, src: p.src || '' }, due: now() + rand() * cfg.jitterS * 1000, queued: now() });
      return { verdict: 'queued' };
    }
    // -> the items whose delay is over AND got a token (oldest first); ones waiting longer than waitS are dropped
    function due() {
      const out = [], t = now();
      queue.sort((a, b) => a.due - b.due);
      for (let i = 0; i < queue.length;) {
        const q = queue[i];
        if (q.due > t) break;
        if (bucket.take()) { out.push(q); queue.splice(i, 1); continue; }
        if (t - q.due > cfg.waitS * 1000) { queue.splice(i, 1); stats.drop('rate', 'global rate limit', q.key); continue; }
        i++;
      }
      return out;
    }
    return {
      offer, due,
      sent(item, call, raw) { stats.gated(item.key, call, raw); },
      unsent(item, why) { stats.drop('unsent', why, item.key); },
      setCfg(c) { cfg = Object.assign({}, DEFAULTS, c); bucket.set(cfg.bucketS * 1000, cfg.burst); },
      pending: () => queue.length,
      stats,
    };
  }

  // ------------------------------------------------------------------ callsign in a node name
  // 'VK4XXX Tracker', 'vk4xxx-9 car' -> {base, ssid} (ssid null if the name has none); null when no callsign-shaped word
  // HAM ONLY (2026-10-31: "we cannot gate non-ham station names into aprs.fi under any circumstance"): the FIRST
  // or SECOND word of the name must be an Australian or New Zealand amateur callsign -- VK or ZL, 1-2 digits, 1-4
  // letters -- then the end, a space / punctuation, or -SSID 1-15 ("VK4XXX Bike", "BARC VK4BA Repeater", "🚗 VK4ZB").
  // The first word wins when both are calls. A call further in, or anything that merely looks like one ("m3sh3dup r3p"
  // -> R3P), is refused. = bridge/kelly_igate.py call_from_name (vectors: from_name).
  const HAM_RE = /^\s*(?:\S+\s+)??((?:VK|ZL)[0-9]{1,2}[A-Z]{1,4})(?:-([0-9]{1,2}))?(?=$|[^A-Z0-9])/i;
  function callFromName(name) {
    const m = HAM_RE.exec(String(name || ''));
    if (!m) return null;
    const base = m[1].toUpperCase(), ssid = m[2] != null ? +m[2] : null;
    return validBase(base) && (ssid == null || (ssid >= 1 && ssid <= 15)) ? { base, ssid } : null;
  }
  // a CALL-SSID that may go to APRS-IS from this iGate: VK / ZL only (the same shape as above)
  const hamCall = c => { const m = /^((?:VK|ZL)[0-9]{1,2}[A-Z]{1,4})(?:-([0-9]{1,2}))?$/.exec(String(c || '')); return !!m && validBase(m[1]) && (m[2] == null || (+m[2] >= 1 && +m[2] <= 15)); };
  // the last check before a line leaves: its source callsign is a VK/ZL amateur's AND the node's name carries that call (word 1 or 2)
  const hamNode = (src, name) => { const cs = callFromName(name); return hamCall(src) && !!cs && cs.base === String(src).split('-')[0]; };

  // ------------------------------------------------------------------ telemetry (APRS 1.0.1 ch. 13)
  // A node's readings, flattened: [{id, label, value, unit}]. id = 'lpp:<channel>:<LPP type>' (CayenneLPP, from a
  // telemetry request) or 'st:<field>' (a repeater's status). A mapping source may be 'lpp:*:<type>' = the first reading
  // of that type on any channel (presets use it: the channel numbers differ between firmwares).
  const ST = { battV: ['Battery', 'V'], noise: ['Noise floor', 'dBm'], rssi: ['Last RSSI', 'dBm'], snr: ['Last SNR', 'dB'], txAir: ['TX airtime', '%'],
    rxAir: ['RX airtime', '%'], txQueue: ['TX queue', ''], uptimeH: ['Uptime', 'h'], relayedH: ['Relayed', '/h'], errors: ['Errors', ''] };
  function readings(lpp, st) {
    const out = [];
    for (const x of lpp || []) if (x && x.name !== 'gps' && typeof x.value === 'number') out.push({ id: `lpp:${x.ch}:${x.type}`, label: `ch ${x.ch} ${x.name}`, value: x.value, unit: x.unit || '' });
    if (st) {
      const up = Math.max(1, +st.uptimeS || 0), v = {
        battV: st.battV, noise: st.noise, rssi: st.rssi, snr: st.snr, txAir: (st.txAirS || 0) / up * 100, rxAir: (st.rxAirS || 0) / up * 100,
        txQueue: st.txQueue, uptimeH: up / 3600, relayedH: ((st.sentFlood || 0) + (st.sentDirect || 0)) / (up / 3600), errors: st.errors };
      for (const [k, [label, unit]] of Object.entries(ST)) if (typeof v[k] === 'number' && isFinite(v[k])) out.push({ id: `st:${k}`, label, value: Math.round(v[k] * 1000) / 1000, unit });
    }
    return out;
  }
  const pick = (rs, src) => {
    const m = /^lpp:\*:(\d+)$/.exec(src || '');
    const r = m ? rs.find(x => x.id.startsWith('lpp:') && x.id.endsWith(`:${m[1]}`)) : rs.find(x => x.id === src);
    return r ? r.value : null;
  };
  // A mapping: {a: [5 x {src, name, unit, min, max} | null], b: [8 x {src, op: '<' | '>', v, name} | null], title}
  // Each analog value goes out as 0-255 across min..max (EQNS a=0, b=(max-min)/255, c=min), which every APRS client reads.
  const A_LEN = [7, 7, 6, 6, 5], B_LEN = [6, 5, 4, 4, 4, 3, 3, 3];   // PARM / UNIT field limits, APRS 1.0.1
  const tclean = (t, n) => clean(t, 40).replace(/,/g, ' ').replace(/ {2,}/g, ' ').slice(0, n).trim();
  const slots = m => ({ a: Array.from({ length: 5 }, (_, i) => (m && m.a && m.a[i] && m.a[i].src ? m.a[i] : null)),
    b: Array.from({ length: 8 }, (_, i) => (m && m.b && m.b[i] && m.b[i].src ? m.b[i] : null)) });
  const num = x => String(+Number(x).toPrecision(6));
  // -> {a: [raw 0-255 | null], b: '01..', missing: [names]}
  function tlmValues(m, rs) {
    const { a, b } = slots(m), missing = [];
    const av = a.map(x => {
      if (!x) return null;
      const v = pick(rs, x.src); if (v == null) { missing.push(x.name || x.src); return null; }
      const lo = +x.min, hi = +x.max; if (!(hi > lo)) return null;
      return Math.max(0, Math.min(255, Math.round((v - lo) / (hi - lo) * 255)));
    });
    const bits = b.map(x => { if (!x) return '0'; const v = pick(rs, x.src); if (v == null) { missing.push(x.name || x.src); return '0'; } return (x.op === '<' ? v < +x.v : v > +x.v) ? '1' : '0'; }).join('');
    return { a: av, b: bits, missing };
  }
  const seqNow = (t = Date.now()) => Math.floor(t / 60000) % 1000;   // from the clock: two iGates polling the same minute agree
  // the T# body; an unmapped/missing analog slot is left empty
  const tlmBody = (seq, a, b) => `T#${String(seq % 1000).padStart(3, '0')},${a.map(x => (x == null ? '' : String(x).padStart(3, '0'))).join(',')},${b}`;
  // the four definition message bodies (to the station itself; aprs.fi labels and scales its graphs with them)
  function tlmDefs(src, m) {
    const { a, b } = slots(m), to = `:${String(src).padEnd(9, ' ')}:`;
    // 13 positions (A1-A5, B1-B8): a bit's name stays in its place even when analog slots are empty
    const lst = (fa, fb) => {
      const f = [...a.map((x, i) => (x ? tclean(fa(x), A_LEN[i]) : '')), ...b.map((x, i) => (x ? tclean(fb(x), B_LEN[i]) : ''))];
      while (f.length && !f[f.length - 1]) f.pop();
      return f.join(',');
    };
    const eq = a.map(x => (x ? `0,${num((+x.max - +x.min) / 255)},${num(+x.min)}` : '0,1,0')).join(',');
    return [
      `${to}PARM.${lst(x => x.name, x => x.name)}`,
      `${to}UNIT.${lst(x => x.unit, x => x.label || 'on')}`,
      `${to}EQNS.${eq}`,
      `${to}BITS.11111111,${tclean(m && m.title || 'MeshCore via Kelly', 23)}`,   // each bit means "true" when 1
    ];
  }
  const tlmSig = m => JSON.stringify(slots(m)) + (m && m.title || '');
  // Device types: a starting mapping the owner then adjusts per device.
  const R_BATT = { src: 'st:battV', name: 'Battery', unit: 'V', min: 3, max: 4.5 };
  const PRESETS = [
    { id: 'repeater', name: 'MeshCore repeater (any)', a: [R_BATT, { src: 'st:noise', name: 'Noise', unit: 'dBm', min: -130, max: -53.5 },
      { src: 'st:txAir', name: 'TX air', unit: '%', min: 0, max: 25.5 }, { src: 'st:rssi', name: 'RSSI', unit: 'dBm', min: -130, max: -53.5 },
      { src: 'st:snr', name: 'SNR', unit: 'dB', min: -20, max: 31 }], b: [{ src: 'st:battV', op: '<', v: 3.5, name: 'LowBat' }] },
    { id: 'sensecap-solar', name: 'SenseCAP Solar Node (P1)', a: [R_BATT, { src: 'st:noise', name: 'Noise', unit: 'dBm', min: -130, max: -53.5 },
      { src: 'st:txAir', name: 'TX air', unit: '%', min: 0, max: 25.5 }, { src: 'st:relayedH', name: 'Relay', unit: '/h', min: 0, max: 510 },
      { src: 'st:uptimeH', name: 'Uptime', unit: 'h', min: 0, max: 2550 }], b: [{ src: 'st:battV', op: '<', v: 3.5, name: 'LowBat' }] },
    { id: 'tracker', name: 'GPS tracker (battery only)', a: [{ src: 'lpp:*:116', name: 'Battery', unit: 'V', min: 3, max: 4.5 }], b: [] },
    { id: 'env', name: 'Weather / environment sensor', a: [{ src: 'lpp:*:116', name: 'Battery', unit: 'V', min: 3, max: 4.5 },
      { src: 'lpp:*:103', name: 'Temp', unit: 'degC', min: -20, max: 63.5 }, { src: 'lpp:*:104', name: 'Humid', unit: '%', min: 0, max: 100 },
      { src: 'lpp:*:115', name: 'Press', unit: 'hPa', min: 900, max: 1100 }], b: [] },
    { id: 'custom', name: 'Custom', a: [], b: [] },
  ];

  return { TOCALL, SOFTWARE, DEFAULTS, OWN_MIN_MIN, DROPS, passcode, validBase, fullCall, validSymbol, fmtLat, fmtLon, position, packet,
    statusPacket, checkPosition, distanceM, roundPos, aprsFiUrl, TokenBucket, Stats, Gate,
    callFromName, hamCall, hamNode, ST, readings, tlmValues, seqNow, tlmBody, tlmDefs, tlmSig, slots, PRESETS };
});
