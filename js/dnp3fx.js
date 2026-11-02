/* Kelly Page -- DNP3 Lab sound + spark effects (window.KellyDnp3Fx). Everything is synthesised with WebAudio (no files,
 * so it works from file://) and every effect is ONE-SHOT: an arc crackles for under a second, a spark burst burns out,
 * an alarm sounds three times (kelly-page/CLAUDE.md "Flashy, but nothing loops forever"). The only sustained sound is
 * the transformer hum, which is opt-in (off by default) and stops whenever the page is hidden.
 *
 * KellyDnp3Fx.audio(getCtx, vol) -> { clunk, trip, rack, arc, tap, alarm, blocked, coin, win, fail, badge, hum(on, load),
 *                                     turbine(on, speed), water(on, flow), horn(), hornStop(), chirp(rx),   (Wivenhoe)
 *                                     jet(on, n1, n2), starter(on, n2), whump(), tick(near), co2() }      (Mackay GT)
 * KellyDnp3Fx.sparks(canvas) -> { burst(x, y, intensity, colour), arc(x, y, intensity), clear() }  (x, y in canvas px)
 */
(function () {
  'use strict';

  function audio(getCtx, vol) {
    let humNodes = null, noiseBuf = null; const sus = { tb: null, wt: null, hn: null, jt: null, sr: null };
    const ctx = () => { try { return getCtx(); } catch { return null; } };
    const V = () => Math.max(0, Math.min(1, vol()));
    function noise(c) {
      if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return noiseBuf;
    }
    function env(c, g, t, a, peak, d) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
    function noiseHit(c, t, { f = 800, q = 1, type = 'lowpass', peak = 0.5, a = 0.002, d = 0.15, dest } = {}) {
      const s = c.createBufferSource(); s.buffer = noise(c); s.playbackRate.value = 0.6 + Math.random() * 0.8;
      const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g = c.createGain(); env(c, g, t, a, peak * V(), d);
      s.connect(fl).connect(g).connect(dest || c.destination); s.start(t, Math.random() * 0.5); s.stop(t + a + d + 0.05);
    }
    function tone(c, t, { f = 440, f2, type = 'sine', peak = 0.3, a = 0.005, d = 0.2, dest } = {}) {
      const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + a + d);
      const g = c.createGain(); env(c, g, t, a, peak * V(), d);
      o.connect(g).connect(dest || c.destination); o.start(t); o.stop(t + a + d + 0.05);
    }
    const run = fn => { const c = ctx(); if (!c || !V()) return; try { fn(c, c.currentTime + 0.01); } catch (e) { console.warn('dnp3 fx', e); } };
    return {
      // a heavy breaker closing: mechanism thump + latch click
      clunk: (k = 1) => run((c, t) => { tone(c, t, { f: 90, f2: 40, peak: 0.55 * k, d: 0.28 }); noiseHit(c, t, { f: 500, peak: 0.6 * k, d: 0.12 }); noiseHit(c, t + 0.04, { f: 3500, type: 'bandpass', q: 3, peak: 0.25, d: 0.04 }); }),
      // a trip: solenoid snap, spring release, a harder CLUNK
      trip: (k = 1) => run((c, t) => {
        noiseHit(c, t, { f: 4500, type: 'bandpass', q: 4, peak: 0.4, d: 0.03 });
        tone(c, t + 0.01, { f: 420, f2: 110, type: 'triangle', peak: 0.25, d: 0.22 });
        tone(c, t + 0.03, { f: 70, f2: 32, peak: 0.75 * k, d: 0.35 }); noiseHit(c, t + 0.03, { f: 380, peak: 0.8 * k, d: 0.18 });
      }),
      // racking a truck in: ratchet clicks
      rack: () => run((c, t) => { for (let i = 0; i < 7; i++) noiseHit(c, t + i * 0.07, { f: 2500 + i * 120, type: 'highpass', peak: 0.22, d: 0.025 }); tone(c, t + 0.52, { f: 160, f2: 80, peak: 0.3, d: 0.12 }); }),
      // high-voltage arc: crackle + 100 Hz buzz, length grows with the current broken
      arc: (k = 0.5) => run((c, t) => {
        const len = 0.18 + 0.7 * k;
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 100;
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
        const g = c.createGain(); env(c, g, t, 0.005, 0.18 * k * V(), len); o.connect(lp).connect(g).connect(c.destination); o.start(t); o.stop(t + len + 0.1);
        const n = Math.round(10 + 40 * k);
        for (let i = 0; i < n; i++) noiseHit(c, t + Math.random() * len, { f: 1500 + Math.random() * 5000, type: 'bandpass', q: 2, peak: (0.15 + Math.random() * 0.45) * k, d: 0.01 + Math.random() * 0.03 });
        noiseHit(c, t, { f: 6000, type: 'highpass', peak: 0.5 * k, d: len * 0.6 });
      }),
      // on-load tap changer: motor whirr then the diverter's clunk
      tap: (secs = 2.5) => run((c, t) => {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(110, t); o.frequency.linearRampToValueAtTime(150, t + secs * 0.8);
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
        const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08 * V() + 0.0002, t + 0.2); g.gain.setValueAtTime(0.08 * V() + 0.0002, t + secs * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + secs * 0.9);
        o.connect(lp).connect(g).connect(c.destination); o.start(t); o.stop(t + secs);
        tone(c, t + secs * 0.85, { f: 120, f2: 50, peak: 0.45, d: 0.2 }); noiseHit(c, t + secs * 0.85, { f: 900, peak: 0.4, d: 0.08 });
      }),
      // annunciator: three two-tone beeps, then quiet (the tile stays lit until ACK)
      alarm: () => run((c, t) => { for (let i = 0; i < 3; i++) { tone(c, t + i * 0.36, { f: 880, type: 'square', peak: 0.09, d: 0.14 }); tone(c, t + i * 0.36 + 0.17, { f: 660, type: 'square', peak: 0.09, d: 0.14 }); } }),
      blocked: () => run((c, t) => { tone(c, t, { f: 140, type: 'square', peak: 0.12, d: 0.12 }); tone(c, t + 0.16, { f: 120, type: 'square', peak: 0.12, d: 0.18 }); }),
      // arcade layer
      coin: () => run((c, t) => { tone(c, t, { f: 988, type: 'square', peak: 0.1, d: 0.06 }); tone(c, t + 0.07, { f: 1319, type: 'square', peak: 0.1, d: 0.22 }); }),
      win: () => run((c, t) => { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(c, t + i * 0.11, { f, type: 'square', peak: 0.1, d: i === 5 ? 0.4 : 0.09 })); }),
      fail: () => run((c, t) => { [392, 330, 262, 196].forEach((f, i) => tone(c, t + i * 0.16, { f, type: 'triangle', peak: 0.16, d: 0.15 })); }),
      badge: () => run((c, t) => { [784, 988, 1175, 1568].forEach((f, i) => tone(c, t + i * 0.09, { f, type: 'square', peak: 0.09, d: 0.12 })); tone(c, t + 0.4, { f: 2093, type: 'sine', peak: 0.12, d: 0.6 }); }),
      // transformer hum: 100 Hz + harmonics (magnetostriction), louder with load. hum(false) stops it.
      hum(on, load = 0.5) {
        if (!on && !humNodes) return;
        const c = ctx();
        if (!on || !c || !V()) { if (humNodes) { try { const t = c ? c.currentTime : 0; humNodes.g.gain.setTargetAtTime(0.0001, t, 0.15); const n = humNodes; setTimeout(() => n.o.forEach(o => { try { o.stop(); } catch {} }), 600); } catch {} humNodes = null; } return; }
        const level = (0.012 + 0.03 * Math.min(1.4, load)) * V();
        if (humNodes) { humNodes.g.gain.setTargetAtTime(level, c.currentTime, 0.5); return; }
        const g = c.createGain(); g.gain.value = 0.0001; g.connect(c.destination);
        const o = [[100, 1], [200, 0.45], [300, 0.25], [400, 0.1]].map(([f, a]) => { const x = c.createOscillator(); x.frequency.value = f; const xg = c.createGain(); xg.gain.value = a; x.connect(xg).connect(g); x.start(); return x; });
        g.gain.setTargetAtTime(level, c.currentTime, 0.4);
        humNodes = { g, o };
      },
      // Wivenhoe: a pump-turbine's hum (pitch tracks speed, 0-1) and the water rush (level tracks flow, 0-1). Both are
      // sustained, so the page only turns them on when the user opted in, and turns them off when it's hidden.
      turbine(on, speed = 0) {
        const c = ctx(); speed = Math.max(0, Math.min(1, speed));
        if (!on || !c || !V() || speed < 0.02) { stopNodes('tb'); return; }
        if (!sus.tb) {
          const g = c.createGain(); g.gain.value = 0.0001; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.connect(g).connect(c.destination);
          const o = [['sawtooth', 1, 0.6], ['sine', 2, 0.5], ['triangle', 7.5, 0.08]].map(([type, mul, a]) => { const x = c.createOscillator(); x.type = type; x.mul = mul; const xg = c.createGain(); xg.gain.value = a; x.connect(xg).connect(lp); x.start(); return x; });
          sus.tb = { g, o };
        }
        const t = c.currentTime, f = 28 + 62 * speed;
        sus.tb.o.forEach(x => x.frequency.setTargetAtTime(f * x.mul, t, 0.4));
        sus.tb.g.gain.setTargetAtTime((0.01 + 0.05 * speed) * V(), t, 0.4);
      },
      water(on, flow = 0) {
        const c = ctx(); flow = Math.max(0, Math.min(1, flow));
        if (!on || !c || !V() || flow < 0.02) { stopNodes('wt'); return; }
        if (!sus.wt) {
          const s = c.createBufferSource(); s.buffer = noise(c); s.loop = true;
          const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
          const g = c.createGain(); g.gain.value = 0.0001; s.connect(bp).connect(g).connect(c.destination); s.start();
          sus.wt = { g, o: [s], bp };
        }
        const t = c.currentTime;
        sus.wt.bp.frequency.setTargetAtTime(350 + 500 * flow, t, 0.5);
        sus.wt.g.gain.setTargetAtTime((0.015 + 0.08 * flow) * V(), t, 0.5);
      },
      // station alarm horn: three two-tone blasts (one-shot); hornStop() silences it early, as ACK does
      horn() {
        stopNodes('hn');
        run((c, t) => {
          const g = c.createGain(); g.gain.value = 0.0001; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600; lp.connect(g).connect(c.destination);
          const o = [c.createOscillator(), c.createOscillator()]; o.forEach((x, i) => { x.type = 'square'; x.frequency.value = i ? 554 : 440; x.connect(lp); x.start(t); x.stop(t + 3.1); });
          for (let i = 0; i < 3; i++) { const s = t + i * 1.0; g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(0.07 * V() + 0.0002, s + 0.04); g.gain.setValueAtTime(0.07 * V() + 0.0002, s + 0.6); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.7); }
          sus.hn = { g, o };
        });
      },
      hornStop: () => stopNodes('hn'),
      // Mackay gas turbine. jet(on, n1, n2): the engine -- a filtered-noise roar whose pitch + level follow N1, a
      // compressor whine on N2 and a low rumble; it spools down by itself as N1/N2 fall (0-1 each). starter(on, n2):
      // the starter motor's whine rising with N2 during the crank. Both sustained: the page only turns them on while
      // the user has sound on, and off when it's hidden.
      jet(on, n1 = 0, n2 = 0) {
        const c = ctx(); n1 = Math.max(0, Math.min(1.1, n1)); n2 = Math.max(0, Math.min(1.1, n2));
        if (!on || !c || !V() || n2 < 0.02) { stopNodes('jt'); return; }
        if (!sus.jt) {
          const g = c.createGain(); g.gain.value = 0.0001; g.connect(c.destination);
          const s = c.createBufferSource(); s.buffer = noise(c); s.loop = true;
          const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7; const rg = c.createGain(); rg.gain.value = 1;
          s.connect(bp).connect(rg).connect(g); s.start();
          const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160; const lg = c.createGain(); lg.gain.value = 0.9;
          s.connect(lp).connect(lg).connect(g);
          const wh = c.createOscillator(); wh.type = 'sine'; const wg = c.createGain(); wg.gain.value = 0.06; wh.connect(wg).connect(g); wh.start();
          const wh2 = c.createOscillator(); wh2.type = 'triangle'; const wg2 = c.createGain(); wg2.gain.value = 0.025; wh2.connect(wg2).connect(g); wh2.start();
          sus.jt = { g, o: [s, wh, wh2], bp, wh, wh2 };
        }
        const t = c.currentTime, J = sus.jt;
        J.bp.frequency.setTargetAtTime(180 + 900 * n1 * n1, t, 0.3);
        J.wh.frequency.setTargetAtTime(500 + 3200 * n2, t, 0.3); J.wh2.frequency.setTargetAtTime(240 + 1500 * n2, t, 0.3);
        J.g.gain.setTargetAtTime((0.015 + 0.16 * Math.pow(n1, 1.6)) * V(), t, 0.35);
      },
      starter(on, n2 = 0) {
        const c = ctx(); n2 = Math.max(0, Math.min(1, n2));
        if (!on || !c || !V()) { stopNodes('sr'); return; }
        if (!sus.sr) {
          const g = c.createGain(); g.gain.value = 0.0001; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.connect(g).connect(c.destination);
          const o = c.createOscillator(); o.type = 'sawtooth'; o.connect(lp); o.start();
          const o2 = c.createOscillator(); o2.type = 'square'; const og = c.createGain(); og.gain.value = 0.25; o2.connect(og).connect(lp); o2.start();
          sus.sr = { g, o: [o, o2] };
        }
        const t = c.currentTime, f = 180 + 1700 * Math.min(1, n2 / 0.55);
        sus.sr.o[0].frequency.setTargetAtTime(f, t, 0.4); sus.sr.o[1].frequency.setTargetAtTime(f / 2, t, 0.4);
        sus.sr.g.gain.setTargetAtTime(0.045 * V(), t, 0.3);
      },
      // light-off: the WHUMP of eight cans catching -- a deep thump and a rushing burst
      whump: () => run((c, t) => { tone(c, t, { f: 70, f2: 28, peak: 0.8, a: 0.01, d: 0.6 }); noiseHit(c, t, { f: 260, peak: 0.9, a: 0.02, d: 0.7 }); noiseHit(c, t + 0.05, { f: 1200, type: 'bandpass', q: 0.8, peak: 0.3, d: 0.5 }); }),
      // a synchroscope tick (the page speeds them up as the needle nears 12 o'clock)
      tick: (near = 0) => run((c, t) => { tone(c, t, { f: 1800 + 900 * near, type: 'square', peak: 0.035 + 0.04 * near, a: 0.001, d: 0.025 }); }),
      // CO2 flooding the enclosure: a long falling hiss
      co2: () => run((c, t) => { noiseHit(c, t, { f: 5000, type: 'highpass', peak: 0.5, a: 0.05, d: 3.2 }); noiseHit(c, t, { f: 900, type: 'bandpass', q: 0.5, peak: 0.25, a: 0.1, d: 2.5 }); }),
      // a P25 data burst: a short sweep up when we transmit, down when we receive, with a squelch-tail hiss
      chirp: (rx = false) => run((c, t) => {
        tone(c, t, { f: rx ? 2100 : 1300, f2: rx ? 1300 : 2100, type: 'sine', peak: 0.05, a: 0.003, d: 0.06 });
        noiseHit(c, t + 0.07, { f: 3000, type: 'highpass', peak: 0.03, d: 0.05 });
      }),
    };
    function stopNodes(k) {
      const n = sus[k]; if (!n) return; sus[k] = null;
      const c = ctx();
      try { n.g.gain.cancelScheduledValues(c.currentTime); n.g.gain.setTargetAtTime(0.0001, c.currentTime, 0.12); } catch {}
      setTimeout(() => n.o.forEach(o => { try { o.stop(); } catch {} }), 500);
    }
  }

  // Canvas particle sparks + a jagged lightning bolt; runs rAF only while something is burning.
  function sparks(cv) {
    const g = cv.getContext('2d'); let parts = [], bolts = [], raf = 0, last = 0;
    const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    function fit() { const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); } g.setTransform(dpr, 0, 0, dpr, 0, 0); }
    function frame(ts) {
      const dt = Math.min(0.05, (ts - (last || ts)) / 1000); last = ts;
      fit(); const r = cv.getBoundingClientRect(); g.clearRect(0, 0, r.width, r.height);
      g.globalCompositeOperation = 'lighter';
      parts = parts.filter(p => (p.life -= dt) > 0);
      for (const p of parts) {
        p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        const a = Math.max(0, p.life / p.max);
        g.strokeStyle = `hsla(${p.h}, 100%, ${60 + 30 * a}%, ${a})`; g.lineWidth = p.w;
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02); g.stroke();
      }
      bolts = bolts.filter(b => (b.life -= dt) > 0);
      for (const b of bolts) {
        const a = b.life / b.max;
        g.shadowColor = b.col; g.shadowBlur = 18;
        for (let k = 0; k < 2; k++) {
          g.strokeStyle = k ? `rgba(255,255,255,${a})` : b.col; g.lineWidth = k ? 1.2 : 3.5 * a;
          g.beginPath(); let x = b.x, y = b.y - b.len / 2; g.moveTo(x, y);
          for (let s = 1; s <= 8; s++) { x = b.x + (Math.random() - 0.5) * b.len * 0.5; y = b.y - b.len / 2 + (b.len * s) / 8; g.lineTo(x, y); }
          g.stroke();
        }
        g.shadowBlur = 0;
        g.fillStyle = `rgba(200,230,255,${0.35 * a})`; g.beginPath(); g.arc(b.x, b.y, 28 * a + 6, 0, Math.PI * 2); g.fill();
      }
      g.globalCompositeOperation = 'source-over';
      if (parts.length || bolts.length) raf = requestAnimationFrame(frame); else { raf = 0; last = 0; g.clearRect(0, 0, r.width, r.height); }
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    return {
      burst(x, y, k = 0.5, hue = 45) {
        if (reduced()) return;
        const n = Math.round(14 + 70 * k);
        for (let i = 0; i < n; i++) {
          const ang = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 380 * (0.4 + k);
          const max = 0.25 + Math.random() * 0.6 * (0.5 + k);
          parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 120, life: max, max, w: 1 + Math.random() * 1.8, h: hue + Math.random() * 20 - 10 });
        }
        kick();
      },
      arc(x, y, k = 0.5, col = '#9fd8ff') {
        if (reduced()) return;
        bolts.push({ x, y, len: 30 + 40 * k, life: 0.15 + 0.45 * k, max: 0.15 + 0.45 * k, col });
        this.burst(x, y, k, 200);
        kick();
      },
      clear() { parts = []; bolts = []; },
    };
  }

  window.KellyDnp3Fx = { audio, sparks };
})();
