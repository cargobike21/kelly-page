/* Kelly Page -- LoRa Mesh > 📍 MeshPRS tab (2026-10-31, unreleased). APRS over MeshCore, made visible: MeshPRS frames
 * (GRP_DATA 0xFF4D on #meshprs, MeshPRS/spec/MeshPRS-Spec.md) and the profile-0 adverts of nodes on the iGate list, on a
 * map with real APRS symbols, a test panel per tracker (last heard, beacon interval, missed frames from seq), the live
 * packet log with every byte laid out, and the iGate's verdict on each frame.
 *
 * It owns NO APRS-IS connection: the iGate is js/igateui.js (the APRS iGate page) -- same settings, same list, same
 * bridge login. This tab reads its status, follows each frame through its gate (igate.onMprs) and flips its switches
 * (igate.mprsSet: on / dry / mprs). The big switch is DRY RUN vs LIVE; dry run is the default for a new Kelly.
 *
 * window.KellyMeshPRSUI(k) -> { init(), shown(), hidden(), feed(kind, x) }   k from mesh.js: { $, esc, store, toast,
 *   settings, fmtAgo, ms, myPos(), igate(), demo(), isMeshCore(), showPage(p), nodeName(key) }
 * feed kinds (mesh.js IG): 'chdata' (companion RESP 27), 'grpdata' (raw log GRP_DATA, for rssi / path, and the
 *   frames themselves when the node has no #meshprs slot), 'advert' (a fresh advert with a position).
 * Pure part: js/mprs-core.js (tests/mprs-core-test.js). Browser test: tests/mprs-cdp.js. Demo: index.html#mprs-demo
 * with LoRa Mesh on the MeshCore Demo -- Bravo's VK4ZB-7 drives a loop near Ipswich, one frame every 15 s, 1 in 6 "lost".
 * Stored: 'mprsUI' (settings below), 'mprsTracks' (stations + tracks, Tracker.json).
 * Symbols: hessu/aprs-symbols (vendor/aprs-symbols-f2286a9, credited on the map). Nothing animates forever.
 */
