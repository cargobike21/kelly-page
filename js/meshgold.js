/* Kelly Page -- the Golden Packet TOKEN (LoRa Mesh page, MeshCore; Phase 5c of docs/lora-mesh-gap-analysis.md, 2026-10-22).
 *
 * Not the two-way "golden packet" of js/meshpaths.js (a proven exchange with a far station): this is ONE signed packet the
 * club passes station to station (js/gold-token.js has the format and the rules). The P25X gateway mints it and keeps the
 * ledger (server.js "Golden Packet ledger"); each hand-off is a MeshCore DM "GOLD ..." signed by the GIVER'S NODE.
 *
 *   receive   a GOLD hand-off DM'd to this node: checked against the sender's key from the node's contacts (and that it
 *             names THIS node as the recipient), kept, celebrated (Mesh Quest: Golden Packet Holder, the hand-off km
 *             record), and reported to the gateway over P25 (KF {op: 'gold'}, server.js kfGold) when that's ticked
 *   pass on   the holder picks a contact and confirms; the node signs the next hand-off (meshcore.js sign()), Kelly checks
 *             the signature itself, DMs it (normal retries) and reports it too -- whoever reaches the gateway first wins,
 *             the ledger takes the second report as a duplicate. Never automatic.
 *   paste     a token as text (a freshly minted one sent some other way, or a hand-off read off another screen)
 *   ask       the gateway's view of a token (holder, seq, last holders) -- shows up a fork or a hand-off we missed
 * Off unless ms.gold.on: until then a GOLD DM is just a text. Tokens live in this browser (store 'meshGold2'), per node key.
 *
 * Awards rules (kelly-page/AWARDS_REVIEW.md section 5 "Token", 2026-10-24; the token stays DM-only):
 *   - the giver's key comes from the node's contacts, else from the P25X ham directory (KellyHamCalls.all(), src 'dir')
 *   - the pass-on picker offers only licensed hams' companions (k.hamOf(node).ham, type 1, not one of ours)
 *   - Holder / Pass It On XP (k.F('token') / k.F('gave')) only once the gateway LEDGER says OK to our report (it records
 *     same-owner, A->B->A within 24 h and unknown-owner hand-offs WITHOUT trophies: reply {ok, trophies, why});
 *     each call carries the other side's key / owner and whether it's a NEW giver / receiver (distinct counts). No radio,
 *     no answer: the hand-off still happens, the XP waits ("Report to the ledger" asks again)
 *   - store 'meshGold2'; the old 'meshGold' is read only: shown as classic history, a token still held there moves across
 *     (already scored: no XP again), and it is never written again
 *   - demo (k.awardsDemo() / k.isDemo()): a session-only book, nothing stored, nothing reported, no XP
 *
 * window.KellyMeshGold(k) -> { text, render, init, gatewayReply, kfEvent, ownsXid }; k from mesh.js.
 */
