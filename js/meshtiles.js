/* Kelly Page -- offline map tiles for the LoRa Mesh map (Phase 12 of docs/lora-mesh-gap-analysis.md, 2026-10-23).
 *
 * Keep map tiles as you view them (ms.tileCache, off by default): the mesh map's tile layers are swapped for ones that
 * look in the Cache API first and keep what they fetch, about 50 MB at most, oldest out first, a tile refetched after
 * 30 days. Needs a secure context (https / localhost) with CacheStorage and a tile server that sends CORS headers;
 * anywhere else (file://, plain http, a CORS-less server) the tiles load as normal, silently. A small "cached map"
 * note on the map says when tiles in view came from the cache.
 *
 * "Save this area" (prefetch the view, a few zooms deeper) is offered ONLY for a source marked allowBulk. OSM's tile
 * policy forbids bulk prefetch, and the default Esri canvas (app.js makeMap) is a hosted service with its own terms,
 * so neither is marked: the button only shows for "own tile server" (ms.tileOwn, e.g. tiles served from the NUC).
 * Capped by zoom (+3, max 16) and MAX_SAVE tiles, with a count and size estimate to confirm first.
 *
 * window.KellyMeshTiles(k) -> { init, render, attach(map), sync(), stats(), clear() }; k: { $, esc, ms, save(), toast, dirty }
 * Settings: "📦 Keep map tiles" beside Coverage map (injected by init), and the own tile server URL under it.
 * window.KellyMeshTiles.tileRange(bounds, z) / countTiles(bounds, z0, z1) / estimate(n, avg) -- pure, for tests.
 */
