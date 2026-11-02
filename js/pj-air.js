/* Kelly Page -- LoRa Mesh > Packet Journey: airtime + channel load, and stations on the wrong path hash size
 * (2026-10-24, unreleased). Coded against js/pj-core.js only -- see PACKET_JOURNEY_PLAN.md "Round 2", row Air.
 *
 * window.KellyPJAir(mount, c) -> { destroy() }        mount = #pj-air
 * window.KellyPJAir.airtimeMs(bytes, radio, opts?)    the Semtech LoRa time-on-air (pure; also module.exports in Node)
 * window.KellyPJAir.preambleFor(sf), .createAgg(KINDS) -- pure, for tests.
 *
 * Two sets: live and demo (ev.demo), session only (no storage). The demo set is shown while the shell says demo is
 * on. Redraw <= 1/s and only while c.visible(); while there was traffic in the last minute a 5 s refresh lets the gauge
 * fall back, then it stops. Nothing animates. Every list is capped.
 *
 * Honest limits, said on the card: this is airtime HEARD by our node (stations we can't hear used the channel too),
 * and each copy of one flood (via several repeaters) counts -- each copy was a separate transmission.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.KellyPJAir = api.mount; Object.assign(root.KellyPJAir, api); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MINUTES = 60, MAX_RECENT = 5000, MAX_TALK = 200, MAX_HASH_ST = 200, MAX_PKEYS = 3000, TOP = 8, WRONG_ROWS = 12;

  // ============================================================ LoRa time on air (pure)
  // MeshCore's preamble: src/helpers/radiolib/RadioLibWrappers.h (companion-v1.18.0 / repeater-v1.18.0 and main @81dbae5,
  // 2026-10-15): `static uint16_t preambleLengthForSF(uint8_t sf) { return sf <= 8 ? 32 : 16; }`, applied in
  // RadioLibWrapper::begin() via _radio->setPreambleLength(...) "longer preamble for lower SF improves reliability".
  // (CustomSX1262::begin passes 16 first; begin() then overrides it. Older firmware stayed at 16 -- ~45 ms less at SF8/62.5.)
  const preambleFor = sf => (sf <= 8 ? 32 : 16);

  /* Semtech SX127x / SX126x datasheet (AN1200.13 "LoRa Modem Designer's Guide"):
   *   Tsym = 2^SF / BW;  Tpreamble = (nPreamble + 4.25) * Tsym
   *   nPayload = 8 + max(ceil((8*PL - 4*SF + 28 + 16*CRC - 20*IH) / (4*(SF - 2*DE))) * (CR + 4), 0)
   * CR 1..4 = 4/5..4/8 (5..8 accepted too); explicit header (IH 0), CRC on, DE (low data rate optimise) when Tsym > 16 ms
   * (RadioLib's auto rule; SF11/12 at 125 kHz, SF10+ at 62.5). bytes = the whole LoRa payload = MeshCore packet size.
   * radio = { sf, bwKHz, cr }; opts = { preamble?, crc?, implicit?, ldro? }. -> ms (number), or null for bad input. */
  function airtimeMs(bytes, radio, opts = {}) {
    const r = radio || {}, sf = +r.sf, bw = +r.bwKHz;
    let cr = +r.cr; if (cr >= 5 && cr <= 8) cr -= 4;
    const pl = +bytes;
    if (!(sf >= 5 && sf <= 12) || !(bw > 0) || !(cr >= 1 && cr <= 4) || !(pl >= 0) || !isFinite(pl)) return null;
    const tsym = Math.pow(2, sf) / bw;   // ms (bw in kHz)
    const de = opts.ldro != null ? (opts.ldro ? 1 : 0) : tsym > 16 ? 1 : 0;
    const crc = opts.crc === false ? 0 : 1, ih = opts.implicit ? 1 : 0;
    const npre = opts.preamble != null ? +opts.preamble : preambleFor(sf);
    const n = 8 + Math.max(Math.ceil((8 * pl - 4 * sf + 28 + 16 * crc - 20 * ih) / (4 * (sf - 2 * de))) * (cr + 4), 0);
    return (npre + 4.25) * tsym + n * tsym;
  }

  // ============================================================ pure aggregation (no DOM)
  function createAgg(KINDS) {
    const NK = KINDS.length, kidx = k => { const i = KINDS.indexOf(k); return i < 0 ? NK - 1 : i; };
    const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
    function empty() {
      return { t0: Date.now(), n: 0, ms: 0, recent: [], mins: {}, kMs: new Array(NK).fill(0), kN: new Array(NK).fill(0), talk: {},
        hs: {}, pk: new Map(), bySize: { 1: 0, 2: 0, 3: 0 } };
    }
    function evict(map, max, score) {
      const ids = Object.keys(map); if (ids.length <= max) return;
      ids.sort((a, b) => score(map[a]) - score(map[b]));
      for (const id of ids.slice(0, ids.length - max)) delete map[id];
    }
    // ev + its airtime (ms, or null) + the hash-check verdict (or null)
    function add(set, ev, ms, hc) {
      if (!ev) return;
      const t = num(ev.t) || Date.now();
      if (ms != null && ms > 0) {
        set.n++; set.ms += ms;
        const k = kidx(ev.kind); set.kMs[k] += ms; set.kN[k]++;
        set.recent.push([t, ms]);
        while (set.recent.length && (set.recent[0][0] < t - 60000 || set.recent.length > MAX_RECENT)) set.recent.shift();
        const m = Math.floor(t / 60000), mk = String(m);
        set.mins[mk] = (set.mins[mk] || 0) + ms;
        for (const key of Object.keys(set.mins)) if (+key <= m - MINUTES || +key > m + 1) delete set.mins[key];
        const src = (ev.src && ev.src.id) || 'unknown';
        const s = set.talk[src] || (set.talk[src] = { ms: 0, n: 0, last: 0, name: '' });
        s.ms += ms; s.n++; s.last = Math.max(s.last, t);
        if (ev.src && ev.src.name) s.name = String(ev.src.name).slice(0, 40);
        evict(set.talk, MAX_TALK, x => x.ms);
      }
      if (hc && hc.size) {
        // one flood heard via several repeaters is ONE packet for the % (pkey leaves the path out)
        const pk = ev.pkey || ev.hex || null, fresh = !pk || !set.pk.has(pk);
        if (pk) { set.pk.set(pk, t); if (set.pk.size > MAX_PKEYS) set.pk.delete(set.pk.keys().next().value); }
        if (fresh) set.bySize[hc.size] = (set.bySize[hc.size] || 0) + 1;
        const id = hc.id || ('name:' + hc.name);
        const h = set.hs[id] || (set.hs[id] = { id, n: 0, first: t, last: 0, strength: 'likely' });
        if (fresh) h.n++;
        h.last = Math.max(h.last, t); h.size = hc.size; h.name = String(hc.name || '?').slice(0, 60);
        if (hc.key) h.key = hc.key; if (hc.role) h.role = hc.role; h.type = hc.type; h.unknown = !!hc.unknown;
        if (hc.strength === 'certain') h.strength = 'certain';
        evict(set.hs, MAX_HASH_ST, x => x.last);
      }
    }
    // -> what the cards draw. canon(id) folds placeholder ids into keys; expected = the size this network wants
    function view(set, canon, expected, now = Date.now()) {
      const cut = now - 60000; let last60 = 0;
      for (const [t, ms] of set.recent) if (t >= cut && t <= now + 5000) last60 += ms;
      const m = Math.floor(now / 60000), mins = [];
      for (let i = MINUTES - 1; i >= 0; i--) mins.push((set.mins[String(m - i)] || 0) / 60000 * 100);
      const fold = {};
      for (const [id, s] of Object.entries(set.talk)) {
        const cid = id === 'unknown' ? id : (canon ? canon(id) : id) || id, f = fold[cid] || (fold[cid] = { id: cid, ms: 0, n: 0, last: 0, name: '' });
        f.ms += s.ms; f.n += s.n; f.last = Math.max(f.last, s.last); if (s.name && !f.name) f.name = s.name;
      }
      const talkers = Object.values(fold).sort((a, b) => b.ms - a.ms).slice(0, TOP);
      const tot = Object.values(set.bySize).reduce((a, b) => a + b, 0), good = set.bySize[expected] || 0;
      const wrong = Object.values(set.hs).filter(h => h.size !== expected).sort((a, b) => b.last - a.last);
      return { t0: set.t0, n: set.n, ms: set.ms, loadPct: last60 / 60000 * 100, last60, mins, kMs: set.kMs.slice(), kN: set.kN.slice(), talkers,
        floods: tot, wrongFloods: tot - good, wrongPct: tot ? (tot - good) / tot * 100 : null, bySize: Object.assign({}, set.bySize),
        wrong, checked: Object.keys(set.hs).length, recentAt: set.recent.length ? set.recent[set.recent.length - 1][0] : 0 };
    }
    return { empty, add, view };
  }

  const loadLevel = p => p == null ? 'none' : p < 10 ? 'ok' : p < 25 ? 'warn' : 'bad';
  const loadMeaning = p => p == null || p < 0.05 ? 'Quiet: nothing heard in the last minute.'
    : p < 10 ? 'Plenty of room: packets rarely collide at this load.'
    : p < 25 ? 'Getting busy: collisions start to cost packets, repeaters wait longer to send.'
    : 'Congested: many packets will collide and be lost -- fewer adverts and floods would help.';

  // ============================================================ the view
  function mount(mountEl, c) {
    const PJ = c.PJ, KINDS = PJ.KINDS, PAL = PJ.PALETTE, A = createAgg(KINDS);
    const esc = c.esc || (s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
    const fmtAgo = c.fmtAgo || (t => Math.round((Date.now() - t) / 1000) + 's ago');
    const canon = id => { try { return c.reg && c.reg.canonical ? c.reg.canonical(id) : id; } catch { return id; } };
    const nodeOf = id => { try { return c.reg && c.reg.get ? c.reg.get(id) : null; } catch { return null; } };
    const HC = () => (typeof self !== 'undefined' && self.KellyMcHashCheck) || null;
    const radio = () => { try { return (c.radio && c.radio()) || { freqMHz: 923.125, bwKHz: 62.5, sf: 8, cr: 5, demo: true }; } catch { return { freqMHz: 923.125, bwKHz: 62.5, sf: 8, cr: 5, demo: true }; } };
    const expected = () => { try { return (c.hashExpected && c.hashExpected()) || 2; } catch { return 2; } };

    let live = A.empty(), demo = A.empty(), showDemo = false;
    const cur = () => showDemo ? demo : live;

    mountEl.innerHTML = `<div class="pj-air">
      <div class="card pj-air-load"><div class="card-h"><h2>📻 Airtime &amp; channel load</h2><span class="tag" data-r="set">live</span></div>
        <div class="pj-air-top">
          <div class="pj-air-gauge"><canvas data-c="gauge"></canvas><div class="pj-air-gv"><b data-r="pct">0%</b><small>last 60 s</small></div></div>
          <div class="pj-air-meta"><p class="pj-air-mean" data-r="mean"></p>
            <dl class="pj-air-kv"><dt>Heard on air</dt><dd data-r="tot">–</dd><dt>Radio</dt><dd data-r="radio">–</dd></dl></div>
        </div>
        <div class="pj-air-sub">Load per minute <span class="dim">· last 60 min · bands 10% / 25%</span></div>
        <canvas data-c="line"></canvas>
        <div class="pj-air-sub">Airtime by kind</div>
        <div class="pj-air-split" data-r="split"></div><ul class="pj-air-kleg" data-r="kleg"></ul>
        <div class="pj-air-sub">Top talkers by airtime <span class="dim">· who started the packets</span></div>
        <div class="pj-air-tbl"><table><thead><tr><th>Station</th><th>Airtime</th><th>Share</th><th>Pkts</th><th>Last</th></tr></thead><tbody data-r="talk"></tbody></table></div>
        <p class="pj-air-note">Airtime <b>heard by our node</b> -- stations we can't hear used the channel too, so the real load is higher.
          Each copy of a flood (one per repeater that passed it on) counts: every copy was its own transmission.</p>
      </div>
      <div class="card pj-air-hash" data-r="hashCard"><div class="card-h"><h2>#️⃣ Path hash size check</h2><span class="tag" data-r="hexp">expect 2-byte</span></div>
        <div class="pj-air-htop"><div class="pj-air-hbig"><b data-r="hpct">–</b><small data-r="hsub">of flood packets on the wrong size</small></div>
          <div class="pj-air-sizes" data-r="sizes"></div></div>
        <div class="pj-air-tbl"><table><thead><tr><th>Station</th><th>Sends</th><th>Evidence</th><th>Pkts</th><th>Last seen</th></tr></thead><tbody data-r="wrong"></tbody></table></div>
        <div class="pj-air-hfoot"><button class="btn ghost" data-act="analyser">🔬 How to fix → MeshCore Analyser</button>
          <span class="pj-air-note">Evidence: <b>certain</b> = an advert or anonymous request (the full key is in it); <b>likely</b> = a message whose sender we can only guess. Replies are not counted.</span></div>
      </div></div>`;
    const R = n => mountEl.querySelector(`[data-r="${n}"]`), CV = n => mountEl.querySelector(`[data-c="${n}"]`);
    if (!HC()) R('hashCard').hidden = true;

    const short = id => !id ? '?' : id.startsWith('h:') ? id.slice(2) + '…' : id.startsWith('n:') ? id.slice(2) : id.slice(0, 8) + '…';
    const nameOf = (id, fb) => id === 'unknown' ? 'Unknown sender' : (((nodeOf(id) || {}).name) || fb || short(id));
    const fmtMs = ms => ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3600e3 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 3600e3).toFixed(1)} h`;
    const fmtPct = p => p == null ? '–' : p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
    const css = n => { try { return getComputedStyle(mountEl).getPropertyValue(n).trim(); } catch { return ''; } };
    const LV = { ok: '#39ff88', warn: '#ffb020', bad: '#ff3b5c', none: '#5b6b8c' };
    function canvas(cv, h, wFix) {
      const w = wFix || Math.max(10, cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 300), dpr = Math.min(3, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; if (wFix) cv.style.width = w + 'px'; }
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); return { g, w, h };
    }

    // ---------------------------------------------------------- draw
    function draw() {
      const ex = expected(), V = A.view(cur(), canon, ex), rd = radio();
      const tag = R('set'); tag.textContent = showDemo ? 'demo' : 'live'; tag.className = 'tag ' + (showDemo ? 'warn' : 'ok');
      const lv = loadLevel(V.n ? V.loadPct : null);
      R('pct').textContent = fmtPct(V.loadPct); R('pct').style.color = LV[lv];
      R('mean').textContent = loadMeaning(V.n ? V.loadPct : null);
      R('tot').textContent = V.n ? `${fmtMs(V.ms)} in ${V.n.toLocaleString()} packets · ${fmtMs(V.last60)} in the last minute` : 'nothing yet';
      const pre = preambleFor(+rd.sf), eg = airtimeMs(50, rd);
      R('radio').innerHTML = `SF${esc(rd.sf)} · BW ${esc(rd.bwKHz)} kHz · CR 4/${esc(+rd.cr >= 5 ? rd.cr : +rd.cr + 4)}${rd.freqMHz ? ` · ${esc(rd.freqMHz)} MHz` : ''} · preamble ${pre}`
        + `<br><span class="dim">a 50-byte packet ≈ ${fmtMs(eg)}</span>${rd.demo ? ' <span class="tag warn">assumed SEQ defaults</span>' : ''}`;
      drawGauge(V.loadPct, lv); drawLine(V.mins); drawKinds(V); drawTalk(V);
      if (HC()) drawHash(V, ex);
    }
    function drawGauge(p, lv) {
      const cv = CV('gauge'); const { g, w, h } = canvas(cv, 120, 200);
      const cx = w / 2, cy = h - 12, r = Math.min(w / 2 - 12, h - 22), a0 = Math.PI, span = Math.PI;
      const max = 50, at = v => a0 + span * Math.min(1, v / max);
      g.lineWidth = 14; g.lineCap = 'butt';
      for (const [from, to, col] of [[0, 10, 'rgba(57,255,136,.18)'], [10, 25, 'rgba(255,176,32,.2)'], [25, max, 'rgba(255,59,92,.2)']]) {
        g.strokeStyle = col; g.beginPath(); g.arc(cx, cy, r, at(from), at(to)); g.stroke();
      }
      if (p > 0) { g.strokeStyle = LV[lv]; g.shadowColor = LV[lv]; g.shadowBlur = 10; g.beginPath(); g.arc(cx, cy, r, a0, at(p)); g.stroke(); g.shadowBlur = 0; }
      g.font = `600 10px ${css('--mono') || 'monospace'}`; g.fillStyle = css('--dim') || '#8394b8'; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const v of [0, 10, 25, 50]) { const a = at(v), rr = r + 1; g.fillText(v + (v === 50 ? '%+' : ''), cx + Math.cos(a) * (rr - 22), cy + Math.sin(a) * (rr - 22) + (v === 0 || v === 50 ? -6 : 0)); }
    }
    function drawLine(mins) {
      const { g, w, h } = canvas(CV('line'), 130), padL = 32, padB = 16, padT = 6, cw = w - padL - 6, ch = h - padB - padT;
      const top = Math.max(30, Math.ceil(Math.max(...mins) / 10) * 10), y = v => padT + ch - ch * Math.min(1, v / top), x = i => padL + cw * i / (mins.length - 1);
      const mono = css('--mono') || 'monospace', dim = css('--dim') || '#8394b8';
      g.fillStyle = 'rgba(255,176,32,.06)'; g.fillRect(padL, y(25), cw, y(10) - y(25));
      g.fillStyle = 'rgba(255,59,92,.07)'; g.fillRect(padL, padT, cw, y(25) - padT);
      g.strokeStyle = 'rgba(131,148,184,.15)'; g.lineWidth = 1; g.font = `600 10px ${mono}`; g.fillStyle = dim; g.textAlign = 'right'; g.textBaseline = 'middle';
      for (const v of [0, 10, 25, top]) { const yy = Math.round(y(v)) + .5; g.beginPath(); g.moveTo(padL, yy); g.lineTo(w - 6, yy); g.stroke(); g.fillText(v + '%', padL - 4, yy); }
      g.beginPath(); mins.forEach((v, i) => i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)));
      g.strokeStyle = css('--chart-line') || '#00e5ff'; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
      g.lineTo(x(mins.length - 1), y(0)); g.lineTo(x(0), y(0)); g.closePath(); g.fillStyle = 'rgba(0,229,255,.10)'; g.fill();
      g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.fillText('-60m', padL + 14, h - 3); g.fillText('-30m', padL + cw / 2, h - 3); g.textAlign = 'right'; g.fillText('now', w - 6, h - 3);
    }
    function drawKinds(V) {
      const tot = V.kMs.reduce((a, b) => a + b, 0);
      R('split').innerHTML = tot ? KINDS.map((k, i) => V.kMs[i] ? `<i style="width:${(100 * V.kMs[i] / tot).toFixed(2)}%;background:${PAL[k].color}" title="${esc(PAL[k].label)}"></i>` : '').join('') : '';
      R('kleg').innerHTML = KINDS.map((k, i) => V.kN[i] ? `<li><i style="background:${PAL[k].color}"></i><span>${esc(PAL[k].label)}</span><b>${fmtMs(V.kMs[i])}</b><small>${fmtPct(100 * V.kMs[i] / tot)} · avg ${fmtMs(V.kMs[i] / V.kN[i])}</small></li>` : '').join('')
        || '<li class="pj-air-empty">No packets yet.</li>';
    }
    function drawTalk(V) {
      R('talk').innerHTML = V.talkers.length ? V.talkers.map(t => `<tr data-id="${esc(t.id)}"><td class="pj-air-nm" title="${esc(t.id)}">${esc(nameOf(t.id, t.name))}</td><td class="pj-air-n">${fmtMs(t.ms)}</td>`
        + `<td>${fmtPct(V.ms ? 100 * t.ms / V.ms : null)}</td><td>${t.n.toLocaleString()}</td><td class="pj-air-ago">${esc(fmtAgo(t.last))}</td></tr>`).join('')
        : '<tr><td colspan="5" class="pj-air-empty">Waiting for packets.</td></tr>';
    }
    function drawHash(V, ex) {
      R('hexp').textContent = `expect ${ex}-byte`;
      const hp = R('hpct'); hp.textContent = fmtPct(V.wrongPct);
      hp.style.color = V.wrongPct == null ? '' : V.wrongPct === 0 ? LV.ok : V.wrongPct < 10 ? LV.warn : LV.bad;
      R('hsub').textContent = V.floods ? `of ${V.floods.toLocaleString()} flood packets on the wrong size (${V.wrongFloods.toLocaleString()})` : 'no flood packets that show a sender\'s setting yet';
      R('sizes').innerHTML = [1, 2, 3].map(s => `<span class="pj-air-sz${s === ex ? ' ok' : V.bySize[s] ? ' bad' : ''}"><b>${s}-byte</b>${(V.bySize[s] || 0).toLocaleString()}</span>`).join('');
      const H = HC();
      R('wrong').innerHTML = V.wrong.length ? V.wrong.slice(0, WRONG_ROWS).map(h => {
        let tip = ''; try { tip = H && H.hint ? H.hint({ name: h.name, size: h.size, expected: ex, role: h.role }) : ''; } catch { tip = ''; }
        const id = h.key ? h.key : '';
        return `<tr${id ? ` data-id="${esc(id)}"` : ''} title="${esc(tip)}"><td class="pj-air-nm">${esc(h.name)}${h.unknown ? ' <span class="dim">?</span>' : ''}</td><td class="pj-air-bad">${h.size}-byte</td>`
          + `<td><span class="tag ${h.strength === 'certain' ? 'bad' : 'warn'}">${h.strength}</span></td><td>${h.n.toLocaleString()}</td><td class="pj-air-ago">${esc(fmtAgo(h.last))}</td></tr>`;
      }).join('') + (V.wrong.length > WRONG_ROWS ? `<tr><td colspan="5" class="pj-air-empty">+ ${V.wrong.length - WRONG_ROWS} more</td></tr>` : '')
        : `<tr><td colspan="5" class="pj-air-empty">${V.checked ? `All ${V.checked} station${V.checked === 1 ? '' : 's'} checked send ${ex}-byte hashes. 👍` : 'No stations checked yet.'}</td></tr>`;
    }

    // ---------------------------------------------------------- scheduling (<= 1/s, visible only, no idle loop)
    let timer = 0, idleT = 0, lastDraw = 0, lastW = 0;
    function want() { if (!c.visible() || timer) return; timer = setTimeout(drawNow, Math.max(0, 1000 - (Date.now() - lastDraw))); }
    function drawNow() {
      clearTimeout(timer); timer = 0; clearTimeout(idleT); idleT = 0;
      if (!c.visible()) return;
      lastDraw = Date.now();
      try { draw(); } catch (e) { console.warn('pj-air draw', e); }
      const r = cur().recent; if (r.length && r[r.length - 1][0] > Date.now() - 65000) idleT = setTimeout(want, 5000);   // the gauge falls back, then stops
    }

    // ---------------------------------------------------------- bus + DOM
    const safe = fn => x => { try { fn(x); } catch (e) { console.warn('pj-air', e); } };
    const offs = [
      c.bus.on('packet', safe(ev => {
        if (!ev) return;
        const ms = airtimeMs(ev.size, radio());
        let hc = null; const H = HC();
        if (H && ev.d) { try { hc = H.evaluate(ev.d, expected(), { byPrefix: c.byPrefix }); } catch { hc = null; } }
        const set = ev.demo ? demo : live; A.add(set, ev, ms, hc);
        if (set === cur()) want();
      })),
      c.bus.on('nodes', safe(() => want())),
      c.bus.on('visible', safe(v => { if (v) drawNow(); else { clearTimeout(timer); timer = 0; clearTimeout(idleT); idleT = 0; } })),
      c.bus.on('reset', safe(() => { live = A.empty(); demo = A.empty(); if (c.visible()) drawNow(); })),
      c.bus.on('demo', safe(on => { on = !!on; if (on === showDemo) return; showDemo = on; if (c.visible()) drawNow(); })),
    ];
    const onClick = e => {
      const t = e.target; if (!t || !t.closest) return;
      if (t.closest('[data-act="analyser"]')) {
        const b = document.querySelector('[data-tabs="mesh"] [data-tab="analyser"]');
        if (b) b.click(); else if (c.toast) c.toast('🔬', 'MeshCore Analyser', 'Open LoRa Mesh › MeshCore Analyser for the fix for each station.', 'info');
        return;
      }
      const tr = t.closest('tr[data-id]'); if (tr) c.bus.emit('select', { node: tr.dataset.id, from: 'air' });
    };
    mountEl.addEventListener('click', onClick);
    let ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { const w = mountEl.clientWidth; if (w !== lastW) { lastW = w; want(); } }); ro.observe(mountEl); }
    if (c.visible()) drawNow();

    return {
      destroy() {
        for (const off of offs) try { off(); } catch { /* gone */ }
        clearTimeout(timer); clearTimeout(idleT); timer = idleT = 0;
        mountEl.removeEventListener('click', onClick); if (ro) ro.disconnect();
        mountEl.innerHTML = '';
      },
      _view: () => A.view(cur(), canon, expected()), _sets: () => ({ live, demo }),   // tests
    };
  }

  return { mount, airtimeMs, preambleFor, createAgg, loadLevel };
});
