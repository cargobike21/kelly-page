/* Kelly Page -- MeshCore path hash size check (2026-10-24: "catch stations on the wrong byte size, ours or
 * anyone's"). Pure logic + a log; the alert card and the self-check warning are drawn by js/mesh.js.
 *
 * Where the size shows (MeshCore v1.18.0, see js/mcdecode.js): the path_len byte, top 2 bits = hash size - 1
 * (src/Packet.h getPathHashSize). The SENDER picks it -- Mesh::sendFlood(pkt, delay, path_hash_mode + 1) -- and every
 * repeater adds its own hash at that size (Mesh::routeRecvPacket). So a received flood packet shows the setting of the
 * node that STARTED it, even with no hops. But replies don't: a repeater answers at the requester's size
 * (simple_repeater MyMesh::sendFloodReply), and PATH / RESPONSE / ACK follow the conversation. Hence:
 *   certain  a flood ADVERT (full public key) or ANON_REQ (the sender's full key travels in it)
 *   likely   a flood channel message we could decrypt (the sender's name is inside), a flood TXT_MSG / REQ (only a
 *            1-byte sender address -- may match several contacts), a channel message we can't read (no sender)
 *   ignored  RESPONSE, PATH, ACK, TRACE, CONTROL, MULTIPART, anything direct-routed
 * Our own node: the companion's DEVICE_INFO byte 81 (path_hash_mode), checked at connect and when the setting changes.
 *
 * KellyMcHashCheck.create({ store, now? }) -> { check(dec, ev, ctx), self(mode, expected), nodes(), log(), clear() }
 *   ctx = { expected, byPrefix(hex) -> [{ name, key, role }] }.  Also the pure evaluate(dec, expected, ctx) and hint(rec).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyMcHashCheck = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const LOG_CAP = 500, NODE_CAP = 200, SAME_PKT_MS = 5 * 60000, ALERT_EVERY_MS = 24 * 3600000;

  // one decoded packet -> a verdict about the node that sent it, or null (nothing to say / not evidence)
  function evaluate(dec, expected, ctx = {}) {
    if (!dec || !dec.ok || !dec.flood || !dec.hashSize || !expected) return null;
    const i = dec.info || {}, base = { size: dec.hashSize, expected, ok: dec.hashSize === expected, type: dec.typeName, hops: dec.hops, path: dec.path || [] };
    switch (dec.typeName) {
      case 'ADVERT':
        if (!i.advert) return null;
        return Object.assign(base, { strength: 'certain', id: `key:${i.advert.key}`, key: i.advert.key, name: i.advert.name || i.advert.key.slice(0, 8), role: i.advert.role });
      case 'ANON_REQ': {
        const m = (ctx.byPrefix ? ctx.byPrefix(i.ephKey.slice(0, 12)) : [])[0];
        return Object.assign(base, { strength: 'certain', id: `key:${i.ephKey}`, key: i.ephKey, name: m ? m.name : i.ephKey.slice(0, 8), role: m && m.role });
      }
      case 'GRP_TXT': case 'GRP_DATA':
        if (i.sender) return Object.assign(base, { strength: 'likely', id: `name:${i.sender}`, name: i.sender, via: `#${String(i.channel || '').replace(/^#/, '')}` });
        return Object.assign(base, { strength: 'likely', id: `ch:${i.chHash}`, name: `someone on channel ${i.chHash}`, unknown: true });
      case 'TXT_MSG': case 'REQ': {
        const m = ctx.byPrefix ? ctx.byPrefix(i.src) : [];
        return Object.assign(base, { strength: 'likely', id: m.length === 1 ? `key:${m[0].key}` : `src:${i.src}`, key: m.length === 1 ? m[0].key : undefined,
          name: m.length === 1 ? m[0].name : m.length ? `${m.map(x => x.name).slice(0, 3).join(' / ')}${m.length > 3 ? ' …' : ''} (address ${i.src})` : `address ${i.src}`, role: m.length === 1 ? m[0].role : undefined, unknown: m.length !== 1 });
      }
      default: return null;   // replies and the rest follow someone else's size
    }
  }

  // plain-English fix for one node (rec from evaluate)
  function hint(rec) {
    const mode = rec.expected - 1, fw = rec.size === 1 ? ' If it is on firmware older than v1.14 it can only do 1-byte: update the firmware first.' : '';
    const rpt = `On the repeater's command line (the MeshCore app's repeater admin, Kelly's Repeater management › CLI, or USB): set path.hash.mode ${mode}, then reboot (and set its clock again).`;
    const cmp = `In the MeshCore app: Settings › Network Settings › Default Path Hash Size › ${rec.expected}-byte, then tick to save.`;
    const role = String(rec.role || '');
    const how = /repeater|room/.test(role) ? rpt : /companion|chat/.test(role) ? cmp : `${cmp} For a repeater or room server: set path.hash.mode ${mode}, then reboot.`;
    return `${rec.name} sends ${rec.size}-byte path hashes; this network expects ${rec.expected}-byte. ${how}${fw}`;
  }

  function create({ store, now = () => Date.now() } = {}) {
    const S = store || { get: (k, d) => d, set() {} };
    let nodes = S.get('meshHashNodes', {}) || {}, log = S.get('meshHashLog', []) || [];
    const seen = new Map();   // payload -> time (the same flood heard again via another repeater)
    const save = () => {
      const ids = Object.keys(nodes).sort((a, b) => nodes[b].last - nodes[a].last);
      if (ids.length > NODE_CAP) for (const id of ids.slice(NODE_CAP)) delete nodes[id];
      S.set('meshHashNodes', nodes); S.set('meshHashLog', log.slice(-LOG_CAP));
    };
    // -> { rec, alert } when this packet shows a node on the wrong size (alert = first time, or a day since the last)
    function check(dec, ev = {}, ctx = {}) {
      const rec = evaluate(dec, ctx.expected, ctx);
      if (!rec || rec.ok) return null;
      const t = now(), pk = dec.hex.slice(-48);
      for (const [x, at] of seen) if (t - at > SAME_PKT_MS) seen.delete(x);
      if (seen.has(pk)) return null;
      seen.set(pk, t);
      const n = nodes[rec.id] || { id: rec.id, first: t, count: 0, alerted: 0 };
      Object.assign(n, { name: rec.name, key: rec.key || n.key, role: rec.role || n.role, size: rec.size, expected: rec.expected, strength: rec.strength === 'certain' || n.strength === 'certain' ? 'certain' : 'likely',
        type: rec.type, last: t, hops: rec.hops, snr: ev.snr, unknown: !!rec.unknown });
      n.count++;
      const alert = !n.alerted || t - n.alerted > ALERT_EVERY_MS;
      if (alert) n.alerted = t;
      nodes[rec.id] = n;
      log.push({ t, id: rec.id, name: rec.name, size: rec.size, expected: rec.expected, strength: rec.strength, type: rec.type, hops: rec.hops, path: rec.path, snr: ev.snr, rssi: ev.rssi, hex: dec.hex });
      if (log.length > LOG_CAP * 1.2) log = log.slice(-LOG_CAP);
      save();
      return { rec: Object.assign({}, rec, { hint: hint(rec) }), node: n, alert };
    }
    // our own companion: mode = DEVICE_INFO path_hash_mode (0/1/2) -> { ours, expected, ok } or null (not known)
    const self = (mode, expected) => mode == null || !expected ? null : { ours: mode + 1, expected, ok: mode + 1 === expected, mode, wantMode: expected - 1 };
    return {
      check, self,
      nodes: () => Object.values(nodes).sort((a, b) => b.last - a.last),
      log: () => log.slice(),
      forget: id => { delete nodes[id]; save(); },
      clear: () => { nodes = {}; log = []; seen.clear(); save(); },
    };
  }

  return { create, evaluate, hint };
});
