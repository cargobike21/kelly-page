// The shared QR / meshcore:// link module (js/meshqr.js): the pure part, in Node. Vectors from review/qr-04-shared-module.md §6.
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" kelly-page/tests/meshqr-test.js
'use strict';
const Q = require('../js/meshqr.js');
let pass = 0, fail = 0;
const t = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}`, extra === undefined ? '' : extra); } };
const code = fn => { try { fn(); return 'OK'; } catch (e) { return e.code || `plain: ${e.message}`; } };
const K = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', S = '8b3387e9c5cdea6ac9e5edbaa115cd72';
const C = (q, accept) => Q.parse(`meshcore://contact/add?${q}`, accept ? { accept } : undefined);

// 1-4: each type round-trips
for (const ty of [1, 2, 3, 4]) {
  const b = Q.buildContact({ name: 'VK4XXX Home', key: K, type: ty });
  t(`build type ${ty}`, b.link === `meshcore://contact/add?name=VK4XXX+Home&public_key=${K}&type=${ty}`, b.link);
  const p = Q.parse(b.link);
  t(`parse type ${ty}`, p.kind === 'contact' && p.key === K && p.type === ty && p.name === 'VK4XXX Home' && p.verified === false);
}
// 5: the official Public channel example
const pub = Q.parse(`meshcore://channel/add?name=Public&secret=${S}`, { accept: ['channel'] });
t('public channel', pub.kind === 'channel' && pub.name === 'Public' && pub.secret === S && pub.wellKnown && pub.link === `meshcore://channel/add?name=Public&secret=${S}`, pub);
// 6: region_scope
const rs = Q.parse(`meshcore://channel/add?name=VK4%20Net&secret=${S}&region_scope=%23au-qld`, { accept: ['channel'] });
t('region scope', rs.regionScope === '#au-qld' && rs.warnings.some(w => w.code === 'scope-needs-app-1.47') && Q.buildChannel({ name: 'VK4 Net', secret: S, regionScope: '#au-qld' }).link === rs.link, rs.link);
// 7: upper-case hex
t('upper-case key', C(`name=x&public_key=${K.toUpperCase()}&type=1`).key === K);
t('upper-case secret', Q.parse(`meshcore://channel/add?name=x&secret=${S.toUpperCase()}`, { accept: ['channel'] }).secret === S);
// 8: upper-case scheme, path, params
t('upper-case everything', Q.parse(`MESHCORE://Contact/Add?NAME=x&PUBLIC_KEY=${K}&TYPE=3`).type === 3);
// 9 / 10: + and %20
t('+ and %20', C(`name=Kelly+VK4XXX&public_key=${K}`).name === 'Kelly VK4XXX' && C(`name=Kelly%20VK4XXX&public_key=${K}`).name === 'Kelly VK4XXX');
t('a + in a name', Q.buildContact({ name: 'A+B', key: K }).link.includes('name=A%2BB') && Q.parse(Q.buildContact({ name: 'A+B', key: K }).link).name === 'A+B');
// 11: callsigns
for (const n of ['VK4XXX/P', 'VK4XXX-1']) { const l = Q.buildContact({ name: n, key: K, type: 1 }).link; t(`callsign ${n}`, Q.parse(l).name === n, l); }
t('unencoded / parses', C(`name=VK4XXX/P&public_key=${K}&type=1`).name === 'VK4XXX/P');
// 12: emoji
for (const n of ['Kelly 📻 VK4XXX', '🇦🇺 VK4XXX']) t(`emoji ${n}`, Q.parse(Q.contactLink({ name: n, key: K, type: 1 })).name === n);
// 13 / 14: & and =
for (const n of ['Tom & Jerry', 'a=b']) t(`round trip ${n}`, Q.parse(Q.contactLink({ name: n, key: K, type: 1 })).name === n);
const raw = C(`name=Tom&Jerry&public_key=${K}&type=1`);
t('raw & in a name', raw.name === 'Tom' && raw.ignored.includes('jerry'), raw);
// 15: names over 31 bytes
const long = C(`name=${'A'.repeat(32)}&public_key=${K}`);
t('32 ASCII -> 31', long.name === 'A'.repeat(31) && long.warnings.some(w => w.code === 'name-truncated'));
t('16 x é -> 15', C(`name=${encodeURIComponent('é'.repeat(16))}&public_key=${K}`).name === 'é'.repeat(15));
t('flag not split', C(`name=${encodeURIComponent('x'.repeat(30) + '🇦🇺')}&public_key=${K}`).name === 'x'.repeat(30));
t('fitName', Q.fitName('é'.repeat(16)).cut && new TextEncoder().encode(Q.fitName('é'.repeat(16)).name).length === 30);
// 16 / 17: keys
for (const k of [K.slice(1), K + 'a', K.slice(0, 63) + 'g', 'z'.repeat(64)]) t(`bad key ${k.length}`, code(() => C(`name=x&public_key=${k}&type=1`)) === 'BAD_KEY');
t('zero key', code(() => C(`name=x&public_key=${'0'.repeat(64)}&type=1`)) === 'ZERO_KEY');
t('no key', code(() => C('name=x&type=1')) === 'BAD_KEY');
// 18: secrets
for (const s of [S.slice(1), S + 'a', 'z'.repeat(32)]) t(`bad secret ${s.length}`, code(() => Q.parse(`meshcore://channel/add?name=x&secret=${s}`, { accept: ['channel'] })) === 'BAD_SECRET');
t('zero secret warns', Q.parse(`meshcore://channel/add?name=x&secret=${'0'.repeat(32)}`, { accept: ['channel'] }).warnings.some(w => w.code === 'zero-secret'));
// 19: types
for (const ty of ['0', '5', 'abc', '2.0', '-1', '0x2']) t(`bad type ${ty}`, code(() => C(`name=x&public_key=${K}&type=${ty}`)) === 'BAD_TYPE');
t('missing type', (p => p.type === 1 && p.warnings.some(w => w.code === 'type-assumed'))(C(`name=x&public_key=${K}`)));
t('empty type', C(`name=x&public_key=${K}&type=`).type === 1);
t('spaced type', C(`name=x&public_key=${K}&type=%202%20`).type === 2);
// 20: duplicate params
t('same dup ok', C(`name=x&public_key=${K}&type=2&type=2`).type === 2);
t('differing dup refused', code(() => C(`name=x&public_key=${K}&type=2&type=3`)) === 'DUP_PARAM');
t('two keys refused', code(() => C(`name=x&public_key=${K}&public_key=${'b'.repeat(64)}`)) === 'DUP_PARAM');
// 21: unknown params
t('unknown params', (p => ['lat', 'foo', 'v'].every(x => p.ignored.includes(x)))(C(`name=x&public_key=${K}&type=1&lat=-27.5&foo=bar&v=2`)));
// 22: private keys
t('private_key param', code(() => C(`name=x&public_key=${K}&type=1&private_key=${'c'.repeat(128)}`)) === 'PRIVATE_KEY');
t('prv param', code(() => C(`name=x&public_key=${K}&prv=1`)) === 'PRIVATE_KEY');
t('bare 128 hex', code(() => Q.parse('d'.repeat(128))) === 'PRIVATE_KEY');
t('meshcore://<128 hex>', code(() => Q.parse(`meshcore://${'d'.repeat(128)}`)) === 'PRIVATE_KEY');
// 23: surrounding text
const L = Q.contactLink({ name: 'VK4XXX', key: K, type: 1 });
t('in angle brackets + sentence', Q.parse(`Here's mine: <${L}>. 73 de VK4XXX`).key === K);
t('markdown', Q.parse(`[me](${L})`).key === K);
t('trailing ).', Q.parse(`(${L}).`).type === 1);
t('two links -> warning', (p => p.more.length === 1 && p.warnings.some(w => w.code === 'links-ignored'))(Q.parse(`${L}\n${Q.contactLink({ name: 'B', key: 'b'.repeat(64), type: 1 })}`)));
t('&amp;', Q.parse(L.replace(/&/g, '&amp;')).key === K);
t('unencoded space in a name', C(`name=Foo Bar&public_key=${K}&type=2`).name === 'Foo Bar');
t('trailing slash', Q.parse(`meshcore://contact/add/?name=x&public_key=${K}`).key === K);
// 24 / 25: adverts (shape only here; hc-service-test checks signatures)
const A = 'ab'.repeat(130);
t('advert', (p => p.kind === 'advert' && p.hex === A && !p.verified)(Q.parse(`meshcore://${A}`)));
t('advert wrapped over lines', Q.parse(`card: meshcore://${A.slice(0, 80)}\n${A.slice(80, 160)}\n${A.slice(160)}\n73`).hex === A);
t('bare advert hex', Q.parse(A.match(/.{1,60}/g).join('\n')).kind === 'advert');
t('quoted-printable', Q.parse(`meshcore://${A.slice(0, 70)}=\n${A.slice(70)}`).hex === A);
t('advert 99 B', code(() => Q.parse(`meshcore://${'ab'.repeat(99)}`)) === 'BAD_HEX');
t('advert odd', code(() => Q.parse(`meshcore://${'a'.repeat(201)}`)) === 'BAD_HEX');
t('advert 176 B', code(() => Q.parse(`meshcore://${'ab'.repeat(176)}`)) === 'BAD_HEX');
t('signed beats unsigned', Q.parse(`${L}\nmeshcore://${A}`).kind === 'advert');
// 26 / 27: other networks / Kelly
t('meshtastic /e/', code(() => Q.parse('https://meshtastic.org/e/#CgMSAQE')) === 'WRONG_NETWORK');
t('meshtastic /v/', code(() => Q.parse('https://meshtastic.org/v/#Cg')) === 'WRONG_NETWORK');
t('meshtastic accepted', Q.parse('https://meshtastic.org/e/#CgMSAQE', { accept: ['meshtastic'] }).kind === 'meshtastic');
const KU = 'https://192.168.1.20:8443/?token=abc&mesh=meshcore#mesh';
t('kelly connect named, token not echoed', (() => { try { Q.parse(KU); return false; } catch (e) { return e.code === 'WRONG_KIND' && /Kelly connect/.test(e.message) && !/abc/.test(e.message); } })());
t('kelly accepted as kelly', Q.parse(KU, { accept: ['kelly'] }).kind === 'kelly');
t('community refused', code(() => Q.parse('{"type":"meshcore_community","v":1,"name":"x","k":"AAAA"}')) === 'WRONG_KIND');
t('web refused', code(() => Q.parse('https://example.com/')) === 'WRONG_KIND');
// 28 / 29 / 30 / 31: empty, long, names
for (const e of ['', '   ', null, '﻿​']) t(`empty ${JSON.stringify(e)}`, code(() => Q.parse(e)) === 'EMPTY');
t('too long', code(() => Q.parse('x'.repeat(4097))) === 'TOO_LONG');
t('channel without a name', code(() => Q.parse(`meshcore://channel/add?secret=${S}`, { accept: ['channel'] })) === 'NO_NAME');
t('contact without a name is allowed', C(`public_key=${K}&type=1`).name === '');
t('control chars', code(() => C(`name=Bad%0Aname&public_key=${K}`)) === 'BAD_NAME' && code(() => C(`name=a%07&public_key=${K}`)) === 'BAD_NAME');
// 32 / 33: wrong kind / unknown path
t('channel in a contact importer', (() => { try { Q.parse(`meshcore://channel/add?name=x&secret=${S}`); return false; } catch (e) { return e.code === 'WRONG_KIND' && /not a contact/.test(e.message) && !e.message.includes(S); } })());
t('contact in a channel importer', code(() => Q.parse(L, { accept: ['channel'] })) === 'WRONG_KIND');
t('unknown meshcore path', code(() => Q.parse('meshcore://foo/add?x=1')) === 'NOT_MESHCORE');
t('junk', code(() => Q.parse('hello there')) === 'NOT_MESHCORE');
// 34: idempotent
for (const l of [L, Q.contactLink({ name: 'Kelly 🐕 Öst & co', key: K, type: 3 })]) t('contact idempotent', Q.parse(Q.parse(l).link).link === l);
t('channel idempotent', Q.parse(rs.link, { accept: ['channel'] }).link === rs.link);
// 35: type tables agree with hc-core
const HC = require('../js/hc-core.js');
t('TYPES vs HC.TYPE_NAME', [1, 2, 3, 4].every(i => Q.TYPES[i] === HC.TYPE_NAME[i]));
// hashtag channels
const ht = Q.hashtagSecret('#test');
t('hashtag secret', /^[0-9a-f]{32}$/.test(ht || '') && Q.parse(`meshcore://channel/add?name=%23test&secret=${ht}`, { accept: ['channel'] }).hashtag === true);
t('not a hashtag', Q.parse(`meshcore://channel/add?name=%23test&secret=${S}`, { accept: ['channel'] }).hashtag === false);
// helpers
t('fingerprint', Q.fingerprint(K) === 'a1b2c3d4…5c6d7e8f90'.replace('…5c6d7e8f90', '…6d7e8f90'));
t('classify', Q.classify(L) === 'contact' && Q.classify(KU) === 'kelly' && Q.classify('nope') === null && Q.classify(`x meshcore://${A}`) === 'advert');
t('buildContact refuses a bad key', code(() => Q.buildContact({ key: 'abc' })) === 'BAD_KEY');
t('buildContact type 0 -> 1', Q.buildContact({ key: K, type: 0, name: 'x' }).type === 1);
// hc-core uses it
const card = HC.parseCard(`see ${L} thanks`, {});
t('HC.parseCard via meshqr', card.kind === 'contact' && card.key === K && card.call === 'VK4XXX' && card.qr === L);
// a name only an unsigned QR gave never makes a ham (QR_REVIEW.md S2)
const hs = x => HC.hamStatus(Object.assign({ net: 'meshcore', key: K, name: 'VK4XXX Home', type: 1 }, x), { me: {} });
t('QR-claimed name is unverified', hs({ nameFrom: 'qr' }).tier === 'unverified' && hs({ nameFrom: 'qr' }).ham === false, hs({ nameFrom: 'qr' }));
t('the same name from an advert is probable', hs({}).tier === 'probable');
t('the directory still wins over a QR claim', hs({ nameFrom: 'qr', dir: { c: 'VK4XXX', t: 1 } }).tier === 'verified');
t('HC.qrLink = contactLink', HC.qrLink({ key: K, type: 2, name: 'x' }) === Q.contactLink({ key: K, type: 2, name: 'x' }));
// APRS share card (iGate, 2026-10-31): contact link + aprs/sym/cmt
const sh = Q.buildShare({ name: 'VK4XXX Buddy', key: K, type: 4, c: 'VK4XXX', s: 12, y: '/b', m: 'Mesh Buddy' });
t('buildShare = the contact link + aprs/sym/cmt', sh.link.startsWith(Q.contactLink({ name: 'VK4XXX Buddy', key: K, type: 4 }) + '&aprs=VK4XXX-12&sym=%2Fb&cmt=Mesh+Buddy'), sh.link);
const shp = Q.parse(`Add my tracker: ${sh.link}`);
t('a share card parses back', shp.kind === 'contact' && shp.key === K && JSON.stringify(shp.aprs) === JSON.stringify({ c: 'VK4XXX', s: 12, y: '/b', m: 'Mesh Buddy' }) && !shp.ignored.length, shp);
t('a share card\'s link keeps its aprs params', shp.link === sh.link);
t('a plain contact has no aprs', Q.parse(L).aprs === undefined);
t('a bad aprs callsign is dropped, the contact still adds', C(`name=x&public_key=${K}&aprs=N0CALL-0`).aprs === undefined && C(`name=x&public_key=${K}&aprs=N0CALL-0`).key === K);
t('SSID 16 is refused', C(`name=x&public_key=${K}&aprs=VK4XXX-16`).aprs === undefined);
t('a bad symbol falls back to car', C(`name=x&public_key=${K}&aprs=VK4XXX-9&sym=xx`).aprs.y === '/>');
t('buildShare refuses a non-callsign', code(() => Q.buildShare({ name: 'x', key: K, type: 1, c: 'MESH', s: 1 })) === 'BAD_NAME');

console.log(`${pass} passed, ${fail} failed`);
console.log(fail ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
process.exitCode = fail ? 1 : 0;
