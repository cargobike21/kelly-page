/* Kelly Page -- the LoRa Mesh outbox (js/mesh.js store-and-forward), driven in the REAL page over the Chrome DevTools
 * Protocol: MeshCore picked but not connected -> a message is queued (📮, kept in localStorage); then the MeshCore demo
 * node connects -> the queued message goes out on its own.
 *   node tests/mesh-outbox-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket)
 * Uses a throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path');
const BROWSER = process.argv[2] || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/') + '#mesh';
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', PAGE], { stdio: 'ignore' });
  let ws, id = 0;
  const pend = new Map();
  try {
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
    if (!tab) throw new Error('browser did not start');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await sleep(1500);
    await js(`document.querySelector('button[data-page="mesh"]').click()`);   // the LoRa Mesh page, as a user opens it
    await sleep(300);
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    eq('device MeshCore, link USB (nothing connected)', [await pick('#mesh-dev', 'meshcore'), await pick('#mesh-link', 'usb')], ['meshcore', 'usb']);
    eq('offline MeshCore: the Send button offers to queue', await until(`document.querySelector('#mesh-send').textContent === '📮 Queue' && !document.querySelector('#mesh-send').disabled`, 3000), true);
    await js(`(() => { const t = document.querySelector('#mesh-text'); t.value = 'outbox check 1'; document.querySelector('#mesh-send').click(); })()`);
    await sleep(500);
    const box = await js(`JSON.parse(localStorage.getItem('kelly.meshOutbox.meshcore') || '[]').map(o => o.text)`);
    eq('send while not connected -> kept in the outbox', box, ['outbox check 1']);
    eq('... and shown with the queued tick', await until(`[...document.querySelectorAll('#mesh-chat .mt-st')].some(i => i.textContent === '📮')`, 3000), true);
    eq('... with a toast saying so', await js(`document.body.textContent.includes("isn't connected")`), true);
    // now the MeshCore demo node comes online: the outbox goes out by itself
    await pick('#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click()`);
    const gone = await until(`JSON.parse(localStorage.getItem('kelly.meshOutbox.meshcore') || '[]').length === 0`, 20000);
    eq('connected -> the outbox is sent and emptied', gone, true);
    eq('... the message no longer shows as queued', await until(`![...document.querySelectorAll('#mesh-chat .mt-st')].some(i => i.textContent === '📮')`, 5000), true);
  } catch (e) { console.log(`FAIL exception: ${e.message}`); fails.push('exception'); }
  finally {
    try { ws && ws.close(); } catch { /* */ }
    killTree(br, profile);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  }
  console.log(`RESULT: ${fails.length ? 'FAIL ' + fails.join(', ') : 'ALL PASS'}`);
  process.exit(fails.length ? 1 : 0);
})();
