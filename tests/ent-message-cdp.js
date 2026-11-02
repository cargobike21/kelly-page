// REFUSAL 'message' in the real page, over CDP (js/entitlements.js + app.js):
//   ?ent=message (a public copy without a registration): a gateway page stays in the menu with a lock and opens a locked
//   card ("Available to registered P25X members. Register at kellypage.app"); a hidden gateway card gets a locked
//   placeholder; a text to the gateway comes back {ok:false, gated:true, reason} with a toast; the demo radio removes the
//   cards again. ?ent=public (silent) shows none of it.
// Node 22+: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/ent-message-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const BASE = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/');
const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TEXT = 'Available to registered P25X members. Register at kellypage.app';
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
    await cmd('Runtime.enable');

    await open('ent=message');
    eq('message: REFUSAL is message', await js(`[KellyEnt.REFUSAL, KellyEnt.messaging, KellyEnt.mode]`), ['message', true, 'public']);
    eq('message: gateway page stays in the menu, marked locked', await js(`(() => { const b = document.querySelector('#nav [data-page="weather"]'); return [getComputedStyle(b).display !== 'none', b.hasAttribute('data-ent-locked')]; })()`), [true, true]);
    eq('message: opening it shows the locked card', await js(`(document.querySelector('#nav [data-page="weather"]').click(), [document.querySelector('.page.active').id, document.querySelector('.page.active').innerText.includes(${JSON.stringify(TEXT.split('.')[0])}), /kellypage\\.app/.test(document.querySelector('.page.active').innerText)])`), ['page-weather-locked', true, true]);
    eq('message: the real page stays hidden', await js(`getComputedStyle(document.querySelector('#page-weather')).display`), 'none');
    eq('message: a hidden card gets a placeholder next to it', await js(`(() => { const c = document.querySelector('#mesh-gw-go'); const card = c && c.closest('.card'); return !!card && card.hasAttribute('data-ent-hidden') && !!card.nextElementSibling && card.nextElementSibling.classList.contains('ent-locked'); })()`), true);
    eq('message: the register link goes to Admin', await js(`(document.querySelector('.page.active [data-ent-reg]').click(), document.querySelector('.page.active').id)`), 'page-admin');
    eq('message: no page error', errors.slice(), []);

    // the send gate (demo radio connected, then taken off the entitlement): refused with the member text and a toast
    await open('ent=message&demo');
    eq('message: a text to the gateway is refused with the member text, a toast, and nothing to the radio', await js(`(async () => {
      KellyEnt.setDemo(false); const n0 = kelly.state.packets.length;
      const r = await kelly.send('d21-' + kelly.settings.relayId + '-6869');
      return [r.ok, r.gated, r.reason, document.getElementById('toasts').textContent.includes('Members only'),
        kelly.state.packets.slice(n0).filter(p => p.dir === 'tx' && p.ident === 'd').length]; })()`), [false, true, TEXT, true, 0]);

    // the demo radio lifts every refusal: placeholders gone, the page opens
    await open('ent=message&demo');
    eq('message + demo: no locked cards, no locked menu entries', await js(`[document.querySelectorAll('.ent-locked, .ent-locked-page').length, document.querySelectorAll('[data-ent-locked]').length]`), [0, 0]);
    eq('message + demo: the page opens', await js(`(document.querySelector('#nav [data-page="weather"]').click(), document.querySelector('.page.active').id)`), 'page-weather');

    // silent preview: none of it
    await open('ent=public');
    eq('public (silent): no locked cards, gateway page not in the menu', await js(`[document.querySelectorAll('.ent-locked, .ent-locked-page, [data-ent-locked]').length, getComputedStyle(document.querySelector('#nav [data-page="weather"]')).display]`), [0, 'none']);
    eq('public (silent): a hidden page cannot be opened', await js(`(document.querySelector('#nav [data-page="weather"]').click(), document.querySelector('.page.active').id)`), 'page-dashboard');
  } finally { killTree(br, profile); }
  console.log(fails.length ? `RESULT: FAIL (${fails.join(', ')})` : `RESULT: ALL PASS (${pass})`);
  process.exit(fails.length ? 1 : 0);
})();
