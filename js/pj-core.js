/* Kelly Page -- LoRa Mesh > Packet Journey: the shared contract (2026-10-24, unreleased). Pure: no DOM, no storage.
 * Every component of the tab (pj-net, pj-sound, pj-stats, pj-inspect, pj-demo) codes against THIS file only; see
 * PACKET_JOURNEY_PLAN.md. Change it only in the integration step -- a component that needs more asks for it.
 *
 * Decoding is js/mcdecode.js (one parser for the whole app); this file turns its answer into one PacketEvent.
 *
 * PacketEvent (frozen once emitted -- never mutate it):
 *   seq      number   1, 2, 3 ... in arrival order
 *   t        number   ms since 1970 (Date.now() on arrival, or the capture's time)
 *   demo     bool     made up by pj-demo (or the MeshCore Demo link), not heard on air
 *   kind     'advert' | 'chat' | 'dm' | 'ack' | 'path' | 'req' | 'unknown'   -- the colour / sound / stats class
 *   type     'ADVERT' | 'GRP_TXT' | ... (KellyMcDecode.TYPES name, or 'type 12')      typeLabel  friendly name
 *   route    'flood' | 'direct'        transport  bool (a transport-code route)        routeName  decoder's name
 *   encrypted bool (payload stays secret to us)      decrypted  bool (one of OUR channels, text below)
 *   hashSize  1 | 2 | 3 | null (trace)               hops  number of path hashes (flood: repeaters travelled)
 *   path      [hex]  path hashes, first first. Flood = repeaters it came through; direct = hops still to go
 *   snrs      [dB]   trace only: the SNR each repeater added
 *   snr, rssi  number | null  how OUR node heard it (dB, dBm)
 *   size      bytes on air (whole packet)            payloadLen  bytes after the path
 *   src       NodeRef | null  who started it, if the packet says (advert key, channel sender name, 1-byte src addr)
 *   dest      { hash } | null  DM / request / response / anon-request target (1-byte address)
 *   journey   [nodeId]  the line to draw: origin -> each repeater -> 'me' (flood); origin -> 'me' (direct: who relayed
 *             it so far isn't in the packet); a TRACE: origin -> the route's repeaters passed so far -> 'me'.
 *             Unknown origin = 'unknown'.     ahead  [nodeId]  direct / trace: hops still to go (we overheard it on the way)
 *   heardFrom nodeId    the last transmitter before us (flood: the last repeater, else the origin; direct with hops
 *             still to go: 'unknown')
 *   text      string | null  decoded channel text        sender  string | null   channel  string | null
 *   gps       { lat, lon } | null  advert location       advert  { name, role, roleId, key } | null
 *   pkey      string   the packet's identity, 8 hex: FNV-1a of payload type + payload (path left out), like MeshCore's
 *             own Packet::calculatePacketHash -- the same flood heard via several repeaters has one pkey
 *   summary   one line from the decoder                  ok  bool   err  string | null
 *   raw       Uint8Array   hex  string   d  the full KellyMcDecode answer (fields for the byte view)
 *
 * Registry: at most 300 nodes (least recently heard dropped; 'me' and 'unknown' stay). NodeRef / registry node: { id, name, hash (shortest known prefix), key|null, role|null ('repeater'...),
 *   lat|null, lon|null, firstSeen, lastSeen, known (from an advert or the companion's contacts) }
 * Node ids: 'me' (our node), 'unknown', a full public key hex once known, else 'h:<hash hex>' (a path hash) or 'n:<name>'
 *   (a channel sender by name). A placeholder is folded into the key node when an advert explains it: reg.get(oldId)
 *   still finds it, reg.canonical(oldId) gives the new id. Registry: get, canonical, all, me, resolve, byName, upsertKey,
 *   clear (shell only), takeChanged (ingest only).
 *
 * Bus events (bus.on(name, fn) -> unsubscribe fn):
 *   'packet'     PacketEvent                     every packet, live or demo
 *   'nodes'      registry                        the node registry changed (new node, name, position)
 *   'select'     { node?: id, packet?: PacketEvent, from: 'net'|'stats'|'inspect'|... }   the user picked something
 *   'visible'    bool                            tab shown / hidden (also page hidden) -- pause when false
 *   'reset'      -                               the user reset the stats / view
 *   'demo'       bool                            demo mode on / off
 * Any component may emit 'select'. Only the shell (pj-ui.js) emits 'visible', 'reset' and 'demo'; only this file's
 * ingest() emits 'packet' and 'nodes'.
 *
 * window.KellyPJ (UMD) = { KINDS, PALETTE, kindOf, createBus, createRegistry, toEvent, ingest, DEMO_CHANNEL } -- see each below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mcdecode.js'));
  else root.KellyPJ = factory(root.KellyMcDecode);
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  // ---------------------------------------------------------------- packet classes, in legend order
  const KINDS = ['advert', 'chat', 'dm', 'ack', 'path', 'req', 'unknown'];
  // colour = the glow / chart colour; dim = the same at low alpha for trails and fills; label = legend text
  const PALETTE = {
    advert: { color: '#00e5ff', dim: 'rgba(0,229,255,.25)', label: 'Advert', icon: '📡' },
    chat: { color: '#39ff88', dim: 'rgba(57,255,136,.25)', label: 'Channel chat', icon: '💬' },
    dm: { color: '#b06bff', dim: 'rgba(176,107,255,.25)', label: 'Encrypted DM', icon: '🔒' },
    ack: { color: '#ffffff', dim: 'rgba(255,255,255,.22)', label: 'ACK', icon: '✔' },
    path: { color: '#ffb020', dim: 'rgba(255,176,32,.25)', label: 'Path / trace', icon: '🧭' },
    req: { color: '#3ba8ff', dim: 'rgba(59,168,255,.25)', label: 'Request / response', icon: '🔁' },
    unknown: { color: '#ff3b5c', dim: 'rgba(255,59,92,.25)', label: 'Raw / unknown', icon: '❓' },
  };
  // decoder type name -> kind. CONTROL (node discover) is a request / answer; MULTIPART is (in practice) a repeated ACK.
  const KIND_OF = { ADVERT: 'advert', GRP_TXT: 'chat', GRP_DATA: 'chat', TXT_MSG: 'dm', ACK: 'ack', MULTIPART: 'ack',
    PATH: 'path', TRACE: 'path', REQ: 'req', RESPONSE: 'req', ANON_REQ: 'req', CONTROL: 'req' };
  const kindOf = d => (d && d.ok && KIND_OF[d.typeName]) || 'unknown';

  // ---------------------------------------------------------------- bus
  function createBus() {
    const subs = new Map();
    return {
      on(name, fn) { if (!subs.has(name)) subs.set(name, new Set()); subs.get(name).add(fn); return () => subs.get(name).delete(fn); },
      // a subscriber that throws is logged and skipped -- one broken component never stops the others
      emit(name, x) { const s = subs.get(name); if (!s) return; for (const fn of [...s]) { try { fn(x); } catch (e) { console.warn('Packet Journey', name, e); } } },
    };
  }

  // ---------------------------------------------------------------- node registry
  // opts.byPrefix(hex) -> [{ name, key, role }] = the companion's contacts (mesh.js); opts.myName() -> string
  // MAX_NODES: a club display runs for days on a mesh of hundreds; the least recently heard go first (reg.get(old id) -> undefined)
  const MAX_NODES = 300;
  function createRegistry(opts = {}) {
    const max = opts.max || MAX_NODES;
    const nodes = new Map(), alias = new Map(), now = () => Date.now();   // alias: a folded placeholder id -> the id it became
    const mk = (id, o) => Object.assign({ id, name: '', hash: '', key: null, role: null, lat: null, lon: null, firstSeen: now(), lastSeen: now(), known: false }, o);
    nodes.set('me', mk('me', { name: 'My node', known: true }));
    nodes.set('unknown', mk('unknown', { name: 'Unknown sender' }));
    let changed = false;
    const touch = n => { n.lastSeen = now(); return n; };
    function trim() {
      if (nodes.size <= max) return;
      const old = [...nodes.values()].filter(n => n.id !== 'me' && n.id !== 'unknown').sort((a, b) => a.lastSeen - b.lastSeen);
      for (const n of old.slice(0, nodes.size - max)) nodes.delete(n.id);
      for (const [a, id] of alias) if (!nodes.has(id)) alias.delete(a);
      changed = true;
    }
    function upsertKey(key, o = {}) {
      key = key.toLowerCase();
      let n = nodes.get(key);
      if (!n) {
        n = mk(key, { key, hash: key.slice(0, 4), known: true }); nodes.set(key, n); changed = true;
        // a placeholder 'h:<prefix>' this key explains is folded in: keep its first-seen, drop it -- unless another
        // known key shares the prefix (1-byte hashes): then nobody can say whose it was, and it stays a placeholder
        const shared = h => { for (const m of nodes.values()) if (m !== n && m.key && m.key.startsWith(h)) return true; return false; };
        for (const [id, p] of nodes) if (id.startsWith('h:') && key.startsWith(p.hash) && !shared(p.hash)) { n.firstSeen = Math.min(n.firstSeen, p.firstSeen); nodes.delete(id); alias.set(id, key); }
      }
      if (o.name && !o.raw && n.raw && n.raw === o.name) o = { ...o, name: null };   // the same name again: keep its callsign label
      for (const f of ['name', 'raw', 'role', 'lat', 'lon']) if (o[f] != null && o[f] !== '' && n[f] !== o[f]) { n[f] = o[f]; changed = true; }
      trim();
      return touch(n);
    }
    // a path hash -> the node it stands for: one known key starting with it, else a placeholder per hash
    function resolve(hash) {
      hash = String(hash || '').toLowerCase();
      if (!hash) return nodes.get('unknown');
      const hits = []; for (const n of nodes.values()) if (n.key && n.key.startsWith(hash)) hits.push(n);
      if (hits.length === 1) return touch(hits[0]);
      if (!hits.length && opts.byPrefix) {
        const c = opts.byPrefix(hash);
        if (c.length === 1) return upsertKey(c[0].key, { name: c[0].label || c[0].name, raw: c[0].name, role: c[0].role || null });   // label: with its callsign (Ham Contacts)
      }
      const id = 'h:' + hash;
      let n = nodes.get(id);
      if (!n) { n = mk(id, { hash, name: hits.length > 1 ? `${hash} (${hits.length} nodes)` : hash }); nodes.set(id, n); changed = true; trim(); }
      return touch(n);
    }
    function byName(name) {   // a channel sender: match a known node's name, else a named placeholder
      const q = String(name || '').trim(); if (!q) return nodes.get('unknown');
      for (const n of nodes.values()) { const nm = n.raw || n.name; if (nm && nm.toLowerCase() === q.toLowerCase()) return touch(n); }
      const id = 'n:' + q.toLowerCase();
      let n = nodes.get(id); if (!n) { n = mk(id, { name: q }); nodes.set(id, n); changed = true; trim(); }
      return touch(n);
    }
    return {
      // get() follows a folded placeholder ('h:3308' -> the full key from a later advert), so an older event's ids still work
      get: id => nodes.get(id) || nodes.get(alias.get(id)), canonical: id => nodes.has(id) ? id : alias.get(id) || id,
      all: () => [...nodes.values()], upsertKey, resolve, byName,
      me() { const n = nodes.get('me'); const m = opts.myName && opts.myName(); if (m && n.name !== m) { n.name = m; changed = true; } return n; },
      takeChanged() { const c = changed; changed = false; return c; },
      clear() { for (const id of [...nodes.keys()]) if (id !== 'me' && id !== 'unknown') nodes.delete(id); alias.clear(); changed = true; },
    };
  }

  // ---------------------------------------------------------------- KellyMcDecode answer -> PacketEvent
  let seq = 0;
  const pkeyOf = (raw, type, payLen) => { let h = 0x811c9dc5 ^ (type & 255); h = Math.imul(h, 16777619); for (let i = raw.length - payLen; i < raw.length; i++) { h ^= raw[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); };
  const ref = n => n ? { id: n.id, name: n.name, hash: n.hash, key: n.key, role: n.role, lat: n.lat, lon: n.lon } : null;
  function toEvent(d, rx, reg) {
    const i = d.info || {}, kind = kindOf(d), flood = !!d.flood;
    let src = null, gps = null, advert = null;
    if (i.advert) {
      const a = i.advert;
      advert = { name: a.name || '', role: a.role, roleId: a.roleId, key: a.key };
      if (a.lat != null && a.lon != null && !(a.lat === 0 && a.lon === 0)) gps = { lat: a.lat, lon: a.lon };
      src = reg.upsertKey(a.key, { name: a.name, role: a.roleId === 2 ? 'repeater' : a.roleId === 3 ? 'room server' : a.roleId === 4 ? 'sensor' : a.roleId === 1 ? 'companion' : null, lat: gps && gps.lat, lon: gps && gps.lon });
    } else if (i.sender) src = reg.byName(i.sender);
    else if (i.src) src = reg.resolve(i.src);
    reg.me();   // keeps our own name current
    const origin = src ? src.id : 'unknown';
    let journey, ahead, heardFrom;
    if (d.typeName === 'TRACE' && i.trace) {   // the route is in the payload; each repeater passed so far added one SNR
      const route = i.trace.hashes.map(h => reg.resolve(h).id), done = Math.min(route.length, (d.snrs || []).length);
      journey = [origin, ...route.slice(0, done), 'me']; ahead = route.slice(done);
      heardFrom = done ? route[done - 1] : origin;
    } else if (flood) {   // the path is the repeaters it came through, first first
      const pathNodes = (d.path || []).map(h => reg.resolve(h));
      journey = [origin, ...pathNodes.map(n => n.id), 'me']; ahead = [];
      heardFrom = pathNodes.length ? pathNodes[pathNodes.length - 1].id : origin;
    } else {   // direct: the path is the hops still to go; who relayed it so far isn't in the packet
      ahead = (d.path || []).map(h => reg.resolve(h).id); journey = [origin, 'me'];
      heardFrom = ahead.length ? 'unknown' : origin;
    }
    const ev = {
      seq: ++seq, t: rx.t || Date.now(), demo: !!rx.demo, kind,
      type: d.typeName || '?', typeLabel: d.friendly || d.typeName || '?', route: flood ? 'flood' : 'direct', transport: d.route === 0 || d.route === 3, routeName: d.routeName || '',
      encrypted: !!d.encrypted, decrypted: !!d.decrypted, hashSize: d.hashSize ?? null, hops: d.hops || 0, path: (d.path || []).slice(), snrs: d.snrs ? d.snrs.slice() : [],
      snr: rx.snr ?? null, rssi: rx.rssi ?? null, size: d.len, payloadLen: d.payloadLen || 0,
      src: ref(src), dest: i.dest ? { hash: i.dest } : null, journey, ahead, heardFrom,
      text: i.text ?? null, sender: i.sender ?? null, channel: i.channel ?? null, gps, advert,
      pkey: rx.raw ? pkeyOf(rx.raw, d.type ?? 255, d.payloadLen || 0) : null,
      summary: d.ok ? d.summary : (d.err || 'undecodable'), ok: !!d.ok, err: d.err || null,
      raw: rx.raw, hex: d.hex, d,
    };
    return Object.freeze(ev);
  }

  // rx = { raw: Uint8Array | hex, snr, rssi, t?, demo? }; decodeOpts = { channels, expectHash } (+ extra demo channels)
  // -> the PacketEvent, already emitted on the bus as 'packet' (and 'nodes' first when the registry changed)
  function ingest(bus, reg, rx, decodeOpts) {
    const raw = rx.raw instanceof Uint8Array ? rx.raw : D.unhex(rx.raw);
    const ev = toEvent(D.decode(raw, decodeOpts || {}), Object.assign({}, rx, { raw }), reg);
    if (reg.takeChanged()) bus.emit('nodes', reg);
    bus.emit('packet', ev);
    return ev;
  }

  // demo mode's own channel (pj-demo encrypts with it, the shell lends it to the decoder): key = sha256('#packet-journey')[0..16]
  const DEMO_CHANNEL = D ? { name: '#pj-demo', secret: D.sha256(new TextEncoder().encode('#packet-journey')).subarray(0, 16) } : null;

  return { KINDS, PALETTE, kindOf, createBus, createRegistry, toEvent, ingest, DEMO_CHANNEL };
});
