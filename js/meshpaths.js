/* Kelly Page -- Mesh Paths (2026-10-17): how packets find their way across the LoRa mesh, and the GOLDEN PACKET.
 *
 * Hearing a station 100 km away is one-way luck. A golden packet is the other half: a packet WE sent that reached a
 * distant station, proven by something it sent back. Kelly keeps every route it can see, draws them as a network
 * on the mesh map (hover a station = every hop its packets took, like aprs.fi), hides the local noise, and goes
 * for gold: it replies to the farthest stations along the reverse of the path they reached us by.
 *
 * Where the routes come from (MeshCore, js/meshcore.js io.route events -- checked against firmware v1.18.0):
 *   rx            every packet the radio hears, with its path: a flood packet collects one hash per repeater
 *                 (the first 1-3 bytes of the repeater's public key), first repeater first. An ADVERT says who sent
 *                 it, so its path is that station's inbound route; others only carry 1-byte src/dest hashes.
 *   advert-path   GET_ADVERT_PATH: the hops a contact's last advert took (asked for the far ones at connect).
 *   outPath       a contact's learned route TO them (contact frames), used up from the front by the repeaters.
 * Two-way proof (any one of these = the link worked both ways):
 *   ack           our DM's ACK came back (SEND_CONFIRMED, with the round trip in ms)
 *   path-updated  the node learned a route to them from their path-return -- they only send one after OUR packet
 *                 reached them (BaseChatMesh::onContactPathRecv)
 *   discovery     a path-discovery answer: our route to them AND theirs back (PUSH 0x8d)
 *   trace         MeshCore, repeaters / room servers only: a trace out to it and back (PUSH 0x89), an SNR per hop
 *   traceroute    Meshtastic: route towards + route back (mesh.js onTrace)
 * Meshtastic packets carry no path (only hop counts), so there it's traceroutes and DM ACKs.
 *
 * The GOLDEN PACKET = the Golden Handshake (kelly-page/AWARDS_REVIEW.md section 5, 2026-10-24): an ack / path-return /
 * path discovery with a licensed ham's own COMPANION (k.hamOf(node).ham, type 1, not one of ours) at 20 km+ CREDITED km
 * (k.creditKm: capped by the repeaters on the path -- see chainKmOf). Repeater / room traces and Meshtastic traceroutes
 * stay on the path map and the two-way list but never score gold. Every contact-proven two-way (ack, message, reverse,
 * path-return, discover) is also a Handshake proof: k.mutual({key, num, name, type, how, at}) -- meshfun decides.
 * Demo (k.awardsDemo() / k.isDemo()): routes and two-ways go to a session-only list, never into meshPaths.<dev>.
 *
 * Going for gold (MeshCore, ham companions only, user-initiated), in the order the user picked (Golden packets > Go for gold):
 *   reverse  set the contact's route to the REVERSE of the path its packets reached us by (setPath), send a short
 *             DM, wait for the ACK -- this is the golden packet as the author defined it. No ACK: the old route is put back.
 *   discover  path discovery (no message in anyone's inbox) -- only nodes that allow telemetry answer
 *   message   forget the route, send the DM by flood; the ACK + path-return give both routes
 * One try per station per 10 min, 6 an hour, path discovery inside the Trace Route tab's airtime budget (k.claimAir):
 * the mesh is shared airtime. The DM text is the user's (editable).
 *
 * Hash -> station: a hash can match several repeaters (1 byte = 256 values). resolve() picks, along the whole path,
 * the candidates that make the shortest believable chain (Viterbi over km, hops over 120 km cost extra); a hash
 * that matches nobody is a "ghost" placed between its neighbours.
 *
 * window.KellyMeshPaths(k) -> { route, node, text, trace, ack, render, hover, init, showGolden, online }; k from mesh.js.
 */
