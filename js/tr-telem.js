/* Kelly Page -- LoRa Mesh > 🔭 Trace Route > 📊 Telemetry polling (2026-10-25, unreleased). Two operators who hold each
 * other as contacts each opt in to let the other read their node's base telemetry (battery, MCU temperature), then poll
 * it on a timer with a route check alongside. The grant messages, state machine and schedule are js/tr-grants.js (read
 * its header for who enforces what -- the short version: OUR NODE refuses a poll from anyone whose flag 0x02 we haven't
 * set; Kelly runs the handshake and never polls without a grant). Coded against the context `c` from js/tr-ui.js:
 *   c.telemFor(demo) -> the radio side of one world (the demo sky or the real node): ready, nodes, node, myKey, request,
 *                       send, flag, flagged, setFlag, base, setBase
 *   bus 'tdata' { key, text, demo }   a grant DM from another Kelly (CLI-data txt_type 1)
 *   c.trace(key, { method: 'path' })  the route check (tr-engine), c.claim(id, method, via) the shared airtime budget
 *
 * window.KellyTRTelem(mount, c) -> { destroy(), _w (tests) }
 * Two worlds, kept apart: 'live' (stored in store('trTelem')) and 'demo' (memory only, gone on reload). Only one poll
 * runs at a time (the companion holds one telemetry request at a time), the most overdue first.
 */
