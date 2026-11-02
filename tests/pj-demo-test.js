/* Kelly Page tests -- Packet Journey demo (js/pj-demo.js): every packet the pretend mesh makes is real MeshCore bytes.
 * Run (no system Node; VS Code's Electron works):
 *   ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" tests/pj-demo-test.js
 * Prints RESULT: PASS / FAIL. */
'use strict';
const path = require('path');
const D = require(path.join(__dirname, '../js/mcdecode.js'));
const PJ = require(path.join(__dirname, '../js/pj-core.js'));
const Demo = require(path.join(__dirname, '../js/pj-demo.js'));
let fails = 0; const bad = m => { fails++; if (fails < 25) console.log('FAIL', m); };

const eng = Demo._engine(D, PJ.DEMO_CHANNEL, 12345);
// node keys: distinct, 2-byte repeater hashes unique
const keys = new Set(eng.nodes.map(n => n.keyHex)); if (keys.size !== eng.nodes.length) bad('duplicate keys');
const rh = eng.nodes.filter(n => n.role === 2).map(n => n.keyHex.slice(0, 4)); if (new Set(rh).size !== rh.length) bad('repeater 2-byte hash clash');

const bus = PJ.createBus(), reg = PJ.createRegistry();
const types = {}, scen = {}, kinds = {}, hs = {}, routes = {};
let n = 0, decrypted = 0, privateEnc = 0, gps = 0, gaps = [], totalMs = 0;
for (let i = 0; i < 3000; i++) {
  const list = eng.next();
  scen[list.scenario || 'warm'] = (scen[list.scenario || 'warm'] || 0) + 1;
  for (const p of list) {
    n++; totalMs += p.dt; gaps.push(p.dt);
    if (!(p.raw instanceof Uint8Array)) { bad('raw not Uint8Array'); continue; }
    const d = D.decode(p.raw, { channels: [PJ.DEMO_CHANNEL] });
    if (!d.ok) { bad(`${p.type} not ok: ${d.err} ${D.hex(p.raw)}`); continue; }
    if (d.typeName !== p.type) bad(`intended ${p.type} decoded ${d.typeName}`);
    if (d.fields.some(f => f.start + f.len > p.raw.length)) bad('field past end ' + p.type);
    const covered = d.fields.reduce((a, f) => a + f.len, 0); if (covered !== p.raw.length) bad(`${p.type}: fields cover ${covered}/${p.raw.length}`);
    if (p.snr < -16 || p.snr > 12 || p.rssi < -125 || p.rssi > -45) bad(`snr/rssi ${p.snr}/${p.rssi}`);
    types[d.typeName] = (types[d.typeName] || 0) + 1;
    routes[d.routeName] = (routes[d.routeName] || 0) + 1;
    if (d.hashSize) hs[d.hashSize] = (hs[d.hashSize] || 0) + 1;
    if (d.typeName === 'GRP_TXT') { if (d.decrypted) { decrypted++; if (!d.info.sender || !d.info.text) bad('chat no sender/text'); } else privateEnc++; }
    const ev = PJ.ingest(bus, reg, { raw: p.raw, snr: p.snr, rssi: p.rssi, demo: true }, { channels: [PJ.DEMO_CHANNEL] });
    kinds[ev.kind] = (kinds[ev.kind] || 0) + 1;
    if (ev.gps) gps++;
    if (ev.kind === 'unknown' && ev.type !== 'RAW_CUSTOM') bad('unknown kind for ' + ev.type);
    if (ev.journey[ev.journey.length - 1] !== 'me') bad('journey does not end at me');
  }
}
const want = ['ADVERT', 'GRP_TXT', 'GRP_DATA', 'TXT_MSG', 'ACK', 'MULTIPART', 'PATH', 'TRACE', 'REQ', 'RESPONSE', 'ANON_REQ', 'CONTROL', 'RAW_CUSTOM'];
for (const t of want) if (!types[t]) bad('never made ' + t);
if (!decrypted) bad('no decrypted chat'); if (!privateEnc) bad('no private (encrypted) chat');
if (!hs[1] || !hs[2] || hs[1] > hs[2] / 5) bad('hash size mix ' + JSON.stringify(hs));
if (!routes['transport flood']) bad('no transport flood');
const named = reg.all().filter(x => x.known && x.name).length; if (named < 12) bad('only ' + named + ' named nodes');
const mean = totalMs / n; if (mean < 500 || mean > 3000) bad('mean gap ' + mean);
console.log('packets', n, 'mean gap ms', Math.round(mean), 'per type', JSON.stringify(types));
console.log('kinds', JSON.stringify(kinds), 'hash sizes', JSON.stringify(hs), 'routes', JSON.stringify(routes), 'gps adverts', gps, 'nodes known', named);
console.log('sample chat:', (() => { for (let i = 0; i < 50; i++) { const l = eng.scenarios.chat(); const d = D.decode(l[0].raw, { channels: [PJ.DEMO_CHANNEL] }); return d.summary + ' | path ' + (d.path || []).join(' ') ; } })());
console.log('RESULT:', fails ? `FAIL (${fails})` : 'PASS');
