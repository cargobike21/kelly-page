/* Kelly Page -- awards shared between a member's Kellys through their bridge (js/statesync.js), in the real page over CDP.
 *   0. the merge rule: bridge/kelly_state_vectors.json (kelly_state.py runs the same ones)
 *   1. two browsers (A = the PC, B = the phone), each with its own profile, one stand-in bridge with a real merge:
 *      A earns a badge -> pushed; B starts -> has A's badge before Mesh Quest loads; B earns another -> pushed;
 *      A restarts -> has both; XP is the higher of the two; the token goes in X-Kelly-Token, never in an address
 *   2. a ?demo page doesn't sync
 *   node tests/statesync-cdp.js [path to chrome/msedge]     (Node 22+) */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const BROWSER = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const KP = path.resolve(__dirname, '..');
const BASE = 9300 + Math.floor(Math.random() * 400), WEB = BASE + 700;
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = 'st4te-Tok_7';

// the merge rule, straight from the page's file
global.window = { location: { protocol: 'file:', search: '', hostname: '', host: '' }, localStorage: { getItem() { return null; } } };
require(path.join(KP, 'js', 'statesync.js'));
const S = global.window.KellyStateSync;
for (const v of JSON.parse(fs.readFileSync(path.join(KP, 'bridge', 'kelly_state_vectors.json'), 'utf8'))) eq(`0. merge: ${v.name}`, S.canon(S.merge(v.a, v.b, v.path)), S.canon(v.want));

