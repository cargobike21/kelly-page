/* Kelly Page -- LoRa Mesh > 🔭 Trace Route: tr-viz, the "Constellation" canvas (2026-10-24, unreleased).
 * A night sky with only three kinds of star: our node, the target, and the repeaters between. The packet is a comet
 * that draws the constellation line behind it: ice blue out (--tr-out), gold back (--tr-back). Line width and
 * brightness follow KellyTR.snrNorm, the glow under it is KellyTR.snrColor's band; a discovery (no SNR) draws neutral.
 *   idle      the selected pair (bus 'select' / c.selected()) with a faint dotted line, plus the last result for that
 *             target if one was seen this session (static)
 *   pending   the comet runs the engine's estMs timeline (from sentAt); stars ignite as it reaches them; past the
 *             target it waits there, "listening…", until 'done'
 *   success   replay of the real result, out then back, on js/tr-sound.js's clock (KellyTRSound.plan spacing; RTT shown real); a
 *             supernova at the target (once), a gold flare on our star, then the constellation's name (summary)
 *   failure   the comet fizzles at the last star it was estimated to reach, the rest is a dotted "unknown" track, the
 *             stars fade to grey, plain status text. no-path: the two stars with an empty sky between them.
 * Layout: GPS (equirectangular, padded, aspect kept) when our node and the target both have a position; hops without
 * one sit between their placed neighbours. Otherwise an even arc, us on the left, the target on the right.
 * Frames only through c.fxLoop; every animation ends, then the loop goes dormant (returns DEAD) until an event wakes a
 * fresh one. Nothing is drawn while !c.visible(). c.fx() false: no comet, the final figure fades in in a few steps.
 * Click a star -> bus 'select' { node, from: 'viz' } (not our own star, not a nameless hash).
 *
 * window.KellyTRViz(mount, c) -> { destroy(), _test } (_test = internals for tests/tr-viz-tests.html)
 */
