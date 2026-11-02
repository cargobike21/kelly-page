/* Kelly Page -- LoRa Mesh > MeshCore Analyser tab (2026-10-24): a packet sniffer and a learning tool for MeshCore.
 *   capture   every packet the companion hears (PUSH LOG_RX_DATA, fed by mesh.js), a 2,000-packet ring buffer,
 *             pause / resume, clear, filters (type, node, hops, wrong hash size), save / load (JSON, or raw hex lines)
 *   decode    js/mcdecode.js (pure, tested; layouts from the MeshCore source); OUR channels are decrypted, nothing else
 *   learn     each packet as a colour byte strip (tap a block: what it is, in plain English), a journey view of its
 *             hops (plays once when picked -- nothing loops), a legend, and a guided tour of one advert and one
 *             channel message, built here with a tour-only channel key
 *   share     an ADVERT's detail offers ▦ Show this node's QR (its decoded key / type / name, js/meshqr.js)
 *   check     the path hash size check (js/mchashcheck.js): wrong-size path blocks are red with ⚠️; the list of nodes
 *             on the wrong size, the log, and the expected size live in the panel at the bottom
 * window.KellyMcAnalyser(k) -> { init, feed(ev), shown, refreshChecks }; k from mesh.js:
 *   { $, esc, toast, decodeOpts() -> { channels, expectHash }, byPrefix(hex), myName(), fx(), fmtAgo(t),
 *     hash: { nodes(), log(), clear(), forget(id), expected(), setExpected(n), hint(rec), p25: { on(), set(b) } } }
 */
