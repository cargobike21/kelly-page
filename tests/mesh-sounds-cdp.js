/* Kelly Page -- mesh sounds (Phase 6c): P25X alert tones by priority and quiet hours with the critical override, driven
 * in the REAL page over the Chrome DevTools Protocol. A demo station posts real alert texts (window.KellyMeshDemo.inject);
 * which tone played is told by how many oscillators Kelly starts (routine 2, priority 6, critical 6 sweeps, a chat 3).
 *   node tests/mesh-outbox-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket)
 * Uses a throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path');
const BROWSER = process.argv[2] || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/') + '#mesh';
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', PAGE], { stdio: 'ignore' });
  let ws, id = 0;
  const pend = new Map();
  try {
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
    if (!tab) throw new Error('browser did not start');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await sleep(1500);
    // count oscillators per sound (and their first frequency) -- the page's Web Audio, untouched otherwise
    await js(`(() => { window.__osc = []; const P = (window.AudioContext || window.webkitAudioContext).prototype, c = P.createOscillator;
      P.createOscillator = function () { const o = c.call(this), rec = { t: o.type, f: null }; window.__osc.push(rec);
        const sv = o.frequency.setValueAtTime.bind(o.frequency); o.frequency.setValueAtTime = (v, w) => { if (rec.f == null) { rec.f = Math.round(v); rec.t = o.type; } return sv(v, w); }; return o; }; })()`);
    await js(`document.querySelector('button[data-page="mesh"]').click()`);
    await sleep(300);
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click()`);
    // one real click (on the node search box): the browser plays sound only after a user gesture
    const r = await js(`(() => { const e = document.querySelector('#mesh-q'); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return [b.left + 8, b.top + 6]; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r[0], y: r[1], button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r[0], y: r[1], button: 'left', clickCount: 1 });
    eq('demo up, inject hook there, sound allowed', await until(`!!window.KellyMeshDemo && navigator.userActivation.hasBeenActive`, 15000), true);
    await sleep(9000);   // let the start-up adverts and their sounds pass
    const BOB = await js(`window.KellyMeshDemo.world.findIndex(s => s.name === 'Brisbane Bob')`);
    const heard = async text => { await js(`window.__osc = []`); await js(`window.KellyMeshDemo.inject.channel(${BOB}, ${JSON.stringify(text)}, 0)`); await sleep(5000); return js(`window.__osc.map(x => x.t + x.f)`); };
    const has = (got, want) => want.every(w => got.filter(x => x === w).length >= want.filter(x => x === w).length);
    let g = await heard('P1-ALM 3a VK4RBX 2210 site alarm');
    eq('a routine alert -> the routine double beep (2 x 880 Hz), no chat chime', has(g, ['sine880', 'sine880']) && !g.includes('triangle1318'), true);
    g = await heard('P1+RPT 3b VK4RBX 2211 repeater down');
    eq('a priority alert -> the rising call (659-880-1175 twice)', has(g, ['triangle659', 'triangle880', 'triangle1175', 'triangle659', 'triangle880', 'triangle1175']), true);
    g = await heard('P1!SOS 3c VK4RBX 2212 emergency');
    eq('a critical alert -> the alarm sweeps (3 x up + down)', g.filter(x => x === 'sawtooth600').length >= 3 && g.filter(x => x === 'sawtooth1400').length >= 3, true);
    g = await heard('Morning all');
    eq('an ordinary channel text -> the chat chime, no alert tone', g.includes('triangle1318') && !g.some(x => /sawtooth600|triangle659/.test(x)), true);
    // quiet hours covering now: routine/priority/chat silent, critical still sounds
    const hm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const now = new Date(), from = hm(new Date(now - 3600000)), to = hm(new Date(+now + 3600000));
    await js(`(() => { document.querySelector('#ms-qfrom').value = '${from}'; document.querySelector('#ms-qto').value = '${to}'; const c = document.querySelector('#ms-quiet'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(400);
    eq('quiet hours on: the page says so', await until(`document.querySelector('#ms-qnow').textContent.includes('quiet now')`, 3000), true);
    eq('quiet: a chat text makes no sound', await heard('Anyone up?'), []);
    eq('quiet: a priority alert makes no sound', await heard('P1+RPT 3d VK4RBX 2213 repeater down'), []);
    g = await heard('P1!SOS 3e VK4RBX 2214 emergency');
    eq('quiet: a critical alert still sounds, nothing else does', g.filter(x => /^sawtooth(600|1400)$/.test(x)).length >= 6 && !g.includes('triangle1318'), true);
    await js(`window.__osc = []; document.querySelector('[data-try="alert-routine"]').click()`); await sleep(300);
    eq('quiet: the ▶ try button still plays', await js(`window.__osc.length`), 2);
    eq('quiet hours remembered', await until(`(JSON.parse(localStorage.getItem('kelly.settings') || '{}').mesh || {}).quiet?.on === true`, 5000), true);
  } catch (e) { console.log(`FAIL exception: ${e.message}`); fails.push('exception'); }
  finally {
    try { ws && ws.close(); } catch { /* */ }
    killTree(br, profile);
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold a file */ }
  }
  console.log(`RESULT: ${fails.length ? 'FAIL ' + fails.join(', ') : 'ALL PASS'}`);
  process.exit(fails.length ? 1 : 0);
})();
