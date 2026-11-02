/* Kelly Page -- registration tokens: format and offline verification (public release plan section 7.1, step 13).
 *
 * A token says "this station (sub = callsign) on this device (dev = its Ed25519 public key) may use these features
 * (feat) until exp". It is issued by the registration service and is not a secret: it's bound to the device key,
 * so a copy is useless on another device. ONE format in two languages: bridge/kelly_ent.py verifies the same tokens;
 * both run bridge/ent_token_vectors.json. Pure UMD; Ed25519 comes in from the host like js/igate-wl.js
 * (nodeEd(require('crypto')) in Node, naclEd(window.nacl) in the browser).
 *
 *   token    = seg "." base64url(sig)
 *   seg      = base64url(UTF-8 JSON payload)
 *   sig      = Ed25519 over the ASCII bytes "KPT1." + seg, by the key KEYS[payload.kid]
 *   payload  {v: 1, kid, jti, sub: callsign, dev: base64url device public key, llid: [radio IDs],
 *             feat: [feature names], net: {gw: [gateway radio IDs], ...}, iat, nbf, exp (unix s),
 *             ser?: [radio serial numbers] -- optional: the licence is bound to these radios (serialAllowed())}
 *   Unknown claims are ignored; a `ser` that isn't a list of strings is TOK_FORMAT.
 *
 * Revocation list (GET kellypage.app/api/revoked), same keys, its own prefix so it can never pass as a token:
 *   doc      = "KPV1." seg "." base64url(sig);  sig = Ed25519 over "KPV1." + seg
 *   payload  {v: 1, kid, seq (goes up with every change), at, next (fetch again after), jti: [token IDs],
 *             dev: [device keys]}
 *   verifyRevocations(doc, {ed, keys, minSeq}) -> {ok, reason, payload, stale}; reasons REV_FORMAT, REV_VERSION, REV_KID,
 *   REV_SIG, REV_OLD (seq below the last one accepted -- keep that seq and pass it as minSeq). isRevoked(payload, tok).
 *
 * KEYS are pinned HERE (and in kelly_ent.py), current and next, rotated with releases: a new signing key reaches
 * stations with a Kelly release, never over the air. The signing key itself is never in any repo.
 * verify() never throws: {ok, reason, payload}. reason codes: TOK_FORMAT, TOK_VERSION, TOK_KID, TOK_SIG, TOK_NOT_YET,
 * TOK_EXPIRED, TOK_DEVICE.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyToken = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // kid -> public key (64 hex). kp-2026a = scripts/kelly_token.py keygen, 2026-11-01 (private seed in .env, never here).
  const KEYS = {
    'kp-2026a': 'd5ecbe1d7ec4e3147164a5c0be0da490e9ab7a87248b7f270f9e6e6d3d2e7781',
  };
  const SKEW_S = 300;          // clocks this far apart still agree on nbf / exp
  const DOMAIN = 'KPT1.';

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
    s = String(s || '');
    if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
    const out = [];
    for (let i = 0; i < s.length; i += 4) {
      const c = [0, 1, 2, 3].map(k => (i + k < s.length ? B64.indexOf(s[i + k]) : 0));
      const n = c[0] << 18 | c[1] << 12 | c[2] << 6 | c[3];
      out.push(n >> 16 & 255);
      if (i + 2 < s.length) out.push(n >> 8 & 255);
      if (i + 3 < s.length) out.push(n & 255);
    }
    return Uint8Array.from(out);
  }

  // the payload without checking anything (for display of a refused token), or null
  function peek(token) {
    const parts = String(token || '').trim().split('.');
    if (parts.length !== 2) return null;
    const raw = unb64u(parts[0]);
    if (!raw) return null;
    try { const p = JSON.parse(new TextDecoder().decode(raw)); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch (e) { return null; }
  }

  // opts: {ed (adapter), keys (default KEYS), now (unix ms; the caller's clock guard), dev (this device's base64url
  // public key; null = don't check the device)}
  function verify(token, opts) {
    const o = opts || {}, keys = o.keys || KEYS;
    const parts = String(token || '').trim().split('.');
    const payload = parts.length === 2 ? peek(token) : null;
    const no = reason => ({ ok: false, reason, payload });
    if (!payload) return no('TOK_FORMAT');
    if (payload.v !== 1) return no('TOK_VERSION');
    const key = Object.prototype.hasOwnProperty.call(keys, payload.kid) ? keys[payload.kid] : null;
    if (!key || !/^[0-9a-f]{64}$/i.test(key)) return no('TOK_KID');
    const sig = unb64u(parts[1]);
    let good = false;
    try { good = !!sig && sig.length === 64 && o.ed.verify(sig, utf8(DOMAIN + parts[0]), unhex(key)); } catch (e) { good = false; }
    if (!good) return no('TOK_SIG');
    if (typeof payload.sub !== 'string' || typeof payload.dev !== 'string' || !Array.isArray(payload.feat)
      || typeof payload.exp !== 'number' || (payload.llid && !Array.isArray(payload.llid))
      || (payload.ser !== undefined && !(Array.isArray(payload.ser) && payload.ser.every(s => typeof s === 'string')))) return no('TOK_FORMAT');
    const now = (o.now != null ? o.now : Date.now()) / 1000;
    if (typeof payload.nbf === 'number' && now + SKEW_S < payload.nbf) return no('TOK_NOT_YET');
    if (now - SKEW_S >= payload.exp) return no('TOK_EXPIRED');
    if (o.dev != null && payload.dev !== o.dev) return no('TOK_DEVICE');
    return { ok: true, reason: null, payload };
  }

  // make a token (tests, and the issuing side). signer = ed.signer(seed).
  function issue(payload, signer) {
    const seg = b64u(utf8(JSON.stringify(payload)));
    return `${seg}.${b64u(signer.sign(utf8(DOMAIN + seg)))}`;
  }

  // refresh from half-life (plan 7.3: lifetime 30 days, refresh from day 15)
  function refreshDue(payload, nowMs) {
    if (!payload || typeof payload.exp !== 'number') return false;
    const start = typeof payload.iat === 'number' ? payload.iat : payload.exp - 30 * 86400;
    return (nowMs != null ? nowMs : Date.now()) / 1000 >= start + (payload.exp - start) / 2;
  }

  // the optional serial binding: true when the token has no `ser` claim, or names this radio's serial (CCDI q4)
  const normSer = s => String(s == null ? '' : s).trim().toUpperCase();
  function serialAllowed(payload, serial) {
    if (!payload || payload.ser === undefined) return true;
    if (!Array.isArray(payload.ser)) return false;
    const s = normSer(serial);
    return !!s && payload.ser.some(x => normSer(x) === s);
  }

  // ------------------------------------------------------------------ revocation list (KPV1)
  const REV_DOMAIN = 'KPV1.';
  // opts: {ed, keys (default KEYS), minSeq (the highest seq accepted before; older lists are refused), now (unix ms)}
  function verifyRevocations(doc, opts) {
    const o = opts || {}, keys = o.keys || KEYS;
    const s = String(doc || '').trim();
    const parts = s.startsWith(REV_DOMAIN) ? s.slice(REV_DOMAIN.length).split('.') : [];
    let payload = null;
    if (parts.length === 2) {
      const raw = unb64u(parts[0]);
      try { payload = raw && JSON.parse(new TextDecoder().decode(raw)); } catch (e) { payload = null; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = null;
    }
    const no = reason => ({ ok: false, reason, payload, stale: false });
    if (!payload) return no('REV_FORMAT');
    if (payload.v !== 1) return no('REV_VERSION');
    const key = Object.prototype.hasOwnProperty.call(keys, payload.kid) ? keys[payload.kid] : null;
    if (!key || !/^[0-9a-f]{64}$/i.test(key)) return no('REV_KID');
    const sig = unb64u(parts[1]);
    let good = false;
    try { good = !!sig && sig.length === 64 && o.ed.verify(sig, utf8(REV_DOMAIN + parts[0]), unhex(key)); } catch (e) { good = false; }
    if (!good) return no('REV_SIG');
    const strs = a => Array.isArray(a) && a.every(x => typeof x === 'string');
    if (!Number.isInteger(payload.seq) || typeof payload.at !== 'number' || typeof payload.next !== 'number'
      || !strs(payload.jti) || !strs(payload.dev)) return no('REV_FORMAT');
    if (o.minSeq != null && payload.seq < o.minSeq) return no('REV_OLD');
    const now = (o.now != null ? o.now : Date.now()) / 1000;
    return { ok: true, reason: null, payload, stale: now - SKEW_S > payload.next };
  }
  // is a token (its payload, or {jti, dev}) on a verified revocation list's payload?
  function isRevoked(rev, tok) {
    if (!rev || !tok) return false;
    return (!!tok.jti && (rev.jti || []).includes(tok.jti)) || (!!tok.dev && (rev.dev || []).includes(tok.dev));
  }
  // make a revocation list (tests). signer = ed.signer(seed).
  function issueRevocations(payload, signer) {
    const seg = b64u(utf8(JSON.stringify(payload)));
    return `${REV_DOMAIN}${seg}.${b64u(signer.sign(utf8(REV_DOMAIN + seg)))}`;
  }

  // ------------------------------------------------------------------ Ed25519 adapters (= js/igate-wl.js)
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

  return { KEYS, SKEW_S, DOMAIN, REV_DOMAIN, hex, unhex, b64u, unb64u, peek, verify, issue, refreshDue, serialAllowed,
    verifyRevocations, isRevoked, issueRevocations, nodeEd, naclEd };
});
