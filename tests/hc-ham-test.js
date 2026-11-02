// Ham status (js/hc-core.js hamStatus / countsFor / hamOwners), KellyHamCalls.hamOf (js/hc-calls.js) and the award
// engine (js/award-engine.js) -- AWARDS_REVIEW.md section 3 / review/02-ham-filter.md section 6. Runs both hc-core copies.
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" kelly-page/tests/hc-ham-test.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const KELLY = path.join(__dirname, '..', 'js'), GW = path.join(__dirname, '..', '..', 'tools', 'p25x-fault-finding-page', 'hc-core.js');
let pass = 0, fail = 0;
const t = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra)); } };

const K1 = 'a'.repeat(63) + '1', K2 = 'b'.repeat(63) + '2', K3 = 'c'.repeat(63) + '3', MYKEY = 'd'.repeat(63) + '4';
const ME = { me: { call: 'VK4XXX', keys: [MYKEY], radios: ['5050002'] } };

function coreCases(HC, tag) {
  const T = (n, ok, x) => t(`[${tag}] ${n}`, ok, x);
  const S = (ev, ctx) => HC.hamStatus(ev, ctx || ME);
  // 1 dir entry: verified; mine disagrees -> scoring call = dir, why names both
  let r = S({ net: 'meshcore', key: K1, name: 'Bob', type: 1, dir: { c: 'VK4XYZ', t: 1 }, mine: 'VK4QQQ' });
  T('1 dir verified ham', r.ham && r.tier === 'verified' && r.call === 'VK4XYZ' && r.src === 'dir', r);
  T('1 why names both', /VK4XYZ/.test(r.why) && /VK4QQQ/.test(r.why), r.why);
  T('1 frozen', Object.isFrozen(r));
  // 2 name evidence
  r = S({ net: 'meshcore', key: K1, name: 'VK4XYZ Bob', type: 1 });
  T('2 VK name probable ham', r.ham && r.tier === 'probable' && r.src === 'name', r);
  r = S({ net: 'meshcore', key: K1, name: 'w1aw', type: 1 });
  T('2 lower-case w1aw not ham', !r.ham && (r.tier === 'unverified' || r.tier === 'none'), r);
  r = S({ net: 'meshcore', key: K1, name: 'W1AW', type: 1 });
  T('2 W1AW from a name unverified', !r.ham && r.tier === 'unverified', r);
  // 3 model names
  for (const n of ['UV5R base', 'T1000-E', 'Heltec V3', 'RAK4631', 'T1KE']) { r = S({ net: 'meshcore', key: K1, name: n, type: 1 }); T(`3 no call in "${n}"`, r.call === null && !r.ham, r); }
  // 4 repeater / room / sensor with a dir entry
  for (const ty of [2, 3, 4]) { r = S({ net: 'meshcore', key: K1, name: 'VK4ZB Rpt', type: ty, dir: { c: 'VK4ZB', t: ty } }); T(`4 type ${ty} infra, owner kept`, r.cls === 'infra' && !r.ham && r.owner === 'VK4ZB', r); }
  // 5 type disagreement: the restrictive one wins
  r = S({ net: 'meshcore', key: K1, name: 'x', type: 1, dir: { c: 'VK4ZB', t: 2 } });
  T('5 advert 1 + dir 2 -> infra', r.cls === 'infra' && !r.ham, r);
  r = S({ net: 'meshcore', key: K1, name: 'x', type: 0, dir: { c: 'VK4ZB', t: 1 } });
  T('5 advert 0 + dir 1 -> station', r.cls === 'station' && r.ham, r);
  // 6 keyless channel sender
  r = S({ net: 'meshcore', name: 'VK4XYZ', keyless: true, mine: 'VK4XYZ' });
  T('6 keyless unverified, not ham', r.tier === 'unverified' && !r.ham, r);
  // 7 mine only
  r = S({ net: 'meshcore', key: K1, name: 'Bob', type: 1, mine: 'VK4XYZ' });
  T('7 mine probable', r.tier === 'probable' && r.src === 'mine' && r.ham, r);
  T('7 local yes, club no', HC.countsFor(r, 'local') && !HC.countsFor(r, 'club') && HC.countsFor(r, 'visual'));
  // 8 two keys, one call -> one owner
  const a = S({ net: 'meshcore', key: K1, name: 'a', type: 1, dir: { c: 'VK4XYZ', t: 1 } }), b = S({ net: 'meshcore', key: K2, name: 'b', type: 1, dir: { c: 'VK4XYZ', t: 1 } });
  T('8 one owner', HC.hamOwners([a, b], 'club').size === 1 && HC.hamOwners([a, b], 'local').has('VK4XYZ'));
  // 9 self
  const selfs = [S({ net: 'meshcore', key: MYKEY, name: 'n', type: 1 }), S({ net: 'p25', radio: '1050002', radioCall: 'VK4XXX' }), S({ net: 'meshcore', key: K3, name: 'n', type: 1, dir: { c: 'VK4XXX', t: 1 } }),
    S({ net: 'meshcore', key: K3, name: 'VK4XXX Rpt2', type: 1 }), S({ net: 'p25', radio: '3050002' })];
  selfs.forEach((x, i) => T(`9 self #${i}`, x.self && !HC.countsFor(x, 'local') && !HC.countsFor(x, 'club') && HC.countsFor(x, 'visual'), x));
  T('9 radioBase alias rule', HC.radioBase('1050002') === '5050002' && HC.radioBase(5059999) === '5059999' && HC.radioBase('3150123') === '3150123' && HC.radioBase('2050002', { '2050002': '5051111' }) === '5051111');
  // 10 P25
  T('10 5059999 gateway', S({ net: 'p25', radio: '5059999', radioCall: 'VK4RBX' }).cls === 'gateway');
  T('10 0000001 infra', S({ net: 'p25', radio: '1' }).cls === 'infra');
  r = S({ net: 'p25', radio: '1051111', radioCall: 'VK4ZQ' }, {});
  T('10 alias verified, owner = base call', r.tier === 'verified' && r.owner === 'VK4ZQ' && r.ham, r);
  T('10 unknown ID unverified', S({ net: 'p25', radio: '5050001' }, {}).tier === 'unverified');
  // 11 Meshtastic
  T('11 role 4 licensed -> infra', S({ net: 'meshtastic', name: 'VK4XYZ hill', role: 4, licensed: true }).cls === 'infra');
  r = S({ net: 'meshtastic', name: 'VK4XYZ mobile', role: 0, licensed: true });
  T('11 role 0 licensed + call -> probable', r.tier === 'probable' && r.ham && r.src === 'meshtastic', r);
  T('11 role 5 tracker -> station', S({ net: 'meshtastic', name: 'VK4XYZ', role: 5 }).cls === 'station');
  T('11 meshtastic never club', !HC.countsFor(r, 'club'));
  // 12 APRS
  r = S({ net: 'aprs', aprsCall: 'VK4XYZ-9', aprsSym: '/>' });
  T('12 APRS owner base call probable', r.owner === 'VK4XYZ' && r.tier === 'probable' && r.ham && !HC.countsFor(r, 'club'), r);
  T('12 digi symbol infra', S({ net: 'aprs', aprsCall: 'VK4RDI-1', aprsSym: '/#' }).cls === 'infra');
  T('12 viaInternet gateway', S({ net: 'aprs', aprsCall: 'VK4XYZ-9', viaInternet: true }).cls === 'gateway');
  // 13 demo
  r = S({ net: 'meshcore', key: K1, name: 'VK4XYZ', type: 1, demo: true });
  T('13 demo: local only on the demo profile, club never', !HC.countsFor(r, 'local') && HC.countsFor(r, 'local', { demoProfile: true }) && !HC.countsFor(r, 'club'));
  // 14 never throws
  T('14 null / {} never throw', HC.hamStatus(null).ham === false && HC.hamStatus({}).ham === false && HC.hamStatus(undefined, null).tier === 'none');
  T('14 NOT_HAM', HC.NOT_HAM.ham === false && HC.NOT_HAM.tier === 'none');
  // repeater / club-format calls (decision 6), otherCalls, sticky names
  T('R VK4RES on a companion -> infra', S({ net: 'meshcore', key: K1, name: 'VK4RES', type: 1 }).cls === 'infra');
  T('R VK4RBX club call -> infra', S({ net: 'p25', radio: '5050123', radioCall: 'VK4RBX' }).cls === 'infra');
  T('R VK4ZR (a person) stays a station', S({ net: 'meshcore', key: K1, name: 'VK4ZR Romeo', type: 1 }).ham);
  T('R ctx.clubCalls', S({ net: 'meshcore', key: K1, name: 'VK4WIA', type: 1 }, { clubCalls: ['VK4WIA'] }).cls === 'infra');
  T('O otherCalls fold', S({ net: 'meshcore', key: K1, name: 'VK4ZZZ', type: 1 }, { otherCalls: { VK4ZZZ: 'VK4XYZ' } }).owner === 'VK4XYZ');
  T('O second licence of mine is self', S({ net: 'meshcore', key: K1, name: 'VK4ZZZ', type: 1 }, { me: { call: 'VK4XYZ' }, otherCalls: { VK4ZZZ: 'VK4XYZ' } }).self);
  T('S renamed key unverified', S({ net: 'meshcore', key: K1, name: 'VK4AAB', type: 1, firstCall: 'VK4AAA' }).tier === 'unverified');
  T('S call taken by another key unverified', S({ net: 'meshcore', key: K2, name: 'VK4AAA', type: 1, firstKey: K1 }).tier === 'unverified');
  T('S dir beats a rename', S({ net: 'meshcore', key: K1, name: 'VK4AAB', type: 1, firstCall: 'VK4AAA', dir: { c: 'VK4AAB', t: 1 } }).tier === 'verified');
  T('G bot name gateway', S({ net: 'meshcore', key: K1, name: 'VK4XYZ bot', type: 1 }).cls === 'gateway');
  T('G infraKeys gateway', S({ net: 'meshcore', key: K1, name: 'VK4XYZ', type: 1 }, { infraKeys: new Set([K1]) }).cls === 'gateway');
}

