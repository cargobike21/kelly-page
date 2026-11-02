/* Kelly Page -- awards shared between a member's Kellys (the PC and the phone) through their Kelly bridge
 * (2026-10-23). The bridge keeps a copy (bridge/kelly_state.py, GET / POST /api/kelly-state) that only ever
 * grows: a POST merges in. This file:
 *   at start, BEFORE app.js and the pages read their stores: a synchronous GET of the bridge's copy, merged into this
 *     browser's stores, so the Mesh Quest, RTTY, fire, ISS, space weather, golden packet and BLE game awards earned on
 *     the other Kelly are here when the pages load;
 *   then 5 s after start, every 60 s and when the page is hidden or closed: a POST of this Kelly's stores (only when
 *     they changed since the last one). What the other Kelly sends meanwhile arrives on the next start.
 * Also the station's details ('profile', 2026-10-24: callsign, IDs, fixed position, APRS and mesh calls -- PROFILE
 *   below), where the newest change to each field wins rather than the best value.
 * Same keys and the same merge rule as kelly_state.py; both run bridge/kelly_state_vectors.json.
 * Only on a page served by a Kelly bridge, with its token (the address's ?token=, or the one mesh.js remembers for
 * this address) or on the bridge's own machine. Not in ?demo, and not in the Pi's always-on Kelly (&keeper): that one
 * hears the mesh 24 h a day, and its counts would swamp the member's own. Nor from a #mesh-demo* / #hc-demo / #tr-demo
 * address, and no POST while KellyAwards.demo() (js/award-engine.js) says a demo runs.
 * window.KellyStateSync = { KEYS, merge, pull, push, enabled } */
