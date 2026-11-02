/* Kelly Page -- LoRa Mesh > 🔭 Trace Route: tr-sound (2026-10-24, unreleased). The "Constellation" sounds: Web Audio
 * synthesis only (no files), on Kelly's one shared AudioContext (c.audioCtx(); never closed here). Same key as Packet
 * Journey (C major pentatonic), but glassy "celesta" tones: a struck sine with a quiet inharmonic shimmer partial and a
 * soft echo, so the two tabs sound related without sounding alike.
 *   launch    a run's first 'run' in phase 'queued' / 'sending': a quick rising shimmer (5 high notes)
 *   pending   a very soft tone at each out hop's estMs after sentAt (the comet's estimated arrival), climbing the scale
 *   success   'done' success: the REAL hops replayed out then back, pitch up the scale with TR.snrNorm(hop.snr)
 *             (out leg bright, return leg warmer and softer), a major arrival chord at the target, and a softer
 *             resolving chord when the comet is home
 *   failure   'done' timeout / no-path / error: a descending A-minor fall plus a soft noise "fizzle" (cancelled: silent)
 *
 * REPLAY TIMING (tr-viz uses the same numbers so sight and sound line up) -- KellyTRSound.plan(run) returns it:
 *   legs     n = (out.length - 1) + (back.length - 1), at least 1   (one leg per star-to-star step, out then back)
 *   spacing  KellyTRSound.spacing(n) = clamp(6000 / n, 120, 900) ms
 *   time 0 = when 'done' arrives; the comet leaves me at 0 and reaches star k (1-based along out[1..], back[1..]) at
 *            k * spacing.  Arrival chord at the target = (out.length - 1) * spacing (it replaces the target's hop tone);
 *            return chord = n * spacing (replaces the last hop tone, me). If back is [] the return chord sounds one
 *            spacing after the arrival chord.  Constants: SPACING_TOTAL 6000, SPACING_MIN 120, SPACING_MAX 900.
 * Limits: at most 8 voices alive (a sound = one voice), everything scheduled with timers and fired just in time, so a
 * new run, the tab hiding or destroy() cancels every tone not yet played. Silent while !c.visible().
 *
 * Starts OFF every session (autoplay rules + no surprises); volume remembered in c.store('trSound', { vol }).
 * window.KellyTRSound(mount, c) -> { destroy(), _test: { setOn(b), stats(), handle(name, x) } }
 * window.KellyTRSound.plan(run) -> { spacing, n, arriveAt, returnAt, total, events: [{ at, type, leg, deg, snr }] }
 */
