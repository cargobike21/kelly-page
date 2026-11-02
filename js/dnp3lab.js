/* Kelly Page -- DNP3 Demo page (2026-10-18, unreleased). A 33/11 kV zone substation, a DNP3 outstation in front of it
 * and a DNP3 master, all inside this page and joined by a simulated link (latency + loss sliders) -- so you can switch
 * plant, poll it, operate it with SELECT -> OPERATE, and read every frame byte by byte. Nothing goes on air or on a
 * network; the outstation is always the simulator.
 *
 * Files: js/dnp3.js (codec, superset of scripts/dnp3.py), js/dnp3sim.js (substation + outstation + master),
 *        js/dnp3link.js (the in-page link), js/dnp3view.js (decode, plain English, ladder -- shared with Wivenhoe),
 *        js/dnp3fx.js (synth sounds + sparks), this file, css/dnp3lab.css, tests/dnp3-tests.html.
 * The page's other plants, the trainers on js/scadakit.js (Wivenhoe, the Mackay gas turbine), have it when
 * settings.dnp3.plant is not 'sub' -- then this file's tick and render stand still.
 * Tabs (data-tabs="dnp3"): sub (single-line diagram, meters, alarms, events), scada (master controls, points, events,
 * logs), insp (captured frames + byte decode, timestamp reference, time sync).
 * Effects are one-shot; the transformer hum is opt-in (kelly-page/CLAUDE.md "Flashy, but nothing loops forever").
 *
 * window.KellyDnp3UI(ctx) -> { init, render, shown }
 */
