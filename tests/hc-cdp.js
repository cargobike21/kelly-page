'use strict';
// Ham Contacts over CDP: the real index.html. Part 1: #hc-demo (the demo backend). Part 2: the MeshCore Demo link
// (#mesh-demo-meshcore: the live service through js/meshcore.js into js/meshcoresim.js). Screenshot: %TEMP%\hamcontacts.png
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/hc-cdp.js
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
      if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) { const t = m.params.args.map(a => a.value || a.description).join(' '); if (/Ham Contacts|hc-|Trace Route|Packet Journey|Analyser/.test(t)) errs.push(t.slice(0, 400)); }
      if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result.exceptionDetails ? { __err: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description } : r.result.result.value; };
    const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await ev(x); if (v && !v.__err) return v; await sleep(250); } return null; };
    await fn(ev, until);
    if (shot) { await ev(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true); document.getElementById('hc-root').scrollIntoView(); true`); await sleep(600); const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(os.tmpdir(), shot), Buffer.from(s.result.data, 'base64')); }
    ok(!errs.length, 'no exceptions / warnings from Ham Contacts or its neighbours', errs.slice(0, 3).join(' | '));
  } finally { try { ws && ws.close(); } catch {} killTree(br, profile); }
}

(async () => {
  await page('#hc-demo', async (ev, until) => {
    ok(await until('!!(window.kellyHamContacts && kellyHamContacts._c.demo() && kellyHamContacts._c.visible())', 8000), 'tab open, demo on, visible');
    const s = await until(`(() => { const s = kellyHamContacts._c.svc.state(); return s.link.online && s.count ? s : null; })()`, 5000);
    ok(s && s.link.via === 'demo' && s.maxContacts === 32, 'demo service online', s && JSON.stringify({ via: s.link.via, count: s.count, max: s.maxContacts }));
    ok(await ev(`/demo/.test(document.getElementById('hc-modebadge').textContent) && /\\d+ \\/ 32/.test(document.getElementById('hc-cap-text').textContent)`), 'badge + capacity meter', await ev(`document.getElementById('hc-cap-text').textContent`));
    ok(await ev(`['hc-contacts','hc-announce','hc-heard','hc-share','hc-dir','hc-calls'].every(id => !!document.getElementById(id))`), 'every mount point exists');
    const filled = await until(`(() => { const ids = ['hc-contacts','hc-announce','hc-heard','hc-share','hc-dir','hc-calls']; const m = ids.filter(id => (document.getElementById(id).textContent || '').trim().length < 20); return m.length ? null : true; })()`, 5000);
    ok(filled, 'every part rendered something', filled ? null : await ev(`['hc-contacts','hc-announce','hc-heard','hc-share','hc-dir','hc-calls'].map(id => id + ':' + document.getElementById(id).textContent.trim().length).join(' ')`));
    ok(await until(`document.querySelectorAll('#hc-contacts [data-key], #hc-contacts .hc-ct-row').length >= 5`, 5000), 'contact rows drawn', await ev(`document.querySelectorAll('#hc-contacts [data-key], #hc-contacts .hc-ct-row').length`));
    // callsign mapping -> the record and the shell's names (the chat / Trace Route hooks read the same registry)
    const lab = await ev(`(() => { const r = kellyHamContacts._c.svc.contacts().find(x => !x.call); if (!r) return 'none'; KellyHamCalls.set(r.key, 'VK4ZQQ', r.name); return KellyHamCalls.label(r.key, r.name); })()`);
    ok(/^VK4ZQQ · /.test(lab), 'KellyHamCalls.label after a mapping', lab);
    ok(await until(`kellyHamContacts._c.svc.contacts().some(x => x.call === 'VK4ZQQ' && x.callSrc === 'mine')`, 3000), 'records carry the mapped callsign');
    // a demo card added through the service (what the share part's Add button calls)
    const add = await ev(`(async () => { const w = kellyHamContacts._c.demoWorld(); const s = w.stations.find(x => !x.on); for (let i = 0; i < 4; i++) { const r = await kellyHamContacts._c.svc.add(w.cardOf(s.name)); if (r.ok || r.code !== 'timeout') return r; } })()`);
    ok(add && add.ok, 'add a signed card', JSON.stringify(add));
    ok(await until(`/VK4Z|Rptr|Room|Sensor/.test(document.getElementById('hc-dir').textContent)`, 4000), 'demo directory listed');
    const r = await ev(`kellyHamContacts._c.svc.advert('local')`);
    ok(r && (r.ok || r.code === 'timeout'), 'advert through the facade', JSON.stringify(r));
    ok(await until(`/✅|⚠️/.test(document.getElementById('hc-readout').textContent)`, 3000), 'op result shown in the status line', await ev(`document.getElementById('hc-readout').textContent`));
    const r2 = await ev(`kellyHamContacts._c.svc.advert('local')`);
    ok(r2 && !r2.ok && r2.code === 'rate', 'second advert rate-limited', JSON.stringify(r2));
    // QR (QR_REVIEW.md): ▦ on a directory row and a contact row (real type), the 🤝 swap panel, the LoRa Mesh Scan hook
    await ev(`kellyHamContacts._c.bus.emit('visible', true); true`);
    await until(`(() => { const b = document.querySelector('#hc-dir [data-a="qr"]'); if (b) b.click(); return !!b; })()`, 6000);
    const dq = await until(`(() => { const l = document.querySelector('#mqr .mqr-link'); return l && l.value && !document.getElementById('mqr').hidden ? { link: l.value, cap: document.getElementById('mqr').textContent } : null; })()`, 6000);
    ok(dq && /^meshcore:\/\/contact\/add\?/.test(dq.link) && /from the P25X directory/.test(dq.cap), 'directory row ▦ -> its contact QR', dq && dq.link);
    await until(`(() => { const r = kellyHamContacts._c.svc.contacts().find(x => x.type === 2); const b = r && document.querySelector('#hc-contacts [data-act="qr"][data-key="' + r.key + '"]'); if (b) b.click(); return !!b; })()`, 6000);
    const cq = await until(`(() => { const l = document.querySelector('#mqr .mqr-link'); return l && /type=2/.test(l.value) ? l.value : null; })()`, 6000);
    ok(!!cq, 'contact row ▦ -> a repeater keeps type 2', cq);
    await ev(`document.querySelector('#mqr [data-mqr="close"]').click(); true`);
    const sw = await until(`(() => { const b = document.querySelector('#hc-share [data-sh="swap"]'); if (b && !b.disabled && !document.querySelector('#hc-share [data-sh="swapqr"]')) b.click(); const cv = document.querySelector('#hc-share [data-sh="swapqr"]'); return cv && cv.width > 0 && /Now scan theirs/.test(document.getElementById('hc-share').textContent) ? true : null; })()`, 25000);
    ok(sw, '🤝 swap: my QR + "Now scan theirs"');
    const imp = await ev(`(() => { const w = kellyHamContacts._c.demoWorld(); const s = w.stations.find(x => !x.on); const n = kellyHamContacts._c.svc.contacts().length; const took = window.kellyHCImport(KellyHC.qrLink({ key: s.key, type: s.type, name: s.name })); return { took, same: kellyHamContacts._c.svc.contacts().length === n, prev: /Add to my radio/.test(document.querySelector('#hc-share [data-sh="prev"]').textContent) }; })()`);
    ok(imp && imp.took && imp.same && imp.prev, 'window.kellyHCImport: preview, nothing added', JSON.stringify(imp));
    await ev(`kellyHamContacts._c.setDemo(false); true`);
    ok(await until(`!kellyHamContacts._c.svc.state().link.online && /no node/.test(document.getElementById('hc-modebadge').textContent)`, 3000), 'demo off -> no node');
  }, 'hamcontacts.png');

  await page('#mesh-demo-meshcore', async (ev, until) => {
    ok(await until(`kellyMesh && kellyMesh.state && kellyMesh.state().status === 'on'`, 15000) || await until(`!!(window.kellyHamContacts && kellyHamContacts._c.svc.state().link.online)`, 15000), 'MeshCore Demo link up');
    const s = await until(`(() => { const s = kellyHamContacts._c.svc.state(); return s.link.online && s.count && s.autoAdd ? s : null; })()`, 15000);
    ok(s && s.link.via === 'sim-link' && s.maxContacts === 350 && s.autoAdd.all === true, 'live service: contacts, table size, auto-add read from the node', s && JSON.stringify({ via: s.link.via, count: s.count, max: s.maxContacts, auto: s.autoAdd }));
    const card = await ev(`kellyHamContacts._c.svc.myCard()`);
    ok(card && card.ok && card.value.key === s.me.key, 'my card: exported by the node, signature verified', JSON.stringify(card && (card.ok ? card.value.name : card)));
    const off = await ev(`kellyHamContacts._c.svc.setAutoAdd({ all: false, types: { companion: false, repeater: true, room: false, sensor: false } })`);
    ok(off && off.ok && off.value.all === false && off.value.types.repeater === true && off.value.types.companion === false, 'auto-add off, repeaters only (SET_OTHER_PARAMS + SET_AUTOADD_CONFIG)', JSON.stringify(off));
    const c0 = await ev(`kellyHamContacts._c.svc.contacts().find(c => c.type === 1).key`);
    const rm = await ev(`kellyHamContacts._c.svc.remove(${JSON.stringify(c0)})`);
    ok(rm && rm.ok && !(await ev(`!!kellyHamContacts._c.svc.contacts().find(c => c.key === ${JSON.stringify(c0)})`)), 'remove a companion', JSON.stringify(rm));
    const fav = await ev(`(async () => { const k = kellyHamContacts._c.svc.contacts()[0].key; const r = await kellyHamContacts._c.svc.setFav(k, true); return { r, fav: kellyHamContacts._c.svc.get(k).fav }; })()`);
    ok(fav && fav.r.ok, 'favourite flag written', JSON.stringify(fav));
    const disc = await ev(`(async () => { const k = kellyHamContacts._c.svc.contacts().find(c => c.type === 1).key; const r = await kellyHamContacts._c.svc.allowDiscover(k, true); return { r, on: kellyHamContacts._c.svc.get(k).letsDiscover, base: kellyHamContacts._c.svc.state().telemetryBase }; })()`);
    ok(disc && disc.r.ok && disc.on && disc.base === 1, 'allow discovery: contact flag 0x02 + base telemetry 1 (SET_OTHER_PARAMS, 3 bytes)', JSON.stringify(disc));
    const back = await ev(`kellyHamContacts._c.svc.refresh()`);
    ok(back && back.ok, 'refresh reads the whole table again', JSON.stringify(back));
    // a re-read is not traffic: last heard must not jump to "now" for every contact (review finding, 2026-10-24)
    const ages = await ev(`(async () => { await new Promise(r => setTimeout(r, 3000)); await kellyHamContacts._c.svc.refresh(); const b = kellyHamContacts._c.svc.contacts().map(c => Date.now() - (c.lastHeard || 0)); return { fresh: b.filter(x => x < 1500).length, n: b.length }; })()`);
    ok(ages && ages.n > 3 && ages.fresh <= 1, 'refresh does not mark contacts as heard', JSON.stringify(ages));
    // an in-person QR swap writes a zero-hop route (ADD_UPDATE_CONTACT out_path_len 0); a plain add leaves it unknown
    const dr = await ev(`(async () => { const S = kellyHamContacts._c.svc, a = 'd1'.repeat(32), b = 'd2'.repeat(32);
      const go = async (...x) => { let r; for (let i = 0; i < 4; i++) { r = await S.add(...x); if (r.ok || r.code !== 'timeout') break; } return r; };
      const r1 = await go({ key: a, type: 1, name: 'VK4ZZS Swap' }, { direct: true }), r2 = await go({ key: b, type: 1, name: 'VK4ZZT Plain' });
      await S.refresh(); const A = S.get(a), B = S.get(b); return { r1: r1.ok, r2: r2.ok, a: !!(A && A.onRadio), b: !!(B && B.onRadio) }; })()`);
    // (js/meshcoresim.js keeps a NEW contact's route unknown whatever out_path_len says, so hops can't be checked here)
    ok(dr && dr.r1 && dr.r2 && dr.a && dr.b, 'swap add { direct: true } through meshcore.js, and a plain add, both land on the node', JSON.stringify(dr));
  });
  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('RESULT: FAIL', e); process.exit(1); });
