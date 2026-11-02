/* Kelly Page -- Wivenhoe pumped-storage SCADA trainer: the DNP3 Demo page's second plant (window.KellyWivenhoeUI).
 * A TRAINING SIMULATION inspired by Wivenhoe Power Station -- not affiliated with its operator, figures approximate.
 *
 * Files: js/wivenhoe.js (plant model, point list, demo sequencer, challenges -- pure), js/scadakit.js (everything the
 *        trainers share: roles, link, master/outstation, inspector, points, alarms, challenges, settings), this file
 *        (the mimic, the operator panel and the plant's hooks), css/wivenhoe.css, tests/wivenhoe-tests.html.
 * Roles: both = master + outstation in this page over the simulated link (default); master = this Kelly is the
 *        control room, the plant is "far away" and drawn only from DNP3; outstation = this Kelly is the RTU at the
 *        station (in simulation a background master stands in for the control room). Link: simulated P25, or the
 *        real radio (parked TM9100 in Transparent, as the substation's RF modes) for master or outstation.
 * Motion: turbines and flow particles move only while water moves, through k.fxLoop at ~20 fps, and stop when the
 *        page is hidden; new alarms flash 3 times then stay steady (kelly-page/CLAUDE.md, 2026-10-20).
 *        Sound is muted until the user unmutes it; the turbine hum + water rush are a separate opt-in.
 *
 * window.KellyWivenhoeUI(ctx) -> { init, render, shown, hidden, active, claimRf }
 */
