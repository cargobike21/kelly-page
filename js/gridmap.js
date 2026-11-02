/* Kelly Page -- SEQ Grid Map tab of the QLD Grid Power page (2026-10-18, unreleased).
 *
 * A LOGICAL map (not a geographic or exact network diagram) of how power reaches South East Queensland: each fuel's
 * QLD-wide output -> the 275 kV backbone -> 110 kV bulk supply -> 33 kV zone -> 11 kV towns, with rooftop solar fed
 * in at the 11 kV end and the rest of the state as one "Central & North QLD" sink.
 *   Real (the gateway's Open Electricity answer, over P25 -- gridApply in app.js): each fuel's MW, battery charging,
 *   operational demand, the NSW border flow, rooftop solar.
 *   Illustrative (said on the page): which stations stand for each fuel, and how demand divides between the SEQ nodes
 *   (fixed shares, TOWNS below), so the flows add up but aren't measured per node. No grid frequency (Open Electricity
 *   doesn't publish it).
 * Lines: red/orange 275-110 kV, amber 33 kV, yellow-green 11 kV, blue storage. Width = MW. Particles stream along each
 * line for FLOW_MS after a new reading (or when the tab opens), then stop -- the steady width + arrow keep showing
 * direction and size (kelly-page/CLAUDE.md "Flashy, but nothing loops forever").
 *
 * window.KellyGridMap(ctx) -> { render(d), shown() }; ctx = { $, esc, showPage }.
 */
