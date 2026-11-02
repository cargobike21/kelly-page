/* Kelly Page -- LoRa Mesh > 🔭 Trace Route: the station picker (2026-10-24, unreleased). TRACE_ROUTE_PLAN.md agent 2.
 * window.KellyTRPicker(mount, c) -> { destroy() }, mounted in #tr-picker by js/tr-ui.js; c is that file's context.
 *   - search (name / key prefix / role words), chips All / ⭐ Favourites (store 'trFav', ≤ 100 ids) / 🕘 Recent
 *     (from 'done' runs, store 'trRecent', ≤ 20 { id, name, t })
 *   - the list: favourites, then traceable, then last heard; ≤ 150 rows; each row = a select button + a star button
 *     (arrow keys move between rows, Enter / Space selects)
 *   - a small Leaflet map (c.makeMap; null = no map), markers for stations with GPS, click = select from 'map';
 *     collapsible (collapsed by default on a phone)
 *   - the action panel: the selected station (▦ its contact QR, js/meshqr.js, when its full key and type are known), method Auto / Trace / Discover, a big Trace button (disabled with
 *     c.canTrace()'s reason), pending progress from c.current() (phase, try n of m, countdown to sentAt + timeoutMs,
 *     Cancel), and the rate limit (c.limits(): "next trace in 42 s", used / caps)
 * Re-renders the list on 'nodes' / 'demo' / 'link' at most once a second, and not while hidden. The panel's countdown
 * ticks once a second only while something counts down and the tab is visible. Nothing animates forever.
 */
