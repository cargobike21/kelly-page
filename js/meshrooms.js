/* Kelly Page -- Rooms card (LoRa Mesh page, MeshCore; Phase 9 of docs/lora-mesh-gap-analysis.md, 2026-10-23).
 *
 * A MeshCore ROOM SERVER is the mesh's bulletin board: you log in (its guest password, blank for read only where the
 * room allows it, or its admin password), then it pushes you the posts you haven't had, one at a time; a post of yours
 * is a DM to the room. Frame layouts, checked against simple_room_server + companion_radio v1.18.0, are in
 * js/meshcore.js's header. What matters here:
 *   - a WRONG PASSWORD GETS NO ANSWER (as a repeater): a failed login is a ~16 s timeout
 *   - posts trickle in ~1.2 s apart after a login; each carries its author's 4-byte key prefix, named from your
 *     node's contacts (else shown as a short key). The room's own notices carry its own key.
 *   - the room never sends you your own posts: Kelly keeps them as you send them (delivered = the room's ACK)
 *   - the room keeps only its last 32 posts, in RAM. Kelly keeps more: IndexedDB 'kelly-mesh-rooms', CAP per room
 *   - "sync since" lives in your NODE (per contact), so a second login only brings what's new
 * Keep-alive: every 20 min per room you're logged in to (binary request 2, a few bytes of airtime), so the room keeps
 * pushing. A room you ticked "remember" for is logged in again after a reconnect (at most every 30 min).
 * "Ask the room again" = keep-alive with since 1: the room re-sends all it holds (only if your node has a direct route).
 *
 * Off unless ms.rooms. Then room posts (txt_type 2 DMs from a room server) come here instead of the DM list.
 * Passwords only if "remember" is ticked, in this browser's storage (store 'meshRoomPw', per room key).
 *
 * ▦ QR in the room header: the room's contact/add QR (type 3, js/meshqr.js); never its password.
 *
 * window.KellyMeshRooms(k) -> { render, init, online, post, rooms }; k from mesh.js (meshrepeaters.js's pattern).
 */
