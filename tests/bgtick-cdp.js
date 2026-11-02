'use strict';
// js/bgtick.js in a BACKGROUND tab: Edge with intensive wake-up throttling brought forward to 10 s (normally 5 min),
// tests/bgtick-test.html sent behind a second tab, then 80 s later a plain 1 s setInterval should have stalled (gaps of
// ~60 s) while KellyBgTick kept ~1 s. This is what lost the APRS iGate's MeshPRS frames on 2026-10-31 (all 'expired').
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/bgtick-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = 'file:///' + path.join(__dirname, 'bgtick-test.html').split(path.sep).join('/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (b, what, extra) => { if (b) pass++; else fail++; console.log(`${b ? 'PASS' : 'FAIL'} ${what}${extra != null ? ' -- ' + extra : ''}`); };

(async () => {
  const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
  const br = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files',
    '--no-first-run', '--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10', url], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map();
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /bgtick/.test(t.url)); } catch {} }
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result.result.value;
    await sleep(2000);
    // a second tab in front: the test page goes to the background (document.hidden)
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const bws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise(r => bws.onopen = r);
    bws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank', background: false } }));
    await sleep(3000);
    ok(await ev('document.visibilityState') === 'hidden', 'the test page is in the background', await ev('document.visibilityState'));
    const t0 = await ev('JSON.stringify({p: counts.plain, b: counts.bg})');
    await sleep(80000);
    const c = await ev('({ plain: counts.plain, bg: counts.bg, maxPlain: Math.max(...counts.gapsPlain), maxBg: Math.max(...counts.gapsBg) })');
    console.log('after 80 s in the background:', JSON.stringify(c), 'start', t0);
    // counts, not gaps: headless Edge's throttling loses plain ticks without a steady gap pattern (real Edge: one a minute)
    ok(c.bg - c.plain >= 10, 'a plain setInterval loses ticks in a background tab (the bug)', `plain ${c.plain}, worker ${c.bg}`);
    ok(c.bg >= 80 && c.maxBg < 2500, 'KellyBgTick keeps ticking about once a second', `${c.bg} ticks, ${c.maxBg} ms max gap`);
    try { bws.close(); } catch {}
  } finally { try { ws && ws.close(); } catch {} killTree(br, profile); }
  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('RESULT: FAIL', e); process.exit(1); });
