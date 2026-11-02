/* Kelly Page -- Node info panel on the LoRa Mesh map (Phase 6b of docs/lora-mesh-gap-analysis.md, 2026-10-22).
 *
 * Click a node (map marker or Nodes row) and a card opens over the map: what it is, when and how it was last heard
 * (hops, SNR / RSSI, heard direct), battery, distance and bearing from you, its P25 radio if it's a ham, and its route
 * history from the paths module -- the routes it was heard via (newest first), our route to it, and two-way proofs.
 * Buttons: message it, trace the route, its trends (the bridge's history, when there is one), centre the map, and ▦ QR
 * (its contact/add QR, js/meshqr.js) -- only for a MeshCore node Kelly holds the WHOLE 64-hex public key of, typed from
 * the node (role, else hwLabel); hidden for Meshtastic nodes and keyless channel senders (never a key guessed by name).
 * Static: redrawn only when what it shows changes. Closed with ✕ or Escape (the selection clears too).
 *
 * window.KellyMeshInfo(k) -> { render }; k from mesh.js:
 *   { $, esc, fmtAgo, sel(), unsel(), node(num), myNum(), myPos(), distKm(a, b), hw(n), id(n), p25(n), routes(num),
 *     dm(num), trace(num), centre(num), trends() -> (src => ...) | null, canTrace(n), toast? (the QR dialog's picture errors) }
 * KellyMeshInfo.qrType(n) -> 1-4 | 0 (no QR). Tests: tests/meshinfo-qr-tests.html, tests/mesh-info-cdp.js.
 */
