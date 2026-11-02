/* Kelly Page -- P25X Transfer (Kelly Share): files up to 5 MB over P25, moved overnight.
 *
 * The library lives on the P25X gateway (dashboard share.js, Tools > Kelly Share there). By day this page asks for the
 * list, queues a download, or offers a file to send -- a second of air each. The files move in the night window
 * (22:00-05:00 by default) in 48 kB pieces, and the gateway runs the show both ways:
 *   download  the gateway pushes each piece (KF kind 1 model SHARE) -> filed here (IndexedDB) -> joined + SHA-256
 *             checked when the last one lands -> "ready" with a Save button in the morning
 *   upload    the gateway pulls each piece ({app:'share', c:'pull', up, i}) -> this page answers with KF kind 1 model
 *             SHAREUP from the file the user queued
 * Protocol = the block at the top of the dashboard's share.js -- keep in step. Pieces carry their own header
 * ('S' 'H' 01 | metaLen | meta JSON | bytes) so whichever Kelly is on the radio at 2 am can file them.
 * The station store: a Kelly on a Kelly bridge (a Pi) also keeps files in the bridge's /api/share-store,
 * so what the Pi's keeper (headless, its own storage) fetches overnight is in the PC's Kelly in the morning, and what
 * the PC queues to send is there for the keeper to answer the pulls with. On a PC with no bridge: leave Kelly open.
 *
 * window.KellyShareUI(ctx) -> { init, render, shown, gatewayReply, piece, ownsXid, kfEvent }; ctx from app.js.
 */
