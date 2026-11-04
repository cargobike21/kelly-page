/* Kelly Page -- APRS iGate page (js/igateui.js), driven in the REAL page over the Chrome DevTools Protocol, served by a
 * stand-in bridge on 127.0.0.1 with a fake /api/igate (records the config and every line it is asked to send):
 *   1. the page: nav button, SSID -1..-15, CALL-SSID preview, Calculate passcode; the config reaches the bridge
 *   2. the club list: signed by a test admin key (pinned in the page for the test), fetched from an address, accepted
 *      (its stations join MY list); a forged one refused and the good one kept
 *   3. positions: a whitelisted advert -> the bridge gets exactly {src: VK4XXX-9, ...}; a non-whitelisted key, 0,0 and a
 *      raw advert with a bad signature are dropped and counted; a raw advert with a GOOD node signature is gated
 *   4. my list: a heard node with a callsign in its name offered + added; my own entry gates; a removed club entry stays
 *      removed (a stand-in MeshCore link: contacts + a session answering telemetry and status)
 *   5. telemetry: device type, Read the node, swap a slot, save (+ as a device type); the poll (direct routes only) sends
 *      PARM/UNIT/EQNS/BITS then T# through the bridge
 *   6-7. dry run; admin: import a seed, add a station, sign -> v2 here, my list takes it; counters kept, Reset
 *   node tests/igate-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket)
 * Throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const BROWSER = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const KP = path.resolve(__dirname, '..');
const PORT = 9300 + Math.floor(Math.random() * 500), WEB = PORT + 600;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the stand-in bridge
const B = { config: null, lines: [], wl: null };
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav' };
const body = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
const status = () => ({ state: B.config && B.config.on ? (B.config.dry ? 'dry' : 'up') : 'off', on: !!(B.config && B.config.on), server: 'rotate.aprs2.net:14580 (fake)', verified: true, uptime: 60, retryIn: 0, error: '', sent: B.lines.length, dropped: { rate: 0, offline: 0, invalid: 0 }, log: [] });
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${WEB}`), J = (o, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/igate') return J(status());
  if (u.pathname === '/api/igate/config') { B.config = await body(req); return J({ ok: true, status: status() }); }
  if (u.pathname === '/api/igate/send') {
    const b = await body(req); B.lines.push(...(b.lines || []));
    return J({ results: (b.lines || []).map(l => ({ ok: true, packet: `${l.src}>APZKPG,qAO,${B.config.call}:!(fake)` })), status: status() });
  }
  if (u.pathname === '/wl.json') return J(B.wl);
  if (/^\/(api|ws|mesh|ble)/.test(u.pathname)) { res.writeHead(404); return res.end(); }
  const f = path.join(KP, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(KP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => srv.listen(WEB, '127.0.0.1', r));
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
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
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || '')); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    const PAGE = `http://127.0.0.1:${WEB}/index.html?nosplash&nosw`;
    const ready = async () => { await until(`document.readyState === 'complete' && !!window.kelly && !!window.kelly.igate()`); await sleep(800); await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`); };

    await send('Page.navigate', { url: PAGE });
    await sleep(500); await until(`document.readyState === 'complete'`);
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.persona = 'shack'; s.myCall = 'VK4XXX'; localStorage.setItem('kelly.settings', JSON.stringify(s)); location.reload(); })()`);
    await sleep(800); await ready();
    await js(`window.confirm = () => true; window.prompt = () => window.__seed || ''`);

    // ---- 1. the page
    eq('nav button for the page', await js(`!!document.querySelector('#nav button[data-page="igate"]')`), true);
    await js(`document.querySelector('#nav button[data-page="igate"]').click()`);
    eq('SSID choices -1 .. -15', await js(`[...document.querySelectorAll('#ig-ssid option')].map(o => o.textContent).join(',')`), Array.from({ length: 15 }, (_, i) => `-${i + 1}`).join(','));
    eq('callsign filled from the station setup', await js(`document.querySelector('#ig-call').value`), 'VK4XXX');
    eq('CALL-SSID preview (default -10)', await js(`kelly.settings.igate.ssid = 10, kelly.igate().render(), document.querySelector('#ig-preview').textContent`), 'VK4XXX-10');
    await js(`(() => { const e = document.querySelector('#ig-call'); e.value = 'VK4XXXZZ'; e.dispatchEvent(new Event('change')); })()`); await js(`kelly.igate().render()`);
    eq('a bad callsign is called out', await js(`/doesn't look like a callsign/.test(document.querySelector('#ig-call-msg').textContent) && document.querySelector('#ig-preview').textContent`), '—');
    await js(`(() => { const e = document.querySelector('#ig-call'); e.value = 'vk4xxx'; e.dispatchEvent(new Event('change')); })()`);
    // decision 0009: no passcode box -- the bridge keeps it; a new Kelly starts in dry run
    eq('no passcode in the page', await js(`!document.querySelector('#ig-pass') && !('pass' in kelly.settings.igate)`), true);
    eq('dry run is the default', await js(`document.querySelector('#ig-dry').checked`), true);
    await js(`(() => { const e = document.querySelector('#ig-dry'); e.checked = false; e.dispatchEvent(new Event('change')); })()`);
    await js(`(() => { const e = document.querySelector('#ig-on'); e.checked = true; e.dispatchEvent(new Event('change')); })()`);
    eq('the bridge got the config: on, VK4XXX-10, no passcode, vers', await until(`true`) && (await (async () => { for (let i = 0; i < 20 && !(B.config && B.config.on); i++) await sleep(200); return B.config && [B.config.on, B.config.call, 'pass' in B.config, !!B.config.vers, B.config.dry]; })()), [true, 'VK4XXX-10', false, true, false]);

    // a stand-in MeshCore link: three contacts (one with a callsign in its name and a direct route, one without a
    // callsign), a session that answers telemetry + status
    await js(`(() => {
      const nodes = [
        { key: '5a'.repeat(32), longName: 'VK4ZR-1 Solar Rpt', role: 2, hwLabel: 'Repeater', outPath: { sz: 1, h: ['a3'] } },
        { key: '6b'.repeat(32), longName: 'Heltec V3', role: 1, hwLabel: 'Companion', outPath: { sz: 1, h: [] } },
        { key: 'ab'.repeat(32), longName: 'VK4XXX car', role: 1, hwLabel: 'Companion', outPath: null }];
      window.__asked = []; window.__nodes = nodes;
      const sess = { telemetry: async n => { __asked.push(['tlm', n.key.slice(0, 2)]); return [{ ch: 1, type: 116, name: 'voltage', value: 4.05, unit: 'V' }, { ch: 2, type: 103, name: 'temperature', value: 31.5, unit: '°C' }]; },
        status: async n => { __asked.push(['st', n.key.slice(0, 2)]); return { battV: 4.05, noise: -110, rssi: -90, snr: 6, txAirS: 360, rxAirS: 600, uptimeS: 36000, sentFlood: 100, sentDirect: 20, txQueue: 0, errors: 0 }; },
        advert: async () => {}, sharePosition: async () => {} };
      kelly.mesh().igateLink = () => ({ dev: () => 'meshcore', online: () => true, session: () => sess, selfKey: () => '11'.repeat(32), selfName: () => 'VK4XXX Base', nodes: () => nodes, isDemo: () => false });
    })()`);

    // ---- 2. the club list: signed by a test admin, pinned in the page for the test; its stations join MY list
    const keys = await js(`(() => {
      const ad = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5)), t1 = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(6));
      window.__seed = IgateWL.hex(new Uint8Array(32).fill(5)); window.__t1 = t1;
      IgateWL.ADMIN_KEYS.push(IgateWL.hex(ad.publicKey));
      const ed = IgateWL.naclEd(nacl), signer = ed.signer(new Uint8Array(32).fill(5));
      const doc = IgateWL.sign({ v: 1, at: 1761000000, by: 'VK4XXX', e: [
        { k: 'ab'.repeat(32), c: 'VK4XXX', s: 9, y: '/>', m: 'MeshCore car', e: 1, by: 'VK4XXX', at: 1761000000 },
        { k: IgateWL.hex(t1.publicKey), c: 'VK4ZQ', s: 7, y: '/[', m: '', e: 1, by: 'VK4XXX', at: 1761000000 }] }, signer);
      const forged = JSON.parse(JSON.stringify(doc)); forged.b.v = 5;
      return { doc, forged, t1: IgateWL.hex(t1.publicKey) };
    })()`);
    await js(`kelly.igate().render()`);
    eq('before any list: nothing on my list, the state says so', await js(`[kelly.igate().list().e.length, document.querySelector('#ig-state').textContent]`), [0, 'my list is empty']);
    B.wl = keys.doc;
    await js(`(() => { const e = document.querySelector('#ig-wl-url'); e.value = 'http://127.0.0.1:${WEB}/wl.json'; e.dispatchEvent(new Event('change')); document.querySelector('#ig-wl-fetch').click(); })()`);
    eq('signed club list accepted (v1, 2 stations)', await until(`/v1 · 2 stations/.test(document.querySelector('#ig-wl-tag').textContent)`), true);
    await js(`kelly.igate().render()`);
    eq('its 2 stations are on my list, from the club list', await js(`[...document.querySelectorAll('#ig-l-rows tr')].map(r => [r.cells[0].textContent, r.cells[4].textContent]).sort()`), [['VK4XXX-9', 'club list'], ['VK4ZQ-7', 'club list']]);
    B.wl = keys.forged;
    await js(`document.querySelector('#ig-wl-fetch').click()`); await sleep(800); await js(`kelly.igate().render()`);
    eq('forged list refused, v1 kept', await js(`[document.querySelector('#ig-wl-tag').textContent, /signature does not match/.test(document.querySelector('#ig-wl-meta').textContent)]`), ['v1 · 2 stations', true]);

    // ---- 3. positions
    const t0 = B.lines.length;
    await js(`kelly.igate().feed('advert', { key: 'ab'.repeat(32), lat: -27.4545, lon: 152.9876, ts: 1000 })`);
    await js(`kelly.igate().feed('advert', { key: 'cd'.repeat(32), lat: -27.4545, lon: 152.9876, ts: 1000 })`);
    await js(`kelly.igate().feed('advert', { key: 'ab'.repeat(32), lat: 0, lon: 0, ts: 1001 })`);
    for (let i = 0; i < 50 && B.lines.length === t0; i++) await sleep(250);
    eq('a listed advert -> the bridge gets the tracker\'s call + position + symbol + comment', B.lines.slice(t0).map(l => [l.src, l.lat, l.lon, l.sym, l.comment]), [['VK4XXX-9', -27.4545, 152.9876, '/>', 'MeshCore car']]);
    // a raw advert: one with a forged signature, one properly node-signed
    await js(`(() => {
      const kp = window.__t1, ts = 2000, la = Math.round(-27.6 * 1e6), lo = Math.round(152.7 * 1e6);
      // flags 0x91 = chat node + position + NAME: HAM ONLY needs a name starting with the callsign, club list or not
      const nm = new TextEncoder().encode('VK4ZQ Walk'), app = new Uint8Array(9 + nm.length); app[0] = 0x91; new DataView(app.buffer).setInt32(1, la, true); new DataView(app.buffer).setInt32(5, lo, true); app.set(nm, 9);
      const tsb = new Uint8Array(4); new DataView(tsb.buffer).setUint32(0, ts, true);
      const msg = new Uint8Array([...kp.publicKey, ...tsb, ...app]), sig = nacl.sign.detached(msg, kp.secretKey);
      const pay = new Uint8Array([...kp.publicKey, ...tsb, ...sig, ...app]);
      const bad = pay.slice(); bad[40] ^= 1;
      const adv = { key: IgateWL.hex(kp.publicKey), lat: -27.6, lon: 152.7, ts, name: 'VK4ZQ Walk' };
      kelly.igate().feed('raw', { raw: bad, payOff: 0, advert: adv });
      kelly.igate().feed('raw', { raw: pay, payOff: 0, advert: adv });
    })()`);
    for (let i = 0; i < 50 && B.lines.length < t0 + 2; i++) await sleep(250);
    eq('node-signed raw advert gated (VK4ZQ-7)', B.lines.slice(t0 + 1).map(l => l.src), ['VK4ZQ-7']);
    await js(`kelly.igate().render()`);
    const kp = await js(`Object.fromEntries([...document.querySelectorAll('.ig-kpi')].map(x => [x.querySelector('span').textContent, x.querySelector('b').textContent]))`);
    eq('counters: gated 2, heard 5, not on my list 1, invalid 2 (0,0 + bad signature)', [kp.Gated, kp['Heard (MeshCore)'], kp['Not on my list'], kp['Invalid position']], ['2', '5', '1', '2']);
    eq('stations table: aprs.fi link per station', await js(`[...document.querySelectorAll('#ig-stations a')].map(a => a.getAttribute('href')).sort()`), ['https://aprs.fi/#!call=a%2FVK4XXX-9', 'https://aprs.fi/#!call=a%2FVK4ZQ-7']);
    eq('log shows the drop reasons', await js(`/Not on my list/.test(document.querySelector('#ig-log').textContent) && /bad advert signature/.test(document.querySelector('#ig-log').textContent)`), true);

    // ---- 4. my list: an offered node (callsign in its name), my own entry, a removed club entry stays removed
    eq('offered: only the heard node with a callsign in its name, not yet listed', await js(`[...document.querySelectorAll('#ig-l-offer-rows tr')].map(r => [r.cells[0].textContent, r.cells[2].textContent])`), [['VK4ZR-1', '📡 Repeater']]);
    eq('own node: its name carries my callsign', await js(`/carries VK4XXX/.test(document.querySelector('#ig-own-wl').textContent)`), true);
    await js(`document.querySelector('#ig-l-offer-rows button[data-ig-offer]').click(); kelly.igate().render()`);
    eq('added from its node name; no more offers', await js(`[[...document.querySelectorAll('#ig-l-rows tr')].map(r => r.cells[4].textContent).includes('node name'), document.querySelector('#ig-l-offers').hidden]`), [true, true]);
    // HAM ONLY (2026-10-31): a node without a callsign in its name, or listed under someone else's callsign, is refused
    await js(`__nodes.push({ key: 'cd'.repeat(32), longName: 'VK4ZB Home', role: 1, hwLabel: 'Companion', outPath: null }); true`);   // heard now, so it can be listed
    const addTry = (key, call) => js(`(() => { const v = (id, x) => { document.querySelector(id).value = x; }; v('#ig-l-key', '${key}'); v('#ig-l-call', '${call}'); v('#ig-l-ssid', '12'); document.querySelector('#ig-l-add').click(); return kelly.igate().list().e.some(x => x.k === '${key}'); })()`);
    eq('refused: no amateur callsign in its name (Heltec V3)', await addTry('6b'.repeat(32), 'vk4zb'), false);
    eq('refused: listed under a callsign it does not carry', await addTry('cd'.repeat(32), 'vk4zr'), false);
    await js(`(() => { const v = (id, x) => { document.querySelector(id).value = x; }; v('#ig-l-key', 'cd'.repeat(32)); v('#ig-l-call', 'vk4zb'); v('#ig-l-ssid', '12'); v('#ig-l-sym', '/-'); v('#ig-l-comment', 'home node'); document.querySelector('#ig-l-add').click(); })()`);
    const t1 = B.lines.length;
    await js(`kelly.igate().feed('advert', { key: 'cd'.repeat(32), lat: -27.61, lon: 152.76, ts: 3000 })`);
    for (let i = 0; i < 50 && B.lines.length === t1; i++) await sleep(250);
    eq('my own entry gates (VK4ZB-12, house, comment)', B.lines.slice(t1).map(l => [l.src, l.sym, l.comment]), [['VK4ZB-12', '/-', 'home node']]);
    await js(`(() => { const i = kelly.igate().list().e.findIndex(x => x.c === 'VK4ZQ'); document.querySelector('#ig-l-rows button[data-ig-l-del="' + i + '"]').click(); })()`);
    eq('club entry removed from my list', await js(`kelly.igate().list().e.some(x => x.c === 'VK4ZQ')`), false);

    // ---- 5. telemetry for the repeater: device type, read the node, save; the poll sends T# + definitions
    await js(`(() => { const i = kelly.igate().list().e.findIndex(x => x.c === 'VK4ZR'); document.querySelector('#ig-l-rows button[data-ig-l-tlm="' + i + '"]').click(); })()`);
    eq('telemetry editor open for VK4ZR-1', await js(`[document.querySelector('#ig-t').hidden, document.querySelector('#ig-t-title').textContent]`), [false, '📈 Telemetry for VK4ZR-1']);
    await js(`(() => { const e = document.querySelector('#ig-t-type'); e.value = 'repeater'; e.dispatchEvent(new Event('change')); })()`);
    eq('device type fills the slots', await js(`[...document.querySelectorAll('#ig-t-a tr')].map(r => r.querySelector('[data-f=name]').value)`), ['Battery', 'Noise', 'TX air', 'RSSI', 'SNR']);
    await js(`document.querySelector('#ig-t-read').click()`);
    eq('Read: both telemetry and status asked; readings listed', await until(`document.querySelectorAll('#ig-t-reads tr').length >= 10`) && await js(`[__asked.map(a => a.join(':')).join(), /st:battV/.test(document.querySelector('#ig-t-reads').textContent), /ch 2 temperature/.test(document.querySelector('#ig-t-reads').textContent)]`), ['tlm:5a,st:5a', true, true]);
    eq('the live value column: battery 4.05 V -> raw 178 (1.0499.. / 1.5 * 255)', await js(`document.querySelector('#ig-t-a tr').querySelector('[data-now]').textContent.split(' ')[0]`), '178');
    // the owner swaps A5 for the node's temperature reading (unique to this device)
    await js(`(() => { const sel = () => document.querySelectorAll('#ig-t-a tr')[4].querySelector('[data-f=src]');
      let e = sel(); e.value = ''; e.dispatchEvent(new Event('change', { bubbles: true }));
      e = sel(); e.value = 'lpp:2:103'; e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    eq('A5 now the temperature: name + unit from the reading', await js(`[document.querySelectorAll('#ig-t-a tr')[4].querySelector('[data-f=name]').value, document.querySelectorAll('#ig-t-a tr')[4].querySelector('[data-f=unit]').value]`), ['Tempera', 'degC']);
    await js(`(() => { const r = document.querySelectorAll('#ig-t-a tr')[4], set = (f, v) => { const e = r.querySelector('[data-f=' + f + ']'); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }; set('name', 'Temp'); set('min', '-20'); set('max', '63.5'); })()`);
    eq('preview: T# with the five values, PARM with the owner\'s names', await js(`(() => { const t = document.querySelector('#ig-t-prev').textContent; return [/^VK4ZR-1>APZKPG,qAO,VK4XXX-10:T#\\d{3},178,067,010,133,157,00000000$/m.test(t), /:VK4ZR-1  :PARM.Battery,Noise,TX air,RSSI,Temp,LowBat$/m.test(t)]; })()`), [true, true]);
    await js(`document.querySelector('#ig-t-type-save').click()`);
    eq('saved as my own device type', await js(`JSON.parse(localStorage.getItem('kelly.igatePresets') || '[]').length === 1 && [...document.querySelectorAll('#ig-t-type option')].some(o => o.selected && o.value.startsWith('my-'))`), true);
    await js(`document.querySelector('#ig-t-save').click(); kelly.igate().render()`);
    eq('the list shows telemetry on for VK4ZR-1', await js(`[...document.querySelectorAll('#ig-l-rows tr')].find(r => r.cells[0].textContent === 'VK4ZR-1').cells[5].textContent.startsWith('📈')`), true);
    const t2 = B.lines.length;
    for (let i = 0; i < 300 && !B.lines.slice(t2).some(l => /^T#/.test(l.body || '')); i++) await sleep(250);   // the 30 s poll, then one line per 1 s
    const tl = B.lines.slice(t2).filter(l => l.body);
    eq('the poll sent PARM, UNIT, EQNS, BITS, then T#, all for VK4ZR-1', tl.map(l => [l.src, l.body.replace(/^:VK4ZR-1  :/, '').split(/[.#]/)[0]]), [['VK4ZR-1', 'PARM'], ['VK4ZR-1', 'UNIT'], ['VK4ZR-1', 'EQNS'], ['VK4ZR-1', 'BITS'], ['VK4ZR-1', 'T']]);
    eq('T# carries the mapped values (the temperature swapped in)', /^T#\d{3},178,067,010,133,157,00000000$/.test((tl[4] || {}).body || ''), true);
    eq('no node without a direct route was polled', await js(`__asked.filter(a => a[1] !== '5a').length`), 0);

    // ---- 6. dry run reaches the bridge config
    await js(`(() => { const e = document.querySelector('#ig-dry'); e.checked = true; e.dispatchEvent(new Event('change')); })()`);
    await sleep(600);
    eq('dry run -> bridge config dry', B.config.dry, true);

    // ---- 7. admin: import the seed, add a station, sign + keep -> v2 here; my list takes the new one, not the removed one
    await js(`document.querySelector('#ig-admin').open = true; document.querySelector('#ig-adm-imp').click()`);
    eq('admin key loaded + pinned', await until(`/pinned in this release/.test(document.querySelector('#ig-admin-key').textContent)`), true);
    await js(`(() => { const v = (id, x) => { document.querySelector(id).value = x; }; v('#ig-e-key', 'ef'.repeat(32)); v('#ig-e-call', 'VK4ZR'); v('#ig-e-ssid', '5'); v('#ig-e-sym', '/k'); v('#ig-e-comment', 'test truck'); document.querySelector('#ig-e-add').click(); })()`);
    await js(`kelly.igate().render()`);
    eq('draft shows 3 stations + an unpublished change', await js(`[document.querySelectorAll('#ig-wl-rows tr').length, /unpublished/.test(document.querySelector('#ig-pub-msg').textContent)]`), [3, true]);
    await js(`document.querySelector('#ig-pub-file').click()`);
    eq('signed + kept here as v2', await until(`/v2 · 3 stations/.test(document.querySelector('#ig-wl-tag').textContent)`), true);
    eq('v2 is signed by the admin key and verifies', await js(`IgateWL.verify(JSON.parse(localStorage.getItem('kelly.igateWL')).doc, IgateWL.naclEd(nacl)).ok`), true);
    eq('my list: VK4ZR-5 joined from v2, the removed VK4ZQ did not come back', await js(`kelly.igate().list().e.map(x => x.c + '-' + x.s).sort()`), ['VK4XXX-9', 'VK4ZB-12', 'VK4ZR-1', 'VK4ZR-5']);
    eq('my list is kept in the store', await js(`JSON.parse(localStorage.getItem('kelly.igateList')).e.length`), 4);

    // ---- counters persist, then reset
    await sleep(31000);   // the counters' 30 s save
    eq('counters saved in the store (3 positions, 5 telemetry lines)', await js(`(() => { const j = JSON.parse(localStorage.getItem('kelly.igateStats')); return [j.gated, j.tlm.n]; })()`), [3, 5]);
    await js(`document.querySelector('#ig-reset').click(); kelly.igate().render()`);
    eq('reset counters', await js(`[...document.querySelectorAll('.ig-kpi')].find(x => x.querySelector('span').textContent === 'Gated').querySelector('b').textContent`), '0');

    // ---- 8. shared devices (P25) + 🔳 device cards (2026-10-31)
    const KS = '9a'.repeat(32), KQ = '7c'.repeat(32);
    await js(`kelly.igate().gatewayReply({ app: 'igcm', v: 1, e: [{ k: '${KS}', c: 'VK4XYZ', s: 9, y: '/>', m: 'shared car', e: 1, by: 'VK4XYZ', at: 1761000000 },
      { k: 'cd'.repeat(32), c: 'VK4ZB', s: 3, y: '/b', m: '', e: 1, by: 'VK4ZB', at: 1761000000 }] }); kelly.igate().render()`);
    eq('shared list v1 merged: the new station joins as "shared (P25)", my own entry for the same key is untouched',
      await js(`(() => { const L = kelly.igate().list().e; const a = L.find(x => x.k === '${KS}'), b = L.find(x => x.k === 'cd'.repeat(32)); return [a && a.src, a && a.c + '-' + a.s, b.src, b.s]; })()`), ['comm', 'VK4XYZ-9', 'own', 12]);
    eq('the shared card shows v1 and both stations', await js(`[document.querySelector('#ig-cm-tag').textContent, document.querySelectorAll('#ig-cm-rows tr').length]`), ['v1 · 2 stations', 2]);
    const t3 = B.lines.length;
    await js(`kelly.igate().feed('advert', { key: '${KS}', lat: -27.5, lon: 153.0, ts: 4000 })`);
    await sleep(1500);
    eq('a shared station not heard with its callsign is NOT gated (HAM ONLY)', B.lines.length, t3);
    await js(`__nodes.push({ key: '${KS}', longName: 'VK4XYZ Car', role: 1, hwLabel: 'Companion', outPath: null }); kelly.igate().feed('advert', { key: '${KS}', lat: -27.5, lon: 153.0, ts: 4001 })`);
    for (let i = 0; i < 50 && B.lines.length === t3; i++) await sleep(250);
    eq('once its own name carries VK4XYZ it gates', B.lines.slice(t3).map(l => [l.src, l.comment]), [['VK4XYZ-9', 'shared car']]);
    await js(`kelly.igate().gatewayReply({ app: 'igcm', v: 2, e: [{ k: 'cd'.repeat(32), c: 'VK4ZB', s: 3, y: '/b', m: '', e: 1, by: 'VK4ZB', at: 1761000000 }] })`);
    eq('v2 dropped it: it leaves my list', await js(`kelly.igate().list().e.some(x => x.k === '${KS}')`), false);
    // a device card, pasted
    const link = await js(`KellyMeshQR.buildShare({ name: 'VK4QQ Bike', key: '${KQ}', type: 4, c: 'VK4QQ', s: 12, y: '/b', m: 'Mesh Buddy' }).link`);
    await js(`window.prompt = () => ${JSON.stringify(link)}; document.querySelector('#ig-card-paste').click(); true`);
    eq('card: the confirm dialog names VK4QQ-12', await until(`/VK4QQ-12/.test((document.querySelector('[data-mqr="yes"]') || {}).closest ? document.querySelector('[data-mqr="yes"]').closest('div').parentElement.textContent : '')`), true);
    await js(`document.querySelector('[data-mqr="yes"]').click(); kelly.igate().render()`);
    eq('card: added as "QR card", waiting (not heard yet)', await until(`[...document.querySelectorAll('#ig-l-rows tr')].some(r => r.cells[0].textContent === 'VK4QQ-12' && /QR card/.test(r.cells[4].textContent) && /not heard yet/.test(r.cells[4].textContent))`), true);
    // 🔳 on my own row shows a card carrying aprs=
    await js(`(() => { const i = kelly.igate().list().e.findIndex(x => x.c === 'VK4ZB'); document.querySelector('#ig-l-rows button[data-ig-l-qr="' + i + '"]').click(); })()`);
    eq('🔳 shows the device card link', await until(`/aprs=VK4ZB-12/.test((document.querySelector('.mqr-link') || {}).value || '')`), true);
    eq('no page errors', errs, []);
  } catch (e) {
    console.log('FAIL', e.message); fails.push(e.message);
  } finally {
    try { ws && ws.close(); } catch { /* gone */ }
    killTree(br, profile); srv.close();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  }
  console.log(fails.length ? `RESULT: FAIL (${fails.length})` : 'RESULT: ALL PASS');
  process.exit(fails.length ? 1 : 0);
})();
