/* Kelly Page -- Connect a phone (js/connectqr.js), driven in the REAL page over the Chrome DevTools Protocol, served by a
 * stand-in bridge on 127.0.0.1 with a fake GET /api/connect:
 *   1. PC: Admin > Connection > 📱 Connect a phone -- addresses listed (LAN https picked), QR hidden until Show QR, the
 *      QR decodes to the exact <address>/?connect=ip&token=... link, the token masked in every visible address,
 *      🖨 Print card renders; an older bridge (no /api/connect) falls back to the page's own address
 *   2. Scan (the shared js/meshqr.js scanner + dialog): only Kelly bridge addresses accepted, other kinds named (a
 *      MeshCore contact / channel, Meshtastic -- never echoed); "Switch to Kelly at <host>?" with "⚠️ not on your home
 *      network" off RFC1918 / Tailscale / .local, and "new address" the first time -> Switch goes there
 *   3. Phone (390 x 844, touch) with no radio link: the banner offers 📷 Scan a Kelly QR; ✕ hides it
 *   node tests/connectqr-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket)
 * Throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const BROWSER = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const KP = path.resolve(__dirname, '..');
const PORT = 9300 + Math.floor(Math.random() * 500), WEB = PORT + 600;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = 's3cret-Tok_9';
const DEV = 'meshtastic';   // the test page's LoRa Mesh device (mesh.js default): the QR carries the PC's own
const LAN_HTTPS = 'https://10.0.30.50:8443/';

// the stand-in bridge: Kelly's files + /api/connect (api = false: an older bridge without it)
let api = true;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${WEB}`);
  if (u.pathname === '/api/connect') {
    if (!api) { res.writeHead(404); return res.end(); }
    const j = { urls: [{ url: `http://127.0.0.1:${WEB}/`, label: 'Home network', kind: 'lan', https: false }, { url: LAN_HTTPS, label: 'Home network (https)', kind: 'lan', https: true },
      { url: 'https://100.64.0.20:8443/', label: 'Tailscale', kind: 'tailscale', https: true }], port: 8025, tlsPort: 8443, hasToken: true };
    if (u.searchParams.get('token') === TOKEN) j.token = TOKEN;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify(j));
  }
  if (/^\/(api|ws|mesh|ble)/.test(u.pathname)) { res.writeHead(404); return res.end(); }
  const f = path.join(KP, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(KP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => srv.listen(WEB, '127.0.0.1', r));
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0;
  const pend = new Map(), errs = [], logs = [];
  try {
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
    if (!tab) throw new Error('browser did not start');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value == null ? '' : String(a.value)).join(' '));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || '')); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const ready = async () => { await until(`document.readyState === 'complete' && !!window.KellyConnectQR && !!document.querySelector('#cqr-mount button')`); await sleep(1000); await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`); };
    const PAGE = `http://127.0.0.1:${WEB}/index.html?nosplash&nosw&token=${TOKEN}`;

    await send('Page.navigate', { url: PAGE });
    await sleep(500); await until(`document.readyState === 'complete'`);
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.persona = 'shack'; localStorage.setItem('kelly.settings', JSON.stringify(s)); location.reload(); })()`);
    await sleep(800); await ready();

    // ---- pure: which QR texts are Kelly addresses
    const P = (t) => js(`(() => { try { return KellyConnectQR.parseKellyUrl(${JSON.stringify(t)}).href; } catch (e) { return 'ERR'; } })()`);
    eq('accepts https LAN + token', await P(`${LAN_HTTPS}?token=abc`), `${LAN_HTTPS}?token=abc&mesh=meshcore#mesh`);
    eq('accepts plain bridge port 8025', await P('http://10.0.30.50:8025/'), 'http://10.0.30.50:8025/?mesh=meshcore#mesh');
    eq('keeps an existing connect=ip', await P(`${LAN_HTTPS}?connect=ip&token=abc`), `${LAN_HTTPS}?connect=ip&token=abc`);
    eq('rejects a web page', await P('https://example.com/'), 'ERR');
    eq('rejects a MeshCore contact', await P('meshcore://contact/add?name=x&public_key=' + 'a'.repeat(64)), 'ERR');
    eq('rejects plain text', await P('hello'), 'ERR');
    eq('rejects a login in the address', await P('https://u:p@10.0.30.50:8443/?token=a'), 'ERR');
    const PE = (t) => js(`(() => { try { KellyConnectQR.parseKellyUrl(${JSON.stringify(t)}); return 'OK'; } catch (e) { return e.message; } })()`);
    const KEY = 'cd'.repeat(32), SEC = '5a'.repeat(16);
    const eC = await PE(`meshcore://contact/add?name=Bob&public_key=${KEY}&type=1`);
    eq('a contact QR is named (MeshCore contact, Ham Contacts)', /MeshCore contact/.test(eC) && /Ham Contacts/.test(eC) && !eC.includes(KEY), true);
    const eCh = await PE(`meshcore://channel/add?name=Club&secret=${SEC}`);
    eq('a channel QR is named, its secret not echoed', /MeshCore channel/.test(eCh) && !eCh.includes(SEC), true);
    eq('a Meshtastic link is named', /Meshtastic/.test(await PE('https://meshtastic.org/e/#CgMSAQESBggBQANIAQ')), true);
    const H = (h) => js(`KellyConnectQR.homeHost(${JSON.stringify(h)})`);
    eq('home network: RFC1918 / Tailscale / .local / localhost / LAN name / ULA', [await H('10.1.2.3'), await H('172.20.0.9'), await H('192.168.1.5'), await H('100.64.0.20'), await H('kelly-pi.local'), await H('localhost'), await H('raspberrypi'), await H('[fd7a:115c:a1e0::1]')], [true, true, true, true, true, true, true, true]);
    eq('not home: public IPs and names, 172.32, 100.128', [await H('203.0.113.5'), await H('kelly.example.com'), await H('172.32.0.1'), await H('100.128.0.1'), await H('8.8.8.8'), await H('[2001:db8::1]')], [false, false, false, false, false, false]);
    eq('mask hides the token', await js(`KellyConnectQR.mask('https://h:8443/?connect=ip&token=abc')`), 'https://h:8443/?connect=ip&token=…');

    // ---- 1. PC: the card
    await click('button[data-page="admin"]'); await sleep(300);
    eq('Connect a phone button in Connection', await js(`!!document.querySelector('#page-admin #cqr-mount [data-cqr="card"]')`), true);
    await click('#cqr-mount [data-cqr="card"]');
    eq('addresses listed from /api/connect', await until(`document.querySelectorAll('#cqr .cqr-pick option').length === 3`, 6000), true);
    eq('LAN https picked by default', await js(`document.querySelector('#cqr .cqr-pick').value`), '1');
    eq('QR hidden until Show QR', await js(`document.querySelector('#cqr .cqr-qr').hidden`), true);
    eq('warning shown', await js(`/Anyone who scans this can use your radio/.test(document.querySelector('#cqr').textContent)`), true);
    eq('token masked in the address line', await js(`document.querySelector('#cqr .cqr-addr').textContent`), `${LAN_HTTPS}?token=…&mesh=${DEV}#mesh`);
    eq('token never in visible text', await js(`!document.querySelector('#cqr').innerText.includes(${JSON.stringify(TOKEN)})`), true);
    await click('#cqr [data-cqr="show"]');
    eq('QR shown', await until(`!document.querySelector('#cqr .cqr-qr').hidden`, 5000), true);
    eq('QR decodes to the exact link', await js(`KellyMeshQR.decode(document.querySelector('#cqr canvas'), true)`), `${LAN_HTTPS}?token=${TOKEN}&mesh=${DEV}#mesh`);
    await js(`(() => { const s = document.querySelector('#cqr .cqr-pick'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(600);
    eq('picking Tailscale redraws the QR', await js(`KellyMeshQR.decode(document.querySelector('#cqr canvas'), true)`), `https://100.64.0.20:8443/?token=${TOKEN}&mesh=${DEV}#mesh`);
    await js(`window.__printed = null; window.print = () => { const p = document.querySelector('#cqr-print'); window.__printed = { on: document.body.classList.contains('cqr-printing'), img: !!(p && p.querySelector('img') && p.querySelector('img').src.startsWith('data:image/png')), steps: p ? p.querySelectorAll('ol li').length : 0, masked: p ? !p.textContent.includes(${JSON.stringify(TOKEN)}) : false }; }`);
    await click('#cqr [data-cqr="print"]');
    eq('print card renders (QR image, 3 steps, token masked, only it printing)', await until(`!!window.__printed`, 5000) && await js('window.__printed'), { on: true, img: true, steps: 3, masked: true });
    eq('... and printing ends', await until(`!document.body.classList.contains('cqr-printing')`, 3000), true);
    await click('#cqr [data-cqr="close"]');

    // an older bridge: no /api/connect -> the page's own address
    api = false;
    await click('#cqr-mount [data-cqr="card"]');
    eq('fallback without /api/connect: one address, this bridge', await until(`document.querySelectorAll('#cqr .cqr-pick option').length === 1 && /This bridge/.test(document.querySelector('#cqr .cqr-pick').textContent)`, 8000), true);
    await click('#cqr [data-cqr="show"]'); await until(`!document.querySelector('#cqr .cqr-qr').hidden`, 5000);
    eq('... its QR carries the page token', await js(`KellyMeshQR.decode(document.querySelector('#cqr canvas'), true)`), `http://127.0.0.1:${WEB}/?token=${TOKEN}&mesh=${DEV}#mesh`);
    await click('#cqr [data-cqr="close"]');
    api = true;

    // ---- 2. scan: offer / switch (the camera itself needs a real phone), in the shared #mqr dialog
    await js(`window.__went = null; window.__toasts = []; KellyConnectQR.go = h => { window.__went = h; }; localStorage.removeItem('kelly.cqrHosts'); window.__cq = KellyConnectQR({ toast(i, t, m) { window.__toasts.push(t + ': ' + m); }, settings: {}, connected: () => false, connType: () => 'serial' })`);
    eq('a non-Kelly code is refused', await js(`window.__cq.offer('https://example.com/', null)`), false);
    eq('a MeshCore contact in Scan a Kelly QR is refused and named', await js(`window.__cq.offer('meshcore://contact/add?name=Bob&public_key=${'cd'.repeat(32)}&type=1', null)`), false);
    eq('... the toast names it (MeshCore contact, Ham Contacts), no key', await js(`window.__toasts.some(t => /MeshCore contact/.test(t) && /Ham Contacts/.test(t) && !t.includes('cdcdcdcd'))`), true);
    eq('a Kelly code is offered', await js(`window.__cq.offer(${JSON.stringify(`${LAN_HTTPS}?token=${TOKEN}`)}, null)`), true);
    const dlg = () => js(`(document.querySelector('#mqr:not([hidden])') || {}).textContent || ''`);
    eq('... "Switch to Kelly at <host>?" (shared dialog)', /Switch to Kelly at 10\.0\.30\.50:8443\?/.test(await dlg()), true);
    eq('... a LAN host: no home-network warning', /not on your home network/.test(await dlg()), false);
    eq('... first time: "new address"', /new address/.test(await dlg()), true);
    eq('... token masked there too', await js(`!document.querySelector('#mqr').innerText.includes(${JSON.stringify(TOKEN)})`), true);
    await click('#mqr [data-mqr="yes"]');
    eq('Switch goes to the link, mesh-only (no connect=ip)', await js('window.__went'), `${LAN_HTTPS}?token=${TOKEN}&mesh=meshcore#mesh`);
    eq('... and remembers the host', await js(`JSON.parse(localStorage.getItem('kelly.cqrHosts'))`), ['10.0.30.50:8443']);
    await js(`window.__cq.offer(${JSON.stringify(`${LAN_HTTPS}?token=${TOKEN}`)}, null)`);
    eq('same host again: no "new address"', /new address/.test(await dlg()), false);
    await click('#mqr [data-mqr="no"]');
    await js(`window.__went = null; window.__cq.offer('https://203.0.113.5:8443/?token=${TOKEN}', null)`);
    eq('a public host: "⚠️ not on your home network" + new address', [/⚠️ not on your home network/.test(await dlg()), /new address/.test(await dlg())], [true, true]);
    await click('#mqr [data-mqr="no"]');
    eq('... Cancel goes nowhere', await js('window.__went'), null);
    await js(`window.__cq.offer('https://100.64.0.20:8443/?token=${TOKEN}', null)`);
    eq('a Tailscale host: no home-network warning', /not on your home network/.test(await dlg()), false);
    await click('#mqr [data-mqr="no"]');
    // no camera here (plain http, or no getUserMedia): the shared scanner says why and offers a photo
    await js(`void Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: undefined, configurable: true })`);
    await js(`window.__cq.scan()`);
    eq('no camera: says so, photo offered', /camera/i.test(await dlg()) && /photo of the QR/.test(await dlg()) && await js(`!!document.querySelector('#mqr [data-mqr="photo"]')`), true);
    eq('one dialog: no #cqr scanner open', await js(`!document.querySelector('#cqr') || document.querySelector('#cqr').hidden`), true);
    await click('#mqr [data-mqr="close"]');
    eq('From image button in Connection', await js(`!!document.querySelector('#cqr-mount [data-cqr="image"]')`), true);

    // ---- 3. a phone with no radio link and no token (opened bare): the banner. With a token it stays away (mesh-only QR link)
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await send('Page.navigate', { url: PAGE.replace(/&token=[^&]*/, '') }); await sleep(800); await ready();
    const coarse = await js(`matchMedia('(pointer: coarse)').matches`);
    eq('phone: banner offers 📷 Scan a Kelly QR', coarse ? await until(`(() => { const b = document.querySelector('#cqr-banner'); return !!b && !b.hidden && !!b.querySelector('[data-cqr="scan"]'); })()`, 9000) : 'pointer:coarse not emulated', true);
    if (coarse) {
      eq('banner button >= 44 px', await js(`document.querySelector('#cqr-banner [data-cqr="scan"]').getBoundingClientRect().height >= 44`), true);
      await click('#cqr-banner [data-cqr="off"]');
      eq('✕ hides the banner', await js(`document.querySelector('#cqr-banner').hidden`), true);
    }
    eq('the token never reached the console', logs.some(l => l.includes(TOKEN)), false);
    eq('no page errors', errs, []);
  } catch (e) {
    console.log('FAIL', e.message); fails.push(e.message);
  } finally {
    try { ws && ws.close(); } catch { /* gone */ }
    killTree(br, profile); srv.close();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  }
  console.log(fails.length ? `RESULT: FAIL (${fails.length})` : 'RESULT: ALL PASS');
  process.exit(fails.length ? 1 : 0);
})();
