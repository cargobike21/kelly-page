/* Kelly Page -- LoRa Mesh > 📇 Ham Contacts > contact cards (#hc-share; HAM_CONTACTS_PLAN.md agent 2, 2026-10-24, unreleased).
 * STANDARD MeshCore card forms only (js/hc-core.js header): out = svc.myCard() -> the signed advert link
 * (meshcore://<hex>, the official app's "share contact") in a box with Copy / Download .txt, plus the official app's QR
 * (meshcore://contact/add?...). In = paste / 📷 camera / 🖼️ picture / 📄 .txt file (<= 4 kB), read with HC.parseCard
 * (signature checked), previewed, then one click svc.add(cardInfo). A card that doesn't parse adds nothing. The card holds
 * only the node's PUBLIC key -- the private key never leaves the radio.
 * QR / camera / clipboard: js/meshqr.js only (KellyMeshQR.draw / cameraWhy / copy / fingerprint, ui().show / scan /
 * fromImage / confirm / confirmCard -- one dialog per page). QR_REVIEW.md section 5:
 *   preview: "✅ name and position signed by this radio (callsign not checked)" vs "⚠️ unsigned app QR"; the 16-hex
 *   fingerprint + 1/2-byte path hash (+ the whole key on demand); "on your radio as X -- this card says Y"; every other
 *   card in the text listed (one Add each); the reader's warnings; the callsign trust label (KellyHamCalls.trust:
 *   ✅ in the P25X directory · 🖊️ signed advert · 👤 you set it · ❔ claimed · ⛔ directory conflict = the directory
 *   lists THIS key under another call -> "Add anyway" asks first · ℹ️ the call has other nodes in the directory).
 *   An unsigned contact/add added -> KellyHamCalls.qrClaim(key, name) (a claim until that key's own advert is seen).
 * 🤝 Swap (in person): my contact/add QR big + my fingerprint to read aloud -> "Now scan theirs" -> preview -> added with
 *   svc.add(card, { direct: true }) (zero-hop route: they are in range) -> a pre-filled, user-tapped DM "73 de CALL, QR
 *   swap" (c.sendDm) whose ACK proves they hold our key: the checklist "✅ I have them · ✅ they have me (their node
 *   ACKed)". The Handshake award comes from that ACK as for any DM (meshpaths / meshfun 'ack'); a swap scores nothing.
 *   Opt-in while it is open: stations whose NEW zero-hop advert is heard are offered (❔, never added by themselves).
 * Bus 'card' { how: 'copy'|'download'|'qr'|'scan', key?, at } (Mesh Quest's Calling Card window) only when a card really
 *   changes hands -- a copy that worked, a saved file, the big / swap QR shown, or (how 'scan', key = theirs) a card we
 *   read from a camera / picture / the LoRa Mesh Scan button and added. Never when the card just draws.
 * window.KellyHCShare(mount, c) -> { destroy(), importText(text) }   (c = the shell's context, js/hc-ui.js)
 *   importText(text): the LoRa Mesh 📷 Scan hook (window.kellyHCImport in js/hc-ui.js) -- the text goes into the import
 *   box and its preview opens; nothing is added until the user presses Add.
 */
