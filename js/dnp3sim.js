/* Kelly Page -- DNP3 Lab engine, pure (no DOM; UMD: window.DNP3Sim). Needs js/dnp3.js loaded first.
 *
 *  Substation  a 33/11 kV zone substation model: two 33 kV incomers, T1/T2 (20 MVA, 17-tap OLTC, tap 9 = nominal,
 *              1.25 %/step, "raise" = raise the 11 kV volts), 11 kV Bus A / B / C with ties BAB (normally closed) and
 *              BBC (normally open), six radial feeders (F1-F2 on A, F3-F4 on B, F5-F6 on C) each with an earth switch,
 *              and 2.4 MVAr capacitor banks C1 (Bus A) and C2 (Bus C). tick(dt) runs the load flow (simple per-island
 *              voltage drop, not a full Newton solve -- good enough to teach with), protection (feeder overcurrent
 *              0.4 s, backup 1.0 s on a stuck breaker, switch-on-to-fault, transformer over-temperature) and the
 *              interlocks. operate(id, action, by) is the only way anything switches -- the SLD, the DNP3 outstation
 *              and the challenges all go through it, so the interlocks can't be dodged except by the explicit bypass.
 *  POINTS      the outstation's point map (BI / BO / AI / counters, with scale + units + deadbands + class).
 *  Outstation  DNP3 outstation over a Substation: class 0/1/2/3 reads, events with timestamps from its OWN clock
 *              (which drifts and starts wrong, so the time-sync lab has something to fix), SELECT/OPERATE with a select
 *              timeout and identical-object check, DIRECT OPERATE (+NR), WRITE g50v1/g50v3/g80v1, DELAY MEASURE,
 *              RECORD CURRENT TIME, (dis/en)able unsolicited, cold/warm restart, link status.
 *  Master      DNP3 master: one transaction at a time with timeout + retry, CONFIRMs, a mirrored point database,
 *              SBO / direct controls, the non-LAN (delay measure) and LAN (record current time) time syncs.
 * Both stacks talk through `.send(frameBytes)` and `.receive(frameBytes)` --
 * the UI joins them with an in-page loopback link (js/dnp3lab.js). tests/dnp3-tests.html drives a master against an outstation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dnp3.js'));
  else root.DNP3Sim = factory(root.DNP3);
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';
  const now = () => (typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now());
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ------------------------------------------------------------------ the substation
  const FEEDERS = [
    { id: 'F1', bus: 'A', name: 'F1 Riverview', p: 3.4, q: 1.3 },
    { id: 'F2', bus: 'A', name: 'F2 Industrial Est', p: 4.6, q: 2.2 },
    { id: 'F3', bus: 'B', name: 'F3 Hospital', p: 2.8, q: 1.0 },
    { id: 'F4', bus: 'B', name: 'F4 CBD North', p: 3.9, q: 1.6 },
    { id: 'F5', bus: 'C', name: 'F5 Rural West', p: 2.2, q: 1.1 },
    { id: 'F6', bus: 'C', name: 'F6 Water Pumps', p: 3.1, q: 1.9 },
  ];
  const TX_MVA = 20, TAP_NOM = 9, TAP_MAX = 17, TAP_STEP = 0.0125, CAP_MVAR = 2.4, X_TX = 0.15, R_TX = 0.012;
  const OC_PICKUP = 600, OC_TIME = 0.4, BACKUP_TIME = 1.0, TEMP_ALARM = 105, TEMP_TRIP = 125, CAP_DISCHARGE = 30, TAP_TIME = 2.5;

  class Substation {
    constructor() {
      this.listeners = [];
      this.reset();
    }
    reset() {
      const cb = (name, closed, kv) => ({ type: 'cb', name, closed, kv, ops: 0 });
      this.el = {
        'cb.L1': cb('33 kV Incomer L1', true, 33), 'cb.L2': cb('33 kV Incomer L2', true, 33),
        'cb.T1H': cb('T1 33 kV CB', true, 33), 'cb.T2H': cb('T2 33 kV CB', true, 33),
        'cb.T1L': cb('T1 11 kV CB', true, 11), 'cb.T2L': cb('T2 11 kV CB', true, 11),
        'cb.BAB': cb('Bus Tie A-B', true, 11), 'cb.BBC': cb('Bus Tie B-C', false, 11),
        'cb.C1': cb('Cap Bank C1 CB', false, 11), 'cb.C2': cb('Cap Bank C2 CB', false, 11),
      };
      FEEDERS.forEach(f => { this.el['cb.' + f.id] = cb(f.name + ' CB', true, 11); this.el['es.' + f.id] = { type: 'es', name: f.name + ' Earth Switch', closed: false, kv: 11, ops: 0 }; });
      this.tx = { T1: { tap: TAP_NOM + 1, temp: 62, busy: 0, mw: 0, mvar: 0, amps: 0, load: 0, live: true }, T2: { tap: TAP_NOM + 1, temp: 60, busy: 0, mw: 0, mvar: 0, amps: 0, load: 0, live: true } };
      this.grid = { L1: true, L2: true, pu: 1.03, hz: 50.0, hzTarget: 50.0 };
      this.fdr = {}; FEEDERS.forEach(f => { this.fdr[f.id] = { ...f, scale: 1, fault: false, stuck: false, amps: 0, mw: 0, mvar: 0, live: true, ocT: 0, tripped: false }; });
      this.cap = { C1: { bus: 'A', lastOpen: -1e9, mvar: 0 }, C2: { bus: 'C', lastOpen: -1e9, mvar: 0 } };
      this.bus = { b33: { live: true, kv: 33 }, A: { live: true, kv: 11 }, B: { live: true, kv: 11 }, C: { live: true, kv: 11 } };
      this.t = 0; this.local = false; this.bypass = false; this.bypassUsed = 0; this.loadScale = 1; this.drift = true;
      this.alarms = {}; this.backupT = {}; this.seed = 7; this.totMW = 0; this.totMVAr = 0; this.pf = 1;
      this.solve(0);
    }
    on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
    emit(e) { e.t = this.t; for (const f of this.listeners) try { f(e); } catch (err) { console.error(err); } }
    rnd() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x7fffffff; }

    // -- interlocks: null = allowed, else the reason in plain words
    check(id, action) {
      const e = this.el[id], close = action === 'close';
      if (id.startsWith('tap.')) {
        const T = this.tx[id.slice(4)];
        if (T.busy > 0) return 'Tap changer still moving';
        if (action === 'raise' && T.tap >= TAP_MAX) return 'Already on top tap (17)';
        if (action === 'lower' && T.tap <= 1) return 'Already on bottom tap (1)';
        return null;
      }
      if (!e) return 'No such plant item';
      if (close === e.closed) return `Already ${close ? 'closed' : 'open'}`;
      if (this.bypass) return null;
      if (e.type === 'es') {
        const f = id.slice(3);
        if (close && this.el['cb.' + f].closed) return `Open ${f} CB first -- never earth a live feeder`;
        return null;
      }
      if (!close) return null;
      if (/^cb\.F\d$/.test(id) && this.el['es.' + id.slice(3)].closed) return `${id.slice(3)} earth switch is closed -- open it before closing the CB`;
      if (/^cb\.C\d$/.test(id)) {
        const c = this.cap[id.slice(3)], left = CAP_DISCHARGE - (this.t - c.lastOpen);
        if (left > 0) return `Capacitor still discharging -- wait ${Math.ceil(left)} s`;
        if (this.bus[c.bus].live && this.bus[c.bus].kv / 11 > 1.05) return `Bus ${c.bus} already above 1.05 pu -- the bank would push it higher`;
      }
      if (id === 'cb.BAB' || id === 'cb.BBC') {
        const [x, y] = id === 'cb.BAB' ? ['A', 'B'] : ['B', 'C'];
        const ix = this.islandOf(x), iy = this.islandOf(y);
        if (ix !== iy && this.islandTx(ix).length && this.islandTx(iy).length) {
          if (Math.abs(this.tx.T1.tap - this.tx.T2.tap) > 1) return `Paralleling T1 and T2 with taps ${this.tx.T1.tap} vs ${this.tx.T2.tap} -- match them within one step first`;
        }
        const earthed = this.islandFeeders(ix).concat(this.islandFeeders(iy)).find(f => this.fdr[f].fault && this.el['cb.' + f].closed);
        if (earthed) return `${earthed} is faulted and its CB is still closed -- you'd close onto the fault`;
      }
      return null;
    }
    // id 'cb.F1' + 'open'|'close', or 'tap.T1' + 'raise'|'lower'; by = 'local' | 'scada' | 'prot'. Returns { ok, reason, arc }
    operate(id, action, by = 'local') {
      if (by === 'scada' && this.local) return { ok: false, reason: 'Substation is in LOCAL control', status: 7 };
      if (by === 'scada' && id.startsWith('es.')) return { ok: false, reason: 'Earth switches are local operation only', status: 4 };
      const why = by === 'prot' ? null : this.check(id, action);
      if (why) { this.emit({ type: 'block', id, action, reason: why, by }); return { ok: false, reason: why, status: 15 }; }
      if (this.bypass && by !== 'prot') this.bypassUsed++;
      if (id.startsWith('tap.')) {
        const k = id.slice(4), T = this.tx[k];
        T.busy = TAP_TIME; T.pending = action === 'raise' ? 1 : -1;
        this.emit({ type: 'tap', id, tx: k, action, by, start: true });
        return { ok: true };
      }
      const e = this.el[id], close = action === 'close', amps = this.ampsThrough(id);
      e.closed = close; e.ops++;
      if (id.startsWith('cb.C') && !close) this.cap[id.slice(3)].lastOpen = this.t;
      this.solve(0);
      let fault = false;
      if (close && /^cb\.F\d$/.test(id) && (this.fdr[id.slice(3)].fault || this.el['es.' + id.slice(3)].closed) && this.fdr[id.slice(3)].live) fault = true;
      if (close && id.startsWith('es.') && this.fdr[id.slice(3)].live) fault = true;   // bypassed onto a live feeder
      const arc = fault ? 1 : clamp(amps / 900, 0.05, 0.8);
      this.emit({ type: 'op', id, action, closed: close, by, amps, arc, fault, name: e.name });
      if (fault) {   // switch on to fault: instant trip of whatever can clear it
        const f = id.slice(3);
        if (id.startsWith('es.')) this.fdr[f].fault = true;
        if (!this.fdr[f].stuck) setTimeout0(() => this.trip('cb.' + f, 'Switch-on-to-fault'), 0, this);
      }
      return { ok: true, arc, fault };
    }
    trip(id, cause) {
      const e = this.el[id]; if (!e || !e.closed) return;
      const amps = this.ampsThrough(id);
      e.closed = false; e.ops++;
      if (id.startsWith('cb.C')) this.cap[id.slice(3)].lastOpen = this.t;
      if (/^cb\.F\d$/.test(id)) this.fdr[id.slice(3)].tripped = true;
      this.solve(0);
      this.emit({ type: 'trip', id, cause, amps, arc: clamp(amps / 700, 0.3, 1), name: e.name });
      this.setAlarm('prot', true, `Protection operated: ${e.name} (${cause})`, 'bad');
    }
    ampsThrough(id) {
      if (/^cb\.F\d$/.test(id)) return this.fdr[id.slice(3)].amps;
      if (id === 'cb.T1L' || id === 'cb.T1H') return this.tx.T1.amps * (id.endsWith('H') ? 1 / 3 : 1);
      if (id === 'cb.T2L' || id === 'cb.T2H') return this.tx.T2.amps * (id.endsWith('H') ? 1 / 3 : 1);
      if (id === 'cb.BAB' || id === 'cb.BBC') { const b = id === 'cb.BAB' ? 'B' : 'B'; return this.busAmps(b); }
      if (id.startsWith('cb.C')) return this.cap[id.slice(3)].mvar * 1000 / (1.732 * 11);
      return 0;
    }
    busAmps(b) { return FEEDERS.filter(f => f.bus === b).reduce((s, f) => s + this.fdr[f.id].amps, 0); }
    // -- topology
    islands() {   // union of 11 kV buses through closed ties
      const p = { A: 'A', B: 'B', C: 'C' }, find = x => (p[x] === x ? x : (p[x] = find(p[x])));
      if (this.el['cb.BAB'].closed) p[find('A')] = find('B');
      if (this.el['cb.BBC'].closed) p[find('B')] = find('C');
      return find;
    }
    islandOf(b) { return this.islands()(b); }
    islandBuses(i) { const f = this.islands(); return ['A', 'B', 'C'].filter(b => f(b) === i); }
    islandTx(i) {   // transformers actually supplying that island
      const f = this.islands(), out = [];
      if (this.tx.T1.live && this.el['cb.T1L'].closed && f('A') === i) out.push('T1');
      if (this.tx.T2.live && this.el['cb.T2L'].closed && f('C') === i) out.push('T2');
      return out;
    }
    islandFeeders(i) { const bs = this.islandBuses(i); return FEEDERS.filter(f => bs.includes(f.bus)).map(f => f.id); }

    solve(dt) {
      const g = this.grid;
      // 33 kV side
      const b33 = (g.L1 && this.el['cb.L1'].closed) || (g.L2 && this.el['cb.L2'].closed);
      this.tx.T1.live = b33 && this.el['cb.T1H'].closed;
      this.tx.T2.live = b33 && this.el['cb.T2H'].closed;
      // loads
      if (dt && this.drift) for (const f of Object.values(this.fdr)) f.scale = clamp(f.scale + (this.rnd() - 0.5) * 0.01 * dt * 4, 0.85, 1.15);
      const find = this.islands();
      let totP = 0, totQ = 0;
      for (const b of ['A', 'B', 'C']) this.bus[b].live = false;
      for (const T of Object.values(this.tx)) { T.mw = 0; T.mvar = 0; T.amps = 0; T.load = 0; T.circ = 0; }
      const seen = new Set();
      for (const b of ['A', 'B', 'C']) {
        const i = find(b); if (seen.has(i)) continue; seen.add(i);
        const txs = this.islandTx(i), buses = this.islandBuses(i), live = txs.length > 0;
        let P = 0, Q = 0;
        for (const f of this.islandFeeders(i)) {
          const F = this.fdr[f];
          F.live = live && this.el['cb.' + f].closed;
          F.mw = F.live ? F.p * F.scale * this.loadScale : 0; F.mvar = F.live ? F.q * F.scale * this.loadScale : 0;
          P += F.mw; Q += F.mvar;
        }
        // first pass voltage without caps, then caps at that voltage
        const tap = txs.length ? txs.reduce((s, k) => s + this.tx[k].tap, 0) / txs.length : TAP_NOM;
        const v0 = g.pu * (1 + (tap - TAP_NOM) * TAP_STEP);
        let capQ = 0;
        for (const [k, c] of Object.entries(this.cap)) {
          const on = live && this.el['cb.' + k].closed && buses.includes(c.bus);
          c.mvar = on ? CAP_MVAR * v0 * v0 : 0; capQ += c.mvar;
        }
        const n = Math.max(1, txs.length), Qn = Q - capQ;
        const drop = (R_TX * P + X_TX * Qn) / (n * TX_MVA);
        const pu = live ? v0 - drop - 0.02 * (totP / 40) : 0;
        for (const bb of buses) { this.bus[bb].live = live; this.bus[bb].kv = live ? 11 * pu : 0; }
        for (const f of this.islandFeeders(i)) {
          const F = this.fdr[f];
          F.amps = F.live ? Math.hypot(F.mw, F.mvar) * 1000 / (1.732 * Math.max(1, 11 * pu)) : 0;
          if (F.live && F.fault) F.amps = 4200 + this.rnd() * 300;
        }
        if (txs.length === 2 && Math.abs(this.tx.T1.tap - this.tx.T2.tap) > 0) this.tx.T1.circ = this.tx.T2.circ = Math.abs(this.tx.T1.tap - this.tx.T2.tap) * 55;
        for (const k of txs) {
          const T = this.tx[k];
          T.mw = P / n; T.mvar = Qn / n;
          const fltA = this.islandFeeders(i).reduce((s, f) => s + (this.fdr[f].fault && this.fdr[f].live ? this.fdr[f].amps : 0), 0) / n;
          T.amps = Math.hypot(T.mw, T.mvar) * 1000 / (1.732 * Math.max(1, 11 * pu)) + (T.circ || 0) + fltA;
          T.load = Math.hypot(T.mw, T.mvar) / TX_MVA;
        }
        totP += P; totQ += Qn;
      }
      this.bus.b33.live = b33;
      this.bus.b33.kv = b33 ? 33 * (g.pu - (0.01 * totP + 0.04 * totQ) / 60) : 0;
      this.totMW = totP; this.totMVAr = totQ; this.pf = totP ? totP / Math.hypot(totP, totQ) : 1;
      // frequency (grid-wide, we only watch it)
      if (dt) { g.hz += (g.hzTarget - g.hz) * Math.min(1, dt * 0.5) + (this.drift ? (this.rnd() - 0.5) * 0.004 : 0); }
    }

    tick(dt) {
      this.t += dt;
      // tap changers finish moving
      for (const [k, T] of Object.entries(this.tx)) if (T.busy > 0) {
        T.busy -= dt;
        if (T.busy <= 0) { T.busy = 0; T.tap = clamp(T.tap + T.pending, 1, TAP_MAX); this.emit({ type: 'tap', id: 'tap.' + k, tx: k, tap: T.tap, done: true }); }
      }
      this.solve(dt);
      // transformer thermal model (time compressed: tau 40 s)
      for (const [k, T] of Object.entries(this.tx)) {
        const target = 30 + 70 * Math.pow(T.live ? T.load : 0, 1.6) + (T.circ || 0) * 0.05;
        T.temp += (target - T.temp) * Math.min(1, dt / 40);
        if (T.temp > TEMP_TRIP && (this.el['cb.' + k + 'L'].closed || this.el['cb.' + k + 'H'].closed)) {
          this.trip('cb.' + k + 'L', 'Winding over-temperature'); this.trip('cb.' + k + 'H', 'Winding over-temperature');
        }
        this.setAlarm('temp' + k, T.temp > TEMP_ALARM, `${k} winding temperature high (${T.temp.toFixed(0)} °C)`, 'warn');
      }
      // feeder overcurrent + backup
      for (const F of Object.values(this.fdr)) {
        if (F.live && F.amps > OC_PICKUP) {
          F.ocT += dt;
          if (F.ocT >= OC_TIME && !F.stuck) { this.trip('cb.' + F.id, 'Overcurrent'); F.ocT = 0; }
          else if (F.stuck && F.ocT >= BACKUP_TIME) {   // breaker fail: clear the bus
            F.ocT = 0;
            this.setAlarm('cbf' + F.id, true, `${F.id} breaker FAILED to trip -- backup protection operated`, 'bad');
            const i = this.islandOf(F.bus), txs = this.islandTx(i);
            if (F.bus === 'B') { this.trip('cb.BAB', 'Backup (CB fail ' + F.id + ')'); this.trip('cb.BBC', 'Backup (CB fail ' + F.id + ')'); }
            else if (txs.includes(F.bus === 'A' ? 'T1' : 'T2')) this.trip(F.bus === 'A' ? 'cb.T1L' : 'cb.T2L', 'Backup (CB fail ' + F.id + ')');
          }
        } else F.ocT = 0;
      }
      // standing alarms
      for (const b of ['A', 'B', 'C']) {
        const pu = this.bus[b].kv / 11;
        this.setAlarm('dead' + b, !this.bus[b].live, `Bus ${b} DEAD`, 'bad');
        this.setAlarm('uv' + b, this.bus[b].live && pu < 0.95, `Bus ${b} undervoltage (${(pu * 100).toFixed(1)} %)`, 'warn');
        this.setAlarm('ov' + b, this.bus[b].live && pu > 1.06, `Bus ${b} overvoltage (${(pu * 100).toFixed(1)} %)`, 'warn');
      }
      this.setAlarm('sup33', !this.bus.b33.live, 'Loss of 33 kV supply', 'bad');
      this.setAlarm('par', this.tx.T1.circ > 0, `T1/T2 paralleled off-tap -- circulating current ${Math.round(this.tx.T1.circ)} A`, 'warn');
      this.setAlarm('byp', this.bypass, 'Interlock BYPASS active', 'warn');
      this.setAlarm('local', this.local, 'Substation in LOCAL control (SCADA blocked)', 'info');
      this.setAlarm('uf', this.grid.hz < 49.85, `Under-frequency ${this.grid.hz.toFixed(2)} Hz`, 'warn');
    }
    setAlarm(k, on, text, level) {
      const a = this.alarms[k];
      if (on && !a) { this.alarms[k] = { k, text, level, at: this.t, acked: false }; this.emit({ type: 'alarm', k, on: true, text, level }); }
      else if (on && a) a.text = text;
      else if (!on && a) { delete this.alarms[k]; this.emit({ type: 'alarm', k, on: false, text: a.text, level }); }
    }
    ackAlarms() { Object.values(this.alarms).forEach(a => { a.acked = true; }); if (this.alarms.prot) delete this.alarms.prot; Object.keys(this.alarms).filter(k => k.startsWith('cbf')).forEach(k => delete this.alarms[k]); this.emit({ type: 'ack' }); }
    // -- the common view the SLD draws from (a remote view is built from DNP3 points with the same shape)
    view() {
      const v = { el: {}, bus: {}, tx: {}, fdr: {}, cap: {}, hz: this.grid.hz, totMW: this.totMW, totMVAr: this.totMVAr, pf: this.pf, local: this.local, bypass: this.bypass, alarms: Object.values(this.alarms), grid: { L1: this.grid.L1, L2: this.grid.L2 } };
      for (const [k, e] of Object.entries(this.el)) v.el[k] = { closed: e.closed, name: e.name };
      for (const [k, b] of Object.entries(this.bus)) v.bus[k] = { live: b.live, kv: b.kv };
      for (const [k, T] of Object.entries(this.tx)) v.tx[k] = { tap: T.tap, temp: T.temp, mw: T.mw, mvar: T.mvar, amps: T.amps, live: T.live, busy: T.busy, load: T.load };
      for (const [k, F] of Object.entries(this.fdr)) v.fdr[k] = { amps: F.amps, mw: F.mw, mvar: F.mvar, live: F.live, fault: F.fault, name: F.name };
      for (const [k, c] of Object.entries(this.cap)) v.cap[k] = { mvar: c.mvar, live: this.bus[c.bus].live && this.el['cb.' + k].closed, left: Math.max(0, CAP_DISCHARGE - (this.t - c.lastOpen)) };
      return v;
    }
    snapshot() { return { el: Object.fromEntries(Object.entries(this.el).map(([k, e]) => [k, e.closed])), tap: [this.tx.T1.tap, this.tx.T2.tap] }; }
  }
  // a tiny helper so a trip triggered inside operate() happens after the 'op' event has been handled
  function setTimeout0(fn, ms, sub) { if (typeof setTimeout === 'function' && !sub.sync) setTimeout(fn, ms); else fn(); }

  // ------------------------------------------------------------------ point map
  // F1 first: the NUC dashboard's DNP3 MASTER page treats BI 0 / BO 0 as "the breaker", so its TRIP/CLOSE switch F1 here
  const CBS = ['cb.F1', 'cb.F2', 'cb.F3', 'cb.F4', 'cb.F5', 'cb.F6', 'cb.C1', 'cb.C2', 'cb.BAB', 'cb.BBC', 'cb.T1L', 'cb.T2L', 'cb.T1H', 'cb.T2H', 'cb.L1', 'cb.L2'];
  const POINTS = {
    bi: [
      ...CBS.map(id => ({ id, name: id.slice(3) + ' CB closed', get: s => +s.el[id].closed })),
      ...FEEDERS.map(f => ({ id: 'es.' + f.id, name: f.id + ' earth switch closed', get: s => +s.el['es.' + f.id].closed })),
      { id: 'al.prot', name: 'Protection operated', get: s => +!!s.alarms.prot },
      { id: 'al.tempT1', name: 'T1 winding temp alarm', get: s => +!!s.alarms.tempT1 },
      { id: 'al.tempT2', name: 'T2 winding temp alarm', get: s => +!!s.alarms.tempT2 },
      { id: 'al.deadA', name: 'Bus A dead', get: s => +!s.bus.A.live },
      { id: 'al.deadB', name: 'Bus B dead', get: s => +!s.bus.B.live },
      { id: 'al.deadC', name: 'Bus C dead', get: s => +!s.bus.C.live },
      { id: 'al.local', name: 'Local control selected', get: s => +s.local },
      { id: 'al.bypass', name: 'Interlock bypass on', get: s => +s.bypass },
      { id: 'al.sup33', name: '33 kV supply lost', get: s => +!s.bus.b33.live },
      { id: 'al.grid1', name: 'Line L1 33 kV source available', get: s => +s.grid.L1 },
      { id: 'al.grid2', name: 'Line L2 33 kV source available', get: s => +s.grid.L2 },
    ],
    bo: [
      ...CBS.map(id => ({ id, name: id.slice(3) + ' CB trip/close', how: 'TRIP 0x81 opens, CLOSE 0x41 closes' })),
      { id: 'tap.T1', name: 'T1 tap raise/lower', how: 'CLOSE 0x41 raises, TRIP 0x81 lowers' },
      { id: 'tap.T2', name: 'T2 tap raise/lower', how: 'CLOSE 0x41 raises, TRIP 0x81 lowers' },
      { id: 'reset', name: 'Alarm reset', how: 'PULSE ON 0x01' },
    ],
    // raw = value x scale on the wire; db = deadband in raw counts (class 2 events)
    ai: [
      { id: 'kv.b33', name: '33 kV bus voltage', unit: 'kV', scale: 100, db: 20, get: s => s.bus.b33.kv },
      { id: 'kv.A', name: 'Bus A voltage', unit: 'kV', scale: 100, db: 6, get: s => s.bus.A.kv },
      { id: 'kv.B', name: 'Bus B voltage', unit: 'kV', scale: 100, db: 6, get: s => s.bus.B.kv },
      { id: 'kv.C', name: 'Bus C voltage', unit: 'kV', scale: 100, db: 6, get: s => s.bus.C.kv },
      { id: 'mw.T1', name: 'T1 active power', unit: 'MW', scale: 100, db: 20, get: s => s.tx.T1.mw },
      { id: 'mvar.T1', name: 'T1 reactive power', unit: 'MVAr', scale: 100, db: 20, get: s => s.tx.T1.mvar },
      { id: 'mw.T2', name: 'T2 active power', unit: 'MW', scale: 100, db: 20, get: s => s.tx.T2.mw },
      { id: 'mvar.T2', name: 'T2 reactive power', unit: 'MVAr', scale: 100, db: 20, get: s => s.tx.T2.mvar },
      ...FEEDERS.map(f => ({ id: 'a.' + f.id, name: f.id + ' current', unit: 'A', scale: 1, db: 8, get: s => s.fdr[f.id].amps })),
      { id: 'tap.T1', name: 'T1 tap position', unit: 'tap', scale: 1, db: 0, get: s => s.tx.T1.tap },
      { id: 'tap.T2', name: 'T2 tap position', unit: 'tap', scale: 1, db: 0, get: s => s.tx.T2.tap },
      { id: 'temp.T1', name: 'T1 winding temperature', unit: '°C', scale: 10, db: 10, get: s => s.tx.T1.temp },
      { id: 'temp.T2', name: 'T2 winding temperature', unit: '°C', scale: 10, db: 10, get: s => s.tx.T2.temp },
      { id: 'hz', name: 'Frequency', unit: 'Hz', scale: 100, db: 2, get: s => s.grid.hz },
      { id: 'mw.tot', name: 'Total active power', unit: 'MW', scale: 100, db: 30, get: s => s.totMW },
      { id: 'mvar.tot', name: 'Total reactive power', unit: 'MVAr', scale: 100, db: 30, get: s => s.totMVAr },
      { id: 'mvar.C1', name: 'Cap bank C1 output', unit: 'MVAr', scale: 100, db: 20, get: s => s.cap.C1.mvar },
      { id: 'mvar.C2', name: 'Cap bank C2 output', unit: 'MVAr', scale: 100, db: 20, get: s => s.cap.C2.mvar },
    ],
    ctr: [...CBS.filter(id => /F\d|BAB|BBC|C\d/.test(id)).map(id => ({ id, name: id.slice(3) + ' CB operations', get: s => s.el[id].ops }))],
  };
  const pointIndex = pts => { const ix = {}; for (const k of Object.keys(pts)) { ix[k] = {}; pts[k].forEach((p, i) => { ix[k][p.id] = i; }); } return ix; };
  const idx = pointIndex(POINTS);

  // ------------------------------------------------------------------ plant adapter
  // Everything the Outstation needs from the plant behind it, so one outstation serves any plant (this substation,
  // js/wivenhoe.js's pumped-storage station). points = { bi, bo, ai, ctr, ao? } each [{ id, name, get(model), ... }];
  // a plant with a dnp3Plant() method supplies its own, else the model is taken to be a Substation.
  //   validate(p, code, selecting) -> CROB status (0 = go ahead)    execute(p, code) -> CROB status
  //   aoValidate(p, raw, selecting) / aoExecute(p, raw) -> status   (only if points.ao)
  //   boValue(p) -> 0/1 for g10     local() / trouble() -> IIN bits     onChange(fn) -> unsubscribe
  const actionOf = (p, code) => {
    const tc = code & 0xC0, op = code & 0x0F, on = tc === 0x40 || (!tc && op === 3);
    if (p.id.startsWith('tap.')) return on ? 'raise' : 'lower';
    return on ? 'close' : 'open';
  };
  function substationPlant(sub) {
    return {
      model: sub, points: POINTS,
      local: () => sub.local,
      trouble: () => Object.keys(sub.alarms).some(k => k.startsWith('cbf')),
      boValue: p => (p.id.startsWith('cb.') ? +sub.el[p.id].closed : 0),
      onChange: fn => sub.on(e => { if (e.type === 'op' || e.type === 'trip' || e.type === 'tap' || e.type === 'alarm') fn(); }),
      validate(p, code, selecting) {
        const tc = code & 0xC0, op = code & 0x0F;
        if (p.id === 'reset') return op === 1 ? 0 : 3;
        if (!(tc === 0x40 || tc === 0x80 || op === 3 || op === 4)) return 3;   // FORMAT ERROR: needs trip/close or latch
        if (selecting) {   // check the interlocks at select time too, as real RTUs do
          const why = p.id.startsWith('tap') ? null : sub.check(p.id, actionOf(p, code));
          if (why && !/Already/.test(why)) return 15;
        }
        return 0;
      },
      execute(p, code) {
        if (p.id === 'reset') { sub.ackAlarms(); return 0; }
        const r = sub.operate(p.id, actionOf(p, code), 'scada');
        if (r.ok) return 0;
        if (/Already/.test(r.reason || '')) return 14;   // ALREADY COMPLETE
        return r.status || 15;
      },
    };
  }

  // ------------------------------------------------------------------ shared link handling
  class Station {
    constructor(o) {
      this.addr = o.addr; this.send = () => {}; this.tap = () => {}; this.listeners = [];
      this.ra = new D.Reassembler(); this.trSeq = 0; this.log = []; this.stats = { tx: 0, rx: 0, crc: 0, ignored: 0, timeouts: 0 };
    }
    on(fn) { this.listeners.push(fn); }
    emit(e) { for (const f of this.listeners) try { f(e); } catch (err) { console.error(err); } }
    note(dir, text, hex) { const e = { at: Date.now(), dir, text, hex }; this.log.push(e); if (this.log.length > 300) this.log.shift(); this.emit({ type: 'log', entry: e }); }
    xmit(dest, app, label, dirFromMaster) {
      const frames = D.buildFrames(dest, this.addr, app, { dir: dirFromMaster, trSeq: this.trSeq });
      this.trSeq = (this.trSeq + frames.length) & 0x3F;
      for (const f of frames) { this.stats.tx++; this.tap('tx', f, label); this.send(f); }
      this.note('tx', label + (frames.length > 1 ? ` (${frames.length} segments)` : ''), D.hex(frames[0]));
    }
    linkReply(dest, fn, dirFromMaster) { const f = D.buildLink({ dest, src: this.addr, fn, prm: false, dir: dirFromMaster }); this.stats.tx++; this.tap('tx', f, 'link ' + D.LINK_SEC[fn]); this.send(f); }
    // returns { L, app } for a whole fragment addressed to us, or null
    accept(frame) {
      const L = D.parseLink(frame);
      this.stats.rx++;
      if (!L.ok) { this.stats.crc++; this.note('err', 'Frame dropped: ' + L.error, D.hex(frame)); this.emit({ type: 'linkerr', error: L.error }); return null; }
      if (L.dest !== this.addr && L.dest < 0xFFFD) { this.stats.ignored++; this.note('err', `Ignored: frame for address ${L.dest}, I am ${this.addr}`, D.hex(frame)); this.emit({ type: 'wrongaddr', dest: L.dest }); return null; }
      this.lastRxAt = now();   // the RTU's own "is my master still there" (Wivenhoe's BI0012)
      this.tap('rx', frame);
      if (L.prm && L.fn === 9) { this.note('rx', 'REQUEST LINK STATUS', D.hex(frame)); this.linkReply(L.src, 11, !this.isOutstation ? true : false); return null; }
      if (L.prm && (L.fn === 0 || L.fn === 2)) { this.note('rx', L.fnName, D.hex(frame)); this.linkReply(L.src, 0, !this.isOutstation); return null; }
      if (!L.prm) { this.note('rx', 'Link ' + L.fnName, D.hex(frame)); this.emit({ type: 'link', fn: L.fn, src: L.src }); return null; }
      if (L.prm && L.fn === 3) this.linkReply(L.src, 0, !this.isOutstation);   // confirmed user data: ACK it
      const app = this.ra.feed(L.user);
      return app ? { L, app } : null;
    }
  }

  // ------------------------------------------------------------------ outstation
  class Outstation extends Station {
    constructor(sub, o = {}) {
      super({ addr: o.addr == null ? 4 : o.addr });
      this.isOutstation = true;
      this.plant = o.plant || (sub.dnp3Plant ? sub.dnp3Plant() : substationPlant(sub));
      this.P = this.plant.points; this.sub = this.plant.model; this.master = o.master == null ? 1 : o.master;
      this.cfg = { biStatic: 2, biEvent: 2, aiStatic: 1, aiEvent: 3, selectTimeout: 10000, unsolRetry: 5000, maxEvents: 100, ...(o.cfg || {}) };
      this.iin = (1 << D.IIN.DEVICE_RESTART) | (1 << D.IIN.NEED_TIME);
      this.clockOffset = o.clockOffset == null ? 4217 : o.clockOffset;   // ms the outstation clock is wrong by
      this.driftPpm = o.driftPpm == null ? 250 : o.driftPpm;
      this.events = []; this.pending = null; this.select = null; this.unsol = !!o.unsol; this.unsolPending = null; this.appSeq = 0; this.unsSeq = 0;
      const P = this.P, m = this.sub;
      this.last = { bi: P.bi.map(p => p.get(m)), ai: P.ai.map(p => Math.round(p.get(m) * p.scale)), ctr: P.ctr.map(p => p.get(m)) };
      this.recorded = null; this.lastDrift = now(); this.paused = false;
      // stamp events the moment plant changes (as an RTU's SOE does), not on the next UI tick
      this.unsub = this.plant.onChange(() => this.scan(true));
    }
    detach() { if (this.unsub) this.unsub(); }
    clock() { return now() + this.clockOffset; }
    // called by the UI each sim tick: drift the clock, turn changes into timestamped events, maybe send unsolicited
    scan(eventOnly) {
      const t = now(); this.clockOffset += (t - this.lastDrift) * this.driftPpm / 1e6; this.lastDrift = t;
      const s = this.sub, P = this.P, ts = this.clock();
      P.bi.forEach((p, i) => { const v = p.get(s); if (v !== this.last.bi[i]) { this.last.bi[i] = v; this.addEvent({ type: 'bi', cls: 1, index: i, value: v, time: ts }); } });
      P.ai.forEach((p, i) => { const raw = Math.round(p.get(s) * p.scale); if (Math.abs(raw - this.last.ai[i]) > p.db) { this.last.ai[i] = raw; this.addEvent({ type: 'ai', cls: 2, index: i, value: raw, time: ts }); } });
      P.ctr.forEach((p, i) => { const v = p.get(s); if (v !== this.last.ctr[i] && Math.abs(v - this.last.ctr[i]) > (p.db || 0)) { this.last.ctr[i] = v; this.addEvent({ type: 'ctr', cls: 3, index: i, value: v, time: ts }); } });
      if (eventOnly) return;
      if (this.unsol && this.events.length && !this.unsolPending && !this.pending && !this.paused && !(this.unsolBackoff > t)) this.sendUnsol();
      if (this.unsolPending && t - this.unsolPending.at > this.cfg.unsolRetry) {
        if (++this.unsolPending.tries > 3) { this.note('err', 'Unsolicited not confirmed after 3 retries -- holding events for the next poll'); this.unsolPending = null; this.unsolBackoff = t + 30000; }
        else { this.unsolPending.at = t; this.xmit(this.master, this.unsolPending.app, `UNSOLICITED retry ${this.unsolPending.tries}`, false); }
      }
    }
    addEvent(e) {
      // cfg.mostRecent = ['ai', 'ctr']: those points keep only their latest unsent event (DNP3's "most recent" event
      // mode) -- a ramping analog then costs one event per poll, not one per deadband step. BIs always keep every change.
      if (this.cfg.mostRecent && this.cfg.mostRecent.includes(e.type)) {
        const held = new Set([...(this.pending ? this.pending.evs : []), ...(this.unsolPending ? this.unsolPending.evs : [])]);
        const k = this.events.findIndex(x => x.type === e.type && x.index === e.index && !held.has(x));
        if (k >= 0) this.events.splice(k, 1);
      }
      // cfg.classMax = { 1: n, 2: n, 3: n } gives each class its own buffer (oldest of that class goes first)
      const cap = this.cfg.classMax && this.cfg.classMax[e.cls];
      if (cap) { const same = this.events.filter(x => x.cls === e.cls); if (same.length >= cap) { this.events.splice(this.events.indexOf(same[0]), 1); this.iin |= 1 << D.IIN.EVENT_OVERFLOW; this.emit({ type: 'overflow', cls: e.cls }); } }
      if (this.events.length >= this.cfg.maxEvents) { this.events.shift(); this.iin |= 1 << D.IIN.EVENT_OVERFLOW; }
      this.events.push(e); this.emit({ type: 'event', ev: e });
    }
    curIin() {
      let iin = this.iin & ~0x0E;
      for (const e of this.events) iin |= 1 << e.cls;
      if (this.plant.local()) iin |= 1 << D.IIN.LOCAL_CONTROL; else iin &= ~(1 << D.IIN.LOCAL_CONTROL);
      if (this.plant.trouble()) iin |= 1 << D.IIN.DEVICE_TROUBLE; else iin &= ~(1 << D.IIN.DEVICE_TROUBLE);
      return iin;
    }
    staticObjects(groups) {
      const s = this.sub, P = this.P, parts = [];
      if (groups.includes(1)) parts.push(D.binaryStatic(P.bi.map(p => ({ value: p.get(s) })), this.cfg.biStatic));
      if (groups.includes(10)) parts.push(D.boStatus(P.bo.map(p => ({ value: this.plant.boValue(p) }))));
      if (groups.includes(20)) parts.push(D.counterStatic(P.ctr.map(p => ({ value: p.get(s) }))));
      if (groups.includes(30)) parts.push(D.analogStatic(P.ai.map(p => ({ value: this.cfg.aiStatic === 5 ? p.get(s) * p.scale : Math.round(p.get(s) * p.scale) })), this.cfg.aiStatic));
      if (groups.includes(40) && P.ao) parts.push(D.aoStatus(P.ao.map(p => ({ value: Math.round(p.get(s) * p.scale) }))));
      return D.cat(...parts);
    }
    eventObjects(evs) {
      const bi = evs.filter(e => e.type === 'bi'), ai = evs.filter(e => e.type === 'ai'), ct = evs.filter(e => e.type === 'ctr');
      return D.cat(D.events(2, this.cfg.biEvent, bi), D.events(32, this.cfg.aiEvent, ai), D.events(22, 5, ct));
    }
    sendUnsol() {
      const evs = this.events.slice(0, 12);
      const app = D.appResponse(D.FC.UNSOLICITED_RESPONSE, this.curIin(), this.eventObjects(evs), { con: true, uns: true, seq: this.unsSeq });
      this.unsolPending = { app, evs, seq: this.unsSeq, at: now(), tries: 0 };
      this.xmit(this.master, app, `UNSOLICITED ${evs.length} event(s)`, false);
    }
    receive(frame) {
      if (this.paused) return;
      const got = this.accept(frame); if (!got) return;
      const t0 = now();
      const { L, app } = got;
      const pa = D.parseApp(app);
      if (!pa.ok && !pa.objects.length) { this.note('err', 'Bad application fragment: ' + pa.error); return; }
      this.note('rx', `${pa.fcName}${pa.objects.length ? ' ' + pa.objects.map(o => `g${o.g}v${o.v}`).join(' ') : ''}`, D.hex(frame));
      this.master = L.src;
      const seq = pa.ac.seq, fc = pa.fc, reply = (objs, o = {}) => this.respond(seq, objs, o);
      if (fc === D.FC.CONFIRM) {
        if (pa.ac.uns && this.unsolPending && this.unsolPending.seq === seq) { this.dropEvents(this.unsolPending.evs); this.unsolPending = null; this.unsSeq = (this.unsSeq + 1) & 0x0F; this.emit({ type: 'confirmed', uns: true }); }
        else if (!pa.ac.uns && this.pending && this.pending.seq === seq) { this.dropEvents(this.pending.evs); this.pending = null; this.emit({ type: 'confirmed' }); }
        return;
      }
      if (fc === D.FC.READ) {
        let groups = [], evs = [], unknown = false;
        for (const o of pa.objects) {
          if (o.g === 60) { if (o.v === 1) groups.push(...(this.cfg.lean ? [1, 30] : [1, 10, 20, 30, 40])); else evs.push(...this.events.filter(e => e.cls === o.v - 1)); }
          else if ([1, 10, 20, 30].includes(o.g) || (o.g === 40 && this.P.ao)) groups.push(o.g);
          else if (o.g === 2) evs.push(...this.events.filter(e => e.type === 'bi'));
          else if (o.g === 32) evs.push(...this.events.filter(e => e.type === 'ai'));
          else if (o.g === 22) evs.push(...this.events.filter(e => e.type === 'ctr'));
          else if (o.g === 50 && o.v === 1) { reply(new D.W().u8(50).u8(1).u8(0x07).u8(1).u48(this.clock()).out()); return; }
          else unknown = true;
        }
        evs = [...new Set(evs)].slice(0, this.cfg.maxEvPerReply || (this.cfg.lean ? 8 : 40));   // lean (RF): small replies, the rest wait for the next poll
        // binary objects first: scripts/dnp3.py (the NUC dashboard's decoder) stops at the first object it doesn't know,
        // so BI events + BI statics must come before analogs / counters for its breaker display to work
        const gs = [...new Set(groups)];
        const objs = D.cat(this.eventObjects(evs.filter(e => e.type === 'bi')), this.staticObjects(gs.filter(g => g === 1)),
          this.eventObjects(evs.filter(e => e.type !== 'bi')), this.staticObjects(gs.filter(g => g !== 1)));
        if (evs.length) this.pending = { seq, evs };
        reply(objs, { con: evs.length > 0, iinExtra: unknown ? 1 << D.IIN.OBJECT_UNKNOWN : 0 });
        return;
      }
      if (fc === D.FC.SELECT || fc === D.FC.OPERATE || fc === D.FC.DIRECT_OPERATE || fc === D.FC.DIRECT_OPERATE_NR) {
        const crobs = [], aos = []; let aoV = 2;
        for (const o of pa.objects) {
          if (o.g === 12 && o.v === 1) crobs.push(...o.points);
          if (o.g === 41 && (o.v === 1 || o.v === 2)) { aos.push(...o.points); aoV = o.v; }
        }
        if (!crobs.length && !aos.length) { reply(null, { iinExtra: 1 << D.IIN.OBJECT_UNKNOWN }); return; }
        const objHex = D.hex(app.subarray(2)), all = [...crobs, ...aos];
        for (const c of crobs) c.status = this.controlStatus(c, fc, seq, objHex);
        for (const a of aos) a.status = this.controlStatus(a, fc, seq, objHex, true);
        if (fc === D.FC.SELECT) { if (all.every(c => c.status === 0)) this.select = { seq, objHex, at: now() }; }
        else this.select = null;
        if (fc !== D.FC.SELECT) {
          for (const c of crobs) if (c.status === 0) c.status = this.execute(c);
          for (const a of aos) if (a.status === 0) a.status = this.plant.aoExecute(this.P.ao[a.index], a.value);
        }
        if (fc !== D.FC.DIRECT_OPERATE_NR) reply(D.cat(crobs.length ? D.crobEcho(crobs) : null, aos.length ? D.aoEcho(aos, aoV) : null));
        return;
      }
      if (fc === D.FC.WRITE) {
        let bad = false;
        for (const o of pa.objects) {
          if (o.g === 50 && (o.v === 1 || o.v === 3) && o.points[0]) {
            const want = o.v === 1 ? o.points[0].time : o.points[0].time + (now() - (this.recorded || now()));
            const before = this.clock() - now();
            this.clockOffset = want - now() + (o.v === 1 ? (now() - t0) : 0);
            this.iin &= ~(1 << D.IIN.NEED_TIME);
            this.note('info', `Clock set (${o.v === 1 ? 'g50v1 absolute time' : 'g50v3 last recorded time'}): was ${fmtOff(before)}, now ${fmtOff(this.clockOffset)}`);
            this.emit({ type: 'clockset', before, after: this.clockOffset, how: o.v });
          } else if (o.g === 80 && o.v === 1) {
            for (const p of o.points) if (!p.value && p.index === 7) this.iin &= ~(1 << D.IIN.DEVICE_RESTART);
            this.emit({ type: 'iinclear' });
          } else bad = true;
        }
        reply(null, { iinExtra: bad ? 1 << D.IIN.PARAM_ERROR : 0 });
        return;
      }
      if (fc === D.FC.DELAY_MEASURE) {
        const turnaround = Math.max(0, Math.round(now() - t0 + (this.turnaroundMs || 0)));
        reply(D.delayFine(turnaround));
        return;
      }
      if (fc === D.FC.RECORD_CURRENT_TIME) { this.recorded = now(); reply(null); return; }
      if (fc === D.FC.ENABLE_UNSOLICITED || fc === D.FC.DISABLE_UNSOLICITED) { this.unsol = fc === D.FC.ENABLE_UNSOLICITED; this.emit({ type: 'unsol', on: this.unsol }); reply(null); return; }
      if (fc === D.FC.COLD_RESTART || fc === D.FC.WARM_RESTART) {
        reply(new D.W().u8(52).u8(fc === D.FC.COLD_RESTART ? 1 : 2).u8(0x07).u8(1).u16(fc === D.FC.COLD_RESTART ? 2 : 500).out());
        this.iin |= (1 << D.IIN.DEVICE_RESTART) | (1 << D.IIN.NEED_TIME); this.events = []; this.select = null; this.unsol = false;
        this.emit({ type: 'restart', cold: fc === D.FC.COLD_RESTART });
        return;
      }
      reply(null, { iinExtra: 1 << D.IIN.NO_FUNC });
    }
    dropEvents(evs) {
      const set = new Set(evs); this.events = this.events.filter(e => !set.has(e));
      const cm = this.cfg.classMax, full = cm && [1, 2, 3].some(c => cm[c] && this.events.filter(e => e.cls === c).length >= cm[c]);
      if (this.events.length < this.cfg.maxEvents && !full) this.iin &= ~(1 << D.IIN.EVENT_OVERFLOW);
    }
    respond(seq, objs, o = {}) {
      const app = D.appResponse(D.FC.RESPONSE, this.curIin() | (o.iinExtra || 0), objs, { seq, con: !!o.con });
      const run = () => this.xmit(this.master, app, `RESPONSE${objs && objs.length ? ` ${objs.length} B of objects` : ''}${o.con ? ' (CON)' : ''}`, false);
      if (this.turnaroundMs && typeof setTimeout === 'function') setTimeout(run, this.turnaroundMs); else run();
    }
    controlStatus(c, fc, seq, objHex, isAo) {
      const p = isAo ? (this.P.ao || [])[c.index] : this.P.bo[c.index];
      if (!p) return 4;   // NOT SUPPORTED
      if (this.plant.local(p, isAo)) return 7;   // LOCAL (a plant may still take its own remote/local selector)
      if (fc === D.FC.OPERATE) {
        if (!this.select || ((this.select.seq + 1) & 0x0F) !== seq || this.select.objHex !== objHex) return 2;   // NO SELECT
        if (now() - this.select.at > this.cfg.selectTimeout) return 1;   // TIMEOUT
      }
      return isAo ? this.plant.aoValidate(p, c.value, fc === D.FC.SELECT) : this.plant.validate(p, c.code, fc === D.FC.SELECT);
    }
    execute(c) { return this.plant.execute(this.P.bo[c.index], c.code); }
  }
  const fmtOff = ms => `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(3)} s`;

  // ------------------------------------------------------------------ master
  class Master extends Station {
    constructor(o = {}) {
      super({ addr: o.addr == null ? 1 : o.addr });
      this.dest = o.dest == null ? 4 : o.dest;
      this.timeout = o.timeout || 4000; this.retries = o.retries == null ? 1 : o.retries;
      this.queue = []; this.cur = null; this.seq = 0; this.P = o.points || POINTS;   // P only names points in labels
      this.db = { bi: [], bo: [], ai: [], ctr: [], ao: [], iin: 0, at: 0, events: [] };
      this.autoTime = o.autoTime !== false; this.autoClearRestart = o.autoClearRestart !== false;
    }
    // -- tasks (queued; one outstanding at a time)
    task(t) { this.queue.push(t); this.pump(); return t; }
    integrity() { return this.task({ label: 'Integrity poll (class 1,2,3,0)', fc: D.FC.READ, objs: D.readIntegrity() }); }
    poll(cls) { return this.task({ label: `Event poll class ${cls.join(',')}`, fc: D.FC.READ, objs: D.readClass(cls) }); }
    readGroup(g, v = 0) { return this.task({ label: `Read g${g}v${v}`, fc: D.FC.READ, objs: D.readGroup(g, v) }); }
    readTime() { return this.task({ label: 'Read outstation clock (g50v1)', fc: D.FC.READ, objs: Uint8Array.from([50, 1, 0x07, 1]) }); }
    sbo(bo, code, o = {}) {
      const objs = D.crob(bo, code), name = `${(this.P.bo[bo] || {}).name || 'BO ' + bo} ${D.CROB_NAMES[code] || D.h2(code)}`;
      if (o.skipSelect) return this.task({ label: `OPERATE (no select!) ${name}`, fc: D.FC.OPERATE, objs, ctrl: { bo, code }, seqOverride: (this.seq + 1) & 0x0F });
      return this.task({ label: `SELECT ${name}`, fc: D.FC.SELECT, objs, ctrl: { bo, code }, then: (r, ok) => {
        if (!ok) return;
        const op = () => this.queue.unshift({ label: `OPERATE ${name}`, fc: D.FC.OPERATE, objs, ctrl: { bo, code } });
        if (o.operateDelay) setTimeout(() => { op(); this.pump(); }, o.operateDelay); else op();
      }, sbo: true });
    }
    direct(bo, code, o = {}) {
      const name = `${(this.P.bo[bo] || {}).name || 'BO ' + bo} ${D.CROB_NAMES[code] || D.h2(code)}`;
      return this.task({ label: `${o.nr ? 'DIRECT OPERATE NR' : 'DIRECT OPERATE'} ${name}`, fc: o.nr ? D.FC.DIRECT_OPERATE_NR : D.FC.DIRECT_OPERATE, objs: D.crob(bo, code), ctrl: { bo, code }, noReply: !!o.nr });
    }
    // analog output (g41v2, raw = value x scale): SELECT then OPERATE, or { direct: true }
    setpoint(ao, raw, o = {}) {
      const objs = D.aoBlock(ao, raw), name = `${(this.P.ao && this.P.ao[ao] || {}).name || 'AO ' + ao} = ${raw}`, ctrl = { ao, raw };
      if (o.direct) return this.task({ label: `DIRECT OPERATE ${name}`, fc: D.FC.DIRECT_OPERATE, objs, ctrl });
      return this.task({ label: `SELECT ${name}`, fc: D.FC.SELECT, objs, ctrl, sbo: true,
        then: (r, ok) => { if (ok) this.queue.unshift({ label: `OPERATE ${name}`, fc: D.FC.OPERATE, objs, ctrl }); } });
    }
    clearRestart() { return this.task({ label: 'WRITE g80v1 idx 7 = 0 (clear DEVICE RESTART)', fc: D.FC.WRITE, objs: D.iinClear(7) }); }
    unsolicited(on) { return this.task({ label: `${on ? 'ENABLE' : 'DISABLE'} UNSOLICITED class 1,2,3`, fc: on ? D.FC.ENABLE_UNSOLICITED : D.FC.DISABLE_UNSOLICITED, objs: D.readClass([1, 2, 3]) }); }
    restart(cold) { return this.task({ label: cold ? 'COLD RESTART' : 'WARM RESTART', fc: cold ? D.FC.COLD_RESTART : D.FC.WARM_RESTART, objs: null }); }
    linkStatus() { const f = D.buildLink({ dest: this.dest, src: this.addr, fn: 9, dir: true }); this.stats.tx++; this.tap('tx', f, 'REQUEST LINK STATUS'); this.note('tx', 'REQUEST LINK STATUS (link layer only)', D.hex(f)); this.linkAsk = now(); this.send(f); }
    // Non-LAN time sync (IEEE 1815 "delay measurement"): DELAY MEASURE -> g52v2 turnaround; delay = (rtt - turnaround)/2;
    // WRITE g50v1 = master time + delay. LAN: RECORD CURRENT TIME then WRITE g50v3 = the master's time when it sent that.
    timeSync(method = 'nonlan') {
      const ts = { method, steps: [] }; this.timeSyncState = ts;
      if (method === 'lan') {
        return this.task({ label: 'RECORD CURRENT TIME (LAN time sync)', fc: D.FC.RECORD_CURRENT_TIME, objs: null, onSend: at => { ts.t0 = at; ts.steps.push({ k: 'record', at }); },
          then: (r, ok) => { if (!ok) return; ts.steps.push({ k: 'recorded', at: now() }); this.queue.unshift({ label: 'WRITE g50v3 last recorded time', fc: D.FC.WRITE, objs: D.lastRecordedTimeWrite(ts.t0), then: () => { ts.done = true; this.emit({ type: 'timesync', ts }); } }); } });
      }
      return this.task({ label: 'DELAY MEASURE (time sync step 1)', fc: D.FC.DELAY_MEASURE, objs: null, onSend: at => { ts.t0 = at; ts.steps.push({ k: 'delay-tx', at }); },
        then: (r, ok, pa) => {
          if (!ok) return;
          ts.t3 = now(); const d = pa.objects.find(o => o.g === 52); ts.turn = d && d.points[0] ? d.points[0].value * (d.v === 1 ? 1000 : 1) : 0;
          ts.rtt = ts.t3 - ts.t0; ts.delay = Math.max(0, (ts.rtt - ts.turn) / 2);
          ts.steps.push({ k: 'delay-rx', at: ts.t3, rtt: ts.rtt, turn: ts.turn, delay: ts.delay });
          this.emit({ type: 'timesync', ts });
          this.queue.unshift({ label: 'WRITE g50v1 absolute time (time sync step 2)', fc: D.FC.WRITE, objsFn: () => { ts.t4 = now(); ts.written = ts.t4 + ts.delay; return D.timeWrite(ts.written); }, then: (r2, ok2) => { ts.done = ok2; ts.steps.push({ k: 'write-ok', at: now() }); this.emit({ type: 'timesync', ts }); } });
        } });
    }
    raw(app, label) { return this.task({ label: label || 'Raw request', rawApp: app }); }
    pump() {
      if (this.cur || !this.queue.length) return;
      const t = this.cur = this.queue.shift();
      t.seq = t.seqOverride != null ? t.seqOverride & 0x0F : this.seq;
      this.seq = (t.seq + 1) & 0x0F;
      t.tries = 0;
      this.fire(t);
    }
    fire(t) {
      const objs = t.objsFn ? t.objsFn() : t.objs;
      const app = t.rawApp || D.appRequest(t.fc, objs, { seq: t.seq });
      if (t.onSend) t.onSend(now());
      t.sentAt = now();
      this.xmit(this.dest, app, t.label + (t.tries ? ` (retry ${t.tries})` : ''), true);
      if (t.noReply) { this.cur = null; this.emit({ type: 'done', task: t, ok: true }); this.pump(); return; }
      clearTimeout(t.timer);
      if (typeof setTimeout === 'function') t.timer = setTimeout(() => this.timedOut(t), this.timeout);
    }
    timedOut(t) {
      if (this.cur !== t) return;
      this.stats.timeouts++;
      if (t.tries < this.retries) { t.tries++; this.stats.retries = (this.stats.retries || 0) + 1; this.note('err', `No response in ${this.timeout / 1000} s -- retrying`); this.fire(t); return; }
      this.note('err', `TIMEOUT: ${t.label} -- no response from outstation ${this.dest}`);
      this.cur = null; this.emit({ type: 'timeout', task: t }); this.emit({ type: 'done', task: t, ok: false });
      this.pump();
    }
    receive(frame) {
      const got = this.accept(frame);
      if (!got && this.linkAsk) {
        const L = D.parseLink(frame);
        if (L.ok && !L.prm && L.fn === 11 && L.dest === this.addr) { this.emit({ type: 'linkstatus', rtt: now() - this.linkAsk, src: L.src }); this.linkAsk = 0; }
      }
      if (!got) return;
      const pa = D.parseApp(got.app);
      if (pa.fc !== D.FC.RESPONSE && pa.fc !== D.FC.UNSOLICITED_RESPONSE) return;
      this.db.iin = pa.iin; this.db.at = Date.now();
      this.applyObjects(pa);
      this.note('rx', `${pa.fcName}${pa.ac.uns ? '' : ' seq ' + pa.ac.seq}${pa.iinSet.length ? ' [' + pa.iinSet.map(s => s.replace(/^IIN\d\.\d /, '')).join(', ') + ']' : ''}`, D.hex(frame));
      if (pa.ac.con) this.xmit(got.L.src, D.appRequest(D.FC.CONFIRM, null, { seq: pa.ac.seq, uns: pa.ac.uns }), `CONFIRM${pa.ac.uns ? ' (unsolicited)' : ''} seq ${pa.ac.seq}`, true);
      this.emit({ type: 'db', pa });
      if (pa.fc === D.FC.UNSOLICITED_RESPONSE) return;
      const t = this.cur;
      if (!t || pa.ac.seq !== t.seq) return;
      clearTimeout(t.timer);
      t.rtt = now() - t.sentAt; this.stats.lastRtt = t.rtt;
      let ok = !(pa.iin & 0x0700);   // IIN2.0-2.2: no func / object unknown / param error
      const crobs = pa.objects.filter(o => o.g === 12 || o.g === 41).flatMap(o => o.points);
      if (t.ctrl && crobs.length) {
        const st = crobs[0].status; ok = st === 0;
        this.note(ok ? 'info' : 'err', `${t.label}: ${D.CROB_STATUS[st] || 'status ' + st}`);
        this.emit({ type: 'ctrl', task: t, status: st, ok, sbo: t.fc === D.FC.SELECT });
      }
      this.cur = null;
      this.emit({ type: 'done', task: t, ok, pa });
      if (t.then) t.then(t, ok, pa);
      // the master's housekeeping, as real masters do it: clear restart, set the time when asked
      if (this.autoClearRestart && pa.iin & (1 << D.IIN.DEVICE_RESTART) && !this.queue.some(q => q.fc === D.FC.WRITE)) this.clearRestart();
      if (this.autoTime && pa.iin & (1 << D.IIN.NEED_TIME) && !this.queue.some(q => q.fc === D.FC.DELAY_MEASURE) && t.fc !== D.FC.DELAY_MEASURE && !(t.label || '').includes('time sync')) this.timeSync();
      this.pump();
    }
    applyObjects(pa) {
      const db = this.db;
      for (const o of pa.objects) {
        const tgt = o.g === 1 || o.g === 2 ? 'bi' : o.g === 10 ? 'bo' : o.g === 30 || o.g === 32 ? 'ai' : o.g === 20 || o.g === 22 ? 'ctr' : o.g === 40 ? 'ao' : null;
        if (!tgt) continue;
        for (const p of o.points) {
          db[tgt][p.index] = p.value;
          if (o.cls === 'event') { db.events.push({ g: o.g, v: o.v, index: p.index, value: p.value, time: p.time, rx: Date.now(), timed: o.time !== 'none' }); if (db.events.length > 200) db.events.shift(); }
        }
      }
    }
  }

  // A view (same shape as Substation.view()) built from a master's mirrored points -- draws the REMOTE substation.
  function viewFromPoints(db) {
    const bi = id => db.bi[idx.bi[id]], ai = id => { const p = POINTS.ai[idx.ai[id]]; const raw = db.ai[idx.ai[id]]; return raw == null ? 0 : raw / p.scale; };
    const v = { el: {}, bus: {}, tx: {}, fdr: {}, cap: {}, remote: true, hz: ai('hz'), totMW: ai('mw.tot'), totMVAr: ai('mvar.tot'), alarms: [], local: !!bi('al.local'), bypass: !!bi('al.bypass'), grid: { L1: bi('al.grid1') !== 0, L2: bi('al.grid2') !== 0 } };
    v.pf = v.totMW ? v.totMW / Math.hypot(v.totMW, v.totMVAr) : 1;
    for (const p of POINTS.bi) if (p.id.startsWith('cb.') || p.id.startsWith('es.')) v.el[p.id] = { closed: !!bi(p.id), name: p.name, unknown: bi(p.id) == null };
    for (const b of ['b33', 'A', 'B', 'C']) { const kv = ai('kv.' + b); v.bus[b] = { kv, live: kv > 1 }; }
    for (const k of ['T1', 'T2']) v.tx[k] = { tap: ai('tap.' + k), temp: ai('temp.' + k), mw: ai('mw.' + k), mvar: ai('mvar.' + k), live: v.bus.b33.live && v.el['cb.' + k + 'H'].closed, amps: Math.hypot(ai('mw.' + k), ai('mvar.' + k)) * 1000 / (1.732 * 11), load: Math.hypot(ai('mw.' + k), ai('mvar.' + k)) / TX_MVA };
    for (const f of FEEDERS) v.fdr[f.id] = { amps: ai('a.' + f.id), live: v.bus[f.bus].live && v.el['cb.' + f.id].closed, name: f.name };
    for (const k of ['C1', 'C2']) v.cap[k] = { mvar: ai('mvar.' + k), live: ai('mvar.' + k) > 0.1 };
    if (bi('al.prot')) v.alarms.push({ k: 'prot', text: 'Protection operated', level: 'bad' });
    if (bi('al.tempT1')) v.alarms.push({ k: 'tempT1', text: 'T1 winding temp high', level: 'warn' });
    if (bi('al.tempT2')) v.alarms.push({ k: 'tempT2', text: 'T2 winding temp high', level: 'warn' });
    for (const b of ['A', 'B', 'C']) if (bi('al.dead' + b)) v.alarms.push({ k: 'dead' + b, text: `Bus ${b} DEAD`, level: 'bad' });
    if (bi('al.sup33')) v.alarms.push({ k: 'sup33', text: 'Loss of 33 kV supply', level: 'bad' });
    return v;
  }

  return { Substation, Outstation, Master, POINTS, FEEDERS, idx, pointIndex, substationPlant, actionOf, viewFromPoints, fmtOff,
    consts: { TX_MVA, TAP_NOM, TAP_MAX, TAP_STEP, CAP_MVAR, OC_PICKUP, TEMP_ALARM, TEMP_TRIP, CAP_DISCHARGE, TAP_TIME } };
});
