// open a test page over CDP, wait for "RESULT" in #out, print it
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
// Packet Journey sound tests (tests/pj-sound-tests.html) over CDP: --dump-dom snapshots before the offline renders end
const PAGE = process.argv[2] || 'file:///' + path.join(__dirname, 'pj-sound-tests.html').split(path.sep).join('/'), PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const br = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', PAGE], { stdio: 'ignore' });
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const js = expr => new Promise(res => { const i = ++id; pend.set(i, m => res(m.result && m.result.result && m.result.result.value)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
    let txt = ''; for (let i = 0; i < 80; i++) { txt = await js(`(document.getElementById('out')||{}).textContent||''`) || ''; if (/RESULT/.test(txt)) break; await sleep(250); }
    console.log(txt); ws.close();
  } finally { killTree(br); setTimeout(() => process.exit(0), 300); }
})();
