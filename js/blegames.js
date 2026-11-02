/* Kelly Page -- BLE games (BLE brief Phase 5), a plugin of the BLE Presence page (js/bleui.js).
 *
 *   Fox hunt   hide registered beacons (foxes); hunters close in with the RSSI meter and Geiger clicks; a fox is found
 *              when it's held at "found" strength (default -50 dBm, ~1 m) for a few seconds. Staged foxes wake one
 *              after another. Points by speed.
 *   Check-ins  an event (field day, club night): a registered beacon arriving checks its owner in -- points, a bonus
 *              for first on site, streaks across events. Results as CSV and printable certificates.
 *   BLEdex     collect the KINDS of thing heard: companies, AD types, address kinds, PDU types, PHYs -- never who.
 *              Badges for firsts (Coded PHY, extended advertising, Auracast...). PDU/PHY need the Inspector's
 *              captured bytes (reconstructed packets don't carry them).
 *   Leaderboard profiles by callsign: fox finds, check-ins, streaks, Packet Quiz points; all time or this month.
 *
 * Privacy (brief, mandatory): only registered, opted-in devices take part in games (registering = opting in); unknown
 * devices count in the BLEdex by category only. Announcements over P25 are optional, ordinary identified texts, and
 * go through the airtime queue at the LOWEST priority ('game') so they never delay a real alert.
 * Fair play: a fox's packets could be replayed by a second beacon; rolling-code fox firmware (nRF52840) is planned.
 */
