/* P25X mesh alert bridge -- the rules engine (docs/lora-mesh-gap-analysis.md Phase 3, section 4.4).
 *
 * ONE engine in two places, the same rule JSON in both:
 *   gateway/mesh-bridge-rules.js   the gateway (default): alarms, P25 texts -> the club mesh node
 *   kelly-page/js/mesh-bridge-rules.js                   Kelly "direct" mode: a town with no P25X gateway (simplex)
 * The two files are IDENTICAL -- edit one, copy it over (mesh-bridge-rules-test.js checks they match).
 * Pure UMD, no dependencies: Node (require) and the browser (window.MeshBridgeRules). No timers of its own -- the host
 * calls pump() / tick() and passes the clock in, so it runs the same under tests.
 *
 * What it does, per event (an alarm, a P25 text, an emergency, a status):
 *   match     rules (source, alarm id, category, talkgroup, unit ID, priority, keyword) -> targets
 *             (MeshCore channel or contact, Meshtastic P25X channel, LoRaWAN device)
 *   dedupe    the same alert to the same target inside dedupeS is sent once
 *   encode    compact, versioned text a human can read on any mesh screen: "P1!SOS 3k VK4RBX 1932 text"
 *   queue     priority classes critical > priority > routine, capped
 *   limit     a self-imposed airtime budget per rolling hour (Australia has no duty-cycle limit, 4.2 / 5.6): routine
 *             0.5 %, priority adds 0.5 %, critical has a 1 % reserve the others never touch; pacing 20 s / 10 s / none;
 *             routine max 6 per destination per hour. Time on air is COMPUTED (Semtech formula) from the bytes.
 *   track     each alert: P25 receipt -> mesh sent / ACK (DMs) -> human ack ("ACK 3k" back on the mesh), with an
 *             escalation timer that re-sends (as priority, or critical's own 30 s repeats) until someone acks
 *   reverse   mesh -> P25 only from senders on a whitelist keyed on the MeshCore PUBLIC KEY. A DM carries the
 *             sender's key, so it's proven. A channel post carries only a free-text name: with reverse.channelByName
 *             (on by default, 2026-10-21) a post whose name holds a whitelisted CALLSIGN is forwarded too, and
 *             audited as "name only, not key-verified" -- anyone can type that name, so the audit says so
 *   audit     one record per decision, for the host to append as JSONL
 * Everything is off until cfg.enabled (gateway data/mesh-bridge.json, Kelly settings.mesh.rules).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeshBridgeRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 1;
  const CLASSES = ['routine', 'priority', 'critical'];
  const RANK = { routine: 0, priority: 1, critical: 2 };
  const SOURCES = ['alarm', 'text', 'emergency', 'status'];
  const NETS = ['meshcore', 'meshtastic', 'lorawan'];
  // short codes for the compact encoder: event kind / alarm category -> 2-4 letters. P25 status numbers map through
  // cfg.statusCodes (a radio's status list is per code plug) -- "S<n>" when there's no entry.
  const CODES = { emergency: 'SOS', sos: 'SOS', site: 'SITE', 'site-offline': 'SOFF', offline: 'SOFF', mains: 'MAIN', power: 'PWR', battery: 'BATT',
    solar: 'SOL', temperature: 'TEMP', geofence: 'GEO', proximity: 'PROX', encryption: 'ENC', watchdog: 'WDOG', weather: 'WX',
    fire: 'FIRE', flood: 'FLD', text: 'TXT', status: 'STS', test: 'TEST', alarm: 'ALM' };
  const CLS_CHAR = { routine: '-', priority: '+', critical: '!' };
  const CHAR_CLS = { '-': 'routine', '+': 'priority', '!': 'critical' };

  const DEFAULTS = {
    enabled: false,
    radio: { sf: 8, bw: 62.5, cr: 5, preamble: 8 },   // the club MeshCore preset: 923.125 MHz / BW 62.5 / SF8 / CR 4/5
    budget: { routinePct: 0.5, priorityPct: 0.5, criticalPct: 1, routineGapS: 20, priorityGapS: 10, criticalRepeatS: 30, perDestHour: 6, repeaters: 10 },   // repeaters: how many retransmit a flood (channel-use estimate only). SEQ floods cross the
                                                                          // whole mesh, Sunshine Coast to the NSW border (no region codes, MBUG wiki), so 10 is a floor
    dedupeS: 600,
    escalation: { ackMin: 10, maxRepeats: 2 },
    queueMax: 50,
    maxText: 140,
    statusCodes: {},
    rules: [],
    reverse: { enabled: false, channelByName: true, allow: [] },   // allow: [{ key: '12+ hex of the MeshCore public key', call: 'VK4XYZ' }]
    // MeshCore #Public: every post floods all of SEQ (no region codes) and MBUG asks for floods kept low, so automated
    // alerts don't go there unless this is set. Use a private P25X channel, #emergency for radio emergencies, #test for tests.
    allowPublic: false,
  };

  // ------------------------------------------------------------------ config
  const isHex = (s, min) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${min},64}$`, 'i').test(s);
  const arr = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
  // a MeshCore target on the node's #Public channel? channels = { index: name } from the node (the host knows them)
  const isPublicCh = (t, channels) => !!(t && t.net === 'meshcore' && Number.isInteger(t.ch) && channels && /^#?public$/i.test(String(channels[t.ch] || '').trim()));
  const PUBLIC_WHY = 'is #Public -- an automated post there floods the whole SEQ mesh (MBUG asks for floods kept low). Use a private P25X channel, #emergency for radio emergencies or #test for tests; or set "allowPublic": true';
  function normalise(cfg) {
    const c = cfg || {};
    const out = {
      ...DEFAULTS, ...c,
      radio: { ...DEFAULTS.radio, ...(c.radio || {}) },
      budget: { ...DEFAULTS.budget, ...(c.budget || {}) },
      escalation: { ...DEFAULTS.escalation, ...(c.escalation || {}) },
      reverse: { ...DEFAULTS.reverse, ...(c.reverse || {}) },
      statusCodes: { ...(c.statusCodes || {}) },
    };
    out.enabled = !!out.enabled;
    out.reverse.enabled = !!out.reverse.enabled;
    out.reverse.allow = arr(out.reverse.allow).map((a) => ({ key: String(a.key || '').toLowerCase(), call: String(a.call || '').toUpperCase() }));
    out.reverse.channelByName = out.reverse.channelByName !== false;
    out.rules = arr(c.rules).map((r, i) => ({
      id: String(r.id || `r${i + 1}`), name: String(r.name || r.id || `Rule ${i + 1}`), enabled: r.enabled !== false,
      match: { ...(r.match || {}) }, cls: r.cls || r.priority || null, targets: arr(r.targets), format: r.format === 'text' ? 'text' : 'compact',
      escalate: !!r.escalate,
    }));
    return out;
  }
  // -> [] when good, else a list of what's wrong (the Tools page shows these and refuses to save)
  // opts.channels = the node's { index: name }: with it, #Public targets are refused unless cfg.allowPublic
  function validate(cfg, opts = {}) {
    const e = [], c = normalise(cfg), ids = new Set();
    const num = (v, lo, hi, what) => { if (!(typeof v === 'number' && v >= lo && v <= hi)) e.push(`${what} must be a number ${lo}-${hi}`); };
    num(c.radio.sf, 5, 12, 'radio.sf'); num(c.radio.bw, 7.8, 500, 'radio.bw'); num(c.radio.cr, 5, 8, 'radio.cr'); num(c.radio.preamble, 6, 64, 'radio.preamble');
    num(c.budget.routinePct, 0, 10, 'budget.routinePct'); num(c.budget.priorityPct, 0, 10, 'budget.priorityPct'); num(c.budget.criticalPct, 0, 10, 'budget.criticalPct');
    num(c.budget.routineGapS, 0, 3600, 'budget.routineGapS'); num(c.budget.priorityGapS, 0, 3600, 'budget.priorityGapS'); num(c.budget.criticalRepeatS, 10, 3600, 'budget.criticalRepeatS');
    num(c.budget.perDestHour, 1, 120, 'budget.perDestHour'); num(c.budget.repeaters, 0, 60, 'budget.repeaters');
    num(c.dedupeS, 0, 86400, 'dedupeS'); num(c.escalation.ackMin, 1, 1440, 'escalation.ackMin'); num(c.escalation.maxRepeats, 0, 10, 'escalation.maxRepeats');
    num(c.queueMax, 1, 500, 'queueMax'); num(c.maxText, 40, 160, 'maxText');
    c.rules.forEach((r, i) => {
      const at = `rule ${i + 1} (${r.id})`;
      if (ids.has(r.id)) e.push(`${at}: duplicate id`); ids.add(r.id);
      for (const s of arr(r.match.source)) if (!SOURCES.includes(s)) e.push(`${at}: unknown source "${s}" (have ${SOURCES.join(', ')})`);
      if (r.match.priority != null && !CLASSES.includes(r.match.priority)) e.push(`${at}: match.priority must be one of ${CLASSES.join(', ')}`);
      if (r.cls != null && !CLASSES.includes(r.cls)) e.push(`${at}: cls must be one of ${CLASSES.join(', ')}`);
      for (const u of arr(r.match.unit)) if (!/^\d{1,8}$/.test(String(u))) e.push(`${at}: unit "${u}" is not a radio ID`);
      for (const t of arr(r.match.talkgroup)) if (!/^\d{1,5}$/.test(String(t))) e.push(`${at}: talkgroup "${t}" is not a talkgroup number`);
      if (!r.targets.length) e.push(`${at}: no targets`);
      r.targets.forEach((t, j) => {
        const tt = `${at} target ${j + 1}`;
        if (!NETS.includes(t.net)) e.push(`${tt}: net must be one of ${NETS.join(', ')}`);
        else if (t.net === 'meshcore' && !(Number.isInteger(t.ch) && t.ch >= 0 && t.ch <= 7) && !isHex(t.to, 12)) e.push(`${tt}: a MeshCore target needs ch 0-7 or to (12+ hex of the contact's key)`);
        else if (t.net === 'meshtastic' && !t.channel) e.push(`${tt}: a Meshtastic target needs a channel (e.g. "P25X")`);
        else if (t.net === 'lorawan' && !isHex(t.dev, 16)) e.push(`${tt}: a LoRaWAN target needs dev (the 16-hex DevEUI)`);
        else if (!c.allowPublic && isPublicCh(t, opts.channels)) e.push(`${tt}: channel ${t.ch} ${PUBLIC_WHY}`);
      });
    });
    c.reverse.allow.forEach((a, i) => { if (!isHex(a.key, 12)) e.push(`reverse.allow ${i + 1}: key must be 12+ hex digits of the MeshCore public key (not a name)`); if (!/^[A-Z]{1,2}\d[A-Z]{1,4}$/.test(a.call)) e.push(`reverse.allow ${i + 1}: call "${a.call}" isn't a callsign`); });
    return e;
  }

  // ------------------------------------------------------------------ matching
  const lc = (s) => String(s == null ? '' : s).toLowerCase();
  const wordIn = (text, kw) => new RegExp(`(^|[^a-z0-9])${lc(kw).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(lc(text));
  // event: { source, alarm?, category?, talkgroup?, unit?, priority?, text, label? }
  function ruleMatches(r, ev) {
    if (!r.enabled) return false;
    const m = r.match;
    const any = (list, v) => { const l = arr(list); return !l.length || l.map(String).map(lc).includes(lc(v)); };
    if (!any(m.source, ev.source)) return false;
    if (!any(m.alarm, ev.alarm)) return false;
    if (!any(m.category, ev.category)) return false;
    if (!any(m.talkgroup, ev.talkgroup)) return false;
    if (!any(m.unit, ev.unit)) return false;
    if (m.priority && RANK[ev.priority || 'routine'] < RANK[m.priority]) return false;
    const kws = arr(m.keyword);
    if (kws.length && !kws.some((k) => wordIn(`${ev.label || ''} ${ev.text || ''}`, k))) return false;
    return true;
  }
  // -> [{ rule, cls, target }] one per (rule, target); the highest class wins when two rules hit the same target
  function match(ev, cfg) {
    const byTarget = new Map();
    for (const r of cfg.rules) {
      if (!ruleMatches(r, ev)) continue;
      const cls = r.cls || ev.priority || 'routine';
      for (const t of r.targets) {
        const k = targetKey(t), old = byTarget.get(k);
        if (!old || RANK[cls] > RANK[old.cls]) byTarget.set(k, { rule: r, cls, target: t });
      }
    }
    return [...byTarget.values()];
  }
  const targetKey = (t) => (t.net === 'meshcore' ? (t.to ? `meshcore:dm:${lc(t.to).slice(0, 12)}` : `meshcore:ch:${t.ch}`) : t.net === 'meshtastic' ? `meshtastic:${lc(t.channel)}` : `lorawan:${lc(t.dev)}`);

  // ------------------------------------------------------------------ compact encoding
  // "P1" version, class char, code, " ", ref, " ", source (callsign / unit / site), " ", HHMM local, " ", text
  //   P1!SOS 3k VK4XXX 1932 Fallen at the shed, need help
  //   P1+SOFF 3m VK4RBX 0412 Ipswich repeater offline
  // ASCII only (P25 texts and every mesh screen), cut to maxBytes. The ref is what a human sends back: "ACK 3k".
  const ascii = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/ {2,}/g, ' ').trim();
  function codeOf(ev, cfg) {
    if (ev.source === 'status' && ev.status != null) return String((cfg.statusCodes || {})[ev.status] || `S${ev.status}`).toUpperCase().slice(0, 4);
    if (ev.source === 'emergency') return 'SOS';
    return CODES[lc(ev.code || ev.category || ev.alarm)] || CODES[ev.source] || 'ALM';
  }
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`; };
  function encode(ev, { cls, ref, at, format = 'compact', maxBytes = 140, cfg = DEFAULTS } = {}) {
    const text = ascii(ev.text || ev.label || '');
    if (format === 'text') {
      const head = `[P25X${ref ? ` ${ref}` : ''}] `;
      return (head + text).slice(0, maxBytes);
    }
    const src = ascii(ev.from || ev.site || (ev.unit != null ? String(ev.unit) : 'P25X')).replace(/ /g, '').slice(0, 10) || 'P25X';
    const head = `P${VERSION}${CLS_CHAR[cls] || '-'}${codeOf(ev, cfg)} ${ref || '0'} ${src} ${hhmm(at || Date.now())} `;
    let body = text;
    if (head.length + body.length > maxBytes) body = `${body.slice(0, Math.max(0, maxBytes - head.length - 2))}..`;
    return (head + body).slice(0, maxBytes);
  }
  // -> { v, cls, code, ref, from, hhmm, text } or null
  function decode(s) {
    const m = /^P(\d+)([-+!])([A-Z0-9]{1,4}) ([0-9a-z]+) (\S+) (\d{4}) ?([\s\S]*)$/.exec(String(s || ''));
    if (!m) return null;
    return { v: Number(m[1]), cls: CHAR_CLS[m[2]], code: m[3], ref: m[4], from: m[5], hhmm: m[6], text: m[7] };
  }
  // "ACK 3k", "ack #3k", "3k ack", "ACK P1!SOS 3k" -> '3k'
  function parseAck(text) {
    const t = String(text || '').trim();
    let m = /^ack\b\s*(?:P\d[-+!][A-Z0-9]{1,4}\s+)?#?([0-9a-z]{1,6})\b/i.exec(t) || /^#?([0-9a-z]{1,6})\s+ack\b/i.exec(t);
    return m ? m[1].toLowerCase() : null;
  }

  // ------------------------------------------------------------------ airtime
  // LoRa time on air (Semtech AN1200.13): explicit header, CRC on, low-data-rate optimise when a symbol > 16 ms
  function timeOnAir(bytes, radio = DEFAULTS.radio) {
    const sf = radio.sf, bw = radio.bw * 1000, cr = radio.cr - 4, tsym = (2 ** sf) / bw, de = tsym > 0.016 ? 1 : 0;
    const n = 8 + Math.max(Math.ceil((8 * bytes - 4 * sf + 28 + 16) / (4 * (sf - 2 * de))) * (cr + 4), 0);
    return (radio.preamble + 4.25 + n) * tsym;
  }
  // bytes a MeshCore text takes on air: header + path_len + hashes/MAC, then the encrypted body (timestamp, flags,
  // ["name: "] text) padded to the 16-byte cipher block. An estimate: the path grows by a byte per repeater hop.
  function meshcoreAirBytes(textBytes, { dm = false, nameLen = 0 } = {}) {
    const plain = 4 + 1 + (dm ? 0 : nameLen + 2) + textBytes;
    return 2 + (dm ? 2 : 1) + 2 + Math.ceil(plain / 16) * 16;
  }
  // The other nets' radios (Phase 7). Meshtastic: SEQ's MEDIUM_FAST preset, slot 45 / 926.125 MHz since May 2025 (MBUG wiki
  // mf-config; SF9 / BW250, 16-symbol preamble), ~20
  // bytes of header + protobuf around the text; its own limiter, same budget figures. LoRaWAN: a downlink at AU915 RX2 DR8
  // (SF12 / BW500), 13 bytes of MAC header + MIC; not budgeted here -- lorawan.js caps it per device per day (5.6).
  const MESHTASTIC_RADIO = { sf: 9, bw: 250, cr: 5, preamble: 16 }, LORAWAN_RADIO = { sf: 12, bw: 500, cr: 5, preamble: 8 };
  function airFor(target, textBytes, radio = DEFAULTS.radio) {
    if (target.net === 'meshtastic') return timeOnAir(20 + textBytes, MESHTASTIC_RADIO);
    if (target.net === 'lorawan') return timeOnAir(13 + textBytes, LORAWAN_RADIO);
    return timeOnAir(meshcoreAirBytes(textBytes, { dm: !!target.to, nameLen: 8 }), radio);
  }
  const byteLen = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf8'));

  // ------------------------------------------------------------------ limiter (rolling hour of OUR transmissions)
  class Limiter {
    constructor(budget, radio) { this.b = budget; this.radio = radio; this.log = []; this.lastAt = { routine: -Infinity, priority: -Infinity, critical: -Infinity }; }
    prune(now) { this.log = this.log.filter((x) => now - x.at < 3600e3); }
    used(now, cls) { this.prune(now); return this.log.filter((x) => !cls || x.cls === cls).reduce((a, x) => a + x.air, 0); }
    pools() { const s = (p) => (p / 100) * 3600; return { routine: s(this.b.routinePct), priority: s(this.b.priorityPct), critical: s(this.b.criticalPct) }; }
    // -> { ok } or { ok: false, waitMs, why }
    check(now, cls, dest, air) {
      this.prune(now);
      const P = this.pools(), u = { routine: this.used(now, 'routine'), priority: this.used(now, 'priority'), critical: this.used(now, 'critical') };
      const freeAt = (need) => {   // when enough of the hour's oldest airtime (in the pools this class may use) ages out
        let got = 0; for (const x of this.log) { got += x.air; if (got >= need) return x.at + 3600e3 - now; } return 3600e3;
      };
      if (cls === 'routine') {
        const gap = this.b.routineGapS * 1e3 - (now - Math.max(this.lastAt.routine, this.lastAt.priority));
        if (gap > 0) return { ok: false, waitMs: gap, why: `routine pacing (1 per ${this.b.routineGapS} s)` };
        const toDest = this.log.filter((x) => x.dest === dest && x.cls === 'routine');
        if (toDest.length >= this.b.perDestHour) return { ok: false, waitMs: toDest[0].at + 3600e3 - now, why: `${this.b.perDestHour} routine sends to this destination this hour` };
        if (u.routine + air > P.routine) return { ok: false, waitMs: freeAt(u.routine + air - P.routine), why: `routine airtime budget (${this.b.routinePct} % of the hour) used` };
        return { ok: true };
      }
      if (cls === 'priority') {
        const gap = this.b.priorityGapS * 1e3 - (now - this.lastAt.priority);
        if (gap > 0) return { ok: false, waitMs: gap, why: `priority pacing (1 per ${this.b.priorityGapS} s)` };
        // priority may use its own pool plus whatever routine left
        if (u.routine + u.priority + air > P.routine + P.priority) return { ok: false, waitMs: freeAt(u.routine + u.priority + air - P.routine - P.priority), why: `priority airtime budget (${this.b.routinePct + this.b.priorityPct} % of the hour) used` };
        return { ok: true };
      }
      // critical: no pacing on the first send (the host spaces repeats), its own reserve plus anything unused above
      const total = P.routine + P.priority + P.critical;
      if (u.routine + u.priority + u.critical + air > total) return { ok: false, waitMs: freeAt(u.routine + u.priority + u.critical + air - total), why: `critical reserve (${this.b.criticalPct} %) used up as well` };
      return { ok: true };
    }
    take(now, cls, dest, air) { this.log.push({ at: now, cls, dest, air }); this.lastAt[cls] = now; }
    snapshot(now) {
      const P = this.pools();
      return { routineS: +this.used(now, 'routine').toFixed(2), priorityS: +this.used(now, 'priority').toFixed(2), criticalS: +this.used(now, 'critical').toFixed(2),
        poolS: { routine: P.routine, priority: P.priority, critical: P.critical }, sends: this.log.length,
        channelPct: +((this.used(now) * (1 + this.b.repeaters)) / 36).toFixed(3) };   // with repeats, % of one channel
    }
  }

  // ------------------------------------------------------------------ the engine
  // host: { now() ms, send(target, text, item) -> Promise<{ ok, delivered?, rtt?, error? }>, audit(rec), toP25?(radioOrCall, text, from) }
  const REF36 = (n) => (n % 1296).toString(36);   // 2 base-36 digits, wraps after 1296 alerts (the tracker keeps 200)
  function Engine(cfgIn, host) {
    let cfg = normalise(cfgIn);
    const lim = new Limiter(cfg.budget, cfg.radio);
    const lims = { meshcore: lim, meshtastic: new Limiter(cfg.budget, MESHTASTIC_RADIO) };   // one per channel; LoRaWAN: lorawan.js
    const limOf = (target) => lims[target.net] || null;
    const queue = [];                 // { id, ref, cls, target, tkey, text, air, at, tries, alert }
    const seen = new Map();           // dedupe key -> at
    const alerts = new Map();         // ref -> tracking record
    let seq = Math.floor((host.now ? host.now() : Date.now()) / 1000) % 1296, sending = false;
    const now = () => (host.now ? host.now() : Date.now());
    const audit = (kind, o) => { try { host.audit && host.audit({ at: now(), kind, ...o }); } catch { /* the host's log failing never stops the bridge */ } };
    const ddKey = (ev, tk) => `${tk}|${ev.source}|${lc(ev.alarm || ev.category || '')}|${ev.unit || ''}|${lc(ascii(ev.text || ev.label || ''))}`;

    function enqueue(item) {
      if (queue.length >= cfg.queueMax) {   // full: drop the lowest class, oldest first -- never a critical for a routine
        let worst = -1;
        for (let i = 0; i < queue.length; i++) if (worst < 0 || RANK[queue[i].cls] < RANK[queue[worst].cls]) worst = i;
        if (worst < 0 || RANK[queue[worst].cls] > RANK[item.cls]) { audit('drop', { ref: item.ref, cls: item.cls, target: targetKey(item.target), why: `queue full (${cfg.queueMax})` }); return false; }
        const [d] = queue.splice(worst, 1); audit('drop', { ref: d.ref, cls: d.cls, target: targetKey(d.target), why: `queue full (${cfg.queueMax}): made room for a ${item.cls} alert` });
      }
      queue.push(item);
      queue.sort((a, b) => RANK[b.cls] - RANK[a.cls] || a.at - b.at);
      return true;
    }

    // An event from P25 (alarm, text, emergency, status) -> { matched, queued: [refs], skipped: [why] }
    function submit(ev) {
      const res = { matched: 0, queued: [], skipped: [] };
      if (!cfg.enabled) { res.skipped.push('bridge off'); return res; }
      const hits = match(ev, cfg); res.matched = hits.length;
      if (!hits.length) return res;
      const t = now();
      for (const [k, at] of seen) if (t - at > cfg.dedupeS * 1e3) seen.delete(k);
      const ref = REF36(seq++);
      const cls0 = hits.reduce((c, h) => (RANK[h.cls] > RANK[c] ? h.cls : c), 'routine');
      const rec = { ref, at: t, ev: { source: ev.source, alarm: ev.alarm, category: ev.category, unit: ev.unit, talkgroup: ev.talkgroup, text: ascii(ev.text || ev.label || '') },
        cls: cls0, targets: {}, p25: (ev.p25 || []).map((p) => ({ radio: p.radio, state: p.state || 'sent' })), humanAck: null, repeats: 0, escalate: hits.some((h) => h.rule.escalate) || cls0 === 'critical', nextEsc: null };
      for (const h of hits) {
        const tk = targetKey(h.target), dk = ddKey(ev, tk);
        if (seen.has(dk)) { res.skipped.push(`${tk}: duplicate inside ${cfg.dedupeS} s`); audit('dedupe', { ref, rule: h.rule.id, target: tk, text: rec.ev.text }); continue; }
        seen.set(dk, t);
        const maxBytes = h.target.net === 'lorawan' ? 51 : cfg.maxText;   // LoRaWAN AU915 DR2: 51 B at the slowest
        const text = encode(ev, { cls: h.cls, ref, at: t, format: h.rule.format, maxBytes, cfg });
        const air = airFor(h.target, byteLen(text), cfg.radio);
        if (enqueue({ id: `${ref}:${tk}`, ref, cls: h.cls, target: h.target, tkey: tk, text, air, at: t, tries: 0, rule: h.rule.id })) {
          rec.targets[tk] = { state: 'queued', cls: h.cls };
          res.queued.push(ref);
          audit('queue', { ref, rule: h.rule.id, cls: h.cls, target: tk, text, air: +air.toFixed(3) });
        }
      }
      if (Object.keys(rec.targets).length) {
        alerts.set(ref, rec);
        if (alerts.size > 200) alerts.delete(alerts.keys().next().value);
        if (rec.escalate) rec.nextEsc = t + (rec.cls === 'critical' ? cfg.budget.criticalRepeatS * 1e3 : cfg.escalation.ackMin * 60e3);
      }
      res.queued = [...new Set(res.queued)];
      return res;
    }

    // A deliberate test from the Tools page (2026-10-21): ONE routine message to ONE target, marked TEST, through
    // the normal queue and airtime budget. Never critical, never escalated, no ack wanted. Works with the bridge off:
    // it tests the path, not the rules. -> { queued, target, text, air } or { error }
    function test(target, opts = {}) {
      if (!target || !NETS.includes(target.net)) return { error: `target.net must be one of ${NETS.join(', ')}` };
      if (!cfg.allowPublic && isPublicCh(target, opts.channels)) return { error: `channel ${target.ch} ${PUBLIC_WHY}` };
      if (target.net === 'meshcore' && !(Number.isInteger(target.ch) && target.ch >= 0 && target.ch <= 7) && !isHex(target.to, 12)) return { error: 'a MeshCore target needs ch 0-7 or to: 12+ hex of the contact key' };
      if (target.net === 'meshtastic' && !target.channel) return { error: 'a Meshtastic target needs a channel (e.g. "P25X")' };
      if (target.net === 'lorawan' && !(isHex(target.dev, 16) && target.dev.length === 16)) return { error: 'a LoRaWAN target needs dev: the 16-hex DevEUI' };
      const t = now(), tk = targetKey(target), d = new Date(t);
      const text = ascii(`TEST P25X mesh alert bridge ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} - no action needed`).slice(0, cfg.maxText);
      const air = airFor(target, byteLen(text), cfg.radio);
      const queued = enqueue({ id: `test:${tk}:${t}`, ref: 'test', cls: 'routine', target, tkey: tk, text, air, at: t, tries: 0, rule: 'test' });
      audit('test', { target: tk, text, air: +air.toFixed(3), queued });
      return { queued, target: tk, text, air: +air.toFixed(3) };
    }

    // Send what the budget allows now. -> ms until the next item could go (0 = nothing waiting)
    async function pump() {
      if (sending) return 1000;
      sending = true;
      try {
        for (;;) {
          if (!queue.length) return 0;
          const t = now();
          let pick = -1, wait = Infinity;
          for (let i = 0; i < queue.length; i++) {
            const q = queue[i], L = limOf(q.target), c = L ? L.check(t, q.cls, q.tkey, q.air) : { ok: true };
            if (c.ok) { pick = i; break; }
            if (c.waitMs < wait) wait = c.waitMs;
            if (q.cls === 'critical') break;   // never let a lower class jump a waiting critical
          }
          if (pick < 0) return Math.max(250, Math.min(wait, 3600e3));
          const q = queue.splice(pick, 1)[0];
          const L = limOf(q.target); if (L) L.take(t, q.cls, q.tkey, q.air);
          const rec = alerts.get(q.ref);
          let r;
          try { r = await host.send(q.target, q.text, q); } catch (e) { r = { ok: false, error: e.message }; }
          const state = !r.ok ? 'failed' : r.delivered ? 'delivered' : r.queued ? 'queued' : 'sent';   // queued: the Kelly bridge holds it until it has the node
          if (rec && rec.targets[q.tkey]) Object.assign(rec.targets[q.tkey], { state, at: now(), rtt: r.rtt || null, error: r.error || null });
          audit('send', { ref: q.ref, cls: q.cls, target: q.tkey, text: q.text, result: state, rtt: r.rtt || null, error: r.error || null, air: +q.air.toFixed(3) });
        }
      } finally { sending = false; }
    }

    // Escalation: alerts nobody has acked -> re-queued (critical every criticalRepeatS, others after ackMin, as
    // priority), up to escalation.maxRepeats times. Call every few seconds.
    function tick() {
      const t = now();
      for (const rec of alerts.values()) {
        if (!rec.escalate || rec.humanAck || rec.nextEsc == null || t < rec.nextEsc) continue;
        if (rec.repeats >= cfg.escalation.maxRepeats) { rec.nextEsc = null; audit('escalate-end', { ref: rec.ref, why: `no ack after ${rec.repeats} repeats` }); continue; }
        rec.repeats++;
        const cls = rec.cls === 'critical' ? 'critical' : 'priority';
        for (const [tk, tg] of Object.entries(rec.targets)) {
          const target = targetFromKey(tk), text = encode({ ...rec.ev, text: `REPEAT ${rec.repeats}: ${rec.ev.text}` }, { cls, ref: rec.ref, at: rec.at, maxBytes: cfg.maxText, cfg });
          const air = airFor(target, byteLen(text), cfg.radio);
          if (enqueue({ id: `${rec.ref}:${tk}:r${rec.repeats}`, ref: rec.ref, cls, target, tkey: tk, text, air, at: t, tries: rec.repeats, rule: 'escalation' })) tg.state = 'queued';
        }
        audit('escalate', { ref: rec.ref, repeat: rec.repeats, cls });
        rec.nextEsc = t + (rec.cls === 'critical' ? cfg.budget.criticalRepeatS * 1e3 : cfg.escalation.ackMin * 60e3);
      }
    }
    const targetFromKey = (k) => { const p = k.split(':'); return p[0] === 'meshcore' ? (p[1] === 'dm' ? { net: 'meshcore', to: p[2] } : { net: 'meshcore', ch: Number(p[2]) }) : p[0] === 'meshtastic' ? { net: 'meshtastic', channel: p[1] } : { net: 'lorawan', dev: p[1] }; };

    // A mesh text the host received: { dm, key (12+ hex, DMs only), name, text, ch }
    // -> { ack: ref } (a human ack, recorded), { forward: { to, text, call } } (reverse: the host sends it to P25),
    //    { refused: why }, or null (nothing for the rules engine)
    function onMesh(m) {
      if (!cfg.enabled) return null;
      const ref = parseAck(m.text);
      if (ref && alerts.has(ref)) {
        const who = allowOf(m), by = ack(ref, who ? who.call : (m.name || (m.key || '').slice(0, 12)), { via: 'mesh', verified: !!who, key: m.key || null });
        return { ack: ref, by };
      }
      if (!cfg.reverse.enabled) return null;
      const fw = /^@([A-Za-z0-9/]{3,12})[:,]?\s+([\s\S]+)$/.exec(String(m.text || '').trim());
      if (!fw) return null;
      if (!m.dm || !m.key) {   // a channel post (or a DM without a key): only a name to go on
        const byName = cfg.reverse.channelByName ? allowOfName(m.name) : null;
        if (!byName) {
          audit('refuse', { from: m.name, why: cfg.reverse.channelByName ? 'channel post: no whitelisted callsign in the sender name' : 'channel message: MeshCore channel posts carry no sender key -- DM the bridge node instead' });
          return { refused: cfg.reverse.channelByName ? 'your node name has no callsign on the bridge whitelist' : 'channel messages carry no sender key: send it as a DM' };
        }
        const text = ascii(`MESH ${byName.call}: ${fw[2]}`).slice(0, 160);
        audit('reverse', { from: byName.call, name: m.name, to: fw[1].toUpperCase(), text, verified: false, how: 'name only, not key-verified (channel post)' });
        return { forward: { to: fw[1].toUpperCase(), text, call: byName.call, verified: false } };
      }
      const who = allowOf(m);
      if (!who) { audit('refuse', { from: m.name, key: m.key.slice(0, 12), why: 'key not on the reverse whitelist' }); return { refused: 'your node key is not on the bridge whitelist' }; }
      const text = ascii(`MESH ${who.call}: ${fw[2]}`).slice(0, 160);
      audit('reverse', { from: who.call, key: m.key.slice(0, 12), to: fw[1].toUpperCase(), text, verified: true, how: 'key (DM)' });
      return { forward: { to: fw[1].toUpperCase(), text, call: who.call, verified: true } };
    }
    // A human ack from anywhere (the mesh, or a P25 radio texting "ACK 3k" to the gateway): stops the escalation.
    // -> who it's recorded as (the first ack stands), or null for an unknown ref
    function ack(ref, by, { via = 'p25', verified = false, key = null } = {}) {
      const rec = alerts.get(String(ref || '').toLowerCase()); if (!rec) return null;
      if (!rec.humanAck) {
        rec.humanAck = { at: now(), by: String(by), via, verified, key };
        queue.splice(0, queue.length, ...queue.filter((q) => !(q.ref === rec.ref && q.rule === 'escalation')));
      }
      audit('ack', { ref: rec.ref, by: String(by), via, verified });
      return rec.humanAck.by;
    }
    // whitelist entries hold 12+ hex digits; a DM gives us the sender's 6-byte prefix (12 hex) -- compare that much
    const allowOf = (m) => { const k = lc(m.key || ''); if (k.length < 12) return null; return cfg.reverse.allow.find((a) => a.key.length >= 12 && (a.key.startsWith(k) || k.startsWith(a.key))) || null; };
    // a channel sender's free-text name holding a whitelisted callsign as a whole word ("VK4XXX", "VK4XXX Home", "VK4XXX-2";
    // not "VK4XXXX"). Weaker than a key: anyone can set that name, which is why it's audited as name only.
    const allowOfName = (name) => { const n = String(name || '').toUpperCase(); return cfg.reverse.allow.find((a) => a.call && new RegExp(`(^|[^A-Z0-9])${a.call}([^A-Z0-9]|$)`).test(n)) || null; };

    function p25Receipt(ref, radio, state) {   // the P25 side of an alert delivered / not
      const rec = alerts.get(ref); if (!rec) return;
      const p = rec.p25.find((x) => String(x.radio) === String(radio)); if (p) p.state = state; else rec.p25.push({ radio, state });
      audit('p25', { ref, radio, state });
    }
    // A target's state changing after send() returned -- LoRaWAN Class A is only on air after the device's next uplink, so
    // lorawan.js reports sent / delivered / unacked / failed / expired later. -> true when the alert and target are known
    function targetState(ref, tkey, state, extra = {}) {
      const rec = alerts.get(ref); if (!rec || !rec.targets[tkey]) return false;
      Object.assign(rec.targets[tkey], { state, at: now(), ...extra });
      audit('state', { ref, target: tkey, state, ...extra });
      return true;
    }
    function meshAck(ref, tkey, rtt) { const rec = alerts.get(ref); if (rec && rec.targets[tkey]) Object.assign(rec.targets[tkey], { state: 'delivered', rtt }); }

    return {
      submit, pump, tick, onMesh, ack, p25Receipt, meshAck, targetState, test, has: (ref) => alerts.has(String(ref || '').toLowerCase()),
      config: () => cfg,
      setConfig(c) { cfg = normalise(c); lim.b = cfg.budget; lim.radio = cfg.radio; lims.meshtastic.b = cfg.budget; },
      status: () => ({ enabled: cfg.enabled, queue: queue.map((q) => ({ ref: q.ref, cls: q.cls, target: q.tkey, text: q.text, at: q.at, air: +q.air.toFixed(3) })),
        airtime: lim.snapshot(now()), airtimeMeshtastic: lims.meshtastic.snapshot(now()),
        alerts: [...alerts.values()].slice(-50).reverse().map((r) => ({ ref: r.ref, at: r.at, cls: r.cls, text: r.ev.text, targets: r.targets, p25: r.p25, humanAck: r.humanAck, repeats: r.repeats, escalating: r.nextEsc != null && !r.humanAck })) }),
      // dry run for the Tools page: what WOULD happen, nothing queued
      preview(ev) {
        const t = now();
        return match(ev, { ...cfg, rules: cfg.rules }).map((h) => {
          const text = encode(ev, { cls: h.cls, ref: '??', at: t, format: h.rule.format, maxBytes: h.target.net === 'lorawan' ? 51 : cfg.maxText, cfg });
          const air = airFor(h.target, byteLen(text), cfg.radio);
          return { rule: h.rule.id, cls: h.cls, target: targetKey(h.target), text, bytes: byteLen(text), airS: +air.toFixed(3), budget: limOf(h.target) ? limOf(h.target).check(t, h.cls, targetKey(h.target), air) : { ok: true, why: 'LoRaWAN: capped per device by lorawan.js' } };
        });
      },
      _limiter: lim, _queue: queue, _alerts: alerts,
    };
  }

  return { VERSION, CLASSES, SOURCES, NETS, CODES, DEFAULTS, normalise, validate, isPublicCh, match, ruleMatches, targetKey, encode, decode, parseAck, ascii,
    timeOnAir, meshcoreAirBytes, airFor, MESHTASTIC_RADIO, LORAWAN_RADIO, Limiter, Engine };
});
