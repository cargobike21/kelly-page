/* Kelly Page -- the ONE QR / meshcore:// link module (LoRa Mesh; Phase 10 of docs/lora-mesh-gap-analysis.md 2026-10-23,
 * made the shared module 2026-10-24 per QR_REVIEW.md §6 / review/qr-04-shared-module.md). Every page that builds,
 * reads, draws or scans a QR code uses this file: Contacts card, Ham Contacts, Channels, Connect a phone, the node panel.
 *
 * The standard (docs.meshcore.io/qr_codes; checked against MeshCore firmware v1.18.0 + meshcore-open, review/qr-01):
 *   meshcore://contact/add?name=<url-encoded>&public_key=<64 hex>&type=<1..4>     1 companion 2 repeater 3 room 4 sensor
 *       what the official app puts in a contact QR. Key, type and name only, NOT signed (the name is a claim), added
 *       with ADD_UPDATE_CONTACT (meshcore.js addContact()).
 *       Kelly's APRS share card = that link + &aprs=<CALL-SSID>&sym=<symbol>[&cmt=<comment>] (parse() -> .aprs {c, s, y, m};
 *       buildShare()); the official app ignores the extra params.
 *   meshcore://channel/add?name=<url-encoded>&secret=<32 hex>[&region_scope=<url-encoded>]   (region_scope: app 1.47+)
 *       a channel's 16-byte secret: whoever holds it reads and posts on that channel (meshcore.js setChannel()).
 *   meshcore://<hex of the signed advert packet>
 *       CMD_EXPORT_CONTACT's form (the app's "copy to clipboard"); IMPORT_CONTACT. Signed: verified by hc-core.js
 *       parseCard (the only Ed25519 code), never here -- this file only recognises its shape (verified: false).
 *   Out: lowercase hex, params in the official order, spaces as '+' (URLSearchParams). In: lenient -- any case of scheme /
 *   path / param names / hex, '+' or %20, unknown params ignored, link found inside surrounding text (email, chat,
 *   markdown, <...>, trailing punctuation, &amp;, quoted-printable and line-wrapped advert hex). Names are cut to 31 UTF-8
 *   bytes on a character boundary (the firmware's field). A param given twice with DIFFERENT values is refused (Kelly
 *   and the Dart app would read different keys). A contact link carrying a private-key-looking param, or a bare
 *   64-byte hex blob (MeshCore's private key export), is refused -- private keys never go in a QR.
 *   Other things a QR can hold are named, never echoed: a Kelly connect address (bridge token), a Meshtastic /e/ (PSK) or
 *   /v/ link, a meshcore-open community code (shared secret), any web address.
 *
 * Pure (UMD, Node): LIMITS, TYPES, ERR, PUBLIC_SECRET, QRError, parse(text, {accept}), classify(text), normalise, extract,
 *   buildContact, contactLink, buildShare, buildChannel, hexKey, hexSecret, isZero, okType, fitName, fingerprint, hashtagSecret
 * Drawing (browser): load(which), draw(canvas, text, px, {ecl, quiet}), svg(text, {ecl, quiet, mm}) -> '<svg..>',
 *   decode(src, thorough), decodeAll(src, thorough), cameraWhy(), copy(text)
 * Dialog (one per page, shared by every caller): ui({ toast }) -> { show, showChannel, showText, scan, fromImage,
 *   readImage, paste, confirm, confirmCard, close, scanning }
 * The encoder (vendor/qrcode-generator-1.4.4, MIT) and decoder (vendor/jsqr-1.4.0, Apache-2.0) load on first use.
 * window.KellyMeshQR. Tests: tests/meshqr-test.js (Node), tests/meshqr-tests.html, tests/meshqr-cdp.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.KellyMeshQR = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const TYPES = { 1: 'Companion', 2: 'Repeater', 3: 'Room server', 4: 'Sensor' };
  const LIMITS = { NAME_BYTES: 31, SCOPE_BYTES: 64, TEXT_MAX: 4096, ADVERT_MIN_BYTES: 100, ADVERT_MAX_BYTES: 175, IMAGE_MAX: 25 * 1024 * 1024 };
  const PUBLIC_SECRET = '8b3387e9c5cdea6ac9e5edbaa115cd72';   // MeshCore's Public channel (docs/companion_protocol.md)
  const doc = root && root.document;
  // the vendor folder beside this script (the page loads js/meshqr.js, the tests ../js/meshqr.js)
  const BASE = (() => { try { return new URL('../vendor/', doc.currentScript.src).href; } catch { return 'vendor/'; } })();
  const LIBS = { enc: { path: 'qrcode-generator-1.4.4/qrcode.js', name: 'qrcode' }, dec: { path: 'jsqr-1.4.0/jsQR.js', name: 'jsQR' } };

  // ---- errors: .message is the sentence a card shows (callers read e.message), .code an ERR key, .kind what was found
  const ERR = { EMPTY: 'EMPTY', TOO_LONG: 'TOO_LONG', NOT_MESHCORE: 'NOT_MESHCORE', WRONG_KIND: 'WRONG_KIND', WRONG_NETWORK: 'WRONG_NETWORK',
    BAD_KEY: 'BAD_KEY', ZERO_KEY: 'ZERO_KEY', BAD_TYPE: 'BAD_TYPE', NO_NAME: 'NO_NAME', BAD_NAME: 'BAD_NAME', BAD_SECRET: 'BAD_SECRET',
    BAD_SCOPE: 'BAD_SCOPE', DUP_PARAM: 'DUP_PARAM', PRIVATE_KEY: 'PRIVATE_KEY', BAD_HEX: 'BAD_HEX' };
  class QRError extends Error { constructor(code, message, kind) { super(message); this.name = 'QRError'; this.code = code; this.kind = kind || null; } }
  const fail = (code, msg, kind) => { throw new QRError(code, msg, kind); };

  // what each kind is called, and where it belongs, for "that is a ... -- use ..." (never the code's content)
  const KIND_SAY = {
    contact: 'a MeshCore contact card -- add it in LoRa Mesh › 📇 Ham Contacts (or the 📇 Contacts card)',
    advert: 'a MeshCore contact card -- add it in LoRa Mesh › 📇 Ham Contacts (or the 📇 Contacts card)',
    channel: 'a MeshCore channel, not a contact (it carries the channel\'s secret key) -- add channels in LoRa Mesh › 📻 Channels',
    kelly: 'a Kelly connect code (it holds your bridge token) -- use Admin › Connection › 📷 Scan a Kelly QR',
    meshtastic: 'a Meshtastic link, not MeshCore -- open it in the Meshtastic app',
    community: 'a MeshCore community code (it holds a shared secret) -- Kelly can\'t use those',
    web: 'a web address, not a MeshCore code',
  };

  // ---- small helpers
  const utf8 = s => new TextEncoder().encode(s);
  const HEX = /^[0-9a-f]+$/;
  const isZero = h => /^0+$/.test(String(h || ''));
  // trim + lowercase; exactly 64 / 32 hex (and for a key not all zero), else null
  const hexKey = s => { const h = String(s == null ? '' : s).trim().toLowerCase(); return /^[0-9a-f]{64}$/.test(h) && !isZero(h) ? h : null; };
  const hexSecret = s => { const h = String(s == null ? '' : s).trim().toLowerCase(); return /^[0-9a-f]{32}$/.test(h) ? h : null; };
  // '1'..'4' (spaces allowed) -> 1..4, anything else (0, 5, 2.0, 0x2, abc) -> null
  const okType = v => { const m = /^\s*([1-4])\s*$/.exec(String(v == null ? '' : v)); return m ? Number(m[1]) : null; };
  const CTRL = /[\x00-\x1f\x7f]/;
  // a name -> { name, cut, bad }: NFC, trimmed, cut to max UTF-8 bytes on a grapheme boundary (a flag / ZWJ emoji is
  // never split; the firmware's own cut is bytewise and would leave half a character); bad = control characters
  function fitName(s, max = LIMITS.NAME_BYTES) {
    let t = String(s == null ? '' : s);
    try { t = t.normalize('NFC'); } catch { /* old engine */ }
    t = t.trim();
    if (CTRL.test(t)) return { name: t, cut: false, bad: true };
    if (utf8(t).length <= max) return { name: t, cut: false, bad: false };
    const parts = typeof Intl !== 'undefined' && Intl.Segmenter ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t), x => x.segment) : Array.from(t);
    let out = '', n = 0;
    for (const p of parts) { const b = utf8(p).length; if (n + b > max) break; out += p; n += b; }
    return { name: out.trim(), cut: true, bad: false };
  }
  // 'a1b2c3d4…ef567890': the first 8 and last 8 hex digits, enough to read aloud and check in person
  const fingerprint = key => { const k = String(key || '').toLowerCase(); return k.length >= 16 ? `${k.slice(0, 8)}…${k.slice(-8)}` : k; };
  // a hashtag channel's secret = the first 16 bytes of sha256("#name") (MeshCore docs/companion_protocol.md) -> hex | null
  function hashtagSecret(name) {
    const n = String(name || ''); if (!/^#\S/.test(n)) return null;
    let sha = root && root.KellyMcDecode && root.KellyMcDecode.sha256;
    if (!sha && typeof require === 'function') { try { sha = require('./mcdecode.js').sha256; } catch { sha = null; } }
    if (!sha) return null;
    return Array.from(sha(utf8(n)).subarray(0, 16), x => x.toString(16).padStart(2, '0')).join('');
  }

  // ---- text in
  // any text -> one clean string: BOM / zero-width gone, HTML &amp;, quoted-printable soft breaks (=\n) joined, NFC, trimmed
  function normalise(text) {
    let t = String(text == null ? '' : text).replace(/[﻿​-‍⁠]/g, '').replace(/&amp;/gi, '&').replace(/=\r?\n/g, '');
    try { t = t.normalize('NFC'); } catch { /* old engine */ }
    return t.trim();
  }
  const TRAIL = /[.,;:!?)\]}>'"]+$/;
  // text -> { links: [meshcore:// link..], text } -- every meshcore:// link in it, trailing punctuation off, a name with
  // an unencoded space glued back ("name=Foo Bar&public_key=.."), an advert's hex continued over wrapped lines; a text
  // that is nothing but >= 200 hex digits is taken as an advert
  function extract(text) {
    const t = String(text || ''), links = [], re = /meshcore:\/\/[^\s<>"'`]+/gi;
    let m;
    while ((m = re.exec(t))) {
      let l = m[0], end = m.index + l.length;
      const lineEnd = (i => (i < 0 ? t.length : i))(t.indexOf('\n', end));
      if (/^meshcore:\/\/[a-z]+\/add/i.test(l)) {
        // "name=Foo Bar&public_key=..": the rest of the line carries on the query
        let rest = t.slice(end, lineEnd);
        let g;
        while ((g = /^ +([^\s<>"'`]*&(?:name|public_key|type|secret|region_scope)=[^\s<>"'`]*)/i.exec(rest))) { l += ' ' + g[1]; rest = rest.slice(g[0].length); end += g[0].length; }
      } else if (HEX.test(l.slice(11).toLowerCase()) && lineEnd - m.index >= 60) {
        // a long advert wrapped by a mail program: whole-hex lines that follow are its continuation
        let at = lineEnd;
        while (at < t.length) {
          const nl = t.indexOf('\n', at + 1), line = t.slice(at + 1, nl < 0 ? t.length : nl).trim();
          if (line.length < 8 || !/^[0-9a-f]+$/i.test(line)) break;   // not "73" on its own line
          l += line; at = nl < 0 ? t.length : nl;
          if (line.length < 40) break;   // a short line ends the block
        }
        re.lastIndex = at;
      }
      links.push(l.replace(TRAIL, ''));
    }
    if (!links.length) { const h = t.replace(/\s+/g, ''); if (h.length >= 200 && /^[0-9a-f]+$/i.test(h)) links.push(`meshcore://${h}`); }
    return { links, text: t };
  }
  // one link / text -> its kind without reading it fully: contact | channel | advert | kelly | meshtastic | community | web | meshcore (unknown path) | null
  function kindOf(s) {
    const t = String(s || '').trim();
    let m = /^meshcore:\/\/([a-z]+)\/add\/?(\?|$)/i.exec(t);
    if (m) { const w = m[1].toLowerCase(); return w === 'contact' || w === 'channel' ? w : 'meshcore'; }
    if (/^meshcore:\/\/[0-9a-f\s]+$/i.test(t)) return 'advert';
    if (/^meshcore:\/\//i.test(t)) return 'meshcore';
    if (/^https?:\/\/(www\.)?meshtastic\.org\/[ev]\/?/i.test(t)) return 'meshtastic';
    if (/^\{[\s\S]*"type"\s*:\s*"meshcore_community"/.test(t)) return 'community';
    if (/^https?:\/\//i.test(t)) return /[?&]token=/i.test(t) || /^https?:\/\/[^/?#]+:(8025|8443)([/?#]|$)/i.test(t) ? 'kelly' : 'web';
    return null;
  }
  // any text -> the kind of the code it holds (the scanner's "name it and skip it"); never throws
  function classify(text) {
    try { const t = normalise(text); if (!t) return null; const ex = extract(t); return ex.links.length ? kindOf(ex.links[0]) : kindOf(t); } catch { return null; }
  }
  // a query string -> { get(name), names, dup: [names given twice, differently], all: Map }
  function query(qs) {
    const all = new Map(), dup = [];
    for (const [k0, v] of new URLSearchParams(qs)) { const k = k0.toLowerCase(); if (all.has(k)) { if (all.get(k) !== v && !dup.includes(k)) dup.push(k); } else all.set(k, v); }
    return { get: k => (all.has(k) ? all.get(k) : null), names: [...all.keys()], dup, all };
  }
  const PRIV_PARAM = /priv|prv|seed|secret_?key|private/i;

  function parseContact(link) {
    const q = query(link.replace(/^[^?]*\??/, ''));
    if (q.names.some(n => PRIV_PARAM.test(n))) fail(ERR.PRIVATE_KEY, 'that link carries a private key -- never share one; nothing was added', 'contact');
    if (q.dup.length) fail(ERR.DUP_PARAM, `that contact link gives ${q.dup.join(', ')} twice with different values -- nothing was added`, 'contact');
    const k0 = q.get('public_key');
    const key = hexKey(k0);
    if (!key) fail(isZero(String(k0 || '').trim()) && String(k0 || '').trim().length === 64 ? ERR.ZERO_KEY : ERR.BAD_KEY,
      isZero(String(k0 || '').trim()) && String(k0 || '').trim().length === 64 ? 'that contact link\'s public key is all zeros' : 'that contact link has no proper public key (64 hex digits)', 'contact');
    const r = finishContact({ key, type: q.get('type'), name: q.get('name') }, q.names.filter(n => !['name', 'public_key', 'type', ...SHARE_PARAMS].includes(n)));
    const a = shareOf(q);
    if (a) { r.aprs = a; r.link = shareLink(r, a); }
    return r;
  }
  // Kelly's "share my device for APRS" card (2026-10-31): a normal contact link plus aprs=<CALL-SSID>&sym=<2 chars>[&cmt=..]
  // -- the MeshCore app ignores the extra params and just adds the contact; a Kelly iGate also lists it. Unsigned like
  // the rest of the link: an iGate gates the node only while its own signed advert carries that callsign (HAM ONLY).
  const SHARE_PARAMS = ['aprs', 'sym', 'cmt'];
  function shareOf(q) {
    const m = /^([A-Z0-9]{1,3}[0-9][A-Z]{1,4})-([1-9]|1[0-5])$/.exec(String(q.get('aprs') || '').trim().toUpperCase());
    if (!m || m[1].length > 6) return null;
    const y = String(q.get('sym') || '/>');
    return { c: m[1], s: Number(m[2]), y: y.length === 2 && /^[/\\0-9A-Z]$/.test(y[0]) && y.charCodeAt(1) > 32 && y.charCodeAt(1) < 127 ? y : '/>',
      m: String(q.get('cmt') || '').replace(/[^\x20-\x7e]/g, '').replace(/[|~]/g, '').slice(0, 40).trim() };
  }
  const shareLink = (r, a) => `${r.link}&${new URLSearchParams(Object.assign({ aprs: `${a.c}-${a.s}`, sym: a.y }, a.m ? { cmt: a.m } : {}))}`;
  // { name, key, type, c, s, y, m } -> { link, name, key, type, aprs, warnings } (throws QRError like buildContact)
  function buildShare({ name, key, type, c, s, y, m } = {}) {
    const r = buildContact({ name, key, type });
    const a = shareOf(query(new URLSearchParams({ aprs: `${c}-${s}`, sym: y || '/>', cmt: m || '' }).toString()));
    if (!a) fail(ERR.BAD_NAME, 'a share card needs an amateur callsign and an SSID 1-15', 'contact');
    return Object.assign(r, { aprs: a, link: shareLink(r, a) });
  }
  function finishContact({ key, type, name }, ignored = []) {
    const warnings = [];
    let ty = okType(type);
    if (ty == null) {
      if (type == null || type === '' || type === 0) { ty = 1; warnings.push({ code: 'type-assumed', msg: 'No node type given -- taken as a Companion.' }); }
      else fail(ERR.BAD_TYPE, `that contact link has an unknown type (${String(type).slice(0, 8)})`, 'contact');
    }
    const f = fitName(name);
    if (f.bad) fail(ERR.BAD_NAME, 'that contact\'s name holds control characters', 'contact');
    if (f.cut) warnings.push({ code: 'name-truncated', msg: `Name shortened to "${f.name}" (a node keeps 31 bytes).` });
    const link = `meshcore://contact/add?${new URLSearchParams({ name: f.name, public_key: key, type: String(ty) })}`;
    return { kind: 'contact', key, type: ty, name: f.name, link, verified: false, warnings, ignored };
  }
  function parseChannel(link) {
    const q = query(link.replace(/^[^?]*\??/, ''));
    if (q.dup.length) fail(ERR.DUP_PARAM, `that channel link gives ${q.dup.join(', ')} twice with different values -- nothing was added`, 'channel');
    return finishChannel({ name: q.get('name'), secret: q.get('secret'), regionScope: q.get('region_scope') }, q.names.filter(n => !['name', 'secret', 'region_scope'].includes(n)));
  }
  function finishChannel({ name, secret, regionScope }, ignored = []) {
    const warnings = [];
    const f = fitName(name);
    if (f.bad) fail(ERR.BAD_NAME, 'that channel\'s name holds control characters', 'channel');
    if (!f.name) fail(ERR.NO_NAME, 'that channel link has no name', 'channel');
    if (f.cut) warnings.push({ code: 'name-truncated', msg: `Name shortened to "${f.name}" (a node keeps 31 bytes).` });
    const s = hexSecret(secret);
    if (!s) fail(ERR.BAD_SECRET, 'that channel link has no proper secret (32 hex digits)', 'channel');
    if (isZero(s)) warnings.push({ code: 'zero-secret', msg: 'Its secret is all zeros -- anyone can read that channel.' });
    let scope = regionScope == null ? null : String(regionScope).trim();
    if (scope === '') scope = null;
    if (scope != null) {
      if (CTRL.test(scope) || utf8(scope).length > LIMITS.SCOPE_BYTES) fail(ERR.BAD_SCOPE, 'that channel link has a broken region scope', 'channel');
      warnings.push({ code: 'scope-needs-app-1.47', msg: `Region scope "${scope}": the MeshCore app needs v1.47 or later for it; Kelly shows it but doesn't apply it.` });
    }
    const p = { name: f.name, secret: s }; if (scope != null) p.region_scope = scope;
    const hashtag = hashtagSecret(f.name);
    return { kind: 'channel', name: f.name, secret: s, regionScope: scope, wellKnown: s === PUBLIC_SECRET, hashtag: hashtag != null && hashtag === s,
      link: `meshcore://channel/add?${new URLSearchParams(p)}`, warnings, ignored };
  }
  function parseAdvertLink(link) {
    const h = link.replace(/^meshcore:\/\//i, '').replace(/\s+/g, '').toLowerCase();
    if (h.length === 128) fail(ERR.PRIVATE_KEY, 'that looks like a node\'s PRIVATE key -- never share it; nothing was added', 'advert');
    if (!HEX.test(h) || h.length % 2) fail(ERR.BAD_HEX, 'that contact card is cut short -- copy all of it', 'advert');
    if (h.length / 2 < LIMITS.ADVERT_MIN_BYTES) fail(ERR.BAD_HEX, 'that contact card is cut short -- copy all of it', 'advert');
    if (h.length / 2 > LIMITS.ADVERT_MAX_BYTES) fail(ERR.BAD_HEX, 'that card is too big to be a MeshCore contact', 'advert');
    return { kind: 'advert', hex: h, link: `meshcore://${h}`, verified: false, warnings: [], ignored: [] };
  }

  // text -> Parsed (throws QRError). opts.accept = the kinds this importer takes (default contact + advert); a kind it
  // doesn't take throws WRONG_KIND / WRONG_NETWORK naming it. Parsed = { kind, link, warnings, ignored, more, ... }:
  //   contact { key, type, name, verified: false } · channel { name, secret, regionScope, wellKnown, hashtag } ·
  //   advert { hex, verified: false } · meshtastic / kelly / web { url } (only when accepted). more = other links found.
  function parse(text, opts = {}) {
    const accept = opts.accept || ['contact', 'advert'];
    const what = accept.includes('contact') ? 'contact card' : accept.includes('channel') ? 'channel code' : 'code';
    const raw = text == null ? '' : String(text);
    if (raw.length > LIMITS.TEXT_MAX) fail(ERR.TOO_LONG, `that is far too long to be a ${what}`);
    const t = normalise(raw);
    if (!t) fail(ERR.EMPTY, `nothing to add -- paste or scan a ${what}`);
    const { links } = extract(t);
    if (!links.length) {
      if (/^[0-9a-f]{128}$/i.test(t.replace(/\s+/g, ''))) fail(ERR.PRIVATE_KEY, 'that looks like a node\'s PRIVATE key -- never share it; nothing was added');
      const k = kindOf(t);
      if (k && accept.includes(k)) return { kind: k, url: t, link: t, warnings: [], ignored: [], more: [] };
      if (k) fail(k === 'meshtastic' ? ERR.WRONG_NETWORK : ERR.WRONG_KIND, `that is ${KIND_SAY[k]} -- nothing was added`, k);
      fail(ERR.NOT_MESHCORE, `no ${what} found in that text -- it should hold a meshcore:// link`);
    }
    const kinds = links.map(kindOf);
    // a signed advert beats an unsigned contact/add; then the first link this importer takes
    let i = accept.includes('advert') ? kinds.indexOf('advert') : -1;
    if (i < 0) i = kinds.findIndex(k => accept.includes(k));
    if (i < 0) {
      const k = kinds[0];
      if (k === 'meshcore') fail(ERR.NOT_MESHCORE, 'that is a MeshCore link Kelly doesn\'t know -- nothing was added', k);
      fail(ERR.WRONG_KIND, `that is ${KIND_SAY[k] || 'not a MeshCore code'} -- nothing was added`, k);
    }
    const k = kinds[i], link = links[i];
    const r = k === 'contact' ? parseContact(link) : k === 'channel' ? parseChannel(link) : k === 'advert' ? parseAdvertLink(link) : { kind: k, url: link, link, warnings: [], ignored: [] };
    r.more = links.filter((l, j) => j !== i && accept.includes(kinds[j]) && l.toLowerCase() !== link.toLowerCase());
    if (r.more.length) r.warnings.push({ code: 'links-ignored', msg: `${r.more.length} more card${r.more.length > 1 ? 's' : ''} in that text -- add ${r.more.length > 1 ? 'them' : 'it'} one at a time.` });
    return r;
  }

  // ---- links out
  // { name, key, type } -> { link, name, key, type, warnings } (throws QRError on a bad key / type / name)
  function buildContact({ name, key, type } = {}) {
    const k = hexKey(key);
    if (!k) fail(isZero(String(key || '')) ? ERR.ZERO_KEY : ERR.BAD_KEY, 'a contact QR needs the node\'s whole public key (64 hex digits)', 'contact');
    const r = finishContact({ key: k, type: type == null || type === 0 ? null : type, name });
    return { link: r.link, name: r.name, key: k, type: r.type, warnings: r.warnings };
  }
  const contactLink = c => buildContact(c).link;
  // { name, secret, regionScope } -> { link, name, secret, regionScope, wellKnown, hashtag, warnings }
  function buildChannel({ name, secret, regionScope } = {}) {
    const r = finishChannel({ name, secret: secret instanceof Uint8Array ? Array.from(secret, x => x.toString(16).padStart(2, '0')).join('') : secret, regionScope });
    return { link: r.link, name: r.name, secret: r.secret, regionScope: r.regionScope, wellKnown: r.wellKnown, hashtag: r.hashtag, warnings: r.warnings };
  }

  // ---- the vendored libraries, loaded on first use
  const loading = {};
  function load(which) {
    const lib = LIBS[which];
    if (root[lib.name]) return Promise.resolve(root[lib.name]);
    return loading[which] || (loading[which] = new Promise((res, rej) => {
      const s = doc.createElement('script');
      s.src = BASE + lib.path;
      s.onload = () => root[lib.name] ? res(root[lib.name]) : rej(new Error(`${lib.path} did not load`));
      s.onerror = () => { delete loading[which]; rej(new Error(`couldn't load ${lib.path}`)); };
      doc.head.appendChild(s);
    }));
  }
  async function matrix(text, ecl) {
    const qrcode = await load('enc');
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    const q = qrcode(0, ecl || 'M'); q.addData(String(text), 'Byte'); q.make();
    return q;
  }
  // text -> a QR code on the canvas, about px CSS pixels wide: black on white (never inverted in dark mode), the
  // 4-module quiet zone drawn inside, whole device pixels per module and at least 4 CSS px each. -> module count
  async function draw(cv, text, px = 300, { ecl = 'M', quiet = 4 } = {}) {
    const q = await matrix(text, ecl), n = q.getModuleCount(), cells = n + 2 * Math.max(4, quiet);
    const dpr = Math.max(1, Math.min(4, (root.devicePixelRatio || 1)));
    const css = Math.max(px, cells * 4), s = Math.max(2, Math.floor(css * dpr / cells)), size = s * cells, qz = (cells - n) / 2;
    cv.width = cv.height = size;
    cv.style.width = cv.style.height = `${Math.round(size / dpr)}px`;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + qz) * s, (r + qz) * s, s, s);
    return n;
  }
  // text -> '<svg ...>' for print: mm wide, ECC Q by default; refuses a size under 0.4 mm per module
  async function svg(text, { ecl = 'Q', quiet = 4, mm = 40 } = {}) {
    const q = await matrix(text, ecl), n = q.getModuleCount(), cells = n + 2 * Math.max(4, quiet), qz = (cells - n) / 2;
    if (mm / cells < 0.4) throw new Error(`that QR code needs at least ${Math.ceil(cells * 0.4)} mm to scan reliably on paper`);
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + qz} ${r + qz}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cells} ${cells}" width="${mm}mm" height="${mm}mm" shape-rendering="crispEdges"><rect width="${cells}" height="${cells}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  // BarcodeDetector if it reads QR here (null if not; KellyMeshQR.native = false turns it off, for the tests)
  let detector;
  async function nativeDetector() {
    if (api.native === false || !('BarcodeDetector' in root)) return null;
    if (detector !== undefined) return detector;
    try { detector = (await root.BarcodeDetector.getSupportedFormats()).includes('qr_code') ? new root.BarcodeDetector({ formats: ['qr_code'] }) : null; }
    catch { detector = null; }
    return detector;
  }
  let work;
  // one jsQR pass over a region of src (sx, sy, sw, sh) scaled so its long side is `long` px
  async function jsqrPass(src, sx, sy, sw, sh, long, both) {
    const jsQR = await load('dec');
    const k = Math.min(1, long / Math.max(sw, sh)), w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    work = work || doc.createElement('canvas');
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    const g = work.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const r = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: both ? 'attemptBoth' : 'dontInvert' });
    return r ? r.data : null;
  }
  // an image / canvas / playing video -> every QR text found ([] if none). A video frame (thorough false): the native
  // detector, else jsQR on the whole frame at 640 px and, every other frame, a centre square crop (dense advert codes).
  // A still (thorough): native, then jsQR at 1200 and 2400 px, then 3 x 3 overlapping crops at full size.
  let alt = 0;
  async function decodeAll(src, thorough = true) {
    const d = await nativeDetector();
    if (d) {
      try { const r = await d.detect(src); if (r && r.length) return r.map(x => x.rawValue).filter(Boolean); if (!thorough) return []; }
      catch { if (!thorough) return []; }
    }
    const w0 = src.videoWidth || src.naturalWidth || src.width, h0 = src.videoHeight || src.naturalHeight || src.height;
    if (!w0 || !h0) return [];
    if (!thorough) {
      alt ^= 1;
      if (!alt) { const s = Math.min(w0, h0) * 0.7; const t = await jsqrPass(src, (w0 - s) / 2, (h0 - s) / 2, s, s, 640, false); return t ? [t] : []; }
      const t = await jsqrPass(src, 0, 0, w0, h0, 640, false); return t ? [t] : [];
    }
    for (const long of [1200, 2400]) { const t = await jsqrPass(src, 0, 0, w0, h0, long, true); if (t) return [t]; if (Math.max(w0, h0) <= long) break; }
    const cw = w0 / 2, ch = h0 / 2;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) { const t = await jsqrPass(src, x * cw / 2, y * ch / 2, cw, ch, 1600, true); if (t) return [t]; }
    return [];
  }
  const decode = async (src, thorough = true) => (await decodeAll(src, thorough))[0] || null;

  // '' when the camera can run here, else one sentence why not (js/secure.js knows the https fix)
  function cameraWhy() {
    if (root.KellySecure) return root.KellySecure.why('camera');
    const md = root.navigator && root.navigator.mediaDevices;
    return root.isSecureContext && md && md.getUserMedia ? '' : 'The camera only works on a secure page (https:// or localhost).';
  }
  // text -> the clipboard; true if it got there (the async API can hang without a user gesture: 1.5 s, then execCommand)
  async function copy(text) {
    try {
      const nav = root.navigator && root.navigator.clipboard;
      if (nav) { await Promise.race([nav.writeText(String(text)), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 1500))]); return true; }
    } catch { /* fall back */ }
    try {
      const ta = doc.createElement('textarea'); ta.value = String(text); ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      doc.body.appendChild(ta); ta.select(); const okc = doc.execCommand && doc.execCommand('copy'); ta.remove(); return !!okc;
    } catch { return false; }
  }
  const camError = e => {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera blocked: allow it from the 🔒 in the address bar, or use 🖼️ From image.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera on this device -- use 🖼️ From image.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'Another app is using the camera -- close it, or use 🖼️ From image.';
    return `No camera: ${(e && (e.message || e.name)) || 'it would not start'}. Use 🖼️ From image instead.`;
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TYPE_ICON = { 1: '📱', 2: '📡', 3: '🏛️', 4: '🌡️' };
  const IDLE_MS = 120000;

  // ---- the dialog: ONE per page (every ui() shares it, and there is one camera owner)
  let box = null, scanning = null, onClose = null, keyHooked = false, visHooked = false;
  function ui({ toast } = {}) {
    const say = (t, m) => (toast ? toast('🖼️', t, m, 'warn') : null);
    function open(title, html) {
      if (!box) {
        box = doc.createElement('div'); box.id = 'mqr'; box.className = 'mqr'; box.hidden = true;
        box.innerHTML = '<div class="mqr-box" role="dialog" aria-modal="true" aria-labelledby="mqr-title"><div class="mqr-h"><b id="mqr-title"></b><button class="btn small ghost" data-mqr="close" title="Close">✕</button></div><div id="mqr-body"></div></div>';
        doc.body.appendChild(box);
        box.addEventListener('click', e => { if (e.target === box || e.target.closest('[data-mqr="close"]')) close(); });
      }
      if (!keyHooked) { keyHooked = true; doc.addEventListener('keydown', e => { if (e.key === 'Escape' && box && !box.hidden) close(); }); }
      stopScan(); settle(false);
      box.querySelector('#mqr-title').textContent = title;
      box.querySelector('#mqr-body').innerHTML = html;
      box.hidden = false;
      return box.querySelector('#mqr-body');
    }
    // a pending confirm() answers false when the dialog closes or is reused
    function settle(v) { const f = onClose; onClose = null; if (f) f(v); }
    function close() { stopScan(); settle(false); if (box) box.hidden = true; }
    const caption = (name, type, key) => `<p class="mqr-cap"><b>${esc(name || '(no name)')}</b><br><span class="small">${TYPE_ICON[type] || ''} ${esc(TYPES[type] || '')}${key ? ` · <code>${esc(fingerprint(key))}</code>` : ''}</span></p>`;

    // Show QR of a contact: the app's form first (the official app reads it); the signed advert as a second choice
    // (Kelly-to-Kelly, screen only). contact = { key, type, name }; advert = async () => link; note = an extra line
    function show({ title, contact, advert, note: extra }) {
      let built;
      try { built = buildContact(contact); } catch (e) { const b = open(title || '▦ QR code', '<p class="small"></p>'); b.querySelector('p').textContent = `⚠️ ${e.message}`; return Promise.resolve(); }
      const body = open(title || `▦ ${built.name || 'Contact'}`, `<div class="mqr-tabs"><button class="btn small on" data-fmt="app">MeshCore app</button>${advert ? '<button class="btn small" data-fmt="advert">Signed advert</button>' : ''}</div>`
        + `<canvas class="mqr-code" width="300" height="300"></canvas>${caption(built.name, built.type, built.key)}<p class="small mqr-note"></p>`
        + `${extra ? `<p class="small dim">${esc(extra)}</p>` : ''}<div class="mc-link"><input readonly class="mqr-link" aria-label="The link in the QR code"><button class="btn small" data-mqr="copy">Copy</button></div>`);
      const cv = body.querySelector('canvas'), note = body.querySelector('.mqr-note'), inp = body.querySelector('.mqr-link');
      const NOTE = { app: 'Scan it with the MeshCore phone app, or with Kelly. The name is not checked: the key is what counts.', advert: 'The whole signed advert (name and position signed by the node). Kelly and meshcore-open read it; show it on a screen, it is too dense to print small.' };
      async function pick(fmt) {
        body.querySelectorAll('[data-fmt]').forEach(b => b.classList.toggle('on', b.dataset.fmt === fmt));
        note.textContent = 'Drawing…';
        try {
          const link = fmt === 'advert' ? await advert() : built.link;
          await draw(cv, link, 300); inp.value = link; note.textContent = NOTE[fmt] + (built.warnings.length && fmt === 'app' ? ` ${built.warnings.map(w => w.msg).join(' ')}` : '');
        } catch (e) { note.textContent = `⚠️ ${e.message}`; }
      }
      body.addEventListener('click', async e => {
        const f = e.target.closest('[data-fmt]'); if (f) return pick(f.dataset.fmt);
        if (e.target.closest('[data-mqr="copy"]')) note.textContent = (await copy(inp.value)) ? 'Link copied.' : 'Copy did not work -- select the link and copy it.';
      });
      return pick('app');
    }
    // Show QR of a channel. A private channel's QR IS its key: drawn only after "Show QR", the secret is never shown as
    // text, and Copy needs that click too. ch = { name, secret, regionScope }
    function showChannel({ title, channel }) {
      let b;
      try { b = buildChannel(channel); } catch (e) { const x = open(title || '📻 Channel QR', '<p class="small"></p>'); x.querySelector('p').textContent = `⚠️ ${e.message}`; return Promise.resolve(); }
      const open_ = b.wellKnown || b.hashtag;
      const warn = open_ ? '' : '<p class="small">⚠️ This is a private channel. Its QR code <b>is</b> the channel key: anyone who scans or photographs it can read and post on the channel, for good. Show it only to people you trust, never on a printed sheet.</p><button class="btn primary" data-mqr="reveal">Show QR</button>';
      const body = open(title || `📻 ${b.name}`, `${warn}<canvas class="mqr-code" width="300" height="300"${open_ ? '' : ' hidden'}></canvas>`
        + `<p class="mqr-cap"><b>${esc(b.name)}</b><br><span class="small">MeshCore channel${b.hashtag ? ' · public hashtag channel' : b.wellKnown ? ' · the Public channel' : ' · private'}${b.regionScope ? ` · region ${esc(b.regionScope)}` : ''}</span></p>`
        + `<p class="small mqr-note">${open_ ? 'Anyone can read this channel: its secret comes from its name.' : ''}</p><div class="mc-link"${open_ ? '' : ' hidden'}><button class="btn small" data-mqr="copy">Copy link</button></div>`);
      const cv = body.querySelector('canvas'), note = body.querySelector('.mqr-note');
      const reveal = async () => { cv.hidden = false; body.querySelector('.mc-link').hidden = false; const r = body.querySelector('[data-mqr="reveal"]'); if (r) r.remove(); try { await draw(cv, b.link, 300); note.textContent = b.warnings.map(w => w.msg).join(' '); } catch (e) { note.textContent = `⚠️ ${e.message}`; } };
      body.addEventListener('click', async e => {
        if (e.target.closest('[data-mqr="reveal"]')) return reveal();
        if (e.target.closest('[data-mqr="copy"]')) note.textContent = (await copy(b.link)) ? 'Link copied -- it holds the channel key.' : 'Copy did not work.';
      });
      return open_ ? reveal() : Promise.resolve();
    }

    function stopScan() {
      if (!scanning) return;
      const s = scanning; scanning = null;
      clearTimeout(s.timer); clearTimeout(s.idle);
      if (s.stream) s.stream.getTracks().forEach(t => t.stop());
      if (s.video) { s.video.pause(); s.video.srcObject = null; }
    }
    // Any text as a QR (the Mesh bridge address, a Kelly connect code): with `secret`, drawn only after Show QR, and the
    // line under it shows `display` (the token masked); Copy copies the real text
    function showText({ title, text, display, note, secret }) {
      const body = open(title, `${secret ? `<p class="small">⚠️ ${esc(secret)}</p><button class="btn primary" data-mqr="reveal">Show QR</button>` : ''}`
        + `<canvas class="mqr-code" width="300" height="300"${secret ? ' hidden' : ''}></canvas><p class="small mqr-note"></p>`
        + '<div class="mc-link"><input readonly class="mqr-link" aria-label="The text in the QR code"><button class="btn small" data-mqr="copy">Copy</button></div>');
      const cv = body.querySelector('canvas'), out = body.querySelector('.mqr-note'), inp = body.querySelector('.mqr-link');
      inp.value = display || text; out.textContent = note || '';
      const reveal = async () => { cv.hidden = false; const b = body.querySelector('[data-mqr="reveal"]'); if (b) b.remove(); try { await draw(cv, text, 300); } catch (e) { out.textContent = `⚠️ ${e.message}`; } };
      body.addEventListener('click', async e => {
        if (e.target.closest('[data-mqr="reveal"]')) return reveal();
        if (e.target.closest('[data-mqr="copy"]')) out.textContent = (await copy(text)) ? 'Copied.' : 'Copy did not work.';
      });
      return secret ? null : reveal();
    }

    // the check every scanner / picture / paste runs: opts.check(text) if given (may throw), else parse(text, {accept})
    const validate = (text, opts) => (opts.check ? opts.check(text) : parse(text, { accept: opts.accept }));
    // Scan QR from the camera: frames until a code this caller takes is read; other codes are named once and skipped.
    // Stops on a read, close, Esc, another scan, the tab hidden / the phone switching app (▶ Resume), or 2 min idle.
    // onText(text, parsed). opts = { accept, check, title, hint }
    async function scan(onText, opts = {}) {
      const title = opts.title || '📷 Scan a QR code';
      const why = cameraWhy();
      if (why) {
        const p = open(title, '<p class="small"></p><button class="btn" data-mqr="photo">📷 Take a photo of the QR</button>');
        p.querySelector('p').textContent = `${why} You can still take a photo of the QR code, or pick a screenshot.`;
        p.querySelector('[data-mqr="photo"]').onclick = () => { close(); fromImage(onText, opts); };
        return;
      }
      const body = open(title, '<video class="mqr-video" playsinline muted></video><div class="row gap mqr-tools"><button class="btn small ghost" data-mqr="flip" hidden title="Switch camera">⟲</button><button class="btn small ghost" data-mqr="torch" hidden title="Torch">🔦</button></div>'
        + `<p class="small mqr-note">Starting the camera…</p>${opts.hint ? `<p class="small dim">${esc(opts.hint)}</p>` : ''}`);
      const video = body.querySelector('video'), note = body.querySelector('.mqr-note'), me = scanning = { video };
      let devId = null;
      try { devId = root.localStorage && root.localStorage.getItem('kelly.qrCam'); } catch { devId = null; }
      const start = async () => {
        if (me.stream) me.stream.getTracks().forEach(t => t.stop());
        const v = devId ? { deviceId: { exact: devId }, width: { ideal: 1280 } } : { facingMode: 'environment', width: { ideal: 1280 } };
        try { me.stream = await root.navigator.mediaDevices.getUserMedia({ video: v, audio: false }); }
        catch (e) { if (devId) { devId = null; return start(); } throw e; }
        if (scanning !== me) { me.stream.getTracks().forEach(t => t.stop()); return false; }   // closed while the browser asked
        video.srcObject = me.stream; await video.play();
        const track = me.stream.getVideoTracks()[0], caps = track && track.getCapabilities ? track.getCapabilities() : {};
        body.querySelector('[data-mqr="torch"]').hidden = !caps.torch;
        try { const cams = (await root.navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); me.cams = cams; body.querySelector('[data-mqr="flip"]').hidden = cams.length < 2; } catch { /* no list */ }
        return true;
      };
      try { if (!(await start())) return; }
      catch (e) { if (scanning === me) { stopScan(); note.textContent = `⚠️ ${camError(e)}`; } return; }
      body.querySelector('[data-mqr="flip"]').onclick = async () => {
        const cams = me.cams || [], cur = me.stream && me.stream.getVideoTracks()[0] && me.stream.getVideoTracks()[0].getSettings().deviceId;
        const i = cams.findIndex(c => c.deviceId === cur), nx = cams[(i + 1) % cams.length];
        if (!nx) return; devId = nx.deviceId; try { root.localStorage && root.localStorage.setItem('kelly.qrCam', devId); } catch { /* private window */ }
        try { await start(); } catch (e) { note.textContent = `⚠️ ${camError(e)}`; }
      };
      body.querySelector('[data-mqr="torch"]').onclick = async () => {
        const t = me.stream && me.stream.getVideoTracks()[0]; if (!t) return;
        me.torch = !me.torch; try { await t.applyConstraints({ advanced: [{ torch: me.torch }] }); } catch { me.torch = false; }
      };
      note.textContent = 'Hold the QR code up to the camera.';
      const pause = msg => {
        if (scanning !== me) return;
        stopScan();
        note.innerHTML = `${esc(msg)} <button class="btn small" data-mqr="resume">▶ Resume</button>`;
        note.querySelector('[data-mqr="resume"]').onclick = () => scan(onText, opts);
      };
      if (!visHooked) {
        visHooked = true;
        const hide = () => { if (scanning && scanning.pause) scanning.pause('Camera paused while Kelly was hidden.'); };
        doc.addEventListener('visibilitychange', () => { if (doc.hidden) hide(); });
        root.addEventListener && root.addEventListener('pagehide', hide);
      }
      me.pause = pause;
      me.idle = setTimeout(() => pause('Camera stopped: nothing read for 2 minutes.'), IDLE_MS);
      let last = '', frames = 0;
      const t0 = Date.now();
      const tick = async () => {
        if (scanning !== me) return;
        let texts = [];
        if (!doc.hidden && video.readyState >= 2) { try { texts = await decodeAll(video, false); } catch (e) { note.textContent = `⚠️ ${e.message}`; } }
        if (scanning !== me) return;
        frames++;
        let bad = null;
        for (const text of texts) {
          let parsed;
          try { parsed = validate(text, opts); } catch (e) { bad = bad || e; continue; }
          close(); onText(text, parsed); return;
        }
        if (bad && bad.message !== last) { last = bad.message; note.textContent = `⚠️ ${bad.message.replace(/ -- nothing was added$/, '')}. Try another code.`; }
        if (texts.length > 1 && !bad) note.textContent = `${texts.length} codes in view -- move closer to one.`;
        me.timer = setTimeout(tick, Date.now() - t0 > 20000 ? 300 : 150);
      };
      tick();
    }

    // From image: pick a photo or screenshot (any page, no camera or secure context needed; on a phone it can open the
    // camera app). Only a code this caller takes reaches onText(text, parsed); anything else is named in a toast and
    // never put in a text box (a Kelly connect code would show its token, a Meshtastic link its PSK).
    function fromImage(onText, opts = {}) {
      const inp = doc.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      if (cameraWhy() && /Android|iPhone|iPad|Mobile/i.test((root.navigator && root.navigator.userAgent) || '')) inp.setAttribute('capture', 'environment');
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0]; if (!f) return;
        readImage(f).then(text => {
          let parsed;
          try { parsed = validate(text, opts); } catch (e) { return say('Not added', e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.'); }
          onText(text, parsed);
        }, e => say('No QR code read', e.message));
      });
      inp.click();
    }
    // a File / Blob -> the QR code's text (rejects with a sentence if there's none)
    async function readImage(file) {
      if (file.size > LIMITS.IMAGE_MAX) throw new Error('that picture is over 25 MB -- send a smaller photo or a screenshot');
      let src = null, url = null;
      try {
        if (root.createImageBitmap) {
          try { src = await root.createImageBitmap(file); } catch { src = null; }
        }
        if (!src) { url = URL.createObjectURL(file); const img = new Image(); img.src = url; await img.decode(); src = img; }
      } catch {
        if (url) URL.revokeObjectURL(url);
        throw new Error(/heic|heif/i.test(file.type || file.name || '') ? 'that photo format (HEIC) can\'t be read here -- send a JPEG or PNG, or a screenshot' : 'that file could not be opened as a picture');
      }
      try {
        const text = await decode(src, true);
        if (!text) throw new Error('no QR code found in that picture -- try a closer, sharper photo');
        return text;
      } finally { if (url) URL.revokeObjectURL(url); if (src && src.close) src.close(); }
    }
    // pasted text / a .txt file -> Parsed (throws QRError), same rules as the camera
    const paste = (text, opts = {}) => validate(text, opts);

    // a yes / no question in the dialog -> Promise<bool> (false on close / Esc). html is the caller's (escape it!)
    function confirm({ title, html, ok = 'Add', cancel = 'Cancel', danger = false }) {
      const body = open(title, `${html}<div class="row gap mqr-act"><button class="btn ${danger ? 'danger' : 'primary'}" data-mqr="yes">${esc(ok)}</button><button class="btn ghost" data-mqr="no">${esc(cancel)}</button></div>`);
      return new Promise(res => {
        onClose = res;
        body.querySelector('[data-mqr="yes"]').onclick = () => { onClose = null; close(); res(true); };
        body.querySelector('[data-mqr="no"]').onclick = () => close();
      });
    }
    // the shared "add this contact?" preview, before anything is written to a radio. card = Parsed / CardInfo
    // { kind, key, type, name, verified, lat, lon, warnings }; extra = { status: sentence (on your radio as X / new),
    // trust: sentence (callsign check), warn: sentence (e.g. the table is full), self: bool } -> Promise<bool>
    function confirmCard(card, extra = {}) {
      const signed = card.verified;
      const rows = [
        `<p class="mqr-cap"><b>${esc(card.name || '(no name)')}</b><br><span class="small">${TYPE_ICON[card.type] || '❔'} ${esc(TYPES[card.type] || 'Node')}${card.warnings && card.warnings.some(w => w.code === 'type-assumed') ? ' (assumed: the card gave no type)' : ''}</span></p>`,
        `<p class="small">Key <code>${esc(fingerprint(card.key))}</code> · path hash <code>${esc(String(card.key || '').slice(0, 2))}</code> / <code>${esc(String(card.key || '').slice(0, 4))}</code></p>`,
        `<p class="small">${signed ? '✅ Name and position signed by this radio (the callsign is not checked).' : '⚠️ An unsigned app QR: anyone can type any name into one. Check the key above with its owner in person.'}</p>`,
      ];
      if (extra.trust) rows.push(`<p class="small">${esc(extra.trust)}</p>`);
      if (extra.status) rows.push(`<p class="small">${esc(extra.status)}</p>`);
      if (extra.warn) rows.push(`<p class="small">⚠️ ${esc(extra.warn)}</p>`);
      for (const w of card.warnings || []) if (w.code !== 'type-assumed') rows.push(`<p class="small dim">${esc(w.msg)}</p>`);
      if (extra.self) return confirm({ title: '📇 This is your own node', html: rows.join('') + '<p class="small">That card is your own node: nothing to add.</p>', ok: 'OK', cancel: 'Close' }).then(() => false);
      return confirm({ title: '📇 Add this contact to your radio?', html: rows.join(''), ok: extra.ok || 'Add to my radio', danger: !!extra.danger });
    }
    return { show, showChannel, showText, scan, fromImage, readImage, paste, confirm, confirmCard, close, scanning: () => !!scanning };
  }

  const api = { TYPES, LIMITS, ERR, PUBLIC_SECRET, QRError, parse, classify, normalise, extract, buildContact, contactLink, buildShare, buildChannel,
    hexKey, hexSecret, isZero, okType, fitName, fingerprint, hashtagSecret, load, draw, svg, decode, decodeAll, cameraWhy, copy, ui, native: true };
  return api;
});