(function () {
  'use strict';

  const MAX_ROWS = 150, FAV_CAP = 100, RECENT_CAP = 20;
  const ROLE_ICON = { repeater: '📡', room: '🏠', companion: '📱', sensor: '🌡️' };
  const ROLE_LABEL = { repeater: 'Repeater', room: 'Room server', companion: 'Companion', sensor: 'Sensor' };
  const PHASE_LABEL = { queued: 'queued', sending: 'sending', outbound: 'on the way out', returning: 'on the way back', done: 'done' };
  const METHODS = [['auto', 'Auto', 'Trace when a route is known, otherwise discover one first'],
    ['trace', 'Trace', 'Trace along a known route (per-hop signal)'], ['discover', 'Discover', 'Flood a path discovery (hashes only, no signal)'],
    ['ping', 'Ping', 'Companions: send a short message and wait for its ACK -- it lands in their inbox']];
  const ONE_BYTE = 'Sends 1-byte path hashes (this network uses 2-byte). Kelly never routes through a 1-byte hop it can\'t pin to one repeater.';

  window.KellyTRPicker = function (mount, c) {
    if (!mount || !c) return { destroy() {} };
    const TR = c.TR || window.KellyTR;
    const esc = c.esc || (s => String(s ?? '').replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';'));
    const fmtAgo = c.fmtAgo || (ts => ts ? Math.round((Date.now() - ts) / 1000) + 's ago' : 'never');
    const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch (e) { return d; } };
    const sget = (k, d) => safe(() => c.store && c.store.get ? c.store.get(k, d) : d, d);
    const sset = (k, v) => { try { if (c.store && c.store.set) c.store.set(k, v); } catch (e) { /* storage full: keep going */ } };
    const vis = () => !!safe(() => c.visible(), false);
    const phone = () => !!(window.matchMedia && matchMedia('(max-width: 600px)').matches);

    let favs = new Set((Array.isArray(sget('trFav', [])) ? sget('trFav', []) : []).filter(x => typeof x === 'string').slice(0, FAV_CAP));
    let demoRecent = [];   // demo / MeshCore Demo link runs: this session only, never saved
    const rec = () => safe(() => c.demo(), false) ? demoRecent : recent;
    let recent = (Array.isArray(sget('trRecent', [])) ? sget('trRecent', []) : []).filter(r => r && typeof r.id === 'string').slice(0, RECENT_CAP);
    let sel = safe(() => c.selected(), null) || null;
    let tab = 'all', query = '', method = 'auto', mapOpen = !phone(), destroyed = false;
    let byId = new Map();   // the last render's nodes by id (the map uses it: c.node() rebuilds the list each call)
    let lastRender = 0, renderTimer = null, dirty = false, tick = null, flash = null;   // flash: { text, until } a refused trace's reason

    mount.innerHTML = `<div class="tr-pk">
      <div class="tr-pk-find">
        <input class="tr-pk-q" type="search" placeholder="Search name, key or role…" aria-label="Search stations by name, key prefix or role" autocomplete="off" spellcheck="false">
        <div class="tr-pk-chips" role="group" aria-label="Show">
          <button type="button" class="tr-pk-chip" data-tab="all" aria-pressed="true">All <b class="tr-pk-n" data-n="all"></b></button>
          <button type="button" class="tr-pk-chip" data-tab="fav" aria-pressed="false">⭐ Favourites <b class="tr-pk-n" data-n="fav"></b></button>
          <button type="button" class="tr-pk-chip" data-tab="recent" aria-pressed="false">🕘 Recent <b class="tr-pk-n" data-n="recent"></b></button>
        </div>
      </div>
      <div class="tr-pk-mapwrap">
        <button type="button" class="tr-pk-maptog" aria-expanded="true">🗺️ Map <span class="tr-pk-mapcount"></span></button>
        <div class="tr-pk-map"></div>
      </div>
      <div class="tr-pk-act"></div>
      <ul class="tr-pk-list" aria-label="Stations"></ul>
      <div class="tr-pk-more dim small"></div>
    </div>`;
    const q = s => mount.querySelector(s);
    const qEl = q('.tr-pk-q'), listEl = q('.tr-pk-list'), actEl = q('.tr-pk-act'), moreEl = q('.tr-pk-more');
    const mapWrap = q('.tr-pk-mapwrap'), mapBox = q('.tr-pk-map'), mapTog = q('.tr-pk-maptog');

    // ------------------------------------------------------------ data
    const nodes = () => { const a = safe(() => c.nodes(), []); return Array.isArray(a) ? a.filter(n => n && n.id != null) : []; };
    const nodeOf = id => id == null ? null : safe(() => c.node(id), null) || nodes().find(n => n.id === id) || null;
    const roleText = r => ROLE_LABEL[r] || 'Station';
    function matches(n, words) {
      if (!words.length) return true;
      const name = String(n.name || '').toLowerCase(), key = String(n.key || n.id || '').toLowerCase(), role = String(n.role || 'unknown').toLowerCase();
      const roleWords = role + ' ' + roleText(n.role).toLowerCase() + (n.role === 'room' ? ' room server' : '');
      return words.every(w => name.includes(w) || key.startsWith(w.replace(/^0x/, '')) || roleWords.split(' ').some(r => r.startsWith(w)));
    }
    function shown(all) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      let list;
      if (tab === 'recent') {
        const by = new Map(all.map(n => [n.id, n]));
        list = rec().map(r => by.get(r.id)).filter(Boolean);
      } else {
        list = tab === 'fav' ? all.filter(n => favs.has(n.id)) : all.slice();
        list.sort((a, b) => (favs.has(b.id) - favs.has(a.id)) || (!!b.canTrace - !!a.canTrace) || ((b.lastHeard || 0) - (a.lastHeard || 0))
          || String(a.name || '').localeCompare(String(b.name || '')));
      }
      return list.filter(n => matches(n, words));
    }

    // ------------------------------------------------------------ list
    function snrBar(snr) {
      const ok = snr != null && isFinite(snr);
      const w = Math.round((TR ? TR.snrNorm(snr) : 0.35) * 100), col = TR ? TR.snrColor(snr) : '#8aa0b8';
      const txt = ok ? `${snr > 0 ? '+' : ''}${(+snr).toFixed(1)} dB` : '— dB';
      return `<span class="tr-pk-snr ${TR && ok ? 'tr-snr-' + TR.snrClass(snr) : 'tr-snr-none'}" title="Last heard at ${esc(txt)}${ok && TR ? ' (' + esc((TR.SNR.find(b => snr >= b.min) || {}).label || '') + ')' : ''}">`
        + `<i class="tr-pk-bar"><i style="width:${ok ? w : 0}%;background:${col}"></i></i><span>${esc(txt)}</span></span>`;
    }
    function rowHtml(n) {
      const id = String(n.id), fav = favs.has(id), on = id === sel;
      const hops = n.hops == null ? '? hops' : n.hops === 0 ? 'direct' : `${n.hops} hop${n.hops === 1 ? '' : 's'}`;
      const km = n.km != null && isFinite(n.km) ? `${n.km < 10 ? n.km.toFixed(1) : Math.round(n.km)} km` : '';
      const can = n.canTrace ? ['ok', 'trace', 'Can be traced (per-hop signal)'] : n.canPing ? ['warn', 'ping', n.why || 'Ping or discover only'] : n.canDiscover ? ['warn', 'discover only', n.why || 'Path discovery only']
        : ['bad', 'no route', n.why || 'Cannot be traced or discovered'];
      const name = n.name || (n.key ? String(n.key).slice(0, 8) : id);
      return `<li class="tr-pk-row${on ? ' tr-on' : ''}${fav ? ' tr-fav' : ''}" data-id="${esc(id)}">`
        + `<button type="button" class="tr-pk-pick" data-id="${esc(id)}" aria-current="${on ? 'true' : 'false'}" title="${esc(roleText(n.role))}: ${esc(name)}${n.key ? ' · ' + esc(String(n.key).slice(0, 12)) : ''}">`
        + `<span class="tr-pk-ic" aria-hidden="true">${ROLE_ICON[n.role] || '❔'}</span>`
        + `<span class="tr-pk-main"><span class="tr-pk-name">${esc(name)}</span>`
        + `<span class="tr-pk-meta"><span class="tr-sr">${esc(roleText(n.role))}, </span>${esc(fmtAgo(n.lastHeard || null))} · ${esc(hops)}${km ? ' · ' + esc(km) : ''}</span></span>`
        + snrBar(n.snr)
        + (n.sends && n.sends.size === 1 ? `<span class="tag bad tr-pk-1b" title="${esc(ONE_BYTE)}">1-byte</span>` : '')
        + `<span class="tag ${can[0]} tr-pk-can" title="${esc(can[2])}">${esc(can[1])}</span>`
        + (n.canTrace ? '' : `<span class="tr-sr">: ${esc(can[2])}</span>`)
        + `</button>`
        + `<button type="button" class="tr-pk-star" data-star="${esc(id)}" aria-pressed="${fav}" aria-label="${fav ? 'Remove' : 'Add'} ${esc(name)} ${fav ? 'from' : 'to'} favourites" title="Favourite">${fav ? '★' : '☆'}</button></li>`;
    }
    function emptyHtml(all) {
      const l = safe(() => c.link(), null) || {};
      if (!all.length) {
        const demoBtn = document.getElementById('tr-demo-btn'), demo = safe(() => c.demo(), false);
        return `<li class="tr-pk-empty"><p>${esc(l.online || demo ? 'No stations yet: wait for adverts to be heard (or ask your node to advert).' : l.why || 'No MeshCore node is connected.')}</p>`
          + (!demo && demoBtn && !demoBtn.hidden ? '<p class="dim small">No radio to hand? Try the demo: a made-up SEQ mesh.</p><button type="button" class="btn tr-pk-demo">🎲 Turn on Demo</button>' : '') + '</li>';
      }
      if (tab === 'fav' && !query) return '<li class="tr-pk-empty"><p class="dim">No favourites yet: press ☆ on a station to keep it at the top.</p></li>';
      if (tab === 'recent' && !query) return '<li class="tr-pk-empty"><p class="dim">No traces yet: the stations you trace show up here.</p></li>';
      return `<li class="tr-pk-empty"><p class="dim">No station matches "${esc(query)}".</p></li>`;
    }
    function renderList() {
      lastRender = Date.now(); dirty = false;
      const all = nodes(), list = shown(all), rows = list.slice(0, MAX_ROWS);
      byId = new Map(all.map(n => [n.id, n]));
      const focusId = document.activeElement && mount.contains(document.activeElement) ? document.activeElement.getAttribute('data-id') || document.activeElement.getAttribute('data-star') : null;
      const focusStar = !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('tr-pk-star'));
      const top = listEl.scrollTop;
      listEl.innerHTML = rows.length ? rows.map(rowHtml).join('') : emptyHtml(all);
      if (listEl.scrollTop !== top) listEl.scrollTop = top;   // same element, so normally kept; belt and braces
      moreEl.textContent = list.length > MAX_ROWS ? `+${list.length - MAX_ROWS} more: narrow the search to see them` : '';
      const setN = (k, v) => { const e = q(`[data-n="${k}"]`); if (e) e.textContent = v ? String(v) : ''; };
      const ids = new Set(all.map(n => n.id));
      setN('all', all.length); setN('fav', [...favs].filter(id => ids.has(id)).length); setN('recent', rec().filter(r => ids.has(r.id)).length);
      if (focusId) { const f = listEl.querySelector(focusStar ? `[data-star="${cssEsc(focusId)}"]` : `.tr-pk-pick[data-id="${cssEsc(focusId)}"]`); if (f) f.focus({ preventScroll: true }); }
      syncMap(all);
      renderAct();
    }
    const cssEsc = s => window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
    function schedule(now) {
      if (destroyed) return;
      if (!vis() && !now) { dirty = true; return; }
      const wait = 1000 - (Date.now() - lastRender);
      if (now || wait <= 0) { clearTimeout(renderTimer); renderTimer = null; renderList(); return; }
      if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; if (!destroyed) { if (vis()) renderList(); else dirty = true; } }, wait);
    }
    function highlight() {
      for (const li of listEl.querySelectorAll('.tr-pk-row')) {
        const on = li.getAttribute('data-id') === sel;
        li.classList.toggle('tr-on', on);
        const b = li.querySelector('.tr-pk-pick'); if (b) b.setAttribute('aria-current', on ? 'true' : 'false');
      }
    }
    function revealRow() {
      const li = sel ? listEl.querySelector(`.tr-pk-row[data-id="${cssEsc(sel)}"]`) : null; if (!li) return;
      const t = li.offsetTop - listEl.offsetTop, b = t + li.offsetHeight;   // scroll inside the list only, never the page
      if (t < listEl.scrollTop) listEl.scrollTop = t; else if (b > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = b - listEl.clientHeight;
    }

    // ------------------------------------------------------------ select
    function select(id, from) {
      if (id == null) return;
      sel = String(id); flash = null;
      highlight(); markSel(); renderAct();
      c.bus && c.bus.emit('select', { node: sel, from });
    }
    function onSelect(s) {
      if (!s || !s.node || s.from === 'picker' || s.from === 'map') { if (s && s.node) { sel = String(s.node); } return; }
      sel = String(s.node); flash = null;
      highlight(); revealRow(); markSel(); renderAct();
    }
    function toggleFav(id) {
      if (favs.has(id)) favs.delete(id); else { favs.add(id); while (favs.size > FAV_CAP) favs.delete(favs.values().next().value); }
      sset('trFav', [...favs]);
      schedule(true);
    }

    // ------------------------------------------------------------ action panel (Trace button, progress, limits)
    const secs = ms => Math.max(0, Math.ceil(ms / 1000));
    const fmtWait = ms => { const s = secs(ms); return s >= 90 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };
    function limitInfo(now) {
      const l = safe(() => c.limits(), null); if (!l) return { html: '', counting: false };
      const parts = []; let counting = false;
      if (l.nextAt && l.nextAt > now) { parts.push(`<b>Next trace in ${esc(fmtWait(l.nextAt - now))}</b>`); counting = true; }
      const pt = sel && l.perTarget ? l.perTarget[sel] : null;
      if (pt && pt > now && !(l.nextAt && l.nextAt >= pt)) { parts.push(`this station again in ${esc(fmtWait(pt - now))}`); counting = true; }
      if (!l.ok && l.reason) parts.push(esc(l.reason));
      const u = l.used || {}, cp = l.caps || {};
      const used = cp.tenMin ? `<span class="tr-pk-used" title="Runs used / allowed: shared airtime, good amateur practice">${u.tenMin ?? 0}/${cp.tenMin} in 10 min · ${u.hour ?? 0}/${cp.hour ?? '?'} per hour · floods ${u.flood10 ?? 0}/${cp.flood10 ?? '?'}</span>` : '';
      return { html: parts.length || used ? `<div class="tr-pk-limit${l.ok === false ? ' tr-blocked' : ''}">${parts.length ? `<span>⏳ ${parts.join(' · ')}</span>` : ''}${used}</div>` : '', counting };
    }
    function renderAct() {
      if (destroyed) return;
      const now = Date.now(), cur = safe(() => c.current(), null), pending = !!(cur && cur.status === 'pending');
      const n = nodeOf(sel), lim = limitInfo(now);
      let counting = lim.counting, h = '';
      if (pending) {
        const name = cur.targetName || (nodeOf(cur.target) || {}).name || 'the station';
        const left = cur.sentAt && cur.timeoutMs ? cur.sentAt + cur.timeoutMs - now : null;
        if (left != null) counting = true;
        h += `<div class="tr-pk-run"><div class="tr-pk-runh"><span class="tr-pk-runic" aria-hidden="true">${cur.method === 'discover' ? '🧭' : cur.method === 'ping' ? '📨' : '☄️'}</span>`
          + `<span><b>${cur.method === 'discover' ? 'Discovering a path to' : cur.method === 'ping' ? 'Pinging' : 'Tracing'} ${esc(name)}</b><br>`
          + `<span class="dim">${esc(PHASE_LABEL[cur.phase] || cur.phase || 'pending')}${cur.tries > 1 ? ` · try ${esc(cur.attempt)} of ${esc(cur.tries)}` : ''}`
          + `${left != null ? ` · gives up in <b class="tr-pk-cd">${esc(fmtWait(left))}</b>` : cur.sentAt ? '' : ' · waiting to send'}</span></span></div>`
          + `<button type="button" class="btn tr-pk-cancel">✖ Cancel</button></div>`;
      }
      if (n) {
        if (method === 'ping' && !n.canPing) method = 'auto';
        const reason = pending ? 'A trace is running: wait for it, or cancel it.' : safe(() => c.canTrace(n.id, { method }), 'the trace engine is not ready');
        h += `<div class="tr-pk-sel"><span class="tr-pk-ic" aria-hidden="true">${ROLE_ICON[n.role] || '❔'}</span><span class="tr-pk-seln"><b>${esc(n.name || n.id)}</b>`
          + `<span class="dim small">${esc(roleText(n.role))}${n.canTrace ? '' : n.why ? ' · ' + esc(n.why) : ''}</span>`
          + (n.sends && n.sends.size === 1 ? `<span class="tr-pk-1bnote"><span class="tag bad tr-pk-1b">1-byte</span> ${esc(ONE_BYTE)}${n.sends.strength === 'likely' ? ' (likely: seen in its messages)' : ''}</span>` : '')
          + `</span>${qrOf(n) ? `<button type="button" class="btn small ghost tr-pk-qr" title="Show this station's contact QR (MeshCore app form)" aria-label="Show this station's QR code">▦</button>` : ''}</div>`
          + `<div class="tr-pk-meth" role="radiogroup" aria-label="Method">${METHODS.filter(([m]) => m !== 'ping' || n.canPing).map(([m, l, t]) => `<button type="button" role="radio" class="tr-pk-m${m === method ? ' tr-on' : ''}" data-m="${m}" aria-checked="${m === method}" title="${esc(t)}">${l}</button>`).join('')}</div>`
          + `<button type="button" class="btn primary tr-pk-go"${reason ? ' disabled aria-disabled="true"' : ''} aria-describedby="tr-pk-why">${method === 'discover' ? '🧭 Discover path' : method === 'ping' ? '📨 Send ping' : '🔭 Trace route'}</button>`
          + `<div class="tr-pk-why${reason ? ' tr-no' : ''}" id="tr-pk-why">${reason ? esc(reason) : flash && flash.until > now ? esc(flash.text) : ''}</div>`;
        if (flash && flash.until > now) counting = true;
      } else if (!pending) {
        h += `<div class="tr-pk-hint dim">Pick a station below${map ? ' or on the map' : ''} to trace the route to it and back.</div>`;
      }
      h += lim.html;
      const fa = document.activeElement, fsel = fa && actEl.contains(fa) ? (fa.dataset.m ? `[data-m="${fa.dataset.m}"]` : fa.classList.contains("tr-pk-cancel") ? ".tr-pk-cancel" : fa.classList.contains("tr-pk-go") ? ".tr-pk-go" : null) : null;
      actEl.innerHTML = h;   // the focused control is found again: this redraws once a second while counting down
      if (fsel) { const f = actEl.querySelector(fsel); if (f && !f.disabled) f.focus({ preventScroll: true }); }
      ticking(counting);
    }
    function ticking(need) {
      if (need && vis() && !destroyed) { if (!tick) tick = setInterval(() => { if (!vis() || destroyed) return ticking(false); renderAct(); }, 1000); }
      else if (tick) { clearInterval(tick); tick = null; }
    }
    function go() {
      if (!sel) return;
      if (method === 'ping' && !safe(() => c.demo(), false) && !sget('trPingOk', false)) {
        const n = nodeOf(sel);
        if (!confirm(`Ping sends a short message to ${n ? n.name : 'this station'}'s inbox ("Trace Route ping -- no reply needed") and waits for the ACK. It shows in your chat too.\n\nSend pings? (Kelly won't ask again.)`)) return;
        sset('trPingOk', true);
      }
      const r = safe(() => c.trace(sel, { method }), { ok: false, reason: 'the trace engine did not answer' }) || { ok: false, reason: 'the trace engine did not answer' };
      flash = r.ok ? null : { text: r.reason || 'refused', until: Date.now() + 8000 };
      renderAct();
      if (!r.ok && flash) { const w = actEl.querySelector('.tr-pk-why'); if (w) { w.textContent = flash.text; w.classList.add('tr-no'); } }
    }

    // ------------------------------------------------------------ map
    const L = window.L;
    let map = null, fitted = false;
    const markers = new Map();   // id -> { m, lat, lon }
    let meMarker = null;
    try { map = L ? c.makeMap(mapBox, true, null) : null; } catch (e) { console.warn('tr-picker map', e); map = null; }
    // no key on purpose: app.js makeMap's key runs fitOnce(), which fits to the P25 radios, not mesh stations
    if (!map) mapWrap.hidden = true;
    const okPos = (lat, lon) => lat != null && lon != null && isFinite(lat) && isFinite(lon) && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    const ROLE_COL = { repeater: '#ff2bd6', room: '#ffb020', companion: '#3ba8ff', sensor: '#39ff88' };
    function mkStyle(n, on) {
      const col = ROLE_COL[n.role] || '#8394b8';
      return { radius: on ? 9 : favs.has(n.id) ? 7 : 6, color: on ? '#ffffff' : col, weight: on ? 3 : 1.5, fillColor: col, fillOpacity: on ? 0.95 : 0.7, opacity: 1 };
    }
    function syncMap(all) {
      if (!map || !L) return;
      try {
        const keep = new Set();
        let cnt = 0;
        for (const n of all) {
          if (!okPos(n.lat, n.lon)) continue;
          keep.add(n.id); cnt++;
          let mk = markers.get(n.id);
          if (!mk) {
            const m = L.circleMarker([n.lat, n.lon], Object.assign(mkStyle(n, n.id === sel), { className: 'tr-pk-mk' })).addTo(map);
            m.on('click', () => { try { select(n.id, 'map'); revealRow(); } catch (e) { console.warn('tr-picker', e); } });
            mk = { m, lat: n.lat, lon: n.lon }; markers.set(n.id, mk);
          } else if (mk.lat !== n.lat || mk.lon !== n.lon) { mk.m.setLatLng([n.lat, n.lon]); mk.lat = n.lat; mk.lon = n.lon; }
          mk.m.setStyle(mkStyle(n, n.id === sel));
          mk.m.bindTooltip(`${ROLE_ICON[n.role] || '❔'} ${esc(n.name || n.id)}`, { direction: 'top' });
        }
        for (const [id, mk] of markers) if (!keep.has(id)) { mk.m.remove(); markers.delete(id); }
        const me = safe(() => c.myPos(), null);
        if (me && okPos(me.lat, me.lon)) {
          if (!meMarker) meMarker = L.circleMarker([me.lat, me.lon], { radius: 7, color: '#00e5ff', weight: 3, fillColor: '#eaf6ff', fillOpacity: 1, interactive: false, className: 'tr-pk-me' }).addTo(map);
          else meMarker.setLatLng([me.lat, me.lon]);
        } else if (meMarker) { meMarker.remove(); meMarker = null; }
        const cEl = q('.tr-pk-mapcount'); if (cEl) cEl.textContent = `(${cnt} with GPS)`;
        if (!fitted && mapOpen && markers.size && mapBox.clientWidth > 50 && mapBox.clientHeight > 50) fit();
      } catch (e) { console.warn('tr-picker map', e); }
    }
    function fit() {
      if (!map) return;
      const pts = [...markers.values()].map(mk => [mk.lat, mk.lon]);
      if (meMarker) { const p = meMarker.getLatLng(); pts.push([p.lat, p.lng]); }
      if (!pts.length) return;
      try { map.fitBounds(pts, { padding: [18, 18], maxZoom: 12 }); fitted = true; } catch (e) { /* hidden box */ }
    }
    function markSel() {
      if (!map) return;
      for (const [id, mk] of markers) { const n = byId.get(id); if (n) try { mk.m.setStyle(mkStyle(n, id === sel)); if (id === sel) mk.m.bringToFront(); } catch (e) { /* ignore */ } }
    }
    function setMapOpen(open) {
      mapOpen = open; mapWrap.classList.toggle('tr-closed', !open); mapTog.setAttribute('aria-expanded', String(open));
      if (open && map) setTimeout(() => { if (destroyed) return; try { map.invalidateSize(); } catch (e) { /* ignore */ } if (!fitted) fit(); }, 60);
    }
    setMapOpen(mapOpen);

    // ▦ the target's contact QR: only with its full 32-byte key and a known type (1-4) -- never a hash-only hop
    function qrOf(n) {
      const key = n && n.key ? String(n.key).toLowerCase() : '', type = n ? +n.roleId : 0;
      return window.KellyMeshQR && /^[0-9a-f]{64}$/.test(key) && type >= 1 && type <= 4 ? { key, type, name: n.nodeName != null ? n.nodeName : n.name || '' } : null;
    }
    function showQr(n) {
      const q = qrOf(n); if (!q) return;
      safe(() => window.KellyMeshQR.ui({ toast: c.toast }).show({ contact: q, note: 'Scan it with the MeshCore app (or Kelly) to add this station as a contact.' }), null);
    }

    // ------------------------------------------------------------ events
    function onClick(e) {
      const t = e.target.closest ? e.target.closest('button') : null; if (destroyed || !t || !mount.contains(t)) return;
      if (t.dataset.star) return toggleFav(t.dataset.star);
      if (t.classList.contains('tr-pk-pick')) return select(t.dataset.id, 'picker');
      if (t.dataset.tab) { tab = t.dataset.tab; for (const b of mount.querySelectorAll('.tr-pk-chip')) b.setAttribute('aria-pressed', String(b === t)); listEl.scrollTop = 0; return schedule(true); }
      if (t.dataset.m) { method = t.dataset.m; flash = null; return renderAct(); }
      if (t.classList.contains('tr-pk-go')) return go();
      if (t.classList.contains('tr-pk-qr')) return showQr(nodeOf(sel));
      if (t.classList.contains('tr-pk-cancel')) { safe(() => c.cancel(), null); return renderAct(); }
      if (t === mapTog) return setMapOpen(!mapOpen);
      if (t.classList.contains('tr-pk-demo')) { const d = document.getElementById('tr-demo-btn'); if (d) d.click(); }
    }
    mount.addEventListener('click', onClick);
    let qTimer = null;
    qEl.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { query = qEl.value.trim(); listEl.scrollTop = 0; schedule(true); }, 120); });
    qEl.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { const f = listEl.querySelector('.tr-pk-pick'); if (f) { e.preventDefault(); f.focus(); } }
      else if (e.key === 'Enter') { const f = listEl.querySelectorAll('.tr-pk-pick'); if (f.length === 1) { e.preventDefault(); select(f[0].dataset.id, 'picker'); } }
    });
    listEl.addEventListener('keydown', e => {
      const b = e.target; if (!b || !b.classList || !(b.classList.contains('tr-pk-pick') || b.classList.contains('tr-pk-star'))) return;
      const li = b.closest('.tr-pk-row'); if (!li) return;
      const star = b.classList.contains('tr-pk-star');
      const go2 = el => { if (el) { e.preventDefault(); const t = el.querySelector(star ? '.tr-pk-star' : '.tr-pk-pick'); if (t) t.focus(); } };
      if (e.key === 'ArrowDown') go2(li.nextElementSibling);
      else if (e.key === 'ArrowUp') { if (li.previousElementSibling) go2(li.previousElementSibling); else { e.preventDefault(); qEl.focus(); } }
      else if (e.key === 'Home') go2(listEl.firstElementChild);
      else if (e.key === 'End') go2(listEl.lastElementChild);
    });

    const guard = fn => x => { try { if (!destroyed) fn(x); } catch (e) { console.warn('tr-picker', e); } };
    const on = (name, fn) => { try { return c.bus ? c.bus.on(name, guard(fn)) : () => {}; } catch (e) { return () => {}; } };
    const unsubs = [
      on('nodes', () => schedule()),
      on('link', () => schedule()),
      on('demo', on => { if (!on) demoRecent = []; sel = safe(() => c.selected(), null) || null; fitted = false; flash = null; schedule(); }),
      on('select', onSelect),
      on('run', () => renderAct()),
      on('limit', () => renderAct()),
      on('done', r => {
        if (r && r.target) {
          const e = { id: String(r.target), name: String(r.targetName || ''), t: r.endedAt || Date.now() };
          if (r.demo) demoRecent = [e].concat(demoRecent.filter(x => x.id !== e.id)).slice(0, RECENT_CAP);
          else { recent = [e].concat(recent.filter(x => x.id !== e.id)).slice(0, RECENT_CAP); sset('trRecent', recent); }
        }
        renderAct();
        if (tab === 'recent') schedule(); else { const e = q('[data-n="recent"]'); if (e) e.textContent = String(rec().length || ''); }
      }),
      on('visible', v => {
        if (!v) return ticking(false);
        if (map && mapOpen) setTimeout(() => { if (destroyed) return; try { map.invalidateSize(); } catch (e) { /* ignore */ } if (!fitted) fit(); }, 60);
        if (dirty) schedule(true); else renderAct();
      }),
    ];

    renderList();

    return {
      destroy() {
        destroyed = true; ticking(false); clearTimeout(renderTimer); clearTimeout(qTimer);
        for (const u of unsubs) try { u(); } catch (e) { /* ignore */ }
        if (map) try { map.remove(); } catch (e) { /* ignore */ }
        markers.clear(); mount.removeEventListener('click', onClick); mount.innerHTML = '';
      },
      _state: () => ({ sel, tab, query, method, favs: [...favs], recent: recent.slice(), rows: listEl.querySelectorAll('.tr-pk-row').length, markers: markers.size, map: !!map, ticking: !!tick, mapOpen }),
    };
  };
})();
