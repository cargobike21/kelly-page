// js/websync.js: webOk, the KPD1 envelope check, pulling the iGate club list, the put/upload requests. Node 22+.
// Run: node tests/websync-test.js   (or via tests/run-all.js)
const crypto = require('crypto'), path = require('path');
const J = f => path.join(__dirname, '..', 'js', f);
const WS = require(J('websync.js')), HC = require(J('hc-core.js')), IG = require(J('igate-wl.js')), T = require(J('enttoken.js'));
let pass = 0; const fails = [];
const t = (name, ok, got) => { if (ok) pass++; else { fails.push(name); console.log(`FAIL ${name}${got !== undefined ? '  got ' + JSON.stringify(got) : ''}`); } };
const ed = HC.nodeEd(crypto), te = (s) => new TextEncoder().encode(s);
const lic = ed.signer(Uint8Array.from({ length: 32 }, (_, i) => 5 + i)), other = ed.signer(Uint8Array.from({ length: 32 }, (_, i) => 77 + i));
const LK = [HC.hex(lic.publicKey)];
const kpd1 = (obj, signer = lic, tamper = '') => { const seg = HC.b64u(te(JSON.stringify(obj))); return `KPD1.${seg}${tamper}.${HC.b64u(signer.sign(te('KPD1.' + seg)))}`; };
const node = ed.signer(Uint8Array.from({ length: 32 }, (_, i) => 150 + i));
const entry = (n = 'VK4ABC node') => { const e = { k: HC.hex(node.publicKey), c: 'VK4ABC', n, t: 1, at: 1790000000, x: 0 }; e.s = HC.b64u(node.sign(HC.dirBytes(e))); return e; };

t('webOk: file:// is not', WS.webOk({ location: { protocol: 'file:' }, navigator: { onLine: true } }) === false);
t('webOk: https and online is', WS.webOk({ location: { protocol: 'https:' }, navigator: { onLine: true } }) === true);
t('webOk: offline is not', WS.webOk({ location: { protocol: 'https:' }, navigator: { onLine: false } }) === false);

let r = WS.parseKpd1(kpd1({ v: 1, at: 1790000500, e: [entry()] }), ed, LK);
t('KPD1: a good envelope parses', r.ok && r.at === 1790000500 && r.e.length === 1, r);
t('KPD1: its entry verifies by its own node signature', r.ok && HC.verifyEntry(r.e[0], ed, { now: 1790000600000 }).ok);
t('KPD1: signed by another key refused', !WS.parseKpd1(kpd1({ v: 1, at: 1, e: [] }, other), ed, LK).ok);
t('KPD1: a tampered body refused', !WS.parseKpd1(kpd1({ v: 1, at: 1, e: [] }, lic, 'A'), ed, LK).ok);
t('KPD1: no pinned key = refused', !WS.parseKpd1(kpd1({ v: 1, at: 1, e: [] }), ed, []).ok);
t('KPD1: wrong version/shape refused', !WS.parseKpd1(kpd1({ v: 2, at: 1, e: [] }), ed, LK).ok && !WS.parseKpd1(kpd1({ v: 1, at: 1 }), ed, LK).ok);
t('KPD1: junk refused', !WS.parseKpd1('hello', ed, LK).ok && !WS.parseKpd1('', ed, LK).ok);
const forgedEntry = Object.assign(entry(), { n: 'VK4ABC changed' });
r = WS.parseKpd1(kpd1({ v: 1, at: 1, e: [forgedEntry] }), ed, LK);
t('KPD1: a valid envelope does not vouch for a forged entry (the caller\'s HC.verifyEntry drops it)', r.ok && !HC.verifyEntry(r.e[0], ed).ok);

