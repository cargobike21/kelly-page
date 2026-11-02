/* Kelly Page -- 📻 Channels card (LoRa Mesh page; QR_REVIEW.md §4 items 8 + 13, review/qr-03-scan-safety.md §2 flow D,
 * 2026-10-24).
 *
 * MeshCore: the node's channel slots (meshcore.js channelSlots(): the first min(DEVICE_INFO[3], 8)), each labelled by
 * comparing its secret: 🌐 Public (MeshCore's well-known secret), #️⃣ hashtag (secret = sha256("#name")[0:16], public:
 * anyone can work it out) or 🔐 private. ▦ per channel -> meshqr.js ui().showChannel (a private channel's QR only after
 * "Show QR"; no QR for Public -- MBUG keeps traffic off it). Import = flow D: a meshcore://channel/add QR (camera,
 * picture or paste) or a typed #name -> a PREVIEW in this card (name, kind, the first 4 hex of the secret only, the
 * slot it goes to, "already have it in slot N", ⚠️ same name / different secret, region_scope shown but not applied)
 * -> ➕ Add -> setChannel (CMD_SET_CHANNEL 32). The first free slot by default; every slot full = refused; writing over
 * a slot in use only by picking it and a separate danger confirm "Replace slot N (#name)". Nothing is added without a
 * click.
 * Meshtastic: one button, ▦ SEQ Meshtastic settings (js/mtshare.js: default channel + MBUG LoRa config) -- show only,
 * Kelly can't change a Meshtastic node's channels; scanning it in the Meshtastic app REPLACES that node's channels.
 *
 * SECRETS: a channel secret lives in meshcore.js memory and, while a preview is open, in this module's closure. It never
 * goes to localStorage / statesync / the console / the gateway / awards, and never into the DOM as text (4 hex digits
 * at most). The paste box is emptied as soon as it is read; errors never echo what was pasted.
 *
 * window.KellyMeshChannels(k) -> { render, init, online, importText }; k from mesh.js: { $, esc, toast, dirty,
 *   currentPage, session, online, dev, showTab, addEvent }. Statics: KellyMeshChannels.kindOf(slot), .plan(ch, slots).
 * window.kellyChannelImport(text) -> bool: opens the card with that text in the preview (never adds by itself).
 * Tests: tests/meshchannels-tests.html (the card against the MeshCore sim).
 */
