/* Kelly Page -- LoRa Mesh > Packet Journey: live stats, leaderboard, charts and the chat / advert ticker
 * (2026-10-24, unreleased). Coded against js/pj-core.js only -- see PACKET_JOURNEY_PLAN.md row 3.
 *
 * window.KellyPJStats(mount, c, tickerMount) -> { destroy() }
 *   mount        #pj-stats (full width, below the canvas): tiles + cards
 *   tickerMount  #pj-ticker (thin strip under the canvas): decoded chat + first adverts, newest first, last 20
 * window.KellyPJStats.createAgg(KINDS) -> the pure aggregator (also module.exports.createAgg in Node, for tests).
 *
 * Two stat sets: live (persisted to store('pjStats'), debounced 10 s + on hide) and demo (ev.demo, session only).
 * The demo set is shown while the shell says demo is on, live otherwise; a tag says which. Ids are folded with
 * c.reg.canonical() at draw time (and when saving). Redraw <= 1/s and only while c.visible(); nothing loops: the
 * tiles count up once per change, ticker items slide in once. Saved copy capped at ~150 KB (see compact()).
 * Most heard stations: a "hams only" toggle (off by default, store 'pjStatsHams') shows only stations
 * window.KellyHamCalls.hamOf calls a ham (ham: true); hidden when KellyHamCalls is missing. A view filter only --
 * nothing counted changes, no XP (AWARDS_REVIEW.md M5).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.KellyPJStats = api.mount; root.KellyPJStats.createAgg = api.createAgg; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1, MAX_ST = 250, MAX_REL = 250, MAX_SIG = 60, MAX_TICK = 20, MAX_SEEN = 400, MINUTES = 60, HOPS = 9;
  const SAVE_CAP = 150000;   // bytes of JSON; the per-station signal series are trimmed until it fits

  // ============================================================ pure aggregation (no DOM)
  function createAgg(KINDS) {
    const NK = KINDS.length, zeros = () => new Array(NK).fill(0);
    const kidx = k => { const i = KINDS.indexOf(k); return i < 0 ? NK - 1 : i; };
    const skip = id => !id || id === 'me' || id === 'unknown';
    const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;

    function empty() {
      return { t0: Date.now(), total: 0, kinds: zeros(), flood: 0, direct: 0, enc: 0, dec: 0, hops: new Array(HOPS).fill(0),
        mins: {}, recent: [], st: {}, rel: {}, seen: [], tick: [] };
    }
    function station(set, id, t) {
      let s = set.st[id];
      if (!s) s = set.st[id] = { n: 0, k: zeros(), br: null, bs: null, last: 0, first: t, name: '', sig: [] };
      return s;
    }
    function evict(map, max, score) {
      const ids = Object.keys(map); if (ids.length <= max) return;
      ids.sort((a, b) => score(map[a]) - score(map[b]));
      for (const id of ids.slice(0, ids.length - max)) delete map[id];
    }
    function pushTick(set, item) { set.tick.push(item); if (set.tick.length > MAX_TICK) set.tick.splice(0, set.tick.length - MAX_TICK); }

    // -> the new ticker item (or null) so the view can slide it in
    function add(set, ev) {
      if (!ev) return null;
      const t = num(ev.t) || Date.now(), k = kidx(ev.kind), snr = num(ev.snr), rssi = num(ev.rssi);
      set.total++; set.kinds[k]++;
      if (ev.ok === false) { /* undecodable: no real route or hop count */ }
      else if (ev.route === 'flood') { set.flood++; set.hops[Math.min(HOPS - 1, Math.max(0, ev.hops | 0))]++; } else set.direct++;
      if (ev.decrypted) set.dec++; else if (ev.encrypted) set.enc++;
      const m = Math.floor(t / 60000), mk = String(m);
      (set.mins[mk] || (set.mins[mk] = zeros()))[k]++;
      for (const key of Object.keys(set.mins)) if (+key <= m - MINUTES) delete set.mins[key];
      set.recent.push(t); while (set.recent.length && (set.recent[0] < t - 60000 || set.recent.length > 3000)) set.recent.shift();
      // origin station: count, best signal, last heard, kind mix
      const src = ev.src && ev.src.id;
      if (!skip(src)) {
        const s = station(set, src, t);
        s.n++; s.k[k]++; s.last = Math.max(s.last, t);
        if (ev.src.name) s.name = String(ev.src.name).slice(0, 40);
        if (snr != null && (s.bs == null || snr > s.bs)) s.bs = snr;
        if (rssi != null && (s.br == null || rssi > s.br)) s.br = rssi;
      }
      // signal series: how WE heard the transmitter we heard (the last repeater, else the origin)
      const hf = ev.heardFrom;
      if (!skip(hf) && (snr != null || rssi != null)) {
        const s = station(set, hf, t);
        if (!s.n && !s.name) { const p = ev.src && ev.src.id === hf ? ev.src.name : ''; if (p) s.name = String(p).slice(0, 40); }
        s.sig.push([Math.round(t / 1000), snr, rssi]); if (s.sig.length > MAX_SIG) s.sig.splice(0, s.sig.length - MAX_SIG);
        if (!s.n) s.last = Math.max(s.last, t);
      }
      // repeaters: every hash a flood packet came through
      if (ev.route === 'flood' && Array.isArray(ev.journey)) for (const id of ev.journey.slice(1, -1)) if (!skip(id)) set.rel[id] = (set.rel[id] || 0) + 1;
      evict(set.st, MAX_ST, s => s.n * 1e13 + s.last);
      evict(set.rel, MAX_REL, n => n);
      // ticker: decoded channel text, and the first advert from a key
      let item = null;
      if (ev.text) item = { t, c: 1, s: String(ev.sender || '').slice(0, 40), ch: String(ev.channel || '').slice(0, 30), x: String(ev.text).slice(0, 200), id: src || null };
      else if (ev.advert && ev.advert.key) {
        const kp = String(ev.advert.key).slice(0, 12).toLowerCase();
        if (!set.seen.includes(kp)) {
          set.seen.push(kp); if (set.seen.length > MAX_SEEN) set.seen.shift();
          item = { t, a: 1, s: String(ev.advert.name || '').slice(0, 40) || kp.slice(0, 8), r: ev.advert.role != null ? String(ev.advert.role).slice(0, 20) : '', g: ev.gps ? 1 : 0, id: src || null };
        }
      }
      // a flood is heard once per repeater that passes it on: the same sender + text within 5 min is one ticker line
      if (item && item.c && set.tick.some(o => o.c && o.s === item.s && o.ch === item.ch && o.x === item.x && t - o.t < 300e3)) item = null;
      if (item) pushTick(set, item);
      return item;
    }

    // merge entries whose ids now fold to one node
    function fold(set, canon) {
      const cn = id => { try { return (canon && canon(id)) || id; } catch { return id; } };
      const st = {}, rel = {};
      for (const [id0, s] of Object.entries(set.st)) {
        const id = cn(id0), o = st[id];
        if (!o) { st[id] = Object.assign({}, s, { k: s.k.slice(), sig: s.sig.slice() }); continue; }
        o.n += s.n; for (let i = 0; i < NK; i++) o.k[i] += s.k[i] || 0;
        o.br = o.br == null ? s.br : s.br == null ? o.br : Math.max(o.br, s.br);
        o.bs = o.bs == null ? s.bs : s.bs == null ? o.bs : Math.max(o.bs, s.bs);
        o.last = Math.max(o.last, s.last); o.first = Math.min(o.first, s.first); if (!o.name) o.name = s.name;
        o.sig = o.sig.concat(s.sig).sort((a, b) => a[0] - b[0]).slice(-MAX_SIG);
      }
      for (const [id0, n] of Object.entries(set.rel)) { const id = cn(id0); rel[id] = (rel[id] || 0) + n; }
      return { st, rel };
    }

    function view(set, canon, now) {
      now = now || Date.now();
      const { st, rel } = fold(set, canon);
      const board = Object.entries(st).filter(([, s]) => s.n > 0).map(([id, s]) => Object.assign({ id }, s)).sort((a, b) => b.n - a.n || b.last - a.last);
      const rels = Object.entries(rel).map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n);
      const uniq = new Set(board.map(b => b.id)); for (const r of rels) uniq.add(r.id);
      const m = Math.floor(now / 60000), mins = [];
      for (let i = MINUTES - 1; i >= 0; i--) mins.push((set.mins[String(m - i)] || zeros()).slice());
      const sigs = Object.entries(st).filter(([, s]) => s.sig.length).map(([id, s]) => ({ id, name: s.name, n: s.sig.length, sig: s.sig })).sort((a, b) => b.n - a.n);
      return {
        total: set.total, kinds: set.kinds.slice(), flood: set.flood, direct: set.direct,
        perMin: set.recent.filter(t => t > now - 60000).length,
        unique: uniq.size, busiest: rels[0] || null, rels,
        decPct: set.dec + set.enc ? Math.round(100 * set.dec / (set.dec + set.enc)) : null, dec: set.dec, enc: set.enc,
        hops: set.hops.slice(), mins, board, sigs, tick: set.tick.slice(), t0: set.t0,
      };
    }

    // the saved copy: folded, bounded; the signal series go first when it's too big
    function compact(set, canon) {
      const { st, rel } = fold(set, canon);
      const out = Object.assign({}, set, { st, rel, recent: set.recent.slice(-200) });
      let keep = 40;
      for (;;) {
        const ranked = Object.keys(st).sort((a, b) => (st[b].n + st[b].sig.length) - (st[a].n + st[a].sig.length));
        const st2 = {};
        ranked.forEach((id, i) => { st2[id] = i < keep ? st[id] : Object.assign({}, st[id], { sig: [] }); });
        out.st = st2;
        const len = JSON.stringify(out).length;
        if (len <= SAVE_CAP || keep === 0) return out;
        keep = Math.floor(keep / 2);
        if (keep === 0) {   // still too big: drop the least-heard stations
          const ids = ranked.slice(Math.floor(ranked.length / 2)); for (const id of ids) delete st[id];
        }
      }
    }

    // a saved copy -> a set, or null when it doesn't look like one of ours
    function restore(o) {
      if (!o || typeof o !== 'object' || !Array.isArray(o.kinds) || o.kinds.length !== NK) return null;
      const s = Object.assign(empty(), o);
      if (!Array.isArray(s.hops) || s.hops.length !== HOPS) s.hops = new Array(HOPS).fill(0);
      for (const k of ['recent', 'seen', 'tick']) if (!Array.isArray(s[k])) s[k] = [];
      for (const k of ['mins', 'st', 'rel']) if (!s[k] || typeof s[k] !== 'object') s[k] = {};
      for (const [id, e] of Object.entries(s.st)) if (!e || !Array.isArray(e.k) || !Array.isArray(e.sig)) delete s.st[id];
      return s;
    }

    return { empty, add, view, compact, restore, fold };
  }

  // ============================================================ the view
  function mount(mountEl, c, tickerEl) {
    const PJ = c.PJ, KINDS = PJ.KINDS, PAL = PJ.PALETTE, A = createAgg(KINDS);
    const esc = c.esc || (s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
    const fmtAgo = c.fmtAgo || (t => Math.round((Date.now() - t) / 1000) + 's ago');
    const canon = id => (c.reg && c.reg.canonical ? c.reg.canonical(id) : id);
    const nodeOf = id => { try { return c.reg && c.reg.get ? c.reg.get(id) : null; } catch { return null; } };

    let live = A.empty(), demo = A.empty(), showDemo = false, sel = null, sigPick = null;
    try { const o = c.store && c.store.get('pjStats', null); if (o && o.v === VERSION) live = A.restore(o.live) || live; } catch (e) { console.warn('pj-stats restore', e); }
    const cur = () => showDemo ? demo : live;

    // ---------------------------------------------------------- skeleton
    const TILES = [['total', 'Packets', 'heard so far'], ['rate', 'Packets / min', 'last 60 s'], ['uniq', 'Stations', 'unique, origin + repeaters'],
      ['busy', 'Busiest repeater', 'most path appearances'], ['flood', 'Flood / direct', ''], ['dec', 'Decrypted', 'of encrypted packets']];
    mountEl.innerHTML = `<div class="pj-stats-wrap">
      <div class="pj-stats-top"><h2 class="pj-stats-title">📊 Live stats</h2><span class="tag" data-r="set">live</span><span class="pj-stats-since" data-r="since"></span></div>
      <div class="pj-stats-tiles">${TILES.map(([k, h, s]) => `<div class="pj-stats-tile pj-stats-t-${k}"><span class="pj-stats-tl">${h}</span>
        <b class="pj-stats-tv" data-t="${k}">0</b><small class="pj-stats-ts" data-s="${k}">${s}</small>${k === 'flood' ? '<div class="pj-stats-split" data-r="split"><i></i><i></i></div>' : ''}</div>`).join('')}</div>
      <div class="pj-stats-grid">
        <div class="card pj-stats-board"><div class="card-h"><h2>🏆 Most heard stations</h2><span class="tag" data-r="bcount">0</span>
          <label class="pj-stats-hams" data-r="hamsBox" hidden title="Show only licensed hams' stations (callsign from the directory, your own mapping, or the node name)" style="margin-left:auto;font-size:.85em;white-space:nowrap;cursor:pointer"><input type="checkbox" data-r="hams"> 📻 hams only</label></div>
          <div class="pj-stats-tbl"><table><thead><tr><th>#</th><th>Station</th><th>Pkts</th><th>Best RSSI</th><th>Best SNR</th><th>Last heard</th><th>Mix</th></tr></thead><tbody data-r="board"></tbody></table></div></div>
        <div class="card pj-stats-donut"><div class="card-h"><h2>🍩 Packet kinds</h2></div><div class="pj-stats-dwrap"><canvas data-c="donut"></canvas><ul class="pj-stats-dleg" data-r="dleg"></ul></div></div>
        <div class="card pj-stats-time"><div class="card-h"><h2>⏱ Packets per minute</h2><span class="tag">last 60 min</span></div><canvas data-c="time"></canvas></div>
        <div class="card pj-stats-hops"><div class="card-h"><h2>🪜 Hops travelled</h2><span class="tag" data-r="hnote">flood</span></div><div class="pj-stats-hist" data-r="hist"></div></div>
        <div class="card pj-stats-sig"><div class="card-h"><h2>📶 Signal</h2><label class="pj-stats-pick"><select data-r="pick"></select></label></div>
          <canvas data-c="sig"></canvas><div class="pj-stats-sleg"><span class="pj-stats-snr">● SNR dB</span><span class="pj-stats-rssi">● RSSI dBm</span><span class="dim" data-r="sigNote"></span></div></div>
      </div></div>`;
    const R = n => mountEl.querySelector(`[data-r="${n}"]`), CV = n => mountEl.querySelector(`[data-c="${n}"]`);
    if (tickerEl) tickerEl.innerHTML = '<div class="pj-tick"><span class="pj-tick-h">ON AIR</span><ul class="pj-tick-list"></ul></div>';
    const tickList = tickerEl && tickerEl.querySelector('.pj-tick-list');

    // ---------------------------------------------------------- helpers
    const short = id => !id ? '?' : id.startsWith('h:') ? id.slice(2) + '…' : id.startsWith('n:') ? id.slice(2) : id.slice(0, 8) + '…';
    const nameOf = (id, fallback) => { const n = nodeOf(id); return (n && n.name) || fallback || short(id); };
    const roleIcon = id => { const n = nodeOf(id), r = n && n.role; return r === 'repeater' ? '📡' : r === 'room server' ? '🏠' : r === 'sensor' ? '🌡' : r === 'companion' ? '📱' : ''; };
    const f1 = x => x == null ? '–' : (Math.round(x * 10) / 10).toString();
    function canvas(cv, h) {
      const w = Math.max(10, cv.clientWidth || cv.parentNode.clientWidth || 300), dpr = Math.min(3, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); return { g, w, h };
    }
    const css = n => { try { return getComputedStyle(mountEl).getPropertyValue(n).trim(); } catch { return ''; } };

    // ---------------------------------------------------------- tiles (count up once per change)
    const shown = {}, target = {};
    let anim = 0;
    function setTile(k, v, fmt) {
      target[k] = { v, fmt };
      if (!(k in shown) || !c.fx || !c.fx() || typeof v !== 'number' || shown[k] == null) { shown[k] = v; paintTile(k); return; }
      if (!anim) { const t0 = performance.now(), from = Object.assign({}, shown); anim = requestAnimationFrame(function step(now) {
        const p = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - p, 3);
        for (const kk of Object.keys(target)) { const tv = target[kk].v; if (typeof tv === 'number' && typeof from[kk] === 'number') shown[kk] = p >= 1 ? tv : from[kk] + (tv - from[kk]) * e; else shown[kk] = tv; paintTile(kk); }
        anim = p < 1 ? requestAnimationFrame(step) : 0;
      }); }
    }
    function paintTile(k) {
      const el = mountEl.querySelector(`[data-t="${k}"]`); if (!el) return;
      const t = target[k], v = shown[k];
      el.textContent = t.fmt ? t.fmt(v) : (typeof v === 'number' ? Math.round(v).toLocaleString() : (v == null ? '–' : String(v)));
    }

    // ---------------------------------------------------------- draw
    function draw() {
      const V = A.view(cur(), canon);
      const setTag = R('set'); setTag.textContent = showDemo ? 'demo' : 'live'; setTag.className = 'tag ' + (showDemo ? 'warn' : 'ok');
      R('since').textContent = V.total ? 'since ' + new Date(V.t0).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'no packets yet';
      setTile('total', V.total); setTile('rate', V.perMin); setTile('uniq', V.unique);
      setTile('busy', V.busiest ? nameOf(V.busiest.id) : '–'); mountEl.querySelector('[data-s="busy"]').textContent = V.busiest ? `${V.busiest.n.toLocaleString()} relays` : 'no repeated packets yet';
      const fd = V.flood + V.direct, fp = fd ? Math.round(100 * V.flood / fd) : null;
      setTile('flood', fp, x => x == null ? '–' : `${Math.round(x)}%`); mountEl.querySelector('[data-s="flood"]').textContent = fd ? `${V.flood.toLocaleString()} flood · ${V.direct.toLocaleString()} direct` : 'flood share';
      const sp = R('split').children; sp[0].style.width = (fp || 0) + '%'; sp[1].style.width = (fd ? 100 - fp : 0) + '%';
      setTile('dec', V.decPct, x => x == null ? '–' : `${Math.round(x)}%`); mountEl.querySelector('[data-s="dec"]').textContent = V.dec + V.enc ? `${V.dec} of ${V.dec + V.enc} encrypted` : 'of encrypted packets';
      drawBoard(V); drawDonut(V); drawTime(V); drawHist(V); drawSig(V);
    }
    // hams only (Ham Contacts' window.KellyHamCalls; may be missing -> the toggle hides)
    const HAMS = () => { const K = typeof window !== 'undefined' && window.KellyHamCalls; return K && typeof K.hamOf === 'function' ? K : null; };
    const ROLE_TYPE = { companion: 1, repeater: 2, 'room server': 3, sensor: 4 };
    let hamsOnly = false;
    try { hamsOnly = !!(c.store && c.store.get('pjStatsHams', false)); } catch { hamsOnly = false; }
    function isHam(id) {
      const K = HAMS(), n = nodeOf(id); if (!K || !n) return false;
      try { const h = K.hamOf({ key: n.key, name: n.raw || n.name, type: ROLE_TYPE[n.role] || 0, demo: showDemo }); return !!(h && h.ham === true); } catch { return false; }
    }
    function drawBoard(V) {
      const K = HAMS(), box = R('hamsBox'), cb = R('hams'), only = !!K && hamsOnly;
      if (box) box.hidden = !K; if (cb) cb.checked = only;
      const list = only ? V.board.filter(s => isHam(s.id)) : V.board;
      R('bcount').textContent = only ? `${list.length} ham${list.length === 1 ? '' : 's'} of ${V.board.length}` : V.board.length + ' stations';
      const selC = sel && canon(sel);
      R('board').innerHTML = list.slice(0, 12).map((s, i) => {
        const tot = s.k.reduce((a, b) => a + b, 0) || 1;
        const mix = s.k.map((n, j) => n ? `<i style="width:${(100 * n / tot).toFixed(1)}%;background:${PAL[KINDS[j]].color}" title="${esc(PAL[KINDS[j]].label)}: ${n}"></i>` : '').join('');
        return `<tr data-id="${esc(s.id)}" class="${s.id === selC ? 'pj-stats-sel' : ''}"><td class="pj-stats-rk">${i + 1}</td>
          <td class="pj-stats-nm"><span>${roleIcon(s.id)} ${esc(nameOf(s.id, s.name))}</span></td><td class="pj-stats-n">${s.n.toLocaleString()}</td>
          <td>${s.br == null ? '–' : esc(f1(s.br))}</td><td>${s.bs == null ? '–' : esc(f1(s.bs))}</td><td class="pj-stats-ago">${esc(fmtAgo(s.last))}</td>
          <td><div class="pj-stats-mix">${mix}</div></td></tr>`;
      }).join('') || (only && V.board.length ? '<tr><td colspan="7" class="pj-stats-empty">No hams among the stations heard yet -- untick "hams only" to see them all.</td></tr>'
        : '<tr><td colspan="7" class="pj-stats-empty">No stations heard yet -- the leaderboard fills as packets arrive.</td></tr>');
    }
    function drawDonut(V) {
      const cv = CV('donut'), size = 170, { g } = canvas(cv, size), w = cv.clientWidth || size;
      const cx = Math.min(w, size) / 2, cy = size / 2, r = size / 2 - 8, tot = V.kinds.reduce((a, b) => a + b, 0);
      g.lineWidth = 22; g.lineCap = 'butt';
      if (!tot) { g.strokeStyle = 'rgba(131,148,184,.25)'; g.beginPath(); g.arc(cx, cy, r - 11, 0, Math.PI * 2); g.stroke(); }
      let a = -Math.PI / 2;
      V.kinds.forEach((n, i) => {
        if (!n) return; const da = Math.PI * 2 * n / tot, p = PAL[KINDS[i]];
        g.strokeStyle = p.color; g.shadowColor = p.color; g.shadowBlur = 10;
        g.beginPath(); g.arc(cx, cy, r - 11, a, a + da - (tot > n ? 0.02 : 0)); g.stroke(); a += da;
      });
      g.shadowBlur = 0; g.fillStyle = css('--text') || '#e8f1ff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `700 24px ${css('--display') || 'sans-serif'}`; g.fillText(tot.toLocaleString(), cx, cy - 6);
      g.font = `600 11px ${css('--mono') || 'monospace'}`; g.fillStyle = css('--dim') || '#8394b8'; g.fillText('PACKETS', cx, cy + 16);
      R('dleg').innerHTML = KINDS.map((k, i) => `<li><i style="background:${PAL[k].color};box-shadow:0 0 8px ${PAL[k].color}"></i><span>${esc(PAL[k].label)}</span><b>${V.kinds[i].toLocaleString()}</b><small>${tot ? Math.round(100 * V.kinds[i] / tot) : 0}%</small></li>`).join('');
    }
    function drawTime(V) {
      const { g, w, h } = canvas(CV('time'), 170), padL = 30, padB = 18, padT = 8, cw = w - padL - 4, ch = h - padB - padT;
      const max = Math.max(1, ...V.mins.map(m => m.reduce((a, b) => a + b, 0)));
      const top = niceMax(max), mono = css('--mono') || 'monospace', dim = css('--dim') || '#8394b8';
      g.strokeStyle = 'rgba(131,148,184,.15)'; g.lineWidth = 1; g.font = `600 10px ${mono}`; g.fillStyle = dim; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (const f of [0, 0.5, 1]) { const y = padT + ch - ch * f; g.beginPath(); g.moveTo(padL, y + .5); g.lineTo(w - 4, y + .5); g.stroke(); g.fillText(String(Math.round(top * f)), padL - 4, y); }
      const bw = cw / V.mins.length;
      V.mins.forEach((m, i) => {
        let y = padT + ch; const x = padL + i * bw;
        m.forEach((n, j) => { if (!n) return; const bh = ch * n / top; g.fillStyle = PAL[KINDS[j]].color; g.fillRect(x + 0.5, y - bh, Math.max(1, bw - 1.5), bh); y -= bh; });
      });
      g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = dim;
      g.fillText('-60m', padL + 14, h - 4); g.fillText('-30m', padL + cw / 2, h - 4); g.textAlign = 'right'; g.fillText('now', w - 4, h - 4);
    }
    function niceMax(m) { const p = Math.pow(10, Math.floor(Math.log10(m))); for (const s of [1, 2, 5, 10]) if (s * p >= m) return s * p; return m; }
    function drawHist(V) {
      const max = Math.max(1, ...V.hops), tot = V.hops.reduce((a, b) => a + b, 0);
      R('hnote').textContent = `${tot.toLocaleString()} flood · ${V.direct.toLocaleString()} direct`;
      R('hist').innerHTML = V.hops.map((n, i) => `<div class="pj-stats-hb" title="${i === HOPS - 1 ? HOPS - 1 + '+' : i} hops: ${n}">
        <b>${n ? n.toLocaleString() : ''}</b><i style="height:${(100 * n / max).toFixed(1)}%;--hue:${Math.round(190 - i * 22)}"></i><span>${i === HOPS - 1 ? (HOPS - 1) + '+' : i}</span></div>`).join('');
    }
    let pickKey = '';
    function drawSig(V) {
      const pick = R('pick'), opts = V.sigs.slice(0, 20);
      const want = (sigPick && opts.some(o => o.id === canon(sigPick))) ? canon(sigPick) : (V.board.find(b => opts.some(o => o.id === b.id)) || opts[0] || {}).id || '';
      const key = opts.map(o => o.id + '|' + nameOf(o.id, o.name)).join(',');
      if (key !== pickKey) { pickKey = key; pick.innerHTML = opts.length ? opts.map(o => `<option value="${esc(o.id)}">${esc(nameOf(o.id, o.name))} (${o.n})</option>`).join('') : '<option value="">no signal reports yet</option>'; }
      if (pick.value !== want) pick.value = want;
      const s = opts.find(o => o.id === want), { g, w, h } = canvas(CV('sig'), 160), padL = 30, padR = 36, padT = 8, padB = 18;
      const mono = css('--mono') || 'monospace', dim = css('--dim') || '#8394b8';
      g.font = `600 10px ${mono}`; g.fillStyle = dim;
      R('sigNote').textContent = s ? `heard from ${nameOf(s.id, s.name)} -- last ${s.sig.length}` : '';
      if (!s) { g.textAlign = 'center'; g.fillText('Signal reports appear as packets arrive', w / 2, h / 2); return; }
      const pts = s.sig, t0 = pts[0][0], t1 = Math.max(t0 + 1, pts[pts.length - 1][0]), cw = w - padL - padR, ch = h - padT - padB;
      const snrs = pts.map(p => p[1]).filter(x => x != null), rss = pts.map(p => p[2]).filter(x => x != null);
      const sl = snrs.length ? Math.floor(Math.min(-5, ...snrs) / 5) * 5 : -20, sh = snrs.length ? Math.ceil(Math.max(5, ...snrs) / 5) * 5 : 15;
      const rl = rss.length ? Math.floor(Math.min(...rss) / 10) * 10 - 10 : -130, rh = rss.length ? Math.ceil(Math.max(...rss) / 10) * 10 + 10 : -40;
      const X = t => padL + cw * (pts.length === 1 ? 0.5 : (t - t0) / (t1 - t0));
      g.strokeStyle = 'rgba(131,148,184,.15)'; g.lineWidth = 1; g.textBaseline = 'middle';
      for (const f of [0, 0.5, 1]) {
        const y = padT + ch - ch * f; g.beginPath(); g.moveTo(padL, y + .5); g.lineTo(w - padR, y + .5); g.stroke();
        g.textAlign = 'right'; g.fillStyle = PAL.chat.color; g.fillText(String(Math.round(sl + (sh - sl) * f)), padL - 4, y);
        g.textAlign = 'left'; g.fillStyle = PAL.advert.color; g.fillText(String(Math.round(rl + (rh - rl) * f)), w - padR + 4, y);
      }
      const line = (idx, lo, hi, col) => {
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2; g.shadowColor = col; g.shadowBlur = 6; g.beginPath(); let on = false;
        for (const p of pts) { if (p[idx] == null) continue; const x = X(p[0]), y = padT + ch - ch * (p[idx] - lo) / (hi - lo); if (on) g.lineTo(x, y); else { g.moveTo(x, y); on = true; } }
        g.stroke(); g.shadowBlur = 0;
        for (const p of pts) { if (p[idx] == null) continue; g.beginPath(); g.arc(X(p[0]), padT + ch - ch * (p[idx] - lo) / (hi - lo), 2.2, 0, Math.PI * 2); g.fill(); }
      };
      line(2, rl, rh, PAL.advert.color); line(1, sl, sh, PAL.chat.color);
      g.fillStyle = dim; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
      const hm = t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      g.fillText(hm(t0), padL, h - 4); g.textAlign = 'right'; g.fillText(hm(t1), w - padR, h - 4);
    }

    // ---------------------------------------------------------- ticker
    function tickHtml(it) {
      const tm = new Date(it.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (it.c) return `<li class="pj-tick-chat"${it.id ? ` data-id="${esc(it.id)}"` : ''}><time>${tm}</time>${it.ch ? `<em>${esc(it.ch)}</em>` : ''}<b>${esc(it.s || '?')}</b><span>${esc(it.x)}</span></li>`;
      return `<li class="pj-tick-adv"${it.id ? ` data-id="${esc(it.id)}"` : ''}><time>${tm}</time><em>NEW</em><b>${esc(it.s)}</b><span>${esc(it.r || 'node')}${it.g ? ' · 📍 GPS' : ''}</span></li>`;
    }
    function tickAll() {
      if (!tickList) return;
      const items = cur().tick.slice().reverse();
      tickList.innerHTML = items.map(tickHtml).join('') || '<li class="pj-tick-idle">Decoded channel chat and newly heard stations scroll in here.</li>';
    }
    function tickAdd(it) {
      if (!tickList) return;
      const idle = tickList.querySelector('.pj-tick-idle'); if (idle) idle.remove();
      tickList.insertAdjacentHTML('afterbegin', tickHtml(it));
      if (c.visible() && (!c.fx || c.fx())) tickList.firstElementChild.classList.add('pj-tick-new');
      while (tickList.children.length > MAX_TICK) tickList.lastElementChild.remove();
    }

    // ---------------------------------------------------------- scheduling (<= 1/s, visible only, no idle loop)
    let timer = 0, idleT = 0, lastDraw = 0, saveT = 0, lastW = 0;
    function want() {
      if (!c.visible() || timer) return;
      timer = setTimeout(drawNow, Math.max(0, 1000 - (Date.now() - lastDraw)));
    }
    function drawNow() {
      clearTimeout(timer); timer = 0; clearTimeout(idleT); idleT = 0;
      if (!c.visible()) return;
      lastDraw = Date.now();
      try { draw(); } catch (e) { console.warn('pj-stats draw', e); }
      // packets/min and "last heard" age while there was recent traffic; stops once it's quiet
      const r = cur().recent; if (r.length && r[r.length - 1] > Date.now() - 65000) idleT = setTimeout(want, 5000);
    }
    function save() {
      clearTimeout(saveT); saveT = 0;
      try { if (c.store) c.store.set('pjStats', { v: VERSION, live: A.compact(live, canon) }); } catch (e) { console.warn('pj-stats save', e); }
    }
    const saveSoon = () => { if (!saveT) saveT = setTimeout(save, 10000); };

    // ---------------------------------------------------------- bus + DOM events
    const safe = fn => x => { try { fn(x); } catch (e) { console.warn('pj-stats', e); } };
    const offs = [
      c.bus.on('packet', safe(ev => {
        if (!ev) return;
        const set = ev.demo ? demo : live, it = A.add(set, ev);
        if (!ev.demo) saveSoon();
        if (set === cur()) { if (it) tickAdd(it); want(); }
      })),
      c.bus.on('nodes', safe(() => want())),
      c.bus.on('select', safe(x => {
        if (!x || x.from === 'stats') return;
        const id = x.node || (x.packet && x.packet.src && x.packet.src.id) || null; if (!id) return;
        sel = id; sigPick = id;
        const cid = canon(id);
        for (const tr of mountEl.querySelectorAll('tbody tr[data-id]')) tr.classList.toggle('pj-stats-sel', tr.dataset.id === cid);
        want();
      })),
      c.bus.on('visible', safe(v => { if (v) drawNow(); else { clearTimeout(timer); timer = 0; clearTimeout(idleT); idleT = 0; if (saveT) save(); } })),
      c.bus.on('reset', safe(() => {
        live = A.empty(); demo = A.empty(); sel = null; sigPick = null; pickKey = '';
        clearTimeout(saveT); saveT = 0; try { if (c.store) c.store.set('pjStats', null); } catch { /* storage off */ }
        tickAll(); if (c.visible()) drawNow();
      })),
      c.bus.on('demo', safe(on => { on = !!on; if (on === showDemo) return; showDemo = on; sel = null; pickKey = ''; tickAll(); if (c.visible()) drawNow(); })),
    ];
    const onClick = e => {
      const tr = e.target.closest && e.target.closest('tr[data-id]'); if (!tr) return;
      sel = tr.dataset.id; sigPick = sel;
      for (const r of mountEl.querySelectorAll('tbody tr[data-id]')) r.classList.toggle('pj-stats-sel', r === tr);
      c.bus.emit('select', { node: sel, from: 'stats' }); want();
    };
    const onPick = e => {
      if (!e.target.matches) return;
      if (e.target.matches('[data-r="pick"]')) { sigPick = e.target.value || null; drawNow(); }
      else if (e.target.matches('[data-r="hams"]')) { hamsOnly = !!e.target.checked; try { if (c.store) c.store.set('pjStatsHams', hamsOnly); } catch { /* storage off */ } drawNow(); }
    };
    const onTick = e => { const li = e.target.closest && e.target.closest('li[data-id]'); if (li) c.bus.emit('select', { node: li.dataset.id, from: 'stats' }); };
    const onHide = () => save();
    mountEl.addEventListener('click', onClick); mountEl.addEventListener('change', onPick);
    if (tickList) tickList.addEventListener('click', onTick);
    window.addEventListener('pagehide', onHide);
    let ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { const w = mountEl.clientWidth; if (w !== lastW) { lastW = w; want(); } }); ro.observe(mountEl); }

    tickAll();
    if (c.visible()) drawNow();

    return {
      destroy() {
        for (const off of offs) try { off(); } catch { /* gone */ }
        clearTimeout(timer); clearTimeout(idleT); if (anim) cancelAnimationFrame(anim);
        if (saveT) save();
        mountEl.removeEventListener('click', onClick); mountEl.removeEventListener('change', onPick);
        if (tickList) tickList.removeEventListener('click', onTick);
        window.removeEventListener('pagehide', onHide); if (ro) ro.disconnect();
        mountEl.innerHTML = ''; if (tickerEl) tickerEl.innerHTML = '';
      },
      _view: () => A.view(cur(), canon), _save: save, _sets: () => ({ live, demo, showDemo }),   // tests
    };
  }

  return { mount, createAgg, VERSION, SAVE_CAP };
});
