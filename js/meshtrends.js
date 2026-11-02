/* Kelly Page -- Mesh trends (LoRa Mesh page, MeshCore; Phase 4c of docs/lora-mesh-gap-analysis.md, 2026-10-21).
 *
 * Charts of what the bridge's node has heard over time, from the bridge's own history (bridge/kelly_mesh_history.py,
 * started with --mesh-gateway --mesh-history): GET /api/mesh-history on the same bridge as the /mesh link (same token).
 * "This node": SNR, RSSI, noise floor, packets heard, TX/RX airtime %, battery, DM delivery % and round trip, node
 * answering. A station (by its advert key): SNR, RSSI, hops, distance, DM delivery to it. Ranges 6 h .. 1 year; the
 * bridge picks the resolution (1 min / 15 min / 1 h). Each chart is the average line inside a min-max band, broken
 * where there's no data (bridge off), with a hover readout. The bridge's threshold warnings (low battery, busy channel,
 * heavy TX, noisy site, failing DMs -- MeshCoreWatch.WARN) show above the charts. Static SVG: nothing animates, nothing loops.
 * The MeshCore demo (#mesh-demo-meshcore) draws made-up history so the card can be seen on file://.
 *
 * window.KellyMeshTrends(k) -> { render, init }; k from mesh.js:
 *   { $, esc, store, currentPage, historyUrl() -> 'http(s)://host:port/api/mesh-history?token=..' | '', isSim(), fmtAgo }
 */
