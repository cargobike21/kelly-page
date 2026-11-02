/* Kelly Page -- Drive mode (js/meshdrive.js) + offline tiles (js/meshtiles.js), driven in the REAL page over the Chrome
 * DevTools Protocol:
 *   1. file:// + the MeshCore demo: Drive mode off by default; zero-hop advert pings (the default) with Ask who heard me
 *      on the demo's made-up track -> pings gated (500 m AND 60 s, nothing while stopped), discover answers matched to repeaters (a stranger's
 *      post in the window ignored), points on the Coverage layer as "driven" cells, summary, GeoJSON download
 *   2. http://127.0.0.1 (a secure context) from a plain Kelly bridge: Keep map tiles with an "own tile server" (the
 *      bridge serving an image) -> tiles in the Cache API, Save this area (allowBulk only), "cached map" after a reload;
 *      the default (Esri) source never shows Save this area
 *   node tests/meshdrive-cdp.js [path to chrome/msedge] [python]     (Node 22+, for its built-in WebSocket)
 * Throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path');
const BROWSER = process.argv[2] || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const PY = process.argv[3] || [path.resolve(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe'), '/usr/bin/python3'].find(p => fs.existsSync(p));
const KP = path.resolve(__dirname, '..');
const PORT = 9300 + Math.floor(Math.random() * 500), BPORT = 18100 + Math.floor(Math.random() * 40);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-')), dl = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-dl-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const km = (a, b) => { const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };

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
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    const check = (sel, on) => js(`(() => { const c = document.querySelector('${sel}'); c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const openMesh = async () => {
      await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
      // past the first-run persona picker (it sits over the page in a fresh profile)
      await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); if (s.persona) return; s.persona = 'shack'; localStorage.setItem('kelly.settings', JSON.stringify(s)); location.reload(); })()`);
      await sleep(800);
      await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
      await sleep(1200);
      await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`);
      await click('button[data-page="mesh"]'); await sleep(300);
    };
    const demo = async () => {
      await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
      await click('#mesh-go');
      return until(`document.querySelectorAll('#mesh-map .leaflet-marker-icon').length >= 3`, 15000);
    };
    await send('Page.enable');
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });

    // ---- 1. the demo
    await openMesh();
    eq('MeshCore demo up', await demo(), true);
    eq('Drive mode off by default: switch there, card hidden', await js(`[!!document.querySelector('#ms-drive'), document.querySelector('#ms-drive').checked, document.querySelector('#md-card').hidden]`), [true, false, true]);
    await check('#ms-drive', true); await sleep(400);
    eq('Drive mode on: card shown, zero-hop advert by default, Start enabled, Ask who heard me off', await js(`[document.querySelector('#md-card').hidden, document.querySelector('#md-ping').value, document.querySelector('#md-go').disabled, document.querySelector('#md-ask').checked]`), [false, 'advert', false, false]);
    await pick('#md-ping', 'channel'); await sleep(300);
    eq('channel pings: Public is never offered', await js(`[...document.querySelector('#md-ch').options].map(o => o.textContent)`), ['-- pick --', 'P25X']);
    await pick('#md-ch', '1'); await sleep(300);
    eq('... channel picked: Start enabled', await js(`document.querySelector('#md-go').disabled`), false);
    await pick('#md-ping', 'advert'); await sleep(300);
    await check('#md-ask', true); await sleep(300);
    await click('#md-go');
    eq('driving (demo)', await until(`document.querySelector('#md-tag').textContent === 'DRIVING (DEMO)'`, 3000), true);
    eq('the made-up drive ends by itself', await until(`!window.KellyMeshDrive._i.running()`, 45000), true);
    const pts = await js(`window.KellyMeshDrive._i.points()`);
    const pings = [...new Map(pts.map(p => [p.ping, p])).values()].sort((a, b) => a.t - b.t);
    const gaps = pings.slice(1).map((p, i) => ({ s: (p.t - pings[i].t) / 1000, m: km(pings[i], p) * 1000 }));
    console.log(`  ${pings.length} pings, gaps ${gaps.map(g => `${g.s}s/${Math.round(g.m)}m`).join(' ')}`);
    eq('several pings over the drive', pings.length >= 5, true);
    eq('every ping >= 500 m AND >= 60 s after the last (none during the stop)', gaps.every(g => g.s >= 60 && g.m >= 500), true);
    const rpts = [...new Set(pts.filter(p => p.repeater).map(p => p.repeater))].sort();
    eq('discover answers matched to the demo\'s repeaters by key', rpts.includes('VK4XXX Veranda Rptr') && rpts.includes('Mt Coot-tha Rptr') && pts.filter(p => p.repeater).every(p => p.via === 'discover' && p.hops === 0), true);
    eq('... another station\'s discovery in the window ignored, and no repeater twice per ping', [rpts.some(r => /^\?/.test(r)), pts.filter(p => p.hash).length === new Set(pts.filter(p => p.hash).map(p => `${p.ping}|${p.hash}`)).size], [false, true]);
    eq('summary shown: km, pings, repeaters heard, best DX', await js(`(() => { const t = document.querySelector('#md-body .md-sum').textContent; return ['km', 'pings', 'repeaters heard', 'best DX'].every(x => t.includes(x)); })()`), true);
    // the coverage layer's driven source
    eq('driven cells not drawn while Coverage is off', await js(`document.querySelectorAll('#mesh-map path.cov-drive').length`), 0);
    await click('#md-cov'); await sleep(600);
    eq('"Show on the Coverage map" -> driven cells, legend counts the points', await until(`document.querySelectorAll('#mesh-map path.cov-drive').length >= 2 && /driven points/.test(document.querySelector('#mesh-cov-legend').textContent)`, 8000), true);
    eq('... the stations-heard-direct cells still drawn beside them', await js(`document.querySelectorAll('#mesh-map path.cov-cell').length >= 1`), true);
    // GeoJSON download
    await click('#md-geo');
    let file = null; for (let i = 0; i < 30 && !file; i++) { await sleep(200); file = fs.readdirSync(dl).find(f => f.endsWith('.geojson')); }
    const gj = file ? JSON.parse(fs.readFileSync(path.join(dl, file), 'utf8')) : null;
    eq('GeoJSON download: one Point feature per point', gj && [gj.type, gj.features.length, gj.features[0].geometry.type], ['FeatureCollection', pts.length, 'Point']);
    eq('demo points are not kept in IndexedDB', await js(`new Promise(res => { const r = indexedDB.open('kelly-drive', 1); r.onupgradeneeded = () => r.result.createObjectStore('pts', { keyPath: 'id', autoIncrement: true }); r.onsuccess = () => { const q = r.result.transaction('pts').objectStore('pts').count(); q.onsuccess = () => res(q.result); }; r.onerror = () => res(-1); })`), 0);
    // tiles on file:// -- the switch, normal tiles, no Save this area for the default source
    await check('#ms-tiles', true); await sleep(1500);
    eq('Keep map tiles on (file://): the map still has tiles, no Save this area', await js(`[document.querySelectorAll('#mesh-map .leaflet-tile').length > 0, !!document.querySelector('#mesh-map .mt-save')]`), [true, false]);
    await check('#ms-tiles', false);

    // ---- 2. a secure context (http://127.0.0.1) from a plain bridge, an own tile server
    bridge = spawn(PY, [path.join(KP, 'bridge', 'kelly_bridge.py'), '--port', String(BPORT)], { stdio: 'ignore' });
    let upB = false;
    for (let i = 0; i < 50 && !upB; i++) { await sleep(200); try { upB = (await fetch(`http://127.0.0.1:${BPORT}/index.html`)).ok; } catch { /* starting */ } }
    eq('bridge serving Kelly', upB, true);
    await send('Page.navigate', { url: `http://127.0.0.1:${BPORT}/#mesh` });
    await sleep(800);
    await openMesh();
    eq('MeshCore demo up (http://127.0.0.1)', await demo(), true);
    eq('a secure context here', await js(`window.isSecureContext && !!window.caches`), true);
    await check('#ms-tiles', true); await sleep(1000);
    eq('default source: tiles kept but no Save this area (not allowBulk)', await js(`!!document.querySelector('#mesh-map .mt-save')`), false);
    const own = `http://127.0.0.1:${BPORT}/assets/kelly-mark.svg?z={z}&x={x}&y={y}`;
    await pick('#ms-tileown', own);
    const nCache = `caches.open('kelly-tiles-v1').then(c => c.keys()).then(k => k.length)`;
    eq('own tile server: tiles go into the Cache API as they are viewed', await until(`${nCache}.then(n => n >= 4)`, 15000), true);
    eq('... and Save this area is offered (allowBulk)', await until(`!!document.querySelector('#mesh-map .mt-save')`, 5000), true);
    const before = await js(nCache);
    await js(`window.confirm = () => true`);
    await click('#mesh-map .mt-save');
    eq('Save this area: more tiles kept (count + size asked first)', await until(`${nCache}.then(n => n > ${before} + 20)`, 30000), true);
    await until(`!document.querySelector('#mesh-map .mt-save').disabled`, 30000);
    await js(`location.reload()`); await sleep(800);
    await sleep(1500); await openMesh(); await demo(); await until(`!!document.querySelector('#ms-tileown')`, 15000);
    eq('after a reload: "cached map" note', await until(`!!document.querySelector('#mesh-map .mt-cached')`, 15000), true);
    await pick('#ms-tileown', '');
    await sleep(800);
    eq('own server cleared: Save this area gone', await js(`!!document.querySelector('#mesh-map .mt-save')`), false);
  } catch (e) { console.log(`FAIL exception: ${e.message}`); fails.push('exception'); }
  finally {
    try { ws && ws.close(); } catch { /* */ }
    killTree(br, profile); if (bridge) bridge.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(dl, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  }
  console.log(`RESULT: ${fails.length ? 'FAIL ' + fails.join(', ') : 'ALL PASS'}`);
  process.exit(fails.length ? 1 : 0);
})();
