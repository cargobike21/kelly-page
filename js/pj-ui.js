/* Kelly Page -- LoRa Mesh > 🛰️ Packet Journey tab (2026-10-24, unreleased): a SCADA-style live picture of MeshCore
 * traffic -- packets fly along their hop paths on a network canvas, with sound, live stats and a byte-by-byte view.
 * This file is the shell: the layout, the mount points, the shared context, live feed, demo / reset / full screen and
 * visibility. The parts (one file each, coded against js/pj-core.js -- see PACKET_JOURNEY_PLAN.md):
 *   js/pj-net.js     window.KellyPJNet(mount, c)              the animated network canvas
 *   js/pj-sound.js   window.KellyPJSound(mount, c)            Web Audio sounds + the speaker controls
 *   js/pj-stats.js   window.KellyPJStats(mount, c, ticker)    stats, leaderboard, charts, the chat / advert ticker
 *   js/pj-inspect.js window.KellyPJInspect(mount, c)          click-to-inspect byte view
 *   js/pj-demo.js    window.KellyPJDemo(c)                    made-up MeshCore traffic -> c.ingest()
 *   js/pj-time.js    window.KellyPJTime(mount, c)             busiest time of day (24 x 7), new vs returning stations
 *   js/pj-reach.js   window.KellyPJReach(mount, c)            repeater reach, link quality (trace SNRs), duplicate ratio
 *   js/pj-map.js     window.KellyPJMap(mount, c)              GPS adverts on a live map, fading by age
 *   js/pj-air.js     window.KellyPJAir(mount, c)              airtime + channel load, wrong path hash size stations
 * Each returns { destroy?() } (pj-demo: { start(), stop(), running() }); a missing or failing part leaves its box empty.
 *
 * window.KellyPacketJourneyUI(k) -> { init, feed(rx), shown(), hidden() }; k from mesh.js:
 *   { $, esc, store, toast, settings, audioCtx, fxLoop, fmtAgo, decodeOpts(), byPrefix(hex), myName(), myPos() -> { lat, lon } | null,
 *     radio() -> { freqMHz, bwKHz, sf, cr, txDbm? } | null, makeMap(el, zoom, key) -> Leaflet map | null }
 */
