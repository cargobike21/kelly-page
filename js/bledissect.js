/* Kelly Page -- BLE packet dissector, pure (no DOM): the BLE Presence page's Inspector, Learn tab, Packet Quiz and
 * BLEdex. Every field knows its exact bytes, a plain-English explanation, and whether those bytes were really captured.
 *
 * Captured: the bridge's raw HCI capture (bridge/kelly_ble.py HciCapture, CAP_NET_RAW) hands over the controller's
 * own LE Advertising Report events, byte for byte -- 04 3E len 02 (legacy) / 0D (extended) ... -- which is what btmon
 * and Wireshark show. Reconstructed: from a parsed record (BlueZ via bleak, a remote node, the demo): the AD structures
 * are rebuilt from the fields BlueZ kept, so byte order and Flags may differ from the air -- every such node has
 * real: false and the UI says so. Never present a guessed byte as captured.
 *
 * Neither path sees the link layer (preamble, access address, PDU header, CRC): the controller strips it. Those are
 * shown only as an explanation (LINK_LAYER), clearly marked, until an nRF52840 sniffer is supported.
 *
 * window.KellyBleDissect (UMD). Tests: tests/ble-tests.html.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyBleDissect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const hx = (b, n = 2) => b.toString(16).toUpperCase().padStart(n, '0');
  const le16 = (b, i) => b[i] | (b[i + 1] << 8);
  const be16 = (b, i) => (b[i] << 8) | b[i + 1];
  const s8 = v => (v > 127 ? v - 256 : v);
  const s16 = v => (v > 32767 ? v - 65536 : v);
  const fromHex = h => Uint8Array.from((String(h).match(/../g) || []).map(x => parseInt(x, 16)));
  const toHex = (b, sep = ' ') => Array.from(b, x => hx(x)).join(sep);
  const addrStr = (b, i) => Array.from(b.slice(i, i + 6)).reverse().map(x => hx(x)).join(':');   // over the air LSB first

  const COMPANIES = { 0x004C: 'Apple', 0x0006: 'Microsoft', 0x0075: 'Samsung', 0x00E0: 'Google', 0x0059: 'Nordic Semiconductor',
    0x02E5: 'Espressif', 0x038F: 'Xiaomi', 0x0157: 'Huami', 0x0499: 'Ruuvi', 0x0087: 'Garmin', 0x0171: 'Amazon', 0x009E: 'Bose',
    0x0822: 'Adafruit', 0x000D: 'Texas Instruments', 0x000A: 'Qualcomm', 0x0131: 'Cypress', 0x0002: 'Intel', 0x000F: 'Broadcom',
    0x005D: 'Realtek', 0x0397: 'Tile', 0x067C: 'Tile', 0x0969: 'Woan (SwitchBot)', 0x0A12: 'Inkbird', 0x0D53: 'Tuya' };
  const company = id => COMPANIES[id] || `company 0x${hx(id, 4)}`;

  // Bluetooth SIG assigned numbers: AD types (a selection -- the common ones and a few rare ones worth a badge)
  const AD_TYPES = {
    0x01: ['Flags', 'How the device can be discovered and which radios it has.'],
    0x02: ['16-bit service UUIDs (more exist)', 'Services the device offers, as short SIG numbers; the list is incomplete.'],
    0x03: ['16-bit service UUIDs', 'The full list of services the device offers, as short SIG numbers.'],
    0x04: ['32-bit service UUIDs (more exist)', ''], 0x05: ['32-bit service UUIDs', ''],
    0x06: ['128-bit service UUIDs (more exist)', 'Custom services use long 128-bit UUIDs.'], 0x07: ['128-bit service UUIDs', 'Custom services use long 128-bit UUIDs.'],
    0x08: ['Shortened local name', 'The start of the device\'s name -- the rest needs a scan request.'],
    0x09: ['Complete local name', 'The device\'s name, in UTF-8.'],
    0x0A: ['TX power level', 'How loud the device transmits, in dBm -- with the RSSI it gives a rough distance (path loss).'],
    0x0D: ['Class of device', 'A Classic Bluetooth device class.'], 0x10: ['Device ID', ''],
    0x12: ['Peripheral connection interval range', ''], 0x14: ['16-bit solicitation UUIDs', ''],
    0x16: ['Service data (16-bit UUID)', 'Data belonging to one service: a 16-bit UUID, then that service\'s bytes. BTHome, Eddystone and the Xiaomi custom firmware all live here.'],
    0x17: ['Public target address', ''], 0x18: ['Random target address', ''],
    0x19: ['Appearance', 'What kind of thing this is (watch, tag, thermometer...), as a SIG number.'],
    0x1A: ['Advertising interval', ''], 0x1B: ['LE Bluetooth device address', ''], 0x1C: ['LE role', ''],
    0x20: ['Service data (32-bit UUID)', ''], 0x21: ['Service data (128-bit UUID)', ''], 0x24: ['URI', ''],
    0x27: ['LE supported features', ''], 0x29: ['PB-ADV (Mesh provisioning)', ''], 0x2A: ['Mesh message', 'Bluetooth Mesh traffic.'],
    0x2B: ['Mesh beacon', 'Bluetooth Mesh beacon.'], 0x2C: ['BIGInfo', 'LE Audio broadcast info.'], 0x2D: ['Broadcast code', ''],
    0x30: ['Broadcast name', 'An LE Audio (Auracast) broadcast\'s name.'], 0x31: ['Encrypted advertising data', ''],
    0xFF: ['Manufacturer specific data', 'A company ID (assigned by the Bluetooth SIG) then whatever that company wants. iBeacon is Apple\'s.'] };
  const adName = t => (AD_TYPES[t] || [`AD type 0x${hx(t)}`])[0];
  const LEGACY_EVT = { 0: ['ADV_IND', 'Connectable and scannable: anyone may ask for more (a scan request) or connect.'],
    1: ['ADV_DIRECT_IND', 'A call to one particular device to connect.'],
    2: ['ADV_SCAN_IND', 'Scannable, not connectable: ask for more, but you can\'t connect.'],
    3: ['ADV_NONCONN_IND', 'Just broadcasting: no scan, no connection. Most beacons send this.'],
    4: ['SCAN_RSP', 'The answer to our scan request: extra data the device couldn\'t fit in its advert (often the name).'] };
  const ADDR_TYPE = { 0: 'Public', 1: 'Random', 2: 'Public identity (resolved)', 3: 'Random static identity (resolved)' };
  const PHY = { 0: 'none', 1: 'LE 1M', 2: 'LE 2M', 3: 'LE Coded (long range)' };
  const randomKind = top => (top === 3 ? 'static' : top === 1 ? 'rpa' : top === 0 ? 'nrpa' : 'reserved');
  const KIND_TXT = { public: 'a public address, fixed by the maker', static: 'random static -- fixed until the device is reset',
    rpa: 'a resolvable private address -- it changes every few minutes so nobody can track the device (phones, watches)',
    nrpa: 'a non-resolvable private address -- changes, and can never be traced back', reserved: 'a reserved address type' };

  // the link layer the controller strips before we see anything (explanation only, never "captured")
  const LINK_LAYER = [
    { label: 'Preamble', bytes: 'AA', explain: '1 byte (2 on 2M PHY) of alternating bits so the receiver can lock on. Not visible over HCI.' },
    { label: 'Access address', bytes: 'D6 BE 89 8E', explain: '0x8E89BED6, the same for every advertisement on channels 37, 38 and 39 (sent LSB first). Not visible over HCI.' },
    { label: 'PDU header', bytes: '?? ??', explain: 'PDU type (ADV_IND...), ChSel, TxAdd/RxAdd (public or random addresses) and the payload length. HCI turns it into the event type and address type fields.' },
    { label: 'AdvA + AdvData', bytes: '…', explain: 'The advertiser\'s address and up to 31 bytes of AD structures (legacy) -- these DO reach us, below.' },
    { label: 'CRC', bytes: '?? ?? ??', explain: '24-bit CRC. A bad one and the controller drops the packet -- so we only ever see good packets. Not visible over HCI.' },
  ];

  // ---- the tree: node = { label, start, len, value, explain, layer, real, children, field? (telemetry field), tv? }
  let seq = 0;
  const node = (label, start, len, value, explain, layer, real, extra) => Object.assign({ id: 'n' + (++seq), label, start, len, value, explain: explain || '', layer, real, children: [] }, extra || {});

  function adChildren(t, b, s, len, real) {   // decode inside one AD structure's data (b = whole buffer, s = data start)
    const out = [], d = i => b[s + i], N = (...a) => { const n = node(...a.slice(0, 6), real, a[6]); out.push(n); return n; };
    if (t === 0x01 && len >= 1) {
      const f = d(0), bits = ['LE Limited Discoverable', 'LE General Discoverable', 'BR/EDR (Classic) not supported', 'LE + BR/EDR at once (controller)', 'LE + BR/EDR at once (host)'];
      N('Flag bits', s, 1, bits.filter((_, i) => f >> i & 1).join(', ') || 'none', 'Bit 0 limited, bit 1 general discoverable, bit 2 = "LE only".', 'dec');
    } else if (t >= 0x02 && t <= 0x07) {
      const w = t <= 3 ? 2 : t <= 5 ? 4 : 16;
      for (let i = 0; i + w <= len; i += w) {
        const v = w === 16 ? Array.from(b.slice(s + i, s + i + 16)).reverse().map(x => hx(x)).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-') : '0x' + Array.from(b.slice(s + i, s + i + w)).reverse().map(x => hx(x)).join('');
        N('Service UUID', s + i, w, v, 'Little-endian on the air: the bytes appear reversed.', 'dec');
      }
    } else if (t === 0x08 || t === 0x09 || t === 0x30) {
      N('Name', s, len, '"' + new TextDecoder().decode(b.slice(s, s + len)) + '"', 'UTF-8 text.', 'dec');
    } else if (t === 0x0A && len >= 1) {
      N('TX power', s, 1, `${s8(d(0))} dBm`, 'Signed byte.', 'dec');
    } else if (t === 0x19 && len >= 2) {
      N('Appearance', s, 2, '0x' + hx(le16(b, s), 4), 'Little-endian: the low byte comes first.', 'dec');
    } else if (t === 0xFF && len >= 2) {
      const cid = le16(b, s);
      N('Company ID', s, 2, `0x${hx(cid, 4)} = ${company(cid)}`, 'Little-endian: 4C 00 on the air is 0x004C, Apple.', 'dec', { quiz: 'company' });
      if (cid === 0x004C && len >= 25 && d(2) === 0x02 && d(3) === 0x15) {
        N('iBeacon type', s + 2, 1, '0x02', 'Apple\'s sub-type for iBeacon.', 'dec');
        N('iBeacon length', s + 3, 1, '21 (0x15)', 'The 21 bytes that follow.', 'dec');
        const u = Array.from(b.slice(s + 4, s + 20)).map(x => hx(x)).join('');
        N('Proximity UUID', s + 4, 16, `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20)}`.toLowerCase(), 'Who the beacon belongs to -- big-endian here, unlike most of BLE.', 'dec');
        N('Major', s + 20, 2, be16(b, s + 20), 'A group number, big-endian.', 'dec');
        N('Minor', s + 22, 2, be16(b, s + 22), 'The beacon within the group, big-endian.', 'dec');
        N('Measured power', s + 24, 1, `${s8(d(24))} dBm`, 'The RSSI expected at 1 m -- for estimating distance.', 'dec');
      } else if (len > 2) N('Company data', s + 2, len - 2, toHex(b.slice(s + 2, s + len)), 'The company\'s own format.', 'dec');
    } else if (t === 0x16 && len >= 2) {
      const uu = le16(b, s), p = s + 2, pl = len - 2;
      N('Service UUID', s, 2, `0x${hx(uu, 4)}`, 'Which service this data is for (little-endian).', 'dec');
      if (uu === 0xFEAA && pl >= 1) {
        const fr = b[p];
        N('Eddystone frame', p, 1, { 0: 'UID', 0x10: 'URL', 0x20: 'TLM (telemetry)', 0x30: 'EID' }[fr] || '0x' + hx(fr), 'Google\'s Eddystone: 00 UID, 10 URL, 20 TLM.', 'dec');
        if (fr === 0x00 && pl >= 18) {
          N('TX power at 0 m', p + 1, 1, `${s8(b[p + 1])} dBm`, '', 'dec');
          N('Namespace', p + 2, 10, toHex(b.slice(p + 2, p + 12), ''), 'Who the beacon belongs to.', 'dec');
          N('Instance', p + 12, 6, toHex(b.slice(p + 12, p + 18), ''), 'Which beacon.', 'dec');
        } else if (fr === 0x20 && pl >= 14) {
          N('Battery', p + 2, 2, `${be16(b, p + 2)} mV`, 'Big-endian.', 'dec', { tf: 'batt_mv', tv: be16(b, p + 2) });
          N('Temperature', p + 4, 2, `${(s16(be16(b, p + 4)) / 256).toFixed(2)} °C`, 'Signed 8.8 fixed point.', 'dec', { tf: 'temp', tv: s16(be16(b, p + 4)) / 256 });
        }
      } else if (uu === 0xFCD2 && pl >= 1) {
        const info = b[p];
        N('BTHome device info', p, 1, `v${info >> 5}${info & 1 ? ', encrypted' : ''}${info & 4 ? ', trigger-based' : ''}`, 'Bits 5-7 version, bit 0 encryption, bit 2 sends on events.', 'dec');
        const OBJ = { 0x00: ['Packet id', 1, 0, 1], 0x01: ['Battery', 1, 0, 1, '%', 'batt'], 0x02: ['Temperature', 2, 1, 0.01, '°C', 'temp'], 0x03: ['Humidity', 2, 0, 0.01, '%', 'hum'],
          0x0C: ['Voltage', 2, 0, 0.001, 'V', 'volt'], 0x2E: ['Humidity', 1, 0, 1, '%', 'hum'], 0x45: ['Temperature', 2, 1, 0.1, '°C', 'temp'], 0x11: ['Opening', 1, 0, 1, '', 'opening'],
          0x1A: ['Door', 1, 0, 1, '', 'door'], 0x21: ['Motion', 1, 0, 1, '', 'motion'], 0x2D: ['Window', 1, 0, 1, '', 'window'], 0x04: ['Pressure', 3, 0, 0.01, 'hPa', 'pressure'], 0x12: ['CO2', 2, 0, 1, 'ppm', 'co2'] };
        for (let i = 1; i < pl && !(info & 1);) {
          const o = OBJ[b[p + i]]; if (!o) { N('Unknown object', p + i, pl - i, '0x' + hx(b[p + i]), 'An object id this page doesn\'t know -- its length can\'t be known, so decoding stops.', 'dec'); break; }
          let v = 0; for (let k = o[1] - 1; k >= 0; k--) v = v * 256 + b[p + i + 1 + k];
          if (o[2]) v = o[1] === 1 ? s8(v) : s16(v);
          const val = Math.round(v * o[3] * 1000) / 1000;
          N(o[0], p + i, 1 + o[1], `${val} ${o[4] || ''}`.trim(), `Object id 0x${hx(b[p + i])}, then ${o[1]} byte${o[1] > 1 ? 's' : ''} little-endian${o[3] !== 1 ? `, × ${o[3]}` : ''}.`, 'dec', o[5] ? { tf: o[5], tv: val } : null);
          i += 1 + o[1];
        }
      } else if (uu === 0x181A && (pl === 13 || pl >= 15)) {
        N('MAC (inside the data)', p, 6, addrStr(b, p), 'The custom firmware repeats the sensor\'s address.', 'dec');
        if (pl === 13) {
          N('Temperature', p + 6, 2, `${s16(be16(b, p + 6)) / 10} °C`, 'ATC1441 format: big-endian, × 0.1.', 'dec', { tf: 'temp', tv: s16(be16(b, p + 6)) / 10 });
          N('Humidity', p + 8, 1, `${b[p + 8]} %`, '', 'dec', { tf: 'hum', tv: b[p + 8] });
          N('Battery', p + 9, 1, `${b[p + 9]} %`, '', 'dec', { tf: 'batt', tv: b[p + 9] });
          N('Battery voltage', p + 10, 2, `${be16(b, p + 10)} mV`, '', 'dec', { tf: 'batt_mv', tv: be16(b, p + 10) });
        } else {
          N('Temperature', p + 6, 2, `${s16(le16(b, p + 6)) / 100} °C`, 'pvvx format: little-endian, × 0.01.', 'dec', { tf: 'temp', tv: s16(le16(b, p + 6)) / 100 });
          N('Humidity', p + 8, 2, `${le16(b, p + 8) / 100} %`, 'Little-endian, × 0.01.', 'dec', { tf: 'hum', tv: le16(b, p + 8) / 100 });
          N('Battery voltage', p + 10, 2, `${le16(b, p + 10)} mV`, '', 'dec', { tf: 'batt_mv', tv: le16(b, p + 10) });
          N('Battery', p + 12, 1, `${b[p + 12]} %`, '', 'dec', { tf: 'batt', tv: b[p + 12] });
          N('Counter', p + 13, 1, b[p + 13], 'Goes up with each new measurement -- compare two packets in Diff.', 'dec');
        }
      } else if (pl) N('Service data', p, pl, toHex(b.slice(p, p + len - 2)), '', 'dec');
    }
    for (const cd of customs) { try { cd.nodes(t, b, s, len, real).forEach(n => out.push(n)); } catch {} }
    return out;
  }
  // AD structures: [length][type][data...], repeated. A length of 0 ends the list early.
  function adStructs(b, start, len, real) {
    const out = [];
    for (let i = start; i < start + len;) {
      const l = b[i]; if (!l) { if (i < start + len) out.push(node('Padding', i, start + len - i, '', 'Zero length = no more structures.', 'ad', real)); break; }
      if (i + 1 + l > start + len) { out.push(node('Truncated structure', i, start + len - i, '', 'The length runs past the end of the data -- a broken packet.', 'ad', real)); break; }
      const t = b[i + 1], ad = node(adName(t), i, 1 + l, `${l - 1} data byte${l - 1 === 1 ? '' : 's'}`, (AD_TYPES[t] || [])[1] || '', 'ad', real, { adType: t });
      ad.children.push(node('Length', i, 1, l, 'How many bytes follow: the type byte plus the data.', 'ad', real, { quiz: 'length' }));
      ad.children.push(node('AD type', i + 1, 1, `0x${hx(t)} = ${adName(t)}`, 'What the data means (Bluetooth SIG assigned number).', 'ad', real, { quiz: 'adtype' }));
      if (l > 1) ad.children.push(...adChildren(t, b, i + 2, l - 1, real));
      out.push(ad);
      i += 1 + l;
    }
    return out;
  }

  // ---- one HCI LE Advertising Report event (bytes start with the H4 type 04): -> { bytes, tree, reports, real }
  function dissect(bytes, opts = {}) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), real = opts.real !== false;
    const tree = [], reports = [];
    if (b[0] !== 0x04 || b[1] !== 0x3E || b.length < 5) return { bytes: b, tree: [node('Not an LE advertising report', 0, b.length, toHex(b), '', 'hci', real)], reports, real };
    const sub = b[3];
    const hci = node('HCI event', 0, Math.min(b.length, 3 + b[2]), sub === 0x02 ? 'LE Advertising Report' : sub === 0x0D ? 'LE Extended Advertising Report' : 'LE meta event', 'What the Bluetooth controller tells the computer: one advertisement it heard.', 'hci', real);
    hci.children.push(node('H4 packet type', 0, 1, '0x04 = event', 'On a UART link (the Pi\'s onboard chip) each HCI packet starts with its type: 01 command, 02 ACL data, 04 event.', 'hci', real));
    hci.children.push(node('Event code', 1, 1, '0x3E = LE meta event', 'All LE (low energy) events share 0x3E and say which one in the next-but-one byte.', 'hci', real));
    hci.children.push(node('Parameter length', 2, 1, b[2], 'Bytes in the rest of the event.', 'hci', real));
    hci.children.push(node('Subevent', 3, 1, sub === 0x02 ? '0x02 = advertising report (legacy)' : '0x0D = extended advertising report (Bluetooth 5)', 'Legacy reports are the classic 31-byte adverts; extended ones are Bluetooth 5\'s longer, multi-PHY kind.', 'hci', real));
    hci.children.push(node('Number of reports', 4, 1, b[4], 'Usually 1.', 'hci', real));
    tree.push(hci);
    let i = 5;
    for (let r = 0; r < b[4] && i < b.length; r++) {
      const rep = { legacy: sub === 0x02 }, R = node(`Report ${r + 1}`, i, 0, '', '', 'rep', real);
      const add = (label, len, value, explain, extra) => { const n = node(label, i, len, value, explain, 'rep', real, extra); R.children.push(n); i += len; return n; };
      if (sub === 0x02) {
        const et = b[i]; rep.evt = (LEGACY_EVT[et] || ['?'])[0];
        add('Event type', 1, `${et} = ${rep.evt}`, (LEGACY_EVT[et] || ['', ''])[1], { quiz: 'pdu' });
      } else {
        const et = le16(b, i), bits = [];
        if (et & 1) bits.push('connectable'); if (et & 2) bits.push('scannable'); if (et & 4) bits.push('directed'); if (et & 8) bits.push('scan response'); if (et & 16) bits.push('legacy PDU');
        rep.evt = et & 16 ? ({ 0x13: 'ADV_IND', 0x15: 'ADV_DIRECT_IND', 0x12: 'ADV_SCAN_IND', 0x10: 'ADV_NONCONN_IND', 0x1B: 'SCAN_RSP', 0x1A: 'SCAN_RSP' }[et & 0x1F] || 'legacy') : 'ADV_EXT_IND';
        rep.legacy = !!(et & 16); rep.ext = !(et & 16);
        add('Event type', 2, `0x${hx(et, 4)}: ${bits.join(', ') || 'non-connectable'} (${rep.evt})`, 'Bit flags: connectable, scannable, directed, scan response, legacy. Bits 5-6 = data status (complete / more to come / truncated).', { quiz: 'pdu' });
      }
      const at = b[i]; rep.addrType = ADDR_TYPE[at] || '?';
      add('Address type', 1, `${at} = ${rep.addrType}`, 'Public = from the maker; random = see the address\'s top two bits.', { quiz: 'addrtype' });
      rep.addr = addrStr(b, i);
      const top = b[i + 5] >> 6;
      rep.addrKind = at === 0 || at === 2 ? 'public' : randomKind(top);
      rep.addrStart = i;
      add('Address', 6, rep.addr, `Sent LSB first, so the bytes are reversed. This one is ${KIND_TXT[rep.addrKind]}.` + (at === 1 ? ` Its top two bits are ${top.toString(2).padStart(2, '0')}.` : ''), { quiz: 'addr', mask: rep.addrKind === 'rpa' || rep.addrKind === 'nrpa' });
      let dlen;
      if (sub === 0x0D) {
        rep.phy1 = PHY[b[i]] || '?'; add('Primary PHY', 1, rep.phy1, 'The radio mode on the advertising channels: 1M, or Coded for long range (4x the range, 1/8 the speed).', { quiz: 'phy' });
        rep.phy2 = PHY[b[i]] || '?'; add('Secondary PHY', 1, rep.phy2, 'Where the rest of an extended advert travels (an auxiliary packet on a data channel).');
        add('Advertising SID', 1, b[i] === 0xFF ? 'none' : b[i], 'Tells apart several advertising sets from one device.');
        rep.tx = s8(b[i]); add('TX power', 1, b[i] === 127 ? 'not given' : `${rep.tx} dBm`, '');
        rep.rssi = s8(b[i]); add('RSSI', 1, `${rep.rssi} dBm`, 'Received signal strength: closer to 0 = louder.', { quiz: 'rssi' });
        add('Periodic interval', 2, le16(b, i) ? `${le16(b, i) * 1.25} ms` : 'none', '');
        add('Direct address type', 1, b[i], ''); add('Direct address', 6, addrStr(b, i), 'Only for directed adverts.');
        dlen = b[i]; add('Data length', 1, dlen, '');
      } else { dlen = b[i]; add('Data length', 1, dlen, 'Up to 31 bytes of AD structures in a legacy advert.'); }
      rep.dataStart = i; rep.dataLen = dlen; rep.data = b.slice(i, i + dlen);
      const D = node('Advertising data', i, dlen, `${dlen} bytes of AD structures`, 'The part the device chose to say: a run of [length][type][data] structures.', 'ad', real);
      D.children = adStructs(b, i, dlen, real); R.children.push(D); i += dlen;
      if (sub === 0x02) { rep.rssi = s8(b[i]); add('RSSI', 1, `${rep.rssi} dBm`, 'Received signal strength: closer to 0 = louder. Signed byte.', { quiz: 'rssi' }); }
      R.len = i - R.start; R.value = `${rep.evt} from ${rep.addr}`;
      tree.push(R); reports.push(rep);
    }
    return { bytes: b, tree, reports, real };
  }

  // ---- reconstruct an HCI legacy report from a parsed record (BlueZ / node / demo): real = false everywhere
  function fromRecord(r) {
    const ad = [], push = (t, d) => { if (d.length + 2 + ad.length <= 251) ad.push(d.length + 1, t, ...d); };
    if (r.nm) push(0x09, [...new TextEncoder().encode(r.nm)].slice(0, 29));
    if (r.tx != null) push(0x0A, [r.tx & 0xFF]);
    const u16 = (r.u || []).filter(u => /^[0-9a-f]{4}$/.test(u));
    if (u16.length) push(0x03, u16.flatMap(u => [parseInt(u.slice(2), 16), parseInt(u.slice(0, 2), 16)]));
    for (const [u, h] of Object.entries(r.s || {})) if (/^[0-9a-f]{4}$/.test(u)) push(0x16, [parseInt(u.slice(2), 16), parseInt(u.slice(0, 2), 16), ...fromHex(h)]);
    for (const [c, h] of Object.entries(r.m || {})) push(0xFF, [+c & 0xFF, (+c >> 8) & 0xFF, ...fromHex(h)]);
    const addr = String(r.a || '00:00:00:00:00:00').split(':').map(x => parseInt(x, 16)).reverse();
    const at = r.at === 'random' || (r.at == null && (addr[5] >> 6) === 1) ? 1 : 0;
    const body = [0x02, 1, 3, at, ...addr, ad.length, ...ad, (r.r | 0) & 0xFF];
    return dissect([0x04, 0x3E, body.length, ...body], { real: false });
  }

  // ---- privacy: rotating addresses of unregistered devices are masked (UI shows ••, exports zeros)
  function masked(diss, keep) {
    const b = Uint8Array.from(diss.bytes);
    for (const r of diss.reports) if ((r.addrKind === 'rpa' || r.addrKind === 'nrpa') && !(keep && keep(r))) b.fill(0, r.addrStart, r.addrStart + 6);
    return b;
  }

  // ---- pcap (libpcap, linktype 201 = BLUETOOTH_HCI_H4_WITH_PHDR): opens in Wireshark as HCI H4 events
  function pcap(packets) {   // [{ts (ms), bytes (H4, starting 04)}]
    const parts = [], u32 = (v, a) => { a.push(v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255); };
    const g = []; u32(0xA1B2C3D4, g); g.push(2, 0, 4, 0); u32(0, g); u32(0, g); u32(65535, g); u32(201, g);
    parts.push(...g);
    for (const p of packets) {
      const b = p.bytes, rec = []; const ts = Math.floor(p.ts / 1000), us = (p.ts % 1000) * 1000;
      u32(ts, rec); u32(us, rec); u32(b.length + 4, rec); u32(b.length + 4, rec);
      rec.push(0, 0, 0, 1);   // direction, big-endian: 1 = received (controller -> host)
      parts.push(...rec, ...b);
    }
    return Uint8Array.from(parts);
  }

  // ---- diff two packets' advertising data, byte by byte
  function diff(a, b) {
    const n = Math.max(a.length, b.length), out = [];
    for (let i = 0; i < n; i++) out.push({ i, a: a[i], b: b[i], same: a[i] === b[i] });
    return out;
  }

  // ---- custom decoders (no code): { name, company (number) | uuid ('181a'), fields: [{ n, off, type, scale, unit, tf }] }
  const TYPES = { u8: [1, (b, i) => b[i]], s8: [1, (b, i) => s8(b[i])], u16le: [2, le16], s16le: [2, (b, i) => s16(le16(b, i))], u16be: [2, be16],
    s16be: [2, (b, i) => s16(be16(b, i))], u32le: [4, (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0], s32le: [4, (b, i) => b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24] };
  const customs = [];
  function customDecoder(spec) {
    const fields = (spec.fields || []).filter(f => TYPES[f.type] && f.n);
    const read = data => { const val = {}; for (const f of fields) { const [w, rd] = TYPES[f.type]; if (+f.off + w <= data.length) val[f.tf || f.n] = Math.round(rd(data, +f.off) * (+f.scale || 1) * 1000) / 1000; } return val; };
    const pick = rec => spec.company != null && spec.company !== '' ? (rec.m || {})[String(+spec.company)] : (rec.s || {})[String(spec.uuid || '').toLowerCase()];
    return {
      spec,
      // for ble.js KellyBle.custom: rec -> { kind, val } | null
      decode(rec) { const h = pick(rec); if (!h) return null; const val = read(fromHex(h)); return Object.keys(val).length ? { kind: 'custom', custom: spec.name, val } : null; },
      // for the Inspector tree: inside the AD structure it matches
      nodes(t, b, s, len, real) {
        let p, pl;
        if (t === 0xFF && spec.company !== '' && spec.company != null && len >= 2 && le16(b, s) === +spec.company) { p = s + 2; pl = len - 2; }
        else if (t === 0x16 && spec.uuid && len >= 2 && hx(le16(b, s), 4).toLowerCase() === String(spec.uuid).toLowerCase()) { p = s + 2; pl = len - 2; }
        else return [];
        return fields.filter(f => +f.off + TYPES[f.type][0] <= pl).map(f => {
          const v = Math.round(TYPES[f.type][1](b, p + +f.off) * (+f.scale || 1) * 1000) / 1000;
          return node(`${f.n} (your decoder "${spec.name}")`, p + +f.off, TYPES[f.type][0], `${v} ${f.unit || ''}`.trim(), `${f.type} at offset ${f.off}${+f.scale && +f.scale !== 1 ? ` × ${f.scale}` : ''}.`, 'dec', real, f.tf ? { tf: f.tf, tv: v } : null);
        });
      },
    };
  }
  function setCustom(list) { customs.length = 0; (list || []).forEach(s => customs.push(customDecoder(s))); return customs; }

  // ---- walk every node
  function walk(tree, fn, depth = 0) { for (const n of tree) { fn(n, depth); walk(n.children, fn, depth + 1); } }
  const flat = tree => { const o = []; walk(tree, n => o.push(n)); return o; };

  // ---- BLEdex: what kinds of thing a packet shows -- categories only, never who
  function categories(diss) {
    const out = new Set();
    for (const r of diss.reports) {
      out.add('pdu:' + r.evt); out.add('addr:' + r.addrKind);
      if (r.ext) out.add('ext:advertising'); if (r.phy1) out.add('phy:' + r.phy1); if (r.phy2 && r.phy2 !== 'none') out.add('phy:' + r.phy2);
    }
    walk(diss.tree, n => {
      if (n.adType != null) out.add('ad:' + adName(n.adType));
      if (n.label === 'Company ID') out.add('company:' + String(n.value).split('= ')[1]);
      if (n.label === 'Proximity UUID') out.add('kind:iBeacon');
      if (n.label === 'Eddystone frame') out.add('kind:Eddystone ' + n.value);
      if (n.label === 'BTHome device info') out.add('kind:BTHome');
      if (n.label === 'MAC (inside the data)') out.add('kind:Xiaomi custom firmware');
    });
    return [...out];
  }
  const BADGES = [
    { id: 'first', icon: '📡', name: 'First contact', desc: 'Your first packet in the Inspector', test: s => s.packets >= 1 },
    { id: 'ten', icon: '🔟', name: 'Ten kinds', desc: '10 different things in the BLEdex', test: s => s.kinds >= 10 },
    { id: 'thirty', icon: '🏅', name: 'Collector', desc: '30 different things in the BLEdex', test: s => s.kinds >= 30 },
    { id: 'ibeacon', icon: '🍏', name: 'Beacon spotter', desc: 'An iBeacon', test: s => s.has('kind:iBeacon') },
    { id: 'eddystone', icon: '🔗', name: 'Eddystone', desc: 'A Google Eddystone frame', test: s => s.hasPrefix('kind:Eddystone') },
    { id: 'bthome', icon: '🌡️', name: 'Sensor whisperer', desc: 'A BTHome sensor', test: s => s.has('kind:BTHome') },
    { id: 'rpa', icon: '🎭', name: 'Masked ball', desc: 'A rotating private address (and you can\'t see whose)', test: s => s.has('addr:rpa') },
    { id: 'static', icon: '🗿', name: 'Steady', desc: 'A random static address', test: s => s.has('addr:static') },
    { id: 'scanrsp', icon: '💬', name: 'Asked and answered', desc: 'A scan response', test: s => s.has('pdu:SCAN_RSP') },
    { id: 'ext', icon: '📜', name: 'Bluetooth 5', desc: 'An extended advertisement', test: s => s.has('ext:advertising') },
    { id: 'coded', icon: '🛰️', name: 'Long range', desc: 'A Coded PHY packet (rare!)', test: s => s.has('phy:LE Coded (long range)') },
    { id: 'twom', icon: '⚡', name: 'Fast lane', desc: 'An LE 2M packet', test: s => s.has('phy:LE 2M') },
    { id: 'companies', icon: '🏭', name: 'Who\'s who', desc: '5 different companies', test: s => s.count('company:') >= 5 },
    { id: 'mesh', icon: '🕸️', name: 'Mesh', desc: 'A Bluetooth Mesh packet', test: s => s.has('ad:Mesh message') || s.has('ad:Mesh beacon') },
    { id: 'auracast', icon: '🎧', name: 'Auracast', desc: 'An LE Audio broadcast name', test: s => s.has('ad:Broadcast name') },
  ];

  // ---- Packet Quiz: a question about a (masked) packet. Levels follow the Australian licence grades.
  const LEVELS = [['Foundation', 0], ['Standard', 60], ['Advanced', 160]];
  const level = pts => LEVELS.filter(l => pts >= l[1]).pop()[0];
  function quiz(diss, rnd = Math.random) {
    const nodes = flat(diss.tree), qs = [];
    const comp = nodes.find(n => n.quiz === 'company');
    if (comp) qs.push({ kind: 'bytes', q: 'Click the two bytes that are the company ID.', answer: [comp.start, comp.len], explain: comp.explain, pts: 15 });
    const adt = nodes.filter(n => n.quiz === 'adtype');
    if (adt.length) {
      const n = adt[Math.floor(rnd() * adt.length)], right = adName(diss.bytes[n.start]);
      const wrong = Object.values(AD_TYPES).map(x => x[0]).filter(x => x !== right).sort(() => rnd() - 0.5).slice(0, 3);
      const choices = [right, ...wrong].sort(() => rnd() - 0.5);
      qs.push({ kind: 'choice', q: `The highlighted byte is 0x${hx(diss.bytes[n.start])}. What AD type is it?`, highlight: [n.start, 1], choices, answer: choices.indexOf(right), explain: (AD_TYPES[diss.bytes[n.start]] || ['', ''])[1], pts: 10 });
    }
    const pdu = nodes.find(n => n.quiz === 'pdu'), rep = diss.reports[0];
    if (pdu && rep && rep.legacy) {
      const names = ['ADV_IND', 'ADV_DIRECT_IND', 'ADV_SCAN_IND', 'ADV_NONCONN_IND', 'SCAN_RSP'];
      qs.push({ kind: 'choice', q: 'What kind of advertisement is this (look at the event type byte)?', highlight: [pdu.start, pdu.len], choices: names, answer: names.indexOf(rep.evt), explain: (Object.values(LEGACY_EVT).find(x => x[0] === rep.evt) || ['', ''])[1], pts: 10 });
    }
    if (rep) {
      const kinds = ['public', 'static', 'rpa', 'nrpa'], labels = ['Public (from the maker)', 'Random static', 'Resolvable private (rotates)', 'Non-resolvable private'];
      qs.push({ kind: 'choice', q: 'What kind of address is this? (Address type byte, then the top two bits of the last address byte.)', highlight: [rep.addrStart - 1, 7], choices: labels, answer: kinds.indexOf(rep.addrKind), explain: 'Random addresses: top bits 11 static, 01 resolvable private, 00 non-resolvable.', pts: 20 });
      const rs = nodes.find(n => n.quiz === 'rssi');
      if (rs) qs.push({ kind: 'bytes', q: 'Click the RSSI byte.', answer: [rs.start, 1], explain: rs.explain, pts: 10 });
    }
    const len = nodes.filter(n => n.quiz === 'length');
    if (len.length) { const n = len[Math.floor(rnd() * len.length)]; qs.push({ kind: 'choice', q: `This AD structure's length byte is 0x${hx(diss.bytes[n.start])}. How many bytes of data follow the type byte?`, highlight: [n.start, 1], choices: [diss.bytes[n.start] - 1, diss.bytes[n.start], diss.bytes[n.start] + 1, diss.bytes[n.start] - 2].map(String), answer: 0, explain: 'The length counts the type byte too, so the data is one less.', pts: 15 }); }
    if (!qs.length) return null;
    const q = qs[Math.floor(rnd() * qs.length)];
    if (q.kind === 'choice' && q.answer !== 0) return q;
    if (q.kind === 'choice') {   // shuffle so the right answer isn't always first
      const right = q.choices[0], ch = q.choices.slice().sort(() => rnd() - 0.5);
      return Object.assign({}, q, { choices: ch, answer: ch.indexOf(right) });
    }
    return q;
  }

  return { dissect, fromRecord, adStructs, masked, pcap, diff, customDecoder, setCustom, customs, categories, BADGES, quiz, LEVELS, level,
    walk, flat, AD_TYPES, adName, LEGACY_EVT, ADDR_TYPE, PHY, LINK_LAYER, KIND_TXT, company, fromHex, toHex, addrStr };
});
