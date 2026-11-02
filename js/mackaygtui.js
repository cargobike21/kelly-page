/* Kelly Page -- Mackay gas turbine SCADA trainer: the DNP3 Demo page's third plant (window.KellyMackayGtUI).
 * A TRAINING SIMULATION inspired by the former Mackay Gas Turbine (decommissioned 2021) -- not affiliated with Stanwell;
 * engine figures are approximate and for education.
 *
 * Files: js/mackaygt.js (plant model, point list, fuel maths, demo cycle, challenges -- pure), js/scadakit.js (roles,
 *        link, master/outstation, inspector, points, alarms, challenges, settings -- shared with Wivenhoe), this file
 *        (the cutaway mimic + effects canvas, fuel strip, start progress, synchroscope, operator panel, instructor
 *        faults, Fuel / Engine / Facts tabs), css/mackaygt.css, tests/mackaygt-tests.html.
 * Motion: blades spin, flames glow and fuel flows only while the engine turns, through k.fxLoop at ~20 fps, and
 *        everything stops when the page is hidden or the SCADA picture is stale. Light-off fireball, black smoke on a
 *        trip and the CO2 fog are one-shot. Flame flicker is slow and small; the heat shimmer is OFF by default (a
 *        switch); prefers-reduced-motion stops flicker, shimmer, smoke and fireballs (kelly-page/CLAUDE.md).
 * Sound: muted until the user unmutes (kit); then the engine is LOUD -- starter whine, light-off whump, jet roar on
 *        N1/N2, generator hum, breaker clunks, synchroscope ticks speeding up near 12 o'clock, alarm horn, CO2 hiss.
 *
 * window.KellyMackayGtUI(ctx) -> { init, render, shown, hidden, active, claimRf }
 */
