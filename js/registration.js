/* Kelly Page -- registration: the token client and Admin > Register this station (public release plan 7.1-7.4,
 * step 13).
 *
 * A registration token (js/enttoken.js) is checked here, offline, against the pinned keys, this device's key
 * (js/ident.js) and a clock that never goes backwards (the latest time this browser has seen, as license.js does).
 * A good one goes to KellyEnt.setToken(): its features turn on, and its net.gw gateways join the member-only
 * destinations. A bad, expired or other-device token is simply not used (KellyEnt then behaves as unregistered).
 * Where it's kept: with the key -- on the bridge when the key is the bridge's (kelly_ident.py token.txt), else
 * localStorage kelly.ent.token. Neither is in the config file, a backup or /api/kelly-state.
 *
 * At load: the stored token is applied at once (synchronously, device not checked yet), so member pages are there
 * from the start; init() then checks it against the device key. Every hour: re-checked (expiry), and refreshed from
 * half-life at the registration service (REG_URL, tools/kellypage-reg on kellypage.app).
 * Registering online: register() signs the service's one-time challenge with the device key (proof it holds the key)
 * and sends callsign + radio IDs; pickup() then collects the token once the admin has approved it (on open and hourly
 * while waiting). Kelly only talks to the service when the member registers, while waiting, and to renew.
 * window.KellyReg = { init, save, remove, register, pickup, refresh, status, REASONS }; window.KellyRegUI(ctx) = the card.
 */
