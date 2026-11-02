/* P25X Golden Packet token (docs/lora-mesh-gap-analysis.md Phase 5, section 4.3) -- format, signatures, ledger.
 *
 * ONE module in two places:
 *   gateway/gold-token.js   the gateway: mints tokens, keeps THE ledger
 *   kelly-page/js/gold-token.js                   Kelly: reads / checks tokens, builds hand-offs for its node to sign
 * The two files are IDENTICAL -- edit one, copy it over (gold-token-test.js checks they match). Pure UMD, no
 * dependencies: the Ed25519 functions come in from the host (Node's crypto: nodeEd(require('crypto')); the browser:
 * naclEd(window.nacl), vendor/tweetnacl-1.0.3). Ed25519 only, no HMAC (a secret can't sit in a free client).
 *
 * A token is one packet that moves station to station. Why the gateway is the ledger: any bit string can be copied, so
 * "non-duplicable" means the ledger accepts only the NEXT hand-off from the CURRENT holder; a second, different hand-off
 * at a seq already taken is a fork -- refused and kept as evidence.
 *
 *   MINT    (signed by the gateway's issuer key, GOLD_ISSUER_SEED in its .env)            18 B + 64 B signature
 *           'G' 0x01 0x01 | id u32 | seq u8 = 0 | holder key prefix 6 B | ts u32
 *   HANDOFF (signed by the GIVER'S MeshCore node key: companion SIGN_START/DATA/FINISH)   24 B + 64 B signature
 *           'G' 0x01 0x02 | id u32 | seq u8 (previous + 1) | from prefix 6 B | to prefix 6 B | ts u32
 * All little-endian. As text (a MeshCore DM): "GOLD " + base64url(body + signature) -- a hand-off is ~123 characters.
 * seq is a byte: a token retires after 255 hand-offs.
 *
 * Trophies (awards review 2026-10-24): every good hand-off is RECORDED (the token really moved, and the chain must stay
 * whole so the new holder can pass it on), but it earns trophies (Kelly's Holder / Pass It On) only when
 *   - both keys have a known owner: opts.ownerOf(key or 12-hex prefix) -> owner callsign or null (the gateway: its ham
 *     directory's verified entries, folded by its otherCalls table); an unknown owner -> no trophies;
 *   - the two owners differ (passing it between your own nodes earns nothing);
 *   - it isn't straight back A -> B -> A (by key or by owner) within 24 h of the previous hand-off.
 * The history entry gets trophies: true|false and why; handoff() answers {ok: true, trophies, why}. Entries recorded
 * before this rule have no `trophies` field (read as "not checked"). Without opts.ownerOf every hand-off is trophies: false.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GoldToken = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAGIC = 0x47, VERSION = 1, MINT = 1, HANDOFF = 2, SIG = 64, PREFIX = 6;
  const MINT_LEN = 18, HANDOFF_LEN = 24, PENDING_MAX = 20, FORKS_MAX = 50, PINGPONG_MS = 24 * 3600 * 1000;

  // ------------------------------------------------------------------ bytes
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = h => { const s = String(h || '').replace(/[^0-9a-f]/gi, ''); const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
  const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  const put32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = v >>> 8 & 255; b[o + 2] = v >>> 16 & 255; b[o + 3] = v >>> 24 & 255; };
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
    const t = String(s || '').replace(/[+]/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (/[^A-Za-z0-9_-]/.test(t) || t.length % 4 === 1) return null;
    const out = [];
    for (let i = 0; i < t.length; i += 4) {
      const c = [0, 1, 2, 3].map(j => (i + j < t.length ? B64.indexOf(t[i + j]) : 0));
      const n = c[0] << 18 | c[1] << 12 | c[2] << 6 | c[3];
      out.push(n >> 16 & 255); if (i + 2 < t.length) out.push(n >> 8 & 255); if (i + 3 < t.length) out.push(n & 255);
    }
    return Uint8Array.from(out);
  }
  const prefixOf = k => String(k || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, PREFIX * 2);

  // ------------------------------------------------------------------ format
  function mintBody({ id, holder, ts }) {
    const b = new Uint8Array(MINT_LEN); b[0] = MAGIC; b[1] = VERSION; b[2] = MINT; put32(b, 3, id >>> 0); b[7] = 0;
    b.set(unhex(prefixOf(holder)).subarray(0, PREFIX), 8); put32(b, 14, ts >>> 0); return b;
  }
  function handoffBody({ id, seq, from, to, ts }) {
    if (!(seq >= 1 && seq <= 255)) throw new Error('seq must be 1-255');
    const b = new Uint8Array(HANDOFF_LEN); b[0] = MAGIC; b[1] = VERSION; b[2] = HANDOFF; put32(b, 3, id >>> 0); b[7] = seq;
    b.set(unhex(prefixOf(from)).subarray(0, PREFIX), 8); b.set(unhex(prefixOf(to)).subarray(0, PREFIX), 14); put32(b, 20, ts >>> 0); return b;
  }
  const join = (body, sig) => { const o = new Uint8Array(body.length + SIG); o.set(body); o.set(sig, body.length); return o; };
  const toText = bytes => `GOLD ${b64u(bytes)}`;
  // text ("GOLD ...", anywhere in a message) or bytes -> {kind: 'mint'|'handoff', id, seq, holder | from+to, ts, body, sig} or null
  function parse(x) {
    let b = x;
    if (typeof x === 'string') { const m = /\bGOLD ([A-Za-z0-9_-]{100,140})/.exec(x); b = m ? unb64u(m[1]) : null; }
    if (!b || b.length < 3 || b[0] !== MAGIC || b[1] !== VERSION) return null;
    if (b[2] === MINT && b.length === MINT_LEN + SIG) {
      return { kind: 'mint', id: u32(b, 3), seq: b[7], holder: hex(b.subarray(8, 14)), ts: u32(b, 14), body: b.subarray(0, MINT_LEN), sig: b.subarray(MINT_LEN) };
    }
    if (b[2] === HANDOFF && b.length === HANDOFF_LEN + SIG) {
      return { kind: 'handoff', id: u32(b, 3), seq: b[7], from: hex(b.subarray(8, 14)), to: hex(b.subarray(14, 20)), ts: u32(b, 20),
        body: b.subarray(0, HANDOFF_LEN), sig: b.subarray(HANDOFF_LEN) };
    }
    return null;
  }
  function check(p, pubKey, ed) {   // p from parse(); pubKey: 32 bytes or 64 hex; ed: {verify(sig, msg, pub)}
    try { const k = typeof pubKey === 'string' ? unhex(pubKey) : pubKey; return k.length === 32 && !!ed.verify(p.sig, p.body, k); } catch { return false; }
  }

  // ------------------------------------------------------------------ Ed25519 adapters
  // Node: raw 32-byte keys wrapped in the fixed DER headers crypto.createPublicKey / createPrivateKey want
  function nodeEd(crypto) {
    const SPKI = Buffer.from('302a300506032b6570032100', 'hex'), PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
    const pub = k => crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(k)]), format: 'der', type: 'spki' });
    return {
      verify: (sig, msg, k) => crypto.verify(null, Buffer.from(msg), pub(k), Buffer.from(sig)),
      // a signer from a 32-byte seed (the gateway's issuer key): {sign(msg) -> 64 B, publicKey: 32 B}
      signer(seed) {
        const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
        const raw = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
        return { sign: msg => new Uint8Array(crypto.sign(null, Buffer.from(msg), key)), publicKey: new Uint8Array(raw) };
      },
    };
  }
  // the browser: TweetNaCl (vendor/tweetnacl-1.0.3/nacl-fast.min.js -> window.nacl)
  function naclEd(nacl) {
    return {
      verify: (sig, msg, k) => nacl.sign.detached.verify(Uint8Array.from(msg), Uint8Array.from(sig), Uint8Array.from(k)),
      signer(seed) { const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(seed)); return { sign: msg => nacl.sign.detached(Uint8Array.from(msg), kp.secretKey), publicKey: kp.publicKey }; },
    };
  }

  // ------------------------------------------------------------------ the ledger (the gateway's; pure, JSON-able)
  // data: {v, nextId, tokens: {id: {id, issuedAt, holder, holderName, seq, mint (hex), history: [...], pending: [...], forks: [...]}}}
  function Ledger(data, opts = {}) {
    const now = opts.now || (() => Date.now()), ed = opts.ed;
    const ownerOf = k => { try { const o = opts.ownerOf ? opts.ownerOf(k) : null; return o ? String(o).toUpperCase() : null; } catch { return null; } };
    // may this hand-off earn trophies? -> {trophies, why, fromOwner, toOwner}
    function judge(t, p, gk) {
      const fromOwner = ownerOf(gk), toOwner = ownerOf(p.to);
      const no = why => ({ trophies: false, why, fromOwner, toOwner });
      if (!fromOwner) return no("the giver's node isn't in the P25X ham directory");
      if (!toOwner) return no("the receiver's node isn't in the P25X ham directory");
      if (fromOwner === toOwner) return no(`both nodes are ${fromOwner}'s -- passing it to yourself earns nothing`);
      const prev = t.history.slice().reverse().find(h => h.kind === 'handoff');
      if (prev && now() - prev.at < PINGPONG_MS && (prev.from === p.to || (prev.fromOwner && prev.fromOwner === toOwner))) return no('straight back to the station that gave it within 24 h');
      return { trophies: true, why: `${fromOwner} to ${toOwner}`, fromOwner, toOwner };
    }
    const D = data && data.tokens ? data : { v: 1, nextId: 1, tokens: {} };
    const tok = id => D.tokens[String(id >>> 0)];

    function mint(holder, meta = {}, issuer) {   // issuer: {sign(msg)} -- the gateway's key
      const h = prefixOf(holder);
      if (h.length !== PREFIX * 2) throw new Error('holder: a MeshCore key prefix (12 hex digits)');
      const id = D.nextId >>> 0; D.nextId = (id + 1) >>> 0 || 1;
      const ts = Math.floor(now() / 1000), body = mintBody({ id, holder: h, ts }), bytes = join(body, issuer.sign(body));
      D.tokens[String(id)] = { id, issuedAt: now(), holder: h, holderName: meta.holderName || '', seq: 0, mint: hex(bytes), note: meta.note || '',
        history: [{ seq: 0, kind: 'mint', to: h, toName: meta.holderName || '', ts, at: now() }], pending: [], forks: [] };
      return { id, text: toText(bytes), token: D.tokens[String(id)] };
    }
    // a hand-off reported by its recipient (or anyone): the text/bytes, the GIVER's full public key, and what the
    // reporter knows about the hop (names, km, snr, hops, path). -> {ok, ...} or {ok:false, error, fork?, pending?}
    function handoff(x, giverKey, meta = {}) {
      const p = typeof x === 'object' && x && x.kind ? x : parse(x);
      if (!p || p.kind !== 'handoff') return { ok: false, error: 'not a Golden Packet hand-off' };
      const t = tok(p.id); if (!t) return { ok: false, error: `unknown token ${p.id}` };
      const gk = String(giverKey || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(gk)) return { ok: false, error: "the giver's public key (64 hex digits) is needed" };
      if (gk.slice(0, PREFIX * 2) !== p.from) return { ok: false, error: "the giver's key doesn't match the hand-off" };
      if (!ed || !check(p, gk, ed)) return { ok: false, error: 'bad signature' };
      const body = hex(p.body), sig = hex(p.sig);
      if (p.seq <= t.seq) {
        const had = t.history.find(h => h.seq === p.seq);
        if (had && had.body === body) return { ok: true, duplicate: true, trophies: had.trophies === true, why: had.why || null, token: t };
        t.forks.unshift({ seq: p.seq, from: p.from, to: p.to, ts: p.ts, at: now(), body, sig, by: meta.by || '' }); t.forks.splice(FORKS_MAX);
        return { ok: false, fork: true, error: `fork: hand-off ${p.seq} of token ${p.id} is already recorded (to ${had ? had.to : '?'})`, token: t };
      }
      if (p.seq !== t.seq + 1) {   // a later hop reached us first (towns with no gateway): keep it until the gap fills
        if (!t.pending.some(q => q.body === body)) { t.pending.push({ body, sig, key: gk, meta, at: now() }); t.pending.splice(0, Math.max(0, t.pending.length - PENDING_MAX)); }
        return { ok: false, pending: true, error: `out of order: waiting for hand-off ${t.seq + 1} (kept)`, token: t };
      }
      if (p.from !== t.holder) return { ok: false, error: `${p.from} isn't the holder (${t.holder} is)`, token: t };
      if (p.ts > now() / 1000 + 3600) return { ok: false, error: 'dated in the future (the node clock?)', token: t };
      const last = t.history[t.history.length - 1];
      if (last && p.ts + 300 < last.ts) return { ok: false, error: 'dated before the previous hand-off', token: t };
      const j = judge(t, p, gk);
      t.seq = p.seq; t.holder = p.to;
      t.history.push({ seq: p.seq, kind: 'handoff', from: p.from, to: p.to, ts: p.ts, at: now(), body, sig, giverKey: gk,
        fromName: meta.fromName || '', toName: meta.toName || '', km: meta.km ?? null, snr: meta.snr ?? null, hops: meta.hops ?? null, path: meta.path || null, by: meta.by || '',
        trophies: j.trophies, why: j.why, fromOwner: j.fromOwner, toOwner: j.toOwner });
      if (meta.toName) t.holderName = meta.toName;
      t.pending = t.pending.filter(q => q.body !== body);
      // a kept later hop may follow on now
      for (let again = true; again;) {
        again = false;
        for (const q of t.pending.slice()) {
          const qp = parse(join(unhex(q.body), unhex(q.sig)));
          if (qp && qp.seq === t.seq + 1) { const r = handoff(qp, q.key, q.meta); if (r.ok) again = true; else t.pending = t.pending.filter(z => z !== q); break; }
        }
      }
      return { ok: true, trophies: j.trophies, why: j.why, token: t };
    }
    function summary(t) {
      const hops = t.history.filter(h => h.kind === 'handoff');
      return { id: t.id, holder: t.holder, holderName: t.holderName, seq: t.seq, issuedAt: t.issuedAt, lastAt: t.history[t.history.length - 1].at,
        hops: hops.length, km: Math.round(hops.reduce((a, h) => a + (h.km || 0), 0) * 10) / 10, holders: new Set(t.history.map(h => h.to)).size,
        longestKm: hops.reduce((a, h) => Math.max(a, h.km || 0), 0), forks: t.forks.length, pending: t.pending.length, retired: t.seq >= 255,
        lastTrophies: hops.length ? hops[hops.length - 1].trophies === true : null };
    }
    return { mint, handoff, token: tok, list: () => Object.values(D.tokens).map(summary).sort((a, b) => b.lastAt - a.lastAt), summary, data: () => D };
  }

  return { VERSION, MINT_LEN, HANDOFF_LEN, SIG, mintBody, handoffBody, join, toText, parse, check, prefixOf, hex, unhex, b64u, unb64u,
    nodeEd, naclEd, Ledger };
});
