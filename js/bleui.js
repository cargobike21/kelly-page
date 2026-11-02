/* Kelly Page -- BLE Presence page: Bluetooth LE devices around the shack -> P25 text alerts.
 *
 * The idea (2026-10-19): the operator has BLE devices around home -- a keyring beacon, a thermometer, the
 * go-box -- and gets told on P25 when one arrives, leaves, goes quiet or reads out of range. The Kelly bridge scans
 * (bridge/kelly_ble.py; --ble hci0) and streams adverts over /ble; remote scanner Pis (bridge/kelly_ble_node.py)
 * feed the same stream from other zones. Everything else is here and in js/ble.js (decoders, presence, rules,
 * airtime queue -- pure, tested in tests/ble-tests.html). Alerts go out through Kelly's own text path (ctx.sendText
 * = sendTextTo in app.js: CCDI text on a TP9400, a Kelly frame to the P25X gateway on a TM9100), one at a time,
 * paced by the airtime queue so a TM9100 isn't kept out of CCR (it can't receive while sending).
 *
 * Runs whenever settings.ble.on (the Pi keeper too: its config file carries settings.ble), draws only while the page
 * is open. Privacy: passers-by's phones and watches (rotating addresses) are counted by maker only and never stored;
 * fixed-address devices show in the Nearby list for registering, held in memory for 2 minutes. Nothing about
 * unregistered devices is saved or sent anywhere.
 *
 * window.KellyBleUI(ctx) -> { init, render, shown, onP25Text }; ctx from app.js.
 */
