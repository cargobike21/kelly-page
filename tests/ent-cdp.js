// Entitlements in the real page (js/entitlements.js + the gates in app.js), over CDP:
//   ?ent=public (a copy without a registration): every gateway page and card hidden, every visible nav entry opens
//   with no toast, no page error, no "waiting" state; a hidden page can't be opened; a text to the gateway is refused
//   and nothing reaches the radio; the demo radio shows everything and hiding comes back when it disconnects;
//   the private build hides nothing.
// Node 22+: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/ent-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const BASE = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/');
const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GATEWAY_PAGES = ['bulletins', 'pbbs', 'share', 'web', 'weather', 'spacewx', 'cams', 'fires', 'solar', 'grid', 'dams', 'insights', 'sstv'];
let pass = 0; const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); };

(async () => {
  const br = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--allow-file-access-from-files', '--no-first-run', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map(), errors = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async expr => { const m = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return m.result && m.result.result && m.result.result.value; };
    const open = async q => { errors.length = 0; await cmd('Page.navigate', { url: `${BASE}?${q}&nofx&nosplash` }); await sleep(6000); };
    const visiblePages = `[...document.querySelectorAll('#nav button[data-page]')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.page)`;
    await cmd('Runtime.enable');

    // ---- public preview, no radio
    await open('ent=public');
    const vis = await js(visiblePages);
    eq('public: no gateway page in the menu', GATEWAY_PAGES.filter(p => vis.includes(p)), []);
    eq('public: open pages still there', ['dashboard', 'mesh', 'igate', 'radio', 'messages', 'gps', 'ble', 'dnp3', 'admin'].every(p => vis.includes(p)), true);
    eq('public: gateway cards hidden', await js(`['#c-sync', '#trk-sync', '#apn-sync', '#apn-list', '#g-locs', '#ku-check', '#ku-auto', '#mb-to', '#slog-send'].filter(s => !document.querySelector(s).closest('[data-ent-hidden]'))`), []);
    eq('public: the GPS page keeps its radio list and own-GPS parts', await js(`['#g-units', '#g-myq', '#ap-on'].filter(s => document.querySelector(s).closest('[data-ent-hidden]'))`), []);
    eq('public: Code Plugs keeps only the local tabs', await js(`[...document.querySelectorAll('[data-tabs="cp"] [data-tab]')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.dataset.tab)`), ['tm9100', 'tm9400']);
    eq('public: no group left empty', await js(`[...document.querySelectorAll('#nav .nav-grp')].filter(s => !s.hidden && !s.querySelector('button[data-page]:not([data-ent-hidden])')).length`), 0);
    // every visible page opens cleanly: no toast, no error
    await js(`window.__toasts = []; new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => __toasts.push(n.textContent)))).observe(document.getElementById('toasts'), { childList: true })`);
    for (const p of vis) { await js(`document.querySelector('#nav [data-page="${p}"]').click()`); await sleep(150); }
    await sleep(1500);
    eq('public: clicking through every visible page -- no toast', await js(`__toasts`), []);
    eq('public: clicking through every visible page -- no page error', errors.slice(), []);
    eq('public: a hidden page cannot be opened', await js(`(document.querySelector('#nav [data-page="weather"]').click(), document.querySelector('.page.active').id)`), 'page-dashboard');
    eq('public: refusals are only in the debug log', await js(`KellyEnt.log.some(e => e.reason === 'ENT_NO_TOKEN' && /showPage weather/.test(e.where))`), true);

    // ---- public preview with the demo radio
    await open('ent=public&demo');
    eq('public + demo: everything shown', await js(`document.querySelectorAll('[data-ent-hidden]').length`), 0);
    eq('public + demo: a gateway page opens', await js(`(document.querySelector('#nav [data-page="weather"]').click(), document.querySelector('.page.active').id)`), 'page-weather');
    eq('demo off again: hidden again, back on the dashboard', await js(`(async () => { await kelly.disconnect(); await new Promise(r => setTimeout(r, 800));
      return [document.querySelectorAll('[data-ent-hidden]').length > 30, document.querySelector('.page.active').id]; })()`), [true, 'page-dashboard']);

    // ---- the send gate: demo radio connected, but as a copy without the feature
    await open('ent=public&demo');
    eq('gate: a text to the gateway is refused silently, nothing goes to the radio', await js(`(async () => {
      KellyEnt.setDemo(false); const n0 = kelly.state.packets.length;
      const r = await kelly.send('d21-' + kelly.settings.relayId + '-6869');
      return [r.ok, r.gated, kelly.state.packets.slice(n0).filter(p => p.dir === 'tx' && p.ident === 'd').length]; })()`), [true, true, 0]);
    eq('gate: a local query still goes to the radio', await js(`(async () => { const n0 = kelly.state.packets.length; await kelly.send('q0');
      return kelly.state.packets.slice(n0).some(p => p.dir === 'tx' && p.ident === 'q'); })()`), true);

    // ---- this copy as it ships: the members' build hides nothing; the public export hides the gateway parts
    await open('x=1');
    const build = await js(`KellyEnt.build`);
    if (build === 'public') eq('public build: gateway parts hidden, no add-on', await js(`[document.querySelectorAll('[data-ent-hidden]').length > 30, typeof window.KellyTaitProgUI]`), [true, 'undefined']);
    else eq('private build: nothing hidden', await js(`document.querySelectorAll('[data-ent-hidden]').length`), 0);
    eq(`${build} build: no page error`, errors.slice(), []);
    ws.close();
  } catch (e) { fails.push('exception'); console.log('FAIL exception ' + (e.stack || e)); }
  finally {
    console.log(fails.length ? `RESULT: FAIL (${fails.length}): ${fails.join(', ')}` : `RESULT: ALL PASS (${pass})`);
    killTree(br, profile); setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
  }
})();
