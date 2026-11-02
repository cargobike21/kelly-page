/* nrfdfu.js -- Nordic "legacy" serial DFU, as the Adafruit nRF52 bootloader speaks it (RAK4631, SenseCAP ...). A port
 * of adafruit-nrfutil 0.5.3 nordicsemi/dfu/dfu_transport_serial.py + util.py + crc16.py, byte for byte, so Kelly can
 * flash an application image the way `adafruit-nrfutil dfu serial --package x.zip -p COMx -b 115200 --singlebank
 * --touch 1200` does. Pure (UMD): the caller moves the bytes.
 *
 *   KellyDfu.packet(seq, payload)   one HCI packet: 4-byte SLIP header (seq, ack = seq+1, integrity + reliable bits,
 *                                    type 14, 12-bit length, checksum), payload, CRC-16 LE, SLIP-escaped, 0xC0 framed
 *   KellyDfu.unslip(bytes)          0xDB 0xDC -> 0xC0, 0xDB 0xDD -> 0xDB
 *   KellyDfu.crc16(bytes, crc)      CRC-16/CCITT as nrfutil computes it (start 0xFFFF)
 *   KellyDfu.flash(io, bin, dat, onProgress)  the whole update on an open bootloader port:
 *       io = { write(Uint8Array) -> Promise, read(maxMs) -> Promise<Uint8Array|null>, sleep(ms) -> Promise }
 *       start (mode 4 = application, sizes 0 / 0 / bin) -> wait the erase time -> init packet (the .dat + 2 zero
 *       bytes) -> 512-byte data packets (a page-write pause every 8) -> stop. Each packet waits for the bootloader's
 *       ack frame (two 0xC0 within 1 s); no ack = an error, never a silent carry-on.
 *       onProgress({ phase: 'erase' | 'write' | 'done', done, total })
 *
 * The 1200-baud "touch" that drops a running app into the bootloader, and finding the bootloader's new port, are the
 * caller's (Web Serial: js/meshbuddy.js). Bootloader, SoftDevice and SoftDevice+bootloader images are not supported --
 * an application image only, so a mistake can't brick the bootloader.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyDfu = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const INIT = 1, START = 3, DATA = 4, STOP = 5, MODE_APP = 4;
  const PAGE = 4096, PAGE_ERASE_S = 0.0897, PAGE_WRITE_S = (PAGE / 4) * 0.0001, CHUNK = 512, ACK_MS = 1000;

  function crc16(bytes, crc = 0xFFFF) {
    for (const b of bytes) {
      crc = ((crc >> 8) & 0x00FF) | ((crc << 8) & 0xFF00);
      crc ^= b;
      crc ^= (crc & 0x00FF) >> 4;
      crc ^= (crc << 8) << 4;
      crc ^= ((crc & 0x00FF) << 4) << 1;
      crc &= 0xFFFF;
    }
    return crc & 0xFFFF;
  }
  const u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

  function slipHeader(seq, len) {
    const h = [0, 0, 0, 0];
    h[0] = seq | (((seq + 1) % 8) << 3) | (1 << 6) | (1 << 7);   // data integrity check present, reliable packet
    h[1] = 14 | ((len & 0x000F) << 4);                             // HCI packet type 14
    h[2] = (len & 0x0FF0) >> 4;
    h[3] = (~(h[0] + h[1] + h[2]) + 1) & 0xFF;
    return h;
  }
  function packet(seq, payload) {
    const body = slipHeader(seq, payload.length).concat(Array.from(payload));
    const crc = crc16(body);
    body.push(crc & 0xFF, (crc >> 8) & 0xFF);
    const out = [0xC0];
    for (const b of body) { if (b === 0xC0) out.push(0xDB, 0xDC); else if (b === 0xDB) out.push(0xDB, 0xDD); else out.push(b); }
    out.push(0xC0);
    return Uint8Array.from(out);
  }
  function unslip(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c !== 0xDB) { out.push(c); continue; }
      const d = bytes[++i];
      if (d === 0xDC) out.push(0xC0); else if (d === 0xDD) out.push(0xDB); else throw new Error('bad SLIP escape');
    }
    return out;
  }

  function Session(io) {
    let seq = 0;
    async function ack() {
      const buf = [], t0 = Date.now();
      while (buf.filter(b => b === 0xC0).length < 2) {
        const left = ACK_MS - (Date.now() - t0);
        if (left <= 0) break;
        const got = await io.read(left);
        if (got && got.length) buf.push(...got);
      }
      if (buf.filter(b => b === 0xC0).length < 2) throw new Error(buf.length ? 'the bootloader\'s answer was cut short' : 'no answer from the bootloader');
      const i0 = buf.indexOf(0xC0), i1 = buf.indexOf(0xC0, i0 + 1), frame = unslip(buf.slice(i0 + 1, i1));
      return frame.length ? (frame[0] >> 3) & 0x07 : -1;
    }
    async function send(payload) {
      seq = (seq + 1) % 8;
      await io.write(packet(seq, payload));
      return ack();
    }
    return { send };
  }

  async function flash(io, bin, dat, onProgress = () => {}) {
    bin = Uint8Array.from(bin); dat = Uint8Array.from(dat);
    if (!bin.length || bin.length > 0xF4000) throw new Error('not an application image (size)');
    const s = Session(io), total = bin.length;
    // start: application mode, SoftDevice 0, bootloader 0, application size; then the bootloader erases
    await s.send([...u32(START), ...u32(MODE_APP), ...u32(0), ...u32(0), ...u32(total)]);
    const eraseMs = Math.max(500, (Math.floor(total / PAGE) + 1) * PAGE_ERASE_S * 1000);
    onProgress({ phase: 'erase', done: 0, total, ms: eraseMs });
    await io.sleep(eraseMs);
    await s.send([...u32(INIT), ...dat, 0, 0]);
    const n = Math.ceil(total / CHUNK);
    for (let i = 0; i < n; i++) {
      await s.send([...u32(DATA), ...bin.subarray(i * CHUNK, (i + 1) * CHUNK)]);
      if (i % 8 === 0) await io.sleep(PAGE_WRITE_S * 1000);
      onProgress({ phase: 'write', done: Math.min(total, (i + 1) * CHUNK), total });
    }
    await io.sleep(PAGE_WRITE_S * 1000);
    await s.send(u32(STOP));
    await io.sleep((PAGE_ERASE_S + PAGE_WRITE_S) * 1000);   // single bank, no SoftDevice: the activate wait
    onProgress({ phase: 'done', done: total, total });
  }

  return { crc16, packet, unslip, slipHeader, flash, CHUNK, MODE_APP };
});
