/* Kelly Page -- Repeater management (LoRa Mesh page, MeshCore; Phase 2 of docs/lora-mesh-gap-analysis.md, 2026-10-21).
 *
 * A MeshCore repeater (or room server) has no app link of its own: the companion node Kelly is connected to manages
 * it OVER THE AIR. Log in with its admin password, then read its status (battery, noise floor, airtime, packet and
 * duplicate counts), its telemetry (CayenneLPP: battery voltage, temperature, ...), the stations it hears directly
 * (neighbours), and run its CLI. Built for the author's veranda SenseCAP Solar repeater, checked against it on the bench.
 *
 * Driver calls (js/meshcore.js Session; each rejects with a plain-English reason):
 *   login(node, pw), status(node), telemetry(node), neighbours(node), cli(node, text), ownStats()
 * Things the bench taught us, shown to the user where they matter:
 *   - a WRONG PASSWORD GETS NO ANSWER: a failed login is a ~16 s timeout, "wrong password or out of range"
 *   - a repeater's clock restarts at 15 May 2024 after a power-off: an admin login sets it when it's slow (meshcore.js),
 *     and the 🕒 Set clock buttons do it by hand, for a repeater (admin) and for your own node. Neither can turn a
 *     clock BACK (MeshCore refuses), so a fast one needs a power-off first.
 *   - about 1 in 10 CLI answers is lost on a busy repeater: meshcore.js retries once
 * Passwords: only if "remember" is ticked, in this browser's storage (store 'meshRptPw', per repeater key) --
 * never in settings (which can be exported) and never sent anywhere but to the repeater, encrypted, over LoRa.
 *
 * ▦ QR: the selected node's contact/add QR (js/meshqr.js), type 2 / 3 from the contact; never a password near it.
 * window.KellyMeshRepeaters(k) -> { render, init, online, replay }; k from mesh.js (the paths module's pattern).
 * k.SS(kind, ...) passes each status / telemetry / own-stats read to the Station SCADA tab (no extra airtime).
 */
