'use strict';
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// Packet Journey network canvas tests (tests/pj-net-tests.html) over CDP; a mid-test screenshot goes to %TEMP%\pjnet.png
const url = 'file:///' + path.join(__dirname, 'pj-net-tests.html').split(path.sep).join('/') + (process.argv[2] || '');
const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const br = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1000,900', url], { stdio: 'ignore' });
  let ws, id = 0, shot = 0; const pend = new Map(), errs = [];
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') errs.push('WARN ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 400)); if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result.result.value;
    for (let i = 0; i < 120; i++) {
      const t = await ev('document.title');
      if (t === 'SHOT' && !shot) { shot = 1; const s = await send('Page.captureScreenshot', { clip: { x: 0, y: 0, width: 990, height: 620, scale: 1 } }); fs.writeFileSync(path.join(os.tmpdir(), 'pjnet.png'), Buffer.from(s.result.data, 'base64')); await sleep(2500); }
      if (t === 'DONE') break; await sleep(150);
    }
    console.log(await ev('document.getElementById("out").textContent'));
    if (errs.length) console.log('ERRORS', errs);
  } finally { try { ws && ws.close(); } catch {} killTree(br, profile); }
})();
