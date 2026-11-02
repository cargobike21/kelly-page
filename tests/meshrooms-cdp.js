/* Kelly Page -- LoRa Mesh Rooms card (js/meshrooms.js), on the MeshCore demo over CDP: switch Rooms on, log in to the
 * demo room server as a guest, read its posts (authors named), post, and see the post delivered; ▦ QR in the room
 * header (type 3, never its password).
 *   node tests/meshrooms-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket)
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
    await js(`document.querySelector('button[data-page="mesh"]').click()`);
    await sleep(300);
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await js(`document.querySelector('#mesh-go').click()`);
    await until(`document.querySelectorAll('#mesh-map .mm-wrap').length >= 5`, 15000);
    await sleep(3000);   // the demo's start-up adverts
    eq('the Rooms card is shown for MeshCore, off', await js(`(() => { const c = document.querySelector('#rm-card'); return c && !c.hidden && document.querySelector('#rm-tag').textContent; })()`), 'off');
    await js(`(() => { const c = document.querySelector('#rm-on'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    eq('switched on: the demo room server is listed', await until(`/Ipswich Chat Room/.test((document.querySelector('.rm-room') || {}).textContent || '')`, 5000), true);
    await js(`(() => { document.querySelector('#rm-pw').value = 'hello'; document.querySelector('#rm-login').click(); })()`);
    eq('guest login answers', await until(`/Guest/.test((document.querySelector('#rm-card .rp-chip.ok') || {}).textContent || '')`, 20000), true);
    eq('... and its posts come in, one at a time', await until(`document.querySelectorAll('#rm-card .rm-post').length >= 6`, 30000), true);
    const posts = await js(`[...document.querySelectorAll('#rm-card .rm-post')].map(p => p.querySelector('.rm-meta b').textContent + ': ' + p.querySelector('.rm-text').textContent)`);
    eq('the room\'s notice first, then authors by name from the contacts', `${posts[0].startsWith('Ipswich Chat Room (notice): Welcome')} ${posts[1]}`, 'true VK4ZB Bravo Heltec: Anyone tried 2-byte path hashes yet? Working well here.');
    eq('an author the node has no contact for shows as a short key', /^[0-9a-f]{6}…: First post from the Coast/.test(posts[3]), true);
    eq('room posts are not in the DM list', await js(`(() => { const b = document.body.cloneNode(true); b.querySelector('#rm-card').remove(); b.querySelectorAll('script').forEach(s => s.remove()); return !/Anyone tried 2-byte/.test(b.textContent); })()`), true);
    await js(`(() => { document.querySelector('#rm-text').value = 'Hello from the CDP test'; document.querySelector('#rm-post').click(); })()`);
    eq('a post shows as yours and is delivered (the room ACKs it)', await until(`/You.*Hello from the CDP test.*|✓ in the room/.test(document.querySelector('#rm-card .rm-thread').textContent) && /✓ in the room/.test(document.querySelector('#rm-card .rm-thread').textContent)`, 20000), true);
    eq('the switch is kept in settings', await until(`((JSON.parse(localStorage.getItem('kelly.settings') || '{}').mesh) || {}).rooms === true`, 5000), true);
    eq('posts are kept in IndexedDB', await js(`new Promise(r => { const q = indexedDB.open('kelly-mesh-rooms'); q.onsuccess = () => { const g = q.result.transaction('posts').objectStore('posts').count(); g.onsuccess = () => r(g.result); }; q.onerror = () => r(-1); })`) >= 7 ? 'yes' : 'no', 'yes');
    // ▦ QR in the room header (QR_REVIEW.md opp. 4): contact/add, type 3, the room's own key; never its password
    const room = await js(`(() => { const b = document.querySelector('.rm-room.on') || document.querySelector('.rm-room'); return b && b.dataset.rmRoom; })()`);
    eq('the room header has ▦ QR, in its own row (not the password row)', await js(`(() => { const b = document.querySelector('#rm-card [data-rm="qr"]'); return !!b && !!b.closest('.rm-head') && !b.closest('.rm-top'); })()`), true);
    await js(`document.querySelector('#rm-card [data-rm="qr"]').click()`);
    eq('... -> the QR dialog', await until(`(() => { const b = document.querySelector('#mqr'); return b && !b.hidden && /^meshcore:/.test(document.querySelector('#mqr .mqr-link').value); })()`, 8000), true);
    const q = new URLSearchParams((await js(`document.querySelector('#mqr .mqr-link').value`)).split('?')[1] || '');
    eq('... type 3 (room server), its key and name', `${q.get('type')} ${q.get('public_key') === room} ${q.get('name')}`, '3 true Ipswich Chat Room');
    eq('... the guest password is nowhere in it', await js(`(() => { const b = document.querySelector('#mqr'); return b.textContent.includes('hello') || b.querySelector('.mqr-link').value.includes('hello') || !!b.querySelector('input[type=password]'); })()`), false);
    await js(`document.querySelector('#mqr [data-mqr="close"]').click()`);
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
