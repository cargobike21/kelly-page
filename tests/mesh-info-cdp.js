/* Kelly Page -- the node info panel on the LoRa Mesh map (Phase 6b: js/meshinfo.js), driven in the REAL page over the
 * Chrome DevTools Protocol with the MeshCore demo: click a marker -> the panel (details, distance, route history); its
 * buttons (message, trends, trace for a repeater); Escape and ✕ close it.
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
    await js(`document.querySelector('button[data-page="mesh"]').click()`);
    await sleep(300);
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click()`);
    await until(`document.querySelectorAll('#mesh-map .mm-wrap').length >= 5`, 15000);
    await sleep(8000);   // the demo's start-up adverts: route history to show
    eq('no panel until a node is picked', await js(`document.querySelector('#mesh-info').hidden`), true);
    // click the veranda repeater's marker (its short name on the marker)
    const clicked = await js(`(() => { const m = [...document.querySelectorAll('#mesh-map .leaflet-marker-icon')].find(x => x.querySelector('.mm') && !x.querySelector('.mm.me, .mm.p25, .mm.gw, .mm.aprs'));
      if (!m) return null; m.dispatchEvent(new MouseEvent('click', { bubbles: true })); return m.textContent; })()`);
    eq('a node marker found and clicked', !!clicked, true);
    // markers drawn on top of each other open the overlap picker (2026-10-23): it lists them; take the veranda repeater
    const pickRpt = `(() => { const p = document.querySelector('.mesh-pick'); if (!p) return 'no picker';
      const bs = [...p.querySelectorAll('button')], b = bs.find(x => /Rpt/.test(x.textContent)) || bs[0]; b.click(); return bs.length + ' listed'; })()`;
    await sleep(500);
    console.log('     (overlap picker: ' + await js(pickRpt) + ')');
    eq('-> the panel opens with its name, type, ID and position + distance', await until(`(() => { const b = document.querySelector('#mesh-info'); return !b.hidden && /Type/.test(b.textContent) && /ID/.test(b.textContent) && / km [NESW]{1,2}/.test(b.textContent); })()`, 5000), true);
    const name = await js(`document.querySelector('#mesh-info .mi-h b').textContent`);
    eq('... route history: heard via, with SNR', await js(`(() => { const b = document.querySelector('#mesh-info'); return /Heard via/.test(b.textContent) && /dB/.test(b.querySelector('.mi-routes').textContent); })()`), true);
    eq('... a repeater offers Trace route, and Trends (the demo has history)', await js(`[!!document.querySelector('[data-mi="trace"]'), !!document.querySelector('[data-mi="trends"]')]`), [name.includes('Rptr'), true]);
    await js(`document.querySelector('[data-mi="trends"]').click()`);
    await sleep(800);
    eq('📈 Trends -> the trends card switches to that station', await until(`(() => { const s = document.querySelector('#tr-src'); return s && s.value !== 'self' && s.selectedOptions[0].textContent.startsWith(${JSON.stringify(name)}); })()`, 5000), true);
    if (name.includes('Rptr')) eq('a MeshCore repeater has no 💬 Message (it takes no text)', await js(`!document.querySelector('[data-mi="dm"]')`), true);
    else {
      await js(`document.querySelector('[data-mi="dm"]').click()`);
      await sleep(500);
      eq('💬 Message -> a DM tab for it, chosen', await js(`(() => { const t = document.querySelector('#mesh-tabs button.dm.on'); return !!t; })()`), true);
    }
    await js(`document.activeElement && document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    eq('Escape closes the panel', await until(`document.querySelector('#mesh-info').hidden`, 3000), true);
    await js(`[...document.querySelectorAll('#mesh-map .leaflet-marker-icon')].find(x => x.textContent === ${JSON.stringify(clicked)}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(500); await js(pickRpt);
    await until(`!document.querySelector('#mesh-info').hidden`, 3000);
    await js(`document.querySelector('[data-mi="close"]').click()`);
    eq('✕ closes it too', await until(`document.querySelector('#mesh-info').hidden`, 3000), true);
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
