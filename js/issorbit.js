/* Kelly Page -- ISS orbit + Doppler engine, pure (window.KellyIssOrbit). Needs vendor/satellite.js-5.0.0 (SGP4, MIT).
 *
 *   rec(l1, l2)                       satrec from a TLE
 *   look(rec, t, obs)                 { az, el (deg), range (km), rr (range rate km/s, + = receding), lat, lon, alt (km), v (km/s) }
 *   passes(rec, obs, from, hours, minEl)   [{ aos, los, tca, maxEl, azAos, azLos, track: [{ t, az, el }] }]  (times in ms)
 *   rxHz(fHz, rr)                     the frequency you hear: f x (1 - rr / c)  (approaching = higher)
 *   bankChannel(shiftHz, bank)        which of a 5-channel Doppler bank to sit on: index 0-4 (CH1 = +5 kHz ... CH5 = -5 kHz)
 *   footprintKm(alt)                  ground radius of the area that can see the satellite at 0 deg elevation
 * obs = { lat, lon (deg), alt (km) }. tests/iss-tests.html checks it.
 */
(function () {
  'use strict';
  const S = () => window.satellite, C_KMS = 299792.458, RE = 6378.137;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

  function rec(l1, l2) { return S().twoline2satrec(l1.trim(), l2.trim()); }
  function state(r, t) {
    const d = new Date(t), pv = S().propagate(r, d);
    if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
    return { d, pos: pv.position, vel: pv.velocity, gmst: S().gstime(d) };
  }
  function look(r, t, obs) {
    const a = state(r, t), b = state(r, t + 1000); if (!a || !b) return null;
    const og = { latitude: rad(obs.lat), longitude: rad(obs.lon), height: obs.alt || 0 };
    const ecfA = S().eciToEcf(a.pos, a.gmst), ecfB = S().eciToEcf(b.pos, b.gmst);
    const la = S().ecfToLookAngles(og, ecfA), lb = S().ecfToLookAngles(og, ecfB);
    const geo = S().eciToGeodetic(a.pos, a.gmst);
    return { az: (deg(la.azimuth) + 360) % 360, el: deg(la.elevation), range: la.rangeSat, rr: lb.rangeSat - la.rangeSat,
      lat: deg(geo.latitude), lon: ((deg(geo.longitude) + 540) % 360) - 180, alt: geo.height, v: Math.hypot(a.vel.x, a.vel.y, a.vel.z) };
  }
  // passes above minEl: coarse 30 s scan for horizon crossings, then 1 s refinement; track every 10 s for the sky plot
  function passes(r, obs, from = Date.now(), hours = 36, minEl = 10) {
    const out = [], end = from + hours * 3600e3, el = t => { const l = look(r, t, obs); return l ? l.el : -90; };
    const edge = (t0, t1, rising) => { for (let i = 0; i < 20; i++) { const m = (t0 + t1) / 2; if ((el(m) > 0) === rising) t1 = m; else t0 = m; } return Math.round(t1 / 1000) * 1000; };
    let prev = el(from), tPrev = from;
    if (prev > 0) { let t = from; while (el(t) > 0 && t > from - 20 * 60e3) t -= 30e3; prev = el(t); tPrev = t; }   // already up: find its AOS
    for (let t = tPrev + 30e3; t < end; t += 30e3) {
      const e = el(t);
      if (prev <= 0 && e > 0) {
        const aos = edge(t - 30e3, t, true);
        let u = t; while (el(u) > 0 && u < aos + 20 * 60e3) u += 30e3;
        const los = edge(u - 30e3, u, false);
        const track = []; let best = { el: -90, t: aos };
        for (let s = aos; s <= los; s += 10e3) { const l = look(r, s, obs); if (!l) continue; track.push({ t: s, az: l.az, el: l.el }); if (l.el > best.el) best = { el: l.el, t: s }; }
        const la = look(r, aos, obs), ll = look(r, los, obs);
        if (best.el >= minEl && los > from) out.push({ aos, los, tca: best.t, maxEl: best.el, azAos: la ? la.az : 0, azLos: ll ? ll.az : 0, track });
        t = los; prev = 0; continue;
      }
      prev = e;
    }
    return out;
  }
  const rxHz = (f, rr) => f * (1 - rr / C_KMS);
  // 5-channel bank: CH1 +5, CH2 +2.5, CH3 0, CH4 -2.5, CH5 -5 kHz; switch half-way between neighbours
  function bankChannel(shiftHz, bank = [5000, 2500, 0, -2500, -5000]) {
    let best = 0; for (let i = 1; i < bank.length; i++) if (Math.abs(shiftHz - bank[i]) < Math.abs(shiftHz - bank[best])) best = i;
    return best;
  }
  const footprintKm = alt => RE * Math.acos(RE / (RE + alt));
  window.KellyIssOrbit = { rec, look, passes, rxHz, bankChannel, footprintKm, C_KMS };
})();
