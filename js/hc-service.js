/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts: the radio contacts service (2026-10-24, unreleased).
 * The API and its Result / ContactRecord shapes are specified in js/hc-core.js's header; this file is the one
 * implementation, over a small BACKEND so the live node and the demo (js/hc-demo.js) behave the same:
 *
 *   backend = { via() 'live'|'sim-link'|'demo', online() bool, why() string, me() { key, name } | null,
 *     maxContacts() n | null, autoAdd() -> { all, bits, maxHops }, setAutoAdd({ all?, bits?, maxHops? }),
 *     hasContact(key) -> bool, importAdvert(link), addKey({ key, type, name, direct? }), addHeard(key), remove(key),
 *     resetPath(key), setFav(key, on), setFlag(key, bit, on), telemetryModes() -> { base, loc, env } | null,
 *     setTelemetryBase(mode), advert(flood bool), share(key) (CMD_SHARE_CONTACT), alive() -> resolves if the node answers,
 *     relink(why)? (drop the link and reconnect: a radio that restarted under an open port), exportSelf() -> 'meshcore://..', sign(bytes) -> 64 bytes,
 *     nodeByKey(key) -> mesh.js-shaped node | null (snr / rssi / lastHeard / num), nodes() -> iterable of such nodes }
 *   Each async backend call may reject with an Error whose message is the driver's (meshcore.js) words.
 *   The backend tells the core what the node says through svc._node(n, isNewAdvert, meta), svc._gone(key), svc._status().
 *
 * Beyond hc-core.js's API: svc.add(input, { direct: true }) (an in-person QR swap: a zero-hop route for a contact/add);
 * a NEW_ADVERT from a key, or a known contact's own advert (PUSH_ADVERT -> meta.advert), calls KellyHamCalls.advertSeen(key)
 * (its QR-claimed name is confirmed or replaced). svc.cleanup() / svc.cleanupSettings({ on?, days? }): stale contact cleanup,
 * the bridge's --mesh-prune-days done by Kelly (state().cleanup; backend clock() -> the node's unix s).
 * window.KellyHamContactsService(opts) -> svc;  opts: { backend, bus, store, ed, myCall() (settings callsign),
 *   myPos(), distKm(a, b), demo bool (its own limiter counters + looser limits), active() (emit only while true) }
 * window.KellyHamLiveBackend(k) -> backend over mesh.js's MeshCore session (k from js/hc-ui.js).
 */
