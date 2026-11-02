/* Kelly Page -- LoRa Mesh > 🔭 Trace Route: tr-history (2026-10-24, unreleased). Past traces per station, from the
 * engine's 'done' runs, in #tr-history (full width under the main grid).
 *
 * Storage: c.store('trHistory') = { v: 1, s: { [station id]: { n: name, r: role, runs: [rec, ...] oldest first } } }
 *   rec = { t, status, method, via, rtt (ms | null), hops (out repeaters), pathKey, snrs ([dB] every hop's SNR out then
 *   back, rounded to 0.25; [] for a discovery), changed (true | false | null) }
 *   Caps: 40 stations (the least recently traced go first) x 25 runs, snrs <= 40 values, pathKey <= 160 chars, and the
 *   whole JSON <= 100 000 chars (trimmed from the busiest station's oldest runs) -- well under the 150 KB budget of the
 *   ~5 MB localStorage Kelly shares with everything.
 *   Demo runs (run.demo: the demo world or the MeshCore Demo link) never touch storage: they live in memory and are
 *   dropped when 'demo' goes false. In demo mode only the demo runs show; otherwise stored + in-memory (sim-link) runs.
 * UI: station list (name, runs, last result, best / avg RTT, last-path-changed flag) | the selected station's RTT and
 *   weakest-hop SNR chart (canvas) + its runs table, newest first. Follows 'select' (else the newest run's station);
 *   clicking a station emits select { node, from: 'history' }. Clear one station / clear all (confirm()).
 *   Redraws at most once a second, and only while c.visible().
 * window.KellyTRHistory(mount, c) -> { destroy(), _test: { flush(), data(), mem(), view(), size(), selected() } }
 */
