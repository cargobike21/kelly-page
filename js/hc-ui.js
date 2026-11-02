/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts tab (2026-10-24, unreleased): get other hams onto your MeshCore radio's
 * contacts (and yourself onto theirs), because DMs, pings, traces and path discovery only work between stations that
 * have each other as contacts (js/hc-core.js says why). Plan, contract and file owners: HAM_CONTACTS_PLAN.md.
 * This file is the shell: layout, mount points, the shared context `c`, live / demo switching, the status line. Parts
 * (one file each, coded against js/hc-core.js + js/hc-service.js):
 *   js/hc-contacts.js  KellyHCContacts(mount, c)   contacts on my radio      (#hc-contacts)
 *                      KellyHCAnnounce(mount, c)   advert local / flood      (#hc-announce)
 *                      KellyHCHeard(mount, c)      heard, not added + auto-add (#hc-heard)
 *   js/hc-share.js     KellyHCShare(mount, c)      my card out, a card in    (#hc-share)
 *   js/hc-dir.js       KellyHCDir(mount, c)        the P25X ham directory    (#hc-dir)
 *   js/hc-calls.js     window.KellyHamCalls + KellyHCCalls(mount, c)  callsign mapping (#hc-calls)
 *   js/hc-ops.js       KellyHCOperators(mount, c)  📡 Heard operators: everyone heard, one table (#hc-ops; 2026-10-25) --
 *                      with it mounted the Heard box keeps only its bulk add + auto-add + discovery settings (c.opsTable)
 * Each returns { destroy?() }; a missing or failing part leaves its box empty.
 *
 * The shared context c (+ for hc-ops.js: opsTable true, live() -> Map key -> mesh.js node, chans(), openChannel(index,
 *   text), p25Of(node), openP25(id) -- see its header):
 *   bus (HC.createBus), HC (= window.KellyHC), svc (the live or demo service -- always the one in use; same API),
 *   $, esc, store (get(key, def) / set(key, v)), toast(icon, title, text, kind), fmtAgo(ms), root(), visible(),
 *   demo(), setDemo(on), demoWorld() -> the hc-demo.js world | null (its cardOf / keyOf / sign / stations),
 *   ed -> HC.naclEd(nacl) | null, myCall() -> settings callsign (upper case) | '',
 *   openTrace(key, method 'auto'|'trace'|'discover'|'ping' | null) -> { ok, reason } -- the Trace Route tab, that station
 *     selected (and the run started when a method is given; Trace Route's own limits and ping consent apply),
 *   openChat(key) -> { ok, reason? } -- the Mesh tab's chat with that station,
 *   kfRequest(obj, label) -> Promise<xid | null> (a P25 request to the gateway; null without a radio) | null in demo,
 *   onGateway(fn) -> off: fn(j) for each gateway answer whose app is 'hdir',
 *   say(result) -- show a Result in the tab's status line (every op result goes there automatically too),
 *   setGwCall(call | null) -- the gateway's callsign for our radio (an hdir reply's `you`): settings.gwCall (saved when
 *     it changes; '' when the gateway says none) + KellyHamCalls.bump(). Ignored in the demo.
 *   sendDm(key, text) -> Promise<{ ok, msg?, demo?, answers?, chat?, reason? }> -- one user-tapped DM (the QR swap's
 *     "73 de .."): k.sendDm when mesh.js gives it (msg.state 'delivered' = ACKed), else the chat opened with the text
 *     typed in; the demo pokes its world (a scripted station answers with bus 'mutual' how 'ack').
 * window.kellyHCImport(text) -> bool: the LoRa Mesh 📷 Scan hook -- shows this tab and opens the contact card
 *   preview with that text (js/hc-share.js importText); nothing is added until the user presses Add.
 *
 * window.KellyHamContactsUI(k) -> { init, shown(), hidden(), feed(kind, ...), gatewayReply(j), on(ev, fn) -> off };
 *   k from mesh.js: { $, esc, store, toast, settings, save() (or saveSoon(what)), fmtAgo, myPos(), distKm, nodes(), myNum(),
 *     me(), session(), online(), isMeshCore(), isSimLink(), openTrace(key, method), openChat(num), kfRequest(obj, label), showTab(),
 *     sendDm(num, text)? -> msg | null (optional, like Trace Route's: the QR swap's confirming DM) }
 *   on(ev, fn) = the bus (hc-core.js header) for mesh.js -> Mesh Quest; awards events (review/07-build-contract.md):
 *     'card' { how: 'copy'|'download'|'qr'|'scan', key? (scan: theirs), at }   'advert' { mode: 'local'|'flood'|'share', key?, at }
 *     'op' { op, key, phase, result?, from?: 'dir' }   'dir' { mineListed, firstOf: { CALL: unix s }, demo? }
 *     'mutual' { key, name, type: 1, how: 'ack'|'message', at, demo: true } -- ONLY from the demo world (a scripted
 *       station answering a ping / message / add; one of them is "yours": its name carries your callsign, so it never scores)
 */
(function () {
  'use strict';

  window.KellyHamContactsUI = function (k) {
    const HC = window.KellyHC;
    if (!HC || !window.KellyHamContactsService) return null;
    const bus = HC.createBus();
    const nacl = window.nacl && window.nacl.sign ? window.nacl : null, ed = nacl ? HC.naclEd(nacl) : null;
    let root = null, vis = false, demoOn = false, world = null, demoSvc = null, parts = {}, lastSay = null;
    const gw = new Set();
    if (window.KellyAwards) window.KellyAwards.addDemo(() => demoOn);   // awards play on the throwaway profile while the demo runs
    const myCall = () => String((k.settings && k.settings.myCall) || '').toUpperCase();

    const liveB = window.KellyHamLiveBackend(k);
    const live = window.KellyHamContactsService({ backend: liveB, bus, store: k.store, ed, myCall, myPos: k.myPos, distKm: k.distKm, active: () => !demoOn });
    const svc = () => (demoOn && demoSvc ? demoSvc : live);
    // c.svc: always the service in use (the parts hold this object, never a backend)
    const facade = {};
    ['state', 'contacts', 'heard', 'get', 'refresh', 'add', 'remove', 'resetPath', 'setFav', 'share', 'shareWait', 'allowDiscover', 'setTelemetryBase', 'advert', 'advertWait', 'setAutoAdd', 'myCard', 'signEntry', 'room', 'forgetHeard', 'cleanup', 'cleanupSettings', 'demo']
      .forEach(fn => { facade[fn] = (...a) => svc()[fn](...a); });

    const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const c = {
      bus, HC, svc: facade, $: k.$, esc: k.esc, store: k.store, toast: k.toast, fmtAgo: k.fmtAgo, ed, myCall, reduced,
      root: () => root, visible: () => vis, demo: () => demoOn, setDemo: on => setDemo(!!on), demoWorld: () => (demoOn ? world : null),
      openTrace: (key, method) => { if (demoOn) return method === 'ping' ? demoAnswer(key, 'ack', 'ping') : { ok: false, reason: 'Trace Route needs your real node: turn the demo off (Trace Route has a demo of its own).' }; return k.openTrace ? k.openTrace(key, method || null) || { ok: true } : { ok: false, reason: 'Trace Route is not loaded' }; },
      openChat: key => {
        if (demoOn) return demoAnswer(key, 'message', 'message');
        const r = svc().get(key);
        if (!r || r.num == null || !k.openChat) return { ok: false, reason: 'Kelly has no chat for that station yet.' };
        k.openChat(r.num); return { ok: true };
      },
      kfRequest: (obj, label) => (demoOn || !k.kfRequest ? null : k.kfRequest(obj, label)),
      onGateway: fn => { gw.add(fn); return () => gw.delete(fn); },
      say: r => say(r),
      setGwCall: call => setGwCall(call),
      sendDm: (key, text) => sendDm(key, text),
      opsTable: true,
      live: () => { const m = new Map(); if (!demoOn && k.nodes) for (const n of k.nodes()) if (n && n.key) m.set(String(n.key).toLowerCase(), n); return m; },
      chans: () => (k.chans ? k.chans() : []),
      openChannel: (index, text) => (demoOn ? null : k.openChannel ? k.openChannel(index, text) : null),
      p25Of: n => (demoOn || !k.p25Of ? null : k.p25Of(n)),
      openP25: id => (k.openP25 ? k.openP25(id) : null),
    };
    // a user-tapped DM to one contact (the QR swap's "73 de .."): -> Promise<{ ok, msg? (mesh.js's message: watch
    // msg.state for 'delivered' = their node ACKed), demo?, answers?, chat? (opened the chat with the text typed in), reason? }>
    async function sendDm(key, text) {
      const r = svc().get(key);
      if (demoOn) { let a = null; try { a = world && world.poke(key, 'ack'); } catch { a = null; } return { ok: true, demo: true, answers: !!a, yours: !!(a && a.yours) }; }
      if (!r || r.num == null) return { ok: false, reason: 'Kelly has no chat for that station yet -- it needs to be heard first.' };
      if (typeof k.sendDm === 'function') { const msg = await k.sendDm(r.num, text); return msg ? { ok: true, msg } : { ok: false, reason: 'The message did not go out (see the chat).' }; }
      if (!k.openChat) return { ok: false, reason: 'The chat is not loaded.' };
      k.openChat(r.num);
      const t = document.getElementById('mesh-text'); if (t) { t.value = text; try { t.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* */ } t.focus(); }
      return { ok: true, chat: true };
    }
    function setGwCall(call) {
      if (demoOn || !k.settings) return;
      const v = call == null || call === '' ? '' : HC.normCall(call);
      if (v == null) return;   // not a callsign: leave it
      if ((k.settings.gwCall || '') !== v) {
        k.settings.gwCall = v;
        try { if (k.save) k.save(); else if (k.saveSoon) k.saveSoon('settings'); } catch (e) { console.warn('Ham Contacts gwCall', e); }
      }
      try { if (window.KellyHamCalls && window.KellyHamCalls.bump) window.KellyHamCalls.bump(); } catch { /* */ }
    }
    // the demo world's scripted answers: nothing is sent; a station that "has you" answers and the bus says 'mutual'
    function demoAnswer(key, how, what) {
      const r = svc().get(key), name = r ? r.label || r.name : 'That station';
      let a = null; try { a = world && world.poke(key, how); } catch { a = null; }
      const verb = what === 'ping' ? 'No ping is sent' : 'No message is sent (messages need your real node)';
      return { ok: false, reason: a ? `Demo: ${verb}. ${name} "answers" in a few seconds -- a pretend Handshake${a.yours ? ' with your own station, which never scores' : ''}.`
        : `Demo: ${verb}, and ${name} hasn't added you, so no answer comes.` };
    }

    // ------------------------------------------------------------ layout
    function render() {
      const e = k.esc;
      root.innerHTML = `<div class="hc">
        <div class="card hc-top">
          <div class="hc-title"><h3>📇 Ham Contacts</h3><span class="tag hc-mode" id="hc-modebadge">no node</span>
            <span class="hc-cap" id="hc-cap" title="Contacts on your node / the most it holds"><span class="hc-cap-bar"><i id="hc-cap-fill"></i></span><b id="hc-cap-text">–</b></span>
            <span class="grow"></span>
            <button class="btn ghost small" id="hc-refresh" title="Read every contact and the auto-add setting from your node again">⟳ Refresh</button>
            <button class="btn small" id="hc-demo-btn">🎲 Demo</button></div>
          <p class="hc-readout" id="hc-readout" aria-live="polite"></p>
          <details class="hc-why"><summary>Why add other hams as contacts?</summary>
            <p>MeshCore only lets two stations message, ping, trace or discover a path to each other once <b>each has the other in its contacts</b>.
            Private packets carry just a tiny hash of who sent them and are encrypted with a key both radios work out from each other's public keys --
            a node that doesn't have you as a contact can't tell who you are, so it ignores you. Swap contacts first, then everything else works.</p>
            <p>Fastest ways: send a <b>flood advert</b> while the other ham has auto-add on; share your <b>contact card</b> (the standard MeshCore link or QR -- the MeshCore phone app reads it too); or use the
            <b>P25X ham directory</b>. Add them, and ask them to add you.</p></details>
        </div>
        <div id="hc-ops"></div>
        <div class="hc-grid">
          <section class="hc-col hc-col-main"><div id="hc-contacts"></div></section>
          <aside class="hc-col hc-col-side"><div id="hc-announce"></div><div id="hc-heard"></div><div id="hc-share"></div></aside>
        </div>
        <div class="hc-grid hc-grid-low"><section class="hc-col"><div id="hc-dir"></div></section><section class="hc-col"><div id="hc-calls"></div></section></div>
      </div>`;
      root.querySelector('#hc-demo-btn').onclick = () => setDemo(!demoOn);
      root.querySelector('#hc-refresh').onclick = () => svc().refresh();
      for (const [id, fn] of [['hc-ops', 'KellyHCOperators'], ['hc-contacts', 'KellyHCContacts'], ['hc-announce', 'KellyHCAnnounce'], ['hc-heard', 'KellyHCHeard'], ['hc-share', 'KellyHCShare'], ['hc-dir', 'KellyHCDir'], ['hc-calls', 'KellyHCCalls']]) {
        const m = root.querySelector(`#${id}`);
        if (typeof window[fn] !== 'function') { m.innerHTML = ''; continue; }
        try { parts[fn] = window[fn](m, c) || {}; } catch (err) { console.warn('Ham Contacts', fn, err); m.innerHTML = `<div class="card hc-broken">⚠️ This part did not load (${e(err.message)}).</div>`; }
      }
      void e;
    }
    function say(r) {
      const el = root && root.querySelector('#hc-readout'); if (!el || !r) return;
      lastSay = { r, at: Date.now() };
      el.textContent = r.ok ? `✅ ${r.msg}` : `⚠️ ${r.error}`;
      el.className = `hc-readout ${r.ok ? 'ok' : 'bad'}`;
    }
    function top() {
      if (!root) return;
      const s = svc().state(), m = root.querySelector('#hc-modebadge');
      m.textContent = s.link.via === 'demo' ? 'demo' : s.link.via === 'sim-link' ? 'MeshCore Demo link' : s.link.online ? 'live' : 'no node';
      m.className = `tag hc-mode ${s.link.via === 'demo' || s.link.via === 'sim-link' ? 'demo' : s.link.online ? 'live' : ''}`;
      const b = root.querySelector('#hc-demo-btn'); b.textContent = demoOn ? '⏹ Stop demo' : '🎲 Demo'; b.classList.toggle('primary', demoOn);
      root.querySelector('#hc-refresh').disabled = !s.link.online || s.busy.includes('refresh');
      const max = s.maxContacts, n = s.count, f = root.querySelector('#hc-cap-fill'), t = root.querySelector('#hc-cap-text');
      t.textContent = s.link.online ? (max ? `${n} / ${max}` : `${n}`) : '–';
      const frac = max ? Math.min(1, n / max) : 0;
      f.style.width = `${Math.round(frac * 100)}%`;
      root.querySelector('#hc-cap').className = `hc-cap${frac >= 1 ? ' full' : frac >= HC.WARN_FRACTION ? ' warn' : ''}`;
      const el = root.querySelector('#hc-readout');
      if (!lastSay || Date.now() - lastSay.at > 15000) {
        el.className = 'hc-readout';
        el.textContent = !s.link.online ? s.link.why : s.busy.length ? `Working: ${s.busy.join(', ')}…` : `${n} contact${n === 1 ? '' : 's'} on your node${s.me ? ` (${s.me.call || s.me.name})` : ''}.`;
      }
    }
    bus.on('state', top);
    bus.on('op', e => { if (e && e.phase === 'done' && e.result) say(e.result); });
    // demo: a station we just added says hello back (when it "has us" too)
    bus.on('op', e => { if (demoOn && world && e && e.op === 'add' && e.phase === 'done' && e.result && e.result.ok && !(e.result.value && e.result.value.already)) { try { world.poke(e.key, 'message'); } catch { /* */ } } });

    // ------------------------------------------------------------ demo
    function setDemo(on) {
      if (on === demoOn) return;
      if (on) {
        if (!window.KellyHamDemo) return say(HC.fail('error', 'The demo did not load.'));
        world = window.KellyHamDemo({ nacl, myCall: myCall(), emit: (ev, p) => { if (demoOn) bus.emit(ev, p); } });
        demoSvc = window.KellyHamContactsService({ backend: world.backend, bus, store: k.store, ed, myCall: () => 'VK4ZZA', distKm: k.distKm,
          myPos: () => ({ lat: world.me.lat, lon: world.me.lon }), demo: true, active: () => demoOn });
        demoOn = true; world.start(demoSvc);
      } else { demoOn = false; if (world) world.stop(); world = null; demoSvc = null; }
      lastSay = null; bus.emit('demo', demoOn); svc()._emitAll(); top();
    }

    // ------------------------------------------------------------ visibility
    function checkVis() {
      const v = !!(root && root.offsetParent !== null && !document.hidden);
      if (v !== vis) { vis = v; bus.emit('visible', v); if (v) { svc()._emitAll(); top(); } }
    }

    return window.kellyHamContacts = {   // for the console / test drivers, like window.kellyTraceRoute
      init() {
        root = document.getElementById('hc-root'); if (!root) return;
        const HCalls = window.KellyHamCalls;
        if (HCalls && HCalls.init) { try { HCalls.init({ store: k.store, bus }); if (HCalls.onChange) HCalls.onChange(() => { bus.emit('calls'); svc()._emitAll(); }); } catch (e) { console.warn('Ham Contacts calls', e); } }
        render(); top();
        document.addEventListener('visibilitychange', checkVis);
        setInterval(() => { checkVis(); if (!demoOn) live._status(); if (vis) top(); }, 1000);
        if (/[?&#]hc-demo\b/.test(location.href)) setTimeout(() => setDemo(true), 400);   // index.html#hc-demo: tests, club displays
        // the LoRa Mesh 📷 Scan button (mesh.js): a contact card it read -> this tab's import preview (nothing is added
        // until the user presses Add). -> true when the preview took it
        window.kellyHCImport = text => {
          try { if (k.showTab) k.showTab(); } catch (e) { console.warn('Ham Contacts import', e); }
          const p = parts.KellyHCShare; if (!p || typeof p.importText !== 'function') return false;
          try { p.importText(text); setTimeout(checkVis, 30); return true; } catch (e) { console.warn('Ham Contacts import', e); return false; }
        };
      },
      shown() { setTimeout(checkVis, 30); },
      hidden() { setTimeout(checkVis, 30); },
      // mesh.js io: ('node', n, isNewAdvert, meta) / ('gone', num, key) / ('status', s) -- MeshCore only
      feed(kind, a, b, c) {
        if (kind === 'node') live._node(a, b, c);
        else if (kind === 'gone') live._gone(b || (a && a.key));
        else if (kind === 'status') live._status(a);
      },
      gatewayReply(j) { for (const fn of gw) { try { fn(j); } catch (e) { console.warn('Ham Contacts gateway', e); } } },
      on: (ev, fn) => bus.on(ev, fn),   // mesh.js forwards 'card' / 'advert' / 'op' / 'dir' / 'mutual' to Mesh Quest
      _c: c,   // tests
    };
  };
})();