(function () {
  'use strict';
  const SYM = 'vendor/aprs-symbols-f2286a9/png/aprs-symbols-24-';
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
  const ESRI_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
  const ESRI_ATTR = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';
  const RAW_MS = 4000, TICK_MS = 5000, SAVE_MS = 60000, DEMO_MS = 15000, DEMO_MAX = 40;
  const KIND = { frame: ['MeshPRS', 'frame'], advert: ['advert · profile 0', 'advert'], object: ['object', 'object'] };
  const GSTATE = { queued: ['⏳', 'queued'], sent: ['✅', 'sent to APRS-IS'], dry: ['🧪', 'dry run'], drop: ['⛔', 'not gated'] };
  // the demo drive: a loop through Ipswich's west (Bravo's sim station starts at -27.6275, 152.7644)
  const ROUTE = [[-27.6275, 152.7644], [-27.6247, 152.7688], [-27.6206, 152.7723], [-27.6163, 152.7765], [-27.6136, 152.7831], [-27.6151, 152.7903],
    [-27.6197, 152.7934], [-27.6255, 152.7916], [-27.6302, 152.7863], [-27.6326, 152.7794], [-27.6319, 152.7720], [-27.6295, 152.7668]];

  window.KellyMeshPRSUI = function (k) {
    const { $, esc, store, toast, fmtAgo } = k;
    const M = window.MeshPRS, P = window.KellyMPRS, MC = window.KellyMcDecode;
    if (!M || !P) return { init() {}, shown() {}, hidden() {}, feed() {} };
    const cfg = Object.assign({ tile: '', track: 50, staleMin: 30, adverts: true, expectS: 120 }, store.get('mprsUI', {}) || {});
    const T = P.Tracker({ expectS: cfg.expectS });
    T.load(store.get('mprsTracks', null));
    let root = null, visible = false, built = false, map = null, L0 = null, tileOk = 0, tileErr = 0, offline = false, grid = null, meMk = null;
    let sel = null, follow = '', pick = null, paused = false, filter = '', soonT = null, tickT = null, saveAt = 0, changed = false, unsub = null, fitted = false;
    let demo = null;
    const raws = [], marks = new Map(), q = s => root && root.querySelector(s);
    const ig = () => (k.igate ? k.igate() : null);
    const igs = () => { const g = ig(); return g && g.mprsStatus ? g.mprsStatus() : null; };
    const save = () => store.set('mprsUI', cfg);
    const ago = t => (t ? fmtAgo(t) : '—');
    const secs = s => (s == null ? '—' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
    const callOk = c => /^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$/.test(c || '');
    const aprsFi = c => `https://aprs.fi/#!call=a%2F${encodeURIComponent(c)}`;

    // ---------------------------------------------------------------- in
    function hook() {   // the iGate page is made after the mesh page: subscribe once it exists
      if (unsub) return; const g = ig(); if (!g || !g.onMprs) return;
      unsub = g.onMprs(ev => { if (T.gate(ev)) { changed = true; soon(); } });
    }
    function rec(r) { changed = true; if (r && r.sid && !follow && !sel) sel = r.sid; soon(); }
    function feed(kind, x) {
      hook();
      const now = Date.now();
      if (kind === 'grpdata' && x && x.raw) {
        let d = null; try { d = MC ? MC.decode(x.raw, { channels: [{ name: M.CHANNEL, secret: M.CHANNEL_KEY }] }) : null; } catch { /* */ }
        const r = { at: now, raw: x.raw, snr: x.snr, rssi: x.rssi, d, used: false };
        raws.unshift(r); raws.length = Math.min(raws.length, 30);
        // no #meshprs slot on the node: the frame itself comes from the raw log, decrypted with the public key
        const st = igs(), inf = d && d.info;
        if (st && st.slot == null && inf && inf.channel && inf.dataType === M.DATA_TYPE && inf.data) {
          r.used = true; rec(T.frame({ at: now, blob: M.unhex(inf.data), via: 'raw log', snr: x.snr, rssi: x.rssi, hops: d.hops, path: d.path || null, raw: M.hex(x.raw) }));
        }
        return;
      }
      if (kind === 'chdata' && x && x.type === M.DATA_TYPE && /^#meshprs$/i.test(x.chName || '')) {
        const hex = M.hex(x.data);
        // the same packet's raw log line (heard a moment before): rssi and the path. Bytes match when it decrypts;
        // otherwise the newest unused GRP_DATA (the demo node's raw log carries no real ciphertext)
        let m = raws.find(r => !r.used && now - r.at < RAW_MS && r.d && r.d.info && r.d.info.data && r.d.info.data.toUpperCase() === hex);
        if (!m) m = raws.find(r => !r.used && now - r.at < RAW_MS && !(r.d && r.d.info && r.d.info.data));
        if (m) m.used = true;
        rec(T.frame({ at: x.at || now, blob: x.data, via: 'node', snr: x.snr, rssi: m ? m.rssi : null, hops: x.hops, path: m && m.d ? m.d.path || null : null, raw: m ? M.hex(m.raw) : null }));
        return;
      }
      if (kind === 'advert' && x && x.key && cfg.adverts) {
        const g = ig(), e = g && g.entryFor ? g.entryFor(x.key) : null;
        if (!e || !e.e) return;   // only nodes on my iGate list: those are the profile-0 trackers
        rec(T.advert({ at: x.at || now, key: x.key, call: `${e.c}-${e.s}`, sym: e.y, comment: e.m || '', lat: x.lat, lon: x.lon, name: x.name || k.nodeName(x.key), snr: x.snr, hops: x.hops }));
      }
    }

    // ---------------------------------------------------------------- the shell
    function shell() {
      root.innerHTML = `<div class="mprs">
        <div class="card mprs-top">
          <div class="mprs-title"><h3>📍 MeshPRS</h3><span class="tag">APRS over MeshCore · spec 1.0 Candidate</span><span class="grow"></span>
            <button class="btn small primary" id="mp-demo" hidden>▶ Demo tracker</button>
            <a class="btn small ghost" href="https://cargobike21.github.io/MeshPRS/MeshPRS-Spec.html" target="_blank" rel="noopener">📖 The standard</a>
            <a class="btn small ghost" href="https://github.com/cargobike21/MeshPRS" target="_blank" rel="noopener">🐙 GitHub project</a></div>
          <p class="mprs-lede">A MeshCore station sends its position as a tiny <b>MeshPRS frame</b> on the <b>#meshprs</b> channel; Kelly hears it through your USB node,
            puts it on the map, turns it into an <b>APRS</b> line and -- when you go live -- gates it to <b>APRS-IS</b>, where it shows on <b>aprs.fi</b>.
            Nodes on your iGate list that only send ordinary adverts show here too, as <b>profile 0</b>.</p>
          <div class="mprs-strip">
            <div class="mprs-chip" id="mp-c-slot"></div>
            <div class="mprs-chip" id="mp-c-ig"></div>
            <div class="mprs-switch" id="mp-sw" role="group" aria-label="Dry run or live">
              <button id="mp-dry" title="Show what would go to APRS-IS, send nothing">🧪 DRY RUN</button>
              <button id="mp-live" title="Gate to APRS-IS for real: stations show on aprs.fi">📡 LIVE</button></div>
          </div>
          <p class="mprs-note">🔓 Only <b>#meshprs</b> is gated -- a hashtag channel whose key anyone can work out from its name, so nothing on it is private.
            Direct messages, private channels and room servers are <b>never</b> sent to APRS-IS (spec §11, §13).</p>
        </div>
        <div class="tabs" data-tabs="mprs"><button data-tab="map" class="on">🗺️ Map &amp; trackers</button><button data-tab="pkts">📡 Live packets</button><button data-tab="ig">🚦 iGate</button><button data-tab="set">⚙️ Settings</button></div>
        <div class="tab on" data-tabpane="mprs:map"><div class="mprs-grid">
          <div class="card mprs-mapcard"><div class="card-h"><h2>🗺️ Map</h2><span class="grow"></span>
              <button class="btn ghost small" id="mp-fit" title="Zoom to every station">⤢ Fit all</button>
              <label class="dim small">Follow <select id="mp-follow" class="mini-in"></select></label>
              <label class="dim small">Track <select id="mp-trackn" class="mini-in">${[10, 50, 200, 500].map(n => `<option value="${n}">${n} points</option>`).join('')}</select></label></div>
            <div class="mprs-map" id="mp-map"></div>
            <div class="mprs-mapnote" id="mp-mapnote" hidden></div>
            <p class="dim small mprs-credit">APRS symbols: <a href="https://github.com/hessu/aprs-symbols" target="_blank" rel="noopener">hessu/aprs-symbols</a> (OH7LZB, aprs.fi) ·
              faded = not heard for ${esc(String(cfg.staleMin))} min · ▲ = heading</p></div>
          <div class="mprs-col"><div class="card"><div class="card-h"><h2>🛰️ Trackers</h2><span class="dim small" id="mp-tcount"></span></div><div id="mp-trackers" class="mprs-trackers"></div></div></div>
        </div></div>
        <div class="tab" data-tabpane="mprs:pkts"><div class="mprs-grid">
          <div class="card"><div class="card-h"><h2>📡 Live packets</h2><span class="grow"></span>
              <input id="mp-pf" class="mini-in" placeholder="Filter: callsign">
              <button class="btn ghost small" id="mp-pause">⏸ Pause</button><button class="btn ghost small" id="mp-pclear">Clear</button></div>
            <div class="mprs-plist" id="mp-plist"></div></div>
          <div class="card"><div class="card-h"><h2>🔬 Packet</h2></div><div id="mp-pdetail" class="mprs-pdetail"></div></div>
        </div></div>
        <div class="tab" data-tabpane="mprs:ig"><div class="mprs-grid">
          <div class="card"><div class="card-h"><h2>🚦 iGate</h2><span class="grow"></span><button class="btn ghost small" id="mp-igpage">Open the APRS iGate page ›</button></div><div id="mp-ig"></div></div>
          <div class="card"><div class="card-h"><h2>⛔ Why frames were not gated</h2></div><div id="mp-drops"></div></div>
        </div></div>
        <div class="tab" data-tabpane="mprs:set"><div class="card mprs-set">
          <div class="card-h"><h2>⚙️ Settings</h2></div>
          <label>Map tiles <input id="mp-s-tile" placeholder="(default: the LoRa Mesh map's own server, else Esri dark grey)" spellcheck="false"></label>
          <p class="dim small">A tile URL with {z} {x} {y}, e.g. a tile server on your Pi. With no tiles (the Pi offline) the stations still show, on a plain grid.</p>
          <label>Faded after <input id="mp-s-stale" type="number" min="1" max="1440" class="mini-in"> min unheard</label>
          <label>Expected beacon interval <input id="mp-s-exp" type="number" min="5" max="3600" class="mini-in"> s (until a station has shown its own)</label>
          <label class="tog"><input type="checkbox" id="mp-s-adv"><i></i><span>Show listed nodes' adverts (profile 0) as trackers too</span></label>
          <p class="dim small">Your callsign, SSID, APRS-IS server, passcode (kept in the Kelly bridge only), the station list and your own MeshPRS beacon are all on the
            <a href="#" id="mp-s-igpage">APRS iGate page</a>: this tab shares them, it never keeps a second copy.</p>
          <button class="btn small danger" id="mp-s-clear">🗑️ Forget every station</button>
        </div></div>
      </div>`;
      const tabs = q('[data-tabs="mprs"]');
      tabs.addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (!b) return;
        tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        root.querySelectorAll('[data-tabpane^="mprs:"]').forEach(p => p.classList.toggle('on', p.dataset.tabpane === `mprs:${b.dataset.tab}`));
        if (b.dataset.tab === 'map' && map) setTimeout(() => map.invalidateSize(), 50);
        draw(); });
      q('#mp-dry').onclick = () => setLive(false);
      q('#mp-live').onclick = () => setLive(true);
      q('#mp-demo').onclick = () => (demo ? stopDemo() : startDemo());
      q('#mp-fit').onclick = () => { follow = ''; q('#mp-follow').value = ''; fitAll(); };
      q('#mp-follow').onchange = e => { follow = e.target.value; if (follow) { sel = follow; panTo(follow); } draw(); };
      const tn = q('#mp-trackn'); tn.value = String(cfg.track); tn.onchange = () => { cfg.track = +tn.value || 50; save(); marks.forEach(m => { m.tsig = ''; }); draw(); };
      q('#mp-pf').oninput = e => { filter = e.target.value.trim().toUpperCase(); drawPackets(); };
      q('#mp-pause').onclick = () => { paused = !paused; q('#mp-pause').textContent = paused ? '▶ Resume' : '⏸ Pause'; drawPackets(); };
      q('#mp-pclear').onclick = () => { T.packets().length = 0; pick = null; drawPackets(); };
      q('#mp-plist').onclick = e => { const r = e.target.closest('[data-p]'); if (r) { pick = +r.dataset.p; drawPackets(); } };
      q('#mp-trackers').onclick = e => {
        const b = e.target.closest('[data-act]'), card = e.target.closest('[data-sid]'); if (!card) return;
        const id = card.dataset.sid;
        if (b && b.dataset.act === 'follow') { follow = follow === id ? '' : id; q('#mp-follow').value = follow; if (follow) panTo(id); }
        else if (b && b.dataset.act === 'pkt') { const s = T.station(id); if (s && s.lastRec) { pick = s.lastRec.id; showSub('pkts'); } }
        else if (b && b.dataset.act === 'igate') {   // the APRS iGate page's 🔎 Add my device, searching for this tracker's key
          const s = T.station(id), g = ig(); k.showPage('igate');
          if (g && g.findDevice) setTimeout(() => g.findDevice(s && s.key ? String(s.key).slice(0, 8).toLowerCase() : (s ? s.call.split('-')[0] : '')), 150);
        }
        else if (!e.target.closest('a, summary, details')) { sel = id; panTo(id); }
        draw(); };
      const goIg = e => { if (e) e.preventDefault(); k.showPage('igate'); };
      q('#mp-igpage').onclick = goIg; q('#mp-s-igpage').onclick = goIg;
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-do]'); if (!b) return;
        if (b.dataset.do === 'ig-on') { const g = ig(); if (g) g.mprsSet('on', true); }
        if (b.dataset.do === 'mp-on') { const g = ig(); if (g) g.mprsSet('mprs', true); }
        if (b.dataset.do === 'slot') { const g = ig(); if (g && g.addMprsChannel) g.addMprsChannel(); }
        if (b.dataset.do === 'igpage') k.showPage('igate');
        setTimeout(draw, 300); });
      const tile = q('#mp-s-tile'); tile.value = cfg.tile; tile.onchange = () => { cfg.tile = tile.value.trim(); save(); resetTiles(); };
      const stale = q('#mp-s-stale'); stale.value = cfg.staleMin; stale.onchange = () => { cfg.staleMin = Math.min(1440, Math.max(1, +stale.value || 30)); save(); draw(); };
      const exp = q('#mp-s-exp'); exp.value = cfg.expectS; exp.onchange = () => { cfg.expectS = Math.min(3600, Math.max(5, +exp.value || 120)); save(); draw(); };
      const adv = q('#mp-s-adv'); adv.checked = !!cfg.adverts; adv.onchange = () => { cfg.adverts = adv.checked; save(); };
      q('#mp-s-clear').onclick = () => { if (!confirm('Forget every MeshPRS station and track on this Kelly?')) return; T.clear(); marks.forEach(m => m.g.remove()); marks.clear(); sel = follow = ''; changed = true; persist(true); draw(); };
      built = true;
    }
    const showSub = t => { const b = q(`[data-tabs="mprs"] [data-tab="${t}"]`); if (b) b.click(); };

    // ---------------------------------------------------------------- dry run / live (the iGate page's own switches)
    function setLive(live) {
      const g = ig(), st = igs();
      if (!g || !st) { toast('📡', 'The APRS iGate did not load', '', 'bad'); return; }
      if (!live) { g.mprsSet('dry', true); toast('🧪', 'Dry run', 'Nothing goes to APRS-IS; the iGate log shows what would have'); draw(); return; }
      if (!st.dry && st.on && st.mprs) return;
      if (!callOk(st.call)) { toast('⚠️', 'A callsign first', 'Set your iGate callsign on the APRS iGate page', 'bad'); k.showPage('igate'); return; }
      if (!st.listed) { toast('⚠️', 'Your iGate list is empty', 'Only stations on your list are gated -- add some on the APRS iGate page', 'bad'); return; }
      if (!confirm(`Go LIVE?\n\nMeshPRS frames from the ${st.listed} station(s) on your list will be gated to APRS-IS (${st.server}) as ${st.call} and show on aprs.fi.\n\nDry run stays one click away.`)) return;
      g.mprsSet('dry', false); if (!st.on) g.mprsSet('on', true); if (!st.mprs) g.mprsSet('mprs', true);
      toast('📡', 'LIVE to APRS-IS', `Gating as ${st.call}`, 'good'); draw();
    }

    // ---------------------------------------------------------------- the map
    function makeMap() {
      if (map || !window.L) return;
      const el = q('#mp-map'); if (!el || el.clientWidth < 50) return;
      const me = k.myPos && k.myPos();
      map = L.map(el, { zoomControl: true, attributionControl: true }).setView(me ? [me.lat, me.lon] : [-27.55, 152.85], 11);
      if (window.ResizeObserver) new ResizeObserver(() => map && map.invalidateSize()).observe(el);
      L0 = { tiles: L.layerGroup().addTo(map), tracks: L.layerGroup().addTo(map), stations: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map), grid: L.layerGroup().addTo(map) };
      resetTiles();
      map.on('moveend', () => { if (offline) drawGrid(); });
    }
    function tileSources() {
      const own = String(cfg.tile || (k.ms && k.ms.tileOwn) || '').trim();
      return own ? [[own, { maxZoom: 19, attribution: 'Own tile server' }]] : [[ESRI, { maxZoom: 16, attribution: ESRI_ATTR }], [ESRI_LABELS, { maxZoom: 16 }]];
    }
    function resetTiles() {
      if (!map) return;
      L0.tiles.clearLayers(); tileOk = 0; tileErr = 0; setOffline(false);
      for (const [url, o] of tileSources()) {
        const l = L.tileLayer(url, o).addTo(L0.tiles);
        l.on('tileload', () => { tileOk++; if (offline) setOffline(false); });
        l.on('tileerror', () => { tileErr++; if (!tileOk && tileErr >= 3) setOffline(true); });
      }
      // a tile server that never answers at all (no error, no load): offline after 8 s
      setTimeout(() => { if (map && !tileOk) setOffline(true); }, 8000);
    }
    function setOffline(v) {
      if (offline === v) return; offline = v;
      const n = q('#mp-mapnote'); if (n) { n.hidden = !v; n.textContent = v ? '🧭 Map tiles unreachable (offline?) -- stations on a plain lat / lon grid' : ''; }
      q('#mp-map') && q('#mp-map').classList.toggle('offline', v);
      if (v) drawGrid(); else if (L0) L0.grid.clearLayers();
    }
    function drawGrid() {
      if (!map) return; L0.grid.clearLayers();
      const b = map.getBounds(), z = map.getZoom();
      const step = z >= 14 ? 0.005 : z >= 12 ? 0.02 : z >= 10 ? 0.1 : z >= 8 ? 0.5 : z >= 6 ? 2 : 10;
      const st = { color: '#2c3e68', weight: 1, opacity: 0.8, interactive: false };
      for (let la = Math.floor(b.getSouth() / step) * step; la <= b.getNorth(); la += step) {
        L.polyline([[la, b.getWest()], [la, b.getEast()]], st).addTo(L0.grid);
        L.marker([la, b.getWest()], { interactive: false, icon: L.divIcon({ className: 'mprs-gl', html: `${la.toFixed(step < 0.1 ? 3 : 1)}°`, iconSize: [60, 12], iconAnchor: [-2, 12] }) }).addTo(L0.grid);
      }
      for (let lo = Math.floor(b.getWest() / step) * step; lo <= b.getEast(); lo += step) {
        L.polyline([[b.getSouth(), lo], [b.getNorth(), lo]], st).addTo(L0.grid);
        L.marker([b.getNorth(), lo], { interactive: false, icon: L.divIcon({ className: 'mprs-gl', html: `${lo.toFixed(step < 0.1 ? 3 : 1)}°`, iconSize: [60, 12], iconAnchor: [-2, -2] }) }).addTo(L0.grid);
      }
    }
    function symHtml(sym, size = 24) {
      const s = P.sprite(sym), px = (c, r) => `-${c * size}px -${r * size}px`, bs = `${16 * size}px ${6 * size}px`;
      const one = (sheet, c, r, cls) => `<i class="mprs-sym${cls}" style="width:${size}px;height:${size}px;background-image:url('${SYM}${sheet}@2x.png');background-size:${bs};background-position:${px(c, r)}"></i>`;
      return `<span class="mprs-symw" style="width:${size}px;height:${size}px" title="${esc(sym || '')}">${one(s.sheet, s.col, s.row, '')}${s.overlay ? one(2, s.ocol, s.orow, ' ov') : ''}</span>`;
    }
    // a frame sender is on my iGate list when an entry's key starts with its frame's key prefix
    const onList = s => { const g = ig(), L = g && g.list ? g.list() : null, p = String(s.key || '').toLowerCase();
      return !!(p && L && L.e.some(x => x.e && String(x.k).startsWith(p))); };
    const ageCls = s => { const m = (Date.now() - s.last) / 60000; return m > cfg.staleMin * 3 ? 'old' : m > cfg.staleMin ? 'stale' : ''; };
    function popHtml(s) {
      const pt = s.track[s.track.length - 1] || {}, r = s.lastRec, f = r && r.f, g = s.lastGate, kind = KIND[s.kind] || KIND.frame;
      const rows = [
        ['Symbol', `${symHtml(s.sym)} <code>${esc(s.sym || '')}</code>`],
        s.comment ? ['Comment', esc(s.comment)] : null,
        pt.speed != null || pt.course != null ? ['Moving', `${pt.speed != null ? `${pt.speed} km/h` : ''} ${pt.course != null ? `${pt.course}°` : ''}`] : null,
        pt.alt != null ? ['Altitude', `${pt.alt} m`] : null,
        ['Heard', `${new Date(s.last).toLocaleTimeString()} (${ago(s.last)})`],
        ['Path', `${s.hops == null ? '?' : s.hops === 0 ? 'direct' : `${s.hops} hop${s.hops === 1 ? '' : 's'}`}${s.path && s.path.length ? ` · ${esc(s.path.join(' → '))}` : ''}`],
        s.snr != null || s.rssi != null ? ['Signal', `${s.snr != null ? `SNR ${s.snr} dB` : ''} ${s.rssi != null ? `RSSI ${s.rssi} dBm` : ''}`] : null,
        ['iGate', g ? `${GSTATE[g.st][0]} ${esc(GSTATE[g.st][1])}${g.reason ? ` -- ${esc(g.reason)}` : ''}` : s.kind === 'advert' ? 'on the APRS iGate page' : '--'],
      ].filter(Boolean);
      return `<div class="mprs-pop"><b>${esc(s.call)}</b> <span class="mprs-k ${kind[1]}">${esc(kind[0])}</span>${s.name ? `<div class="dim small">${esc(s.name)}</div>` : ''}
        <table>${rows.map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join('')}</table>
        ${f && f.subtype === 0 || s.kind === 'advert' ? `<a href="${aprsFi(s.call)}" target="_blank" rel="noopener">${esc(s.call)} on aprs.fi ›</a>` : ''}</div>`;
    }
    function drawMap() {
      makeMap(); if (!map) return;
      const all = T.stations().filter(s => s.lat != null);
      for (const s of all) {
        let m = marks.get(s.id);
        const cls = ageCls(s), sig = `${s.sym}|${s.call}|${cls}|${s.heading}|${sel === s.id}|${s.kind}`;
        if (!m) { m = { g: null, sig: '', tsig: '', line: null, dots: null }; marks.set(s.id, m); }
        const html = `<div class="mprs-mk ${cls} ${KIND[s.kind] ? KIND[s.kind][1] : ''}${sel === s.id ? ' sel' : ''}">${symHtml(s.sym)}${s.heading != null ? `<b class="mprs-arrow" style="transform:rotate(${s.heading}deg)"></b>` : ''}<em>${esc(s.call)}</em></div>`;
        if (!m.g) {
          m.g = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'mprs-mkw', html, iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12] }), zIndexOffset: 500 }).addTo(L0.stations);
          m.g.bindPopup(() => popHtml(T.station(s.id) || s), { maxWidth: 320 });
          m.g.on('click', () => { sel = s.id; drawTrackers(); });
          m.sig = sig;
        } else {
          m.g.setLatLng([s.lat, s.lon]);
          if (m.sig !== sig) { m.g.setIcon(L.divIcon({ className: 'mprs-mkw', html, iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12] })); m.sig = sig; }
          if (m.g.isPopupOpen()) m.g.setPopupContent(popHtml(s));
        }
        const tr = s.track.slice(-cfg.track), tsig = `${tr.length}|${tr.length ? tr[tr.length - 1].at : 0}|${cls}`;
        if (m.tsig !== tsig) {
          m.tsig = tsig; if (m.line) m.line.remove(); if (m.dots) m.dots.remove();
          const col = s.kind === 'advert' ? '#a78bfa' : s.kind === 'object' ? '#ffb020' : '#00e5ff', op = cls === 'old' ? 0.25 : cls === 'stale' ? 0.45 : 0.85;
          m.line = tr.length > 1 ? L.polyline(tr.map(p => [p.lat, p.lon]), { color: col, weight: 2.5, opacity: op, interactive: false }).addTo(L0.tracks) : null;
          m.dots = L.layerGroup(tr.slice(0, -1).map(p => L.circleMarker([p.lat, p.lon], { radius: 2.5, color: col, weight: 1, opacity: op, fillOpacity: op * 0.8 })
            .bindTooltip(`${esc(s.call)} · ${new Date(p.at).toLocaleTimeString()}${p.speed != null ? ` · ${p.speed} km/h` : ''}`))).addTo(L0.tracks);
        }
      }
      for (const [id, m] of marks) if (!T.station(id)) { if (m.g) m.g.remove(); if (m.line) m.line.remove(); if (m.dots) m.dots.remove(); marks.delete(id); }
      // me: this Kelly, the iGate
      const me = k.myPos && k.myPos(), st = igs();
      if (me && me.lat != null) {
        const html = `<div class="mprs-mk me"><span class="mprs-me">📡</span><em>${esc((st && st.call) || 'this iGate')}</em></div>`;
        if (!meMk) meMk = L.marker([me.lat, me.lon], { icon: L.divIcon({ className: 'mprs-mkw', html, iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: 400 })
          .bindTooltip('This Kelly -- your iGate').addTo(L0.me);
        else { meMk.setLatLng([me.lat, me.lon]); if (meMk._mprsHtml !== html) meMk.setIcon(L.divIcon({ className: 'mprs-mkw', html, iconSize: [24, 24], iconAnchor: [12, 12] })); }
        meMk._mprsHtml = html;
      }
      if (follow) panTo(follow, true);
      else if (!fitted && all.length) { fitted = true; fitAll(); }
    }
    function panTo(id, soft) { const s = T.station(id); if (map && s && s.lat != null) { if (soft) map.panTo([s.lat, s.lon], { animate: true }); else map.setView([s.lat, s.lon], Math.max(map.getZoom(), 14)); } }
    function fitAll() {
      if (!map) return;
      const pts = T.stations().filter(s => s.lat != null).map(s => [s.lat, s.lon]), me = k.myPos && k.myPos();
      if (me && me.lat != null) pts.push([me.lat, me.lon]);
      if (pts.length === 1) map.setView(pts[0], 14); else if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
    }

    // ---------------------------------------------------------------- the trackers (the GPS device test panel)
    function drawTrackers() {
      const box = q('#mp-trackers'); if (!box) return;
      const all = T.stations(), now = Date.now(), sw = q('#mp-follow');
      q('#mp-tcount').textContent = all.length ? `${all.length} heard` : '';
      const opts = `<option value="">-- none --</option>` + all.filter(s => s.lat != null).map(s => `<option value="${esc(s.id)}">${esc(s.call)}</option>`).join('');
      if (sw.dataset.sig !== opts) { sw.innerHTML = opts; sw.dataset.sig = opts; } sw.value = follow;
      if (!all.length) { box.innerHTML = emptyHint(); return; }
      box.innerHTML = all.map(s => {
        const b = P.beacon(s, now, cfg.expectS), pt = s.track[s.track.length - 1] || {}, kind = KIND[s.kind] || KIND.frame, g = s.lastGate, r = s.lastRec;
        const since = (now - s.last) / 1000, age = ageCls(s);
        const gate = g ? `<span class="mprs-g ${g.st}" title="${esc(g.reason ? P.WHY[g.reason] || g.reason : g.line || '')}">${GSTATE[g.st][0]} ${esc(GSTATE[g.st][1])}${g.reason ? `: ${esc(g.reason)}` : ''}</span>`
          : s.kind === 'advert' ? '<span class="mprs-g">gated by the iGate page (adverts)</span>' : '<span class="mprs-g">iGate: not seen yet</span>';
        const fix = r && r.f && r.f.subtype === 0 ? `${r.f.amb ? `ambiguity ${r.f.amb} · ` : ''}${r.f.alt !== undefined ? `alt ${r.f.alt} m · ` : ''}${r.f.course !== undefined ? `${pt.course}° ${r.f.speed} km/h` : 'no course'}` : s.kind === 'advert' ? 'advert position' : '';
        return `<div class="mprs-tk ${age}${sel === s.id ? ' sel' : ''}${follow === s.id ? ' fol' : ''}" data-sid="${esc(s.id)}">
          <div class="mprs-tk-h">${symHtml(s.sym)}<b>${esc(s.call)}</b><span class="mprs-k ${kind[1]}">${esc(kind[0])}</span><span class="grow"></span>
            <span class="mprs-age ${b.overdue ? 'late' : ''}" title="Last heard ${esc(new Date(s.last).toLocaleString())}">${esc(secs(since))} ago</span></div>
          <div class="mprs-tk-b">
            <div><span class="dim">Node</span> ${esc(s.name || k.nodeName(s.key) || '--')}${s.key ? ` <code>${esc(String(s.key).slice(0, 8))}</code>` : ''}</div>
            <div><span class="dim">Fix</span> ${s.lat != null ? `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` : 'none'} ${fix ? `<span class="dim">· ${esc(fix)}</span>` : ''}</div>
            <div><span class="dim">Radio</span> ${s.snr != null ? `SNR ${s.snr} dB` : 'SNR --'} · ${s.rssi != null ? `RSSI ${s.rssi} dBm` : 'RSSI --'} · ${s.hops == null ? 'hops ?' : s.hops === 0 ? 'direct' : `${s.hops} hop${s.hops === 1 ? '' : 's'}`}${s.path && s.path.length ? ` <code>${esc(s.path.join('→'))}</code>` : ''}</div>
            <div class="mprs-beacon"><span title="Expected: the median of this station's own gaps (or the setting, until it has two)"><span class="dim">Every</span> ${esc(secs(b.expectS))}</span>
              <span><span class="dim">last gap</span> ${esc(secs(b.lastS))}</span><span><span class="dim">avg</span> ${esc(secs(b.avgS))}</span>
              ${s.kind !== 'advert' ? `<span class="${b.missed ? 'bad' : ''}" title="From the frame counter (seq): frames this station sent that you did not hear"><span class="dim">missed</span> ${b.missed}${b.pct != null ? ` <span class="dim">(${b.pct}% heard)</span>` : ''}</span>` : ''}
              ${b.overdue ? '<span class="bad">⏰ overdue</span>' : ''}</div>
            <div>${gate}${s.gated || s.dry ? ` <span class="dim small">· ${s.gated} sent · ${s.dry} dry</span>` : ''}</div>
            ${r && r.kind === 'frame' ? `<details class="mprs-last"><summary>Last raw packet · ${r.n} bytes · ${esc(r.via)}</summary>${lastHtml(r)}</details>` : ''}
          </div>
          <div class="mprs-tk-a"><button class="btn ghost small" data-act="follow">${follow === s.id ? '🎯 Following' : '🎯 Follow'}</button>
            ${r && r.kind === 'frame' ? '<button class="btn ghost small" data-act="pkt">🔬 Dissect</button>' : ''}
            ${s.kind === 'frame' && !onList(s) ? '<button class="btn small primary" data-act="igate">➕ Add to my iGate list</button>' : ''}
            ${s.kind !== 'object' ? `<a class="btn ghost small" href="${aprsFi(s.call)}" target="_blank" rel="noopener">aprs.fi ›</a>` : ''}</div>
        </div>`;
      }).join('');
    }
    function emptyHint() {
      const st = igs(), meshOn = k.isMeshCore && k.isMeshCore();
      return `<div class="mprs-empty"><p><b>No MeshPRS stations heard yet.</b></p><ol>
        <li>${meshOn ? '✅' : '⬜'} LoRa Mesh on a <b>MeshCore</b> node (the 🕸️ Mesh tab) -- or the MeshCore Demo</li>
        <li>${st && st.slot != null ? '✅' : '⬜'} <b>#meshprs</b> in a channel slot on the node ${st && st.slot == null && st.link ? '<button class="btn ghost small" data-do="slot">Add #meshprs</button>' : ''}</li>
        <li>A station sending MeshPRS frames -- another Kelly with <i>Also send a MeshPRS frame</i> on (APRS iGate page). Stock trackers send adverts:
          put them on your iGate list and they show here as profile 0.</li></ol>
        ${window.KellyMeshDemo ? '<p>On the demo? Press <b>▶ Demo tracker</b> above.</p>' : ''}</div>`;
    }
    function lastHtml(r) {
      const d = P.dissect(M.unhex(r.hex)), t = r.f ? P.tnc2(r.f, (igs() || {}).call || 'N0CALL', r.at) : null;
      return `<div class="mprs-two"><div><div class="dim small">Bytes</div>${hexDump(d.fields, M.unhex(r.hex))}</div>
        <div><div class="dim small">Decoded</div><table class="mprs-ft">${d.fields.map(x => `<tr class="g-${x.group}"><th>${esc(x.label)}</th><td>${esc(x.value)}</td></tr>`).join('')}</table></div></div>
        ${t ? `<div class="mprs-tnc2">${t.line ? esc(t.line) : `<span class="dim">no APRS line: ${esc(t.why)}</span>`}</div>` : ''}`;
    }
    function hexDump(fields, b) {
      const grp = new Array(b.length).fill(''), fk = new Array(b.length).fill('');
      for (const x of fields) for (let i = x.start; i < x.start + x.len && i < b.length; i++) { grp[i] = x.group; fk[i] = x.key; }
      let h = '';
      for (let o = 0; o < b.length; o += 16) {
        h += `<div><span class="mprs-off">${o.toString(16).padStart(2, '0').toUpperCase()}</span>`;
        for (let i = o; i < Math.min(o + 16, b.length); i++) h += `<i class="g-${grp[i]}" data-f="${fk[i]}">${b[i].toString(16).padStart(2, '0').toUpperCase()}</i>`;
        h += '</div>';
      }
      return `<div class="mprs-hex">${h}</div>`;
    }

    // ---------------------------------------------------------------- live packets
    function drawPackets() {
      const box = q('#mp-plist'); if (!box) return;
      if (!paused) {
        const all = T.packets().filter(p => !filter || (p.f && (p.f.src.includes(filter) || (p.f.name || '').toUpperCase().includes(filter))) || (p.call || '').includes(filter)).slice(0, 150);
        box.innerHTML = all.length ? all.map(p => {
          const call = p.f ? p.f.src : p.call || (p.kind === 'advert' ? (p.name || 'advert') : '?');
          const what = p.kind === 'advert' ? 'advert' : p.f ? P.SUB[p.f.subtype] : `⚠️ ${p.err}`;
          const g = p.gate ? `<span class="mprs-g ${p.gate.st}">${GSTATE[p.gate.st][0]}${p.gate.reason ? ` ${esc(p.gate.reason)}` : ''}</span>` : '';
          return `<div class="mprs-pr${pick === p.id ? ' on' : ''}${p.err ? ' bad' : ''}${p.dup ? ' dup' : ''}" data-p="${p.id}"><span class="mono dim">${esc(new Date(p.at).toLocaleTimeString())}</span>
            <b>${esc(call)}</b><span>${esc(what)}${p.dup ? ' <span class="dim">(dup)</span>' : ''}</span><span class="dim">${p.n ? `${p.n} B` : ''}</span>
            <span class="dim">${p.snr != null ? `${p.snr} dB` : ''}</span>${g}</div>`;
        }).join('') : '<p class="dim">Nothing yet -- frames and listed adverts appear here as they are heard.</p>';
      }
      drawDetail();
    }
    function drawDetail() {
      const box = q('#mp-pdetail'); if (!box) return;
      const p = T.packets().find(x => x.id === pick);
      if (!p) { box.innerHTML = '<p class="dim">Pick a packet on the left: its MeshCore envelope, its MeshPRS bytes field by field, and the APRS line it became.</p>'; return; }
      if (p.kind === 'advert') {
        box.innerHTML = `<p><b>${esc(p.call)}</b> -- an ordinary MeshCore advert from <b>${esc(p.name || p.key.slice(0, 8))}</b>, a node on your iGate list (profile 0).
          Its position is ${p.lat != null ? `${(+p.lat).toFixed(5)}, ${(+p.lon).toFixed(5)}` : 'missing'}. The APRS iGate page gates adverts with the SSID, symbol and comment from your list.</p>`;
        return;
      }
      const b = M.unhex(p.hex), d = P.dissect(b), st = igs(), t = p.f ? P.tnc2(p.f, (st && st.call) || 'N0CALL', p.at) : null;
      const g = p.gate;
      box.innerHTML = `<div class="mprs-layer"><h4>① MeshCore packet <span class="dim small">${esc(p.via)}</span></h4>
          <p class="small">GRP_DATA (payload type 6) on <b>#meshprs</b> · data type <code>0xFF4D</code> · ${p.hops == null ? 'hops ?' : p.hops === 0 ? 'heard direct' : `${p.hops} hop(s)`}
          ${p.path && p.path.length ? ` · path <code>${esc(p.path.join(' → '))}</code>` : ''} ${p.snr != null ? ` · SNR ${p.snr} dB` : ''}${p.rssi != null ? ` · RSSI ${p.rssi} dBm` : ''}</p>
          ${p.raw ? `<details><summary class="small">Raw packet as the radio heard it (${p.raw.length / 2} bytes, encrypted with the public #meshprs key)</summary><div class="mprs-hex raw">${esc(p.raw.replace(/(..)/g, '$1 '))}</div></details>` : '<p class="dim small">No raw log line matched this frame.</p>'}</div>
        <div class="mprs-layer"><h4>② MeshPRS frame <span class="dim small">${b.length} bytes</span></h4>${hexDump(d.fields, b)}
          <table class="mprs-ft big">${d.fields.map(x => `<tr class="g-${x.group}" data-f="${x.key}" title="${esc(x.explain || '')}"><th>${esc(x.label)}</th><td class="mono">${esc(x.hex)}</td><td>${esc(x.value)}</td></tr>`).join('')}</table>
          ${d.err ? `<p class="mprs-err">⚠️ <b>${esc(d.err)}</b> -- ${esc(P.WHY[d.err] || '')}</p>` : ''}</div>
        <div class="mprs-layer"><h4>③ APRS-IS line (TNC2)</h4>${t ? t.line ? `<div class="mprs-tnc2">${esc(t.line)}</div>` : `<p class="dim">No APRS line: ${esc(t.why)}</p>` : '<p class="dim">--</p>'}
          <p class="small">${g ? `${GSTATE[g.st][0]} <b>${esc(GSTATE[g.st][1])}</b>${g.reason ? ` -- <b>${esc(g.reason)}</b>: ${esc(P.WHY[g.reason] || '')}` : ''}${g.line && g.st !== 'queued' ? `<br><span class="mono small">${esc(g.line)}</span>` : ''}`
            : (st && !st.on) ? 'The iGate is off, so this frame was only shown, not offered to APRS-IS.' : (st && !st.mprs) ? 'MeshPRS gating is off on the APRS iGate page.' : 'No iGate verdict yet.'}</p>
          <p class="dim small">Path: <code>SRC&gt;APZKPG,qAO,${esc((st && st.call) || 'IGATECALL')}</code> -- the MeshPRS tocall (shared by every MeshPRS gateway so APRS-IS merges their copies) and qAO (a receive-only gateway). Nothing else goes in the path (spec §11).</p></div>`;
      // hover a field: light its bytes (and the other way round)
      box.querySelectorAll('[data-f]').forEach(el => {
        el.onmouseenter = () => box.querySelectorAll(`[data-f="${el.dataset.f}"]`).forEach(x => x.classList.add('hl'));
        el.onmouseleave = () => box.querySelectorAll('.hl').forEach(x => x.classList.remove('hl'));
      });
    }

    // ---------------------------------------------------------------- the strip and the iGate panel
    function drawStrip() {
      const st = igs(), slot = q('#mp-c-slot'), igc = q('#mp-c-ig'), sw = q('#mp-sw');
      if (!st) { igc.innerHTML = '⚠️ The APRS iGate did not load'; return; }
      slot.className = `mprs-chip ${st.slot != null ? 'ok' : st.link ? 'warn' : ''}`;
      slot.innerHTML = st.slot != null ? `📻 <b>#meshprs</b> in slot ${esc(String(st.slot))}` : st.link ? '📻 #meshprs not on the node <button class="btn ghost small" data-do="slot">Add it</button>' : '📻 No MeshCore node connected';
      const b = st.bridge, live = st.on && st.mprs && !st.dry;
      const conn = !st.on ? 'iGate off' : !st.bridgeUp ? 'no Kelly bridge' : b ? ({ up: 'connected', dry: 'dry run', off: 'off', connecting: 'connecting…', verifying: 'logging in…', waiting: 'reconnecting', unverified: 'not verified' }[b.state] || b.state) : '…';
      igc.className = `mprs-chip ${live && b && b.state === 'up' ? 'ok' : !st.on || !st.mprs ? '' : 'warn'}`;
      igc.innerHTML = `🚦 iGate <b>${esc(st.call || 'no callsign')}</b> · ${esc(conn)}${b && b.server && st.on ? ` · ${esc(b.server)}` : ''}
        ${!st.on ? '<button class="btn ghost small" data-do="ig-on">Turn on</button>' : !st.mprs ? '<button class="btn ghost small" data-do="mp-on">Gate MeshPRS</button>' : ''}`;
      sw.classList.toggle('live', !!live); sw.classList.toggle('dry', !live);
      q('#mp-dry').classList.toggle('on', !live); q('#mp-live').classList.toggle('on', !!live);
      q('#mp-demo').hidden = !window.KellyMeshDemo; q('#mp-demo').textContent = demo ? `⏹ Stop demo (${demo.n}/${DEMO_MAX})` : '▶ Demo tracker';
    }
    function drawIgate() {
      const box = q('#mp-ig'), dbox = q('#mp-drops'); if (!box) return;
      const st = igs(); if (!st) { box.innerHTML = '<p class="dim">The APRS iGate did not load.</p>'; return; }
      const b = st.bridge, s = st.stats || { heard: 0, queued: 0, drops: {} };
      const row = (a, v, cls = '') => `<div class="mprs-kv ${cls}"><span>${a}</span><b>${v}</b></div>`;
      box.innerHTML = `<div class="mprs-kvs">${row('Mode', st.on && st.mprs ? (st.dry ? '🧪 dry run' : '📡 LIVE') : 'off', st.on && st.mprs && !st.dry ? 'live' : '')}
          ${row('Callsign', esc(st.call || '--'))}${row('Server', esc((b && b.server) || st.server || '--'))}
          ${row('Connection', esc(b ? b.state : st.bridgeErr ? 'bridge: ' + st.bridgeErr : 'no Kelly bridge'))}
          ${row('Frames heard', s.heard)}${row('Queued', s.queued)}${row('Sent', st.out)}${row('Not sent', st.unsent)}
          ${row('Dropped', Object.values(s.drops).reduce((a, n) => a + n, 0))}${row('Stations on my list', st.listed)}</div>
        <p class="dim small">Counts are the iGate's own, since it last reset (APRS iGate page). Tocall <code>APZKPG</code> (provisional, shared by every MeshPRS gateway),
          q-construct <code>qAO</code>, server ${esc(st.server)} with rotate.aprs2.net as the fallback. The passcode stays in the Kelly bridge.</p>`;
      const mine = {};
      for (const p of T.packets()) if (p.err) mine[p.err] = (mine[p.err] || 0) + 1; else if (p.gate && p.gate.st === 'drop') mine[p.gate.reason] = (mine[p.gate.reason] || 0) + 1;
      const all = Object.assign({}, s.drops); for (const [r, n] of Object.entries(mine)) if (!(r in all)) all[r] = n;
      const list = Object.entries(all).sort((a, b) => b[1] - a[1]);
      dbox.innerHTML = list.length ? `<table class="mprs-ft big">${list.map(([r, n]) => `<tr><th>${esc(r)}</th><td>${n}</td><td class="dim">${esc(P.WHY[r] || '')}</td></tr>`).join('')}</table>`
        : '<p class="dim">No drops yet. Every frame the iGate refuses lands here with its reason (spec §15.2).</p>';
    }

    // ---------------------------------------------------------------- the demo tracker (MeshCore Demo only)
    function startDemo() {
      const D = window.KellyMeshDemo;
      if (!D) { toast('🕸️', 'MeshCore Demo first', 'LoRa Mesh > Connect > MeshCore Demo', 'bad'); return; }
      const i = D.world.findIndex(s => s.mprs);
      if (i < 0) { toast('⚠️', 'No MeshPRS station in this demo', '', 'bad'); return; }
      // the demo node hands MeshPRS frames up (RESP 27) only with #meshprs in a slot -- its raw log carries no real ciphertext
      const st = igs(); if (st && st.slot == null && ig().addMprsChannel) ig().addMprsChannel();
      demo = { i, n: 0, step: 0, t: null };
      const go = () => {
        const W = window.KellyMeshDemo; if (!demo || !W) { stopDemo(); return; }
        const s = W.world[demo.i], a = ROUTE[demo.step % ROUTE.length], b2 = ROUTE[(demo.step + 1) % ROUTE.length];
        s.lat = a[0]; s.lon = a[1];
        s.mprsSeq = ((s.mprsSeq === undefined ? 0 : s.mprsSeq) + 1) & 255;
        const crs = Math.round(P.bearing({ lat: a[0], lon: a[1] }, { lat: b2[0], lon: b2[1] }) * 256 / 360) & 255;
        const blob = M.encode({ subtype: 0, seq: s.mprsSeq, src: s.mprs, key: M.hex(s.key.subarray(0, 4)), lat: M.degToRaw(a[0], 90), lon: M.degToRaw(a[1], 180),
          sym: '/>', course: crs, speed: 38 + (demo.step % 4) * 6, alt: 30 + (demo.step % 5) * 4, comment: 'MeshPRS demo drive' });
        // one beacon in six is "lost" on the way: the missed counter shows it (its seq is used, nothing is heard)
        if (demo.step % 6 !== 5) W.inject.mprs(demo.i, blob);
        demo.step++; demo.n++; drawStrip();
        if (demo.n >= DEMO_MAX) { stopDemo(); toast('🏁', 'Demo drive finished', `${DEMO_MAX} beacons`); return; }
        demo.t = setTimeout(go, DEMO_MS);
      };
      go(); toast('🚗', 'Demo tracker driving', `${D.world[i].mprs}: a frame every ${DEMO_MS / 1000} s, 1 in 6 lost on purpose`);
    }
    function stopDemo() { if (demo && demo.t) clearTimeout(demo.t); demo = null; if (built) drawStrip(); }

    // ---------------------------------------------------------------- drawing + upkeep
    function draw() {
      if (!visible || !built || root.offsetParent === null) return;   // another page is showing: the 5 s tick catches up on return
      hook();
      drawStrip();
      const on = (q('[data-tabs="mprs"] button.on') || {}).dataset || {};
      if (on.tab === 'map') { drawMap(); drawTrackers(); } else if (on.tab === 'pkts') drawPackets(); else if (on.tab === 'ig') drawIgate();
      persist();
    }
    function soon() { if (!visible || soonT) return; soonT = setTimeout(() => { soonT = null; draw(); }, 250); }
    function persist(now) {
      if (!changed || (!now && Date.now() - saveAt < SAVE_MS)) return;
      saveAt = Date.now(); changed = false; store.set('mprsTracks', T.json());
    }
    function tick() { tickT = null; if (!visible) return; draw(); tickT = setTimeout(tick, TICK_MS); }

    const api = {
      init() { root = $('#mprs-root'); if (!root) return; shell(); hook(); window.kellyMeshPRS = api;
        window.addEventListener('beforeunload', () => persist(true));
        if (location.hash === '#mprs-demo') { const t0 = Date.now(), wait = () => { if (window.KellyMeshDemo) startDemo(); else if (Date.now() - t0 < 20000) setTimeout(wait, 1000); }; setTimeout(wait, 1500); } },
      shown() { visible = true; hook(); draw(); if (map) setTimeout(() => map.invalidateSize(), 50); if (!tickT) tickT = setTimeout(tick, TICK_MS); },
      hidden() { visible = false; persist(true); },
      feed,
      // tests
      tracker: () => T, startDemo, stopDemo, state: () => ({ visible, offline, tileOk, tileErr, sel, follow, demo: demo ? demo.n : 0, map: !!map, marks: marks.size }),
    };
    return api;
  };
})();
