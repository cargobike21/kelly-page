/* Kelly Page -- Wivenhoe pumped-storage SCADA trainer: plant model, DNP3 point map, demo sequencer, challenges.
 * Pure (no DOM; UMD: window.Wivenhoe). The UI is js/wivenhoeui.js; tests are tests/wivenhoe-tests.html.
 *
 * A TRAINING SIMULATION inspired by Wivenhoe Power Station (QLD) -- not affiliated with its operator; every figure is
 * approximate. Upper reservoir Splityard Creek Dam, lower reservoir Lake Wivenhoe, two reversible pump-turbines.
 *   Units      generate 60-285 MW each (setpoint AO), pump at a fixed ~250 MW each (single-speed pumps). Start and
 *              stop take a few real seconds whatever the time speed, so an operator can watch them spin up.
 *   Water      flow = P / (rho g H eta) generating, P eta / (rho g H) pumping; head ~95-105 m with the upper level.
 *              Splityard Creek ~23 GL active storage (about 10 h at full output); Lake Wivenhoe ~1,165 GL, so the
 *              lower level barely moves -- the mimic draws it exaggerated and says so.
 *   Breakers   one generator breaker (unit bus) and one 275 kV grid breaker; station auxiliaries hang off the grid
 *              side, so with the grid breaker open the station battery runs down.
 *   Interlocks (check() explains, in words, why a command is refused -- the UI shows that text)
 *              no pumping with the upper HIGH alarm on; no generating with the upper LOW alarm on; units need both
 *              breakers closed (opening either trips running units); E-STOP trips both units, opens the generator
 *              breaker and latches until reset; a unit goes pumping -> idle -> generating, never straight across.
 *   Time       tick(dtReal) moves water at dtReal x accel; real time, the 10 / 30 minute demos and manual set accel.
 *
 * POINTS is the one point list for the outstation, the master and the UI (DNP3 indexes from 0: BI0001 = BI 0).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scadacore.js'));
  else root.Wivenhoe = factory(root.ScadaCore);
})(typeof self !== 'undefined' ? self : this, function (SC) {
  'use strict';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const toward = (x, target, step) => (x < target ? Math.min(target, x + step) : Math.max(target, x - step));

  // ------------------------------------------------------------------ plant constants (approximate)
  const C = {
    UNIT_MAX: 285, UNIT_MIN: 60, PUMP_MW: 250, ETA: 0.9, RHO_G: 9810,
    UP_ACTIVE: 23e6, LOW_FSV: 1165e6,               // m3: Splityard Creek active storage, Lake Wivenhoe full supply
    HI_ON: 95, HI_OFF: 93, LO_ON: 10, LO_OFF: 12,   // upper reservoir alarms (%), with hysteresis
    HI_STOP: 97, LO_STOP: 8,                         // protection stops the units here
    START_S: 6, STOP_S: 5, GEN_RAMP: 40, PUMP_RAMP: 60, TRIP_LOCK_S: 10,
    BATT_FLOAT: 128.0, BATT_MIN: 105, KV: 275,
  };
  const head = upPct => 95 + 0.1 * upPct;
  const UNIT_STATES = { stop: 'Idle', 'pump-start': 'Starting (pump)', pump: 'Pumping', 'gen-start': 'Starting (generate)', gen: 'Generating', stopping: 'Stopping' };

  class Plant {
    constructor(o = {}) { this.listeners = []; this.reset(o); }
    reset(o = {}) {
      this.t = 0; this.accel = o.accel || 1; this.local = false;
      this.upVol = C.UP_ACTIVE * (o.up == null ? 50 : o.up) / 100;
      this.lowVol = C.LOW_FSV * (o.low == null ? 68 : o.low) / 100;
      this.units = [1, 2].map(n => ({ n, state: 'stop', speed: 0, mw: 0, sp: 200, flow: 0, starts: 0, lockUntil: 0 }));
      this.genCB = o.genCB !== false; this.gridCB = o.gridCB !== false; this.estop = false;
      this.batt = C.BATT_FLOAT; this.hz = 50; this.kv = C.KV; this.demand = 0; this.noise = 0;
      this.mwhGen = 0; this.mwhUsed = 0;
      this.hi = false; this.lo = false; this.alarms = {};
      this.p25 = { healthy: true, rssi: -85, pktRate: 0, sent: 0, rcvd: 0 };   // fed by the host from the RTU's comms
      this.levels(); this.emit({ type: 'reset' });
    }
    on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
    emit(e) { for (const f of this.listeners) try { f(e); } catch (err) { console.error(err); } }
    get up() { return 100 * this.upVol / C.UP_ACTIVE; }
    get low() { return 100 * this.lowVol / C.LOW_FSV; }
    get totalMW() { return this.units.reduce((s, u) => s + u.mw, 0); }
    get genMW() { return this.units.reduce((s, u) => s + Math.max(0, u.mw), 0); }
    get pumpMW() { return this.units.reduce((s, u) => s + Math.max(0, -u.mw), 0); }
    get flow() { return this.units.reduce((s, u) => s + u.flow, 0); }
    available(u) { return !this.estop && this.t >= u.lockUntil; }
    running(u) { return u.state !== 'stop'; }

    // ---------------------------------------------------------------- alarms
    setAlarm(id, on, text, level = 'warn') {
      const a = this.alarms[id];
      if (on && !a) { this.alarms[id] = { id, text, level, at: Date.now(), acked: false }; this.emit({ type: 'alarm', id, on: true, text, level }); }
      else if (!on && a) { delete this.alarms[id]; this.emit({ type: 'alarm', id, on: false, text: a.text, level: a.level }); }
    }
    ackAlarms() { for (const a of Object.values(this.alarms)) a.acked = true; this.emit({ type: 'ack' }); }
    levels() {
      const up = this.up;
      if (!this.hi && up >= C.HI_ON) this.hi = true; else if (this.hi && up < C.HI_OFF) this.hi = false;
      if (!this.lo && up <= C.LO_ON) this.lo = true; else if (this.lo && up > C.LO_OFF) this.lo = false;
      this.setAlarm('hi', this.hi, 'Upper reservoir HIGH level', 'warn');
      this.setAlarm('lo', this.lo, 'Upper reservoir LOW level', 'warn');
    }

    // ---------------------------------------------------------------- commands (local panel, DNP3 and the demo all come here)
    // ids: u1.pump u1.gen u1.stop u2.* gencb.close gencb.open gridcb.close gridcb.open estop estop.reset
    // check() -> null when allowed, else the interlock in plain words ("Already ..." = nothing to do)
    check(id) {
      const [what, act] = id.split('.');
      if (what === 'estop') return act === 'reset' ? (this.estop ? null : 'Already reset: the emergency stop is not active') : this.estop ? 'Already stopped: the emergency stop is active' : null;
      if (what === 'gencb' || what === 'gridcb') {
        const closed = what === 'gencb' ? this.genCB : this.gridCB, name = what === 'gencb' ? 'generator breaker' : 'grid breaker';
        if (act === 'close' && closed) return `Already closed: the ${name}`;
        if (act === 'open' && !closed) return `Already open: the ${name}`;
        if (act === 'close' && what === 'gencb' && this.estop) return 'Blocked: the emergency stop is active -- reset it before closing the generator breaker';
        return null;
      }
      const u = this.units[what === 'u1' ? 0 : 1], U = `Unit ${u.n}`;
      if (act === 'stop') return u.state === 'stop' || u.state === 'stopping' ? `Already stopped: ${U}` : null;
      const want = act === 'pump' ? 'pump' : 'gen', other = want === 'pump' ? 'gen' : 'pump';
      if (u.state === want || u.state === want + '-start') return `Already ${want === 'pump' ? 'pumping' : 'generating'}: ${U}`;
      if (this.estop) return `${U} can't start: the emergency stop is active`;
      if (!this.available(u)) return `${U} is not available: it tripped and is locked out for ${Math.ceil((u.lockUntil - this.t) / this.accel)} s more`;
      if (u.state === other || u.state === other + '-start') return `${U} can't go straight from ${other === 'pump' ? 'pumping' : 'generating'} to ${want === 'pump' ? 'pumping' : 'generating'} -- stop it and let it come to idle first`;
      if (u.state === 'stopping') return `${U} is still running down -- wait for it to reach idle`;
      if (!this.gridCB) return `${U} can't start: the grid breaker is open (units can't run off-grid)`;
      if (!this.genCB) return `${U} can't start: the generator breaker is open`;
      if (want === 'pump' && this.hi) return `${U} can't pump: the upper reservoir HIGH level alarm is on -- Splityard Creek is full`;
      if (want === 'gen' && this.lo) return `${U} can't generate: the upper reservoir LOW level alarm is on -- not enough water to run`;
      return null;
    }
    command(id, by = 'local') {
      const why = this.check(id);
      if (why) {
        const already = /^Already/.test(why);
        if (!already) this.emit({ type: 'block', id, reason: why, by });
        return { ok: false, reason: why, status: already ? 14 : 15 };
      }
      const [what, act] = id.split('.');
      if (what === 'estop') {
        if (act === 'reset') { this.estop = false; this.setAlarm('estop', false); this.emit({ type: 'estop', on: false, by }); }
        else this.trip('EMERGENCY STOP', true, by);
      } else if (what === 'gencb' || what === 'gridcb') this.breaker(what, act === 'close', by);
      else {
        const u = this.units[what === 'u1' ? 0 : 1];
        if (act === 'stop') u.state = 'stopping';
        else { u.state = act === 'pump' ? 'pump-start' : 'gen-start'; u.starts++; }
        this.emit({ type: 'unit', unit: u.n, state: u.state, by });
      }
      return { ok: true };
    }
    setpoint(n, mw, by = 'local') {
      if (!(mw >= C.UNIT_MIN && mw <= C.UNIT_MAX)) return { ok: false, status: 12, reason: `Setpoint out of range: ${mw} MW (allowed ${C.UNIT_MIN}-${C.UNIT_MAX} MW)` };
      const u = this.units[n - 1]; u.sp = Math.round(mw);
      this.emit({ type: 'setpoint', unit: n, mw: u.sp, by });
      return { ok: true };
    }
    breaker(which, close, by) {
      if (which === 'gencb') this.genCB = close; else this.gridCB = close;
      this.emit({ type: 'breaker', id: which, closed: close, by });
      if (!close) for (const u of this.units) if (this.running(u)) this.tripUnit(u, `${which === 'gencb' ? 'generator' : 'grid'} breaker opened under it`);
    }
    tripUnit(u, cause) {
      u.state = 'stopping'; u.mw = 0; u.flow = 0; u.lockUntil = this.t + C.TRIP_LOCK_S * this.accel;
      this.emit({ type: 'trip', unit: u.n, cause });
      this.setAlarm('trip' + u.n, true, `Unit ${u.n} TRIPPED: ${cause}`, 'bad');
    }
    trip(cause, estop, by) {
      if (estop) { this.estop = true; this.setAlarm('estop', true, 'EMERGENCY STOP active', 'bad'); this.emit({ type: 'estop', on: true, by }); }
      for (const u of this.units) if (this.running(u)) this.tripUnit(u, cause);
      if (this.genCB) this.breaker('gencb', false, by);
    }

    // ---------------------------------------------------------------- the process
    tick(dtReal) {
      const dt = dtReal * this.accel;   // plant seconds
      this.t += dt;
      const H = head(this.up);
      for (const u of this.units) {
        const was = u.state;
        if (u.state === 'pump-start' || u.state === 'gen-start') {
          u.speed = Math.min(1, u.speed + dtReal / C.START_S);
          if (u.speed >= 1) u.state = u.state === 'pump-start' ? 'pump' : 'gen';
        } else if (u.state === 'stopping') {
          u.speed = Math.max(0, u.speed - dtReal / C.STOP_S); u.mw = toward(u.mw, 0, 120 * dtReal);
          if (u.speed <= 0) { u.state = 'stop'; u.mw = 0; }
        } else if (u.state === 'gen') u.mw = toward(u.mw, u.sp, C.GEN_RAMP * dtReal);
        else if (u.state === 'pump') u.mw = toward(u.mw, -C.PUMP_MW, C.PUMP_RAMP * dtReal);
        if (u.state === 'stop') { u.speed = 0; u.mw = 0; }
        u.flow = u.mw > 0 ? u.mw * 1e6 / (C.RHO_G * H * C.ETA) : u.mw < 0 ? u.mw * 1e6 * C.ETA / (C.RHO_G * H) : 0;   // + downhill
        if (u.state !== was) this.emit({ type: 'unit', unit: u.n, state: u.state, by: 'plant' });
        if (this.t >= u.lockUntil && this.alarms['trip' + u.n] && u.state === 'stop') this.setAlarm('trip' + u.n, false);
      }
      const q = this.flow * dt;
      this.upVol = clamp(this.upVol - q, 0, C.UP_ACTIVE); this.lowVol = clamp(this.lowVol + q, 0, C.LOW_FSV);
      this.mwhGen += this.genMW * dt / 3600; this.mwhUsed += this.pumpMW * dt / 3600;
      this.levels();
      // protection: stop pumping into a full reservoir, stop generating from an empty one
      for (const u of this.units) {
        if (u.state === 'pump' && this.up >= C.HI_STOP) this.protStop(u, 'upper reservoir full');
        if (u.state === 'gen' && this.up <= C.LO_STOP) this.protStop(u, 'upper reservoir empty');
      }
      // the grid: frequency sags when demand runs ahead of what's sent out (only the challenges add demand)
      this.noise = clamp(this.noise + (Math.random() - 0.5) * 0.004 * dtReal * 4, -0.03, 0.03);
      const short = Math.max(0, this.demand - this.genMW);
      this.hz = toward(this.hz, 50 + this.noise - short * 0.0005, 0.08 * dtReal);
      this.kv = this.gridCB ? C.KV + (this.genMW - this.pumpMW) * 0.004 + this.noise * 20 : 0;
      this.batt = this.gridCB ? toward(this.batt, C.BATT_FLOAT, 0.5 * dtReal) : Math.max(C.BATT_MIN, this.batt - dt / 3600);
      this.setAlarm('aux', !this.gridCB, 'Station auxiliary supply lost -- running on battery', 'warn');
      this.setAlarm('batt', this.batt < 115, 'Station battery LOW', 'bad');
      this.setAlarm('comms', !this.p25.healthy, 'P25 link to SCADA master lost', 'warn');
    }
    protStop(u, why) { u.state = 'stopping'; this.emit({ type: 'unit', unit: u.n, state: 'stopping', by: 'protection', cause: why }); }

    view() {
      return { up: this.up, low: this.low, genCB: this.genCB, gridCB: this.gridCB, estop: this.estop, hi: this.hi, lo: this.lo, hz: this.hz, kv: this.kv,
        flow: this.flow, batt: this.batt, total: this.totalMW, pump: this.pumpMW, gen: this.genMW, aux: this.gridCB, link: this.p25.healthy, rssi: this.p25.rssi,
        units: this.units.map(u => ({ n: u.n, state: u.state, mw: u.mw, speed: u.speed, sp: u.sp, avail: this.available(u), flow: u.flow })),
        alarms: Object.values(this.alarms), mwhGen: this.mwhGen, mwhUsed: this.mwhUsed };
    }
    dnp3Plant() { return plantAdapter(this); }
  }

  // ------------------------------------------------------------------ the point database (shared by outstation, master, UI)
  // AI: raw on the wire = value x scale (16-bit friendly for the lean P25 class 0); db = event deadband in raw counts,
  // sized for a P25 channel at demo speed (0.5 % of level, 5 MW, 0.05 Hz...) -- tighter and the events swamp the link
  const U = (m, n) => m.units[n - 1];
  const POINTS = {
    bi: [
      { id: 'u1.avail', code: 'BI0001', name: 'Unit 1 Available', get: m => +m.available(U(m, 1)) },
      { id: 'u2.avail', code: 'BI0002', name: 'Unit 2 Available', get: m => +m.available(U(m, 2)) },
      { id: 'u1.pump', code: 'BI0003', name: 'Unit 1 Pump Running', get: m => +(U(m, 1).state === 'pump') },
      { id: 'u2.pump', code: 'BI0004', name: 'Unit 2 Pump Running', get: m => +(U(m, 2).state === 'pump') },
      { id: 'u1.gen', code: 'BI0005', name: 'Unit 1 Generating', get: m => +(U(m, 1).state === 'gen') },
      { id: 'u2.gen', code: 'BI0006', name: 'Unit 2 Generating', get: m => +(U(m, 2).state === 'gen') },
      { id: 'gencb', code: 'BI0007', name: 'Generator Breaker Closed', get: m => +m.genCB },
      { id: 'gridcb', code: 'BI0008', name: 'Grid Connected', get: m => +m.gridCB },
      { id: 'hi', code: 'BI0009', name: 'Upper Reservoir High Alarm', get: m => +m.hi },
      { id: 'lo', code: 'BI0010', name: 'Upper Reservoir Low Alarm', get: m => +m.lo },
      { id: 'estop', code: 'BI0011', name: 'Emergency Stop Active', get: m => +m.estop },
      { id: 'link', code: 'BI0012', name: 'P25 Link Healthy', get: m => +m.p25.healthy },
    ],
    ai: [
      { id: 'up', code: 'AI1001', name: 'Upper Reservoir Level', unit: '%', scale: 100, db: 50, get: m => m.up },
      { id: 'low', code: 'AI1002', name: 'Lower Reservoir Level', unit: '%', scale: 100, db: 10, get: m => m.low },
      { id: 'u1.mw', code: 'AI1003', name: 'Unit 1 MW', unit: 'MW', scale: 10, db: 50, get: m => U(m, 1).mw },
      { id: 'u2.mw', code: 'AI1004', name: 'Unit 2 MW', unit: 'MW', scale: 10, db: 50, get: m => U(m, 2).mw },
      { id: 'total', code: 'AI1005', name: 'Total Station MW', unit: 'MW', scale: 10, db: 50, get: m => m.totalMW },
      { id: 'pump', code: 'AI1006', name: 'Pump Power MW', unit: 'MW', scale: 10, db: 50, get: m => m.pumpMW },
      { id: 'hz', code: 'AI1007', name: 'Grid Frequency', unit: 'Hz', scale: 100, db: 5, get: m => m.hz },
      { id: 'kv', code: 'AI1008', name: 'Bus Voltage', unit: 'kV', scale: 10, db: 20, get: m => m.kv },
      { id: 'flow', code: 'AI1009', name: 'Water Flow', unit: 'm³/s', scale: 10, db: 100, get: m => m.flow },
      { id: 'batt', code: 'AI1010', name: 'Station Battery Voltage', unit: 'V', scale: 10, db: 5, get: m => m.batt },
      { id: 'rssi', code: 'AI1011', name: 'P25 RSSI', unit: 'dBm', scale: 1, db: 3, get: m => m.p25.rssi },
      { id: 'pkt', code: 'AI1012', name: 'P25 Packet Rate', unit: 'pkt/min', scale: 10, db: 50, get: m => m.p25.pktRate },
    ],
    // counters: db = how far a counter moves before it makes a class 3 event (else every MWh would be an event)
    ctr: [
      { id: 'mwhGen', code: 'C4001', name: 'MWh Generated', db: 25, get: m => Math.floor(m.mwhGen) },
      { id: 'mwhUsed', code: 'C4002', name: 'MWh Consumed (pumping)', db: 25, get: m => Math.floor(m.mwhUsed) },
      { id: 'u1.starts', code: 'C4003', name: 'Unit 1 Start Count', db: 0, get: m => U(m, 1).starts },
      { id: 'u2.starts', code: 'C4004', name: 'Unit 2 Start Count', db: 0, get: m => U(m, 2).starts },
      { id: 'sent', code: 'C4005', name: 'DNP3 Messages Sent', db: 20, get: m => m.p25.sent },
      { id: 'rcvd', code: 'C4006', name: 'DNP3 Messages Received', db: 20, get: m => m.p25.rcvd },
    ],
    bo: [
      { id: 'u1.pump', code: 'BO2001', name: 'Unit 1 Start Pumping', how: 'PULSE ON (or CLOSE)' },
      { id: 'u1.gen', code: 'BO2002', name: 'Unit 1 Start Generating', how: 'PULSE ON (or CLOSE)' },
      { id: 'u1.stop', code: 'BO2003', name: 'Unit 1 Stop', how: 'PULSE ON (or CLOSE)' },
      { id: 'u2.pump', code: 'BO2004', name: 'Unit 2 Start Pumping', how: 'PULSE ON (or CLOSE)' },
      { id: 'u2.gen', code: 'BO2005', name: 'Unit 2 Start Generating', how: 'PULSE ON (or CLOSE)' },
      { id: 'u2.stop', code: 'BO2006', name: 'Unit 2 Stop', how: 'PULSE ON (or CLOSE)' },
      { id: 'gencb', code: 'BO2007', name: 'Generator Breaker Close/Trip', how: 'CLOSE 0x41 closes, TRIP 0x81 opens', breaker: true },
      { id: 'gridcb', code: 'BO2008', name: 'Grid Breaker Close/Trip', how: 'CLOSE 0x41 closes, TRIP 0x81 opens', breaker: true },
      { id: 'estop', code: 'BO2009', name: 'Emergency Stop', how: 'PULSE ON (or CLOSE)' },
      { id: 'estop.reset', code: 'BO2010', name: 'Emergency Stop Reset', how: 'PULSE ON (or CLOSE)' },
    ],
    ao: [
      { id: 'u1.sp', code: 'AO3001', name: 'Unit 1 MW Setpoint', unit: 'MW', scale: 1, get: m => U(m, 1).sp, unitNo: 1 },
      { id: 'u2.sp', code: 'AO3002', name: 'Unit 2 MW Setpoint', unit: 'MW', scale: 1, get: m => U(m, 2).sp, unitNo: 2 },
    ],
  };
  const idx = SC.indexPoints(POINTS), crobCommand = SC.crobCommand, rtuComms = SC.rtuComms;

  function plantAdapter(m) {
    return {
      model: m, points: POINTS,
      local: () => m.local,
      trouble: () => m.estop,
      boValue: p => (p.breaker ? +(p.id === 'gencb' ? m.genCB : m.gridCB) : 0),
      onChange: fn => m.on(e => { if (e.type !== 'setpoint' && e.type !== 'reset' && e.type !== 'ack') fn(); }),
      validate(p, code, selecting) {
        const cmd = crobCommand(p, code); if (!cmd) return 3;   // FORMAT ERROR
        if (selecting) { const why = m.check(cmd); if (why && !/^Already/.test(why)) { m.emit({ type: 'block', id: cmd, reason: why, by: 'scada' }); return 15; } }
        return 0;
      },
      execute(p, code) { const r = m.command(crobCommand(p, code), 'scada'); return r.ok ? 0 : r.status; },
      aoValidate(p, raw) { return raw >= C.UNIT_MIN && raw <= C.UNIT_MAX ? 0 : 12; },   // OUT OF RANGE
      aoExecute(p, raw) { const r = m.setpoint(p.unitNo, raw, 'scada'); return r.ok ? 0 : r.status; },
    };
  }

  // BI0012 "P25 Link Healthy" is ScadaCore.rtuComms (a master asked something in the last timeoutMs).

  // A view (same shape as Plant.view()) from a master's mirrored points: the SCADA screen, drawn from DNP3 alone
  function viewFromPoints(db) {
    const bi = id => db.bi[idx.bi[id]], ai = id => { const r = db.ai[idx.ai[id]]; return r == null ? null : r / POINTS.ai[idx.ai[id]].scale; };
    const n0 = x => (x == null ? 0 : x);
    const units = [1, 2].map(n => {
      const mw = n0(ai(`u${n}.mw`)), st = bi(`u${n}.pump`) ? 'pump' : bi(`u${n}.gen`) ? 'gen' : 'stop';
      return { n, state: st, mw, speed: st === 'stop' ? 0 : 1, sp: db.ao ? db.ao[n - 1] : null, avail: !!bi(`u${n}.avail`), flow: 0 };
    });
    const flow = n0(ai('flow')), tot = Math.abs(units[0].mw) + Math.abs(units[1].mw) || 1;
    units.forEach(u => { u.flow = flow * Math.abs(u.mw) / tot; });
    return { remote: true, known: db.at > 0, up: n0(ai('up')), low: n0(ai('low')), genCB: !!bi('gencb'), gridCB: !!bi('gridcb'), estop: !!bi('estop'), hi: !!bi('hi'), lo: !!bi('lo'),
      hz: n0(ai('hz')), kv: n0(ai('kv')), flow, batt: n0(ai('batt')), total: n0(ai('total')), pump: n0(ai('pump')), gen: Math.max(0, n0(ai('total'))), aux: !!bi('gridcb'),
      link: bi('link') !== 0, rssi: n0(ai('rssi')), units, alarms: [] };
  }

  // ------------------------------------------------------------------ time modes + the demo sequencer
  // accel is plant seconds per real second. Demo phases are in real seconds.
  const MODES = {
    real: { name: 'Real time', accel: 1, schedule: 'day' },
    demo10: { name: '10 minute demo', accel: 120, phases: [['pump', 240], ['gen', 240], ['idle', 120]] },
    demo30: { name: '30 minute demo', accel: 50, phases: [['pump', 600], ['gen', 600], ['idle', 600]] },
    manual: { name: 'Manual', accel: 60 },
  };
  // the real station's day, roughly: pump overnight on cheap power, generate into the evening peak
  const dayPhase = d => { const h = d.getHours(); return h >= 22 || h < 6 ? 'pump' : h >= 17 && h < 21 ? 'gen' : 'idle'; };

  // Sequencer: works out the next command to bring the plant to the phase's state and hands it to issue(id) --
  // the host sends it over DNP3 when there's a master, so the demo's controls show up in the packet inspector.
  // A command it has sent isn't sent again for `cooldown` real seconds: over SCADA a unit shows nothing until it's up to
  // speed and the next poll has been answered, so asking again sooner just piles controls on the link.
  class Sequencer {
    constructor(mode, o = {}) { this.mode = mode; this.t = 0; this.pendingUntil = 0; this.held = ''; this.sent = {}; this.cooldown = o.cooldown || 25; this.gap = o.gap || 4; }
    phase(now = new Date()) {
      const M = MODES[this.mode];
      if (M.schedule === 'day') return { phase: dayPhase(now), left: null };
      if (!M.phases) return null;
      const total = M.phases.reduce((s, p) => s + p[1], 0); let x = this.t % total;
      for (const [ph, len] of M.phases) { if (x < len) return { phase: ph, left: len - x, len }; x -= len; }
      return null;
    }
    // view = plant.view() or viewFromPoints() (or null to only advance time); returns the command id to send now, or null
    next(dtReal, v, check, now) {
      this.t += dtReal;
      const p = this.phase(now); if (!p || !v) return null;   // no view (nothing known yet, or a control in flight): just keep time
      if (v.estop) { this.held = 'Demo paused: the emergency stop is active -- reset it to carry on'; return null; }
      if (this.t < this.pendingUntil) return null;
      const want = p.phase === 'idle' ? 'stop' : p.phase;
      for (const cmd of this.steps(v, want)) {
        if (this.t - (this.sent[cmd] == null ? -1e9 : this.sent[cmd]) < this.cooldown) continue;
        const why = check ? check(cmd) : null;
        if (why && /^Already/.test(why)) { this.sent[cmd] = this.t; continue; }   // the plant is ahead of the screen
        // pumping into a full reservoir / generating from an empty one is what the interlocks are for: hold, don't push
        if (why) { this.held = `Demo holding: ${why}`; this.pendingUntil = this.t + 5; return null; }
        this.held = ''; this.sent[cmd] = this.t; this.pendingUntil = this.t + this.gap;
        return cmd;
      }
      this.held = '';
      return null;
    }
    steps(v, want) {
      const out = [];
      if (want !== 'stop') { if (!v.gridCB) out.push('gridcb.close'); if (!v.genCB) out.push('gencb.close'); if (out.length) return out; }
      for (const u of v.units) {
        const s = u.state, id = 'u' + u.n;
        if (want === 'stop') { if (s !== 'stop' && s !== 'stopping') out.push(id + '.stop'); continue; }
        if (s === want || s === want + '-start' || s === 'stopping') continue;
        out.push(s !== 'stop' ? id + '.stop' : `${id}.${want}`);
      }
      return out;
    }
  }

  // ------------------------------------------------------------------ challenges
  // setup(plant, ctx) arranges the plant; tick(plant, ctx, secs) returns null while running, then a result
  // { pass, stars (0-3), score, text }. ctx (from the host): { setLoss(pct), ctrlOk, polls, answered, staleMax }.
  // end(plant) (optional) tidies up however it finished; fmt(score) words a best score; lowerWins = smaller is better.
  const CHALLENGES = {
    peak: {
      name: 'Evening peak', icon: '🌆', secs: 90, lowerWins: true, fmt: s => s + ' s', end(m) { m.demand = 0; },
      brief: 'It is 5:30 pm and Queensland is coming home: demand jumps 450 MW and the frequency is sagging. Get both units generating, 400 MW or more in total, within 90 seconds.',
      setup(m) { m.reset({ up: 70, accel: 1 }); m.demand = 450; m.units.forEach(u => { u.sp = 285; }); },
      tick(m, ctx, s) {
        if (m.genMW >= 400) { const stars = s < 45 ? 3 : s < 70 ? 2 : 1; m.demand = 0; return { pass: true, stars, score: Math.round(s), text: `${Math.round(m.genMW)} MW on the grid after ${s.toFixed(0)} s. Frequency back to ${m.hz.toFixed(2)} Hz.` }; }
        if (s >= this.secs) { m.demand = 0; return { pass: false, stars: 0, score: Math.round(m.genMW), text: `Only ${Math.round(m.genMW)} MW after 90 s -- the market dispatched someone else.` }; }
        return null;
      },
    },
    low: {
      name: 'Low reservoir', icon: '🏜️', secs: 150, fmt: s => s + ' MWh',
      brief: 'Splityard Creek is down to 20 % and the market wants an average of 250 MW for the next 2½ minutes (time runs ×60, so about 2½ hours of plant time). Deliver it without setting off the upper reservoir LOW alarm.',
      setup(m) { m.reset({ up: 20, accel: 60 }); m.units.forEach(u => { u.sp = 200; }); this.mwh0 = 0; },
      tick(m, ctx, s) {
        if (m.lo) return { pass: false, stars: 0, score: Math.round(m.mwhGen), text: `LOW level alarm after ${s.toFixed(0)} s with ${Math.round(m.mwhGen)} MWh delivered. Splityard Creek ran too low.` };
        if (s >= this.secs) {
          const avg = m.mwhGen / (this.secs * 60 / 3600), pass = avg >= 250;
          return { pass, stars: pass ? (m.up > 14 ? 3 : m.up > 12 ? 2 : 1) : 0, score: Math.round(m.mwhGen), text: `Averaged ${avg.toFixed(0)} MW (${Math.round(m.mwhGen)} MWh), finishing at ${m.up.toFixed(1)} % with no LOW alarm.${pass ? '' : ' Not quite the 250 MW the market wanted.'}` };
        }
        return null;
      },
    },
    radio: {
      name: 'Bad radio day', icon: '📡', secs: 180, needsMaster: true, fmt: s => s + ' % answered',
      brief: 'Storms over the range: the P25 link is losing 30 % of packets for 3 minutes. Keep SCADA working -- get 4 controls through (any) and never let the master\'s data go more than 45 s stale.',
      setup(m, ctx) { ctx.setLoss(30); },
      tick(m, ctx, s) {
        const fail = ctx.staleMax > 45;
        if (fail || s >= this.secs) {
          ctx.setLoss(null);
          const pct = ctx.polls ? Math.round(100 * ctx.answered / ctx.polls) : 0, pass = !fail && ctx.ctrlOk >= 4;
          return { pass, stars: pass ? (pct >= 80 ? 3 : pct >= 65 ? 2 : 1) : 0, score: pct, text: `${ctx.ctrlOk} control(s) confirmed, ${pct} % of requests answered, data at most ${ctx.staleMax.toFixed(0)} s stale.${fail ? ' The master lost sight of the station for too long.' : ''}` };
        }
        return null;
      },
    },
  };

  return { Plant, POINTS, idx, C, MODES, Sequencer, CHALLENGES, UNIT_STATES, viewFromPoints, rtuComms, crobCommand, plantAdapter, head, dayPhase };
});
