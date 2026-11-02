/* Kelly Page -- Mackay gas turbine SCADA trainer: plant model, DNP3 point map, fuel maths, demo cycle, challenges.
 * Pure (no DOM; UMD: window.MackayGT). The UI is js/mackaygtui.js (on js/scadakit.js); tests: tests/mackaygt-tests.html.
 *
 * A TRAINING SIMULATION inspired by the former Mackay Gas Turbine (QLD, decommissioned 2021) -- not affiliated with
 * Stanwell; engine figures are approximate and for education. One Rolls-Royce Olympus industrial gas turbine, 34 MW
 * open-cycle peaker on light fuel oil, twin-shaft: an aero-derived gas generator (LP spool N1 + HP spool N2, 8 cannular
 * combustors) blowing a separate free power turbine that drives the generator at 3000 rpm (50 Hz).
 *
 *   Time       The start/stop sequence, spools, flames and protection run in REAL seconds whatever the time speed, so an
 *              operator can watch a start (about 85 s cold to full load); fuel, tanks, temperatures, counters and the
 *              clock run in plant time = real x accel, so at x60 the fuel counters and tanks visibly move.
 *   Fuel       flow follows the fuel control valve; full-load fuel = 34 MW x SFC (0.30 kg/kWh) / density (0.84 kg/L)
 *              = ~12,140 L/h; at part load an open-cycle machine is much worse per MWh: full-speed-no-load already burns
 *              22 % of full-load fuel, gas-generator idle 10 % (FUEL.fsnl / FUEL.idle). Every figure is an estimate.
 *   Tanks      bulk storage (1.2 ML) -> transfer pump -> day tank (30 kL) -> fuel pump -> engine. Day tank low-low trips.
 *   Electrical generator breaker (unit -> station bus) and line breaker (bus -> the Mackay network). On the grid the
 *              governor holds the MW setpoint; on an island (black start) it holds 50 Hz and follows the town's load --
 *              more load than the engine has and the frequency collapses (under-frequency trip).
 *   Interlocks check(id) explains, in words, why a command is refused; permissives() is the start checklist.
 *   Trips      latch with a first-up; reset (BO2004) once the engine has run down. fault(name) injects one (instructor).
 *
 * POINTS is the one point list for the outstation, the master and the UI (DNP3 indexes from 0: BI0001 = BI 0).
 * BI0022 Generator Protection Trip and BI0023 Fuel Low-Low Trip are additions (so every trip has a first-up on SCADA).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scadacore.js'));
  else root.MackayGT = factory(root.ScadaCore);
})(typeof self !== 'undefined' ? self : this, function (SC) {
  'use strict';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const toward = (x, target, step) => (x < target ? Math.min(target, x + step) : Math.max(target, x - step));
  const lag = (x, target, dt, tau) => x + (target - x) * Math.min(1, dt / tau);

  // ------------------------------------------------------------------ constants (approximate)
  const C = {
    RATED_MW: 34, MVA: 42, KV: 11, PT_SYNC: 3000, PT_TRIP: 3300,          // 3300 rpm = 110 % power turbine overspeed
    N2_IDLE: 78, OIL_P: 2.6, OIL_LOW: 1.5, OIL_TRIP: 1.0,
    EGT_ALARM: 560, EGT_TRIP: 600, SPREAD_ALARM: 45, SPREAD_TRIP: 70, VIB_ALARM: 7.1, VIB_TRIP: 11,
    HZ_HI: 52, HZ_LO: 47.5, REV_MW: -1.0,
    BATT_FLOAT: 127, BATT_LOW: 112, FILTER_MAX: 25, OILTANK_MIN: 40,
    STORAGE_L: 1.2e6, DAY_L: 30000, TRANSFER_LPH: 30000, STORAGE_LOW: 10, DAY_LOW: 15, DAY_LOWLOW: 3,
    RAMP: 1.5, UNLOAD: 3, AUX_MW: 0.4, COOL_S: 12, RUNON_S: 15, H: 6, COLD_LOAD: 0.15,
    MW_SP: [0, 34], KV_SP: [10.5, 11.5],
  };
  // fuel + the "what does it cost" sums -- all configurable on the page, all estimates
  const FUEL = { sfc: 0.30, density: 0.84, fsnl: 0.22, idle: 0.10, price: 1.90, co2: 2.68, tanker: 55000, car: 60, pool: 2.5e6, homes: 18000, kwHome: 1.5, storageL: C.STORAGE_L };

  const STAGES = [['perm', 'Pre-start checks'], ['lube', 'Lube oil'], ['crank', 'Crank + purge'], ['ignite', 'Ignition + light-off'], ['accel', 'Accelerate to idle'],
    ['pt', 'Power turbine to 3000 rpm'], ['excite', 'Excitation'], ['sync', 'Synchronise'], ['ramp', 'Load ramp']];
  const STATE_NAMES = { stopped: 'Stopped', perm: 'Pre-start checks', lube: 'Lube oil pump', crank: 'Cranking / purge', ignite: 'Light-off', accel: 'Accelerating',
    pt: 'Power turbine accelerating', excite: 'Exciting', sync: 'Synchronising', ramp: 'Ramping load', run: 'On load', fsnl: 'Full speed, no load',
    unload: 'Unloading', cool: 'Cool-down run', rundown: 'Running down', runon: 'Lube oil run-on' };
  const TRIPS = {
    overspeed: { bi: 'trip.os', text: 'Power turbine OVERSPEED (110 %)' }, egt: { bi: 'trip.egt', text: 'High exhaust gas temperature' },
    vibration: { bi: 'trip.vib', text: 'High bearing vibration' }, oil: { bi: 'trip.oil', text: 'Low lube oil pressure' },
    flameout: { bi: 'trip.flame', text: 'Flame out' }, fire: { bi: 'fire', text: 'FIRE in the enclosure -- CO2 released' },
    fuel: { bi: 'trip.fuel', text: 'Fuel low-low (day tank)' }, genprot: { bi: 'trip.gen', text: 'Generator protection' },
    estop: { bi: 'estop', text: 'EMERGENCY STOP' },
  };
  const FAULTS = {   // instructor faults (and the demo's): what goes wrong AT the plant
    overspeed: 'Governor failure on load rejection (trips the generator breaker; the power turbine runs away)',
    egt: 'Hot section fouling: exhaust temperature creeps up', spread: 'Blocked fuel nozzle in can 5: exhaust spread grows',
    vibration: 'Bearing distress: vibration grows', oil: 'Lube oil leak: pressure and tank level fall', flameout: 'Fuel filter blockage: flame out',
    fire: 'Fire in the turbine enclosure', fuel: 'Fuel transfer pump fails: the day tank drains', revpower: 'Fuel control valve sticks nearly shut (reverse power)',
    nolight: 'Igniter fault: the next start fails to light', blackout: 'Network blackout (the Mackay grid goes dead)', gridback: 'Network restored',
  };
  const CAN_OFF = [3, -5, 6, -2, 1, -6, 4, -1];   // thermocouple offsets, degC

  // fuel flow in L/h at a power (MW) with a fuel config; mode 'load' (on the generator), 'fsnl', 'idle'
  function fullLoadLph(f = FUEL, mw = C.RATED_MW) { return mw * 1000 * f.sfc / f.density; }
  function fuelLph(mw, f = FUEL) { const full = fullLoadLph(f); return full * (f.fsnl + (1 - f.fsnl) * clamp(mw, 0, C.RATED_MW * 1.05) / C.RATED_MW); }
  // the fun numbers for a flow (L/h)
  function fuelStats(lph, f = FUEL) {
    const lps = lph / 3600;
    return { lph, lpm: lph / 60, kgph: lph * f.density, lps, carSecs: lps > 0 ? f.car / lps : null, tankersPerHour: lph / f.tanker, poolsPerWeek: lph * 168 / f.pool,
      costPerHour: lph * f.price, co2tPerHour: lph * f.co2 / 1000, sfcHere: null };
  }
  // "how much to run the town": homes x average kW -> MW, litres per hour, how long the storage tank lasts
  function town(f = FUEL, storageL = f.storageL) {
    const mw = f.homes * f.kwHome / 1000, fits = mw <= C.RATED_MW, lph = fuelLph(Math.min(mw, C.RATED_MW), f);
    return { mw, fits, units: Math.ceil(mw / C.RATED_MW), lph, hours: lph > 0 ? storageL / lph : null };
  }

  class Plant {
    constructor(o = {}) { this.listeners = []; this.fuelCfg = Object.assign({}, FUEL, o.fuel || {}); this.reset(o); }
    reset(o = {}) {
      this.t = 0; this.accel = o.accel || 1; this.clock = (o.hour == null ? 14 : o.hour) * 3600; this.rnd = o.seed != null ? seeded(o.seed) : Math.random;
      if (o.fuel) Object.assign(this.fuelCfg, o.fuel);
      this.state = 'stopped'; this.st = 0; this.purge = 0;
      this.n1 = 0; this.n2 = 0; this.pt = 0; this.ptRef = 0; this.fcv = 0; this.g = 0; this.flames = Array(8).fill(false); this.starter = false; this.igniters = false;
      this.egt = 30; this.tcs = Array(8).fill(30); this.vib = 0.4; this.oilP = 0; this.oilT = 30; this.oilTank = 85; this.lubePump = false; this.fuelPump = false;
      this.storageL = o.storageL != null ? o.storageL : this.fuelCfg.storageL * (o.storagePct == null ? 82 : o.storagePct) / 100; this.dayL = C.DAY_L * (o.dayPct == null ? 90 : o.dayPct) / 100; this.transfer = false;
      this.genCB = false; this.lineCB = o.lineCB != null ? o.lineCB : o.gridLive !== false; this.gridLive = o.gridLive !== false; this.blackStart = false; this.remote = true;
      this.excited = false; this.kv = 0; this.hz = 50; this.mw = 0; this.mvar = 0; this.mwCmd = 0; this.mwSp = o.mwSp != null ? o.mwSp : 20; this.kvSp = 11.0;
      this.wtemp = 35; this.batt = C.BATT_FLOAT; this.fire = false; this.co2 = false; this.co2At = 0; this.vent = false; this.encT = 32;
      this.townExtra = 0; this.slip = 0; this.angle = 0; this.syncHeld = '';
      this.trips = {}; this.firstUp = null; this.estop = false; this.startFail = null; this.faults = {}; this.revT = 0; this.hzT = 0;
      this.mwh = 0; this.litres = 0; this.starts = 0; this.tripCount = 0; this.hours = 0;
      this.run = { litres: 0, mwh: 0, secs: 0 };
      this.demandMW = null;   // set by a challenge: the town's demand on the grid
      this.townFixed = o.townMW != null ? o.townMW : null;   // a challenge's own town in MW (else the page's "run the town" homes x kW)
      this.p25 = { healthy: true, rssi: -85, pktRate: 0, sent: 0, rcvd: 0 };
      this.alarmsAcked = 0;
      if (o.online != null) this.goOnline(o.online);
      this.emit({ type: 'reset' });
    }
    // a hot unit already on the grid at mw (challenges start here)
    goOnline(mw) {
      this.state = 'run'; this.n2 = 96; this.n1 = 94; this.pt = C.PT_SYNC; this.ptRef = C.PT_SYNC; this.flames.fill(true); this.lubePump = true; this.fuelPump = true;
      this.oilP = C.OIL_P + 0.4; this.oilT = 62; this.egt = 450; this.excited = true; this.kv = this.kvSp; this.genCB = true; this.lineCB = true; this.gridLive = true;
      this.mwSp = mw; this.mwCmd = mw; this.mw = mw; this.g = this.fcv = this.gFor(mw); this.vent = true;
    }
    on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
    emit(e) { for (const f of this.listeners) try { f(e); } catch (err) { console.error(err); } }
    ackAlarms() { this.alarmsAcked = Date.now(); this.emit({ type: 'ack' }); }
    get F() { return this.fuelCfg; }
    get tripped() { return Object.keys(this.trips).length > 0; }
    get burning() { return this.flames.filter(Boolean).length > 0; }
    get running() { return ['accel', 'pt', 'excite', 'sync', 'ramp', 'run', 'fsnl', 'unload', 'cool'].includes(this.state); }
    get starting() { return STAGES.some(s => s[0] === this.state); }
    get fuelLph() { return this.fuelOk ? this.fcv * fullLoadLph(this.F) : 0; }
    get fuelOk() { return this.fuelPump && this.dayL > 0; }
    get storagePct() { return 100 * this.storageL / this.F.storageL; }
    get dayPct() { return 100 * this.dayL / C.DAY_L; }
    get spread() { const f = this.tcs; return Math.max(...f) - Math.min(...f); }
    get busLive() { return (this.lineCB && this.gridLive) || (this.genCB && this.kv > 5); }
    get paralleled() { return this.genCB && this.lineCB && this.gridLive; }
    get island() { return this.genCB && !this.paralleled; }
    get townLit() { return this.gridLive || (this.lineCB && this.genCB && this.kv > 8); }
    get townMW() { return this.townFixed != null ? this.townFixed : this.F.homes * this.F.kwHome / 1000; }
    get available() { return !this.tripped && !this.estop && !this.co2 && !this.fire && this.dayPct > C.DAY_LOWLOW && this.batt > C.BATT_LOW; }
    get ambient() { const h = this.clock / 3600; return 26 + 5 * Math.sin(2 * Math.PI * (h - 9) / 24); }
    get cit() { return this.ambient + 0.6; }
    get cdp() { return this.n2 < 1 ? 1.013 : 1.013 * (1 + 9.5 * Math.pow(Math.max(0, this.n2 - 20) / 80, 2.2)); }
    get cdt() { return (this.cit + 273) * Math.pow(this.cdp / 1.013, 0.286 / 0.86) - 273; }
    get filterDp() { return (2 + 10 * Math.pow(this.n1 / 100, 2)) * (1 + this.hours * 0.002) + (this.faults.filter ? 20 : 0); }
    get fuelP() { return this.fuelPump ? 4 + 40 * this.fcv : 0; }
    get amps() { const s = Math.hypot(this.mw, this.mvar); return this.kv > 0.5 ? s * 1e6 / (Math.sqrt(3) * this.kv * 1000) : 0; }
    get pf() { const s = Math.hypot(this.mw, this.mvar); return s > 0.3 ? this.mw / s : 1; }
    get field() { return this.excited ? (this.kv / C.KV) * (180 + 9 * this.mvar + 2.5 * Math.abs(this.mw)) : 0; }
    gFor(mw) { const f = this.F; return f.fsnl + (1 - f.fsnl) * mw / C.RATED_MW; }

    // ---------------------------------------------------------------- the start checklist: [{ id, text, ok, why }]
    permissives() {
      const p = [], add = (id, text, ok, why) => p.push({ id, text, ok: !!ok, why: ok ? '' : why });
      const fu = this.firstUp ? TRIPS[this.firstUp.cause].text : 'a trip';
      add('trip', 'No trip latched', !this.tripped, `a trip is latched (first-up: ${fu}) -- reset it first (BO2004)`);
      add('estop', 'Emergency stop clear', !this.estop, 'the emergency stop is active -- reset it (BO2004)');
      add('fire', 'Fire system healthy, CO2 not released', !this.fire && !this.co2, this.fire ? 'fire detected in the enclosure' : 'the CO2 has been released -- reset (BO2004) once the enclosure is safe');
      add('rest', 'Engine at rest', this.state === 'stopped' && this.n2 < 5, this.state === 'stopped' ? `the engine is still running down (N2 ${this.n2.toFixed(0)} %)` : `the unit is ${STATE_NAMES[this.state].toLowerCase()}`);
      add('gencb', 'Generator breaker open', !this.genCB, 'the generator breaker is closed');
      add('oil', 'Lube oil tank level OK', this.oilTank > C.OILTANK_MIN, `lube oil tank low (${this.oilTank.toFixed(0)} %)`);
      add('fuel', 'Fuel in the day tank', this.dayPct > C.DAY_LOW, `the day tank is at ${this.dayPct.toFixed(0)} % -- not enough fuel to start`);
      add('batt', 'DC battery healthy', this.batt > C.BATT_LOW, `DC battery low (${this.batt.toFixed(1)} V) -- the controls and emergency lube pump need it`);
      add('aux', 'Station supply (or black start)', this.busLive || this.blackStart, 'the station bus is dead (blackout) -- select BLACK START mode (BO2007) to start from the battery');
      add('filter', 'Intake filter clean', this.filterDp < C.FILTER_MAX, `intake filter blocked (${this.filterDp.toFixed(0)} mbar)`);
      return p;
    }
    permOk() { return this.permissives().every(p => p.ok || p.id === 'rest'); }

    // ---------------------------------------------------------------- commands (local panel, DNP3 and the demo all come here)
    // ids: start stop estop reset gencb.close gencb.open linecb.close linecb.open blackstart.on blackstart.off rl.remote rl.local
    // check() -> null when allowed, else the interlock in plain words ("Already ..." = nothing to do)
    check(id) {
      const [what, act] = id.split('.'), S = this.state;
      if (what === 'start') {
        if (this.starting) return 'Already starting';
        if (this.running && S !== 'cool') return 'Already running';
        const bad = this.permissives().find(p => !p.ok);
        return bad ? `Can't start: ${bad.why}` : null;
      }
      if (what === 'stop') return ['stopped', 'rundown', 'runon'].includes(S) ? 'Already stopped' : ['unload', 'cool'].includes(S) ? 'Already stopping' : null;
      if (what === 'estop') return this.estop ? 'Already stopped: the emergency stop is active' : null;
      if (what === 'reset') {
        if (!this.tripped && !this.estop && !this.co2 && !this.startFail) return 'Already reset: nothing is latched';
        if (!['stopped', 'runon'].includes(S)) return `Can't reset yet: the engine is still ${STATE_NAMES[S].toLowerCase()} -- wait for it to run down`;
        if (this.fire) return "Can't reset: fire still detected in the enclosure";
        return null;
      }
      if (what === 'gencb') {
        if (act === 'open') return this.genCB ? null : 'Already open: the generator breaker';
        if (this.genCB) return 'Already closed: the generator breaker';
        if (S === 'sync') return 'Already synchronising -- the auto-synchroniser closes the breaker at 12 o\'clock';
        if (S !== 'fsnl') return `Can't close the generator breaker: the unit isn't at speed and excited (it is ${STATE_NAMES[S].toLowerCase()}) -- start it, the sequence closes it`;
        if (!this.busLive && !this.blackStart) return "Can't close onto a dead bus without BLACK START mode (BO2007)";
        return null;
      }
      if (what === 'linecb') {
        if (act === 'open') return this.lineCB ? null : 'Already open: the line breaker';
        if (this.lineCB) return 'Already closed: the line breaker';
        if (this.gridLive && this.genCB && this.kv > 5) return "Can't close the line breaker: both sides are live and not synchronised -- open the generator breaker first";
        return null;
      }
      if (what === 'blackstart') return act === 'on' ? (this.blackStart ? 'Already on: black start mode' : null) : (this.blackStart ? null : 'Already off: black start mode');
      if (what === 'rl') return act === 'remote' ? (this.remote ? 'Already in REMOTE' : null) : (this.remote ? null : 'Already in LOCAL');
      return 'Unknown command';
    }
    command(id, by = 'local') {
      const why = this.check(id);
      if (why) {
        const already = /^Already/.test(why);
        if (!already) this.emit({ type: 'block', id, reason: why, by });
        return { ok: false, reason: why, status: already ? 14 : 15 };
      }
      const [what, act] = id.split('.');
      if (what === 'start') {
        if (this.state === 'cool') { this.go('fsnl', by); this.excited = true; return { ok: true }; }   // a stop in cool-down can be turned round
        this.starts++; this.run = { litres: 0, mwh: 0, secs: 0 }; this.startFail = null; this.go('perm', by);
      } else if (what === 'stop') this.normalStop(by);
      else if (what === 'estop') { this.estop = true; this.emit({ type: 'estop', on: true, by }); this.trip('estop', 'EMERGENCY STOP', by); }
      else if (what === 'reset') {
        const was = { trips: Object.keys(this.trips), estop: this.estop, co2: this.co2 };
        this.trips = {}; this.firstUp = null; this.estop = false; this.co2 = false; this.startFail = null; this.faults = {};
        this.emit({ type: 'reset', by, was });
      } else if (what === 'gencb') { if (act === 'open') this.breaker('gencb', false, by); else this.go('sync', by); }
      else if (what === 'linecb') this.breaker('linecb', act === 'close', by);
      else if (what === 'blackstart') { this.blackStart = act === 'on'; this.emit({ type: 'mode', id: 'blackstart', on: this.blackStart, by }); }
      else if (what === 'rl') { this.remote = act === 'remote'; this.emit({ type: 'mode', id: 'remote', on: this.remote, by }); }
      return { ok: true };
    }
    // which = 'mwsp' | 'kvsp' (the AO point ids)
    setpoint(which, value, by = 'local') {
      const [lo, hi] = which === 'mwsp' ? C.MW_SP : C.KV_SP, unit = which === 'mwsp' ? 'MW' : 'kV';
      if (!(value >= lo && value <= hi)) return { ok: false, status: 12, reason: `Setpoint out of range: ${value} ${unit} (allowed ${lo}-${hi} ${unit})` };
      if (which === 'mwsp') this.mwSp = Math.round(value * 10) / 10; else this.kvSp = Math.round(value * 100) / 100;
      this.emit({ type: 'setpoint', which, value: which === 'mwsp' ? this.mwSp : this.kvSp, unit, by });
      return { ok: true };
    }
    normalStop(by) {
      if (this.genCB && this.mw > 1 && !this.island) this.go('unload', by);
      else if (this.genCB) { this.breaker('gencb', false, by); this.go('cool', by); }
      else if (this.burning) this.go('cool', by);
      else this.go('rundown', by);
    }
    go(state, by = 'plant') { const prev = this.state; this.state = state; this.st = 0; this.syncHeld = ''; this.emit({ type: 'stage', state, prev, by }); }
    breaker(id, close, by, how = by === 'sequence' ? 'auto' : 'manual') {
      const wasMW = this.mw, wasIsland = this.island;
      if (id === 'gencb') this.genCB = close; else this.lineCB = close;
      this.emit({ type: 'breaker', id, closed: close, by, how });
      if (id === 'gencb' && !close) {
        // load rejection: the power turbine overspeeds until the governor catches it (a failed governor doesn't)
        if (wasMW > 2) { this.pt += 240 * wasMW / C.RATED_MW; this.emit({ type: 'loadrej', mw: wasMW }); if (this.faults.overspeed) this.ptRunaway = true; }
        this.mw = 0; this.mvar = 0; this.mwCmd = 0;
        if (['ramp', 'run'].includes(this.state)) this.go('fsnl', 'plant');
      }
      if (id === 'linecb' && close && this.genCB && !this.gridLive) this.townExtra = C.COLD_LOAD;   // cold-load pickup when the town comes back
      if (id === 'linecb' && !close && this.genCB && this.gridLive && wasMW > 2 && !wasIsland) this.emit({ type: 'loadrej', mw: wasMW });   // the island's frequency does the rest
    }
    trip(cause, text, by = 'protection', o = {}) {
      if (this.trips[cause]) return;
      const first = !this.tripped && !this.firstUp;
      this.trips[cause] = { text: text || TRIPS[cause].text, at: this.t, first };
      if (first) this.firstUp = { cause, text: text || TRIPS[cause].text, at: this.t };
      if (!['stopped', 'runon', 'rundown'].includes(this.state) || this.burning) {
        this.tripCount++;
        const wasMW = this.mw;
        this.fcv = 0; this.g = 0; this.flames.fill(false); this.starter = false; this.igniters = false; this.excited = false; this.ptRunaway = false;
        if (this.genCB) { this.genCB = false; this.emit({ type: 'breaker', id: 'gencb', closed: false, by: 'protection', how: 'trip' }); }
        this.mw = 0; this.mvar = 0; this.mwCmd = 0;
        this.go('rundown', 'protection');
        this.emit({ type: 'trip', cause, text: this.trips[cause].text, first, smoke: o.smoke !== false, mw: wasMW, by });
      } else this.emit({ type: 'trip', cause, text: this.trips[cause].text, first, smoke: false, by });
      this.faults = Object.assign({}, this.faults, { overspeed: false, egt: false, spread: false, vibration: false, flameout: false, revpower: false });
    }
    startFailed(reason) { this.startFail = reason; this.emit({ type: 'startfail', reason }); this.fcv = 0; this.flames.fill(false); this.starter = false; this.igniters = false; this.go(this.n2 > 1 ? 'rundown' : 'runon', 'protection'); }
    // instructor / demo faults (FAULTS); returns false when it doesn't apply now
    fault(name, by = 'instructor') {
      if (!FAULTS[name]) return false;
      if (name === 'blackout') {
        if (!this.gridLive) return false;
        this.gridLive = false; if (this.lineCB && !this.genCB) { this.lineCB = false; this.emit({ type: 'breaker', id: 'linecb', closed: false, by: 'protection', how: 'undervoltage' }); }
        this.emit({ type: 'grid', live: false, by }); return true;
      }
      // network back: it synchronises to the island, and the unit holds the MW it was making
      if (name === 'gridback') { if (this.gridLive) return false; this.gridLive = true; this.townExtra = 0; this.mwCmd = this.mw; this.emit({ type: 'grid', live: true, by }); return true; }
      if (name === 'fire') { this.fire = true; this.fireAt = this.t; this.fireRt = 0; this.emit({ type: 'fire', by }); return true; }
      if (name === 'overspeed') { this.faults.overspeed = true; if (this.genCB && this.mw > 2) this.breaker('gencb', false, 'protection', 'trip'); else this.ptRunaway = this.running; this.emit({ type: 'fault', name, by }); return true; }
      this.faults[name] = true; this.faultT = 0; this.emit({ type: 'fault', name, by });
      return true;
    }

    // ---------------------------------------------------------------- the process
    tick(r) {
      const dt = r * this.accel;   // plant seconds
      this.t += dt; this.clock = (this.clock + dt) % 86400; this.st += r;
      const f = this.F, S = this.state;
      // --- the sequence (real seconds)
      if (S === 'perm') { if (this.st >= 2.5) { const bad = this.permissives().find(p => !p.ok && p.id !== 'rest'); if (bad) this.startFailed(`Start aborted at the pre-start checks: ${bad.why}`); else this.go('lube', 'sequence'); } }
      else if (S === 'lube') { this.lubePump = true; if (this.oilP >= 1.8 && this.st >= 2) this.go('crank', 'sequence'); else if (this.st > 8) this.startFailed(`Start aborted: lube oil pressure did not build (${this.oilP.toFixed(1)} bar) -- check the lube oil pump`); }
      else if (S === 'crank') {
        if (!this.starter) { this.starter = true; this.emit({ type: 'starter', on: true }); }
        this.fuelPump = true; this.vent = true;
        if (this.n2 >= 22) this.purge += r;
        if (this.purge >= 6) { this.purge = 0; this.go('ignite', 'sequence'); this.igniters = true; }
      } else if (S === 'ignite') {
        this.g = this.st > 0.5 ? 0.04 : 0;
        for (let i = 0; i < 8; i++) if (!this.flames[i] && !this.faults.nolight && this.fcv > 0.02 && this.st >= 0.8 + i * 0.25) { this.flames[i] = true; this.emit({ type: 'can', i }); }
        if (this.flames.every(Boolean)) { this.igniters = false; this.emit({ type: 'lightoff' }); this.go('accel', 'sequence'); }
        else if (this.st > 5) { this.faults.nolight = false; this.trip('flameout', `Failed to light: ${8 - this.flames.filter(Boolean).length} of 8 cans had no flame -- bad start`, 'protection'); }
      } else if (S === 'accel') {
        this.g = toward(this.g, f.idle, 0.012 * r);
        if (this.starter && this.n2 > 55) { this.starter = false; this.emit({ type: 'starter', on: false }); }
        if (this.n2 >= C.N2_IDLE - 0.5) this.go('pt', 'sequence');
      } else if (S === 'pt') {
        this.ptRef = toward(this.ptRef, C.PT_SYNC, 200 * r);
        if (this.pt >= C.PT_SYNC - 15) this.go('excite', 'sequence');
      } else if (S === 'excite') {
        if (!this.excited) { this.excited = true; this.emit({ type: 'excite', on: true }); }
        if (this.kv >= this.kvSp * 0.97) this.go('sync', 'sequence');
      } else if (S === 'sync') this.autoSync(r);
      else if (S === 'ramp') { if (this.island ? this.st > 3 : Math.abs(this.mw - this.mwSp) < 0.5) this.go('run', 'sequence'); }
      else if (S === 'unload') { if (this.mw < 1) { this.breaker('gencb', false, 'sequence'); this.go('cool', 'sequence'); } }
      else if (S === 'cool') { this.excited = false; if (this.st >= C.COOL_S) { this.flames.fill(false); this.g = 0; this.fcv = 0; this.emit({ type: 'fueloff' }); this.go('rundown', 'sequence'); } }
      else if (S === 'rundown') { this.excited = false; this.g = 0; if (this.n2 < 1 && this.pt < 20) this.go('runon', 'sequence'); }
      else if (S === 'runon') { if (this.st >= C.RUNON_S) { this.lubePump = false; this.fuelPump = false; this.vent = false; this.go('stopped', 'sequence'); } }
      if (S === 'stopped') { this.lubePump = false; this.fuelPump = false; }

      // --- the governor: fuel demand g, then the fuel control valve follows it
      const onGrid = this.paralleled, isl = this.island;
      if (['pt', 'excite', 'sync', 'fsnl'].includes(this.state) || (this.state === 'cool')) {
        const ref = this.state === 'cool' ? 2400 : this.state === 'sync' ? C.PT_SYNC * (1 + this.slip / 50) : this.state === 'pt' ? this.ptRef : C.PT_SYNC;
        this.ptRef = ref;
        const base = f.idle + (f.fsnl - f.idle) * clamp(ref / C.PT_SYNC, 0, 1);
        this.g = clamp(base + 0.0008 * (ref - this.pt), 0, 0.6);
      } else if (['ramp', 'run', 'unload'].includes(this.state)) {
        if (onGrid) {
          const target = this.state === 'unload' ? 0 : this.mwSp;
          this.mwCmd = toward(this.mwCmd, target, (this.state === 'unload' ? C.UNLOAD : C.RAMP) * r);
          this.g = this.gFor(this.mwCmd);
        } else if (isl) {
          const load = this.islandLoad();
          this.g = clamp(this.gFor(load + 6 * (50 - this.hz)), 0, 1.08);
        }
      }
      if (this.faults.revpower && this.burning) this.g = Math.min(this.g, f.fsnl * 0.55);
      if (this.faults.flameout && this.burning) { this.faultT = (this.faultT || 0) + r; if (this.faultT > 1.5) this.flames = this.flames.map((x, i) => x && i % 3 !== 0); }
      const fuelAvail = this.fuelOk && !['stopped', 'perm', 'lube', 'crank', 'rundown', 'runon'].includes(this.state);
      this.fcv = fuelAvail ? lag(this.fcv, this.g, r, 0.6) : 0;
      if (!fuelAvail && this.burning && this.state !== 'ignite') this.flames.fill(false);

      // --- spools + power turbine (real seconds)
      let n2ss;
      if (this.burning && this.fcv > 0.02) n2ss = this.fcv < f.idle ? 25 + 53 * clamp((this.fcv - 0.04) / (f.idle - 0.04), 0, 1) : C.N2_IDLE + 22 * Math.pow(clamp((this.fcv - f.idle) / (1 - f.idle), 0, 1.2), 0.6);
      else n2ss = this.starter ? 25 : 0;
      this.n2 = lag(this.n2, n2ss, r, n2ss > this.n2 ? 2.5 : 6);
      if (this.n2 < 0.3 && n2ss === 0) this.n2 = 0;
      const n1ss = this.n2 <= 25 ? this.n2 * 0.6 : 15 + (this.n2 - 25) * 85 / 75;
      this.n1 = lag(this.n1, n1ss, r, 3.5); if (this.n1 < 0.3 && n1ss === 0) this.n1 = 0;
      if (onGrid) { this.pt = lag(this.pt, 60 * this.hz, r, 0.3); }
      else if (this.ptRunaway) { this.pt += 70 * r; }
      else if (isl) { this.pt = 60 * this.hz; }
      else if (['pt', 'excite', 'sync', 'fsnl', 'cool'].includes(this.state)) this.pt = toward(lag(this.pt, this.ptRef, r, 1.6), this.ptRef, 0);
      else if (this.burning && this.n2 > 60) this.pt = lag(this.pt, 300 * (this.n2 - 60) / 18, r, 4);   // gas generator idle: the PT creeps
      else this.pt = lag(this.pt, 0, r, 7);
      if (this.pt < 5 && !this.burning) this.pt = 0;

      // --- generator (excitation, frequency, power)
      const kvT = this.excited && this.pt > 2700 ? (onGrid ? C.KV + this.mvar * 0.004 : this.kvSp) : 0;
      this.kv = lag(this.kv, kvT, r, kvT ? 1.0 : 0.5); if (this.kv < 0.05) this.kv = 0;
      this.noise = clamp((this.noise || 0) + (this.rnd() - 0.5) * 0.004, -0.03, 0.03);
      const pmech = this.burning ? C.RATED_MW * (this.fcv - f.fsnl) / (1 - f.fsnl) : (this.genCB ? -1.6 : 0);   // no fuel: the PT is motored
      if (onGrid) {
        this.hz = lag(this.hz, 50 + this.noise, r, 2);
        this.mw = lag(this.mw, pmech, r, 1.2);
        this.mvar = lag(this.mvar, clamp((this.kvSp - C.KV) * 60 + 0.25 * Math.max(0, this.mw), -12, 22), r, 1.5);
      } else if (isl) {
        const load = this.islandLoad();
        this.mw = load; this.mvar = load * 0.33;
        this.hz = clamp(this.hz + (pmech - load) / (2 * C.H * C.MVA) * 50 * r, 40, 60);   // swing equation, inertia H
      } else {
        this.mw = 0; this.mvar = 0; this.hz = this.pt > 100 ? this.pt / 60 : 50;
        if (this.state !== 'sync') this.angle = 0;
      }
      if (this.townExtra > 0) this.townExtra = Math.max(0, this.townExtra - r * C.COLD_LOAD / 25);
      const S2 = Math.hypot(this.mw, this.mvar);
      this.wtemp = lag(this.wtemp, this.ambient + 12 + 58 * Math.pow(S2 / C.MVA, 2), dt, 900);

      // --- lube oil, fuel tanks, fire, battery, vibration, exhaust
      const oilT = (this.lubePump ? C.OIL_P : 0) + (this.n2 > 60 ? 0.4 : 0);
      this.oilP = lag(this.oilP, oilT * (this.faults.oil ? 0.3 : 1), r, this.faults.oil ? 4 : 1.2);
      if (this.faults.oil) this.oilTank = Math.max(0, this.oilTank - dt / 120);
      this.oilT = lag(this.oilT, this.n2 > 30 ? this.ambient + 25 + 30 * Math.max(0, this.mw) / C.RATED_MW : this.ambient + 3, dt, 240);
      const burn = this.fuelLph * dt / 3600;
      this.dayL = Math.max(0, this.dayL - burn);
      if (!this.transfer && this.dayPct < 60 && this.storageL > 0 && !this.faults.fuel) this.transfer = true;
      if (this.transfer && (this.dayPct >= 95 || this.storageL <= 0 || this.faults.fuel)) this.transfer = false;
      if (this.transfer) { const mv = Math.min(this.storageL, C.TRANSFER_LPH * dt / 3600, C.DAY_L - this.dayL); this.storageL -= mv; this.dayL += mv; }
      this.litres += burn; this.run.litres += burn;
      const genE = Math.max(0, this.mw) * dt / 3600; this.mwh += genE; this.run.mwh += genE;
      if (this.burning) { this.hours += dt / 3600; this.run.secs += dt; }
      if (this.fire) {
        this.fireRt = (this.fireRt || 0) + r;
        if (!this.co2 && this.fireRt > 1.5) { this.co2 = true; this.vent = false; this.emit({ type: 'co2' }); this.trip('fire', null, 'protection'); }
        if (this.co2 && this.fireRt > 12) { this.fire = false; this.emit({ type: 'fire-out' }); }
      }
      this.encT = lag(this.encT, this.fire ? 180 : this.ambient + (this.burning ? (this.vent ? 14 : 40) : 4), r, this.fire ? 2 : 30);
      const auxLive = this.busLive;
      this.batt = auxLive ? lag(this.batt, C.BATT_FLOAT, dt, 600) : Math.max(100, this.batt - (dt / 3600) * 1.5 - (this.starter ? 0.004 * r : 0));
      this.battSag = this.starter ? 6 : 0;
      const sp = this.n2 / 100, crit = this.n2 > 38 && this.n2 < 52 && !this.burning ? 2.2 : 0;
      if (this.faults.vibration && this.burning) this.faultVib = (this.faultVib || 0) + 0.6 * r; else if (!this.faults.vibration) this.faultVib = 0;
      this.vib = lag(this.vib, this.n2 < 0.5 ? 0.2 : 1.2 + 2.6 * sp * sp + 0.8 * Math.max(0, this.mw) / C.RATED_MW + crit + (this.faultVib || 0) + (this.rnd() - 0.5) * 0.25, r, 0.8);
      let egtT = this.cit;
      if (this.burning) egtT = this.cit + 200 + 260 * Math.pow(Math.max(0, this.fcv), 0.8) + (['ignite', 'accel'].includes(this.state) ? 140 : 0);
      if (this.faults.egt && this.burning) { this.faultEgt = (this.faultEgt || 0) + 5 * r; egtT += this.faultEgt; } else if (!this.faults.egt) this.faultEgt = 0;
      this.egt = lag(this.egt, egtT, r, this.burning ? 2 : 20);
      if (this.faults.spread && this.burning) this.faultSp = (this.faultSp || 0) + 3 * r; else if (!this.faults.spread) this.faultSp = 0;
      for (let i = 0; i < 8; i++) this.tcs[i] = this.egt + (this.burning ? CAN_OFF[i] * (0.4 + this.fcv) : 0) - (i === 4 ? (this.faultSp || 0) : 0) - (this.burning && !this.flames[i] ? 90 : 0);

      // --- protection (only while there's something to protect). The flame detectors are fast, the thermocouples slow:
      // lost flames trip FLAME OUT before the cold cans show up as an exhaust spread.
      if (this.running && this.state !== 'cool' && this.flames.filter(Boolean).length < 6) this.trip('flameout', `Flame out: ${8 - this.flames.filter(Boolean).length} of 8 cans lost their flame`);
      if (this.pt > C.PT_TRIP) this.trip('overspeed', `Power turbine OVERSPEED: ${Math.round(this.pt)} rpm (${(100 * this.pt / C.PT_SYNC).toFixed(0)} %)`);
      if (this.burning && this.egt > C.EGT_TRIP) this.trip('egt', `High exhaust gas temperature: ${Math.round(this.egt)} °C`);
      if (this.burning && this.fcv > 0.08 && this.spread > C.SPREAD_TRIP) this.trip('egt', `High exhaust temperature SPREAD: ${Math.round(this.spread)} °C (can 5 cold)`);
      if (this.vib > C.VIB_TRIP) this.trip('vibration', `High bearing vibration: ${this.vib.toFixed(1)} mm/s`);
      if (this.n2 > 40 && this.oilP < C.OIL_TRIP && !['stopped', 'perm', 'lube', 'runon'].includes(this.state)) this.trip('oil', `Low lube oil pressure: ${this.oilP.toFixed(2)} bar`);
      if (this.fuelPump && this.burning && this.dayPct < C.DAY_LOWLOW) this.trip('fuel', `Fuel low-low: day tank at ${this.dayPct.toFixed(1)} %`);
      if (this.genCB && this.mw < C.REV_MW) { this.revT += r; if (this.revT > 2) this.trip('genprot', `Generator protection: REVERSE POWER (${this.mw.toFixed(1)} MW)`); } else this.revT = 0;
      if (this.genCB && (this.hz > C.HZ_HI || this.hz < C.HZ_LO)) { this.hzT += r; if (this.hzT > 1) this.trip('genprot', `Generator protection: ${this.hz > 50 ? 'OVER' : 'UNDER'}-FREQUENCY (${this.hz.toFixed(2)} Hz)`); } else this.hzT = 0;
    }
    islandLoad() { return C.AUX_MW + (this.lineCB ? this.townMW * (1 + this.townExtra) : 0); }
    // auto-synchroniser: pull the slip down, close when the synchroscope needle is near 12 o'clock
    autoSync(r) {
      if (!this.excited) this.excited = true;
      if (!(this.lineCB && this.gridLive)) {   // the bus isn't held up by the network
        if (this.busLive && this.genCB) return;
        if (this.blackStart) { this.slip = 0; this.angle = 0; this.breaker('gencb', true, 'sequence', 'deadbus'); this.go('ramp', 'sequence'); return; }
        this.syncHeld = 'Waiting: the bus is dead and BLACK START mode is off'; return;
      }
      this.syncHeld = '';
      this.slip = Math.max(0.06, 0.35 - 0.035 * this.st);
      const fgen = this.pt / 60, ds = fgen - 50;
      this.angle = ((this.angle + 360 * ds * r) % 360 + 360) % 360;
      const a = this.angle > 180 ? this.angle - 360 : this.angle;
      if (this.st > 3 && Math.abs(ds) < 0.25 && Math.abs(a) < 7 && Math.abs(this.kv - C.KV) < 0.4) { this.angle = 0; this.breaker('gencb', true, 'sequence', 'sync'); this.mwCmd = 0.5; this.go('ramp', 'sequence'); }
    }

    view() {
      const tr = {}; for (const k of Object.keys(TRIPS)) tr[k] = !!this.trips[k];
      return { remote: false, known: true, state: this.state, stageIdx: stageIdx(this.state), running: this.running, starting: this.starting, avail: this.available, permOk: this.permOk(), perms: this.permissives(),
        n1: this.n1, n2: this.n2, pt: this.pt, flames: this.flames.slice(), flame: this.burning, egt: this.egt, spread: this.spread, tcs: this.tcs.slice(), cit: this.cit, cdp: this.cdp, cdt: this.cdt, dp: this.filterDp,
        oilP: this.oilP, oilT: this.oilT, oilTank: this.oilTank, vib: this.vib, fuelLph: this.fuelLph, fuelP: this.fuelP, storagePct: this.storagePct, dayPct: this.dayPct, fuelPump: this.fuelPump, lubePump: this.lubePump, transfer: this.transfer,
        mw: this.mw, mvar: this.mvar, kv: this.kv, amps: this.amps, hz: this.hz, pf: this.pf, field: this.field, wtemp: this.wtemp, genCB: this.genCB, lineCB: this.lineCB, blackStart: this.blackStart,
        busLive: this.busLive, gridLive: this.gridLive, townLit: this.townLit, island: this.island, sync: this.state === 'sync' ? { slip: this.pt / 60 - 50, angle: this.angle, held: this.syncHeld } : null,
        fire: this.fire, co2: this.co2, vent: this.vent, batt: this.batt - (this.battSag || 0), ambient: this.ambient, remoteOn: this.remote, link: this.p25.healthy, rssi: this.p25.rssi,
        trips: tr, tripped: this.tripped, firstUp: this.firstUp ? this.firstUp.cause : null, firstText: this.firstUp ? this.firstUp.text : null, estop: this.estop, startFail: this.startFail,
        mwSp: this.mwSp, kvSp: this.kvSp, starter: this.starter, igniters: this.igniters, litres: this.litres, mwh: this.mwh, starts: this.starts, tripCount: this.tripCount, hours: this.hours,
        run: { ...this.run }, demandMW: this.demandMW, fuelLow: this.storagePct < C.STORAGE_LOW || this.dayPct < C.DAY_LOW };
    }
    dnp3Plant() { return plantAdapter(this); }
  }
  const stageIdx = s => { const i = STAGES.findIndex(x => x[0] === s); return i >= 0 ? i : ['ramp', 'run'].includes(s) ? STAGES.length : -1; };
  function seeded(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  // ------------------------------------------------------------------ the point database (shared by outstation, master, UI)
  // AI: raw on the wire = value x scale (16-bit friendly for the lean P25 class 0); db = event deadband in raw counts,
  // sized for a P25 channel (0.5 MW, 2 % speed, 30 rpm, 8 °C ...) -- tighter and the events swamp the link
  const POINTS = {
    bi: [
      { id: 'avail', code: 'BI0001', name: 'Unit Available', get: m => +m.available },
      { id: 'perm', code: 'BI0002', name: 'Start Permissives OK', get: m => +m.permOk() },
      { id: 'seq', code: 'BI0003', name: 'Starting Sequence Active', get: m => +m.starting },
      { id: 'run', code: 'BI0004', name: 'Unit Running', get: m => +m.running },
      { id: 'flame', code: 'BI0005', name: 'Flame Detected (any)', get: m => +m.burning },
      { id: 'gencb', code: 'BI0006', name: 'Generator Breaker Closed', get: m => +m.genCB },
      { id: 'linecb', code: 'BI0007', name: 'Line Breaker Closed', get: m => +m.lineCB },
      { id: 'blackstart', code: 'BI0008', name: 'Black Start Mode Active', get: m => +m.blackStart },
      { id: 'lube', code: 'BI0009', name: 'Lube Oil Pump Running', get: m => +m.lubePump },
      { id: 'fuelpump', code: 'BI0010', name: 'Fuel Pump Running', get: m => +m.fuelPump },
      { id: 'fire', code: 'BI0011', name: 'Fire Detected', get: m => +(m.fire || !!m.trips.fire) },
      { id: 'co2', code: 'BI0012', name: 'CO2 Released', get: m => +m.co2 },
      { id: 'trip.os', code: 'BI0013', name: 'Overspeed Trip', get: m => +!!m.trips.overspeed },
      { id: 'trip.egt', code: 'BI0014', name: 'High EGT Trip', get: m => +!!m.trips.egt },
      { id: 'trip.vib', code: 'BI0015', name: 'High Vibration Trip', get: m => +!!m.trips.vibration },
      { id: 'trip.oil', code: 'BI0016', name: 'Low Lube Oil Pressure Trip', get: m => +!!m.trips.oil },
      { id: 'trip.flame', code: 'BI0017', name: 'Flame Out Trip', get: m => +!!m.trips.flameout },
      { id: 'fuellow', code: 'BI0018', name: 'Fuel Tank Low Alarm', get: m => +(m.storagePct < C.STORAGE_LOW || m.dayPct < C.DAY_LOW) },
      { id: 'estop', code: 'BI0019', name: 'Emergency Stop Active', get: m => +m.estop },
      { id: 'remote', code: 'BI0020', name: 'Remote Control Enabled', get: m => +m.remote },
      { id: 'link', code: 'BI0021', name: 'P25 Link Healthy', get: m => +m.p25.healthy },
      { id: 'trip.gen', code: 'BI0022', name: 'Generator Protection Trip', get: m => +!!m.trips.genprot },
      { id: 'trip.fuel', code: 'BI0023', name: 'Fuel Low-Low Trip', get: m => +!!m.trips.fuel },
    ],
    ai: [
      { id: 'mw', code: 'AI1001', name: 'Generator MW', unit: 'MW', scale: 10, db: 5, get: m => m.mw },
      { id: 'mvar', code: 'AI1002', name: 'Generator MVAr', unit: 'MVAr', scale: 10, db: 10, get: m => m.mvar },
      { id: 'kv', code: 'AI1003', name: 'Generator Voltage', unit: 'kV', scale: 100, db: 10, get: m => m.kv },
      { id: 'amps', code: 'AI1004', name: 'Generator Current', unit: 'A', scale: 1, db: 50, get: m => m.amps },
      { id: 'hz', code: 'AI1005', name: 'Frequency', unit: 'Hz', scale: 100, db: 5, get: m => (m.kv > 1 || m.genCB ? m.hz : 0) },
      { id: 'pf', code: 'AI1006', name: 'Power Factor', unit: '', scale: 100, db: 3, get: m => m.pf },
      { id: 'n1', code: 'AI1007', name: 'Gas Generator LP Speed N1', unit: '%', scale: 10, db: 20, get: m => m.n1 },
      { id: 'n2', code: 'AI1008', name: 'Gas Generator HP Speed N2', unit: '%', scale: 10, db: 20, get: m => m.n2 },
      { id: 'pt', code: 'AI1009', name: 'Power Turbine Speed', unit: 'rpm', scale: 1, db: 30, get: m => m.pt },
      { id: 'egt', code: 'AI1010', name: 'EGT Average', unit: '°C', scale: 1, db: 8, get: m => m.egt },
      { id: 'spread', code: 'AI1011', name: 'EGT Spread', unit: '°C', scale: 1, db: 5, get: m => m.spread },
      { id: 'cit', code: 'AI1012', name: 'Compressor Inlet Temp', unit: '°C', scale: 10, db: 10, get: m => m.cit },
      { id: 'cdp', code: 'AI1013', name: 'Compressor Delivery Pressure', unit: 'bar', scale: 10, db: 3, get: m => m.cdp },
      { id: 'cdt', code: 'AI1014', name: 'Compressor Delivery Temp', unit: '°C', scale: 1, db: 8, get: m => m.cdt },
      { id: 'dp', code: 'AI1015', name: 'Intake Filter dP', unit: 'mbar', scale: 10, db: 10, get: m => m.filterDp },
      { id: 'oilp', code: 'AI1016', name: 'Lube Oil Pressure', unit: 'bar', scale: 100, db: 10, get: m => m.oilP },
      { id: 'oilt', code: 'AI1017', name: 'Lube Oil Temp', unit: '°C', scale: 10, db: 20, get: m => m.oilT },
      { id: 'vib', code: 'AI1018', name: 'Bearing Vibration', unit: 'mm/s', scale: 10, db: 5, get: m => m.vib },
      { id: 'fuel', code: 'AI1019', name: 'Fuel Flow', unit: 'L/hr', scale: 1, db: 250, get: m => m.fuelLph },
      { id: 'fuelp', code: 'AI1020', name: 'Fuel Pressure', unit: 'bar', scale: 10, db: 20, get: m => m.fuelP },
      { id: 'tank', code: 'AI1021', name: 'Fuel Storage Tank Level', unit: '%', scale: 100, db: 20, get: m => m.storagePct },
      { id: 'wtemp', code: 'AI1022', name: 'Generator Winding Temp', unit: '°C', scale: 10, db: 20, get: m => m.wtemp },
      { id: 'batt', code: 'AI1023', name: 'DC Battery Voltage', unit: 'V', scale: 10, db: 5, get: m => m.batt - (m.battSag || 0) },
      { id: 'amb', code: 'AI1024', name: 'Ambient Temp', unit: '°C', scale: 10, db: 5, get: m => m.ambient },
      { id: 'rssi', code: 'AI1025', name: 'P25 RSSI', unit: 'dBm', scale: 1, db: 3, get: m => m.p25.rssi },
      { id: 'pkt', code: 'AI1026', name: 'P25 Packet Rate', unit: 'pkt/min', scale: 10, db: 50, get: m => m.p25.pktRate },
    ],
    // counters: db = how far a counter moves before it makes a class 3 event (else every litre would be an event)
    ctr: [
      { id: 'mwh', code: 'C4001', name: 'MWh Generated', db: 2, get: m => Math.floor(m.mwh) },
      { id: 'litres', code: 'C4002', name: 'Fuel Burned Litres', db: 1000, get: m => Math.floor(m.litres) },
      { id: 'starts', code: 'C4003', name: 'Starts', db: 0, get: m => m.starts },
      { id: 'trips', code: 'C4004', name: 'Trips', db: 0, get: m => m.tripCount },
      { id: 'hours', code: 'C4005', name: 'Running Hours', db: 0, get: m => Math.floor(m.hours) },
      { id: 'sent', code: 'C4006', name: 'DNP3 Messages Sent', db: 20, get: m => m.p25.sent },
      { id: 'rcvd', code: 'C4007', name: 'DNP3 Messages Received', db: 20, get: m => m.p25.rcvd },
    ],
    bo: [
      { id: 'start', code: 'BO2001', name: 'Start Unit', how: 'PULSE ON (or CLOSE)' },
      { id: 'stop', code: 'BO2002', name: 'Normal Stop', how: 'PULSE ON (or CLOSE)' },
      { id: 'estop', code: 'BO2003', name: 'Emergency Stop', how: 'PULSE ON (or CLOSE)' },
      { id: 'reset', code: 'BO2004', name: 'Reset Trips / E-Stop', how: 'PULSE ON (or CLOSE)' },
      { id: 'gencb', code: 'BO2005', name: 'Generator Breaker Close/Trip', how: 'CLOSE 0x41 = synchronise + close, TRIP 0x81 opens', pair: ['close', 'open'] },
      { id: 'linecb', code: 'BO2006', name: 'Line Breaker Close/Trip', how: 'CLOSE 0x41 closes, TRIP 0x81 opens', pair: ['close', 'open'] },
      { id: 'blackstart', code: 'BO2007', name: 'Black Start Mode On/Off', how: 'CLOSE 0x41 = on, TRIP 0x81 = off', pair: ['on', 'off'] },
      { id: 'rl', code: 'BO2008', name: 'Remote/Local Select', how: 'CLOSE 0x41 = remote, TRIP 0x81 = local (accepted even in LOCAL)', pair: ['remote', 'local'] },
    ],
    ao: [
      { id: 'mwsp', code: 'AO3001', name: 'MW Setpoint', unit: 'MW', scale: 10, min: C.MW_SP[0], max: C.MW_SP[1], get: m => m.mwSp },
      { id: 'kvsp', code: 'AO3002', name: 'Voltage Setpoint', unit: 'kV', scale: 100, min: C.KV_SP[0], max: C.KV_SP[1], get: m => m.kvSp },
    ],
  };
  const idx = SC.indexPoints(POINTS);

  function plantAdapter(m) {
    return {
      model: m, points: POINTS,
      local: p => !m.remote && !(p && p.id === 'rl'),   // in LOCAL the RTU refuses SCADA controls -- except the selector itself
      trouble: () => m.estop || m.tripped,
      boValue: p => +({ gencb: m.genCB, linecb: m.lineCB, blackstart: m.blackStart, rl: m.remote }[p.id] || false),
      onChange: fn => m.on(e => { if (!['setpoint', 'reset', 'ack', 'can', 'starter', 'excite', 'fault'].includes(e.type)) fn(); }),
      validate(p, code, selecting) {
        const cmd = SC.crobCommand(p, code); if (!cmd) return 3;   // FORMAT ERROR
        if (selecting) { const why = m.check(cmd); if (why && !/^Already/.test(why)) { m.emit({ type: 'block', id: cmd, reason: why, by: 'scada' }); return 15; } }
        return 0;
      },
      execute(p, code) { const r = m.command(SC.crobCommand(p, code), 'scada'); return r.ok ? 0 : r.status; },
      aoValidate(p, raw) { const v = raw / p.scale; return v >= p.min && v <= p.max ? 0 : 12; },   // OUT OF RANGE
      aoExecute(p, raw) { const r = m.setpoint(p.id, raw / p.scale, 'scada'); return r.ok ? 0 : r.status; },
    };
  }
  const rtuComms = SC.rtuComms;

  // A view (same shape as Plant.view()) from a master's mirrored points: the SCADA screen, drawn from DNP3 alone.
  // What SCADA can't see (the start sequence's stage, each can's flame, the synchroscope) it infers or leaves out; the
  // first-up trip comes from the RTU's time-stamped events -- that's what sequence-of-events recording is for.
  const TRIP_BI = Object.entries(TRIPS).map(([cause, t]) => [cause, idx.bi[t.bi]]);
  function viewFromPoints(db) {
    const R = SC.reader(POINTS, idx, db), bi = id => !!R.bi(id), n0 = id => { const x = R.ai(id); return x == null ? 0 : x; };
    const tr = {}; for (const [cause, i] of TRIP_BI) tr[cause] = !!db.bi[i];
    // first-up: of the trips standing now, the one whose latest ON event is oldest
    let firstUp = null, t0 = Infinity;
    for (const [cause, i] of TRIP_BI) if (tr[cause]) {
      const ev = (db.events || []).filter(e => e.g === 2 && e.index === i && e.value).pop(), t = ev && ev.time ? ev.time : Infinity;
      if (firstUp == null || t < t0) { firstUp = cause; t0 = t; }
    }
    const running = bi('run'), seq = bi('seq'), gencb = bi('gencb'), kv = n0('kv'), pt = n0('pt'), n2 = n0('n2');
    const state = seq ? (gencb ? 'ramp' : kv > 5 ? 'sync' : pt > 2900 ? 'excite' : pt > 100 && bi('flame') ? 'pt' : bi('flame') ? 'accel' : n2 > 10 ? 'crank' : bi('lube') ? 'lube' : 'perm')
      : running ? (gencb ? 'run' : 'fsnl') : bi('flame') ? 'cool' : n2 > 1 || pt > 20 ? 'rundown' : bi('lube') ? 'runon' : 'stopped';
    const egt = n0('egt'), spread = n0('spread');
    const tcs = Array.from({ length: 8 }, (_, i) => egt + (i === 4 ? -spread / 2 : i === 0 ? spread / 2 : 0));
    const mw = n0('mw'), mvar = n0('mvar');
    return { remote: true, known: db.at > 0, state, stageIdx: stageIdx(state), running, starting: seq, avail: bi('avail'), permOk: bi('perm'), perms: null,
      n1: n0('n1'), n2, pt, flames: Array(8).fill(bi('flame')), flame: bi('flame'), egt, spread, tcs, cit: n0('cit'), cdp: n0('cdp'), cdt: n0('cdt'), dp: n0('dp'),
      oilP: n0('oilp'), oilT: n0('oilt'), oilTank: null, vib: n0('vib'), fuelLph: n0('fuel'), fuelP: n0('fuelp'), storagePct: n0('tank'), dayPct: null, fuelPump: bi('fuelpump'), lubePump: bi('lube'), transfer: null,
      mw, mvar, kv, amps: n0('amps'), hz: n0('hz'), pf: n0('pf'), field: null, wtemp: n0('wtemp'), genCB: gencb, lineCB: bi('linecb'), blackStart: bi('blackstart'),
      busLive: null, gridLive: null, townLit: gencb && bi('linecb') ? true : null, island: null, sync: null,
      fire: bi('fire'), co2: bi('co2'), vent: running && !bi('co2'), batt: n0('batt'), ambient: n0('amb'), remoteOn: bi('remote'), link: R.bi('link') !== 0, rssi: n0('rssi'),
      trips: tr, tripped: Object.values(tr).some(Boolean), firstUp, firstText: firstUp ? TRIPS[firstUp].text : null, estop: bi('estop'), startFail: null,
      mwSp: R.ao('mwsp'), kvSp: R.ao('kvsp'), starter: null, igniters: null, litres: R.ctr('litres') || 0, mwh: R.ctr('mwh') || 0, starts: R.ctr('starts') || 0, tripCount: R.ctr('trips') || 0, hours: R.ctr('hours') || 0,
      run: null, demandMW: null, fuelLow: bi('fuellow') };
  }

  // ------------------------------------------------------------------ time modes + the demo cycle
  // accel is plant seconds per real second (fuel, tanks, temperatures, counters); the sequence always runs in real time.
  const MODES = {
    real: { name: 'Real time', accel: 1 },
    x10: { name: '×10', accel: 10 },
    x60: { name: '×60', accel: 60 },
    demo: { name: 'Demo cycle', accel: 30, demo: true },
  };
  // The demo cycle: cold start -> full load -> hold -> stop -> blackout + black start -> town on an island -> grid back
  // -> a trip -> reset + restart, round and round. Each step names what it is waiting for; act(v) returns the next
  // command id, { ao, value } for a setpoint, or 'fault:<name>' for something that happens AT the plant.
  const DEMO = [
    // the setpoint goes once (AO3001's status only comes back with an integrity poll, so SCADA can't wait to see it)
    { name: 'Cold start to full load', act: (v, s) => {
      if (v.tripped || v.estop) return 'reset';
      if (v.blackStart) return 'blackstart.off';
      if (!v.lineCB) return 'linecb.close';
      if (v.state === 'stopped') return 'start';
      if (!s.sp && v.mwSp !== 34) { s.sp = true; return { ao: 0, value: 34 }; }
      return null;
    },
      done: v => v.genCB && v.mw >= 33 },
    { name: 'Holding full load', act: () => null, done: (v, s) => s.t > 40 },
    { name: 'Normal stop: unload, cool down, run down', act: v => (v.running || v.starting ? 'stop' : null), done: (v, s) => v.state === 'stopped' && s.t > 3 },
    { name: 'BLACKOUT -- black start the unit, then the town', act: (v, s) => {
      if (!s.blackout) { s.blackout = true; return 'fault:blackout'; }
      if (v.tripped || v.estop) return 'reset';
      if (!v.blackStart) return 'blackstart.on';
      if (!v.genCB && v.lineCB && v.state === 'stopped') return 'linecb.open';   // sectionalise: start on the station bus alone
      if (v.state === 'stopped') return 'start';
      if (v.genCB && v.state === 'run' && !v.lineCB) return 'linecb.close';
      return null;
    }, done: v => v.genCB && v.lineCB && v.running },
    { name: 'Town running on the island', act: () => null, done: (v, s) => s.t > 40 },
    { name: 'Network restored', act: (v, s) => { if (!s.back) { s.back = true; return 'fault:gridback'; } return v.blackStart ? 'blackstart.off' : null; }, done: (v, s) => s.back && !v.blackStart && s.t > 8 },
    { name: 'Something goes wrong ...', act: (v, s) => { if (!s.f) { s.f = true; return 'fault:vibration'; } return null; }, done: (v, s) => v.tripped || s.t > 60 },
    { name: 'Tripped: wait for the run-down, reset, restart', act: v => (v.state === 'stopped' && (v.tripped || v.estop) ? 'reset' : null), done: v => v.state === 'stopped' && !v.tripped && !v.estop },
  ];
  class Sequencer {
    constructor(mode, o = {}) { this.mode = mode; this.t = 0; this.i = 0; this.s = { t: 0 }; this.held = ''; this.sent = {}; this.cooldown = o.cooldown || 15; this.gap = o.gap || 3; this.pendingUntil = 0; }
    get step() { return DEMO[this.i]; }
    phase() { return MODES[this.mode] && MODES[this.mode].demo ? { phase: this.step.name, step: this.i + 1, of: DEMO.length } : null; }
    // view = plant.view() or viewFromPoints() (or null to only advance time); returns what to send now, or null
    next(dtReal, v, check) {
      this.t += dtReal; this.s.t += dtReal;
      if (!MODES[this.mode] || !MODES[this.mode].demo || !v) return null;
      if (this.step.done(v, this.s)) { this.i = (this.i + 1) % DEMO.length; this.s = { t: 0 }; this.held = ''; return null; }
      if (this.t < this.pendingUntil) return null;
      const c = this.step.act(v, this.s); if (!c) { this.held = ''; return null; }
      const key = typeof c === 'string' ? c : `ao${c.ao}=${c.value}`;
      if (this.t - (this.sent[key] == null ? -1e9 : this.sent[key]) < this.cooldown) return null;
      if (typeof c === 'string' && !c.startsWith('fault:') && check) {
        const why = check(c);
        if (why && /^Already/.test(why)) { this.sent[key] = this.t; return null; }   // the plant is ahead of the screen
        if (why) { this.held = `Demo holding: ${why}`; this.pendingUntil = this.t + 5; return null; }
      }
      this.held = ''; this.sent[key] = this.t; this.pendingUntil = this.t + this.gap;
      return c;
    }
  }

  // ------------------------------------------------------------------ challenges
  // setup(plant, ctx) arranges the plant; tick(plant, ctx, secs) returns null while running, then a result
  // { pass, stars (0-3), score, text }. ctx (from the host): { setLoss(pct), ctrlOk, polls, answered, staleMax }.
  // end(plant) (optional) tidies up however it finished; fmt(score) words a best score; lowerWins = smaller is better.
  const L0 = m => Math.round(m.run.litres).toLocaleString('en-AU');
  const CHALLENGES = {
    blackout: {
      name: 'Blackout!', icon: '🌑', secs: 300, lowerWins: true, fmt: s => s + ' s to light the town',
      brief: 'The Mackay network is dead, the line breaker tripped on under-voltage, and the station runs on its DC battery. Black start the unit: BLACK START mode, start, let it energise the dead bus, then close the line breaker to bring the town back. Keep it lit for 15 s without a trip.',
      setup(m) { m.reset({ accel: 1, gridLive: false, lineCB: false, townMW: 27 }); this.litAt = null; },
      tick(m, ctx, s) {
        if (m.tripped) return { pass: false, stars: 0, score: Math.round(s), text: `Tripped: ${m.firstUp ? m.firstUp.text : 'trip'}. The town stays dark. ${L0(m)} L burned.` };
        const lit = m.lineCB && m.genCB && m.kv > 8;
        if (lit && this.litAt == null) this.litAt = s; if (!lit) this.litAt = null;
        if (this.litAt != null && s - this.litAt >= 15) { const t = Math.round(this.litAt); return { pass: true, stars: t < 130 ? 3 : t < 190 ? 2 : 1, score: t, text: `The town came back after ${t} s and held at ${m.hz.toFixed(2)} Hz. ${L0(m)} L of diesel burned, no trips.` }; }
        if (s >= this.secs) return { pass: false, stars: 0, score: Math.round(s), text: 'Five minutes and the town is still dark.' };
        return null;
      },
    },
    peak: {
      name: 'Peak demand', icon: '⚡', secs: 300, lowerWins: true, fmt: s => s + ' s cold to 34 MW',
      brief: 'A heatwave evening: the market needs every megawatt. From cold, get the unit to full load (33 MW or more on the grid) as fast as you can -- start it, and send AO3001 = 34 MW. Any trip and you lose.',
      setup(m) { m.reset({ accel: 1, mwSp: 20 }); },
      tick(m, ctx, s) {
        if (m.tripped) return { pass: false, stars: 0, score: Math.round(s), text: `Tripped: ${m.firstUp ? m.firstUp.text : 'trip'}.` };
        if (m.genCB && m.mw >= 33) { const t = Math.round(s); return { pass: true, stars: t < 100 ? 3 : t < 130 ? 2 : 1, score: t, text: `${m.mw.toFixed(1)} MW on the grid after ${t} s, ${L0(m)} L burned getting there, no trips.` }; }
        if (s >= this.secs) return { pass: false, stars: 0, score: Math.round(s), text: `Only ${m.mw.toFixed(1)} MW after 5 minutes.` };
        return null;
      },
    },
    fuel: {
      name: 'Fuel watch', icon: '⛽', secs: 240, fmt: s => s.toLocaleString('en-AU') + ' L left',
      brief: 'Supply ships late: about 44,000 L left between the day tank and storage, and the town\'s evening peak (17:00-21:00, time ×60) still to come. Follow the demand with AO3001 -- meet 95 % of it without running dry. Every MW you make above demand is diesel you won\'t have later.',
      setup(m) { m.reset({ accel: 60, online: 18, storageL: 17000, dayPct: 90, hour: 17 }); this.met = 0; this.want = 0; m.demandMW = 18; },
      tick(m, ctx, s) {
        const d = 18 + 14 * Math.pow(Math.sin(Math.PI * Math.min(1, s / this.secs)), 1.5);
        m.demandMW = d;
        const hrs = 0.25 * m.accel / 3600; this.want += d * hrs; this.met += Math.min(Math.max(0, m.paralleled ? m.mw : 0), d) * hrs;
        const left = Math.round(m.dayL + m.storageL);
        if (m.tripped) return { pass: false, stars: 0, score: left, text: `Tripped: ${m.firstUp ? m.firstUp.text : 'trip'} -- the town is short.` };
        if (s >= this.secs) {
          const pct = 100 * this.met / this.want, pass = pct >= 95;
          return { pass, stars: pass ? (left > 3000 ? 3 : left > 1500 ? 2 : 1) : 0, score: left, text: `Met ${pct.toFixed(1)} % of the evening's ${this.want.toFixed(0)} MWh, ${L0(m)} L burned, ${left.toLocaleString('en-AU')} L left in the tanks.${pass ? '' : ' Not enough of the demand.'}` };
        }
        return null;
      },
      end(m) { m.demandMW = null; },
    },
    radio: {
      name: 'Bad radio day', icon: '📡', secs: 300, needsMaster: true, fmt: s => s + ' % answered',
      brief: 'Cyclone weather: the P25 link loses 30 % of packets. From the control room, start the unit and get 25 MW or more on the grid (start + AO3001), without the master\'s data going more than 60 s stale.',
      setup(m, ctx) { m.reset({ accel: 1, mwSp: 20 }); ctx.setLoss(30); },
      tick(m, ctx, s) {
        const fail = ctx.staleMax > 60 || m.tripped, ok = m.genCB && m.mw >= 25;
        if (fail || ok || s >= this.secs) {
          ctx.setLoss(null);
          const pct = ctx.polls ? Math.round(100 * ctx.answered / ctx.polls) : 0, pass = ok && !fail;
          return { pass, stars: pass ? (pct >= 80 ? 3 : pct >= 65 ? 2 : 1) : 0, score: pct, text: `${ok ? `${m.mw.toFixed(1)} MW after ${Math.round(s)} s` : 'Never reached 25 MW'}; ${ctx.ctrlOk} control(s) confirmed, ${pct} % of requests answered, data at most ${ctx.staleMax.toFixed(0)} s stale.${m.tripped ? ' Tripped.' : ''}` };
        }
        return null;
      },
    },
  };

  return { Plant, POINTS, idx, C, FUEL, STAGES, STATE_NAMES, TRIPS, FAULTS, MODES, DEMO, Sequencer, CHALLENGES, viewFromPoints, rtuComms, plantAdapter, fullLoadLph, fuelLph, fuelStats, town, stageIdx };
});
