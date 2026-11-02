// Meshtastic codec self-test (js/meshtastic.js). No Node on the author's PC -- run it where there is one:
//   node kelly-page/tests/meshtastic-test.js [path/to/meshtastic.js]   (the NUC copy: /home/robert/p25x-fault-finding-page/meshtastic.js)
const M = require(process.argv[2] || require('path').join(__dirname, '../js/meshtastic.js'));
const assert = require('assert');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
// round trip FromRadio with nested NodeInfo
const fr = { nodeInfo: { num: 0xdeadbeef, user: { id: '!deadbeef', longName: 'VK4XXX Kelly 🐕', shortName: 'KLY', hwModel: 43, isLicensed: true, role: 2 },
  position: { latitudeI: -276105000, longitudeI: 1527583000, altitude: -12 }, snr: 6.25, lastHeard: 1791886000, hopsAway: 2,
  deviceMetrics: { batteryLevel: 101, voltage: 4.1, channelUtilization: 12.5 } } };
const b = M.encode('FromRadio', fr), d = M.fromRadio(b);
ok(d.nodeInfo.num === 0xdeadbeef, 'num'); ok(d.nodeInfo.user.longName === 'VK4XXX Kelly 🐕', 'utf8 name'); ok(d.nodeInfo.user.isLicensed === true, 'bool');
ok(d.nodeInfo.position.latitudeI === -276105000, 'sfixed32 neg'); ok(d.nodeInfo.position.altitude === -12, 'int32 neg');
ok(Math.abs(d.nodeInfo.snr - 6.25) < 1e-6, 'float'); ok(d.nodeInfo.hopsAway === 2, 'uint32'); ok(d.nodeInfo.deviceMetrics.batteryLevel === 101, 'nested');
// packed repeated + negative int32 in RouteDiscovery
const rd = M.decode('RouteDiscovery', M.encode('RouteDiscovery', { route: [0x77d0e104, 0x3a7f1c02], snrTowards: [-20, 32, -1], routeBack: [0x3a7f1c02] }));
ok(rd.route.length === 2 && rd.route[0] === 0x77d0e104, 'packed fixed32'); ok(rd.snrTowards.join() === '-20,32,-1', 'packed int32 neg ' + rd.snrTowards);
// text packet builder -> ToRadio -> decode
const t = M.textPacket({ to: M.BROADCAST, channel: 1, text: 'CQ mesh de VK4XXX' });
const tr = M.decode('ToRadio', t.bytes);
ok(tr.packet.to === M.BROADCAST && tr.packet.channel === 1 && tr.packet.id === t.id, 'packet header');
ok(M.decodePayload(tr.packet.decoded.portnum, tr.packet.decoded.payload).text === 'CQ mesh de VK4XXX', 'text payload');
// position builder
const pp = M.decode('ToRadio', M.positionPacket({ lat: -27.4698, lon: 153.0251, alt: 30 }).bytes);
const pos = M.decodePayload(3, pp.packet.decoded.payload); ok(Math.abs(pos.lat + 27.4698) < 1e-6 && Math.abs(pos.lon - 153.0251) < 1e-6, 'position');
// framer: junk, a frame, a bogus START with huge len, debug text, a frame split across pushes
const frames = [], logs = [];
const f = new M.Framer((x) => frames.push(M.fromRadio(x)), (l) => logs.push(l));
const a = M.frame(M.encode('FromRadio', { configCompleteId: 42 })), c = M.frame(M.encode('FromRadio', { myInfo: { myNodeNum: 1234 } }));
const junk = Buffer.from('INFO | ??:??:?? 3 [Main] Booting\n');
f.push(Buffer.concat([junk, a, Buffer.from([0x94, 0xc3, 0xff, 0xff]), Buffer.from('DEBUG mid\n'), c.subarray(0, 3)])); f.push(c.subarray(3));
ok(frames.length === 2 && frames[0].configCompleteId === 42 && frames[1].myInfo.myNodeNum === 1234, 'framer ' + JSON.stringify(frames));
ok(logs.some((l) => l.includes('Booting')) && logs.some((l) => l.includes('DEBUG mid')), 'framer logs ' + JSON.stringify(logs));
// MQTT key expansion and channel hash for LongFast + default key (well known: 8)
ok(M.channelHash('LongFast', M.DEFAULT_KEY) === 8, 'LongFast hash ' + M.channelHash('LongFast', M.DEFAULT_KEY));
ok(M.expandPsk(Uint8Array.of(1))[15] === 0x01 && M.expandPsk(Uint8Array.of(2))[15] === 0x02, 'psk expand');
ok(M.hwName(43) === 'Heltec V3' && M.hwName(71) === 'SenseCAP T1000-E' && M.hwName(44) === 'Heltec Wsl V3', 'hw names ' + M.hwName(44));
console.log(`${n} checks passed`);