(function () {
  'use strict';
  const B = window.KellyBle;
  const TYPES = { person: ['🧑', 'Person'], radio: ['📻', 'Radio'], gobox: ['🧰', 'Go-box'], vehicle: ['🚗', 'Vehicle'], asset: ['🗼', 'Repeater asset'], sensor: ['🌡️', 'Sensor'], pet: ['🐾', 'Pet'], other: ['🔹', 'Other'] };
  // a pet roams to the edge of range: leave only when properly gone (10 min, below -95), and no telemetry by default
  const PET_DEFAULTS = { type: 'pet', depart: -95, absence: 600, tlm: false };
  const PRIO_LABEL = { alarm: 'Alarm', presence: 'Presence', routine: 'Routine', telem: 'Telemetry', game: 'Game' };
  const NEARBY_MS = 120000, ANON_MS = 300000;

  window.KellyBleUI = function (k) {
    const { $, esc, settings, store, toast, addEvent, dirty } = k;
    const DEF = { on: false, bridgeUrl: '', dry: false, anim: true, devices: {}, rules: {}, zones: {},
      presence: { arrive: -80, depart: -90, absenceSec: 300, debounceSec: 30, minHits: 2, zoneHystDb: 6, zoneSwitchSec: 30 },
      air: { alarmGap: 20, presenceGap: 120, routineGap: 600, hourCap: 20 },
      nodeDownMin: 10, nodeDownTo: '',
      telem: { on: false, heartbeatMin: 30, gap: 300 },   // Phase 2: readings to the P25X gateway -> MQTT -> Grafana
      snd: { on: true, vol: 0.5, ping: true, arrive: true, depart: true, tx: true, alarm: true, cw: true, cwWpm: 20, cwHz: 700, alarmsOnly: false, quiet: '' } };
    const bs = settings.ble = Object.assign({}, DEF, settings.ble || {});
    for (const g of ['presence', 'air', 'snd', 'telem']) bs[g] = Object.assign({}, DEF[g], bs[g] || {});
    for (const g of ['devices', 'rules', 'zones']) bs[g] = bs[g] || {};
    const save = () => k.saveSoon('settings');
    const hist = Object.assign({ alerts: [], air: [] }, store.get('ble', {}) || {});   // alert history + airtime log
    const saveHist = (() => { let t = 0; return () => { clearTimeout(t); t = setTimeout(() => store.set('ble', { alerts: hist.alerts.slice(-300), air: air.log().slice(-300) }), 1500); }; })();

    // ---- runtime
    const startedAt = Date.now();
    let presence = B.Presence(optFor, startedAt), rules = B.Rules(() => bs.rules, devices), registry = B.Registry(devices());
    const air = B.AirQueue(airOpts()); air.load(hist.air);
    const nearby = new Map();       // address -> { r, d, first, last, n, id }   (unregistered: memory only, 2 min)
    const anon = new Map();         // address -> { cat, last }                  (rotating: counted, never shown)
    const live = {};                // device id -> { r, d, val, last, rssi }
    const link = { ws: null, state: 'off', note: '', hello: null, retry: 0, rx: 0, since: 0 };
    let nodes = [], health = {}, sending = false, demoSim = null, demoTimer = 0, tickTimer = 0;
    const ui = { tab: 'radar', form: null, ruleForm: null, find: null, flash: new Set(), sweep: false, txAt: 0, token: null, lastNodeDown: {}, lastFrame: null };
    const tele = B.Telemetry({ heartbeatMin: +bs.telem.heartbeatMin || 30 });
    let tlmSeq = Math.floor(Math.random() * 256);

    function devices() { return k.demo() && demoSim ? Object.assign({}, demoSim.devices, bs.devices) : bs.devices; }
    function optFor(id, zone) {
      const p = bs.presence, z = (zone && bs.zones[zone]) || {}, d = devices()[id] || {};
      const o = { arrive: +p.arrive, depart: +p.depart, absenceSec: +p.absenceSec, debounceSec: +p.debounceSec, minHits: +p.minHits, zoneHystDb: +p.zoneHystDb, zoneSwitchSec: +p.zoneSwitchSec };
      for (const src of [z, d]) {
        if (src.arrive !== '' && src.arrive != null) o.arrive = +src.arrive;
        if (src.depart !== '' && src.depart != null) o.depart = +src.depart;
        if (src.absence !== '' && src.absence != null) o.absenceSec = +src.absence;
      }
      return o;
    }
    function airOpts() { const a = bs.air; return { gap: { alarm: +a.alarmGap, presence: +a.presenceGap, routine: +a.routineGap, telem: Math.max(60, +bs.telem.gap || 300) }, hourCap: +a.hourCap }; }
    function devsChanged() { registry = B.Registry(devices()); telemNumbers(); sendFilter(); save(); dirty('ble'); }
    // Telemetry sensor numbers (1-254): given once to a device sending telemetry and kept, so Grafana's history stays its own.
    function telemNumbers() {
      const used = new Set(Object.values(bs.devices).map(d => +d.tn).filter(Boolean));
      for (const [id, dv] of Object.entries(devices())) {
        if (dv.tlm && !dv.tn && bs.devices[id]) { let n = 1; while (used.has(n) && n < 254) n++; dv.tn = n; used.add(n); }
        if (dv.tn) { if (dv.tlm) tele.setName(+dv.tn, dv.type, dv.name || id); else tele.forget(+dv.tn); }
      }
    }
    const tn = id => { const dv = devices()[id]; return dv && dv.tlm && +dv.tn ? +dv.tn : 0; };
    const gatewayId = () => +settings.relayId || 5059999;
    const devName = id => (devices()[id] || {}).name || id;
    const icon = t => (TYPES[t] || TYPES.other)[0];
    // Plugins (Phase 4 js/bleinspect.js, Phase 5 js/blegames.js): window.KellyBlePlugins = [api => ({ tabs, build, render,
    // onTab, onAdv, onHci, onHello, onInspect, onPresence })]. They get the api below; the core never depends on them.
    let plugins = [];
    const hook = (name, ...a) => { for (const p of plugins) if (p[name]) { try { p[name](...a); } catch (e) { console.error('ble plugin', name, e); } } };

    // ---- the bridge link (/ble)
    function bleUrl() {
      const own = String(bs.bridgeUrl || '').trim();
      if (own) {
        let u = /^wss?:\/\//i.test(own) ? own : `ws://${own}`;
        const m = /^(wss?:\/\/[^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(u);
        return m ? (window.KellySecure ? KellySecure.wsUrl : String)(`${m[1]}/ble${m[3] || ''}`) : '';   // https page: wss://
      }
      // Served by a bridge (the Pi, start-kelly.bat): that bridge scans. Opened as a file: the radio's IP bridge, or localhost.
      const su = String(settings.url || '');
      if (/^https?:/.test(location.protocol)) {
        const tok = new URLSearchParams(location.search).get('token') || (/[?&]token=([^&#]+)/.exec(su) || [])[1];
        return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ble${tok ? '?token=' + encodeURIComponent(decodeURIComponent(tok)) : ''}`;
      }
      const u = (/^wss?:\/\//.test(su) ? su : 'ws://localhost:8025/ws').replace(/\/ws(\?|$)/, '/ble$1');
      return window.KellySecure ? KellySecure.wsUrl(u) : u;
    }
    const apiUrl = () => bleUrl().replace(/^ws/, 'http').replace(/\/ble(\?|$)/, '/api/ble-nodes$1');
    function connect() {
      clearTimeout(link.retry);
      if (!bs.on || k.demo()) return;
      const url = bleUrl(); if (!url) { link.state = 'off'; link.note = 'No bridge address'; return; }
      link.state = 'connecting'; dirty('ble');
      let ws;
      try { ws = new WebSocket(url); } catch (e) { link.state = 'down'; link.note = e.message; schedule(); return; }
      link.ws = ws;
      ws.onopen = () => { link.state = 'up'; link.note = ''; link.since = Date.now(); sendFilter(); dirty('ble'); };
      ws.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error('ble', err); } };
      ws.onclose = () => {
        if (link.ws !== ws) return;
        const was = link.state; link.ws = null; link.state = 'down';
        link.note = was === 'connecting' ? `Can't reach ${url.replace(/token=[^&]+/, 'token=…')} -- is the bridge running with --ble?` : 'The bridge link closed';
        if (was === 'up') addEvent('data', 'BLE: bridge link lost');
        schedule(); dirty('ble');
      };
    }
    function schedule() { if (bs.on) link.retry = setTimeout(connect, link.state === 'down' ? 15000 : 5000); }
    function disconnect() { clearTimeout(link.retry); if (link.ws) { const w = link.ws; link.ws = null; try { w.close(); } catch {} } link.state = 'off'; }
    function sendFilter() { if (link.ws && link.ws.readyState === 1) link.ws.send(JSON.stringify({ t: 'filter', keys: B.filterKeys(devices()) })); }
    function onMsg(m) {
      if (m.t === 'hello') { link.hello = m; nodes = m.nodes || []; health = m.health || {}; ui.sweep = true; hook('onHello', m); dirty('ble'); }
      else if (m.t === 'hci') hook('onHci', m.list || []);
      else if (m.t === 'inspect') hook('onInspect', m.state || {});
      else if (m.t === 'advs') { const now = Date.now(); for (const r of m.list || []) ingest(r, now); link.rx += (m.list || []).length; }
      else if (m.t === 'health') { const was = health[m.h.adapter]; health[m.h.adapter] = m.h; if (m.h.ok === false && (!was || was.ok !== false)) { toast('📶', `Bluetooth ${m.h.adapter} needs attention`, (m.h.fix || [])[0] || '', 'bad'); addEvent('data', `BLE: ${m.h.adapter} -- ${(m.h.fix || []).join(' ')}`); } dirty('ble'); }
      else if (m.t === 'nodes') { nodes = m.list || []; dirty('ble'); }
    }

    // ---- ingest one advert
    function ingest(r, now) {
      const d = B.decode(r), id = registry.lookup(r, d);
      if (plugins.length) hook('onAdv', r, d, id, now);
      if (id) {
        const L = live[id] = live[id] || { first: now, n: 0 };
        const fresh = !L.last || now - L.last > 60000;
        Object.assign(L, { r, d, last: now, rssi: r.r, zone: r.z }); L.n++;
        if (Object.keys(d.val).length) { L.val = Object.assign(L.val || {}, d.val); L.valAt = now; handleAlerts(rules.evaluate({ type: 'reading', id, val: d.val, t: r.ts, zone: r.z }, now)); }
        const s = tn(id);
        if (s) { for (const [f, v] of Object.entries(d.val)) tele.observe(s, f, v, r.ts); tele.observe(s, 'rssi', r.r, r.ts); }
        presence.feed({ id, zone: r.z, rssi: r.r, t: r.ts }, now).forEach(onPresence);
        // its current here/away too, not only at the moment it changes: telemetry switched on while a device is
        // already home would otherwise never report it (seen 2026-10-19). Unchanged = nothing sent (deadband 0).
        const ps = presence.get(id);
        if (s && ps && (ps.st === 'present' || ps.st === 'away')) tele.observe(s, 'present', ps.st === 'present' ? 1 : 0, now);
        if (fresh && ui.find !== id) sfx('ping');
        return;
      }
      // A beacon ID (iBeacon / Eddystone UID) is public on purpose -- e.g. a phone running a beacon app, whose own address
      // rotates: listed by that ID so it can be registered. Anything else on a rotating address is a passer-by: counted only.
      const beacon = d.ib || (d.ed && d.ed.frame === 'uid');
      if (B.rotates(d.addr) && !beacon) { anon.set(r.a, { cat: d.tag ? d.tag.name : d.company || (d.kind !== 'other' ? d.kind : 'Unknown'), tag: !!d.tag, last: now, z: r.z, r: r.r }); return; }
      const key = beacon ? B.bestKey(r, d) : r.a, n = nearby.get(key);
      if (n) { n.r = r; n.d = d; n.last = now; n.n++; }
      else nearby.set(key, { r, d, first: now, last: now, n: 1, isNew: true });
    }
    function onPresence(ev) {
      const dv = devices()[ev.id] || {}, name = dv.name || ev.id;
      if (tn(ev.id) && ev.type !== 'move') tele.observe(tn(ev.id), 'present', ev.type === 'arrive' ? 1 : 0, Date.now());
      if (!ev.quiet) {
        const txt = ev.type === 'arrive' ? `${name} arrived ${ev.zone}` : ev.type === 'depart' ? `${name} left${ev.zone ? ' ' + ev.zone : ''}` : `${name} moved ${ev.from} → ${ev.zone}`;
        addEvent('data', `BLE: ${txt}`);
        ui.flash.add(ev.id);
        if (ev.type === 'arrive') { sfx('arrive'); if (bs.snd.cw && (dv.call || '').trim()) setTimeout(() => cw(dv.call.trim()), 700); }
        else if (ev.type === 'depart') sfx('depart');
        else sfx('ping');
      }
      handleAlerts(rules.evaluate(ev, Date.now()));
      hook('onPresence', ev);
      dirty('ble');
    }
    function handleAlerts(list) {
      const now = Date.now();
      for (const a of list || []) {
        air.push(a, now);
        hist.alerts.push({ t: now, rule: a.rule, dev: a.dev, to: a.to.join(', '), text: a.text, prio: a.prio, state: 'queued', esc: a.esc || 0 });
        if (a.prio === 'alarm') { sfx('alarm-critical'); toast('🚨', 'BLE alarm', a.text, 'bad'); } else sfx('alarm-info');
      }
      if (list && list.length) { while (hist.alerts.length > 300) hist.alerts.shift(); saveHist(); dirty('ble'); }
    }

    // ---- once a second: departures, not-seen rules, escalations, node checks, the airtime queue
    function zoneClock(z) {
      if (!z) return null;
      const n = nodes.find(x => x.zone === z);
      if (!n) return Date.now();                       // the bridge's own adapter (or the demo)
      return n.clock || null;                          // a remote zone: as far as its data reaches
    }
    function tick() {
      const now = Date.now();
      presence.tick(now, zoneClock, Object.keys(devices())).forEach(onPresence);
      handleAlerts(rules.tick(now, id => presence.get(id) || null, startedAt));
      for (const [a, n] of nearby) if (now - n.last > NEARBY_MS) nearby.delete(a);
      for (const [a, n] of anon) if (now - n.last > ANON_MS) anon.delete(a);
      checkNodes(now);
      if (ui.find) findClick(now);
      if (telemReady() && !air.queue().some(x => x.prio === 'telem') && tele.due(now)) air.push({ to: [gatewayId()], text: 'BLE telemetry', prio: 'telem' }, now);
      if (!sending) {
        const x = air.next(now);
        if (x) transmit(x);
      }
      if (k.currentPage() === 'ble') dirty('ble');
    }
    function checkNodes(now) {
      const to = B.units(bs.nodeDownTo), min = +bs.nodeDownMin || 0;
      for (const n of nodes) {
        const down = !n.up && n.lastHb && now - n.lastHb > min * 60000;
        if (down && !ui.lastNodeDown[n.id]) {
          ui.lastNodeDown[n.id] = now;
          addEvent('data', `BLE: scanner ${n.name} offline ${Math.round((now - n.lastHb) / 60000)} min`);
          if (min && to.length) handleAlerts([{ rule: 'node', dev: n.id, key: 'node|' + n.id, to, prio: 'presence', text: B.fit(`Scanner ${n.name} offline ${Math.round((now - n.lastHb) / 60000)} min`), t: now }]);
        } else if (n.up && ui.lastNodeDown[n.id]) { delete ui.lastNodeDown[n.id]; addEvent('data', `BLE: scanner ${n.name} back`); }
      }
    }
    // Telemetry goes as a Kelly frame over P25 Transparent -- a TM9100 (kellyData); a TP9400 has no such path.
    const telemReady = () => bs.telem.on && (k.demo() || k.canFrames());
    async function sendTelem(x) {
      const now = Date.now(), d = tele.due(now);
      if (!d) { air.drop(x); return; }
      let frame, ok;
      try { frame = window.CCDI.KellyFrame.telem(tlmSeq = (tlmSeq + 1) & 255, Math.floor(now / 1000), d.items); } catch (e) { air.drop(x); addEvent('data', `BLE telemetry: ${e.message}`); return; }
      const summary = `${d.nReadings} reading${d.nReadings === 1 ? '' : 's'}${d.beat ? ' (heartbeat)' : ''}: ` +
        d.items.filter(i => i[0] === 'reading').map(i => `#${i[1]} ${i[2]} ${i[3]}`).join(', ');
      x.size = frame.length; x.text = B.fit(`Telemetry ${summary}`);
      const dry = bs.dry || k.demo();
      try {
        if (dry) { ok = true; addEvent('data', `BLE dry run -- would send telemetry to the gateway (${frame.length} B): ${summary}`); }
        else if (!k.radioConnected() || !k.canFrames()) ok = false;
        else { ui.txAt = Date.now(); sfx('tx'); dirty('ble'); ok = await k.sendFrame(frame); }
      } catch { ok = false; }
      air.done(x, ok, Date.now());
      if (ok) tele.sent(d, now);
      ui.lastFrame = { t: now, hex: [...frame].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' '), bytes: frame.length, items: d.items, beat: d.beat, ok, dry };
      hist.alerts.push({ t: now, rule: 'telem', dev: '', to: String(gatewayId()), text: x.text, size: frame.length, prio: 'telem', state: ok ? (dry ? 'dry' : 'sent') : x.tries >= air.opts.tries ? 'failed' : 'retrying' });
      while (hist.alerts.length > 300) hist.alerts.shift();
      if (ok && !dry) addEvent('data', `BLE telemetry to the gateway (${frame.length} B): ${summary}`);
    }
    async function transmit(x) {
      if (x.tlm) { sending = true; try { await sendTelem(x); } finally { sending = false; saveHist(); dirty('ble'); } return; }
      sending = true;
      const h = [...hist.alerts].reverse().find(a => a.state === 'queued' && x.text.includes(a.text));
      let ok;
      try {
        if (bs.dry || k.demo()) { ok = true; addEvent('data', `BLE dry run -- would send to ${x.to}: ${x.text}`); }
        else if (!k.radioConnected()) ok = false;
        else { ui.txAt = Date.now(); sfx('tx'); dirty('ble'); ok = await k.sendText(x.to, x.text); }
      } catch { ok = false; }
      air.done(x, ok, Date.now());
      for (const a of hist.alerts) if (a.state === 'queued' && x.text.includes(a.text) && String(a.to).split(', ').includes(String(x.to))) a.state = ok ? (bs.dry || k.demo() ? 'dry' : 'sent') : x.tries >= air.opts.tries ? 'failed' : 'queued';
      if (h && !ok && !k.radioConnected()) h.note = 'radio not connected -- retrying';
      ui.txAt = ok ? Date.now() : 0;
      sending = false; saveHist(); dirty('ble');
    }

    // ---- sound (Web Audio, generated -- nothing copyrighted). Never the only sign of anything: every sound has a
    // toast, an event or a board change beside it.
    function canSound(kind) {
      const s = bs.snd;
      if (!settings.sound || !s.on) return false;
      const alarm = kind.startsWith('alarm-critical');
      if ((s.alarmsOnly || (s.quiet && B.inWindow(s.quiet, Date.now()))) && !alarm) return false;
      const flag = kind.startsWith('alarm') ? 'alarm' : kind;
      return s[flag] !== false;
    }
    function env(ac, t, dur, vol, a = 0.005, rel = 0.05) {
      const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + a);
      g.gain.setValueAtTime(vol, t + Math.max(a, dur - rel)); g.gain.linearRampToValueAtTime(0, t + dur); g.connect(ac.destination); return g;
    }
    function tone(ac, t, f, dur, vol, type = 'sine', f2) {
      const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      o.connect(env(ac, t, dur, vol)); o.start(t); o.stop(t + dur + 0.02);
    }
    function sfx(kind, force) {
      if (!force && !canSound(kind)) return;
      let ac; try { ac = k.audioCtx(); } catch { return; }
      const t = ac.currentTime + 0.02, v = Math.max(0, Math.min(1, +bs.snd.vol)) * 0.35;
      if (kind === 'ping') { tone(ac, t, 1250, 0.32, v, 'sine', 950); tone(ac, t + 0.36, 1250, 0.3, v * 0.25, 'sine', 950); }   // sonar + echo
      else if (kind === 'arrive') [660, 880, 1320].forEach((f, i) => tone(ac, t + i * 0.11, f, 0.16, v));
      else if (kind === 'depart') [1320, 880, 587].forEach((f, i) => tone(ac, t + i * 0.13, f, 0.18, v));
      else if (kind === 'tx') { for (let i = 0; i < 36; i++) tone(ac, t + i * 0.011, Math.random() < 0.5 ? 1200 : 1800, 0.011, v * 0.5, 'square'); }   // a data burst
      else if (kind === 'alarm-info') tone(ac, t, 880, 0.12, v);
      else if (kind === 'alarm-warning') { tone(ac, t, 1000, 0.15, v, 'triangle'); tone(ac, t + 0.25, 1000, 0.15, v, 'triangle'); }
      else if (kind === 'alarm-critical') for (let i = 0; i < 6; i++) tone(ac, t + i * 0.18, i % 2 ? 900 : 1400, 0.16, v, 'square');
      else if (kind === 'click') { const n = ac.createBufferSource(), b = ac.createBuffer(1, 220, ac.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length); n.buffer = b; n.connect(env(ac, t, 0.006, v * 1.4, 0.0005, 0.003)); n.start(t); }
    }
    function cw(text, force) {
      if (!force && !canSound('cw')) return;
      let ac; try { ac = k.audioCtx(); } catch { return; }
      const unit = 1.2 / Math.max(5, Math.min(40, +bs.snd.cwWpm || 20)), f = Math.max(300, Math.min(1200, +bs.snd.cwHz || 700)), v = Math.max(0, Math.min(1, +bs.snd.vol)) * 0.3;
      let t = ac.currentTime + 0.05;
      for (const [on, u] of B.morse(text)) { if (on) tone(ac, t, f, u * unit, v); t += u * unit; }
    }
    // fox-hunt style finder: clicks speed up as the device's RSSI rises
    let nextClick = 0;
    function findClick(now) {
      const L = live[ui.find]; if (!L || now - L.last > 15000) return;
      const r = Math.max(-100, Math.min(-40, L.rssi)), every = 40 + (1 - (r + 100) / 60) * 960;
      if (now >= nextClick) { sfx('click', true); nextClick = now + every; setTimeout(() => ui.find && findClick(Date.now()), every); }
    }

    // ---- demo radio: the simulator stands in for the bridge
    function demoStart() {
      if (demoTimer) return;
      demoSim = B.Sim(Date.now() & 0xffff, Date.now(), ['Home']);
      // the demo's thermometer and go-box send telemetry (as dry runs) as sensors 101 / 102
      Object.assign(demoSim.devices.shack, { tlm: true, tn: 101 }); Object.assign(demoSim.devices.gobox, { tlm: true, tn: 102 });
      tele.setName(101, 'sensor', demoSim.devices.shack.name); tele.setName(102, 'gobox', demoSim.devices.gobox.name);
      presence =B.Presence(optFor, Date.now() - 3600000); registry = B.Registry(devices()); rules = B.Rules(() => demoRules(), devices);
      link.state = 'up'; link.note = 'Demo: a simulated house (keyring beacon, thermometer, go-box, passers-by)'; link.hello = { adapters: ['sim'], zone: 'Home', sim: true };
      health = { sim: { adapter: 'sim', ok: true, fix: [], note: 'simulated adapter', tempC: 41.2, throttle: [] } };
      demoTimer = setInterval(() => { const now = Date.now(); demoSim.at(now).forEach(r => ingest(r, now)); link.rx++; }, 1000);
      ui.sweep = true;
    }
    function demoRules() {
      return Object.keys(bs.rules).length ? bs.rules : {
        d1: { en: true, on: 'arrive', dev: 'keys', to: '1050002', tpl: B.DEFAULT_TPL.arrive, prio: 'presence', cool: 5 },
        d2: { en: true, on: 'depart', dev: 'keys', to: '1050002', tpl: B.DEFAULT_TPL.depart, prio: 'presence', cool: 5 },
        d3: { en: true, on: 'battery', dev: 'gobox', to: '1050002', value: 20, prio: 'alarm' },
        d4: { en: true, on: 'reading', dev: 'shack', field: 'temp', op: '>', value: 26.5, to: '1050002', tpl: 'Shack hot: {value} C', prio: 'routine' } };
    }
    function demoStop() { clearInterval(demoTimer); demoTimer = 0; demoSim = null; presence = B.Presence(optFor, Date.now()); rules = B.Rules(() => bs.rules, devices); registry = B.Registry(devices()); link.state = 'off'; }

    // ---- start / stop
    function setOn(on) {
      bs.on = !!on; save();
      if (bs.on) { link.state = 'connecting'; connect(); addEvent('data', 'BLE: scanning on'); }
      else { disconnect(); addEvent('data', 'BLE: scanning off'); }
      dirty('ble');
    }

    // ================================================================ rendering
    const root = () => $('#ble-root');
    const ago = t => (t ? k.fmtAgo(t) : '—');
    const still = () => !settings.fx || !bs.anim || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    function render() {
      if (k.currentPage() !== 'ble') return;
      try { renderInner(); } finally { const r = root(); if (r && window.KellyEnt) KellyEnt.hideUi(r); }
    }
    function renderInner() {
      const el = root(); if (!el) return;
      if (!el.dataset.built) build(el);
      el.classList.toggle('ble-still', still());
      head();
      const tab = ui.tab;
      if (tab === 'radar') { radar(); nearbyTable(); }
      else if (tab === 'presence') board();
      else if (tab === 'devices') { devTable(); phoneStatus(); }
      else if (tab === 'rules') ruleList();
      else if (tab === 'alerts') alertsTab();
      else if (tab === 'nodes') nodesTab();
      else { const p = plugins.find(x => (x.tabs || []).some(t => t[0] === tab)); if (p && p.render) p.render(tab); }
      for (const id of ui.flash) { const c = el.querySelector(`[data-dev="${CSS.escape(id)}"]`); if (c) { c.classList.remove('ble-flash'); void c.offsetWidth; c.classList.add('ble-flash'); } }
      ui.flash.clear();
    }
    const TABS = [['radar', '📡 Scanner'], ['presence', '🏠 Presence'], ['devices', '🏷️ Devices'], ['rules', '📜 Rules'], ['alerts', '📨 Alerts'], ['nodes', '🛰️ Adapters & nodes'], ['settings', '⚙️ Settings']];
    function build(el) {
      el.dataset.built = '1';
      el.innerHTML = `
        <div class="card ble-hero">
          <div class="card-h"><h2>📶 BLE Presence</h2><div class="row gap wrap"><span class="tag" id="ble-link"></span><span class="tag" id="ble-dry" hidden>DRY RUN</span></div></div>
          <p class="dim small ble-lede">Bluetooth LE devices around home &rarr; P25 text alerts. Register a beacon, a sensor or the go-box, write a rule, and Kelly tells your radio when it arrives, leaves, goes quiet or reads out of range.</p>
          <div class="ble-path" id="ble-path"><span>🏷️<small>Beacon</small></span><i></i><span>📶<small>Scanner</small></span><i></i><span>🖥️<small>Kelly</small></span><i></i><span>📻<small>Radio</small></span><i></i><span>📟<small>Your P25 radio</small></span></div>
          <div class="ble-stats" id="ble-stats"></div>
          <div class="row gap wrap"><button class="btn primary" id="ble-on"></button><label class="fld inline"><input type="checkbox" id="ble-dry-cb"> <span>Dry run (log, don't transmit)</span></label><span class="dim small" id="ble-note"></span></div>
        </div>
        <div class="tabs" id="ble-tabs">${[...TABS.slice(0, -1), ...plugins.flatMap(p => p.tabs || []), TABS[TABS.length - 1]].map(([id, l]) => `<button data-tab="${id}">${l}</button>`).join('')}</div>
        ${plugins.flatMap(p => p.tabs || []).map(([id]) => `<div class="tab" data-pane="${id}"><div data-plugin="${id}"></div></div>`).join('')}
        <div class="tab" data-pane="radar"><div class="grid ble-radar-grid"><div class="card"><div class="card-h"><h3>Radar</h3><span class="dim small">closer to the middle = stronger signal</span></div><div id="ble-radar"></div></div>
          <div class="card"><div class="card-h"><h3>Nearby</h3><span class="dim small" id="ble-anon"></span></div><div class="ble-scroll"><table class="tbl" id="ble-nearby"></table></div>
          <p class="dim small">Phones, watches and earbuds use <b>rotating addresses</b> that change every few minutes, so they can't be registered -- and they're other people's. They're only counted by maker. Use a dedicated beacon (iBeacon / Eddystone / a fixed MAC) for presence.</p></div></div>
          <div class="card" id="ble-form-card" hidden></div></div>
        <div class="tab" data-pane="presence"><div class="ble-board" id="ble-board"></div></div>
        <div class="tab" data-pane="devices"><div class="card"><div class="card-h"><h3>Registered devices</h3><div class="row gap wrap"><button class="btn primary" data-phonenew>📱 My phone as a beacon</button><button class="btn" id="ble-add-dev">➕ Add by hand</button></div></div><div class="ble-scroll"><table class="tbl ble-devtbl" id="ble-devs"></table></div></div><div class="card ble-phone" id="ble-phone-card" hidden></div><div class="card" id="ble-form-card2" hidden></div></div>
        <div class="tab" data-pane="rules"><div class="card"><div class="card-h"><h3>Alert rules</h3><button class="btn" id="ble-add-rule">➕ New rule</button></div><div id="ble-rules"></div>
          <p class="dim small">Alerts go out as P25 text from this radio (through the P25X gateway on a TM9100), unencrypted and under your own radio ID, like every Kelly message. Reply <b>ACK</b> from the radio to stop a repeating alert.</p></div><div class="card" id="ble-rule-card" hidden></div></div>
        <div class="tab" data-pane="alerts"><div id="ble-alerts"></div></div>
        <div class="tab" data-pane="nodes"><div id="ble-nodes"></div><div class="card" id="ble-node-add"></div></div>
        <div class="tab" data-pane="settings"><div id="ble-settings"></div></div>`;
      el.querySelector('#ble-tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { ui.tab = b.dataset.tab; if (ui.tab === 'radar') ui.sweep = true; showTab(); hook('onTab', ui.tab); render(); } };
      for (const p of plugins) for (const [id] of p.tabs || []) { try { p.build && p.build(el.querySelector(`[data-plugin="${id}"]`), id); } catch (e) { console.error('ble plugin build', e); } }
      el.querySelector('#ble-on').onclick = () => setOn(!bs.on);
      el.querySelector('#ble-dry-cb').onchange = e => { bs.dry = e.target.checked; save(); dirty('ble'); };
      el.querySelector('#ble-add-dev').onclick = () => devForm(null, null);
      el.querySelector('#ble-add-rule').onclick = () => ruleForm(null);
      el.addEventListener('click', onClick);
      showTab(); nodeAddForm(); settingsForm();
    }
    function showTab() {
      const el = root();
      el.querySelectorAll('#ble-tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
      el.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('on', p.dataset.pane === ui.tab));
    }
    function head() {
      const el = root(), st = air.stats(Date.now());
      const L = { up: ['ok', 'Bridge linked'], connecting: ['warn', 'Connecting…'], down: ['bad', 'Bridge not reachable'], off: ['', 'Off'] }[link.state] || ['', link.state];
      const t = el.querySelector('#ble-link'); t.textContent = k.demo() ? 'DEMO' : L[1]; t.className = `tag ble-st-${L[0]}`;
      el.querySelector('#ble-dry').hidden = !bs.dry;
      el.querySelector('#ble-dry-cb').checked = !!bs.dry;
      el.querySelector('#ble-on').textContent = bs.on || k.demo() ? '⏹ Stop scanning' : '▶ Start scanning';
      el.querySelector('#ble-note').textContent = link.note || (link.hello ? `Adapters: ${(link.hello.adapters || []).join(', ') || 'none'} · zone ${link.hello.zone}${nodes.length ? ` · ${nodes.filter(n => n.up).length}/${nodes.length} remote nodes up` : ''}` : '');
      const here = Object.keys(devices()).filter(id => (presence.get(id) || {}).st === 'present').length;
      el.querySelector('#ble-stats').innerHTML = [
        ['Registered', Object.keys(devices()).length], ['Here now', here], ['Nearby', nearby.size + anon.size],
        ['Alerts today', st.day], ['Queued', st.queued], ['Air today', `${st.airDay} s`]].map(([a, b]) => `<div><b>${esc(String(b))}</b><small>${a}</small></div>`).join('');
      const p = el.querySelector('#ble-path');
      if (ui.txAt && Date.now() - ui.txAt < 4000 && !p.classList.contains('tx')) { p.classList.add('tx'); setTimeout(() => p.classList.remove('tx'), 2600); }
    }

    // ---- radar: rings at -40/-60/-80/-100 dBm; a blip's angle is fixed per device, its distance its RSSI
    function hashAngle(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0) % 3600) / 10; }
    const rad = r => 8 + (1 - (Math.max(-100, Math.min(-35, r)) + 100) / 65) * 132;
    function radar() {
      const now = Date.now(), host = root().querySelector('#ble-radar');
      const blip = (key, r, cls, label, age) => {
        const a = hashAngle(key) * Math.PI / 180, d = rad(r), x = 150 + d * Math.cos(a), y = 150 + d * Math.sin(a), op = Math.max(0.15, 1 - age / 60000);
        return `<g class="${cls}" opacity="${op.toFixed(2)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="${cls.includes('reg') ? 6 : 3}"/>${label ? (x > 175 ? `<text x="-9" y="4" text-anchor="end">${esc(label)}</text>` : `<text x="9" y="4">${esc(label)}</text>`) : ''}</g>`;
      };
      let g = '';
      for (const [a, n] of anon) g += blip(a, (n.r || -92), 'b-anon', '', now - n.last);
      for (const [a, n] of nearby) g += blip(a, n.r.r, 'b-near', '', now - n.last);
      for (const [id, L] of Object.entries(live)) if (devices()[id] && now - L.last < 600000) g += blip(id, L.rssi, `b-reg t-${devices()[id].type || 'other'}`, `${icon(devices()[id].type)} ${devName(id)}`, now - L.last);
      const sweep = ui.sweep && !still() ? '<g class="ble-sweep"><path d="M150 150 L150 10 A140 140 0 0 1 249 51 Z"/></g>' : '';
      ui.sweep = false;

      host.innerHTML = `<svg viewBox="0 0 300 300" class="ble-radar" role="img" aria-label="BLE radar">
        ${[140, 100, 60, 22].map((r, i) => `<circle class="ring" cx="150" cy="150" r="${r}"/><text class="ring-l" x="${152 + r * 0.7}" y="${148 - r * 0.7}">${[-100, -80, -60, -40][i]}</text>`).join('')}
        <line class="ring" x1="10" y1="150" x2="290" y2="150"/><line class="ring" x1="150" y1="10" x2="150" y2="290"/>
        ${sweep}${g}<circle class="me" cx="150" cy="150" r="4"/></svg>`;

    }
    function decodedText(d) {
      const v = d.val || {}, bits = [];
      if (d.ib) bits.push(`iBeacon ${d.ib.major}/${d.ib.minor}`);
      if (d.ed) bits.push(d.ed.frame === 'url' ? `Eddystone ${d.ed.url}` : d.ed.frame === 'uid' ? 'Eddystone UID' : 'Eddystone TLM');
      if (d.kind === 'bthome') bits.push(d.bth && d.bth.encrypted ? 'BTHome (encrypted)' : 'BTHome');
      if (d.kind === 'pvvx' || d.kind === 'atc') bits.push(d.kind.toUpperCase());
      if (v.temp != null) bits.push(`${v.temp} °C`);
      if (v.hum != null) bits.push(`${v.hum} %RH`);
      if (v.batt != null) bits.push(`🔋${v.batt}%`);
      if (v.volt != null) bits.push(`${v.volt} V`);
      for (const f of ['door', 'window', 'opening', 'motion', 'smoke', 'button']) if (v[f] != null) bits.push(`${f} ${v[f]}`);
      if (d.tag) bits.unshift('🏷 ' + d.tag.name);
      if (!bits.length && d.company) bits.push(d.company);
      return bits.join(' · ');
    }
    function nearbyTable() {
      const el = root(), rows = [...nearby.entries()].sort((a, b) => b[1].r.r - a[1].r.r).slice(0, 40);
      el.querySelector('#ble-nearby').innerHTML = `<thead><tr><th>Device</th><th>Address</th><th>Decoded</th><th>RSSI</th><th>Seen</th><th></th></tr></thead><tbody>${rows.map(([a, n]) => `
        <tr><td>${esc(n.r.nm || '—')}${nodes.length ? `<div class="dim small">${esc(n.r.z)}</div>` : ''}</td><td class="mono small">${esc(n.r.a)}<div class="dim small">${esc(B.ADDR_KIND[n.d.addr].split(' (')[0])}</div></td>
        <td class="small">${esc(decodedText(n.d))}</td><td class="mono">${n.r.r}</td><td class="small">${ago(n.last)}</td>
        <td>${B.bestKey(n.r, n.d) ? `<button class="btn small" data-reg="${esc(a)}">Register</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">Nothing with a fixed address in range yet.</td></tr>'}</tbody>`;
      const cats = {}; for (const n of anon.values()) cats[n.cat] = (cats[n.cat] || 0) + 1;
      el.querySelector('#ble-anon').textContent = anon.size ? `+ ${anon.size} on rotating addresses: ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ×${n}`).join(', ')}${[...anon.values()].some(x => x.tag) ? ' -- tracker tags like AirTag and SmartTag change their address on purpose (anti-stalking), so only their owner’s phone can follow them' : ''}` : '';
    }

    // ---- presence board
    function board() {
      const now = Date.now(), ids = Object.keys(devices());
      root().querySelector('#ble-board').innerHTML = ids.map(id => {
        const dv = devices()[id], p = presence.get(id) || {}, L = live[id] || {}, st = dv.en === false ? 'off' : p.st || 'unknown';
        const lab = { present: 'HERE', away: 'AWAY', unknown: 'WAITING', off: 'OFF' }[st];
        const bar = L.rssi != null && now - L.last < 60000 ? Math.max(4, Math.min(100, (L.rssi + 100) * 1.6)) : 0;
        const v = L.val ? decodedText({ val: L.val }) : '';
        return `<div class="card ble-card st-${st}" data-dev="${esc(id)}"><div class="ble-ic">${icon(dv.type)}</div><div class="ble-cb">
          <div class="ble-cn">${esc(dv.name || id)}${dv.call ? ` <span class="dim">${esc(dv.call)}</span>` : ''}</div>
          <div class="ble-cs"><b>${lab}</b>${p.zone && st === 'present' ? ` · ${esc(p.zone)}` : ''} <span class="dim small">${st === 'present' ? 'since ' + B.clock(p.since) : p.lastSeen ? 'last seen ' + ago(p.lastSeen) : ''}</span></div>
          <div class="ble-bar"><i style="width:${bar}%"></i></div><div class="dim small">${L.rssi != null ? `${L.rssi} dBm · ${ago(L.last)}` : 'not heard yet'}${v ? ` · ${esc(v)}` : ''}</div></div></div>`;
      }).join('') || `<div class="card dim">No devices registered yet. Open <b>Scanner</b>, find your beacon in Nearby and press Register -- or use your phone: <button class="btn small" data-phonenew>📱 My phone as a beacon</button></div>`;
    }

    // ---- devices
    function devTable() {
      const now = Date.now(), el = root().querySelector('#ble-devs');
      el.innerHTML = `<thead><tr><th>Device</th><th>Matches</th><th>State</th><th>Last reading</th><th>Overrides</th><th></th></tr></thead><tbody>${Object.entries(devices()).map(([id, dv]) => {
        const p = presence.get(id) || {}, L = live[id] || {}, demoDev = k.demo() && demoSim && demoSim.devices[id] && !bs.devices[id];
        const ov = ['arrive', 'depart', 'absence'].filter(x => dv[x] !== '' && dv[x] != null).map(x => `${x} ${dv[x]}`).join(', ');
        return `<tr data-dev="${esc(id)}"><td>${icon(dv.type)} <b>${esc(dv.name || id)}</b>${dv.phone ? ' <span class="tag">📱 phone</span>' : ''}${dv.call ? `<div class="dim small">${esc(dv.call)}</div>` : ''}${dv.notes ? `<div class="dim small">${esc(dv.notes)}</div>` : ''}</td>
          <td class="mono small">${esc(dv.match || '')}</td><td>${dv.en === false ? 'off' : esc(p.st || 'waiting')}${p.zone ? ` · ${esc(p.zone)}` : ''}<div class="dim small">${L.rssi != null ? `${L.rssi} dBm ${ago(L.last)}` : ''}</div></td>
          <td class="small">${L.val ? esc(decodedText({ val: L.val })) : ''}${dv.tlm && dv.tn ? `<div class="dim small" title="Sent to the P25X gateway as sensor ${dv.tn}">📈 telemetry #${dv.tn}</div>` : ''}</td><td class="small">${esc(ov)}</td>
          <td class="nowrap">${demoDev ? '<span class="dim small">demo</span>' : `<button class="btn small" data-find="${esc(id)}">${ui.find === id ? '⏹ Stop' : '🔍 Find'}</button> ${dv.type === 'pet' && !petRulesFor(id) ? `<button class="btn small" data-petrules="${esc(id)}" title="Texts you when it leaves home (alarm) and when it is back">🐾 Pet alerts</button> ` : ''}${dv.phone && B.parseIbKey(dv.match) ? `<button class="btn small" data-phone="${esc(id)}" title="The UUID / major / minor to type into the beacon app">📱 App settings</button> ` : ''}<button class="btn small" data-edit="${esc(id)}">Edit</button> <button class="btn small" data-del="${esc(id)}">✕</button>`}</td></tr>`;
      }).join('') || '<tr><td colspan="6" class="dim">None yet.</td></tr>'}</tbody>`;
      if (ui.find && live[ui.find]) {
        const L = live[ui.find];
        el.insertAdjacentHTML('beforeend', `<tfoot><tr><td colspan="6"><div class="ble-find"><b>🔍 Finding ${esc(devName(ui.find))}</b> <span class="mono">${L.rssi} dBm</span> <span class="ble-heat" style="--h:${Math.max(0, Math.min(1, (L.rssi + 100) / 60))}">${L.rssi > -55 ? 'HOT' : L.rssi > -70 ? 'warm' : L.rssi > -85 ? 'cool' : 'cold'}</span> <span class="dim small">clicks speed up as you get closer${now - L.last > 15000 ? ' -- not heard for a while' : ''}</span></div></td></tr></tfoot>`);
      }
    }
    // the register / edit form; a = nearby address to prefill from
    function devForm(id, a) {
      const card = root().querySelector(ui.tab === 'radar' ? '#ble-form-card' : '#ble-form-card2');
      const dv = id ? Object.assign({}, bs.devices[id]) : { name: '', call: k.myCall() || '', type: 'person', match: '', notes: '', en: true };
      if (a && nearby.get(a)) { const n = nearby.get(a); dv.match = B.bestKey(n.r, n.d); dv.name = n.r.nm || (n.d.ib ? 'iBeacon' : n.d.kind !== 'other' ? n.d.kind : 'Beacon'); if (n.d.kind === 'pvvx' || n.d.kind === 'atc' || n.d.kind === 'bthome') dv.type = 'sensor';
        if (n.d.tag) Object.assign(dv, PET_DEFAULTS, { name: (n.r.nm || n.d.tag.name).trim().slice(0, 24) }); }   // a tracker tag: most likely on a pet
      card.hidden = false;
      card.innerHTML = `<div class="card-h"><h3>${id ? 'Edit device' : 'Register a device'}</h3><button class="btn small" data-close>✕</button></div>
        <div class="grid ble-form">
          <label class="fld"><span>Name</span><input id="bf-name" maxlength="24" value="${esc(dv.name)}"></label>
          <label class="fld"><span>Owner callsign</span><input id="bf-call" maxlength="10" value="${esc(dv.call || '')}" placeholder="VK4ABC"></label>
          <label class="fld"><span>Type</span><select id="bf-type">${Object.entries(TYPES).map(([t, [i, l]]) => `<option value="${t}"${dv.type === t ? ' selected' : ''}>${i} ${l}</option>`).join('')}</select></label>
          <label class="fld grow"><span>Matches</span><input id="bf-match" class="mono" value="${esc(dv.match)}" placeholder="mac:AA:BB:CC:DD:EE:FF · ib:uuid:major:minor · ed:namespace:instance · name:my beacon"></label>
          <label class="fld grow"><span>Notes</span><input id="bf-notes" maxlength="60" value="${esc(dv.notes || '')}"></label>
          <label class="fld"><span>Arrive dBm</span><input id="bf-arrive" type="number" value="${esc(dv.arrive != null ? dv.arrive : '')}" placeholder="${bs.presence.arrive}"></label>
          <label class="fld"><span>Depart dBm</span><input id="bf-depart" type="number" value="${esc(dv.depart != null ? dv.depart : '')}" placeholder="${bs.presence.depart}"></label>
          <label class="fld"><span>Absence s</span><input id="bf-absence" type="number" value="${esc(dv.absence != null ? dv.absence : '')}" placeholder="${bs.presence.absenceSec}"></label>
        </div><p class="dim small" id="bf-warn"></p>
        <label class="fld inline" data-ent="bridge.ble2p25"><input type="checkbox" id="bf-tlm"${(dv.tlm != null ? dv.tlm : dv.type === 'sensor') ? ' checked' : ''}> <span>📈 Send its readings to the P25X gateway (MQTT + Grafana)</span></label>
        <p class="dim small" id="bf-tlmwarn"></p>
        <div class="row gap"><button class="btn primary" id="bf-save">💾 Save</button><label class="fld inline"><input type="checkbox" id="bf-en"${dv.en !== false ? ' checked' : ''}> <span>Enabled</span></label></div>`;
      const tlmWarn = () => { card.querySelector('#bf-tlmwarn').textContent = tlmWarnText(card.querySelector('#bf-tlm').checked, card.querySelector('#bf-type').value); };
      card.querySelector('#bf-tlm').onchange = tlmWarn; card.querySelector('#bf-type').addEventListener('change', tlmWarn); tlmWarn();
      const warn = () => { const m = card.querySelector('#bf-match').value.trim(), nk = B.normKey(m);
        card.querySelector('#bf-warn').textContent = !nk ? 'Matches: mac:, ib:, ed: or name: then the value.' : nk.startsWith('name:') ? 'Names aren\'t unique -- any device advertising this name will count. A MAC or beacon ID is better.' : nk.startsWith('mac:') && /^[4-7]/i.test(nk.slice(4)) ? 'That looks like a rotating (private) address -- it will change in minutes. Use the beacon ID instead.' : ''; };
      card.querySelector('#bf-match').oninput = warn; warn();
      card.querySelector('#bf-save').onclick = () => {
        const v = s => card.querySelector(s).value.trim(), nk = B.normKey(v('#bf-match'));
        if (!nk) { toast('❓', 'What should it match?', 'mac:…, ib:…, ed:… or name:…', 'bad'); return; }
        const nid = id || ('d' + Date.now().toString(36));
        bs.devices[nid] = { name: v('#bf-name') || nid, call: v('#bf-call').toUpperCase(), type: v('#bf-type'), match: nk, notes: v('#bf-notes'), arrive: v('#bf-arrive'), depart: v('#bf-depart'), absence: v('#bf-absence'), en: card.querySelector('#bf-en').checked,
          tlm: card.querySelector('#bf-tlm').checked, tn: (bs.devices[nid] || {}).tn || 0 };
        if (a) nearby.delete(a);
        card.hidden = true; devsChanged(); toast('🏷️', id ? 'Device saved' : 'Device registered', bs.devices[nid].name);
      };
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function tlmWarnText(on, t) {
      return !on ? '' : (t === 'person' || t === 'vehicle'
        ? '⚠ This sends when it is home or away, and P25X members can read the gateway\'s MQTT and Grafana -- think twice for a person or a car. '
        : 'Its readings (and here / away) go to the P25X gateway, where club members can see them. ') +
        (bs.telem.on ? '' : 'Telemetry is off in Settings.');
    }

    // ---- your phone as a beacon (Phase 13): a web page can't transmit BLE, so a beacon app on the phone sends an iBeacon
    // ID that Kelly makes up (B.phoneBeacon) and registers as a person; the card then says whether the scanner hears it.
    // ui.phone = { uuid, major, minor, id } -- id once it's registered (or an existing phone device, from its match key).
    function phoneCard(id) {
      const card = root().querySelector('#ble-phone-card'), dv = id ? bs.devices[id] : null;
      ui.phone = dv ? Object.assign({ id }, B.parseIbKey(dv.match)) : Object.assign({ id: null }, B.phoneBeacon());
      if (!ui.phone.uuid) { ui.phone = null; return; }
      const name = dv ? dv.name : 'My phone', call = dv ? dv.call || '' : k.myCall() || '';
      card.hidden = false;
      card.innerHTML = `<div class="card-h"><h3>📱 Your phone as a beacon</h3><button class="btn small" data-close>✕</button></div>
        <p class="ble-ph-why">A web page can't transmit Bluetooth, so your phone runs a small beacon app that sends the ID below. Kelly does the rest.</p>
        <div class="ble-ph-id">
          <div><small>UUID</small><b class="mono" id="bp-uuid"></b><button class="btn" data-copy="uuid">📋 Copy</button></div>
          <div><small>Major</small><b class="mono" id="bp-major"></b><button class="btn" data-copy="major">📋 Copy</button></div>
          <div><small>Minor</small><b class="mono" id="bp-minor"></b><button class="btn" data-copy="minor">📋 Copy</button></div>
        </div>
        <ol class="ble-ph-steps">
          <li><b>Android:</b> install <b>Beacon Simulator</b> (free, Play Store). <b>iPhone:</b> any iBeacon transmitter app works, but iOS only sends while that app is open on screen, so it can't tell Kelly you're home with the phone in your pocket.</li>
          <li>In the app tap <b>+</b> and choose <b>iBeacon</b>.</li>
          <li>Paste the <b>UUID</b>, then type the <b>Major</b> and <b>Minor</b> exactly as shown.</li>
          <li>Power <b>Medium</b> (High if the Pi is at the far end of the house); mode <b>Balanced</b> -- Low latency flattens the battery.</li>
          <li>Turn the beacon on. Android: Settings › Apps › Beacon Simulator › Battery › <b>Unrestricted</b>, or it stops when the screen locks.</li>
        </ol>
        <div class="grid ble-form">
          <label class="fld"><span>Name</span><input id="bp-name" maxlength="24" value="${esc(name)}"></label>
          <label class="fld"><span>Owner callsign</span><input id="bp-call" maxlength="10" value="${esc(call)}" placeholder="VK4ABC"></label>
        </div>
        <label class="fld inline" data-ent="bridge.ble2p25"><input type="checkbox" id="bp-tlm"${dv && dv.tlm ? ' checked' : ''}> <span>📈 Send here / away to the P25X gateway (MQTT + Grafana)</span></label>
        <p class="dim small" id="bp-tlmwarn"></p>
        <div class="row gap wrap"><button class="btn primary" id="bp-save"></button>${dv ? '' : '<button class="btn" id="bp-new" title="Make a different ID">🎲 New ID</button>'}</div>
        <div class="ble-ph-st" id="bp-st" role="status"></div>`;
      const q = s => card.querySelector(s);
      const fill = () => { q('#bp-uuid').textContent = ui.phone.uuid; q('#bp-major').textContent = ui.phone.major; q('#bp-minor').textContent = ui.phone.minor; q('#bp-save').textContent = ui.phone.id ? '💾 Save' : '✅ Register this beacon'; phoneStatus(); };
      const tw = () => { q('#bp-tlmwarn').textContent = tlmWarnText(q('#bp-tlm').checked, 'person'); };
      q('#bp-tlm').onchange = tw; tw();
      if (q('#bp-new')) q('#bp-new').onclick = () => { Object.assign(ui.phone, B.phoneBeacon()); fill(); };
      q('#bp-save').onclick = () => {
        const nid = ui.phone.id || ('d' + Date.now().toString(36)), old = bs.devices[nid] || { notes: '', arrive: '', depart: '', absence: '', en: true, tn: 0 };
        bs.devices[nid] = Object.assign({}, old, { name: q('#bp-name').value.trim() || 'My phone', call: q('#bp-call').value.trim().toUpperCase(), type: 'person',
          match: B.ibKey(ui.phone), tlm: q('#bp-tlm').checked, phone: true });
        nearby.delete(B.ibKey(ui.phone));
        const isNew = !ui.phone.id; ui.phone.id = nid; devsChanged(); fill();
        toast('📱', isNew ? 'Phone beacon registered' : 'Phone beacon saved', bs.devices[nid].name);
      };
      fill();
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    function phoneStatus() {
      const card = root().querySelector('#ble-phone-card'); if (!card || card.hidden || !ui.phone) return;
      const el = card.querySelector('#bp-st'), now = Date.now(), L = ui.phone.id && live[ui.phone.id], pre = !ui.phone.id && nearby.get(B.ibKey(ui.phone));
      const where = z => z && nodes.length ? ` in ${esc(z)}` : '';
      let cls = 'wait', h;
      if (L && now - L.last < 60000) { cls = 'ok'; h = `✓ Seen by your Pi${where(L.zone)} at <b>${L.rssi} dBm</b> · ${ago(L.last)}`; }
      else if (L) h = `Last seen ${ago(L.last)} at ${L.rssi} dBm -- not heard in the last minute. Is the beacon still on?`;
      else if (pre) { cls = 'ok'; h = `✓ Heard at <b>${pre.r.r} dBm</b> -- press Register to start tracking it.`; }
      else if (!bs.on && !k.demo()) h = 'Not heard yet -- scanning is off: press ▶ Start scanning at the top.';
      else if (link.state !== 'up' && !k.demo()) h = `Not heard yet -- the bridge isn't linked (${esc(link.state)}).`;
      else h = 'Not heard yet -- turn the beacon on in the app. It shows here a few seconds after your Pi hears it.';
      el.className = `ble-ph-st ${cls}`; el.innerHTML = h;
    }
    function copyText(t) {
      const done = () => toast('📋', 'Copied', t);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => prompt('Copy this:', t));
      else prompt('Copy this:', t);
    }

    // ---- rules
    const ruleSummary = r => {
      const who = r.dev === '*' || !r.dev ? 'any device' : devName(r.dev);
      const what = { arrive: 'arrives', depart: 'leaves', move: 'moves zone', notseen: `not seen for ${r.hours || '?'} h`, outside: `seen outside ${r.sched || '(no schedule)'}`, battery: `battery < ${r.value || 20}%`, reading: `${r.field || '?'} ${r.op || '>'} ${r.value}` }[r.on] || r.on;
      return `${who} ${what}${r.zone ? ` (${r.zone})` : ''} → ${r.to || 'nobody'}`;
    };
    function ruleList() {
      const list = Object.entries(k.demo() ? demoRules() : bs.rules);
      root().querySelector('#ble-rules').innerHTML = list.length ? `<table class="tbl"><thead><tr><th></th><th>When</th><th>Says</th><th>Priority</th><th></th></tr></thead><tbody>${list.map(([id, r]) => `
        <tr><td><input type="checkbox" data-ren="${esc(id)}"${r.en !== false ? ' checked' : ''}${k.demo() && !bs.rules[id] ? ' disabled' : ''}></td><td>${esc(ruleSummary(r))}${+r.esc > 0 ? `<div class="dim small">repeats every ${r.esc} min until cleared</div>` : ''}</td>
        <td class="mono small">${esc(r.tpl || B.DEFAULT_TPL[r.on] || '')}</td><td><span class="ble-pr pr-${r.prio || 'presence'}">${PRIO_LABEL[r.prio || 'presence']}</span></td>
        <td class="nowrap">${bs.rules[id] ? `<button class="btn small" data-redit="${esc(id)}">Edit</button> <button class="btn small" data-rdel="${esc(id)}">✕</button>` : '<span class="dim small">demo</span>'}</td></tr>`).join('')}</tbody></table>`
        : '<p class="dim">No rules yet -- a registered device does nothing until a rule says who to tell.</p>';
    }
    function ruleForm(id) {
      const card = root().querySelector('#ble-rule-card');
      const r = id ? Object.assign({}, bs.rules[id]) : { en: true, on: 'arrive', dev: '*', zone: '', to: String(bs.lastTo || ''), tpl: '', prio: 'presence', cool: 10, quiet: '', sched: '', hours: 4, field: 'temp', op: '>', value: '', esc: 0, escMax: 3 };
      const zones = [...new Set([(link.hello || {}).zone || 'Home', ...nodes.map(n => n.zone)])];
      card.hidden = false;
      card.innerHTML = `<div class="card-h"><h3>${id ? 'Edit rule' : 'New rule'}</h3><button class="btn small" data-close>✕</button></div>
        <div class="grid ble-form">
          <label class="fld"><span>When</span><select id="rf-on">${Object.entries(B.TRIGGERS).map(([t, l]) => `<option value="${t}"${r.on === t ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld"><span>Device</span><select id="rf-dev"><option value="*">Any registered device</option>${Object.entries(bs.devices).map(([d, dv]) => `<option value="${esc(d)}"${r.dev === d ? ' selected' : ''}>${icon(dv.type)} ${esc(dv.name || d)}</option>`).join('')}</select></label>
          <label class="fld"><span>Zone</span><select id="rf-zone"><option value="">Any</option>${zones.map(z => `<option${r.zone === z ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
          <label class="fld grow"><span>Tell (radio IDs)</span><input id="rf-to" value="${esc(r.to)}" placeholder="1050002, 2050002"></label>
          <label class="fld" data-for="notseen"><span>Hours</span><input id="rf-hours" type="number" min="0.1" step="0.5" value="${esc(r.hours)}"></label>
          <label class="fld grow" data-for="outside"><span>Allowed times</span><input id="rf-sched" value="${esc(r.sched)}" placeholder="Mon-Fri 07:00-18:00; Sat 08:00-12:00"></label>
          <label class="fld" data-for="reading"><span>Reading</span><select id="rf-field">${['temp', 'hum', 'batt', 'volt', 'battMv', 'pressure', 'co2', 'door', 'window', 'opening', 'motion', 'smoke', 'moisture', 'power', 'current'].map(f => `<option${r.field === f ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
          <label class="fld" data-for="reading"><span>Is</span><select id="rf-op"><option value=">"${r.op === '>' ? ' selected' : ''}>above</option><option value="<"${r.op === '<' ? ' selected' : ''}>below</option></select></label>
          <label class="fld" data-for="reading battery"><span>Value</span><input id="rf-value" type="number" step="any" value="${esc(r.value)}" placeholder="20"></label>
          <label class="fld"><span>Priority</span><select id="rf-prio">${Object.entries(PRIO_LABEL).map(([p, l]) => `<option value="${p}"${r.prio === p ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="fld"><span>Cooldown min</span><input id="rf-cool" type="number" min="0" value="${esc(r.cool)}"></label>
          <label class="fld"><span>Quiet hours</span><input id="rf-quiet" value="${esc(r.quiet)}" placeholder="22:00-06:00"></label>
          <label class="fld"><span>Repeat every min</span><input id="rf-esc" type="number" min="0" value="${esc(r.esc)}" title="0 = once"></label>
          <label class="fld"><span>Repeat at most</span><input id="rf-escmax" type="number" min="1" value="${esc(r.escMax)}"></label>
          <label class="fld grow ble-tpl"><span>Message</span><textarea id="rf-tpl" rows="2" placeholder="">${esc(r.tpl)}</textarea></label>
        </div>
        <div class="ble-preview"><span class="dim small">Preview</span> <span class="mono" id="rf-prev"></span> <b id="rf-count"></b></div>
        <p class="dim small">Placeholders: {device} {callsign} {owner} {type} {zone} {from} {time} {date} {rssi} {last_seen} {batt} {value} {field}. A P25 text is 160 bytes; Kelly keeps alerts to ${B.P25_TEXT_MAX} so the gateway's "CALL: " still fits, and cuts anything longer. Quiet hours hold presence and routine alerts, never alarms.</p>
        <div class="row gap"><button class="btn primary" id="rf-save">💾 Save rule</button><button class="btn" id="rf-test">📨 Send a test now</button></div>`;
      const q = s => card.querySelector(s);
      const sync = () => {
        const on = q('#rf-on').value;
        card.querySelectorAll('[data-for]').forEach(l => { l.hidden = !l.dataset.for.split(' ').includes(on); });
        q('#rf-tpl').placeholder = B.DEFAULT_TPL[on];
        const dv = bs.devices[q('#rf-dev').value] || { name: 'Keyring', call: k.myCall() || 'VK4ABC' };
        const txt = B.render(q('#rf-tpl').value.trim() || B.DEFAULT_TPL[on], { device: dv.name, callsign: dv.call || dv.name, owner: dv.call || '', type: dv.type || '', zone: q('#rf-zone').value || 'Home', from: 'Shed', time: B.clock(Date.now()), date: new Date().toLocaleDateString(), rssi: -67, last_seen: B.ago(Date.now() - 5 * 3600000, Date.now()), batt: 15, value: 27.4, field: q('#rf-field').value });
        const raw = B.bytes(B.render(q('#rf-tpl').value.trim() || B.DEFAULT_TPL[on], { device: dv.name, callsign: dv.call || dv.name, zone: 'Home', time: '08:00', rssi: -67, last_seen: '03:00', batt: 15, value: 27.4, field: 'temp' }, 1000));
        q('#rf-prev').textContent = txt; q('#rf-count').textContent = `${B.bytes(txt)} / ${B.P25_TEXT_MAX} bytes${raw > B.P25_TEXT_MAX ? ' -- will be cut' : ''}`; q('#rf-count').className = raw > B.P25_TEXT_MAX ? 'bad' : '';
      };
      card.querySelectorAll('input,select,textarea').forEach(i => { i.oninput = sync; i.onchange = sync; }); sync();
      const read = () => ({ en: id ? bs.rules[id].en !== false : true, on: q('#rf-on').value, dev: q('#rf-dev').value, zone: q('#rf-zone').value, to: q('#rf-to').value.trim(), tpl: q('#rf-tpl').value.trim(),
        prio: q('#rf-prio').value, cool: q('#rf-cool').value, quiet: q('#rf-quiet').value.trim(), sched: q('#rf-sched').value.trim(), hours: q('#rf-hours').value, field: q('#rf-field').value,
        op: q('#rf-op').value, value: q('#rf-value').value, esc: q('#rf-esc').value, escMax: q('#rf-escmax').value });
      q('#rf-save').onclick = () => {
        const nr = read();
        if (!B.units(nr.to).length) { toast('❓', 'Who should hear it?', 'One or more radio IDs, e.g. your handheld', 'bad'); return; }
        if (nr.on === 'outside' && !B.inSchedule(nr.sched, Date.now()) && !/\d:\d\d/.test(nr.sched)) { toast('❓', 'Allowed times?', 'e.g. Mon-Fri 07:00-18:00', 'bad'); return; }
        if (nr.quiet && !/^\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*$/.test(nr.quiet)) { toast('❓', 'Quiet hours', 'like 22:00-06:00', 'bad'); return; }
        bs.rules[id || ('r' + Date.now().toString(36))] = nr; bs.lastTo = nr.to;
        card.hidden = true; save(); dirty('ble'); toast('📜', 'Rule saved', ruleSummary(nr));
      };
      q('#rf-test').onclick = () => {
        const nr = read(), to = B.units(nr.to);
        if (!to.length) { toast('❓', 'Who to?', 'Put a radio ID in Tell', 'bad'); return; }
        handleAlerts([{ rule: 'test', dev: '', key: 'test', to, prio: nr.prio, text: B.fit('TEST ' + q('#rf-prev').textContent), t: Date.now() }]);
        toast('📨', 'Test queued', bs.dry ? 'Dry run is on: it will only be logged' : 'It goes out when the airtime queue lets it');
      };
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ---- telemetry status + the last frame, byte for byte
    function telemCard(now, st) {
      const sensors = Object.entries(devices()).filter(([, d]) => d.tlm && d.tn);
      const why = !bs.telem.on ? 'Off -- switch it on in Settings.' : !k.demo() && !k.canFrames() ? 'This radio can\'t send it: telemetry rides Kelly frames over P25 Transparent (a TM9100). A TP9400 has no such path.' : '';
      const f = ui.lastFrame, fr = f && window.CCDI.KellyFrame.scan(f.hex.split(' ').map(h => parseInt(h, 16)))[0];
      return `<div class="card" data-ent="bridge.ble2p25"><div class="card-h"><h3>📈 Telemetry to the P25X gateway</h3>${bs.telem.on ? '<button class="btn small" data-tlmnow>Send all now</button>' : ''}</div>
        ${why ? `<p class="dim">${esc(why)}</p>` : ''}
        <div class="ble-stats">${[['Sensors', sensors.length], ['Frames today', st.telemDay], ['Heartbeat', `${bs.telem.heartbeatMin} min`], ['Last frame', f ? B.clock(f.t) : '—'], ['Size', f ? `${f.bytes} B` : '—']].map(([a, b]) => `<div><b>${esc(String(b))}</b><small>${a}</small></div>`).join('')}</div>
        ${sensors.length ? `<p class="small">${sensors.map(([id, d]) => `<span class="tag">#${d.tn} ${esc(d.name || id)}</span>`).join(' ')}</p>` : '<p class="dim small">No device sends telemetry yet: Devices › Edit › "Send its readings to the P25X gateway".</p>'}
        ${f ? `<details class="small"><summary>Last frame${f.dry ? ' (dry run)' : f.ok ? '' : ' (not sent)'}: ${f.items.filter(i => i[0] === 'reading').length} readings${f.beat ? ', heartbeat' : ''}</summary>
          <pre class="mono ble-hex">${esc(f.hex)}</pre>
          ${fr ? `<table class="tbl"><tbody>${fr.names.map(n => `<tr><td>#${n.sensor}</td><td colspan="2">name "${esc(n.name)}" (${esc(n.dtype)})</td></tr>`).join('')}${fr.readings.map(r => `<tr><td>#${r.sensor}</td><td>${esc(r.field)}</td><td class="mono">${r.value}${r.age ? ` <span class="dim">(${r.age} s old)</span>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
          <p class="dim">A5 4B = a Kelly frame, 0F = telemetry, then the length, the payload (0D bytes sent as 7D 2D so the radio never sends early) and a CRC. The gateway publishes MQTT <code>p25x/ble/&lt;radio&gt;/&lt;sensor&gt;</code>; Grafana: P25X BLE Telemetry.</p></details>` : ''}
        <p class="dim small">Readings go when they change past a deadband (0.3 °C, 2 %RH, 2 % battery…), everything at each heartbeat, at most one frame every ${bs.telem.gap} s, after every alert. Club members can see the gateway's MQTT and Grafana.</p></div>`;
    }
    // ---- alerts: queue, escalations, history, airtime
    function alertsTab() {
      const now = Date.now(), st = air.stats(now), q = air.queue(), escs = rules.escalating();
      root().querySelector('#ble-alerts').innerHTML = `
        <div class="card"><div class="card-h"><h3>Airtime</h3><span class="dim small">one message at a time; alarms first; presence alerts to the same radio are joined</span></div>
          <div class="ble-stats">${[['Sent last hour', `${st.hour} / ${air.opts.hourCap}`], ['Sent today', st.day], ['Air last hour', `${st.airHour} s`], ['Air today', `${st.airDay} s`], ['Bytes today', st.bytesDay], ['Next slot', q.length ? `${st.nextIn} s` : '—']].map(([a, b]) => `<div><b>${esc(String(b))}</b><small>${a}</small></div>`).join('')}</div>
          <p class="dim small">Air time is an estimate (${B.airSec(100)} s for 100 bytes). Gaps: alarm ${bs.air.alarmGap} s, presence ${bs.air.presenceGap} s, routine ${bs.air.routineGap} s; ${bs.air.hourCap} non-alarm alerts an hour at most. On a TM9100 each send steps out of CCR for ~25 s.</p></div>
        <div class="card"><div class="card-h"><h3>Waiting to send (${q.length})</h3>${q.length ? '<button class="btn small" data-qclear>Clear queue</button>' : ''}</div>
          ${q.length ? `<table class="tbl"><tbody>${q.map(x => `<tr><td><span class="ble-pr pr-${x.prio}">${PRIO_LABEL[x.prio]}</span></td><td class="mono">${x.to}</td><td>${esc(x.text)}${x.n > 1 ? ` <span class="dim small">(${x.n} joined)</span>` : ''}</td><td class="small dim">${x.tries ? `try ${x.tries + 1}` : ago(x.t)}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">Nothing waiting.</p>'}</div>
        ${telemCard(now, st)}
        ${escs.length ? `<div class="card"><div class="card-h"><h3>Repeating until cleared</h3><button class="btn small" data-ackall>✔ Acknowledge all</button></div><table class="tbl"><tbody>${escs.map(x => `<tr><td>${esc(x.text)}</td><td class="small dim">repeat ${x.count}, next ${B.clock(x.next)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="card"><div class="card-h"><h3>History</h3>${hist.alerts.length ? '<button class="btn small" data-hclear>Clear</button>' : ''}</div><div class="ble-scroll"><table class="tbl"><thead><tr><th>Time</th><th>Priority</th><th>To</th><th>Message</th><th>Bytes</th><th>Result</th></tr></thead><tbody>
          ${[...hist.alerts].reverse().slice(0, 150).map(a => `<tr><td class="small nowrap">${B.ago(a.t, now)}</td><td><span class="ble-pr pr-${a.prio}">${PRIO_LABEL[a.prio] || a.prio}</span></td><td class="mono small">${esc(a.to)}</td><td>${esc(a.text)}</td><td class="mono small">${a.size || B.bytes(a.text)}</td><td class="small st-${a.state}">${esc(a.state)}${a.note ? ` <span class="dim">${esc(a.note)}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">No alerts yet.</td></tr>'}</tbody></table></div></div>`;
    }

    // ---- adapters + remote nodes
    function healthBlock(h) {
      if (!h) return '<span class="dim">no report yet</span>';
      const bits = [];
      if (h.tempC != null) bits.push(`${h.tempC} °C`);
      if (h.uptime) bits.push(`up ${Math.round(h.uptime / 3600)} h`);
      if (h.throttle && h.throttle.length) bits.push(`<span class="bad">${esc(h.throttle.join(', '))}</span>`);
      if (h.ntp === false) bits.push('<span class="bad">clock not synced</span>');
      if (h.model) bits.push(esc(h.model));
      if (h.adverts != null) bits.push(`${h.adverts} adverts`);
      return `<b class="${h.ok === false || h.scanning === false ? 'bad' : 'good'}">${h.ok === false ? 'needs attention' : h.scanning === false ? `not scanning${h.error ? ': ' + esc(h.error) : ''}` : 'OK'}</b> ${bits.join(' · ')}${(h.fix || []).length ? `<ul class="ble-fix">${h.fix.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}`;
    }
    function nodesTab() {
      const now = Date.now(), ad = (link.hello || {}).adapters || [];
      root().querySelector('#ble-nodes').innerHTML = `
        <div class="card"><div class="card-h"><h3>This bridge's adapters</h3><span class="tag">zone ${esc((link.hello || {}).zone || '?')}</span></div>
          ${ad.length ? `<table class="tbl"><tbody>${ad.map(a => `<tr><td class="mono">${esc(a)}</td><td>${healthBlock(health[a])}</td></tr>`).join('')}</tbody></table>` : `<p class="dim">${link.state === 'up' ? 'The bridge has no adapter of its own (remote nodes only).' : 'Not linked to a bridge with BLE.'} On the Pi: <code>--ble hci0</code> on the bridge (Raspberry Pi onboard), <code>--ble hci0,hci1</code> with a USB dongle too.</p>`}
          <p class="dim small">Pi onboard Bluetooth shares its radio and antenna with Wi-Fi: scanning gets patchy when Wi-Fi is busy. For a busy site, or Wi-Fi backhaul, fit a USB dongle (TP-Link UB5A, or an nRF52840 dongle with Zephyr hci_usb) and scan on that.</p></div>
        <div class="card"><div class="card-h"><h3>Remote scanner nodes</h3></div>
          ${nodes.length ? `<div class="ble-scroll"><table class="tbl"><thead><tr><th>Node</th><th>Link</th><th>Backlog</th><th>Clock</th><th>Records</th><th>Health</th><th></th></tr></thead><tbody>${nodes.map(n => `
            <tr><td><b>${esc(n.name)}</b><div class="dim small">${esc(n.id)} · zone ${esc(n.zone)}${n.ver ? ` · v${esc(n.ver)}` : ''}${n.adapter ? ` · ${esc(n.adapter)}` : ''}</div></td>
            <td class="${n.up ? 'good' : 'bad'}">${n.up ? 'up' : 'down'}<div class="dim small">${n.lastHb ? 'heard ' + ago(n.lastHb) : 'never'}${n.addr ? ` · ${esc(n.addr)}` : ''}</div></td>
            <td class="mono">${n.buffered != null ? n.buffered : '—'}</td><td class="small">${n.drift != null ? `${(n.drift / 1000).toFixed(1)} s off` : '—'}${n.drift != null && Math.abs(n.drift) > 5000 ? ' <span class="bad">⚠</span>' : ''}<div class="dim small">${n.clock ? 'data to ' + B.clock(n.clock) : ''}</div></td>
            <td class="mono small">${n.recs || 0}${n.dropped ? ` <span class="bad">(${n.dropped} dropped)</span>` : ''}</td><td class="small">${healthBlock(n.health)}</td>
            <td class="nowrap"><button class="btn small" data-disc="${esc(n.id)}" ${n.up ? '' : 'disabled'}>${n.discoverUntil && n.discoverUntil > now ? '⏹ Discovery' : '🔎 Discover 10 min'}</button> <button class="btn small" data-rot="${esc(n.id)}">🔑 New token</button> <button class="btn small" data-rev="${esc(n.id)}">✕</button></td></tr>`).join('')}</tbody></table></div>`
            : '<p class="dim">None. A remote node is another Pi (a Zero 2 W does) running <code>bridge/kelly_ble_node.py</code>: the shed, the clubhouse, a repeater site. Its sightings reach this Kelly over the network and count as their own zone.</p>'}
          <p class="dim small">A node only forwards your registered devices (Discover lets it send everything for 10 minutes, to register a new beacon there). If its link drops it keeps what it hears and sends it later, in order -- so a slow node never makes a device "leave".</p></div>`;
    }
    function nodeAddForm() {
      const card = root().querySelector('#ble-node-add');
      card.innerHTML = `<div class="card-h"><h3>Add a remote node</h3></div>
        <div class="row gap wrap"><label class="fld"><span>Node id</span><input id="na-id" placeholder="shed" maxlength="32"></label><label class="fld"><span>Zone</span><input id="na-zone" placeholder="Shed" maxlength="32"></label><label class="fld"><span>Name</span><input id="na-name" placeholder="The shed" maxlength="40"></label><button class="btn" id="na-add">➕ Add</button></div>
        <div id="na-out"></div>
        <details class="dim small"><summary>How is a node kept safe?</summary><p>The link between a node and this bridge is ordinary IP (your LAN, Tailscale, 4G) -- it never touches P25 or the air. Each node gets its own token here; the bridge keeps only a hash of it, refuses any node it doesn't know, checks every record it sends and limits how fast it may send, and a node can't make Kelly transmit anything -- only your rules can, through the airtime limits. Across the internet, keep the link inside Tailscale (it's encrypted end to end), or put the bridge behind a TLS proxy and point the node at wss://. New token or ✕ cuts a node off at once.</p></details>`;
      card.querySelector('#na-add').onclick = () => nodeApi({ op: 'add', id: card.querySelector('#na-id').value.trim().toLowerCase(), zone: card.querySelector('#na-zone').value.trim(), name: card.querySelector('#na-name').value.trim() });
    }
    async function nodeApi(body) {
      if (k.demo()) { toast('🛰️', 'Not in the demo', 'Connect to a bridge to manage nodes', 'bad'); return; }
      if (body.op === 'revoke' && !confirm(`Remove node ${body.id}? Its token stops working at once.`)) return;
      try {
        const r = await fetch(apiUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.status);
        nodes = j.nodes || nodes;
        const out = root().querySelector('#na-out');
        if (j.token) {
          const host = (bleUrl().match(/^wss?:\/\/([^/?]+)/) || [])[1] || 'THIS-BRIDGE:8025';
          out.innerHTML = `<div class="ble-token"><b>Token for ${esc(body.id)}</b> -- shown once, copy it now:<pre class="mono">${esc(j.token)}</pre>
            On the node Pi (after unzipping Kelly there): <pre class="mono">sudo bash bridge/install-pi.sh --ble-node --server ${esc(host)} --node ${esc(body.id)} --token ${esc(j.token)}</pre></div>`;
        } else out.innerHTML = '';
        toast('🛰️', body.op === 'add' ? 'Node added' : body.op === 'rotate' ? 'New token made' : 'Node removed', body.id);
        dirty('ble');
      } catch (e) { toast('⚠️', 'Node change failed', e.message, 'bad'); }
    }

    // ---- settings
    function settingsForm() {
      const el = root().querySelector('#ble-settings'), p = bs.presence, a = bs.air, s = bs.snd;
      const num = (id, v, lab, extra = '') => `<label class="fld"><span>${lab}</span><input type="number" data-set="${id}" value="${esc(v)}" ${extra}></label>`;
      const chk = (id, v, lab) => `<label class="fld inline"><input type="checkbox" data-set="${id}"${v ? ' checked' : ''}> <span>${lab}</span></label>`;
      el.innerHTML = `
        <div class="card"><div class="card-h"><h3>Presence</h3></div><div class="row gap wrap">
          ${num('presence.arrive', p.arrive, 'Arrive at dBm')}${num('presence.depart', p.depart, 'Leave below dBm')}${num('presence.absenceSec', p.absenceSec, 'Absent after s', 'min="30"')}
          ${num('presence.minHits', p.minHits, 'Sightings to arrive', 'min="1"')}${num('presence.debounceSec', p.debounceSec, '…within s')}${num('presence.zoneHystDb', p.zoneHystDb, 'Zone change needs dB')}${num('presence.zoneSwitchSec', p.zoneSwitchSec, '…for s')}</div>
          <p class="dim small">Arrive and leave are separate thresholds so a device on the edge doesn't flap. A device must be heard strongly enough a couple of times to arrive, and gone (or too faint) for the whole absence time to leave. Already here when Kelly starts = no alert. Override per device in Devices.</p></div>
        <div class="card"><div class="card-h"><h3>Airtime budget</h3></div><div class="row gap wrap">
          ${num('air.alarmGap', a.alarmGap, 'Alarm gap s', 'min="10"')}${num('air.presenceGap', a.presenceGap, 'Presence gap s', 'min="30"')}${num('air.routineGap', a.routineGap, 'Routine gap s', 'min="60"')}${num('air.hourCap', a.hourCap, 'Per hour (non-alarm)', 'min="1"')}</div>
          <div class="row gap wrap">${num('nodeDownMin', bs.nodeDownMin, 'Node offline alert after min', 'min="0"')}<label class="fld grow"><span>…tell (radio IDs)</span><input data-set="nodeDownTo" value="${esc(bs.nodeDownTo)}" placeholder="1050002"></label></div></div>
        <div class="card"><div class="card-h"><h3>Sound and motion</h3><div class="row gap"><button class="btn small" data-snd="ping">Ping</button><button class="btn small" data-snd="arrive">Arrive</button><button class="btn small" data-snd="depart">Leave</button><button class="btn small" data-snd="tx">Data burst</button><button class="btn small" data-snd="alarm-info">Info</button><button class="btn small" data-snd="alarm-warning">Warning</button><button class="btn small" data-snd="alarm-critical">Critical</button><button class="btn small" data-snd="cw">CW callsign</button></div></div>
          <div class="row gap wrap">${chk('snd.on', s.on, 'BLE sounds')}${chk('snd.ping', s.ping, 'Sonar ping')}${chk('snd.arrive', s.arrive, 'Arrival')}${chk('snd.depart', s.depart, 'Departure')}${chk('snd.cw', s.cw, 'Callsign in CW on arrival')}${chk('snd.tx', s.tx, 'Data burst on send')}${chk('snd.alarm', s.alarm, 'Alert tones')}${chk('snd.alarmsOnly', s.alarmsOnly, 'Alarms only')}</div>
          <div class="row gap wrap"><label class="fld"><span>Volume</span><input type="range" min="0" max="1" step="0.05" data-set="snd.vol" value="${esc(s.vol)}"></label>${num('snd.cwWpm', s.cwWpm, 'CW WPM', 'min="5" max="40"')}${num('snd.cwHz', s.cwHz, 'CW pitch Hz', 'min="300" max="1200"')}<label class="fld"><span>Quiet hours</span><input data-set="snd.quiet" value="${esc(s.quiet)}" placeholder="22:00-06:00"></label>${chk('anim', bs.anim, 'Animations')}</div>
          <p class="dim small">Kelly's own Sound switch (Admin) mutes these too. Animations also stop with Admin › Effects off or the system's reduce-motion setting.</p></div>
        <div class="card" data-ent="bridge.ble2p25"><div class="card-h"><h3>📈 Telemetry to the P25X gateway</h3></div>
          <div class="row gap wrap">${chk('telem.on', bs.telem.on, 'Send readings of the devices marked for it')}${num('telem.heartbeatMin', bs.telem.heartbeatMin, 'Heartbeat min', 'min="5"')}${num('telem.gap', bs.telem.gap, 'At most one frame every s', 'min="60"')}</div>
          <p class="dim small">Sensor readings (and here / away of devices you mark) go to the P25X gateway as small Kelly frames over P25 data, and from there to MQTT and the P25X BLE Telemetry dashboard in Grafana. Needs a TM9100 (Kelly frames over P25 Transparent). They wait behind every alert and never count against the alert limit. Club members can read the gateway's MQTT and Grafana -- mark only what you're happy to share.</p></div>
        <div class="card"><div class="card-h"><h3>Bridge</h3></div><label class="fld grow"><span>BLE bridge address (blank = the radio's bridge)</span><input data-set="bridgeUrl" value="${esc(bs.bridgeUrl)}" placeholder="192.168.1.50:8025?token=…"></label>
          <p class="dim small">Now: <span class="mono">${esc(bleUrl().replace(/token=[^&]+/, 'token=…'))}</span></p></div>`;
      el.querySelectorAll('[data-set]').forEach(i => { i.onchange = () => {
        const path = i.dataset.set.split('.'); let o = bs; while (path.length > 1) o = o[path.shift()];
        o[path[0]] = i.type === 'checkbox' ? i.checked : i.type === 'number' || i.type === 'range' ? +i.value : i.value.trim();
        Object.assign(air.opts.gap, airOpts().gap); air.opts.hourCap = +bs.air.hourCap;
        tele.opts.heartbeatMin = Math.max(5, +bs.telem.heartbeatMin || 30);
        if (i.dataset.set === 'bridgeUrl' && bs.on) { disconnect(); connect(); }
        save(); dirty('ble');
      }; });
    }

    // one click for a pet: "left home" as an alarm (repeats every 15 min until it's back or you reply ACK), "back home"
    const petRulesFor = id => Object.values(bs.rules).some(r => r.dev === id && (r.on === 'depart' || r.on === 'arrive'));
    function addPetRules(id) {
      let to = String(bs.lastTo || '').trim();
      if (!B.units(to).length) to = (prompt('Which radio IDs should hear about it? (e.g. your handheld)', '') || '').trim();
      if (!B.units(to).length) return;
      const t = Date.now().toString(36);
      bs.rules['r' + t + 'a'] = { en: true, on: 'depart', dev: id, zone: '', to, tpl: '{device} has left home! Last seen {last_seen}', prio: 'alarm', cool: 30, quiet: '', esc: 15, escMax: 3 };
      bs.rules['r' + t + 'b'] = { en: true, on: 'arrive', dev: id, zone: '', to, tpl: '{device} is back home {time}', prio: 'presence', cool: 10, quiet: '' };
      bs.lastTo = to; save(); dirty('ble');
      toast('🐾', 'Pet alerts on', `${devName(id)}: an alarm when it leaves (repeats until it's back or you reply ACK), a text when it's back`);
    }
    function onClick(e) {
      const t = e.target.closest('button,input[type=checkbox]'); if (!t) return;
      const d = t.dataset;
      if (d.reg) devForm(null, d.reg);
      else if (d.edit) devForm(d.edit, null);
      else if (d.del) { if (confirm(`Forget ${devName(d.del)}?`)) { delete bs.devices[d.del]; presence.forget(d.del); delete live[d.del]; if (ui.find === d.del) ui.find = null; devsChanged(); } }
      else if (d.find) { ui.find = ui.find === d.find ? null : d.find; nextClick = 0; dirty('ble'); }
      else if (d.redit) ruleForm(d.redit);
      else if (d.rdel) { if (confirm('Delete this rule?')) { delete bs.rules[d.rdel]; save(); dirty('ble'); } }
      else if (d.ren) { if (bs.rules[d.ren]) { bs.rules[d.ren].en = t.checked; save(); } }
      else if (d.close != null) t.closest('.card').hidden = true;
      else if (d.qclear != null) { air.queue().forEach(x => air.done(Object.assign(x, { tries: 99 }), false, Date.now())); for (const a of hist.alerts) if (a.state === 'queued') a.state = 'cancelled'; saveHist(); dirty('ble'); }
      else if (d.hclear != null) { hist.alerts = []; saveHist(); dirty('ble'); }
      else if (d.ackall != null) { const n = rules.ack(); toast('✔', 'Acknowledged', `${n} repeating alert${n === 1 ? '' : 's'} stopped`); dirty('ble'); }
      else if (d.disc) { const n = nodes.find(x => x.id === d.disc); if (link.ws) link.ws.send(JSON.stringify({ t: 'discover', node: d.disc, min: n && n.discoverUntil > Date.now() ? 0 : 10 })); }
      else if (d.rot) { if (confirm(`Make a new token for ${d.rot}? The old one stops working at once.`)) nodeApi({ op: 'rotate', id: d.rot }); }
      else if (d.rev) nodeApi({ op: 'revoke', id: d.rev });
      else if (d.petrules) addPetRules(d.petrules);
      else if (d.phonenew != null) { if (ui.tab !== 'devices') { ui.tab = 'devices'; showTab(); render(); } phoneCard(null); }
      else if (d.phone) phoneCard(d.phone);
      else if (d.copy && ui.phone) copyText(String(ui.phone[d.copy]));
      else if (d.tlmnow != null) { tele.forceBeat(); air.push({ to: [gatewayId()], text: 'BLE telemetry', prio: 'telem' }, Date.now()); toast('📈', 'Telemetry queued', `It goes when the queue allows (at most every ${bs.telem.gap} s)`); dirty('ble'); }
      else if (d.snd) { if (d.snd === 'cw') cw(k.myCall() || 'VK4ABC', true); else sfx(d.snd, true); }
    }

    return {
      init() {
        const api = { k, B, bs, esc, toast, addEvent, dirty, save, store, devices, live, sfx, cw, devName, icon, tn,
          registry: () => registry, presence: () => presence, link, nodes: () => nodes,
          visible: id => k.currentPage() === 'ble' && ui.tab === id,
          send: msg => { if (link.ws && link.ws.readyState === 1) link.ws.send(JSON.stringify(msg)); },
          // a game event over the air: lowest priority, behind every real alert
          announce: (text, to) => { const t = B.units(to); if (t.length) air.push({ to: t, text: B.fit(text), prio: 'game', rule: 'game' }, Date.now()); return t.length; },
          // the page's own decoder list changed (Inspector's builder): ble.js decode uses it from now on
          setDecoders: list => { B.custom.length = 0; for (const c of list) B.custom.push([c.spec.name, rec => c.decode(rec)]); } };
        plugins = (window.KellyBlePlugins || []).map(f => { try { return f(api) || {}; } catch (e) { console.error('ble plugin', e); return {}; } });
        telemNumbers();
        tickTimer =setInterval(() => { if (k.demo()) { if (!demoTimer) demoStart(); } else if (demoTimer) { demoStop(); if (bs.on) connect(); } tick(); }, 1000);
        if (bs.on && !k.demo()) connect();
      },
      render,
      shown() { ui.sweep = true; if (k.demo() && !demoTimer) demoStart(); render(); },
      // "ACK" (or a gateway-forwarded "CALL: ACK") from a radio stops the repeating alerts
      onP25Text(m) {
        if (m.dir !== 'in' || !/(^|:\s*)ACK\b/i.test(m.text || '')) return;
        const n = rules.ack(); if (!n) return;
        addEvent('data', `BLE: ${n} repeating alert${n === 1 ? '' : 's'} acknowledged by radio`); toast('✔', 'BLE alert acknowledged', m.text); dirty('ble');
      },
    };
  };
})();