(function () {
  'use strict';
  const G = window.MackayGT, C = G.C, P = G.POINTS;
  const W = 1300, H = 620, AX = 300;   // viewBox, engine axis
  const fmt = (x, d = 0) => (x == null || !Number.isFinite(x) ? '--' : x.toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const n0 = x => (x == null || !Number.isFinite(x) ? 0 : x);

  // ------------------------------------------------------------------ the mimic: cutaway + single line + fuel system
  function mimic() {
    const glyph = (key, x, r, n = 7) => `<g class="gt-rot" transform="translate(${x} ${AX})"><circle class="hub" r="${r}"/><circle class="blur" r="${r - 3}"/><g data-rot="${key}">${Array.from({ length: n }, (_, i) => `<path d="M0 0 C${r * 0.3} -${r * 0.25} ${r * 0.55} -${r * 0.55} ${r * 0.62} -${r * 0.92}" transform="rotate(${i * 360 / n})"/>`).join('')}<circle r="${Math.max(3, r * 0.18)}"/></g></g>`;
    const stages = (x0, x1, n, top, bot, cls) => Array.from({ length: n }, (_, i) => { const x = x0 + (x1 - x0) * i / (n - 1); const k = i / (n - 1); return `<line class="stg ${cls}" x1="${x}" y1="${AX - top(k)}" x2="${x}" y2="${AX + top(k)}"/>`; }).join('');
    const can = (i, x, y) => `<g class="can" data-can="${i}" transform="translate(${x} ${y})"><rect class="cb" x="-8" y="-20" width="16" height="40" rx="7"/><path class="fl" d="M0 16 C-7 6 -5 -4 0 -16 C5 -4 7 6 0 16 Z"/><circle class="ig" r="3" cy="12"/></g>`;
    const cans = [0, 1, 2, 3].map(i => can(i, 357 + i * 20, AX - 50)).join('') + [4, 5, 6, 7].map(i => can(i, 357 + (i - 4) * 20, AX + 50)).join('');
    const cb = (id, x, y, label) => `<g class="sk-cb" data-cb="${id}" transform="translate(${x} ${y})" tabindex="0" role="button" aria-label="${label}"><rect class="hit" x="-26" y="-22" width="52" height="40"/><circle cx="-18" cy="0" r="3.5"/><circle cx="18" cy="0" r="3.5"/><line class="blade" x1="-18" y1="0" x2="18" y2="0"/><text class="lab" x="0" y="-12" text-anchor="middle">${label}</text></g>`;
    const house = (x, y, k) => `<g class="house" transform="translate(${x} ${y})"><path d="M0 18 V6 L11 -4 L22 6 V18 Z"/><rect class="win" x="5" y="8" width="5" height="5"/><rect class="win" x="13" y="8" width="5" height="5" style="--d:${k}"/></g>`;
    return `<svg class="sk-mimic gt-mimic" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mackay gas turbine mimic: air intake, Olympus gas generator with 8 combustor cans, free power turbine, exhaust stack, generator, breakers to the Mackay network, fuel storage and day tank">
      <defs>
        <linearGradient id="gt-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1430"/><stop offset="1" stop-color="#05080f"/></linearGradient>
        <linearGradient id="gt-fuelg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffcf5a"/><stop offset="1" stop-color="#b86a00"/></linearGradient>
        <linearGradient id="gt-hot" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff7a1a" stop-opacity=".0"/><stop offset=".5" stop-color="#ff7a1a" stop-opacity=".55"/><stop offset="1" stop-color="#ff3b1a" stop-opacity=".25"/></linearGradient>
        <radialGradient id="gt-flame" cx=".5" cy=".7" r=".6"><stop offset="0" stop-color="#e8f6ff"/><stop offset=".35" stop-color="#56b8ff"/><stop offset=".7" stop-color="#ff9a2a"/><stop offset="1" stop-color="#ff4d00" stop-opacity="0"/></radialGradient>
        <pattern id="gt-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" fill="rgba(5,9,18,.55)"/><line x1="0" y1="0" x2="0" y2="10" stroke="rgba(131,148,184,.35)" stroke-width="3"/></pattern>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#gt-sky)"/>
      <text class="gt-banner" data-v="banner" x="24" y="40"></text><text class="lab dim" data-v="sub" x="24" y="64"></text>
      <!-- enclosure -->
      <rect class="encl" data-encl x="140" y="${AX - 150}" width="600" height="300" rx="14"/>
      <text class="lab dim" x="152" y="${AX - 160}">TURBINE ENCLOSURE <tspan data-v="encl"></tspan></text>
      <g class="co2n">${[260, 440, 620].map(x => `<path d="M${x - 7} ${AX - 150} h14 l-7 10 z"/>`).join('')}</g>
      <g class="gt-fire" data-fire transform="translate(700 ${AX - 118})"><path d="M0 22 C-14 10 -8 -2 -2 -14 C0 -4 6 -2 6 -12 C14 0 14 14 0 22 Z"/><text class="lab" x="0" y="40" text-anchor="middle">FIRE</text></g>
      <!-- air intake + filter house -->
      <rect class="filter" x="28" y="${AX - 120}" width="96" height="240" rx="6"/>
      ${Array.from({ length: 9 }, (_, i) => `<line class="louv" x1="36" y1="${AX - 106 + i * 26}" x2="116" y2="${AX - 96 + i * 26}"/>`).join('')}
      <text class="lab" x="28" y="${AX - 130}">AIR INTAKE</text><text class="val" data-v="dp" x="76" y="${AX + 142}" text-anchor="middle"></text>
      <path class="duct" d="M124 ${AX - 70} C150 ${AX - 70} 155 ${AX - 80} 172 ${AX - 80} L172 ${AX + 80} C155 ${AX + 80} 150 ${AX + 70} 124 ${AX + 70} Z"/>
      <g data-air>${[-40, 0, 40].map(d => `<path class="air" d="M100 ${AX + d} h40 l-8 -5 m8 5 l-8 5"/>`).join('')}</g>
      <!-- gas generator -->
      <path class="casing" d="M172 ${AX - 80} L330 ${AX - 54} L344 ${AX - 80} L438 ${AX - 80} L452 ${AX - 58} L528 ${AX - 54} L528 ${AX + 54} L452 ${AX + 58} L438 ${AX + 80} L344 ${AX + 80} L330 ${AX + 54} L172 ${AX + 80} Z"/>
      ${stages(184, 250, 5, k => 74 - 12 * k, 0, 'lp')}${stages(262, 326, 6, k => 58 - 8 * k, 0, 'hp')}${stages(458, 520, 4, k => 50 - 4 * k, 0, 'tb')}
      <line class="shaft" x1="172" y1="${AX}" x2="528" y2="${AX}"/>
      ${glyph('n1a', 214, 30)}${glyph('n2a', 294, 23, 9)}${glyph('n2b', 470, 22, 9)}${glyph('n1b', 508, 18)}
      ${cans}
      <text class="lab dim" x="400" y="${AX + 102}" text-anchor="middle">8 CANNULAR COMBUSTORS</text>
      <text class="lab" x="214" y="${AX - 92}" text-anchor="middle">LP COMP</text><text class="lab" x="294" y="${AX - 72}" text-anchor="middle">HP COMP</text><text class="lab" x="490" y="${AX - 70}" text-anchor="middle">TURBINES</text>
      <text class="val" data-v="n1" x="230" y="${AX + 102}" text-anchor="end"></text><text class="val" data-v="n2" x="230" y="${AX + 122}" text-anchor="end"></text>
      <text class="lab dim" x="340" y="${AX - 112}" text-anchor="middle">GAS GENERATOR (Olympus)</text>
      <!-- hot gas duct -> free power turbine -> exhaust -->
      <path class="hgd" data-hgd d="M528 ${AX - 50} L566 ${AX - 70} L566 ${AX + 70} L528 ${AX + 50} Z"/>
      <text class="val" data-v="egt" x="547" y="${AX - 84}" text-anchor="middle"></text>
      <path class="casing pt" d="M566 ${AX - 70} L606 ${AX - 92} L700 ${AX - 110} L700 ${AX + 110} L606 ${AX + 92} L566 ${AX + 70} Z"/>
      ${stages(600, 690, 4, k => 84 + 18 * k, 0, 'tb')}
      <line class="shaft" x1="570" y1="${AX}" x2="880" y2="${AX}"/>
      ${glyph('pt', 646, 34, 11)}
      <text class="lab" x="646" y="${AX + 134}" text-anchor="middle">FREE POWER TURBINE</text><text class="val" data-v="pt" x="646" y="${AX + 156}" text-anchor="middle"></text>
      <path class="stack" d="M700 ${AX - 110} L740 ${AX - 110} L742 110 L812 110 L814 ${AX + 110} L700 ${AX + 110} Z"/>
      <path class="stack-glow" data-stackglow d="M742 112 L812 112 L814 ${AX + 100} L704 ${AX + 100} Z"/>
      <text class="lab" x="777" y="96" text-anchor="middle">EXHAUST</text>
      <!-- generator -->
      <rect class="gen" data-gen x="880" y="${AX - 58}" width="140" height="116" rx="18"/>
      ${glyph('gen', 950, 36, 4)}
      <text class="lab" x="950" y="${AX + 80}" text-anchor="middle">GENERATOR 11 kV</text>
      <text class="big" data-v="mw" x="950" y="${AX - 72}" text-anchor="middle"></text><text class="val" data-v="genkv" x="950" y="${AX + 102}" text-anchor="middle"></text>
      <!-- single line: generator -> GEN CB -> station bus -> LINE CB -> Mackay network; aux + battery off the bus -->
      <path class="el" data-el="gen" d="M1020 ${AX} H1040 V160 H1050"/>
      ${cb('gencb', 1076, 160, 'GEN CB')}
      <path class="el" data-el="bus" d="M1102 160 H1140"/><path class="el bus" data-el="bus" d="M1140 124 V246"/>
      <text class="lab dim" x="1140" y="116" text-anchor="middle">BUS</text>
      <path class="el" data-el="bus" d="M1140 160 H1158"/>
      ${cb('linecb', 1184, 160, 'LINE CB')}
      <path class="tl" data-tl d="M1210 160 H1232 V100 Q1262 84 1296 78"/>
      <path class="pylon" d="M1262 84 L1252 138 M1262 84 L1272 138 M1255 112 H1269 M1250 92 H1274"/>
      <text class="lab" x="1296" y="64" text-anchor="end">MACKAY NETWORK</text><text class="val" data-v="net" x="1296" y="44" text-anchor="end"></text>
      <path class="el" data-el="bus" d="M1140 230 H1112 V256"/>
      <g class="aux"><rect x="1078" y="256" width="68" height="40" rx="6"/><text class="lab" x="1112" y="272" text-anchor="middle">AUX + DC</text><text class="val" data-v="batt" x="1112" y="289" text-anchor="middle"></text></g>
      <text class="chip bs" data-v="bs" x="1140" y="210" text-anchor="start"></text>
      <g class="town" data-town transform="translate(1176 214)">${[0, 1, 2, 3].map(i => house((i % 2) * 30, Math.floor(i / 2) * 30, i)).join('')}<text class="lab" x="30" y="84" text-anchor="middle">TOWN</text><text class="val" data-v="town" x="30" y="102" text-anchor="middle"></text></g>
      <path class="feed" data-feed d="M1236 170 V214"/>
      <!-- synchroscope -->
      <g class="sync" data-sync transform="translate(1110 ${AX + 150})"><circle class="face" r="50"/><path class="mark" d="M0 -50 V-38"/><text class="lab" x="0" y="-58" text-anchor="middle">SYNCHROSCOPE</text>
        <text class="tiny" x="-36" y="32" text-anchor="middle">SLOW</text><text class="tiny" x="36" y="32" text-anchor="middle">FAST</text>
        <g data-needle><path class="needle" d="M0 6 V-44"/></g><circle class="pin" r="5"/><text class="val" data-v="slip" x="0" y="72" text-anchor="middle"></text></g>
      <!-- fuel system: storage -> transfer pump -> day tank -> fuel pump -> fuel control valve -> the cans -->
      <rect class="tank" x="24" y="472" width="176" height="128" rx="8"/><rect class="fuel" data-w="st" x="26" y="598" width="172" height="0"/>
      <text class="lab" x="112" y="464" text-anchor="middle">BULK STORAGE</text><text class="big" data-v="st" x="112" y="548" text-anchor="middle"></text><text class="val" data-v="stl" x="112" y="572" text-anchor="middle"></text>
      <path class="pipe" d="M200 585 H226"/><circle class="pump" data-pump="tr" cx="240" cy="585" r="14"/><path class="pipe" d="M254 585 H280"/>
      <path class="ppath" data-path="tr" d="M200 585 H280"/><g data-parts="tr"></g>
      <rect class="tank" x="280" y="500" width="84" height="100" rx="6"/><rect class="fuel" data-w="day" x="282" y="598" width="80" height="0"/>
      <text class="lab" x="322" y="492" text-anchor="middle">DAY TANK</text><text class="val" data-v="day" x="322" y="560" text-anchor="middle"></text>
      <path class="pipe" d="M364 585 H396"/><circle class="pump" data-pump="fp" cx="410" cy="585" r="14"/><path class="pipe" d="M424 585 H470 V540"/>
      <g class="fcv" transform="translate(470 528)"><path d="M-12 -10 L12 10 V-10 L-12 10 Z"/><text class="lab" x="18" y="4">FCV</text><text class="val" data-v="fcv" x="18" y="22"></text></g>
      <path class="pipe" d="M470 516 V${AX + 120} H386 V${AX + 72}"/>
      <path class="ppath" data-path="fuel" d="M364 585 H470 V${AX + 120} H386 V${AX + 72}"/><g data-parts="fuel"></g>
      <text class="big fuelbig" data-v="flow" x="600" y="572" text-anchor="middle"></text><text class="lab dim" x="600" y="596" text-anchor="middle">FUEL FLOW (estimate)</text>
      <!-- lube oil -->
      <rect class="oiltank" x="760" y="500" width="90" height="60" rx="6"/><text class="lab" x="805" y="492" text-anchor="middle">LUBE OIL</text>
      <circle class="pump" data-pump="lo" cx="872" cy="530" r="12"/><path class="oil" data-oil d="M884 530 H900 V${AX + 120} H${600} V${AX + 92}"/>
      <text class="val" data-v="oil" x="805" y="534" text-anchor="middle"></text><text class="val dim" data-v="oilt" x="805" y="552" text-anchor="middle"></text>
      <!-- stale overlay + badge -->
      <g class="stale" data-stale><rect width="${W}" height="${H}" fill="url(#gt-hatch)"/><rect class="sbox" x="430" y="16" width="440" height="44" rx="10"/><text class="stxt" data-v="stale" x="650" y="44" text-anchor="middle"></text></g>
      <text class="badge" x="12" y="${H - 6}">TRAINING SIMULATION · inspired by the former Mackay Gas Turbine · not affiliated with Stanwell · figures approximate</text>
    </svg><canvas class="gt-fx" aria-hidden="true"></canvas>`;
  }

  // ------------------------------------------------------------------ fuel strip + start progress (always visible)
  function below() {
    return `<div class="card gt-prog" id="gt-prog"></div>
    <div class="card gt-fuel">
      <div class="gt-big"><span>Fuel flow</span><b id="gt-lpm">0</b><i>L/min</i><small id="gt-lph"></small></div>
      <div class="gt-big"><span>Burned this run</span><b id="gt-runl">0</b><i>litres</i><small id="gt-runc"></small></div>
      <ul class="gt-cmp" id="gt-cmp"></ul>
      <div class="gt-tanks"><div class="gt-gauge" title="Bulk storage"><i id="gt-g-st"></i><span>STORAGE</span><b id="gt-g-stv"></b></div><div class="gt-gauge day" title="Day tank"><i id="gt-g-day"></i><span>DAY TANK</span><b id="gt-g-dayv"></b></div><p class="dim small" id="gt-left"></p></div>
      <span class="tag gt-est">ESTIMATES · SFC ${G.FUEL.sfc} kg/kWh at full load</span>
    </div>`;
  }

  // ------------------------------------------------------------------ operator panel
  function opHtml() {
    return `<div class="gt-ops">
      <div class="card gt-unit"><div class="card-h"><h2>Unit 1 · Rolls-Royce Olympus</h2><span class="gt-state" id="gt-st"></span></div>
        <div class="sk-mw"><b id="gt-mwv"></b><span>MW</span><span class="dim small" id="gt-mwsub"></span></div>
        <div class="row gap wrap"><button class="btn primary" data-cmd="start">▶ Start <span class="dim">BO2001</span></button><button class="btn" data-cmd="stop">■ Normal stop <span class="dim">BO2002</span></button><button class="btn ghost" data-cmd="reset">↺ Reset trips <span class="dim">BO2004</span></button></div>
        <p class="gt-why" id="gt-why"></p>
        <h3 class="gt-h3">Start permissives</h3><ul class="gt-perms" id="gt-perms"></ul>
        <label class="sk-sl"><span>MW setpoint <b id="gt-ao0-v"></b></span><input type="range" id="gt-ao0" min="${C.MW_SP[0]}" max="${C.MW_SP[1]}" step="0.5"></label>
        <button class="btn small" data-sp="0">Send setpoint (AO3001)</button>
        <label class="sk-sl"><span>Voltage setpoint <b id="gt-ao1-v"></b></span><input type="range" id="gt-ao1" min="${C.KV_SP[0]}" max="${C.KV_SP[1]}" step="0.05"></label>
        <button class="btn small" data-sp="1">Send setpoint (AO3002)</button>
      </div>
      <div class="card"><div class="card-h"><h2>Breakers + modes</h2></div>
        <div class="sk-brk"><span>Generator breaker <b id="gt-gencb"></b></span><button class="btn small" data-cmd="gencb.close">Sync + close</button><button class="btn small ghost" data-cmd="gencb.open">Trip</button></div>
        <div class="sk-brk"><span>Line breaker <b id="gt-linecb"></b></span><button class="btn small" data-cmd="linecb.close">Close</button><button class="btn small ghost" data-cmd="linecb.open">Trip</button></div>
        <div class="sk-brk"><span>Black start mode <b id="gt-bs"></b></span><button class="btn small" data-cmd="blackstart.on">On</button><button class="btn small ghost" data-cmd="blackstart.off">Off</button></div>
        <div class="sk-brk"><span>Control <b id="gt-rl"></b></span><button class="btn small" data-cmd="rl.remote">Remote</button><button class="btn small ghost" data-cmd="rl.local">Local</button></div>
        <div class="sk-estop"><button class="sk-ebtn" data-cmd="estop" aria-label="Emergency stop">E-STOP</button><span class="dim small">BO2003 -- trips the unit and latches until BO2004</span></div>
        <p class="dim small" id="gt-opnote"></p>
      </div>
      <div class="card gt-faults" id="gt-faults"><div class="card-h"><h2>🧑‍🏫 Instructor</h2><span class="dim small">make something go wrong AT the plant -- not a SCADA control</span></div>
        <div class="gt-fbtns">${Object.entries(G.FAULTS).map(([k, t]) => `<button class="btn small ghost" data-fault="${k}" title="${t}">${{ overspeed: '🌀 Overspeed', egt: '🔥 Hot EGT', spread: '🌡️ EGT spread', vibration: '📳 Vibration', oil: '🛢️ Oil leak', flameout: '💨 Flame out', fire: '🚒 Fire', fuel: '⛽ Transfer pump', revpower: '↩️ Reverse power', nolight: '🔌 Igniter', blackout: '🌑 Blackout', gridback: '💡 Restore network' }[k]}</button>`).join('')}</div>
        <p class="dim small" id="gt-fnote">Each one shows a trip with its first-up alarm. The unit has to run down before BO2004 resets it.</p>
      </div>
    </div>`;
  }

  // ------------------------------------------------------------------ tabs
  const num = (id, label, step, unit) => `<label class="fld inline small"><span>${label}${unit ? ` <i class="dim">${unit}</i>` : ''}</span><input type="number" id="gt-f-${id}" step="${step}"></label>`;
  const TABS = [
    { key: 'fuel', label: '⛽ Fuel + the town', html: () => `<div class="d3-row">
      <div class="card"><div class="card-h"><h2>🏘️ How much to run the town?</h2></div>
        <div class="sk-form">${num('homes', 'Homes', 500)}${num('kwHome', 'Average load per home', 0.1, 'kW')}</div>
        <div class="gt-townout" id="gt-townout"></div>
        <div class="gt-hbar"><i id="gt-tbar"></i></div><p class="dim small" id="gt-tbarlab"></p>
      </div>
      <div class="card"><div class="card-h"><h2>Fuel figures</h2><span class="dim small">all estimates -- change them</span></div>
        <div class="sk-form">${num('sfc', 'Specific fuel consumption at full load', 0.01, 'kg/kWh')}${num('density', 'Diesel density', 0.01, 'kg/L')}${num('price', 'Diesel price', 0.05, '$/L')}${num('co2', 'CO2 per litre', 0.01, 'kg')}${num('tanker', 'B-double tanker', 1000, 'L')}${num('storageKL', 'Bulk storage capacity', 50, 'kL')}</div>
        <div id="gt-fuelout" class="gt-fuelout"></div>
        <button class="btn small ghost" id="gt-fdef">Back to the defaults</button>
      </div></div>` },
    { key: 'eng', label: '🔧 Engine data', html: () => `<div class="d3-row">
      <div class="card"><div class="card-h"><h2>Engine + generator</h2><span class="dim small" id="gt-engsrc"></span></div><div class="d3-scroll tall"><table class="d3-tbl gt-eng"><thead><tr><th>Reading</th><th>Value</th><th>Alarm</th><th>Trip</th></tr></thead><tbody id="gt-engt"></tbody></table></div></div>
      <div class="card"><div class="card-h"><h2>Exhaust thermocouples</h2><span class="dim small">8, one behind each can</span></div><div id="gt-tcs"></div><p class="dim small">One cold can (a blocked fuel nozzle, a lost flame) shows as a big spread long before the average looks wrong -- that's why the spread has its own trip.</p></div></div>` },
    { key: 'facts', label: '📖 Station + fun facts', html: () => `<div class="d3-row">
      <div class="card"><div class="card-h"><h2>The station</h2><span class="tag sk-sim">as the trainer models it · approximate</span></div>
        <ul class="gt-facts">
          <li><b>1 × Rolls-Royce Olympus</b> industrial gas turbine, <b>34 MW</b>, open-cycle peaker</li>
          <li>Fuel: <b>light fuel oil / diesel</b></li>
          <li>Commissioned <b>1975</b>, refurbished <b>2014</b>, decommissioned <b>April 2021</b></li>
          <li>Remote-controlled, fast start, <b>black start</b> capable -- originally built to black start Collinsville Power Station</li>
          <li>Twin-shaft: an aero-derived <b>gas generator</b> blowing hot gas through a separate <b>free power turbine</b> that turns the generator at 3000 rpm (50 Hz)</li>
        </ul>
        <p class="dim small">This page is a training simulation inspired by the former Mackay Gas Turbine. It is not affiliated with Stanwell or any operator, and the engine and fuel figures are approximate, for education.</p>
      </div>
      <div class="card"><div class="card-h"><h2>Fun facts</h2></div>
        <div class="gt-fun">
          <h3>✈️ A bomber engine making electricity</h3><p>The Olympus began as a jet engine for the Avro Vulcan bomber, and a later version powered Concorde. Bolt the gas-generator part of a jet to the ground, point its exhaust at a separate turbine instead of out of a nozzle, and you have an industrial gas turbine that can go from cold to full load in a minute or two.</p>
          <h3>💸 Why peakers are expensive to run</h3><p id="gt-fun-cost"></p>
          <h3>🌑 What "black start" means</h3><p>After a total blackout, most power stations can't start themselves: their pumps, fans and controls need power from the grid. A black-start unit starts from its own battery, energises a dead bus, then a dead line, then picks up load a block at a time -- and the rest of the network is rebuilt around it. Try the <b>Blackout!</b> challenge.</p>
          <h3>🏁 Why stations like this retire</h3><p>Open-cycle diesel units are among the costliest ways to make a megawatt-hour, so they run only for a few hours a year; meanwhile 1970s plant needs ever more maintenance. As gas peakers, batteries and stronger transmission arrive, it stops making sense to keep one ready. (A general picture, not the operator's own statement.)</p>
          <h3>📡 Why DNP3 over radio</h3><p>A remote station like this is exactly what SCADA over a radio link was made for: a master in a control room hundreds of kilometres away polls an RTU at the site, and the RTU time-stamps every event so the first-up trip is known even if the radio was down when it happened.</p>
        </div>
      </div></div>` },
  ];

  window.KellyMackayGtUI = function (k) {
    const settings = k.settings, prev = settings.gt || {};
    const fuel = Object.assign({}, G.FUEL, prev.fuel || {});
    const plant = new G.Plant({ accel: 30, fuel });
    plant.fuelCfg = fuel;   // the page's fuel figures ARE the plant's (edits apply at once)
    const ui = window.KellyScadaKit(k, {
      key: 'gt', prefix: 'gt', cfgKey: 'gt', model: G, plant, defaults: { time: 'demo', psnd: true, shimmer: false, fuel },
      title: '⛽ Mackay gas turbine <span class="dim small">SCADA trainer</span>',
      simTag: 'TRAINING SIMULATION · inspired by the former Mackay Gas Turbine (decommissioned 2021) · not affiliated with Stanwell · engine figures approximate',
      intro: 'One Rolls-Royce Olympus -- a jet engine bolted to the ground -- driving a 34 MW generator on light fuel oil. Fast start, black start, and a fuel bill you can watch climbing. Start it, synchronise it, load it, trip it, black start the town -- all over DNP3 on a P25 radio link.',
      psndLabel: 'engine sound (roar, starter, hum)', topExtra: '<label class="chk small"><input type="checkbox" id="gt-shimmer"> heat shimmer</label>',
      mimic, below, opHtml, tabs: TABS,
      rfNote: role => (role === 'master' ? 'The outstation must be another Kelly running this station (needs the gateway\'s DNP3 forwarder) -- the NUC\'s DNP3 MASTER page only knows a breaker on BI 0 / BO 0.'
        : 'Any DNP3 master on the network can poll this RTU; the NUC dashboard\'s DNP3 MASTER page sees BI 0 = BI0001 Unit Available, and its BO 0 is BO2001 Start Unit here (CLOSE starts it).'),
      hooks: api => hooks(api, k, plant),
    });
    settings.gt.fuel = fuel;   // saved with the page's settings: the same object the plant burns by
    return ui;
  };

  function hooks(api, k, plant) {
    const { q, play, soe, cfg } = api, $ = k.$, esc = k.esc;
    const M = {}, ang = { n1a: 0, n2a: 0, n2b: 0, n1b: 0, pt: 0, gen: 0 }, ph = { fuel: 0, tr: 0 }, flick = Array(8).fill(1);
    let target = null, pv = null, cv = null, g2 = null, parts = [], plumeT = 0, syncNext = 0, runBase = null, paintAt = 0;
    const F = () => plant.fuelCfg;

    // ---------------------------------------------------------------- effects canvas (one-shot puffs, steady plume)
    function fit() { const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); } const s = r.width / W; g2.setTransform(dpr * s, 0, 0, dpr * s, 0, 0); return r.width > 0; }
    function puff(kind, x, y, n) {
      if (api.reduced()) return;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = kind === 'fire' ? 40 + Math.random() * 140 : kind === 'co2' ? 20 + Math.random() * 60 : 10 + Math.random() * 40;
        const max = kind === 'co2' ? 3 + Math.random() * 2 : kind === 'fire' ? 0.5 + Math.random() * 0.5 : 2 + Math.random() * 1.5;
        parts.push({ kind, x: x + (kind === 'co2' ? (Math.random() - 0.5) * 560 : (Math.random() - 0.5) * 30), y: y + (kind === 'co2' ? Math.random() * 280 : 0), vx: Math.cos(a) * sp * (kind === 'co2' ? 1 : 0.5), vy: kind === 'co2' ? Math.sin(a) * sp * 0.4 : -Math.abs(Math.sin(a) * sp) - (kind === 'smoke' ? 50 : 30), r: kind === 'fire' ? 10 + Math.random() * 16 : 8 + Math.random() * 10, life: max, max });
      }
      if (parts.length > 400) parts.splice(0, parts.length - 400);
    }
    function drawFx(dt, v, frozen) {
      if (!cv || !fit()) return false;
      g2.clearRect(0, 0, W, H);
      const burning = v && v.flame && !frozen, load = v ? Math.max(0, n0(v.mw)) / C.RATED_MW : 0, still = api.reduced();
      // plume over the stack: a steady glow that grows with load; it drifts slowly up unless reduced motion
      if (burning) {
        plumeT += dt;
        const base = 0.3 + 0.6 * load, cx = 777, cy = 104;
        for (let i = 0; i < 4; i++) {
          const f = still ? i / 4 : ((plumeT * 0.25 + i / 4) % 1), y = cy - f * 95, r = 26 + 48 * load + f * 34, a = base * (1 - f) * 0.7;
          const gr = g2.createRadialGradient(cx, y, 2, cx, y, r); gr.addColorStop(0, `rgba(255,170,70,${a})`); gr.addColorStop(1, 'rgba(255,90,20,0)');
          g2.fillStyle = gr; g2.beginPath(); g2.arc(cx, y, r, 0, Math.PI * 2); g2.fill();
        }
        if (cfg.shimmer && !still) {   // heat shimmer: wavy translucent bands rising out of the stack (opt-in)
          g2.strokeStyle = `rgba(220,235,255,${0.08 + 0.1 * load})`; g2.lineWidth = 2;
          for (let b = 0; b < 6; b++) {
            const y = 100 - ((plumeT * 30 + b * 16) % 96);
            g2.beginPath(); for (let x = 744; x <= 810; x += 4) g2.lineTo(x + Math.sin(plumeT * 4 + b) * 3, y + Math.sin(x * 0.18 + plumeT * 6 + b) * 2.5); g2.stroke();
          }
        }
      }
      // particles: light-off fireball, black smoke, CO2 fog
      parts = parts.filter(p => (p.life -= dt) > 0);
      for (const p of parts) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.r += (p.kind === 'smoke' ? 18 : p.kind === 'co2' ? 10 : 30) * dt; p.vx *= 0.98;
        const a = Math.max(0, p.life / p.max);
        g2.fillStyle = p.kind === 'fire' ? `rgba(255,${120 + 100 * a | 0},40,${0.75 * a})` : p.kind === 'smoke' ? `rgba(20,20,24,${0.55 * a})` : `rgba(235,245,255,${0.28 * a})`;
        g2.beginPath(); g2.arc(p.x, p.y, p.r, 0, Math.PI * 2); g2.fill();
      }
      return burning || parts.length > 0;
    }

    // ---------------------------------------------------------------- fuel numbers
    function runLitres(v) {
      if (v.run) return v.run.litres;
      if (runBase == null || v.starts !== runBase.starts) runBase = { starts: v.starts, litres: v.litres };   // SCADA: C4002 since the last start (C4003)
      return Math.max(0, v.litres - runBase.litres);
    }
    function paintFuel(v, rolling) {
      const lph = n0(v.fuelLph), fs = G.fuelStats(lph, F()), runL = rolling != null ? rolling : runLitres(v);
      q('lpm').textContent = fmt(fs.lpm, 0);
      q('lph').textContent = `${fmt(lph)} L/h · ${fmt(fs.kgph)} kg/h`;
      q('runl').textContent = fmt(runL);
      q('runc').textContent = `$${fmt(runL * F().price)} · ${fmt(runL * F().co2 / 1000, 1)} t CO2`;
      const fullS = G.fuelStats(G.fullLoadLph(F()), F());
      const cmp = lph > 1 ? [
        `🚗 fills a ${F().car} L car tank every <b>${fmt(fs.carSecs, 1)} s</b>`,
        `🚛 <b>${fmt(fs.tankersPerHour, 2)}</b> B-double tankers an hour (${fmt(F().tanker / 1000)} kL each)`,
        `🏊 <b>${fmt(fullS.poolsPerWeek, 2)}</b> Olympic pools of diesel a week at full load`,
        `💸 <b>$${fmt(fs.costPerHour)}</b> an hour · ${fmt(fs.co2tPerHour, 1)} t CO2 an hour`,
      ] : [`🔇 not burning -- at full load it would fill a ${F().car} L car tank every <b>${fmt(fullS.carSecs, 1)} s</b>`, `🏊 <b>${fmt(fullS.poolsPerWeek, 2)}</b> Olympic pools a week at full load`];
      const h = cmp.map(x => `<li>${x}</li>`).join(''); const n = q('cmp'); if (n.dataset.h !== h) { n.innerHTML = h; n.dataset.h = h; }
      const sp = n0(v.storagePct), dp = v.dayPct;
      q('g-st').style.transform = `scaleY(${Math.max(0, Math.min(1, sp / 100))})`; q('g-stv').textContent = `${sp.toFixed(1)} %`;
      q('g-day').style.transform = `scaleY(${dp == null ? 0 : Math.max(0, Math.min(1, dp / 100))})`; q('g-dayv').textContent = dp == null ? 'n/a' : `${dp.toFixed(0)} %`;
      q('g-st').parentNode.classList.toggle('low', sp < C.STORAGE_LOW); q('g-day').parentNode.classList.toggle('low', dp != null && dp < C.DAY_LOW);
      const left = sp / 100 * F().storageL + (dp == null ? 0 : dp / 100 * C.DAY_L);
      q('left').textContent = lph > 1 ? `At this burn the tanks last about ${fmt(left / lph, 1)} h${plant.accel > 1 ? ` (${fmt(left / lph * 3600 / plant.accel / 60, 1)} min of this page at ×${plant.accel})` : ''}.` : `${fmt(left)} L in the tanks.`;
    }

    // ---------------------------------------------------------------- the start progress strip
    const STOPS = [['unload', 'Unload'], ['cool', 'Cool-down'], ['rundown', 'Run-down'], ['runon', 'Lube run-on']];
    function paintProg(v) {
      let h;
      const stopping = STOPS.some(s => s[0] === v.state) || (v.tripped && v.state !== 'stopped');
      if (stopping) {
        const i = STOPS.findIndex(s => s[0] === v.state);
        h = `${v.tripped ? `<span class="gt-tripchip">TRIPPED · first-up: ${esc(v.firstText || '')}</span>` : '<b class="gt-pt">Stopping</b>'}<div class="gt-chips">${STOPS.map(([key, t], j) => `<span class="${j < i ? 'ok' : j === i ? 'now' : ''}">${t}</span>`).join('')}</div>`;
      } else {
        const i = v.stageIdx, run = v.state === 'run';
        h = `<b class="gt-pt">${v.starting ? 'Starting' : run ? 'On load' : v.state === 'stopped' ? (v.tripped || v.estop ? 'Tripped -- reset to start' : 'Ready') : esc(G.STATE_NAMES[v.state] || v.state)}</b><div class="gt-chips">${G.STAGES.map(([key, t], j) => `<span class="${i > j || run ? 'ok' : i === j ? 'now' : ''}">${j + 1}. ${t}</span>`).join('')}<span class="${run ? 'ok' : ''}">✓ On load</span></div>`;
        if (v.sync && v.sync.held) h += `<p class="gt-held">⏸ ${esc(v.sync.held)}</p>`;
        if (v.startFail && v.state === 'stopped') h += `<p class="gt-held bad">✖ ${esc(v.startFail)}</p>`;
        if (v.remote) h += '<p class="dim small">Stage worked out from SCADA points (BI0003, BI0005, N2, PT, kV, BI0006) -- the RTU doesn\'t send the step number.</p>';
      }
      const n = q('prog'); if (n.dataset.h !== h) { n.innerHTML = h; n.dataset.h = h; }
    }

    return {
      bind(root) {
        M.svg = root.querySelector('.gt-mimic');
        M.v = {}; M.svg.querySelectorAll('[data-v]').forEach(n => { M.v[n.dataset.v] = n; });
        M.rot = {}; M.svg.querySelectorAll('[data-rot]').forEach(n => { M.rot[n.dataset.rot] = n; });
        M.can = Array.from(M.svg.querySelectorAll('[data-can]')); M.fl = M.can.map(c => c.querySelector('.fl'));
        M.cb = {}; M.svg.querySelectorAll('[data-cb]').forEach(n => { M.cb[n.dataset.cb] = n; });
        M.el = {}; M.svg.querySelectorAll('[data-el]').forEach(n => (M.el[n.dataset.el] = M.el[n.dataset.el] || []).push(n));
        M.paths = {}; M.svg.querySelectorAll('[data-path]').forEach(n => { M.paths[n.dataset.path] = { el: n, len: n.getTotalLength() }; });
        M.parts = {}; M.svg.querySelectorAll('[data-parts]').forEach(n => { M.parts[n.dataset.parts] = n; });
        M.pump = {}; M.svg.querySelectorAll('[data-pump]').forEach(n => { M.pump[n.dataset.pump] = n; });
        for (const key of ['tl', 'stale', 'encl', 'fire', 'town', 'feed', 'sync', 'needle', 'hgd', 'stackglow', 'gen', 'oil', 'air']) M[key] = M.svg.querySelector(`[data-${key}]`);
        M.wSt = M.svg.querySelector('[data-w="st"]'); M.wDay = M.svg.querySelector('[data-w="day"]');
        cv = root.querySelector('.gt-fx'); g2 = cv.getContext('2d');
        M.svg.addEventListener('click', e => { const g = e.target.closest('[data-cb]'); if (g) { const v = api.curView(), id = g.dataset.cb; api.issue(`${id}.${(id === 'gencb' ? v.genCB : v.lineCB) ? 'open' : 'close'}`); } });
        M.svg.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-cb]')) { e.preventDefault(); e.target.closest('[data-cb]').dispatchEvent(new MouseEvent('click', { bubbles: true })); } });
        q('ao0').value = plant.mwSp; q('ao1').value = plant.kvSp; q('ao0').oninput = api.dirty; q('ao1').oninput = api.dirty;
        q('shimmer').checked = !!cfg.shimmer; q('shimmer').onchange = e => { cfg.shimmer = e.target.checked; api.save(); };
        q('faults').addEventListener('click', e => {
          const b = e.target.closest('[data-fault]'); if (!b) return;
          if (!api.plantHere()) return;
          const okk = plant.fault(b.dataset.fault, 'instructor');
          if (!okk) api.toast('🧑‍🏫', 'Nothing happens', b.dataset.fault === 'blackout' ? 'The network is already dead.' : b.dataset.fault === 'gridback' ? 'The network is already live.' : 'That fault does not apply right now.');
          api.dirty();
        });
        // fuel tab
        const FK = ['homes', 'kwHome', 'sfc', 'density', 'price', 'co2', 'tanker'];
        const fill = () => { FK.forEach(f => { q('f-' + f).value = F()[f]; }); q('f-storageKL').value = F().storageL / 1000; };
        FK.forEach(f => { q('f-' + f).onchange = e => { const x = +e.target.value; if (x > 0) { F()[f] = x; api.save(); } else e.target.value = F()[f]; api.dirty(); }; });
        q('f-storageKL').onchange = e => { const x = +e.target.value; if (x >= 50) { const pct = plant.storagePct; F().storageL = x * 1000; plant.storageL = F().storageL * pct / 100; api.save(); } fill(); api.dirty(); };
        q('fdef').onclick = () => { const pct = plant.storagePct; Object.assign(F(), G.FUEL); plant.storageL = F().storageL * pct / 100; api.save(); fill(); api.dirty(); };
        fill();
      },
      // plant events -> the station log (sounds + effects come from what the SCREEN sees change, in paint)
      event(e) {
        const by = e.by === 'scada' ? ' (SCADA)' : e.by === 'protection' ? ' (protection)' : e.by === 'demo' ? ' (demo)' : e.by === 'instructor' ? ' (instructor)' : '';
        const S = G.STATE_NAMES;
        if (e.type === 'stage') { if (e.by !== 'sequence' || !['stopped'].includes(e.state) || e.prev !== 'runon') soe(`Unit: ${S[e.state]}${by}`, e.by === 'protection' ? 'warn' : ''); else soe('Unit: stopped, lube oil pump off', ''); }
        else if (e.type === 'lightoff') soe('LIGHT-OFF: flame in all 8 cans', 'sc');
        else if (e.type === 'breaker') soe(`${e.id === 'gencb' ? 'Generator' : 'Line'} breaker ${e.closed ? 'CLOSED' : 'OPENED'}${e.how === 'sync' ? ' by the auto-synchroniser' : e.how === 'deadbus' ? ' onto the DEAD BUS (black start)' : e.how === 'undervoltage' ? ' on under-voltage' : ''}${by}`, e.closed ? '' : 'warn');
        else if (e.type === 'trip') soe(`TRIP: ${e.text}${e.first ? ' -- FIRST UP' : ''}`, 'bad');
        else if (e.type === 'startfail') soe(e.reason, 'bad');
        else if (e.type === 'co2') soe('CO2 DISCHARGED into the turbine enclosure', 'bad');
        else if (e.type === 'fire') soe(`FIRE detected in the turbine enclosure${by}`, 'bad');
        else if (e.type === 'fire-out') soe('Fire out (CO2)', '');
        else if (e.type === 'grid') soe(e.live ? `Mackay network restored${by}` : `BLACKOUT: the Mackay network is dead${by}`, e.live ? 'sc' : 'bad');
        else if (e.type === 'mode') soe(e.id === 'blackstart' ? `Black start mode ${e.on ? 'ON' : 'off'}${by}` : `Control ${e.on ? 'REMOTE' : 'LOCAL'}${by}`, '');
        else if (e.type === 'setpoint') soe(`${e.which === 'mwsp' ? 'MW' : 'Voltage'} setpoint ${e.value} ${e.unit}${by}`, '');
        else if (e.type === 'estop') soe('EMERGENCY STOP' + by, 'bad');
        else if (e.type === 'reset') soe('Trips reset (BO2004)' + by, 'sc');
        else if (e.type === 'loadrej') soe(`Load rejection: ${e.mw.toFixed(1)} MW thrown off -- the power turbine surges`, 'warn');
        else if (e.type === 'fault') soe(`Instructor: ${G.FAULTS[e.name]}`, 'warn');
        else if (e.type === 'fueloff') soe('Fuel off after the cool-down run', '');
      },
      alarms(v, add) {
        if (v.remote && !v.known) return;   // the master has no data yet: nothing to alarm on (the kit says NO DATA)
        for (const [cause, on] of Object.entries(v.trips || {})) if (on) add('t-' + cause, cause === v.firstUp && v.firstText ? `TRIP: ${v.firstText}` : `TRIP: ${G.TRIPS[cause].text}`, 'bad', cause === v.firstUp);
        if (v.fire) add('fire', 'FIRE DETECTED in the turbine enclosure', 'bad');
        if (v.co2) add('co2', 'CO2 released -- enclosure flooded, do not enter', 'bad');
        if (v.startFail && v.state === 'stopped') add('sf', 'Start failed: ' + v.startFail.replace(/^Start aborted[^:]*: /, ''), 'warn');
        if (v.fuelLow) add('fuel', 'Fuel tank LOW', 'warn');
        if (v.running && v.oilP < C.OIL_LOW && !v.trips.oil) add('oil', `Lube oil pressure LOW (${v.oilP.toFixed(1)} bar)`, 'warn');
        if (v.flame && v.egt > C.EGT_ALARM && !v.trips.egt) add('egt', `EGT HIGH (${Math.round(v.egt)} °C)`, 'warn');
        if (v.flame && v.spread > C.SPREAD_ALARM && !v.trips.egt) add('spread', `EGT spread HIGH (${Math.round(v.spread)} °C)`, 'warn');
        if (v.vib > C.VIB_ALARM && !v.trips.vibration) add('vib', `Vibration HIGH (${v.vib.toFixed(1)} mm/s)`, 'warn');
        if (v.batt && v.batt < C.BATT_LOW) add('batt', 'DC battery LOW', 'bad');
        if (v.dp > 20) add('dp', 'Intake filter dP HIGH', 'warn');
        if (v.gridLive === false) add('grid', 'Mackay network DEAD (blackout)', 'warn');
        if (v.remoteOn === false) add('local', 'Unit in LOCAL -- SCADA controls refused', 'warn');
      },
      sound(v, on) {
        const fx = api.fx; if (!fx) return;
        const n2 = n0(v.n2) / 100, starter = v.starter != null ? v.starter : v.state === 'crank';
        fx.jet(on && n2 > 0.02, n0(v.n1) / 100, n2);
        if (fx.starter) fx.starter(on && starter, n2);
        fx.hum(on && v.genCB && n0(v.mw) > 0.5, Math.min(1.3, n0(v.mw) / C.RATED_MW * 1.2));
      },
      phaseText(seq) { const p = seq.phase(); return p ? `🎬 step ${p.step}/${p.of}: ${p.phase}` : 'you drive'; },
      localSetpoint(ao, value, by) { const r = plant.setpoint(P.ao[ao].id, value, by); if (!r.ok) api.toast('⛔', 'Setpoint refused', r.reason, 'bad'); },
      reset() { plant.reset({ accel: plant.accel }); pv = null; runBase = null; parts = []; return ['⛽', 'Station reset', 'Unit stopped and cold, network live, storage at 82 %']; },
      chalStart() { pv = null; runBase = null; },

      // ---- paint (~4 Hz): values, classes, what changed -> sounds + one-shot effects
      paint(v, stale, frozen) {
        const tx = (key, s) => { const n = M.v[key]; if (n && n.textContent !== s) n.textContent = s; };
        const S = G.STATE_NAMES[v.state] || v.state;
        tx('banner', v.tripped ? `TRIPPED · ${v.firstText || ''}` : v.estop ? 'EMERGENCY STOP' : v.state === 'run' ? `ON LOAD · ${n0(v.mw).toFixed(1)} MW` : S.toUpperCase());
        M.v.banner.setAttribute('class', `gt-banner ${v.tripped || v.estop ? 'bad' : v.state === 'run' ? 'good' : v.starting ? 'warn' : ''}`);
        tx('sub', `${v.island ? 'ISLANDED · governor holds 50 Hz · ' : ''}${v.blackStart ? 'BLACK START MODE · ' : ''}${v.remoteOn === false ? 'LOCAL · ' : 'REMOTE · '}${v.remote ? 'SCADA view (from DNP3)' : 'plant view (the truth)'}`);
        tx('n1', `N1 ${n0(v.n1).toFixed(0)} %`); tx('n2', `N2 ${n0(v.n2).toFixed(0)} %`); tx('pt', `${fmt(v.pt)} rpm`);
        tx('egt', `EGT ${fmt(v.egt)} °C${v.flame ? ` ±${fmt(v.spread)}` : ''}`); tx('dp', `dP ${n0(v.dp).toFixed(1)} mbar`);
        tx('mw', `${n0(v.mw).toFixed(1)} MW`); tx('genkv', v.kv > 0.5 ? `${v.kv.toFixed(2)} kV · ${n0(v.hz).toFixed(2)} Hz · PF ${n0(v.pf).toFixed(2)}` : 'de-energised');
        tx('batt', `${n0(v.batt).toFixed(1)} V`); tx('bs', v.blackStart ? 'BLACK START' : '');
        const netLive = v.gridLive == null ? null : v.gridLive;
        tx('net', netLive === false ? 'DEAD -- blackout' : netLive ? (v.lineCB && v.genCB && n0(v.mw) > 1 ? `exporting ${n0(v.mw).toFixed(1)} MW` : 'live') : v.lineCB ? 'line breaker closed' : 'line breaker open');
        tx('town', v.townLit === true ? (v.island && v.lineCB ? `${(plant.townMW).toFixed(0)} MW on the island` : 'lights on') : v.townLit === false ? 'DARK' : '?');
        tx('st', `${n0(v.storagePct).toFixed(1)} %`); tx('stl', `${fmt(n0(v.storagePct) / 100 * F().storageL / 1000)} kL`);
        tx('day', v.dayPct == null ? 'not on SCADA' : `${v.dayPct.toFixed(0)} %`); tx('fcv', v.remote ? '' : `${(plant.fcv * 100).toFixed(0)} % open`);
        tx('flow', `${fmt(v.fuelLph)} L/h`); tx('oil', `${n0(v.oilP).toFixed(2)} bar`); tx('oilt', `${n0(v.oilT).toFixed(0)} °C`);
        tx('encl', v.co2 ? '· CO2 RELEASED' : v.fire ? '· FIRE' : v.vent ? '· ventilation on' : '');
        // synchroscope: the plant's own panel shows it; SCADA has no point for it
        const sy = v.sync; M.sync.classList.toggle('on', !!sy); M.sync.classList.toggle('na', !!v.remote);
        tx('slip', sy ? (sy.held ? 'waiting' : `slip ${sy.slip >= 0 ? '+' : ''}${sy.slip.toFixed(2)} Hz`) : v.remote ? 'local panel only' : v.genCB ? 'in sync' : '');
        // breakers + single line
        M.cb.gencb.classList.toggle('closed', !!v.genCB); M.cb.linecb.classList.toggle('closed', !!v.lineCB);
        const busLive = v.busLive != null ? v.busLive : (v.genCB && v.kv > 5) || v.lineCB;
        const live = { gen: v.kv > 5, bus: busLive };
        for (const [key, nodes] of Object.entries(M.el)) nodes.forEach(n => n.classList.toggle('live', !!live[key]));
        const exporting = v.lineCB && v.genCB && n0(v.mw) > 1;
        M.tl.setAttribute('class', `tl ${exporting ? 'exp' : netLive === false ? (v.lineCB && v.genCB ? 'exp' : 'dead') : netLive || v.lineCB ? 'live' : 'dead'}`);
        M.town.setAttribute('class', `town ${v.townLit === true ? 'lit' : v.townLit === false ? 'dark' : ''}`);
        M.feed.classList.toggle('live', v.townLit === true);
        M.encl.classList.toggle('co2', !!v.co2); M.fire.classList.toggle('on', !!v.fire);
        M.gen.classList.toggle('live', v.kv > 5); M.hgd.style.opacity = v.flame ? (0.25 + 0.6 * Math.min(1, n0(v.egt) / 550)).toFixed(2) : '0';
        M.stackglow.style.opacity = v.flame ? (0.15 + 0.5 * Math.max(0, n0(v.mw)) / C.RATED_MW).toFixed(2) : '0';
        M.pump.tr.classList.toggle('on', !!v.transfer); M.pump.fp.classList.toggle('on', !!v.fuelPump); M.pump.lo.classList.toggle('on', !!v.lubePump);
        M.oil.classList.toggle('on', n0(v.oilP) > 0.5); M.air.style.opacity = (0.15 + 0.85 * Math.min(1, n0(v.n1) / 100)).toFixed(2);
        const tank = (node, pct, y0, h0) => { const hh = h0 * Math.max(0, Math.min(1, n0(pct) / 100)); node.setAttribute('y', (y0 + h0 - hh).toFixed(1)); node.setAttribute('height', hh.toFixed(1)); };
        tank(M.wSt, v.storagePct, 474, 124); tank(M.wDay, v.dayPct == null ? 0 : v.dayPct, 502, 96);
        M.wSt.classList.toggle('low', n0(v.storagePct) < C.STORAGE_LOW); M.wDay.classList.toggle('low', v.dayPct != null && v.dayPct < C.DAY_LOW);
        M.stale.style.display = frozen ? '' : 'none'; if (stale) tx('stale', stale);
        // what changed since the last paint: sounds + one-shot effects (the SCADA screen reacts when the DATA arrives)
        if (pv && !frozen) {
          const cansNow = v.flames || [], cansWas = pv.flames || [];
          cansNow.forEach((on, i) => { if (on && !cansWas[i]) { M.can[i].classList.remove('ign'); void M.can[i].getBBox(); M.can[i].classList.add('ign'); setTimeout(() => M.can[i].classList.remove('ign'), 700); } });
          if (v.flame && !pv.flame) { play('whump'); puff('fire', 777, 104, 26); }
          if (v.tripped && !pv.tripped) puff('smoke', 777, 104, 30);
          if (v.co2 && !pv.co2) { play('co2'); puff('co2', 440, AX - 140, 70); }
          if (v.genCB !== pv.genCB) play(v.genCB ? 'clunk' : 'trip', v.genCB ? 1 : 0.9);
          if (v.lineCB !== pv.lineCB) play(v.lineCB ? 'clunk' : 'trip', 0.8);
        }
        pv = { flames: (v.flames || []).slice(), flame: v.flame, tripped: v.tripped, co2: v.co2, genCB: v.genCB, lineCB: v.lineCB };
        target = { v, frozen };
        paintAt = performance.now();
        paintProg(v); paintFuel(v);
      },
      // ---- motion (fxLoop): blades spin with N1/N2/PT, flames glow + flicker, fuel flows, the synchroscope turns
      frame(now, dt) {
        if (!M.svg || !target) return 400;
        const { v, frozen } = target, still = api.reduced();
        let moving = false;
        const spin = (key, frac, dir = 1) => {
          if (frozen || still || frac < 0.003) return;
          ang[key] = (ang[key] + dir * Math.min(1, frac) * 420 * dt) % 360;   // <= 21° a frame: no wagon-wheel strobing
          M.rot[key].setAttribute('transform', `rotate(${ang[key].toFixed(1)})`); M.rot[key].parentNode.style.setProperty('--sp', Math.min(1, frac).toFixed(2)); moving = true;
        };
        spin('n1a', n0(v.n1) / 100); spin('n1b', n0(v.n1) / 100, -1); spin('n2a', n0(v.n2) / 100, -1); spin('n2b', n0(v.n2) / 100); spin('pt', n0(v.pt) / C.PT_SYNC); spin('gen', n0(v.pt) / C.PT_SYNC);
        // flames: glow tracks fuel flow; a slow small flicker (none under reduced motion or on a stale screen)
        const fuelFrac = Math.min(1, n0(v.fuelLph) / G.fullLoadLph(plant.fuelCfg));
        (v.flames || []).forEach((on, i) => {
          if (on && !frozen && !still) flick[i] += ((0.88 + Math.random() * 0.24) - flick[i]) * Math.min(1, dt * 3);
          const op = on ? Math.min(1, (0.45 + 0.55 * Math.sqrt(fuelFrac)) * (still || frozen ? 1 : flick[i])) : 0;
          const s = op.toFixed(2); if (M.fl[i].style.opacity !== s) M.fl[i].style.opacity = s;
          M.can[i].classList.toggle('lit', !!on);
        });
        if (v.flame && !frozen && !still) moving = true;
        // fuel (and the transfer pump) particles: speed = flow
        const flowP = (key, on, rate, count) => {
          const gp = M.parts[key], P2 = M.paths[key];
          if (!on || frozen || still) { if (gp.childElementCount) gp.textContent = ''; return; }
          if (gp.childElementCount !== count) gp.innerHTML = Array.from({ length: count }, () => '<circle r="3.4"/>').join('');
          ph[key] = (ph[key] + rate * dt) % 1;
          Array.from(gp.children).forEach((c, j) => { const pt = P2.el.getPointAtLength(((ph[key] + j / count) % 1) * P2.len); c.setAttribute('cx', pt.x.toFixed(1)); c.setAttribute('cy', pt.y.toFixed(1)); });
          moving = true;
        };
        flowP('fuel', n0(v.fuelLph) > 1, 0.05 + 0.35 * fuelFrac, Math.round(6 + 12 * fuelFrac));
        flowP('tr', !!v.transfer, 0.25, 6);
        // synchroscope needle + ticks speeding up as it nears 12 o'clock
        const sy = v.sync;
        if (sy && !frozen) {
          M.needle.setAttribute('transform', `rotate(${sy.angle.toFixed(1)})`);
          const a = Math.abs(sy.angle > 180 ? sy.angle - 360 : sy.angle);
          if (!sy.held && now >= syncNext) { play('tick', 1 - a / 180); syncNext = now + (0.12 + 0.55 * a / 180) * 1000; }
          moving = true;
        } else if (v.genCB) M.needle.setAttribute('transform', 'rotate(0)');
        // the rolling litres counter: interpolated between paints at the current burn x time speed
        if (v.run && n0(v.fuelLph) > 1 && !frozen) { const extra = n0(v.fuelLph) * plant.accel * (now - paintAt) / 3.6e6; q('runl').textContent = fmt(v.run.litres + Math.max(0, extra)); moving = true; }
        if (drawFx(dt, v, frozen)) moving = true;
        return moving ? 50 : 400;
      },
      renderOp(v) {
        const s = q('st'); s.textContent = v.tripped ? 'TRIPPED' : G.STATE_NAMES[v.state] || v.state; s.className = `gt-state s-${v.state}${v.tripped || v.estop ? ' bad' : ''}`;
        q('mwv').textContent = n0(v.mw).toFixed(1);
        q('mwsub').textContent = ` · sp ${v.mwSp == null ? '--' : v.mwSp} MW · ${fmt(v.fuelLph)} L/h`;
        q('ao0-v').textContent = q('ao0').value + ' MW'; q('ao1-v').textContent = (+q('ao1').value).toFixed(2) + ' kV';
        const B = (id, on, t, f) => { const n = q(id); n.textContent = on ? t : f; n.className = on ? 'good' : 'bad'; };
        B('gencb', v.genCB, 'CLOSED', 'OPEN'); B('linecb', v.lineCB, 'CLOSED', 'OPEN');
        const bs = q('bs'); bs.textContent = v.blackStart ? 'ON' : 'off'; bs.className = v.blackStart ? 'warn' : '';
        const rl = q('rl'); rl.textContent = v.remoteOn === false ? 'LOCAL' : 'REMOTE'; rl.className = v.remoteOn === false ? 'warn' : 'good';
        // why it can't start (the plant's own words when it's here, else what SCADA can tell)
        let why = '';
        if (api.plantHere() && !v.running && !v.starting) { const w = plant.check('start'); why = w && !/^Already/.test(w) ? w : ''; }
        else if (v.remote && !v.running && !v.starting && !v.permOk) why = "Can't start: BI0002 Start Permissives OK is OFF -- the RTU won't say which one (look at the trips and alarms)";
        const wn = q('why'); wn.textContent = why ? '🔒 ' + why : ''; wn.hidden = !why;
        const perms = v.perms;
        const ph2 = perms ? perms.map(p => `<li class="${p.ok ? 'ok' : 'no'}"><b>${p.ok ? '✔' : '✖'}</b> ${esc(p.text)}${p.ok ? '' : ` <span class="dim">-- ${esc(p.why)}</span>`}</li>`).join('')
          : `<li class="${v.permOk ? 'ok' : 'no'}"><b>${v.permOk ? '✔' : '✖'}</b> BI0002 Start Permissives OK <span class="dim">(SCADA sees one summary point, not the list)</span></li>`;
        const pn = q('perms'); if (pn.dataset.h !== ph2) { pn.innerHTML = ph2; pn.dataset.h = ph2; }
        q('faults').hidden = !api.plantHere();
      },
      renderTab(key, v) {
        if (key === 'fuel') {
          const f = F(), tw = G.town(f), full = G.fullLoadLph(f);
          q('townout').innerHTML = `<div class="gt-tbig"><b>${fmt(tw.mw, 1)}</b><span>MW needed</span></div><div class="gt-tbig"><b>${fmt(tw.lph)}</b><span>litres an hour${tw.fits ? '' : ' (one unit\'s worth)'}</span></div><div class="gt-tbig"><b>${tw.hours == null ? '--' : fmt(tw.hours, 0)}</b><span>hours of storage (${tw.hours == null ? '--' : fmt(tw.hours / 24, 1)} days)</span></div>
            ${tw.fits ? '' : `<p class="gt-held bad">✖ ${fmt(tw.mw, 0)} MW is more than one 34 MW unit -- the town needs ${tw.units} of them. Try a black start onto this town and watch the frequency collapse.</p>`}`;
          const days = tw.hours == null ? 0 : tw.hours / 24;
          q('tbar').style.transform = `scaleX(${Math.min(1, days / 14)})`; q('tbarlab').textContent = `Full storage (${fmt(f.storageL / 1000)} kL) runs the town for about ${fmt(days, 1)} days -- the bar is 14 days.`;
          const eff = 3.6 / (f.sfc * 42.8) * 100, perMWhFull = full / C.RATED_MW * f.price, perMWhHalf = G.fuelLph(17, f) / 17 * f.price;
          q('fuelout').innerHTML = `<p>Full load: <b>${fmt(full)} L/h</b> (${fmt(full * f.density)} kg/h). Full speed, no load: ${fmt(G.fuelLph(0, f))} L/h -- before a single MW goes out.</p>
            <p>Fuel cost: <b>$${fmt(perMWhFull)}/MWh</b> at full load, $${fmt(perMWhHalf)}/MWh at half load. Thermal efficiency about <b>${fmt(eff, 0)} %</b> (diesel ~42.8 MJ/kg).</p>`;
        } else if (key === 'eng') {
          q('engsrc').textContent = v.remote ? 'from DNP3 (the master\'s copy)' : 'live at the plant';
          const R = (name, val, unit, d, al, tr, hi = true) => { const x = val == null ? null : +val; const lvl = x == null ? '' : tr != null && (hi ? x >= tr : x <= tr) ? 'bad' : al != null && (hi ? x >= al : x <= al) ? 'warn' : ''; return `<tr class="${lvl}"><td>${name}</td><td class="v">${x == null ? '--' : fmt(x, d) + ' ' + unit}</td><td class="dim">${al == null ? '' : (hi ? '≥ ' : '≤ ') + al}</td><td class="dim">${tr == null ? '' : (hi ? '≥ ' : '≤ ') + tr}</td></tr>`; };
          const run = v.running;
          const h = [R('Gas generator LP speed N1', v.n1, '%', 1), R('Gas generator HP speed N2', v.n2, '%', 1), R('Power turbine speed', v.pt, 'rpm', 0, 3150, C.PT_TRIP),
            R('EGT average', v.egt, '°C', 0, C.EGT_ALARM, C.EGT_TRIP), R('EGT spread', v.spread, '°C', 0, C.SPREAD_ALARM, C.SPREAD_TRIP), R('Compressor inlet temp', v.cit, '°C', 1), R('Compressor delivery pressure', v.cdp, 'bar', 1), R('Compressor delivery temp', v.cdt, '°C', 0),
            R('Intake filter dP', v.dp, 'mbar', 1, 20, C.FILTER_MAX), run ? R('Lube oil pressure', v.oilP, 'bar', 2, C.OIL_LOW, C.OIL_TRIP, false) : R('Lube oil pressure', v.oilP, 'bar', 2), R('Lube oil temp', v.oilT, '°C', 1), R('Lube oil tank', v.oilTank, '%', 0, null, C.OILTANK_MIN, false),
            R('Bearing vibration', v.vib, 'mm/s', 1, C.VIB_ALARM, C.VIB_TRIP), R('Fuel flow', v.fuelLph, 'L/h', 0), R('Fuel pressure', v.fuelP, 'bar', 1), R('Fuel storage', v.storagePct, '%', 1, C.STORAGE_LOW, null, false), R('Day tank', v.dayPct, '%', 0, C.DAY_LOW, C.DAY_LOWLOW, false),
            R('Generator MW', v.mw, 'MW', 1, null, C.REV_MW, false), R('Generator MVAr', v.mvar, 'MVAr', 1), R('Generator voltage', v.kv, 'kV', 2), R('Generator current', v.amps, 'A', 0), R('Frequency', v.kv > 1 ? v.hz : null, 'Hz', 2), R('Power factor', v.pf, '', 2),
            R('Field current', v.field, 'A', 0), R('Winding temp', v.wtemp, '°C', 1, 120, 140), R('DC battery', v.batt, 'V', 1, null, C.BATT_LOW, false), R('Ambient', v.ambient, '°C', 1)].join('');
          const n = q('engt'); if (n.dataset.h !== h) { n.innerHTML = h; n.dataset.h = h; }
          const tcs = v.tcs || [], mx = 650, bw = 34;
          const bars = tcs.map((t, i) => { const hh = Math.max(0, Math.min(1, t / mx)) * 120; return `<g transform="translate(${10 + i * (bw + 8)} 0)"><rect class="${t > C.EGT_ALARM ? 'warn' : ''}${v.flame && v.egt - t > C.SPREAD_ALARM / 2 ? ' cold' : ''}" x="0" y="${140 - hh}" width="${bw}" height="${hh}" rx="4"/><text x="${bw / 2}" y="156" text-anchor="middle">${i + 1}</text><text x="${bw / 2}" y="${134 - hh}" text-anchor="middle">${fmt(t)}</text></g>`; }).join('');
          q('tcs').innerHTML = `<svg class="gt-tcs" viewBox="0 0 350 162">${bars}</svg>${v.remote ? '<p class="dim small">SCADA only has the average and the spread (AI1010, AI1011): these bars are a sketch from those two.</p>' : ''}`;
        } else if (key === 'facts') {
          const f = F(), full = G.fullLoadLph(f), perMWh = full / C.RATED_MW * f.price;
          const fc = q('fun-cost'), t = `At full load this engine turns about ${fmt(full)} litres of diesel an hour into 34 MW -- roughly $${fmt(perMWh)} of fuel for every megawatt-hour at $${f.price.toFixed(2)}/L, before maintenance or wages, and worse at part load. There's no steam cycle to recover the exhaust heat (that's what "open cycle" means), so about ${fmt(100 - 3.6 / (f.sfc * 42.8) * 100, 0)} % of the fuel's energy goes up the stack. A peaker earns its keep by being there for the few hours a year when the price is very high -- or when everything else has gone dark.`;
          if (fc.textContent !== t) fc.textContent = t;
        }
      },
    };
  }
})();