(async () => {
  const mk = (status, text) => async () => ({ ok: status < 300, status, text: async () => text, json: async () => JSON.parse(text) });
  let seen = null;
  const pullWith = async (text, status = 200, accept) => WS.pullHamdir({ fetch: async (u, o) => { seen = u; return mk(status, text)(); }, ed, keys: LK });
  r = await pullWith(kpd1({ v: 1, at: 9, e: [] }));
  t('pullHamdir: GET kellypage.app/api/hamdir, parsed', seen === 'https://kellypage.app/api/hamdir' && r.ok && r.at === 9, [seen, r]);
  r = await pullWith('', 503); t('pullHamdir: a 503 is a quiet failure', !r.ok && r.status === 503);
  r = await WS.pullHamdir({ fetch: async () => { throw new Error('offline'); }, ed, keys: LK }); t('pullHamdir: a network error is a quiet failure', !r.ok && /offline/.test(r.error));

  // the iGate club list: the existing accept() rules (pinned keys, version only up) decide
  const adm = IG.nodeEd(crypto).signer(Uint8Array.from({ length: 32 }, (_, i) => 9 + i)), igEd = IG.nodeEd(crypto), keys = [IG.hex(adm.publicKey)];
  const list = (v, n) => IG.sign({ v, at: 1790000000 + v, by: 'VK4XXX', e: n ? [{ k: HC.hex(node.publicKey), c: 'VK4ABC', s: 7, y: '/>', m: '', e: 1, by: 'VK4XXX', at: 1790000000 }] : [] }, adm);
  let kept = IG.accept(null, list(2, 1), igEd, keys).doc;
  const take = doc => { const a = IG.accept(kept, doc, igEd, keys); if (a.ok) kept = a.doc; return a.ok; };
  r = await WS.pullIgateWl({ fetch: mk(200, JSON.stringify(list(3, 1))), accept: take });
  t('pullIgateWl: a newer signed list is taken', r.ok && r.accepted === true && kept.b.v === 3);
  r = await WS.pullIgateWl({ fetch: mk(200, JSON.stringify(list(1, 0))), accept: take });
  t('pullIgateWl: an older list is not (version only goes up)', r.ok && r.accepted === false && kept.b.v === 3);
  const bad = list(9, 1); bad.b.v = 10;
  r = await WS.pullIgateWl({ fetch: mk(200, JSON.stringify(bad)), accept: take });
  t('pullIgateWl: a bad signature is not, last good copy kept', r.accepted === false && kept.b.v === 3);
  r = await WS.pullIgateWl({ fetch: mk(404, '{"error":"no club list yet"}'), accept: take }); t('pullIgateWl: 404 is quiet', !r.ok && r.status === 404 && kept.b.v === 3);
  r = await WS.pullIgateWl({ fetch: mk(200, 'not json'), accept: take }); t('pullIgateWl: non-JSON is quiet', !r.ok);

  // requests
  let req = null;
  const rec = (status, body) => async (u, o) => { req = { u, o }; return { ok: status < 300, status, json: async () => body }; };
  r = await WS.uploadIgateWl({ fetch: rec(200, { ok: true, v: 4 }), doc: list(4, 1) });
  t('uploadIgateWl: POST the doc as the body, no bearer token', r.ok && r.v === 4 && req.u.endsWith('/api/sync/igate-wl') && !req.o.headers.Authorization && JSON.parse(req.o.body).b.v === 4);
  r = await WS.uploadIgateWl({ fetch: rec(409, { error: 'older' }), doc: list(4, 1) }); t('uploadIgateWl: a refusal reports the error', !r.ok && r.error === 'older');

  // putHamdir: the registration token + a device-key signature over "P25X-POP|hdput|<jti>|<dirBytes>|<t>"
  const devKey = ed.signer(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
  const KPT = HC.b64u(te(JSON.stringify({ v: 1, kid: 'kp-test', jti: '00aa11bb22cc33dd', sub: 'VK4ABC', dev: HC.b64u(devKey.publicKey), feat: [], exp: 2e9 }))) + '.sig';
  const signed = []; const sign = async m => { signed.push(m); return devKey.sign(te(m)); };
  r = await WS.putHamdir({ fetch: rec(200, { ok: true, n: 1 }), entry: entry(), token: KPT, sign, now: () => 1790000123456 });
  const pb = JSON.parse(req.o.body), msg = WS.hdPutMessage('00aa11bb22cc33dd', entry(), 1790000123);
  t('putHamdir: {entry, token, t, sig_dev} to /api/hamdir/put', r.ok && req.u.endsWith('/api/hamdir/put') && pb.token === KPT && pb.entry.c === 'VK4ABC' && pb.t === 1790000123, pb);
  t('putHamdir: the device key signs P25X-POP|hdput|<jti>|<dirBytes>|<t>', signed[0] === msg && msg.startsWith('P25X-POP|hdput|00aa11bb22cc33dd|P25X-HDIR1|')
    && ed.verify(T.unb64u(pb.sig_dev), te(msg), devKey.publicKey));
  t('putHamdir: dirBytes in the message = hc-core dirBytes', msg.includes('|' + new TextDecoder().decode(HC.dirBytes(entry())) + '|'));
  const S = await import(require('url').pathToFileURL(path.join(__dirname, '..', '..', 'tools', 'kellypage-reg', 'sync.js')).href);
  t('putHamdir: the same message the server checks (sync.js hdPutMessage)', S.hdPutMessage('00aa11bb22cc33dd', entry(), 1790000123) === msg);
  r = await WS.putHamdir({ fetch: rec(200, {}), entry: entry(), token: KPT }); t('putHamdir: no device key = nothing sent', !r.ok && /device key/.test(r.error));
  r = await WS.putHamdir({ fetch: rec(200, {}), entry: entry(), token: 'junk', sign }); t('putHamdir: no token = nothing sent', !r.ok && /token/.test(r.error));
  r = await WS.putHamdir({ fetch: rec(403, { error: 'token expired' }), entry: entry(), token: KPT, sign }); t('putHamdir: a refusal reports the error', !r.ok && r.error === 'token expired');

  console.log(`${pass} passed, ${fails.length} failed`);
  console.log(fails.length ? `RESULT: FAIL (${fails.join(', ')})` : 'RESULT: ALL PASS');
  process.exit(fails.length ? 1 : 0);
})();
