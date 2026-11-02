/* Kelly Page -- LoRa Mesh > Packet Journey: pj-sound (2026-10-24, unreleased). Every packet as a short synthesised sound,
 * Web Audio only (no files), on Kelly's one shared AudioContext (c.audioCtx(); never closed here).
 *
 * Everything sits in one key (C major pentatonic), so any mix of packets is a chord, never a clash; strong signals
 * (ev.snr) play higher up the scale, and each hop a flood travelled feeds more into a soft sonar echo.
 *   advert   sonar ping: a sine with a small pitch drop and a long echo tail
 *   chat     bright two-note bell chime (a pentatonic third apart)
 *   dm       low, soft, slowly-opening filtered tone with a beating detune and a minor third (secret, encrypted)
 *   ack      tiny tick (filtered noise click + a short high sine)
 *   path     quick rising arpeggio (trace: one note per repeater SNR, up to 5)
 *   req      two-note question (rising) -- RESPONSE answers (falling)
 *   unknown  short, soft, low filtered buzz
 *   flood    any kind sent as a flood gets a quiet rising sweep layered on top
 *   burst    over the rate limit, packets merge into one quiet "glitter" (one note per kind in the burst)
 * Rate limit: a 6-token bucket refilled at 6/s; starts are staggered >= 60 ms and never scheduled > 0.5 s ahead;
 * at most 14 voices alive. Silent while the tab isn't visible. Each voice disconnects itself when its sources end.
 *
 * Starts OFF every session (autoplay rules + nobody wants a surprise); volume and per-kind mutes are remembered in
 * c.store('pjSound', { vol, mute: { kind: true } }).
 *
 * window.KellyPJSound(mount, c) -> { destroy(), _test }   (_test: { play(ev), setOn(b), stats() } for tests/pj-sound-tests.html)
 */
