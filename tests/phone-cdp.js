/* Kelly Page -- Phase 13 phone layout, driven in the REAL page over the Chrome DevTools Protocol at 390 x 844 (a phone):
 *   1. LoRa Mesh: messages, then the map, come first; the other cards fold; tapping a title opens it and it stays open
 *      after a reload; 44 px touch targets
 *   2. BLE Presence > Devices > "My phone as a beacon": an iBeacon ID is made, registered as a person, and the status
 *      goes "not heard yet" -> "seen by your Pi" when a (fake) bridge reports that beacon on a rotating address
 *   node tests/phone-cdp.js [path to chrome/msedge] [screenshot.png]     (Node 22+, for its built-in WebSocket)
 * Throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path');
const BROWSER = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const SHOT = process.argv[3] || '';
const KP = path.resolve(__dirname, '..');
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// a stand-in for the Kelly bridge's /ble WebSocket: the test pushes adverts through window.__fakeBle
const FAKE_BLE = `(() => { const Real = window.WebSocket;
  window.WebSocket = function (url, p) {
    if (!/\\/ble(\\?|$)/.test(String(url))) return new Real(url, p);
    const w = { readyState: 0, url, send() {}, close() { w.readyState = 3; if (w.onclose) w.onclose({}); } };
    window.__fakeBle = w;
    setTimeout(() => { w.readyState = 1; if (w.onopen) w.onopen({}); if (w.onmessage) w.onmessage({ data: JSON.stringify({ t: 'hello', adapters: ['hci0'], zone: 'Home', nodes: [] }) }); }, 50);
    return w;
  };
  window.WebSocket.OPEN = 1; })();`;

(async () => {
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=390,844',
    'about:blank'], { stdio: 'ignore' });
  let ws, id = 0;
  const pend = new Map(), errs = [];
  try {
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
    if (!tab) throw new Error('browser did not start');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_BLE });
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const ready = async () => { await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`); await sleep(1200); await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`); };

    await send('Page.navigate', { url: 'file:///' + path.join(KP, 'index.html').replace(/\\/g, '/') + '?nosplash' });
    await sleep(500); await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.persona = 'shack'; localStorage.setItem('kelly.settings', JSON.stringify(s)); location.reload(); })()`);
    await sleep(800); await ready();
    eq('viewport is a phone', await js('innerWidth'), 390);

    // ---- 1. LoRa Mesh
    await click('button[data-page="mesh"]'); await sleep(400);
    const top = sel => `(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top + scrollY)`;
    // the short page (2026-10-24): connection, messages, Mesh Quest -- nothing else until "Show all"
    eq('short page: only connection, messages, Mesh Quest', await js(`[...document.querySelectorAll('#page-mesh .card, #page-mesh .tabs')].filter(x => x.offsetHeight > 0 && !x.parentElement.closest('.mesh-chatcard, #mq-card')).map(x => x.matches('.mesh-top') ? 'conn' : x.matches('.mesh-chatcard') ? 'msgs' : x.matches('#mq-card') ? 'quest' : (x.id || x.className)).sort()`), ['conn', 'msgs', 'quest']);
    eq('short page: messages above Mesh Quest', await js(`${top('.mesh-chatcard')} < ${top('#mq-card')}`), true);
    eq('short page: "Show all" button >= 44 px', await js(`document.querySelector('.mesh-lite-btn').getBoundingClientRect().height >= 44`), true);
    await click('.mesh-lite-btn'); await sleep(300);
    eq('Show all: the map, tabs and other cards are back', await js(`[document.querySelector('.mesh-mapcard').offsetHeight > 0, document.querySelector('[data-tabs="mesh"]').offsetHeight > 0, document.querySelectorAll('[data-tabpane="mesh:main"] .mesh-fold').length > 0 && [...document.querySelectorAll('[data-tabpane="mesh:main"] .mesh-fold')].some(c => c.offsetHeight > 0)]`), [true, true, true]);
    eq('messages above the map', await js(`${top('.mesh-chatcard')} < ${top('.mesh-mapcard')}`), true);
    eq('map above every other Mesh card', await js(`(() => { const m = ${top('.mesh-mapcard')}; return [...document.querySelectorAll('[data-tabpane="mesh:main"] .mesh-fold')].filter(c => c.offsetParent).every(c => c.getBoundingClientRect().top + scrollY > m); })()`), true);
    const nFold = await js(`document.querySelectorAll('[data-tabpane="mesh:main"] .mesh-fold').length`);
    eq('the other cards are foldable (>= 6)', nFold >= 6, true);
    eq('... and start folded (body hidden, toggle shown)', await js(`[...document.querySelectorAll('[data-tabpane="mesh:main"] .mesh-fold')].every(c => c.classList.contains('folded') && [...c.children].filter(x => !x.matches('.card-h')).every(x => getComputedStyle(x).display === 'none'))`), true);
    eq('fold toggles are 44 px', await js(`(() => { const b = [...document.querySelectorAll('.mesh-foldbtn')].find(x => x.offsetParent); const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`), [44, 44]);
    eq('Connect button >= 44 px tall', await js(`document.querySelector('#mesh-go').getBoundingClientRect().height >= 44`), true);
    const key = await js(`(() => { const c = [...document.querySelectorAll('[data-tabpane="mesh:main"] .mesh-fold')].find(x => x.offsetParent && x.querySelector('.card-h h2')); c.querySelector(':scope > .card-h h2').click(); return c.id || c.querySelector('.card-h h2').textContent; })()`);
    eq('tapping a title opens that card', await js(`[...document.querySelectorAll('[data-tabpane="mesh:main"] .mesh-fold')].filter(c => !c.classList.contains('folded')).length`), 1);
    await js('location.reload()'); await sleep(800); await ready();
    await click('button[data-page="mesh"]'); await sleep(400);
    eq('... and stays open after a reload', await js(`(() => { const c = [...document.querySelectorAll('[data-tabpane="mesh:main"] .mesh-fold')].find(x => (x.id || x.querySelector('.card-h h2').textContent) === ${JSON.stringify(key)}); return !!c && !c.classList.contains('folded'); })()`), true);
    eq('no sideways scroll on the Mesh page', await js(`document.querySelector('#page-mesh').scrollWidth <= document.querySelector('#page-mesh').clientWidth + 1`), true);
    // an iPhone: no Web Bluetooth / Web Serial -> the hint says to use the Kelly bridge link
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    await js('location.reload()'); await sleep(800); await ready();
    await click('button[data-page="mesh"]'); await sleep(300);
    await js(`(() => { Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true }); const e = document.querySelector('#mesh-link'); e.value = 'ble'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    eq('iPhone: the link hint says use the Kelly bridge', await until(`/iPhone and iPad have no Web Bluetooth or Web Serial.*Kelly bridge/.test(document.querySelector('#mesh-hint').textContent)`, 4000), true);
    if (SHOT) { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(SHOT, Buffer.from(s.result.data, 'base64')); }

    // ---- 2. BLE: my phone as a beacon
    await click('button[data-page="ble"]'); await sleep(500);
    await until(`!!document.querySelector('#ble-root [data-tab="devices"]')`, 5000);
    if (!(await js(`/Stop/.test(document.querySelector('#ble-on').textContent)`))) await click('#ble-on');
    await click('#ble-root [data-tab="devices"]'); await sleep(200);
    await click('#ble-root [data-phonenew]'); await sleep(200);
    const ib = await js(`({ uuid: document.querySelector('#bp-uuid').textContent, major: +document.querySelector('#bp-major').textContent, minor: +document.querySelector('#bp-minor').textContent })`);
    eq('the card shows a fresh iBeacon ID', /^[0-9a-f-]{36}$/.test(ib.uuid) && ib.major > 0 && ib.minor > 0, true);
    eq('copy buttons for UUID / major / minor', await js(`[...document.querySelectorAll('#ble-phone-card [data-copy]')].map(b => b.dataset.copy)`), ['uuid', 'major', 'minor']);
    eq('says a web page can\'t transmit BLE', await js(`/can't transmit Bluetooth/.test(document.querySelector('#ble-phone-card').textContent)`), true);
    await click('#bp-save');
    await until(`/"phone":true/.test(localStorage.getItem('kelly.settings') || '')`, 5000);
    const dev = await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); return Object.values((s.ble || {}).devices || {}).find(d => d.phone) || null; })()`);
    eq('registered as a person, telemetry off', dev && [dev.type, dev.match, dev.tlm], ['person', `ib:${ib.uuid}:${ib.major}:${ib.minor}`, false]);
    eq('status before it is heard', await until(`/Not heard yet/.test(document.querySelector('#bp-st').textContent)`, 4000), true);
    const hx = n => n.toString(16).padStart(4, '0');
    const adv = { n: 'local', z: 'Home', ad: 'hci0', ts: Date.now(), a: '5B:11:22:33:44:55', at: 'random', r: -63, tx: null, nm: null, m: { 76: `0215${ib.uuid.replace(/-/g, '')}${hx(ib.major)}${hx(ib.minor)}c5` }, s: {}, u: [] };
    await js(`window.__fakeBle.onmessage({ data: ${JSON.stringify(JSON.stringify({ t: 'advs', list: [adv] }))} })`);
    eq('status: seen by your Pi at -63 dBm', await until(`/Seen by your Pi at -63 dBm/.test(document.querySelector('#bp-st').textContent)`, 5000), true);
    eq('the device row says 📱 phone, with App settings', await js(`(() => { const r = [...document.querySelectorAll('#ble-devs tr[data-dev]')].find(x => /phone/.test(x.textContent)); return !!r && !!r.querySelector('[data-phone]'); })()`), true);
    eq('Devices table stacks (no header row) on a phone', await js(`getComputedStyle(document.querySelector('#ble-devs thead')).display`), 'none');
    eq('BLE tab buttons are 44 px', await js(`document.querySelector('#ble-root .tabs button').getBoundingClientRect().height >= 44`), true);
    eq('no sideways scroll on the BLE page', await js(`document.querySelector('#ble-root').scrollWidth <= document.querySelector('#ble-root').clientWidth + 1`), true);
    eq('no page errors', errs, []);
  } catch (e) {
    console.log('FAIL', e.message); fails.push(e.message);
  } finally {
    try { ws && ws.close(); } catch { /* gone */ }
    killTree(br, profile);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  }
  console.log(fails.length ? `RESULT: FAIL (${fails.length})` : 'RESULT: ALL PASS');
  process.exit(fails.length ? 1 : 0);
})();