(function () {
  'use strict';
  const Q = () => window.KellyMeshQR, MT = () => window.KellyMtShare;
  const KIND = { public: '🌐 Public', hashtag: '#️⃣ hashtag (public)', private: '🔐 private' };

  // { name, secretHex } -> 'public' | 'hashtag' | 'private'
  function kindOf(c) {
    const q = Q(), s = String(c.secretHex || c.secret || '').toLowerCase();
    if (q && s === q.PUBLIC_SECRET) return 'public';
    if (q && q.hashtagSecret(c.name) === s) return 'hashtag';
    return 'private';
  }
  // a parsed channel against the node's slots -> { kind, already, clash, free, full, used }
  function plan(ch, slots) {
    const list = (slots && slots.list) || [], max = (slots && slots.max) || 0, s = String(ch.secret).toLowerCase();
    const same = list.find(c => c.secretHex === s);
    const clash = list.find(c => c.secretHex !== s && String(c.name).toLowerCase() === String(ch.name).toLowerCase());
    let free = null; for (let i = 0; i < max; i++) if (!list.some(c => c.index === i)) { free = i; break; }
    return { kind: ch.wellKnown ? 'public' : ch.hashtag ? 'hashtag' : 'private', already: same ? same.index : null, clash: clash ? { index: clash.index, name: clash.name } : null,
      free, full: max > 0 && free == null, used: list.length };
  }

  window.KellyMeshChannels = function (k) {
    const { $, esc } = k;
    const ui = { sig: '', pending: null, err: '', busy: '', hop: 5, slot: null };
    let qui = null;
    const dlg = () => qui || (qui = Q().ui({ toast: k.toast }));
    const dev = () => (k.dev ? k.dev() : 'meshcore');
    const sess = () => { const s = k.session && k.session(); return s && s.channelSlots ? s : null; };
    const slots = () => { const s = sess(); if (!s || (k.online && !k.online())) return null; try { return s.channelSlots(); } catch { return null; } };
    const redraw = () => { ui.sig = ''; if (k.dirty) k.dirty('mesh'); render(); };
    const toast = (icon, t, m, c) => { if (k.toast) k.toast(icon, t, m, c); };

    // a Parsed channel (meshqr.js) -> the preview. Only what's needed is kept; the secret stays in this closure.
    function setPending(p) {
      ui.pending = { name: p.name, secret: p.secret, regionScope: p.regionScope || null, wellKnown: !!p.wellKnown, hashtag: !!p.hashtag,
        warnings: (p.warnings || []).filter(w => w.code !== 'scope-needs-app-1.47').map(w => w.msg) };
      ui.err = ''; ui.slot = null; redraw();
    }
    const say = e => { ui.err = String((e && e.message) || e || '').replace(/ -- nothing was added$/, ''); ui.pending = null; redraw(); };
    function fromText(text) {
      try { setPending(Q().parse(String(text || ''), { accept: ['channel'] })); return true; } catch (e) { say(e); return false; }
    }
    function joinHashtag(raw) {
      let n = String(raw || '').trim(); if (!n) return say('type a channel name, like #test');
      if (!n.startsWith('#')) n = '#' + n;
      if (/\s/.test(n) || n.length < 2) return say('a hashtag channel name has no spaces, like #test');
      try { const b = Q().buildChannel({ name: n, secret: Q().hashtagSecret(n) }); setPending(Object.assign({}, b, { hashtag: true })); }
      catch (e) { say(e); }
    }
    // window.kellyChannelImport: the LoRa Mesh 📷 Scan (or anyone) hands over a channel QR's text
    function importText(text) {
      const ok = fromText(text);
      if (dev() !== 'meshcore') toast('📻', 'A MeshCore channel', 'Pick the MeshCore device and connect your node to add it.', 'warn');
      if (k.showTab) { try { k.showTab(); } catch { /* not on the page */ } }
      const box = $('#mch-card'); if (box && box.scrollIntoView) { try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* old browser */ } }
      return ok;
    }

    function previewHtml(p, sl) {
      const pl = plan(p, sl), h = [];
      h.push(`<div class="mch-pv-h"><b>${esc(p.name)}</b> <span class="mch-kind k-${pl.kind}">${KIND[pl.kind]}</span></div>`);
      h.push(`<p class="small">${pl.kind === 'private' ? '🔐 A private channel: anyone with this code can read and post on it.' : '🌐 Public: anyone can read it' + (pl.kind === 'hashtag' ? ' (its key comes from its name).' : '.')}`
        + ` Secret <code>${esc(p.secret.slice(0, 4))}…</code></p>`);
      if (p.regionScope) h.push(`<p class="small">Region scope <code>${esc(p.regionScope)}</code>: Kelly shows it but doesn't apply it (app 1.47+).</p>`);
      for (const w of p.warnings) h.push(`<p class="small dim">${esc(w)}</p>`);
      if (!sl) { h.push('<p class="small">Connect your MeshCore node to add it.</p>'); }
      else if (pl.already != null) h.push(`<p class="small">✅ You already have it in slot ${pl.already}.</p>`);
      else {
        if (pl.clash) h.push(`<p class="small mch-warn">⚠️ A different channel with the same name is in slot ${pl.clash.index} (${esc(pl.clash.name)}). This one has another key: it is not the same channel.</p>`);
        const pick = ui.slot != null ? ui.slot : pl.free;
        const opts = [];
        for (let i = 0; i < sl.max; i++) {
          const c = sl.list.find(x => x.index === i);
          if (i === 0 && c) continue;   // slot 0 (Public) is never offered for replacing
          opts.push(`<option value="${i}"${i === pick ? ' selected' : ''}>Slot ${i} · ${c ? `replace ${esc(c.name)}` : 'free'}</option>`);
        }
        if (pl.full && pick == null) opts.unshift('<option value="" selected>-- all slots in use --</option>');
        h.push(`<div class="row gap wrap mch-pv-act"><label class="fld"><span>Slot</span><select id="mch-slot">${opts.join('')}</select></label>`
          + `<button class="btn primary" id="mch-add"${pick == null || ui.busy ? ' disabled' : ''}>➕ Add to my node</button><button class="btn ghost" id="mch-cancel">Cancel</button></div>`);
        if (pl.full && pick == null) h.push(`<p class="small mch-warn">⛔ All ${sl.max} channel slots are in use: not added. Remove one in the MeshCore app, or pick a slot above to replace it on purpose.</p>`);
      }
      if (!sl || pl.already != null) h.push('<div class="row gap mch-pv-act"><button class="btn ghost" id="mch-cancel">Close</button></div>');
      return `<div class="mch-pv" role="group" aria-label="Channel to add">${h.join('')}</div>`;
    }

    function render() {
      const box = $('#mch-card'); if (!box) return;
      const d = dev(), on = d === 'meshcore' || d === 'meshtastic';
      box.hidden = !on; if (!on || (k.currentPage && k.currentPage() !== 'mesh')) return;
      const sl = d === 'meshcore' ? slots() : null;
      const sig = JSON.stringify([d, sl && sl.max, sl && sl.list.map(c => c.index + ':' + c.name + ':' + kindOf(c)), ui.pending && [ui.pending.name, ui.pending.secret.slice(0, 4)], ui.slot, ui.err, ui.busy, ui.hop]);
      if (sig === ui.sig) return; ui.sig = sig;
      const tag = $('#mch-tag'), body = $('#mch-body');
      if (d === 'meshtastic') {
        if (tag) tag.textContent = 'Meshtastic';
        body.innerHTML = '<p class="small dim">The SEQ mesh\'s Meshtastic settings, as MBUG asks: Medium Fast, frequency slot 45, region ANZ, the default channel. Scan with the Meshtastic app; Kelly can\'t change a Meshtastic node\'s channels.</p>'
          + `<div class="row gap wrap"><label class="fld"><span>Hop limit</span><select id="mch-hop"><option value="5"${ui.hop === 5 ? ' selected' : ''}>5 · city / central</option><option value="7"${ui.hop === 7 ? ' selected' : ''}>7 · Ipswich, coasts, NSW</option></select></label>`
          + '<button class="btn primary" id="mch-seq">▦ SEQ Meshtastic settings</button></div>';
        return;
      }
      if (tag) tag.textContent = sl ? `${sl.list.length} of ${sl.max} slots` : 'not connected';
      let h = '';
      if (!sl) h += '<p class="small dim">Connect your MeshCore node to see its channels.</p>';
      else {
        h += '<ul class="mch-list">' + sl.list.map(c => {
          const kd = kindOf(c);
          return `<li class="mch-row"><span class="mch-slot">${c.index}</span><b class="mch-name">${esc(c.name)}</b><span class="mch-kind k-${kd}">${KIND[kd]}</span>`
            + (kd === 'public' ? '' : `<button class="btn small ghost" data-mch-qr="${c.index}" title="${kd === 'private' ? 'QR of this channel -- it IS the key' : 'QR of this channel'}">▦</button>`) + '</li>';
        }).join('') + '</ul>';
        if (sl.list.some(c => kindOf(c) === 'public')) h += '<p class="small dim">No QR for Public: every node has it, and MBUG keeps traffic off it.</p>';
      }
      h += '<div class="row gap wrap mch-in"><button class="btn" id="mch-scan">📷 Scan</button><button class="btn" id="mch-pic">🖼️ Picture</button>'
        + '<input id="mch-paste" class="grow" placeholder="or paste a meshcore://channel/add link" autocomplete="off" spellcheck="false" aria-label="Paste a channel link"><button class="btn" id="mch-go">Preview</button></div>'
        + '<div class="row gap wrap mch-in"><input id="mch-hash" placeholder="#test" maxlength="31" autocomplete="off" spellcheck="false" aria-label="Hashtag channel name"><button class="btn" id="mch-join">#️⃣ Join a hashtag channel</button></div>'
        + '<p class="small dim">Hashtag channels are public: the name is the key, and #Test is not #test (MBUG\'s are lower case).</p>';
      if (ui.busy) h += `<div class="rp-busy">⏳ ${esc(ui.busy)}…</div>`;
      if (ui.err) h += `<div class="rp-err">⚠️ ${esc(ui.err)}</div>`;
      if (ui.pending) h += previewHtml(ui.pending, sl);
      const keep = { hash: ($('#mch-hash') || {}).value, focus: document.activeElement && document.activeElement.id };
      body.innerHTML = h;
      if (keep.hash && $('#mch-hash')) $('#mch-hash').value = keep.hash;
      if (keep.focus && /^mch-(hash|paste)$/.test(keep.focus) && $('#' + keep.focus)) $('#' + keep.focus).focus();
    }

    async function add() {
      const p = ui.pending, s = sess(), sl = slots(); if (!p || !s || !sl || ui.busy) return;
      const pl = plan(p, sl), sel = $('#mch-slot'), idx = sel && sel.value !== '' ? +sel.value : pl.free;
      if (idx == null || pl.already != null) return;
      const used = sl.list.find(c => c.index === idx);
      if (used) {
        const yes = await dlg().confirm({ title: `Replace slot ${idx} (${used.name})?`, danger: true, ok: `Replace slot ${idx} (${used.name})`,
          html: `<p class="small">⚠️ Slot ${idx} holds <b>${esc(used.name)}</b>. Replacing it puts <b>${esc(p.name)}</b> there and your node stops hearing ${esc(used.name)} until you add it again${kindOf(used) === 'private' ? ' -- with its code, which Kelly doesn\'t keep' : ''}.</p>` });
        if (!yes || ui.pending !== p) return;
      }
      ui.busy = `Writing ${p.name} to slot ${idx}`; ui.err = ''; redraw();
      try {
        const r = await s.setChannel(idx, p.name, p.secret, { replace: !!used });
        ui.pending = null; ui.slot = null;
        toast('📻', 'Channel added', `${r.name} is in slot ${r.index}.`, 'ok');
        if (k.addEvent) k.addEvent('network', `Mesh channel ${r.name} added to slot ${r.index}`);
      } catch (e) { ui.err = `Not added: ${e.message}`; }
      finally { ui.busy = ''; redraw(); }
    }
    function showQr(idx) {
      const sl = slots(), c = sl && sl.list.find(x => x.index === idx); if (!c) return;
      if (kindOf(c) === 'public') return;
      dlg().showChannel({ title: `▦ ${c.name}`, channel: { name: c.name, secret: c.secretHex } });
    }
    function showSeq() {
      const m = MT(); if (!m) return;
      const s = m.seq({ hopLimit: ui.hop });
      dlg().showText({ title: '▦ SEQ Meshtastic settings', text: s.url,
        secret: 'Scanning this in the Meshtastic app REPLACES the channels on that node with the one default channel (Medium Fast) and retunes it to MBUG\'s settings: Medium Fast, slot 45 (926.125 MHz), ANZ, hop limit ' + ui.hop + '. Note any other channels you use (Weather, POTA ...) first, and add them again after.',
        note: `Default channel only (the well-known key), no secret. MBUG also asks: role CLIENT_MUTE to start, CLIENT or ROUTER_LATE on a roof. Source: ${m.SEQ.source}.` });
    }

    function init() {
      const box = $('#mch-card'); if (!box) return;
      box.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.mchQr != null) return showQr(+b.dataset.mchQr);
        const opts = { accept: ['channel'], title: '📷 Scan a channel QR', hint: 'A MeshCore channel QR (meshcore://channel/add). Nothing is added until you press Add.' };
        if (b.id === 'mch-scan') return dlg().scan((t, p) => setPending(p), opts);
        if (b.id === 'mch-pic') return dlg().fromImage((t, p) => setPending(p), opts);
        if (b.id === 'mch-go') { const i = $('#mch-paste'), v = i.value; i.value = ''; return fromText(v); }
        if (b.id === 'mch-join') { const i = $('#mch-hash'), v = i.value; i.value = ''; return joinHashtag(v); }
        if (b.id === 'mch-add') return add();
        if (b.id === 'mch-cancel') { ui.pending = null; ui.slot = null; ui.err = ''; return redraw(); }
        if (b.id === 'mch-seq') return showSeq();
      });
      box.addEventListener('change', e => {
        if (e.target.id === 'mch-slot') { ui.slot = e.target.value === '' ? null : +e.target.value; redraw(); }
        if (e.target.id === 'mch-hop') { ui.hop = +e.target.value === 7 ? 7 : 5; ui.sig = ''; }
      });
      box.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        if (e.target.id === 'mch-paste') { e.preventDefault(); const v = e.target.value; e.target.value = ''; fromText(v); }
        if (e.target.id === 'mch-hash') { e.preventDefault(); const v = e.target.value; e.target.value = ''; joinHashtag(v); }
      });
      // a pasted link is read at once and the box emptied, so a channel key doesn't sit on screen
      box.addEventListener('paste', e => {
        if (e.target.id !== 'mch-paste') return;
        const t = e.clipboardData && e.clipboardData.getData('text'); if (!t) return;
        e.preventDefault(); e.target.value = ''; fromText(t);
      });
    }
    // a new session: the slots are read again by meshcore.js; drop a stale slot choice
    function online() { ui.slot = null; redraw(); }

    const api = { render, init, online, importText };
    window.kellyChannelImport = text => importText(text);
    return api;
  };
  window.KellyMeshChannels.kindOf = kindOf;
  window.KellyMeshChannels.plan = plan;
})();