(function () {
  'use strict';
  const D = window.DNP3, S = window.DNP3Sim;
  const FEEDS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
  // diagram positions (viewBox 1200 x 600)
  const X = { L1: 450, L2: 750, T1: 250, T2: 950, F1: 100, F2: 180, F3: 530, F4: 670, F5: 1015, F6: 1115, C1: 330, C2: 880 };
  const ON = { F1: 'A', F2: 'A', C1: 'A', F3: 'B', F4: 'B', F5: 'C', F6: 'C', C2: 'C' };
  const BUSX = { A: [50, 370], B: [450, 750], C: [830, 1165] };
  const POS = { 'cb.L1': [450, 62], 'cb.L2': [750, 62], 'cb.T1H': [250, 140], 'cb.T2H': [950, 140], 'cb.T1L': [250, 290], 'cb.T2L': [950, 290], 'cb.BAB': [410, 340], 'cb.BBC': [790, 340] };
  for (const f of [...FEEDS, 'C1', 'C2']) POS['cb.' + f] = [X[f], 400];

  function diagram() {
    const o = [];
    const ln = (key, d) => o.push(`<path class="ln" data-k="${key}" d="${d}"/>`);
    const br = (id, label, dx, anchor, dy = 4) => { const [x, y] = POS[id]; o.push(`<g class="br" data-id="${id}" tabindex="0"><rect x="${x - 12}" y="${y - 12}" width="24" height="24" rx="3"/><text x="${x + dx}" y="${y + dy}" text-anchor="${anchor}">${label}</text></g>`); };
    for (const s of ['L1', 'L2']) {
      const x = X[s];
      o.push(`<g class="src" data-id="src.${s}"><circle cx="${x}" cy="18" r="11"/><text x="${x}" y="23" text-anchor="middle">~</text><text class="lab" x="${x + 18}" y="16">${s} 33 kV line</text></g>`);
      ln('s' + s, `M${x} 29 V50`); ln('i' + s, `M${x} 74 V100`); br('cb.' + s, s, 16, 'start');
    }
    o.push(`<path class="bus" data-k="b33" d="M200 100 H1000"/><text class="lab" x="194" y="104" text-anchor="end">33 kV</text><text class="val" data-v="b33" x="1008" y="104"></text>`);
    for (const t of ['T1', 'T2']) {
      const x = X[t];
      ln(t + 'a', `M${x} 100 V128`); br('cb.' + t + 'H', t + ' HV', 16, 'start'); ln(t + 'b', `M${x} 152 V168`);
      o.push(`<g class="xf" data-id="tx.${t}" tabindex="0"><circle data-k="${t}h" class="ln" cx="${x}" cy="190" r="22"/><circle data-k="${t}l" class="ln" cx="${x}" cy="222" r="22"/><path class="tapmark" d="M${x - 32} 236 L${x + 32} 174"/>
        <text class="lab" x="${x + 40}" y="188">${t} 20 MVA</text><text class="val" data-v="${t}tap" x="${x + 40}" y="204"></text><text class="val" data-v="${t}temp" x="${x + 40}" y="220"></text></g>`);
      ln(t + 'c', `M${x} 244 V278`); br('cb.' + t + 'L', t + ' LV', 16, 'start'); ln(t + 'd', `M${x} 302 V340`);
    }
    for (const b of ['A', 'B', 'C']) o.push(`<path class="bus" data-k="bus${b}" d="M${BUSX[b][0]} 340 H${BUSX[b][1]}"/><g data-id="bus.${b}"><rect x="${BUSX[b][0]}" y="312" width="${BUSX[b][1] - BUSX[b][0]}" height="22" fill="transparent"/><text class="lab" x="${BUSX[b][0] + 4}" y="330">11 kV BUS ${b}</text><text class="val" data-v="bus${b}" x="${BUSX[b][1] - 4}" y="330" text-anchor="end"></text></g>`);
    ln('tAB1', 'M370 340 H398'); ln('tAB2', 'M422 340 H450'); br('cb.BAB', 'A-B tie', 0, 'middle', 30);
    ln('tBC1', 'M750 340 H778'); ln('tBC2', 'M802 340 H830'); br('cb.BBC', 'B-C tie', 0, 'middle', 30);
    for (const f of FEEDS) {
      const x = X[f];
      ln(f + 'a', `M${x} 340 V388`); br('cb.' + f, f, -16, 'end'); ln(f + 'b', `M${x} 412 V528`); ln(f + 'c', `M${x - 7} 522 L${x} 536 L${x + 7} 522`);
      o.push(`<g class="es" data-id="es.${f}" tabindex="0"><rect x="${x + 2}" y="448" width="34" height="40" fill="transparent"/><path class="blade" d="M${x} 462 L${x + 24} 462"/><path class="gnd" d="M${x + 26} 462 V474 M${x + 18} 474 H${x + 34} M${x + 21} 479 H${x + 31} M${x + 24} 484 H${x + 28}"/></g>`);
      o.push(`<g data-id="fdr.${f}"><text class="lab" x="${x}" y="554" text-anchor="middle" data-v="${f}n"></text><text class="val" x="${x}" y="570" text-anchor="middle" data-v="${f}a"></text><text class="flt" x="${x}" y="586" text-anchor="middle" data-v="${f}f"></text></g>`);
    }
    for (const c of ['C1', 'C2']) {
      const x = X[c];
      ln(c + 'a', `M${x} 340 V388`); br('cb.' + c, c, -16, 'end'); ln(c + 'b', `M${x} 412 V446`);
      o.push(`<g data-id="cap.${c}"><path class="ln" data-k="${c}p" d="M${x - 14} 446 H${x + 14} M${x - 14} 455 H${x + 14}"/><path class="gnd" d="M${x} 455 V468 M${x - 8} 468 H${x + 8} M${x - 5} 473 H${x + 5}"/><text class="lab" x="${x}" y="498" text-anchor="middle">${c} 2.4 MVAr</text><text class="val" x="${x}" y="514" text-anchor="middle" data-v="${c}q"></text></g>`);
    }
    return `<svg class="d3-sld" viewBox="0 0 1200 600" role="img" aria-label="Substation single-line diagram">${o.join('')}</svg>`;
  }

  window.KellyDnp3UI = function (k) {
    const { $, $$, esc, toast, dirty, settings } = k;
    const cfg = settings.dnp3 = Object.assign({ sfx: true, hum: false, lat: 120, loss: 0, auto: true, biEv: 2, aiEv: 3, mode: 'sim', osAddr: 4, msAddr: 1 }, settings.dnp3 || {});
    const save = () => k.saveSoon && k.saveSoon('settings');
    const st = { sel: null, ctl: null, sbo: null, cap: [], capN: 0, pick: null, soe: [], started: false, lastPoll: 0, lastInteg: 0, ts: null, alarmAt: 0 };
    const sub = new S.Substation();
    const truth = new Map();
    let os, ms, fx, sp, svg, N = {}, V = {}, E = {};
    const onPage = () => k.currentPage() === 'dnp3' && !document.hidden;
    const tab = () => { const b = $('[data-tabs="dnp3"] button.on'); return b ? b.dataset.tab : 'sub'; };
    const clicked = () => !navigator.userActivation || navigator.userActivation.hasBeenActive;
    const play = (n, ...a) => { if (cfg.sfx && fx && onPage() && clicked()) fx[n](...a); };
    const hhmmss = t => { const d = new Date(t); return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };

    // ------------------------------------------------------------ the in-page link (js/dnp3link.js, as a quick wire: latency + loss, no P25 air time)
    let lk = null;
    function log(who, dir, f, label) {
      st.cap.push({ n: ++st.capN, at: Date.now(), who, dir, hex: D.hex(f), label: label || '', size: f.length });
      if (st.cap.length > 400) st.cap.shift();
      if (tab() === 'insp') dirty('dnp3');
    }
    // ------------------------------------------------------------ over P25 RF (k.rf from app.js: parked TM9100, raw frames)
    // rf-os: this Kelly's substation answers a master elsewhere (the NUC dashboard's DNP3 MASTER page, or another Kelly
    // through the gateway); rf-ms: this Kelly is the master of an outstation elsewhere. DNP3 link addresses do the
    // picking -- every parked radio on the repeater hears the gateway's call, and each station only takes frames for it.
    const isRf = () => cfg.mode === 'rf-os' || cfg.mode === 'rf-ms';
    const myAddr = () => (cfg.mode === 'rf-ms' ? cfg.msAddr : cfg.osAddr);
    function air(who, f) {
      if (!k.rf || !k.rf.parked()) {
        log(who, 'lost', f, k.rf && k.rf.demo() ? 'not sent: the demo radio has no RF' : 'not sent: radio not parked in Transparent');
        if (Date.now() - (st.rfWarnAt || 0) > 15000) { st.rfWarnAt = Date.now(); toast('📻', 'DNP3 not sent', 'Park a TM9100 in Transparent (Admin > Home mode) to put DNP3 on air', 'bad'); }
        return;
      }
      st.rfTx = Date.now();
      k.rf.send(f, `DNP3 ${who === 'O' ? 'reply' : 'request'} ${f.length} B`);
    }
    function fromAir(f) {
      const L = D.parseLink(f);
      if (L.ok && L.src === myAddr() && L.dest !== myAddr()) return;   // our own call, repeated back by the repeater
      st.rfRx = Date.now();
      log('R', 'rx', f, 'received over RF');
      (cfg.mode === 'rf-os' ? os : ms).receive(f);
    }
    function build() {
      if (os) os.detach();
      const rf = isRf();
      // RF: a lean point set (packed BIs, 16-bit AIs, no BO status / counters in class 0, 8 events a reply) keeps an
      // integrity answer near 70 B instead of ~300 B -- the channel moves ~2.7 kbit/s and loses a few % of calls
      os = new S.Outstation(sub, { addr: cfg.osAddr, master: cfg.msAddr, cfg: { biEvent: +cfg.biEv, aiEvent: +cfg.aiEv, ...(rf ? { lean: true, biStatic: 1, aiStatic: 4 } : {}) } });
      ms = new S.Master({ addr: cfg.msAddr, dest: cfg.osAddr, autoTime: false, timeout: rf ? 7000 : 4000 });
      os.turnaroundMs = rf ? 0 : 15;
      os.send = () => {}; ms.send = () => {};
      if (lk) { lk.close(); lk = null; }
      if (!rf) { lk = new window.DNP3Link.Link({ lat: cfg.lat, loss: cfg.loss, p25: false }); lk.join(ms, os); lk.on(e => { if (e.type === 'lost') log(e.from, 'lost', e.frame, e.why); }); }
      else if (cfg.mode === 'rf-os') os.send = f => air('O', f);
      else ms.send = f => air('M', f);
      if (k.rf) { const fr = new D.Framer(fromAir); k.rf.onRx(rf ? b => fr.push(b) : null); }
      ms.on(e => { if (e.type === 'db' && e.pa) { const t = e.pa.objects.find(o => o.g === 50 && o.points[0]); if (t) st.rtuClock = { time: t.points[0].time, rx: Date.now() }; } });
      ms.tap = (dir, f, label) => { if (dir === 'tx') log('M', 'tx', f, label); };
      os.tap = (dir, f, label) => { if (dir === 'tx') log('O', 'tx', f, label); };
      ms.on(e => {
        if (e.type === 'ctrl') {
          if (e.sbo && e.ok) st.sbo = { bo: e.task.ctrl.bo, code: e.task.ctrl.code, seq: e.task.seq, objs: e.task.objs, at: Date.now() };
          if (!e.ok) { play('blocked'); toast('⛔', 'Control refused by the RTU', D.CROB_STATUS[e.status] || 'status ' + e.status, 'bad'); }
          else if (!e.sbo) play('coin');
        }
        if (e.type === 'timesync') st.ts = e.ts;
        if (e.type === 'timeout') sub.setAlarm('comms', true, 'SCADA comms fail -- no answer from the RTU', 'bad');
        if (e.type === 'done' && e.ok) sub.setAlarm('comms', false);
        if (tab() !== 'sub') dirty('dnp3');
      });
      // the real moment each event happened, keyed as the master will see it (kind, index, stamped ms) -- shows the RTU clock error
      os.on(e => { if (e.type === 'event') { truth.set(e.ev.type + ':' + e.ev.index + ':' + Math.floor(e.ev.time), performance.timeOrigin + performance.now()); if (truth.size > 500) truth.delete(truth.keys().next().value); } if (tab() !== 'sub') dirty('dnp3'); });
    }

    // ------------------------------------------------------------ plant events -> sound, sparks, event list
    sub.on(e => {
      const t = new Date().toLocaleTimeString([], { hour12: false });
      if (e.type === 'op') {
        note(t, `${e.name} ${e.closed ? 'CLOSED' : 'OPENED'}${e.by === 'scada' ? ' (SCADA)' : ''}${e.fault ? ' onto a FAULT' : ''}`, e.fault ? 'bad' : e.by === 'scada' ? 'sc' : '');
        if (e.id.startsWith('es.')) play('rack'); else play(e.closed ? 'clunk' : 'trip', e.closed ? 1 : 0.7);
        if (!e.id.startsWith('es.') && (e.amps > 40 || e.fault)) { play('arc', e.arc); spark(e.id, e.arc); }
      } else if (e.type === 'trip') { note(t, `TRIP ${e.name}: ${e.cause}`, 'bad'); play('trip', 1); play('arc', e.arc); spark(e.id, e.arc); }
      else if (e.type === 'block') { note(t, `Blocked: ${e.reason}`, 'warn'); play('blocked'); if (e.by === 'local') toast('🔒', 'Interlock', e.reason, 'bad'); }
      else if (e.type === 'tap') { if (e.start) { play('tap', S.consts.TAP_TIME); note(t, `${e.tx} tap ${e.action}${e.by === 'scada' ? ' (SCADA)' : ''}`, e.by === 'scada' ? 'sc' : ''); } else note(t, `${e.tx} on tap ${e.tap}`, ''); }
      else if (e.type === 'alarm' && e.on) { note(t, 'ALARM: ' + e.text, e.level === 'bad' ? 'bad' : 'warn'); if (e.level !== 'info' && Date.now() - st.alarmAt > 3000) { st.alarmAt = Date.now(); play('alarm'); } }
      dirty('dnp3');
    });
    function note(t, text, cls) { st.soe.unshift({ t, text, cls }); if (st.soe.length > 60) st.soe.pop(); }
    function spark(id, s) {
      if (!sp || tab() !== 'sub' || !document.body.classList.contains('fx')) return;
      const p = POS[id], cv = $('#d3-fx'); if (!p || !cv) return;
      const r = cv.getBoundingClientRect(), sc = Math.min(r.width / 1200, r.height / 600);
      sp.arc((r.width - 1200 * sc) / 2 + p[0] * sc, (r.height - 600 * sc) / 2 + p[1] * sc, s);
    }

    // ------------------------------------------------------------ tick
    function tick() {
      if ((cfg.plant && cfg.plant !== 'sub')) return;   // the Wivenhoe trainer has the page (js/wivenhoeui.js)
      sub.tick(0.25);
      os.scan();
      const t = Date.now();
      // RF polls far less often: every poll is two over-the-air calls on a shared channel
      const integEvery = isRf() ? 300000 : 60000, pollEvery = isRf() ? 30000 : 5000;
      if (cfg.auto && cfg.mode !== 'rf-os' && !st.sbo && !ms.cur && !ms.queue.length) {
        if (t - st.lastInteg > integEvery) { st.lastInteg = st.lastPoll = t; ms.integrity(); }
        else if (t - st.lastPoll > pollEvery) { st.lastPoll = t; ms.poll([1, 2, 3]); }
      }
      if (st.sbo && t - st.sbo.at > 10000) st.sbo = null;
      if (fx && clicked()) fx.hum(cfg.hum && onPage(), (sub.tx.T1.load + sub.tx.T2.load) / 2);
      if (onPage()) dirty('dnp3');
    }

    // ------------------------------------------------------------ drawing
    function paintDiagram(v) {
      const c = (key, volts) => (N[key] || []).forEach(n => { const cl = volts === 33 ? 'k33' : volts === 11 ? 'k11' : volts === 'f' ? 'kf' : 'k0'; if (n.dataset.c !== cl) { n.classList.remove('k33', 'k11', 'kf', 'k0'); n.classList.add(cl); n.dataset.c = cl; } });
      const tx = (key, s) => { const n = V[key]; if (n && n.textContent !== s) n.textContent = s; };
      const b33 = v.bus.b33.live;
      for (const s of ['L1', 'L2']) { c('s' + s, v.grid[s] ? 33 : 0); c('i' + s, b33 ? 33 : 0); E['src.' + s].classList.toggle('lost', !v.grid[s]); }
      c('b33', b33 ? 33 : 0); tx('b33', b33 ? v.bus.b33.kv.toFixed(2) + ' kV' : 'DEAD');
      for (const t of ['T1', 'T2']) {
        const T = v.tx[t], bus = t === 'T1' ? 'A' : 'C';
        c(t + 'a', b33 ? 33 : 0); c(t + 'b', T.live ? 33 : 0); c(t + 'h', T.live ? 33 : 0); c(t + 'l', T.live ? 11 : 0); c(t + 'c', T.live ? 11 : 0); c(t + 'd', v.bus[bus].live ? 11 : 0);
        tx(t + 'tap', `Tap ${T.tap}${T.busy ? ' (moving)' : ''}`); tx(t + 'temp', `${T.temp.toFixed(0)} °C · ${(T.load * 100).toFixed(0)} %`);
        E['tx.' + t].classList.toggle('hot', T.temp > S.consts.TEMP_ALARM);
      }
      for (const b of ['A', 'B', 'C']) { c('bus' + b, v.bus[b].live ? 11 : 0); tx('bus' + b, v.bus[b].live ? `${v.bus[b].kv.toFixed(2)} kV  ${(v.bus[b].kv / 0.11).toFixed(1)} %` : 'DEAD'); }
      c('tAB1', v.bus.A.live ? 11 : 0); c('tAB2', v.bus.B.live ? 11 : 0); c('tBC1', v.bus.B.live ? 11 : 0); c('tBC2', v.bus.C.live ? 11 : 0);
      for (const f of FEEDS) {
        const F = v.fdr[f], live = v.bus[ON[f]].live, out = F.fault && F.live ? 'f' : F.live ? 11 : 0;
        c(f + 'a', live ? 11 : 0); c(f + 'b', out); c(f + 'c', out);
        tx(f + 'n', F.name.replace(/^F\d /, '')); tx(f + 'a', `${Math.round(F.amps)} A`); tx(f + 'f', F.fault ? 'FAULT' : '');
        E['es.' + f].classList.toggle('closed', v.el['es.' + f].closed);
      }
      for (const q of ['C1', 'C2']) { const C = v.cap[q]; c(q + 'a', v.bus[ON[q]].live ? 11 : 0); c(q + 'b', C.live ? 11 : 0); c(q + 'p', C.live ? 11 : 0); tx(q + 'q', C.live ? C.mvar.toFixed(2) + ' MVAr' : C.left > 0 ? `discharging ${Math.ceil(C.left)} s` : 'off'); }
      for (const id of Object.keys(POS)) {
        const n = E[id], cl = v.el[id].closed;
        const side = /L\d$|H$/.test(id) ? (b33 ? 33 : 0) : id === 'cb.T1L' ? 11 * +(v.tx.T1.live || v.bus.A.live) : id === 'cb.T2L' ? 11 * +(v.tx.T2.live || v.bus.C.live) : id === 'cb.BAB' ? 11 * +(v.bus.A.live || v.bus.B.live) : id === 'cb.BBC' ? 11 * +(v.bus.B.live || v.bus.C.live) : 11 * +v.bus[ON[id.slice(3)]].live;
        n.classList.toggle('closed', cl);
        const want = cl && side ? (side === 33 ? 'k33' : 'k11') : 'k0';
        if (n.dataset.c !== want) { n.classList.remove('k33', 'k11', 'k0'); n.classList.add(want); n.dataset.c = want; }
      }
      Object.values(E).forEach(n => n.classList.toggle('sel', n.dataset.id === st.sel));
    }
    function meters(v) {
      const m = [
        ['33 kV bus', v.bus.b33.kv, 'kV', 0, 38, 2], ['Bus A', v.bus.A.kv, 'kV', 0, 12.5, 2], ['Bus B', v.bus.B.kv, 'kV', 0, 12.5, 2], ['Bus C', v.bus.C.kv, 'kV', 0, 12.5, 2],
        ['Load', v.totMW, 'MW', 0, 40, 1], ['Reactive', v.totMVAr, 'MVAr', -10, 20, 1], ['Frequency', v.hz, 'Hz', 49.5, 50.5, 2],
        ['T1 winding', v.tx.T1.temp, '°C', 20, 140, 0], ['T2 winding', v.tx.T2.temp, '°C', 20, 140, 0]];
      $('#d3-meters').innerHTML = m.map(([l, val, u, lo, hi, dp]) => { const p = Math.max(0, Math.min(100, 100 * (val - lo) / (hi - lo))); const warn = (u === '°C' && val > S.consts.TEMP_ALARM) || (u === 'kV' && l !== '33 kV bus' && (val < 10.45 || val > 11.66)); return `<div class="d3-m ${warn ? 'warn' : ''}"><span>${l}</span><b>${val.toFixed(dp)}<small> ${u}</small></b><i style="--p:${p}%"></i></div>`; }).join('');
    }
    function panel(v) {
      const id = st.sel;
      if (!id) return '<p class="dim">Click a breaker, earth switch, transformer, feeder or bus on the diagram.</p>';
      const btn = (act, label, cls) => { const why = sub.check(id.replace('tx.', 'tap.'), act), done = why && /^Already/.test(why); return `<button class="btn ${cls}" data-act="${act}" ${done ? 'disabled' : ''} title="${esc(why || '')}">${why && !done ? '🔒 ' : ''}${label}</button>`; };
      const lock = act => { const why = sub.check(id.replace('tx.', 'tap.'), act); return why && !/^Already/.test(why) ? `<p class="d3-lock">🔒 ${esc(why)}</p>` : ''; };
      if (id.startsWith('cb.') || id.startsWith('es.')) {
        const e = sub.el[id], bo = S.idx.bo[id];
        return `<h3>${esc(e.name)}</h3><p class="d3-st ${e.closed ? 'c' : 'o'}">${e.closed ? 'CLOSED' : 'OPEN'}</p>
          <p class="dim small">${id.startsWith('es.') ? 'Earth switch: local operation only.' : `${Math.round(sub.ampsThrough(id))} A · ${e.ops} operations · DNP3 binary output ${bo}`}</p>
          <div class="row gap">${btn('open', 'Open', 'danger')}${btn('close', 'Close', 'primary')}</div>${lock(e.closed ? 'open' : 'close')}${/^cb\.F/.test(id) ? feeder(id.slice(3)) : ''}`;
      }
      if (id.startsWith('tx.')) {
        const T = v.tx[id.slice(3)];
        return `<h3>Transformer ${id.slice(3)}</h3><p class="dim small">33/11 kV, 20 MVA, 17 taps of 1.25 %, tap 9 nominal. Tap ${T.tap}, ${T.temp.toFixed(1)} °C, ${(T.load * 100).toFixed(0)} % load.</p>
          <div class="row gap">${btn('raise', '▲ Raise', 'primary')}${btn('lower', '▼ Lower', '')}</div>${lock('raise')}<p class="dim small">Over DNP3: binary output ${S.idx.bo['tap.' + id.slice(3)]}, CLOSE raises, TRIP lowers.</p>`;
      }
      if (id.startsWith('fdr.')) return `<h3>${esc(sub.fdr[id.slice(4)].name)}</h3>${feeder(id.slice(4))}`;
      if (id.startsWith('bus.')) { const b = v.bus[id.slice(4)]; return `<h3>11 kV Bus ${id.slice(4)}</h3><p>${b.live ? `${b.kv.toFixed(3)} kV (${(b.kv / 0.11).toFixed(1)} %)` : 'DEAD'}</p><p class="dim small">Capacitor banks and tap changers move the voltage.</p>`; }
      if (id.startsWith('src.')) { const s = id.slice(4); return `<h3>${s} 33 kV line</h3><p>${sub.grid[s] ? 'Supply available' : 'No supply'}</p><button class="btn small" data-line="${s}">${sub.grid[s] ? 'Lose supply' : 'Restore supply'}</button>`; }
      return '';
    }
    function feeder(f) {
      const F = sub.fdr[f];
      return `<p class="dim small">${F.mw.toFixed(2)} MW · ${F.mvar.toFixed(2)} MVAr · ${Math.round(F.amps)} A</p>
        <div class="row gap wrap"><button class="btn small danger" data-fault="${f}" ${F.fault ? 'disabled' : ''}>⚡ Inject fault</button><button class="btn small" data-clear="${f}" ${F.fault ? '' : 'disabled'}>🔧 Clear fault</button>
        <label class="small"><input type="checkbox" data-stuck="${f}" ${F.stuck ? 'checked' : ''}> breaker fails to trip</label></div>`;
    }
    function renderSub() {
      const remote = cfg.mode === 'rf-ms', v = remote ? S.viewFromPoints(ms.db) : sub.view();
      paintDiagram(v); meters(v);
      $('#d3-panel').innerHTML = remote ? `<p>This is the <b>remote</b> substation, drawn only from the DNP3 points received over RF${ms.db.at ? ` (last answer ${((Date.now() - ms.db.at) / 1000).toFixed(0)} s ago)` : ' -- none yet, run an integrity poll'}.</p><p class="dim small">Operate it from the SCADA Master tab.</p>` : panel(v);
      const al = remote ? v.alarms : Object.values(sub.alarms);
      $('#d3-alarms').innerHTML = al.length ? al.map(a => `<li class="${a.level} ${a.acked ? '' : 'new'}">${esc(a.text)}</li>`).join('') : '<li class="dim">No alarms</li>';
      $('#d3-soe').innerHTML = st.soe.slice(0, 30).map(e => `<li class="${e.cls}"><time>${e.t}</time> ${esc(e.text)}</li>`).join('') || '<li class="dim">Switch something -- events land here</li>';
      $('#d3-local').checked = sub.local; $('#d3-bypass').checked = sub.bypass;
      $('#d3-load-v').textContent = Math.round(sub.loadScale * 100) + ' %';
    }

    function renderScada() {
      const db = ms.db, rv = S.viewFromPoints(db);
      $('#d3-auto-t').textContent = isRf() ? '(events every 30 s, integrity every 5 min -- RF)' : '(events every 5 s, integrity every 60 s)';
      if (cfg.mode === 'rf-os') {   // the master is elsewhere: show what this RTU is doing on air
        const iin = os.curIin(), c = [1, 2, 3].map(n => os.events.filter(e => e.cls === n).length), lastRx = [...os.log].reverse().find(e => e.dir === 'rx');
        $('#d3-rtu').innerHTML = `<div class="d3-iins">${[...D.IIN1.map((n, i) => [`1.${i}`, n, iin & (1 << i)]), ...D.IIN2.slice(0, 4).map((n, i) => [`2.${i}`, n, iin & (1 << (i + 8))])].map(([b, n, on]) => `<span class="d3-iin ${on ? 'on' : ''}">${b} ${n}</span>`).join('')}</div>
          <p class="small">Events waiting for the master: class 1 <b>${c[0]}</b> · class 2 <b>${c[1]}</b> · class 3 <b>${c[2]}</b> · clock ${S.fmtOff(os.clockOffset)} · unsolicited ${os.unsol ? 'on' : 'off'}</p>
          <p class="dim small">Last request heard: ${lastRx ? `${esc(lastRx.text)} at ${new Date(lastRx.at).toLocaleTimeString([], { hour12: false })}` : 'none yet'} · frames received ${os.stats.rx}, sent ${os.stats.tx}, CRC errors ${os.stats.crc}, for other addresses ${os.stats.ignored}</p>`;
        $('#d3-evh').textContent = 'Events buffered in this RTU';
        $('#d3-ev').innerHTML = os.events.slice(-30).reverse().map(e => { const q = (e.type === 'bi' ? S.POINTS.bi : e.type === 'ai' ? S.POINTS.ai : S.POINTS.ctr)[e.index] || {}; return `<tr><td><span class="d3-tag">class ${e.cls}</span></td><td>${esc(q.name || String(e.index))}</td><td class="v">${e.value}</td><td class="v">${hhmmss(e.time)}</td><td></td></tr>`; }).join('') || '<tr><td colspan="5" class="dim">None -- switch something on the Substation tab</td></tr>';
      } else $('#d3-evh').textContent = 'Events received';
      const ls = lk ? lk.stats() : null;
      $('#d3-mstat').textContent = `${db.at ? 'last answer ' + ((Date.now() - db.at) / 1000).toFixed(1) + ' s ago' : 'no answer yet'} · round trip ${ms.stats.lastRtt ? Math.round(ms.stats.lastRtt) + ' ms' : '--'} · timeouts ${ms.stats.timeouts}${ls ? ` · ${ls.pps.toFixed(1)} pkt/s, ${ls.bps.toFixed(0)} B/s, ${ls.lost} lost` : ''}${ms.cur ? ' · waiting for: ' + ms.cur.label : ''}`;
      $('#d3-iin').innerHTML = [...D.IIN1.map((n, i) => [`1.${i}`, n, (db.iin || 0) & (1 << i)]), ...D.IIN2.slice(0, 4).map((n, i) => [`2.${i}`, n, (db.iin || 0) & (1 << (i + 8))])].map(([b, n, on]) => `<span class="d3-iin ${on ? 'on' : ''}">${b} ${n}</span>`).join('');
      // control
      const opts = S.POINTS.bo.map((p, i) => `<option value="${i}" ${String(i) === String(st.ctl) ? 'selected' : ''}>${i} · ${esc(p.name)}</option>`).join('');
      const sel = $('#d3-bo'); if (sel.dataset.n !== '1') { sel.innerHTML = opts; sel.dataset.n = '1'; }
      const bo = +sel.value, p = S.POINTS.bo[bo], isTap = p.id.startsWith('tap.');
      const seen = p.id.startsWith('cb.') && rv.el[p.id] && !rv.el[p.id].unknown ? (rv.el[p.id].closed ? 'CLOSED' : 'OPEN') : '--';
      $('#d3-bo-st').innerHTML = `${esc(p.how)}${p.id.startsWith('cb.') ? ` · SCADA sees it <b>${seen}</b>` : ''}`;
      $('#d3-c1').textContent = isTap ? '▲ Raise (CLOSE)' : 'Close (0x41)'; $('#d3-c2').textContent = isTap ? '▼ Lower (TRIP)' : 'Trip (0x81)';
      const sb = st.sbo, left = sb ? Math.max(0, 10 - (Date.now() - sb.at) / 1000) : 0;
      $('#d3-sbo').hidden = !sb;
      if (sb) $('#d3-sbo-t').innerHTML = `<b>SELECTED</b> ${esc(S.POINTS.bo[sb.bo].name)} · ${D.CROB_NAMES[sb.code]} · execute within <b>${left.toFixed(0)} s</b> (OPERATE will carry seq ${(sb.seq + 1) & 15} and the identical object)`;
      // tables
      const here = cfg.mode === 'rf-os', biv = i => (here ? S.POINTS.bi[i].get(sub) : db.bi[i]), aiv = i => (here ? Math.round(S.POINTS.ai[i].get(sub) * S.POINTS.ai[i].scale) : db.ai[i]);
      $('#d3-bi').innerHTML = S.POINTS.bi.map((q, i) => `<tr><td>${i}</td><td>${esc(q.name)}</td><td class="v">${biv(i) == null ? '--' : biv(i)}</td></tr>`).join('');
      $('#d3-ai').innerHTML = S.POINTS.ai.map((q, i) => { const r = aiv(i); return `<tr><td>${i}</td><td>${esc(q.name)}</td><td class="v">${r == null ? '--' : r}</td><td class="v">${r == null ? '' : (r / q.scale).toFixed(q.scale >= 100 ? 2 : q.scale === 10 ? 1 : 0) + ' ' + q.unit}</td></tr>`; }).join('');
      if (cfg.mode !== 'rf-os') $('#d3-ev').innerHTML = db.events.slice(-30).reverse().map(e => {
        const q = (e.g === 2 ? S.POINTS.bi : e.g === 32 ? S.POINTS.ai : S.POINTS.ctr)[e.index] || {}, real = e.timed ? truth.get((e.g === 2 ? 'bi' : e.g === 32 ? 'ai' : 'ctr') + ':' + e.index + ':' + e.time) : null, skew = real != null ? e.time - real : null;
        return `<tr><td><span class="d3-tag ${e.timed ? 't' : ''}">g${e.g}v${e.v}</span></td><td>${esc(q.name || String(e.index))}</td><td class="v">${e.value}</td><td class="v">${e.timed ? hhmmss(e.time) : '<span class="dim">no timestamp</span>'}</td><td class="v ${skew != null && Math.abs(skew) > 1000 ? 'bad' : skew != null && Math.abs(skew) < 50 ? 'ok' : ''}">${skew == null ? (e.timed ? '?' : '') : (skew >= 0 ? '+' : '') + (skew / 1000).toFixed(3) + ' s'}</td></tr>`;
      }).join('') || '<tr><td colspan="5" class="dim">No events yet -- switch something on the Substation tab, then poll</td></tr>';
      const lg = l => l.slice(-40).reverse().map(e => `<li class="${e.dir}"><time>${new Date(e.at).toLocaleTimeString([], { hour12: false })}</time> ${e.dir === 'tx' ? '→' : e.dir === 'rx' ? '←' : e.dir === 'err' ? '✖' : '·'} ${esc(e.text)}</li>`).join('');
      $('#d3-mlog').innerHTML = lg(ms.log); $('#d3-olog').innerHTML = lg(os.log);
      $('#d3-lat-v').textContent = cfg.lat + ' ms'; $('#d3-loss-v').textContent = cfg.loss + ' %';
    }

    function renderInsp() {
      const rows = st.cap.slice(-120).reverse().map(c => `<tr data-n="${c.n}" class="${c.n === st.pick ? 'sel' : ''} ${c.dir}"><td>${c.n}</td><td>${new Date(c.at).toLocaleTimeString([], { hour12: false })}</td><td><span class="d3-who ${c.who}">${c.who === 'M' ? 'MASTER' : c.who === 'R' ? 'FROM AIR' : 'OUTSTATION'}</span></td><td class="v">${c.size}</td><td>${c.dir === 'lost' ? '✖ LOST · ' : ''}${esc(sum(c))}</td></tr>`).join('');
      const tb = $('#d3-cap'); if (tb.dataset.h !== rows) { tb.innerHTML = rows || '<tr><td colspan="5" class="dim">No frames yet -- the master polls every 5 s, or press Integrity poll</td></tr>'; tb.dataset.h = rows; }
      const c = st.cap.find(x => x.n === st.pick);
      if (c && $('#d3-dec').dataset.n !== String(c.n)) { $('#d3-dec').dataset.n = c.n; $('#d3-dec').innerHTML = decode(c.hex, c.label, c.who); }
      const seqH = window.KellyDnp3View.sequence(st.cap.slice(-14).map(x => ({ who: x.who === 'R' ? (cfg.mode === 'rf-os' ? 'M' : 'O') : x.who, at: x.at, lost: x.dir === 'lost', why: x.label, size: x.size, text: window.KellyDnp3View.shortName(x.hex) })), esc);
      if ($('#d3-seq').dataset.h !== seqH) { $('#d3-seq').innerHTML = seqH; $('#d3-seq').dataset.h = seqH; }
      // time sync panel
      const o = $('#d3-off');
      $('#d3-clk-m').textContent = hhmmss(Date.now());
      if (cfg.mode === 'rf-ms') {   // the RTU is elsewhere: all we know is the last g50v1 it sent (late by one air delay)
        const rc = st.rtuClock, off = rc ? rc.time - rc.rx : null;
        $('#d3-clk-o').textContent = rc ? hhmmss(Date.now() + off) : 'read it ↓';
        o.textContent = rc ? S.fmtOff(off) + ' (incl. air delay)' : '--'; o.className = 'd3-off ' + (off == null ? '' : Math.abs(off) > 2000 ? 'bad' : Math.abs(off) > 500 ? 'warn' : 'good');
        $('#d3-need').classList.toggle('on', !!((ms.db.iin || 0) & (1 << D.IIN.NEED_TIME)));
      } else {
        const off = os.clockOffset;
        $('#d3-clk-o').textContent = hhmmss(Date.now() + off);
        o.textContent = S.fmtOff(off); o.className = 'd3-off ' + (Math.abs(off) > 1000 ? 'bad' : Math.abs(off) > 50 ? 'warn' : 'good');
        $('#d3-need').classList.toggle('on', !!(os.iin & (1 << D.IIN.NEED_TIME)));
      }
      const ts = st.ts;
      $('#d3-math').innerHTML = ts && ts.rtt != null ? `
        <div><span>Master sends DELAY MEASURE at</span><b>${hhmmss(ts.t0)}</b></div><div><span>Reply (g52v2) back at</span><b>${hhmmss(ts.t3)}</b></div>
        <div><span>Round trip</span><b>${ts.rtt.toFixed(0)} ms</b></div><div><span>Outstation turnaround (in the g52v2)</span><b>${ts.turn} ms</b></div>
        <div class="big"><span>One-way delay = (round trip − turnaround) ÷ 2</span><b>${ts.delay.toFixed(1)} ms</b></div>
        ${ts.written ? `<div><span>WRITE g50v1 = master clock + delay</span><b>${hhmmss(ts.written)}</b></div>` : ''}${ts.done ? '<div class="good"><span>Outstation clock set, IIN1.4 NEED TIME cleared</span><b>✔</b></div>' : ''}`
        : ts && ts.method === 'lan' ? `<div><span>RECORD CURRENT TIME at</span><b>${hhmmss(ts.t0)}</b></div><div><span>then WRITE g50v3 with that time</span><b>${ts.done ? '✔' : '…'}</b></div><p class="dim small">The LAN method assumes the link delay is near zero, so the clock ends up behind by one link delay. Try it with a slow link.</p>`
        : '<p class="dim">Press Run time sync to see the numbers.</p>';
    }
    const cache = new Map();
    function sum(c) { if (!cache.has(c.n)) { let s; try { s = D.inspect(c.hex).summary; } catch { s = '?'; } cache.set(c.n, s); if (cache.size > 600) cache.delete(cache.keys().next().value); } return cache.get(c.n); }
    function decode(hex, label, who) {
      const V = window.KellyDnp3View, w = who === 'R' ? (cfg.mode === 'rf-os' ? 'M' : 'O') : who;
      return (w ? `<p class="wv-why">💬 ${esc(V.explain(hex, w, S.POINTS))}</p>` : '') + V.decodeHtml(hex, label, esc);
    }
    function reference() {
      $('#d3-ref').innerHTML = `<table class="d3-tbl"><thead><tr><th>Object</th><th>Name</th><th>Bytes / point</th><th>Time</th></tr></thead><tbody>${Object.values(D.OBJ).filter(o => o.d >= 0 || o.g === 60).map(o => `<tr class="${o.t !== 'none' ? 'timed' : ''}"><td>g${o.g}v${o.v}</td><td>${esc(o.name)}</td><td class="v">${o.d > 0 ? o.d : o.d === 0 ? '1 bit' : '--'}</td><td>${{ none: '<span class="dim">none</span>', abs: '⏱ 48-bit ms since 1970 UTC', rel: '⏱ 16-bit ms after a g51 CTO', is: '⏱ is a time / delay' }[o.t]}</td></tr>`).join('')}</tbody></table>`;
    }

    function renderLink() {
      const m = cfg.mode, rf = isRf(), parked = k.rf && k.rf.parked(), ago = t => (t ? `${((Date.now() - t) / 1000).toFixed(0)} s ago` : 'never');
      $$('#page-dnp3 [data-only]').forEach(n => { n.hidden = !n.dataset.only.split(' ').includes(m); });
      $$('#page-dnp3 [data-not]').forEach(n => { n.hidden = n.dataset.not.split(' ').includes(m); });
      $('[data-tabs="dnp3"] button[data-tab="scada"]').textContent = m === 'rf-os' ? 'Outstation (RTU)' : 'SCADA Master';
      $$('#d3-modes [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
      const ls = $('#d3-linkst');
      if (!rf) { ls.className = 'd3-linkst ok'; ls.textContent = 'Simulated link inside this page -- nothing goes on air.'; return; }
      ls.className = 'd3-linkst ' + (parked ? 'ok' : 'bad');
      ls.innerHTML = `${parked ? '📻 Radio parked in Transparent -- DNP3 goes over P25 data.' : `⚠ ${k.rf && k.rf.demo() ? 'The demo radio has no RF.' : 'Radio not parked in Transparent.'} Connect a TM9100 and set Admin › Home mode to Transparent.`}
        This Kelly is the <b>${m === 'rf-os' ? 'OUTSTATION' : 'MASTER'}</b> at DNP3 address <b>${myAddr()}</b>${m === 'rf-ms' ? `, talking to outstation <b>${cfg.osAddr}</b>` : `, answering master <b>${cfg.msAddr}</b>`}. Last sent ${ago(st.rfTx)} · last received ${ago(st.rfRx)}.`;
    }
    function render() {
      if (!st.started || (cfg.plant && cfg.plant !== 'sub')) return;
      renderLink();
      const t = tab();
      if (t === 'sub') renderSub(); else if (t === 'scada') renderScada(); else renderInsp();
    }

    // ------------------------------------------------------------ wiring
    function init() {
      if (!$('#page-dnp3')) return;
      // link mode + DNP3 addresses (changing either rebuilds both stations)
      $('#d3-modes').addEventListener('click', async e => {
        const b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === cfg.mode) return;
        // master on air keys the radio up by itself: every poll is a transmission, sent whether or not an outstation answers
        if (b.dataset.mode === 'rf-ms' && k.confirmBox && !(await k.confirmBox('Make this Kelly the DNP3 master on air?',
          `Your radio will start transmitting by itself, polling for outstation ${cfg.osAddr}: an event poll every 30 s (resent once after 7 s if nothing answers) and an integrity poll every 5 min, for as long as Kelly is open and the radio is parked in Transparent -- even if no outstation is listening. Untick Auto poll on the SCADA Master tab, or switch back to another mode, to stop it.`))) return;
        cfg.mode = b.dataset.mode; save(); st.sbo = null; st.rtuClock = null; build(); dirty('dnp3'); });
      const addr = (id, key) => { const n = $(id); n.value = cfg[key]; n.onchange = () => { const v = Math.max(0, Math.min(65519, Math.round(+n.value) || 0)); n.value = v; cfg[key] = v; save(); build(); dirty('dnp3'); }; };
      addr('#d3-osaddr', 'osAddr'); addr('#d3-msaddr', 'msAddr');
      $('#d3-diagram').innerHTML = diagram();
      svg = $('#d3-diagram svg');
      svg.querySelectorAll('[data-k]').forEach(n => (N[n.dataset.k] = N[n.dataset.k] || []).push(n));
      svg.querySelectorAll('[data-v]').forEach(n => { V[n.dataset.v] = n; });
      svg.querySelectorAll('[data-id]').forEach(n => { E[n.dataset.id] = n; });
      const pickAt = e => { const g = e.target.closest('[data-id]'); if (g) { st.sel = g.dataset.id; dirty('dnp3'); } };
      svg.addEventListener('click', pickAt);
      svg.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickAt(e); } });
      $('#d3-panel').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.act) sub.operate(st.sel.replace('tx.', 'tap.'), b.dataset.act, 'local');
        if (b.dataset.fault) { sub.fdr[b.dataset.fault].fault = true; sub.solve(0); }
        if (b.dataset.clear) { if (sub.fdr[b.dataset.clear].live) toast('🔧', 'Open the feeder first', 'The repair crew only works on a dead feeder', 'bad'); else { sub.fdr[b.dataset.clear].fault = false; sub.fdr[b.dataset.clear].tripped = false; } }
        if (b.dataset.line) { const s = b.dataset.line; sub.grid[s] = !sub.grid[s]; sub.solve(0); }
        dirty('dnp3');
      });
      $('#d3-panel').addEventListener('change', e => { const c = e.target.closest('[data-stuck]'); if (c) sub.fdr[c.dataset.stuck].stuck = c.checked; });
      $('#d3-local').onchange = e => { sub.local = e.target.checked; dirty('dnp3'); };
      $('#d3-bypass').onchange = e => { sub.bypass = e.target.checked; dirty('dnp3'); };
      $('#d3-load').oninput = e => { sub.loadScale = +e.target.value / 100; dirty('dnp3'); };
      $('#d3-ack').onclick = () => { sub.ackAlarms(); dirty('dnp3'); };
      $('#d3-reset').onclick = () => { sub.reset(); build(); st.soe = []; st.sbo = null; $('#d3-load').value = 100; dirty('dnp3'); toast('⚡', 'Substation reset', 'Normal running arrangement'); };
      $('#d3-sfx').checked = cfg.sfx; $('#d3-sfx').onchange = e => { cfg.sfx = e.target.checked; save(); };
      $('#d3-hum').checked = cfg.hum; $('#d3-hum').onchange = e => { cfg.hum = e.target.checked; save(); };
      // master
      $('#d3-integ').onclick = () => ms.integrity();
      $('#d3-c123').onclick = () => ms.poll([1, 2, 3]);
      $('#d3-unsol').onclick = () => ms.unsolicited(!os.unsol);
      $('#d3-tsync').onclick = () => ms.timeSync('nonlan');
      $('#d3-tsync2').onclick = () => ms.timeSync('nonlan');
      $('#d3-tlan').onclick = () => ms.timeSync('lan');
      $('#d3-tread').onclick = () => ms.readTime();
      $('#d3-skew').onclick = () => { os.clockOffset = (Math.random() < 0.5 ? -1 : 1) * (3000 + Math.random() * 6000); os.iin |= 1 << D.IIN.NEED_TIME; dirty('dnp3'); };
      $('#d3-restart').onclick = () => ms.restart(true);
      $('#d3-auto').checked = cfg.auto; $('#d3-auto').onchange = e => { cfg.auto = e.target.checked; save(); };
      $('#d3-lat').value = cfg.lat; $('#d3-lat').oninput = e => { cfg.lat = +e.target.value; if (lk) lk.cfg.lat = cfg.lat; save(); dirty('dnp3'); };
      $('#d3-loss').value = cfg.loss; $('#d3-loss').oninput = e => { cfg.loss = +e.target.value; if (lk) lk.cfg.loss = cfg.loss; save(); dirty('dnp3'); };
      $('#d3-biev').value = cfg.biEv; $('#d3-aiev').value = cfg.aiEv;
      $('#d3-biev').onchange = e => { cfg.biEv = +e.target.value; os.cfg.biEvent = cfg.biEv; save(); };
      $('#d3-aiev').onchange = e => { cfg.aiEv = +e.target.value; os.cfg.aiEvent = cfg.aiEv; save(); };
      $('#d3-bo').onchange = e => { st.ctl = e.target.value; st.sbo = null; dirty('dnp3'); };
      const code = n => { const p = S.POINTS.bo[+$('#d3-bo').value]; return n === 1 ? D.CROB.CLOSE : p.id === 'reset' ? D.CROB.PULSE_ON : D.CROB.TRIP; };
      const send = n => {
        const bo = +$('#d3-bo').value, mode = $('#d3-mode').value, c = code(n);
        if (mode === 'sbo') ms.task({ label: `SELECT ${S.POINTS.bo[bo].name} ${D.CROB_NAMES[c] || ''}`, fc: D.FC.SELECT, objs: D.crob(bo, c), ctrl: { bo, code: c } });
        else ms.direct(bo, c, { nr: mode === 'nr' });
      };
      $('#d3-c1').onclick = () => send(1); $('#d3-c2').onclick = () => send(2);
      $('#d3-exec').onclick = () => { const s = st.sbo; if (!s) return; st.sbo = null; ms.task({ label: `OPERATE ${S.POINTS.bo[s.bo].name} ${D.CROB_NAMES[s.code] || ''}`, fc: D.FC.OPERATE, objs: s.objs, ctrl: { bo: s.bo, code: s.code }, seqOverride: (s.seq + 1) & 15 }); };
      $('#d3-cancel').onclick = () => { st.sbo = null; dirty('dnp3'); };
      // inspector
      $('#d3-cap').addEventListener('click', e => { const r = e.target.closest('tr[data-n]'); if (r) { st.pick = +r.dataset.n; dirty('dnp3'); } });
      $('#d3-dec').addEventListener('mouseover', e => { const f = e.target.closest('[data-f]'); $$('#d3-dec .hot').forEach(n => n.classList.remove('hot')); if (f && f.dataset.f !== '-1') $$(`#d3-dec [data-f="${f.dataset.f}"]`).forEach(n => n.classList.add('hot')); });
      $('#d3-clear').onclick = () => { st.cap = []; st.pick = null; $('#d3-dec').innerHTML = ''; $('#d3-dec').dataset.n = ''; dirty('dnp3'); };
      $('#d3-paste-go').onclick = () => { const h = $('#d3-paste').value; if (!/^[\s0-9a-f]+$/i.test(h) || h.replace(/\s/g, '').length < 20) { toast('🔍', 'Paste a DNP3 frame in hex', 'It starts 05 64'); return; } st.pick = null; $('#d3-dec').dataset.n = 'paste'; $('#d3-dec').innerHTML = decode(h.replace(/\s/g, ''), 'pasted', null); };
      reference();
      build();
    }
    function shown() {
      if (!st.started) {
        st.started = true;
        if (window.KellyDnp3Fx) { fx = window.KellyDnp3Fx.audio(() => k.audioCtx(), () => (settings.soundVol == null ? 0.8 : +settings.soundVol)); sp = window.KellyDnp3Fx.sparks($('#d3-fx')); }
        setInterval(tick, 250);
        if (cfg.mode === 'sim') setTimeout(() => ms.integrity(), 400);
      }
      dirty('dnp3');
    }
    return { init, render, shown };
  };
})();
