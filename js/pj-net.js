/* Kelly Page -- LoRa Mesh > Packet Journey: pj-net, the live network canvas (2026-10-24, unreleased).
 * A SCADA-style picture of the mesh as our node hears it: our node in the centre, everything else on rings by hop
 * distance (a light force layout that settles, then stops) or by GPS (nodes without a position parked on a side rail).
 * Each 'packet' is a glowing pulse flying along ev.journey (origin -> repeaters -> me) with a fading trail; colour =
 * PALETTE[kind], radius by size, brightness by SNR; a flood starts with a burst at the origin, a landing ripples at our
 * node, a direct packet's 'ahead' hops are drawn dashed beyond us. Links that carried traffic glow, then fade.
 * Click a node -> details overlay + bus 'select' { node, from: 'net' }; 'select' from elsewhere highlights a node or a
 * packet's journey. Coded against js/pj-core.js only (see PACKET_JOURNEY_PLAN.md).
 *
 * Frames: only through c.fxLoop(draw). The loop runs while something moves, polls every POLL_MS for a short while
 * once quiet, then goes dormant (returns DEAD) until the next packet / select / resize wakes a fresh loop. Nothing is
 * drawn while the tab is hidden. c.fx() false: no motion -- paths light up and fade in a few steps, no ripples.
 *
 * window.KellyPJNet(mount, c) -> { destroy(), _t } (_t = internals for tests/pj-net-tests.html)
 */
