/* Kelly Page -- SEQ Dam Telemetry (2026-10-18, unreleased): South East Queensland's dams and the rivers either side of
 * them, carried over P25 packet data. A show-piece for what a P25 data network can move: one ~650 B answer (~2 s on air)
 * holds six storages with four weeks of history and the live river gauges.
 *
 * The gateway does the fetching (dashboard seq-dams.js): Seqwater's dam-levels table and daily history, plus river
 * height and discharge from the Queensland Water Monitoring Information Portal (WMIP, Hydstra web service, datasource AT).
 * Kelly asks over the Radio-files path, KF kind 3 {op: 'dams'} -> kind 4 {app: 'dams', ...} | {app: 'dams', error};
 * the fields are in seq-dams.js's header -- keep apply() and DAMS in step with it. Asked when the page opens and every
 * settings.damsEvery minutes (default 30; Seqwater updates through the day, WMIP hourly) while it stays open.
 *
 * Tabs: Overview (tank gauges), P25 Packet Stream (the real answer's bytes, link lamps, and a SIMULATOR of per-station
 * telemetry frames -- clearly labelled, never mixed into the real figures), River Flow (inflow / outflow per dam).
 * Animations play once per new reading (water rises, waves slosh 3 times, rivers flow 4 times), then .dm-calm stops
 * them -- nothing loops (kelly-page/CLAUDE.md "Flashy, but nothing loops forever").
 *
 * window.KellyDamsUI(ctx) -> { init, render, shown, gatewayReply, ownsXid, kfEvent }; ctx from app.js.
 */
