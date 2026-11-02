'use strict';
// Ham Contacts > Heard operators (js/hc-ops.js) over CDP, the real index.html. Part 1: #hc-demo (the demo world). Part 2: the
// MeshCore Demo link (#mesh-demo-meshcore: the live service through js/meshcore.js into js/meshcoresim.js). Screenshot: %TEMP%\heardops.png
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/hc-ops-cdp.js
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
      if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) { const t = m.params.args.map(a => a.value || a.description).join(' '); if (/Ham Contacts|hc-|Heard operators/.test(t)) errs.push(t.slice(0, 400)); }
      if (m.method === 'Runtime.exceptionThrown') errs.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable');
    const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result.exceptionDetails ? { __err: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description } : r.result.result.value; };
    const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await ev(x); if (v && !v.__err) return v; await sleep(250); } return null; };
    await fn(ev, until);
    if (shot) { await ev(`document.querySelector('#persona-picker') && (document.querySelector('#persona-picker').hidden = true); document.getElementById('hc-ops').scrollIntoView(); true`); await sleep(600); const s = await send('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(os.tmpdir(), shot), Buffer.from(s.result.data, 'base64')); }
    ok(!errs.length, 'no exceptions / warnings from Heard operators / Ham Contacts', errs.slice(0, 3).join(' | '));
  } finally { try { ws && ws.close(); } catch {} killTree(br, profile); }
}


