'use strict';
// LoRa Mesh > 🐕 Mesh Buddy over CDP, on a fake Web Serial RAK4631 (see FAKE): the HAM ONLY identity (Kelly's own VK/ZL
// callsign), a full flash through a simulated Adafruit bootloader (image byte for byte), the USB-CLI setup, refusals.
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/meshbuddy-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const base = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (b, what, extra) => { if (b) pass++; else fail++; console.log(`${b ? 'PASS' : 'FAIL'} ${what}${extra != null ? ' -- ' + extra : ''}`); };

async function page(hash, fn, shot) {
  const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
  const br = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1300,1100', `${base}?demo&nosplash&nofx${hash}`], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map(), errs = [];
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) { const t = m.params.args.map(a => a.value || a.description).join(' '); if (/Mesh Buddy|MeshPRS|mprs|APRS iGate|Packet Journey/.test(t)) errs.push(t.slice(0, 400)); }
      if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result.exceptionDetails ? { __err: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description } : r.result.result.value; };
    const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await ev(x); if (v && !v.__err) return v; await sleep(250); } return null; };
    await fn(ev, until);
    if (shot) { await ev(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true); document.getElementById('ig-find').scrollIntoView(); true`); await sleep(800); const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(os.tmpdir(), shot), Buffer.from(s.result.data, 'base64')); }
    ok(!errs.length, 'no exceptions / warnings', errs.slice(0, 3).join(' | '));
  } finally { try { ws && ws.close(); } catch {} killTree(br, profile); }
}


// a fake Web Serial RAK4631: the app port (Mesh Buddy's USB CLI, or another firmware), the 1200-baud touch that turns
// it into the bootloader port (PID 0x002A), a bootloader that CRC-checks every DFU frame and rebuilds the image
const FAKE = (fw, grantBoot) => `(() => {
  const VID = 0x239A, enc = new TextEncoder(), dec = new TextDecoder();
  const T = window.__mbT = { fw: '${fw}', cmds: [], present: new Set(['app']), image: [], frames: 0, bad: 0, flashed: false, touched: 0, requests: 0, cfg: {} };
  function cliReply(c) {
    T.cmds.push(c);
    if (T.fw !== 'Mesh Buddy') return T.fw === 'MeshCore' ? 'Unknown command' : null;
    if (c === 'mprs') return 'Mesh Buddy 1.0 ON ' + (T.cfg.call || 'NOCALL') + ' ' + (T.cfg.sym || '/b') + ' flood every smart fix NO 0 sats; sent 0 (last 0s ago N=0) seq 9 spd 0';
    let m;
    if ((m = /^mprs (\\w+) ?(.*)$/.exec(c))) { T.cfg[m[1]] = m[2]; return 'OK'; }
    if (c.startsWith('set radio ')) return 'OK - reboot to apply';
    if (c.startsWith('set ')) return 'OK';
    if ((m = /^password (.+)$/.exec(c))) { T.pass = m[1]; return 'password now: ' + m[1]; }
    if (c === 'get public.key') return '> ' + 'AB'.repeat(32);
    if (c === 'reboot') return null;
    return 'Unknown command';
  }
  function mkPort(kind) {
    let sink = null, line = '', fr = [];
    const send = s => { try { sink && sink.enqueue(typeof s === 'string' ? enc.encode(s) : s); } catch (e) {} };
    function dfuFrame(f) {
      const b = KellyDfu.unslip(f), len = (b[1] >> 4) | (b[2] << 4), crc = b[4 + len] | (b[5 + len] << 8);
      if (KellyDfu.crc16(b.slice(0, 4 + len)) !== crc) { T.bad++; return; }
      T.frames++; const op = b[4];
      if (op === 4) for (const x of b.slice(8, 4 + len)) T.image.push(x);
      if (op === 5) { T.flashed = true; setTimeout(() => { T.present.delete('boot'); T.present.add('app'); T.fw = 'Mesh Buddy'; }, 300); }
      send(Uint8Array.from([0xC0, (((b[0] & 7) + 1) % 8) << 3, 0, 0, 0xC0]));
    }
    function onData(u) {
      if (kind === 'boot') { for (const x of u) { if (x !== 0xC0) fr.push(x); else if (fr.length) { dfuFrame(fr); fr = []; } } return; }
      line += dec.decode(u);
      let i; while ((i = line.indexOf('\\r')) >= 0) { const c = line.slice(0, i); line = line.slice(i + 1); const r = cliReply(c); if (r != null) send(c + '\\r\\n  -> ' + r + '\\r\\n'); }
    }
    const port = { kind, getInfo: () => ({ usbVendorId: VID, usbProductId: kind === 'boot' ? 0x002A : 0x8029 }), readable: null, writable: null,
      async open(o) {
        if (!T.present.has(kind)) throw new Error('The device has been lost.');
        if (kind === 'app' && o.baudRate === 1200) { T.touched++; port._touch = true; return; }
        port.readable = new ReadableStream({ start(c) { sink = c; } });
        port.writable = new WritableStream({ write(chunk) { onData(Uint8Array.from(chunk)); } });
      },
      async close() {
        if (port._touch) { port._touch = false; T.present.delete('app'); setTimeout(() => T.present.add('boot'), 400); }
        try { sink && sink.close(); } catch (e) {} sink = null; port.readable = port.writable = null;
      },
      async setSignals() {} };
    return port;
  }
  const ports = { app: mkPort('app'), boot: mkPort('boot') };
  Object.defineProperty(navigator, 'serial', { configurable: true, value: {
    requestPort: async () => { T.requests++; return ports[T.present.has('boot') ? 'boot' : 'app']; },
    getPorts: async () => [...T.present].filter(k => k === 'app' || ${grantBoot ? 'true' : 'false'}).map(k => ports[k]) } });
  return true;
})()`;

(async () => {
  await page('?demo&nofx&nosplash', async (ev, until) => {
    ok(await until('!!(window.kellyMeshBuddy && document.querySelector("#mb-root .mb"))', 15000), 'Mesh Buddy tab rendered');
    await ev(`kelly.showPage('mesh'); document.querySelector('[data-tabs="mesh"] [data-tab="buddy"]').click(); true`);
    // HAM ONLY: the callsign is Kelly's own, VK / ZL only
    const st = async call => ev(`(() => { kelly.settings.myCall = ${JSON.stringify(call)}; kellyMeshBuddy.shown(); const s = kellyMeshBuddy.state();
      return { problem: s.problem, call: s.call, name: s.name, disabled: document.getElementById('mb-flash').disabled, warn: (document.querySelector('#mb-root .mb-warn') || {}).textContent || '' }; })()`);
    const a = await st('');
    ok(a && /Set your callsign first/.test(a.problem) && a.disabled, 'no callsign in Admin: refused, buttons off', JSON.stringify(a));
    const b = await st('K1ABC');
    ok(b && /isn't a VK or ZL amateur callsign/.test(b.problem) && b.disabled, 'a non-VK/ZL callsign: refused', JSON.stringify(b));
    const c = await st('vk4xxx');
    ok(c && !c.problem && c.call === 'VK4XXX-12' && c.name === 'VK4XXX Buddy' && !c.disabled, 'VK4XXX: goes on air as VK4XXX-12 named "VK4XXX Buddy"', JSON.stringify(c));
    ok(await ev(`/VK4XXX-12/.test(document.querySelector('#mb-root .mb-id').textContent)`), 'the identity line shows it');

    // ⚡ flash a Meshtastic kit: touch -> bootloader port (not granted yet: one more click) -> DFU -> setup
    ok(await ev(FAKE('Meshtastic', false)), 'fake tracker plugged in (Meshtastic, bootloader port not yet granted)');
    await ev(`document.getElementById('mb-flash').click(); true`);
    ok(await until(`!!document.getElementById('mb-pick')`, 15000), 'asks for one more click to choose the bootloader port');
    await ev(`document.getElementById('mb-pick').click(); true`);
    const r = await until(`(() => { const s = kellyMeshBuddy.state(); return s.result || (!s.busy && s.log.some(l => l.startsWith('✖')) ? { err: s.log.join(' | ') } : null); })()`, 150000);
    ok(r && r.key && !r.err, 'flash + set up finished', JSON.stringify(r).slice(0, 400));
    const t = await ev(`(async () => { const T = window.__mbT, img = Uint8Array.from(T.image);
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', img))].map(b => b.toString(16).padStart(2, '0')).join('');
      const meta = await new Promise(res => { const x = new XMLHttpRequest(); x.open('GET', 'firmware/mesh-buddy/firmware.json'); x.responseType = 'json'; x.onload = () => res(x.response); x.send(); });
      return { touched: T.touched, bad: T.bad, frames: T.frames, n: img.length, size: meta.size, ok: sha === meta.sha256, flashed: T.flashed, cmds: T.cmds, pass: T.pass, requests: T.requests }; })()`);
    ok(t && t.touched === 1, '1200-baud touch sent once', t && t.touched);
    ok(t && t.bad === 0 && t.flashed, 'every DFU frame CRC-good, stop packet reached', t && JSON.stringify({ bad: t.bad, flashed: t.flashed }));
    ok(t && t.ok && t.n === t.size, `the bootloader rebuilt firmware/mesh-buddy byte for byte (${t && t.n} bytes, sha-256 = firmware.json)`);
    const want = ['set name VK4XXX Buddy', 'mprs call VK4XXX-12', 'mprs sym /b', 'mprs comment Mesh Buddy', 'mprs route flood', 'mprs every 0', 'mprs min 120', 'mprs tlm on', 'set radio 923.125,62.5,8,5', 'set tx 22', 'get public.key'];
    ok(t && want.every(w => t.cmds.includes(w)), 'set up: name, call, symbol, comment, flood, smart beaconing, min 120, telemetry, SEQ radio, 22 dBm', t && t.cmds.join(' / '));
    ok(t && t.cmds[t.cmds.length - 1] === 'reboot', 'ends with a reboot');
    ok(t && /^[A-Za-z0-9]{12}$/.test(t.pass || '') && r.pass === t.pass, 'a new random 12-character admin password, shown to the owner');
    ok(await ev(`(() => { const u = JSON.parse(localStorage.getItem('kelly.meshBuddy') || localStorage.getItem('meshBuddy') || 'null') || (kellyMeshBuddy.state().units && { units: kellyMeshBuddy.state().units }); return !!(u && u.units && u.units.some(x => x.call === 'VK4XXX-12' && x.key === 'ab'.repeat(32))); })()`), 'kept under My Mesh Buddies');
    ok(await ev(`!!document.querySelector('#mb-root .mb-done') && /VK4XXX-12 is ready/.test(document.querySelector('#mb-root .mb-done').textContent)`), 'done card shown');

    // ⚙️ set up only, on a tracker that isn't running Mesh Buddy: refused, nothing written
    await ev(FAKE('MeshCore', true));
    await ev(`document.getElementById('mb-setup').click(); true`);
    const e = await until(`(() => { const s = kellyMeshBuddy.state(); return !s.busy && s.log.length ? s.log.join(' | ') : null; })()`, 20000);
    ok(e && /isn't running Mesh Buddy/.test(e), 'set up only on another firmware: refused', e);
    ok(await ev(`window.__mbT.cmds.join(',') === 'mprs'`), '... after asking "mprs" only -- nothing else sent');

    // ⚙️ set up only on a Mesh Buddy: patchy coverage + my local mesh's radio settings + 17 dBm
    await ev(FAKE('Mesh Buddy', true));
    await ev(`(() => { const sel = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
      sel('mb-preset', 'custom'); sel('mb-f', '916.5'); sel('mb-bw', '125'); sel('mb-sf', '9'); sel('mb-cr', '5'); sel('mb-tx', '17');
      const p = document.getElementById('mb-patchy'); p.checked = true; p.dispatchEvent(new Event('change'));
      const w = document.getElementById('mb-word'); w.value = 'Ute|~'; w.dispatchEvent(new Event('change'));
      const s = document.getElementById('mb-ssid'); s.value = '9'; s.dispatchEvent(new Event('change')); return true; })()`);
    await ev(`document.getElementById('mb-setup').click(); true`);
    const r2 = await until(`(() => { const s = kellyMeshBuddy.state(); return !s.busy && (s.result || s.log.length) ? { result: s.result, log: s.log } : null; })()`, 30000);
    const c2 = await ev(`window.__mbT.cmds`);
    ok(r2 && r2.result && c2 && ['mprs min 60', 'set radio 916.5,125,9,5', 'set tx 17', 'mprs call VK4XXX-9', 'set name VK4XXX Ute'].every(w => c2.includes(w)),
      'set up only: patchy (min 60), custom radio, 17 dBm, SSID 9, name word cleaned to "Ute"', JSON.stringify(c2));
    ok(c2 && !c2.some(x => x.startsWith('mprs every 30')) && c2.filter(x => x.startsWith('password ')).length === 1, 'one password, no test settings');

    // ➕ Add it to my iGate list -> the iGate page's finder, searched by the node key
    await ev(`document.getElementById('mb-igate').click(); true`);
    const q = await until(`(() => { const el = document.getElementById('ig-find-q'); return el && el.value ? el.value : null; })()`, 5000);
    ok(q === 'abababab', 'Add to my iGate list: opens the finder on its key', q);
  });
  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})();