(function () {
  'use strict';
  const HOP_KM_MAX = 120;          // a LoRa hop longer than this is suspect: costs extra in resolve()
  const TRY_GAP = 10 * 60000, TRY_HOUR = 6, WAIT_MIN = 25000;
  const MEDAL = ['🥇', '🥈', '🥉'];
  const HOW = { reverse: 'reverse path', discover: 'path discovery', message: 'message + ACK', ack: 'message + ACK', 'path-return': 'path return', trace: 'trace', traceroute: 'traceroute' };

  window.KellyMeshPaths = function (k) {
    const { $, esc, store, toast, addEvent, dirty, ms } = k;
    const ps = ms.paths = Object.assign({ show: true, minKm: 20, win: 168, backbone: false, goldKm: 20, chain: 'reverse,discover,message',
      text: 'Golden packet test de {call} via Kelly, {km} km -- no reply needed. 73' }, ms.paths || {});
    const sk = () => `meshPaths.${k.devKey()}`;
    // B7: in demo D is a session-only book (R stays the saved one, untouched); only R is ever written to the store
    const isDemo = () => { try { if (k.awardsDemo && k.awardsDemo()) return true; } catch { /* */ } try { return !!(k.isDemo && k.isDemo()); } catch { return false; } };
    const blank = () => ({ st: {}, seqs: [], golds: [], tries: [] });
    let R = load(), dev = k.devKey(), inDemo = isDemo(), D = inDemo ? blank() : R;
    function load() { const d = store.get(`meshPaths.${k.devKey()}`, null) || {}; return { st: d.st || {}, seqs: d.seqs || [], golds: d.golds || [], tries: d.tries || [] }; }
    const saveSoon = (() => { let t; return () => { clearTimeout(t); if (D !== R) return; t = setTimeout(() => { if (D === R && !isDemo()) store.set(sk(), R); }, 2000); }; })();
    function ensureDev() {
      const dm = isDemo();
      if (dm !== inDemo) { inDemo = dm; D = dm ? blank() : R; ui.sig = ''; ui.attempt = null; ui.last = null; ui.fresh = null; ver++; }
      if (k.devKey() !== dev) { if (!inDemo) store.set(`meshPaths.${dev}`, R); dev = k.devKey(); R = load(); D = inDemo ? blank() : R; ui.sig = ''; }
    }
    const ui = { tab: 'gold', sig: '', hover: null, attempt: null, rxBuf: [], showing: null, fresh: null };
    let ver = 0;   // bumps on every change: the map redraws only then
    const bump = () => { ver++; saveSoon(); dirty('mesh'); };
    const S = num => D.st[num >>> 0] || (D.st[num >>> 0] = { inb: [], out: null, two: [] });
    const node = num => k.node(num);
    const pos = n => n && n.lat != null && n.lon != null ? { lat: n.lat, lon: n.lon } : null;
    const kmTo = n => { const a = k.myPos(), b = pos(n); return a && b ? k.distKm(a, b) : null; };
    const fmtKm = v => v == null ? '?' : v >= 100 ? v.toFixed(0) : v.toFixed(1);
    const myHash = sz => { const m = node(k.myNum()); return m && m.key ? m.key.slice(0, sz * 2) : null; };

    // ------------------------------------------------------------------ hash -> station
    // candidates for a hash: nodes whose key starts with it; repeaters / room servers first (companions don't forward)
    function candidates(h) {
      const all = [], fwd = [];
      for (const n of k.nodes()) if (n.key && n.key.startsWith(h) && n.num !== k.myNum()) { all.push(n); if (n.role === 2 || n.role === 3) fwd.push(n); }
      return fwd.length ? fwd : all;
    }
    // a ghost (no station has that hash) costs a full long hop on each side, so it only wins when every real candidate
    // would mean an impossible hop; a real one with no position is in between
    const legCost = (a, b) => {
      const pa = a && a.p, pb = b && b.p;
      if (!pa || !pb) return a && a.ghost || b && b.ghost ? HOP_KM_MAX : HOP_KM_MAX / 2;
      const d = k.distKm(pa, pb); return d + (d > HOP_KM_MAX ? (d - HOP_KM_MAX) * 6 : 0);
    };
    // A hop list between two fixed ends -> [{num?, name, p, ghost, hash}] (ends excluded). path: {sz, h} or {nums}
    const resCache = new Map();
    function resolve(path, from, to) {
      if (!path) return [];
      if (path.nums) return path.nums.map(num => { const n = node(num); return { num, name: n ? k.nodeName(num) : `!${(num >>> 0).toString(16)}`, p: pos(n), ghost: !n }; });
      const key = `${path.h.join('.')}|${from && from.num}|${to && to.num}|${k.nodesVer()}`;
      if (resCache.has(key)) return resCache.get(key);
      const layers = path.h.map(h => {
        const c = candidates(h).map(n => ({ num: n.num, name: k.nodeName(n.num), p: pos(n), hash: h }));
        c.push({ name: `?${h}`, p: null, ghost: true, hash: h });
        return c;
      });
      // Viterbi: cheapest chain from -> layers -> to
      let prev = [{ s: from, cost: 0, back: null }];
      for (const L of layers) prev = L.map(s => { let best = null; for (const q of prev) { const c = q.cost + legCost(q.s, s); if (!best || c < best.cost) best = { s, cost: c, back: q }; } return best; });
      let end = null; for (const q of prev) { const c = q.cost + legCost(q.s, to); if (!end || c < end.cost) end = { cost: c, back: q }; }
      const out = []; for (let q = end.back; q && q.back; q = q.back) out.unshift({ ...q.s });
      // ghosts sit between their nearest placed neighbours
      const pts = [from && from.p, ...out.map(x => x.p), to && to.p];
      for (let i = 0; i < out.length; i++) {
        if (out[i].p) continue;
        let a = i, b = i + 2; while (a > 0 && !pts[a]) a--; while (b < pts.length - 1 && !pts[b]) b++;
        if (pts[a] && pts[b]) { const f = (i + 1 - a) / (b - a); out[i].p = { lat: pts[a].lat + (pts[b].lat - pts[a].lat) * f, lon: pts[a].lon + (pts[b].lon - pts[a].lon) * f }; out[i].placed = true; pts[i + 1] = out[i].p; }
      }
      if (resCache.size > 600) resCache.clear();
      resCache.set(key, out);
      return out;
    }
    const end = num => { const n = node(num); return { num, name: n ? k.nodeName(num) : '?', p: pos(n) }; };
    const meEnd = () => ({ num: k.myNum(), name: 'you', p: k.myPos() });
    // the whole chain: inbound = them -> hops -> me, outbound = me -> hops -> them
    const chainIn = (num, path) => { const a = end(num), b = meEnd(); return [a, ...resolve(path, a, b), b]; };
    const chainOut = (num, path) => { const a = meEnd(), b = end(num); return [a, ...resolve(path, a, b), b]; };
    const pathKm = ch => { let s = 0; for (let i = 1; i < ch.length; i++) if (ch[i - 1].p && ch[i].p) s += k.distKm(ch[i - 1].p, ch[i].p); return s; };
    const hopsOf = path => path ? (path.nums ? path.nums.length : path.h.length) : null;
    const rev = path => path && (path.nums ? { nums: [...path.nums].reverse() } : { sz: path.sz, h: [...path.h].reverse() });

    // ------------------------------------------------------------------ ingest
    function addInbound(num, path, via, snr) {
      if (!path || num == null) return;
      const s = S(num), sig = path.nums ? path.nums.join('.') : path.h.join('.');
      let r = s.inb.find(x => x.sig === sig);
      if (r) { r.n++; r.t = Date.now(); if (snr != null) r.snr = snr; r.via = via; }
      else { s.inb.unshift(r = { sig, ...(path.nums ? { nums: path.nums } : { sz: path.sz, h: path.h }), via, t: Date.now(), n: 1, snr }); s.inb.splice(6); }
      s.inb.sort((a, b) => b.t - a.t);
      bump();
    }
    // every flood path, sender known or not: the repeater backbone (newest 500 distinct)
    function addSeq(path, from, snr) {
      const sig = `${from || ''}|${path.h.join('.')}`;
      let q = D.seqs.find(x => x.sig === sig);
      if (q) { q.n++; q.t = Date.now(); } else { D.seqs.unshift({ sig, from: from || null, sz: path.sz, h: path.h, t: Date.now(), n: 1, snr }); if (D.seqs.length > 500) D.seqs.length = 500; }
    }
    function route(e) {
      ensureDev();
      if (e.kind === 'rx') {
        const p = e.pkt, a = ui.attempt;
        if (p.route !== 'flood') return;
        if (p.advert) { k.noteAdvert(Object.assign({}, p.advert, { snr: e.snr, rssi: e.rssi, path: p.path, hops: p.route === 'flood' ? hopsOf(p.path) : null })); addSeq(p.path, p.advert.num, e.snr); addInbound(p.advert.num, p.path, 'advert', e.snr); return; }
        addSeq(p.path, null, e.snr);
        // their reply on its way back to us: the ACK of our DM, or the path-return / response packet carrying it
        const mine = myHash(1);
        if (a && Date.now() - a.at < 120000 && ((p.ack && p.ack === a.ack) || (p.dest && p.dest === mine && a.key && a.key.startsWith(p.src)))) a.back = { sz: p.path.sz, h: p.path.h, snr: e.snr };
        else if (p.dest && mine && p.dest === mine && p.src) {   // a DM / request / path to us: the sender if only one contact has that hash
          const c = [...k.nodes()].filter(n => n.key && n.key.startsWith(p.src));
          if (c.length === 1) addInbound(c[0].num, p.path, 'message', e.snr);
        }
        if (p.ch) { ui.rxBuf.push({ t: Date.now(), path: p.path, snr: e.snr }); ui.rxBuf = ui.rxBuf.filter(x => Date.now() - x.t < 8000); }
        ver++;
        return;
      }
      if (e.kind === 'advert') { askAdvertPath(e.num, e.key); return; }
      if (e.kind === 'sent') { const a = ui.attempt; if (a && a.num === e.num && a.stage !== 'discover') { a.ack = e.ack; a.sentFlood = e.flood; a.timeout = e.timeout; } return; }
      if (e.kind === 'ack') { const num = e.ref && e.ref.to; if (num == null) return; const a = ui.attempt && ui.attempt.num === num ? ui.attempt : null; twoWay(num, a ? a.stage : 'ack', { rtt: e.rtt, out: a && a.stage === 'reverse' ? a.used : null, back: a && a.back }); if (a) finish(a, true); return; }
      if (e.kind === 'noack') { const a = ui.attempt; if (a && e.ref && e.ref.to === a.num) stageFailed(a, 'no ACK'); return; }
      if (e.kind === 'path-updated') { S(e.num).pathAt = Date.now(); const a = ui.attempt; if (!a || a.num !== e.num) twoWay(e.num, 'path-return', {}); return; }
      if (e.kind === 'discovery') {
        const n = [...k.nodes()].find(x => x.key && x.key.startsWith(e.prefix)); if (!n) return;
        const a = ui.attempt && ui.attempt.num === n.num ? ui.attempt : null;
        S(n.num).out = { ...e.out, t: Date.now() };
        if (e.back) addInbound(n.num, e.back, 'discovery');
        twoWay(n.num, 'discover', { out: e.out, back: e.back, rtt: e.rtt });
        if (a) finish(a, true);
      }
    }
    // a contact frame: its learned route TO them
    function nodeUpdate(n) {
      ensureDev();
      if (!n || !n.outPath) return;
      const s = S(n.num), sig = n.outPath.h.join('.');
      if (!s.out || s.out.h.join('.') !== sig) { s.out = { sz: n.outPath.sz, h: n.outPath.h, t: Date.now() }; bump(); }
      // a two-way by flood (ACK / path-return): the node re-reads the contact just after, with the route it learned
      const g = D.golds.find(x => x.num === n.num && ['message', 'ack', 'path-return'].includes(x.how) && Date.now() - x.t < 60000);
      if (g) { g.out = { sz: n.outPath.sz, h: n.outPath.h }; bump(); }
    }
    // a channel text: the flood packet heard just before it (same hop count) was its route
    function text(m) {
      if (!m || m.dm || m.hops == null || m.from == null) return;
      const c = ui.rxBuf.filter(x => x.path.h.length === m.hops && Date.now() - x.t < 6000);
      if (c.length) { addInbound(m.from, c[c.length - 1].path, 'channel', c[c.length - 1].snr); ui.rxBuf = ui.rxBuf.filter(x => x !== c[c.length - 1]); }
    }
    // Meshtastic traceroute: towards [me .. them], back [them .. me]
    function trace(tr) {
      if (!tr || !tr.towards || !tr.back) return;
      ensureDev();
      const out = { nums: tr.towards.slice(1, -1) }, back = { nums: tr.back.slice(1, -1) };
      S(tr.to).out = { ...out, t: Date.now() }; addInbound(tr.to, back, 'traceroute');
      twoWay(tr.to, 'traceroute', { out, back, rtt: tr.done - tr.at });
      if (ui.attempt && ui.attempt.num === tr.to) finish(ui.attempt, true);
    }
    // Meshtastic DM ACK from the destination itself
    function ack(msg) { if (msg && !k.isDriver() && msg.state === 'delivered' && msg.to != null) twoWay(msg.to, 'ack', {}); }

    // ------------------------------------------------------------------ advert paths (read-only, from the node)
    const apQ = [], apAsked = new Map();
    function askAdvertPath(num, key) {
      const s = k.session(); if (!s || !s.advertPath || !key) return;
      if (Date.now() - (apAsked.get(num) || 0) < 60000) return;
      apAsked.set(num, Date.now()); apQ.push({ num, key }); pumpAp();
    }
    let apBusy = false;
    async function pumpAp() {
      if (apBusy) return; apBusy = true;
      while (apQ.length) {
        const q = apQ.shift(), s = k.session(); if (!s) break;
        const r = await s.advertPath(q.key);
        if (r && r.path) addInbound(q.num, r.path, 'advert');
        await new Promise(res => setTimeout(res, 350));
      }
      apBusy = false;
    }
    // at connect: the far stations' advert routes, farthest first
    function online() {
      ensureDev(); if (!k.caps().paths) return;
      const far = [...k.nodes()].filter(n => n.key && n.num !== k.myNum()).map(n => ({ n, km: kmTo(n) })).filter(x => x.km != null).sort((a, b) => b.km - a.km).slice(0, 40);
      for (const { n } of far) askAdvertPath(n.num, n.key);
    }

    // ------------------------------------------------------------------ awards (AWARDS_REVIEW.md section 5; js/award-engine.js)
    const AW = () => window.KellyAwards || null;
    const NOT_HAM = () => (AW() && AW().NOT_HAM) || { ham: false, tier: 'none', call: null, owner: null, cls: 'unknown', self: false, src: null, why: 'Ham Contacts did not load, so nothing scores', demo: false };
    const hamOf = n => { try { return (k.hamOf && k.hamOf(n)) || NOT_HAM(); } catch { return NOT_HAM(); } };
    const typeOf = n => Number(n && (n.type != null ? n.type : n.role)) || 0;
    const selfKey = key => { try { return !!(key && k.isSelf && k.isSelf(key)); } catch { return false; } };
    // a licensed ham's own companion (type 1), not one of ours: the only station a Golden Handshake can be with
    const hamCompanion = (n, hs) => !!(n && n.key && typeOf(n) === 1 && hs && hs.ham && !hs.self && !selfKey(n.key));
    const MUTUAL = new Set(['ack', 'message', 'reverse', 'path-return', 'discover']);   // proofs that need both ends as contacts
    const GOLD_KM = () => Math.max(20, Number(ps.goldKm) || 20);
    const STAGES = ['reverse', 'discover', 'message'];
    // the km between the repeaters on a path, when EVERY hop is a 2/3-byte hash (or a Meshtastic node number) that matches
    // exactly one repeater / room server with a known (advertised) position; else undefined -- the cap is then 40 km a hop
    function chainKmOf(path) {
      if (!path) return undefined;
      const fwd = n => !!(n && (n.role === 2 || n.role === 3) && pos(n) && n.num !== k.myNum());
      let pts;
      if (path.nums) pts = path.nums.map(num => { const n = node(num); return fwd(n) ? pos(n) : null; });
      else {
        if (!(path.sz >= 2) || !Array.isArray(path.h)) return undefined;
        const ns = [...k.nodes()].filter(n => n.key && fwd(n));
        pts = path.h.map(h => { const c = ns.filter(n => String(n.key).toLowerCase().startsWith(String(h).toLowerCase())); return c.length === 1 ? pos(c[0]) : null; });
      }
      if (!pts.length || pts.some(p => !p)) return undefined;
      let s = 0; for (let i = 1; i < pts.length; i++) s += k.distKm(pts[i - 1], pts[i]);
      return s;
    }
    // credited km for every km award (k.creditKm -> meshfun's engine; KellyAwards.kmCap until that's wired): the tighter
    // of the routes we know (a resolved repeater chain first, else the fewest hops)
    function credited(n, km, g) {
      if (km == null) return null;
      const opts = [g.back, g.out].filter(Boolean).map(p => ({ hops: hopsOf(p) || 0, ck: chainKmOf(p) }));
      const r = opts.filter(x => x.ck !== undefined).sort((a, b) => a.ck - b.ck)[0] || opts.sort((a, b) => a.hops - b.hops)[0] || { hops: 0, ck: undefined };
      try { const v = k.creditKm ? k.creditKm(n.key, km, r.hops, r.ck) : undefined; if (typeof v === 'number' && Number.isFinite(v)) return v; } catch { /* the cap below */ }
      const A = AW(); return A && A.kmCap ? A.kmCap(km, r.hops, r.ck) : Math.min(km, 40 * (r.hops + 1));
    }

    // ------------------------------------------------------------------ two-way + golden
    function twoWay(num, how, info) {
      ensureDev();
      const n = node(num); if (!n || num === k.myNum()) return;
      const km = kmTo(n), mp = k.myPos(), s = S(num), now = Date.now(), hs = hamOf(n);
      s.two.unshift({ t: now, how, rtt: info.rtt || null }); s.two.splice(10);
      if (info.out && !info.out.nums && !s.out) s.out = { ...info.out, t: now };
      const g = { id: `${num}:${now}`, num, name: k.nodeName(num), ham: !!hs.ham, call: hs.call || null, t: now, km, how, rtt: info.rtt || null, snr: info.snr != null ? info.snr : null, dev: k.devLabel(),
        out: info.out || (s.out ? { ...s.out } : null), back: info.back || (s.inb[0] ? { ...s.inb[0] } : null),
        them: pos(n), me: mp ? { lat: mp.lat, lon: mp.lon } : null };
      for (const x of ['out', 'back']) if (g[x]) { delete g[x].t; delete g[x].n; delete g[x].sig; delete g[x].via; }
      // a Handshake proof (both ends are contacts): meshfun scores it -- hams only, once a day
      if (n.key && MUTUAL.has(how) && k.mutual) { try { k.mutual({ key: n.key, num, name: g.name, type: typeOf(n), how, at: now }); } catch { /* never breaks the mesh */ } }
      // the Golden Handshake: a contact-proven two-way with a ham's companion at 20 km+ CREDITED (no "new best" rule: B3)
      const canGold = MUTUAL.has(how) && k.isDriver() && hamCompanion(n, hs);
      const ckm = canGold ? credited(n, km, g) : null, golden = ckm != null && ckm >= GOLD_KM();
      g.ckm = ckm; g.gold = golden;
      if (ui.attempt && ui.attempt.num === num) { ui.attempt.gold = golden; ui.attempt.ckm = ckm; }
      // one record per station per hour (the best of them; once golden it stays golden)
      const old = D.golds.find(x => x.num === num && now - x.t < 3600000);
      if (old) { const was = !!old.gold; if ((km || 0) >= (old.km || 0)) Object.assign(old, g, { id: old.id }); old.gold = was || golden; }
      else D.golds.unshift(g);
      D.golds.sort((a, b) => (b.km || 0) - (a.km || 0) || b.t - a.t); D.golds.splice(200);
      addEvent('network', `Mesh two-way with ${g.name}${km != null ? ` (${fmtKm(km)} km)` : ''} by ${HOW[how] || how}${golden ? ' -- GOLDEN HANDSHAKE' : ''}`);
      k.F('twoWay', { ...g, key: n.key || null, ham: hs });
      if (golden) k.F('golden', { ...g, key: n.key, km: ckm, rawKm: km, ham: hs });
      if (golden) { const id = (old || g).id; ui.fresh = id; setTimeout(() => { if (ui.fresh === id) ui.fresh = null; dirty('mesh'); }, 6000); k.sfx('ack'); }
      bump();
      return g;
    }

    // ------------------------------------------------------------------ go for gold
    const chain = () => { const c = String(ps.chain || 'reverse,discover,message').split(',').filter(x => STAGES.includes(x)); return c.length ? c : STAGES.slice(); };
    // why this station can't be gone for gold, or null (MeshCore, a ham's companion with a key)
    function goldWhy(n, hs) {
      if (!k.isDriver()) return 'Go for gold is MeshCore only: a Golden Handshake is a DM ACK, path return or path discovery with a ham\'s companion';
      if (!n || !n.key) return 'Only heard by name on a channel -- Kelly needs its advert';
      if (typeOf(n) === 2 || typeOf(n) === 3) return 'A repeater or room server never makes a golden packet -- it stays on the path map';
      if (typeOf(n) !== 1) return 'Not a companion node';
      if (hs.self || selfKey(n.key)) return 'That\'s one of your own nodes -- it never scores';
      if (!hs.ham) return hs.why || 'Not known as a licensed ham\'s station yet (Ham Contacts > Callsigns)';
      return null;
    }
    function canTry(num) {
      const t = D.tries.filter(x => Date.now() - x.t < 3600000);
      if (ui.attempt) return 'one attempt at a time';
      if (t.filter(x => x.num === num && Date.now() - x.t < TRY_GAP).length) return 'tried in the last 10 min -- give the mesh a rest';
      if (t.length >= TRY_HOUR) return `${TRY_HOUR} attempts an hour is the limit (shared airtime)`;
      return null;
    }
    async function goForGold(num) {
      ensureDev();
      const n = node(num); if (!n) return;
      const no = goldWhy(n, hamOf(n)); if (no) { toast('🥇', `Not a golden packet: ${k.nodeName(num)}`, no, 'bad'); return; }
      const why = canTry(num); if (why) { toast('🥇', 'Not now', why, 'bad'); return; }
      if (!k.online()) { toast('📡', 'Connect your LoRa node first', '', 'bad'); return; }
      const stages = chain();
      D.tries.unshift({ num, t: Date.now() }); D.tries.splice(50);
      const a = ui.attempt = { num, key: n.key, km: kmTo(n), stages, i: -1, at: Date.now(), log: [], oldPath: n.outPath || null };
      say(a, `Going for gold: ${k.nodeName(num)}, ${fmtKm(a.km)} km away`);
      k.sfx('tx'); nextStage(a);
    }
    function say(a, line) { a.log.push({ t: Date.now(), line }); dirty('mesh'); }
    async function nextStage(a) {
      if (ui.attempt !== a) return;
      a.i++; a.back = null; a.ack = null;
      const stage = a.stage = a.stages[a.i];
      if (!stage) { finish(a, false); return; }
      const n = node(a.num), s = k.session();
      try {
        const why = stage === 'discover' && k.claimAir ? k.claimAir(n.key, stage) : null;   // the Trace Route tab's airtime budget
        if (why) { say(a, `Path discovery skipped: ${why}`); return nextStage(a); }
        if (stage === 'reverse') {
          const inb = S(a.num).inb.find(x => x.h);
          if (!inb) { say(a, 'Reverse path: no inbound route seen yet -- skipped'); return nextStage(a); }
          const q = k.route2 ? k.route2(rev(inb)) : { route: rev(inb) };   // never set a guessed 1-byte route on the contact
          if (q.reason) { say(a, `Reverse path skipped: ${q.reason}`); return nextStage(a); }
          a.used = q.route;
          say(a, `Reverse path: ${a.used.h.length ? a.used.h.length + ' hop' + (a.used.h.length === 1 ? '' : 's') + ' back the way it came' : 'direct, no repeaters'} -- sending the golden packet`);
          await s.setPath(n, a.used);
          a.restore = true;
          await dm(a);
        } else if (stage === 'discover') {
          say(a, 'Path discovery: asking for both routes (no message in their inbox)');
          const r = await s.discover(n);
          wait(a, Math.max(WAIT_MIN, (r.timeout || 0) * 1.5), 'no answer (it may not allow telemetry)');
        } else if (stage === 'message') {
          if (a.restore) { await restorePath(a); }
          say(a, 'Message by flood: the mesh finds the way, the ACK proves it');
          await s.setPath(n, null);
          a.restore = true;   // put the learned route back if this fails too
          await dm(a);
        }
      } catch (e) { stageFailed(a, e.message); }
    }
    // the golden packet itself: a DM; the driver's own ACK timer (or ours, if it set none) ends the stage
    async function dm(a) {
      const st0 = a.stage, msg = await k.sendDm(a.num, goldText(a));
      if (!msg) throw new Error('the node would not send it');
      wait(a, 75000, 'no ACK');
      return st0;
    }
    function wait(a, ms_, why) { const st0 = a.stage; setTimeout(() => { if (ui.attempt === a && a.stage === st0) stageFailed(a, why); }, ms_); }
    async function restorePath(a) {
      a.restore = false;
      try { await k.session().setPath(node(a.num), a.oldPath); } catch {}
    }
    async function stageFailed(a, why) {
      if (ui.attempt !== a) return;
      say(a, `${HOW[a.stage] || a.stage}: ${why}`);
      if (a.restore && (a.stage === 'reverse' || a.i + 1 >= a.stages.length)) await restorePath(a);
      nextStage(a);
    }
    function finish(a, ok) {
      if (ui.attempt !== a) return;
      ui.attempt = null; a.done = Date.now(); a.ok = ok;
      if (ok) { say(a, a.gold ? `🥇 Golden Handshake confirmed by ${HOW[a.stage] || a.stage}` : `🤝 Two-way confirmed by ${HOW[a.stage] || a.stage}${a.ckm != null ? ` -- ${fmtKm(a.ckm)} km credited, a golden packet needs ${GOLD_KM()} km` : ''}`); a.restore = false; }   // a route that worked stays
      else { say(a, 'No two-way this time -- the far end may be asleep, or the path one-way. Try again later.'); if (a.restore) restorePath(a); k.sfx('fail'); }
      ui.last = a; dirty('mesh');
    }
    const goldText = a => String(ps.text || '').replace('{call}', (k.myCall() || 'Kelly')).replace('{km}', fmtKm(a.km)).slice(0, 150);

    // ------------------------------------------------------------------ map
    let layer = null, hiLayer = null, drawnSig = '';
    const COL = { in: '#00e5ff', out: '#ff3bd4', gold: '#ffd166', bb: '#7c5cff' };
    function inWin(t) { return !ps.win || Date.now() - t < ps.win * 3600000; }
    // stations worth showing: far enough, heard in the window
    function farStations() {
      const out = [];
      for (const [num, s] of Object.entries(D.st)) {
        const n = node(+num); if (!n || +num === k.myNum()) continue;
        const km = kmTo(n), inb = s.inb.filter(x => inWin(x.t));
        if (km == null || km < ps.minKm) continue;
        if (!inb.length && !(s.out && inWin(s.out.t)) && !D.golds.some(g => g.num === +num && inWin(g.t))) continue;
        out.push({ num: +num, n, km, s, inb });
      }
      return out.sort((a, b) => b.km - a.km);
    }
    function polyline(ch, color, w, cls, op = 0.85) {
      const pts = ch.filter(x => x.p).map(x => [x.p.lat, x.p.lon]);
      if (pts.length < 2) return null;
      return window.L.polyline(pts, { color, weight: w, opacity: op, className: cls, interactive: false });
    }
    function drawMap() {
      const map = k.map(), L = window.L; if (!map || !L) return;
      const sig = `${ver}|${ps.show}|${ps.minKm}|${ps.win}|${ps.backbone}|${k.nodesVer()}`;
      if (sig === drawnSig) return; drawnSig = sig;
      if (layer) layer.remove(); layer = null;
      if (!ps.show) return;
      layer = L.layerGroup().addTo(map);
      // edges: resolved hop pairs, counted
      const edges = new Map(), hubs = new Map();
      const add = (ch, kind, wgt, far) => {
        for (let i = 1; i < ch.length; i++) {
          const a = ch[i - 1], b = ch[i]; if (!a.p || !b.p) continue;
          const ka = a.num != null ? `n${a.num}` : `g${a.hash}`, kb = b.num != null ? `n${b.num}` : `g${b.hash}`;
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const e = edges.get(key) || { a, b, w: 0, kinds: new Set() }; e.w += wgt; e.kinds.add(kind); edges.set(key, e);
        }
        for (const h of ch.slice(1, -1)) { const kk = h.num != null ? `n${h.num}` : `g${h.hash}`; const x = hubs.get(kk) || { h, far: new Set() }; x.far.add(far); hubs.set(kk, x); }
      };
      for (const f of farStations()) {
        for (const r of f.inb) add(chainIn(f.num, r), 'in', r.n || 1, f.num);
        if (f.s.out && inWin(f.s.out.t)) add(chainOut(f.num, f.s.out), 'out', 1, f.num);
      }
      if (ps.backbone) for (const q of D.seqs.filter(x => inWin(x.t) && !x.from)) {
        const b = meEnd(), hops = resolve(q, null, b); add([...hops, b], 'bb', q.n || 1, `s${q.sig}`);
      }
      for (const g of D.golds.filter(x => inWin(x.t) && (x.km || 0) >= ps.minKm)) {
        if (g.out) add(chainOut(g.num, g.out), 'gold', 2, g.num);
        if (g.back) add(chainIn(g.num, g.back), 'gold', 2, g.num);
        if (!g.out && !g.back) add([meEnd(), end(g.num)], 'gold', 2, g.num);
      }
      const maxW = Math.max(1, ...[...edges.values()].map(e => e.w));
      for (const e of edges.values()) {
        const kind = e.kinds.has('gold') ? 'gold' : e.kinds.has('out') && e.kinds.has('in') ? 'gold' : e.kinds.has('out') ? 'out' : e.kinds.has('in') ? 'in' : 'bb';
        const w = 1.2 + 4 * Math.sqrt(e.w / maxW);
        L.polyline([[e.a.p.lat, e.a.p.lon], [e.b.p.lat, e.b.p.lon]], { color: COL[kind], weight: w + 5, opacity: 0.10, interactive: false }).addTo(layer);   // glow
        L.polyline([[e.a.p.lat, e.a.p.lon], [e.b.p.lat, e.b.p.lon]], { color: COL[kind], weight: w, opacity: kind === 'bb' ? 0.45 : 0.8, className: `mp-edge mp-${kind}`, interactive: false }).addTo(layer);
      }
      // hubs: repeaters that carry far stations, sized by how many
      for (const x of hubs.values()) {
        const h = x.h; if (!h.p) continue;
        const r = 4 + Math.min(10, x.far.size * 1.6);
        const m = L.circleMarker([h.p.lat, h.p.lon], { radius: r, color: h.ghost ? '#a78bfa' : '#00e5ff', weight: 2, fillColor: h.ghost ? 'transparent' : '#00e5ff', fillOpacity: h.ghost ? 0 : 0.25, dashArray: h.ghost ? '3 3' : null, className: 'mp-hub' });
        m.bindTooltip(`<b>${esc(h.name)}</b>${h.ghost ? ` · unknown repeater (hash ${esc(h.hash)})${h.placed ? ', placed between its neighbours' : ''}` : ''}<br>carries ${x.far.size} long-haul station${x.far.size === 1 ? '' : 's'}`);
        m.addTo(layer);
      }
      drawHover();
    }
    // hover a station: every hop its packets took (cyan in, magenta out, gold two-way), with each leg's km
    function hover(num) { ui.hover = num == null ? null : num >>> 0; drawHover(); renderHoverCard(); }
    function drawHover() {
      const map = k.map(), L = window.L; if (!map || !L) return;
      if (hiLayer) hiLayer.remove(); hiLayer = null;
      const num = ui.showing ? ui.showing.num : ui.hover; if (num == null) return;
      const s = D.st[num]; hiLayer = L.layerGroup().addTo(map);
      const legs = (ch, color, cls) => {
        const pl = polyline(ch, color, 4, cls, 0.95); if (pl) pl.addTo(hiLayer);
        ch.forEach((h, i) => { if (!h.p || i === 0 || i === ch.length - 1) return;
          L.circleMarker([h.p.lat, h.p.lon], { radius: 6, color, weight: 2, fillColor: '#050b14', fillOpacity: 0.9, interactive: false }).addTo(hiLayer)
            .bindTooltip(`${i}. ${esc(h.name)}`, { permanent: true, direction: 'top', className: 'mp-hoplbl', offset: [0, -6] }); });
      };
      const g = ui.showing || D.golds.find(x => x.num === num);
      if (g && (g.out || g.back)) { if (g.out) legs(chainOut(num, g.out), COL.out, 'mp-hi mp-flow-out'); if (g.back) legs(chainIn(num, g.back), COL.gold, 'mp-hi mp-flow-in'); }
      else if (s) { s.inb.slice(0, 3).forEach((r, i) => legs(chainIn(num, r), COL.in, `mp-hi mp-flow-in${i ? ' mp-dim' : ''}`)); if (s.out) legs(chainOut(num, s.out), COL.out, 'mp-hi mp-flow-out'); }
    }
    function chainHtml(ch) {
      return ch.map((h, i) => { const leg = i && ch[i - 1].p && h.p ? k.distKm(ch[i - 1].p, h.p) : null;
        return `${i ? `<i class="mp-leg">${leg != null ? fmtKm(leg) + ' km' : '·'}</i>` : ''}<span class="mp-hop${h.ghost ? ' ghost' : ''}">${esc(h.name)}</span>`; }).join('');
    }
    function renderHoverCard() {
      const box = $('#mp-hover'); if (!box) return;
      const num = ui.hover, s = num != null ? D.st[num] : null, n = num != null ? node(num) : null;
      if (!n || !s || (!s.inb.length && !s.out)) { box.hidden = true; return; }
      box.hidden = false;
      const km = kmTo(n), inb = s.inb[0];
      box.innerHTML = `<b>${esc(k.nodeName(num))}</b> · ${fmtKm(km)} km`
        + (inb ? `<div class="mp-chain in"><label>⬇ heard via</label>${chainHtml(chainIn(num, inb))}</div><small>${hopsOf(inb)} hop${hopsOf(inb) === 1 ? '' : 's'} · ${esc(inb.via)} · ${k.fmtAgo(inb.t)}${inb.snr != null ? ` · last hop ${inb.snr.toFixed(1)} dB` : ''}${s.inb.length > 1 ? ` · ${s.inb.length} routes seen` : ''}</small>` : '')
        + (s.out ? `<div class="mp-chain out"><label>⬆ route to it</label>${chainHtml(chainOut(num, s.out))}</div>` : '')
        + (s.two[0] ? `<small class="mp-gold">🥇 two-way ${k.fmtAgo(s.two[0].t)} by ${esc(HOW[s.two[0].how] || s.two[0].how)}</small>` : '');
    }
    // a golden record on the map: out (magenta) then back (gold), animated, and the whole map fitted to it
    function showGolden(g) {
      if (!g) return;
      ui.showing = g; drawHover();
      const map = k.map(); if (map && g.me && g.them) map.fitBounds(window.L.latLngBounds([[g.me.lat, g.me.lon], [g.them.lat, g.them.lon]]), { padding: [60, 60], maxZoom: 12 });
      k.scrollToMap();
      clearTimeout(showGolden.t); showGolden.t = setTimeout(() => { ui.showing = null; drawHover(); }, 25000);
    }

    // ------------------------------------------------------------------ card
    function render() {
      ensureDev();
      drawMap();
      const box = $('#mp-card'); if (!box || k.currentPage() !== 'mesh') return;
      const far = farStations(), golds = D.golds.filter(g => inWin(g.t)), a = ui.attempt || ui.last;
      const sig = `${ver}|${ui.tab}|${ps.minKm}|${ps.win}|${ps.show}|${ps.backbone}|${ui.fresh}|${a ? a.log.length + (a.done || 0) : 0}|${k.online()}|${Math.floor(Date.now() / 30000)}`;
      if (sig === ui.sig) return; ui.sig = sig;
      const ckmOf = g => g.ckm != null ? g.ckm : g.km;
      const best = golds.filter(g => g.gold).reduce((m, g) => !m || ckmOf(g) > ckmOf(m) ? g : m, null);
      const goldRank = new Map(golds.filter(g => g.gold).sort((a, b) => ckmOf(b) - ckmOf(a)).map((g, i) => [g.id, i]));
      $('#mp-tag').textContent = `${far.length} far station${far.length === 1 ? '' : 's'} · ${golds.length} two-way${goldRank.size ? ` · ${goldRank.size} golden` : ''}`;
      $('#mp-best').innerHTML = best ? `🥇 <b>${fmtKm(ckmOf(best))} km</b> Golden Handshake with ${esc(best.name)} <span class="dim">(${esc(HOW[best.how] || best.how)}, ${k.fmtAgo(best.t)})</span>`
        : `<span class="dim">No golden packet yet: an ACK, path return or path discovery with a ham's companion ${GOLD_KM()} km+ away (credited) -- go for gold below.</span>`;
      $('#mp-show').checked = !!ps.show; $('#mp-bb').checked = !!ps.backbone; $('#mp-min').value = ps.minKm; $('#mp-minv').textContent = `${ps.minKm} km`; $('#mp-win').value = String(ps.win);
      $$('#mp-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
      const body = $('#mp-body');
      if (ui.tab === 'gold') {
        body.innerHTML = golds.length ? `<ol class="mp-list">${golds.slice(0, 25).map((g, i) => `<li class="${g.id === ui.fresh ? 'fresh' : ''}" data-gold="${esc(g.id)}">
          <span class="mp-medal">${g.gold ? MEDAL[goldRank.get(g.id)] || '🏅' : '🤝'}</span>
          <span class="mp-txt"><b>${esc(g.name)}${g.ham ? ' <em class="mp-ham">HAM</em>' : ''}</b><small>${fmtKm(g.km)} km${g.ckm != null && g.km != null && g.ckm < g.km - 0.05 ? ` (${fmtKm(g.ckm)} credited)` : ''} · ${esc(HOW[g.how] || g.how)} · ${g.out ? hopsOf(g.out) + ' out' : '? out'} / ${g.back ? hopsOf(g.back) + ' back' : '? back'}${g.rtt ? ` · ${(g.rtt / 1000).toFixed(1)} s round trip` : ''}${g.snr != null ? ` · ${g.snr.toFixed(1)} dB back` : ''} · ${k.fmtAgo(g.t)}</small></span>
          <button class="btn ghost small" data-showg="${esc(g.id)}">🗺️</button></li>`).join('')}</ol>`
          : `<p class="dim small">A two-way exchange appears here the moment one is proven: an ACK to your message, a path-return, a path-discovery answer${k.isDriver() ? ' or a trace back from a repeater' : ' or a traceroute'}. A golden packet is one with a licensed ham's companion ${GOLD_KM()} km+ away (credited km) -- repeater traces stay on the map but never score gold.</p>`;
      } else if (ui.tab === 'try') {
        const cands = k.isDriver() ? far.filter(f => !goldWhy(f.n, hamOf(f.n)) && !(f.s.two[0] && Date.now() - f.s.two[0].t < 86400000)).slice(0, 10) : [];
        if (!k.isDriver()) { body.innerHTML = '<p class="dim small">Go for gold is MeshCore only: a golden packet is a Golden Handshake -- a DM ACK, path return or path discovery with a licensed ham\'s companion node. Traceroutes still show here as two-way exchanges.</p>'; return; }
        body.innerHTML = `${a ? `<div class="mp-attempt${a.done ? (a.ok ? ' ok' : ' bad') : ' run'}"><b>${a.done ? (a.ok ? (a.gold ? '🥇 GOLDEN!' : '🤝 Two-way') : '🙁 Not this time') : '📡 Going for gold…'} ${esc(k.nodeName(a.num))} · ${fmtKm(a.km)} km</b>${a.log.map(l => `<div>${esc(l.line)}</div>`).join('')}</div>` : ''}
          <div class="row gap wrap"><label class="fld"><span>Try</span><select id="mp-chain">${[['reverse,discover,message', 'Reverse path, then discovery, then message'], ['reverse', 'Reverse path only'], ['discover,message', 'Discovery, then message'], ['discover', 'Path discovery only (no message)'], ['message', 'Message by flood']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <label class="fld grow"><span>Message ({call}, {km})</span><input id="mp-text" maxlength="150" value="${esc(ps.text)}"></label></div>
          <ul class="mp-list">${cands.map(f => { const r = f.inb.find(x => x.h || x.nums), why = canTry(f.num);
            return `<li><span class="mp-medal">🎯</span><span class="mp-txt"><b>${esc(k.nodeName(f.num))} <em class="mp-ham">HAM</em></b><small>${fmtKm(f.km)} km · ${r ? `heard via ${hopsOf(r)} hop${hopsOf(r) === 1 ? '' : 's'} (${esc(r.via)}) · reverse path ready` : 'no route seen yet'} · ${f.n.lastHeard ? k.fmtAgo(f.n.lastHeard) : ''}</small></span>
              <button class="btn primary small" data-gold-try="${f.num}" ${why || !k.online() ? `disabled title="${esc(why || 'connect your node')}"` : ''}>🥇 Go for gold</button></li>`; }).join('') || `<li class="dim small">No ham companions ${ps.minKm} km+ away heard yet${ps.win ? ' in this window' : ''}. Repeaters and room servers never make a golden packet; a ham's companion needs a callsign (Ham Contacts) and to be your contact.</li>`}</ul>
          <p class="dim small">Only licensed hams' companion nodes are offered. Each try sends a short message (or a path discovery request, inside the Trace Route airtime budget) -- once per station per 10 min, ${TRY_HOUR} an hour. A reverse-path try that fails puts the station's old route back on your node.</p>`;
        const c = $('#mp-chain'); if (c) { c.value = chain().join(','); c.onchange = () => { ps.chain = c.value; k.save(); }; }
        const t = $('#mp-text'); if (t) t.onchange = () => { ps.text = t.value; k.save(); };
      } else {
        body.innerHTML = `<ul class="mp-list">${far.slice(0, 20).map(f => { const r = f.inb[0];
          return `<li data-far="${f.num}"><span class="mp-medal">${D.golds.some(g => g.num === f.num) ? '🥇' : '📡'}</span><span class="mp-txt"><b>${esc(k.nodeName(f.num))} · ${fmtKm(f.km)} km</b>${r ? `<div class="mp-chain in">${chainHtml(chainIn(f.num, r))}</div><small>${hopsOf(r)} hop${hopsOf(r) === 1 ? '' : 's'} · path ${fmtKm(pathKm(chainIn(f.num, r)))} km · ${k.fmtAgo(r.t)}</small>` : '<small>route to it only</small>'}</span></li>`; }).join('') || `<li class="dim small">Nothing ${ps.minKm} km+ away yet.</li>`}</ul>`;
      }
    }
    const $$ = sel => [...document.querySelectorAll(sel)];
    function init() {
      const box = $('#mp-card'); if (!box) return;
      box.onclick = e => {
        const t = e.target.closest('[data-tab]'); if (t) { ui.tab = t.dataset.tab; ui.sig = ''; dirty('mesh'); return; }
        const sg = e.target.closest('[data-showg]'); if (sg) { showGolden(D.golds.find(g => g.id === sg.dataset.showg)); return; }
        const tr = e.target.closest('[data-gold-try]'); if (tr) { ps.chain = ($('#mp-chain') || {}).value || ps.chain; goForGold(+tr.dataset.goldTry); return; }
        const fr = e.target.closest('[data-far]'); if (fr) { k.focusNode(+fr.dataset.far); hover(+fr.dataset.far); }
      };
      box.onmouseover = e => { const li = e.target.closest('[data-far],[data-gold]'); if (!li) return; const num = li.dataset.far ? +li.dataset.far : (D.golds.find(g => g.id === li.dataset.gold) || {}).num; if (num != null && num !== ui.hover) hover(num); };
      box.onmouseleave = () => hover(null);
      $('#mp-show').onchange = e => { ps.show = e.target.checked; k.save(); ui.sig = ''; dirty('mesh'); };
      $('#mp-bb').onchange = e => { ps.backbone = e.target.checked; k.save(); ui.sig = ''; dirty('mesh'); };
      $('#mp-min').oninput = e => { ps.minKm = +e.target.value; $('#mp-minv').textContent = `${ps.minKm} km`; ui.sig = ''; dirty('mesh'); };
      $('#mp-min').onchange = () => k.save();
      $('#mp-win').onchange = e => { ps.win = +e.target.value; k.save(); ui.sig = ''; dirty('mesh'); };
    }
    // the demo mesh: real Meshtastic traceroutes do the two-way part; seed a few inbound routes so the map has a story
    function demoSeed() {
      ensureDev();
      if (D === R) return;   // only into the session-only demo book: never saved (B7)
      const me = k.myPos(); if (!me || Object.keys(D.st).length) return;
      const ns = [...k.nodes()].filter(n => n.num !== k.myNum() && pos(n)).map(n => ({ n, km: k.distKm(me, n) })).sort((a, b) => b.km - a.km);
      for (const { n } of ns.slice(0, 6)) {
        const mids = ns.filter(x => x.n !== n && x.km < k.distKm(me, n) && k.distKm(x.n, n) < k.distKm(me, n)).sort((a, b) => k.distKm(a.n, n) - k.distKm(b.n, n)).slice(0, 2).map(x => x.n.num);
        addInbound(n.num, { nums: mids }, 'demo');
      }
    }
    // a station's route history for the node info panel (js/meshinfo.js): heard via (newest first), our route, two-way
    function routes(num) {
      const s = D.st[num >>> 0]; if (!s) return null;
      return { inb: s.inb.slice(0, 6).map(r => ({ t: r.t, n: r.n, snr: r.snr, via: r.via, html: chainHtml(chainIn(num, r)) })),
        out: s.out ? chainHtml(chainOut(num, s.out)) : null, two: s.two.slice(0, 5).map(x => ({ t: x.t, how: HOW[x.how] || x.how, rtt: x.rtt })) };
    }
    // the newest inbound route with hashes (how its packets last reached us) -> { sz, h, t, snr } (the Trace Route tab)
    function inbound(num) { const s = D.st[num >>> 0], r = s && s.inb.find(x => x.h); return r ? { sz: r.sz || 1, h: r.h.slice(), t: r.t, snr: r.snr ?? null } : null; }
    const api = { route, node: nodeUpdate, text, trace, ack, render, hover, init, showGolden, online, demoSeed, golds: () => D.golds, chainIn, routes, inbound, attempt: () => ui.attempt || ui.last,
      debug: () => ({ stations: Object.keys(D.st).length, seqs: D.seqs.length, golds: D.golds.length, me: k.myPos(), placed: [...k.nodes()].filter(n => pos(n)).length, far: farStations().length, ver }) };
    window.kellyMeshPaths = api;   // for the console / test drivers, like window.kelly
    return api;
  };
})();