(function () {
  'use strict';
  const HC = window.KellyHC;

  window.KellyHamContactsService = function (opts) {
    const B = opts.backend, bus = opts.bus, store = opts.store, demo = !!opts.demo;
    const active = opts.active || (() => true);
    const emit = (ev, p) => { if (active()) bus.emit(ev, p); };
    const onRadio = new Map();   // key -> base { key, name, type, fav, outPath, hops, lastAdvert, lat, lon, num }
    const heard = new Map();     // key -> base + { src, at }
    const dismissed = new Map(); // key -> when the user dismissed a 'seen' station: hidden until Kelly hears it again
    const HEARD_KEY = demo ? 'hcHeardDemo' : 'hcHeard', LIM_KEY = demo ? 'hcAdvLimDemo' : 'hcAdvLim';
    if (!demo) for (const h of (store.get(HEARD_KEY, []) || [])) if (h && HC.okKey(h.key)) heard.set(h.key, h);
    let autoAdd = null, linkSig = '', lastOnline = false;
    const busy = new Map();      // key (or op name) -> op name
    const inflight = new Set();  // { settle } -- a disconnect settles each with 'offline'

    // ------------------------------------------------------------ records
    const calls = () => window.KellyHamCalls;
    function base(n, extra) {
      const key = String(n.key || '').toLowerCase();
      return Object.assign({ key, name: n.longName || n.name || '', type: n.role ?? n.type ?? 0, fav: !!n.fav, letsDiscover: !!((n.flags || 0) & 2), outPath: n.outPath || null,
        hops: n.hops ?? null, lastAdvert: n.advertTs ? n.advertTs * 1000 : n.lastAdvert || null, lat: n.lat ?? null, lon: n.lon ?? null, num: n.num ?? null }, extra || {});
    }
    // ix: key -> mesh.js node, built once per list (B.nodeByKey scans every node)
    const index = () => { const m = new Map(); for (const n of B.nodes()) if (n && n.key) m.set(String(n.key).toLowerCase(), n); return m; };
    function toRecord(b, isOn, ix) {
      const live = (ix ? ix.get(b.key) : B.nodeByKey(b.key)) || {}, cs = calls() && calls().callOf ? safe(() => calls().callOf(b.key, b.name)) : null;
      const call = cs ? cs.call : HC.callFromName(b.name), me = opts.myPos && opts.myPos();
      const lat = b.lat ?? live.lat ?? null, lon = b.lon ?? live.lon ?? null;
      const km = me && lat != null && lon != null && !(lat === 0 && lon === 0) && opts.distKm ? opts.distKm(me, { lat, lon }) : null;
      return HC.record({ ...b, call, callSrc: cs ? cs.src : call ? 'name' : null, onRadio: isOn, pending: !isOn, lat, lon, km,
        lastHeard: live.lastHeard || b.at || null, snr: live.snr ?? live.directSnr ?? null, rssi: live.rssi ?? null, num: b.num ?? live.num ?? null });
    }
    const safe = fn => { try { return fn(); } catch { return null; } };
    const myKey = () => { const m = safe(() => B.me()); return m && m.key ? String(m.key).toLowerCase() : null; };
    function seen() {   // stations Kelly knows from earlier (mesh.js nodes with a key) that aren't on the radio
      if (!B.online() || !onRadio.size) return [];
      const out = [], me = myKey();
      for (const n of B.nodes()) {
        const key = n && n.key ? String(n.key).toLowerCase() : '';
        if (!HC.okKey(key) || key === me || onRadio.has(key) || heard.has(key) || ![1, 2, 3, 4].includes(n.role)) continue;
        if (dismissed.has(key) && !((n.lastHeard || 0) > dismissed.get(key))) continue;
        out.push(base(n, { src: 'seen' }));
      }
      return out;
    }
    const contacts = () => { const ix = index(); return [...onRadio.values()].map(b => toRecord(b, true, ix)); };
    const heardList = () => { const ix = index(); return [...heard.values(), ...seen()].filter(b => !onRadio.has(b.key)).map(b => toRecord(b, false, ix)); };
    const capHeard = () => { if (heard.size <= 300) return; const old = [...heard.values()].sort((a, b) => (a.at || 0) - (b.at || 0)); for (const h of old.slice(0, heard.size - 300)) heard.delete(h.key); };
    const saveHeard = () => { if (!demo) store.set(HEARD_KEY, [...heard.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 100)); };
    const changed = (lists = 'both') => { if (lists !== 'heard') emit('contacts', contacts()); if (lists !== 'contacts') emit('heard', heardList()); };

    // ------------------------------------------------------------ results, timeouts, disconnects
    function words(e, op) {
      const m = String(e && e.message || e || '');
      // firmware ERR 3 also means "couldn't send / buffer full" for share, export and sign
      if (/table full/.test(m) && /^(share|myCard|sign|advert)$/.test(op || '')) return HC.fail('busy', 'The node could not do that just now (it is busy or out of room) -- try again in a moment.');
      if (/table full/.test(m)) return HC.fail('full', 'The node says its contact table is full -- remove a contact first.');
      if (/did not answer|timed out/.test(m)) return HC.fail('timeout', 'The node did not answer in time. Check the USB / bridge link and try again.');
      if (/not connected|link lost|offline/.test(m)) return HC.fail('offline', 'The node is not connected.');
      if (/not found/.test(m)) return HC.fail('refused', 'The node does not have that contact (it may have been removed already).');
      if (/busy/.test(m)) return HC.fail('busy', 'The node is busy -- try again in a moment.');
      if (/not supported/.test(m)) return HC.fail('refused', 'This node\'s firmware does not support that.');
      return HC.fail('error', m ? m.charAt(0).toUpperCase() + m.slice(1).replace(/\.?$/, '.') : 'Something went wrong.');
    }
    // run one radio operation: one at a time per key, a timeout, settled 'offline' if the link drops
    // o: { ms (outer timeout), survives (a link drop doesn't end it: a remove that restarts the radio waits it out),
    //      tag (extra fields on both 'op' events, e.g. { from: 'dir' } for a directory add -- Mesh Quest reads it) }
    function run(op, key, fn, okMsg, o = {}) {
      if (!B.online()) return Promise.resolve(HC.fail('offline', B.why() || 'Connect a MeshCore companion node first (LoRa Mesh > Mesh tab).'));
      const lock = key || op;
      if (busy.has(lock)) return Promise.resolve(HC.fail('busy', 'Kelly is already doing that -- wait for it to finish.'));
      busy.set(lock, op); emit('op', { op, key, phase: 'start', ...(o.tag || {}) }); emit('state', state());
      return new Promise(resolve => {
        let done = false;
        const t = {};
        const settle = r => {
          if (done) return; done = true; clearTimeout(t.timer); inflight.delete(t); busy.delete(lock);
          emit('op', { op, key, phase: 'done', result: r, ...(o.tag || {}) }); emit('state', state()); resolve(r);
        };
        t.settle = settle; t.survives = !!o.survives; inflight.add(t);
        const ms = o.ms || HC.TIMEOUT_MS;
        t.timer = setTimeout(() => settle(HC.fail('timeout', `No answer from the node after ${Math.round(ms / 1000)} seconds -- check the USB / bridge link.`)), ms);
        Promise.resolve().then(fn).then(v => settle(v && v.ok === false ? v : HC.ok(v, typeof okMsg === 'function' ? okMsg(v) : okMsg)), e => settle(words(e, op)));
      });
    }

    // ------------------------------------------------------------ the node's own events (from the backend)
    function _node(n, isNewAdvert, meta) {
      const key = n && n.key ? String(n.key).toLowerCase() : '';
      if (!HC.okKey(key) || key === myKey()) return;
      // the node passed on that key's own advert (signed by it): a name an unsigned QR gave is no longer just a claim
      // -- a NEW_ADVERT (a key the node didn't hold) or, for one it does hold (added from a QR), PUSH_ADVERT (meta.advert)
      if ((isNewAdvert || (meta && meta.advert)) && calls() && calls().advertSeen) safe(() => calls().advertSeen(key));
      if (!isNewAdvert) { onRadio.set(key, base(n)); if (heard.delete(key)) saveHeard(); changed(); return; }
      // a NEW_ADVERT: saved (auto-add) or only passed on (manual) -- ask the node which
      dismissed.delete(key);
      if (onRadio.has(key)) { onRadio.set(key, base(n)); changed('contacts'); return; }
      Promise.resolve(B.hasContact(key)).then(has => {
        if (has) { onRadio.set(key, base(n)); heard.delete(key); }
        else { heard.set(key, base(n, { src: 'advert', at: Date.now() })); capHeard(); }
        saveHeard(); changed();
      }, () => {});
    }
    function _gone(key) { key = String(key || '').toLowerCase(); if (onRadio.delete(key)) changed(); }
    // s = mesh.js io.status ('config' while connecting: the node is about to send every contact again), or nothing (a poll)
    async function _status(s) {
      if (s && s !== 'on') onRadio.clear();
      const on = B.online(), sig = `${on}|${B.via()}`;
      if (sig === linkSig) return;
      linkSig = sig;
      // offline (or connecting): what the node holds is unknown -- the contacts it sends while connecting fill it again
      if (!on) { for (const t of [...inflight]) if (!t.survives) t.settle(HC.fail('offline', 'The node disconnected before it answered.')); onRadio.clear(); autoAdd = null; }
      if (on && !lastOnline) readAutoAdd();
      lastOnline = on;
      emit('state', state()); changed();
    }
    async function readAutoAdd() { try { autoAdd = HC.autoAddOf(await B.autoAdd()); } catch { autoAdd = null; } emit('state', state()); }

    // ------------------------------------------------------------ the API
    function state() {
      const on = B.online(), m = safe(() => B.me());
      const call = m ? ((calls() && safe(() => (calls().callOf(m.key, m.name) || {}).call)) || HC.callFromName(m.name) || HC.normCall(opts.myCall && opts.myCall())) : null;
      return { link: { online: on, via: on ? B.via() : 'none', why: on ? null : B.why() }, maxContacts: on ? B.maxContacts() : null, count: onRadio.size,
        autoAdd: on ? autoAdd : null, me: m && m.key ? { key: String(m.key).toLowerCase(), name: m.name || '', call: call || null } : null, busy: [...busy.values()], busyKeys: Object.fromEntries(busy),
        telemetryBase: on ? ((safe(() => B.telemetryModes()) || {}).base ?? null) : null, cleanup: { ...cleanCfg } };
    }
    function room(n = 1) {
      const max = B.maxContacts(), have = onRadio.size;
      if (!max) return { ok: true, free: null, fit: n, warn: null };
      const free = max - have, after = have + n;
      if (n > free) return { ok: false, free, fit: Math.max(0, free), warn: `Your node holds at most ${max} contacts and has ${have} -- room for ${Math.max(0, free)} more. Remove some first.` };
      return { ok: true, free, fit: n, warn: after >= max * HC.WARN_FRACTION ? `That brings your node to ${after} of its ${max} contacts.${autoAdd && autoAdd.overwrite ? ' When it is full, auto-add overwrites the oldest non-favourite.' : ''}` : null };
    }
    // anything add() takes -> { card } | { heardKey } | { error Result }
    function interpret(input) {
      if (input && typeof input === 'object' && input.kind) return { card: input };
      if (input && typeof input === 'object') {
        const key = String(input.key || '').toLowerCase(), type = Number(input.type || 1), name = String(input.name || '').trim();
        if (heard.has(key) || seen().some(s => s.key === key)) return { heardKey: key };
        if (!HC.okKey(key)) return { error: HC.fail('invalid', 'That contact has no proper public key (64 hex digits).') };
        if (![1, 2, 3, 4].includes(type)) return { error: HC.fail('invalid', 'That contact has an unknown node type.') };
        if (HC.utf8(name).length > 31 || /[\x00-\x1f\x7f]/.test(name)) return { error: HC.fail('invalid', 'That contact\'s name is too long or holds control characters.') };
        return { card: { kind: 'contact', key, type, name, verified: false, call: HC.normCall(input.call) || HC.callFromName(name), callFrom: null } };
      }
      const t = String(input == null ? '' : input).trim();
      if (HC.okKey(t.toLowerCase()) && (heard.has(t.toLowerCase()) || seen().some(s => s.key === t.toLowerCase()))) return { heardKey: t.toLowerCase() };
      try { return { card: HC.parseCard(t, { ed: opts.ed }) }; } catch (e) { return { error: HC.fail('invalid', e.message) }; }
    }
    // o.direct: an in-person QR swap (they are in range) -- a contact/add is written with a zero-hop route, so the
    // first DM isn't flooded (an imported signed advert keeps the node's own route)
    function add(input, o) {
      const direct = !!(o && o.direct);
      const x = interpret(input);
      if (x.error) return Promise.resolve(x.error);
      const key = x.card ? x.card.key : x.heardKey;
      if (key === myKey()) return Promise.resolve(HC.fail('invalid', 'That card is your own node.'));
      const rec = onRadio.get(key);
      if (rec) return Promise.resolve(HC.ok({ key, already: true }, `${HC.label(rec.name, HC.callFromName(rec.name))} is already on your radio.`));
      const r = room(1); if (!r.ok) return Promise.resolve(HC.fail('full', r.warn));
      const h = heard.get(key) || seen().find(s => s.key === key);
      const name = x.card ? x.card.name : h ? h.name : '';
      return run('add', key, async () => {
        if (x.card && x.card.kind === 'advert') {
          // some firmwares keep an imported card only as a heard advert (PUSH_NEW_ADVERT, not saved): write it, check it
          let landed = false;
          try { await B.importAdvert(x.card.link); } catch (e) { if (!/did not add|did not save/.test(e.message)) throw e; landed = true; }
          if (!landed) landed = !(await B.hasContact(key));
          if (landed) { try { await B.addHeard(key); landed = !(await B.hasContact(key)); } catch { /* still only heard */ } }
          if (landed) {
            heard.set(key, base({ key, name, role: x.card.type, lat: x.card.lat, lon: x.card.lon }, { src: 'card', at: Date.now() })); saveHeard(); changed('heard');
            return HC.fail('refused', `Your node took ${HC.label(name, x.card.call)}'s card but kept it only as a heard advert, not a contact. It is under "Heard": press Add there.`);
          }
        }
        else if (x.card) { const v = await B.addKey(direct ? { key, type: x.card.type, name, direct: true } : { key, type: x.card.type, name }); if (v && v.already) return { key, already: true }; }
        else {
          try { await B.addHeard(key); }
          catch (e) { if (!/no.*advert|has not passed on/.test(e.message) || !h) throw e; await B.addKey({ key, type: h.type || 1, name: h.name }); }
        }
        const b = h ? { ...h } : base({ key, name, role: x.card.type, lat: x.card.lat, lon: x.card.lon });
        delete b.src; delete b.at;
        if (!onRadio.has(key)) onRadio.set(key, b);
        if (heard.delete(key)) saveHeard();
        changed();
        return { key, card: x.card || null, warn: r.warn };
      }, v => v.already ? 'Already on your radio.' : `${HC.label(name, x.card ? x.card.call : HC.callFromName(name))} added to your radio.${r.warn ? ` ${r.warn}` : ''}`,
      input && typeof input === 'object' && input.from === 'dir' ? { tag: { from: 'dir' } } : undefined);
    }
    const nameOf = key => { const b = onRadio.get(key) || heard.get(key); return b ? HC.label(b.name, HC.callFromName(b.name)) : String(key || '').slice(0, 8); };
    function onKey(op, key, fn, msg, o) {
      key = String(key || '').toLowerCase();
      if (!onRadio.has(key)) return Promise.resolve(HC.fail('refused', 'That station is not on your radio.'));
      return run(op, key, fn, msg, o);
    }
    // a remove can restart the radio on some firmwares (it rewrites its contact file): the command, or the heartbeat
    // after it, goes unanswered and / or the link drops. Kelly reconnects, then checks the contact is really gone.
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function alive(ms) { try { return await Promise.race([Promise.resolve(B.alive()).then(() => true, () => false), sleep(ms).then(() => false)]); } catch { return false; } }
    async function backOnline(ms, tok) {
      const t0 = Date.now(); let wentDown = !B.online();
      while (Date.now() - t0 < ms) { if (!B.online()) wentDown = true; else if (wentDown || (B.token && B.token() !== tok)) { await sleep(1500); return true; } await sleep(500); }
      return false;
    }
    const remove = key => onKey('remove', key, async () => {
      const k2 = String(key).toLowerCase(), n = nameOf(k2), tok = B.token ? B.token() : null;
      const same = () => !B.token || B.token() === tok;   // still the session the remove went to (not already reconnected)
      let restarted = false;
      try { await B.remove(k2); } catch (e) { if (B.online() && !/did not answer|not connected|link lost|offline/.test(e.message)) throw e; restarted = true; }
      if (!restarted) restarted = !(await alive(12000));   // > two driver command timeouts: a heartbeat may queue behind one
      if (restarted) {
        emit('state', state());
        if (B.online() && same()) {
          if (B.autoReconnect && !B.autoReconnect()) throw new Error('the radio stopped answering after the remove (it may have restarted) and auto-reconnect is off -- press Connect on the Mesh tab, then check the contact');
          if (B.relink) B.relink('the radio restarted after a contact was removed');
        }
        if (!(await backOnline(80000, tok))) throw new Error('the radio restarted after the remove and has not reconnected yet -- check the LoRa Mesh tab, then look for the contact again');
        if (await B.hasContact(k2)) throw new Error('the radio restarted during the remove and still has that contact -- press Remove again');
      }
      _gone(k2); return { key: k2, name: n, restarted };
    }, v => `${v.name} removed from your radio${v.restarted ? ' (the radio restarted itself and Kelly reconnected)' : ''}. It comes back with its next advert if auto-add is on.`, { ms: 120000, survives: true });
    const resetPath = key => onKey('resetPath', key, async () => { const k2 = String(key).toLowerCase(); await B.resetPath(k2); const b = onRadio.get(k2); if (b) { b.outPath = null; b.hops = null; } changed('contacts'); return { key: k2 }; },
      () => 'Route forgotten: the next message to them floods and finds a fresh one.');
    // let that ham run a path discovery to us: their contact's flag 0x02, and our base mode 1 when it was 0 (deny)
    const allowDiscover = (key, on) => onKey('discover', key, async () => {
      const k2 = String(key).toLowerCase(); let raised = false;
      await B.setFlag(k2, 0x02, !!on);
      const t = safe(() => B.telemetryModes());
      if (on && t && t.base === 0) { await B.setTelemetryBase(1); raised = true; }
      const b = onRadio.get(k2); if (b) b.letsDiscover = !!on; changed('contacts'); emit('state', state());
      return { key: k2, on: !!on, raised };
    }, v => v.on ? `${nameOf(v.key)} may now discover a path to you${v.raised ? ' (your node now answers path discovery from the contacts you allow)' : ''}.` : `${nameOf(v.key)} can no longer discover a path to you.`);
    const setTelemetryBase = mode => run('telemetry', 'telemetry', async () => { if (![0, 1, 2].includes(mode)) throw new Error('bad value'); await B.setTelemetryBase(mode); emit('state', state()); return { mode }; },
      v => v.mode === 2 ? 'Anyone may now discover a path to you (and read your battery).' : v.mode === 1 ? 'Only the contacts you allow may discover a path to you.' : 'Nobody may discover a path to you now.');
    const setFav = (key, on) => onKey('fav', key, async () => { const k2 = String(key).toLowerCase(); await B.setFav(k2, !!on); const b = onRadio.get(k2); if (b) b.fav = !!on; changed('contacts'); return { key: k2, fav: !!on }; },
      () => on ? 'Marked as a favourite: the node never overwrites it.' : 'No longer a favourite.');

    // adverts: rate-limited for airtime (HC.LIMITS; counters survive a reload)
    const lim = () => (demo ? HC.LIMITS.demo : HC.LIMITS);
    // the counters: in memory AND in the store (a full store must not switch the limit off), merged on every read
    let limMem = {};
    function limGet() {
      let st = {}; try { st = store.get(LIM_KEY, {}) || {}; } catch { st = {}; }
      const out = {}; for (const m of ['local', 'flood', 'share']) out[m] = [...new Set([...(st[m] || []), ...(limMem[m] || [])])].sort((a, b) => a - b);
      return out;
    }
    function advertWait(mode) {
      const L = lim()[mode], st = limGet(), list = (st[mode] || []).filter(t => Date.now() - t < 86400000), now = Date.now();
      let w = list.length ? list[list.length - 1] + L.gapMs - now : 0;
      if (L.perHour) { const h = list.filter(t => now - t < 3600000); if (h.length >= L.perHour) w = Math.max(w, h[0] + 3600000 - now); }
      if (L.perDay && list.length >= L.perDay) w = Math.max(w, list[list.length - L.perDay] + 86400000 - now);
      return Math.max(0, w);
    }
    const fmtWait = ms => ms >= 3600000 ? `${Math.ceil(ms / 3600000)} h` : ms >= 60000 ? `${Math.ceil(ms / 60000)} min` : `${Math.ceil(ms / 1000)} s`;
    function advert(mode) {
      if (mode !== 'local' && mode !== 'flood') return Promise.resolve(HC.fail('invalid', 'Advert mode is local or flood.'));
      const w = advertWait(mode);
      if (w > 0) return Promise.resolve(HC.fail('rate', `To save airtime, the next ${mode === 'flood' ? 'flood' : 'local'} advert can go in ${fmtWait(w)}.`));
      return run('advert', `advert:${mode}`, async () => {
        spent(mode);   // counted before it goes: a lost OK frame must not let a retry send a second flood
        await B.advert(mode === 'flood');
        emit('advert', { mode, at: Date.now() });
        return { mode };
      }, mode === 'flood' ? 'Advert flooded: every repeater around passes it on, so hams across the network can add you.' : 'Advert sent zero-hop: only stations that hear you directly get it.');
    }
    function spent(mode) { const st = limGet(); st[mode] = [...st[mode].filter(t => Date.now() - t < 86400000), Date.now()].slice(-200); limMem = st; try { store.set(LIM_KEY, st); } catch { /* full: the memory copy still limits */ } }
    // introduce a contact: its advert re-sent zero-hop (CMD_SHARE_CONTACT) so hams near us can add them
    function share(key) {
      key = String(key || '').toLowerCase();
      if (!onRadio.has(key)) return Promise.resolve(HC.fail('refused', 'That station is not on your radio.'));
      if ([...busy.values()].includes('share')) return Promise.resolve(HC.fail('busy', 'One introduction at a time -- wait for the last one to go.'));
      const w = advertWait('share');
      if (w > 0) return Promise.resolve(HC.fail('rate', `To save airtime, the next introduction can go in ${fmtWait(w)}.`));
      return run('share', key, async () => { spent('share'); await B.share(key); emit('advert', { mode: 'share', key, at: Date.now() }); return { key }; },
        () => `${nameOf(key)}'s advert sent zero-hop: hams who hear you directly can add them now.`);
    }
    function setAutoAdd(o = {}) {
      return run('autoAdd', 'autoAdd', async () => {
        const cur = autoAdd || { types: {}, overwrite: false, maxHops: 0, bitsKnown: false };
        const p = {};
        if (o.all != null) p.all = !!o.all;
        if (o.types || o.overwrite != null || o.maxHops != null) {
          if (!cur.bitsKnown && autoAdd) throw new Error('not supported');
          p.bits = HC.bitsOf(Object.assign({}, cur.types, o.types || {}), o.overwrite != null ? o.overwrite : cur.overwrite);
          p.maxHops = o.maxHops != null ? o.maxHops : cur.maxHops || 0;
        }
        await B.setAutoAdd(p);
        autoAdd = HC.autoAddOf(await B.autoAdd());
        return autoAdd;
      }, v => v && v.all ? 'Auto-add is on: your node saves every station it hears advertise.' : 'Auto-add is off: new stations wait under "Heard" until you add them.');
    }
    function myCard() {
      return run('myCard', 'myCard', async () => {
        const link = await B.exportSelf(), c = HC.parseCard(link, { ed: opts.ed });
        const st = state(), call = (st.me && st.me.call) || c.call || null;
        return { advert: c.advert, link: c.link, qr: c.qr, key: c.key, name: c.name, type: c.type, call };
      }, 'Your contact card is ready to share.');
    }
    function signEntry(e) {
      const me = myKey(), n = HC.normEntry({ ...e, s: undefined });
      if (!n) return Promise.resolve(HC.fail('invalid', 'That directory entry is not complete (callsign, name, type, time).'));
      if (n.k !== me) return Promise.resolve(HC.fail('refused', 'Your node only signs its own directory entry.'));
      return run('sign', 'sign', async () => {
        const sig = await B.sign(HC.dirBytes(n)), s = HC.b64u(sig), out = { ...n, s };
        if (opts.ed) { const v = HC.verifyEntry(out, opts.ed); if (!v.ok) throw new Error(`the node's signature did not check out (${v.error})`); }
        return out;
      }, 'Signed by your node.');
    }
    function refresh() {
      return run('refresh', 'refresh', async () => {
        const list = await B.listContacts();
        onRadio.clear(); for (const n of list) if (n && n.key && String(n.key).toLowerCase() !== myKey()) onRadio.set(String(n.key).toLowerCase(), base(n));
        for (const k2 of [...heard.keys()]) if (onRadio.has(k2)) heard.delete(k2);
        saveHeard();
        autoAdd = HC.autoAddOf(await B.autoAdd().catch(() => null));
        changed();
        return { count: onRadio.size };
      }, v => `Read ${v.count} contact${v.count === 1 ? '' : 's'} from your node.`);
    }
    // ---- stale contact cleanup (2026-10-31): the bridge's --mesh-prune-days only runs while no Kelly holds the node,
    // and a member's Kelly holds it all day, so Kelly does the same job itself. Same rules as kelly_bridge.py prune():
    // companions / rooms / sensors not heard for `days`, repeaters for 2x (they're the routes), oldest first, at most
    // CLEAN_MAX a run; never a favourite or a contact with no last-heard time; ages by the NODE's clock against its own
    // lastmod (a node whose clock was never set is skipped). Auto (cfg.on, off by default): daily, and hourly while the
    // table is within 6 % of full. cfg { on, days, last, removed, left, skipped } in store 'hcCleanup'.
    const CLEAN_KEY = 'hcCleanup', CLEAN_MAX = 150, DAY = 86400000;
    let cleanCfg = Object.assign({ on: false, days: 7, last: 0 }, demo ? {} : store.get(CLEAN_KEY, {}) || {});
    const saveClean = () => { if (!demo) store.set(CLEAN_KEY, cleanCfg); };
    function cleanupSettings(o = {}) {
      if (o.on != null) cleanCfg.on = !!o.on;
      if (o.days != null) cleanCfg.days = Math.max(1, Math.min(365, Number(o.days) || 7));
      saveClean(); emit('state', state());
    }
    function cleanup(o = {}) {
      const days = cleanCfg.days;
      return run('cleanup', 'cleanup', async () => {
        cleanCfg.last = Date.now(); saveClean();
        const nodeNow = B.clock ? await B.clock() : Math.floor(Date.now() / 1000);
        if (nodeNow < 1704067200) { cleanCfg.skipped = 'the node\'s clock isn\'t set'; saveClean(); throw new Error('your node\'s clock isn\'t set, so Kelly can\'t tell how old its contacts are -- set it on the Mesh tab, then try again'); }
        const me = myKey(), list = await B.listContacts(), stale = [];
        for (const n of list) {
          const key = String(n && n.key || '').toLowerCase(), lm = Math.floor((n.lastHeard || 0) / 1000);
          if (!HC.okKey(key) || key === me || !lm || n.fav || ((n.flags || 0) & 1)) continue;
          if (nodeNow - lm > days * 86400 * ((n.role ?? n.type) === 2 ? 2 : 1)) stale.push([lm, key, n.longName || n.name || key.slice(0, 12)]);
        }
        stale.sort((a, b) => a[0] - b[0]);
        const names = [];
        for (const [, key, name] of stale.slice(0, CLEAN_MAX)) {
          if (!B.online()) break;
          try { await B.remove(key); } catch (e) { if (/not found/.test(e.message)) { _gone(key); continue; } if (!names.length) throw e; break; }
          _gone(key); names.push(name);
          await new Promise(r => setTimeout(r, 100));
        }
        Object.assign(cleanCfg, { removed: names.length, left: Math.max(0, stale.length - names.length), skipped: null }); saveClean();
        return { removed: names.length, names: names.slice(0, 20), left: cleanCfg.left, count: onRadio.size, days, auto: !!o.auto };
      }, v => v.removed ? `Removed ${v.removed} contact${v.removed === 1 ? '' : 's'} not heard for ${days}+ days (repeaters ${2 * days}+)${v.left ? `, ${v.left} more next run` : ''}.`
        : `Nothing to remove: every contact was heard in the last ${days} days (repeaters ${2 * days}).`, { ms: 300000 });
    }
    function cleanupDue() {
      if (demo || !cleanCfg.on || !B.online() || busy.size) return false;
      const since = Date.now() - (cleanCfg.last || 0), max = B.maxContacts();
      return since >= DAY || (!!max && onRadio.size >= max * 0.94 && since >= DAY / 24);
    }
    if (!demo && typeof setInterval === 'function') setInterval(() => { if (cleanupDue()) cleanup({ auto: true }); }, 5 * 60000);

    const get = key => { key = String(key || '').toLowerCase(); const b = onRadio.get(key); if (b) return toRecord(b, true); const h = heard.get(key) || seen().find(s => s.key === key); return h ? toRecord(h, false) : null; };
    function forgetHeard(key) { key = String(key || '').toLowerCase(); dismissed.set(key, Date.now()); if (heard.delete(key)) saveHeard(); changed('heard'); }

    return { state, contacts, heard: heardList, get, refresh, add, remove, resetPath, setFav, share, shareWait: () => advertWait('share'), allowDiscover, setTelemetryBase, advert, advertWait, setAutoAdd, myCard, signEntry, room, forgetHeard, cleanup, cleanupSettings,
      demo: () => demo, _node, _gone, _status, _emitAll: () => { emit('state', state()); changed(); } };
  };

  // ------------------------------------------------------------ the live backend: mesh.js's MeshCore session
  window.KellyHamLiveBackend = function (k) {
    const s = () => k.session && k.session();
    const nodeByKey = key => { key = String(key || '').toLowerCase(); for (const n of k.nodes()) if (n && n.key && String(n.key).toLowerCase() === key) return n; return null; };
    const need = () => { const x = s(); if (!x || !x.listContacts) throw new Error('not connected'); return x; };
    const nodeArg = key => nodeByKey(key) || { key: String(key).toLowerCase(), num: undefined };
    return {
      via: () => (k.isSimLink && k.isSimLink() ? 'sim-link' : 'live'),
      online: () => !!(k.online() && s() && s().listContacts),
      why: () => !k.isMeshCore() ? 'Ham Contacts is for MeshCore: pick a MeshCore device on the Mesh tab and connect it.' : 'Connect your MeshCore companion node (LoRa Mesh > Mesh tab), or press Demo.',
      me: () => { const m = k.me(); return m && m.key ? { key: m.key, name: m.longName || '' } : null; },
      maxContacts: () => { const x = s(); return x && x.maxContacts ? x.maxContacts() : null; },
      autoAdd: () => need().autoAdd(),
      setAutoAdd: o => need().setAutoAdd(o),
      hasContact: key => need().hasContact(key),
      importAdvert: link => need().importContact(link),
      addKey: c => need().addContact(c),
      addHeard: key => need().addHeard(key),
      remove: key => need().removeContact(nodeArg(key)),
      resetPath: key => need().setPath(nodeArg(key), null),
      setFav: (key, on) => need().setFavourite(nodeArg(key), on),
      setFlag: (key, bit, on) => need().setContactFlag(nodeArg(key), bit, on),
      telemetryModes: () => { const x = s(); return x && x.telemetryModes ? x.telemetryModes() : null; },
      setTelemetryBase: m => need().setTelemetryBase(m),
      advert: flood => need().advert(flood),
      exportSelf: () => need().exportContact(null),
      sign: bytes => need().sign(bytes),
      listContacts: () => need().listContacts(),
      clock: () => need().ownClock(),
      share: key => need().shareContact(nodeArg(key)),
      alive: () => need().heartbeat(),
      relink: why => k.relink && k.relink(why),
      token: () => (k.session ? k.session() : null),
      autoReconnect: () => (k.autoReconnect ? k.autoReconnect() : true),
      nodeByKey, nodes: () => k.nodes(),
    };
  };
})();
