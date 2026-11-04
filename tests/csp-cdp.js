// The hosted copy's Content-Security-Policy (kellypage.app/app/*, set in kellypage-site/_headers), over CDP: Kelly is served
// from a local static server with exactly that header, then index.html?demo opens every menu page and every tab, and
// mesh.html, manual.html and the guides load -- no CSP violation and no page error anywhere. Keep CSP below = _headers.
// Node 22+: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/csp-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), http = require('http'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; worker-src 'self' blob:; " +
  "frame-src https://challenges.cloudflare.com; connect-src 'self' https: wss: ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*; " +
  "img-src 'self' data: blob: https:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; manifest-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
const ROOT = path.join(__dirname, '..');
const PORT = 9800 + Math.floor(Math.random() * 150), WEB = PORT + 200, profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
let pass = 0; const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); };

// the kellypage-site header must be the one tested here (when that repo sits beside this one)
const site = path.join(ROOT, '..', '..', 'kellypage-site', '_headers');
if (fs.existsSync(site)) {
  const m = fs.readFileSync(site, 'utf8').match(/\/app\/\*[\s\S]*?Content-Security-Policy: ([^\r\n]+)/);
  eq('kellypage-site/_headers /app/* CSP = this test\'s CSP', m && m[1], CSP);
}

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname), f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
  fs.createReadStream(f).pipe(res);
}).listen(WEB, '127.0.0.1');

(async () => {
  const br = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map(), errors = [], violations = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      if (m.method === 'Log.entryAdded' && /Content Security Policy/i.test(m.params.entry.text)) violations.push(m.params.entry.text.slice(0, 240));
      if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async expr => { const m = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return m.result && m.result.result && m.result.result.value; };
    const open = async (file, ms = 2500) => { errors.length = 0; violations.length = 0; await cmd('Page.navigate', { url: `http://127.0.0.1:${WEB}/${file}` }); await sleep(ms); };
    await cmd('Runtime.enable'); await cmd('Log.enable'); await cmd('Page.enable');

    await open('index.html?demo&nofx&nosplash', 6000);
    eq('index: Kelly started (kp-missing hidden, CCDI loaded)', await js(`typeof CCDI !== 'undefined' && getComputedStyle(document.getElementById('kp-missing')).display === 'none'`), true);
    // (DevTools' own evaluate is exempt from CSP, so probe with a real inline script element instead of eval)
    eq('index: the CSP header is in force (an inline script does not run)', await js(`(async () => { const s = document.createElement('script'); s.textContent = 'window.__inl = 1';
      document.body.appendChild(s); await new Promise(r => setTimeout(r, 200)); return window.__inl === 1 ? 'ran' : 'blocked'; })()`), 'blocked');
    violations.length = 0;   // that probe's own report
    const pages = await js(`[...document.querySelectorAll('#nav button[data-page]')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.page)`);
    eq('index: a full menu to walk', pages.length > 25, true);
    for (const p of pages) {
      await js(`document.querySelector('#nav [data-page="${p}"]').click()`); await sleep(250);
      await js(`(async () => { for (const b of document.querySelectorAll('.page.active [data-tab]')) { if (b.offsetParent) { b.click(); await new Promise(r => setTimeout(r, 120)); } } })()`);
    }
    await sleep(2000);
    eq('index: sound hint link does not navigate', await js(`(() => { const a = document.querySelector('#snd-hint a'), h = location.hash; a.click(); return location.hash === h; })()`), true);
    eq(`index: every page and tab (${pages.length} pages) -- no CSP violation`, violations.slice(), []);
    eq('index: every page and tab -- no page error', errors.slice(), []);

    for (const f of ['mesh.html', 'manual.html', 'install-pi.html', 'igate-guide.html', 'mesh-buddy-guide.html']) {
      await open(f);
      eq(`${f}: no CSP violation`, violations.slice(), []);
      eq(`${f}: no page error`, errors.slice(), []);
    }
    eq('mesh.html: the launcher script ran (a browser banner is shown)', await (async () => { await open('mesh.html'); return js(`['b-ok','b-bad','b-warn'].some(i => !document.getElementById(i).hidden)`); })(), true);
    ws.close();
  } catch (e) { fails.push('crash: ' + e.message); console.log(e); }
  finally { killTree(br, profile); server.close(); }
  console.log(`\n${pass} passed, ${fails.length} failed\nRESULT: ${fails.length ? 'FAIL' : 'ALL PASS'}`);
  process.exit(fails.length ? 1 : 0);
})();
