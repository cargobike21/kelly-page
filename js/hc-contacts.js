/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts: contacts on my radio, announce myself, heard-not-added + auto-add
 * (2026-10-24, unreleased). HAM_CONTACTS_PLAN.md agent 1. Coded against js/hc-core.js (the spec) + js/hc-service.js;
 * mounted by js/hc-ui.js, which hands each factory the shared context c (its header lists it).
 *   window.KellyHCContacts(mount, c) -> { destroy() }   #hc-contacts  the node's contact table: search, sort (favourites,
 *     hams with a callsign, last heard), <= 400 rows; per row Share / ▦ QR (KellyMeshQR, its real type 1-4; hidden for
 *     an unknown type) / callsign trust icon (KellyHamCalls.trust) / Favourite / Let-them-discover / Reset path /
 *     Remove (confirmed inline) / Trace / Ping (companions) / Message; a "nearly full" banner; an empty state.
 *   window.KellyHCAnnounce(mount, c) -> { destroy() }   #hc-announce  Advert zero-hop / flood, live rate-limit countdown.
 *   window.KellyHCHeard(mount, c) -> { destroy() }      #hc-heard     heard, not added: Add / dismiss / Add all hams
 *     heard (room-checked, one at a time, Stop); the node's auto-add settings; who may discover a path to you.
 * Every radio button is disabled while its op runs (bus 'op' + state().busy + its own promise) and shows its own Result
 * inline; the shell's status line shows it too. Re-renders at most once a second and only while c.visible(); list
 * boxes are never replaced (scroll kept), focus is put back by data-act / data-key. Countdowns tick once a second only
 * while something counts down and the tab is visible. Nothing animates forever. Results never throw; bus handlers are
 * wrapped. CSS: css/hc-contacts.css (hc-ct- / hc-an- / hc-hd-).
 */
