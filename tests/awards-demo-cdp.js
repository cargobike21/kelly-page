/* Kelly Page -- awards: "demo never scores, never saves, never sends KF" (kelly-page/AWARDS_REVIEW.md section 8,
 * review/07-build-contract.md), checked in the REAL page over the Chrome DevTools Protocol, once per demo mode:
 *   #mesh-demo-meshcore (the in-page MeshCore sim; then the hash is dropped -- the sim link alone must keep it a demo),
 *   #hc-demo (Ham Contacts' demo world), #tr-demo (Trace Route's demo, one trace run), ?demo (the whole-app demo, with the
 *   Meshtastic demo mesh), and Packet Journey's Demo traffic on an ordinary page (no demo in the address at all).
 * Before any page script runs, an injected script snapshots localStorage kelly.meshQuest* (not meshQuestTab, a UI tab),
 * kelly.meshGold*, kelly.meshPaths.*, logs every write to those keys, and wraps window.KellyFiles.request / .encode
 * (every KF request app.js sends starts there: rfSendContainer(await KF.request(obj))). After ~25 s of traffic each
 * mode asserts: KellyAwards.demo() is on, the keys are unchanged and were never written, zero KF requests.
 *   node tests/awards-demo-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket; one CDP run at a time) */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path');
const BROWSER = process.argv[2] || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const BASE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const TRAFFIC_MS = 25000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (b, what, extra) => { if (b) pass++; else fail++; console.log(`${b ? 'PASS' : 'FAIL'} ${what}${extra != null && extra !== '' ? ' -- ' + extra : ''}`); };

// runs before every page script: the snapshot, the write log, the KF wrapper
const INSTRUMENT = `(() => {
  const RE = /^kelly\\.(meshQuest(?!Tab)|meshGold|meshPaths\\.)/;
  const snap = () => { const o = {}; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (RE.test(k)) o[k] = localStorage.getItem(k); } } catch (e) { o.__err = String(e); } return o; };
  window.__aw = { start: snap(), writes: [], kf: [], snap };
  try {
    const set = Storage.prototype.setItem, rm = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) { try { if (this === window.localStorage && RE.test(String(k))) window.__aw.writes.push(String(k)); } catch (e) {} return set.call(this, k, v); };
    Storage.prototype.removeItem = function (k) { try { if (this === window.localStorage && RE.test(String(k))) window.__aw.writes.push('-' + k); } catch (e) {} return rm.call(this, k); };
  } catch (e) {}
  let kf;
  Object.defineProperty(window, 'KellyFiles', { configurable: true, enumerable: true, get() { return kf; }, set(v) {
    kf = v;
    if (v && typeof v.request === 'function' && !v.__awWrapped) {
      const r = v.request, en = v.encode;
      v.request = function (obj) { window.__aw.kf.push(['request', obj && obj.op]); return r.apply(this, arguments); };
      if (typeof en === 'function') v.encode = function (f) { window.__aw.kf.push(['encode', f && f.kind]); return en.apply(this, arguments); };
      v.__awWrapped = true;
    }
  } });
})();`;

async function mode(name, url, drive) {
  const PORT = 9300 + Math.floor(Math.random() * 600), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1280,1000', 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map(), errs = [];
  console.log(`--- ${name}: ${url.replace(BASE, 'index.html')}`);
  try {
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
    if (!tab) throw new Error('browser did not start');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; errs.push(String((d.exception && d.exception.description) || d.text).slice(0, 300)); }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + ((r.result.exceptionDetails.exception || {}).description || '')); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await js(expr); if (v) return v; } catch { /* page not ready */ } await sleep(250); } return null; };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    await send('Page.navigate', { url });
    ok(!!(await until(`document.readyState === 'complete' && !!window.__aw && !!window.kelly && !!document.querySelector('#mesh-dev')`, 20000)), `${name}: page up, instrumented`);
    await sleep(1500);
    await js(`(() => { const p = document.querySelector('#persona-picker'); if (p) p.hidden = true; return true; })()`);
    await drive(js, until);
    await sleep(TRAFFIC_MS);
    ok(await js(`!!(window.KellyAwards && KellyAwards.demo())`), `${name}: KellyAwards.demo() is on`);
    const r = await js(`(() => { const now = __aw.snap(); return { same: JSON.stringify(now) === JSON.stringify(__aw.start), start: Object.keys(__aw.start), now: Object.keys(now), writes: [...new Set(__aw.writes)], kf: __aw.kf }; })()`);
    ok(r.same, `${name}: meshQuest* / meshGold* / meshPaths.* unchanged`, r.same ? '' : `before ${JSON.stringify(r.start)} after ${JSON.stringify(r.now)}`);
    ok(!r.writes.length, `${name}: never written`, r.writes.join(', '));
    ok(!r.kf.length, `${name}: zero KF requests`, JSON.stringify(r.kf.slice(0, 10)));
    ok(!errs.length, `${name}: no page exceptions`, errs.slice(0, 3).join(' | '));
  } catch (e) { ok(false, `${name}: exception`, e.message); }
  finally {
    try { ws && ws.close(); } catch { /* */ }
    killTree(br, profile);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  }
}

