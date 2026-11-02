/* Kelly Page -- Connect a phone (2026-10-23). A member's Kelly runs headless on a Pi at home (the Kelly bridge); their
 * phone joins it by scanning a QR code instead of typing an address and a long token.
 *
 *   PC (Admin > Connection > 📱 Connect a phone): the bridge's addresses come from its GET /api/connect
 *     { urls: [{ url, label, kind: 'lan'|'tailscale'|'mdns', https }], port, tlsPort, hasToken, token? }
 *     (LAN first; `token` only when the request carried the right ?token=). An older bridge without it: the page's own
 *     origin, or the IP bridge URL's host. The QR is <address>/?token=...&mesh=<device>#mesh -- LoRa Mesh only, the radio stays with the Pi --
 *     drawn only after "Show QR" (anyone who scans it can use the radio). 🖨 Print card: the QR + 3 steps on paper.
 *   Phone (📷 Scan a Kelly QR / 🖼️ From image, and a banner on a phone with no radio link): the shared scanner
 *     (js/meshqr.js ui().scan / fromImage -- one dialog and one camera per page, QR_REVIEW.md S23), checked by
 *     parseKellyUrl: only Kelly bridge addresses (http/https with ?token= or port 8025 / 8443); a MeshCore contact /
 *     channel / Meshtastic code is named and pointed to its place (S10). Then "Switch to Kelly at <host>?" in the
 *     shared dialog, with "⚠️ not on your home network" (not RFC1918 / Tailscale 100.64/10 / .local / localhost) and
 *     "new address" the first time a host is used (localStorage kelly.cqrHosts) (S25), then go there.
 * The token never goes to the console, and any address shown as text has it masked (?token=…).
 *
 * window.KellyConnectQR(ctx) -> { init, open, scan, close, offer }; ctx = { $, esc, toast, settings, connected(), connType() }.
 * The last instance made is KellyConnectQR.current (the LoRa Mesh 📷 Scan button hands it a Kelly code).
 * Pure (also on the function, and module.exports for the tests): parseKellyUrl, phoneUrl, mask, pickDefault, tokenOf,
 * bridgeServed, homeHost.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.KellyConnectQR = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  const doc = root.document;
  const PORTS = /^(8025|8443)$/;

  // ---- pure
  const tokenOf = u => { try { return new URL(String(u || '').replace(/^ws/i, 'http')).searchParams.get('token') || ''; } catch { return ''; } };
  const mask = u => String(u || '').replace(/([?&]token=)[^&#]*/gi, '$1…');
  // a bridge address -> the phone's link: LoRa Mesh only (?mesh=<device>, mesh.js connects it), never ?connect=ip --
  // the P25 radio takes one Kelly at a time and the Pi's always-on Kelly keeps it (2026-10-23)
  function phoneUrl(base, token, dev) {
    const u = new URL('/', base);
    if (token) u.searchParams.set('token', token);
    u.searchParams.set('mesh', dev || 'meshcore');
    u.hash = 'mesh';
    return u.href;
  }
  // text read from a QR code -> a URL to go to, or throws a sentence for the dialog
  function parseKellyUrl(text) {
    const t = String(text == null ? '' : text).trim();
    // another kind of code (a MeshCore contact / channel, Meshtastic...): the shared module's sentence names it (S10)
    const Q = root.KellyMeshQR, k = Q && Q.classify ? Q.classify(t) : null;
    if (k && k !== 'kelly' && k !== 'web') Q.parse(t, { accept: ['kelly', 'web'] });
    let u; try { u = new URL(t); } catch { throw new Error("that QR code isn't a web address"); }
    if (!/^https?:$/.test(u.protocol)) throw new Error("that isn't a Kelly address (it must start http:// or https://)");
    if (u.username || u.password) throw new Error("that address carries a login -- Kelly's never do");
    if (!u.searchParams.get('token') && !PORTS.test(u.port)) throw new Error("that isn't a Kelly bridge address (no ?token= and not port 8025 or 8443)");
    if (!u.searchParams.has('connect') && !u.searchParams.has('mesh')) { u.searchParams.set('mesh', 'meshcore'); u.hash = 'mesh'; }
    return u;
  }
  // the address the QR starts on: LAN over https (the phone can use the camera and Bluetooth there), else any LAN, else the first
  const pickDefault = urls => (urls || []).find(x => x.kind === 'lan' && x.https) || (urls || []).find(x => x.kind === 'lan') || (urls || [])[0] || null;
  // was this page served by a Kelly bridge (its port 8025 / --tls-port 8443, or opened with ?token=)?
  const bridgeServed = loc => /^https?:$/.test(loc.protocol) && (PORTS.test(loc.port) || !!new URLSearchParams(loc.search).get('token'));
  // is this host (URL.hostname) on a home network: RFC1918, Tailscale's 100.64/10, loopback / link-local, IPv6 ULA /
  // link-local, *.local / *.lan / *.home.arpa, localhost, or a bare LAN name (no dot)? (S25: a hamfest sticker can point anywhere)
  function homeHost(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!h) return false;
    if (h === 'localhost' || /\.(local|lan|home\.arpa|localhost)$/.test(h)) return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (m) { const a = +m[1], b = +m[2]; return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254); }
    if (h.includes(':')) return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
    return !h.includes('.');
  }
  // the hosts this browser has switched to before ("new address" the first time); try/catch: a private window has none
  const HOSTS = 'kelly.cqrHosts';
  const usedHosts = () => { try { const a = JSON.parse(root.localStorage.getItem(HOSTS) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const rememberHost = h => { try { root.localStorage.setItem(HOSTS, JSON.stringify([h].concat(usedHosts().filter(x => x !== h)).slice(0, 30))); } catch { /* private window */ } };

  // ---- the PC card's dialog: one #cqr for the page, however many instances (scanning uses js/meshqr.js's dialog)
  let box = null;
  function open(title, html) {
    if (!box) {
      box = doc.createElement('div'); box.id = 'cqr'; box.className = 'cqr'; box.hidden = true;
      box.innerHTML = '<div class="cqr-box" role="dialog" aria-modal="true"><div class="cqr-h"><b id="cqr-title"></b><button class="btn small ghost" data-cqr="close" title="Close">✕</button></div><div id="cqr-body"></div></div>';
      doc.body.appendChild(box);
      box.addEventListener('click', e => { if (e.target === box || e.target.closest('[data-cqr="close"]')) close(); });
      doc.addEventListener('keydown', e => { if (e.key === 'Escape' && box && !box.hidden) close(); });
    }
    try { root.KellyMeshQR.ui().close(); } catch { /* no shared dialog */ }
    box.querySelector('#cqr-title').textContent = title;
    const body = box.querySelector('#cqr-body'); body.innerHTML = html;
    box.hidden = false;
    return body;
  }
  function close() { if (box) box.hidden = true; }

  function create(ctx) {
    const esc = ctx.esc || (s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));
    const QR = () => root.KellyMeshQR;
    let banner = null, bannerOff = false;

    // where this Kelly's bridge is: the page's own origin when a bridge served it, else the 🌐 IP bridge URL
    function bridge() {
      const pageTok = new URLSearchParams(root.location.search).get('token') || '';
      if (bridgeServed(root.location)) return { base: root.location.origin, token: pageTok || tokenOf(ctx.settings.url), served: true };
      if (ctx.connType() === 'ip' && ctx.settings.url) {
        try { const u = new URL(String(ctx.settings.url).replace(/^ws/i, 'http')); return { base: u.origin, token: u.searchParams.get('token') || '', served: false }; } catch { /* bad URL */ }
      }
      return null;
    }
    async function addresses(b) {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
      try {
        const r = await fetch(`${b.base}/api/connect${b.token ? `?token=${encodeURIComponent(b.token)}` : ''}`, { cache: 'no-store', signal: ctl.signal });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!j || !Array.isArray(j.urls) || !j.urls.length) throw new Error('no addresses');
        return { urls: j.urls, token: j.token || b.token, hasToken: !!j.hasToken, live: true };
      } catch {   // an older bridge (no /api/connect), or not reachable from here: the address this Kelly already uses
        return { urls: [{ url: `${b.base}/`, label: b.served ? 'This bridge' : 'The IP bridge', kind: 'lan', https: b.base.startsWith('https:') }], token: b.token, hasToken: !!b.token, live: false };
      } finally { clearTimeout(t); }
    }

    // 📱 Connect a phone (PC side)
    async function card() {
      const b = bridge();
      if (!b) {
        open('📱 Connect a phone', '<p class="small">A phone joins Kelly through its bridge -- the Raspberry Pi (or PC) running <code>kelly_bridge.py</code>. Connect this Kelly that way first (Connection › 🌐 IP bridge), or open it from the Pi\'s own address, then come back here.</p>');
        return;
      }
      const body = open('📱 Connect a phone', '<p class="small cqr-note">Finding this bridge\'s addresses…</p>');
      const a = await addresses(b);
      if (!box || box.hidden) return;
      const first = pickDefault(a.urls), opts = a.urls.map((x, i) => `<option value="${i}"${x === first ? ' selected' : ''}>${esc(x.label || x.kind)} · ${esc(mask(x.url))}</option>`).join('');
      body.innerHTML = `<label class="fld"><span>Address for the phone</span><select class="cqr-pick">${opts}</select></label>
        <p class="small dim">${a.live ? 'Use a <b>home network (LAN)</b> address while the phone is on your WiFi; a Tailscale address works away from home once the phone runs Tailscale.' : 'This bridge doesn\'t list its addresses (an older Kelly bridge), so this is the one this Kelly uses.'}</p>
        ${a.hasToken && !a.token ? '<p class="small cqr-warn">⚠️ This bridge needs a token, and this Kelly doesn\'t know it: open Kelly with <code>?token=…</code> (or put it in the IP bridge URL), then try again.</p>' : ''}
        <p class="small cqr-warn">⚠️ Anyone who scans this can use your radio -- like knowing the token. Show it only to your own phone.</p>
        <div class="cqr-qr" hidden><canvas class="cqr-code" width="300" height="300"></canvas></div>
        <p class="small cqr-addr"></p>
        <div class="row gap wrap"><button class="btn primary" data-cqr="show">Show QR</button><button class="btn" data-cqr="print">🖨 Print card</button><button class="btn ghost" data-cqr="copy">Copy link</button></div>
        <ol class="small cqr-steps"><li>On the phone, open the camera and scan the code (or Kelly's 📷 Scan a Kelly QR).</li>
          <li>On an <b>https://</b> address the phone warns about the certificate the first time: <b>Advanced › Proceed</b>. It's your own bridge's certificate -- once per phone.</li>
          <li>Done: Kelly opens and connects. Add it to the home screen to keep it.</li></ol>`;
      const pick = body.querySelector('.cqr-pick'), cv = body.querySelector('canvas'), wrap = body.querySelector('.cqr-qr'), addr = body.querySelector('.cqr-addr');
      const link = () => phoneUrl(a.urls[+pick.value].url, a.token, ctx.settings && ctx.settings.mesh && ctx.settings.mesh.dev);
      const label = () => { addr.textContent = mask(link()); };
      label();
      async function show() {
        try { await QR().draw(cv, link(), 300); wrap.hidden = false; body.querySelector('[data-cqr="show"]').textContent = 'Hide QR'; }
        catch (e) { addr.textContent = `⚠️ ${e.message}`; }
      }
      pick.addEventListener('change', () => { label(); if (!wrap.hidden) show(); });
      body.addEventListener('click', async e => {
        const btn = e.target.closest('[data-cqr]'); if (!btn) return;
        const what = btn.dataset.cqr;
        if (what === 'show') { if (wrap.hidden) show(); else { wrap.hidden = true; btn.textContent = 'Show QR'; } }
        else if (what === 'print') printCard(link(), a.urls[+pick.value]);
        else if (what === 'copy') {
          try { await root.navigator.clipboard.writeText(link()); ctx.toast && ctx.toast('📋', 'Link copied', 'Send it only to your own phone -- it carries the token.'); }
          catch { root.prompt('Copy this link (it carries the token -- your own phone only):', link()); }
        }
      });
    }

    // 🖨 a card for the fridge: the QR, the address (token masked) and the three steps; only it prints
    async function printCard(url, entry) {
      const cv = doc.createElement('canvas');
      try { await QR().draw(cv, url, 600); } catch (e) { ctx.toast && ctx.toast('🖨', "Couldn't draw the QR", e.message, 'warn'); return; }
      let p = doc.getElementById('cqr-print');
      if (!p) { p = doc.createElement('div'); p.id = 'cqr-print'; doc.body.appendChild(p); }
      p.innerHTML = `<h1>Kelly -- connect your phone</h1><img alt="QR code: Kelly on your home bridge" src="${cv.toDataURL('image/png')}">
        <p class="cqr-p-addr">${esc(mask(url))}${entry && entry.label ? ` (${esc(entry.label)})` : ''}</p>
        <ol><li>Scan the code with the phone's camera.</li><li>If the phone warns about the certificate (https), choose <b>Advanced › Proceed</b> -- once per phone.</li><li>Done: Kelly opens and connects. Add it to the home screen.</li></ol>
        <p class="cqr-p-warn">Keep this card at home: anyone who scans it can use your radio.</p>`;
      doc.body.classList.add('cqr-printing');
      const done = () => { doc.body.classList.remove('cqr-printing'); root.removeEventListener('afterprint', done); };
      root.addEventListener('afterprint', done);
      try { root.print(); } finally { setTimeout(done, 1000); }
    }

    // ---- 📷 Scan a Kelly QR (phone side), on the shared scanner / dialog (js/meshqr.js)
    const SCAN = { accept: ['kelly', 'web'], check: parseKellyUrl, title: '📷 Scan a Kelly QR',
      hint: 'Point the camera at the QR code on your PC screen or printed card. No camera here? The phone\'s own camera app opens Kelly straight away.' };
    const say = (t, m) => ctx.toast && ctx.toast('📷', t, m, 'warn');
    // a read QR text -> ask before going (the shared dialog's Yes / No, not window.confirm); false if it isn't a Kelly code
    function offer(text, note) {
      let u; try { u = parseKellyUrl(text); } catch (e) { const m = e.message.replace(/ -- nothing was added$/, ''); if (note) note.textContent = `⚠️ ${m}. Try another code.`; else say('Not a Kelly address', m.charAt(0).toUpperCase() + m.slice(1) + '.'); return false; }
      close();
      const home = homeHost(u.hostname), seen = u.host === root.location.host || usedHosts().includes(u.host);
      const html = `<p>Switch to Kelly at <b>${esc(u.host)}</b>?</p>`
        + (home ? '' : '<p class="small cqr-warn cqr-away">⚠️ not on your home network: this address isn\'t your own WiFi (LAN), Tailscale or this device. Only switch if you know whose Kelly it is -- whoever runs it sees what you do there.</p>')
        + (seen ? '' : '<p class="small cqr-new">🆕 new address: this phone hasn\'t switched to it before.</p>')
        + `<p class="small dim">${esc(mask(u.href))}</p>`;
      const Q = QR();
      const go = () => { rememberHost(u.host); create.go(u.href); };
      if (!Q) { if (root.confirm(`Switch to Kelly at ${u.host}?${home ? '' : ' (not on your home network)'}`)) go(); return true; }
      Q.ui({ toast: ctx.toast }).confirm({ title: '📷 Scan a Kelly QR', html, ok: 'Switch', danger: !home }).then(yes => { if (yes) go(); });
      return true;
    }
    function scan() {
      close();
      const Q = QR(); if (!Q) return say('No scanner', 'The QR module did not load -- reload Kelly.');
      Q.ui({ toast: ctx.toast }).scan(text => offer(text), SCAN);
    }
    function fromImage() {
      close();
      const Q = QR(); if (!Q) return say('No scanner', 'The QR module did not load -- reload Kelly.');
      Q.ui({ toast: ctx.toast }).fromImage(text => offer(text), SCAN);
    }

    // ---- on a phone with no radio link: one quiet banner offering the scan (dismissed until the next visit)
    const isPhone = () => !!(root.matchMedia && root.matchMedia('(max-width: 600px)').matches && root.matchMedia('(pointer: coarse)').matches);
    function bannerCheck() {
      // the QR's mesh-only link isn't 'not connected' -- but only while that link is up or coming up: a page holding a
      // changed (refused) token kept the banner away, the one way back (the owner's phone, 2026-10-23)
      const mesh = root.KellyMeshLink, meshUp = !!(mesh && mesh.status() !== 'off');
      const want = !bannerOff && isPhone() && !ctx.connected() && !meshUp;
      if (want && !banner) {
        banner = doc.createElement('div'); banner.id = 'cqr-banner'; banner.className = 'cqr-banner';
        banner.innerHTML = '<span>📱 Not connected to your Kelly.</span><button class="btn primary" data-cqr="scan">📷 Scan a Kelly QR</button><button class="btn small ghost" data-cqr="off" title="Not now">✕</button>';
        banner.addEventListener('click', e => {
          const b = e.target.closest('[data-cqr]'); if (!b) return;
          if (b.dataset.cqr === 'scan') scan();
          if (b.dataset.cqr === 'off') { bannerOff = true; bannerCheck(); }
        });
        doc.body.appendChild(banner);
      }
      if (banner) banner.hidden = !want;
    }

    function init() {
      const m = doc.getElementById('cqr-mount');
      if (m) {
        m.innerHTML = '<div class="row gap wrap"><button class="btn" data-cqr="card" title="A QR code of this bridge\'s address for your phone">📱 Connect a phone</button><button class="btn ghost" data-cqr="scan" title="On a phone: read the QR from your PC or printed card">📷 Scan a Kelly QR</button><button class="btn ghost" data-cqr="image" title="Read a Kelly QR from a photo or screenshot">🖼️ From image</button></div>';
        m.addEventListener('click', e => { const b = e.target.closest('[data-cqr]'); if (!b) return; if (b.dataset.cqr === 'card') card(); else if (b.dataset.cqr === 'scan') scan(); else if (b.dataset.cqr === 'image') fromImage(); });
      }
      // give a ?connect=ip start a few seconds to link up before suggesting anything
      setTimeout(() => { bannerCheck(); setInterval(bannerCheck, 3000); }, 5000);
    }
    const inst = { init, open: card, scan, fromImage, close, offer, bannerCheck };
    create.current = inst;
    return inst;
  }
  create.go = href => { root.location.href = href; };   // replaceable in the tests
  Object.assign(create, { parseKellyUrl, phoneUrl, mask, pickDefault, tokenOf, bridgeServed, homeHost });
  return create;
});
