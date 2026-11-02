/* Kelly Page -- install as an app (Phase 13: manifest.webmanifest, sw.js, js/pwa.js) in the REAL page over the Chrome
 * DevTools Protocol, served from a throwaway localhost server (a service worker needs https or localhost):
 *   the manifest parses and the page is installable, the worker takes control and caches the shell (named after
 *   js/version.js), bridge APIs and ?token= requests stay out of the cache, the page reloads with the server DOWN,
 *   a new js/version.js (a release) replaces the cache, ?nosw removes the worker and its caches.
 *   node tests/pwa-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket) */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const BROWSER = process.argv[2] || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const KP = path.resolve(__dirname, '..');
const PORT = 9300 + Math.floor(Math.random() * 500), WEB = PORT + 600;
const ORIGIN = `http://localhost:${WEB}`;
const VER = /KELLY_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(KP, 'js', 'version.js'), 'utf8'))[1];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the bridge's static rules, near enough: kelly-page/ only, /api/* answers 404 here (it's the not-cached check)
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.json': 'application/json' };
let release = null;   // set: js/version.js is served as this version (a release, without touching the real file)
const server = http.createServer((req, res) => {
  const u = new URL(req.url, ORIGIN);
  if (release && u.pathname === '/js/version.js') { res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' }); return res.end(`window.KELLY_VERSION = '${release}';
window.KELLY_BUILT = '2099-01-01';
`); }
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html', f = path.resolve(KP, rel);
  if (!f.startsWith(KP) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(WEB, 'localhost', r));
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', `${ORIGIN}/index.html?nofx&nosplash`], { stdio: 'ignore' });
  let ws, id = 0;
  const pend = new Map();
  try {
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
    if (!tab) throw new Error('browser did not start');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const errs = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* mid-navigation */ } await sleep(250); } return false; };
    const loaded = `document.readyState === 'complete' && typeof CCDI !== 'undefined' && typeof KellyPwa !== 'undefined'`;
    await send('Runtime.enable');
    await until(loaded);

    const man = await send('Page.getAppManifest');
    eq('manifest found, no parse errors', [!!man.result.url, man.result.errors.length], [true, 0]);
    eq('manifest name / display', await js(`fetch('manifest.webmanifest').then(r => r.json()).then(m => [m.name, m.short_name, m.display, m.icons.length])`), ['Kelly Page', 'Kelly', 'standalone', 5]);
    eq('every manifest icon loads', await js(`fetch('manifest.webmanifest').then(r => r.json()).then(m => Promise.all(m.icons.map(i => fetch(i.src).then(r => r.ok)))).then(a => a.every(Boolean))`), true);

    eq('the worker activates', await until(`navigator.serviceWorker.ready.then(r => !!r.active)`, 15000), true);
    eq(`cache named after version.js (kelly-${VER}-dev)`, await js(`caches.keys()`), [`kelly-${VER}-dev`]);
    eq('the shell is cached at install (index.html + scripts + css)', await js(`caches.open('kelly-${VER}-dev').then(c => Promise.all(['index.html', 'js/app.js', 'js/ccdi.js', 'css/kelly.css', 'js/pwa.js', 'manifest.webmanifest'].map(u => c.match(new URL(u, location).href).then(Boolean))))`), [true, true, true, true, true, true]);

    await send('Page.reload'); await sleep(500); await until(loaded);
    eq('after a reload the page is controlled', await js(`!!navigator.serviceWorker.controller`), true);
    const inst = await send('Page.getInstallabilityErrors');
    eq('installable (no installability errors)', (inst.result.installabilityErrors || []).map(e => e.errorId), []);

    await js(`Promise.all([fetch('api/host?token=abc').then(r => r.status), fetch('js/version.js?token=abc').then(r => r.status)])`);
    await sleep(300);
    eq('bridge APIs and ?token= requests are not cached', await js(`caches.open('kelly-${VER}-dev').then(c => c.keys()).then(ks => ks.map(k => k.url).filter(u => /\\/api\\/|token=/.test(u)))`), []);

    // offline: the server goes away entirely, the page still loads (with a token in its address, as a bookmark has)
    await new Promise(r => server.close(r)); server.closeAllConnections && server.closeAllConnections();
    await send('Page.navigate', { url: `${ORIGIN}/?connect=ip&token=secret&nofx&nosplash` }); await sleep(500);
    eq('server down: Kelly still loads from the cache', await until(loaded, 15000), true);
    eq('server down: the "files missing" banner stays hidden', await js(`getComputedStyle(document.getElementById('kp-missing')).display`), 'none');
    eq('the token address was never cached', await js(`caches.open('kelly-${VER}-dev').then(c => c.keys()).then(ks => ks.filter(k => /token=/.test(k.url)).length)`), 0);

    release = '9.9.9';
    await new Promise(r => server.listen(WEB, 'localhost', r));
    await send('Page.navigate', { url: `${ORIGIN}/index.html?nofx&nosplash` }); await sleep(500); await until(loaded);
    eq('a release (new version.js): the new cache replaces the old', await until(`caches.keys().then(k => k.length === 1 && k[0] === 'kelly-9.9.9-2099-01-01')`, 15000), true);
    await send('Page.navigate', { url: `${ORIGIN}/index.html?nosw&nofx&nosplash` }); await sleep(500); await until(loaded);
    // unregister + cache delete take their own time: wait for them (a fixed 1.5 s failed now and then)
    await until(`Promise.all([navigator.serviceWorker.getRegistrations().then(r => r.length), caches.keys().then(k => k.length)]).then(([a, b]) => a + b === 0)`, 10000);
    eq('?nosw: worker and caches gone', await js(`Promise.all([navigator.serviceWorker.getRegistrations().then(r => r.length), caches.keys().then(k => k.length)])`), [0, 0]);
    eq('no page exceptions', errs, []);
  } catch (e) { console.log(`FAIL exception: ${e.message}`); fails.push('exception'); }
  finally {
    try { ws && ws.close(); } catch { /* */ }
    killTree(br, profile);
    try { server.close(); } catch { /* already */ }
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  }
  console.log(`RESULT: ${fails.length ? 'FAIL ' + fails.join(', ') : 'ALL PASS'}`);
  process.exit(fails.length ? 1 : 0);
})();
