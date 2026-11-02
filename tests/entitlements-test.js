// js/entitlements.js: tiers, the CCDI classifier, the private / public builds, demo, tokens, silent logging.
// Node: node tests/entitlements-test.js (VS Code's: ELECTRON_RUN_AS_NODE=1 Code.exe tests/entitlements-test.js)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const C = require('../js/ccdi.js');
const SRC = fs.readFileSync(path.join(__dirname, '../js/entitlements.js'), 'utf8');

let pass = 0; const fails = [];
const t = (name, ok, got) => { if (ok) pass++; else { fails.push(name); console.log(`FAIL ${name}${got !== undefined ? '  got ' + JSON.stringify(got) : ''}`); } };

// a fresh KellyEnt per build / URL, with its own fake window
function load(build, search = '') {
  const win = { location: { search }, localStorage: { getItem: () => null, setItem() {} }, console: { debug() {} } };
  win.globalThis = win;
  const src = SRC.replace(/const BUILD = '[a-z]+';/, `const BUILD = '${build}';`).replace(/typeof window !== 'undefined' \? window : globalThis/, 'win');
  vm.runInNewContext(src, { win, URLSearchParams, Date, console, module: undefined });
  return win.KellyEnt;
}

const cmd = C.cmd, ccr = C.ccr;
const E = load('private');
E.setGateway(5059999);

// ---- classifier (same answer in either build: it names the feature, the build decides)
const F = w => E.ccdiFeature(w);
t('queries open', [cmd.model(), cmd.serial(), cmd.versions(), cmd.cctm('063'), cmd.gps(), cmd.getSdm()].every(w => F(w) === null));
t('local radio control open', [cmd.volume(10), cmd.goToChannel(3), cmd.talkgroup(101), cmd.txPower(2), cmd.monitor(true), cmd.key('05', 1), cmd.enterCCR()].every(w => F(w) === null));
t('PTT, release, cancel, emergency open', [cmd.tx(true), cmd.tx(false), cmd.cancel(0), cmd.emergency(0), cmd.emergency(2), cmd.ackEmergency(1234)].every(w => F(w) === null));
t('calls open', F(cmd.individualCall(31258)) === null && F(cmd.groupCall(101)) === null);
t('text to the gateway = member', F(cmd.extSend(5059999, '6869')) === 'p25.text.gw', F(cmd.extSend(5059999, '6869')));
t('text to another radio = open', F(cmd.extSend(31258, '6869')) === null);
t('chunked text: save part open, send part gated', C.externalMessage(5059999, 'x'.repeat(150)).map(F).join() === ',p25.text.gw', C.externalMessage(5059999, 'x'.repeat(150)).map(F));
t('status to the gateway = member', F(cmd.statusUpdate(5059999, 3)) === 'p25.text.gw');
t('status to another radio = open', F(cmd.statusUpdate(31258, 3)) === null);
t('a command left out of the build is refused in every build', !E.allowed('build.removed') && !load('public').allowed('build.removed') && E.tier('build.removed') === 'never');
t('emergency alarm service open', F(cmd.emergencyAlarm(5059999)) === null);
t('location send / poll = member', F(cmd.sendPosition(5059999)) === 'p25.loc' && F(cmd.pollLocation(31258)) === 'p25.loc');
t('test tone / selcall / DTMF = registered', [cmd.diagTestTone(true), cmd.diagTestToneBer(true), cmd.selcall('12345'), cmd.dtmf('1'), ccr.selcall('123')].every(w => F(w) === 'radio.testtx'));
t('diag reads open', F(cmd.diagFrequencies()) === null && F(cmd.diagSignal(1, 1, 1)) === null);
t('SEND_SDM = member', F(cmd.sendSdm(1, 'ABC')) === 'p25.text.gw');
t('transparent entry open', F(cmd.transparent('+', 'H')) === null);
t('CCR receive side open', [ccr.rxFreq(438e6), ccr.bandwidth(1), ccr.volume(100), ccr.rxCtcss(91.5), ccr.signalReport(true, 1000), ccr.p25('C', '1'), ccr.p25('K', '1'), ccr.exit()].every(w => F(w) === null));
t('CCR transmit side = registered', [ccr.txFreq(438e6), ccr.txCtcss(91.5), ccr.txDcs('023'), ccr.unitId(1234567), ccr.txNac('293'), ccr.modulation(1), ccr.p25('A', '1')].every(w => F(w) === 'ccr.tx'));
t('CCR raw TSBK / LDU1 = member', F(ccr.p25('G', 'x')) === 'p25.transparent' && F(ccr.p25('H', 'x')) === 'p25.transparent');
t('junk is open (never wedge an escape)', F('zzz') === null && F('\r') === null && F('+++') === null && F('') === null);

