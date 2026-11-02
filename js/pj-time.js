/* Kelly Page -- LoRa Mesh > Packet Journey: busiest time of day + new vs returning stations (2026-10-24, unreleased).
 * Coded against js/pj-core.js only -- see PACKET_JOURNEY_PLAN.md "Round 2", row "Time".
 *
 * window.KellyPJTime(mount, c) -> { destroy() }      mount = #pj-time (half width in .pj-more, full width on a phone)
 * window.KellyPJTime.createAgg(KINDS) -> the pure aggregator (module.exports.createAgg in Node, for tests).
 *
 * Card 1: a 7 x 24 heatmap (Mon..Sun x hour 0..23, local time) of packets heard, all / chat / adverts; hover or tap a
 *   cell for its count and top kind; the current hour is outlined; a line names the busiest hour.
 * Card 2: per day, last 14 days, distinct origin stations (ev.src.id, folded with c.reg.canonical) heard for the first
 *   time ever that day (new) vs heard before (returning). "Ever" = since this page started keeping it: a known list
 *   of station-id hashes (FNV-1a, 8 hex) with first / last day, capped at MAX_KNOWN (least recently heard go).
 *
 * Two sets like pj-stats: live (store('pjTime'), versioned, debounced 15 s + on hide, < SAVE_CAP bytes) and demo
 * (ev.demo, session only; on first show it is seeded with a made-up fortnight so the heatmap has a shape). The demo set
 * is shown while the shell's 'demo' is on. Redraw <= 1/s, only while c.visible(); nothing animates.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.KellyPJTime = api.mount; Object.assign(root.KellyPJTime, { createAgg: api.createAgg, dayNum: api.dayNum, hourRange: api.hourRange, MAX_KNOWN: api.MAX_KNOWN, SAVE_CAP: api.SAVE_CAP }); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1, DAYS = 14, MAX_KNOWN = 2000, MAX_TODAY = 600, SAVE_CAP = 60000;
  const WD = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const WD3 = WD.map(d => d.slice(0, 3));

  // local calendar helpers. dayNum = days since 1970 of the LOCAL date (DST-proof: built from y/m/d via UTC)
  const dayNum = t => { const d = new Date(t); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); };
  const rowOf = t => (new Date(t).getDay() + 6) % 7;   // Monday = 0
  const hourOf = t => new Date(t).getHours();
  const dayDate = dn => new Date(dn * 864e5);          // read with getUTC*
  function fnv(s) {
    let h = 0x811c9dc5; s = String(s);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  const h12 = h => { h = ((h % 24) + 24) % 24; return { n: h % 12 || 12, s: h < 12 ? 'am' : 'pm' }; };
  function hourRange(h) {
    const a = h12(h), b = h12(h + 1);
    return a.s === b.s ? `${a.n}-${b.n} ${b.s}` : `${a.n} ${a.s}-${b.n} ${b.s}`;
  }
  function guess(row, h) {
    if (h >= 18 && h <= 21) return row >= 5 ? 'weekend net night?' : 'net night?';
    if (h >= 6 && h <= 8 && row < 5) return 'morning commute?';
    if (h >= 16 && h <= 17 && row < 5) return 'drive home?';
    if (h >= 0 && h <= 4) return 'night owls?';
    if (h >= 9 && h <= 15 && row >= 5) return 'weekend portable ops?';
    return '';
  }

  // ============================================================ pure aggregation (no DOM)
  function createAgg(KINDS) {
    const NK = KINDS.length;
    const kidx = k => { const i = KINDS.indexOf(k); return i < 0 ? NK - 1 : i; };
    const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
    const skip = id => !id || typeof id !== 'string' || id === 'me' || id === 'unknown';

    function empty(now) {
      // heat: 7 x 24 x NK counts, flat (row * 24 + hour) * NK + kind. known: hash -> [firstDay, lastDay].
      // today: the day tlist belongs to; tlist: distinct station hashes heard today; days: older days frozen as [new, returning]
      return { t0: now || Date.now(), total: 0, heat: new Array(168 * NK).fill(0), known: {}, today: 0, tlist: [], days: {}, raw: {} };
    }

    // close today's list into frozen counts once the date moves on
    function rollover(set, dn) {
      if (set.today === dn) return;
      if (set.today && set.tlist.length) {
        let n = 0, r = 0;
        for (const h of set.tlist) { const k = set.known[h]; if (k && k[0] >= set.today) n++; else r++; }
        set.days[set.today] = [n, r];
      }
      set.today = dn; set.tlist = []; set.raw = {};
      for (const d of Object.keys(set.days)) if (+d <= dn - DAYS) delete set.days[d];
    }
    function evictKnown(set, max) {
      const ids = Object.keys(set.known); if (ids.length <= max) return;
      const keep = new Set(set.tlist);
      ids.sort((a, b) => set.known[a][1] - set.known[b][1] || set.known[a][0] - set.known[b][0]);
      let over = ids.length - max;
      for (const h of ids) { if (over <= 0) break; if (keep.has(h)) continue; delete set.known[h]; over--; }
    }

    function add(set, ev, canon) {
      if (!ev) return;
      const t = num(ev.t) || Date.now(), dn = dayNum(t);
      set.total++;
      set.heat[(rowOf(t) * 24 + hourOf(t)) * NK + kidx(ev.kind)]++;
      const id0 = ev.src && ev.src.id;
      if (skip(id0)) return;
      if (dn < set.today) return;   // a late capture from an earlier day: counted in the heatmap only
      rollover(set, dn);
      let id = id0; try { id = (canon && canon(id0)) || id0; } catch { /* registry gone */ }
      const h = fnv(id), h0 = fnv(id0);
      let k = set.known[h];
      if (!k) k = set.known[h] = [dn, dn];
      if (h0 !== h && set.known[h0]) k[0] = Math.min(k[0], set.known[h0][0]);   // a placeholder this key explains
      k[1] = dn;
      if (!set.raw[h]) set.raw[h] = id;   // session only: lets view() re-fold today's ids after the registry learns more
      if (!set.tlist.includes(h) && set.tlist.length < MAX_TODAY) set.tlist.push(h);
      evictKnown(set, MAX_KNOWN);
    }

    // filter: 'all' | a kind name ('chat', 'advert', ...)
    function view(set, canon, now, filter) {
      now = now || Date.now();
      const fk = filter && filter !== 'all' ? KINDS.indexOf(filter) : -1;
      const cells = []; let max = 0, sum = 0, best = -1;
      for (let i = 0; i < 168; i++) {
        let n = 0, top = -1, tn = 0;
        for (let k = 0; k < NK; k++) { const v = set.heat[i * NK + k] || 0; if (v > tn) { tn = v; top = k; } }
        if (fk >= 0) n = set.heat[i * NK + fk] || 0; else for (let k = 0; k < NK; k++) n += set.heat[i * NK + k] || 0;
        cells.push({ n, top: top >= 0 ? KINDS[top] : null, topN: tn });
        sum += n; if (n > max) { max = n; best = i; }
      }
      const busiest = sum >= 10 && best >= 0 ? { row: Math.floor(best / 24), hour: best % 24, n: max, label: `${WD[Math.floor(best / 24)]} ${hourRange(best % 24)}`, guess: guess(Math.floor(best / 24), best % 24) } : null;

      // today, re-folded: two of today's ids that are now one node count once; its first day is the earliest of them
      const dn = dayNum(now);
      let tn = 0, tr = 0;
      if (set.today === dn) {
        const groups = new Map();
        for (const h of set.tlist) {
          let g = h; const raw = set.raw && set.raw[h];
          if (raw && canon) { try { const cid = canon(raw); if (cid && cid !== raw) g = fnv(cid); } catch { /* ignore */ } }
          const f = set.known[h] ? set.known[h][0] : dn, o = groups.get(g);
          groups.set(g, o == null ? f : Math.min(o, f));
        }
        for (const f of groups.values()) if (f >= dn) tn++; else tr++;
      } else if (set.today && set.today > dn - DAYS && set.tlist.length) {
        // the date moved on with no packet since: the old list is a past day now
        let n = 0, r = 0; for (const h of set.tlist) { const k = set.known[h]; if (k && k[0] >= set.today) n++; else r++; }
        set = Object.assign({}, set, { days: Object.assign({}, set.days, { [set.today]: [n, r] }) });
      }
      const days = [];
      for (let i = DAYS - 1; i >= 0; i--) {
        const d = dn - i, dt = dayDate(d), v = i === 0 ? [tn, tr] : (set.days[d] || [0, 0]);
        days.push({ dn: d, label: WD3[(dt.getUTCDay() + 6) % 7].slice(0, 2) + ' ' + dt.getUTCDate(), wd: WD3[(dt.getUTCDay() + 6) % 7], date: dt.getUTCDate(), n: v[0], r: v[1], today: i === 0 });
      }
      return { t0: set.t0, total: set.total, sum, cells, max, busiest, now: rowOf(now) * 24 + hourOf(now), days, today: { n: tn, r: tr }, known: Object.keys(set.known).length };
    }

    // the saved copy: everything but the session-only raw map; trimmed until its JSON fits SAVE_CAP
    function compact(set, canon) {
      const o = { t0: set.t0, total: set.total, heat: set.heat.slice(), known: {}, today: set.today, tlist: [], days: Object.assign({}, set.days) };
      for (const [h, v] of Object.entries(set.known)) o.known[h] = v.slice();
      // fold today's placeholders the registry has since explained into their key (the raw map doesn't survive a reload)
      for (const h of set.tlist) {
        let g = h; const raw = set.raw && set.raw[h];
        if (raw && canon) { try { const cid = canon(raw); if (cid && cid !== raw) g = fnv(cid); } catch { /* ignore */ } }
        if (g !== h && o.known[h]) {
          const k = o.known[g] || (o.known[g] = o.known[h].slice());
          k[0] = Math.min(k[0], o.known[h][0]); k[1] = Math.max(k[1], o.known[h][1]); delete o.known[h];
        }
        if (!o.tlist.includes(g)) o.tlist.push(g);
      }
      let s = JSON.stringify(o), max = Object.keys(o.known).length;
      while (s.length > SAVE_CAP && max > 50) { max = Math.floor(max * 0.8); evictKnown(o, max); s = JSON.stringify(o); }
      return o;
    }
    function restore(o) {
      if (!o || typeof o !== 'object' || !Array.isArray(o.heat) || o.heat.length !== 168 * NK) return null;
      const s = empty(num(o.t0) || Date.now());
      s.total = num(o.total) || 0;
      s.heat = o.heat.map(x => num(x) || 0);
      if (o.known && typeof o.known === 'object') for (const [h, v] of Object.entries(o.known)) if (Array.isArray(v) && num(v[0]) != null && num(v[1]) != null) s.known[h] = [v[0], v[1]];
      s.today = num(o.today) || 0;
      s.tlist = Array.isArray(o.tlist) ? o.tlist.filter(h => typeof h === 'string').slice(0, MAX_TODAY) : [];
      if (o.days && typeof o.days === 'object') for (const [d, v] of Object.entries(o.days)) if (Array.isArray(v)) s.days[d] = [num(v[0]) || 0, num(v[1]) || 0];
      evictKnown(s, MAX_KNOWN);
      return s;
    }

    // a made-up fortnight for the demo set: evening peaks, a Sunday 7 pm net, quiet small hours; new stations tail off
    function seedDemo(set, now, seed) {
      let x = (seed >>> 0) || 0x5eed;
      const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
      const mix = { advert: .3, chat: .22, dm: .1, ack: .14, path: .1, req: .1, unknown: .04 };
      for (let row = 0; row < 7; row++) for (let h = 0; h < 24; h++) {
        let rate = 3 + 10 * Math.exp(-((h - 19.5) ** 2) / 6) + 5 * Math.exp(-((h - 7.5) ** 2) / 2) * (row < 5 ? 1 : .3) + (row >= 5 && h >= 9 && h <= 16 ? 5 : 0);
        if (h <= 4) rate *= .25;
        if (row === 6 && h === 19) rate += 28;   // the net
        rate = rate * 2 * (0.8 + rnd() * 0.4);   // two weeks of it
        for (const k of KINDS) { const ki = KINDS.indexOf(k); set.heat[(row * 24 + h) * NK + ki] += Math.round(rate * (mix[k] || 0.05) * (k === 'chat' && row === 6 && h === 19 ? 3 : 1)); }
      }
      set.total = set.heat.reduce((a, b) => a + b, 0);
      const dn = dayNum(now);
      for (let i = DAYS - 1; i >= 1; i--) {
        const d = dn - i, fresh = Math.max(0, Math.round((i > 10 ? 9 : 3) * rnd() + (i > 12 ? 6 : 0))), back = Math.round(6 + 10 * rnd() + (rowOf(d * 864e5 + 43200e3) === 6 ? 8 : 0));
        set.days[d] = [fresh, i === DAYS - 1 ? 0 : back];
        for (let j = 0; j < fresh + back; j++) { const h = fnv('demo:' + d + ':' + j); set.known[h] = [d, d]; }
      }
      set.t0 = (dn - DAYS + 1) * 864e5;
      return set;
    }

    return { empty, add, view, compact, restore, seedDemo, rollover };
  }

  // ============================================================ the view
  // the neon scale: deep navy -> teal -> cyan -> lime -> pale yellow, by sqrt(n / max)
  const STOPS = [[11, 21, 48], [6, 78, 110], [0, 229, 255], [57, 255, 136], [255, 251, 138]];
  function heatColour(f) {
    if (!(f > 0)) return '';
    f = Math.min(1, Math.sqrt(f)) * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(f)), p = f - i, a = STOPS[i], b = STOPS[i + 1];
    return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * p)).join(',')})`;
  }

  function mount(mountEl, c) {
    const PJ = c.PJ, KINDS = PJ.KINDS, PAL = PJ.PALETTE, A = createAgg(KINDS);
    const canon = id => (c.reg && c.reg.canonical ? c.reg.canonical(id) : id);
    const esc = c.esc || (s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));

    let live = A.empty(), demo = null, showDemo = false, filter = 'all', pick = -1;
    try { const o = c.store && c.store.get('pjTime', null); if (o && o.v === VERSION) live = A.restore(o.live) || live; } catch (e) { console.warn('pj-time restore', e); }
    const demoSet = () => demo || (demo = A.seedDemo(A.empty(), Date.now(), 24102026));
    const cur = () => showDemo ? demoSet() : live;

    // ---------------------------------------------------------- skeleton
    const FILTERS = [['all', 'All'], ['chat', 'Chat'], ['advert', 'Adverts']];
    let grid = '<div class="pj-time-corner"></div>';
    for (let h = 0; h < 24; h++) grid += `<div class="pj-time-hl" data-h="${h}">${h % 3 === 0 ? h : ''}</div>`;
    for (let r = 0; r < 7; r++) {
      grid += `<div class="pj-time-wl" data-w="${r}">${WD3[r]}</div>`;
      for (let h = 0; h < 24; h++) grid += `<button type="button" class="pj-time-cell" data-i="${r * 24 + h}" aria-label="${WD[r]} ${hourRange(h)}"></button>`;
    }
    mountEl.innerHTML = `<div class="pj-time">
      <div class="card pj-time-heat"><div class="card-h"><h2>🕖 Busiest time of day</h2><span class="tag" data-r="set">live</span></div>
        <div class="pj-time-bar"><div class="pj-time-seg" role="group" aria-label="Which packets">${FILTERS.map(([k, l]) => `<button type="button" class="pj-time-f" data-f="${k}">${l}</button>`).join('')}</div>
          <span class="pj-time-since" data-r="since"></span></div>
        <div class="pj-time-scroll"><div class="pj-time-grid">${grid}</div></div>
        <div class="pj-time-scale"><span>0</span><i class="pj-time-ramp"></i><span data-r="max">0</span><span class="pj-time-scale-l">packets / hour slot, local time</span></div>
        <p class="pj-time-pick" data-r="pick">Hover or tap a square for its count.</p>
        <p class="pj-time-busy" data-r="busy"></p></div>
      <div class="card pj-time-new"><div class="card-h"><h2>🆕 New vs returning stations</h2><span class="tag" data-r="kn">0 known</span></div>
        <div class="pj-time-big">
          <div class="pj-time-bn pj-time-b-new"><b data-r="tn">0</b><span>new today</span></div>
          <div class="pj-time-bn pj-time-b-ret"><b data-r="tr">0</b><span>returning today</span></div>
        </div>
        <div class="pj-time-bars" data-r="bars"></div>
        <div class="pj-time-leg"><span class="pj-time-l-new">■ new (first heard ever)</span><span class="pj-time-l-ret">■ returning</span><span class="dim" data-r="ever"></span></div></div>
    </div>`;
    const R = n => mountEl.querySelector(`[data-r="${n}"]`);
    const cellEls = [...mountEl.querySelectorAll('.pj-time-cell')];
    let V = null;

    function cellText(i) {
      if (!V || i < 0) return 'Hover or tap a square for its count.';
      const x = V.cells[i], what = filter === 'all' ? 'packets' : filter === 'chat' ? 'chat packets' : 'adverts';
      const top = x.top && x.topN ? ` · mostly ${(PAL[x.top] && PAL[x.top].label) || x.top} (${x.topN.toLocaleString()})` : '';
      return `${WD[Math.floor(i / 24)]} ${hourRange(i % 24)}: ${x.n.toLocaleString()} ${what}${filter === 'all' ? top : ''}`;
    }

    // ---------------------------------------------------------- draw
    function draw() {
      V = A.view(cur(), canon, Date.now(), filter);
      const tag = R('set'); tag.textContent = showDemo ? 'demo' : 'live'; tag.className = 'tag ' + (showDemo ? 'warn' : 'ok');
      R('since').textContent = V.total ? `${V.sum.toLocaleString()} heard since ${new Date(V.t0).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : 'no packets yet';
      for (const b of mountEl.querySelectorAll('.pj-time-f')) b.classList.toggle('on', b.dataset.f === filter);
      for (let i = 0; i < 168; i++) {
        const el = cellEls[i], x = V.cells[i], col = heatColour(V.max ? x.n / V.max : 0);
        el.style.background = col; el.classList.toggle('pj-time-hot', !!V.max && x.n === V.max);
        el.classList.toggle('pj-time-now', i === V.now); el.title = cellText(i);
      }
      for (const w of mountEl.querySelectorAll('.pj-time-wl')) w.classList.toggle('on', +w.dataset.w === Math.floor(V.now / 24));
      for (const h of mountEl.querySelectorAll('.pj-time-hl')) h.classList.toggle('on', +h.dataset.h === V.now % 24);
      R('max').textContent = V.max.toLocaleString();
      R('pick').textContent = cellText(pick);
      const b = V.busiest;
      R('busy').innerHTML = b ? `Busiest: <b>${esc(b.label)}</b> · ${b.n.toLocaleString()}${b.guess ? ` <span class="pj-time-guess">(${esc(b.guess)})</span>` : ''}` : '<span class="dim">Busiest hour shows once a few more packets are in.</span>';

      R('tn').textContent = V.today.n.toLocaleString(); R('tr').textContent = V.today.r.toLocaleString();
      R('kn').textContent = `${V.known.toLocaleString()} known`;
      const top = Math.max(1, ...V.days.map(d => d.n + d.r));
      R('bars').innerHTML = V.days.map(d => {
        const tot = d.n + d.r;
        return `<div class="pj-time-day${d.today ? ' pj-time-today' : ''}" title="${esc(`${d.wd} ${d.date}: ${d.n} new, ${d.r} returning`)}">
          <span class="pj-time-dv">${tot || ''}</span>
          <div class="pj-time-stack" style="height:${(100 * tot / top).toFixed(1)}%"><i class="pj-time-sn" style="flex:${d.n}"></i><i class="pj-time-sr" style="flex:${d.r}"></i></div>
          <span class="pj-time-dl">${esc(d.wd.slice(0, 2))}<br>${d.date}</span></div>`;
      }).join('');
      R('ever').textContent = `"ever" = since ${new Date(V.t0).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }

    // ---------------------------------------------------------- scheduling (<= 1/s, visible only, no idle loop)
    let timer = 0, hourT = 0, lastDraw = 0, saveT = 0;
    function want() { if (!c.visible() || timer) return; timer = setTimeout(drawNow, Math.max(0, 1000 - (Date.now() - lastDraw))); }
    function drawNow() {
      clearTimeout(timer); timer = 0; clearTimeout(hourT); hourT = 0;
      if (!c.visible()) return;
      lastDraw = Date.now();
      try { draw(); } catch (e) { console.warn('pj-time draw', e); }
      // move the "now" outline when the hour turns over (one timer, only while shown)
      const d = new Date(); hourT = setTimeout(want, ((60 - d.getMinutes()) * 60 - d.getSeconds()) * 1000 + 500);
    }
    function save() {
      clearTimeout(saveT); saveT = 0;
      try { if (c.store) c.store.set('pjTime', { v: VERSION, live: A.compact(live, canon) }); } catch (e) { console.warn('pj-time save', e); }
    }
    const saveSoon = () => { if (!saveT) saveT = setTimeout(save, 15000); };

    // ---------------------------------------------------------- bus + DOM events
    const safe = fn => x => { try { fn(x); } catch (e) { console.warn('pj-time', e); } };
    const offs = [
      c.bus.on('packet', safe(ev => {
        if (!ev) return;
        if (ev.demo) A.add(demoSet(), ev, canon); else { A.add(live, ev, canon); saveSoon(); }
        if (!!ev.demo === showDemo) want();
      })),
      c.bus.on('nodes', safe(() => want())),
      c.bus.on('visible', safe(v => { if (v) drawNow(); else { clearTimeout(timer); timer = 0; clearTimeout(hourT); hourT = 0; if (saveT) save(); } })),
      c.bus.on('reset', safe(() => {
        live = A.empty(); demo = null; pick = -1;
        clearTimeout(saveT); saveT = 0; try { if (c.store) c.store.set('pjTime', null); } catch { /* storage off */ }
        if (c.visible()) drawNow();
      })),
      c.bus.on('demo', safe(on => { on = !!on; if (on === showDemo) return; showDemo = on; pick = -1; if (c.visible()) drawNow(); })),
    ];
    const cellAt = e => { const el = e.target.closest && e.target.closest('.pj-time-cell'); return el ? +el.dataset.i : -1; };
    const onClick = e => {
      const f = e.target.closest && e.target.closest('.pj-time-f');
      if (f) { filter = f.dataset.f; drawNow(); return; }
      const i = cellAt(e); if (i < 0) return;
      pick = i; for (const el of cellEls) el.classList.toggle('pj-time-sel', +el.dataset.i === i);
      R('pick').textContent = cellText(i);
    };
    const onOver = e => { const i = cellAt(e); if (i >= 0) R('pick').textContent = cellText(i); };
    const onOut = e => { if (cellAt(e) >= 0) R('pick').textContent = cellText(pick); };
    const onHide = () => save();
    mountEl.addEventListener('click', onClick); mountEl.addEventListener('mouseover', onOver); mountEl.addEventListener('mouseout', onOut);
    window.addEventListener('pagehide', onHide);

    if (c.visible()) drawNow();

    return {
      destroy() {
        for (const off of offs) try { off(); } catch { /* gone */ }
        clearTimeout(timer); clearTimeout(hourT);
        if (saveT) save();
        mountEl.removeEventListener('click', onClick); mountEl.removeEventListener('mouseover', onOver); mountEl.removeEventListener('mouseout', onOut);
        window.removeEventListener('pagehide', onHide);
        mountEl.innerHTML = '';
      },
      _view: () => A.view(cur(), canon, Date.now(), filter), _save: save, _sets: () => ({ live, demo, showDemo }),   // tests
    };
  }

  return { mount, createAgg, VERSION, SAVE_CAP, MAX_KNOWN, dayNum, hourRange, fnv };
});