// 17 byte identity, then the cases on both copies
const kellyCore = path.join(KELLY, 'hc-core.js');
t('17 hc-core.js byte-identical to the gateway copy', fs.existsSync(GW) && fs.readFileSync(GW).equals(fs.readFileSync(kellyCore)));
const HC = require(kellyCore);
coreCases(HC, 'kelly');
if (fs.existsSync(GW)) { delete require.cache[require.resolve(GW)]; coreCases(require(GW), 'gateway'); }

// 14 + 15: KellyHamCalls.hamOf in a fake window
function loadCalls(withHC) {
  const ls = new Map();
  const win = { localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) }, console };
  win.window = win;
  if (withHC) win.KellyHC = HC;
  const ctx = vm.createContext(Object.assign(win, { setTimeout, clearTimeout, URLSearchParams, TextEncoder, TextDecoder }));
  vm.runInContext(fs.readFileSync(path.join(KELLY, 'hc-calls.js'), 'utf8'), ctx);
  return win;
}
let w = loadCalls(false);
t('14 hamOf without hc-core -> not ham', w.KellyHamCalls.hamOf({ key: K1, longName: 'VK4XYZ', type: 1 }).ham === false);
w = loadCalls(true);
const reg = w.KellyHamCalls, bus = HC.createBus();
reg.init({ store: { get: (k, d) => d, set: () => {} }, bus });
reg.hooks({ me: () => ({ call: 'VK4XXX', keys: [MYKEY], radios: [] }) });
let h = reg.hamOf({ key: K1, longName: 'Bob', type: 1 });
t('15 no call yet', !h.ham && h.tier === 'none', h);
reg.set(K1, 'VK4XYZ', 'Bob');
h = reg.hamOf({ key: K1, longName: 'Bob', type: 1 });
t('15 set() changes the next hamOf', h.ham && h.src === 'mine' && h.call === 'VK4XYZ', h);
bus.emit('demo', true);
reg.fromDir([{ k: K2, c: 'VK4DEM', n: 'Demo', t: 1, at: 1.8e9, x: 0 }]);
t('15 demo dir entry used while on', reg.hamOf({ key: K2, longName: 'Demo', type: 1 }).tier === 'verified');
t('15 demo results tagged demo', reg.hamOf({ key: K2, longName: 'Demo', type: 1 }).demo === true);
bus.emit('demo', false);
t('15 demo off drops demo dir entries', reg.hamOf({ key: K2, longName: 'Demo', type: 1 }).tier === 'none');
t('15 my own key is self', reg.hamOf({ key: MYKEY, longName: 'Kelly', type: 1 }).self);
t('15 P25 via the radioCall hook', (reg.hooks({ radioCall: id => (id === '5051111' ? 'VK4ZQ' : null) }), reg.hamOf({ radio: '5051111' }).owner === 'VK4ZQ'));
h = reg.hamOf({ key: K3, longName: 'VK4AAA', type: 1 });
const h2 = reg.hamOf({ key: K3, longName: 'VK4AAB', type: 1 });
t('15 sticky: first name call probable, rename unverified', h.tier === 'probable' && h2.tier === 'unverified', [h, h2]);
t('15 sticky: another key taking VK4AAA unverified', reg.hamOf({ key: 'e'.repeat(64), longName: 'VK4AAA', type: 1 }).tier === 'unverified');

