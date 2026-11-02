/* Kelly Page -- LoRa Mesh > 🛡️ Property Guard tab (2026-10-25, unreleased): a CONCEPT and interactive demo, nothing
 * goes on air. Shows how a ham could guard an unattended tractor shed on a remote block with a RAK4631 WisBlock
 * (nRF52840 + SX1262) on a RAK13002 IO board -- a budget of 6 digital + 2 analog inputs -- reporting over MeshCore
 * through an off-grid SenseCAP solar repeater to the home station. The remote block is MeshCore ONLY (decided
 * 2026-10-25): P25 lives at the ham's house, where this Kelly runs the alarm logic and turns the events the ham ticks
 * in "P25 message triggers" into P25 texts from the home radio. Arm / disarm / acknowledge are Kelly buttons at home;
 * the shed only reports. A second RAK4631 (node B) takes the far zone once node A's channels are used up. Everything
 * is simulated in the page; no device code.
 * The monitoring model it shows: DIs are interrupts (an event the moment they change, debounced), AIs are polled every
 * POLL_MS against a threshold, every node sends a heartbeat (a node that misses MISS of them is flagged silent), and
 * Disarmed / Armed / Entry / Alarm with an entry delay that correlation (radar -> gate beam -> seismic -> door) skips.
 *
 * window.KellyPropertyGuardUI(k) -> { init(), shown(), hidden() }; k from mesh.js: { $, esc, store, toast, settings,
 *   audioCtx }. index.html#pg-demo opens the tab and plays the scripted intrusion.
 * Nothing loops forever (kelly-page/CLAUDE.md): flashes run 3 times, the siren once; the tick only runs while the tab
 * is visible or the demo plays. Sound is off until the user turns it on (store 'pg.sound').
 * Stored: 'pg.trig' { alarm, warn, entry, silent, lowbatt, tank, arm } (TRIGS defaults), 'pg.trigCh' [channel ids whose
 * trips send a text], 'pg.trigArmed' (channel trips only while armed, default true), 'pg.to' (who the texts go to).
 */