(function () {
  'use strict';

  window.KellyHCShare = function (mount, c) {
    const HC = c.HC, esc = c.esc, Q = window.KellyMeshQR || null;
    const offs = [];
    let card = null, cardErr = null, getting = false, cardSeq = 0;     // export
    let parsed = null, parseErr = null, adding = false, addRes = null, prevSeq = 0, inMsg = null, src = 'paste', more = [];   // import
    let swap = null;   // { at, key, card, added, res, dm, msg, theyHave, listen, offers: Map, gone: Set, busy }
    let qrUi = null, timer = null, lastDraw = 0, dirty = false, dead = false, dmTimer = null;

    const cap = s => { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/([^.!?])$/, '$1.') : ''; };
    const q = sel => mount.querySelector(sel);
    const st = () => { try { return c.svc.state(); } catch { return { link: { online: false }, busy: [], me: null }; } };
    const busyOp = op => { const b = st().busy || []; return b.includes(op); };
    const camWhy = () => { try { return Q ? Q.cameraWhy() || '' : 'The QR reader did not load.'; } catch { return 'The camera is not available here.'; } };
    const qr = () => { if (!qrUi && Q) qrUi = Q.ui({ toast: (...a) => { try { c.toast(...a); } catch { /* no toast */ } } }); return qrUi; };
    const typeName = t => `${HC.TYPE_ICON[t] || '❔'} ${HC.TYPE_NAME[t] || 'Node'}`;
    const handOut = (how, extra) => { try { c.bus.emit('card', Object.assign({ how, at: Date.now() }, extra || {})); } catch { /* never throw */ } };
    const fp = k => (Q ? Q.fingerprint(k) : String(k || '').slice(0, 16)).replace(/([0-9a-f]{4})(?=[0-9a-f])/g, '$1 ');
    const shortKey = k => `<code class="hc-sh-key" title="${esc(k)}">${esc(String(k).slice(0, 8))}…</code>`;
    const keyHtml = k => `<code class="hc-sh-fp">${esc(fp(k))}</code> <span class="hc-sh-hash">path hash <code>${esc(String(k).slice(0, 2))}</code> / <code>${esc(String(k).slice(0, 4))}</code></span>
      <details class="hc-sh-full"><summary>whole key</summary><code>${esc(k)}</code></details>`;
    const H = () => window.KellyHamCalls || null;
    const parseOne = t => HC.parseCard(t, { ed: c.ed });
    // the callsign trust label for a card (KellyHamCalls.trust), or null without it
    const trustOf = p => { const K = H(); try { return K && K.trust ? K.trust(p.key, { name: p.name, call: p.call, signed: !!p.verified, qr: !p.verified }) : null; } catch { return null; } };
    const claim = p => { const K = H(); if (p && !p.verified && K && K.qrClaim) { try { K.qrClaim(p.key, p.name); } catch { /* */ } } };
    const getRec = key => { try { return c.svc.get(key); } catch { return null; } };
    const myCall = () => { try { return (c.myCall && c.myCall()) || (st().me && st().me.call) || ''; } catch { return ''; } };
    // "on your radio as X -- this card says Y" (S5): an unsigned card never renames a contact
    function radioLine(p) {
      const s = st(), rec = getRec(p.key);
      if (s.me && s.me.key === p.key) return { cls: 'warn', text: 'This is your own card.', mine: true };
      if (rec && rec.onRadio) return rec.name && rec.name !== p.name
        ? { cls: 'ok', text: `✅ On your radio as "${rec.name}" -- this card says "${p.name || '(no name)'}".${p.verified ? '' : ' Kelly never renames a contact from an unsigned card.'}`, on: true }
        : { cls: 'ok', text: '✅ Already on your radio', on: true };
      return { cls: '', text: rec && rec.pending ? 'Heard, not added yet' : 'Not on your radio yet' };
    }

    // ------------------------------------------------------------ skeleton (built once; inputs keep their text)
    const why = camWhy();
    mount.innerHTML = `<div class="card hc-sh">
      <div class="card-h"><h2>🪪 Contact cards</h2><span class="tag">standard MeshCore</span></div>
      <section class="hc-sh-sec">
        <h3 class="hc-sh-h">My contact card</h3>
        <div class="hc-sh-row"><button class="btn primary small" data-sh="get">🪪 Get my card</button>
          <button class="btn small" data-sh="swap" title="In person: show your QR, scan theirs, and check with a message that both radios have each other">🤝 Swap with a ham here</button>
          <span class="hc-sh-msg" data-sh="get-msg" aria-live="polite"></span></div>
        <div data-sh="swapbox"></div>
        <div data-sh="out"></div>
        <p class="hc-sh-note">🔐 A card holds only your radio's <b>public</b> key (never the private key), so it is safe to share anywhere. It works in the official MeshCore phone app too.</p>
      </section>
      <section class="hc-sh-sec hc-sh-in">
        <h3 class="hc-sh-h">Add a ham's card</h3>
        <textarea class="hc-sh-paste" data-sh="paste" rows="3" spellcheck="false" autocomplete="off" aria-label="Paste a contact card" placeholder="Paste their card here: a meshcore://… link (an email or chat message holding one is fine)"></textarea>
        <div class="hc-sh-row hc-sh-tools">
          <button class="btn small" data-sh="scan"${why ? ` disabled title="${esc(why)}"` : ' title="Read their QR code with this device\'s camera"'}>📷 Scan QR</button>
          <button class="btn small" data-sh="image" title="A photo or screenshot of their QR code">🖼️ From image</button>
          <button class="btn small" data-sh="file" title="A .txt file holding their meshcore:// link (4 kB at most)">📄 From file</button>
          <button class="btn ghost small" data-sh="clear" title="Empty the box">✕ Clear</button>
          <input type="file" accept=".txt,text/plain" data-sh="filein" hidden>
        </div>
        ${why ? `<p class="hc-sh-note hc-sh-cam">📷 ${esc(why)} 🖼️ From image works anywhere.</p>` : ''}
        <p class="hc-sh-msg" data-sh="in-msg" aria-live="polite"></p>
        <div data-sh="prev"></div>
      </section>
    </div>`;
    const paste = q('[data-sh="paste"]'), fileIn = q('[data-sh="filein"]');

    // ------------------------------------------------------------ export
    async function getCard() {
      if (getting || busyOp('myCard')) return card;
      getting = true; const seq = ++cardSeq; sync();
      q('[data-sh="get-msg"]').textContent = 'Asking your node for its card…';
      let r;
      try { r = await c.svc.myCard(); } catch (e) { r = HC.fail('error', e && e.message); }
      if (dead || seq !== cardSeq) return null;
      getting = false;
      if (r && r.ok && r.value && r.value.link) { card = r.value; cardErr = null; } else { card = null; cardErr = r || HC.fail('error'); }
      buildOut(); sync();
      return card;
    }
    function buildOut() {
      const out = q('[data-sh="out"]'), msg = q('[data-sh="get-msg"]');
      if (!card) { out.innerHTML = ''; msg.textContent = cardErr ? `⚠️ ${cardErr.error}` : ''; msg.className = `hc-sh-msg${cardErr ? ' bad' : ''}`; return; }
      msg.textContent = ''; msg.className = 'hc-sh-msg';
      const call = HC.normCall(card.call) || HC.callFromName(card.name);
      out.innerHTML = `<div class="hc-sh-who">
          <span class="hc-sh-call">${esc(call || 'no callsign')}</span>
          <span class="hc-sh-name">${esc(card.name || '(no name)')}</span>
          <span class="tag">${esc(typeName(card.type))}</span>${shortKey(card.key)}</div>
        <div class="hc-sh-share">
          <div class="hc-sh-qrbox"><canvas class="hc-sh-qr" data-sh="qr" width="240" height="240" aria-label="QR code of your contact card"></canvas>
            <button class="btn ghost small" data-sh="bigqr" title="Show it big, for someone to scan">🔍 Bigger</button></div>
          <div class="hc-sh-linkbox">
            <label class="fld"><span>Signed link (paste it into the MeshCore app, or send it to them)</span>
              <textarea readonly class="hc-sh-link" data-sh="link" rows="4" spellcheck="false"></textarea></label>
            <div class="hc-sh-row"><button class="btn small" data-sh="copy">📋 Copy</button><button class="btn small" data-sh="dl">💾 Download .txt</button><span class="hc-sh-msg" data-sh="copy-msg" aria-live="polite"></span></div>
            <p class="hc-sh-note">The QR is the MeshCore app's own form: scan it with the app's "Add contact" or with Kelly. Fingerprint <code class="hc-sh-fp">${esc(fp(card.key))}</code></p>
          </div></div>`;
      q('[data-sh="link"]').value = card.link;
      const cv = q('[data-sh="qr"]');
      if (Q) Q.draw(cv, card.qr, 240).catch(e => { if (!dead) { cv.hidden = true; q('[data-sh="copy-msg"]').textContent = `⚠️ No QR: ${e.message}`; } });
      else cv.hidden = true;
    }
    async function copyLink() {   // KellyMeshQR.copy gives up on the async clipboard after 1.5 s, then tries execCommand
      const ta = q('[data-sh="link"]'), m = q('[data-sh="copy-msg"]'); if (!ta || !card) return;
      let done = false;
      try { done = Q ? await Q.copy(card.link) : false; } catch { done = false; }
      if (dead) return;
      if (!done) { try { ta.focus(); ta.select(); } catch { /* */ } }
      if (done) handOut('copy');
      if (m) { m.textContent = done ? '✅ Copied.' : 'Select the link and copy it by hand (this browser would not let Kelly).'; m.className = `hc-sh-msg${done ? ' ok' : ' bad'}`; }
    }
    function download() {
      if (!card) return;
      const m = q('[data-sh="copy-msg"]');
      try {
        const who = (HC.normCall(card.call) || HC.callFromName(card.name) || card.key.slice(0, 8)).replace(/[^A-Za-z0-9_-]/g, '');
        const url = URL.createObjectURL(new Blob([`${card.link}\n`], { type: 'text/plain' }));
        const a = document.createElement('a'); a.href = url; a.download = `meshcore-contact-${who}.txt`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        handOut('download');
        if (m) { m.textContent = '✅ Saved as a .txt file.'; m.className = 'hc-sh-msg ok'; }
      } catch (e) { if (m) { m.textContent = `⚠️ Could not save the file: ${e.message}`; m.className = 'hc-sh-msg bad'; } }
    }
    function bigQr() {
      const u = qr(); if (!u || !card) return;
      try { u.show({ title: `🪪 ${HC.label(card.name, card.call)}`, contact: { key: card.key, type: card.type, name: card.name }, advert: async () => card.link }); handOut('qr'); } catch (e) { console.warn('Ham Contacts share', e); }
    }

    // ------------------------------------------------------------ import
    function setText(t, how) { paste.value = String(t == null ? '' : t); inMsg = null; src = how || 'paste'; doParse(); }
    function doParse() {
      const t = paste.value;
      prevSeq++; addRes = null; more = [];
      if (!t.trim()) { parsed = null; parseErr = null; }
      else {
        try { parsed = parseOne(t); parseErr = null; } catch (e) { parsed = null; parseErr = cap(e && e.message || 'That is not a contact card'); }
        // S6: every other card in the text, one Add each (the same key as the main one, or a repeat, is dropped)
        if (parsed && parsed.more && parsed.more.length) {
          const keys = new Set([parsed.key]);
          for (const l of parsed.more.slice(0, 20)) {
            let x = null; try { x = parseOne(l); } catch (e) { more.push({ err: cap(e.message) }); continue; }
            if (keys.has(x.key)) continue; keys.add(x.key); more.push({ card: x, res: null, busy: false });
          }
        }
      }
      buildPrev(); sync();
    }
    function readFile(f) {
      if (!f) return;
      const bad = s => { inMsg = { bad: true, text: s }; parsed = null; parseErr = null; buildPrev(); sync(); };
      if (!/\.txt$/i.test(f.name || '') && !/^text\//.test(f.type || '')) return bad(`"${f.name}" is not a .txt file. A contact card file is plain text holding one meshcore:// link. Nothing was added.`);
      if (f.size > HC.CARD_MAX_TEXT) return bad(`"${f.name}" is ${(f.size / 1024).toFixed(1)} kB -- far too big for a contact card (4 kB at most; a card is a few hundred bytes). Nothing was added.`);
      const rd = new FileReader();
      rd.onload = () => { if (!dead) { paste.value = String(rd.result || ''); inMsg = { text: `📄 Read "${f.name}".` }; src = 'file'; doParse(); } };
      rd.onerror = () => { if (!dead) bad(`Could not read "${f.name}".`); };
      try { rd.readAsText(f); } catch (e) { bad(`Could not read "${f.name}": ${e.message}`); }
    }
    function callNow() {
      if (!parsed) return null;
      if (parsed.call) return { call: parsed.call, src: 'its name' };
      const HCalls = H();
      try { const r = HCalls && HCalls.callOf ? HCalls.callOf(parsed.key, parsed.name) : null; if (r && r.call) return { call: r.call, src: r.src === 'mine' ? 'saved by you' : r.src === 'dir' ? 'the ham directory' : 'its name' }; } catch { /* no registry */ }
      return null;
    }
    const warnList = p => (p.warnings || []).filter(w => w.code !== 'type-assumed' && w.code !== 'links-ignored');
    function moreHtml() {
      if (!more.length) return '';
      const n = more.filter(m => m.card).length, bad = more.length - n;
      return `<div class="hc-sh-more"><p class="hc-sh-note">📇 ${n ? `${n} more card${n === 1 ? '' : 's'} in that text${bad ? ` (and ${bad} that could not be read)` : ''}:` : `${bad} more link${bad === 1 ? '' : 's'} in that text could not be read.`}</p>
        <ul class="hc-sh-morelist">${more.map((m, i) => m.card ? (() => {
          const x = m.card, tr = trustOf(x), conflict = tr && tr.code === 'conflict';
          return `<li data-i="${i}"><span class="hc-sh-mwho">${tr && tr.icon ? `<span title="${esc(tr.text)}">${esc(tr.icon)}</span> ` : ''}<b>${esc(x.name || '(no name)')}</b> <span class="dim">${esc(typeName(x.type))} · <code>${esc(fp(x.key))}</code> · ${x.verified ? '✅ signed' : '⚠️ unsigned'}</span></span>
            <button class="btn small${conflict ? ' danger' : ''}" data-sh="more-add" data-i="${i}"${m.busy ? ' disabled' : ''}>${m.busy ? '⏳' : conflict ? '⛔ Add anyway' : 'Add'}</button><span class="hc-sh-msg" data-sh="more-msg" data-i="${i}"></span></li>`;
        })() : `<li class="dim">⚠️ ${esc(m.err)}</li>`).join('')}</ul></div>`;
    }
    function buildPrev() {
      const box = q('[data-sh="prev"]'), m = q('[data-sh="in-msg"]');
      m.textContent = inMsg ? inMsg.text : ''; m.className = `hc-sh-msg${inMsg && inMsg.bad ? ' bad' : ''}`;
      if (parseErr) { box.innerHTML = `<div class="hc-sh-err" role="alert">⚠️ ${esc(parseErr)} Nothing was added.</div>`; return; }
      if (!parsed) { box.innerHTML = ''; return; }
      const p = parsed, offerCall = !p.call && !!H() && typeof H().set === 'function';
      const pos = p.lat != null && p.lon != null ? `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` : null;
      const assumed = (p.warnings || []).some(w => w.code === 'type-assumed');
      const warns = warnList(p);
      box.innerHTML = `<div class="hc-sh-prev">
        <div class="hc-sh-who"><span class="hc-sh-call" data-sh="pcall"></span><span class="hc-sh-name">${esc(p.name || '(no name)')}</span></div>
        <dl class="hc-sh-dl">
          <dt>Type</dt><dd>${esc(typeName(p.type))}${assumed ? ' <span class="dim">(assumed: the card gave no type)</span>' : ''}</dd>
          <dt>Key</dt><dd>${keyHtml(p.key)}</dd>
          <dt>Card</dt><dd>${p.verified ? '<span class="hc-sh-ok">✅ name and position signed by this radio (callsign not checked)</span>' : '<span class="hc-sh-warn">⚠️ unsigned app QR -- check the key with its owner</span>'}</dd>
          ${pos ? `<dt>Position</dt><dd>${esc(pos)}</dd>` : ''}
          <dt>Callsign</dt><dd><span data-sh="pcallsrc"></span><span class="hc-sh-info" data-sh="pinfo"></span></dd>
          <dt>My radio</dt><dd data-sh="onradio"></dd>
        </dl>
        ${warns.length ? `<ul class="hc-sh-warns">${warns.map(w => `<li>${esc(w.msg)}</li>`).join('')}</ul>` : ''}
        ${offerCall ? `<div class="hc-sh-row hc-sh-callrow"><label class="fld inline"><span>Their callsign</span><input data-sh="callin" maxlength="10" placeholder="VK4XYZ" autocomplete="off" spellcheck="false"></label>
          <button class="btn small" data-sh="callsave">Save callsign</button><span class="hc-sh-msg" data-sh="call-msg"></span></div>` : ''}
        <div class="hc-sh-row"><button class="btn primary" data-sh="add">➕ Add to my radio</button></div>
        <p class="hc-sh-msg" data-sh="add-msg" aria-live="polite"></p>
        <p class="hc-sh-note">🤝 Ask them to add <b>your</b> card the same way: messages, pings and traces only work once both radios have each other.</p>
        ${moreHtml()}
      </div>`;
      if (offerCall) { const cn = callNow(); if (cn) q('[data-sh="callin"]').value = cn.call; }
    }
    // a conflict (the directory gives THIS key another call) is a deliberate second step
    async function conflictOk(p, tr) {
      if (!tr || tr.code !== 'conflict') return true;
      const u = qr(); if (!u) return false;
      return u.confirm({ title: '⛔ Not the callsign it claims', html: `<p class="small">${esc(tr.text)}</p><p class="small">Add <b>${esc(p.name || '(no name)')}</b> anyway, as a station that is <b>not</b> ${esc(p.call || '')}?</p>`, ok: 'Add anyway', danger: true });
    }
    async function addIt() {
      if (!parsed || adding || busyOp('add')) return;
      const seq = prevSeq, p = parsed, how = src;
      if (!(await conflictOk(p, trustOf(p))) || dead || seq !== prevSeq) return;
      adding = true; addRes = null; sync();
      const am = q('[data-sh="add-msg"]'); if (am) { am.textContent = 'Adding…'; am.className = 'hc-sh-msg'; }
      let r;
      try { r = await c.svc.add(p); } catch (e) { r = HC.fail('error', e && e.message); }
      adding = false;
      if (dead) return;
      added(p, r, how);
      if (seq === prevSeq) addRes = r || HC.fail('error');
      sync();
    }
    // after a card was added: an unsigned name is a claim; a card we read in (camera / picture / Scan) counts for Calling Card
    function added(p, r, how) {
      if (!r || !r.ok || (r.value && r.value.already)) return;
      claim(p);
      if (how === 'scan' || how === 'image' || how === 'import' || how === 'swap') handOut('scan', { key: p.key });
    }
    async function addMore(i) {
      const m = more[i]; if (!m || !m.card || m.busy) return;
      if (!(await conflictOk(m.card, trustOf(m.card))) || dead) return;
      m.busy = true; sync();
      let r; try { r = await c.svc.add(m.card); } catch (e) { r = HC.fail('error', e && e.message); }
      m.busy = false; m.res = r; if (dead) return;
      added(m.card, r, src);
      sync();
    }
    function resultLine(r) {
      if (!r) return { text: '', cls: '' };
      if (r.ok) return r.value && r.value.already ? { text: `✅ ${r.msg || 'Already on your radio.'}`, cls: 'ok' } : { text: `✅ ${r.msg || 'Added.'}`, cls: 'ok' };
      const icon = { full: '⛔', offline: '🔌', timeout: '⏱️', refused: '⚠️', busy: '⏳', invalid: '⚠️' }[r.code] || '⚠️';
      const extra = r.code === 'timeout' || r.code === 'busy' ? ' Try again.' : r.code === 'offline' ? ' Connect your node (or press 🎲 Demo) and try again.' : '';
      return { text: `${icon} ${r.error || 'Something went wrong.'}${extra}`, cls: 'bad' };
    }
    function saveCall() {
      const inp = q('[data-sh="callin"]'), m = q('[data-sh="call-msg"]'); if (!inp || !parsed) return;
      const call = HC.normCall(inp.value);
      if (!call) { m.textContent = '⚠️ That is not a callsign (like VK4XYZ).'; m.className = 'hc-sh-msg bad'; return; }
      try { H().set(parsed.key, call, parsed.name); inp.value = call; m.textContent = `✅ Saved: ${call}.`; m.className = 'hc-sh-msg ok'; }
      catch (e) { m.textContent = `⚠️ ${e.message}`; m.className = 'hc-sh-msg bad'; }
      sync();
    }

    // ------------------------------------------------------------ 🤝 swap (in person)
    async function openSwap() {
      if (swap) return;
      const box = q('[data-sh="swapbox"]');
      if (!card) { box.innerHTML = '<p class="hc-sh-msg">Getting your card first…</p>'; await getCard(); if (dead) return; }
      if (!card) { box.innerHTML = ''; return; }
      swap = { at: Date.now(), key: null, card: null, added: false, res: null, dm: null, msg: null, theyHave: false, listen: false, offers: new Map(), gone: new Set(), busy: false, why: null };
      box.innerHTML = `<div class="hc-sh-swap" role="region" aria-label="Swap contact cards in person">
        <div class="hc-sh-row"><b class="hc-sh-h">🤝 Swap in person</b><span class="grow"></span><button class="btn ghost small" data-sh="swapdone">✕ Done</button></div>
        <ol class="hc-sh-steps">
          <li>They scan this with Kelly or the MeshCore app:</li>
        </ol>
        <div class="hc-sh-swapqr"><canvas class="hc-sh-qr big" data-sh="swapqr" width="300" height="300" aria-label="QR code of your contact"></canvas>
          <p class="hc-sh-note">Read this aloud so they can check it on their screen: <code class="hc-sh-fp big">${esc(fp(card.key))}</code></p></div>
        <div data-sh="swaplive"></div></div>`;
      const cv = q('[data-sh="swapqr"]');
      if (Q) Q.draw(cv, card.qr, 300).catch(e => { if (!dead) { cv.hidden = true; swap && (swap.why = `No QR: ${e.message}`); renderSwap(); } });
      handOut('qr');
      renderSwap();
    }
    function closeSwap() { swap = null; clearTimeout(dmTimer); dmTimer = null; const b = q('[data-sh="swapbox"]'); if (b) b.innerHTML = ''; }
    function renderSwap() {
      if (!swap || dead) return;
      const live = q('[data-sh="swaplive"]'); if (!live) return;
      const s = swap, dmIn = q('[data-sh="dmtext"]'), typed = dmIn ? dmIn.value : null;
      const them = s.card ? HC.label(s.card.name, s.card.call) : '';
      const dmState = s.dm === 'sending' ? '⏳ Sending…' : s.dm === 'sent' ? '📡 Sent -- waiting for their node to ACK it…' : s.dm === 'acked' ? '✅ Their node ACKed it: they have you.'
        : s.dm === 'chat' ? '💬 Sent from the chat: when it shows ✓✓ there, they have you.' : s.dm === 'noack' ? '⚠️ No ACK yet: ask them to add your card, then send it again.' : s.dm === 'failed' ? `⚠️ ${s.dmWhy || 'It did not go out.'}` : '';
      const offers = [...s.offers.values()].filter(o => !s.gone.has(o.key));
      live.innerHTML = `${s.why ? `<p class="hc-sh-msg bad">⚠️ ${esc(s.why)}</p>` : ''}
        <ol class="hc-sh-steps" start="2"><li>Now scan theirs:
          <span class="hc-sh-row"><button class="btn primary small" data-sh="swapscan"${why ? ` disabled title="${esc(why)}"` : ''}>📷 Scan theirs</button><button class="btn small" data-sh="swapimage">🖼️ From image</button></span></li>
          ${s.added ? `<li>Check it worked both ways: send them a message (it goes direct, zero-hop):
            <span class="hc-sh-row"><input class="hc-sh-dmtext" data-sh="dmtext" maxlength="100" aria-label="The message to send"><button class="btn small" data-sh="swapdm"${s.dm === 'sending' || s.dm === 'sent' ? ' disabled' : ''}>💬 Send</button></span>
            <span class="hc-sh-msg" data-sh="dmstate">${esc(dmState)}</span>${s.dm === 'chat' && !s.theyHave ? ' <button class="btn ghost small" data-sh="swapticked">It shows ✓✓</button>' : ''}</li>` : ''}
        </ol>
        ${s.res && !s.res.ok ? `<p class="hc-sh-msg bad">${esc(resultLine(s.res).text)}</p>` : ''}
        <ul class="hc-sh-check" aria-label="Swap checklist">
          <li class="${s.added ? 'ok' : ''}">${s.added ? '✅' : '⬜'} I have them${them ? ` (${esc(them)})` : ''}</li>
          <li class="${s.theyHave ? 'ok' : ''}">${s.theyHave ? '✅' : '⬜'} they have me (their node ACKed)</li></ul>
        <label class="hc-sh-opt"><input type="checkbox" data-sh="swaplisten"${s.listen ? ' checked' : ''}> They can't scan? Offer stations whose advert I hear direct while this is open (❔ anyone nearby can advertise -- check the name with them)</label>
        ${s.listen ? `<ul class="hc-sh-offers">${offers.length ? offers.map(o => `<li data-k="${esc(o.key)}">❔ <b>${esc(o.label || o.name || o.key.slice(0, 8))}</b> <span class="dim">${esc(typeName(o.type))} · <code>${esc(fp(o.key))}</code> · heard direct</span>
            <button class="btn small" data-sh="offeradd" data-k="${esc(o.key)}"${o.busy ? ' disabled' : ''}>${o.busy ? '⏳' : 'Add'}</button><button class="btn ghost small" data-sh="offerno" data-k="${esc(o.key)}" title="Not them">✕</button>${o.res ? ` <span class="hc-sh-msg ${resultLine(o.res).cls}">${esc(resultLine(o.res).text)}</span>` : ''}</li>`).join('')
            : '<li class="dim">Nothing heard yet: ask them to send a zero-hop advert (Advert, local).</li>'}</ul>` : ''}`;
      const di = q('[data-sh="dmtext"]'); if (di) di.value = typed != null ? typed : `73 de ${myCall() || 'Kelly'}, QR swap`;
    }
    function swapScan(fromPic) {
      const u = qr(); if (!u || !swap) return;
      const opts = { accept: ['contact', 'advert'], check: parseOne, title: '📷 Scan their QR', hint: 'Their Ham Contacts > Swap QR, or the MeshCore app\'s "Share contact" QR.' };
      const got = (t, p) => { if (!dead && swap) swapGot(p || (() => { try { return parseOne(t); } catch { return null; } })()); };
      if (fromPic) u.fromImage(got, opts); else u.scan(got, opts);
    }
    async function swapGot(p) {
      if (!p || !swap) return;
      const u = qr(), s = st(), rec = getRec(p.key), tr = trustOf(p), rl = radioLine(p);
      const extra = { status: rl.text.replace(/^✅ /, ''), trust: tr ? tr.text : null, warn: tr && tr.info ? tr.info.replace(/^ℹ️ /, '') : null, self: !!(s.me && s.me.key === p.key) };
      const room = (() => { try { return c.svc.room(1); } catch { return null; } })();
      if (!rl.on && room && room.warn) extra.warn = [extra.warn, room.warn].filter(Boolean).join(' ');
      if (tr && tr.code === 'conflict') { extra.ok = 'Add anyway'; extra.danger = true; }
      const yes = u ? await u.confirmCard(p, extra) : true;
      if (!yes || dead || !swap) return;
      swap.card = p; swap.key = p.key; swap.busy = true; swap.res = null; renderSwap();
      let r;
      if (rec && rec.onRadio) r = HC.ok({ key: p.key, already: true }, 'Already on your radio.');
      else { try { r = await c.svc.add(p, { direct: true }); } catch (e) { r = HC.fail('error', e && e.message); } }
      if (dead || !swap) return;
      swap.busy = false; swap.res = r;
      if (r && r.ok) { swap.added = true; added(p, r, 'swap'); }
      renderSwap(); sync();
    }
    async function swapDm() {
      if (!swap || !swap.key || !c.sendDm) { if (swap) { swap.dm = 'failed'; swap.dmWhy = 'This Kelly cannot send that message.'; renderSwap(); } return; }
      const inp = q('[data-sh="dmtext"]'), text = (inp && inp.value.trim()) || `73 de ${myCall() || 'Kelly'}, QR swap`, s = swap;
      s.dm = 'sending'; s.dmText = text; renderSwap();
      let r; try { r = await c.sendDm(s.key, text); } catch (e) { r = { ok: false, reason: e && e.message }; }
      if (dead || swap !== s) return;
      if (!r || !r.ok) { s.dm = 'failed'; s.dmWhy = (r && r.reason) || 'It did not go out.'; }
      else if (r.chat) s.dm = 'chat';
      else if (r.demo) s.dm = s.theyHave ? 'acked' : 'sent';
      else if (r.msg) { s.dm = 'sent'; s.msg = r.msg; watchAck(s, 0); }
      if (s.theyHave) s.dm = 'acked';
      renderSwap();
    }
    // mesh.js updates msg.state when the ACK comes back: look once a second for 2 minutes at most, only while the swap is open
    function watchAck(s, n) {
      clearTimeout(dmTimer); dmTimer = null;
      if (dead || swap !== s || !s.msg) return;
      const v = s.msg.state;
      if (v === 'delivered') { s.theyHave = true; s.dm = 'acked'; return renderSwap(); }
      if (v === 'failed' || v === 'noack' || n >= 120) { s.dm = v === 'failed' ? 'failed' : 'noack'; if (v === 'failed') s.dmWhy = s.msg.err || 'It did not go out.'; return renderSwap(); }
      dmTimer = setTimeout(() => watchAck(s, n + 1), 1000);
    }
    // opt-in: a NEW zero-hop advert heard while the swap is open (never added by itself)
    function swapHeard(list) {
      if (!swap || !swap.listen || !Array.isArray(list)) return;
      let any = false;
      for (const r of list) {
        if (!r || !r.key || r.src !== 'advert' || r.hops !== 0 || (r.lastHeard || 0) < swap.at || swap.offers.has(r.key)) continue;
        swap.offers.set(r.key, { key: r.key, name: r.name, label: r.label, type: r.type, busy: false, res: null }); any = true;
      }
      if (any) renderSwap();
    }
    async function offerAdd(key) {
      const s = swap, o = s && s.offers.get(key); if (!o || o.busy) return;
      o.busy = true; renderSwap();
      let r; try { r = await c.svc.add(key, { direct: true }); } catch (e) { r = HC.fail('error', e && e.message); }
      if (dead || swap !== s) return;
      o.busy = false; o.res = r;
      if (r && r.ok) { s.added = true; s.key = key; s.card = { key, name: o.name, call: HC.callFromName(o.name), type: o.type }; }
      renderSwap();
    }

    // ------------------------------------------------------------ live bits (cheap; no rebuilds, so typed text stays)
    function sync() {
      if (dead) return;
      const s = st(), gb = q('[data-sh="get"]');
      if (gb) { gb.disabled = getting || busyOp('myCard'); gb.textContent = getting ? '⏳ Getting…' : card ? '⟳ Get it again' : '🪪 Get my card'; }
      const sb = q('[data-sh="swap"]'); if (sb) sb.disabled = !!swap || getting || !(s.link && s.link.online);
      if (!card && !cardErr && !getting) { const gm = q('[data-sh="get-msg"]'); if (gm) gm.textContent = s.link && s.link.online ? '' : 'Connect your node (or press 🎲 Demo) first.'; }
      more.forEach((m, i) => {
        const el = mount.querySelector(`[data-sh="more-msg"][data-i="${i}"]`), b = mount.querySelector(`[data-sh="more-add"][data-i="${i}"]`);
        const rec = m.card ? getRec(m.card.key) : null;
        if (b) { b.disabled = m.busy || !!(rec && rec.onRadio); if (rec && rec.onRadio) b.textContent = '✅ On your radio'; else if (m.busy) b.textContent = '⏳'; }
        if (el) { const l = resultLine(m.res); el.textContent = l.text; el.className = `hc-sh-msg ${l.cls}`; }
      });
      if (!parsed) return;
      const rl = radioLine(parsed), tr = trustOf(parsed);
      const or = q('[data-sh="onradio"]');
      if (or) { or.textContent = rl.text; or.className = rl.cls ? `hc-sh-${rl.cls}` : ''; }
      const cn = callNow(), pc = q('[data-sh="pcall"]'), ps = q('[data-sh="pcallsrc"]'), pi = q('[data-sh="pinfo"]');
      if (pc) pc.textContent = cn ? `${tr && tr.icon && tr.code !== 'none' ? `${tr.icon} ` : ''}${cn.call}` : 'no callsign';
      if (ps) ps.textContent = cn ? (tr && tr.code !== 'none' && tr.text ? tr.text : `${cn.call} (from ${cn.src})`) : 'none in its name';
      if (pi) pi.textContent = tr && tr.info ? ` ${tr.info}` : '';
      const ab = q('[data-sh="add"]');
      if (ab) {
        ab.disabled = adding || busyOp('add') || !!rl.mine || !!rl.on;
        ab.className = `btn ${tr && tr.code === 'conflict' && !rl.on ? 'danger' : 'primary'}`;
        ab.textContent = adding ? '⏳ Adding…' : rl.on ? '✅ On your radio' : tr && tr.code === 'conflict' ? `⛔ Add anyway (not ${parsed.call || 'that call'})` : '➕ Add to my radio';
      }
      const am = q('[data-sh="add-msg"]');
      if (am && !adding) {
        const l = resultLine(addRes), room = !addRes && !rl.on && !rl.mine ? (() => { try { return c.svc.room(1); } catch { return null; } })() : null;
        am.textContent = l.text || (room && room.warn ? `⚠️ ${room.warn}` : ''); am.className = `hc-sh-msg ${l.cls || (room && room.warn ? 'bad' : '')}`;
      }
    }
    // event-driven refresh: only while visible, at most once a second
    function later() {
      if (dead) return;
      if (!c.visible()) { dirty = true; return; }
      if (timer) return;
      const wait = Math.max(0, 1000 - (Date.now() - lastDraw));
      timer = setTimeout(() => { timer = null; if (dead) return; if (!c.visible()) { dirty = true; return; } lastDraw = Date.now(); dirty = false; try { sync(); } catch (e) { console.warn('Ham Contacts share', e); } }, wait);
    }
    const on = (ev, fn) => offs.push(c.bus.on(ev, p => { try { fn(p); } catch (e) { console.warn('Ham Contacts share', ev, e); } }));
    on('op', e => { if (e && (e.op === 'add' || e.op === 'myCard')) { const gb = q('[data-sh="get"]'), ab = q('[data-sh="add"]'); if (gb && e.op === 'myCard') gb.disabled = e.phase === 'start' || getting; if (ab && e.op === 'add' && e.phase === 'start') ab.disabled = true; } later(); });
    ['state', 'contacts', 'heard', 'calls', 'dir'].forEach(ev => on(ev, later));
    on('heard', swapHeard);
    // the demo world's scripted answer (and any other two-way proof the shell passes on) for the station we swapped with
    on('mutual', p => { if (swap && p && p.key && String(p.key).toLowerCase() === swap.key) { swap.theyHave = true; if (swap.dm) swap.dm = 'acked'; renderSwap(); } });
    on('visible', v => { if (v && dirty) later(); if (!v && qrUi) { try { qrUi.close(); } catch { /* gone */ } } });
    on('demo', () => { cardSeq++; getting = false; card = null; cardErr = null; closeSwap(); buildOut(); if (paste.value.trim()) doParse(); else sync(); });

    // ------------------------------------------------------------ clicks
    const readIn = how => (t, p) => { if (dead) return; inMsg = { text: how === 'scan' ? '📷 Read a QR code.' : '🖼️ Read a QR code from the picture.' }; paste.value = t; src = how; doParse(); void p; };
    const inOpts = () => ({ accept: ['contact', 'advert'], check: parseOne });
    const onClick = e => {
      const b = e.target.closest('[data-sh]'); if (!b || b.disabled) return;
      try {
        switch (b.dataset.sh) {
          case 'get': getCard(); break;
          case 'copy': copyLink(); break;
          case 'dl': download(); break;
          case 'bigqr': bigQr(); break;
          case 'scan': { const u = qr(); if (!u) { inMsg = { bad: true, text: 'The QR reader did not load.' }; buildPrev(); break; } u.scan(readIn('scan'), inOpts()); break; }
          case 'image': { const u = qr(); if (!u) { inMsg = { bad: true, text: 'The QR reader did not load.' }; buildPrev(); break; } u.fromImage(readIn('image'), inOpts()); break; }
          case 'file': fileIn.value = ''; fileIn.click(); break;
          case 'clear': setText(''); break;
          case 'add': addIt(); break;
          case 'more-add': addMore(Number(b.dataset.i)); break;
          case 'callsave': saveCall(); break;
          case 'swap': openSwap(); break;
          case 'swapdone': closeSwap(); sync(); break;
          case 'swapscan': swapScan(false); break;
          case 'swapimage': swapScan(true); break;
          case 'swapdm': swapDm(); break;
          case 'swapticked': if (swap) { swap.theyHave = true; renderSwap(); } break;
          case 'offeradd': offerAdd(b.dataset.k); break;
          case 'offerno': if (swap) { swap.gone.add(b.dataset.k); renderSwap(); } break;
          default: break;
        }
      } catch (err) { console.warn('Ham Contacts share', err); }
    };
    const onInput = e => { if (e.target === paste) { inMsg = null; src = 'paste'; doParse(); } };
    const onChange = e => {
      if (e.target && e.target.dataset && e.target.dataset.sh === 'swaplisten' && swap) {
        swap.listen = !!e.target.checked;
        if (swap.listen) { try { swapHeard(c.svc.heard()); } catch { /* */ } }
        renderSwap();
      }
    };
    const onKey = e => { if (e.target && e.target.dataset && e.target.dataset.sh === 'callin' && e.key === 'Enter') saveCall(); };
    const onFile = () => readFile(fileIn.files && fileIn.files[0]);
    mount.addEventListener('click', onClick);
    mount.addEventListener('input', onInput);
    mount.addEventListener('change', onChange);
    mount.addEventListener('keydown', onKey);
    fileIn.addEventListener('change', onFile);
    sync();

    return {
      destroy() {
        dead = true; clearTimeout(timer); clearTimeout(dmTimer);
        offs.splice(0).forEach(off => { try { off(); } catch { /* gone */ } });
        mount.removeEventListener('click', onClick); mount.removeEventListener('input', onInput); mount.removeEventListener('change', onChange); mount.removeEventListener('keydown', onKey);
        if (qrUi) { try { qrUi.close(); } catch { /* gone */ } }
        mount.innerHTML = '';
      },
      // the LoRa Mesh 📷 Scan hook (window.kellyHCImport): into the box, preview shown, nothing added
      importText(text) {
        if (dead) return;
        setText(text, 'import'); inMsg = { text: '📷 Read by the LoRa Mesh Scan button -- check it, then press Add.' }; buildPrev(); sync();
        try { mount.scrollIntoView({ block: 'nearest' }); } catch { /* */ }
      },
      // tests
      _setText: setText, _file: readFile, _card: () => card, _parsed: () => parsed, _more: () => more, _swap: () => swap, _swapGot: swapGot,
    };
  };
})();