(function () {
  'use strict';

  const KEY = 'trHistory', MAX_ST = 40, MAX_RUNS = 25, BUDGET = 100000, MAX_SNRS = 40, MAX_PK = 160, REDRAW_MS = 1000;
  const finite = x => typeof x === 'number' && isFinite(x);
  const q25 = x => Math.round(x * 4) / 4;
  const RESULT = { success: ['✔', 'ok'], timeout: ['⏱', 'timed out'], 'no-path': ['∅', 'no path'], error: ['⚠', 'error'], cancelled: ['⊘', 'cancelled'] };

  window.KellyTRHistory = function (mount, c) {
    const TR = c.TR || window.KellyTR || {};
    const esc = c.esc || (s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])));
    const fmtAgo = c.fmtAgo || (t => t ? Math.round((Date.now() - t) / 1000) + 's ago' : 'never');
    const vis = () => { try { return !!(c.visible && c.visible()); } catch { return false; } };
    const isDemo = () => { try { return !!(c.demo && c.demo()); } catch { return false; } };
    const empty = () => ({ v: 1, s: {} });
    let data = null, mem = null;
    const size = d => JSON.stringify(d || data).length;
    const lastT = st => st.runs.length ? st.runs[st.runs.length - 1].t : 0;

    // ------------------------------------------------------------ data
    function load() {
      let d; try { d = c.store && c.store.get(KEY, null); } catch { d = null; }
      if (!d || typeof d !== 'object' || !d.s || typeof d.s !== 'object') return empty();
      const out = empty();
      for (const [id, st] of Object.entries(d.s)) if (st && Array.isArray(st.runs) && st.runs.length) out.s[id] = { n: String(st.n || id), r: st.r || null, runs: st.runs.filter(r => r && finite(r.t)).slice(-MAX_RUNS) };
      capStations(out); trimSize(out);
      return out;
    }
    data = load(); mem = empty();
    function save() {
      trimSize(data);
      try { c.store && c.store.set(KEY, data); } catch (e) { console.warn('Trace Route history: not saved', e); }
    }
    function capStations(d) {
      const ids = Object.keys(d.s);
      if (ids.length <= MAX_ST) return;
      ids.sort((a, b) => lastT(d.s[a]) - lastT(d.s[b]));
      for (const id of ids.slice(0, ids.length - MAX_ST)) delete d.s[id];
    }
    // drop the busiest station's oldest run until the JSON fits the budget
    function trimSize(d) {
      let n = size(d), guard = 0;
      while (n > BUDGET && guard++ < 2000) {
        let pick = null;
        for (const [id, st] of Object.entries(d.s)) if (!pick || st.runs.length > pick[1].runs.length || (st.runs.length === pick[1].runs.length && lastT(st) < lastT(pick[1]))) pick = [id, st];
        if (!pick) break;
        const gone = pick[1].runs.shift();
        n -= gone ? JSON.stringify(gone).length + 1 : 0;
        if (!pick[1].runs.length) { delete d.s[pick[0]]; n = size(d); }
        if (guard % 50 === 0) n = size(d);
      }
    }
    function recOf(r) {
      const hops = [...(Array.isArray(r.out) ? r.out.slice(1) : []), ...(Array.isArray(r.back) ? r.back.slice(1) : [])];
      const snrs = hops.map(h => h && finite(h.snr) ? q25(h.snr) : null).filter(x => x != null).slice(0, MAX_SNRS);
      return { t: finite(r.endedAt) ? r.endedAt : Date.now(), status: RESULT[r.status] ? r.status : 'error', method: r.method === 'discover' || r.method === 'ping' ? r.method : 'trace',
        via: r.via || (r.demo ? 'demo' : 'live'), rtt: r.status === 'success' && finite(r.rttMs) ? Math.round(r.rttMs) : null,
        hops: Array.isArray(r.out) ? Math.max(0, r.out.length - 2) : 0, pathKey: String(r.pathKey || '').slice(0, MAX_PK), snrs,
        changed: r.changed === true ? true : r.changed === false ? false : null };
    }
    function add(d, r) {
      const id = String(r.target);
      const st = d.s[id] || (d.s[id] = { n: r.targetName || id.slice(0, 8), r: r.targetRole || null, runs: [] });
      if (r.targetName) st.n = String(r.targetName).slice(0, 60);
      if (r.targetRole) st.r = r.targetRole;
      st.runs.push(recOf(r));
      if (st.runs.length > MAX_RUNS) st.runs.splice(0, st.runs.length - MAX_RUNS);
      capStations(d);
    }
    function onDone(r) {
      if (!r || !r.target || r.status === 'pending') return;
      if (r.demo || (r.via && r.via !== 'live')) add(mem, r); else { add(data, r); save(); }
      schedule();
    }
    // what the UI shows: demo mode = the demo runs; otherwise stored + the in-memory (sim-link) runs, merged by station
    function view() {
      if (isDemo()) return mem.s;
      const out = {};
      for (const src of [data.s, mem.s]) for (const [id, st] of Object.entries(src)) {
        const o = out[id] || (out[id] = { n: st.n, r: st.r, runs: [] });
        o.runs = o.runs.concat(st.runs); if (src === mem.s) { o.n = st.n || o.n; o.r = st.r || o.r; }
      }
      for (const o of Object.values(out)) o.runs.sort((a, b) => a.t - b.t);
      return out;
    }
    const weakest = rec => rec && Array.isArray(rec.snrs) && rec.snrs.length ? Math.min(...rec.snrs.filter(finite)) : null;
    function summary(st) {
      const ok = st.runs.filter(x => x.status === 'success' && finite(x.rtt)), last = st.runs[st.runs.length - 1] || null;
      return { n: st.runs.length, last, best: ok.length ? Math.min(...ok.map(x => x.rtt)) : null, avg: ok.length ? ok.reduce((a, x) => a + x.rtt, 0) / ok.length : null,
        changed: !!(last && last.changed) };
    }

    // ------------------------------------------------------------ selection
    let selId = (() => { try { return c.selected ? c.selected() : null; } catch { return null; } })();
    function current(v) {
      if (selId) return selId;
      let best = null;
      for (const [id, st] of Object.entries(v)) if (st.runs.length && (!best || lastT(st) > best[1])) best = [id, lastT(st)];
      return best ? best[0] : null;
    }

    // ------------------------------------------------------------ DOM
    mount.innerHTML = `<div class="card tr-hist">
        <div class="card-h tr-hist-h"><h2>🕘 Trace history</h2><span class="tag tr-hist-set">live</span><span class="tr-hist-grow"></span>
          <button type="button" class="btn ghost tr-hist-clrall" title="Forget every stored trace">🗑 Clear all</button></div>
        <div class="tr-hist-body">
          <div class="tr-hist-list" role="list"></div>
          <div class="tr-hist-detail">
            <div class="tr-hist-dh"><b class="tr-hist-name"></b><span class="tr-hist-sum dim small"></span><span class="tr-hist-grow"></span>
              <button type="button" class="btn ghost tr-hist-clr" title="Forget this station's traces">Clear station</button></div>
            <div class="tr-hist-chartw"><canvas class="tr-hist-chart" aria-label="Round-trip time and weakest hop SNR, oldest to newest"></canvas>
              <div class="tr-hist-leg small"><span class="tr-hist-lrtt">● RTT (s)</span><span class="tr-hist-lsnr">● weakest hop SNR (dB)</span><span class="tr-hist-lfail">✕ failed</span></div></div>
            <div class="tr-hist-tw"><table class="tr-hist-table"><thead><tr><th>When</th><th>Result</th><th>RTT</th><th>Hops</th><th>Weakest</th><th>Path</th></tr></thead><tbody></tbody></table></div>
          </div>
        </div>
      </div>`;
    const $q = s => mount.querySelector(s);
    const listEl = $q('.tr-hist-list'), tbody = $q('.tr-hist-table tbody'), cv = $q('.tr-hist-chart');
    const fmtRtt = ms => finite(ms) ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s' : '–';
    const fmtSnr = s => finite(s) ? (s > 0 ? '+' : '') + (Math.round(s * 4) / 4).toString() + ' dB' : '–';
    const snrCls = s => TR.snrClass ? TR.snrClass(s) : 'none';
    const roleIcon = r => r === 'repeater' ? '📡' : r === 'room' ? '🏠' : r === 'companion' ? '📱' : r === 'sensor' ? '🌡' : '⭐';
    function nameOf(id, v) {
      if (v[id] && v[id].n) return v[id].n;
      try { const n = c.node && c.node(id); if (n && n.name) return n.name; } catch { /* */ }
      return String(id || '').slice(0, 8);
    }

    let lastDraw = 0, timer = 0, dirty = true, draws = 0;
    function schedule() {
      dirty = true;
      if (!vis() || timer) return;
      timer = setTimeout(() => { timer = 0; if (vis()) draw(); }, Math.max(0, lastDraw + REDRAW_MS - Date.now()));
    }
    function draw() {
      dirty = false; lastDraw = Date.now(); draws++;
      const v = view(), ids = Object.keys(v).filter(id => v[id].runs.length).sort((a, b) => lastT(v[b]) - lastT(v[a])), sel = current(v);
      $q('.tr-hist-set').textContent = isDemo() ? 'demo' : 'live';
      $q('.tr-hist-clrall').disabled = !ids.length;
      listEl.innerHTML = ids.length ? ids.map(id => {
        const st = v[id], s = summary(st), res = RESULT[s.last && s.last.status] || RESULT.error;
        return `<button type="button" role="listitem" class="tr-hist-st${id === sel ? ' tr-hist-on' : ''}" data-id="${esc(id)}" title="Show this station's traces (and select it)">
          <span class="tr-hist-stn">${roleIcon(st.r)} ${esc(st.n || id.slice(0, 8))}</span>
          <span class="tr-hist-stm"><span class="tr-hist-res tr-hist-${esc(s.last ? s.last.status : 'error')}" title="last: ${esc(res[1])}">${res[0]}</span>
          <span title="runs">${s.n}×</span><span title="best / average round trip">${fmtRtt(s.best)} / ${fmtRtt(s.avg)}</span>${s.changed ? '<span class="tr-hist-chg" title="the route changed on the last trace">↻</span>' : ''}</span></button>`;
      }).join('') : '<div class="tr-hist-none dim small">No traces yet. Each trace\'s result lands here, per station.</div>';
      const st = sel ? v[sel] : null, runs = st ? st.runs : [];
      $q('.tr-hist-name').textContent = sel ? nameOf(sel, v) : 'No station';
      const s = st ? summary(st) : null;
      $q('.tr-hist-sum').textContent = s ? `${s.n} run${s.n === 1 ? '' : 's'} · best ${fmtRtt(s.best)} · avg ${fmtRtt(s.avg)}` : sel ? 'not traced yet' : '';
      $q('.tr-hist-clr').disabled = !(sel && (data.s[sel] || mem.s[sel]));
      tbody.innerHTML = runs.length ? runs.slice().reverse().map(r => {
        const res = RESULT[r.status] || RESULT.error, w = weakest(r);
        return `<tr class="tr-hist-r-${esc(r.status)}"><td>${esc(fmtAgo(r.t))}</td>
          <td><span class="tr-hist-res tr-hist-${esc(r.status)}">${res[0]}</span> ${esc(res[1])}${r.method === 'discover' || r.method === 'ping' ? ` <span class="tag tr-hist-tag">${esc(r.method)}</span>` : ''}${r.via && r.via !== 'live' ? ` <span class="tag tr-hist-tag">${esc(r.via)}</span>` : ''}</td>
          <td>${fmtRtt(r.rtt)}</td><td>${finite(r.hops) ? r.hops : '–'}</td><td class="tr-hist-snr-${snrCls(w)}">${fmtSnr(w)}</td>
          <td>${r.changed ? '<span class="tr-hist-chg">↻ path changed</span>' : ''}</td></tr>`;
      }).join('') : `<tr><td colspan="6" class="dim small">${sel ? 'No traces to this station yet.' : 'Trace a station to start its history.'}</td></tr>`;
      chart(runs);
    }

    function css(n, d) { try { return getComputedStyle(mount).getPropertyValue(n).trim() || d; } catch { return d; } }
    function chart(runs) {
      const H = 150, w = Math.max(10, cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 300), dpr = Math.min(3, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + 'px'; }
      const g = cv.getContext && cv.getContext('2d'); if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, H);
      const mono = css('--mono', 'monospace'), dim = css('--dim', '#8394b8'), cRtt = css('--tr-back', '#ffd36b'), cSnr = css('--tr-out', '#7df9ff'), cFail = css('--tr-fail', '#ff3b5c');
      g.font = `600 10px ${mono}`; g.fillStyle = dim; g.textBaseline = 'middle';
      if (!runs.length) { g.textAlign = 'center'; g.fillText('RTT and signal appear after the first trace', w / 2, H / 2); return; }
      const padL = 34, padR = 38, padT = 10, padB = 18, cw = w - padL - padR, ch = H - padT - padB;
      const rtts = runs.map(r => r.status === 'success' && finite(r.rtt) ? r.rtt / 1000 : null), ws = runs.map(weakest);
      const rh = Math.max(2, Math.ceil(Math.max(0, ...rtts.filter(finite)) * 1.15)), sl = Math.floor(Math.min(-6, ...ws.filter(finite)) / 6) * 6, sh = Math.ceil(Math.max(6, ...ws.filter(finite)) / 6) * 6;
      const X = i => padL + (runs.length === 1 ? cw / 2 : cw * i / (runs.length - 1)), Y = (v, lo, hi) => padT + ch - ch * (v - lo) / (hi - lo);
      g.strokeStyle = 'rgba(131,148,184,.15)'; g.lineWidth = 1;
      for (const f of [0, 0.5, 1]) {
        const y = padT + ch - ch * f; g.beginPath(); g.moveTo(padL, y + .5); g.lineTo(w - padR, y + .5); g.stroke();
        g.textAlign = 'right'; g.fillStyle = cRtt; g.fillText((rh * f).toFixed(rh < 10 ? 1 : 0), padL - 4, y);
        g.textAlign = 'left'; g.fillStyle = cSnr; g.fillText(String(Math.round(sl + (sh - sl) * f)), w - padR + 4, y);
      }
      const line = (vals, lo, hi, col, dotCol) => {
        g.strokeStyle = col; g.lineWidth = 2; g.shadowColor = col; g.shadowBlur = 5; g.beginPath(); let on = false;
        vals.forEach((v, i) => { if (!finite(v)) return; const x = X(i), y = Y(v, lo, hi); if (on) g.lineTo(x, y); else { g.moveTo(x, y); on = true; } });
        g.stroke(); g.shadowBlur = 0;
        vals.forEach((v, i) => { if (!finite(v)) return; g.fillStyle = dotCol ? dotCol(v) : col; g.beginPath(); g.arc(X(i), Y(v, lo, hi), 2.6, 0, Math.PI * 2); g.fill(); });
      };
      line(ws, sl, sh, cSnr, v => TR.snrColor ? TR.snrColor(v) : cSnr);
      line(rtts, 0, rh, cRtt);
      g.strokeStyle = cFail; g.lineWidth = 1.6;
      runs.forEach((r, i) => { if (r.status === 'success' || r.status === 'cancelled') return; const x = X(i), y = padT + ch - 4; g.beginPath(); g.moveTo(x - 3.5, y - 3.5); g.lineTo(x + 3.5, y + 3.5); g.moveTo(x + 3.5, y - 3.5); g.lineTo(x - 3.5, y + 3.5); g.stroke(); });
      g.fillStyle = dim; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
      const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      g.fillText(hm(runs[0].t), padL, H - 4); if (runs.length > 1) { g.textAlign = 'right'; g.fillText(hm(runs[runs.length - 1].t), w - padR, H - 4); }
    }

    function clearStation(id) {
      if (!id) return;
      if (typeof confirm === 'function' && !confirm(`Forget the trace history for ${nameOf(id, view())}?`)) return;
      delete data.s[id]; delete mem.s[id]; save(); schedule();
    }
    function clearAll() {
      if (typeof confirm === 'function' && !confirm('Forget every stored trace?')) return;
      data = empty(); mem = empty(); save(); schedule();
    }
    mount.addEventListener('click', onClick);
    function onClick(e) {
      try {
        const b = e.target.closest && e.target.closest('button'); if (!b || !mount.contains(b)) return;
        if (b.classList.contains('tr-hist-st')) { const id = b.dataset.id; selId = id; c.bus.emit('select', { node: id, from: 'history' }); schedule(); }
        else if (b.classList.contains('tr-hist-clr')) clearStation(current(view()));
        else if (b.classList.contains('tr-hist-clrall')) clearAll();
      } catch (err) { console.warn('Trace Route history', err); }
    }

    const safe = fn => x => { try { fn(x); } catch (e) { console.warn('Trace Route history', e); } };
    const offs = [
      c.bus.on('done', safe(onDone)),
      c.bus.on('select', safe(s => { if (s && s.node) { selId = String(s.node); schedule(); } })),
      c.bus.on('demo', safe(on => { if (!on) mem = empty(); selId = null; schedule(); })),
      c.bus.on('visible', safe(v => { if (v) schedule(); else if (timer) { clearTimeout(timer); timer = 0; dirty = true; } })),
    ];
    let ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => { if (vis()) schedule(); }); ro.observe(cv.parentNode); }
    if (vis()) draw();

    return {
      destroy() {
        offs.forEach(f => { try { f(); } catch { /* */ } });
        if (timer) clearTimeout(timer); timer = 0; if (ro) ro.disconnect();
        mount.removeEventListener('click', onClick); mount.innerHTML = '';
      },
      _test: { flush: draw, data: () => data, mem: () => mem, view, size: () => size(data), selected: () => current(view()), draws: () => draws, dirty: () => dirty },
    };
  };
})();
