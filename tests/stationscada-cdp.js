/* Kelly Page -- Station SCADA tab (js/stationscada-*.js), driven in the REAL page over the Chrome DevTools Protocol:
 *   1. LoRa Mesh > Station SCADA: the simulation runs, the mimic, panels, packet log, annunciator fill in
 *   2. inject a pulled USB cable -> SERIAL LOST unacknowledged -> ACK -> replug -> normal
 *   3. inspector, theme, a component switched off, sound starts muted, the Mesh tab still works (map resized)
 *   4. live source = Kelly's own mesh link, on the MeshCore demo node (js/meshcoresim.js)
 *   node tests/stationscada-cdp.js [path to chrome/msedge] [screenshot.png]     (Node 22+, for its built-in WebSocket)
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

(async () => {
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1200,900',
    'file:///' + path.join(KP, 'index.html').replace(/\\/g, '/') + '?nosplash'], { stdio: 'ignore' });
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
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error')) { const t = m.params.args.map(a => a.value ?? a.description).join(' '); if (/Station SCADA/.test(t)) errs.push(t); }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);

    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    // past the first-run persona picker (it sits over the page in a fresh profile)
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.persona = 'shack'; localStorage.setItem('kelly.settings', JSON.stringify(s)); location.reload(); })()`);
    await sleep(800);
    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await sleep(1200);
    await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`);
    await click('button[data-page="mesh"]'); await sleep(300);
    eq('LoRa Mesh has its tabs, Mesh first', await js(`[...document.querySelectorAll('[data-tabs="mesh"] button')].map(b => b.dataset.tab + (b.classList.contains('on') ? '*' : ''))`), ['main*', 'scada', 'analyser', 'journey', 'trace', 'contacts', 'guard']);
    eq('the Mesh tab still shows the chat and map', await js(`!!document.querySelector('[data-tabpane="mesh:main"].on #mesh-map .leaflet-container, [data-tabpane="mesh:main"].on #mesh-map.leaflet-container')`), true);

    // ---- 1. the simulation
    await click('[data-tabs="mesh"] [data-tab="scada"]');
    eq('Station SCADA tab -> the mimic is built', await until(`!!document.querySelector('#ss-root .ss-mimic') && document.querySelector('[data-tabpane="mesh:scada"]').classList.contains('on')`, 5000), true);
    eq('... equipment tags', await js(`[...document.querySelectorAll('.ss-tag text')].map(t => t.textContent.replace(/^[⚠✖] /, ''))`), ['CMP-01 RAK4631', 'HOST-01 RPI4', 'RPT-01 SOLAR P1']);
    eq('simulation: packets in the log', await until(`document.querySelectorAll('#ss-log tr[data-i]').length >= 3`, 30000), true);
    eq('... neighbours on the horizon', await until(`document.querySelectorAll('#ss-nbr [data-nbr]').length >= 3`, 20000), true);
    eq('... telemetry readouts filled (battery, CPU)', await js(`[document.querySelector('#ss-g-batt .ss-gnum').textContent !== '–', document.querySelector('#ss-g-cpu .ss-gnum').textContent !== '–']`), [true, true]);
    eq('... six annunciator tiles', await js(`document.querySelectorAll('.ss-tile').length`), 6);
    eq('... all ten extra components on', await js(`[...document.querySelectorAll('.ss-comp')].filter(c => !c.hidden).length`), 10);
    eq('... sound starts muted', await js(`document.querySelector('#ss-mute').textContent.includes('off')`), true);
    eq('... status bar shows the SEQ preset', await js(`document.querySelector('#ss-status').textContent.includes('923.125 MHz · BW 62.5 · SF8 · CR4/5')`), true);
    // a pulse / LED can be lit for less than one 250 ms poll: an observer notes any, so a short one isn't missed
    await js(`(() => { const seen = () => document.querySelectorAll('#ss-fx .ss-pulse').length > 0 || !!document.querySelector('.ss-led.tx.on, .ss-led.rx.on, .ss-led.usb.on');
      window.__ssFx = seen(); new MutationObserver(() => { if (seen()) window.__ssFx = true; }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); })()`);
    eq('... a pulse or LED animates on traffic', await until(`window.__ssFx === true`, 20000), true);

    // ---- 2. alarms
    await click('[data-inj="usb"]');
    eq('pull the USB cable -> SERIAL LOST unacknowledged', await until(`[...document.querySelectorAll('.ss-tile.unack b')].some(b => b.textContent === 'SERIAL LOST')`, 5000), true);
    eq('... HOST-01 tag in alarm', await js(`document.querySelector('#ss-tag-host').classList.contains('alarm')`), true);
    eq('... flashing stops after 3 s (nothing flashes forever)', await until(`![...document.querySelectorAll('.ss-tile.flash')].length`, 6000), true);
    await click('#ss-ack');
    eq('ACK -> acknowledged, still lit', await until(`[...document.querySelectorAll('.ss-tile.ack b')].some(b => b.textContent === 'SERIAL LOST')`, 3000), true);
    await click('[data-inj="usb"]');
    eq('replug -> back to normal', await until(`![...document.querySelectorAll('.ss-tile:not(.normal) b')].some(b => b.textContent === 'SERIAL LOST')`, 5000), true);
    eq('... historian logged it', await js(`[...document.querySelectorAll('#ss-hist td')].some(td => /SERIAL LOST/.test(td.textContent))`), true);

    // ---- 3. inspector, theme, components, the Mesh tab
    await js(`document.querySelector('#ss-log tr[data-i]').click()`);
    eq('click a log line -> the inspector decodes it', await until(`/Packet type/.test(document.querySelector('#ss-insp').textContent) && /Airtime/.test(document.querySelector('#ss-insp').textContent)`, 3000), true);
    eq('... with a hex dump', await js(`!!document.querySelector('#ss-insp .ss-hex')`), true);
    await pick('#ss-theme', 'crt');
    eq('CRT theme -> class + remembered', [await js(`document.querySelector('#ss-root').classList.contains('ss-crt')`), await until(`((JSON.parse(localStorage.getItem('kelly.settings') || '{}').stationScada || {}).cfg || {}).theme === 'crt'`, 5000)], [true, true]);
    await pick('#ss-theme', 'control');
    await js(`(() => { const c = document.querySelector('[data-feat="waterfall"]'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    eq('waterfall switched off -> its card hides', await js(`document.querySelector('[data-comp="waterfall"]').hidden`), true);
    await js(`(() => { const c = document.querySelector('[data-feat="waterfall"]'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    // config: a different preset changes the airtime maths and the status bar
    await pick('#ss-preset', 'au915');
    eq('radio preset AU 915 -> status bar', await until(`document.querySelector('#ss-status').textContent.includes('915.800 MHz · BW 250 · SF10')`, 3000), true);
    await pick('#ss-preset', 'seq');
    if (SHOT) {
      await js(`window.scrollTo(0, 0); document.querySelector('#ss-root').scrollIntoView()`); await sleep(1500);
      const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1200, height: 900, scale: 1 } });
      fs.writeFileSync(SHOT, Buffer.from(r.result.data, 'base64')); console.log('screenshot', SHOT);
    }
    await click('[data-tabs="mesh"] [data-tab="main"]'); await sleep(400);
    eq('back to Mesh -> the map has its size', await js(`document.querySelector('#mesh-map').getBoundingClientRect().height > 100`), true);

    // ---- 4. live: Kelly's own mesh link on the MeshCore demo node
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await click('#mesh-go');
    await until(`/ONLINE|online/i.test(document.querySelector('#mesh-state').textContent)`, 20000);
    await click('[data-tabs="mesh"] [data-tab="scada"]'); await sleep(300);
    await pick('#ss-src', 'kelly');
    eq("source = Kelly's mesh link -> LIVE, serial up", await until(`/LIVE/.test(document.querySelector('#ss-status').textContent) && /Serial UP/.test(document.querySelector('#ss-status').textContent)`, 8000), true);
    eq('... the companion panel shows the node\'s radio', await until(`/923\\.125|869|9\\d\\d\\.\\d/.test(document.querySelector('#ss-ro-cmp').textContent)`, 8000), true);
    eq('... live packets / USB frames arrive', await until(`document.querySelectorAll('#ss-log tr[data-i]').length > 0 || !!document.querySelector('.ss-led.usb.on')`, 40000), true);
    eq('... a heard packet fills CMP-01\'s RSSI / SNR / last packet', await until(`(() => { const d = [...document.querySelectorAll('#ss-ro-cmp .ss-ro')].map(r => [r.querySelector('dt').textContent, r.querySelector('dd').textContent]); const v = n => (d.find(x => x[0] === n) || [])[1]; return !!v('RSSI') && v('RSSI') !== '–' && v('Last packet') !== '–'; })()`, 60000), true);
    eq('no Station SCADA errors', errs, []);
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