(function () {
  'use strict';
  const MAX_VIEW = 120;   // nodes drawn at once: the most recently heard (the layout is n^2 per frame)
  const MAX_PULSES = 60, MAX_RIPPLES = 30, MAX_BURSTS = 20, MAX_GHOSTS = 20, MAX_FLASHES = 40;
  const HOP_MS = 460, FADE_MS = 2600, DEAD = 2e9, POLL_MS = 200, DORMANT_AFTER = 20000;
  const STEP_MS = 320, STEPS = [1, 0.62, 0.36, 0.16];   // reduced motion: lit, then fade in four steps
  const COL = { me: '#00e5ff', repeater: '#ff2bd6', companion: '#8fb4ff', 'room server': '#39ff88', sensor: '#ffb020', node: '#9fb0d8', ph: '#5b6b8c', unknown: '#ff3b5c' };
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const num = v => typeof v === 'number' && isFinite(v);
  const hasGps = n => n && num(n.lat) && num(n.lon) && !(n.lat === 0 && n.lon === 0);
  const ease = p => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); const v = m ? parseInt(m[1], 16) : 0xffffff;
    return [v >> 16 & 255, v >> 8 & 255, v & 255];
  }
  const rgba = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${clamp(a, 0, 1).toFixed(3)})`; };
  // one pre-rendered radial glow per colour: drawImage with 'lighter' is far cheaper than shadowBlur
  const sprites = new Map();
  function sprite(color) {
    let s = sprites.get(color); if (s) return s;
    s = document.createElement('canvas'); s.width = s.height = 64;
    const g = s.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, rgba(color, 0.95)); gr.addColorStop(0.45, rgba(color, 0.32)); gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); sprites.set(color, s); return s;
  }
  const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  window.KellyPJNet = function (mount, c) {
    if (!mount || !c || !c.bus) return { destroy() {} };
    const esc = c.esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';'));
    const fmtAgo = c.fmtAgo || (t => t ? Math.round((Date.now() - t) / 1000) + 's ago' : 'never');
    const fx = () => { try { return c.fx ? !!c.fx() : true; } catch (e) { return true; } };
    const visible = () => { try { return c.visible ? !!c.visible() : true; } catch (e) { return true; } };
    const reg = c.reg || { get: () => null, canonical: id => id, all: () => [], me: () => null };
    const canon = id => { try { return reg.canonical(id) || id; } catch (e) { return id; } };
    const regGet = id => { try { return reg.get(id) || null; } catch (e) { return null; } };
    const PAL = (c.PJ && c.PJ.PALETTE) || {};
    const T = () => performance.now();

    let layout = 'auto';
    try { layout = c.store && c.store.get('pjNetLayout', 'auto') === 'gps' ? 'gps' : 'auto'; } catch (e) { /* storage off */ }
    mount.classList.add('pj-net-host');
    mount.innerHTML = `<canvas class="pj-net-cv" tabindex="0" aria-label="Live network picture: packets flying along their hop paths to our node"></canvas>
      <div class="pj-net-ctl">
        <button class="btn ghost pj-net-btn" data-act="layout" title="Switch between rings by hop distance and a GPS map"></button>
        <button class="btn ghost pj-net-btn" data-act="spread" title="Spread the nodes out again">⟳</button>
      </div>
      <div class="pj-net-key"><span><i class="me"></i>Our node</span><span><i class="rpt"></i>Repeater</span><span><i class="cmp"></i>Companion</span><span><i class="ph"></i>Only a path hash / name</span></div>
      <div class="pj-net-info" hidden></div>`;
    const cv = mount.querySelector('.pj-net-cv'), ctx = cv.getContext('2d');
    const info = mount.querySelector('.pj-net-info'), btnLayout = mount.querySelector('[data-act=layout]');
    let mono = 'Consolas, monospace', disp = mono;
    try { const cs = getComputedStyle(document.documentElement); mono = cs.getPropertyValue('--mono').trim() || mono; disp = cs.getPropertyValue('--display').trim() || mono; } catch (e) { /* defaults */ }

    // ------------------------------------------------------------ state
    const nodes = new Map();   // id -> view node
    const links = new Map();   // 'a|b' -> { a, b, n, solid, hotT, color }
    let pulses = [], ripples = [], bursts = [], ghosts = [], flashes = [];
    let selNode = null, selPath = null, hover = null, lastPkt = null, total = 0;
    let W = 0, H = 0, dpr = 1, scale = 0, scaleT = 0, alpha = 0, lastHot = -1e9, dirty = true, dead = false;
    let running = false, gen = 0, quietSince = 0, lastFrame = 0, infoAt = 0;

    function vnode(id) {
      let v = nodes.get(id); if (v) return v;
      v = { id, x: 0, y: 0, vx: 0, vy: 0, sx: NaN, sy: NaN, tx: 0, ty: 0, dist: id === 'me' ? 0 : Infinity, placed: id === 'me', flashT: -1e9, heard: 0, sent: 0, relayed: 0, nbr: null };
      nodes.set(id, v); alpha = Math.max(alpha, 0.6); return v;
    }
    vnode('me');
    const lkey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
    function link(a, b, solid) {
      if (a === b) return null;
      const k = lkey(a, b); let l = links.get(k);
      if (!l) { l = { a, b, n: 0, solid: false, hotT: -1e9, color: '#00e5ff' }; links.set(k, l); }
      if (solid) l.solid = true; return l;
    }
    const dedupe = ids => { const o = []; for (const id of ids) if (id != null && o[o.length - 1] !== id) o.push(id); return o; };
    const ids = arr => dedupe((Array.isArray(arr) ? arr : []).map(x => canon(String(x))));
    const glow = age => fx() ? (age < FADE_MS ? Math.exp(-age / 700) : 0) : (STEPS[Math.floor(age / STEP_MS)] || 0);

    // registry -> view: fold placeholders into their key nodes, drop what the registry forgot (reset), add the new
    function syncNodes() {
      for (const [id, v] of [...nodes]) {
        if (id === 'me') continue;
        if (!regGet(id)) { nodes.delete(id); continue; }
        const k = canon(id);
        if (k !== id) {
          const t = nodes.get(k);
          if (t) { t.heard += v.heard; t.sent += v.sent; t.relayed += v.relayed; t.dist = Math.min(t.dist, v.dist); t.flashT = Math.max(t.flashT, v.flashT); }
          else { v.id = k; nodes.set(k, v); }
          nodes.delete(id);
          if (selNode === id) selNode = k;
          for (const [lk, l] of [...links]) if (l.a === id || l.b === id) {
            links.delete(lk); const a = l.a === id ? k : l.a, b = l.b === id ? k : l.b;
            const m = link(a, b, l.solid); if (m) { m.n += l.n; m.hotT = Math.max(m.hotT, l.hotT); m.color = l.color; }
          }
        }
      }
      try {
        const fresh = reg.all().filter(n => n && n.id && n.id !== 'unknown' && canon(n.id) === n.id).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        for (const n of fresh.slice(0, MAX_VIEW)) vnode(n.id);
      } catch (e) { /* registry missing */ }
      trimView();
      alpha = Math.max(alpha, 0.3); dirty = true;
    }

    // over MAX_VIEW: drop the least recently heard that no packet in flight is using (and their links)
    function trimView() {
      if (nodes.size > MAX_VIEW) {
        const busy = new Set(); for (const p of pulses) for (const id of p.ids.concat(p.ahead || [])) busy.add(id);
        const seen = id => { const n = regGet(id); return n ? n.lastSeen || 0 : 0; };
        const old = [...nodes.keys()].filter(id => id !== 'me' && id !== 'unknown' && id !== selNode && !busy.has(id)).sort((a, b) => seen(a) - seen(b));
        for (const id of old.slice(0, nodes.size - MAX_VIEW)) nodes.delete(id);
      }
      for (const [lk, l] of [...links]) if (!nodes.has(l.a) || !nodes.has(l.b)) links.delete(lk);
    }

    // ------------------------------------------------------------ packets
    function onPacket(ev) {
      if (!ev || typeof ev !== 'object') return;
      let path = ids(ev.journey); if (!path.length) path = ['unknown', 'me'];
      if (path[path.length - 1] !== 'me') path.push('me');
      const ahead = ids(ev.ahead).filter(id => id !== 'me');
      const kind = PAL[ev.kind] ? ev.kind : 'unknown', color = (PAL[kind] && PAL[kind].color) || '#ff3b5c';
      const now = T();
      total++;
      path.forEach((id, i) => {
        const v = vnode(id), d = path.length - 1 - i;
        if (d < v.dist) { v.dist = d; alpha = Math.max(alpha, 0.5); }
        if (i < path.length - 1) { v.heard++; if (i === 0) v.sent++; else v.relayed++; v.nbr = path[i + 1]; }
        if (i) { const l = link(path[i - 1], id, true); if (l) { l.n++; l.color = color; } }
      });
      ahead.forEach((id, i) => {
        const v = vnode(id); if (i + 1 < v.dist) v.dist = i + 1; if (!v.nbr) v.nbr = i ? ahead[i - 1] : 'me'; v.heard++;
        const l = link(i ? ahead[i - 1] : 'me', id, false); if (l) { l.n++; l.color = color; }
      });
      if (nodes.size > MAX_VIEW) trimView();
      const size = num(ev.size) ? ev.size : 40, snr = num(ev.snr) ? ev.snr : null;
      const pk = { ids: path, ahead, color, kind, flood: ev.route === 'flood', seq: ev.seq,
        r: 2.6 + clamp(size, 0, 255) / 255 * 6.5, bright: snr == null ? 0.7 : clamp((snr + 20) / 35, 0.18, 1) };
      lastPkt = { kind, color, label: (PAL[kind] && PAL[kind].label) || kind, from: nameOf(path[0]), hops: Math.max(0, path.length - 2), route: ev.route || '', snr, rssi: num(ev.rssi) ? Math.round(ev.rssi) : null, at: Date.now() };
      dirty = true;
      if (!visible()) return;   // the counts and links stay current; nothing to animate on a hidden tab
      launch(pk, now);
      if (selNode && path.includes(selNode) && Date.now() - infoAt > 600) showInfo(selNode);
      kick();
    }
    function launch(pk, now) {
      if (fx()) {
        pulses.push(Object.assign({ t0: now, step: 0, hop: Math.max(160, Math.min(pulses.length > 30 ? HOP_MS * 0.65 : HOP_MS, 2800 / Math.max(1, pk.ids.length - 1))) }, pk));   // a long path flies faster: any journey <= ~2.8 s
        if (pulses.length > MAX_PULSES) pulses.splice(0, pulses.length - MAX_PULSES);
        flashNode(pk.ids[0], now);
        if (pk.flood) { bursts.push({ id: pk.ids[0], t0: now, color: pk.color }); if (bursts.length > MAX_BURSTS) bursts.shift(); }
      } else {
        flashes.push({ ids: pk.ids, ahead: pk.ahead, color: pk.color, t0: now });
        if (flashes.length > MAX_FLASHES) flashes.shift();
        pk.ids.forEach(id => flashNode(id, now));
        for (let i = 1; i < pk.ids.length; i++) heat(pk.ids[i - 1], pk.ids[i], pk.color, now);
      }
    }
    function flashNode(id, now) { const v = nodes.get(id); if (v) v.flashT = now; lastHot = now; }
    function heat(a, b, color, now) { const l = links.get(lkey(a, b)); if (l) { l.hotT = now; l.color = color; } lastHot = now; }
    function nameOf(id) {
      if (id === 'me') { const m = regGet('me'); return (m && m.name) || 'My node'; }
      const n = regGet(id); if (!n) return String(id || '?');
      return n.name || n.hash || (n.key ? n.key.slice(0, 8) : String(id));
    }
    function kindOf(id) {   // view class: me | repeater | companion | room server | sensor | node | ph | unknown
      if (id === 'me') return 'me'; if (id === 'unknown') return 'unknown';
      const n = regGet(id); if (!n) return 'ph';
      if (String(n.id || id).startsWith('h:') || String(n.id || id).startsWith('n:')) return 'ph';
      return COL[n.role] ? n.role : n.known ? 'node' : 'ph';
    }

    // ------------------------------------------------------------ layout
    // rings: one per hop distance that has nodes (unknown distance outermost), each big enough round for its nodes
    let rings = new Map();
    function ringTable() {
      const cnt = new Map(); for (const v of nodes.values()) if (v.id !== 'me') { const d = v.dist === Infinity ? Infinity : Math.max(1, v.dist); cnt.set(d, (cnt.get(d) || 0) + 1); }
      const m = new Map(); let R = 0;
      for (const d of [...cnt.keys()].sort((a, b) => a - b)) { const n = cnt.get(d); R = Math.max(R ? R + 0.5 + 0.4 * Math.min(1, n / 8) : 1.2, n * 0.46 / (2 * Math.PI)); m.set(d, R); }   // sparse outer rings sit closer
      return (rings = m);
    }
    const ringOf = v => rings.get(v.dist === Infinity ? Infinity : Math.max(1, v.dist)) || 1;
    function place(v) {   // a new node: on its ring, near the neighbour it talks to
      const r = ringOf(v), nb = v.nbr && nodes.get(v.nbr);
      const a = nb && nb.placed && (nb.x || nb.y) ? Math.atan2(nb.y, nb.x) + (Math.random() - 0.5) * 0.9 : Math.random() * Math.PI * 2;
      v.x = Math.cos(a) * r; v.y = Math.sin(a) * r; v.placed = true;
    }
    function tick() {
      ringTable(); const arr = [...nodes.values()];
      for (const v of arr) if (!v.placed) place(v);
      for (const v of arr) {
        if (v.id === 'me') continue;
        const r = Math.hypot(v.x, v.y) || 1e-3, f = (ringOf(v) - r) * 0.12;
        v.vx += v.x / r * f; v.vy += v.y / r * f;
      }
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {   // keep nodes apart
        const p = arr[i], q = arr[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1e-3;
        if (d < 0.9) { const f = (0.9 - d) / d * (d < 0.45 ? 0.2 : 0.05); p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f; }
      }
      for (const l of links.values()) {   // links pull their ends round to the same side
        const p = nodes.get(l.a), q = nodes.get(l.b); if (!p || !q) continue;
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1e-3, f = (d - 1) / d * 0.005;
        p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
      }
      for (const v of arr) {
        if (v.id === 'me') { v.x = v.y = v.vx = v.vy = 0; continue; }
        const m = Math.min(1, alpha * 2); v.vx *= 0.6; v.vy *= 0.6;
        v.x += clamp(v.vx, -0.2, 0.2) * m; v.y += clamp(v.vy, -0.2, 0.2) * m;
      }
      alpha *= 0.965; if (alpha < 0.004) alpha = 0;
    }
    function settleNow() {   // reduced motion: no visible settling, compute it up front (bounded work)
      const n = nodes.size, ticks = Math.min(220, Math.floor(4e6 / (n * n + 1)) || 1);
      for (let i = 0; i < ticks && alpha > 0; i++) tick();
      alpha = 0;
    }
    function targets() {
      const rail = Math.min(170, Math.max(110, W * 0.2));
      if (layout === 'auto') {
        let mr = 1.3; for (const v of nodes.values()) mr = Math.max(mr, Math.hypot(v.x, v.y) + 0.3);
        scaleT = Math.max(10, (Math.min(W, H) / 2 - 34) / mr);
        if (!scale || !fx()) scale = scaleT;
        const cx = W / 2, cy = H / 2 + 6;
        for (const v of nodes.values()) { v.tx = cx + v.x * scale; v.ty = cy + v.y * scale; v.rail = false; v.hidden = false; }
        return { cx, cy };
      }
      const geo = [], off = [];
      for (const v of nodes.values()) { const n = v.id === 'me' ? regGet('me') : regGet(v.id); (hasGps(n) ? geo : off).push([v, n]); }
      const x0 = 22, x1 = W - rail - 22, y0 = 44, y1 = H - 34;
      let g = null;
      if (geo.length) {
        const lat0 = geo.reduce((s, [, n]) => s + n.lat, 0) / geo.length, k = Math.cos(lat0 * Math.PI / 180);
        let a = Infinity, b = -Infinity, cmin = Infinity, cmax = -Infinity;
        for (const [, n] of geo) { const px = n.lon * k, py = -n.lat; a = Math.min(a, px); b = Math.max(b, px); cmin = Math.min(cmin, py); cmax = Math.max(cmax, py); }
        const sx = Math.max(b - a, 0.03), sy = Math.max(cmax - cmin, 0.03), s = Math.min((x1 - x0) / sx, (y1 - y0) / sy);
        const ox = (x0 + x1) / 2 - (a + b) / 2 * s, oy = (y0 + y1) / 2 - (cmin + cmax) / 2 * s;
        for (const [v, n] of geo) { v.tx = ox + n.lon * k * s; v.ty = oy - n.lat * s; v.rail = false; v.hidden = false; }
        g = { kmPerPx: 111.32 / s };
      }
      const rank = v => v.id === 'me' ? -1e9 : (kindOf(v.id) === 'repeater' ? -1e6 : 0) - v.heard;
      off.sort((p, q) => rank(p[0]) - rank(q[0]));
      const slots = Math.max(1, Math.floor((H - 70) / 19)), rx = W - rail + 14;
      off.forEach(([v], i) => { const s = Math.min(i, slots - 1); v.tx = rx; v.ty = 56 + s * 19; v.rail = true; v.hidden = i >= slots - 1 && off.length > slots; });
      return { geo: g, rail, railX: W - rail, more: off.length > slots ? off.length - slots + 1 : 0, noGps: !geo.length };
    }
    // ease every node toward its target; returns true while something is still moving
    function moveNodes(dt) {
      let moving = false; const k = fx() ? 1 - Math.exp(-dt / 140) : 1;
      for (const v of nodes.values()) {
        if (!num(v.sx)) { v.sx = v.tx; v.sy = v.ty; continue; }
        const dx = v.tx - v.sx, dy = v.ty - v.sy;
        if (Math.abs(dx) + Math.abs(dy) < 0.3) { v.sx = v.tx; v.sy = v.ty; continue; }
        v.sx += dx * k; v.sy += dy * k; moving = true;
      }
      if (fx() && Math.abs(scale - scaleT) > 0.2) { scale += (scaleT - scale) * k; moving = true; } else scale = scaleT;
      return moving;
    }

    // ------------------------------------------------------------ frames
    function kick() {
      dirty = true; quietSince = T();
      if (dead || running) return;
      running = true; const my = ++gen;
      const loop = c.fxLoop || (draw => { const s = now => setTimeout(() => requestAnimationFrame(s), draw(now)); requestAnimationFrame(s); });
      try {
        loop(now => {
          if (my !== gen || dead) return DEAD;
          let d;
          try { d = frame(num(now) ? now : T()); } catch (e) { console.warn('Packet Journey net', e); pulses = []; ripples = []; bursts = []; ghosts = []; flashes = []; d = null; }   // drop what broke, sleep
          if (d == null) { running = false; return DEAD; }   // dormant: the next kick() starts a fresh loop
          return d;
        });
      } catch (e) { running = false; }
    }
    function frame(now) {
      if (!visible()) return null;
      if (!W || !H) measure();
      if (!W || !H) return null;
      const dt = Math.min(100, lastFrame ? now - lastFrame : 16); lastFrame = now;
      if (layout === 'auto' && alpha > 0) { if (fx()) { tick(); tick(); } else settleNow(); }
      const L = targets(), moving = moveNodes(dt) || alpha > 0;
      const busy = pulses.length || ripples.length || bursts.length || ghosts.length || flashes.length;
      const fading = now - lastHot < FADE_MS;
      if (busy || moving || fading || dirty) { render(now, L); dirty = false; }
      if (fx() && (busy || moving)) { quietSince = now; return 0; }
      if (fading) { quietSince = now; return fx() ? 40 : STEP_MS; }
      if (flashes.length) { quietSince = now; return STEP_MS; }
      return now - quietSince > DORMANT_AFTER ? null : POLL_MS;
    }
    function measure() {
      const r = mount.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (w === W && h === H && cv.width === Math.round(w * dpr)) return;
      W = w; H = h; cv.width = Math.max(1, Math.round(w * dpr)); cv.height = Math.max(1, Math.round(h * dpr));
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      for (const v of nodes.values()) v.sx = NaN;   // snap to the new size
      scale = 0; dirty = true;
    }

    // a pulse's head and the trail behind it, walked back along the polyline
    function trailPts(P, seg, frac, len) {
      const a = P[seg], b = P[seg + 1], hx = a.sx + (b.sx - a.sx) * frac, hy = a.sy + (b.sy - a.sy) * frac, pts = [[hx, hy]];
      let left = len, cx = hx, cy = hy, i = seg;
      while (left > 0 && i >= 0) {
        const p = P[i], d = Math.hypot(cx - p.sx, cy - p.sy);
        if (d >= left) { const t = left / (d || 1); pts.push([cx + (p.sx - cx) * t, cy + (p.sy - cy) * t]); break; }
        pts.push([p.sx, p.sy]); left -= d; cx = p.sx; cy = p.sy; i--;
      }
      return pts;
    }
    function strokePath(list, color, a, w, dash) {
      const P = list.map(id => nodes.get(id)).filter(Boolean); if (P.length < 2) return;
      ctx.beginPath(); ctx.moveTo(P[0].sx, P[0].sy); for (let i = 1; i < P.length; i++) ctx.lineTo(P[i].sx, P[i].sy);
      ctx.strokeStyle = rgba(color, a); ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]);
    }
    function shape(kind, x, y, r) {
      ctx.beginPath();
      if (kind === 'repeater') { ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.1, y); ctx.lineTo(x, y + r * 1.25); ctx.lineTo(x - r * 1.1, y); ctx.closePath(); }
      else if (kind === 'room server') ctx.rect(x - r, y - r, r * 2, r * 2);
      else if (kind === 'sensor') { ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.1, y + r * 0.8); ctx.lineTo(x - r * 1.1, y + r * 0.8); ctx.closePath(); }
      else if (kind === 'me') { for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r); } ctx.closePath(); }
      else ctx.arc(x, y, r, 0, Math.PI * 2);
    }

    function render(now, L) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // frame: corner brackets
      ctx.strokeStyle = 'rgba(0,229,255,.35)'; ctx.lineWidth = 1.5; ctx.beginPath();
      for (const [x, y, sx, sy] of [[8, 8, 1, 1], [W - 8, 8, -1, 1], [8, H - 8, 1, -1], [W - 8, H - 8, -1, -1]]) { ctx.moveTo(x, y + 16 * sy); ctx.lineTo(x, y); ctx.lineTo(x + 16 * sx, y); }
      ctx.stroke();
      const ts = clamp(W / 900, 1, 1.8), px = n => `${(n * ts).toFixed(1)}px`;   // text grows with the canvas (projector, full screen)
      ctx.font = `600 ${px(10)} ${mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (layout === 'auto' && L.cx != null) {
        if (!rings.size && nodes.size > 1) ringTable();
        let ly = 1e9;
        for (const [d, R] of rings) {
          const r = R * scale; if (r > Math.max(W, H)) break;
          ctx.beginPath(); ctx.arc(L.cx, L.cy, r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(0,229,255,.07)'; ctx.lineWidth = 1; ctx.setLineDash([3, 6]); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(0,229,255,.32)'; const y = L.cy - r * 0.77 - 4; if (ly - y < 12) continue; ly = y; ctx.textAlign = 'left'; ctx.fillText(d === Infinity ? 'distance unknown' : d === 1 ? 'heard direct' : d - 1 + (d === 2 ? ' hop' : ' hops'), L.cx + r * 0.64 + 4, y); ctx.textAlign = 'center';
        }
      } else if (layout === 'gps') {
        ctx.fillStyle = 'rgba(5,9,18,.55)'; ctx.fillRect(L.railX, 0, W - L.railX, H);
        ctx.strokeStyle = 'rgba(0,229,255,.18)'; ctx.beginPath(); ctx.moveTo(L.railX + 0.5, 30); ctx.lineTo(L.railX + 0.5, H - 30); ctx.stroke();
        ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(0,229,255,.55)'; ctx.fillText('NO GPS', L.railX + 12, 38);
        if (L.more) { ctx.fillStyle = 'rgba(131,148,184,.8)'; ctx.fillText(`+${L.more} more`, L.railX + 26, H - 22); }
        if (L.geo) {   // scale bar
          const nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]; let km = nice[0];
          for (const v of nice) if (v / L.geo.kmPerPx <= 140) km = v;
          const px = km / L.geo.kmPerPx, x = 22, y = H - 20;
          ctx.strokeStyle = 'rgba(232,241,255,.55)'; ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4); ctx.stroke();
          ctx.fillStyle = 'rgba(232,241,255,.7)'; ctx.fillText(km + ' km', x + px + 8, y - 2);
        } else { ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(131,148,184,.85)'; ctx.fillText('No node has sent a GPS position yet -- adverts with a location appear here', (L.railX) / 2, H / 2); }
        ctx.textAlign = 'center';
      }
      // every link ever used: one faint path; direct 'ahead' only links dashed
      ctx.beginPath(); let dashed = false;
      for (const l of links.values()) { if (!l.solid) { dashed = true; continue; } const p = nodes.get(l.a), q = nodes.get(l.b); if (p && q && !(p.hidden && q.hidden)) { ctx.moveTo(p.sx, p.sy); ctx.lineTo(q.sx, q.sy); } }
      ctx.strokeStyle = 'rgba(110,140,205,.2)'; ctx.lineWidth = 1; ctx.stroke();
      if (dashed) {
        ctx.beginPath(); for (const l of links.values()) if (!l.solid) { const p = nodes.get(l.a), q = nodes.get(l.b); if (p && q) { ctx.moveTo(p.sx, p.sy); ctx.lineTo(q.sx, q.sy); } }
        ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(110,140,205,.16)'; ctx.stroke(); ctx.setLineDash([]);
      }
      if (selNode) for (const l of links.values()) if (l.a === selNode || l.b === selNode) strokePath([l.a, l.b], '#00e5ff', 0.45, 1.6, l.solid ? null : [3, 5]);
      if (selPath) { strokePath(selPath.ids, selPath.color, 0.28, 9); strokePath(selPath.ids, '#ffffff', 0.85, 1.6); if (selPath.ahead.length) strokePath(['me', ...selPath.ahead], selPath.color, 0.7, 1.4, [4, 5]); }

      ctx.globalCompositeOperation = 'lighter';
      for (const l of links.values()) {   // links that carried traffic glow and fade
        const h = glow(now - l.hotT); if (h < 0.03) continue;
        const dash = l.solid ? null : [4, 6];
        strokePath([l.a, l.b], l.color, 0.22 * h, 2 + 7 * h, dash); strokePath([l.a, l.b], l.color, 0.85 * h, 1 + 1.6 * h, dash);
      }
      for (const f of flashes) {   // reduced motion: the whole path lit, stepping down
        const a = STEPS[Math.floor((now - f.t0) / STEP_MS)] || 0;
        if (f.ahead.length) strokePath(['me', ...f.ahead], f.color, 0.6 * a, 1.4, [4, 5]);
      }
      for (const g of ghosts) {   // direct packets: the hops still to go, dashed beyond us
        const a = 1 - (now - g.t0) / 1800; strokePath(['me', ...g.ahead], g.color, 0.7 * a, 1.5, [4, 6]);
      }
      for (const v of nodes.values()) {   // node glows (brighter for a moment when it transmits)
        if (v.hidden || !num(v.sx)) continue;
        const k = kindOf(v.id); if (k === 'unknown' && !v.heard) continue;
        const f = glow(now - v.flashT), base = k === 'me' ? 0.75 : k === 'ph' ? 0.18 : 0.38, s = (k === 'me' ? 46 : 26) + 34 * f;
        ctx.globalAlpha = clamp(base + 0.6 * f, 0, 1); ctx.drawImage(sprite(COL[k] || COL.node), v.sx - s / 2, v.sy - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
      // pulses: head + trail
      for (const p of pulses) {
        const P = p.ids.map(id => nodes.get(id)); if (P.some(x => !x || !num(x.sx))) continue;
        const el = Math.max(0, now - p.t0), seg = Math.max(0, Math.min(P.length - 2, Math.floor(el / p.hop))), frac = P.length < 2 ? 1 : ease(clamp((el - seg * p.hop) / p.hop, 0, 1));
        if (P.length < 2) continue;
        const pts = trailPts(P, seg, frac, 34 + p.r * 9), [hx, hy] = pts[0], [tx, ty] = pts[pts.length - 1];
        const gr = ctx.createLinearGradient(tx, ty, hx, hy); gr.addColorStop(0, rgba(p.color, 0)); gr.addColorStop(1, rgba(p.color, 0.85 * p.bright));
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.strokeStyle = gr; ctx.lineWidth = Math.max(1.2, p.r * 0.8); ctx.stroke();
        const s = p.r * (5 + 3 * p.bright); ctx.globalAlpha = 0.35 + 0.65 * p.bright; ctx.drawImage(sprite(p.color), hx - s / 2, hy - s / 2, s, s); ctx.globalAlpha = 1;
      }
      for (const r of ripples) {   // landing at our node
        const v = nodes.get(r.id); if (!v) continue; const q = clamp((now - r.t0) / r.dur, 0, 1); if (q <= 0) continue;
        ctx.beginPath(); ctx.arc(v.sx, v.sy, 10 + q * r.max, 0, Math.PI * 2); ctx.strokeStyle = rgba(r.color, (1 - q) * 0.8 * r.bright); ctx.lineWidth = 2.2 * (1 - q) + 0.6; ctx.stroke();
      }
      for (const b of bursts) {   // flood: a burst at the origin
        const v = nodes.get(b.id); if (!v || v.hidden) continue; const q = clamp((now - b.t0) / 760, 0, 1), e = 1 - Math.pow(1 - q, 3);
        ctx.beginPath(); ctx.arc(v.sx, v.sy, 6 + e * 34, 0, Math.PI * 2); ctx.strokeStyle = rgba(b.color, 0.7 * (1 - q)); ctx.lineWidth = 1.6; ctx.stroke();
        ctx.beginPath();
        for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 + 0.3, r0 = 8 + e * 26; ctx.moveTo(v.sx + Math.cos(a) * r0, v.sy + Math.sin(a) * r0); ctx.lineTo(v.sx + Math.cos(a) * (r0 + 6), v.sy + Math.sin(a) * (r0 + 6)); }
        ctx.strokeStyle = rgba(b.color, 0.9 * (1 - q)); ctx.lineWidth = 1.4; ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';

      // node bodies + labels
      const many = nodes.size > 28;
      ctx.font = `600 ${px(10.5)} ${mono}`;
      const order = [...nodes.values()].filter(v => v.id !== 'me'); if (nodes.get('me')) order.push(nodes.get('me'));
      const labels = [];
      for (const v of order) {
        if (v.hidden || !num(v.sx)) continue;
        const k = kindOf(v.id); if (k === 'unknown' && !v.heard) continue;
        const col = COL[k] || COL.node, r = (k === 'me' ? 12 : k === 'repeater' ? 6.5 : k === 'ph' ? 4 : 5) * Math.sqrt(ts), f = glow(now - v.flashT);
        shape(k, v.sx, v.sy, r);
        ctx.fillStyle = k === 'ph' || k === 'unknown' ? 'rgba(10,18,38,.9)' : k === 'me' ? '#062033' : rgba(col, 0.35 + 0.5 * f);
        ctx.fill(); ctx.lineWidth = k === 'me' ? 2.4 : 1.5; ctx.strokeStyle = rgba(col, k === 'ph' ? 0.55 + 0.4 * f : 0.95);
        if (k === 'ph' || k === 'unknown') ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]);
        if (k === 'me') { ctx.beginPath(); ctx.arc(v.sx, v.sy, 3.2, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
        if (v.id === selNode || v.id === hover) { shape(k, v.sx, v.sy, r + 5); ctx.strokeStyle = v.id === selNode ? '#ffffff' : 'rgba(0,229,255,.7)'; ctx.lineWidth = 1.4; ctx.stroke(); }
        const showLabel = k === 'me' || k === 'repeater' || !many || v.id === selNode || v.id === hover || v.rail;
        if (showLabel) labels.push({ v, k, r, pri: k === 'me' ? 0 : v.id === selNode ? 1 : v.id === hover ? 2 : k === 'repeater' ? 3 : 4 });
      }
      // labels: most important first, any that would overlap one already drawn is skipped (hover / select shows it)
      labels.sort((p, q) => p.pri - q.pri);
      const boxes = [];
      for (const { v, k, r, pri } of labels) {
        const t = short(nameOf(v.id), v.rail ? 16 : 18), w = ctx.measureText(t).width;
        if (v.rail) { ctx.textAlign = 'left'; ctx.fillStyle = k === 'ph' ? 'rgba(131,148,184,.75)' : 'rgba(232,241,255,.85)'; ctx.fillText(t, v.sx + 10, v.sy + 0.5); ctx.textAlign = 'center'; continue; }
        const y = v.sy + r + 10 * ts, bx = [v.sx - w / 2 - 3, y - 7 * ts, w + 6, 13 * ts];
        if (pri > 2 && boxes.some(o => bx[0] < o[0] + o[2] && o[0] < bx[0] + bx[2] && bx[1] < o[1] + o[3] && o[1] < bx[1] + bx[3])) continue;
        boxes.push(bx); ctx.fillStyle = 'rgba(5,9,18,.72)'; ctx.fillRect(...bx);
        ctx.fillStyle = k === 'me' ? '#00e5ff' : k === 'ph' ? 'rgba(131,148,184,.8)' : 'rgba(232,241,255,.9)'; ctx.fillText(t, v.sx, y);
      }
      // HUD
      const hy = W < 560 ? 62 : 22 * ts;   // a phone: the GPS / spread buttons take the top row
      ctx.textAlign = 'left'; ctx.font = `700 ${px(10.5)} ${disp}`; ctx.fillStyle = 'rgba(0,229,255,.8)';
      let rp = 0; for (const v of nodes.values()) if (kindOf(v.id) === 'repeater') rp++;
      const shown = [...nodes.values()].filter(v => !(v.id === 'unknown' && !v.heard)).length;
      ctx.fillText(`NET  ${shown} NODES · ${rp} RPT · ${pulses.length || flashes.length} IN FLIGHT · ${total} PKTS`, 18, hy);
      if (lastPkt) {
        ctx.font = `600 ${px(11)} ${mono}`; const y = hy + 18 * ts;
        ctx.fillStyle = lastPkt.color; ctx.fillText('●', 18, y);
        ctx.fillStyle = 'rgba(232,241,255,.85)';
        const tm = new Date(lastPkt.at).toTimeString().slice(0, 8);
        ctx.fillText(short(`${tm}  ${lastPkt.label} from ${lastPkt.from} · ${lastPkt.route} · ${lastPkt.hops} hop${lastPkt.hops === 1 ? '' : 's'}${lastPkt.snr != null ? ' · ' + lastPkt.snr.toFixed(1) + ' dB' : ''}${lastPkt.rssi != null ? ' · ' + lastPkt.rssi + ' dBm' : ''}`, Math.max(20, Math.floor((W - (W < 560 ? 40 : 200)) / (6.6 * ts)))), 18 + 14 * ts, y);
      } else {
        const me = nodes.get('me'); ctx.textAlign = 'center'; ctx.font = `600 ${px(12)} ${mono}`; ctx.fillStyle = 'rgba(131,148,184,.85)';
        if (me && num(me.sx)) ctx.fillText('Listening… each packet will fly in along the path it took', me.sx, me.sy + 44);
      }
      ctx.textAlign = 'center';
      advance(now);
    }
    // move time on: pulses hop, land, and spawn ripples / ghosts; spent effects drop out
    function advance(now) {
      const keep = [];
      for (const p of pulses) {
        const segs = p.ids.length - 1, el = Math.max(0, now - p.t0), seg = Math.floor(el / p.hop);
        while (p.step < Math.min(seg, segs)) {   // a hop just finished: that link glows, the next node transmits
          p.step++; heat(p.ids[p.step - 1], p.ids[p.step], p.color, now);
          if (p.step < segs) flashNode(p.ids[p.step], now);
        }
        if (seg >= segs || segs < 1) {
          const last = p.ids[p.ids.length - 1]; flashNode(last, now);
          ripples.push({ id: last, t0: now, dur: 900, max: 40, color: p.color, bright: 0.5 + 0.5 * p.bright }, { id: last, t0: now + 160, dur: 900, max: 26, color: p.color, bright: 0.4 + 0.4 * p.bright });
          if (p.ahead.length) { ghosts.push({ ahead: p.ahead, color: p.color, t0: now }); p.ahead.forEach((id, i) => heat(i ? p.ahead[i - 1] : 'me', id, p.color, now)); }
        } else keep.push(p);
      }
      pulses = keep;
      if (ripples.length > MAX_RIPPLES) ripples.splice(0, ripples.length - MAX_RIPPLES);
      if (ghosts.length > MAX_GHOSTS) ghosts.splice(0, ghosts.length - MAX_GHOSTS);
      ripples = ripples.filter(r => now - r.t0 < r.dur);
      bursts = bursts.filter(b => now - b.t0 < 760);
      ghosts = ghosts.filter(g => now - g.t0 < 1800);
      flashes = flashes.filter(f => now - f.t0 < STEP_MS * STEPS.length);
    }

    // ------------------------------------------------------------ interaction
    function hit(x, y) {
      let best = null, bd = 16;
      for (const v of nodes.values()) {
        if (v.hidden || !num(v.sx) || (v.id === 'unknown' && !v.heard)) continue;
        const d = Math.hypot(v.sx - x, v.sy - y); if (d < bd) { bd = d; best = v.id; }
      }
      return best;
    }
    const at = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    function onClick(e) {
      try {
        const id = hit(...at(e));
        if (!id) { selNode = null; selPath = null; info.hidden = true; kick(); return; }
        selNode = id; selPath = null; showInfo(id); kick();
        c.bus.emit('select', { node: id, from: 'net' });
      } catch (err) { console.warn('Packet Journey net', err); }
    }
    function onMove(e) {
      try { const id = hit(...at(e)); cv.style.cursor = id ? 'pointer' : 'default'; if (id !== hover) { hover = id; kick(); } } catch (err) { /* ignore */ }
    }
    function onLeave() { if (hover) { hover = null; kick(); } }
    function showInfo(id) {
      const v = nodes.get(id), n = id === 'me' ? regGet('me') : regGet(id); if (!v) { info.hidden = true; return; }
      infoAt = Date.now();
      const k = kindOf(id), role = k === 'me' ? 'our node' : k === 'ph' ? (String(id).startsWith('n:') ? 'channel sender (name only)' : 'path hash only -- no advert yet') : k === 'unknown' ? 'sender the packet does not name' : (n && n.role) || 'node';
      const key = n && n.key ? n.key : null, gps = hasGps(n) ? `${n.lat.toFixed(4)}, ${n.lon.toFixed(4)}` : 'no position';
      const dist = v.dist === Infinity ? '?' : v.dist === 0 ? '-' : v.dist === 1 ? 'heard direct' : `${v.dist - 1} hop${v.dist === 2 ? '' : 's'} away`;
      info.innerHTML = `<button class="pj-net-x" title="Close">✕</button>
        <div class="pj-net-ih"><i style="background:${COL[k] || COL.node};box-shadow:0 0 8px ${COL[k] || COL.node}"></i><b>${esc(nameOf(id))}</b></div>
        <dl>
          <dt>Role</dt><dd>${esc(role)}</dd>
          <dt>${key ? 'Key' : 'Id'}</dt><dd class="mono" title="${esc(key || id)}">${esc(short(key || id, 22))}</dd>
          <dt>Hash</dt><dd class="mono">${esc((n && n.hash) || '-')}</dd>
          <dt>Last seen</dt><dd>${esc(n && n.lastSeen ? fmtAgo(n.lastSeen) : 'never')}</dd>
          <dt>Packets</dt><dd>${v.heard}${v.heard ? ` <span class="dim">(${v.sent} sent, ${v.relayed} relayed)</span>` : ''}</dd>
          <dt>Distance</dt><dd>${esc(dist)}</dd>
          <dt>GPS</dt><dd class="mono">${esc(gps)}</dd>
        </dl>`;
      info.hidden = false;
      info.querySelector('.pj-net-x').onclick = () => { info.hidden = true; selNode = null; kick(); };
    }
    function setLayout(l) {
      layout = l === 'gps' ? 'gps' : 'auto';
      try { c.store && c.store.set('pjNetLayout', layout); } catch (e) { /* storage off */ }
      btnLayout.textContent = layout === 'gps' ? '◎ Rings' : '🌐 GPS map';
      btnLayout.title = layout === 'gps' ? 'Lay the nodes out on rings by hop distance from our node' : 'Lay the nodes out by their GPS positions';
      scale = 0; kick();
    }
    function spread() {
      for (const v of nodes.values()) if (v.id !== 'me') v.placed = false;
      alpha = 1; kick();
    }
    btnLayout.onclick = () => setLayout(layout === 'gps' ? 'auto' : 'gps');
    mount.querySelector('[data-act=spread]').onclick = spread;
    cv.addEventListener('click', onClick); cv.addEventListener('pointermove', onMove); cv.addEventListener('pointerleave', onLeave);
    setLayout(layout);

    // ------------------------------------------------------------ bus
    const safe = fn => x => { try { fn(x); } catch (e) { console.warn('Packet Journey net', e); } };
    const offs = [
      c.bus.on('packet', safe(onPacket)),
      c.bus.on('nodes', safe(() => { syncNodes(); if (selNode && !info.hidden) showInfo(selNode); kick(); })),
      c.bus.on('select', safe(s => {
        if (!s || s.from === 'net') return;
        if (s.packet && typeof s.packet === 'object') {
          const p = s.packet; let path = ids(p.journey); if (path[path.length - 1] !== 'me') path.push('me');
          const kind = PAL[p.kind] ? p.kind : 'unknown';
          selPath = { ids: path, ahead: ids(p.ahead).filter(id => id !== 'me'), color: (PAL[kind] && PAL[kind].color) || '#ff3b5c' };
          selNode = null; info.hidden = true;
          for (const id of [...path, ...selPath.ahead]) vnode(id);
          if (visible()) launch({ ids: path, ahead: selPath.ahead, color: selPath.color, kind, flood: false, r: 4, bright: 1 }, T());   // replay it once
        } else if (s.node != null) {
          const id = canon(String(s.node)); selPath = null;
          if (nodes.has(id)) { selNode = id; showInfo(id); } else { selNode = null; info.hidden = true; }
        }
        kick();
      })),
      c.bus.on('reset', safe(() => {
        pulses = []; ripples = []; bursts = []; ghosts = []; flashes = []; links.clear();
        for (const id of [...nodes.keys()]) if (id !== 'me') nodes.delete(id);
        const me = nodes.get('me'); Object.assign(me, { heard: 0, sent: 0, relayed: 0, flashT: -1e9 });
        selNode = selPath = hover = lastPkt = null; total = 0; info.hidden = true; alpha = 0; kick();
      })),
      c.bus.on('visible', safe(v => { if (v) { W = 0; measure(); kick(); } })),
    ];
    let ro = null;
    try { ro = new ResizeObserver(() => { try { measure(); kick(); } catch (e) { /* ignore */ } }); ro.observe(mount); } catch (e) { window.addEventListener('resize', kick); }
    syncNodes(); measure(); kick();

    return {
      destroy() {
        dead = true; gen++;
        offs.forEach(f => { try { f(); } catch (e) { /* ignore */ } });
        try { ro && ro.disconnect(); } catch (e) { /* ignore */ }
        window.removeEventListener('resize', kick);
        mount.innerHTML = ''; mount.classList.remove('pj-net-host');
      },
      _t: { rings: () => rings, alpha: () => alpha, nodes, links, pulses: () => pulses, flashes: () => flashes, ripples: () => ripples, layout: () => layout, setLayout, hit, running: () => running, sel: () => ({ node: selNode, path: selPath }), frame: () => frame(T()) },
    };
  };
})();
