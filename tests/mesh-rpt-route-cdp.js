/* Kelly Page -- LoRa Mesh repeater card: a stale stored route (js/meshrepeaters.js), on the MeshCore demo over CDP.
 * The real case (2026-10-29): a test node was carried from home to work; its contact still said "direct", so every login
 * and status read went nowhere. Here: log in to the demo veranda repeater (route learned: direct), mark it moved
 * (meshcoresim.js s.moved: a stored route no longer arrives), read status -> tried twice, then "Try again by flood"
 * -> route forgotten, status answers by flood.
 *   node tests/mesh-rpt-route-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket)
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
  const pend = new Map(), errors = [];
  try {
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
    if (!tab) throw new Error('browser did not start');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    const card = `document.querySelector('#rp-card').textContent`;
    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await sleep(1500);
    await js(`document.querySelector('button[data-page="mesh"]').click()`);
    await sleep(300);
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click()`);
    await until(`document.querySelectorAll('#mesh-map .mm-wrap').length >= 5`, 15000);
    await sleep(8000);   // the demo's start-up adverts
    const R = '"VK4XXX Veranda Rptr"';
    eq('the veranda repeater is in the card', await js(`(() => { const s = document.querySelector('#rp-sel'); const o = [...s.options].find(o => o.textContent.startsWith(${R})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), true);
    await sleep(300);
    eq('the card shows the stored route (none yet: flood)', await until(`/Route your node has stored: flood/.test(${card})`, 3000), true);
    eq('... with a Trace the route button', await js(`!!document.querySelector('#rp-card [data-rp="trace"]')`), true);
    await js(`(() => { document.querySelector('#rp-pw').value = 'password'; document.querySelector('#rp-login').click(); })()`);
    eq('admin login answers', await until(`/Admin/.test(${card})`, 20000), true);
    await until(`!document.querySelector('#rp-card .rp-busy')`, 40000);   // the login's own status / telemetry / neighbours
    eq('the login taught a route: direct', await until(`/stored: direct/.test(${card})`, 5000), true);
    // it moves away: the "direct" route is stale now
    eq('the demo repeater is marked moved', await js(`(() => { const s = window.KellyMeshDemo.world.find(x => x.name === ${R}); if (!s) return false; s.moved = true; return true; })()`), true);
    await js(`document.querySelector('#rp-card [data-rp="status"]').click()`);
    eq('no answer -> tried once more', await until(`/trying once more/.test(${card})`, 30000), true);
    eq('... then reported, with "Try again by flood"', await until(`!!document.querySelector('#rp-card [data-rp="flood"]')`, 40000), true);
    eq('... naming the direct route as the likely cause', await js(`/by the direct route/.test(${card})`), true);
    eq('... and pointing at Trace Route', await js(`/A short trace often gets through/.test(${card})`), true);
    await js(`document.querySelector('#rp-card [data-rp="flood"]').click()`);
    eq('the route is forgotten (flood)', await until(`/stored: flood/.test(${card})`, 5000), true);
    eq('... and the status answers by flood', await until(`!document.querySelector('#rp-card .rp-err') && !document.querySelector('#rp-card .rp-busy') && /Status/.test([...document.querySelectorAll('#rp-card .rp-h')].map(h => h.textContent).join())`, 30000), true);
    eq('the flood offer is gone', await js(`!document.querySelector('#rp-card [data-rp="flood"]')`), true);
    await js(`document.querySelector('#rp-card [data-rp="trace"]').click()`);
    eq('Trace the route opens the Trace Route tab', await until(`(() => { const b = document.querySelector('[data-tabs="mesh"] [data-tab="trace"]'); return !!b && (b.classList.contains('on') || b.getAttribute('aria-selected') === 'true'); })()`, 5000), true);
    eq('no page errors', errors, []);
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
