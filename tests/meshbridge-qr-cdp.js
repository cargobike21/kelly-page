/* Kelly Page -- LoRa Mesh: the Mesh bridge address as a QR code (🔳 share), in the real page over CDP.
 *   1. the address in use (blank field -> worked out from the page bridge; typed -> as typed) is the QR, token behind Show QR
 *      (the warning: anyone who scans it can use the LoRa node and read the channels)
 *   2. 📷 Scan beside 🔌 Connect: each kind routed (contact / advert -> kellyHCImport, channel -> kellyChannelImport, Kelly
 *      code -> the "Switch to" offer, Meshtastic -> its app), a toast when a hook is missing; the code never on screen
 *   node tests/meshbridge-qr-cdp.js [path to chrome/msedge]     (Node 22+)
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
    await js(`location.hash = '#mesh'`); await sleep(800);
    await js(`(() => { const l = document.querySelector('#mesh-link'); l.value = 'bridge'; l.dispatchEvent(new Event('change')); })()`); await sleep(600);
    eq('🔳 beside the field, no scan button', await js(`!!document.querySelector('#mesh-bwrap #mesh-bqr') && !document.querySelector('#mesh-bscan')`), true);
    // 1. blank field: the address Kelly works out from the bridge that served the page (+ the page token)
    eq('in use, field blank', await js('KellyMeshBridgeQR.share()'), `127.0.0.1:${WEB}?token=${TOKEN}`);
    await click('#mesh-bqr'); await sleep(400);
    eq('QR hidden until Show QR', await js(`document.querySelector('#mqr:not([hidden]) canvas').hidden`), true);
    eq('secret warning: node + channels', await js(`/anyone who scans it can use your LoRa node and read your channels/.test(document.querySelector('#mqr:not([hidden])').textContent)`), true);
    eq('token masked in the line', await js(`document.querySelector('#mqr:not([hidden]) .mqr-link').value`), `${LAN_HTTPS}?token=…&mesh=${DEV}#mesh`);
    await click('#mqr:not([hidden]) [data-mqr="reveal"]'); await sleep(800);
    const qr = await js(`KellyMeshQR.decode(document.querySelector('#mqr:not([hidden]) canvas'), true)`);
    eq('QR = a phone link: LAN https Kelly + token + mesh-only', qr, `${LAN_HTTPS}?token=${TOKEN}&mesh=${DEV}#mesh`);
    eq('... a web address the phone camera opens', /^https:\/\//.test(qr), true);
    await js(`document.querySelector('#mqr [data-mqr="close"]').click()`);

    // 2. 📷 Scan on the connection bar
    eq('📷 Scan beside Connect', await js(`(() => { const b = document.querySelector('#mesh-scan'); return [!!b, b && b.previousElementSibling && b.previousElementSibling.id, b && !b.hidden && getComputedStyle(b).display !== 'none', b && b.textContent]; })()`), [true, 'mesh-go', true, '📷 Scan']);
    await click('#mesh-scan'); await sleep(400);
    eq('... opens the shared scanner', await js(`!!document.querySelector('#mqr:not([hidden])') && /Scan a QR code/.test(document.querySelector('#mqr-title').textContent)`), true);
    await js(`document.querySelector('#mqr [data-mqr="close"]').click()`);
    const KEY = 'ab'.repeat(32), SEC = '0f'.repeat(16);
    const CONTACT = `meshcore://contact/add?name=Bob&public_key=${KEY}&type=2`, CHAN = `meshcore://channel/add?name=Club&secret=${SEC}`;
    const ROUTE = t => js(`(() => { const t = ${JSON.stringify(t)}; KellyMeshScan.route(t, KellyMeshQR.parse(t, { accept: ['contact', 'advert', 'channel', 'kelly', 'meshtastic'] })); return true; })()`);
    const toasts = () => js(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`);
    const clearToasts = () => js(`document.querySelectorAll('.toast').forEach(t => t.remove())`);
    await js(`delete window.kellyHCImport; delete window.kellyChannelImport`);
    await clearToasts(); await ROUTE(CONTACT); await sleep(200);
    eq('contact, no Ham Contacts hook: a toast pointing there', /Ham Contacts/.test(await toasts()), true);
    await clearToasts(); await ROUTE(CHAN); await sleep(200);
    eq('channel, no Channels hook: a toast, nothing saved', /channel/i.test(await toasts()) && /nothing was saved/.test(await toasts()), true);
    eq('... its secret never on screen', (await js(`document.body.innerText`)).includes(SEC), false);
    await js(`window.__hc = []; window.__ch = []; window.kellyHCImport = t => window.__hc.push(t); window.kellyChannelImport = t => window.__ch.push(t)`);
    await ROUTE(CONTACT); await ROUTE(CHAN);
    eq('contact -> kellyHCImport(text)', await js('window.__hc'), [CONTACT]);
    eq('channel -> kellyChannelImport(text)', await js('window.__ch'), [CHAN]);
    const ADV = 'meshcore://' + '11'.repeat(110);
    await ROUTE(ADV);
    eq('signed advert -> kellyHCImport', await js('window.__hc.length'), 2);
    await clearToasts(); await ROUTE('https://meshtastic.org/e/#CgMSAQESBggBQANIAQ');
    eq('meshtastic -> "open it in the Meshtastic app"', /Meshtastic app/.test(await toasts()), true);
    await ROUTE(`${LAN_HTTPS}?token=${TOKEN}`); await sleep(300);
    eq('Kelly code -> the "Switch to Kelly at" offer', await js(`/Switch to Kelly at 10\\.0\\.30\\.50:8443\\?/.test(document.querySelector('#mqr:not([hidden])').textContent)`), true);
    eq('... token masked', await js(`!document.querySelector('#mqr').innerText.includes(${JSON.stringify(TOKEN)})`), true);
    await js(`document.querySelector('#mqr [data-mqr="no"]').click()`);
    await js(`delete window.kellyHCImport; delete window.kellyChannelImport`);
    // typed: as typed (wss kept)
    await js(`(() => { const i = document.querySelector('#mesh-burl'); i.value = 'wss://100.64.0.10:3000/mesh-bridge?token=abc'; i.dispatchEvent(new Event('change')); })()`); await sleep(300);
    eq('in use, typed (wss kept, path kept)', await js('KellyMeshBridgeQR.share()'), 'wss://100.64.0.10:3000/mesh-bridge?token=abc');
    const typed = await js('KellyMeshBridgeQR.link()');
    eq('typed address rides in the link (mb=)', new URL(typed).searchParams.get('mb'), 'wss://100.64.0.10:3000/mesh-bridge?token=abc');
    eq('... with the page token and mesh-only', [new URL(typed).searchParams.get('token'), new URL(typed).searchParams.get('mesh'), new URL(typed).searchParams.has('connect')], [TOKEN, DEV, false]);
    // a phone opening that link: the field takes the mb address, the mesh connects (mb is the address, not the page bridge)
    await send('Page.navigate', { url: typed.replace(LAN_HTTPS, `http://127.0.0.1:${WEB}/`) }); await sleep(2500);
    eq('phone side: Mesh bridge address = mb', await js(`document.querySelector('#mesh-burl').value`), 'wss://100.64.0.10:3000/mesh-bridge?token=abc');
    eq('phone side: Node link = Kelly bridge', await js(`document.querySelector('#mesh-link').value`), 'bridge');
    eq('no token in the console', logs.some(l => l.includes(TOKEN)), false);
    eq('no page errors', errs, []);
  } catch (e) { console.log(`FAIL ${e.message}`); fails.push(e.message); }
  finally { try { ws && ws.close(); } catch {} killTree(br, profile); srv.close(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
  console.log(`RESULT: ${fails.length ? `FAIL (${fails.length})` : 'ALL PASS'}`);
  process.exit(fails.length ? 1 : 0);
})();