// ---- private build: everything allowed
t('private: member feature allowed', E.allowed('p25.gateway') && E.allowed('tait.program'));
t('private: state', E.state().member === true && E.state().build === 'private');

// ---- private build previewing public
const PV = load('private', '?ent=public');
t('?ent=public: member feature refused', !PV.allowed('p25.gateway') && PV.mode === 'public');
t('?ent=public: open feature allowed', PV.allowed('nonsense.feature'));

// ---- public build
const P = load('public');
t('public: member refused', !P.allowed('p25.gateway'));
t('public: registered refused', !P.allowed('tait.program'));
t('public: unknown open', P.allowed('some.new.thing'));
t('public: gate() returns the fallback', P.gate('p25.gateway', 0, 'wx') === 0);
t('public: check() logs a reason code, no throw', !P.check('p25.sstv', 'sstvSend') && P.log.some(e => e.reason === 'ENT_NO_TOKEN' && e.feature === 'p25.sstv' && e.where === 'sstvSend'));
t('public: dump() is text', /ENT_NO_TOKEN p25.sstv @sstvSend/.test(P.dump()));
let fired = 0; P.on('change', () => fired++);
P.setDemo(true);
t('public + demo: everything allowed', P.allowed('p25.gateway') && P.allowed('tait.program') && fired === 1);
P.setDemo(false);
t('public, demo off again: refused', !P.allowed('p25.gateway') && fired === 2);
P.setToken({ sub: 'VK9TST', feat: ['p25.gateway', 'p25.text.gw'], exp: Date.now() / 1000 + 3600, net: { gw: [5059001] } });
t('public + token: listed feature allowed', P.allowed('p25.gateway'));
t('public + token: unlisted feature refused with ENT_NO_FEATURE', !P.check('tait.program', 'x') && P.log.slice(-1)[0].reason === 'ENT_NO_FEATURE');
t('token net.gw counts as a gateway', P.isGateway(5059001));
P.setToken({ sub: 'VK9TST', feat: ['p25.gateway'], exp: Date.now() / 1000 - 10 });
t('public + expired token: refused with ENT_EXPIRED', !P.check('p25.gateway', 'y') && P.log.slice(-1)[0].reason === 'ENT_EXPIRED');
for (let i = 0; i < 300; i++) P.check('p25.sstv', 'loop');
t('log is capped', P.log.length === 200, P.log.length);