(function () {
  'use strict';
  // CLI commands that change the repeater: asked twice. A wrong radio setting strands it out of reach.
  const RISKY = /^(reboot|erase|password |set (radio|freq|bw|sf|cr|tx|af|repeat|guest\.password|prv\.key)|start ota|neighbor\.remove)/i;
  const QUICK = ['ver', 'clock', 'get radio', 'get tx', 'neighbors', 'advert'];
  const fmtUp = s => { s = s | 0; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };
  const pct = (a, b) => b > 0 ? `${(100 * a / b).toFixed(a / b < 0.01 ? 2 : 1)} %` : '–';
  // a node's clock read at `at` (ms) as unix s `s` -> "right", "12 min slow", "not set (restarted at May 2024)"
  const CLOCK_OK = Date.UTC(2024, 4, 16) / 1000;
  const nowS = () => Math.floor(Date.now() / 1000);
  function clockNote(c) {
    if (!c || c.s == null) return '';
    const s = c.s + Math.round((Date.now() - c.at) / 1000), d = s - nowS(), a = Math.abs(d);
    if (s < CLOCK_OK) return 'not set (it restarted at May 2024)';
    if (a < 120) return 'right';
    const amt = a < 5400 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} days`;
    return `${amt} ${d < 0 ? 'slow' : 'fast'}`;
  }

  window.KellyMeshRepeaters = function (k) {
    const { $, esc, store, toast } = k;
    const rs = {};            // per repeater key: { login, status, tel, neigh, cli: [], busy, err, at }
    const ui = { sel: store.get('meshRptSel', ''), sig: '', own: null, ownClock: null };   // ownClock: { s, at, msg }
    const R = key => rs[key] || (rs[key] = { cli: [] });
    const pwOf = key => (store.get('meshRptPw', {}) || {})[key] || '';
    const setPw = (key, pw) => { const m = store.get('meshRptPw', {}) || {}; if (pw) m[key] = pw; else delete m[key]; store.set('meshRptPw', m); };
    // "Status every 15 min" (2026-10-23, the author's solar veranda repeater): per repeater, while this Kelly holds the node and
    // is logged in -- or can log in with a remembered password. ~1-2 s of airtime a time. The bridge does the same while
    // no Kelly is attached (kelly_bridge.py --mesh-rpt-poll), so the battery history has no gaps either way.
    const AUTO_MS = 15 * 60000;
    const autoOf = key => !!(store.get('meshRptAuto', {}) || {})[key];
    const setAuto = (key, on) => { const m = store.get('meshRptAuto', {}) || {}; if (on) m[key] = true; else delete m[key]; store.set('meshRptAuto', m); };
    // repeaters + room servers Kelly knows, own callsign first, then the closest by hops
    function repeaters() {
      const call = k.myCall();
      return [...k.nodes()].filter(n => n.key && (n.role === 2 || n.role === 3))
        .sort((a, b) => (call && (b.longName || '').toUpperCase().includes(call)) - (call && (a.longName || '').toUpperCase().includes(call))
          || (a.hops ?? 99) - (b.hops ?? 99) || (a.longName || '').localeCompare(b.longName || ''));
    }
    const current = () => { const l = repeaters(); return l.find(n => n.key === ui.sel) || l[0] || null; };
    // ▦ QR of the selected repeater / room server (js/meshqr.js): contact/add with the type FROM THE CONTACT (2 / 3),
    // never the default 1. Key, name and type only -- the dialog shows no password, and none is ever put in a QR.
    const QR = () => window.KellyMeshQR;
    let qrUi = null;
    const qrType = n => (QR() && n && /^[0-9a-f]{64}$/i.test(n.key || '') && [2, 3, 4].includes(n.role) ? n.role : 0);
    function showQr(n) {
      const t = qrType(n); if (!t) return;
      qrUi = qrUi || QR().ui({ toast });
      return qrUi.show({ title: `▦ ${n.longName}`, contact: { key: n.key, type: t, name: n.longName }, note: 'Anyone who scans it can add this node as a contact. Logging in still needs its password, which is never in a QR code.' });
    }
    const nameOfPrefix = p => { const n = [...k.nodes()].find(x => x.key && x.key.startsWith(p)); return n ? n.longName : null; };
    const redraw = () => { ui.sig = ''; k.dirty('mesh'); };
    // Mesh Quest: Repeater Admin, and Repeater Hero from the packets YOUR repeaters (admin login) have sent
    // a login with MeshCore's stock admin password ('password', or none) never counts for Repeater Admin / Hero (AWARDS_REVIEW.md 6.9)
    const DEFAULT_PW = ['', 'password', 'hello'], isDefaultPw = pw => DEFAULT_PW.includes(String(pw == null ? '' : pw).trim().toLowerCase());
    const hero = (n, r) => { if (k.SS) k.SS('rptStatus', n, r.status); if (k.F) k.F('repeater', { key: n.key, name: n.longName, admin: !!(r.login && r.login.admin), defaultPw: !!(r.login && r.login.defaultPw), sent: r.status.sent, uptimeS: r.status.uptimeS }); };

    // The route the node has stored TO this repeater (meshcore.js parseContact outPath): null = none, it floods.
    // A "direct" one left over from when the repeater was next to you (a backpack node, 2026-10-29) can't arrive.
    const routeOf = n => !n.outPath ? { kind: 'flood', text: 'flood (no route learned yet)' }
      : !n.outPath.h.length ? { kind: 'direct', text: 'direct (zero hop: it hears your node itself)' }
      : { kind: 'learned', text: n.outPath.h.join(' → ') };
    // one call at a time per repeater; busy text shows what's happening (a failed login takes ~16 s).
    // An answer lost on a weak hop is common (a node at -10.5 dB: 1 login in 4 came back), so a call with no
    // answer is tried once more (tries = 2) before it's reported. "wrong password" (LOGIN_FAIL) is never retried.
    // Still no answer while a stored route was used -> r.flood = the action, and the card offers "Try again by flood".
    async function run(n, what, fn, tries = 1, act = '') {
      const r = R(n.key), s = k.session();
      if (!s || !s.login) { toast('📡', 'Connect a MeshCore node first', 'Repeater management goes through your own companion node.', 'warn'); return; }
      r.busy = what; r.err = ''; r.noAns = false; redraw();
      try {
        for (let i = 1; ; i++) {
          try { const v = await fn(s); r.at = Date.now(); return v; }
          catch (e) { if (i >= tries || !/^no /.test(e.message)) throw e; r.busy = `${what} · no answer, trying once more`; redraw(); }
        }
      } catch (e) {
        r.err = `${what}: ${e.message}`; r.noAns = /^no /.test(e.message); k.addEvent('network', `Mesh repeater ${n.longName}: ${r.err}`);
        if (act && /^no /.test(e.message) && n.outPath) r.flood = act;
      } finally { r.busy = ''; redraw(); }
    }
    // forget the stored route (the next call floods and the answer teaches a fresh one), then do `act` again
    async function viaFlood(n) {
      const r = R(n.key), act = r.flood, s = k.session(); if (!act || !s || !s.setPath) return;
      r.flood = '';
      try { await s.setPath(n, null); n.outPath = null; n.hops = null; }
      catch (e) { r.err = `Forgetting the route: ${e.message}`; redraw(); return; }
      k.addEvent('network', `Mesh repeater ${n.longName}: route forgotten, trying by flood`);
      if (act === 'login') return login(n);
      return action(n, act);
    }
    async function login(n) {
      const pw = ($('#rp-pw') || {}).value || '', remember = ($('#rp-rem') || {}).checked;
      const r = R(n.key);
      r.flood = '';
      const v = await run(n, 'Logging in (a wrong password gets no answer: up to ~16 s a try)', s => s.login(n, pw), 2, 'login');
      if (!v) { r.login = null; return; }
      r.login = { ...v, t: Date.now(), defaultPw: isDefaultPw(pw) };
      if (v.clock != null) r.clock = { s: /^OK/.test(v.clockSet || '') ? nowS() : v.clock, at: Date.now() };
      setPw(n.key, remember ? pw : ''); redraw();
      k.sfx('ack');
      toast('🔑', `Logged in to ${n.longName}`, `${v.admin ? 'Admin' : 'Guest'}${v.clockSet ? ` · ${/^OK/.test(v.clockSet) ? 'its clock was slow: set' : v.clockSet}` : ''}`, 'good');
      if (v.admin) await refresh(n);
    }
    // Status / Telemetry / Neighbours, each tried twice ('all' = the three in turn; a flood offer re-runs all three)
    async function action(n, what) {
      const r = R(n.key);
      const all = what === 'all';
      r.flood = '';
      // 'all' stops at the first read that gets no answer: the next two would only wait out the same weak link
      if (what === 'status' || all) { const v = await run(n, 'Reading status', s => s.status(n), 2, what); if (v) { r.status = { ...v, t: Date.now() }; hero(n, r); } else if (all) return; }
      if (what === 'tel' || all) { const v = await run(n, 'Reading telemetry', s => s.telemetry(n), 2, what); if (v) { r.tel = { list: v, t: Date.now() }; if (k.SS) k.SS('rptTel', n, v); } else if (all) return; }
      if (what === 'neigh' || all) { const v = await run(n, 'Reading neighbours', s => s.neighbours(n), 2, what); if (v) r.neigh = { ...v, t: Date.now() }; }
      redraw();
    }
    const refresh = n => action(n, 'all');
    async function setClock(n) {
      const r = R(n.key), v = await run(n, 'Setting its clock', s => s.setClock(n));
      if (v == null) return;
      r.clockMsg = v;
      if (/^OK/.test(v)) { r.clock = { s: nowS(), at: Date.now() }; toast('🕒', `${n.longName}: clock set`, v, 'good'); }
      else toast('🕒', `${n.longName}: clock not set`, /backwards/.test(v) ? 'Its clock is ahead, and MeshCore never turns a clock back: power it off and on, then set it.' : v, 'warn');
      redraw();
    }
    async function setOwnClock() {
      const s = k.session(); if (!s || !s.setOwnClock) return;
      try { ui.ownClock = { s: await s.setOwnClock(), at: Date.now(), msg: 'set to this PC\'s time' }; toast('🕒', 'Your node\'s clock is set', '', 'good'); }
      catch (e) { ui.ownClock = { ...(ui.ownClock || {}), msg: e.message }; toast('🕒', 'Your node\'s clock was not set', e.message, 'warn'); }
      redraw();
    }
    async function readOwnClock() {
      const s = k.session(); if (!s || !s.ownClock) return;
      try { ui.ownClock = { s: await s.ownClock(), at: Date.now() }; } catch { /* older firmware: no clock to show */ }
    }
    async function cli(n, text) {
      text = String(text || '').trim(); if (!text) return;
      if (RISKY.test(text) && !confirm(`Send "${text}" to ${n.longName}?\n\nThis changes the repeater over the air. A wrong radio setting or password can leave it out of reach until someone gets to it with a USB cable.`)) return;
      const r = R(n.key), row = { cmd: text, t: Date.now() };
      r.cli.push(row); if (r.cli.length > 40) r.cli.shift();
      const reply = await run(n, `Running "${text}"`, s => s.cli(n, text));
      if (reply == null) row.err = r.err; else row.reply = reply;
      if (/^reboot/i.test(text)) r.login = null;   // it reboots without answering; a fresh login is needed
      redraw();
    }

    // ------------------------------------------------------------------ render
    function tiles(st) {
      const t = (label, v, note = '') => `<div class="tile"><small>${label}</small><b>${v}</b>${note ? `<span class="small dim">${note}</span>` : ''}</div>`;
      return `<div class="rp-tiles">${t('Battery', `${st.battV.toFixed(2)} V`)}${t('Noise floor', `${st.noise} dBm`, st.noise <= -115 ? 'quiet' : st.noise <= -105 ? 'some noise' : 'noisy')}`
        + `${t('Last heard', `${st.rssi} dBm`, `SNR ${st.snr} dB`)}${t('Up', fmtUp(st.uptimeS))}`
        + `${t('Airtime TX', `${st.txAirS} s`, pct(st.txAirS, st.uptimeS) + ' of the time')}${t('Airtime RX', `${st.rxAirS} s`, pct(st.rxAirS, st.uptimeS))}`
        + `${t('Packets', `${st.recv} in / ${st.sent} out`)}${t('Relayed (flood)', `${st.sentFlood}`, `${st.recvFlood} floods heard`)}`
        + `${t('Duplicates', `${st.dupFlood}`, 'the same flood by another path')}${t('Errors', `${st.errors}${st.recvErrors != null ? ` / ${st.recvErrors} CRC` : ''}`, st.txQueue ? `${st.txQueue} queued` : 'queue empty')}</div>`;
    }
    function render() {
      const box = $('#rp-card'); if (!box) return;
      const on = !!(k.caps().repeaters);
      box.hidden = !on; if (!on || k.currentPage() !== 'mesh') return;
      const list = repeaters(), n = current(), r = n ? R(n.key) : null;
      const sig = JSON.stringify([list.map(x => x.key + x.hops), n && n.key, n && n.outPath, r && [r.busy, r.err, r.flood, r.at, r.cli.length, !!r.login, r.clock && r.clock.at], k.online(), ui.own && ui.own.t, ui.ownClock, Math.floor(Date.now() / 30000)]);
      if (sig === ui.sig) return; ui.sig = sig;
      $('#rp-tag').textContent = `${list.length} repeater${list.length === 1 ? '' : 's'} known`;
      const body = $('#rp-body');
      if (!list.length) { body.innerHTML = '<p class="small dim">No repeaters heard yet. A repeater shows up here once your node has its advert (they send one every few hours, or ask: <b>advert</b> on its own CLI).</p>' + ownHtml(); return; }
      const opt = list.map(x => `<option value="${esc(x.key)}"${x === n ? ' selected' : ''}>${esc(x.longName)} · ${x.hwLabel}${x.hops != null ? ` · ${x.hops === 0 ? 'direct' : x.hops + ' hop' + (x.hops > 1 ? 's' : '')}` : ''}</option>`).join('');
      const lg = r.login, pw = pwOf(n.key);
      let h = `<div class="row gap wrap rp-top"><label class="fld grow"><span>Repeater</span><select id="rp-sel">${opt}</select></label>`
        + `<label class="fld"><span>Password</span><input id="rp-pw" type="password" maxlength="15" autocomplete="off" size="14" value="${esc(pw)}" placeholder="admin password"></label>`
        + `<label class="tog small" title="Kept in this browser only, never in your settings or the cloud"><input type="checkbox" id="rp-rem"${pw ? ' checked' : ''}><i></i><span>Remember here</span></label>`
        + `<button class="btn primary" id="rp-login"${r.busy ? ' disabled' : ''}>🔑 Log in</button></div>`;
      h += `<div class="rp-state">${lg ? `<span class="rp-chip ok">${lg.admin ? '🛡️ Admin' : '👤 Guest'}</span> logged in ${esc(k.fmtAgo(lg.t))}${lg.fwLevel != null ? ` · firmware level ${lg.fwLevel}` : ''}${lg.clockSet ? ` · <span class="dim">${esc(/^OK/.test(lg.clockSet) ? 'its clock was slow: set' : lg.clockSet)}</span>` : ''}` : '<span class="rp-chip">Not logged in</span> <span class="small dim">Log in as admin for neighbours and the CLI.</span>'}</div>`;
      if (lg && lg.admin) h += `<div class="rp-state small">🕒 Its clock: <b>${esc(clockNote(r.clock) || 'not read')}</b>${r.clockMsg ? ` <span class="dim">· ${esc(r.clockMsg)}</span>` : ''}`
        + ` <button class="btn ghost small" data-rp="clock"${r.busy ? ' disabled' : ''} title="Sets it to this PC's time (over the air, ~1 s of airtime)">🕒 Set clock</button></div>`;
      const rt = routeOf(n);
      h += `<div class="rp-state small">🧭 Route your node has stored: <b>${esc(rt.text)}</b>`
        + (k.openTrace ? ` <button class="btn ghost small" data-rp="trace" title="Trace Route tab: finds the route if there isn't one, then shows the signal on every hop">🛰️ Trace the route</button>` : '') + '</div>';
      if (r.busy) h += `<div class="rp-busy">⏳ ${esc(r.busy)}…</div>`;
      if (r.err) h += `<div class="rp-err">⚠️ ${esc(r.err)}</div>`;
      if (r.err && !r.busy && r.noAns) {
        h += r.flood
          ? `<div class="rp-state small">No answer, tried twice, by the ${rt.kind === 'direct' ? '<b>direct</b> route (a repeater that has moved away, e.g. a node you carried somewhere, is no longer direct)' : `stored route <b>${esc(rt.text)}</b>`}. `
            + `<button class="btn small" data-rp="flood"${r.busy ? ' disabled' : ''} title="Forgets the stored route and sends it again as a flood; the answer teaches your node a fresh route">📡 Try again by flood</button></div>`
          : '';
        h += `<div class="rp-state small dim">Still nothing? A short trace often gets through where the longer login / status answers don't: 🛰️ Trace the route shows which hop is weak (below about -10 dB at SF8, answers get lost).</div>`;
      }
      h += `<div class="row gap wrap rp-btns"><button class="btn" data-rp="status"${r.busy ? ' disabled' : ''}>📊 Status</button><button class="btn" data-rp="tel"${r.busy ? ' disabled' : ''}>🌡️ Telemetry</button>`
        + `<button class="btn" data-rp="neigh"${r.busy ? ' disabled' : ''}>🛰️ Neighbours</button><button class="btn ghost" data-rp="all"${r.busy ? ' disabled' : ''}>⟳ All three</button>`
        + (qrType(n) ? `<button class="btn ghost" data-rp="qr" title="Its contact QR (key, name and type only: never a password)">▦ QR</button>` : '')
        + `<label class="tog small" title="While you're connected and logged in (or the password is remembered). Fills its battery / noise / airtime trends."><input type="checkbox" id="rp-auto"${autoOf(n.key) ? ' checked' : ''}><i></i><span>⏱ Status every 15 min</span></label></div>`;
      if (r.status) h += `<h4 class="rp-h">Status <small class="dim">${esc(k.fmtAgo(r.status.t))}</small></h4>${tiles(r.status)}`;
      if (r.tel) h += `<h4 class="rp-h">Telemetry <small class="dim">${esc(k.fmtAgo(r.tel.t))}</small></h4><div class="rp-tel">${r.tel.list.length ? r.tel.list.map(x => x.name === 'gps'
        ? `<span class="rp-chip">📍 ${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}</span>` : `<span class="rp-chip">${esc(x.name)} <b>${x.value}${esc(x.unit)}</b>${x.ch > 1 ? ` <small>ch ${x.ch}</small>` : ''}</span>`).join('') : '<span class="dim">Nothing reported</span>'}</div>`;
      if (r.neigh) h += `<h4 class="rp-h">Heard directly <small class="dim">${r.neigh.total} station${r.neigh.total === 1 ? '' : 's'} · ${esc(k.fmtAgo(r.neigh.t))}</small></h4>`
        + (r.neigh.list.length ? `<table class="rp-nb"><tr><th>Station</th><th>Last heard</th><th>SNR</th></tr>${r.neigh.list.map(x => `<tr><td>${esc(nameOfPrefix(x.prefix) || x.prefix)}</td><td>${esc(k.fmtAgo(Date.now() - x.ago * 1000))}</td><td>${x.snr} dB</td></tr>`).join('')}</table>`
          : '<p class="small dim">No zero-hop neighbours yet: it hears other repeaters only through yet another repeater. That is normal for a new site.</p>');
      h += `<details class="rp-cli"${r.cli.length ? ' open' : ''}><summary>⌨️ Remote CLI <small class="dim">(admin)</small></summary>`
        + `<div class="row gap wrap">${QUICK.map(q => `<button class="btn ghost small" data-rp-cli="${esc(q)}"${r.busy ? ' disabled' : ''}>${esc(q)}</button>`).join('')}</div>`
        + `<pre class="rp-log">${r.cli.length ? r.cli.map(c => `<b>&gt; ${esc(c.cmd)}</b>\n${c.reply != null ? esc(c.reply || '(done, no answer)') : c.err ? `<span class="bad">${esc(c.err)}</span>` : '…'}`).join('\n') : '<span class="dim">Commands and answers appear here.</span>'}</pre>`
        + `<div class="row gap"><input id="rp-cmd" class="grow" maxlength="150" placeholder="e.g. get radio, set advert.interval 3, neighbors" autocomplete="off"><button class="btn" id="rp-run"${r.busy ? ' disabled' : ''}>Run</button></div></details>`;
      // a redraw must not eat a half-typed password or command
      const keep = { pw: ($('#rp-pw') || {}).value, cmd: ($('#rp-cmd') || {}).value, rem: ($('#rp-rem') || {}).checked, focus: document.activeElement && document.activeElement.id, key: ui.drawn };
      const ol = body.querySelector('.rp-log'), olEnd = !ol || ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;   // scrolled up to read: stay there (js/keepscroll.js)
      body.innerHTML = h + ownHtml();
      ui.drawn = n.key;
      if (keep.key === n.key) {
        if (keep.pw != null && $('#rp-pw')) $('#rp-pw').value = keep.pw;
        if (keep.cmd && $('#rp-cmd')) $('#rp-cmd').value = keep.cmd;
        if (keep.rem != null && $('#rp-rem')) $('#rp-rem').checked = keep.rem;
        if (keep.focus && /^rp-(pw|cmd)$/.test(keep.focus)) $('#' + keep.focus).focus();
      }
      const log = body.querySelector('.rp-log'); if (log && (olEnd || keep.key !== n.key)) log.scrollTop = log.scrollHeight;
    }
    function ownHtml() {
      const o = ui.own;
      return `<details class="rp-own"${o ? ' open' : ''}><summary>📟 Your own node's counters</summary>`
        + (o ? `<div class="rp-tiles">${[['Battery', o.battV != null ? `${o.battV.toFixed(2)} V` : '–'], ['Noise floor', o.noise != null ? `${o.noise} dBm` : '–'], ['Last RX', o.rssi != null ? `${o.rssi} dBm · SNR ${o.snr}` : '–'],
          ['Airtime', o.txAirS != null ? `${o.txAirS} s TX · ${o.rxAirS} s RX` : '–'], ['Packets', o.recv != null ? `${o.recv} in / ${o.sent} out` : '–'], ['Up', o.uptimeS != null ? fmtUp(o.uptimeS) : '–']]
          .map(([a, b]) => `<div class="tile"><small>${a}</small><b>${esc(b)}</b></div>`).join('')}</div><p class="small dim">Read ${esc(k.fmtAgo(o.t))}.</p>` : '')
        + (ui.ownClock ? `<p class="small">🕒 Its clock: <b>${esc(clockNote(ui.ownClock) || 'not read')}</b>${ui.ownClock.msg ? ` <span class="dim">· ${esc(ui.ownClock.msg)}</span>` : ''}</p>` : '')
        + `<button class="btn ghost small" id="rp-own">Read them</button> <button class="btn ghost small" id="rp-ownclock" title="Sets your node to this PC's time">🕒 Set clock</button></details>`;
    }

    function init() {
      const box = $('#rp-card'); if (!box) return;
      box.addEventListener('change', e => {
        if (e.target.id === 'rp-sel') { ui.sel = e.target.value; store.set('meshRptSel', ui.sel); redraw(); }
        if (e.target.id === 'rp-auto') { const n = current(); if (n) { setAuto(n.key, e.target.checked); if (e.target.checked) autoTick(true); } }
      });
      setInterval(() => autoTick(false), 60000);
      box.addEventListener('click', async e => {
        const n = current(); const b = e.target.closest('button'); if (!b) return;
        if (b.id === 'rp-own') { const s = k.session(); if (!s || !s.ownStats) return; try { ui.own = { ...(await s.ownStats()), t: Date.now() }; if (k.SS) k.SS('own', ui.own); await readOwnClock(); } catch (er) { toast('📟', 'No answer from your node', er.message, 'warn'); } redraw(); return; }
        if (b.id === 'rp-ownclock') return setOwnClock();
        if (!n) return;
        if (b.id === 'rp-login') return login(n);
        if (b.id === 'rp-run') { const i = $('#rp-cmd'); const v = i.value; i.value = ''; return cli(n, v); }
        if (b.dataset.rpCli) return cli(n, b.dataset.rpCli);
        const r = R(n.key), what = b.dataset.rp;
        if (what === 'qr') return showQr(n);
        if (what === 'clock') return setClock(n);
        if (what === 'flood') return viaFlood(n);
        if (what === 'trace') { const v = k.openTrace && k.openTrace(n.key); if (v && v.ok === false) toast('🛰️', 'Trace Route', v.reason || 'not available', 'warn'); return; }
        if (['status', 'tel', 'neigh', 'all'].includes(what)) await action(n, what);
        redraw();
      });
      box.addEventListener('keydown', e => { if (e.target.id === 'rp-cmd' && e.key === 'Enter') { e.preventDefault(); const n = current(); if (n) { const v = e.target.value; e.target.value = ''; cli(n, v); } }
        if (e.target.id === 'rp-pw' && e.key === 'Enter') { e.preventDefault(); const n = current(); if (n) login(n); } });
    }
    let autoBusy = false;
    async function autoTick(now) {
      const s = k.session(); if (autoBusy || !s || !s.login || !s.status || (k.online && !k.online())) return;
      autoBusy = true;
      try {
        for (const n of repeaters()) {
          const r = R(n.key); if (!autoOf(n.key) || r.busy) continue;
          if (!now && Date.now() - Math.max(r.status ? r.status.t : 0, r.autoAt || 0) < AUTO_MS) continue;
          r.autoAt = Date.now();
          if (!r.login) {
            const pw = pwOf(n.key); if (!pw) continue;   // not logged in, nothing remembered: wait for the user
            const v = await run(n, 'Logging in (auto status)', x => x.login(n, pw)); if (!v) continue;
            r.login = { ...v, t: Date.now(), defaultPw: isDefaultPw(pw) };
          }
          const st = await run(n, 'Reading status (auto, every 15 min)', x => x.status(n)); if (st) { r.status = { ...st, t: Date.now() }; hero(n, r); }
        }
      } finally { autoBusy = false; }
    }
    // a fresh session knows nothing about logins: the repeater keeps them, but Kelly re-asks to be sure
    function online() { for (const key in rs) rs[key].login = null; redraw(); }
    // Station SCADA (live) starting up: what this card already knows, so its panels aren't blank until the next read
    function replay() {
      if (!k.SS) return;
      for (const [key, r] of Object.entries(rs)) { const n = [...k.nodes()].find(x => x.key === key); if (!n) continue; if (r.status) k.SS('rptStatus', n, r.status); if (r.tel) k.SS('rptTel', n, r.tel.list); }
      if (ui.own) k.SS('own', ui.own);
    }
    return { render, init, online, replay };
  };
})();
