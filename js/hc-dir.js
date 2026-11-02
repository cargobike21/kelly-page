/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts > the P25X ham directory (#hc-dir; 2026-10-24, unreleased).
 * A shared list of hams' MeshCore nodes, carried over P25 by the P25X gateway (like the APRS iGate club list), so a
 * ham can put other hams on their radio in one go -- and list themselves so others can add them.
 * Trust: every entry is SELF-SIGNED by that ham's own node (svc.signEntry -> the companion's SIGN_*), over
 * HC.dirBytes(entry). Only a key's own node can publish or withdraw its entry; every entry is checked here with
 * HC.verifyEntry before it is shown or used (bad ones are dropped and counted). Only the callsign, node name, type and
 * public key are shared -- never a private key, a position, or anyone else's entry.
 * Opt-in (store 'hcDirOptIn', off by default): nothing goes on the air until the user turns it on.
 * On the air (hc-core.js header): {op: 'hdir', have: v} on first show (at most hourly), on Check now, and when the
 * gateway pushes {app: 'hdir', notify: 1, v}; {op: 'hdirput', e} for List me / Withdraw. The gateway's whole-list
 * answer replaces ours (withdrawn entries are simply left out of it; an x: 1 entry in a list also removes that key).
 * Source (store 'hcDirSource', js/websync.js): 'auto' (default) = HTTPS from kellypage.app when online and not on file://, else
 * P25; 'p25' | 'https' | 'both'. HTTPS: GET /api/hamdir is a KPD1 envelope checked against the pinned licence key, then every
 * entry against its own node's signature; List me / Withdraw POST the entry with this station's registration token
 * (/api/hamdir/put). live.h = the envelope's `at` (never goes back). Tests: tests/websync-test.js, hc-dir-tests.html.
 * Last good list: store 'hcDir' = { v, e: [entry], checked, at, bad } (<= HC.DIR_MAX, newest `at` per key, ~100 kB max).
 * Demo: a made-up directory of the demo world's hams, properly signed by their own demo keys, plus one forged entry
 * that is rejected and counted. Nothing is sent. Demo entries carry demo: true and a made-up f.
 * Awards (AWARDS_REVIEW.md section 4, review/07-build-contract.md): entries may carry the gateway's f (unix s the
 * CALLSIGN was first accepted; outside the signed bytes, kept as given). Bus 'dir' { mineListed, firstOf: { CALL: f },
 * demo? }: mineListed = our own key is in the gateway's verified list (never in the demo). Adds made here carry
 * from: 'dir' on the service's 'op' events. A reply with you: CALL (the gateway's callsign for our radio) goes to
 * c.setGwCall (settings.gwCall + KellyHamCalls.bump()).
 * ▦ per live (not withdrawn) row: that entry's contact/add QR in KellyMeshQR's dialog, "from the P25X directory" (screen only).
 * window.KellyHCDir(mount, c) -> { destroy(), _t (tests) }
 */
