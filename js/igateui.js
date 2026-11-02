/* Kelly Page -- APRS iGate page (2026-10-24, unreleased): MeshCore trackers on THIS owner's list -> APRS-IS (aprs.fi).
 *
 * Every Kelly can be an iGate, and each owner decides what theirs gates: MY LIST (store 'igateList') is the only thing
 * that lets a node through (by node KEY, never by name; default deny). It fills three ways:
 *   mine        the owner adds a node (a MeshCore contact, or a pasted key) with its owner's callsign
 *   node name   a heard node whose name has a callsign in it ('VK4XXX Tracker') is OFFERED; the owner adds or dismisses it
 *   club list   the club's signed known-users list (js/igate-wl.js; over P25, a file or an address) is merged in. A club
 *               entry the owner hasn't touched follows the club list; once edited, disabled or deleted it is the owner's
 *               (a deleted one stays deleted: 'gone')
 *   QR card     another ham's 🔳 device card (js/meshqr.js buildShare: contact link + aprs/sym/cmt), scanned here; may wait
 *               unheard on the list (2026-10-31)
 *   shared      the P25X gateway's shared-devices list ({op: 'igcm'}), merged like the club list; each P25 owner shares
 *               the entries under their OWN callsign ({op: 'igcmput'}). Unsigned -- HAM ONLY at gate time is the guard
 * The LoRa Mesh page's MeshCore link (js/mesh.js IG hooks) hands over positions only:
 *   advert     a contact the node pushed just now (its NEW_ADVERT, or the contact read straight after an advert push)
 *   raw        a raw advert from the packet log -- its Ed25519 signature is checked HERE (TweetNaCl) before it counts,
 *              so a forged advert can't borrow a listed key
 *   telemetry  this page polling a listed node (DIRECT route only, never a flood): its GPS (settings.igate.poll) and,
 *              per device, APRS telemetry -- CayenneLPP readings and repeater status mapped by the owner (entry.t; device
 *              types in js/igate.js PRESETS) -> T# + PARM/UNIT/EQNS/BITS
 * js/igate.js decides (list, position rules, dedup, per-station interval, bucket); everything goes out through the Kelly
 * bridge's persistent APRS-IS connection (bridge/kelly_igate.py, /api/igate) -- the internet only. P25 carries just the
 * club list ({op: 'igwl', have} once a day / on the gateway's push; the admin publishes with 'igwlput'). The admin's
 * Kelly keeps its Ed25519 seed in IndexedDB 'kelly-igate' (never synced, never in settings) and signs here.
 * Own beacon: the node's advert, with Kelly's position rounded for privacy (or the node's own GPS), at most every
 * 15 min zero-hop / 60 min flood. Counters persist (store 'igateStats').
 *
 * window.KellyIgateUI(ctx) -> { init, render, feed, gatewayReply, ownsXid, kfEvent }; ctx from app.js.
 */
