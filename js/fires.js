/* Kelly Page -- SEQ Hazard Watch page (was Fire Watch; 2026-10-18, unreleased): bushfires and road incidents near the
 * P25X repeaters, carried over P25 data, on a tactical map -- plus a simulated P25 dispatch / AVL terminal and a response
 * drill for training.
 *
 * Real: one gateway answer, KF kind 3 {op: 'fires', tr: 1} -> kind 4 {app: 'fires', t, q, f: [fires], x: {t, q, f: [[road
 * events]]} | xerr}. Fires from QFD's current bushfire incidents (dashboard qfd-fires.js, CC BY 4.0); road events from the
 * QLDTraffic API (qld-traffic.js; SEQ crashes, hazards, flooding, events, and roadworks only when they close a road;
 * CC BY 4.0 AU). Field lists in those two headers -- keep items() and SITES in step. Shown with its real bytes and size.
 * Simulated (badged SIMULATED / PRACTICE everywhere): the P25 dispatch + AVL traffic (made-up club talkgroups TG 4901-4903
 * and SIM units driving out from the nearest repeater -- nothing real is intercepted or decoded) and the drill's practice
 * incidents. Never an official warning service: the page points to QFD and QLDTraffic for that.
 *
 * Tabs (data-tabs="fires"): map (Leaflet, layers, dispatch panel, sim units), stream (AVL terminal, real data path,
 * lamps), arcade (3-step response drill, badges, XP). Animations run once or 3 times, never forever; a sim unit drives
 * for a few seconds then parks and is removed (kelly-page/CLAUDE.md "Flashy, but nothing loops forever").
 *
 * window.KellyFiresUI(ctx) -> { init, render, shown, gatewayReply, ownsXid, kfEvent }; ctx from app.js.
 */
