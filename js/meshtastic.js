/* Kelly Page -- Meshtastic protocol, pure (no DOM, no radio, no crypto).
 *
 * The protobuf messages Kelly and the P25X gateway use, the serial/TCP stream framer, payload decoders
 * per port, packet builders and the name tables. Field numbers are from github.com/meshtastic/protobufs
 * master 28f4f5f (2026-10-12); only the fields we use are listed -- unknown fields are skipped, so newer
 * firmware still decodes.
 *
 * UMD: window.KellyMesh in the browser, module.exports in Node. gateway/meshtastic.js
 * is an IDENTICAL copy (the gateway's MQTT side) -- edit this one and copy it over.
 *
 * Client API (meshtastic.org/docs/development/device/client-api):
 *   serial (115200 8N1) and TCP (port 4403): 94 C3 | len hi | len lo | protobuf (ToRadio out, FromRadio in),
 *     len <= 512; bytes outside a frame are the device's debug log. Before the first packet on serial,
 *     send WAKE (32 x C3) so a sleeping device starts listening.
 *   BLE: service 6ba1b218-15a8-461f-9fa8-5dcae273eafd; write unframed ToRadio to toradio (f75c76d2-...),
 *     read FromRadio from fromradio (2c55e69e-...) until empty, re-read when fromnum (ed9da18c-...) notifies.
 *   On connect send ToRadio{wantConfigId}: the device replies with myInfo, every nodeInfo, channels,
 *     config, then configCompleteId with the same id.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyMesh = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ schemas: field -> [name, type, repeated]
  const S = {
    MeshPacket: { 1: ['from', 'fixed32'], 2: ['to', 'fixed32'], 3: ['channel', 'uint32'], 4: ['decoded', 'Data'], 5: ['encrypted', 'bytes'],
      6: ['id', 'fixed32'], 7: ['rxTime', 'fixed32'], 8: ['rxSnr', 'float'], 9: ['hopLimit', 'uint32'], 10: ['wantAck', 'bool'],
      11: ['priority', 'uint32'], 12: ['rxRssi', 'int32'], 14: ['viaMqtt', 'bool'], 15: ['hopStart', 'uint32'], 17: ['pkiEncrypted', 'bool'],
      18: ['nextHop', 'uint32'], 19: ['relayNode', 'uint32'] },
    Data: { 1: ['portnum', 'uint32'], 2: ['payload', 'bytes'], 3: ['wantResponse', 'bool'], 4: ['dest', 'fixed32'], 5: ['source', 'fixed32'],
      6: ['requestId', 'fixed32'], 7: ['replyId', 'fixed32'], 8: ['emoji', 'fixed32'], 9: ['bitfield', 'uint32'] },
    User: { 1: ['id', 'string'], 2: ['longName', 'string'], 3: ['shortName', 'string'], 4: ['macaddr', 'bytes'], 5: ['hwModel', 'uint32'],
      6: ['isLicensed', 'bool'], 7: ['role', 'uint32'], 8: ['publicKey', 'bytes'], 9: ['isUnmessagable', 'bool'] },
    Position: { 1: ['latitudeI', 'sfixed32'], 2: ['longitudeI', 'sfixed32'], 3: ['altitude', 'int32'], 4: ['time', 'fixed32'],
      5: ['locationSource', 'uint32'], 7: ['timestamp', 'fixed32'], 14: ['gpsAccuracy', 'uint32'], 15: ['groundSpeed', 'uint32'],
      16: ['groundTrack', 'uint32'], 19: ['satsInView', 'uint32'], 23: ['precisionBits', 'uint32'] },
    DeviceMetrics: { 1: ['batteryLevel', 'uint32'], 2: ['voltage', 'float'], 3: ['channelUtilization', 'float'], 4: ['airUtilTx', 'float'],
      5: ['uptimeSeconds', 'uint32'] },
    EnvironmentMetrics: { 1: ['temperature', 'float'], 2: ['relativeHumidity', 'float'], 3: ['barometricPressure', 'float'], 5: ['voltage', 'float'],
      6: ['current', 'float'], 9: ['lux', 'float'] },
    Telemetry: { 1: ['time', 'fixed32'], 2: ['deviceMetrics', 'DeviceMetrics'], 3: ['environmentMetrics', 'EnvironmentMetrics'] },
    NodeInfo: { 1: ['num', 'uint32'], 2: ['user', 'User'], 3: ['position', 'Position'], 4: ['snr', 'float'], 5: ['lastHeard', 'fixed32'],
      6: ['deviceMetrics', 'DeviceMetrics'], 7: ['channel', 'uint32'], 8: ['viaMqtt', 'bool'], 9: ['hopsAway', 'uint32'], 10: ['isFavorite', 'bool'] },
    MyNodeInfo: { 1: ['myNodeNum', 'uint32'], 8: ['rebootCount', 'uint32'], 11: ['minAppVersion', 'uint32'], 13: ['pioEnv', 'string'], 15: ['nodedbCount', 'uint32'] },
    ChannelSettings: { 2: ['psk', 'bytes'], 3: ['name', 'string'], 4: ['id', 'fixed32'], 5: ['uplinkEnabled', 'bool'], 6: ['downlinkEnabled', 'bool'] },
    Channel: { 1: ['index', 'int32'], 2: ['settings', 'ChannelSettings'], 3: ['role', 'uint32'] },
    LogRecord: { 1: ['message', 'string'], 2: ['time', 'fixed32'], 3: ['source', 'string'], 4: ['level', 'uint32'] },
    QueueStatus: { 1: ['res', 'int32'], 2: ['free', 'uint32'], 3: ['maxlen', 'uint32'], 4: ['meshPacketId', 'uint32'] },
    DeviceMetadata: { 1: ['firmwareVersion', 'string'], 2: ['deviceStateVersion', 'uint32'], 7: ['role', 'uint32'], 9: ['hwModel', 'uint32'] },
    FromRadio: { 1: ['id', 'uint32'], 2: ['packet', 'MeshPacket'], 3: ['myInfo', 'MyNodeInfo'], 4: ['nodeInfo', 'NodeInfo'], 6: ['logRecord', 'LogRecord'],
      7: ['configCompleteId', 'uint32'], 8: ['rebooted', 'bool'], 10: ['channel', 'Channel'], 11: ['queueStatus', 'QueueStatus'], 13: ['metadata', 'DeviceMetadata'] },
    Heartbeat: { 1: ['nonce', 'uint32'] },
    ToRadio: { 1: ['packet', 'MeshPacket'], 3: ['wantConfigId', 'uint32'], 4: ['disconnect', 'bool'], 7: ['heartbeat', 'Heartbeat'] },
    RouteDiscovery: { 1: ['route', 'fixed32', 1], 2: ['snrTowards', 'int32', 1], 3: ['routeBack', 'fixed32', 1], 4: ['snrBack', 'int32', 1] },
    Routing: { 1: ['routeRequest', 'RouteDiscovery'], 2: ['routeReply', 'RouteDiscovery'], 3: ['errorReason', 'uint32'] },
    Waypoint: { 1: ['id', 'uint32'], 2: ['latitudeI', 'sfixed32'], 3: ['longitudeI', 'sfixed32'], 4: ['expire', 'uint32'], 5: ['lockedTo', 'uint32'],
      6: ['name', 'string'], 7: ['description', 'string'], 8: ['icon', 'fixed32'] },
    Neighbor: { 1: ['nodeId', 'uint32'], 2: ['snr', 'float'], 3: ['lastRxTime', 'fixed32'] },
    NeighborInfo: { 1: ['nodeId', 'uint32'], 2: ['lastSentById', 'uint32'], 3: ['nodeBroadcastIntervalSecs', 'uint32'], 4: ['neighbors', 'Neighbor', 1] },
    MapReport: { 1: ['longName', 'string'], 2: ['shortName', 'string'], 3: ['role', 'uint32'], 4: ['hwModel', 'uint32'], 5: ['firmwareVersion', 'string'],
      6: ['region', 'uint32'], 7: ['modemPreset', 'uint32'], 8: ['hasDefaultChannel', 'bool'], 9: ['latitudeI', 'sfixed32'], 10: ['longitudeI', 'sfixed32'],
      11: ['altitude', 'int32'], 12: ['positionPrecision', 'uint32'], 13: ['numOnlineLocalNodes', 'uint32'] },
    ServiceEnvelope: { 1: ['packet', 'MeshPacket'], 2: ['channelId', 'string'], 3: ['gatewayId', 'string'] },
  };
  const WIRE = { uint32: 0, int32: 0, sint32: 0, bool: 0, fixed32: 5, sfixed32: 5, float: 5, string: 2, bytes: 2 };
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ------------------------------------------------------------------ protobuf decode
  function readVarint(b, o) {   // -> [lo, hi, next]; exact low 32 bits (a negative int32 is a 10-byte varint)
    let lo = 0, hi = 0, shift = 0, x;
    for (let i = 0; i < 10; i++) {
      if (o >= b.length) throw new Error('varint cut short');
      x = b[o++];
      if (shift < 28) lo |= (x & 0x7f) << shift;
      else if (shift === 28) { lo |= (x & 0x0f) << 28; hi |= (x & 0x7f) >>> 4; }
      else hi |= (x & 0x7f) << (shift - 32);
      shift += 7;
      if (!(x & 0x80)) return [lo >>> 0, hi >>> 0, o];
    }
    throw new Error('varint too long');
  }
  function scalar(type, lo, hi) {
    if (type === 'bool') return lo !== 0;
    if (type === 'int32') return lo | 0;
    if (type === 'sint32') return (lo >>> 1) ^ -(lo & 1);
    return lo;   // uint32
  }
  function decode(name, b) {
    const sch = S[name], out = {};
    if (!b) return out;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 0;
    while (o < b.length) {
      let key; [key, , o] = readVarint(b, o);
      const fno = key >>> 3, wt = key & 7, f = sch[fno];
      let raw;
      if (wt === 0) { const r = readVarint(b, o); o = r[2]; raw = r; }
      else if (wt === 5) { if (o + 4 > b.length) throw new Error('fixed32 cut short'); raw = o; o += 4; }
      else if (wt === 1) { o += 8; continue; }
      else if (wt === 2) { let n; [n, , o] = readVarint(b, o); if (o + n > b.length) throw new Error(`${name}.${fno} cut short`); raw = b.subarray(o, o + n); o += n; }
      else throw new Error(`wire type ${wt} in ${name}`);
      if (!f) continue;
      const [key2, type, rep] = f;
      const one = (w, r) => {
        if (S[type]) return decode(type, r);
        if (w === 0) return scalar(type, r[0], r[1]);
        if (w === 5) return type === 'float' ? dv.getFloat32(r, true) : type === 'sfixed32' ? dv.getInt32(r, true) : dv.getUint32(r, true);
        return type === 'string' ? dec.decode(r) : r;
      };
      if (rep && wt === 2 && !S[type] && WIRE[type] !== 2) {   // packed repeated scalars
        const arr = out[key2] || (out[key2] = []);
        const sub = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        for (let p = 0; p < raw.length;) {
          if (WIRE[type] === 5) { arr.push(type === 'sfixed32' ? sub.getInt32(p, true) : type === 'float' ? sub.getFloat32(p, true) : sub.getUint32(p, true)); p += 4; }
          else { const r = readVarint(raw, p); p = r[2]; arr.push(scalar(type, r[0], r[1])); }
        }
      } else if (rep) (out[key2] || (out[key2] = [])).push(one(wt, raw));
      else out[key2] = one(wt, raw);
    }
    return out;
  }

  // ------------------------------------------------------------------ protobuf encode
  function pushVarint(a, v) {   // uint32 or int32 (negative -> 10 bytes)
    if (v < 0) { let lo = v >>> 0; for (let i = 0; i < 4; i++) { a.push((lo & 0x7f) | 0x80); lo >>>= 7; } a.push((lo & 0x0f) | 0x70 | 0x80); for (let i = 0; i < 4; i++) a.push(0xff); a.push(0x01); return; }
    v >>>= 0;
    while (v > 0x7f) { a.push((v & 0x7f) | 0x80); v >>>= 7; }
    a.push(v);
  }
  function encode(name, obj) {
    const sch = S[name], a = [];
    const f4 = (v, type) => { const x = new DataView(new ArrayBuffer(4)); if (type === 'float') x.setFloat32(0, v, true); else if (type === 'sfixed32') x.setInt32(0, v, true); else x.setUint32(0, v >>> 0, true); for (let i = 0; i < 4; i++) a.push(x.getUint8(i)); };
    for (const fno of Object.keys(sch)) {
      const [key, type, rep] = sch[fno];
      const val = obj[key];
      if (val === undefined || val === null) continue;
      const vals = rep ? val : [val];
      if (rep && !S[type] && WIRE[type] !== 2) {   // packed
        const sub = [];
        for (const v of vals) { if (WIRE[type] === 5) { const x = new DataView(new ArrayBuffer(4)); if (type === 'sfixed32') x.setInt32(0, v, true); else x.setUint32(0, v >>> 0, true); for (let i = 0; i < 4; i++) sub.push(x.getUint8(i)); } else pushVarint(sub, type === 'bool' ? +v : v); }
        pushVarint(a, (fno << 3) | 2); pushVarint(a, sub.length); a.push(...sub);
        continue;
      }
      for (const v of vals) {
        if (S[type]) { const m = encode(type, v); pushVarint(a, (fno << 3) | 2); pushVarint(a, m.length); for (const x of m) a.push(x); continue; }
        const w = WIRE[type];
        pushVarint(a, (fno << 3) | w);
        if (w === 0) pushVarint(a, type === 'bool' ? (v ? 1 : 0) : type === 'sint32' ? ((v << 1) ^ (v >> 31)) >>> 0 : v);
        else if (w === 5) f4(v, type);
        else { const by = type === 'string' ? enc.encode(v) : v; pushVarint(a, by.length); for (const x of by) a.push(x); }
      }
    }
    return Uint8Array.from(a);
  }

  // ------------------------------------------------------------------ stream framing (serial / TCP)
  const START1 = 0x94, START2 = 0xc3, MAXLEN = 512;
  const WAKE = new Uint8Array(32).fill(START2);
  function frame(bytes) { const out = new Uint8Array(bytes.length + 4); out.set([START1, START2, bytes.length >> 8, bytes.length & 0xff]); out.set(bytes, 4); return out; }
  // push(bytes): calls onFrame(protobuf bytes) per frame and onLog(text line) for the debug output between them.
  class Framer {
    constructor(onFrame, onLog) { this.onFrame = onFrame; this.onLog = onLog || (() => {}); this.buf = new Uint8Array(0); this.text = ''; }
    push(bytes) {
      const b = new Uint8Array(this.buf.length + bytes.length); b.set(this.buf); b.set(bytes, this.buf.length);
      let o = 0;
      while (o < b.length) {
        if (b[o] !== START1) { this.logByte(b[o]); o++; continue; }
        if (o + 1 >= b.length) break;
        if (b[o + 1] !== START2) { this.logByte(b[o]); o++; continue; }
        if (o + 3 >= b.length) break;
        const n = (b[o + 2] << 8) | b[o + 3];
        if (n > MAXLEN) { o++; continue; }              // corrupt: back to hunting for START1
        if (o + 4 + n > b.length) break;
        this.flushLog();
        try { this.onFrame(b.slice(o + 4, o + 4 + n)); } catch (e) { this.onLog(`[frame error] ${e.message}`); }
        o += 4 + n;
      }
      this.buf = b.slice(o);
      if (this.buf.length > 4096) this.buf = new Uint8Array(0);
    }
    logByte(c) { if (c === 10) this.flushLog(); else if (c >= 32 && c < 127) { this.text += String.fromCharCode(c); if (this.text.length > 400) this.flushLog(); } }
    flushLog() { const t = this.text.replace(/\x1b\[[0-9;]*m/g, '').trim(); this.text = ''; if (t) this.onLog(t); }
  }

  // ------------------------------------------------------------------ names
  const BROADCAST = 0xffffffff;
  const PORT = { TEXT: 1, REMOTE_HW: 2, POSITION: 3, NODEINFO: 4, ROUTING: 5, ADMIN: 6, TEXT_COMPRESSED: 7, WAYPOINT: 8, AUDIO: 9, DETECTION: 10,
    ALERT: 11, REPLY: 32, IP_TUNNEL: 33, PAXCOUNTER: 34, SERIAL: 64, STORE_FORWARD: 65, RANGE_TEST: 66, TELEMETRY: 67, TRACEROUTE: 70,
    NEIGHBORINFO: 71, ATAK: 72, MAP_REPORT: 73 };
  const PORT_NAME = Object.fromEntries(Object.entries(PORT).map(([k, v]) => [v, k]));
  const ROLE = ['Client', 'Client mute', 'Router', 'Router client', 'Repeater', 'Tracker', 'Sensor', 'TAK', 'Client hidden', 'Lost and found', 'TAK tracker', 'Router late', 'Client base'];
  const ROUTING_ERROR = { 0: 'OK', 1: 'no route', 2: 'NAK', 3: 'timed out', 4: 'no interface', 5: 'max retransmit', 6: 'no channel', 7: 'too large',
    8: 'no response', 9: 'duty cycle limit', 32: 'bad request', 33: 'not authorised', 34: 'PKI failed', 35: 'unknown public key', 38: 'rate limited' };
  const HW = { 0: 'UNSET', 1: 'TLORA_V2', 2: 'TLORA_V1', 3: 'TLORA_V2_1_1P6', 4: 'TBEAM', 5: 'HELTEC_V2_0', 6: 'TBEAM_V0P7', 7: 'T_ECHO', 8: 'TLORA_V1_1P3',
    9: 'RAK4631', 10: 'HELTEC_V2_1', 11: 'HELTEC_V1', 12: 'LILYGO_TBEAM_S3_CORE', 13: 'RAK11200', 14: 'NANO_G1', 15: 'TLORA_V2_1_1P8', 16: 'TLORA_T3_S3',
    17: 'NANO_G1_EXPLORER', 18: 'NANO_G2_ULTRA', 19: 'LORA_TYPE', 20: 'WIPHONE', 21: 'WIO_WM1110', 22: 'RAK2560', 23: 'HELTEC_HRU_3601',
    24: 'HELTEC_WIRELESS_BRIDGE', 25: 'STATION_G1', 26: 'RAK11310', 27: 'MAKERFABS_TRACKER', 29: 'CANARYONE', 30: 'RP2040_LORA', 31: 'STATION_G2',
    32: 'LORA_RELAY_V1', 33: 'T_ECHO_PLUS', 34: 'PPR', 35: 'GENIEBLOCKS', 36: 'NRF52_UNKNOWN', 37: 'PORTDUINO', 38: 'ANDROID_SIM', 39: 'DIY_V1',
    40: 'NRF52840_PCA10059', 41: 'DR_DEV', 42: 'M5STACK', 43: 'HELTEC_V3', 44: 'HELTEC_WSL_V3', 45: 'BETAFPV_2400_TX', 46: 'BETAFPV_900_NANO_TX',
    47: 'RPI_PICO', 48: 'HELTEC_WIRELESS_TRACKER', 49: 'HELTEC_WIRELESS_PAPER', 50: 'T_DECK', 51: 'T_WATCH_S3', 52: 'PICOMPUTER_S3', 53: 'HELTEC_HT62',
    54: 'EBYTE_ESP32_S3', 55: 'ESP32_S3_PICO', 56: 'CHATTER_2', 57: 'HELTEC_WIRELESS_PAPER_V1_0', 58: 'HELTEC_WIRELESS_TRACKER_V1_0', 59: 'UNPHONE',
    60: 'TD_LORAC', 61: 'CDEBYTE_EORA_S3', 62: 'TWC_MESH_V4', 63: 'NRF52_PROMICRO_DIY', 64: 'RADIOMASTER_900_BANDIT_NANO', 65: 'HELTEC_CAPSULE_SENSOR_V3',
    66: 'HELTEC_VISION_MASTER_T190', 67: 'HELTEC_VISION_MASTER_E213', 68: 'HELTEC_VISION_MASTER_E290', 69: 'HELTEC_MESH_NODE_T114', 70: 'SENSECAP_INDICATOR',
    71: 'TRACKER_T1000_E', 72: 'RAK3172', 73: 'WIO_E5', 74: 'RADIOMASTER_900_BANDIT', 75: 'ME25LS01_4Y10TD', 76: 'RP2040_FEATHER_RFM95',
    77: 'M5STACK_COREBASIC', 78: 'M5STACK_CORE2', 79: 'RPI_PICO2', 80: 'M5STACK_CORES3', 81: 'SEEED_XIAO_S3', 82: 'MS24SF1', 83: 'TLORA_C6',
    84: 'WISMESH_TAP', 85: 'ROUTASTIC', 86: 'MESH_TAB', 87: 'MESHLINK', 88: 'XIAO_NRF52_KIT', 89: 'THINKNODE_M1', 90: 'THINKNODE_M2', 91: 'T_ETH_ELITE',
    92: 'HELTEC_SENSOR_HUB', 93: 'MUZI_BASE', 94: 'HELTEC_MESH_POCKET', 95: 'SEEED_SOLAR_NODE', 96: 'NOMADSTAR_METEOR_PRO', 97: 'CROWPANEL', 98: 'LINK_32',
    99: 'SEEED_WIO_TRACKER_L1', 100: 'SEEED_WIO_TRACKER_L1_EINK', 101: 'MUZI_R1_NEO', 102: 'T_DECK_PRO', 103: 'T_LORA_PAGER', 105: 'WISMESH_TAG',
    106: 'RAK3312', 107: 'THINKNODE_M5', 108: 'HELTEC_MESH_SOLAR', 109: 'T_ECHO_LITE', 110: 'HELTEC_V4', 111: 'M5STACK_C6L', 112: 'M5STACK_CARDPUTER_ADV',
    113: 'HELTEC_WIRELESS_TRACKER_V2', 114: 'T_WATCH_ULTRA', 115: 'THINKNODE_M3', 116: 'WISMESH_TAP_V2', 117: 'RAK3401', 118: 'RAK6421', 119: 'THINKNODE_M4',
    120: 'THINKNODE_M6', 121: 'MESHSTICK_1262', 122: 'TBEAM_1_WATT', 123: 'T5_S3_EPAPER_PRO', 124: 'TBEAM_BPF', 125: 'MINI_EPAPER_S3', 126: 'TDISPLAY_S3_PRO',
    127: 'HELTEC_MESH_NODE_T096', 128: 'MESH_TRACKER_X1', 129: 'THINKNODE_M7', 130: 'THINKNODE_M8', 131: 'THINKNODE_M9', 132: 'HELTEC_V4_R8',
    133: 'HELTEC_MESH_NODE_T1', 134: 'STATION_G3', 135: 'T_IMPULSE_PLUS', 136: 'T_ECHO_CARD', 137: 'SEEED_WIO_TRACKER_L2', 138: 'CROWPANEL_P4',
    139: 'HELTEC_MESH_TOWER_V2', 140: 'MESHNOLOGY_W10', 141: 'HELTEC_RC32', 142: 'HELTEC_RC52', 143: 'HELTEC_RCC6', 144: 'SEEED_WIO_TRACKER_L1_PRO_1W',
    145: 'MESHNOLOGY_W12', 146: 'MESHPAGER_X2', 147: 'T_CONNECT_PRO', 148: 'AXIOMETA_GENESIS_MINI', 149: 'MAKERFABS_NOMAD_TERMINAL', 150: 'THINKNODE_MX', 255: 'PRIVATE_HW' };
  const HW_PRETTY = { TBEAM: 'LilyGO T-Beam', T_ECHO: 'LilyGO T-Echo', RAK4631: 'RAK WisBlock 4631', HELTEC_V3: 'Heltec V3', HELTEC_V4: 'Heltec V4',
    T_DECK: 'LilyGO T-Deck', T_DECK_PRO: 'LilyGO T-Deck Pro', TRACKER_T1000_E: 'SenseCAP T1000-E', STATION_G2: 'B&Q Station G2', STATION_G3: 'B&Q Station G3',
    NANO_G2_ULTRA: 'B&Q Nano G2 Ultra', HELTEC_WIRELESS_TRACKER: 'Heltec Wireless Tracker', HELTEC_MESH_NODE_T114: 'Heltec T114', SEEED_XIAO_S3: 'Seeed XIAO S3',
    PORTDUINO: 'Linux (meshtasticd)', LILYGO_TBEAM_S3_CORE: 'LilyGO T-Beam Supreme', THINKNODE_M1: 'Elecrow ThinkNode M1', WISMESH_TAP: 'RAK WisMesh Tap',
    HELTEC_MESH_POCKET: 'Heltec MeshPocket', SEEED_WIO_TRACKER_L1: 'Seeed Wio Tracker L1', T_LORA_PAGER: 'LilyGO T-LoRa Pager', ANDROID_SIM: 'Android simulator',
    DIY_V1: 'DIY', PRIVATE_HW: 'Private hardware', UNSET: 'Unknown' };
  function hwName(n) {
    const k = HW[n];
    if (!k) return n == null ? '' : `Hardware ${n}`;
    return HW_PRETTY[k] || k.toLowerCase().split('_').map(w => /^(v\d|s3|g\d|t\d+|e\d+|c\d|m\d+|rak\d*|esp32)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  const nodeId = n => '!' + (n >>> 0).toString(16).padStart(8, '0');
  const parseNodeId = s => { const m = /^!?([0-9a-f]{8})$/i.exec(String(s || '').trim()); return m ? parseInt(m[1], 16) >>> 0 : null; };
  // Meshtastic's own default short name: the last 4 hex digits of the node id.
  const defaultShort = n => (n >>> 0).toString(16).padStart(8, '0').slice(-4);

  // ------------------------------------------------------------------ payloads
  const deg = i => (i == null ? null : i / 1e7);
  // -> { port, name, ... } for the ports Kelly shows; { port, name, raw } for the rest.
  function decodePayload(portnum, payload) {
    const p = payload || new Uint8Array(0), name = PORT_NAME[portnum] || `PORT_${portnum}`;
    try {
      switch (portnum) {
        case PORT.TEXT: case PORT.RANGE_TEST: case PORT.DETECTION: case PORT.ALERT: return { port: portnum, name, text: dec.decode(p) };
        case PORT.POSITION: { const x = decode('Position', p); return { port: portnum, name, ...x, lat: deg(x.latitudeI), lon: deg(x.longitudeI) }; }
        case PORT.NODEINFO: return { port: portnum, name, user: decode('User', p) };
        case PORT.ROUTING: return { port: portnum, name, routing: decode('Routing', p) };
        case PORT.TELEMETRY: return { port: portnum, name, telemetry: decode('Telemetry', p) };
        case PORT.TRACEROUTE: return { port: portnum, name, route: decode('RouteDiscovery', p) };
        case PORT.WAYPOINT: { const w = decode('Waypoint', p); return { port: portnum, name, waypoint: { ...w, lat: deg(w.latitudeI), lon: deg(w.longitudeI) } }; }
        case PORT.NEIGHBORINFO: return { port: portnum, name, neighbors: decode('NeighborInfo', p) };
        case PORT.MAP_REPORT: { const m = decode('MapReport', p); return { port: portnum, name, map: { ...m, lat: deg(m.latitudeI), lon: deg(m.longitudeI) } }; }
        default: return { port: portnum, name, raw: p };
      }
    } catch (e) { return { port: portnum, name, error: e.message, raw: p }; }
  }

  // ------------------------------------------------------------------ builders (ToRadio bytes, unframed)
  const newId = () => ((Math.random() * 0xfffffffe) >>> 0) + 1;
  const toRadio = obj => encode('ToRadio', obj);
  const wantConfig = id => toRadio({ wantConfigId: id });
  const heartbeat = () => toRadio({ heartbeat: { nonce: newId() } });
  function packet({ to = BROADCAST, channel = 0, portnum, payload, wantAck = false, wantResponse = false, id = newId(), hopLimit, replyId, emoji, requestId }) {
    return { id, bytes: toRadio({ packet: { to, channel, id, wantAck, hopLimit, decoded: { portnum, payload, wantResponse, replyId, emoji, requestId } } }) };
  }
  // A text (max ~200 bytes over the air); emoji = 1 with replyId makes it a tapback reaction.
  const textPacket = ({ to, channel, text, wantAck = true, replyId, emoji }) =>
    packet({ to, channel, portnum: PORT.TEXT, payload: enc.encode(text), wantAck, replyId, emoji: emoji ? 1 : undefined });   // broadcast + wantAck = "heard by the mesh" (implicit ACK)
  const positionPacket = ({ to, channel, lat, lon, alt, time = Math.floor(Date.now() / 1000), wantResponse }) =>
    packet({ to, channel, portnum: PORT.POSITION, wantResponse, payload: encode('Position', { latitudeI: Math.round(lat * 1e7), longitudeI: Math.round(lon * 1e7), altitude: alt != null ? Math.round(alt) : undefined, time, locationSource: 1 }) });
  const traceroutePacket = ({ to, channel = 0, hopLimit = 7 }) => packet({ to, channel, portnum: PORT.TRACEROUTE, payload: encode('RouteDiscovery', {}), wantResponse: true, hopLimit });
  const nodeinfoPacket = ({ to, channel = 0, user }) => packet({ to, channel, portnum: PORT.NODEINFO, payload: encode('User', user), wantResponse: true });
  const MAX_TEXT_BYTES = 200;

  // ------------------------------------------------------------------ MQTT helpers (the gateway side; crypto is the caller's)
  // Default channel key ("AQ==" = 1): 1PG7OiApB1nwvP+rz05pAQ==. A 1-byte PSK n means the default key with its last
  // byte + (n - 1); 16 / 32 bytes = AES-128 / AES-256 as given; empty = no encryption.
  const DEFAULT_KEY = Uint8Array.from([0xd4, 0xf1, 0xbb, 0x3a, 0x20, 0x29, 0x07, 0x59, 0xf0, 0xbc, 0xff, 0xab, 0xcf, 0x4e, 0x69, 0x01]);
  function expandPsk(psk) {
    if (!psk || !psk.length) return null;
    if (psk.length === 1) { if (psk[0] === 0) return null; const k = DEFAULT_KEY.slice(); k[15] = (k[15] + psk[0] - 1) & 0xff; return k; }
    return psk;
  }
  // AES-CTR nonce: packet id (64-bit LE) | from node (32-bit LE) | 4 zero bytes.
  function nonce(packetId, fromNode) { const n = new Uint8Array(16), dv = new DataView(n.buffer); dv.setUint32(0, packetId >>> 0, true); dv.setUint32(8, fromNode >>> 0, true); return n; }
  // Channel hash the firmware puts in MeshPacket.channel for encrypted packets: XOR of the name bytes ^ XOR of the key bytes.
  function channelHash(name, key) { let h = 0; for (const c of enc.encode(name)) h ^= c; for (const c of key || []) h ^= c; return h & 0xff; }

  return { S, decode, encode, Framer, frame, WAKE, MAXLEN, BROADCAST, PORT, PORT_NAME, ROLE, ROUTING_ERROR, HW, hwName, nodeId, parseNodeId, defaultShort,
    decodePayload, newId, toRadio, wantConfig, heartbeat, packet, textPacket, positionPacket, traceroutePacket, nodeinfoPacket, MAX_TEXT_BYTES,
    DEFAULT_KEY, expandPsk, nonce, channelHash,
    fromRadio: b => decode('FromRadio', b), meshPacket: b => decode('MeshPacket', b), envelope: b => decode('ServiceEnvelope', b),
    BLE: { service: '6ba1b218-15a8-461f-9fa8-5dcae273eafd', toRadio: 'f75c76d2-129e-4dad-a1dd-7866124401e7',
      fromRadio: '2c55e69e-4993-11ed-b878-0242ac120002', fromNum: 'ed9da18c-a800-4f66-a670-aa7547e34453' },
    TCP_PORT: 4403, BAUD: 115200 };
});