(function (root) {
  'use strict';
  const KEYS = ['meshQuest', 'meshGold', 'meshQuest2', 'meshGold2', 'rttyQuest', 'fireQuest', 'issQuest', 'swQuest', 'bleGames'];
  const CAP = 500, DAY_KEYS = ['day', 'd'], MIN_KEYS = ['first', 'hops'], LOWER_BETTER = ['deep', 'rtt'];
  const LOCAL_ONLY = ['bleGames/fox'];
  const MAX_VALUE = 256 * 1024;

  const isNum = x => typeof x === 'number' && isFinite(x);
  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  // the same text for the same value whatever the key order (Python: json.dumps(sort_keys=True))
  const canon = x => Array.isArray(x) ? `[${x.map(canon).join(',')}]` : isObj(x) ? `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}` : JSON.stringify(x);
  const tkey = x => isObj(x) ? (isNum(x.t) ? x.t : isNum(x.at) ? x.at : null) : null;
  const typ = x => x === null ? 'null' : Array.isArray(x) ? 'list' : typeof x;

  function mergeList(a, b, path) {
    const all = a.concat(b);
    const idk = all.length ? ['id', 'key'].find(k => all.every(x => isObj(x) && k in x)) : undefined;
    let out = [];
    if (idk) {
      const at = new Map();
      for (const x of all) { const i = canon(x[idk]); if (at.has(i)) out[at.get(i)] = merge(out[at.get(i)], x, path.concat(String(x[idk]))); else { at.set(i, out.length); out.push(x); } }
    } else {
      const seen = new Set();
      for (const x of all) { const c = canon(x); if (!seen.has(c)) { seen.add(c); out.push(x); } }
    }
    if (out.length && out.every(x => tkey(x) !== null)) {
      const ref = a.length > 1 ? a : b, desc = ref.length > 1 && tkey(ref[0]) >= tkey(ref[ref.length - 1]);
      out.sort((x, y) => desc ? tkey(y) - tkey(x) : tkey(x) - tkey(y));
      return desc ? out.slice(0, CAP) : out.slice(-CAP);
    }
    return out.slice(-CAP);
  }

  // ---- the station's details (2026-10-24: "location, station name, all that user data should sync with the
  // phone -- it's the same user"). Not an award: the newest change to each field wins. 'profile' = {v: {field: value},
  // at: {field: ms}}, fields named by their path in kelly.settings. Left out on purpose: aprs.on and igate.on (two Kellys would
  // both beacon / gate), the mesh <-> P25 bridge switches (two bridges = every text twice), and how each device connects.
  const PROFILE = ['myCall', 'myId', 'relayId', 'callerFmt', 'aliasRule', 'lookup', 'sstvStamp',
    'aprs.lat', 'aprs.lon', 'aprs.call', 'aprs.pass', 'aprs.symbol', 'aprs.comment', 'aprs.ambiguity', 'aprs.interval', 'aprs.via',
    'mesh.aprsCall', 'mesh.hamMode', 'mesh.nearKm',
    'igate.call', 'igate.ssid', 'igate.server', 'igate.port', 'igate.filter', 'igate.statusText'];   // never igate.on (two iGates)
  function mergeProfile(a, b) {
    const v = {}, at = {}, av = a.v || {}, aa = a.at || {}, bv = b.v || {}, ba = b.at || {};
    for (const f of Object.keys(av).concat(Object.keys(bv).filter(f => !(f in av)))) {
      const useA = f in av && (!(f in bv) || (aa[f] || 0) >= (ba[f] || 0));
      v[f] = useA ? av[f] : bv[f]; at[f] = useA ? aa[f] || 0 : ba[f] || 0;
    }
    return { v, at };
  }

  // two copies of one store (or a part of one) -> one holding everything both earned (see kelly_state.py's docstring)
  function merge(a, b, path = []) {
    if (a === null || a === undefined) return b === undefined ? a : b;
    if (b === null || b === undefined) return a;
    if (path.length === 1 && path[0] === 'profile' && isObj(a) && isObj(b)) return mergeProfile(a, b);
    if (LOCAL_ONLY.includes(path.join('/'))) return a;
    const key = path.length ? path[path.length - 1] : '', parent = path.length > 1 ? path[path.length - 2] : '';
    if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
    if (isNum(a) && isNum(b)) return MIN_KEYS.includes(key) ? Math.min(a, b) : Math.max(a, b);
    if (typeof a === 'string' && typeof b === 'string') return a >= b ? a : b;
    if (Array.isArray(a) && Array.isArray(b)) return mergeList(a, b, path);
    if (!(isObj(a) && isObj(b))) return typ(a) !== typ(b) ? b : a;
    if (parent === 'recs' && isNum(a.v) && isNum(b.v)) {
      if (a.v === b.v) return (a.at || 0) <= (b.at || 0) ? a : b;   // the first to get there
      return (a.v < b.v) === LOWER_BETTER.includes(key) ? a : b;
    }
    if (parent === 'tokens') { const sa = a.seq || 0, sb = b.seq || 0; return sa > sb || (sa === sb && (a.at || 0) >= (b.at || 0)) ? a : b; }
    if (key === 'board') return (a.got || a.at || 0) >= (b.got || b.at || 0) ? a : b;
    if (key === 'streak' && 'last' in a && 'last' in b) {
      const out = Object.assign({}, String(a.last || '') >= String(b.last || '') ? a : b);
      if (isNum(a.best) || isNum(b.best)) out.best = Math.max(a.best || 0, b.best || 0);
      return out;
    }
    for (const dk of DAY_KEYS) if (typeof a[dk] === 'string' && typeof b[dk] === 'string' && a[dk] !== b[dk]) return a[dk] > b[dk] ? a : b;
    const out = {};
    for (const k of Object.keys(a).concat(Object.keys(b).filter(k => !(k in a)))) out[k] = merge(a[k], b[k], path.concat(k));
    return out;
  }

  // ---- where, and with what token
  const LS = 'kelly.';
  const lsGet = k => { try { const v = root.localStorage.getItem(LS + k); return v == null ? null : JSON.parse(v); } catch { return null; } };
  const lsSet = (k, v) => { try { root.localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch { return false; } };
  // this Kelly's profile from kelly.settings; a field changed since the last look is stamped now. First sight: 0 when
  // empty (a fresh phone never wipes the PC's callsign), else 1 (any real edit beats it). Book: kelly.profileSync.
  const getPath = (o, f) => f.split('.').reduce((x, k) => (isObj(x) ? x[k] : undefined), o);
  function setPath(o, f, val) { const ks = f.split('.'), last = ks.pop(); let x = o; for (const k of ks) { if (!isObj(x[k])) x[k] = {}; x = x[k]; } x[last] = val; }
  function localProfile() {
    const s = lsGet('settings') || {}, book = lsGet('profileSync') || {}, snap = book.snap || {}, at = book.at || {}, v = {}, outAt = {};
    let changed = false;
    for (const f of PROFILE) {
      const val = getPath(s, f); if (val === undefined) continue;
      const c = canon(val);
      if (!(f in snap)) { at[f] = val === '' || val === null ? 0 : 1; snap[f] = c; changed = true; }
      else if (snap[f] !== c) { at[f] = Date.now(); snap[f] = c; changed = true; }
      v[f] = val; outAt[f] = at[f] || 0;
    }
    if (changed) lsSet('profileSync', { snap, at });
    return { v, at: outAt };
  }
  // the merged profile into kelly.settings -- what came from the other Kelly doesn't count as changed here
  function applyProfile(p) {
    const s = lsGet('settings') || {}, book = lsGet('profileSync') || {}, got = [];
    book.snap = book.snap || {}; book.at = book.at || {};
    for (const f of Object.keys(p.v || {})) {
      if (!PROFILE.includes(f)) continue;
      const val = p.v[f];
      if (canon(getPath(s, f)) !== canon(val)) { setPath(s, f, val); got.push(f); }
      book.snap[f] = canon(val); book.at[f] = (p.at || {})[f] || 0;
    }
    if (got.length) lsSet('settings', s);
    lsSet('profileSync', book);
    return got;
  }

  function where() {
    const loc = root.location, q = new URLSearchParams(loc.search);
    if (!/^https?:$/.test(loc.protocol) || q.has('demo') || q.has('keeper') || /^#(mesh-demo|hc-demo|tr-demo)/.test(loc.hash || '')) return null;
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc.hostname);
    const tok = q.get('token') || lsGet(`bridgeToken:${loc.host}`) || '';
    if (!tok && !local) return null;
    return { base: `${loc.origin}/api/kelly-state`, tok };
  }
  const W = (() => { try { return where(); } catch { return null; } })();

  // ---- at start: the bridge's copy into this browser's stores (synchronous: the pages read their stores next)
  function pull() {
    if (!W) return { ok: false, why: 'off' };
    let remote;
    try {
      const x = new XMLHttpRequest();
      x.open('GET', W.base, false);
      if (W.tok) x.setRequestHeader('X-Kelly-Token', W.tok);
      x.send();
      if (x.status !== 200) return { ok: false, why: `HTTP ${x.status}` };
      remote = JSON.parse(x.responseText || '{}');
    } catch (e) { return { ok: false, why: e && e.name || 'error' }; }
    const got = [];
    for (const k of KEYS) {
      if (remote[k] == null) continue;
      const local = lsGet(k), m = merge(local, remote[k], [k]);
      if (canon(m) !== canon(local) && lsSet(k, m)) got.push(k);
    }
    if (isObj(remote.profile)) { const f = applyProfile(mergeProfile(localProfile(), remote.profile)); if (f.length) got.push(`profile: ${f.join(', ')}`); }
    return { ok: true, got };
  }

  // ---- this Kelly's stores to the bridge (only when they changed since the last time)
  let sent = '';
  function payload() {
    const out = {};
    for (const k of KEYS) { const v = lsGet(k); if (v != null && canon(v).length <= MAX_VALUE) out[k] = v; }
    const p = localProfile(); if (Object.keys(p.v).length) out.profile = p;
    return out;
  }
  async function push(beacon) {
    if (!W) return false;
    try { if (root.KellyAwards && root.KellyAwards.demo()) return false; } catch { /* */ }   // a demo is running: nothing of it travels
    const body = payload(), text = canon(body);
    if (!Object.keys(body).length || text === sent) return false;
    if (beacon) {
      const ok = root.navigator.sendBeacon && root.navigator.sendBeacon(`${W.base}${W.tok ? `?token=${encodeURIComponent(W.tok)}` : ''}`, new Blob([JSON.stringify(body)], { type: 'text/plain' }));
      if (ok) sent = text;
      return !!ok;
    }
    try {
      const r = await fetch(W.base, { method: 'POST', body: JSON.stringify(body), headers: Object.assign({ 'Content-Type': 'text/plain' }, W.tok ? { 'X-Kelly-Token': W.tok } : {}), cache: 'no-store' });
      if (r.ok) sent = text;
      return r.ok;
    } catch { return false; }
  }

  const res = pull();
  if (W) {
    root.setTimeout(() => push(false), 5000);
    root.setInterval(() => { if (!root.document.hidden) push(false); }, 60000);
    root.addEventListener('pagehide', () => push(true));
    root.document.addEventListener('visibilitychange', () => { if (root.document.hidden) push(true); });
  }
  root.KellyStateSync = { KEYS, PROFILE, merge, mergeProfile, canon, localProfile, pull, push, enabled: !!W, last: res };
})(typeof window !== 'undefined' ? window : globalThis);