(function () {
  'use strict';
  const MB = 1048576;
  // ---- SHA-256: crypto.subtle where the browser allows it, else this (Kelly from the Pi over plain http)
  const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
    0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256js(data) {
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    const len = data.length, total = Math.ceil((len + 9) / 64) * 64, last = new Uint8Array(total - Math.floor(len / 64) * 64);
    last.set(data.subarray(Math.floor(len / 64) * 64)); last[len % 64] = 0x80;
    const bits = len * 8, lv = new DataView(last.buffer); lv.setUint32(last.length - 4, bits >>> 0); lv.setUint32(last.length - 8, Math.floor(bits / 2 ** 32));
    const full = Math.floor(len / 64), dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let b = 0; b < full + last.length / 64; b++) {
      const v = b < full ? dv : lv, o = b < full ? b * 64 : (b - full) * 64;
      for (let i = 0; i < 16; i++) w[i] = v.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
      let [a, bb, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0, t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    return Array.from(h, x => x.toString(16).padStart(8, '0')).join('');
  }
  async function sha256(data) {
    if (window.crypto && crypto.subtle) try { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), x => x.toString(16).padStart(2, '0')).join(''); } catch {}
    return sha256js(data);
  }
  // ---- a piece: 'S' 'H' 01 | metaLen(2 BE) | meta JSON | bytes  (= dashboard share.js packPiece)
  function packPiece(meta, data) {
    const j = new TextEncoder().encode(JSON.stringify(meta)), out = new Uint8Array(5 + j.length + data.length);
    out.set([0x53, 0x48, 1, j.length >> 8, j.length & 255], 0); out.set(j, 5); out.set(data, 5 + j.length);
    return out;
  }
  function unpackPiece(b) {
    if (b.length < 5 || b[0] !== 0x53 || b[1] !== 0x48 || b[2] !== 1) throw new Error('not a Kelly Share piece');
    const n = (b[3] << 8) | b[4];
    return { meta: JSON.parse(new TextDecoder().decode(b.subarray(5, 5 + n))), data: b.subarray(5 + n) };
  }

  window.KellyShareUI = function (k) {
    const { $, esc, store, toast, addEvent, dirty } = k;
    const s = Object.assign({ list: [], cfg: null, mine: { jobs: [], ups: [] }, at: 0, ups: {}, files: {}, dls: {} }, store.get('share', {}) || {});
    const persist = () => { if (mode !== 'demo') store.set('share', s); };
    const ui = { ask: null, queue: [], err: '', pick: null, pickErr: '', busy: '' };
    const kB = n => n >= MB ? `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;
    const cfg = () => s.cfg || { win: ['22:00', '05:00'], max: 5 * MB, seg: 48 * 1024, rate: 380, approve: true };
    const airH = (b, up) => { const h = b / cfg().rate / 3600 / (up ? 0.5 : 1); return h < 1 ? `~${Math.max(1, Math.round(h * 60))} min` : `~${h.toFixed(1)} h`; };
    const eta = n => n == null ? '' : n === 0 ? 'tonight' : n === 1 ? 'tomorrow night' : `in ${n} nights`;
    let mode = 'real';
    function ensureMode() { const m = k.demo() ? 'demo' : 'real'; if (m !== mode) { mode = m; ui.queue = []; ui.ask = null; } }

    // ------------------------------------------------------------------ storage: this browser (IndexedDB) + the station's bridge
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('kelly-share', 1); r.onupgradeneeded = () => r.result.createObjectStore('b'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    async function idb(modeRW, fn) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction('b', modeRW), q = fn(tx.objectStore('b')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); }
    const station = () => { const b = k.bridgeBase && k.bridgeBase(); return b && mode !== 'demo' ? b : null; };   // {base, token} or null
    const surl = (key) => { const b = station(); return `${b.base}/api/share-store${key ? '/' + key : ''}${b.token ? '?token=' + encodeURIComponent(b.token) : ''}`; };
    async function put(key, data) {
      if (mode === 'demo') { demoMem.set(key, data); return; }
      await idb('readwrite', st => st.put(data, key));
      if (station()) try { await fetch(surl(key), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data }); } catch {}
    }
    async function get(key) {
      if (mode === 'demo') return demoMem.get(key) || null;
      const v = await idb('readonly', st => st.get(key)).catch(() => null);
      if (v) return v;
      if (station()) try { const r = await fetch(surl(key), { cache: 'no-store' }); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch {}
      return null;
    }
    async function del(key) {
      if (mode === 'demo') { demoMem.delete(key); return; }
      await idb('readwrite', st => st.delete(key)).catch(() => {});
      if (station()) try { await fetch(surl(key), { method: 'DELETE' }); } catch {}
    }
    const demoMem = new Map();

    // ------------------------------------------------------------------ requests (one on the air at a time)
    function ask(obj, label, onAnswer) { ui.queue.push({ obj, label, onAnswer }); next(); }
    async function next() {
      ensureMode();
      if (ui.ask || !ui.queue.length) return;
      if (mode === 'demo') { const q = ui.queue.shift(), xid = -Date.now(); ui.ask = { ...q, xid }; dirty('share'); setTimeout(() => { if (ui.ask && ui.ask.xid === xid) gatewayReply({ app: 'share', ...demoGw(q.obj) }); }, 1800); return; }
      if (!k.radioConnected()) { ui.err = 'Connect the radio first -- Admin › Connect'; ui.queue = []; dirty('share'); return; }
      if (k.rfBusy()) { setTimeout(next, 3000); return; }
      const q = ui.queue.shift(); ui.err = ''; ui.ask = { ...q, at: Date.now() };
      const xid = await k.kfRequest({ op: 'share', ...q.obj }, q.label);
      if (!xid) { ui.ask = null; ui.err = 'Could not send the request'; dirty('share'); return; }
      ui.ask.xid = xid; dirty('share');
    }
    function kfEvent(e) {
      if (!ui.ask) return;
      if (e.kind === 'tx-done') { const xid = ui.ask.xid; setTimeout(() => { if (ui.ask && ui.ask.xid === xid) { ui.err = 'The gateway took the request but never answered -- try again'; ui.ask = null; dirty('share'); next(); } }, 90000); }
      else if (e.kind === 'tx-failed') { ui.err = e.cancelled ? '' : 'No answer from the P25X gateway'; ui.ask = null; next(); }
      dirty('share');
    }
    function gatewayReply(j) {
      ensureMode();
      if (j.c === 'pull') { answerPull(j); return; }
      const a = ui.ask; ui.ask = null;
      if (j.error) { ui.err = j.error; toast('📦', 'Kelly Share', j.error, 'bad'); }
      else {
        if (j.cfg) s.cfg = j.cfg;
        if (j.files) s.list = j.files.map(f => ({ id: f[0], name: f[1], size: f[2], by: f[3], at: f[4] * 1000, desc: f[5], n: f[6], pending: !!f[7] }));
        if (j.mine) s.mine = j.mine;
        if (j.c === 'list') s.at = Date.now();
        persist();
        if (a && a.onAnswer) try { a.onAnswer(j); } catch (e) { console.error('share', e); }
      }
      dirty('share'); setTimeout(next, 800);
    }

    // ------------------------------------------------------------------ the night: pieces in, pulls answered
    // A download piece (KF kind 1 model SHARE): file it; the last one joins the file and checks it.
    async function piece(f) {
      ensureMode();
      let p; try { p = unpackPiece(f.body); } catch (e) { addEvent('error', `Kelly Share: ${e.message}`); return; }
      const m = p.meta, d = s.dls[m.sha256] || (s.dls[m.sha256] = { name: m.name, size: m.size, n: m.n, f: m.f, j: m.j, have: [], at: Date.now() });
      await put(`seg-${m.sha256.slice(0, 24)}-${m.i}`, p.data);
      if (!d.have.includes(m.i)) d.have.push(m.i);
      d.last = Date.now(); persist(); dirty('share');
      if (d.have.length >= d.n) await assemble(m.sha256);
    }
    async function assemble(hash) {
      const d = s.dls[hash]; if (!d) return;
      const parts = [];
      for (let i = 0; i < d.n; i++) { const b = await get(`seg-${hash.slice(0, 24)}-${i}`); if (!b) { d.have = d.have.filter(x => x !== i); persist(); return; } parts.push(b); }
      const all = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let o = 0; for (const b of parts) { all.set(b, o); o += b.length; }
      if (all.length !== d.size || await sha256(all) !== hash) { addEvent('error', `Kelly Share: ${d.name} failed its check -- the gateway sends it again`); d.have = []; persist(); return; }
      await put(`file-${hash.slice(0, 24)}`, all);
      for (let i = 0; i < d.n; i++) await del(`seg-${hash.slice(0, 24)}-${i}`);
      s.files[hash] = { name: d.name, size: d.size, at: Date.now(), f: d.f }; delete s.dls[hash]; persist();
      addEvent('data', `Kelly Share: ${d.name} (${kB(d.size)}) arrived and checked`);
      toast('📦', `${d.name} has arrived`, `${kB(d.size)} over P25 overnight -- every byte checked. P25X Transfer › Save`, 'good', () => k.showPage('share'));
      dirty('share');
    }
    // the gateway asks for piece i of an upload we queued
    async function answerPull(j, tries = 0) {
      const data = await get(`up-${String(j.sha256).slice(0, 24)}`);
      if (!data) { addEvent('error', `Kelly Share: asked for ${j.up} piece ${j.i + 1}, but this Kelly doesn't have that file any more`); return; }
      if (mode !== 'demo' && k.rfBusy()) { if (tries < 12) setTimeout(() => answerPull(j, tries + 1), 5000); return; }
      const seg = j.seg || cfg().seg, part = data.subarray(j.i * seg, Math.min(data.length, (j.i + 1) * seg));
      const u = Object.values(s.ups).find(x => x.up === j.up); if (u) { u.sent = Math.max(u.sent || 0, j.i + 1); u.last = Date.now(); persist(); }
      if (mode === 'demo') { demoUpGot(j, part); dirty('share'); return; }
      await k.kfSendFile({ kind: 1, model: 'SHAREUP', name: `${j.up}:${j.i}`, body: packPiece({ u: j.up, i: j.i, sha256: j.sha256 }, part) }, `Kelly Share: piece ${j.i + 1} of ${u ? u.name : j.up}`);
      dirty('share');
    }

    // ------------------------------------------------------------------ user actions
    const refresh = () => ask({ c: 'list' }, 'Kelly Share: the library', null);
    function want(id) {
      const f = s.list.find(x => x.id === id); if (!f) return;
      ask({ c: 'want', id }, `Kelly Share: queue ${f.name}`, j => { toast('🌙', `${f.name} queued`, `${kB(f.size)}, ${airH(f.size)} on air -- ${eta(j.eta)}. Leave Kelly on the radio overnight.`, 'good'); refreshMine(); });
    }
    const refreshMine = () => ask({ c: 'status' }, 'Kelly Share: my transfers', null);
    async function offer() {
      const f = ui.pick; if (!f) return;
      const desc = ($('#sh-desc').value || '').trim().slice(0, 200);
      ui.busy = `Checking ${f.name}…`; dirty('share');
      const data = new Uint8Array(await f.arrayBuffer()), hash = await sha256(data);
      await put(`up-${hash.slice(0, 24)}`, data);
      s.ups[hash] = { name: f.name, size: data.length, desc, at: Date.now(), sha256: hash }; persist();
      ui.busy = '';
      ask({ c: 'offer', name: f.name, size: data.length, sha256: hash, desc }, `Kelly Share: send ${f.name}`, j => {
        s.ups[hash].up = j.up; s.ups[hash].nseg = j.nseg; persist();
        toast('🌙', `${f.name} will go tonight`, `${kB(data.length)}, ${airH(data.length, true)} of air with rests -- ${eta(j.eta)}${cfg().approve ? '. The sysop approves it before others see it.' : ''}`, 'good');
        ui.pick = null; $('#sh-file').value = ''; $('#sh-desc').value = ''; refreshMine();
      });
      dirty('share');
    }
    function cancel(kind, id) { ask(kind === 'job' ? { c: 'cancel', job: id } : { c: 'cancel', up: id }, 'Kelly Share: cancel', () => refreshMine()); }
    async function save(hash) {
      const f = s.files[hash]; if (!f) return;
      const data = await get(`file-${hash.slice(0, 24)}`);
      if (!data) { toast('📦', `${f.name} isn't here any more`, 'It may have been removed from the station store', 'bad'); return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data])); a.download = f.name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      f.saved = Date.now(); persist(); dirty('share');
    }
    async function forget(hash) { await del(`file-${hash.slice(0, 24)}`); delete s.files[hash]; persist(); dirty('share'); }
    // files the Pi's keeper fetched while the PC was off: on the station store, not yet in this browser's list
    async function pickupStation() {
      if (!station() || k.keeper) return;
      try {
        const items = await fetch(surl(''), { cache: 'no-store' }).then(r => r.ok ? r.json() : []);
        const meta = await fetch(surl('index.json'), { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
        let n = 0;
        for (const [hash, f] of Object.entries((meta && meta.files) || {})) if (!s.files[hash] && items.some(x => x.key === `file-${hash.slice(0, 24)}`)) { s.files[hash] = f; n++; }
        if (n) { persist(); toast('📦', `${n} file${n === 1 ? '' : 's'} arrived overnight`, 'Fetched by the Pi while the PC was off -- P25X Transfer › Save', 'good', () => k.showPage('share')); dirty('share'); }
      } catch {}
    }
    // the keeper tells the station store what it has (so the PC's Kelly can list it)
    async function publishStation() {
      if (!station() || !k.keeper) return;
      try { await fetch(surl('index.json'), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: JSON.stringify({ files: s.files, at: Date.now() }) }); } catch {}
    }

    // ------------------------------------------------------------------ demo: a small make-believe library, a fast "night"
    let demoDb = null;
    function demoGw(o) {
      if (!demoDb) demoDb = { files: [['f1', 'VK4 repeater map.pdf', 1.8 * MB | 0, 'VK4XXX', Date.now() / 1000 - 86400 | 0, 'Every VK4 repeater on one page', 7, 0],
        ['f2', 'Club meeting minutes Oct.docx', 210 * 1024, 'VK4ZB', Date.now() / 1000 - 3600 | 0, 'October meeting', 3, 0],
        ['f3', 'TM9100 programming guide.pdf', 4.6 * MB | 0, 'VK4ZQ', Date.now() / 1000 - 7 * 86400 | 0, 'Tait TM9100 how-to', 12, 0]], jobs: [], ups: [], n: 1 };
      const mine = () => ({ jobs: demoDb.jobs.map(j => [j.id, j.f, j.name, j.size, j.done, j.nseg, j.done >= j.nseg ? 'done' : 'queued', 0]), ups: demoDb.ups.map(u => [u.id, u.name, u.size, u.got, u.nseg, u.got >= u.nseg ? 'done' : 'queued', 0]) });
      const c = { win: ['22:00', '05:00'], max: 5 * MB, seg: 48 * 1024, rate: 380, approve: true };
      if (o.c === 'list' || o.c === 'status') return { c: 'list', files: demoDb.files, cfg: c, mine: mine() };
      if (o.c === 'want') { const f = demoDb.files.find(x => x[0] === o.id); const j = { id: `j${demoDb.n++}`, f: f[0], name: f[1], size: Math.min(f[2], 150 * 1024), nseg: 3, done: 0 }; demoDb.jobs.push(j); demoNight(j); return { c: 'queued', job: j.id, eta: 0, nseg: j.nseg }; }
      if (o.c === 'offer') { const u = { id: `u${demoDb.n++}`, name: o.name, size: o.size, sha256: o.sha256, nseg: Math.max(1, Math.ceil(o.size / (48 * 1024))), got: 0 }; demoDb.ups.push(u); setTimeout(() => demoPull(u), 4000); return { c: 'offered', up: u.id, nseg: u.nseg, seg: 48 * 1024, eta: 0 }; }
      if (o.c === 'cancel') return { c: 'cancelled' };
      return { c: o.c, error: 'Unknown request' };
    }
    // the demo's "night" runs in seconds: a made-up file arrives piece by piece
    async function demoNight(j) {
      const body = new TextEncoder().encode(`Demo file "${j.name}" from the Kelly Share demo library.\n`.repeat(2000)).subarray(0, j.size);
      const hash = await sha256(body);
      for (let i = 0; i < j.nseg; i++) {
        await new Promise(r => setTimeout(r, 2500));
        if (mode !== 'demo') return;
        const seg = Math.ceil(body.length / j.nseg), part = body.subarray(i * seg, Math.min(body.length, (i + 1) * seg));
        j.done = i + 1;
        await piece({ body: packPiece({ f: j.f, j: j.id, i, n: j.nseg, size: body.length, sha256: hash, name: j.name.replace(/\.\w+$/, '.txt') }, part) });
      }
    }
    function demoPull(u) { if (u.got < u.nseg && mode === 'demo') answerPull({ c: 'pull', up: u.id, i: u.got, sha256: u.sha256, seg: 48 * 1024, size: u.size }); }
    function demoUpGot(j, part) { const u = demoDb.ups.find(x => x.id === j.up); if (!u) return; u.got = j.i + 1; if (u.got < u.nseg) setTimeout(() => demoPull(u), 2500); else { refreshMine(); toast('📤', `${u.name} sent (demo)`, 'Waiting for the sysop to approve it', 'good'); } }

    // ------------------------------------------------------------------ render
    function render() {
      ensureMode();
      const page = $('#page-share'); if (!page || k.currentPage() !== 'share') return;
      const c = cfg(), ready = Object.entries(s.files);
      $('#sh-when').textContent = s.at ? `library checked ${k.fmtAgo(s.at)}` : 'library not checked yet';
      $('#sh-win').textContent = `🌙 Files move ${c.win[0]}–${c.win[1]}`;
      $('#sh-sync').textContent = ui.ask ? (ui.ask.label || 'Asking…') : '📡 Get the library';
      $('#sh-sync').disabled = !!ui.ask;
      $('#sh-err').hidden = !ui.err; $('#sh-err').textContent = ui.err;
      $('#sh-station').textContent = station() ? (k.keeper ? '🍓 This is the Pi keeper: files it fetches go to the station store for the PC.' : '🍓 On a Kelly bridge: files fetched overnight by the Pi are here in the morning.')
        : '💻 No bridge: leave this Kelly open, on the radio, overnight.';
      const jobs = s.mine.jobs || [], ups = s.mine.ups || [];
      $('#sh-lib').innerHTML = s.list.map(f => {
        const j = jobs.find(x => x[1] === f.id && x[6] !== 'cancelled'), have = Object.values(s.files).some(x => x.f === f.id);
        return `<li><span class="sh-ic">${/\.(jpe?g|png|gif|webp)$/i.test(f.name) ? '🖼️' : /\.pdf$/i.test(f.name) ? '📕' : /\.(zip|7z|rar)$/i.test(f.name) ? '🗜️' : '📄'}</span>
          <span class="sh-txt"><b>${esc(f.name)}${f.pending ? ' <em class="sh-pend">waiting for approval</em>' : ''}</b><small>${kB(f.size)} · ${airH(f.size)} on air · from ${esc(f.by || '?')} · ${k.fmtAgo(f.at)}${f.n ? ` · ${f.n} got it` : ''}</small>${f.desc ? `<small class="sh-desc">${esc(f.desc)}</small>` : ''}</span>
          ${have ? '<span class="tag good">✓ have it</span>' : j ? `<span class="tag">${j[6] === 'done' ? '✓ delivered' : `🌙 ${eta(j[7]) || 'queued'}`}</span>` : f.pending ? '' : `<button class="btn primary small" data-want="${esc(f.id)}">🌙 Get it tonight</button>`}</li>`;
      }).join('') || `<li class="dim small">${s.at ? 'The library is empty.' : 'Press 📡 Get the library -- a second or two of air.'}</li>`;
      // downloads: arriving + ready
      const arriving = Object.entries(s.dls).map(([h, d]) => `<li><span class="sh-ic">📥</span><span class="sh-txt"><b>${esc(d.name)}</b><small>${d.have.length}/${d.n} pieces · ${kB(d.size)}${d.last ? ` · last piece ${k.fmtAgo(d.last)}` : ''}</small><i class="sh-bar"><i style="width:${Math.round(d.have.length / d.n * 100)}%"></i></i></span></li>`);
      const waiting = jobs.filter(j => j[6] !== 'done' && j[6] !== 'cancelled' && !Object.values(s.dls).some(d => d.j === j[0]) && !Object.values(s.files).some(f => f.f === j[1])).map(j => `<li><span class="sh-ic">🌙</span><span class="sh-txt"><b>${esc(j[2])}</b><small>${kB(j[3])} · ${j[4]}/${j[5]} pieces · ${j[6] === 'waiting' ? 'trying again tomorrow night' : eta(j[7]) || 'queued'}</small></span><button class="btn ghost small" data-cancel-job="${esc(j[0])}">✕</button></li>`);
      const done = ready.sort((a, b) => b[1].at - a[1].at).map(([h, f]) => `<li><span class="sh-ic">📦</span><span class="sh-txt"><b>${esc(f.name)}</b><small>${kB(f.size)} · arrived ${k.fmtAgo(f.at)}${f.saved ? ' · saved' : ''}</small></span><button class="btn primary small" data-save="${h}">💾 Save</button><button class="btn ghost small" data-forget="${h}" title="Remove from Kelly">🗑</button></li>`);
      $('#sh-dl').innerHTML = [...done, ...arriving, ...waiting].join('') || '<li class="dim small">Nothing yet -- pick a file from the library.</li>';
      // uploads
      $('#sh-up').innerHTML = ups.filter(u => u[5] !== 'cancelled').map(u => `<li><span class="sh-ic">${u[5] === 'done' ? '✅' : '📤'}</span><span class="sh-txt"><b>${esc(u[1])}</b><small>${kB(u[2])} · ${u[3]}/${u[4]} pieces · ${u[5] === 'done' ? (c.approve ? 'sent -- waiting for the sysop to approve it' : 'sent -- in the library') : u[5] === 'waiting' ? 'trying again tomorrow night' : eta(u[6]) || 'queued'}</small><i class="sh-bar"><i style="width:${Math.round(u[3] / u[4] * 100)}%"></i></i></span>${u[5] !== 'done' ? `<button class="btn ghost small" data-cancel-up="${esc(u[0])}">✕</button>` : ''}</li>`).join('')
        || '<li class="dim small">Nothing sent yet.</li>';
      const p = ui.pick;
      $('#sh-pick').textContent = ui.busy || (p ? `📎 ${p.name} · ${kB(p.size)} · ${airH(p.size, true)} of air with the radio resting between pieces${p.size > 2.5 * MB ? ' (likely two nights)' : ''}` : ui.pickErr ? `⚠️ ${ui.pickErr}` : `Up to ${kB(c.max)}. It goes out overnight, a piece at a time.`);
      $('#sh-pick').classList.toggle('bad', !p && !!ui.pickErr);
      $('#sh-send').disabled = !p || !!ui.busy;
    }

    function init() {
      $('#sh-sync').onclick = () => { refresh(); };
      $('#sh-file').onchange = e => {
        const f = e.target.files && e.target.files[0]; ui.pick = null; ui.pickErr = '';
        if (f && f.size > cfg().max) { ui.pickErr = `${f.name} is ${kB(f.size)} -- Kelly Share takes up to ${kB(cfg().max)}`; e.target.value = ''; }
        else if (f && !f.size) { ui.pickErr = `${f.name} is empty`; e.target.value = ''; }
        else if (f) ui.pick = f;
        dirty('share');
      };
      $('#sh-send').onclick = () => offer();
      $('#page-share').onclick = e => {
        const w = e.target.closest('[data-want]'); if (w) { want(w.dataset.want); return; }
        const sv = e.target.closest('[data-save]'); if (sv) { save(sv.dataset.save); return; }
        const fg = e.target.closest('[data-forget]'); if (fg && confirm('Remove this file from Kelly? (It stays in the library.)')) { forget(fg.dataset.forget); return; }
        const cj = e.target.closest('[data-cancel-job]'); if (cj && confirm('Cancel this download?')) { cancel('job', cj.dataset.cancelJob); return; }
        const cu = e.target.closest('[data-cancel-up]'); if (cu && confirm('Cancel sending this file?')) cancel('up', cu.dataset.cancelUp);
      };
      if (k.keeper) setInterval(publishStation, 60000);
    }
    function shown() { ensureMode(); pickupStation(); if (!s.at || Date.now() - s.at > 6 * 3600000) { if (k.radioConnected()) setTimeout(refresh, 800); } dirty('share'); }
    return { init, render, shown, gatewayReply, piece: async f => { await piece(f); if (k.keeper) publishStation(); }, kfEvent, ownsXid: xid => !!(ui.ask && ui.ask.xid === xid) };
  };
  window.KellyShareUI.sha256js = sha256js;   // tests
  window.KellyShareUI.packPiece = packPiece;
})();
