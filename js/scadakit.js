/* Kelly Page -- the SCADA trainer kit: the page side every DNP3 Demo trainer plant shares (window.KellyScadaKit).
 * Used by js/wivenhoeui.js (Wivenhoe pumped storage) and js/mackaygtui.js (Mackay gas turbine).
 *
 * The kit owns: the outstation + master + link (js/dnp3sim.js, js/dnp3link.js, or the parked radio), roles
 * both / master / outstation x link sim / rf, frame capture, "What just happened?", SBO step tracker, stale-SCADA logic,
 * alarms (new = 3 flashes then steady + UNACK, kelly-page/CLAUDE.md), polling, the demo sequencer's commands, the
 * challenge harness, and the Packet inspector / Sequence / Points / Alarms & events / Challenges / Settings tabs.
 * The plant brings its model module (POINTS, idx, MODES, Sequencer, CHALLENGES, viewFromPoints -- see js/scadacore.js),
 * its mimic and its operator panel, through `spec`:
 *
 *   key        settings.dnp3.plant value that selects it ('wiv')     prefix  DOM id prefix ('wv' -> #wv-root, #wv-role ...)
 *   cfgKey     settings key for its config ('wiv')                    model   the plant module (window.Wivenhoe)
 *   plant      the model instance                                    defaults extra / changed config defaults
 *   title, intro, simTag, psndLabel, topExtra   header text + markup   osCfg(rf) extra outstation cfg
 *   mimic()    SVG markup        below()  markup under the mimic row (optional)      opHtml()  the operator panel
 *   tabs       [{ key, label, html }] extra tabs, after Operator      rfNote(role) a line about the far end on air
 *   hooks(api) -> { paint(v, stale, frozen), frame(now, dt) -> ms to the next frame, renderOp(v), renderTab(key, v),
 *                   bind(root), event(e), alarms(v, add), sound(v, on), tick(dt), phaseText(seq, mode),
 *                   localSetpoint(ao, value), reset() -> [icon, title, text] }  -- all optional but paint/opHtml
 *
 * window.KellyScadaKit(ctx, spec) -> { init, render, shown, active, claimRf, debug, api }
 */
