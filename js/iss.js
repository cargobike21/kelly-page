/* Kelly Page -- ISS Tracker & Auto-Tuner page (2026-10-18, unreleased): predicts ISS passes over the station, shows them
 * live, and can retune the attached Tait radio for each pass -- then put it back exactly as it was.
 *
 * Elements: KF kind 3 {op: 'tle'} -> kind 4 {app: 'tle', n, l1, l2, ep} from the dashboard's iss-tle.js (CelesTrak),
 * asked at most once a day (TLEs stay good for days); kept in store `issTle`; a built-in set from 2026-10-18 until then.
 * Orbit, passes and Doppler: js/issorbit.js on satellite.js SGP4 (vendor/, MIT) -- tests/iss-tests.html. Doppler from
 * the real range rate: f_rx = f (1 - rr / c), about +-3.4 kHz at 145.800 MHz for the ISS.
 * Position: Kelly's own (Fixed position or the radio's GPS fix -- app.js apnMine), else the browser's, else typed in.
 *
 * Radio automation (RECEIVE ONLY -- nothing here ever keys the transmitter), armed per station, with a dry run:
 *   T-5 min  alarm + toast.
 *   AOS      save zone / channel / volume, then either
 *            ccr  -- enter CCR, analogue FM (UZB 0), wide bandwidth (H3), volume (J), squelch override (M D) and the
 *                    Doppler-corrected receive frequency (R, Hz), retuned whenever it moves a tuning step; or
 *            bank -- CCDI volume control + volume, monitor (squelch override) on, and "go to channel" through a
 *                    5-channel Doppler bank (default zone 3, CH1 +5 / CH2 +2.5 / CH3 145.800 / CH4 -2.5 / CH5 -5 kHz).
 *   LOS+15 s ccr: leave CCR (the radio reboots ~10 s) -- then both: back to the saved channel, volume, monitor off.
 * A bench "test pass" runs the same machine on a made-up 2.5-minute pass. Every command lands in the log.
 *
 * Tabs (data-tabs="iss"): orbit (map, sky dome, Doppler curve, live numbers), auto (next pass, pass table, radio
 * controls + lamps + command log), audio (listen / spectrum / record, pass log, badges), help (frequencies, channel
 * spacing, Doppler steps with live numbers, programming table, setup guide).
 * Effects are one-shot: AOS chirp + Doppler sweep, squelch-open hiss, pass-complete fanfare, pre-pass alarm. The
 * spectrum runs only while the user listens (kelly-page/CLAUDE.md "Flashy, but nothing loops forever").
 *
 * window.KellyIssUI(ctx) -> { init, render, shown, gatewayReply, ownsXid, kfEvent }; ctx from app.js.
 */