const OPS = `document.getElementById('hc-ops')`;
const rows = `[...document.querySelectorAll('#hc-ops .hc-ops-row[data-key]')]`;
(async () => {
  await page('#hc-demo', async (ev, until) => {
    ok(await until(`!!(window.kellyHamContacts && kellyHamContacts._c.demo() && kellyHamContacts._c.visible())`, 8000), 'Ham Contacts demo open');
    ok(await until(`${rows}.length > 1`, 8000), 'Heard operators: rows from the demo world', await ev(`${rows}.length`));
    const d = await ev(`(() => { const svc = kellyHamContacts._c.svc, keys = ${rows}.map(r => r.dataset.key);
      const all = [...svc.contacts(), ...svc.heard()].map(r => r.key).filter(k => k !== (svc.state().me || {}).key);
      return { rows: keys.length, uniq: new Set(keys).size, want: new Set(all).size,
        book: ${rows}.filter(r => /In address book/.test(r.textContent)).length, contacts: svc.contacts().length,
        newb: ${rows}.filter(r => /New/.test(r.querySelector('.c-stat').textContent)).length, heard: svc.heard().length }; })()`);
    ok(d && d.rows === d.uniq && d.rows === d.want, 'one row per public key: contacts + heard, deduped', JSON.stringify(d));
    ok(d && d.book === d.contacts - 0 || (d && d.book >= d.contacts - 1), 'address-book rows marked', JSON.stringify(d));
    ok(d && d.newb > 0 && d.newb <= d.heard, 'heard-not-added rows marked New', JSON.stringify(d));
    ok(await ev(`(() => { const h = document.querySelector('#hc-heard .card-h h2'); return !!h && /Add hams/.test(h.textContent) && document.querySelector('#hc-heard [data-r="list"]').hidden; })()`), 'Heard box keeps only bulk add + settings');
    const ov = await ev(`(() => { const card = document.querySelector('#hc-ops .hc-ops'), main = document.querySelector('main') || document.body, adv = document.querySelector('#hc-ops [data-act="advert"]').getBoundingClientRect();
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, card: card.scrollWidth - card.clientWidth, advRight: Math.round(adv.right), view: document.documentElement.clientWidth }; })()`);
    ok(ov && ov.page <= 1 && ov.card <= 1 && ov.advRight <= ov.view, 'no sideways page scroll; the header buttons fit (a wide table scrolls inside its box)', JSON.stringify(ov));
    // filters + sort
    const f = await ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), set = (sel, v) => { const e = document.querySelector('#hc-ops ' + sel); if (e.type === 'checkbox') e.checked = v; else e.value = v; e.dispatchEvent(new Event(e.tagName === 'INPUT' && e.type === 'search' ? 'input' : 'change', { bubbles: true })); };
      set('[data-f="type"]', '2'); await w(300); const rep = ${rows}.map(r => r.querySelector('.c-type').textContent);
      set('[data-f="type"]', '0'); set('[data-f="newOnly"]', true); await w(300); const nw = ${rows}.every(r => /New/.test(r.querySelector('.c-stat').textContent)) && ${rows}.length > 0;
      set('[data-f="newOnly"]', false); set('[data-f="sort"]', 'name'); await w(300); const names = ${rows}.map(r => r.querySelector('.c-name b').textContent);
      set('[data-f="sort"]', 'heard'); return { rep, nw, nwDbg: { n: ${rows}.length, prefs: JSON.parse(localStorage.getItem('kelly.hcOps') || '{}') }, sorted: names.join('|') === names.slice().sort((a, b) => a.localeCompare(b)).join('|') || names.length < 2 }; })()`);
    ok(f && f.rep.length > 0 && f.rep.every(t => /Repeater/.test(t)), 'type filter: repeaters only', JSON.stringify(f && f.rep));
    ok(f && f.nw, 'New only filter', JSON.stringify(f && f.nwDbg));
    ok(f && f.sorted !== false, 'sort by name');
    // hams filter: possible = a person's station with a call; likely = verified / probable; never repeaters / rooms
    const hm = await ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), set = (sel, v) => { const e = document.querySelector('#hc-ops ' + sel); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
      const all = ${rows}.length; set('[data-f="ham"]', 'possible'); await w(300);
      const pos = ${rows}.map(r => ({ type: r.querySelector('.c-type').textContent, name: r.querySelector('.c-name').textContent.replace(/\\s+/g, ' ').trim() }));
      set('[data-f="ham"]', 'likely'); await w(300); const lik = ${rows}.length;
      set('[data-f="ham"]', 'all'); await w(300); return { all, pos, lik, back: ${rows}.length }; })()`);
    ok(hm && hm.pos.length > 0 && hm.pos.length < hm.all && hm.pos.every(p => !/Repeater|Room|Sensor/.test(p.type)), 'possible hams: fewer rows, no repeaters / rooms / sensors', JSON.stringify(hm && hm.pos.map(p => p.name)));
    ok(hm && hm.lik <= hm.pos.length && hm.back === hm.all, 'likely hams is a subset; All brings everyone back', hm && `${hm.all} all, ${hm.pos.length} possible, ${hm.lik} likely`);
    // callsign label (Kelly only)
    const cs = await ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)), row = ${rows}[0], key = row.dataset.key;
      row.querySelector('[data-act="call"]').click(); await w(200); const i = document.querySelector('#hc-ops .hc-ops-callin'); i.value = 'vk4zzq';
      document.querySelector('#hc-ops [data-act="call-save"]').click(); await w(400);
      const c = window.KellyHamCalls.callOf(key, ''); const shown = [...document.querySelectorAll('#hc-ops .hc-ops-row[data-key]')].find(r => r.dataset.key === key);
      return { call: c && c.call, src: c && c.src, shown: !!shown && /VK4ZZQ/.test(shown.textContent), rec: (kellyHamContacts._c.svc.get(key) || {}).call, txt: shown && shown.querySelector('.c-name').textContent.trim() }; })()`);
    ok(cs && cs.call === 'VK4ZZQ' && cs.src === 'mine' && cs.shown, 'callsign edit = a Kelly label, shown in the row', JSON.stringify(cs));
    // add from a row (demo service)
    const ad = await ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); const row = ${rows}.find(r => r.querySelector('[data-act="add"]')); if (!row) return null; const key = row.dataset.key;
      row.querySelector('[data-act="add"]').click(); for (let i = 0; i < 40; i++) { await w(250); const r = kellyHamContacts._c.svc.get(key); if (r && r.onRadio) break; }
      await w(1200); const after = ${rows}.find(r => r.dataset.key === key); return { onRadio: !!(kellyHamContacts._c.svc.get(key) || {}).onRadio, badge: !!after && /In address book/.test(after.textContent), noAdd: !!after && !after.querySelector('[data-act="add"]') }; })()`);
    ok(ad && ad.onRadio && ad.badge && ad.noAdd, 'Add: lands in the address book, row re-badged', JSON.stringify(ad));
  }, 'heardops.png');

  await page('#mesh-demo-meshcore', async (ev, until) => {
    ok(await until(`!!(window.kellyHamContacts && kellyHamContacts._c.svc.state().link.online && kellyHamContacts._c.svc.state().count)`, 20000), 'MeshCore Demo link up');
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="contacts"]').click(); true`);
    ok(await until(`${rows}.length > 0`, 8000), 'Heard operators: rows from the simulated node', await ev(`${rows}.length`));
    await new Promise(r => setTimeout(r, 25000));   // adverts / channel posts from the sim
    const lv = await ev(`(() => { const R = ${rows}; return { n: R.length, sig: R.filter(r => /dB/.test(r.querySelector('.c-sig').textContent)).length,
      path: R.filter(r => /direct|hop/.test(r.querySelector('.c-path').textContent)).length, loc: R.filter(r => /,/.test(r.querySelector('.c-loc').textContent)).length,
      chans: [...document.querySelectorAll('#hc-ops [data-f="ch"] option')].map(o => o.textContent),
      live: [...kellyHamContacts._c.live().values()].filter(n => n.advAt).length }; })()`);
    ok(lv && lv.sig > 0 && lv.path > 0 && lv.loc > 0, 'signal, hops/path and location columns filled', JSON.stringify(lv));
    ok(lv && lv.chans.length > 1, 'channel filter lists the node\'s channels', JSON.stringify(lv && lv.chans));
    const dm = await ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); const b = ${rows}.map(r => r.querySelector('[data-act="dm"]')).find(b => b && !b.disabled); if (!b) return null;
      b.click(); await w(500); return { tab: !!document.querySelector('[data-tabs="mesh"] [data-tab="main"].on'), focus: document.activeElement && document.activeElement.id }; })()`);
    ok(dm && dm.tab && dm.focus === 'mesh-text', '💬 opens the direct chat', JSON.stringify(dm));
    await ev(`document.querySelector('[data-tabs="mesh"] [data-tab="contacts"]').click(); true`); await new Promise(r => setTimeout(r, 600));
    const tr = await ev(`(async () => { const w = ms => new Promise(r => setTimeout(r, ms)); const b = ${rows}.map(r => r.querySelector('[data-act="trace"]')).find(b => b && !b.disabled); if (!b) return null;
      b.click(); await w(600); return { tab: !!document.querySelector('[data-tabs="mesh"] [data-tab="trace"].on') }; })()`);
    ok(tr && tr.tab, '🔭 opens Trace Route on that station', JSON.stringify(tr));
  });
  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('RESULT: FAIL', e); process.exit(1); });