(function () {
  'use strict';
  const FLOW_MS = 7000;
  // nodes: x, y in a 1200 x 640 viewBox; t = gen | tx (275 kV) | bsp (110 kV) | zone (33 kV) | town (11 kV) | sink
  const N = {
    coal: { x: 90, y: 70, t: 'gen', name: 'Coal', eg: 'Tarong, Millmerran, Callide, Stanwell, Gladstone', fuel: 'coal' },
    gas: { x: 90, y: 160, t: 'gen', name: 'Gas', eg: 'Swanbank E, Darling Downs, Braemar, Condamine', fuel: 'gas' },
    wind: { x: 90, y: 250, t: 'gen', name: 'Wind', eg: 'Coopers Gap, MacIntyre, Dulacca', fuel: 'wind' },
    solar: { x: 90, y: 340, t: 'gen', name: 'Utility solar', eg: 'Western Downs, Darling Downs and Lilyvale solar farms', fuel: 'solar' },
    hydro: { x: 90, y: 430, t: 'gen', name: 'Hydro', eg: 'Wivenhoe (pumped storage), Barron Gorge, Kareeya', fuel: 'hydro', store: 1 },
    battery: { x: 90, y: 520, t: 'gen', name: 'Batteries', eg: 'Western Downs, Wandoan, Swanbank and other big batteries', fuel: 'battery', store: 1 },
    nsw: { x: 90, y: 610, t: 'gen', name: 'NSW interconnector', eg: 'QNI and Terranora (Directlink)', fuel: 'nsw' },
    tarong: { x: 360, y: 110, t: 'tx', name: 'Tarong / Halys 275 kV', eg: 'Western backbone' },
    mridge: { x: 360, y: 400, t: 'tx', name: 'Middle Ridge 275 kV', eg: 'Toowoomba' },
    blackwall: { x: 600, y: 260, t: 'tx', name: 'Blackwall 275 kV', eg: 'Ipswich' },
    spine: { x: 840, y: 110, t: 'tx', name: 'South Pine 275 kV', eg: 'North Brisbane' },
    cnq: { x: 600, y: 40, t: 'sink', name: 'Central & North QLD', eg: 'The rest of the state' },
    swanbank: { x: 600, y: 420, t: 'bsp', name: 'Swanbank 110 kV', eg: 'Bulk supply, Ipswich' },
    rocklea: { x: 840, y: 330, t: 'bsp', name: 'Rocklea 110 kV', eg: 'Bulk supply, SW Bris' },
    murarrie: { x: 1060, y: 230, t: 'bsp', name: 'Murarrie 110 kV', eg: 'Bulk supply, E Bris' },
    ipsw: { x: 600, y: 520, t: 'zone', name: 'Ipswich West 33 kV', eg: 'Zone substation' },
    richlands: { x: 840, y: 470, t: 'zone', name: 'Richlands 33 kV', eg: 'Zone substation' },
    tmba: { x: 360, y: 520, t: 'zone', name: 'Toowoomba 33 kV', eg: 'Zone substation' },
    t_tmba: { x: 360, y: 610, t: 'town', name: 'Toowoomba 11 kV', share: 0.035 },
    t_ipsw: { x: 600, y: 610, t: 'town', name: 'Ipswich 11 kV', share: 0.05 },
    t_spring: { x: 840, y: 610, t: 'town', name: 'Springfield 11 kV', share: 0.04 },
    t_logan: { x: 1000, y: 470, t: 'town', name: 'Logan & Gold Coast', share: 0.11 },
    t_cbd: { x: 1120, y: 360, t: 'town', name: 'Brisbane CBD 11 kV', share: 0.12 },
    t_north: { x: 1100, y: 110, t: 'town', name: 'North Brisbane 11 kV', share: 0.1 },
  };
  // edges: from, to, kV class (275 | 110 | 33 | 11 | st = storage)
  const E = [
    ['coal', 'tarong', 275], ['gas', 'tarong', 275], ['wind', 'tarong', 275], ['solar', 'mridge', 275], ['nsw', 'mridge', 275],
    ['hydro', 'blackwall', 'st'], ['battery', 'blackwall', 'st'],
    ['tarong', 'cnq', 275], ['tarong', 'spine', 275], ['tarong', 'blackwall', 275], ['mridge', 'blackwall', 275], ['mridge', 'tmba', 110],
    ['blackwall', 'swanbank', 110], ['blackwall', 'rocklea', 110], ['spine', 'murarrie', 110], ['spine', 't_north', 33],
    ['swanbank', 'ipsw', 33], ['rocklea', 'richlands', 33], ['rocklea', 't_logan', 33], ['murarrie', 't_cbd', 33],
    ['tmba', 't_tmba', 11], ['ipsw', 't_ipsw', 11], ['richlands', 't_spring', 11],
  ];
  const TOWNS = Object.keys(N).filter(k => N[k].t === 'town');

  // Full screen for a panel: the browser's Fullscreen API (Esc leaves); where it's refused, a fixed full-window layer
  // (class .gm-fs, Esc leaves too). The button's label follows. Used by both QLD Grid Power tabs.
  function fullscreen(el, btn, onEnter) {
    const isFull = () => document.fullscreenElement === el || el.classList.contains('gm-fs');
    const label = () => { btn.textContent = isFull() ? '✕ Exit full screen' : '⛶ Full screen'; };
    const leave = () => { if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {}); el.classList.remove('gm-fs'); label(); };
    btn.onclick = () => {
      if (isFull()) return leave();
      const fallback = () => { el.classList.add('gm-fs'); label(); if (onEnter) onEnter(); };
      if (el.requestFullscreen) el.requestFullscreen().then(() => onEnter && onEnter()).catch(fallback); else fallback();
    };
    document.addEventListener('fullscreenchange', label);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && el.classList.contains('gm-fs')) leave(); });
    return { leave };
  }
  const fmt = mw => (Math.abs(mw) >= 1000 ? (mw / 1000).toFixed(2) + ' GW' : Math.round(mw) + ' MW');

  // Flows from a reading. Operational demand (Open Electricity's) is already net of rooftop solar, so each town's grid
  // draw is its share of it; the rest goes to Central & North QLD. Fuel lines carry the real MW. Below the backbone each
  // line carries what its side needs (a tree solve). Blackwall is fed twice: Middle Ridge sends its local surplus (solar
  // + NSW less Toowoomba, negative = Blackwall feeds it), hydro and batteries feed in directly, Tarong makes up the rest.
  // Supply and demand don't match to the MW (losses, "other" fuel, interval timing), so Tarong's in and out differ a little.
  function flows(d) {
    const m = d.mix || {}, f = {}, demand = +d.d || 0, roof = +m.rooftop || 0;
    const sh = TOWNS.reduce((s, k) => s + N[k].share, 0);
    const load = {}; TOWNS.forEach(k => { load[k] = demand * N[k].share; });
    load.cnq = demand * (1 - sh);
    const gen = { coal: +m.coal || 0, gas: +m.gas || 0, wind: +m.wind || 0, solar: +m.solar || 0, hydro: +m.hydro || 0, battery: (+m.battery || 0) - (+d.chg || 0), nsw: (+d.imp || 0) - (+d.exp || 0) };
    const kids = {}; E.forEach(([a, b]) => { (kids[a] = kids[a] || []).push(b); });
    const need = n => (load[n] != null ? load[n] : 0) + (kids[n] || []).reduce((s, c) => s + need(c), 0);
    E.forEach(([a, b]) => { f[a + '>' + b] = N[a].t === 'gen' ? gen[a] : need(b); });
    f['mridge>blackwall'] = gen.solar + gen.nsw - need('tmba');
    f['tarong>blackwall'] = need('blackwall') - f['mridge>blackwall'] - gen.hydro - gen.battery;
    return { f, load, gen, demand, roof };
  }

  window.KellyGridMap = function (k) {
    const { $, esc } = k;
    let drawnAt = 0, sel = null, raf = 0, until = 0, paths = [], last = null;

    function svg(d) {
      const { f, load, gen } = flows(d), max = Math.max(1, ...Object.values(f).map(Math.abs));
      let s = '<defs><marker id="gm-arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="gm-arrh"/></marker></defs>';
      for (const [a, b, kv] of E) {
        const A = N[a], B = N[b], mw = f[a + '>' + b], w = 1.5 + 9 * Math.sqrt(Math.abs(mw) / max), rev = mw < 0;
        const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2, x0 = rev ? B.x : A.x, y0 = rev ? B.y : A.y, x1 = rev ? A.x : B.x, y1 = rev ? A.y : B.y;
        const id = `gm-e-${a}-${b}`, dd = `M${x0} ${y0} C${(x0 + mx) / 2} ${y0} ${(mx + x1) / 2} ${y1} ${x1} ${y1}`;
        s += `<path id="${id}" class="gm-e kv${kv} ${Math.abs(mw) < 1 ? 'idle' : ''}" d="${dd}" style="stroke-width:${w.toFixed(1)}px" data-mw="${Math.round(mw)}"/>`;
        if (Math.abs(mw) >= 1) s += `<path class="gm-dir kv${kv}" d="M${(mx - (x1 - x0) * 0.02).toFixed(1)} ${(my - (y1 - y0) * 0.02).toFixed(1)} L${(mx + (x1 - x0) * 0.02).toFixed(1)} ${(my + (y1 - y0) * 0.02).toFixed(1)}" marker-end="url(#gm-arr)"/>`;
        s += `<text class="gm-mw" x="${mx}" y="${my - 6}" text-anchor="middle">${Math.abs(mw) < 1 ? '' : fmt(Math.abs(mw))}${rev && N[a].t === 'gen' ? ' ⇐' : ''}</text>`;
      }
      for (const [key, n] of Object.entries(N)) {
        const v = n.t === 'gen' ? gen[key] : n.t === 'town' || key === 'cnq' ? load[key] : null;
        const sub = n.t === 'gen' ? (key === 'battery' && v < 0 ? `charging ${fmt(-v)}` : key === 'nsw' ? (v >= 0 ? `importing ${fmt(v)}` : `exporting ${fmt(-v)}`) : fmt(v || 0)) : v != null ? (v < 0 ? `exporting ${fmt(-v)}` : fmt(v)) : n.eg;
        s += `<g class="gm-n t-${n.t} ${n.store ? 'store' : ''} ${sel === key ? 'sel' : ''} ${v != null && v < 0 ? 'rev' : ''}" data-node="${key}" tabindex="0"><rect x="${n.x - 66}" y="${n.y - 20}" width="132" height="40" rx="9"/>`
          + `<text class="gm-nm" x="${n.x}" y="${n.y - 3}" text-anchor="middle">${esc(n.name)}</text><text class="gm-sub" x="${n.x}" y="${n.y + 12}" text-anchor="middle">${esc(sub)}</text></g>`;
      }
      return `<svg class="gm-svg" viewBox="0 0 1200 640" role="img" aria-label="Logical map of how power reaches South East Queensland">${s}<g id="gm-dots"></g></svg>`;
    }
    function panel(d) {
      if (!sel) return '<p class="dim">Click any node for its role and the power through it.</p>';
      const n = N[sel], { f, load, gen } = flows(d);
      const ins = E.filter(e => e[1] === sel).map(e => [e[0], f[e[0] + '>' + sel]]), outs = E.filter(e => e[0] === sel).map(e => [e[1], f[sel + '>' + e[1]]]);
      const real = n.t === 'gen';
      let h = `<h3>${esc(n.name)}</h3><p class="dim small">${esc(n.eg || '')}</p>`;
      if (real) h += `<p><b>${fmt(Math.abs(gen[sel]))}</b> ${sel === 'battery' && gen[sel] < 0 ? 'charging' : sel === 'nsw' ? (gen[sel] >= 0 ? 'imported from NSW' : 'exported to NSW') : 'Queensland-wide'} <span class="tag ok">REAL</span></p><p class="dim small">From Open Electricity via the P25X gateway. The stations named are examples of this fuel; the figure is all of it across QLD.</p>`;
      else {
        if (load[sel] != null) h += `<p>Grid draw <b>${fmt(load[sel])}</b> <span class="tag warn">ILLUSTRATIVE</span></p><p class="dim small">${sel === 'cnq' ? 'Queensland demand not drawn on this SEQ map.' : `A fixed ${(N[sel].share * 100).toFixed(1)} % share of QLD operational demand -- what the grid supplies after rooftop solar, which would cover roughly another ${fmt(N[sel].share * flows(d).roof)} here right now.`}</p>`;
        h += ins.concat(outs).length ? `<ul class="gm-io">${ins.map(([x, mw]) => `<li>⬅ ${esc(N[x].name)} <b>${fmt(Math.abs(mw))}</b></li>`).join('')}${outs.map(([x, mw]) => `<li>➡ ${esc(N[x].name)} <b>${fmt(Math.abs(mw))}</b></li>`).join('')}</ul>` : '';
      }
      if (['zone', 'town', 'bsp'].includes(n.t)) h += `<button class="btn small" data-gm-scada="sub">🔌 Open a substation SCADA view (DNP3 Demo)</button>`;
      if (sel === 'hydro') h += `<button class="btn small" data-gm-scada="wiv">💧 Run Wivenhoe in the SCADA trainer (DNP3 Demo)</button>`;
      if (sel === 'gas') h += `<button class="btn small" data-gm-scada="gt">⛽ Run a gas turbine peaker in the SCADA trainer (DNP3 Demo)</button>`;
      return h;
    }
    // particles: dots along each live edge for FLOW_MS, speed and count by MW
    function flow() {
      cancelAnimationFrame(raf);
      const g = document.getElementById('gm-dots'); if (!g || !document.body.classList.contains('fx')) return;
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const max = Math.max(1, ...[...document.querySelectorAll('.gm-e')].map(p => Math.abs(+p.dataset.mw)));
      paths = [...document.querySelectorAll('.gm-e:not(.idle)')].map(p => {
        const mw = Math.abs(+p.dataset.mw), len = p.getTotalLength(), n = Math.max(1, Math.round(1 + 5 * mw / max));
        const dots = Array.from({ length: n }, (_, i) => { const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('r', 2.6); c.setAttribute('class', 'gm-dot ' + [...p.classList].find(x => x.startsWith('kv'))); g.appendChild(c); return { c, o: i / n }; });
        return { p, len, v: 0.08 + 0.25 * mw / max, dots };
      });
      until = performance.now() + FLOW_MS;
      const step = t => {
        const fade = Math.max(0, Math.min(1, (until - t) / 1200));
        for (const e of paths) for (const d of e.dots) { const u = (d.o + t / 1000 * e.v) % 1, pt = e.p.getPointAtLength(u * e.len); d.c.setAttribute('cx', pt.x); d.c.setAttribute('cy', pt.y); d.c.style.opacity = fade; }
        if (t < until) raf = requestAnimationFrame(step); else g.innerHTML = '';
      };
      raf = requestAnimationFrame(step);
    }
    function render(d) {
      const host = $('#gm-map'); if (!host) return;
      if (!d || !d.mix) { host.innerHTML = '<p class="dim">No reading yet -- press Refresh to ask the P25X gateway.</p>'; return; }
      const onTab = !!$('[data-tabpane="grid:map"].on');
      if (d.got !== drawnAt || last !== sel) {
        host.innerHTML = svg(d);
        const isNew = d.got !== drawnAt; drawnAt = d.got; last = sel;
        if (isNew && onTab) flow();
      }
      $('#gm-panel').innerHTML = panel(d);
      const f = flows(d);
      $('#gm-sum').innerHTML = `<span>Demand <b>${fmt(f.demand)}</b></span><span>Rooftop solar <b>${fmt(f.roof)}</b></span><span>SEQ towns on this map <b>${fmt(TOWNS.reduce((s, x) => s + Math.max(0, f.load[x]), 0))}</b></span>`;
    }
    function shown() { setTimeout(flow, 80); }
    function init() {
      const host = $('#gm-map'); if (!host) return;
      host.addEventListener('click', e => { const g = e.target.closest('[data-node]'); if (g) { sel = g.dataset.node; k.redraw(); } });
      host.addEventListener('keydown', e => { if (e.key === 'Enter') { const g = e.target.closest('[data-node]'); if (g) { sel = g.dataset.node; k.redraw(); } } });
      const fs = fullscreen($('#gm-card'), $('#gm-full'), () => setTimeout(flow, 120));
      $('#gm-panel').addEventListener('click', e => {
        const b = e.target.closest('[data-gm-scada]'); if (!b) return;
        fs.leave(); k.showPage('dnp3');
        const p = document.querySelector(`#d3-plant [data-plant="${b.dataset.gmScada}"]`); if (p && !p.closest('[hidden]')) p.click();   // pick the plant too
      });
      const ov = $('#gr-overview'), ob = $('#gr-full'); if (ov && ob) fullscreen(ov, ob, k.redraw);   // QLD overview tab
    }
    return { init, render, shown };
  };
})();
