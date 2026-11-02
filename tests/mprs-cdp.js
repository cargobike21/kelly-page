'use strict';
// LoRa Mesh > MeshPRS tab over CDP: the real index.html on the MeshCore Demo (#mprs-demo). The demo tracker's frame
// arrives (RESP 27 on #meshprs), lands on the map and the tracker panel; missed frames from seq; the iGate's verdict;
// the dry-run default and the live switch's guards; the packet dissector; offline tiles -> grid. Screenshot: %TEMP%\meshprs.png
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/mprs-cdp.js
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
      if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) { const t = m.params.args.map(a => a.value || a.description).join(' '); if (/MeshPRS|mprs|APRS iGate|Packet Journey/.test(t)) errs.push(t.slice(0, 400)); }
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

(async () => {
  await page('#mprs-demo', async (ev, until) => {
    ok(await until('!!(window.kellyMeshPRS && document.querySelector("#mprs-root .mprs"))', 10000), 'tab rendered');
    ok(await until('!!window.KellyMeshDemo', 15000), 'LoRa Mesh on the MeshCore Demo');
    ok(await until(`document.querySelector('[data-tabpane="mesh:mprs"]').classList.contains('on')`, 8000), 'MeshPRS tab is showing');
    const st0 = await ev('kelly.igate().mprsStatus()');
    ok(st0 && st0.dry === true, 'dry run is the default on a new Kelly', JSON.stringify(st0 && { dry: st0.dry, on: st0.on }));
    ok(await until('kelly.igate().mprsStatus().slot != null', 12000), 'the demo added #meshprs to a slot');
    // the demo tracker's first frame (sent at start, before the slot existed) may be lost; the next is 15 s later
    const s = await until(`(() => { const s = kellyMeshPRS.tracker().station('VK4ZB-7'); return s && s.track.length ? { n: s.frames, lat: s.lat, lon: s.lon, kind: s.kind, sym: s.sym, snr: s.snr, hops: s.hops } : null; })()`, 40000);
    ok(s && s.kind === 'frame' && Math.abs(s.lat + 27.61) < 0.05 && s.sym === '/>', 'demo tracker frame decoded onto a station', JSON.stringify(s));
    ok(s && s.snr != null && s.hops != null, 'SNR and hops from RESP 27', JSON.stringify(s));
    ok(await until(`kellyMeshPRS.state().marks >= 1 && !!document.querySelector('#mp-map .mprs-mk .mprs-sym')`, 8000), 'marker with an APRS sprite on the map');
    ok(await ev(`!!document.querySelector('#mp-trackers [data-sid="VK4ZB-7"] .mprs-beacon')`), 'tracker card with the beacon panel');
    // missed frames from seq: two frames 3 apart -> 2 missed (straight into the sim, through the real node path)
    const miss = await ev(`(async () => { const D = window.KellyMeshDemo, M = window.MeshPRS, i = D.world.findIndex(x => x.mprs), w = D.world[i];
      const f = seq => M.encode({ subtype: 0, seq, src: 'VK4XYZ-9', key: 'DEADBEEF', lat: M.degToRaw(-27.5, 90), lon: M.degToRaw(152.95, 180), sym: '/b', comment: 'bike' });
      D.inject.mprs(i, f(100)); await new Promise(r => setTimeout(r, 1500)); D.inject.mprs(i, f(103)); await new Promise(r => setTimeout(r, 1500));
      const s = kellyMeshPRS.tracker().station('VK4XYZ-9'); return s ? { frames: s.frames, missed: s.missed } : null; })()`);
    ok(miss && miss.frames === 2 && miss.missed === 2, 'missed frames counted from seq', JSON.stringify(miss));
    // iGate on (dry): a station not on the list is refused 'untrusted', and the tab shows why
    await ev(`(() => { const g = kelly.igate(); kelly.settings.igate.call = 'VK4XXX'; g.mprsSet('on', true); g.mprsSet('mprs', true); return true; })()`);
    const v = await ev(`(async () => { const D = window.KellyMeshDemo, M = window.MeshPRS, i = D.world.findIndex(x => x.mprs), w = D.world[i];
      D.inject.mprs(i, M.encode({ subtype: 0, seq: 104, src: 'VK4XYZ-9', key: 'DEADBEEF', lat: M.degToRaw(-27.501, 90), lon: M.degToRaw(152.951, 180), sym: '/b', comment: 'bike' }));
      await new Promise(r => setTimeout(r, 1500)); const p = kellyMeshPRS.tracker().packets().find(p => p.f && p.f.src === 'VK4XYZ-9' && p.f.seq === 104); return p && p.gate; })()`);
    ok(v && v.st === 'drop' && v.reason === 'untrusted', 'iGate verdict on the frame: untrusted', JSON.stringify(v));
    // the live switch: refused with an empty list, dry run stays
    await ev(`window.confirm = () => true; document.getElementById('mp-live').click(); true`);
    ok(await ev(`kelly.igate().mprsStatus().dry === true`), 'LIVE refused while my iGate list is empty');
    ok(await ev(`document.getElementById('mp-sw').classList.contains('dry') && document.getElementById('mp-dry').classList.contains('on')`), 'switch shows DRY RUN');
    // the packet dissector
    const d = await ev(`(async () => { document.querySelector('[data-tabs="mprs"] [data-tab="pkts"]').click(); await new Promise(r => setTimeout(r, 400));
      const row = [...document.querySelectorAll('#mp-plist [data-p]')].find(r => /VK4ZB-7/.test(r.textContent)); if (!row) return null; row.click(); await new Promise(r => setTimeout(r, 300));
      const box = document.getElementById('mp-pdetail'); return { layers: box.querySelectorAll('.mprs-layer').length, tnc2: (box.querySelector('.mprs-tnc2') || {}).textContent || '',
        bytes: box.querySelectorAll('.mprs-hex i').length, fields: [...box.querySelectorAll('.mprs-ft tr')].map(t => t.dataset.f) }; })()`);
    ok(d && d.layers === 3, 'three layers: MeshCore, MeshPRS, APRS', JSON.stringify(d));
    ok(d && /^VK4ZB-7>APZKPG,qAO,VK4XXX-10:!27\d\d\.\d\dS\/152\d\d\.\d\dE>\d{3}\/\d{3}\/A=\d{6}MeshPRS demo drive$/.test(d.tnc2), 'TNC2 line as the spec renders it', d && d.tnc2);
    ok(d && d.fields.join(',') === 'hdr,sub,seq,src,key,lat,lon,sym,pf,alt,crs,spd,text', 'every field of a full position frame', d && d.fields.join(','));
    // iGate panel + drop table
    const ig = await ev(`(async () => { document.querySelector('[data-tabs="mprs"] [data-tab="ig"]').click(); await new Promise(r => setTimeout(r, 300));
      return { kv: document.querySelectorAll('#mp-ig .mprs-kv').length, drops: document.getElementById('mp-drops').textContent }; })()`);
    ok(ig && ig.kv >= 8 && /untrusted/.test(ig.drops), 'iGate panel and drop reasons', JSON.stringify(ig));
    // tiles unreachable -> the plain grid
    const off = await ev(`(async () => { document.querySelector('[data-tabs="mprs"] [data-tab="set"]').click(); const t = document.getElementById('mp-s-tile');
      t.value = 'http://127.0.0.1:9/{z}/{x}/{y}.png'; t.dispatchEvent(new Event('change')); document.querySelector('[data-tabs="mprs"] [data-tab="map"]').click();
      for (let i = 0; i < 40 && !kellyMeshPRS.state().offline; i++) await new Promise(r => setTimeout(r, 250));
      return { off: kellyMeshPRS.state().offline, note: !document.getElementById('mp-mapnote').hidden, lines: document.querySelectorAll('#mp-map .mprs-gl').length }; })()`);
    ok(off && off.off && off.note && off.lines > 2, 'offline tiles: note + lat/lon grid', JSON.stringify(off));
    await ev(`(() => { const t = document.getElementById('mp-s-tile'); t.value = ''; t.dispatchEvent(new Event('change')); return true; })()`);
    // Packet Journey still works beside it
    ok(await ev(`(async () => { document.querySelector('[data-tabs="mesh"] [data-tab="journey"]').click(); await new Promise(r => setTimeout(r, 600));
      const on = document.querySelector('[data-tabpane="mesh:journey"]').classList.contains('on') && !!document.querySelector('#pj-root').children.length;
      document.querySelector('[data-tabs="mesh"] [data-tab="mprs"]').click(); await new Promise(r => setTimeout(r, 300)); return on; })()`), 'Packet Journey tab unaffected');
    // 🔎 Add my device: the tracker card's button -> the iGate page's finder, its card prefilled from the frame, one click adds it
    const fd = await ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); const D = window.KellyMeshDemo, i = D.world.findIndex(x => x.mprs), pre = MeshPRS.hex(D.world[i].key.subarray(0, 4)).toLowerCase();
      const btn = document.querySelector('#mp-trackers [data-sid="VK4ZB-7"] [data-act="igate"]'); if (!btn) return { err: 'no Add button on the tracker card' };
      btn.click(); await w(900);
      const pick = document.getElementById('ig-find-pick'), row = document.querySelector('#ig-find-rows .ig-find-row.sel');
      const mpText = row ? ((row.querySelector('.ig-find-mp') || {}).textContent || '') : '', src = (/as (\\S+)/.exec(mpText) || [])[1] || '';
      const r = { q: document.getElementById('ig-find-q').value, open: !pick.hidden, src, call: (document.getElementById('ig-fp-call') || {}).value, ssid: (document.getElementById('ig-fp-ssid') || {}).value };
      document.getElementById('ig-fp-add').click(); await w(300);
      r.listed = kelly.igate().list().e.some(x => x.k.startsWith(pre)); r.rowOn = /on your list/.test((document.querySelector('#ig-find-rows') || {}).textContent || '');
      r.pre = pre; return r; })()`);
    ok(fd && fd.q === fd.pre && fd.open && fd.src && fd.call === fd.src.split('-')[0], 'finder: searched by key prefix, card prefilled from the frame', JSON.stringify(fd));
    ok(fd && fd.listed && fd.rowOn, 'finder: one click puts it on my list', JSON.stringify(fd));
    const fl = await ev(`(async () => { document.getElementById('ig-find-q').value = ''; document.getElementById('ig-find-q').dispatchEvent(new Event('input'));
      document.getElementById('ig-find-listen').click(); const t = document.getElementById('ig-find-listen').textContent; const h = !document.getElementById('ig-find-hint').hidden;
      document.getElementById('ig-find-listen').click(); return { t, h, rows: document.querySelectorAll('#ig-find-rows .ig-find-row').length }; })()`);
    ok(fl && /Stop listening/.test(fl.t) && fl.h && fl.rows >= 1, 'finder: recent nodes listed; Listen for it shows its hint', JSON.stringify(fl));
    const ham = await ev(`(() => { const t = document.getElementById('ig-find-rows').textContent;
      return { nonHam: /Bremer Creek Sensor|Ipswich Chat Room|Toowoomba Rptr|Brisbane Bob/.test(t), note: /no VK or ZL amateur callsign as its first or second word/.test(t), rows: [...document.querySelectorAll('#ig-find-rows .ig-find-row b')].map(b => b.textContent) }; })()`);
    ok(ham && !ham.nonHam && ham.note, 'finder: only amateur stations listed, the rest hidden with a note', JSON.stringify(ham));
    ok(await ev(`!!localStorage && (kellyMeshPRS.hidden(), true)`), 'tracks saved on hide');
    await ev('kellyMeshPRS.shown(), kellyMeshPRS.stopDemo(), true');
  }, 'meshprs.png');
  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('RESULT: FAIL', e); process.exit(1); });
