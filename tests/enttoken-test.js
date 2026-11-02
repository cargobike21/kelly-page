// js/enttoken.js: the registration token vectors (bridge/ent_token_vectors.json, = bridge/test_kelly_ent.py) + helpers.
// Node: node tests/enttoken-test.js (VS Code's: ELECTRON_RUN_AS_NODE=1 Code.exe tests/enttoken-test.js)
'use strict';
const T = require('../js/enttoken.js');
const V = require('../bridge/ent_token_vectors.json');
const ed = T.nodeEd(require('crypto'));

let pass = 0; const fails = [];
const t = (name, ok, got) => { if (ok) pass++; else { fails.push(name); console.log(`FAIL ${name}${got !== undefined ? '  got ' + JSON.stringify(got) : ''}`); } };

for (const c of V.cases) {
  const r = T.verify(c.token, { ed, keys: V.keys, now: c.now * 1000, dev: c.dev });
  t(`vector: ${c.name}`, r.reason === c.reason && r.ok === (c.reason === null), r.reason);
}
const vnow = V.cases[0].now * 1000, signer0 = () => ed.signer(Uint8Array.from({ length: 32 }, (_, i) => i));
for (const c of V.serial) {
  const r = T.verify(c.token, { ed, keys: V.keys, now: vnow });
  t(`serial vector: ${c.name}`, r.ok && T.serialAllowed(r.payload, c.serial) === c.ok, [r.reason, r.payload && r.payload.ser]);
}
for (const c of V.revocations) {
  const r = T.verifyRevocations(c.doc, { ed, keys: V.keys, now: c.now * 1000, minSeq: c.min_seq });
  let good = r.reason === c.reason && r.ok === (c.reason === null) && (!r.ok || r.stale === c.stale);
  if (r.ok && c.revoked_jti) good = good && T.isRevoked(r.payload, { jti: c.revoked_jti }) && T.isRevoked(r.payload, { dev: c.revoked_dev })
    && !T.isRevoked(r.payload, { jti: 'ffffffffffffffff', dev: 'nope' });
  t(`revocation vector: ${c.name}`, good, [r.reason, r.stale]);
}
const rg = V.revocations.find(c => c.name === 'good');
t('issueRevocations = the Python list, byte for byte', T.issueRevocations(JSON.parse(Buffer.from(T.unb64u(rg.doc.slice(5).split('.')[0])).toString()), signer0()) === rg.doc);
t('revocations: junk never throws', T.verifyRevocations(undefined, { ed }).reason === 'REV_FORMAT' && T.verifyRevocations('KPV1.a.b', { ed }).reason === 'REV_FORMAT');
t('serial: no payload is not bound', T.serialAllowed(null, '1') === true);
t('test key never pinned', !('kp-test' in T.KEYS) && Object.values(T.KEYS).every(k => /^[0-9a-f]{64}$/.test(k)));
t('junk never throws', T.verify(undefined, { ed }).reason === 'TOK_FORMAT' && T.verify('a.b', { ed }).reason === 'TOK_FORMAT');
// issue() round-trips, and makes the same bytes Python does (same JSON, same signature: Ed25519 is deterministic)
const signer = ed.signer(Uint8Array.from({ length: 32 }, (_, i) => i));
const good = V.cases.find(c => c.name === 'good');
t('issue = the Python token, byte for byte', T.issue(T.peek(good.token), signer) === good.token);
t('b64u round trip', T.hex(T.unb64u(T.b64u(Uint8Array.from([0, 1, 2, 250, 251, 252, 253])))) === '000102fafbfcfd');
t('unb64u refuses non-base64url', T.unb64u('ab+/') === null && T.unb64u('a') === null);
const p = { iat: 1000, exp: 1000 + 30 * 86400 };
t('refresh not due on day 14', !T.refreshDue(p, (1000 + 14 * 86400) * 1000));
t('refresh due on day 15', T.refreshDue(p, (1000 + 15 * 86400) * 1000));

console.log(`${pass} passed, ${fails.length} failed`);
console.log(fails.length ? `RESULT: FAIL (${fails.join(', ')})` : 'RESULT: ALL PASS');
process.exit(fails.length ? 1 : 0);
