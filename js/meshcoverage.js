/* Kelly Page -- Coverage layer on the LoRa Mesh map (Phase 4d of docs/lora-mesh-gap-analysis.md, 2026-10-22).
 *
 * Where this node hears stations DIRECTLY (0 hops) and how strongly. A relayed packet's SNR is the last repeater's, not
 * the station's, so only direct hearings count -- the honest part of a coverage map. Stations are binned into cells of
 * about 1.5 km, each coloured by its best direct SNR (green >= 5 dB, yellow >= 0, orange >= -7.5, red below: LoRa still
 * decodes well under 0 dB at SF8) with a tooltip listing who was heard there. A dashed ring marks the farthest direct
 * station from this node.
 *
 * Data: the bridge's history (--mesh-history, /api/mesh-history?coverage=1: every station heard direct in the last 30
 * days, average / best SNR, how often) when the mesh comes through a bridge; otherwise the stations the node knows right
 * now (hops 0 with an SNR). The MeshCore demo uses its simulated stations. Opt-in: Settings' "Coverage map" (ms.coverage).
 * Static layer: drawn once per data change, nothing animates.
 *
 * Driven source (Phase 12, js/meshdrive.js, k.driven()): Drive mode's points -- where YOU were when a repeater heard your
 * ping -- in ~0.5 km cells by the best SNR heard there (grey: a ping nobody repeated), dashed edge, class cov-drive.
 *
 * window.KellyMeshCoverage(k) -> { draw(map), legend() }; k from mesh.js:
 *   { esc, nodes(), myNum(), myPos(), on(), historyUrl(), isSim(), fmtAgo, driven()? }
 */
