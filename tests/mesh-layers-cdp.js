/* Kelly Page -- the LoRa Mesh map's layers (Phase 6a: js/mesh.js ensureMap / drawMap), driven in the REAL page over the
 * Chrome DevTools Protocol: the layer control lists the six overlays; switching one off removes its markers and is kept;
 * the old P25 checkbox and the control agree; APRS-IS nearby draws Kelly's Nearby APRS stations (seeded in storage).
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
    // seed Kelly's Nearby APRS (normally fetched over P25 from the gateway) before the page loads it
    await until(`document.readyState === 'complete'`);
    await js(`localStorage.setItem('kelly.aprsNear', JSON.stringify({ at: Date.now(), km: 50, rows: [
      { name: 'VK4ABC-9', lat: -27.47, lon: 153.02, sym: '/>', heard: Date.now() - 300000, p25: false, kmh: 60, course: 90, comment: 'mobile' },
      { name: 'VK4XXX', lat: -27.61, lon: 152.76, sym: '/-', heard: Date.now() - 60000, p25: true, kmh: null, course: null, comment: 'home' }] }))`);
    await send('Page.reload');
    await sleep(1500);
    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await sleep(1500);
    await js(`document.querySelector('button[data-page="mesh"]').click()`);
    await sleep(300);
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click()`);
    await until(`document.querySelectorAll('#mesh-map .mm-wrap').length >= 5`, 15000);
    const labels = await js(`[...document.querySelectorAll('#mesh-map .leaflet-control-layers-overlays label')].map(l => l.textContent.trim())`);
    eq('layer control lists the six overlays', labels, ['📡 Mesh nodes', '📻 P25 radios', '🔗 Neighbour links', '🌐 Gateway mesh (via P25)', '🗺️ Coverage (heard direct)', '📍 APRS-IS nearby']);
    const ticks = () => js(`[...document.querySelectorAll('#mesh-map .leaflet-control-layers-overlays input')].map(i => i.checked)`);
    eq('defaults: everything on except Coverage and APRS-IS', await ticks(), [true, true, true, true, false, false]);
    const box = i => js(`document.querySelectorAll('#mesh-map .leaflet-control-layers-overlays input')[${i}].click()`);
    const nodes = () => js(`document.querySelectorAll('#mesh-map .mm-wrap .mm:not(.aprs):not(.p25):not(.gw)').length`);
    const before = await nodes();
    await box(0); await sleep(400);
    eq('Mesh nodes off -> its markers leave the map, and it is remembered', [before > 3, await nodes(), await until(`((JSON.parse(localStorage.getItem('kelly.settings') || '{}').mesh || {}).layers || {}).nodes === false`, 5000)], [true, 0, true]);
    await box(0); await sleep(400);
    eq('... and back on', (await nodes()) === before, true);
    await box(5); await sleep(600);
    eq('APRS-IS nearby on -> both seeded stations drawn, the P25 one marked', await js(`[document.querySelectorAll('#mesh-map .mm.aprs').length, document.querySelectorAll('#mesh-map .mm.aprs.p25').length]`), [2, 1]);
    await js(`(() => { const c = document.querySelector('#ms-p25'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(500);
    eq('the old P25 checkbox off -> the control agrees', (await ticks())[1], false);
    await box(1); await sleep(400);
    eq('the control P25 on -> the old checkbox agrees', await js(`document.querySelector('#ms-p25').checked`), true);
    await box(4); await sleep(600);
    eq('Coverage from the control -> the legend shows, Settings tick agrees', await js(`[!document.querySelector('#mesh-cov-legend').hidden, document.querySelector('#ms-cov').checked]`), [true, true]);
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