(function () {
  'use strict';

  window.KellyPacketJourneyUI = function (k) {
    const PJ = window.KellyPJ, D = window.KellyMcDecode;
    if (!PJ || !D) return null;
    const bus = PJ.createBus(), reg = PJ.createRegistry({ byPrefix: k.byPrefix, myName: k.myName });
    let root = null, demo = null, parts = {}, vis = false, live = 0;

    const rmq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;   // one query, read per frame by the canvas
    const reduced = () => !!(rmq && rmq.matches);
    // our node on the GPS layout: the companion's own position (or Kelly's), else Ipswich while the demo mesh runs
    function placeMe() {
      const n = reg.get('me'), p = k.myPos && k.myPos(), q = p && p.lat != null ? p : demo && demo.running() ? { lat: -27.6210, lon: 152.7646 } : null;
      if (q && (n.lat !== q.lat || n.lon !== q.lon)) { n.lat = q.lat; n.lon = q.lon; bus.emit('nodes', reg); }
    }
    const decodeOpts = () => { const o = k.decodeOpts(); return Object.assign({}, o, { channels: (o.channels || []).concat(PJ.DEMO_CHANNEL) }); };
    const c = {
      bus, PJ, D, reg, $: k.$, esc: k.esc, store: k.store, toast: k.toast, fmtAgo: k.fmtAgo, fxLoop: k.fxLoop, audioCtx: k.audioCtx,
      fx: () => k.settings.fx !== false && !reduced(),   // Kelly's own effects switch, and the OS "reduce motion"
      reduced,
      visible: () => vis,
      ingest: rx => PJ.ingest(bus, reg, rx, decodeOpts()),
      root: () => root,
      // LoRa settings for airtime: the companion's, else (no node yet, or the demo) Brisbane/SEQ MeshCore's (demo: true)
      radio: () => { const r = k.radio && k.radio(); return r && r.sf ? r : { freqMHz: 923.125, bwKHz: 62.5, sf: 8, cr: 5, demo: true }; },
      hashExpected: () => k.decodeOpts().expectHash || 2,   // the path hash size this network expects (the Analyser's setting)
      byPrefix: k.byPrefix, makeMap: k.makeMap || (() => null), myPos: () => { const n = reg.get('me'); return n && n.lat != null ? { lat: n.lat, lon: n.lon } : null; },
    };

    function make(name, factory, ...a) {
      if (typeof window[factory] !== 'function') return null;
      try { return window[factory](...a); } catch (e) { console.warn('Packet Journey', factory, e); return null; }
    }
    function legend() {
      return PJ.KINDS.map(x => { const p = PJ.PALETTE[x]; return `<span><i style="background:${p.color};box-shadow:0 0 8px ${p.color}"></i>${k.esc(p.label)}</span>`; }).join('');
    }

    function render() {
      root.innerHTML = `<div class="pj">
        <div class="card pj-head">
          <div class="pj-title"><h2>🛰️ Packet Journey</h2><span class="pj-mode" id="pj-mode">waiting</span></div>
          <p class="dim small">Every MeshCore packet your node hears, flying in along the path it took. Colour says what it is; brightness says how strong it arrived. Tap a node or a packet to look closer.</p>
          <div class="pj-bar">
            <button class="btn" id="pj-demo-btn">🎲 Demo traffic</button>
            <div id="pj-sound" class="pj-sound"></div>
            <span class="grow"></span>
            <button class="btn ghost" id="pj-reset" title="Clear the stats, the leaderboard and the picture">🧹 Reset</button>
            <button class="btn ghost" id="pj-fs" title="Full screen, for a projector or a club display">⛶ Full screen</button>
          </div>
          <div class="pj-legend">${legend()}</div>
        </div>
        <div class="pj-main">
          <div class="card pj-stage"><div id="pj-net" class="pj-net"></div><div id="pj-ticker" class="pj-ticker"></div></div>
          <div class="card pj-side"><div id="pj-inspect"></div></div>
        </div>
        <div id="pj-stats" class="pj-stats"></div>
        <div class="pj-more">
          <div id="pj-time" class="pj-part"></div><div id="pj-reach" class="pj-part"></div>
          <div id="pj-map" class="pj-part pj-wide"></div><div id="pj-air" class="pj-part"></div>
        </div>
      </div>`;
      const $ = k.$;
      $('#pj-demo-btn').onclick = () => setDemo(!(demo && demo.running()));
      $('#pj-reset').onclick = () => { if (confirm('Reset Packet Journey? The stats, the leaderboard and the picture start again.')) { reg.clear(); bus.emit('reset'); bus.emit('nodes', reg); } };
      $('#pj-fs').onclick = fullscreen;
      parts.net = make('net', 'KellyPJNet', $('#pj-net'), c);
      parts.sound = make('sound', 'KellyPJSound', $('#pj-sound'), c);
      parts.stats = make('stats', 'KellyPJStats', $('#pj-stats'), c, $('#pj-ticker'));
      parts.inspect = make('inspect', 'KellyPJInspect', $('#pj-inspect'), c);
      parts.time = make('time', 'KellyPJTime', $('#pj-time'), c);
      parts.reach = make('reach', 'KellyPJReach', $('#pj-reach'), c);
      parts.map = make('map', 'KellyPJMap', $('#pj-map'), c);
      parts.air = make('air', 'KellyPJAir', $('#pj-air'), c);
      demo = make('demo', 'KellyPJDemo', c);
      if (demo && window.KellyAwards) window.KellyAwards.addDemo(() => demo.running());   // awards: demo traffic never scores
      if (!demo) $('#pj-demo-btn').hidden = true;
      mode();
    }
    function mode() {
      const m = root && root.querySelector('#pj-mode'); if (!m) return;
      const d = demo && demo.running(), l = Date.now() - live < 120e3;
      m.textContent = d && l ? 'live + demo' : d ? 'demo' : l ? 'live' : 'waiting for packets';
      m.className = 'pj-mode' + (d ? ' demo' : l ? ' live' : '');
      const b = root.querySelector('#pj-demo-btn'); if (b) { b.textContent = d ? '⏹ Stop demo' : '🎲 Demo traffic'; b.classList.toggle('primary', !!d); }
    }
    function setDemo(on) {
      if (!demo) return;
      if (on && !demo.running()) demo.start(); else if (!on && demo.running()) demo.stop();
      placeMe(); bus.emit('demo', !!on); mode();
    }
    function fullscreen() {
      const el = root.querySelector('.pj');
      if (document.fullscreenElement) return document.exitFullscreen();
      if (el.classList.contains('pj-fs')) { el.classList.remove('pj-fs'); return bus.emit('visible', vis); }   // the fallback is on: that's "exit"
      const fallback = () => { el.classList.add('pj-fs'); bus.emit('visible', vis); };
      if (el.requestFullscreen) el.requestFullscreen().catch(fallback); else fallback();
    }
    // shown = the Packet Journey pane is on screen and the browser tab isn't hidden
    function checkVis() {
      const v = !!(root && root.offsetParent !== null && !document.hidden);
      if (v !== vis) { vis = v; bus.emit('visible', v); }
    }

    return {
      init() {
        root = document.getElementById('pj-root'); if (!root) return;
        render();
        document.addEventListener('visibilitychange', checkVis);
        document.addEventListener('fullscreenchange', () => setTimeout(() => bus.emit('visible', vis), 50));   // canvases re-measure
        setInterval(() => { checkVis(); mode(); }, 1000);
        setInterval(placeMe, 30e3); placeMe();   // page / tab changes elsewhere in the app; cheap
        if (/[?&#]pj-demo\b/.test(location.href)) setTimeout(() => setDemo(true), 400);   // index.html#pj-demo: club displays, tests
      },
      // a live packet from mesh.js onRxPacket: { kind: 'rx', snr, rssi, raw }
      feed(e) { if (!e || !e.raw) return; live = Date.now(); c.ingest({ raw: e.raw, snr: e.snr, rssi: e.rssi }); },
      shown() { setTimeout(checkVis, 30); },
      hidden() { setTimeout(checkVis, 30); },
      _c: c,   // tests
    };
  };
})();
