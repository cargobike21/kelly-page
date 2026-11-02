/* Kelly Page -- simulated P25 data link for the DNP3 demos (UMD: window.DNP3Link). Needs js/dnp3.js (airSeconds).
 *
 * Carries frames between a DNP3 master and outstation (js/dnp3sim.js) the way the bench measured a TP9400/TM9100 in
 * P25 Transparent mode (2026-10-05): one shared half-duplex channel (a frame waits for the one before it, in either
 * direction), ~0.56 s radio turnaround + ~2.7 kbit/s of payload (D.airSeconds), frames over 28 B split by the radio's
 * serial packetiser into a second burst 120 ms later in the same key-up. On top: extra network latency, random
 * loss, and an RSSI slider that adds loss as the signal fades below about -105 dBm. cut(true) drops everything,
 * including frames already on their way. p25: false turns it into a quick wire (latency only) for comparison.
 *
 * const L = new DNP3Link.Link({ lat, loss, rssi, p25 }); L.join(master, outstation); L.on(e => ...)
 *   events: { type: 'tx' | 'lost' | 'rx', from: 'M' | 'O', frame, why?, air? }       L.stats() -> numbers for the UI
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./dnp3.js'));
  else root.DNP3Link = factory(root.DNP3);
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const SPLIT_AT = 28, SPLIT_GAP_MS = 120, WINDOW_MS = 10000;

  // extra loss from a weak signal: nothing above -105 dBm, all of it by -120 dBm
  const rssiLoss = dbm => { const x = Math.max(0, Math.min(1, (-dbm - 105) / 15)); return 100 * x * x; };

  class Link {
    constructor(o = {}) {
      this.cfg = { lat: 120, loss: 0, rssi: -85, p25: true, ...o };
      this.down = false; this.chanFree = 0; this.busyTill = { M: 0, O: 0 }; this.listeners = []; this.win = []; this.timers = new Set();
      this.tot = { tx: 0, bytes: 0, lost: 0, rx: 0, airMs: 0 };
    }
    on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
    emit(e) { for (const f of this.listeners) try { f(e); } catch (err) { console.error(err); } }
    join(master, outstation) { master.send = f => this.carry('M', outstation, f); outstation.send = f => this.carry('O', master, f); }
    cut(on) { this.down = !!on; this.emit({ type: 'cut', on: this.down }); }
    lossPct() { if (this.down) return 100; const a = this.cfg.loss / 100, b = rssiLoss(this.cfg.rssi) / 100; return 100 * (1 - (1 - a) * (1 - b)); }
    airMs(n) { return this.cfg.p25 ? D.airSeconds(n) * 1000 + (n > SPLIT_AT ? SPLIT_GAP_MS : 0) : 0; }
    carry(from, to, f) {
      const t = now(), n = f.length;
      this.tot.tx++; this.tot.bytes += n; this.win.push({ at: t, n });
      if (this.down) return this.lose(from, f, 'link cut -- nothing gets through');
      // the channel is busy until the last frame has finished, whichever end sent it
      const start = this.cfg.p25 ? Math.max(t, this.chanFree) : t, air = this.airMs(n);
      if (this.cfg.p25) { this.chanFree = start + air; this.tot.airMs += air; }
      const jitter = this.cfg.lat * (0.9 + Math.random() * 0.2);
      const at = Math.max(start + air + jitter, this.busyTill[from] + 1); this.busyTill[from] = at;
      this.emit({ type: 'tx', from, frame: f, air, wait: start - t, at });
      if (Math.random() * 100 < this.lossPct()) { this.later(at - t, () => this.lose(from, f, this.cfg.rssi < -105 ? `lost: weak signal (${this.cfg.rssi} dBm)` : 'lost on the link')); return; }
      this.later(at - t, () => {
        if (this.down) return this.lose(from, f, 'link cut while the frame was on air');
        this.tot.rx++; this.emit({ type: 'rx', from, frame: f }); to.receive(f);
      });
    }
    lose(from, f, why) { this.tot.lost++; this.emit({ type: 'lost', from, frame: f, why }); }
    later(ms, fn) { const id = setTimeout(() => { this.timers.delete(id); fn(); }, Math.max(0, ms)); this.timers.add(id); }
    close() { for (const id of this.timers) clearTimeout(id); this.timers.clear(); this.listeners = []; }
    // packets/s and bytes/s over the last 10 s, how busy the channel is, totals
    stats() {
      const t = now(); this.win = this.win.filter(x => t - x.at < WINDOW_MS);
      const span = WINDOW_MS / 1000, bytes = this.win.reduce((s, x) => s + x.n, 0);
      const airMs = this.cfg.p25 ? this.win.reduce((s, x) => s + this.airMs(x.n), 0) : 0;
      return { pps: this.win.length / span, bps: bytes / span, busy: Math.min(100, 100 * airMs / WINDOW_MS), lossPct: this.lossPct(), ...this.tot };
    }
  }
  return { Link, rssiLoss, SPLIT_AT };
});
