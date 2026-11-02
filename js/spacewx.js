/* Kelly Page -- Space Weather page (2026-10-18, unreleased): NOAA SWPC solar and geomagnetic data over P25, and what it
 * does (and doesn't do) to HF, VHF, P25, GPS and satellite links in Queensland.
 *
 * Real: one gateway answer, KF kind 3 {op: 'spacewx'} -> kind 4 {app: 'spacewx', ...} from the dashboard's space-wx.js
 * (GOES X-ray flux 6 h, 3-hourly + 1-minute Kp, 10.7 cm flux, sunspot number, NOAA R/S/G scales + 3-day forecast) --
 * fields in its header; keep apply() in step. Shown with its real bytes and size.
 * Estimated (badged ESTIMATE): HF band conditions, MUF and D-region absorption, worked out here from those numbers for
 * Brisbane's sun angle. Absorption uses NOAA D-RAP's relation: the highest affected frequency HAF = 10 log10(flux) + 65
 * MHz has 1 dB of absorption, falling as f^-1.5, sunlit side only. MUF is a rough foF2-from-SFI rule, good for teaching,
 * not for planning a contest. P25 VHF/UHF is line of sight, so flares barely touch it -- the page shows the real numbers.
 * Simulated (badged): the Blackout Survival drill's scenarios.
 *
 * Tabs (data-tabs="spacewx"): ops (sun, X-ray chart, Kp, scales, band matrix, MUF / absorption), link (link impact,
 * absorption by band, band-noise listener, real data path), arcade (drill, Kp prediction log scored against later real
 * Kp, badges, Solar School). Effects are one-shot: a flare burst on a new C+ peak, an aurora shimmer (3 times) at Kp >= 5,
 * a klaxon for a new M/X flare, a Geiger burst for an S storm, 6 s of band noise on request
 * (kelly-page/CLAUDE.md "Flashy, but nothing loops forever").
 *
 * window.KellySpaceWxUI(ctx) -> { init, render, shown, gatewayReply, ownsXid, kfEvent }; ctx from app.js.
 */
