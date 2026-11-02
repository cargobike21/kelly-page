/* Kelly Page -- LoRa Mesh > Packet Journey: pj-inspect (2026-10-24, unreleased). The right-hand card: a short live list
 * of recent packets and, for the one picked, a learning-tool breakdown -- the header byte split into its bits, the path
 * length byte, each path hash with the node it stands for, every field from js/mcdecode.js as a colour-coded block
 * (tap one for what it means) and a hex dump tinted by field. Block colours reuse css/mcanalyser.css .mca-g-<group>.
 *
 * The node filter chip gets ▦ (its contact QR, js/meshqr.js) when the registry has that node's full key and role.
 * window.KellyPJInspect(mount, c) -> { destroy() }      c = the shared context (js/pj-ui.js, PACKET_JOURNEY_PLAN.md)
 * Bus: listens to 'packet', 'select', 'visible', 'reset', 'nodes'; emits 'select' { packet, from: 'inspect' }.
 */
(function () {
  'use strict';

  const KEEP = 200, SHOW = 30, MIN_GAP = 350;   // packets kept (for the node filter), shown, ms between list redraws
  const ROUTE_TXT = ['transport flood: floods everywhere, but only inside the region its transport codes name',
    'flood: every repeater that hears it repeats it, adding its own hash to the path',
    'direct: follows a path the sender already knows; each repeater on it takes its own hash off',
    'transport direct: a known path, plus region (transport) codes'];

  window.KellyPJInspect = function (mount, c) {
    if (!mount) return { destroy() {} };
    const esc = s => { try { return c.esc(s == null ? '' : String(s)); } catch { return String(s == null ? '' : s).replace(/[&<>"']/g, x => '&#' + x.charCodeAt(0) + ';'); } };
    const PAL = (c.PJ && c.PJ.PALETTE) || {};
    const col = k => (PAL[k] || PAL.unknown || { color: '#ff3b5c' }).color;
    const D = c.D || {};
    const st = { buf: [], frozen: null, held: 0, sel: null, field: null, node: null, dirty: false, timer: null, last: 0 };
    const subs = [];

    mount.innerHTML = `<div class="pj-insp">
      <div class="card-h pj-insp-h"><h2>🔍 Inspect</h2><span class="pj-insp-count" data-r="count"></span>
        <button class="btn ghost pj-insp-pause" data-r="pause" title="Freeze the list so you can pick a packet">⏸ Pause list</button></div>
      <div class="pj-insp-filter" data-r="filter" hidden></div>
      <div class="pj-insp-list" data-r="list" role="listbox" aria-label="Recent packets"></div>
      <div class="pj-insp-detail" data-r="detail"></div>
    </div>`;
    const R = n => mount.querySelector(`[data-r="${n}"]`);

    // ---------------------------------------------------------------- helpers
    const nodeName = id => { if (!id) return '?'; if (id === 'me') return (c.reg && c.reg.me && c.reg.me().name) || 'My node'; const n = c.reg && c.reg.get(id); return (n && n.name) || (id.startsWith('h:') ? id.slice(2) : id.startsWith('n:') ? id.slice(2) : id.slice(0, 8)); };
    // ▦ a node's contact QR: only with its full 32-byte key and a known role -- never a hash-only hop
    const ROLE_TYPE = { companion: 1, repeater: 2, room: 3, 'room server': 3, sensor: 4 };
    const qrOf = id => {
      if (!id || !window.KellyMeshQR) return null;
      let n = null; try { n = id === 'me' ? null : c.reg && c.reg.get(id); } catch { n = null; }
      const key = n && n.key ? String(n.key).toLowerCase() : '', type = n ? ROLE_TYPE[String(n.role || '').toLowerCase()] : null;
      return /^[0-9a-f]{64}$/.test(key) && type ? { key, type, name: n.raw || n.name || '' } : null;
    };
    const canon = id => { try { return c.reg.canonical(id); } catch { return id; } };
    const touches = (ev, node) => {
      const want = canon(node);
      const ids = [].concat(ev.journey || [], ev.ahead || [], ev.src ? [ev.src.id] : [], ev.heardFrom ? [ev.heardFrom] : []);
      return ids.some(id => id && canon(id) === want);
    };
    const hhmmss = t => { try { return new Date(t).toLocaleTimeString([], { hour12: false }); } catch { return ''; } };
    const num = (v, u) => v == null || isNaN(v) ? '–' : `${Math.round(v * 10) / 10}${u}`;
    const hex2 = x => (x & 255).toString(16).padStart(2, '0');
    const bin = (x, n) => (x >>> 0).toString(2).padStart(n, '0');

    // ---------------------------------------------------------------- the list
    function rows() {
      const src = st.frozen || st.buf, out = [];
      for (let i = src.length - 1; i >= 0 && out.length < SHOW; i--) if (!st.node || touches(src[i], st.node)) out.push(src[i]);
      return out;
    }
    function renderList() {
      st.dirty = false; st.last = Date.now();
      const box = R('list'); if (!box) return;
      const list = rows();
      R('count').textContent = st.frozen ? `paused${st.held ? ` · ${st.held} new` : ''}` : `${st.buf.length} seen`;
      R('pause').textContent = st.frozen ? '▶ Resume list' : '⏸ Pause list';
      R('pause').classList.toggle('primary', !!st.frozen);
      const f = R('filter');
      if (st.node) { f.hidden = false; f.innerHTML = `<span class="tag pj-insp-chip">Only <b>${esc(nodeName(st.node))}</b> <button class="pj-insp-x" data-r="clearf" title="Show every packet" aria-label="Clear filter">✕</button></span>${qrOf(st.node) ? ' <button class="btn small ghost pj-insp-qr" data-r="qr" title="Show this node&#39;s contact QR (MeshCore app form)" aria-label="Show this node&#39;s QR code">▦</button>' : ''}`; R('clearf').onclick = () => { st.node = null; renderList(); };
        if (R('qr')) R('qr').onclick = () => { const q = qrOf(st.node); if (q) try { window.KellyMeshQR.ui({ toast: c.toast }).show({ contact: q, note: 'Scan it with the MeshCore app (or Kelly) to add this node as a contact.' }); } catch (e) { console.warn('pj-inspect qr', e); } }; }
      else { f.hidden = true; f.innerHTML = ''; }
      if (!list.length) { box.innerHTML = `<div class="pj-insp-empty">${st.node ? 'Nothing from this node in the last packets.' : 'Waiting for packets... try 🎲 Demo traffic.'}</div>`; return; }
      box.innerHTML = list.map(ev => {
        const hops = ev.ok === false ? 'bad' : ev.type === 'TRACE' ? `${(ev.snrs || []).length}↯` : `${ev.hops || 0}h`;   // undecodable: no real hop count
        return `<button class="pj-insp-row${st.sel && st.sel.seq === ev.seq ? ' on' : ''}" data-seq="${ev.seq}" role="option" title="${esc(ev.summary || ev.typeLabel)} · ${esc(ev.route)}">
          <i class="pj-insp-dot" style="background:${col(ev.kind)};box-shadow:0 0 6px ${col(ev.kind)}"></i>
          <span class="pj-insp-t">${esc(hhmmss(ev.t))}</span>
          <span class="pj-insp-s">${ev.demo ? '<em>demo</em> ' : ''}${esc(ev.summary || ev.typeLabel || '?')}</span>
          <span class="pj-insp-n">${esc(hops)}</span><span class="pj-insp-n">${esc(num(ev.snr, ''))}</span></button>`;
      }).join('');
    }
    function schedule() {
      st.dirty = true;
      if (st.timer || !c.visible()) return;
      st.timer = setTimeout(() => { st.timer = null; if (!c.visible()) return; if (st.hover && st.dirty) { schedule(); return; } if (st.dirty) renderList(); if (st.detailDirty) { st.detailDirty = false; renderDetail(); } }, st.hover ? 800 : Math.max(0, MIN_GAP - (Date.now() - st.last)));   // a pointer over the list holds it still
    }
    function findSeq(seq) { for (const src of [st.frozen || [], st.buf]) for (const ev of src) if (ev.seq === seq) return ev; return null; }

    // ---------------------------------------------------------------- the breakdown
    function oneLiner(ev) {
      const p = PAL[ev.kind] || {};
      let html = `<div class="pj-insp-sum"><span class="pj-insp-kind" style="color:${col(ev.kind)};border-color:${col(ev.kind)}">${esc(p.icon || '')} ${esc(p.label || ev.kind)}</span>
        <b>${esc(ev.typeLabel || ev.type)}</b> · ${esc(ev.route)}${ev.transport ? ' (transport codes)' : ''} · ${esc(ev.size)} bytes${ev.demo ? ' · <span class="tag warn">demo</span>' : ''}</div>
        <p class="pj-insp-line">${esc(ev.summary)}</p>`;
      if (ev.text != null) html += `<p class="pj-insp-msg">💬 ${ev.sender ? `<b>${esc(ev.sender)}</b>: ` : ''}${esc(ev.text)}${ev.channel ? ` <span class="dim">on ${esc(ev.channel)}</span>` : ''}</p>`;
      else if (ev.encrypted) html += `<p class="pj-insp-lock">🔒 Encrypted -- ${ev.kind === 'chat' ? 'on a channel you don\'t hold the key for' : 'only the two ends can read it'}. That's the point.</p>`;
      if (ev.gps) html += `<p class="pj-insp-gps">📍 ${esc(ev.gps.lat.toFixed(4))}, ${esc(ev.gps.lon.toFixed(4))}${ev.advert && ev.advert.name ? ` -- ${esc(ev.advert.name)}` : ''}</p>`;
      if (!ev.ok) html += `<p class="pj-insp-bad">⚠️ ${esc(ev.err || 'Could not decode')}</p>`;
      html += `<p class="pj-insp-rx dim">Heard ${esc(hhmmss(ev.t))} from <b>${esc(nodeName(ev.heardFrom))}</b> · SNR ${esc(num(ev.snr, ' dB'))} · RSSI ${esc(num(ev.rssi, ' dBm'))}</p>`;
      return html;
    }
    function journey(ev) {
      const j = ev.journey || [], a = ev.ahead || [];
      if (!j.length) return '';
      const chip = (id, cls) => `<span class="pj-insp-jn ${cls || ''}">${esc(nodeName(id))}</span>`;
      let html = j.map((id, i) => chip(id, i === 0 ? 'from' : id === 'me' ? 'me' : '')).join('<span class="pj-insp-arrow">→</span>');
      if (a.length) html += `<span class="pj-insp-ahead"> · still to go: ${a.map(id => chip(id, 'ahead')).join('<span class="pj-insp-arrow">→</span>')}</span>`;
      return `<div class="pj-insp-sec"><h4>Journey</h4><div class="pj-insp-journey">${html}</div></div>`;
    }
    // the header byte, bit by bit: version b7-6, type b5-2, route b1-0
    function headerBits(ev, raw) {
      const h = raw[0], route = h & 3, type = (h >> 2) & 15, ver = h >> 6;
      const tn = (D.TYPES && D.TYPES[type]) || `type ${type}`, fr = (D.FRIENDLY && D.FRIENDLY[tn]) || tn;
      const bits = bin(h, 8).split('').map((b, i) => `<span class="pj-insp-bit ${i < 2 ? 'v' : i < 6 ? 'ty' : 'ro'}">${b}</span>`).join('');
      return `<div class="pj-insp-sec"><h4>Header byte <code>0x${hex2(h)}</code></h4>
        <div class="pj-insp-bits">${bits}</div>
        <div class="pj-insp-bitkey">
          <div><span class="pj-insp-sw v"></span><b>Version</b> (top 2 bits <code>${bin(ver, 2)}</code>) = v${ver + 1}${ver === 0 ? ': 1-byte addresses, 2-byte MAC' : ''}</div>
          <div><span class="pj-insp-sw ty"></span><b>Type</b> (middle 4 <code>${bin(type, 4)}</code>) = ${type}: ${esc(tn)} -- ${esc(fr)}</div>
          <div><span class="pj-insp-sw ro"></span><b>Route</b> (low 2 <code>${bin(route, 2)}</code>) = ${route}: ${esc(ROUTE_TXT[route])}</div>
        </div></div>`;
    }
    function pathSection(ev, raw) {
      const pl = (ev.d && ev.d.fields || []).find(f => f.group === 'pathlen');
      if (!pl) return '';
      const b = raw[pl.start];
      let html = `<div class="pj-insp-sec"><h4>Path length byte <code>0x${hex2(b)}</code></h4>`;
      if (ev.type === 'TRACE') {
        html += `<p class="small">For a trace this byte is just a count: <b>${b}</b> SNR reading${b === 1 ? '' : 's'} follow, one added by each repeater the trace passed.</p>`;
        if ((ev.snrs || []).length) html += `<div class="pj-insp-chips">${ev.snrs.map((s, i) => `<span class="pj-insp-chip snr">#${i + 1} <b>${esc(num(s, ' dB'))}</b></span>`).join('')}</div>`;
      } else {
        const bits = bin(b, 8).split('').map((x, i) => `<span class="pj-insp-bit ${i < 2 ? 'hs' : 'hc'}">${x}</span>`).join('');
        html += `<div class="pj-insp-bits">${bits}</div><div class="pj-insp-bitkey">
          <div><span class="pj-insp-sw hs"></span><b>Hash size</b> (top 2 <code>${bin(b >> 6, 2)}</code>) + 1 = <b>${(b >> 6) + 1}-byte</b> hashes${(b >> 6) === 0 ? ' (only 256 IDs -- clashes are easy)' : ''}</div>
          <div><span class="pj-insp-sw hc"></span><b>Hops</b> (low 6 <code>${bin(b & 63, 6)}</code>) = <b>${b & 63}</b> ${ev.route === 'direct' ? 'still to go' : 'travelled'}</div></div>`;
        const ids = ev.route === 'flood' ? (ev.journey || []).slice(1, -1) : (ev.ahead || []);
        if ((ev.path || []).length) html += `<div class="pj-insp-chips">${ev.path.map((h, i) => `<span class="pj-insp-chip hash" title="The first ${esc(ev.hashSize)} byte(s) of this repeater's public key"><code>${esc(h)}</code> ${esc(nodeName(ids[i]))}</span>`).join('<span class="pj-insp-arrow">→</span>')}</div>`;
        else html += `<p class="small dim">No hashes: ${ev.route === 'direct' ? 'the last hop -- it goes straight to its target' : 'heard straight from the sender, no repeater in between'}.</p>`;
      }
      return html + '</div>';
    }
    function fieldsSection(ev, raw) {
      const fs = (ev.d && ev.d.fields) || [];
      if (!fs.length) return '';
      const on = st.field;
      const blocks = fs.map((f, i) => {
        const short = f.len <= 4 ? f.hex : f.hex.slice(0, 8) + '…';
        return `<button class="mca-blk pj-insp-blk mca-g-${esc(f.group)}${f.warn ? ' warn' : ''}${on === i ? ' on' : ''}" data-f="${i}" title="${esc(f.label)}: ${f.len} byte${f.len === 1 ? '' : 's'}"><code>${esc(short)}</code><span>${esc(f.label)}</span><small>${f.len}B</small></button>`;
      }).join('');
      const f = on != null ? fs[on] : null;
      const ex = f ? `<div class="pj-insp-explain${f.warn ? ' warn' : ''}"><h4>${esc(f.label)} <small>bytes ${f.start}-${f.start + f.len - 1}</small></h4><div class="val">${esc(f.value)}</div><p>${esc(f.explain || '')}</p></div>`
        : `<div class="pj-insp-explain dim">Tap a block to see what those bytes mean.</div>`;
      // hex dump: each byte tinted by its field
      const grp = new Array(raw.length).fill(-1);
      fs.forEach((x, i) => { for (let k = x.start; k < x.start + x.len && k < raw.length; k++) grp[k] = i; });
      let dump = '';
      for (let o = 0; o < raw.length; o += 16) {
        dump += `<div class="pj-insp-hl"><span class="pj-insp-off">${o.toString(16).padStart(3, '0')}</span>`;
        for (let k = o; k < Math.min(o + 16, raw.length); k++) {
          const gi = grp[k], g = gi >= 0 ? fs[gi] : null;
          dump += `<span class="pj-insp-b${g ? ' pj-insp-t-' + esc(g.group) : ''}${gi === on && on != null ? ' on' : ''}" data-f="${gi}" title="${esc(g ? g.label : '')}">${hex2(raw[k])}</span>`;
        }
        dump += '</div>';
      }
      return `<div class="pj-insp-sec"><h4>Every field</h4><div class="pj-insp-strip">${blocks}</div>${ex}</div>
        <div class="pj-insp-sec"><h4>Hex dump <small class="dim">${raw.length} bytes</small></h4><div class="pj-insp-dump">${dump}</div></div>`;
    }
    function renderDetail() {
      const box = R('detail'); if (!box) return;
      const ev = st.sel;
      if (!ev) { box.innerHTML = `<div class="pj-insp-empty">Tap a packet above (or one on the picture) to take it apart byte by byte.</div>`; return; }
      let raw = ev.raw;
      if (!(raw instanceof Uint8Array)) raw = ev.hex && D.unhex ? D.unhex(ev.hex) : new Uint8Array(0);
      try {
        box.innerHTML = `<div class="pj-insp-card">${oneLiner(ev)}${journey(ev)}${raw.length ? headerBits(ev, raw) : ''}${raw.length > 1 ? pathSection(ev, raw) : ''}${fieldsSection(ev, raw)}</div>`;
      } catch (e) { console.warn('pj-inspect', e); box.innerHTML = `<div class="pj-insp-empty">Couldn't show this packet: ${esc(e.message)}</div>`; return; }
      box.querySelectorAll('[data-f]').forEach(b => { b.onclick = () => { const i = +b.dataset.f; if (i < 0) return; st.field = st.field === i ? null : i; renderDetail(); }; });
    }
    function show(ev, emit) {
      st.sel = ev; st.field = null; renderDetail();
      mount.querySelectorAll('.pj-insp-row').forEach(r => r.classList.toggle('on', +r.dataset.seq === ev.seq));
      if (emit) c.bus.emit('select', { packet: ev, node: ev.src ? ev.src.id : undefined, from: 'inspect' });
    }

    // ---------------------------------------------------------------- wiring
    // pick on pointerdown: the list may be redrawn between press and release (keyboard Enter/Space still clicks)
    const pickRow = e => { const b = e.target.closest('.pj-insp-row'); if (!b) return; const ev = findSeq(+b.dataset.seq); if (ev) show(ev, true); };
    R('list').onpointerdown = e => { if (e.button === 0) pickRow(e); };
    R('list').onclick = e => { if (e.detail === 0) pickRow(e); };
    R('list').onpointerenter = () => { st.hover = true; };
    R('list').onpointerleave = () => { st.hover = false; if (st.dirty) schedule(); };
    R('pause').onclick = () => { st.frozen = st.frozen ? null : st.buf.slice(); st.held = 0; renderList(); };
    const on = (name, fn) => subs.push(c.bus.on(name, x => { try { fn(x); } catch (e) { console.warn('pj-inspect', name, e); } }));
    on('packet', ev => {
      if (!ev) return;
      st.buf.push(ev); if (st.buf.length > KEEP) st.buf.splice(0, st.buf.length - KEEP);
      if (st.frozen) { st.held++; schedule(); return; }
      schedule();
    });
    on('select', s => {
      if (!s || s.from === 'inspect') return;
      if (s.packet) { show(s.packet, false); return; }
      if (s.node) { st.node = s.node; renderList(); }
      else if (s.node === null) { st.node = null; renderList(); }
    });
    on('visible', v => { if (!v) return; if (st.dirty) renderList(); if (st.detailDirty) { st.detailDirty = false; renderDetail(); } });
    on('nodes', () => { if (st.sel) st.detailDirty = true; schedule(); });   // names arrive later: refresh the chips (batched)
    on('reset', () => { st.buf = []; st.frozen = null; st.held = 0; st.sel = null; st.field = null; st.node = null; renderList(); renderDetail(); });

    renderList(); renderDetail();
    return {
      destroy() { subs.forEach(u => { try { u(); } catch {} }); subs.length = 0; if (st.timer) clearTimeout(st.timer); st.timer = null; mount.innerHTML = ''; },
      _state: st,   // tests
    };
  };
})();
