/* Kelly Page -- LoRa Mesh page (was "Meshtastic", renamed 2026-10-17): a LoRa node on this computer, the mesh on
 * Kelly's map, and a P25 <-> mesh bridge. Device types (Device list; nodes + chats kept per type):
 *   Meshtastic  this file + js/meshtastic.js (protobufs) -- everything below, plus the demo mesh
 *   MeshCore    js/meshcore.js -- a COMPANION-firmware node: contacts, channels, DMs with ACKs, position via advert
 *   LoRa APRS   js/loraaprs.js -- a CA2RXU tracker (BLE KISS/TNC2) or iGate / KISS TNC: stations, APRS messages
 *   Those two are "drivers" (connectDriver): their Session does the protocol and reports through an io object;
 *   features a device lacks (traceroute, reactions, position requests) are hidden by its caps.
 *
 * Meshtastic links (all speak the same FromRadio/ToRadio protobufs, js/meshtastic.js):
 *   USB      Web Serial, 115200, framed (94 C3 len) -- Chrome/Edge, on localhost / file:// / https only
 *   Bluetooth Web Bluetooth, the Meshtastic BLE service -- same browsers, same secure-context rule
 *   Bridge   WebSocket /mesh on the Kelly bridge (bridge/kelly_bridge.py --mesh-serial / --mesh-tcp):
 *            a node plugged into the Pi, or a WiFi node on TCP 4403. The way in when Kelly is opened
 *            from the Pi over the LAN (plain http = no Web Serial / Bluetooth).
 *   Demo     a simulated SEQ mesh producing real protobuf frames -- for trying it with no hardware.
 *
 * Bridge (Mesh page > P25 bridge, all off by default):
 *   Mesh -> P25  texts on the chosen channel (or DMs to this node) go to a P25 radio as "MESH <name>: text"
 *   P25 -> Mesh  texts this radio receives ("@mesh ..." only, or all) go out on a channel as
 *                "[P25 <your call>] <sender>: text" -- plaintext, with your callsign, so it IDs
 *   Loop guard: a "[P25" text is never sent back to P25, and a "MESH " text never back to the mesh;
 *   forwards to P25 are spaced 15 s (airtime), queue max 10.
 * Without a node: "Mesh near me" asks the P25X gateway over P25 (KF {op: 'meshnear'}, dashboard
 * mesh-mqtt.js -- the mesh as heard on Meshtastic MQTT).
 *
 * window.KellyMeshUI(ctx) -> { init, render, onP25Text, ownsXid, kfEvent, gatewayReply }; ctx comes from app.js.
 * Packet paths + golden packets (two-way long distance): js/meshpaths.js, fed from here (PA).
 * Repeater management (MeshCore: log in over the air, status, telemetry, neighbours, CLI): js/meshrepeaters.js (RP).
 * Rooms (MeshCore room servers: log in, posts, post; ms.rooms): js/meshrooms.js (RM).
 * Mesh trends (charts from the bridge's --mesh-history, /api/mesh-history): js/meshtrends.js (TR).
 * Coverage layer on the map (stations heard direct, by SNR; ms.coverage): js/meshcoverage.js (CV).
 * Node info panel over the map (the selected node: details, route history, actions): js/meshinfo.js (MI).
 * Contact management (MeshCore: share, export/import meshcore:// links, remove, own name): js/meshcontacts.js (CT).
 * Drive mode (wardriving: GPS, gated pings, repeaters that heard you; ms.drive): js/meshdrive.js (DV). Offline map tiles
 * (Cache API; ms.tileCache, ms.tileOwn): js/meshtiles.js (TL).
 */