(function () {
  'use strict';
  const X = window.KellyBleDissect;
  window.KellyBlePlugins = window.KellyBlePlugins || [];
  window.KellyBlePlugins.push(function (api) {
    const { esc, toast, store, bs } = api;
    const G = Object.assign({ fox: { cfg: { foxes: '', found: -50, hold: 3, staged: true, announce: false, to: '' }, run: null }, events: [], dex: {}, badges: {}, awards: [] },
      store.get('bleGames', {}) || {});
    const save = () => store.set('bleGames', G);
    const ui = { sub: 'fox', board: 'all', newBadges: new Set(), celebrate: null, near: {} };
    const dexSeen = new Map();
    const me = () => api.k.myCall() || 'ME';

    // ---- awards -> leaderboard
    function award(call, pts, kind, what) {
      G.awards.push({ call: (call || '').toUpperCase(), pts, kind, what, at: Date.now() });
      if (G.awards.length > 5000) G.awards.splice(0, G.awards.length - 5000);
    }

    // ---- Fox hunt
    const foxIds = () => String(G.fox.cfg.foxes || '').split(',').filter(id => api.devices()[id]);
    function activeFoxes() {
      const run = G.fox.run; if (!run) return [];
      const left = run.order.filter(id => !run.finds.some(f => f.fox === id));
      return G.fox.cfg.staged ? left.slice(0, 1) : left;
    }
    function startHunt() {
      const order = foxIds();
      if (!order.length) { toast('🦊', 'Pick at least one fox', 'Any registered beacon will do -- hide it first!', 'bad'); return; }
      G.fox.run = { start: Date.now(), order, finds: [], stageAt: Date.now(), hunter: me() };
      save(); api.addEvent('data', `BLE fox hunt started: ${order.length} fox${order.length > 1 ? 'es' : ''}`); clickLoop(); api.dirty('ble');
    }
    function stopHunt(done) {
      const run = G.fox.run; if (!run) return;
      (G.fox.history = G.fox.history || []).unshift({ start: run.start, end: Date.now(), hunter: run.hunter, finds: run.finds, foxes: run.order.length, complete: !!done });
      G.fox.history.length = Math.min(G.fox.history.length, 50);
      G.fox.run = null; save(); api.dirty('ble');
      if (done) toast('🏁', 'All foxes found!', `${run.finds.reduce((a, f) => a + f.pts, 0)} points`);
    }
    function onFoxAdv(r, id, now) {
      const run = G.fox.run; if (!run || !activeFoxes().includes(id)) return;
      const near = ui.near[id] = ui.near[id] || { since: 0 };
      near.rssi = r.r; near.at = now;
      if (r.r >= +G.fox.cfg.found) { if (!near.since) near.since = now; }
      else near.since = 0;
      if (near.since && now - near.since >= +G.fox.cfg.hold * 1000) found(id, now);
    }
    function found(id, now) {
      const run = G.fox.run, mins = (now - (G.fox.cfg.staged ? run.stageAt : run.start)) / 60000;
      const pts = Math.max(10, Math.round(100 - mins * 2)), n = run.order.indexOf(id) + 1, name = api.devName(id);
      run.finds.push({ fox: id, name, call: run.hunter, at: now, pts }); run.stageAt = now; delete ui.near[id];
      award(run.hunter, pts, 'fox', name); save();
      ui.celebrate = { what: `🦊 ${name} found! +${pts}`, at: now };
      api.sfx('arrive'); setTimeout(() => api.cw('FOX ' + n), 600);
      api.addEvent('data', `BLE fox hunt: ${run.hunter} found ${name} (+${pts})`); toast('🦊', `${name} found!`, `+${pts} points`);
      if (G.fox.cfg.announce) api.announce(`${run.hunter} found ${name.toUpperCase()} +${pts} pts`, G.fox.cfg.to);
      if (run.finds.length === run.order.length) stopHunt(true);
      api.dirty('ble');
    }
    // Geiger clicks for the nearest active fox while the Games tab is open (stops when it isn't)
    let clickT = 0;
    function clickLoop() {
      clearTimeout(clickT);
      if (!G.fox.run) return;
      const n = activeFoxes().map(id => ui.near[id]).filter(x => x && Date.now() - x.at < 10000).sort((a, b) => b.rssi - a.rssi)[0];
      let every = 1500;
      if (n && api.visible('games') && ui.sub === 'fox') { const r = Math.max(-100, Math.min(-40, n.rssi)); every = 40 + (1 - (r + 100) / 60) * 960; api.sfx('click', true); }
      clickT = setTimeout(clickLoop, every);
    }

    // ---- Check-ins
    const activeEvent = () => G.events.find(e => !e.end);
    function startEvent(name, pts, bonus, announce, to) {
      if (activeEvent()) return;
      const ev = { id: 'e' + Date.now().toString(36), name: name || 'Event', start: Date.now(), end: null, pts: +pts || 10, bonus: +bonus || 0, announce, to, checkins: [] };
      G.events.unshift(ev); save();
      for (const [id, dv] of Object.entries(api.devices())) { const p = api.presence().get(id); if (p && p.st === 'present') checkIn(ev, id, dv, Date.now()); }   // already here
      api.addEvent('data', `BLE event "${ev.name}" started`); api.dirty('ble');
    }
    function streakOf(call, uptoEvent) {   // consecutive events, newest first, that this callsign checked in to
      let n = 0;
      for (const e of G.events.slice(G.events.indexOf(uptoEvent))) { if (e.checkins.some(c => c.call === call)) n++; else break; }
      return n;
    }
    function checkIn(ev, id, dv, at) {
      const call = String(dv.call || '').toUpperCase(); if (!call || ev.checkins.some(c => c.call === call)) return;
      const first = !ev.checkins.length, pts = ev.pts + (first ? ev.bonus : 0);
      ev.checkins.push({ call, dev: dv.name || id, at, first, pts });
      award(call, pts, 'checkin', ev.name); save();
      const streak = streakOf(call, ev);
      api.addEvent('data', `BLE check-in: ${call} at "${ev.name}" +${pts}${first ? ' (first on site)' : ''}${streak > 1 ? `, ${streak} events in a row` : ''}`);
      toast('✅', `${call} checked in`, `${ev.name}${first ? ' -- first on site!' : ''} +${pts}`); api.sfx('arrive');
      if (ev.announce) api.announce(`${call} checked in ${ev.name}${first ? ' FIRST' : ''} +${pts}`, ev.to);
      api.dirty('ble');
    }
    function endEvent() { const ev = activeEvent(); if (ev) { ev.end = Date.now(); save(); api.dirty('ble'); } }
    function eventCsv(ev) {
      const rows = ['callsign,device,time,first,points,streak', ...ev.checkins.map(c => [c.call, `"${c.dev}"`, new Date(c.at).toISOString(), c.first, c.pts, streakOf(c.call, ev)].join(','))];
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' })); a.download = `${ev.name.replace(/\W+/g, '-')}-checkins.csv`; a.click();
    }
    function certificates(ev) {
      const w = window.open('', '_blank'); if (!w) { toast('🖨', 'Allow pop-ups to print certificates', '', 'bad'); return; }
      const date = new Date(ev.start).toLocaleDateString();
      w.document.write(`<!doctype html><title>${esc(ev.name)} certificates</title><style>body{font-family:Georgia,serif;margin:0}.c{page-break-after:always;border:12px double #1f3b73;margin:24px;padding:48px;text-align:center;min-height:80vh;box-sizing:border-box}
        h1{font-size:40px;color:#1f3b73;margin:.2em}h2{font-size:56px;margin:.3em;letter-spacing:.08em}p{font-size:20px}.s{font-size:14px;color:#555}</style>
        ${ev.checkins.map(c => `<div class="c"><p class="s">Kelly Page · P25X</p><h1>Certificate of attendance</h1><p>This certifies that</p><h2>${esc(c.call)}</h2><p>checked in at <b>${esc(ev.name)}</b> on ${esc(date)} at ${esc(new Date(c.at).toLocaleTimeString())}${c.first ? ', <b>first on site</b>' : ''}.</p><p>${c.pts} points · ${streakOf(c.call, ev)} event${streakOf(c.call, ev) > 1 ? 's' : ''} in a row</p><p class="s">Checked in automatically by their registered Bluetooth LE beacon.</p></div>`).join('')}
        <script>window.onload=()=>window.print()<\/script>`);
      w.document.close();
    }

    // ---- BLEdex
    const dexStats = () => {
      const cats = Object.keys(G.dex);
      return { packets: cats.reduce((a, c) => a + G.dex[c].n, 0), kinds: cats.length, has: c => !!G.dex[c], hasPrefix: p => cats.some(c => c.startsWith(p)), count: p => cats.filter(c => c.startsWith(p)).length };
    };
    function dexAdd(diss, now) {
      let added = false;
      for (const c of X.categories(diss)) {
        if (!diss.real && /^(pdu|phy|ext):/.test(c)) continue;   // a reconstructed packet doesn't know these
        if (!G.dex[c]) { G.dex[c] = { first: now, n: 0 }; added = true; ui.newDex = c; }
        G.dex[c].n++;
      }
      if (added) {
        const s = dexStats();
        for (const b of X.BADGES) if (!G.badges[b.id] && b.test(s)) { G.badges[b.id] = now; ui.newBadges.add(b.id); toast(b.icon, `Badge: ${b.name}`, b.desc); api.sfx('arrive'); award(me(), 5, 'badge', b.name); }
        save();
      }
    }
    function onAdv(r, d, id, now) {
      if (id) onFoxAdv(r, id, now);
      const k = r.a;   // BLEdex: each address at most once a minute -- counting kinds, not people
      if (now - (dexSeen.get(k) || 0) < 60000) return;
      dexSeen.set(k, now); if (dexSeen.size > 3000) dexSeen.clear();
      try { dexAdd(X.fromRecord(r), now); } catch {}
    }
    function onHci(list) {   // captured bytes (while the Inspector is open): PDU types, PHYs, extended adverts
      for (const [, , hex] of list) { try { const dz = X.dissect(X.fromHex(hex)); const k = 'h' + ((dz.reports[0] || {}).addr || ''); const now = Date.now(); if (now - (dexSeen.get(k) || 0) < 60000) continue; dexSeen.set(k, now); dexAdd(dz, now); } catch {} }
    }
    function onPresence(ev) {
      const e = activeEvent(); if (!e || ev.type !== 'arrive') return;
      checkIn(e, ev.id, api.devices()[ev.id] || {}, ev.t || Date.now());
    }

    // ---- rendering
    let root = null;
    function build(el) {
      root = el;
      el.innerHTML = `<div class="tabs small" id="bg-sub">${[['fox', '🦊 Fox hunt'], ['checkin', '✅ Check-ins'], ['dex', '📕 BLEdex'], ['board', '🏆 Leaderboard']].map(([k, l]) => `<button data-sub="${k}">${l}</button>`).join('')}</div><div id="bg-body"></div>`;
      el.querySelector('#bg-sub').onclick = e => { const b = e.target.closest('[data-sub]'); if (b) { ui.sub = b.dataset.sub; render(); } };
      el.querySelector('#bg-body').addEventListener('click', onClick);
      el.querySelector('#bg-body').addEventListener('change', onChange);
    }
    function render() {
      if (!root) return;
      root.querySelectorAll('#bg-sub [data-sub]').forEach(b => b.classList.toggle('on', b.dataset.sub === ui.sub));
      const body = root.querySelector('#bg-body');
      if (body.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;   // don't redraw under typing
      body.innerHTML = ui.sub === 'fox' ? foxView() : ui.sub === 'checkin' ? checkinView() : ui.sub === 'dex' ? dexView() : boardView();
      if (ui.celebrate && Date.now() - ui.celebrate.at < 4000) { const c = body.querySelector('.bg-celebrate'); if (c && !c.dataset.done) c.dataset.done = 1; }
      ui.newBadges.clear();
    }
    const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    function foxView() {
      const run = G.fox.run, c = G.fox.cfg, devs = Object.entries(api.devices()), chosen = new Set(foxIds());
      if (!run) return `<div class="card"><div class="card-h"><h3>🦊 Fox hunt</h3></div>
        <p class="dim small">Hide one or more registered beacons -- a spare tag, a phone running a beacon app, an nRF52840 dongle. Then hunt them with this page on a laptop or tablet beside a portable scanner (a Pi Zero 2 W on a battery pack does it): the meter and the clicks get faster as you close in.</p>
        <div class="bg-foxpick">${devs.map(([id, dv]) => `<label class="fld inline"><input type="checkbox" data-fox="${esc(id)}"${chosen.has(id) ? ' checked' : ''}> <span>${api.icon(dv.type)} ${esc(dv.name || id)}</span></label>`).join('') || '<span class="dim">Register a beacon first (Scanner › Register).</span>'}</div>
        <div class="row gap wrap"><label class="fld"><span>Found at ≥ dBm</span><input type="number" data-fc="found" value="${esc(c.found)}" style="width:80px"></label>
          <label class="fld"><span>Held for s</span><input type="number" data-fc="hold" value="${esc(c.hold)}" min="1" style="width:70px"></label>
          <label class="fld inline"><input type="checkbox" data-fc="staged"${c.staged ? ' checked' : ''}> <span>Staged (each fox wakes when the last is found)</span></label>
          <label class="fld inline"><input type="checkbox" data-fc="announce"${c.announce ? ' checked' : ''}> <span>Announce finds on P25</span></label>
          <label class="fld"><span>…to radio IDs</span><input data-fc="to" value="${esc(c.to)}" placeholder="1050002" style="width:140px"></label></div>
        <div class="row gap"><button class="btn primary" data-act="start">🏁 Start the hunt</button><span class="dim small">Hunter: ${esc(me())}</span></div>
        <p class="dim small">Fair play: a found fox needs its signal held strong for ${c.hold} s. A copied beacon could fool it -- rolling-code fox firmware is planned. Announcements are lowest priority: they never delay a real alert.</p></div>
        ${historyView()}`;
      const now = Date.now(), act = activeFoxes();
      return `<div class="card bg-run"><div class="card-h"><h3>🦊 Hunt on -- ${mmss(now - run.start)}</h3><button class="btn small" data-act="stop">⏹ End</button></div>
        ${ui.celebrate && now - ui.celebrate.at < 4000 ? `<div class="bg-celebrate">${esc(ui.celebrate.what)}</div>` : ''}
        ${run.order.map((id, i) => {
          const f = run.finds.find(x => x.fox === id), a = act.includes(id), n = ui.near[id], fresh = n && now - n.at < 10000;
          const heat = fresh ? Math.max(0, Math.min(1, (n.rssi + 100) / (100 + +c.found))) : 0;
          return `<div class="bg-fox ${f ? 'found' : a ? 'live' : 'asleep'}"><div class="bg-fn">${f ? '✅' : a ? '🦊' : '💤'} Fox ${i + 1}: ${esc(api.devName(id))}</div>
            ${f ? `<div>Found in ${mmss(f.at - run.start)} · +${f.pts}</div>` : a ? `<div class="bg-meter"><i style="width:${Math.round(heat * 100)}%;--h:${heat}"></i></div><div class="small">${fresh ? `${n.rssi} dBm · ${heat > 0.85 ? 'HOT 🔥' : heat > 0.6 ? 'warm' : heat > 0.3 ? 'cool' : 'cold 🧊'}${n.since ? ` · hold it… ${Math.max(0, +c.hold - Math.floor((now - n.since) / 1000))}` : ''}` : 'not heard -- keep moving'}</div>` : '<div class="dim small">asleep until the fox before is found</div>'}</div>`;
        }).join('')}
        <p class="dim small">Points: 100, less 2 a minute (at least 10)${c.staged ? ', timed from the previous find' : ''}.</p></div>`;
    }
    function historyView() {
      const h = G.fox.history || []; if (!h.length) return '';
      return `<div class="card"><div class="card-h"><h3>Past hunts</h3></div><table class="tbl"><tbody>${h.slice(0, 10).map(x => `<tr><td class="small">${new Date(x.start).toLocaleString()}</td><td>${esc(x.hunter)}</td><td>${x.finds.length}/${x.foxes} foxes${x.complete ? ' 🏁' : ''}</td><td>${mmss(x.end - x.start)}</td><td>${x.finds.reduce((a, f) => a + f.pts, 0)} pts</td></tr>`).join('')}</tbody></table></div>`;
    }
    function checkinView() {
      const ev = activeEvent(), owners = Object.values(api.devices()).filter(d => d.call).length;
      return `<div class="card"><div class="card-h"><h3>✅ Event check-ins</h3>${ev ? '<button class="btn small" data-act="endev">⏹ End event</button>' : ''}</div>
        ${ev ? `<p><b>${esc(ev.name)}</b> since ${new Date(ev.start).toLocaleTimeString()} · ${ev.checkins.length} checked in · ${ev.pts} pts each${ev.bonus ? `, +${ev.bonus} first on site` : ''}</p>${checkinTable(ev)}`
          : `<p class="dim small">Members' registered beacons (devices with an owner callsign: ${owners} so far) check them in automatically when they arrive. Registering a beacon is opting in -- nobody else is ever tracked.</p>
          <div class="row gap wrap"><label class="fld"><span>Event</span><input id="bg-evname" placeholder="Field day ${new Date().getFullYear()}"></label><label class="fld"><span>Points</span><input id="bg-evpts" type="number" value="10" style="width:70px"></label>
          <label class="fld"><span>First on site bonus</span><input id="bg-evbonus" type="number" value="5" style="width:70px"></label>
          <label class="fld inline"><input type="checkbox" id="bg-evann"> <span>Announce on P25</span></label><label class="fld"><span>…to</span><input id="bg-evto" placeholder="1050002" style="width:120px"></label>
          <button class="btn primary" data-act="startev">▶ Start event</button></div>`}</div>
        ${G.events.filter(e => e.end).slice(0, 8).map(e => `<div class="card"><div class="card-h"><h3>${esc(e.name)} <span class="dim small">${new Date(e.start).toLocaleDateString()}</span></h3><div class="row gap"><button class="btn small" data-csv="${e.id}">⬇ CSV</button><button class="btn small" data-cert="${e.id}">🖨 Certificates</button></div></div>${checkinTable(e)}</div>`).join('')}`;
    }
    const checkinTable = ev => ev.checkins.length ? `<table class="tbl"><thead><tr><th>Callsign</th><th>Beacon</th><th>Arrived</th><th>Points</th><th>Streak</th></tr></thead><tbody>${ev.checkins.map(c => `<tr><td><b>${esc(c.call)}</b>${c.first ? ' 🥇' : ''}</td><td>${esc(c.dev)}</td><td>${new Date(c.at).toLocaleTimeString()}</td><td>${c.pts}</td><td>${streakOf(c.call, ev)}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">Nobody yet.</p>';
    function dexView() {
      const s = dexStats(), groups = {};
      for (const [c, v] of Object.entries(G.dex)) { const [g, ...rest] = c.split(':'); (groups[g] = groups[g] || []).push([rest.join(':'), v]); }
      const GN = { company: '🏭 Companies', ad: '🧱 AD types', kind: '🔖 Formats', addr: '🎭 Address kinds', pdu: '📨 Advert types', phy: '📶 PHYs', ext: '📜 Bluetooth 5' };
      return `<div class="card"><div class="card-h"><h3>📕 BLEdex: ${s.kinds} kinds collected</h3><span class="dim small">${s.packets} sightings</span></div>
        <p class="dim small">Every kind of thing Kelly has heard -- never who. Advert types and PHYs need captured bytes: open the Inspector for a while to collect them.</p>
        <div class="bg-badges">${X.BADGES.map(b => `<div class="bg-badge ${G.badges[b.id] ? 'got' : ''}${ui.newBadges.has(b.id) ? ' new' : ''}" title="${esc(b.desc)}"><span>${G.badges[b.id] ? b.icon : '🔒'}</span><b>${esc(b.name)}</b><small>${esc(b.desc)}</small></div>`).join('')}</div>
        ${Object.entries(GN).filter(([g]) => groups[g]).map(([g, n]) => `<h4>${n} (${groups[g].length})</h4><div class="bg-dex">${groups[g].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `<span class="tag" title="first ${new Date(v.first).toLocaleString()}">${esc(k)} <b>×${v.n}</b></span>`).join(' ')}</div>`).join('')}</div>`;
    }
    function boardView() {
      const since = ui.board === 'month' ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() : 0;
      const P = {};
      for (const a of G.awards) {
        if (a.at < since) continue;
        const p = P[a.call] = P[a.call] || { pts: 0, fox: 0, checkin: 0, badge: 0 };
        p.pts += a.pts; p[a.kind] = (p[a.kind] || 0) + 1;
      }
      const q = (store.get('bleQuiz', {}) || {}).pts || 0;
      if (q && !since) { const p = P[me()] = P[me()] || { pts: 0, fox: 0, checkin: 0, badge: 0 }; p.pts += q; p.quiz = q; }
      const rows = Object.entries(P).sort((a, b) => b[1].pts - a[1].pts);
      const best = call => { let b = 0; for (const e of G.events) b = Math.max(b, streakOf(call, e)); return b; };
      return `<div class="card"><div class="card-h"><h3>🏆 Leaderboard</h3><select data-board><option value="all"${ui.board === 'all' ? ' selected' : ''}>All time</option><option value="month"${ui.board === 'month' ? ' selected' : ''}>This month</option></select></div>
        ${rows.length ? `<table class="tbl"><thead><tr><th>#</th><th>Callsign</th><th>Points</th><th>Foxes</th><th>Check-ins</th><th>Best streak</th><th>Quiz</th></tr></thead><tbody>${rows.map(([call, p], i) => `<tr><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td><b>${esc(call)}</b></td><td>${p.pts}</td><td>${p.fox}</td><td>${p.checkin}</td><td>${best(call)}</td><td>${p.quiz || ''}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">No points yet -- hunt a fox, run an event, or try the Packet Quiz (Learn).</p>'}
        <p class="dim small">This station's games. Coming next: beacon treasure hunts, BLE DX (furthest reliable detection), Golden Packet relays across scanner nodes, and club team challenges.</p></div>`;
    }
    function onClick(e) {
      const a = e.target.dataset.act;
      if (a === 'start') startHunt();
      else if (a === 'stop') { if (confirm('End the hunt?')) stopHunt(false); }
      else if (a === 'startev') { const v = s => root.querySelector(s); startEvent(v('#bg-evname').value.trim() || v('#bg-evname').placeholder, v('#bg-evpts').value, v('#bg-evbonus').value, v('#bg-evann').checked, v('#bg-evto').value); }
      else if (a === 'endev') { if (confirm('End this event?')) endEvent(); }
      else if (e.target.dataset.csv) eventCsv(G.events.find(x => x.id === e.target.dataset.csv));
      else if (e.target.dataset.cert) certificates(G.events.find(x => x.id === e.target.dataset.cert));
    }
    function onChange(e) {
      const t = e.target, d = t.dataset;
      if (d.fox) { const s = new Set(foxIds()); if (t.checked) s.add(d.fox); else s.delete(d.fox); G.fox.cfg.foxes = [...s].join(','); save(); }
      else if (d.fc) { G.fox.cfg[d.fc] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? +t.value : t.value.trim(); save(); }
      else if (d.board != null) { ui.board = t.value; render(); }
    }

    if (G.fox.run) setTimeout(clickLoop, 2000);
    return {
      tabs: [['games', '🎮 Games']],
      build, render, onAdv, onHci, onPresence,
      onTab(tab) { if (tab === 'games') clickLoop(); },
    };
  });
})();
