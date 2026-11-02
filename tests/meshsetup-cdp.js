/* Kelly Page -- Set up a node over USB (Phase 11: js/meshsetup.js) in the REAL page over the Chrome DevTools Protocol,
 * against the Demo node (js/meshclisim.js): off by default, switch on, read, MBUG preset as a diff, the band guard,
 * write + read back, ▦ Show this node's QR (type 2, no password, never prv.key), restart, no page exceptions. The parsing and guards themselves are tests/meshsetup-tests.html.
 *   node tests/meshsetup-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket) */
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
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'warning' || m.params.type === 'error')) { const t = m.params.args.map(a => a.value ?? a.description).join(' '); if (/Node setup/.test(t)) errs.push(t); }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const text = sel => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);

    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    // past the first-run persona picker (it sits over the page in a fresh profile)
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.persona = 'shack'; localStorage.setItem('kelly.settings', JSON.stringify(s)); location.reload(); })()`);
    await sleep(800);
    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await sleep(1200);
    await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`);
    await click('button[data-page="mesh"]'); await sleep(400);

    eq('off by default: card hidden, toggle off', await js(`[document.querySelector('#msu-card').hidden, document.querySelector('#ms-setup').checked]`), [true, false]);
    await js(`(() => { const c = document.querySelector('#ms-setup'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(200);
    eq('switched on: the card shows, not connected', await js(`[document.querySelector('#msu-card').hidden, document.querySelector('#msu-tag').textContent]`), [false, 'not connected']);
    eq('kept in settings as mesh.setup', await js(`new Promise(r => setTimeout(() => r(JSON.parse(localStorage.getItem('kelly.settings') || '{}').mesh.setup), 1500))`), true);
    eq('Flash firmware notes: the official flasher + our three boards', await js(`(() => { const d = document.querySelector('.msu-flash'); return [!!d.querySelector('a[href="https://flasher.meshcore.co.uk/"]'), /XIAO-BOOT/.test(d.textContent), /adafruit-nrfutil/.test(d.textContent), /esptool/.test(d.textContent)]; })()`), [true, true, true, true]);

    await click('#msu-demo');
    eq('Demo node: settings read into the form', await until(`!!document.querySelector('#msu-mbug')`, 10000), true);
    eq('... name, radio, board', await js(`[document.querySelector('[data-f=name]').value, document.querySelector('[data-f=freq]').value, document.querySelector('[data-f=bw]').value, /Seeed SenseCap Solar/.test(document.querySelector('.msu-who').textContent)]`), ['VK4XXX Veranda Rptr', '923.125', '62.5', true]);
    // ▦ Show this node's QR (QR_REVIEW.md opp. 5): public key + name, type 2 (a repeater); never a password
    await js(`(() => { const f = document.querySelector('[data-f=guestPw]'); if (f) { f.value = 'Sekrit42'; f.dispatchEvent(new Event('input', { bubbles: true })); } return !!f; })()`);
    await click('#msu-qr');
    eq('▦ Show this node\'s QR -> its contact/add QR', await until(`(() => { const b = document.querySelector('#mqr'); return b && !b.hidden && /^meshcore:\\/\\/contact/.test(document.querySelector('#mqr .mqr-link').value); })()`, 8000), true);
    eq('... public key from get public.key, its name, type 2 (repeater)', await js(`document.querySelector('#mqr .mqr-link').value`),
      `meshcore://contact/add?${new URLSearchParams({ name: 'VK4XXX Veranda Rptr', public_key: '7a3e0c51d2b94f6880a1c6e2f4d9b3a5c8e17f2046b9d3a1e5c7f0b2d4a6c8e0', type: '2' })}`);
    eq('... no password anywhere in the dialog (a typed guest password included)', await js(`(() => { const b = document.querySelector('#mqr'); return /Sekrit42|password(?! is| are)/i.test(b.textContent.replace(/passwords are never in a QR code/i, '')) || !!b.querySelector('input[type=password]'); })()`), false);
    eq('... the console never asked for prv.key', /prv/i.test(await text('#msu-log')), false);
    await click('#mqr [data-mqr="close"]');
    await click('#msu-undo'); await sleep(100);
    await click('#msu-mbug'); await sleep(100);
    eq('MBUG preset shown as a diff before anything is written', await js(`[...document.querySelectorAll('#msu-diff tr')].slice(1).map(r => r.cells[0].textContent + ': ' + r.cells[2].textContent)`), ['Flood advert every: 83 h', 'Path hash size: 2 bytes (MBUG)', 'Multi-acks: on']);
    await js(`(() => { const f = document.querySelector('[data-f=tx]'); f.value = '30'; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    eq('TX power over the board cap: refused', await js(`[document.querySelector('#msu-write').disabled, document.querySelector('[data-e=tx]').textContent]`), [true, '-9 to 22 dBm (SenseCAP Solar Node: its SX1262 tops out at 22 dBm)']);
    await js(`(() => { const f = document.querySelector('[data-f=tx]'); f.value = '22'; f.dispatchEvent(new Event('input', { bubbles: true })); const g = document.querySelector('[data-f=freq]'); g.value = '916'; g.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    eq('a radio change in band: allowed, after a restart', await js(`[document.querySelector('#msu-write').disabled, /Radio.*after a restart/.test(document.querySelector('#msu-diff').textContent)]`), [false, true]);
    await js(`window.confirm = () => true`);
    await click('#msu-write');
    eq('written one command at a time and read back', await until(`/4 written and read back: all checked/.test(document.querySelector('#msu-body').textContent)`, 15000), true);
    eq('... each answer shown', await js(`[...document.querySelectorAll('#msu-diff tr.ok')].length`), 4);
    eq('radio changed: offers a restart', await js(`!!document.querySelector('#msu-reboot')`), true);
    eq('after the read-back: ▦ Show this node\'s QR still offered', await js(`!!document.querySelector('#msu-qr')`), true);
    await click('#msu-reboot');
    eq('restart: link closed, says to connect again', await until(`/Connect again in a few seconds/.test(document.querySelector('#msu-body').textContent) && !!document.querySelector('#msu-demo')`, 8000), true);
    eq('the console shows the commands sent', /set radio 916,62.5,8,5/.test(await text('#msu-log')), true);
    await sleep(1000);
    eq('no page exceptions', errs, []);
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
