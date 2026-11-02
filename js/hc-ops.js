/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts > 📡 Heard operators (2026-10-25, unreleased): every station heard on the
 * mesh in one sortable, filterable table, deduped by public key -- the address book (the node's contacts) and the
 * heard-not-added list together -- with Add / Message / Channel / P25 / Trace / callsign per row.
 * Passive: it only reads what the node and Kelly already heard (adverts, raw packets, channel posts). Every radio action
 * is a button the user presses. Coded against js/hc-core.js (ContactRecord) + js/hc-service.js; mounted by js/hc-ui.js
 * in #hc-ops, which hands it the shared context c (its header lists it), plus these extras from mesh.js:
 *   c.live() -> Map key -> mesh.js node: what the record doesn't carry -- directSnr / directAt / rssi (heard direct),
 *     advHops / advPath { sz, h } / advAt (its last advert: hops and the repeaters it came through), chs [channel
 *     indexes it posted on], firstHeard
 *   c.chans() -> [{ index, name }]   c.openChannel(index, text) -> the Mesh tab's chat on that channel, text typed in
 *   c.p25Of(node) -> { id, name } | null (its callsign is a P25 radio)   c.openP25(id) -> Kelly's P25 compose
 * Status: New = not in the address book and not marked seen (store 'hcOpsSeen', <= 1000 keys); In address book =
 *   onRadio; Direct = its route is 0 hops or Kelly heard it direct in the last 2 h.
 * Traces open the Trace Route tab (c.openTrace); the row shows that station's last run from Trace Route's own store
 *   ('trHistory', read only). Callsigns are Kelly labels (window.KellyHamCalls.set / clear), never written to the node.
 * Hams filter (2026-10-25): possible = a person's station carrying a callsign (any tier), likely = verified | probable --
 *   Ham Contacts' own verdict (KellyHamCalls.hamOf), so repeater / room / sensor / bot / club calls never count.
 * Channel filter: "heard posting on channel X" -- matched by the advert name in a "Name: msg" post (anyone can use a name).
 * Re-renders at most once a second, only while visible; ages tick every 10 s. Nothing animates. CSS: css/hc-ops.css.
 */
(function () {
  'use strict';

  const MAX_ROWS = 400, SEEN_MAX = 1000, DIRECT_MS = 2 * 3600e3;
  const TYPES = [[0, 'All types'], [1, '📱 Chat'], [2, '📡 Repeater'], [3, '🏛️ Room'], [4, '🌡️ Sensor']];
  const SORTS = [['heard', 'Last heard'], ['signal', 'Signal'], ['hops', 'Hops'], ['name', 'Name']];
  // hams filter, from Ham Contacts' own verdict (KellyHamCalls.hamOf -> hc-core hamStatus): a person's station (not a
  // repeater / room / sensor / bot / club call) carrying a callsign. Possible = any evidence; likely = verified | probable.
  const HAMS = [['all', 'All stations'], ['possible', '🎙️ Possible hams'], ['likely', '✅ Likely hams']];
  const snrClass = s => (s == null ? '' : s >= 6 ? 'great' : s >= 0 ? 'good' : s >= -8 ? 'fair' : 'poor');
  const fmtKm = km => (km == null ? '' : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
  const absT = ms => { if (!ms) return ''; const d = new Date(ms), today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); };

  window.KellyHCOperators = function (mount, c) {
    if (!mount || !c || !c.svc) return { destroy() {} };
    const esc = c.esc || (s => String(s ?? '').replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';'));
    const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch (e) { return d; } };
    const store = c.store || { get: (k, d) => d, set() {} };
    const prefs = Object.assign({ sort: 'heard', type: 0, ch: 'all', ham: 'all', newOnly: false, q: '' }, safe(() => store.get('hcOps', {}), {}) || {});
    let seen = new Set(safe(() => store.get('hcOpsSeen', []), []) || []);
    const busy = new Map(), res = new Map();   // key -> what's running / its last Result { ok, msg|error }
    let editing = null, lastRender = 0, timer = null, destroyed = false;
    const offs = [];

    mount.innerHTML = `<div class="card hc-ops"><div class="card-h"><h2>📡 Heard operators</h2><span class="tag" data-r="n">0</span>
        <span class="hc-ops-grow"></span><button class="btn small ghost" data-act="seen" title="Clear every New badge">✓ Mark all seen</button>
        <button class="btn small" data-act="advert" title="Send a zero-hop advert so operators near you hear you too">📣 Advertise me</button></div>
      <p class="dim small hc-ops-why">Everyone your node and Kelly have heard -- from their adverts and any packet -- one row per public key. Listening only:
        nothing is sent until you press a button. Add a station to your node's address book before you message or trace it.</p>
      <div class="hc-ops-bar">
        <input type="search" data-f="q" placeholder="Search name, callsign or key" aria-label="Search heard operators" value="${esc(prefs.q)}">
        <select data-f="type" aria-label="Node type">${TYPES.map(([v, l]) => `<option value="${v}"${+prefs.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select data-f="ham" aria-label="Ham radio operators" title="Possible: a person's station with a callsign anywhere (its name, one you set, the P25X directory). Likely: verified or a VK / ZL call in its own advert. Repeaters, rooms, sensors, bots and club calls are left out of both.">${HAMS.map(([v, l]) => `<option value="${v}"${prefs.ham === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <select data-f="ch" aria-label="Heard posting on channel"></select>
        <label class="chk"><input type="checkbox" data-f="newOnly"${prefs.newOnly ? ' checked' : ''}> New only</label>
        <label class="hc-ops-sort">Sort <select data-f="sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}"${prefs.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <span class="hc-ops-res" data-r="top" aria-live="polite"></span></div>
      <div class="hc-ops-table" role="table" aria-label="Heard operators">
        <div class="hc-ops-row hc-ops-head" role="row"><span role="columnheader">Operator</span><span role="columnheader">Type · key</span><span role="columnheader">Last heard</span>
          <span role="columnheader">Signal</span><span role="columnheader">Hops · path</span><span role="columnheader">Location</span><span role="columnheader">Status</span><span role="columnheader">Actions</span></div>
        <div data-r="rows"></div></div></div>`;
    const q = s => mount.querySelector(s), rowsEl = q('[data-r="rows"]'), chSel = q('[data-f="ch"]');
    const savePrefs = () => store.set('hcOps', prefs);
    const saveSeen = () => { const a = [...seen]; store.set('hcOpsSeen', a.slice(-SEEN_MAX)); if (a.length > SEEN_MAX) seen = new Set(a.slice(-SEEN_MAX)); };

    // ------------------------------------------------------------ the list
    function list() {
      const st = safe(() => c.svc.state(), null) || {}, me = st.me && st.me.key;
      const live = safe(() => c.live(), null) || new Map(), byKey = new Map();
      for (const r of safe(() => c.svc.contacts(), []) || []) if (r && r.key) byKey.set(r.key, r);
      for (const r of safe(() => c.svc.heard(), []) || []) if (r && r.key && !byKey.has(r.key)) byKey.set(r.key, r);
      const out = [];
      for (const r of byKey.values()) {
        if (r.key === me) continue;
        const n = live.get(r.key) || {}, now = Date.now();
        const directFresh = n.directAt && now - n.directAt < DIRECT_MS;
        const snr = directFresh ? n.directSnr : r.snr, rssi = directFresh && n.rssi != null ? n.rssi : r.rssi;
        const lastHeard = Math.max(r.lastHeard || 0, n.lastHeard || 0, n.advAt || 0) || null;
        out.push({ r, n, snr: snr ?? null, rssi: rssi ?? null, lastHeard, direct: r.hops === 0 || !!directFresh, isNew: !r.onRadio && !seen.has(r.key), chs: Array.isArray(n.chs) ? n.chs : [] });
      }
      return { all: out, live };
    }
    function filtered(all) {
      const needle = String(prefs.q || '').trim().toLowerCase(), type = +prefs.type || 0, ch = prefs.ch;
      const rows = all.filter(x => (!prefs.newOnly || x.isNew) && (!type || x.r.type === type) && (ch === 'all' || x.chs.includes(+ch)) && hamOk(x)
        && (!needle || `${x.r.label} ${x.r.name} ${x.r.call || ''} ${x.r.key}`.toLowerCase().includes(needle)));
      const by = { heard: (a, b) => (b.lastHeard || 0) - (a.lastHeard || 0), signal: (a, b) => (b.snr ?? -99) - (a.snr ?? -99),
        hops: (a, b) => (hopsOf(a) ?? 99) - (hopsOf(b) ?? 99), name: (a, b) => (a.r.name || a.r.short).localeCompare(b.r.name || b.r.short) };
      return rows.sort((a, b) => (by[prefs.sort] || by.heard)(a, b) || (b.lastHeard || 0) - (a.lastHeard || 0));
    }
    const hopsOf = x => (x.r.hops != null ? x.r.hops : x.n.advHops != null ? x.n.advHops : null);
    function hamOk(x) {
      if (prefs.ham !== 'possible' && prefs.ham !== 'likely') return true;
      const H = window.KellyHamCalls, s = H && H.hamOf ? safe(() => H.hamOf({ key: x.r.key, name: x.r.name, type: x.r.type }, 'meshcore'), null) : null;
      if (!s || s.cls !== 'station' || !s.call) return false;
      return prefs.ham === 'possible' || s.tier === 'verified' || s.tier === 'probable';
    }
    // the repeater a hash prefix names, when exactly one known station's key starts with it
    function nameOfHash(h, live) {
      if (!h) return null;
      const hit = []; for (const [key, n] of live) if (key.startsWith(String(h).toLowerCase())) { hit.push(n); if (hit.length > 1) break; }
      return hit.length === 1 ? (hit[0].longName || hit[0].name || null) : null;
    }
    function lastTrace(key) {
      const d = safe(() => store.get('trHistory', null), null), s = d && d.s && d.s[key], run = s && s.runs && s.runs[s.runs.length - 1];
      return run || null;
    }

    // ------------------------------------------------------------ cells
    function nameCell(x) {
      const r = x.r, ed = editing === r.key;
      const inName = r.call && r.callSrc === 'name' && String(r.name || '').toUpperCase().includes(r.call);   // already in the name: shown once
      const call = r.call && !inName ? `<span class="hc-ops-call" title="${esc(r.callSrc === 'mine' ? 'callsign you set' : r.callSrc === 'dir' ? 'from the P25X ham directory' : 'in its advert name')}">${esc(r.call)}</span>` : '';
      if (ed) return `<span class="hc-ops-name"><input class="hc-ops-callin" data-act="call-in" data-key="${esc(r.key)}" maxlength="10" placeholder="callsign" value="${esc(r.callSrc === 'mine' ? r.call || '' : '')}" aria-label="Callsign for ${esc(r.name)}">
        <button class="btn small primary" data-act="call-save" data-key="${esc(r.key)}">Save</button><button class="btn small ghost" data-act="call-cancel">✕</button></span>`;
      return `<span class="hc-ops-name">${call}<b>${esc(r.name || r.short)}</b><button class="hc-ops-pen" data-act="call" data-key="${esc(r.key)}" title="Set the callsign Kelly shows for this station (a Kelly label: the node keeps its own name)">✏️</button></span>`;
    }
    function signalCell(x) {
      if (x.snr == null && x.rssi == null) return '<span class="dim">—</span>';
      return `<span class="hc-ops-snr ${snrClass(x.snr)}">${x.snr != null ? `${x.snr.toFixed(1)} dB` : ''}</span>${x.rssi != null ? `<small>${x.rssi} dBm</small>` : ''}`;
    }
    function pathCell(x, live) {
      const r = x.r, n = x.n, h = hopsOf(x);
      const hopTxt = h == null ? '<span class="dim">no route yet</span>' : h === 0 ? '<b class="hc-ops-direct">direct</b>' : `${h} hop${h === 1 ? '' : 's'}`;
      let via = '';
      const p = r.outPath && r.outPath.h.length ? r.outPath.h : n.advPath && n.advPath.h && n.advPath.h.length ? n.advPath.h : null;
      if (p) {
        const last = p[p.length - 1], nm = nameOfHash(last, live);
        via = `<small title="${esc(p.join(' › '))}${r.outPath ? ' (its route from your node)' : ' (the path of its last advert)'}">via ${esc(nm || last)}${p.length > 1 ? ` +${p.length - 1}` : ''}</small>`;
      }
      const t = lastTrace(r.key);
      const tr = t ? `<small class="hc-ops-tr ${t.status === 'success' ? 'ok' : 'bad'}" title="Last trace ${esc(absT(t.t))}">🔭 ${t.status === 'success' ? `${t.rtt != null ? `${(t.rtt / 1000).toFixed(1)} s` : 'ok'}${t.snrs && t.snrs.length ? ` · min ${Math.min(...t.snrs).toFixed(1)} dB` : ''}` : esc(t.status)}</small>` : '';
      return `${hopTxt}${via}${tr}`;
    }
    function locCell(x) {
      const r = x.r;
      if (r.lat == null || r.lon == null || (r.lat === 0 && r.lon === 0)) return '<span class="dim">—</span>';
      return `<span title="${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}">${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}</span>${r.km != null ? `<small>${esc(fmtKm(r.km))}</small>` : ''}`;
    }
    function statusCell(x) {
      return [x.isNew ? '<span class="hc-ops-b new">New</span>' : '', x.r.onRadio ? '<span class="hc-ops-b book">In address book</span>' : '',
        x.direct ? '<span class="hc-ops-b direct">Direct</span>' : ''].join('') || '<span class="dim">heard</span>';
    }
    function actsCell(x, online) {
      const r = x.r, key = esc(r.key), run = busy.get(r.key), off = !online ? ' disabled' : '';
      const p25 = safe(() => c.p25Of && c.p25Of(Object.assign({ longName: r.call || r.name }, x.n)), null);
      const chatty = r.type === 1 || r.type === 3 || r.type === 0;
      return [!r.onRadio ? `<button class="btn small primary" data-act="add" data-key="${key}"${off || (run ? ' disabled' : '')} title="Add to your node's address book (its public key is what direct messages need)">${run === 'add' ? '⏳' : '➕'} Add</button>` : '',
        chatty ? `<button class="btn small" data-act="dm" data-key="${key}"${r.onRadio ? '' : ' disabled'} title="${r.onRadio ? 'Direct message (encrypted with its key)' : 'Add it first: a direct message needs it in your address book'}">💬</button>` : '',
        chatty ? `<button class="btn small ghost" data-act="chan" data-key="${key}" title="Mention it in a channel post">📢</button>` : '',
        p25 ? `<button class="btn small ghost" data-act="p25" data-id="${esc(p25.id)}" title="Text ${esc(p25.name)} on P25 instead (P25X messaging)">📻</button>` : '',
        `<button class="btn small ghost" data-act="trace" data-key="${key}"${r.onRadio ? '' : ' disabled'} title="${r.onRadio ? 'Trace the route to it (opens Trace Route)' : 'Add it first: Trace Route needs it in your address book'}">🔭</button>`].join('');
    }

    function chOptions(all) {
      const chans = safe(() => c.chans(), []) || [], used = new Set(all.flatMap(x => x.chs));
      const opts = [['all', 'Any channel'], ...chans.map(ch => [String(ch.index), `# ${ch.name}${used.has(ch.index) ? '' : ' (no posts heard)'}`])];
      if (prefs.ch !== 'all' && !opts.some(o => o[0] === String(prefs.ch))) opts.push([String(prefs.ch), `# ${prefs.ch}`]);
      const html = opts.map(([v, l]) => `<option value="${esc(v)}"${String(prefs.ch) === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
      if (chSel.innerHTML !== html && document.activeElement !== chSel) chSel.innerHTML = html;
    }

    function render() {
      if (destroyed) return;
      lastRender = Date.now();
      const st = safe(() => c.svc.state(), null) || { link: {} }, online = !!(st.link && st.link.online);
      const { all, live } = list(), rows = filtered(all);
      chOptions(all);
      q('[data-r="n"]').textContent = rows.length === all.length ? String(all.length) : `${rows.length} / ${all.length}`;
      const focus = document.activeElement && mount.contains(document.activeElement) ? { act: document.activeElement.dataset.act, key: document.activeElement.dataset.key } : null;
      const html = rows.length ? rows.slice(0, MAX_ROWS).map(x => {
        const r = x.r, rs = res.get(r.key);
        return `<div class="hc-ops-row${x.isNew ? ' is-new' : ''}" role="row" data-key="${esc(r.key)}">
          <span role="cell" class="c-name">${nameCell(x)}</span>
          <span role="cell" class="c-type">${r.icon} ${esc(r.typeName)}<small class="hc-ops-key" title="${esc(r.key)}">${esc(r.short)}</small></span>
          <span role="cell" class="c-heard" title="${esc(x.lastHeard ? new Date(x.lastHeard).toLocaleString() : '')}">${x.lastHeard ? esc(safe(() => c.fmtAgo(x.lastHeard), '')) : '<span class="dim">never</span>'}<small>${esc(absT(x.lastHeard))}</small></span>
          <span role="cell" class="c-sig">${signalCell(x)}</span>
          <span role="cell" class="c-path">${pathCell(x, live)}</span>
          <span role="cell" class="c-loc">${locCell(x)}</span>
          <span role="cell" class="c-stat">${statusCell(x)}</span>
          <span role="cell" class="c-acts">${actsCell(x, online)}</span>
          ${rs ? `<p class="hc-ops-rowres ${rs.ok ? 'ok' : 'bad'}" role="status">${esc(rs.ok ? rs.msg || 'Done.' : rs.error || 'Something went wrong.')}</p>` : ''}</div>`;
      }).join('') : `<p class="hc-ops-empty dim">${all.length ? 'Nobody matches these filters.' : online ? 'Nobody heard yet. Operators show up here as their adverts arrive -- or press 📣 Advertise me so they hear you.' : esc((st.link && st.link.why) || 'Connect your MeshCore node on the Mesh tab (or press 🎲 Demo above).')}</p>`;
      if (rowsEl.innerHTML !== html) {
        const top = rowsEl.scrollTop; rowsEl.innerHTML = html; rowsEl.scrollTop = top;
        if (focus && focus.act) { const el = rowsEl.querySelector(`[data-act="${focus.act}"]${focus.key ? `[data-key="${CSS.escape(focus.key)}"]` : ''}`); if (el) el.focus(); }
      }
      q('[data-act="advert"]').disabled = !online || busy.has('advert');
    }
    function schedule(now) {
      if (destroyed) return;
      if (timer && now) { clearTimeout(timer); timer = null; }   // a user action never waits behind a throttled redraw
      if (timer) return;
      if (!safe(() => c.visible(), false) && !now) return;
      const wait = now ? 0 : Math.max(0, 1000 - (Date.now() - lastRender));
      timer = setTimeout(() => { timer = null; render(); }, wait);
    }

    // ------------------------------------------------------------ actions
    async function run(key, what, fn) {
      if (busy.has(key)) return;
      busy.set(key, what); schedule(true);
      let r; try { r = await fn(); } catch (e) { r = { ok: false, error: e.message }; }
      busy.delete(key); if (r) res.set(key, r);
      if (r && c.say) safe(() => c.say(r));
      schedule(true);
      if (r) setTimeout(() => { if (res.get(key) === r) { res.delete(key); schedule(); } }, 12000);
      return r;
    }
    function findRec(key) { return safe(() => c.svc.get(key), null); }
    mount.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
      const key = b.dataset.key, act = b.dataset.act, rec = key ? findRec(key) : null;
      if (act === 'add' && key) { seen.add(key); saveSeen(); run(key, 'add', () => c.svc.add(key)); }
      else if (act === 'dm' && rec) { const r = c.openChat ? c.openChat(key) : null; if (r && r.ok === false) res.set(key, { ok: false, error: r.reason }); }
      else if (act === 'chan' && rec) { if (c.openChannel) c.openChannel(prefs.ch !== 'all' ? +prefs.ch : 0, `@[${rec.name || rec.short}] `); }
      else if (act === 'p25') { if (c.openP25) c.openP25(+b.dataset.id); }
      else if (act === 'trace' && key) { const r = c.openTrace ? c.openTrace(key, null) : null; if (r && r.ok === false) { res.set(key, { ok: false, error: `Trace Route: ${r.reason}` }); schedule(true); } }
      else if (act === 'call' && key) { editing = key; schedule(true); setTimeout(() => { const i = rowsEl.querySelector('.hc-ops-callin'); if (i) i.focus(); }, 30); }
      else if (act === 'call-cancel') { editing = null; schedule(true); }
      else if (act === 'call-save' && key) saveCall(key);
      else if (act === 'seen') { const { all } = list(); for (const x of all) seen.add(x.r.key); saveSeen(); schedule(true); }
      else if (act === 'advert') run('advert', 'advert', () => c.svc.advert('local')).then(r => { const t = q('[data-r="top"]'); if (t && r) { t.textContent = r.ok ? (r.msg || 'Advert sent.') : r.error; t.className = `hc-ops-res ${r.ok ? 'ok' : 'bad'}`; } });
    });
    function saveCall(key) {
      const i = rowsEl.querySelector('.hc-ops-callin'), rec = findRec(key), H = window.KellyHamCalls;
      const v = String(i ? i.value : '').trim().toUpperCase();
      if (!H) { res.set(key, { ok: false, error: 'Callsign labels are not loaded.' }); editing = null; schedule(true); return; }
      if (!v) { safe(() => H.clear(key)); res.set(key, { ok: true, msg: 'Callsign label removed.' }); }
      else if (!/^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}(\/[A-Z0-9]{1,4})?$/.test(v)) { res.set(key, { ok: false, error: `"${v}" doesn't look like a callsign.` }); schedule(true); return; }
      else { safe(() => H.set(key, v, rec ? rec.name : undefined)); res.set(key, { ok: true, msg: `Kelly now shows ${v} for this station.` }); }
      editing = null; schedule(true);
    }
    mount.addEventListener('keydown', e => {
      if (!e.target.classList.contains('hc-ops-callin')) return;
      if (e.key === 'Enter') { e.preventDefault(); saveCall(e.target.dataset.key); } else if (e.key === 'Escape') { editing = null; schedule(true); }
    });
    mount.addEventListener('input', e => { if (e.target.dataset.f === 'q') { prefs.q = e.target.value; savePrefs(); schedule(true); } });
    mount.addEventListener('change', e => {
      const f = e.target.dataset.f; if (!f || f === 'q') return;
      prefs[f] = f === 'newOnly' ? e.target.checked : f === 'type' ? +e.target.value : e.target.value;
      savePrefs(); schedule(true);
    });

    for (const ev of ['contacts', 'heard', 'state', 'calls', 'op', 'demo']) offs.push(c.bus.on(ev, () => schedule()));
    offs.push(c.bus.on('visible', v => { if (v) schedule(true); }));
    const tick = setInterval(() => { if (safe(() => c.visible(), false)) schedule(); }, 10000);   // ages, signals
    render();
    return {
      destroy() { destroyed = true; clearInterval(tick); clearTimeout(timer); for (const off of offs) safe(() => off()); },
      _rows: () => filtered(list().all),   // tests
    };
  };
})();
