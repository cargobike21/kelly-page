/* Kelly Page -- Meshtastic share links (pure, no DOM): the "SEQ settings" QR on the LoRa Mesh page's 📻 Channels card
 * (js/meshchannels.js). SHOW ONLY: Kelly never applies one to a node; the Meshtastic phone app does when it scans it.
 *
 * Link: https://meshtastic.org/e/#<base64url, no padding, of a ChannelSet protobuf>          REPLACE: the app swaps the
 *       node's channels for these and applies lora_config (retunes + reboots the node)
 *       https://meshtastic.org/e/?add=true#<...>                                              ADD: the app adds the channels
 *       and DROPS lora_config (Meshtastic-Android core/model/.../util/ChannelSet.kt getChannelUrl / toChannelSet, main
 *       2026-10-24: "add must not retune"). So a link that sets the SEQ LoRa settings can only be a REPLACE link.
 * Known-good vector (Meshtastic-Android ChannelSetTest.matchPython): https://meshtastic.org/e/#CgMSAQESBggBQANIAQ =
 *   one channel { psk 0x01 } + LoRaConfig { use_preset, hop_limit 3, tx_enabled } (tests/mtshare-test.js rebuilds it).
 *
 * Field numbers, github.com/meshtastic/protobufs master 569a2b3 (2026-10-24):
 *   apponly.proto  ChannelSet       1 settings (repeated ChannelSettings)  2 lora_config (Config.LoRaConfig)
 *   channel.proto  ChannelSettings  2 psk (bytes; 1 byte 0x01 = the default key "AQ==")  3 name (string; empty = the
 *                                   preset's name, e.g. "MediumFast")  5 uplink_enabled  6 downlink_enabled
 *   config.proto   LoRaConfig       1 use_preset  2 modem_preset (enum; MEDIUM_FAST = 4)  7 region (enum; ANZ = 6)
 *                                   8 hop_limit  9 tx_enabled  10 tx_power (0 = the region's legal max)  11 channel_num
 *                                   (1-based frequency slot; 0 = from the channel name's hash)
 * proto3: a zero / false / empty field is left out, as the official encoders do. A hand-built LoRaConfig that forgets
 * tx_enabled leaves it FALSE and the node goes silent -- so build() always writes it (default true).
 *
 * SEQ settings (MBUG, wiki.mbug.com.au/en/meshtastic/mf-config, read 2026-10-24): MEDIUM_FAST, frequency slot 45
 * (926.125 MHz), region ANZ; hop limit 5 in the city / central, 7 on the coasts, Ipswich and NSW; channel 0 left with
 * an empty name so it shows as "MediumFast". (Role CLIENT_MUTE first -- a device setting, not in a ChannelSet.)
 *
 * UMD: window.KellyMtShare in the browser, module.exports in Node. Tests: tests/mtshare-test.js.
 *   PRESET, REGION, SEQ, DEFAULT_PSK, encodeChannelSet(cs) -> Uint8Array, b64url(bytes), link(cs, {add}) -> url,
 *   seq({ hopLimit }) -> { url, hopLimit, settings }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyMtShare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PRESET = { LONG_FAST: 0, LONG_SLOW: 1, VERY_LONG_SLOW: 2, MEDIUM_SLOW: 3, MEDIUM_FAST: 4, SHORT_SLOW: 5, SHORT_FAST: 6, LONG_MODERATE: 7, SHORT_TURBO: 8 };
  const REGION = { UNSET: 0, US: 1, EU_868: 3, ANZ: 6, NZ_865: 11 };
  const DEFAULT_PSK = Uint8Array.of(1);   // "AQ==": the firmware's well-known default key, index 1 -- no secret
  const SEQ = Object.freeze({ preset: 'MEDIUM_FAST', region: 'ANZ', channelNum: 45, hopCity: 5, hopFar: 7, source: 'wiki.mbug.com.au/en/meshtastic/mf-config (2026-10-24)' });
  const enc = new TextEncoder();

  function varint(a, v) { v = Math.floor(v); if (v < 0 || v > 0xffffffff) throw new RangeError('varint out of range'); while (v > 0x7f) { a.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } a.push(v); }
  const tag = (a, f, w) => varint(a, f * 8 + w);
  const u = (a, f, v) => { if (v) { tag(a, f, 0); varint(a, v === true ? 1 : v); } };   // proto3: 0 / false left out
  const lenf = (a, f, bytes) => { if (!bytes || !bytes.length) return; tag(a, f, 2); varint(a, bytes.length); for (const x of bytes) a.push(x); };
  const sub = (a, f, bytes) => { tag(a, f, 2); varint(a, bytes.length); for (const x of bytes) a.push(x); };   // a message, even if empty
  const enumOf = (tbl, v, what) => { const n = typeof v === 'number' ? v : tbl[v]; if (n == null) throw new Error(`unknown ${what} ${v}`); return n; };

  function channelSettings(c = {}) {
    const a = [];
    lenf(a, 2, c.psk == null ? DEFAULT_PSK : c.psk);
    if (c.name) { const b = enc.encode(c.name); if (b.length > 11) throw new Error('a Meshtastic channel name is 11 bytes at most'); lenf(a, 3, b); }
    u(a, 5, !!c.uplink); u(a, 6, !!c.downlink);
    return a;
  }
  function loraConfig(l = {}) {
    const a = [];
    u(a, 1, l.usePreset !== false);
    u(a, 2, enumOf(PRESET, l.preset == null ? 0 : l.preset, 'preset'));
    u(a, 7, enumOf(REGION, l.region == null ? 0 : l.region, 'region'));
    const hop = l.hopLimit == null ? 3 : l.hopLimit;
    if (!(hop >= 1 && hop <= 7)) throw new Error('hop limit is 1 to 7');
    u(a, 8, hop);
    u(a, 9, l.txEnabled !== false);   // ALWAYS true unless asked: proto3's default false = a silent radio
    u(a, 10, l.txPower || 0);
    u(a, 11, l.channelNum || 0);
    return a;
  }
  // { channels: [{ psk, name, uplink, downlink }], lora: { preset, region, hopLimit, channelNum, txEnabled, usePreset } | null }
  function encodeChannelSet(cs = {}) {
    const a = [];
    for (const c of cs.channels && cs.channels.length ? cs.channels : [{}]) sub(a, 1, channelSettings(c));
    if (cs.lora) sub(a, 2, loraConfig(cs.lora));
    return Uint8Array.from(a);
  }
  function b64url(bytes) {
    let s = ''; for (const x of bytes) s += String.fromCharCode(x);
    const b = typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // add: true -> "?add=true" and no lora_config (what the apps do with it anyway)
  function link(cs, { add = false } = {}) {
    const body = add ? Object.assign({}, cs, { lora: null }) : cs;
    return `https://meshtastic.org/e/${add ? '?add=true' : ''}#${b64url(encodeChannelSet(body))}`;
  }
  // the SEQ (MBUG) settings: the default primary channel (default key, empty name = "MediumFast") + MBUG's LoRa config.
  // A REPLACE link: scanning it swaps the node's channels for this one and retunes it.
  function seq({ hopLimit = SEQ.hopCity } = {}) {
    const settings = { channels: [{ psk: DEFAULT_PSK, name: '' }], lora: { usePreset: true, preset: SEQ.preset, region: SEQ.region, hopLimit, txEnabled: true, channelNum: SEQ.channelNum } };
    return { url: link(settings), hopLimit, settings };
  }
  return { PRESET, REGION, SEQ, DEFAULT_PSK, encodeChannelSet, b64url, link, seq };
});