(function () {
  'use strict';
  const DB = 'kelly-mesh-rooms', CAP = 300, PAGE = 30, KA_MS = 20 * 60000, RELOGIN_MS = 30 * 60000;
  const CLOCK_OK = Date.UTC(2024, 4, 16) / 1000;   // before this, the room's clock wasn't set: use the time it arrived
  const enc = new TextEncoder();

  // ---- IndexedDB (posts per room); everything still works in memory if it's missing or refused
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      try {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { const s = r.result.createObjectStore('posts', { keyPath: 'id' }); s.createIndex('room', 'room'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
    return dbp;
  }
  const tx = (mode, fn) => db().then(d => new Promise((res, rej) => { const t = d.transaction('posts', mode); const v = fn(t.objectStore('posts')); t.oncomplete = () => res(v && v.result); t.onerror = () => rej(t.error); }));

  window.KellyMeshRooms = function (k) {
    const { $, esc, store, toast } = k, ms = k.ms;
    const rs = {};            // per room key: { posts: [] oldest first, login, busy, err, shown, kaAt, loginAt }
    const ui = { sel: store.get('meshRoomSel', ''), sig: '', loaded: false };
    const R = key => rs[key] || (rs[key] = { posts: [], shown: PAGE });
    const pwMap = () => store.get('meshRoomPw', {}) || {};
    const pwOf = key => pwMap()[key];
    const setPw = (key, pw) => { const m = pwMap(); if (pw != null) m[key] = pw; else delete m[key]; store.set('meshRoomPw', m); };
    const readOf = key => (store.get('meshRoomRead', {}) || {})[key] || 0;
    const markRead = key => { const r = R(key), last = r.posts.length ? r.posts[r.posts.length - 1].rx : 0; if (last > readOf(key)) { const m = store.get('meshRoomRead', {}) || {}; m[key] = last; store.set('meshRoomRead', m); } };
    const unread = key => { const t = readOf(key); return R(key).posts.filter(p => !p.mine && p.rx > t).length; };
    const redraw = () => { ui.sig = ''; k.dirty('mesh'); };
    const myKey = () => { const s = k.session(); return s && s.selfKey ? s.selfKey() || '' : ''; };

    // room servers your node has as contacts (type 3), the closest first
    function rooms() {
      return [...k.nodes()].filter(n => n.key && n.role === 3).sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99) || (a.longName || '').localeCompare(b.longName || ''));
    }
    // ▦ QR (js/meshqr.js): a room server is type 3 (never the default 1); the guest password never goes near it
    const QR = () => window.KellyMeshQR;
    let qrUi = null;
    const qrOk = n => !!(QR() && ms.qr !== false && n && /^[0-9a-f]{64}$/i.test(n.key || ''));
    function showQr(n) {
      if (!qrOk(n)) return;
      qrUi = qrUi || QR().ui({ toast });
      return qrUi.show({ title: `▦ ${n.longName}`, contact: { key: n.key, type: 3, name: n.longName }, note: 'Anyone who scans it can add this room as a contact. Reading or posting still needs its password, which is never in a QR code.' });
    }
    const current = () => { const l = rooms(); return l.find(n => n.key === ui.sel) || l[0] || null; };
    // an author's 4-byte key prefix -> { name, kind: 'room' | 'me' | 'contact' | 'unknown' }
    function author(room, prefix) {
      if (!prefix) return { name: '?', kind: 'unknown' };
      if (room.key.startsWith(prefix)) return { name: `${room.longName} (notice)`, kind: 'room' };
      if (myKey().startsWith(prefix)) return { name: 'You', kind: 'me' };
      const n = [...k.nodes()].find(x => x.key && x.key.startsWith(prefix));
      return n ? { name: n.longName || prefix, kind: 'contact' } : { name: `${prefix.slice(0, 6)}…`, kind: 'unknown' };
    }

    function keep(r, p) {
      r.posts.push(p); r.posts.sort((a, b) => a.ts - b.ts || a.rx - b.rx);
      const drop = r.posts.length > CAP ? r.posts.splice(0, r.posts.length - CAP) : [];
      tx('readwrite', s => { s.put(p); drop.forEach(x => s.delete(x.id)); }).catch(() => {});
    }
    // ---- a pushed post from mesh.js (io.text). -> true if it was a room post (then it's not shown as a DM)
    function post(m) {
      if (!ms.rooms || !m || !m.dm || m.type !== 2) return false;
      const room = rooms().find(n => n.key.startsWith(m.prefix)); if (!room) return false;
      const r = R(room.key), rx = Date.now(), ts = m.ts >= CLOCK_OK ? m.ts : Math.floor(rx / 1000);
      const text = String(m.text || '').replace(/\0+$/, ''), id = `${room.key.slice(0, 12)}:${m.ts}:${m.author}:${text}`;
      if (r.posts.some(p => p.id === id)) return true;   // "ask the room again" brings ones we have
      keep(r, { id, room: room.key, author: m.author, ts, rx, text, snr: m.snr, clockOff: m.ts < CLOCK_OK || undefined });
      if (k.F) k.F('heard', room);
      if (room.key !== (current() || {}).key || k.currentPage() !== 'mesh') k.sfx('dm');
      redraw();
      return true;
    }

    // one call at a time per room; busy text shows what's happening
    async function run(n, what, fn) {
      const r = R(n.key), s = k.session();
      if (!s || !s.roomLogin) { toast('📡', 'Connect a MeshCore node first', 'Rooms go through your own companion node.', 'warn'); return; }
      r.busy = what; r.err = ''; redraw();
      try { return await fn(s); }
      catch (e) { r.err = `${what}: ${e.message}`; k.addEvent('network', `Mesh room ${n.longName}: ${r.err}`); }
      finally { r.busy = ''; redraw(); }
    }
    async function login(n, pw, remember, quiet) {
      const r = R(n.key);
      r.loginAt = Date.now();
      const v = await run(n, quiet ? 'Logging in again' : 'Logging in (a wrong password gets no answer: up to ~16 s)', s => s.roomLogin(n, pw));
      if (!v) { r.login = null; return; }
      r.login = { ...v, t: Date.now() }; r.kaAt = Date.now();
      if (remember != null) setPw(n.key, remember ? pw : null);
      redraw();
      if (!quiet) { k.sfx('ack'); toast('🏠', `In to ${n.longName}`, `${v.admin ? 'Admin' : v.canPost ? 'Guest: read and post' : 'Guest: read only'} · new posts arrive one at a time`, 'good'); }
    }
    async function send(n, text) {
      text = String(text || '').trim(); const r = R(n.key), s = k.session();
      if (!text) return;
      if (!r.login || !r.login.canPost) { toast('🏠', 'Log in to post', 'A read-only guest can read but not post.', 'warn'); return; }
      const max = s && s.maxPost || 151;
      if (enc.encode(text).length > max) { toast('🏠', 'Too long', `A room post is at most ${max} bytes.`, 'warn'); return; }
      const p = { id: `${n.key.slice(0, 12)}:me:${Date.now()}`, room: n.key, mine: true, author: myKey().slice(0, 8), ts: Math.floor(Date.now() / 1000), rx: Date.now(), text, state: 'sending' };
      keep(r, p); markRead(n.key); redraw();
      try { await s.roomPost(n, text, p); } catch (e) { p.state = 'failed'; p.err = e.message; }
      redraw();
    }
    async function askAgain(n) {
      const v = await run(n, 'Asking the room to send everything again', s => s.roomKeepAlive(n, 1));
      if (v) toast('🏠', 'Asked', v.flood ? 'Your node has no direct route to it yet, so the room may not re-send. Post or log in once, then try again.' : 'Up to the 32 posts it holds come in over the next minute.', v.flood ? 'warn' : 'good');
    }

    // ------------------------------------------------------------------ render
    const STATE = { sending: '⏳ sending', retry: '⏳ trying again', delivered: '✓ in the room', failed: '⚠️ not delivered' };
    function render() {
      const box = $('#rm-card'); if (!box) return;
      const on = !!(k.caps().repeaters);
      box.hidden = !on; if (!on || k.currentPage() !== 'mesh') return;
      const list = rooms(), n = current(), r = n ? R(n.key) : null;
      if (ms.rooms && n) markRead(n.key);
      const sig = JSON.stringify([ms.rooms, ui.loaded, list.map(x => x.key + x.hops + unread(x.key)), n && n.key, r && [r.busy, r.err, r.posts.length, r.shown, !!r.login, r.posts.filter(p => p.mine).map(p => p.state).join()], k.online(), Math.floor(Date.now() / 60000)]);
      if (sig === ui.sig) return; ui.sig = sig;
      $('#rm-on').checked = !!ms.rooms;
      const total = list.reduce((a, x) => a + (x === n ? 0 : unread(x.key)), 0);
      $('#rm-tag').textContent = !ms.rooms ? 'off' : `${list.length} room${list.length === 1 ? '' : 's'}${total ? ` · ${total} unread` : ''}`;
      const body = $('#rm-body');
      if (!ms.rooms) { body.innerHTML = '<p class="small dim">Off: a room server\'s posts show as ordinary DMs from it.</p>'; return; }
      if (!list.length) { body.innerHTML = '<p class="small dim">No room servers in your node\'s contacts yet. One shows up once your node hears its advert (or import its <code>meshcore://</code> link in Contacts).</p>'; return; }
      const lg = r.login, pw = pwOf(n.key);
      let h = `<div class="rm-rooms">${list.map(x => { const u = x === n ? 0 : unread(x.key); return `<button class="rm-room${x === n ? ' on' : ''}" data-rm-room="${esc(x.key)}">🏠 ${esc(x.longName)}${x.hops != null ? ` <small>${x.hops === 0 ? 'direct' : x.hops + ' hop' + (x.hops > 1 ? 's' : '')}</small>` : ''}${u ? ` <b class="rm-badge">${u}</b>` : ''}</button>`; }).join('')}</div>`;
      // the room header: its name and ▦ QR (contact/add, type 3) -- a row of its own, away from the password box
      h += `<div class="row gap rm-head"><b>🏠 ${esc(n.longName)}</b><span class="grow"></span>${qrOk(n) ? '<button class="btn ghost small" data-rm="qr" title="This room as a contact QR (key, name and type only: never its password)">▦ QR</button>' : ''}</div>`;
      h += `<div class="row gap wrap rm-top"><label class="fld"><span>Password</span><input id="rm-pw" type="password" maxlength="15" autocomplete="off" size="14" value="${esc(pw || '')}" placeholder="guest password"></label>`
        + `<label class="tog small" title="Kept in this browser only. A remembered room is logged in again after a reconnect."><input type="checkbox" id="rm-rem"${pw != null ? ' checked' : ''}><i></i><span>Remember here</span></label>`
        + `<button class="btn primary" id="rm-login"${r.busy ? ' disabled' : ''}>🔑 Log in</button></div>`
        + `<p class="small dim rm-hint">Blank = read only, if the room allows it. Its guest password lets you post. A wrong password gets no answer, so a failed login takes about 16 s.</p>`;
      h += `<div class="rp-state">${lg ? `<span class="rp-chip ok">${lg.admin ? '🛡️ Admin' : lg.canPost ? '👤 Guest' : '👀 Read only'}</span> logged in ${esc(k.fmtAgo(lg.t))}` : '<span class="rp-chip">Not logged in</span>'}</div>`;
      if (r.busy) h += `<div class="rp-busy">⏳ ${esc(r.busy)}…</div>`;
      if (r.err) h += `<div class="rp-err">⚠️ ${esc(r.err)}</div>`;
      const posts = r.posts.slice(-r.shown);
      h += '<div class="rm-thread">';
      if (r.posts.length > posts.length) h += `<button class="btn ghost small rm-older" data-rm="older">⬆ Load older (${r.posts.length - posts.length} more here)</button>`;
      else if (lg) h += `<button class="btn ghost small rm-older" data-rm="again"${r.busy ? ' disabled' : ''} title="The room re-sends all it holds (its last 32 posts). Needs a direct route to it.">⬆ Ask the room again</button>`;
      h += posts.length ? posts.map(p => {
        const a = p.mine ? { name: 'You', kind: 'me' } : author(n, p.author);
        return `<div class="rm-post rm-${a.kind}"><div class="rm-meta"><b title="${esc(p.author || '')}">${esc(a.name)}</b> <small class="dim">${esc(new Date(p.ts * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}${p.clockOff ? ' (room clock not set)' : ''}</small>`
          + `${p.mine ? ` <small class="rm-st ${p.state || ''}">${esc(STATE[p.state] || '')}${p.err ? ` · ${esc(p.err)}` : ''}</small>` : ''}</div><div class="rm-text">${esc(p.text)}</div></div>`;
      }).join('') : `<p class="small dim">${lg ? 'Nothing yet: posts come in one at a time, about a second apart.' : 'Log in to read this room.'}</p>`;
      h += '</div>';
      h += `<div class="row gap rm-send"><input id="rm-text" class="grow" maxlength="151" placeholder="${lg && lg.canPost ? 'Post to the room (151 bytes max)' : 'Log in with the guest password to post'}" autocomplete="off"${lg && lg.canPost ? '' : ' disabled'}>`
        + `<button class="btn" id="rm-post"${lg && lg.canPost && !r.busy ? '' : ' disabled'}>Post</button></div>`;
      // a redraw must not eat a half-typed password or post
      const keepv = { pw: ($('#rm-pw') || {}).value, text: ($('#rm-text') || {}).value, rem: ($('#rm-rem') || {}).checked, focus: document.activeElement && document.activeElement.id, key: ui.drawn };
      const ot = body.querySelector('.rm-thread'), otEnd = !ot || ot.scrollHeight - ot.scrollTop - ot.clientHeight < 40;   // scrolled up to read: stay there (js/keepscroll.js)
      body.innerHTML = h;
      if (keepv.key === n.key) {
        if (keepv.pw != null && $('#rm-pw')) $('#rm-pw').value = keepv.pw;
        if (keepv.text && $('#rm-text')) $('#rm-text').value = keepv.text;
        if (keepv.rem != null && $('#rm-rem')) $('#rm-rem').checked = keepv.rem;
        if (keepv.focus && /^rm-(pw|text)$/.test(keepv.focus) && !$('#' + keepv.focus).disabled) $('#' + keepv.focus).focus();
      }
      ui.drawn = n.key;
      const th = body.querySelector('.rm-thread'); if (th && !ui.keepScroll && (otEnd || keepv.key !== n.key)) th.scrollTop = th.scrollHeight;
      ui.keepScroll = false;
    }

    function init() {
      const box = $('#rm-card'); if (!box) return;
      tx('readonly', s => s.getAll()).then(all => {
        for (const p of all || []) R(p.room).posts.push(p);
        for (const key in rs) rs[key].posts.sort((a, b) => a.ts - b.ts || a.rx - b.rx);
        ui.loaded = true; redraw();
      }).catch(() => { ui.loaded = true; });
      $('#rm-on').onchange = e => { ms.rooms = e.target.checked; k.save(); redraw(); };
      box.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.rmRoom) { ui.sel = b.dataset.rmRoom; store.set('meshRoomSel', ui.sel); redraw(); return; }
        const n = current(); if (!n) return;
        if (b.id === 'rm-login') return login(n, ($('#rm-pw') || {}).value || '', ($('#rm-rem') || {}).checked);
        if (b.id === 'rm-post') { const i = $('#rm-text'); const v = i.value; i.value = ''; return send(n, v); }
        if (b.dataset.rm === 'older') { R(n.key).shown += PAGE; ui.keepScroll = true; redraw(); }
        if (b.dataset.rm === 'again') return askAgain(n);
        if (b.dataset.rm === 'qr') return showQr(n);
      });
      box.addEventListener('keydown', e => {
        const n = current(); if (!n || e.key !== 'Enter') return;
        if (e.target.id === 'rm-text') { e.preventDefault(); const v = e.target.value; e.target.value = ''; send(n, v); }
        if (e.target.id === 'rm-pw') { e.preventDefault(); login(n, e.target.value || '', ($('#rm-rem') || {}).checked); }
      });
      setInterval(tick, 60000);
    }
    // keep-alive for rooms you're in; log in again to remembered rooms after a reconnect (each rate limited)
    let busy = false;
    async function tick() {
      const s = k.session(); if (busy || !ms.rooms || !s || !s.roomKeepAlive || (k.online && !k.online())) return;
      busy = true;
      try {
        for (const n of rooms()) {
          const r = R(n.key); if (r.busy) continue;
          if (r.login) { if (Date.now() - (r.kaAt || 0) >= KA_MS) { r.kaAt = Date.now(); await s.roomKeepAlive(n, 0).catch(e => k.addEvent('network', `Mesh room ${n.longName}: keep-alive: ${e.message}`)); } continue; }
          const pw = pwOf(n.key);
          if (pw != null && Date.now() - (r.loginAt || 0) >= RELOGIN_MS) await login(n, pw, null, true);
        }
      } finally { busy = false; }
    }
    // a fresh session: the room still has us in its list, but Kelly logs in again to be sure (remembered rooms: soon)
    function online() { for (const key in rs) { rs[key].login = null; rs[key].loginAt = Date.now() - RELOGIN_MS + 15000; } redraw(); }
    return { render, init, online, post, rooms, tick, unread };
  };
})();