const meshPage = js => js(`(() => { const b = document.querySelector('button[data-page="mesh"]'); if (b) b.click(); return true; })()`);
const pick = (js, sel, v) => js(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
const meshTab = (js, t) => js(`(() => { const b = document.querySelector('[data-tabs="mesh"] [data-tab="${t}"]'); if (b) b.click(); return !!b; })()`);

(async () => {
  // 1. the in-page MeshCore sim: adverts, a CQ on the channel, DMs (P1 Handshakes), then the hash goes -- the link stays a demo
  await mode('MeshCore demo', `${BASE}?nosplash#mesh-demo-meshcore`, async (js, until) => {
    ok(!!(await until(`kelly.mesh() && kelly.mesh().state.status === 'on' && !!window.KellyMeshDemo`, 20000)), 'MeshCore demo: sim link up');
    await js(`(() => { const I = KellyMeshDemo.inject; for (let i = 0; i < 4; i++) { try { I.advert(i); } catch (e) {} } try { I.channel(1, 'CQ CQ anyone about?', 0); } catch (e) {} for (let i = 0; i < 3; i++) { try { I.dm(i, 'Hello from the demo ' + i); } catch (e) {} } return true; })()`);
    await js(`history.replaceState(null, '', location.pathname + location.search + '#mesh'); true`);
    ok(await js(`!!(window.KellyAwards && KellyAwards.demo())`), 'MeshCore demo: still a demo with no demo hash (the sim link, B8)');
    setTimeout(() => js(`(() => { const I = KellyMeshDemo && KellyMeshDemo.inject; if (I) for (let i = 0; i < 3; i++) { try { I.dm(i, 'Second round ' + i); } catch (e) {} } return true; })()`).catch(() => {}), 10000);
  });
  // 2. Ham Contacts' demo world (scripted stations that answer = demo Handshakes, one "yours")
  await mode('Ham Contacts demo', `${BASE}?nosplash#hc-demo`, async (js, until) => {
    ok(!!(await until(`!!(window.kellyHamContacts && kellyHamContacts._c.demo())`, 10000)), 'Ham Contacts demo: on');
    await js(`(async () => { try { const w = kellyHamContacts._c.demoWorld(); for (const s of w.stations.filter(x => !x.on).slice(0, 3)) { try { await kellyHamContacts._c.svc.add(w.cardOf(s.name)); } catch (e) {} } } catch (e) {} return true; })()`);
  });
  // 3. Trace Route's demo: one trace run
  await mode('Trace Route demo', `${BASE}?nosplash#tr-demo`, async (js, until) => {
    ok(!!(await until(`!!(window.kellyTraceRoute && kellyTraceRoute._c.demo())`, 10000)), 'Trace Route demo: on');
    const t = await until(`(() => { const n = kellyTraceRoute._c.nodes().filter(n => n.canTrace)[0]; return n && n.id; })()`, 10000);
    if (t) await js(`(async () => { try { await kellyTraceRoute._c.trace(${JSON.stringify(t)}, { method: 'auto' }); } catch (e) {} return true; })()`);
  });
  // 4. the whole-app demo, with the Meshtastic demo mesh on the LoRa Mesh page
  await mode('?demo', `${BASE}?demo&nosplash#mesh`, async (js, until) => {
    await meshPage(js); await sleep(300);
    await pick(js, '#mesh-dev', 'meshtastic'); await pick(js, '#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click(); true`);
    ok(!!(await until(`kelly.mesh() && kelly.mesh().state.status === 'on'`, 20000)), '?demo: Meshtastic demo mesh up');
  });
  // 5. Packet Journey's Demo traffic on an ordinary page: only its addDemo provider makes it a demo
  await mode('Packet Journey demo traffic', `${BASE}?nosplash#mesh`, async (js, until) => {
    await meshPage(js); await sleep(300); await meshTab(js, 'journey');
    ok(!!(await until(`!!document.querySelector('#pj-demo-btn') && !document.querySelector('#pj-demo-btn').hidden`, 10000)), 'Packet Journey: Demo traffic button');
    await js(`document.querySelector('#pj-demo-btn').click(); true`);
    ok(!!(await until(`!!(window.KellyAwards && KellyAwards.demo())`, 5000)), 'Packet Journey: demo traffic counts as a demo');
  });
  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('RESULT: FAIL', e); process.exit(1); });
