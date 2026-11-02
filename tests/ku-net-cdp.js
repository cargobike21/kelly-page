// Admin > Kelly updates from kellypage.app (internet), over CDP, offline: the page's requests to
// https://kellypage.app/api/release/* are answered here with a made-up release. Check -> NEW; Get -> downloaded,
// checksum-checked, ready to install/save exactly like a P25 release; a bad checksum is refused; the public build
// shows the internet option but not the P25 parts; nothing is fetched until the user asks.
// Node 22+: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/ku-net-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const killTree = require('./killtree.js');
const BASE = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/');
const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); };

const ZIP = crypto.randomBytes(300000);                    // a made-up "release": only its bytes and checksum matter here
const release = { version: '9.9.9', date: '1 January 2030', size: '0.3 MB', sha256: crypto.createHash('sha256').update(ZIP).digest('hex'), notes: 'test release', name: 'KellyPage-9.9.9.zip' };
let badSha = false; const seen = [];

(async () => {
  const br = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--allow-file-access-from-files', '--no-first-run', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map(), errors = [];
    const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      if (m.method === 'Fetch.requestPaused') {
        const p = new URL(m.params.request.url).pathname; seen.push(p);
        const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }];
        if (p === '/api/release/latest') cmd('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, body: Buffer.from(JSON.stringify(badSha ? { ...release, sha256: '0'.repeat(64) } : release)).toString('base64'),
          responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }] });
        else if (p === '/api/release/zip') cmd('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, body: ZIP.toString('base64'),
          responseHeaders: [...cors, { name: 'Content-Type', value: 'application/zip' }, { name: 'Content-Length', value: String(ZIP.length) }, { name: 'X-Kelly-Version', value: release.version }, { name: 'Access-Control-Expose-Headers', value: 'Content-Length, X-Kelly-Version' }] });
        else cmd('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 404, body: '' });
      }
      if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const js = async expr => { const m = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return m.result && m.result.result && m.result.result.value; };
    const open = async q => { errors.length = 0; await cmd('Page.navigate', { url: `${BASE}?${q}&nofx&nosplash` }); await sleep(6000); };
    const vis = sel => `(() => { const el = document.querySelector('${sel}'); return !!el && !el.closest('[data-ent-hidden]') && !el.closest('[hidden]'); })()`;
    await cmd('Runtime.enable'); await cmd('Page.enable');
    await cmd('Fetch.enable', { patterns: [{ urlPattern: 'https://kellypage.app/api/release/*' }] });

    // ---- the public build: the card is there with the internet option, the P25 parts aren't
    await open('ent=public');
    eq('public: the update card and the internet buttons show', [await js(vis('#ku-card')), await js(vis('#ku-net-check')), await js(vis('#ku-net-get'))], [true, true, true]);
    eq('public: the P25 parts are hidden', [await js(vis('#ku-check')), await js(vis('#ku-now')), await js(vis('#ku-auto')), await js(vis('#ku-avail'))], [false, false, false, false]);
    eq('nothing asked of kellypage.app until the user presses a button', seen.length, 0);
    await js(`document.querySelector('#nav [data-page="admin"]').click()`);
    eq('Check kellypage.app: the new version shows', await js(`(async () => { document.querySelector('#ku-net-check').click(); await new Promise(r => setTimeout(r, 1500));
      return [document.querySelector('#ku-net-avail').textContent.includes('v9.9.9'), document.querySelector('#ku-net-avail').textContent.includes('NEW'), document.querySelector('#ku-net-get').disabled]; })()`), [true, true, false]);
    eq('Get it: downloaded, checked, ready like a P25 release', await js(`(async () => { document.querySelector('#ku-net-get').click();
      await new Promise(r => setTimeout(r, 400)); if (!document.querySelector('#modal').hidden) document.querySelector('#modal-yes').click();   // this copy is a members' build (?ent=public only previews)
      setTimeout(() => { if (!document.querySelector('#modal').hidden) document.querySelector('#modal-no').click(); }, 4000);   // "Install now?" afterwards: not now
      for (let i = 0; i < 40 && !document.querySelector('#ku-done').offsetParent; i++) await new Promise(r => setTimeout(r, 250));
      const s = JSON.parse(localStorage.getItem('kelly.ku'));
      return [s.done, s.info.version, s.info.via, s.info.size, document.querySelector('#ku-state').textContent, !document.querySelector('#ku-done').hidden]; })()`),
      [true, '9.9.9', 'internet', ZIP.length, 'ready', true]);
    eq('the zip kept is the one that was sent', await js(`(async () => { const db = await new Promise((ok, no) => { const r = indexedDB.open('kelly-updates'); r.onsuccess = () => ok(r.result); r.onerror = no; });
      const s = JSON.parse(localStorage.getItem('kelly.ku'));
      const b = await new Promise(ok => { const t = db.transaction(db.objectStoreNames[0]).objectStore(db.objectStoreNames[0]).get(s.info.id + ':0'); t.onsuccess = () => ok(t.result); });
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), x => x.toString(16).padStart(2, '0')).join(''); })()`), release.sha256);
    eq('Get is greyed once the version is downloaded', await js(`document.querySelector('#ku-net-get').disabled`), true);
    eq('the requests were only the two release endpoints', [...new Set(seen)].sort(), ['/api/release/latest', '/api/release/zip']);

    // ---- a download that doesn't match its checksum is refused
    await js(`localStorage.removeItem('kelly.ku')`);
    badSha = true;
    await open('x=1');
    await js(`document.querySelector('#nav [data-page="admin"]').click()`);
    // a members' copy warns that kellypage.app has the public build: No = nothing fetched, Yes = carries on
    eq('members build: warns first; No fetches nothing', await js(`(async () => { document.querySelector('#ku-net-check').click(); await new Promise(r => setTimeout(r, 1200));
      const before = ${JSON.stringify('')} + performance.getEntriesByType('resource').filter(e => /release\\/zip/.test(e.name)).length;
      document.querySelector('#ku-net-get').click(); await new Promise(r => setTimeout(r, 500));
      const shown = !document.querySelector('#modal').hidden && /public build/.test(document.querySelector('#modal-body').textContent);
      document.querySelector('#modal-no').click(); await new Promise(r => setTimeout(r, 800));
      return [shown, !!JSON.parse(localStorage.getItem('kelly.ku') || '{}').done]; })()`), [true, false]);
    eq('bad checksum: refused, nothing ready', await js(`(async () => {
      document.querySelector('#ku-net-get').click(); await new Promise(r => setTimeout(r, 500)); document.querySelector('#modal-yes').click(); await new Promise(r => setTimeout(r, 2500));
      const s = JSON.parse(localStorage.getItem('kelly.ku') || '{}');
      return [!!s.done, /checksum/.test(document.querySelector('#ku-net-avail').textContent)]; })()`), [false, true]);
    eq('members build: the P25 parts show too', [await js(vis('#ku-check')), await js(vis('#ku-net-get'))], [true, true]);
    eq('no page error', errors.slice(), []);
    ws.close();
  } catch (e) { fails.push('exception'); console.log('FAIL exception ' + (e.stack || e)); }
  finally {
    console.log(fails.length ? `RESULT: FAIL (${fails.length}): ${fails.join(', ')}` : `RESULT: ALL PASS (${pass})`);
    killTree(br, profile); setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
  }
})();
