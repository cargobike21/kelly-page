/* Kelly Page -- the remembered radio link (app.js resumeRadio), in the real page over CDP with a stand-in bridge:
 *   1. the user's Connect over IP works -> reload -> Kelly connects the same way by itself
 *   2. the user's Disconnect -> reload -> stays off
 *   3. the remembered address fails -> one toast; tapping it opens Admin > Connection with the Bridge URL focused
 *   4. a Connect-a-phone page (?mesh=meshcore) in a browser that never pressed Connect -> never takes the radio
 *   node tests/radio-resume-cdp.js [path to chrome/msedge]     (Node 22+)
 * Throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
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

// the stand-in bridge: Kelly's files + a /ws that takes the WebSocket handshake (a silent radio) and counts links
let wsLinks = 0;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${WEB}`);
  if (/^\/(api|ws|mesh|ble)/.test(u.pathname)) { res.writeHead(404); return res.end(); }
  const f = path.join(KP, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(KP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
srv.on('upgrade', (req, sock) => {
  sock.on('error', () => {});
  if (!req.url.startsWith('/ws')) return sock.destroy();
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  wsLinks++;
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
    const ready = async () => { await until(`document.readyState === 'complete' && !!document.querySelector('#a-connect')`); await sleep(1000); await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`); };
    const PAGE = `http://127.0.0.1:${WEB}/index.html?nosplash&nosw`;
    const WSURL = `ws://127.0.0.1:${WEB}/ws`;
    const settings = () => js(`JSON.parse(localStorage.getItem('kelly.settings') || '{}')`);
    const reload = async (url = PAGE) => { await send('Page.navigate', { url }); await sleep(600); await ready(); };
    const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200); } return false; };
    const toasts = () => js(`[...document.querySelectorAll('.toast b')].map(b => b.textContent)`);

    await send('Page.navigate', { url: PAGE });
    await sleep(500); await until(`document.readyState === 'complete'`);
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.persona = 'shack'; localStorage.setItem('kelly.settings', JSON.stringify(s)); location.reload(); })()`);
    await sleep(800); await ready();

    // 1. the user's own Connect over IP, then a reload
    eq('fresh page: no radio link by itself', (await sleep(2500), wsLinks), 0);
    await js(`(() => { document.querySelector('#a-type [data-type="ip"]').click(); const u = document.querySelector('#a-url'); u.value = ${JSON.stringify(WSURL)}; u.dispatchEvent(new Event('change')); })()`);
    await js(`document.querySelector('#a-connect').click()`);
    eq('Connect opens the link', await waitFor(() => wsLinks === 1, 8000), true);
    await sleep(2500);   // saveSoon
    const s1 = await settings();
    eq('remembered: ip + the URL', [s1.radioLast && s1.radioLast.type, s1.radioLast && s1.radioLast.url], ['ip', WSURL]);
    eq('remembered: resume on', s1.radioResume, true);
    await reload();
    eq('reload: connects the same way by itself', await waitFor(() => wsLinks === 2, 8000), true);

    // 2. the user's Disconnect, then a reload
    await js(`document.querySelector('#a-disconnect').click()`); await sleep(2500);
    eq('Disconnect: resume off', (await settings()).radioResume, false);
    await reload(); await sleep(3500);
    eq('reload after Disconnect: stays off', wsLinks, 2);

    // 3. the remembered address fails
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.radioResume = true; s.radioLast = { type: 'ip', url: 'ws://127.0.0.1:9/ws?token=s3cret', vid: 0, pid: 0, at: Date.now() }; localStorage.setItem('kelly.settings', JSON.stringify(s)); })()`);
    await reload();
    eq('one "Couldn\'t reconnect" toast', await until(`[...document.querySelectorAll('.toast b')].some(b => /Couldn't reconnect the radio/.test(b.textContent))`, 12000), true);
    await sleep(1500);
    eq('... only one', (await toasts()).filter(t => /Couldn't reconnect the radio/.test(t)).length, 1);
    eq('... no other connect toast', (await toasts()).filter(t => /Could not connect/.test(t)).length, 0);
    eq('... token hidden', await js(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('s3cret'))`), false);
    await js(`[...document.querySelectorAll('.toast')].find(t => /Couldn't reconnect the radio/.test(t.textContent)).click()`); await sleep(700);
    eq('tap: Admin page, Bridge URL focused', await js(`[location.hash, document.activeElement && document.activeElement.id]`), ['#admin', 'a-url']);

    // 4. a Connect-a-phone page in a browser that never pressed Connect
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.radioResume = false; s.radioLast = { type: 'ip', url: ${JSON.stringify(WSURL)}, vid: 0, pid: 0, at: Date.now() }; localStorage.setItem('kelly.settings', JSON.stringify(s)); })()`);
    const before = wsLinks;
    await reload(`http://127.0.0.1:${WEB}/index.html?nosplash&nosw&mesh=meshcore#mesh`); await sleep(4000);
    eq('?mesh= page never takes the radio', wsLinks, before);

    eq('no page errors', errs, []);
  } catch (e) { console.log(`FAIL ${e.message}`); fails.push(e.message); }
  finally { try { ws && ws.close(); } catch {} killTree(br, profile); srv.close(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
  console.log(`RESULT: ${fails.length ? `FAIL (${fails.length})` : 'ALL PASS'}`);
  process.exit(fails.length ? 1 : 0);
})();
