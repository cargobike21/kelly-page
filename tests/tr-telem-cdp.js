'use strict';
// Trace Route > Telemetry polling over CDP: the real index.html in demo mode (#tr-demo). Bravo's far Kelly asks to poll us
// (offering his) -> approve -> poll him with a route check -> sparklines; ask the Gold Coast (declines) and Romeo (no Kelly);
// revoke; phone width. Screenshot: %TEMP%\trtelem.png
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/tr-telem-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/') + '?demo&nosplash#tr-demo';
const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (b, what, extra) => { if (b) pass++; else fail++; console.log(`${b ? 'PASS' : 'FAIL'} ${what}${extra != null ? ' -- ' + extra : ''}`); };
(async () => {
  const br = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1100,1000', url], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map(), errs = [];
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) { const t = m.params.args.map(a => a.value || a.description).join(' '); if (/Trace Route|tr-|telem/i.test(t)) errs.push(t.slice(0, 400)); }
      if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result.exceptionDetails ? { __err: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description } : r.result.result.value; };
    const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await ev(x); if (v && !v.__err) return v; await sleep(250); } return null; };
    const click = sel => ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
    const txt = () => ev(`(document.querySelector('#tr-telem') || {}).textContent || ''`);

    ok(await until('!!(window.kellyTraceRoute && kellyTraceRoute._c.demo() && kellyTraceRoute._c.visible())', 8000), 'tab open, demo on');
    ok(await until(`!!document.querySelector('#tr-telem .tr-tl')`, 3000), 'telemetry panel mounted');
    ok(/granted contacts only/.test(await txt()), 'demo node: answers granted contacts only');
    await ev(`window.confirm = () => true; const pp = document.getElementById('persona-picker'); if (pp) pp.hidden = true; true`);

    // 1. Bravo's far Kelly asks to poll us, offering his (12 s into the demo)
    ok(await until(`/asks to poll you/.test(document.querySelector('#tr-telem').textContent)`, 20000), "Bravo's request shows as pending");
    ok(/offers theirs/.test(await txt()), 'with his offer');
    const bravo = await ev(`kellyTraceRoute._c.nodes().find(n => /Bravo mobile/.test(n.name)).key`);
    ok(await ev(`/you can poll/.test(document.querySelector('#tr-telem').textContent)`), 'his offer: Bravo is already under "Who I can poll"');
    ok(await ev(`kellyTraceRoute._c.telemFor(true).flag(${JSON.stringify(bravo)}) === false`), 'not yet allowed on our node');
    ok(await click('#tr-telem button[data-act="approve"]'), 'Approve clicked');
    ok(await until(`kellyTraceRoute._c.telemFor(true).flag(${JSON.stringify(bravo)}) === true`, 3000), 'approve sets his flag on our node');
    ok(await until(`/granted/.test(document.querySelector('#tr-telem').textContent) && /keys confirmed/.test(document.querySelector('#tr-telem').textContent)`, 3000), 'granted, keys confirmed');

    // 2. poll him: telemetry + route check
    ok(await until(`!!document.querySelector('#tr-telem .tr-tl-peer button[data-act="start"]')`, 3000), 'his poll panel is open');
    await click('#tr-telem .tr-tl-peer button[data-act="start"]');
    const h1 = await until(`(() => { const el = document.querySelector('#tr-telem .tr-tl-tile b'); return el && /V$/.test(el.textContent) && el.textContent; })()`, 30000);
    ok(!!h1, 'first poll: battery shown', h1);
    ok(await until(`document.querySelectorAll('#tr-telem .tr-tl-hop').length >= 3`, 30000), 'route check: hop chips there and back', await ev(`[...document.querySelectorAll('#tr-telem .tr-tl-pathrow')].map(r => r.textContent.replace(/\\s+/g, ' ')).join(' | ')`));
    ok(/isn't measured/.test(await txt()), 'says the companion hop is not measured');
    ok(await ev(`/polling now|next in/.test(document.querySelector('#tr-telem').textContent)`), 'next poll shown');
    ok(await ev(`document.querySelectorAll('#tr-telem .tr-tl-cell').length >= 1`), 'route health strip has a cell');
    // a second poll (the per-station gaps in demo are 8 s) -> the sparklines draw
    await sleep(9000);
    let second = null;
    for (let i = 0; i < 6 && !second; i++) {
      await click('#tr-telem button[data-act="now"]');
      second = await until(`document.querySelectorAll('#tr-telem .tr-tl-cell').length >= 2`, 12000);
      if (!second) await sleep(4000);
    }
    ok(!!second, 'Poll now: a second poll');
    ok(await until(`document.querySelectorAll('#tr-telem svg.tr-tl-spk').length >= 1`, 3000), 'sparkline drawn', await ev(`document.querySelectorAll('#tr-telem svg.tr-tl-spk').length`));
    ok(await ev(`!!document.querySelector('#tr-telem svg.tr-tl-spk circle.tr-tl-hit title')`), 'sparkline points have hover titles');
    ok(await ev(`document.querySelectorAll('#tr-history .tr-hist-list > *').length >= 1`), 'route checks feed Trace history too');

    // 3. ask the Gold Coast (declines) and Romeo (no Kelly: no ACK)
    const gc = await ev(`kellyTraceRoute._c.nodes().find(n => /Gold Coast/.test(n.name)).key`);
    await ev(`(() => { const s = document.getElementById('tr-tl-who'); s.value = ${JSON.stringify(gc)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    ok(await click('#tr-telem .tr-tl-ask button[data-act="ask"]'), 'Request access to the Gold Coast');
    ok(await until(`/asked -- waiting/.test(document.querySelector('#tr-telem').textContent)`, 3000), 'shows as asked');
    ok(await until(`/declined/.test(document.querySelector('#tr-telem').textContent)`, 15000), 'their Kelly declines');
    ok(await ev(`kellyTraceRoute._c.telemFor(true).flag(${JSON.stringify(gc)}) === false`), 'our offer to them withdrawn on decline');

    // 4. revoke Bravo: our node stops answering him at once
    ok(await click('#tr-telem button[data-act="revokeIn"]'), 'Revoke clicked');
    ok(await until(`kellyTraceRoute._c.telemFor(true).flag(${JSON.stringify(bravo)}) === false`, 3000), 'revoke clears his flag');
    ok(await until(`!/keys confirmed/.test(document.querySelector('#tr-telem').textContent)`, 3000), 'Bravo gone from "Who can poll my telemetry"');

    // 5. never poll without a grant
    const romeo = await ev(`kellyTraceRoute._c.nodes().find(n => /Romeo/.test(n.name)).key`);
    const nr = await ev(`kellyTraceRoute._telem()._poll(true, ${JSON.stringify(romeo)})`);
    ok(nr && nr.ok === false && /no grant/.test(nr.reason), 'no grant: Kelly refuses to poll', JSON.stringify(nr));
    const nr2 = await ev(`kellyTraceRoute._telem()._poll(true, ${JSON.stringify(gc)})`);
    ok(nr2 && nr2.ok === false, 'declined: no poll either');
    // Romeo has no Kelly: the request is sent three times, then gives up with a note
    await ev(`(() => { const s = document.getElementById('tr-tl-who'); s.value = ${JSON.stringify(romeo)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await click('#tr-telem .tr-tl-ask button[data-act="ask"]');
    ok(await until(`kellyTraceRoute._telem()._w.demo.outbox.some(e => e.key === ${JSON.stringify(romeo)} && e.op === 'REQ' && !e.acked)`, 3000), "Romeo's request waits for an ACK in the outbox");

    // screenshot at desktop width
    await sleep(400);
    const box = await ev(`(() => { const el = document.querySelector('#tr-telem'); el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y + scrollY, w: r.width, h: Math.min(r.height, 1400) }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
    fs.writeFileSync(path.join(os.tmpdir(), 'trtelem.png'), Buffer.from(shot.result.data, 'base64'));

    // 6. phone width: no sideways scroll
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(1200);
    // a phone shows just messages + Mesh Quest (mesh.js phoneLite): "Show all" brings the tabs back, then open Trace Route
    await ev(`(() => { const b = document.querySelector('.mesh-lite-btn'); if (b && document.querySelector('#page-mesh').classList.contains('mesh-lite')) b.click(); document.querySelector('[data-tabs="mesh"] [data-tab="trace"]').click(); return true; })()`);
    await sleep(1200);
    const over = await ev(`(() => { const r = document.querySelector('#tr-telem'); r.scrollIntoView(); const b = r.getBoundingClientRect(); let widest = 0; for (const el of r.querySelectorAll('*')) { const q = el.getBoundingClientRect(); if (q.width) widest = Math.max(widest, q.right); } return { doc: document.documentElement.scrollWidth, win: innerWidth, w: Math.round(b.width), right: Math.round(b.right), widest: Math.round(widest) }; })()`);
    ok(over.w > 300 && over.doc <= over.win + 1 && over.widest <= over.win + 1, 'phone: panel shown, nothing past the screen edge', JSON.stringify(over));

    ok(!errs.length, 'no console errors', errs.join(' || '));
  } catch (e) { fail++; console.log('FAIL harness', e && e.stack); }
  finally { try { ws && ws.close(); } catch {} killTree(br.pid); }
  console.log(`${pass} passed, ${fail} failed`);
  console.log(fail ? `RESULT: FAIL (${fail})` : 'RESULT: ALL PASS');
  process.exit(fail ? 1 : 0);
})();
