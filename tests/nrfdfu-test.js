'use strict';
// js/nrfdfu.js (Node): packets byte-identical to adafruit-nrfutil 0.5.3 (tests/nrfdfu-ref.json, made by its own
// HciPacket), and a whole update against a simulated Adafruit bootloader that checks every frame's header checksum
// and CRC, acks it, and rebuilds the image -- which must equal the shipped firmware/mesh-buddy .bin exactly.
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" tests/nrfdfu-test.js
const fs = require('fs'), path = require('path');
const D = require('../js/nrfdfu.js');
let pass = 0, fail = 0;
const ok = (b, what, extra) => { if (b) pass++; else fail++; console.log(`${b ? 'PASS' : 'FAIL'} ${what}${!b && extra != null ? ' -- ' + extra : ''}`); };
const hex = u => Buffer.from(u).toString('hex');

for (const c of JSON.parse(fs.readFileSync(path.join(__dirname, 'nrfdfu-ref.json'), 'utf8'))) {
  const got = hex(D.packet(c.seq, Buffer.from(c.data, 'hex')));
  ok(got === c.out, `packet seq ${c.seq}, ${c.data.length / 2} bytes = nrfutil's`, got);
}
ok(D.crc16([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]) === 0x29B1, 'CRC-16/CCITT-FALSE check value 0x29B1');

// the simulated bootloader: a byte stream in, ack frames out
function Bootloader(opts = {}) {
  let rx = [], out = [], image = [], init = null, started = null, stopped = false, frames = 0, bad = 0;
  function frame(f) {
    const b = D.unslip(f);
    const h = b.slice(0, 4), len = (h[1] >> 4) | (h[2] << 4), body = b.slice(4, 4 + len), crc = b[4 + len] | (b[5 + len] << 8);
    if (((h[0] + h[1] + h[2] + h[3]) & 0xFF) !== 0 || D.crc16(b.slice(0, 4 + len)) !== crc || (h[1] & 0x0F) !== 14) { bad++; return; }
    frames++;
    const op = body[0] | (body[1] << 8) | (body[2] << 16) | (body[3] << 24), rest = body.slice(4);
    if (op === 3) started = { mode: rest[0], app: rest[12] | (rest[13] << 8) | (rest[14] << 16) | (rest[15] << 24) };
    else if (op === 1) init = rest;
    else if (op === 4) image.push(...rest);
    else if (op === 5) stopped = true;
    if (opts.silentAfter != null && frames > opts.silentAfter) return;
    const seq = h[0] & 7, a = ((seq + 1) % 8) << 3;
    out.push(0xC0, a, 0, 0, 0xC0);   // a minimal ack frame: C0 <header byte with the ack number> ... C0
  }
  return {
    io: {
      write: async u => { for (const x of u) { if (x !== 0xC0) rx.push(x); else if (rx.length) { frame(rx); rx = []; } } },   // 0xC0 ends a frame
      read: async () => { const o = Uint8Array.from(out); out = []; return o.length ? o : (await new Promise(r => setTimeout(r, 5)), null); },
      sleep: async () => {},
    },
    state: () => ({ image: Uint8Array.from(image), init, started, stopped, frames, bad }),
  };
}

(async () => {
  const dir = path.join(__dirname, '..', 'firmware', 'mesh-buddy'), meta = JSON.parse(fs.readFileSync(path.join(dir, 'firmware.json'), 'utf8'));
  const bin = fs.readFileSync(path.join(dir, meta.bin)), dat = fs.readFileSync(path.join(dir, meta.dat));
  ok(bin.length === meta.size, `firmware.json size matches the .bin (${bin.length})`);
  ok(require('crypto').createHash('sha256').update(bin).digest('hex') === meta.sha256, 'firmware.json sha256 matches the .bin');
  const B = Bootloader(), phases = new Set();
  await D.flash(B.io, bin, dat, p => phases.add(p.phase));
  const s = B.state();
  ok(s.bad === 0, 'every frame: header checksum + CRC good', s.bad);
  ok(s.started && s.started.mode === 4 && s.started.app === bin.length, 'start: application mode, its size', JSON.stringify(s.started));
  ok(s.init && hex(s.init) === hex(dat) + '0000', 'init packet = the .dat + 2 zero bytes', s.init && hex(s.init));
  ok(s.image.length === bin.length && Buffer.compare(Buffer.from(s.image), bin) === 0, `the bootloader rebuilt the image byte for byte (${s.image.length} bytes)`);
  ok(s.stopped, 'stop packet sent');
  ok(s.frames === 3 + Math.ceil(bin.length / 512), `frames: start + init + ${Math.ceil(bin.length / 512)} data + stop`, s.frames);
  ok(['erase', 'write', 'done'].every(p => phases.has(p)), 'progress: erase, write, done');
  // a bootloader that stops answering: the update fails loudly
  const Q = Bootloader({ silentAfter: 5 });
  let err = null; try { await D.flash(Q.io, bin, dat); } catch (e) { err = e.message; }
  ok(err === 'no answer from the bootloader', 'no ack -> an error, not a silent carry-on', err);
  let e2 = null; try { await D.flash(B.io, new Uint8Array(0), dat); } catch (e) { e2 = e.message; }
  ok(/application image/.test(e2 || ''), 'an empty image is refused', e2);
  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})();