(function () {
  'use strict';
  const D = window.DNP3, S = window.DNP3Sim, V = window.KellyDnp3View, L = window.DNP3Link, SC = window.ScadaCore;

  window.KellyScadaKit = function (k, spec) {
    const { $, $$, esc, toast, dirty, settings } = k;
    const W = spec.model, P = W.POINTS, X = spec.prefix, plant = spec.plant;
    const id = s => `${X}-${s}`, q = s => $('#' + id(s));
    const cfg = settings[spec.cfgKey] = Object.assign({ role: 'both', link: 'sim', time: Object.keys(W.MODES)[0], speed: 60, view: 'scada', muted: true, vol: 0.7, psnd: false,
      lat: 100, loss: 0, rssi: -85, p25: true, evAll: false, integ: 60, evPoll: 5, timeout: 7, retries: 1, osAddr: 10, msAddr: 1, ctl: 'sbo', auto: true, unsol: false,
      bufs: [100, 100, 100], results: {} }, spec.defaults || {}, settings[spec.cfgKey] || {});
    if (!W.MODES[cfg.time]) cfg.time = Object.keys(W.MODES)[0];
    const save = () => k.saveSoon && k.saveSoon('settings');
    const st = { started: false, cap: [], capN: 0, open: null, exp: [], soe: [], lastInteg: 0, lastPoll: 0, track: null, chg: {}, prev: {}, alarms: {}, chal: null,
      polls: 0, answered: 0, ctrlOk: 0, staleMax: 0, lastBlock: null, chirpAt: 0, rfTx: 0, rfRx: 0 };
    let os, ms, link, seq = new W.Sequencer(cfg.time), fx, framer, rawRx = null;
    const active = () => (settings.dnp3 || {}).plant === spec.key;
    const onPage = () => k.currentPage() === 'dnp3' && active() && !document.hidden;
    const tab = () => { const b = $(`[data-tabs="${X}"] button.on`); return b ? b.dataset.tab : 'op'; };
    const rf = () => cfg.link === 'rf';
    const masterHere = () => cfg.role !== 'outstation' || !rf();          // in simulation a stand-in master polls the RTU
    const plantHere = () => !(rf() && cfg.role === 'master');
    const useMaster = () => cfg.role !== 'outstation';                    // operator controls go over DNP3
    const hhmmss = t => { const d = new Date(t); return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
    const sndOn = () => !cfg.muted && fx && onPage();
    const play = (n, ...a) => { if (sndOn() && fx[n]) try { fx[n](...a); } catch {} };
    const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const linkPt = W.idx.bi.link != null ? P.bi[W.idx.bi.link] : null;
    const setHtml = (n, h) => { if (n && n.dataset.h !== h) { n.innerHTML = h; n.dataset.h = h; } };

    // ---------------------------------------------------------------- engine
    function build() {
      if (os) os.detach(); if (link) link.close();
      const R = rf(), b = cfg.bufs;
      os = new S.Outstation(plant, { addr: cfg.osAddr, master: cfg.msAddr, unsol: cfg.unsol,
        cfg: Object.assign({ biEvent: 2, aiEvent: 4, aiStatic: R ? 4 : 2, biStatic: R ? 1 : 2, lean: R, maxEvPerReply: R ? 8 : cfg.p25 ? 12 : 40, mostRecent: cfg.evAll ? null : ['ai', 'ctr'],
          classMax: { 1: b[0], 2: b[1], 3: b[2] }, maxEvents: b[0] + b[1] + b[2] }, spec.osCfg ? spec.osCfg(R) : {}) });
      ms = new S.Master({ addr: cfg.msAddr, dest: cfg.osAddr, autoTime: true, timeout: cfg.timeout * 1000, retries: cfg.retries, points: P });
      os.turnaroundMs = R ? 0 : 20;
      os.send = () => {}; ms.send = () => {};
      link = null;
      if (!R) {
        link = new L.Link({ lat: cfg.lat, loss: st.chal && st.lossOverride != null ? st.lossOverride : cfg.loss, rssi: cfg.rssi, p25: cfg.p25 });
        link.join(ms, os);
        link.on(onLink);
      } else if (cfg.role === 'master') ms.send = f => air('M', f);
      else os.send = f => air('O', f);
      framer = new D.Framer(fromAir);
      rawRx = R ? b2 => framer.push(b2) : null;
      ms.on(onMaster);
      os.on(e => { if (e.type === 'unsol') { cfg.unsol = e.on; save(); } if (e.type === 'overflow' && Date.now() - (st.ovAt || 0) > 5000) { st.ovAt = Date.now(); soe(`Class ${e.cls} event buffer FULL -- oldest event thrown away (IIN2.3)`, 'warn'); } });
      st.lastInteg = 0; st.lastPoll = 0; st.track = null;
    }
    // simulated link -> capture, chirps
    const byFrame = new WeakMap();
    function onLink(e) {
      if (e.type === 'tx') { const c = capture(e.from, e.frame, { arrive: Date.now() + (e.at - performance.now()), air: e.air }); byFrame.set(e.frame, c); if (Date.now() - st.chirpAt > 140) { st.chirpAt = Date.now(); play('chirp', e.from === 'O'); } }
      else if (e.type === 'lost') { const c = byFrame.get(e.frame) || capture(e.from, e.frame, {}); c.lost = true; c.why = e.why; }
      if (e.type === 'cut') dirty('dnp3');
    }
    function capture(who, f, o) {
      const hex = D.hex(f);
      const c = { n: ++st.capN, at: Date.now(), who, hex, size: f.length, name: V.shortName(hex), ...o };
      if (!st.hold) { st.cap.push(c); if (st.cap.length > 300) st.cap.shift(); }
      st.exp.unshift({ at: c.at, who, text: V.explain(hex, who, P), c }); if (st.exp.length > 40) st.exp.pop();
      return c;
    }
    // real radio
    function air(who, f) {
      if (!k.rf || !k.rf.parked()) {
        const c = capture(who, f, {}); c.lost = true; c.why = k.rf && k.rf.demo() ? 'not sent: the demo radio has no RF' : 'not sent: radio not parked in Transparent';
        if (Date.now() - (st.rfWarnAt || 0) > 15000) { st.rfWarnAt = Date.now(); toast('📻', 'DNP3 not sent', 'Park a TM9100 in Transparent (Admin › Home mode) to put DNP3 on air', 'bad'); }
        return;
      }
      st.rfTx = Date.now(); capture(who, f, { air: D.airSeconds(f.length) * 1000 }); play('chirp', false);
      k.rf.send(f, `DNP3 ${who === 'O' ? 'reply' : 'request'} ${f.length} B`);
    }
    function fromAir(f) {
      const Lk = D.parseLink(f), me = cfg.role === 'master' ? cfg.msAddr : cfg.osAddr;
      if (Lk.ok && Lk.src === me && Lk.dest !== me) return;   // our own call, repeated back by the repeater
      st.rfRx = Date.now(); capture(cfg.role === 'master' ? 'O' : 'M', f, {}); play('chirp', true);
      (cfg.role === 'master' ? ms : os).receive(f);
    }
    function onMaster(e) {
      if (e.type === 'done' && !(e.task.ctrl)) { if (st.chal) { st.polls++; if (e.ok) st.answered++; } }
      if (e.type === 'ctrl') {
        const t = st.track;
        if (t && e.task.ctrl && (t.bo != null ? t.bo === e.task.ctrl.bo : t.ao === e.task.ctrl.ao)) {
          if (e.sbo) { t.stage = e.ok ? 'operate' : 'refused'; t.status = e.status; }
          else { t.stage = e.ok ? 'done' : 'refused'; t.status = e.status; }
          t.at = Date.now();
        }
        if (!e.ok && e.status === 14) { soe(`${e.task.label}: already done`, ''); if (t) { t.stage = 'done'; t.why = 'already done'; } }
        else if (!e.ok) {
          play('blocked');
          const why = e.status === 15 && st.lastBlock && Date.now() - st.lastBlock.at < 8000 ? st.lastBlock.reason : D.CROB_STATUS[e.status] || 'status ' + e.status;
          toast('⛔', `Refused by the RTU: ${D.CROB_STATUS[e.status] || e.status}`, why, 'bad');
          if (t) t.why = why;
        } else if (!e.sbo) { play('coin'); if (st.chal) st.ctrlOk++; }
      }
      if (e.type === 'timeout') { if (st.track && st.track.stage !== 'done') { st.track.stage = 'timeout'; } if (st.chal) st.polls++; }
      if (tab() !== 'op') dirty('dnp3');
    }
    function soe(text, cls) { st.soe.unshift({ at: Date.now(), text, cls }); if (st.soe.length > 80) st.soe.pop(); }

    // ---------------------------------------------------------------- what the screens show
    function scadaStale() {
      if (!masterHere()) return null;
      const db = ms.db, lim = Math.max(3 * effPoll().ev, cfg.timeout + 5) * 1000;
      if (!db.at) return 'NO DATA YET -- waiting for the first poll';
      const age = Date.now() - db.at;
      if (link && link.down) return `LINK CUT -- data frozen ${Math.round(age / 1000)} s ago`;
      return age > lim ? `STALE -- last answer ${Math.round(age / 1000)} s ago` : null;
    }
    const showScada = () => cfg.role === 'master' || (cfg.role === 'both' && cfg.view === 'scada');
    function curView() { return showScada() ? W.viewFromPoints(ms.db) : plant.view(); }
    function effPoll() { return rf() ? { ev: Math.max(15, cfg.evPoll), integ: Math.max(120, cfg.integ) } : { ev: cfg.evPoll, integ: cfg.integ }; }
    function alarmList(v, stale) {
      const a = [], add = (aid, text, level, first) => a.push({ id: aid, text, level, first: !!first });   // first = the first-up trip
      if (H.alarms) H.alarms(v, add);
      if (linkPt && v.link === false) add('link', `${linkPt.code}: the RTU says its P25 link is unhealthy`, 'warn');
      if (stale && showScada() && !/NO DATA/.test(stale)) add('comms', 'SCADA COMMS FAIL -- the master has lost the RTU', 'bad');
      return a;
    }
    function trackAlarms(list) {
      const now = Date.now(), ids = new Set(list.map(a => a.id)); let fresh = false;
      for (const a of list) { const was = st.alarms[a.id]; if (!was) { st.alarms[a.id] = { ...a, at: now, acked: false }; fresh = true; soe('ALARM: ' + a.text, a.level === 'bad' ? 'bad' : 'warn'); } else { was.first = a.first; was.text = a.text; } }
      for (const aid of Object.keys(st.alarms)) if (!ids.has(aid)) { soe('Cleared: ' + st.alarms[aid].text, ''); delete st.alarms[aid]; }
      if (fresh) play('horn');
    }
    function ackAll() { for (const a of Object.values(st.alarms)) a.acked = true; if (plant.ackAlarms) plant.ackAlarms(); if (fx) fx.hornStop(); dirty('dnp3'); }

    // ---------------------------------------------------------------- commands
    function issue(cmd, by = 'operator') {
      if (useMaster()) {
        if (!masterHere()) return;
        const b = SC.boFor(P, W.idx, cmd); if (!b) return;
        const code = b.close === true ? D.CROB.CLOSE : b.close === false ? D.CROB.TRIP : D.CROB.PULSE_ON, name = `${P.bo[b.bo].code} ${P.bo[b.bo].name}`;
        if (cfg.ctl === 'sbo') { ms.sbo(b.bo, code); st.track = { bo: b.bo, name: `${name} · ${D.CROB_NAMES[code]}`, stage: 'select', at: Date.now(), sbo: true, by }; }
        else { ms.direct(b.bo, code); st.track = { bo: b.bo, name: `${name} · ${D.CROB_NAMES[code]}`, stage: 'direct', at: Date.now(), sbo: false, by }; }
      } else {
        const r = plant.command(cmd, by === 'demo' ? 'demo' : 'local');
        if (!r.ok && r.status === 14 && by !== 'demo') toast('ℹ️', 'Nothing to do', r.reason);
      }
      dirty('dnp3');
    }
    // ao = AO index, value in engineering units (raw on the wire = value x the point's scale)
    function setpoint(ao, value, by = 'operator') {
      const p = P.ao[ao];
      if (useMaster()) {
        if (!masterHere()) return;
        ms.setpoint(ao, Math.round(value * (p.scale || 1)), { direct: cfg.ctl !== 'sbo' });
        st.track = { ao, name: `${p.code} ${p.name} = ${value} ${p.unit}`, stage: cfg.ctl === 'sbo' ? 'select' : 'direct', at: Date.now(), sbo: cfg.ctl === 'sbo', by };
      } else if (H.localSetpoint) H.localSetpoint(ao, value, by === 'demo' ? 'demo' : 'local');
      dirty('dnp3');
    }

    // ---------------------------------------------------------------- tick (4 Hz, independent of the comms)
    function tick() {
      if (!active()) return;
      const dt = 0.25, t = Date.now();
      if (!st.chal) plant.accel = cfg.time === 'manual' ? +cfg.speed : W.MODES[cfg.time].accel;
      if (plantHere()) {
        plant.tick(dt);
        const s = link ? link.stats() : null;
        if (s) st.pktEma = st.pktEma == null ? s.pps * 60 : st.pktEma * 0.97 + s.pps * 60 * 0.03;   // smoothed, or every packet is an event
        SC.rtuComms(plant, os, { timeoutMs: Math.max(20, 3 * effPoll().ev + 5) * 1000, rssi: link ? link.cfg.rssi : cfg.rssi, pktPerMin: st.pktEma == null ? plant.p25.pktRate : Math.round(st.pktEma) });
        os.scan();
      }
      // the demo drives the plant -- over DNP3 when there's a master, so its controls show in the inspector too.
      // A sequencer step 'fault:<what>' is something going wrong AT the plant (not a control), so it skips DNP3.
      if (!st.chal && cfg.time !== 'manual' && (plantHere() || useMaster())) {
        const v = useMaster() ? (ms.db.at ? W.viewFromPoints(ms.db) : null) : plant.view();
        const busy = useMaster() && (ms.queue.some(x => x.ctrl) || (ms.cur && ms.cur.ctrl));   // one control at a time on the link
        const c = seq.next(dt, busy ? null : v, plantHere() ? x => plant.check(x) : null);
        if (c && typeof c === 'object' && c.ao != null) setpoint(c.ao, c.value, 'demo');
        else if (c && c.startsWith('fault:')) { if (plantHere() && plant.fault) plant.fault(c.slice(6), 'demo'); }
        else if (c) issue(c, 'demo');
      }
      if (masterHere() && cfg.auto) {
        const pp = effPoll();
        if (!ms.cur && !ms.queue.length) {
          if (t - st.lastInteg > pp.integ * 1000) { st.lastInteg = st.lastPoll = t; ms.integrity(); }
          else if (t - st.lastPoll > pp.ev * 1000) { st.lastPoll = t; ms.poll([1, 2, 3]); }
        }
      }
      if (st.chal) chalTick(dt);
      if (st.track && ['done', 'refused', 'timeout'].includes(st.track.stage) && t - st.track.at > 15000) st.track = null;
      const v = curView(); trackAlarms(alarmList(v, scadaStale()));
      if (H.tick) H.tick(dt, v);
      if (fx && H.sound) H.sound(v, cfg.psnd && sndOn());
      if (onPage()) dirty('dnp3');
    }

    // ---------------------------------------------------------------- challenges
    function chalStart(key) {
      if (rf()) { toast('🏆', 'Challenges need the simulated link', 'Switch Link to Simulated P25'); return; }
      const def = W.CHALLENGES[key];
      if (def.needsMaster && !useMaster()) { toast('📡', `${def.name} needs a master`, 'Switch Role to Both or Master station -- the controls have to cross the radio link'); return; }
      const ctx = { setLoss: x => { st.lossOverride = x; if (link) link.cfg.loss = x == null ? cfg.loss : x; }, get ctrlOk() { return st.ctrlOk; }, get polls() { return st.polls; }, get answered() { return st.answered; }, get staleMax() { return st.staleMax; } };
      st.ctrlOk = 0; st.polls = 0; st.answered = 0; st.staleMax = 0; st.result = null;
      st.chal = { key, def, ctx, t: 0 };
      def.setup(plant, ctx); seq = new W.Sequencer(cfg.time); st.lastInteg = 0;
      if (H.chalStart) H.chalStart(key);
      soe(`Challenge started: ${def.name}`, 'sc'); play('badge');
      toast(def.icon, def.name, def.brief);
      dirty('dnp3');
    }
    function chalEnd() { const c = st.chal; st.chal = null; st.lossOverride = null; if (link) link.cfg.loss = cfg.loss; if (c && c.def.end) c.def.end(plant, c.ctx); }
    function chalTick(dt) {
      const c = st.chal; c.t += dt;
      if (masterHere() && ms.db.at) st.staleMax = Math.max(st.staleMax, (Date.now() - ms.db.at) / 1000);
      const r = c.def.tick(plant, c.ctx, c.t);
      if (!r) return;
      chalEnd();
      st.result = { key: c.key, ...r, at: Date.now() };
      const best = cfg.results[c.key], better = (a, b2) => (c.def.lowerWins ? a < b2 : a > b2);
      if (r.pass && (!best || r.stars > best.stars || (r.stars === best.stars && better(r.score, best.score)))) { cfg.results[c.key] = { stars: r.stars, score: r.score, at: Date.now() }; save(); }
      play(r.pass ? 'win' : 'fail');
      soe(`Challenge ${r.pass ? 'PASSED' : 'failed'}: ${c.def.name} -- ${r.text}`, r.pass ? 'sc' : 'bad');
      toast(r.pass ? '🏆' : '💥', `${c.def.name}: ${r.pass ? '★'.repeat(r.stars) : 'not this time'}`, r.text, r.pass ? '' : 'bad');
      dirty('dnp3');
    }

    // ---------------------------------------------------------------- the api the plant's hooks get
    const api = {
      cfg, st, plant, W, P, X, q, id, esc, k,
      get ms() { return ms; }, get os() { return os; }, get link() { return link; }, get seq() { return seq; }, get fx() { return fx; },
      play, soe, issue, setpoint, ackAll, showScada, scadaStale, curView, rf, useMaster, masterHere, plantHere, onPage, reduced, sndOn, save,
      dirty: () => dirty('dnp3'), toast,
    };
    const H = spec.hooks(api) || {};

    // plant events: interlock blocks are the kit's (the refusal text), the rest is the plant's own log
    plant.on(e => {
      if (e.type === 'block') { st.lastBlock = { at: Date.now(), reason: e.reason }; soe(`Interlock: ${e.reason}`, 'warn'); if (e.by === 'local') { play('blocked'); toast('🔒', 'Interlock', e.reason, 'bad'); } return; }
      if (H.event) H.event(e);
    });

    // ---------------------------------------------------------------- page shell (inside #<prefix>-root)
    function shell() {
      const seg = (sid, opts) => `<div class="sk-seg" id="${id(sid)}">${opts.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join('')}</div>`;
      const sl = (sid, label, min, max, step) => `<label class="sk-sl"><span>${label} <b id="${id(sid)}-v"></b></span><input type="range" id="${id(sid)}" min="${min}" max="${max}" step="${step}" aria-label="${label}"></label>`;
      const tabs = spec.tabs || [];
      return `
    <div class="card sk-top">
      <div class="card-h"><h2>${spec.title}</h2><span class="tag sk-sim">${spec.simTag}</span></div>
      <p class="dim small">${spec.intro}</p>
      <div class="sk-ctl">
        <div><span class="sk-k">Role</span>${seg('role', [['both', '🔁 Both (loopback)'], ['master', '🎛️ Master station'], ['outstation', '📟 Outstation (RTU)']])}</div>
        <div><span class="sk-k">Link</span>${seg('link', [['sim', '🧪 Simulated P25'], ...(!window.KellyEnt || KellyEnt.allowed('p25.transparent') ? [['rf', '📻 Real P25 radio']] : [])])}</div>
        <div><span class="sk-k">Time</span><select id="${id('time')}">${Object.entries(W.MODES).map(([m, M]) => `<option value="${m}">${M.name}</option>`).join('')}</select>
          <select id="${id('speed')}" aria-label="Manual time speed"><option value="1">×1</option><option value="10">×10</option><option value="60">×60</option><option value="300">×300</option></select><span class="dim small" id="${id('phase')}"></span></div>
        <div><span class="sk-k">Screen</span>${seg('view', [['scada', '🖥️ SCADA (what the master knows)'], ['plant', '🏭 Plant (the truth)']])}</div>
        <div class="sk-snd"><button class="btn small" id="${id('mute')}"></button><input type="range" id="${id('vol')}" min="0" max="1" step="0.05" aria-label="Volume"><label class="chk small"><input type="checkbox" id="${id('psnd')}"> ${spec.psndLabel || 'plant sound'}</label>${spec.topExtra || ''}</div>
      </div>
      <p class="sk-linkst" id="${id('linkst')}"></p>
    </div>
    <div class="sk-main">
      <div class="card sk-mwrap"><div class="sk-mimicbox" id="${id('mimic')}">${spec.mimic()}</div><div class="sk-ann" id="${id('ann')}"></div></div>
      <div class="card sk-linkcard">
        <div class="card-h"><h2>📡 P25 link</h2><button class="btn small sk-cut" id="${id('cut')}"></button></div>
        <div class="sk-simlink" id="${id('simlink')}">${sl('lat', 'Extra latency', 0, 2000, 50)}${sl('loss', 'Packet loss', 0, 60, 1)}${sl('rssi', 'RSSI', -125, -60, 1)}
          <label class="chk small"><input type="checkbox" id="${id('p25')}"> P25 air time (half-duplex, ~2.7 kbit/s, 0.56 s key-up)</label></div>
        <div class="sk-stats" id="${id('stats')}"></div>
        <p class="dim small" id="${id('cutnote')}"></p>
      </div>
    </div>
    ${spec.below ? spec.below() : ''}
    <div class="tabs" data-tabs="${X}"><button data-tab="op" class="on">Operator</button>${tabs.map(t => `<button data-tab="${t.key}">${t.label}</button>`).join('')}<button data-tab="insp">Packet inspector</button><button data-tab="seq">Sequence</button><button data-tab="pts">Points</button><button data-tab="ev">Alarms &amp; events</button><button data-tab="ch">Challenges</button><button data-tab="cfg">Settings</button></div>
    <div class="tab on" data-tabpane="${X}:op">
      <div class="card sk-ctltrack" id="${id('track')}"></div>
      ${spec.opHtml()}
      <div class="card"><div class="card-h"><h2>💬 What just happened?</h2><span class="dim small">each DNP3 exchange in plain English</span></div><ol class="sk-explain" id="${id('explain')}"></ol></div>
    </div>
    ${tabs.map(t => `<div class="tab" data-tabpane="${X}:${t.key}">${t.html()}</div>`).join('')}
    <div class="tab" data-tabpane="${X}:insp">
      <div class="card"><div class="card-h"><h2>Live packet inspector</h2><div class="row gap"><label class="chk small"><input type="checkbox" id="${id('hold')}"> pause</label><button class="btn small" id="${id('clear')}">Clear</button></div></div>
        <p class="dim small">Every DNP3 frame on the link, newest first. Click one to open it: the plain-English version, then every byte.</p>
        <div class="d3-scroll tall"><table class="d3-tbl d3-click sk-pkts"><thead><tr><th>#</th><th>Time</th><th>Direction</th><th>Function</th><th>B</th><th>Air</th><th>Summary</th></tr></thead><tbody id="${id('pkts')}"></tbody></table></div>
      </div>
    </div>
    <div class="tab" data-tabpane="${X}:seq"><div class="card"><div class="card-h"><h2>Sequence diagram</h2><span class="dim small">the last 14 frames; the slope is the time on air</span></div><div id="${id('seq')}"></div></div></div>
    <div class="tab" data-tabpane="${X}:pts"><div class="card"><div class="card-h"><h2>Point list</h2><span class="dim small" id="${id('ptsrc')}"></span></div><div class="d3-scroll tall"><table class="d3-tbl sk-ptbl"><thead><tr><th>Point</th><th>Name</th><th>Value</th><th>Raw</th><th>Class</th><th>Quality</th><th>Last change</th></tr></thead><tbody id="${id('pts')}"></tbody></table></div></div></div>
    <div class="tab" data-tabpane="${X}:ev">
      <div class="card"><div class="card-h"><h2>🚨 Alarms</h2><button class="btn small" id="${id('ack')}">Acknowledge all</button></div><div id="${id('alarms')}"></div></div>
      <div class="d3-row">
        <div class="card"><div class="card-h"><h2>Events received by the master</h2><span class="dim small">stamped by the RTU's clock</span></div><div class="d3-scroll"><table class="d3-tbl"><thead><tr><th>RTU time</th><th>Point</th><th>Value</th><th>Class</th></tr></thead><tbody id="${id('mev')}"></tbody></table></div></div>
        <div class="card"><div class="card-h"><h2>Station event log</h2><span class="dim small">what happened at the plant</span></div><div class="d3-scroll"><table class="d3-tbl"><tbody id="${id('soe')}"></tbody></table></div></div>
      </div>
    </div>
    <div class="tab" data-tabpane="${X}:ch"><div class="card"><div class="card-h"><h2>🏆 Challenges</h2><span class="dim small">need the simulated link</span></div><div id="${id('chal')}" class="sk-chal"></div></div></div>
    <div class="tab" data-tabpane="${X}:cfg">
      <div class="d3-row">
        <div class="card"><div class="card-h"><h2>Master station</h2></div>
          <div class="sk-form">
            <label class="fld inline small"><span>Master address</span><input type="number" id="${id('msaddr')}" min="0" max="65519"></label>
            <label class="fld inline small"><span>Outstation address</span><input type="number" id="${id('osaddr')}" min="0" max="65519"></label>
            <label class="fld inline small"><span>Integrity poll (class 0), s</span><input type="number" id="${id('integ')}" min="10" max="3600"></label>
            <label class="fld inline small"><span>Event poll (class 1/2/3), s</span><input type="number" id="${id('evpoll')}" min="1" max="600"></label>
            <label class="fld inline small"><span>Response timeout, s</span><input type="number" id="${id('timeout')}" min="1" max="60"></label>
            <label class="fld inline small"><span>Retries</span><input type="number" id="${id('retries')}" min="0" max="5"></label>
            <label class="fld inline small"><span>Controls</span><select id="${id('ctlmode')}"><option value="sbo">Select before operate</option><option value="direct">Direct operate</option></select></label>
            <label class="chk small"><input type="checkbox" id="${id('auto')}"> poll automatically</label>
          </div>
          <div class="row gap wrap d3-bar"><button class="btn" id="${id('integ-now')}">Integrity poll now</button><button class="btn" id="${id('ev-now')}">Event poll now</button><button class="btn" id="${id('tsync')}">Time sync</button><button class="btn ghost" id="${id('unsol-en')}">ENABLE unsolicited</button><button class="btn ghost" id="${id('unsol-dis')}">DISABLE unsolicited</button></div>
          <p class="dim small">On the real radio the master polls no faster than every 15 s (events) and 120 s (integrity): every poll is two transmissions on a channel other people share.</p>
        </div>
        <div class="card"><div class="card-h"><h2>Outstation (RTU)</h2></div>
          <div class="sk-form">
            <label class="chk small"><input type="checkbox" id="${id('unsol')}"> Unsolicited responses allowed (the master can also switch this)</label>
            <label class="chk small"><input type="checkbox" id="${id('evall')}"> Keep every analog + counter change (off = "most recent" mode: one event per point until it's sent)</label>
            <label class="fld inline small"><span>Class 1 event buffer</span><input type="number" id="${id('buf1')}" min="1" max="500"></label>
            <label class="fld inline small"><span>Class 2 event buffer</span><input type="number" id="${id('buf2')}" min="1" max="500"></label>
            <label class="fld inline small"><span>Class 3 event buffer</span><input type="number" id="${id('buf3')}" min="1" max="500"></label>
          </div>
          <p class="dim small" id="${id('bufst')}"></p>
          <p class="dim small">Binary inputs make class 1 events, analogs class 2 (with deadbands), counters class 3. Make a buffer small, cut the link and watch it overflow: the oldest events go, and IIN2.3 tells the master.</p>
          <button class="btn ghost" id="${id('reset')}">Reset the station</button>
        </div>
      </div>
    </div>`;
    }

    // ---------------------------------------------------------------- render (the page's dirty cycle, ~4 Hz)
    function render() {
      if (!st.started || !active()) return;
      const stale = scadaStale(), v = curView();
      renderTop(stale);
      H.paint(v, stale, !!stale && showScada());
      renderAnn();
      renderLink();
      const t = tab();
      if (t === 'op') renderOp(v); else if (t === 'insp') renderInsp(); else if (t === 'seq') q('seq').innerHTML = V.sequence(st.cap.slice(-14).map(c => ({ ...c, text: c.name })), esc);
      else if (t === 'pts') renderPts(stale); else if (t === 'ev') renderEv(); else if (t === 'ch') renderChal(); else if (t === 'cfg') renderCfg();
      else if (H.renderTab) H.renderTab(t, v, stale);
    }
    function renderTop(stale) {
      const seg = (sid, val) => $$(`#${id(sid)} [data-v]`).forEach(b => b.classList.toggle('on', b.dataset.v === val));
      seg('role', cfg.role); seg('link', cfg.link); seg('view', cfg.view);
      q('view').hidden = cfg.role !== 'both';
      $$(`#${id('role')} [data-v="both"]`).forEach(b => { b.disabled = rf(); });
      q('speed').hidden = cfg.time !== 'manual';
      q('phase').textContent = st.chal ? `Challenge running: ${st.chal.def.name} · ${Math.floor(st.chal.t)} s` : cfg.time === 'manual' ? `you drive · time ×${cfg.speed}` :
        `${H.phaseText ? H.phaseText(seq, W.MODES[cfg.time]) : ''} · time ×${W.MODES[cfg.time].accel}${seq.held ? ' · ' + seq.held : ''}`;
      q('mute').textContent = cfg.muted ? '🔇 Sound off' : '🔊 Sound on';
      const ls = q('linkst');
      if (!rf()) { ls.className = 'sk-linkst ok'; ls.textContent = `Simulated P25 link inside this page -- nothing goes on air. ${cfg.role === 'master' ? 'This Kelly is the control room; the station is "far away" and you only see what DNP3 tells you.' : cfg.role === 'outstation' ? 'This Kelly is the RTU at the station; a stand-in control room polls it over the link. Your buttons are the local panel.' : 'Master and outstation both here, talking over the link.'}`; return; }
      const parked = k.rf && k.rf.parked(), ago = t => (t ? `${((Date.now() - t) / 1000).toFixed(0)} s ago` : 'never');
      ls.className = 'sk-linkst ' + (parked ? 'ok' : 'bad');
      ls.innerHTML = `${parked ? '📻 Radio parked in Transparent -- DNP3 goes over P25 data.' : `⚠ ${k.rf && k.rf.demo() ? 'The demo radio has no RF.' : 'Radio not parked in Transparent.'} Connect a TM9100 and set Admin › Home mode to Transparent.`}
        This Kelly is the <b>${cfg.role === 'master' ? 'MASTER' : 'OUTSTATION'}</b> at DNP3 address <b>${cfg.role === 'master' ? cfg.msAddr : cfg.osAddr}</b>. Last sent ${ago(st.rfTx)} · last received ${ago(st.rfRx)}.
        ${spec.rfNote ? '<br><span class="dim small">' + spec.rfNote(cfg.role) + '</span>' : ''}`;
    }
    function renderAnn() {
      const list = Object.values(st.alarms).sort((a, b) => (a.acked - b.acked) || (b.at - a.at));
      const h = list.length ? list.map(a => `<div class="sk-alm ${a.level}${a.acked ? ' ack' : ' unack'}${a.first ? ' first' : ''}" data-id="${a.id}">${a.first ? '<em>FIRST UP</em>' : ''}${esc(a.text)}${a.acked ? '' : '<i>UNACK</i>'}</div>`).join('') + (list.some(a => !a.acked) ? '<button class="btn small" data-ack>Acknowledge</button>' : '')
        : '<div class="sk-alm none">No alarms</div>';
      setHtml(q('ann'), h);
    }
    function renderLink() {
      const sim = !rf();
      q('simlink').hidden = !sim; q('cut').hidden = !sim;
      if (sim) {
        q('cut').textContent = link.down ? '🔗 Restore the link' : '✂️ Cut the link'; q('cut').classList.toggle('down', link.down);
        q('lat-v').textContent = cfg.lat + ' ms'; q('loss-v').textContent = (st.chal && st.lossOverride != null ? st.lossOverride : cfg.loss) + ' %' + (st.chal && st.lossOverride != null ? ' (challenge)' : ''); q('rssi-v').textContent = cfg.rssi + ' dBm' + (cfg.rssi < -105 ? ' ⚠ fading' : '');
      }
      const s = link ? link.stats() : null, m = ms.stats, lp = linkPt;
      const cell = (k2, v2, cls = '') => `<div class="${cls}"><span>${k2}</span><b>${v2}</b></div>`;
      const h = (s ? cell('Packets/s', s.pps.toFixed(2)) + cell('Bytes/s', s.bps.toFixed(0)) + cell('Channel busy', s.busy.toFixed(0) + ' %', s.busy > 70 ? 'warn' : '') + cell('Lost', `${s.lost} / ${s.tx}`, s.lost ? 'warn' : '') : cell('Sent', st.cap.filter(c => !c.lost).length))
        + cell('Round trip', m.lastRtt ? (m.lastRtt / 1000).toFixed(2) + ' s' : '--') + cell('Retries', m.retries || 0, m.retries ? 'warn' : '') + cell('Timeouts', m.timeouts, m.timeouts ? 'bad' : '')
        + (lp ? cell(`RTU link (${lp.code})`, plantHere() ? (plant.p25.healthy ? 'HEALTHY' : 'LOST') : (ms.db.bi[W.idx.bi.link] ? 'HEALTHY' : ms.db.at ? 'LOST' : '--'), plantHere() && !plant.p25.healthy ? 'bad' : 'good') : '')
        + cell('RTU event buffer', `${os.events.length}${os.iin & (1 << D.IIN.EVENT_OVERFLOW) ? ' · OVERFLOW' : ''}`, os.events.length > 20 ? 'warn' : '');
      setHtml(q('stats'), h);
      q('cutnote').textContent = link && link.down ? `The link is cut. The master's polls time out, its screen goes stale, and after 20 s without a poll the RTU itself flags ${lp ? lp.code : 'its link'} false. Everything that happens now waits in the RTU's event buffers -- restore the link and watch them flush.` : '';
    }
    function renderOp(v) {
      if (H.renderOp) H.renderOp(v);
      const on = q('opnote');
      if (on) on.textContent = !useMaster() ? 'You are at the RTU: these buttons work the plant directly (local panel), no DNP3.' : !masterHere() ? '' : cfg.ctl === 'sbo' ? 'Select-before-operate: every button sends SELECT, then OPERATE -- watch both below and in the inspector.' : 'Direct operate: one DNP3 request per button.';
      // the control tracker
      const t = st.track, steps = t && t.sbo ? [['select', '① SELECT sent'], ['operate', '② selected OK → OPERATE'], ['done', '③ done']] : [['direct', '① DIRECT OPERATE sent'], ['done', '② done']];
      const order = steps.map(s => s[0]), cur = t ? order.indexOf(t.stage) : -1;
      const h = t ? `<div class="sk-trk"><b>${esc(t.name)}</b>${t.by === 'demo' ? ' <span class="tag">demo</span>' : ''}<div class="sk-steps">${steps.map(([key, label], i) => `<span class="${t.stage === 'refused' || t.stage === 'timeout' ? (i === Math.max(0, cur) ? 'bad' : i < cur ? 'ok' : '') : i < cur || t.stage === 'done' ? 'ok' : i === cur ? 'now' : ''}">${label}</span>`).join('')}</div>
        ${t.stage === 'refused' ? `<p class="sk-why">⛔ ${esc(D.CROB_STATUS[t.status] || 'refused')}${t.why && t.why !== D.CROB_STATUS[t.status] ? ': ' + esc(t.why) : ''}</p>` : t.stage === 'timeout' ? '<p class="sk-why">⌛ No answer from the RTU -- the control may or may not have happened. That is why real masters re-read the status afterwards.</p>' : ''}</div>`
        : '<p class="dim small">Press a button below: the steps of the DNP3 control show up here.</p>';
      setHtml(q('track'), h);
      const ex = st.exp.slice(0, 10).map(e => `<li class="${e.c && e.c.lost ? 'lost' : ''}"><span class="sk-t">${new Date(e.at).toLocaleTimeString([], { hour12: false })}</span><span class="d3-who ${e.who}">${e.who === 'M' ? 'MASTER' : 'OUTSTATION'}</span> ${esc(e.text)}${e.c && e.c.lost ? ` <b class="bad">✖ ${esc(e.c.why || 'lost')}</b>` : ''}</li>`).join('') || '<li class="dim">Nothing yet -- the master polls every few seconds.</li>';
      setHtml(q('explain'), ex);
    }
    function renderInsp() {
      const rows = st.cap.slice(-150).reverse().map(c => {
        const row = `<tr data-n="${c.n}" class="${c.lost ? 'lost' : ''} ${c.n === st.open ? 'sel' : ''}"><td>${c.n}</td><td>${hhmmss(c.at)}</td><td><span class="d3-who ${c.who}">${c.who === 'M' ? 'MASTER → RTU' : 'RTU → MASTER'}</span></td><td>${esc(c.name)}</td><td class="v ${c.size > L.SPLIT_AT ? 'warn' : ''}">${c.size}</td><td class="v">${c.air ? (c.air / 1000).toFixed(2) + ' s' : ''}</td><td>${c.lost ? `✖ ${esc(c.why || 'LOST')} · ` : ''}${esc(sum(c))}</td></tr>`;
        return c.n === st.open ? row + `<tr class="sk-open"><td colspan="7"><p class="sk-why">💬 ${esc(V.explain(c.hex, c.who, P))}</p>${V.decodeHtml(c.hex, c.who === 'M' ? 'from the master' : 'from the outstation', esc)}</td></tr>` : row;
      }).join('');
      const tb = q('pkts'); if (tb.dataset.h !== rows) { tb.innerHTML = rows || '<tr><td colspan="7" class="dim">No frames yet.</td></tr>'; tb.dataset.h = rows; }
    }
    const sumCache = new Map();
    function sum(c) { if (!sumCache.has(c.n)) { let s; try { s = D.inspect(c.hex).summary; } catch { s = '?'; } sumCache.set(c.n, s); if (sumCache.size > 500) sumCache.delete(sumCache.keys().next().value); } return sumCache.get(c.n); }
    const fmtAi = (p, r) => `${(r / p.scale).toFixed(p.scale >= 100 ? 2 : p.scale >= 10 ? 1 : 0)} ${p.unit}`;
    function renderPts(stale) {
      const local = !showScada() && plantHere(), db = ms.db;
      q('ptsrc').textContent = local ? 'live values in this RTU' : `the master's copy${stale ? ' -- ' + stale : ''}`;
      const qual = local ? 'ONLINE' : !db.at ? 'NO DATA' : stale ? 'COMM LOST' : 'ONLINE';
      const rows = [];
      const add = (kind, p, i, raw, eng, cls) => {
        const key = kind + i; if (raw != null && st.prev[key] !== raw) { if (st.prev[key] !== undefined) st.chg[key] = Date.now(); st.prev[key] = raw; }
        rows.push(`<tr><td>${p.code}</td><td>${esc(p.name)}</td><td class="v">${raw == null ? '--' : eng}</td><td class="v dim">${raw == null ? '' : raw}</td><td>${cls}</td><td><span class="sk-q ${qual.replace(' ', '')}">${qual}</span></td><td class="dim">${st.chg[key] ? new Date(st.chg[key]).toLocaleTimeString([], { hour12: false }) : ''}</td></tr>`);
      };
      P.bi.forEach((p, i) => { const r = local ? p.get(plant) : db.bi[i]; add('bi', p, i, r, r ? 'ON' : 'OFF', 'event 1'); });
      P.ai.forEach((p, i) => { const r = local ? Math.round(p.get(plant) * p.scale) : db.ai[i]; add('ai', p, i, r, r == null ? '' : fmtAi(p, r), `event 2 · db ${p.db}`); });
      P.ctr.forEach((p, i) => { const r = local ? p.get(plant) : db.ctr[i]; add('ctr', p, i, r, r, 'event 3'); });
      (P.ao || []).forEach((p, i) => { const r = local ? Math.round(p.get(plant) * (p.scale || 1)) : db.ao[i]; add('ao', p, i, r, r == null ? '' : `${(r / (p.scale || 1)).toFixed(p.scale >= 10 ? 1 : 0)} ${p.unit}`, 'g40 status'); });
      P.bo.forEach(p => rows.push(`<tr class="dim"><td>${p.code}</td><td>${esc(p.name)}</td><td colspan="3">control · ${esc(p.how)}</td><td></td><td></td></tr>`));
      setHtml(q('pts'), rows.join(''));
    }
    function renderEv() {
      const al = Object.values(st.alarms);
      const ah = al.length ? al.map(a => `<div class="sk-alm ${a.level}${a.acked ? ' ack' : ' unack'}${a.first ? ' first' : ''}">${a.first ? '<em>FIRST UP</em>' : ''}${esc(a.text)} <span class="dim small">${new Date(a.at).toLocaleTimeString([], { hour12: false })}</span>${a.acked ? ' <span class="dim small">acknowledged</span>' : '<i>UNACK</i>'}</div>`).join('') : '<p class="dim">No alarms.</p>';
      setHtml(q('alarms'), ah);
      const nm = (g, i) => { const p = (g === 2 ? P.bi : g === 32 ? P.ai : P.ctr)[i]; return p ? `${p.code} ${p.name}` : `g${g} ${i}`; };
      const vv = (g, i, val) => { if (g === 2) return val ? 'ON' : 'OFF'; const p = g === 32 ? P.ai[i] : null; return p ? fmtAi(p, val) : val; };
      const mh = ms.db.events.slice(-40).reverse().map(e => `<tr><td class="v">${e.time ? hhmmss(e.time) : '--'}</td><td>${esc(nm(e.g, e.index))}</td><td class="v">${vv(e.g, e.index, e.value)}</td><td><span class="d3-tag">class ${e.g === 2 ? 1 : e.g === 32 ? 2 : 3}</span></td></tr>`).join('') || '<tr><td colspan="4" class="dim">None yet.</td></tr>';
      setHtml(q('mev'), mh);
      const sh = st.soe.map(e => `<tr class="${e.cls}"><td class="v">${new Date(e.at).toLocaleTimeString([], { hour12: false })}</td><td>${esc(e.text)}</td></tr>`).join('') || '<tr><td class="dim">Quiet so far.</td></tr>';
      setHtml(q('soe'), sh);
    }
    function renderChal() {
      const h = Object.entries(W.CHALLENGES).map(([key, c]) => {
        const best = cfg.results[key], running = st.chal && st.chal.key === key, res = st.result && st.result.key === key ? st.result : null;
        return `<div class="sk-ch${running ? ' run' : ''}"><h3>${c.icon} ${esc(c.name)}</h3><p>${esc(c.brief)}</p>
          ${running ? `<p class="sk-run">⏱ ${Math.floor(st.chal.t)} / ${c.secs} s</p><button class="btn ghost small" data-chstop>Give up</button>`
            : `<button class="btn primary small" data-ch="${key}" ${st.chal || rf() ? 'disabled' : ''}>Start</button>`}
          ${res ? `<p class="sk-res ${res.pass ? 'good' : 'bad'}">${res.pass ? '★'.repeat(res.stars) + '☆'.repeat(3 - res.stars) : '✖'} ${esc(res.text)}</p>` : ''}
          ${best ? `<p class="dim small">Best: ${'★'.repeat(best.stars)} · ${esc(c.fmt ? c.fmt(best.score) : String(best.score))}</p>` : ''}</div>`;
      }).join('');
      setHtml(q('chal'), h);
    }
    function renderCfg() {
      const c = os.events.reduce((a, e) => { a[e.cls] = (a[e.cls] || 0) + 1; return a; }, {});
      q('bufst').textContent = `Waiting in the RTU now: class 1 ${c[1] || 0} / ${cfg.bufs[0]}, class 2 ${c[2] || 0} / ${cfg.bufs[1]}, class 3 ${c[3] || 0} / ${cfg.bufs[2]}${os.iin & (1 << D.IIN.EVENT_OVERFLOW) ? ' -- OVERFLOWED' : ''} · unsolicited ${os.unsol ? 'ON' : 'off'}`;
      q('unsol').checked = os.unsol;
    }

    // ---------------------------------------------------------------- motion: the plant's frame, only while on the page
    let lastFrame = 0;
    function frame(now) {
      if (!onPage() || !H.frame) { lastFrame = 0; return 400; }
      const dt = lastFrame ? Math.min(0.2, (now - lastFrame) / 1000) : 0; lastFrame = now;
      return H.frame(now, dt);
    }

    // ---------------------------------------------------------------- wiring
    function init() {
      const root = $(`#${id('root')}`); if (!root) return;
      root.innerHTML = shell();
      // tabs (app.js binds .tabs at start-up, before this markup exists)
      $(`[data-tabs="${X}"]`).addEventListener('click', e => {
        const b = e.target.closest('button[data-tab]'); if (!b) return;
        $$(`[data-tabs="${X}"] button`).forEach(x => x.classList.toggle('on', x === b));
        $$(`[data-tabpane^="${X}:"]`).forEach(pn => pn.classList.toggle('on', pn.dataset.tabpane === `${X}:${b.dataset.tab}`));
        dirty('dnp3');
      });
      const seg = (sid, key, after) => q(sid).addEventListener('click', async e => {
        const b = e.target.closest('[data-v]'); if (!b || b.disabled || cfg[key] === b.dataset.v) return;
        if (after && (await after(b.dataset.v)) === false) return;
        cfg[key] = b.dataset.v; save(); dirty('dnp3');
      });
      seg('role', 'role', async v => {
        if (rf() && v === 'master' && k.confirmBox && !(await k.confirmBox('Make this Kelly the DNP3 master on air?', 'Your radio will start transmitting by itself, polling outstation ' + cfg.osAddr + ' every ' + effPoll().ev + ' s (integrity every ' + effPoll().integ + ' s), for as long as Kelly is open on this page and the radio is parked. Untick "poll automatically" in Settings, or switch role, to stop it.'))) return false;
        setTimeout(() => { build(); dirty('dnp3'); });
      });
      seg('link', 'link', async v => {
        if (v === 'rf' && cfg.role === 'both') cfg.role = 'outstation';
        if (v === 'rf' && st.chal) chalEnd();
        if (v === 'rf' && cfg.role === 'master' && k.confirmBox && !(await k.confirmBox('Put the DNP3 master on air?', 'Your radio will start transmitting by itself, polling outstation ' + cfg.osAddr + '.'))) return false;
        setTimeout(() => { build(); claimRf(); dirty('dnp3'); });
      });
      seg('view', 'view');
      q('time').value = cfg.time; q('time').onchange = e => { cfg.time = e.target.value; seq = new W.Sequencer(cfg.time); save(); dirty('dnp3'); };
      q('speed').value = String(cfg.speed); q('speed').onchange = e => { cfg.speed = +e.target.value; save(); };
      q('mute').onclick = () => { cfg.muted = !cfg.muted; save(); if (!cfg.muted) { try { k.audioCtx(); } catch {} play('chirp', false); } else if (fx) { if (H.sound) H.sound(curView(), false); fx.hornStop(); } dirty('dnp3'); };
      q('vol').value = cfg.vol; q('vol').oninput = e => { cfg.vol = +e.target.value; save(); };
      q('psnd').checked = cfg.psnd; q('psnd').onchange = e => { cfg.psnd = e.target.checked; save(); };
      // link card
      const slider = (sid, key, apply) => { const n = q(sid); n.value = cfg[key]; n.oninput = () => { cfg[key] = +n.value; if (link) apply(+n.value); save(); dirty('dnp3'); }; };
      slider('lat', 'lat', x => { link.cfg.lat = x; }); slider('loss', 'loss', x => { if (!(st.chal && st.lossOverride != null)) link.cfg.loss = x; }); slider('rssi', 'rssi', x => { link.cfg.rssi = x; });
      q('p25').checked = cfg.p25; q('p25').onchange = e => { cfg.p25 = e.target.checked; if (link) link.cfg.p25 = cfg.p25; save(); };
      q('cut').onclick = () => { if (!link) return; link.cut(!link.down); soe(link.down ? 'P25 link CUT (training)' : 'P25 link restored', link.down ? 'bad' : 'sc'); play(link.down ? 'trip' : 'clunk', 0.6); dirty('dnp3'); };
      // annunciator
      q('ann').addEventListener('click', e => { if (e.target.closest('[data-ack]')) ackAll(); });
      // operator: [data-cmd] = a control (over DNP3 when there's a master), [data-sp] = send AO <index> from #<prefix>-ao<index>
      root.querySelector(`[data-tabpane="${X}:op"]`).addEventListener('click', e => {
        const b = e.target.closest('[data-cmd],[data-sp]'); if (!b || b.disabled) return;
        if (b.dataset.cmd) { if (b.dataset.cmd === 'estop' || (/\.(open|off)$/.test(b.dataset.cmd) && cfg.role !== 'outstation')) play('blocked'); issue(b.dataset.cmd); }
        else { const ao = +b.dataset.sp; setpoint(ao, +q('ao' + ao).value); }
      });
      // inspector
      q('pkts').addEventListener('click', e => { const r = e.target.closest('tr[data-n]'); if (r) { st.open = st.open === +r.dataset.n ? null : +r.dataset.n; dirty('dnp3'); } });
      q('pkts').addEventListener('mouseover', e => { const f = e.target.closest('[data-f]'); $$(`#${id('pkts')} .hot`).forEach(n => n.classList.remove('hot')); if (f && f.dataset.f !== '-1') $$(`#${id('pkts')} .sk-open [data-f="${f.dataset.f}"]`).forEach(n => n.classList.add('hot')); });
      q('clear').onclick = () => { st.cap = []; st.open = null; dirty('dnp3'); };
      q('hold').onchange = e => { st.hold = e.target.checked; };
      q('ack').onclick = ackAll;
      // challenges
      q('chal').addEventListener('click', e => {
        const b = e.target.closest('[data-ch]'); if (b) chalStart(b.dataset.ch);
        if (e.target.closest('[data-chstop]') && st.chal) { st.chal.def.tick(plant, st.chal.ctx, st.chal.def.secs + 1); chalEnd(); soe('Challenge abandoned', 'warn'); dirty('dnp3'); }
      });
      // settings
      const num = (sid, key, lo, hi, rebuild) => { const n = q(sid); n.value = cfg[key]; n.onchange = () => { const v = Math.max(lo, Math.min(hi, Math.round(+n.value) || lo)); n.value = v; cfg[key] = v; save(); if (rebuild) build(); else { ms.timeout = cfg.timeout * 1000; ms.retries = cfg.retries; } dirty('dnp3'); }; };
      num('msaddr', 'msAddr', 0, 65519, true); num('osaddr', 'osAddr', 0, 65519, true); num('integ', 'integ', 10, 3600); num('evpoll', 'evPoll', 1, 600); num('timeout', 'timeout', 1, 60); num('retries', 'retries', 0, 5);
      q('ctlmode').value = cfg.ctl; q('ctlmode').onchange = e => { cfg.ctl = e.target.value; save(); };
      q('auto').checked = cfg.auto; q('auto').onchange = e => { cfg.auto = e.target.checked; save(); };
      q('integ-now').onclick = () => masterHere() && ms.integrity();
      q('ev-now').onclick = () => masterHere() && ms.poll([1, 2, 3]);
      q('tsync').onclick = () => masterHere() && ms.timeSync('nonlan');
      q('unsol-en').onclick = () => masterHere() && ms.unsolicited(true);
      q('unsol-dis').onclick = () => masterHere() && ms.unsolicited(false);
      q('evall').checked = !!cfg.evAll; q('evall').onchange = e => { cfg.evAll = e.target.checked; os.cfg.mostRecent = cfg.evAll ? null : ['ai', 'ctr']; save(); };
      q('unsol').onchange = e => { os.unsol = e.target.checked; cfg.unsol = os.unsol; save(); };
      [1, 2, 3].forEach(c => { const n = q('buf' + c); n.value = cfg.bufs[c - 1]; n.onchange = () => { const v = Math.max(1, Math.min(500, Math.round(+n.value) || 1)); n.value = v; cfg.bufs[c - 1] = v; os.cfg.classMax[c] = v; os.cfg.maxEvents = cfg.bufs.reduce((a, b) => a + b, 0); save(); }; });
      q('reset').onclick = () => {
        const msg = H.reset ? H.reset() : null;
        build(); st.soe = []; st.alarms = {}; st.cap = []; st.exp = []; seq = new W.Sequencer(cfg.time);
        if (msg) toast(...msg); dirty('dnp3');
      };
      if (H.bind) H.bind(root);
      build();
    }
    function claimRf() { if (k.rf) k.rf.onRx(b => rawRx && rawRx(b)); }
    function shown() {
      if (!st.started) {
        st.started = true;
        if (window.KellyDnp3Fx) fx = window.KellyDnp3Fx.audio(() => k.audioCtx(), () => (cfg.muted ? 0 : cfg.vol * (settings.soundVol == null ? 0.8 : +settings.soundVol)));
        setInterval(tick, 250);
        if (k.fxLoop) k.fxLoop(frame);
        setTimeout(() => masterHere() && ms.integrity(), 400);
      }
      if (!active() && fx && H.sound) H.sound(curView(), false);
      claimRf();
      dirty('dnp3');
    }
    // the page left this plant (another plant picked): silence it
    function hidden() { if (fx && H.sound) H.sound(curView(), false); if (fx) fx.hornStop(); }
    return { init, render, shown, hidden, active, claimRf, api, debug: () => ({ plant, os, ms, link, seq, st, cfg }) };
  };
})();
