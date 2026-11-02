// MeshPRS intake (decision 0010): js/meshcore.js turns a companion RESP 27 (CHANNEL_DATA_RECV, layout from
// companion-v1.18.0 MyMesh.cpp onChannelDataRecv) into io.chdata, and the blob is a frame js/meshprs.js decodes.
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/meshprs-intake-test.js
'use strict';
const path = require('path');
require(path.join(__dirname, '../js/meshcore.js'));            // sets globalThis.KellyMeshCore
const M = require(path.join(__dirname, '../js/meshprs.js'));
const MC = globalThis.KellyMeshCore;
const fails = [];
const check = (name, ok, got) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  (got ${JSON.stringify(got)})`)); if (!ok) fails.push(name); };

const got = [], logs = [];
const ses = new MC.DRIVER.Session({ send: () => {}, chdata: x => got.push(x), log: t => logs.push(t), status: () => {}, node: () => {}, self: () => {},
  channels: () => {}, stat: () => {}, text: () => {}, route: () => {}, ack: () => {} });
const pos = M.unhex('50 00 2A 00 00 12 9F 5D 8E 02 F9 52 3D 35 EF D8 14 D1 6C 2F 3E 00 4D 6F 62 69 6C 65');
// [27][snr*4 = -22 -> -5.5 dB][0][0][ch 3][path_len 0x42 = 2 hops of 2-byte hashes][type 4D FF][len][blob]
const f = Uint8Array.from([27, 0xEA, 0, 0, 3, 0x42, 0x4D, 0xFF, pos.length, ...pos]);
ses.onFrame(f);
check('RESP 27 -> one io.chdata', got.length === 1, got.length);
const x = got[0] || {};
check('channel index, SNR, hops, data type', x.ch === 3 && x.snr === -5.5 && x.hops === 2 && x.type === M.DATA_TYPE, { ch: x.ch, snr: x.snr, hops: x.hops, type: x.type });
check('the blob is the frame', x.data && M.hex(x.data) === M.hex(pos));
check('...and decodes as VK4ABC\'s position', x.data && M.decode(x.data).src === 'VK4ABC');
ses.onFrame(Uint8Array.from([27, 0, 0, 0, 1, 0xFF, 0x4D, 0xFF, 5, 1, 2, 3, 4, 5]));
check('path_len 0xFF = came direct: hops null', got[1] && got[1].hops === null, got[1]);
ses.onFrame(Uint8Array.from([27, 0, 0, 0, 1, 0xFF, 0x4D, 0xFF, 9, 1, 2]));
check('a length past the frame is ignored', got.length === 2, got.length);
// ---- the driver against js/meshcoresim.js (bridge/test_kelly_mesh_sim_channels.py checks the Python sim the same way)
require(path.join(__dirname, '../js/meshcoresim.js'));
const SIM = globalThis.KellyMeshCoreSim;
const MPRS_POS = '50 00 26 00 21 4F 04 C7 8E 0E 86 7B E5 22 B5 D8 E9 A1 6C 2F 5B 00 4B 65 6C 6C 79 20 73 69 6D 20 74 72 61 63 6B 65 72';
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rig(opts = {}) {
  const sim = SIM.create(Object.assign({ auto: false }, opts)), seen = [];
  const s = new MC.DRIVER.Session({ send: async p => { sim.write(p); }, chdata: x => seen.push(x), log: () => {}, status: () => {}, node: () => {},
    self: () => {}, channels: () => {}, stat: () => {}, text: () => {}, route: () => {}, ack: () => {} });
  sim.onFrame(f => s.onFrame(f));
  return { sim, s, seen };
}
(async () => {
  const { sim, s, seen } = rig();
  sim.inject.mprs(1);
  await sleep(300);
  check('sim: no #meshprs slot -> nothing handed to Kelly', seen.length === 0, seen.length);
  await s.setChannel(3, M.CHANNEL, M.CHANNEL_KEY);
  sim.inject.mprs(1);
  await sleep(300);
  const x2 = seen[0] || {};
  check('sim: with the slot -> io.chdata on channel 3, #meshprs', seen.length === 1 && x2.ch === 3 && x2.chName === '#meshprs' && x2.type === M.DATA_TYPE, { n: seen.length, ch: x2.ch, name: x2.chName });
  const want = M.unhex(MPRS_POS); want[2] = 0x27;   // the second frame from Bravo: seq 39 (the first, 38, went before the slot)
  check('sim: Bravo\'s Position frame, byte for byte the Python sim\'s', x2.data && M.hex(x2.data) === M.hex(want), x2.data && M.hex(x2.data));
  const key = M.hex(SIM.keyOf('VK4ZB Bravo Heltec'));
  let line = null; try { line = M.check(x2.data, { igate: 'VK4XXX-10', bindings: [{ call: 'VK4ZB', key }] }); } catch (e) { line = e.reason; }
  check('sim: and it gates as VK4ZB-7', line === 'VK4ZB-7>APZKPG,qAO,VK4XXX-10:!2737.65S/15245.86E[Kelly sim tracker', line);

  await s.sendChannelData(3, M.DATA_TYPE, want);
  const sd = sim.state().sentData;
  check('send: CMD 62 flood on slot 3, the frame as given, unscoped already (no default scope)', sd.length === 1 && sd[0].ch === 3 && sd[0].pathLen === 0xFF && sd[0].type === M.DATA_TYPE && sd[0].data === M.hex(want).toLowerCase() && !sd[0].unscoped, sd);
  await s.sendChannelData(3, M.DATA_TYPE, [1, 2, 3], { flood: false });
  check('send: zero-hop = path_len 0', sim.state().sentData[1] && sim.state().sentData[1].pathLen === 0, sim.state().sentData[1]);
  let err = null; try { await s.sendChannelData(6, M.DATA_TYPE, [1]); } catch (e) { err = e.message; }
  check('send: an empty slot is refused by the node', !!err, err);
  err = null; try { await s.sendChannelData(3, M.DATA_TYPE, new Uint8Array(166)); } catch (e) { err = e.message; }
  check('send: over 165 bytes refused before it goes', /165/.test(err || ''), err);
  sim.stop();

  const r2 = rig({ scope: ['#qld', '00112233445566778899aabbccddeeff'] });
  await r2.s.setChannel(3, M.CHANNEL, M.CHANNEL_KEY);
  await r2.s.sendChannelData(3, M.DATA_TYPE, want);
  check('send: a node with a default scope -> sent unscoped, then put back', r2.sim.state().sentData[0].unscoped === true && r2.sim.state().unscoped === false, r2.sim.state());
  r2.sim.stop();

  console.log(`RESULT: ${fails.length ? 'FAIL' : 'ALL PASS'} (${fails.length} failed)`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