(function () {
  'use strict';
  const CELL_KM = 1.5, DRIVE_KM = 0.5, DAYS = 30, REFRESH_MS = 5 * 60000;
  const colour = snr => snr >= 5 ? '#39ff88' : snr >= 0 ? '#ffd166' : snr >= -7.5 ? '#ff9f40' : '#ff3b5c';
  const km = (a, b) => { const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };

  window.KellyMeshCoverage = function (k) {
    const { esc } = k;
    let layer = null, sig = '', hist = null, histAt = 0, histBusy = false, histBase = '';

    async function loadHistory() {
      const url = k.historyUrl(); if (!url || histBusy) return;
      histBusy = true;
      try {
        const to = Date.now(), r = await fetch(url + (url.includes('?') ? '&' : '?') + `coverage=1&from=${to - DAYS * 86400000}&to=${to}`, { cache: 'no-store' });
        hist = r.ok ? ((await r.json()).stations || []) : null;
      } catch { hist = null; }
      histAt = Date.now(); histBusy = false; sig = '';
    }
    // [{name, lat, lon, snr (avg), best, n, last, live}] -- history first, then live nodes it doesn't have
    function stations() {
      const out = [], have = new Set();
      for (const s of hist || []) { out.push({ name: s.name || s.src, lat: s.lat, lon: s.lon, snr: s.snr, best: s.best, n: s.n, last: s.last }); have.add(s.src); }
      for (const n of k.nodes()) {
        // MeshCore: a 0-hop advert heard (n.directSnr, from mesh.js); Meshtastic: hopsAway 0 with its last SNR
        const snr = n.directSnr != null ? n.directSnr : n.hops === 0 && n.snr != null ? n.snr : null;
        if (snr == null || n.lat == null || n.lon == null || n.num === k.myNum()) continue;
        if (n.key && have.has(String(n.key).slice(0, 12))) continue;
        out.push({ name: n.longName || n.shortName || String(n.num), lat: n.lat, lon: n.lon, snr, best: snr, n: 1, last: n.directAt || n.lastHeard, live: true });
      }
      return out;
    }
    function cells(list) {
      const dLat = CELL_KM / 111.32, m = new Map();
      for (const s of list) {
        const dLon = CELL_KM / (111.32 * Math.cos(s.lat * Math.PI / 180));
        const i = Math.floor(s.lat / dLat), j = Math.floor(s.lon / dLon), key = `${i}:${j}`;
        const c = m.get(key) || { b: [[i * dLat, j * dLon], [(i + 1) * dLat, (j + 1) * dLon]], best: -99, list: [] };
        c.best = Math.max(c.best, s.best ?? s.snr); c.list.push(s); m.set(key, c);
      }
      return [...m.values()];
    }
    function draw(map) {
      if (!map || !window.L) return;
      if (!k.on()) { if (layer) { layer.remove(); layer = null; sig = ''; } return; }
      const base = k.isSim() ? '' : k.historyUrl();
      if (base !== histBase) { histBase = base; hist = null; histAt = 0; }
      if (base && Date.now() - histAt > REFRESH_MS) loadHistory().then(() => draw(map));
      const list = stations(), me = k.myPos(), drv = (k.driven && k.driven()) || [];
      const s = JSON.stringify([list.map(x => [x.name, x.lat, x.lon, x.best, x.n]), me && [me.lat, me.lon], drv.length, drv.length && drv[drv.length - 1].t]);
      if (s === sig && layer) return; sig = s;
      if (layer) layer.remove(); layer = L.layerGroup().addTo(map);
      for (const c of cells(list)) {
        const n = c.list.reduce((a, x) => a + (x.n || 1), 0);
        const tip = `<b>Heard direct here</b> · best ${c.best.toFixed(1)} dB<br>` + c.list.slice(0, 6).map(x =>
          `${esc(x.name)}: ${(x.snr ?? 0).toFixed(1)} dB avg${x.n > 1 ? ` · ${x.n}×` : ''}${x.live ? ' · now' : x.last ? ` · ${esc(k.fmtAgo(x.last))}` : ''}`).join('<br>')
          + (c.list.length > 6 ? `<br>+${c.list.length - 6} more` : '');
        L.rectangle(c.b, { color: colour(c.best), weight: 1, opacity: 0.7, fillColor: colour(c.best), fillOpacity: Math.min(0.55, 0.22 + 0.05 * Math.log2(1 + n)), className: 'cov-cell' })
          .bindTooltip(tip, { sticky: true }).addTo(layer);
      }
      drawDriven(drv);
      if (me && list.length) {
        const far = list.reduce((a, x) => { const d = km(me, x); return d > a.d ? { d, x } : a; }, { d: 0, x: null });
        if (far.x) L.circle([me.lat, me.lon], { radius: far.d * 1000, color: '#39ff88', weight: 1, opacity: 0.5, dashArray: '4 8', fill: false })
          .bindTooltip(`Farthest heard direct: ${esc(far.x.name)}, ${far.d.toFixed(1)} km`, { sticky: true }).addTo(layer);
      }
    }
    // Drive mode's points: cells where you were, coloured by the best repeater SNR heard there
    function drawDriven(drv) {
      if (!drv.length) return;
      const dLat = DRIVE_KM / 111.32, m = new Map();
      for (const p of drv) {
        const dLon = DRIVE_KM / (111.32 * Math.cos(p.lat * Math.PI / 180)), i = Math.floor(p.lat / dLat), j = Math.floor(p.lon / dLon), key = `${i}:${j}`;
        const c = m.get(key) || { b: [[i * dLat, j * dLon], [(i + 1) * dLat, (j + 1) * dLon]], best: null, rpt: new Map(), pings: new Set() };
        c.pings.add(p.ping);
        if (p.snr != null) { c.best = c.best == null ? p.snr : Math.max(c.best, p.snr); const o = c.rpt.get(p.repeater); if (o == null || p.snr > o) c.rpt.set(p.repeater, p.snr); }
        m.set(key, c);
      }
      for (const c of m.values()) {
        const col = c.best == null ? '#8a8f98' : colour(c.best), r = [...c.rpt.entries()].sort((a, b) => b[1] - a[1]);
        const tip = `<b>🚗 Driven here</b> · ${c.pings.size} ping${c.pings.size === 1 ? '' : 's'}<br>` + (r.length ? r.slice(0, 6).map(([n, v]) => `${esc(n || '?')}: ${v.toFixed(1)} dB`).join('<br>') + (r.length > 6 ? `<br>+${r.length - 6} more` : '') : 'No repeats heard');
        L.rectangle(c.b, { color: col, weight: 1.5, opacity: 0.9, dashArray: '3 3', fillColor: col, fillOpacity: 0.45, className: 'cov-drive' }).bindTooltip(tip, { sticky: true }).addTo(layer);
      }
    }
    function legend() {
      const drv = (k.driven && k.driven()) || [];
      return `<span class="cov-key"><i style="--c:#39ff88"></i>≥ 5 dB <i style="--c:#ffd166"></i>0–5 <i style="--c:#ff9f40"></i>−7.5–0 <i style="--c:#ff3b5c"></i>weaker · heard direct${hist ? `, ${DAYS} days of history` : ', now'}${drv.length ? ` · 🚗 ${drv.length} driven points` : ''}</span>`;
    }
    return { draw, legend, count: () => stations().length };
  };
})();
