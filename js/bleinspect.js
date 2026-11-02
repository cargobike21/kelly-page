/* Kelly Page -- BLE Packet Inspector + Learn (BLE brief Phase 4), a plugin of the BLE Presence page (js/bleui.js).
 *
 * Inspector: the controller's own advertising reports, byte for byte (bridge raw HCI capture, kelly_ble.py HciCapture),
 * or -- without it, from a remote node, or in the demo -- reconstructed from parsed fields and labelled so. Hex view and
 * protocol tree linked both ways; every field explained; diff of two packets from one device; the BLE -> P25 telemetry
 * byte map; what HCI can't see (the link layer, explained, never shown as captured); a no-code custom decoder builder;
 * exports: pcap for Wireshark (captured packets only), JSON and CSV. Learn: guided walkthroughs + the Packet Quiz.
 *
 * Privacy: rotating (private) addresses of unregistered devices are masked (••) on screen and zeroed in exports;
 * packets live in memory only (the last 300) unless bookmarked, and bookmarks keep the masked bytes.
 * Dissection: js/bledissect.js (pure, tested in tests/ble-tests.html).
 */
(function () {
  'use strict';
  const X = window.KellyBleDissect;
  if (!X) return;
  // real captures, masked (rotating address zeroed): lessons + quiz fallback when nothing's been heard yet
  const SAMPLES = {
    ibeacon: '043e2702010201' + '000000000040' + '1b1aff4c0002153f46eab9b0154bcdbf9798acba61978700010001c4b6',
    pvvx: '043e2b02010000' + '01225e38c1a4' + '1f' + '0b094154435f354532323031' + '12161a18' + '01225e38c1a4b4099a15860b5a0704' + 'bc',
    coded: '043e1d' + '0d01' + '0000' + '01' + '0000000000c0' + '03' + '00' + 'ff' + '7f' + 'c0' + '0000' + '00' + '000000000000' + '03' + '020106',
    rpa: '043e1e02010001' + '000000000040' + '12' + '020106' + '03032cfe' + '0aff0600010920020a0b0c' + 'b0' };   // addresses: placeholders with the right top bits
  const DECO_TYPES = ['u8', 's8', 'u16le', 's16le', 'u16be', 's16be', 'u32le', 's32le'];
  const TELEM_FIELDS = ['', 'temp', 'hum', 'batt', 'batt_mv', 'volt', 'pressure', 'co2', 'door', 'window', 'opening', 'motion', 'lux', 'moisture', 'power', 'current', 'count'];

  window.KellyBlePlugins = window.KellyBlePlugins || [];
  window.KellyBlePlugins.push(function (api) {
    const { esc, toast, store, bs, B } = api;
    const st = { packets: [], paused: false, sel: null, cmp: null, nodeId: null, hoverI: -1, on: false, cap: {}, lastRec: new Map(), seq: 0,
      f: { q: '', ad: '', rssi: -100, reg: false, real: false }, bookmarks: store.get('bleBookmarks', []) || [] };
    const quiz = Object.assign({ pts: 0, right: 0, asked: 0 }, store.get('bleQuiz', {}) || {});
    const lesson = { i: 0, step: 0 };
    let q = null, qPkt = null, qMsg = '';

    // ---- custom decoders live in settings.ble.decoders (scalar leaves): fields "n|off|type|scale|unit|tf;..."
    bs.decoders = bs.decoders || {};
    const specOf = ([id, d]) => ({ id, name: d.name, company: d.company === '' ? '' : d.company, uuid: d.uuid,
      fields: String(d.fields || '').split(';').filter(Boolean).map(s => { const [n, off, type, scale, unit, tf] = s.split('|'); return { n, off: +off, type, scale: +scale || 1, unit, tf }; }) });
    const applyDecoders = () => api.setDecoders(X.setCustom(Object.entries(bs.decoders).map(specOf)));
    applyDecoders();

    // ---- packets in
    const recFrom = diss => {   // the fields ble.js matches devices on, out of a dissection (registry lookup)
      const r = diss.reports[0] || {}, out = { a: r.addr, at: /Random/.test(r.addrType) ? 'random' : 'public', m: {}, s: {}, nm: null };
      for (const n of X.flat(diss.tree)) {
        if (n.adType === 0xFF && n.len > 4) out.m[String(diss.bytes[n.start + 2] | diss.bytes[n.start + 3] << 8)] = X.toHex(diss.bytes.slice(n.start + 4, n.start + n.len), '').toLowerCase();
        if (n.adType === 0x16 && n.len > 4) out.s[X.toHex([diss.bytes[n.start + 3], diss.bytes[n.start + 2]], '').toLowerCase()] = X.toHex(diss.bytes.slice(n.start + 4, n.start + n.len), '').toLowerCase();
        if (n.adType === 0x09 || n.adType === 0x08) out.nm = new TextDecoder().decode(diss.bytes.slice(n.start + 2, n.start + n.len));
      }
      return out;
    };
    function add(diss, ts, src, zone) {
      if (st.paused) return;
      const rec = recFrom(diss), dd = B.decode(rec), reg = api.registry().lookup(rec, dd);
      const rep = diss.reports[0] || {};
      const pk = { id: ++st.seq, ts, diss, real: diss.real, reg, name: reg ? api.devName(reg) : rec.nm || '', src, zone,
        key: B.bestKey(rec, dd) || rep.addr, masked: (rep.addrKind === 'rpa' || rep.addrKind === 'nrpa') && !reg };
      st.packets.unshift(pk);
      if (st.packets.length > 300) st.packets.length = 300;
    }
    function onHci(list) {
      if (!st.on) return;
      for (const [ad, ts, hex] of list) add(X.dissect(X.fromHex(hex)), ts, 'hci:' + ad, (api.link.hello || {}).zone);
      if (api.visible('inspect')) api.dirty('ble');
    }
    function onAdv(r, d, id, now) {   // reconstructed: no raw capture for this source (a node, the demo, no permission)
      if (!st.on) return;
      const raw = r.n === 'local' && Object.values(st.cap).includes('raw');
      if (raw) return;
      const k = r.a + '|' + JSON.stringify(r.m) + JSON.stringify(r.s);
      if (now - (st.lastRec.get(k) || 0) < 2000) return;   // the same advert again: once every 2 s is plenty to read
      st.lastRec.set(k, now); if (st.lastRec.size > 2000) st.lastRec.clear();
      add(X.fromRecord(r), r.ts || now, r.n === 'local' ? 'record' : 'node:' + r.n, r.z);
    }
    function setOn(on) {
      if (st.on === on) return;
      st.on = on; api.send({ t: 'inspect', on });
    }

    // ---- rendering helpers
    const LAYER_CLS = { hci: 'l-hci', rep: 'l-rep', ad: 'l-ad', dec: 'l-dec' };
    function byteOwners(diss) {   // deepest node per byte
      const own = new Array(diss.bytes.length).fill(null);
      X.walk(diss.tree, n => { for (let i = n.start; i < n.start + n.len && i < own.length; i++) own[i] = n; });
      return own;
    }
    function hexView(diss, opts = {}) {
      const own = byteOwners(diss), rep = diss.reports[0], maskFrom = opts.mask && rep ? rep.addrStart : -1;
      const sel = opts.sel || [-1, 0];
      let h = '<div class="bi-hex">';
      diss.bytes.forEach((b, i) => {
        const n = own[i], m = maskFrom >= 0 && i >= maskFrom && i < maskFrom + 6, on = i >= sel[0] && i < sel[0] + sel[1];
        h += `<span data-i="${i}" class="${n ? LAYER_CLS[n.layer] : ''}${on ? ' on' : ''}${diss.real ? '' : ' recon'}${opts.click ? ' clk' : ''}">${m ? '••' : b.toString(16).toUpperCase().padStart(2, '0')}</span>`;
      });
      return h + '</div>';
    }
    // a masked packet hides its rotating address everywhere it's shown: hex, tree values, the info box
    const hideAddr = p => {
      const r = p && p.masked && p.diss.reports[0];
      return r ? { txt: s => String(s).split(r.addr).join('••:••:••:••:••:••'), range: [r.addrStart, 6] } : { txt: String, range: [-1, 0] };
    };
    function treeView(diss, selId, txt = String) {
      const li = n => `<li><div class="bi-n${n.id === selId ? ' on' : ''} ${LAYER_CLS[n.layer]}" data-node="${n.id}"><b>${esc(n.label)}</b> <span>${esc(txt(n.value))}</span></div>${n.children.length ? `<ul>${n.children.map(li).join('')}</ul>` : ''}</li>`;
      return `<ul class="bi-tree">${diss.tree.map(li).join('')}</ul>`;
    }
    const findNode = (diss, id) => X.flat(diss.tree).find(n => n.id === id);
    const deepestAt = (diss, i) => byteOwners(diss)[i];

    // ---- the Inspector tab
    let root = null;
    function build(el) {
      root = el;
      el.innerHTML = `
        <div class="card"><div class="card-h"><h3>🔬 Packet Inspector</h3><div class="row gap wrap"><span class="tag" id="bi-src"></span>
          <button class="btn small" id="bi-pause"></button><button class="btn small" id="bi-clear">Clear</button>
          <button class="btn small" id="bi-pcap" title="Captured packets only, rotating addresses zeroed">⬇ pcap</button><button class="btn small" id="bi-json">⬇ JSON</button><button class="btn small" id="bi-csv">⬇ CSV</button></div></div>
          <p class="dim small">Every Bluetooth LE advert, byte by byte, with what each byte means. <b>Captured</b> bytes are exactly what the radio chip reported (raw HCI); <b>reconstructed</b> ones (dashed) are rebuilt from the fields BlueZ kept, so their order may differ from the air. Phones' rotating addresses show as •• -- they're other people's.</p>
          <div class="row gap wrap bi-filters">
            <label class="fld"><span>Find</span><input id="bi-q" placeholder="name, address, company, kind"></label>
            <label class="fld"><span>AD type</span><select id="bi-ad"><option value="">any</option>${Object.entries(X.AD_TYPES).map(([t, [n]]) => `<option value="${t}">${esc(n)}</option>`).join('')}</select></label>
            <label class="fld"><span>RSSI ≥</span><input id="bi-rssi" type="number" value="-100" style="width:80px"></label>
            <label class="fld inline"><input type="checkbox" id="bi-reg"> <span>Registered only</span></label>
            <label class="fld inline"><input type="checkbox" id="bi-real"> <span>Captured only</span></label>
            <label class="fld inline"><input type="checkbox" id="bi-bm"> <span>★ Bookmarks only</span></label>
          </div></div>
        <div class="grid bi-grid"><div class="card bi-list-card"><div class="ble-scroll"><table class="tbl click" id="bi-list"></table></div></div>
          <div class="card" id="bi-detail"></div></div>
        <div class="card"><div class="card-h"><h3>👻 What HCI can't see: the link layer</h3><span class="tag">explanation, not captured</span></div>
          <p class="dim small">Before the bytes above reach Kelly, the Bluetooth chip strips the link layer. Seeing it needs a sniffer (an nRF52840 dongle with Nordic's sniffer firmware -- planned).</p>
          <table class="tbl"><tbody>${X.LINK_LAYER.map(l => `<tr><td><b>${esc(l.label)}</b></td><td class="mono">${esc(l.bytes)}</td><td class="small">${esc(l.explain)}</td></tr>`).join('')}</tbody></table>
          <p class="dim small">Advertising happens on channels 37 (2402 MHz), 38 (2426) and 39 (2480 MHz), between Wi-Fi channels 1, 6 and 11 -- the same packet is usually sent on all three.</p></div>
        <div class="card" id="bi-deco"></div>`;
      const $ = s => el.querySelector(s);
      $('#bi-pause').onclick = () => { st.paused = !st.paused; api.dirty('ble'); };
      $('#bi-clear').onclick = () => { st.packets = []; st.sel = st.cmp = null; api.dirty('ble'); };
      $('#bi-pcap').onclick = exportPcap; $('#bi-json').onclick = () => exportText('json'); $('#bi-csv').onclick = () => exportText('csv');
      for (const [s, k, t] of [['#bi-q', 'q', 'v'], ['#bi-ad', 'ad', 'v'], ['#bi-rssi', 'rssi', 'n'], ['#bi-reg', 'reg', 'c'], ['#bi-real', 'real', 'c'], ['#bi-bm', 'bm', 'c']])
        $(s).oninput = $(s).onchange = e => { st.f[k] = t === 'c' ? e.target.checked : t === 'n' ? +e.target.value : e.target.value.trim().toLowerCase(); api.dirty('ble'); };
      $('#bi-list').onclick = e => { const tr = e.target.closest('[data-pk]'); if (!tr) return; const b = e.target.closest('[data-bm]'); if (b) { bookmark(+tr.dataset.pk); return; } st.sel = +tr.dataset.pk; st.cmp = null; st.nodeId = null; api.dirty('ble'); };
      $('#bi-detail').addEventListener('click', onDetailClick);
      $('#bi-detail').addEventListener('mouseover', e => { const s = e.target.closest('.bi-hex span'); if (s && s.closest('#bi-main')) { const p = selPk(); const n = p && deepestAt(p.diss, +s.dataset.i); if (n && n.id !== st.hoverId) { st.hoverId = n.id; paintSel(p.diss, n); } } });
      decoBuilder();
    }
    // bookmarks keep the (masked) bytes; shown as packets again with "★ only"
    const bmCache = new Map();
    const bmPackets = () => st.bookmarks.map(b => {
      if (!bmCache.has(b.id)) { const diss = X.dissect(X.fromHex(b.hex), { real: b.real }); bmCache.set(b.id, { id: b.id, ts: b.ts, diss, real: b.real, reg: null, name: b.name, key: 'bm' + b.id, masked: false }); }
      return bmCache.get(b.id);
    });
    const selPk = () => st.packets.find(p => p.id === st.sel) || bmPackets().find(p => p.id === st.sel) || null;
    function paintSel(diss, n) {   // hover: highlight without a full re-render
      const box = root.querySelector('#bi-main'); if (!box) return;
      box.querySelectorAll('.bi-hex span').forEach(s => { const i = +s.dataset.i; s.classList.toggle('hov', i >= n.start && i < n.start + n.len); });
      const info = root.querySelector('#bi-info'); if (info) info.innerHTML = nodeInfo(diss, n, hideAddr(selPk()));
    }
    const nodeInfo = (diss, n, h = hideAddr(null)) => {
      const hex = Array.from(diss.bytes.slice(n.start, n.start + n.len), (b, k) => { const i = n.start + k; return i >= h.range[0] && i < h.range[0] + h.range[1] ? '••' : b.toString(16).toUpperCase().padStart(2, '0'); }).join(' ');
      return `<div class="bi-info"><b>${esc(n.label)}</b> <span class="tag ${n.real ? 'ble-st-ok' : 'ble-st-warn'}">${n.real ? 'captured' : 'reconstructed'}</span>
      <div class="mono small">bytes ${n.start}${n.len > 1 ? '-' + (n.start + n.len - 1) : ''}: ${esc(hex)}</div>
      <div>${esc(h.txt(n.value))}</div><div class="dim small">${esc(n.explain || '')}</div></div>`;
    };
    function visiblePackets() {
      const f = st.f;
      return (f.bm ? bmPackets() : st.packets).filter(p => {
        const r = p.diss.reports[0] || {};
        if (f.reg && !p.reg) return false;
        if (f.real && !p.real) return false;
        if (r.rssi != null && r.rssi < f.rssi) return false;
        if (f.ad && !X.flat(p.diss.tree).some(n => n.adType === +f.ad)) return false;
        if (f.q) { const hay = `${p.name} ${p.masked ? '' : r.addr} ${X.categories(p.diss).join(' ')}`.toLowerCase(); if (!hay.includes(f.q)) return false; }
        return true;
      });
    }
    function render(tab) {
      if (tab === 'learn') return renderLearn();
      if (!root) return;
      setOn(api.visible('inspect'));
      const $ = s => root.querySelector(s), capS = Object.values(st.cap);
      const src = api.k.demo() ? ['ble-st-warn', 'Demo: reconstructed'] : capS.includes('raw') ? ['ble-st-ok', 'Captured: raw HCI'] : capS.includes('no-permission') ? ['ble-st-warn', 'Reconstructed (bridge lacks CAP_NET_RAW)'] : ['ble-st-warn', 'Reconstructed'];
      $('#bi-src').className = 'tag ' + src[0]; $('#bi-src').textContent = src[1];
      $('#bi-pause').textContent = st.paused ? '▶ Resume' : '⏸ Pause';
      const list = visiblePackets().slice(0, 120), bm = new Set(st.bookmarks.map(b => b.id));
      $('#bi-list').innerHTML = `<thead><tr><th></th><th>Time</th><th>RSSI</th><th>From</th><th>What</th><th>B</th></tr></thead><tbody>${list.map(p => {
        const r = p.diss.reports[0] || {}, kinds = X.categories(p.diss).filter(c => c.startsWith('kind:') || c.startsWith('company:')).map(c => c.split(':')[1]).slice(0, 2).join(', ');
        return `<tr data-pk="${p.id}" class="${p.id === st.sel ? 'sel' : ''}"><td><span data-bm class="bi-bm" title="Bookmark">${bm.has(p.id) ? '★' : '☆'}</span></td><td class="small nowrap">${new Date(p.ts).toLocaleTimeString()}</td><td class="mono">${r.rssi != null ? r.rssi : ''}</td>
          <td class="small">${p.reg ? '🏷️ ' + esc(p.name) : p.masked ? '<span class="dim">•• rotating</span>' : `<span class="mono">${esc(r.addr || '')}</span>${p.name ? '<br>' + esc(p.name) : ''}`}</td>
          <td class="small">${esc(r.evt || '')}${kinds ? '<br><span class="dim">' + esc(kinds) + '</span>' : ''}</td><td class="small">${p.real ? '' : '<span title="reconstructed">≈</span>'}</td></tr>`;
      }).join('') || `<tr><td colspan="6" class="dim">${st.paused ? 'Paused.' : 'Waiting for adverts…'}</td></tr>`}</tbody>`;
      renderDetail();
      if (!api.k.demo() && api.link.state !== 'up') $('#bi-src').textContent = 'Bridge not linked';
    }
    function renderDetail() {
      const box = root.querySelector('#bi-detail'), p = selPk();
      if (!p) { box.innerHTML = '<p class="dim">Pick a packet on the left. Hover the bytes or the tree -- each lights up the other.</p>'; return; }
      const n = st.nodeId ? findNode(p.diss, st.nodeId) : null;
      const sel = n ? [n.start, n.len] : [-1, 0];
      const prev = st.packets.find(x => x.id !== p.id && x.key === p.key && x.ts <= p.ts);
      box.innerHTML = `<div class="card-h"><h3>${p.reg ? '🏷️ ' + esc(p.name) : p.masked ? 'Someone\'s device (rotating address)' : esc(p.name || (p.diss.reports[0] || {}).addr || 'Packet')}</h3>
        <div class="row gap"><span class="tag ${p.real ? 'ble-st-ok' : 'ble-st-warn'}">${p.real ? 'captured' : 'reconstructed'}</span>${prev ? '<button class="btn small" data-diff>⇄ Diff with the one before</button>' : ''}</div></div>
        <div id="bi-main">${hexView(p.diss, { mask: p.masked, sel })}</div>
        <div class="bi-legend small"><span class="l-hci">HCI event</span><span class="l-rep">report</span><span class="l-ad">AD structure</span><span class="l-dec">decoded</span></div>
        <div id="bi-info">${n ? nodeInfo(p.diss, n, hideAddr(p)) : '<div class="dim small">Hover a byte or click a line in the tree.</div>'}</div>
        ${treeView(p.diss, st.nodeId, hideAddr(p).txt)}
        ${st.cmp ? diffView(p, st.packets.find(x => x.id === st.cmp)) : ''}
        ${telemMap(p)}`;
    }
    function onDetailClick(e) {
      const p = selPk(); if (!p) return;
      const nd = e.target.closest('[data-node]');
      if (nd) { st.nodeId = nd.dataset.node; renderDetail(); return; }
      const sp = e.target.closest('#bi-main .bi-hex span');
      if (sp) { const n = deepestAt(p.diss, +sp.dataset.i); st.nodeId = n && n.id; renderDetail(); return; }
      if (e.target.closest('[data-diff]')) { const prev = st.packets.find(x => x.id !== p.id && x.key === p.key && x.ts <= p.ts); st.cmp = prev && prev.id; renderDetail(); }
    }
    function diffView(a, b) {
      if (!b) return '';
      const ra = a.diss.reports[0], rb = b.diss.reports[0]; if (!ra || !rb) return '';
      const d = X.diff(rb.data, ra.data), changed = d.filter(x => !x.same).length;
      const row = (k, lbl) => `<div class="bi-diffrow"><span class="dim small">${lbl}</span>${d.map(x => `<span class="${x.same ? '' : 'chg'}">${x[k] == null ? '··' : x[k].toString(16).toUpperCase().padStart(2, '0')}</span>`).join('')}</div>`;
      return `<div class="bi-diff"><h4>⇄ Advertising data: ${changed} byte${changed === 1 ? '' : 's'} changed in ${Math.round((a.ts - b.ts) / 1000)} s</h4>${row('a', 'before')}${row('b', 'now')}
        <p class="dim small">Changing bytes are where the action is: counters, sensor values, battery. Bytes that never change are IDs. That's how sensor formats get worked out -- then describe one below in the decoder builder.</p></div>`;
    }
    // BLE -> P25: each decoded reading, its bytes in the advert, and the same value as a TELEM item on P25
    function telemMap(p) {
      const KF = window.CCDI && window.CCDI.KellyFrame, rows = X.flat(p.diss.tree).filter(n => n.tf && KF && KF.TELEM_Q[n.tf]);
      if (!rows.length) return '';
      const sn = p.reg ? api.tn(p.reg) : 0;
      const item = n => { const [code, scale] = KF.TELEM_Q[n.tf], v = Math.round(n.tv / scale), b = [1, sn || 0, code, 0, 0, v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255]; return X.toHex(b); };
      return `<div class="bi-map"><h4>📡 BLE → P25: these readings as Kelly sends them to the P25X gateway</h4><table class="tbl"><thead><tr><th>Reading</th><th>In the advert</th><th>Value</th><th>In the TELEM frame (P25)</th></tr></thead><tbody>
        ${rows.map(n => `<tr><td>${esc(n.label)}</td><td class="mono">${esc(X.toHex(p.diss.bytes.slice(n.start, n.start + n.len)))}</td><td>${esc(String(n.value))}</td><td class="mono">${item(n)}</td></tr>`).join('')}</tbody></table>
        <p class="dim small">TELEM item = 01 (a reading), sensor number${sn ? ` (#${sn})` : ' (00: this device doesn\'t send telemetry)'}, quantity code, age in seconds (2), value × 1/scale as a signed 32-bit big-endian number. BLE is little-endian; P25X telemetry is big-endian -- watch the bytes swap.</p></div>`;
    }
    function bookmark(id) {
      const i = st.bookmarks.findIndex(b => b.id === id);
      if (i >= 0) st.bookmarks.splice(i, 1);
      else { const p = st.packets.find(x => x.id === id); if (!p) return; st.bookmarks.unshift({ id, ts: p.ts, real: p.real, name: p.name, hex: X.toHex(p.masked ? X.masked(p.diss) : p.diss.bytes, '') }); st.bookmarks.length = Math.min(st.bookmarks.length, 50); }
      store.set('bleBookmarks', st.bookmarks); api.dirty('ble');
    }
    // ---- exports (masked)
    function save(name, data, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
    const keepReg = p => () => !!p.reg;
    function exportPcap() {
      const real = visiblePackets().filter(p => p.real).reverse();
      if (!real.length) { toast('🔬', 'No captured packets', 'pcap only holds captured bytes -- reconstructed ones aren\'t what was on the air. Use JSON or CSV for those.', 'bad'); return; }
      save(`kelly-ble-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.pcap`, X.pcap(real.map(p => ({ ts: p.ts, bytes: X.masked(p.diss, keepReg(p)) }))), 'application/vnd.tcpdump.pcap');
      toast('⬇', `${real.length} packets saved`, 'Open in Wireshark: it decodes them as Bluetooth HCI H4 events. Rotating addresses are zeroed.');
    }
    function exportText(kind) {
      const ps = visiblePackets().reverse().map(p => { const r = p.diss.reports[0] || {}; return { time: new Date(p.ts).toISOString(), captured: p.real, rssi: r.rssi, pdu: r.evt, address: p.masked ? 'masked' : r.addr, addressKind: r.addrKind, device: p.name, kinds: X.categories(p.diss).join(' '), hex: X.toHex(X.masked(p.diss, keepReg(p)), '') }; });
      if (kind === 'json') save('kelly-ble.json', JSON.stringify(ps, null, 1), 'application/json');
      else save('kelly-ble.csv', ['time,captured,rssi,pdu,address,addressKind,device,kinds,hex', ...ps.map(p => [p.time, p.captured, p.rssi, p.pdu, p.address, p.addressKind, `"${String(p.device || '').replace(/"/g, '""')}"`, `"${p.kinds}"`, p.hex].join(','))].join('\n'), 'text/csv');
    }

    // ---- custom decoder builder (no code)
    function decoBuilder() {
      const el = root.querySelector('#bi-deco');
      const rows = Object.entries(bs.decoders);
      el.innerHTML = `<div class="card-h"><h3>🧩 Custom decoders</h3><button class="btn small" id="bd-new">➕ New decoder</button></div>
        <p class="dim small">A device Kelly doesn't know? Find which bytes change (Diff), then describe them here: where they are, what type, what scale. Kelly then decodes them everywhere -- the Inspector, alert rules, and telemetry if you give them a telemetry name.</p>
        ${rows.length ? `<table class="tbl"><tbody>${rows.map(([id, d]) => `<tr><td><b>${esc(d.name)}</b></td><td class="small">${d.company !== '' && d.company != null ? `company ${esc(String(d.company))}` : `service ${esc(d.uuid || '')}`}</td><td class="mono small">${esc(d.fields)}</td><td><button class="btn small" data-dedit="${esc(id)}">Edit</button> <button class="btn small" data-ddel="${esc(id)}">✕</button></td></tr>`).join('')}</tbody></table>` : ''}
        <div id="bd-form"></div>`;
      el.querySelector('#bd-new').onclick = () => decoForm(null);
      el.onclick = e => { const d = e.target.dataset; if (d.dedit) decoForm(d.dedit); else if (d.ddel && confirm('Delete this decoder?')) { delete bs.decoders[d.ddel]; api.save(); applyDecoders(); decoBuilder(); } };
    }
    function decoForm(id) {
      const d = id ? specOf([id, bs.decoders[id]]) : { name: '', company: '', uuid: '', fields: [{ n: 'temp', off: 0, type: 's16le', scale: 0.01, unit: '°C', tf: 'temp' }] };
      const f = root.querySelector('#bd-form');
      const fieldRow = x => `<tr><td><input class="bd-n" value="${esc(x.n)}" style="width:110px"></td><td><input class="bd-off" type="number" min="0" value="${x.off}" style="width:60px"></td>
        <td><select class="bd-type">${DECO_TYPES.map(t => `<option${t === x.type ? ' selected' : ''}>${t}</option>`).join('')}</select></td><td><input class="bd-scale" type="number" step="any" value="${x.scale}" style="width:80px"></td>
        <td><input class="bd-unit" value="${esc(x.unit || '')}" style="width:60px"></td><td><select class="bd-tf">${TELEM_FIELDS.map(t => `<option value="${t}"${t === (x.tf || '') ? ' selected' : ''}>${t || '—'}</option>`).join('')}</select></td><td><button class="btn small bd-rm">✕</button></td></tr>`;
      f.innerHTML = `<div class="grid ble-form"><label class="fld"><span>Name</span><input id="bd-name" value="${esc(d.name)}"></label>
        <label class="fld"><span>Company ID (decimal)</span><input id="bd-co" value="${esc(String(d.company))}" placeholder="e.g. 76 = Apple"></label>
        <label class="fld"><span>…or service UUID (16-bit)</span><input id="bd-uu" value="${esc(d.uuid || '')}" placeholder="181a"></label></div>
        <table class="tbl"><thead><tr><th>Field</th><th>Offset</th><th>Type</th><th>Scale</th><th>Unit</th><th>Telemetry as</th><th></th></tr></thead><tbody id="bd-rows">${d.fields.map(fieldRow).join('')}</tbody></table>
        <p class="dim small">Offset counts from the first byte <i>after</i> the company ID (or service UUID). le = little-endian (most of BLE), be = big-endian.</p>
        <div class="row gap"><button class="btn small" id="bd-add">➕ Field</button><button class="btn primary" id="bd-save">💾 Save decoder</button><span id="bd-test" class="small"></span></div>`;
      const read = () => ({ name: f.querySelector('#bd-name').value.trim(), company: f.querySelector('#bd-co').value.trim(), uuid: f.querySelector('#bd-uu').value.trim().toLowerCase(),
        fields: [...f.querySelectorAll('#bd-rows tr')].map(tr => ({ n: tr.querySelector('.bd-n').value.trim().replace(/[|;]/g, ''), off: +tr.querySelector('.bd-off').value, type: tr.querySelector('.bd-type').value, scale: +tr.querySelector('.bd-scale').value || 1, unit: tr.querySelector('.bd-unit').value.replace(/[|;]/g, ''), tf: tr.querySelector('.bd-tf').value })).filter(x => x.n) });
      const test = () => { const s = read(), p = selPk(); if (!p) { f.querySelector('#bd-test').textContent = 'Select a packet to try it on.'; return; }
        const r = X.customDecoder(s).decode(recFrom(p.diss)); f.querySelector('#bd-test').textContent = r ? 'On the selected packet: ' + Object.entries(r.val).map(([k, v]) => `${k} ${v}`).join(', ') : 'Doesn\'t match the selected packet.'; };
      f.oninput = test; test();
      f.querySelector('#bd-add').onclick = () => { f.querySelector('#bd-rows').insertAdjacentHTML('beforeend', fieldRow({ n: '', off: 0, type: 'u8', scale: 1 })); };
      f.querySelector('#bd-rows').onclick = e => { if (e.target.classList.contains('bd-rm')) e.target.closest('tr').remove(); };
      f.querySelector('#bd-save').onclick = () => {
        const s = read();
        if (!s.name || (s.company === '' && !/^[0-9a-f]{4}$/.test(s.uuid)) || !s.fields.length) { toast('🧩', 'Needs a name, a company ID or 4-digit service UUID, and a field', '', 'bad'); return; }
        bs.decoders[id || 'x' + Date.now().toString(36)] = { name: s.name.slice(0, 24), company: s.company === '' ? '' : +s.company, uuid: s.uuid,
          fields: s.fields.map(x => [x.n, x.off, x.type, x.scale, x.unit, x.tf].join('|')).join(';') };
        api.save(); applyDecoders(); decoBuilder(); toast('🧩', 'Decoder saved', s.name);
      };
    }

    // ---- Learn: guided walkthroughs on real (masked) packets, and the Packet Quiz
    const LESSONS = [
      { title: 'Anatomy of an iBeacon', sample: 'ibeacon', steps: [
        ['HCI event', 'This is exactly what the Bluetooth chip sent the computer. 04 = an event, 3E = an LE event, 02 = an advertising report.'],
        ['Event type', '02 = ADV_SCAN_IND: "here I am, ask me for more if you like".'],
        ['Address', 'A phone\'s rotating address -- masked here, it\'s private. A dedicated beacon would use a fixed one.'],
        ['Manufacturer specific data', 'One AD structure: 1A = 26 bytes follow, FF = manufacturer data.'],
        ['Company ID', '4C 00 -- little-endian, so 0x004C: Apple. iBeacon is Apple\'s format.'],
        ['Proximity UUID', 'The beacon owner\'s ID. Unusually for BLE, iBeacon numbers are big-endian.'],
        ['Major', 'A group (a building, a club).'], ['Minor', 'One beacon in the group. Kelly matches on UUID + major + minor.'],
        ['Measured power', 'The signal expected 1 m away (C4 = -60 dBm). Compare with the RSSI to guess the distance.'],
        ['RSSI', 'How strong it arrived: B6 = -74 dBm. Closer to 0 = nearer.']] },
      { title: 'Why your phone\'s address keeps changing', sample: 'rpa', steps: [
        ['Address type', '01 = a random address. "Random" covers three kinds -- the top two bits of the address say which.'],
        ['Address', 'Top bits 01: a resolvable private address. The phone makes a new one every ~15 minutes, so shops and passers-by can\'t follow it around. Only devices it has paired with (they hold its IRK key) can recognise it.'],
        ['Advertising data', 'That\'s why Kelly can\'t register a phone by its address -- and why a beacon app, or a dedicated beacon with a fixed ID, works instead.']] },
      { title: 'A sensor in an advert: the Xiaomi thermometer', sample: 'pvvx', steps: [
        ['Service data (16-bit UUID)', 'AD type 16 = service data: a 16-bit UUID, then that service\'s bytes.'],
        ['Service UUID', '1A 18 = 0x181A, the "environmental sensing" service the custom firmware uses.'],
        ['Temperature', 'B4 09 little-endian = 0x09B4 = 2484, × 0.01 = 24.84 °C. Kelly reads this every few seconds.'],
        ['Humidity', '9A 15 = 0x159A = 5530 → 55.30 %.'],
        ['Counter', 'Goes up by one with each new measurement -- Diff two packets and watch it.']] },
      { title: 'Coded PHY: Bluetooth\'s long range', sample: 'coded', steps: [
        ['Subevent', '0D = an extended advertising report: Bluetooth 5\'s kind, up to 255 bytes and any PHY.'],
        ['Primary PHY', '03 = LE Coded. Each bit is sent 8 times (S=8): 1/8 the speed for about 4× the range -- a fox hunt across a park instead of a room.'],
        ['Secondary PHY', 'Where the rest of an extended advert goes: on a data channel, pointed to by an AUX pointer.'],
        ['Flags', 'Even long-range adverts start with the usual Flags structure.']] },
      { title: 'What we can\'t see: the link layer', sample: 'ibeacon', steps: [
        ['HCI event', 'Everything here came after the chip removed the link layer: preamble AA, access address D6 BE 89 8E (0x8E89BED6, the same for every advert), the PDU header and a 24-bit CRC.'],
        ['Report 1', 'A packet with a bad CRC never gets this far -- the chip drops it silently. So RSSI is all we learn about weak signals.'],
        ['Event type', 'The PDU header\'s type bits survive as this event type, and its TxAdd bit as the address type.']] },
    ];
    let lroot = null;
    function buildLearn(el) {
      lroot = el;
      el.innerHTML = `<div class="card"><div class="card-h"><h3>🎓 Learn BLE, byte by byte</h3><select id="bl-pick">${LESSONS.map((l, i) => `<option value="${i}">${esc(l.title)}</option>`).join('')}</select></div><div id="bl-body"></div></div>
        <div class="card"><div class="card-h"><h3>❓ Packet Quiz</h3><div class="row gap"><span class="tag" id="bq-level"></span><span class="dim small" id="bq-score"></span><button class="btn small" id="bq-new">New question</button></div></div><div id="bq-body"></div></div>`;
      el.querySelector('#bl-pick').onchange = e => { lesson.i = +e.target.value; lesson.step = 0; renderLearn(); };
      el.querySelector('#bl-body').onclick = e => { if (e.target.dataset.lstep) { lesson.step = Math.max(0, Math.min(LESSONS[lesson.i].steps.length - 1, lesson.step + +e.target.dataset.lstep)); renderLearn(); } };
      el.querySelector('#bq-new').onclick = newQuestion;
      el.querySelector('#bq-body').onclick = onQuizClick;
    }
    function renderLearn() {
      if (!lroot) return;
      const L = LESSONS[lesson.i], diss = X.dissect(X.fromHex(SAMPLES[L.sample])), [label, text] = L.steps[lesson.step];
      const n = X.flat(diss.tree).find(x => x.label === label) || diss.tree[0];
      lroot.querySelector('#bl-body').innerHTML = `${hexView(diss, { mask: true, sel: [n.start, n.len] })}
        <div class="bi-info"><b>${lesson.step + 1} / ${L.steps.length}: ${esc(label)}</b><div>${esc(text)}</div><div class="dim small">${esc(n.explain || '')}</div></div>
        <div class="row gap"><button class="btn small" data-lstep="-1"${lesson.step ? '' : ' disabled'}>◀ Back</button><button class="btn small primary" data-lstep="1"${lesson.step < L.steps.length - 1 ? '' : ' disabled'}>Next ▶</button>
        <span class="dim small">A real capture from a bench Pi (addresses masked).</span></div>`;
      lroot.querySelector('#bq-level').textContent = X.level(quiz.pts) + ' level';
      lroot.querySelector('#bq-score').textContent = `${quiz.pts} pts · ${quiz.right}/${quiz.asked} right`;
      if (!q) lroot.querySelector('#bq-body').innerHTML = '<p class="dim">Questions use packets Kelly has just heard (or the lesson samples). Foundation → Standard (60 pts) → Advanced (160 pts), like the licence grades.</p>';
    }
    function newQuestion() {
      const pool = st.packets.filter(p => p.real && p.diss.reports.length);
      const diss = pool.length ? pool[Math.floor(Math.random() * Math.min(pool.length, 40))].diss : X.dissect(X.fromHex(SAMPLES[Object.keys(SAMPLES)[Math.floor(Math.random() * 4)]]));
      qPkt = diss; q = X.quiz(diss); qMsg = ''; drawQuiz();
    }
    function drawQuiz() {
      const box = lroot.querySelector('#bq-body'); if (!q) return;
      box.innerHTML = `<p><b>${esc(q.q)}</b></p>${hexView(qPkt, { mask: true, sel: q.highlight || [-1, 0], click: q.kind === 'bytes' })}
        ${q.kind === 'choice' ? `<div class="row gap wrap">${q.choices.map((c, i) => `<button class="btn small" data-qa="${i}">${esc(c)}</button>`).join('')}</div>` : '<p class="dim small">Click a byte.</p>'}
        <p>${qMsg}</p>`;
    }
    function onQuizClick(e) {
      if (!q || q.done) return;
      let right = null;
      if (e.target.dataset.qa != null) right = +e.target.dataset.qa === q.answer;
      const sp = e.target.closest('.bi-hex span');
      if (sp && q.kind === 'bytes') { const i = +sp.dataset.i; right = i >= q.answer[0] && i < q.answer[0] + q.answer[1]; }
      if (right == null) return;
      q.done = true; quiz.asked++;
      const before = X.level(quiz.pts);
      if (right) { quiz.right++; quiz.pts += q.pts; api.sfx('arrive'); } else api.sfx('alarm-info');
      store.set('bleQuiz', quiz);
      const correct = q.kind === 'choice' ? q.choices[q.answer] : `bytes ${q.answer[0]}-${q.answer[0] + q.answer[1] - 1}`;
      qMsg = `${right ? `✅ Right! +${q.pts}` : `❌ It was ${esc(correct)}.`} ${esc(q.explain || '')}${X.level(quiz.pts) !== before ? ` <b class="bi-up">🎉 ${esc(X.level(quiz.pts))} level!</b>` : ''}`;
      if (q.kind === 'bytes') q.highlight = q.answer;
      drawQuiz(); renderLearn();
    }

    return {
      tabs: [['inspect', '🔬 Inspector'], ['learn', '🎓 Learn']],
      build(el, id) { if (id === 'inspect') build(el); else buildLearn(el); },
      render,
      onTab(tab) { setOn(tab === 'inspect'); if (tab === 'learn') renderLearn(); },
      onHello(m) { st.cap = m.inspect || {}; st.on = false; if (api.visible('inspect')) setOn(true); },
      onInspect(state) { st.cap = state; },
      onHci, onAdv,
      // for the games plugin: the quiz score + the latest dissections
      quizPoints: () => quiz.pts,
    };
  });
})();
