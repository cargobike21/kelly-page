'use strict';
// Trace Route integration over CDP: the real index.html in demo mode (#tr-demo) -- picker -> engine -> sim -> viz /
// sound / history, rate limit, timeout, cancel, the neighbouring tabs, phone width. Screenshot: %TEMP%\trroute.png
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/tr-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/') + '?demo&nosplash#tr-demo';
const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (b, what, extra) => { if (b) pass++; else fail++; console.log(`${b ? 'PASS' : 'FAIL'} ${what}${extra != null ? ' -- ' + extra : ''}`); };
(async () => {
  const br = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1280,1000', url], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map(), errs = [];
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) { const t = m.params.args.map(a => a.value || a.description).join(' '); if (/Trace Route|tr-|Packet Journey|Analyser/.test(t)) errs.push(t.slice(0, 400)); }
      if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result.exceptionDetails ? { __err: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description } : r.result.result.value; };
    const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await ev(x); if (v && !v.__err) return v; await sleep(250); } return null; };

    ok(await until('!!(window.kellyTraceRoute && kellyTraceRoute._c.demo() && kellyTraceRoute._c.visible())', 8000), 'tab open, demo on, visible');
    await ev(`window.__tr = []; kellyTraceRoute._c.bus.on('done', r => __tr.push(r)); window.__runs = 0; kellyTraceRoute._c.bus.on('run', () => __runs++); true`);
    const parts = await ev(`({ rows: document.querySelectorAll('#tr-picker .tr-pk-row').length, canvas: !!document.querySelector('#tr-viz canvas'), sound: !!document.querySelector('#tr-sound .tr-snd-tog'), hist: !!document.querySelector('#tr-history .tr-hist-h'), nodes: kellyTraceRoute._c.nodes().length })`);
    ok(parts.rows > 5 && parts.canvas && parts.sound && parts.hist, 'every part mounted', JSON.stringify(parts));

    // 1. a traceable repeater, through the picker's own buttons
    const target = await ev(`(() => { const n = kellyTraceRoute._c.nodes().filter(n => n.canTrace && n.outPath && n.lastHeard > Date.now() - 864e5)[0]; return n && n.id; })()`);
    ok(!!target, 'demo has a traceable repeater', target);
    await ev(`document.querySelector('#tr-picker .tr-pk-row[data-id="${target}"] button').click(); true`);
    ok(await until(`kellyTraceRoute._c.selected() === ${JSON.stringify(target)}`, 2000), 'row click selects');
    // ▦ the target's contact QR in the shared dialog: its own key, type 2 (repeater)
    ok(await until(`!!document.querySelector('#tr-picker .tr-pk-sel .tr-pk-qr')`, 2000), '▦ beside a target with a full key');
    await ev(`document.querySelector('#tr-picker .tr-pk-qr').click(); true`);
    const qrl = await until(`!!(document.querySelector('#mqr:not([hidden]) .mqr-link') || {}).value`, 4000) && await ev(`document.querySelector('#mqr .mqr-link').value`);
    ok(!!qrl && qrl.includes(`public_key=${target}`) && /[?&]type=[23](&|$)/.test(qrl), "▦ = contact/add with the target key + its type (2 / 3)", qrl);
    await ev(`document.querySelector('#mqr [data-mqr="close"]').click(); true`);
    await ev(`document.querySelector('#tr-picker .tr-pk-go').click(); true`);
    ok(await until(`kellyTraceRoute._c.current() && kellyTraceRoute._c.current().status === 'pending'`, 2000), 'Trace button starts a run');
    ok(await until(`!!document.querySelector('#tr-picker .tr-pk-cancel')`, 2000), 'Cancel button shows while pending');
    const r1 = await until(`__tr.length >= 1 && __tr[0]`, 30000);
    ok(r1 && ['success', 'timeout'].includes(r1.status), 'run finishes', r1 && `${r1.status} rtt ${r1.rttMs} hops ${r1.out.length - 2} snrMin ${r1.snrMin}`);
    const again = await ev(`kellyTraceRoute._c.trace(${JSON.stringify(target)}, { method: 'auto' })`);
    ok(again && again.ok === false && !!again.reason, 'same target again at once is refused', JSON.stringify(again) + ` after ${r1 && ((Date.now() - r1.t0) / 1000).toFixed(1)} s`);
    ok(await until(`!!document.querySelector('#tr-picker .tr-pk-go[disabled]')`, 1500), 'Trace button disabled while limited');
    ok(await ev(`/round trip|no answer/.test(document.getElementById('tr-readout').textContent)`), 'readout shows the result', await ev(`document.getElementById('tr-readout').textContent`));
    ok(await until(`document.querySelectorAll('#tr-history .tr-hist-list > *').length >= 1`, 3000), 'history lists the station');

    // 2. live caps hold: 10 runs in 10 min (demo caps are looser: 30) -- the limiter's own numbers
    const lim = await ev(`kellyTraceRoute._c.limits()`);
    ok(lim && lim.caps && lim.caps.tenMin >= 10 && lim.used && lim.used.tenMin >= 1, 'limit state reported', lim && JSON.stringify({ caps: lim.caps, used: lim.used }));

    // 3. the unreachable station: timeout (with a retry), never hangs
    const dead = await ev(`(() => { const n = kellyTraceRoute._c.nodes().filter(n => n.canTrace && n.lastHeard < Date.now() - 864e5)[0]; return n && n.id; })()`);
    if (dead) {
      const t0 = Date.now(); const s = await ev(`kellyTraceRoute._c.trace(${JSON.stringify(dead)}, { method: 'trace' })`);
      ok(s && s.ok, 'trace to the dead station starts', JSON.stringify(s));
      const r = await until(`__tr.length >= 2 && __tr[1]`, 80000);
      ok(r && r.status !== 'pending', 'dead station settles', r && `${r.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s, tries ${r.tries}: ${r.error}`);
      ok(await ev(`!document.querySelector('#tr-picker .tr-pk-cancel')`), 'no stuck pending UI after timeout');
    } else ok(false, 'demo has an unreachable station');

    // 4. cancel mid-flight
    const other = await ev(`(() => { const n = kellyTraceRoute._c.nodes().filter(n => n.canTrace && n.id !== ${JSON.stringify(target)} && n.lastHeard > Date.now() - 864e5)[0]; return n && n.id; })()`);
    const s4 = await ev(`kellyTraceRoute._c.trace(${JSON.stringify(other)}, { method: 'auto' })`);
    await sleep(500); await ev(`kellyTraceRoute._c.cancel(); true`);
    const r4 = await until(`__tr.length >= 3 && __tr[2]`, 2000);
    ok(s4 && s4.ok && r4 && r4.status === 'cancelled', 'cancel settles at once', r4 && r4.status);

    // the look: a multi-hop trace, screenshot at the end of its replay (the first-run personality picker hidden)
    const far = await ev(`(() => { const n = kellyTraceRoute._c.nodes().filter(n => n.canTrace && ((n.outPath || n.inbound || { h: [] }).h.length >= 2) && n.lastHeard > Date.now() - 864e5)[0]; return n && n.id; })()`);
    if (far) {
      await ev(`document.getElementById('persona-picker').hidden = true; document.querySelector('#tr-picker .tr-pk-row[data-id="${far}"] button').click(); kellyTraceRoute._c.trace(${JSON.stringify(far)}, { method: 'trace' })`);
      const rf = await until(`__tr.length >= 4 && __tr[3]`, 40000);
      ok(rf && rf.status !== 'pending', 'multi-hop trace settles', rf && `${rf.status} ${rf.out.length - 2} hops out, ${rf.back.length - 2} back`);
      await sleep(9000);
      await ev(`document.querySelector('.tr-stage').scrollIntoView({ block: 'start' }); true`); await sleep(400);
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1260, height: 1000, scale: 0.8 } });
      fs.writeFileSync(path.join(os.tmpdir(), 'trroute.png'), Buffer.from(shot.result.data, 'base64'));
    }
    // 4b. 1-byte hashes: a hop shared by two repeaters is never traced; 1-byte senders are badged; a companion ping
    const tam = await ev(`(() => { const n = kellyTraceRoute._c.nodes().find(n => /Tamborine/.test(n.name)); return n && n.id; })()`);
    const why = await ev(`kellyTraceRoute._c.canTrace(${JSON.stringify(tam)}, { method: 'trace' })`);
    // its route's 1-byte hop: refused when 2+ repeaters share that byte, else sent as 2 bytes (the sim sometimes reroutes it)
    const shared = await ev(`(() => { const c = kellyTraceRoute._c, n = c.node(${JSON.stringify(tam)}), h = n.outPath && n.outPath.h[0]; return h ? c.nodes().filter(x => x.key && (x.role === 'repeater' || x.role === 'room') && x.key.startsWith(h)).length : 0; })()`);
    ok(shared > 1 ? /shared by/.test(why || '') : why === null || !/1-byte/.test(why), 'Tamborine: a shared 1-byte hop is never traced', `${shared} repeaters share its hop; canTrace: ${why}`);
    ok(await until(`!!document.querySelector('#tr-picker .tr-pk-1b')`, 3000), '1-byte senders carry a badge');
    const romeo = await ev(`(() => { const n = kellyTraceRoute._c.nodes().find(n => /VK4ZR Romeo/.test(n.name)); return n && n.id; })()`);
    ok(/can't be traced/.test(await ev(`kellyTraceRoute._c.node(${JSON.stringify(romeo)}).why`) || ''), 'a companion says up front it cannot be traced');
    await ev(`document.querySelector('#tr-picker .tr-pk-row[data-id="${romeo}"] button').click(); true`);
    ok(await until(`!!document.querySelector('#tr-picker [data-m="ping"]')`, 2000), 'Ping offered for a companion');
    const nDone = await ev(`__tr.length`);
    await ev(`document.querySelector('#tr-picker [data-m="ping"]').click(); true`); await sleep(200);
    await ev(`document.querySelector('#tr-picker .tr-pk-go').click(); true`);
    const rp = await until(`__tr.length > ${nDone} && __tr[${nDone}]`, 30000);
    ok(rp && rp.method === 'ping' && ['success', 'timeout'].includes(rp.status), 'demo ping settles', rp && `${rp.status} rtt ${rp.rttMs} -- ${rp.note || rp.error}`);
    await ev(`document.querySelector('#tr-picker .tr-pk-row[data-id="${target}"] button').click(); true`);
    await ev(`__tr.length = 3; true`);   // the screenshot step below reads __tr[3]

    // 5. idle CPU: once still, Trace Route asks for no more frames than the page does with it hidden
    await sleep(9000);
    const RAF = `new Promise(res => { let n = 0; const o = window.requestAnimationFrame; window.requestAnimationFrame = f => { n++; return o(f); }; setTimeout(() => { window.requestAnimationFrame = o; res(n); }, 3000); })`;
    const rafTr = await ev(RAF);
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="analyser"]').click(); true`); await sleep(1500);
    const rafOff = await ev(RAF);
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="trace"]').click(); true`); await sleep(500);
    ok(rafTr <= rafOff + 12, 'idle: Trace Route adds no frame loop', `${rafTr} rAF in 3 s on Trace Route, ${rafOff} on the Analyser tab`);

    // 6. the neighbours still work
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="journey"]').click(); true`);
    ok(await until(`!!document.querySelector('#pj-net canvas') && document.querySelector('#pj-root').offsetParent !== null`, 3000), 'Packet Journey tab shows its canvas');
    ok(await until(`!kellyTraceRoute._c.visible()`, 3000), 'Trace Route pauses when hidden');
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="analyser"]').click(); true`);
    ok(await until(`document.querySelector('#mca-root').offsetParent !== null && document.querySelector('#mca-root').children.length > 0`, 3000), 'Analyser tab renders');
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="main"]').click(); true`);
    ok(await until(`!!document.querySelector('#mesh-text') && document.querySelector('#mesh-text').offsetParent !== null`, 3000), 'Mesh tab chat box visible');

    // 7. phone width: one column, no sideways scroll
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="trace"]').click(); true`);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(1200);
    // a phone shows just messages + Mesh Quest (mesh.js phoneLite): "Show all" brings the tabs back, then open Trace Route
    await ev(`(() => { const b = document.querySelector('.mesh-lite-btn'); if (b && document.querySelector('#page-mesh').classList.contains('mesh-lite')) b.click(); document.querySelector('[data-tabs="mesh"] [data-tab="trace"]').click(); return true; })()`);
    await sleep(1200);
    console.log('  phone diag', JSON.stringify(await ev(`({ page: (document.querySelector('.page.on, .page.active') || {}).id, pane: !!document.querySelector('#tr-root').offsetParent, trOn: document.querySelector('[data-tabpane="mesh:trace"]').className, w: innerWidth })`)));
    const ph = await ev(`({ sw: document.querySelector('.tr').scrollWidth, cw: document.querySelector('.tr').clientWidth, cols: getComputedStyle(document.querySelector('.tr-main')).gridTemplateColumns.split(' ').length, vizW: document.querySelector('#tr-viz canvas').clientWidth })`);
    ok(ph.cw > 300 && ph.vizW > 300 && ph.cols === 1 && ph.sw <= ph.cw + 2, 'phone: one column, no sideways scroll', JSON.stringify(ph));

    // 8. the MeshCore Demo link: the real driver (js/meshcore.js) into js/meshcoresim.js -- a ping and a 2-byte trace
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Page.navigate', { url: url.replace('?demo&nosplash#tr-demo', '?demo&nosplash&simlink=1#mesh-demo-meshcore') }); await sleep(2500);   // a new query: a real reload
    ok(await until(`!!(window.kellyTraceRoute && kellyTraceRoute._c.link().via === 'sim-link')`, 15000), 'MeshCore Demo link online');
    await ev(`document.getElementById('persona-picker').hidden = true; document.querySelector('[data-tabs="mesh"] [data-tab="trace"]').click(); window.__tr = []; kellyTraceRoute._c.bus.on('done', r => __tr.push(r)); window.__sent = []; true`);
    const sl = await ev(`(() => { const ns = kellyTraceRoute._c.nodes(); const comp = ns.find(n => n.canPing && /Bravo Heltec/.test(n.name)), rpt = ns.filter(n => n.canTrace && n.role === 'repeater' && kellyTraceRoute._c.canTrace(n.id, { method: 'trace' }) === null).sort((a, b) => ((b.outPath || b.inbound || { h: [] }).h.length) - ((a.outPath || a.inbound || { h: [] }).h.length))[0]; return { comp: comp && comp.id, rpt: rpt && rpt.id, rptName: rpt && rpt.name }; })()`);
    const sp = await ev(`kellyTraceRoute._c.trace(${JSON.stringify(sl.comp)}, { method: 'ping' })`);
    const pr = await until(`__tr[0]`, 70000);
    ok(sp && sp.ok && pr && pr.status === 'success', 'sim-link ping: ACK through the real driver', pr && `${pr.status} ${pr.note || pr.error}`);
    console.log('  chat diag', JSON.stringify(await ev(`({ tabs: (document.querySelector('#mesh-tabs') || {}).textContent, has: /Trace Route ping/.test(document.querySelector('#page-mesh').textContent) })`)));
    await ev(`(() => { document.querySelector('[data-tabs="mesh"] [data-tab="main"]').click(); const b = [...document.querySelectorAll('#mesh-tabs [data-chat^="dm"]')].pop(); if (b) b.click(); return true; })()`);
    ok(await until(`/Trace Route ping/.test(document.querySelector('#page-mesh').textContent)`, 3000), 'the ping shows in the DM chat');
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="trace"]').click(); true`);
    const st = await ev(`kellyTraceRoute._c.trace(${JSON.stringify(sl.rpt)}, { method: 'trace' })`);
    console.log('  trace start', JSON.stringify(st), JSON.stringify(sl));
    const tr2 = await until(`__tr[1]`, 70000);
    ok(st && st.ok && tr2 && tr2.status === 'success' && tr2.hashSize === 2 && tr2.out.slice(1).every(h => !h.hash || h.hash.length === 4), 'sim-link trace with 2-byte hops', tr2 && `${tr2.status} ${sl.rptName}: ${tr2.out.map(h => h.hash || 'me').join(' > ')}`);

    ok(!errs.length, 'no exceptions / Trace Route warnings', errs.join('\n  '));
  } catch (e) { ok(false, 'harness', e.stack); }
  finally { try { ws && ws.close(); } catch {} killTree(br, profile); }
  console.log(`${pass} passed, ${fail} failed`); console.log(fail ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
})();
