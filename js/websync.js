/* Kelly Page -- the kellypage.app sync hub, client side (upgrade Track E, 2026-11-02, unreleased).
 * Small, DOM-free helpers; Node tests load it with require (tests/websync-test.js). Server: tools/kellypage-reg/sync.js.
 *   webOk(g)                          online and not on file:// (the Worker only answers a real https/http origin) -> bool
 *   pullIgateWl({fetch, base, accept})  GET /api/sync/igate-wl -> hands the parsed doc to accept(doc) (igateui's take():
 *                                       pinned admin keys, version only ever up, last good copy kept). Best effort: never throws.
 *   uploadIgateWl({fetch, base, doc})  POST an admin-signed doc. No token: the server checks the admin signature and only
 *                                     takes a higher version.
 *   parseKpd1(text, ed, keys)         "KPD1." + b64u({v:1, at, e:[entry..]}) + "." + sig over "KPD1."+seg, checked against the
 *                                     pinned licence key(s) (KellyToken.KEYS values) -> {ok, at, e} | {ok: false, error}.
 *                                     Each ENTRY is still checked by the caller with HC.verifyEntry (its own node's signature).
 *   pullHamdir({fetch, base, ed, keys})
 *   putHamdir({fetch, base, entry, token, sign, now})  sign(text) -> Uint8Array(64) = this station's DEVICE key
 *                                     (KellyIdent.sign): proves the caller holds the registration's key. Signs
 *                                     hdPutMessage(jti, entry, t) = "P25X-POP|hdput|<jti>|<dirBytes(entry)>|<t>".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyWebSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const BASE = 'https://kellypage.app';
  const unhex = h => { const s = String(h || ''); const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
  function unb64u(s) {
    s = String(s || '');
    if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
    try { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), ch => ch.charCodeAt(0)); } catch { return null; }
  }
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64u(b) {
    let out = '';
    for (let i = 0; i < b.length; i += 3) {
      const n = b[i] << 16 | (b[i + 1] || 0) << 8 | (b[i + 2] || 0);
      out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < b.length ? B64[n >> 6 & 63] : '') + (i + 2 < b.length ? B64[n & 63] : '');
    }
    return out;
  }
  // = hc-core.js dirBytes / sync.js dirBytes (as text)
  const dirText = e => `P25X-HDIR1|${e.k}|${e.c}|${e.n}|${e.t}|${e.at}|${e.x ? 1 : 0}`;
  const hdPutMessage = (jti, e, t) => `P25X-POP|hdput|${jti}|${dirText(e)}|${t}`;
  function tokenJti(token) {
    const seg = String(token || '').split('.')[0];
    const raw = unb64u(seg);
    try { const p = raw && JSON.parse(new TextDecoder().decode(raw)); return p && typeof p.jti === 'string' ? p.jti : null; } catch { return null; }
  }
  function webOk(g) {
    g = g || (typeof self !== 'undefined' ? self : {});
    const proto = g.location && g.location.protocol, online = g.navigator ? g.navigator.onLine !== false : true;
    return (proto === 'https:' || proto === 'http:') && online;
  }
  async function getText(o, path) {
    const f = o.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!f) return { ok: false, status: 0, error: 'no fetch' };
    try {
      const r = await f((o.base || BASE) + path, { cache: 'no-store', headers: { Accept: '*/*' } });
      if (!r.ok) return { ok: false, status: r.status, error: `kellypage.app answered ${r.status}` };
      return { ok: true, status: r.status, text: await r.text() };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
  }
  async function pullIgateWl(o) {
    const r = await getText(o, '/api/sync/igate-wl');
    if (!r.ok) return r;
    let doc; try { doc = JSON.parse(r.text); } catch { return { ok: false, status: r.status, error: 'not JSON' }; }
    try { return { ok: true, status: r.status, accepted: o.accept ? o.accept(doc) : null, doc }; } catch (e) { return { ok: false, status: r.status, error: String(e && e.message || e) }; }
  }
  async function post(o, path, body, headers) {
    const f = o.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!f) return { ok: false, error: 'no fetch' };
    try {
      const r = await f((o.base || BASE) + path, { method: 'POST', cache: 'no-store', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) });
      let j = {}; try { j = await r.json(); } catch { /* not JSON */ }
      return r.ok ? Object.assign({ ok: true, status: r.status }, j) : { ok: false, status: r.status, error: j.error || `kellypage.app answered ${r.status}` };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }
  const uploadIgateWl = o => post(o, '/api/sync/igate-wl', JSON.stringify(o.doc));
  async function putHamdir(o) {
    const jti = tokenJti(o.token);
    if (!jti) return { ok: false, error: 'no registration token' };
    if (typeof o.sign !== 'function') return { ok: false, error: 'no device key to sign with' };
    const t = Math.floor((o.now ? o.now() : Date.now()) / 1000);
    let sig;
    try { sig = await o.sign(hdPutMessage(jti, o.entry, t)); } catch (e) { return { ok: false, error: 'the device key would not sign: ' + String(e && e.message || e) }; }
    return post(o, '/api/hamdir/put', { entry: o.entry, token: o.token, t, sig_dev: b64u(sig) });
  }

  function parseKpd1(text, ed, keys) {
    const parts = String(text || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'KPD1') return { ok: false, error: 'not a KPD1 directory' };
    const sig = unb64u(parts[2]);
    if (!sig || sig.length !== 64 || !ed) return { ok: false, error: 'bad signature' };
    const msg = new TextEncoder().encode('KPD1.' + parts[1]);
    let good = false;
    for (const k of keys || []) { try { if (ed.verify(sig, msg, unhex(k))) { good = true; break; } } catch { /* next key */ } }
    if (!good) return { ok: false, error: 'the directory is not signed by the Kelly licence key' };
    const raw = unb64u(parts[1]);
    let d = null; try { d = raw && JSON.parse(new TextDecoder().decode(raw)); } catch { d = null; }
    if (!d || d.v !== 1 || !Array.isArray(d.e) || !Number.isFinite(d.at)) return { ok: false, error: 'malformed directory' };
    return { ok: true, at: d.at, e: d.e };
  }
  async function pullHamdir(o) {
    const r = await getText(o, '/api/hamdir');
    if (!r.ok) return r;
    return parseKpd1(r.text, o.ed, o.keys);
  }
  return { BASE, webOk, pullIgateWl, uploadIgateWl, parseKpd1, pullHamdir, putHamdir, hdPutMessage, tokenJti };
});
