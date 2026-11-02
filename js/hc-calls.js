/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts: callsign mapping (2026-10-24, unreleased). Plan: HAM_CONTACTS_PLAN.md
 * (agent 4); the API is specified in js/hc-core.js's header ("window.KellyHamCalls").
 *
 * window.KellyHamCalls -- the registry, made when this script loads (before mesh.js draws anything). Until the shell
 * calls init({ store, bus }) it reads the same localStorage key Kelly's store uses ('kelly.hcCalls'), so the chat shows
 * callsigns even before the Ham Contacts tab has been opened.
 *   Precedence: 'mine' (this user's own edits, stored as 'hcCalls', <= 500) > 'dir' (verified, self-signed directory
 *   entries, memory only: js/hc-dir.js keeps its own list and hands it over with fromDir) > 'name' (a call in the name).
 *   label(key, name) is memoised (the chat and Packet Journey call it per row per redraw); any change clears the memo.
 *   key null = a channel sender known only by its name: its name is matched (exact, case-insensitive) against the names
 *   of known mappings -- a name two mappings share with different calls matches neither.
 *   Demo: while the shell's bus says 'demo' is on, set() / fromDir() mappings are kept in memory only and dropped when
 *   the demo stops (the demo's made-up hams never land in the saved list or an export).
 *   Extras beyond the contract (private, may be ignored): fromDir(entries, { replace: true }) swaps the whole directory
 *   layer; _batch(fn) runs fn with one change notification at the end (import); _demo() -> demo on?
 *   QR (QR_REVIEW.md S2, section 5): qrClaim(key, name) / advertSeen(key) / claimOf(key) -> the claimed name | null;
 *   dirOf(key) -> { call, name, t } | null; dirKeys(call) -> [keys]; trust(key, { name, call, signed, qr }) ->
 *   { code 'dir'|'conflict'|'mine'|'signed'|'claimed'|'none', icon, call, text, info } -- the label the card preview and
 *   the contact rows show (conflict only when the directory gives THIS key another call).
 *
 * window.KellyHCCalls(mount, c) -> { destroy() } -- the "Callsigns" box (#hc-calls): every contact and heard station with
 *   its callsign and where it came from; inline edit, clear, "use the one in its name", a "no callsign yet" filter,
 *   export / import of my mappings as JSON. KellyHCCalls.exportText() / .importText(text) are the pure halves (tests).
 */
(function () {
  'use strict';
  const MAX = 500, MEMO_MAX = 4000, IMPORT_MAX_BYTES = 256 * 1024, STORE_KEY = 'hcCalls';
  const H = () => window.KellyHC || null;
  const lowKey = k => (k == null ? '' : String(k).trim().toLowerCase());
  const okKey = k => { const hc = H(); return hc ? hc.okKey(k) : /^[0-9a-f]{64}$/.test(k) && !/^0+$/.test(k); };
  const normCall = c => { const hc = H(); return hc ? hc.normCall(c) : null; };
  const FALLBACK = Object.freeze({ ham: false, tier: 'none', call: null, owner: null, cls: 'unknown', self: false, src: null, why: 'Ham Contacts did not load, so nothing scores', demo: false });
  const cleanName = n => (n == null ? '' : String(n)).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);

  // ---------------------------------------------------------------- the registry
  function makeRegistry() {
    // before init: Kelly's own store format ('kelly.' + key, JSON), every access guarded (private window, full storage)
    const lsStore = {
      get(k, d) { try { const v = window.localStorage.getItem('kelly.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
      set(k, v) { try { window.localStorage.setItem('kelly.' + k, JSON.stringify(v)); } catch { /* full / off: memory only */ } },
    };
    let store = lsStore, demoOn = false, offDemo = null, batching = 0, pendingNote = false, pendingSave = false, loadedHC = false;
    // loaded before KellyHC (odd script order): nothing validates yet, so read the saved list again once it is there
    const ensure = () => { if (!loadedHC && H()) load(); };
    const mine = new Map();   // key -> { call, name, at, demo? }   insertion order = oldest first
    const dir = new Map();    // key -> { call, name, at, demo? }
    const subs = new Set();
    let memo = new Map(), nameIdx = null;

    function load() {
      mine.clear(); loadedHC = !!H(); memo = new Map(); nameIdx = null;
      let list = null;
      try { list = store.get(STORE_KEY, []); } catch { list = []; }
      if (!Array.isArray(list)) list = [];
      const rows = [];
      for (const r of list) {
        if (!r || typeof r !== 'object') continue;
        const k = lowKey(r.k), c = normCall(r.c);
        if (!okKey(k) || !c) continue;
        rows.push({ k, call: c, name: cleanName(r.n), at: Number(r.at) || 0 });
      }
      rows.sort((a, b) => a.at - b.at);
      for (const r of rows.slice(-MAX)) { mine.delete(r.k); mine.set(r.k, { call: r.call, name: r.name, at: r.at }); }
    }
    function save() {
      if (batching) { pendingSave = true; return; }
      const out = [];
      for (const [k, x] of mine) { const v = x.demo ? x.prev : x; if (v) out.push(v.name ? { k, c: v.call, n: v.name, at: v.at } : { k, c: v.call, at: v.at }); }
      try { store.set(STORE_KEY, out); } catch { /* a throwing store: keep the mapping in memory */ }
    }
    function changed() {
      memo = new Map(); nameIdx = null;
      if (batching) { pendingNote = true; return; }
      for (const fn of [...subs]) { try { fn(); } catch (e) { try { console.warn('KellyHamCalls onChange', e); } catch { /* */ } } }
    }
    // lower-cased name -> call (or false = ambiguous), one index per source
    function buildIdx() {
      const idx = { mine: new Map(), dir: new Map() };
      for (const [src, m] of [['mine', mine], ['dir', dir]]) {
        for (const v of m.values()) {
          const n = (v.name || '').toLowerCase(); if (!n) continue;
          const t = idx[src];
          if (!t.has(n)) t.set(n, v.call); else if (t.get(n) !== v.call) t.set(n, false);
        }
      }
      return idx;
    }
    function callOf(key, name) {
      try {
        ensure();
        const k = lowKey(key);
        if (k) {
          const m = mine.get(k); if (m) return { call: m.call, src: 'mine' };
          const d = dir.get(k); if (d) return { call: d.call, src: 'dir' };
        } else {
          const n = cleanName(name).toLowerCase();
          if (n) {
            if (!nameIdx) nameIdx = buildIdx();
            const a = nameIdx.mine.get(n); if (a) return { call: a, src: 'mine' };
            const b = nameIdx.dir.get(n); if (b) return { call: b, src: 'dir' };
          }
        }
        const hc = H(), c = hc ? hc.callFromName(name) : null;
        return c ? { call: c, src: 'name' } : null;
      } catch { return null; }
    }
    function label(key, name) {
      let n = '';
      try {
        n = name == null ? '' : String(name);
        ensure();
        const mk = lowKey(key) + '\u0001' + n;
        const hit = memo.get(mk); if (hit !== undefined) return hit;
        const cs = callOf(key, n), hc = H();
        // no key (a channel sender known by name only): anyone can take a name, so a mapped call is shown unconfirmed
        let v = cs && hc ? hc.label(n, cs.call) : n;
        if (cs && !lowKey(key) && cs.src !== 'name' && v !== n) v = v.replace(`${cs.call} · `, `${cs.call}? · `);
        if (memo.size >= MEMO_MAX) memo = new Map();
        memo.set(mk, v);
        return v;
      } catch { return n; }
    }
    function set(key, call, name) {
      ensure();
      const k = lowKey(key);
      if (!H()) throw new Error('Ham Contacts did not load, so callsigns cannot be saved right now -- reload Kelly.');
      if (!okKey(k)) throw new Error('That station has no proper key (64 hex digits), so a callsign cannot be saved for it.');
      const c = normCall(call);
      if (!c) throw new Error(`"${String(call == null ? '' : call).trim().slice(0, 20)}" is not an amateur callsign -- use one like VK4ABC.`);
      const old = mine.get(k);
      if (!old && mine.size >= MAX) throw new Error(`You already have ${MAX} callsigns saved -- clear some first.`);
      const nm = name == null ? (old ? old.name : '') : cleanName(name);
      if (old && old.call === c && old.name === nm && !!old.demo === demoOn) return c;
      mine.delete(k);
      const v = { call: c, name: nm, at: Date.now() };
      if (demoOn) { v.demo = true; const prev = old ? (old.demo ? old.prev : old) : null; if (prev) v.prev = prev; }   // the real one comes back after the demo
      mine.set(k, v);
      if (!v.demo) save();
      changed();
      return c;
    }
    function clear(key) {
      ensure();
      const k = lowKey(key), had = mine.get(k);
      if (!had) return false;
      mine.delete(k);
      if (!had.demo) save();
      changed();
      return true;
    }
    function all() {
      ensure();
      const out = [];
      for (const [k, v] of mine) out.push({ key: k, call: v.call, src: 'mine', name: v.name });
      for (const [k, v] of dir) if (!mine.has(k)) out.push({ key: k, call: v.call, src: 'dir', name: v.name });
      return out.sort((a, b) => (a.call < b.call ? -1 : a.call > b.call ? 1 : 0));
    }
    // entries: verified directory entries { k, c, n, t, at, x, s }. Newest `at` per key wins; x: 1 removes it.
    function fromDir(entries, opts) {
      const hc = H(); if (!hc || !Array.isArray(entries)) return { added: 0, removed: 0 };
      let added = 0, removed = 0, touched = false;
      if (opts && opts.replace && dir.size) { removed = dir.size; dir.clear(); touched = true; }
      for (const raw of entries) {
        const e = hc.normEntry(raw); if (!e) continue;
        const old = dir.get(e.k);
        if (old && old.at > e.at) continue;
        if (e.x) { if (old) { dir.delete(e.k); removed++; touched = true; } continue; }
        if (old && old.call === e.c && old.name === e.n && old.at === e.at) continue;
        const v = { call: e.c, name: e.n, at: e.at, t: e.t };
        if (demoOn) { v.demo = true; const prev = old ? (old.demo ? old.prev : old) : null; if (prev) v.prev = prev; }
        dir.set(e.k, v);
        added++; touched = true;
      }
      if (dir.size > MAX) { [...dir.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, dir.size - MAX).forEach(([k]) => dir.delete(k)); }
      if (touched) changed();
      return { added, removed };
    }
    function dropDemo() {
      let any = false;
      for (const m of [mine, dir]) for (const [k, v] of [...m]) if (v.demo) { if (v.prev) m.set(k, v.prev); else m.delete(k); any = true; }
      if (any) changed();
    }
    function onChange(fn) { if (typeof fn !== 'function') return () => {}; subs.add(fn); return () => { subs.delete(fn); }; }
    function init(o) {
      o = o || {};
      if (o.store && typeof o.store.get === 'function' && typeof o.store.set === 'function') store = o.store;
      if (offDemo) { try { offDemo(); } catch { /* */ } offDemo = null; }
      if (o.bus && typeof o.bus.on === 'function') {
        offDemo = o.bus.on('demo', on => { const was = demoOn; demoOn = !!on; bump(); if (was && !demoOn) dropDemo(); });
      }
      sticky = null; load(); changed();
      return api;
    }
    function _batch(fn) {
      batching++;
      try { return fn(); } finally {
        batching--;
        if (!batching && pendingSave) { pendingSave = false; save(); }
        if (!batching && pendingNote) { pendingNote = false; changed(); }
      }
    }
    // this user's saved mappings as stored (a demo edit shows the real one it covers): what an export holds
    function _mine() {
      ensure();
      const out = [];
      for (const [k, x] of mine) { const v = x.demo ? x.prev : x; if (v) out.push({ key: k, call: v.call, name: v.name || '' }); }
      return out;
    }
    // ---- ham status for awards (AWARDS_REVIEW.md section 3): the evidence for HC.hamStatus, memoised
    // Sticky name calls: the first call a key had in its name, and the first key heard with a name call (store
    // 'hcSticky', <= STICKY_MAX each; never written in demo) -- a rename, or a second node taking a call, is unverified.
    const STICKY_MAX = 2000, HAM_MEMO_MAX = 2000, QR_MAX = 500;
    // QR claims ('hcQrClaim' {key: name}, <= QR_MAX): a contact added from an unsigned contact/add QR keeps that name
    // as a CLAIM until its own advert is seen (QR_REVIEW.md S2). qrClaim(key, name) after such an add; advertSeen(key)
    // when the node passes on that key's advert (signed by it).
    let qrClaims = null;
    const loadQr = () => { if (qrClaims) return qrClaims; let s = null; try { s = store.get('hcQrClaim', null); } catch { /* */ } qrClaims = (s && typeof s === 'object') ? s : {}; return qrClaims; };
    function saveQr() { const ks = Object.keys(qrClaims); if (ks.length > QR_MAX) ks.slice(0, ks.length - QR_MAX).forEach(x => delete qrClaims[x]); try { store.set('hcQrClaim', qrClaims); } catch { /* memory only */ } }
    function qrClaim(key, name) { const k = lowKey(key); if (!okKey(k) || demoOn) return; loadQr()[k] = cleanName(name); saveQr(); bump(); }
    function advertSeen(key) { const k = lowKey(key), q = loadQr(); if (q[k] == null) return; delete q[k]; saveQr(); bump(); }
    const claimOf = key => { const q = loadQr()[lowKey(key)]; return q == null ? null : q; };
    // the directory's word on ONE key (the call it lists for this key) and every key it lists under a call -- several
    // nodes per ham is normal, so another key under the same call is never a conflict
    function dirOf(key) { ensure(); const d = dir.get(lowKey(key)); return d ? { call: d.call, name: d.name, t: d.t || 0 } : null; }
    function dirKeys(call) { const c0 = normCall(call), out = []; if (!c0) return out; for (const [k, v] of dir) if (v.call === c0) out.push(k); return out; }
    // the callsign trust label (QR_REVIEW.md section 5) for a key + the call a card / name shows:
    //   o = { name, call, signed (the name came from that node's own signed advert), qr (an unsigned contact/add QR) }
    //   -> { code: 'dir'|'conflict'|'mine'|'signed'|'claimed'|'none', icon, call, text, info (an extra sentence) | null }
    // 'dir' is gateway-attested (the P25 radio ID behind the entry), not cryptographic; 'conflict' ONLY when the
    // directory lists THIS key under a different call
    function trust(key, o) {
      o = o || {};
      const k = lowKey(key), hc = H();
      try {
        ensure();
        const fromName = hc ? hc.callFromName(o.name) : null, call = normCall(o.call) || fromName;
        const d = okKey(k) ? dir.get(k) : null, m = okKey(k) ? mine.get(k) : null;
        const others = call ? dirKeys(call).filter(x => x !== k) : [];
        const info = others.length && !(d && d.call === call) ? `ℹ️ ${call} has ${others.length === 1 ? 'another node' : `${others.length} other nodes`} in the P25X directory -- one ham may run several.` : null;
        if (d && call && d.call !== call) return { code: 'conflict', icon: '⛔', call: d.call, info: null, text: `⛔ The P25X directory lists this node's key as ${d.call}, not ${call}: this is not ${call}'s node.` };
        if (d) return { code: 'dir', icon: '✅', call: d.call, info: null, text: `✅ ${d.call}: in the P25X directory (the gateway vouches for it by its P25 radio ID -- not cryptographic proof).` };
        if (m) return { code: 'mine', icon: '👤', call: m.call, info, text: `👤 ${m.call}: you set it${call && call !== m.call ? ` (the card says ${call})` : ''}.` };
        if (!call) return { code: 'none', icon: '', call: null, info: null, text: 'No callsign in its name.' };
        if (o.qr || !o.signed) return { code: 'claimed', icon: '❔', call, info, text: `❔ ${call}: claimed -- anyone can type a callsign into a QR. Ask ${call} to read you their fingerprint, or to list themselves in the P25X directory.` };
        return { code: 'signed', icon: '🖊️', call, info, text: `🖊️ ${call}: in the name its radio signed (the callsign itself is not checked).` };
      } catch { return { code: 'none', icon: '', call: null, info: null, text: '' }; }
    }
    let hk = {}, hamMemo = new Map(), hamVer = 0, sticky = null, stickyT = 0;
    const hookv = (name, d, ...a) => { try { const f = hk[name]; return typeof f === 'function' ? f(...a) : f != null ? f : d; } catch { return d; } };
    const loadSticky = () => { if (sticky) return sticky; let s = null; try { s = store.get('hcSticky', null); } catch { /* */ } sticky = { k: (s && s.k) || {}, c: (s && s.c) || {} }; return sticky; };
    function saveSticky() {
      if (stickyT) return;
      stickyT = setTimeout(() => {
        stickyT = 0;
        for (const m of ['k', 'c']) { const ks = Object.keys(sticky[m]); if (ks.length > STICKY_MAX) ks.slice(0, ks.length - STICKY_MAX).forEach(x => delete sticky[m][x]); }
        try { store.set('hcSticky', sticky); } catch { /* full: memory only */ }
      }, 1500);
    }
    function bump() { hamVer++; hamMemo = new Map(); }
    function hooks(o) { hk = Object.assign({}, hk, o || {}); bump(); return api; }
    function hamOf(x, net0) {
      const hc = H();
      if (!hc || typeof hc.hamStatus !== 'function') return FALLBACK;
      try {
        ensure();
        x = x || {};
        const key = lowKey(x.key), radio = x.radio != null && x.radio !== '' ? String(x.radio) : null;
        const net = net0 || x.net || (radio ? 'p25' : x.aprsCall ? 'aprs' : okKey(key) || x.keyless ? 'meshcore' : 'meshtastic');
        const name = cleanName(x.longName != null ? x.longName : x.name);
        const demo = demoOn || !!hookv('demo', false) || !!x.demo;
        const me = hookv('me', {}) || {};
        const type = net === 'meshcore' ? Number(x.type != null ? x.type : x.role) || 0 : null;
        const mk = [hamVer, net, key, radio, name, type, x.role, !!x.licensed, x.aprsCall, x.aprsSym, !!(x.viaMqtt || x.viaInternet), demo, !!x.keyless,
          me.call, (me.keys || []).join(','), (me.radios || []).join(',')].join('|');
        const hit = hamMemo.get(mk); if (hit) return hit;
        const ev = { net, key: key || null, name, keyless: !!x.keyless || (net === 'meshcore' && !okKey(key)), type, role: x.role, licensed: !!x.licensed,
          aprsCall: x.aprsCall, aprsSym: x.aprsSym, radio, viaInternet: !!(x.viaMqtt || x.viaInternet), demo };
        if (net === 'p25') ev.radioCall = hookv('radioCall', null, radio);
        if (net === 'meshcore' && okKey(key)) {
          const m = mine.get(key); if (m) ev.mine = m.call;
          const d = dir.get(key); if (d) ev.dir = { c: d.call, t: d.t || 0 };
          const nc = hc.callFromName(name);
          if (nc) {
            const s = loadSticky(), q = loadQr();
            ev.firstCall = s.k[key] || null; ev.firstKey = s.c[nc] || null;
            // a name only an unsigned QR gave (no advert since): unverified, and it never takes the call first
            if (q[key] != null && q[key] === name) ev.nameFrom = 'qr';
            else if (!demo && (!s.k[key] || !s.c[nc])) { if (!s.k[key]) s.k[key] = nc; if (!s.c[nc]) s.c[nc] = key; saveSticky(); }
          }
        } else if (net === 'meshcore') {
          const cs = callOf(null, name); if (cs && cs.src === 'mine') ev.mine = cs.call;
        }
        const ctx = { me, infraKeys: hookv('infraKeys', null), otherCalls: hookv('otherCalls', null), clubCalls: hookv('clubCalls', null), aliases: hookv('aliases', null), demo };
        const r = hc.hamStatus(ev, ctx);
        if (hamMemo.size >= HAM_MEMO_MAX) hamMemo = new Map();
        hamMemo.set(mk, r);
        return r;
      } catch { return FALLBACK; }
    }
    subs.add(bump);   // a mapping or directory change

    load();
    const api = { init, label, callOf, set, clear, all, fromDir, onChange, hamOf, hooks, bump, qrClaim, advertSeen, claimOf, dirOf, dirKeys, trust, _batch, _mine, _demo: () => demoOn, MAX };
    return api;
  }
  // one per page: a second load of this script keeps the first registry (its mappings and subscribers)
  if (!window.KellyHamCalls || typeof window.KellyHamCalls.label !== 'function') window.KellyHamCalls = makeRegistry();

  // ---------------------------------------------------------------- export / import (pure)
  function exportText(reg) {
    reg = reg || window.KellyHamCalls;
    const calls = reg._mine().map(m => (m.name ? { key: m.key, call: m.call, name: m.name } : { key: m.key, call: m.call }));
    return JSON.stringify({ kind: 'kelly-ham-calls', v: 1, at: new Date().toISOString(), calls }, null, 1);
  }
  // text -> { ok, added, updated, same, rejected, why: { reason: count }, error? }. Accepts our export, a bare array of
  // { key, call, name? }, or an object { key: call }.
  function importText(text, reg) {
    reg = reg || window.KellyHamCalls;
    const res = { ok: false, added: 0, updated: 0, same: 0, rejected: 0, why: {} };
    const t = String(text == null ? '' : text);
    if (t.length > IMPORT_MAX_BYTES) return Object.assign(res, { error: 'That file is too big to be a callsign list.' });
    let j;
    try { j = JSON.parse(t); } catch { return Object.assign(res, { error: 'That file is not JSON -- export a list from Kelly\'s Callsigns box first.' }); }
    let list = null;
    if (Array.isArray(j)) list = j;
    else if (j && typeof j === 'object' && Array.isArray(j.calls)) list = j.calls;
    else if (j && typeof j === 'object') list = Object.keys(j).map(key => ({ key, call: j[key] }));
    if (!list) return Object.assign(res, { error: 'That file holds no callsign list.' });
    const bad = why => { res.rejected++; res.why[why] = (res.why[why] || 0) + 1; };
    const have = new Map(reg.all().filter(m => m.src === 'mine').map(m => [m.key, m]));
    reg._batch(() => {
      for (const r of list.slice(0, 5000)) {
        if (!r || typeof r !== 'object') { bad('not a mapping'); continue; }
        const key = lowKey(r.key != null ? r.key : r.k), call = r.call != null ? r.call : r.c, name = r.name != null ? r.name : r.n;
        if (!okKey(key)) { bad('bad key'); continue; }
        const c = normCall(call);
        if (!c) { bad('bad callsign'); continue; }
        const old = have.get(key);
        if (old && old.call === c) { res.same++; continue; }
        try { reg.set(key, c, typeof name === 'string' ? name : undefined); } catch (e) { bad(/already have/.test(e.message) ? 'list full' : 'refused'); continue; }
        if (old) res.updated++; else res.added++;
        have.set(key, { key, call: c });
      }
    });
    if (list.length > 5000) { res.rejected += list.length - 5000; res.why['too many'] = list.length - 5000; }
    res.ok = true;
    return res;
  }
  function importSummary(r) {
    if (!r.ok) return r.error;
    const parts = [];
    if (r.added) parts.push(`${r.added} added`);
    if (r.updated) parts.push(`${r.updated} updated`);
    if (r.same) parts.push(`${r.same} already the same`);
    if (r.rejected) parts.push(`${r.rejected} rejected (${Object.entries(r.why).map(([w, n]) => `${w} ×${n}`).join(', ')})`);
    return parts.length ? `Import: ${parts.join(', ')}.` : 'Import: the file held no callsigns.';
  }

  // ---------------------------------------------------------------- the editor (#hc-calls)
  const SRC = { mine: ['mine', 'you set it'], dir: ['directory', 'from the P25X ham directory (signed by their own node)'], name: ['in its name', 'read from the station\'s name'] };
  const ROW_MAX = 400;

  window.KellyHCCalls = function (mount, c) {
    const reg = window.KellyHamCalls, HC = c.HC || window.KellyHC;
    const esc = c.esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
    let onlyNone = false, q = '', edit = null /* { key, value, err, focus, s0, s1 } */, rowErr = null, dirty = true, timer = null, lastAt = 0, dead = false;
    const offs = [];

    mount.innerHTML = `<div class="card hc-cs">
      <div class="card-h"><h2>🪪 Callsigns</h2><span class="tag hc-cs-count" id="hc-cs-count">–</span></div>
      <p class="hc-cs-note">Who is who: a callsign shown beside each station's name in the chat, Packet Journey, the Analyser and Trace Route.
        Yours win, then the P25X ham directory, then a call written in the station's own name.</p>
      <div class="hc-cs-tools">
        <input class="fld hc-cs-q" id="hc-cs-q" type="search" placeholder="Search name, call or key" aria-label="Search callsigns">
        <label class="hc-cs-only"><input type="checkbox" id="hc-cs-only"> No callsign yet</label>
        <span class="hc-cs-grow"></span>
        <button class="btn ghost small" id="hc-cs-export" title="Save the callsigns you set as a JSON file">⬇ Export</button>
        <button class="btn ghost small" id="hc-cs-import" title="Read callsigns from a JSON file exported by Kelly">⬆ Import</button>
        <input type="file" id="hc-cs-file" accept=".json,application/json" hidden>
      </div>
      <p class="hc-cs-msg" id="hc-cs-msg" aria-live="polite"></p>
      <div class="hc-cs-list" id="hc-cs-list"></div>
    </div>`;
    const $ = s => mount.querySelector(s);
    const listEl = $('#hc-cs-list'), msgEl = $('#hc-cs-msg');
    const note = (ok, text) => { if (!msgEl) return; msgEl.textContent = text || ''; msgEl.className = `hc-cs-msg ${ok ? 'ok' : 'bad'}`; };
    const say = r => { try { if (c.say) c.say(r); } catch { /* */ } };

    function rows() {
      const seen = new Map();
      const add = (r, where) => { if (r && r.key && !seen.has(r.key)) seen.set(r.key, { key: r.key, name: r.name || '', short: r.short || r.key.slice(0, 8), icon: r.icon || '❔', where }); };
      try { (c.svc.contacts() || []).forEach(r => add(r, 'on radio')); } catch { /* */ }
      try { (c.svc.heard() || []).forEach(r => add(r, 'heard')); } catch { /* */ }
      for (const m of reg.all()) if (m.src === 'mine' && !seen.has(m.key)) seen.set(m.key, { key: m.key, name: m.name || '', short: m.key.slice(0, 8), icon: '🪪', where: 'saved' });
      const out = [];
      for (const r of seen.values()) {
        const cs = reg.callOf(r.key, r.name), inName = HC ? HC.callFromName(r.name) : null;
        out.push(Object.assign(r, { call: cs ? cs.call : null, src: cs ? cs.src : null, inName }));
      }
      out.sort((a, b) => (!!b.call - !!a.call) || (a.call || a.name).localeCompare(b.call || b.name));
      return out;
    }

    function rowHtml(r) {
      const k = esc(r.key);
      if (edit && edit.key === r.key) {
        return `<div class="hc-cs-row editing" data-key="${k}">
          <span class="hc-cs-ic">${esc(r.icon)}</span>
          <span class="hc-cs-who"><b class="hc-cs-name">${esc(r.name || r.short)}</b><small>${esc(r.short)} · ${esc(r.where)}</small></span>
          <span class="hc-cs-edit"><input class="fld hc-cs-in" data-key="${k}" value="${esc(edit.value)}" maxlength="12" spellcheck="false" autocomplete="off"
            aria-label="Callsign for ${esc(r.name || r.short)}" placeholder="VK4ABC">
            <button class="btn primary small" data-act="save">Save</button><button class="btn ghost small" data-act="cancel">Cancel</button></span>
          ${edit.err ? `<span class="hc-cs-err">⚠️ ${esc(edit.err)}</span>` : ''}</div>`;
      }
      const s = r.src && SRC[r.src];
      const useName = r.inName && r.inName !== r.call;
      return `<div class="hc-cs-row${r.call ? '' : ' none'}" data-key="${k}">
        <span class="hc-cs-ic">${esc(r.icon)}</span>
        <span class="hc-cs-who"><b class="hc-cs-name">${esc(r.name || r.short)}</b><small>${esc(r.short)} · ${esc(r.where)}</small></span>
        <span class="hc-cs-call">${r.call ? esc(r.call) : '<i>no callsign</i>'}</span>
        <span class="tag hc-cs-src ${esc(r.src || 'none')}" title="${esc(s ? s[1] : 'nothing known yet')}">${esc(s ? s[0] : 'none')}</span>
        <span class="hc-cs-acts">
          <button class="btn ghost small" data-act="edit" title="Type a callsign for this station">✏️ ${r.call ? 'Edit' : 'Add'}</button>
          ${useName ? `<button class="btn ghost small" data-act="usename" data-call="${esc(r.inName)}" title="Use the callsign written in its name">Use ${esc(r.inName)}</button>` : ''}
          ${r.src === 'mine' ? '<button class="btn ghost small" data-act="clear" title="Forget the callsign you set">✕ Clear</button>' : ''}
        </span>
        ${rowErr && rowErr.key === r.key ? `<span class="hc-cs-err">⚠️ ${esc(rowErr.text)}</span>` : ''}</div>`;
    }

    function render() {
      if (dead) return;
      if (timer) clearTimeout(timer);
      timer = null; lastAt = Date.now(); dirty = false;
      try {
        // keep the editor's typed text, focus and caret across the redraw
        const inp = listEl.querySelector('.hc-cs-in');
        if (edit && inp) { edit.value = inp.value; edit.focus = document.activeElement === inp; edit.s0 = inp.selectionStart; edit.s1 = inp.selectionEnd; }
        const all = rows(), ql = q.toLowerCase();
        const shown = all.filter(r => (!onlyNone || !r.call || (edit && edit.key === r.key)) &&
          (!ql || r.name.toLowerCase().includes(ql) || (r.call || '').toLowerCase().includes(ql) || r.key.startsWith(ql)));
        const n = all.filter(r => r.call).length;
        const cnt = $('#hc-cs-count'); if (cnt) cnt.textContent = `${n} / ${all.length} with a call`;
        const top = listEl.scrollTop;
        listEl.innerHTML = shown.length
          ? shown.slice(0, ROW_MAX).map(rowHtml).join('') + (shown.length > ROW_MAX ? `<p class="hc-cs-more">${shown.length - ROW_MAX} more -- search to find them.</p>` : '')
          : `<p class="hc-cs-empty">${all.length ? (onlyNone ? 'Every station here has a callsign. 🎉' : 'Nothing matches that search.') : 'No contacts or heard stations yet -- connect your MeshCore node, or try the demo.'}</p>`;
        if (top) listEl.scrollTop = top;
        const ni = listEl.querySelector('.hc-cs-in');
        if (edit && ni && edit.focus) { ni.focus(); try { ni.setSelectionRange(edit.s0 ?? ni.value.length, edit.s1 ?? ni.value.length); } catch { /* */ } }
      } catch (e) { try { console.warn('Ham Contacts callsigns', e); } catch { /* */ } }
    }
    function schedule() {
      if (dead) return;
      dirty = true;
      if (!c.visible || !c.visible()) return;            // drawn when the tab is shown ('visible')
      if (timer) return;
      timer = setTimeout(render, Math.max(0, lastAt + 1000 - Date.now()));
    }
    const safeOn = (ev, fn) => { try { const off = c.bus.on(ev, p => { try { fn(p); } catch (e) { console.warn('Ham Contacts callsigns', e); } }); if (typeof off === 'function') offs.push(off); } catch { /* */ } };
    ['contacts', 'heard', 'calls', 'demo'].forEach(ev => safeOn(ev, schedule));
    safeOn('visible', v => { if (v && dirty) schedule(); });

    function nameOf(key) { const r = rows().find(x => x.key === key); return r ? r.name : undefined; }
    function save(key, value) {
      try {
        const call = reg.set(key, value, nameOf(key));
        edit = null; rowErr = null;
        say(HC ? HC.ok({ key, call }, `Saved ${call} for that station.`) : { ok: true, msg: `Saved ${call}.` });
      } catch (e) {
        if (edit && edit.key === key) { edit.err = e.message; edit.value = value; edit.focus = true; } else rowErr = { key, text: e.message };
      }
      render();
    }
    listEl.addEventListener('click', ev => {
      try {
        const b = ev.target.closest('[data-act]'); if (!b) return;
        const row = b.closest('.hc-cs-row'), key = row && row.dataset.key; if (!key) return;
        const act = b.dataset.act;
        if (act === 'edit') { const r = rows().find(x => x.key === key); edit = { key, value: (r && r.call) || '', err: null, focus: true }; rowErr = null; render(); }
        else if (act === 'cancel') { edit = null; render(); }
        else if (act === 'save') { const i = row.querySelector('.hc-cs-in'); save(key, i ? i.value : ''); }
        else if (act === 'usename') save(key, b.dataset.call);
        else if (act === 'clear') { reg.clear(key); rowErr = null; say({ ok: true, msg: 'Cleared the callsign you set for that station.' }); render(); }
      } catch (e) { console.warn('Ham Contacts callsigns', e); }
    });
    listEl.addEventListener('keydown', ev => {
      const i = ev.target.closest && ev.target.closest('.hc-cs-in'); if (!i) return;
      if (ev.key === 'Enter') { ev.preventDefault(); save(i.dataset.key, i.value); }
      else if (ev.key === 'Escape') { ev.preventDefault(); edit = null; render(); }
    });
    listEl.addEventListener('input', ev => { const i = ev.target.closest && ev.target.closest('.hc-cs-in'); if (i && edit) { edit.value = i.value; edit.err = null; } });
    $('#hc-cs-q').addEventListener('input', ev => { q = ev.target.value.trim(); render(); });
    $('#hc-cs-only').addEventListener('change', ev => { onlyNone = ev.target.checked; render(); });
    $('#hc-cs-export').addEventListener('click', () => {
      try {
        const mineN = reg.all().filter(m => m.src === 'mine').length;
        if (!mineN) return note(false, 'You haven\'t set any callsigns yet -- there is nothing to export.');
        const blob = new Blob([exportText(reg)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
        const d = new Date(), p = n => String(n).padStart(2, '0');
        a.href = url; a.download = `kelly-callsigns-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
        note(true, `Exported ${mineN} callsign${mineN === 1 ? '' : 's'}.`);
      } catch (e) { note(false, `Export failed: ${e.message}`); }
    });
    const file = $('#hc-cs-file');
    $('#hc-cs-import').addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0]; file.value = '';
      if (!f) return;
      if (f.size > IMPORT_MAX_BYTES) return note(false, 'That file is too big to be a callsign list.');
      f.text().then(t => { const r = importText(t, reg); note(r.ok && !r.rejected, importSummary(r)); render(); })
        .catch(e => note(false, `Could not read that file: ${e.message}`));
    });

    render();
    return {
      destroy() { dead = true; if (timer) clearTimeout(timer); timer = null; offs.splice(0).forEach(off => { try { off(); } catch { /* */ } }); mount.innerHTML = ''; },
      _render: render, _import: t => { const r = importText(t, reg); note(r.ok && !r.rejected, importSummary(r)); render(); return r; },   // tests
    };
  };
  window.KellyHCCalls.exportText = exportText;
  window.KellyHCCalls.importText = importText;
  window.KellyHCCalls.importSummary = importSummary;
})();
