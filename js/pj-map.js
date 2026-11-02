/* Kelly Page -- LoRa Mesh > Packet Journey: pj-map (2026-10-24, unreleased). "Stations on the map": every node that
 * has told us where it is (an advert with GPS, the registry's lat/lon, our own node from c.myPos()) as a Leaflet
 * marker in #pj-map. Role-styled (repeater = magenta diamond, companion = blue dot, room server = amber square,
 * sensor = lime triangle-ish dot, our node = cyan ring), brightness / size by how recently it was heard: fresh
 * (< 10 min) bright with a glow, fading through the hours to dim (24 h+). That is a STEADY style re-evaluated every
 * 30 s -- nothing loops (kelly-page/CLAUDE.md "Rules that bite"). A new GPS advert gives one ring pulse (CSS, one
 * iteration, the marker removed by a timer). Optional: recent flood paths as fading polylines, fit to stations.
 *
 * window.KellyPJMap(mount, c) -> { destroy() }      (c = the shell's context, see js/pj-ui.js)
 * Bus in: packet, nodes, visible, reset, select.  Bus out: select { node, from: 'map' }.
 * No Leaflet (c.makeMap -> null) = a plain message, the rest still counts stations.
 */
(function () {
  'use strict';

  const MAX_MARKERS = 300, MAX_PATHS = 20, MAX_PULSES = 12, TICK = 30e3;
  const MIN = 60e3, HOUR = 3600e3;
  const ROLES = {   // registry role -> css class, label
    repeater: { cls: 'rpt', label: 'Repeater' }, companion: { cls: 'cmp', label: 'Companion' },
    'room server': { cls: 'room', label: 'Room server' }, sensor: { cls: 'sens', label: 'Sensor' },
  };
  // age tier 0 (fresh) .. 4 (24 h+): steady styles in pj-map.css
  const tierOf = age => age < 10 * MIN ? 0 : age < HOUR ? 1 : age < 6 * HOUR ? 2 : age < 24 * HOUR ? 3 : 4;
  const okPos = (lat, lon) => typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

  window.KellyPJMap = function (mount, c) {
    if (!mount || !c || !c.bus) return { destroy() {} };
    const esc = c.esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
    const fmtAgo = c.fmtAgo || (ms => Math.round(ms / 1000) + ' s ago');
    const store = c.store || { get: (k, d) => d, set() {} };
    const L = window.L;
    let opts = { paths: false };
    try { opts = Object.assign(opts, store.get('pjMap', {}) || {}); } catch (e) { /* keep defaults */ }

    // data (kept while hidden; the DOM is only touched while visible)
    const heard = new Map();     // node id -> last heard ms (from packets: ev.t)
    const gpsOf = new Map();     // node id -> { lat, lon } from ev.gps (the registry normally has it too)
    let journeys = [];           // [{ ids, kind, t }] recent flood journeys, newest last
    const markers = new Map();   // node id -> { m, cls, tier }
    let pathLayer = null, pulseCount = 0, selId = null, fitted = false, dirty = true, timer = null, destroyed = false;

    mount.innerHTML = `<div class="card pj-map-card">
      <div class="card-h"><h2>🗺️ Stations on the map</h2><span class="tag pj-map-count">0 with GPS</span></div>
      <div class="pj-map-bar">
        <label class="pj-map-tog"><input type="checkbox" class="pj-map-paths"${opts.paths ? ' checked' : ''}> Show recent paths</label>
        <button class="btn ghost pj-map-fit" type="button">⤢ Fit to stations</button>
        <span class="pj-map-legend">
          <span><i class="pj-map-k pj-map-r-rpt"></i>Repeater</span><span><i class="pj-map-k pj-map-r-cmp"></i>Companion</span>
          <span><i class="pj-map-k pj-map-r-room"></i>Room</span><span><i class="pj-map-k pj-map-r-sens"></i>Sensor</span>
          <span><i class="pj-map-k pj-map-r-me"></i>My node</span><span class="pj-map-age">bright = heard &lt; 10 min · dim = 24 h+</span>
        </span>
      </div>
      <div class="pj-map-box"></div>
    </div>`;
    const q = s => mount.querySelector(s);
    const box = q('.pj-map-box'), countEl = q('.pj-map-count');
    let map = null;
    try { map = L ? c.makeMap(box, true, null)   /* no key: app.js fitOnce would fit to P25 radios, not mesh stations */ : null; } catch (e) { console.warn('pj-map', e); map = null; }
    if (!map) {
      box.classList.add('pj-map-none');
      box.innerHTML = '<p class="dim small">The map needs Leaflet, which isn\'t loaded here. Stations with GPS are still counted above.</p>';
      q('.pj-map-fit').hidden = true; q('.pj-map-tog').hidden = true;
    } else {
      try { pathLayer = L.layerGroup().addTo(map); } catch (e) { pathLayer = null; }
    }

    const vis = () => { try { return !!c.visible(); } catch (e) { return false; } };
    const canon = id => { try { return c.reg.canonical(id); } catch (e) { return id; } };
    const node = id => { try { return c.reg.get(id) || null; } catch (e) { return null; } };
    function posOf(n) {
      if (!n) return null;
      if (n.id === 'me') { const p = c.myPos && c.myPos(); if (p && okPos(p.lat, p.lon)) return p; }
      if (okPos(n.lat, n.lon)) return { lat: n.lat, lon: n.lon };
      const g = gpsOf.get(n.id); return g && okPos(g.lat, g.lon) ? g : null;
    }
    const lastOf = n => Math.max(heard.get(n.id) || 0, n.id === 'me' ? Date.now() : 0) || n.lastSeen || 0;
    const roleOf = n => n.id === 'me' ? { cls: 'me', label: 'My node' } : ROLES[n.role] || { cls: 'oth', label: n.role || 'Station' };

    function icon(cls, tier, sel) {
      return L.divIcon({ className: 'pj-map-wrap', iconSize: [30, 30], iconAnchor: [15, 15],
        html: `<div class="pj-map-m pj-map-r-${cls} pj-map-a${tier}${sel ? ' pj-map-sel' : ''}"><i></i></div>` });
    }
    function tip(id) {
      const n = node(id); if (!n) return '';
      const r = roleOf(n), last = lastOf(n);
      return `<b>${esc(n.name || n.hash || id)}</b><br>${esc(r.label)} · heard ${esc(last ? fmtAgo(Date.now() - last) : 'never')}` +
        (n.hash ? `<br><span class="pj-map-hash">${esc(n.hash)}</span>` : '');
    }

    // the stations to show: registry nodes with a position, newest first, capped
    function stations() {
      let all = []; try { all = c.reg.all() || []; } catch (e) { all = []; }
      const withPos = [], without = [];
      for (const n of all) {
        if (!n || n.id === 'unknown') continue;
        const p = posOf(n); if (p) withPos.push({ n, p, last: lastOf(n) }); else without.push(n);
      }
      withPos.sort((a, b) => b.last - a.last);
      return { show: withPos.slice(0, MAX_MARKERS), nWith: withPos.length, nWithout: without.length };
    }

    // traffic-driven redraws are coalesced (a flood arrives as a burst of copies); the 30 s tick and reset call sync() directly
    let soon = null;
    function later() { if (soon) return; soon = setTimeout(() => { soon = null; if (!destroyed && vis()) { try { sync(); } catch (e) { console.warn('pj-map', e); } } }, 250); }
    function sync() {
      dirty = false;
      const s = stations();
      countEl.textContent = `${s.nWith} station${s.nWith === 1 ? '' : 's'} with GPS · ${s.nWithout} without`;
      if (!map) return;
      const now = Date.now(), keep = new Set();
      for (const { n, p, last } of s.show) {
        keep.add(n.id);
        const cls = roleOf(n).cls, tier = n.id === 'me' ? 0 : tierOf(now - last), sel = n.id === selId;
        const key = cls + tier + (sel ? 's' : '');
        let mk = markers.get(n.id);
        if (!mk) {
          const m = L.marker([p.lat, p.lon], { icon: icon(cls, tier, sel), keyboard: false, riseOnHover: true, zIndexOffset: (4 - tier) * 100 + (sel ? 1000 : 0) });
          const id = n.id;
          m.bindTooltip(() => tip(id), { direction: 'top', offset: [0, -12], className: 'pj-map-tip' });
          m.on('click', () => { try { highlight(id, false); c.bus.emit('select', { node: id, from: 'map' }); } catch (e) { console.warn('pj-map', e); } });
          m.addTo(map); mk = { m, key, lat: p.lat, lon: p.lon }; markers.set(n.id, mk);
        } else {
          if (mk.key !== key) { mk.m.setIcon(icon(cls, tier, sel)); mk.m.setZIndexOffset((4 - tier) * 100 + (sel ? 1000 : 0)); mk.key = key; }
          if (mk.lat !== p.lat || mk.lon !== p.lon) { mk.m.setLatLng([p.lat, p.lon]); mk.lat = p.lat; mk.lon = p.lon; }
        }
      }
      for (const [id, mk] of markers) if (!keep.has(id)) { mk.m.remove(); markers.delete(id); }
      drawPaths();
      if (!fitted && markers.size && box.clientWidth > 50 && box.clientHeight > 50) { fitted = true; fit(); }
    }

    function drawPaths() {
      if (!pathLayer) return;
      pathLayer.clearLayers();
      if (!opts.paths) return;
      const now = Date.now(), list = journeys.slice(-MAX_PATHS);
      list.forEach((j, i) => {
        const pts = [];
        for (const id of j.ids) { const p = posOf(node(id)); if (!p) return; pts.push([p.lat, p.lon]); }
        if (pts.length < 2) return;
        // fade: older and further back in the list = fainter (steady, redrawn on the 30 s tick / new packets)
        const ageF = Math.max(0, 1 - (now - j.t) / (30 * MIN)), rankF = (i + 1) / list.length;
        const op = 0.12 + 0.68 * ageF * rankF;
        const col = (c.PJ && c.PJ.PALETTE[j.kind] || {}).color || '#00e5ff';
        L.polyline(pts, { color: col, weight: 2.5, opacity: op, interactive: false, className: 'pj-map-path' }).addTo(pathLayer);
      });
    }

    function fit() {
      if (!map || !markers.size) return;
      const pts = [...markers.values()].map(mk => [mk.lat, mk.lon]);
      try { if (pts.length === 1) map.setView(pts[0], 11); else map.fitBounds(pts, { padding: [30, 30], maxZoom: 12 }); } catch (e) { /* zero-size map */ }
    }

    function pulse(lat, lon) {
      if (!map || pulseCount >= MAX_PULSES || !okPos(lat, lon)) return;
      let fxOn = true; try { fxOn = c.fx ? c.fx() : true; } catch (e) { fxOn = true; }
      if (!fxOn) return;
      const col = (c.PJ && c.PJ.PALETTE.advert && c.PJ.PALETTE.advert.color) || '#00e5ff';
      const m = L.marker([lat, lon], { interactive: false, keyboard: false, zIndexOffset: -50,
        icon: L.divIcon({ className: 'pj-map-wrap', iconSize: [60, 60], iconAnchor: [30, 30], html: `<i class="pj-map-pulse" style="--pj-map-pc:${col}"></i>` }) });
      m.addTo(map); pulseCount++;
      setTimeout(() => { m.remove(); pulseCount--; }, 1700);
    }

    function highlight(id, pan) {
      selId = id;
      if (!vis() || !map) { dirty = true; return; }
      sync();
      const mk = markers.get(id);
      if (mk && pan) { try { map.panTo([mk.lat, mk.lon]); } catch (e) { /* ignore */ } }
    }

    // ---------------------------------------------------------------- bus
    function onPacket(ev) {
      if (!ev) return;
      const t = typeof ev.t === 'number' ? ev.t : Date.now();
      const stamp = id => { if (!id || id === 'unknown') return; const k = canon(id); if ((heard.get(k) || 0) < t) heard.set(k, t); };
      const srcId = ev.src && ev.src.id;
      stamp(srcId); stamp(ev.heardFrom);
      if (ev.route === 'flood' && Array.isArray(ev.journey)) ev.journey.forEach(stamp);
      if (srcId && ev.gps && okPos(ev.gps.lat, ev.gps.lon)) gpsOf.set(canon(srcId), { lat: ev.gps.lat, lon: ev.gps.lon });
      if (ev.route === 'flood' && Array.isArray(ev.journey) && ev.journey.length >= 2 && !ev.journey.includes('unknown')) {
        journeys.push({ ids: ev.journey.slice(), kind: ev.kind || 'unknown', t });
        if (journeys.length > MAX_PATHS * 3) journeys = journeys.slice(-MAX_PATHS * 2);
      }
      if (!vis()) { dirty = true; return; }
      later();
      if (ev.kind === 'advert' && ev.gps) pulse(ev.gps.lat, ev.gps.lon);
    }
    function onNodes() {
      // folded ids: carry heard / gps across to the new id; dropped ids just fall out of stations()
      for (const [id, v] of [...heard]) { const k = canon(id); if (k !== id) { heard.delete(id); if ((heard.get(k) || 0) < v) heard.set(k, v); } }
      for (const [id, v] of [...gpsOf]) { const k = canon(id); if (k !== id) { gpsOf.delete(id); if (!gpsOf.has(k)) gpsOf.set(k, v); } }
      if (selId) selId = canon(selId);
      if (!vis()) { dirty = true; return; }
      later();
    }
    function onVisible(v) {
      if (!v || !map) { if (!map && v) sync(); return; }
      setTimeout(() => { if (destroyed) return; try { map.invalidateSize(); } catch (e) { /* ignore */ } sync(); }, 60);
    }
    function onReset() {
      heard.clear(); gpsOf.clear(); journeys = []; selId = null; fitted = false;
      for (const mk of markers.values()) mk.m.remove();
      markers.clear(); if (pathLayer) pathLayer.clearLayers();
      dirty = true; if (vis()) sync(); else countEl.textContent = '0 stations with GPS · 0 without';
    }
    function onSelect(s) {
      if (!s || !s.node || s.from === 'map') return;
      highlight(canon(s.node), true);
    }
    const guard = fn => x => { try { fn(x); } catch (e) { console.warn('pj-map', e); } };
    const unsubs = [
      c.bus.on('packet', guard(onPacket)), c.bus.on('nodes', guard(onNodes)), c.bus.on('visible', guard(onVisible)),
      c.bus.on('reset', guard(onReset)), c.bus.on('select', guard(onSelect)),
    ];

    q('.pj-map-paths').onchange = e => { opts.paths = !!e.target.checked; try { store.set('pjMap', opts); } catch (er) { /* full */ } drawPaths(); };
    q('.pj-map-fit').onclick = fit;
    timer = setInterval(() => { try { if (vis()) sync(); } catch (e) { console.warn('pj-map', e); } }, TICK);
    try { sync(); } catch (e) { console.warn('pj-map', e); }

    return {
      destroy() {
        destroyed = true; clearInterval(timer); clearTimeout(soon); unsubs.forEach(u => u && u());
        try { if (map) map.remove(); } catch (e) { /* ignore */ }
        mount.innerHTML = '';
      },
      // tests
      _state: () => ({ markers: [...markers.entries()].map(([id, mk]) => ({ id, key: mk.key, lat: mk.lat, lon: mk.lon })), paths: pathLayer ? pathLayer.getLayers().length : 0, pulses: pulseCount, sel: selId, map }),
    };
  };
})();
