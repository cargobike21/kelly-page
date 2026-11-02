// js/registration.js consumes kellypage.app/api/revoked: a token whose jti or device is on the verified list loses its
// entitlements (KellyEnt reason ENT_REVOKED); an older list, a bad signature, file:// or a 404 change nothing.
// Node: node tests/revocation-test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const T = require('../js/enttoken.js');

let pass = 0; const fails = [];
const t = (name, ok, got) => { if (ok) pass++; else { fails.push(name); console.log(`FAIL ${name}${got !== undefined ? '  got ' + JSON.stringify(got) : ''}`); } };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ed = T.nodeEd(crypto);
const lic = ed.signer(new Uint8Array(32).fill(5)), other = ed.signer(new Uint8Array(32).fill(6)), dev = ed.signer(new Uint8Array(32).fill(7));
const DEV = T.b64u(dev.publicKey), NOW = Math.floor(Date.now() / 1000);
const pay = (o = {}) => ({ v: 1, kid: 'kp-test', jti: 'aaaa1111bbbb2222', sub: 'VK9TST', dev: DEV, llid: [5051234], feat: ['p25.gateway'], iat: NOW, nbf: NOW - 5, exp: NOW + 86400, ...o });
const list = (o = {}, signer = lic) => T.issueRevocations({ v: 1, kid: 'kp-test', seq: 5, at: NOW, next: NOW + 7200, jti: [], dev: [], ...o }, signer);

function page(protocol, served) {
  const store = {};
  const win = { localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } }, location: { origin: protocol + '//x', protocol, search: '' }, store };
  win.window = win; win.self = win; win.globalThis = win;
  win.fetch = async (url) => { win.fetched = (win.fetched || 0) + 1; return served.v === null ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => served.v }; };
  const ctx = vm.createContext(win);
  Object.assign(ctx, { TextEncoder, TextDecoder, URLSearchParams, Date, setInterval: () => 0, console });
  vm.runInContext(read('js/enttoken.js'), ctx);
  vm.runInContext(read('vendor/tweetnacl-1.0.3/nacl-fast.min.js'), ctx);
  ctx.KellyToken.KEYS['kp-test'] = Buffer.from(lic.publicKey).toString('hex');
  ctx.KellyIdent = { get: async () => ({ pub: DEV, kind: 'x', fp: 'F' }), sign: async () => new Uint8Array(64) };
  vm.runInContext(read('js/entitlements.js').replace(/const BUILD = '[a-z]+';/, "const BUILD = 'public';"), ctx);
  vm.runInContext(read('js/registration.js'), ctx);
  return ctx;
}
const tokenFor = p => T.issue(p, lic);
// KellyReg.revocations is internal: it runs from tick() inside init(); drive it through init().
async function run(protocol, served, payload) {
  const c = page(protocol, served);
  c.localStorage.setItem('kelly.ent.token', tokenFor(payload));
  vm.runInContext(read('js/registration.js'), c);                // re-run: the stored token is applied at load
  await c.KellyReg.init();
  await new Promise(r => setTimeout(r, 20));
  return c;
}

(async () => {
  let served = { v: list() };
  let c = await run('https:', served, pay());
  t('not on the list: entitlements stay', c.KellyEnt.allowed('p25.gateway'), c.KellyEnt.log.slice(-1));
  t('the list was fetched and its seq kept', c.localStorage.getItem('kelly.rev.seq') === '5');

  served = { v: list({ jti: ['aaaa1111bbbb2222'] }) };
  c = await run('https:', served, pay());
  t('this jti revoked: ENT_REVOKED', !c.KellyEnt.check('p25.gateway', 'x') && c.KellyEnt.log.slice(-1)[0].reason === 'ENT_REVOKED', c.KellyEnt.log.slice(-1));

  served = { v: list({ dev: [DEV] }) };
  c = await run('https:', served, pay());
  t('this device revoked: ENT_REVOKED', !c.KellyEnt.allowed('p25.gateway'));

  served = { v: list({ jti: ['aaaa1111bbbb2222'] }, other) };
  c = await run('https:', served, pay());
  t('a list with a bad signature is ignored', c.KellyEnt.allowed('p25.gateway'));

  served = { v: null };
  c = await run('https:', served, pay());
  t('404: nothing changes', c.KellyEnt.allowed('p25.gateway'));

  served = { v: list({ jti: ['aaaa1111bbbb2222'] }) };
  c = await run('file:', served, pay());
  t('file://: never fetched, entitlements stay', !c.fetched && c.KellyEnt.allowed('p25.gateway'), c.fetched);

  // an older list than the one seen cannot un-revoke
  c = page('https:', { v: list({ seq: 9, jti: ['aaaa1111bbbb2222'] }) });
  c.localStorage.setItem('kelly.ent.token', tokenFor(pay()));
  vm.runInContext(read('js/registration.js'), c); await c.KellyReg.init(); await new Promise(r => setTimeout(r, 20));
  t('seq 9 revokes', !c.KellyEnt.allowed('p25.gateway'));
  c.fetch = async () => ({ ok: true, status: 200, text: async () => list({ seq: 4, jti: [] }) });
  c.window.fetch = c.fetch;
  await c.KellyReg.init(); await new Promise(r => setTimeout(r, 20));
  t('an older seq (4) does not bring it back', !c.KellyEnt.allowed('p25.gateway') && c.localStorage.getItem('kelly.rev.seq') === '9');

  // a refreshed token with a new jti is not on the held list
  c.KellyEnt.setToken(pay({ jti: 'cccc3333dddd4444' }));
  t('KellyEnt: serial binding, token ser vs the connected radio', (() => { c.KellyEnt.setRevoked(false); c.KellyEnt.setToken(pay({ ser: ['SER1'] })); c.KellyEnt.setSerial('SER2'); const a = c.KellyEnt.allowed('p25.gateway'); c.KellyEnt.setSerial('ser1'); return !a && c.KellyEnt.allowed('p25.gateway'); })());

  console.log(fails.length ? `RESULT: FAIL (${fails.length})` : `RESULT: ALL PASS (${pass})`);
  process.exit(fails.length ? 1 : 0);
})();