// the award engine
global.KellyHC = HC;
const AW = require(path.join(KELLY, 'award-engine.js'));
let clock = Date.UTC(2026, 9, 24, 1, 0, 0);
const prof = {};
const eng = AW.create({ P: () => prof, hamOf: x => HC.hamStatus(x, ME), now: () => clock });
const ham = (key, call, extra) => Object.assign({ net: 'meshcore', key, name: `${call} node`, type: 1 }, extra || {});
let c = eng.count('shake', ham(K1, 'VK4XYZ'), 'ack');
t('E first handshake scores', c.counts && c.first && c.score && c.owner === 'VK4XYZ', c);
c = eng.count('shake', ham(K1, 'VK4XYZ'), 'ack');
t('E same ham same day: counts, no score', c.counts && !c.first && !c.score, c);
c = eng.count('shake', ham(K2, 'VK4XYZ', { dir: { c: 'VK4XYZ', t: 1 }, name: 'x' }));
t('E second node of the same owner: not first', c.counts && !c.first && !c.score, c);
t('E self never counts', !eng.count('shake', ham(MYKEY, 'VK4QQ')).counts);
t('E repeater never counts', !eng.count('shake', ham(K3, 'VK4QWE', { type: 2 })).counts);
t('E trace anyStation counts a repeater', eng.count('trace', ham(K3, 'VK4QWE', { type: 2 })).score);
t('E trace again today: no score', !eng.count('trace', ham(K3, 'VK4QWE', { type: 2 })).score);
// 3 new probable owners a day (VK4XYZ was the first)
const r2 = eng.count('shake', ham('1'.repeat(64), 'VK4AAA')), r3 = eng.count('shake', ham('2'.repeat(64), 'VK4AAB')), r4 = eng.count('shake', ham('3'.repeat(64), 'VK4AAC'));
t('E new probable owners: 3 a day', r2.counts && r3.counts && !r4.counts && /tomorrow/.test(r4.why), [r2, r3, r4]);
t('E verified owners are not capped', eng.count('shake', ham('4'.repeat(64), 'VK4VER', { dir: { c: 'VK4VER', t: 1 } })).counts);
for (let i = 0; i < 12; i++) eng.count('shake', ham(String(i % 10).repeat(63) + 'f', `VK4D${'ABCDEFGHIJKL'[i]}`, { dir: { c: `VK4D${'ABCDEFGHIJKL'[i]}`, t: 1 } }));
t('E handshake daily cap 10', prof.aw.today.n.shake === 10, prof.aw.today.n);
const late = eng.count('shake', ham('9'.repeat(64), 'VK4LAT', { dir: { c: 'VK4LAT', t: 1 } }));
t('E past the cap: counts + first, no score', late.counts && late.first && !late.score, late);
clock += 86400000;
const nd = eng.count('shake', ham(K1, 'VK4XYZ'));
t('E next day: the same ham scores again', nd.score && !nd.first, nd);
t('E new day: VK4AAC counts now', eng.count('shake', ham('3'.repeat(64), 'VK4AAC')).counts);
t('E plain cap', (() => { let n = 0; for (let i = 0; i < 25; i++) if (eng.cap('rx')) n++; return n === 20; })());
// self set
eng.connected(K1);
t('E connected -> self', eng.isSelf(K1) && !eng.count('shake', ham(K1, 'VK4XYZ')).counts);
clock += 1000; eng.notMine(K1);
t('E not mine -> out', !eng.isSelf(K1));
clock += 1000; eng.connected(K1);
t('E connected again -> back in', eng.isSelf(K1));
clock += 91 * 86400000;
t('E self key expires after 90 days', !eng.isSelf(K1));
eng.addSelf(() => [K2.toUpperCase()]);
t('E extra self keys (admin repeaters)', eng.isSelf(K2));
t('K direct capped at 40', AW.kmCap(90, 0) === 40 && AW.kmCap(12, 0) === 12 && AW.kmCap(150, 2) === 120 && AW.kmCap(150, 3, 50) === 130);
clock += 1000;
t('K first distance', eng.creditKm(K3, 30, 0) === 30);
t('K grew: held for a day', eng.creditKm(K3, 38, 0) === 30);
t('K shrank: at once', eng.creditKm(K3, 20, 0) === 20);
clock += 86400000 + 1;
t('K grew a day later: taken', eng.creditKm(K3, 38, 0) === 38);
t('E demo() false in Node', AW.demo() === false);
const off = AW.addDemo(() => true); t('E demo provider', AW.demo() === true); off(); t('E demo provider off', AW.demo() === false);
t('E hamOf throwing -> nothing scores', !AW.create({ P: () => ({}), hamOf: () => { throw new Error('x'); } }).count('shake', { key: K1 }).counts);

console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