(function () {
  'use strict';
  const HOUR = 3600000, ANSWER_MS = 180000, SHOW_MAX = 300, RENDER_MS = 1000;

  window.KellyHCDir = function (mount, c) {
    const HC = c.HC, esc = c.esc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`));
    const offs = [], timers = new Set();
    let dead = false;
    const sget = (k, d) => { try { const v = c.store.get(k, d); return v == null ? d : v; } catch { return d; } };
    const sset = (k, v) => { try { c.store.set(k, v); } catch { /* storage full: the shell's store toasts */ } };
    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!dead) { try { fn(); } catch (e) { console.warn('Ham directory', e); } } }, ms); timers.add(t); return t; };
    const nowS = () => Math.floor(Date.now() / 1000);

    // ------------------------------------------------------------ the list
    // entries -> { list (verified, live, newest per key, newest first, <= DIR_MAX), bad (count dropped) }
    function take(entries, base) {
      const map = new Map((base || []).map(e => [e.k, e]));
      let bad = 0;
      for (const raw of Array.isArray(entries) ? entries : []) {
        const r = HC.verifyEntry(raw, c.ed);
        if (!r.ok) { bad++; continue; }
        const e = r.entry, old = map.get(e.k), f = Math.floor(Number(raw.f));
        if (f >= 1.6e9 && f <= 4.2e9) e.f = f;   // first accepted (per callsign) -- not signed, so only a date for the awards
        else if (old && old.f && old.c === e.c) e.f = old.f;
        if (raw.demo) e.demo = true;
        if (old && old.at >= e.at) continue;
        map.set(e.k, e);
      }
      const list = [...map.values()].filter(e => !e.x).sort((a, b) => b.at - a.at).slice(0, HC.DIR_MAX);
      return { list, bad };
    }
    function loadLive() {
      const d = sget('hcDir', null);
      if (!d || !Array.isArray(d.e)) return { v: 0, e: [], checked: 0, at: 0, bad: 0 };
      const r = take(d.e);   // checked again: localStorage can be edited
      return { v: Number(d.v) | 0, h: Number(d.h) || 0, e: r.list, checked: Number(d.checked) || 0, at: Number(d.at) || 0, bad: Number(d.bad) || 0 };
    }
    let optIn = !!sget('hcDirOptIn', false);
    // re-checking the stored list costs ~4 ms an entry (Ed25519 in JS): only for a user who opted in
    let live = optIn ? loadLive() : { v: 0, e: [], checked: 0, at: 0, bad: 0 }, demoDir = null;
    const saveLive = () => sset('hcDir', { v: live.v, h: live.h || 0, e: live.e, checked: live.checked, at: live.at, bad: live.bad });
    const D = () => (c.demo() ? demoDir || (demoDir = buildDemo()) : live);

    // ------------------------------------------------------------ source: P25 (the gateway) and/or HTTPS (kellypage.app)
    // store 'hcDirSource' = 'auto' (default: https when online and not on file://, else p25) | 'p25' | 'https' | 'both'.
    // The HTTPS list is a KPD1 envelope signed by the pinned licence key AND each entry is still checked against its own
    // node's signature (take -> HC.verifyEntry), so kellypage.app can add or drop entries but never forge one.
    let source = String(sget('hcDirSource', 'auto')); if (!['auto', 'p25', 'https', 'both'].includes(source)) source = 'auto';
    const WS = () => c.websync || window.KellyWebSync;
    const webOk = () => { try { return !!WS() && (c.web ? !!c.web() : WS().webOk()); } catch { return false; } };
    const effSrc = () => (source === 'auto' ? (webOk() ? 'https' : 'p25') : source);   // 'p25' | 'https' | 'both'
    const licKeys = () => { try { return c.licenceKeys ? c.licenceKeys() : window.KellyToken ? Object.values(window.KellyToken.KEYS) : []; } catch { return []; } };
    const regToken = () => { try { return c.regToken ? c.regToken() : window.KellyReg && window.KellyReg.token ? window.KellyReg.token() : ''; } catch { return ''; } };
    let httpsAsk = 0;
    async function fetchHttps(why) {
      if (why !== 'manual' && Date.now() - httpsAsk < 20000) return;
      httpsAsk = Date.now();
      let r;
      try { r = await WS().pullHamdir({ fetch: c.fetch, ed: c.ed, keys: licKeys() }); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      if (dead || c.demo()) return;
      if (!r.ok) { live.hError = r.error; if (why === 'manual' || effSrc() === 'https') note('bad', `kellypage.app: ${r.error}.`); else schedule(); return; }
      live.hError = '';
      if (r.at < (live.h || 0)) { note('bad', 'kellypage.app sent an older directory than the one Kelly has -- ignored.'); return; }
      const t = take(r.e, effSrc() === 'both' ? live.e : null);   // https alone: its list replaces ours; both: merged (newest per key)
      live = Object.assign({}, live, { e: t.list, h: r.at, checked: Date.now(), at: Date.now(), bad: t.bad });
      saveLive(); changed(true);
      note(t.bad ? 'bad' : 'ok', `Directory from kellypage.app: ${t.list.length} ham${t.list.length === 1 ? '' : 's'}${t.bad ? ` -- ${t.bad} entr${t.bad === 1 ? 'y' : 'ies'} failed the signature check and ${t.bad === 1 ? 'was' : 'were'} dropped` : ''}.`);
    }
    // My entry (already signed by my node and checked) to kellypage.app, with this station's registration token and a
    // signature by this station's device key (KellyIdent) proving it holds the registration
    const identSign = () => (c.identSign ? c.identSign : window.KellyIdent && typeof window.KellyIdent.sign === 'function' ? m => window.KellyIdent.sign(m) : null);
    async function putHttps(entry) {
      const token = regToken();
      if (!token) return HC.fail('refused', 'Listing on kellypage.app needs this station registered (Admin › Register this station).');
      const sign = identSign();
      if (!sign) return HC.fail('refused', 'Listing on kellypage.app needs this station\'s device key (Admin › Register this station).');
      const r = await WS().putHamdir({ fetch: c.fetch, entry, token, sign });
      if (!r.ok) return HC.fail('refused', `kellypage.app refused it: ${r.error || 'no reason given'}.`);
      const base = live.e.filter(e => e.k !== entry.k); if (!entry.x) base.push(entry);
      live.e = take([], base).list; live.h = live.h || 1; saveLive(); changed(); feedCalls([entry]);
      return HC.ok(entry, entry.x ? 'You are off the P25X ham directory on kellypage.app.' : 'You are on the P25X ham directory on kellypage.app.');
    }

    function feedCalls(list, replace) {
      const K = window.KellyHamCalls;
      if (K && typeof K.fromDir === 'function') { try { K.fromDir(list, replace ? { replace: true } : undefined); } catch (e) { console.warn('Ham directory: callsigns', e); } }
    }
    // bus 'dir' payload: { mineListed, firstOf: { CALL: unix s }, demo? }
    function dirInfo() {
      const demo = !!c.demo(), d = D(), k = myKey(), firstOf = {};
      for (const e of d.e) if (e.f && (!firstOf[e.c] || e.f < firstOf[e.c])) firstOf[e.c] = e.f;
      const out = { mineListed: !demo && !!k && (live.v > 0 || live.h > 0) && live.e.some(e => e.k === k && !e.x), firstOf };
      if (demo) out.demo = true;
      return out;
    }
    const emitDir = () => { let p; try { p = dirInfo(); } catch { p = { mineListed: false, firstOf: {} }; } try { c.bus.emit('dir', p); } catch { /* never throw */ } };
    function changed(replace) { const d = D(); feedCalls(d.e, replace && !c.demo()); emitDir(); schedule(); }

    // ------------------------------------------------------------ demo
    function buildDemo() {
      const w = c.demoWorld && c.demoWorld();
      if (!w) return { v: 1, e: [], checked: Date.now(), at: Date.now(), bad: 0, demo: true };
      const t0 = nowS(), raw = [];
      (w.stations || []).filter(s => HC.callFromName(s.name) && !s.yours).forEach((s, i) => {
        const e = { k: w.keyOf(s.name), c: HC.callFromName(s.name), n: s.name, t: [1, 2, 3, 4].includes(s.type) ? s.type : 1, at: t0 - (i + 1) * 5400, x: 0 };
        // made-up "first listed": every third ham is new this week (Welcome Wagon's window shows), the rest months ago
        raw.push({ ...e, s: HC.b64u(w.sign(s.name, HC.dirBytes(e))), f: i % 3 === 1 ? t0 - (i + 1) * 9000 : t0 - (40 + i * 11) * 86400, demo: true });
      });
      // a forged entry: VK4ZZX's key, but signed by someone else's node -- must be rejected
      const f = { k: w.keyOf('VK4ZZX Forged'), c: 'VK4ZZX', n: 'VK4ZZX Forged', t: 1, at: t0 - 600, x: 0 };
      raw.push({ ...f, s: HC.b64u(w.sign('VK4ZZB Springfield', HC.dirBytes(f))) });
      const r = take(raw);
      return { v: 1, e: r.list, checked: Date.now(), at: Date.now(), bad: r.bad, demo: true };
    }

    // ------------------------------------------------------------ status line of this box
    let msg = null;   // { kind: 'ok'|'bad'|'info', text }
    const note = (kind, text) => { msg = { kind, text, at: Date.now() }; schedule(true); };
    const sayR = r => { try { c.say(r); } catch { /* shell missing */ } };

    // ------------------------------------------------------------ fetch
    let fetchAsk = null, putAsk = null, running = null, pub = null;   // running: 'add' | 'bulk' (radio adds); pub: 'sign' | 'put' (List me / Withdraw)
    async function fetchDir(why) {
      try {
        if (c.demo()) { demoDir = buildDemo(); note('info', `Demo directory: ${demoDir.e.length} made-up hams${demoDir.bad ? `, ${demoDir.bad} forged entry rejected` : ''}. Nothing was sent.`); changed(); return; }
        if (!optIn) return;
        const es = effSrc();
        if (es !== 'p25') {
          if (!webOk()) { if (es === 'https') { note('bad', 'kellypage.app needs an internet connection and Kelly opened from a web address (not a file). Pick the P25X gateway as the source instead.'); return; } }
          else { await fetchHttps(why); if (es === 'https') return; }
        }
        if (fetchAsk && Date.now() - fetchAsk.at < ANSWER_MS) { if (why === 'manual') note('info', 'Already asking the P25X gateway -- waiting for its answer.'); return; }
        let p = null;
        try { p = c.kfRequest({ op: 'hdir', have: live.v }, 'Ham Contacts: is there a newer P25X ham directory?'); } catch { p = null; }
        if (!p) { note('bad', 'No radio: the directory comes from the P25X gateway over P25. Connect your P25 radio (Admin › Connect).'); return; }
        const ask = fetchAsk = { at: Date.now() };
        schedule(true);
        let xid = null; try { xid = await p; } catch { xid = null; }
        if (dead || fetchAsk !== ask) return;
        if (!xid) { fetchAsk = null; note('bad', 'Not sent: connect your P25 radio first (Admin › Connect) -- the directory comes over P25.'); return; }
        live.checked = Date.now(); saveLive();   // only once it really went (no radio = try again next time)
        if (why === 'manual') note('info', 'Asked the P25X gateway for the directory -- answers take up to a minute or two.');
        later(() => { if (fetchAsk === ask) { fetchAsk = null; note('bad', 'No answer from the P25X gateway after 3 minutes. It may not have the directory yet, or the radio link is down -- try Check now later.'); } }, ANSWER_MS);
      } catch (e) { console.warn('Ham directory fetch', e); }
    }

    function onReply(j) {
      if (!j || j.app !== 'hdir') return;
      if (Object.prototype.hasOwnProperty.call(j, 'you') && !c.demo() && typeof c.setGwCall === 'function') { try { c.setGwCall(j.you); } catch (e) { console.warn('Ham directory: gateway callsign', e); } }
      if (j.notify) { if ((Number(j.v) || 0) > live.v && optIn && !c.demo()) fetchDir('notify'); return; }
      if (j.put) return onPut(j);
      fetchAsk = null;
      if (j.error) { live.error = String(j.error); note('bad', `The P25X gateway says: ${j.error}`); return; }
      live.error = '';
      if (j.cur) { live.checked = Date.now(); saveLive(); if (!c.demo()) { emitDir(); note('ok', `The directory is up to date (version ${live.v}, ${live.e.length} ham${live.e.length === 1 ? '' : 's'}).`); } else schedule(); return; }
      if (Array.isArray(j.e)) {
        const r = take(j.e);
        live = { v: Number(j.v) | 0, h: live.h || 0, e: r.list, checked: Date.now(), at: Date.now(), bad: r.bad };
        saveLive();
        if (!c.demo()) changed(true);   // in the demo it is kept for later (the demo's end feeds it to the callsigns)
        note(r.bad ? 'bad' : 'ok', `Directory version ${live.v}: ${r.list.length} ham${r.list.length === 1 ? '' : 's'}${r.bad ? ` -- ${r.bad} entr${r.bad === 1 ? 'y' : 'ies'} failed the signature check and ${r.bad === 1 ? 'was' : 'were'} dropped` : ''}.`);
      }
    }
    function onPut(j) {
      const a = putAsk; putAsk = null; if (pub === 'put') pub = null;
      if (j.ok) {
        const withdrawn = a ? !!a.entry.x : false;
        if (a) {
          const base = live.e.filter(e => e.k !== a.entry.k);
          if (!a.entry.x) base.push(a.entry);
          live.e = take([], base).list;
          if (live.v === a.baseV && Number(j.v) === a.baseV + 1) live.v = Number(j.v);   // nobody else changed it in between
          else later(() => fetchDir('after-put'), 3000);
          saveLive(); if (!c.demo()) changed(); feedCalls([a.entry]);
        } else later(() => fetchDir('after-put'), 3000);
        const r = HC.ok({ v: j.v }, !a ? 'The P25X gateway confirmed your directory change.' : withdrawn ? 'You are off the P25X ham directory.' : 'You are on the P25X ham directory -- other hams get it within the hour.');
        sayR(r); note('ok', r.msg);
      } else {
        const r = HC.fail('refused', j.same ? 'The P25X gateway already has that entry.' : `The P25X gateway refused it: ${j.error || 'no reason given'}.`);
        sayR(r); note('bad', r.error);
      }
    }
    offs.push(c.onGateway(j => { try { onReply(j); } catch (e) { console.warn('Ham directory reply', e); } }));

    // ------------------------------------------------------------ List me / Withdraw
    const st = () => { try { return c.svc.state(); } catch { return { link: { online: false }, me: null, busy: [] }; } };
    function myCallsign(s) {
      const me = s.me; let call = null;
      const K = window.KellyHamCalls;
      if (me && K && typeof K.callOf === 'function') { try { const x = K.callOf(me.key, me.name); call = x && x.call; } catch { call = null; } }
      return HC.normCall(call) || HC.normCall(me && me.call) || HC.normCall(c.myCall && c.myCall()) || null;
    }
    const myKey = () => { const s = st(); return s.me ? s.me.key : null; };
    const mine = () => { const k = myKey(); return k ? D().e.find(e => e.k === k) || null : null; };
    async function publish(withdraw) {
      if (pub) return HC.fail('busy', 'Wait for the last one to finish.');
      const res = await (async () => {
        if (!c.demo() && !optIn) return HC.fail('refused', 'Turn on "Use the P25X ham directory" first.');
        const s = st();
        if (!s.link || !s.link.online || !s.me) return HC.fail('offline', 'Connect your MeshCore node first: only your own node can sign your directory entry.');
        const call = myCallsign(s);
        if (!call) return HC.fail('invalid', 'Kelly needs your callsign first: put it in Settings (or in your node\'s name). The directory lists hams by callsign.');
        const prev = mine(), entry = { k: s.me.key, c: call, n: String(s.me.name || ''), t: 1, at: Math.max(nowS(), prev ? prev.at + 1 : 0, putAsk ? putAsk.entry.at + 1 : 0), x: withdraw ? 1 : 0 };
        if (!HC.normEntry(entry)) return HC.fail('invalid', 'Your node\'s name is too long (31 bytes at most) or holds odd characters -- rename it first.');
        pub = 'sign'; schedule(true);
        const r = await c.svc.signEntry(entry);
        if (!r || !r.ok) return r || HC.fail('error', 'Your node did not sign the entry.');
        const v = HC.verifyEntry(r.value, c.ed);
        if (!v.ok) return HC.fail('error', `Your node's signature did not check out (${v.error}).`);
        if (c.demo()) {
          const d = D(), base = d.e.filter(e => e.k !== v.entry.k);
          if (!v.entry.x) base.push(v.entry);
          d.e = take([], base).list; changed();
          return HC.ok(v.entry, withdraw ? 'Demo: withdrawn here only -- nothing was sent.' : 'Demo: signed by your node and listed here only -- nothing was sent.');
        }
        const es = effSrc();
        if (es !== 'p25') {   // kellypage.app: needs the registration token + this entry (self-signed by the node)
          if (!webOk()) { if (es === 'https') return HC.fail('offline', 'kellypage.app needs an internet connection and Kelly opened from a web address (not a file). Pick the P25X gateway as the source instead.'); }
          else {
            pub = 'put'; schedule(true);
            const w = await putHttps(v.entry);
            if (es === 'https') return w;
            if (!w.ok) { sayR(w); note('bad', w.error); }   // both: carry on over P25
          }
        }
        let p = null;
        try { p = c.kfRequest({ op: 'hdirput', e: v.entry }, withdraw ? 'Ham Contacts: withdrawing my directory entry' : 'Ham Contacts: listing me in the P25X ham directory'); } catch { p = null; }
        if (!p) return HC.fail('offline', 'No radio: your entry goes to the P25X gateway over P25. Connect your P25 radio (Admin › Connect).');
        pub = 'put'; schedule(true);
        let xid = null; try { xid = await p; } catch { xid = null; }
        if (!xid) return HC.fail('offline', 'Not sent: connect your P25 radio first (Admin › Connect).');
        const ask = putAsk = { entry: v.entry, at: Date.now(), baseV: live.v };
        later(() => { if (putAsk === ask) { putAsk = null; if (pub === 'put') pub = null; note('bad', 'No answer from the P25X gateway after 3 minutes. It may not have the directory yet, or the radio link is down.'); } }, ANSWER_MS);
        return HC.ok(v.entry, withdraw ? 'Withdrawal sent to the P25X gateway -- waiting for its answer.' : 'Entry sent to the P25X gateway -- waiting for its answer.');
      })().catch(e => HC.fail('error', String(e && e.message || e)));
      if (pub === 'sign' || (pub === 'put' && !putAsk)) pub = null;
      sayR(res); note(res.ok ? (putAsk ? 'info' : 'ok') : 'bad', res.ok ? res.msg : res.error);
      return res;
    }

    // ------------------------------------------------------------ adding to my radio
    const onRadio = () => { try { return new Set(c.svc.contacts().map(r => r.key)); } catch { return new Set(); } };
    let bulk = null, ask = null, rowBusy = null;
    const picked = new Set();
    const addInput = e => ({ key: e.k, type: e.t, name: e.n, from: 'dir' });   // from: the 'op' events say it came from here
    async function addOne(k) {
      if (running) return HC.fail('busy', 'Wait for the last one to finish.');
      const e = D().e.find(x => x.k === k); if (!e) return HC.fail('invalid', 'That ham is no longer in the directory.');
      running = 'add'; rowBusy = k; schedule(true);
      let r; try { r = await c.svc.add(addInput(e)); } catch (err) { r = HC.fail('error', String(err && err.message || err)); }
      running = null; rowBusy = null;
      if (!r) r = HC.fail('error', 'No answer.');
      note(r.ok ? 'ok' : 'bad', r.ok ? (r.value && r.value.already ? `${e.c} is already on your radio.` : `${e.c} added to your radio. Ask them to add you too.`) : `${e.c}: ${r.error}`);
      return r;
    }
    // plan an add of several: skip the ones already there; check room first (warn past 90 %, offer only as many as fit)
    function planAdd(list, what) {
      if (running) return null;
      const on = onRadio(), me = myKey();
      const todo = list.filter(e => e.k !== me && !on.has(e.k)), already = list.filter(e => e.k !== me).length - todo.length;
      ask = null;
      if (!todo.length) { note('info', list.length ? `All ${what} are already on your radio.` : 'Nothing to add.'); return null; }
      let room; try { room = c.svc.room(todo.length); } catch { room = { ok: true, free: null, warn: null }; }
      if (!room.ok) {
        const fit = Math.max(0, room.free || 0);
        if (!fit) { note('bad', room.warn || 'Your node has no room for more contacts.'); return null; }
        ask = { list: todo.slice(0, fit), already, text: `${room.warn} Add only the first ${fit} (newest first)? That fills your node's contact table.`, btn: `Add the ${fit} that fit` };
      } else if (room.warn) ask = { list: todo, already, text: room.warn, btn: `Add ${todo.length} anyway` };
      else { runBulk(todo, already); return 'started'; }
      schedule(true); return 'ask';
    }
    async function runBulk(list, already) {
      if (running) return null;
      running = 'bulk'; ask = null;
      const b = bulk = { total: list.length, i: 0, added: [], already: already || 0, failed: [], stop: false, done: false };
      schedule(true);
      for (let i = 0; i < list.length; i++) {
        if (b.stop || dead) { list.slice(i).forEach(e => b.failed.push({ c: e.c, why: 'stopped' })); break; }
        const e = list[i]; b.i = i + 1;
        if (onRadio().has(e.k)) { b.already++; continue; }
        let r; try { r = await c.svc.add(addInput(e)); } catch (err) { r = HC.fail('error', String(err && err.message || err)); }
        if (r && r.ok) { if (r.value && r.value.already) b.already++; else { b.added.push(e.c); picked.delete(e.k); } }
        else {
          b.failed.push({ c: e.c, why: (r && r.error) || 'no answer' });
          if (r && (r.code === 'full' || r.code === 'offline')) { list.slice(i + 1).forEach(x => b.failed.push({ c: x.c, why: r.code === 'full' ? 'the node is full' : 'the node disconnected' })); break; }
        }
        schedule();
      }
      b.done = true; running = null;
      const sum = `Added ${b.added.length}, already on your radio ${b.already}, failed ${b.failed.length}.`;
      sayR(b.failed.length ? HC.fail('error', sum) : HC.ok(b, sum));
      note(b.failed.length ? 'bad' : 'ok', sum);
      return b;
    }

    // ------------------------------------------------------------ view
    let q = '', lastR = 0, rTimer = null, dirty = true;
    mount.innerHTML = `<div class="card hc-dr">
      <div class="card-h"><h2>🗂️ P25X ham directory</h2><span class="tag hc-dr-ver" data-r="ver">–</span></div>
      <label class="hc-dr-opt"><input type="checkbox" data-a="opt"> <span>Use the P25X ham directory</span></label>
      <label class="hc-dr-src"><span>Get it from</span> <select data-a="src" aria-label="Where the directory comes from"><option value="auto">Automatic (internet if online, else P25)</option><option value="https">kellypage.app (internet)</option><option value="p25">The P25X gateway (P25 radio)</option><option value="both">Both</option></select></label>
      <p class="hc-dr-note">Hams who list themselves here can be added to your radio in one go -- over P25, from the P25X gateway.
        Only a callsign, node name, type and <b>public</b> key are shared, never a private key or a position. Each entry is signed by
        that ham's own node, so <b>only your own radio can publish or withdraw your entry</b>, and Kelly checks every signature.</p>
      <div class="hc-dr-me" data-r="me"></div>
      <p class="hc-dr-msg" data-r="msg" aria-live="polite"></p>
      <div class="hc-dr-tools">
        <input type="search" class="hc-dr-q" data-a="q" placeholder="Search callsign or name" aria-label="Search the directory">
        <button class="btn ghost small" data-a="check" title="Ask the P25X gateway for a newer directory">⟳ Check now</button>
      </div>
      <div class="hc-dr-bulk" data-r="bulk"></div>
      <div class="hc-dr-list" data-r="list"></div>
      <p class="hc-dr-foot" data-r="foot"></p>
    </div>`;
    const R = n => mount.querySelector(`[data-r="${n}"]`);
    const optBox = mount.querySelector('[data-a="opt"]'), qBox = mount.querySelector('[data-a="q"]');
    optBox.checked = optIn;
    const srcBox = mount.querySelector('[data-a="src"]'); srcBox.value = source;

    function schedule(now) {
      dirty = true;
      if (dead) return;
      if (!c.visible()) return;
      if (now) { if (rTimer) { clearTimeout(rTimer); timers.delete(rTimer); rTimer = null; } render(); return; }   // a click's answer shows at once
      if (rTimer) return;
      rTimer = later(() => { rTimer = null; if (dirty && c.visible()) render(); }, Math.max(0, RENDER_MS - (Date.now() - lastR)));
    }
    const typeOf = t => `${HC.TYPE_ICON[t] || ''} ${HC.TYPE_NAME[t] || 'Node'}`;
    function render() {
      if (dead) return;
      dirty = false; lastR = Date.now();
      try {
        const d = D(), demo = c.demo(), on = onRadio(), s = st(), me = s.me ? s.me.key : null, show = demo || optIn;
        optBox.disabled = !!running || !!pub; optBox.checked = optIn;
        srcBox.disabled = !!running || !!pub; if (srcBox.value !== source) srcBox.value = source;
        mount.querySelector('.hc-dr').classList.toggle('hc-dr-off', !show);
        const ver = R('ver');
        ver.textContent = demo ? 'demo' : optIn ? (d.v || d.h ? `${d.v ? 'v' + d.v : 'web'} · ${d.e.length}` : 'not fetched') : 'off';
        ver.className = `tag hc-dr-ver${demo ? ' warn' : optIn && (d.v || d.h) ? ' ok' : ''}`;
        // me
        const my = mine(), call = myCallsign(s), canPub = show && !pub && s.link && s.link.online && !!s.me;
        R('me').innerHTML = !show ? '' : `<div class="hc-dr-mine">${s.me
          ? (my ? `✅ You're listed as <b class="hc-dr-call">${esc(my.c)}</b> · ${esc(my.n)}` : `You're not listed${call ? ` (you'd be listed as <b class="hc-dr-call">${esc(call)}</b> · ${esc(s.me.name)})` : ' -- Kelly needs your callsign (Settings) first'}.`)
          : 'Connect your MeshCore node to list yourself.'}</div>
          <div class="hc-dr-btns"><button class="btn primary small" data-a="listme" ${canPub && call ? '' : 'disabled'}>${pub === 'sign' ? '✍️ Signing…' : pub === 'put' ? '📡 Sending…' : my ? '↻ Update my entry' : '📇 List me'}</button>
          <button class="btn ghost small" data-a="withdraw" ${canPub && call && (my || !d.v) ? '' : 'disabled'} title="Take your entry off the directory (signed by your node)">Withdraw</button></div>`;
        const m = R('msg');
        m.textContent = msg ? msg.text : !show ? 'Off: nothing is sent or fetched until you turn it on.' : demo ? 'Demo: a made-up directory -- nothing is sent.' : fetchAsk ? 'Asking the P25X gateway…' : live.error ? `The P25X gateway says: ${live.error}` : '';
        m.className = `hc-dr-msg ${msg ? msg.kind : ''}`;
        mount.querySelector('[data-a="check"]').disabled = !show || !!fetchAsk || !!running;
        qBox.disabled = !show;
        // bulk area: a question, progress, or the add-all / add-picked buttons
        const ql = q.trim().toLowerCase();
        const rows = !show ? [] : d.e.filter(e => !ql || e.c.toLowerCase().includes(ql) || e.n.toLowerCase().includes(ql) || (HC.TYPE_NAME[e.t] || '').toLowerCase().includes(ql));
        for (const k of [...picked]) if (!d.e.some(e => e.k === k) || on.has(k)) picked.delete(k);
        const notYet = d.e.filter(e => e.k !== me && !on.has(e.k));
        let bh = '';
        if (!show) bh = '';
        else if (ask) bh = `<div class="hc-dr-ask">⚠️ ${esc(ask.text)} <span class="hc-dr-btns"><button class="btn primary small" data-a="askyes">${esc(ask.btn)}</button><button class="btn ghost small" data-a="askno">Cancel</button></span></div>`;
        else if (bulk && !bulk.done) bh = `<div class="hc-dr-prog"><span>Adding ${bulk.i} of ${bulk.total}… (${bulk.added.length} added)</span><span class="hc-dr-bar"><i style="width:${Math.round(100 * bulk.i / Math.max(1, bulk.total))}%"></i></span><button class="btn small" data-a="stop" ${bulk.stop ? 'disabled' : ''}>⏹ Stop</button></div>`;
        else {
          bh = `<div class="hc-dr-btns"><button class="btn small" data-a="addall" ${running || !notYet.length || !s.link.online ? 'disabled' : ''}>➕ Add all not yet on my radio (${notYet.length})</button>
            <button class="btn ghost small" data-a="addpicked" ${running || !picked.size || !s.link.online ? 'disabled' : ''}>Add picked (${picked.size})</button>
            ${picked.size ? '<button class="btn ghost small" data-a="clearpick">Clear picks</button>' : ''}</div>`;
          if (bulk && bulk.done) {
            bh += `<div class="hc-dr-sum"><b>Added ${bulk.added.length}</b> · already on your radio ${bulk.already} · failed ${bulk.failed.length}
              ${bulk.failed.length ? `<ul>${bulk.failed.slice(0, 20).map(f => `<li><b class="hc-dr-call">${esc(f.c)}</b>: ${esc(f.why)}</li>`).join('')}${bulk.failed.length > 20 ? `<li>…and ${bulk.failed.length - 20} more</li>` : ''}</ul>` : ''}
              <button class="btn ghost small" data-a="sumok">OK</button></div>`;
          }
        }
        R('bulk').innerHTML = bh;
        // list (keep its scroll)
        const L = R('list'), top = L.scrollTop;
        L.innerHTML = !show ? '' : !d.e.length ? `<p class="hc-dr-empty">${demo ? 'No demo hams.' : d.v || d.h ? 'Nobody is listed yet -- be the first: List me.' : 'Not fetched yet -- press Check now.'}</p>`
          : !rows.length ? '<p class="hc-dr-empty">No match.</p>'
          : rows.slice(0, SHOW_MAX).map(e => {
            const there = on.has(e.k), self = e.k === me;
            return `<div class="hc-dr-row${there ? ' on' : ''}" data-k="${esc(e.k)}">
              <input type="checkbox" data-a="pick" aria-label="Pick ${esc(e.c)}" ${picked.has(e.k) ? 'checked' : ''} ${there || self || running ? 'disabled' : ''}>
              <span class="hc-dr-who"><b class="hc-dr-call">${esc(e.c)}</b><span class="hc-dr-name">${esc(e.n)}</span></span>
              <span class="hc-dr-type">${esc(typeOf(e.t))}</span>
              <span class="tag ${self ? '' : there ? 'ok' : 'warn'} hc-dr-badge">${self ? 'you' : there ? 'on my radio' : 'not yet'}</span>
              <span class="hc-dr-when" title="${esc(new Date(e.at * 1000).toLocaleString())}">${esc(c.fmtAgo ? c.fmtAgo(e.at * 1000) : '')}</span>
              ${e.x ? '' : `<button class="btn ghost small hc-dr-qr" data-a="qr" title="Show ${esc(e.c)}'s contact QR (from the P25X directory) for someone to scan">▦</button>`}
              <button class="btn small hc-dr-add" data-a="add" ${there || self || running || !s.link.online ? 'disabled' : ''}>${rowBusy === e.k ? '…' : 'Add'}</button></div>`;
          }).join('');
        L.scrollTop = top;
        R('foot').textContent = !show ? '' : `${rows.length > SHOW_MAX ? `Showing ${SHOW_MAX} of ${rows.length} -- search to narrow. ` : ''}${d.bad ? `${d.bad} entr${d.bad === 1 ? 'y' : 'ies'} dropped: the signature didn't check out. ` : ''}${!c.ed ? 'This browser cannot check signatures (TweetNaCl did not load) -- reload Kelly. ' : ''}${d.checked && !demo ? `Checked ${c.fmtAgo ? c.fmtAgo(d.checked) : ''}.` : ''}`;
      } catch (e) { console.warn('Ham directory render', e); }
    }

    // ------------------------------------------------------------ events
    function onClick(ev) {
      const b = ev.target && ev.target.closest && ev.target.closest('[data-a]'); if (!b || b.disabled || !mount.contains(b)) return;
      const a = b.dataset.a, row = b.closest('[data-k]'), k = row && row.dataset.k;
      try {
        if (a === 'listme') publish(false);
        else if (a === 'withdraw') publish(true);
        else if (a === 'check') fetchDir('manual');
        else if (a === 'add' && k) addOne(k);
        else if (a === 'qr' && k) showQr(k);
        else if (a === 'addall') { const on = onRadio(), me = myKey(); planAdd(D().e.filter(e => e.k !== me && !on.has(e.k)), 'the hams in the directory'); }
        else if (a === 'addpicked') planAdd(D().e.filter(e => picked.has(e.k)), 'the picked hams');
        else if (a === 'clearpick') { picked.clear(); schedule(true); }
        else if (a === 'askyes' && ask) { const x = ask; runBulk(x.list, x.already); }
        else if (a === 'askno') { ask = null; schedule(true); }
        else if (a === 'stop' && bulk) { bulk.stop = true; schedule(true); }
        else if (a === 'sumok') { bulk = null; schedule(true); }
      } catch (e) { console.warn('Ham directory', e); }
    }
    // ▦ a live entry's contact QR (screen only): key, name and type exactly as its own node signed them
    let qrUi = null;
    function showQr(k) {
      const e = D().e.find(x => x.k === k && !x.x); if (!e) return;
      if (!qrUi && window.KellyMeshQR) qrUi = window.KellyMeshQR.ui({ toast: (...a) => { try { c.toast(...a); } catch { /* */ } } });
      if (!qrUi) { note('bad', 'The QR code drawer did not load -- reload Kelly.'); return; }
      qrUi.show({ title: `▦ ${e.c}'s contact`, contact: { key: e.k, type: e.t, name: e.n }, note: 'from the P25X directory' });
    }
    function onChange(ev) {
      const t = ev.target; if (!t || !t.dataset) return;
      if (t.dataset.a === 'opt') {
        optIn = !!t.checked; sset('hcDirOptIn', optIn); msg = null;
        if (optIn) { note('info', 'On. Kelly asks the P25X gateway for the directory now and then (at most hourly), and when it says there is a new one.'); if (c.visible()) maybeFetch(); }
        else note('info', mine() ? 'Off. You are still listed -- turn it on and press Withdraw to come off the directory.' : 'Off: nothing is sent or fetched.');
      } else if (t.dataset.a === 'src') {
        source = ['auto', 'p25', 'https', 'both'].includes(t.value) ? t.value : 'auto'; sset('hcDirSource', source);
        note('info', source === 'auto' ? 'Automatic: kellypage.app when you are online, the P25X gateway over P25 when not.' : source === 'https' ? 'From kellypage.app only.' : source === 'p25' ? 'From the P25X gateway over P25 only.' : 'From both kellypage.app and the P25X gateway.');
        if (optIn && c.visible()) fetchDir('manual');
      } else if (t.dataset.a === 'pick') {
        const k = t.closest('[data-k]') && t.closest('[data-k]').dataset.k;
        if (k) { if (t.checked) picked.add(k); else picked.delete(k); schedule(true); }
      }
    }
    function onInput(ev) { if (ev.target === qBox) { q = qBox.value; schedule(true); } }
    mount.addEventListener('click', onClick); mount.addEventListener('change', onChange); mount.addEventListener('input', onInput);

    function maybeFetch() { if (optIn && !c.demo() && Date.now() - (live.checked || 0) > HOUR) fetchDir('auto'); }
    const on = (ev, fn) => { try { const off = c.bus.on(ev, p => { try { fn(p); } catch (e) { console.warn('Ham directory', ev, e); } }); if (typeof off === 'function') offs.push(off); } catch { /* no bus */ } };
    on('visible', v => { if (v) { maybeFetch(); if (dirty) schedule(); } else if (qrUi) { try { qrUi.close(); } catch { /* */ } } });
    on('contacts', () => schedule());
    on('state', () => schedule());
    on('calls', () => schedule());
    on('demo', d => {
      ask = null; bulk = null; picked.clear(); msg = null;
      if (d) { demoDir = buildDemo(); changed(); }
      else { demoDir = null; feedCalls(live.e, true); emitDir(); schedule(true); }
    });
    if (c.demo()) demoDir = buildDemo();
    feedCalls(D().e, !c.demo());
    render();
    if (c.visible()) maybeFetch();
    if (!c.demo() && (live.v || live.h)) later(emitDir, 0);   // a stored gateway list: tell the listeners once (mesh.js subscribes after this runs)

    return {
      destroy() {
        dead = true;
        offs.forEach(f => { try { f(); } catch { /* */ } }); offs.length = 0;
        timers.forEach(clearTimeout); timers.clear();
        mount.removeEventListener('click', onClick); mount.removeEventListener('change', onChange); mount.removeEventListener('input', onInput);
        if (bulk) bulk.stop = true;
      },
      _t: { take, dirInfo, publish, fetchDir, fetchHttps, putHttps, effSrc, onReply, planAdd, runBulk, addOne, showQr, render, list: () => D(), live: () => live, ask: () => ask, bulk: () => bulk, msg: () => msg, running: () => running, pub: () => pub, picked },
    };
  };
})();
