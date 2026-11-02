// Kelly Page -- js/mtshare.js (Meshtastic share links) in Node. Its own tiny protobuf reader decodes what the encoder
// wrote; the known-good vector is Meshtastic-Android's ChannelSetTest.matchPython URL.
//   ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" tests/mtshare-test.js     -> RESULT: ALL PASS
'use strict';
const M = require('../js/mtshare.js');
let pass = 0; const fails = [];
function eq(name, got, want) {
  const g = typeof got === 'object' ? JSON.stringify(got) : String(got), w = typeof want === 'object' ? JSON.stringify(want) : String(want);
  if (g === w) { pass++; console.log('PASS ' + name); } else { fails.push(name); console.log(`FAIL ${name}: got ${g} want ${w}`); }
}
const throws = (name, fn, re) => { let m = ''; try { fn(); } catch (e) { m = e.message; } eq(name, re.test(m), true); };

// ---- a tiny proto reader: bytes -> { field: [values] } (varint -> number, length-delimited -> Uint8Array)
function read(b) {
  const o = {}; let i = 0;
  const vi = () => { let v = 0, m = 1, x; do { x = b[i++]; v += (x & 0x7f) * m; m *= 128; } while (x & 0x80); return v; };
  while (i < b.length) {
    const t = vi(), f = Math.floor(t / 8), w = t & 7; let v;
    if (w === 0) v = vi(); else if (w === 2) { const n = vi(); v = b.subarray(i, i + n); i += n; } else if (w === 5) { v = b.subarray(i, i + 4); i += 4; } else throw new Error('wire type ' + w);
    (o[f] = o[f] || []).push(v);
  }
  return o;
}
const fromUrl = url => { const h = url.split('#')[1].replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(Buffer.from(h, 'base64')); };
const hex = b => Buffer.from(b).toString('hex');
// decode a ChannelSet the way an app would (field numbers: js/mtshare.js header)
function decodeSet(bytes) {
  const cs = read(bytes);
  const channels = (cs[1] || []).map(c => { const r = read(c); return { psk: hex(r[2] ? r[2][0] : []), name: r[3] ? Buffer.from(r[3][0]).toString() : '' }; });
  let lora = null;
  if (cs[2]) { const r = read(cs[2][0]), g = f => (r[f] ? r[f][0] : 0); lora = { usePreset: !!g(1), preset: g(2), region: g(7), hopLimit: g(8), txEnabled: !!g(9), txPower: g(10), channelNum: g(11) }; }
  return { channels, lora };
}

// ---- the known-good URL
const KNOWN = 'https://meshtastic.org/e/#CgMSAQESBggBQANIAQ';
eq('known vector: decodes to one default-key channel + use_preset, hop 3, tx on', decodeSet(fromUrl(KNOWN)),
  { channels: [{ psk: '01', name: '' }], lora: { usePreset: true, preset: 0, region: 0, hopLimit: 3, txEnabled: true, txPower: 0, channelNum: 0 } });
eq('known vector: rebuilt byte for byte (LONG_FAST, no region, hop 3)', M.link({ channels: [{}], lora: { preset: 'LONG_FAST', hopLimit: 3 } }), KNOWN);

// ---- the SEQ (MBUG) link
const s5 = M.seq(), d5 = decodeSet(fromUrl(s5.url));
eq('seq: a REPLACE link (no ?add=true: add mode drops the LoRa config)', /^https:\/\/meshtastic\.org\/e\/#[A-Za-z0-9_-]+$/.test(s5.url), true);
eq('seq: one channel, the default key AQ==, empty name (shows as MediumFast)', d5.channels, [{ psk: '01', name: '' }]);
eq('seq: LoRa = preset MEDIUM_FAST (4), region ANZ (6), slot 45, hop 5, tx ENABLED', d5.lora,
  { usePreset: true, preset: 4, region: 6, hopLimit: 5, txEnabled: true, txPower: 0, channelNum: 45 });
eq('seq: exact bytes', hex(fromUrl(s5.url)), '0a03120101120c08011004380640054801582d');
eq('seq: exact URL', s5.url, 'https://meshtastic.org/e/#CgMSAQESDAgBEAQ4BkAFSAFYLQ');
const s7 = M.seq({ hopLimit: 7 });
eq('seq hop 7 (Ipswich / coasts)', decodeSet(fromUrl(s7.url)).lora.hopLimit, 7);
eq('seq: no secret anywhere (psk is the 1-byte default)', decodeSet(fromUrl(s7.url)).channels.every(c => c.psk === '01'), true);
eq('MBUG numbers in SEQ', `${M.SEQ.preset} ${M.SEQ.region} ${M.SEQ.channelNum} ${M.SEQ.hopCity}/${M.SEQ.hopFar}`, 'MEDIUM_FAST ANZ 45 5/7');

// ---- tx_enabled guard + add mode + errors
eq('txEnabled defaults to true when not given', decodeSet(M.encodeChannelSet({ lora: { preset: 'MEDIUM_FAST' } })).lora.txEnabled, true);
eq('txEnabled false only when asked', decodeSet(M.encodeChannelSet({ lora: { txEnabled: false } })).lora.txEnabled, false);
const add = M.link(s5.settings, { add: true });
eq('add link: ?add=true before the #', /^https:\/\/meshtastic\.org\/e\/\?add=true#/.test(add), true);
eq('add link: carries no lora_config', decodeSet(fromUrl(add)).lora, null);
eq('a named channel with its own key', decodeSet(M.encodeChannelSet({ channels: [{ name: 'Weather', psk: Uint8Array.of(1, 2, 3) }] })).channels, [{ psk: '010203', name: 'Weather' }]);
throws('a 12-byte channel name refused', () => M.encodeChannelSet({ channels: [{ name: 'TwelveBytes!' }] }), /11 bytes/);
throws('hop limit 8 refused', () => M.seq({ hopLimit: 8 }), /hop limit/);
throws('unknown preset refused', () => M.encodeChannelSet({ lora: { preset: 'WARP' } }), /unknown preset/);
eq('b64url: no padding, url-safe', M.b64url(Uint8Array.of(0xfb, 0xff)), '-_8');

console.log(`${pass} passed, ${fails.length} failed`);
console.log(`RESULT: ${fails.length ? 'FAIL ' + fails.join(', ') : 'ALL PASS'}`);
process.exitCode = fails.length ? 1 : 0;