(function () {
  'use strict';
  const MAX_TOKENS = 30, MAX_LOG = 60, MAX_WHO = 200, STORE = 'meshGold2', CLASSIC = 'meshGold';

  window.KellyMeshGold = function (k) {
    const { $, esc, store, toast } = k, ms = k.ms;
    const G = window.GoldToken, ed = G && window.nacl ? G.naclEd(window.nacl) : null;
    ms.gold = Object.assign({ on: false, report: true }, ms.gold || {});
    const ui = { sig: '', asks: new Map(), sending: new Map(), status: {} };
    const myKey = () => { const s = k.session(); return s && s.selfKey ? s.selfKey() : null; };
    const myPre = () => G.prefixOf(myKey() || '');
    const isDemo = () => { try { if (k.awardsDemo && k.awardsDemo()) return true; } catch { /* */ } try { return !!(k.isDemo && k.isDemo()); } catch { return false; } };
    const fresh = () => ({ tokens: {}, log: [], givers: {}, receivers: {} });
    const demoBook = {};   // demo: per node key, this session only
    const classic = me => { try { const all = store.get(CLASSIC, {}) || {}; return all[me || myPre() || 'none'] || null; } catch { return null; } };
    // first use of meshGold2 for this node: a token still HELD in the classic book moves across (already scored)
    function migrate(me) {
      const d = fresh(), c = classic(me);
      if (c && c.tokens) for (const t of Object.values(c.tokens)) if (t && t.id != null && !t.gave) d.tokens[t.id] = { ...t, classic: true, credited: 'classic' };
      return d;
    }
    function D() {
      const me = myPre() || 'none';
      if (isDemo()) return demoBook[me] || (demoBook[me] = fresh());
      const all = store.get(STORE, {}) || {};
      const d = all[me] || migrate(me);
      for (const f of ['tokens', 'givers', 'receivers']) d[f] = d[f] || {};
      d.log = d.log || [];
      return d;
    }
    function put(d) {
      const me = myPre() || 'none';
      if (isDemo()) { demoBook[me] = d; return; }   // demo: never stored
      const all = store.get(STORE, {}) || {}; all[me] = d; store.set(STORE, all);
    }
    const redraw = () => { ui.sig = ''; k.dirty('mesh'); };
    const nodeByPrefix = p => p ? [...k.nodes()].find(n => n.key && n.key.slice(0, 12) === p) || null : null;
    // a key from the P25X ham directory (signed entries) when the node has no contact for it
    function dirNode(p) {
      try {
        const H = window.KellyHamCalls, e = p && H && H.all ? H.all().find(x => x.src === 'dir' && x.key && String(x.key).toLowerCase().slice(0, 12) === p) : null;
        return e ? { num: null, key: String(e.key).toLowerCase(), longName: e.name || e.call, call: e.call, type: 0, fromDir: true } : null;
      } catch { return null; }
    }
    const nameOf = p => { const n = nodeByPrefix(p) || dirNode(p); return n ? n.longName : p === myPre() ? (k.myCall() || 'you') : p; };
    // ---- who counts (js/award-engine.js; KellyAwards.NOT_HAM until mesh.js passes hamOf)
    const NOT_HAM = () => (window.KellyAwards && window.KellyAwards.NOT_HAM) || { ham: false, tier: 'none', call: null, owner: null, cls: 'unknown', self: false, src: null, why: 'Ham Contacts did not load, so nothing scores', demo: false };
    const hamOf = n => { try { return (n && k.hamOf && k.hamOf(n)) || NOT_HAM(); } catch { return NOT_HAM(); } };
    const typeOf = n => Number(n && (n.type != null ? n.type : n.role)) || 0;
    const selfKey = key => { try { return !!(key && k.isSelf && k.isSelf(key)); } catch { return false; } };
    const hamCompanion = n => { if (!n || !/^[0-9a-f]{64}$/i.test(n.key || '') || typeOf(n) !== 1 || n.num === k.myNum()) return false; const hs = hamOf(n); return !!(hs.ham && !hs.self && !selfKey(n.key)); };
    const contacts0 = () => { try { return [...k.nodes()].filter(hamCompanion).map(n => n.num).join(','); } catch { return ''; } };   // the picker, for the redraw signature
    // the ledger's answer to OUR report: XP only on ok + trophies (ok alone = recorded without trophies; server.js kfGold)
    const ledgerOk = j => !!(j && j.ok && !j.pending && !j.fork && j.trophies);
    function capWho(m) { const ks = Object.keys(m); if (ks.length > MAX_WHO) ks.sort((a, b) => m[a] - m[b]).slice(0, ks.length - MAX_WHO).forEach(x => delete m[x]); }
    const kmTo = n => { const me = k.myPos(); return me && n && n.lat != null ? Math.round(k.distKm(me, n) * 10) / 10 : null; };
    function log(d, text) { d.log.unshift({ t: Date.now(), text }); d.log.splice(MAX_LOG); k.addEvent('network', `Golden Packet: ${text}`); }
    function keep(d, tok) {
      d.tokens[tok.id] = tok;
      const ids = Object.keys(d.tokens).sort((a, b) => (d.tokens[b].at || 0) - (d.tokens[a].at || 0));
      for (const id of ids.slice(MAX_TOKENS)) delete d.tokens[id];
    }

    // ---------------------------------------------------------------- receive
    // a text from the mesh (mesh.js, every MeshCore DM): {from: num, text, snr, hops}. True when it was a token.
    function text(m) {
      if (!ms.gold.on || !G || !m || !/\bGOLD [A-Za-z0-9_-]{100,}/.test(m.text || '')) return false;
      const p = G.parse(m.text); if (!p) return false;
      if (p.kind === 'mint') return accept(m.text, { via: k.nodeName(m.from) });
      const giver = k.node(m.from);
      return accept(m.text, { giver, snr: m.snr, hops: m.hops });
    }
    // a token text, from a DM or pasted. o.giver: the node it came from (a DM). -> true if kept
    function accept(textIn, o = {}) {
      const p = G.parse(textIn), d = D(), me = myPre();
      if (!p) { toast('🪙', 'Not a Golden Packet', 'Expected "GOLD " and about 120 letters', 'bad'); return false; }
      if (!me) { toast('🪙', 'Connect your MeshCore node first', 'A token belongs to a node key', 'bad'); return false; }
      if (p.kind === 'mint') {
        if (p.holder !== me) { toast('🪙', `Token #${p.id} was minted for someone else`, `holder ${nameOf(p.holder)}`, 'bad'); return false; }
        if (d.tokens[p.id] && d.tokens[p.id].seq >= 0) { toast('🪙', `You already have token #${p.id}`, '', 'warn'); return false; }
        keep(d, { id: p.id, seq: 0, from: 'gateway', fromName: 'P25X gateway', to: me, ts: p.ts, text: G.toText(G.join(p.body, p.sig)), verified: 'issuer not checked', at: Date.now(), km: null });
        log(d, `token #${p.id} minted for you`); put(d);
        if (ms.gold.report && !isDemo()) ask(p.id, 'mint');   // Holder XP once the ledger confirms you hold it
        redraw(); return true;
      }
      // a hand-off: it must name this node, and verify against the giver's key
      if (p.to !== me) { k.addEvent('network', `Golden Packet: hand-off ${p.seq} of token #${p.id} is for ${nameOf(p.to)}, not you -- ignored`); return false; }
      const ok64 = n => !!(n && /^[0-9a-f]{64}$/i.test(n.key || ''));
      const giver = [o.giver && o.giver.key && o.giver.key.slice(0, 12) === p.from ? o.giver : null, nodeByPrefix(p.from), dirNode(p.from)].find(ok64) || null;
      if (!giver) {
        toast('🪙', `A Golden Packet from an unknown node (${p.from})`, "Neither your node nor the P25X ham directory has a key for the giver, so it can't be checked -- ask them to send an advert", 'bad');
        return false;
      }
      if (!ed || !G.check(p, giver.key, ed)) { toast('🪙', `A forged Golden Packet from ${giver.longName}?`, "The signature doesn't match the giver's node key -- not kept", 'bad'); log(d, `refused a bad signature (token #${p.id}) from ${giver.longName}`); put(d); redraw(); return false; }
      const had = d.tokens[p.id];
      if (had && had.seq >= p.seq) { if (had.seq === p.seq) return true; toast('🪙', `An old hand-off of token #${p.id}`, `you've seen hand-off ${had.seq} already`, 'warn'); return false; }
      const km = kmTo(giver), tok = { id: p.id, seq: p.seq, from: p.from, fromName: giver.longName || p.from, giverKey: giver.key.toLowerCase(), to: me, ts: p.ts,
        text: G.toText(G.join(p.body, p.sig)), verified: giver.fromDir ? 'directory key' : 'node key', at: Date.now(), km, snr: o.snr ?? null, hops: o.hops ?? null, reported: null, gave: null, credited: null };
      keep(d, tok); log(d, `token #${p.id} from ${tok.fromName}${km != null ? ` (${km} km)` : ''}, hand-off ${p.seq}`); put(d);
      k.sfx('ack');
      // Holder XP waits for the ledger (gatewayReply -> credit)
      if (ms.gold.report) reportGot(tok);
      redraw(); return true;
    }
    const reportGot = tok => report(tok.id, tok.text, tok.giverKey, { fn: tok.fromName, tn: k.myCall() || '', km: tok.km, snr: tok.snr, hops: tok.hops }, 'got');
    const reportGave = tok => report(tok.id, tok.gave.text, myKey(), { fn: k.myCall() || '', tn: tok.gave.toName, km: tok.gave.km, hops: tok.gave.hops ?? null }, 'gave');

    // ---------------------------------------------------------------- XP, only after the ledger says OK
    function credit(d, tok, role, j) {
      if (isDemo()) return;
      const x = role === 'gave' ? tok.gave : tok;
      if (!x || x.credited) return;
      if (j && j.ok && !ledgerOk(j)) {   // recorded, but no trophy (a key not in the directory, same owner...)
        x.credited = 'none'; log(d, `token #${tok.id}: on the ledger, but no XP -- ${j.why || j.error || 'both stations need to be in the P25X ham directory'}`); return;
      }
      x.credited = Date.now();
      if (role === 'gave') {
        const n = { key: tok.gave.key || null, num: tok.gave.num, longName: tok.gave.toName, type: 1 }, hs = n.key ? hamOf(n) : NOT_HAM();
        const who = String(hs.owner || n.key || tok.gave.to), isNew = !d.receivers[who]; if (isNew) d.receivers[who] = Date.now(); capWho(d.receivers);
        k.F('gave', { id: tok.id, seq: tok.gave.seq, key: n.key, owner: hs.owner || null, ham: hs, km: tok.gave.km, newReceiver: isNew, receivers: Object.keys(d.receivers).length });
      } else {
        const g = tok.from === 'gateway' ? null : nodeByPrefix(tok.from) || dirNode(tok.from) || (tok.giverKey ? { key: tok.giverKey, longName: tok.fromName } : null);
        const hs = g ? hamOf(g) : NOT_HAM(), who = tok.from === 'gateway' ? 'gateway' : String(hs.owner || tok.giverKey || tok.from), isNew = !d.givers[who];
        if (isNew) d.givers[who] = Date.now(); capWho(d.givers);
        k.F('token', { id: tok.id, seq: tok.seq, fromName: tok.fromName, km: tok.km, snr: tok.snr ?? null, hops: tok.hops ?? null, key: tok.giverKey || null, owner: hs.owner || null, ham: hs, newGiver: isNew, givers: Object.keys(d.givers).length });
      }
    }

    // ---------------------------------------------------------------- the gateway (over P25)
    // role: 'got' (we received it) / 'gave' (we passed it on) -- whose XP the ledger's answer releases
    async function report(id, t, giverKey, meta, role) {
      if (isDemo()) { k.addEvent('network', `Golden Packet: demo -- token #${id} not reported to the gateway (no XP in demo)`); return; }
      let xid = null;
      try { xid = await k.kfRequest({ op: 'gold', t, k: giverKey, ...meta, call: k.myCall() || '' }, `reporting Golden Packet #${id} to the P25X gateway`); } catch { xid = null; }
      if (xid) ui.asks.set(xid, { id: Number(id), kind: 'report', role: role || 'got', at: Date.now() });
      else ui.status[id] = { err: 'not reported (no P25 radio?) -- the XP waits for the ledger' };
      redraw();
    }
    // the ledger's view; role 'mint' = a fresh mint pasted / received: Holder XP when it says this node holds it
    async function ask(id, role) {
      if (isDemo()) { if (!role) toast('🪙', 'Demo tokens stay on this PC', '', 'warn'); return; }
      let xid = null;
      try { xid = await k.kfRequest({ op: 'gold', id: Number(id) }, `asking the P25X gateway about Golden Packet #${id}`); } catch { xid = null; }
      if (xid) { ui.asks.set(xid, { id: Number(id), kind: 'ask', role: role || null, at: Date.now() }); ui.status[id] = { busy: true }; }
      redraw();
    }
    // ask the ledger again for a hand-off whose XP is still waiting (no radio at the time, no answer, report was off)
    function reportAgain(id) {
      const d = D(), tok = d.tokens[id]; if (!tok) return;
      if (tok.gave && !tok.gave.credited) reportGave(tok);
      else if (tok.from === 'gateway' && !tok.credited) ask(id, 'mint');
      else if (!tok.credited) reportGot(tok);
    }
    const ownsXid = xid => ui.asks.has(xid);
    function kfEvent(e) {
      const a = e.t && ui.asks.get(e.t.xid); if (!a) return;
      if (e.kind === 'tx-failed') { ui.asks.delete(e.t.xid); ui.status[a.id] = { err: `no answer from the P25X gateway${a.kind === 'report' || a.role ? ' -- the XP waits for the ledger' : ''}` }; if (!e.cancelled) toast('🪙', 'No answer from the P25X gateway', `Golden Packet #${a.id}`, 'bad'); }
      redraw();
    }
    // {app: 'gold', ok, duplicate, pending, fork, error, token: summary, last?}. One request in the air per token is the
    // usual case, so the oldest outstanding ask for that token (or any) takes the answer.
    function gatewayReply(j) {
      const id = j.token ? j.token.id : null;
      let hit = null;
      for (const [xid, a] of ui.asks) if (id == null || a.id === id) { hit = a; ui.asks.delete(xid); break; }
      const d = D(), tok = id != null ? d.tokens[id] : hit ? d.tokens[hit.id] : null;
      if (hit && hit.kind === 'report' && tok) {
        const gave = hit.role === 'gave' && tok.gave, x = gave ? tok.gave : tok;
        x.reported = { at: Date.now(), ok: !!j.ok, dup: !!j.duplicate, pending: !!j.pending, error: j.error || null, trophy: ledgerOk(j) };
        if (j.ok) { log(d, `the gateway recorded token #${tok.id}${gave ? ` to ${tok.gave.toName}` : ''}${j.duplicate ? ' (already had it)' : ''}`); credit(d, tok, gave ? 'gave' : 'got', j); }
        else if (j.pending) log(d, `the gateway kept token #${tok.id} until the hand-off before it arrives -- the XP waits`);
        else { log(d, `the gateway refused token #${tok.id}: ${j.error} -- no XP`); toast('🪙', `The gateway refused Golden Packet #${tok.id}`, j.error || '', 'bad'); }
        put(d);
      } else if (hit && hit.kind === 'ask' && hit.role === 'mint' && tok && tok.from === 'gateway' && j.token) {
        // a mint: the ledger says this node is its first holder
        if (j.token.holder === myPre() && Number(j.token.seq) === 0) { credit(d, tok, 'got', Object.assign({}, j, { ok: true, trophies: true })); put(d); }
      } else if (hit && hit.kind === 'ask' && tok && Array.isArray(j.last)) {
        // a status answer: each `last` row is [seq, name, km, unix s, trophies 1/0] -- settles XP still waiting on our hand-offs
        const row = seq => j.last.find(r => Array.isArray(r) && Number(r[0]) === seq && (r[4] === 0 || r[4] === 1));
        const rg = tok.from !== 'gateway' && !tok.credited ? row(tok.seq) : null, rv = tok.gave && !tok.gave.credited ? row(tok.gave.seq) : null;
        if (rg) credit(d, tok, 'got', { ok: true, trophies: rg[4] === 1, why: 'the ledger recorded it without trophies' });
        if (rv) credit(d, tok, 'gave', { ok: true, trophies: rv[4] === 1, why: 'the ledger recorded it without trophies' });
        if (rg || rv) put(d);
      }
      const sid = id != null ? id : hit && hit.id;
      if (sid != null) ui.status[sid] = j.ok || j.token ? { at: Date.now(), token: j.token, last: j.last || null, error: j.ok ? null : j.error } : { err: j.error || 'refused' };
      if (hit && hit.kind === 'ask' && !hit.role && j.token) {
        const mine = j.token.holder === myPre();
        toast('🪙', `Golden Packet #${j.token.id}: ${mine ? 'the ledger says YOU hold it' : `held by ${j.token.holderName || nameOf(j.token.holder)}`}`, `${j.token.hops} hand-offs · ${j.token.km} km · ${j.token.holders} holders`, mine ? 'good' : '');
      }
      redraw();
    }

    // ---------------------------------------------------------------- pass it on
    async function give(id, num) {
      const d = D(), tok = d.tokens[id], n = k.node(num), s = k.session();
      if (!tok || tok.gave) return;
      if (!s || !s.sign || !myKey()) { toast('🪙', 'Connect your MeshCore node first', 'Your node signs the hand-off', 'bad'); return; }
      if (!n || !/^[0-9a-f]{64}$/i.test(n.key || '')) { toast('🪙', 'Pick a contact your node has a key for', '', 'bad'); return; }
      if (!hamCompanion(n)) { toast('🪙', `${n.longName || 'That node'} isn't a ham's companion`, hamOf(n).why || 'The token goes only to licensed hams\' own companion nodes -- not repeaters, rooms or your own nodes', 'bad'); return; }
      if (tok.seq >= 255) { toast('🪙', `Token #${id} has retired`, '255 hand-offs is its lot', 'warn'); return; }
      if (!confirm(`Pass Golden Packet #${id} to ${n.longName}?\n\nOnce your node signs it, the token is theirs -- the gateway won't take a second hand-off from you.`)) return;
      const body = G.handoffBody({ id: tok.id, seq: tok.seq + 1, from: myKey(), to: n.key, ts: Math.floor(Date.now() / 1000) });
      let sig;
      try { sig = await s.sign(body); } catch (e) { toast('🪙', 'Your node would not sign the hand-off', e.message, 'bad'); return; }
      const bytes = G.join(body, sig), p = G.parse(bytes);
      if (!ed || !G.check(p, myKey(), ed)) { toast('🪙', "The node's signature didn't check out", 'Not sent', 'bad'); return; }
      const t = G.toText(bytes), km = kmTo(n);
      tok.gave = { seq: tok.seq + 1, to: n.key.slice(0, 12), key: n.key.toLowerCase(), toName: n.longName, num: n.num, text: t, at: Date.now(), km, hops: n.hops ?? null, reported: null, credited: null };
      log(d, `token #${id} passed to ${n.longName}${km != null ? ` (${km} km)` : ''}`); put(d);
      const msg = await k.sendDm(n.num, `${t}`);
      if (msg) ui.sending.set(Number(id), msg);
      // Pass It On XP waits for the ledger (gatewayReply -> credit)
      if (ms.gold.report) reportGave(tok);
      redraw();
    }

    // ---------------------------------------------------------------- render
    function render() {
      const box = $('#mg-card'); if (!box) return;
      const on = !!(k.caps().contacts && G);
      box.hidden = !on; if (!on || k.currentPage() !== 'mesh') return;
      const d = D(), toks = Object.values(d.tokens).sort((a, b) => b.at - a.at), sending = [...ui.sending].map(([id, m]) => [id, m.state]);
      const sig = JSON.stringify([ms.gold, toks.map(t => [t.id, t.seq, !!t.gave, t.reported && t.reported.at, t.credited, t.gave && t.gave.credited, t.gave && t.gave.reported && t.gave.reported.at]), sending, ui.status, ui.asks.size, d.log.length, k.online(), myPre(), isDemo(), contacts0(), Math.floor(Date.now() / 60000)]);
      if (sig === ui.sig) return; ui.sig = sig;
      const held = toks.filter(t => !t.gave);
      $('#mg-tag').textContent = ms.gold.on ? `${held.length} held` : 'off';
      $('#mg-on').checked = !!ms.gold.on; $('#mg-rep').checked = !!ms.gold.report;
      const body = $('#mg-body');
      if (!ms.gold.on) { body.innerHTML = '<p class="small dim">Off: a <code>GOLD ...</code> DM shows as an ordinary message.</p>'; return; }
      // hams' own companions only (the token is a contact award: AWARDS_REVIEW.md section 5)
      const contacts = [...k.nodes()].filter(hamCompanion)
        .sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99) || (a.longName || '').localeCompare(b.longName || ''));
      const opts = contacts.map(n => { const c = hamOf(n).call; return `<option value="${n.num}">${esc(n.longName)}${c && !String(n.longName || '').toUpperCase().includes(c) ? ` (${esc(c)})` : ''}${n.hops != null ? ` · ${n.hops === 0 ? 'direct' : n.hops + ' hop' + (n.hops > 1 ? 's' : '')}` : ''}${kmTo(n) != null ? ` · ${kmTo(n)} km` : ''}</option>`; }).join('');
      const xpState = x => x.credited === 'classic' ? 'classic (scored before)' : x.credited === 'none' ? 'no XP (see the log)' : x.credited ? '✓ XP' : isDemo() ? 'demo: no XP' : '⏳ XP when the ledger confirms';
      const repState = t => (!t.reported ? (ms.gold.report && !isDemo() && t.from !== 'gateway' && ui.asks.size ? 'reporting…' : '') : t.reported.ok ? '✓ on the ledger' : t.reported.pending ? '⏳ ledger waiting for an earlier hand-off' : `✗ ledger: ${esc(t.reported.error || 'refused')}`) + ` · ${xpState(t)}`;
      const again = (t, x) => !x.credited && !isDemo() && !(x.reported && !x.reported.ok && !x.reported.pending) ? ` <button class="btn ghost small" data-report="${t.id}">Report to the ledger</button>` : '';
      const st = id => { const s = ui.status[id]; if (!s) return ''; if (s.busy) return '<small class="dim">asking the gateway…</small>'; if (s.err) return `<small class="rp-err">${esc(s.err)}</small>`;
        const x = s.token; if (!x) return `<small class="rp-err">${esc(s.error || '')}</small>`;
        return `<small>Ledger: ${x.holder === myPre() ? '<b>you</b>' : esc(x.holderName || nameOf(x.holder))} hold${x.holder === myPre() ? '' : 's'} it · hand-off ${x.seq} · ${x.km} km · ${x.holders} holders${x.forks ? ` · ⚠ ${x.forks} fork${x.forks > 1 ? 's' : ''}` : ''}</small>`
          + (s.last ? `<small class="dim">${s.last.map(([seq, nm, km]) => `${seq}: ${esc(nm)}${km != null ? ` ${km} km` : ''}`).join(' → ')}</small>` : ''); };
      let h = held.length ? '' : '<p class="small dim">You hold no token. One arrives as a <code>GOLD ...</code> DM from the station passing it on -- or paste one below.</p>';
      for (const t of held) {
        h += `<div class="mg-tok" data-id="${t.id}"><div class="mg-head"><span class="mg-coin">🪙</span><b>Token #${t.id}</b><span class="dim small">hand-off ${t.seq} · from ${esc(t.fromName)}${t.km != null ? ` · ${t.km} km` : ''}${t.snr != null ? ` · SNR ${t.snr}` : ''} · ${k.fmtAgo(t.at)}</span></div>`
          + `<div class="small">${t.verified === 'node key' ? '✓ signed by the giver\'s node' : t.verified === 'directory key' ? '✓ signed by the giver\'s node (key from the P25X ham directory)' : esc(t.verified)} · ${repState(t)}${again(t, t)}</div>${st(t.id)}`
          + `<div class="row gap wrap mg-ctl"><label class="fld grow"><span>Pass it on to</span><select class="mg-to">${opts || '<option value="">no ham companions with a key yet</option>'}</select></label>`
          + `<button class="btn primary" data-give="${t.id}"${opts && k.online() ? '' : ' disabled'}>🤲 Pass it on</button><button class="btn ghost small" data-ask="${t.id}">Ask the gateway</button></div></div>`;
      }
      const given = toks.filter(t => t.gave);
      if (given.length) h += `<h3 class="rp-h">Passed on</h3><ul class="mg-list">${given.map(t => { const m = ui.sending.get(t.id);
        return `<li>🪙 #${t.id} → <b>${esc(t.gave.toName)}</b>${t.gave.km != null ? ` · ${t.gave.km} km` : ''} · ${k.fmtAgo(t.gave.at)}${m ? ` · ${m.state === 'delivered' ? '✓✓ delivered' : esc(m.state)}` : ''} · <span class="small">${repState(t.gave)}</span>${again(t, t.gave)} <button class="btn ghost small" data-ask="${t.id}">Ask the gateway</button>${st(t.id)}</li>`; }).join('')}</ul>`;
      // classic (store 'meshGold', before the 2026-10-24 rules): read only, never written
      const cl = isDemo() ? null : classic(myPre());
      if (cl && ((cl.tokens && Object.keys(cl.tokens).length) || (cl.log && cl.log.length))) {
        const ct = Object.values(cl.tokens || {}).sort((a, b) => (b.at || 0) - (a.at || 0));
        h += `<details class="mg-classic"><summary class="small">Classic history (${ct.length} token${ct.length === 1 ? '' : 's'}, before the hams-only rules)</summary><ul class="small dim">${ct.slice(0, 20).map(t => `<li>🪙 #${esc(t.id)} from ${esc(t.fromName || '?')}${t.gave ? ` → ${esc(t.gave.toName || '?')}` : ' (moved to your tokens above)'}${t.km != null ? ` · ${esc(t.km)} km` : ''}</li>`).join('')}${(cl.log || []).slice(0, 10).map(x => `<li>${k.fmtAgo(x.t)}: ${esc(x.text)}</li>`).join('')}</ul></details>`;
      }
      h += `<details class="mg-paste"><summary class="small">Got a token as text?</summary><div class="row gap wrap"><input class="grow" id="mg-text" placeholder="GOLD ..." spellcheck="false"><button class="btn" id="mg-add">Add</button></div></details>`;
      if (d.log.length) h += `<details class="mg-log"><summary class="small">Token log (${d.log.length})</summary><ul class="small dim">${d.log.slice(0, 20).map(x => `<li>${k.fmtAgo(x.t)}: ${esc(x.text)}</li>`).join('')}</ul></details>`;
      const open = [...body.querySelectorAll('details[open]')].map(x => x.className);
      body.innerHTML = h;
      for (const c of open) { const x = body.querySelector(`details.${c.split(' ')[0]}`); if (x) x.open = true; }
    }
    function init() {
      const box = $('#mg-card'); if (!box) return;
      $('#mg-on').onchange = e => { ms.gold.on = e.target.checked; k.save(); redraw(); };
      $('#mg-rep').onchange = e => { ms.gold.report = e.target.checked; k.save(); redraw(); };
      $('#mg-body').onclick = e => {
        const g = e.target.closest('[data-give]'); if (g) { const sel = g.closest('.mg-tok').querySelector('.mg-to'); if (sel && sel.value) give(Number(g.dataset.give), Number(sel.value) >>> 0); return; }
        const a = e.target.closest('[data-ask]'); if (a) { ask(a.dataset.ask); return; }
        const r = e.target.closest('[data-report]'); if (r) { reportAgain(Number(r.dataset.report)); return; }
        if (e.target.id === 'mg-add') { const i = $('#mg-text'); if (i && accept(i.value.trim())) i.value = ''; }
      };
    }
    return { text, accept, render, init, gatewayReply, kfEvent, ownsXid, give, reportAgain, data: D };
  };
})();
