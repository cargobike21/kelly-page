/* Kelly Page -- Station SCADA extras: each one its own switchable component (Components & config on the tab).
 * window.StationScadaPanels = [ factory() -> { id, icon, title, wide?, tag?, html(api), mount(el, api), event(e, api),
 *   tick(now, api) (1 Hz while the tab shows), frame(now, api) -> true while it's moving } ]
 * api comes from stationscada-ui.js (state S, cfg(), colors(), inspect(), the neighbour selection, ...).
 * Same house rules: nothing animates unless something happened; reduced motion = no needle swings, no scrolling sweeps.
 */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const hexRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0x39ff88; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ago = ms => { const s = Math.round(ms / 1000); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; };
  // a neighbour picker shared by the link budget and Fresnel views
  const nbrSelect = (api, id) => {
    const sel = api.selNbr(), list = api.nbrs();
    return `<select id="${id}" class="ss-nsel">${list.length ? list.map(n => `<option value="${api.esc(n.id)}"${sel && sel.id === n.id ? ' selected' : ''}>${api.esc(n.name || n.id)}${n.distKm != null ? ` · ${n.distKm.toFixed(1)} km` : ''}</option>`).join('') : '<option>No neighbours heard yet</option>'}</select>`;
  };
  const bindSelect = (el, sel, api) => { el.addEventListener('change', e => { if (e.target.matches(sel)) api.setSelNbr(e.target.value); }); };

  // ---------------------------------------------------------------- 1. LoRa chirp waterfall
  function waterfall() {
    let cv, g, W = 720, H = 150, sig = [], lastRow = 0, tailUntil = 0, img;
    const ROW_MS = 25, SPAN = 6;   // a row every 25 ms; the strip shows 6x the bandwidth, so a chirp is a steep diagonal
    return {
      id: 'waterfall', icon: '🌊', title: 'LoRa chirp waterfall', wide: true, tag: true, first: true,
      html: () => `<canvas class="ss-wf" width="${W}" height="${H}" aria-label="Waterfall: packets on air drawn as chirp sweeps"></canvas><div class="ss-wfaxis small dim"><span id="ss-wf-lo"></span><span>time ↓ (stretched so a 0.3 s packet shows) · frequency →</span><span id="ss-wf-hi"></span></div>`,
      mount(el) {
        cv = el.querySelector('canvas'); g = cv.getContext('2d'); g.fillStyle = '#03060f'; g.fillRect(0, 0, W, H); img = g.createImageData(W, 1);
      },
      event(e, api) {
        if (e.type !== 'rf' || (e.dev === 'cmp' && e.dir === 'rx')) return;   // the shack's RX of the mast's repeat = the same air
        const c = api.colors(), p = e.pkt || {}, air = api.C.airtimeMs(p.len || 20, api.cfg().radio);
        const kind = p.crc === 'fail' ? 'err' : e.dir === 'tx' && e.dev !== 'nbr' ? 'tx' : 'rx';
        const off = e.dev === 'nbr' ? ((parseInt(String(e.peer).replace(/\D/g, '') || '1', 10) * 37) % 11 - 5) / 400 : e.dev === 'cmp' ? 0.006 : 0;   // crystal offsets, a few kHz
        const strength = kind === 'tx' ? 1 : clamp(((p.snr ?? -5) + 20) / 30, 0.25, 1) * (e.dev === 'nbr' ? 0.55 : 1);
        sig.push({ t0: performance.now(), dur: clamp(air * 4, 2400, 4400), col: hexRgb(kind === 'tx' ? c.tx : kind === 'err' ? c.err : c.rx), off, strength, seed: Math.random() * 1000 | 0, kind });
        if (sig.length > 12) sig.shift();
      },
      tick(now, api) {
        const r = api.cfg().radio, span = r.bwKHz * SPAN;
        const lo = document.getElementById('ss-wf-lo'), hi = document.getElementById('ss-wf-hi'), tag = document.getElementById('ss-tag-waterfall');
        if (lo) lo.textContent = `${(r.freqMHz - span / 2000).toFixed(3)} MHz`; if (hi) hi.textContent = `${(r.freqMHz + span / 2000).toFixed(3)} MHz`;
        if (tag) tag.textContent = `SF${r.sf} · BW ${r.bwKHz} kHz · ${sig.some(s => performance.now() - s.t0 < s.dur) ? 'ON AIR' : 'quiet'}`;
      },
      frame(now, api) {
        if (!g) return false;
        sig = sig.filter(s => now - s.t0 < s.dur);
        if (sig.length) tailUntil = now + 2500;
        if (now > tailUntil) return false;            // quiet air: the waterfall stands still (no endless scrolling)
        if (now - lastRow < ROW_MS) return true;
        lastRow = now;
        g.drawImage(cv, 0, 0, W, H - 1, 0, 1, W, H - 1);
        const d = img.data, bandW = W / SPAN, mid = W / 2;
        for (let x = 0; x < W; x++) { const n = 10 + Math.random() * 22; d[x * 4] = n * 0.25; d[x * 4 + 1] = n * 0.45; d[x * 4 + 2] = n; d[x * 4 + 3] = 255; }
        const rows = api.reduced() ? 40 : 24;         // rows per chirp: slower sweeps with reduced motion
        for (const s of sig) {
          const el = now - s.t0, row = Math.floor(el / ROW_MS), sym = Math.floor(row / rows), within = (row % rows) / rows;
          const lft = mid + s.off * W - bandW / 2;
          for (let x = Math.max(0, lft | 0); x < Math.min(W, lft + bandW); x++) { d[x * 4] += s.col[0] * 0.08 * s.strength; d[x * 4 + 1] += s.col[1] * 0.08 * s.strength; d[x * 4 + 2] += s.col[2] * 0.08 * s.strength; }
          // preamble: up-chirps; sync word: 2 down-chirps; then data symbols: up-chirps starting at a symbol-value offset (cyclic)
          let f;
          if (sym < 3) f = within; else if (sym < 4) f = 1 - within; else f = (within + ((s.seed * (sym + 3) * 2654435761) >>> 0) % 997 / 997) % 1;
          // this row's piece of the sweep: from where it was a row ago to where it is now (a continuous diagonal)
          const cx = lft + f * bandW, px = s.lastX != null && Math.abs(cx - s.lastX) < bandW / 2 ? s.lastX : cx;
          s.lastX = cx;
          for (let x = Math.max(0, Math.round(Math.min(px, cx)) - 1); x <= Math.min(W - 1, Math.round(Math.max(px, cx)) + 1); x++) {
            const a = s.strength;
            d[x * 4] = Math.min(255, d[x * 4] + s.col[0] * a); d[x * 4 + 1] = Math.min(255, d[x * 4 + 1] + s.col[1] * a); d[x * 4 + 2] = Math.min(255, d[x * 4 + 2] + s.col[2] * a);
          }
        }
        g.putImageData(img, 0, 0);
        return true;
      },
    };
  }

  // ---------------------------------------------------------------- 2. packet inspector
  function inspector() {
    let el, seen = -1;
    const dump = hex => {
      const b = (hex || '').match(/../g) || [], out = [];
      for (let i = 0; i < b.length; i += 16) {
        const row = b.slice(i, i + 16);
        out.push(`${i.toString(16).padStart(4, '0')}  ${row.join(' ').padEnd(47)}  ${row.map(h => { const c = parseInt(h, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '·'; }).join('')}`);
      }
      return out.join('\n');
    };
    return {
      id: 'inspector', icon: '🔬', title: 'Packet inspector', wide: false,
      html: () => '<div class="ss-insp" id="ss-insp"><p class="dim small">Click a line in the packet log, or a pulse on the mimic.</p></div>',
      mount(e) { el = e.querySelector('#ss-insp'); },
      tick(now, api) {
        const S = api.S; if (S.selVer === seen || !S.sel) return; seen = S.selVer;
        const r = S.sel, p = r.pkt || {}, cfg = api.cfg(), C = api.C, esc = api.esc;
        const bytes = p.hex ? Uint8Array.from(p.hex.match(/../g).map(h => parseInt(h, 16))) : null, dec = bytes ? C.decodePacket(bytes) : null;
        const sens = C.sensitivity(cfg.radio), ts = C.symbolMs(cfg.radio);
        const hdr = bytes ? bytes[0] : null;
        const names = (p.path || []).map(h => `<code>${esc(h)}</code>${api.nbrName(h) ? ` ${esc(api.nbrName(h))}` : ''}`).join(' → ');
        const rows = [
          ['Direction', `${r.dir === 'tx' ? '▲ TX' : '▼ RX'} at ${r.dev === 'rpt' ? 'RPT-01 (mast)' : r.dev === 'cmp' ? 'CMP-01 (shack)' : 'neighbour'}${r.fwd ? ' · repeated' : ''}${r.retry ? ` · retry ${r.retry}` : ''}`],
          ['Packet type', esc(p.type || '?')], ['Route', `${esc(p.route || '?')}${dec ? ` (${dec.routeName}${dec.transport ? ', transport codes' : ''})` : ''}`],
          ['Hops / path', `${p.hops ?? 0}${names ? ` · ${names}` : ''}${dec ? ` · ${dec.hashSize}-byte hashes` : ''}`],
          ['SNR / RSSI', p.snr != null ? `${api.num(p.snr, 2)} dB / ${p.rssi ?? '–'} dBm · margin ${p.rssi != null ? `${api.num(p.rssi - sens, 1)} dB over ${api.num(sens, 1)} dBm` : '–'} · SNR floor SF${cfg.radio.sf} ${C.SNR_LIMIT[cfg.radio.sf]} dB` : '– (not measured here)'],
          ['CRC', p.crc === 'fail' ? '✖ FAILED (dropped, not repeated)' : '✓ ok'],
          ['Size', `${p.len || '?'} bytes${dec ? ` (header ${dec.headerLen + dec.path.length * dec.hashSize}, payload ${dec.payloadLen})` : ''}`],
          ['Airtime', `${api.num(r.air, 1)} ms at SF${cfg.radio.sf} / ${cfg.radio.bwKHz} kHz / CR4/${cfg.radio.cr} (symbol ${api.num(ts, 3)} ms, preamble ${cfg.radio.preamble})`],
          hdr != null ? ['Header byte', `<code>0x${hdr.toString(16).padStart(2, '0')}</code> = route ${(hdr & 3).toString(2).padStart(2, '0')} · type ${((hdr >> 2) & 15).toString(2).padStart(4, '0')} (${esc(dec.type)}) · version ${hdr >> 6}`] : null,
          dec && dec.advert ? ['Advert', `${esc(dec.advert.name || '')} · ${esc(dec.advert.role)}${dec.advert.lat != null ? ` · ${dec.advert.lat.toFixed(4)}, ${dec.advert.lon.toFixed(4)}` : ''} · key <code>${dec.advert.key.slice(0, 16)}…</code>`] : null,
          p.text ? ['Text', `${esc(p.text)} <span class="dim small">(${p.type === 'GRP_TXT' ? 'decrypted by the companion for its channel' : 'decrypted by the companion'})</span>`] : null,
          ['Time', new Date(r.t).toLocaleTimeString()],
        ].filter(Boolean);
        el.innerHTML = `<table class="ss-kv">${rows.map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join('')}</table>`
          + (p.hex ? `<pre class="ss-hex" aria-label="Hex dump">${esc(dump(p.hex))}</pre>` : '<p class="dim small">No raw bytes from this source.</p>');
      },
    };
  }

  // ---------------------------------------------------------------- 4. link budget
  function budget() {
    let el;
    return {
      id: 'budget', icon: '📐', title: 'Link budget',
      html: api => `<div class="row gap wrap"><label class="fld"><span>Mast ↔</span>${nbrSelect(api, 'ss-lb-n')}</label></div><div id="ss-lb"></div>`,
      mount(e, api) { el = e; bindSelect(e, '#ss-lb-n', api); },
      tick(now, api) {
        const cfg = api.cfg(), C = api.C, n = api.selNbr(), box = el.querySelector('#ss-lb'), selEl = el.querySelector('#ss-lb-n');
        if (selEl && selEl.options.length !== api.nbrs().length + (api.nbrs().length ? 0 : 1)) selEl.outerHTML = nbrSelect(api, 'ss-lb-n');
        if (!n) { box.innerHTML = '<p class="dim small">No neighbour heard yet.</p>'; return; }
        const a = cfg.ant, r = cfg.radio;
        const lb = C.linkBudget({ txDbm: r.txDbm, txGain: 3, txCable: 0.5, rxGain: a.rpt.gainDbi, rxCable: a.rpt.cableDb, extraDb: 0, km: n.distKm || 1, mhz: r.freqMHz, rssi: n.rssi, snr: n.snr, radio: r });
        const known = n.distKm != null, m = lb.margin, lv = m < 6 ? 'alarm' : m < 12 ? 'warn' : 'ok';
        const shack = C.linkBudget({ txDbm: r.txDbm, txGain: a.cmp.gainDbi, txCable: a.cmp.cableDb, rxGain: a.rpt.gainDbi, rxCable: a.rpt.cableDb, extraDb: a.extraLossDb, km: 0.02, mhz: r.freqMHz, rssi: api.S.cmp.rssi, radio: r });
        const row = (k, v, cls = '') => `<tr class="${cls}"><th>${k}</th><td>${v}</td></tr>`;
        box.innerHTML = `<table class="ss-kv">${row('TX power (theirs, assumed)', `${r.txDbm} dBm`)}${row('Their antenna / cable', '+3 dBi / −0.5 dB')}
          ${row('Path', known ? `${n.distKm.toFixed(1)} km · free-space loss ${lb.fspl.toFixed(1)} dB` : 'distance unknown (no position) -- measured margin only')}
          ${row('Mast antenna / cable', `+${a.rpt.gainDbi} dBi / −${a.rpt.cableDb} dB`)}
          ${known ? row('Predicted RSSI (free space)', `${lb.predicted.toFixed(1)} dBm`) : ''}${row('Measured RSSI / SNR', n.rssi != null ? `${n.rssi} dBm / ${api.num(n.snr, 1)} dB` : n.snr != null ? `– / ${api.num(n.snr, 1)} dB` : '–')}
          ${row(`Sensitivity (SF${r.sf}, ${r.bwKHz} kHz)`, `${lb.sens.toFixed(1)} dBm`)}
          ${known && n.rssi != null ? row('Excess path loss', `${(lb.predicted - n.rssi).toFixed(1)} dB (terrain, clutter, fading)`) : ''}
          ${row('<b>Link margin</b>', `<b>${m.toFixed(1)} dB</b> ${lv === 'ok' ? '✓' : lv === 'warn' ? '⚠ thin' : '✖ marginal'}${n.rssi == null ? ' (predicted)' : ''}`, lv)}</table>
          <div class="ss-fade" data-lv="${lv}" title="Fade margin: 0-6 dB marginal, 6-12 thin, 12+ good"><i style="transform:scaleX(${clamp(m / 40, 0, 1).toFixed(3)})"></i><span>0</span><span>6</span><span>12</span><span>20</span><span>40 dB</span></div>
          <p class="small dim">Shack ↔ mast: predicted ${shack.predicted.toFixed(0)} dBm through ${a.extraLossDb} dB of walls/roof${api.S.cmp.rssi != null ? `, measured ${api.S.cmp.rssi} dBm` : ''}.</p>`;
      },
    };
  }

  // ---------------------------------------------------------------- 5. Fresnel zone profile
  function fresnel() {
    let el, sig = '';
    return {
      id: 'fresnel', icon: '🏔️', title: 'Fresnel zone',
      html: api => `<div class="row gap wrap"><label class="fld"><span>Mast ↔</span>${nbrSelect(api, 'ss-fz-n')}</label></div><div id="ss-fz"></div>`,
      mount(e, api) { el = e; bindSelect(e, '#ss-fz-n', api); },
      tick(now, api) {
        const cfg = api.cfg(), n = api.selNbr(), box = el.querySelector('#ss-fz'), selEl = el.querySelector('#ss-fz-n');
        if (selEl && selEl.options.length !== api.nbrs().length + (api.nbrs().length ? 0 : 1)) selEl.outerHTML = nbrSelect(api, 'ss-fz-n');
        if (!n || n.distKm == null) { box.innerHTML = '<p class="dim small">Pick a neighbour with a known position.</p>'; sig = ''; return; }
        const a = cfg.ant, elev2 = n.elevM ?? a.siteElevM, h2 = n.hM ?? 10;
        const s = `${n.id}|${JSON.stringify(a)}|${JSON.stringify(cfg.terrain)}|${cfg.radio.freqMHz}|${elev2}`; if (s === sig) return; sig = s;
        const f = api.C.fresnel({ km: n.distKm, mhz: cfg.radio.freqMHz, h1: a.rpt.heightM, elev1: a.siteElevM, h2, elev2, obstacles: cfg.terrain });
        const W = 600, H = 190, pad = 26, ymin = Math.min(a.siteElevM, elev2) - 10;
        const ymax = Math.max(...f.pts.map(p => p.los + p.r1), f.a, f.b) + 10;
        const X = x => pad + x / n.distKm * (W - 2 * pad), Y = y => H - pad - (y - ymin) / (ymax - ymin) * (H - 2 * pad);
        const pts = [{ x: 0, los: f.a, r1: 0, top: a.siteElevM }, ...f.pts, { x: n.distKm, los: f.b, r1: 0, top: elev2 }];
        const up = pts.map(p => `${X(p.x).toFixed(1)},${Y(p.los + p.r1).toFixed(1)}`), dn = pts.slice().reverse().map(p => `${X(p.x).toFixed(1)},${Y(p.los - p.r1).toFixed(1)}`);
        const ground = pts.filter(p => !p.label).map(p => `${X(p.x).toFixed(1)},${Y(p.top).toFixed(1)}`);
        const lv = f.clearPct >= 60 ? 'ok' : f.clearPct >= 0 ? 'warn' : 'alarm';
        const w = f.worstAt;
        box.innerHTML = `<svg class="ss-fz" viewBox="0 0 ${W} ${H}" role="img" aria-label="Path profile with the first Fresnel zone">
          <polygon class="ss-fz-zone" points="${up.join(' ')} ${dn.join(' ')}"/>
          <polygon class="ss-fz-gnd" points="${X(0)},${H - pad} ${ground.join(' ')} ${X(n.distKm)},${H - pad}"/>
          ${cfg.terrain.filter(o => o.atKm < n.distKm).map(o => `<rect class="ss-fz-obs" x="${X(o.atKm) - 4}" y="${Y(a.siteElevM + o.heightM)}" width="8" height="${Math.max(0, Y(a.siteElevM) - Y(a.siteElevM + o.heightM))}"/><text class="ss-fz-t" x="${X(o.atKm)}" y="${Y(a.siteElevM + o.heightM) - 4}" text-anchor="middle">${api.esc(o.label || '')}</text>`).join('')}
          <line class="ss-fz-los" x1="${X(0)}" y1="${Y(f.a)}" x2="${X(n.distKm)}" y2="${Y(f.b)}"/>
          ${w ? `<circle class="ss-fz-w ${lv}" cx="${X(w.x)}" cy="${Y(w.top)}" r="4"/>` : ''}
          <text class="ss-fz-t" x="${X(0) + 4}" y="${Y(f.a) - 6}">RPT-01 ${a.rpt.heightM} m</text><text class="ss-fz-t" x="${X(n.distKm) - 4}" y="${Y(f.b) - 6}" text-anchor="end">${api.esc(n.name || '')} ${h2} m</text>
          <text class="ss-fz-t" x="${W / 2}" y="${H - 6}" text-anchor="middle">${n.distKm.toFixed(1)} km · r₁ at midpath ${f.r1mid.toFixed(1)} m · 4/3 earth</text></svg>
          <p class="ss-fz-v" data-lv="${lv}"><b>${f.clearPct >= 100 ? '100 %+' : `${f.clearPct.toFixed(0)} %`}</b> of the first Fresnel zone clear ${lv === 'ok' ? '✓ (60 %+ = clear)' : lv === 'warn' ? `⚠ partly obstructed${w && w.label ? ` by ${api.esc(w.label)}` : ''}` : `✖ blocked${w && w.label ? ` by ${api.esc(w.label)}` : ''}`}</p>
          <p class="small dim">No elevation data in Kelly: ground is flat at the mast's ${a.siteElevM} m between, plus the obstacles in Config (<code>terrain</code>) and earth bulge.</p>`;
      },
    };
  }

  // ---------------------------------------------------------------- 6. airtime / duty cycle
  function airtime() {
    let el;
    return {
      id: 'airtime', icon: '⏱️', title: 'Airtime & duty cycle', tag: true,
      html: () => `<div class="ss-air"><svg viewBox="0 0 160 96" class="ss-dial" aria-hidden="true"><path class="ss-gtrack" d="M16 86 A64 64 0 0 1 144 86"/><path class="ss-dialwarn" d="M16 86 A64 64 0 0 1 144 86" pathLength="100"/>
        <g class="ss-dialneedle"><path d="M80 86 L80 30"/><circle cx="80" cy="86" r="5"/></g><text x="16" y="96" class="ss-dt">0</text><text x="144" y="96" class="ss-dt" text-anchor="end">20 %</text></svg>
        <div><b class="ss-big" id="ss-air-busy">–</b><small>channel busy (10 min)</small><div class="ss-bar" id="ss-air-tx"><span>RPT TX duty</span><i><b></b></i><em>–</em><small>%</small></div><p class="small" id="ss-air-warn"></p></div></div><div class="ss-airtypes" id="ss-air-types"></div>`,
      mount(e) { el = e; },
      tick(now, api) {
        const S = api.S, L = api.cfg().limits.dutyPct, busy = S.busy || 0, duty = S.rpt.dutyPct ?? S.duty ?? 0;
        el.querySelector('#ss-air-busy').textContent = `${busy.toFixed(2)} %`;
        el.querySelector('.ss-dialneedle').style.transform = `rotate(${(-90 + clamp(busy / 20, 0, 1) * 180).toFixed(1)}deg)`;
        el.querySelector('.ss-dialwarn').style.strokeDasharray = `${100 - clamp(L.warnHi / 20, 0, 1) * 100} 100`;
        el.querySelector('.ss-dialwarn').style.strokeDashoffset = `${-clamp(L.warnHi / 20, 0, 1) * 100}`;
        const b = el.querySelector('#ss-air-tx'), lv = api.C.level(duty, L);
        b.querySelector('b').style.transform = `scaleX(${clamp(duty / 20, 0, 1).toFixed(3)})`; b.querySelector('em').textContent = duty.toFixed(2); b.dataset.lv = lv;
        const blv = api.C.level(busy, L);
        el.querySelector('#ss-air-warn').innerHTML = blv === 'alarm' ? '✖ <b>Channel congestion</b>: packets will collide -- fewer floods, longer advert intervals' : blv === 'warn' ? '⚠ Channel getting busy' : '✓ Plenty of air';
        el.querySelector('#ss-air-warn').dataset.lv = blv;
        const by = {}; S.air.forEach(a => { by.all = (by.all || 0) + a.ms; });
        const types = {}; S.log.filter(r => now - r.t < 600000 && r.dev === 'rpt').forEach(r => { types[r.pkt.type] = (types[r.pkt.type] || 0) + r.air; });
        const tot = Object.values(types).reduce((s, v) => s + v, 0) || 1;
        el.querySelector('#ss-air-types').innerHTML = Object.entries(types).sort((a, b2) => b2[1] - a[1]).slice(0, 6).map(([t, ms]) => `<div class="ss-bar small"><span>${api.esc(t)}</span><i><b style="transform:scaleX(${(ms / tot).toFixed(3)})"></b></i><em>${(ms / 1000).toFixed(1)} s</em><small></small></div>`).join('');
        const tag = document.getElementById('ss-tag-airtime'); if (tag) tag.textContent = `${S.air.length} on air · 10 min`;
      },
    };
  }

  // ---------------------------------------------------------------- 7. solar energy balance + 24 h forecast
  function solar() {
    let el;
    return {
      id: 'solar', icon: '☀️', title: 'Solar energy balance',
      html: () => `<div class="ss-solar"><div class="ss-sflow"><div><b id="ss-s-in">–</b><small>panel</small></div><span class="ss-arrow">➜</span><div><b id="ss-s-batt">–</b><small id="ss-s-state">battery</small></div><span class="ss-arrow">➜</span><div><b id="ss-s-load">–</b><small>node load</small></div></div>
        <svg class="ss-fc" viewBox="0 0 600 150" id="ss-s-fc" role="img" aria-label="Battery charge forecast for the next 24 hours"></svg><p class="small dim" id="ss-s-note"></p></div>`,
      mount(e) { el = e; },
      tick(now, api) {
        const S = api.S, sol = api.cfg().solar, r = S.rpt, sim = api.srcKind() === 'sim';
        const loadW = sol.loadMa / 1000 * (r.battV || sol.battNomV);
        el.querySelector('#ss-s-in').textContent = r.solarW != null ? `${r.solarW.toFixed(2)} W` : '– W';
        el.querySelector('#ss-s-batt').textContent = r.battPct != null ? `${r.battPct.toFixed(0)} %` : r.battV != null ? `${r.battV.toFixed(2)} V` : '–';
        el.querySelector('#ss-s-state').textContent = r.charge ? `battery · ${r.charge}` : 'battery';
        el.querySelector('#ss-s-load').textContent = `${loadW.toFixed(3)} W`;
        if (now - (this._fcAt || 0) < 5000) return; this._fcAt = now;
        // forecast: the same model as the simulation, from now, at today's cloud (sim) or a 30 % guess (live)
        const h0 = sim ? S.env.hour ?? 12 : new Date().getHours() + new Date().getMinutes() / 60, cloud = sim ? S.env.cloud ?? 0.3 : 0.3;
        let soc = (r.battPct ?? 60) / 100; const pts = [], sun = [];
        for (let i = 0; i <= 96; i++) {
          const h = (h0 + i / 4) % 24, el2 = Math.sin(Math.PI * (h - 6) / 12), w = Math.max(0, el2) * sol.panelW * (1 - 0.8 * cloud);
          const inMa = soc >= 0.995 ? Math.min(w * sol.chargeEff / 3.9 * 1000, sol.loadMa) : w * sol.chargeEff / 3.9 * 1000;
          if (i) soc = clamp(soc + (inMa - sol.loadMa) / 1000 * 0.25 / sol.battAh, 0, 1);
          pts.push(soc); sun.push(w);
        }
        const X = i => 30 + i / 96 * 550, Y = v => 130 - v * 110, Ys = w => 130 - w / sol.panelW * 110;
        const hh = i => { const h = Math.floor((h0 + i / 4) % 24); return `${String(h).padStart(2, '0')}:00`; };
        el.querySelector('#ss-s-fc').innerHTML = `<g class="ss-fcgrid">${[0, 0.5, 1].map(v => `<line x1="30" x2="580" y1="${Y(v)}" y2="${Y(v)}"/><text x="26" y="${Y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join('')}
          ${[0, 24, 48, 72, 96].map(i => `<text x="${X(i)}" y="146" text-anchor="middle">${i ? hh(i) : 'now'}</text>`).join('')}</g>
          <polygon class="ss-fcsun" points="${X(0)},130 ${sun.map((w, i) => `${X(i).toFixed(1)},${Ys(w).toFixed(1)}`).join(' ')} ${X(96)},130"/>
          <polyline class="ss-fcsoc" points="${pts.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>
          <text class="ss-fclbl" x="${X(96) - 4}" y="${Y(pts[96]) - 6}" text-anchor="end">${(pts[96] * 100).toFixed(0)} % in 24 h</text>`;
        el.querySelector('#ss-s-note').textContent = `Shaded: expected panel power (${sol.panelW} W panel, ${Math.round(cloud * 100)} % cloud${sim ? '' : ' assumed'}). Line: battery charge, ${sol.battAh} Ah at ${sol.loadMa} mA. ${sim ? '' : 'Live: MeshCore doesn\'t report solar current, so this is the model only.'}`;
      },
    };
  }

  // ---------------------------------------------------------------- 8. SWR / forward-reflected needles (simulated)
  function swr() {
    let el;
    const m = { rpt: { fwd: 0, ref: 0, tf: 0, tr: 0, swr: 1.25, hot: 0 }, cmp: { fwd: 0, ref: 0, tf: 0, tr: 0, swr: 1.6, hot: 0 } };
    const meter = (id, name) => `<div class="ss-swr" id="ss-swr-${id}"><svg viewBox="0 0 200 118" aria-hidden="true"><rect class="ss-swrface" x="2" y="2" width="196" height="114" rx="8"/>
      <path class="ss-swrscale" d="M30 92 A80 80 0 0 1 170 92"/><path class="ss-swrred" d="M146 50 A80 80 0 0 1 170 92"/>
      ${[0, 0.25, 0.5, 0.75, 1].map(f => { const a = Math.PI * (1 - f) * 0.8 + Math.PI * 0.1, x = 100 + 80 * Math.cos(a), y = 110 - 80 * Math.sin(a); return `<line class="ss-tick" x1="${x}" y1="${y}" x2="${100 + 70 * Math.cos(a)}" y2="${110 - 70 * Math.sin(a)}"/>`; }).join('')}
      <g class="ss-nf"><path d="M100 110 L100 34"/></g><g class="ss-nr"><path d="M100 110 L100 44"/></g><circle cx="100" cy="110" r="6" class="ss-hub"/>
      <text x="12" y="20" class="ss-swrt">FWD</text><text x="188" y="20" class="ss-swrt" text-anchor="end">REF</text></svg>
      <div class="ss-swrro"><b>${name}</b><span>FWD <em class="f">–</em> W</span><span>REF <em class="r">–</em> W</span><span>SWR <em class="s">–</em></span></div></div>`;
    const ang = f => (-72 + clamp(f, 0, 1) * 144);
    return {
      id: 'swr', icon: '🎛️', title: 'SWR meters (simulated)', tag: true,
      html: () => `<div class="ss-swrs">${meter('rpt', 'RPT-01 feed')}${meter('cmp', 'CMP-01 feed')}</div><p class="small dim">Neither node has an SWR bridge: the needles are modelled from the TX events and the antennas' expected match, just because a ham loves a needle.</p>`,
      mount(e) { el = e; },
      event(e, api) {
        if (e.type === 'env' && e.lightning) { m.rpt.hot = performance.now() + 30000; }
        if (e.type !== 'rf' || e.dir !== 'tx' || (e.dev !== 'rpt' && e.dev !== 'cmp')) return;
        const x = m[e.dev], w = Math.pow(10, api.cfg().radio.txDbm / 10) / 1000, s = x.swr + (e.dev === 'rpt' && performance.now() < x.hot ? 1.5 : 0) + Math.random() * 0.06;
        const g = ((s - 1) / (s + 1)) ** 2;
        x.tf = w; x.tr = w * g; x.s = s; x.until = performance.now() + clamp(api.C.airtimeMs(e.pkt.len || 20, api.cfg().radio), 250, 1500);
      },
      frame(now, api) {
        let moving = false;
        for (const id of ['rpt', 'cmp']) {
          const x = m[id]; if (now > (x.until || 0)) { x.tf = 0; x.tr = 0; }
          const k = api.reduced() ? 1 : 0.18;
          const nf = x.fwd + (x.tf - x.fwd) * k, nr = x.ref + (x.tr - x.ref) * k;
          if (Math.abs(nf - x.fwd) > 1e-4 || Math.abs(nr - x.ref) > 1e-5) moving = true;
          x.fwd = Math.abs(nf - x.tf) < 1e-4 ? x.tf : nf; x.ref = Math.abs(nr - x.tr) < 1e-5 ? x.tr : nr;
          const box = el.querySelector(`#ss-swr-${id}`); if (!box) continue;
          box.querySelector('.ss-nf').style.transform = `rotate(${ang(x.fwd / 0.25)}deg)`;
          box.querySelector('.ss-nr').style.transform = `rotate(${ang(x.ref / 0.025)}deg)`;
          if (x.fwd > 0.001 || x.tf) { box.querySelector('.f').textContent = x.fwd.toFixed(3); box.querySelector('.r').textContent = x.ref.toFixed(4); box.querySelector('.s').textContent = x.s ? `${x.s.toFixed(2)}:1` : '–'; }
          box.dataset.lv = x.s >= 2.5 ? 'alarm' : x.s >= 2 ? 'warn' : '';
        }
        const tag = document.getElementById('ss-tag-swr'); if (tag) tag.textContent = `${api.cfg().radio.txDbm} dBm = ${(Math.pow(10, api.cfg().radio.txDbm / 10)).toFixed(0)} mW`;
        return moving;
      },
    };
  }

  // ---------------------------------------------------------------- 9. alarm annunciator + historian
  function annunciator() {
    let el, sig = '', hSeen = -1;
    return {
      id: 'annunciator', icon: '🚨', title: 'Alarm annunciator', wide: true, first: true,
      html: () => `<div class="ss-ann" id="ss-ann"></div><div class="row gap"><button class="btn primary small" id="ss-ack">✓ ACK</button><button class="btn ghost small" id="ss-rst">↺ RESET</button>
        <span class="small dim">ACK silences and steadies; a cleared alarm stays lit (RTN) until acknowledged; RESET clears the latched ones and the CRC count.</span></div>
        <div class="ss-histwrap"><table class="ss-hist"><thead><tr><th>Time</th><th>Tag</th><th>Event</th></tr></thead><tbody id="ss-hist"></tbody></table></div>`,
      mount(e, api) { el = e; e.querySelector('#ss-ack').onclick = () => api.ackAll(); e.querySelector('#ss-rst').onclick = () => api.resetAll(); },
      tick(now, api) {
        const A = api.S.alarms, ids = api.C.ALARMS.map(a => a.id);
        const s = ids.map(id => { const a = A[id] || {}; return `${id}:${a.state}:${a.why}:${now < (a.flashUntil || 0)}`; }).join('|');
        if (s !== sig) {
          sig = s;
          el.querySelector('#ss-ann').innerHTML = api.C.ALARMS.map(d => {
            const a = A[d.id] || { state: 'normal' }, st = a.state || 'normal';
            const flash = st === 'unack' && now < (a.flashUntil || 0) && !api.reduced();
            return `<div class="ss-tile ${st} ${a.level || ''}${flash ? ' flash' : ''}" role="status"><b>${d.label}</b><small>${st === 'normal' ? 'NORMAL' : st === 'unack' ? '▲ UNACK' : st === 'ack' ? 'ACK' : 'RTN · UNACK'}${a.why && st !== 'normal' ? ` · ${api.esc(a.why)}` : ''}</small></div>`;
          }).join('');
        }
        if (api.S.histVer !== hSeen) {
          hSeen = api.S.histVer;
          el.querySelector('#ss-hist').innerHTML = api.S.hist.slice(-80).reverse().map(h => `<tr class="${h.level}"><td>${new Date(h.t).toLocaleTimeString()}</td><td>${api.esc(h.tag)}</td><td>${h.level === 'alarm' ? '✖ ' : h.level === 'warn' ? '⚠ ' : ''}${api.esc(h.text)}</td></tr>`).join('');
        }
      },
    };
  }

  // ---------------------------------------------------------------- 10. trend charts (small multiples: one measure each, one axis each)
  function trends() {
    let el, cv, g, win = 3600000, last = 0, hoverX = null;
    const SERIES = [['rssi', 'RSSI at the shack', 'dBm', 0], ['snr', 'SNR at the shack', 'dB', 1], ['batt', 'Mast battery', 'V', 2], ['rate', 'Packets', '/min', 0]];
    const H1 = 62, W = 720;
    function draw(api) {
      const now = Date.now(), pts = api.S.trend.filter(p => now - p.t <= win), css = getComputedStyle(el);
      const ink = css.getPropertyValue('--dim').trim() || '#8394b8', grid = css.getPropertyValue('--chart-grid').trim() || '#1b2740', line = css.getPropertyValue('--chart-line').trim() || '#00e5ff', text = css.getPropertyValue('--text').trim() || '#e8f1ff';
      g.clearRect(0, 0, W, H1 * 4 + 10);
      g.font = '11px JetBrains Mono, Consolas, monospace';
      SERIES.forEach(([key, label, unit, dp], i) => {
        const y0 = i * H1 + 4, vals = pts.filter(p => p[key] != null);
        g.fillStyle = ink; g.fillText(`${label} (${unit})`, 4, y0 + 11);
        g.strokeStyle = grid; g.lineWidth = 1; g.beginPath(); g.moveTo(70, y0 + H1 - 10); g.lineTo(W - 6, y0 + H1 - 10); g.stroke();
        if (vals.length < 2) { g.fillStyle = ink; g.fillText('collecting… (a point every 10 s)', 80, y0 + 34); return; }
        let lo = Math.min(...vals.map(p => p[key])), hi = Math.max(...vals.map(p => p[key])); if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
        const X = t => 70 + (1 - (now - t) / win) * (W - 76), Y = v => y0 + 16 + (1 - (v - lo) / (hi - lo)) * (H1 - 30);
        g.fillStyle = ink; g.fillText(hi.toFixed(dp), 4, y0 + 26); g.fillText(lo.toFixed(dp), 4, y0 + H1 - 12);
        g.strokeStyle = line; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
        vals.forEach((p, j) => { const x = X(p.t), y = Y(p[key]); if (j) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
        if (hoverX != null && hoverX >= 70) {
          const t = now - (1 - (hoverX - 70) / (W - 76)) * win, p = vals.reduce((b, q) => Math.abs(q.t - t) < Math.abs(b.t - t) ? q : b, vals[0]);
          g.strokeStyle = ink; g.lineWidth = 1; g.beginPath(); g.moveTo(X(p.t), y0 + 14); g.lineTo(X(p.t), y0 + H1 - 10); g.stroke();
          g.fillStyle = line; g.beginPath(); g.arc(X(p.t), Y(p[key]), 4, 0, 7); g.fill();
          g.fillStyle = text; const s = `${p[key].toFixed(dp)} ${unit} · ${new Date(p.t).toLocaleTimeString()}`; g.fillText(s, Math.min(X(p.t) + 8, W - g.measureText(s).width - 4), y0 + 11);
        }
      });
    }
    return {
      id: 'trends', icon: '📈', title: 'Trends', wide: true,
      html: () => `<div class="row gap"><label class="fld"><span>Window</span><select id="ss-tw"><option value="600000">10 min</option><option value="3600000" selected>1 hour</option><option value="21600000">6 hours</option><option value="86400000">24 hours</option></select></label><span class="small dim">Hover for values. Kept while Kelly is open.</span></div>
        <canvas class="ss-trend" width="${W}" height="${H1 * 4 + 10}" role="img" aria-label="Trend charts: RSSI, SNR, mast battery, packet rate"></canvas>`,
      mount(e, api) {
        el = e; cv = e.querySelector('canvas'); g = cv.getContext('2d');
        e.querySelector('#ss-tw').onchange = ev => { win = +ev.target.value; draw(api); };
        cv.addEventListener('mousemove', ev => { const r = cv.getBoundingClientRect(); hoverX = (ev.clientX - r.left) / r.width * W; draw(api); });
        cv.addEventListener('mouseleave', () => { hoverX = null; draw(api); });
      },
      tick(now, api) { if (now - last < 5000) return; last = now; draw(api); },
    };
  }

  // ---------------------------------------------------------------- 11. neighbour table + best DX
  function neighbours() {
    let el;
    return {
      id: 'neighbours', icon: '🛰️', title: 'Neighbours', tag: true,
      html: () => '<p class="small" id="ss-dx"></p><div class="ss-logwrap"><table class="ss-nt"><thead><tr><th>Station</th><th>Heard</th><th>SNR</th><th>RSSI</th><th>Hops</th><th>km</th></tr></thead><tbody id="ss-nt"></tbody></table></div>',
      mount(e, api) { el = e; e.querySelector('#ss-nt').onclick = ev => { const tr = ev.target.closest('tr[data-id]'); if (tr) api.setSelNbr(tr.dataset.id); }; },
      tick(now, api) {
        const list = api.nbrs(), sel = api.selNbr();
        el.querySelector('#ss-nt').innerHTML = list.slice(0, 30).map(n => `<tr data-id="${api.esc(n.id)}" class="${sel && sel.id === n.id ? 'sel' : ''}"><td>${n.role === 'repeater' ? '📡' : '🔷'} ${api.esc(n.name || n.id)}</td><td>${n.lastHeard ? ago(now - n.lastHeard) : '–'}</td>`
          + `<td>${n.snr != null ? api.num(n.snr, 1) : '–'}</td><td>${n.rssi ?? '–'}</td><td>${n.hops ?? '–'}</td><td>${n.distKm != null ? n.distKm.toFixed(1) : '–'}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">Nobody heard yet</td></tr>';
        const dx = api.S.dx;
        el.querySelector('#ss-dx').innerHTML = dx ? `🏆 Best DX heard direct: <b>${api.esc(dx.name)}</b>, ${dx.km.toFixed(1)} km${dx.snr != null ? ` at ${api.num(dx.snr, 1)} dB SNR` : ''} <span class="dim">(${new Date(dx.t).toLocaleDateString()})</span>` : '<span class="dim">Best DX: nothing heard direct with a position yet</span>';
        const tag = document.getElementById('ss-tag-neighbours'); if (tag) tag.textContent = `${list.length} heard`;
      },
    };
  }

  // order on the page: the two "first" ones go on top in reverse (annunciator, then waterfall), then the packet log, then these
  window.StationScadaPanels = [waterfall, annunciator, inspector, budget, fresnel, airtime, solar, swr, trends, neighbours];
})();