// the stand-in bridge: Kelly's files + /api/kelly-state (the token in X-Kelly-Token or ?token=; POST merges)
let state = {}, gets = 0, posts = 0, tokInUrl = 0, bad = 0;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${WEB}`);
  if (u.pathname === '/api/kelly-state') {
    const tok = u.searchParams.get('token') || req.headers['x-kelly-token'];
    if (u.searchParams.get('token') && req.method !== 'POST') tokInUrl++;
    const out = (st, j) => { res.writeHead(st, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(j)); };
    if (tok !== TOKEN) { bad++; return out(403, { error: 'token' }); }
    if (req.method === 'GET') { gets++; return out(200, state); }
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      posts++; const j = JSON.parse(body || '{}');
      for (const k of S.KEYS.concat('profile')) if (j[k] != null) state[k] = S.merge(state[k], j[k], [k]);
      out(200, state);
    });
    return;
  }
  if (/^\/(api|ws|mesh|ble)/.test(u.pathname)) { res.writeHead(404); return res.end(); }
  const f = path.join(KP, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(KP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

async function browser(port, label) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `kelly-ss-${label}-`));
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  let tab;
  for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
  if (!tab) throw new Error(`browser ${label} did not start`);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(), errs = [], logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value == null ? '' : String(a.value)).join(' '));
    if (m.method === 'Log.entryAdded') logs.push(`${m.params.entry.text} ${m.params.entry.url || ''}`);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text); return r.result.result.value; };
  const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
  const open = async url => { await send('Page.navigate', { url: 'about:blank' }); await sleep(300); await send('Page.navigate', { url }); await sleep(600); await until(`document.readyState === 'complete' && !!window.KellyStateSync`); await sleep(1200); };
  const close = () => { try { ws.close(); } catch {} killTree(br, profile); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500); };
  return { js, until, open, close, errs, logs };
}
const quest = b => b.js(`JSON.parse(localStorage.getItem('kelly.meshQuest') || 'null')`);
// a station detail typed into its Admin field (change event -> Kelly saves it 400 ms later), then a push
const setField = async (b, sel, val) => { await b.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e.type === 'checkbox') e.checked = ${JSON.stringify(val)}; else e.value = ${JSON.stringify(val)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(700); };
const settingsOf = b => b.js(`JSON.parse(localStorage.getItem('kelly.settings') || '{}')`);
const earn = (b, badge, xp) => b.js(`(() => { const q = JSON.parse(localStorage.getItem('kelly.meshQuest') || '{}'); q.badges = Object.assign(q.badges || {}, { ${JSON.stringify(badge)}: Date.now() }); q.xp = ${xp}; localStorage.setItem('kelly.meshQuest', JSON.stringify(q)); return KellyStateSync.push(false); })()`);

(async () => {
  await new Promise(r => srv.listen(WEB, '127.0.0.1', r));
  const PAGE = `http://127.0.0.1:${WEB}/index.html?nosplash&nosw&token=${TOKEN}`, BARE = `http://127.0.0.1:${WEB}/index.html?nosplash&nosw`;
  let A, B;
  try {
    [A, B] = await Promise.all([browser(BASE, 'A'), browser(BASE + 1, 'B')]);
    // 1. A (the PC) starts on the bridge with the token, earns a badge, pushes it
    await A.open(PAGE);
    eq('A: syncing on a bridge page with a token', await A.js('KellyStateSync.enabled'), true);
    eq('A: pushed its badge', await earn(A, 'pc-dx', 300), true);
    eq('bridge: has A\'s badge', Object.keys((state.meshQuest || {}).badges || {}), ['pc-dx']);
    // B (the phone) starts: A's badge is in its store before Mesh Quest loads
    await B.open(PAGE);
    eq('B: A\'s badge arrived at start', Object.keys((await quest(B) || {}).badges || {}).includes('pc-dx'), true);
    eq('B: ... and Mesh Quest loaded it', await B.js(`(() => { const t = document.body.innerText; return !!(window.KellyStateSync.last && window.KellyStateSync.last.got && window.KellyStateSync.last.got.includes('meshQuest')); })()`), true);
    eq('B: pushed its own badge', await earn(B, 'phone-first-ham', 120), true);
    // 2. station details (2026-10-24): the newest change to each field wins; aprs.on never travels
    await setField(A, '#a-mycall', 'VK4XXX'); await setField(A, '#ap-lat', '-27.6123'); await setField(A, '#ap-on', true);
    await A.js('KellyStateSync.push(false)');
    eq('bridge: has the callsign and position A set, not its beacon switch', [((state.profile || {}).v || {}).myCall, ((state.profile || {}).v || {})['aprs.lat'], 'aprs.on' in (((state.profile || {}).v) || {})], ['VK4XXX', '-27.612300', false]);
    await B.open(PAGE);
    const sb = await settingsOf(B);
    eq('B at start: the callsign and fixed position from A', [sb.myCall, (sb.aprs || {}).lat], ['VK4XXX', '-27.612300']);
    eq('B: ... in the Admin field too', await B.js(`document.querySelector('#a-mycall').value`), 'VK4XXX');
    eq('B: ... but not beaconing (aprs.on stays its own)', !!(sb.aprs || {}).on, false);
    await setField(B, '#a-mycall', 'VK4QQ'); await B.js('KellyStateSync.push(false)');
    // A restarts (no token in the address now: the one mesh.js remembers for this address)
    await A.open(BARE);
    const qa = await quest(A);
    eq('A after a restart: both badges', Object.keys(qa.badges || {}).sort(), ['pc-dx', 'phone-first-ham']);
    eq('A: XP is the higher of the two (300, not 420)', qa.xp, 300);
    const sa = await settingsOf(A);
    eq('A after a restart: the newer callsign from B, its own position and beacon switch', [sa.myCall, (sa.aprs || {}).lat, !!(sa.aprs || {}).on], ['VK4QQ', '-27.612300', true]);
    const qb = (await B.open(PAGE), await quest(B));
    eq('B after a restart: both badges, XP 300', [Object.keys(qb.badges || {}).sort(), qb.xp], [['pc-dx', 'phone-first-ham'], 300]);
    eq('the token never in a GET address', tokInUrl, 0);
    eq('no request refused', bad, 0);
    // (the browser tags its own messages with the page address, which the member opened with ?token= -- not ours)
    eq('the sync never puts the token in the console', A.logs.concat(B.logs).some(l => /kelly-state/.test(l) && l.includes(TOKEN)), false);
    eq('no page errors', A.errs.concat(B.errs), []);
    // 2. a demo page doesn't sync
    for (const x of [A, B]) await x.js(`location.href = 'about:blank'`).catch(() => {});
    await sleep(1500);   // both pages' own pushes on the way out land first
    const g0 = gets, p0 = posts;
    await A.open(`http://127.0.0.1:${WEB}/index.html?nosplash&nosw&demo&token=${TOKEN}`);
    eq('?demo: not syncing, no requests', [await A.js('KellyStateSync.enabled'), gets - g0, posts - p0], [false, 0, 0]);
  } catch (e) { console.log(`FAIL ${e.message}`); fails.push(e.message); }
  finally { for (const b of [A, B]) if (b) b.close(); srv.close(); }
  console.log(`RESULT: ${fails.length ? `FAIL (${fails.length})` : 'ALL PASS'}`);
  setTimeout(() => process.exit(fails.length ? 1 : 0), 1800);
})();