(function () {
  'use strict';
  const ANSWER_MS = 90000, BNE = { la: -27.47, lo: 153.03 };
  // A real answer, 2026-10-18 18:35 AEST (a C3.8 flare earlier in the window) -- what the demo radio "receives"
  const DEMO = { t: '2026-10-18T08:33:00Z', x: [-619, -619, -617, -619, -619, -621, -591, -546, -547, -560, -581, -589, -587, -585, -585, -589, -586, -591, -595, -600, -606, -608, -608, -596, -543, -543, -558, -576, -590, -600, -605, -610, -612, -609, -603, -611],
    xn: 7.28e-7, xc: 'B7.3', xp: 'C3.8', k: [13, 30, 27, 30, 23, 23, 33, 20, 17, 23, 17, 33, 37, 23, 20, 10, 7, 7, 7, 27, 30, 10, 20, 23], kt: '2026-10-18T03:00:00', kn: 1.33, sfi: 132, ssn: 69, ssm: '2026-09',
    sc: { r: 0, s: 0, g: 0 }, fc: [{ d: '2026-10-18', r1: 20, r3: 5, s: 5, g: 0 }, { d: '2026-10-19', r1: 20, r3: 5, s: 5, g: 1 }, { d: '2026-10-20', r1: 20, r3: 5, s: 5, g: 0 }] };
  const BANDS = [['160 m', 1.9], ['80 m', 3.6], ['40 m', 7.1], ['30 m', 10.1], ['20 m', 14.2], ['17 m', 18.1], ['15 m', 21.2], ['12 m', 24.9], ['10 m', 28.5]];
  const GRADE = ['Poor', 'Fair', 'Good', 'Excellent'];
  const SCALE = { r: ['', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'], s: ['', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'], g: ['', 'Minor', 'Moderate', 'Strong', 'Severe', 'Extreme'] };
  const BADGES = [
    ['over_air', '📻', 'Over the Air', 'Receive space weather over P25'],
    ['flare', '☀️', 'Flare Spotter', 'See a C-class or bigger flare in the data'],
    ['mflare', '💥', 'Big One', 'See an M or X-class flare'],
    ['storm', '🧲', 'Storm Chaser', 'See Kp 5 or more (a G1 storm)'],
    ['aurora', '🌌', 'Aurora Australis', 'See Kp 7 or more'],
    ['listen', '🎧', 'Band Listener', 'Listen to the band noise'],
    ['drill', '🛰️', 'Blackout Survivor', 'Finish a Blackout Survival drill'],
    ['perfect', '🏆', 'Perfect Comms', 'Every drill answer right'],
    ['oracle', '🔮', 'First Forecast', 'Get a Kp prediction right'],
    ['oracle3', '🧙', 'Flare Forecaster', 'Get 3 Kp predictions right'],
    ['scholar', '🎓', 'Solar Scholar', 'Read every Solar School card'],
    ['watch', '👁️', 'On Watch', 'Keep fresh space weather for an hour'],
  ];
  const RANKS = [[0, 'Sunspot Spotter'], [400, 'Ionosphere Ace'], [1200, 'Flare Forecaster'], [3000, 'Space Weather Officer'], [6000, 'Heliophysics Legend']];
  const flux = v => Math.pow(10, v / 100);
  const fclass = f => { if (!(f > 0)) return '--'; for (const [c, b] of [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7]]) if (f >= b) return c + (f / b).toFixed(1); return 'A' + (f / 1e-8).toFixed(1); };
  // sun elevation over Brisbane (degrees), simple NOAA-style approximation
  function sunElev(t = Date.now(), la = BNE.la, lo = BNE.lo) {
    const d = new Date(t), day = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
    const decl = 23.44 * Math.sin((2 * Math.PI / 365) * (day - 81)) * Math.PI / 180;
    const hr = d.getUTCHours() + d.getUTCMinutes() / 60 + lo / 15, ha = (hr - 12) * 15 * Math.PI / 180, lat = la * Math.PI / 180;
    return Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha)) * 180 / Math.PI;
  }
  // the propagation model (ESTIMATE) -- see the header
  function model(d, t = Date.now(), forceDay) {
    const el = sunElev(t), day = forceDay != null ? forceDay : el > 0, kp = d.kn != null ? d.kn : (d.k[d.k.length - 1] || 0) / 10;
    const haf = day ? Math.max(0, 10 * Math.log10(d.xn || 1e-9) + 65) : 0;
    const noon = 3.0 + 0.045 * (d.sfi || 70), fo = (day ? noon * (0.55 + 0.45 * Math.sin(Math.max(0, el) * Math.PI / 180)) : noon * 0.45) * (kp >= 5 ? 1 - 0.05 * (kp - 4) : 1);
    const muf = 3.2 * fo, absorb = f => (haf > 0 ? Math.pow(haf / f, 1.5) : 0);
    const grade = (f, dayCol) => {
      const m = dayCol ? 3.2 * noon * (kp >= 5 ? 1 - 0.05 * (kp - 4) : 1) * 0.95 : 3.2 * noon * 0.45 * (kp >= 5 ? 1 - 0.05 * (kp - 4) : 1), r = f / m;
      let g = r > 1 ? 0 : r > 0.85 ? 2 : r > 0.45 ? 3 : r > 0.25 ? 2 : 1;
      if (dayCol && f < 5) g -= f < 2.5 ? 3 : 1;                 // normal daytime D-layer absorption on 160 / 80 m
      const a = dayCol ? (Math.max(0, 10 * Math.log10(d.xn || 1e-9) + 65) / f) ** 1.5 : 0;
      if (a > 10) g = 0; else if (a > 3) g -= 1;                  // flare absorption (sunlit side)
      if (kp >= 6) g -= 1;
      return Math.max(0, Math.min(3, g));
    };
    return { el, day, kp, haf, fo, muf, absorb, grade };
  }

  window.KellySpaceWxUI = function (k) {
    const { $, esc, store, toast, dirty, settings, saveSoon, fmtAgo } = k;
    const S = { d: store.get('spacewx', null), hex: store.get('spacewxHex', null), ask: null, err: '', timer: 0, askN: 0, okN: 0, alert: null, drill: null, ionoDay: true };
    const Q = Object.assign({ xp: 0, best: 0, badges: {}, preds: [], hits: 0, school: {}, watchMin: 0 }, store.get('swQuest', {}));
    const saveQ = () => store.set('swQuest', Q);
    const every = () => (settings.swEvery == null ? 10 : +settings.swEvery);
    const onPage = () => k.currentPage() === 'spacewx' && !document.hidden;
    const tab = () => { const b = $('[data-tabs="spacewx"] button.on'); return b ? b.dataset.tab : 'ops'; };

    // ------------------------------------------------------------ sound (synth, one-shot)
    const clicked = () => !navigator.userActivation || navigator.userActivation.hasBeenActive;
    function ctx() { try { return k.audioCtx(); } catch { return null; } }
    function snd(kind) {
      if (settings.swSfx === false || !clicked() || !onPage()) return;
      const c = ctx(); if (!c) return;
      const t0 = c.currentTime + 0.01, vol = (settings.soundVol == null ? 0.8 : +settings.soundVol) * 0.5;
      const tone = (f, t, d, type = 'square', g = 0.1, f2) => { const o = c.createOscillator(), a = c.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d); a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(g * vol + 0.0001, t + 0.01); a.gain.exponentialRampToValueAtTime(0.0001, t + d); o.connect(a).connect(c.destination); o.start(t); o.stop(t + d + 0.05); };
      const tick = t => { const b = c.createBuffer(1, 220, c.sampleRate), x = b.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * (1 - i / x.length); const s = c.createBufferSource(), a = c.createGain(); s.buffer = b; a.gain.value = 0.3 * vol; s.connect(a).connect(c.destination); s.start(t); };
      if (kind === 'klaxon') for (let i = 0; i < 3; i++) tone(420, t0 + i * 0.7, 0.6, 'sawtooth', 0.09, 640);
      else if (kind === 'geiger') { let t = t0; for (let i = 0; i < 28; i++) { t += 0.02 + Math.random() * 0.12; tick(t); } }
      else if (kind === 'blip') tone(1500, t0, 0.15, 'sine', 0.12, 900);
      else if (kind === 'good') { tone(880, t0, 0.08); tone(1320, t0 + 0.09, 0.14); }
      else if (kind === 'bad') { tone(220, t0, 0.18, 'sawtooth'); tone(180, t0 + 0.2, 0.22, 'sawtooth'); }
      else if (kind === 'badge') [659, 880, 1109, 1319].forEach((f, i) => tone(f, t0 + i * 0.09, i === 3 ? 0.4 : 0.1, 'triangle', 0.14));
    }
    // 6 s of band noise: static whose level rises with Kp, plus a weak CW "CQ" faded by the absorption on that band
    function listen(mhz) {
      const c = ctx(); if (!c || !S.d) return;
      const m = model(S.d), att = m.absorb(mhz), kp = m.kp, vol = settings.soundVol == null ? 0.8 : +settings.soundVol, dur = 6, t0 = c.currentTime + 0.05;
      const n = c.createBuffer(1, c.sampleRate * dur, c.sampleRate), x = n.getChannelData(0); let b = 0;
      for (let i = 0; i < x.length; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); x[i] = (Math.random() * 2 - 1) * 0.5 + b * 4; }
      const s = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain(); s.buffer = n; bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.6;
      g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime((0.05 + 0.025 * kp) * vol, t0 + 0.3); g.gain.setValueAtTime((0.05 + 0.025 * kp) * vol, t0 + dur - 0.4); g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      s.connect(bp).connect(g).connect(c.destination); s.start(t0); s.stop(t0 + dur);
      const sig = 0.12 * vol * Math.pow(10, -att / 20) * (mhz > m.muf && mhz < 30 ? 0.08 : 1);
      const code = '-.-. --.-', unit = 0.07; let t = t0 + 0.6;
      for (const ch of code) { if (ch === ' ') { t += unit * 3; continue; } const len = ch === '-' ? unit * 3 : unit; const o = c.createOscillator(), a = c.createGain(); o.frequency.value = 650; a.gain.setValueAtTime(0.0001, t); a.gain.linearRampToValueAtTime(sig, t + 0.005); a.gain.setValueAtTime(sig, t + len - 0.005); a.gain.linearRampToValueAtTime(0.0001, t + len); o.connect(a).connect(c.destination); o.start(t); o.stop(t + len + 0.01); t += len + unit; }
      badge('listen');
    }
    function badge(id) {
      if (Q.badges[id]) return;
      const b = BADGES.find(x => x[0] === id); if (!b) return;
      Q.badges[id] = Date.now(); Q.xp += 100; saveQ(); snd('badge');
      const pop = $('#sw-pop'); if (pop) { pop.innerHTML = `<div class="sw-badge-pop"><b>${b[1]}</b><span>BADGE UNLOCKED</span><strong>${esc(b[2])}</strong><small>${esc(b[3])} · +100 XP</small></div>`; pop.hidden = false; clearTimeout(S.popT); S.popT = setTimeout(() => { pop.hidden = true; }, 3500); }
      dirty('spacewx');
    }

    // ------------------------------------------------------------ asking the gateway (= dams.js)
    async function ask(auto) {
      if (S.ask) return;
      if (auto && !k.demo() && (!k.radioConnected() || k.rfBusy())) return;
      S.err = ''; S.askN++;
      if (k.demo()) {
        const xid = -Date.now(); S.ask = { xid, at: Date.now(), demo: true, auto };
        setTimeout(() => { if (S.ask && S.ask.xid === xid) gatewayReply({ app: 'spacewx', at: Date.now(), ...JSON.parse(JSON.stringify(DEMO)) }, null); }, 1500);
        dirty('spacewx'); return;
      }
      if (!k.radioConnected()) { S.err = 'Offline -- connect the radio to ask the P25X gateway'; dirty('spacewx'); return; }
      S.ask = { xid: 0, at: Date.now(), auto };
      const xid = await k.kfRequest({ op: 'spacewx' }, 'Space weather');
      S.ask = xid ? { xid, at: Date.now(), auto } : null;
      if (!xid && !auto) S.err = 'The radio is busy -- try again in a moment';
      dirty('spacewx');
    }
    function kfEvent(e) {
      if (!S.ask) return;
      if (e.kind === 'tx-done') { const xid = S.ask.xid; S.ask.phase = 'gateway'; setTimeout(() => { if (S.ask && S.ask.xid === xid && !k.rfRx()) { S.ask = null; S.err = 'The gateway took the request but never answered -- press Refresh'; dirty('spacewx'); } }, ANSWER_MS); }
      else if (e.kind === 'tx-failed') { S.err = e.cancelled ? '' : 'No answer from the P25X gateway -- press Refresh'; S.ask = null; }
      dirty('spacewx');
    }
    function gatewayReply(j, r) {
      const a = S.ask; S.ask = null;
      if (j.error) { S.err = j.error; if (!(a && a.auto)) toast('🌞', 'Space Weather', j.error, 'bad'); dirty('spacewx'); return; }
      const prev = S.d;
      S.okN++;
      S.d = { ...j, got: Date.now(), air: { bytes: r && r.data ? r.data.length : 0, secs: a && !a.demo ? (Date.now() - a.at) / 1000 : null } };
      if (r && r.data) { S.hex = Array.from(r.data, b => b.toString(16).padStart(2, '0')).join(''); store.set('spacewxHex', S.hex); badge('over_air'); k.addEvent('data', `Space weather over P25: ${j.xc}, Kp ${j.kn}, ${r.data.length} B`); }
      store.set('spacewx', S.d); S.err = '';
      const peak = Math.max(...j.x), kpMax = Math.max(...j.k) / 10, letter = c => 'ABCMX'.indexOf((c || 'A')[0]);
      if (peak >= -600) badge('flare'); if (peak >= -500) badge('mflare'); if (kpMax >= 5 || j.kn >= 5) badge('storm'); if (kpMax >= 7 || j.kn >= 7) badge('aurora');
      // effects only for something NEW since the last answer
      if (prev && letter(j.xp) >= 2 && (letter(j.xp) > letter(prev.xp) || j.xp > prev.xp)) burst('flare');
      if (letter(j.xc) >= 3 && (!prev || letter(prev.xc) < 3)) { S.alert = { text: `${j.xc} flare in progress -- HF radio blackout on the sunlit side`, at: Date.now() }; snd('klaxon'); }
      if (j.sc.s >= 1 && (!prev || prev.sc.s < 1)) { S.alert = { text: `S${j.sc.s} solar radiation storm -- satellite and polar HF risk`, at: Date.now() }; snd('geiger'); }
      if ((j.kn >= 5) && (!prev || prev.kn < 5)) burst('aurora');
      scorePreds();
      snd('blip');
      dirty('spacewx');
    }
    function burst(kind) { const el = $(kind === 'flare' ? '#sw-sun' : '#sw-aurora'); if (!el || !document.body.classList.contains('fx')) return; el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); }
    function autoTick() {
      clearTimeout(S.timer); S.timer = 0;
      if (k.currentPage() !== 'spacewx') return;
      if (every() && (!S.d || Date.now() - S.d.got >= every() * 60000 - 5000)) ask(true);
      if (S.d && Date.now() - S.d.got < 900000) { Q.watchMin += 0.5; if (Q.watchMin >= 60) badge('watch'); saveQ(); }
      S.timer = setTimeout(autoTick, S.d ? 30000 : 5000);
      dirty('spacewx');
    }

    // ------------------------------------------------------------ Kp prediction log (scored against later real Kp)
    const SLOT = 3 * 3600000, slotOf = t => Math.floor(t / SLOT) * SLOT;
    const kpCat = kp => (kp >= 5 ? 2 : kp >= 4 ? 1 : 0), CATS = ['Quiet (Kp < 4)', 'Active (Kp 4)', 'Storm (Kp 5+)'];
    function predict(cat) {
      const slot = slotOf(Date.now()) + SLOT;   // the next 3-hour period (UTC slots, as NOAA's Kp)
      if (Q.preds.some(p => p.slot === slot)) { toast('🔮', 'Already predicted', 'One guess per 3-hour period', 'bad'); return; }
      Q.preds.push({ slot, cat, made: Date.now() }); Q.preds = Q.preds.slice(-30); saveQ(); snd('blip'); dirty('spacewx');
    }
    function scorePreds() {
      const d = S.d; if (!d || !d.kt) return;
      const last = Date.parse(d.kt + 'Z');
      for (const p of Q.preds) {
        if (p.res != null || p.slot > last) continue;
        const i = d.k.length - 1 - Math.round((last - p.slot) / SLOT); if (i < 0) { p.res = -1; continue; }
        p.kp = d.k[i] / 10; p.res = kpCat(p.kp) === p.cat ? 1 : 0;
        if (p.res) { Q.hits++; Q.xp += 150; snd('good'); badge('oracle'); if (Q.hits >= 3) badge('oracle3'); }
      }
      saveQ();
    }

    // ------------------------------------------------------------ Blackout Survival drill (SIMULATED scenarios)
    const SCEN = [
      { q: 'An X2 flare hits at midday. Your 40 m net to Rockhampton fades out. Best way to get the message through?', a: ['Send it over P25X -- VK4RAR is on the network, and the backhaul is Tailscale over the internet', 'Turn the power up on 40 m', 'Move to 160 m', 'Keep calling on 40 m'], ok: 0, why: 'Flare absorption is in the sunlit D-region and hits low HF hardest; VHF/UHF P25 and internet backhaul are untouched.' },
      { q: 'An M5 flare is in progress at 2 pm. Which HF band suffers MOST?', a: ['80 m', '20 m', '10 m', 'They all suffer equally'], ok: 0, why: 'D-region absorption falls as frequency^-1.5, so the lowest band takes the biggest hit.' },
      { q: 'A big flare erupts at 3 am Brisbane time. What happens to SEQ HF?', a: ['Little -- the blackout only hits the sunlit side of Earth', 'Total HF blackout across Australia', 'P25 repeaters go off air', 'VHF goes long distance'], ok: 0, why: 'Flare X-rays ionise the D-region only where the Sun is up.' },
      { q: 'A G4 storm at night and your P25 GPS tracks start jumping around. Why?', a: ['Ionospheric scintillation is upsetting GPS fixes', 'The P25 data is being corrupted', 'The repeater is overheating', 'The flare is reflecting P25'], ok: 0, why: 'Strong geomagnetic storms disturb the ionosphere that GPS signals pass through; the P25 link carrying the positions is fine.' },
      { q: 'An S3 solar radiation storm is under way. Which link is most at risk?', a: ['Satellite telemetry -- energetic protons upset spacecraft electronics', 'The P25 VHF repeater', 'Your LoRa mesh node', 'The Tailscale backhaul'], ok: 0, why: 'Proton storms affect satellites and polar HF; ground VHF/UHF is unaffected.' },
      { q: 'Does an X-class flare black out your P25 UHF repeater?', a: ['Hardly -- absorption at 450 MHz is a tiny fraction of a dB', 'Yes, completely', 'Only the digital part', 'Only at night'], ok: 0, why: 'With absorption falling as f^-1.5, even an X10 flare costs about 0.03 dB at 450 MHz.' },
      { q: 'Kp hits 8 and there is aurora. What might you notice on 2 m and VHF P25?', a: ['Distant stations or interference arriving via the aurora', 'Nothing at all ever', 'The repeater talks faster', 'All VHF stops working'], ok: 0, why: 'Aurora and sporadic-E can carry VHF far beyond line of sight -- distant co-channel signals can show up.' },
      { q: 'Solar flux is 200 and it is the middle of the day. Which band is likely wide open for DX?', a: ['10 m', '160 m', '80 m', 'None -- high flux closes HF'], ok: 0, why: 'High solar flux pushes the MUF up, opening the high HF bands.' },
    ];
    const DRILL_S = 12;
    function drillStart() {
      const order = SCEN.map((s, i) => i).sort(() => Math.random() - 0.5).slice(0, 6);
      S.drill = { order, i: 0, score: 0, ok: 0, picks: [], at: Date.now(), done: false, res: null, shuf: [] };
      drillRound(); snd('blip');
    }
    function drillRound() {
      const d = S.drill; d.res = null;
      if (d.i >= d.order.length) return drillEnd();
      const s = SCEN[d.order[d.i]]; d.shuf = s.a.map((t, j) => j).sort(() => Math.random() - 0.5);
      d.at = Date.now(); clearTimeout(d.t); d.t = setTimeout(() => drillPick(-1), DRILL_S * 1000);
      $('#sw-drill').dataset.key = ''; dirty('spacewx');
    }
    function drillPick(j) {
      const d = S.drill; if (!d || d.done || d.res) return;
      clearTimeout(d.t);
      const s = SCEN[d.order[d.i]], ok = j === s.ok, secs = (Date.now() - d.at) / 1000;
      const pts = ok ? 100 + Math.round(Math.max(0, DRILL_S - secs) * 10) : 0;
      d.score += pts; if (ok) d.ok++; d.res = { ok, pts, j, why: s.why };
      snd(ok ? 'good' : 'bad'); $('#sw-drill').dataset.key = ''; dirty('spacewx');
      setTimeout(() => { if (S.drill === d) { d.i++; drillRound(); } }, 3200);
    }
    function drillEnd() {
      const d = S.drill; d.done = true;
      Q.xp += Math.round(d.score / 5); if (d.score > Q.best) Q.best = d.score; saveQ();
      badge('drill'); if (d.ok === d.order.length) badge('perfect');
      snd('badge'); $('#sw-drill').dataset.key = ''; dirty('spacewx');
    }

    // ------------------------------------------------------------ drawing
    function sunSvg(d) {
      const L = 'ABCMX'.indexOf((d.xc || 'A')[0]), hue = ['#ffcf5a', '#ffb020', '#ff8a1a', '#ff5a1a', '#ff2b4a'][Math.max(0, L)];
      let seed = (d.ssn || 0) * 7 + 3; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
      const spots = Array.from({ length: Math.min(14, Math.round((d.ssn || 0) / 12)) }, () => { const a = rnd() * Math.PI * 2, r = 20 + rnd() * 50; return `<circle cx="${100 + r * Math.cos(a)}" cy="${100 + r * Math.sin(a) * 0.6}" r="${2 + rnd() * 3}" class="spot"/>`; }).join('');
      return `<svg viewBox="0 0 200 200" class="sw-sunsvg"><defs><radialGradient id="sw-sg" cx="45%" cy="40%"><stop offset="0" stop-color="#fff6d0"/><stop offset=".55" stop-color="${hue}"/><stop offset="1" stop-color="#7a1d00"/></radialGradient></defs>
        <circle cx="100" cy="100" r="92" class="corona" style="fill:${hue}"/><circle cx="100" cy="100" r="78" fill="url(#sw-sg)"/>${spots}<circle cx="100" cy="100" r="78" class="flash"/></svg>`;
    }
    function xraySvg(d) {
      const W = 600, H = 200, y = v => H - 10 - ((v + 900) / 600) * (H - 20), x = i => 40 + i * ((W - 50) / 35);
      const bands = [['X', -400], ['M', -500], ['C', -600], ['B', -700], ['A', -800]].map(([c, v]) => `<line x1="40" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="28" y="${y(v) + 4}" class="gc c${c}">${c}</text>`).join('');
      const pts = d.x.map((v, i) => `${x(i).toFixed(1)},${y(Math.max(-900, Math.min(-300, v))).toFixed(1)}`).join(' ');
      return `<svg viewBox="0 0 ${W} ${H}" class="sw-chart">${bands}<polyline points="${pts}" class="xr"/><circle cx="${x(35)}" cy="${y(d.x[35])}" r="4" class="now"/><text x="${W - 12}" y="16" text-anchor="end" class="gt">now ${esc(d.xc)} · 6 h peak ${esc(d.xp)}</text><text x="40" y="${H - 1}" class="gt">-6 h</text></svg>`;
    }
    function kpSvg(d) {
      const W = 600, H = 170, bw = (W - 40) / 24;
      const bars = d.k.map((v, i) => { const kp = v / 10, h = (kp / 9) * (H - 30); return `<rect x="${30 + i * bw}" y="${H - 18 - h}" width="${bw - 3}" height="${Math.max(1, h)}" class="kb ${kp >= 5 ? 'st' : kp >= 4 ? 'ac' : 'q'}"><title>Kp ${kp.toFixed(1)}</title></rect>`; }).join('');
      const g = [5, 7, 9].map(kv => `<line x1="28" x2="${W}" y1="${H - 18 - (kv / 9) * (H - 30)}" y2="${H - 18 - (kv / 9) * (H - 30)}" class="gl"/><text x="2" y="${H - 14 - (kv / 9) * (H - 30)}" class="gt">G${kv - 4}</text>`).join('');
      return `<svg viewBox="0 0 ${W} ${H}" class="sw-chart">${g}${bars}<text x="30" y="${H - 2}" class="gt">3 days ago</text><text x="${W - 4}" y="${H - 2}" text-anchor="end" class="gt">last 3 h: Kp ${(d.k[d.k.length - 1] / 10).toFixed(1)}</text></svg>`;
    }
    function gauge(v, max, label, unit, cls) { const p = Math.max(0, Math.min(1, v / max)); return `<div class="sw-g ${cls || ''}"><span>${label}</span><div class="sw-gbar"><i style="width:${(p * 100).toFixed(0)}%"></i></div><b>${v >= 100 ? v.toFixed(0) : v.toFixed(1)}<small> ${unit}</small></b></div>`; }

    function render() {
      const d = S.d;
      $('#sw-when').textContent = d ? `X-ray ${d.t ? new Date(d.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?'} · received ${fmtAgo(d.got)}${d.stale ? ' · STALE' : ''}` : '';
      $('#sw-phase').textContent = S.ask ? (S.ask.phase === 'gateway' ? 'Gateway reading NOAA…' : 'Asking over P25…') : '';
      const e = $('#sw-err'); e.hidden = !S.err; e.textContent = S.err;
      $('#sw-every').value = String(every()); $('#sw-sfx').checked = settings.swSfx !== false;
      const al = $('#sw-alert'); al.hidden = !S.alert || Date.now() - S.alert.at > 120000; if (!al.hidden) al.innerHTML = `<b>⚠ SPACE WEATHER ALERT</b> ${esc(S.alert.text)}`;
      $('#page-spacewx').classList.toggle('sw-empty', !d);
      const t = tab();
      if (t === 'arcade') return renderArcade();
      if (!d) return;
      if (t === 'ops') renderOps(d); else renderLink(d);
    }
    function renderOps(d) {
      const m = model(d);
      if ($('#sw-sun').dataset.v !== d.xc + d.ssn) { $('#sw-sun').innerHTML = sunSvg(d); $('#sw-sun').dataset.v = d.xc + d.ssn; }
      const kpNow = m.kp;
      $('#sw-tiles').innerHTML = [['X-ray now', d.xc, 'cls' + 'ABCMX'.indexOf(d.xc[0])], ['6 h peak', d.xp, 'cls' + 'ABCMX'.indexOf(d.xp[0])], ['Kp now', kpNow.toFixed(1), kpNow >= 5 ? 'hot' : kpNow >= 4 ? 'warm' : 'ok'], ['Solar flux', d.sfi == null ? '--' : String(d.sfi), ''], ['Sunspots', d.ssn == null ? '--' : String(d.ssn), ''], ['Sun over BNE', m.day ? `up ${m.el.toFixed(0)}°` : 'below horizon', m.day ? 'warm' : '']]
        .map(([n, v, c]) => `<div class="sw-tile ${c}"><span>${n}</span><b>${esc(v)}</b></div>`).join('');
      $('#sw-scales').innerHTML = [['r', 'R', 'Radio blackouts', 'from X-ray flares'], ['s', 'S', 'Radiation storms', 'from solar protons'], ['g', 'G', 'Geomagnetic storms', 'from the solar wind (Kp)']]
        .map(([key, L, n, why]) => { const v = d.sc[key]; return `<div class="sw-scale lv${v}"><b>${L}${v}</b><span>${n}</span><small>${v ? SCALE[key][v] : 'none'} · ${why}</small></div>`; }).join('')
        + `<div class="sw-fc"><span>NOAA 3-day outlook</span>${d.fc.map(f => `<div><b>${new Date(f.d + 'T00:00:00Z').toLocaleDateString([], { weekday: 'short', day: 'numeric' })}</b> R1-2 ${f.r1}% · R3+ ${f.r3}% · S1+ ${f.s}% · G${f.g}</div>`).join('')}</div>`;
      $('#sw-xray').innerHTML = xraySvg(d);
      $('#sw-kp').innerHTML = kpSvg(d);
      $('#sw-bands').innerHTML = `<table class="sw-tbl"><thead><tr><th>Band</th><th>Day</th><th>Night</th></tr></thead><tbody>${BANDS.map(([n, f]) => { const gd = m.grade(f, true), gn = m.grade(f, false); return `<tr><td>${n}</td><td class="g${gd} ${m.day ? 'now' : ''}">${GRADE[gd]}</td><td class="g${gn} ${m.day ? '' : 'now'}">${GRADE[gn]}</td></tr>`; }).join('')}
        <tr><td>6 m</td><td colspan="2" class="g${m.muf > 50 ? 1 : 0}">${m.muf > 50 ? 'F2 possible' : 'Sporadic-E only'}</td></tr><tr><td>2 m / P25 VHF</td><td colspan="2" class="g2">Line of sight${m.kp >= 7 ? ' · aurora openings possible' : ''}</td></tr><tr><td>P25 UHF / LoRa</td><td colspan="2" class="g2">Line of sight -- not affected</td></tr></tbody></table>`;
      $('#sw-muf').innerHTML = gauge(m.muf, 50, 'MUF (3000 km)', 'MHz', 'muf') + gauge(m.fo, 15, 'foF2 (critical)', 'MHz', 'muf') + gauge(m.haf, 35, 'Highest affected freq', 'MHz', m.haf > 15 ? 'bad' : 'abs') + gauge(m.absorb(7.1), 20, 'Flare absorption 40 m', 'dB', m.absorb(7.1) > 3 ? 'bad' : 'abs');
    }
    function renderLink(d) {
      const m = model(d), ab = f => m.absorb(f), month = new Date().getMonth(), esSeason = month >= 10 || month <= 1;
      const gpsBad = d.sc.g >= 4 ? 'bad' : d.sc.g >= 3 ? 'warn' : 'ok';
      const rows = [
        ['P25 VHF repeater RF (150 MHz)', `${ab(150).toFixed(3)} dB`, m.kp >= 7 ? 'warn' : esSeason ? 'warn' : 'ok', m.kp >= 7 ? 'Aurora: distant co-channel signals possible' : esSeason ? 'Sporadic-E season: distant signals possible some days' : 'Normal -- line of sight'],
        ['P25 UHF / RoIP (450 MHz)', `${ab(450).toFixed(4)} dB`, 'ok', 'Normal -- line of sight'],
        ['P25X backhaul (Tailscale, internet)', '--', 'ok', 'Not affected by space weather'],
        ['GPS / LRRP positions', `G${d.sc.g} now`, gpsBad, gpsBad === 'ok' ? 'Normal' : 'Storm scintillation: positions may wander'],
        ['HF backup, 40 m NVIS', `${ab(7.1).toFixed(1)} dB`, ab(7.1) > 10 ? 'bad' : ab(7.1) > 3 ? 'warn' : 'ok', `${GRADE[m.grade(7.1, m.day)]} (estimate)`],
        ['HF long haul, 20 m', `${ab(14.2).toFixed(1)} dB`, ab(14.2) > 10 ? 'bad' : ab(14.2) > 3 ? 'warn' : 'ok', `${GRADE[m.grade(14.2, m.day)]} (estimate)`],
        ['Satellite telemetry', `S${d.sc.s} now`, d.sc.s >= 2 ? 'warn' : 'ok', d.sc.s >= 2 ? 'Proton storm: spacecraft upsets possible' : 'Normal'],
        ['LoRa mesh (915 MHz)', '--', 'ok', 'Not affected'],
      ];
      $('#sw-links').innerHTML = rows.map(([n, v, st, txt]) => `<div class="sw-link ${st}"><i></i><b>${esc(n)}</b><span>${esc(v)}</span><small>${esc(txt)}</small></div>`).join('');
      // the sunlit side of Earth right now (over Brisbane only when the sun is up -- the note says which)
      const lit = model(d, Date.now(), true).absorb, fs = [1.9, 3.6, 7.1, 14.2, 21.2, 28.5, 50, 146, 440], mx = Math.max(1, ...fs.map(lit));
      $('#sw-abs').innerHTML = fs.map(f => `<div class="sw-absrow"><span>${f < 30 ? f + ' MHz' : f === 50 ? '6 m' : f === 146 ? '2 m / P25' : 'UHF P25'}</span><div class="sw-gbar"><i style="width:${(100 * lit(f) / mx).toFixed(1)}%"></i></div><b>${lit(f) < 0.01 ? '<0.01' : lit(f).toFixed(2)} dB</b></div>`).join('')
        + `<p class="dim small">On the sunlit side of Earth, today's X-ray flux (${esc(d.xc)}) gives a highest affected frequency of ${model(d, Date.now(), true).haf.toFixed(1)} MHz. ${m.day ? 'The sun is up over Brisbane, so this applies here now.' : 'The sun is down over Brisbane, so SEQ has no flare absorption right now.'} An X10 flare would raise it to about 35 MHz -- still only ~0.1 dB at 146 MHz.</p>`;
      $('#sw-path').innerHTML = `<div class="sw-kv"><span>Answer</span><b>${d.air && d.air.bytes ? d.air.bytes + ' B' : 'demo'}</b></div><div class="sw-kv"><span>Round trip</span><b>${d.air && d.air.secs ? d.air.secs.toFixed(1) + ' s' : '--'}</b></div><div class="sw-kv"><span>Answers / asks</span><b>${S.okN} / ${S.askN}</b></div>`;
      $('#sw-hex').textContent = S.hex ? S.hex.match(/.{1,2}/g).join(' ') : '(the demo radio has no bytes -- connect a radio to see the real answer as it crossed the air)';
    }
    function renderArcade() {
      const r = RANKS.reduce((a, x) => (Q.xp >= x[0] ? x : a), RANKS[0]), nx = RANKS.find(x => x[0] > Q.xp);
      $('#sw-rank').innerHTML = `<b>${esc(r[1])}</b><span class="sw-xp"><i style="width:${nx ? Math.round(100 * (Q.xp - r[0]) / (nx[0] - r[0])) : 100}%"></i></span><small>${Q.xp} XP · best drill ${Q.best} · ${Q.hits} forecasts right · ${Object.keys(Q.badges).length}/${BADGES.length} badges</small>`;
      $('#sw-badges').innerHTML = BADGES.map(([id, ic, name, how]) => `<div class="sw-b ${Q.badges[id] ? 'got' : ''}" title="${esc(how)}"><b>${ic}</b><span>${esc(name)}</span><small>${esc(how)}</small></div>`).join('');
      // prediction log
      const next = slotOf(Date.now()) + SLOT, made = Q.preds.find(p => p.slot === next), hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('#sw-pred').innerHTML = `<p>What will Kp be from <b>${hhmm(next)}</b> to <b>${hhmm(next + SLOT)}</b>? NOAA's real Kp scores it once that period is over (each answer you get brings the latest).</p>
        <div class="row gap wrap">${CATS.map((c, i) => `<button class="btn small ${made && made.cat === i ? 'primary' : ''}" data-pred="${i}" ${made ? 'disabled' : ''}>${c}</button>`).join('')}</div>
        <ul class="sw-preds">${Q.preds.slice(-8).reverse().map(p => `<li class="${p.res === 1 ? 'ok' : p.res === 0 ? 'bad' : ''}">${hhmm(p.slot)}-${hhmm(p.slot + SLOT)}: ${CATS[p.cat]} → ${p.res == null ? 'waiting for NOAA' : p.res < 0 ? 'no data' : `Kp ${p.kp.toFixed(1)} ${p.res ? '✔ +150' : '✖'}`}</li>`).join('') || '<li class="dim">No forecasts yet.</li>'}</ul>`;
      // drill (redraws only when its state changes)
      const h = $('#sw-drill'), dr = S.drill;
      if (!dr) { if (h.dataset.key !== 'idle') { h.dataset.key = 'idle'; h.innerHTML = `<p>Six quick scenarios: a flare, a storm or a proton event hits -- pick the move that keeps the message getting through, ${DRILL_S} s each. Scenarios are practice; the physics is real.</p><button class="btn primary big" id="sw-drill-go">▶ Start Blackout Survival</button>`; } }
      else {
        const left = dr.done ? 0 : Math.max(0, DRILL_S - (Date.now() - dr.at) / 1000), key = [dr.i, !!dr.res, dr.done].join('|');
        if (h.dataset.key === key) { const tm = $('#sw-time'); if (tm) tm.textContent = dr.done ? '--' : left.toFixed(1); }
        else {
          h.dataset.key = key;
          if (dr.done) h.innerHTML = `<div class="sw-end"><b>COMMS RESTORED</b><span>${dr.score}</span><small>${dr.ok}/${dr.order.length} right</small><button class="btn primary" id="sw-drill-go">Again</button></div>`;
          else { const s = SCEN[dr.order[dr.i]];
            h.innerHTML = `<div class="sw-hud"><span>Scenario <b>${dr.i + 1}/${dr.order.length}</b></span><span>Score <b>${dr.score}</b></span><span>Time <b id="sw-time">${left.toFixed(1)}</b></span><span class="tag warn">PRACTICE</span></div>
              <p class="sw-q">${esc(s.q)}</p><div class="sw-ans">${dr.shuf.map(j => `<button class="btn ${dr.res ? (j === s.ok ? 'right' : j === dr.res.j ? 'wrong' : '') : ''}" data-ans="${j}" ${dr.res ? 'disabled' : ''}>${esc(s.a[j])}</button>`).join('')}</div>
              ${dr.res ? `<p class="sw-why ${dr.res.ok ? 'ok' : 'bad'}">${dr.res.ok ? `✔ +${dr.res.pts}` : dr.res.j < 0 ? '⏰ Time' : '✖'} -- ${esc(dr.res.why)}</p>` : ''}`; }
        }
      }
      if (!$('#sw-school').dataset.done) school();
      $$cards();
    }
    function $$cards() { document.querySelectorAll('#sw-school .sw-card').forEach(c => c.classList.toggle('read', !!Q.school[c.dataset.card])); const l = document.querySelector('#sw-iono'); if (l) l.innerHTML = ionoSvg(S.ionoDay); }
    function ionoSvg(day) {
      const L = [['F2', 220, 400, '#7c5cff', 'F2: the main HF mirror, 220-400 km. Higher solar flux = denser = higher MUF.'], ['F1', 150, 220, '#00b8d9', 'F1: daytime only, merges into F2 at night.'], ['E', 90, 150, '#39ff88', 'E: daytime; sporadic-E patches open 6 m and 2 m in summer.'], ['D', 60, 90, '#ffb020', 'D: daytime only. Absorbs low HF -- and flare X-rays make it far worse.']];
      const y = km => 230 - (km - 40) * 0.55;
      return `<svg viewBox="0 0 520 240" class="sw-ionosvg"><rect width="520" height="240" rx="12" class="bg"/>${L.filter(([n]) => day || (n !== 'D' && n !== 'F1')).map(([n, a, b, c, t]) => `<rect x="10" y="${y(b)}" width="500" height="${y(a) - y(b)}" fill="${c}" opacity=".18"/><text x="18" y="${y(b) + 16}" class="ln" fill="${c}">${n}</text><text x="56" y="${y(b) + 16}" class="lt">${esc(t)}</text>`).join('')}
        <text x="500" y="228" text-anchor="end" class="lt">${day ? '☀ Day' : '🌙 Night: D and F1 gone -- low bands open up'}</text><line x1="10" y1="230" x2="510" y2="230" class="ground"/></svg>`;
    }
    function school() {
      const cards = [
        ['flare', '☀️ Solar flares and X-ray classes', 'Flares are classed by peak X-ray flux from GOES: A, B, C, M, X -- each letter ten times the last (C1 = 10⁻⁶ W/m², M1 = 10⁻⁵, X1 = 10⁻⁴). NOAA R scale: R1 = M1, R2 = M5, R3 = X1, R4 = X10, R5 = X20. The X-rays reach us in 8 minutes and only hit the sunlit side.'],
        ['kp', '🧲 The Kp index', 'Kp (0-9) measures how hard the geomagnetic field is being shaken, from magnetometers around the world every 3 hours. Kp 5 = G1 storm, 6 = G2, 7 = G3, 8 = G4, 9 = G5. Storms lower the MUF, bring aurora and upset GPS.'],
        ['s', '☢️ Radiation storms (S scale)', 'Energetic protons from big eruptions: S1 at 10 pfu above 10 MeV, rising tenfold per level. They upset satellites and black out HF over the poles -- ground VHF/UHF is untouched.'],
        ['muf', '📶 MUF and solar flux', 'The 10.7 cm solar flux (SFI) tracks the extreme UV that builds the F2 layer. Higher flux = higher critical frequency (foF2) = higher MUF, so 15, 12 and 10 m open up. At night the F2 layer thins and the MUF drops.'],
        ['p25', '📻 Why P25 shrugs it off', 'P25 runs on VHF and UHF, which go straight through the ionosphere -- coverage is line of sight from the repeater. Flare absorption falls with frequency to the power 1.5, so at 150-450 MHz it is a tiny fraction of a dB. The real effects: aurora or sporadic-E carrying distant signals in, and GPS position errors in big storms.'],
      ];
      $('#sw-school').innerHTML = `<div class="sw-iono-wrap"><div class="row gap"><b>Ionosphere layers</b><button class="btn small" id="sw-iono-tog">Show ${S.ionoDay ? 'night' : 'day'}</button></div><div id="sw-iono"></div></div>`
        + cards.map(([key, title, body]) => `<details class="sw-card" data-card="${key}"><summary>${title}</summary><p>${body}</p></details>`).join('');
      $('#sw-school').dataset.done = '1';
    }

    function init() {
      $('#sw-read').onclick = () => ask(false);
      $('#sw-every').onchange = e => { settings.swEvery = +e.target.value; saveSoon('settings'); autoTick(); };
      $('#sw-sfx').onchange = e => { settings.swSfx = e.target.checked; saveSoon('settings'); };
      $('#page-spacewx').addEventListener('click', e => {
        if (e.target.closest('#sw-drill-go')) { $('#sw-drill').dataset.key = ''; drillStart(); return; }
        const a = e.target.closest('[data-ans]'); if (a) { drillPick(+a.dataset.ans); return; }
        const p = e.target.closest('[data-pred]'); if (p) { predict(+p.dataset.pred); return; }
        if (e.target.closest('#sw-listen')) { listen(+$('#sw-band').value); return; }
        if (e.target.closest('#sw-iono-tog')) { S.ionoDay = !S.ionoDay; e.target.textContent = `Show ${S.ionoDay ? 'night' : 'day'}`; $$cards(); return; }
      });
      $('#page-spacewx').addEventListener('toggle', e => { const c = e.target.closest && e.target.closest('.sw-card'); if (c && c.open) { Q.school[c.dataset.card] = 1; saveQ(); if (Object.keys(Q.school).length >= 5) badge('scholar'); $$cards(); } }, true);
      setInterval(() => { if (onPage() && S.drill && !S.drill.done) dirty('spacewx'); }, 250);
    }
    function shown() { setTimeout(autoTick, 400); dirty('spacewx'); }
    return { init, render, shown, gatewayReply, kfEvent, ownsXid: xid => !!(S.ask && S.ask.xid === xid) };
  };
})();