(function () {
  'use strict';
  const O = () => window.KellyIssOrbit;
  const DEMO_TLE = { n: 'ISS (ZARYA)', l1: '1 25544U 98067A   26291.14461894  .00007503  00000+0  14456-3 0  9994', l2: '2 25544  51.6328  51.6259 0006780 277.7856  82.2363 15.48918166590814', ep: '2026-10-18T03:28:15.076Z', builtin: true };
  const BANK = [5000, 2500, 0, -2500, -5000];
  const BADGES = [
    ['first', '🛰️', 'First Pass', 'Track your first ISS pass'],
    ['high', '⬆️', 'Overhead!', 'Track a pass higher than 70 degrees'],
    ['doppler', '📐', 'Doppler Corrected', 'Retune 10+ times in one CCR pass'],
    ['bank', '🏦', 'Bank Walker', 'Step the 5-channel bank through 3+ channels in a pass'],
    ['bench', '🔧', 'Bench Tested', 'Run a test pass through the radio'],
    ['rec', '🎙️', 'Captured', 'Record audio during a pass'],
    ['night', '🌙', 'Night Owl', 'Track a pass between 10 pm and 5 am'],
    ['five', '🌍', 'Regular Orbiter', 'Track 5 passes'],
    ['fresh', '📡', 'Fresh Elements', 'Get the ISS elements over P25'],
  ];
  const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const hms = t => new Date(t).toLocaleTimeString([], { hour12: false });
  const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const compass = a => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(a / 22.5) % 16];
  const khz = hz => `${hz >= 0 ? '+' : ''}${(hz / 1000).toFixed(2)} kHz`;
  const mhz = hz => (hz / 1e6).toFixed(4) + ' MHz';

  window.KellyIssUI = function (k) {
    const { $, esc, store, toast, dirty, settings, saveSoon, fmtAgo } = k;
    const C = k.C;
    const cfg = settings.iss = Object.assign({ mode: 'ccr', armed: false, dry: true, zone: 3, chBase: 1, centerHz: 145800000, stepHz: 500, vol: 16, minEl: 10, pre: 5, tail: 15, analog: true, autoRec: false,
      pos: 'auto', lat: '', lon: '', sfx: true }, settings.iss || {});
    const S = { tle: store.get('issTle', null) || DEMO_TLE, rec: null, passes: [], passAt: 0, obs: null, ask: null, err: '', map: null, lay: null, now: null,
      ap: { phase: 'idle', pass: null, saved: null, lastHz: null, lastCh: null, retunes: 0, chans: new Set(), busy: false, tailUntil: 0, prewarned: 0 }, log: [], listen: null, geo: null };
    const Q = Object.assign({ xp: 0, badges: {}, passes: [] }, store.get('issQuest', {}));
    const saveQ = () => store.set('issQuest', Q);
    const save = () => saveSoon('settings');
    const onPage = () => k.currentPage() === 'iss' && !document.hidden;
    const tab = () => { const b = $('[data-tabs="iss"] button.on'); return b ? b.dataset.tab : 'orbit'; };
    function setTle(t) { S.tle = t; try { S.rec = O().rec(t.l1, t.l2); } catch (e) { S.err = 'Bad orbital elements: ' + e.message; S.rec = null; } S.passAt = 0; }

    // ------------------------------------------------------------ where we are
    function observer() {
      if (cfg.pos === 'manual' && cfg.lat !== '' && cfg.lon !== '') return { lat: +cfg.lat, lon: +cfg.lon, alt: 0.05, src: 'typed in' };
      if (cfg.pos !== 'browser') { const m = k.myPos && k.myPos(); if (m) return { lat: m.lat, lon: m.lon, alt: 0.05, src: 'Kelly position (APRS / GPS)' }; }
      if (S.geo) return { ...S.geo, alt: 0.05, src: 'browser location' };
      if (cfg.lat !== '' && cfg.lon !== '') return { lat: +cfg.lat, lon: +cfg.lon, alt: 0.05, src: 'typed in' };
      return null;
    }
    function askBrowser() {
      if (!navigator.geolocation) { toast('📍', 'No browser location', 'Type your latitude and longitude instead', 'bad'); return; }
      navigator.geolocation.getCurrentPosition(p => { S.geo = { lat: p.coords.latitude, lon: p.coords.longitude }; cfg.pos = 'browser'; save(); S.passAt = 0; dirty('iss'); },
        e => toast('📍', 'Location refused', e.message, 'bad'), { timeout: 15000 });
    }

    // ------------------------------------------------------------ sound (synth, one-shot)
    const clicked = () => !navigator.userActivation || navigator.userActivation.hasBeenActive;
    function snd(kind) {
      if (!cfg.sfx || !clicked()) return;
      let c; try { c = k.audioCtx(); } catch { return; }
      const t0 = c.currentTime + 0.01, vol = (settings.soundVol == null ? 0.8 : +settings.soundVol) * 0.5;
      const tone = (f, t, d, type = 'sine', g = 0.12, f2) => { const o = c.createOscillator(), a = c.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d); a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(g * vol + 0.0001, t + 0.01); a.gain.exponentialRampToValueAtTime(0.0001, t + d); o.connect(a).connect(c.destination); o.start(t); o.stop(t + d + 0.05); };
      const hiss = (t, d) => { const b = c.createBuffer(1, Math.ceil(c.sampleRate * d), c.sampleRate), x = b.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1; const s = c.createBufferSource(), f = c.createBiquadFilter(), a = c.createGain(); s.buffer = b; f.type = 'bandpass'; f.frequency.value = 2500; a.gain.setValueAtTime(0.16 * vol, t); a.gain.exponentialRampToValueAtTime(0.0001, t + d); s.connect(f).connect(a).connect(c.destination); s.start(t); };
      if (kind === 'aos') { [1200, 1600, 2000].forEach((f, i) => tone(f, t0 + i * 0.09, 0.08, 'square', 0.06)); tone(1400, t0 + 0.35, 1.4, 'sine', 0.08, 900); }   // telemetry chirp + Doppler sweep
      else if (kind === 'pre') for (let i = 0; i < 3; i++) { tone(880, t0 + i * 0.5, 0.18, 'triangle'); tone(1320, t0 + i * 0.5 + 0.2, 0.18, 'triangle'); }
      else if (kind === 'squelch') hiss(t0, 0.35);
      else if (kind === 'done') [523, 659, 784, 1047].forEach((f, i) => tone(f, t0 + i * 0.12, i === 3 ? 0.5 : 0.12, 'square', 0.07));
      else if (kind === 'badge') [784, 988, 1175, 1568].forEach((f, i) => tone(f, t0 + i * 0.09, i === 3 ? 0.4 : 0.1, 'triangle', 0.12));
    }
    function badge(id) {
      if (Q.badges[id]) return;
      const b = BADGES.find(x => x[0] === id); if (!b) return;
      Q.badges[id] = Date.now(); Q.xp += 100; saveQ(); snd('badge');
      const pop = $('#is-pop'); if (pop) { pop.innerHTML = `<div class="is-badge-pop"><b>${b[1]}</b><span>BADGE UNLOCKED</span><strong>${esc(b[2])}</strong><small>${esc(b[3])} · +100 XP</small></div>`; pop.hidden = false; clearTimeout(S.popT); S.popT = setTimeout(() => { pop.hidden = true; }, 3500); }
      dirty('iss');
    }

    // ------------------------------------------------------------ elements over P25 (= dams.js pattern)
    async function ask(auto) {
      if (S.ask) return;
      if (auto && (k.demo() || !k.radioConnected() || k.rfBusy())) return;
      S.err = '';
      if (k.demo()) { toast('🛰️', 'Demo radio', 'Using the built-in elements from 2026-10-18 -- connect a radio to fetch fresh ones'); return; }
      if (!k.radioConnected()) { S.err = 'Offline -- connect the radio to ask the P25X gateway'; dirty('iss'); return; }
      S.ask = { xid: 0, at: Date.now(), auto };
      const xid = await k.kfRequest({ op: 'tle' }, 'ISS elements');
      S.ask = xid ? { xid, at: Date.now(), auto } : null;
      if (!xid && !auto) S.err = 'The radio is busy -- try again in a moment';
      dirty('iss');
    }
    function kfEvent(e) {
      if (!S.ask) return;
      if (e.kind === 'tx-failed') { S.err = e.cancelled ? '' : 'No answer from the P25X gateway'; S.ask = null; }
      if (e.kind === 'tx-done') { const xid = S.ask.xid; setTimeout(() => { if (S.ask && S.ask.xid === xid && !k.rfRx()) { S.ask = null; S.err = 'The gateway never answered'; dirty('iss'); } }, 90000); }
      dirty('iss');
    }
    function gatewayReply(j) {
      S.ask = null;
      if (j.error) { S.err = j.error; dirty('iss'); return; }
      const t = { n: j.n, l1: j.l1, l2: j.l2, ep: j.ep, got: Date.now() };
      store.set('issTle', t); setTle(t); badge('fresh');
      k.addEvent('data', `ISS elements over P25 (epoch ${j.ep.slice(0, 16)})`);
      dirty('iss');
    }

    // ------------------------------------------------------------ radio automation (receive only)
    function log(dir, label, wire, ok) { S.log.unshift({ t: Date.now(), dir, label, wire: wire || '', ok }); if (S.log.length > 120) S.log.pop(); if (tab() === 'auto') dirty('iss'); }
    async function act(label, frame) {   // one radio command, or just the log in a dry run
      if (cfg.dry) { log('dry', label, frame); return true; }
      if (!k.radioConnected()) { log('err', label + ' -- radio offline', frame, false); return false; }
      const r = await k.send(frame, { label: 'ISS: ' + label, quiet: true });
      log(r.ok ? 'tx' : 'err', label + (r.ok ? '' : ` -- ${r.error || 'no ACK'}`), frame, r.ok);
      return r.ok;
    }
    async function step(label, fn) {   // CCR entry / exit (which run their own command sequences)
      if (cfg.dry) { log('dry', label); return true; }
      if (!k.radioConnected()) { log('err', label + ' -- radio offline', '', false); return false; }
      const r = await fn(); const ok = r === true || (r && r.ok);
      log(ok ? 'tx' : 'err', label + (ok ? '' : ' -- failed'), '', ok); return ok;
    }
    const shiftAt = (p, t) => (p.synthetic ? p.shift(t) : (() => { const l = O().look(S.rec, t, S.obs); return l ? O().rxHz(cfg.centerHz, l.rr) - cfg.centerHz : 0; })());
    async function aos(p) {
      const A = S.ap; A.phase = 'active'; A.pass = p; A.retunes = 0; A.lastHz = null; A.lastCh = null; A.chans = new Set(); A.busy = true;
      const r = k.radio(); A.saved = { zone: r.zone, channel: r.channel, volume: r.volume == null ? 12 : r.volume };
      log('info', `AOS${p.synthetic ? ' (bench test)' : ''} -- saved zone ${A.saved.zone ?? '?'} ch ${A.saved.channel ?? '?'} vol ${A.saved.volume}`);
      snd('aos'); if (onPage()) toast('🛰️', p.synthetic ? 'Bench test pass' : 'ISS pass -- AOS', cfg.mode === 'ccr' ? 'Retuning in CCR for Doppler' : 'Stepping the Doppler bank', 'good');
      if (cfg.mode === 'ccr') {
        if (await step('Enter CCR', () => k.enterCcr())) {
          if (cfg.analog) await step('Analogue FM (UZB 0)', () => k.ccrP25('B', '0', { label: 'ISS: analogue FM', expect: '+', quiet: true }));
          await act('Wide bandwidth (H3)', C.ccr.bandwidth(3));
          await act(`Volume ${Math.round(cfg.vol / 25 * 255)}/255`, C.ccr.volume(Math.round(cfg.vol / 25 * 255)));
          await act('Squelch override on (M D)', C.ccr.monitor(true));
        }
      } else {
        await act('CCDI volume control on', C.cmd.volumeControl(true));
        await act(`Volume ${cfg.vol}/25`, C.cmd.volume(cfg.vol));
        await act('Monitor (squelch override) on', C.cmd.monitor(true));
      }
      snd('squelch');
      A.busy = false;
      if (cfg.autoRec && !S.listen) startListen(true);
    }
    async function track(now) {
      const A = S.ap; if (A.busy || !A.pass) return;
      const sh = shiftAt(A.pass, now);
      A.busy = true;
      if (cfg.mode === 'ccr') {
        const f = Math.round((cfg.centerHz + sh) / cfg.stepHz) * cfg.stepHz;
        if (f !== A.lastHz) { await act(`Rx ${mhz(f)} (${khz(sh)})`, C.ccr.rxFreq(f)); A.lastHz = f; A.retunes++; }
      } else {
        const i = O().bankChannel(sh, BANK), ch = cfg.chBase + i;
        if (ch !== A.lastCh) { await act(`Zone ${cfg.zone} CH${ch} (${khz(BANK[i])}, Doppler ${khz(sh)})`, C.cmd.goToChannel(ch, cfg.zone)); A.lastCh = ch; A.chans.add(ch); A.retunes++; }
      }
      A.busy = false;
    }
    async function restore() {
      const A = S.ap; A.phase = 'restore'; A.busy = true;
      if (cfg.mode === 'ccr') await step('Leave CCR (the radio reboots, ~10 s)', () => k.leaveCcr());
      const s = A.saved || {};
      if (s.channel != null) await act(`Back to zone ${s.zone ?? ''} CH${s.channel}`, C.cmd.goToChannel(s.channel, s.zone ?? ''));
      await act('CCDI volume control on', C.cmd.volumeControl(true));
      await act(`Volume back to ${s.volume}/25`, C.cmd.volume(s.volume));
      await act('Monitor off', C.cmd.monitor(false));
      const p = A.pass;
      log('info', `Pass complete -- ${A.retunes} retune(s); radio restored`);
      if (S.listen && S.listen.auto) stopListen();
      if (p && !p.synthetic) {
        Q.passes.unshift({ at: p.aos, maxEl: Math.round(p.maxEl), retunes: A.retunes, mode: cfg.mode, dry: cfg.dry, rec: !!A.recorded }); Q.passes = Q.passes.slice(0, 50); Q.xp += 50 + Math.round(p.maxEl); saveQ();
        badge('first'); if (p.maxEl > 70) badge('high'); if (Q.passes.length >= 5) badge('five');
        const h = new Date(p.aos).getHours(); if (h >= 22 || h < 5) badge('night');
        if (cfg.mode === 'ccr' && A.retunes >= 10 && !cfg.dry) badge('doppler'); if (cfg.mode === 'bank' && A.chans.size >= 3 && !cfg.dry) badge('bank');
      } else if (p && p.synthetic && !cfg.dry) badge('bench');
      snd('done');
      A.phase = 'idle'; A.pass = null; A.busy = false; dirty('iss');
    }
    function benchTest() {
      if (S.ap.phase !== 'idle' && S.ap.phase !== 'pre') { toast('🛰️', 'A pass is running', 'Wait for it to finish', 'bad'); return; }
      const t0 = Date.now() + 2000, len = 150000;
      const p = { synthetic: true, aos: t0, los: t0 + len, tca: t0 + len / 2, maxEl: 60, azAos: 300, azLos: 120, shift: t => 3400 * Math.cos(Math.PI * Math.min(1, Math.max(0, (t - t0) / len))),
        track: Array.from({ length: 16 }, (_, i) => ({ t: t0 + i * len / 15, az: (300 + i * 12) % 360, el: 60 * Math.sin(Math.PI * i / 15) })) };
      S.bench = p; log('info', `Bench test pass armed: AOS in 2 s, 2.5 min long${cfg.dry ? ' (DRY RUN -- nothing sent)' : ''}`); dirty('iss');
    }
    function cancel() { if (S.ap.phase === 'active' || S.ap.phase === 'tail') { log('info', 'Cancelled -- restoring now'); S.bench = null; restore(); } }

    // ------------------------------------------------------------ the 1 s tick (runs whenever Kelly is open, so an armed pass fires on any page)
    function tick() {
      S.obs = observer();
      const now = Date.now();
      if (S.rec && S.obs && (now - S.passAt > 10 * 60e3 || !S.passes.length || S.passes[0].los < now)) {
        try { S.passes = O().passes(S.rec, S.obs, now - 15 * 60e3, 48, +cfg.minEl).filter(p => p.los > now - 60e3); } catch (e) { S.err = e.message; }
        S.passAt = now;
      }
      S.now = S.rec && S.obs ? O().look(S.rec, now, S.obs) : null;
      if (S.now) S.now.shift = O().rxHz(cfg.centerHz, S.now.rr) - cfg.centerHz;
      const A = S.ap, next = S.bench || S.passes.find(p => p.los > now);
      if (A.phase === 'idle' || A.phase === 'pre') {
        if (next && (cfg.armed || next.synthetic) && cfg.mode !== 'off') {
          if (!next.synthetic && next.aos - now <= cfg.pre * 60e3 && next.aos > now && A.prewarned !== next.aos) { A.prewarned = next.aos; A.phase = 'pre'; snd('pre'); toast('🛰️', `ISS pass in ${Math.ceil((next.aos - now) / 60e3)} min`, `Max ${next.maxEl.toFixed(0)}° · AOS ${hm(next.aos)} from the ${compass(next.azAos)}`); log('info', `Pre-pass alarm: AOS ${hms(next.aos)}, max ${next.maxEl.toFixed(0)} deg`); }
          if (now >= next.aos && now < next.los) aos(next);
        }
      } else if (A.phase === 'active') {
        if (now >= A.pass.los) { A.phase = 'tail'; A.tailUntil = now + cfg.tail * 1000; log('info', `LOS -- restoring in ${cfg.tail} s`); }
        else track(now);
      } else if (A.phase === 'tail' && now >= A.tailUntil) { S.bench = null; restore(); }
      if (onPage()) dirty('iss');
    }

    // ------------------------------------------------------------ listening: spectrum + recorder (only while the user asks)
    async function startListen(auto) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        const c = k.audioCtx(), src = c.createMediaStreamSource(stream), an = c.createAnalyser(); an.fftSize = 2048; src.connect(an);
        const chunks = [], mr = window.MediaRecorder ? new MediaRecorder(stream) : null;
        if (mr) { mr.ondataavailable = e => e.data.size && chunks.push(e.data); mr.start(1000); }
        S.listen = { stream, an, mr, chunks, at: Date.now(), auto: !!auto, raf: 0 };
        if (S.ap.phase === 'active') S.ap.recorded = true;
        drawSpectrum(); dirty('iss');
      } catch (e) { toast('🎙️', 'No audio input', e.message + ' -- connect the radio speaker / line out to the PC input', 'bad'); }
    }
    function stopListen() {
      const L = S.listen; if (!L) return;
      cancelAnimationFrame(L.raf); L.stream.getTracks().forEach(t => t.stop());
      if (L.mr && L.mr.state !== 'inactive') { L.mr.onstop = () => { const blob = new Blob(L.chunks, { type: L.mr.mimeType || 'audio/webm' }); S.lastRec = { url: URL.createObjectURL(blob), at: L.at, secs: Math.round((Date.now() - L.at) / 1000), type: blob.type }; badge('rec'); dirty('iss'); }; L.mr.stop(); }
      S.listen = null; dirty('iss');
    }
    function drawSpectrum() {
      const L = S.listen, cv = $('#is-wf'); if (!L || !cv) return;
      const g = cv.getContext('2d'), W = cv.width = cv.clientWidth || 600, H = cv.height = 220, buf = new Uint8Array(L.an.frequencyBinCount), bins = Math.floor(buf.length * 0.4);
      const step = () => {
        if (!S.listen) return;
        L.an.getByteFrequencyData(buf);
        const img = g.getImageData(0, 0, W, H - 61); g.putImageData(img, 0, 1);   // waterfall scrolls down
        for (let x = 0; x < W; x++) { const v = buf[Math.floor(x / W * bins)]; g.fillStyle = `hsl(${240 - v * 0.9}, 100%, ${Math.min(60, v / 3)}%)`; g.fillRect(x, 0, 1, 1); }
        g.fillStyle = '#050912'; g.fillRect(0, H - 60, W, 60); g.strokeStyle = '#39ff88'; g.beginPath();
        for (let x = 0; x < W; x++) { const v = buf[Math.floor(x / W * bins)]; const y = H - 2 - v / 255 * 56; x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
        L.raf = requestAnimationFrame(step);
      };
      step();
    }

    // ------------------------------------------------------------ drawing
    function initMap() {
      if (S.map || !window.L || !$('#is-map')) return;
      const L = window.L;
      S.map = L.map('is-map', { worldCopyJump: true, attributionControl: true }).setView([-20, 150], 2);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Tiles &copy; Esri · elements CelesTrak', maxZoom: 8 }).addTo(S.map);
      S.lay = { track: L.polyline([], { color: '#00e5ff', weight: 1.5, opacity: 0.6, dashArray: '4 6' }).addTo(S.map), foot: L.circle([0, 0], { radius: 1, color: '#39ff88', weight: 1, fillOpacity: 0.06 }).addTo(S.map),
        iss: L.marker([0, 0], { icon: L.divIcon({ className: 'is-iss', html: '<b>🛰️</b><span>ISS</span>', iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 900 }).addTo(S.map), me: null };
    }
    function drawMap() {
      if (!S.map || !S.now) return;
      const L = window.L, now = Date.now(), pts = [];
      for (let t = now - 10 * 60e3; t <= now + 90 * 60e3; t += 60e3) { const l = O().look(S.rec, t, S.obs); if (l) pts.push([l.lat, l.lon]); }
      const segs = [[]]; pts.forEach((p, i) => { if (i && Math.abs(p[1] - pts[i - 1][1]) > 180) segs.push([]); segs[segs.length - 1].push(p); });   // break at the date line
      S.lay.track.setLatLngs(segs); S.lay.iss.setLatLng([S.now.lat, S.now.lon]);
      S.lay.foot.setLatLng([S.now.lat, S.now.lon]); S.lay.foot.setRadius(O().footprintKm(S.now.alt) * 1000);
      if (!S.lay.me) S.lay.me = L.marker([S.obs.lat, S.obs.lon], { icon: L.divIcon({ className: 'is-me', html: '<b>📻</b>', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(S.map);
      else S.lay.me.setLatLng([S.obs.lat, S.obs.lon]);
    }
    function skySvg(p) {
      const R = 120, c = 140, xy = (az, el) => { const r = R * (90 - Math.max(0, el)) / 90, a = (az - 90) * Math.PI / 180; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
      let s = `<svg viewBox="0 0 280 280" class="is-sky"><circle cx="${c}" cy="${c}" r="${R}" class="ring"/><circle cx="${c}" cy="${c}" r="${R * 2 / 3}" class="ring"/><circle cx="${c}" cy="${c}" r="${R / 3}" class="ring"/>`
        + `<line x1="${c}" y1="${c - R}" x2="${c}" y2="${c + R}" class="ring"/><line x1="${c - R}" y1="${c}" x2="${c + R}" y2="${c}" class="ring"/>`
        + ['N', 'E', 'S', 'W'].map((n, i) => { const [x, y] = xy(i * 90, -8); return `<text x="${x}" y="${y + 4}" text-anchor="middle" class="cd">${n}</text>`; }).join('')
        + `<text x="${c + 4}" y="${c - R / 3 + 12}" class="el">60°</text><text x="${c + 4}" y="${c - R * 2 / 3 + 12}" class="el">30°</text>`;
      if (p) {
        s += `<polyline class="trk" points="${p.track.map(q => xy(q.az, q.el).join(',')).join(' ')}"/>`;
        const [ax, ay] = xy(p.azAos, 0), [lx, ly] = xy(p.azLos, 0); s += `<circle cx="${ax}" cy="${ay}" r="5" class="aos"/><circle cx="${lx}" cy="${ly}" r="5" class="los"/>`;
        const now = Date.now(), live = p.synthetic ? (now >= p.aos && now <= p.los ? p.track[Math.min(p.track.length - 1, Math.floor((now - p.aos) / (p.los - p.aos) * (p.track.length - 1)))] : null) : (S.now && S.now.el > 0 && now >= p.aos - 60e3 && now <= p.los ? S.now : null);
        if (live) { const [x, y] = xy(live.az, live.el); s += `<circle cx="${x}" cy="${y}" r="7" class="now"/>`; }
      }
      return s + '</svg>';
    }
    function dopSvg(p) {
      const W = 520, H = 200, y = hz => H / 2 - hz / 5000 * (H / 2 - 14);
      let s = `<svg viewBox="0 0 ${W} ${H}" class="is-dop">` + [5000, 2500, 0, -2500, -5000].map((hz, i) => `<line x1="40" x2="${W - 6}" y1="${y(hz)}" y2="${y(hz)}" class="${hz ? 'gl' : 'gz'}"/><text x="34" y="${y(hz) + 4}" text-anchor="end" class="gt">CH${cfg.chBase + i}</text>`).join('');
      if (p) {
        const x = t => 40 + (t - p.aos) / (p.los - p.aos) * (W - 50), pts = [];
        for (let t = p.aos; t <= p.los; t += Math.max(1000, (p.los - p.aos) / 120)) pts.push(`${x(t).toFixed(1)},${y(shiftAt(p, t)).toFixed(1)}`);
        s += `<polyline points="${pts.join(' ')}" class="curve"/><text x="40" y="${H - 2}" class="gt">AOS ${hm(p.aos)}</text><text x="${W - 6}" y="${H - 2}" text-anchor="end" class="gt">LOS ${hm(p.los)}</text>`;
        const now = Date.now(); if (now >= p.aos && now <= p.los) s += `<circle cx="${x(now)}" cy="${y(shiftAt(p, now))}" r="5" class="now"/>`;
      }
      return s + '</svg>';
    }

    function render() {
      $('#page-iss').classList.toggle('is-noobs', !S.obs);
      $('#is-where').textContent = S.obs ? `📍 ${S.obs.lat.toFixed(3)}, ${S.obs.lon.toFixed(3)} · ${S.obs.src}` : '📍 no position yet';
      $('#is-tle').textContent = `Elements epoch ${S.tle.ep ? S.tle.ep.slice(0, 16).replace('T', ' ') : '?'} UTC${S.tle.builtin ? ' (built in)' : S.tle.got ? ` · fetched ${fmtAgo(S.tle.got)}` : ''}`;
      const e = $('#is-err'); e.hidden = !S.err; e.textContent = S.err;
      const now = Date.now(), A = S.ap, cur = A.pass || S.bench || S.passes.find(p => p.los > now);
      const phaseTxt = { idle: cfg.armed && cfg.mode !== 'off' ? 'ARMED -- waiting for the next pass' : 'Disarmed', pre: 'PRE-PASS -- AOS soon', active: 'TRACKING', tail: 'LOS -- holding before restore', restore: 'RESTORING the radio' }[A.phase];
      $('#is-phase').textContent = phaseTxt + (cfg.dry ? ' · DRY RUN' : ''); $('#is-phase').className = 'is-phase ' + A.phase + (cfg.armed ? ' armed' : '');
      const t = tab();
      if (t === 'orbit') renderOrbit(cur); else if (t === 'auto') renderAuto(cur); else if (t === 'audio') renderAudio(); else renderHelp();
    }
    function renderOrbit(cur) {
      if (!S.map) { initMap(); setTimeout(() => S.map && S.map.invalidateSize(), 60); }
      drawMap();
      const n = S.now;
      $('#is-live').innerHTML = n ? [['Latitude', n.lat.toFixed(2) + '°'], ['Longitude', n.lon.toFixed(2) + '°'], ['Altitude', n.alt.toFixed(0) + ' km'], ['Speed', (n.v * 3600).toFixed(0) + ' km/h'],
        ['Azimuth', `${n.az.toFixed(0)}° ${compass(n.az)}`], ['Elevation', n.el.toFixed(1) + '°'], ['Range', n.range.toFixed(0) + ' km'], ['Doppler now', khz(n.shift)]].map(([a, b]) => `<div class="is-kv ${a === 'Elevation' && n.el > 0 ? 'up' : ''}"><span>${a}</span><b>${b}</b></div>`).join('') : '<p class="dim">Set your position (Radio Automation tab) to see the ISS from your station.</p>';
      const sk = $('#is-sky'), key = cur ? cur.aos + ':' + Math.floor(Date.now() / 2000) : 'none'; if (sk.dataset.k !== key) { sk.dataset.k = key; sk.innerHTML = skySvg(cur); $('#is-dopc').innerHTML = dopSvg(cur); }
      $('#is-skycap').textContent = cur ? `${cur.synthetic ? 'Bench test pass' : 'Pass'} ${hm(cur.aos)}-${hm(cur.los)} · max ${cur.maxEl.toFixed(0)}° · rises ${compass(cur.azAos)}, sets ${compass(cur.azLos)}` : 'No pass in the next 48 h above your minimum elevation';
    }
    function renderAuto(cur) {
      const now = Date.now(), r = k.radio(), A = S.ap;
      $('#is-next').innerHTML = cur ? `<div class="is-count"><span>${now < cur.aos ? 'AOS in' : now < cur.los ? 'LOS in' : 'Done'}</span><b>${dur((now < cur.aos ? cur.aos : cur.los) - now)}</b></div>
        <div class="is-kvs"><div class="is-kv"><span>AOS</span><b>${hms(cur.aos)} ${compass(cur.azAos)}</b></div><div class="is-kv"><span>Max elevation</span><b>${cur.maxEl.toFixed(0)}° at ${hm(cur.tca)}</b></div><div class="is-kv"><span>LOS</span><b>${hms(cur.los)} ${compass(cur.azLos)}</b></div><div class="is-kv"><span>Duration</span><b>${dur(cur.los - cur.aos)}</b></div></div>`
        : '<p class="dim">No pass found yet -- check your position and minimum elevation.</p>';
      $('#is-passes').innerHTML = S.passes.slice(0, 12).map(p => `<tr class="${p.maxEl > 70 ? 'hi' : p.maxEl > 40 ? 'good' : ''}"><td>${new Date(p.aos).toLocaleDateString([], { weekday: 'short', day: 'numeric' })}</td><td>${hms(p.aos)}</td><td>${p.maxEl.toFixed(0)}°</td><td>${hms(p.los)}</td><td>${dur(p.los - p.aos)}</td><td>${compass(p.azAos)} → ${compass(p.azLos)}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">No passes</td></tr>';
      const lamps = [['Radio link', k.radioConnected() ? 'ok' : 'bad', k.radioConnected() ? `${r.model || 'radio'} · ${k.connMode()}` : 'offline'], ['Auto-tune', cfg.armed && cfg.mode !== 'off' ? 'ok' : 'off', cfg.armed ? (cfg.mode === 'ccr' ? 'armed · CCR Doppler' : 'armed · channel bank') : 'disarmed'],
        ['Now on', A.phase === 'active' ? 'ok' : 'off', A.phase === 'active' ? (cfg.mode === 'ccr' ? (A.lastHz ? mhz(A.lastHz) : '...') : `zone ${cfg.zone} CH${A.lastCh || '?'}`) : `zone ${r.zone ?? '?'} CH${r.channel ?? '?'}`],
        ['Squelch', A.phase === 'active' || r.monitor ? 'warn' : 'off', A.phase === 'active' ? 'OPEN (override)' : r.monitor ? 'open' : 'normal'], ['Mode', cfg.dry ? 'warn' : 'ok', cfg.dry ? 'DRY RUN -- nothing sent' : 'LIVE -- commands go to the radio']];
      $('#is-lamps').innerHTML = lamps.map(([n, st, v]) => `<div class="is-lamp ${st}"><i></i><span>${n}</span><b>${esc(v)}</b></div>`).join('');
      $('#is-log').innerHTML = S.log.slice(0, 60).map(l => `<li class="${l.dir}"><time>${hms(l.t)}</time> ${l.dir === 'dry' ? '<em>DRY</em> ' : l.dir === 'tx' ? '→ ' : l.dir === 'err' ? '✖ ' : '· '}${esc(l.label)}${l.wire ? ` <code>${esc(String(l.wire).replace(/\r/g, ''))}</code>` : ''}</li>`).join('') || '<li class="dim">No commands yet -- try a bench test pass (dry run first).</li>';
      const busy = A.phase !== 'idle' && A.phase !== 'pre';
      $('#is-cancel').disabled = !busy; $('#is-bench').disabled = busy;
    }
    function renderAudio() {
      const L = S.listen;
      $('#is-listen').textContent = L ? `⏹ Stop (${dur(Date.now() - L.at)})` : '🎙️ Listen & record';
      $('#is-reclink').innerHTML = S.lastRec ? `<a class="btn small" href="${S.lastRec.url}" download="iss-pass-${new Date(S.lastRec.at).toISOString().slice(0, 16).replace(/[:T]/g, '')}.${/ogg/.test(S.lastRec.type) ? 'ogg' : 'webm'}">💾 Save recording (${S.lastRec.secs} s)</a>` : '';
      $('#is-plog').innerHTML = Q.passes.slice(0, 15).map(p => `<li>${new Date(p.at).toLocaleString([], { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · max ${p.maxEl}° · ${p.retunes} retunes · ${p.mode}${p.dry ? ' (dry run)' : ''}${p.rec ? ' · 🎙️' : ''}</li>`).join('') || '<li class="dim">No passes tracked yet -- arm the auto-tuner and leave Kelly open.</li>';
      $('#is-badges').innerHTML = BADGES.map(([id, ic, n, how]) => `<div class="is-b ${Q.badges[id] ? 'got' : ''}" title="${esc(how)}"><b>${ic}</b><span>${esc(n)}</span><small>${esc(how)}</small></div>`).join('');
      $('#is-xp').textContent = `${Q.xp} XP · ${Q.passes.length} passes logged · ${Object.keys(Q.badges).length}/${BADGES.length} badges`;
    }
    function renderHelp() {
      // the biggest shift is at the horizon: measure it on the coming passes rather than guess
      const n = S.now, mx = S.passes.length ? Math.max(...S.passes.slice(0, 8).map(p => Math.abs(shiftAt(p, p.aos)))) : 3400;
      $('#is-livehelp').innerHTML = `Right now the ISS is ${n ? `${n.range.toFixed(0)} km away, ${n.rr >= 0 ? 'receding' : 'approaching'} at ${Math.abs(n.rr).toFixed(2)} km/s, so 145.800 MHz arrives at <b>${mhz(cfg.centerHz + n.shift)}</b> (${khz(n.shift)})` : 'not visible from a known position'}. The largest shift you will ever see at 145.800 MHz is about <b>±${(mx / 1000).toFixed(1)} kHz</b> (on a low pass at the horizon); at 437.800 MHz it is about ±10 kHz.`;
      $('#is-bankrows').innerHTML = BANK.map((o, i) => `<tr><td>Zone ${cfg.zone} CH${cfg.chBase + i}</td><td>${mhz(cfg.centerHz + o)}</td><td>${o ? (o > 0 ? '+' : '') + o / 1000 + ' kHz' : 'centre'}</td><td>${['AOS / approaching', 'approaching high', 'overhead (closest approach)', 'receding high', 'LOS / receding'][i]}</td><td>none</td><td>Wide (25 kHz)</td><td>Analogue FM, RX only</td></tr>`).join('');
    }

    function init() {
      setTle(S.tle);
      const bind = (id, key, num, after) => { const el = $(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!cfg[key]; else el.value = cfg[key]; el.onchange = () => { cfg[key] = el.type === 'checkbox' ? el.checked : num ? +el.value : el.value; save(); if (after) after(); dirty('iss'); }; };
      bind('#is-mode', 'mode'); bind('#is-armed', 'armed', false, () => log('info', cfg.armed ? 'Auto-tune ARMED' : 'Auto-tune disarmed')); bind('#is-dry', 'dry', false, () => log('info', cfg.dry ? 'Dry run ON -- commands are only logged' : 'Dry run OFF -- commands go to the radio'));
      bind('#is-zone', 'zone', true); bind('#is-chbase', 'chBase', true); bind('#is-step', 'stepHz', true); bind('#is-vol', 'vol', true); bind('#is-minel', 'minEl', true, () => { S.passAt = 0; });
      bind('#is-analog', 'analog'); bind('#is-autorec', 'autoRec'); bind('#is-sfx', 'sfx'); bind('#is-center', 'centerHz', true);
      bind('#is-pos', 'pos', false, () => { S.passAt = 0; if (cfg.pos === 'browser') askBrowser(); }); bind('#is-lat', 'lat', false, () => { S.passAt = 0; }); bind('#is-lon', 'lon', false, () => { S.passAt = 0; });
      $('#page-iss').addEventListener('click', e => {
        if (e.target.closest('#is-bench')) benchTest();
        else if (e.target.closest('#is-cancel')) cancel();
        else if (e.target.closest('#is-fetch')) ask(false);
        else if (e.target.closest('#is-geo')) askBrowser();
        else if (e.target.closest('#is-listen')) S.listen ? stopListen() : startListen(false);
        else if (e.target.closest('#is-clearlog')) { S.log = []; dirty('iss'); }
      });
      setInterval(tick, 1000);
      // fresh elements once a day while a radio is connected (CelesTrak asks for restraint; TLEs last days)
      setInterval(() => { const age = Date.now() - (S.tle.got || 0); if (age > 24 * 3600e3) ask(true); }, 10 * 60e3);
    }
    function shown() { setTimeout(() => { initMap(); if (S.map) S.map.invalidateSize(); }, 80); if (Date.now() - (S.tle.got || 0) > 24 * 3600e3) setTimeout(() => ask(true), 1500); dirty('iss'); }
    return { init, render, shown, gatewayReply, kfEvent, ownsXid: xid => !!(S.ask && S.ask.xid === xid) };
  };
})();
