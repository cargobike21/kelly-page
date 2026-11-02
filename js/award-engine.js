/* Kelly Page -- the award engine (awards review 2026-10-24, kelly-page/AWARDS_REVIEW.md sections 3, 6 and 8;
 * unreleased). Pure UMD (browser + Node; tests/award-engine-test.js). THIS HEADER IS THE CONTRACT the award writers
 * (meshfun.js, meshpaths.js, meshgold.js) code against: one place applies the ham test, the self set, the
 * one-per-ham-per-day rule and the daily caps, so no award keeps its own.
 *
 * ---- Demo: one flag for every award writer
 *   KellyAwards.demo() -> true while ANY demo runs: ?demo, a #mesh-demo* / #hc-demo / #tr-demo address, or a
 *     registered provider -- mesh.js (the demo mesh link, the sim transport = the bridge's --mesh-sim), hc-ui.js (the Ham
 *     Contacts demo), tr-ui.js (the Trace Route demo), pj-ui.js (Packet Journey demo traffic).
 *   KellyAwards.addDemo(fn) -> off   fn() -> bool, may throw (= false)
 *   While it is true every award writer uses its throwaway profile, saves nothing, syncs nothing and sends no KF.
 *
 * ---- Engine: KellyAwards.create({ P, hamOf, now? }) -> engine
 *   P()            the profile in use (meshfun's P(): the meshQuest2 store, or the throwaway demo one); the engine's
 *                  book lives in p.aw, the self set in p.selfKeys / p.notMine
 *   hamOf(other)   -> HamStatus (KellyHamCalls.hamOf). Missing or throwing -> KellyHC.NOT_HAM: nothing scores
 *   engine.count(kind, other, how?, opts?) -> frozen {
 *       r          the HamStatus (other may also BE a HamStatus already: { ham, tier, owner, ... })
 *       counts     it is an award-worthy station for this kind: countsFor(r, 'local', { demoProfile: demo() }), not in
 *                  the self set, and (a new probable owner) within NEW_PROBABLE_DAY
 *       first      counts, and the first time ever this owner counted for this kind (badge counters: owners(kind))
 *       score      counts, the first for this owner today (UTC) for this kind, and under the kind's daily cap: give XP
 *       owner, why why = one sentence when it doesn't count / score }
 *     opts.anyStation  count infrastructure and non-hams too (Pathfinder traces: still never self); dedupe by owner,
 *                      else the key.   opts.cap  override the kind's daily cap.   opts.dry  look, don't book it
 *   engine.cap(kind, n?) -> bool   a plain daily counter with no station (received messages): true while under n
 *   engine.owners(kind) -> { owner: { first, last, n, tier, key, how } }   every owner that counted for kind
 *   engine.isSelf(key) -> bool;  engine.selfKeys() -> [key] (the active self set)
 *   engine.connected(key)  this Kelly connected to that node: it is mine (refreshes its 90 days)
 *   engine.notMine(key)    the "not mine" button: out of the self set until it is connected again
 *   engine.addSelf(fn)     extra self keys, fn() -> [key] (repeaters logged in to as admin, saved admin passwords)
 *   engine.creditKm(key, km, hops, chainKm?) -> km to credit (every km award and record): at most chainKm + 2 x END_KM
 *     when the repeaters on the path resolve to known positions (chainKm = the km between them), else END_KM x (hops + 1)
 *     (a direct node: 40 km); and a station's distance that GREW is held at the smaller value for 24 h (a moved position)
 *   KellyAwards.kmCap(km, hops, chainKm?) -> the cap alone (pure)
 *   KINDS = per-kind defaults { cap: scoring events a day } -- a kind not listed has no cap but still one per owner a day
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyAwards = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KINDS = {
    shake: { cap: 10 },          // a new Handshake: +20 XP, 10 a day
    heard: {},                   // a new ham heard
    rx: { cap: 20 },             // a received message +2 (engine.cap, no station)
    ack: {},                     // ✓✓: first per ham per day
    trace: { anyStation: true }, // once per target per day
    golden: {},                  // once per station per day
    cq: {},                      // a CQ answered: once per caller per day
    qso: {},
  };
  const NEW_PROBABLE_DAY = 3, SELF_DAYS = 90, EVER_MAX = 500, SELF_MAX = 200;
  const DAY_MS = 86400000, END_KM = 40;
  function kmCap(km, hops, chainKm) {
    if (!(km >= 0)) return null;
    const h = Number.isFinite(hops) && hops >= 0 ? hops : 0;
    const cap = Number.isFinite(chainKm) && chainKm >= 0 ? chainKm + 2 * END_KM : END_KM * (h + 1);
    return Math.min(km, cap);
  }
  const utcDay = t => new Date(t).toISOString().slice(0, 10);
  const lowKey = k => (k == null ? '' : String(k).trim().toLowerCase());
  const HCx = () => (typeof self !== 'undefined' && self.KellyHC) || (typeof globalThis !== 'undefined' && globalThis.KellyHC) || null;
  const NOT_HAM = Object.freeze({ ham: false, tier: 'none', call: null, owner: null, cls: 'unknown', self: false, src: null, why: 'Ham Contacts did not load, so nothing scores', demo: false });

  // ---------------------------------------------------------------- demo
  const providers = new Set();
  function demo() {
    try {
      const loc = typeof location !== 'undefined' ? location : null;
      if (loc) {
        if (new URLSearchParams(loc.search || '').has('demo')) return true;
        if (/^#(mesh-demo|hc-demo|tr-demo)/.test(loc.hash || '')) return true;
      }
    } catch { /* */ }
    for (const fn of providers) { try { if (fn()) return true; } catch { /* = false */ } }
    return false;
  }
  function addDemo(fn) { if (typeof fn !== 'function') return () => {}; providers.add(fn); return () => providers.delete(fn); }

  // ---------------------------------------------------------------- engine
  function create(o) {
    o = o || {};
    const now = typeof o.now === 'function' ? o.now : () => Date.now();
    const extraSelf = new Set();
    const book = () => {
      const p = o.P();
      const aw = p.aw || (p.aw = {});
      aw.known = aw.known || {}; aw.ever = aw.ever || {};
      const d = utcDay(now());
      if (!aw.today || aw.today.day !== d) aw.today = { day: d, seen: {}, n: {}, fresh: {} };
      for (const f of ['seen', 'n', 'fresh']) aw.today[f] = aw.today[f] || {};
      if (!p.selfKeys) p.selfKeys = {};
      if (!p.notMine) p.notMine = {};
      return { p, aw, t: aw.today };
    };
    function selfKeys() {
      const { p } = book(), cut = now() - SELF_DAYS * DAY_MS, out = new Set();
      for (const [k, at] of Object.entries(p.selfKeys)) if (at >= cut && !((p.notMine[k] || 0) >= at)) out.add(k);
      for (const fn of extraSelf) { try { for (const k of fn() || []) if (k) out.add(lowKey(k)); } catch { /* */ } }
      return [...out];
    }
    const isSelf = key => !!key && selfKeys().includes(lowKey(key));
    function connected(key) {
      const k = lowKey(key); if (!k) return;
      const { p } = book(); p.selfKeys[k] = now();
      const ks = Object.keys(p.selfKeys); if (ks.length > SELF_MAX) ks.sort((a, b) => p.selfKeys[a] - p.selfKeys[b]).slice(0, ks.length - SELF_MAX).forEach(x => delete p.selfKeys[x]);
    }
    function notMine(key) { const k = lowKey(key); if (!k) return; const { p } = book(); p.notMine[k] = now(); }
    function addSelf(fn) { if (typeof fn !== 'function') return () => {}; extraSelf.add(fn); return () => extraSelf.delete(fn); }
    function statusOf(other) {
      if (other && typeof other === 'object' && 'ham' in other && 'tier' in other) return other;
      try { return (o.hamOf && o.hamOf(other)) || NOT_HAM; } catch { return NOT_HAM; }
    }
    function count(kind, other, how, opts) {
      opts = opts || {};
      const def = KINDS[kind] || {}, any = opts.anyStation != null ? !!opts.anyStation : !!def.anyStation;
      const r = statusOf(other), key = lowKey(other && other.key);
      const res = (counts, first, score, owner, why) => Object.freeze({ r, counts, first, score, owner: owner || null, why: why || '' });
      const HC = HCx(), dp = demo();
      if (r.self || (key && isSelf(key))) return res(false, false, false, r.owner, 'your own station -- it never scores');
      const owner = r.owner || (any ? key || null : null);
      if (!owner) return res(false, false, false, null, r.why || 'no callsign known');
      let ok;
      if (any) ok = !r.demo || dp;
      else ok = HC && HC.countsFor ? HC.countsFor(r, 'local', { demoProfile: dp }) : !!(r.ham && !r.self && (r.tier === 'verified' || r.tier === 'probable'));
      if (!ok) return res(false, false, false, owner, r.why || 'not a licensed ham\'s own station');
      const { aw, t } = book();
      // a new owner known only by its name (probable): at most NEW_PROBABLE_DAY a day, the rest wait for tomorrow
      if (!any && r.tier === 'probable' && !aw.known[owner] && !t.fresh[owner] && Object.keys(t.fresh).length >= NEW_PROBABLE_DAY)
        return res(false, false, false, owner, `${owner} counts from tomorrow (at most ${NEW_PROBABLE_DAY} new stations a day are taken on their name alone)`);
      const ever = aw.ever[kind] || (aw.ever[kind] = {}), seen = t.seen[kind] || (t.seen[kind] = {});
      const first = !ever[owner], todayFirst = !seen[owner];
      const cap = opts.cap != null ? opts.cap : def.cap != null ? def.cap : Infinity, n = t.n[kind] || 0;
      const score = todayFirst && n < cap;
      if (opts.dry) return res(true, first, score, owner, score ? '' : todayFirst ? `the daily limit of ${cap} is reached -- it still counts for trophies` : 'already counted today');
      const tm = now();
      if (!any && !aw.known[owner]) { aw.known[owner] = tm; if (r.tier === 'probable') t.fresh[owner] = 1; }
      const e = ever[owner] || (ever[owner] = { first: tm, last: tm, n: 0, tier: r.tier, key: key || null, how: how || null });
      e.last = tm; e.n++; if (r.tier === 'verified') e.tier = 'verified'; if (key && !e.key) e.key = key;
      const es = Object.keys(ever); if (es.length > EVER_MAX) es.sort((a, b) => ever[a].last - ever[b].last).slice(0, es.length - EVER_MAX).forEach(x => delete ever[x]);
      seen[owner] = 1;
      if (score) t.n[kind] = n + 1;
      return res(true, first, score, owner, score ? '' : todayFirst ? `the daily limit of ${cap} is reached -- it still counts for trophies` : 'already counted today');
    }
    function cap(kind, n) {
      const { t } = book(), lim = n != null ? n : (KINDS[kind] || {}).cap != null ? KINDS[kind].cap : Infinity, c = t.n[kind] || 0;
      if (c >= lim) return false;
      t.n[kind] = c + 1; return true;
    }
    const owners = kind => (book().aw.ever[kind] || {});
    function creditKm(key, km, hops, chainKm) {
      let v = kmCap(km, hops, chainKm); if (v == null) return null;
      const k = lowKey(key); if (!k) return v;
      const { aw } = book(), tm = now(), pos = aw.km || (aw.km = {}), was = pos[k];
      if (!was || Math.abs(v - was.km) <= 1) { if (!was) pos[k] = { km: v, at: tm }; }
      else if (v < was.km || tm - was.at >= DAY_MS) pos[k] = { km: v, at: tm };
      else v = was.km;   // it grew less than a day ago: held at the smaller distance
      const ks = Object.keys(pos); if (ks.length > EVER_MAX) ks.sort((a, b) => pos[a].at - pos[b].at).slice(0, ks.length - EVER_MAX).forEach(x => delete pos[x]);
      return v;
    }
    return { count, cap, owners, isSelf, selfKeys, connected, notMine, addSelf, creditKm };
  }

  return { KINDS, NEW_PROBABLE_DAY, SELF_DAYS, END_KM, NOT_HAM, utcDay, kmCap, demo, addDemo, create };
});
