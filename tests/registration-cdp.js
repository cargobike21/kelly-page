// Device identity (js/ident.js) + registration tokens (js/enttoken.js, js/registration.js) in the real page, over CDP:
//   ?ent=public (a copy without a registration): a device key is made and kept; it signs registration messages only;
//   a token for this device turns its features on (and survives a reload, applied before the pages load); a token
//   for another device or an expired one is refused; removing it turns them off; the token and key never appear in
//   the config file, the backup or the shared awards; the Admin card shows it all.
// Tokens here are signed by the TEST key (bridge/ent_token_vectors.json), pinned in the page before enttoken.js runs.
// Node 22+: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/registration-cdp.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const killTree = require('./killtree.js');
const T = require('../js/enttoken.js');
const V = require('../bridge/ent_token_vectors.json');
const BASE = 'file:///' + path.join(__dirname, '..', 'index.html').split(path.sep).join('/');
const PORT = 9800 + Math.floor(Math.random() * 150), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kelly-cdp-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const signer = T.nodeEd(require('crypto')).signer(Uint8Array.from({ length: 32 }, (_, i) => i));
const token = (dev, over = {}) => { const now = Math.floor(Date.now() / 1000);
  return T.issue(Object.assign({ v: 1, kid: 'kp-test', jti: 'cdp1', sub: 'VK4XYZ', dev, llid: [5051234], feat: ['p25.gateway', 'p25.text.gw'],
    net: { gw: [5059999] }, iat: now, nbf: now - 60, exp: now + 30 * 86400 }, over), signer); };
let pass = 0; const fails = [];
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) pass++; else fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`); };

(async () => {
  const br = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--allow-file-access-from-files', '--no-first-run', '--window-size=1300,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let tab; for (let i = 0; i < 50 && !tab; i++) { await sleep(200); try { tab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch {} }
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
    let id = 0; const pend = new Map(), errors = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    };
    const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const js = async expr => { const m = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return m.result && m.result.result && m.result.result.value; };
    const open = async q => { errors.length = 0; await cmd('Page.navigate', { url: `${BASE}?${q}&nofx&nosplash` }); await sleep(6000); };
    await cmd('Runtime.enable');
    await cmd('Page.enable');
    // the test key, pinned the moment enttoken.js defines KellyToken (and the early token check right after uses it)
    await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'KellyToken', { configurable: true,
      set(v) { v.KEYS['kp-test'] = '${V.keys['kp-test']}'; this.__kt = v; }, get() { return this.__kt; } });` });

    await open('ent=public');
    const ident = await js(`KellyIdent.get()`);
    eq('a device key is made', [typeof ident.pub, ident.pub.length, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(ident.fp)], ['string', 43, true]);
    eq('kept by the browser (file:// is a secure context: non-extractable WebCrypto)', ident.kind, 'webcrypto');
    eq('signs a registration message (verifies with its public key)', await js(`(async () => { const m = new TextEncoder().encode('P25X-AUTH|t|5051234|1|n');
      const s = await KellyIdent.sign(m); return [s.length, nacl.sign.detached.verify(m, s, KellyToken.unb64u((await KellyIdent.get()).pub))]; })()`), [64, true]);
    eq('refuses to sign anything else', await js(`KellyIdent.sign('KPT1.forged').then(() => 'signed', e => e.message)`), 'not a registration message');
    eq('unregistered: member features off, card says so', await js(`[KellyEnt.allowed('p25.gateway'), KellyReg.status().text, document.querySelector('#reg-pub').textContent === '${ident.pub}']`), [false, 'Not registered', true]);

    eq("another device's token refused", await js(`KellyReg.save('${token(T.b64u(new Uint8Array(32)))}').then(r => [r.ok, r.reason])`), [false, 'TOK_DEVICE']);
    eq('an expired token refused', await js(`KellyReg.save('${token(ident.pub, { iat: 1e9, nbf: 1e9, exp: 1e9 + 86400 })}').then(r => [r.ok, r.reason])`), [false, 'TOK_EXPIRED']);
    eq('still off after the refusals', await js(`KellyEnt.allowed('p25.gateway')`), false);
    const good = token(ident.pub);
    eq('this device\'s token: saved, features on (only those named)', await js(`(async () => { const r = await KellyReg.save('${good}');
      return [r.ok, KellyEnt.allowed('p25.gateway'), KellyEnt.allowed('p25.sstv'), KellyEnt.isGateway(5059999), KellyReg.status().call]; })()`), [true, true, false, true, 'VK4XYZ']);
    eq('the card shows it', await js(`[document.querySelector('#reg-state').textContent, document.querySelector('#reg-status').textContent, document.querySelector('#reg-remove').hidden]`),
      ['registered', 'Registered as VK4XYZ', false]);

    // never in the config file, the backup or the awards shared through the bridge
    const cfg = await js(`kelly.configToXml ? kelly.configToXml() : null`);
    eq('config file: no token, no device key', cfg === null ? 'no configToXml on window.kelly' : [cfg.includes(good.slice(0, 40)), cfg.includes(ident.pub)], [false, false]);
    eq('shared awards: not a synced key', await js(`!!window.KellyStateSync && !KellyStateSync.KEYS.some(k => /ent|token|ident/i.test(k))`), true);

    // a reload: the stored token is applied at once, and checked against the device again
    await open('ent=public');
    eq('after a reload: still registered, same device key', await js(`(async () => { await new Promise(r => setTimeout(r, 500));
      return [KellyEnt.allowed('p25.gateway'), (await KellyIdent.get()).pub === '${ident.pub}', KellyReg.status().checked]; })()`), [true, true, true]);
    eq('remove: features off, token gone', await js(`(async () => { await KellyReg.remove(); return [KellyEnt.allowed('p25.gateway'), localStorage.getItem('kelly.ent.token')]; })()`), [false, null]);
    eq('no page error', errors.slice(), []);
    ws.close();
  } catch (e) { fails.push('exception'); console.log('FAIL exception ' + (e.stack || e)); }
  finally {
    console.log(fails.length ? `RESULT: FAIL (${fails.length}): ${fails.join(', ')}` : `RESULT: ALL PASS (${pass})`);
    killTree(br, profile); setTimeout(() => process.exit(fails.length ? 1 : 0), 300);
  }
})();
