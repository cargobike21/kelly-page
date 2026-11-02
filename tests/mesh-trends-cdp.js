/* Kelly Page -- Mesh trends (js/meshtrends.js), driven in the REAL page over the Chrome DevTools Protocol:
 *   1. file:// + the MeshCore demo node -> the trends card draws made-up history (tiles, charts, ranges, a station, hover)
 *   2. a real bridge (kelly_bridge.py --mesh-sim --mesh-gateway --mesh-history, on a history file seeded here) serving
 *      the page -> link "Bridge" -> the card reads /api/mesh-history
 *   node tests/mesh-trends-cdp.js [path to chrome/msedge] [python]     (Node 22+, for its built-in WebSocket)
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
    eq('trends card hidden with nothing connected', await js(`document.querySelector('#tr-card').hidden`), true);
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click()`);
    eq('MeshCore demo -> trends card shown with charts', await until(`!document.querySelector('#tr-card').hidden && document.querySelectorAll('#tr-body .tr-chart polyline').length >= 8`, 15000), true);
    eq('... 24 h by the minute, tiles filled', await js(`[document.querySelector('#tr-tag').textContent, document.querySelectorAll('#tr-body .rp-tiles .tile').length]`), ['every minute · demo', 5]);
    eq('... the bridge warnings shown above the charts', await js(`(document.querySelector('#tr-body .tr-warn') || {}).textContent || ''`).then(t => t.includes('channel busy')), true);
    eq('... the min-max band on SNR / RSSI', await js(`!!document.querySelector('[data-tr="tr-snr"] .tr-band') && !!document.querySelector('[data-tr="tr-rssi"] .tr-band')`), true);
    eq('... a gap where the bridge was off breaks the line', await js(`document.querySelectorAll('[data-tr="tr-snr"] polyline').length >= 2`), true);
    await js(`document.querySelector('[data-tr-range="7d"]').click()`);
    eq('7 days -> 15-minute buckets, remembered', await until(`document.querySelector('#tr-tag').textContent === 'every 15 min · demo'`, 5000) && await js(`localStorage.getItem('kelly.meshTrRange')`), '"7d"');
    await js(`document.querySelector('[data-tr-range="1y"]').click()`);
    eq('1 year -> hourly', await until(`document.querySelector('#tr-tag').textContent === 'every hour · demo'`, 5000), true);
    await js(`document.querySelector('[data-tr-range="24h"]').click()`);
    await sleep(300);
    eq('stations listed by name', await js(`[...document.querySelectorAll('#tr-src option')].map(o => o.textContent.split(' · ')[0])`), ['This node', 'VK4XXX Veranda Rptr (repeater)', 'Toowoomba Rptr (repeater)', 'VK4ZR Romeo (companion)']);
    await pick('#tr-src', '3e08c379461c');
    eq('a repeater -> its own charts (SNR, RSSI, hops, distance, DM) plus its battery / noise / airtime / duplicates', await until(`document.querySelectorAll('#tr-body .tr-chart').length === 11 && !!document.querySelector('[data-tr="tr-hops"]') && !!document.querySelector('[data-tr="tr-dup_pct"]')`, 5000), true);
    const before = await js(`document.querySelector('#tr-snr-read').textContent`);
    await js(`document.querySelector('[data-tr="tr-snr"]').scrollIntoView({ block: 'center' })`); await sleep(200);
    const box = await js(`(() => { const r = document.querySelector('[data-tr="tr-snr"] svg').getBoundingClientRect(); return [r.left + r.width * 0.3, r.top + r.height / 2]; })()`);
    await js(`document.querySelector('[data-tr="tr-snr"] svg').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ${box[0]}, clientY: ${box[1]} }))`);
    await sleep(200);
    eq('hover -> the readout shows that time, the cursor line moves', await js(`document.querySelector('#tr-snr-read').textContent !== ${JSON.stringify(before)} && +document.querySelector('#tr-snr-cur').getAttribute('x1') > 0`), true);
    eq('no console errors from the trends module', await js(`!(window.__trErr)`), true);

    // ---- 2. a real bridge with a seeded history
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-hist-')), hist = path.join(dir, 'h.sqlite');
    execFileSync(PY, ['-c', `
import sys, time; sys.path.insert(0, ${JSON.stringify(path.join(KP, 'bridge'))})
from kelly_mesh_history import MeshHistory
h = MeshHistory(${JSON.stringify(hist)}); now = time.time(); t0 = int(now // 60) * 60 - 6 * 3600
h.minute = t0
for i in range(360):
    t = t0 + i * 60
    h.add("self", "snr", 5 + (i % 7), t + 1); h.add("self", "packets", i % 4, t + 2); h.add("self", "batt_v", 4.1, t + 3)
    if i % 30 == 0:
        h.add("aabbccddeeff", "snr", 2.5, t + 4); h.source("aabbccddeeff", name="Seeded Rptr", type="repeater")
h.flush(t0 + 360 * 60 + 1)
`]);
    bridge = spawn(PY, [path.join(KP, 'bridge', 'kelly_bridge.py'), '--port', String(BPORT), '--mesh-sim', '--mesh-gateway', '--mesh-sim-faults', 'quiet',
      '--mesh-outbox', path.join(dir, 'o.sqlite'), '--mesh-history', hist], { stdio: 'ignore' });
    let upB = false;
    for (let i = 0; i < 50 && !upB; i++) { await sleep(200); try { upB = (await fetch(`http://127.0.0.1:${BPORT}/api/mesh-status`)).ok; } catch { /* starting */ } }
    eq('bridge with --mesh-history started', upB, true);
    await send('Page.navigate', { url: `http://127.0.0.1:${BPORT}/#mesh` });
    await sleep(800);
    await openMesh();
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'bridge'); await pick('#mesh-burl', `127.0.0.1:${BPORT}`);   // the page isn't on :8025
    await js(`document.querySelector('#mesh-go').click()`);
    eq('link Bridge -> the card reads the bridge history (6 h of SNR)', await until(`!document.querySelector('#tr-card').hidden && document.querySelectorAll('[data-tr="tr-snr"] polyline').length === 1 && !document.querySelector('#tr-tag').textContent.includes('demo')`, 20000), true);
    eq('... latest SNR shown', await js(`document.querySelector('#tr-snr-read').textContent.trim().split(' ')[0]`), String((5 + 359 % 7).toFixed(1)));
    eq('... the seeded station is offered', await until(`[...document.querySelectorAll('#tr-src option')].some(o => o.textContent.startsWith('Seeded Rptr (repeater)'))`, 5000), true);
    eq('... metrics the bridge never recorded say so', await js(`document.querySelector('[data-tr="tr-noise_floor"]') === null && [...document.querySelectorAll('.tr-empty')].some(e => e.textContent.includes('Noise floor'))`), true);
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