(function () {
  'use strict';
  const ANSWER_MS = 90000, SIM_MS = 60000, CALM_MS = 9000;
  // = DAMS in the dashboard's seq-dams.js (keys + gauge stations). gated: has spillway gates (Seqwater's gated dams).
  const DAMS = [
    { k: 'wiv', name: 'Wivenhoe', lake: 'Lake Wivenhoe', river: 'Brisbane River', gated: true, stn: 'WIV',
      in: ['143009A', 'Brisbane R at Gregors Creek'], out: ['143001C', 'Brisbane R at Savages Crossing'] },
    { k: 'som', name: 'Somerset', lake: 'Lake Somerset', river: 'Stanley River', gated: true, stn: 'SOM',
      in: ['143901A', 'Stanley R at Woodford'], out: null, outNote: 'Releases straight into Lake Wivenhoe' },
    { k: 'npd', name: 'North Pine', lake: 'Lake Samsonvale', river: 'North Pine River', gated: true, stn: 'NPD',
      in: null, out: null, outNote: 'No live stream gauge -- the WMIP sites on the North Pine are closed' },
    { k: 'hin', name: 'Hinze', lake: 'Advancetown Lake', river: 'Nerang River', stn: 'HIN',
      in: ['146015A', 'Nerang R at Numinbah'], out: ['146002B', 'Nerang R at Glenhurst'] },
    { k: 'wya', name: 'Wyaralong', lake: 'Wyaralong Dam', river: 'Teviot Brook', stn: 'WYA',
      in: ['145011A', 'Teviot Bk at Croftby'], out: null, outNote: 'No telemetry below the wall' },
    { k: 'les', name: 'Leslie Harrison', lake: 'Leslie Harrison Dam', river: 'Tingalpa Creek', gated: true, stn: 'LHD',
      in: null, out: null, outNote: 'No live stream gauge on Tingalpa Creek' },
  ];
  // A real answer from the gateway, 2026-10-18 15:05 -- what the demo radio "receives" (nothing on air)
  const DEMO = {"t":"2026-10-18T05:05:00.000Z","tot":{"p":79.6,"v":2048904,"f":2574180,"n":25,"s":[81.7,81.6,81.6,81.2,81,80.9,80.9,80.6,80.7,80.5,80.5,80.2,80.2,80.2,79.6]},"d":{"hin":{"p":94.4,"v":293360,"f":310730,"t":"2026-10-18T04:00:00.000Z","s":[96.2,96.1,96,95.8,95.7,95.6,95.4,95.4,95.2,95.1,94.9,94.8,94.6,94.5,94.4],"w":-0.5,"dv":-144},"les":{"p":73.1,"v":9658,"f":13206,"t":"2026-10-18T05:00:00.000Z","s":[76.8,76.5,76.3,85.4,75.8,75.5,75.2,74.9,74.8,74.4,74.1,73.7,73.4,73.2,73.1],"w":-0.8,"dv":-5},"npd":{"p":47.9,"v":102697,"f":214302,"t":"2026-10-18T05:00:00.000Z","s":[49.2,49,48.9,48.8,48.7,48.6,48.5,48.4,48.3,48.2,48.1,48,47.9,47.9,47.9],"w":-0.2,"dv":0},"som":{"p":78.6,"v":298566,"f":379849,"t":"2026-10-18T05:03:00.000Z","fu":0,"s":[79.5,79.4,79.1,79.1,79,79,78.9,78.8,78.8,78.8,78.8,78.7,78.6,78.6,78.6],"w":-0.1,"dv":-312},"wiv":{"p":79.3,"v":923649,"f":1165240,"t":"2026-10-18T05:05:00.000Z","fu":0,"s":[81.9,82,82.2,81.4,81,81.1,81.2,80.7,81,80.7,80.8,80.4,80.6,80.6,79.3],"w":-1.6,"dv":-10563},"wya":{"p":95.4,"v":98184,"f":102883,"t":"2026-10-18T05:00:00.000Z","s":[96.3,96.2,96.1,96,96,95.9,95.8,95.7,95.8,95.8,95.7,95.6,95.6,95.5,95.4],"w":-0.2,"dv":-35}},"r":{"143009A":{"h":0.88,"t":"2026-10-18T06:00:00.000Z","qt":[0.175,0.177,0.18,0.182,0.183,0.183,0.184,0.18],"q":0.18},"143001C":{"h":1.32,"t":"2026-10-18T06:00:00.000Z","qt":[4.155,4,3.911,3.84,3.779,3.783,3.805,3.829],"q":3.829},"143901A":{"h":1.858,"t":"2026-10-18T06:00:00.000Z","qt":[0.237,0.225,0.232,0.284,0.381,0.516,0.662,0.746],"q":0.746},"146015A":{"h":0.478,"t":"2026-10-18T06:00:00.000Z","qt":[0.029,0.036,0.04,0.041,0.071,0.09,0.083,0.073],"q":0.073},"146002B":{"h":0.267,"t":"2026-10-18T06:00:00.000Z","qt":[0.172,0.174,0.182,0.202,0.218,0.292,0.3,0.215],"q":0.215},"145011A":{"h":0.533,"t":"2026-10-18T06:00:00.000Z","qt":[0.005,0.005,0.005,0.006,0.006,0.006,0.006,0.007],"q":0.007}}};

  window.KellyDamsUI = function (k) {
    const { $, $$, esc, store, toast, dirty, settings, saveSoon, fmtAgo } = k;
    const S = {
      d: store.get('dams', null),            // the last answer + {got, air: {bytes, secs}}
      hex: store.get('damsHex', null),       // the packed bytes of the last real answer, hex (what crossed the air)
      ask: null, err: '', drawn: 0, prev: {}, timer: 0, t: 0, calm: 0, txAt: 0, rxAt: 0,
      sim: { on: false, until: 0, t: 0, seq: 0, rows: [], rssi: null, snr: null, ok: 0, bad: 0 },
    };
    const every = () => (settings.damsEvery == null ? 30 : +settings.damsEvery);
    const unit = () => settings.damsUnit || 'cumecs';
    const n0 = v => (v == null || isNaN(v) ? '--' : Math.round(v).toLocaleString());
    const pc = v => (v == null || isNaN(v) ? '--' : (+v).toFixed(1));
    const hhmm = iso => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--');

    // ------------------------------------------------------------------ asking the gateway
    async function ask(auto) {
      if (S.ask) return;
      if (auto && (!k.radioConnected() || k.rfBusy())) { dirty('dams'); return; }   // try again on the next tick
      S.err = '';
      if (k.demo()) {   // the demo radio has no gateway: a real answer from 2026-10-18, nothing on air
        const xid = -Date.now();
        S.ask = { xid, at: Date.now(), phase: 'asking', demo: true, auto }; S.txAt = Date.now();
        setTimeout(() => { if (S.ask && S.ask.xid === xid) kfEvent({ kind: 'tx-done' }); }, 700);
        setTimeout(() => { if (S.ask && S.ask.xid === xid) gatewayReply({ app: 'dams', at: Date.now(), ...JSON.parse(JSON.stringify(DEMO)) }, null); }, 2400);
        tick(); dirty('dams'); return;
      }
      if (!k.radioConnected()) { S.err = 'Offline -- connect the radio to ask the P25X gateway'; dirty('dams'); return; }
      S.ask = { xid: 0, at: Date.now(), phase: 'asking', auto };   // held across the await so a second tap can't ask twice
      const xid = await k.kfRequest({ op: 'dams' }, 'SEQ dam telemetry');
      S.ask = xid ? { xid, at: Date.now(), phase: 'asking', auto } : null;
      if (xid) S.txAt = Date.now();
      else if (!auto) S.err = 'The radio is busy -- try again in a moment';
      tick(); dirty('dams');
    }
    function tick() {   // 1 s redraws while a request is out (lamps, chunk count); stops when it's answered
      clearTimeout(S.t);
      if (!S.ask) return;
      dirty('dams');
      S.t = setTimeout(tick, 1000);
    }
    function kfEvent(e) {
      if (!S.ask) return;
      if (e.kind === 'tx-done') {
        S.ask.phase = 'gateway'; S.ask.delivered = Date.now();
        const xid = S.ask.xid;
        setTimeout(() => { if (S.ask && S.ask.xid === xid && !k.rfRx()) { S.ask = null; S.err = 'The gateway took the request but never answered -- press Refresh to try again'; dirty('dams'); } }, ANSWER_MS);
      } else if (e.kind === 'tx-failed') { S.err = e.cancelled ? '' : 'No answer from the P25X gateway -- press Refresh to try again'; S.ask = null; }
      dirty('dams');
    }
    function gatewayReply(j, r) {   // r = the finished transfer (r.data = the packed bytes that crossed the air)
      const a = S.ask; S.ask = null; clearTimeout(S.t);
      S.rxAt = Date.now();
      if (j.error) { S.err = j.error; if (!(a && a.auto)) toast('💧', 'SEQ Dam Telemetry', j.error, 'bad'); dirty('dams'); return; }
      if (S.d) for (const x of DAMS) if (S.d.d && S.d.d[x.k]) S.prev[x.k] = S.d.d[x.k].p;   // the water rises from here
      if (S.d && S.d.tot) S.prev.tot = S.d.tot.p;
      S.d = { ...j, got: Date.now(), air: { bytes: r && r.data ? r.data.length : 0, secs: a && !a.demo ? (Date.now() - a.at) / 1000 : null } };
      if (r && r.data) { S.hex = Array.from(r.data, b => b.toString(16).padStart(2, '0')).join(''); store.set('damsHex', S.hex); }
      store.set('dams', S.d); S.err = '';
      if (r) k.addEvent('data', `SEQ dams over P25: ${j.tot ? j.tot.p : '?'}% combined, ${r.data.length} B`);
      unCalm();
      dirty('dams');
    }
    function autoTick() {   // auto refresh while the page is open
      clearTimeout(S.timer); S.timer = 0;
      if (k.currentPage() !== 'dams') return;
      const ev = every();
      if (ev && (!S.d || Date.now() - S.d.got >= ev * 60000 - 5000)) ask(true);
      S.timer = setTimeout(autoTick, 30000);
      dirty('dams');   // keeps "received … ago" and the lamps current
    }
    function unCalm() {   // let the arrival animations play once, then stop everything (no replay on tab switches)
      const pg = $('#page-dams'); if (pg) pg.classList.remove('dm-calm');
      clearTimeout(S.calm);
      S.calm = setTimeout(() => { const p = $('#page-dams'); if (p) p.classList.add('dm-calm'); }, CALM_MS);
    }

    // ------------------------------------------------------------------ reading the answer
    function damStatus(x, v, d) {   // [class, words]
      if (!v) return ['none', 'No reading'];
      if (v.sp) return ['spill', x.gated ? 'Spilling / gated release' : 'Spilling'];
      if (v.fu > 0) return ['flood', `Flood storage ${pc(v.fu)}% in use`];
      const g = x.in && d.r && d.r[x.in[0]];
      if (g && surging(g)) return ['inflow', 'High inflow'];
      if (v.p >= 99) return ['full', 'At full supply'];
      return ['ok', 'Below full supply'];
    }
    function surging(g) { const qt = g.qt || []; return g.q >= 50 || (g.q >= 2 && qt.length > 1 && qt[0] > 0 && g.q / qt[0] >= 3); }
    function netStatus(d) {
      const st = DAMS.map(x => [x, damStatus(x, d.d[x.k], d)]);
      const of = c => st.filter(s => s[1][0] === c).map(s => s[0].name);
      const ageH = d.t ? (Date.now() - new Date(d.t).getTime()) / 3600e3 : 99;
      if (of('spill').length) return ['spill', 'Spillway active', of('spill').join(', ')];
      if (of('flood').length) return ['flood', 'Flood operations', of('flood').join(', ')];
      if (of('inflow').length) return ['inflow', 'High inflow', of('inflow').join(', ')];
      if (ageH > 6 || d.stale) return ['old', 'Data delayed', d.stale ? 'Seqwater unreachable -- the gateway sent its last copy' : `Last observation ${Math.round(ageH)} h ago`];
      return ['ok', 'Nominal', 'All six storages below full supply, rivers quiet'];
    }
    const trendOf = (a, b, tol) => (a == null || b == null ? '' : b - a > tol ? 'up' : a - b > tol ? 'down' : 'flat');
    const arrow = t => (t === 'up' ? '▲' : t === 'down' ? '▼' : '►');
    function flowFmt(q) {   // m3/s or ML/day
      if (q == null) return ['--', unit() === 'mld' ? 'ML/d' : 'm³/s'];
      if (unit() === 'mld') { const v = q * 86.4; return [v >= 100 ? n0(v) : v.toFixed(v >= 10 ? 1 : 2), 'ML/d']; }
      return [q >= 100 ? n0(q) : q.toFixed(q >= 10 ? 1 : q >= 1 ? 2 : 3), 'm³/s'];
    }

    // ------------------------------------------------------------------ drawing
    function spark(vals, w = 160, h = 34, cls = '') {
      const v = (vals || []).filter(x => x != null);
      if (v.length < 2) return '';
      const lo = Math.min(...v), hi = Math.max(...v), X = i => (i / (v.length - 1)) * w, Y = y => (hi === lo ? h / 2 : h - 3 - (y - lo) / (hi - lo) * (h - 6));
      const pts = v.map((y, i) => `${X(i).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');
      return `<svg class="dm-spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="a" d="M0,${h} L${pts.replace(/ /g, ' L')} L${w},${h} Z"/><polyline points="${pts}"/>`
        + `<circle cx="${X(v.length - 1).toFixed(1)}" cy="${Y(v[v.length - 1]).toFixed(1)}" r="2.6"/></svg>`;
    }
    // A wave strip twice the tank's width: it slides sideways (3 times) while the water level transitions into place
    const wave = (x0, w, amp) => { let p = `M${x0} 0`; for (let x = x0; x < x0 + w * 2; x += 30) p += ` q7.5 ${-amp} 15 0 t15 0`; return `${p} V400 H${x0} Z`; };
    function tank(id, p, from, cls = '') {   // a tall storage tank: 0-100 % of full supply, overflow lip above
      const X = 14, Y = 14, W = 92, H = 120, lvl = v => Y + H * (1 - Math.max(0, Math.min(104, v || 0)) / 100);
      const ticks = [25, 50, 75].map(t => `<line x1="${X + W - 12}" x2="${X + W}" y1="${lvl(t)}" y2="${lvl(t)}"/><text x="${X + W - 15}" y="${lvl(t) + 3}">${t}</text>`).join('');
      return `<svg class="dm-tank ${cls}" viewBox="0 0 120 150" data-to="${lvl(p).toFixed(1)}">
        <defs><clipPath id="${id}"><rect x="${X}" y="${Y}" width="${W}" height="${H}" rx="12"/></clipPath>
          <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="s0"/><stop offset="1" class="s1"/></linearGradient></defs>
        <rect class="dm-shell" x="${X}" y="${Y}" width="${W}" height="${H}" rx="12"/>
        <g clip-path="url(#${id})"><g class="dm-water" style="transform:translateY(${lvl(from).toFixed(1)}px)">
          <path class="dm-wave back" d="${wave(X - 60, W + 60, 4)}" fill="url(#${id}g)"/>
          <path class="dm-wave" d="${wave(X - 45, W + 60, 5)}" fill="url(#${id}g)"/></g>
          <g class="dm-bub"><circle cx="${X + 24}" cy="${Y + H - 6}" r="2"/><circle cx="${X + 52}" cy="${Y + H - 4}" r="1.5"/><circle cx="${X + 70}" cy="${Y + H - 8}" r="2.4"/></g></g>
        <g class="dm-ticks">${ticks}</g>
        <line class="dm-fsl" x1="${X - 6}" x2="${X + W + 6}" y1="${Y}" y2="${Y}"/><text class="dm-fsl-t" x="${X - 4}" y="${Y - 4}">FSL</text>
        <rect class="dm-rim" x="${X}" y="${Y}" width="${W}" height="${H}" rx="12"/></svg>`;
    }
    function bigTank(p, from) {   // the combined storage: a round reservoir with a % ring
      const R = 92, C = 2 * Math.PI * 104, lvl = v => 110 + R - 2 * R * Math.max(0, Math.min(100, v || 0)) / 100;
      return `<svg class="dm-big" viewBox="0 0 220 220" data-to="${lvl(p).toFixed(1)}">
        <defs><clipPath id="dmc-tot"><circle cx="110" cy="110" r="${R}"/></clipPath>
          <linearGradient id="dmc-totg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="s0"/><stop offset="1" class="s1"/></linearGradient></defs>
        <circle class="dm-ring-bg" cx="110" cy="110" r="104"/>
        <circle class="dm-ring" cx="110" cy="110" r="104" style="stroke-dasharray:${(C * Math.min(100, p || 0) / 100).toFixed(1)} ${C.toFixed(1)}"/>
        <circle class="dm-shell" cx="110" cy="110" r="${R}"/>
        <g clip-path="url(#dmc-tot)"><g class="dm-water" style="transform:translateY(${lvl(from).toFixed(1)}px)">
          <path class="dm-wave back" d="${wave(-60, 300, 6)}" fill="url(#dmc-totg)"/><path class="dm-wave" d="${wave(-40, 300, 7)}" fill="url(#dmc-totg)"/></g></g>
        <text class="dm-big-p" x="110" y="112">${pc(p)}<tspan>%</tspan></text><text class="dm-big-l" x="110" y="138">COMBINED SEQ</text></svg>`;
    }
    function settle(root) {   // move every new tank's water from its old level to the new one (CSS transition)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        root.querySelectorAll('svg[data-to]').forEach(s => { const w = s.querySelector('.dm-water'); if (w) w.style.transform = `translateY(${s.dataset.to}px)`; });
      }));
    }

    function renderOverview(d) {
      const tot = d.tot || {}, ns = netStatus(d);
      const hero = $('#dm-hero');
      hero.className = 'dm-hero st-' + ns[0];
      const tw = tot.s && tot.s.length > 7 ? tot.p - tot.s[tot.s.length - 4] : null;   // ~a week (points are 2 days apart)
      hero.innerHTML = `<div class="dm-big-wrap">${bigTank(tot.p, S.prev.tot != null ? S.prev.tot : 0)}</div>
        <div class="dm-hero-txt">
          <div class="dm-status"><i class="dm-orb"></i><b>${esc(ns[1])}</b><small>${esc(ns[2])}</small></div>
          <div class="dm-kv"><span>Stored</span><b>${n0(tot.v)}<small> ML</small></b></div>
          <div class="dm-kv"><span>Full supply</span><b>${n0(tot.f)}<small> ML</small></b></div>
          <div class="dm-kv"><span>Dams</span><b>${tot.n || '--'}<small> Seqwater storages</small></b></div>
          <div class="dm-kv"><span>Week</span><b class="dm-tr ${trendOf(0, tw, 0.2)}">${tw == null ? '--' : `${arrow(trendOf(0, tw, 0.2))} ${tw > 0 ? '+' : ''}${tw.toFixed(1)}`}<small> % points</small></b></div>
          <div class="dm-hero-spark" title="All 25 dams, % of full supply, last four weeks">${spark(tot.s, 300, 46)}<span>4 weeks</span></div>
        </div>`;
      $('#dm-cards').innerHTML = DAMS.map((x, n) => {
        const v = d.d[x.k];
        if (!v) return `<div class="dm-card none"><h3>${esc(x.name)}</h3><p class="dim small">Not in this answer</p></div>`;
        const st = damStatus(x, v, d), tr = v.w == null ? '' : trendOf(0, v.w, 0.3);
        const gi = x.in && d.r && d.r[x.in[0]], go = x.out && d.r && d.r[x.out[0]];
        return `<button class="dm-card st-${st[0]}" data-dam="${x.k}" style="--i:${n}">
          <div class="dm-card-h"><h3>${esc(x.name)}</h3><span class="dm-led ${st[0]}" title="${esc(st[1])}"></span></div>
          <div class="dm-card-b">${tank('dmc-' + x.k, v.p, S.prev[x.k] != null ? S.prev[x.k] : 0, 'st-' + st[0])}
            <div class="dm-card-n"><b class="dm-pct">${pc(v.p)}<small>%</small></b>
              <span class="dm-ml">${n0(v.v)} <small>/ ${n0(v.f)} ML</small></span>
              <span class="dm-tr ${tr}">${v.w == null ? '' : `${arrow(tr)} ${v.w > 0 ? '+' : ''}${v.w.toFixed(1)} <small>7 d</small>`}</span>
              <span class="dm-st">${esc(st[1])}</span></div></div>
          <div class="dm-bar"><i style="width:${Math.min(100, v.p || 0)}%"></i></div>
          ${spark(v.s, 160, 30)}
          <div class="dm-tip" role="tooltip"><b>${esc(x.name)} Dam</b> · ${esc(x.lake)}<br>
            ${n0(v.v)} ML of ${n0(v.f)} ML full supply<br>
            Observed ${hhmm(v.t)} · ${v.dv == null ? '' : `${v.dv > 0 ? '+' : ''}${n0(v.dv)} ML since yesterday`}<br>
            ${v.fu != null ? `Flood storage in use: ${pc(v.fu)}%<br>` : ''}
            ${gi ? `Inflow ${esc(x.in[1])}: ${gi.q != null ? `${gi.q} m³/s` : '--'}, ${gi.h} m<br>` : ''}
            ${go ? `Outflow ${esc(x.out[1])}: ${go.q != null ? `${go.q} m³/s` : '--'}, ${go.h} m<br>` : ''}
            ${v.c ? `<i>Seqwater: ${esc(v.c)}</i><br>` : ''}<span class="dim">Click for river flows</span></div>
        </button>`;
      }).join('');
      settle($('#page-dams'));
    }

    function chan(q, dir) {   // a river channel; faster flow = shorter animation (4 runs, then still)
      const s = q == null ? 0 : Math.max(0.5, Math.min(6, 3.2 - Math.log10(Math.max(q, 0.001)) * 0.9));
      return `<div class="dm-chan ${q == null ? 'dry' : ''} ${dir}"><i style="--dur:${s.toFixed(2)}s"></i></div>`;
    }
    function gauge(g, label, role) {
      if (!label) return `<div class="dm-g none"><span class="dm-g-k">${role}</span><span class="dim small">No gauge</span></div>`;
      if (!g) return `<div class="dm-g none"><span class="dm-g-k">${role}</span><b class="small">${esc(label[1])}</b><span class="dim small">No data in this answer</span></div>`;
      const [v, u] = flowFmt(g.q), qt = g.qt || [], tr = qt.length > 1 ? trendOf(qt[0], qt[qt.length - 1], Math.max(0.005, qt[0] * 0.1)) : '';
      return `<div class="dm-g ${g.q != null && surging(g) ? 'surge' : ''}" title="WMIP ${label[0]} · ${esc(label[1])} · ${hhmm(g.t)}">
        <span class="dm-g-k">${role} · ${label[0]}</span><b class="small">${esc(label[1])}</b>
        <div class="dm-g-v"><b>${v}</b><small>${u}</small><span class="dm-tr ${tr}">${tr ? arrow(tr) : ''}</span></div>
        <span class="dm-g-h">River height <b>${g.h != null ? g.h.toFixed(2) : '--'} m</b> · ${hhmm(g.t)}</span>
        ${spark(qt, 140, 26, 'q')}</div>`;
    }
    function renderRivers(d) {
      const sel = S.sel;
      $('#dm-rivers').innerHTML = DAMS.map(x => {
        const v = d.d[x.k] || {}, st = damStatus(x, d.d[x.k], d);
        const gi = x.in && d.r && d.r[x.in[0]], go = x.out && d.r && d.r[x.out[0]];
        return `<div class="dm-river st-${st[0]}${sel === x.k ? ' sel' : ''}" id="dm-rv-${x.k}">
          <div class="dm-river-h"><h3>${esc(x.name)} <small>${esc(x.river)}</small></h3><span class="tag ${st[0] === 'ok' || st[0] === 'full' ? 'ok' : st[0] === 'none' ? '' : 'warn'}">${esc(st[1])}</span></div>
          <div class="dm-river-b">${gauge(gi, x.in, 'Inflow')}${chan(gi ? gi.q : null, 'in')}
            <div class="dm-mini"><b>${pc(v.p)}%</b><span>${esc(x.gated ? 'Gated spillway' : 'Un-gated spillway')}</span>
              <span class="dm-dv ${v.dv > 0 ? 'up' : v.dv < 0 ? 'down' : ''}">${v.dv == null ? '' : `${v.dv > 0 ? '+' : ''}${n0(v.dv)} ML/day net`}</span></div>
            ${chan(go ? go.q : null, 'out')}${x.out ? gauge(go, x.out, 'Outflow') : `<div class="dm-g none"><span class="dm-g-k">Outflow</span><span class="dim small">${esc(x.outNote || 'No gauge')}</span></div>`}</div>
        </div>`;
      }).join('');
      // storage change, diverging bars: + = the dam gained water since yesterday
      const rows = DAMS.map(x => [x, d.d[x.k] && d.d[x.k].dv]).filter(r => r[1] != null), max = Math.max(1, ...rows.map(r => Math.abs(r[1])));
      $('#dm-dv').innerHTML = rows.map(([x, dv]) => `<div class="dm-dvrow"><span>${esc(x.name)}</span><div class="dm-dvbar"><i class="${dv < 0 ? 'neg' : 'pos'}" style="--w:${(Math.abs(dv) / max * 50).toFixed(1)}%"></i></div>`
        + `<b class="${dv < 0 ? 'down' : dv > 0 ? 'up' : ''}">${dv > 0 ? '+' : ''}${n0(dv)}<small> ML</small></b></div>`).join('');
      // every gauge, biggest flow first
      const gs = DAMS.flatMap(x => [[x, x.in, 'in'], [x, x.out, 'out']]).filter(r => r[1] && d.r && d.r[r[1][0]]).map(r => [...r, d.r[r[1][0]]]).sort((a, b) => (b[3].q || 0) - (a[3].q || 0));
      $('#dm-gauges').innerHTML = gs.length ? `<table class="dm-tbl"><tr><th>Gauge</th><th>Dam</th><th>Height</th><th>Flow</th><th>24 h</th></tr>${gs.map(([x, l, io, g]) => {
        const [v, u] = flowFmt(g.q), qt = g.qt || [], tr = qt.length > 1 ? trendOf(qt[0], qt[qt.length - 1], Math.max(0.005, qt[0] * 0.1)) : '';
        return `<tr><td><b>${esc(l[1])}</b><br><span class="dim small mono">${l[0]}</span></td><td>${esc(x.name)} <span class="dim small">${io === 'in' ? 'inflow' : 'outflow'}</span></td>`
          + `<td class="mono">${g.h != null ? g.h.toFixed(3) : '--'} m</td><td class="mono"><b>${v}</b> ${u}</td><td><span class="dm-tr ${tr}">${tr ? arrow(tr) : ''}</span> ${spark(qt, 80, 18, 'q')}</td></tr>`; }).join('')}</table>`
        : `<p class="dim small">${d.rerr ? `WMIP did not answer the gateway: ${esc(d.rerr)}` : 'No river gauges in this answer.'}</p>`;
    }

    // ------------------------------------------------------------------ the packet stream
    function lamps() {
      const d = S.d, now = Date.now(), rx = S.ask && !S.ask.demo && k.rfRx();
      const ageH = d && d.t ? (now - new Date(d.t).getTime()) / 3600e3 : null;
      const L = [
        ['LINK', k.radioConnected() ? 'on' : 'off', k.radioConnected() ? (k.demo() ? 'Demo radio' : 'Radio connected') : 'Radio offline'],
        ['TX', S.ask && S.ask.phase === 'asking' ? 'tx' : now - S.txAt < 1800 ? 'tx' : 'off', S.ask && S.ask.phase === 'asking' ? 'Sending the request' : 'Request out'],
        ['RX', rx || (S.ask && S.ask.demo && S.ask.phase === 'gateway') ? 'rx' : now - S.rxAt < 1800 ? 'rx' : 'off', rx ? `${rx.chunks.size}/${rx.info ? rx.info.nchunks : '?'} chunks` : 'Answer in'],
        ['GW', S.err ? 'err' : d ? 'on' : 'off', S.err ? 'Gateway error' : d ? 'Gateway answered' : 'No answer yet'],
        ['DATA', ageH == null ? 'off' : ageH < 2 ? 'on' : ageH < 6 ? 'warn' : 'err', ageH == null ? 'No data' : `Observed ${ageH < 1 ? `${Math.round(ageH * 60)} min` : `${ageH.toFixed(1)} h`} ago`],
        ['WMIP', !d ? 'off' : d.rerr ? 'err' : 'on', !d ? 'Rivers' : d.rerr ? 'WMIP failed' : `${Object.keys(d.r || {}).length} river gauges`],
      ];
      $('#dm-lamps').innerHTML = L.map(([n, c, t]) => `<div class="dm-lamp ${c}" title="${esc(t)}"><i></i><b>${n}</b><small>${esc(t)}</small></div>`).join('');
      // signal meters: the radio's own RSSI when it reports one; SNR only exists in the simulator
      const rssi = S.sim.on ? S.sim.rssi : k.rssi(), snr = S.sim.on ? S.sim.snr : null;
      const bar = (v, lo, hi) => (v == null ? 0 : Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)));
      $('#dm-meters').innerHTML = `<div class="dm-meter"><span>RSSI${S.sim.on ? ' <em>sim</em>' : ''}</span><div><i style="width:${bar(rssi, -125, -50)}%"></i></div><b>${rssi == null ? '--' : `${Math.round(rssi)} dBm`}</b></div>`
        + `<div class="dm-meter"><span>SNR${S.sim.on ? ' <em>sim</em>' : ''}</span><div><i style="width:${bar(snr, 0, 35)}%"></i></div><b>${snr == null ? '--' : `${snr.toFixed(1)} dB`}</b></div>`
        + `<div class="dm-meter"><span>Air</span><div><i style="width:${d && d.air && d.air.bytes ? Math.min(100, d.air.bytes / 10) : 0}%"></i></div><b>${d && d.air && d.air.bytes ? `${d.air.bytes} B${d.air.secs ? ` · ${d.air.secs.toFixed(1)} s` : ''}` : '--'}</b></div>`;
    }
    function hexDump(hex) {   // the KF container: magic, version, kind, method, size, CRC-32, then deflate
      if (!hex) return '<p class="dim small">No real answer received yet -- the demo radio sends nothing over the air. Connect a radio and press Refresh to see the actual bytes.</p>';
      const b = hex.match(/../g), cls = i => (i < 2 ? 'mg' : i === 2 ? 'vr' : i === 3 ? 'kd' : i === 4 ? 'mt' : i < 9 ? 'sz' : i < 13 ? 'crc' : 'zb');
      let out = '';
      for (let r = 0; r < Math.min(b.length, 160); r += 16) {
        const row = b.slice(r, r + 16);
        out += `<div><span class="off">${r.toString(16).padStart(4, '0')}</span>${row.map((x, i) => `<i class="${cls(r + i)}">${x}</i>`).join('')}`
          + `<span class="asc">${row.map(x => { const c = parseInt(x, 16); return c >= 32 && c < 127 ? esc(String.fromCharCode(c)) : '·'; }).join('')}</span></div>`;
      }
      return out + (b.length > 160 ? `<div class="dim small">… ${b.length - 160} more bytes</div>` : '');
    }
    function records(d) {   // the answer, one telemetry line per station
      const f = (v, w, dp = 1) => (v == null ? '-'.repeat(w) : (+v).toFixed(dp).padStart(w, '0'));
      return DAMS.map(x => {
        const v = d.d[x.k]; if (!v) return '';
        const gi = x.in && d.r && d.r[x.in[0]], go = x.out && d.r && d.r[x.out[0]];
        return `<div class="dm-rec"><b>${x.stn}</b> <span class="c1">LVL ${f(v.p, 5)}%</span> <span class="c2">VOL ${String(v.v).padStart(7, '0')}ML</span> `
          + `<span class="c3">Δ7D ${v.w == null ? '--' : (v.w > 0 ? '+' : '') + v.w.toFixed(1)}</span> <span class="c4">IN ${gi ? f(gi.q, 7, 3) : '-------'}</span> `
          + `<span class="c5">OUT ${go ? f(go.q, 7, 3) : '-------'}</span> <span class="c6">OBS ${hhmm(v.t)}</span>${v.sp ? ' <span class="c7">SPILL</span>' : ''}</div>`;
      }).join('');
    }

    // The simulator: per-station telemetry frames as a dam's own P25 data terminal might send them. Synthetic -- built
    // from the last real reading plus noise, with made-up battery, solar, RSSI and SNR -- and badged SIMULATED throughout.
    // Frame: ver 02 | station | seq | flags | height mm u16 | storage ML/10 u24 | battery cV u16 | solar cV u16 | CRC-16/CCITT
    function crc16(bytes) { let c = 0xFFFF; for (const b of bytes) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c; }
    function simFrame() {
      const d = S.d || DEMO, now = new Date(), x = DAMS[Math.floor(Math.random() * DAMS.length)], v = (d.d && d.d[x.k]) || {};
      const g = (x.in && d.r && d.r[x.in[0]]) || (x.out && d.r && d.r[x.out[0]]) || null;
      const hr = now.getHours() + now.getMinutes() / 60, sun = Math.max(0, Math.sin((hr - 5.5) / 13 * Math.PI));
      const h = g && g.h != null ? g.h + (Math.random() - 0.5) * 0.004 : null, vol = v.v != null ? v.v + Math.round((Math.random() - 0.5) * 40) : null;
      const batt = 12.6 + sun * 1.2 + (Math.random() - 0.5) * 0.08, solar = sun * 19.5 + (sun ? (Math.random() - 0.5) * 0.6 : 0);
      const rssi = -78 - DAMS.indexOf(x) * 4.5 + (Math.random() - 0.5) * 8, snr = Math.max(2, (rssi + 122) * 0.62 + (Math.random() - 0.5) * 3);
      const seq = (S.sim.seq = (S.sim.seq + 1) & 0xFF), hmm = h == null ? 0xFFFF : Math.round(h * 1000), v10 = vol == null ? 0xFFFFFF : Math.round(vol / 10);
      const by = [0x02, DAMS.indexOf(x) + 1, seq, (v.sp ? 1 : 0) | (g ? 2 : 0), hmm >> 8, hmm & 255, (v10 >> 16) & 255, (v10 >> 8) & 255, v10 & 255,
        Math.round(batt * 100) >> 8, Math.round(batt * 100) & 255, Math.round(solar * 100) >> 8, Math.round(solar * 100) & 255];
      let crc = crc16(by); const bad = Math.random() < 0.06 + Math.max(0, -95 - rssi) * 0.02;
      if (bad) crc ^= 0x5A3C;   // a frame hit by a fade: its CRC won't check
      by.push(crc >> 8, crc & 255);
      S.sim.rssi = rssi; S.sim.snr = snr; bad ? S.sim.bad++ : S.sim.ok++;
      return { at: Date.now(), x, seq, rssi, snr, h, vol, batt, solar, bad, hex: by.map(b => b.toString(16).padStart(2, '0')) };
    }
    function simStep() {
      clearTimeout(S.sim.t);
      if (!S.sim.on) return;
      if (Date.now() > S.sim.until) { simStop(); return; }
      S.sim.rows.unshift(simFrame());
      if (S.sim.rows.length > 30) S.sim.rows.length = 30;
      renderSim(true);
      lamps();
      S.sim.t = setTimeout(simStep, 900 + Math.random() * 1600);
    }
    function simStart() { Object.assign(S.sim, { on: true, until: Date.now() + SIM_MS, ok: 0, bad: 0 }); simStep(); dirty('dams'); }
    function simStop() { S.sim.on = false; clearTimeout(S.sim.t); S.sim.rssi = S.sim.snr = null; renderSim(false); dirty('dams'); }
    function renderSim(added) {
      const el = $('#dm-sim'); if (!el) return;
      const left = Math.max(0, Math.ceil((S.sim.until - Date.now()) / 1000));
      $('#dm-sim-go').textContent = S.sim.on ? `■ Stop (${left} s)` : '▶ Run simulator · 60 s';
      $('#dm-sim-go').classList.toggle('on', S.sim.on);
      $('#dm-sim-stats').textContent = S.sim.ok + S.sim.bad ? `${S.sim.ok + S.sim.bad} frames · ${S.sim.bad} CRC fail · ${Math.round(S.sim.ok / (S.sim.ok + S.sim.bad) * 100)}% good` : '';
      const F = ['ver', 'stn', 'seq', 'flg', 'hgt', 'hgt', 'vol', 'vol', 'vol', 'bat', 'bat', 'sol', 'sol', 'crc', 'crc'];
      el.innerHTML = S.sim.rows.length ? S.sim.rows.map((f, i) => `<div class="dm-frame${f.bad ? ' bad' : ''}${added && i === 0 ? ' new' : ''}">
          <span class="t">${new Date(f.at).toLocaleTimeString([], { hour12: false })}</span><b>${f.x.stn}-TLM</b>
          <span class="hx">${f.hex.map((b, j) => `<i class="${F[j]}">${b}</i>`).join('')}</span>
          <span class="dec">${f.h == null ? 'H ----' : `H ${f.h.toFixed(3)} m`} · V ${f.vol == null ? '--' : n0(f.vol)} ML · B ${f.batt.toFixed(2)} V · S ${f.solar.toFixed(1)} V</span>
          <span class="sig">${Math.round(f.rssi)} dBm · ${f.snr.toFixed(1)} dB</span><span class="crc">${f.bad ? 'CRC ✗' : 'CRC ✓'}</span></div>`).join('')
        : '<p class="dim small">Press Run to watch simulated telemetry frames from a station at each dam -- how a P25 data terminal at the wall could report on its own. Built from the last real reading plus noise; battery, solar, RSSI and SNR are made up.</p>';
    }

    // ------------------------------------------------------------------ render
    function render() {
      if (!$('#page-dams')) return;
      const a = S.ask, d = S.d, rx = a && !a.demo && k.rfRx(), ev = every();
      $('#dm-read').disabled = !!a || k.rfBusy();
      $('#dm-every').value = String(ev);
      $$('#dm-unit button').forEach(b => b.classList.toggle('on', b.dataset.u === unit()));
      $('#dm-phase').textContent = a ? `${k.chanBusy() ? 'Channel in use -- waiting. ' : ''}${rx ? `On its way… ${rx.chunks.size}/${rx.info ? rx.info.nchunks : '?'} chunks`
        : a.phase === 'gateway' ? 'The gateway has it -- reading Seqwater and WMIP…' : 'Asking the P25X gateway…'}`
        : !k.radioConnected() ? (d ? 'Offline -- showing the last reading. Connect the radio to refresh.' : 'Offline -- connect the radio, then press Refresh.')
        : ev ? `Refreshes every ${ev} min while this page is open` : 'Auto refresh off';
      $('#dm-err').textContent = S.err; $('#dm-err').hidden = !S.err;
      $('#page-dams').classList.toggle('dm-empty', !d);
      lamps();
      renderSim(false);
      if (!d) { $('#dm-when').textContent = ''; return; }
      const ageH = d.t ? (Date.now() - new Date(d.t).getTime()) / 3600e3 : 0;
      $('#dm-when').innerHTML = `Seqwater ${hhmm(d.t)}${ageH > 6 || d.stale ? ' <span class="tag warn">delayed</span>' : ''}`;
      const air = d.air || {};
      $('#dm-note').textContent = `${air.bytes ? `${air.bytes} B over P25` : 'Demo data (a real answer from 18 Oct 2026)'}${air.secs ? ` in ${air.secs.toFixed(1)} s` : ''} · received ${fmtAgo(d.got)}`
        + `${d.herr ? ` · no history (${d.herr})` : ''}${d.rerr ? ` · no rivers (${d.rerr})` : ''} · Data: Seqwater dam levels (automated, unverified); river gauges © State of Queensland (DLGWV, WMIP), CC BY 4.0`;
      if (S.drawn === d.got && S.drawnUnit === unit()) return;   // same reading: don't rebuild (and replay) anything
      const fresh = S.drawn !== d.got;
      S.drawn = d.got; S.drawnUnit = unit();
      if (fresh) renderOverview(d);
      renderRivers(d);
      $('#dm-records').innerHTML = records(d);
      $('#dm-hex').innerHTML = hexDump(S.hex && d.air && d.air.bytes ? S.hex : null);
      $('#dm-size').textContent = d.air && d.air.bytes ? `${d.air.bytes} B packed · ${S.hex ? S.hex.length / 2 : 0} B shown as hex` : '';
      if (fresh) { S.prev = {}; }
    }
    function shown() { unCalm(); setTimeout(autoTick, 500); dirty('dams'); }

    function init() {
      $('#dm-read').onclick = () => ask(false);
      $('#dm-every').onchange = () => { settings.damsEvery = +$('#dm-every').value; saveSoon('settings'); autoTick(); };
      $('#dm-unit').onclick = e => { const b = e.target.closest('[data-u]'); if (!b) return; settings.damsUnit = b.dataset.u; saveSoon('settings'); dirty('dams'); };
      $('#dm-sim-go').onclick = () => (S.sim.on ? simStop() : simStart());
      $('#dm-cards').onclick = e => {   // a dam card -> its rivers
        const c = e.target.closest('[data-dam]'); if (!c) return;
        S.sel = c.dataset.dam; S.drawnUnit = null;
        $('[data-tabs="dams"] [data-tab="rivers"]').click();
        setTimeout(() => { const el = $('#dm-rv-' + S.sel); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
      };
      if (S.d) S.prev = {};   // the stored reading fills from empty the first time the page shows
    }
    return { init, render, shown, gatewayReply, kfEvent, ownsXid: xid => !!(S.ask && S.ask.xid === xid) };
  };
})();
