/* Kelly Page -- MeshCore contact management (LoRa Mesh page; Phase 2 of docs/lora-mesh-gap-analysis.md, 2026-10-21).
 *
 * The contacts live on the companion node, not in Kelly. This card asks the node to:
 *   share   send that contact's advert ONE hop over the air (CMD_SHARE_CONTACT), so nodes beside you learn it
 *   export  a meshcore:// link holding the contact's signed advert (CMD_EXPORT_CONTACT; no contact = your own node):
 *           paste it into the MeshCore phone app, an email, the club page ... Another contact's advert is re-made
 *           WITHOUT the path it reached us by (QR_REVIEW.md C10), so it fits the importers' size limits
 *   import  a meshcore:// link (or the bare hex) back into the node (CMD_IMPORT_CONTACT) -- the advert is signed, so a
 *           link can't change someone's key. The box, the camera and a picture all go the same way (QR_REVIEW.md S1):
 *           read (js/hc-core.js parseCard checks the signature) -> the shared preview (KellyMeshQR confirmCard: new / on
 *           your radio as X / the table nearly full, re-read afresh) -> written only on "Add". An unsigned contact/add
 *           name is passed to KellyHamCalls.qrClaim (a claim, never a ham until its own advert is heard)
 *   remove  forget a contact (CMD_REMOVE_CONTACT); it comes back with its next advert if auto-add is on
 *   name    your own node's advert name (CMD_SET_ADVERT_NAME) -- put your callsign in it: the hams-only filters look
 *           for one
 *   QR      show a contact / your node as a QR code, read one from the camera or a picture (js/meshqr.js, ms.qr); the
 *           official app's contact/add form is added with ADD_UPDATE_CONTACT
 * window.KellyMeshContacts(k) -> { render, init }; k from mesh.js (the paths/repeaters modules' pattern).
 * KellyMeshContacts.bareAdvert(hex) -> { bare, key } | null (the path strip, for tests). Tests: tests/meshqr-cdp.js.
 */