(function () {
  'use strict';
  const W = window.Wivenhoe;
  const UPPER = { x0: 60, x1: 392, top: 112, bot: 232 }, LOWER = { x0: 890, x1: 1192, top: 372, bot: 524 };
  const LOW_BAND = [50, 85];   // the lower lake is drawn over 50-85 % (exaggerated: it barely moves)
  const RX = { u1: [655, 447], u2: [735, 447] };

  // ------------------------------------------------------------------ the mimic (static SVG; paint + frame animate it)
  function mimic() {
    const blades = Array.from({ length: 7 }, (_, i) => `<path d="M0 0 C8 -6 16 -14 20 -24" transform="rotate(${i * 360 / 7})"/>`).join('');
    const runner = (id, [x, y], n) => `<g class="wv-unit" data-u="${n}"><circle class="casing" cx="${x}" cy="${y}" r="31"/><g transform="translate(${x} ${y})"><g class="runner" data-run="${n}">${blades}<circle r="6"/></g></g>
      <text class="lab" x="${x}" y="${y + 47}" text-anchor="middle">UNIT ${n}</text>${n === 1 ? `<text class="val" data-v="u1mw" x="${x + 14}" y="${y + 64}" text-anchor="end"></text><text class="chip" data-v="u1st" x="${x + 14}" y="${y - 38}" text-anchor="end"></text>`
        : `<text class="val" data-v="u2mw" x="${x - 14}" y="${y + 64}" text-anchor="start"></text><text class="chip" data-v="u2st" x="${x - 14}" y="${y - 38}" text-anchor="start"></text>`}</g>`;
    const cb = (id, x, y, label) => `<g class="sk-cb" data-cb="${id}" transform="translate(${x} ${y})" tabindex="0"><rect class="hit" x="-26" y="-22" width="52" height="40"/><circle cx="-18" cy="0" r="3.5"/><circle cx="18" cy="0" r="3.5"/><line class="blade" x1="-18" y1="0" x2="18" y2="0"/><text class="lab" x="0" y="-12" text-anchor="middle">${label}</text></g>`;
    return `<svg class="sk-mimic wv-mimic" viewBox="0 0 1200 560" role="img" aria-label="Wivenhoe pumped storage mimic: upper reservoir, penstock, underground power station, lower lake and grid connection">
      <defs>
        <linearGradient id="wv-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1a3a"/><stop offset="1" stop-color="#050912"/></linearGradient>
        <linearGradient id="wv-water" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1fb6ff"/><stop offset="1" stop-color="#0a3d7a"/></linearGradient>
        <clipPath id="wv-upclip"><path d="M${UPPER.x0} ${UPPER.top} Q90 ${UPPER.bot + 8} 210 ${UPPER.bot} L370 ${UPPER.bot} L${UPPER.x1} ${UPPER.top} Z"/></clipPath>
        <clipPath id="wv-lowclip"><path d="M${LOWER.x0} ${LOWER.top} Q930 ${LOWER.bot} 1020 ${LOWER.bot} L1192 ${LOWER.bot} L${LOWER.x1} ${LOWER.top} Z"/></clipPath>
        <pattern id="wv-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" fill="rgba(5,9,18,.55)"/><line x1="0" y1="0" x2="0" y2="10" stroke="rgba(131,148,184,.35)" stroke-width="3"/></pattern>
      </defs>
      <rect width="1200" height="560" fill="url(#wv-sky)"/>
      <path class="terrain" d="M0 560 L0 150 Q60 100 140 98 L420 104 Q500 120 560 230 Q640 360 820 366 L1200 366 L1200 560 Z"/>
      <path class="rock" d="M560 380 Q640 372 820 380 L820 520 L560 520 Z"/>
      <!-- upper reservoir: Splityard Creek -->
      <g clip-path="url(#wv-upclip)"><rect class="water" data-w="up" x="${UPPER.x0}" y="${UPPER.bot}" width="${UPPER.x1 - UPPER.x0}" height="0"/></g>
      <path class="basin" d="M${UPPER.x0} ${UPPER.top} Q90 ${UPPER.bot + 8} 210 ${UPPER.bot} L370 ${UPPER.bot} L${UPPER.x1} ${UPPER.top}"/>
      <path class="dam" d="M${UPPER.x1 - 4} ${UPPER.top - 10} L${UPPER.x1 + 12} ${UPPER.top - 10} L${UPPER.x1 + 34} ${UPPER.bot + 10} L${UPPER.x1 - 8} ${UPPER.bot + 10} Z"/>
      <text class="lab" x="70" y="88">SPLITYARD CREEK DAM <tspan class="dim">upper reservoir</tspan></text>
      <text class="big" data-v="up" x="220" y="180" text-anchor="middle"></text>
      <path class="limit hi" d="M${UPPER.x0 + 4} ${UPPER.bot - 1.2 * W.C.HI_ON} H${UPPER.x1 - 4}"/><path class="limit lo" d="M${UPPER.x0 + 30} ${UPPER.bot - 1.2 * W.C.LO_ON} H${UPPER.x1 - 20}"/>
      <!-- penstock + tailrace (flow particles ride these paths) -->
      <path class="tunnel" d="M372 226 C460 250 540 330 640 432"/><path class="tunnel-in" data-path="pen" d="M372 226 C460 250 540 330 640 432"/>
      <path class="tunnel" d="M770 450 C840 452 880 476 960 486"/><path class="tunnel-in" data-path="tail" d="M770 450 C840 452 880 476 960 486"/>
      <g data-parts="pen"></g><g data-parts="tail"></g>
      <text class="val" data-v="flow" x="470" y="330" text-anchor="end"></text>
      <!-- underground power station -->
      <rect class="cavern" x="600" y="396" width="190" height="104" rx="12"/>
      <text class="lab" x="695" y="389" text-anchor="middle">UNDERGROUND POWER STATION</text>
      ${runner('u1', RX.u1, 1)}${runner('u2', RX.u2, 2)}
      <!-- lower reservoir: Lake Wivenhoe -->
      <g clip-path="url(#wv-lowclip)"><rect class="water" data-w="low" x="${LOWER.x0}" y="${LOWER.bot}" width="${LOWER.x1 - LOWER.x0}" height="0"/></g>
      <path class="basin" d="M${LOWER.x0} ${LOWER.top} Q930 ${LOWER.bot} 1020 ${LOWER.bot} L1192 ${LOWER.bot} L${LOWER.x1} ${LOWER.top}"/>
      <text class="lab" x="1192" y="548" text-anchor="end">LAKE WIVENHOE <tspan class="dim">lower · level drawn exaggerated</tspan></text>
      <text class="big" data-v="low" x="1080" y="455" text-anchor="middle"></text>
      <!-- electrical: unit cables up the shaft, generator breaker, station bus, grid breaker, transformer, 275 kV line -->
      <path class="el" data-el="shaft" d="M695 396 V170 H730"/>
      ${cb('gencb', 760, 170, 'GEN CB')}
      <path class="el" data-el="bus" d="M778 170 H882"/>
      <text class="lab dim" x="830" y="194" text-anchor="middle">STATION BUS</text>
      ${cb('gridcb', 900, 170, 'GRID CB')}
      <path class="el" data-el="hv" d="M918 170 H952"/>
      <g class="xf"><circle class="el" data-el="hv" cx="966" cy="170" r="14"/><circle class="el" data-el="hv" cx="986" cy="170" r="14"/></g>
      <path class="el" data-el="aux" d="M936 170 V212"/><g class="aux"><rect x="900" y="212" width="72" height="34" rx="6"/><text class="lab" x="936" y="226" text-anchor="middle">AUX</text><text class="val" data-v="batt" x="936" y="240" text-anchor="middle"></text></g>
      <path class="tl" data-tl="1" d="M1000 170 Q1040 140 1080 112 Q1130 96 1196 92"/>
      <path class="pylon" d="M1080 112 L1068 166 M1080 112 L1092 166 M1072 140 H1088 M1066 118 H1094"/>
      <text class="lab" x="1196" y="80" text-anchor="end">275 kV · TO GRID</text>
      <text class="val" data-v="grid" x="1196" y="128" text-anchor="end"></text>
      <text class="big" data-v="total" x="790" y="250" text-anchor="middle"></text><text class="lab dim" data-v="totlab" x="790" y="270" text-anchor="middle"></text>
      <!-- stale overlay + banner -->
      <g class="stale" data-stale><rect width="1200" height="560" fill="url(#wv-hatch)"/><rect class="sbox" x="380" y="16" width="440" height="44" rx="10"/><text class="stxt" data-v="stale" x="600" y="44" text-anchor="middle"></text></g>
      <text class="badge" x="12" y="552">TRAINING SIMULATION · figures approximate · not affiliated with the station's operator</text>
    </svg>`;
  }

  // ------------------------------------------------------------------ operator panel (inside the kit's Operator tab)
  function opHtml() {
    const unitCard = n => `<div class="card wv-ucard" data-unit="${n}"><div class="card-h"><h2>Unit ${n}</h2><span class="wv-state" id="wv-u${n}-st"></span></div>
      <div class="sk-mw"><b id="wv-u${n}-mw"></b><span>MW</span></div>
      <div class="row gap wrap"><button class="btn primary" data-cmd="u${n}.gen">⚡ Start generating</button><button class="btn" data-cmd="u${n}.pump">💧 Start pumping</button><button class="btn ghost" data-cmd="u${n}.stop">■ Stop</button></div>
      <label class="sk-sl"><span>MW setpoint <b id="wv-ao${n - 1}-v"></b></span><input type="range" id="wv-ao${n - 1}" min="${W.C.UNIT_MIN}" max="${W.C.UNIT_MAX}" step="5"></label>
      <button class="btn small" data-sp="${n - 1}">Send setpoint (AO300${n})</button><p class="dim small" id="wv-u${n}-note"></p></div>`;
    return `<div class="wv-units">${unitCard(1)}${unitCard(2)}
        <div class="card"><div class="card-h"><h2>Breakers</h2></div>
          <div class="sk-brk"><span>Generator breaker <b id="wv-gencb"></b></span><button class="btn small" data-cmd="gencb.close">Close</button><button class="btn small ghost" data-cmd="gencb.open">Trip</button></div>
          <div class="sk-brk"><span>Grid breaker <b id="wv-gridcb"></b></span><button class="btn small" data-cmd="gridcb.close">Close</button><button class="btn small ghost" data-cmd="gridcb.open">Trip</button></div>
          <div class="sk-estop"><button class="sk-ebtn" data-cmd="estop" aria-label="Emergency stop">E-STOP</button><button class="btn small" data-cmd="estop.reset">Reset E-stop</button></div>
          <p class="dim small" id="wv-opnote"></p>
        </div>
      </div>`;
  }

  window.KellyWivenhoeUI = function (k) {
    const plant = new W.Plant({ accel: 120 });
    return window.KellyScadaKit(k, {
      key: 'wiv', prefix: 'wv', cfgKey: 'wiv', model: W, plant, defaults: { time: 'demo10' },
      title: '💧 Wivenhoe pumped storage <span class="dim small">SCADA trainer</span>',
      simTag: 'TRAINING SIMULATION · not affiliated with the station\'s operator · figures approximate',
      intro: 'Splityard Creek Dam on the hill, Lake Wivenhoe below, two reversible pump-turbines in a cavern between them. Pump water uphill when power is cheap, let it back down through the turbines when Queensland needs it -- and run the whole station over DNP3 on a P25 radio link, the way a real RTU in the bush is run.',
      psndLabel: 'turbine + water sound', mimic, opHtml,
      rfNote: role => (role === 'master' ? 'The outstation must be another Kelly running this station (needs the gateway\'s DNP3 forwarder) -- the NUC\'s DNP3 MASTER page only knows a breaker on BI 0 / BO 0.'
        : 'Any DNP3 master on the network can poll this RTU; the NUC dashboard\'s DNP3 MASTER page will see the binary inputs; its BO 0 is BO2001 Unit 1 Start Pumping here (CLOSE starts it, TRIP is a format error).'),
      hooks: api => hooks(api, k, plant),
    });
  };

  function hooks(api, k, plant) {
    const { st, q, play, soe } = api, $ = k.$;
    const M = {};   // mimic nodes
    const disp = { up: null, low: null }, ang = [0, 0], ph = { pen: 0, tail: 0 };
    let target = null;

    function placeWater() {
      const uy = UPPER.bot - (UPPER.bot - UPPER.top) * Math.max(0, Math.min(100, disp.up)) / 100;
      const lf = (disp.low - LOW_BAND[0]) / (LOW_BAND[1] - LOW_BAND[0]), ly = LOWER.bot - (LOWER.bot - LOWER.top) * Math.max(0.03, Math.min(1, lf));
      M.wUp.setAttribute('y', uy.toFixed(1)); M.wUp.setAttribute('height', (UPPER.bot - uy + 4).toFixed(1));
      M.wLow.setAttribute('y', ly.toFixed(1)); M.wLow.setAttribute('height', (LOWER.bot - ly + 4).toFixed(1));
    }
    return {
      bind() {
        M.svg = $('#wv-mimic svg');
        M.v = {}; M.svg.querySelectorAll('[data-v]').forEach(n => { M.v[n.dataset.v] = n; });
        M.u = {}; M.svg.querySelectorAll('.wv-unit').forEach(n => { M.u[n.dataset.u] = n; });
        M.run = {}; M.svg.querySelectorAll('[data-run]').forEach(n => { M.run[n.dataset.run] = n; });
        M.cb = {}; M.svg.querySelectorAll('[data-cb]').forEach(n => { M.cb[n.dataset.cb] = n; });
        M.el = {}; M.svg.querySelectorAll('[data-el]').forEach(n => (M.el[n.dataset.el] = M.el[n.dataset.el] || []).push(n));
        M.paths = {}; M.svg.querySelectorAll('[data-path]').forEach(n => { M.paths[n.dataset.path] = { el: n, len: n.getTotalLength() }; });
        M.parts = {}; M.svg.querySelectorAll('[data-parts]').forEach(n => { M.parts[n.dataset.parts] = n; });
        M.tl = M.svg.querySelector('[data-tl]'); M.limits = Array.from(M.svg.querySelectorAll('.limit')); M.stale = M.svg.querySelector('[data-stale]');
        M.wUp = M.svg.querySelector('[data-w="up"]'); M.wLow = M.svg.querySelector('[data-w="low"]');
        M.svg.addEventListener('click', e => { const g = e.target.closest('[data-cb]'); if (g) { const v = api.curView(), cid = g.dataset.cb, closed = cid === 'gencb' ? v.genCB : v.gridCB; api.issue(`${cid}.${closed ? 'open' : 'close'}`); } });
        for (const n of [1, 2]) { const s = q('ao' + (n - 1)); s.value = plant.units[n - 1].sp; s.oninput = api.dirty; }
      },
      // plant events -> sounds + station log
      event(e) {
        const by = e.by === 'scada' ? ' (SCADA)' : e.by === 'protection' ? ' (protection)' : e.by === 'demo' ? ' (demo)' : '';
        if (e.type === 'unit') { soe(`Unit ${e.unit}: ${W.UNIT_STATES[e.state]}${by}${e.cause ? ' -- ' + e.cause : ''}`, e.by === 'protection' ? 'warn' : ''); }
        else if (e.type === 'breaker') { soe(`${e.id === 'gencb' ? 'Generator' : 'Grid'} breaker ${e.closed ? 'CLOSED' : 'OPENED'}${by}`, e.closed ? '' : 'warn'); play(e.closed ? 'clunk' : 'trip', e.closed ? 1 : 0.8); }
        else if (e.type === 'trip') { soe(`Unit ${e.unit} TRIPPED: ${e.cause}`, 'bad'); }
        else if (e.type === 'estop') { soe(e.on ? 'EMERGENCY STOP' + by : 'Emergency stop reset' + by, e.on ? 'bad' : ''); }
        else if (e.type === 'setpoint') soe(`Unit ${e.unit} setpoint ${e.mw} MW${by}`, '');
      },
      alarms(v, add) {
        if (v.estop) add('estop', 'EMERGENCY STOP active', 'bad');
        v.units.forEach(u => { if (!u.avail && !v.estop) add('na' + u.n, `Unit ${u.n} not available (tripped, locked out)`, 'bad'); });
        if (v.hi) add('hi', 'Upper reservoir HIGH level', 'warn');
        if (v.lo) add('lo', 'Upper reservoir LOW level', 'warn');
        if (!v.gridCB) add('grid', 'Grid breaker OPEN -- off-grid, auxiliaries on battery', 'warn');
        if (v.batt && v.batt < 115) add('batt', 'Station battery LOW', 'bad');
      },
      sound(v, on) { const fx = api.fx; if (!fx) return; const sp = Math.max(...v.units.map(u => u.speed)); fx.turbine(on, sp); fx.water(on, Math.min(1, Math.abs(v.flow) / 650)); },
      phaseText(seq) {
        const p = seq.phase();
        return `${p ? (p.phase === 'pump' ? '💧 pumping' : p.phase === 'gen' ? '⚡ generating' : '⏸ idle') : ''}${p && p.left != null ? ` · ${Math.ceil(p.left / 60)} min left` : ''}`;
      },
      localSetpoint(ao, value, by) { plant.setpoint(W.POINTS.ao[ao].unitNo, value, by); },
      reset() { plant.reset({ accel: plant.accel }); disp.up = null; return ['💧', 'Station reset', 'Both units idle, breakers closed, Splityard Creek at 50 %']; },

      // ---- drawing: static values (paint, ~4 Hz) ...
      paint(v, stale, frozen) {
        const tx = (key, s) => { const n = M.v[key]; if (n && n.textContent !== s) n.textContent = s; };
        tx('up', `${v.up.toFixed(1)} %`); tx('low', `${v.low.toFixed(2)} %`);
        tx('flow', Math.abs(v.flow) < 1 ? 'no flow' : `${Math.abs(v.flow).toFixed(0)} m³/s ${v.flow > 0 ? '▼ down' : '▲ up'}`);
        tx('batt', `${v.batt.toFixed(1)} V`); tx('grid', v.gridCB ? `${v.kv.toFixed(1)} kV · ${v.hz.toFixed(2)} Hz` : 'OFF-GRID');
        tx('total', `${v.total >= 0 ? '' : '−'}${Math.abs(v.total).toFixed(0)} MW`);
        tx('totlab', v.total > 5 ? 'EXPORTING to the grid' : v.total < -5 ? 'IMPORTING to pump' : 'idle');
        for (const u of v.units) {
          tx(`u${u.n}mw`, `${u.mw >= 0 ? '' : '−'}${Math.abs(u.mw).toFixed(0)} MW`);
          tx(`u${u.n}st`, !u.avail && u.state === 'stop' ? 'TRIPPED' : { stop: 'IDLE', 'pump-start': 'STARTING', pump: 'PUMPING', 'gen-start': 'STARTING', gen: 'GENERATING', stopping: 'STOPPING' }[u.state] || u.state);
          M.u[u.n].setAttribute('class', `wv-unit s-${u.state}${u.avail ? '' : ' na'}`);
        }
        M.cb.gencb.classList.toggle('closed', v.genCB); M.cb.gridcb.classList.toggle('closed', v.gridCB);
        const running = v.units.some(u => u.state !== 'stop');
        const live = { shaft: running, bus: v.gridCB || (v.genCB && running), hv: true, aux: v.gridCB };
        for (const [key, nodes] of Object.entries(M.el)) { const on = live[key]; nodes.forEach(n => n.classList.toggle('live', !!on)); }
        M.tl.setAttribute('class', `tl ${!v.gridCB ? 'dead' : v.total > 5 ? 'exp' : v.total < -5 ? 'imp' : 'live'}`);
        M.limits.forEach(n => n.classList.toggle('on', n.classList.contains('hi') ? v.hi : v.lo));
        M.stale.style.display = frozen ? '' : 'none';
        if (stale) tx('stale', stale);
        // a frozen SCADA picture doesn't move: no spinning or flowing on data the master can't vouch for
        target = { up: v.up, low: v.low, flow: frozen ? 0 : v.flow, units: v.units.map(u => ({ mw: u.mw, state: u.state, speed: frozen ? 0 : u.speed })) };
        if (disp.up == null) { disp.up = v.up; disp.low = v.low; placeWater(); }
      },
      // ... and motion (fxLoop): water levels ease, runners spin with speed (backwards when pumping), particles follow the flow
      frame(now, dt) {
        if (!M.svg || !target) return 400;
        const T = target, still = api.reduced();
        let moving = false;
        for (const key of ['up', 'low']) { const d = T[key] - disp[key]; if (Math.abs(d) > 0.002) { disp[key] += still ? d : d * Math.min(1, dt * 2.5); moving = true; } }
        placeWater();
        T.units.forEach((u, i) => {
          if (u.speed > 0.005 && !still) { const dir = u.state.startsWith('pump') ? -1 : 1; ang[i] = (ang[i] + dir * u.speed * 540 * dt) % 360; moving = true; M.run[i + 1].setAttribute('transform', `rotate(${ang[i].toFixed(1)})`); }
        });
        const fl = T.flow, flowing = Math.abs(fl) > 1 && !still;
        for (const pth of ['pen', 'tail']) {
          const g = M.parts[pth], P2 = M.paths[pth];
          if (!flowing) { if (g.childElementCount) g.textContent = ''; continue; }
          const n = Math.round(6 + 14 * Math.min(1, Math.abs(fl) / 650));
          if (g.childElementCount !== n) g.innerHTML = Array.from({ length: n }, () => '<circle r="3.2"/>').join('');
          ph[pth] = (ph[pth] + Math.sign(fl) * (0.05 + 0.25 * Math.min(1, Math.abs(fl) / 650)) * dt + 1) % 1;
          const len = P2.len;
          Array.from(g.children).forEach((c, j) => { const f = (ph[pth] + j / n) % 1, pt = P2.el.getPointAtLength(f * len); c.setAttribute('cx', pt.x.toFixed(1)); c.setAttribute('cy', pt.y.toFixed(1)); });
          moving = true;
        }
        return moving ? 50 : 400;
      },
      renderOp(v) {
        for (const u of v.units) {
          const s = $(`#wv-u${u.n}-st`); s.textContent = !u.avail && u.state === 'stop' ? 'TRIPPED' : W.UNIT_STATES[u.state]; s.className = `wv-state s-${u.state}${u.avail ? '' : ' na'}`;
          $(`#wv-u${u.n}-mw`).textContent = `${u.mw >= 0 ? '' : '−'}${Math.abs(u.mw).toFixed(0)}`;
          q(`ao${u.n - 1}-v`).textContent = q('ao' + (u.n - 1)).value + ' MW';
          $(`#wv-u${u.n}-note`).textContent = u.state === 'pump' ? 'Pumping is a fixed ~250 MW (single-speed pump): the setpoint only matters when generating.' : u.sp != null ? `Setpoint in the RTU: ${u.sp} MW` : '';
        }
        $('#wv-gencb').textContent = v.genCB ? 'CLOSED' : 'OPEN'; $('#wv-gencb').className = v.genCB ? 'good' : 'bad';
        $('#wv-gridcb').textContent = v.gridCB ? 'CLOSED' : 'OPEN'; $('#wv-gridcb').className = v.gridCB ? 'good' : 'bad';
      },
    };
  }
})();