(function () {
  'use strict';
  const brg = (a, b) => { const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r),
    x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
    return (Math.atan2(y, x) / r + 360) % 360; };
  const compass = d => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];

  const TYPE_OF = [[/repeater/i, 2], [/room/i, 3], [/sensor/i, 4], [/companion|chat/i, 1]];
  // a node -> its MeshCore contact type (1-4) when it can have a contact QR, else 0
  function qrType(n) {
    if (!window.KellyMeshQR || !n || !/^[0-9a-f]{64}$/i.test(n.key || '')) return 0;
    if ([1, 2, 3, 4].includes(n.role)) return n.role;
    const t = TYPE_OF.find(([re]) => re.test(n.hwLabel || '')); return t ? t[1] : 0;
  }

  window.KellyMeshInfo = function (k) {
    const { $, esc } = k;
    let sig = '', bound = false, qrUi = null;
    function showQr(n) {
      const t = qrType(n); if (!t) return;
      qrUi = qrUi || window.KellyMeshQR.ui({ toast: k.toast });
      return qrUi.show({ title: `▦ ${n.longName || k.id(n)}`, contact: { key: n.key, type: t, name: n.longName || '' } });
    }

    function rows(n) {
      const r = [], me = k.myPos();
      r.push(['Type', `${esc(k.hw(n))}${n.licensed ? ' · <b class="mi-ham">HAM</b>' : ''}`]);
      r.push(['ID', `<code>${esc(k.id(n))}</code>`]);
      if (n.lastHeard) r.push(['Last heard', `${esc(k.fmtAgo(n.lastHeard))}${n.hops != null ? ` · ${n.hops === 0 ? 'direct' : `${n.hops} hop${n.hops === 1 ? '' : 's'}`}` : ''}`]);
      if (n.snr != null || n.rssi != null) r.push(['Signal', `${n.snr != null ? `SNR ${(+n.snr).toFixed(1)} dB` : ''}${n.rssi != null ? ` · RSSI ${n.rssi} dBm` : ''} <small class="dim">(last hop)</small>`]);
      if (n.directSnr != null) r.push(['Heard direct', `SNR ${(+n.directSnr).toFixed(1)} dB · ${esc(k.fmtAgo(n.directAt))}`]);
      if (n.battery != null) r.push(['Battery', n.battery > 100 ? '⚡ powered' : `${n.battery} %${n.voltage ? ` · ${(+n.voltage).toFixed(2)} V` : ''}`]);
      if (n.lat != null && n.lon != null) {
        const d = me ? k.distKm(me, n) : null, b = me ? brg(me, n) : null;
        r.push(['Position', `${(+n.lat).toFixed(4)}, ${(+n.lon).toFixed(4)}${d != null ? ` · <b>${d < 10 ? d.toFixed(1) : Math.round(d)} km ${compass(b)}</b> <small class="dim">(${Math.round(b)}°)</small>` : ''}`]);
      }
      const p = k.p25(n); if (p) r.push(['P25', `📻 ${esc(p.name || p.call || '')} ${p.id ? `<small class="dim">${esc(String(p.id))}</small>` : ''}`]);
      return r;
    }
    function routesHtml(num) {
      const R = k.routes(num); if (!R) return '';
      let h = '';
      if (R.inb && R.inb.length) h += `<h4>Heard via</h4><ol class="mi-routes">${R.inb.map(x => `<li><span class="mi-chain">${x.html || '<i>direct</i>'}</span><small class="dim">${x.snr != null ? `${(+x.snr).toFixed(1)} dB · ` : ''}${x.n > 1 ? `${x.n}× · ` : ''}${esc(k.fmtAgo(x.t))}</small></li>`).join('')}</ol>`;
      if (R.out) h += `<h4>Our route to it</h4><div class="mi-chain">${R.out}</div>`;
      if (R.two && R.two.length) h += `<h4>Two-way</h4><ul class="mi-two">${R.two.map(x => `<li>🥇 ${esc(x.how)}${x.rtt ? ` · ${(x.rtt / 1000).toFixed(1)} s round trip` : ''} · <small class="dim">${esc(k.fmtAgo(x.t))}</small></li>`).join('')}</ul>`;
      return h;
    }
    function render() {
      const box = $('#mesh-info'); if (!box) return;
      const num = k.sel(), n = num != null ? k.node(num) : null;
      if (!n || num === k.myNum()) { if (!box.hidden) { box.hidden = true; box.innerHTML = ''; sig = ''; } return; }
      const R = k.routes(num);
      const s = JSON.stringify([num, n.longName, n.lastHeard, n.hops, n.snr, n.rssi, n.directSnr, n.battery, n.lat, n.lon, k.myPos(), qrType(n), R && [R.inb && R.inb.map(x => x.t + x.n), R.out, R.two && R.two.length], Math.floor(Date.now() / 30000)]);
      if (s === sig && !box.hidden) return; sig = s;
      const tr = k.trends && k.trends();
      box.innerHTML = `<div class="mi-h"><b>${esc(n.longName || n.shortName || k.id(n))}</b><button class="btn ghost small" data-mi="close" title="Close (Esc)">✕</button></div>`
        + `<table class="mi-t">${rows(n).map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join('')}</table>`
        + routesHtml(num)
        + `<div class="row gap mi-acts">${!k.canDm || k.canDm(n) ? '<button class="btn small" data-mi="dm">💬 Message</button>' : ''}${k.canTrace(n) ? '<button class="btn small" data-mi="trace">🔍 Trace route</button>' : ''}`
        + `${tr && n.key ? '<button class="btn small" data-mi="trends">📈 Trends</button>' : ''}${n.lat != null ? '<button class="btn small" data-mi="centre">🎯 Centre</button>' : ''}`
        + `${qrType(n) ? '<button class="btn small" data-mi="qr" title="Its contact QR (key, name and type)">▦ QR</button>' : ''}</div>`;
      box.hidden = false;
      if (!bound) {
        bound = true;
        box.addEventListener('click', e => {
          const b = e.target.closest('[data-mi]'); if (!b) return;
          const cur = k.sel(), nn = cur != null ? k.node(cur) : null; if (!nn) return;
          ({ close: () => k.unsel(), dm: () => k.dm(cur), trace: () => k.trace(cur), centre: () => k.centre(cur),
            trends: () => { const t = k.trends(); if (t) t(String(nn.key).slice(0, 12)); }, qr: () => showQr(nn) })[b.dataset.mi]();
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !box.hidden && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) k.unsel(); });
      }
    }
    return { render };
  };
  window.KellyMeshInfo.qrType = qrType;   // for tests/meshinfo-qr-tests.html
})();
