'use strict';
// Property Guard over CDP: the real index.html, #pg-demo (the scripted intrusion), then manual triggers. Screenshot: %TEMP%\propertyguard.png
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/pg-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const base = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (b, what, extra) => { if (b) pass++; else fail++; console.log(`${b ? 'PASS' : 'FAIL'} ${what}${extra != null ? ' -- ' + extra : ''}`); };

async function page(hash, fn, shot) {
  const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
  const br = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1280,1000', `${base}?demo&nosplash${hash}`], { stdio: 'ignore' });
  let ws, id = 0; const pend = new Map(), errs = [];
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) { const t = m.params.args.map(a => a.value || a.description).join(' '); if (/Property Guard|pg-/.test(t)) errs.push(t.slice(0, 400)); }
      if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result.exceptionDetails ? { __err: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description } : r.result.result.value; };
    const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await ev(x); if (v && !v.__err) return v; await sleep(250); } return null; };
    await fn(ev, until);
    if (shot) { await ev(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true); document.getElementById('pg-root').scrollIntoView(); true`); await sleep(600); const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(os.tmpdir(), shot), Buffer.from(s.result.data, 'base64')); }
    ok(!errs.length, 'no exceptions / warnings from Property Guard', errs.slice(0, 3).join(' | '));
  } finally { try { ws && ws.close(); } catch {} killTree(br, profile); }
}

(async () => {
  await page('#pg-demo', async (ev, until) => {
    ok(await until('!!(window.kellyPropertyGuard && document.querySelector("#pg-root .pg"))', 8000), 'tab rendered');
    ok(await ev(`document.querySelectorAll('#pg-root .pg-tile').length === 12 && !!document.querySelector('#pg-root .pg-map')`), '12 IO tiles + site map');
    ok(await until(`kellyPropertyGuard._s().arm === 'armed'`, 8000), 'demo arms in Kelly');
    const al = await until(`(() => { const s = kellyPropertyGuard._s(); return s.arm === 'alarm' ? s : null; })()`, 25000);
    ok(al && al.chain.map(x => x.label).join('>').includes('Driveway radar>Gate beam>Seismic'), 'correlated chain led to the alarm', al && al.chain.map(x => x.label).join('>'));
    const am = await until(`kellyPropertyGuard._s().msgs.find(m => m.kind === 'alarm') || null`, 5000);   // lands once its packet has hopped home -> the home P25 radio
    ok(am && /PG ALARM shed: Shed door/.test(am.text), 'Alarm trigger (on by default) sent a P25 text', am && am.text);
    ok(await until(`!!document.querySelector('#pg-state-s') && /Acknowledged/.test(document.querySelector('#pg-state-s').textContent)`, 12000), 'demo Acknowledge in Kelly');
    // manual: a lone radar hit never alarms; a window opened while armed alarms at once
    ok(await ev(`(async () => { document.getElementById('pg-reset').click(); document.getElementById('pg-arm').click(); for (let i = 0; i < 40 && kellyPropertyGuard._s().arm !== 'armed'; i++) await new Promise(r => setTimeout(r, 100));
      document.querySelector('[data-di="A-DI4"]').click(); await new Promise(r => setTimeout(r, 1500)); const a1 = kellyPropertyGuard._s().arm;
      document.querySelector('[data-di="A-DI2"]').click(); await new Promise(r => setTimeout(r, 300)); return a1 === 'armed' && kellyPropertyGuard._s().arm === 'alarm'; })()`), 'lone radar stays armed; window = instant alarm');
    ok(await ev(`(() => { const t = document.getElementById('pg-t-A-DI2'); return t.classList.contains('on') && /OPEN/.test(t.textContent); })()`), 'window tile shows OPEN');
    ok(await ev(`(() => { document.getElementById('pg-reset').click(); return !document.querySelector('#pg-root .pg-sens.on, #pg-root .pg-tile.on'); })()`), 'reset clears the map and tiles');
    const na = await ev(`(async () => { document.getElementById('pg-reset').click(); document.querySelector('[data-di="A-DI1"]').click(); await new Promise(r => setTimeout(r, 400)); document.getElementById('pg-arm').click(); await new Promise(r => setTimeout(r, 3000));
      const s = kellyPropertyGuard._s(); return { arm: s.arm, notArmed: s.log.some(l => /Not armed: Shed door/.test(l.text)), msgs: s.msgs.map(m => m.text), log: s.log.slice(0, 4).map(l => l.text) }; })()`);
    ok(na && na.arm === 'disarmed' && na.notArmed && !na.msgs.length, "won't arm with the door open (said in Kelly, no P25 text)", JSON.stringify(na));
    // P25 message triggers: Alarm unticked -> no text; a Shed door sensor trigger ticked -> a text on the door trip
    const tr = await ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); const S = () => kellyPropertyGuard._s();
      document.getElementById('pg-reset').click(); await w(400);
      const box = document.querySelector('[data-trig="alarm"]'); box.click(); const door = document.querySelector('[data-trigch="A-DI1"]'); door.click();
      document.getElementById('pg-arm').click(); await w(400); document.querySelector('[data-di="A-DI2"]').click(); await w(2500);
      const r = { alarm: S().arm, alarmTexts: S().msgs.filter(m => m.kind === 'alarm').length, offLogged: S().log.some(l => /trigger "🚨 Alarm" is off/.test(l.text)) };
      document.querySelector('[data-di="A-DI1"]').click(); await w(2500);
      r.doorText = S().msgs.some(m => /PG Shed door A.DI1 OPEN/.test(m.text)); box.click(); door.click(); return r; })()`);
    ok(tr && tr.alarm === 'alarm' && tr.alarmTexts === 0 && tr.offLogged, 'Alarm trigger off: still alarms in Kelly, no P25 text', JSON.stringify(tr));
    ok(tr && tr.doorText, 'Shed door sensor trigger sends a P25 text', JSON.stringify(tr));
  }, 'propertyguard.png');
  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('RESULT: FAIL', e); process.exit(1); });
