// Every Kelly test, one at a time (the CDP ones time out at random when run in parallel), with one summary at the end:
//   tests/*-test.js (Node), bridge/test_*.py (Python), tests/*-tests.html (one headless Edge, waits for each page's
//   RESULT line), tests/*-cdp.js (each starts its own browser).
// Node 22+: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/run-all.js [filter]
// Python: KELLY_PY (default: the uv base python), with KELLY_PYTHONPATH added (the repo's .venv site-packages).
// A filter (a substring) runs only the matching files. Exit code 1 if anything failed.
const { spawn, spawnSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const KELLY = path.join(__dirname, '..'), REPO = path.join(KELLY, '..');
const filter = process.argv[2] || '';
const PY = process.env.KELLY_PY || path.join(os.homedir(), 'AppData/Roaming/uv/python/cpython-3.14-windows-x86_64-none/python.exe');
const PYPATH = process.env.KELLY_PYTHONPATH || path.join(REPO, '.venv', 'Lib', 'site-packages');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const pick = (dir, re) => fs.readdirSync(dir).filter(f => re.test(f) && f !== 'run-all.js' && f.includes(filter)).sort();
const resultOf = text => { const m = String(text).match(/RESULT:?\s*(ALL PASS[^\n]*|FAIL[^\n]*)/i); return m ? m[1].trim() : null; };
function record(kind, name, ok, line, secs) {
  results.push({ kind, name, ok, line, secs });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${kind.padEnd(4)} ${name.padEnd(34)} ${secs.toFixed(0).padStart(4)} s  ${line || ''}`);
}

function runProc(kind, name, cmd, args, opts) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 420000, maxBuffer: 64 << 20 }, opts));
  const out = (r.stdout || '') + (r.stderr || ''), line = resultOf(out);
  const ok = r.status === 0 && (!line || /^ALL PASS/i.test(line));
  record(kind, name, ok, line || (r.error ? r.error.message : `exit ${r.status}`) + (ok ? '' : `  | ${out.trim().split('\n').filter(l => /FAIL|Error/.test(l)).slice(0, 3).join(' | ')}`), (Date.now() - t0) / 1000);
}

async function htmlPages(files) {
  if (!files.length) return;
  const PORT = 9650 + Math.floor(Math.random() * 100), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
  const br = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    for (const f of files) {
      const t0 = Date.now();
      await cmd('Page.navigate', { url: 'file:///' + path.join(__dirname, f).split(path.sep).join('/') });
      let line = null;
      while (!line && Date.now() - t0 < 120000) {
        await sleep(1000);
        const m = await cmd('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true });
        line = resultOf(m.result && m.result.result && m.result.result.value);
      }
      record('html', f, !!line && /^ALL PASS/i.test(line), line || 'no RESULT line in 120 s', (Date.now() - t0) / 1000);
    }
    ws.close();
  } finally { killTree(br, profile); await sleep(500); }
}

(async () => {
  const node = process.execPath, nenv = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
  for (const f of pick(__dirname, /-test\.js$/)) runProc('node', f, node, [path.join(__dirname, f)], { cwd: KELLY, env: nenv });
  const bridge = path.join(KELLY, 'bridge');
  for (const f of pick(bridge, /^test_.*\.py$/)) runProc('py', f, PY, [f], { cwd: bridge, env: Object.assign({}, process.env, { PYTHONPATH: PYPATH, PYTHONIOENCODING: 'utf-8' }) });
  // a page with no RESULT line is a fixture another test drives (bgtick-test.html -> bgtick-cdp.js), not a test
  await htmlPages(pick(__dirname, /-tests?\.html$/).filter(f => /RESULT/.test(fs.readFileSync(path.join(__dirname, f), 'utf8'))));
  for (const f of pick(__dirname, /-cdp\.js$/)) { runProc('cdp', f, node, [path.join(__dirname, f)], { cwd: KELLY, env: nenv }); await sleep(1500); }
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} passed${bad.length ? `; FAILED: ${bad.map(r => r.name).join(', ')}` : ''}`);
  console.log(bad.length ? `RESULT: FAIL (${bad.length})` : 'RESULT: ALL PASS');
  process.exit(bad.length ? 1 : 0);
})();