(function () {
  'use strict';

  const MAX_ROWS = 400;
  const fmtWait = ms => { const s = Math.ceil(ms / 1000); if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.ceil((s % 3600) / 60)} min`; if (s >= 60) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; return `${s} s`; };
  const fmtKm = km => (km == null ? '' : km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);
  const hopsText = h => (h == null ? 'no route yet' : h === 0 ? 'direct' : `${h} hop${h === 1 ? '' : 's'}`);
  const snrClass = s => (s == null ? '' : s >= 6 ? 'great' : s >= 0 ? 'good' : s >= -8 ? 'fair' : 'poor');
  const snrPct = s => Math.max(4, Math.min(100, Math.round(((s + 20) / 32) * 100)));
  const resText = r => (!r ? '' : r.ok ? (r.msg || 'Done.') : (r.error || 'Something went wrong.'));

  // what every factory shares: safe calls, a throttled renderer, op tracking, inline results
  function kit(mount, c) {
    const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch (e) { return d; } };
    const esc = c.esc || (s => String(s ?? '').replace(/[&<>"']/g, ch => '&#' + ch.charCodeAt(0) + ';'));
    const fmtAgo = ts => (ts ? safe(() => c.fmtAgo(ts), '') : 'never');
    const vis = () => !!safe(() => c.visible(), false);
    const st = () => safe(() => c.svc.state(), null) || { link: { online: false, via: 'none', why: 'Ham Contacts is not ready.' }, maxContacts: null, count: 0, autoAdd: null, me: null, busy: [], telemetryBase: null };
    const running = new Map();   // lock key -> op name, for ops in flight ('op' events + our own calls)
    const results = new Map();   // slot -> { r, at }: each button's own last Result
    const offs = [];
    let destroyed = false, lastRender = 0, timer = null, dirty = false, renderFn = null;
    const k = {
      safe, esc, fmtAgo, vis, st, running, results, offs,
      get destroyed() { return destroyed; },
      setRender(fn) { renderFn = fn; },
      render() { if (destroyed || !renderFn) return; lastRender = Date.now(); dirty = false; clearTimeout(timer); timer = null; try { renderFn(); } catch (e) { console.warn('Ham Contacts part', e); } },
      // at most once a second; while hidden only mark it dirty (now = right away, e.g. after a click)
      schedule(now) {
        if (destroyed) return;
        if (!vis() && !now) { dirty = true; return; }
        const wait = 1000 - (Date.now() - lastRender);
        if (now || wait <= 0) return k.render();
        if (!timer) timer = setTimeout(() => { timer = null; if (destroyed) return; if (vis()) k.render(); else dirty = true; }, wait);
      },
      on(ev, fn) { const off = safe(() => c.bus.on(ev, x => { try { fn(x); } catch (e) { console.warn('Ham Contacts', ev, e); } }), null); if (off) offs.push(off); },
      // run a service call: mark its lock busy, keep its Result for the slot, never throw
      async call(slot, lock, fn) {
        if (!running.has(lock)) running.set(lock, 'op');
        k.schedule(true);
        let r;
        try { r = await fn(); } catch (e) { r = { ok: false, code: 'error', error: String((e && e.message) || e || 'Something went wrong.') }; }
        if (!r || typeof r !== 'object') r = { ok: true, msg: 'Done.' };
        running.delete(lock);
        if (!destroyed) { results.set(slot, { r, at: Date.now() }); k.schedule(true); }
        return r;
      },
      note(slot, r) { results.set(slot, { r, at: Date.now() }); },
      res(slot, maxAge = 60000) { const x = results.get(slot); if (!x) return null; if (Date.now() - x.at > maxAge) { results.delete(slot); return null; } return x.r; },
      resHtml(slot, cls) { const r = k.res(slot); return r ? `<span class="${cls} ${r.ok ? 'ok' : 'bad'}" role="status">${r.ok ? '✅' : '⚠️'} ${esc(resText(r))}</span>` : ''; },
      busy(lock) { return running.has(lock); },
      opName(name) { const s = st(); return Array.isArray(s.busy) && s.busy.includes(name); },
      // keep focus across a rebuild: remember data-act (+ data-key) of the focused control inside box
      keepFocus(box, build) {
        const a = document.activeElement, inside = a && box.contains(a);
        const act = inside ? a.getAttribute('data-act') : null, key = inside ? a.getAttribute('data-key') : null;
        const top = box.scrollTop;
        build();
        if (box.scrollTop !== top) box.scrollTop = top;
        if (act) {
          const sel = `[data-act="${cssEsc(act)}"]${key ? `[data-key="${cssEsc(key)}"]` : ''}`;
          const f = box.querySelector(sel); if (f && !f.disabled) { try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        }
      },
      destroy() { destroyed = true; clearTimeout(timer); for (const off of offs.splice(0)) { try { off(); } catch (e) { /* ignore */ } } },
      get dirty() { return dirty; },
    };
    // the service's 'op' events keep `running` right for ops other parts (or another tab) started
    k.on('op', e => { if (!e || !e.op) return; const lock = e.key || e.op; if (e.phase === 'start') running.set(lock, e.op); else if (e.phase === 'done') running.delete(lock); k.schedule(); });
    k.on('visible', v => { if (v && dirty) k.schedule(true); });
    k.on('demo', () => { running.clear(); results.clear(); k.schedule(true); });
    return k;
  }
  // the label with the callsign as the boldest thing ("<b>VK4XYZ</b> · Bob's node" / "<b>VK4XXX</b> Tracker")
  // the callsign's trust label (KellyHamCalls.trust, QR_REVIEW.md section 5): ✅ directory · 🖊️ its signed advert ·
  // 👤 you set it · ❔ claimed in an unsigned QR (until its own advert is heard) · ⛔ the directory gives this key another call
  function trustHtml(r, esc) {
    const K = window.KellyHamCalls; if (!r.call || !K || !K.trust) return '';
    let t = null;
    try { const cl = K.claimOf ? K.claimOf(r.key) : null; t = K.trust(r.key, { name: r.name, call: r.callSrc === 'name' ? r.call : null, signed: !(cl != null && cl === r.name) }); } catch { t = null; }
    if (!t || !t.icon) return '';
    return ` <span class="hc-ct-trust" title="${esc(t.text + (t.info ? ` ${t.info}` : ''))}" aria-label="${esc(t.text)}">${esc(t.icon)}</span>`;
  }
  function nameHtml(r, esc) {
    const l = esc(r.label || r.short || '?');
    if (!r.call) return l;
    let hit = false;
    const out = l.replace(new RegExp(`\\b${r.call}\\b`, 'i'), m => { hit = true; return `<b class="hc-ct-call">${m}</b>`; });
    return (hit ? out : `<b class="hc-ct-call">${esc(r.call)}</b> · ${l}`) + trustHtml(r, esc);
  }
  const cssEsc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  function copyText(t) {
    if (window.KellyMeshQR && window.KellyMeshQR.copy) return window.KellyMeshQR.copy(t).catch(() => false);   // the shared clipboard helper
    return new Promise(res => {
      const fallback = () => {
        try { const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); res(!!ok); } catch (e) { res(false); }
      };
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => res(true), fallback); else fallback(); } catch (e) { fallback(); }
    });
  }

  // ================================================================ 1. Contacts on my radio
  window.KellyHCContacts = function (mount, c) {
    if (!mount || !c || !c.svc) return { destroy() {} };
    const k = kit(mount, c), esc = k.esc;
    let query = '', confirmKey = null, qTimer = null, tickT = null, qrUi = null;
    mount.innerHTML = `<div class="card hc-ct">
      <div class="card-h"><h2>Contacts on my radio</h2><span class="tag hc-ct-count" data-r="count">–</span></div>
      <div class="hc-ct-banner" data-r="banner" hidden></div>
      <div class="hc-ct-find"><input type="search" class="hc-ct-q" data-act="q" placeholder="Search name, callsign or key…" aria-label="Search contacts" autocomplete="off" spellcheck="false">
        <span class="hc-ct-sorthint">⭐ favourites first, then hams with a callsign, then last heard</span></div>
      <ul class="hc-ct-list" data-r="list" aria-label="Contacts on your node"></ul>
      <p class="hc-ct-more" data-r="more"></p></div>`;
    const q = s => mount.querySelector(s);
    const listEl = q('[data-r="list"]'), qEl = q('.hc-ct-q');

    function sorted(list) {
      const n = query.toLowerCase();
      const hit = r => !n || (r.label || '').toLowerCase().includes(n) || (r.name || '').toLowerCase().includes(n) || (r.call || '').toLowerCase().includes(n) || (r.key || '').startsWith(n);
      return list.filter(r => r && r.key && hit(r)).sort((a, b) => (b.fav - a.fav) || (!!b.call - !!a.call) || ((b.lastHeard || 0) - (a.lastHeard || 0)) || String(a.label).localeCompare(String(b.label)));
    }
    function rowHtml(r, s) {
      const key = esc(r.key), lockBusy = k.running.has(r.key);
      const online = s.link.online, dis = !online || lockBusy ? ' disabled' : '';
      const shareW = k.safe(() => c.svc.shareWait(), 0) || 0;
      const callBits = nameHtml(r, esc);
      const snr = r.snr != null ? `<span class="hc-ct-snr ${snrClass(r.snr)}" title="Last heard direct at ${r.snr.toFixed(1)} dB SNR"><span class="hc-ct-bar"><i style="width:${snrPct(r.snr)}%"></i></span>${r.snr.toFixed(1)} dB</span>` : '<span class="hc-ct-snr none" title="Kelly has not heard it direct">no signal yet</span>';
      const working = lockBusy ? `<span class="hc-ct-res work" role="status">⏳ working…${k.running.get(r.key) === 'remove' ? ' A remove can take up to 90 s if the radio restarts itself.' : ''}</span>` : '';
      const confirm = confirmKey === r.key
        ? `<div class="hc-ct-confirm" role="alert">Remove <b>${esc(r.label)}</b> from your radio? DMs and traces to them stop working until it's added again.
            <button class="btn small danger" data-act="rm-yes" data-key="${key}"${dis}>🗑 Yes, remove</button><button class="btn small ghost" data-act="rm-no" data-key="${key}">Cancel</button></div>` : '';
      return `<li class="hc-ct-row${r.fav ? ' fav' : ''}" data-key="${key}">
        <span class="hc-ct-icon" title="${esc(r.typeName)}" aria-hidden="true">${r.icon}</span>
        <div class="hc-ct-main">
          <div class="hc-ct-name">${callBits}${r.fav ? ' <span class="hc-ct-star" title="Favourite">⭐</span>' : ''}</div>
          <div class="hc-ct-meta"><span>${esc(r.typeName)}</span>
            <button class="hc-ct-key" data-act="copy" data-key="${key}" title="Copy the full public key: ${key}">${esc(r.short)}</button>
            <span title="Last heard">🕘 ${esc(k.fmtAgo(r.lastHeard))}</span>
            <span class="${r.hops == null ? 'hc-ct-noroute' : ''}" title="${r.hops == null ? 'The node has no route: the next message floods and finds one' : 'Hops on the route your node has learned'}">${hopsText(r.hops)}</span>
            ${r.km != null ? `<span>📍 ${esc(fmtKm(r.km))}</span>` : ''}${r.letsDiscover ? '<span class="tag ok hc-ct-disc" title="They may run a path discovery to you">🔍 may discover</span>' : ''}</div>
        </div>
        ${snr}
        <div class="hc-ct-acts">
          <button class="btn small" data-act="share" data-key="${key}"${dis || (shareW > 0 ? ' disabled' : '')} title="Introduce: re-send their advert zero-hop so hams who hear you directly can add them">📣 ${shareW > 0 ? `<span data-r="sharew">${fmtWait(shareW)}</span>` : 'Share'}</button>
          ${[1, 2, 3, 4].includes(r.type) ? `<button class="btn small ghost" data-act="qr" data-key="${key}" title="Show ${esc(r.label)}'s contact QR (${esc(r.typeName)}) for someone to scan">▦</button>` : ''}
          <button class="btn small${r.fav ? ' primary' : ''}" data-act="fav" data-key="${key}"${dis} aria-pressed="${r.fav}" title="${r.fav ? 'Favourite: never overwritten when the table is full. Press to unmark' : 'Mark as a favourite: never overwritten when the table is full'}">⭐</button>
          <button class="btn small${r.letsDiscover ? ' primary' : ''}" data-act="disc" data-key="${key}"${dis} aria-pressed="${r.letsDiscover}" title="Let them discover a path to me (they can read your base telemetry)">🔍</button>
          <button class="btn small" data-act="reset" data-key="${key}"${dis} title="Reset path: forget the route; the next message floods and learns a fresh one">↺</button>
          <button class="btn small danger" data-act="rm" data-key="${key}"${dis} title="Remove from your radio">🗑</button>
          <button class="btn small ghost" data-act="trace" data-key="${key}" title="Trace Route to them">🔭</button>
          ${r.type === 1 ? `<button class="btn small ghost" data-act="ping" data-key="${key}" title="Ping: a short DM and its ACK (they must have you as a contact)">📶</button>` : ''}
          <button class="btn small ghost" data-act="chat" data-key="${key}" title="Message them">💬</button>
        </div>
        ${confirm}${working || k.resHtml(r.key, 'hc-ct-res')}
      </li>`;
    }
    function emptyHtml(s) {
      if (!s.link.online) return `<li class="hc-ct-empty"><p><b>No node connected.</b> ${esc(s.link.why || 'Connect your MeshCore companion node on the Mesh tab.')}</p><p class="dim">Or press 🎲 Demo at the top to try every button with a pretend node.</p></li>`;
      if (query) return `<li class="hc-ct-empty"><p class="dim">No contact matches "${esc(query)}".</p></li>`;
      return `<li class="hc-ct-empty"><p><b>Your node has no contacts yet.</b> Nothing private (messages, pings, traces) works until both stations have each other.</p>
        <p class="dim">Send a 📢 advert so hams with auto-add on save you; add stations from "Heard, not added"; swap contact cards; or use the P25X ham directory. Then ask them to add you too.</p></li>`;
    }
    function render() {
      const s = k.st(), all = k.safe(() => c.svc.contacts(), []) || [], list = sorted(all), rows = list.slice(0, MAX_ROWS);
      q('[data-r="count"]').textContent = s.link.online ? (s.maxContacts ? `${s.count} / ${s.maxContacts}` : String(s.count)) : '–';
      const ban = q('[data-r="banner"]'), max = s.maxContacts;
      if (s.link.online && max && s.count >= max * 0.9) {
        ban.hidden = false; ban.className = `hc-ct-banner${s.count >= max ? ' full' : ''}`;
        ban.textContent = s.count >= max
          ? `⚠️ Your node is full (${s.count} of ${max}). New stations can't be added until you remove some${s.autoAdd && s.autoAdd.overwrite ? ' -- or auto-add overwrites the oldest non-favourite' : ''}. ⭐ your hams so they're never pushed out.`
          : `⚠️ Your node is nearly full: ${s.count} of ${max} contacts. Remove ones you no longer need, and ⭐ your hams so overwrite-oldest never drops them.`;
      } else ban.hidden = true;
      if (confirmKey && !all.some(r => r.key === confirmKey)) confirmKey = null;
      k.keepFocus(listEl, () => { listEl.innerHTML = rows.length ? rows.map(r => rowHtml(r, s)).join('') : emptyHtml(s); });
      q('[data-r="more"]').textContent = list.length > MAX_ROWS ? `+${list.length - MAX_ROWS} more: narrow the search to see them` : '';
      tick();
    }
    // the share countdown: once a second, only while waiting and visible; updates the labels in place
    function tick() {
      clearTimeout(tickT); tickT = null;
      const w = k.safe(() => c.svc.shareWait(), 0) || 0;
      if (w <= 0 || !k.vis() || k.destroyed) return;
      tickT = setTimeout(() => {
        tickT = null; if (k.destroyed) return;
        const w2 = k.safe(() => c.svc.shareWait(), 0) || 0, els = listEl.querySelectorAll('[data-r="sharew"]');
        if (w2 <= 0 || !els.length) return k.schedule(true);
        els.forEach(e => { e.textContent = fmtWait(w2); });
        tick();
      }, 1000 - (w % 1000 || 0) + 20);
    }
    k.setRender(render);

    async function act(a, key, btn) {
      const r = k.safe(() => c.svc.get(key), null);
      if (a === 'copy') { const done = await copyText(key); k.note(key, done ? { ok: true, msg: `Copied ${r ? r.label : 'the'}'s full public key.` } : { ok: false, code: 'error', error: 'Could not copy: select the key in the tooltip instead.' }); return k.schedule(true); }
      if (a === 'qr') {   // that contact's own key, name and REAL type (a repeater stays 2, a room 3): screen only
        if (!r || ![1, 2, 3, 4].includes(r.type)) { k.note(key, { ok: false, code: 'refused', error: 'Kelly does not know what kind of node that is, so it cannot make its QR.' }); return k.schedule(true); }
        if (!qrUi && window.KellyMeshQR) qrUi = window.KellyMeshQR.ui({ toast: (...x) => { try { c.toast(...x); } catch { /* */ } } });
        if (!qrUi) { k.note(key, { ok: false, code: 'error', error: 'The QR code drawer did not load -- reload Kelly.' }); return k.schedule(true); }
        qrUi.show({ title: `▦ ${r.label}`, contact: { key: r.key, type: r.type, name: r.name }, note: 'from the contacts on your radio' });
        return;
      }
      if (a === 'trace' || a === 'ping') {
        const o = k.safe(() => c.openTrace(key, a === 'ping' ? 'ping' : 'auto'), null) || { ok: true };
        k.note(key, o.ok === false ? { ok: false, code: 'refused', error: o.reason || 'Trace Route could not start.' } : { ok: true, msg: a === 'ping' ? 'Ping started in Trace Route.' : 'Opened in Trace Route.' });
        return k.schedule(true);
      }
      if (a === 'chat') {
        if (k.safe(() => c.demo(), false)) k.note(key, { ok: false, code: 'refused', error: 'Messages need your real node: turn the demo off.' });
        else if (!r || r.num == null) k.note(key, { ok: false, code: 'refused', error: 'Kelly has no chat for that station yet -- it needs to be heard first.' });
        else { k.safe(() => c.openChat(key)); k.note(key, { ok: true, msg: 'Opened the chat on the Mesh tab.' }); }
        return k.schedule(true);
      }
      if (a === 'rm') { confirmKey = key; return k.schedule(true); }
      if (a === 'rm-no') { confirmKey = null; return k.schedule(true); }
      if (k.busy(key)) return;
      if (a === 'rm-yes') { confirmKey = null; k.running.set(key, 'remove'); return k.call(key, key, () => c.svc.remove(key)); }
      if (a === 'share') return k.call(key, key, () => c.svc.share(key));
      if (a === 'fav') return k.call(key, key, () => c.svc.setFav(key, !(r && r.fav)));
      if (a === 'disc') return k.call(key, key, () => c.svc.allowDiscover(key, !(r && r.letsDiscover)));
      if (a === 'reset') return k.call(key, key, () => c.svc.resetPath(key));
      void btn;
    }
    const onClick = e => {
      const b = e.target.closest && e.target.closest('[data-act]'); if (!b || !mount.contains(b) || b.disabled) return;
      const a = b.getAttribute('data-act'), key = b.getAttribute('data-key'); if (!key || a === 'q') return;
      act(a, key, b);
    };
    mount.addEventListener('click', onClick);
    const onInput = () => { clearTimeout(qTimer); qTimer = setTimeout(() => { query = qEl.value.trim(); listEl.scrollTop = 0; k.schedule(true); }, 120); };
    qEl.addEventListener('input', onInput);
    for (const ev of ['contacts', 'state', 'calls', 'advert']) k.on(ev, () => k.schedule());
    k.on('visible', v => { if (v) tick(); });
    k.render();
    return {
      destroy() { k.destroy(); clearTimeout(qTimer); clearTimeout(tickT); mount.removeEventListener('click', onClick); qEl.removeEventListener('input', onInput); },
      _render: () => k.render(), _query: v => { qEl.value = v; query = String(v).trim(); k.render(); },
    };
  };

  // ================================================================ 2. Announce myself
  window.KellyHCAnnounce = function (mount, c) {
    if (!mount || !c || !c.svc) return { destroy() {} };
    const k = kit(mount, c), esc = k.esc;
    let tickT = null;
    const MODES = [
      ['local', '📢 Advert (local)', 'Zero-hop: only stations that hear you directly get it. Cheap -- use it any time.'],
      ['flood', '📡 Advert (flood)', 'Flood: every repeater passes it on, so hams across the network can add you. Costs everyone\'s shared airtime -- use sparingly.'],
    ];
    mount.innerHTML = `<div class="card hc-an"><div class="card-h"><h2>Announce myself</h2></div>
      <p class="hc-an-why dim">An advert carries your node's public key. Hams whose radio has auto-add on save you as a contact straight away; others see you under "Heard".</p>
      <div class="hc-an-modes" data-r="modes"></div></div>`;
    const box = mount.querySelector('[data-r="modes"]');
    function render() {
      const s = k.st(), on = s.link.online, anyAdv = k.opName('advert');
      k.keepFocus(box, () => {
        box.innerHTML = MODES.map(([m, label, why]) => {
          const w = on ? (k.safe(() => c.svc.advertWait(m), 0) || 0) : 0, run = k.busy(`advert:${m}`) || anyAdv;
          return `<div class="hc-an-mode hc-an-${m}">
            <button class="btn${m === 'local' ? ' primary' : ''} hc-an-btn" data-act="adv-${m}"${!on || run || w > 0 ? ' disabled' : ''}>${label}${w > 0 ? ` · <span data-r="w-${m}">${fmtWait(w)}</span>` : run ? ' · sending…' : ''}</button>
            <p class="hc-an-note">${esc(why)}</p>${k.resHtml(m, 'hc-an-res')}</div>`;
        }).join('') + (on ? '' : `<p class="hc-an-off dim">${esc(s.link.why || 'Connect your node first.')}</p>`);
      });
      tick();
    }
    function tick() {
      clearTimeout(tickT); tickT = null;
      if (k.destroyed || !k.vis() || !k.st().link.online) return;
      const ws = MODES.map(([m]) => k.safe(() => c.svc.advertWait(m), 0) || 0);
      if (!ws.some(w => w > 0)) return;
      tickT = setTimeout(() => {
        tickT = null; if (k.destroyed) return;
        let reopen = false;
        MODES.forEach(([m], i) => {
          const w = k.safe(() => c.svc.advertWait(m), 0) || 0, e = box.querySelector(`[data-r="w-${m}"]`);
          if (ws[i] > 0 && w <= 0) reopen = true; else if (e) e.textContent = fmtWait(w);
        });
        if (reopen) k.schedule(true); else tick();
      }, 1000);
    }
    k.setRender(render);
    const onClick = e => {
      const b = e.target.closest && e.target.closest('[data-act]'); if (!b || !mount.contains(b) || b.disabled) return;
      const m = (b.getAttribute('data-act') || '').replace(/^adv-/, ''); if (m !== 'local' && m !== 'flood') return;
      if (k.busy(`advert:${m}`)) return;
      k.call(m, `advert:${m}`, () => c.svc.advert(m));
    };
    mount.addEventListener('click', onClick);
    for (const ev of ['state', 'advert']) k.on(ev, () => k.schedule());
    k.on('visible', v => { if (v) tick(); });
    k.render();
    return { destroy() { k.destroy(); clearTimeout(tickT); mount.removeEventListener('click', onClick); }, _render: () => k.render() };
  };

  // ================================================================ 3. Heard, not added + auto-add + discovery
  window.KellyHCHeard = function (mount, c) {
    if (!mount || !c || !c.svc) return { destroy() {} };
    const k = kit(mount, c), esc = k.esc;
    const hidden = new Map();   // key -> dismissed at (a 'seen' station can't be forgotten by the service: hide it here)
    let batch = null;           // { keys, i, added, already, failed: [], stop, cur, done }
    let offer = null;           // { n, keys, warn, fit } -- the room check before "Add all hams heard"
    const SRC = { advert: ['heard its advert', 'Your node passed on its advert but did not keep it'], seen: ['known to Kelly', 'Kelly heard it earlier (another session or a packet) -- it is not on your node'],
      card: ['card kept as heard', 'You imported its card but your node kept it only as a heard advert'], dir: ['directory', 'From the P25X ham directory'] };
    const TYPES = [['companion', '📱 Companions', 'phones and handhelds -- other hams'], ['repeater', '📡 Repeaters', 'needed to trace through them'],
      ['room', '🏛️ Room servers', 'shared chat rooms / BBS'], ['sensor', '🌡️ Sensors', 'telemetry nodes']];
    const BASE = [[0, 'Nobody', 'the firmware default: nobody can discover a path to you'], [1, 'Contacts I allow', 'only contacts you switch 🔍 on, in Contacts on my radio'],
      [2, 'Anyone', 'any station may discover a path to you (and read your battery level)']];
    mount.innerHTML = `<div class="card hc-hd"><div class="card-h"><h2>Heard, not added</h2><span class="tag" data-r="n">0</span></div>
      <p class="hc-hd-why dim">Stations your node heard (or Kelly knows) that are not in its contacts. Add the hams you want to talk to.</p>
      <div class="hc-hd-bulk" data-r="bulk"></div>
      <ul class="hc-hd-list" data-r="list" aria-label="Heard stations not on your node"></ul>
      <details class="hc-hd-auto" open><summary>Auto-add on your node</summary><div data-r="auto"></div></details>
      <details class="hc-hd-tel"><summary>Who may discover a path to you</summary><div data-r="tel"></div></details></div>`;
    const q = s => mount.querySelector(s), uid = Math.random().toString(36).slice(2, 8);
    const listEl = q('[data-r="list"]'), bulkEl = q('[data-r="bulk"]'), autoEl = q('[data-r="auto"]'), telEl = q('[data-r="tel"]');
    if (c.opsTable) {   // 📡 Heard operators (js/hc-ops.js) shows every station; this box keeps the bulk add + the settings
      q('.card-h h2').textContent = 'Add hams · auto-add';
      q('.hc-hd-why').textContent = 'Every station heard is in Heard operators above. Here: add all hams heard at once, and what your node saves by itself.';
      listEl.hidden = true;
    }
    const heard = () => (k.safe(() => c.svc.heard(), []) || []).filter(r => r && r.key && !(hidden.has(r.key) && (r.lastHeard || 0) <= hidden.get(r.key)))
      .sort((a, b) => (!!b.call - !!a.call) || ((b.lastHeard || 0) - (a.lastHeard || 0)));

    function rowHtml(r, s) {
      const key = esc(r.key), run = k.busy(r.key) || (batch && !batch.done && batch.cur === r.key), src = SRC[r.src] || null;
      const dis = !s.link.online || run || (batch && !batch.done) ? ' disabled' : '';
      return `<li class="hc-hd-row" data-key="${key}"><span class="hc-hd-icon" title="${esc(r.typeName)}" aria-hidden="true">${r.icon}</span>
        <div class="hc-hd-main"><div class="hc-hd-name">${nameHtml(r, esc)}</div>
          <div class="hc-hd-meta"><span>${esc(r.typeName)}</span><span class="hc-hd-key" title="${key}">${esc(r.short)}</span><span>🕘 ${esc(k.fmtAgo(r.lastHeard))}</span>
            ${r.snr != null ? `<span class="hc-hd-snr ${snrClass(r.snr)}">${r.snr.toFixed(1)} dB</span>` : ''}${r.km != null ? `<span>📍 ${esc(fmtKm(r.km))}</span>` : ''}
            ${src ? `<span class="tag hc-hd-src" title="${esc(src[1])}">${esc(src[0])}</span>` : ''}</div></div>
        <div class="hc-hd-acts"><button class="btn small primary" data-act="add" data-key="${key}"${dis}>${run ? '⏳ Adding…' : '➕ Add'}</button>
          <button class="btn small ghost" data-act="dismiss" data-key="${key}"${run ? ' disabled' : ''} title="Dismiss: hide it until it is heard again">✕</button></div>
        ${k.resHtml(r.key, 'hc-hd-res')}</li>`;
    }
    function bulkHtml(list, s) {
      const hams = list.filter(r => r.call);
      if (batch && !batch.done) {
        const name = batch.curName ? esc(batch.curName) : '';
        return `<div class="hc-hd-prog" role="status">⏳ Adding ${Math.min(batch.i + 1, batch.keys.length)} of ${batch.keys.length}${name ? `: ${name}` : ''}…
          <span class="hc-hd-progbar"><i style="width:${Math.round((batch.i / batch.keys.length) * 100)}%"></i></span>
          <button class="btn small danger" data-act="stop"${batch.stop ? ' disabled' : ''}>${batch.stop ? 'Stopping…' : '⏹ Stop'}</button></div>`;
      }
      if (offer) {
        return `<div class="hc-hd-offer" role="alert">⚠️ ${esc(offer.warn)}
          ${offer.fit > 0 ? `<button class="btn small primary" data-act="bulk-go" data-n="${offer.fit}">➕ Add ${offer.fit === offer.n ? 'all' : `the first`} ${offer.fit}</button>` : ''}
          <button class="btn small ghost" data-act="bulk-no">Cancel</button></div>`;
      }
      const dis = !s.link.online || !hams.length ? ' disabled' : '';
      return `<button class="btn small" data-act="bulk"${dis} title="Add every heard station that has a callsign, one at a time">➕ Add all hams heard${hams.length ? ` (${hams.length})` : ''}</button>${k.resHtml('bulk', 'hc-hd-res')}`;
    }
    function autoHtml(s) {
      const a = s.autoAdd, run = k.busy('autoAdd') || k.opName('autoAdd'), on = s.link.online;
      if (!on) return `<p class="dim">${esc(s.link.why || 'Connect your node to see its auto-add setting.')}</p>`;
      if (!a) return '<p class="dim">Kelly has not read your node\'s auto-add setting yet -- press ⟳ Refresh at the top.</p>';
      const d = run ? ' disabled' : '', typesKnown = a.bitsKnown !== false && a.types && a.types.companion != null;
      const tdis = run || !typesKnown ? ' disabled' : '';
      return `<label class="chk hc-hd-all"><input type="checkbox" data-act="aa-all"${a.all ? ' checked' : ''}${d}> <b>Auto-add everything</b></label>
        <p class="hc-hd-note">${a.all ? 'On: your node saves every station it hears advertise (the firmware default). Easiest for meeting new hams; a busy mesh fills the table.' : 'Off: only the types ticked below are saved; everything else waits here under "Heard".'}</p>
        <fieldset class="hc-hd-types${a.all ? ' dimmed' : ''}"><legend>While auto-add everything is off, save these automatically${run ? ' <span class="hc-hd-work">⏳ saving…</span>' : ''}</legend>
          ${typesKnown ? '' : '<p class="hc-hd-note">This node\'s firmware has no per-type auto-add.</p>'}
          ${TYPES.map(([t, lbl, note]) => `<label class="chk"><input type="checkbox" data-act="aa-t" data-key="${t}"${a.types && a.types[t] ? ' checked' : ''}${tdis}> ${lbl}</label><span class="hc-hd-note">${esc(note)}</span>`).join('')}
          <label class="chk"><input type="checkbox" data-act="aa-ow"${a.overwrite ? ' checked' : ''}${tdis}> ♻️ Overwrite oldest when full</label><span class="hc-hd-note">a new station replaces the oldest non-favourite (⭐ keeps your hams safe)</span>
          <label class="fld inline hc-hd-hops"><span>Max hops</span><input type="number" min="0" max="64" step="1" data-act="aa-hops" value="${a.maxHops == null ? 0 : a.maxHops}"${tdis}></label><span class="hc-hd-note">1 = direct only, N = up to N-1 hops, 0 = any distance</span>
          ${a.all ? '<p class="hc-hd-note warnish">These only act while "Auto-add everything" is off.</p>' : ''}
        </fieldset>${k.resHtml('auto', 'hc-hd-res')}${cleanHtml(s)}`;
    }
    // stale contact cleanup (hc-service.js cleanup): the bridge's --mesh-prune-days can't run while this Kelly holds the node
    function cleanHtml(s) {
      const cu = s.cleanup || {}, run = k.busy('cleanup') || k.opName('cleanup'), d = run ? ' disabled' : '', days = cu.days || 7;
      const last = cu.last ? `Last run ${esc(k.fmtAgo(cu.last))}: ${cu.skipped ? esc(cu.skipped) : `removed ${cu.removed || 0}${cu.left ? `, ${cu.left} still to go` : ''}`}.` : 'Not run yet.';
      return `<fieldset class="hc-hd-types"><legend>🧹 Clean up old contacts${run ? ' <span class="hc-hd-work">⏳ cleaning…</span>' : ''}</legend>
          <label class="chk"><input type="checkbox" data-act="cu-on"${cu.on ? ' checked' : ''}${d}> Every day, and hourly when nearly full</label><span class="hc-hd-note">removes up to 150 at a time, oldest first -- never a ⭐ favourite</span>
          <label class="fld inline hc-hd-hops"><span>Not heard for</span><input type="number" min="1" max="365" step="1" data-act="cu-days" value="${days}"${d}></label><span class="hc-hd-note">days (repeaters twice that: they're your routes). Ages by your node's own clock.</span>
          <p class="hc-hd-note">${last} <button class="btn small" data-act="cu-now"${d || !s.link.online ? ' disabled' : ''}>🧹 Clean up now</button></p>
        </fieldset>${k.resHtml('cleanup', 'hc-hd-res')}`;
    }
    function telHtml(s) {
      if (!s.link.online) return `<p class="dim">${esc(s.link.why || 'Connect your node first.')}</p>`;
      const run = k.busy('telemetry') || k.opName('telemetry'), cur = s.telemetryBase;
      return `<p class="hc-hd-note">A path discovery to a companion is a base-telemetry request: your node answers it only if you allow it.${cur == null ? ' Kelly could not read this setting from your node.' : ''}</p>
        <div class="hc-hd-base" role="radiogroup" aria-label="Who may discover a path to you">${BASE.map(([m, lbl, note]) => `<label class="chk"><input type="radio" name="hc-hd-base-${uid}" data-act="tel" data-key="${m}"${cur === m ? ' checked' : ''}${run ? ' disabled' : ''}> <b>${lbl}</b></label><span class="hc-hd-note">${esc(note)}</span>`).join('')}</div>
        ${run ? '<p class="hc-hd-work">⏳ saving…</p>' : ''}${k.resHtml('tel', 'hc-hd-res')}`;
    }
    function render() {
      const s = k.st(), list = heard();
      q('[data-r="n"]').textContent = String(list.length);
      k.keepFocus(bulkEl, () => { bulkEl.innerHTML = bulkHtml(list, s); });
      k.keepFocus(listEl, () => {
        listEl.innerHTML = list.length ? list.slice(0, MAX_ROWS).map(r => rowHtml(r, s)).join('')
          : `<li class="hc-hd-empty dim">${s.link.online ? 'Nothing waiting. New stations show up here when auto-add is off (or limited to some types) and they advertise.' : esc(s.link.why || 'No node connected.')}</li>`;
      });
      k.keepFocus(autoEl, () => { autoEl.innerHTML = autoHtml(s); });
      k.keepFocus(telEl, () => { telEl.innerHTML = telHtml(s); });
    }
    k.setRender(render);

    function startOffer() {
      const hams = heard().filter(r => r.call), n = hams.length;
      if (!n) return;
      const rm = k.safe(() => c.svc.room(n), null) || { ok: true, free: null, warn: null };
      if (rm.ok && !rm.warn) return runBatch(hams.map(r => r.key));
      const fit = rm.ok ? n : Math.max(0, Math.min(n, rm.free || 0));
      offer = { n, keys: hams.map(r => r.key), warn: rm.ok ? rm.warn : `${rm.warn}${fit > 0 ? ` Kelly can add the first ${fit} (newest heard first).` : ''}`, fit };
      k.schedule(true);
    }
    async function runBatch(keys) {
      offer = null;
      const b = batch = { keys, i: 0, added: 0, already: 0, failed: [], stop: false, cur: null, curName: '', done: false };
      k.schedule(true);
      for (; b.i < keys.length && !b.stop && !k.destroyed; b.i++) {
        const key = keys[b.i], rec = k.safe(() => c.svc.get(key), null);
        b.cur = key; b.curName = rec ? rec.label : key.slice(0, 8); k.schedule(true);
        let r = await k.call(key, key, () => c.svc.add(key));
        if (r && !r.ok && r.code === 'timeout' && !b.stop) r = await k.call(key, key, () => c.svc.add(key));   // one retry: a lost answer
        if (r && r.ok) { if (r.value && r.value.already) b.already++; else b.added++; }
        else { b.failed.push({ key, name: b.curName, error: resText(r) }); if (r && (r.code === 'full' || r.code === 'offline')) { b.stop = true; b.i++; break; } }
      }
      b.done = true; b.cur = null;
      const left = keys.length - b.i;
      const parts = [`Added ${b.added}`]; if (b.already) parts.push(`${b.already} already there`); if (b.failed.length) parts.push(`${b.failed.length} failed (${b.failed[0].name}: ${b.failed[0].error})`); if (left > 0) parts.push(`${left} not tried (stopped)`);
      const sum = { ok: !b.failed.length, code: b.failed.length ? 'error' : undefined, msg: `${parts.join(', ')}.`, error: `${parts.join(', ')}.`, value: { added: b.added, already: b.already, failed: b.failed.length, left } };
      k.note('bulk', sum); k.safe(() => c.say(sum));
      k.schedule(true);
      return sum;
    }
    const onClick = e => {
      const b = e.target.closest && e.target.closest('[data-act]'); if (!b || !mount.contains(b) || b.disabled) return;
      const a = b.getAttribute('data-act'), key = b.getAttribute('data-key');
      if (a === 'add' && key) { if (!k.busy(key)) k.call(key, key, () => c.svc.add(key)); return; }
      if (a === 'dismiss' && key) { const r = k.safe(() => c.svc.get(key), null); hidden.set(key, (r && r.lastHeard) || Date.now()); if (hidden.size > 300) hidden.delete(hidden.keys().next().value); k.safe(() => c.svc.forgetHeard(key)); k.results.delete(key); return k.schedule(true); }
      if (a === 'bulk') return startOffer();
      if (a === 'cu-now') return k.call('cleanup', 'cleanup', () => c.svc.cleanup());
      if (a === 'bulk-no') { offer = null; return k.schedule(true); }
      if (a === 'bulk-go' && offer) return runBatch(offer.keys.slice(0, offer.fit));
      if (a === 'stop' && batch && !batch.done) { batch.stop = true; return k.schedule(true); }
    };
    const onChange = e => {
      const el = e.target; if (!el || !mount.contains(el) || !el.getAttribute) return;
      const a = el.getAttribute('data-act'), s = k.st(), cur = s.autoAdd;
      if (a === 'cu-on') return c.svc.cleanupSettings({ on: !!el.checked });
      if (a === 'cu-days') return c.svc.cleanupSettings({ days: parseInt(el.value, 10) || 7 });
      if (a === 'aa-all') return k.call('auto', 'autoAdd', () => c.svc.setAutoAdd({ all: !!el.checked }));
      if (a === 'aa-t' && cur) {
        const types = {}; for (const [t] of TYPES) { const box = autoEl.querySelector(`[data-act="aa-t"][data-key="${t}"]`); types[t] = box ? !!box.checked : !!(cur.types && cur.types[t]); }
        return k.call('auto', 'autoAdd', () => c.svc.setAutoAdd({ types }));   // types MERGE: give all four
      }
      if (a === 'aa-ow') return k.call('auto', 'autoAdd', () => c.svc.setAutoAdd({ overwrite: !!el.checked }));
      if (a === 'aa-hops') { const n = Math.max(0, Math.min(64, parseInt(el.value, 10) || 0)); return k.call('auto', 'autoAdd', () => c.svc.setAutoAdd({ maxHops: n })); }
      if (a === 'tel') { const m = Number(el.getAttribute('data-key')); if ([0, 1, 2].includes(m)) return k.call('tel', 'telemetry', () => c.svc.setTelemetryBase(m)); }
    };
    mount.addEventListener('click', onClick);
    mount.addEventListener('change', onChange);
    for (const ev of ['heard', 'contacts', 'state', 'calls']) k.on(ev, () => k.schedule());
    k.on('demo', () => { hidden.clear(); offer = null; if (batch) batch.stop = true; });
    k.render();
    return {
      destroy() { k.destroy(); if (batch) batch.stop = true; mount.removeEventListener('click', onClick); mount.removeEventListener('change', onChange); },
      _render: () => k.render(), _batch: () => batch, _runBatch: runBatch,
    };
  };
})();
