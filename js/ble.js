/* Kelly Page -- BLE presence + alerts, pure (no DOM, no radio, no Bluetooth).
 *
 * The Kelly bridge scans (bridge/kelly_ble.py, local adapters; bridge/kelly_ble_node.py, remote scanner nodes)
 * and streams one normalised record per advertisement over its /ble WebSocket:
 *   { n: node id ('local' = the bridge's own adapter), z: zone, ad: adapter, ts: ms (the scanner's clock),
 *     a: 'AA:BB:CC:DD:EE:FF', at: 'public' | 'random', r: RSSI dBm, tx: TX power | null, nm: name | null,
 *     m: { '<company id, decimal>': hex }, s: { '<uuid: 4 hex for SIG 16-bit, else full>': hex }, u: [uuids] }
 * BlueZ hands over parsed AD structures, not raw bytes -- so decoders work on m / s, and the inspector (later)
 * marks anything rebuilt from them as reconstructed.
 *
 * Here: address kinds, decoders (iBeacon, Eddystone UID/URL/TLM, BTHome v2, Xiaomi ATC1441 / pvvx), device
 * identity keys, the presence engine (EMA RSSI, arrive/depart hysteresis, debounce, absence timeout, zone choice
 * with hysteresis, no alert storm at start-up, remote zones judged by their own clock), the rules engine
 * (arrive, depart, move, not seen, outside schedule, battery, reading; cooldown, quiet hours, escalation),
 * templates fitted to the P25 text limit, the airtime queue (priority, gaps, hourly caps, coalescing), a
 * simulator, and Morse timing for the CW callsign. The page is js/bleui.js; tests tests/ble-tests.html.
 *
 * Settings shapes (objects keyed by id, scalar leaves -- so Admin > Save config carries them to the Pi keeper):
 *   device  { name, call, type, match: 'mac:..' | 'ib:uuid[:major[:minor]]' | 'ed:ns:inst' | 'name:..', notes,
 *             arrive, depart, absence (overrides; '' = default), en }
 *   rule    { en, on, dev ('*' or a device id), zone ('' = any), to ('1050002, 2050002'), tpl, prio
 *             ('alarm' | 'presence' | 'routine'), cool (min), quiet ('22:00-06:00' | ''), sched ('Mon-Fri 07:00-18:00',
 *             for 'outside'), hours (for 'notseen'), field / op / value (for 'reading' / 'battery'), esc (min, 0 = off), escMax }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyBle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const hexBytes = h => { const s = String(h || '').replace(/[^0-9a-f]/gi, ''); const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
  const toHex = (u, a = 0, b = u.length) => Array.from(u.slice(a, b), x => x.toString(16).padStart(2, '0')).join('');
  const s8 = v => v > 127 ? v - 256 : v;
  const s16 = v => v > 32767 ? v - 65536 : v;
  const s24 = v => v > 0x7fffff ? v - 0x1000000 : v;
  const round = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };
  // '0000feaa-0000-1000-8000-00805f9b34fb' -> 'feaa'; anything else lower-cased as is
  const uuidShort = u => { const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(u || ''); return m ? m[1].toLowerCase() : String(u || '').toLowerCase(); };

  // A few Bluetooth SIG company IDs (assigned numbers) -- enough to name what's around a house. The full list is
  // the inspector's job (later); unknown ones show as 0xNNNN.
  const COMPANIES = { 0x004C: 'Apple', 0x0006: 'Microsoft', 0x0075: 'Samsung', 0x00E0: 'Google', 0x0059: 'Nordic Semiconductor',
    0x02E5: 'Espressif', 0x038F: 'Xiaomi', 0x0157: 'Huami', 0x0499: 'Ruuvi', 0x0087: 'Garmin', 0x0171: 'Amazon', 0x009E: 'Bose',
    0x0822: 'Adafruit', 0x000D: 'Texas Instruments', 0x000A: 'Qualcomm', 0x001D: 'Qualcomm', 0x0131: 'Cypress', 0x0310: 'SGL Italia',
    0x0002: 'Intel', 0x000F: 'Broadcom', 0x005D: 'Realtek', 0x0110: 'Nippon Seiki', 0x0397: 'Tile', 0x067C: 'Tile',
    0x0969: 'Woan (SwitchBot)', 0x0A12: 'Inkbird', 0x0BAA: 'Meshtastic', 0x0D53: 'Tuya' };
  const companyName = id => COMPANIES[id] || `0x${(+id).toString(16).padStart(4, '0').toUpperCase()}`;

  // Address kinds (Core spec Vol 6 Part B 1.3): a random address's top two bits say which.
  // A scanner that can't say (bleak off BlueZ: at null) -- top bits 01 is almost surely a phone's RPA (= kelly_ble.rotates).
  function addrKind(a, at) {
    const top = parseInt(String(a || '00').slice(0, 2), 16) >> 6;
    if (at == null) return top === 1 ? 'rpa' : 'public';
    if (at !== 'random') return 'public';
    return top === 3 ? 'static' : top === 1 ? 'rpa' : top === 0 ? 'nrpa' : 'reserved';
  }
  const ADDR_KIND = { public: 'Public (fixed, from the maker)', static: 'Random static (fixed until the device is reset)',
    rpa: 'Resolvable private (rotates every few minutes -- phones, watches)', nrpa: 'Non-resolvable private (rotates; beacons in privacy mode)', reserved: 'Reserved' };
  const rotates = k => k === 'rpa' || k === 'nrpa';

  // ---- decoders: each takes the record, returns a partial result or null
  function decIBeacon(r) {
    const h = r.m && r.m['76']; if (!h) return null;
    const b = hexBytes(h); if (b.length < 23 || b[0] !== 0x02 || b[1] !== 0x15) return null;
    const u = toHex(b, 2, 18);
    const uuid = `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`;
    return { kind: 'ibeacon', ib: { uuid, major: (b[18] << 8) | b[19], minor: (b[20] << 8) | b[21], tx: s8(b[22]) } };
  }
  const EDDY_SCHEME = ['http://www.', 'https://www.', 'http://', 'https://'];
  const EDDY_EXP = ['.com/', '.org/', '.edu/', '.net/', '.info/', '.biz/', '.gov/', '.com', '.org', '.edu', '.net', '.info', '.biz', '.gov'];
  function decEddystone(r) {
    const h = r.s && r.s.feaa; if (!h) return null;
    const b = hexBytes(h); if (!b.length) return null;
    if (b[0] === 0x00 && b.length >= 18) return { kind: 'eddystone', ed: { frame: 'uid', tx: s8(b[1]), ns: toHex(b, 2, 12), inst: toHex(b, 12, 18) } };
    if (b[0] === 0x10 && b.length >= 3) {
      let url = EDDY_SCHEME[b[2]] || '';
      for (let i = 3; i < b.length; i++) url += b[i] < EDDY_EXP.length ? EDDY_EXP[b[i]] : String.fromCharCode(b[i]);
      return { kind: 'eddystone', ed: { frame: 'url', tx: s8(b[1]), url } };
    }
    if (b[0] === 0x20 && b.length >= 14 && b[1] === 0) {
      const mv = (b[2] << 8) | b[3], t = s16((b[4] << 8) | b[5]) / 256;
      const val = { battMv: mv || null, temp: t === -128 ? null : round(t, 2) };
      return { kind: 'eddystone', ed: { frame: 'tlm', advCnt: ((b[6] << 24) >>> 0) + (b[7] << 16) + (b[8] << 8) + b[9], secCnt: (((b[10] << 24) >>> 0) + (b[11] << 16) + (b[12] << 8) + b[13]) / 10 }, val };
    }
    return null;
  }
  // BTHome v2 (bthome.io/format): service data FCD2, device-info byte then (object id, value) pairs. Objects are
  // little-endian; an id we don't know ends the parse (its length is unknowable). Encrypted payloads aren't decoded.
  const BTH = {   // id: [name, bytes, signed, factor]
    0x00: ['pid', 1, 0, 1], 0x01: ['batt', 1, 0, 1], 0x02: ['temp', 2, 1, 0.01], 0x03: ['hum', 2, 0, 0.01], 0x04: ['pressure', 3, 0, 0.01],
    0x05: ['lux', 3, 0, 0.01], 0x06: ['mass', 2, 0, 0.01], 0x08: ['dew', 2, 1, 0.01], 0x09: ['count', 1, 0, 1], 0x0A: ['energy', 3, 0, 0.001],
    0x0B: ['power', 3, 0, 0.01], 0x0C: ['volt', 2, 0, 0.001], 0x0D: ['pm25', 2, 0, 1], 0x0E: ['pm10', 2, 0, 1], 0x0F: ['generic', 1, 0, 1],
    0x10: ['powerOn', 1, 0, 1], 0x11: ['opening', 1, 0, 1], 0x12: ['co2', 2, 0, 1], 0x13: ['tvoc', 2, 0, 1], 0x14: ['moisture', 2, 0, 0.01],
    0x15: ['battLow', 1, 0, 1], 0x16: ['charging', 1, 0, 1], 0x1A: ['door', 1, 0, 1], 0x1E: ['light', 1, 0, 1], 0x20: ['moist', 1, 0, 1],
    0x21: ['motion', 1, 0, 1], 0x22: ['moving', 1, 0, 1], 0x23: ['occupancy', 1, 0, 1], 0x29: ['smoke', 1, 0, 1], 0x2D: ['window', 1, 0, 1],
    0x2E: ['hum', 1, 0, 1], 0x2F: ['moisture', 1, 0, 1], 0x3A: ['button', 1, 0, 1], 0x3D: ['count', 2, 0, 1], 0x3E: ['count', 4, 0, 1],
    0x3F: ['rotation', 2, 1, 0.1], 0x40: ['distanceMm', 2, 0, 1], 0x43: ['current', 2, 0, 0.001], 0x45: ['temp', 2, 1, 0.1],
    0x4A: ['volt', 2, 0, 0.1], 0x4B: ['gas', 3, 0, 0.001], 0x51: ['accel', 2, 0, 0.001], 0x52: ['gyro', 2, 0, 0.001], 0x5D: ['current', 2, 1, 0.001],
    0x5E: ['direction', 2, 0, 0.01], 0x5F: ['precip', 2, 0, 0.1] };
  function decBTHome(r) {
    const h = r.s && r.s.fcd2; if (!h) return null;
    const b = hexBytes(h); if (!b.length) return null;
    const info = b[0], version = info >> 5;
    if (version !== 2) return { kind: 'bthome', bth: { version, note: 'not BTHome v2' } };
    if (info & 1) return { kind: 'bthome', bth: { version, encrypted: true } };
    const val = {}; let i = 1;
    while (i < b.length) {
      const d = BTH[b[i]]; if (!d) break;
      const [name, n, signed, f] = d; if (i + 1 + n > b.length) break;
      let v = 0; for (let k = n - 1; k >= 0; k--) v = v * 256 + b[i + 1 + k];
      if (signed) v = n === 1 ? s8(v) : n === 2 ? s16(v) : n === 3 ? s24(v) : v | 0;
      val[name] = round(v * f, 3);
      i += 1 + n;
    }
    return { kind: 'bthome', bth: { version, trigger: !!(info & 4) }, val };
  }
  // Xiaomi LYWSD03MMC etc. with custom firmware: service data 181A. ATC1441 = 13 bytes big-endian; pvvx = 15 bytes LE.
  function decXiaomiCustom(r) {
    const h = r.s && r.s['181a']; if (!h) return null;
    const b = hexBytes(h);
    if (b.length === 13) return { kind: 'atc', val: { temp: round(s16((b[6] << 8) | b[7]) / 10, 1), hum: b[8], batt: b[9], battMv: (b[10] << 8) | b[11] }, seq: b[12] };
    if (b.length >= 15) return { kind: 'pvvx', val: { temp: round(s16(b[6] | (b[7] << 8)) / 100, 2), hum: round((b[8] | (b[9] << 8)) / 100, 2), battMv: b[10] | (b[11] << 8), batt: b[12] }, seq: b[13] };
    return null;
  }
  // Tracker tags (pet / key finders): which kind, and whether Kelly can follow one. Find My / SmartTag / Google
  // trackers rotate their address and IDs on purpose (anti-stalking): recognised and labelled, never trackable.
  function decTag(r) {
    const u = (r.u || []).map(x => String(x).toLowerCase()), s = r.s || {}, m = r.m || {}, nm = String(r.nm || '').trim();
    const apple = m['76'] || '';
    if (/^itag/i.test(nm) || (u.includes('ffe0') && (u.includes('1802') || /tag/i.test(nm))))
      return { kind: 'tag', tag: { kind: 'itag', name: 'Key-finder tag (iTag)', trackable: true, note: 'Fixed address: register it by MAC.' } };
    if (s.feed || s.feec || u.includes('feed') || u.includes('feec'))
      return { kind: 'tag', tag: { kind: 'tile', name: 'Tile tracker', trackable: null, note: 'Some Tiles keep a fixed address (register by MAC); others rotate it and can\'t be followed.' } };
    if (/^12/.test(apple))   // Apple continuity type 0x12 = Find My (offline finding)
      return { kind: 'tag', tag: { kind: 'findmy', name: 'Apple Find My (AirTag or a Find My device)', trackable: false, note: 'Rotates its address and key every few minutes on purpose -- only its owner\'s iPhone can follow it.' } };
    if (s.fd5a || u.includes('fd5a'))
      return { kind: 'tag', tag: { kind: 'smarttag', name: 'Samsung SmartTag', trackable: false, note: 'Rotates its ID on purpose -- only its owner\'s Galaxy phone can follow it.' } };
    if (s.feaa && /^4[01]/.test(s.feaa))
      return { kind: 'tag', tag: { kind: 'fmdn', name: 'Google Find My Device tracker', trackable: false, note: 'Rotating ephemeral ID -- only its owner\'s phone can follow it.' } };
    return null;
  }
  const DECODERS = [['iBeacon', decIBeacon], ['Eddystone', decEddystone], ['BTHome v2', decBTHome], ['Xiaomi ATC/pvvx', decXiaomiCustom], ['Tracker tag', decTag]];
  // custom decoders (the inspector's builder, later) register here: fn(record) -> { kind, val } | null
  const custom = [];
  function decode(r) {
    const out = { kind: 'other', addr: addrKind(r.a, r.at), val: {} };
    for (const [, fn] of DECODERS.concat(custom)) {
      let d = null; try { d = fn(r); } catch { d = null; }
      if (d) { Object.assign(out, d, { val: Object.assign(out.val, d.val || {}) }); }
    }
    const cids = Object.keys(r.m || {});
    out.company = cids.length ? companyName(+cids[0]) : '';
    return out;
  }

  // ---- identity: the keys a registered device can match on. Rotating addresses never make a 'mac:' key.
  function idKeys(r, d) {
    const k = [];
    if (r.a && !rotates(d.addr)) k.push('mac:' + r.a.toUpperCase());
    if (d.ib) { const u = d.ib.uuid; k.push(`ib:${u}:${d.ib.major}:${d.ib.minor}`, `ib:${u}:${d.ib.major}`, `ib:${u}`); }
    if (d.ed && d.ed.frame === 'uid') k.push(`ed:${d.ed.ns}:${d.ed.inst}`);
    if (r.nm) k.push('name:' + String(r.nm).trim().toLowerCase());
    return k;
  }
  // what to suggest when registering a device seen in the live view: the steadiest key it has
  function bestKey(r, d) {
    if (d.ib) return `ib:${d.ib.uuid}:${d.ib.major}:${d.ib.minor}`;
    if (d.ed && d.ed.frame === 'uid') return `ed:${d.ed.ns}:${d.ed.inst}`;
    if (r.a && !rotates(d.addr)) return 'mac:' + r.a.toUpperCase();
    if (r.nm) return 'name:' + String(r.nm).trim().toLowerCase();
    return '';
  }
  function normKey(k) {
    k = String(k || '').trim();
    const m = /^(mac|ib|ed|name):(.*)$/i.exec(k); if (!m) return '';
    const kind = m[1].toLowerCase(), v = m[2].trim();
    if (kind === 'mac') return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(v) ? 'mac:' + v.toUpperCase() : '';
    if (kind === 'name') return v ? 'name:' + v.toLowerCase() : '';
    return v ? `${kind}:${v.toLowerCase()}` : '';
  }
  // devices { id: {match, en, ...} } -> lookup(record, decoded) -> device id | null
  function Registry(devices) {
    const idx = new Map();
    for (const [id, dv] of Object.entries(devices || {})) { if (dv && dv.en !== false) { const k = normKey(dv.match); if (k) idx.set(k, id); } }
    return { size: idx.size, keys: () => [...idx.keys()], lookup(r, d) { for (const k of idKeys(r, d)) { const id = idx.get(k); if (id) return id; } return null; } };
  }
  // the record a scanner node may forward when it filters to registered devices (= kelly_ble_node.py wants())
  const filterKeys = devices => Registry(devices).keys();

  // ---- a phone as a beacon (Phase 13): a web page can't transmit BLE, so a beacon app on the phone (Beacon Simulator
  // and the like) sends an iBeacon identity Kelly makes up. A random version-4 UUID (apps that check the UUID accept it)
  // + major / minor 1-65534, lower case like decIBeacon, so the registered key is the one idKeys makes from the advert.
  const rnd = () => { try { return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; } catch { return Math.random(); } };
  function phoneBeacon(rand = rnd) {
    const h = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
    h[12] = '4'; h[16] = '89ab'[Math.floor(rand() * 4)];
    const u = h.join(''), n = () => 1 + Math.floor(rand() * 65534);
    return { uuid: `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`, major: n(), minor: n() };
  }
  const ibKey = b => `ib:${b.uuid}:${b.major}:${b.minor}`;
  // 'ib:uuid:major:minor' -> { uuid, major, minor } (null for anything else, or a uuid-only / uuid:major key)
  function parseIbKey(k) {
    const m = /^ib:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+):(\d+)$/i.exec(normKey(k));
    return m ? { uuid: m[1], major: +m[2], minor: +m[3] } : null;
  }

  // ---- presence
  const STALE_ZONE_MS = 3600000;
  const PRESENCE_DEFAULTS = { arrive: -80, depart: -90, alpha: 0.3, minHits: 2, debounceSec: 30, absenceSec: 300, zoneHystDb: 6, zoneSwitchSec: 30, startupSec: 0 };
  // optFor(deviceId, zone) -> the options for that device in that zone (defaults < zone < device). Times in ms.
  function Presence(optFor, now0) {
    const devs = new Map(), t0 = now0;
    const o = (id, z) => Object.assign({}, PRESENCE_DEFAULTS, optFor ? optFor(id, z) : {});
    function dev(id) { let d = devs.get(id); if (!d) devs.set(id, d = { id, st: 'unknown', zone: null, zones: {}, lastSeen: 0, lastRssi: null, since: 0, cand: null }); return d; }
    function feed(s, now) {   // s = { id, zone, rssi, t }
      const ev = [], d = dev(s.id), op = o(s.id, s.zone);
      const e = d.zones[s.zone] || (d.zones[s.zone] = { v: null, t: 0, strong: 0, hits: [] });
      e.v = e.v == null ? s.rssi : e.v + op.alpha * (s.rssi - e.v);
      e.t = Math.max(e.t, s.t); e.hits.push(s.t); e.hits = e.hits.filter(t => s.t - t < op.debounceSec * 1000);
      if (e.v >= op.depart) e.strong = Math.max(e.strong, s.t);
      d.lastSeen = Math.max(d.lastSeen, s.t); d.lastRssi = Math.round(e.v);
      if (d.st !== 'present') {
        if (e.v >= op.arrive && e.hits.length >= op.minHits) {
          const quiet = d.st === 'unknown' && now - t0 < (op.startupSec || op.absenceSec) * 1000;   // already here when Kelly started
          d.st = 'present'; d.zone = s.zone; d.since = s.t; d.cand = null;
          ev.push({ type: 'arrive', id: s.id, zone: s.zone, rssi: d.lastRssi, t: s.t, quiet });
        }
        return ev;
      }
      // present: which zone? the strongest fresh one, switched only after zoneHystDb better for zoneSwitchSec
      const cur = d.zones[d.zone];
      if (s.zone !== d.zone && cur) {
        const curWeak = cur.v < op.depart || s.t - cur.t > op.absenceSec * 1000;
        if (e.v >= op.arrive && (curWeak || e.v >= cur.v + op.zoneHystDb)) {
          if (!d.cand || d.cand.zone !== s.zone) d.cand = { zone: s.zone, since: s.t };
          else if (s.t - d.cand.since >= op.zoneSwitchSec * 1000) {
            const from = d.zone; d.zone = s.zone; d.cand = null;
            ev.push({ type: 'move', id: s.id, zone: s.zone, from, rssi: d.lastRssi, t: s.t });
          }
        } else if (d.cand && d.cand.zone === s.zone) d.cand = null;
      }
      return ev;
    }
    // zoneClock(zone) = how far that zone's data reaches (a remote node's newest delivered time; now for the local
    // adapter). A device departs only when every zone that saw it is past absenceSec since its last strong sighting
    // there -- so a node whose link is down (clock frozen) can't make anyone "leave". ids = every registered device.
    function tick(now, zoneClock, ids) {
      const ev = [];
      for (const d of devs.values()) {
        if (d.st !== 'present') continue;
        const op = o(d.id, d.zone);
        let gone = true, last = 0;
        for (const [z, e] of Object.entries(d.zones)) {
          if (!e.strong) continue;   // only ever heard faintly there: no say
          last = Math.max(last, e.strong);
          let zc = zoneClock ? zoneClock(z) : now;
          if (zc == null || now - zc > STALE_ZONE_MS) zc = now;   // a node down over an hour doesn't hold everyone "here" for ever
          if (zc - e.strong <= op.absenceSec * 1000) { gone = false; break; }
        }
        if (gone) { const zone = d.zone; d.st = 'away'; d.since = last || d.lastSeen; ev.push({ type: 'depart', id: d.id, zone, t: now, lastSeen: d.lastSeen }); }
      }
      for (const id of ids || []) {   // not here at start-up: away, quietly
        const d = dev(id);
        if (d.st === 'unknown' && now - t0 >= (o(id, null).startupSec || o(id, null).absenceSec) * 1000) { d.st = 'away'; ev.push({ type: 'depart', id, zone: null, t: now, lastSeen: d.lastSeen, quiet: true }); }
      }
      return ev;
    }
    return { feed, tick, get: id => devs.get(id), all: () => [...devs.values()], forget: id => devs.delete(id) };
  }

  // ---- time helpers
  const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim()); return m ? +m[1] * 60 + +m[2] : null; };
  // '22:00-06:00' -> is t inside (wraps midnight)?
  function inWindow(spec, t) {
    const m = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(spec || ''); if (!m) return false;
    const d = new Date(t), x = d.getHours() * 60 + d.getMinutes(), a = hm(m[1]), b = hm(m[2]);
    return a <= b ? x >= a && x < b : x >= a || x < b;
  }
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  // 'Mon-Fri 07:00-18:00' / 'Sat,Sun 08:00-12:00' / '07:00-18:00' (every day); several joined with ';'
  function inSchedule(spec, t) {
    const parts = String(spec || '').split(';').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return true;
    const day = new Date(t).getDay();
    return parts.some(p => {
      const m = /^(?:([a-z]{3}(?:\s*[-,]\s*[a-z]{3})*)\s+)?(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})$/i.exec(p); if (!m) return false;
      if (m[1]) {
        const ok = new Set();
        for (const seg of m[1].toLowerCase().split(',')) {
          const [a, b] = seg.split('-').map(s => DAYS.indexOf(s.trim()));
          if (a < 0) continue;
          if (b == null || b < 0) ok.add(a); else for (let i = a; ; i = (i + 1) % 7) { ok.add(i); if (i === b) break; }
        }
        if (!ok.has(day)) return false;
      }
      return inWindow(m[2], t);
    });
  }
  const pad2 = n => String(n).padStart(2, '0');
  const clock = t => { const d = new Date(t); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  function ago(t, now) {
    if (!t) return 'never';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 3600) return clock(t);
    if (s < 86400) return `${clock(t)} (${Math.round(s / 3600)}h ago)`;
    const d = new Date(t); return `${d.getDate()}/${d.getMonth() + 1} ${clock(t)}`;
  }

  // ---- templates
  const P25_TEXT_MAX = 140;   // 160-byte P25 text, less room for the gateway's "CALL: " when it forwards a Kelly text
  const bytes = s => new TextEncoder().encode(s).length;
  function fit(text, max = P25_TEXT_MAX) {
    text = String(text).replace(/\s+/g, ' ').trim();
    if (bytes(text) <= max) return text;
    let out = text;
    while (out && bytes(out + '..') > max) out = out.slice(0, -1);
    return out.replace(/\s+$/, '') + '..';
  }
  function render(tpl, vars, max = P25_TEXT_MAX) {
    const t = String(tpl || '').replace(/\{(\w+)\}/g, (all, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : all === '{zone}' ? '?' : ''));
    return fit(t, max);
  }
  const DEFAULT_TPL = {
    arrive: '{callsign} arrived {zone} {time}',
    depart: '{device} left {zone} {time}',
    move: '{device} moved {from} > {zone} {time}',
    notseen: 'ALERT {device} not seen at {zone} since {last_seen}',
    outside: '{device} at {zone} {time} outside schedule',
    battery: '{device} battery low {batt}%',
    reading: '{device} {field} {value}',
  };
  const TRIGGERS = { arrive: 'Arrives', depart: 'Leaves', move: 'Moves zone', notseen: 'Not seen for…', outside: 'Seen outside schedule', battery: 'Battery low', reading: 'Sensor reading' };
  const PRIO = { alarm: 0, presence: 1, routine: 2, telem: 3, game: 4 };   // game = Phase 5 announcements: never ahead of anything real
  const units = s => String(s || '').split(/[\s,;]+/).map(x => +x).filter(x => Number.isInteger(x) && x > 0 && x < 16777215);

  // ---- rules: rules() -> { id: rule }; devices() -> { id: device }. evaluate / tick return alerts
  //   { rule, dev, key, to: [unit ids], text, prio, esc }
  function Rules(rulesFn, devicesFn) {
    const last = new Map();        // rule|dev -> last alert ms (cooldown)
    const latched = new Map();     // rule|dev -> ms while a threshold rule is tripped / a notseen has fired
    const active = new Map();      // key -> { alert, next, count } escalations waiting to be cleared
    function vars(ev, dv, extra, now) {
      return Object.assign({ device: dv.name || ev.id, callsign: dv.call || dv.name || ev.id, owner: dv.call || '', type: dv.type || '',
        zone: ev.zone || '', from: ev.from || '', time: clock(ev.t || now), date: new Date(ev.t || now).toLocaleDateString(),
        rssi: ev.rssi != null ? ev.rssi : '', last_seen: ago(ev.lastSeen, now) }, extra || {});
    }
    function make(r, rid, ev, dv, now, extra) {
      const key = `${rid}|${ev.id}`;
      const quiet = r.quiet && r.prio !== 'alarm' && inWindow(r.quiet, now);
      if (quiet) return null;
      const cool = (r.cool != null && r.cool !== '' ? +r.cool : 10) * 60000;
      if (now - (last.get(key) || 0) < cool) return null;
      const to = units(r.to); if (!to.length) return null;
      last.set(key, now);
      const a = { rule: rid, dev: ev.id, key, to, prio: r.prio || 'presence', text: render(r.tpl || DEFAULT_TPL[r.on], vars(ev, dv, extra, now)), t: now };
      if (+r.esc > 0) active.set(key, { alert: a, next: now + +r.esc * 60000, count: 0, max: +r.escMax || 3 });
      return a;
    }
    const applies = (r, ev) => r && r.en !== false && (r.dev === '*' || !r.dev || r.dev === ev.id) && (!r.zone || !ev.zone || r.zone === ev.zone);
    function clear(ruleOn, devId) {   // the opposite happened: stop escalating
      for (const [k, x] of active) { const r = (rulesFn() || {})[x.alert.rule]; if (x.alert.dev === devId && r && ruleOn.includes(r.on)) active.delete(k); }
    }
    function evaluate(ev, now) {
      const out = [], rules = rulesFn() || {}, dv = (devicesFn() || {})[ev.id] || {};
      if (ev.type === 'arrive') clear(['depart', 'notseen'], ev.id);
      if (ev.type === 'depart') clear(['arrive', 'move', 'outside'], ev.id);
      for (const [rid, r] of Object.entries(rules)) {
        if (!applies(r, ev)) continue;
        const key = `${rid}|${ev.id}`;
        if (ev.quiet) continue;
        let a = null;
        if (['arrive', 'depart', 'move'].includes(r.on) && r.on === ev.type) a = make(r, rid, ev, dv, now);
        else if (r.on === 'outside' && (ev.type === 'arrive' || ev.type === 'move') && r.sched && !inSchedule(r.sched, ev.t || now)) a = make(r, rid, ev, dv, now);
        else if ((r.on === 'battery' || r.on === 'reading') && ev.type === 'reading') {
          const field = r.on === 'battery' ? 'batt' : r.field, v = ev.val ? ev.val[field] : null;
          if (v == null) continue;
          const lim = r.value !== '' && r.value != null ? +r.value : r.on === 'battery' ? 20 : null; if (lim == null) continue;
          const op = r.on === 'battery' ? '<' : r.op || '>';
          const band = r.on === 'battery' ? 5 : Math.max(Math.abs(lim) * 0.02, 0.5);   // re-arm only once clearly back
          const tripped = op === '<' ? v < lim : v > lim, clearOk = op === '<' ? v >= lim + band : v <= lim - band;
          if (tripped && !latched.get(key)) { latched.set(key, now); a = make(r, rid, ev, dv, now, { batt: ev.val.batt != null ? ev.val.batt : '', field, value: v }); }
          else if (clearOk && latched.get(key)) { latched.delete(key); active.delete(key); }
        }
        if (a) out.push(a);
      }
      return out;
    }
    // not-seen rules and escalations; state(id) -> { lastSeen, zone } (null if never seen), startedAt = when watching began
    function tick(now, state, startedAt) {
      const out = [], rules = rulesFn() || {}, devs = devicesFn() || {};
      for (const [rid, r] of Object.entries(rules)) {
        if (!r || r.en === false || r.on !== 'notseen' || !(+r.hours > 0)) continue;
        for (const id of r.dev === '*' || !r.dev ? Object.keys(devs) : [r.dev]) {
          const p = state(id), key = `${rid}|${id}`, seen = p ? p.lastSeen : 0;
          if (latched.get(key)) {   // fired: re-arms (and stops repeating) once the device is seen again
            if (seen > latched.get(key)) { latched.delete(key); active.delete(key); }
            continue;
          }
          const ref = seen || startedAt || 0;
          if (!ref || now - ref < +r.hours * 3600000) continue;
          latched.set(key, now);
          const a = make(r, rid, { id, zone: r.zone || (p && p.zone) || '', t: now, lastSeen: seen }, devs[id] || {}, now);
          if (a) out.push(a);
        }
      }
      for (const [k, x] of active) {
        if (now < x.next) continue;
        x.count++; x.next = now + (+(rules[x.alert.rule] || {}).esc || 10) * 60000;
        out.push(Object.assign({}, x.alert, { text: fit(`REPEAT ${x.count}: ${x.alert.text}`), t: now, esc: x.count }));
        if (x.count >= x.max) active.delete(k);
      }
      return out;
    }
    return { evaluate, tick, ack(devId) { let n = 0; for (const [k, x] of active) if (!devId || x.alert.dev === devId) { active.delete(k); n++; } return n; },
      escalating: () => [...active.values()].map(x => ({ key: x.alert.key, text: x.alert.text, count: x.count, next: x.next })) };
  }

  // ---- airtime: one radio, one message at a time. Items are per recipient.
  //   gap  = seconds since the last send before this priority may go; cap = per hour (alarms have their own)
  // telem = BLE telemetry frames to the P25X gateway: last in line, its own gap, outside the hourly cap
  const AIR_DEFAULTS = { gap: { alarm: 20, presence: 120, routine: 600, telem: 300, game: 600 }, hourCap: 20, alarmHourCap: 30, maxAge: { alarm: 7200, presence: 1800, routine: 3600, telem: 3600, game: 1800 }, retrySec: 30, tries: 5, max: P25_TEXT_MAX };
  const AIR_BPS = 380;   // P25 data bytes per second on air, end to end (as the PBBS page measures)
  const airSec = b => round(1 + b / AIR_BPS, 1);
  function AirQueue(opts) {
    const o = Object.assign({}, AIR_DEFAULTS, opts || {}, { gap: Object.assign({}, AIR_DEFAULTS.gap, (opts || {}).gap) });
    const q = [], sent = [];   // sent: { t, to, text, bytes, air, prio, ok }
    let lastAt = 0, seq = 0;
    function push(a, now) {
      for (const to of a.to) {
        const prio = PRIO[a.prio] != null ? a.prio : 'presence';
        if (prio === 'telem') {   // one telemetry slot at a time: the frame is built when it goes, from the latest values
          if (!q.some(x => x.prio === 'telem')) q.push({ id: ++seq, to, text: a.text, prio, t: now, notBefore: 0, tries: 0, n: 1, tlm: true });
          continue;
        }
        if (prio !== 'alarm') {   // coalesce: same recipient + priority, still waiting, and both fit
          const m = q.find(x => x.to === to && x.prio === prio && !x.tries && bytes(`${x.text} | ${a.text}`) <= o.max);
          if (m) { m.text = `${m.text} | ${a.text}`; m.n++; continue; }
        }
        q.push({ id: ++seq, to, text: a.text, prio, t: now, notBefore: 0, tries: 0, n: 1, rule: a.rule, dev: a.dev });
      }
      q.sort((x, y) => PRIO[x.prio] - PRIO[y.prio] || x.t - y.t);
    }
    const inHour = (now, f) => sent.filter(s => s.ok && now - s.t < 3600000 && f(s)).length;
    function next(now) {
      for (let i = q.length - 1; i >= 0; i--) if (now - q[i].t > o.maxAge[q[i].prio] * 1000) q.splice(i, 1);   // stale: dropped
      for (const x of q) {
        if (x.notBefore > now) continue;
        if (now - lastAt < o.gap[x.prio] * 1000) continue;
        if (x.prio === 'alarm' ? inHour(now, s => s.prio === 'alarm') >= o.alarmHourCap
          : x.prio !== 'telem' && x.prio !== 'game' && inHour(now, s => s.prio !== 'alarm' && s.prio !== 'telem' && s.prio !== 'game') >= o.hourCap) continue;
        return x;
      }
      return null;
    }
    function done(x, ok, now) {
      const b = x.size || bytes(x.text);   // a telemetry frame: its real size
      if (ok) { const i = q.indexOf(x); if (i >= 0) q.splice(i, 1); lastAt = now; }
      else if (++x.tries >= o.tries) { const i = q.indexOf(x); if (i >= 0) q.splice(i, 1); }
      else x.notBefore = now + o.retrySec * 1000;
      sent.push({ t: now, to: x.to, text: x.text, bytes: b, air: ok ? airSec(b) : 0, prio: x.prio, ok, n: x.n, dropped: !ok && x.tries >= o.tries });
      while (sent.length > 500) sent.shift();
    }
    function stats(now) {
      const win = ms => sent.filter(s => s.ok && now - s.t < ms);
      const h = win(3600000), d = win(86400000);
      return { queued: q.length, hour: h.filter(s => s.prio !== 'telem').length, day: d.filter(s => s.prio !== 'telem').length, telemDay: d.filter(s => s.prio === 'telem').length, airHour: round(h.reduce((a, s) => a + s.air, 0), 1), airDay: round(d.reduce((a, s) => a + s.air, 0), 1),
        bytesDay: d.reduce((a, s) => a + s.bytes, 0), nextIn: q.length ? Math.max(0, Math.round((lastAt + o.gap[q[0].prio] * 1000 - now) / 1000)) : 0 };
    }
    const drop = x => { const i = q.indexOf(x); if (i >= 0) q.splice(i, 1); };   // nothing to send after all
    return { push, next, done, drop, stats, queue: () => q.slice(), log: () => sent.slice(), load(list) { sent.length = 0; (list || []).slice(-500).forEach(s => sent.push(s)); }, opts: o };
  }

  // ---- telemetry to the P25X gateway (Phase 2): report by exception past a deadband, a heartbeat with every current
  // value, names once a day. Fields = ccdi.js KellyFrame.TELEM_Q (rssi only rides heartbeats: it never stops moving).
  const TELEM_DEADBAND = { temp: 0.3, hum: 2, batt: 2, batt_mv: 50, volt: 0.05, pressure: 1, co2: 50, present: 0, rssi: Infinity,
    door: 0, window: 0, opening: 0, motion: 0, lux: 50, moisture: 2, power: 2, current: 0.05, smoke: 0, count: 0, pm25: 5, pm10: 5, dew: 0.3, tvoc: 25 };
  const telemField = k => (k === 'battMv' ? 'batt_mv' : k);
  const TELEM_MAX_RAW = 190;   // bytes of items per frame: room for stuffing inside the 240-byte payload
  function Telemetry(opts) {
    const o = Object.assign({ heartbeatMin: 30, namesEveryH: 24 }, opts || {});
    const cur = new Map(), sentV = new Map(), names = new Map(), sentNames = new Map();
    let lastBeat = 0;
    const key = (s, f) => `${s}|${f}`;
    function observe(sensor, field, value, t) {
      const f = telemField(field);
      if (!(f in TELEM_DEADBAND) || value == null || !isFinite(value) || !(sensor > 0 && sensor < 255)) return;
      cur.set(key(sensor, f), { sensor, field: f, v: +value, t });
    }
    function setName(sensor, type, name) { names.set(sensor, { type: type || 'other', name: String(name || '').slice(0, 24) }); }
    function forget(sensor) { for (const m of [cur, sentV]) for (const k of [...m.keys()]) if (k.startsWith(sensor + '|')) m.delete(k); names.delete(sensor); sentNames.delete(sensor); }
    const changed = (k, c) => { const s = sentV.get(k); if (TELEM_DEADBAND[c.field] === Infinity) return false; return !s || (TELEM_DEADBAND[c.field] === 0 ? s.v !== c.v : Math.abs(s.v - c.v) >= TELEM_DEADBAND[c.field]); };
    // -> { items, beat, nReadings } to send now, or null. Readings older than 2 heartbeats are stale: not sent.
    function due(now) {
      const beat = now - lastBeat >= o.heartbeatMin * 60000, items = [];
      let raw = 0, nReadings = 0;
      const fits = n => raw + n <= TELEM_MAX_RAW;
      const sensorsIn = new Set();
      for (const [k, c] of cur) {
        if (now - c.t > 2 * o.heartbeatMin * 60000) continue;
        if (!beat && !changed(k, c)) continue;
        if (!fits(9)) break;
        items.push(['reading', c.sensor, c.field, c.v, Math.max(0, Math.round((now - c.t) / 1000))]); raw += 9; nReadings++; sensorsIn.add(c.sensor);
      }
      for (const s of sensorsIn) {
        const n = names.get(s), was = sentNames.get(s);
        if (n && (!was || was.name !== n.name || was.type !== n.type || now - was.at > o.namesEveryH * 3600000) && fits(4 + n.name.length + 2)) {
          items.unshift(['name', s, n.type, n.name]); raw += 4 + new TextEncoder().encode(n.name).length;
        }
      }
      return nReadings ? { items, beat, nReadings } : null;
    }
    function sent(d, now) {
      for (const it of d.items) {
        if (it[0] === 'reading') sentV.set(key(it[1], it[2]), { v: it[3], t: now });
        else sentNames.set(it[1], { name: it[3], type: it[2], at: now });
      }
      if (d.beat) lastBeat = now;
    }
    return { observe, setName, forget, due, sent, forceBeat() { lastBeat = 0; }, opts: o, current: () => [...cur.values()], lastBeat: () => lastBeat };
  }

  // ---- simulator: a house with a keyring iBeacon that comes and goes, a pvvx thermometer, a BTHome go-box with a
  // fading battery, and passers-by phones on rotating addresses. Deterministic for a given seed; t in ms.
  const SIM_UUID = 'f7826da6-4fa2-4e98-8024-bc5b71e0893e';
  function Sim(seed = 1, t0 = Date.now(), zones = ['Home']) {
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const hx = (n, v) => (v >>> 0).toString(16).padStart(n * 2, '0').slice(-n * 2);
    const le = (n, v) => { let o = ''; for (let i = 0; i < n; i++) o += hx(1, (v >> (8 * i)) & 255); return o; };
    const rot = k => { const b = [64 | (Math.floor(rnd() * 64)), ...Array.from({ length: 5 }, () => Math.floor(rnd() * 256))]; return b.map(x => hx(1, x).toUpperCase()).join(':') + (k ? '' : ''); };
    const phones = Array.from({ length: 4 }, () => ({ a: rot(), next: 0 }));
    let seq = 0;
    return {
      uuid: SIM_UUID,
      devices: { keys: { name: 'Keyring beacon', call: 'VK4XXX', type: 'person', match: `ib:${SIM_UUID}:100:1`, en: true },
        shack: { name: 'Shack thermometer', type: 'sensor', match: 'mac:A4:C1:38:5E:22:01', en: true },
        gobox: { name: 'Go-box', type: 'gobox', match: 'mac:E8:31:CD:00:B0:01', en: true } },
      at(t) {   // the adverts heard in the second ending at t
        const out = [], el = (t - t0) / 1000, z = zones[0];
        const base = { n: 'sim', z, ad: 'sim0', ts: t, tx: null, m: {}, s: {}, u: [] };
        // keyring: here for 4 min of every 8 (from 20 s in), fading at the edges
        const ph = (el - 20) % 480;
        if (el > 20 && ph < 240) {
          const edge = Math.min(ph, 240 - ph);
          const r = Math.round(edge < 20 ? -88 + edge / 2 : -62 - rnd() * 8);
          if (rnd() < 0.9) out.push(Object.assign({}, base, { a: rot(), at: 'random', r, m: { 76: `0215${SIM_UUID.replace(/-/g, '')}${hx(2, 100)}${hx(2, 1)}c5` } }));
        }
        if (Math.floor(el) % 3 === 0) {   // thermometer every ~3 s
          const temp = Math.round((24 + 3 * Math.sin(el / 600) + rnd() * 0.2) * 100), hum = Math.round((55 + 5 * Math.cos(el / 900)) * 100);
          out.push(Object.assign({}, base, { a: 'A4:C1:38:5E:22:01', at: 'public', r: -70 - Math.round(rnd() * 6), nm: 'ATC_5E2201',
            s: { '181a': `01225e38c1a4${le(2, temp)}${le(2, hum)}${le(2, 2950)}5a${hx(1, ++seq & 255)}04` } }));
        }
        if (Math.floor(el) % 5 === 0) {   // go-box battery falls 1 % a minute from 25 %
          const batt = Math.max(5, 25 - Math.floor(el / 60));
          out.push(Object.assign({}, base, { a: 'E8:31:CD:00:B0:01', at: 'public', r: -75 - Math.round(rnd() * 5), nm: 'Go-box',
            s: { fcd2: `40${'00'}${hx(1, seq & 255)}01${hx(1, batt)}0c${le(2, 12800 - (25 - batt) * 20)}` } }));
        }
        for (const p of phones) {   // passers-by: rotating addresses, Apple / Samsung manufacturer data
          if (t >= p.next) { p.a = rot(); p.next = t + 60000 + rnd() * 600000; p.cid = rnd() < 0.6 ? 76 : 117; }
          if (rnd() < 0.5) out.push(Object.assign({}, base, { a: p.a, at: 'random', r: -85 - Math.round(rnd() * 12), m: { [p.cid]: p.cid === 76 ? '1005031c' + hx(3, Math.floor(rnd() * 1e7)) : '0100' } }));
        }
        return out;
      },
    };
  }

  // ---- Morse for the CW callsign on arrival: [[on?, units]], 1 unit = 1.2 / wpm s (PARIS)
  const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
    N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '/': '-..-.', '?': '..--..', '.': '.-.-.-', ',': '--..--', '-': '-....-' };
  function morse(text) {
    const out = [];
    const words = String(text || '').toUpperCase().split(/\s+/).filter(Boolean);
    words.forEach((w, wi) => {
      [...w].forEach((ch, ci) => {
        const code = MORSE[ch]; if (!code) return;
        [...code].forEach((el, ei) => { out.push([true, el === '.' ? 1 : 3]); if (ei < code.length - 1) out.push([false, 1]); });
        if (ci < w.length - 1) out.push([false, 3]);
      });
      if (wi < words.length - 1) out.push([false, 7]);
    });
    return out;
  }

  return { hexBytes, toHex, uuidShort, addrKind, ADDR_KIND, rotates, companyName, COMPANIES, decode, DECODERS, custom, idKeys, bestKey, normKey, Registry, filterKeys, phoneBeacon, ibKey, parseIbKey,
    Presence, PRESENCE_DEFAULTS, inWindow, inSchedule, clock, ago, fit, render, bytes, P25_TEXT_MAX, DEFAULT_TPL, TRIGGERS, PRIO, units,
    Rules, AirQueue, AIR_DEFAULTS, airSec, Telemetry, TELEM_DEADBAND, Sim, morse, MORSE };
});
