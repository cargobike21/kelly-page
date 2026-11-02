/* Kelly Page -- Coverage layer (js/meshcoverage.js), driven in the REAL page over the Chrome DevTools Protocol:
 *   1. file:// + the MeshCore demo node, Coverage map on -> cells for the stations the demo node hears direct
 *   2. a real bridge (--mesh-sim --mesh-gateway --mesh-history) on a history file seeded with direct and relayed
 *      stations -> only the direct ones are drawn, coloured by SNR, with the legend saying "history"
 *   node tests/mesh-coverage-cdp.js [path to chrome/msedge] [python]     (Node 22+, for its built-in WebSocket)
 * Throwaway browser profile and history file; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn, execFileSync } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path');
const BROWSER = process.argv[2] || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const PY = process.argv[3] || [path.resolve(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe'), '/usr/bin/python3'].find(p => fs.existsSync(p));
const KP = path.resolve(__dirname, '..');
const PORT = 9300 + Math.floor(Math.random() * 500), BPORT = 18040 + Math.floor(Math.random() * 40);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1200,900',
    'file:///' + path.join(KP, 'index.html').replace(/\\/g, '/') + '#mesh'], { stdio: 'ignore' });
  let ws, id = 0, bridge = null;
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
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    const openMesh = async () => {
      await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
      await sleep(1200);
      await js(`document.querySelector('button[data-page="mesh"]').click()`);
      await sleep(300);
    };

    // ---- 1. the demo
    await openMesh();
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click()`);
    await until(`document.querySelectorAll('#mesh-map .leaflet-marker-icon').length >= 3`, 15000);
    eq('coverage off by default: no cells, no legend', await js(`[document.querySelectorAll('#mesh-map .cov-cell').length, document.querySelector('#mesh-cov-legend').hidden]`), [0, true]);
    await js(`(() => { const c = document.querySelector('#ms-cov'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    eq('Coverage map on (demo) -> cells for stations heard direct, legend shown', await until(`document.querySelectorAll('#mesh-map .cov-cell').length >= 1 && !document.querySelector('#mesh-cov-legend').hidden`, 20000), true);
    eq('... legend says "now" (no history in the demo)', await js(`document.querySelector('#mesh-cov-legend').textContent.includes('now')`), true);
    eq('... remembered', await js(`JSON.parse(localStorage.getItem('kelly.settings') || '{}').mesh.coverage`), true);

    // ---- 2. a real bridge with seeded history: 2 direct stations (one strong, one weak), 1 relayed only
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cov-')), hist = path.join(dir, 'h.sqlite');
    execFileSync(PY, ['-c', `
import sys, time; sys.path.insert(0, ${JSON.stringify(path.join(KP, 'bridge'))})
from kelly_mesh_history import MeshHistory
h = MeshHistory(${JSON.stringify(hist)}); t0 = int(time.time() // 60) * 60 - 7200
h.minute = t0
for i in range(5):
    t = t0 + i * 600
    h.add("aaaaaaaaaaaa", "snr0", 9.0, t + 1); h.add("bbbbbbbbbbbb", "snr0", -9.0, t + 2); h.add("cccccccccccc", "snr", 4.0, t + 3)
h.source("aaaaaaaaaaaa", name="Strong Rptr", type="repeater", lat=-27.50, lon=153.00)
h.source("bbbbbbbbbbbb", name="Weak Node", type="companion", lat=-27.40, lon=152.80)
h.source("cccccccccccc", name="Relayed Only", type="companion", lat=-27.30, lon=153.10)
h.flush(t0 + 3600)
`]);
    bridge = spawn(PY, [path.join(KP, 'bridge', 'kelly_bridge.py'), '--port', String(BPORT), '--mesh-sim', '--mesh-gateway', '--mesh-sim-faults', 'quiet',
      '--mesh-outbox', path.join(dir, 'o.sqlite'), '--mesh-history', hist], { stdio: 'ignore' });
    let upB = false;
    for (let i = 0; i < 50 && !upB; i++) { await sleep(200); try { upB = (await fetch(`http://127.0.0.1:${BPORT}/api/mesh-status`)).ok; } catch { /* starting */ } }
    const cv = await (await fetch(`http://127.0.0.1:${BPORT}/api/mesh-history?coverage=1`)).json();
    eq('bridge: /api/mesh-history?coverage=1 lists only the stations heard direct', cv.stations.map(s => s.name).sort(), ['Strong Rptr', 'Weak Node']);
    await send('Page.navigate', { url: `http://127.0.0.1:${BPORT}/#mesh` });
    await sleep(800);
    await openMesh();
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'bridge'); await pick('#mesh-burl', `127.0.0.1:${BPORT}`);
    await js(`document.querySelector('#mesh-go').click()`);
    await js(`(() => { const c = document.querySelector('#ms-cov'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);   // a new origin: its own settings
    eq('link Bridge -> coverage drawn from history (legend says history)', await until(`document.querySelector('#mesh-cov-legend') && !document.querySelector('#mesh-cov-legend').hidden && document.querySelector('#mesh-cov-legend').textContent.includes('history')`, 20000), true);
    const cols = await js(`[...document.querySelectorAll('#mesh-map path.cov-cell')].map(p => p.getAttribute('stroke')).sort()`);
    eq('... a green cell (9 dB) and a red one (-9 dB), the relayed station not drawn', cols.includes('#39ff88') && cols.includes('#ff3b5c') && !cols.includes('#ffd166'), true);
  } catch (e) { console.log(`FAIL exception: ${e.message}`); fails.push('exception'); }
  finally {
    try { ws && ws.close(); } catch { /* */ }
    killTree(br, profile); if (bridge) bridge.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  }
  console.log(`RESULT: ${fails.length ? 'FAIL ' + fails.join(', ') : 'ALL PASS'}`);
  process.exit(fails.length ? 1 : 0);
})();