(function () {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const POLL_MS = 2000, TICK_MS = 500, ENTRY_MS = 20000, DEBOUNCE_MS = 300, SEIS_TH = 35, LOWBATT = 3.5, TANK_LOW = 20, MISS = 3;
  // the simulated heartbeat: 15 s here stands for the 15 min a real node would use
  const HB_MS = { A: 15000, B: 15000, R: 20000 };
  // map positions (SVG user units, viewBox 900 x 540)
  const XY = { A: [628, 172], B: [790, 438], R: [300, 96], H: [70, 64], X: [70, 186] };   // X = the home P25 radio
  // the P25 message triggers the ham picks in Kelly at home: [id, label, on by default]
  const TRIGS = [['alarm', '🚨 Alarm', true], ['warn', '⚠️ Pre-alarm warning (threat 80+)', true], ['entry', '⏱️ Entry delay started', false],
    ['silent', '💀 Node silent (missed heartbeats)', true], ['lowbatt', '🔋 Low battery', true], ['tank', '💧 Tank low', true], ['arm', '🔒 Armed / disarmed', false]];
  const NODES = {
    A: { name: 'Node A · Shed', hw: 'RAK4631 + RAK13002 · LiPo + small panel', io: { di: 6, ai: 2 } },
    B: { name: 'Node B · Tank paddock', hw: 'RAK4631 + RAK13002 · LiPo + small panel', io: { di: 2, ai: 2 } },
    R: { name: 'Repeater · Ridge', hw: 'SenseCAP solar node · MeshCore repeater firmware' },
  };
  const CH = [
    { id: 'A-DI1', node: 'A', io: 'DI1', name: 'Shed door', icon: '🚪', kind: 'toggle', w: 30, on: 'OPEN', off: 'CLOSED',
      wire: 'Magnetic reed, normally closed, pull-up -- interrupt on both edges. Entry zone (20 s delay).' },
    { id: 'A-DI2', node: 'A', io: 'DI2', name: 'Window', icon: '🪟', kind: 'toggle', w: 40, on: 'OPEN', off: 'CLOSED',
      wire: 'Magnetic reed, normally closed. Instant zone -- nobody comes home through the window.' },
    { id: 'A-DI3', node: 'A', io: 'DI3', name: 'Indoor PIR', icon: '🧍', kind: 'pulse', hold: 4000, w: 30, on: 'MOTION', off: 'QUIET',
      wire: 'Low-power PIR (tens of µA), open-collector out. Follows the door during entry, instant otherwise.' },
    { id: 'A-DI4', node: 'A', io: 'DI4', name: 'Driveway radar', icon: '📡', kind: 'pulse', hold: 3000, w: 20, on: 'TARGET', off: 'CLEAR',
      wire: 'Microwave motion detector on the shed corner, aimed down the driveway. NC relay contact.' },
    { id: 'A-DI5', node: 'A', io: 'DI5', name: 'Gate beam', icon: '🚧', kind: 'pulse', hold: 1200, w: 25, on: 'BROKEN', off: 'CLEAR',
      wire: 'PE break-beam pair across the gate -- the choke point every vehicle passes. NC relay contact.' },
    { id: 'A-DI6', node: 'A', io: 'DI6', name: 'Shed-entrance beam', icon: '🔦', kind: 'pulse', hold: 1200, w: 20, on: 'BROKEN', off: 'CLEAR',
      wire: 'PE break-beam pair across the approach to the shed door. NC relay contact.' },
    { id: 'A-AI1', node: 'A', io: 'AI1', name: 'Seismic line', icon: '👣', kind: 'seis', w: 20,
      wire: `Buried geophone -> op-amp + envelope detector -> 0-3 V. Polled every ${POLL_MS / 1000} s; an event when over ${SEIS_TH}% on 2 polls running.` },
    { id: 'A-AI2', node: 'A', io: 'AI2', name: 'Supply', icon: '🔋', kind: 'batt',
      wire: `Node battery through a divider. Polled; a low-battery event below ${LOWBATT} V.` },
    { id: 'B-DI1', node: 'B', io: 'DI1', name: 'Back gate chain', icon: '⛓️', kind: 'toggle', w: 20, on: 'OPEN', off: 'CLOSED',
      wire: 'Reed switch on the back-paddock gate.' },
    { id: 'B-DI2', node: 'B', io: 'DI2', name: 'Pump-stand PIR', icon: '🐾', kind: 'pulse', hold: 4000, w: 15, on: 'MOTION', off: 'QUIET',
      wire: 'Outdoor PIR on the pump and tank stand (pumps walk off rural blocks).' },
    { id: 'B-AI1', node: 'B', io: 'AI1', name: 'Tank level', icon: '💧', kind: 'tank',
      wire: `0.5-4.5 V pressure sender through a divider. Polled; an event below ${TANK_LOW}%.` },
    { id: 'B-AI2', node: 'B', io: 'AI2', name: 'Supply', icon: '🔋', kind: 'batt',
      wire: 'Node battery through a divider. Polled.' },
  ];
  const CHI = Object.fromEntries(CH.map(c => [c.id, c]));
  const LEVELS = [[80, 'Intrusion', 'bad'], [50, 'Suspicious', 'warn'], [20, 'Watch', 'watch'], [0, 'Quiet', 'ok']];
  const STATES = { disarmed: ['DISARMED', 'Logging only'], armed: ['ARMED', 'Watching every zone'], entry: ['ENTRY DELAY', ''], alarm: ['ALARM', 'Latched until disarmed'] };
  const fmtT = ms => new Date(ms).toLocaleTimeString([], { hour12: false });

  window.KellyPropertyGuardUI = function (k) {
    const esc = k.esc;
    let root = null, vis = false, timer = null, demo = null;
    let snd = !!k.store.get('pg.sound', false), showHb = !!k.store.get('pg.hb', false);
    const trig = Object.assign(Object.fromEntries(TRIGS.map(t => [t[0], t[2]])), k.store.get('pg.trig', {}));
    let trigCh = k.store.get('pg.trigCh', []), trigArmed = k.store.get('pg.trigArmed', true) !== false, sendTo = String(k.store.get('pg.to', '') || '');
    if (!Array.isArray(trigCh)) trigCh = [];
    const trigOn = t => t.startsWith('ch:') ? trigCh.includes(t.slice(3)) && (!trigArmed || arm !== 'disarmed') : !!trig[t];
    const trigLabel = t => t.startsWith('ch:') ? `${CHI[t.slice(3)].name} trips` : (TRIGS.find(x => x[0] === t) || [t, t])[1];
    const S = {}, N = {}, log = [], msgs = [];
    let arm, entryEnd, threat, chain, lastPoll, bounces, lastWarn, kick, siren, acked, figs = [], epoch = 0;   // epoch: a reset drops packets still hopping

    function reset() {
      const now = Date.now(); epoch++;
      for (const c of CH) { if (S[c.id] && S[c.id].tm) clearTimeout(S[c.id].tm);
        S[c.id] = { on: false, v: c.kind === 'seis' ? 4 : c.kind === 'batt' ? 3.96 : c.kind === 'tank' ? 72 : 0, at: now, n: 0, hist: [], over: 0 }; }
      for (const id of ['A', 'B', 'R']) N[id] = { hb: now, cut: false, seq: 0, silent: false, low: false, cloudy: false, pct: 84 };
      arm = 'disarmed'; entryEnd = 0; threat = 0; chain = []; lastPoll = 0; bounces = 0; lastWarn = 0; kick = 0; acked = false;
      stopSiren(); log.length = 0; msgs.length = 0;
      for (const a of figs) { try { a.cancel(); } catch (e) { /* gone */ } } figs = [];
      if (root) root.querySelectorAll('.pg-sens.on').forEach(el => el.classList.remove('on'));
    }

    // ------------------------------------------------------------ sound (Web Audio; off by default)
    const vol = () => (k.settings && k.settings.soundVol != null ? k.settings.soundVol : 0.7);
    function tone(f0, f1, dur, type, gain, when) {
      if (!snd || !k.audioCtx) return null;
      try {
        const ctx = k.audioCtx(), t = ctx.currentTime + (when || 0), o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * vol()), t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.03); return o;
      } catch (e) { return null; }
    }
    const blip = () => { tone(880, 1320, 0.09, 'square', 0.12); };
    const chirp = soft => { tone(1900, 2700, 0.05, 'sine', soft ? 0.025 : 0.08); };
    const p25Tone = () => { tone(1200, 1200, 0.08, 'triangle', 0.15); tone(1600, 1600, 0.12, 'triangle', 0.15, 0.1); };
    const armTone = up => { [0, 1, 2].forEach(i => tone(up ? 520 + i * 180 : 880 - i * 180, up ? 520 + i * 180 : 880 - i * 180, 0.1, 'triangle', 0.14, i * 0.12)); };
    function playSiren() {   // two-tone, 4 s, once
      if (!snd || !k.audioCtx || Date.now() - (siren && siren.at || 0) < 30000) return;
      try {
        const ctx = k.audioCtx(), t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth';
        for (let i = 0; i < 12; i++) o.frequency.setValueAtTime(i % 2 ? 960 : 660, t + i * 0.33);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09 * vol() + 0.0002, t + 0.05);
        g.gain.setValueAtTime(0.09 * vol() + 0.0002, t + 3.8); g.gain.exponentialRampToValueAtTime(0.0001, t + 4);
        o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 4.05);
        siren = { o, at: Date.now() }; o.onended = () => { if (siren && siren.o === o) siren.o = null; };
      } catch (e) { /* no audio */ }
    }
    function stopSiren() { if (siren && siren.o) { try { siren.o.stop(); } catch (e) { /* already stopped */ } siren.o = null; } }

    // ------------------------------------------------------------ the mesh: packets hop node -> repeater -> home (-> the home P25 radio)
    const q = s => root && root.querySelector(s);
    function hop(a, b, cls, ms) {
      return new Promise(res => {
        const fx = q('#pg-fx');
        if (!fx || !vis || !fx.animate) { res(); return; }
        const [x1, y1] = XY[a], [x2, y2] = XY[b];
        const dot = document.createElementNS(SVGNS, 'circle');
        dot.setAttribute('r', '7'); dot.setAttribute('class', 'pg-pkt ' + (cls || ''));
        fx.appendChild(dot);
        const ln = q(`#pg-l-${[a, b].sort().join('')}`); if (ln) { ln.classList.add('lit'); setTimeout(() => ln.classList.remove('lit'), (ms || 650) + 150); }
        const an = dot.animate([{ transform: `translate(${x1}px, ${y1}px)`, opacity: 0 }, { transform: `translate(${x1}px, ${y1}px)`, opacity: 1, offset: 0.1 },
          { transform: `translate(${x2}px, ${y2}px)`, opacity: 1 }], { duration: ms || 650, easing: 'ease-in-out' });
        const done = () => { dot.remove(); res(); };
        an.onfinish = done; an.oncancel = done;
      });
    }
    async function route(path, cls, soft) {
      for (let i = 0; i < path.length - 1; i++) { chirp(soft); await hop(path[i], path[i + 1], cls); }
    }
    async function send(node, text, ack) {   // node -> home over the mesh (an event is a DM to the home companion: ACKed)
      const n = N[node]; if (n.cut) return;
      n.seq++; const msg = `${node} ${text} #${n.seq}`;
      addLog('mesh', `${node} → home via ridge repeater: "${msg}" (${msg.length + 9} B on air)`);
      const ep = epoch; await route([node, 'R', 'H'], ack ? 'ev' : 'hb');
      if (ack && ep === epoch) addLog('mesh', `ACK ✓ ${node} #${n.seq} in ${(0.9 + Math.random() * 0.7).toFixed(1)} s`);
    }
    // Kelly at home -> the home P25 radio (CCDI) -> on air. Only when the ham ticked that trigger; the shed has no P25
    async function p25(text, kind, t) {
      if (t && !trigOn(t)) { addLog('info', `P25 trigger "${trigLabel(t)}" is off -- no text sent`); return; }
      const ep = epoch; await route(['H', 'X'], 'p25');
      if (ep !== epoch) return;
      msgs.unshift({ at: Date.now(), text, kind, to: sendTo }); msgs.splice(30);
      addLog('p25', `Kelly sent a P25 text from the home radio (${text.length} chars): ${text}`);
      p25Tone(); renderMsgs();
    }
    function chanTrig(c, state) { p25(`PG ${c.name} ${c.node}.${c.io} ${state} ${fmtT(Date.now())}`, 'info', `ch:${c.id}`); }

    // ------------------------------------------------------------ sensors
    function setDI(id, on, src) {
      const c = CHI[id], s = S[id], now = Date.now();
      if (c.kind === 'pulse' && on && s.on) { clearTimeout(s.tm); s.tm = setTimeout(() => setDI(id, false, 'auto'), c.hold); return; }
      if (s.on === on) return;
      if (src === 'user' && now - (s.uat || 0) < DEBOUNCE_MS) { bounces++; addLog('info', `${c.node}·${c.io} ${c.name}: change inside ${DEBOUNCE_MS} ms ignored (debounce)`); updHead(); return; }
      if (src === 'user') s.uat = now;
      s.on = on; s.at = now; if (on) s.n++;
      if (c.kind === 'pulse' && on) { clearTimeout(s.tm); s.tm = setTimeout(() => setDI(id, false, 'auto'), c.hold); }
      updTile(id, on); mapSensor(id, on);
      if (N[c.node].cut) return;   // the wire changed; a dead node tells nobody
      if (on) blip();
      addLog(on ? 'ev' : 'info', `${c.node}·${c.io} ${c.name}: ${on ? c.on : c.off} (interrupt)`);
      send(c.node, `ev ${c.io}=${on ? 1 : 0}`, true);
      if (on) { judge(c); if (trigCh.includes(id)) chanTrig(c, c.on); }
    }

    function poll() {
      const now = Date.now(), sun = sunNow();
      const s = S['A-AI1'];
      if (!N.A.cut) {
        s.v = Math.min(100, 2 + Math.random() * 5 + kick); kick *= 0.45;
        s.hist.push(s.v); if (s.hist.length > 40) s.hist.shift();
        if (s.v >= SEIS_TH) {
          if (++s.over === 2) {
            s.at = now; s.n++; blip(); mapSensor('A-AI1', true);
            addLog('ev', `A·AI1 Seismic line: ${Math.round(s.v)}% -- over ${SEIS_TH}% on 2 polls (footsteps / vehicle)`);
            send('A', `ev AI1=${Math.round(s.v)}`, true); judge(CHI['A-AI1'], 'Seismic');
            if (trigCh.includes('A-AI1')) chanTrig(CHI['A-AI1'], `${Math.round(s.v)}%`);
          }
        } else { if (s.over >= 2) mapSensor('A-AI1', false); s.over = 0; }
      }
      for (const node of ['A', 'B']) {
        const b = S[`${node}-AI2`], n = N[node]; if (n.cut) continue;
        b.v = Math.max(3.3, Math.min(4.15, b.v + (n.cloudy ? -0.03 : sun > 0.2 ? 0.004 * sun : -0.0008)));
        if (b.v < LOWBATT && !n.low) { n.low = true; b.at = now; addLog('warn', `${node}·AI2 Supply ${b.v.toFixed(2)} V -- under ${LOWBATT} V`);
          send(node, `ev AI2=${b.v.toFixed(2)}`, true); p25(`PG LOW BATTERY ${NODES[node].name}: ${b.v.toFixed(2)} V. Check the panel.`, 'warn', 'lowbatt'); }
        else if (b.v > LOWBATT + 0.1 && n.low) { n.low = false; addLog('info', `${node}·AI2 Supply back to ${b.v.toFixed(2)} V`); }
        updTile(`${node}-AI2`);
      }
      const t = S['B-AI1'];
      if (!N.B.cut) {
        const was = t.v; t.v = Math.max(0, t.v - (t.drain ? 2.5 : 0.01));
        if (t.v < TANK_LOW && was >= TANK_LOW) { t.at = now; t.n++; addLog('warn', `B·AI1 Tank level ${Math.round(t.v)}% -- under ${TANK_LOW}%`);
          send('B', `ev AI1=${Math.round(t.v)}`, true); p25(`PG TANK LOW: tank paddock at ${Math.round(t.v)}%, falling. Leak, open tap -- or someone filling up?`, 'warn', 'tank'); }
        updTile('B-AI1');
      }
      N.R.pct = Math.max(5, Math.min(100, N.R.pct + (sun > 0.15 ? 0.05 * sun : -0.012)));
      updTile('A-AI1');
    }
    const sunNow = () => { const d = new Date(), h = d.getHours() + d.getMinutes() / 60; return Math.max(0, Math.sin(Math.PI * (h - 6) / 13)); };

    function beat(id) {
      const n = N[id]; n.hb = Date.now();
      if (id === 'R') { if (showHb) addLog('hb', `Ridge repeater advert · battery ${Math.round(n.pct)}% · ${sunNow() > 0.15 ? 'charging' : 'night'}`); if (vis) route(['R', 'H'], 'hb', true); return; }
      n.seq++;
      if (showHb) addLog('hb', `${id} heartbeat #${n.seq} · ${S[`${id}-AI2`].v.toFixed(2)} V · all inputs reported`);
      if (vis) route([id, 'R', 'H'], 'hb', true);
    }
    function silent(id) {
      const n = N[id]; n.silent = true;
      addLog('warn', `${NODES[id].name} SILENT -- ${MISS} heartbeats missed (last heard ${fmtT(n.hb)})`);
      p25(`PG NODE SILENT: ${NODES[id].name} missed ${MISS} heartbeats, last heard ${fmtT(n.hb)}. Flat battery or tampering?`, 'warn', 'silent');
      if (arm !== 'disarmed') { threat = Math.min(100, threat + 20); chain.push({ at: Date.now(), label: `${id} silent`, icon: '💀' }); }
      updNodes();
    }

    // ------------------------------------------------------------ the alarm state machine + correlation
    function judge(c, label) {
      const now = Date.now();
      chain = chain.filter(x => now - x.at < 180000);
      const seq = chain.length && now - chain[chain.length - 1].at < 60000;
      threat = Math.min(100, threat + (c.w || 0) + (seq ? 10 : 0));
      chain.push({ at: now, label: label || c.name, icon: c.icon }); if (chain.length > 8) chain.shift();
      if (arm === 'disarmed' || arm === 'alarm') { updThreat(); return; }
      const why = chain.map(x => x.label).join(' > ');
      if (c.id === 'A-DI2') alarm(c, 'window opened -- instant zone');
      else if (c.id === 'A-DI1') { if (threat >= 50) alarm(c, `correlated chain (threat ${Math.round(threat)}) -- entry delay skipped`); else if (arm === 'armed') startEntry(); }
      else if (c.id === 'A-DI3') { if (arm === 'armed') alarm(c, 'movement inside with no door opened'); }
      else if (threat >= 80 && now - lastWarn > 120000) {
        lastWarn = now; addLog('warn', `Pre-alarm: ${why} (threat ${Math.round(threat)})`);
        p25(`PG WARNING shed: ${why}. Threat ${Math.round(threat)}. Still armed.`, 'warn', 'warn');
      }
      updThreat(); updHead();
    }
    function startEntry() {
      arm = 'entry'; entryEnd = Date.now() + ENTRY_MS;
      addLog('warn', `Door opened while armed, nothing else seen -- ${ENTRY_MS / 1000} s entry delay. Disarm in Kelly.`);
      p25(`PG ENTRY shed: door opened ${fmtT(Date.now())}, ${ENTRY_MS / 1000} s to disarm.`, 'warn', 'entry');
      updHead();
    }
    function alarm(c, why) {
      if (arm === 'alarm') return;
      arm = 'alarm'; acked = false;
      const chainTxt = chain.map(x => x.label).join('>');
      addLog('alarm', `ALARM -- ${c.node}·${c.io} ${c.name}: ${why}`);
      playSiren(); flashEl(q('.pg-state'));
      p25(`PG ALARM shed: ${c.name} ${c.node}.${c.io} ${fmtT(Date.now())}. ${chainTxt}.`, 'alarm', 'alarm');
      updHead(); updThreat();
    }
    // arm / disarm / acknowledge happen in Kelly at home: the alarm logic is here, the shed node only reports
    function doArm(on) {
      if (on) {
        if (arm !== 'disarmed') return;
        const open = CH.filter(c => c.node === 'A' && c.kind === 'toggle' && S[c.id].on);
        if (open.length) {
          const what = open.map(c => `${c.name} (${c.io})`).join(', ');
          addLog('warn', `Not armed: ${what} open`);
          if (k.toast) k.toast('🛡️', "Property Guard can't arm", `${what} open`, 'bad');
          return;
        }
        arm = 'armed'; threat = 0; chain = []; armTone(true);
        addLog('info', 'Armed in Kelly at home -- every shed zone reported closed');
        p25('PG armed: shed (node A) all zones closed, tank paddock (node B) watching.', 'ok', 'arm');
      } else {
        if (arm === 'disarmed') return;
        arm = 'disarmed'; entryEnd = 0; threat = 0; chain = []; stopSiren(); armTone(false);
        addLog('info', 'Disarmed in Kelly at home');
        p25('PG disarmed. Event log kept in Kelly.', 'ok', 'arm');
      }
      updHead(); updThreat();
    }
    function doAck() {
      if (arm !== 'alarm' || acked) return;
      acked = true; stopSiren(); addLog('info', 'Alarm acknowledged in Kelly -- siren off, still latched until disarmed');
      updHead();
    }

    // ------------------------------------------------------------ tick (only while visible or the demo plays)
    function tick() {
      const now = Date.now();
      if (arm !== 'alarm') threat = Math.max(0, threat - TICK_MS / 1000);
      if (arm === 'entry' && now >= entryEnd) alarm(CHI['A-DI1'], 'entry delay ran out, nobody disarmed');
      if (now - lastPoll >= POLL_MS) { lastPoll = now; poll(); }
      for (const id of ['A', 'B', 'R']) {
        const n = N[id];
        if (!n.cut && now - n.hb >= HB_MS[id]) beat(id);
        if (n.cut && !n.silent && now - n.hb >= HB_MS[id] * MISS) silent(id);
      }
      updThreat(); updNodes(); updHead();
    }
    function run() {
      const want = vis || !!demo;
      if (want && !timer) { timer = setInterval(tick, TICK_MS); for (const n of Object.values(N)) n.hb = Math.max(n.hb, Date.now() - 2000); }
      else if (!want && timer) { clearInterval(timer); timer = null; }
    }
    function checkVis() {
      const v = !!(root && root.offsetParent !== null && !document.hidden);
      if (v !== vis) { vis = v; if (v) { renderLog(); renderMsgs(); updAll(); } }
      run();
    }

    // ------------------------------------------------------------ the scripted intrusion
    function narrate(text) { const el = q('#pg-narr'); if (!el) return; el.hidden = !text; el.textContent = text || ''; if (text) flashEl(el, 1); }
    function walk(id, pts, ms) {
      const el = q(id); if (!el || !el.animate) return;
      const an = el.animate(pts.map(([x, y]) => ({ transform: `translate(${x}px, ${y}px)`, opacity: 1 })), { duration: ms, fill: 'forwards', easing: 'linear' });
      figs.push(an);
    }
    function hideFig(id) { const el = q(id); if (el && el.animate) figs.push(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards', composite: 'replace' })); }
    const DRIVE = [[110, 528], [180, 462], [250, 392], [345, 304], [420, 262], [452, 248]];
    function startDemo() {
      if (demo) return stopDemo();
      reset(); renderLog(); renderMsgs(); updAll();
      const tm = [], at = (ms, fn) => tm.push(setTimeout(() => { try { fn(); } catch (e) { console.warn('Property Guard demo', e); } }, ms));
      demo = { tm }; run(); updHead();
      addLog('info', '▶ Demo: a scripted intrusion at the tractor shed');
      at(0, () => { narrate('1 · 21:47 on a dark rural block -- MeshCore only, no P25 out there. At home you press Arm in Kelly.'); doArm(true); });
      at(3500, () => { narrate('2 · Headlights. The microwave radar on the shed corner (DI4) picks up a vehicle coming down the driveway.'); walk('#pg-car', DRIVE, 5200); });
      at(4800, () => setDI('A-DI4', true));
      at(8200, () => { narrate('3 · 4 s later the gate beam (DI5) breaks. Radar, then the gate: that is a vehicle coming in, not a wallaby. Threat climbs.'); setDI('A-DI5', true); });
      at(10000, () => { narrate('4 · Engine off. Footsteps on the buried geophone line (AI1) -- an analog input, so the node polls it and compares with a threshold.'); walk('#pg-man', [[452, 248], [500, 228], [532, 206]], 4600); });
      for (const d of [10400, 11600, 12800, 13900]) at(d, () => { kick += 42; });
      at(15000, () => { narrate('5 · Someone crosses the shed-entrance beam (DI6). The chain is radar > gate > seismic > beam.'); setDI('A-DI6', true); });
      at(16800, () => { narrate('6 · The shed door opens (DI1). With that chain behind it Kelly skips the entry delay -- ALARM.'); walk('#pg-man', [[532, 206], [562, 192]], 900); setDI('A-DI1', true); });
      at(18600, () => setDI('A-DI3', true));
      at(19600, () => narrate('7 · The events hopped node A > ridge repeater > your home companion over MeshCore. "Alarm" is ticked in P25 message triggers, so Kelly sends a P25 text from your home radio.'));
      at(24500, () => { narrate('8 · You press Acknowledge in Kelly: siren off, the alarm stays latched and the shed keeps reporting.'); doAck(); });
      at(28500, () => { narrate('9 · They bolt. Door, beam, seismic, gate, radar -- every move still logged.'); setDI('A-DI1', false); walk('#pg-man', [[562, 192], [500, 228], [452, 248]], 2200); kick += 55; });
      at(30200, () => { hideFig('#pg-man'); setDI('A-DI6', true); kick += 40; });
      at(31200, () => walk('#pg-car', DRIVE.slice().reverse(), 4200));
      at(32400, () => setDI('A-DI5', true));
      at(33600, () => setDI('A-DI4', true));
      at(35600, () => hideFig('#pg-car'));
      at(37000, () => { narrate('Done. Pick which events send P25 texts, trip sensors yourself, pull node B\'s battery, or disarm.'); demo = null; run(); updHead(); });
      at(48000, () => { if (!demo) narrate(''); });
    }
    function stopDemo() {
      if (!demo) return; for (const t of demo.tm) clearTimeout(t); demo = null;
      for (const a of figs) { try { a.cancel(); } catch (e) { /* gone */ } } figs = [];
      narrate(''); addLog('info', '⏹ Demo stopped'); run(); updHead();
    }

    // ------------------------------------------------------------ rendering
    function addLog(sev, text) { log.unshift({ at: Date.now(), sev, text }); log.splice(150); if (vis) renderLog(); }
    function renderLog() {
      const el = q('#pg-log'); if (!el) return;
      el.innerHTML = log.length ? log.slice(0, 90).map(l => `<li class="pg-${l.sev}"><time>${fmtT(l.at)}</time><b>${{ ev: 'EVENT', alarm: 'ALARM', warn: 'WARN', p25: 'P25', mesh: 'MESH', hb: 'BEAT', info: 'INFO' }[l.sev]}</b><span>${esc(l.text)}</span></li>`).join('')
        : '<li class="pg-info"><span>Nothing yet -- press ▶ Run demo, or trip a sensor.</span></li>';
    }
    function renderMsgs() {
      const el = q('#pg-msgs'); if (!el) return;
      const from = esc(String((k.settings && k.settings.myCall) || 'home radio').toUpperCase());
      el.innerHTML = msgs.length ? msgs.map((m, i) => `<div class="pg-msg ${m.kind}${i === 0 ? ' new' : ''}"><div class="pg-msg-h"><span>📻 ${from} → ${esc(m.to || 'your handheld')}</span><time>${fmtT(m.at)}</time></div>
          <p>${esc(m.text)}</p><small>${m.text.length} chars · one P25 text</small></div>`).join('')
        : '<p class="dim small">No texts yet. Each event ticked in P25 message triggers is sent here as a P25 text from your home radio.</p>';
      const n = el.querySelector('.pg-msg.new'); if (n && vis) flashEl(n, 1);
    }
    function tileBody(c) {
      const s = S[c.id], dead = N[c.node].cut;
      if (c.kind === 'seis') {
        const pts = s.hist.map((v, i) => `${(i * 120 / 39).toFixed(1)},${(30 - v * 0.3).toFixed(1)}`).join(' ');
        return `<div class="pg-val">${dead ? '—' : Math.round(s.v) + '%'}</div><svg class="pg-spark" viewBox="0 0 120 30" preserveAspectRatio="none"><line x1="0" x2="120" y1="${30 - SEIS_TH * 0.3}" y2="${30 - SEIS_TH * 0.3}" class="th"/><polyline points="${pts}"/></svg>`;
      }
      if (c.kind === 'batt') { const pct = Math.max(0, Math.min(100, (s.v - 3.3) / 0.85 * 100));
        return `<div class="pg-val">${dead ? '—' : s.v.toFixed(2) + ' V'}</div><div class="pg-bar ${s.v < LOWBATT ? 'low' : ''}"><i style="width:${pct.toFixed(0)}%"></i></div>`; }
      if (c.kind === 'tank') return `<div class="pg-val">${dead ? '—' : Math.round(s.v) + '%'}</div><div class="pg-bar tank ${s.v < TANK_LOW ? 'low' : ''}"><i style="width:${s.v.toFixed(0)}%"></i></div>`;
      return `<div class="pg-val">${s.on ? c.on : c.off}</div>`;
    }
    function tileBtns(c) {
      if (c.kind === 'toggle') return `<button class="btn small" data-di="${c.id}">${S[c.id].on ? 'Close' : 'Open'}</button>`;
      if (c.kind === 'pulse') return `<button class="btn small" data-di="${c.id}">Trip</button>`;
      if (c.kind === 'seis') return '<button class="btn small" data-kick="40">👣 Steps</button><button class="btn small" data-kick="85">🚙 Vehicle</button>';
      if (c.kind === 'batt') return `<button class="btn small ghost" data-cloud="${c.node}">${N[c.node].cloudy ? '☀️ Sun back' : '☁️ Cloudy week'}</button>`;
      return `<button class="btn small ghost" data-drain="1">${S[c.id].drain ? '🔧 Fix leak' : '🚿 Leak'}</button>`;
    }
    function updTile(id, flash) {
      const el = q(`#pg-t-${id}`); if (!el) return;
      const c = CHI[id], s = S[id];
      el.classList.toggle('on', !!s.on || (c.kind === 'seis' && s.over >= 2));
      el.classList.toggle('dead', N[c.node].cut);
      const set = (sel, html) => { const m = el.querySelector(sel); if (m.innerHTML !== html) m.innerHTML = html; };   // a button never swapped under the pointer
      set('.pg-tb', tileBody(c));
      set('.pg-when', s.n ? `last ${fmtT(s.at)} · ${s.n}×` : 'no events');
      set('.pg-act', tileBtns(c));
      if (flash) flashEl(el);
    }
    function mapSensor(id, on) {
      const el = q(`[data-ch="${id}"]`); if (!el) return;
      el.classList.toggle('on', !!on); if (on) flashEl(el);
    }
    function flashEl(el, n) { if (el && el.animate && vis) el.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 380, iterations: n || 3 }); }
    function updThreat() {
      const t = Math.round(threat), lv = LEVELS.find(l => t >= l[0]);
      const f = q('#pg-threat-fill'); if (!f) return;
      f.style.transform = `scaleX(${t / 100})`; f.className = `pg-${lv[2]}`;
      q('#pg-threat-txt').textContent = `${t} · ${lv[1]}`; q('#pg-threat-txt').className = `pg-${lv[2]}`;
      const ch = q('#pg-chain');
      const html = chain.length ? chain.map(x => `<span class="pg-chip">${x.icon} ${esc(x.label)}</span>`).join('<i>›</i>') : '<span class="dim small">No recent activity</span>';
      if (ch.innerHTML !== html) ch.innerHTML = html;
    }
    function updHead() {
      const st = q('.pg-state'); if (!st) return;
      const [label, sub] = STATES[arm];
      st.className = `pg-state ${arm}${arm === 'alarm' && acked ? ' acked' : ''}`;
      q('#pg-state-l').textContent = label;
      q('#pg-state-s').textContent = arm === 'entry' ? `${Math.max(0, Math.ceil((entryEnd - Date.now()) / 1000))} s to disarm` : arm === 'alarm' && acked ? 'Acknowledged · latched' : sub;
      q('#pg-arm').textContent = arm === 'disarmed' ? '🔒 Arm' : '🔓 Disarm';
      q('#pg-ack').hidden = arm !== 'alarm' || acked;
      q('#pg-demo').textContent = demo ? '⏹ Stop demo' : '▶ Run demo';
      q('#pg-snd').textContent = snd ? '🔊 Sound on' : '🔇 Sound off';
      q('#pg-bounce').textContent = bounces ? `${bounces} bounce${bounces === 1 ? '' : 's'} filtered` : '';
      const p = q('#pg-sun'); if (p) p.textContent = sunNow() > 0.15 ? '☀️' : '🌙';
    }
    function updNodes() {
      const el = q('#pg-nodes'); if (!el) return;
      const now = Date.now();
      el.innerHTML = ['A', 'B', 'R'].map(id => {
        const n = N[id], d = NODES[id], ago = Math.round((now - n.hb) / 1000);
        const st = n.silent ? ['SILENT', 'bad'] : n.cut ? ['no reply…', 'warn'] : ['OK', 'ok'];
        const pw = id === 'R' ? `${Math.round(n.pct)}% ${sunNow() > 0.15 ? '⚡ charging' : '🌙 night'}` : `${S[`${id}-AI2`].v.toFixed(2)} V`;
        const io = d.io ? `<span class="pg-budget">DI ${d.io.di}/6 · AI ${d.io.ai}/2${id === 'A' ? ' · <b>full</b>' : ''}</span>` : '';
        const cut = id === 'B' ? `<button class="btn small ${n.cut ? '' : 'danger'}" data-cut="B">${n.cut ? '🔌 Reconnect' : '✂️ Pull its battery'}</button>` : '';
        return `<div class="pg-node ${st[1]}"><div><b>${d.name}</b><small>${d.hw}</small>${io}</div>
          <div class="pg-node-r"><span class="tag ${st[1] === 'ok' ? 'ok' : st[1] === 'warn' ? 'warn' : ''}">${st[0]}</span><small>${pw} · heard ${ago} s ago</small>${cut}</div></div>`;
      }).join('');
      for (const id of ['A', 'B', 'R']) { const m = q(`#pg-n-${id}`); if (m) m.classList.toggle('dead', !!N[id].cut); }
    }
    function updAll() { for (const c of CH) updTile(c.id); updNodes(); updThreat(); updHead(); }

    function mapSvg() {
      const sens = (id, inner) => `<g class="pg-sens" data-ch="${id}">${inner}</g>`;
      return `<svg class="pg-map" viewBox="0 0 900 540" role="img" aria-label="Site map: shed, driveway, gate, seismic line, nodes and the solar repeater">
        <defs><radialGradient id="pg-glow"><stop offset="0" stop-color="#00e5ff" stop-opacity=".35"/><stop offset="1" stop-color="#00e5ff" stop-opacity="0"/></radialGradient></defs>
        <rect class="pg-ground" x="0" y="0" width="900" height="540" rx="14"/>
        <path class="pg-hill" d="M150 150 Q 300 40 450 150 Z"/>
        <rect class="pg-road" x="0" y="512" width="900" height="22"/><text class="pg-lbl" x="760" y="527">rural road</text>
        <path class="pg-drive" d="M110 528 C 180 462, 250 392, 345 304 S 470 236, 556 200"/>
        <rect class="pg-paddock" x="700" y="330" width="185" height="170" rx="10"/><text class="pg-lbl" x="712" y="350">tank paddock</text>
        ${sens('A-AI1', '<rect class="pg-seis" x="470" y="78" width="320" height="214" rx="34"/><text class="pg-lbl" x="640" y="306">buried geophone line · AI1</text>')}
        ${sens('A-DI4', '<path class="pg-cone" d="M560 214 L 300 330 L 400 452 Z"/><circle class="pg-dot" cx="560" cy="214" r="6"/>')}
        <rect class="pg-shed" x="560" y="120" width="140" height="100" rx="4"/><text class="pg-lbl" x="572" y="140">tractor shed</text>
        <text x="668" y="200" class="pg-emoji" font-size="30">🚜</text>
        ${sens('A-DI1', '<rect class="pg-door" x="556" y="168" width="8" height="40" rx="2"/>')}
        ${sens('A-DI2', '<rect class="pg-win" x="640" y="116" width="40" height="8" rx="2"/>')}
        ${sens('A-DI3', '<path class="pg-cone small" d="M694 126 L 640 160 L 670 196 Z"/><circle class="pg-dot" cx="694" cy="126" r="5"/>')}
        ${sens('A-DI6', '<line class="pg-beam" x1="536" y1="160" x2="536" y2="222"/><circle class="pg-post" cx="536" cy="160" r="4"/><circle class="pg-post" cx="536" cy="222" r="4"/>')}
        ${sens('A-DI5', '<line class="pg-beam" x1="322" y1="284" x2="370" y2="326"/><circle class="pg-post" cx="322" cy="284" r="5"/><circle class="pg-post" cx="370" cy="326" r="5"/><text class="pg-lbl" x="378" y="338">gate · DI5</text>')}
        <rect class="pg-fence" x="300" y="280" width="16" height="4" transform="rotate(42 308 282)"/>
        <circle class="pg-tank" cx="820" cy="420" r="30"/><text x="820" y="428" class="pg-emoji" text-anchor="middle" font-size="22">💧</text>
        ${sens('B-DI1', '<rect class="pg-door" x="878" y="380" width="6" height="40" rx="2"/><text class="pg-lbl" x="836" y="374">back gate</text>')}
        ${sens('B-DI2', '<circle class="pg-dot" cx="760" cy="470" r="5"/><path class="pg-cone small" d="M760 470 L 800 448 L 790 490 Z"/>')}
        <line id="pg-l-AR" class="pg-link" x1="${XY.A[0]}" y1="${XY.A[1]}" x2="${XY.R[0]}" y2="${XY.R[1]}"/>
        <line id="pg-l-BR" class="pg-link" x1="${XY.B[0]}" y1="${XY.B[1]}" x2="${XY.R[0]}" y2="${XY.R[1]}"/>
        <line id="pg-l-HR" class="pg-link" x1="${XY.R[0]}" y1="${XY.R[1]}" x2="${XY.H[0]}" y2="${XY.H[1]}"/>
        <line id="pg-l-HX" class="pg-link p25" x1="${XY.H[0]}" y1="${XY.H[1]}" x2="${XY.X[0]}" y2="${XY.X[1]}"/>
        <g id="pg-n-A" class="pg-node-ic"><circle cx="${XY.A[0]}" cy="${XY.A[1]}" r="13"/><text x="${XY.A[0]}" y="${XY.A[1] + 4}" text-anchor="middle">A</text></g>
        <g id="pg-n-B" class="pg-node-ic"><circle cx="${XY.B[0]}" cy="${XY.B[1]}" r="13"/><text x="${XY.B[0]}" y="${XY.B[1] + 4}" text-anchor="middle">B</text></g>
        <g id="pg-n-R" class="pg-node-ic rpt"><circle cx="${XY.R[0]}" cy="${XY.R[1]}" r="15"/><text x="${XY.R[0]}" y="${XY.R[1] + 5}" text-anchor="middle" class="pg-emoji" font-size="15" id="pg-sun">☀️</text></g>
        <text class="pg-lbl hi" x="${XY.R[0] + 22}" y="${XY.R[1] - 8}">SenseCAP solar repeater</text>
        <g class="pg-off"><rect x="14" y="40" width="112" height="48" rx="10"/><text x="70" y="60" text-anchor="middle">🏠 Home</text><text x="70" y="78" text-anchor="middle" class="sm">companion + Kelly</text></g>
        <g class="pg-off p25"><rect x="14" y="162" width="112" height="48" rx="10"/><text x="70" y="182" text-anchor="middle">📻 P25 radio</text><text x="70" y="200" text-anchor="middle" class="sm">at home · CCDI</text></g>
        <text class="pg-lbl" x="14" y="112">← 11 km to home</text>
        <text id="pg-car" class="pg-emoji pg-fig" font-size="30" text-anchor="middle" dominant-baseline="central">🚙</text>
        <text id="pg-man" class="pg-emoji pg-fig" font-size="24" text-anchor="middle" dominant-baseline="central">🥷</text>
        <g id="pg-fx"></g>
      </svg>`;
    }

    function insights() {
      return `<details class="card pg-how" open><summary><h2>💡 How it works</h2></summary>
        <div class="pg-how-grid">
          <div><h4>One small board guards the whole shed</h4>
            <p>A RAK4631 (nRF52840 + SX1262 LoRa) on a RAK13002 IO board has the six digital and two analog inputs this shed needs -- door, window,
            indoor PIR, driveway radar, two break-beams, a seismic line and its own battery. No mains, no mobile coverage, no NBN, no P25: a LiPo, a small
            panel and MeshCore. When the channels run out, a second RAK4631 takes the far zone (here the tank paddock) and joins the same mesh.</p></div>
          <div><h4>Interrupts for switches, polls for analog</h4>
            <p>A door switch only matters when it <i>changes</i>, so it wakes the nRF52840 from sleep with an interrupt and the event goes out at once.
            An analog input has no "change" -- the node samples it every ${POLL_MS / 1000} s (a millisecond of ADC work) and only transmits when a threshold
            is crossed. A heartbeat every 15 min proves the node is alive: ${MISS} missed and the home station tells you -- a thief who pulls the battery
            still sets something off.</p></div>
          <div><h4>Smart, not just loud</h4>
            <p>A wallaby on the radar alone only raises the threat score; it decays away. Radar, then the gate beam, then footsteps, then the door is a
            story -- each link in the chain adds weight, and a door opened with that story behind it skips the entry delay. The window and an indoor PIR
            with no door are instant zones. A ${DEBOUNCE_MS} ms debounce stops a rattling door making ten alarms. All of this runs in Kelly at home.</p></div>
          <div><h4>Range from the ridge</h4>
            <p>The shed sits in a gully with no path home. A SenseCAP solar node on the ridge runs MeshCore repeater firmware, off-grid, and relays both
            sensor nodes to your home station 11 km away. Every event is a MeshCore DM to the home companion, so it is ACKed and retried. There is no
            P25 at the block: Kelly at home runs the alarm and sends P25 texts from your home radio for the events you tick -- set in Kelly, never at the shed.</p></div>
        </div>
        <div class="pg-calc">
          <h4>Why event-driven beats constant polling over the air</h4>
          <label>If the node sent every input's state every <b id="pg-calc-n">30</b> s instead:
            <input type="range" id="pg-calc" min="5" max="600" step="5" value="30"></label>
          <div class="pg-calc-rows" id="pg-calc-out"></div>
          <p class="dim small">Typical figures, check your own datasheets and channel settings: ~0.4 s on air per packet, ~120 mA while the SX1262 transmits at
          22 dBm, each packet sent again by the repeater. MeshCore keeps the receiver on (~5 mA, ~120 mAh a day) so the node can hear its ACKs
          -- that, not the transmissions, is the node's biggest cost, and why each node gets a small panel.</p>
        </div>
        <div class="pg-how-grid">
          <div><h4>Power budget, node A</h4>
            <table class="pg-tbl"><tr><th>Part</th><th>Draw</th><th>Per day</th></tr>
              <tr><td>nRF52840 asleep between events</td><td>~3 µA</td><td>&lt;0.1 mAh</td></tr>
              <tr><td>SX1262 listening (MeshCore RX)</td><td>~5 mA</td><td>~120 mAh</td></tr>
              <tr><td>~140 packets (events + heartbeats)</td><td>~120 mA × 0.4 s</td><td>~2 mAh</td></tr>
              <tr><td>Indoor PIR</td><td>~50 µA</td><td>~1 mAh</td></tr>
              <tr><td>Geophone amplifier</td><td>~0.5 mA</td><td>~12 mAh</td></tr>
              <tr><td>Radar + two beam pairs</td><td>30-100 mA at 12 V</td><td>own battery</td></tr></table></div>
          <div><h4>Build tips</h4>
            <ul class="pg-tips">
              <li>The nRF52840's internal pull-ups are ~13 kΩ: a normally-closed reed loop then draws ~0.25 mA all day. An external 1 MΩ pull-up drops it to ~3 µA.</li>
              <li>Radar and break-beams are the power hogs. Run them from a 12 V SLA with its own panel and wire their <b>relay contacts</b> to the DIs -- the RAK node never sees 12 V.</li>
              <li>Normally-closed everywhere: a cut wire looks like an open door, so cutting a cable sets off the alarm instead of hiding it.</li>
              <li>A gland per cable run and an IP65 box. Put the RAK node inside the shed, high and out of sight, antenna through the roof.</li>
              <li>Keep events tiny (a few bytes) and send heartbeats rarely -- the mesh is shared with every other ham on the channel.</li>
              <li>Keep the brains at home: the shed node only reports and takes no commands, so there is nothing at the remote end to talk into disarming.</li>
            </ul></div>
        </div>
      </details>`;
    }
    function calc() {
      const n = +q('#pg-calc').value; q('#pg-calc-n').textContent = n;
      const ev = 140, pol = Math.round(86400 / n) + 96;
      const row = (label, pk, cls) => { const air = pk * 0.4 * 2, mah = pk * 0.4 * 120 / 3600;
        return `<div class="pg-calc-row ${cls}"><b>${label}</b><span>${pk.toLocaleString()} packets</span><span>${Math.round(air / 60)} min on air (${(air / 864).toFixed(2)}%)</span><span>${mah.toFixed(1)} mAh TX</span><span>${cls === 'poll' ? `up to ${n} s late` : 'instant'}</span>
          <div class="pg-bar"><i style="width:${Math.min(100, air / 864 * 10).toFixed(1)}%"></i></div></div>`; };
      q('#pg-calc-out').innerHTML = row('Event-driven', ev, 'evt') + row(`Poll every ${n} s`, pol, 'poll');
    }

    function render() {
      root.innerHTML = `<div class="pg">
        <div class="card pg-top">
          <div class="pg-title"><h3>🛡️ Property Guard</h3><span class="tag warn">Concept · simulation</span>
            <div class="pg-state disarmed"><b id="pg-state-l">DISARMED</b><small id="pg-state-s"></small></div>
            <span class="grow"></span>
            <button class="btn small primary" id="pg-demo">▶ Run demo</button>
            <button class="btn small" id="pg-arm">🔒 Arm</button>
            <button class="btn small danger" id="pg-ack" hidden>🔕 Acknowledge</button>
            <button class="btn small ghost" id="pg-snd"></button>
            <button class="btn small ghost" id="pg-reset" title="Start the simulation again">⟲ Reset</button></div>
          <p class="pg-lede">An unattended tractor shed on a remote block, guarded by one <b>RAK4631</b> on a <b>RAK13002</b> (6 digital + 2 analog inputs), relayed over
            <b>MeshCore</b> by a solar <b>SenseCAP</b> repeater to your home station. The block is <b>MeshCore only</b> -- P25 is at your house, where Kelly runs the alarm
            and sends a <b>P25 text</b> for each event you tick. Everything here is simulated in the page -- nothing goes on air.</p>
          <p class="pg-narr" id="pg-narr" hidden aria-live="polite"></p>
        </div>
        <div class="pg-grid">
          <div class="card pg-mapcard"><div class="card-h"><h2>🗺️ Site map</h2><span class="dim small">dots = MeshCore packets hopping · cyan events · grey heartbeats · magenta P25 (home only)</span></div>${mapSvg()}</div>
          <div class="pg-col">
            <div class="card pg-threat"><div class="card-h"><h2>🎯 Threat</h2><b id="pg-threat-txt">0 · Quiet</b></div>
              <div class="pg-meter"><i id="pg-threat-fill"></i></div><div class="pg-chain" id="pg-chain"></div>
              <p class="dim small">Each sensor adds weight, a sensor within 60 s of the last adds more, and it decays 1 a second. 50+ and a door skips the entry delay; 80+ sends a warning.</p></div>
            <div class="card"><div class="card-h"><h2>📶 Mesh nodes</h2><span class="dim small">heartbeat every 15 min (15 s here)</span></div><div id="pg-nodes"></div></div>
            <div class="card pg-trigs"><div class="card-h"><h2>📻 P25 message triggers</h2><span class="dim small">Kelly at home · your P25 radio</span></div>
              <label class="pg-to">Send to <input type="text" id="pg-to" maxlength="24" placeholder="radio ID or talkgroup, e.g. 1050002" value="${esc(sendTo)}"></label>
              <div class="pg-trig-list">${TRIGS.map(t => `<label><input type="checkbox" data-trig="${t[0]}"${trig[t[0]] ? ' checked' : ''}> ${t[1]}</label>`).join('')}</div>
              <div class="pg-sub">Sensor trips</div>
              <div class="pg-trig-list ch">${CH.filter(c => c.kind !== 'batt' && c.kind !== 'tank').map(c => `<label><input type="checkbox" data-trigch="${c.id}"${trigCh.includes(c.id) ? ' checked' : ''}> ${c.icon} ${c.node}·${c.io} ${esc(c.name)}</label>`).join('')}</div>
              <label class="pg-armed-only"><input type="checkbox" id="pg-trig-armed"${trigArmed ? ' checked' : ''}> sensor trips only while armed</label>
              <p class="dim small">The shed is MeshCore only. Events come home over the mesh; Kelly decides which become P25 texts, so you change this here, never at the remote site.</p></div>
            <div class="card pg-msgcard"><div class="card-h"><h2>📨 P25 texts sent</h2><span class="dim small">from your home radio</span></div><div id="pg-msgs" class="pg-msgs"></div></div>
          </div>
        </div>
        <div class="card"><div class="card-h"><h2>🔌 Inputs · RAK13002</h2><span class="dim small" id="pg-bounce"></span></div>
          <div class="pg-sub">Node A · shed -- every channel used</div>
          <div class="pg-tiles">${CH.filter(c => c.node === 'A').map(tile).join('')}</div>
          <div class="pg-sub">Node B · tank paddock -- the second RAK4631, added when node A ran out of inputs</div>
          <div class="pg-tiles">${CH.filter(c => c.node === 'B').map(tile).join('')}</div></div>
        <div class="card"><div class="card-h"><h2>📜 Event log</h2><label class="dim small"><input type="checkbox" id="pg-hb"${showHb ? ' checked' : ''}> show heartbeats</label></div><ol class="pg-log" id="pg-log"></ol></div>
        ${insights()}
      </div>`;
      function tile(c) {
        return `<div class="pg-tile ${c.kind}" id="pg-t-${c.id}" title="${esc(c.wire)}"><div class="pg-th"><span class="pg-io">${c.io}</span><span>${c.icon} ${esc(c.name)}</span></div>
          <div class="pg-tb"></div><div class="pg-when"></div><p class="pg-wire">${esc(c.wire)}</p><div class="pg-act"></div></div>`;
      }
      q('#pg-demo').onclick = startDemo;
      q('#pg-arm').onclick = () => doArm(arm === 'disarmed');
      q('#pg-ack').onclick = doAck;
      q('#pg-snd').onclick = () => { snd = !snd; k.store.set('pg.sound', snd); if (snd) blip(); updHead(); };
      q('#pg-reset').onclick = () => { stopDemo(); reset(); renderLog(); renderMsgs(); updAll(); };
      q('#pg-hb').onchange = e => { showHb = e.target.checked; k.store.set('pg.hb', showHb); };
      q('#pg-calc').oninput = calc; calc();
      q('#pg-to').onchange = e => { sendTo = e.target.value.trim(); k.store.set('pg.to', sendTo); renderMsgs(); };
      q('#pg-trig-armed').onchange = e => { trigArmed = e.target.checked; k.store.set('pg.trigArmed', trigArmed); };
      q('.pg-trigs').addEventListener('change', e => {
        const t = e.target.dataset.trig, c = e.target.dataset.trigch;
        if (t) { trig[t] = e.target.checked; k.store.set('pg.trig', trig); addLog('info', `P25 trigger "${trigLabel(t)}" ${e.target.checked ? 'on' : 'off'}`); }
        else if (c) { trigCh = trigCh.filter(x => x !== c); if (e.target.checked) trigCh.push(c); k.store.set('pg.trigCh', trigCh); addLog('info', `P25 trigger "${trigLabel('ch:' + c)}" ${e.target.checked ? 'on' : 'off'}`); }
      });
      root.querySelector('.pg').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.di) { const c = CHI[b.dataset.di]; setDI(c.id, c.kind === 'pulse' ? true : !S[c.id].on, 'user'); }
        else if (b.dataset.kick) { kick += +b.dataset.kick; addLog('info', `You ${+b.dataset.kick > 60 ? 'drive along' : 'walk over'} the seismic line -- the next polls will show it`); }
        else if (b.dataset.cloud) { const n = N[b.dataset.cloud]; n.cloudy = !n.cloudy; addLog('info', n.cloudy ? `A week of cloud over node ${b.dataset.cloud} (battery drains fast here)` : `Sun back on node ${b.dataset.cloud}'s panel`); updTile(`${b.dataset.cloud}-AI2`); }
        else if (b.dataset.drain) { const s = S['B-AI1']; s.drain = !s.drain; if (!s.drain) s.v = Math.max(s.v, 72); addLog('info', s.drain ? 'A leak at the tank (sim)' : 'Leak fixed, tank refilled'); updTile('B-AI1'); }
        else if (b.dataset.cut) { const n = N.B;
          if (!n.cut) { n.cut = true; addLog('info', 'Node B lost power (sim: someone pulled its battery) -- watch for the silent-node alert'); }
          else { n.cut = false; n.silent = false; addLog('info', 'Node B back on air'); beat('B'); }
          for (const c of CH) if (c.node === 'B') updTile(c.id); updNodes(); }
      });
    }

    return window.kellyPropertyGuard = {   // for the console / test drivers, like window.kellyHamContacts
      init() {
        root = document.getElementById('pg-root'); if (!root) return;
        reset(); render(); renderLog(); renderMsgs(); updAll();
        document.addEventListener('visibilitychange', checkVis);
        setInterval(checkVis, 1000);
        if (location.hash === '#pg-demo') setTimeout(() => { checkVis(); startDemo(); }, 1200);
      },
      shown() { setTimeout(checkVis, 30); },
      hidden() { setTimeout(checkVis, 30); },
      _s: () => ({ arm, threat, chain, S, N, log, msgs }),   // tests
    };
  };
})();