(function () {
  'use strict';
  const CAP = 2000, LIST_MAX = 400;

  window.KellyMcAnalyser = function (k) {
    const D = window.KellyMcDecode, { $, esc } = k;
    const st = { buf: [], paused: false, dropped: 0, sel: null, field: null, f: { type: '', node: '', hmin: '', hmax: '', bad: false }, loaded: '', tour: null, timer: 0, anim: 0 };
    let root = null;

    const dec = (hex, extraCh) => { const o = k.decodeOpts(); return D.decode(hex, Object.assign({}, o, extraCh ? { channels: (o.channels || []).concat(extraCh) } : {})); };
    const time = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // ---- capture
    function feed(ev) {
      if (!ev || !ev.raw) return;
      if (st.paused) { st.dropped++; soon(); return; }
      const hex = D.hex(ev.raw);
      st.buf.push({ t: Date.now(), snr: ev.snr, rssi: ev.rssi, hex, d: dec(hex) });
      if (st.buf.length > CAP) st.buf.splice(0, st.buf.length - CAP);
      soon();
    }
    const soon = () => { if (!st.timer && root && !root.closest('[hidden]')) st.timer = setTimeout(() => { st.timer = 0; renderList(); renderBar(); }, 300); };

    // ---- filters
    function match(p) {
      const d = p.d, f = st.f;
      if (f.type && d.typeName !== f.type) return false;
      if (f.bad && !d.mismatch) return false;
      if (f.hmin !== '' && !(d.hops >= +f.hmin)) return false;
      if (f.hmax !== '' && !(d.hops <= +f.hmax)) return false;
      if (f.node) {
        const q = f.node.toLowerCase(), i = d.info || {};
        const hay = [d.summary, (d.path || []).join(' '), i.src, i.dest, i.sender, i.advert && i.advert.name, i.advert && i.advert.key].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }

    // ---- save / load
    function download(name, text, type) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    function saveJson() {
      download(`meshcore-capture-${stamp()}.json`, JSON.stringify({ format: 'kelly-meshcore-capture', version: 1, saved: new Date().toISOString(),
        note: 'Raw MeshCore packets (Packet::writeTo bytes) as heard by the companion. Channel keys are never saved.',
        packets: st.buf.map(p => ({ t: p.t, snr: p.snr, rssi: p.rssi, hex: p.hex })) }, null, 1), 'application/json');
    }
    function saveHex() {
      download(`meshcore-capture-${stamp()}.txt`, `# Kelly Page MeshCore capture, ${new Date().toISOString()}\n# time snr rssi raw-packet-hex\n`
        + st.buf.map(p => `${new Date(p.t).toISOString()} ${p.snr ?? '-'} ${p.rssi ?? '-'} ${p.hex}`).join('\n') + '\n', 'text/plain');
    }
    // JSON from saveJson (or a bare [{hex}] list), or text lines whose last word is the packet's hex
    function parseCapture(text) {
      text = String(text || '').trim();
      if (/^[[{]/.test(text)) {
        const j = JSON.parse(text), list = Array.isArray(j) ? j : j.packets || [];
        return list.filter(p => p && /^[0-9a-f]{4,}$/i.test(p.hex || '')).map(p => ({ t: p.t || Date.now(), snr: p.snr ?? null, rssi: p.rssi ?? null, hex: p.hex.toLowerCase() }));
      }
      const out = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || line.startsWith('#')) continue;
        const w = line.trim().split(/\s+/), h = w[w.length - 1];
        if (!/^[0-9a-f]{4,}$/i.test(h)) continue;
        const t = w.length >= 4 ? Date.parse(w[0]) : NaN, num = x => x === '-' || x == null || isNaN(+x) ? null : +x;
        out.push({ t: isNaN(t) ? Date.now() : t, snr: w.length >= 4 ? num(w[1]) : null, rssi: w.length >= 4 ? num(w[2]) : null, hex: h.toLowerCase() });
      }
      return out;
    }
    function load(file) {
      const r = new FileReader();
      r.onload = () => {
        let list;
        try { list = parseCapture(r.result); } catch (e) { return k.toast('🔬', 'Not a capture file', e.message, 'bad'); }
        if (!list.length) return k.toast('🔬', 'No packets in that file', 'Expected a Kelly capture (.json) or lines ending in packet hex', 'warn');
        st.buf = list.slice(-CAP).map(p => Object.assign(p, { d: dec(p.hex) }));
        st.paused = true; st.loaded = `${file.name} (${list.length} packet${list.length === 1 ? '' : 's'})`; st.sel = null;
        render();
      };
      r.readAsText(file);
    }

    // ---- guided tour: a demo repeater advert and a channel message on a tour-only channel (key = sha256('#kelly-tour'))
    const TOUR_CH = { name: '#kelly-tour', secret: D.sha256(new TextEncoder().encode('#kelly-tour')).subarray(0, 16) };
    function tourPackets() {
      const u32 = (a, v) => a.push(v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255);
      // ADVERT, flood, v1, 2 hops of 2-byte hashes; demo key + signature bytes (a real one would be Ed25519)
      const adv = [(4 << 2) | 1, (1 << 6) | 2, 0xa3, 0xf0, 0x5e, 0x12];
      for (let i = 0; i < 32; i++) adv.push((0x4b + i * 37) & 255);
      u32(adv, Math.floor(Date.UTC(2026, 9, 24, 8, 0) / 1000));
      for (let i = 0; i < 64; i++) adv.push((i * 53 + 7) & 255);
      adv.push(0x02 | 0x10 | 0x80); u32(adv, -27470000); u32(adv, 153020000);
      for (const c of new TextEncoder().encode('Kelly Tour Rptr')) adv.push(c);
      // GRP_TXT, flood, 1 hop: [channel hash][MAC 2][AES(ts, type 0, "VK4XXX: Hello mesh!")]
      const plain = [], body = new TextEncoder().encode('VK4XXX: Hello mesh! This is the Kelly guided tour.');
      u32(plain, Math.floor(Date.UTC(2026, 9, 24, 8, 1) / 1000)); plain.push(0); plain.push(...body);
      const enc = D.encryptThenMac(TOUR_CH.secret, Uint8Array.from(plain));
      const grp = [(5 << 2) | 1, (1 << 6) | 1, 0xa3, 0xf0, D.channelHash(TOUR_CH.secret), ...enc];
      return [{ title: 'An advert', intro: 'Every node shouts "here I am" now and then: an advert. Repeaters pass it on, so the whole mesh learns the node\'s name, key and (if it shares it) location. Let\'s take one apart, byte by byte.', hex: D.hex(Uint8Array.from(adv)) },
        { title: 'A channel message', intro: 'Now a message on a channel. It\'s encrypted with the channel\'s key -- this tour lends Kelly the key for its pretend channel "#kelly-tour", the same way your node lends Kelly the keys of YOUR channels.', hex: D.hex(Uint8Array.from(grp)) }];
    }
    function tourStart() {
      const steps = [];
      for (const s of tourPackets()) {
        const d = dec(s.hex, [TOUR_CH]);
        steps.push({ hex: s.hex, d, title: s.title, text: s.intro, field: null });
        d.fields.forEach((f, i) => steps.push({ hex: s.hex, d, title: `${s.title}: ${f.label}`, text: f.explain, field: i, value: f.value }));
      }
      steps.push({ hex: steps[steps.length - 1].hex, d: steps[steps.length - 1].d, title: 'That\'s it!', text: 'Every packet on the list above can be opened the same way: tap a coloured block to see what it is. Red blocks with ⚠️ are path hashes of the wrong size for this network -- the "Hash size check" below says who and how to fix it.', field: null });
      st.tour = { steps, i: 0 }; renderDetail();
    }

    // ---- drawing
    function render() {
      if (!root) return;
      root.innerHTML = `<div class="mca">
        <div class="card"><div class="card-h"><h2>🔬 MeshCore Analyser</h2><span class="tag" id="mca-state">live</span></div>
          <p class="dim small">Every packet your MeshCore companion hears, taken apart byte by byte. Encrypted messages stay encrypted -- only <b>your</b> channels are decoded, with the keys your node holds.</p>
          <div class="mca-bar" id="mca-bar"></div></div>
        <div class="mca-main">
          <div class="card"><div class="card-h"><h2>Packets</h2><span class="mca-count" id="mca-count"></span></div><div class="mca-list" id="mca-list"></div></div>
          <div class="card" id="mca-detail"></div>
        </div>
        <div class="card mca-hc" id="mca-hc"></div>
      </div>`;
      renderBar(); renderList(); renderDetail(); renderChecks();
    }
    function renderBar() {
      const bar = $('#mca-bar'); if (!bar) return;
      const f = st.f, types = Object.values(D.TYPES);
      const s = $('#mca-state'); if (s) { s.textContent = st.loaded ? 'file' : st.paused ? 'paused' : 'live'; }
      if (!bar.dataset.built) {
        bar.dataset.built = '1';
        bar.innerHTML = `<button class="btn" id="mca-pause"></button><button class="btn ghost" id="mca-clear">🧹 Clear</button>
          <label class="fld"><span>Type</span><select id="mca-ftype"><option value="">All</option>${types.map(t => `<option value="${t}">${esc(D.FRIENDLY[t] || t)}</option>`).join('')}</select></label>
          <label class="fld"><span>Node / hash</span><input id="mca-fnode" size="12" placeholder="name or ab12"></label>
          <label class="fld"><span>Hops</span><span class="row gap"><input id="mca-fhmin" type="number" min="0" max="63" placeholder="min"><input id="mca-fhmax" type="number" min="0" max="63" placeholder="max"></span></label>
          <label class="fld inline"><input type="checkbox" id="mca-fbad"> <span>Wrong hash size only</span></label>
          <span class="grow"></span>
          <button class="btn ghost" id="mca-savej" title="Save the capture as JSON (raw hex inside)">💾 JSON</button><button class="btn ghost" id="mca-saveh" title="Save as text: one packet\'s hex per line">💾 Hex</button>
          <label class="btn ghost" title="Load a saved capture to look at again">📂 Load<input type="file" id="mca-load" accept=".json,.txt,.hex,text/plain,application/json" hidden></label>
          <button class="btn primary" id="mca-tour">🎓 Guided tour</button>
          <div class="mca-note" id="mca-note" style="flex-basis:100%"></div>`;
        $('#mca-pause').onclick = () => { st.paused = !st.paused; if (!st.paused) { st.loaded = ''; st.dropped = 0; } renderBar(); };
        $('#mca-clear').onclick = () => { st.buf = []; st.sel = null; st.loaded = ''; st.dropped = 0; renderList(); renderDetail(); renderBar(); };
        $('#mca-ftype').onchange = e => { f.type = e.target.value; renderList(); };
        $('#mca-fnode').oninput = e => { f.node = e.target.value.trim(); renderList(); };
        $('#mca-fhmin').oninput = e => { f.hmin = e.target.value; renderList(); };
        $('#mca-fhmax').oninput = e => { f.hmax = e.target.value; renderList(); };
        $('#mca-fbad').onchange = e => { f.bad = e.target.checked; renderList(); };
        $('#mca-savej').onclick = () => st.buf.length ? saveJson() : k.toast('🔬', 'Nothing captured yet', '', 'warn');
        $('#mca-saveh').onclick = () => st.buf.length ? saveHex() : k.toast('🔬', 'Nothing captured yet', '', 'warn');
        $('#mca-load').onchange = e => { const fl = e.target.files && e.target.files[0]; if (fl) load(fl); e.target.value = ''; };
        $('#mca-tour').onclick = tourStart;
      }
      $('#mca-pause').textContent = st.paused ? '▶ Resume capture' : '⏸ Pause';
      const note = $('#mca-note');
      note.textContent = st.loaded ? `Showing ${st.loaded} -- live capture is paused; Resume goes back to live.` : st.paused && st.dropped ? `Paused: ${st.dropped} packet${st.dropped === 1 ? '' : 's'} not captured.` : '';
    }
    function renderList() {
      const box = $('#mca-list'); if (!box) return;
      const rows = [];
      for (let i = st.buf.length - 1; i >= 0 && rows.length < LIST_MAX; i--) if (match(st.buf[i])) rows.push(i);
      const c = $('#mca-count'); if (c) c.textContent = `${rows.length}${rows.length >= LIST_MAX ? '+' : ''} shown · ${st.buf.length} captured`;
      if (!rows.length) { box.innerHTML = `<div class="mca-empty">${st.buf.length ? 'No packets match the filters.' : 'Waiting for packets… Connect a MeshCore node on the Mesh tab (or its Demo), or press 🎓 Guided tour.'}</div>`; return; }
      box.innerHTML = `<table><thead><tr><th>Time</th><th>What</th><th>Hops</th><th>Hash</th><th>Detail</th><th>SNR</th></tr></thead><tbody>${rows.map(i => {
        const p = st.buf[i], d = p.d;
        return `<tr data-i="${i}" class="${st.sel === i ? 'sel' : ''}"><td>${time(p.t)}</td><td>${esc(d.friendly || d.typeName || '?')}<br><small class="dim">${esc(d.routeName || '')}</small></td><td>${d.hops ?? ''}</td>`
          + `<td>${d.hashSize ? `<span class="mca-hs${d.mismatch ? ' bad' : ''}">${d.mismatch ? '⚠️ ' : ''}${d.hashSize}B</span>` : ''}</td><td class="sum">${esc(d.ok ? d.summary : `⚠️ ${d.err}`)}</td><td>${p.snr != null ? `${p.snr} dB` : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
      box.querySelectorAll('tr[data-i]').forEach(tr => { tr.onclick = () => { st.sel = +tr.dataset.i; st.field = null; st.tour = null; renderList(); renderDetail(true); }; });
    }
    function strip(d, on, tourField) {
      return `<div class="mca-strip">${d.fields.map((f, i) => {
        const short = f.len > 6 ? f.hex.slice(0, 8) + '…' : f.hex;
        return `<button class="mca-blk mca-g-${f.group}${f.warn ? ' warn' : ''}${on === i ? ' on' : ''}${tourField === i ? ' tour' : ''}" data-f="${i}" style="flex:${Math.max(1, Math.round(Math.sqrt(f.len) * 3))} 1 0" title="${esc(f.label)}: ${f.len} byte${f.len === 1 ? '' : 's'}"><code>${short}</code><span>${esc(f.label)}</span><small>${f.len}B</small></button>`;
      }).join('')}</div>`;
    }
    const legend = d => { const g = [...new Set(d.fields.map(f => f.group))]; return `<div class="mca-legend">${g.map(x => `<span><i class="mca-g-${x}"></i>${esc(D.GROUPS[x] || x)}</span>`).join('')}</div>`; };
    function explainBox(d, i) {
      const f = d.fields[i];
      if (!f) return `<div class="mca-explain"><h4>Tap a block</h4><p>Each coloured block is one field of the packet, sized by how many bytes it takes. Tap one to see what it means.</p></div>`;
      return `<div class="mca-explain${f.warn ? ' warn' : ''}"><h4>${esc(f.label)} <small class="dim">· byte ${f.start}${f.len > 1 ? `–${f.start + f.len - 1}` : ''} · ${f.len} byte${f.len === 1 ? '' : 's'}</small></h4>`
        + `${f.value ? `<div class="val">${esc(f.value)}</div>` : ''}<p>${esc(f.explain || '')}</p></div>`;
    }
    // the hops as a chain: who started it -> each repeater (path hash -> a known node's name) -> this node
    function journey(d) {
      if (!d.ok) return '';
      const i = d.info || {}, hops = d.flood ? (d.path || []) : [];
      const origin = i.advert ? (i.advert.name || i.advert.key.slice(0, 8)) : i.sender || (i.src ? `addr ${i.src}` : d.flood ? 'sender' : null);
      if (!d.flood) return `<div class="mca-journey"><p class="dim small">A direct-routed packet: ${(d.path || []).length ? `the hops still to go are ${esc(d.path.join(' → '))}` : 'it has reached the last hop'}. The journey view draws flood packets, whose path is the trail they have travelled.</p></div>`;
      const pts = [{ label: origin || 'sender', h: '', cls: 'start' }].concat(hops.map(h => { const m = k.byPrefix(h); return { label: m.length ? (m[0].label || m[0].name) + (m.length > 1 ? ` +${m.length - 1}` : '') : 'unknown', h, cls: (m.length ? 'known' : '') + (d.mismatch ? ' warn' : '') }; }))
        .concat([{ label: k.myName() || 'your node', h: '', cls: 'end' }]);
      const W = 1000, n = pts.length, x = j => n === 1 ? W / 2 : 50 + j * (W - 100) / (n - 1), cut = s => s.length > 16 ? s.slice(0, 15) + '…' : s;
      return `<div class="mca-journey"><div class="row gap" style="justify-content:space-between;align-items:center"><b>Journey</b><button class="btn small ghost" id="mca-replay">↻ Replay</button></div>
        <svg viewBox="0 0 ${W} 120" preserveAspectRatio="xMidYMid meet">${pts.slice(1).map((p, j) => `<line data-j="${j}" x1="${x(j)}" y1="44" x2="${x(j + 1)}" y2="44"/>`).join('')}
        ${pts.map((p, j) => `<g class="n ${p.cls}"><circle cx="${x(j)}" cy="44" r="16"/>${p.h ? `<text class="h" x="${x(j)}" y="48">${esc(p.h)}</text>` : ''}<text x="${x(j)}" y="84">${esc(cut(p.label))}</text></g>`).join('')}
        <circle class="dot" id="mca-dot" r="7" cx="${x(0)}" cy="44" opacity="0"/></svg>
        <p class="dim small">${hops.length ? `${hops.length} repeater${hops.length === 1 ? '' : 's'} carried it, each adding its ${d.hashSize}-byte hash. Names come from the nodes your companion knows whose key starts with that hash${d.hashSize === 1 ? ' (with 1-byte hashes several nodes can share one)' : ''}.` : 'Heard straight from the sender: no repeaters in between.'}</p></div>`;
    }
    // the dot travels the chain once, a hop at a time; effects off / reduced motion: the links just light up
    function playJourney() {
      cancelAnimationFrame(st.anim);
      const svg = root && root.querySelector('.mca-journey svg'); if (!svg) return;
      const lines = [...svg.querySelectorAll('line')], dot = svg.querySelector('#mca-dot');
      lines.forEach(l => l.classList.remove('lit'));
      if (!lines.length) return;
      if (!k.fx()) { lines.forEach(l => l.classList.add('lit')); return; }
      const per = 650, t0 = performance.now();
      dot.setAttribute('opacity', '1');
      const step = now => {
        if (!svg.isConnected) return;   // redrawn meanwhile
        const e = Math.max(0, (now - t0) / per), j = Math.min(lines.length - 1, Math.floor(e)), f = Math.min(1, e - j), l = lines[j];   // the first frame can be stamped before t0
        for (let q = 0; q < j; q++) lines[q].classList.add('lit');
        dot.setAttribute('cx', +l.getAttribute('x1') + (l.getAttribute('x2') - l.getAttribute('x1')) * f);
        if (e < lines.length) st.anim = requestAnimationFrame(step); else { l.classList.add('lit'); dot.setAttribute('opacity', '0'); }
      };
      st.anim = requestAnimationFrame(step);
    }
    // ▦ an ADVERT's node as a contact QR (js/meshqr.js): its decoded full key, type 1-4 and name; nothing for other packets
    function advQr(d) {
      const a = d && d.ok && d.typeName === 'ADVERT' && d.info && d.info.advert;
      return a && window.KellyMeshQR && /^[0-9a-f]{64}$/i.test(a.key || '') && a.roleId >= 1 && a.roleId <= 4 ? { key: a.key.toLowerCase(), type: a.roleId, name: a.name || '' } : null;
    }
    function renderDetail(play) {
      const box = $('#mca-detail'); if (!box) return;
      const T = st.tour;
      let d, raw, field = st.field, head = '';
      if (T) {
        const s = T.steps[T.i]; d = s.d; raw = s.hex; field = s.field;
        head = `<div class="mca-tour"><h4>🎓 ${esc(s.title)} <small class="dim">· step ${T.i + 1} of ${T.steps.length}</small></h4>${s.value ? `<div class="mca-raw">${esc(s.value)}</div>` : ''}<p>${esc(s.text)}</p>
          <div class="row gap"><button class="btn small ghost" id="mca-tback" ${T.i ? '' : 'disabled'}>◀ Back</button><button class="btn small primary" id="mca-tnext">${T.i < T.steps.length - 1 ? 'Next ▶' : 'Finish'}</button><button class="btn small ghost" id="mca-texit">✕ Exit tour</button></div></div>`;
      } else if (st.sel != null && st.buf[st.sel]) { d = st.buf[st.sel].d; raw = st.buf[st.sel].hex; }
      if (!d) { box.innerHTML = `<div class="card-h"><h2>Packet</h2></div><p class="dim">Pick a packet on the list to take it apart -- or press <b>🎓 Guided tour</b> for a step-by-step walk through an advert and a channel message.</p>`; return; }
      box.innerHTML = `<div class="card-h"><h2>Packet</h2><span class="tag">${d.len} bytes</span></div>${head}
        <p class="mca-sum"><b>${esc(d.friendly || d.typeName || '?')}</b> · ${esc(d.routeName || '')}${d.hashSize ? ` · <span class="mca-hs${d.mismatch ? ' bad' : ''}">${d.mismatch ? '⚠️ ' : ''}${d.hashSize}-byte hashes</span>` : ''} — ${esc(d.ok ? d.summary : d.err)}</p>
        ${!T && advQr(d) ? '<p class="mca-qrrow"><button class="btn small ghost" id="mca-qr" title="The advertised node as a MeshCore contact QR">▦ Show this node&#39;s QR</button></p>' : ''}
        ${d.mismatch ? `<div class="mca-explain warn"><h4>⚠️ Wrong path hash size</h4><p>This packet was started with ${d.hashSize}-byte path hashes, but this network expects ${k.hash.expected()}-byte. The Hash size check below shows who sent it and how to fix it.</p></div>` : ''}
        ${strip(d, field, T ? field : null)}${legend(d)}${T ? '' : explainBox(d, field)}${journey(d)}
        <details><summary class="small">All fields</summary><table class="mca-fields">${d.fields.map(f => `<tr class="${f.warn ? 'warn' : ''}"><td>${esc(f.label)}</td><td>${f.start}</td><td>${f.len}</td><td class="hex">${esc(f.hex)}</td><td>${esc(f.value)}</td></tr>`).join('')}</table>
          <p class="mca-raw">${esc(raw)}</p></details>`;
      box.querySelectorAll('.mca-blk').forEach(b => { b.onclick = () => { if (st.tour) return; st.field = +b.dataset.f; renderDetail(); }; });
      const rp = $('#mca-replay'); if (rp) rp.onclick = playJourney;
      const qb = $('#mca-qr'); if (qb) qb.onclick = () => { const q = advQr(d); if (q) try { window.KellyMeshQR.ui({ toast: k.toast }).show({ contact: q, note: 'From the advert this node sent (key, type and name). Scan it with the MeshCore app (or Kelly) to add it.' }); } catch (e) { console.warn('mca qr', e); } };
      if (T) {
        $('#mca-tback').onclick = () => { T.i = Math.max(0, T.i - 1); renderDetail(T.steps[T.i].field == null); };
        $('#mca-tnext').onclick = () => { if (T.i < T.steps.length - 1) { T.i++; renderDetail(T.steps[T.i].field == null); } else { st.tour = null; renderDetail(); } };
        $('#mca-texit').onclick = () => { st.tour = null; renderDetail(); };
      }
      if (play) playJourney();
    }
    // nodes on the wrong path hash size, the expected size, the log
    function renderChecks() {
      const box = $('#mca-hc'); if (!box) return;
      const exp = k.hash.expected(), list = k.hash.nodes().filter(n => n.expected === exp && n.size !== exp), log = k.hash.log();
      box.innerHTML = `<div class="card-h"><h2>⚠️ Path hash size check</h2><span class="tag">${list.length ? `${list.length} node${list.length === 1 ? '' : 's'}` : 'all good'}</span></div>
        <p class="dim small">MeshCore puts each packet's hash size in its path length byte, chosen by the node that sent it. Kelly checks every advert and message it hears (replies are left out: they copy the asker's size). Brisbane/SEQ (MBUG) asks for 2-byte.</p>
        <div class="row gap wrap" style="align-items:flex-end"><label class="fld"><span>This network expects</span><select id="mca-exp">${[1, 2, 3].map(v => `<option value="${v}" ${v === exp ? 'selected' : ''}>${v}-byte hashes${v === 2 ? ' (MBUG)' : ''}</option>`).join('')}</select></label>
          <label class="fld inline"><input type="checkbox" id="mca-p25" ${k.hash.p25.on() ? 'checked' : ''}> <span>Also text my P25 radio (once a day per node)</span></label>
          <button class="btn small ghost" id="mca-logj">📄 Log (JSON)</button><button class="btn small ghost" id="mca-logc">📄 Log (CSV)</button><button class="btn small ghost" id="mca-hclear">🧹 Clear</button><span class="small dim">${log.length} event${log.length === 1 ? '' : 's'} logged</span></div>
        ${list.length ? `<table><thead><tr><th>Node</th><th>Sends</th><th>Expected</th><th>Last seen</th><th>Evidence</th></tr></thead><tbody>${list.map(n => `<tr><td><b>${esc(n.name)}</b>${n.role ? ` <small class="dim">${esc(n.role)}</small>` : ''}<div class="fix">${esc(k.hash.hint(n))}</div></td><td><span class="mca-hs bad">${n.size}B</span></td><td>${n.expected}B</td><td>${esc(k.fmtAgo(n.last))}<br><small class="dim">${n.count}×</small></td><td>${n.strength === 'certain' ? '✔ certain (advert)' : 'likely'}<br><small class="dim">${esc(n.type)}</small></td></tr>`).join('')}</tbody></table>` : '<p class="small">No node heard so far uses a different size. 👍</p>'}`;
      $('#mca-exp').onchange = e => { k.hash.setExpected(+e.target.value); st.buf.forEach(p => { p.d = dec(p.hex); }); render(); };
      $('#mca-p25').onchange = e => k.hash.p25.set(e.target.checked);
      $('#mca-logj').onclick = () => download(`meshcore-hash-log-${stamp()}.json`, JSON.stringify(k.hash.log(), null, 1), 'application/json');
      $('#mca-logc').onclick = () => download(`meshcore-hash-log-${stamp()}.csv`, 'time,node,id,sent,expected,evidence,type,hops,snr,rssi,path,raw\n'
        + k.hash.log().map(e => [new Date(e.t).toISOString(), e.name, e.id, e.size, e.expected, e.strength, e.type, e.hops, e.snr ?? '', e.rssi ?? '', (e.path || []).join(' '), e.hex].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n') + '\n', 'text/csv');
      $('#mca-hclear').onclick = () => { if (confirm('Clear the list of nodes and the hash size log?')) { k.hash.clear(); renderChecks(); } };
    }

    return {
      init() { root = document.getElementById('mca-root'); render(); },
      feed,
      shown() { renderList(); renderBar(); renderChecks(); },
      refreshChecks() { renderChecks(); },
      _parse: parseCapture, _tour: tourPackets, _state: st,   // tests
    };
  };
})();
