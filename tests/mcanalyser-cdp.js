/* Kelly Page -- the path hash size check + the MeshCore Analyser tab, driven in the REAL page over the Chrome DevTools
 * Protocol with the MeshCore demo node (js/meshcoresim.js):
 *   1. self-check: the demo companion starts on 1-byte (forced here) -> the warning on the connection card; "Set my node
 *      to 2-byte" sends CMD_SET_PATH_HASH_MODE and the warning goes
 *   2. a demo station on 1-byte (Brisbane Bob) adverts -> the alert card names it, with the fix; the log keeps it
 *   3. MeshCore Analyser: the packets are listed, Bob's advert is flagged, its strip has a red path block, the tour runs
 *   4. ▦ on an advert's detail: the shared QR dialog with a contact/add link (name, 64-hex key, type); none on a direct message
 *   node tests/mcanalyser-cdp.js [path to chrome/msedge]     (Node 22+; on this PC VS Code's: see kelly-page/CLAUDE.md)
 * Throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path');
const BROWSER = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const KP = path.resolve(__dirname, '..');
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// the demo companion starts on 1-byte path hashes (its default is 2-byte, as Brisbane/SEQ asks)
const ONE_BYTE = `(() => { let v; Object.defineProperty(window, 'KellyMeshCoreSim', { configurable: true, get: () => v,
  set: x => { v = Object.assign({}, x, { create: o => x.create(Object.assign({}, o, { pathHashMode: 0 })) }); } }); })();`;

(async () => {
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
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
    await send('Page.addScriptToEvaluateOnNewDocument', { source: ONE_BYTE });
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* mid-load */ } await sleep(250); } return false; };
    const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);

    const url = 'file:///' + path.join(KP, 'index.html').replace(/\\/g, '/') + '?nosplash';
    await send('Page.navigate', { url });
    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.persona = 'shack'; localStorage.setItem('kelly.settings', JSON.stringify(s)); })()`);
    await send('Page.navigate', { url: 'about:blank' }); await sleep(300);   // a hash-only change wouldn't reload the page
    await send('Page.navigate', { url: url + '#mesh-demo-meshcore' });
    await until(`document.readyState === 'complete' && !!window.KellyMeshLink`);
    await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`);
    await click('button[data-page="mesh"]');
    eq('demo MeshCore node online', await until(`KellyMeshLink.status() === 'on'`, 20000), true);

    // 1. self-check
    eq('self-check: the warning shows our node on 1-byte', await until(`(() => { const w = document.querySelector('#mesh-hashwarn'); return !w.hidden && /1-byte/.test(w.textContent) && /expects 2-byte/.test(w.textContent); })()`, 8000), true);
    await click('#mesh-hashfix');
    eq('self-check: "Set my node to 2-byte" clears it', await until(`document.querySelector('#mesh-hashwarn').hidden`, 8000), true);

    // 2. a station on 1-byte
    eq('alert card hidden while nobody is on the wrong size', await js(`document.querySelector('#mh-hcard').hidden`), true);
    await js(`KellyMeshDemo.inject.advert(KellyMeshDemo.world.findIndex(s => s.name === 'Brisbane Bob'))`);
    eq('alert card: Brisbane Bob, 1-byte, with the fix', await until(`(() => { const c = document.querySelector('#mh-hcard'); return !c.hidden && /Brisbane Bob/.test(c.textContent) && /1-byte/.test(c.textContent) && /Default Path Hash Size/.test(c.textContent); })()`, 8000), true);
    eq('the mismatch is logged', await js(`(JSON.parse(localStorage.getItem('kelly.meshHashLog') || '[]')).some(e => e.name === 'Brisbane Bob' && e.size === 1 && e.expected === 2 && e.strength === 'certain')`), true);
    await js(`KellyMeshDemo.inject.advert(KellyMeshDemo.world.findIndex(s => s.name === 'Mt Coot-tha Rptr'))`);
    await sleep(800);
    eq('a 2-byte station is not flagged', await js(`!/Coot-tha/.test(document.querySelector('#mh-hcard').textContent)`), true);

    // 3. the analyser
    await click('#mh-hopen');
    eq('the analyser tab opens', await until(`!!document.querySelector('#mca-list') && document.querySelector('[data-tabpane="mesh:analyser"]').offsetHeight > 0`, 5000), true);
    eq('packets are listed', await until(`document.querySelectorAll('#mca-list tr[data-i]').length >= 2`, 8000), true);
    eq('the advert from Bob is flagged in the list', await js(`[...document.querySelectorAll('#mca-list tr[data-i]')].some(tr => /Brisbane Bob/.test(tr.textContent) && tr.querySelector('.mca-hs.bad'))`), true);
    await js(`[...document.querySelectorAll('#mca-list tr[data-i]')].find(tr => /Brisbane Bob/.test(tr.textContent)).click()`);
    eq('its strip: a red path-length block with the warning', await until(`(() => { const b = [...document.querySelectorAll('#mca-detail .mca-blk')]; return b.length > 5 && b.some(x => x.classList.contains('warn') && /Path length/.test(x.textContent)); })()`, 4000), true);
    await js(`document.querySelector('#mca-detail .mca-blk[data-f="1"]').click()`);
    eq('tapping a block explains it', await until(`/hash size/i.test(document.querySelector('#mca-detail .mca-explain').textContent)`, 3000), true);
    eq('the journey ends at our node', await js(`/VK4XXX Kelly Sim/.test(document.querySelector('.mca-journey').textContent)`), true);
    eq('the check panel lists Bob', await js(`/Brisbane Bob/.test(document.querySelector('#mca-hc').textContent)`), true);
    // ▦ an advert's node as a contact QR (decoded key / type / name); nothing on other packets
    eq("advert detail: ▦ Show this node's QR", await js(`!!document.querySelector('#mca-detail #mca-qr')`), true);
    await click('#mca-qr');
    eq('... opens the shared QR dialog', await until(`!!document.querySelector('#mqr:not([hidden]) canvas.mqr-code')`, 4000), true);
    const link = await until(`!!(document.querySelector('#mqr .mqr-link') || {}).value`, 4000) && await js(`document.querySelector('#mqr .mqr-link').value`);
    const q = link ? new URL(link.replace(/^meshcore:\/\//, 'https://x/')).searchParams : null;
    eq('... a contact/add link: Bob, 64-hex key, his advert type', q ? [/^meshcore:\/\/contact\/add\?/.test(link), q.get('name'), /^[0-9a-f]{64}$/.test(q.get('public_key')), ['1', '2', '3', '4'].includes(q.get('type'))] : null, [true, 'Brisbane Bob', true, true]);
    eq('... the QR decodes to that link', await js(`KellyMeshQR.decode(document.querySelector('#mqr canvas'), true)`), link);
    await js(`document.querySelector('#mqr [data-mqr="close"]').click()`);
    await click('#mca-fbad'); await sleep(400);
    eq('"Wrong hash size only" leaves just the flagged packets', await js(`[...document.querySelectorAll('#mca-list tr[data-i]')].every(tr => tr.querySelector('.mca-hs.bad'))`), true);
    await click('#mca-tour');
    eq('guided tour: step 1', await until(`/step 1 of/.test((document.querySelector('.mca-tour') || {}).textContent || '')`, 3000), true);
    for (let i = 0; i < 8; i++) await click('#mca-tnext');
    eq('guided tour: steps through the fields, the current block outlined', await js(`!!document.querySelector('.mca-blk.tour') && /step 9 of/.test(document.querySelector('.mca-tour').textContent)`), true);
    // a capture with a direct message only (the demo world only adverts): no ▦ there
    const capf = path.join(profile, 'dm-capture.txt');
    fs.writeFileSync(capf, '# one TXT_MSG, flood\n09' + '00' + 'aabb' + '1234' + '00'.repeat(16) + '\n');
    const docN = await send('DOM.getDocument', {}), inN = await send('DOM.querySelector', { nodeId: docN.result.root.nodeId, selector: '#mca-load' });
    await send('DOM.setFileInputFiles', { nodeId: inN.result.nodeId, files: [capf] });
    await until(`document.querySelectorAll('#mca-list tr[data-i]').length === 1`, 5000);
    await js(`document.querySelector('#mca-list tr[data-i]').click()`); await sleep(200);
    eq("no ▦ on a packet that isn't an advert", await js(`!!document.querySelector('#mca-detail .mca-sum') && !document.querySelector('#mca-detail #mca-qr')`), true);
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