(function () {
  'use strict';
  const hx = a => a.map(x => x.toString(16).padStart(2, '0')).join('');
  // a signed advert packet (hex) -> { bare: the same advert re-made with no path (flood, path_len 0), key } | null
  // (= js/hc-core.js parseAdvert's `bare`: header [route 2 bits | type << 2], transport codes on routes 0 / 3, path_len, path)
  function bareAdvert(h) {
    h = String(h || '').toLowerCase(); if (!/^([0-9a-f]{2})+$/.test(h)) return null;
    const b = h.match(/../g).map(x => parseInt(x, 16));
    if (b.length < 2 || ((b[0] >> 2) & 15) !== 4) return null;
    let o = 1 + ((b[0] & 3) === 0 || (b[0] & 3) === 3 ? 4 : 0);
    if (o >= b.length) return null;
    const pl = b[o++]; if ((pl >> 6) > 2) return null;
    o += (pl & 63) * ((pl >> 6) + 1);
    const p = b.slice(o); if (p.length < 101) return null;
    return { bare: hx([(b[0] & ~3) | 1, 0, ...p]), key: hx(p.slice(0, 32)) };
  }
  window.KellyMeshContacts = function (k) {
    const { $, esc, store, toast } = k;
    const ui = { sel: store.get('meshContactSel', ''), sig: '', msg: '', link: '' };
    const list = () => [...k.nodes()].filter(n => n.key && n.num !== k.myNum()).sort((a, b) => (a.longName || '').localeCompare(b.longName || ''));
    const current = () => { const l = list(); return l.find(n => n.key === ui.sel) || l[0] || null; };
    const redraw = () => { ui.sig = ''; k.dirty('mesh'); };
    const say = m => { ui.msg = m; redraw(); };
    async function act(fn, ok) {
      const s = k.session(); if (!s || !s.removeContact) { toast('📇', 'Connect a MeshCore node first', 'Contacts live on your companion node.', 'warn'); return; }
      try { const v = await fn(s); if (ok) say(ok(v)); return v; } catch (e) { say(`⚠️ ${e.message}`); }
    }
    // QR codes (js/meshqr.js, ms.qr): Show QR / My QR / Scan QR / From image. The dialog is made on first use.
    const QR = window.KellyMeshQR, qrOn = () => !!QR && (!k.qrOn || k.qrOn());
    let qrUi = null;
    const qr = () => qrUi || (qrUi = QR.ui({ toast }));
    // '' when the camera can run here, else why not (js/secure.js: a secure page is needed)
    const camWhy = () => window.KellySecure ? window.KellySecure.why('camera') : window.isSecureContext ? '' : 'The camera only works on a secure page (https:// or localhost).';
    const cap = m => { m = String(m || ''); return m.charAt(0).toUpperCase() + m.slice(1); };
    // signed adverts are signature-checked by js/hc-core.js parseCard (TweetNaCl) before the preview; without hc-core the
    // shared reader's shape check is all there is (the node still checks the signature itself)
    const HCx = () => (window.KellyHC && window.KellyHC.parseCard ? window.KellyHC : null);
    const edOf = () => { try { return window.nacl && HCx() ? HCx().naclEd(window.nacl) : null; } catch { return null; } };
    const ACCEPT = ['contact', 'advert'];
    function readCard(text) {
      if (HCx()) return HCx().parseCard(text, { ed: edOf() });
      const p = QR.parse(text, { accept: ACCEPT });
      if (p.kind !== 'advert') return p;
      const a = bareAdvert(p.hex); if (!a) throw new Error('that contact card is cut short -- copy all of it');
      return Object.assign({}, p, { key: a.key, advert: a.bare, link: `meshcore://${a.bare}` });
    }
    // the exported advert of ANOTHER contact carries the path it reached us by (not signed): re-made without it, so the
    // link fits the importers' limits (<= 171 bytes for meshcore-open, 175 for the node). = hc-core parseAdvert's `bare`
    async function exportLink(s, node) {
      const v = await s.exportContact(node);
      if (!node) return v;
      try { const c = HCx() && edOf() ? HCx().parseCard(v, { ed: edOf() }) : null; if (c && c.advert) return `meshcore://${c.advert}`; } catch { /* the local re-make below */ }
      const a = bareAdvert(v.replace(/^meshcore:\/\//i, ''));
      return a ? `meshcore://${a.bare}` : v;
    }
    // the signed-advert QR: asked of the node when that tab is picked (node null = this node)
    const advertOf = node => async () => { const s = k.session(); if (!s || !s.exportContact) throw new Error('connect a MeshCore node first'); return exportLink(s, node); };
    // is it on the radio already (under what name), and is there room? Kelly's count can be stale (another app may have
    // changed the table), so it's read afresh near the limit; with auto-add's "overwrite oldest" on, say what goes
    async function onRadio(s, c) {
      const key = String(c.key || '').toLowerCase(), l = list(), n = l.find(x => String(x.key).toLowerCase() === key);
      let had = !!n;
      if (!had && s.hasContact) had = await s.hasContact(key).catch(() => false);
      const max = s.maxContacts ? s.maxContacts() : null, near = h => max && h + 1 >= max * 0.9;
      let have = l.length, warn = '';
      if (!had && near(have)) {
        if (s.listContacts) { try { have = (await s.listContacts()).filter(x => String(x.key).toLowerCase() !== String((k.me() || {}).key || '').toLowerCase()).length; } catch { /* the cached count */ } }
        let over = null;
        if (near(have) && s.autoAdd) { try { const a = await s.autoAdd(); over = a.bits != null ? !!(a.bits & 1) : null; } catch { /* older firmware */ } }
        if (have >= max) warn = over ? `Your node's contact table is full (${have} of ${max}): adding this pushes out your oldest non-favourite contact.` : `Your node's contact table is full (${have} of ${max}): remove a contact first, or the node will refuse this one.`;
        else if (near(have)) warn = `That brings your node to ${have + 1} of its ${max} contacts.${over ? ' Once it is full, each new contact pushes out your oldest non-favourite.' : ''}`;
      }
      const status = !had ? 'New contact: not on your radio yet.'
        : `Already on your radio${n ? ` as "${n.longName}"` : ''}. ${c.kind === 'advert' ? 'Adding it again updates it from this signed card, if the card is newer.' : 'An unsigned card never renames a contact: nothing changes.'}`;
      return { had, status, warn };
    }
    // a contact card from the box, a QR code or a picture: read (signature checked) -> preview -> only on "Add": a signed
    // advert -> IMPORT_CONTACT, the official app's contact/add (key, type, name) -> ADD_UPDATE_CONTACT. -> true if written
    async function review(text, card) {
      if (!QR) { say('⚠️ The QR reader (js/meshqr.js) did not load -- reload Kelly.'); return; }
      let c = card;
      if (!c) { try { c = readCard(text); } catch (e) { say(`⚠️ ${cap(e.message)}.`); return; } }
      const s = k.session(); if (!s || !s.removeContact) { toast('📇', 'Connect a MeshCore node first', 'Contacts live on your companion node.', 'warn'); return; }
      const me = k.me();
      if (me && me.key && String(me.key).toLowerCase() === String(c.key).toLowerCase()) { say('📇 That QR code is your own node: nothing to add.'); qr().confirmCard(c, { self: true }); return; }
      let r;
      try { r = await onRadio(s, c); } catch (e) { say(`⚠️ ${e.message}`); return; }
      const yes = await qr().confirmCard(c, { status: r.status, warn: r.warn, ok: r.had ? (c.kind === 'advert' ? 'Update from this card' : 'OK') : 'Add to my radio' });
      if (!yes) { say('Nothing was added.'); return; }
      const nm = c.name || 'the contact';
      if (c.kind === 'advert') return act(x => x.importContact(c.advert ? `meshcore://${c.advert}` : c.link), x => `📥 Added: ${(x && x.name) || nm} (a signed card).`).then(v => v !== undefined || undefined);
      const v = await act(x => x.addContact({ key: c.key, type: c.type, name: c.name }), x => x && x.already ? `📇 ${nm} is already in your contacts.` : `📥 Added: ${nm}. An unsigned app card: its name is a claim until its own advert is heard.`);
      // a QR-claimed name never counts as a ham until the node's own advert is seen (QR_REVIEW.md S2)
      if (v && !v.already && window.KellyHamCalls && window.KellyHamCalls.qrClaim) { try { window.KellyHamCalls.qrClaim(c.key, c.name); } catch { /* the claim list is optional */ } }
      return v !== undefined || undefined;
    }
    const scanOpts = title => ({ accept: ACCEPT, check: readCard, title, hint: 'A MeshCore contact QR: the app\'s, or a signed advert. You see it before anything is added.' });

    function render() {
      const box = $('#mc-card'); if (!box) return;
      const on = !!(k.caps().contacts);
      box.hidden = !on; if (!on || k.currentPage() !== 'mesh') return;
      const l = list(), n = current(), me = k.me(), cam = camWhy();
      const sig = JSON.stringify([l.map(x => x.key).join(), n && n.key, ui.msg, ui.link, me && me.longName, k.online(), qrOn()]);
      if (sig === ui.sig) return; ui.sig = sig;
      $('#mc-tag').textContent = `${l.length} contact${l.length === 1 ? '' : 's'} on the node`;
      const opt = l.map(x => `<option value="${esc(x.key)}"${x === n ? ' selected' : ''}>${esc(x.longName)} · ${esc(x.hwLabel)}</option>`).join('');
      const keepName = ($('#mc-name') || {}).value, keepImp = ($('#mc-imp') || {}).value;
      $('#mc-body').innerHTML = `<div class="row gap wrap rp-top"><label class="fld grow"><span>Contact</span><select id="mc-sel">${opt || '<option>none yet</option>'}</select></label>`
        + `<button class="btn" data-mc="share"${n ? '' : ' disabled'} title="Send its advert one hop over the air">📣 Share</button>`
        + `<button class="btn" data-mc="export"${n ? '' : ' disabled'}>🔗 Export link</button>`
        + `<button class="btn ghost" data-mc="remove"${n ? '' : ' disabled'}>🗑️ Remove</button></div>`
        + `<div class="row gap wrap rp-top"><label class="fld grow"><span>Import a meshcore:// link</span><input id="mc-imp" placeholder="meshcore://…" autocomplete="off"></label><button class="btn" data-mc="import">📥 Import</button></div>`
        + `<div class="row gap wrap rp-top"><label class="fld grow"><span>Your node's name</span><input id="mc-name" maxlength="31" autocomplete="off" value="${esc(me ? me.longName : '')}"></label><button class="btn" data-mc="name">Save name</button><button class="btn ghost" data-mc="mine">🔗 My link</button></div>`
        + (qrOn() ? `<div class="row gap wrap rp-top"><button class="btn" data-mc="qr"${n ? '' : ' disabled'} title="This contact as a QR code">▦ Show QR</button>`
          + `<button class="btn" data-mc="myqr"${me && me.key ? '' : ' disabled'} title="Your own node as a QR code">▦ My QR</button>`
          + `<button class="btn" data-mc="scan"${cam ? ' disabled' : ''} title="${esc(cam || 'Read a contact QR code with the camera')}">📷 Scan QR</button>`
          + `<button class="btn" data-mc="img" title="Read a contact QR code from a photo or screenshot">🖼️ From image</button></div>`
          + (cam ? `<p class="small">📷 ${esc(cam)} 🖼️ From image works anywhere.</p>` : '') : '')
        + (ui.link ? `<div class="mc-link"><input readonly id="mc-link" value="${esc(ui.link)}"><button class="btn small" data-mc="copy">Copy</button></div>` : '')
        + (ui.msg ? `<p class="small">${esc(ui.msg)}</p>` : '');
      if (keepName != null && document.activeElement && document.activeElement.id === 'mc-name') $('#mc-name').value = keepName;
      if (keepImp) $('#mc-imp').value = keepImp;
    }

    function init() {
      const box = $('#mc-card'); if (!box) return;
      box.addEventListener('change', e => { if (e.target.id === 'mc-sel') { ui.sel = e.target.value; store.set('meshContactSel', ui.sel); ui.link = ''; ui.msg = ''; redraw(); } });
      box.addEventListener('click', async e => {
        const b = e.target.closest('[data-mc]'); if (!b) return;
        const n = current(), me = k.me(), what = b.dataset.mc;
        if (what === 'copy') { const i = $('#mc-link'); i.select(); try { await navigator.clipboard.writeText(i.value); say('Link copied.'); } catch { document.execCommand && document.execCommand('copy'); } return; }
        if (what === 'share' && n) return act(s => s.shareContact(n), () => `📣 ${n.longName}'s advert sent one hop over the air.`);
        if (what === 'export' && n) { const v = await act(s => exportLink(s, n)); if (v) { ui.link = v; say(`🔗 ${n.longName}'s contact link:`); } return; }
        if (what === 'mine') { const v = await act(s => s.exportContact(null)); if (v) { ui.link = v; say('🔗 Your own node, as a link others can import:'); } return; }
        if (what === 'remove' && n) {
          if (!confirm(`Remove ${n.longName} from your node's contacts?\n\nIt comes back with its next advert if your node adds contacts automatically.`)) return;
          return act(s => s.removeContact(n), () => `🗑️ ${n.longName} removed from the node.`);
        }
        if (what === 'import') { const v = ($('#mc-imp').value || '').trim(); if (!v) return; const r = await review(v); if (r) $('#mc-imp').value = ''; return; }
        if (what === 'qr' && n && qrOn()) return qr().show({ title: `📇 ${n.longName}`, contact: { key: n.key, type: n.role || 1, name: n.longName }, advert: advertOf(n) });
        if (what === 'myqr' && me && me.key && qrOn()) return qr().show({ title: `📇 ${me.longName} (you)`, contact: { key: me.key, type: 1, name: me.longName }, advert: advertOf(null) });
        if (what === 'scan' && qrOn()) return qr().scan((t, c) => review(t, c), scanOpts('📷 Scan a contact QR'));
        if (what === 'img' && qrOn()) return qr().fromImage((t, c) => review(t, c), scanOpts('🖼️ Contact QR from a picture'));
        if (what === 'name') {
          const v = ($('#mc-name').value || '').trim(); if (!v) return;
          if (!/\b[A-Z]{1,2}\d{1,2}[A-Z]{1,4}\b/i.test(v) && !confirm(`"${v}" has no callsign in it. The hams-only filters (and the P25X bridge) look for one. Use it anyway?`)) return;
          return act(s => s.setName(v), () => `Name set to "${v}". It goes out with your next advert.`);
        }
      });
    }
    return { render, init };
  };
  window.KellyMeshContacts.bareAdvert = bareAdvert;   // for tests/meshqr-cdp.js
})();