(function () {
  'use strict';
  const RANGES = { '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, '1y': 365 * 86400 };
  const SELF = [
    { m: 'snr', label: 'SNR', unit: 'dB', d: 1, band: true },
    { m: 'rssi', label: 'RSSI', unit: 'dBm', d: 0, band: true },
    { m: 'noise_floor', label: 'Noise floor', unit: 'dBm', d: 0 },
    { m: 'packets', label: 'Packets heard', unit: '/min', d: 1 },
    { m: 'tx_air_pct', label: 'Airtime TX', unit: '%', d: 2 },
    { m: 'rx_air_pct', label: 'Airtime RX', unit: '%', d: 2 },
    { m: 'batt_v', label: 'Battery', unit: 'V', d: 2 },
    { m: 'dm_ok', label: 'DM delivery', unit: '%', d: 0, pct: true },
    { m: 'dm_rtt_ms', label: 'DM round trip', unit: 's', d: 1, scale: 0.001 },
    { m: 'node_answering', label: 'Node answering', unit: '%', d: 0, pct: true },
  ];
  const STATION = [
    { m: 'snr', label: 'SNR', unit: 'dB', d: 1, band: true },
    { m: 'rssi', label: 'RSSI', unit: 'dBm', d: 0, band: true },
    { m: 'hops', label: 'Hops', unit: '', d: 1, band: true },
    { m: 'km', label: 'Distance', unit: 'km', d: 1 },
    { m: 'dm_ok', label: 'DM delivery', unit: '%', d: 0, pct: true },
    { m: 'dm_rtt_ms', label: 'DM round trip', unit: 's', d: 1, scale: 0.001 },
  ];
  // a repeater's own figures, recorded by the bridge whenever its status is read over the air (Repeater management)
  const REPEATER = [
    { m: 'batt_v', label: 'Battery', unit: 'V', d: 2 },
    { m: 'noise_floor', label: 'Noise floor', unit: 'dBm', d: 0 },
    { m: 'tx_air_pct', label: 'Airtime TX', unit: '%', d: 2 },
    { m: 'rx_air_pct', label: 'Airtime RX', unit: '%', d: 2 },
    { m: 'dup_pct', label: 'Duplicate floods', unit: '%', d: 1 },
  ];
  const W = 600, H = 110;

  window.KellyMeshTrends = function (k) {
    const { $, esc, store } = k;
    const ui = { range: RANGES[store.get('meshTrRange', '')] ? store.get('meshTrRange') : '24h', src: 'self', sources: null, data: null,
      err: '', at: 0, busy: false, sig: '', base: '', pts: {} };

    // ---------------------------------------------------------------- data
    async function getJson(url) {
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `the bridge said ${r.status}`);
      return j;
    }
    const q0 = (p) => { const url = k.historyUrl(); if (!url) throw new Error('no bridge'); return url + (url.includes('?') ? '&' : '?') + p; };
    // a station's charts: the usual ones, plus a repeater's own figures when the bridge has any for it
    function defsFor(src) {
      if (src === 'self') return SELF;
      const have = new Set(((ui.sources || []).find(s => s.src === src) || {}).metrics || []);
      return STATION.concat(REPEATER.filter(d => have.has(d.m)));
    }
    async function load() {
      if (ui.busy) return;
      ui.busy = true; ui.err = ''; redraw();
      try {
        const span = RANGES[ui.range], to = Date.now(), from = to - span * 1000;
        if (k.isSim() && !ui.sources) ui.sources = demoSources();
        if (!k.isSim() && (!ui.sources || Date.now() - ui.at > 50000)) { const s = await getJson(q0('sources=1')); ui.sources = s.sources || []; ui.warn = s.warnings || {}; }
        const defs = defsFor(ui.src);
        if (k.isSim()) {
          ui.sources = demoSources(); ui.data = demo(ui.src, defs, from, to, span);
          ui.warn = { busy: { text: 'channel busy -- the node hears traffic 31 % of the time (15 min)', since: Date.now() - 1260000 } };
        } else {
          ui.data = await getJson(q0(`src=${encodeURIComponent(ui.src)}&m=${defs.map(d => d.m).join(',')}&from=${from}&to=${to}`));
        }
        ui.at = Date.now();
      } catch (e) {
        ui.err = /Failed to fetch|NetworkError|Load failed/i.test(e.message) ? "can't reach the bridge's history (an older bridge, or not this machine's and no token?)" : e.message;
        ui.data = null; ui.at = Date.now();
      }
      ui.busy = false; redraw();
    }

    // made-up but plausible: a day/night cycle, noise, a short bridge outage
    function rnd(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 >>> 0) / 4294967296); }
    function demoSources() {
      const now = Date.now();
      return [{ src: 'self', metrics: SELF.map(d => d.m) },
        { src: '3e08c379461c', name: 'VK4XXX Veranda Rptr', type: 'repeater', last: now - 300000, metrics: STATION.concat(REPEATER).map(d => d.m) },
        { src: '5a1f00c2d9e4', name: 'Toowoomba Rptr', type: 'repeater', last: now - 3600000, metrics: ['snr', 'rssi', 'hops', 'km'] },
        { src: '91b7aa03ce10', name: 'VK4ZR Romeo', type: 'companion', last: now - 7200000, metrics: STATION.map(d => d.m) }];
    }
    function demo(src, defs, from, to, span) {
      const res = span <= 2 * 86400 ? 60 : span <= 35 * 86400 ? 900 : 3600, r = rnd(src.length * 7919 + span);
      const base = { snr: [6, 3], rssi: [-92, 6], noise_floor: [-117, 1.5], packets: [2.2, 1.6], tx_air_pct: [0.3, 0.25], rx_air_pct: [2.5, 1.5],
        batt_v: [4.05, 0.08], dup_pct: [12, 6], dm_ok: [0.9, 0.3], dm_rtt_ms: [2400, 900], node_answering: [1, 0], hops: [1.2, 0.6], km: [3.1, 0] };
      const series = {};
      for (const d of defs) {
        const [mid, sd] = base[d.m] || [1, 0.5], pts = [];
        for (let t = Math.ceil(from / 1000 / res) * res; t * 1000 <= to; t += res) {
          if (t % 86400 > 30000 && t % 86400 < 31800 && res === 60) continue;                       // a half-hour gap
          if (src !== 'self' && r() < (res === 60 ? 0.9 : 0.4)) continue;                           // stations: heard now and then
          const day = Math.sin((t % 86400) / 86400 * 2 * Math.PI);
          let v = mid + sd * (0.6 * day + (r() - 0.5));
          if (d.m === 'dm_ok') v = r() < 0.9 ? 1 : 0;
          if (d.m === 'node_answering') v = r() < 0.998 ? 1 : 0;
          if (d.m === 'batt_v') v = mid + 0.12 * day;
          if (d.m === 'hops') v = Math.max(0, Math.round(v));
          const s = sd * 0.6 * r();
          pts.push([t * 1000, v, v - s, v + s, 1 + (r() * 4 | 0)]);
        }
        series[d.m] = pts;
      }
      return { res, from, to, src, series };
    }

    // ---------------------------------------------------------------- draw
    const fmt = (d, v) => v == null || !isFinite(v) ? '–' : (d.pct ? (v * 100).toFixed(d.d) : (v * (d.scale || 1)).toFixed(d.d));
    const when = (t, span) => { const x = new Date(t); return span > 2 * 86400 ? x.toLocaleDateString([], { day: 'numeric', month: 'short' }) + (span <= 8 * 86400 ? ' ' + x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') : x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    function chart(d, pts, res, from, to) {
      const id = `tr-${d.m}`;
      ui.pts[id] = { d, pts };
      if (!pts.length) return `<div class="tr-chart tr-empty"><div class="tr-h"><b>${esc(d.label)}</b><span class="small dim">no data in this range</span></div></div>`;
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
      for (const p of pts) { lo = Math.min(lo, d.band ? p[2] : p[1]); hi = Math.max(hi, d.band ? p[3] : p[1]); sum += p[1] * p[4]; n += p[4]; }
      if (d.pct) { lo = Math.min(lo, 0); hi = Math.max(hi, 1); }
      if (hi - lo < 1e-9) { hi += 0.5; lo -= 0.5; }
      const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
      const X = t => ((t - from) / (to - from) * W).toFixed(1), Y = v => (H - (v - lo) / (hi - lo) * H).toFixed(1);
      // runs of points with no gap longer than 2.5 buckets
      const runs = []; let run = [];
      for (const p of pts) { if (run.length && p[0] - run[run.length - 1][0] > res * 2500) { runs.push(run); run = []; } run.push(p); }
      if (run.length) runs.push(run);
      let band = '', line = '';
      for (const r of runs) {
        if (d.band && r.length > 1) band += `<path class="tr-band" d="M${r.map(p => `${X(p[0])},${Y(p[3])}`).join(' L')} L${r.slice().reverse().map(p => `${X(p[0])},${Y(p[2])}`).join(' L')} Z"/>`;
        line += r.length > 1 ? `<polyline class="tr-line" points="${r.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}"/>` : `<circle class="tr-dot" cx="${X(r[0][0])}" cy="${Y(r[0][1])}" r="2.5"/>`;
      }
      const last = pts[pts.length - 1];
      return `<div class="tr-chart" data-tr="${id}"><div class="tr-h"><b>${esc(d.label)}</b><span class="tr-read" id="${id}-read">${fmt(d, last[1])} ${esc(d.unit)} <span class="dim">now · avg ${fmt(d, sum / n)}</span></span></div>`
        + `<div class="tr-plot"><span class="tr-y tr-hi">${fmt(d, hi)}</span><span class="tr-y tr-lo">${fmt(d, lo)}</span>`
        + `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(d.label)} over time">${band}${line}<line class="tr-cur" id="${id}-cur" x1="-5" x2="-5" y1="0" y2="${H}"/></svg></div>`
        + `<div class="tr-x"><span>${when(from, (to - from) / 1000)}</span><span>${when(to, (to - from) / 1000)}</span></div></div>`;
    }
    function tiles(data) {
      const S = data.series, avgOf = (m) => { let s = 0, n = 0; for (const p of S[m] || []) { s += p[1] * p[4]; n += p[4]; } return n ? s / n : null; };
      const t = (label, v, note = '') => `<div class="tile"><small>${label}</small><b>${v}</b>${note ? `<span class="small dim">${note}</span>` : ''}</div>`;
      const dmN = (S.dm_ok || []).reduce((a, p) => a + p[4], 0);
      if (ui.src !== 'self') {
        return `<div class="rp-tiles">${t('Average SNR', `${fmt(STATION[0], avgOf('snr'))} dB`)}${t('Average hops', fmt(STATION[2], avgOf('hops')))}`
          + `${t('DM delivery', dmN ? `${fmt(STATION[4], avgOf('dm_ok'))} %` : '–', dmN ? `${dmN} sent` : 'no DMs sent')}${t('Heard', `${(S.snr || []).reduce((a, p) => a + p[4], 0)}×`, 'adverts in this range')}</div>`;
      }
      const span = RANGES[ui.range] * 1000;
      const heard = (ui.sources || []).filter(s => s.src !== 'self' && s.last && s.last >= Date.now() - span).length;
      return `<div class="rp-tiles">${t('Packets heard', `${fmt(SELF[3], avgOf('packets'))}/min`, 'average')}${t('DM delivery', dmN ? `${fmt(SELF[7], avgOf('dm_ok'))} %` : '–', dmN ? `${dmN} sent` : 'no DMs sent')}`
        + `${t('Average SNR', `${fmt(SELF[0], avgOf('snr'))} dB`)}${t('Node answering', avgOf('node_answering') == null ? '–' : `${fmt(SELF[9], avgOf('node_answering'))} %`, 'of the time')}`
        + `${t('Stations heard', `${heard}`, 'in this range')}</div>`;
    }
    function redraw() { ui.sig = ''; render(); }
    function render() {
      const box = $('#tr-card'); if (!box) return;
      const base = k.isSim() ? 'sim' : k.historyUrl();
      box.hidden = !base; if (!base || k.currentPage() !== 'mesh') return;
      if (base !== ui.base) { ui.base = base; ui.sources = null; ui.warn = {}; ui.data = null; ui.at = 0; ui.src = 'self'; }
      if (!ui.busy && Date.now() - ui.at > 60000) { load(); return; }          // load() redraws when it's done
      const sig = JSON.stringify([ui.range, ui.src, ui.at, ui.busy, ui.err]);
      if (sig === ui.sig) return; ui.sig = sig;
      const srcs = (ui.sources || []).filter(s => s.src !== 'self');
      $('#tr-tag').textContent = ui.busy ? 'loading…' : ui.data ? `every ${ui.data.res >= 3600 ? 'hour' : ui.data.res >= 900 ? '15 min' : 'minute'}${k.isSim() ? ' · demo' : ''}` : '';
      const opts = `<option value="self">This node</option>` + srcs.map(s => `<option value="${esc(s.src)}"${s.src === ui.src ? ' selected' : ''}>${esc(s.name || s.src)}${s.type ? ` (${esc(s.type)})` : ''}${s.last ? ` · ${esc(k.fmtAgo(s.last))}` : ''}</option>`).join('');
      const ctl = `<div class="row gap tr-ctl"><div class="seg">${Object.keys(RANGES).map(r => `<button class="btn small${r === ui.range ? ' on' : ''}" data-tr-range="${r}">${r}</button>`).join('')}</div>`
        + `<select id="tr-src" title="This node, or a station it has heard">${opts}</select><button class="btn small" id="tr-reload" title="Load again">↻</button></div>`;
      let body = '';
      const warns = Object.values(ui.warn || {});
      if (warns.length && !ui.err) body += `<div class="tr-warn">${warns.map(w => `<div>⚠️ ${esc(w.text)} <span class="dim">· since ${esc(k.fmtAgo(w.since))}</span></div>`).join('')}</div>`;
      if (ui.err) body = /no history/.test(ui.err)
        ? `<p class="small">The bridge isn't keeping history. Start it with <code>--mesh-gateway --mesh-history</code> (on a Pi: add them to <code>KELLY_MESH_ARGS</code> in <code>/etc/kelly-bridge.env</code>), then give it a few minutes.</p>`
        : `<p class="small bad">${esc(ui.err)}</p>`;
      else if (ui.data) {
        const defs = defsFor(ui.src);
        ui.pts = {};
        body += tiles(ui.data) + `<div class="tr-grid">${defs.map(d => chart(d, ui.data.series[d.m] || [], ui.data.res, ui.data.from, ui.data.to)).join('')}</div>`;
      }
      $('#tr-body').innerHTML = ctl + body;
      const sel = $('#tr-src'); if (sel) sel.value = ui.src;
    }
    function hover(e) {
      const c = e.target.closest('.tr-chart[data-tr]'); if (!c || !ui.data) return;
      const id = c.dataset.tr, info = ui.pts[id]; if (!info || !info.pts.length) return;
      const svg = c.querySelector('svg'), r = svg.getBoundingClientRect();
      const t = ui.data.from + (e.clientX - r.left) / r.width * (ui.data.to - ui.data.from);
      let best = info.pts[0]; for (const p of info.pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      const x = (best[0] - ui.data.from) / (ui.data.to - ui.data.from) * W, cur = $(`#${id}-cur`);
      if (cur) { cur.setAttribute('x1', x); cur.setAttribute('x2', x); }
      const d = info.d, read = $(`#${id}-read`);
      if (read) read.innerHTML = `${fmt(d, best[1])} ${esc(d.unit)} <span class="dim">${esc(when(best[0], 0))}${d.band ? ` · ${fmt(d, best[2])}–${fmt(d, best[3])}` : ''}${new Date(best[0]).toDateString() !== new Date().toDateString() ? ' · ' + esc(new Date(best[0]).toLocaleDateString([], { day: 'numeric', month: 'short' })) : ''}</span>`;
    }
    function init() {
      const box = $('#tr-card'); if (!box) return;
      box.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.trRange) { ui.range = b.dataset.trRange; store.set('meshTrRange', ui.range); load(); }
        if (b.id === 'tr-reload') { ui.sources = null; load(); }
      });
      box.addEventListener('change', e => { if (e.target.id === 'tr-src') { ui.src = e.target.value; load(); } });
      box.addEventListener('pointermove', hover);
      box.addEventListener('pointerleave', () => { ui.sig = ''; render(); });
    }
    // open a station's trends (the node info panel's 📈): select it, load, bring the card into view
    function show(src) {
      ui.src = src; ui.sources = ui.sources || null; load();
      const c = $('#tr-card'); if (c && !c.hidden) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return { render, init, load, show };
  };
})();