(function () {
  'use strict';

  const PENTA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3];
  const step = (base, i) => base * PENTA[((i % 5) + 5) % 5] * Math.pow(2, Math.floor(i / 5));
  const C3 = 130.81, C5 = 523.25, C6 = 1046.5;
  const RATE = 6, BUCKET = 6, GAP = 0.06, AHEAD = 0.5, MAX_VOICES = 14, CLUSTER_MS = 450;

  window.KellyPJSound = function (mount, c) {
    const PJ = c.PJ, KINDS = PJ.KINDS;
    const saved = (() => { try { return c.store.get('pjSound', {}) || {}; } catch { return {}; } })();
    const st = { on: false, vol: saved.vol == null ? 0.6 : Math.min(1, Math.max(0, +saved.vol || 0)), mute: Object.assign({}, saved.mute || {}) };
    let ctx = null, chain = null, active = 0, nextFree = 0, tokens = BUCKET, lastFill = now(), cluster = null, clusterTimer = 0, vis = !!c.visible();
    const counts = { played: 0, clustered: 0, dropped: 0, clusters: 0 };
    function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
    const save = () => { try { c.store.set('pjSound', { vol: st.vol, mute: st.mute }); } catch { /* storage full / off */ } };

    // ------------------------------------------------------------ audio graph: voices -> dry -> comp -> master -> out
    //                                                                     voices -> echo (delay + lowpass feedback) -> comp
    function graph() {
      let x; try { x = c.audioCtx(); } catch { x = null; }
      if (!x) return null;
      if (ctx === x && chain) return chain;
      teardown();
      ctx = x;
      const dry = ctx.createGain(), comp = ctx.createDynamicsCompressor(), master = ctx.createGain();
      const echoIn = ctx.createGain(), delay = ctx.createDelay(1), lp = ctx.createBiquadFilter(), fb = ctx.createGain(), wet = ctx.createGain();
      comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.25;
      delay.delayTime.value = 0.27; lp.type = 'lowpass'; lp.frequency.value = 1700; fb.gain.value = 0.36; wet.gain.value = 0.55;
      master.gain.value = gainOf();
      dry.connect(comp); echoIn.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay); lp.connect(wet); wet.connect(comp);
      comp.connect(master); master.connect(ctx.destination);
      // a short noise buffer for the ACK tick (made once per context)
      const len = Math.floor(ctx.sampleRate * 0.006), noise = ctx.createBuffer(1, len, ctx.sampleRate), d = noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      chain = { dry, comp, master, echoIn, delay, lp, fb, wet, noise };
      return chain;
    }
    function teardown() {
      if (chain) for (const n of ['dry', 'comp', 'master', 'echoIn', 'delay', 'lp', 'fb', 'wet']) { try { chain[n].disconnect(); } catch { /* gone */ } }
      chain = null; ctx = null; active = 0; nextFree = 0;
    }
    const gainOf = () => st.on ? st.vol * st.vol * 0.9 : 0;   // squared: the slider feels even
    function applyVol() {
      if (!chain) return;
      const g = chain.master.gain, t = ctx.currentTime;
      try { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(gainOf(), t + 0.08); } catch { g.value = gainOf(); }
    }

    // one voice = a gain into dry (+ an echo send); it disconnects every node it made once its last source ends
    function voice(echo) {
      const nodes = [], out = ctx.createGain(); let live = 0, done = false;
      out.connect(chain.dry); nodes.push(out);
      if (echo > 0) { const s = ctx.createGain(); s.gain.value = echo; out.connect(s); s.connect(chain.echoIn); nodes.push(s); }
      active++;
      const finish = () => { if (done) return; done = true; active = Math.max(0, active - 1); for (const n of nodes) { try { n.disconnect(); } catch { /* gone */ } } };
      return {
        out,
        node(n) { nodes.push(n); return n; },
        src(s, t0, t1) { nodes.push(s); live++; s.onended = () => { if (--live <= 0) finish(); }; s.start(t0); s.stop(t1); return s; },
      };
    }
    // an enveloped oscillator: f (-> f1 over glide s), attack a, peak, exponential decay to t + dur
    function tone(v, { type = 'sine', f, f1, glide = 0.05, t, a = 0.006, peak = 0.2, dur = 0.4, to }) {
      const o = ctx.createOscillator(), g = v.node(ctx.createGain());
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (f1 && f1 !== f) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(to || v.out);
      return v.src(o, t, t + dur + 0.03);
    }
    function filter(v, type, freq, q) { const f = v.node(ctx.createBiquadFilter()); f.type = type; f.frequency.value = freq; f.Q.value = q || 0.7; f.connect(v.out); return f; }

    // ------------------------------------------------------------ the sounds
    const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
    // SNR -> a scale degree 0..5 (null = the middle)
    const deg = ev => { const s = num(ev && ev.snr); return s == null ? 3 : Math.round(Math.min(1, Math.max(0, (s + 14) / 24)) * 5); };
    const hopsOf = ev => Math.min(4, Math.max(0, num(ev && ev.hops) || (ev && Array.isArray(ev.path) ? ev.path.length : 0)));
    const SOUNDS = {
      advert(t, ev) {
        const v = voice(0.3 + 0.08 * hopsOf(ev)), f = step(C5, deg(ev));
        tone(v, { f: f * 1.12, f1: f, glide: 0.05, t, a: 0.004, peak: 0.3, dur: 1.1 });
        tone(v, { f: f * 2.005, t, a: 0.004, peak: 0.05, dur: 0.45 });
      },
      chat(t, ev) {
        const v = voice(0.12 + 0.05 * hopsOf(ev)), i = deg(ev);
        [step(C6, i), step(C6, i + 2)].forEach((f, k) => {
          const s = t + k * 0.09;
          tone(v, { f, t: s, a: 0.003, peak: 0.17, dur: 0.6 });
          tone(v, { type: 'triangle', f: f * 2, t: s, a: 0.002, peak: 0.035, dur: 0.22 });
          tone(v, { f: f * 3.01, t: s, a: 0.002, peak: 0.015, dur: 0.14 });
        });
      },
      dm(t, ev) {
        const v = voice(0.22 + 0.06 * hopsOf(ev)), f = step(C3, deg(ev));
        const lp = filter(v, 'lowpass', 280, 4);
        lp.frequency.setValueAtTime(280, t); lp.frequency.exponentialRampToValueAtTime(950, t + 0.35); lp.frequency.exponentialRampToValueAtTime(320, t + 1.05);
        tone(v, { f, t, a: 0.09, peak: 0.2, dur: 1.1, to: lp });
        tone(v, { type: 'triangle', f: f * 1.004, t, a: 0.12, peak: 0.12, dur: 1.1, to: lp });
        tone(v, { f: f * 1.2, t: t + 0.16, a: 0.12, peak: 0.07, dur: 0.95, to: lp });   // minor third
      },
      ack(t, ev) {
        const v = voice(0), f = step(C6, deg(ev));
        const s = ctx.createBufferSource(), bp = v.node(ctx.createBiquadFilter()), g = v.node(ctx.createGain());
        s.buffer = chain.noise; bp.type = 'bandpass'; bp.frequency.value = 3600; bp.Q.value = 3; g.gain.value = 0.3;
        s.connect(bp); bp.connect(g); g.connect(v.out); v.src(s, t, t + 0.02);
        tone(v, { f: f * 2, t, a: 0.002, peak: 0.05, dur: 0.04 });
      },
      path(t, ev) {
        const trace = ev && ev.type === 'TRACE', snrs = (ev && Array.isArray(ev.snrs)) ? ev.snrs : [];
        const n = trace ? Math.min(5, 2 + snrs.length) : 3, v = voice(0.15), lp = filter(v, 'lowpass', 2600, 0.8), i = deg(ev);
        for (let k = 0; k < n; k++) {
          // a trace note per repeater: its own SNR picks the step (falls back to the climb)
          const sk = trace && num(snrs[k - 1]) != null ? Math.round(Math.min(1, Math.max(0, (snrs[k - 1] + 14) / 24)) * 5) + k : i + k;
          tone(v, { type: 'triangle', f: step(C5, sk), t: t + k * 0.055, a: 0.004, peak: 0.13, dur: 0.15, to: lp });
        }
      },
      req(t, ev) {
        const v = voice(0.1), i = deg(ev), answer = ev && ev.type === 'RESPONSE';
        const notes = answer ? [i + 3, i] : [i, i + 3];
        notes.forEach((d, k) => {
          const f = step(C5, d), s = t + k * 0.14;
          tone(v, { f, t: s, a: 0.008, peak: 0.15, dur: 0.16 });
          tone(v, { type: 'triangle', f: f * 2, t: s, a: 0.006, peak: 0.03, dur: 0.1 });
        });
      },
      unknown(t) {
        const v = voice(0), lp = filter(v, 'lowpass', 420, 1);
        tone(v, { type: 'sawtooth', f: 110, t, a: 0.012, peak: 0.07, dur: 0.18, to: lp });
        tone(v, { type: 'sawtooth', f: 111.2, t, a: 0.012, peak: 0.05, dur: 0.18, to: lp });
      },
    };
    function sweep(t) {
      const v = voice(0.08), bp = filter(v, 'bandpass', 900, 1.2);
      tone(v, { type: 'triangle', f: 260, f1: 1180, glide: 0.17, t, a: 0.03, peak: 0.06, dur: 0.2, to: bp });
    }
    function glitter(t, n, kinds) {
      const v = voice(0.2), peak = 0.06 * Math.min(1.6, 0.8 + Math.log2(Math.max(1, n)) / 5);
      kinds.slice(0, 4).forEach((k, j) => tone(v, { f: step(C6, KINDS.indexOf(k) + j), t: t + j * 0.04, a: 0.003, peak, dur: 0.28 }));
    }

    // ------------------------------------------------------------ rate limit + scheduling
    function take() {
      const n = now(); tokens = Math.min(BUCKET, tokens + (n - lastFill) / 1000 * RATE); lastFill = n;
      if (tokens < 1) return false; tokens -= 1; return true;
    }
    // the next start time, or null when the queue is already 0.5 s deep / too many voices are alive
    function slot() {
      const ct = ctx.currentTime, t = Math.max(ct + 0.01, nextFree);
      if (t - ct > AHEAD || active >= MAX_VOICES) return null;
      nextFree = t + GAP; return t;
    }
    const audible = kind => st.on && vis && !st.mute[kind];
    function play(ev, force) {
      const kind = (ev && SOUNDS[ev.kind]) ? ev.kind : 'unknown';
      if (!force && !audible(kind)) return false;
      if (!graph()) return false;
      if (!force && !take()) { addCluster(kind); return false; }
      const t = slot(); if (t == null) { if (force) return false; addCluster(kind); return false; }
      SOUNDS[kind](t, ev || {});
      if (ev && ev.route === 'flood' && !st.mute.flood) sweep(t);
      counts.played++;
      return true;
    }
    function addCluster(kind) {
      counts.clustered++;
      if (!cluster) cluster = { n: 0, kinds: [] };
      cluster.n++; if (!cluster.kinds.includes(kind)) cluster.kinds.push(kind);
      if (!clusterTimer) clusterTimer = setTimeout(flushCluster, CLUSTER_MS);
    }
    function flushCluster() {
      clusterTimer = 0;
      try {
        if (!cluster || !st.on || !vis || !graph()) { cluster = null; return; }
        if (!take()) { clusterTimer = setTimeout(flushCluster, CLUSTER_MS); return; }   // keep merging until there's room
        const t = slot(); if (t == null) { counts.dropped += cluster.n; cluster = null; return; }
        glitter(t, cluster.n, cluster.kinds); counts.clusters++; cluster = null;
      } catch (e) { cluster = null; console.warn('Packet Journey sound', e); }
    }
    function dropCluster() { if (clusterTimer) clearTimeout(clusterTimer); clusterTimer = 0; cluster = null; }

    // ------------------------------------------------------------ controls (in the header bar)
    const ORDER = KINDS.concat('flood');
    const label = k => k === 'flood' ? 'Flood sweep' : (PJ.PALETTE[k] && PJ.PALETTE[k].label) || k;
    const color = k => k === 'flood' ? 'var(--lime)' : (PJ.PALETTE[k] && PJ.PALETTE[k].color) || 'var(--cyan)';
    mount.innerHTML = `<div class="pj-sound-row">
        <button type="button" class="btn ghost pj-sound-tog" aria-pressed="false" title="Packet sounds (off until you turn them on)"><span class="pj-sound-ico">🔇</span> <span class="pj-sound-lbl">Sound off</span></button>
        <input type="range" class="pj-sound-vol" min="0" max="100" step="1" aria-label="Packet sound volume" title="Volume">
        <details class="pj-sound-kinds"><summary class="btn ghost" title="Mute single kinds of packet">🎚️ <span class="pj-sound-n"></span></summary>
          <div class="pj-sound-pop"><div class="pj-sound-pop-h">Sounds for</div><div class="pj-sound-chips">${ORDER.map(k =>
            `<button type="button" class="pj-sound-chip" data-k="${k}" style="--pj-sc:${color(k)}" title="Tap to mute / unmute (plays a sample when sound is on)"><i></i>${c.esc(label(k))}</button>`).join('')}</div>
          <div class="pj-sound-pop-f dim small">Pitch follows signal strength; more hops, more echo. Bursts merge into one sparkle.</div></div>
        </details>
      </div>`;
    const q = s => mount.querySelector(s);
    const tog = q('.pj-sound-tog'), vol = q('.pj-sound-vol'), det = q('.pj-sound-kinds');
    vol.value = Math.round(st.vol * 100);
    function paint() {
      tog.setAttribute('aria-pressed', st.on ? 'true' : 'false'); tog.classList.toggle('on', st.on);
      q('.pj-sound-ico').textContent = st.on ? '🔊' : '🔇'; q('.pj-sound-lbl').textContent = st.on ? 'Sound on' : 'Sound off';
      vol.disabled = !st.on;
      const muted = ORDER.filter(k => st.mute[k]).length;
      q('.pj-sound-n').textContent = muted ? `${ORDER.length - muted}/${ORDER.length}` : 'All';
      mount.querySelectorAll('.pj-sound-chip').forEach(b => { const m = !!st.mute[b.dataset.k]; b.classList.toggle('off', m); b.setAttribute('aria-pressed', m ? 'false' : 'true'); });
    }
    function setOn(b) {
      st.on = !!b;
      if (st.on) { graph(); applyVol(); play({ kind: 'advert', snr: 6, hops: 1 }, true); }   // a hello ping, in the click
      else { applyVol(); dropCluster(); }
      paint();
    }
    tog.onclick = () => setOn(!st.on);
    vol.oninput = () => { st.vol = Math.min(1, Math.max(0, (+vol.value || 0) / 100)); applyVol(); };
    vol.onchange = save;
    mount.querySelectorAll('.pj-sound-chip').forEach(b => b.onclick = () => {
      const k = b.dataset.k; st.mute[k] = !st.mute[k]; if (!st.mute[k]) delete st.mute[k];
      save(); paint();
      if (!st.mute[k] && st.on) play(k === 'flood' ? { kind: 'chat', route: 'flood', snr: 4 } : { kind: k, snr: 4, hops: 1, type: k === 'path' ? 'PATH' : null }, true);
    });
    const outside = e => { if (det.open && !det.contains(e.target)) det.open = false; };
    document.addEventListener('click', outside);
    paint();

    // ------------------------------------------------------------ bus
    const offs = [
      c.bus.on('packet', ev => { try { play(ev); } catch (e) { console.warn('Packet Journey sound', e); } }),
      c.bus.on('visible', v => { vis = !!v; if (!vis) dropCluster(); }),
    ];

    return {
      destroy() {
        offs.forEach(f => { try { f(); } catch { /* */ } });
        dropCluster(); document.removeEventListener('click', outside);
        st.on = false; teardown(); mount.innerHTML = '';
      },
      _test: { play: ev => play(ev), setOn, stats: () => Object.assign({ active, tokens, on: st.on }, counts) },
    };
  };
})();
