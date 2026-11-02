/* P25X APRS iGate whitelist -- format, Ed25519 signature, versions (2026-10-24, unreleased).
 *
 * ONE module in two places:
 *   gateway/igate-wl.js   the gateway: checks an uploaded list, keeps + serves the current one
 *   kelly-page/js/igate-wl.js                   Kelly: checks what it is given, keeps the last good copy; the admin signs
 * The two files are IDENTICAL -- edit one, copy it over (the dashboard's igate-wl-test.js checks they match). Pure UMD;
 * Ed25519 comes in from the host like js/gold-token.js (Node's crypto: nodeEd(require('crypto')); the browser:
 * naclEd(window.nacl), vendor/tweetnacl-1.0.3).
 *
 * Only whitelisted MeshCore node keys are ever gated to APRS-IS; default deny. ONE authoritative list:
 *   doc   {b: body, s: signature (base64url, 64 B), k: the signer's public key (64 hex)}
 *   body  {v: version (1, 2, ... only ever up), at: unix s, by: admin callsign, e: [entry, ...] (<= 500, sorted by k)}
 *   entry {k: node public key (64 hex), c: callsign, s: SSID 1-15, y: APRS symbol (table + code), m: comment (<= 40),
 *          e: 1 enabled / 0 disabled, by: added by, at: added at (unix s)}
 * The signature covers canonical(body) (fixed field order, UTF-8). It is accepted only when signed by a key in
 * ADMIN_KEYS -- pinned HERE, so a new admin key reaches stations with a Kelly release, never over the air. The admin's
 * private key never leaves the admin's own Kelly (IndexedDB there; js/igateui.js). A newer version replaces the list; an
 * older one, a bad signature or a different list at the same version is refused and the last good copy stays.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IgateWL = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // The admin public keys (64 hex each). Empty = no list is accepted anywhere yet: generate one on the admin's Kelly
  // (APRS iGate > Whitelist > Admin key), paste its public key here, copy this file to the gateway and release.
  const ADMIN_KEYS = [
    // your network's iGate admin public key(s), 64 hex each
  ];
  const MAX_ENTRIES = 500;

  // ------------------------------------------------------------------ bytes
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = h => { const s = String(h || '').replace(/[^0-9a-f]/gi, ''); const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
  const utf8 = s => new TextEncoder().encode(s);
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
    const t = String(s || ''), o = [];
    let n = 0, bits = 0;
    for (const ch of t) { const v = B64.indexOf(ch); if (v < 0) return null; n = n << 6 | v; bits += 6; if (bits >= 8) { bits -= 8; o.push(n >> bits & 255); } }
    return Uint8Array.from(o);
  }

  // ------------------------------------------------------------------ entries
  const HEX64 = /^[0-9a-f]{64}$/;
  const BASE_RE = /^[A-Z0-9]{1,3}[0-9][A-Z]{1,4}$/;   // = js/igate.js validBase
  const okCall = c => c.length <= 6 && BASE_RE.test(c);
  const okSym = y => typeof y === 'string' && y.length === 2 && /^[/\\0-9A-Z]$/.test(y[0]) && y.charCodeAt(1) > 32 && y.charCodeAt(1) < 127;
  const text = (t, max) => String(t == null ? '' : t).replace(/[^\x20-\x7e]/g, '').replace(/[|~]/g, '').slice(0, max).trim();
  // -> the entry in its one canonical shape, or null if anything is wrong
  function normEntry(x) {
    if (!x || typeof x !== 'object') return null;
    const k = String(x.k || '').toLowerCase(), c = String(x.c || '').trim().toUpperCase(), s = Number(x.s), at = Number(x.at || 0);
    const by = String(x.by || '').trim().toUpperCase();
    if (!HEX64.test(k) || !okCall(c) || !Number.isInteger(s) || s < 1 || s > 15 || !okSym(x.y)) return null;
    if (!Number.isInteger(at) || at < 0 || by.length > 9 || !/^[A-Z0-9-]*$/.test(by)) return null;
    return { k, c, s, y: x.y, m: text(x.m, 40), e: x.e === 0 || x.e === false ? 0 : 1, by, at };
  }
  // fixed field order, entries sorted by key: the bytes the signature covers (no checks -- verify() does those)
  function canonical(b) {
    const e = (Array.isArray(b && b.e) ? b.e : []).map(x => normEntry(x) || x).slice().sort((p, q) => (String(p.k) < String(q.k) ? -1 : String(p.k) > String(q.k) ? 1 : 0));
    return JSON.stringify({ v: b && b.v, at: b && b.at, by: b && b.by, e: e.map(x => ({ k: x.k, c: x.c, s: x.s, y: x.y, m: x.m, e: x.e, by: x.by, at: x.at })) });
  }
  // the body checked and normalised -> {ok, body} | {ok: false, error}
  function checkBody(b) {
    if (!b || typeof b !== 'object') return { ok: false, error: 'no list' };
    if (!Number.isInteger(b.v) || b.v < 1) return { ok: false, error: 'version must be a whole number from 1' };
    if (!Number.isInteger(b.at) || b.at < 0) return { ok: false, error: 'bad time' };
    if (!Array.isArray(b.e) || b.e.length > MAX_ENTRIES) return { ok: false, error: `entries: a list of at most ${MAX_ENTRIES}` };
    const e = [], keys = new Set();
    for (let i = 0; i < b.e.length; i++) {
      const n = normEntry(b.e[i]);
      if (!n) return { ok: false, error: `entry ${i + 1} is not valid (key, callsign, SSID 1-15, symbol)` };
      if (keys.has(n.k)) return { ok: false, error: `entry ${i + 1}: that node key is listed twice` };
      keys.add(n.k); e.push(n);
    }
    e.sort((p, q) => (p.k < q.k ? -1 : 1));
    return { ok: true, body: { v: b.v, at: b.at, by: String(b.by || '').trim().toUpperCase().slice(0, 9), e } };
  }

  // ------------------------------------------------------------------ sign / verify / accept
  // signer: {sign(bytes) -> 64 B, publicKey: 32 B}; throws on a list that wouldn't verify
  function sign(body, signer) {
    const c = checkBody(body);
    if (!c.ok) throw new Error(c.error);
    return { b: c.body, s: b64u(signer.sign(utf8(canonical(c.body)))), k: hex(signer.publicKey) };
  }
  // -> {ok, body} | {ok: false, error}
  function verify(doc, ed, keys = ADMIN_KEYS) {
    if (!doc || typeof doc !== 'object' || !doc.b) return { ok: false, error: 'not a whitelist' };
    const k = String(doc.k || '').toLowerCase();
    if (!HEX64.test(k)) return { ok: false, error: 'no signer key' };
    if (!(keys || []).map(x => String(x).toLowerCase()).includes(k)) return { ok: false, error: `signed by ${k.slice(0, 12)}…, which is not an admin key` };
    const c = checkBody(doc.b);
    if (!c.ok) return c;
    const sig = unb64u(doc.s);
    let good = false;
    try { good = !!sig && sig.length === 64 && !!ed.verify(sig, utf8(canonical(doc.b)), unhex(k)); } catch { good = false; }
    return good ? { ok: true, body: c.body } : { ok: false, error: 'the signature does not match the list' };
  }
  // current = the last good doc (or null). -> {ok, doc: the doc to keep, same?, older?, error?}
  function accept(current, incoming, ed, keys = ADMIN_KEYS) {
    const r = verify(incoming, ed, keys);
    if (!r.ok) return { ok: false, error: r.error, doc: current };
    const cv = current && current.b ? current.b.v : 0;
    if (r.body.v < cv) return { ok: false, older: true, error: `version ${r.body.v} is older than ours (${cv})`, doc: current };
    if (r.body.v === cv) {
      const same = canonical(r.body) === canonical(current.b);
      return same ? { ok: false, same: true, doc: current } : { ok: false, error: `a different list with the same version (${cv}) -- refused`, doc: current };
    }
    return { ok: true, doc: { b: r.body, s: incoming.s, k: String(incoming.k).toLowerCase() } };
  }
  // the enabled entry for a full key or a unique 16+ hex prefix (the P25 path sends prefixes), else null
  function lookup(doc, key) {
    const k = String(key || '').toLowerCase();
    if (!doc || !doc.b || !Array.isArray(doc.b.e) || !/^[0-9a-f]{16,64}$/.test(k)) return null;
    const hits = doc.b.e.filter(x => x.k.startsWith(k));
    return hits.length === 1 && hits[0].e ? hits[0] : null;
  }

  // ------------------------------------------------------------------ Ed25519 adapters (= js/gold-token.js)
  function nodeEd(crypto) {
    const SPKI = Buffer.from('302a300506032b6570032100', 'hex'), PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
    const pub = k => crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(k)]), format: 'der', type: 'spki' });
    return {
      verify: (sig, msg, k) => crypto.verify(null, Buffer.from(msg), pub(k), Buffer.from(sig)),
      signer(seed) {
        const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
        const raw = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
        return { sign: msg => new Uint8Array(crypto.sign(null, Buffer.from(msg), key)), publicKey: new Uint8Array(raw) };
      },
    };
  }
  function naclEd(nacl) {
    return {
      verify: (sig, msg, k) => nacl.sign.detached.verify(Uint8Array.from(msg), Uint8Array.from(sig), Uint8Array.from(k)),
      signer(seed) { const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(seed)); return { sign: msg => nacl.sign.detached(Uint8Array.from(msg), kp.secretKey), publicKey: kp.publicKey }; },
    };
  }

  return { ADMIN_KEYS, MAX_ENTRIES, hex, unhex, utf8, b64u, unb64u, normEntry, canonical, checkBody, sign, verify, accept, lookup, nodeEd, naclEd };
});
