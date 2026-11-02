/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts: the shared contract (2026-10-24, unreleased). Pure UMD (browser + Node).
 * THIS HEADER IS THE SPEC. Phase 2 parts code against it and never change it; ask the integrator instead
 * (kelly-page/HAM_CONTACTS_PLAN.md). The same file is copied byte-identical to the gateway as
 * gateway/hc-core.js (the directory's checks; its test compares the two).
 *
 * Why the tab exists: MeshCore DMs, pings, path discovery and the ACKs / path returns that make traces useful are all
 * encrypted with a secret BOTH ends derive from each other's public key, and a packet carries only a 1-2 byte hash of
 * the sender. A node that hasn't got the sender as a contact can't even tell who it is from -- so nothing works until
 * each side has the other in its contacts. Getting each other's advert (or contact card) onto both radios fixes that.
 *
 * ---- ContactRecord (HC.record(x) builds one; frozen; every field present, null when unknown)
 *   key        64 lowercase hex: the node's Ed25519 public key (= MeshCore's identity). Never a private key.
 *   id         = key
 *   short      the first 8 hex digits, for display ("a1b2c3d4")
 *   name       its advert name (<= 31 bytes)
 *   call       amateur callsign (upper case) or null -- KellyHamCalls' answer, else one in the name
 *   callSrc    'mine' (this user set it) | 'dir' (self-signed directory entry) | 'name' (in the advert name) | null
 *   label      what to show: HC.label(name, call) -- "VK4XYZ · Bob's node" when the name hasn't the call, else the name
 *   type       1 companion | 2 repeater | 3 room | 4 sensor (0 = unknown);  typeName, icon
 *   onRadio    true = in the node's contacts;  pending = heard (an advert, or seen in Kelly) but NOT on the radio
 *   fav        the node's favourite flag (a favourite is never overwritten when the table is full)
 *   letsDiscover  contact flag 0x02: we let THEM read our base telemetry -- the only way a companion answers their path
 *              discovery (with state().telemetryBase 1; base 2 = everyone may, 0 = nobody, the firmware default)
 *   lastHeard  ms (Kelly heard any packet from it) | null;  lastAdvert  ms (its own clock in its last advert) | null
 *   hops       0 = direct; N = hops on the route the node has learned TO it; null = no route yet (the next DM floods)
 *   outPath    { sz: 1|2|3, h: [hex] } | null -- the node's learned route
 *   snr, rssi  dB / dBm the last time Kelly heard it direct, else null
 *   lat, lon, km   its advert position and distance from us, or null
 *   num        mesh.js node number (key-derived), for its chat / node panel
 *   src        where a pending record came from: 'advert' (the node passed on an advert it didn't keep) | 'seen'
 *              (Kelly knows it from earlier) | 'card' | 'dir' | null
 *
 * ---- Result (every service call resolves -- it never rejects, never throws)
 *   { ok: true, value?, msg }                          msg = one plain-English sentence for a toast / status line
 *   { ok: false, code, error }                         code = HC.ERR key, error = one plain-English sentence
 *
 * ---- Contact card: the STANDARD MeshCore forms only (2026-10-24: no custom format), so cards go both ways with the
 *   official MeshCore phone app and other firmwares. Both come from the node's own CMD_EXPORT_CONTACT (signed advert).
 *   1. meshcore://<hex of the node's SIGNED advert>   what the official app's "share contact" copies and IMPORT_CONTACT
 *      takes. Signed by the node's own key, so nobody can forge or alter it. This is the copy / paste / file form.
 *   2. meshcore://contact/add?name=&public_key=&type=  the official app's QR code (docs.meshcore.io/qr_codes), built by
 *      HC.qrLink from the signed advert's key / name / type (= js/meshqr.js contactLink). Read back it is NOT signed:
 *      accepted, verified: false (the UI says "check this key with its owner"), added with ADD_UPDATE_CONTACT.
 *   parseCard finds and reads the link with js/meshqr.js (KellyMeshQR.parse: the one link grammar, looked up only when
 *   called -- the gateway copy never calls it), inside surrounding text too; a signed advert wins over a contact/add in
 *   the same text. CardInfo also has warnings [{code, msg}] and more [other links found].
 *   -> CardInfo { kind: 'advert'|'contact', key, type, name, call (from the name) | null, callFrom: 'name'|null, lat, lon,
 *                 ts (unix s) | null, verified (signature checked good), advert (hex) | null, link (its meshcore:// form),
 *                 qr (the contact/add form) }
 *   A card that is malformed, oversized (> 4 kB of text, advert > 175 bytes), has a bad key (not 64 hex, all zero),
 *   a bad type, an unprintable name, a timestamp > 1 day ahead, or a signature that doesn't verify THROWS an Error whose
 *   message is the sentence to show. Without an Ed25519 verifier (no TweetNaCl) a signed card throws too: never assume.
 *
 * ---- Directory entry (the shared "P25X ham directory"; self-signed by the node itself -- no admin, no private key leaves it)
 *   { k: key 64 hex, c: CALL, n: name (<= 31), t: type 1..4, at: unix s, x: 0 | 1 (1 = withdrawn by its owner), s: sig b64u }
 *   s = Ed25519 signature BY THE NODE (session.sign: the companion's SIGN_START/DATA/FINISH) over HC.dirBytes(entry) =
 *   UTF-8 of "P25X-HDIR1|k|c|n|t|at|x". Only a key's own node can publish or withdraw its entry; a newer `at` wins.
 *   HC.verifyEntry(e, ed) -> { ok, entry | error }. ed = HC.naclEd(nacl) | HC.nodeEd(require('crypto')) (= igate-wl.js).
 *   On the air (KF ops, appended to kfiles.js OPS / server.js KF_OPS): {op: 'hdir', have: v} -> kind 4 {app: 'hdir', v,
 *   cur: 1} or {app: 'hdir', v, e: [entry..]} (whole list, <= HC.DIR_MAX); {op: 'hdirput', e: entry} -> {app: 'hdir',
 *   put: 1, ok, v, error?}; pushed {app: 'hdir', notify: 1, v} when it changes.
 *
 * ---- Service (window.KellyHamContactsService(k) in js/hc-service.js; the demo backend js/hc-demo.js has the same shape)
 *   svc.state() -> { link: { online, via: 'live'|'sim-link'|'demo'|'none', why }, maxContacts (number | null), count,
 *                    autoAdd: { known, all, types: { companion, repeater, room, sensor }, overwrite, maxHops } | null,
 *                    me: { key, name, call } | null, busy: [op names running], busyKeys: { lock key: op name },
 *                    telemetryBase: 0 deny | 1 per-contact flag | 2 anyone | null (who may run a path discovery to us) }
 *   svc.contacts() -> [ContactRecord] on the radio;  svc.heard() -> [ContactRecord] pending;  svc.get(key) -> record | null
 *   svc.refresh()                 re-read every contact + the auto-add settings from the node
 *   svc.add(input)                input = card text | CardInfo | { key, type, name } | a pending record's key. Validates,
 *                                 refuses a full table (code 'full'), skips one already there (ok, value.already)
 *                                 An import some firmwares keep only as a heard advert is written with ADD_UPDATE_CONTACT;
 *                                 if it still isn't saved it lands in heard() and the Result says so (code 'refused')
 *   svc.remove(key)               some firmwares restart the radio on a remove (flash rewrite): the link drop / silence is
 *                                 caught, Kelly reconnects, then checks the contact is gone (up to 90 s; Result says so)
 *   svc.share(key)                CMD_SHARE_CONTACT: that contact's advert re-sent ZERO-HOP so hams near you can add them
 *                                 ("introduce"); rate-limited like adverts (HC.LIMITS.share), svc.shareWait()
 *   svc.resetPath(key) / svc.setFav(key, on)
 *   svc.allowDiscover(key, on)    flag 0x02 on that contact; turning one ON also sets our base mode to 1 when it is 0
 *                                 (never lowers 2). svc.setTelemetryBase(mode 0|1|2)
 *   svc.advert('local'|'flood')   rate-limited (HC.LIMITS): refused with code 'rate' and the wait in plain English
 *   svc.advertWait(mode) -> ms until allowed (0 = now)
 *   svc.setAutoAdd({ all?, types?: {companion..}, overwrite?, maxHops? })   types MERGE into the current ones
 *                                 (give all four to set them exactly); per-type bits only act while `all` is off;
 *                                 maxHops 0 = any distance, 1 = direct only, N = up to N-1 hops, max 64 (NodePrefs.h)
 *   svc.myCard() -> Result value = { advert hex, link (form 1), qr (form 2), key, name, type, call }
 *   svc.signEntry(entryWithoutS) -> Result value = the entry with s (the NODE signs; only our own key: refused otherwise)
 *   svc.room(n) -> { ok, free, fit, warn } -- can n more fit? fit = how many of them do; warn = a sentence when it
 *                                 won't fit or would pass 90 % of the table
 *   svc.forgetHeard(key)          dismiss a heard station (a 'seen' one stays hidden until Kelly hears it again)
 *   Every call: one at a time per key, an outer timeout (HC.TIMEOUT_MS), and a disconnect settles it at once ('offline').
 *
 * ---- Bus (c.bus = HC.createBus(); on(ev, fn) -> off; emit(ev, payload)). Handlers never throw out (caught + logged).
 *   'contacts'  (list)            the on-radio list changed            'heard'   (list)  the pending list changed
 *   'state'     (svc.state())     link / table size / auto-add changed 'op' { op, key, phase: 'start'|'done', result? }
 *   'advert'    { mode, at }      we advertised                        'select' { key, from }  a station was picked
 *   'calls'     ()                a callsign mapping changed (KellyHamCalls)
 *   'dir'       ()                the directory changed (js/hc-dir.js) 'visible' (bool)  the tab shown / hidden
 *   'demo'      (bool)                                        
 *
 * ---- window.KellyHamCalls (js/hc-calls.js; the hook Packet Journey / Trace Route / the chat read -- may be missing)
 *   A singleton made when the script loads (so it exists before mesh.js draws anything); the shell calls
 *   init({ store, bus }) once. Precedence: 'mine' (this user's edit) > 'dir' (a self-signed directory entry) > 'name'.
 *   label(key, name) -> string (= HC.label(name, call); name alone when no call is known -- never throws, cheap: the
 *     chat and Packet Journey call it per row). key may be null (a channel sender known only by its name): match the
 *     name against known mappings' names then, shown UNCONFIRMED ("VK4XYZ? · Bob": anyone can take a name).
 *     callOf(key, name) -> { call, src } | null
 *   set(key, call, name?) / clear(key)  (this user's own mappings; stored, capped at 500)
 *   all() -> [{ key, call, src, name }]      fromDir(entries) (verified entries only -- js/hc-dir.js calls it)
 *   onChange(fn) -> off  (the shell re-emits 'calls' on the bus; mesh.js redraws the chat on it)
 *   fromDir(entries, { replace: true }) swaps the whole directory layer (a full list); merge is the default.
 *   It follows bus 'demo': mappings made while the demo is on stay in memory only and go when it stops.
 *   hamOf(x) -> HamStatus (below) for a mesh.js node / APRS station / { radio }: collects the evidence, memoised.
 *     hooks({ me, radioCall, infraKeys, demo, otherCalls, clubCalls, aliases }) gives it Kelly's side (functions);
 *     bump() drops the memo. Without hc-core.js every station is { ham: false, tier: 'none' }: nothing scores.
 *   qrClaim(key, name)  after adding a contact from an unsigned contact/add QR: that name is a claim (ev.nameFrom 'qr')
 *     and never takes a call first, until advertSeen(key) -- the node passed on that key's own (signed) advert.
 *
 * ---- Ham status (awards review 2026-10-24, kelly-page/AWARDS_REVIEW.md section 3): who counts as a licensed ham
 *   HC.hamStatus(ev, ctx) -> frozen { ham, tier, call, owner, cls, self, src, why, demo }   never throws
 *     ham    cls 'station' and tier verified | probable
 *     tier   'verified' (a gateway-served signed directory entry; a P25 radio whose call the gateway knows)
 *            'probable' (this user's 'mine' mapping; a VK/ZL/AX call in a KEYED advert name; Meshtastic isLicensed + a
 *                        call; a LoRa APRS RF source)   'unverified' (a keyless channel name; a non-VK/ZL/AX call from a
 *                        name; a renamed key; an unknown P25 ID)   'none' (no call)
 *     call   base call (normCall) or null;  owner  the grouping id = call, or ctx.otherCalls[call] (a second licence)
 *     cls    'station' | 'infra' (MeshCore type 2/3/4, Meshtastic roles 2/3/4/6/11, APRS # / & symbols, repeater /
 *            club-format calls VKnR?? + CLUB_CALLS + ctx.clubCalls, 0000001) | 'gateway' (5059999, bots, ctx.infraKeys,
 *            viaInternet) | 'unknown' (keyless, MeshCore type 0 with no directory type)
 *     self   one of mine: key in me.keys, radio base in me.radios, or any call it carries (dir / mine / name) = me.call
 *     src    'dir' | 'p25' | 'mine' | 'name' | 'meshtastic' | 'aprs' | null;  why  one sentence;  demo  ev.demo || ctx.demo
 *   ev  { net: 'meshcore'|'meshtastic'|'aprs'|'p25', key, name, keyless, type, role, licensed, aprsCall, aprsSym, radio,
 *         radioCall, mine, dir: { c, t } | null, viaInternet, demo,
 *         firstCall (the call this key FIRST had in its name), firstKey (the key that FIRST used this name call),
 *         nameFrom: 'qr' (the name came only from an unsigned contact/add QR, no advert from that key since: a name
 *         call is then 'unverified' -- QR_REVIEW.md S2; the owner approved the spec change 2026-10-24) }
 *       The type in the node's own advert and dir.t: the more restrictive (infra) wins; dir.t 1 lifts only type 0.
 *       Scoring precedence dir > p25 > mine > name (display stays mine > dir > name: KellyHamCalls.callOf).
 *   ctx { me: { call, callVerified, keys: [hex], radios: [base ids] }, infraKeys: Set|[], otherCalls: { CALL: OWNER },
 *         clubCalls: [CALL], aliases: { aliasId: baseId }, demo }
 *   HC.countsFor(r, 'visual'|'local'|'club', { demoProfile }) -> bool   visual always; local = ham, not self, verified |
 *     probable, not demo unless demoProfile; club = ham, not self, verified, never demo, never src aprs / meshtastic
 *   HC.hamOwners(results, cls, opts) -> Set of owners that count (self and duplicates dropped)
 *   HC.radioBase(id, aliases) -> the 505 base of a P25 ID ('1050002' -> '5050002'; only [1-46-9]05xxxx + the table)
 *   HC.NOT_HAM = the frozen "nothing known" result (the fallback when this file is missing)
 *
 * window.KellyHC = { ... below }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyHC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPES = { 0: 'node', 1: 'companion', 2: 'repeater', 3: 'room', 4: 'sensor' };
  const TYPE_NAME = { 0: 'Node', 1: 'Companion', 2: 'Repeater', 3: 'Room server', 4: 'Sensor' };
  const TYPE_ICON = { 0: '❔', 1: '📱', 2: '📡', 3: '🏛️', 4: '🌡️' };
  const TYPE_BIT = { companion: 0x02, repeater: 0x04, room: 0x08, sensor: 0x10 }, OVERWRITE_BIT = 0x01;   // GET/SET_AUTOADD_CONFIG
  const ERR = { offline: 'offline', timeout: 'timeout', refused: 'refused', invalid: 'invalid', full: 'full', rate: 'rate', busy: 'busy', error: 'error' };
  // airtime: a zero-hop advert reaches only the stations in range; a flood is repeated by every repeater in the region
  const LIMITS = {
    local: { gapMs: 60000, perHour: 20 },               // one a minute
    flood: { gapMs: 15 * 60000, perDay: 6 },            // one per 15 min, six a day
    share: { gapMs: 30000, perHour: 20 },               // introduce a contact (zero-hop): one per 30 s
    demo: { local: { gapMs: 10000, perHour: 60 }, flood: { gapMs: 30000, perDay: 50 }, share: { gapMs: 5000, perHour: 120 } },
  };
  const TIMEOUT_MS = 20000, WARN_FRACTION = 0.9, DIR_MAX = 500, CARD_MAX_TEXT = 4096, ADVERT_MAX = 175, PACKET_MAX = 300;

  // ---------------------------------------------------------------- bytes
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = h => { const s = String(h || ''); const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
  const utf8 = s => new TextEncoder().encode(s);
  const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  const i32 = (b, o) => b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64u(b) {
    let s = '';
    for (let i = 0; i < b.length; i += 3) {
      const n = b[i] << 16 | (b[i + 1] || 0) << 8 | (b[i + 2] || 0);
      s += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < b.length ? B64[n >> 6 & 63] : '') + (i + 2 < b.length ? B64[n & 63] : '');
    }
    return s;
  }
  function unb64u(s) {
    const o = []; let n = 0, bits = 0;
    for (const ch of String(s || '')) { const v = B64.indexOf(ch); if (v < 0) return null; n = n << 6 | v; bits += 6; if (bits >= 8) { bits -= 8; o.push(n >> bits & 255); } }
    return Uint8Array.from(o);
  }
  const HEX64 = /^[0-9a-f]{64}$/;
  const okKey = k => HEX64.test(k) && !/^0+$/.test(k);

  // ---------------------------------------------------------------- callsigns
  const CALL_IN = /\b((?:[A-Z]{1,2}|\d[A-Z])\d[A-Z]{1,4})\b/i;   // = mesh.js callOf / CALLSIGN_RE2
  const BASE_RE = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/;              // = igate-wl.js
  // 'vk4xxx' / ' VK4XXX-7 ' -> 'VK4XXX'; anything else -> null
  function normCall(c) { const t = String(c || '').trim().toUpperCase().replace(/[-/].*$/, ''); return t.length <= 7 && BASE_RE.test(t) ? t : null; }
  // the callsign in a node name ('VK4XXX Tracker' -> 'VK4XXX'), or null. Lower-case calls count only for VK/ZL/AX.
  function callFromName(name) {
    const s = String(name || ''), m = CALL_IN.exec(s); if (!m) return null;
    const c = m[1].toUpperCase();
    if (m[1] !== c && !/^(VK|ZL|AX)/.test(c)) return null;
    return normCall(c);
  }
  // display label: the name alone if it already holds the call, else "CALL · name"
  function label(name, call) {
    const n = String(name || '').trim(), c = normCall(call);
    if (!c) return n || '?';
    if (!n) return c;
    return new RegExp(`\\b${c}\\b`, 'i').test(n) ? n : `${c} · ${n}`;
  }

  // ---------------------------------------------------------------- records + results
  const num = x => (typeof x === 'number' && isFinite(x) ? x : null);
  function record(x) {
    x = x || {};
    const key = String(x.key || '').toLowerCase(), type = [0, 1, 2, 3, 4].includes(x.type) ? x.type : 0;
    const call = normCall(x.call) || null, name = String(x.name || '').slice(0, 64);
    const outPath = x.outPath && Array.isArray(x.outPath.h) ? { sz: x.outPath.sz || 1, h: x.outPath.h.slice() } : null;
    return Object.freeze({
      key, id: key, short: key.slice(0, 8), name, call, callSrc: call ? (x.callSrc || 'name') : null, label: label(name || key.slice(0, 8), call),
      type, typeName: TYPE_NAME[type], icon: TYPE_ICON[type], onRadio: !!x.onRadio, pending: !x.onRadio && !!x.pending, fav: !!x.fav, letsDiscover: !!x.letsDiscover,
      lastHeard: num(x.lastHeard), lastAdvert: num(x.lastAdvert), hops: num(x.hops) != null && x.hops >= 0 && x.hops < 64 ? x.hops : (outPath ? outPath.h.length : null),
      outPath, snr: num(x.snr), rssi: num(x.rssi), lat: num(x.lat), lon: num(x.lon), km: num(x.km), num: num(x.num), src: x.src || null,
    });
  }
  const ok = (value, msg) => ({ ok: true, value, msg: msg || 'Done.' });
  const fail = (code, error) => ({ ok: false, code: ERR[code] || 'error', error: error || 'Something went wrong.' });

  // ---------------------------------------------------------------- bus
  function createBus(log) {
    const subs = new Map();
    return {
      on(ev, fn) { if (!subs.has(ev)) subs.set(ev, new Set()); subs.get(ev).add(fn); return () => subs.get(ev) && subs.get(ev).delete(fn); },
      emit(ev, payload) { const s = subs.get(ev); if (!s) return; for (const fn of [...s]) { try { fn(payload); } catch (e) { (log || (typeof console !== 'undefined' ? console.warn : () => {}))('Ham Contacts', ev, e); } } },
      clear() { subs.clear(); },
    };
  }

  // ---------------------------------------------------------------- Ed25519 adapters (= igate-wl.js; verify(sig, msg, key))
  function naclEd(nacl) {
    return { verify: (sig, msg, k) => nacl.sign.detached.verify(Uint8Array.from(msg), Uint8Array.from(sig), Uint8Array.from(k)),
      signer(seed) { const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(seed)); return { sign: m => nacl.sign.detached(Uint8Array.from(m), kp.secretKey), publicKey: kp.publicKey }; } };
  }
  function nodeEd(crypto) {
    const SPKI = Buffer.from('302a300506032b6570032100', 'hex'), PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
    const pub = k => crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(k)]), format: 'der', type: 'spki' });
    return { verify: (sig, msg, k) => crypto.verify(null, Buffer.from(msg), pub(k), Buffer.from(sig)),
      signer(seed) {
        const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
        const raw = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
        return { sign: m => new Uint8Array(crypto.sign(null, Buffer.from(m), key)), publicKey: new Uint8Array(raw) };
      } };
  }

  // ---------------------------------------------------------------- adverts (MeshCore Packet::writeTo, advert payload)
  // packet bytes -> { key, ts, type, name, lat, lon, sigOk } or throws. Layout: header [route 2 bits | type 4 bits << 2],
  // transport codes (4 bytes, routes 0 / 3), path_len (top 2 bits = hash size - 1), path, then the advert:
  // key 32 | timestamp u32 | signature 64 | flags (type low 4, 0x10 lat/lon, 0x20 / 0x40 2 bytes each, 0x80 name) | ...
  // signed = key + timestamp + everything after the signature.
  function parseAdvert(b, ed) {
    if (!b || b.length < 2) throw new Error('that card is empty');
    if (b.length > PACKET_MAX) throw new Error('that card is too big to be a MeshCore contact');
    const route = b[0] & 3, type = (b[0] >> 2) & 15;
    if (type !== 4) throw new Error('that link is a MeshCore packet, but not a contact advert');
    let o = 1 + (route === 0 || route === 3 ? 4 : 0);
    if (o >= b.length) throw new Error('that card is cut short');
    const pl = b[o++], n = pl & 63, sz = (pl >> 6) + 1;
    if (sz > 3) throw new Error('that card has a broken path field');
    o += n * sz;
    const p = b.subarray(o);
    if (p.length < 101) throw new Error('that card is cut short');
    const key = hex(p.subarray(0, 32)), ts = u32(p, 32), flags = p[100];
    if (!okKey(key)) throw new Error('that card has no proper public key');
    // the firmware cuts app_data to 32 bytes (MAX_ADVERT_DATA_SIZE) BEFORE it checks the signature (Mesh.cpp), so a
    // longer one can never import on a node: no real node sends one
    if (p.length - 100 > 32) throw new Error('that card is not a real MeshCore advert (its data is longer than a node sends)');
    // the path a forwarded advert carries isn't signed: the card is re-made without it (flood, no path), so a contact
    // exported after a long path still fits the node's IMPORT_CONTACT (<= ADVERT_MAX bytes)
    const bare = new Uint8Array(2 + p.length); bare[0] = (b[0] & ~3) | 1; bare[1] = 0; bare.set(p, 2);
    if (bare.length > ADVERT_MAX) throw new Error('that card is too big to be a MeshCore contact');
    const r = { key, ts, type: flags & 15, name: '', lat: null, lon: null, sigOk: false, bare: hex(bare) };
    let i = 101;
    if (flags & 0x10) { if (p.length < i + 8) throw new Error('that card is cut short'); const la = i32(p, i), lo = i32(p, i + 4); i += 8; if (la || lo) { r.lat = la / 1e6; r.lon = lo / 1e6; } }
    if (flags & 0x20) i += 2;
    if (flags & 0x40) i += 2;
    if (flags & 0x80 && p.length > i) r.name = new TextDecoder('utf-8', { fatal: false }).decode(p.subarray(i)).replace(/\0.*$/s, '');
    if (!ed) throw new Error('this browser cannot check card signatures (TweetNaCl did not load) -- reload Kelly');
    const msg = new Uint8Array(p.length - 64); msg.set(p.subarray(0, 36)); msg.set(p.subarray(100), 36);
    try { r.sigOk = !!ed.verify(p.subarray(36, 100), msg, p.subarray(0, 32)); } catch { r.sigOk = false; }
    if (!r.sigOk) throw new Error('that card\'s signature does not check out -- it was changed, or it is not a real MeshCore contact');
    return r;
  }

  // ---------------------------------------------------------------- cards
  const okName = s => typeof s === 'string' && utf8(s).length <= 31 && !/[\x00-\x1f\x7f]/.test(s);
  function checkCommon(c, nowS) {
    if (![1, 2, 3, 4].includes(c.type)) throw new Error('that card has an unknown node type');
    if (!okName(c.name)) throw new Error('that card\'s name is too long or holds control characters');
    if (c.ts != null && c.ts > nowS + 86400) throw new Error('that card is dated in the future -- the sender\'s node clock is wrong');
    return c;
  }
  // js/meshqr.js (the link grammar), looked up only when a card is read or built -- never at load time: the gateway
  // loads this file without it and never calls qrLink / parseCard
  function QRL() {
    const g = typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.KellyMeshQR) return g.KellyMeshQR;
    if (typeof require === 'function') { try { return require('./meshqr.js'); } catch { /* not beside this file */ } }
    throw new Error('the QR link reader (js/meshqr.js) did not load -- reload Kelly');
  }
  // the official app's QR form for a contact (= KellyMeshQR.contactLink)
  const qrLink = c => QRL().contactLink(c);
  // text -> CardInfo (throws a plain-English Error). opts: { ed (HC.naclEd(nacl)), now ms }. Finding and reading the
  // link is KellyMeshQR.parse (a signed advert wins over an unsigned contact/add in the same text); the signature check
  // and the card rules are here. CardInfo.warnings / more = the reader's (a shortened name, other cards in the text).
  function parseCard(text, opts = {}) {
    if (String(text == null ? '' : text).length > CARD_MAX_TEXT) throw new Error('that is far too long to be a contact card');
    const nowS = Math.floor((opts.now || Date.now()) / 1000);
    const p = QRL().parse(text, { accept: ['contact', 'advert'] });
    const done = c => { c.call = callFromName(c.name); c.callFrom = c.call ? 'name' : null; c.qr = qrLink(c); c.warnings = p.warnings || []; c.more = p.more || []; return c; };
    // form 2: the official app's QR (not signed)
    if (p.kind === 'contact') return done(checkCommon({ kind: 'contact', key: p.key, type: p.type, name: p.name, lat: null, lon: null, ts: null, verified: false, advert: null, link: p.link }, nowS));
    // form 1: the signed advert
    const a = parseAdvert(unhex(p.hex), opts.ed), h = a.bare;
    return done(checkCommon({ kind: 'advert', key: a.key, type: a.type, name: a.name, lat: a.lat, lon: a.lon, ts: a.ts, verified: true, advert: h, link: `meshcore://${h}` }, nowS));
  }

  // ---------------------------------------------------------------- directory entries
  function normEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const k = String(e.k || '').toLowerCase(), c = normCall(e.c), n = String(e.n == null ? '' : e.n), t = Number(e.t), at = Number(e.at), x = e.x ? 1 : 0;
    if (!okKey(k) || !c || !okName(n) || ![1, 2, 3, 4].includes(t) || !Number.isInteger(at) || at < 1.6e9 || at > 4.2e9) return null;
    const out = { k, c, n, t, at, x };
    if (e.s != null) out.s = String(e.s);
    return out;
  }
  const dirBytes = e => utf8(`P25X-HDIR1|${e.k}|${e.c}|${e.n}|${e.t}|${e.at}|${e.x ? 1 : 0}`);
  // -> { ok: true, entry } | { ok: false, error }. opts.now ms: an entry dated > 1 day ahead is refused
  function verifyEntry(e, ed, opts = {}) {
    const n = normEntry(e);
    if (!n) return { ok: false, error: 'malformed directory entry' };
    if (n.at > Math.floor((opts.now || Date.now()) / 1000) + 86400) return { ok: false, error: 'directory entry dated in the future' };
    const sig = unb64u(n.s);
    if (!sig || sig.length !== 64) return { ok: false, error: 'directory entry has no signature' };
    if (!ed) return { ok: false, error: 'no signature checker' };
    let good = false; try { good = !!ed.verify(sig, dirBytes(n), unhex(n.k)); } catch { good = false; }
    return good ? { ok: true, entry: n } : { ok: false, error: 'directory entry signature does not check out' };
  }

  // ---------------------------------------------------------------- auto-add bits <-> settings
  function autoAddOf(a) {   // the driver's { all, bits, maxHops } -> state().autoAdd
    if (!a || a.all == null) return null;
    const b = a.bits;
    return { known: true, all: !!a.all, types: { companion: b != null ? !!(b & TYPE_BIT.companion) : null, repeater: b != null ? !!(b & TYPE_BIT.repeater) : null,
      room: b != null ? !!(b & TYPE_BIT.room) : null, sensor: b != null ? !!(b & TYPE_BIT.sensor) : null },
      overwrite: b != null ? !!(b & OVERWRITE_BIT) : null, maxHops: a.maxHops != null ? a.maxHops : null, bitsKnown: b != null };
  }
  function bitsOf(types, overwrite) {
    let b = overwrite ? OVERWRITE_BIT : 0;
    for (const t of Object.keys(TYPE_BIT)) if (types && types[t]) b |= TYPE_BIT[t];
    return b;
  }

  // ---------------------------------------------------------------- ham status (awards)
  // model / board names that fit the callsign pattern
  const NOT_CALLS = ['UV5R', 'UV9R', 'UV82', 'UV5RA', 'GT3RS', 'T1KE'];
  const CLUB_CALLS = ['VK4RBX'];                                   // club / site calls: infrastructure, never a person
  const RPT_CALL = /^VK\dR[A-Z]{2}$/;                              // repeater / beacon format (ACMA rule still to check)
  const INFRA_ROLES = [2, 3, 4, 6, 11];                            // Meshtastic ROUTER, ROUTER_CLIENT, REPEATER, SENSOR, ROUTER_LATE
  const BOT_NAME = /\b(bot|alert|alerts|bbs)\b/i;                  // = mesh.js
  const GATEWAY_ID = '5059999', TEST_ID = '0000001';
  const NOT_HAM = Object.freeze({ ham: false, tier: 'none', call: null, owner: null, cls: 'unknown', self: false, src: null, why: 'nothing known about this station', demo: false });
  const local = c => /^(VK|ZL|AX)/.test(c);
  function radioBase(id, aliases) {
    if (id == null || id === '') return null;
    const s = String(id).replace(/\D/g, '').padStart(7, '0');
    if (aliases && aliases[s]) return String(aliases[s]).padStart(7, '0');
    return /^[1-46-9]05\d{4}$/.test(s) ? `5${s.slice(1)}` : s;
  }
  function hamStatus(ev, ctx) {
    try { return hamStatus0(ev || {}, ctx || {}); } catch { return NOT_HAM; }
  }
  function hamStatus0(ev, ctx) {
    const me = ctx.me || {}, myCall = normCall(me.call), demo = !!(ev.demo || ctx.demo);
    const net = ev.net || (ev.radio != null && ev.radio !== '' ? 'p25' : ev.aprsCall ? 'aprs' : 'meshcore');
    const key = String(ev.key || '').toLowerCase(), keyless = !!ev.keyless || (net === 'meshcore' && !key);
    const has = (x, v) => !!x && (x instanceof Set ? x.has(v) : Array.isArray(x) && x.includes(v));
    const clubs = CLUB_CALLS.concat((ctx.clubCalls || []).map(normCall).filter(Boolean));
    const ownerOf = c => (c && ctx.otherCalls && normCall(ctx.otherCalls[c])) || c;
    const base = net === 'p25' ? radioBase(ev.radio, ctx.aliases) : null;
    const dir = ev.dir && normCall(ev.dir.c) ? { c: normCall(ev.dir.c), t: Number(ev.dir.t) || 0 } : null;
    const mineC = normCall(ev.mine), nameC0 = callFromName(ev.name), nameC = nameC0 && !NOT_CALLS.includes(nameC0) ? nameC0 : null;
    // every call this station carries: any of them being mine makes it mine (strict on purpose: it only stops scoring)
    const carried = [dir && dir.c, mineC, nameC, net === 'p25' ? normCall(ev.radioCall) : null, net === 'aprs' ? normCall(ev.aprsCall) : null].filter(Boolean);
    let self = (!!key && (me.keys || []).map(x => String(x).toLowerCase()).includes(key)) || (!!base && (me.radios || []).map(x => radioBase(x, ctx.aliases)).includes(base))
      || (!!myCall && carried.some(c => ownerOf(c) === ownerOf(myCall)));

    // ---- class
    let cls = 'station', clsWhy = '';
    if (base === GATEWAY_ID) { cls = 'gateway'; clsWhy = 'the P25X gateway'; }
    else if (base === TEST_ID) { cls = 'infra'; clsWhy = 'the test call ID'; }
    else if ((key && has(ctx.infraKeys, key)) || ev.viaInternet || BOT_NAME.test(String(ev.name || ''))) { cls = 'gateway'; clsWhy = ev.viaInternet ? 'heard over the internet, not RF' : 'a bot or the club\'s own gateway node'; }
    else if (net === 'meshcore') {
      const t = Number(ev.type) || 0, dt = dir ? dir.t : 0;
      if ([2, 3, 4].includes(t) || [2, 3, 4].includes(dt)) { cls = 'infra'; clsWhy = `a ${TYPE_NAME[[2, 3, 4].includes(t) ? t : dt].toLowerCase()}, not a person's own station`; }
      else if (keyless) { cls = 'unknown'; clsWhy = 'known only by a channel name'; }
      else if (t === 1 || dt === 1) cls = 'station';
      else { cls = 'unknown'; clsWhy = 'node type not known yet'; }
    } else if (net === 'meshtastic') { if (INFRA_ROLES.includes(Number(ev.role))) { cls = 'infra'; clsWhy = 'a Meshtastic router / repeater / sensor'; } }
    else if (net === 'aprs') { const sy = String(ev.aprsSym || ''); if (/[#&]$/.test(sy)) { cls = 'infra'; clsWhy = 'an APRS digipeater or iGate'; } }

    // ---- call + tier
    let call = null, tier = 'none', src = null, why = '';
    if (net === 'p25') {
      const c = normCall(ev.radioCall);
      if (c && cls === 'station') { call = c; tier = 'verified'; src = 'p25'; why = `${c} from the P25 radio's own ID (the gateway knows its callsign)`; }
      else if (cls === 'station') { tier = 'unverified'; why = 'a P25 radio ID the gateway has no callsign for'; }
    } else if (net === 'aprs') {
      const c = normCall(ev.aprsCall);
      if (c) { call = c; tier = 'probable'; src = 'aprs'; why = `${c} from its LoRa APRS source call`; }
    } else if (net === 'meshtastic') {
      if (nameC && ev.licensed) { call = nameC; tier = 'probable'; src = 'meshtastic'; why = `${nameC} in its name, HAM mode on`; }
      else if (nameC && local(nameC)) { call = nameC; tier = 'probable'; src = 'name'; why = `${nameC} in its name`; }
      else if (nameC) { call = nameC; tier = 'unverified'; src = 'name'; why = `${nameC} in its name only (not a VK / ZL call)`; }
    } else if (keyless) {
      const c = mineC || nameC;
      if (c) { call = c; tier = 'unverified'; src = mineC ? 'mine' : 'name'; why = `${c}? -- a channel sender known only by its name (anyone can take a name)`; }
    } else if (dir) {
      call = dir.c; tier = 'verified'; src = 'dir';
      why = `${dir.c} from the P25X directory (signed by its node, call checked by the gateway)${mineC && mineC !== dir.c ? ` -- you set ${mineC} for it` : ''}`;
    } else if (mineC) { call = mineC; tier = 'probable'; src = 'mine'; why = `${mineC} -- you set it`; }
    else if (nameC) {
      call = nameC; src = 'name';
      const fc = normCall(ev.firstCall), fk = String(ev.firstKey || '').toLowerCase();
      if (!local(nameC)) { tier = 'unverified'; why = `${nameC} in its name only (not a VK / ZL call)`; }
      else if (ev.nameFrom === 'qr') { tier = 'unverified'; why = `${nameC} claimed in an unsigned QR code only -- its own advert or a P25X directory entry would confirm it`; }
      else if (fc && fc !== nameC) { tier = 'unverified'; why = `renamed: it was ${fc}, now ${nameC} -- a directory entry would settle it`; }
      else if (fk && key && fk !== key) { tier = 'unverified'; why = `${nameC} is already another node's call (the first one heard with it)`; }
      else { tier = 'probable'; why = `${nameC} in its advert name`; }
    }
    if (call && (RPT_CALL.test(call) || clubs.includes(call)) && cls === 'station') { cls = 'infra'; clsWhy = `${call} is a repeater / club callsign`; }
    if (base === GATEWAY_ID || base === TEST_ID) { call = null; tier = 'none'; src = null; }
    const owner = ownerOf(call);
    if (!self && myCall && owner && owner === ownerOf(myCall)) self = true;
    const ham = cls === 'station' && (tier === 'verified' || tier === 'probable');
    if (self) why = `yours${why ? ` (${why})` : ''} -- your own stations never score`;
    else if (!ham && clsWhy) why = `${clsWhy}${why ? `; ${why}` : ''}`;
    if (!why) why = 'no callsign known';
    return Object.freeze({ ham, tier, call, owner, cls, self, src, why, demo });
  }
  function countsFor(r, cls, opts) {
    if (cls === 'visual') return true;
    if (!r || !r.ham || r.self) return false;
    if (cls === 'local') return (r.tier === 'verified' || r.tier === 'probable') && (!r.demo || !!(opts && opts.demoProfile));
    if (cls === 'club') return r.tier === 'verified' && !r.demo && r.src !== 'aprs' && r.src !== 'meshtastic';
    return false;
  }
  function hamOwners(results, cls, opts) {
    const out = new Set();
    for (const r of results || []) if (r && r.owner && countsFor(r, cls, opts)) out.add(r.owner);
    return out;
  }

  return { TYPES, TYPE_NAME, TYPE_ICON, TYPE_BIT, OVERWRITE_BIT, ERR, LIMITS, TIMEOUT_MS, WARN_FRACTION, DIR_MAX, CARD_MAX_TEXT, ADVERT_MAX,
    PACKET_MAX, hex, unhex, utf8, b64u, unb64u, okKey, normCall, callFromName, label, record, ok, fail, createBus, naclEd, nodeEd,
    parseAdvert, parseCard, qrLink, normEntry, dirBytes, verifyEntry, autoAddOf, bitsOf,
    NOT_CALLS, CLUB_CALLS, NOT_HAM, radioBase, hamStatus, countsFor, hamOwners };
});
