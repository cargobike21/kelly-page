/* Kelly Page -- this station's device identity (public release plan section 7.2, step 12).
 *
 * One Ed25519 key per device. A registration token names this key, and the gateway's auth op checks signatures by it,
 * so a token copied to another device is useless. Where the key lives:
 *   bridge   the page is served by a Kelly bridge that has one (bridge/kelly_ident.py, GET /api/ident): the key stays
 *            on the bridge, which signs for the page -- the Pi's keeper, the PC and the phone on one Pi are ONE device
 *   webcrypto  otherwise a NON-extractable WebCrypto Ed25519 key in IndexedDB "kelly-ident" (secure contexts:
 *            https, localhost, file://)
 *   nacl     where WebCrypto Ed25519 is missing (plain http, older browsers): a tweetnacl key in the same store
 *   session  no IndexedDB (private window): a key for this visit only
 * The key never goes into the config file, a backup, the support log or /api/kelly-state (it isn't in localStorage).
 * Clearing the site's data loses the browser key: that's just a new device, registered again.
 *
 * sign() signs only registration messages (PREFIXES), like the bridge, so the key can't be used for anything else.
 * window.KellyIdent = { PREFIXES, get() -> {pub, kind, fp, token?}, sign(bytes) -> Uint8Array(64), fingerprint(pub) }
 */
(function (root) {
  'use strict';
  const PREFIXES = ['P25X-AUTH|', 'P25X-POP|', 'P25X-REFRESH|'];
  const MAX_MSG = 512;
  const DB = 'kelly-ident', STORE = 'keys', ID = 'device';
  const T = () => root.KellyToken;          // js/enttoken.js: b64u helpers
  const enc = s => new TextEncoder().encode(s);

  // "ABCD-EFGH-JKMN": the first 60 bits of SHA-512(public key), Crockford base32 -- for reading out, not security
  function fingerprint(pubB64u) {
    const raw = T().unb64u(pubB64u);
    if (!raw || !root.nacl) return '';
    const h = root.nacl.hash(raw), A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let bits = 0, n = 0, out = '';
    for (let i = 0; out.length < 12; ) {
      if (n < 5) { bits = ((bits << 8) | h[i++]) & 0xFFFF; n += 8; }
      out += A[(bits >> (n - 5)) & 31]; n -= 5;
    }
    return out.match(/.{4}/g).join('-');
  }

  // ---- IndexedDB (tiny: one record)
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('no IndexedDB')); return; }
      const rq = root.indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const db = rq.result, tx = db.transaction(STORE, mode), r = fn(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(r && 'result' in r ? r.result : undefined); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }

  // ---- the bridge's identity, when this page is served by a bridge that has one
  function bridgeAddr() {
    const loc = root.location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return null;
    let tok = '';
    try { tok = new URLSearchParams(loc.search).get('token') || JSON.parse(root.localStorage.getItem(`kelly.bridgeToken:${loc.host}`) || '""') || ''; } catch (e) { tok = ''; }
    return { base: `${loc.origin}/api/ident`, tok };
  }
  async function bridgeCall(path, opts = {}) {
    const b = bridgeAddr();
    if (!b) throw new Error('not on a bridge');
    const ctl = root.AbortController ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch(b.base + path, Object.assign({ cache: 'no-store', signal: ctl && ctl.signal },
        opts, { headers: Object.assign({ 'Content-Type': 'application/json' }, b.tok ? { 'X-Kelly-Token': b.tok } : {}) }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
      return j;
    } finally { if (timer) clearTimeout(timer); }
  }

  // ---- the browser's own key
  async function browserKey() {
    let rec = null;
    try { rec = await idb('readonly', s => s.get(ID)); } catch (e) { rec = null; }
    if (rec && rec.pub) return rec;
    const subtle = root.crypto && root.crypto.subtle;
    if (subtle) {
      try {
        const kp = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);   // private half NOT extractable
        const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
        rec = { kind: 'webcrypto', priv: kp.privateKey, pub: T().b64u(pub), at: Date.now() };
      } catch (e) { rec = null; }   // no Ed25519 in this browser / not a secure context
    }
    if (!rec) {
      const kp = root.nacl.sign.keyPair();
      rec = { kind: 'nacl', seed: kp.secretKey.slice(0, 32), pub: T().b64u(kp.publicKey), at: Date.now() };
    }
    try { await idb('readwrite', s => s.put(rec, ID)); } catch (e) { rec.kind = 'session'; }
    return rec;
  }

  let current = null;    // the promise of {pub, kind, fp, token?, rec?}
  async function load() {
    try {
      const j = await bridgeCall('');
      if (j && j.pub) return { pub: j.pub, kind: 'bridge', fp: fingerprint(j.pub), token: j.token || '' };
    } catch (e) { /* no bridge, or a bridge without an identity: the browser's own key */ }
    const rec = await browserKey();
    return { pub: rec.pub, kind: rec.kind, fp: fingerprint(rec.pub), rec };
  }

  const KellyIdent = {
    PREFIXES,
    fingerprint,
    get() { if (!current) current = load().catch(e => { current = null; throw e; }); return current.then(i => ({ pub: i.pub, kind: i.kind, fp: i.fp, token: i.token })); },
    async sign(msg) {
      const m = typeof msg === 'string' ? enc(msg) : Uint8Array.from(msg);
      const head = new TextDecoder().decode(m.slice(0, 16));
      if (m.length > MAX_MSG || !PREFIXES.some(p => head.startsWith(p))) throw new Error('not a registration message');
      if (!current) this.get();
      const i = await current;
      if (i.kind === 'bridge') {
        const j = await bridgeCall('/sign', { method: 'POST', body: JSON.stringify({ msg: T().b64u(m) }) });
        return T().unb64u(j.sig);
      }
      if (i.rec.kind === 'webcrypto') return new Uint8Array(await root.crypto.subtle.sign({ name: 'Ed25519' }, i.rec.priv, m));
      return root.nacl.sign.detached(m, root.nacl.sign.keyPair.fromSeed(Uint8Array.from(i.rec.seed)).secretKey);
    },
    // the bridge keeps the station's token (when the identity is the bridge's): kelly_ident.py /api/ident/token
    bridgeToken(token) { return token ? bridgeCall('/token', { method: 'POST', body: JSON.stringify({ token }) }) : bridgeCall('/token', { method: 'DELETE' }); },
  };
  root.KellyIdent = KellyIdent;
})(window);
