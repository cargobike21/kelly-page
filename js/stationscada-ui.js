/* Kelly Page -- Station SCADA (LoRa Mesh > Station SCADA tab, 2026-10-23): an animated plant-HMI mimic of a MeshCore
 * home station -- SenseCAP Solar Node P1 repeater up the mast, RAK4631 companion in the shack, Raspberry Pi 4 on its USB.
 *
 * Modules (each its own file, loaded before app.js):
 *   stationscada-core.js    pure: config defaults, the JSON event schema, LoRa airtime / link budget / Fresnel, alarms
 *   stationscada-sim.js     pure: the simulation source (default)
 *   stationscada-live.js    live sources: Kelly's own mesh link (fed by mesh.js), or a bridge WebSocket
 *   stationscada-audio.js   Web Audio sounds (muted at first; mute + volume remembered)
 *   stationscada-panels.js  the switchable extras (waterfall, inspector, link budget, Fresnel, airtime, solar, SWR,
 *                           annunciator, trends, neighbours) -- window.StationScadaPanels
 *   stationscada-ui.js      this: the tab, the mimic, telemetry panels, packet log, controls
 * Rules this page keeps (kelly-page/CLAUDE.md): one fxLoop (fast only while something moves, ~5 Hz idle, 600 ms when
 * the tab isn't showing -- nothing moves then and the simulation pauses); every animation is per-event and ends
 * (pulses, rings, LED blinks; an unacknowledged alarm flashes 3 times, then stays lit until ACK); prefers-reduced-motion
 * or Kelly's effects off = no travelling pulses, the links just light up.
 *
 * window.KellyStationScadaUI(k) -> { init, feed(kind, ...a), shown }   (made by mesh.js; k from there)
 */