(function () {
  'use strict';
  window.KellyMeshUI = function (k) {
    const M = window.KellyMesh, { $, $$, esc, settings, store, toast, addEvent, dirty } = k;
    // Device types: Meshtastic is this file's own (js/meshtastic.js protobufs); the others are drivers with one shape
    // -- { id, label, baud, ble: {service, write, notify}, caps, hint, Framer, frame, Session(io) } -- js/meshcore.js,
    // js/loraaprs.js. A driver's Session turns its device's frames into nodes / texts / ACKs (the io object below).
    const DRIVERS = { meshcore: window.KellyMeshCore && window.KellyMeshCore.DRIVER, aprs: window.KellyLoraAprs && window.KellyLoraAprs.DRIVER };
    const DEV_LABEL = { meshtastic: 'Meshtastic', meshcore: 'MeshCore', aprs: 'LoRa APRS' };
    const ms = settings.mesh = Object.assign({ dev: 'meshtastic', link: 'demo', sound: true, fx: true, sfx: { rx: true, text: true, dm: true, node: true, ham: true, tx: true, ack: true, trace: true, bridge: true },
      toP25: false, toP25Ch: 0, toP25Dest: '', fromP25: false, fromP25Mode: 'tag', fromP25Ch: 0, sharePos: false, nearKm: 50, scope: true,
      hashExpect: 2, hashP25: false }, settings.mesh || {});   // path hash size check: the network's size (MBUG SEQ: 2-byte), P25 alerts
    ms.sfx = Object.assign({ rx: true, text: true, dm: true, node: true, ham: true, tx: true, ack: true, trace: true, bridge: true, cq: true }, ms.sfx);
    ms.hunt = Object.assign({ alert: true, sub: false, km: 50 }, ms.hunt);
    if (!['first', 'only', 'all'].includes(ms.hamMode)) ms.hamMode = 'first';
    if (ms.sosToP25 == null) ms.sosToP25 = true;    // mesh emergencies go to the P25 radio even with Mesh -> P25 off
    if (ms.p25Layer == null) ms.p25Layer = true;    // P25 radios (Kelly's GPS fixes) on the mesh map
    if (ms.autoReconnect == null) ms.autoReconnect = true;   // a lost link (bridge, Bluetooth, USB replug) comes back by itself
    ms.sfx.sos = ms.sfx.sos !== false;   // hams first / hams only / everyone (callers + node list)
    const save = () => k.saveSoon('settings');

    // ------------------------------------------------------------------ state
    // each device type keeps its own nodes + chats (Meshtastic's under the original keys)
    const sk = (base, dev = ms.dev) => dev === 'meshtastic' ? base : `${base}.${dev}`;
    const st = {
      link: null, status: 'off', note: '', myNum: null, fw: '', channels: [], configId: 0, session: null, drv: null, radio: '',
      advertAt: new Map(),   // MeshCore key -> when the node last pushed an advert from it (the APRS iGate's freshness test)
      nodes: new Map((store.get(sk('meshNodes'), []) || []).map(n => [n.num, n])),
      chats: store.get(sk('meshChats'), {}), chat: 'ch0', unread: {}, pending: new Map(),
      logs: [], traces: [], ripples: new Map(), links: [], waypoints: new Map(),
      rx: 0, tx: 0, lastRx: 0, gw: store.get('meshGateway', null), gwAsk: null, toP25Q: [], toP25At: 0, lastShare: 0,
      callers: (store.get('meshCallers', []) || []).filter(c => Date.now() - c.t < 12 * 3600000), subAsk: null, answering: null,
      routes: new Map(),   // P25 radio ID -> the mesh station whose text the bridge last sent it (for "@re" replies)
      toMeshQ: [], toMeshAt: 0,   // P25 -> mesh, one every FROM_P25_GAP (shared airtime)
      sosSeen: new Map(),         // "from|text" -> when it went to P25 (the same emergency once per 10 min)
      wantLink: false, lastLink: null,   // the user asked for a link (auto-reconnect) and how to make it again
    };
    const drv = () => DRIVERS[ms.dev] || null;   // null = Meshtastic
    const hasDemo = dev => dev === 'meshtastic' || dev === 'meshcore';   // MeshCore's demo = js/meshcoresim.js
    const caps = () => drv() ? drv().caps : { trace: true, traceAny: true, react: true, askPos: true, dm: true, channels: true, sharePos: true };
    const me = () => st.nodes.get(st.myNum);
    // node identity: a driver's nodes bring their own ID / hardware labels; Meshtastic's come from the node number
    const nid = num => { const n = st.nodes.get(num >>> 0); return n && n.idLabel ? n.idLabel : M.nodeId(num); };
    const hwOf = n => n ? (n.hwLabel || M.hwName(n.hw)) : '';
    const roleOf = n => n && !n.hwLabel && n.role ? M.ROLE[n.role] || '' : '';
    const defShort = num => drv() ? '?' : M.defaultShort(num);
    const nm = num => { const n = st.nodes.get(num >>> 0); return n ? (n.longName || n.shortName || nid(num)) : nid(num); };
    const short = num => { const n = st.nodes.get(num >>> 0); return n && n.shortName ? n.shortName : defShort(num); };
    const nodeColor = n => n.num === st.myNum ? '#ffb020' : n.viaMqtt ? '#7d8a99' : n.hops == null ? '#a78bfa' : n.hops === 0 ? '#39ff88' : n.hops <= 2 ? '#00e5ff' : '#ff3bd4';
    const saveNodes = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => { store.set(sk('meshNodes'), [...st.nodes.values()].sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0)).slice(0, 300)); store.set(sk('meshChats'), st.chats); }, 1500); }; })();
    function switchDev(dev) {   // a different device type: its own nodes and chats
      store.set(sk('meshNodes'), [...st.nodes.values()].slice(0, 300)); store.set(sk('meshChats'), st.chats);
      ms.dev = dev;
      st.nodes = new Map((store.get(sk('meshNodes'), []) || []).map(n => [n.num, n])); st.chats = store.get(sk('meshChats'), {});
      Object.assign(st, { myNum: null, fw: '', radio: '', channels: [], chat: 'ch0', unread: {}, traces: [], links: [], note: '' });
      st.pending.clear(); st.waypoints.clear(); st.ripples.clear();
      if (!hasDemo(dev) && ms.link === 'demo') ms.link = 'usb';
    }
    const maxText = (target = activeTarget()) => st.session ? st.session.maxText(target.to === M.BROADCAST ? { ch: target.channel } : { dm: st.nodes.get(target.to) }) : M.MAX_TEXT_BYTES;
    const distKm = (a, b) => { const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
    const bearing = (a, b) => { const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r), x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r); return Math.atan2(y, x); };
    const myPos = () => { const n = me(); if (n && n.lat != null) return { lat: n.lat, lon: n.lon }; return k.myPos(); };
    const bytesOf = s => new TextEncoder().encode(s).length;
    const cut = (s, max) => { let t = s; while (bytesOf(t) > max) t = t.slice(0, -1); return t; };
    // P25 texts are plain ASCII: fold accents and smart punctuation, drop emoji (= the gateway's meshAscii)
    const ascii = s => String(s || '').normalize('NFKD').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '').replace(/ {2,}/g, ' ').trim();
    // Contact hunting: a text "calls" when it's asking for contacts -- the same test as the gateway's meshIsCalling()
    // (server.js "Mesh callers"), which pushes Meshtastic callers to a subscribed Kelly over P25.
    const CALL_RE = /\b(cq|qrz|anyone\b.{0,12}\b(there|about|around|on|out|listening|copy|hear|awake|up)|anybody\b.{0,12}\b(there|about|around|on|out|listening|copy|hear)|radio check|signal (check|report)|range test|testing|test test|can (anyone|you) (hear|copy|read)|who'?s (on|out|about|around|up)|looking for|any takers|hello (all|everyone|mesh|world)|hi (all|everyone|mesh)|g'?day (all|everyone|mesh)|calling all|qsl\?|copy\?)/i;
    // real mesh calls are mostly short greetings: "Hello", "Ping", "👋", "Hi from Mount Toolebewong", "Slvf online"
    const GREET_RE = /^\s*(?:👋|📡|(?:hello|hallo|hola|hi|hey|heya|g'?day|howdy|ping|test|teste|testing|cq|qrz|good (?:morning|afternoon|evening|day)|morning|evening)\b)/i, FROM_RE = /\b(?:hi|hello|hey|g'?day|greetings|cheers)\s+(?:all\s+|everyone\s+)?from\b/i, ONLINE_RE = /\b(?:online|on air|on the air|qrv|connected|back on)\b/i;
    const isCalling = (text, name) => {
      const t = String(text || '').trim();
      if (!t || /^\[P25|^MESH /.test(t) || /\bbot\b|alert|bbs\b/i.test(name || '')) return false;
      return CALL_RE.test(t) || GREET_RE.test(t) || FROM_RE.test(t) || (t.length <= 40 && ONLINE_RE.test(t));
    };
    // a ham: licensed (HAM) mode, or a callsign in the name (VK/ZL/AX any case; other countries' calls in capitals)
    const CALLSIGN_RE = /\b(?:VK|ZL|AX)\d[A-Z]{1,4}\b/i, CALLSIGN_RE2 = /\b(?:[A-Z]{1,2}|\d[A-Z])\d[A-Z]{1,4}\b/;
    const hasCall = s => !!s && (CALLSIGN_RE.test(s) || CALLSIGN_RE2.test(s));
    // short names are only 4 characters ("T1KE" looks like a call), so only a VK/ZL/AX call counts there
    const isHam = o => !!o && !!(o.licensed || o.ham || hasCall(o.longName || o.name) || CALLSIGN_RE.test(o.shortName || o.short || ''));
    const hamSort = (list, key) => { const sosFirst = (a, b) => (b.sos ? 1 : 0) - (a.sos ? 1 : 0);
      return ms.hamMode === 'only' ? list.filter(x => x.sos || isHam(x)).sort(sosFirst) : ms.hamMode === 'first' ? list.slice().sort((a, b) => sosFirst(a, b) || (isHam(b) ? 1 : 0) - (isHam(a) ? 1 : 0) || key(b) - key(a)) : list.slice().sort(sosFirst); };
    const callOf = name => { const m = /\b([A-Z]{1,2}\d[A-Z]{1,4})\b/i.exec(name || ''); return m ? m[1].toUpperCase() : (name || '').trim(); };
    const saveCallers = () => store.set('meshCallers', st.callers.slice(0, 40));
    // Emergencies: Meshtastic's alert bell (a BEL character in the text), or SOS / MAYDAY / EMERGENCY
    const isSos = t => /\u0007/.test(t || '') || /\b(SOS|MAYDAY|EMERGENCY)\b/i.test(t || '');
    const noBell = t => String(t || '').replace(/\u0007/g, '').trim();
    // the P25 radio of a mesh ham (a callsign in its name), from Kelly's Directory / RadioID / Last heard
    const p25Of = o => { const c = callOf(o && (o.longName || o.name) || ''); return c && hasCall(c) && k.p25Of ? k.p25Of(c) : null; };
    const meshNodeByCall = x => { const c = String(x || '').toUpperCase(); return [...st.nodes.values()].filter(n => n.num !== st.myNum)
      .sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0)).find(n => callOf(n.longName || '').toUpperCase() === c || (n.shortName || '').toUpperCase() === c) || null; };
    function raiseSos(c) {   // c: { name, text, from, lat, lon, km, brg, src }
      sfx('sos'); flash('dm');
      addEvent('alarm', `🚨 MESH EMERGENCY from ${c.name}: ${noBell(c.text)}`);
      const el = pop(`<div class="mp-burst"></div><span class="mh-ic">🚨</span><div class="mp-msg"><small>🚨 MESH EMERGENCY${c.src === 'gateway' ? ' · VIA THE P25X GATEWAY' : ''}</small><b>${esc(c.name)}</b>`
        + `<span>${c.km != null ? `${c.km.toFixed(1)} km ${F('cardinal', c.brg) || ''}` : 'position unknown'}${c.lat != null ? ` · ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}` : ''}</span><p>${esc(noBell(c.text))}</p>`
        + `<div class="mp-reply">${c.lat != null ? '<button class="btn small" data-x="map">🗺️ Map</button>' : ''}<button class="btn primary small" data-x="p25">📻 Send to P25</button></div></div>`, 'msg sos', 45000, () => k.showPage('mesh'));
      if (!el) return;
      el.onclick = e => {
        const b = e.target.closest('[data-x]'); if (!b) return; e.stopPropagation();
        if (b.dataset.x === 'map' && c.lat != null) { k.showPage('mesh'); setTimeout(() => { if (st.map) { st.map.setView([c.lat, c.lon], 13); $('#mesh-map').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 100); }
        if (b.dataset.x === 'p25') { const d = parseInt(ms.toP25Dest, 10); if (d > 0) queueToP25({ dest: d, text: sosText(c), sos: true }); else k.openP25 && k.openP25('', sosText(c)); }
      };
    }
    const sosText = c => cut(`MESH SOS ${c.name}: ${noBell(c.text)}${c.lat != null ? ` @${c.lat.toFixed(4)},${c.lon.toFixed(4)}` : ''}`, 160);
    // a caller from this node's traffic (src 'node') or the P25X gateway's Meshtastic MQTT feed (src 'gateway')
    function addCaller(c) {
      if (st.callers.some(x => x.from === c.from && x.text === c.text && Math.abs(x.t - c.t) < 15 * 60000)) return;
      const p = myPos(); if (p && c.lat != null) { c.km = distKm(p, c); c.brg = bearing(p, c); }
      c.ham = isHam(c); c.sos = c.sos || isSos(c.text);
      st.callers.unshift(c); st.callers.splice(40); saveCallers();
      const fresh = Date.now() - c.t < 10 * 60000;
      if (c.sos) { if (fresh && c.src === 'gateway') raiseSos(c); dirty('mesh'); return; }   // a node's own emergency was raised by receiveText
      if (fresh && ms.hunt.alert && (c.ham || ms.hamMode === 'all')) {
        sfx('cq'); flash('node');
        const el = pop(`<div class="mp-burst"></div><span class="mh-ic">📣</span><div class="mp-msg"><small>📣 CALLING NOW${c.src === 'gateway' ? ' · VIA THE P25X GATEWAY' : ''}</small><b>${esc(c.name)}${c.ham ? ' <span class="mesh-ham">HAM</span>' : ''}</b>`
          + `<span>${c.km != null ? `${c.km.toFixed(1)} km ${F('cardinal', c.brg) || ''} · ` : ''}${esc(c.mesh)}</span><p>${esc(c.text)}</p><div class="mp-reply"><button class="btn primary small">🎯 Answer</button></div></div>`,
        'msg call', 12000, () => { k.showPage('mesh'); });
        if (el) el.querySelector('button').onclick = e => { e.stopPropagation(); k.showPage('mesh'); setTimeout(() => answer(c.key), 80); el.classList.add('out'); setTimeout(() => el.remove(), 400); };
      }
      dirty('mesh');
    }
    function answer(key) {
      const c = st.callers.find(x => x.key === key); if (!c) return;
      const sameMesh = c.mesh === DEV_LABEL[ms.dev] && st.status === 'on';
      if (!sameMesh) { toast('📣', `${c.name} is on ${c.mesh}`, st.status === 'on' ? `Your node is ${DEV_LABEL[ms.dev]} -- the two don't hear each other. Connect a ${c.mesh} node to answer.` : `Connect a ${c.mesh} node to answer.`, 'bad'); return; }
      const me_ = (settings.myCall || '').toUpperCase() || 'KELLY';
      const rpt = c.km != null ? ` -- copy you ${c.km.toFixed(0)} km ${F('cardinal', c.brg) || ''}`.trimEnd() : ' -- copy you';
      const n = st.nodes.get(c.from), canDm = caps().dm && (c.src === 'gateway' || (n && n.idLabel !== 'channel only'));
      openChat(canDm ? `dm${c.from}` : `ch${c.ch || 0}`);
      if (canDm && !st.chats[`dm${c.from}`]) st.chats[`dm${c.from}`] = [];
      $('#mesh-text').value = cut(`${callOf(c.name)} de ${me_}${rpt}. QSL? 73`, maxText());
      $('#mesh-text').focus(); st.answering = { key, num: c.from, at: Date.now() };
      dirty('mesh');
    }
    // a send after pressing Answer (to that station, or on the channel) answers the call: Mesh Quest credit
    function noteAnswer(target) {
      const a = st.answering; if (!a || Date.now() - a.at > 15 * 60000) return;
      if (target.to !== a.num && target.to !== M.BROADCAST) return;
      const c = st.callers.find(x => x.key === a.key); if (c) { c.answered = Date.now(); saveCallers(); }
      st.answering = null;
      Fi('answered', undefined, { call: callOf(c ? c.name : nm(a.num)), verified: !!(c && c.src === 'gateway'), at: Date.now(), num: a.num, via: 'mesh' });
    }
    // B2: "📻 Answer on P25" only opens the Messages page with the text in it -- CQ Hunter credit waits for that text to
    // really go to that radio (app.js marks it sent / acked / delivered). verified: the caller is on the gateway's Mesh
    // callers list (the gateway heard it). Checked on onP25Sent() (if app.js calls it), else every 3 s for 15 min.
    let p25Ans = null, p25AnsT = 0;
    function p25AnswerOpen(c, id, call) {
      p25Ans = { id: +id, call: String(call || '').toUpperCase(), key: c ? c.key : null, verified: !!(c && c.src === 'gateway'), at: Date.now() };
      clearInterval(p25AnsT); p25AnsT = setInterval(() => p25AnswerCheck(null), 3000);
    }
    function p25AnswerCheck(m0) {
      const a = p25Ans; if (!a) { clearInterval(p25AnsT); p25AnsT = 0; return; }
      if (Date.now() - a.at > 15 * 60000) { p25Ans = null; clearInterval(p25AnsT); p25AnsT = 0; return; }
      const ok = m => m && m.dir === 'out' && +m.peer === a.id && (m.ts || 0) >= a.at - 1000 && ['sent', 'acked', 'delivered'].includes(m.state);
      let m = ok(m0) ? m0 : null;
      if (!m) { const s = kst(), list = (s && s.messages) || []; for (let i = list.length - 1; i >= 0 && i >= list.length - 50; i--) if (ok(list[i])) { m = list[i]; break; } }
      if (!m) return;
      p25Ans = null; clearInterval(p25AnsT); p25AnsT = 0;
      const c = a.key && st.callers.find(x => x.key === a.key); if (c) { c.answered = Date.now(); saveCallers(); dirty('mesh'); }
      Fi('answered', undefined, { call: a.call, verified: a.verified, at: m.ts || Date.now(), radio: a.id, via: 'p25' });
    }
    function onP25Sent(m) { try { p25AnswerCheck(m); } catch (e) { console.warn('Mesh callers', e); } }
    async function huntSub(on) {
      const p = k.myPos();
      if (on && !p) { toast('📍', 'Kelly needs your position first', 'GPS › Fixed position, or a GPS fix', 'bad'); ms.hunt.sub = false; save(); dirty('mesh'); return; }
      if (awDemo()) { if (on) toast('🎮', 'Not while a demo runs', 'Callers from the gateway need a real radio -- a demo sends nothing over P25', 'bad'); st.subAsk = null; dirty('mesh'); return; }
      const xid = await kfSafe({ op: 'meshsub', enabled: !!on, km: +ms.hunt.km || 50, lat: p ? +p.lat.toFixed(4) : 0, lon: p ? +p.lon.toFixed(4) : 0, call: (settings.myCall || '').toUpperCase(), hams: ms.hamMode === 'only' },
        on ? 'asking the gateway to send you mesh callers' : 'telling the gateway to stop sending mesh callers');
      st.subAsk = xid ? { xid, at: Date.now(), on: !!on } : null; dirty('mesh');
    }
    function gatewayCallers(rows, at) {   // rows from 'meshsub' (recent) or 'meshcall' (pushed)
      for (const [id, s, l, la, lo, ham, hops, ch, text, age, sos, mesh] of rows || []) {
        const num = parseInt(id, 16) >>> 0, t = (at || Date.now()) - (age || 0) * 1000;
        addCaller({ key: `g${num}:${t}`, src: 'gateway', mesh: mesh || 'Meshtastic', from: num, name: l || s || M.nodeId(num), short: s, ham: !!ham, hops: hops < 0 ? null : hops,
          lat: la == null ? null : la / 1e4, lon: lo == null ? null : lo / 1e4, ch: 0, chName: ch, text, t, sos: !!sos });
      }
    }

    // ---- awards (kelly-page/AWARDS_REVIEW.md, review/07-build-contract.md): one demo flag (js/award-engine.js), the ham
    // test (KellyHamCalls.hamOf via meshfun), the self set (meshfun's engine). Demo never scores, saves or sends KF.
    // linkDemo: the demo mesh (also while it is still opening), the in-page MeshCore sim, the bridge's --mesh-sim (B8)
    const linkDemo = () => (ms.link === 'demo' && (!!st.link || st.status !== 'off')) || !!(st.link && (st.link.transport === 'sim' || st.link.meshSim));
    const awDemo = () => { try { return window.KellyAwards ? !!window.KellyAwards.demo() : linkDemo(); } catch { return true; } };
    if (window.KellyAwards && window.KellyAwards.addDemo) try { window.KellyAwards.addDemo(linkDemo); } catch (e) { console.warn('Awards', e); }
    // every KF request from an award writer (and this page) goes through here: none at all while any demo runs
    const kfSafe = (obj, label) => { if (awDemo()) { console.info('Kelly demo: KF request not sent', obj && obj.op); return Promise.resolve(null); } return k.kfRequest(obj, label); };
    const NOT_HAM = (window.KellyAwards && window.KellyAwards.NOT_HAM) || (window.KellyHC && window.KellyHC.NOT_HAM) || Object.freeze({ ham: false, tier: 'none', call: null, owner: null, cls: 'unknown', self: false, src: null, why: 'Ham Contacts did not load, so nothing scores', demo: false });
    // Fi: a meshfun call that may not exist yet (an older meshfun.js) -- quietly the fallback instead of a warning per call
    const Fi = (fn, dflt, ...a) => (fun && typeof fun[fn] === 'function' ? F(fn, ...a) : typeof dflt === 'function' ? dflt(...a) : dflt);
    const awk = {   // what mesh.js passes to every award writer's k (meshfun, meshpaths, meshgold)
      awardsDemo: () => awDemo(),
      hamOf: node => Fi('hamOf', x => { const H = window.KellyHamCalls; try { return H && H.hamOf ? H.hamOf(x) : NOT_HAM; } catch { return NOT_HAM; } }, node) || NOT_HAM,
      isSelf: key => !!Fi('isSelf', false, key),
      mutual: x => Fi('mutual', undefined, x),
      creditKm: (key, km, hops, chainKm) => Fi('creditKm', (kk, d, h, c) => { const A = window.KellyAwards; return A && A.kmCap ? A.kmCap(d, h, c) : d; }, key, km, hops, chainKm),
    };
    // Mesh Quest (js/meshfun.js): records, trophies, missions, club leaderboard. F() never lets it break the mesh.
    const fun = window.KellyMeshFun ? window.KellyMeshFun({ $, $$, esc, settings, store, toast, addEvent, dirty, ms, save: () => save(),
      audioCtx: k.audioCtx, fmtAgo: k.fmtAgo, currentPage: k.currentPage, showPage: k.showPage, kfRequest: kfSafe, ...awk,
      isDemo: () => awDemo(), online: () => st.status === 'on', myNum: () => st.myNum, myPos: () => myPos(), caps: () => caps(),
      devLabel: () => DEV_LABEL[ms.dev], nodes: () => st.nodes.values(),
      contactKeys: () => { try { return hcu && hcu._c ? hcu._c.svc.contacts().map(r => r.key) : null; } catch { return null; } },   // Calling Card's known-station snapshot
      myKey: () => { try { return myKey(); } catch { return null; } }, p25Of: name => p25Of({ name }), node: num => st.nodes.get(num >>> 0), nodeName: num => nm(num), hwOf: n => hwOf(n), distKm, bearing, showDx: r => showDx(r), focusNode: num => focusNode(num), showGolden: g => PA('showGolden', g) }) : null;
    const F = (fn, ...a) => { if (!fun) return; try { return fun[fn](...a); } catch (e) { console.warn('Mesh Quest', fn, e); } };
    // ---- the self set + Kelly's side of the ham test (KellyHamCalls.hooks, js/hc-calls.js)
    const kst = () => (window.kelly && window.kelly.state) || null;   // app.js's state (aliases, units, selfId) -- k has none of it
    const myKey = () => { const n = ms.dev === 'meshcore' ? me() : null; return n && n.key ? String(n.key).toLowerCase() : null; };
    // repeaters this Kelly logged in to as admin (Mesh Quest rpts) or keeps an admin password for (meshRptPw): mine
    let admMemo = null, admAt = 0;
    function adminKeys() {
      if (admMemo && Date.now() - admAt < 30000) return admMemo;
      const out = new Set();
      try { for (const kk of Object.keys(store.get('meshRptPw', {}) || {})) out.add(kk.toLowerCase()); } catch { /* */ }
      for (const sk_ of ['meshQuest2', 'meshQuest']) try { const p = store.get(sk_, null); for (const kk of Object.keys((p && p.rpts) || {})) out.add(kk.toLowerCase()); } catch { /* */ }
      admMemo = [...out].filter(x => /^[0-9a-f]{64}$/.test(x)).slice(0, 200); admAt = Date.now(); return admMemo;
    }
    let selfHooked = false;
    function hookSelf() {   // once meshfun's engine is there (it may make it in init)
      if (selfHooked || !fun) return;
      try { const eng = typeof fun.engine === 'function' ? fun.engine() : fun.engine; if (eng && typeof eng.addSelf === 'function') { eng.addSelf(adminKeys); selfHooked = true; } } catch (e) { console.warn('Awards', e); }
    }
    hookSelf();
    let hamMe = null, hamMeAt = 0;
    function hamMeNow() {
      if (hamMe && Date.now() - hamMeAt < 1000) return hamMe;
      const mc = String(settings.myCall || '').toUpperCase().trim(), gw = String(settings.gwCall || '').toUpperCase().trim();
      const keys = new Set([...(Fi('selfKeys', () => []) || []), myKey(), ...adminKeys()].filter(Boolean).map(x => String(x).toLowerCase()));
      const s = kst(), al = (s && s.aliases) || {}, ids = [settings.myId, s && s.selfId].map(x => String(x || '').trim()).filter(x => /^\d+$/.test(x) && +x > 0);
      const radios = new Set(ids);
      for (const id of ids) { const a = al[id]; if (a && a.base) radios.add(String(a.base)); }
      for (const [aid, a] of Object.entries(al)) if (a && a.base && radios.has(String(a.base))) radios.add(String(aid));
      hamMe = { call: gw || mc || null, callVerified: !!gw && gw === mc, keys: [...keys], radios: [...radios] }; hamMeAt = Date.now();
      return hamMe;
    }
    const aliasMap = () => { const s = kst(), out = {}; try { for (const [id, a] of Object.entries((s && s.aliases) || {})) if (a && a.base) out[id] = String(a.base); } catch { /* */ } return out; };
    // the gateway's callsign for a P25 radio: app.js's Last heard (u.gwCall = "CALL Name", from the gateway's userlist)
    const radioCallOf = radio => { const s = kst(), u = s && s.units && s.units[radio], g = u && u.gwCall; return g ? String(g).trim().split(/\s+/)[0].toUpperCase() : null; };
    if (window.KellyHamCalls && window.KellyHamCalls.hooks) try { window.KellyHamCalls.hooks({ me: hamMeNow, radioCall: radioCallOf, aliases: aliasMap, demo: () => awDemo() }); } catch (e) { console.warn('Ham Contacts', e); }
    // a change in who I am drops the ham memo: my call, the gateway's call for my radio, my node's key, the alias table
    let hamSig = '';
    function hamSync() {
      let al = 0; try { al = JSON.stringify((kst() || {}).aliases || {}).length; } catch { /* */ }
      const sig = [settings.myCall, settings.gwCall, settings.myId, myKey(), al, adminKeys().length].join('|');
      if (sig === hamSig) return; hamSig = sig; hamMe = null;
      try { if (window.KellyHamCalls && window.KellyHamCalls.bump) window.KellyHamCalls.bump(); } catch { /* */ }
    }
    setInterval(hamSync, 30000);
    function selfKnown(key) { if (!key) return; hookSelf(); Fi('connected', undefined, String(key).toLowerCase()); hamSync(); }
    // Mesh Paths (js/meshpaths.js): every route Kelly can see, the path map, golden packets. PA() never breaks the mesh either.
    let nodesVer = 0;   // bumps when a node's position / key changes: the path map re-resolves hashes then
    const paths = window.KellyMeshPaths ? window.KellyMeshPaths({ $, esc, store, toast, addEvent, dirty, ms, save: () => save(), fmtAgo: k.fmtAgo, currentPage: k.currentPage,
      devKey: () => ms.dev, devLabel: () => DEV_LABEL[ms.dev], node: num => st.nodes.get(num >>> 0), nodes: () => st.nodes.values(), nodesVer: () => nodesVer, nodeName: num => nm(num),
      myNum: () => st.myNum, myPos: () => myPos(), myCall: () => (settings.myCall || '').toUpperCase(), distKm, caps: () => caps(), session: () => st.session, isDriver: () => !!drv(),
      online: () => st.status === 'on', isDemo: () => ms.link === 'demo' && !!st.link, ...awk, map: () => st.map, sendDm: (num, text) => sendText(text, { to: num >>> 0, channel: 0 }, { tries: 1 }),   // a golden try tests ONE route: no retry, no flood fallback
      traceroute: num => traceroute(num), focusNode: num => focusNode(num), sfx: kind => sfx(kind), F: (fn, ...a) => F(fn, ...a), noteAdvert: a => noteAdvert(a),
      claimAir: (key, method) => TRU('claim', key, method) || null,   // the Trace Route tab's airtime budget (traces + floods)
      route2: path => route2(path),   // 2-byte hops only (traces, and the reverse-path route it sets)
      scrollToMap: () => { const el = $('#mesh-map'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }) : null;
    const PA = (fn, ...a) => { if (!paths) return; try { return paths[fn](...a); } catch (e) { console.warn('Mesh Paths', fn, e); } };
    // Repeater management (js/meshrepeaters.js): log in to a MeshCore repeater over the air, status, telemetry, CLI.
    const rpt = window.KellyMeshRepeaters ? window.KellyMeshRepeaters({ $, esc, store, toast, addEvent, dirty, fmtAgo: k.fmtAgo, currentPage: k.currentPage,
      session: () => st.session, caps: () => caps(), nodes: () => st.nodes.values(), online: () => st.status === 'on', myCall: () => (settings.myCall || '').toUpperCase(),
      sfx: kind => sfx(kind), F: (fn, ...a) => F(fn, ...a), SS: (kind, ...a) => SS('feed', kind, ...a),
      openTrace: (key, method) => { showMeshTab('trace'); return TRU('focus', key, method) || { ok: false, reason: 'Trace Route did not load' }; } }) : null;
    const RP =(fn, ...a) => { if (!rpt) return; try { return rpt[fn](...a); } catch (e) { console.warn('Mesh repeaters', fn, e); } };
    // Rooms (js/meshrooms.js): MeshCore room servers -- log in, read the posts, post. Off unless ms.rooms.
    const rooms = window.KellyMeshRooms ? window.KellyMeshRooms({ $, esc, store, toast, addEvent, dirty, ms, save: () => save(), fmtAgo: k.fmtAgo, currentPage: k.currentPage,
      session: () => st.session, caps: () => caps(), nodes: () => st.nodes.values(), online: () => st.status === 'on', sfx: kind => sfx(kind), F: (fn, ...a) => F(fn, ...a) }) : null;
    const RM = (fn, ...a) => { if (!rooms) return; try { return rooms[fn](...a); } catch (e) { console.warn('Mesh rooms', fn, e); } };
    // Channels (js/meshchannels.js): MeshCore channel slots, channel QRs + import (SET_CHANNEL); Meshtastic: the SEQ settings QR
    const chans = window.KellyMeshChannels ? window.KellyMeshChannels({ $, esc, toast, addEvent, dirty, currentPage: k.currentPage,
      session: () => st.session, online: () => st.status === 'on' && ms.dev === 'meshcore', dev: () => ms.dev, showTab: () => showMeshTab('main') }) : null;
    const CHN = (fn, ...a) => { if (!chans) return; try { return chans[fn](...a); } catch (e) { console.warn('Mesh channels', fn, e); } };
    // Set up a node over USB (js/meshsetup.js, ms.setup): a repeater / room server's own USB text console, not this link
    const setup = window.KellyMeshSetup ? window.KellyMeshSetup({ $, esc, ms, save: () => save(), toast, addEvent, currentPage: k.currentPage,
      wsUrl: () => meshWsUrl(), bridgeBusy: () => !!(st.link && st.link.transport === 'bridge') }) : null;
    const SU = (fn, ...a) => { if (!setup) return; try { return setup[fn](...a); } catch (e) { console.warn('Node setup', fn, e); } };
    // Golden Packet token (js/meshgold.js): one signed packet passed station to station, the gateway's ledger over P25
    const gold = window.KellyMeshGold ? window.KellyMeshGold({ $, esc, store, toast, addEvent, dirty, ms, save: () => save(), fmtAgo: k.fmtAgo, currentPage: k.currentPage,
      session: () => st.session, caps: () => caps(), nodes: () => st.nodes.values(), node: num => st.nodes.get(num >>> 0), nodeName: num => nm(num), myNum: () => st.myNum,
      myPos: () => myPos(), myCall: () => (settings.myCall || '').toUpperCase(), distKm, online: () => st.status === 'on', isDemo: () => ms.link === 'demo' && !!st.link, ...awk,
      sendDm: (num, text) => sendText(text, { to: num >>> 0, channel: 0 }), kfRequest: kfSafe, sfx: kind => sfx(kind), F: (fn, ...a) => F(fn, ...a) }) : null;
    const GD = (fn, ...a) => { if (!gold) return; try { return gold[fn](...a); } catch (e) { console.warn('Golden Packet', fn, e); } };
    // APRS iGate (js/igateui.js via app.js k.igate): MeshCore positions only -- never texts, channels or anything encrypted
    const IG = (kind, x) => { if (ms.dev !== 'meshcore') return; MPU('feed', kind, x); if (!k.igate) return; try { k.igate(kind, x); } catch (e) { console.warn('APRS iGate', kind, e); } };
    // Mesh trends (js/meshtrends.js): history charts from the bridge (--mesh-history), or made-up ones in the MeshCore demo
    const trd = window.KellyMeshTrends ? window.KellyMeshTrends({ $, esc, store, currentPage: k.currentPage, fmtAgo: k.fmtAgo,
      historyUrl: () => meshHistoryUrl(), isSim: () => !!(st.link && st.link.transport === 'sim') }) : null;
    const TR = (fn, ...a) => { if (!trd) return; try { return trd[fn](...a); } catch (e) { console.warn('Mesh trends', fn, e); } };
    // Coverage layer (js/meshcoverage.js): where the node hears stations direct, from the bridge history or the live nodes
    const cov = window.KellyMeshCoverage ? window.KellyMeshCoverage({ esc, fmtAgo: k.fmtAgo, nodes: () => st.nodes.values(), myNum: () => st.myNum,
      myPos: () => myPos(), on: () => !!ms.coverage, historyUrl: () => meshHistoryUrl(), isSim: () => !!(st.link && st.link.transport === 'sim'), driven: () => DV('points') }) : null;
    const CV = (fn, ...a) => { if (!cov) return; try { return cov[fn](...a); } catch (e) { console.warn('Mesh coverage', fn, e); } };
    // Drive mode (js/meshdrive.js, ms.drive): GPS + gated pings, which repeaters heard you -> the coverage layer's driven source
    const drive = window.KellyMeshDrive ? window.KellyMeshDrive({ $, esc, ms, store, toast, addEvent, dirty, save: () => save(), currentPage: k.currentPage,
      isSim: () => !!(st.link && st.link.transport === 'sim'), dev: () => ms.dev, online: () => st.status === 'on', session: () => st.session, channels: () => st.channels,
      nodes: () => st.nodes.values(), myNum: () => st.myNum, me: () => me(), F: (fn, ...a) => F(fn, ...a), sfx: kind => sfx(kind),
      setCoverage: on => setLayer('cov', on), rulesLimiter: () => { const E = rules(); return E && E._limiter; } }) : null;
    const DV = (fn, ...a) => { if (!drive) return; try { return drive[fn](...a); } catch (e) { console.warn('Drive mode', fn, e); } };
    // Offline map tiles (js/meshtiles.js, ms.tileCache / ms.tileOwn): the mesh map's tiles kept in the Cache API
    const tiles = window.KellyMeshTiles ? window.KellyMeshTiles({ $, esc, ms, save: () => save(), toast, dirty }) : null;
    const TL = (fn, ...a) => { if (!tiles) return; try { return tiles[fn](...a); } catch (e) { console.warn('Map tiles', fn, e); } };
    // Node info panel (js/meshinfo.js): opens over the map for the selected node (st.sel)
    const info = window.KellyMeshInfo ? window.KellyMeshInfo({ $, esc, fmtAgo: k.fmtAgo, sel: () => st.sel ?? null, unsel: () => { st.sel = null; dirty('mesh'); },
      node: num => st.nodes.get(num >>> 0), myNum: () => st.myNum, myPos: () => myPos(), distKm, hw: hwOf, id: n => nid(n.num),
      p25: n => isHam(n) ? p25Of(n) : null, routes: num => PA('routes', num) || null,
      canDm: n => !(ms.dev === 'meshcore' && n.role === 2),   // a MeshCore repeater takes no text (log in to manage it)
      dm: num => { const key = `dm${num}`; st.chats[key] = st.chats[key] || []; openChat(key); const t = $('#mesh-text'); if (t) t.focus(); },
      trace: num => traceroute(num), canTrace: n => st.status === 'on' && !!caps().trace && (caps().traceAny || n.role === 2 || n.role === 3),   // as the Nodes list centre: num => focusNode(num),
      trends: () => trd && ($('#tr-card') && !$('#tr-card').hidden) ? (src => TR('show', src)) : null }) : null;
    const MI = (fn, ...a) => { if (!info) return; try { return info[fn](...a); } catch (e) { console.warn('Mesh info', fn, e); } };
    // Contact management (js/meshcontacts.js): share / export / import / remove contacts, set this node's name (MeshCore)
    const ctc = window.KellyMeshContacts ? window.KellyMeshContacts({ $, esc, store, toast, dirty, currentPage: k.currentPage, session: () => st.session, caps: () => caps(),
      nodes: () => st.nodes.values(), myNum: () => st.myNum, me: () => me(), online: () => st.status === 'on', qrOn: () => ms.qr !== false }) : null;   // ms.qr: QR buttons (js/meshqr.js), on unless set false
    const CT = (fn, ...a) => { if (!ctc) return; try { return ctc[fn](...a); } catch (e) { console.warn('Mesh contacts', fn, e); } };
    // iPhone / iPad (iPadOS reports itself as a Mac): no Web Bluetooth, no Web Serial in any browser there
    const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // Station SCADA tab (js/stationscada-*.js): the home station as a plant mimic. Its live source taps this file's
    // MeshCore session through SS('feed', kind, ...) -- the raw RX log, USB frames, sends, link state, repeater reads.
    const radioOf = () => { const m = /([\d.]+) MHz · BW ([\d.]+) kHz · SF(\d+) · CR4\/(\d)(?: · (-?\d+) dBm)?/.exec(st.radio || ''); return m ? { freqMHz: +m[1], bwKHz: +m[2], sf: +m[3], cr: +m[4], txDbm: m[5] != null ? +m[5] : undefined } : null; };
    const scada = window.KellyStationScadaUI && window.StationScadaCore ? window.KellyStationScadaUI({ $, esc, settings, store, toast, saveSoon: k.saveSoon, audioCtx: k.audioCtx, fxLoop: k.fxLoop,
      currentPage: k.currentPage, fmtAgo: k.fmtAgo, myCall: () => (settings.myCall || '').toUpperCase(),
      live: { radio: radioOf, myCall: () => (settings.myCall || '').toUpperCase(), nodes: () => st.nodes.values(), myNum: () => st.myNum, me: () => me(), myPos: () => myPos(), distKm, bearing,
        status: () => st.status, fw: () => st.fw, replay: () => RP('replay'),
        hostUrl: () => { const u = meshHistoryUrl(); return u ? u.replace('/api/mesh-history', '/api/host') : ''; } } }) : null;
    const SS = (fn, ...a) => { if (!scada) return; try { return scada[fn](...a); } catch (e) { console.warn('Station SCADA', fn, e); } };
    // MeshCore Analyser tab + the path hash size check (js/mcdecode.js, js/mchashcheck.js, js/mcanalyser.js; 2026-10-24)
    const MCD = window.KellyMcDecode, MHC = window.KellyMcHashCheck;
    const HC = MHC && MCD ? MHC.create({ store }) : null;
    const byPrefix = h => { h = String(h || '').toLowerCase(); const out = []; if (!h) return out; for (const n of st.nodes.values()) if (n.key && n.key.startsWith(h)) out.push({ name: n.longName || n.shortName || n.key.slice(0, 8), label: callLabel(n.key, n.longName || n.shortName || n.key.slice(0, 8)), key: n.key, role: String(n.hwLabel || '').toLowerCase() }); return out; };
    const decodeOpts = () => ({ channels: st.session && st.session.channelKeys ? st.session.channelKeys() : [], expectHash: ms.hashExpect || 2 });
    const showMeshTab = t => { k.showPage('mesh'); const b = $(`[data-tabs="mesh"] [data-tab="${t}"]`); if (b) b.click(); };
    const an = window.KellyMcAnalyser && HC ? window.KellyMcAnalyser({ $, esc, toast, decodeOpts, byPrefix, myName: () => (me() || {}).longName || '', fmtAgo: k.fmtAgo,
      fx: () => !!settings.fx && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches),
      hash: { nodes: () => HC.nodes(), log: () => HC.log(), clear: () => { HC.clear(); dirty('mesh'); }, forget: id => HC.forget(id), expected: () => ms.hashExpect || 2,
        setExpected: v => { ms.hashExpect = v; save(); dirty('mesh'); }, hint: r => MHC.hint(r), p25: { on: () => !!ms.hashP25, set: b => { ms.hashP25 = !!b; save(); } } } }) : null;
    const AN = (fn, ...a) => { if (!an) return; try { return an[fn](...a); } catch (e) { console.warn('MeshCore Analyser', fn, e); } };
    // Packet Journey tab (js/pj-*.js, 2026-10-24): the same packets, drawn flying along their hop paths
    const pj = window.KellyPacketJourneyUI && MCD ?window.KellyPacketJourneyUI({ $, esc, store, toast, settings, audioCtx: k.audioCtx, fxLoop: k.fxLoop, fmtAgo: k.fmtAgo,
      decodeOpts, byPrefix, myName: () => (me() || {}).longName || '', myPos: () => myPos(), radio: radioOf, makeMap: k.makeMap }) : null;
    const PJ = (fn, ...a) => { if (!pj) return; try { return pj[fn](...a); } catch (e) { console.warn('Packet Journey', fn, e); } };
    // Trace Route tab (js/tr-*.js, 2026-10-24): one station, the route there and back, star by star
    const tru = window.KellyTraceRouteUI ? window.KellyTraceRouteUI({ $, esc, store, toast, settings, audioCtx: k.audioCtx, fxLoop: k.fxLoop, fmtAgo: k.fmtAgo, makeMap: k.makeMap,
      myPos: () => myPos(), radio: radioOf, distKm, nodes: () => st.nodes.values(), myNum: () => st.myNum, myName: () => (me() || {}).longName || '',
      hashSize: () => st.hashMode != null ? (st.hashMode & 3) + 1 : 1, online: () => st.status === 'on' && ms.dev === 'meshcore', isSimLink: () => !!(st.link && st.link.transport === 'sim'),
      session: () => st.session, inbound: num => PA('inbound', num) || null,
      sendDm: (num, text) => sendText(text, { to: num >>> 0, channel: 0 }, { tries: 1 }),   // Trace Route's ping: one try, shown in the chat
      sendsOf: (key, name) => { if (!HC) return null; const r = HC.nodes().find(x => (key && x.key && x.key.toLowerCase() === key) || (name && x.id === `name:${name}`)); return r ? { size: r.size, strength: r.strength } : null; },
      noteTrace: (num, r, t0) => { const tr = traceRecord(num, r, t0); st.traces.unshift(tr); st.traces.splice(10); F('trace', tr); PA('trace', tr); dirty('mesh'); } }) : null;
    const TRU = (fn, ...a) => { if (!tru) return; try { return tru[fn](...a); } catch (e) { console.warn('Trace Route', fn, e); } };
    // Ham Contacts tab (js/hc-*.js, 2026-10-24): other hams onto this node's contacts, and us onto theirs
    const hcu = window.KellyHamContactsUI ? (() => { try { return window.KellyHamContactsUI({ $, esc, store, toast, settings, save: () => save(), fmtAgo: k.fmtAgo, myPos: () => myPos(), distKm,
      nodes: () => st.nodes.values(), myNum: () => st.myNum, me: () => me(), session: () => st.session, online: () => st.status === 'on' && ms.dev === 'meshcore',
      isMeshCore: () => ms.dev === 'meshcore', isSimLink: () => !!(st.link && st.link.transport === 'sim'), kfRequest: kfSafe, showTab: () => showMeshTab('contacts'),
      // a radio that restarted under an open port (a contact remove on some firmwares): drop the link, auto-reconnect redoes APP_START
      relink: why => { const l = st.link; if (!l) return; linkLost(why); Promise.resolve().then(() => l.close()).catch(() => {}); },
      openTrace: (key, method) => { showMeshTab('trace'); return TRU('focus', key, method) || { ok: false, reason: 'Trace Route did not load' }; },
      autoReconnect: () => !!ms.autoReconnect,
      sendDm: (num, text) => sendText(text, { to: num >>> 0, channel: 0 }),   // the QR swap's "73 de" DM: its ACK = they hold our key
      openChat: num => { showMeshTab('main'); const key = `dm${num >>> 0}`; st.chats[key] = st.chats[key] || []; openChat(key); const t = $('#mesh-text'); if (t) t.focus(); },
      // Heard operators (js/hc-ops.js): channel names, a channel post with a mention typed in, the P25 alternative
      chans: () => (st.channels || []).filter(Boolean).map(c => ({ index: c.index, name: chName(c.index) })),
      openChannel: (index, text) => { showMeshTab('main'); const key = `ch${index || 0}`; st.chats[key] = st.chats[key] || []; openChat(key); const t = $('#mesh-text'); if (t) { if (text) t.value = text; t.dispatchEvent(new Event('input', { bubbles: true })); t.focus(); } },
      p25Of: n => p25Of(n), openP25: id => k.openP25(id) }); } catch (e) { console.warn('Ham Contacts', e); return null; } })() : null;
    const HCU = (fn, ...a) => { if (!hcu) return; try { return hcu[fn](...a); } catch (e) { console.warn('Ham Contacts', fn, e); } };
    // Property Guard tab (js/pg-ui.js, 2026-10-25): concept demo -- a RAK4631 shed alarm over MeshCore -> P25X messages, all simulated
    const pgu = window.KellyPropertyGuardUI ? (() => { try { return window.KellyPropertyGuardUI({ $, esc, store, toast, settings, audioCtx: k.audioCtx }); } catch (e) { console.warn('Property Guard', e); return null; } })() : null;
    const PGU = (fn, ...a) => { if (!pgu) return; try { return pgu[fn](...a); } catch (e) { console.warn('Property Guard', fn, e); } };
    // LoRa Mesh > 📍 MeshPRS tab (js/mprs-ui.js): MeshPRS frames and listed adverts on a map, on the APRS iGate page's engine
    const mpu = window.KellyMeshPRSUI ? (() => { try { return window.KellyMeshPRSUI({ $, esc, store, toast, settings, fmtAgo: k.fmtAgo, ms, myPos: () => myPos(),
      igate: () => (k.igateUI ? k.igateUI() : null), demo: () => window.KellyMeshDemo || null, isMeshCore: () => ms.dev === 'meshcore', showPage: k.showPage,
      nodeName: key => { for (const n of st.nodes.values()) if (n.key === key) return n.longName || ''; return ''; } }); } catch (e) { console.warn('MeshPRS', e); return null; } })() : null;
    const MPU = (fn, ...a) => { if (!mpu) return; try { return mpu[fn](...a); } catch (e) { console.warn('MeshPRS', fn, e); } };
    // LoRa Mesh > 🐕 Mesh Buddy tab (js/meshbuddy.js): flash + set up a Mesh Buddy tracker over USB from this station's callsign
    const mbu = window.KellyMeshBuddyUI ? (() => { try { return window.KellyMeshBuddyUI({ $, esc, store, toast, settings, showPage: k.showPage,
      igate: () => (k.igateUI ? k.igateUI() : null) }); } catch (e) { console.warn('Mesh Buddy', e); return null; } })() : null;
    const MBU = (fn, ...a) => { if (!mbu) return; try { return mbu[fn](...a); } catch (e) { console.warn('Mesh Buddy', fn, e); } };
    // Ham Contacts bus -> Mesh Quest (contact-making awards, AWARDS_REVIEW.md section 4): outreach + the demo world's Handshakes
    if (hcu && typeof hcu.on === 'function') try {
      const opKey = e => String(e.key || (e.result && e.result.value && e.result.value.key) || '').toLowerCase();
      hcu.on('card', p => Fi('outreach', undefined, 'card', Object.assign({ at: Date.now() }, p || {})));
      hcu.on('advert', p => { if (!p) return; Fi('outreach', undefined, p.mode === 'share' ? 'share' : 'advert', Object.assign({ at: Date.now() }, p)); });
      hcu.on('op', e => { if (e && e.op === 'add' && e.phase === 'done' && e.from === 'dir' && e.result && e.result.ok && opKey(e)) Fi('outreach', undefined, 'dirAdd', { key: opKey(e), at: Date.now() }); });
      hcu.on('dir', p => { if (p) Fi('outreach', undefined, p.mineListed ? 'listed' : 'dir', p.mineListed ? { key: myKey(), firstOf: p.firstOf || {}, at: Date.now() } : { mineListed: false, firstOf: p.firstOf || {} }); hamSync(); });   // firstOf feeds Welcome Wagon either way
      hcu.on('mutual', p => { if (!p || !p.key) return; if (p.yours) Fi('connected', undefined, p.key); Fi('mutual', undefined, Object.assign({}, p, { demo: true })); });   // only the demo world emits it; its 'yours' station joins the (demo) self set   // only the demo world emits it
    } catch (e) { console.warn('Ham Contacts', e); }
    if (window.KellyHamCalls && window.KellyHamCalls.onChange) window.KellyHamCalls.onChange(() => { nodesVer++; dirty('mesh'); });   // a callsign edit shows in the chat / Packet Journey at once
    // a node's name with its callsign where one is known (js/hc-calls.js window.KellyHamCalls): the chat, Packet Journey
    // (key null: a channel sender known only by name -- the mapping may still know that name)
    function callLabel(key, name) { const H = window.KellyHamCalls; if (!H || !name || ms.dev !== 'meshcore') return name; try { return H.label(key || null, name) || name; } catch { return name; } }
    const nmc = num => { const n = st.nodes.get(num >>> 0); return n ? callLabel(n.key, nm(num)) : nm(num); };
    // every packet the companion hears: to the analyser, and through the hash size check (logged quietly, no pop-up --
    // 2026-10-24: "stop the pop up warnings about 1 byte packets"; the P25 text stays opt-in)
    function onRxPacket(e) {
      AN('feed', e); PJ('feed', e);
      if (!HC || !e.raw) return;
      const r = HC.check(MCD.decode(e.raw, decodeOpts()), e, { expected: ms.hashExpect || 2, byPrefix });
      if (!r) return;
      AN('refreshChecks'); dirty('mesh');
      if (!r.alert) return;   // once a day per node
      const msg = `${r.rec.name} sends ${r.rec.size}-byte path hashes; this network expects ${r.rec.expected}-byte`;
      addEvent('network', `LoRa Mesh: ${msg} (${r.rec.strength}, from a ${r.rec.type})`);
      if (ms.hashP25) {
        const dest = parseInt(ms.toP25Dest, 10);
        if (dest > 0) queueToP25({ dest, text: `MESH HASH ${r.rec.name}: ${r.rec.size}-byte, expected ${r.rec.expected}-byte` });
        else addEvent('data', 'Hash size alert not sent to P25: set the P25 radio in the P25 bridge card');
      }
    }
    // our own node vs the network (DEVICE_INFO path_hash_mode at connect; the expected size when it changes): the line on
    // the connection card + its fix button, and the alert card listing nodes heard on the wrong size
    function hashUI() {
      const w = $('#mesh-hashwarn'), exp = ms.hashExpect || 2;
      const sc = HC && st.status === 'on' && ms.dev === 'meshcore' ? HC.self(st.hashMode, exp) : null;
      if (w) {
        w.hidden = !sc || sc.ok;
        const sig = sc && !sc.ok ? `${sc.ours}|${exp}` : '';
        if (w.dataset.sig !== sig) {
          w.dataset.sig = sig;
          w.innerHTML = sig ? `<span>⚠️ Your node sends <b>${sc.ours}-byte</b> path hashes; this network expects ${exp}-byte.</span><button class="btn small primary" id="mesh-hashfix">Set my node to ${exp}-byte</button>` : '';
          const b = $('#mesh-hashfix'); if (b) b.onclick = fixHash;
        }
      }
      const c = $('#mh-hcard'); if (!c || !HC) return;
      const list = HC.nodes().filter(n => n.expected === exp && n.size !== exp), sig = list.map(n => `${n.id}${n.last}`).join('|');
      c.hidden = !list.length;
      const n = $('#mh-hcount'); if (n) n.textContent = `${list.length} node${list.length === 1 ? '' : 's'}`;
      if (c.dataset.sig === sig) return;
      c.dataset.sig = sig;
      $('#mh-hlist').innerHTML = list.slice(0, 6).map(n => `<div class="mh-hrow"><div><b>${esc(n.name)}</b> <small>${n.role ? `${esc(n.role)} · ` : ''}${n.strength === 'certain' ? 'certain (advert)' : 'likely'}</small></div>`
        + `<div><span class="mca-hs bad">${n.size}-byte</span> <small>expected ${n.expected} · ${esc(k.fmtAgo(n.last))}</small></div><div class="fix">${esc(MHC.hint(n))}</div></div>`).join('')
        + (list.length > 6 ? `<p class="small dim">…and ${list.length - 6} more in the MeshCore Analyser.</p>` : '');
    }
    async function fixHash() {
      const exp = ms.hashExpect || 2;
      try { await st.session.setPathHashMode(exp - 1); toast('✅', `Your node now sends ${exp}-byte path hashes`, 'Saved on the node; no reboot needed', 'good'); addEvent('network', `LoRa Mesh: this node set to ${exp}-byte path hashes`); }
      catch (e) { toast('⚠️', "Couldn't change the node's path hash size", e.message, 'bad'); }
      dirty('mesh');
    }
    // A MeshCore advert heard on air from a station that isn't a contact (auto-add off, or a repeater): keep its name,
    // key and position, so the path map can name the hop and place it.
    function noteAdvert(a) {
      if (!a || a.num == null || a.num === st.myNum) return;
      const old = st.nodes.get(a.num), C = window.KellyMeshCore && window.KellyMeshCore.DRIVER;
      // heard DIRECT (a 0-hop flood advert): its own signal, kept apart from n.hops (a contact's route length, re-read from
      // the node) -- the coverage layer (js/meshcoverage.js) reads n.directSnr / n.directAt
      const direct = a.hops === 0 && a.snr != null;
      // every advert: when, its hops and the repeaters it came through (Ham Contacts > Heard operators); RSSI only direct
      const adv = { advAt: Date.now(), advHops: a.hops ?? null, advPath: a.path && Array.isArray(a.path.h) ? { sz: a.path.sz, h: a.path.h.slice(0, 64) } : null, ...(direct && a.rssi != null ? { rssi: a.rssi } : {}) };
      if (old) Object.assign(old, adv, { lastHeard: Date.now() });
      if (old && direct) Object.assign(old, { snr: a.snr, directSnr: a.snr, directAt: Date.now(), lastHeard: Date.now() });
      if (old && (old.lat != null || a.lat == null) && old.key) return;
      const TYPE = { 1: 'Companion', 2: 'Repeater', 3: 'Room server', 4: 'Sensor' };
      const n = Object.assign(old || { num: a.num, firstHeard: Date.now(), advertOnly: true }, {
        key: (old && old.key) || a.key, idLabel: a.key.slice(0, 12), longName: (old && old.longName) || a.name || a.key.slice(0, 8),
        shortName: (old && old.shortName) || (C ? C.shortOf(a.name || '') : (a.name || '?').slice(0, 4)), hwLabel: (old && old.hwLabel) || TYPE[a.type] || 'Node',
        role: old && old.role != null ? old.role : a.type, licensed: (old && old.licensed) || (C ? C.looksHam(a.name) : false), lastHeard: Date.now(), ...adv,
        ...(direct ? { snr: a.snr, directSnr: a.snr, directAt: Date.now() } : {}) });
      if (a.lat != null) { n.lat = a.lat; n.lon = a.lon; }
      st.nodes.set(a.num, n); nodesVer++; saveNodes(); dirty('mesh');
    }

    // ------------------------------------------------------------------ sounds (WebAudio synth, nothing on air)
    // Quiet hours (Phase 6c, ms.quiet {on, from, to} 'HH:MM', may wrap midnight): mesh sounds stay silent, except the
    // ones that are a call for help -- SOS and a critical P25X alert -- which also ignore their own tick and the mesh mute
    // (the page-wide Sound switch still wins: that one is the user saying "no sound at all").
    const CRITICAL_SFX = new Set(['sos', 'alert-critical']);
    function quietNow(d = new Date()) {
      const q = ms.quiet; if (!q || !q.on) return false;
      const m = s => { const x = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return x ? +x[1] * 60 + +x[2] : null; };
      const a = m(q.from), b = m(q.to), t = d.getHours() * 60 + d.getMinutes();
      if (a == null || b == null || a === b) return false;
      return a < b ? t >= a && t < b : t >= a || t < b;
    }
    function sfx(kind) {
      const crit = CRITICAL_SFX.has(kind);
      if (!settings.sound || (!crit && (!ms.sound || ms.sfx[kind.startsWith('alert-') ? 'alert' : kind] === false || quietNow()))) return;
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;   // the browser blocks sound until a first click
      try {
        const ctx = k.audioCtx(), t0 = ctx.currentTime, vol = (settings.soundVol ?? 0.7);
        const env = (g, t, a, peak, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * vol), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + d); };
        const osc = (type, f0, f1, t, d, peak, a = 0.01) => {   // a sweep = a LoRa chirp
          const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
          o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + d * 0.9);
          env(g, t, a, peak, d); o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + d + 0.05);
        };
        const cw = (code, t, f = 700, dit = 0.05) => { for (const ch of code) { if (ch === ' ') { t += dit * 3; continue; } const d = ch === '-' ? dit * 3 : dit; osc('sine', f, f, t, d, 0.12, 0.004); t += d + dit; } };
        switch (kind) {
          case 'rx': osc('sine', 420, 1650, t0, 0.11, 0.07); osc('sine', 420, 1650, t0 + 0.12, 0.11, 0.05); break;
          case 'text': osc('sine', 500, 1800, t0, 0.09, 0.06); osc('triangle', 1318, 1318, t0 + 0.12, 0.25, 0.11); osc('triangle', 1760, 1760, t0 + 0.2, 0.35, 0.09); break;
          case 'dm': [1046, 1318, 1568, 2093].forEach((f, i) => osc('triangle', f, f, t0 + i * 0.07, 0.28, 0.12)); osc('sine', 3136, 4186, t0 + 0.3, 0.4, 0.03); break;
          case 'node': [523, 659, 784, 988, 1175, 1568].forEach((f, i) => osc('square', f, f * 1.01, t0 + i * 0.045, 0.12, 0.035)); osc('sine', 300, 2400, t0 + 0.3, 0.35, 0.05); break;
          case 'ham': cw('--... ...--', t0 + 0.05); break;   // "73" in CW, 24 wpm
          case 'cq': cw('-.-. --.-', t0 + 0.05, 800); break;    // "CQ" in CW: someone's calling
          // P25X alerts arriving on the mesh (mesh-bridge-rules.js compact form), by priority -- never looping
          case 'alert-routine': osc('sine', 880, 880, t0, 0.09, 0.1); osc('sine', 880, 880, t0 + 0.16, 0.09, 0.1); break;
          case 'alert-priority': [0, 0.5].forEach(o => [659, 880, 1175].forEach((f, i) => osc('triangle', f, f, t0 + o + i * 0.11, 0.14, 0.13))); break;
          case 'alert-critical': for (let r = 0; r < 3; r++) { osc('sawtooth', 600, 1400, t0 + r * 0.9, 0.35, 0.1, 0.005); osc('sawtooth', 1400, 600, t0 + r * 0.9 + 0.4, 0.35, 0.1, 0.005); } break;
          case 'sos': for (let i = 0; i < 6; i++) osc('square', i % 2 ? 770 : 960, i % 2 ? 770 : 960, t0 + i * 0.32, 0.3, 0.09, 0.01); cw('... --- ...', t0 + 2.1, 880); break;   // siren, then SOS
          case 'tx': osc('sine', 1700, 380, t0, 0.13, 0.07); osc('sine', 1700, 380, t0 + 0.14, 0.13, 0.05); break;
          case 'ack': osc('sine', 1500, 1500, t0, 0.05, 0.08); osc('sine', 2000, 2000, t0 + 0.07, 0.07, 0.08); break;
          case 'trace': osc('sine', 1180, 1150, t0, 0.9, 0.16, 0.005); osc('sine', 1180, 1150, t0 + 0.45, 0.7, 0.05, 0.005); break;   // sonar ping + echo
          case 'bridge': {
            const n = Math.floor(ctx.sampleRate * 0.6), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
            for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
            const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = buf; f.type = 'bandpass'; f.Q.value = 3;
            f.frequency.setValueAtTime(300, t0); f.frequency.exponentialRampToValueAtTime(4000, t0 + 0.5); env(g, t0, 0.08, 0.12, 0.6);
            s.connect(f).connect(g).connect(ctx.destination); s.start(t0);
            for (let i = 0; i < 8; i++) osc('square', i % 2 ? 1200 : 2200, i % 2 ? 1200 : 2200, t0 + 0.45 + i * 0.03, 0.025, 0.03, 0.002);   // P25-ish data burble
            break;
          }
          case 'connect': osc('sawtooth', 110, 880, t0, 0.5, 0.05, 0.05); [880, 1320, 1760].forEach((f, i) => osc('sine', f, f, t0 + 0.5 + i * 0.08, 0.2, 0.08)); break;
          case 'fail': osc('sawtooth', 220, 110, t0, 0.4, 0.07); break;
        }
      } catch { /* audio not unlocked yet */ }
    }

    // ------------------------------------------------------------------ links
    // Each: { name, open(onBytes|onPacket), write(ToRadio bytes), close(), framed }. With a driver (d), write() takes
    // what the driver's Session sends and d.wrap() puts the transport's framing on it (MeshCore '<' len over USB).
    // reuse: what an earlier link left in .reuse -- reconnects without the browser's chooser (which needs a click)
    function serialLink(d, reuse) {
      let port, reader, alive = true;
      return { name: 'USB', transport: 'usb', async open(onBytes) {
        if (!navigator.serial) throw new Error('This browser has no Web Serial (use Chrome or Edge, from this PC -- or the Bridge link)');
        if (reuse) {   // the same USB device, once it's plugged back in
          port = (await navigator.serial.getPorts()).find(p => { const i = p.getInfo(); return i.usbVendorId === reuse.usbVendorId && i.usbProductId === reuse.usbProductId; });
          if (!port) throw new Error('the USB node is not plugged in');
        } else port = await navigator.serial.requestPort();
        this.reuse = port.getInfo();
        await port.open({ baudRate: d ? d.baud : M.BAUD });
        if (d) { try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {} }   // don't reset an ESP32 board
        (async () => { while (alive && port.readable) { reader = port.readable.getReader(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) onBytes(value); } } catch { } finally { reader.releaseLock(); } } if (alive) linkLost('USB device unplugged'); })();
        if (!d) await this.raw(M.WAKE);
      }, async raw(b) { const w = port.writable.getWriter(); try { await w.write(b); } finally { w.releaseLock(); } },
      write(b) { return this.raw(d ? (d.wrap ? d.wrap(b, 'usb') : b) : M.frame(b)); },
      async close() { alive = false; try { await reader?.cancel(); } catch {} try { await port?.close(); } catch {} } };
    }
    // A driver's Bluetooth: one of its services (a LoRa APRS tracker offers KISS or TNC2), characteristics picked by
    // property -- notify in, write out -- since CA2RXU's TNC2 service swaps the usual Nordic UART roles.
    // Writes go one at a time (overlapping GATT writes drop MeshCore links).
    function bleDriverLink(d, reuse) {
      let dev, wr, chain = Promise.resolve();
      return { name: 'Bluetooth', transport: 'ble', mode: null, async open(onBytes) {
        if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth (Chrome or Edge, from this PC -- or the Bridge link)');
        dev = reuse || await navigator.bluetooth.requestDevice({ filters: d.ble.services.map(s => ({ services: [s] })), optionalServices: d.ble.services });
        this.reuse = dev; onBleLost(dev);
        const gatt = await dev.gatt.connect();
        let svc = null;
        for (const s of d.ble.services) { try { svc = await gatt.getPrimaryService(s); this.mode = (d.ble.modes || {})[s] || null; break; } catch {} }
        if (!svc) throw new Error(`${dev.name || 'that device'} has no ${d.label} service`);
        const chars = await svc.getCharacteristics();
        const nt = chars.find(c => c.properties.notify);
        wr = chars.find(c => c !== nt && (c.properties.write || c.properties.writeWithoutResponse));
        if (!nt || !wr) throw new Error(`${dev.name || 'that device'}: its ${d.label} service has no notify/write pair`);
        nt.addEventListener('characteristicvaluechanged', e => { const v = e.target.value; onBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), d.ble.framed); });
        await nt.startNotifications();   // MeshCore: this is where the OS asks for the node's PIN
        this.devName = dev.name || '';
      }, write(b) {
        const out = d.wrap ? d.wrap(b, 'ble') : b;
        chain = chain.then(() => wr.properties.write ? wr.writeValueWithResponse(out) : wr.writeValueWithoutResponse(out));
        return chain;
      }, async close() { try { dev?.gatt?.disconnect(); } catch {} } };
    }
    function bleLink(reuse) {
      let dev, toR, fromR, fromNum, busy = false, onB;
      const drain = async () => {
        if (busy) return; busy = true;
        try { for (let i = 0; i < 200; i++) { const v = await fromR.readValue(); if (!v.byteLength) break; onB(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), true); } } catch (e) { k.addEvent('error', `Mesh BLE read: ${e.message}`); }
        busy = false;
      };
      return { name: 'Bluetooth', async open(onBytes) {
        if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth (Chrome or Edge, from this PC -- or the Bridge link)');
        onB = onBytes;
        dev = reuse || await navigator.bluetooth.requestDevice({ filters: [{ services: [M.BLE.service] }] });
        this.reuse = dev; onBleLost(dev);
        const svc = await (await dev.gatt.connect()).getPrimaryService(M.BLE.service);
        [toR, fromR, fromNum] = await Promise.all([svc.getCharacteristic(M.BLE.toRadio), svc.getCharacteristic(M.BLE.fromRadio), svc.getCharacteristic(M.BLE.fromNum)]);
        await fromNum.startNotifications(); fromNum.addEventListener('characteristicvaluechanged', drain);
        this.drain = drain;
      }, async write(b) { await toR.writeValueWithResponse(b); setTimeout(drain, 50); },
      async close() { try { dev?.gatt?.disconnect(); } catch {} } };
    }
    function bridgeLink(d) {
      let ws, sim = false;   // sim: the bridge runs --mesh-sim (its target says so): a demo for the awards (B8)
      return { name: 'Bridge', transport: 'bridge', get meshSim() { return sim; }, async open(onBytes) {
        // the mesh bridge's own address if set (a node on another network, e.g. a MeshCore WiFi node beside the
        // Ipswich NUC: "100.64.0.10:8026?token=..."), else the bridge this Kelly's radio uses
        const url = meshWsUrl();
        await new Promise((res, rej) => {
          ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
          const t = setTimeout(() => rej(new Error(`no answer from ${url}`)), 6000);
          ws.onopen = () => { clearTimeout(t); res(); };
          ws.onerror = () => { clearTimeout(t); rej(new Error(/[?&]token=/.test(url) ? `can't reach the bridge at ${url.replace(/([?&]token=)[^&]+/, '$1…')} -- check the address and the token (a wrong token is refused), and that the bridge runs with --mesh-serial or --mesh-tcp`
            : `the bridge at ${url} refused the link: no token -- open Kelly once with ?token=… in the address (or scan the bridge's QR), or put the token in the Mesh bridge address`)); };
        });
        ws.onmessage = e => { if (typeof e.data === 'string') { try { const j = JSON.parse(e.data); if (typeof j.target === 'string') sim = /--mesh-sim|simulated MeshCore/.test(j.target); if (j.bridge) { st.note = `Bridge: ${j.bridge}${j.target ? ` (${j.target})` : ''}`; dirty('mesh'); } if (j.node) nodeState(j); if (typeof j.watch === 'boolean') setWatch(j.watch); } catch {} return; } onBytes(new Uint8Array(e.data)); };
        ws.onclose = () => linkLost('bridge closed the mesh link');
        if (!d) ws.send(M.WAKE);
      }, async write(b) {
        if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('the mesh bridge link is closed');
        if (st.watch) throw new Error(WATCH_MSG);
        ws.send(d ? (d.wrap ? d.wrap(b, 'bridge') : b) : M.frame(b));
      }, alive: () => !!ws && ws.readyState === WebSocket.OPEN, close() { try { ws.onclose = null; ws.close(); } catch {} } };
    }
    function demoLink() { return demoMesh(); }
    // MeshCore's demo: a simulated companion node (js/meshcoresim.js) answering the real driver frame by frame
    function simLink() {
      let sim = null;
      return { name: 'Demo', transport: 'sim', async open(onBytes) {
        if (!window.KellyMeshCoreSim) throw new Error('the MeshCore simulator (js/meshcoresim.js) is not loaded');
        sim = window.KellyMeshCoreSim.create({ auto: true, seed: Date.now() >>> 0 });
        sim.onFrame(f => onBytes(f, true));
        window.KellyMeshDemo = { inject: sim.inject, world: sim.world, state: sim.state };   // the demo only: tests / demo buttons make a station act now
        st.note = 'Demo MeshCore mesh -- simulated, nothing transmitted';
      }, write(b) { if (!sim) throw new Error('the demo node is closed'); sim.write(b); },
      close() { if (sim) sim.stop(); sim = null; delete window.KellyMeshDemo; } };
    }
    // one listener per Bluetooth device, however often it reconnects
    function onBleLost(dev) { if (dev.kellyLost) return; dev.kellyLost = true; dev.addEventListener('gattserverdisconnected', () => linkLost('Bluetooth disconnected')); }
    // the /mesh WebSocket: the mesh bridge's own address if set, else the bridge this page came from, else the radio's
    // The page's bridge token, remembered per bridge address the moment a page is opened with ?token=, so a tab opened
    // later without it (a bookmark, a typed address -- the owner's PC, 2026-10-23) still has it. The bridge checks it.
    function pageToken() {
      const tok = new URLSearchParams(location.search).get('token'), tk = `bridgeToken:${location.host}`;
      if (!/^https?:/.test(location.protocol)) return tok;
      if (tok) { if (store.get(tk, '') !== tok) store.set(tk, tok); return tok; }
      return store.get(tk, '') || null;
    }
    pageToken();
    function meshWsUrl() {
      const own = meshBridgeUrl();
      // the page came from a bridge: its /mesh wants the same token as /ws (the radio link's, or the page's ?token=) --
      // without it a bridge started with --token refuses the link (403; seen 2026-10-21)
      // a ?token= in the address wins: the saved Bridge URL can still hold a token that has since been changed
      // (2026-10-23 -- the old one was refused and the phone link never came up)
      let tok = pageToken();
      if (!new URLSearchParams(location.search).get('token')) try { tok = new URL(String(settings.url || '').replace(/^ws/i, 'http')).searchParams.get('token') || tok; } catch {}
      // served by a bridge: its plain port 8025, its --tls-port 8443, or any page opened with ?token= (the owner's phone, 2026-10-23)
      const fromBridge = /^https?:/.test(location.protocol) && (/:(8025|8443)$/.test(location.host) || !!new URLSearchParams(location.search).get('token'));
      const base = own || (fromBridge ?`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${tok ? `?token=${encodeURIComponent(tok)}` : ''}` : settings.url);
      let u = own || String(base || '').replace(/\/ws(\?|$)/, '/mesh$1');
      // the Pi keeper says so: the bridge has it only listen while anyone else uses the node (other programs on the
      // Pi, like a member's telemetry poller, are ordinary clients -- 2026-11-01)
      if (/[?&]keeper\b/.test(location.search)) u += `${u.includes('?') ? '&' : '?'}keeper=1`;
      return window.KellySecure ? KellySecure.wsUrl(u) : u;   // https page: ws:// -> wss:// (js/secure.js)
    }
    // the same bridge's history (bridge --mesh-history): only while the mesh comes through a bridge, or one is set
    function meshHistoryUrl() {
      if (!(st.link && st.link.transport === 'bridge') && !String(ms.bridgeUrl || '').trim()) return '';
      const m = /^(wss?):\/\/([^/?#]+)[^?#]*(\?[^#]*)?/i.exec(meshWsUrl()); if (!m) return '';
      const tok = new URLSearchParams(m[3] || '').get('token');
      return `${m[1].toLowerCase() === 'wss' ? 'https' : 'http'}://${m[2]}/api/mesh-history${tok ? `?token=${encodeURIComponent(tok)}` : ''}`;
    }
    // "host:port", "host:port?token=x", "ws://host:port/mesh?token=x" -> a /mesh WebSocket URL ('' = not set)
    // Share the Mesh bridge address as a QR code (2026-10-23). The QR holds the address the way the field
    // takes it: host:port[/path]?token=... (wss:// kept, so an http Kelly still uses TLS for an https bridge).
    // bridgeShareText: the address in use -- the field's, else the one meshWsUrl() works out.
    function bridgeShareText() {
      const m = /^(wss?):\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/i.exec(meshWsUrl() || ''); if (!m) return '';
      const path = !m[3] || m[3] === '/' || m[3] === '/mesh' ? '' : m[3];
      return `${m[1].toLowerCase() === 'wss' ? 'wss://' : ''}${m[2]}${path}${m[4] || ''}`;
    }
    // ... and as a link a phone camera opens (2026-10-23: a bare address read as "not a web address"): the Kelly
    // page on this bridge -- its LAN https address from /api/connect when the bridge has one -- with the bridge token,
    // ?mesh=<device> (mesh.js connects the LoRa Mesh, never the radio) and, when the field is set, &mb=<that address>
    async function bridgeShareLink() {
      let tok = pageToken(), base = '';
      try { const u = new URL(String(settings.url || '').replace(/^ws/i, 'http')); tok = tok || u.searchParams.get('token'); if (!/^https?:/.test(location.protocol)) base = `${u.protocol}//${u.host}/`; } catch {}
      if (/^https?:/.test(location.protocol)) {
        base = `${location.origin}/`;
        try {
          const r = await fetch(`${location.origin}/api/connect${tok ? `?token=${encodeURIComponent(tok)}` : ''}`, { cache: 'no-store' });
          if (r.ok) { const j = await r.json(), urls = (j && j.urls) || [], u = urls.find(x => x.kind === 'lan' && x.https) || urls.find(x => x.kind === 'lan'); if (u && u.url) base = u.url; }
        } catch { /* an older bridge: this page's own address */ }
      }
      if (!base) return '';
      const u = new URL(base);
      u.pathname = '/'; u.search = ''; if (tok) u.searchParams.set('token', tok);
      u.searchParams.set('mesh', ms.dev); if (ms.bridgeUrl) u.searchParams.set('mb', ms.bridgeUrl);
      u.hash = 'mesh';
      return u.href;
    }
    window.KellyMeshBridgeQR = { share: bridgeShareText, link: bridgeShareLink };   // for tests/meshbridge-qr-cdp.js
    window.KellyMeshLink = { status: () => st.status };   // js/connectqr.js: is the LoRa Mesh link up (or coming up)?
    function meshBridgeUrl() {
      let u = String(ms.bridgeUrl || '').trim(); if (!u) return '';
      if (!/^wss?:\/\//i.test(u)) u = `ws://${u}`;
      const m = /^(wss?:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(u); if (!m) return '';
      return `${m[1]}${!m[2] || m[2] === '/' || m[2] === '/ws' ? '/mesh' : m[2]}${m[3] || ''}`;
    }

    let framer = null, hbTimer = 0;
    // Listening only (the Pi keeper, bridge/kelly_keeper.py): while a person's Kelly uses the same node through the
    // bridge, this one sends NOTHING -- no syncs, heartbeats, polls, adverts or rule replies (they'd go twice) -- but
    // still hears every frame the node sends (the bridge copies them to both), so the APRS iGate keeps gating. The
    // bridge says {"watch": true/false} and drops anything we write meanwhile; the session's commands fail at once
    // (io.standby). Back to false: start the session again, which also syncs what's waiting on the node.
    const WATCH_MSG = 'listening only -- another Kelly is using this LoRa node';
    function setWatch(on) {
      if (!!st.watch === on) return;
      st.watch = on;
      addEvent('network', on ? `LoRa Mesh: ${WATCH_MSG} (the APRS iGate keeps running)` : 'LoRa Mesh: the node is ours again -- reconnecting');
      dirty('mesh');
      const l = st.link;
      if (!on && l && l.transport === 'bridge') setTimeout(async () => { if (st.link !== l || st.watch) return; await disconnect(true); connect(true); }, 1500);
    }
    // MeshCore / LoRa APRS: the driver's Session does the protocol; this io is how it reaches the page
    async function connectDriver(d, link, quiet) {
      st.drv = d; st.status = 'connecting'; st.connAt = Date.now(); st.note = ''; st.channels = []; dirty('mesh');
      const log = line => { st.logs.push({ t: Date.now(), line }); if (st.logs.length > 300) st.logs.shift(); dirty('meshlog'); };
      let session = null;
      framer = new d.Framer(f => session && session.onFrame(f), log);
      const io = {
        mode: null,
        send: b => Promise.resolve().then(() => link.write(b)).then(() => { st.tx++; SS('feed', 'usb', 'to_node', b.length); }),   // every link's write() may be sync or async
        standby: () => !!st.watch,
        cfg: () => ({ call: ms.aprsCall || `${(settings.myCall || '').toUpperCase()}-7` }),
        node: (n, isNewAdvert, meta) => { const live = st.status === 'on' && !(meta && meta.read);   // meta.read: Kelly re-read it -- not heard
          const old = st.nodes.get(n.num), isNew = !old && live; const m = Object.assign(old || { firstHeard: Date.now() }, Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined)));
          if (m.lat != null && old && (old.lat !== m.lat || old.lon !== m.lon)) m.trail = (m.trail || []).concat([[m.lat, m.lon]]).slice(-30);
          if (live) m.lastHeard = Date.now();   // heard live; while loading, the device's own last-heard stands
          if (!old || old.lat !== m.lat || old.lon !== m.lon || old.key !== m.key) nodesVer++;
          st.nodes.set(n.num, m); if (live) { st.ripples.set(n.num, Date.now()); st.rx++; st.lastRx = Date.now(); }
          PA('node', m);
          if (isNew) popNode(m, false); else if (live) { sfx('rx'); flash('rx'); }
          if (live) F('heard', m);
          // APRS iGate: a position the node has just heard (its NEW_ADVERT, or a contact read straight after an advert
          // push) -- never the contact list read at connect, whose positions may be days old
          if (st.status === 'on' && n.key && n.lat != null && (isNewAdvert || Date.now() - (st.advertAt.get(n.key) || 0) < 15000))
            IG('advert', { key: n.key, lat: n.lat, lon: n.lon, ts: n.advertTs, name: n.longName || '', snr: n.snr, hops: n.hops });
          if (ms.dev === 'meshcore') HCU('feed', 'node', m, !!isNewAdvert, meta);
          saveNodes(); dirty('mesh'); },
        gone: num => { const gk = (st.nodes.get(num) || {}).key; if (ms.dev === 'meshcore' && gk) HCU('feed', 'gone', num, gk); if (num === st.myNum || !st.nodes.delete(num)) return; nodesVer++; saveNodes(); dirty('mesh'); },
        self: n => { st.myNum = n.num; st.radio = n.radio || ''; st.nodes.set(n.num, Object.assign(st.nodes.get(n.num) || {}, n)); SS('feed', 'self'); if (ms.dev === 'meshcore' && n.key) selfKnown(n.key); dirty('mesh'); },
        channels: list => { st.channels = list; ms.chNames = list.map(c => c && { index: c.index, name: c.name }); save(); dirty('mesh'); },   // names only, for a start while listening
        status: (s, note) => { st.status = s; if (note != null) st.note = note; if (s === 'on') online(); SS('feed', 'status', s, note); if (ms.dev === 'meshcore') HCU('feed', 'status', s); dirty('mesh'); },
        stat: (key, v) => {
          if (key === 'fw') st.fw = v; else if (key === 'battery' && me()) me().voltage = v;
          else if (key === 'hashMode') {   // the self-check: a toast + event when ours differs from the network's
            const was = st.hashMode; st.hashMode = v; const sc = HC && HC.self(v, ms.hashExpect || 2);
            if (sc && !sc.ok && was !== v) { toast('⚠️', 'Your node uses the wrong path hash size', `${sc.ours}-byte; this network expects ${sc.expected}-byte -- the LoRa Mesh page can fix it`, 'warn', () => k.showPage('mesh')); addEvent('network', `LoRa Mesh: this node sends ${sc.ours}-byte path hashes, the network expects ${sc.expected}-byte`); }
          }
          dirty('mesh');
        },
        log,
        route: e => { PA('route', e); TRU('route', e); if (e.kind === 'rx') { SS('feed', 'rx', e); onRxPacket(e); } if (e.kind === 'rx' || e.kind === 'control') DV('rx', e);
          // APRS iGate (js/igateui.js): a raw advert with a position (its signature is checked there), and "an advert
          // just came in" for a contact the node is about to send us again -- only then is its position fresh
          if (e.kind === 'advert' && e.key) { st.advertAt.set(e.key, Date.now()); if (st.advertAt.size > 300) st.advertAt.delete(st.advertAt.keys().next().value); }
          if (e.kind === 'rx' && e.pkt && e.pkt.advert) IG('raw', { raw: e.raw, payOff: e.pkt.payOff, advert: e.pkt.advert });   // with or without a position: any signed advert proves the key (igateui.js)
          if (e.kind === 'rx' && e.raw && ((e.raw[0] >> 2) & 15) === 6) IG('grpdata', { raw: e.raw, snr: e.snr, rssi: e.rssi }); },   // GRP_DATA: MeshPRS raw-log fallback
        chdata: x => IG('chdata', x),   // channel datagrams (companion RESP 27): MeshPRS frames for the APRS iGate (js/igateui.js)
        cli: m => { if (m && m.dm) TRU('cli', m); },   // a CLI-data DM (txt_type 1): Telemetry polling's grant messages (js/tr-telem.js)
        ack: (msg, state, err) => { if (!msg) return; msg.state = state; if (err) msg.err = err; else if (state === 'delivered') delete msg.err; if (state === 'failed') sfx('fail'); else if (state !== 'noack' && state !== 'retry') sfx('ack'); if (state === 'delivered') F('ack', msg); saveNodes(); dirty('mesh'); },
        text: m => {
          let from = m.num;
          if (!m.dm && m.sender != null) {   // MeshCore channel text: "Name: text" -- the contact of that name, else a name-only node
            const known = [...st.nodes.values()].find(n => n.longName === m.sender);
            from = known ? known.num : (d.nameNum ? d.nameNum(m.sender) : m.num);
            if (!known && m.sender) st.nodes.set(from, { num: from, longName: m.sender, shortName: d.shortOf ? d.shortOf(m.sender) : m.sender.slice(0, 4), idLabel: 'channel only', hwLabel: 'Heard on a channel', licensed: d.looksHam ? d.looksHam(m.sender) : false, firstHeard: Date.now() });
            if (from === st.myNum) return;
          }
          const n = st.nodes.get(from); if (n) { n.lastHeard = Date.now(); if (m.snr != null) n.snr = m.snr; if (m.hops != null) n.hops = m.hops; st.ripples.set(from, Date.now()); F('heard', n);
            if (!m.dm && m.ch != null) { n.chs = n.chs || []; if (!n.chs.includes(m.ch)) { n.chs.push(m.ch); n.chs.splice(0, n.chs.length - 8); } } }   // channels it posted on (Heard operators)
          PA('text', { dm: m.dm, hops: m.hops, from });
          if (m.dm && m.type === 2 && RM('post', m)) { st.rx++; st.lastRx = Date.now(); return; }   // a room server's post: the Rooms card
          if (m.dm) GD('text', { from, text: m.text, snr: m.snr, hops: m.hops });
          // P1 (awards): a DM from a known contact reached us decrypted -- they have us, we have them: a Handshake proof
          if (m.dm && ms.dev === 'meshcore' && n && n.key && from !== st.myNum) Fi('mutual', undefined, { key: String(n.key).toLowerCase(), num: from, name: n.longName || '', type: n.role != null ? n.role : n.type, how: 'message', at: Date.now() });
          st.rx++; st.lastRx = Date.now();
          receiveText({ id: m.key || `${from}:${m.ts || Date.now()}:${m.text}`, from, to: m.dm ? st.myNum : M.BROADCAST, ch: m.dm ? 0 : m.ch || 0, text: m.text, t: Date.now(), snr: m.snr, hops: m.hops, state: 'rx' },
            m.dm ? `dm${from}` : `ch${m.ch || 0}`);
        },
      };
      try {
        await link.open((bytes, unframed) => { SS('feed', 'usb', 'to_host', bytes.length); if (unframed) session && session.onFrame(bytes); else framer.push(bytes); });
        io.mode = link.transport === 'ble' ? link.mode : link.transport === 'usb' || link.transport === 'bridge' ? 'serial' : null;
        session = st.session = d.Session(io);
        st.link = link; st.status = 'config';
        addEvent('network', `${d.label}: connected over ${link.name}`);
        await session.start();
        st.lastLink = { kind: ms.link, dev: ms.dev, reuse: link.reuse };
        // a node that hangs after it came online: two missed heartbeats (local only, nothing goes on air) = stale
        let miss = 0;
        clearInterval(hbTimer); hbTimer = setInterval(async () => {
          const s = st.session; if (!s || st.watch) return;
          try { await s.heartbeat(); if (miss >= 2 && st.stale && st.stale.src === 'hb') { st.stale = null; toast('✅', 'The LoRa node is answering again', '', 'good'); dirty('mesh'); } miss = 0; }
          catch { if (st.session === s && ++miss === 2 && !st.stale) staleNode({ src: 'hb', since: Date.now() - 2 * HB_MS }); }
        }, HB_MS);
      } catch (e) {
        if (st.watch && st.link === link && link.alive && link.alive()) {
          // started while another Kelly has the node: no start-up talk, so take the channel names from last time and
          // just listen (setWatch(false) starts the session properly). Not online(): its hooks would all try to send.
          st.channels = (ms.chNames || []).filter(Boolean); st.status = 'on'; st.note = WATCH_MSG;
          st.lastLink = { kind: ms.link, dev: ms.dev, reuse: link.reuse };
          addEvent('network', `${d.label}: connected over ${link.name}, ${WATCH_MSG}`); dirty('mesh');
          return;
        }
        try { await link.close(); } catch {}
        st.link = null; st.session = null; st.status = 'off'; st.note = e.message; if (!quiet) { sfx('fail'); toast('📡', d.label, e.message, 'bad'); }
      }
      dirty('mesh');
    }
    // Catch-up from the bridge (2026-10-23): a phone's Kelly sleeps, and the always-on Kelly / the bridge's own
    // --mesh-gateway session take the node's messages first, so they never reach the phone. The bridge keeps what it
    // saw (/api/mesh-texts, {id, dm, ch, sender, prefix, to, text, at, out}); on connecting through it, merge in what
    // this Kelly hasn't got -- quietly: no sounds, pop-ups or P25 forwarding for old news, just unread counts.
    async function syncFromBridge() {
      const hu = st.link && st.link.transport === 'bridge' && ms.dev === 'meshcore' ? meshHistoryUrl() : ''; if (!hu) return;
      let j; try { const u = new URL(hu.replace('/api/mesh-history', '/api/mesh-texts')); if (ms.syncAt) u.searchParams.set('since', String(ms.syncAt - 600000)); const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) return; j = await r.json(); } catch { return; }
      const d = st.drv, byName = s => [...st.nodes.values()].find(n => n.longName === s), byKey = p => p ? [...st.nodes.values()].find(n => n.key && n.key.startsWith(p)) : null;
      let got = 0, last = ms.syncAt || 0;
      for (const t of (j && j.texts) || []) {
        if (!t || !t.text || !t.at) continue;
        last = Math.max(last, t.at);
        const peer = t.dm ? byKey(t.out ? t.to : t.prefix) || (t.out ? null : byName(t.sender)) : null;
        if (t.dm && !peer) continue;   // a DM from / to a station this Kelly doesn't know: nowhere to put it
        const from = t.out ? st.myNum : t.dm ? peer.num : (byName(t.sender) || {}).num ?? (d && d.nameNum ? d.nameNum(t.sender) : 0);
        if (!t.out && !t.dm && from === st.myNum) continue;
        const key = t.dm ? `dm${peer.num}` : `ch${t.ch || 0}`, list = st.chats[key] || (st.chats[key] = []), id = `b:${t.id || `${t.sender}:${t.at}:${t.text}`}`;
        if (list.some(x => x.id === id || (x.text === t.text && x.from === from && Math.abs(x.t - t.at) < 120000))) continue;
        list.push({ id, from, to: t.dm ? (t.out ? peer.num : st.myNum) : M.BROADCAST, ch: t.dm ? 0 : t.ch || 0, text: t.text, t: t.at, snr: t.snr, hops: t.hops, state: t.out ? 'sent' : 'rx', synced: true });
        list.sort((a, b) => a.t - b.t); if (list.length > 200) list.splice(0, list.length - 200);
        if (!t.out && !(k.currentPage() === 'mesh' && st.chat === key)) st.unread[key] = (st.unread[key] || 0) + 1;
        got++;
      }
      if (last !== ms.syncAt) { ms.syncAt = last; save(); }
      if (got) { toast('📥', `${got} message${got === 1 ? '' : 's'} from while you were away`, 'Synced from your Kelly bridge', 'good', () => k.showPage('mesh')); saveNodes(); dirty('mesh'); }
    }
    // and every minute while linked: another Kelly on the same bridge may sync a message before this one sees it
    let syncTimer = 0;
    function online() {
      clearInterval(syncTimer);
      if (st.link && st.link.transport === 'bridge') { setTimeout(syncFromBridge, 1500); syncTimer = setInterval(() => { if (st.link && st.link.transport === 'bridge') syncFromBridge(); else clearInterval(syncTimer); }, 60000); }
      const n = me();
      toast('🕸️', `${DEV_LABEL[ms.dev]} online: ${n ? n.longName : 'your node'}`, `${st.nodes.size} node${st.nodes.size === 1 ? '' : 's'} known · ${st.channels.filter(Boolean).length} channel(s)`, 'good', () => k.showPage('mesh'));
      sfx('connect'); flash('on');
      if (!st.chats.ch0) st.chats.ch0 = [];
      F('online'); PA('online'); RP('online'); RM('online'); CHN('online'); setTimeout(flushOutbox, 2000);
      markGood();
    }
    // auto: a reconnect after a lost link -- the same device as last time, no chooser, no error toasts
    async function connect(auto) {
      if (st.link) await disconnect(true);
      if (!auto) { clearTimeout(rcTimer); rcTimer = 0; rcTry = 0; st.wantLink = true; }
      const kind = ms.link, d = drv(), reuse = auto && st.lastLink && st.lastLink.kind === kind && st.lastLink.dev === ms.dev ? st.lastLink.reuse : null;
      if (d) {
        if (kind === 'demo' && !hasDemo(d.id)) { toast('🎮', 'There is no demo for this device', 'The demo mesh is Meshtastic or MeshCore -- or pick USB, Bluetooth or the Kelly bridge', 'bad'); return; }
        return connectDriver(d, kind === 'usb' ? serialLink(d, reuse) : kind === 'ble' ? bleDriverLink(d, reuse) : kind === 'demo' ? simLink() : bridgeLink(d), auto);
      }
      st.drv = null; st.session = null;
      const link = kind === 'usb' ? serialLink(null, reuse) : kind === 'ble' ? bleLink(reuse) : kind === 'bridge' ? bridgeLink() : demoLink();
      st.status = 'connecting'; st.connAt = Date.now(); st.note = ''; st.channels = []; dirty('mesh');
      framer = new M.Framer(onFromRadioBytes, line => { st.logs.push({ t: Date.now(), line }); if (st.logs.length > 300) st.logs.shift(); dirty('meshlog'); });
      try {
        await link.open((bytes, unframed) => { if (unframed || link.unframed) onFromRadioBytes(bytes); else framer.push(bytes); });
        st.link = link; st.status = 'config';
        st.configId = M.newId();
        await link.write(M.wantConfig(st.configId));
        if (link.drain) setTimeout(link.drain, 200);
        st.lastLink = { kind, dev: ms.dev, reuse: link.reuse };
        clearInterval(hbTimer); hbTimer = setInterval(() => { if (st.link && st.link.name !== 'Demo') st.link.write(M.heartbeat()).catch?.(() => {}); }, 5 * 60000);
        addEvent('network', `Meshtastic: connected over ${link.name}`);
      } catch (e) {
        st.status = 'off'; st.note = e.message; if (!auto) { sfx('fail'); toast('📡', 'Meshtastic', e.message, 'bad'); }
      }
      dirty('mesh');
    }
    // internal: connect()'s own tidy-up before a new link -- the user still wants a link
    async function disconnect(internal) {
      clearInterval(hbTimer);
      if (!internal) { st.wantLink = false; clearTimeout(rcTimer); rcTimer = 0; rcTry = 0; if (ms.resume) { ms.resume = false; save(); } }
      const l = st.link; st.link = null; st.session = null; st.status = 'off';
      if (l) { try { await l.close(); } catch {} addEvent('network', `${DEV_LABEL[ms.dev]}: disconnected`); }
      dirty('mesh');
    }
    function linkLost(why) {
      if (!st.link) return;
      clearInterval(hbTimer); st.link = null; st.session = null; st.status = 'off'; st.note = why;
      if (!rcTry) { sfx('fail'); toast('📡', 'Mesh link lost', `${why}${ms.autoReconnect && st.wantLink && st.lastLink && st.lastLink.kind !== 'demo' ? ' -- reconnecting' : ''}`, 'bad'); addEvent('network', `LoRa Mesh: link lost (${why})`); }
      dirty('mesh'); reconnectSoon(why);
    }
    // Auto-reconnect: 5 s, 15 s, 30 s, 1 min, then every 2 min for an hour. Bridge and Bluetooth reconnect as they
    // were; USB once the same device is plugged back in (Web Serial remembers it). Disconnect stops it.
    const RC_S = [5, 15, 30, 60, 120], RC_MAX = 34, HB_MS = 2 * 60000;
    let rcTimer = 0, rcTry = 0;
    function reconnectSoon(why) {
      if (rcTimer || !ms.autoReconnect || !st.wantLink || !st.lastLink || st.lastLink.kind === 'demo') return;
      if (rcTry >= RC_MAX) { st.wantLink = false; rcTry = 0; st.note = `${why} -- gave up reconnecting after an hour`; toast('📡', 'LoRa Mesh: gave up reconnecting', 'Press Connect when the node is back', 'bad'); dirty('mesh'); return; }
      const s = RC_S[Math.min(rcTry, RC_S.length - 1)];
      st.note = `${why} -- reconnecting in ${s} s${rcTry ? ` (try ${rcTry + 1})` : ''}`; dirty('mesh');
      rcTimer = setTimeout(async () => {
        rcTimer = 0; rcTry++;
        if (st.link || !st.wantLink) return;
        await connect(true);
        if (st.link) { addEvent('network', `LoRa Mesh: reconnected after ${rcTry} tr${rcTry === 1 ? 'y' : 'ies'}`); toast('🔌', 'LoRa Mesh reconnected', '', 'good'); rcTry = 0; }
        else reconnectSoon(why);
      }, s * 1000);
    }
    // Phone screen off (2026-10-23): Chrome freezes the page, the back-off timer with it, and the bridge socket
    // dies -- often still looking OPEN. Coming back after a while: a fresh bridge link straight away, not the back-off.
    // Android may also throw the tab away: ms.resume / ms.lastGood (markGood, below) pick the link back up after the
    // reload. A bridge reconnects as it was; USB too when the browser still has the port; Bluetooth needs a tap.
    let hiddenAt = 0;
    // The last link that came ONLINE (2026-10-23: "once connected, connect the same way next time, with a fall
    // back to entering the address"): ms.lastGood {link, dev, vid, pid} + ms.resume; Disconnect clears ms.resume.
    function markGood() {
      const r = st.lastLink && st.lastLink.reuse, g = { link: ms.link, dev: ms.dev, vid: r && r.usbVendorId != null ? r.usbVendorId : null, pid: r && r.usbProductId != null ? r.usbProductId : null };
      const o = ms.lastGood || {};
      if (!ms.resume || o.link !== g.link || o.dev !== g.dev || o.vid !== g.vid || o.pid !== g.pid) { ms.lastGood = g; ms.resume = true; save(); }
    }
    // page start: the same path again; if it doesn't come up, say so once and put the cursor where the address goes
    async function autoStart() {
      // (a bridge link saved by an older Kelly as ms.resume alone counts as a good bridge link)
      const g = ms.lastGood || (ms.link === 'bridge' ? { link: 'bridge', dev: ms.dev } : null); if (st.link || !g || !ms.resume || !ms.autoReconnect || g.link === 'demo') return;
      if (g.dev && g.dev !== ms.dev) switchDev(g.dev);
      if (g.link !== ms.link) { ms.link = g.link; save(); }
      if (g.link === 'ble') return toast('🔵', 'Reconnect your Bluetooth node', 'Bluetooth needs a tap: press Connect on the LoRa Mesh page', 'info', () => k.showPage('mesh'));
      let reuse = null;
      if (g.link === 'usb') {
        const ports = navigator.serial ? await navigator.serial.getPorts().catch(() => []) : [];
        if (!ports.some(p => { const i = p.getInfo(); return i.usbVendorId === g.vid && i.usbProductId === g.pid; })) return fallback('the USB node is not plugged in (or this browser forgot it)');
        reuse = { usbVendorId: g.vid, usbProductId: g.pid };
      }
      st.wantLink = true; st.lastLink = { kind: g.link, dev: ms.dev, reuse };
      st.note = 'connecting the way it did last time'; dirty('mesh');
      await connect(true);
      if (!st.link) { const why = st.note || 'no answer'; fallback(why); reconnectSoon(why); }
    }
    function fallback(why) {
      st.note = why; dirty('mesh');
      toast('📡', "Couldn't reconnect the LoRa mesh", `${why} -- check the ${ms.link === 'bridge' ? 'Mesh bridge address' : 'node'}, or press Connect`, 'warn', () => {
        k.showPage('mesh');
        setTimeout(() => { const i = ms.link === 'bridge' ? $('#mesh-burl') : $('#mesh-go'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } }, 300);
      });
    }
    function resumeNow(why) {
      if (!ms.autoReconnect || !st.wantLink) return;
      const l = st.link;
      if (l && l.transport === 'bridge' && (!l.alive || !l.alive() || (hiddenAt && Date.now() - hiddenAt > 60000))) {
        clearInterval(hbTimer); st.link = null; st.session = null; st.status = 'off'; try { l.close(); } catch {}
      }
      if (st.link) { if (st.link.transport === 'bridge') syncFromBridge(); return; }
      // a connect already under way: waking fires "screen back on" and "network back" together, and st.link is only
      // set once the link is open, so the second made a second bridge link (two /mesh clients, the owner's phone 2026-10-24)
      if (st.status === 'connecting' && Date.now() - (st.connAt || 0) < 15000) return;
      if (st.lastLink && st.lastLink.kind !== 'bridge' && st.lastLink.kind !== 'usb') return;
      clearTimeout(rcTimer); rcTimer = 0; rcTry = 0;
      st.note = `${why} -- reconnecting`; dirty('mesh');
      connect(true).then(() => { if (!st.link) reconnectSoon(why); });
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else { resumeNow('screen back on'); hiddenAt = 0; } });
    window.addEventListener('online', () => resumeNow('network back'));
    async function sendToRadio(bytes) {
      if (!st.link) { toast('📡', `Not connected to a ${DEV_LABEL[ms.dev]} node`, 'Connect on the LoRa Mesh page first', 'bad'); return false; }
      try { await st.link.write(bytes); st.tx++; return true; } catch (e) { toast('📡', 'Mesh send failed', e.message, 'bad'); return false; }
    }

    // ------------------------------------------------------------------ incoming
    function onFromRadioBytes(bytes) {
      let fr; try { fr = M.fromRadio(bytes); } catch (e) { st.logs.push({ t: Date.now(), line: `[decode error] ${e.message}` }); return; }
      if (fr.myInfo) { st.myNum = fr.myInfo.myNodeNum >>> 0; }
      if (fr.metadata) st.fw = fr.metadata.firmwareVersion || st.fw;
      if (fr.nodeInfo) upsertNodeInfo(fr.nodeInfo);
      if (fr.channel) { const c = fr.channel, i = c.index || 0; if (c.role) st.channels[i] = { index: i, name: (c.settings && c.settings.name) || (c.role === 1 ? 'Primary' : `Ch ${i}`), role: c.role }; }   // proto3 leaves index 0 out
      if (fr.logRecord) { st.logs.push({ t: Date.now(), line: fr.logRecord.message }); if (st.logs.length > 300) st.logs.shift(); }
      if (fr.configCompleteId != null && fr.configCompleteId === st.configId) {
        st.status = 'on';
        const n = me();
        toast('🕸️', `Mesh online: ${n ? n.longName : 'your node'}`, `${st.nodes.size} node${st.nodes.size === 1 ? '' : 's'} in its database · ${st.channels.filter(Boolean).length} channel(s)`, 'good', () => k.showPage('mesh'));
        sfx('connect'); flash('on');
        if (!st.chats.ch0) st.chats.ch0 = [];
        F('online'); PA('online'); RP('online'); RM('online'); CHN('online'); setTimeout(flushOutbox, 2000);
        markGood();
        if (ms.link === 'demo') setTimeout(() => PA('demoSeed'), 12000);   // the demo mesh: a few inbound routes for the path map
      }
      if (fr.rebooted) { st.note = 'node rebooted -- asking for its config again'; st.configId = M.newId(); sendToRadio(M.wantConfig(st.configId)); }
      if (fr.packet) onPacket(fr.packet);
      dirty('mesh');
    }
    function upsertNodeInfo(ni) {
      const num = ni.num >>> 0, n = st.nodes.get(num) || { num, firstHeard: Date.now() };
      if (ni.user) Object.assign(n, { longName: ni.user.longName, shortName: ni.user.shortName, hw: ni.user.hwModel, role: ni.user.role || 0, licensed: !!ni.user.isLicensed });
      if (ni.position && ni.position.latitudeI) Object.assign(n, { lat: ni.position.latitudeI / 1e7, lon: ni.position.longitudeI / 1e7, alt: ni.position.altitude });
      if (ni.deviceMetrics) Object.assign(n, { battery: ni.deviceMetrics.batteryLevel, voltage: ni.deviceMetrics.voltage, chUtil: ni.deviceMetrics.channelUtilization, airTx: ni.deviceMetrics.airUtilTx });
      if (ni.lastHeard) n.lastHeard = Math.max(n.lastHeard || 0, ni.lastHeard * 1000);
      if (ni.snr) n.snr = ni.snr;
      if (ni.hopsAway != null) n.hops = ni.hopsAway;
      n.viaMqtt = !!ni.viaMqtt; n.fav = !!ni.isFavorite;
      st.nodes.set(num, n); saveNodes();
    }
    function heard(pkt) {
      const num = pkt.from >>> 0;
      let n = st.nodes.get(num), isNew = false;
      if (!n) { n = { num, firstHeard: Date.now() }; st.nodes.set(num, n); isNew = st.status === 'on'; }
      n.lastHeard = Date.now();
      if (pkt.rxSnr) n.snr = pkt.rxSnr; if (pkt.rxRssi) n.rssi = pkt.rxRssi;
      if (pkt.hopStart != null && pkt.hopLimit != null && pkt.hopStart >= pkt.hopLimit) n.hops = pkt.hopStart - pkt.hopLimit;
      n.viaMqtt = !!pkt.viaMqtt;
      st.ripples.set(num, Date.now()); st.rx++; st.lastRx = Date.now();
      return { n, isNew };
    }
    function chatKey(pkt) { return (pkt.to >>> 0) === M.BROADCAST ? `ch${pkt.channel || 0}` : `dm${(pkt.from >>> 0) === st.myNum ? pkt.to >>> 0 : pkt.from >>> 0}`; }
    function onPacket(pkt) {
      if (!pkt.decoded) { if (pkt.from) heard(pkt); return; }   // encrypted for a channel this node hasn't got
      const fromMe = (pkt.from >>> 0) === st.myNum;
      const { n, isNew } = fromMe ? { n: me(), isNew: false } : heard(pkt);
      const d = pkt.decoded, p = M.decodePayload(d.portnum, d.payload);
      n && (n.lastPort = p.name);
      switch (d.portnum) {
        case M.PORT.TEXT: onText(pkt, d, p.text || '', fromMe); break;
        case M.PORT.POSITION:
          if (n && p.lat != null && (p.lat || p.lon)) { n.trail = (n.trail || []).concat([[p.lat, p.lon]]).slice(-30); Object.assign(n, { lat: p.lat, lon: p.lon, alt: p.altitude, speed: p.groundSpeed, posAt: Date.now() }); }
          break;
        case M.PORT.NODEINFO: if (n && p.user) { const wasHam = n.licensed; Object.assign(n, { longName: p.user.longName, shortName: p.user.shortName, hw: p.user.hwModel, role: p.user.role || 0, licensed: !!p.user.isLicensed }); if (n.licensed && !wasHam && !isNew && st.status === 'on') popNode(n, true); } break;
        case M.PORT.TELEMETRY: {
          const t = p.telemetry || {};
          if (n && t.deviceMetrics) Object.assign(n, { battery: t.deviceMetrics.batteryLevel, voltage: t.deviceMetrics.voltage, chUtil: t.deviceMetrics.channelUtilization, airTx: t.deviceMetrics.airUtilTx, uptime: t.deviceMetrics.uptimeSeconds });
          if (n && t.environmentMetrics) Object.assign(n, { temp: t.environmentMetrics.temperature, humidity: t.environmentMetrics.relativeHumidity, pressure: t.environmentMetrics.barometricPressure });
          break;
        }
        case M.PORT.ROUTING: onRouting(pkt, d, p.routing || {}); break;
        case M.PORT.TRACEROUTE: onTrace(pkt, d, p.route || {}); break;
        case M.PORT.WAYPOINT: if (p.waypoint && p.waypoint.lat != null) { st.waypoints.set(p.waypoint.id, { ...p.waypoint, from: pkt.from, at: Date.now() }); toast('📍', `Waypoint from ${nm(pkt.from)}`, p.waypoint.name || '', 'good', () => k.showPage('mesh')); } break;
        case M.PORT.NEIGHBORINFO: {
          const ni = p.neighbors || {};
          st.links = st.links.filter(l => l.a !== (ni.nodeId >>> 0));
          for (const x of ni.neighbors || []) st.links.push({ a: ni.nodeId >>> 0, b: x.nodeId >>> 0, snr: x.snr, at: Date.now() });
          break;
        }
        case M.PORT.RANGE_TEST: st.logs.push({ t: Date.now(), line: `Range test from ${nm(pkt.from)}: ${p.text} (SNR ${pkt.rxSnr ?? '?'})` }); break;
      }
      if (!fromMe && isNew && n) popNode(n, false);
      else if (!fromMe && d.portnum !== M.PORT.TEXT) { sfx('rx'); flash('rx'); }
      if (!fromMe && n && st.status === 'on') F('heard', n);
      saveNodes();
      dirty('mesh');
    }
    function onText(pkt, d, text, fromMe) {
      const key = chatKey(pkt), list = st.chats[key] || (st.chats[key] = []);
      if (d.emoji && d.replyId) {   // a tapback reaction
        const m = Object.values(st.chats).flat().find(x => x.id === d.replyId);
        if (m) { (m.react = m.react || {})[text] = ((m.react || {})[text] || 0) + 1; sfx('ack'); }
        return;
      }
      if (list.some(x => x.id === pkt.id && x.from === pkt.from)) return;
      const msg = { id: pkt.id, from: pkt.from >>> 0, to: pkt.to >>> 0, ch: pkt.channel || 0, text, t: Date.now(), snr: pkt.rxSnr, hops: pkt.hopStart != null ? pkt.hopStart - pkt.hopLimit : null, state: fromMe ? 'sent' : 'rx' };
      if (fromMe) { list.push(msg); if (list.length > 200) list.shift(); return; }
      receiveText(msg, key);
    }
    // a received text (any device type) into its chat: unread, sound, pop-up, event log, P25 bridge
    function receiveText(msg, key) {
      const list = st.chats[key] || (st.chats[key] = []);
      if (list.some(x => x.id === msg.id && x.from === msg.from)) return;
      list.push(msg); if (list.length > 200) list.shift();
      const text = msg.text, dm = key.startsWith('dm');
      if (!(k.currentPage() === 'mesh' && st.chat === key)) st.unread[key] = (st.unread[key] || 0) + 1;
      // a P25X alert on the mesh (P1-/P1+/P1! ...) gets its own tone by priority instead of the message chirp
      const alert = !msg.mine && window.MeshBridgeRules ? window.MeshBridgeRules.decode(text) : null;
      sfx(alert ? `alert-${alert.cls || 'routine'}` : dm ? 'dm' : 'text'); flash(alert && alert.cls === 'critical' ? 'node' : dm ? 'dm' : 'rx');
      popMsg(msg, dm);
      addEvent('data', `${DEV_LABEL[ms.dev]} ${dm ? 'DM' : `#${chName(msg.ch)}`} from ${nm(msg.from)}: ${text}`);
      bridgeToP25(msg, dm);
      F('text', msg, dm);
      if (msg.from !== st.myNum && isSos(text)) {
        const n = st.nodes.get(msg.from) || {}, p = myPos(), c = { key: `n${msg.from}:${msg.t}`, src: 'node', mesh: DEV_LABEL[ms.dev], from: msg.from, name: nm(msg.from), short: short(msg.from),
          ham: !!n.licensed, hops: msg.hops, lat: n.lat, lon: n.lon, ch: msg.ch, chName: dm ? 'DM' : chName(msg.ch), text, t: msg.t, sos: true };
        if (p && n.lat != null) { c.km = distKm(p, n); c.brg = bearing(p, n); }
        raiseSos(c); addCaller(c);
      } else if (!dm && msg.from !== st.myNum && isCalling(text, nm(msg.from))) {
        const n = st.nodes.get(msg.from) || {};
        addCaller({ key: `n${msg.from}:${msg.t}`, src: 'node', mesh: DEV_LABEL[ms.dev], from: msg.from, name: nm(msg.from), short: short(msg.from), ham: !!n.licensed,
          hops: msg.hops, lat: n.lat, lon: n.lon, ch: msg.ch, chName: chName(msg.ch), text, t: msg.t });
      }
      saveNodes(); dirty('mesh');
    }
    function onRouting(pkt, d, r) {
      const p = st.pending.get(d.requestId);
      if (!p) return;
      const err = r.errorReason || 0, from = pkt.from >>> 0;
      if (err) { p.msg.state = 'failed'; p.msg.err = M.ROUTING_ERROR[err] || `error ${err}`; sfx('fail'); }
      else if (p.msg.to !== M.BROADCAST && from === p.msg.to) { p.msg.state = 'delivered'; sfx('ack'); F('ack', p.msg); PA('ack', p.msg); }
      else if (p.msg.state !== 'delivered') { p.msg.state = 'heard'; sfx('ack'); }
      if (p.msg.state === 'delivered' || err) st.pending.delete(d.requestId);
      saveNodes(); dirty('mesh');
    }
    function onTrace(pkt, d, route) {
      const tr = st.traces.find(t => t.id === d.requestId);
      if (!tr) return;
      tr.done = Date.now();
      tr.towards = [st.myNum, ...(route.route || []).map(x => x >>> 0), tr.to];
      tr.back = [tr.to, ...(route.routeBack || []).map(x => x >>> 0), st.myNum];
      tr.snrT = (route.snrTowards || []).map(v => v / 4); tr.snrB = (route.snrBack || []).map(v => v / 4);
      sfx('trace');
      showTrace(tr);
      F('trace', tr); PA('trace', tr);
    }

    // ------------------------------------------------------------------ actions
    function activeTarget() {
      const key = st.chat;
      return key.startsWith('dm') ? { to: +key.slice(2) >>> 0, channel: 0 } : { to: M.BROADCAST, channel: +key.slice(2) || 0 };
    }
    // ---- outbox (store-and-forward, Phase 2): a message sent while the MeshCore / LoRa APRS node isn't connected is
    // kept in this browser (per device, at most OUTBOX_MAX, for up to a day) and sent, 3 s apart, once it's back.
    const OUTBOX_MAX = 50, OUTBOX_MS = 24 * 3600000;
    const outbox = () => store.get(sk('meshOutbox'), []) || [];
    const saveOutbox = l => store.set(sk('meshOutbox'), l);
    function queueOut(text, target, opts) {
      const dm = target.to !== M.BROADCAST, key = dm ? `dm${target.to}` : `ch${target.channel}`;
      const msg = { id: M.newId(), from: st.myNum, to: target.to, ch: target.channel, text, t: Date.now(), state: 'queued', bridge: opts.bridge };
      (st.chats[key] = st.chats[key] || []).push(msg);
      const l = outbox(); l.push({ id: msg.id, key, to: target.to, ch: target.channel, text, t: msg.t, tries: opts.tries || 0 });
      while (l.length > OUTBOX_MAX) { const d = l.shift(), m = (st.chats[d.key] || []).find(x => x.id === d.id); if (m) { m.state = 'failed'; m.err = 'outbox full'; } }
      saveOutbox(l); saveNodes(); dirty('mesh');
      if (!opts.bridge) toast('📮', `Queued: ${DEV_LABEL[ms.dev]} isn't connected`, 'It goes out when your node is back (kept for 24 h).', 'warn');
      return msg;
    }
    let flushing = false;
    async function flushOutbox() {
      if (flushing || !st.session || st.status !== 'on' || !outbox().length) return;
      flushing = true;
      try {
        let n = 0;
        while (st.session && st.status === 'on') {
          const l = outbox(); if (!l.length) break;
          const o = l.shift(); saveOutbox(l);
          const msg = (st.chats[o.key] || []).find(m => m.id === o.id);
          if (Date.now() - o.t > OUTBOX_MS) { if (msg) { msg.state = 'failed'; msg.err = 'not sent within 24 h'; } continue; }
          if (n++) await new Promise(r => setTimeout(r, 3000));   // shared airtime: one every 3 s
          const dm = o.to !== M.BROADCAST, node = dm ? st.nodes.get(o.to) : null;
          try { const s = await st.session.sendText(dm ? { dm: node || { num: o.to } } : { ch: o.ch }, o.text, msg || {}, { tries: o.tries || undefined }); if (msg && msg.state === 'queued') msg.state = s; }
          catch (e) { if (msg) { msg.state = 'failed'; msg.err = e.message; } }
          saveNodes(); dirty('mesh');
        }
        if (n) toast('📮', `Outbox sent: ${n} message${n === 1 ? '' : 's'}`, 'Queued while your node was away', 'good');
      } finally { flushing = false; }
    }
    async function sendText(text, target = activeTarget(), opts = {}) {
      text = String(text || '').trim(); if (!text) return null;
      const max = maxText(target);
      if (bytesOf(text) > max) { toast('✂️', 'Too long for the mesh', `${bytesOf(text)} / ${max} bytes`, 'bad'); return null; }
      if (st.session) return sendDriverText(text, target, opts);
      if (drv() && ms.link !== 'demo') return queueOut(text, target, opts);
      const { id, bytes } = M.textPacket({ to: target.to, channel: target.channel, text, wantAck: true });
      const msg = { id, from: st.myNum, to: target.to, ch: target.channel, text, t: Date.now(), state: 'sending', bridge: opts.bridge };
      const key = target.to === M.BROADCAST ? `ch${target.channel}` : `dm${target.to}`;
      (st.chats[key] = st.chats[key] || []).push(msg);
      st.pending.set(id, { msg, at: Date.now() });
      const ok = await sendToRadio(bytes);
      msg.state = ok ? (msg.state === 'sending' ? 'sent' : msg.state) : 'failed';
      if (ok) { sfx(opts.bridge ? 'bridge' : 'tx'); flash('tx'); if (!opts.bridge) { F('sent', msg, target.to !== M.BROADCAST); noteAnswer(target); } }
      saveNodes(); dirty('mesh');
      return ok ? msg : null;
    }
    async function sendDriverText(text, target, opts) {   // MeshCore / LoRa APRS
      const dm = target.to !== M.BROADCAST, node = dm ? st.nodes.get(target.to) : null;
      const msg = { id: M.newId(), from: st.myNum, to: target.to, ch: target.channel, text, t: Date.now(), state: 'sending', bridge: opts.bridge };
      const key = dm ? `dm${target.to}` : `ch${target.channel}`;
      (st.chats[key] = st.chats[key] || []).push(msg); dirty('mesh');
      try {
        const state = await st.session.sendText(dm ? { dm: node || { num: target.to } } : { ch: target.channel }, text, msg, { tries: opts.tries });
        if (msg.state === 'sending') msg.state = state;
        sfx(opts.bridge ? 'bridge' : 'tx'); flash('tx');
        SS('feed', 'tx', { type: dm ? 'TXT' : 'GRP_TXT', route: dm ? 'direct' : 'flood', len: bytesOf(text) + (dm ? 16 : 12), text });
        if (!opts.bridge) { F('sent', msg, dm); noteAnswer(target); }
        if (msg.state === 'delivered') F('ack', msg);
      } catch (e) {
        // node error 2 on a DM = the contact isn't in the node's table (never saved, or cleaned up as long unheard)
        const why = dm && ms.dev === 'meshcore' && e.message === 'not found'
          ? `${node && node.longName || nid(target.to)} isn't in your node's contacts -- import its contact link, or wait until its advert is heard` : e.message;
        msg.state = 'failed'; msg.err = why; sfx('fail'); toast('📡', 'Not sent', why, 'bad');
      }
      saveNodes(); dirty('mesh');
      return msg.state === 'failed' ? null : msg;
    }
    async function react(msgId, emoji) {
      if (!caps().react) return;
      const m = Object.values(st.chats).flat().find(x => x.id === msgId); if (!m) return;
      const to = m.to === M.BROADCAST ? M.BROADCAST : (m.from === st.myNum ? m.to : m.from);
      const { bytes } = M.textPacket({ to, channel: m.ch, text: emoji, wantAck: false, replyId: m.id, emoji: true });
      if (await sendToRadio(bytes)) { (m.react = m.react || {})[emoji] = (m.react[emoji] || 0) + 1; sfx('tx'); dirty('mesh'); }
    }
    async function traceroute(num) {
      if (!caps().trace) return;
      if (drv()) return driverTrace(num >>> 0);
      const { id, bytes } = M.traceroutePacket({ to: num >>> 0, channel: 0 });
      const tr = { id, to: num >>> 0, at: Date.now() }; st.traces.unshift(tr); st.traces.splice(10);
      if (await sendToRadio(bytes)) { sfx('trace'); toast('🛰️', `Tracing the route to ${nm(num)}…`, 'Each hop answers as the request passes', 'good'); showTrace(tr); }
      setTimeout(() => { if (!tr.done) { tr.failed = true; showTrace(tr); dirty('mesh'); } }, 60000);
    }
    // MeshCore: a trace path through the repeaters, out and back (js/meshcore.js trace). Hops are key hashes: each is
    // shown as the station it belongs to when Kelly knows one, else as a hash-only node.
    async function driverTrace(num) {
      const n = st.nodes.get(num); if (!n || !st.session || !st.session.trace) return;
      const q = route2(n.outPath || { sz: 2, h: [] });   // 2-byte hops only, never a guessed 1-byte one (js/tr-core.js route2)
      if (q.reason) { toast('🛰️', 'Not traced', `${q.reason} -- the Trace Route tab can discover a clean route`, 'bad'); return; }
      const why = n.key ? TRU('claim', n.key, 'trace') : null;   // one airtime budget with the Trace Route tab
      if (why) { toast('🛰️', 'Not now', why, 'bad'); return; }
      const tr = { id: M.newId(), to: num, at: Date.now() }; st.traces.unshift(tr); st.traces.splice(10);
      sfx('trace'); toast('🛰️', `Tracing the path to ${nm(num)}…`, 'Each repeater on the way adds the signal it heard', 'good'); showTrace(tr);
      try {
        const r = await st.session.trace(Object.assign({}, n, { outPath: q.route }));
        Object.assign(tr, traceRecord(num, r, tr.at), { id: tr.id });
        sfx('trace'); showTrace(tr); F('trace', tr); PA('trace', tr);
      } catch (e) { tr.failed = true; tr.err = e.message; showTrace(tr); }
      dirty('mesh');
    }
    // a route with every hop as 2 bytes of the ONE repeater / room server it can be, or { reason } (KellyTR.route2)
    const route2 = path => window.KellyTR && window.KellyTR.route2 ? window.KellyTR.route2(path, [...st.nodes.values()].filter(x => x.key && (x.role === 2 || x.role === 3)).map(x => x.key)) : { route: path };
    // a MeshCore trace answer -> the traceroute record Mesh Paths + Mesh Quest take (towards / back as node nums)
    function traceRecord(num, r, t0) {
      const hashNum = h => { const m = [...st.nodes.values()].find(x => x.key && x.key.startsWith(h) && (x.role === 2 || x.role === 3)) || [...st.nodes.values()].find(x => x.key && x.key.startsWith(h)); return m ? m.num : (parseInt(h.padEnd(8, '0'), 16) >>> 0); };
      return { id: M.newId(), to: num, at: t0, done: Date.now(), towards: [st.myNum, ...r.out.map(hashNum), num], back: [num, ...r.back.map(hashNum), st.myNum], snrT: r.snrTowards, snrB: r.snrBack };
    }
    async function askPosition(num) {
      if (!caps().askPos) return;
      const p = myPos(); if (!p) { toast('📍', 'Kelly needs your position first', 'GPS › Fixed position, or a GPS fix', 'bad'); return; }
      const { bytes } = M.positionPacket({ to: num >>> 0, lat: p.lat, lon: p.lon, wantResponse: true });
      if (await sendToRadio(bytes)) toast('📍', `Asked ${nm(num)} for its position`, 'It answers with its own when it can', 'good');
    }
    async function sharePosition(manual) {
      const p = k.myPos(); if (!p) { if (manual) toast('📍', 'No position to share', 'GPS › Fixed position, or a GPS fix on the radio', 'bad'); return; }
      if (st.session) {
        if (!st.link) { if (manual) toast('📡', `Not connected to a ${DEV_LABEL[ms.dev]} node`, '', 'bad'); return; }
        try { await st.session.sharePosition(p.lat, p.lon); st.lastShare = Date.now(); F('pos'); if (manual) { toast('📍', `Position sent on ${DEV_LABEL[ms.dev]}`, `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, 'good'); sfx('tx'); } }
        catch (e) { if (manual) toast('📍', 'Position not sent', e.message, 'bad'); }
        return;
      }
      const { bytes } = M.positionPacket({ lat: p.lat, lon: p.lon });
      if (await sendToRadio(bytes)) { st.lastShare = Date.now(); F('pos'); if (manual) { toast('📍', 'Position sent to the mesh', `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, 'good'); sfx('tx'); } }
    }

    // ------------------------------------------------------------------ P25 <-> mesh bridge
    // Mesh -> P25. "@VK4ZSR text" (or "@5050002 text") on the bridged channel / a DM goes to that station's P25
    // radio (Directory, RadioID, Last heard); anything else to the default radio. Emergencies always go, first.
    async function bridgeToP25(msg, dm) {
      if (st.watch || /^\[P25/.test(msg.text)) return;   // listening only: the Kelly driving the node forwards it
      const sos = isSos(msg.text);
      // mesh -> P25 needs bridge.mesh2p25 (js/entitlements.js); an SOS to the P25 radio never does
      if (!(sos && ms.sosToP25) && (ms.toP25 || ms.rules) && !KellyEnt.check('bridge.mesh2p25', 'bridgeToP25')) return;
      if (ms.rules && await rulesFromMesh(msg, dm)) return;
      if (!ms.toP25 && !(sos && ms.sosToP25)) return;
      const chOk = ms.toP25Ch === 'dm' ? dm : !dm && msg.ch === +ms.toP25Ch;
      const at = /^@([A-Za-z0-9/]{3,12})[:,]?\s+([\s\S]+)$/.exec(noBell(msg.text));
      let dest = parseInt(ms.toP25Dest, 10), body = noBell(msg.text);
      if (at && ms.toP25 && (chOk || dm) && !/^mesh$/i.test(at[1])) {
        const to = /^\d{5,8}$/.test(at[1]) ? { id: +at[1], name: at[1] } : await k.p25Lookup(at[1]);
        if (!to) {
          addEvent('data', `Mesh -> P25: no P25 radio found for ${at[1]} (from ${nm(msg.from)})`);
          if (dm) sendText(`[P25 ${(settings.myCall || '').toUpperCase() || 'KELLY'}] No P25 radio found for ${at[1].toUpperCase()}`, { to: msg.from, channel: 0 }, { bridge: true });
          return;
        }
        dest = to.id; body = at[2];
      } else if (!chOk && !sos) return;
      if (!(dest > 0)) return;
      if (!ascii(body)) { addEvent('data', `Mesh -> P25: nothing left to send from ${nm(msg.from)} once emoji were removed (P25 texts are plain ASCII)`); return; }
      if (sos) {   // the same emergency from the same node goes once per 10 min
        const key = `${msg.from}|${body.toLowerCase()}`, now = Date.now();
        for (const [x, t] of st.sosSeen) if (now - t > 10 * 60000) st.sosSeen.delete(x);
        if (st.sosSeen.has(key)) return;
        st.sosSeen.set(key, now);
      }
      st.routes.set(dest, { num: msg.from, dm, ch: msg.ch, at: Date.now() });
      const p = st.nodes.get(msg.from) || {};
      queueToP25({ dest, sos, text: sos ? sosText({ name: short(msg.from), text: body, lat: p.lat, lon: p.lon }) : `MESH ${short(msg.from)}: ${body}` });
    }
    function queueToP25(item) {
      item.text = ascii(item.text).slice(0, 160);
      if (item.sos) st.toP25Q.unshift(item); else st.toP25Q.push(item);
      if (st.toP25Q.length > 10) st.toP25Q.pop();
      if (item.sos && p25Timer) { clearTimeout(p25Timer); p25Timer = 0; }   // an emergency doesn't wait its turn
      pumpToP25();
    }
    let p25Timer = 0;
    async function pumpToP25() {
      if (p25Timer || !st.toP25Q.length) return;
      const wait = st.toP25Q[0].sos ? 0 : Math.max(0, st.toP25At + 15000 - Date.now());
      p25Timer = setTimeout(async () => {
        p25Timer = 0;
        const q = st.toP25Q.shift(); if (!q) return;
        if (!k.radioConnected()) { st.toP25Q.unshift(q); setTimeout(pumpToP25, 30000); return; }
        st.toP25At = Date.now();
        const ok = await k.sendP25Text(q.dest, q.text);
        sfx(q.sos ? 'sos' : 'bridge'); flash('bridge');
        addEvent('data', `Mesh -> P25 ${q.dest}: ${q.text}${ok ? '' : ' (FAILED)'}`);
        if (ok) F('bridge');
        bridgePulse('p25');
        pumpToP25();
      }, wait);
    }
    // app.js calls this for every text the radio receives.
    function onP25Text(m) {
      if ((ms.rules || ms.fromP25) && !KellyEnt.check('bridge.p252mesh', 'onP25Text')) return;
      if (ms.rules && rulesFromP25(m)) return;
      if (!ms.fromP25 || !st.link || st.status !== 'on' || m.dir !== 'in' || !m.text) return;
      let text = String(m.text);
      if (/^MESH /.test(text)) return;   // came from the mesh in the first place
      // "@mesh text" -> the channel; "@mesh @VK4ZGW text" -> a DM to that ham's node; "@re text" -> back to the mesh
      // station whose text this radio last got from the bridge (30 min)
      const tag = /^\s*(@mesh|mesh:)\s*/i, re = /^\s*@re\b[:,]?\s*/i, route = st.routes.get(+m.peer);
      const isRe = re.test(text) && route && Date.now() - route.at < 30 * 60000;
      if (ms.fromP25Mode === 'tag' && !tag.test(text) && !isRe) return;
      text = text.replace(tag, '');
      let target = { to: M.BROADCAST, channel: +ms.fromP25Ch || 0 };
      const at = /^@([A-Za-z0-9/]{2,12})[:,]?\s+([\s\S]+)$/.exec(text);
      if (isRe) { text = text.replace(re, ''); target = route.dm && caps().dm ? { to: route.num, channel: 0 } : { to: M.BROADCAST, channel: route.ch || 0 }; }
      else if (at) {
        const node = meshNodeByCall(at[1]);
        if (node && caps().dm && node.idLabel !== 'channel only') { target = { to: node.num, channel: 0 }; text = at[2]; }
        else text = `@${at[1]} ${at[2]}`;
      }
      const call = (settings.myCall || '').toUpperCase() || 'KELLY';
      const out = cut(`[P25 ${call}] ${k.unitName(m.peer)}: ${text}`, maxText(target));
      const where = target.to === M.BROADCAST ? `ch ${target.channel}` : `DM ${nm(target.to)}`;
      if (st.toMeshQ.length >= FROM_P25_MAX) { addEvent('data', `P25 -> Mesh ${where}: dropped, ${FROM_P25_MAX} already waiting (one every ${FROM_P25_GAP / 1000} s)`); return; }
      st.toMeshQ.push({ out, target, where, at: Date.now() }); pumpToMesh();
    }
    // P25 -> mesh pacing: the mesh is shared airtime (the gateway allows one per radio per 20 s too)
    const FROM_P25_GAP = 20000, FROM_P25_MAX = 5, FROM_P25_TTL = 10 * 60000;
    let meshQTimer = 0;
    function pumpToMesh() {
      if (meshQTimer || !st.toMeshQ.length) return;
      meshQTimer = setTimeout(() => {
        meshQTimer = 0;
        const q = st.toMeshQ.shift(); if (!q) return;
        if (Date.now() - q.at > FROM_P25_TTL) { addEvent('data', `P25 -> Mesh ${q.where}: dropped, waited over 10 min for the node`); pumpToMesh(); return; }
        if (!st.link || st.status !== 'on') { st.toMeshQ.unshift(q); setTimeout(pumpToMesh, 30000); return; }
        st.toMeshAt = Date.now();
        sendText(q.out, q.target, { bridge: true }).then(r => { if (r) { addEvent('data', `P25 -> Mesh ${q.where}: ${q.out}`); bridgePulse('mesh'); flash('bridge'); F('bridge'); } });
        pumpToMesh();
      }, Math.max(0, st.toMeshAt + FROM_P25_GAP - Date.now()));
    }
    setInterval(() => { if (ms.sharePos && st.status === 'on' && Date.now() - st.lastShare > 15 * 60000) sharePosition(false); }, 60000);

    // ------------------------------------------------------------------ alert rules, "direct" mode (simplex, no gateway)
    // js/mesh-bridge-rules.js = the gateway's engine (identical file, same rule JSON as Tools > Mesh alert bridge), run here
    // for a town with no P25X gateway: texts this radio receives go through the rules onto this Kelly's own node, mesh
    // "ACK <ref>" / a P25 "ACK <ref>" acknowledge, and "@CALL text" DMs from whitelisted MeshCore KEYS go to P25.
    // OFF unless ms.rules (Mesh > P25 bridge > Alert rules). Uses the engine's airtime budget, not FROM_P25_GAP.
    let rulesEng = null, rulesSig = '';
    const RULES_LOG_MAX = 100;
    function rules() {
      const MBR = window.MeshBridgeRules;
      if (!ms.rules || !MBR) { rulesEng = null; rulesSig = ''; return null; }
      const sig = JSON.stringify(ms.rulesCfg || {});
      if (rulesEng && sig === rulesSig) return rulesEng;
      rulesSig = sig;
      st.rulesLog = st.rulesLog || [];
      rulesEng = MBR.Engine({ ...(ms.rulesCfg || {}), enabled: true }, {
        now: () => Date.now(),
        audit: r => { st.rulesLog.unshift(r); if (st.rulesLog.length > RULES_LOG_MAX) st.rulesLog.length = RULES_LOG_MAX;
          if (r.kind === 'send' || r.kind === 'refuse' || r.kind === 'ack' || r.kind === 'drop') addEvent('data', `Alert rules: ${r.kind}${r.ref ? ` ${r.ref}` : ''} ${r.target || r.from || ''} ${r.result || r.why || r.by || ''}`.trim()); dirty('mesh'); },
        send: async (target, text) => {
          if (!st.link || st.status !== 'on') return { ok: false, error: 'the mesh node is not connected' };
          let t = null;
          if (target.net === 'meshcore' && ms.dev === 'meshcore') {
            if (target.to) { const n = [...st.nodes.values()].find(x => x.key && x.key.startsWith(String(target.to).toLowerCase().slice(0, 12))); if (!n) return { ok: false, error: 'no contact with that key on this node' }; t = { to: n.num, channel: 0 }; }
            else t = { to: M.BROADCAST, channel: target.ch | 0 };
          } else if (target.net === 'meshtastic' && ms.dev === 'meshtastic') {
            const c = st.channels.find(x => x && String(x.name || '').toLowerCase() === String(target.channel).toLowerCase());
            if (!c) return { ok: false, error: `this node has no channel "${target.channel}"` };
            t = { to: M.BROADCAST, channel: c.index };
          } else return { ok: false, error: `${target.net} target -- this Kelly is connected to ${DEV_LABEL[ms.dev]}` };
          const r = await sendText(cut(text, maxText(t)), t, { bridge: true });
          if (r) { bridgePulse('mesh'); flash('bridge'); }
          return r ? { ok: true } : { ok: false, error: 'the node refused it' };
        },
      });
      return rulesEng;
    }
    // a P25 text this radio received -> an alert ack, or an event for the rules
    function rulesFromP25(m) {
      const E = rules(); if (!E || m.dir !== 'in' || !m.text || /^MESH /.test(m.text)) return false;
      const ref = window.MeshBridgeRules.parseAck(m.text);
      if (ref && E.has(ref)) { E.ack(ref, k.unitName(m.peer), { via: 'p25', verified: true }); return true; }
      const r = E.submit({ source: 'text', unit: m.peer, from: k.unitName(m.peer), text: m.text });
      if (r.queued.length) E.pump();
      return r.queued.length > 0;
    }
    // a mesh text -> true when the rules claimed it (an ack, or a whitelisted "@CALL text" DM, sent on to P25)
    async function rulesFromMesh(msg, dm) {
      const E = rules(); if (!E) return false;
      const n = st.nodes.get(msg.from) || {};
      const res = E.onMesh({ dm, key: dm && n.key ? n.key.slice(0, 12) : null, name: nm(msg.from), text: msg.text, ch: msg.ch });
      if (!res) return false;
      if (res.forward) {
        const to = /^\d{5,8}$/.test(res.forward.to) ? { id: +res.forward.to } : await k.p25Lookup(res.forward.to);
        if (to) queueToP25({ dest: to.id, text: res.forward.text });
        else addEvent('data', `Alert rules: no P25 radio found for ${res.forward.to} (from ${res.forward.call})`);
      }
      return true;
    }
    setInterval(() => { const E = ms.rules && !st.watch ? rules() : null; if (E) { E.tick(); E.pump(); } }, 5000);

    // ------------------------------------------------------------------ the P25X gateway's view (no node needed)
    async function gatewayAsk() {
      const p = k.myPos(); if (!p) { toast('📍', 'Kelly needs your position first', 'GPS › Fixed position, or a GPS fix', 'bad'); return; }
      if (awDemo()) { toast('🎮', 'Not while a demo runs', 'Asking the gateway needs a real radio -- a demo sends nothing over P25', 'bad'); return; }
      const xid = await kfSafe({ op: 'meshnear', lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4), km: +ms.nearKm || 50 }, 'asking the gateway for Meshtastic nodes near you');
      st.gwAsk = xid ? { xid, at: Date.now() } : null; dirty('mesh');
    }
    function kfEvent(e) {
      if (fun && fun.ownsXid(e.t && e.t.xid)) { F('kfEvent', e); return; }
      if (gold && GD('ownsXid', e.t && e.t.xid)) { GD('kfEvent', e); return; }
      if (st.subAsk && e.t && e.t.xid === st.subAsk.xid) { if (e.kind === 'tx-failed') { st.subAsk = null; if (!e.cancelled) toast('📣', 'No answer from the P25X gateway', '', 'bad'); } else if (e.kind === 'tx-done') st.subAsk.delivered = Date.now(); dirty('mesh'); return; }
      if (!st.gwAsk) return;
      if (e.kind === 'tx-done') st.gwAsk.delivered = Date.now();
      else if (e.kind === 'tx-failed') { st.gwAsk = null; if (!e.cancelled) toast('🕸️', 'No answer from the P25X gateway', '', 'bad'); }
      dirty('mesh');
    }
    function gatewayReply(j) {
      if (j.app === 'meshboard') { F('boardReply', j); return; }
      if (j.app === 'gold') { GD('gatewayReply', j); return; }
      if (j.app === 'hdir') { HCU('gatewayReply', j); return; }   // the P25X ham directory (js/hc-dir.js)
      if (j.app === 'meshcall') { gatewayCallers(j.rows, j.at); addEvent('network', `Mesh callers from the gateway: ${(j.rows || []).length}`); return; }
      if (j.app === 'meshsub') {
        st.subAsk = null;
        if (j.error) { ms.hunt.sub = false; save(); toast('📣', 'Mesh callers', j.error, 'bad'); dirty('mesh'); return; }
        ms.hunt.sub = !!j.enabled; ms.hunt.subAt = Date.now(); save();
        toast('📣', j.enabled ? `Hunting: callers within ${j.km} km come to you over P25` : 'Stopped hunting gateway callers', j.enabled ? `${(j.recent || []).length} called in the last 2 hours · Kelly must stay parked to get them` : '', 'good');
        gatewayCallers(j.recent, j.at); dirty('mesh'); return;
      }
      st.gwAsk = null;
      if (j.error) { toast('🕸️', 'Mesh near me', j.error, 'bad'); dirty('mesh'); return; }
      const at = j.at || Date.now();
      st.gw = { at, got: Date.now(), lat: j.lat, lon: j.lon, km: j.km, total: j.total,
        rows: (j.rows || []).map(([id, s, l, la, lo, hw, age, ham, bat, role, hops]) => ({ num: parseInt(id, 16) >>> 0, shortName: s, longName: l, lat: la / 1e4, lon: lo / 1e4, hw, heard: at - age * 60000, licensed: !!ham, battery: bat < 0 ? null : bat, role, hops: hops < 0 ? null : hops })),
        texts: (j.texts || []).map(([age, id, ch, text]) => ({ t: at - age * 60000, from: parseInt(id, 16) >>> 0, ch, text })) };
      store.set('meshGateway', st.gw);
      for (const x of st.gw.texts) {   // callers in the snapshot join the hunt list
        const r = st.gw.rows.find(q => q.num === x.from) || {};
        if (isCalling(x.text, r.longName)) addCaller({ key: `g${x.from}:${x.t}`, src: 'gateway', mesh: 'Meshtastic', from: x.from, name: r.longName || r.shortName || M.nodeId(x.from), short: r.shortName,
          ham: !!r.licensed, hops: r.hops, lat: r.lat, lon: r.lon, ch: 0, chName: x.ch, text: x.text, t: x.t });
      }
      const hams = st.gw.rows.filter(r => r.licensed).length;
      toast('🕸️', `${st.gw.rows.length} mesh node${st.gw.rows.length === 1 ? '' : 's'} within ${j.km} km`, `${hams} in licensed (HAM) mode · ${st.gw.texts.length} recent text(s)`, 'good', () => k.showPage('mesh'));
      sfx('node'); flash('on'); st.gwDrawn = 0; F('gw');
      addEvent('network', `Mesh near me from the gateway: ${st.gw.rows.length} node(s), ${st.gw.texts.length} text(s)`);
      dirty('mesh');
    }

    // ------------------------------------------------------------------ FX: flashes, popups
    function flash(kind) {
      if (!ms.fx || !settings.fx || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const nav = document.querySelector('#nav button[data-page="mesh"]');
      if (nav) { nav.classList.remove('mesh-blink'); void nav.offsetWidth; nav.classList.add('mesh-blink'); }
      const page = $('#page-mesh');
      // no page-edge flash for coming online: it landed on top of the pill, glow, toast and layout settling as the page opened
      if (page && kind !== 'on' && k.currentPage() === 'mesh') { page.dataset.flash = kind; page.classList.remove('mesh-flash'); void page.offsetWidth; page.classList.add('mesh-flash'); }
    }
    function pop(html, cls, ms_ = 6500, onclick) {
      const host = $('#mesh-pops'); if (!host) return;
      const el = document.createElement('div'); el.className = `mesh-pop ${cls}`; el.innerHTML = html;
      el.onclick = e => { if (e.target.closest('input,button')) return; if (onclick) onclick(); el.classList.add('out'); setTimeout(() => el.remove(), 400); };
      host.appendChild(el); while (host.children.length > 3) host.firstChild.remove();
      setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms_);
      return el;
    }
    // ------------------------------------------------------------------ stale node: connected, but the node isn't answering
    // The bridge (kelly_bridge.py --mesh-gateway) says {"node": "stale"|"down"|"ok"} the moment you attach and whenever it
    // changes; for any other link Kelly notices itself: still loading 25 s after Connect. A pop-up + toast once, and a
    // banner in the top card while it lasts (static, no blinking). 2026-10-18: the NUC's node sat stuck 8 h overnight.
    function staleNode(s) {
      if (st.stale && st.stale.src === s.src && st.stale.down === s.down) return;
      st.stale = s;
      const what = s.down ? "the node's port is closed -- unplugged, or it reset" : "the node has stopped answering";
      pop(`<span class="mh-ic">⚠️</span><div><small>STALE CONNECTION</small><b>The LoRa node isn't answering</b><span>Connected to the ${s.src === 'bridge' ? 'bridge' : 'link'}, but ${what}. Power-cycle the node, then Connect again.</span></div>`, 'stale', 15000);
      toast('⚠️', "The LoRa node isn't answering", `${what} -- power-cycle it (unplug and replug its USB), then Connect again`, 'bad');
      sfx('fail'); addEvent('network', `LoRa Mesh: ${what}`); dirty('mesh');
    }
    function nodeState(j) {
      if (j.node === 'reset') {   // the bridge's watchdog (--mesh-auto-reset) rebooted a stuck node: our session is gone, so start again
        st.stale = null;
        toast('🔄', 'The bridge restarted the stuck LoRa node', `${j.why ? `It was ${j.why}. ` : ''}Reconnecting in a few seconds…`, 'good');
        addEvent('network', `LoRa Mesh: the bridge restarted the node${j.why ? ` (${j.why})` : ''}`); dirty('mesh');
        const l = st.link;
        if (l && l.transport === 'bridge') setTimeout(async () => { if (st.link !== l) return; await disconnect(); connect(); }, 12000);
        return;
      }
      if (j.node === 'stale' || j.node === 'down') staleNode({ src: 'bridge', down: j.node === 'down', since: j.since || Date.now() });
      else if (j.node === 'ok' && st.stale) {
        st.stale = null;
        toast('✅', 'The LoRa node is answering again', st.status === 'on' ? '' : "Disconnect and Connect again if the page doesn't fill in", 'good');
        dirty('mesh');
      }
    }
    setInterval(() => {
      if (st.stale && (!st.link || (st.stale.src === 'kelly' && st.status === 'on'))) { st.stale = null; dirty('mesh'); return; }
      if (st.link && !st.stale && (st.status === 'connecting' || st.status === 'config') && st.connAt && Date.now() - st.connAt > 25000)
        staleNode({ src: 'kelly', since: st.connAt });
    }, 5000);
    const avatar = (n, big) => `<span class="mesh-av${big ? ' big' : ''}${n && n.licensed ? ' ham' : ''}" style="--c:${n ? nodeColor(n) : '#7d8a99'}">${esc(n && n.shortName ? n.shortName : n ? defShort(n.num) : '?')}</span>`;
    // The page re-draws on nearly every packet (and every 0.9 s while a node ripples). Rebuilding a list with innerHTML
    // threw away every row, restarting its glow/slide-in mid-way -- a constant flicker. So: write HTML only when it
    // changed, patch lists row by row keyed on an attribute, and keep "12s ago" text out of the HTML (agoTag + fillAgo).
    const setHTML = (el, html) => { if (el._h !== html) { el.innerHTML = html; el._h = html; } };
    const agoTag = t => `<span data-ago="${t || 0}"></span>`;
    const fillAgo = box => box.querySelectorAll('[data-ago]').forEach(e => { const s = ago(+e.dataset.ago); if (e.textContent !== s) e.textContent = s; });
    function patchList(box, rows, attr, tag, empty) {
      if (!rows.length) { setHTML(box, empty); return; }
      box._h = null;
      const have = new Map();
      for (const el of [...box.children]) { const key = el.getAttribute(attr); if (key == null) el.remove(); else have.set(key, el); }
      let prev = null;
      for (const r of rows) {
        const key = String(r.key); let el = have.get(key); have.delete(key);
        if (!el) { el = document.createElement(tag); el.setAttribute(attr, key); }
        if (el.className !== r.cls) el.className = r.cls;
        setHTML(el, r.html);
        const want = prev ? prev.nextSibling : box.firstChild;
        if (el !== want) box.insertBefore(el, want);
        prev = el;
      }
      for (const el of have.values()) el.remove();
      fillAgo(box);
    }
    function popNode(n, hamOnly) {
      const p = myPos(), km = p && n.lat != null ? distKm(p, n) : null;
      pop(`<div class="mp-burst"></div>${avatar(n, true)}<div><small>${n.licensed ? '📻 LICENSED HAM ON THE MESH' : '✨ NEW NODE DISCOVERED'}</small><b>${esc(n.longName || nid(n.num))}</b>`
        + `<span>${esc(hwOf(n))}${roleOf(n) ? ` · ${esc(roleOf(n))}` : ''}${n.hops != null ? ` · ${n.hops === 0 ? 'direct' : n.hops + ' hop' + (n.hops > 1 ? 's' : '')}` : ''}${km != null ? ` · ${km.toFixed(1)} km` : ''}</span></div>`,
      `node${n.licensed ? ' ham' : ''}`, 7000, () => { k.showPage('mesh'); focusNode(n.num); });
      sfx(n.licensed ? 'ham' : 'node');
      if (!hamOnly && n.licensed) setTimeout(() => sfx('node'), 1100);
      flash('node');
    }
    function popMsg(msg, dm) {
      const n = st.nodes.get(msg.from);
      const el = pop(`${avatar(n)}<div class="mp-msg"><small>${dm ? '🔒 DIRECT MESSAGE' : `💬 ${esc(chName(msg.ch))}`}${msg.hops != null ? ` · ${msg.hops === 0 ? 'direct' : msg.hops + ' hops'}` : ''}${msg.snr != null ? ` · SNR ${msg.snr.toFixed(1)}` : ''}</small><b>${esc(nmc(msg.from))}</b><p>${esc(msg.text)}</p>`
        + (dm ? `<div class="mp-reply"><input placeholder="Quick reply…" maxlength="200"><button class="btn primary small">Send</button></div>` : '') + '</div>',
      `msg${dm ? ' dm' : ''}`, dm ? 12000 : 6500, () => { k.showPage('mesh'); openChat(chatKeyFor(msg, dm)); });
      if (el && dm) {
        const inp = el.querySelector('input'), go = () => { if (inp.value.trim()) { sendText(inp.value, { to: msg.from, channel: 0 }); el.classList.add('out'); setTimeout(() => el.remove(), 400); } };
        el.querySelector('button').onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); };
      }
    }
    const chatKeyFor = (msg, dm) => dm ? `dm${msg.from}` : `ch${msg.ch}`;
    const chName = i => (st.channels[i] && st.channels[i].name) || (i === 0 ? 'Primary' : `Channel ${i}`);
    function bridgePulse(dir) { const el = $('#mesh-bridge-viz'); if (!el) return; el.classList.remove('go-p25', 'go-mesh'); void el.offsetWidth; el.classList.add(dir === 'p25' ? 'go-p25' : 'go-mesh'); }
    function showTrace(tr) {
      const box = $('#mesh-trace'); if (!box) return;
      box.hidden = false;
      const hop = (num, i, snr) => `<span class="mt-hop" style="animation-delay:${i * 0.35}s">${avatar(st.nodes.get(num) || { num })}<small>${esc(short(num))}</small>${snr != null && i ? `<em>${snr.toFixed(1)} dB</em>` : ''}</span>`;
      const chain = (list, snr) => list.map((x, i) => (i ? `<i class="mt-wire" style="animation-delay:${i * 0.35 - 0.2}s"></i>` : '') + hop(x, i, snr[i - 1])).join('');
      box.innerHTML = `<div class="card-h"><h3>🛰️ Traceroute to ${esc(nm(tr.to))}</h3><button class="btn ghost small" id="mt-close">✕</button></div>`
        + (tr.done ? `<div class="mt-row"><label>Towards</label>${chain(tr.towards, tr.snrT)}</div><div class="mt-row"><label>Back</label>${chain(tr.back, tr.snrB)}</div>`
          + `<p class="small dim">${tr.towards.length - 2} hop${tr.towards.length === 3 ? '' : 's'} out, ${tr.back.length - 2} back · answered in ${((tr.done - tr.at) / 1000).toFixed(1)} s</p>`
          : tr.failed ? `<p class="small" style="color:var(--red)">${esc(tr.err || 'No answer in 60 s -- the node may be out of range or asleep.')}</p>`
            : `<div class="mt-sonar"><i></i><i></i><i></i></div><p class="small dim">Pinging through the mesh…</p>`);
      $('#mt-close').onclick = () => { box.hidden = true; };
      if (tr.done && st.map) drawTraceOnMap(tr);
    }

    // ------------------------------------------------------------------ map + scope
    let markers = new Map(), gwLayer = null, linkLayer = null, linkSig = '', traceLayer = null, p25Layer = null, p25Sig = '', aprsSig = '';
    // The map's overlays (Phase 6a, 2026-10-22): one persistent group each, cleared and refilled when their data changes
    // (never thrown away per redraw), switched from Leaflet's layer control (top right) -- which shares its on/off with
    // the older checkboxes (ms.p25Layer, ms.coverage). The rest: ms.layers {nodes, links, gw, aprs}.
    let G = null;
    const LAYERS = [['nodes', '📡 Mesh nodes'], ['p25', '📻 P25 radios'], ['links', '🔗 Neighbour links'], ['gw', '🌐 Gateway mesh (via P25)'],
      ['cov', '🗺️ Coverage (heard direct)'], ['aprs', '📍 APRS-IS nearby']];
    const layerOn = id => id === 'p25' ? ms.p25Layer !== false : id === 'cov' ? !!ms.coverage : ((ms.layers || {})[id] ?? id !== 'aprs');
    function setLayer(id, on) {
      if (layerOn(id) === on) return;
      if (id === 'p25') ms.p25Layer = on; else if (id === 'cov') ms.coverage = on; else ms.layers = { ...(ms.layers || {}), [id]: on };
      save(); dirty('mesh');
    }
    function syncLayers() {
      if (!G || !st.map) return;
      for (const [id] of LAYERS) { const on = layerOn(id), has = st.map.hasLayer(G[id]); if (on && !has) G[id].addTo(st.map); else if (!on && has) st.map.removeLayer(G[id]); }
    }
    function ensureMap() {
      if (st.map || !window.L || k.currentPage() !== 'mesh') return;
      st.map = k.makeMap($('#mesh-map'), true, null);
      if (!st.map) return;
      st.map.options.zoomSnap = 0.25; st.map.on('zoomend', () => markPiles());
      const p = myPos(); if (p) st.map.setView([p.lat, p.lon], 10);
      G = Object.fromEntries(LAYERS.map(([id]) => [id, L.layerGroup()]));
      syncLayers();
      const ctl = L.control.layers(null, Object.fromEntries(LAYERS.map(([id, label]) => [label, G[id]])), { collapsed: true, position: 'topright' }).addTo(st.map);
      // the APRS-IS layer only shows GPS › Nearby APRS's list, so say where to get it when that's empty
      const hint = document.createElement('div');
      hint.className = 'mesh-aprs-hint'; hint.hidden = true;
      hint.innerHTML = 'No APRS stations yet — <a href="#">ask on GPS › Nearby APRS</a>';
      hint.querySelector('a').onclick = e => { e.preventDefault(); k.showPage('gps'); };
      (ctl.getContainer().querySelector('.leaflet-control-layers-list') || ctl.getContainer()).appendChild(hint);
      st.aprsHint = hint;
      st.map.on('overlayadd overlayremove', e => { const id = LAYERS.map(x => x[0]).find(x => G[x] === e.layer); if (id) setLayer(id, e.type === 'overlayadd'); });
      addFullscreen();
      TL('attach', st.map);
    }
    // Full screen for the whole map card (info panel, legend, scope come along): the Fullscreen API (Esc leaves);
    // where it's refused, a fixed full-window layer (.mesh-fs, Esc leaves too)
    function addFullscreen() {
      const card = $('#mesh-map').closest('.mesh-mapcard');
      const isFull = () => document.fullscreenElement === card || card.classList.contains('mesh-fs');
      const btn = L.DomUtil.create('a', 'mesh-fs-btn');
      btn.href = '#'; btn.setAttribute('role', 'button');
      const resize = () => setTimeout(() => { if (st.map) { st.map.invalidateSize(); markPiles(); } }, 120);
      const label = () => { const f = isFull(); btn.textContent = f ? '✕' : '⛶'; btn.title = f ? 'Exit full screen (Esc)' : 'Full screen'; };
      const leave = () => { if (document.fullscreenElement === card) document.exitFullscreen().catch(() => {}); card.classList.remove('mesh-fs'); label(); resize(); };
      L.DomEvent.on(btn, 'click', e => {
        L.DomEvent.stop(e);
        if (isFull()) return leave();
        const fallback = () => { card.classList.add('mesh-fs'); label(); resize(); };
        if (card.requestFullscreen) card.requestFullscreen().catch(fallback); else fallback();
      });
      L.DomEvent.disableClickPropagation(btn);
      document.addEventListener('fullscreenchange', () => { label(); resize(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && card.classList.contains('mesh-fs')) leave(); });
      const Ctl = L.Control.extend({ onAdd: () => { const box = L.DomUtil.create('div', 'leaflet-bar'); box.appendChild(btn); return box; } });
      new Ctl({ position: 'topleft' }).addTo(st.map);
      label();
    }
    function markerHtml(n, ripple) {
      return `<div class="mm${n.num === st.myNum ? ' me' : ''}${n.licensed ? ' ham' : ''}${ripple ? ' ping' : ''}" style="--c:${nodeColor(n)}"><span>${esc(n.shortName || defShort(n.num))}</span>${n.licensed ? '<em>HAM</em>' : ''}</div>`;
    }
    function drawMap() {
      ensureMap(); const map = st.map; if (!map) return;
      syncLayers();
      const now = Date.now(), seen = new Set();
      for (const n of st.nodes.values()) {
        if (n.lat == null || n.lon == null) continue;
        seen.add(n.num);
        const rip = now - (st.ripples.get(n.num) || 0) < 1600, sig = `${n.shortName}|${n.licensed}|${n.hops}|${rip}|${n.num === st.myNum}|${n.viaMqtt}`;
        let m = markers.get(n.num);
        const icon = () => L.divIcon({ className: 'mm-wrap', iconSize: [44, 44], iconAnchor: [22, 22], html: markerHtml(n, rip) });
        if (!m) {
          m = L.marker([n.lat, n.lon], { icon: icon(), zIndexOffset: n.num === st.myNum ? 1000 : 0 }).addTo(G.nodes);
          m.on('click', () => pickAt(n.num)); m.on('mouseover', () => PA('hover', n.num)); m.on('mouseout', () => PA('hover', null));
          m.sig = sig; markers.set(n.num, m);
        } else {
          m.setLatLng([n.lat, n.lon]);
          if (m.sig !== sig) { m.setIcon(icon()); m.sig = sig; }
        }
        const pp = isHam(n) ? p25Of(n) : null;
        const tip = `<b>${esc(n.longName || nid(n.num))}</b>${n.licensed ? ' · HAM' : ''}<br>${esc(hwOf(n))}${n.battery != null ? ` · 🔋${n.battery > 100 ? '⚡' : n.battery + '%'}` : ''}<br>${n.lastHeard ? ago(n.lastHeard) : ''}${pp ? `<br>📻 P25 ${esc(pp.name)} · ${pp.id}` : ''}`;
        if (m.getTooltip()) m.setTooltipContent(tip); else m.bindTooltip(tip);
      }
      for (const [num, m] of markers) if (!seen.has(num)) { m.remove(); markers.delete(num); }
      // P25 radios with a GPS fix (Kelly's own GPS data): the other half of the picture
      const units = ms.p25Layer && k.p25Units ? k.p25Units() : [], psig = units.map(u => `${u.id}${u.lat}${u.lon}${u.emergency}`).join('|');
      if (psig !== p25Sig) {
        p25Sig = psig; G.p25.clearLayers(); p25Layer = G.p25;
        for (const u of units) L.marker([u.lat, u.lon], { zIndexOffset: -100, icon: L.divIcon({ className: 'mm-wrap', iconSize: [40, 40], iconAnchor: [20, 20],
          html: `<div class="mm p25${u.emergency ? ' sos' : ''}"><span>📻</span><em>${esc(String(u.name).slice(0, 8))}</em></div>` }) })
          .bindTooltip(`<b>${esc(u.name)}</b> · P25 radio ${u.id}<br>${u.emergency ? '🚨 EMERGENCY · ' : ''}${k.fmtAgo(u.t)}`).addTo(p25Layer);
      }
      // neighbour links
      // rebuilt only when a link or an end moves: it used to be thrown away and redrawn on every page redraw (constant
      // SVG repaints on a busy mesh -- a suspect for the LoRa Mesh flicker, 2026-10-22)
      const lsig = st.links.map(l => { const a = st.nodes.get(l.a), b = st.nodes.get(l.b); return a && b ? `${l.a}:${a.lat},${a.lon}-${l.b}:${b.lat},${b.lon}` : ''; }).join('|');
      if (lsig !== linkSig || !linkLayer) {
        linkSig = lsig; G.links.clearLayers(); linkLayer = G.links;
        for (const l of st.links) { const a = st.nodes.get(l.a), b = st.nodes.get(l.b); if (a && b && a.lat != null && b.lat != null) L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#00e5ff', weight: 1, opacity: 0.35, dashArray: '2 6', interactive: false }).addTo(linkLayer); } }
      // the gateway's nodes (asked over P25), grey, when they aren't already ours
      if (st.gw && st.gwDrawn !== st.gw.got) {
        G.gw.clearLayers(); gwLayer = G.gw; st.gwDrawn = st.gw.got;
        L.circle([st.gw.lat, st.gw.lon], { radius: st.gw.km * 1000, color: '#a78bfa', weight: 1, opacity: 0.4, dashArray: '5 7', fill: false, interactive: false }).addTo(gwLayer);
        for (const r of st.gw.rows) {
          if (st.nodes.get(r.num) && st.nodes.get(r.num).lat != null) continue;
          L.marker([r.lat, r.lon], { icon: L.divIcon({ className: 'mm-wrap', iconSize: [44, 44], iconAnchor: [22, 22], html: `<div class="mm gw${r.licensed ? ' ham' : ''}"><span>${esc(r.shortName || M.defaultShort(r.num))}</span>${r.licensed ? '<em>HAM</em>' : ''}</div>` }) })
            .bindTooltip(`<b>${esc(r.longName || M.nodeId(r.num))}</b> · via the P25X gateway<br>${esc(M.hwName(r.hw))} · ${k.fmtAgo(r.heard)}`).addTo(gwLayer);
        }
        map.fitBounds(L.latLng(st.gw.lat, st.gw.lon).toBounds(st.gw.km * 2000), { padding: [10, 10] });
      }
      // APRS-IS stations near you (Kelly's Nearby APRS, fetched over P25 from the gateway -- the GPS page's list)
      const aprs = layerOn('aprs') && k.aprsNear ? k.aprsNear() : [], asig = aprs.map(r => `${r.name}${r.lat}${r.lon}${r.heard}`).join('|');
      if (st.aprsHint) st.aprsHint.hidden = !layerOn('aprs') || aprs.length > 0;
      if (asig !== aprsSig) {
        aprsSig = asig; G.aprs.clearLayers();
        for (const r of aprs) L.marker([r.lat, r.lon], { zIndexOffset: -200, icon: L.divIcon({ className: 'mm-wrap', iconSize: [40, 40], iconAnchor: [20, 20],
          html: `<div class="mm aprs${r.p25 ? ' p25' : ''}"><span>${esc(r.icon || '📍')}</span><em>${esc(String(r.name).slice(0, 9))}</em></div>` }) })
          .bindTooltip(`<b>${esc(r.name)}</b> · APRS-IS${r.p25 ? ' · on P25' : ''}<br>${k.fmtAgo(r.heard)}${r.kmh != null ? ` · ${Math.round(r.kmh)} km/h` : ''}${r.comment ? `<br>${esc(String(r.comment).slice(0, 60))}` : ''}`).addTo(G.aprs);
      }
      if (!st.fitted && markers.size > 1) { st.fitted = true; map.fitBounds(L.featureGroup([...markers.values()]).getBounds(), { padding: [30, 30], maxZoom: 12 }); }
      markPiles();
    }
    // Mesh Quest: a record's DX path, me -> them, a glowing animated line with the distance on it
    let dxLayer = null;
    function showDx(r) {
      ensureMap(); if (!st.map || r.lat == null) return;
      const mp = myPos(), a = r.myLat != null ? [r.myLat, r.myLon] : mp ? [mp.lat, mp.lon] : null; if (!a) return;
      if (dxLayer) dxLayer.remove(); dxLayer = L.layerGroup().addTo(st.map);
      const b = [r.lat, r.lon], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      L.polyline([a, b], { color: '#ffd166', weight: 4, opacity: 0.95, className: 'mesh-dx-line', interactive: false }).addTo(dxLayer);
      L.circleMarker(b, { radius: 10, color: '#ffd166', weight: 3, fill: false, className: 'mesh-dx-end', interactive: false }).addTo(dxLayer);
      L.marker(mid, { interactive: false, icon: L.divIcon({ className: 'mm-wrap', iconSize: [170, 28], iconAnchor: [85, 14], html: `<div class="mesh-dx-label">🏆 ${Number(r.v).toFixed(1)} km · ${esc(r.who || '')}</div>` }) }).addTo(dxLayer);
      st.map.fitBounds(L.latLngBounds([a, b]), { padding: [50, 50], maxZoom: 13 });
      $('#mesh-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      sfx('trace'); setTimeout(() => { if (dxLayer) { dxLayer.remove(); dxLayer = null; } }, 30000);
    }
    function drawTraceOnMap(tr) {
      if (traceLayer) traceLayer.remove(); traceLayer = L.layerGroup().addTo(st.map);
      const pts = tr.towards.map(x => st.nodes.get(x)).filter(n => n && n.lat != null).map(n => [n.lat, n.lon]);
      if (pts.length > 1) { L.polyline(pts, { color: '#ffb020', weight: 3, opacity: 0.9, className: 'mesh-trace-line' }).addTo(traceLayer); setTimeout(() => traceLayer && traceLayer.remove(), 20000); }
    }
    // A click on a marker with others drawn on top of it (a companion and a repeater at the same house): list them all
    // and let the user pick, instead of whichever happened to be on top (bench, 2026-10-23: DMs went to a repeater).
    const PICK_PX = 30, PICK_MAX = 8;   // markers are 44 px: within 30 px they cover most of each other
    function pickAt(num) {
      const m0 = markers.get(num >>> 0), map = st.map; if (!m0 || !map) return focusNode(num);
      const p0 = map.latLngToContainerPoint(m0.getLatLng());
      const here = [...markers].filter(([, m]) => map.latLngToContainerPoint(m.getLatLng()).distanceTo(p0) <= PICK_PX)
        .map(([nm]) => st.nodes.get(nm)).filter(Boolean).sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));
      if (here.length < 2) return focusNode(num);
      if (here.length > PICK_MAX && map.getZoom() < map.getMaxZoom() - 1) return map.setView(m0.getLatLng(), Math.min(map.getZoom() + 2, map.getMaxZoom()));   // a city pile-up: zoom in first
      const box = document.createElement('div'); box.className = 'mesh-pick';
      box.innerHTML = `<b>${here.length} nodes here</b>` + here.map(n => `<button class="btn ghost small" data-num="${n.num >>> 0}">`
        + `<span>${esc(n.longName || nid(n.num))}</span><small>${esc(hwOf(n))} · ${esc(nid(n.num))}${n.lastHeard ? ` · ${ago(n.lastHeard)}` : ''}</small></button>`).join('');
      const pop = L.popup({ closeButton: true, autoPan: true, className: 'mesh-pick-pop', maxWidth: 280 }).setLatLng(m0.getLatLng()).setContent(box).openOn(map);
      box.onclick = e => { const b = e.target.closest('button[data-num]'); if (!b) return; map.closePopup(pop); focusNode(+b.dataset.num); };
    }
    // ... and show where those piles are: the front marker of each gets a count badge (data-pile), redone on zoom
    function markPiles() {
      const map = st.map; if (!map) return;
      const pts = [...markers].map(([, m]) => [m, map.latLngToContainerPoint(m.getLatLng())]), seen = new Set();
      for (const [m] of pts) { const el = m.getElement(); if (el) delete el.dataset.pile; }
      for (const [m, p] of pts) {
        if (seen.has(m)) continue;
        const pile = pts.filter(([o, q]) => !seen.has(o) && q.distanceTo(p) <= PICK_PX);
        pile.forEach(([o]) => seen.add(o));
        if (pile.length < 2) continue;
        const front = pile.reduce((a, b) => (b[1].y > a[1].y ? b : a))[0].getElement();   // Leaflet stacks southern markers on top
        if (front) front.dataset.pile = pile.length > 99 ? '99+' : pile.length;
      }
    }
    function focusNode(num) {
      st.sel = num >>> 0; const n = st.nodes.get(st.sel);
      if (n && n.lat != null && st.map) st.map.setView([n.lat, n.lon], Math.max(st.map.getZoom(), 12));
      dirty('mesh');
    }
    // Mesh Scope: a radar sweep, nodes by bearing / distance from this station; a blip glows when heard.
    // The sweep runs SCOPE_SWEEP_MS after the page opens or a packet is heard, then stops (a still scope, redrawn every
    // 2 s): a sweep that never stopped flickered the whole window in Chrome on the owner's PC (2026-10-21) and broke the
    // no-endless-animation rule.
    let scopeRaf = 0, scopeOpened = 0;
    const SCOPE_SWEEP_MS = 8000;
    function scope() {
      const cv = $('#mesh-scope');
      // no size = the Station SCADA tab is showing (the Mesh tab's pane is hidden): stop until it's back
      if (!cv || !ms.scope || k.currentPage() !== 'mesh' || document.hidden || !cv.clientWidth) { scopeRaf = 0; return; }
      const W = cv.clientWidth, H = cv.clientHeight, dpr = window.devicePixelRatio || 1;
      if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const still = !(ms.fx && settings.fx) || matchMedia('(prefers-reduced-motion: reduce)').matches
        || Date.now() - Math.max(scopeOpened, st.lastRx || 0) > SCOPE_SWEEP_MS;
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 8, now = performance.now(), sweep = still ? 0 : (now / 2600) % 1 * Math.PI * 2;
      g.fillStyle = '#04110c'; g.fillRect(0, 0, W, H);
      const p = myPos(), pts = [];
      if (p) for (const n of st.nodes.values()) if (n.lat != null && n.num !== st.myNum) pts.push({ n, d: distKm(p, n), b: bearing(p, n) });
      const maxD = Math.max(5, ...pts.map(x => x.d).filter(d => d < 300));
      const scale = [5, 10, 20, 50, 100, 200, 300].find(s => s >= maxD) || 300;
      g.strokeStyle = 'rgba(57,255,136,.22)'; g.lineWidth = 1;
      for (let i = 1; i <= 4; i++) { g.beginPath(); g.arc(cx, cy, R * i / 4, 0, Math.PI * 2); g.stroke(); }
      g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
      g.fillStyle = 'rgba(57,255,136,.55)'; g.font = '10px monospace'; g.fillText(`${scale} km`, cx + 4, cy - R + 12); g.fillText('N', cx - 3, cy - R + 10);
      const grad = !still && g.createConicGradient ? g.createConicGradient(sweep - Math.PI / 2 - 0.9, cx, cy) : null;
      if (grad) { grad.addColorStop(0, 'rgba(57,255,136,0)'); grad.addColorStop(0.14, 'rgba(57,255,136,.28)'); grad.addColorStop(0.145, 'rgba(57,255,136,0)'); g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill(); }
      if (!still) { g.strokeStyle = 'rgba(57,255,136,.8)'; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(sweep) * R, cy - Math.cos(sweep) * R); g.stroke(); }
      for (const { n, d, b } of pts) {
        if (d > scale) continue;
        const x = cx + Math.sin(b) * R * d / scale, y = cy - Math.cos(b) * R * d / scale;
        const since = Date.now() - (st.ripples.get(n.num) || 0), lit = still ? 0 : Math.max(0, 1 - since / 2500);
        let ang = (b - sweep) % (Math.PI * 2); if (ang < 0) ang += Math.PI * 2; const swept = still ? 1 : Math.max(0, 1 - (Math.PI * 2 - ang) / 1.2);
        const c = nodeColor(n), a = 0.35 + Math.max(lit, swept * 0.65);
        g.globalAlpha = a; g.fillStyle = c; g.beginPath(); g.arc(x, y, 3 + lit * 4, 0, Math.PI * 2); g.fill();
        if (lit > 0) { g.globalAlpha = lit * 0.6; g.strokeStyle = c; g.beginPath(); g.arc(x, y, 6 + (1 - lit) * 18, 0, Math.PI * 2); g.stroke(); }
        g.globalAlpha = Math.min(1, a + 0.2); g.fillStyle = '#d6ffe6'; g.fillText(n.shortName || defShort(n.num), x + 6, y + 3);
        g.globalAlpha = 1;
      }
      g.fillStyle = '#ffb020'; g.beginPath(); g.arc(cx, cy, 4, 0, Math.PI * 2); g.fill();
      if (!p) { g.fillStyle = 'rgba(214,255,230,.7)'; g.fillText('Set your position to plot the mesh', 12, H - 12); }
      // 20 fps is plenty for a 2.6 s sweep; still (reduced motion / effects off) = a redraw every 2 s. Never a bare
      // self-requeueing requestAnimationFrame (kelly-page/CLAUDE.md: idle CPU)
      scopeRaf = setTimeout(() => requestAnimationFrame(scope), still ? 2000 : 50);
    }

    // ------------------------------------------------------------------ render
    // A MeshCore node's clock restarts at 15 May 2024 after a power-off, so a time before 16 May 2024 was stamped before
    // anyone set it -- "890d ago" on the map for a station heard last night. Say so instead.
    const CLOCK_OK = Date.UTC(2024, 4, 16);
    const ago = t => !t ? '—' : t < CLOCK_OK ? 'time unknown' : k.fmtAgo(t);
    const tick = s => ({ sending: '<i class="mt-st s">⏳</i>', sent: '<i class="mt-st">✓</i>', heard: '<i class="mt-st h" title="Heard by the mesh">✓</i>', delivered: '<i class="mt-st d" title="Delivered">✓✓</i>', failed: '<i class="mt-st f" title="Not delivered">✗</i>', noack: '<i class="mt-st" title="Sent -- no ACK yet">✓?</i>', retry: '<i class="mt-st s" title="No ACK yet -- trying again">↻</i>', queued: '<i class="mt-st s" title="Queued -- goes when your node is back">📮</i>' }[s] || '');
    const snrBars = snr => snr == null ? '' : `<span class="mesh-snr" title="SNR ${snr.toFixed(1)} dB">${[-15, -10, -5, 0, 5].map(t => `<i class="${snr >= t ? 'on' : ''}"></i>`).join('')}</span>`;
    function openChat(key) { st.chat = key; delete st.unread[key]; dirty('mesh'); setTimeout(() => { const c = $('#mesh-chat'); if (c) c.scrollTop = c.scrollHeight; }, 30); }
    function render() {
      const page = $('#page-mesh'); if (!page) return;
      const on = st.status === 'on', n0 = me();
      // nav badge
      const unread = Object.values(st.unread).reduce((a, b) => a + b, 0), nb = $('#nb-mesh');
      if (nb) { nb.textContent = unread > 99 ? '99+' : unread; nb.classList.toggle('show', unread > 0); }
      if (k.currentPage() !== 'mesh') return;
      hashUI();
      $('#mesh-dev').value = ms.dev; $('#mesh-link').value = ms.link;
      $('#mesh-dev').disabled = !!st.link;
      $$('#mesh-link option[value="demo"]').forEach(o => { o.disabled = !hasDemo(ms.dev); });
      $('#mesh-devname').textContent = DEV_LABEL[ms.dev];
      $('#mesh-aprs').hidden = ms.dev !== 'aprs';
      if (document.activeElement !== $('#mesh-call')) $('#mesh-call').value = ms.aprsCall || '';
      $('#mesh-bwrap').hidden = ms.link !== 'bridge';
      if (document.activeElement !== $('#mesh-burl')) $('#mesh-burl').value = ms.bridgeUrl || '';
      $('#mesh-call').placeholder = `${(settings.myCall || 'VK4XXX').toUpperCase()}-7`;
      const cp = caps();
      $('#page-mesh').classList.toggle('mesh-noreact', !cp.react);
      $('#mesh-go').textContent = st.link ? '⏏ Disconnect' : rcTimer ? '⏹ Stop reconnecting' : '🔌 Connect';
      $('#mesh-state').className = `mesh-state ${st.status}`;
      $('#mesh-state').textContent = { off: 'OFFLINE', connecting: 'CONNECTING…', config: 'LOADING NODE DB…', on: 'MESH ONLINE' }[st.status];
      setHTML($('#mesh-me'), n0 ? `${avatar(n0, true)}<div><b>${esc(n0.longName || '')}</b><small>${esc(nid(n0.num))} · ${esc(hwOf(n0))}${st.fw ? ` · fw ${esc(st.fw)}` : ''}${n0.licensed ? ' · <span class="mesh-ham">HAM</span>' : ''}${fun && myPos() ? ` · 🔲 ${fun.grid(myPos().lat, myPos().lon, 6)}` : ''}${n0.voltage != null && st.drv ? ` · 🔋 ${n0.voltage.toFixed(2)} V` : ''}</small>${st.radio ? `<small>${esc(st.radio)}</small>` : ''}</div>`
        : `<small class="dim">${esc(st.note || (ms.link === 'demo' ? `Demo: a simulated SEQ ${DEV_LABEL[ms.dev]} mesh -- no hardware needed.` : drv() ? drv().hint : 'Plug in or pair a Meshtastic node, then Connect.'))}</small>`);
      const avail = { usb: !!navigator.serial, ble: !!navigator.bluetooth, bridge: true, demo: true }[ms.link];
      $('#mesh-hint').textContent = avail ? (st.note && n0 ? st.note : '') : IOS ? "iPhone and iPad have no Web Bluetooth or Web Serial (in Safari or any other browser there) -- choose Node link: Kelly bridge, with your node plugged into the Pi."
        : `${ms.link === 'usb' ? 'Web Serial' : 'Web Bluetooth'} isn't available here -- it needs Chrome or Edge with Kelly opened on this PC (file:// or localhost). Opened from the Pi? Use the Bridge link.`;
      const sb = $('#mesh-stale');
      if (sb) { sb.hidden = !st.stale; if (st.stale) { setHTML(sb, `<b>⚠️ Stale connection -- the LoRa node isn't answering</b><span>${st.stale.down ? "The node's port is closed (unplugged, or it reset)." : `You're connected, but the node behind the ${st.stale.src === 'bridge' ? 'bridge' : 'link'} stopped replying`} -- since ${new Date(st.stale.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${agoTag(st.stale.since)}). Nothing will load or send until it's power-cycled: unplug and replug its USB (or press reset), then Connect again. If it's a shared node, tell whoever looks after it.</span>`); fillAgo(sb); } }
      const allNodes = [...st.nodes.values()].filter(n => n.num !== st.myNum).sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));
      const nodes = hamSort(allNodes, n => n.lastHeard || 0);
      const p = myPos();
      setHTML($('#mesh-stats'), [['🕸️', nodes.length, 'nodes'], ['📻', nodes.filter(n => n.licensed).length, 'hams'], ['📥', st.rx, 'packets in'], ['📤', st.tx, 'sent'],
        ['📶', n0 && n0.chUtil != null ? `${n0.chUtil.toFixed(1)}%` : '—', 'channel use']].map(([i, v, l]) => `<div class="mesh-stat"><span>${i}</span><b>${v}</b><small>${l}</small></div>`).join(''));
      // channels + DMs
      const tabs = st.channels.filter(Boolean).map(c => `ch${c.index}`);
      if (!tabs.length) tabs.push('ch0');
      const dms = Object.keys(st.chats).filter(x => x.startsWith('dm')).sort((a, b) => ((st.chats[b].slice(-1)[0] || {}).t || 0) - ((st.chats[a].slice(-1)[0] || {}).t || 0)).slice(0, 8);
      if (!tabs.includes(st.chat) && !dms.includes(st.chat)) st.chat = tabs[0];
      setHTML($('#mesh-tabs'), tabs.map(t => `<button data-chat="${t}" class="${st.chat === t ? 'on' : ''}"># ${esc(chName(+t.slice(2)))}${st.unread[t] ? `<em>${st.unread[t]}</em>` : ''}</button>`).join('')
        + dms.map(t => `<button data-chat="${t}" class="dm ${st.chat === t ? 'on' : ''}">🔒 ${esc(short(+t.slice(2)))}${st.unread[t] ? `<em>${st.unread[t]}</em>` : ''}</button>`).join(''));
      const msgs = st.chats[st.chat] || [], chat = $('#mesh-chat'), atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40, sig = `${st.chat}|${msgs.length}|${msgs.map(m => m.state + JSON.stringify(m.react || '')).join('')}`;
      if (chat.dataset.sig !== sig) {
        chat.dataset.sig = sig;
        chat.innerHTML = msgs.map(m => {
          const mine = m.from === st.myNum, n = st.nodes.get(m.from);
          return `<div class="mesh-msg ${mine ? 'mine' : ''}${m.bridge || /^\[P25/.test(m.text) ? ' bridged' : ''}" data-id="${m.id}">${mine ? '' : avatar(n)}<div class="mb"><small>${mine ? 'You' : esc(nmc(m.from))} · ${new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${m.hops != null && !mine ? ` · ${m.hops === 0 ? 'direct' : m.hops + ' hops'}` : ''}${m.err ? ` · ${esc(m.err)}` : ''}</small>`
            + `<p>${esc(m.text)}</p>${m.react ? `<span class="mesh-react">${Object.entries(m.react).map(([e, c]) => `${esc(e)}${c > 1 ? c : ''}`).join(' ')}</span>` : ''}${mine ? tick(m.state) : ''}`
            + `<span class="mesh-tap">${['👍', '❤️', '😂', '📡', '73'].map(e => `<button data-react="${esc(e)}" title="React">${e}</button>`).join('')}</span></div></div>`;
        }).join('') || `<p class="dim small mesh-empty">${on ? 'No messages yet -- say hello to the mesh 👋' : drv() && ms.link !== 'demo' ? 'Not connected: what you send waits in the outbox until your node is back.' : 'Connect a node to chat on the mesh.'}</p>`;
        if (atBottom || msgs.length && msgs[msgs.length - 1].from === st.myNum) chat.scrollTop = chat.scrollHeight;
      }
      const t = $('#mesh-text').value, mx = maxText(); $('#mesh-count').textContent = `${bytesOf(t)} / ${mx}`; $('#mesh-count').style.color = bytesOf(t) > mx ? 'var(--red)' : '';
      const canQueue = !on && !!drv() && ms.link !== 'demo';   // MeshCore / LoRa APRS offline: Send fills the outbox
      $('#mesh-send').disabled = !on && !canQueue;
      $('#mesh-send').textContent = canQueue ? '📮 Queue' : '📡 Send';
      // node list
      const q = ($('#mesh-q').value || '').toLowerCase();
      patchList($('#mesh-nodes'), nodes.filter(n => !q || `${n.longName} ${n.shortName} ${nid(n.num)} ${hwOf(n)}`.toLowerCase().includes(q)).slice(0, 120).map(n => {
        const km = p && n.lat != null ? distKm(p, n) : null, fresh = Date.now() - (st.ripples.get(n.num) || 0) < 2000;
        const bat = n.battery == null ? '' : n.battery > 100 ? '<span class="mesh-bat pwr" title="Powered">⚡</span>' : `<span class="mesh-bat" title="Battery ${n.battery}%"><i style="width:${n.battery}%;background:${n.battery < 20 ? 'var(--red)' : n.battery < 50 ? 'var(--amber)' : '#39ff88'}"></i></span>`;
        const ham = isHam(n), second = ms.hamMode === 'first' && !ham, p25 = ham ? p25Of(n) : null;
        return { key: n.num, cls: `mesh-node${st.sel === n.num ? ' sel' : ''}${fresh ? ' fresh' : ''}${second ? ' second' : ''}`, html: `${avatar(n)}<div class="mn-main"><b>${esc(n.longName || nid(n.num))}${n.licensed ? ' <span class="mesh-ham">HAM</span>' : ham ? ' <span class="mesh-ham call" title="Callsign in its name">CALL</span>' : ''}${n.fav ? ' ⭐' : ''}</b>`
          + `<small>${esc(hwOf(n))}${roleOf(n) ? ` · ${esc(roleOf(n))}` : ''}${n.hops != null ? ` · ${n.hops === 0 ? 'direct' : n.hops + ' hop' + (n.hops > 1 ? 's' : '')}` : ''}${n.viaMqtt ? ' · MQTT' : ''}</small>`
          + `<small>${km != null ? `${km.toFixed(1)} km${fun ? ` ${fun.cardinal(bearing(p, n))} · ${fun.grid(n.lat, n.lon, 6)}` : ''} · ` : ''}${agoTag(n.lastHeard)}${n.temp != null ? ` · 🌡 ${n.temp.toFixed(1)}°C` : ''}</small>`
          + (p25 ? `<small class="mn-p25">📻 also on P25: ${esc(p25.name)} · ${p25.id}${p25.heardVia ? ` · ${esc(p25.heardVia)}` : ''}${p25.lastHeard ? ` · ${agoTag(p25.lastHeard)}` : ''}</small>` : '') + `</div>`
          + `<div class="mn-side">${snrBars(n.snr)}${bat}<span class="mn-act">${p25 ? `<button data-p25="${p25.id}" title="Text ${esc(p25.name)} on P25">📻</button>` : ''}${n.idLabel === 'channel only' || (ms.dev === 'meshcore' && n.role === 2) ? '' : `<button data-dm="${n.num}" title="Direct message">💬</button>`}${cp.trace && (cp.traceAny || n.role === 2 || n.role === 3) ? `<button data-trace="${n.num}" title="Traceroute">🛰️</button>` : ''}${cp.askPos ? `<button data-pos="${n.num}" title="Ask for its position">📍</button>` : ''}</span></div>` };
      }), 'data-node', 'li', `<li class="dim small">${ms.hamMode === 'only' && allNodes.length ? `No hams among the ${allNodes.length} nodes heard -- set the filter to Hams first or Everyone to see them.` : on ? 'No other nodes heard yet.' : 'No nodes yet.'}</li>`);
      // gateway (via P25)
      $('#mesh-gw-go').disabled = !!st.gwAsk;
      $('#mesh-gw-go').textContent = st.gwAsk ? (st.gwAsk.delivered ? '📡 Gateway answering…' : '📡 Asking…') : '📡 Mesh near me (via P25)';
      setHTML($('#mesh-gw'), st.gw ? `<p class="small dim">${st.gw.rows.length} node(s) within ${st.gw.km} km · ${st.gw.rows.filter(r => r.licensed).length} HAM · ${agoTag(st.gw.got)} -- from the P25X gateway's Meshtastic MQTT feed</p>`
        + st.gw.texts.slice(-6).reverse().map(x => `<div class="mesh-gwt"><b>${esc((st.gw.rows.find(r => r.num === x.from) || {}).shortName || M.defaultShort(x.from))}</b> <small>${esc(x.ch)} · ${agoTag(x.t)}</small><p>${esc(x.text)}</p></div>`).join('') : '');
      fillAgo($('#mesh-gw'));
      // bridge
      const chOpts = sel => [...(st.channels.filter(Boolean).length ? st.channels.filter(Boolean) : [{ index: 0 }])].map(c => `<option value="${c.index}" ${String(sel) === String(c.index) ? 'selected' : ''}># ${esc(chName(c.index))}</option>`).join('');
      if ($('#mb-toch').dataset.n !== String(st.channels.length)) {
        $('#mb-toch').innerHTML = chOpts(ms.toP25Ch) + `<option value="dm" ${ms.toP25Ch === 'dm' ? 'selected' : ''}>🔒 DMs to my node</option>`;
        $('#mb-fromch').innerHTML = chOpts(ms.fromP25Ch); $('#mb-toch').dataset.n = String(st.channels.length);
      }
      $('#mb-to').checked = !!ms.toP25; $('#mb-from').checked = !!ms.fromP25; $('#mb-pos').checked = !!ms.sharePos; $('#mb-sos').checked = !!ms.sosToP25; $('#mb-rules').checked = !!ms.rules; $('#ms-p25').checked = !!ms.p25Layer;
      $('#mb-mode').value = ms.fromP25Mode; if (document.activeElement !== $('#mb-dest')) $('#mb-dest').value = ms.toP25Dest || '';
      $('#mesh-bridge-viz').classList.toggle('live', on && (ms.toP25 || ms.fromP25));
      $('#mb-q').textContent = st.toP25Q.length ? `${st.toP25Q.length} waiting for P25 airtime` : '';
      // sounds
      $('#ms-sound').checked = !!ms.sound; $('#ms-fx').checked = !!ms.fx; $('#ms-scope').checked = !!ms.scope; $('#ms-cov').checked = !!ms.coverage; $('#ms-reconn').checked = !!ms.autoReconnect;
      $$('#ms-sfx input').forEach(i => { i.checked = ms.sfx[i.dataset.sfx] !== false; });
      { const q = ms.quiet || {}; $('#ms-quiet').checked = !!q.on; if (document.activeElement !== $('#ms-qfrom')) $('#ms-qfrom').value = q.from || '22:00';
        if (document.activeElement !== $('#ms-qto')) $('#ms-qto').value = q.to || '07:00'; $('#ms-qnow').textContent = q.on ? (quietNow() ? '🌙 quiet now' : 'not now') : ''; }
      // device log
      if (k.currentPage() === 'mesh' && $('#mesh-log').open) $('#mesh-log pre').textContent = st.logs.slice(-80).map(l => `${new Date(l.t).toLocaleTimeString()}  ${l.line}`).join('\n');
      drawMap(); CV('draw', G && G.cov); MI('render');
      { const lg = $('#mesh-cov-legend'); if (lg) { lg.hidden = !ms.coverage || !cov; if (ms.coverage && cov) { const h = CV('legend'); if (lg.dataset.h !== h) { lg.innerHTML = h; lg.dataset.h = h; } } } }
      if (!scopeRaf && ms.scope) { scopeOpened = Date.now(); scopeRaf = requestAnimationFrame(scope); }
      $('#mesh-scope-wrap').hidden = !ms.scope;
      renderHunt();
      F('render');
      PA('render');
      RP('render'); RM('render'); CHN('render'); SU('render'); CT('render'); TR('render'); GD('render'); DV('render'); TL('render');
    }
    setInterval(() => { if (k.currentPage() === 'mesh' && [...st.ripples.values()].some(t => Date.now() - t < 2500)) dirty('mesh'); }, 900);
    setInterval(() => { if (k.currentPage() === 'mesh') { st.huntSig = ''; dirty('mesh'); } }, 30000);   // "2 min ago" moves on
    function renderHunt() {
      const box = $('#mh-list'); if (!box) return;
      const now = Date.now(), all = st.callers.filter(c => now - c.t < 12 * 3600000), p = myPos();
      for (const c of all) { if (p && c.lat != null && c.km == null) { c.km = distKm(p, c); c.brg = bearing(p, c); } c.ham = isHam(c); }
      const list = hamSort(all, c => c.t), hidden = all.length - list.length;
      const live = list.filter(c => now - c.t < 10 * 60000 && !c.answered && (c.ham || ms.hamMode === 'all')).length;
      $('#mh-count').textContent = live ? `${live} ${ms.hamMode === 'all' ? '' : 'ham '}calling now` : list.length ? `${list.length} in the last 12 h` : '';
      $$('.mesh-hamf').forEach(x => { x.value = ms.hamMode; });
      $('#mh-hidden').textContent = hidden ? `${hidden} non-ham caller${hidden === 1 ? '' : 's'} hidden` : '';
      $('#mh-count').classList.toggle('hot', live > 0);
      $('#mh-alert').checked = !!ms.hunt.alert; $('#mh-sub').checked = !!ms.hunt.sub; $('#mh-km').value = String(ms.hunt.km || 50);
      $('#mh-substate').textContent = st.subAsk ? (st.subAsk.delivered ? 'gateway answering…' : 'asking the gateway…') : ms.hunt.sub ? `callers within ${ms.hunt.km} km come to you over P25 while Kelly is parked` : 'off -- you only see callers your own node hears';
      const sig = `${ms.hamMode}|${st.nodes.size}|${list.length}|${list.map(c => c.key + (c.answered ? 'a' : '')).join(',')}|${st.status}|${ms.dev}|${Math.floor(now / 30000)}`;
      if (st.huntSig === sig) { fillAgo(box); return; } st.huntSig = sig;
      patchList(box, list.slice(0, 20).map(c => {
        const second = ms.hamMode === 'first' && !c.ham && !c.sos;   // non-hams: still listed, greyed, no CALLING tag
        const age = now - c.t, hot = age < 10 * 60000 && !c.answered && !second, same = c.mesh === DEV_LABEL[ms.dev] && st.status === 'on';
        const p25 = c.ham ? p25Of(c) : null;
        return { key: c.key, cls: `mh-call${hot ? ' hot' : ''}${c.answered ? ' done' : ''}${second ? ' second' : ''}${c.sos ? ' sos' : ''}`, html: `${c.sos ? '<em class="mh-live sos">🚨 EMERGENCY</em>' : hot ? '<em class="mh-live">📣 CALLING</em>' : c.answered ? '<em class="mh-live done">✓ ANSWERED</em>' : ''}`
          + `<div class="mh-who">${avatar(st.nodes.get(c.from) || { num: c.from, shortName: c.short, licensed: c.ham })}<div><b>${esc(c.name)}${c.ham ? ' <span class="mesh-ham">HAM</span>' : ''}</b>`
          + `<small>${agoTag(c.t)}${c.km != null ? ` · ${c.km.toFixed(1)} km ${F('cardinal', c.brg) || ''}` : ''}${c.hops != null ? ` · ${c.hops === 0 ? 'direct' : c.hops + ' hop' + (c.hops > 1 ? 's' : '')}` : ''}</small></div></div>`
          + `<p>${esc(noBell(c.text))}</p>${p25 ? `<small class="mn-p25">📻 also on P25: ${esc(p25.name)} · ${p25.id}${p25.lastHeard ? ` · ${agoTag(p25.lastHeard)}` : ''}</small>` : ''}<small class="mh-src">${c.src === 'gateway' ? '☁️ via the P25X gateway' : '📡 heard by your node'} · ${esc(c.mesh)}${c.chName ? ` · #${esc(c.chName)}` : ''}</small>`
          + `<div class="mh-act"><button class="btn ${same && !c.answered ? 'primary' : 'ghost'} small" data-answer="${esc(c.key)}" ${same ? '' : `title="On ${esc(c.mesh)} -- connect a ${esc(c.mesh)} node to answer"`}>🎯 Answer</button>${p25 && !same ? `<button class="btn primary small" data-p25ans="${p25.id}" data-pcall="${esc(callOf(c.name))}" title="They're on ${esc(c.mesh)}, you're not -- answer them on P25 instead">📻 Answer on P25</button>` : ''}${c.lat != null ? `<button class="btn ghost small" data-cmap="${esc(c.key)}" title="Show on the map">🗺️</button>` : ''}</div>` };
      }), 'data-ckey', 'div', `<p class="dim small mh-empty">${hidden ? `No hams calling right now (${hidden} other caller${hidden === 1 ? '' : 's'} hidden -- set the filter to Hams first or Everyone to see them). ` : ''}Nobody calling yet. Stations asking for contacts (CQ, QRZ, "anyone about?", radio checks) show up here -- from your node${ms.hunt.sub ? ' and the P25X gateway' : '. Turn on <b>Callers from the gateway</b> to hear the Meshtastic mesh around you even without a node'}.</p>`);
    }

    // ------------------------------------------------------------------ bindings
    // Phone layout (Phase 13, <= 600 px): kelly.css puts the messages and the map first; every other card on the Mesh tab
    // folds to its title bar (tap it to open). Open / folded is kept per card, per viewer (store 'meshFold' {key: true = open}).
    // Wider screens: nothing folds, the toggles hide.
    // The short phone page (2026-10-24: "way too busy, cut it down to connection, messages, meshquest"): on a
    // phone only those show (kelly.css #page-mesh.mesh-lite); "Show all" brings the rest back, kept per viewer ('meshLite').
    function phoneLite() {
      const page = $('#page-mesh'), pane = $('[data-tabpane="mesh:main"]'), mq = window.matchMedia && matchMedia('(max-width: 600px)');
      if (!page || !pane) return;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost mesh-lite-btn';
      const lite = () => store.get('meshLite', true) !== false;
      const apply = () => {
        page.classList.toggle('mesh-lite', lite());
        b.textContent = lite() ? '▾ Show all LoRa Mesh cards' : '▴ Just messages and Mesh Quest';
        const t = $('[data-tabs="mesh"] [data-tab="main"]');   // the tabs hide: be on the Mesh tab
        if (lite() && mq && mq.matches && t && !t.classList.contains('on')) t.click();
      };
      b.onclick = () => { store.set('meshLite', !lite()); apply(); if (st.map) setTimeout(() => st.map.invalidateSize(), 60); dirty('mesh'); };
      pane.appendChild(b); apply();
      if (mq && mq.addEventListener) mq.addEventListener('change', apply);
    }
    function phoneFold() {
      const pane = $('[data-tabpane="mesh:main"]'), mq = window.matchMedia && matchMedia('(max-width: 600px)');
      if (!pane || !mq) return;
      const open = store.get('meshFold', {}) || {};
      const keyOf = c => c.id || ((c.querySelector(':scope > .card-h h2') || {}).textContent || '').replace(/[^A-Za-z ]/g, '').trim().slice(0, 40);
      const cards = [...pane.querySelectorAll('.card')].filter(c => !c.matches('.mesh-chatcard, .mesh-mapcard') && !c.parentElement.closest('.card') && c.querySelector(':scope > .card-h') && keyOf(c));
      const apply = () => cards.forEach(c => { const f = mq.matches && !open[keyOf(c)]; c.classList.toggle('folded', f); const b = c.querySelector(':scope > .card-h > .mesh-foldbtn'); if (b) b.setAttribute('aria-expanded', String(!f)); });
      for (const c of cards) {
        const h = c.querySelector(':scope > .card-h'), b = document.createElement('button');
        c.classList.add('mesh-fold'); b.type = 'button'; b.className = 'mesh-foldbtn'; b.title = 'Open / fold'; b.setAttribute('aria-label', 'Open or fold this card'); b.textContent = '▾';
        h.appendChild(b);
        h.addEventListener('click', e => {
          if (!mq.matches || (e.target.closest('button, input, select, a, label, textarea') && e.target !== b)) return;
          const k = keyOf(c); open[k] = c.classList.contains('folded'); store.set('meshFold', open); apply();
          if (open[k]) dirty('mesh');
        });
      }
      apply();
      if (mq.addEventListener) mq.addEventListener('change', () => { apply(); if (st.map) setTimeout(() => st.map.invalidateSize(), 60); });
    }
    // a code read by 📷 Scan -> where it belongs (each hook is another file's; missing = a toast saying where to go)
    function meshScanned(text, p) {
      const kind = p && p.kind, hook = n => (typeof window[n] === 'function' ? window[n] : null);
      if (kind === 'contact' || kind === 'advert') { const f = hook('kellyHCImport'); return f ? f(text) : toast('📇', 'A MeshCore contact', 'Add it in LoRa Mesh › 📇 Ham Contacts (or the 📇 Contacts card).', 'warn'); }
      if (kind === 'channel') { const f = hook('kellyChannelImport'); return f ? f(text) : toast('📻', 'A MeshCore channel', "It carries the channel's secret key. Kelly can't add channels from a QR here yet -- nothing was saved.", 'warn'); }
      if (kind === 'kelly') { const C = window.KellyConnectQR && window.KellyConnectQR.current; return C && C.offer ? C.offer(text) : toast('📷', 'A Kelly connect code', 'Use Admin › Connection › 📷 Scan a Kelly QR.', 'warn'); }
      if (kind === 'meshtastic') return toast('📷', 'A Meshtastic link', "That's Meshtastic, not MeshCore: open it in the Meshtastic app.", 'warn');
      toast('📷', 'Not a MeshCore code', 'Nothing was added.', 'warn');
    }
    function init() {
      $('#mesh-link').onchange = () => { ms.link = $('#mesh-link').value; save(); dirty('mesh'); };
      $('#mesh-dev').onchange = () => { if (st.link) return; switchDev($('#mesh-dev').value); save(); dirty('mesh'); };
      $('#mesh-call').onchange = () => { ms.aprsCall = $('#mesh-call').value.trim().toUpperCase(); save(); dirty('mesh'); };
      $('#mesh-burl').onchange = () => { ms.bridgeUrl = $('#mesh-burl').value.trim(); save(); dirty('mesh'); };
      // 🔳 beside the Mesh bridge address: the address in use as a QR
      const QRui = window.KellyMeshQR ? window.KellyMeshQR.ui({ toast }) : null;
      if (QRui && $('#mesh-burl')) {
        const inp = $('#mesh-burl'), row = document.createElement('span'); row.className = 'mesh-brow'; row.style.cssText = 'display:flex;gap:4px;align-items:center';
        inp.replaceWith(row); row.append(inp);
        inp.insertAdjacentHTML('afterend', '<button type="button" class="btn small ghost" id="mesh-bqr" title="Show the mesh bridge address in use as a QR code, so another Kelly can scan it">🔳</button>');
        $('#mesh-bqr').onclick = async e => {
          e.preventDefault();
          const text = await bridgeShareLink();
          if (!text) return toast('🔳', 'No Kelly bridge to share', 'Open Kelly from your Kelly bridge (or set its Bridge URL in Admin)', 'warn');
          const hasTok = /[?&](token|mb)=/i.test(text);
          if (!/[?&]token=/i.test(text) && !ms.bridgeUrl) toast('🔳', 'This Kelly has no bridge token', 'The phone will be refused: open Kelly once with ?token=… first', 'warn');
          QRui.showText({ title: '🔳 Mesh bridge address', text, display: text.replace(/([?&]token=)[^&#]*/gi, '$1…').replace(/(token%3D)[^&#]*/gi, '$1…'),
            note: `Scan it with the phone's camera: it opens Kelly on the LoRa Mesh page and connects ${ms.bridgeUrl ? `to ${ms.bridgeUrl.replace(/([?&]token=)[^&#]*/i, '$1…')}` : 'through this bridge'} -- the radio stays here.`,
            secret: hasTok ? 'It holds the bridge token: anyone who scans it can use your LoRa node and read your channels.' : '' });
        };
      }
      // 📷 Scan beside Connect: one scanner for every code a ham might hold up (QR_REVIEW.md item 9), routed by kind --
      // contact / signed advert -> 📇 Ham Contacts (hc-*.js kellyHCImport), channel -> 📻 Channels (kellyChannelImport),
      // Kelly connect code -> Connect a phone's "Switch to" offer, Meshtastic -> its app. The code's text never goes on screen.
      if (QRui && $('#mesh-go')) {
        $('#mesh-go').insertAdjacentHTML('afterend', '<button type="button" class="btn" id="mesh-scan" title="Scan a QR code: a MeshCore contact or channel, or a Kelly connect code">📷 Scan</button>');
        $('#mesh-scan').onclick = e => { e.preventDefault(); QRui.scan(meshScanned, { accept: ['contact', 'advert', 'channel', 'kelly', 'meshtastic'], title: '📷 Scan a QR code',
          hint: 'A MeshCore contact or channel, or a Kelly connect code from your PC.' }); };
        window.KellyMeshScan = { route: meshScanned };   // for tests/meshbridge-qr-cdp.js (the camera needs a real phone)
      }
      $('#mesh-go').onclick = () => (st.link || rcTimer ? disconnect() : connect());
      const send = () => { const v = $('#mesh-text').value; if (!v.trim()) return; sendText(v).then(r => { if (r) $('#mesh-text').value = ''; dirty('mesh'); }); };
      $('#mesh-send').onclick = send;
      $('#mesh-text').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
      $('#mesh-text').oninput = () => dirty('mesh');
      $$('[data-mesh-quick]').forEach(b => { b.onclick = () => { const q = b.dataset.meshQuick; if (q === 'pos') sharePosition(true); else sendText(q.replace('{call}', (settings.myCall || '').toUpperCase() || 'KELLY')); }; });
      $('#mesh-tabs').onclick = e => { const b = e.target.closest('[data-chat]'); if (b) openChat(b.dataset.chat); };
      $('#mesh-chat').onclick = e => { const b = e.target.closest('[data-react]'), m = e.target.closest('[data-id]'); if (b && m) react(+m.dataset.id, b.dataset.react); };
      $('#mesh-q').oninput = () => dirty('mesh');
      $('#mesh-nodes').onclick = e => {
        const dm = e.target.closest('[data-dm]'), tr = e.target.closest('[data-trace]'), ps = e.target.closest('[data-pos]'), li = e.target.closest('[data-node]'), pp = e.target.closest('[data-p25]');
        if (pp) return k.openP25(+pp.dataset.p25);
        if (dm) { const key = `dm${dm.dataset.dm}`; st.chats[key] = st.chats[key] || []; openChat(key); $('#mesh-text').focus(); return; }
        if (tr) return traceroute(+tr.dataset.trace);
        if (ps) return askPosition(+ps.dataset.pos);
        if (li) focusNode(+li.dataset.node);
      };
      $('#mesh-gw-go').onclick = gatewayAsk;
      $('#mh-alert').onchange = () => { ms.hunt.alert = $('#mh-alert').checked; save(); };
      $$('.mesh-hamf').forEach(x => { x.onchange = () => { const was = ms.hamMode; ms.hamMode = x.value; save(); st.huntSig = ''; dirty('mesh');
        if (ms.hunt.sub && (was === 'only') !== (ms.hamMode === 'only')) huntSub(true); }; });   // the gateway filters too when it's hams only
      $('#mh-sub').onchange = () => { ms.hunt.sub = $('#mh-sub').checked; save(); huntSub(ms.hunt.sub); };
      $('#mh-km').onchange = () => { ms.hunt.km = +$('#mh-km').value; save(); if (ms.hunt.sub) huntSub(true); };
      $('#mh-clear').onclick = () => { st.callers = []; saveCallers(); st.huntSig = ''; dirty('mesh'); };
      $('#mh-list').onclick = e => {
        const a = e.target.closest('[data-answer]'), m = e.target.closest('[data-cmap]'), pa = e.target.closest('[data-p25ans]');
        if (pa) { const ck = pa.closest('[data-ckey]'); p25AnswerOpen(ck ? st.callers.find(x => x.key === ck.dataset.ckey) : null, pa.dataset.p25ans, pa.dataset.pcall); return k.openP25(+pa.dataset.p25ans, `${pa.dataset.pcall} de ${(settings.myCall || '').toUpperCase() || 'KELLY'} -- saw your call on the mesh. QSL? 73`); }
        if (a) return answer(a.dataset.answer);
        if (m) { const c = st.callers.find(x => x.key === m.dataset.cmap); if (c && c.lat != null && st.map) { st.map.setView([c.lat, c.lon], Math.max(st.map.getZoom(), 11)); $('#mesh-map').scrollIntoView({ behavior: 'smooth', block: 'center' }); if (st.nodes.get(c.from)) focusNode(c.from); } }
      };
      $('#mesh-km').value = String(ms.nearKm || 50); $('#mesh-km').onchange = () => { ms.nearKm = +$('#mesh-km').value; save(); };
      const tog = (id, key) => { $(id).onchange = () => { ms[key] = $(id).checked; save(); dirty('mesh'); }; };
      tog('#mb-rules', 'rules');
      $('#mb-rules-save').onclick = () => {
        let cfg; try { cfg = JSON.parse($('#mb-rules-cfg').value || '{}'); } catch (e) { $('#mb-rules-msg').textContent = `Not valid JSON: ${e.message}`; return; }
        // the node's channel names, so a rule onto #Public is refused (MBUG: an automated post there floods all of SEQ)
        const chans = Object.fromEntries((st.channels || []).map((c, i) => (c && typeof c === 'object' ? [c.index ?? i, c.name] : [i, c])).filter(([, n]) => n));
        const errs = window.MeshBridgeRules ? window.MeshBridgeRules.validate(cfg, { channels: chans }) : ['js/mesh-bridge-rules.js is not loaded'];
        // direct mode only sees texts to this radio: say so when a rule waits for something it never gets
        const blind = errs.length ? [] : (cfg.rules || []).filter(r => ((r.match || {}).source || []).some(s => s !== 'text')).map(r => r.id || r.name || '?');
        $('#mb-rules-msg').textContent = errs.length ? errs.join(' · ')
          : blind.length ? `Saved. Note: ${blind.join(', ')} ${blind.length > 1 ? 'wait' : 'waits'} for emergencies, statuses or alarms, which direct mode never sees -- only texts this radio receives.` : 'Saved.';
        if (!errs.length) { ms.rulesCfg = cfg; save(); dirty('mesh'); }
      };
      $('#mb-rules-cfg').onfocus = () => { if (!$('#mb-rules-cfg').value.trim()) $('#mb-rules-cfg').value = JSON.stringify(ms.rulesCfg || { rules: [], reverse: { enabled: false, allow: [] } }, null, 1); };
      tog('#mb-to', 'toP25'); tog('#mb-from', 'fromP25'); tog('#mb-pos', 'sharePos'); tog('#ms-sound', 'sound'); tog('#ms-fx', 'fx'); tog('#ms-scope', 'scope'); tog('#ms-cov', 'coverage'); tog('#ms-reconn', 'autoReconnect');
      tog('#mb-sos', 'sosToP25'); tog('#ms-p25', 'p25Layer');
      $('#mb-toch').onchange = () => { ms.toP25Ch = $('#mb-toch').value === 'dm' ? 'dm' : +$('#mb-toch').value; save(); };
      $('#mb-fromch').onchange = () => { ms.fromP25Ch = +$('#mb-fromch').value; save(); };
      $('#mb-mode').onchange = () => { ms.fromP25Mode = $('#mb-mode').value; save(); };
      $('#mb-dest').onchange = () => { ms.toP25Dest = $('#mb-dest').value.trim(); save(); };
      $('#mb-share').onclick = () => sharePosition(true);
      const qsave = () => { ms.quiet = { on: $('#ms-quiet').checked, from: $('#ms-qfrom').value || '22:00', to: $('#ms-qto').value || '07:00' }; save(); dirty('mesh'); };
      ['#ms-quiet', '#ms-qfrom', '#ms-qto'].forEach(id => { $(id).onchange = qsave; });
      $('#ms-sfx').onchange = e => { const i = e.target.closest('[data-sfx]'); if (i) { ms.sfx[i.dataset.sfx] = i.checked; save(); if (i.checked) { if (['mission', 'badge', 'level', 'record'].includes(i.dataset.sfx)) F('play', i.dataset.sfx); else sfx(i.dataset.sfx); } } };
      $('#ms-sfx').onclick = e => { const b = e.target.closest('[data-try]'); if (b) { const was = ms.sound, q = ms.quiet; ms.sound = true; ms.quiet = null; if (['mission', 'badge', 'level', 'record'].includes(b.dataset.try)) F('play', b.dataset.try); else sfx(b.dataset.try); ms.sound = was; ms.quiet = q; } };   // a ▶ always plays, even in quiet hours
      $('#mesh-log').ontoggle = () => dirty('mesh');
      F('init'); hookSelf(); hamSync(); PA('init'); RP('init'); RM('init'); CHN('init'); SU('init'); CT('init'); TR('init'); GD('init'); SS('init'); DV('init'); TL('init'); AN('init'); PJ('init'); TRU('init'); HCU('init'); PGU('init'); MPU('init'); MBU('init');
      // the page was reloaded (Android dropped the tab while the screen was off) with a bridge link up: take it back
      // a phone link from the bridge's QR (js/connectqr.js): ?mesh=<device> -- the LoRa Mesh over this page's bridge, now
      // (the radio stays with the Pi's always-on Kelly); a stale Mesh bridge address would point it elsewhere, so it goes
      const qm = new URLSearchParams(location.search).get('mesh');
      if (qm && DEV_LABEL[qm] && /^https?:/.test(location.protocol)) {
        if (ms.dev !== qm) switchDev(qm);
        ms.link = 'bridge'; ms.bridgeUrl = (new URLSearchParams(location.search).get('mb') || '').trim(); ms.resume = true; save(); dirty('mesh');
        setTimeout(() => { if (!st.link) connect(); }, 1200);
      } else if (ms.resume && ms.autoReconnect) setTimeout(autoStart, 1500);
      phoneFold(); phoneLite();
      const mtabs = $('[data-tabs="mesh"]');
      if (mtabs) mtabs.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return;
        if (b.dataset.tab === 'main') setTimeout(() => { if (st.map) st.map.invalidateSize(); }, 60); else if (b.dataset.tab === 'analyser') AN('shown'); else if (b.dataset.tab === 'journey') PJ('shown'); else if (b.dataset.tab === 'trace') TRU('shown'); else if (b.dataset.tab === 'contacts') HCU('shown'); else if (b.dataset.tab === 'guard') PGU('shown'); else if (b.dataset.tab === 'mprs') MPU('shown'); else if (b.dataset.tab === 'buddy') MBU('shown'); else SS('shown');
        if (b.dataset.tab !== 'journey') PJ('hidden'); if (b.dataset.tab !== 'trace') TRU('hidden'); if (b.dataset.tab !== 'contacts') HCU('hidden'); if (b.dataset.tab !== 'guard') PGU('hidden'); if (b.dataset.tab !== 'mprs') MPU('hidden'); });
      const hco = $('#mh-hopen'); if (hco) hco.onclick = () => showMeshTab('analyser');
      if (location.hash === '#pj-demo') setTimeout(() => showMeshTab('journey'), 600);   // Packet Journey in demo mode (pj-ui.js starts it)
      if (location.hash === '#tr-demo') setTimeout(() => showMeshTab('trace'), 600);   // Trace Route in demo mode (tr-ui.js starts it)
      if (location.hash === '#hc-demo') setTimeout(() => showMeshTab('contacts'), 600);   // Ham Contacts in demo mode (hc-ui.js starts it)
      if (location.hash === '#mesh-contacts') setTimeout(() => showMeshTab('contacts'), 600);   // kellypage.app/mesh (mesh.html) opens Kelly on LoRa Mesh > Ham Contacts
      if (location.hash === '#pg-demo') setTimeout(() => showMeshTab('guard'), 600);   // Property Guard's demo (pg-ui.js starts it)
      if (location.hash === '#mprs-demo') setTimeout(() => showMeshTab('mprs'), 600);   // MeshPRS tab on the MeshCore Demo (mprs-ui.js starts its demo tracker)
      // kelly-page/index.html#mesh-demo opens straight into the demo mesh (club demos, testing)
      // #mesh-demo-meshcore: the simulated MeshCore node (js/meshcoresim.js) instead
      if (location.hash === '#mesh-demo' || location.hash === '#mesh-demo-meshcore' || location.hash === '#mprs-demo') {
        if (location.hash !== '#mesh-demo' && ms.dev !== 'meshcore') switchDev('meshcore');
        else if (location.hash === '#mesh-demo' && ms.dev !== 'meshtastic') switchDev('meshtastic');
        ms.link = 'demo'; setTimeout(() => { k.showPage('mesh'); connect(); if (location.hash === '#mprs-demo') setTimeout(() => showMeshTab('mprs'), 300); }, 600);
      }
    }

    // ------------------------------------------------------------------ demo mesh (simulated, real protobufs)
    function demoMesh() {
      const call = (settings.myCall || 'VK4XXX').toUpperCase(), myNum = 0x4b454c59;
      const N = [
        [myNum, 'KLY', `${call} Kelly`, 43, 0, true, -27.6210, 152.7646],
        [0x3a7f1c02, 'MtCT', 'Mt Coot-tha Router', 31, 2, false, -27.4766, 152.9584],
        [0x5e21aa13, '4ABC', 'VK4ABC Mobile', 4, 5, true, -27.585, 152.82],
        [0x77d0e104, 'IPSW', 'Ipswich Hilltop', 9, 2, false, -27.6395, 152.7403],
        [0x12ab9905, 'GLRS', 'Mt Glorious Solar', 95, 11, false, -27.3333, 152.7667],
        [0x9c03be06, 'TWB', 'VK4TWB Toowoomba', 43, 12, true, -27.5600, 151.9500],
        [0x4d4e5007, 'T1KE', 'Hiker T1000-E', 71, 5, false, -27.4720, 152.9420],
        [0x2f8e7708, 'WX01', 'Redcliffe WX', 9, 6, false, -27.2300, 153.1000],
        [0x61c4dd09, 'GCst', 'Gold Coast Node', 110, 0, false, -28.0000, 153.4300],
        [0x0b5e2a10, '4QF', 'VK4ZQ Portable', 50, 0, true, -27.5150, 152.9750],
        [0xc0ffee11, 'CAFE', 'Cafe Mesh Tab', 86, 0, false, -27.4700, 153.0230],
      ];
      const late = [0x7a4b1c12, 'ROVR', 'VK4ROV Rover', 113, 5, true, -27.70, 152.65];   // joins after a while
      const hops = { 0x3a7f1c02: 1, 0x5e21aa13: 0, 0x77d0e104: 0, 0x12ab9905: 1, 0x9c03be06: 3, 0x4d4e5007: 2, 0x2f8e7708: 2, 0x61c4dd09: 3, 0x0b5e2a10: 1, 0xc0ffee11: 2, 0x7a4b1c12: 0 };
      const chatter = ['Morning all, strong signals off the hilltop this morning', 'Anyone on the P25X network today?', 'Solar node at 92%, the sun is doing its job',
        'QSL from Toowoomba -- 3 hops and still clean', 'Testing range from the car, heading west on the Warrego', '73 de VK4ABC, QRT for lunch', 'Busy mesh today! 12 nodes heard',
        'Anyone try the new Heltec V4 yet?', 'Range test: 41 km to Mt Glorious on the stock antenna', 'Net on the P25X wide TG at 7:30 tonight -- mesh folks welcome', 'Coffee at the cafe node if anyone is in town ☕'];
      const timers = []; let onB = null, wx = 24.5;
      const emit = fr => { if (onB) { const b = M.encode('FromRadio', fr); onB(M.frame(b)); } };
      const pkt = (from, portnum, payload, extra = {}) => {
        const h = hops[from] ?? 1;
        emit({ packet: { from, to: M.BROADCAST, channel: 0, id: M.newId(), rxTime: Math.floor(Date.now() / 1000), rxSnr: +(Math.random() * 14 - 6).toFixed(2), rxRssi: -60 - Math.floor(Math.random() * 60), hopStart: 3, hopLimit: 3 - h, ...extra, decoded: { portnum, payload, ...(extra.decoded || {}) } } });
      };
      const enc = new TextEncoder(), pos = n => M.encode('Position', { latitudeI: Math.round(n[6] * 1e7), longitudeI: Math.round(n[7] * 1e7), altitude: 40 + Math.floor(Math.random() * 300), time: Math.floor(Date.now() / 1000), locationSource: 1 });
      const user = n => M.encode('User', { id: M.nodeId(n[0]), longName: n[2], shortName: n[1], hwModel: n[3], role: n[4], isLicensed: n[5] });
      const every = (ms_, fn) => timers.push(setInterval(fn, ms_));
      const later = (ms_, fn) => timers.push(setTimeout(fn, ms_));
      const pick = a => a[Math.floor(Math.random() * a.length)];
      return { name: 'Demo', unframed: false, async open(cb) { onB = cb; st.note = 'Demo mesh -- simulated, nothing transmitted'; },
        async write(bytes) {
          const tr = M.decode('ToRadio', bytes);
          if (tr.wantConfigId) {
            later(150, () => {
              emit({ myInfo: { myNodeNum: myNum, rebootCount: 3, minAppVersion: 30200, pioEnv: 'heltec-v3' } });
              emit({ metadata: { firmwareVersion: '2.7.11-demo', hwModel: 43, role: 0 } });
              N.forEach((n, i) => emit({ nodeInfo: { num: n[0], user: { id: M.nodeId(n[0]), longName: n[2], shortName: n[1], hwModel: n[3], role: n[4], isLicensed: n[5] },
                position: { latitudeI: Math.round(n[6] * 1e7), longitudeI: Math.round(n[7] * 1e7) }, snr: 4 - i, lastHeard: Math.floor(Date.now() / 1000) - i * 300, hopsAway: hops[n[0]] ?? 0,
                deviceMetrics: { batteryLevel: n[4] === 2 ? 101 : 40 + i * 5, voltage: 3.9, channelUtilization: 8.4, airUtilTx: 1.2 } } }));
              emit({ channel: { index: 0, role: 1, settings: { name: 'MediumFast', psk: Uint8Array.of(1) } } });
              emit({ channel: { index: 1, role: 2, settings: { name: 'P25X', psk: new Uint8Array(16).fill(7) } } });
              emit({ configCompleteId: tr.wantConfigId });
              emit({ logRecord: { message: 'Demo node booted -- region ANZ, preset MediumFast, slot 45 (SEQ)', level: 20 } });
            });
            later(4000, () => pkt(0x5e21aa13, M.PORT.TEXT, enc.encode('G\'day from the mobile! Anyone hearing me on the mesh?')));
            later(45000, () => { pkt(late[0], M.PORT.NODEINFO, user(late)); later(1500, () => pkt(late[0], M.PORT.POSITION, pos(late))); });
            every(9000, () => {   // the mobile and the hiker move
              const m = N[2]; m[6] += (Math.random() - 0.3) * 0.004; m[7] += (Math.random() - 0.2) * 0.006; pkt(m[0], M.PORT.POSITION, pos(m));
              const h = N[6]; h[6] += (Math.random() - 0.5) * 0.0015; h[7] += (Math.random() - 0.5) * 0.0015; later(3000, () => pkt(h[0], M.PORT.POSITION, pos(h)));
            });
            every(31000, () => pkt(pick(N.slice(1))[0], M.PORT.TEXT, enc.encode(pick(chatter))));
            every(23000, () => { const n = pick(N.slice(1)); pkt(n[0], M.PORT.TELEMETRY, M.encode('Telemetry', { time: Math.floor(Date.now() / 1000), deviceMetrics: { batteryLevel: n[4] === 2 ? 101 : 30 + Math.floor(Math.random() * 70), voltage: 3.7 + Math.random() * 0.5, channelUtilization: 5 + Math.random() * 15, airUtilTx: Math.random() * 3, uptimeSeconds: 86400 } })); });
            every(47000, () => { wx += (Math.random() - 0.5); pkt(0x2f8e7708, M.PORT.TELEMETRY, M.encode('Telemetry', { time: Math.floor(Date.now() / 1000), environmentMetrics: { temperature: wx, relativeHumidity: 60 + Math.random() * 10, barometricPressure: 1013 + Math.random() * 4 } })); });
            every(61000, () => pkt(0x3a7f1c02, M.PORT.NEIGHBORINFO, M.encode('NeighborInfo', { nodeId: 0x3a7f1c02, nodeBroadcastIntervalSecs: 900, neighbors: [0x77d0e104, 0x12ab9905, 0x0b5e2a10, 0xc0ffee11, 0x4d4e5007].map(x => ({ nodeId: x, snr: Math.random() * 12 - 3 })) })));
            every(97000, () => { const n = pick(N.slice(1)); pkt(n[0], M.PORT.NODEINFO, user(n)); });
            return;
          }
          const p = tr.packet; if (!p || !p.decoded) return;
          const d = p.decoded, to = p.to >>> 0;
          if (p.wantAck) later(900 + Math.random() * 1800, () => emit({ packet: { from: to === M.BROADCAST ? myNum : to, to: myNum, id: M.newId(), decoded: { portnum: M.PORT.ROUTING, payload: M.encode('Routing', { errorReason: 0 }), requestId: p.id } } }));
          if (d.portnum === M.PORT.TEXT && !d.emoji) {
            const txt = new TextDecoder().decode(d.payload);
            if (to !== M.BROADCAST) later(4000 + Math.random() * 3000, () => emit({ packet: { from: to, to: myNum, channel: 0, id: M.newId(), rxSnr: 6.5, hopStart: 3, hopLimit: 3 - (hops[to] ?? 1), decoded: { portnum: M.PORT.TEXT, payload: enc.encode(pick(['Copy that 👍 got it on the mesh', 'Roger, loud and clear', `QSL ${call}, 73!`, 'Thanks -- will pass it on to the P25 crew'])) } } }));
            else if (/\?|anyone|hello|cq/i.test(txt)) later(6000, () => pkt(pick(N.slice(1))[0], M.PORT.TEXT, enc.encode(pick(['Hearing you fine from here!', `Good copy ${call} 👋`, 'Loud and clear via the Mt Coot-tha router']))));
            else later(2500, () => pkt(pick(N.slice(1))[0], M.PORT.TEXT, enc.encode(pick(['👍', '73'])), { decoded: { emoji: 1, replyId: p.id } }));
          }
          if (d.portnum === M.PORT.TRACEROUTE && to !== M.BROADCAST) {
            const h = hops[to] ?? 1, relays = [0x77d0e104, 0x3a7f1c02, 0x12ab9905, 0x0b5e2a10].filter(x => x !== to).slice(0, h);
            later(1800 + h * 900, () => emit({ packet: { from: to, to: myNum, id: M.newId(), decoded: { portnum: M.PORT.TRACEROUTE, requestId: p.id,
              payload: M.encode('RouteDiscovery', { route: relays, snrTowards: [...relays, to].map(() => Math.round((Math.random() * 16 - 4) * 4)), routeBack: [...relays].reverse(), snrBack: [...relays, 0].map(() => Math.round((Math.random() * 16 - 4) * 4)) }) } } }));
          }
          if (d.portnum === M.PORT.POSITION && d.wantResponse && to !== M.BROADCAST) { const n = N.find(x => x[0] === to) || (late[0] === to ? late : null); if (n) later(2500, () => pkt(n[0], M.PORT.POSITION, pos(n))); }
        },
        close() { timers.forEach(t => { clearInterval(t); clearTimeout(t); }); onB = null; } };
    }

    // the APRS iGate page's view of the MeshCore link (own beacon, telemetry polls, "is my key on the whitelist")
    const igateLink = () => ({ dev: () => ms.dev, online: () => st.status === 'on', session: () => (ms.dev === 'meshcore' ? st.session : null),
      selfKey: () => (ms.dev === 'meshcore' && st.session && st.session.selfKey ? st.session.selfKey() : null), nodes: () => [...st.nodes.values()], selfName: () => (me() || {}).longName || '',
      channels: () => st.channels,
      isDemo: () => ms.link === 'demo' });
    return { init, render, onP25Text, onP25Sent, igateLink, ownsXid: xid => !!(st.gwAsk && st.gwAsk.xid === xid) || !!(st.subAsk && st.subAsk.xid === xid) || !!(fun && fun.ownsXid(xid)), kfEvent, gatewayReply, sfx, state: st };
  };
})();