(function () {
  'use strict';
  const CACHE = 'kelly-tiles-v1', CAP = 50 * 1024 * 1024, MAX_AGE = 30 * 86400000, MAX_SAVE = 1500, AVG0 = 18 * 1024, DEEPER = 3, ZMAX = 16;
  // tile x/y range covering bounds {n, s, e, w} at zoom z (Web Mercator, as Leaflet's tile grid)
  function tileRange(b, z) {
    const n = 2 ** z, clampLat = v => Math.max(-85.0511, Math.min(85.0511, v));
    const x = lon => Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n)));
    const y = lat => { const r = clampLat(lat) * Math.PI / 180; return Math.max(0, Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n))); };
    return { z, x0: x(b.w), x1: x(b.e), y0: y(b.n), y1: y(b.s) };
  }
  function countTiles(b, z0, z1) { let c = 0; for (let z = z0; z <= z1; z++) { const r = tileRange(b, z); c += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1); } return c; }
  const estimate = (n, avg) => n * (avg || AVG0);
  const fmtMB = b => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`;

  function KellyMeshTiles(k) {
    const { ms } = k;
    let map = null, orig = [], mine = [], srcSig = '', note = null, cached = 0, total = null, count = 0, busy = false;
    const noCors = new Set();   // hosts whose tiles can't be fetched (no CORS): left to the plain <img>
    let cacheOk = null;
    async function store() {
      if (cacheOk === false) return null;
      try {
        if (!(window.KellySecure ? window.KellySecure.can('cache') : window.isSecureContext && window.caches)) throw new Error('no Cache API');
        const c = await caches.open(CACHE); cacheOk = true; return c;
      } catch { cacheOk = false; return null; }   // file:// and plain http: normal tiles, no fuss
    }
    async function size() {
      if (total != null) return total;
      const c = await store(); if (!c) return 0;
      total = 0; count = 0;
      try { for (const r of await c.matchAll()) { total += +(r.headers.get('x-kelly-size') || 0); count++; } } catch { /* */ }
      return total;
    }
    async function evict(c) {
      if (total <= CAP) return;
      for (const req of await c.keys()) {   // insertion order: oldest first
        if (total <= CAP * 0.9) break;
        const r = await c.match(req); total -= r ? +(r.headers.get('x-kelly-size') || 0) : 0; count--;
        await c.delete(req);
      }
    }
    // -> a src for the <img>: an object URL from the cache or a fresh fetch, else the plain URL
    async function load(url, fromNet) {
      const c = ms.tileCache ? await store() : null; if (!c) return { src: url };
      const host = (/^https?:\/\/([^/]+)/.exec(url) || [])[1] || '';
      try {
        const hit = await c.match(url);
        if (hit && Date.now() - +(hit.headers.get('x-kelly-at') || 0) < MAX_AGE) return { src: URL.createObjectURL(await hit.blob()), cached: true };
        if (noCors.has(host) || (fromNet === false)) return hit ? { src: URL.createObjectURL(await hit.blob()), cached: true } : { src: url };
        const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!r.ok) return hit ? { src: URL.createObjectURL(await hit.blob()), cached: true } : { src: url };
        const blob = await r.blob();
        await size();
        if (hit) total -= +(hit.headers.get('x-kelly-size') || 0); else count++;
        await c.put(url, new Response(blob, { headers: { 'content-type': r.headers.get('content-type') || blob.type || 'image/png', 'x-kelly-size': String(blob.size), 'x-kelly-at': String(Date.now()) } }));
        total += blob.size; await evict(c);
        return { src: URL.createObjectURL(blob) };
      } catch {
        noCors.add(host);   // CORS refused or offline: the plain <img> (the browser's own cache may still have it)
        return { src: url };
      }
    }
    let Layer = null;
    const layerClass = () => Layer || (Layer = L.TileLayer.extend({
      createTile(coords, done) {
        const img = document.createElement('img');
        img.alt = ''; img.setAttribute('role', 'presentation');
        if (this.options.crossOrigin || this.options.crossOrigin === '') img.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
        L.DomEvent.on(img, 'load', L.Util.bind(this._tileOnLoad, this, done, img));
        L.DomEvent.on(img, 'error', L.Util.bind(this._tileOnError, this, done, img));
        L.DomEvent.on(img, 'load', () => { if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); });
        load(this.getTileUrl(coords)).then(r => { if (r.cached) { cached++; showNote(); } img.src = r.src; });
        return img;
      },
    }));
    // the sources: the map's own layers (app.js makeMap, Esri: no bulk), or one own tile server (allowBulk)
    const own = () => String(ms.tileOwn || '').trim();
    function wanted() { return own() ? [{ url: own(), opts: { maxZoom: 19, maxNativeZoom: ZMAX, attribution: 'Own tile server' }, allowBulk: true }]
      : orig.map(l => ({ url: l._url, opts: l.options, allowBulk: false })); }
    function attach(m) {
      if (!m || !window.L) return;
      map = m; orig = [];
      m.eachLayer(l => { if (l instanceof L.TileLayer && !l._kellyTiles) orig.push(l); });
      note = L.control({ position: 'topleft' });
      note.onAdd = () => { const d = L.DomUtil.create('div', 'mt-note'); d.hidden = true; L.DomEvent.disableClickPropagation(d); return d; };
      note.addTo(m);
      m.on('movestart zoomstart', () => { cached = 0; showNote(); });
      sync();
    }
    // swap the layers when the settings change; nothing to do while both are off
    function sync() {
      if (!map) return;
      const on = !!ms.tileCache || !!own(), sig = on ? `${ms.tileCache ? 1 : 0}|${own()}` : '';
      if (sig === srcSig) { showNote(); return; }
      srcSig = sig;
      mine.forEach(l => map.removeLayer(l)); mine = [];
      if (!on) { orig.forEach(l => { if (!map.hasLayer(l)) l.addTo(map); }); showNote(); return; }
      orig.forEach(l => map.removeLayer(l));
      const C = layerClass();
      for (const s of wanted()) { const l = new C(s.url, s.opts); l._kellyTiles = true; l._allowBulk = s.allowBulk; l.addTo(map); mine.push(l); }
      showNote();
    }
    const bulkLayer = () => mine.find(l => l._allowBulk) || null;
    function showNote() {
      const d = note && note.getContainer(); if (!d) return;
      const bulk = bulkLayer() && cacheOk !== false;
      const parts = [];
      if (cached && ms.tileCache) parts.push(`<span class="mt-cached" title="Some of the map in view came from the tiles Kelly keeps (Cache API)">📦 cached map</span>`);
      if (bulk && ms.tileCache) parts.push(`<button class="mt-save" type="button" ${busy ? 'disabled' : ''} title="Fetch the tiles for this view and ${DEEPER} zooms deeper, for offline use">${busy ? `💾 ${busy}` : '💾 Save this area'}</button>`);
      const h = parts.join(' ');
      d.hidden = !h;
      if (d.dataset.h !== h) { d.innerHTML = h; d.dataset.h = h; const b = d.querySelector('.mt-save'); if (b) b.onclick = saveArea; }
    }
    async function saveArea() {
      const l = bulkLayer(); if (!l || busy || !map) return;
      const c = await store(); if (!c) { k.toast('📦', 'Can\'t keep tiles here', 'Needs https or localhost', 'bad'); return; }
      const bb = map.getBounds(), b = { n: bb.getNorth(), s: bb.getSouth(), e: bb.getEast(), w: bb.getWest() };
      const z0 = Math.max(0, Math.floor(map.getZoom())), z1 = Math.min(ZMAX, z0 + DEEPER);
      let zTop = z1; while (zTop > z0 && countTiles(b, z0, zTop) > MAX_SAVE) zTop--;
      const n = countTiles(b, z0, zTop);
      if (n > MAX_SAVE) { k.toast('💾', 'Area too big', `Zoom in: this view is ${n} tiles (max ${MAX_SAVE})`, 'bad'); return; }
      await size();
      const est = estimate(n, count ? total / count : 0);
      if (!window.confirm(`Save ${n} map tiles (zoom ${z0}-${zTop}, about ${fmtMB(est)}) for offline use?${est + total > CAP ? `\nKelly keeps ${fmtMB(CAP)} of tiles at most, so the oldest go first.` : ''}`)) return;
      const urls = [];
      for (let z = z0; z <= zTop; z++) { const r = tileRange(b, z); for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) urls.push(l.getTileUrl({ x, y, z })); }
      let done = 0;
      busy = `0 / ${urls.length}`; showNote();
      const worker = async () => { while (urls.length) { const u = urls.shift(); const r = await load(u); if (r.src.startsWith('blob:')) URL.revokeObjectURL(r.src); done++; if (done % 10 === 0) { busy = `${done} / ${n}`; showNote(); } } };
      await Promise.all([worker(), worker(), worker()]);
      busy = false; showNote();
      k.toast('💾', 'Area saved', `${done} tiles kept for offline use`, 'good');
    }
    async function stats() { await size(); return { ok: cacheOk, bytes: total || 0, tiles: count, cached, bulk: !!bulkLayer(), layers: mine.length }; }
    async function clear() { const c = await store(); if (c) { await caches.delete(CACHE); total = 0; count = 0; cached = 0; showNote(); } }
    // the switch + own-server field, beside the Coverage map switch (index.html stays as it is)
    let injected = false;
    function init() {
      if (injected) return; const cov = k.$('#ms-cov'), lab = cov && cov.closest('label'); if (!lab) return; injected = true;
      lab.parentElement.insertAdjacentHTML('afterend', `<div class="row gap wrap mt-set"><label class="tog" title="Keep the map tiles you look at (about ${fmtMB(CAP)} at most, oldest out), so the mesh map still draws with no internet"><input type="checkbox" id="ms-tiles"><i></i><span>📦 Keep map tiles</span></label>
        <label class="fld mt-own" hidden><span>Own tile server (lets you save an area)</span><input id="ms-tileown" placeholder="https://host/tiles/{z}/{x}/{y}.png" spellcheck="false"></label>
        <span class="small dim" id="ms-tilewhy"></span></div>`);
      const t = k.$('#ms-tiles'), o = k.$('#ms-tileown');
      t.onchange = () => { ms.tileCache = t.checked; k.save(); sync(); render(); };
      o.onchange = () => { ms.tileOwn = o.value.trim(); k.save(); sync(); render(); };
    }
    function render() {
      init(); const t = k.$('#ms-tiles'); if (!t) return;
      t.checked = !!ms.tileCache;
      const o = k.$('#ms-tileown'); o.closest('label').hidden = !ms.tileCache; if (document.activeElement !== o) o.value = ms.tileOwn || '';
      const why = ms.tileCache && window.KellySecure ? window.KellySecure.why('cache') : ms.tileCache && cacheOk === false ? 'Tiles can only be kept on an https or localhost page.' : '';
      k.$('#ms-tilewhy').textContent = why;
      sync();
    }
    return { init, render, attach, sync, stats, clear, saveArea };
  }
  KellyMeshTiles.tileRange = tileRange; KellyMeshTiles.countTiles = countTiles; KellyMeshTiles.estimate = estimate;
  KellyMeshTiles.CAP = CAP; KellyMeshTiles.MAX_SAVE = MAX_SAVE;
  window.KellyMeshTiles = KellyMeshTiles;
})();