(function (root) {
  'use strict';
  const LS_KEY = 'kelly.ent.token';
  const SEEN_KEY = 'kp-seen';                     // = license.js: the latest time this browser has seen
  const REG_URL = 'https://kellypage.app';       // the registration service (tools/kellypage-reg)
  const PENDING_KEY = 'kelly.reg.pending';        // {call, at}: registered online, waiting for approval
  const CHECK_MS = 3600e3;
  const REASONS = {
    REG_NONE: 'Not registered',
    TOK_EXPIRED: 'Registration expired -- ask for a new token',
    TOK_DEVICE: 'This token is for another device',
    TOK_NOT_YET: "Not valid yet -- check this device's clock",
    TOK_FORMAT: 'Not a registration token', TOK_VERSION: 'Not a registration token',
    TOK_KID: 'Not a registration token for this Kelly', TOK_SIG: 'Not a valid registration token',
  };
  const Tk = () => root.KellyToken, Ent = () => root.KellyEnt;

  function guardNow() {
    let seen = 0;
    try { seen = +root.localStorage.getItem(SEEN_KEY) || 0; } catch (e) { /* storage off */ }
    const t = Math.max(Date.now(), seen);
    try { if (t > seen) root.localStorage.setItem(SEEN_KEY, String(t)); } catch (e) { /* storage off */ }
    return t;
  }
  const lsToken = () => { try { return root.localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } };
  const check = (token, dev) => Tk().verify(token, { ed: Tk().naclEd(root.nacl), now: guardNow(), dev });

  const st = { token: '', payload: null, reason: 'REG_NONE', ident: null, checked: false, pending: null, lastAnswer: null };
  const lsJson = k => { try { return JSON.parse(root.localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  st.pending = lsJson(PENDING_KEY);
  const listeners = [];
  function apply(token, res) {
    st.token = res && res.ok ? token : '';
    st.payload = res && res.ok ? res.payload : null;
    st.reason = !token ? 'REG_NONE' : res.ok ? null : res.reason;
    if (Ent()) Ent().setToken(st.payload);
    setRevoked(!!(st.payload && st.revList && Tk().isRevoked(st.revList, st.payload)));   // (a refreshed token has a new jti)
    for (const fn of listeners) { try { fn(status()); } catch (e) { /* a listener's fault */ } }
  }
  function status() {
    const p = st.payload;
    const text = p ? `Registered as ${p.sub}` : st.pending ? `Waiting for approval (${st.pending.call})`
      : st.lastAnswer === 'revoked' ? 'Registration withdrawn for this device' : REASONS[st.reason] || st.reason;
    return { registered: !!p, reason: st.reason, text, pending: st.pending,
      call: p ? p.sub : null, exp: p ? p.exp : null, features: p ? p.feat : [], ident: st.ident, checked: st.checked };
  }

  // at load: the browser's stored token, before the pages read KellyEnt (the device is checked in init)
  (function early() {
    const t = lsToken();
    if (t && root.KellyToken && root.nacl) apply(t, check(t, null));
  })();

  async function init() {
    try { st.ident = await root.KellyIdent.get(); } catch (e) { st.ident = null; }
    const t = st.ident && st.ident.kind === 'bridge' ? st.ident.token || '' : lsToken();
    st.checked = true;
    apply(t, t ? check(t, st.ident ? st.ident.pub : null) : null);
    setInterval(tick, CHECK_MS);
    tick();
    return status();
  }
  // ---- the signed revocation list (KPV1, GET /api/revoked): best effort, hourly, online pages only (never file://). A token
  // whose jti or device is listed loses its entitlements (KellyEnt reason ENT_REVOKED). The highest seq seen is kept, so an
  // older list can't bring a revoked token back.
  const REV_SEQ_KEY = 'kelly.rev.seq';
  const online = () => !!(root.location && /^https?:$/.test(root.location.protocol));
  function setRevoked(on) { st.revoked = on; if (Ent() && Ent().setRevoked) Ent().setRevoked(on); }
  async function revocations() {
    if (!online() || !REG_URL || !Tk().verifyRevocations || !root.nacl) return false;
    const r = await root.fetch(REG_URL + '/api/revoked', { cache: 'no-store' });
    if (!r.ok) return false;                                  // 404 = no list published
    let minSeq = 0; try { minSeq = +root.localStorage.getItem(REV_SEQ_KEY) || 0; } catch (e) { /* storage off */ }
    const v = Tk().verifyRevocations(await r.text(), { ed: Tk().naclEd(root.nacl), minSeq, now: guardNow() });
    if (!v.ok) return false;
    try { root.localStorage.setItem(REV_SEQ_KEY, String(v.payload.seq)); } catch (e) { /* storage off */ }
    st.revList = v.payload;
    setRevoked(!!st.payload && Tk().isRevoked(v.payload, st.payload));
    return st.revoked;
  }
  function tick() {
    revocations().catch(() => { /* best effort */ });
    if (st.token) { const r = check(st.token, st.ident ? st.ident.pub : null); if (!r.ok) apply(st.token, r); }
    if (st.pending && !st.payload) pickup().catch(() => { /* next hour */ });
    else refresh().catch(() => { /* next hour */ });
  }

  // a token the member pasted (or the service sent): checked against this device first; kept with the key
  async function save(token) {
    token = String(token || '').trim();
    if (!st.ident) st.ident = await root.KellyIdent.get();
    const r = check(token, st.ident.pub);
    if (!r.ok) return { ok: false, reason: r.reason, text: REASONS[r.reason] || r.reason };
    if (st.ident.kind === 'bridge') await root.KellyIdent.bridgeToken(token);
    else root.localStorage.setItem(LS_KEY, token);
    apply(token, r);
    return { ok: true, text: status().text };
  }
  async function remove() {
    if (st.ident && st.ident.kind === 'bridge') { try { await root.KellyIdent.bridgeToken(''); } catch (e) { /* bridge away */ } }
    try { root.localStorage.removeItem(LS_KEY); } catch (e) { /* storage off */ }
    apply('', null);
  }
  // ---- the registration service. Request times are the real clock (the service allows +-5 min), not guardNow().
  async function api(path, body) {
    const r = await fetch(REG_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `the registration service answered ${r.status}`);
    return j;
  }
  const unixNow = () => Math.floor(Date.now() / 1000);
  function fire() { for (const fn of listeners) { try { fn(status()); } catch (e) { /* a listener's fault */ } } }
  function setPending(p) {
    st.pending = p;
    try { if (p) root.localStorage.setItem(PENDING_KEY, JSON.stringify(p)); else root.localStorage.removeItem(PENDING_KEY); } catch (e) { /* storage off */ }
    fire();
  }

  // ---- Cloudflare Turnstile (human check) -- ONLY on the hosted copy, https://kellypage.app. Anywhere else (file://, localhost,
  // a Pi, a bridge) nothing is fetched and no third-party script loads. The site key is public; /api/health may override it
  // (and says mode 'off' when the service wants no check). Tokens are single use: reset after every submit attempt.
  const TS_ORIGIN = 'https://kellypage.app', TS_SITEKEY = '0x4AAAAAAFwGleuq7Rjpi0dH';
  const TS_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const ts = { on: false, id: null, token: '' };
  const hosted = () => !!(root.location && root.location.origin === TS_ORIGIN);
  function tsLoad() {
    if (root.turnstile) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = root.document.createElement('script');
      s.src = TS_SCRIPT; s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error('human check unavailable'));
      root.document.head.appendChild(s);
    });
  }
  // render the widget into el (shown only when it renders); false = not hosted, or the service has it off
  async function turnstileInit(el) {
    if (!hosted() || !el) return false;
    if (ts.on) return true;
    let key = TS_SITEKEY;
    try {
      const h = await (await root.fetch(REG_URL + '/api/health', { cache: 'no-store' })).json();
      const t = { mode: h && h.turnstile, sitekey: h && h.sitekey };   // /api/health: {ok, kid, turnstile: "off"|"hosted"|"required", sitekey?}
      if (t && t.mode === 'off') return false;
      if (t && /^0x[0-9A-Za-z_-]+$/.test(t.sitekey || '')) key = t.sitekey;
    } catch (e) { /* health unreachable: the built-in key */ }
    await tsLoad();
    ts.id = root.turnstile.render(el, { sitekey: key, theme: 'auto',
      callback: tok => { ts.token = tok; }, 'expired-callback': () => { ts.token = ''; }, 'error-callback': () => { ts.token = ''; } });
    ts.on = true; el.hidden = false;
    return true;
  }
  function tsReset() { ts.token = ''; if (ts.on && root.turnstile) { try { root.turnstile.reset(ts.id); } catch (e) { /* widget gone */ } } }

  // register online: callsign + radio IDs + this device's key, signed over the service's one-time challenge
  async function register(call, llids, note) {
    if (!st.ident) st.ident = await root.KellyIdent.get();
    const C = String(call || '').trim().toUpperCase();
    const L = [...new Set((llids || []).map(Number))].filter(n => Number.isInteger(n) && n > 0 && n <= 0xFFFFFF);
    const { nonce } = await api('/api/reg/challenge', {});
    const sig = await root.KellyIdent.sign(`P25X-POP|register|${nonce}|${st.ident.pub}|${C}|${L.join(',')}`);
    const body = { call: C, llid: L, dev: st.ident.pub, note: String(note || '').slice(0, 200), nonce, sig: Tk().b64u(sig) };
    if (ts.on) {
      if (!ts.token) throw new Error('Please complete the human check first');
      body.turnstile = ts.token;
    }
    let j;
    try { j = await api('/api/reg/register', body); }
    catch (e) { if (/turnstile|human|captcha/i.test(e.message)) throw new Error('Human check failed, please try again'); throw e; }
    finally { tsReset(); }
    st.lastAnswer = j.status;
    if (j.status === 'approved') await pickup();
    else setPending({ call: C, at: Date.now() });
    return j.status;
  }
  // approved yet? the token, when it is
  async function pickup() {
    if (!st.ident) st.ident = await root.KellyIdent.get();
    const t = unixNow();
    const sig = await root.KellyIdent.sign(`P25X-POP|pickup|${st.ident.pub}|${t}`);
    const j = await api('/api/reg/pickup', { dev: st.ident.pub, t, sig: Tk().b64u(sig) });
    st.lastAnswer = j.status;
    if (j.token) { const r = await save(j.token); if (r.ok) setPending(null); return r.ok ? 'approved' : r.reason; }
    if (j.status === 'none' || j.status === 'revoked') setPending(null); else fire();
    return j.status;
  }
  // from half-life, a device-signed request for a fresh token
  async function refresh() {
    if (!REG_URL || !st.payload || !Tk().refreshDue(st.payload, guardNow())) return false;
    const t = unixNow();
    const sig = await root.KellyIdent.sign(`P25X-REFRESH|${st.payload.jti}|${t}`);
    const j = await api('/api/token/refresh', { token: st.token, t, sig: Tk().b64u(sig) });
    return !!(j && j.token && (await save(j.token)).ok);
  }

  // ---- over-the-air auth (kfiles op `auth`, gateway gateway/kelly-auth.js): proves to the gateway that
  // this radio ID is driven by the registered device. Signs "P25X-AUTH|<tid>|<llid>|<t>|<n>" with the device key (tid = the
  // token's jti, t = unix seconds, n = 4 random bytes). Returns the request {op, i, t, n, s} for a SHORT frame (about 130 B),
  // or null when there is no token for this radio ID. app.js sends it after a token arrives, on start-up and every ~11 h.
  async function authRequest(llid) {
    const p = st.payload;
    llid = Number(llid);
    if (!p || !p.jti || !(llid > 0 && llid <= 0xFFFFFF) || !(p.llid || []).map(Number).includes(llid)) return null;
    if (!st.ident) st.ident = await root.KellyIdent.get();
    const t = unixNow(), nb = new Uint8Array(4);
    root.crypto.getRandomValues(nb);
    const n = Tk().b64u(nb);
    const sig = await root.KellyIdent.sign(`P25X-AUTH|${p.jti}|${llid}|${t}|${n}`);
    return { op: 'auth', i: p.jti, t, n, s: Tk().b64u(sig) };
  }

  root.KellyReg = { init, save, remove, register, pickup, refresh, status, token: () => st.token, authRequest, turnstileInit, REASONS, REG_URL, on(fn) { listeners.push(fn); } };

  // ---- Admin > Register this station. ctx: {$, esc, toast}
  root.KellyRegUI = function (ctx) {
    const { $, toast } = ctx;
    const say = (text, ok) => { $('#reg-msg').textContent = text; $('#reg-msg').className = 'small ' + (ok ? 'ok-txt' : 'bad-txt'); };
    const KIND = { bridge: 'this Kelly bridge (shared by every page it serves)', webcrypto: 'this browser (protected key)',
      nacl: 'this browser', session: 'this visit only (private window: register from a normal window)' };
    // the QR is drawn only once the card is on screen: KellyMeshQR loads its QR library on first use, and Kelly keeps
    // that library out of the page load (tests/meshqr-cdp.js checks)
    let qrFor = '', qrSeen = false, qrObs = null;
    function drawQr() {
      const i = st.ident;
      if (!qrSeen || !i || i.pub === qrFor || !root.KellyMeshQR) return;
      qrFor = i.pub;
      root.KellyMeshQR.draw($('#reg-qr'), i.pub, 180).catch(() => { $('#reg-qr').hidden = true; });
    }
    const tsStart = () => { turnstileInit($('#reg-ts')).catch(() => say('The human check could not load -- reload and try again', false)); };
    function render(s) {
      const i = s.ident;
      $('#reg-state').textContent = s.registered ? 'registered' : Ent() && Ent().mode === 'private' ? "members' build" : 'not registered';
      $('#reg-status').textContent = s.text;
      $('#reg-pub').textContent = i ? i.pub : '…';
      $('#reg-fp').textContent = i ? i.fp || '—' : '…';
      $('#reg-kind').textContent = i ? KIND[i.kind] || i.kind : '…';
      $('#reg-exp').textContent = s.exp ? new Date(s.exp * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
      $('#reg-remove').hidden = !s.registered;
      $('#reg-online').hidden = s.registered || !!s.pending;
      $('#reg-wait').hidden = s.registered || !s.pending;
      drawQr();
    }
    function init() {
      if (!$('#reg-card')) return;
      root.KellyReg.on(render);
      if (root.IntersectionObserver) {
        qrObs = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { qrSeen = true; qrObs.disconnect(); drawQr(); tsStart(); } });
        qrObs.observe($('#reg-qr'));
      } else { qrSeen = true; tsStart(); }
      render(status());
      root.KellyReg.init().then(render).catch(() => render(status()));
      $('#reg-copy').onclick = async () => {
        const pub = st.ident && st.ident.pub;
        if (!pub) return;
        try { await navigator.clipboard.writeText(pub); toast('📋', 'Device key copied', 'Send it with your callsign and radio ID to register'); }
        catch (e) { toast('⚠️', "Couldn't copy", 'Select the key and copy it by hand', 'bad'); }
      };
      $('#reg-save').onclick = async () => {
        const r = await save($('#reg-token').value).catch(e => ({ ok: false, text: e.message }));
        $('#reg-msg').textContent = r.text;
        $('#reg-msg').className = 'small ' + (r.ok ? 'ok-txt' : 'bad-txt');
        if (r.ok) $('#reg-token').value = '';
      };
      const settings = ctx.settings || {};
      if (!$('#reg-call').value) $('#reg-call').value = settings.myCall || '';
      if (!$('#reg-llid').value && settings.myId) $('#reg-llid').value = settings.myId;
      $('#reg-send').onclick = async () => {
        const call = $('#reg-call').value.trim(), ids = $('#reg-llid').value.split(/[\s,]+/).filter(Boolean).map(Number);
        if (!/^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,4}$/i.test(call)) return say('Enter your callsign', false);
        if (!ids.length || ids.some(n => !(n > 0 && n <= 0xFFFFFF))) return say('Enter your radio ID (the number your radio sends)', false);
        $('#reg-send').disabled = true;
        try {
          const r = await register(call, ids, $('#reg-note').value);
          say(r === 'approved' ? 'Registered' : 'Sent -- Kelly collects your registration once it has been approved', true);
        } catch (e) { say(e.message, false); }
        $('#reg-send').disabled = false;
      };
      $('#reg-check').onclick = async () => {
        try { const r = await pickup(); say(r === 'approved' ? 'Registered' : r === 'pending' ? 'Not approved yet' : status().text, r === 'approved'); }
        catch (e) { say(e.message, false); }
      };
      $('#reg-cancel').onclick = () => { setPending(null); say('', true); };
      $('#reg-remove').onclick = async () => {
        if (!confirm('Remove this station\'s registration token? You can paste it again later.')) return;
        await remove(); $('#reg-msg').textContent = 'Token removed';
      };
    }
    return { init };
  };
})(window);