(function () {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';
  // mimic geometry (viewBox 0 0 1000 520)
  const G = { cmpAnt: [150, 334], rptAnt: [500, 66], usbA: [162, 404], usbB: [204, 404], mesh: [985, 236], arr: [500, 452],
    horizonX: [600, 965], horizonY: 300, panel: [500, 168], batt: [500, 206] };
  const fmtUp = s => { if (s == null) return '–'; s = s | 0; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
  const num = (v, d = 1) => v == null || Number.isNaN(+v) ? '–' : (+v).toFixed(d);
  const hhmm = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor(h % 1 * 60)).padStart(2, '0')}`;

  window.KellyStationScadaUI = function (k) {
    const C = window.StationScadaCore, Sim = window.StationScadaSim, Live = window.StationScadaLive;
    const { esc } = k;
    const ov = k.settings.stationScada = Object.assign({ cfg: {} }, k.settings.stationScada || {});
    let cfg = C.merge(C.DEFAULTS, ov.cfg);
    const save = () => { ov.cfg = ov.cfg || {}; k.saveSoon('settings'); };
    const setOv = (path, v) => { let o = ov.cfg; const ks = path.split('.'); ks.slice(0, -1).forEach(x => { o = o[x] = o[x] && typeof o[x] === 'object' ? o[x] : {}; }); o[ks[ks.length - 1]] = v; cfg = C.merge(C.DEFAULTS, ov.cfg); save(); };
    const audio = window.StationScadaAudio ? window.StationScadaAudio(() => { try { return k.audioCtx(); } catch { return null; } }) : null;

    // ------------------------------------------------------------------ state (what every source feeds)
    const S = {
      rpt: {}, cmp: {}, host: {}, serial: 'up', env: { hour: 12, sunElev: 60, cloud: 0.2, night: false }, nbrs: new Map(),
      log: [], logVer: 0, air: [], crc: [], lastRxT: 0, usbN: 0, rxN: 0, txN: 0,
      alarms: {}, hist: [], histVer: 0, trend: [], sel: null, selVer: 0, selNbr: null, dx: k.store.get('stationScadaDx', null), stories: new Map(),
    };
    let root = null, svg = null, src = null, srcKind = '', running = false, lastTick = 0, built = false, ref = {};
    const comps = [];   // the extras, from stationscada-panels.js
    const fx = { pulses: [], leds: new Map(), glow: new Map() };
    const reduced = () => k.settings.fx === false || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const colors = () => cfg.theme === 'crt' ? cfg.colorsCrt : cfg.colors;
    const isActive = () => !!root && k.currentPage() === 'mesh' && !!root.closest('.tab.on') && !document.hidden;
    const on = id => cfg.features[id] !== false;

    // ------------------------------------------------------------------ events in (one schema, any source)
    function emit(e) {
      const now = e.t || Date.now(), live = isActive();
      switch (e.type) {
        case 'telemetry': {
          const d = S[e.dev]; if (!d) break;
          for (const [kk, v] of Object.entries(e.data || {})) if (v !== undefined) d[kk] = v;
          d.t = now;
          if (e.dev === 'host' && e.data.serial) S.serial = e.data.serial;
          break;
        }
        case 'rf': {
          const p = e.pkt || {}, ms = C.airtimeMs(p.len || 20, cfg.radio);
          const rec = { t: now, dev: e.dev, dir: e.dir, id: e.id, peer: e.peer, pkt: p, retry: e.retry, fwd: e.fwd, air: ms };
          if (e.dev !== 'nbr') { S.log.push(rec); if (S.log.length > 400) S.log.shift(); S.logVer++; }
          // airtime as the mast hears / sends it (the shack's RX of the mast's repeat is the same air, not counted twice)
          if (e.dev === 'rpt' || (e.dev === 'cmp' && e.dir === 'tx')) S.air.push({ t: now, ms, tx: e.dev === 'rpt' && e.dir === 'tx' });
          if (e.dir === 'rx' && (e.dev === 'rpt' || e.dev === 'cmp')) { S.lastRxT = now; S.rxN++; }
          if (e.dir === 'tx' && e.dev !== 'nbr') S.txN++;
          if (p.crc === 'fail') S.crc.push(now);
          if (live) animRf(rec);
          break;
        }
        case 'usb': S.usbN++; if (live) animUsb(e); break;
        case 'neighbour': {
          const n = Object.assign(S.nbrs.get(e.n.id) || {}, Object.fromEntries(Object.entries(e.n).filter(([, v]) => v != null)));
          S.nbrs.set(e.n.id, n);
          if (n.hops === 0 && n.distKm != null && (!S.dx || n.distKm > S.dx.km)) { S.dx = { km: n.distKm, name: n.name, snr: n.snr, t: now }; k.store.set('stationScadaDx', S.dx); hist('info', 'DX', `New best DX: ${n.name}, ${n.distKm.toFixed(1)} km direct`); }
          break;
        }
        case 'link': if (e.serial && e.serial !== S.serial) { S.serial = e.serial; hist(e.serial === 'up' ? 'info' : 'alarm', 'HOST-01', e.serial === 'up' ? `Serial link up${e.note ? `: ${e.note}` : ''}` : `Serial link lost${e.note ? `: ${e.note}` : ''}`); } S.host.serial = S.serial; break;
        case 'env': Object.assign(S.env, e); if (e.lightning && live) lightning(); else if (e.lightning) hist('warn', 'SA-01', 'Lightning nearby'); break;
        case 'log': hist(e.level || 'info', 'SYS', e.text); break;
      }
      for (const c of comps) if (c.on && c.event) try { c.event(e, api); } catch (er) { console.warn('Station SCADA', c.id, er); }
    }
    function hist(level, tag, text) { S.hist.push({ t: Date.now(), level, tag, text }); if (S.hist.length > 300) S.hist.shift(); S.histVer++; }

    // ------------------------------------------------------------------ sources
    function startSource(kind) {
      stopSource();
      srcKind = kind;
      if (kind === 'sim') src = Sim(cfg, emit, {});
      else if (kind === 'kelly') { src = Live.kelly(emit, k.live); src.start(); }
      else if (kind === 'ws') { src = Live.ws(emit, cfg.wsUrl); src.start(); }
      hist('info', 'SYS', `Source: ${kind === 'sim' ? 'simulation' : kind === 'kelly' ? "Kelly's mesh link" : `bridge ${cfg.wsUrl}`}`);
      paintSource();
    }
    function stopSource() { if (src && src.stop) src.stop(); src = null; S.stories.clear(); }
    function resetData() {
      Object.assign(S, { rpt: {}, cmp: {}, host: {}, serial: 'up', log: [], air: [], crc: [], trend: [], lastRxT: 0, sel: null }); S.nbrs.clear(); S.logVer++; S.selVer++;
      if (ref.nbr) ref.nbr.innerHTML = ''; nbrSig = '';
    }

    // ------------------------------------------------------------------ the mimic (SVG)
    function mimicSvg() {
      const stars = Array.from({ length: 46 }, (_, i) => { const x = (i * 211 + 37) % 990, y = (i * 97 + 13) % 270, r = i % 5 === 0 ? 1.6 : 0.9; return `<circle cx="${x}" cy="${y}" r="${r}"/>`; }).join('');
      // the outer g drifts (CSS transform); the inner one places it (an SVG transform attribute a CSS one would replace)
      const cloud = (x, y, s) => `<g class="ss-cloud" data-x="${x}"><g transform="translate(${x} ${y}) scale(${s})"><path d="M0 30 q0 -22 26 -22 q8 -18 32 -14 q20 -10 36 8 q24 0 24 22 q0 12 -14 14 h-92 q-12 0 -12 -8z"/></g></g>`;
      return `<svg class="ss-mimic" viewBox="0 0 1000 520" role="img" aria-label="Station mimic: shack with RAK4631 and Raspberry Pi, mast with SenseCAP Solar P1 repeater, neighbour nodes on the horizon">
        <defs>
          <linearGradient id="ssgr-day" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b3a6e"/><stop offset="1" stop-color="#2d7fb8"/></linearGradient>
          <linearGradient id="ssgr-dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1c4a"/><stop offset=".7" stop-color="#8a3d5c"/><stop offset="1" stop-color="#e2804a"/></linearGradient>
          <linearGradient id="ssgr-night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#02040c"/><stop offset="1" stop-color="#0a1430"/></linearGradient>
          <radialGradient id="ssgr-sun"><stop offset="0" stop-color="#fff6c8"/><stop offset=".5" stop-color="#ffd25a"/><stop offset="1" stop-color="#ffb020" stop-opacity="0"/></radialGradient>
          <pattern id="ssgr-brick" width="20" height="10" patternUnits="userSpaceOnUse"><path d="M0 0h20M0 5h20M10 0v5M0 5v5M20 5v5" stroke="rgba(255,255,255,.04)"/></pattern>
        </defs>
        <rect class="ss-sky" width="1000" height="340" fill="url(#ssgr-night)"/>
        <rect id="ss-sky-day" width="1000" height="340" fill="url(#ssgr-day)" opacity="1"/>
        <rect id="ss-sky-dusk" width="1000" height="340" fill="url(#ssgr-dusk)" opacity="0"/>
        <g id="ss-stars" class="ss-stars" opacity="0">${stars}</g>
        <g id="ss-sun" class="ss-sun"><circle r="34" fill="url(#ssgr-sun)"/><circle r="13" fill="#fff3b0"/></g>
        <g id="ss-clouds" class="ss-clouds">${cloud(80, 50, 1)}${cloud(380, 24, 0.8)}${cloud(720, 70, 1.15)}</g>
        <path class="ss-hills" d="M560 340 L600 318 L650 306 L700 312 L760 296 L820 304 L880 290 L930 300 L1000 294 V340Z"/>
        <rect class="ss-ground" y="340" width="1000" height="180"/>
        <g id="ss-paths" class="ss-paths">
          <path id="ss-l-cr" class="ss-link" d="${arc(G.cmpAnt, G.rptAnt)}"/>
        </g>
        <g id="ss-nbr"></g>
        <!-- house cross-section -->
        <g class="ss-house">
          <polygon class="ss-roof" points="15,212 180,128 345,212"/>
          <rect class="ss-wall" x="40" y="212" width="280" height="258"/><rect x="40" y="212" width="280" height="258" fill="url(#ssgr-brick)"/>
          <rect class="ss-room" x="54" y="226" width="252" height="232" rx="4"/>
          <rect class="ss-window" x="236" y="248" width="56" height="52" rx="3"/><path class="ss-wframe" d="M264 248v52M236 274h56"/>
          <text class="ss-roomlbl" x="66" y="246">SHACK</text>
          <rect class="ss-desk" x="56" y="428" width="248" height="8" rx="2"/><path class="ss-desk" d="M66 436v30M294 436v30"/>
          <!-- CMP-01 RAK4631 on its base board, stub antenna -->
          <g id="ss-cmp" class="ss-dev" data-dev="cmp" tabindex="0">
            <rect class="ss-box rak" x="68" y="386" width="94" height="38" rx="4"/>
            <text class="ss-boxlbl" x="76" y="418">RAK4631</text>
            <path class="ss-ant" d="M150 386 V${G.cmpAnt[1]}"/><circle id="ss-cmp-ant" class="ss-anttip" cx="${G.cmpAnt[0]}" cy="${G.cmpAnt[1]}" r="4"/>
            <circle class="ss-led pwr on" cx="78" cy="396" r="3.4"/><circle id="ss-led-cmp-tx" class="ss-led tx" cx="90" cy="396" r="3.4"/><circle id="ss-led-cmp-rx" class="ss-led rx" cx="102" cy="396" r="3.4"/>
            <text class="ss-ledlbl" x="74" y="407">PWR TX RX</text>
          </g>
          <!-- USB cable -->
          <path id="ss-usb" class="ss-usb" d="M${G.usbA[0]} ${G.usbA[1]} C 176 446, 192 446, ${G.usbB[0]} ${G.usbB[1]}"/>
          <!-- HOST-01 Raspberry Pi 4 + monitor -->
          <g id="ss-host" class="ss-dev" data-dev="host" tabindex="0">
            <rect class="ss-mon" x="204" y="322" width="90" height="58" rx="3"/><path class="ss-desk" d="M249 380v8M232 388h34"/>
            <g id="ss-monbars" class="ss-monbars"><rect x="212" y="362" width="8" height="10"/><rect x="224" y="356" width="8" height="16"/><rect x="236" y="350" width="8" height="22"/><rect x="248" y="358" width="8" height="14"/><rect x="260" y="352" width="8" height="20"/><rect x="272" y="346" width="8" height="26"/></g>
            <text class="ss-montxt" x="212" y="338">P25X · MESH</text>
            <rect class="ss-box pi" x="204" y="396" width="84" height="28" rx="3"/>
            <text class="ss-boxlbl" x="226" y="416">Pi 4</text>
            <circle class="ss-led pwr on" cx="212" cy="404" r="3"/><circle id="ss-led-host-usb" class="ss-led usb" cx="212" cy="415" r="3"/>
          </g>
          <g id="ss-tag-cmp" class="ss-tag" data-dev="cmp"><rect x="56" y="476" width="128" height="20" rx="3"/><text x="62" y="490">CMP-01 RAK4631</text></g>
          <g id="ss-tag-host" class="ss-tag" data-dev="host"><rect x="190" y="476" width="118" height="20" rx="3"/><text x="196" y="490">HOST-01 RPI4</text></g>
        </g>
        <!-- mast: SenseCAP Solar Node P1 repeater, whip on top, surge arrestor at the foot -->
        <g class="ss-mast">
          <path class="ss-guy" d="M500 140 L430 470 M500 140 L570 470"/>
          <rect class="ss-pole" x="497" y="66" width="6" height="404"/>
          <g id="ss-rpt" class="ss-dev" data-dev="rpt" tabindex="0">
            <polygon id="ss-panel" class="ss-panel" points="462,184 538,184 528,160 472,160"/><path class="ss-panelgrid" d="M481 160l-4 24M500 160v24M519 160l4 24M467 172h66"/>
            <rect class="ss-box p1" x="476" y="186" width="48" height="60" rx="5"/>
            <text class="ss-boxlbl" x="483" y="200">P1</text>
            <rect class="ss-battshell" x="483" y="${G.batt[1]}" width="30" height="13" rx="2"/><rect class="ss-battnub" x="513" y="${G.batt[1] + 4}" width="3" height="5"/>
            <rect id="ss-battfill" class="ss-battfill" x="485" y="${G.batt[1] + 2}" width="20" height="9"/>
            <path id="ss-flow" class="ss-flow" d="M500 186 V${G.batt[1]}"/>
            <circle class="ss-led pwr on" cx="486" cy="234" r="3"/><circle id="ss-led-rpt-tx" class="ss-led tx" cx="497" cy="234" r="3"/><circle id="ss-led-rpt-rx" class="ss-led rx" cx="508" cy="234" r="3"/>
            <path class="ss-ant" d="M500 66 V20"/><circle id="ss-rpt-ant" class="ss-anttip" cx="${G.rptAnt[0]}" cy="${G.rptAnt[1]}" r="4"/>
          </g>
          <text id="ss-solarlbl" class="ss-solarlbl" x="544" y="176"></text>
          <g id="ss-tag-rpt" class="ss-tag" data-dev="rpt"><rect x="532" y="214" width="136" height="20" rx="3"/><text x="538" y="228">RPT-01 SOLAR P1</text></g>
          <g id="ss-arr" class="ss-arr"><rect x="488" y="444" width="24" height="16" rx="2"/><text x="518" y="456">SA-01</text></g>
          <path class="ss-earth" d="M500 460 v14 M488 474 h24 M492 478 h16 M496 482 h8"/>
        </g>
        <g id="ss-meshpt" class="ss-meshpt"><circle cx="${G.mesh[0]}" cy="${G.mesh[1]}" r="6"/><text x="${G.mesh[0] - 6}" y="${G.mesh[1] - 12}" text-anchor="end">WIDER MESH ⋯</text></g>
        <g id="ss-bolt" class="ss-bolt" opacity="0"><path d="M640 0 L600 70 L628 72 L560 160 L588 162 L506 60"/></g>
        <rect id="ss-flashov" class="ss-flashov" width="1000" height="520" opacity="0" pointer-events="none"/>
        <text id="ss-caption" class="ss-caption" x="590" y="330"></text>
        <text id="ss-clock" class="ss-clock" x="16" y="24"></text>
        <g id="ss-fx"></g>
      </svg>`;
    }
    // a gentle arc between two points (RF through the air), as a path d
    function arc(a, b, lift = 40) { const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - lift; return `M${a[0]} ${a[1]} Q${mx} ${my} ${b[0]} ${b[1]}`; }
    function arcAt(a, b, f, lift = 40) { const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - lift, u = 1 - f; return [u * u * a[0] + 2 * u * f * mx + f * f * b[0], u * u * a[1] + 2 * u * f * my + f * f * b[1]]; }

    // neighbours on the horizon: the most recently heard repeaters first, at most 6 (the rest come from "wider mesh")
    let nbrSig = '';
    function horizon() {
      const list = [...S.nbrs.values()].filter(n => n.lastHeard).sort((a, b) => (b.role === 'repeater') - (a.role === 'repeater') || b.lastHeard - a.lastHeard).slice(0, 6);
      list.forEach((n, i) => { n.x = G.horizonX[0] + (n.az != null ? n.az : (i + 0.5) / list.length) * (G.horizonX[1] - G.horizonX[0]); });
      // keep labels apart
      list.sort((a, b) => a.x - b.x).forEach((n, i, l) => { if (i && n.x - l[i - 1].x < 62) n.x = l[i - 1].x + 62; n.x = Math.min(n.x, 968); n.y = G.horizonY - (n.role === 'repeater' ? 34 : 14) + (i % 2) * 6; });
      return list;
    }
    function drawHorizon() {
      const list = horizon(), sig = list.map(n => `${n.id}:${Math.round(n.x)}`).join('|');
      for (const n of list) { const g = ref.nbr.querySelector(`[data-nbr="${CSS.escape(n.id)}"] .ss-nsnr`); if (g) g.textContent = n.snr != null ? `${num(n.snr, 1)} dB${n.hops ? ` · ${n.hops} hop${n.hops > 1 ? 's' : ''}` : ''}` : n.hops ? `${n.hops} hops` : ''; }
      if (sig === nbrSig) return; nbrSig = sig;
      ref.nbr.innerHTML = list.map((n, i) => {
        const tip = [n.x, n.y], rep = n.role === 'repeater', ly = G.horizonY + 18 + (i % 2) * 24;   // labels on two rows, so long names don't collide
        return `<g class="ss-nb${rep ? ' rep' : ''}${n.id === S.selNbr ? ' sel' : ''}" data-nbr="${esc(n.id)}" tabindex="0"><path class="ss-link nb" d="${arc(G.rptAnt, tip, 30)}"/>
          ${rep ? `<path class="ss-tower" d="M${tip[0]} ${tip[1]} V${G.horizonY + 4} M${tip[0] - 7} ${G.horizonY + 4} L${tip[0]} ${tip[1] + 8} L${tip[0] + 7} ${G.horizonY + 4}"/>` : `<rect class="ss-tower" x="${tip[0] - 5}" y="${tip[1]}" width="10" height="14" rx="2"/>`}
          <circle class="ss-anttip nb" cx="${tip[0]}" cy="${tip[1]}" r="3.4"/>
          <text class="ss-nname" x="${tip[0]}" y="${ly}" text-anchor="middle">${esc(String(n.name || n.id).slice(0, 18))}</text>
          <text class="ss-nsnr" x="${tip[0]}" y="${ly + 11}" text-anchor="middle">${n.snr != null ? `${num(n.snr, 1)} dB` : ''}</text></g>`;
      }).join('');
      S.drawn = new Map(list.map(n => [n.id, [n.x, n.y]]));
    }
    const posOf = id => id === 'rpt' ? G.rptAnt : id === 'cmp' ? G.cmpAnt : (S.drawn && S.drawn.get(id)) || G.mesh;

    // ------------------------------------------------------------------ animation (per event; nothing loops)
    function pulse(a, b, color, label, rec, dur = 650, lift = 40) {
      if (fx.pulses.length > 60) return;
      if (reduced()) return;
      const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'ss-pulse');
      g.innerHTML = `<circle r="9" fill="${color}" opacity=".18"/><circle r="4.5" fill="${color}"/><text x="8" y="-7" fill="${color}">${label}</text>`;
      if (rec) { g.style.cursor = 'pointer'; g.addEventListener('click', () => inspect(rec)); }
      ref.fx.appendChild(g);
      fx.pulses.push({ g, a, b, t0: performance.now(), dur, lift });
    }
    function ring(at, color) {
      if (reduced()) return;
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', at[0]); c.setAttribute('cy', at[1]); c.setAttribute('r', 10); c.setAttribute('class', 'ss-ring'); c.style.stroke = color;
      c.addEventListener('animationend', () => c.remove());
      ref.fx.appendChild(c);
    }
    function led(key, ms = 140) { fx.leds.set(key, performance.now() + ms); }
    function glow(which, color, ms = 420) { fx.glow.set(which, { until: performance.now() + ms, color }); }
    function animRf(rec) {
      const c = colors(), p = rec.pkt, bad = p.crc === 'fail', col = bad ? c.err : rec.dir === 'tx' && rec.dev !== 'nbr' ? c.tx : c.rx;
      const lbl = bad ? '✖ CRC' : rec.dir === 'tx' && rec.dev !== 'nbr' ? `▲TX ${p.type}` : `▼RX ${p.type}`;
      if (rec.dev === 'nbr') {   // hop trace: earlier hops across the horizon
        const st = S.stories.get(rec.id) || { hops: [] }; S.stories.set(rec.id, st);
        if (S.stories.size > 80) S.stories.delete(S.stories.keys().next().value);
        const prev = st.hops[st.hops.length - 1]; st.hops.push(rec.peer);
        if (on('hoptrace') && prev && prev !== rec.peer) {
          pulse(posOf(prev), posOf(rec.peer), c.rxAlt, `HOP ${st.hops.length - 1}`, rec, 700, 24);
          caption(`Path: ${st.hops.map(id => (S.nbrs.get(id) || {}).name || 'mesh').join(' → ')} → RPT-01`);
        } else if (prev == null) ring(posOf(rec.peer), c.rxAlt);
        return;
      }
      if (rec.dev === 'rpt' && rec.dir === 'rx') {
        pulse(posOf(rec.peer), G.rptAnt, col, lbl, rec, Math.max(400, Math.min(900, rec.air)), rec.peer === 'cmp' ? 40 : 30);
        led('rpt-rx'); glow('rpt', col); playS('rx', 'rpt');
      } else if (rec.dev === 'rpt' && rec.dir === 'tx') {
        led('rpt-tx', 260); ring(G.rptAnt, c.tx); glow('rpt', c.tx); playS('tx', 'rpt');
        pulse(G.rptAnt, G.cmpAnt, c.tx, lbl, rec, 600);
        if (S.drawn) for (const [id, pos] of S.drawn) if (id !== rec.peer) pulse(G.rptAnt, pos, c.tx, '', null, 700, 30);
      } else if (rec.dev === 'cmp' && rec.dir === 'rx') {
        if (rec.peer && rec.peer !== 'rpt') pulse(posOf(rec.peer), G.cmpAnt, col, lbl, rec, 800, 60);
        led('cmp-rx'); glow('cmp', col); playS('rx', 'cmp');
      } else if (rec.dev === 'cmp' && rec.dir === 'tx') {
        led('cmp-tx', 260); ring(G.cmpAnt, c.tx); glow('cmp', c.tx); playS('tx', 'cmp');
        pulse(G.cmpAnt, G.rptAnt, c.tx, `${lbl}${rec.retry ? ` (retry ${rec.retry})` : ''}`, rec, 650);
      }
      if (reduced()) { const l = ref.svg.querySelector(rec.dev === 'cmp' || rec.peer === 'cmp' ? '#ss-l-cr' : '.ss-link.nb'); if (l) { l.classList.add('hot'); setTimeout(() => l.classList.remove('hot'), 350); } }
    }
    let usbPath = null, usbLen = 0, usbLast = 0;
    function animUsb(e) {
      led('host-usb', 90); playS('usb');
      const now = performance.now(); if (now - usbLast < 120 || reduced()) return; usbLast = now;
      if (!usbPath) { usbPath = ref.svg.querySelector('#ss-usb'); usbLen = usbPath.getTotalLength(); }
      const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'ss-pulse');
      const col = colors().usb; g.innerHTML = `<circle r="3.6" fill="${col}"/><text x="-14" y="16" fill="${col}">${e.dir === 'to_host' ? 'USB→' : '←USB'}</text>`;
      ref.fx.appendChild(g);
      fx.pulses.push({ g, usb: e.dir, t0: now, dur: 380 });
    }
    function playS(kind, dev) { if (audio && (cfg.sound[kind] !== false)) audio.play(kind); }
    let capTimer = 0;
    function caption(text) { if (!ref.cap) return; ref.cap.textContent = text; clearTimeout(capTimer); capTimer = setTimeout(() => { ref.cap.textContent = ''; }, 4500); }
    function lightning() {
      hist('warn', 'SA-01', 'Lightning nearby: surge arrestor operated');
      ref.arr.classList.add('hit'); setTimeout(() => ref.arr.classList.remove('hit'), 1800);
      if (reduced() || !on('weather')) return;
      ref.bolt.classList.remove('go'); ref.flash.classList.remove('go'); void ref.bolt.getBBox(); ref.bolt.classList.add('go'); ref.flash.classList.add('go');
    }
    function frameFx(now) {
      for (let i = fx.pulses.length - 1; i >= 0; i--) {
        const p = fx.pulses[i], f = Math.min(1, (now - p.t0) / p.dur);
        let x, y;
        if (p.usb) { const L = usbLen * (p.usb === 'to_host' ? 1 - f : f), pt = usbPath.getPointAtLength(L); x = pt.x; y = pt.y; }
        else [x, y] = arcAt(p.a, p.b, f, p.lift);
        p.g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        if (f >= 1) { p.g.remove(); fx.pulses.splice(i, 1); }
      }
      let lit = false;
      for (const [key, until] of fx.leds) { const el = ref.led[key]; const v = now < until; if (el) el.classList.toggle('on', v); if (!v) fx.leds.delete(key); else lit = true; }
      for (const [which, g] of fx.glow) { const el = ref.ant[which]; const v = now < g.until; if (el) { el.classList.toggle('glow', v); el.style.fill = v ? g.color : ''; } if (!v) fx.glow.delete(which); else lit = true; }
      return fx.pulses.length > 0 || lit;
    }

    // ------------------------------------------------------------------ 1 Hz: sky, tags, telemetry panels, alarms, log
    function sky() {
      const e = S.env, el = e.sunElev ?? 45, ang = Math.PI * ((e.hour ?? 12) - 6) / 12;
      const x = 500 - 440 * Math.cos(ang), y = 340 - 280 * Math.sin(ang);
      ref.sun.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`); ref.sun.style.opacity = el > -4 ? 1 : 0;
      const day = Math.max(0, Math.min(1, (el + 2) / 14)), dusk = Math.max(0, 1 - Math.abs(el - 2) / 10) * 0.9;
      ref.day.setAttribute('opacity', day.toFixed(2)); ref.dusk.setAttribute('opacity', dusk.toFixed(2));
      ref.stars.setAttribute('opacity', on('weather') ? Math.max(0, Math.min(1, -el / 8)).toFixed(2) : 0);
      ref.clouds.style.opacity = on('weather') ? (0.15 + 0.85 * (e.cloud ?? 0.3)).toFixed(2) : 0;
      ref.clouds.querySelectorAll('.ss-cloud').forEach((c, i) => { const bx = +c.dataset.x, xx = ((bx + (e.hour ?? 12) * (26 + i * 9)) % 1150) - 120; c.style.transform = `translateX(${(xx - bx).toFixed(0)}px)`; });
      ref.clock.textContent = `${srcKind === 'sim' ? 'SIM ' : ''}${e.hour != null && srcKind === 'sim' ? hhmm(e.hour) : new Date().toTimeString().slice(0, 5)}${e.night ? ' ☾' : ' ☀'}${srcKind === 'sim' ? ` · cloud ${Math.round((e.cloud ?? 0) * 100)} %` : ''}`;
      // solar flow into the battery + battery level
      const r = S.rpt, w = r.solarW, pct = r.battPct ?? C.battPct(r.battV);
      ref.flow.style.strokeWidth = w == null ? 0 : Math.max(0, Math.min(6, w * 1.2)).toFixed(1);
      ref.flow.style.opacity = w > 0.05 ? 1 : 0;
      ref.solar.textContent = w == null ? '' : `☀ ${num(w, 2)} W → ${r.charge || ''}`;
      ref.batt.setAttribute('width', pct == null ? 0 : (26 * pct / 100).toFixed(1));
      ref.batt.setAttribute('class', `ss-battfill ${C.level(r.battV, cfg.limits.battV) || 'ok'}`);
    }
    function devLevel(dev) {
      const L = cfg.limits, d = S[dev];
      const lv = dev === 'rpt' ? [C.level(d.battV, L.battV), C.level(d.tempC, L.tempC)]
        : dev === 'cmp' ? [S.serial === 'down' ? 'alarm' : '', C.level(d.snr, L.snr)]
          : [C.level(d.cpuTempC, L.cpuTempC), C.level(d.cpuPct, L.cpuPct), C.level(d.memPct, L.memPct), C.level(d.diskPct, L.diskPct), S.serial === 'down' ? 'alarm' : ''];
      return lv.includes('alarm') ? 'alarm' : lv.includes('warn') ? 'warn' : 'ok';
    }
    function tags() {
      for (const dev of ['rpt', 'cmp', 'host']) {
        const lv = devLevel(dev), g = ref.tag[dev], t = g.querySelector('text');
        g.setAttribute('class', `ss-tag ${lv}`);
        t.textContent = `${lv === 'alarm' ? '✖ ' : lv === 'warn' ? '⚠ ' : ''}${cfg.names[dev]}`;
        const card = root.querySelector(`.ss-dev-card[data-dev="${dev}"]`); if (card) card.dataset.lv = lv;
      }
      ref.usbLine.classList.toggle('down', S.serial === 'down');
    }
    // gauges (SVG half-dial), bars, readouts -- updated in place
    function gauge(id, label, unit, min, max) {
      return `<div class="ss-gauge" id="${id}" data-min="${min}" data-max="${max}"><svg viewBox="0 0 120 74" aria-hidden="true"><path class="ss-gtrack" d="M12 66 A48 48 0 0 1 108 66"/><path class="ss-gval" d="M12 66 A48 48 0 0 1 108 66" pathLength="100"/>
        <g class="ss-gneedle"><path d="M60 66 L60 24"/><circle cx="60" cy="66" r="4"/></g></svg><b class="ss-gnum">–</b><small>${label} <i>${unit}</i></small></div>`;
    }
    function setGauge(id, v, lv, digits = 1) {
      const g = root.querySelector(`#${id}`); if (!g) return;
      const min = +g.dataset.min, max = +g.dataset.max, f = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min)));
      g.querySelector('.ss-gval').style.strokeDasharray = `${(f * 100).toFixed(1)} 100`;
      g.querySelector('.ss-gneedle').style.transform = `rotate(${(-90 + f * 180).toFixed(1)}deg)`;
      g.querySelector('.ss-gnum').textContent = v == null ? '–' : num(v, digits);
      g.dataset.lv = lv || '';
    }
    function bar(id, label, unit) { return `<div class="ss-bar" id="${id}"><span>${label}</span><i><b></b></i><em>–</em><small>${unit}</small></div>`; }
    function setBar(id, v, max, lv, digits = 0, text) {
      const b = root.querySelector(`#${id}`); if (!b) return;
      b.querySelector('b').style.transform = `scaleX(${v == null ? 0 : Math.max(0, Math.min(1, v / max)).toFixed(3)})`;
      b.querySelector('em').textContent = text != null ? text : v == null ? '–' : num(v, digits); b.dataset.lv = lv || '';
    }
    function readouts(dev) {
      const d = S[dev], L = cfg.limits, lvOf = { battV: L.battV, tempC: L.tempC, cpuTempC: L.cpuTempC, cpuPct: L.cpuPct, memPct: L.memPct, diskPct: L.diskPct, snr: L.snr, rssi: L.rssi, dutyPct: L.dutyPct };
      const show = (key, v) => {
        if (v == null || v === '') return '–';
        if (key === 'uptimeS') return fmtUp(v);
        if (key === 'lastRxT') { const s = Math.round((Date.now() - v) / 1000); return s < 120 ? `${s} s ago` : `${Math.round(s / 60)} min ago`; }
        if (key === 'cr') return `4/${v}`;
        if (key === 'serial') return v === 'up' ? '● UP' : '✖ DOWN';
        if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(key === 'battV' ? 2 : key === 'freqMHz' ? 3 : 1);
        return String(v);
      };
      const val = (key) => key === 'dutyPct' && dev === 'rpt' && d.dutyPct == null ? S.duty : key === 'serial' ? S.serial : d[key];
      return C.FIELDS[dev].map(([key, label, unit]) => {
        const v = val(key), lv = lvOf[key] ? C.level(v, lvOf[key]) : key === 'serial' && v === 'down' ? 'alarm' : '';
        return `<div class="ss-ro" data-lv="${lv}"><dt>${label}</dt><dd>${esc(show(key, v))}${v != null && unit && !['uptimeS', 'lastRxT'].includes(key) ? ` <i>${unit}</i>` : ''}${lv === 'alarm' ? ' ✖' : lv === 'warn' ? ' ⚠' : ''}</dd></div>`;
      }).join('');
    }
    function panels() {
      const L = cfg.limits, r = S.rpt, c = S.cmp, h = S.host;
      setGauge('ss-g-batt', r.battV, C.level(r.battV, L.battV), 2);
      setBar('ss-b-bpct', r.battPct ?? C.battPct(r.battV), 100, C.level(r.battV, L.battV), 0);
      setBar('ss-b-solar', r.solarW, cfg.solar.panelW, '', 2);
      setBar('ss-b-temp', r.tempC, 80, C.level(r.tempC, L.tempC), 1);
      setGauge('ss-g-rssi', c.rssi, C.level(c.rssi, L.rssi), 0);
      setBar('ss-b-snr', c.snr == null ? null : c.snr + 20, 35, C.level(c.snr, L.snr), 1, c.snr == null ? '–' : num(c.snr, 1));
      setGauge('ss-g-cpu', h.cpuPct, C.level(h.cpuPct, L.cpuPct), 0);
      setBar('ss-b-ctemp', h.cpuTempC, 90, C.level(h.cpuTempC, L.cpuTempC), 1);
      setBar('ss-b-mem', h.memPct, 100, C.level(h.memPct, L.memPct), 0);
      setBar('ss-b-disk', h.diskPct, 100, C.level(h.diskPct, L.diskPct), 0);
      for (const dev of ['rpt', 'cmp', 'host']) { const el = root.querySelector(`#ss-ro-${dev}`); if (el) el.innerHTML = readouts(dev); }
      const nm = root.querySelector('#ss-rpt-name'); if (nm) nm.textContent = S.rpt.name || '';
      const cn = root.querySelector('#ss-cmp-name'); if (cn) cn.textContent = S.cmp.name || '';
      const hn = root.querySelector('#ss-host-name'); if (hn) hn.textContent = S.host.hostName || '';
      if (srcKind !== 'sim') {   // say what a live source can't report, so a dash isn't a mystery
        const n = root.querySelector('#ss-live-note'), say = t => { if (n) n.textContent = t; };
        // not connected at all: say how, before listing what's missing (2026-10-23: the WebSocket picked on a Pi that had no stub)
        if (srcKind === 'kelly' && k.live.status() !== 'on') return say("⚠ Your node isn't connected. On the 🕸️ Mesh tab: Device MeshCore (companion), Node link Kelly bridge, Connect -- this tab follows it.");
        if (srcKind === 'ws' && S.serial === 'down') return say(`⚠ Nothing answering at ${cfg.wsUrl}. This source is only for a Pi running bridge/station_scada_bridge.py. If your node is on the Kelly bridge, pick "Kelly's mesh link" instead.`);
        const miss = [S.rpt.solarW == null && 'solar power (MeshCore doesn\'t report it)', S.host.cpuPct == null && (srcKind === 'kelly' ? 'Pi stats (Kelly bridge /api/host)' : 'Pi stats'),
          S.rpt.battV == null && (srcKind === 'kelly' ? 'repeater status (Mesh tab > Repeater management: log in, ⏱ Status every 15 min)' : 'repeater status (station_scada_bridge.py --repeater)')].filter(Boolean);
        const c = S.cmp, r = cfg.radio, off = c.sf != null && (c.sf !== r.sf || c.bwKHz !== r.bwKHz || Math.abs((c.freqMHz || 0) - r.freqMHz) > 0.001 || c.cr !== r.cr);
        if (off) miss.unshift(`⚠ your node runs ${c.freqMHz} MHz / BW ${c.bwKHz} / SF${c.sf} / CR4/${c.cr} but Config says ${r.freqMHz} / ${r.bwKHz} / SF${r.sf} / CR4/${r.cr} -- airtime and link maths use Config`);
        say(miss.length ? `${off ? '' : 'Not reported yet: '}${miss.join(' · ')}` : '');
      }
    }
    // airtime over the last 10 min, as the mast sees it: TX duty (its own) and channel busy (everything)
    function airtime(now) {
      S.air = S.air.filter(a => now - a.t < 600000); S.crc = S.crc.filter(t => now - t < 600000);
      const tx = S.air.filter(a => a.tx).reduce((s, a) => s + a.ms, 0), all = S.air.reduce((s, a) => s + a.ms, 0);
      S.duty = 100 * tx / 600000; S.busy = 100 * all / 600000;
    }
    // the annunciator state machine: normal -> UNACK (flashes 3x, then steady) -> ACK; clears to RTN (returned, unacked) or normal
    function alarms(now) {
      const s = { rpt: S.rpt, host: S.host, serial: S.serial, lastRxT: S.lastRxT || null, now, dutyPct: S.rpt.dutyPct ?? S.duty, crc10: S.crc.length };
      for (const a of C.evalAlarms(s, cfg.limits)) {
        const st = S.alarms[a.id] = S.alarms[a.id] || { state: 'normal' };
        st.label = a.label; st.why = a.why; st.level = a.level;
        if (a.on && (st.state === 'normal' || st.state === 'rtn')) {
          st.state = 'unack'; st.since = now; st.flashUntil = now + 3000;
          hist(a.level === 'alarm' ? 'alarm' : 'warn', a.id, `${a.label} ${a.why ? `(${a.why})` : ''}`); if (isActive()) playS('alarm');
        } else if (!a.on && st.state === 'ack') { st.state = 'normal'; hist('info', a.id, `${a.label} cleared`); }
        else if (!a.on && st.state === 'unack') { st.state = 'rtn'; hist('info', a.id, `${a.label} returned to normal (unacknowledged)`); }
      }
    }
    function ackAll() { for (const [id, st] of Object.entries(S.alarms)) { if (st.state === 'unack') { st.state = 'ack'; hist('info', id, `${st.label} acknowledged`); } else if (st.state === 'rtn') st.state = 'normal'; } tick(Date.now(), true); }
    function resetAll() { S.crc = []; for (const st of Object.values(S.alarms)) if (st.state === 'rtn' || st.state === 'ack') st.state = 'normal'; hist('info', 'SYS', 'Alarms reset (CRC count cleared)'); tick(Date.now(), true); }

    let logSeen = -1;
    function packetLog() {
      if (S.logVer === logSeen) return; logSeen = S.logVer;
      const c = colors(), rows = S.log.slice(-40).reverse();
      ref.log.innerHTML = rows.map((r, i) => {
        const p = r.pkt, tx = r.dir === 'tx', bad = p.crc === 'fail';
        return `<tr data-i="${S.log.length - 1 - i}" class="${bad ? 'bad' : tx ? 'tx' : 'rx'}${S.sel === r ? ' sel' : ''}"><td>${new Date(r.t).toTimeString().slice(0, 8)}</td>
          <td><b style="color:${bad ? c.err : tx ? c.tx : c.rx}">${bad ? '✖ CRC' : tx ? '▲ TX' : '▼ RX'}</b></td><td>${r.dev === 'rpt' ? 'RPT-01' : 'CMP-01'}${r.fwd ? ' fwd' : ''}${r.retry ? ` r${r.retry}` : ''}</td>
          <td>${esc(p.type || '')}</td><td>${esc(p.route || '')}</td><td>${p.hops ?? ''}</td><td>${p.snr != null ? `${num(p.snr, 1)} / ${p.rssi ?? '–'}` : '–'}</td><td>${p.len || ''}</td><td>${Math.round(r.air)}</td></tr>`;
      }).join('') || '<tr><td colspan="9" class="dim">Nothing on air yet</td></tr>';
    }
    function inspect(rec) { S.sel = rec; S.selVer++; logSeen = -1; const c = comps.find(x => x.id === 'inspector'); if (c && c.on) { c.el.classList.add('ss-pop'); setTimeout(() => c.el.classList.remove('ss-pop'), 700); if (c.tick) c.tick(Date.now(), api); } }

    function tick(now, force) {
      airtime(now);
      sky(); tags(); panels(); alarms(now); packetLog(); drawHorizon();
      if (!S.lastSample || now - S.lastSample >= 10000 || force) sample(now);
      for (const c of comps) if (c.on && c.tick) try { c.tick(now, api); } catch (er) { console.warn('Station SCADA', c.id, er); }
      const rate = S.log.filter(r => now - r.t < 60000).length;
      ref.status.innerHTML = `<span>${srcKind === 'sim' ? '🎮 SIMULATION' : srcKind === 'kelly' ? "📡 LIVE · Kelly's mesh link" : '🍓 LIVE · bridge'}</span><span>Serial <b class="${S.serial === 'up' ? 'ok' : 'alarm'}">${S.serial === 'up' ? 'UP' : 'DOWN'}</b></span>`
        + `<span>${rate} pkt/min</span><span>Air ${num(S.busy, 2)} %</span><span>${cfg.radio.freqMHz.toFixed(3)} MHz · BW ${cfg.radio.bwKHz} · SF${cfg.radio.sf} · CR4/${cfg.radio.cr}</span>`;
    }
    function sample(now) {
      S.lastSample = now;
      const rate = S.log.filter(r => now - r.t < 60000).length;
      S.trend.push({ t: now, rssi: S.cmp.rssi ?? null, snr: S.cmp.snr ?? null, batt: S.rpt.battV ?? null, rate, solar: S.rpt.solarW ?? null, soc: S.rpt.battPct ?? null });
      if (S.trend.length > 8640) S.trend.splice(0, S.trend.length - 8640);
    }

    // ------------------------------------------------------------------ the loop
    function frame() {
      if (!isActive()) { running = false; return 600; }
      const now = Date.now();
      if (!running) { running = true; if (!src) startSource(cfg.source); tick(now, true); }
      if (src && src.step) src.step(now);
      if (now - lastTick >= 1000) { lastTick = now; tick(now); }
      const pn = performance.now();
      let busy = frameFx(pn);
      for (const c of comps) if (c.on && c.frame) try { busy = c.frame(pn, api) || busy; } catch (er) { console.warn('Station SCADA', c.id, er); }
      return busy ? 0 : 200;
    }

    // ------------------------------------------------------------------ build the tab
    const api = { C, S, cfg: () => cfg, esc, fmtAgo: k.fmtAgo, colors, reduced, inspect, ackAll, resetAll, hist, num, fmtUp, store: k.store,
      nbrs: () => [...S.nbrs.values()].sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0)),
      nbrName: h => { const n = [...S.nbrs.values()].find(x => x.hash && h && (x.hash.startsWith(h) || h.startsWith(x.hash))); return n ? n.name : h === 'a3f0' && srcKind === 'sim' ? 'RPT-01 (this mast)' : null; },
      selNbr: () => S.nbrs.get(S.selNbr) || api.nbrs().find(n => n.distKm) || null, setSelNbr: id => { S.selNbr = id; nbrSig = ''; tick(Date.now(), true); },
      setCfg: (path, v) => setOv(path, v), srcKind: () => srcKind, isActive };
    function build() {
      if (built) return; built = true;
      const comp = (window.StationScadaPanels || []).map(f => { try { return typeof f === 'function' ? f() : f; } catch (er) { console.warn('Station SCADA panel', er); return null; } }).filter(Boolean);
      const featLabel = { hoptrace: '🛰️ Hop path trace', weather: '⛅ Weather & sky', cwid: '📻 CW ID button' };
      root.innerHTML = `
        <div class="ss-bar-top card">
          <div class="ss-title"><span class="ss-logo">🏭</span><div><h2>Station SCADA</h2><small>MeshCore home station · plant HMI</small></div></div>
          <div class="ss-status" id="ss-status"></div>
          <div class="row gap wrap ss-ctl">
            <label class="fld"><span>Data source</span><select id="ss-src"><option value="sim">🎮 Simulation</option><option value="kelly">📡 Kelly's mesh link (live -- your node)</option><option value="ws">🍓 Separate Pi bridge (station_scada_bridge.py)</option></select></label>
            <label class="fld" id="ss-wsw" hidden><span>station_scada_bridge.py address</span><input id="ss-ws" size="28" autocomplete="off" placeholder="ws://raspberrypi.local:8765/scada"></label>
            <label class="fld" id="ss-dayw"><span>Day lasts</span><select id="ss-day"><option value="6">6 min</option><option value="24">24 min</option><option value="60">1 hour</option><option value="1440">24 h (real time)</option></select></label>
            <label class="fld"><span>Theme</span><select id="ss-theme"><option value="control">🖥️ Control room</option><option value="crt">📟 Green phosphor CRT</option></select></label>
            <div class="ss-snd"><button class="btn ghost small" id="ss-mute" aria-pressed="false"></button><input type="range" id="ss-vol" min="0" max="100" aria-label="Volume"></div>
            <button class="btn ghost small" id="ss-cw" title="Your callsign in Morse: the shack's TX LED keys in time (sound only -- nothing is transmitted)"></button>
          </div>
          <div class="row gap wrap ss-inject" id="ss-inject">
            <span class="small dim">Make something happen:</span>
            <button class="btn ghost small" data-inj="traffic">📨 Packet</button><button class="btn ghost small" data-inj="burst">📶 Busy channel</button><button class="btn ghost small" data-inj="crc">💥 CRC storm</button>
            <button class="btn ghost small" data-inj="usb">🔌 Pull / replug USB</button><button class="btn ghost small" data-inj="lowbatt">🪫 Flat battery</button><button class="btn ghost small" data-inj="heat">🔥 Heatwave</button><button class="btn ghost small" data-inj="lightning">⚡ Lightning</button>
          </div>
          <div class="small" id="ss-live-note" style="color:var(--amber)"></div>
        </div>
        <div class="card ss-mimic-card">${mimicSvg()}
          <div class="ss-legend" aria-hidden="false"><span><i style="background:var(--ss-tx)"></i>▲ TX</span><span><i style="background:var(--ss-rx)"></i>▼ RX</span><span><i style="background:var(--ss-rxalt)"></i>Hop trace</span><span><i style="background:var(--ss-usb)"></i>USB serial</span><span><i style="background:var(--ss-err)"></i>✖ CRC / error</span></div>
        </div>
        <div class="ss-devs">
          <div class="card ss-dev-card" data-dev="rpt"><div class="card-h"><h2>📡 RPT-01 · SenseCAP Solar P1</h2><span class="tag" id="ss-rpt-name"></span></div>
            <div class="ss-gauges">${gauge('ss-g-batt', 'Battery', 'V', 3.2, 4.3)}<div class="ss-bars">${bar('ss-b-bpct', 'Charge', '%')}${bar('ss-b-solar', 'Solar', 'W')}${bar('ss-b-temp', 'Enclosure', '°C')}</div></div>
            <dl class="ss-ros" id="ss-ro-rpt"></dl></div>
          <div class="card ss-dev-card" data-dev="cmp"><div class="card-h"><h2>🔷 CMP-01 · RAK4631</h2><span class="tag" id="ss-cmp-name"></span></div>
            <div class="ss-gauges">${gauge('ss-g-rssi', 'RSSI', 'dBm', -130, -30)}<div class="ss-bars">${bar('ss-b-snr', 'SNR', 'dB')}</div></div>
            <dl class="ss-ros" id="ss-ro-cmp"></dl></div>
          <div class="card ss-dev-card" data-dev="host"><div class="card-h"><h2>🍓 HOST-01 · Raspberry Pi 4</h2><span class="tag" id="ss-host-name"></span></div>
            <div class="ss-gauges">${gauge('ss-g-cpu', 'CPU', '%', 0, 100)}<div class="ss-bars">${bar('ss-b-ctemp', 'CPU temp', '°C')}${bar('ss-b-mem', 'RAM', '%')}${bar('ss-b-disk', 'Disk', '%')}</div></div>
            <dl class="ss-ros" id="ss-ro-host"></dl></div>
        </div>
        <div class="ss-grid" id="ss-grid">
          <div class="card ss-logcard ss-wide"><div class="card-h"><h2>📜 Packet log</h2><span class="small dim">click a line (or a pulse on the mimic) to inspect it</span></div>
            <div class="ss-logwrap"><table class="ss-log"><thead><tr><th>Time</th><th>Dir</th><th>Where</th><th>Type</th><th>Route</th><th>Hops</th><th>SNR / RSSI</th><th>Bytes</th><th>Air ms</th></tr></thead><tbody id="ss-log"></tbody></table></div></div>
        </div>
        <details class="card ss-cfg"><summary>⚙️ Components &amp; config</summary>
          <div class="ss-feats" id="ss-feats"></div>
          <div class="row gap wrap"><label class="fld"><span>Radio preset (must match your nodes)</span><select id="ss-preset">${Object.entries(C.PRESETS).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join('')}<option value="custom">Custom (edit below)</option></select></label>
            <label class="fld"><span>Callsign for CW ID</span><input id="ss-call" size="9" maxlength="10" autocomplete="off"></label></div>
          <p class="small dim">Radio params, colours, antennas (gain, cable loss, height), terrain obstacles for the Fresnel view, alarm limits, the solar model and the simulation -- as JSON. Only what you change is saved; <b>Reset</b> goes back to the defaults.</p>
          <textarea id="ss-json" rows="14" spellcheck="false"></textarea>
          <div class="row gap"><button class="btn primary small" id="ss-save">Save config</button><button class="btn ghost small" id="ss-reset">Reset to defaults</button><span class="small dim" id="ss-cfgmsg"></span></div>
        </details>`;
      svg = root.querySelector('.ss-mimic');
      ref = { svg, fx: svg.querySelector('#ss-fx'), nbr: svg.querySelector('#ss-nbr'), sun: svg.querySelector('#ss-sun'), day: svg.querySelector('#ss-sky-day'), dusk: svg.querySelector('#ss-sky-dusk'),
        stars: svg.querySelector('#ss-stars'), clouds: svg.querySelector('#ss-clouds'), clock: svg.querySelector('#ss-clock'), flow: svg.querySelector('#ss-flow'), solar: svg.querySelector('#ss-solarlbl'),
        batt: svg.querySelector('#ss-battfill'), arr: svg.querySelector('#ss-arr'), bolt: svg.querySelector('#ss-bolt'), flash: svg.querySelector('#ss-flashov'), cap: svg.querySelector('#ss-caption'),
        usbLine: svg.querySelector('#ss-usb'), log: root.querySelector('#ss-log'), status: root.querySelector('#ss-status'),
        tag: { rpt: svg.querySelector('#ss-tag-rpt'), cmp: svg.querySelector('#ss-tag-cmp'), host: svg.querySelector('#ss-tag-host') },
        led: { 'rpt-tx': svg.querySelector('#ss-led-rpt-tx'), 'rpt-rx': svg.querySelector('#ss-led-rpt-rx'), 'cmp-tx': svg.querySelector('#ss-led-cmp-tx'), 'cmp-rx': svg.querySelector('#ss-led-cmp-rx'), 'host-usb': svg.querySelector('#ss-led-host-usb') },
        ant: { rpt: svg.querySelector('#ss-rpt-ant'), cmp: svg.querySelector('#ss-cmp-ant') } };
      // the extras: each its own card, switchable
      const grid = root.querySelector('#ss-grid');
      for (const f of comp) {
        const c = f; c.on = on(c.id);
        c.el = document.createElement('div'); c.el.className = `card ss-comp${c.wide ? ' ss-wide' : ''}`; c.el.dataset.comp = c.id; c.el.hidden = !c.on;
        c.el.innerHTML = `<div class="card-h"><h2>${c.icon} ${esc(c.title)}</h2>${c.tag ? `<span class="tag" id="ss-tag-${c.id}"></span>` : ''}</div><div class="ss-cbody">${c.html ? c.html(api) : ''}</div>`;
        (c.first ? grid.insertBefore(c.el, grid.firstChild) : grid.appendChild(c.el));
        if (c.mount) try { c.mount(c.el, api); } catch (er) { console.warn('Station SCADA', c.id, er); }
        comps.push(c);
      }
      root.querySelector('#ss-feats').innerHTML = Object.keys(C.DEFAULTS.features).map(id => {
        const c = comps.find(x => x.id === id), label = c ? `${c.icon} ${c.title}` : featLabel[id] || id;
        return `<label class="tog small"><input type="checkbox" data-feat="${id}"${on(id) ? ' checked' : ''}><i></i><span>${esc(label)}</span></label>`;
      }).join('');
      bind();
      applyTheme(); paintSource(); paintSound(); paintCfg();
    }
    function applyTheme() {
      root.classList.toggle('ss-crt', cfg.theme === 'crt');
      const c = colors(); root.style.setProperty('--ss-tx', c.tx); root.style.setProperty('--ss-rx', c.rx); root.style.setProperty('--ss-rxalt', c.rxAlt); root.style.setProperty('--ss-usb', c.usb); root.style.setProperty('--ss-err', c.err); root.style.setProperty('--ss-idle', c.idle);
    }
    function paintSource() {
      if (!built) return;
      root.querySelector('#ss-src').value = cfg.source; root.querySelector('#ss-wsw').hidden = cfg.source !== 'ws'; root.querySelector('#ss-ws').value = cfg.wsUrl;
      root.querySelector('#ss-dayw').hidden = cfg.source !== 'sim'; root.querySelector('#ss-day').value = String(cfg.sim.dayMin);
      root.querySelector('#ss-inject').hidden = cfg.source !== 'sim';
      root.querySelector('#ss-live-note').textContent = '';
      root.querySelector('#ss-theme').value = cfg.theme;
    }
    function paintSound() {
      const b = root.querySelector('#ss-mute'); if (!audio) { b.hidden = true; root.querySelector('#ss-vol').hidden = true; return; }
      b.textContent = audio.muted ? '🔇 Sound off' : '🔊 Sound on'; b.setAttribute('aria-pressed', String(!audio.muted));
      root.querySelector('#ss-vol').value = Math.round(audio.volume * 100);
      const cw = root.querySelector('#ss-cw'); cw.hidden = !on('cwid'); cw.textContent = `📻 CW ID ${callsign()}`;
    }
    const callsign = () => (ov.call || k.myCall() || 'VK4XXX').toUpperCase();
    function paintCfg() {
      const show = { radio: cfg.radio, colors: cfg.colors, colorsCrt: cfg.colorsCrt, ant: cfg.ant, terrain: cfg.terrain, limits: cfg.limits, solar: cfg.solar, sim: cfg.sim, names: cfg.names };
      root.querySelector('#ss-json').value = JSON.stringify(show, null, 2);
      root.querySelector('#ss-preset').value = C.PRESETS[cfg.radio.preset] ? cfg.radio.preset : 'custom';
      root.querySelector('#ss-call').value = ov.call || '';
    }
    function bind() {
      root.querySelector('#ss-src').onchange = e => { setOv('source', e.target.value); resetData(); paintSource(); if (running) startSource(cfg.source); else stopSource(); };
      root.querySelector('#ss-ws').onchange = e => { setOv('wsUrl', e.target.value.trim()); if (cfg.source === 'ws' && running) startSource('ws'); };
      root.querySelector('#ss-day').onchange = e => { setOv('sim.dayMin', +e.target.value); if (src && src.reconfig) src.reconfig(cfg); };
      root.querySelector('#ss-theme').onchange = e => { setOv('theme', e.target.value); applyTheme(); logSeen = -1; };
      root.querySelector('#ss-mute').onclick = () => { audio.setMuted(!audio.muted); paintSound(); };
      root.querySelector('#ss-vol').oninput = e => { audio.setVolume(e.target.value / 100); if (audio.muted) { audio.setMuted(false); paintSound(); } };
      root.querySelector('#ss-cw').onclick = () => {
        const btn = root.querySelector('#ss-cw'); btn.disabled = true;
        hist('info', 'CMP-01', `CW ID: ${callsign()} (sound only, not transmitted)`);
        const ms = audio ? audio.cw(callsign(), down => { const el = ref.led['cmp-tx']; if (el) el.classList.toggle('on', down); const a = ref.ant.cmp; a.classList.toggle('glow', down); a.style.fill = down ? colors().tx : ''; }) : 0;
        setTimeout(() => { btn.disabled = false; }, ms + 200);
      };
      root.querySelector('#ss-inject').onclick = e => { const b = e.target.closest('[data-inj]'); if (b && src && src.inject) { src.inject(b.dataset.inj, Date.now()); hist('info', 'SIM', `Injected: ${b.textContent.trim()}`); } };
      root.querySelector('#ss-feats').onchange = e => {
        const id = e.target.dataset.feat; if (!id) return;
        setOv(`features.${id}`, e.target.checked);
        const c = comps.find(x => x.id === id); if (c) { c.on = e.target.checked; c.el.hidden = !c.on; if (c.on && c.tick) c.tick(Date.now(), api); }
        paintSound(); tick(Date.now(), true);
      };
      root.querySelector('#ss-preset').onchange = e => { const p = C.PRESETS[e.target.value]; if (!p) return; setOv('radio', Object.assign({}, ov.cfg.radio || {}, { preset: e.target.value, freqMHz: p.freqMHz, bwKHz: p.bwKHz, sf: p.sf, cr: p.cr })); paintCfg(); if (src && src.reconfig) src.reconfig(cfg); tick(Date.now(), true); };
      root.querySelector('#ss-call').onchange = e => { ov.call = e.target.value.trim().toUpperCase(); save(); paintSound(); };
      root.querySelector('#ss-save').onclick = () => {
        const msg = root.querySelector('#ss-cfgmsg');
        let j; try { j = JSON.parse(root.querySelector('#ss-json').value); } catch (er) { msg.textContent = `Not valid JSON: ${er.message}`; return; }
        // keep only what differs from the defaults, so a later default change still reaches you
        const diff = (a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) return undefined; if (a && b && typeof a === 'object' && !Array.isArray(a)) { const o = {}; for (const key of Object.keys(a)) { const d = diff(a[key], b[key]); if (d !== undefined) o[key] = d; } return Object.keys(o).length ? o : undefined; } return a; };
        for (const key of Object.keys(j)) { const d = diff(j[key], C.DEFAULTS[key]); if (d === undefined) delete ov.cfg[key]; else ov.cfg[key] = d; }
        if (ov.cfg.radio && !C.PRESETS[cfg.radio.preset]) ov.cfg.radio.preset = 'custom';
        cfg = C.merge(C.DEFAULTS, ov.cfg); save(); applyTheme(); paintCfg(); if (src && src.reconfig) src.reconfig(cfg);
        msg.textContent = 'Saved'; setTimeout(() => { msg.textContent = ''; }, 2500); tick(Date.now(), true);
      };
      root.querySelector('#ss-reset').onclick = () => { const keep = { source: ov.cfg.source, wsUrl: ov.cfg.wsUrl, theme: ov.cfg.theme, features: ov.cfg.features }; ov.cfg = JSON.parse(JSON.stringify(keep)); cfg = C.merge(C.DEFAULTS, ov.cfg); save(); applyTheme(); paintCfg(); if (src && src.reconfig) src.reconfig(cfg); tick(Date.now(), true); };
      ref.log.onclick = e => { const tr = e.target.closest('tr[data-i]'); if (tr) inspect(S.log[+tr.dataset.i]); };
      ref.nbr.addEventListener('click', e => { const g = e.target.closest('[data-nbr]'); if (g) api.setSelNbr(g.dataset.nbr); });
      svg.addEventListener('keydown', e => { if (e.key === 'Enter') { const g = e.target.closest('[data-nbr]'); if (g) api.setSelNbr(g.dataset.nbr); } });
    }

    function init() {
      root = k.$('#ss-root'); if (!root) return;
      build();
      if (cfg.source !== 'sim') startSource(cfg.source);   // live: collect from the start (state only; animations while shown)
      setInterval(() => { if (src && !isActive() && srcKind !== 'sim') { const now = Date.now(); airtime(now); alarms(now); if (now - (S.lastSample || 0) >= 10000) sample(now); } }, 10000);
      const loop = k.fxLoop || (draw => { const step = now => setTimeout(() => requestAnimationFrame(step), draw(now)); requestAnimationFrame(step); });
      loop(frame);
    }
    // from mesh.js: what Kelly's own MeshCore session sees (only used while the source is "Kelly's mesh link")
    function feed(kind, ...a) { if (srcKind === 'kelly' && src && src.feed) src.feed(kind, ...a); }
    function shown() { lastTick = 0; nbrSig = ''; }
    return { init, feed, shown, state: S };
  };
})();
