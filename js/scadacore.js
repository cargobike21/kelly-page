/* Kelly Page -- plant-side helpers shared by the DNP3 Demo's SCADA trainers (Wivenhoe, the Mackay gas turbine).
 * Pure (no DOM; UMD: window.ScadaCore). The page side is js/scadakit.js.
 *
 * A plant module keeps ONE point list (POINTS = { bi, ai, ctr, bo, ao }, DNP3 indexes from 0: BI0001 = BI 0) used by
 * the outstation, the master and the UI. Each point: { id, code, name, get(model) }, plus for AI { unit, scale, db }
 * (raw on the wire = value x scale, db = event deadband in raw counts), for counters { db }, for BO { how, pair? }.
 * A two-state BO (a breaker, a mode switch) has pair: ['close', 'open'] (or breaker: true, the same thing):
 * CLOSE / LATCH ON asks for id + '.close', TRIP / LATCH OFF for id + '.open'. Any other BO is a pulse: PULSE ON,
 * LATCH ON or CLOSE asks for the point's own id.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScadaCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // { bi: { id: index }, ai: ..., ... }
  function indexPoints(POINTS) {
    const idx = {};
    for (const k of Object.keys(POINTS)) { idx[k] = {}; POINTS[k].forEach((p, i) => { idx[k][p.id] = i; }); }
    return idx;
  }
  const pairOf = p => p.pair || (p.breaker ? ['close', 'open'] : null);

  // the command a CROB asks for, or null when the control code doesn't fit the point (-> FORMAT ERROR)
  function crobCommand(p, code) {
    const tc = code & 0xC0, op = code & 0x0F, pr = pairOf(p);
    if (pr) return tc === 0x40 || (!tc && op === 3) ? `${p.id}.${pr[0]}` : tc === 0x80 || (!tc && op === 4) ? `${p.id}.${pr[1]}` : null;
    if (op === 1 || op === 3 || tc === 0x40) return p.id;   // PULSE ON / LATCH ON / CLOSE
    return null;
  }
  // the other way round, for the page: a command id -> { bo, close } (close: true = CLOSE, false = TRIP, null = PULSE ON)
  function boFor(POINTS, idx, id) {
    const m = /^(.*)\.([a-z]+)$/.exec(id);
    if (m && idx.bo[m[1]] != null) { const p = POINTS.bo[idx.bo[m[1]]], pr = pairOf(p); if (pr && pr.includes(m[2])) return { bo: idx.bo[m[1]], close: m[2] === pr[0] }; }
    if (idx.bo[id] != null) return { bo: idx.bo[id], close: null };
    return null;
  }

  // The RTU's own comms diagnostics, refreshed by the host every tick: "P25 Link Healthy" is "a master has asked me
  // something in the last timeoutMs" -- a real RTU's comms-fail logic. A cut link turns it false, as an event the master
  // only gets once the link is back (that's the lesson). m.p25 = { healthy, rssi, pktRate, sent, rcvd }.
  // o = { timeoutMs, rssi, pktPerMin }
  function rtuComms(m, os, o = {}) {
    const t = typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now();
    if (os.lastRxAt == null) os.lastRxAt = t;   // grace period from start-up
    m.p25.healthy = t - os.lastRxAt < (o.timeoutMs || 20000);
    if (o.rssi != null) m.p25.rssi = Math.round(o.rssi);
    if (o.pktPerMin != null) m.p25.pktRate = o.pktPerMin;
    m.p25.sent = os.stats.tx; m.p25.rcvd = os.stats.rx;
  }

  // readers over a master's mirrored points, for a plant's viewFromPoints(): bi(id) -> 0/1/undefined, ai(id) -> value or null
  function reader(POINTS, idx, db) {
    return {
      bi: id => db.bi[idx.bi[id]],
      ai: id => { const r = db.ai[idx.ai[id]]; return r == null ? null : r / POINTS.ai[idx.ai[id]].scale; },
      ctr: id => db.ctr[idx.ctr[id]],
      ao: id => { const i = idx.ao[id], r = db.ao ? db.ao[i] : null; return r == null ? null : r / (POINTS.ao[i].scale || 1); },
    };
  }

  return { indexPoints, crobCommand, boFor, rtuComms, reader, pairOf };
});