(function () {
  'use strict';

  const RETRY_MS = [20e3, 45e3], SEEN_CAP = 60, POLL_TICK = 5e3, TRACE_WAIT = 80e3;

  window.KellyTRTelem = function (mount, c) {
    const G = window.KellyTRGrants;
    if (!G || !mount || !c) return null;
    const esc = c.esc || (s => String(s ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`));
    const safe = (f, d) => { try { return f(); } catch { return d; } };
    const toast = (...a) => safe(() => c.toast && c.toast(...a));
    const fmtAgo = ms => safe(() => c.fmtAgo(ms), `${Math.round((Date.now() - ms) / 1000)} s ago`);

    // ------------------------------------------------------------ the two worlds
    const blankW = () => ({ grants: {}, polls: {}, hist: {}, last: {}, outbox: [], seen: [] });
    const stored = safe(() => c.store.get('trTelem', null), null);
    const W = { live: Object.assign(blankW(), stored && typeof stored === 'object' ? { grants: stored.grants || {}, polls: stored.polls || {}, hist: stored.hist || {}, last: stored.last || {} } : {}), demo: blankW() };
    for (const p of Object.values(W.live.polls)) if (p) p.nextAt = Math.max(p.nextAt || 0, Date.now() + 60e3);   // a reload doesn't fire every poll at once
    const save = () => safe(() => c.store.set('trTelem', { grants: W.live.grants, polls: W.live.polls, hist: W.live.hist, last: W.live.last }));
    const wn = demo => demo ? 'demo' : 'live';
    const T = demo => c.telemFor(demo);
    const shownDemo = () => !!safe(() => c.demo(), false);
    const nameOf = (demo, key) => { const n = safe(() => T(demo).node(key), null), g = W[wn(demo)].grants[key]; return (n && n.name) || (g && g.name) || key.slice(0, 8); };

    // ------------------------------------------------------------ outbox: grant DMs, ACKed by the far Kelly, retried twice
    async function transmit(demo, e) {
      e.tries++; e.at = Date.now();
      try { await T(demo).send(e.key, e.text); }
      catch (err) { e.err = err.message; }
      if (e.op === 'ACK') return;
      e.nextAt = e.tries <= RETRY_MS.length ? Date.now() + RETRY_MS[e.tries - 1] : null;
    }
    function enqueue(demo, key, op, id, extra) {
      const w = W[wn(demo)], text = G.encode(Object.assign({ op, id, from: T(demo).myKey(), to: key }, extra || {}));
      const e = { key, op, id, text, tries: 0, at: 0, nextAt: 0, acked: false };
      if (op !== 'ACK') w.outbox.push(e);
      transmit(demo, e).then(render);
    }
    function pumpOutbox(demo) {
      const w = W[wn(demo)], now = Date.now();
      for (const e of w.outbox.slice()) {
        if (e.acked) { w.outbox.splice(w.outbox.indexOf(e), 1); continue; }
        if (e.nextAt && e.nextAt <= now) transmit(demo, e).then(render);
        else if (e.nextAt === null && now - e.at > 45e3) {   // three tries, no ACK
          w.outbox.splice(w.outbox.indexOf(e), 1);
          const g = w.grants[e.key]; if (g) { g.warn = `no answer to your ${e.op === 'REQ' ? 'request' : 'message'} -- they may not run Kelly right now, or not hold you as a contact`; }
          if (e.op === 'REQ' || !demo) toast('📊', `No answer from ${nameOf(demo, e.key)}`, `Kelly sent it three times. ${e.op === 'REQ' ? 'Your request stays open: it goes through if their Kelly answers later.' : ''}`, 'warn');
          if (!demo) save(); render();
        }
      }
    }

    // ------------------------------------------------------------ the state machine's effects
    async function apply(demo, key, r) {
      const w = W[wn(demo)], t = T(demo);
      w.grants[key] = r.grant;
      for (const f of r.effects) {
        try {
          if (f.do === 'flag') await t.setFlag(key, f.on);
          else if (f.do === 'mode') {
            const b = t.base();
            if (b !== 1) {
              await t.setBase(1);
              toast('🔒', 'Your node now answers granted contacts only', b === 2 ? 'Telemetry was open to every contact -- it is now only for the contacts you grant (this also limits who can run a path discovery to you).'
                : 'Telemetry was off for everyone -- it is now on for the contacts you grant, and nobody else.', 'info');
            }
          } else if (f.do === 'send') enqueue(demo, key, f.op, f.id, f.offer != null ? { offer: f.offer } : null);
          else if (f.do === 'stop') { const p = w.polls[key]; if (p) p.on = false; }
          else if (f.do === 'note') toast(f.icon, f.title, f.text, f.kind);
        } catch (e) {
          r.grant.warn = `${f.do === 'flag' ? (f.on ? 'could not set their permission on your node' : 'could not clear their permission on your node') : 'could not change your node\'s telemetry setting'}: ${e.message}`;
          toast('⚠️', 'Telemetry permission', r.grant.warn, 'error');
        }
      }
      if (!demo) save();
      render();
    }
    function act(demo, key, type, extra) {
      const w = W[wn(demo)], g = w.grants[key] || G.blank(key, nameOf(demo, key));
      g.name = nameOf(demo, key); delete g.warn;
      return apply(demo, key, G.reduce(g, Object.assign({ type, id: G.newId(), now: Date.now() }, extra || {})));
    }

    // a grant DM from another Kelly
    function incoming(ev) {
      const m = G.parse(ev.text); if (!m) return;
      const demo = !!ev.demo, w = W[wn(demo)], key = String(ev.key).toLowerCase();
      if (m.op === 'ACK') { for (const e of w.outbox) if (e.key === key && e.id === m.id) e.acked = true; render(); return; }
      enqueue(demo, key, 'ACK', m.id);   // every message gets its ACK, a repeat too (our first ACK may be the one that was lost)
      const tag = `${key}|${m.op}|${m.id}`;
      if (w.seen.includes(tag)) return;
      w.seen.push(tag); if (w.seen.length > SEEN_CAP) w.seen.shift();
      const bad = G.verify(m, key, T(demo).myKey());
      if (bad) {
        const g = w.grants[key] || G.blank(key, nameOf(demo, key)); g.warn = `a ${m.op} from them was refused: ${bad}`; w.grants[key] = g;
        toast('⚠️', `Telemetry message from ${nameOf(demo, key)} refused`, bad, 'error'); render(); return;
      }
      const g = w.grants[key] || G.blank(key, nameOf(demo, key)); g.name = nameOf(demo, key); delete g.warn;
      apply(demo, key, G.reduce(g, { type: 'got', msg: m, now: Date.now() }));
    }
    const unsub = [c.bus.on('tdata', incoming), c.bus.on('demo', () => render()), c.bus.on('link', () => render()), c.bus.on('visible', v => { if (v) render(); })];

    // ------------------------------------------------------------ polling
    let busy = null;   // { demo, key }
    const pollOf = (w, key) => w.polls[key] || (w.polls[key] = { on: false, every: G.DEFAULT_MIN, nextAt: 0 });
    function waitDone(id) {
      return new Promise(resolve => {
        let off = null;
        const t = setTimeout(() => { if (off) off(); resolve(null); }, TRACE_WAIT);
        off = c.bus.on('done', r => { if (r && r.id === id) { clearTimeout(t); off(); resolve(r); } });
      });
    }
    async function poll(demo, key, manual) {
      const w = W[wn(demo)], t = T(demo), g = w.grants[key], p = pollOf(w, key), now = Date.now();
      if (!g || g.out !== 'granted') return { ok: false, reason: 'no grant from them -- Kelly never polls without one' };
      if (busy) return { ok: false, reason: 'a poll is already running' };
      if (!t.ready()) return { ok: false, reason: demo ? 'demo not available' : 'connect a MeshCore companion node first' };
      const n = t.node(key);
      if (!n) return { ok: false, reason: 'they are not a contact on your node any more' };
      const flood = !(n.outPath && Array.isArray(n.outPath.h));
      const why = c.claim(`tel:${key}`, flood ? 'discover' : 'trace', demo ? 'demo' : 'live');
      if (why) { if (!manual) p.nextAt = now + 120e3; render(); return { ok: false, reason: why }; }
      busy = { demo, key }; p.nextAt = now + p.every * 60e3; render();
      const e = { t: now, ok: false };
      try {
        const r = await t.request(key), s = G.summary(r.lpp);
        Object.assign(e, { ok: true, battV: s.battV, pct: s.pct, tempC: s.tempC, extra: s.extra.length ? s.extra.slice(0, 4) : undefined,
          snr: r.rx ? r.rx.snr : null, rssi: r.rx ? r.rx.rssi : null, flood: r.rx ? r.rx.flood : flood, rtt: r.ms != null ? Math.round(r.ms) : Date.now() - now });
      } catch (err) {
        e.why = err.code === 'timeout' ? 'no answer -- out of reach, or their node no longer allows you (they may have revoked)' : err.message;
      }
      // the route check, on the same budget -- only in the world on screen (the trace engine runs on that world's driver)
      const n2 = t.node(key) || n, path = n2.outPath && Array.isArray(n2.outPath.h) ? n2.outPath.h : null;
      e.route = path ? c.TR.pathKey(path) : null;
      if (demo !== shownDemo()) e.trace = { ok: false, why: demo ? 'demo is off: route not checked' : 'demo is on: route not checked' };
      else if (path && !path.length) e.trace = { ok: true, direct: true };
      else {
        const res = c.trace(key, { method: 'path' });
        if (!res || !res.ok) e.trace = { ok: false, why: (res && res.reason) || 'the route check could not start' };
        else {
          const run = await waitDone(res.id);
          e.trace = !run ? { ok: false, why: 'the route check never finished' }
            : { ok: run.status === 'success', why: run.status === 'success' ? null : run.error || run.status, snrMin: run.snrMin, rtt: run.rttMs, changed: run.changed };
          if (run && run.status === 'success') { e.route = run.pathKey; w.last[key] = { t: Date.now(), out: run.out.map(h => ({ name: h.name, snr: h.snr, known: h.known })), back: run.back.map(h => ({ name: h.name, snr: h.snr, known: h.known })) }; }
        }
      }
      if (e.trace && e.trace.direct) w.last[key] = { t: Date.now(), direct: true };
      w.hist[key] = G.pushHist(w.hist[key], e);
      busy = null;
      if (!demo) save();
      render();
      return { ok: true, entry: e };
    }
    function tick() {
      for (const demo of [false, true]) {
        pumpOutbox(demo);
        if (busy || (demo && !shownDemo())) continue;
        const key = G.due(W[wn(demo)].polls, W[wn(demo)].grants, Date.now());
        if (key) poll(demo, key, false);
      }
      if (vis()) renderSoon();   // the "next poll in" countdown
    }
    const timer = setInterval(tick, POLL_TICK);

    // ------------------------------------------------------------ drawing
    const vis = () => safe(() => c.visible(), true);
    let rq = null;
    const renderSoon = () => { if (!rq) rq = setTimeout(() => { rq = null; render(); }, 300); };
    let reqKey = '', reqOffer = true, openKey = null;
    const fmtIn = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`; };
    const num = (v, d, u) => v == null || !isFinite(v) ? '—' : `${Number(v).toFixed(d)}${u}`;
    const snrCls = v => `tr-tl-snr-${safe(() => c.TR.snrClass(v), 'none')}`;
    const MODE = { 0: ['nobody', 'Your node answers no telemetry requests -- not even from people you grant.', 'bad'], 1: ['granted contacts only', 'Your node answers only the contacts you grant below.', 'ok'],
      2: ['any contact', 'Your node answers telemetry from EVERY contact, granted or not.', 'bad'] };

    // one small line chart: points [{ t, v }] -> svg (gaps where v is null). Single series: the title above names it.
    function spark(pts, color, fmt) {
      const W0 = 160, H0 = 38, P = 4, vals = pts.filter(p => p.v != null && isFinite(p.v));
      if (vals.length < 2) return `<div class="tr-tl-spk-empty dim small">${vals.length ? fmt(vals[0].v) : 'no data yet'}</div>`;
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1, lo = Math.min(...vals.map(p => p.v)), hi = Math.max(...vals.map(p => p.v)), span = hi - lo || 1;
      const x = t => P + (t - t0) / Math.max(1, t1 - t0) * (W0 - 2 * P), y = v => H0 - P - (v - lo) / span * (H0 - 2 * P);
      let d = '', pen = false;
      for (const p of pts) { if (p.v == null || !isFinite(p.v)) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`; pen = true; }
      const dots = vals.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="6" class="tr-tl-hit"><title>${esc(fmt(p.v))} -- ${esc(new Date(p.t).toLocaleString())}</title></circle>`).join('');
      const lp = vals[vals.length - 1];
      return `<svg class="tr-tl-spk" viewBox="0 0 ${W0} ${H0}" preserveAspectRatio="none" role="img" aria-label="${esc(`from ${fmt(lo)} to ${fmt(hi)}, latest ${fmt(lp.v)}`)}">
        <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        <circle cx="${x(lp.t).toFixed(1)}" cy="${y(lp.v).toFixed(1)}" r="3" fill="${color}"/>${dots}</svg>`;
    }
    function hopChips(list) {
      return list.map((h, i) => `${i ? '<span class="tr-tl-arrow" aria-hidden="true">→</span>' : ''}<span class="tr-tl-hop ${h.snr == null ? 'tr-tl-snr-none' : snrCls(h.snr)}${h.known ? '' : ' tr-tl-unk'}">${esc(h.name)}${i ? ` <b>${h.snr == null ? '—' : `${h.snr.toFixed(1)} dB`}</b>` : ''}</span>`).join('');
    }

    function render() {
      if (!mount.isConnected && !mount.parentNode) return;
      const demo = shownDemo(), w = W[wn(demo)], t = T(demo), ready = t.ready(), base = t.base(), now = Date.now();
      const grants = Object.values(w.grants), flagged = new Set(safe(() => t.flagged(), []));
      const pendIn = grants.filter(g => g.in === 'pending'), inOk = grants.filter(g => g.in === 'granted');
      const deviceOnly = [...flagged].filter(k => !(w.grants[k] && w.grants[k].in === 'granted'));
      const canPoll = grants.filter(g => g.out === 'granted'), asking = grants.filter(g => g.out === 'asking' || g.out === 'declined');
      const busyKey = busy && busy.demo === demo ? busy.key : null;
      const md = MODE[base];
      const btn = (act, key, label, cls, title) => `<button type="button" class="btn small${cls ? ` ${cls}` : ''}" data-act="${act}" data-key="${esc(key)}"${title ? ` title="${esc(title)}"` : ''}${ready ? '' : ' disabled'}>${label}</button>`;
      const who = g => `<b>${esc(nameOf(demo, g.key || g))}</b>`;
      const warn = g => g.warn ? `<div class="tr-tl-warn small">⚠️ ${esc(g.warn)}</div>` : '';

      // who can poll me
      let inH = '';
      for (const g of pendIn) inH += `<li class="tr-tl-row tr-tl-pend">${who(g)} <span class="tag">asks to poll you</span>${g.inReq && g.inReq.offer ? ' <span class="tag ok">offers theirs</span>' : ''}<span class="grow"></span>${btn('approve', g.key, '✅ Approve', 'primary', 'Set their permission on your node and tell their Kelly')}${btn('decline', g.key, 'Decline')}${warn(g)}</li>`;
      for (const g of inOk) {
        const off = t.flag(g.key) === false;
        inH += `<li class="tr-tl-row">${who(g)} <span class="tag ok">granted</span>${g.mutual ? ' <span class="tag" title="A message from them decrypted and their keys checked out: each of you holds the other\'s key">🔑 keys confirmed</span>' : ''}<span class="grow"></span>${off ? btn('reflag', g.key, '↻ Re-apply', 'primary', 'Your node no longer has their permission set') : ''}${btn('revokeIn', g.key, '✖ Revoke', '', 'Clears their permission on your node at once, then tells their Kelly')}
          ${off ? '<div class="tr-tl-warn small">⚠️ Your node no longer has their permission set: it will not answer them.</div>' : ''}${warn(g)}</li>`;
      }
      for (const k of deviceOnly) inH += `<li class="tr-tl-row">${who(k)} <span class="tag">set on your node</span><span class="grow"></span>${btn('unflag', k, '✖ Revoke', '', 'Clears their telemetry permission on your node (also stops them discovering a path to you)')}<div class="dim small">Allowed on your node without a Kelly grant (Ham Contacts' 🔍, or another app).</div></li>`;
      if (!inH) inH = '<li class="dim small tr-tl-none">Nobody. Requests from other Kelly operators show here to approve or decline.</li>';

      // who I can poll + the request form
      let outH = '';
      for (const g of canPoll) outH += `<li class="tr-tl-row">${who(g)} <span class="tag ok">you can poll</span>${g.theyOffered ? ' <span class="tag">offered</span>' : ''}<span class="grow"></span>${btn('open', g.key, openKey === g.key ? 'Hide' : 'Open', '')}${btn('dropOut', g.key, 'Stop', '', 'Stop polling them and give the access back')}${warn(g)}</li>`;
      for (const g of asking) outH += `<li class="tr-tl-row">${who(g)} <span class="tag${g.out === 'declined' ? ' bad' : ''}">${g.out === 'declined' ? 'declined' : 'asked -- waiting'}</span><span class="grow"></span>${g.out === 'declined' ? btn('ask', g.key, 'Ask again') : btn('dropOut', g.key, 'Withdraw')}${warn(g)}</li>`;
      if (!outH) outH = '<li class="dim small tr-tl-none">Nobody yet. Ask below.</li>';
      const cands = (safe(() => t.nodes(), []) || []).filter(n => n.key && n.role === 'companion' && !(w.grants[n.key] && (w.grants[n.key].out === 'granted' || w.grants[n.key].out === 'asking')));
      if (reqKey && !cands.some(n => n.key === reqKey)) reqKey = '';
      const form = `<div class="tr-tl-ask">
          <select id="tr-tl-who" aria-label="Station to ask"${ready && cands.length ? '' : ' disabled'}><option value="">${cands.length ? 'Pick a companion contact…' : 'No companion contacts'}</option>${cands.map(n => `<option value="${esc(n.key)}"${n.key === reqKey ? ' selected' : ''}>${esc(n.name)}</option>`).join('')}</select>
          <label class="tr-tl-chk"><input type="checkbox" id="tr-tl-offer"${reqOffer ? ' checked' : ''}> and let them poll mine</label>
          <button type="button" class="btn small primary" data-act="ask" data-key="${esc(reqKey)}"${ready && reqKey ? '' : ' disabled'}>📨 Request access</button>
        </div>
        <p class="dim small">They must hold you as a contact and run Kelly to answer. The request goes as an encrypted direct message between your two keys; both of you check the other's key.</p>`;

      // per-peer panels
      let peers = '';
      for (const g of canPoll) {
        if (openKey !== g.key && canPoll.length > 1) continue;
        const p = pollOf(w, g.key), h = w.hist[g.key] || [], last = h[h.length - 1], ok = h.filter(e => e.ok), lt = w.last[g.key], hl = G.health(h);
        const lastOk = ok[ok.length - 1];
        const status = busyKey === g.key ? '<span class="tr-tl-live">polling now…</span>'
          : last ? (last.ok ? `last poll ${fmtAgo(last.t)}` : `last poll ${fmtAgo(last.t)}: <span class="tr-tl-bad">${esc(last.why || 'no answer')}</span>`) : 'not polled yet';
        const next = p.on ? (p.nextAt > now ? `next in ${fmtIn(p.nextAt - now)}` : 'next: due') : 'polling stopped';
        const route = lt && lt.direct ? '<span class="tr-tl-hop tr-tl-snr-none">a direct neighbour -- no repeaters between you</span>'
          : lt && lt.out ? `<div class="tr-tl-pathrow"><span class="dim small">there</span>${hopChips(lt.out)}</div><div class="tr-tl-pathrow"><span class="dim small">back</span>${hopChips(lt.back)}</div><div class="dim small">Every repeater reports the signal it heard. The hop to and from ${esc(nameOf(demo, g.key))} itself isn't measured: a companion doesn't pass a trace on. Checked ${fmtAgo(lt.t)}.</div>`
          : '<span class="dim small">No route checked yet.</span>';
        const strip = h.slice(-48).map(e => `<span class="tr-tl-cell ${e.ok ? 'ok' : 'bad'}${e.trace && e.trace.changed ? ' chg' : ''}" title="${esc(`${new Date(e.t).toLocaleString()}: ${e.ok ? 'answered' : e.why || 'no answer'}${e.trace ? ` · route ${e.trace.ok ? (e.trace.direct ? 'direct' : 'checked') : `not checked (${e.trace.why})`}${e.trace.changed ? ', changed' : ''}` : ''}`)}"></span>`).join('');
        const sp = (title, key, color, fmt) => `<div class="tr-tl-spkw"><div class="tr-tl-spkt">${title}</div>${spark(h.map(e => ({ t: e.t, v: key(e) })), color, fmt)}</div>`;
        peers += `<div class="tr-tl-peer" data-key="${esc(g.key)}">
          <div class="tr-tl-ph"><h3>${esc(nameOf(demo, g.key))}</h3><span class="dim small">${status} · ${next}</span><span class="grow"></span>
            <label class="tr-tl-chk">every <select data-act="every" data-key="${esc(g.key)}" aria-label="Poll interval">${G.INTERVALS.map(m => `<option value="${m}"${m === p.every ? ' selected' : ''}>${m} min</option>`).join('')}</select></label>
            ${btn(p.on ? 'stop' : 'start', g.key, p.on ? '⏸ Stop polling' : '▶ Start polling', p.on ? '' : 'primary')}
            ${btn('now', g.key, '⟳ Poll now', '', 'One poll now (it counts against the shared airtime budget)')}</div>
          <div class="tr-tl-tiles">
            <div class="tr-tl-tile"><span>Battery</span><b>${num(lastOk && lastOk.battV, 2, ' V')}</b><i>${lastOk && lastOk.pct != null ? `≈${lastOk.pct}% (LiPo estimate)` : '&nbsp;'}</i></div>
            <div class="tr-tl-tile"><span>MCU temperature</span><b>${num(lastOk && lastOk.tempC, 1, ' °C')}</b><i>${lastOk && lastOk.tempC == null ? 'this board does not report it' : '&nbsp;'}</i></div>
            <div class="tr-tl-tile"><span>Their answer, as we heard it</span><b class="${snrCls(lastOk && lastOk.snr)}">${num(lastOk && lastOk.snr, 1, ' dB')}</b><i>${lastOk && lastOk.rssi != null ? `${lastOk.rssi} dBm RSSI${lastOk.flood ? ' · by flood' : ''}` : '&nbsp;'}</i></div>
            <div class="tr-tl-tile"><span>Round trip</span><b>${lastOk ? `${(lastOk.rtt / 1000).toFixed(1)} s` : '—'}</b><i>${lastOk ? fmtAgo(lastOk.t) : '&nbsp;'}</i></div>
          </div>
          ${lastOk && lastOk.extra ? `<div class="dim small">Also reported: ${lastOk.extra.map(x => esc(x.name === 'gps' ? `GPS ${x.lat}, ${x.lon}` : `${x.name} ${x.value}${x.unit || ''} (ch ${x.ch})`)).join(' · ')}</div>` : ''}
          <div class="tr-tl-route">${route}</div>
          <div class="tr-tl-sparks">
            ${sp('Battery (V)', e => e.ok ? e.battV : null, 'var(--tr-back)', v => `${v.toFixed(2)} V`)}
            ${sp('MCU temperature (°C)', e => e.ok ? e.tempC : null, 'var(--amber)', v => `${v.toFixed(1)} °C`)}
            ${sp('Their answer SNR (dB)', e => e.ok ? e.snr : null, 'var(--tr-out)', v => `${v.toFixed(1)} dB`)}
            ${sp('Weakest repeater hop (dB)', e => e.trace && e.trace.ok ? e.trace.snrMin : null, 'var(--tr-good)', v => `${v.toFixed(1)} dB`)}
          </div>
          <div class="tr-tl-health"><span class="tr-tl-spkt">Route health</span><div class="tr-tl-strip" role="img" aria-label="${esc(`${hl.answered} of ${hl.polls} polls answered, ${hl.changes} route changes`)}">${strip || '<span class="dim small">no polls yet</span>'}</div>
            <span class="dim small">${hl.polls ? `${hl.answered}/${hl.polls} answered (${Math.round(hl.rate * 100)}%) · ${hl.traced} route checks · ${hl.changes} route change${hl.changes === 1 ? '' : 's'}` : ''}</span></div>
        </div>`;
      }

      mount.innerHTML = `<div class="card tr-tl">
        <div class="tr-tl-h"><h2>📊 Telemetry polling</h2><span class="tr-mode${md ? (md[2] === 'ok' ? ' live' : ' demo') : ''}" title="${esc(md ? md[1] : 'Kelly could not read this setting from your node')}">your telemetry: ${md ? md[0] : 'unknown'}</span>${demo ? '<span class="tr-mode demo">demo</span>' : ''}</div>
        <p class="dim small">Read another operator's node -- battery and temperature -- on a timer, with the route to them checked each time. Both of you opt in. Your own node refuses a poll from anyone you haven't granted, even with Kelly closed; Kelly never sends one without their grant.</p>
        ${!ready ? `<p class="tr-tl-warn small">${demo ? 'Demo not available.' : 'Connect a MeshCore companion node (LoRa Mesh > Mesh tab), or turn on Demo.'}</p>` : ''}
        ${ready && base !== 1 && base != null && (inOk.length || base === 2) ? `<div class="tr-tl-warn small">⚠️ ${esc(md[1])} ${btn('limit', '', '🔒 Answer granted contacts only', 'primary')}</div>` : ''}
        <div class="tr-tl-cols">
          <section><h3>Who can poll my telemetry</h3><ul class="tr-tl-list">${inH}</ul></section>
          <section><h3>Who I can poll</h3><ul class="tr-tl-list">${outH}</ul>${form}</section>
        </div>
        ${peers ? `<div class="tr-tl-peers">${peers}</div>` : ''}
      </div>`;
    }

    // ------------------------------------------------------------ the user
    mount.addEventListener('change', ev => {
      const el = ev.target;
      if (el.id === 'tr-tl-who') { reqKey = el.value; render(); }
      else if (el.id === 'tr-tl-offer') reqOffer = el.checked;
      else if (el.dataset.act === 'every') {
        const demo = shownDemo(), w = W[wn(demo)], p = pollOf(w, el.dataset.key), m = Math.max(G.MIN_MIN, Number(el.value) || G.DEFAULT_MIN);
        p.every = m; if (p.on) p.nextAt = Math.min(p.nextAt || Infinity, Date.now() + m * 60e3);
        if (!demo) save(); render();
      }
    });
    mount.addEventListener('click', async ev => {
      const b = ev.target.closest('button[data-act]'); if (!b || b.disabled) return;
      const demo = shownDemo(), w = W[wn(demo)], key = b.dataset.key, a = b.dataset.act, t = T(demo);
      try {
        if (a === 'ask' && key) {
          const n = t.node(key);
          if (!n || n.role !== 'companion') return toast('📊', 'Telemetry polling', 'Only companion contacts can be asked.', 'warn');
          await act(demo, key, 'ask', { offer: reqOffer }); reqKey = '';
        } else if (a === 'approve' || a === 'decline' || a === 'revokeIn' || a === 'dropOut') {
          if (a === 'revokeIn' && !confirm(`Stop ${nameOf(demo, key)} polling your telemetry? Your node stops answering them at once.`)) return;
          await act(demo, key, a);
        } else if (a === 'reflag') { await t.setFlag(key, true); toast('📊', 'Permission set again', `Your node answers ${nameOf(demo, key)} again.`, 'ok'); }
        else if (a === 'unflag') { if (!confirm(`Clear ${nameOf(demo, key)}'s telemetry permission on your node?`)) return; await t.setFlag(key, false); }
        else if (a === 'limit') { await t.setBase(1); toast('🔒', 'Done', 'Your node now answers telemetry only from the contacts you grant.', 'ok'); }
        else if (a === 'open') openKey = openKey === key ? null : key;
        else if (a === 'start' || a === 'stop') {
          const p = pollOf(w, key); p.on = a === 'start';
          if (p.on) { p.nextAt = Date.now(); openKey = key; }
          if (!demo) save(); setTimeout(tick, 50);
        } else if (a === 'now') {
          const r = await poll(demo, key, true);
          if (!r.ok) toast('📊', 'Poll not sent', r.reason, 'warn');
        }
      } catch (e) { toast('⚠️', 'Telemetry polling', e.message, 'error'); }
      render();
    });

    render();
    return {
      destroy() { clearInterval(timer); if (rq) clearTimeout(rq); unsub.forEach(f => safe(f)); mount.innerHTML = ''; },
      _w: W, _poll: (demo, key) => poll(!!demo, key, true),   // tests
    };
  };
})();