(function () {
  'use strict';

  const PENTA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3];
  const step = (base, i) => base * PENTA[((i % 5) + 5) % 5] * Math.pow(2, Math.floor(i / 5));
  const C4 = 261.63, C5 = 523.25, C6 = 1046.5, A3 = 220;
  const MAX_VOICES = 8, SPACING_TOTAL = 6000, SPACING_MIN = 120, SPACING_MAX = 900, MAX_HOP_TONES = 64;

  const spacing = n => Math.round(Math.max(SPACING_MIN, Math.min(SPACING_MAX, SPACING_TOTAL / Math.max(1, n || 1))));
  const finite = x => typeof x === 'number' && isFinite(x);

  // the success replay timeline (pure; shared with tests and, by contract, with tr-viz)
  function plan(run) {
    const TR = window.KellyTR;
    const norm = s => TR && TR.snrNorm ? TR.snrNorm(s) : (finite(s) ? Math.max(0, Math.min(1, (s + 12) / 24)) : 0.35);
    const out = (run && Array.isArray(run.out) ? run.out : []).slice(1), back = (run && Array.isArray(run.back) ? run.back : []).slice(1);
    const n = Math.max(1, out.length + back.length), sp = spacing(n), events = [];
    const arriveAt = Math.max(1, out.length) * sp, returnAt = back.length ? n * sp : arriveAt + sp;
    out.forEach((h, i) => {
      const at = (i + 1) * sp, snr = h && finite(h.snr) ? h.snr : null;
      events.push({ at, type: i === out.length - 1 ? 'arrive' : 'hop', leg: 'out', deg: Math.round(norm(snr) * 7), snr });
    });
    if (!out.length) events.push({ at: arriveAt, type: 'arrive', leg: 'out', deg: 3, snr: null });
    back.forEach((h, i) => {
      const at = arriveAt + (i + 1) * sp, snr = h && finite(h.snr) ? h.snr : null;
      events.push({ at, type: i === back.length - 1 ? 'return' : 'hop', leg: 'back', deg: Math.round(norm(snr) * 7), snr });
    });
    if (!back.length) events.push({ at: returnAt, type: 'return', leg: 'back', deg: 3, snr: null });
    return { spacing: sp, n, arriveAt, returnAt, total: returnAt, events: events.slice(0, MAX_HOP_TONES + 2) };
  }

  window.KellyTRSound = function (mount, c) {
    const saved = (() => { try { return (c.store && c.store.get('trSound', {})) || {}; } catch { return {}; } })();
    const st = { on: false, vol: saved.vol == null ? 0.6 : Math.min(1, Math.max(0, +saved.vol || 0)) };
    let ctx = null, chain = null, active = 0, vis = !!(c.visible && c.visible()), curId = null, launched = new Set(), pendKey = null;
    const timers = new Set();
    const counts = { played: 0, dropped: 0, scheduled: 0, cancelled: 0, launches: 0, replays: 0, fails: 0, pending: 0 };
    const save = () => { try { c.store && c.store.set('trSound', { vol: st.vol }); } catch { /* storage full / off */ } };

    // ------------------------------------------------------------ graph: voices -> dry -> comp -> master -> out
    //                                                                     voices -> echo (delay + lowpass feedback) -> comp
    function graph() {
      let x; try { x = c.audioCtx && c.audioCtx(); } catch { x = null; }
      if (!x) return null;
      if (ctx === x && chain) return chain;
      teardown();
      ctx = x;
      const dry = ctx.createGain(), comp = ctx.createDynamicsCompressor(), master = ctx.createGain();
      const echoIn = ctx.createGain(), delay = ctx.createDelay(1), lp = ctx.createBiquadFilter(), fb = ctx.createGain(), wet = ctx.createGain();
      comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.3;
      delay.delayTime.value = 0.31; lp.type = 'lowpass'; lp.frequency.value = 2400; fb.gain.value = 0.32; wet.gain.value = 0.5;
      master.gain.value = gainOf();
      dry.connect(comp); echoIn.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay); lp.connect(wet); wet.connect(comp);
      comp.connect(master); master.connect(ctx.destination);
      const len = Math.floor(ctx.sampleRate * 0.7), noise = ctx.createBuffer(1, len, ctx.sampleRate), d = noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      chain = { dry, comp, master, echoIn, delay, lp, fb, wet, noise };
      return chain;
    }
    function teardown() {
      if (chain) for (const n of ['dry', 'comp', 'master', 'echoIn', 'delay', 'lp', 'fb', 'wet']) { try { chain[n].disconnect(); } catch { /* gone */ } }
      chain = null; ctx = null; active = 0;
    }
    const gainOf = () => st.on ? st.vol * st.vol * 0.85 : 0;
    function applyVol() {
      if (!chain) return;
      const g = chain.master.gain, t = ctx.currentTime;
      try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(gainOf(), t + 0.08); } catch { g.value = gainOf(); }
    }

    // one voice = a gain into dry (+ an echo send); disconnects itself when its last source ends (or a safety timer,
    // in case the context is suspended and onended never comes)
    function voice(echo, lifeS) {
      const nodes = [], out = ctx.createGain(); let live = 0, done = false;
      out.connect(chain.dry); nodes.push(out);
      if (echo > 0) { const s = ctx.createGain(); s.gain.value = echo; out.connect(s); s.connect(chain.echoIn); nodes.push(s); }
      active++;
      const finish = () => { if (done) return; done = true; clearTimeout(safety); active = Math.max(0, active - 1); for (const n of nodes) { try { n.disconnect(); } catch { /* gone */ } } };
      const safety = setTimeout(finish, (lifeS + 1.5) * 1000);
      return {
        out,
        node(n) { nodes.push(n); return n; },
        src(s, t0, t1) { nodes.push(s); live++; s.onended = () => { if (--live <= 0) finish(); }; s.start(t0); s.stop(t1); return s; },
      };
    }
    function tone(v, { type = 'sine', f, f1, glide = 0.05, t, a = 0.004, peak = 0.2, dur = 0.8, to }) {
      const o = ctx.createOscillator(), g = v.node(ctx.createGain());
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f1 && f1 !== f) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(to || v.out);
      return v.src(o, t, t + dur + 0.03);
    }
    // a celesta-like strike: sine fundamental, a quiet octave, and a fast-dying inharmonic "glass" partial
    function celesta(v, f, t, peak, dur) {
      tone(v, { f, t, a: 0.003, peak, dur });
      tone(v, { f: f * 2, t, a: 0.002, peak: peak * 0.22, dur: dur * 0.45 });
      tone(v, { f: f * 3.98, t, a: 0.001, peak: peak * 0.09, dur: 0.12 });
    }

    // ------------------------------------------------------------ the sounds (each returns true if it played)
    const SOUNDS = {
      launch(t) {
        const v = voice(0.35, 1.2);
        for (let k = 0; k < 5; k++) celesta(v, step(C6, k * 2), t + k * 0.06, 0.07 + k * 0.012, 0.55);
      },
      pend(t, x) {
        const v = voice(0.25, 0.8);
        celesta(v, step(C5, Math.min(9, x.i || 0)), t, 0.055, 0.5);
      },
      hop(t, x) {
        const back = x.leg === 'back', v = voice(back ? 0.35 : 0.25, 1.4), f = step(back ? C4 * 2 : C5, x.deg || 0);
        if (back) { tone(v, { type: 'triangle', f, t, a: 0.006, peak: 0.12, dur: 0.9 }); tone(v, { f: f * 2, t, a: 0.003, peak: 0.03, dur: 0.3 }); }
        else celesta(v, f, t, 0.16, 0.9);
      },
      arrive(t) {   // C major, strummed upwards, with the high C on top
        const v = voice(0.4, 2.2);
        [C5, step(C5, 2), step(C5, 3), C6].forEach((f, k) => celesta(v, f, t + k * 0.035, 0.11, 1.8));
      },
      ret(t) {      // softer, lower and longer: a resolving C major (G-C-E-C, a D grace note into the C)
        const v = voice(0.45, 2.8);
        tone(v, { f: step(C4, 1), t, a: 0.01, peak: 0.04, dur: 0.2 });
        [step(C4, -2), C4, step(C4, 2), C5].forEach((f, k) => tone(v, { f, t: t + 0.12 + k * 0.05, a: 0.03, peak: 0.075, dur: 2.4 }));
      },
      fail(t) {     // a descending A minor (E5-C5-A4-E4-A3), then a soft noise fizzle
        const v = voice(0.3, 2.2), lp = v.node(ctx.createBiquadFilter());
        lp.type = 'lowpass'; lp.frequency.value = 2200; lp.connect(v.out);
        [659.25, C5, 440, 329.63, A3].forEach((f, k) => tone(v, { type: 'triangle', f, t: t + k * 0.16, a: 0.006, peak: 0.12 - k * 0.012, dur: 0.55, to: lp }));
        const s = ctx.createBufferSource(), bp = v.node(ctx.createBiquadFilter()), g = v.node(ctx.createGain()), ft = t + 0.75;
        s.buffer = chain.noise; bp.type = 'bandpass'; bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(3800, ft); bp.frequency.exponentialRampToValueAtTime(500, ft + 0.6);
        g.gain.setValueAtTime(0.0001, ft); g.gain.exponentialRampToValueAtTime(0.09, ft + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, ft + 0.65);
        s.connect(bp); bp.connect(g); g.connect(v.out); v.src(s, ft, ft + 0.7);
      },
    };
    function play(kind, x, force) {
      if (!force && !(st.on && vis)) return false;
      if (!SOUNDS[kind] || !graph()) return false;
      if (active >= MAX_VOICES) { counts.dropped++; return false; }
      try { SOUNDS[kind](ctx.currentTime + 0.01, x || {}); counts.played++; return true; } catch (e) { console.warn('Trace Route sound', e); return false; }
    }

    // ------------------------------------------------------------ scheduling (timers, fired just in time)
    function later(ms, kind, x) {
      if (!(st.on && vis)) return;
      const id = setTimeout(() => { timers.delete(id); try { play(kind, x); } catch { /* */ } }, Math.max(0, Math.min(70000, ms)));
      timers.add(id); counts.scheduled++;
    }
    function cancelAll() { for (const id of timers) clearTimeout(id); counts.cancelled += timers.size; timers.clear(); pendKey = null; }

    function onRun(r) {
      if (!r || !r.id) return;
      if (r.id !== curId) { cancelAll(); curId = r.id; }
      if (r.status !== 'pending') return;
      if (!launched.has(r.id) && (r.phase === 'queued' || r.phase === 'sending')) {
        launched.add(r.id); if (launched.size > 50) launched = new Set([r.id]);
        if (play('launch')) counts.launches++;
      }
      // the estimated comet: one soft tone per out hop, once per attempt
      if (finite(r.sentAt) && r.phase !== 'queued' && st.on && vis) {
        const key = `${r.id}:${r.attempt}:${r.sentAt}`;
        if (key !== pendKey) {
          cancelAll(); pendKey = key;
          const now = Date.now(), out = Array.isArray(r.out) ? r.out : [];
          for (let i = 1; i < out.length && i <= MAX_HOP_TONES; i++) {
            const h = out[i]; if (!h || !finite(h.estMs)) continue;
            const ms = r.sentAt + h.estMs - now; if (ms < -150) continue;
            later(ms, 'pend', { i: i - 1 }); counts.pending++;
          }
        }
      }
    }
    function onDone(r) {
      if (!r || !r.id) return;
      cancelAll(); curId = r.id;
      if (!(st.on && vis)) return;
      if (r.status === 'success') {
        const p = plan(r); counts.replays++;
        for (const e of p.events) later(e.at, e.type === 'arrive' ? 'arrive' : e.type === 'return' ? 'ret' : 'hop', e);
      } else if (r.status === 'timeout' || r.status === 'no-path' || r.status === 'error') {
        if (play('fail')) counts.fails++;
      }
    }

    // ------------------------------------------------------------ controls (inline in the header bar)
    const esc = c.esc || (s => String(s));
    mount.innerHTML = `<div class="tr-snd-row">
        <button type="button" class="btn ghost tr-snd-tog" aria-pressed="false" title="Trace sounds (off until you turn them on)"><span class="tr-snd-ico">🔇</span> <span class="tr-snd-lbl">Sound off</span></button>
        <input type="range" class="tr-snd-vol" min="0" max="100" step="1" aria-label="${esc('Trace sound volume')}" title="Volume">
      </div>`;
    const q = s => mount.querySelector(s);
    const tog = q('.tr-snd-tog'), vol = q('.tr-snd-vol');
    vol.value = Math.round(st.vol * 100);
    function paint() {
      tog.setAttribute('aria-pressed', st.on ? 'true' : 'false'); tog.classList.toggle('on', st.on);
      q('.tr-snd-ico').textContent = st.on ? '🔊' : '🔇'; q('.tr-snd-lbl').textContent = st.on ? 'Sound on' : 'Sound off';
      vol.disabled = !st.on;
    }
    function setOn(b) {
      st.on = !!b;
      if (st.on) { graph(); applyVol(); play('arrive', null, true); }   // a hello chord, in the click
      else { applyVol(); cancelAll(); }
      paint();
    }
    tog.onclick = () => setOn(!st.on);
    vol.oninput = () => { st.vol = Math.min(1, Math.max(0, (+vol.value || 0) / 100)); applyVol(); };
    vol.onchange = save;
    paint();

    const safe = fn => x => { try { fn(x); } catch (e) { console.warn('Trace Route sound', e); } };
    const handlers = {
      run: safe(onRun), done: safe(onDone),
      visible: safe(v => { vis = !!v; if (!vis) cancelAll(); }),
      demo: safe(() => cancelAll()),
    };
    const offs = Object.keys(handlers).map(n => c.bus.on(n, handlers[n]));

    return {
      destroy() {
        offs.forEach(f => { try { f(); } catch { /* */ } });
        cancelAll(); st.on = false; teardown(); mount.innerHTML = '';
      },
      _test: { setOn, play: (k, x) => play(k, x), handle: (n, x) => handlers[n] && handlers[n](x), stats: () => Object.assign({ on: st.on, vol: st.vol, active, timers: timers.size }, counts) },
    };
  };
  window.KellyTRSound.plan = plan;
  window.KellyTRSound.spacing = spacing;
  window.KellyTRSound.TIMING = { SPACING_TOTAL, SPACING_MIN, SPACING_MAX, MAX_VOICES };
})();
