/* Kelly Page -- LoRa Mesh > Packet Journey: repeater reach, link quality and duplicates / mesh saturation
 * (2026-10-24, unreleased). Coded against js/pj-core.js only -- see PACKET_JOURNEY_PLAN.md "Round 2", row Reach.
 *
 * window.KellyPJReach(mount, c) -> { destroy() }      mount = #pj-reach (one column of the .pj-more grid)
 * window.KellyPJReach.createAgg() -> the pure aggregator (module.exports.createAgg in Node, for tests).
 *
 * Three cards:
 *   Repeater reach   flood journeys' middle ids (journey.slice(1, -1)): distinct origins carried, packets, how often the
 *                    LAST hop to us (journey[-2]) and the FIRST hop from the origin (journey[1]), farthest origin in km
 *                    (haversine, both ends need lat/lon in the registry, measured at draw time so late adverts count).
 *   Link quality     TRACE snrs[i] = journey[1+i] heard journey[i]; plus every packet's last hop heardFrom -> 'me' at
 *                    ev.snr. Latest / average / best SNR and samples per directed link, best-measured 40 shown.
 *   Duplicates       flood copies grouped by ev.pkey within 30 s of the first copy: copies per unique flood, now (last
 *                    10 min), a gauge, the 60-minute line and the floods heard most times.
 * Session only (no storage). Two sets like pj-stats: live and demo (ev.demo); the demo set is shown while the shell
 * says demo is on, live otherwise, and a tag says which. Ids are folded with c.reg.canonical() at draw time.
 * Caps: repeaters 300 (origins 300 each), links 300, open pkey groups 2000 (pruned at 30 s), worst list 20, 60 minutes.
 * Redraw <= 1/s and only while c.visible() (at once when it becomes visible); nothing animates.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.KellyPJReach = api.mount; root.KellyPJReach.createAgg = api.createAgg; root.KellyPJReach.haversine = api.haversine; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_RPT = 300, MAX_ORIG = 300, MAX_LINKS = 300, MAX_DUP = 2000, MAX_WORST = 20, WIN = 30000, MINUTES = 60, NOW_MIN = 10;
  const SHOW_RPT = 30, SHOW_LINKS = 40, SHOW_WORST = 8;

  function haversine(a, b) {   // km between two { lat, lon }
    const R = 6371, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ============================================================ pure aggregation (no DOM)
  function createAgg() {
    const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
    const skip = id => !id || typeof id !== 'string' || id === 'me' || id === 'unknown';
    const empty = () => ({ t0: Date.now(), n: 0, lastT: 0, rpt: new Map(), links: new Map(), dup: new Map(), mins: new Map(), worst: [] });

    function evictOldest(map, max) {   // Map entries carry .t (last touched); drop the stalest
      if (map.size <= max) return;
      const v = [...map.entries()].sort((a, b) => a[1].t - b[1].t);
      for (const [k] of v.slice(0, map.size - max)) map.delete(k);
    }
    function link(set, from, to, snr, t) {
      if (snr == null || !from || from === 'unknown' || !to || to === 'unknown' || from === to) return;
      const k = from + '>' + to;
      let L = set.links.get(k);
      if (!L) { L = { from, to, n: 0, sum: 0, best: snr, last: snr, t }; set.links.set(k, L); }
      L.n++; L.sum += snr; if (snr > L.best) L.best = snr;
      if (t >= L.t) { L.last = snr; L.t = t; }
      evictOldest(set.links, MAX_LINKS);
    }
    function bucket(set, t) {
      const m = Math.floor(t / 60000);
      let b = set.mins.get(m); if (!b) { b = { f: 0, c: 0 }; set.mins.set(m, b); }
      for (const k of set.mins.keys()) if (k <= m - MINUTES) set.mins.delete(k);
      return b;
    }
    function retire(set, g) {
      if (g.n < 2) return;
      set.worst.push(g); set.worst.sort((a, b) => b.n - a.n || b.t0 - a.t0);
      if (set.worst.length > MAX_WORST) set.worst.length = MAX_WORST;
    }
    function pruneDup(set, t) {
      for (const [k, g] of set.dup) {   // insertion order = first-copy order
        if (g.t0 >= t - WIN && set.dup.size <= MAX_DUP) break;
        set.dup.delete(k); retire(set, g);
      }
    }

    function add(set, ev) {
      if (!ev || typeof ev !== 'object') return;
      const t = num(ev.t) || Date.now(), J = Array.isArray(ev.journey) ? ev.journey : [], flood = ev.route === 'flood';
      set.n++; if (t > set.lastT) set.lastT = t;
      // ---- repeaters: the middle of a flood journey
      if (flood && J.length >= 3) {
        const origin = J[0], mids = J.slice(1, -1), seen = new Set();
        for (const id of mids) {
          if (skip(id) || seen.has(id)) continue; seen.add(id);
          let r = set.rpt.get(id);
          if (!r) { r = { id, pk: 0, first: 0, last: 0, orig: new Map(), t }; set.rpt.set(id, r); }
          r.pk++; r.t = t;
          if (!skip(origin)) { r.orig.delete(origin); r.orig.set(origin, t); if (r.orig.size > MAX_ORIG) r.orig.delete(r.orig.keys().next().value); }
        }
        const f = set.rpt.get(mids[0]), l = set.rpt.get(mids[mids.length - 1]);
        if (f && !skip(mids[0])) f.first++;
        if (l && !skip(mids[mids.length - 1])) l.last++;
        evictOldest(set.rpt, MAX_RPT);
      }
      // ---- links: a trace's SNR per hop, and the last hop to us on every packet
      if (ev.type === 'TRACE' && Array.isArray(ev.snrs)) {
        for (let i = 0; i < ev.snrs.length && i + 1 < J.length - 1; i++) link(set, J[i], J[i + 1], num(ev.snrs[i]), t);
      }
      const snr = num(ev.snr);
      if (snr != null && !skip(ev.heardFrom)) link(set, ev.heardFrom, 'me', snr, t);
      // ---- duplicates: copies of one flood share a pkey
      if (flood && ev.pkey) {
        const k = String(ev.pkey); let g = set.dup.get(k);
        if (g && t - g.t0 <= WIN) {
          g.n++; g.t = t;
          const b = set.mins.get(Math.floor(g.t0 / 60000)); if (b) b.c++;
        } else {
          if (g) { set.dup.delete(k); retire(set, g); }
          g = { pkey: k, t0: t, t, n: 1, type: ev.typeLabel || ev.type || '?', kind: ev.kind || 'unknown', origin: J[0] || 'unknown',
            name: (ev.src && ev.src.name) || (ev.advert && ev.advert.name) || ev.sender || '' };
          set.dup.set(k, g);
          const b = bucket(set, t); b.f++; b.c++;
        }
        pruneDup(set, t);
      }
    }

    // o = { canon(id), get(id) -> node | null, now }
    function view(set, o = {}) {
      const canon = o.canon || (x => x), get = o.get || (() => null), now = num(o.now) || Date.now();
      const pos = id => { const n = get(id); return n && num(n.lat) != null && num(n.lon) != null && !(n.lat === 0 && n.lon === 0) ? n : null; };
      // repeaters, merged by canonical id
      const R = new Map();
      for (const r of set.rpt.values()) {
        const id = canon(r.id); let m = R.get(id);
        if (!m) { m = { id, pk: 0, first: 0, last: 0, orig: new Set(), t: 0 }; R.set(id, m); }
        m.pk += r.pk; m.first += r.first; m.last += r.last; m.t = Math.max(m.t, r.t);
        for (const x of r.orig.keys()) { const cx = canon(x); if (cx !== id) m.orig.add(cx); }
      }
      const reps = [...R.values()].map(m => {
        const p = pos(m.id); let km = null, far = null;
        if (p) for (const x of m.orig) { const q = pos(x); if (!q) continue; const d = haversine(p, q); if (km == null || d > km) { km = d; far = x; } }
        return { id: m.id, origins: m.orig.size, pk: m.pk, first: m.first, last: m.last, km, far, t: m.t };
      }).sort((a, b) => b.origins - a.origins || b.pk - a.pk || b.t - a.t);
      // links, merged by canonical pair
      const Lm = new Map();
      for (const L of set.links.values()) {
        const from = canon(L.from), to = canon(L.to); if (from === to) continue;
        const k = from + '>' + to; let m = Lm.get(k);
        if (!m) { m = { from, to, n: 0, sum: 0, best: L.best, last: L.last, t: L.t }; Lm.set(k, m); }
        else { if (L.best > m.best) m.best = L.best; if (L.t > m.t) { m.t = L.t; m.last = L.last; } }
        m.n += L.n; m.sum += L.sum;
      }
      const links = [...Lm.values()].map(m => ({ from: m.from, to: m.to, n: m.n, avg: m.sum / m.n, best: m.best, last: m.last, t: m.t }))
        .sort((a, b) => b.n - a.n || b.t - a.t);
      // duplicates
      const nm = Math.floor(now / 60000), series = [];
      let f10 = 0, c10 = 0, fAll = 0, cAll = 0;
      for (let i = MINUTES - 1; i >= 0; i--) {
        const b = set.mins.get(nm - i);
        series.push(b && b.f ? b.c / b.f : null);
        if (b) { fAll += b.f; cAll += b.c; if (i < NOW_MIN) { f10 += b.f; c10 += b.c; } }
      }
      const worstAll = set.worst.concat([...set.dup.values()].filter(g => g.n >= 2)).filter(g => g.t0 >= now - MINUTES * 60000)
        .sort((a, b) => b.n - a.n || b.t0 - a.t0).slice(0, SHOW_WORST)
        .map(g => ({ pkey: g.pkey, n: g.n, t0: g.t0, type: g.type, kind: g.kind, origin: canon(g.origin), name: g.name }));
      return { n: set.n, lastT: set.lastT, reps, links, ratio: f10 ? c10 / f10 : null, floods10: f10, copies10: c10,
        floodsHr: fAll, copiesHr: cAll, series, worst: worstAll };
    }
    return { empty, add, view };
  }

  // ============================================================ the view
  function mount(mountEl, c) {
    const A = createAgg(), PAL = (c.PJ && c.PJ.PALETTE) || {};
    const esc = c.esc || (s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
    const fmtAgo = c.fmtAgo || (t => Math.round((Date.now() - t) / 1000) + 's ago');
    const canon = id => { try { return c.reg && c.reg.canonical ? c.reg.canonical(id) : id; } catch { return id; } };
    const nodeOf = id => { try { return c.reg && c.reg.get ? c.reg.get(id) : null; } catch { return null; } };
    let live = A.empty(), demo = A.empty(), showDemo = false, sel = null;
    const cur = () => showDemo ? demo : live;

    mountEl.innerHTML = `<div class="pj-reach">
      <div class="card pj-reach-card"><div class="card-h"><h2>📡 Repeater reach</h2><span class="tag" data-r="set">live</span><span class="tag" data-r="rcount">0</span></div>
        <p class="dim small pj-reach-note">Repeaters that carried flood packets to us: how many different stations each one brought in, and how far away the farthest was.</p>
        <div class="pj-reach-tbl"><table><thead><tr><th>#</th><th>Repeater</th><th title="Different stations whose floods it carried">Origins</th><th title="Flood packets it appeared in">Pkts</th>
          <th title="Times it was the last hop before us">Last hop</th><th title="Times it was the first repeater after the origin">1st hop</th><th title="Farthest origin it carried (both need GPS)">Farthest</th><th>Reach</th></tr></thead>
          <tbody data-r="reps"></tbody></table></div></div>
      <div class="card pj-reach-card"><div class="card-h"><h2>📶 Link quality</h2><span class="tag" data-r="lcount">0</span></div>
        <p class="dim small pj-reach-note">SNR on each radio hop: from trace packets (each repeater adds the SNR it heard), plus how our node heard every last hop. Green is a solid link, red is marginal.</p>
        <div class="pj-reach-tbl"><table><thead><tr><th>From</th><th></th><th>To</th><th>Latest</th><th>Avg</th><th>Best</th><th title="Measurements">N</th><th>Quality</th></tr></thead>
          <tbody data-r="links"></tbody></table></div></div>
      <div class="card pj-reach-card"><div class="card-h"><h2>🌊 Duplicates / mesh saturation</h2><span class="tag" data-r="dtag">last 10 min</span></div>
        <div class="pj-reach-dup">
          <div class="pj-reach-gauge"><canvas data-c="gauge"></canvas></div>
          <div class="pj-reach-dtext"><b class="pj-reach-big" data-r="ratio">–</b><span class="pj-reach-unit">copies per flood</span>
            <small class="dim" data-r="dsub"></small>
            <p class="small pj-reach-explain">A high number means many repeaters are re-sending the same flood packet, so the channel is busier and new packets are more likely to collide.</p></div>
        </div>
        <canvas data-c="line"></canvas>
        <h3 class="pj-reach-h3">Floods heard most times <span class="dim">(last 60 min)</span></h3>
        <ul class="pj-reach-worst" data-r="worst"></ul></div>
    </div>`;
    const R = n => mountEl.querySelector(`[data-r="${n}"]`), CV = n => mountEl.querySelector(`[data-c="${n}"]`);

    // ---------------------------------------------------------- helpers
    const short = id => !id ? '?' : id === 'me' ? 'My node' : id === 'unknown' ? 'Unknown' : id.startsWith('h:') ? id.slice(2) + '…' : id.startsWith('n:') ? id.slice(2) : id.slice(0, 8) + '…';
    const nameOf = (id, fb) => { const n = nodeOf(id); return (n && n.name) || fb || short(id); };
    const f1 = x => x == null || !isFinite(x) ? '–' : (Math.round(x * 10) / 10).toString();
    const snrHue = s => Math.round(130 * Math.max(0, Math.min(1, (s + 15) / 25)));   // -15 dB red .. +10 dB green
    const snrCell = s => s == null ? '<td>–</td>' : `<td style="color:hsl(${snrHue(s)} 100% 60%)">${esc(f1(s))}</td>`;
    const css = n => { try { return getComputedStyle(mountEl).getPropertyValue(n).trim(); } catch { return ''; } };
    function canvas(cv, h) {
      const w = Math.max(10, cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 300), dpr = Math.min(3, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); return { g, w, h };
    }
    const ratioCol = r => r == null ? (css('--dim') || '#8394b8') : r < 1.8 ? (css('--lime') || '#39ff88') : r < 3 ? (css('--amber') || '#ffb020') : (css('--red') || '#ff3b5c');

    // ---------------------------------------------------------- draw
    function draw() {
      const V = A.view(cur(), { canon, get: nodeOf, now: Date.now() });
      const st = R('set'); st.textContent = showDemo ? 'demo' : 'live'; st.className = 'tag ' + (showDemo ? 'warn' : 'ok');
      drawReps(V); drawLinks(V); drawDup(V);
    }
    function drawReps(V) {
      R('rcount').textContent = V.reps.length + ' repeaters';
      const max = Math.max(1, ...V.reps.map(r => r.origins)), sc = sel && canon(sel);
      R('reps').innerHTML = V.reps.slice(0, SHOW_RPT).map((r, i) => `<tr data-id="${esc(r.id)}" class="${r.id === sc ? 'pj-reach-sel' : ''}">
        <td class="pj-reach-rk">${i + 1}</td><td class="pj-reach-nm"><span>${esc(nameOf(r.id))}</span></td>
        <td class="pj-reach-n">${r.origins}</td><td>${r.pk.toLocaleString()}</td><td>${r.last.toLocaleString()}</td><td>${r.first.toLocaleString()}</td>
        <td title="${r.far ? esc(nameOf(r.far)) : 'needs GPS on both ends'}">${r.km == null ? '–' : esc(r.km < 10 ? r.km.toFixed(1) : Math.round(r.km).toString()) + ' km'}</td>
        <td><div class="pj-reach-bar"><i style="width:${(100 * r.origins / max).toFixed(1)}%"></i></div></td></tr>`).join('')
        || '<tr><td colspan="8" class="pj-reach-empty">No repeated flood packets yet -- repeaters show up here once floods arrive through them.</td></tr>';
    }
    function drawLinks(V) {
      const L = V.links.slice(0, SHOW_LINKS), sc = sel && canon(sel);
      R('lcount').textContent = V.links.length > SHOW_LINKS ? `top ${SHOW_LINKS} of ${V.links.length}` : V.links.length + ' links';
      R('links').innerHTML = L.map(l => {
        const q = Math.max(0, Math.min(1, (l.avg + 15) / 25));
        return `<tr data-id="${esc(l.from)}" data-to="${esc(l.to)}" class="${sc && (l.from === sc || l.to === sc) ? 'pj-reach-sel' : ''}" title="last ${esc(fmtAgo(l.t))}">
          <td class="pj-reach-nm"><span>${esc(nameOf(l.from))}</span></td><td class="pj-reach-arr">→</td><td class="pj-reach-nm"><span>${esc(nameOf(l.to))}</span></td>
          ${snrCell(l.last)}${snrCell(l.avg)}${snrCell(l.best)}<td>${l.n}</td>
          <td><div class="pj-reach-bar pj-reach-q"><i style="width:${(100 * q).toFixed(0)}%;background:hsl(${snrHue(l.avg)} 100% 55%)"></i></div></td></tr>`;
      }).join('') || '<tr><td colspan="8" class="pj-reach-empty">No SNR reports yet -- each packet heard adds its last hop; trace packets add every hop.</td></tr>';
    }
    function drawDup(V) {
      const r = V.ratio, col = ratioCol(r);
      const big = R('ratio'); big.textContent = r == null ? '–' : r.toFixed(2) + '×'; big.style.color = col;
      R('dsub').textContent = V.floods10 ? `${V.copies10.toLocaleString()} copies of ${V.floods10.toLocaleString()} floods in 10 min · ${V.floodsHr.toLocaleString()} floods in the hour` : 'no flood packets in the last 10 min';
      // gauge: 1x .. 5x on a half circle
      const { g, w, h } = canvas(CV('gauge'), 96), cx = Math.min(w, 180) / 2, cy = h - 10, rad = Math.min(cx, h - 14) - 8;
      g.lineWidth = 14; g.lineCap = 'round';
      g.strokeStyle = 'rgba(131,148,184,.22)'; g.beginPath(); g.arc(cx, cy, rad, Math.PI, 2 * Math.PI); g.stroke();
      if (r != null) {
        const p = Math.max(0, Math.min(1, (r - 1) / 4));
        g.strokeStyle = col; g.shadowColor = col; g.shadowBlur = 10; g.beginPath(); g.arc(cx, cy, rad, Math.PI, Math.PI + Math.max(0.02, p) * Math.PI); g.stroke(); g.shadowBlur = 0;
      }
      g.font = `600 10px ${css('--mono') || 'monospace'}`; g.fillStyle = css('--dim') || '#8394b8'; g.textBaseline = 'alphabetic';
      g.textAlign = 'left'; g.fillText('1×', cx - rad - 7, h - 1); g.textAlign = 'right'; g.fillText('5×', cx + rad + 7, h - 1);
      // 60-minute line
      const L = canvas(CV('line'), 120), padL = 30, padB = 18, padT = 8, cw = L.w - padL - 6, ch = L.h - padB - padT, gg = L.g;
      const vals = V.series.filter(x => x != null), top = Math.max(2, Math.ceil(Math.max(1, ...vals)));
      const mono = css('--mono') || 'monospace', dim = css('--dim') || '#8394b8';
      gg.strokeStyle = 'rgba(131,148,184,.15)'; gg.lineWidth = 1; gg.font = `600 10px ${mono}`; gg.fillStyle = dim; gg.textAlign = 'right'; gg.textBaseline = 'middle';
      for (let v = 1; v <= top; v += top > 6 ? 2 : 1) { const y = padT + ch - ch * (v - 1) / (top - 1); gg.beginPath(); gg.moveTo(padL, y + .5); gg.lineTo(L.w - 6, y + .5); gg.stroke(); gg.fillText(v + '×', padL - 4, y); }
      const X = i => padL + cw * i / (V.series.length - 1), Y = v => padT + ch - ch * (v - 1) / (top - 1);
      const lc = css('--cyan') || '#00e5ff';
      gg.strokeStyle = lc; gg.fillStyle = lc; gg.lineWidth = 2; gg.shadowColor = lc; gg.shadowBlur = 6; gg.beginPath();
      let on = false;
      V.series.forEach((v, i) => { if (v == null) { on = false; return; } if (on) gg.lineTo(X(i), Y(v)); else { gg.moveTo(X(i), Y(v)); on = true; } });
      gg.stroke(); gg.shadowBlur = 0;
      V.series.forEach((v, i) => { if (v != null) { gg.beginPath(); gg.arc(X(i), Y(v), 2, 0, Math.PI * 2); gg.fill(); } });
      gg.fillStyle = dim; gg.textBaseline = 'alphabetic'; gg.textAlign = 'left'; gg.fillText('-60m', padL, L.h - 4);
      gg.textAlign = 'center'; gg.fillText('-30m', padL + cw / 2, L.h - 4); gg.textAlign = 'right'; gg.fillText('now', L.w - 6, L.h - 4);
      if (!vals.length) { gg.textAlign = 'center'; gg.textBaseline = 'middle'; gg.fillText('copies per flood, per minute', padL + cw / 2, padT + ch / 2); }
      // worst offenders
      R('worst').innerHTML = V.worst.map(x => {
        const c0 = (PAL[x.kind] && PAL[x.kind].color) || '#8394b8', who = x.origin && x.origin !== 'unknown' ? nameOf(x.origin, x.name) : (x.name || 'unknown sender');
        return `<li${x.origin && x.origin !== 'unknown' ? ` data-id="${esc(x.origin)}"` : ''}><b style="color:${ratioCol(x.n)}">${x.n}×</b>
          <i style="background:${c0}"></i><span>${esc(x.type)}</span><em>${esc(who)}</em><time>${esc(fmtAgo(x.t0))}</time></li>`;
      }).join('') || '<li class="pj-reach-empty">No flood heard more than once yet.</li>';
    }

    // ---------------------------------------------------------- scheduling (<= 1/s, visible only, no idle loop)
    let timer = 0, idleT = 0, lastDraw = 0, lastW = 0;
    function want() { if (!c.visible() || timer) return; timer = setTimeout(drawNow, Math.max(0, 1000 - (Date.now() - lastDraw))); }
    function drawNow() {
      clearTimeout(timer); timer = 0; clearTimeout(idleT); idleT = 0;
      if (!c.visible()) return;
      lastDraw = Date.now();
      try { draw(); } catch (e) { console.warn('pj-reach draw', e); }
      // the 10-minute window and the line slide on while there was recent traffic; stops once quiet
      const lt = cur().lastT; if (lt && lt > Date.now() - 11 * 60000) idleT = setTimeout(want, 15000);
    }

    // ---------------------------------------------------------- bus + DOM events
    const safe = fn => x => { try { fn(x); } catch (e) { console.warn('pj-reach', e); } };
    const mark = () => { const sc = sel && canon(sel);
      for (const tr of mountEl.querySelectorAll('tbody tr[data-id]')) tr.classList.toggle('pj-reach-sel', !!sc && (tr.dataset.id === sc || tr.dataset.to === sc)); };
    const offs = [
      c.bus.on('packet', safe(ev => { if (!ev) return; const set = ev.demo ? demo : live; A.add(set, ev); if (set === cur()) want(); })),
      c.bus.on('nodes', safe(() => want())),
      c.bus.on('select', safe(x => {
        if (!x || x.from === 'reach') return;
        sel = x.node || (x.packet && x.packet.src && x.packet.src.id) || null; mark();
      })),
      c.bus.on('visible', safe(v => { if (v) drawNow(); else { clearTimeout(timer); timer = 0; clearTimeout(idleT); idleT = 0; } })),
      c.bus.on('reset', safe(() => { live = A.empty(); demo = A.empty(); sel = null; if (c.visible()) drawNow(); })),
      c.bus.on('demo', safe(on => { on = !!on; if (on === showDemo) return; showDemo = on; if (c.visible()) drawNow(); })),
    ];
    const onClick = e => {
      const el = e.target.closest && e.target.closest('[data-id]'); if (!el || !mountEl.contains(el)) return;
      sel = el.dataset.id; mark();
      c.bus.emit('select', { node: sel, from: 'reach' });
    };
    mountEl.addEventListener('click', onClick);
    let ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { const w = mountEl.clientWidth; if (w !== lastW) { lastW = w; want(); } }); ro.observe(mountEl); }
    if (c.visible()) drawNow();

    return {
      destroy() {
        for (const off of offs) try { off(); } catch { /* gone */ }
        clearTimeout(timer); clearTimeout(idleT);
        mountEl.removeEventListener('click', onClick); if (ro) ro.disconnect();
        mountEl.innerHTML = '';
      },
      _view: () => A.view(cur(), { canon, get: nodeOf, now: Date.now() }), _sets: () => ({ live, demo, showDemo }),   // tests
    };
  }

  return { mount, createAgg, haversine };
});