(function () {
  'use strict';
  const WL_DAY_MS = 86400000, WL_WEB_MS = 6 * 3600000, BRIDGE_POLL_MS = 15000, STATS_SAVE_MS = 30000;
  const TLM_DEFS_MS = 6 * 3600000, TLM_GAP_MS = 6000, TLM_QMAX = 40, TLM_HOLD_MS = 600000, TLM_MIN_MIN = 10;
  const SYMBOLS = [['/>', '🚗 Car'], ['/[', '🚶 Walker'], ['/b', '🚲 Bicycle'], ['/p', '🐕 Dog'], ['/<', '🏍️ Motorcycle'], ['/k', '🛻 Truck'], ['/j', '🚙 Jeep'],
    ['/v', '🚐 Van'], ['/u', '🚚 Lorry'], ['/s', '🚤 Boat'], ['/Y', '⛵ Yacht'], ["/'", '✈️ Small plane'], ['/O', '🎈 Balloon'], ['/-', '🏠 House'], ['/R', '🚌 RV'],
    ['/r', '📡 Repeater'], ['/_', '🌦️ Weather station'], ['/#', '📶 Digipeater']];
  const DROP_LABEL = { notListed: 'Not on my list', rate: 'Rate-limited', duplicate: 'Duplicate', invalid: 'Invalid position', unsent: "Couldn't send" };
  const FROM = { own: 'mine', club: 'club list', name: 'node name', card: 'QR card', comm: 'shared (P25)' };
  // common CayenneLPP types for a "first reading of this type" source (js/igate.js: 'lpp:*:<type>')
  const LPP_ANY = [[116, 'voltage', 'V'], [117, 'current', 'A'], [128, 'power', 'W'], [120, 'percentage', '%'], [103, 'temperature', '°C'],
    [104, 'humidity', '%'], [115, 'pressure', 'hPa'], [101, 'illuminance', 'lx']];

  window.KellyIgateUI = function (k) {
    const { $, esc, store, toast, addEvent, dirty, settings, saveSoon, fmtAgo } = k;
    const I = window.KellyIgate, W = window.IgateWL, nacl = window.nacl, M = window.MeshPRS, MC = window.KellyMcDecode;
    const ed = W && nacl ? W.naclEd(nacl) : null;
    const s = settings.igate;
    s.own = Object.assign({ on: false, src: 'kelly', everyMin: 30, flood: false, places: 3, lastAt: 0 }, s.own || {});
    s.mprs = Object.assign({ on: false, send: false, ssid: s.ssid || 10, sym: '/-', comment: '' }, s.mprs || {});
    // decision 0009: the APRS-IS passcode lives in the bridge only; decision 0015: aunz.aprs2.net (the bridge falls back to rotate)
    if ('pass' in s) { delete s.pass; saveSoon('settings'); }
    if (!s.server || s.server === 'rotate.aprs2.net') { s.server = 'aunz.aprs2.net'; saveSoon('settings'); }
    const wl = Object.assign({ doc: null, src: '', at: 0, checked: 0, error: '' }, store.get('igateWL', {}) || {});
    // the kept copy is checked again: a release may have dropped the admin key that signed it
    if (wl.doc && W && ed && !W.verify(wl.doc, ed).ok) { wl.error = `the kept list (v${wl.doc.b && wl.doc.b.v}) no longer verifies -- dropped`; wl.doc = null; }
    // shared devices (2026-10-31): the gateway's merged list of what P25 Kelly owners shared ({op: 'igcm'}), and what this
    // Kelly last shared ({op: 'igcmput'}: sent = {at, sig, n, v})
    const cm = Object.assign({ v: 0, e: [], at: 0, checked: 0, error: '', sent: null, msg: '' }, store.get('igateCM', {}) || {});
    if (!Array.isArray(cm.e)) cm.e = [];
    const saveCm = () => store.set('igateCM', cm);
    const L0 = store.get('igateList', null) || {};
    const list = { e: Array.isArray(L0.e) ? L0.e : [], gone: Array.isArray(L0.gone) ? L0.gone : [], tlm: L0.tlm && typeof L0.tlm === 'object' ? L0.tlm : {} };
    const myTypes = () => (store.get('igatePresets', []) || []).filter(p => p && p.id && p.a);
    const S = { bridge: null, bridgeAt: 0, bridgeErr: '', asks: new Map(), admin: null, draft: null, log: [], polled: new Map(), tpolled: new Map(),
      ownBusy: false, mprsOut: 0, mprsUnsent: 0, path: '', tq: [], tqAt: 0, t: null, reads: new Map(),
      find: { q: '', pick: null, listenAt: 0, more: false, t: null } };
    const mprsHeard = new Map();   // node key prefix (8 hex) -> { src, sym, at }: MeshPRS senders heard (🔎 Add my device)
    const cfgOf = () => ({ maxAgeMin: +s.maxAgeMin, perStationMin: +s.perStationMin, moveM: +s.moveM, bucketS: +s.everyS, burst: +s.burst });
    const byKey = key => list.e.find(x => x.k === key);
    const lookup = key => { const x = byKey(String(key || '').toLowerCase()); return x && x.e ? x : null; };
    const gate = I.Gate({ lookup, cfg: cfgOf(), stats: store.get('igateStats', null) });
    // MeshPRS (js/meshprs.js, decisions 0005/0015): a frame's callsign must be bound to its node key by an entry on MY list
    // (mine or the club's -- the key and base callsign only; the entry's SSID, symbol and comment are for adverts), and
    // that key's advert heard in the last 24 h (adv: key -> ms, kept in store 'igateAdv')
    const adv = Object.assign({}, store.get('igateAdv', {}) || {});
    const noteAdvert = key => { if (!key) return; adv[String(key).toLowerCase()] = Date.now(); const ks = Object.keys(adv); if (ks.length > 300) delete adv[ks.sort((a, b) => adv[a] - adv[b])[0]]; };
    const mgate = M ? M.Gate({ igate: () => call() || 'N0CALL', bindings: () => list.e.filter(x => x.e).map(x => ({ call: x.c, key: x.k })), adverts: () => adv }) : null;
    const mprsSlot = () => { const L = link(); return ((L && L.channels && L.channels()) || []).find(c => c && /^#meshprs$/i.test(c.name)) || null; };
    const log = (t, line) => { S.log.unshift({ at: Date.now(), t, line }); S.log.length = Math.min(S.log.length, 60); dirty('igate'); };
    const call = () => I.fullCall(s.call, s.ssid);
    const saveWl = () => store.set('igateWL', wl);
    const saveList = () => store.set('igateList', list);
    let statsDirty = false;
    const saveStats = () => { if (statsDirty) { store.set('igateStats', gate.stats.json()); store.set('igateAdv', adv); statsDirty = false; } };
    const link = () => (k.meshLink ? k.meshLink() : null);
    const contacts = () => new Map(((link() && link().nodes()) || []).filter(n => n.key).map(n => [n.key, n]));

    // ---------------------------------------------------------------- the bridge (the only way out)
    function bridge() {
      const base = k.lookupBase(), q = new URLSearchParams(location.search);
      let tok = q.get('token') || '';
      try { tok = tok || localStorage.getItem(`bridgeToken:${location.host}`) || ''; } catch {}
      if (!tok) { const m = /[?&]token=([^&]+)/.exec(settings.url || ''); if (m) tok = decodeURIComponent(m[1]); }
      return { base, headers: Object.assign({ 'Content-Type': 'text/plain' }, tok ? { 'X-Kelly-Token': tok } : {}) };
    }
    async function bridgeCall(path, body) {
      const b = bridge();
      const r = await fetch(`${b.base}${path}`, body ? { method: 'POST', headers: b.headers, body: JSON.stringify(body), cache: 'no-store' } : { headers: b.headers, cache: 'no-store' });
      if (r.status === 403) throw new Error('the bridge wants its token (open Kelly from the bridge address with ?token=…)');
      if (!r.ok) throw new Error(`bridge HTTP ${r.status}`);
      return r.json();
    }
    const bridgeUp = () => !!S.bridge && Date.now() - S.bridgeAt < 2 * BRIDGE_POLL_MS + 5000;
    // privacy zone: home = Kelly's own position (GPS > Fixed position, or its fix); only the bridge sees it, on the LAN
    function homePos() {
      if (!s.privacy) return null;
      const p = k.myPos && k.myPos();
      return p && isFinite(+p.lat) && isFinite(+p.lon) ? [+p.lat, +p.lon] : null;
    }
    async function pushConfig() {
      const c = call();
      const want = { on: !!(s.on && c), call: c || '', server: s.server, port: +s.port, filter: s.filter, dry: !!s.dry,
        everyS: +s.everyS, burst: +s.burst, vers: String(window.KELLY_VERSION || ''), status: s.statusOn ? s.statusText : '', statusMin: +s.statusMin,
        privacy: !!s.privacy, home: homePos() };
      try { const r = await bridgeCall('/api/igate/config', want); S.bridge = r.status; S.bridgeAt = Date.now(); S.bridgeErr = r.ok ? '' : r.error; }
      catch (e) { S.bridgeErr = e.message; }
      dirty('igate');
    }
    // privacy on but no home position: the bridge HOLDS every own-station position. One toast + event per spell, whatever
    // page is open (2026-11-01: a PC copy held the Mesh Buddy's positions for hours with only a dim note to show)
    function privacyWarn() {
      const held = !!(s.on && s.privacy && S.bridge && S.bridge.privacy && !S.bridge.privacy.home);
      if (held && !S.privWarned) {
        S.privWarned = true;
        toast('🛡️', "Your own positions aren't going out", 'The iGate privacy zone is on but Kelly has no home position. Set one (GPS › Fixed position) or turn the privacy zone off.', 'bad');
        addEvent('error', 'APRS iGate: privacy zone on with no home position -- own stations are held, not gated');
      } else if (!held) S.privWarned = false;
    }
    // The Pi keeper (bridge/kelly_keeper.py, opened with &keeper) stays on the LoRa node while a person's Kelly uses it,
    // and while its iGate is on the bridge's iGate is ITS (kelly_igate.http): this page's config and sends are refused,
    // so it stands by -- nothing gated twice, no fight over the callsign / privacy zone. The keeper takes it back if a
    // PC configured the iGate while the keeper was away.
    const IS_KEEPER = /[?&]keeper\b/.test(location.search);
    const standby = () => !IS_KEEPER && !!(S.bridge && S.bridge.keeper);
    const STANDBY_MSG = "the Pi keeper is this station's iGate and gates while you use the node -- this Kelly stands by";
    async function pollBridge() {
      try { S.bridge = await bridgeCall('/api/igate'); S.bridgeAt = Date.now(); S.bridgeErr = '';
        if (standby()) { S.bridgeErr = STANDBY_MSG; dirty('igate'); return; }   // its config, not ours: no pushes, no privacy warning
        if (IS_KEEPER && s.on && call() && !S.bridge.keeper) pushConfig();   // ours again (unchanged config = no reconnect)
        else if (s.on && call() && S.bridge.state === 'off') pushConfig();   // a bridge restart forgot us
        else if (s.privacy && S.bridge.privacy && !S.bridge.privacy.home && homePos()) pushConfig();   // Kelly's position arrived
        privacyWarn(); }
      catch (e) { S.bridgeErr = e.message; }
      dirty('igate');
    }

    // ---------------------------------------------------------------- positions in
    function feed(kind, x) {
      // 🔎 Add my device: which node keys send MeshPRS frames, under what callsign and symbol -- noted even with the iGate off
      if (kind === 'chdata' && M && x.type === M.DATA_TYPE && /^#meshprs$/i.test(x.chName || '')) {
        try { const f = M.decode(x.data); if (f.key && !f.g) { mprsHeard.set(f.key.toLowerCase(), { src: f.src, sym: f.sym || '', at: Date.now() }); if (mprsHeard.size > 200) mprsHeard.delete(mprsHeard.keys().next().value); } } catch { /* not a frame */ }
        if (S.find.listenAt) dirty('igate');
      }
      // "advert heard in 24 h" (decision 0015) counts EVERY advert whose signature checks, with or without a position and
      // with the iGate off: a MeshPRS tracker's boot advert usually goes out before its GPS has a fix (seen on a test tracker, 2026-10-31)
      let good = null;
      if (kind === 'raw') {
        const pay = x.raw && x.raw.subarray ? x.raw.subarray(x.payOff || 0) : null;
        if (!pay || pay.length < 101 || !nacl) return;
        // MeshCore advert: pub key 32 | timestamp 4 | signature 64 | app data; signed = key + timestamp + app data
        const key = pay.subarray(0, 32), msg = new Uint8Array(pay.length - 64);
        msg.set(pay.subarray(0, 36)); msg.set(pay.subarray(100), 36);
        good = false; try { good = nacl.sign.detached.verify(msg, pay.subarray(36, 100), key); } catch {}
        if (good) { noteAdvert(x.advert.key); statsDirty = true; }
      }
      if (kind === 'advert') noteAdvert(x.key);
      if (!s.on) return;
      const now = Date.now();
      if (kind === 'raw') {
        if (!good) { gate.stats.heard(); gate.stats.drop('invalid', 'advert signature does not verify', x.advert.key); statsDirty = true; log('drop', `bad advert signature from ${x.advert.key.slice(0, 12)}…`); return; }
        if (x.advert.lat == null) return;   // no position: noted above, nothing to gate
        return offer({ key: x.advert.key, lat: x.advert.lat, lon: x.advert.lon, ts: x.advert.ts, at: now, src: 'raw', name: x.advert.name });
      }
      if (kind === 'advert' || kind === 'telemetry') return offer({ key: x.key, lat: x.lat, lon: x.lon, ts: x.ts, at: x.at || now, src: kind, name: x.name });
      if (!mgate || !s.mprs.on) return;
      // MeshPRS: the companion's channel data (RESP 27, decision 0010), or -- only when the node has no #meshprs slot --
      // a GRP_DATA from the raw packet log, decrypted here with the public #meshprs key
      if (kind === 'chdata' && x.type === M.DATA_TYPE && /^#meshprs$/i.test(x.chName || '')) return mprsIn(x.data, x.at || now, 'node');
      if (kind === 'grpdata' && MC && !mprsSlot()) {
        const d = MC.decode(x.raw, { channels: [{ name: M.CHANNEL, secret: M.CHANNEL_KEY }] }), inf = d && d.info;
        if (inf && inf.channel && inf.dataType === M.DATA_TYPE && inf.data) return mprsIn(M.unhex(inf.data), now, 'raw log');
      }
    }
    // the LoRa Mesh > MeshPRS tab (js/mprs-ui.js) follows each frame through the gate: offer / drop / sent
    const mprsFns = new Set();
    const emit = e => { for (const fn of mprsFns) try { fn(e); } catch (err) { console.warn('MeshPRS listener', err); } };
    // the name of the listed node a MeshPRS frame is bound to (its key prefix), or '' -- the bridge re-checks it
    function mprsName(f) {
      const kp = String(f && f.key || '').toLowerCase(), e = kp && list.e.find(x => x.e && x.k.toLowerCase().startsWith(kp));
      return e ? nodeName(e.k) || '' : null;   // null = not on my list: the gate drops it as untrusted
    }
    function mprsIn(blob, at, via) {
      let f0 = null; try { f0 = M.decode(blob); } catch (e) { /* the gate names the decode error */ }
      if (f0 && f0.key && !f0.g && f0.sym && !mprsHeard.has(f0.key.toLowerCase())) mprsHeard.set(f0.key.toLowerCase(), { src: f0.src, sym: f0.sym, at: Date.now() });   // raw-log frames too (symFor)
      const nm0 = f0 && !f0.g ? mprsName(f0) : null;
      if (nm0 !== null && !I.hamNode(f0.src, nm0)) {   // HAM ONLY: refused before the gate, whatever it claims
        statsDirty = true; const reason = 'name is not an amateur callsign';
        emit({ t: 'offer', hex: M.hex(blob), at, via, verdict: 'drop', reason, line: '' });
        log('drop', `MeshPRS ${reason} -- ${f0.src} (the listed node's name must carry ${f0.src.split('-')[0]} as its first or second word) (${via})`);
        return { verdict: 'drop', reason };
      }
      const r = mgate.offer(blob, at); statsDirty = true;
      emit({ t: 'offer', hex: M.hex(blob), at, via, verdict: r.verdict, reason: r.reason || '', line: r.item ? r.item.line : '' });
      log(r.verdict === 'queued' ? 'in' : 'drop', r.verdict === 'queued' ? `MeshPRS queued (${via}): ${r.item.line}` : `MeshPRS ${r.reason}${r.f ? ` -- ${r.f.src} seq ${r.f.seq}` : ''} (${via})`);
      return r;
    }
    function offer(p) {
      // HAM ONLY at gate time too: a listed node (the signed club list's included) is gated only while its name still
      // carries the callsign it was listed under as word 1 or 2; a renamed or unknown node is never sent
      const e = byKey(p.key);
      if (e && e.e) {
        const nm = p.name != null ? p.name : nodeName(p.key);
        if (hamCallOf(p.key, nm) !== e.c || !I.hamNode(srcOf(e), nm)) { log('drop', `not gated: ${String(nm || p.key.slice(0, 12))} no longer carries ${e.c} (amateur stations only)`); return { verdict: 'drop', reason: 'notListed' }; }
      }
      const r = gate.offer(p);
      if (r.verdict === 'drop' || r.verdict === 'queued') { statsDirty = true; log(r.verdict === 'queued' ? 'in' : 'drop', `${r.verdict === 'queued' ? 'queued' : DROP_LABEL[r.reason]} -- ${String(p.key).slice(0, 12)}… (${p.src})${r.why ? ': ' + r.why : ''}`); }
      return r;
    }

    // ---------------------------------------------------------------- out: positions, then telemetry lines
    const srcOf = x => `${x.c}-${x.s}`;
    async function tick() {
      S.path = bridgeUp() ? 'internet' : '';
      if (standby()) {   // the Pi keeper gates what this node hears: let ours go, unsent
        for (const it of gate.due()) gate.unsent(it, 'the Pi keeper gates it');
        if (mgate) mgate.due(Date.now());
        S.tq.length = 0;
        return;
      }
      const items = gate.due();
      if (items.length) {
        if (!S.path) for (const it of items) { gate.unsent(it, 'no internet path (the Kelly bridge isn\'t answering)'); log('drop', `not sent: no Kelly bridge -- ${srcOf(it.entry)}`); }
        else await sendBridge(items);
        statsDirty = true;
      }
      const now = Date.now();
      while (S.tq.length && now - S.tq[0].at > TLM_HOLD_MS) { const q = S.tq.shift(); log('drop', `telemetry for ${q.src} not sent: no Kelly bridge for 10 min`); if (q.def) delete list.tlm[q.key]; }
      if (S.tq.length && S.path && now - S.tqAt >= TLM_GAP_MS) await sendTlm();
      if (mgate) {
        const d = mgate.due(now);
        for (const x of d.drop) { log('drop', `MeshPRS ${x.reason}: ${x.item.line}`); emit({ t: 'drop', hex: M.hex(x.item.blob), at: x.item.rxAt, reason: x.reason }); }
        if (d.send.length) { if (S.path) await sendMprs(d.send); else for (const it of d.send) { S.mprsUnsent++; log('drop', `MeshPRS not sent: no Kelly bridge -- ${it.f.src}`); emit({ t: 'drop', hex: M.hex(it.blob), at: it.rxAt, reason: 'no Kelly bridge' }); } }
      }
    }
    // the bridge decodes and renders each frame again (bridge/meshprs.py) and sends ITS line
    async function sendMprs(items) {
      let res;
      try { res = (await bridgeCall('/api/igate/send', { lines: items.map(it => Object.assign({ mprs: M.hex(it.blob), rxAt: it.rxAt, name: mprsName(it.f) || '' },
        it.f._record ? { record: { sender: it.f._record.sender, id: it.f._record.id } } : {})) })).results; }
      catch (e) { S.mprsUnsent += items.length; log('drop', `MeshPRS bridge: ${e.message}`); for (const it of items) emit({ t: 'drop', hex: M.hex(it.blob), at: it.rxAt, reason: `bridge: ${e.message}` }); return; }
      items.forEach((it, i) => { const r = res[i] || {}; if (r.ok) S.mprsOut++; else S.mprsUnsent++; log(r.ok ? 'out' : 'drop', r.ok ? `${r.dry ? '(dry run) ' : ''}${r.packet}` : `bridge refused MeshPRS ${it.f.src}: ${r.reason}`);
        emit(r.ok ? { t: 'sent', hex: M.hex(it.blob), at: it.rxAt, dry: !!r.dry, packet: r.packet } : { t: 'drop', hex: M.hex(it.blob), at: it.rxAt, reason: `bridge refused: ${r.reason}` }); });
      statsDirty = true;
    }
    // An advert position of a node that also sends MeshPRS frames takes the frame's symbol (spec 5.4: prefer the frame -- it
    // is the station's own choice), so aprs.fi doesn't flip between the list entry's symbol and the device's (2026-10-31:
    // a test tracker went bike -> car on an advert gated with the entry's default '/>')
    function symFor(entry) {
      const h = mprsHeard.get(String(entry.k || '').toLowerCase().slice(0, 8));
      return h && I.validSymbol(h.sym) ? h.sym : entry.y;
    }
    async function sendBridge(items) {
      let res;
      try { res = (await bridgeCall('/api/igate/send', { lines: items.map(it => ({ src: srcOf(it.entry), name: nodeName(it.entry.k) || '', lat: it.p.lat, lon: it.p.lon, sym: symFor(it.entry), comment: it.entry.m, amb: 0 })) })).results; }
      catch (e) { for (const it of items) gate.unsent(it, e.message); log('drop', `bridge: ${e.message}`); return; }
      items.forEach((it, i) => {
        const r = res[i] || {};
        if (r.ok) { gate.sent(it, srcOf(it.entry), (r.dry ? '(dry run) ' : '') + r.packet); log('out', `${r.dry ? '(dry run) ' : ''}${r.packet}`); }
        else { gate.unsent(it, r.reason || 'refused'); log('drop', `bridge refused ${srcOf(it.entry)}: ${r.reason}`); }
      });
    }
    async function sendTlm() {
      const q = S.tq[0]; S.tqAt = Date.now();
      let r;
      try { r = ((await bridgeCall('/api/igate/send', { lines: [{ src: q.src, name: nodeName(q.key) || '', body: q.body }] })).results || [])[0] || {}; }
      catch (e) { log('drop', `telemetry: bridge ${e.message}`); return; }   // stays queued; tried again later
      if (r.reason === 'rate') return;                                         // the bridge's bucket: try again shortly
      S.tq.shift();
      if (r.ok) { gate.stats.tlm(q.key, q.src, (r.dry ? '(dry run) ' : '') + r.packet); log('out', `${r.dry ? '(dry run) ' : ''}${r.packet}`); }
      else { log('drop', `bridge refused telemetry for ${q.src}: ${r.reason}`); if (q.def) delete list.tlm[q.key]; }
      statsDirty = true; saveList();
    }
    // a device's readings -> its T# (and the definitions when they changed or every 6 h -- they never change, 2026-10-31)
    function queueTlm(x, rs) {
      const map = x.t && x.t.map; if (!map) return;
      const v = I.tlmValues(map, rs), src = srcOf(x);
      if (hamCallOf(x.k, nodeName(x.k)) !== x.c || !I.hamNode(src, nodeName(x.k))) { log('drop', `${src}: telemetry not sent -- the node no longer carries ${x.c} (amateur stations only)`); return; }
      if (v.a.every(a => a == null) && !/1/.test(v.b)) { log('drop', `${src}: telemetry had none of the mapped values (${v.missing.join(', ') || 'nothing mapped'})`); return; }
      if (v.missing.length) log('in', `${src}: no ${v.missing.join(', ')} this time -- sent without`);
      const sig = I.tlmSig(map), t = list.tlm[x.k];
      if (!t || t.sig !== sig || Date.now() - t.at > TLM_DEFS_MS) {
        for (const body of I.tlmDefs(src, map)) S.tq.push({ key: x.k, src, body, def: true, at: Date.now() });
        list.tlm[x.k] = { sig, at: Date.now() };
      }
      S.tq.push({ key: x.k, src, body: I.tlmBody(I.seqNow(), v.a, v.b), at: Date.now() });
      while (S.tq.length > TLM_QMAX) S.tq.shift();
      saveList();
    }

    // ---------------------------------------------------------------- MY list: node-name offers, the club list
    // nodes heard with a VK / ZL callsign as the first or second word of their name that aren't on my list (or dismissed)
    function offers() {
      const gone = new Set(list.gone), out = [];
      for (const n of contacts().values()) {
        if (byKey(n.key) || gone.has(n.key)) continue;
        const cs = I.callFromName(n.longName); if (!cs) continue;
        out.push({ n, c: cs.base, s: cs.ssid || (n.role === 2 || n.role === 3 ? 1 : 12), y: n.role === 2 || n.role === 3 ? '/r' : n.role === 4 ? '/_' : '/>' });
      }
      return out;
    }
    function addEntry(x, src) {
      const i = list.e.findIndex(y => y.k === x.k), was = i >= 0 ? list.e[i] : null;
      // HAM ONLY: everything but the admin-signed club list must be a node heard carrying that very callsign. A QR card's
      // node not heard yet goes on the list waiting: offer() gates it only once its own advert carries that callsign.
      const unheard = src === 'card' && nodeName(x.k) == null;
      if (src !== 'club' && !unheard && !(was && (was.src === 'club' || was.src === 'comm') && was.c === x.c)) {
        const ham = hamCallOf(x.k, nodeName(x.k));
        if (ham !== x.c) {
          toast('🔒', 'Not added: amateur stations only', ham ? `This node carries ${ham}, not ${x.c}` : nodeName(x.k) == null
            ? 'Kelly hasn\'t heard this node yet -- switch it on near your node, then use 🔎 Add my device' : 'Its name must have your amateur callsign as its first or second word (e.g. VK4ABC Bike)', 'bad');
          return false;
        }
      }
      list.gone = list.gone.filter(g => g !== x.k);
      if (i >= 0) Object.assign(list.e[i], x, { ed: true });
      else list.e.push(Object.assign({ e: 1, src, at: Date.now(), ed: src === 'own', t: null }, x));
      saveList(); dirty('igate');
      return true;
    }
    // the club list into mine: new entries added, untouched ones follow it, ones it dropped (and I never touched) go
    function mergeClub() {
      if (!wl.doc) return;
      const club = wl.doc.b.e, keys = new Set(club.map(x => x.k)), gone = new Set(list.gone);
      let n = 0;
      for (const x of club) {
        const mine = byKey(x.k);
        if (!mine) { if (x.e && !gone.has(x.k)) { list.e.push({ k: x.k, c: x.c, s: x.s, y: x.y, m: x.m, e: 1, src: 'club', at: Date.now(), ed: false, t: null }); n++; } }
        else if (mine.src === 'club' && !mine.ed) Object.assign(mine, { c: x.c, s: x.s, y: x.y, m: x.m, e: x.e });
      }
      list.e = list.e.filter(x => !(x.src === 'club' && !x.ed && !keys.has(x.k)));
      saveList();
      if (n) log('in', `club list v${wl.doc.b.v}: ${n} new station(s) added to my list`);
    }
    // the shared devices into mine, the same way: new ones added (never one I removed, never over an entry I already
    // have), untouched ones follow the shared list, ones it dropped go. HAM ONLY still decides at gate time.
    function mergeComm() {
      const keys = new Set(cm.e.map(x => x.k)), gone = new Set(list.gone), self = selfKey();
      let n = 0;
      for (const x of cm.e) {
        if (!x || !/^[0-9a-f]{64}$/.test(x.k) || x.k === self) continue;
        const mine = byKey(x.k);
        if (!mine) { if (x.e && !gone.has(x.k)) { list.e.push({ k: x.k, c: x.c, s: x.s, y: x.y, m: x.m || '', e: 1, src: 'comm', by: x.by || '', at: Date.now(), ed: false, t: null }); n++; } }
        else if (mine.src === 'comm' && !mine.ed) Object.assign(mine, { c: x.c, s: x.s, y: x.y, m: x.m || '', e: x.e, by: x.by || '' });
      }
      list.e = list.e.filter(x => !(x.src === 'comm' && !x.ed && !keys.has(x.k)));
      saveList();
      if (n) log('in', `shared devices v${cm.v}: ${n} new station(s) added to my list`);
    }
    const selfKey = () => { const L = link(); return String((L && L.selfKey && L.selfKey()) || '').toLowerCase(); };
    // my own devices = the enabled entries under MY callsign (the gateway refuses any other callsign anyway)
    const myShare = () => { const b = String(s.call || '').toUpperCase(); return list.e.filter(x => x.e && x.c === b && x.src !== 'comm' && x.src !== 'club').map(x => ({ k: x.k, c: x.c, s: x.s, y: x.y, m: x.m || '', e: 1 })); };
    const shareSig = e => e.map(x => [x.k, x.s, x.y, x.m].join('|')).sort().join(',');

    // ---------------------------------------------------------------- the club list over P25 (its only P25 use)
    const ownsXid = xid => S.asks.has(xid);
    function kfEvent(e) {
      const a = e.t && S.asks.get(e.t.xid); if (!a) return;
      if (e.kind === 'tx-failed') {
        S.asks.delete(e.t.xid);
        if (a.kind === 'wl') { wl.error = 'no answer from the P25X gateway'; saveWl(); }
        else if (a.kind === 'put') { S.pubMsg = '⚠ no answer from the P25X gateway'; }
        else if (a.kind === 'cm') { cm.error = 'no answer from the P25X gateway'; saveCm(); }
        else if (a.kind === 'cmput') { cm.msg = '⚠ no answer from the P25X gateway -- try again'; saveCm(); }
        dirty('igate');
      }
    }
    // the oldest ask of that kind takes the answer (requests of one kind go one at a time)
    const takeAsk = kind => { for (const [xid, a] of S.asks) if (a.kind === kind) { S.asks.delete(xid); return a; } return null; };
    function gatewayReply(j) {
      if (j.app === 'igcm') { cmReply(j); return; }
      if (j.app !== 'igwl') return;
      if (j.put) {
        takeAsk('put');
        S.pubMsg = j.ok ? `✓ the P25X gateway took version ${j.v} -- stations get it over P25` : j.same ? `The gateway already has version ${j.v}` : `⚠ the gateway refused it: ${j.error}`;
        if (j.ok) toast('🔐', `Club list v${j.v} published`, 'Parked Kelly radios get it now, the rest on their daily check', 'good');
        dirty('igate'); return;
      }
      if (j.notify) { if ((Number(j.v) || 0) > version()) checkWl(true); return; }   // a push: a newer list is out
      takeAsk('wl');
      wl.checked = Date.now();
      if (j.error) wl.error = j.error;
      else if (j.cur) { wl.error = ''; wl.at = Date.now(); }
      else if (j.doc) take(j.doc, 'the P25X gateway (P25)');
      saveWl(); dirty('igate');
    }
    const version = () => (wl.doc && wl.doc.b ? wl.doc.b.v : 0);
    async function checkWl(manual) {
      if (!k.radioConnected() || k.demo()) { if (manual) toast('📻', 'Connect the radio first', 'The club list comes from the P25X gateway over P25 -- or import a file', 'bad'); return; }
      if ([...S.asks.values()].some(a => a.kind === 'wl')) return;
      wl.checked = Date.now(); saveWl();
      const xid = await k.kfRequest({ op: 'igwl', have: version() }, 'APRS iGate: is there a newer club list?');
      if (xid) S.asks.set(xid, { kind: 'wl', at: Date.now() });
      dirty('igate');
    }
    // The same club list from kellypage.app over HTTPS (Track E, 2026-11-02): best effort, online and not file:// only.
    // It is the admin's signed doc stored verbatim, so take() applies the very same rules (pinned admin keys, version only
    // ever up, last good copy stays on any failure).
    async function pullWeb(manual) {
      const WS = window.KellyWebSync;
      if (!WS || !W || !ed || !WS.webOk()) { if (manual) toast('🌐', 'Not online', 'The club list comes from kellypage.app when Kelly runs from a web address and the internet is up', 'bad'); return; }
      wl.webChecked = Date.now(); saveWl();
      const r = await WS.pullIgateWl({ accept: doc => take(doc, 'kellypage.app', !manual) });
      if (!r.ok && manual) toast('🌐', 'No club list from kellypage.app', r.error || '', 'bad');
      dirty('igate');
    }
    // admin: send a list this Kelly just signed to kellypage.app. No token: the server takes it because it carries an admin
    // signature and a higher version than the one it has.
    async function uploadWeb(doc) {
      const WS = window.KellyWebSync;
      if (!WS || !WS.webOk()) { S.pubMsg = '⚠ not online (or Kelly is running from a file) -- save the file and upload it another way'; dirty('igate'); return; }
      S.pubMsg = `Uploading version ${doc.b.v} to kellypage.app…`; dirty('igate');
      const r = await WS.uploadIgateWl({ doc });
      S.pubMsg = r.ok ? `✓ kellypage.app now serves club list v${r.v}${r.same ? ' (it already had this one)' : ''}` : `⚠ kellypage.app refused it: ${r.error}`;
      dirty('igate');
    }
    // ---------------------------------------------------------------- shared devices over P25 (2026-10-31)
    function cmReply(j) {
      if (j.put) {
        takeAsk('cmput');
        if (j.ok) {
          cm.sent = Object.assign({}, S.cmSending || {}, { at: Date.now(), v: j.v, n: j.n });
          const ref = (j.refused || []).map(r => `${String(r.k).slice(0, 8)}: ${r.why}`);
          cm.msg = `✓ the P25X gateway shares ${j.n} of your device${j.n === 1 ? '' : 's'} with every P25X Kelly${ref.length ? ` · not shared: ${ref.join('; ')}` : ''}`;
          toast('📡', j.n ? `${j.n} device${j.n === 1 ? '' : 's'} shared` : 'Stopped sharing', j.n ? 'Every P25X Kelly iGate gets them on its next check' : 'Your devices leave the shared list', 'good');
          if (j.v > cm.v) checkCm(false);
        } else cm.msg = `⚠ ${j.error || 'the gateway refused it'}`;
        S.cmSending = null; saveCm(); dirty('igate'); return;
      }
      if (j.notify) { if ((Number(j.v) || 0) > cm.v) checkCm(false); return; }   // a push: the shared list changed
      takeAsk('cm');
      cm.checked = Date.now();
      if (j.error) cm.error = j.error;
      else if (j.cur) { cm.error = ''; cm.at = Date.now(); }
      else if (Array.isArray(j.e)) {
        const e = j.e.map(x => W.normEntry(x)).filter(Boolean);   // the same entry rules as the club list
        Object.assign(cm, { v: Number(j.v) || 0, e, at: Date.now(), error: '' });
        addEvent('network', `APRS iGate shared devices v${cm.v} (${e.length} stations) from the P25X gateway`);
        mergeComm();
      }
      saveCm(); dirty('igate');
    }
    async function checkCm(manual) {
      if (!k.radioConnected() || k.demo()) { if (manual) toast('📻', 'Connect the radio first', 'Shared devices come from the P25X gateway over P25 -- without P25, swap 🔳 QR cards', 'bad'); return; }
      if ([...S.asks.values()].some(a => a.kind === 'cm')) return;
      cm.checked = Date.now(); saveCm();
      const xid = await k.kfRequest({ op: 'igcm', have: cm.v }, 'APRS iGate: any newly shared devices?');
      if (xid) S.asks.set(xid, { kind: 'cm', at: Date.now() });
      dirty('igate');
    }
    async function shareMine(stop) {
      if (!k.radioConnected() || k.demo()) { toast('📻', 'Connect the radio first', 'Sharing goes to the P25X gateway over P25 -- without P25, show your 🔳 QR card instead', 'bad'); return; }
      if (!I.validBase(String(s.call || '').toUpperCase())) { toast('⚠️', 'Set your callsign first', 'APRS iGate › Callsign', 'bad'); return; }
      if ([...S.asks.values()].some(a => a.kind === 'cmput')) return;
      const e = stop ? [] : myShare();
      if (!stop && !e.length) { toast('🗼', 'Nothing to share', `Your list has no enabled device under ${String(s.call).toUpperCase()}`, 'bad'); return; }
      S.cmSending = { sig: shareSig(e) };
      const xid = await k.kfRequest({ op: 'igcmput', e }, stop ? 'APRS iGate: stop sharing my devices' : `APRS iGate: sharing my ${e.length} device(s)`);
      if (xid) { S.asks.set(xid, { kind: 'cmput', at: Date.now() }); cm.msg = 'Sending to the P25X gateway…'; }
      dirty('igate');
    }

    // any source: the signature decides
    function take(doc, src, quiet) {
      if (!W || !ed) return false;
      const r = W.accept(wl.doc, doc, ed);
      if (r.ok) {
        Object.assign(wl, { doc: r.doc, src, at: Date.now(), error: '' }); saveWl();
        addEvent('network', `APRS iGate club list v${r.doc.b.v} (${r.doc.b.e.length} stations) from ${src}`);
        toast('🔐', `iGate club list v${r.doc.b.v}`, `${r.doc.b.e.length} stations · from ${src}`, 'good');
        if (S.draft && S.draft.base < r.doc.b.v) S.draft = null;
        mergeClub();
        return true;
      }
      if (r.same) { wl.at = Date.now(); wl.error = ''; saveWl(); return true; }
      if (quiet && r.older) return false;   // kellypage.app is behind what we already hold: nothing to say
      wl.error = `${src}: ${r.error}`; saveWl();
      if (!quiet) toast('⚠️', 'Club list not accepted', r.error, 'bad');
      return false;
    }

    // ---------------------------------------------------------------- admin: the key and the club-list draft
    const idb = (mode, fn) => new Promise((res, rej) => {
      const o = indexedDB.open('kelly-igate', 1);
      o.onupgradeneeded = () => o.result.createObjectStore('keys');
      o.onerror = () => rej(o.error);
      o.onsuccess = () => { const tx = o.result.transaction('keys', mode), r = fn(tx.objectStore('keys')); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); };
    });
    async function loadAdmin() {
      try { const seed = await idb('readonly', st => st.get('admin')); setAdmin(seed || null, false); } catch { S.admin = null; }
    }
    function setAdmin(seedHex, persist = true) {
      if (!seedHex) { S.admin = null; if (persist) idb('readwrite', st => st.delete('admin')).catch(() => {}); dirty('igate'); return; }
      const signer = ed.signer(W.unhex(seedHex));
      S.admin = { signer, pub: W.hex(signer.publicKey), pinned: W.ADMIN_KEYS.includes(W.hex(signer.publicKey)) };
      if (persist) idb('readwrite', st => st.put(seedHex, 'admin')).catch(e => toast('⚠️', "Couldn't keep the admin key", e.message, 'bad'));
      dirty('igate');
    }
    const draft = () => S.draft || (S.draft = { base: version(), e: (wl.doc ? wl.doc.b.e : []).map(x => ({ ...x })) });
    function publish(toGateway) {
      if (!S.admin) return;
      const by = I.validBase(String(settings.myCall || '').toUpperCase()) ? String(settings.myCall).toUpperCase() : '';
      let doc;
      try { doc = W.sign({ v: version() + 1, at: Math.floor(Date.now() / 1000), by, e: draft().e }, S.admin.signer); }
      catch (e) { S.pubMsg = `⚠ ${e.message}`; dirty('igate'); return; }
      if (!S.admin.pinned) S.pubMsg = '⚠ signed, but this key is not pinned in js/igate-wl.js ADMIN_KEYS yet -- no station (this one included) will accept it';
      else { take(doc, 'this Kelly (admin)'); S.draft = null; }
      if (toGateway === 'web') uploadWeb(doc);
      else if (toGateway) {
        if (!k.radioConnected() || k.demo()) { S.pubMsg = '⚠ connect the radio to publish over P25 -- or save the file and upload it on the dashboard'; dirty('igate'); return; }
        k.kfRequest({ op: 'igwlput', doc }, `APRS iGate: publishing club list v${doc.b.v}`).then(xid => { if (xid) S.asks.set(xid, { kind: 'put', at: Date.now() }); });
        if (S.admin.pinned) S.pubMsg = `Sending version ${doc.b.v} to the P25X gateway…`;
      } else download(`igate-club-list-v${doc.b.v}.json`, doc);
      dirty('igate');
    }
    function download(name, obj) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' })); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    // ---------------------------------------------------------------- own beacon + polls (MeshCore)
    async function ownBeacon(manual) {
      const L = link(), sess = L && L.online() && L.session();
      if (!sess) { if (manual) toast('🕸️', 'Connect your MeshCore node first', 'LoRa Mesh page', 'bad'); return; }
      if (S.ownBusy) return;
      S.ownBusy = true;
      try {
        let pos = null;
        if (s.own.src === 'kelly') {
          const p = k.myPos();
          if (!p) { if (manual) toast('📍', 'Kelly has no position', 'GPS › Fixed position, or a GPS fix', 'bad'); return; }
          const r = pos = I.roundPos(+p.lat, +p.lon, +s.own.places);
          await sess.sharePosition(r.lat, r.lon);
        }
        await sess.advert(!!s.own.flood);
        if (s.mprs.send && M) try { await ownFrame(sess, pos); } catch (e) { log('drop', `MeshPRS frame failed: ${e.message}`); }
        s.own.lastAt = Date.now(); saveSoon('settings');
        gate.stats.own(); statsDirty = true;
        log('out', `own beacon: ${s.own.flood ? 'flood' : 'zero-hop'} advert${s.own.src === 'kelly' ? ` at ${s.own.places} decimal places` : ' (node GPS)'}`);
      } catch (e) { log('drop', `own beacon failed: ${e.message}`); if (manual) toast('⚠️', 'Beacon not sent', e.message, 'bad'); }
      finally { S.ownBusy = false; dirty('igate'); }
    }
    // decision 0016: the beacon also goes out as a MeshPRS Position frame (K set) on #meshprs. The node must hold the
    // channel; the seq counter is kept per node key across restarts (spec §9.3; a key seen first starts at random)
    async function ownFrame(sess, pos) {
      const L = link(), key = L && L.selfKey(), slot = mprsSlot(), src = I.fullCall(s.call, s.mprs.ssid);
      if (!slot) { log('drop', 'MeshPRS frame not sent: the node has no #meshprs channel (MeshPRS frames card)'); return; }
      if (!key || !src) { log('drop', 'MeshPRS frame not sent: it needs the node\'s key and my callsign'); return; }
      if (!pos) { const me = (L.nodes() || []).find(n => n.key === key); pos = me && me.lat != null ? { lat: me.lat, lon: me.lon } : null; }
      if (!pos) { log('drop', 'MeshPRS frame not sent: no position'); return; }
      const seqs = store.get('mprsSeq', {}) || {};
      const seq = seqs[key] = ((seqs[key] === undefined ? Math.floor(Math.random() * 256) : seqs[key]) + 1) & 255;
      store.set('mprsSeq', seqs);
      const blob = M.encode({ src, key: key.slice(0, 8), subtype: 0, seq, lat: M.degToRaw(+pos.lat, 90), lon: M.degToRaw(+pos.lon, 180),
        sym: I.validSymbol(s.mprs.sym) ? s.mprs.sym : '/-', amb: 0, msg: 0, comment: String(s.mprs.comment || '').replace(/[^\x20-\x7e]|[|~]/g, '').trim().slice(0, 23) });
      await sess.sendChannelData(slot.index, M.DATA_TYPE, blob, { flood: !!s.own.flood });
      log('out', `MeshPRS position frame as ${src} (${s.own.flood ? 'flood' : 'zero-hop'}, seq ${seq}, ${blob.length} bytes): ${M.hex(blob)}`);
    }
    const ownEveryMin = () => Math.max(+s.own.everyMin || 0, s.own.flood ? I.OWN_MIN_MIN.flood : I.OWN_MIN_MIN.zero);
    const usesSt = map => I.slots(map).a.concat(I.slots(map).b).some(x => x && String(x.src).startsWith('st:'));
    const usesLpp = map => I.slots(map).a.concat(I.slots(map).b).some(x => x && String(x.src).startsWith('lpp:'));
    // one node's readings: its telemetry (CayenneLPP) and, for a repeater / room server or when asked, its status
    async function readNode(sess, node, wantLpp, wantSt) {
      const out = { lpp: null, st: null, errs: [] };
      if (wantLpp) try { out.lpp = await sess.telemetry(node); } catch (e) { out.errs.push(`telemetry: ${e.message}`); }
      if (wantSt && sess.status) try { out.st = await sess.status(node); if (!out.st) out.errs.push('status: no answer'); } catch (e) { out.errs.push(`status: ${e.message} (log in to it on the LoRa Mesh page if it needs a password)`); }
      out.rs = I.readings(out.lpp, out.st);
      S.reads.set(node.key, { at: Date.now(), rs: out.rs, errs: out.errs });
      return out;
    }
    // every 30 s at most ONE request: the most overdue of the position polls (settings.igate.poll) and the per-device
    // telemetry polls -- only for listed, enabled nodes the companion has a DIRECT route to (no floods on a shared mesh)
    async function pollOne() {
      const L = link(), sess = L && L.online() && L.session();
      if (!s.on || !sess || !sess.telemetry || S.ownBusy) return;
      const now = Date.now(), nodes = contacts(), jobs = [];
      for (const x of list.e) {
        const n = nodes.get(x.k); if (!x.e || !n || !n.outPath) continue;
        if (x.t && x.t.on && x.t.map) { const every = Math.max(TLM_MIN_MIN, +x.t.every || 15) * 60000, late = now - (S.tpolled.get(x.k) || 0) - every; if (late >= 0) jobs.push({ x, n, late, tlm: true }); }
        if (s.poll) { const every = Math.max(10, +s.pollMin || 15) * 60000, late = now - (S.polled.get(x.k) || 0) - every; if (late >= 0) jobs.push({ x, n, late, tlm: false }); }
      }
      if (!jobs.length) return;
      const j = jobs.sort((a, b) => b.late - a.late)[0], x = j.x;
      S.polled.set(x.k, now); if (j.tlm) S.tpolled.set(x.k, now);
      const map = j.tlm ? x.t.map : null;
      const r = await readNode(sess, j.n, !map || usesLpp(map) || s.poll, !!map && usesSt(map));
      const g = (r.lpp || []).find(y => y.name === 'gps');
      if (g) feed('telemetry', { key: x.k, lat: g.lat, lon: g.lon, at: Date.now() });
      else if (!j.tlm) log('drop', `${srcOf(x)}: telemetry has no GPS (is its GPS on, and telemetry allowed to us?)`);
      if (r.errs.length) log('drop', `${srcOf(x)}: ${r.errs.join('; ')}`);
      if (map) queueTlm(x, r.rs);
      dirty('igate');
    }

    // ---------------------------------------------------------------- the telemetry editor (one device at a time)
    const allTypes = () => [...I.PRESETS, ...myTypes()];
    const copyMap = m => JSON.parse(JSON.stringify({ a: I.slots(m).a, b: I.slots(m).b, title: (m && m.title) || '' }));
    function openTlm(x) {
      const t = x.t || {};
      S.t = { k: x.k, type: t.type || '', on: t.on !== false, every: +t.every || 15, map: copyMap(t.map || { a: [], b: [] }) };
      $('#ig-t').hidden = false; $('#ig-t').scrollIntoView({ block: 'nearest' });
      fillTlm(); renderTlm();
    }
    function applyType(id) {
      const p = allTypes().find(y => y.id === id); if (!p || !S.t) return;
      S.t.type = id; S.t.map = copyMap(Object.assign({ title: S.t.map.title }, p));
      fillTlm(); renderTlm();
    }
    function srcOptions() {
      const rs = S.t ? ((S.reads.get(S.t.k) || {}).rs || []) : [], seen = new Set(), o = [];
      const add = (id, label) => { if (!id || seen.has(id)) return; seen.add(id); o.push([id, label]); };
      for (const r of rs) add(r.id, `${r.label}: ${r.value} ${r.unit}`.trim());
      for (const [id, [label, unit]] of Object.entries(I.ST)) add(`st:${id}`, `status: ${label}${unit ? ` (${unit})` : ''}`);
      for (const [t, name, unit] of LPP_ANY) add(`lpp:*:${t}`, `first ${name} (${unit}), any channel`);
      if (S.t) for (const y of [...S.t.map.a, ...S.t.map.b]) if (y) add(y.src, y.src);
      return o;
    }
    // builds the slot rows from S.t (on open / a type picked / a read) -- typing then edits S.t directly
    function fillTlm() {
      const x = byKey(S.t.k); if (!x) return;
      $('#ig-t-title').textContent = `📈 Telemetry for ${srcOf(x)}`;
      $('#ig-t-type').innerHTML = '<option value="">— pick a device type —</option>' + allTypes().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      $('#ig-t-type').value = S.t.type; $('#ig-t-on').checked = S.t.on; $('#ig-t-every').value = S.t.every; $('#ig-t-name').value = S.t.map.title || '';
      const opts = srcOptions(), sel = v => `<option value="">— none —</option>` + opts.map(([id, l]) => `<option value="${esc(id)}"${id === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
      $('#ig-t-a').innerHTML = S.t.map.a.map((y, i) => `<tr data-a="${i}"><td>A${i + 1}</td><td><select data-f="src">${sel(y && y.src)}</select></td>
        <td><input data-f="name" maxlength="7" value="${esc(y ? y.name : '')}"></td><td><input data-f="unit" maxlength="7" value="${esc(y ? y.unit : '')}"></td>
        <td><input data-f="min" type="number" step="any" value="${y ? esc(String(y.min)) : ''}"></td><td><input data-f="max" type="number" step="any" value="${y ? esc(String(y.max)) : ''}"></td><td class="mono small" data-now></td></tr>`).join('');
      $('#ig-t-b').innerHTML = S.t.map.b.map((y, i) => `<tr data-b="${i}"><td>B${i + 1}</td><td><select data-f="src">${sel(y && y.src)}</select></td>
        <td><select data-f="op"><option value="<"${y && y.op === '<' ? ' selected' : ''}>below</option><option value=">"${y && y.op === '>' ? ' selected' : ''}>above</option></select></td>
        <td><input data-f="v" type="number" step="any" value="${y ? esc(String(y.v)) : ''}"></td><td><input data-f="name" maxlength="6" value="${esc(y ? y.name : '')}"></td><td class="mono small" data-now></td></tr>`).join('');
    }
    function editSlot(tr, f, val) {
      const isA = tr.dataset.a != null, i = +(isA ? tr.dataset.a : tr.dataset.b), arr = isA ? S.t.map.a : S.t.map.b;
      const y = arr[i] || (arr[i] = isA ? { src: '', name: '', unit: '', min: 0, max: 255 } : { src: '', op: '<', v: 0, name: '' });
      if (f === 'src') {
        y.src = val;
        if (!val) { arr[i] = null; fillTlm(); }
        else if (!y.name) {   // a new slot: start from the reading's own name and unit
          const r = ((S.reads.get(S.t.k) || {}).rs || []).find(z => z.id === val), st = /^st:(\w+)$/.exec(val), lp = /^lpp:\*:(\d+)$/.exec(val);
          const nm = r ? r.label.replace(/^ch \d+ /, '') : st && I.ST[st[1]] ? I.ST[st[1]][0] : lp ? (LPP_ANY.find(z => String(z[0]) === lp[1]) || [0, ''])[1] : '';
          y.name = nm.replace(/(^|\s)\w/g, c => c.toUpperCase()).replace(/\s+/g, '').slice(0, isA ? 7 : 6);
          if (isA) y.unit = (r ? r.unit : st && I.ST[st[1]] ? I.ST[st[1]][1] : lp ? (LPP_ANY.find(z => String(z[0]) === lp[1]) || [0, 0, ''])[2] : '').replace('°', 'deg');
          fillTlm();
        }
      } else if (f === 'min' || f === 'max' || f === 'v') y[f] = val === '' ? '' : +val;
      else y[f] = val;
      renderTlm();
    }
    function renderTlm() {
      if (!S.t || $('#ig-t').hidden) return;
      const x = byKey(S.t.k); if (!x) { $('#ig-t').hidden = true; S.t = null; return; }
      const rd = S.reads.get(S.t.k), rs = (rd && rd.rs) || [];
      $('#ig-t-reads').innerHTML = rd ? (rs.length ? rs.map(r => `<tr><td class="mono small">${esc(r.id)}</td><td>${esc(r.label)}</td><td class="mono">${esc(String(r.value))} ${esc(r.unit)}</td></tr>`).join('') : '<tr><td colspan="3" class="dim">It answered with no readings.</td></tr>')
        + (rd.errs.length ? `<tr><td colspan="3" class="bad-txt small">${esc(rd.errs.join(' · '))}</td></tr>` : '') + `<tr><td colspan="3" class="dim small">read ${esc(fmtAgo(rd.at))}</td></tr>`
        : '<tr><td colspan="3" class="dim">Press <b>Read the node now</b> to see what it reports.</td></tr>';
      const v = I.tlmValues(S.t.map, rs);
      document.querySelectorAll('#ig-t-a tr').forEach((tr, i) => { const y = S.t.map.a[i], raw = v.a[i]; tr.querySelector('[data-now]').textContent = !y ? '' : raw == null ? '—' : `${raw} = ${Math.round((+y.min + raw * (+y.max - +y.min) / 255) * 1000) / 1000}`; });
      document.querySelectorAll('#ig-t-b tr').forEach((tr, i) => { tr.querySelector('[data-now]').textContent = S.t.map.b[i] ? (v.b[i] === '1' ? 'on' : 'off') : ''; });
      const src = srcOf(x), lines = [`${src}>${I.TOCALL},qAO,${call() || 'NOCALL'}:${I.tlmBody(I.seqNow(), v.a, v.b)}`, ...I.tlmDefs(src, S.t.map).map(b => `${src}>${I.TOCALL},qAO,${call() || 'NOCALL'}:${b}`)];
      $('#ig-t-prev').textContent = lines.join('\n');
      const bad = S.t.map.a.find(y => y && !(+y.max > +y.min));
      $('#ig-t-msg').innerHTML = bad ? `<span class="bad-txt">${esc(bad.name || bad.src)}: max must be above min</span>`
        : !contacts().get(S.t.k) ? '<span class="bad-txt">This node isn\'t in your MeshCore contacts yet -- it can\'t be read until it is.</span>'
        : !contacts().get(S.t.k).outPath ? '<span class="warn-txt">No direct route to this node yet: it is only polled once the companion has one (no floods). Read it once by hand, or send it a message first.</span>'
        : `Each value goes out as 0-255 across min..max; aprs.fi scales it back. Polled every ${Math.max(TLM_MIN_MIN, +S.t.every || 15)} min while the iGate is on.`;
    }
    async function readNow() {
      const L = link(), sess = L && L.online() && L.session(), n = S.t && contacts().get(S.t.k);
      if (!sess) { toast('🕸️', 'Connect your MeshCore node first', 'LoRa Mesh page', 'bad'); return; }
      if (!n) { toast('🕸️', 'Not in your contacts', 'The node has to be a MeshCore contact', 'bad'); return; }
      $('#ig-t-read').disabled = true; $('#ig-t-read').textContent = 'Reading…';
      try { await readNode(sess, n, true, true); } finally { $('#ig-t-read').disabled = false; $('#ig-t-read').textContent = 'Read the node now'; }
      fillTlm(); renderTlm();
    }
    function saveTlm() {
      const x = byKey(S.t.k); if (!x) return;
      const map = copyMap(S.t.map);
      if (map.a.some(y => y && !(+y.max > +y.min))) { toast('⚠️', 'Check the ranges', 'Each value needs max above min', 'bad'); return; }
      x.t = { type: S.t.type, on: S.t.on, every: Math.max(TLM_MIN_MIN, +S.t.every || 15), map }; x.ed = true;
      delete list.tlm[x.k];   // definitions go again with the next report
      S.tpolled.delete(x.k); saveList();
      toast('📈', `Telemetry saved for ${srcOf(x)}`, S.t.on ? 'Sent with its next poll' : 'Off for now', 'good');
      dirty('igate');
    }
    function saveType() {
      const name = (prompt('Name this device type (it appears in the list for your other devices):', '') || '').trim().slice(0, 40); if (!name) return;
      const mine = myTypes().filter(p => p.name !== name);
      mine.push(Object.assign({ id: `my-${Date.now().toString(36)}`, name }, copyMap(S.t.map)));
      store.set('igatePresets', mine); S.t.type = mine[mine.length - 1].id; fillTlm(); renderTlm();
      toast('💾', `Device type "${name}" saved`, 'Pick it for any device of the same kind', 'good');
    }

    // ---------------------------------------------------------------- render
    const ago = t => (t ? fmtAgo(t) : 'never');
    const dur = sec => (sec >= 86400 ? `${Math.floor(sec / 86400)} d ${Math.floor(sec % 86400 / 3600)} h` : sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.floor(sec % 3600 / 60)} min` : `${Math.floor(sec / 60)} min`);
    const symLabel = y => (SYMBOLS.find(z => z[0] === y) || [y, y])[1];
    function render() {
      const v = gate.stats.view(), b = S.bridge, c = call();
      const listed = list.e.filter(x => x.e).length;
      // header
      // privacy on but no home position: the bridge HOLDS every own-station position -- say so loudly (2026-11-01:
      // a PC copy held the Mesh Buddy's positions for hours with only a dim note to show for it)
      const privHeld = !!(s.on && s.privacy && b && b.privacy && !b.privacy.home);
      const st = !s.on ? ['off', ''] : !c ? ['needs a callsign', 'warn'] : !listed ? ['my list is empty', 'warn'] : !bridgeUp() ? ['no Kelly bridge', 'bad'] : privHeld ? ['own positions HELD', 'bad'] : s.dry ? ['dry run', 'warn'] : ['gating', 'ok'];

      $('#ig-state').textContent = st[0]; $('#ig-state').className = `tag ${st[1]}`;
      // privacy zone: done in the bridge (the last stop before APRS-IS); inside the zone round home one fixed spot, outside exact
      const pv = b && b.privacy, dir = d => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
      $('#ig-priv-info').textContent = !s.privacy ? `off -- every ${c ? c.split('-')[0] : 'my'} station shows exactly where it is, home included`
        : !pv ? 'needs the Kelly bridge (it applies the zone)'
        : !pv.home ? `⚠️ ON, BUT KELLY HAS NO HOME POSITION: my own stations are HELD (not sent to aprs.fi) until it has one -- set GPS › Fixed position, or turn the privacy zone off`
        : pv.bearing == null ? `on -- near home every ${pv.base}-SSID shows at one spot (picked with the first position); away from home, exact`
        : `on -- within ${Math.round(pv.zoneM)} m of a point ${Math.round(pv.dist)} m ${dir(pv.bearing)} of home every ${pv.base}-SSID shows parked at that point; further out, exact`;
      $('#ig-priv-info').className = `small ${privHeld ? 'bad-txt' : 'dim'}`;
      $('#ig-priv-new').hidden = !s.privacy;
      $('#ig-err').hidden = !(s.on && S.bridgeErr); $('#ig-err').textContent = S.bridgeErr ? `Kelly bridge: ${S.bridgeErr}` : '';
      // live counters
      const conn = b ? { t: { up: 'Connected', dry: 'Dry run', off: 'Off', connecting: 'Connecting…', verifying: 'Logging in…', waiting: 'Reconnecting', unverified: 'Not verified' }[b.state] || b.state,
          d: b.state === 'up' ? `${esc(b.server)} · verified · up ${dur(b.uptime)}` : b.state === 'waiting' || b.state === 'unverified' ? `${esc(b.error || '')} · retry in ${b.retryIn} s` : b.state === 'dry' ? 'logs only, never connects' : esc(b.server || ''),
          cls: b.state === 'up' ? 'ok' : b.state === 'unverified' ? 'bad' : 'warn' }
        : { t: 'No bridge', d: 'run bridge/kelly_bridge.py -- the iGate goes out through its internet', cls: 'warn' };
      const kpi = (label, val, sub, cls = '') => `<div class="ig-kpi ${cls}"><span>${label}</span><b>${val}</b><em>${sub}</em></div>`;
      $('#ig-kpis').innerHTML = [
        kpi('APRS-IS', esc(conn.t), conn.d, conn.cls),
        kpi('Gated', v.gated, `${v.lastHour} last hour · ${v.today} today`),
        kpi('Telemetry', v.tlm.n, v.tlm.at ? `last ${ago(v.tlm.at)}` : 'none sent yet'),
        kpi('Heard (MeshCore)', v.heard, `since ${new Date(v.since).toLocaleDateString()}`),
        ...Object.entries(DROP_LABEL).map(([kk, l]) => kpi(l, v.drops[kk], 'dropped', v.drops[kk] ? 'dim2' : '')),
        kpi('Own beacon', v.own.n, v.own.at ? `last ${ago(v.own.at)}` : 'not sent yet'),
      ].join('');
      // callsign
      $('#ig-preview').textContent = c || '—';
      $('#ig-call-msg').innerHTML = !s.call ? '<span class="bad-txt">Your callsign, e.g. VK4XXX</span>' : !I.validBase(String(s.call).toUpperCase()) ? '<span class="bad-txt">That doesn\'t look like a callsign (1-3 prefix characters, a digit, 1-4 letters)</span>'
        : `Logs in as <b class="mono">${esc(c)}</b> · packets look like <span class="mono">TRACKER-9&gt;${I.TOCALL},qAO,${esc(c)}:!…</span>`;
      // stations
      const rows = Object.entries(v.stations).sort((a, b2) => Math.max(b2[1].at || 0, b2[1].tlmAt || 0) - Math.max(a[1].at || 0, a[1].tlmAt || 0));
      $('#ig-stations').innerHTML = rows.length ? rows.map(([key, x]) => `<tr><td class="mono"><b>${esc(x.call)}</b><br><span class="dim small">${esc(key.slice(0, 12))}…</span></td>
        <td>${esc(ago(Math.max(x.at || 0, x.tlmAt || 0)))}</td><td>${x.n}</td><td class="mono small ig-raw">${esc(x.raw || '')}${x.tlmRaw ? `<br><span class="dim">${esc(x.tlmRaw)}</span>` : ''}</td><td><a class="btn small" href="${esc(I.aprsFiUrl(x.call))}" target="_blank" rel="noopener">aprs.fi ↗</a></td></tr>`).join('')
        : '<tr><td colspan="5" class="dim">Nothing gated yet.</td></tr>';
      renderList();
      renderTlm();
      renderWl();
      renderCm();
      renderOwn();
      renderMprs();
      $('#ig-log').innerHTML = [...S.log.map(x => `<div class="ig-l ${x.t}"><span>${esc(new Date(x.at).toLocaleTimeString())}</span> ${esc(x.line)}</div>`),
        ...(b && b.log ? b.log.slice().reverse().slice(0, 15).map(([t, line]) => `<div class="ig-l br"><span>${esc(new Date(t * 1000).toLocaleTimeString())}</span> bridge ${esc(line)}</div>`) : [])].join('') || '<div class="dim">Nothing yet.</div>';
      if (k.navBadge) k.navBadge('igate', s.on && st[1] === 'bad' ? '!' : '');
    }
    function renderList() {
      const nodes = contacts(), off = offers(), nT = list.e.filter(x => x.t && x.t.on).length;
      $('#ig-l-tag').textContent = `${list.e.filter(x => x.e).length} on · ${nT} with telemetry`;
      $('#ig-l-offers').hidden = !off.length;
      $('#ig-l-offer-rows').innerHTML = off.map(o => `<tr><td class="mono"><b>${esc(o.c)}-${o.s}</b></td><td>${esc(o.n.longName)}<br><span class="dim small mono">${esc(o.n.key.slice(0, 16))}… · ${esc(o.n.hwLabel || '')}</span></td>
        <td>${esc(symLabel(o.y))}</td><td><button class="btn small" data-ig-offer="${esc(o.n.key)}">Add</button> <button class="btn small ghost" data-ig-dismiss="${esc(o.n.key)}">Dismiss</button></td></tr>`).join('');
      $('#ig-l-rows').innerHTML = list.e.length ? list.e.map((x, i) => {
        const n = nodes.get(x.k), t = x.t && x.t.on ? (allTypes().find(p => p.id === x.t.type) || { name: 'custom' }).name : '';
        return `<tr class="${x.e ? '' : 'dim'}"><td class="mono"><b>${esc(x.c)}-${x.s}</b></td>
        <td>${n ? esc(n.longName || '') : '<span class="dim">not in contacts</span>'}<br><span class="dim small mono">${esc(x.k.slice(0, 16))}…</span></td>
        <td>${esc(symLabel(x.y))}</td><td>${esc(x.m || '')}</td><td class="small">${esc(FROM[x.src] || x.src)}${(x.src === 'club' || x.src === 'comm') && x.ed ? ' (edited)' : ''}${x.src === 'comm' && x.by ? ` <span class="dim">by ${esc(x.by)}</span>` : ''}${x.src === 'card' && nodeName(x.k) == null ? ' <span class="dim">· not heard yet</span>' : ''}</td>
        <td class="small">${t ? `📈 ${esc(t)}` : '<span class="dim">off</span>'}</td>
        <td class="ig-acts"><button class="btn small" data-ig-l-qr="${i}" title="Show its QR card -- another ham scans it to gate this device too">🔳</button> <button class="btn small" data-ig-l-edit="${i}">Edit</button> <button class="btn small" data-ig-l-tlm="${i}">Telemetry</button> <button class="btn small" data-ig-l-tog="${i}">${x.e ? 'Disable' : 'Enable'}</button> <button class="btn small" data-ig-l-del="${i}" title="Remove">✕</button></td></tr>`;
      }).join('') : '<tr><td colspan="7" class="dim">Nothing on your list yet: add a node below, take one of the offered nodes, or get the club list.</td></tr>';
      const sel = $('#ig-l-contact'), optSig = [...nodes.keys()].join();
      if (sel.dataset.sig !== optSig) {
        sel.dataset.sig = optSig;
        const az = [...nodes.values()].sort((a, b) => String(a.longName || a.key).localeCompare(String(b.longName || b.key)));
        sel.innerHTML = '<option value="">— pick a MeshCore contact (A-Z) —</option>' + az.map(n => `<option value="${esc(n.key)}">${esc(n.longName || n.key.slice(0, 8))} · ${esc(n.key.slice(0, 8))}</option>`).join('');
      }
      renderFind();
    }

    // ---------------------------------------------------------------- 🔎 Add my device (first-time setup, 2026-10-31)
    // Every node this Kelly has heard (contacts and advert-only ones), searchable, newest first. Pinned to the top: nodes
    // that appeared after "Listen for it", then MeshPRS senders, then nodes with a GPS position. "This is mine" opens a
    // prefilled card (callsign / SSID / symbol from its MeshPRS frame, else its node name) -> one click onto my list.
    const FIND_RECENT_MS = 30 * 60000, LISTEN_MS = 3 * 60000, FIND_ROWS = 8;
    const TYPE_ICON = { 1: '📱', 2: '📡', 3: '🏠', 4: '🌡️' };
    const symGuess = (name, role) => {
      const t = String(name || '').toLowerCase();
      return /bike|bicycle|cycl/.test(t) ? '/b' : /walk|hike|foot/.test(t) ? '/[' : /boat|kayak|yacht/.test(t) ? '/s' : /balloon/.test(t) ? '/O'
        : /car|ute|mobile|truck|van/.test(t) ? '/>' : role === 2 ? '/r' : role === 3 ? '/-' : '/>';
    };
    const nodesHeard = () => ((link() && link().nodes()) || []).filter(n => n && n.key);
    // HAM ONLY (2026-10-31: "we cannot gate non-ham station names into aprs.fi under any circumstance"): a node
    // is an amateur's only when the FIRST or SECOND word of its name is a VK / ZL amateur callsign (igate.js callFromName), and any MeshPRS
    // frames it sends claim that same callsign. It may be listed under that callsign only -- never one typed freely. The
    // same test runs again on every line at gate time (club list included) and once more in the bridge (kelly_igate.py).
    function hamCallOf(key, name) {
      const cs = I.callFromName(name || ''); if (!cs) return null;
      const mp = mprsHeard.get(String(key || '').toLowerCase().slice(0, 8));
      return mp && mp.src.split('-')[0] !== cs.base ? null : cs.base;   // MeshPRS frames claiming another call: refused
    }
    const nodeName = key => { const n = nodesHeard().find(x => x.key.toLowerCase() === String(key || '').toLowerCase()); return n ? n.longName || '' : null; };
    function candidates() {
      const L = link(), self = String((L && L.selfKey && L.selfKey()) || '').toLowerCase(), now = Date.now(), F = S.find, q = F.q.trim().toLowerCase();
      const out = []; F.hidden = 0;
      for (const n of nodesHeard()) {
        const key = n.key.toLowerCase(); if (key === self) continue;
        const mp = mprsHeard.get(key.slice(0, 8)), heard = Math.max(n.lastHeard || 0, n.advAt || 0, mp ? mp.at : 0), cs = I.callFromName(n.longName);
        if (q) { if (!`${n.longName || ''} ${key} ${mp ? mp.src : ''} ${cs ? cs.base : ''}`.toLowerCase().includes(q)) continue; }
        else if (now - heard > FIND_RECENT_MS) continue;
        if (!hamCallOf(key, n.longName)) { F.hidden++; continue; }   // not an amateur's node: never offered
        const fresh = !!F.listenAt && ((n.advAt || 0) > F.listenAt || (!!mp && mp.at > F.listenAt));
        out.push({ n, key, mp, heard, fresh, on: byKey(key), score: (fresh ? 4e13 : 0) + (mp ? 2e13 : 0) + (n.lat != null ? 1e13 : 0) + heard });
      }
      return out.sort((a, b) => b.score - a.score);
    }
    function stopListen() { const F = S.find; if (F.t) clearInterval(F.t); F.t = null; F.listenAt = 0; }
    function renderFind() {
      const box = $('#ig-find-rows'); if (!box) return;
      const F = S.find, L = link(), left = F.listenAt ? Math.round((F.listenAt + LISTEN_MS - Date.now()) / 1000) : 0;
      if (F.listenAt && left <= 0) stopListen();
      $('#ig-find-listen').textContent = F.listenAt ? `⏹ Stop listening (${left} s)` : '📡 Listen for it';
      const hint = $('#ig-find-hint');
      hint.hidden = !!L && !F.listenAt;
      hint.innerHTML = !L ? '⚠️ Connect your MeshCore node on the <b>LoRa Mesh</b> page first -- Kelly can only list what your node hears.'
        : '📡 <b>Listening…</b> Switch your device off, then on again. It sends an advert as it starts and pops up here with ✨ as soon as your node hears it.';
      const c = candidates(), shown = F.more ? c : c.slice(0, FIND_ROWS);
      box.innerHTML = shown.length ? shown.map(x => {
        const n = x.n, direct = n.advHops === 0 || (n.directAt && Date.now() - n.directAt < FIND_RECENT_MS);
        const sig = direct ? `heard direct${n.directSnr != null ? `, SNR ${n.directSnr} dB` : ''}` : n.advHops != null ? `${n.advHops} hop${n.advHops === 1 ? '' : 's'} away` : '';
        return `<div class="ig-find-row${x.fresh ? ' fresh' : ''}${F.pick && F.pick.key === x.key ? ' sel' : ''}">
          <span class="ig-find-ic">${x.mp ? '🛰️' : TYPE_ICON[n.role] || '📻'}</span>
          <div class="grow"><b>${esc(n.longName || x.key.slice(0, 8))}</b> <span class="mono dim small">${esc(x.key.slice(0, 8))}</span>${x.fresh ? ' <span class="tag good">✨ just appeared</span>' : ''}
            <div class="small dim">${esc(n.hwLabel || 'Node')} · heard ${esc(fmtAgo(x.heard))}${sig ? ` · ${esc(sig)}` : ''}${n.lat != null ? ' · 📍 has a GPS position' : ''}${x.mp ? ` · <b class="ig-find-mp">sends MeshPRS as ${esc(x.mp.src)}</b>` : ''}</div></div>
          ${x.on ? `<span class="small">✓ on your list as <b>${esc(x.on.c)}-${x.on.s}</b></span> <button class="btn small ghost" data-ig-find-edit="${esc(x.key)}">Edit</button>`
            : `<button class="btn small primary" data-ig-find-pick="${esc(x.key)}">This is mine ➜</button>`}</div>`;
      }).join('') + (c.length > FIND_ROWS ? `<button class="btn small ghost" data-ig-find-more>${F.more ? 'Show fewer' : `Show all ${c.length}`}</button>` : '')
        : `<p class="small dim">${F.q ? `No amateur station heard matches “${esc(F.q)}”. Try part of its name, or the first few characters of its key.` : 'No amateur station heard in the last 30 minutes. Switch your device on near your node, or press <b>📡 Listen for it</b>.'}</p>`;
      if (F.hidden) box.insertAdjacentHTML('beforeend', `<p class="small dim">🔒 ${F.hidden} node${F.hidden === 1 ? '' : 's'} hidden: ${F.hidden === 1 ? 'its' : 'their'} name has no VK or ZL amateur callsign as its first or second word -- only amateur stations can go to APRS-IS. Put your callsign first in your device's name (e.g. <b>VK4ABC Bike</b>) to see it here.</p>`);
    }
    function openPick(key) {
      const n = nodesHeard().find(x => x.key.toLowerCase() === key); if (!n) return;
      const mp = mprsHeard.get(key.slice(0, 8)), cs = I.callFromName(n.longName), base = hamCallOf(key, n.longName);
      if (!base) { toast('🔒', 'Not an amateur station', 'Only nodes with a VK or ZL amateur callsign as the first or second word of their name (e.g. VK4ABC Bike) can be gated', 'bad'); return; }
      let ssid = 12;
      if (mp) { const ss = mp.src.split('-')[1]; ssid = /^\d+$/.test(ss || '') && +ss >= 1 && +ss <= 15 ? +ss : 12; }
      else if (cs) ssid = cs.ssid || 12;
      const sym = mp && I.validSymbol(mp.sym) ? mp.sym : symGuess(n.longName, n.role);
      S.find.pick = { key, mp };
      const syms = (SYMBOLS.some(([y]) => y === sym) ? SYMBOLS : SYMBOLS.concat([[sym, `${sym} (from the device)`]])).map(([y, l]) => `<option value="${esc(y)}"${y === sym ? ' selected' : ''}>${esc(l)}</option>`).join('');
      const box = $('#ig-find-pick'); box.hidden = false;
      box.innerHTML = `<div class="ig-find-card"><div><b>➕ Add ${esc(n.longName || key.slice(0, 8))}</b> <span class="mono dim small">${esc(key.slice(0, 16))}…</span></div>
        <p class="small dim">${mp ? `It sends <b>MeshPRS frames as ${esc(mp.src)}</b>. Once its key is on your list, Kelly gates those frames as ${esc(mp.src)} -- with the symbol and comment the device sends.`
          : `It sends adverts${n.lat != null ? ' with a GPS position' : ' (no position heard yet)'}. Kelly gates those under the callsign below.`}</p>
        <div class="row gap wrap"><label class="fld"><span>Callsign 🔒 (from the device)</span><input id="ig-fp-call" maxlength="6" spellcheck="false" value="${esc(base)}" readonly title="Taken from the device's own name or MeshPRS frames -- a station is only ever gated under the callsign it carries"></label>
          <label class="fld"><span>SSID</span><select id="ig-fp-ssid">${Array.from({ length: 15 }, (_, i) => `<option value="${i + 1}"${i + 1 === ssid ? ' selected' : ''}>-${i + 1}</option>`).join('')}</select></label>
          <label class="fld"><span>Symbol</span><select id="ig-fp-sym">${syms}</select></label>
          <label class="fld grow"><span>Comment (optional)</span><input id="ig-fp-comment" maxlength="40"></label></div>
        <div id="ig-fp-warn" class="small ig-find-warn"></div>
        <div class="row gap"><button class="btn primary" id="ig-fp-add">✅ Add to my list</button><button class="btn ghost" id="ig-fp-cancel">Cancel</button></div></div>`;
      const warn = () => { const c = $('#ig-fp-call').value.trim().toUpperCase(), b = mp ? mp.src.split('-')[0] : '';
        $('#ig-fp-warn').textContent = !I.validBase(c) ? 'Enter the owner\'s callsign, without an SSID (e.g. VK4XXX).' : mp && b !== c ? `⚠️ Its frames say ${mp.src}: they're only gated when the callsign here is ${b}.` : ''; };
      $('#ig-fp-call').oninput = warn; warn();
      $('#ig-fp-cancel').onclick = () => { S.find.pick = null; box.hidden = true; renderFind(); };
      $('#ig-fp-add').onclick = () => {
        const x = { k: key, c: $('#ig-fp-call').value.trim().toUpperCase(), s: +$('#ig-fp-ssid').value, y: $('#ig-fp-sym').value,
          m: $('#ig-fp-comment').value.replace(/[^\x20-\x7e]/g, '').replace(/[|~]/g, '').slice(0, 40).trim(), e: 1 };
        if (!I.validBase(x.c) || !(x.s >= 1 && x.s <= 15) || !I.validSymbol(x.y)) { warn(); toast('⚠️', 'Check the callsign', 'The owner\'s callsign without an SSID, e.g. VK4XXX', 'bad'); return; }
        if (!addEntry(x, 'own')) return; S.find.pick = null; box.hidden = true; stopListen();
        toast('🗼', `${mp ? mp.src : `${x.c}-${x.s}`} is on your list`, s.on ? 'Gated whenever your node hears it -- watch it on LoRa Mesh › MeshPRS' : 'Turn the iGate on (above) to start gating it', 'good');
        renderFind();
      };
      renderFind();
      box.scrollIntoView({ block: 'nearest' });
    }
    // from the LoRa Mesh > MeshPRS tab: "Add to my iGate list" on a tracker -> search for it here, and open it if it's the only match
    function findDevice(q) {
      S.find.q = String(q || ''); const el = $('#ig-find-q'); if (el) el.value = S.find.q;
      const c = candidates();
      if (c.length === 1 && !c[0].on) openPick(c[0].key); else renderFind();
      const f = $('#ig-find'); if (f) setTimeout(() => f.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
      return c.length;
    }
    function renderWl() {
      const d = wl.doc, admin = S.admin, dr = admin ? draft() : null;
      $('#ig-wl-tag').textContent = d ? `v${d.b.v} · ${d.b.e.length} stations` : 'none yet';
      $('#ig-wl-tag').className = `tag ${d ? 'ok' : ''}`;
      $('#ig-wl-meta').innerHTML = d ? `Version <b>${d.b.v}</b> signed by ${esc(d.b.by || '?')} (key <span class="mono">${esc(d.k.slice(0, 12))}…</span>) · from ${esc(wl.src || '?')} · last sync ${esc(ago(wl.at))}${wl.checked ? ` · checked ${esc(ago(wl.checked))}` : ''}. Its stations are added to my list; edit or remove them there.`
        + (wl.error ? ` <span class="bad-txt">· ⚠ ${esc(wl.error)}</span>` : '')
        : `No club list yet -- it's optional: your own list works without it.${wl.error ? ` <span class="bad-txt">⚠ ${esc(wl.error)}</span>` : ''}`;
      // admin: the club list itself
      const rows = dr ? dr.e : d ? d.b.e : [];
      $('#ig-wl-rows').innerHTML = rows.length ? rows.map((x, i) => `<tr class="${x.e ? '' : 'dim'}"><td class="mono"><b>${esc(x.c)}-${x.s}</b></td>
        <td class="mono small">${esc(x.k.slice(0, 16))}…</td><td>${esc(symLabel(x.y))}</td><td>${esc(x.m)}</td><td>${x.e ? '✓' : '—'}</td><td class="small">${esc(x.by)} ${x.at ? esc(new Date(x.at * 1000).toLocaleDateString()) : ''}</td>
        <td>${admin ? `<button class="btn small" data-ig-edit="${i}">Edit</button> <button class="btn small" data-ig-tog="${i}">${x.e ? 'Disable' : 'Enable'}</button> <button class="btn small" data-ig-del="${i}">✕</button>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="7" class="dim">No stations on the club list.</td></tr>';
      $('#ig-admin-key').innerHTML = !ed ? 'This browser can\'t sign (TweetNaCl not loaded).' : admin
        ? `Admin key loaded: <span class="mono">${esc(admin.pub)}</span> ${admin.pinned ? '<span class="tag ok">pinned in this release</span>' : '<span class="tag bad">not pinned</span><br><span class="small">Paste that public key into <span class="mono">ADMIN_KEYS</span> in <span class="mono">kelly-page/js/igate-wl.js</span>, copy the file to <span class="mono">gateway/</span>, and release -- until then no station accepts a list it signs.</span>'}`
        : 'No admin key in this browser: the club list is read-only here. Admins: generate a key once, or import your seed.';
      $('#ig-admin-edit').hidden = !admin; $('#ig-adm-gen').hidden = !!admin; $('#ig-adm-imp').hidden = !!admin; $('#ig-adm-exp').hidden = !admin; $('#ig-adm-forget').hidden = !admin;
      const changed = dr && W.canonical({ v: 0, at: 0, by: '', e: dr.e }) !== W.canonical({ v: 0, at: 0, by: '', e: d ? d.b.e : [] });
      $('#ig-pub').textContent = `Sign + publish v${version() + 1} over P25`;
      $('#ig-pub').disabled = $('#ig-pub-file').disabled = $('#ig-pub-web').disabled = !admin || (!changed && !!d);
      $('#ig-pub-msg').innerHTML = S.pubMsg ? esc(S.pubMsg) : changed ? `${dr.e.length} stations · unpublished changes` : '';
      const sel = $('#ig-e-contact'), nodes = contacts(), optSig = [...nodes.keys()].join();
      if (sel.dataset.sig !== optSig) {
        sel.dataset.sig = optSig;
        sel.innerHTML = '<option value="">— pick a MeshCore contact —</option>' + [...nodes.values()].map(n => `<option value="${esc(n.key)}">${esc(n.longName || n.key.slice(0, 8))} · ${esc(n.key.slice(0, 8))}</option>`).join('');
      }
    }
    function renderOwn() {
      const L = link(), mine = L && L.selfKey(), name = L && L.selfName ? L.selfName() : '', cs = I.callFromName(name);
      const club = mine && W ? W.lookup(wl.doc, mine) : null;
      $('#ig-own-wl').innerHTML = !mine ? '<span class="dim">Connect your MeshCore node (LoRa Mesh page) to see how other iGates will find it.</span>'
        : (cs ? `✓ Your node's name "<b>${esc(name)}</b>" carries <b class="mono">${esc(cs.base)}</b>, so other Kelly iGates that hear it offer to add it.`
          : `<span class="bad-txt">Your node's name "${esc(name)}" has no callsign in it</span> -- rename it to start with yours (e.g. "VK4XXX Tracker") so other Kelly iGates offer to add it.`)
        + (club ? ` It is on the club list as <b class="mono">${esc(club.c)}-${club.s}</b>.` : '')
        + ` <span class="dim small">Key <span class="mono">${esc(mine.slice(0, 16))}…</span></span> <button class="btn small" id="ig-own-copy">Copy key</button>`;
      const cp = $('#ig-own-copy'); if (cp) cp.onclick = () => navigator.clipboard && navigator.clipboard.writeText(mine).then(() => toast('📋', 'Key copied', 'For anyone adding your node by hand, or the club list admin', 'good'));
      $('#ig-own-state').textContent = s.own.on ? `every ${ownEveryMin()} min` : 'off'; $('#ig-own-state').className = `tag ${s.own.on ? 'ok' : ''}`;
      $('#ig-own-last').textContent = s.own.lastAt ? `Last sent ${ago(s.own.lastAt)}; next in about ${Math.max(0, Math.ceil((s.own.lastAt + ownEveryMin() * 60000 - Date.now()) / 60000))} min` : 'Not sent yet.';
      $('#ig-own-min').textContent = `minimum ${s.own.flood ? I.OWN_MIN_MIN.flood : I.OWN_MIN_MIN.zero} min`;
    }

    function renderMprs() {
      const L = link(), slot = mprsSlot(), on = s.on && s.mprs.on, st = mgate ? mgate.stats : null;
      $('#ig-mp-state').textContent = !M ? 'not loaded' : on ? (slot ? 'gating' : 'raw log only') : 'off';
      $('#ig-mp-state').className = `tag ${on ? (slot ? 'ok' : 'warn') : ''}`;
      $('#ig-mp-ch').innerHTML = !(L && L.session && L.session()) ? '<span class="dim">Connect your MeshCore node (LoRa Mesh page) to read #meshprs.</span>'
        : slot ? `✓ Your node has <b>#meshprs</b> in channel slot ${slot.index}, so it hands Kelly every frame it hears.`
        : '<span class="bad-txt">Your node has no #meshprs channel</span> -- Kelly reads frames from the raw packet log instead (it must be on). <button class="btn small" id="ig-mp-add">Add #meshprs to my node</button>';
      const add = $('#ig-mp-add'); if (add) add.onclick = addMprsChannel;
      $('#ig-mp-counts').textContent = st ? `Heard ${st.heard} · queued ${st.queued} · sent ${S.mprsOut}${S.mprsUnsent ? ` · not sent ${S.mprsUnsent}` : ''}` + (Object.keys(st.drops).length ? ` · dropped: ${Object.entries(st.drops).map(([r, n]) => `${r} ${n}`).join(', ')}` : '') : '';
    }
    // a free slot only -- never one in use (js/meshcore.js setChannel refuses that anyway)
    async function addMprsChannel() {
      const ses = link() && link().session && link().session();
      if (!ses || !ses.channelSlots || !ses.setChannel) { toast('📡', 'Connect your MeshCore node first', 'LoRa Mesh page', 'bad'); return; }
      const sl = ses.channelSlots(), used = new Set(sl.list.map(c => c.index));
      const free = Array.from({ length: sl.max }, (_, i) => i).find(i => !used.has(i));
      if (free === undefined) { toast('📡', 'No free channel slot', `All ${sl.max} slots are in use -- free one on the LoRa Mesh page`, 'bad'); return; }
      try { await ses.setChannel(free, M.CHANNEL, M.CHANNEL_KEY); toast('📡', '#meshprs added', `Channel slot ${free}`, 'good'); log('in', `#meshprs added to the node in slot ${free}`); }
      catch (e) { toast('⚠️', 'Could not add #meshprs', e.message, 'bad'); }
      dirty('igate');
    }

    // ---------------------------------------------------------------- 🔳 device cards (2026-10-31)
    // A card = the MeshCore contact link + aprs/sym/cmt (meshqr.js buildShare): the MeshCore app adds the contact, a Kelly
    // iGate also puts it on its list. For hams without P25; P25 users have 📡 Shared devices too.
    let qrUi = null;
    const qr = () => { const Q = window.KellyMeshQR; if (!qrUi && Q) qrUi = Q.ui({ toast }); return qrUi; };
    function showCard(x) {
      const Q = window.KellyMeshQR, n = contacts().get(x.k) || nodesHeard().find(y => y.key.toLowerCase() === x.k);
      if (!Q || !qr()) { toast('⚠️', 'QR codes not loaded', 'Reload Kelly', 'bad'); return; }
      let b;
      try { b = Q.buildShare({ name: (n && n.longName) || `${x.c} device`, key: x.k, type: (n && n.role) || 1, c: x.c, s: x.s, y: x.y, m: x.m || '' }); }
      catch (e) { toast('⚠️', 'No card for this one', e.message, 'bad'); return; }
      const mineNote = x.c === String(s.call || '').toUpperCase() ? '' : ` This device is ${x.c}'s, not yours -- it's best shared by its owner.`;
      qr().showText({ title: `🔳 ${x.c}-${x.s} · device card`, text: b.link,
        note: `Another ham scans this in Kelly (APRS iGate › 📷 Scan a device card) and their iGate gates ${x.c}-${x.s} too. The MeshCore app adds it as a contact. It is gated only while the node's own name carries ${x.c}.${mineNote}` });
    }
    function takeCard(text, parsed) {
      const Q = window.KellyMeshQR; let p = parsed;
      try { if (!p) p = Q.parse(text); } catch (e) { toast('⚠️', 'Not a device card', e.message, 'bad'); return; }
      if (p.kind !== 'contact' || !p.aprs) {
        toast('🔳', 'A plain MeshCore contact', 'It has no APRS callsign -- the key is in the form below; fill in the owner\'s callsign', 'bad');
        if (p.key) { listForm(null); $('#ig-l-key').value = p.key; const cs = I.callFromName(p.name); if (cs) { $('#ig-l-call').value = cs.base; if (cs.ssid) $('#ig-l-ssid').value = cs.ssid; } $('#ig-l-form').scrollIntoView({ block: 'nearest' }); }
        return;
      }
      const a = p.aprs, heard = nodeName(p.key), was = byKey(p.key);
      if (p.key === selfKey()) { toast('🔳', 'That is your own node', 'Kelly gates it from its own beacon settings', 'bad'); return; }
      const nameCs = I.callFromName(p.name || '');
      const warn = !nameCs || nameCs.base !== a.c ? `<p class="small bad-txt">⚠ Its name "${esc(p.name || '')}" doesn't carry ${esc(a.c)} as its first or second word -- it won't be gated until the owner renames the node.</p>` : '';
      qr().confirm({ title: `🔳 Add ${a.c}-${a.s}?`, ok: was ? 'Update' : 'Add to my list',
        html: `<p><b class="mono">${esc(a.c)}-${a.s}</b> · ${esc(symLabel(a.y))}${a.m ? ` · ${esc(a.m)}` : ''}</p><p class="small">Node "${esc(p.name || '?')}" · <span class="mono">${esc(p.key.slice(0, 16))}…</span><br>`
          + `${heard != null ? `Your node has heard it as "${esc(heard)}".` : 'Your node hasn\'t heard it yet -- it waits on your list and is gated once its own advert carries the callsign.'}</p>${warn}` })
        .then(yes => {
          if (!yes) return;
          if (!addEntry({ k: p.key, c: a.c, s: a.s, y: a.y, m: a.m, e: 1 }, 'card')) return;
          toast('🗼', `${a.c}-${a.s} is on your list`, heard != null ? 'Gated whenever your node hears it' : 'Waiting to hear it', 'good');
          log('in', `device card: ${a.c}-${a.s} (${p.key.slice(0, 12)}…) added`);
        });
    }
    function renderCm() {
      const mine = myShare(), sent = cm.sent, changed = sent && sent.sig !== shareSig(mine);
      $('#ig-cm-tag').textContent = cm.v ? `v${cm.v} · ${cm.e.length} stations` : 'none yet'; $('#ig-cm-tag').className = `tag ${cm.e.length ? 'ok' : ''}`;
      $('#ig-cm-meta').innerHTML = (sent && sent.n ? `You share <b>${sent.n}</b> device${sent.n === 1 ? '' : 's'} (sent ${esc(ago(sent.at))})${changed ? ' · <span class="bad-txt">your list has changed since -- share again</span>' : ''}.`
        : `You share nothing yet: ${mine.length} device${mine.length === 1 ? '' : 's'} on your list carr${mine.length === 1 ? 'ies' : 'y'} ${esc(String(s.call || '?').toUpperCase())}.`)
        + ` Shared list ${cm.v ? `v${cm.v}` : '—'}${cm.checked ? ` · checked ${esc(ago(cm.checked))}` : ''}${cm.error ? ` <span class="bad-txt">· ⚠ ${esc(cm.error)}</span>` : ''}`;
      $('#ig-cm-msg').textContent = cm.msg || '';
      $('#ig-cm-stop').hidden = !(sent && sent.n);
      $('#ig-cm-sum').textContent = `The shared list (${cm.e.length})`;
      $('#ig-cm-rows').innerHTML = cm.e.length ? cm.e.map(x => `<tr class="${x.e ? '' : 'dim'}"><td class="mono"><b>${esc(x.c)}-${x.s}</b></td><td class="mono small">${esc(x.k.slice(0, 16))}…</td>
        <td>${esc(symLabel(x.y))}</td><td>${esc(x.m || '')}</td><td class="small">${esc(x.by || '')}${list.gone.includes(x.k) ? ' <span class="dim">· removed by you</span>' : ''}</td></tr>`).join('')
        : '<tr><td colspan="5" class="dim">Nothing shared yet.</td></tr>';
    }

    // ---------------------------------------------------------------- init
    function bind(id, key, conv = x => x, obj = s) {
      const el = $(id), set = () => { const v = el.type === 'checkbox' ? el.checked : conv(el.value); obj[key] = v; saveSoon('settings'); gate.setCfg(cfgOf()); pushConfig(); dirty('igate'); };
      if (el.type === 'checkbox') el.checked = !!obj[key]; else el.value = obj[key] ?? '';
      el.onchange = set;
    }
    function listForm(x) {
      $('#ig-l-key').value = x ? x.k : ''; $('#ig-l-call').value = x ? x.c : ''; $('#ig-l-ssid').value = x ? x.s : 12;
      $('#ig-l-sym').value = x ? x.y : '/>'; $('#ig-l-comment').value = x ? x.m || '' : ''; $('#ig-l-on').checked = x ? !!x.e : true;
    }
    function init() {
      if (!I || !W) return;
      if (!s.call) s.call = String(settings.myCall || (settings.aprs.call || '').split('-')[0] || '').toUpperCase();
      const ssids = Array.from({ length: 15 }, (_, i) => `<option value="${i + 1}">-${i + 1}</option>`).join('');
      $('#ig-ssid').innerHTML = ssids; $('#ig-e-ssid').innerHTML = ssids; $('#ig-l-ssid').innerHTML = ssids;
      const syms = SYMBOLS.map(([y, l]) => `<option value="${esc(y)}">${esc(l)}</option>`).join('');
      $('#ig-e-sym').innerHTML = syms; $('#ig-l-sym').innerHTML = syms; $('#ig-mp-sym').innerHTML = syms; $('#ig-mp-ssid').innerHTML = ssids;
      bind('#ig-on', 'on'); bind('#ig-dry', 'dry');
      bind('#ig-call', 'call', x => x.trim().toUpperCase()); bind('#ig-ssid', 'ssid', Number);
      bind('#ig-server', 'server', x => x.trim()); bind('#ig-port', 'port', Number); bind('#ig-filter', 'filter', x => x.trim());
      bind('#ig-every', 'everyS', x => Math.min(3600, Math.max(2, +x || 5))); bind('#ig-burst', 'burst', x => Math.min(10, Math.max(1, +x || 3)));
      bind('#ig-perstn', 'perStationMin', x => Math.min(60, Math.max(0.5, +x || 2))); bind('#ig-move', 'moveM', x => Math.max(50, +x || 500));
      bind('#ig-maxage', 'maxAgeMin', x => Math.min(60, Math.max(1, +x || 10)));
      bind('#ig-poll', 'poll'); bind('#ig-poll-min', 'pollMin', x => Math.min(240, Math.max(10, +x || 15)));
      bind('#ig-stat-on', 'statusOn'); bind('#ig-stat-text', 'statusText'); bind('#ig-stat-min', 'statusMin', x => Math.min(1440, Math.max(10, +x || 30)));
      bind('#ig-wl-url', 'wlUrl', x => x.trim());
      bind('#ig-priv', 'privacy');
      $('#ig-priv-new').onclick = async () => {
        try { S.bridge = await bridgeCall('/api/igate/privacy', {}); S.bridgeAt = Date.now(); }
        catch (e) { S.bridgeErr = e.message; }
        dirty('igate');
      };
      bind('#ig-own-on', 'on', x => x, s.own); bind('#ig-own-src', 'src', x => x, s.own); bind('#ig-own-every', 'everyMin', Number, s.own);
      bind('#ig-own-flood', 'flood', x => x, s.own); bind('#ig-own-places', 'places', Number, s.own);
      $('#ig-call').oninput = () => { s.call = $('#ig-call').value.trim().toUpperCase(); dirty('igate'); };
      bind('#ig-mp-on', 'on', x => x, s.mprs); bind('#ig-mp-send', 'send', x => x, s.mprs); bind('#ig-mp-ssid', 'ssid', Number, s.mprs);
      bind('#ig-mp-sym', 'sym', x => x, s.mprs); bind('#ig-mp-comment', 'comment', x => x.replace(/[^\x20-\x7e]|[|~]/g, '').slice(0, 23), s.mprs);
      $('#ig-reset').onclick = () => { if (!confirm('Reset every APRS iGate counter?')) return; gate.stats.reset(); statsDirty = true; saveStats(); dirty('igate'); };
      $('#ig-own-now').onclick = () => ownBeacon(true);
      // MY list
      listForm(null);
      $('#ig-l-contact').onchange = () => {
        const n = contacts().get($('#ig-l-contact').value); if (!n) return;
        $('#ig-l-key').value = n.key;
        const cs = I.callFromName(n.longName); if (cs && !$('#ig-l-call').value) { $('#ig-l-call').value = cs.base; if (cs.ssid) $('#ig-l-ssid').value = cs.ssid; }
      };
      $('#ig-l-add').onclick = () => {
        const x = { k: $('#ig-l-key').value.trim().toLowerCase(), c: $('#ig-l-call').value.trim().toUpperCase(), s: +$('#ig-l-ssid').value, y: $('#ig-l-sym').value,
          m: $('#ig-l-comment').value.replace(/[^\x20-\x7e]/g, '').replace(/[|~]/g, '').slice(0, 40).trim(), e: $('#ig-l-on').checked ? 1 : 0 };
        if (!/^[0-9a-f]{64}$/.test(x.k) || !I.validBase(x.c) || !(x.s >= 1 && x.s <= 15) || !I.validSymbol(x.y)) { toast('⚠️', 'Check the entry', 'A 64-hex MeshCore public key, the owner\'s callsign, SSID 1-15', 'bad'); return; }
        if (!addEntry(x, 'own')) return; listForm(null); $('#ig-l-contact').value = '';
        toast('🗼', `${x.c}-${x.s} is on your list`, 'Gated whenever your node hears it', 'good');
      };
      $('#ig-l-clear').onclick = () => { listForm(null); $('#ig-l-contact').value = ''; };
      // 🔎 Add my device
      $('#ig-find-q').oninput = e => { S.find.q = e.target.value; S.find.more = false; renderFind(); };
      $('#ig-find-listen').onclick = () => {
        if (S.find.listenAt) { stopListen(); renderFind(); return; }
        S.find.listenAt = Date.now(); S.find.t = setInterval(renderFind, 2000); renderFind();   // stops by itself after LISTEN_MS
      };
      $('#ig-find-rows').onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.igFindPick) openPick(b.dataset.igFindPick);
        else if (b.dataset.igFindEdit) { const x = byKey(b.dataset.igFindEdit); if (x) { listForm(x); $('#ig-l-form').scrollIntoView({ block: 'nearest' }); } }
        else if (b.dataset.igFindMore != null) { S.find.more = !S.find.more; renderFind(); }
      };
      $('#ig-l-offer-rows').onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.igDismiss) { list.gone.push(b.dataset.igDismiss); saveList(); dirty('igate'); return; }
        const o = offers().find(y => y.n.key === b.dataset.igOffer); if (!o) return;
        if (!addEntry({ k: o.n.key, c: o.c, s: o.s, y: o.y, m: '', e: 1 }, 'name')) return;
        toast('🗼', `${o.c}-${o.s} added from its node name`, 'Edit it to change the SSID, symbol or comment', 'good');
      };
      $('#ig-l-offer-all').onclick = () => { const o = offers(); if (!o.length || !confirm(`Add all ${o.length} offered node(s) to your list?`)) return; for (const y of o) addEntry({ k: y.n.key, c: y.c, s: y.s, y: y.y, m: '', e: 1 }, 'name'); };
      $('#ig-l-rows').onclick = e => {
        const b = e.target.closest('button'); if (!b) return;
        const i = +(b.dataset.igLQr ?? b.dataset.igLEdit ?? b.dataset.igLTlm ?? b.dataset.igLTog ?? b.dataset.igLDel), x = list.e[i]; if (!x) return;
        if (b.dataset.igLQr != null) { showCard(x); return; }
        if (b.dataset.igLEdit != null) { listForm(x); $('#ig-l-form').scrollIntoView({ block: 'nearest' }); return; }
        if (b.dataset.igLTlm != null) { openTlm(x); return; }
        if (b.dataset.igLTog != null) { x.e = x.e ? 0 : 1; x.ed = true; }
        else if (confirm(`Remove ${x.c}-${x.s} from your list?${x.src !== 'own' ? ' It won\'t be offered or added again.' : ''}`)) { list.e.splice(i, 1); if (!list.gone.includes(x.k)) list.gone.push(x.k); if (S.t && S.t.k === x.k) { S.t = null; $('#ig-t').hidden = true; } }
        saveList(); dirty('igate');
      };
      $('#ig-l-gone').onclick = () => { if (!list.gone.length) { toast('🗼', 'Nothing dismissed', '', 'good'); return; } if (confirm(`Forget ${list.gone.length} dismissed / removed node(s)? They can be offered and added again.`)) { list.gone = []; saveList(); mergeClub(); dirty('igate'); } };
      // 🔳 device cards + 📡 shared devices
      const CARD = { accept: ['contact'], title: '📷 Scan a device card', hint: 'A ham\'s 🔳 device card from Kelly (APRS iGate › My list › 🔳)' };
      $('#ig-card-scan').onclick = () => { if (qr()) qr().scan(takeCard, CARD); };
      $('#ig-card-img').onclick = () => { if (qr()) qr().fromImage(takeCard, CARD); };
      $('#ig-card-paste').onclick = () => {
        const t = prompt('Paste the device card link (meshcore://contact/add?…&aprs=…):'); if (!t) return;
        let p; try { p = qr().paste(t, CARD); } catch (e) { toast('⚠️', 'Not a device card', e.message, 'bad'); return; }
        takeCard(t, p);
      };
      $('#ig-cm-share').onclick = () => { const e = myShare(); if (e.length && confirm(`Share ${e.length} device(s) under ${String(s.call).toUpperCase()} with every P25X Kelly iGate?\n\n${list.e.filter(x => e.some(y => y.k === x.k)).map(x => `${x.c}-${x.s}`).join(', ')}`)) shareMine(false); else if (!e.length) shareMine(false); };
      $('#ig-cm-stop').onclick = () => { if (confirm('Stop sharing your devices? They leave the shared list (other iGates that edited them keep theirs).')) shareMine(true); };
      $('#ig-cm-check').onclick = () => checkCm(true);
      // telemetry editor
      $('#ig-t-type').onchange = () => applyType($('#ig-t-type').value);
      $('#ig-t-on').onchange = () => { S.t.on = $('#ig-t-on').checked; renderTlm(); };
      $('#ig-t-every').onchange = () => { S.t.every = Math.max(TLM_MIN_MIN, +$('#ig-t-every').value || 15); $('#ig-t-every').value = S.t.every; renderTlm(); };
      $('#ig-t-name').oninput = () => { S.t.map.title = $('#ig-t-name').value; renderTlm(); };
      const slotEdit = e => { const el = e.target.closest('[data-f]'), tr = el && el.closest('tr'); if (el && tr && S.t) editSlot(tr, el.dataset.f, el.value); };
      $('#ig-t-a').onchange = slotEdit; $('#ig-t-b').onchange = slotEdit;
      $('#ig-t-read').onclick = () => readNow().catch(e => toast('⚠️', 'Read failed', e.message, 'bad'));
      $('#ig-t-save').onclick = saveTlm;
      $('#ig-t-type-save').onclick = saveType;
      $('#ig-t-close').onclick = () => { S.t = null; $('#ig-t').hidden = true; };
      // the club list
      $('#ig-wl-check').onclick = () => checkWl(true);
      $('#ig-wl-web').onclick = () => pullWeb(true);
      $('#ig-wl-fetch').onclick = async () => {
        if (!s.wlUrl) { toast('🔗', 'Type an address first', 'e.g. the P25X dashboard\'s /api/igate', 'bad'); return; }
        try { const j = await (await fetch(s.wlUrl, { cache: 'no-store' })).json(); take(j.doc || j, s.wlUrl); } catch (e) { wl.error = `${s.wlUrl}: ${e.message}`; saveWl(); }
        dirty('igate');
      };
      $('#ig-wl-file').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { take(JSON.parse(await f.text()), `file ${f.name}`); } catch (err) { toast('⚠️', 'Not a club list file', err.message, 'bad'); } dirty('igate'); };
      $('#ig-wl-export').onclick = () => { if (wl.doc) download(`igate-club-list-v${wl.doc.b.v}.json`, wl.doc); else toast('🔐', 'No club list to save yet', '', 'bad'); };
      // admin
      $('#ig-adm-gen').onclick = () => { if (!confirm('Make a new club-list admin key in this browser? Keep a copy of the seed somewhere safe.')) return; setAdmin(W.hex(nacl.randomBytes(32))); };
      $('#ig-adm-imp').onclick = () => { const x = (prompt('Admin seed (64 hex digits):') || '').trim().toLowerCase(); if (!x) return; if (!/^[0-9a-f]{64}$/.test(x)) { toast('⚠️', 'Not a seed', '64 hex digits', 'bad'); return; } setAdmin(x); };
      $('#ig-adm-exp').onclick = async () => { if (!confirm('Show the admin SEED? Anyone with it can sign club lists.')) return; const seed = await idb('readonly', st => st.get('admin')); prompt('Admin seed -- keep it secret:', seed || ''); };
      $('#ig-adm-forget').onclick = () => { if (confirm('Remove the admin key from this browser? (Only do this if you have the seed saved elsewhere.)')) { setAdmin(null); S.draft = null; } };
      $('#ig-e-contact').onchange = () => { const v = $('#ig-e-contact').value; if (v) $('#ig-e-key').value = v; };
      $('#ig-e-add').onclick = () => {
        const x = W.normEntry({ k: $('#ig-e-key').value.trim(), c: $('#ig-e-call').value, s: +$('#ig-e-ssid').value, y: $('#ig-e-sym').value, m: $('#ig-e-comment').value,
          e: $('#ig-e-on').checked ? 1 : 0, by: String(settings.myCall || '').toUpperCase().slice(0, 9).replace(/[^A-Z0-9-]/g, ''), at: Math.floor(Date.now() / 1000) });
        if (!x) { toast('⚠️', 'Check the entry', 'A 64-hex MeshCore public key, a callsign, SSID 1-15', 'bad'); return; }
        const d = draft(), i = d.e.findIndex(y => y.k === x.k);
        if (i >= 0) d.e[i] = Object.assign(x, { by: d.e[i].by || x.by, at: d.e[i].at || x.at }); else d.e.push(x);
        S.pubMsg = ''; ['#ig-e-key', '#ig-e-call', '#ig-e-comment'].forEach(id => { $(id).value = ''; });
        dirty('igate');
      };
      $('#ig-wl-rows').onclick = e => {
        const b = e.target.closest('button'); if (!b || !S.admin) return;
        const d = draft(), i = +(b.dataset.igEdit ?? b.dataset.igTog ?? b.dataset.igDel), x = d.e[i]; if (!x) return;
        if (b.dataset.igEdit != null) { $('#ig-e-key').value = x.k; $('#ig-e-call').value = x.c; $('#ig-e-ssid').value = x.s; $('#ig-e-sym').value = x.y; $('#ig-e-comment').value = x.m; $('#ig-e-on').checked = !!x.e; $('#ig-admin').open = true; }
        else if (b.dataset.igTog != null) x.e = x.e ? 0 : 1;
        else if (confirm(`Remove ${x.c}-${x.s} from the club list?`)) d.e.splice(i, 1);
        S.pubMsg = ''; dirty('igate');
      };
      $('#ig-pub').onclick = () => { if (confirm(`Sign club list version ${version() + 1} and send it to the P25X gateway for every station?`)) publish(true); };
      $('#ig-pub-file').onclick = () => publish(false);
      $('#ig-pub-web').onclick = () => { if (confirm(`Sign club list version ${version() + 1} and upload it to kellypage.app?`)) publish('web'); };
      $('#ig-draft-reset').onclick = () => { S.draft = null; S.pubMsg = ''; dirty('igate'); };
      if (ed) loadAdmin();
      mergeClub(); mergeComm();
      // the loops (all cheap: no drawing). The send loop and the bridge poll run on js/bgtick.js's worker clock: on a
      // plain setInterval a background tab ticked once a minute, so every frame expired and bridgeUp() went false.
      const every = window.KellyBgTick || setInterval;
      every(() => { tick().catch(e => console.warn('APRS iGate', e)); }, 1000);
      every(() => { if (s.on) pollBridge(); }, BRIDGE_POLL_MS);
      setInterval(saveStats, STATS_SAVE_MS);
      addEventListener('pagehide', saveStats);
      setInterval(() => {
        if (s.on && window.KellyWebSync && window.KellyWebSync.webOk() && Date.now() - (wl.webChecked || 0) > WL_WEB_MS) pullWeb(false).catch(() => { /* best effort */ });   // kellypage.app, every 6 h
        if (s.on && Date.now() - (wl.checked || 0) > WL_DAY_MS && k.radioConnected() && !k.rfBusy()) checkWl(false);   // once a day
        else if (s.on && Date.now() - (cm.checked || 0) > WL_DAY_MS && k.radioConnected() && !k.rfBusy()) checkCm(false);   // and the shared devices (30 s later)
        if (s.own.on && Date.now() - (s.own.lastAt || 0) >= ownEveryMin() * 60000) ownBeacon(false);
        pollOne().catch(e => console.warn('APRS iGate poll', e));
        if (k.currentPage() === 'igate') dirty('igate');
      }, 30000);
      if (s.on) pushConfig();
    }
    // for the MeshPRS tab: the same engine and settings as this page (one APRS-IS login), never a second copy
    const MPRS_SET = { on: [s, 'on', '#ig-on'], dry: [s, 'dry', '#ig-dry'], mprs: [s.mprs, 'on', '#ig-mp-on'] };
    function mprsStatus() {
      const st = mgate ? mgate.stats : null, slot = mprsSlot();
      return { on: !!s.on, dry: !!s.dry, mprs: !!s.mprs.on, call: call() || '', server: s.server, bridge: S.bridge, bridgeUp: bridgeUp(), bridgeErr: S.bridgeErr,
        slot: slot ? slot.index : null, link: !!link(), listed: list.e.filter(x => x.e).length,
        stats: st ? { heard: st.heard, queued: st.queued, drops: Object.assign({}, st.drops) } : null, out: S.mprsOut, unsent: S.mprsUnsent };
    }
    function mprsSet(key, v) {
      const m = MPRS_SET[key]; if (!m) return;
      m[0][m[1]] = !!v; const el = $(m[2]); if (el) el.checked = !!v;
      saveSoon('settings'); pushConfig(); dirty('igate');
    }
    return { init, render, feed, gatewayReply, ownsXid, kfEvent, list: () => list,
      onMprs: fn => { mprsFns.add(fn); return () => mprsFns.delete(fn); }, mprsStatus, mprsSet, addMprsChannel: () => addMprsChannel(), findDevice,
      entryFor: key => byKey(String(key || '').toLowerCase()) || null, queueTlm: (key, rs) => { const x = byKey(key); if (x) queueTlm(x, rs); }, tq: () => S.tq };
  };
})();