(function () {
  'use strict';
  const DEAD = 2e9, MAX_HOPS = 64, FRAME_MS = 16, SLOW_MS = 1000;
  const FLARE_MS = 1100, SUMMARY_FADE = 600, FIZZLE_MS = 900, GREY_MS = 1300, FADE_STEP = 110, FADE_STEPS = 4;
  const GREY = '#5b6b8c', NEUTRAL = '#8aa0b8';
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const num = v => typeof v === 'number' && isFinite(v);
  const hasGps = s => s && num(s.lat) && num(s.lon) && !(s.lat === 0 && s.lon === 0);
  const ease = p => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  const short = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const dB = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' dB';
  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); const v = m ? parseInt(m[1], 16) : 0xffffff;
    return [v >> 16 & 255, v >> 8 & 255, v & 255];
  }
  const rgba = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${clamp(a, 0, 1).toFixed(3)})`; };
  const mix = (h1, h2, t) => { const a = rgb(h1), b = rgb(h2); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
  // one pre-rendered radial glow per colour (drawImage with 'lighter' is far cheaper than shadowBlur)
  const sprites = new Map();
  function sprite(color) {
    let s = sprites.get(color); if (s) return s;
    s = document.createElement('canvas'); s.width = s.height = 64;
    const g = s.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.16, rgba(color, 0.95)); gr.addColorStop(0.42, rgba(color, 0.3)); gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); sprites.set(color, s); return s;
  }
  // a quadratic segment bowed to the left of its direction: out and back legs over the same stars become a lens
  function qpt(s, t) { const u = 1 - t; return [u * u * s.ax + 2 * u * t * s.cx + t * t * s.bx, u * u * s.ay + 2 * u * t * s.cy + t * t * s.by]; }

  window.KellyTRViz = function (mount, c) {
    if (!mount || !c || !c.bus) return { destroy() {} };
    const TR = c.TR || window.KellyTR;
    const safeCall = (f, d) => { try { return f(); } catch (e) { return d; } };
    const fx = () => safeCall(() => (c.fx ? !!c.fx() : true) && !(c.reduced && c.reduced()), true);
    const visible = () => safeCall(() => c.visible ? !!c.visible() : true, true);
    const snrNorm = v => TR && TR.snrNorm ? TR.snrNorm(v) : 0.35;
    const snrColor = v => TR && TR.snrColor ? TR.snrColor(v) : NEUTRAL;
    const P = () => performance.now();

    mount.classList.add('tr-viz-host');
    mount.innerHTML = '<canvas class="tr-viz-cv" tabindex="0" role="img" aria-label="Trace Route: the route to the station and back, drawn as a constellation"></canvas>';
    const cv = mount.querySelector('canvas'), ctx = cv.getContext('2d');
    let W = 0, H = 0, dpr = 1, fs = 13, bg = null, col = {}, font = { mono: 'Consolas, monospace', disp: 'system-ui, sans-serif' };
    let dead = false, running = false, gen = 0, dirty = true, frames = 0, lastDelay = null;
    let view = null;                 // what is on the sky now (see makeView)
    const last = new Map();          // target id -> last finished TraceRun this session (cap 100)
    let hover = null;

    // ------------------------------------------------------------ views
    function capList(list) {
      if (list.length <= MAX_HOPS + 2) return { list, cut: 0 };
      return { list: [...list.slice(0, MAX_HOPS + 1), list[list.length - 1]], cut: list.length - MAX_HOPS - 2 };
    }
    function meHop() { const m = safeCall(() => c.me && c.me(), null) || {}; return { id: 'me', hash: null, name: m.name || 'My node', role: null, lat: m.lat ?? null, lon: m.lon ?? null, known: true, snr: null, estMs: 0 }; }
    function nodeHop(id) {
      const n = id != null ? safeCall(() => c.node && c.node(id), null) : null;
      return n ? { id: n.id, hash: n.key ? n.key.slice(0, 2) : null, name: n.name || short(n.id, 10), role: n.role, lat: n.lat, lon: n.lon, known: true, snr: null, estMs: null }
        : id != null ? { id, hash: null, name: short(String(id).replace(/^num:/, '#'), 12), role: null, lat: null, lon: null, known: false, snr: null, estMs: null } : null;
    }
    // a view: { kind 'idle'|'run', target, run, out [Hop], back [Hop], stars Map, segs, cut, t (anim start ms|null), mode }
    function makeView(kind, target, run) {
      let out = [], back = [], cut = 0;
      if (run) {
        const o = capList(Array.isArray(run.out) ? run.out.filter(Boolean) : []); out = o.list; cut = o.cut;
        const b = capList(Array.isArray(run.back) ? run.back.filter(Boolean) : []); back = b.list; cut = Math.max(cut, b.cut);
        if (!out.length || out[0].id !== 'me') out = [meHop(), ...out];
        if (out.length < 2) { const t = nodeHop(run.target) || { id: run.target || '?', name: run.targetName || 'target', known: false, snr: null }; out.push(t); }
        if (run.status === 'no-path') { out = [out[0], out[out.length - 1]]; back = []; }
      } else if (target != null) {
        const t = nodeHop(target); out = t ? [meHop(), t] : [meHop()];
      } else out = [meHop()];
      const stars = new Map();
      const add = (h, leg) => {
        let s = stars.get(h.id);
        if (!s) { s = { id: h.id, name: h.name || (h.hash ? 'hash ' + h.hash : '?'), role: h.role || null, lat: h.lat ?? null, lon: h.lon ?? null, known: !!h.known, x: 0, y: 0, placed: false, legs: new Set(), out: null, back: null, ignite: Infinity }; stars.set(h.id, s); }
        else if (!hasGps(s) && hasGps(h)) { s.lat = h.lat; s.lon = h.lon; }
        s.legs.add(leg); return s;
      };
      out.forEach((h, i) => { const s = add(h, 'out'); if (i > 0 && num(h.snr)) s.out = h.snr; });
      back.forEach((h, i) => { const s = add(h, 'back'); if (i > 0 && num(h.snr)) s.back = h.snr; });
      const segs = [];
      for (let i = 0; i + 1 < out.length; i++) segs.push({ leg: 'out', a: out[i].id, b: out[i + 1].id, snr: num(out[i + 1].snr) ? out[i + 1].snr : null, i });
      for (let i = 0; i + 1 < back.length; i++) segs.push({ leg: 'back', a: back[i].id, b: back[i + 1].id, snr: num(back[i + 1].snr) ? back[i + 1].snr : null, i });
      const v = { kind, target: run ? run.target : target, run: run || null, out, back, stars, segs, cut, t: null, lay: '', mode: 'arc', discover: !!(run && (run.method === 'discover' || run.method === 'ping')) };
      v.anim = !run ? 'none' : run.status === 'pending' ? 'pending' : kind === 'run' ? (run.status === 'success' ? 'replay' : 'fail') : 'static';
      if (v.anim === 'replay' || v.anim === 'fail') v.anim = fx() ? v.anim : 'fade';
      timeline(v);
      return v;
    }
    // the replay timeline: equal time per segment, the whole figure in ~4-8 s
    function timeline(v) {
      // same clock as js/tr-sound.js (KellyTRSound.plan): t=0 at 'done', star k (1-based along out[1..] then back[1..])
      // reached at k*spacing, arrival = nOut*spacing, return = n*spacing (or arrival + spacing when back is [])
      const nOut = v.segs.filter(s => s.leg === 'out').length, nBack = v.segs.length - nOut;
      const seg = replaySpacing(v.run, nOut + nBack);
      let t = 0;
      v.stars.forEach(s => { s.ignite = Infinity; });
      const me = v.stars.get('me'); if (me) me.ignite = 0;
      for (const s of v.segs) {
        s.t0 = t; s.t1 = t + seg; t += seg;
        const b = v.stars.get(s.b); if (b) b.ignite = Math.min(b.ignite, s.t1);
      }
      v.outEnd = nOut * seg; v.backEnd = nBack ? t : v.outEnd + seg; v.total = v.backEnd + FLARE_MS + SUMMARY_FADE;
      v.novaT = v.outEnd;
    }
    function replaySpacing(run, nSegs) {
      const SND = window.KellyTRSound;
      if (run && SND && typeof SND.plan === 'function') {
        const sp = safeCall(() => SND.plan(run).spacing, null);
        if (num(sp) && sp > 0) return sp;
      }
      // fallback = the sound part's formula (n from the run, not our 64-hop-capped segments)
      const n = run ? Math.max(1, Math.max(0, (run.out || []).length - 1) + Math.max(0, (run.back || []).length - 1)) : Math.max(1, nSegs);
      return Math.round(clamp(6000 / n, 120, 900));
    }
    function viewFor(target) {
      const r = target != null ? last.get(target) : null;
      return r ? makeView('idle', target, r) : makeView('idle', target, null);
    }

    // ------------------------------------------------------------ layout
    function measure() {
      const r = mount.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (w === W && h === H && cv.width === Math.max(1, Math.round(w * dpr))) return;
      W = w; H = h; cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      fs = clamp(Math.round(W / 62), 11, 26);
      const cs = safeCall(() => getComputedStyle(mount), null), tok = (n, d) => { const v = cs && cs.getPropertyValue(n).trim(); return v || d; };
      col = { out: tok('--tr-out', '#7df9ff'), back: tok('--tr-back', '#ffd36b'), star: tok('--tr-star', '#eaf6ff'), fail: tok('--tr-fail', '#ff3b5c'), amber: tok('--amber', '#ffb020'), dim: tok('--dim', '#8aa0b8') };
      font = { mono: tok('--mono', 'Consolas, monospace'), disp: tok('--display', 'system-ui, sans-serif') };
      bg = null; if (view) view.lay = ''; dirty = true;
    }
    function background() {
      if (bg && bg.width === cv.width && bg.height === cv.height) return bg;
      bg = document.createElement('canvas'); bg.width = cv.width; bg.height = cv.height;
      const g = bg.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      let seed = 0x2545f491 ^ (W * 31 + H); const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
      const n = Math.min(240, Math.round(W * H / 5200));
      for (let i = 0; i < n; i++) {
        const x = rnd() * W, y = rnd() * H, r = 0.35 + rnd() * rnd() * 1.3, a = 0.12 + rnd() * 0.45;
        g.fillStyle = `rgba(${200 + (rnd() * 55 | 0)},${215 + (rnd() * 40 | 0)},255,${a.toFixed(2)})`;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      return bg;
    }
    function layout(v) {
      const sig = `${W}x${H}`; if (v.lay === sig) return; v.lay = sig;
      const padX = Math.max(fs * 4.2, W * 0.08), top = fs * 4.2, bottom = fs * 6.8;
      const box = { x0: padX, x1: W - padX, y0: top, y1: Math.max(top + 10, H - bottom) };
      const stars = [...v.stars.values()]; stars.forEach(s => { s.placed = false; });
      const me = v.stars.get('me'), tgtId = v.out.length > 1 ? v.out[v.out.length - 1].id : null, tgt = tgtId != null ? v.stars.get(tgtId) : null;
      let gps = false;
      if (me && tgt && hasGps(me) && hasGps(tgt)) {
        const pts = stars.filter(hasGps), lat0 = pts.reduce((a, s) => a + s.lat, 0) / pts.length, k = Math.cos(lat0 * Math.PI / 180);
        const xs = pts.map(s => s.lon * k), ys = pts.map(s => -s.lat);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
        const spanX = maxX - minX, spanY = maxY - minY;
        if (Math.max(spanX, spanY) > 1e-5) {
          gps = true;
          const sc = Math.min((box.x1 - box.x0) / (spanX || 1e-9), (box.y1 - box.y0) / (spanY || 1e-9));
          const ox = (box.x0 + box.x1) / 2 - (minX + maxX) / 2 * sc, oy = (box.y0 + box.y1) / 2 - (minY + maxY) / 2 * sc;
          pts.forEach((s, i) => { s.x = xs[i] * sc + ox; s.y = ys[i] * sc + oy; s.placed = true; });
        }
      }
      v.mode = gps ? 'gps' : 'arc';
      if (!gps) {
        const midY = (box.y0 + box.y1) / 2, arcH = Math.min((box.y1 - box.y0) * 0.42, (box.x1 - box.x0) * 0.2);
        if (me) { me.x = box.x0; me.y = midY; me.placed = true; }
        if (tgt && tgt !== me) { tgt.x = box.x1; tgt.y = midY; tgt.placed = true; }
        if (!tgt && me) { me.x = W / 2; }
        const n = v.out.length - 1;
        v.out.forEach((h, i) => { const s = v.stars.get(h.id); if (s.placed) return; const t = i / n; s.x = box.x0 + (box.x1 - box.x0) * t; s.y = midY - Math.sin(Math.PI * t) * arcH; s.placed = true; });
        const m = v.back.length - 1;
        v.back.forEach((h, j) => { const s = v.stars.get(h.id); if (s.placed) return; const t = 1 - j / m; s.x = box.x0 + (box.x1 - box.x0) * t; s.y = midY + Math.sin(Math.PI * t) * arcH * 0.85; s.placed = true; });
      } else {
        // hops without a position: spread between their placed neighbours in route order (the return leg below the line)
        const fill = (seq, side) => {
          for (let i = 0; i < seq.length; i++) {
            const s = v.stars.get(seq[i].id); if (s.placed) continue;
            let a = i - 1; while (a >= 0 && !v.stars.get(seq[a].id).placed) a--;
            let b = i + 1; while (b < seq.length && !v.stars.get(seq[b].id).placed) b++;
            const A = a >= 0 ? v.stars.get(seq[a].id) : me, B = b < seq.length ? v.stars.get(seq[b].id) : tgt;
            const t = (i - a) / (b - a || 1), dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
            const off = side * fs * 1.6 * ((i - a) % 2 ? 1 : 0.4);
            s.x = A.x + dx * t - dy / L * off; s.y = A.y + dy * t + dx / L * off; s.placed = true;
          }
        };
        fill(v.out, 1); fill(v.back, -1);
      }
      stars.forEach(s => { if (!s.placed) { s.x = W / 2; s.y = H / 2; } s.x = clamp(s.x, fs, W - fs); s.y = clamp(s.y, fs * 2, H - fs * 2); });
      // bowed segments
      for (const g of v.segs) {
        const A = v.stars.get(g.a), B = v.stars.get(g.b), dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
        const bow = clamp(L * 0.12, 3, fs * 2.2);
        Object.assign(g, { ax: A.x, ay: A.y, bx: B.x, by: B.y, cx: (A.x + B.x) / 2 + dy / L * bow, cy: (A.y + B.y) / 2 - dx / L * bow, len: L });
      }
    }

    // ------------------------------------------------------------ frames
    function kick() {
      dirty = true;
      if (dead) return;
      running = true; const my = ++gen;   // a fresh loop each time (the old one dies at its next call), so events show at once
      const loop = c.fxLoop || (draw => { const s = now => setTimeout(() => requestAnimationFrame(s), draw(now)); requestAnimationFrame(s); });
      try {
        loop(() => {
          if (my !== gen || dead) return DEAD;
          let d;
          try { d = frame(P()); } catch (e) { console.warn('Trace Route viz', e); d = null; }
          lastDelay = d == null ? DEAD : d;
          if (d == null) { running = false; return DEAD; }
          return d;
        });
      } catch (e) { running = false; }
    }
    function frame(now) {
      if (!visible()) return null;
      if (!W || !H) measure();
      if (!W || !H || !view) return null;
      layout(view);
      const v = view, a = v.anim;
      if (a === 'pending') { render(now); return pendingDelay(); }
      if (a === 'replay' || a === 'fail' || a === 'fade') {
        if (v.t == null) v.t = now;
        const el = now - v.t, end = a === 'replay' ? v.total : a === 'fail' ? FIZZLE_MS + GREY_MS : FADE_STEP * FADE_STEPS;
        render(now);
        if (el >= end) { v.anim = 'static'; dirty = false; return null; }
        return a === 'fade' ? FADE_STEP : FRAME_MS;
      }
      if (dirty) { render(now); dirty = false; }
      return null;
    }
    function wallEl(v) { return v.run && num(v.run.sentAt) ? Date.now() - v.run.sentAt : null; }
    function estOf(v) {   // estMs per out index, monotonic, with a fallback when the engine left them out
      const per = safeCall(() => TR.hopMs(40, c.radio && c.radio()), 1200) || 1200;
      let lastE = 0; return v.out.map((h, i) => { const e = num(h.estMs) ? h.estMs : i * per; lastE = Math.max(lastE, e); return lastE; });
    }
    function pendingDelay() {
      const v = view, el = wallEl(v);
      if (el == null || !fx()) return SLOW_MS;   // queued / sending, or no motion: a 1 Hz redraw for the timer text
      const est = estOf(v);
      return el < est[est.length - 1] + 400 ? FRAME_MS : SLOW_MS;
    }

    // ------------------------------------------------------------ drawing
    function render(now) {
      frames++;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(background(), 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const v = view;
      if (v.anim === 'pending') drawPending(v);
      else if (v.run && v.run.status === 'success') drawSuccess(v, v.anim === 'static' ? Infinity : now - (v.t ?? now));
      else if (v.run) drawFail(v, v.anim === 'static' ? Infinity : now - (v.t ?? now));
      else drawIdle(v);
    }
    function segPath(g, p0, p1) {
      const n = Math.max(2, Math.ceil(18 * (p1 - p0)) + 1);
      ctx.beginPath();
      for (let k = 0; k < n; k++) { const [x, y] = qpt(g, p0 + (p1 - p0) * k / (n - 1)); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    }
    // a constellation line: a wide glow in the SNR band colour under a core in the leg colour
    function line(g, p, alpha, neutral) {
      if (p <= 0) return;
      const n = neutral ? 0.35 : snrNorm(g.snr), base = g.leg === 'out' ? col.out : col.back, sc = fs / 13;
      const band = neutral || g.snr == null ? NEUTRAL : snrColor(g.snr), w = (neutral ? 1.4 : 0.9 + 3.1 * n) * sc;
      segPath(g, 0, Math.min(1, p));
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(band, (neutral ? 0.1 : 0.12 + 0.26 * n) * alpha); ctx.lineWidth = w * 3.4; ctx.stroke();
      ctx.strokeStyle = rgba(base, (neutral ? 0.6 : 0.45 + 0.55 * n) * alpha); ctx.lineWidth = w; ctx.stroke();
    }
    function dotted(g, alpha, color) {
      segPath(g, 0, 1); ctx.setLineDash([2, fs * 0.55]); ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(color || col.star, alpha); ctx.lineWidth = Math.max(1, fs / 10); ctx.stroke(); ctx.setLineDash([]);
    }
    function star(s, lit, color, big) {
      const r = (big ? 0.55 : 0.36) * fs * (0.65 + 0.35 * lit), g = (big ? 6 : 4.2) * r * (0.5 + 0.5 * lit);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = clamp(0.25 + 0.75 * lit, 0, 1);
      ctx.drawImage(sprite(color), s.x - g, s.y - g, g * 2, g * 2);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = rgba(mix(color, '#ffffff', 0.6), 0.35 + 0.65 * lit); ctx.beginPath(); ctx.arc(s.x, s.y, r * 0.55, 0, Math.PI * 2); ctx.fill();
      if (s === hover && s.id !== 'me') { ctx.strokeStyle = rgba(col.star, 0.5); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.9, 0, Math.PI * 2); ctx.stroke(); }
    }
    function text(str, x, y, size, color, align, weight, family) {
      ctx.font = `${weight || 600} ${Math.round(size)}px ${family || font.mono}`; ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(3,6,15,.72)'; ctx.fillText(str, x + 1, y + 1);
      ctx.fillStyle = color; ctx.fillText(str, x, y);
    }
    function fitText(str, x, y, size, color, maxW, weight, family) {
      ctx.font = `${weight || 600} ${Math.round(size)}px ${family || font.mono}`;
      let s = String(str); while (s.length > 4 && ctx.measureText(s).width > maxW) s = s.slice(0, -2) + '…';
      text(s, x, y, size, color, 'center', weight, family);
    }
    function starColor(v, s) { return s.id === 'me' ? col.out : v.out.length > 1 && s.id === v.out[v.out.length - 1].id ? col.back : col.star; }
    const isEnd = (v, s) => s.id === 'me' || (v.out.length > 1 && s.id === v.out[v.out.length - 1].id);
    // labels: name, then the SNR it heard each way. Every star when they fit; else only the ends and the weakest hop
    function labels(v, alpha, opts) {
      const list = [...v.stars.values()], room = list.length <= Math.max(4, Math.floor(W / (fs * 7.5)));
      let weak = null; if (!room) for (const s of list) { const m = Math.min(s.out ?? 99, s.back ?? 99); if (m < 99 && (!weak || m < weak.m)) weak = { s, m }; }
      const sz = fs * 0.85, maxW = Math.max(fs * 6, Math.min(fs * 12, W / Math.max(3, Math.min(list.length, 9))));
      for (const s of list) {
        if (!(isEnd(v, s) || room || (weak && weak.s === s))) continue;
        if (opts && opts.reached && !opts.reached(s)) continue;
        // ends below their star (clear of the hops' labels), hops above; flipped near an edge / for a lower-arc star
        const end = isEnd(v, s), above = end ? s.y > H - fs * 9 : s.y > fs * 4.5 && !(v.mode === 'arc' && s.legs.has('back') && !s.legs.has('out'));
        const dy = (end ? 1.5 : 1.25) * fs, y0 = above ? s.y - dy : s.y + dy;
        const name = s.id === 'me' ? (s.name || 'My node') : s.name, c0 = opts && opts.grey ? GREY : end ? col.star : rgba(col.star, 0.85);
        ctx.globalAlpha = alpha; fitText(name, s.x, y0, end ? sz * 1.08 : sz, c0, maxW, end ? 700 : 600);
        const parts = [];
        if (!(opts && opts.noSnr)) { if (s.out != null) parts.push(['▸ ' + dB(s.out), snrColor(s.out)]); if (s.back != null) parts.push(['◂ ' + dB(s.back), snrColor(s.back)]); }
        if (parts.length) {
          const yy = above ? y0 - sz * 1.15 : y0 + sz * 1.15, sp = fs * 0.5;
          ctx.font = `600 ${Math.round(sz * 0.9)}px ${font.mono}`;
          const ws = parts.map(p => ctx.measureText(p[0]).width), tot = ws.reduce((a, b) => a + b, 0) + sp * (parts.length - 1);
          let x = s.x - tot / 2;
          parts.forEach((p, i) => { text(p[0], x + ws[i] / 2, yy, sz * 0.9, opts && opts.grey ? GREY : p[1]); x += ws[i] + sp; });
        }
        ctx.globalAlpha = 1;
      }
    }
    function caption(v) {
      const r = v.run; if (!r) return;
      const bits = [r.method === 'discover' ? 'PATH DISCOVERY' : r.method === 'ping' ? 'PING (MESSAGE + ACK)' : 'TRACE', r.via === 'live' ? null : r.via === 'sim-link' ? 'MESHCORE DEMO LINK' : 'DEMO'];
      if (r.tries > 1 && (r.status === 'pending' || r.attempt > 1)) bits.push(`TRY ${r.attempt}/${r.tries}`);
      if (v.mode === 'gps') bits.push('GPS');
      text(bits.filter(Boolean).join(' · '), fs, fs * 1.3, fs * 0.72, rgba(col.dim, 0.9), 'left', 700);
      if (r.changed && r.status === 'success') badge('⟲ ROUTE CHANGED', col.amber);
      if (v.cut) text(`+${v.cut} more hops not drawn`, W - fs, H - fs * 0.9, fs * 0.7, rgba(col.dim, 0.9), 'right');
    }
    function badge(str, color) {
      const sz = fs * 0.78; ctx.font = `700 ${Math.round(sz)}px ${font.mono}`;
      const w = ctx.measureText(str).width + fs * 1.2, h = sz * 1.9, x = W - w - fs * 0.8, y = fs * 0.5;
      ctx.fillStyle = rgba(color, 0.12); ctx.strokeStyle = rgba(color, 0.9); ctx.lineWidth = 1.2;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2); else ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
      text(str, x + w / 2, y + h / 2, sz, color, 'center', 700);
    }
    function footer(l1, l2, c1, alpha) {
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      if (l1) fitText(l1, W / 2, H - fs * 4, fs * 1.45, c1 || col.back, W - fs * 2, 700, font.disp);
      if (l2) fitText(l2, W / 2, H - fs * 2.1, fs * 0.88, rgba(col.star, 0.85), W - fs * 2, 600);
      ctx.globalAlpha = 1;
    }
    function nameOf(v) { const r = v.run, t = v.out.length > 1 ? v.stars.get(v.out[v.out.length - 1].id) : null; return (r && r.targetName) || (t && t.name) || 'the station'; }

    function drawIdle(v) {
      const me = v.stars.get('me'), t = v.out.length > 1 ? v.stars.get(v.out[1].id) : null;
      if (t) { dotted(v.segs[0], 0.28); star(t, 0.75, col.back, true); }
      if (me) star(me, 0.9, col.out, true);
      labels(v, 0.9, { noSnr: true });
      footer(t ? nameOf(v) : null, t ? 'not traced yet this session -- press Trace' : 'Pick a station to trace the route to it and back', t ? rgba(col.back, 0.75) : null, 0.9);
    }
    function drawPending(v) {
      const r = v.run, el = wallEl(v), est = estOf(v), moving = fx(), outSegs = v.segs.filter(g => g.leg === 'out');
      const tEnd = est[est.length - 1];
      // where the comet is on the estimate: segment index + fraction
      let seg = -1, frac = 0;
      if (el != null) { for (let i = 0; i + 1 < est.length; i++) if (el >= est[i]) { seg = i; frac = est[i + 1] > est[i] ? clamp((el - est[i]) / (est[i + 1] - est[i]), 0, 1) : 1; } }
      outSegs.forEach((g, i) => {
        dotted(g, 0.22);
        if (i < seg || (i === seg && frac >= 1)) line(g, 1, 0.75, true);
        else if (i === seg && moving) line(g, ease(frac), 0.75, true);
      });
      const reachedIdx = id => { const i = v.out.findIndex(h => h.id === id); return i; };
      for (const s of v.stars.values()) {
        const i = reachedIdx(s.id), lit = s.id === 'me' ? 1 : i >= 0 && el != null && el >= est[i] ? 1 : 0.15;
        star(s, lit, starColor(v, s), isEnd(v, s));
      }
      labels(v, 0.9, { noSnr: true });
      if (moving && seg >= 0 && el < tEnd) comet(outSegs[seg], ease(frac), col.out, el);
      caption(v);
      const name = nameOf(v), what = r.method === 'discover' ? 'Discovering a path to' : r.method === 'ping' ? 'Pinging' : 'Tracing';
      let l2;
      if (el == null) l2 = r.phase === 'queued' ? 'queued…' : 'sending…';
      else if (el >= tEnd) l2 = `listening for the answer… ${Math.floor(el / 1000)} s` + (r.timeoutMs ? ` of ${Math.round(r.timeoutMs / 1000)} s` : '');
      else l2 = `outbound, hop ${Math.max(1, seg + 1)} of ${outSegs.length} (estimated)`;
      footer(`${what} ${name}`, l2, rgba(col.out, 0.9));
    }
    // the comet: a bright head on the curve and a fading tail walked back along it
    function comet(g, p, color) {
      if (!g) return;
      const [hx, hy] = qpt(g, p), tail = Math.min(p, (fs * 7) / (g.len || 1));
      const N = 10;
      for (let k = N; k >= 1; k--) {
        const q = p - tail * k / N; if (q < 0) continue;
        const [x, y] = qpt(g, q), r = fs * 0.5 * (1 - k / N) + 1;
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5 * (1 - k / N);
        ctx.drawImage(sprite(color), x - r * 2, y - r * 2, r * 4, r * 4);
      }
      const R = fs * 1.5; ctx.globalAlpha = 1; ctx.drawImage(sprite(color), hx - R, hy - R, R * 2, R * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    function ring(x, y, p, color, rMax, width) {
      ctx.strokeStyle = rgba(color, (1 - p) * 0.9); ctx.lineWidth = Math.max(0.5, width * (1 - p));
      ctx.beginPath(); ctx.arc(x, y, 2 + rMax * ease(p), 0, Math.PI * 2); ctx.stroke();
    }
    function nova(s, p) {   // one ring burst + a short starburst at the target
      if (p <= 0 || p >= 1) return;
      ring(s.x, s.y, p, col.back, fs * 5, fs * 0.35);
      ring(s.x, s.y, clamp(p * 1.4 - 0.25, 0, 1), '#ffffff', fs * 3.2, fs * 0.2);
      ctx.strokeStyle = rgba(mix(col.back, '#ffffff', 0.5), (1 - p) * 0.8); ctx.lineWidth = Math.max(0.6, fs * 0.12);
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * Math.PI * 2 + 0.26, r0 = fs * (0.6 + 1.2 * p), r1 = r0 + fs * (k % 2 ? 1.4 : 2.4) * (1 - p * 0.5);
        ctx.beginPath(); ctx.moveTo(s.x + Math.cos(a) * r0, s.y + Math.sin(a) * r0); ctx.lineTo(s.x + Math.cos(a) * r1, s.y + Math.sin(a) * r1); ctx.stroke();
      }
      const R = fs * (2 + 3 * (1 - p)); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1 - p;
      ctx.drawImage(sprite(col.back), s.x - R, s.y - R, R * 2, R * 2); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    function summary(v) {
      const r = v.run, nOut = Math.max(0, r.out.length - 2), nBack = Math.max(0, r.back.length - 2);
      const bits = [`${nOut} hop${nOut === 1 ? '' : 's'} out`, r.back.length ? `${nBack} back` : 'no return path given'];
      if (num(r.rttMs)) bits.push(`RTT ${(r.rttMs / 1000).toFixed(r.rttMs < 10000 ? 2 : 1)} s`);
      let weak = null;
      v.segs.forEach(g => { if (g.snr != null && (!weak || g.snr < weak.snr)) weak = g; });
      if (weak) { const s = v.stars.get(weak.b); bits.push(`weakest hop ${dB(weak.snr)}${s && s.id !== 'me' ? ' at ' + short(s.name, 18) : ' (heard by us)'}`); }
      else if (v.discover) bits.push('discovery: no SNR');
      return bits.join(' · ');
    }
    function drawSuccess(v, el) {
      const all = el === Infinity, neutral = v.discover || v.segs.every(g => g.snr == null), fade = v.anim === 'fade';
      const alpha = fade ? Math.min(1, Math.floor(el / FADE_STEP + 1) / FADE_STEPS) : 1;
      if (fade || all) {
        v.segs.forEach(g => line(g, 1, alpha, neutral));
        for (const s of v.stars.values()) star(s, alpha, starColor(v, s), isEnd(v, s));
        labels(v, alpha, { noSnr: neutral });
        caption(v);
        footer(nameOf(v), summary(v), col.back, alpha);
        return;
      }
      let head = null;
      v.segs.forEach(g => {
        if (el >= g.t1) line(g, 1, 1, neutral);
        else if (el >= g.t0) { const p = ease((el - g.t0) / (g.t1 - g.t0)); line(g, p, 1, neutral); head = [g, p]; }
        else if (g.leg === 'out' || el < v.outEnd) dotted(g, 0.12);
      });
      for (const s of v.stars.values()) {
        const dt = el - s.ignite, lit = dt >= 0 ? 1 : 0.15;
        star(s, lit, starColor(v, s), isEnd(v, s));
        if (dt >= 0 && dt < 380 && s.id !== 'me') ring(s.x, s.y, dt / 380, starColor(v, s), fs * 1.6, fs * 0.15);
      }
      labels(v, 1, { noSnr: neutral, reached: s => el >= s.ignite });
      const tgt = v.stars.get(v.out[v.out.length - 1].id);
      if (tgt && tgt.id !== 'me') nova(tgt, (el - v.novaT) / 1100);
      if (head) comet(head[0], head[1], head[0].leg === 'out' ? col.out : col.back);
      const me = v.stars.get('me');
      if (me && el >= v.backEnd) {
        const p = (el - v.backEnd) / FLARE_MS;
        if (p < 1) { ring(me.x, me.y, p, col.back, fs * 3.6, fs * 0.3); const R = fs * (1.8 + 2.4 * (1 - p)); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 1 - p; ctx.drawImage(sprite(col.back), me.x - R, me.y - R, R * 2, R * 2); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
      }
      caption(v);
      const sumAt = v.backEnd + FLARE_MS * 0.4;
      if (el >= sumAt) footer(nameOf(v), summary(v), col.back, clamp((el - sumAt) / SUMMARY_FADE, 0, 1));
    }
    // failure: the index of the last out star the estimate says it reached (never the target: nobody answered)
    function fizzleIdx(v) {
      const r = v.run; if (!r || !num(r.sentAt) || r.status === 'no-path') return 0;
      const el = (num(r.endedAt) ? r.endedAt : Date.now()) - r.sentAt, est = estOf(v);
      let i = 0; for (let k = 0; k < est.length; k++) if (el >= est[k]) i = k;
      return clamp(i, 0, Math.max(0, v.out.length - 2));
    }
    function failText(v) {
      const r = v.run, name = nameOf(v), tries = r.attempt > 1 ? ` (${r.attempt} tries)` : '';
      if (r.status === 'timeout') return [`No answer from ${name}`, (r.error || 'lost somewhere after us -- MeshCore can’t say which hop dropped it') + tries];
      if (r.status === 'no-path') return [`No path to ${name}`, r.error || 'no route known, and discovery found none'];
      if (r.status === 'cancelled') return ['Trace cancelled', r.error || name];
      return [`Trace to ${name} failed`, r.error || 'something went wrong'];
    }
    function drawFail(v, el) {
      const all = el === Infinity, fade = v.anim === 'fade', fi = fizzleIdx(v), outSegs = v.segs.filter(g => g.leg === 'out');
      const alpha = fade ? Math.min(1, Math.floor(el / FADE_STEP + 1) / FADE_STEPS) : 1;
      const grey = all || fade ? 1 : clamp((el - FIZZLE_MS * 0.6) / GREY_MS, 0, 1);
      const noPath = v.run.status === 'no-path';
      if (!noPath) outSegs.forEach((g, i) => { if (i < fi) line(g, 1, alpha * (0.55 - 0.3 * grey), true); else dotted(g, 0.3 * alpha, mix(col.star, GREY, grey)); });
      const fz = v.stars.get(v.out[fi].id);
      for (const s of v.stars.values()) {
        const i = v.out.findIndex(h => h.id === s.id), reached = i >= 0 && i <= fi;
        const c0 = s.id === 'me' ? col.out : mix(starColor(v, s), GREY, grey);
        star(s, alpha * (s.id === 'me' ? 0.9 : reached ? 0.75 - 0.35 * grey : 0.3), c0, isEnd(v, s));
      }
      labels(v, alpha, { noSnr: true, grey: grey > 0.5 });
      if (!all && !fade && fz && !noPath) {   // the fizzle: a few sparks drifting down and out
        const p = clamp(el / FIZZLE_MS, 0, 1);
        if (p < 1) {
          ctx.globalCompositeOperation = 'lighter';
          for (let k = 0; k < 14; k++) {
            const a = (k * 2.399) % (Math.PI * 2), d = fs * (0.6 + (k % 5) * 0.45) * ease(p), x = fz.x + Math.cos(a) * d, y = fz.y + Math.sin(a) * d * 0.7 + fs * 1.2 * p * p;
            const r = fs * 0.35 * (1 - p) + 0.5; ctx.globalAlpha = (1 - p) * 0.9;
            ctx.drawImage(sprite(k % 3 ? col.out : col.fail), x - r * 2, y - r * 2, r * 4, r * 4);
          }
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
        }
      }
      caption(v);
      const [l1, l2] = failText(v);
      footer(l1, l2, rgba(mix(col.fail, GREY, 0.25), 0.95), all || fade ? alpha : clamp(el / 500, 0, 1));
    }

    // ------------------------------------------------------------ events
    const safe = f => (...a) => { try { f(...a); } catch (e) { console.warn('Trace Route viz', e); } };
    function showRun(r, kind) {
      const same = view && view.run && view.run.id === r.id && view.out.length && r.out.length === view.run.out.length && r.out.every((h, i) => h.id === view.run.out[i].id) && r.status === 'pending' && view.anim === 'pending';
      if (same) { view.run = r; view.out = view.out.map((h, i) => Object.assign({}, h, { estMs: r.out[i] ? r.out[i].estMs : h.estMs })); return; }
      view = makeView(kind, r.target, r);
    }
    function setSel(id) {
      if (view && view.anim === 'pending') return;   // the run in flight stays on the sky
      if (view && view.target === id && id != null) return;
      view = viewFor(id);
    }
    function remember(r) {
      if (!r || r.target == null) return;
      last.delete(r.target); last.set(r.target, r);
      while (last.size > 100) last.delete(last.keys().next().value);
    }
    function hit(x, y) {
      if (!view) return null; let best = null, bd = Math.max(14, fs * 1.3);
      for (const s of view.stars.values()) { const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = s; } }
      return best;
    }
    const pos = e => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    const clickable = s => s && s.id !== 'me' && !String(s.id).startsWith('h:');
    cv.addEventListener('click', safe(e => {
      const s = hit(...pos(e)); if (!clickable(s)) return;
      c.bus.emit('select', { node: s.id, from: 'viz' });
    }));
    cv.addEventListener('mousemove', safe(e => {
      const s = hit(...pos(e)), h = clickable(s) ? s : null;
      cv.style.cursor = h ? 'pointer' : '';
      if (h !== hover) { hover = h; if (view && (view.anim === 'static' || view.anim === 'none')) kick(); }
    }));

    const offs = [
      c.bus.on('run', safe(r => { if (!r || !r.id) return; if (r.status === 'pending') { showRun(r, 'run'); kick(); } })),
      c.bus.on('done', safe(r => { if (!r || !r.id || r.status === 'pending') return; remember(r); view = makeView('run', r.target, r); kick(); })),
      c.bus.on('select', safe(s => { if (!s || s.node == null) return; setSel(s.node); kick(); })),
      c.bus.on('nodes', safe(() => { if (view && view.kind === 'idle' && !view.run) { view = viewFor(view.target); kick(); } })),
      c.bus.on('demo', safe(() => { last.clear(); if (!view || view.anim !== 'pending') view = viewFor(null); kick(); })),
      c.bus.on('visible', safe(v => { if (v) { W = 0; measure(); kick(); } })),
    ];
    let ro = null;
    try { ro = new ResizeObserver(() => { try { measure(); kick(); } catch (e) { /* ignore */ } }); ro.observe(mount); } catch (e) { window.addEventListener('resize', kick); }

    safeCall(() => {
      const cur = c.current && c.current();
      if (cur && cur.status === 'pending') view = makeView('run', cur.target, cur);
      else view = viewFor(c.selected ? c.selected() : null);
    });
    if (!view) view = viewFor(null);
    measure(); kick();

    return {
      destroy() {
        dead = true; gen++;
        offs.forEach(f => { try { f(); } catch (e) { /* ignore */ } });
        try { ro && ro.disconnect(); } catch (e) { /* ignore */ }
        window.removeEventListener('resize', kick);
        mount.innerHTML = ''; mount.classList.remove('tr-viz-host');
      },
      _test: { view: () => view, last, running: () => running, frames: () => frames, lastDelay: () => lastDelay, hit, measure, kick, fs: () => fs, size: () => [W, H] },
    };
  };
})();