(function () {
  'use strict';
  const ANSWER_MS = 90000;
  // = SITES in the dashboard's qfd-fires.js (approximate site positions)
  const SITES = [
    { c: 'VK4RBX', n: 'Ipswich', la: -27.5876, lo: 152.7553, seq: 1 }, { c: 'VK4RMC', n: 'Mt Coot-tha', la: -27.4776, lo: 152.9442, seq: 1 },
    { c: 'VK4RES', n: 'Mt Glorious', la: -27.3303, lo: 152.7614, seq: 1 }, { c: 'VK4RGX', n: 'Springbrook', la: -28.2340, lo: 153.2730, seq: 1 },
    { c: 'VK4RTQ', n: 'Toowoomba', la: -27.5598, lo: 151.9507, seq: 1 }, { c: 'VK4RET', n: 'Bunya Mountains', la: -26.87, lo: 151.58, seq: 1 },
    { c: 'VK4RAR', n: 'Rockhampton', la: -23.38, lo: 150.51 }, { c: 'VK4RSA', n: 'Sarina', la: -21.42, lo: 149.22 },
  ];
  const LEVEL = ['Information', 'Advice', 'Watch and Act', 'Emergency Warning'];
  const FKIND = { V: 'Vegetation fire', B: 'Permitted burn', S: 'Structure fire', O: 'Fire' };
  // road event kinds (qld-traffic.js): icon, words, marker class
  const RKIND = { C: ['💥', 'Crash', 'crit'], F: ['🌊', 'Flooding', 'flood'], H: ['⚠️', 'Hazard', 'warn'], R: ['⛔', 'Road closure', 'crit'], S: ['🎪', 'Special event', 'info'], G: ['🚗', 'Congestion', 'warn'] };
  const TGS = [{ id: 4901, n: 'P25X FIRE WATCH' }, { id: 4902, n: 'P25X ROADWATCH' }, { id: 4903, n: 'P25X FLOODWATCH' }];   // SIMULATED talkgroups
  const tgFor = it => (it.src === 'fire' ? TGS[0] : it.kind === 'F' ? TGS[2] : TGS[1]);
  // Real answers, 2026-10-18 ~18:00 (fires from QFD at 17:35, road events from QLDTraffic at 18:04) -- the demo radio "receives" these
  const DEMO = { t: '2026-10-18T17:35:59+10:00', q: 30, f: [{ i: 'QF6-26-140140', k: 'V', l: 0, s: 'Patrolled', n: 'Woodridge', la: -27.6338, lo: 153.0956, t: '2026-10-15T01:13', v: [0, 0, 0], seq: 1 }],
    x: { t: '2026-10-18T18:04', q: 123, f: [[811011, 'F', 'Long-term flooding', 2, 'All lanes affected', 'Warrill View Peak Crossi', 'Harrisville', -27.814, 152.6856, '10-18T09:38'],
      [717127, 'F', 'Flash flooding', 1, 'Road closed to all traff', 'Dugandan Road', 'Bunya', -27.3549, 152.9481, '05-29T11:40'],
      [739629, 'H', 'Road damage', 2, 'All lanes affected', 'Rosewood Marburg Road', 'Rosewood / Tallegalla', -27.6062, 152.575, '09-29T20:37'],
      [835037, 'H', 'Stationary vehicle', 1, 'Lane or lanes reduced', 'Bradfield Highway', 'Kangaroo Point', -27.4649, 153.0357, '10-18T18:04'],
      [811017, 'H', 'Road damage', 1, 'All lanes affected', 'Allora Road', 'Allora', -28.0513, 151.9764, '10-18T13:33'],
      [714295, 'H', 'Road damage', 1, 'Partial lane closures', 'Tamborine Mountain Road', 'Witheren', -28.0116, 153.1761, '10-18T02:22']] } };
  // practice towns for the drill (approximate centres)
  const TOWNS = [['Beaudesert', -27.99, 152.99], ['Esk', -27.24, 152.42], ['Gatton', -27.56, 152.28], ['Caboolture', -27.08, 152.95], ['Kilcoy', -26.94, 152.56],
    ['Boonah', -28.0, 152.68], ['Redcliffe', -27.23, 153.1], ['Logan Village', -27.77, 153.11], ['Nerang', -27.99, 153.33], ['Tamborine Mtn', -27.92, 153.19],
    ['Crows Nest', -27.26, 152.05], ['Dayboro', -27.2, 152.82], ['Samford', -27.37, 152.88], ['Laidley', -27.63, 152.39], ['Jimboomba', -27.83, 153.03],
    ['Canungra', -28.02, 153.16], ['Nanango', -26.67, 151.99], ['Kingaroy', -26.54, 151.84], ['Dalby', -27.18, 151.26], ['Pittsworth', -27.72, 151.63],
    ['Highfields', -27.46, 151.95], ['Woodford', -26.95, 152.78], ['Mudgeeraba', -28.08, 153.36], ['Rosewood', -27.64, 152.59], ['Toogoolawah', -27.09, 152.38],
    ['Yarraman', -26.84, 151.98], ['Lowood', -27.47, 152.58], ['Kenilworth', -26.6, 152.73], ['Rathdowney', -28.21, 152.86], ['Oakey', -27.43, 151.72]];
  const BADGES = [
    ['first_ack', '🚨', 'Alert Acknowledged', 'Acknowledge a live incident alert'],
    ['fast_ack', '⚡', 'Quick on the Button', 'Acknowledge an alert within 10 s'],
    ['over_air', '📻', 'Over the Air', 'Receive the hazard list over P25'],
    ['roads', '🛣️', 'Roads Watcher', 'Get road events from QLDTraffic'],
    ['quiet', '🌿', 'All Quiet', 'Check in on a day with no SEQ fires'],
    ['dispatch', '📡', 'Dispatcher', 'Play out a dispatch from the map'],
    ['drill', '🎯', 'Drill Complete', 'Finish a response drill'],
    ['perfect', '🏆', 'Perfect Drill', 'Every tower and talkgroup right'],
    ['speed', '🏎️', 'Speed Dispatcher', 'Average under 5 s a round'],
    ['streak', '🔥', 'Hot Streak', '5 perfect rounds in a row'],
    ['towers', '🗼', 'Know Your Towers', 'Route to all six SEQ repeaters'],
    ['tg', '🎚️', 'Right Channel', 'Pick the right talkgroup 25 times'],
    ['watch', '👁️', 'On Watch', 'Keep a fresh hazard list for an hour'],
    ['night', '🌙', 'Night Shift', 'Run a drill between 10 pm and 5 am'],
  ];
  const RANKS = [[0, 'Probationary Dispatcher'], [400, 'Dispatcher'], [1200, 'Senior Dispatcher'], [3000, 'Shift Supervisor'], [6000, 'Comms Centre Legend']];
  const km = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
  const nearest = (la, lo, list = SITES) => list.map(s => ({ s, d: km(la, lo, s.la, s.lo) })).sort((a, b) => a.d - b.d)[0];

  window.KellyFiresUI = function (k) {
    const { $, esc, store, toast, dirty, settings, saveSoon, fmtAgo } = k;
    const S = { d: store.get('fires', null), hex: store.get('firesHex', null), ask: null, err: '', seen: new Set(store.get('firesSeen', [])), alert: null,
      map: null, layers: null, stream: [], streamQ: [], streamT: 0, timer: 0, askN: 0, okN: 0, drill: null, sel: null, seenOnce: false };
    const Q = Object.assign({ xp: 0, best: 0, badges: {}, towers: {}, watchMin: 0, tgOk: 0, times: [] }, store.get('fireQuest', {}));
    const saveQ = () => store.set('fireQuest', Q);
    const every = () => (settings.firesEvery == null ? 5 : +settings.firesEvery);
    const region = () => settings.firesRegion || 'seq';
    const layer = () => Object.assign({ fire: true, road: true }, settings.firesLayers || {});
    const onPage = () => k.currentPage() === 'fires' && !document.hidden;
    const tab = () => { const b = $('[data-tabs="fires"] button.on'); return b ? b.dataset.tab : 'map'; };

    // one list of incidents from the answer: { id, src: fire|road, kind, sev 0-3, cls, icon, title, sub, extra, la, lo }
    function items(d = S.d) {
      if (!d) return [];
      const L = layer(), out = [];
      if (L.fire) for (const x of d.f || []) if (region() === 'all' || x.seq) out.push({ id: 'F' + x.i, src: 'fire', kind: x.k, sev: x.l, cls: 'fire l' + x.l + (x.k === 'B' ? ' kB' : ''), icon: '🔥', title: x.n, sub: `${FKIND[x.k] || 'Fire'} · ${x.s} · ${LEVEL[x.l]}`, extra: `🚒 ${x.v[0]} assigned, ${x.v[2]} on scene${x.w ? ' · ' + x.w : ''}`, la: x.la, lo: x.lo, when: x.t, seq: x.seq });
      if (L.road && d.x) for (const [i, e, st, p, im, rd, loc, la, lo, u] of d.x.f || []) {
        const rk = RKIND[e] || RKIND.H, sev = e === 'C' ? 2 + (p > 1) : e === 'R' || /closed/i.test(im) ? 2 : p;
        out.push({ id: 'T' + i, src: 'road', kind: e, sev, cls: 'road ' + rk[2], icon: rk[0], title: `${rd || st}${loc ? ', ' + loc : ''}`, sub: `${rk[1]} · ${st} · ${im}`, extra: `Priority ${['low', 'medium', 'high'][p] || 'low'}`, la, lo, when: u, seq: 1 });
      }
      return out.sort((a, b) => b.sev - a.sev);
    }

    // ------------------------------------------------------------ sound (synth, one-shot)
    const clicked = () => !navigator.userActivation || navigator.userActivation.hasBeenActive;
    function snd(kind) {
      if (settings.firesSfx === false || !clicked() || !onPage()) return;
      let c; try { c = k.audioCtx(); } catch { return; }
      const t0 = c.currentTime + 0.01, vol = (settings.soundVol == null ? 0.8 : +settings.soundVol) * 0.5;
      const tone = (f, t, d, type = 'square', g = 0.12, f2) => { const o = c.createOscillator(), a = c.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d); a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(g * vol + 0.0001, t + 0.01); a.gain.exponentialRampToValueAtTime(0.0001, t + d); o.connect(a).connect(c.destination); o.start(t); o.stop(t + d + 0.05); };
      const hiss = (t, d, g = 0.15, f = 3000) => { const b = c.createBuffer(1, Math.ceil(c.sampleRate * d), c.sampleRate), x = b.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1; const s = c.createBufferSource(), fl = c.createBiquadFilter(), a = c.createGain(); s.buffer = b; fl.type = 'bandpass'; fl.frequency.value = f; fl.Q.value = 0.7; a.gain.setValueAtTime(g * vol, t); a.gain.exponentialRampToValueAtTime(0.0001, t + d); s.connect(fl).connect(a).connect(c.destination); s.start(t); };
      if (kind === 'alarm') for (let i = 0; i < 3; i++) { tone(1046, t0 + i * 0.42, 0.18); tone(784, t0 + i * 0.42 + 0.2, 0.18); }
      else if (kind === 'siren') for (let i = 0; i < 2; i++) { tone(650, t0 + i * 1.1, 0.55, 'sawtooth', 0.07, 1300); tone(1300, t0 + i * 1.1 + 0.55, 0.55, 'sawtooth', 0.07, 650); }
      else if (kind === 'squelch') { hiss(t0, 0.22, 0.18); tone(1800, t0 + 0.22, 0.03, 'square', 0.08); }   // chhh-kht
      else if (kind === 'blip') tone(1320, t0, 0.12, 'sine', 0.14, 990);
      else if (kind === 'key') tone(2000, t0, 0.02, 'square', 0.03);
      else if (kind === 'good') { tone(880, t0, 0.08); tone(1320, t0 + 0.09, 0.14); }
      else if (kind === 'bad') { tone(220, t0, 0.18, 'sawtooth', 0.1); tone(180, t0 + 0.2, 0.22, 'sawtooth', 0.1); }
      else if (kind === 'badge') [784, 988, 1175, 1568].forEach((f, i) => tone(f, t0 + i * 0.09, i === 3 ? 0.4 : 0.1));
    }
    function badge(id) {
      if (Q.badges[id]) return;
      const b = BADGES.find(x => x[0] === id); if (!b) return;
      Q.badges[id] = Date.now(); Q.xp += 100; saveQ(); snd('badge');
      const pop = $('#fw-pop'); if (pop) { pop.innerHTML = `<div class="fw-badge-pop"><b>${b[1]}</b><span>BADGE UNLOCKED</span><strong>${esc(b[2])}</strong><small>${esc(b[3])} · +100 XP</small></div>`; pop.hidden = false; clearTimeout(S.popT); S.popT = setTimeout(() => { pop.hidden = true; }, 3500); }
      dirty('fires');
    }

    // ------------------------------------------------------------ asking the gateway (= dams.js)
    async function ask(auto) {
      if (S.ask) return;
      if (auto && !k.demo() && (!k.radioConnected() || k.rfBusy())) return;   // busy: autoTick tries again soon
      S.err = ''; S.askN++;
      if (k.demo()) {
        const xid = -Date.now(); S.ask = { xid, at: Date.now(), demo: true, auto };
        setTimeout(() => { if (S.ask && S.ask.xid === xid) gatewayReply({ app: 'fires', at: Date.now(), ...JSON.parse(JSON.stringify(DEMO)) }, null); }, 1800);
        dirty('fires'); return;
      }
      if (!k.radioConnected()) { S.err = 'Offline -- connect the radio to ask the P25X gateway'; dirty('fires'); return; }
      S.ask = { xid: 0, at: Date.now(), auto };
      const xid = await k.kfRequest({ op: 'fires', tr: 1 }, 'SEQ Hazard Watch');
      S.ask = xid ? { xid, at: Date.now(), auto } : null;
      if (!xid && !auto) S.err = 'The radio is busy -- try again in a moment';
      dirty('fires');
    }
    function kfEvent(e) {
      if (!S.ask) return;
      if (e.kind === 'tx-done') { const xid = S.ask.xid; S.ask.phase = 'gateway'; setTimeout(() => { if (S.ask && S.ask.xid === xid && !k.rfRx()) { S.ask = null; S.err = 'The gateway took the request but never answered -- press Refresh'; dirty('fires'); } }, ANSWER_MS); }
      else if (e.kind === 'tx-failed') { S.err = e.cancelled ? '' : 'No answer from the P25X gateway -- press Refresh'; S.ask = null; }
      dirty('fires');
    }
    function gatewayReply(j, r) {
      const a = S.ask; S.ask = null;
      if (j.error) { S.err = j.error; if (!(a && a.auto)) toast('🚨', 'SEQ Hazard Watch', j.error, 'bad'); dirty('fires'); return; }
      S.okN++;
      S.d = { ...j, got: Date.now(), air: { bytes: r && r.data ? r.data.length : 0, secs: a && !a.demo ? (Date.now() - a.at) / 1000 : null } };
      if (r && r.data) { S.hex = Array.from(r.data, b => b.toString(16).padStart(2, '0')).join(''); store.set('firesHex', S.hex); badge('over_air'); k.addEvent('data', `Hazard Watch over P25: ${j.f.length} fire(s), ${j.x ? j.x.f.length : 0} road event(s), ${r.data.length} B`); }
      store.set('fires', S.d); S.err = j.xerr || '';
      if (j.x) badge('roads');
      if (!(j.f || []).some(x => x.seq)) badge('quiet');
      const fresh = items().filter(x => !S.seen.has(x.id));
      fresh.forEach(x => S.seen.add(x.id)); store.set('firesSeen', [...S.seen].slice(-500));
      sweep();
      const loud = fresh.filter(x => x.sev >= 2);
      if (loud.length && S.seenOnce) { S.alert = { list: loud, at: Date.now() }; snd(loud.some(x => x.kind === 'C') ? 'siren' : 'alarm'); }
      S.seenOnce = true;
      drawMap(fresh.map(x => x.id));
      dirty('fires');
    }
    function autoTick() {
      clearTimeout(S.timer); S.timer = 0;
      if (k.currentPage() !== 'fires') return;
      if (every() && (!S.d || Date.now() - S.d.got >= every() * 60000 - 5000)) ask(true);
      if (S.d && Date.now() - S.d.got < 600000) { Q.watchMin += 0.5; if (Q.watchMin >= 60) badge('watch'); saveQ(); }
      S.timer = setTimeout(autoTick, S.d ? 30000 : 5000);   // no list yet: keep trying every 5 s
      dirty('fires');
    }

    // ------------------------------------------------------------ map
    function initMap() {
      if (S.map || !window.L) return;
      const L = window.L;
      S.map = L.map('fw-map', { zoomControl: true, attributionControl: true }).setView([-27.5, 152.75], 8);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Tiles &copy; Esri · fires &copy; State of Queensland (QFD) · road events &copy; State of Queensland (TMR) QLDTraffic, CC BY 4.0', maxZoom: 15 }).addTo(S.map);
      S.layers = { towers: L.layerGroup().addTo(S.map), inc: L.layerGroup().addTo(S.map), units: L.layerGroup().addTo(S.map) };
      for (const s of SITES) {
        L.circle([s.la, s.lo], { radius: 40000, color: '#00e5ff', weight: 1, opacity: 0.35, fillOpacity: 0.03, interactive: false }).addTo(S.layers.towers);
        L.marker([s.la, s.lo], { icon: L.divIcon({ className: 'fw-tower', html: `<b>📡</b><span>${s.c}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }), title: `${s.c} ${s.n}` }).addTo(S.layers.towers);
      }
      drawMap([]);
    }
    function drawMap(fresh) {
      if (!S.map) return;
      const L = window.L; S.layers.inc.clearLayers();
      for (const it of items()) {
        const m = L.marker([it.la, it.lo], { icon: L.divIcon({ className: `fw-inc ${it.cls} ${fresh.includes(it.id) ? 'new' : ''} ${S.sel === it.id ? 'sel' : ''}`, html: `<i></i><b>${it.icon}</b>`, iconSize: [34, 34], iconAnchor: [17, 17] }), title: it.title });
        m.on('click', () => pick(it.id));
        m.addTo(S.layers.inc);
      }
    }
    function sweep() {
      const el = $('#fw-sweep'); if (!el || !document.body.classList.contains('fx')) return;
      el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); snd('blip');
    }
    function pick(id) {
      S.sel = id; const it = items().find(x => x.id === id);
      if (it && S.map) S.map.flyTo([it.la, it.lo], Math.max(S.map.getZoom(), 10), { duration: 0.8 });
      drawMap([]); dirty('fires');
    }

    // ------------------------------------------------------------ simulated dispatch + AVL (training only)
    const UNIT = { fire: 'SIM-FIRE', C: 'SIM-TOW', R: 'SIM-TC', F: 'SIM-RSA', H: 'SIM-RSA', S: 'SIM-TC', G: 'SIM-TC' };
    function dispatch(it) {
      const nr = nearest(it.la, it.lo), tg = tgFor(it), unit = `${UNIT[it.src === 'fire' ? 'fire' : it.kind] || 'SIM-RSA'}-${String(1 + (it.id.length * 7 + it.title.length) % 20).padStart(2, '0')}`;
      const steps = 5, pos = f => [nr.s.la + (it.la - nr.s.la) * f, nr.s.lo + (it.lo - nr.s.lo) * f];
      const rows = [['TSBK', `GRP_V_CH_GRANT  TG ${tg.id} ${tg.n} (SIM)  SRC GATEWAY  SITE ${nr.s.c}`],
        ['VOICE', `GATEWAY: ${it.sub.toUpperCase()} -- ${it.title.toUpperCase()}`],
        ['SDM', `GATEWAY -> ${unit}  "DISPATCH ${it.la.toFixed(4)},${it.lo.toFixed(4)}"`],
        ['STATUS', `${unit} -> GATEWAY  "EN ROUTE"  TG ${tg.id}`]];
      for (let s = 1; s <= steps; s++) { const [la, lo] = pos(s / steps); rows.push(['AVL', `${unit}  LRRP ${la.toFixed(4)}, ${lo.toFixed(4)}  ${(nr.d * (1 - s / steps)).toFixed(1)} KM TO GO  EMERG 0`]); }
      rows.push(['STATUS', `${unit} -> GATEWAY  "ON SCENE"  TG ${tg.id}`]);
      if (it.src === 'road' && /lane|clos/i.test(it.sub)) rows.push(['SDM', `${unit} -> GATEWAY  "${/clos/i.test(it.sub) ? 'ROAD CLOSED -- DIVERSION SET' : 'LANE BLOCKED -- TRAFFIC CONTROL'}"`]);
      rows.push(['TSBK', `CALL_TERM  TG ${tg.id}  (squelch tail)`]);
      rows.forEach(([type, text], i) => S.streamQ.push({ type, text, last: i === rows.length - 1 }));
      pumpStream();
      driveUnit(unit, nr.s, it, rows.length * 650);
      badge('dispatch');
    }
    function pumpStream() {
      if (S.streamT || !S.streamQ.length) return;
      const r = S.streamQ.shift();
      r.ts = Date.now(); r.at = new Date().toLocaleTimeString([], { hour12: false });
      S.stream.unshift(r); if (S.stream.length > 80) S.stream.pop();
      snd('key'); if (r.last) setTimeout(() => snd('squelch'), 300);
      dirty('fires');
      S.streamT = setTimeout(() => { S.streamT = 0; pumpStream(); }, r.last ? 1400 : 650);
    }
    // a SIM unit drives from the tower to the incident over `ms`, parks 6 s, then is removed (no endless motion)
    function driveUnit(name, from, to, ms) {
      if (!S.map) return;
      const L = window.L, m = L.marker([from.la, from.lo], { icon: L.divIcon({ className: 'fw-unit', html: `<b>🚙</b><span>${name}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 800 }).addTo(S.layers.units);
      const line = L.polyline([[from.la, from.lo], [to.la, to.lo]], { color: '#39ff88', weight: 2, dashArray: '5 6', opacity: 0.7, interactive: false }).addTo(S.layers.units);
      const t0 = performance.now(), step = t => { const f = Math.min(1, (t - t0) / ms); m.setLatLng([from.la + (to.la - from.la) * f, from.lo + (to.lo - from.lo) * f]); if (f < 1) requestAnimationFrame(step); else setTimeout(() => { S.layers.units.removeLayer(m); S.layers.units.removeLayer(line); }, 6000); };
      requestAnimationFrame(step);
    }

    // ------------------------------------------------------------ response drill: tower -> talkgroup -> broadcast
    const DRILL_N = 8, DRILL_S = 15, SEQ_SITES = SITES.filter(s => s.seq);
    function drillStart() {
      const live = items().filter(x => x.seq).slice(0, 3).map(x => ({ ...x, live: true }));
      const kinds = [['fire', 'V', '🔥', 'Grass fire'], ['road', 'C', '💥', 'Crash'], ['road', 'F', '🌊', 'Flooded road'], ['road', 'H', '⚠️', 'Debris on road'], ['road', 'R', '⛔', 'Road closed']];
      const pool = TOWNS.slice().sort(() => Math.random() - 0.5).map(([n, la, lo]) => { const [src, kind, icon, what] = kinds[Math.floor(Math.random() * kinds.length)]; return { src, kind, icon, title: `${what}, ${n}`, la: la + (Math.random() - 0.5) * 0.06, lo: lo + (Math.random() - 0.5) * 0.06 }; });
      S.drill = { list: live.concat(pool).slice(0, DRILL_N), i: 0, score: 0, perfect: 0, streak: 0, times: [], done: false };
      drillNext(); snd('blip');
    }
    function drillNext() {
      const d = S.drill; d.step = 'tower'; d.pickT = null; d.pickG = null; d.res = null;
      if (d.i >= d.list.length) return drillEnd();
      d.at = Date.now(); clearTimeout(d.t); d.t = setTimeout(() => drillFinish(true), DRILL_S * 1000);
      dirty('fires');
    }
    function drillTower(code) { const d = S.drill; if (!d || d.done || d.res || d.step !== 'tower') return; d.pickT = code; d.step = 'tg'; snd('key'); dirty('fires'); }
    function drillTg(id) { const d = S.drill; if (!d || d.done || d.res || d.step !== 'tg') return; d.pickG = id; d.step = 'send'; snd('key'); dirty('fires'); }
    function drillFinish(timeout) {
      const d = S.drill; if (!d || d.done || d.res) return;
      clearTimeout(d.t);
      const inc = d.list[d.i], nr = nearest(inc.la, inc.lo, SEQ_SITES), tg = tgFor(inc), secs = (Date.now() - d.at) / 1000;
      const okT = d.pickT === nr.s.c, okG = d.pickG === tg.id, sent = !timeout && d.step === 'send';
      let pts = 0;
      if (sent) { pts = (okT ? 100 : 0) + (okG ? 60 : 0) + Math.round(Math.max(0, DRILL_S - secs) * 10); if (okT && okG) { d.perfect++; d.streak++; pts = Math.round(pts * (1 + Math.min(d.streak - 1, 4) * 0.2)); } else d.streak = 0; d.times.push(secs); }
      else d.streak = 0;
      if (okT) Q.towers[nr.s.c] = 1;
      if (okG) Q.tgOk++;
      d.score += pts; d.res = { okT, okG, sent, pts, nr, tg };
      snd(sent && okT && okG ? 'good' : 'bad'); if (sent) setTimeout(() => snd('squelch'), 200);
      if (d.streak >= 5) badge('streak');
      if (SEQ_SITES.every(s => Q.towers[s.c])) badge('towers');
      if (Q.tgOk >= 25) badge('tg');
      saveQ(); dirty('fires');
      setTimeout(() => { if (S.drill === d) { d.i++; drillNext(); } }, 2200);
    }
    function drillEnd() {
      const d = S.drill; d.done = true;
      const avg = d.times.length ? d.times.reduce((a, b) => a + b, 0) / d.times.length : 99;
      Q.xp += Math.round(d.score / 5); if (d.score > Q.best) Q.best = d.score;
      if (d.times.length) Q.times = (Q.times || []).concat(avg).slice(-20);
      saveQ();
      badge('drill'); if (d.perfect === d.list.length) badge('perfect'); if (d.perfect >= 4 && avg < 5) badge('speed');
      const h = new Date().getHours(); if (h >= 22 || h < 5) badge('night');
      snd('badge'); dirty('fires');
    }
    const PX = lo => ((lo - 151.2) / 2.4) * 600, PY = la => ((-26.4 - la) / 2.0) * 500;   // SEQ in a 600 x 500 SVG
    function drillSvg() {
      const d = S.drill, inc = d && !d.done ? d.list[d.i] : null;
      let s = `<svg class="fw-drill-map" viewBox="0 0 600 500"><rect width="600" height="500" rx="14" class="bg"/>`;
      for (let g = 1; g < 6; g++) s += `<line x1="${g * 100}" y1="0" x2="${g * 100}" y2="500" class="grid"/><line x1="0" y1="${g * 100}" x2="600" y2="${g * 100}" class="grid"/>`;
      if (inc && d.res) s += `<line x1="${PX(inc.lo)}" y1="${PY(inc.la)}" x2="${PX(d.res.nr.s.lo)}" y2="${PY(d.res.nr.s.la)}" class="route ${d.res.okT ? 'ok' : 'bad'}"/>`;
      for (const t of SEQ_SITES) s += `<g class="tw ${d && d.res && d.res.nr.s.c === t.c ? 'right' : ''} ${d && d.res && d.pickT === t.c && !d.res.okT ? 'wrong' : ''} ${d && !d.res && d.pickT === t.c ? 'picked' : ''}" data-tw="${t.c}" tabindex="0"><circle cx="${PX(t.lo)}" cy="${PY(t.la)}" r="16"/><text x="${PX(t.lo)}" y="${PY(t.la) + 4}" text-anchor="middle">📡</text><text class="lab" x="${PX(t.lo)}" y="${PY(t.la) + 32}" text-anchor="middle">${t.c}</text></g>`;
      if (inc) s += `<g class="inc ${inc.live ? 'live' : ''}" ${d.res ? '' : 'data-ping="1"'}><circle class="ring" cx="${PX(inc.lo)}" cy="${PY(inc.la)}" r="10"/><text x="${PX(inc.lo)}" y="${PY(inc.la) + 6}" text-anchor="middle">${inc.icon}</text><text class="lab" x="${PX(inc.lo)}" y="${PY(inc.la) - 16}" text-anchor="middle">${esc(inc.title)}${inc.live ? ' (LIVE)' : ''}</text></g>`;
      return s + '</svg>';
    }

    // ------------------------------------------------------------ rendering
    function render() {
      const d = S.d;
      $('#fw-when').textContent = d ? `QFD ${d.t ? new Date(d.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?'}${d.x ? ` · QLDTraffic ${d.x.t ? d.x.t.slice(11, 16) : '?'}` : ''} · received ${fmtAgo(d.got)}${d.stale ? ' · STALE' : ''}` : '';
      $('#fw-phase').textContent = S.ask ? (S.ask.phase === 'gateway' ? 'Gateway fetching…' : 'Asking over P25…') : '';
      const e = $('#fw-err'); e.hidden = !S.err; e.textContent = S.err;
      $('#fw-region').value = region(); $('#fw-every').value = String(every()); $('#fw-sfx').checked = settings.firesSfx !== false;
      $('#fw-lay-fire').checked = layer().fire; $('#fw-lay-road').checked = layer().road;
      const al = $('#fw-alert');
      if (S.alert) { const left = Math.max(0, 30 - (Date.now() - S.alert.at) / 1000); al.hidden = false; al.innerHTML = `<b>🚨 NEW INCIDENT${S.alert.list.length > 1 ? 'S' : ''}</b> ${S.alert.list.slice(0, 3).map(x => `${x.icon} ${esc(x.title)}`).join(' · ')} <button class="btn small primary" id="fw-ack">ACK ${left > 0 ? Math.ceil(left) + ' s' : ''}</button>`; }
      else al.hidden = true;
      const t = tab();
      if (t === 'map') renderMap(); else if (t === 'stream') renderStream(); else renderArcade();
    }
    function renderMap() {
      if (!S.map) { initMap(); setTimeout(() => S.map && S.map.invalidateSize(), 50); }
      const all = items(), d = S.d, x = d && d.x ? d.x.f : [];
      const fires = all.filter(i => i.src === 'fire').length, roads = all.filter(i => i.src === 'road' && 'CHG'.includes(i.kind)).length;
      const closed = x.filter(r => r[1] === 'R' || /closed/i.test(r[4])).length, flood = x.filter(r => r[1] === 'F').length;
      const avg = Q.times && Q.times.length ? Q.times.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, Q.times.length) : null;
      $('#fw-cards').innerHTML = [['🔥', 'Fires', fires, fires ? 'warm' : 'calm'], ['💥', 'Road incidents', roads, roads ? 'warm' : 'calm'], ['⛔', 'Closures', closed, closed ? 'hot' : 'calm'], ['🌊', 'Flooded roads', flood, flood ? 'flood' : 'calm'], ['⏱️', 'Your avg response', avg == null ? '--' : avg.toFixed(1) + ' s', 'calm']]
        .map(([i, n, v, c]) => `<div class="fw-card ${c}"><span>${i} ${n}</span><b>${v}</b></div>`).join('');
      $('#fw-list').innerHTML = all.map(it => { const nr = nearest(it.la, it.lo); return `<li class="sev${it.sev} ${it.src} ${S.sel === it.id ? 'sel' : ''}" data-i="${esc(it.id)}"><b>${it.icon} ${esc(it.title)}</b><span>${esc(it.sub)}</span><small>${esc(it.extra)} · 📡 ${nr.s.c} ${nr.d.toFixed(0)} km</small></li>`; }).join('') || `<li class="none">${d ? 'Nothing on these layers right now -- all quiet.' : 'No list yet -- press Refresh to ask the P25X gateway.'}</li>`;
      const it = all.find(i => i.id === S.sel), pn = $('#fw-dpanel');
      if (it) { const nr = nearest(it.la, it.lo), tg = tgFor(it);
        pn.innerHTML = `<div class="card-h"><h2>P25 dispatch panel</h2><span class="tag warn">SIMULATED</span></div><h3>${it.icon} ${esc(it.title)}</h3><p class="small">${esc(it.sub)}<br><span class="dim">${esc(it.extra)}${it.when ? ' · updated ' + esc(it.when.replace('T', ' ')) : ''}</span></p>
          <p class="small">Nearest P25X repeater <b>${nr.s.c}</b> (${nr.d.toFixed(0)} km) · talkgroup <b>TG ${tg.id} ${tg.n}</b> (SIM)</p>
          <button class="btn primary" id="fw-dispatch">▶ Play out the dispatch</button> <span class="dim small">A SIM unit drives out on the map and its AVL packets scroll on the P25 Radio &amp; AVL tab.</span>`; }
      else pn.innerHTML = '<p class="dim small">Click an incident on the map or in the list to open its P25 dispatch panel.</p>';
    }
    function renderStream() {
      $('#fw-stream').innerHTML = S.stream.map((r, i) => `<li class="${r.type.toLowerCase()} ${i === 0 ? 'type' : ''}"><time>${r.at}</time><span class="nac">NAC 0x293</span><b>${r.type}</b><code>${esc(r.text)}</code></li>`).join('') || '<li class="dim">Nothing yet -- open an incident on the map and press Play out the dispatch.</li>';
      const d = S.d, rssi = k.rssi && k.rssi(), fresh = d && Date.now() - d.got < every() * 120000 + 60000;
      $('#fw-path').innerHTML = d ? `<div class="fw-kv"><span>Answer</span><b>${d.air && d.air.bytes ? d.air.bytes + ' B' : 'demo'}</b></div><div class="fw-kv"><span>Round trip</span><b>${d.air && d.air.secs ? d.air.secs.toFixed(1) + ' s' : '--'}</b></div><div class="fw-kv"><span>Fires / road</span><b>${(d.f || []).length} / ${d.x ? d.x.f.length : 0}</b></div><div class="fw-kv"><span>Answers / asks</span><b>${S.okN} / ${S.askN}</b></div>` : '<p class="dim">No answer yet.</p>';
      $('#fw-hex').textContent = S.hex ? S.hex.match(/.{1,2}/g).join(' ') : '(the demo radio has no bytes -- connect a radio to see the real answer as it crossed the air)';
      const pct = rssi == null ? 0 : Math.max(0, Math.min(100, (rssi + 125) * 2)), perMin = S.stream.filter(r => Date.now() - r.ts < 60000).length;
      $('#fw-lamps').innerHTML = [['Gateway link', fresh ? 'ok' : d ? 'warn' : 'off', 'REAL'], ['Radio signal', rssi == null ? 'off' : rssi > -100 ? 'ok' : rssi > -112 ? 'warn' : 'bad', 'REAL'], ['Sim units on air', S.streamQ.length || S.streamT ? 'ok' : 'off', 'SIM'], [`Sim packets / min: ${perMin}`, perMin ? 'ok' : 'off', 'SIM']]
        .map(([n, st, tag]) => `<div class="fw-lamp ${st}"><i></i><span>${esc(n)}</span><small>${tag}</small></div>`).join('');
      $('#fw-rssi').innerHTML = `<div class="fw-meter"><i style="width:${pct}%"></i></div><b>${rssi == null ? 'no reading' : rssi + ' dBm'}</b><small>this radio's received signal (CCDI, real)</small>`;
    }
    function renderArcade() {
      const d = S.drill, r = RANKS.reduce((a, x) => (Q.xp >= x[0] ? x : a), RANKS[0]), nx = RANKS.find(x => x[0] > Q.xp);
      $('#fw-rank').innerHTML = `<b>${esc(r[1])}</b><span class="fw-xp"><i style="width:${nx ? Math.round(100 * (Q.xp - r[0]) / (nx[0] - r[0])) : 100}%"></i></span><small>${Q.xp} XP · best drill ${Q.best} · ${Object.keys(Q.badges).length}/${BADGES.length} badges</small>`;
      $('#fw-badges').innerHTML = BADGES.map(([id, ic, name, how]) => `<div class="fw-b ${Q.badges[id] ? 'got' : ''}" title="${esc(how)}"><b>${ic}</b><span>${esc(name)}</span><small>${esc(how)}</small></div>`).join('');
      const h = $('#fw-drill');
      if (!d) { if (h.dataset.state !== 'idle') { h.dataset.state = 'idle'; h.innerHTML = `<p>An incident pops up somewhere in SEQ. <b>1</b> pick the nearest P25X repeater, <b>2</b> pick the right talkgroup (fire, road or flood), <b>3</b> broadcast -- all inside ${DRILL_S} s. Live SEQ incidents join the drill; the rest are <b>practice</b> incidents, and the talkgroups are made up for training.</p><button class="btn primary big" id="fw-drill-go">▶ Start drill</button>`; } return; }
      h.dataset.state = 'run';
      const left = d.done ? 0 : Math.max(0, DRILL_S - (Date.now() - d.at) / 1000), inc = d.done ? null : d.list[d.i];
      // redraw only when the round or step changes -- a full redraw every tick could swallow a click mid-press
      const key = [d.i, d.step, !!d.res, d.done, d.pickT, d.pickG, d.score].join('|');
      if (h.dataset.key === key) { const tm = $('#fw-time'); if (tm) { tm.textContent = d.done ? '--' : left.toFixed(1); tm.parentNode.classList.toggle('low', left < 4); } return; }
      h.dataset.key = key;
      const steps = d.done ? '' : `<div class="fw-steps"><span class="${d.step === 'tower' ? 'on' : 'done'}">1 · Tower${d.pickT ? ' ' + d.pickT : ''}</span><span class="${d.step === 'tg' ? 'on' : d.pickG ? 'done' : ''}">2 · Talkgroup${d.pickG ? ' ' + d.pickG : ''}</span><span class="${d.step === 'send' ? 'on' : ''}">3 · Broadcast</span></div>`;
      const tgRow = !d.done && !d.res ? `<div class="fw-tgs">${TGS.map(t => `<button class="btn small ${d.pickG === t.id ? 'primary' : ''}" data-tg="${t.id}" ${d.step !== 'tg' ? 'disabled' : ''}>TG ${t.id} ${t.n}</button>`).join('')}<button class="btn primary" id="fw-bcast" ${d.step !== 'send' ? 'disabled' : ''}>📡 Broadcast</button></div>` : '';
      const res = d.res ? `<p class="fw-res ${d.res.okT && d.res.okG && d.res.sent ? 'ok' : 'bad'}">${!d.res.sent ? '⏰ Too slow -- ' : ''}${d.res.okT ? '✔' : '✖'} tower ${d.res.nr.s.c} · ${d.res.okG ? '✔' : '✖'} TG ${d.res.tg.id} ${d.res.tg.n}${d.res.pts ? ' · +' + d.res.pts : ''}</p>` : `<p class="fw-res">${inc ? `${inc.icon} ${esc(inc.title)}${inc.live ? ' (LIVE)' : ''}` : ''}</p>`;
      h.innerHTML = `<div class="fw-hud"><span>Round <b>${Math.min(d.i + 1, d.list.length)}/${d.list.length}</b></span><span>Score <b>${d.score}</b></span><span>Streak <b>${d.streak}</b></span><span class="${left < 4 ? 'low' : ''}">Time <b id="fw-time">${d.done ? '--' : left.toFixed(1)}</b></span></div>${steps}${res}${tgRow}${drillSvg()}
        ${d.done ? `<div class="fw-end"><b>DRILL COMPLETE</b><span>${d.score}</span><small>${d.perfect}/${d.list.length} perfect rounds${d.times.length ? ` · average ${(d.times.reduce((a, b) => a + b, 0) / d.times.length).toFixed(1)} s` : ''}</small><button class="btn primary" id="fw-drill-go">Again</button></div>` : ''}`;
    }

    function init() {
      $('#fw-read').onclick = () => ask(false);
      $('#fw-every').onchange = e => { settings.firesEvery = +e.target.value; saveSoon('settings'); autoTick(); };
      $('#fw-region').onchange = e => { settings.firesRegion = e.target.value; saveSoon('settings'); drawMap([]); dirty('fires'); };
      $('#fw-sfx').onchange = e => { settings.firesSfx = e.target.checked; saveSoon('settings'); };
      const lay = (id, key) => { $(id).onchange = e => { settings.firesLayers = { ...layer(), [key]: e.target.checked }; saveSoon('settings'); drawMap([]); dirty('fires'); }; };
      lay('#fw-lay-fire', 'fire'); lay('#fw-lay-road', 'road');
      $('#page-fires').addEventListener('click', e => {
        if (e.target.closest('#fw-ack')) { const left = 30 - (Date.now() - S.alert.at) / 1000; Q.xp += left > 0 ? 50 : 10; saveQ(); badge('first_ack'); if (left >= 20) badge('fast_ack'); S.alert = null; snd('good'); dirty('fires'); return; }
        if (e.target.closest('#fw-drill-go')) { $('#fw-drill').dataset.state = ''; $('#fw-drill').dataset.key = ''; drillStart(); return; }
        if (e.target.closest('#fw-dispatch')) { const it = items().find(i => i.id === S.sel); if (it) dispatch(it); return; }
        const tg = e.target.closest('[data-tg]'); if (tg) { drillTg(+tg.dataset.tg); return; }
        if (e.target.closest('#fw-bcast')) { drillFinish(false); return; }
        const tw = e.target.closest('[data-tw]'); if (tw) { drillTower(tw.dataset.tw); return; }
        const li = e.target.closest('#fw-list li[data-i]'); if (li) pick(li.dataset.i);
      });
      setInterval(() => { if (onPage() && ((S.drill && !S.drill.done) || S.alert)) dirty('fires'); if (S.alert && Date.now() - S.alert.at > 60000) S.alert = null; }, 250);
    }
    function shownPage() { setTimeout(() => { initMap(); if (S.map) S.map.invalidateSize(); }, 60); setTimeout(autoTick, 500); dirty('fires'); }
    return { init, render, shown: shownPage, gatewayReply, kfEvent, ownsXid: xid => !!(S.ask && S.ask.xid === xid) };
  };
})();