// ---- the table the bridge's radio_feature() also runs (bridge/test_kelly_gate.py)
{
  const RV = require('../bridge/radio_feature_vectors.json');
  const bad = RV.cases.filter(([id, params, want]) => E.ccdiFeature(C.frame(id, params)) !== want);
  t('radio_feature_vectors: the page classifies every case as the bridge does', bad.length === 0, bad);
}
// ---- revoked token / serial-bound token (public build)
{
  const R = load('public'), tok = { sub: 'X', feat: ['p25.gateway'], exp: Date.now() / 1000 + 99, ser: ['12345678'] };
  R.setToken(tok);
  t('serial: unknown serial is not checked yet', R.allowed('p25.gateway'));
  R.setSerial('99999999'); t('serial: another radio -> ENT_SERIAL', !R.check('p25.gateway', 'x') && R.log.slice(-1)[0].reason === 'ENT_SERIAL');
  R.setSerial(' 12345678 '); t('serial: the bound radio (case/space-insensitive) -> allowed', R.allowed('p25.gateway'));
  R.setRevoked(true); t('revoked -> ENT_REVOKED', !R.check('p25.gateway', 'y') && R.log.slice(-1)[0].reason === 'ENT_REVOKED');
  R.setRevoked(false); t('revoked cleared -> allowed again', R.allowed('p25.gateway'));
  R.setToken({ sub: 'X', feat: ['p25.gateway'], exp: Date.now() / 1000 + 99 }); R.setSerial('anything');
  t('no ser claim: any radio', R.allowed('p25.gateway'));
}
// ---- REFUSAL switch: 'silent' (members' build, and the default) vs 'message' (public build)
const loadR = (build, refusal, search = '') => {
  const win = { location: { search }, localStorage: { getItem: () => null, setItem() {} }, console: { debug() {} } };
  win.globalThis = win;
  const src = SRC.replace(/const BUILD = '[a-z]+';/, `const BUILD = '${build}';`).replace(/const REFUSAL = '[a-z]+';/, `const REFUSAL = '${refusal}';`)
    .replace(/typeof window !== 'undefined' \? window : globalThis/, 'win');
  vm.runInNewContext(src, { win, URLSearchParams, Date, console, module: undefined });
  return win.KellyEnt;
};
const TEXT = 'Available to registered P25X members. Register at kellypage.app';
t('REFUSAL: the shipped default is silent', /const REFUSAL = 'silent';/.test(SRC) && P.REFUSAL === 'silent' && E.REFUSAL === 'silent');
const PS = loadR('public', 'silent');
t('REFUSAL silent: refused() is the old "nothing to do" answer', JSON.stringify(PS.refused('p25.gateway')) === JSON.stringify({ ok: true, gated: true, code: 'ENT_NO_TOKEN' }), PS.refused('p25.gateway'));
t('REFUSAL silent: not messaging', PS.messaging === false);
const PM = loadR('public', 'message');
t('REFUSAL message: public build messaging', PM.messaging === true && PM.REFUSAL === 'message' && PM.REFUSAL_TEXT === TEXT);
t('REFUSAL message: refused() = {ok:false, gated:true, reason}', JSON.stringify(PM.refused('p25.gateway')) === JSON.stringify({ ok: false, gated: true, reason: TEXT, code: 'ENT_NO_TOKEN' }), PM.refused('p25.gateway'));
t('REFUSAL message: gates themselves unchanged', !PM.allowed('p25.gateway') && PM.allowed('nonsense.feature') && PM.gate('p25.gateway', 7, 'x') === 7);
t('REFUSAL message: refused() carries the real code', (PM.setToken({ sub: 'X', feat: [], exp: Date.now() / 1000 + 99 }), PM.refused('tait.program').code === 'ENT_NO_FEATURE'));
t('REFUSAL message + demo or full token: allowed, nothing refused', (PM.setToken({ sub: 'X', feat: ['p25.gateway'], exp: Date.now() / 1000 + 99 }), PM.allowed('p25.gateway')));
const MM = loadR('private', 'message');
t('REFUSAL message in the private build: nothing refused, mode private', MM.mode === 'private' && MM.allowed('tait.program') && MM.messaging === false);
const PQ = loadR('private', 'silent', '?ent=message');
t('?ent=message previews the public build with messages', PQ.mode === 'public' && PQ.messaging === true && !PQ.allowed('p25.gateway'));
const PQ2 = loadR('private', 'silent', '?ent=public');
t('?ent=public stays silent', PQ2.mode === 'public' && PQ2.messaging === false);

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : `RESULT: ALL PASS (${pass})`);
process.exit(fails.length ? 1 : 0);
