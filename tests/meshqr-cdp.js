/* Kelly Page -- QR contacts (Phase 10: js/meshqr.js in the Contacts card, js/meshcontacts.js), driven in the REAL page
 * over the Chrome DevTools Protocol with the MeshCore demo node:
 *   the libraries load only when a QR dialog opens; Show QR (the app's contact/add form, then the signed advert);
 *   From image round trip (the shown QR saved as a PNG -> the contact removed -> From image shows the PREVIEW first:
 *   Cancel writes nothing, Add adds it back; again = "already on your radio as X"); the paste box previews too; your own
 *   QR refused as an import; a malformed link refused; Export link of another contact carries no path (C10); ▦ QR on
 *   the repeater card (type 2) and the node info panel (type from the node); Scan QR with a fake camera: it runs, and
 *   closing stops the camera.
 *   node tests/meshqr-cdp.js [path to chrome/msedge]     (Node 22+, for its built-in WebSocket; or VS Code's Code.exe
 *   with ELECTRON_RUN_AS_NODE=1)
 * Throwaway browser profile; prints PASS/FAIL lines and RESULT: ALL PASS / FAIL. */
'use strict';
const { spawn } = require('child_process');
const killTree = require('./killtree');
const fs = require('fs'), os = require('os'), path = require('path');
const BROWSER = process.argv[2] || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const KP = path.resolve(__dirname, '..');
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const PNG = path.join(profile, 'contact-qr.png');
const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); if (!ok) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const br = spawn(BROWSER, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', '--window-size=1200,900',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    'file:///' + path.join(KP, 'index.html').replace(/\\/g, '/') + '?nosplash'], { stdio: 'ignore' });
  let ws, id = 0;
  const pend = new Map(), errs = [], chooser = [];
  try {
    let tab;
    for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
    if (!tab) throw new Error('browser did not start');
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text);
      if (m.method === 'Page.fileChooserOpened') chooser.push(m.params);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
    const js = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception || {}).description); return r.result.result.value; };
    const until = async (expr, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(250); } return false; };
    const pick = (sel, v) => js(`(() => { const e = document.querySelector('${sel}'); e.value = '${v}'; e.dispatchEvent(new Event('change', { bubbles: true })); return e.value; })()`);
    const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const msg = () => js(`(document.querySelector('#mc-body p.small:last-child') || {}).textContent || ''`);
    const hasOpt = key => js(`[...document.querySelectorAll('#mc-sel option')].some(o => o.value === ${JSON.stringify(key)})`);
    const preview = () => until(`(() => { const b = document.querySelector('#mqr'); return b && !b.hidden && /Add this contact/.test(document.querySelector('#mqr-title').textContent) && !!b.querySelector('[data-mqr="yes"]'); })()`, 10000);
    const dlg = () => js(`document.querySelector('#mqr-body').textContent`);
    // From image: the page's file picker answered with a file on disk (Page.setInterceptFileChooserDialog)
    const fromImage = async file => {
      chooser.length = 0;
      await click('[data-mc="img"]');
      for (let i = 0; i < 40 && !chooser.length; i++) await sleep(100);
      if (!chooser.length) throw new Error('no file chooser');
      await send('DOM.setFileInputFiles', { files: [file], backendNodeId: chooser[0].backendNodeId });
    };

    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    // past the first-run persona picker (it sits over the page in a fresh profile)
    await js(`(() => { const s = JSON.parse(localStorage.getItem('kelly.settings') || '{}'); s.persona = 'shack'; localStorage.setItem('kelly.settings', JSON.stringify(s)); location.reload(); })()`);
    await sleep(800);
    await until(`document.readyState === 'complete' && !!document.querySelector('#mesh-dev')`);
    await sleep(1200);
    await js(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true)`);
    await send('Page.setInterceptFileChooserDialog', { enabled: true });
    await click('button[data-page="mesh"]'); await sleep(300);
    await pick('#mesh-dev', 'meshcore'); await pick('#mesh-link', 'demo');
    await click('#mesh-go');
    eq('MeshCore demo: the Contacts card with contacts', await until(`!document.querySelector('#mc-card').hidden && document.querySelectorAll('#mc-sel option[value]').length >= 3`, 20000), true);
    eq('... the four QR buttons', await js(`['qr', 'myqr', 'scan', 'img'].map(x => !!document.querySelector('[data-mc="' + x + '"]'))`), [true, true, true, true]);
    eq('the QR libraries are not loaded with the page', await js(`[typeof window.qrcode, typeof window.jsQR]`), ['undefined', 'undefined']);

    // ---- Show QR: a repeater contact
    const sel = await js(`(() => { const s = document.querySelector('#mc-sel'), o = [...s.options].find(x => /Repeater/.test(x.textContent)) || s.options[0]; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return { key: o.value, name: o.textContent.split(' · ')[0] }; })()`);
    await sleep(300);
    await click('[data-mc="qr"]');
    eq('Show QR -> the dialog with a drawn code', await until(`(() => { const b = document.querySelector('#mqr'); return b && !b.hidden && document.querySelector('#mqr .mqr-code').width > 200 && /^meshcore:/.test(document.querySelector('#mqr .mqr-link').value); })()`, 8000), true);
    eq('... the encoder loaded on first use (the decoder not yet)', await js(`[typeof window.qrcode, typeof window.jsQR]`), ['function', 'undefined']);
    const link = await js(`document.querySelector('#mqr .mqr-link').value`);
    eq('... the app form: name, key, type 2 (repeater)', link, `meshcore://contact/add?${new URLSearchParams({ name: sel.name, public_key: sel.key, type: '2' })}`);
    eq('... the code is black on white', await js(`(() => { const c = document.querySelector('#mqr .mqr-code'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let w = 0, b = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] === 255) w++; else if (d[i] === 0) b++; } return w + b === d.length / 4 && b > 0; })()`), true);
    const png = await js(`document.querySelector('#mqr .mqr-code').toDataURL('image/png')`);
    fs.writeFileSync(PNG, Buffer.from(png.split(',')[1], 'base64'));
    await click('#mqr [data-fmt="advert"]');
    eq('Signed advert tab -> the node\'s exported advert link', await until(`/^meshcore:\\/\\/[0-9a-f]{200,}$/.test(document.querySelector('#mqr .mqr-link').value)`, 8000), true);
    await click('#mqr [data-mqr="close"]');
    eq('✕ closes it', await js(`document.querySelector('#mqr').hidden`), true);

    // ---- From image round trip: remove the contact, then read it back from the PNG of its QR
    await js(`window.confirm = () => true`);
    await click('[data-mc="remove"]');
    eq('the contact is removed', await until(`![...document.querySelectorAll('#mc-sel option')].some(o => o.value === ${JSON.stringify(sel.key)})`, 8000), true);
    await fromImage(PNG);
    eq('From image (the saved QR) -> a preview first', await preview(), true);
    eq('... the decoder loaded on first use', await js(`typeof window.jsQR`), 'function');
    const pv = await dlg();
    eq('... name, type, fingerprint, unsigned, new', [pv.includes(sel.name), /Repeater/.test(pv), pv.includes(sel.key.slice(0, 8) + '…' + sel.key.slice(-8)), /unsigned app QR/.test(pv), /New contact/.test(pv)], [true, true, true, true, true]);
    eq('... nothing written before Add', await hasOpt(sel.key), false);
    await click('#mqr [data-mqr="no"]');
    eq('Cancel -> "Nothing was added", still not on the node', [await until(`/Nothing was added/.test((document.querySelector('#mc-body p.small:last-child') || {}).textContent || '')`, 5000), await hasOpt(sel.key)], [true, false]);
    await fromImage(PNG);
    await preview();
    await click('#mqr [data-mqr="yes"]');
    eq('Add -> "Added" ...', await until(`/Added: /.test((document.querySelector('#mc-body p.small:last-child') || {}).textContent || '')`, 10000), true);
    eq('... and the contact is back on the node, same key and name', await until(`[...document.querySelectorAll('#mc-sel option')].some(o => o.value === ${JSON.stringify(sel.key)} && o.textContent.startsWith(${JSON.stringify(sel.name)}))`, 8000), true);
    await fromImage(PNG);
    await preview();
    eq('the same picture again -> the preview says it is on your radio, by name', (await dlg()).includes(`Already on your radio as "${sel.name}"`), true);
    await click('#mqr [data-mqr="yes"]');
    eq('... and adding it changes nothing', await until(`/already in your contacts/.test((document.querySelector('#mc-body p.small:last-child') || {}).textContent || '')`, 10000), true);

    // ---- the paste box previews too; Cancel writes nothing
    const fresh = 'f'.repeat(8) + '0123456789abcdef'.repeat(3) + '9'.repeat(8);
    await js(`document.querySelector('#mc-imp').value = 'meshcore://contact/add?name=Pasted+VK4ZZZ&public_key=${fresh}&type=1'`);
    await click('[data-mc="import"]');
    eq('paste box -> the preview', await preview(), true);
    eq('... with the name from the card', /Pasted VK4ZZZ/.test(await dlg()), true);
    await click('#mqr [data-mqr="no"]');
    await sleep(300);
    eq('... Cancel: not added, the link stays in the box', [await hasOpt(fresh), await js(`document.querySelector('#mc-imp').value.includes('${fresh}')`)], [false, true]);
    await js(`document.querySelector('#mc-imp').value = ''`);

    // ---- Export link of ANOTHER contact: re-made without its path (C10)
    await click('[data-mc="export"]');
    await until(`!!document.querySelector('#mc-link')`, 8000);
    const ex = (await js(`document.querySelector('#mc-link').value`)).replace(/^meshcore:\/\//, '');
    eq('Export link: a flood advert with no path (header route 1, path_len 0)', [parseInt(ex.slice(0, 2), 16) & 3, ex.slice(2, 4)], [1, '00']);
    eq('... a path in an exported advert is stripped (bareAdvert)', await js(`(() => { const h = ${JSON.stringify(ex)}, withPath = h.slice(0, 2) + '03' + 'a1b2c3' + h.slice(4), b = window.KellyMeshContacts.bareAdvert(withPath); return [b.bare === h, b.key.length]; })()`), [true, 64]);
    eq('... and it fits the importers (<= 171 bytes)', ex.length / 2 <= 171, true);

    // ---- My QR: shown, and refused as an import
    await click('[data-mc="myqr"]');
    await until(`!document.querySelector('#mqr').hidden && /^meshcore:\\/\\/contact/.test(document.querySelector('#mqr .mqr-link').value)`, 8000);
    const mine = await js(`document.querySelector('#mqr .mqr-link').value`);
    eq('My QR: this node as a companion', /^meshcore:\/\/contact\/add\?name=[^&]+&public_key=[0-9a-f]{64}&type=1$/.test(mine), true);
    fs.writeFileSync(PNG, Buffer.from((await js(`document.querySelector('#mqr .mqr-code').toDataURL('image/png')`)).split(',')[1], 'base64'));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    eq('Escape closes the dialog', await js(`document.querySelector('#mqr').hidden`), true);
    await fromImage(PNG);
    eq('your own QR as an import -> refused', await until(`/your own node/.test((document.querySelector('#mc-body p.small:last-child') || {}).textContent || '')`, 10000), true);

    // ---- a malformed link in the import box
    await js(`document.querySelector('#mc-imp').value = 'meshcore://contact/add?name=x&public_key=abcd&type=1'`);
    await click('[data-mc="import"]');
    await sleep(300);
    eq('a malformed contact link is refused', /public key/.test(await msg()), true);

    // ---- ▦ QR on the repeater card: type 2 from the contact (never the default 1)
    await js(`document.querySelector('#mqr [data-mqr="close"]') && document.querySelector('#mqr [data-mqr="close"]').click()`);
    const rq = await js(`(() => { const s = document.querySelector('#rp-sel'); if (!s) return null; const o = [...s.options].find(x => / · Repeater/.test(x.textContent)); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return o.value; })()`);
    if (rq) {
      await sleep(300);
      await click('#rp-card [data-rp="qr"]');
      await until(`!document.querySelector('#mqr').hidden && /^meshcore:\\/\\/contact/.test(document.querySelector('#mqr .mqr-link').value)`, 8000);
      const rl = new URLSearchParams((await js(`document.querySelector('#mqr .mqr-link').value`)).split('?')[1] || '');
      eq('repeater card ▦ QR: its key, type 2', `${rl.get('public_key') === rq} ${rl.get('type')}`, 'true 2');
      await click('#mqr [data-mqr="close"]');
    } else eq('repeater card present in the demo', false, true);
    // ---- ▦ QR in the node info panel: a MeshCore node with its whole key; the type from the node
    const ni = await js(`(() => { const r = [...document.querySelectorAll('#mesh-nodes [data-node]')].find(x => /Rptr/.test(x.textContent)); if (!r) return null; r.click(); return r.textContent; })()`);
    eq('node info panel opened from the Nodes list', await until(`!document.querySelector('#mesh-info').hidden && !!document.querySelector('[data-mi="qr"]')`, 5000) && !!ni, true);
    await click('[data-mi="qr"]');
    await until(`!document.querySelector('#mqr').hidden && /^meshcore:\\/\\/contact/.test(document.querySelector('#mqr .mqr-link').value)`, 8000);
    const il = new URLSearchParams((await js(`document.querySelector('#mqr .mqr-link').value`)).split('?')[1] || '');
    eq('... ▦ QR of that repeater: a whole key, type 2', `${/^[0-9a-f]{64}$/.test(il.get('public_key'))} ${il.get('type')}`, 'true 2');
    await click('#mqr [data-mqr="close"]');
    await js(`document.querySelector('[data-mi="close"]').click()`);

    // ---- Scan QR with the fake camera: it runs; closing stops the camera
    eq('file:// is a secure context: Scan QR enabled', await js(`!document.querySelector('[data-mc="scan"]').disabled`), true);
    await click('[data-mc="scan"]');
    eq('Scan QR -> the camera runs in the dialog', await until(`(() => { const v = document.querySelector('#mqr .mqr-video'); return !!(v && v.srcObject && v.readyState >= 2); })()`, 8000), true);
    await js(`window.__qrTrack = document.querySelector('#mqr .mqr-video').srcObject.getVideoTracks()[0]`);
    await sleep(800);
    eq('... still scanning (no QR in the fake picture)', await js(`!document.querySelector('#mqr').hidden && window.__qrTrack.readyState`), 'live');
    await click('#mqr');   // the backdrop
    await sleep(300);
    eq('closing stops the camera', await js(`[document.querySelector('#mqr').hidden, window.__qrTrack.readyState, document.querySelector('#mqr .mqr-video') ? document.querySelector('#mqr .mqr-video').srcObject : null]`), [true, 'ended', null]);
    eq('no page errors', errs, []);
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
