/* Kelly Page -- a simulated MeshCore repeater / room server on its USB serial text CLI, for the LoRa Mesh page's
 * "Set up a node over USB" card (js/meshsetup.js: the Demo node button) and tests/meshsetup-tests.html. Nothing is
 * transmitted.
 *
 * Byte for byte as firmware v1.18.0 talks on its USB port (MeshCore repeater-v1.18.0 / room-server-v1.18.0 tags):
 *   examples/simple_repeater/main.cpp loop(): 115200 baud; each byte but '\n' is echoed as it arrives and kept, a
 *     '\r' ends the line ('\n' is dropped, so "\r\n" works too; 159 bytes max, a full buffer counts as a line); then
 *     '\n', and the reply (if any) as "  -> <reply>\r\n". An empty reply (reboot) prints nothing more.
 *   Boot banner "Repeater ID: <64 hex>" (room server: "Room ID: ...").
 *   src/helpers/CommonRadioPrefs.cpp: get/set radio ("> 923.125,62.5,8,5"; set takes freq,bw,sf,cr in one go,
 *     "OK - reboot to apply" or "Error, invalid params"), get/set tx, path.hash.mode (0-2), multi.acks.
 *   src/helpers/CommonCLI.cpp: ver ("v1.18.0 (Build: 15 Oct 2026)"), board, get role, get/set name (no []\:,?*),
 *     owner.info ('|' = new line), guest.password, lat, lon (StrHelper::ftoa: float, 7 digits, zeros trimmed),
 *     advert.interval (minutes: 0 or 60-240, kept /2), flood.advert.interval (hours: 0 or 3-168), "password X"
 *     (answers "password now: X" -- the password echoed back), reboot (no answer), unknown get "??: x",
 *     unknown set "unknown config: x", anything else "Unknown command".
 * The node: the veranda Solar Node repeater of js/meshcoresim.js ("VK4XXX Veranda Rptr", admin "password" as shipped),
 * on the club's radio settings, before the MBUG changes (1-byte path hashes, flood advert 47 h, multi-acks off).
 *
 * KellyMeshCliSim.create(opts) -> sim
 *   opts: { role: 'repeater' | 'room_server', board ('Seeed SenseCap Solar'), prefs: {...} overrides,
 *           sched(fn, ms) -> cancel, faults: { silent (no CLI: a companion node's firmware), garble 0..1 } }
 *   sim.onData(cb)    cb(Uint8Array) for each burst the node prints
 *   sim.write(bytes)  bytes (Uint8Array or string) typed at it
 *   sim.prefs         its settings (tests); sim.lines() what it has run; sim.reboots; sim.stop()
 */
(function (root) {
  'use strict';
  const enc = new TextEncoder(), dec = new TextDecoder();
  const KEY = '7a3e0c51d2b94f6880a1c6e2f4d9b3a5c8e17f2046b9d3a1e5c7f0b2d4a6c8e0';
  const DEFAULTS = { name: 'VK4XXX Veranda Rptr', owner: '', lat: -27.6257, lon: 152.7666, freq: 923.125, bw: 62.5, sf: 8, cr: 5, tx: 22,
    password: 'password', guest: '', advert: 0, flood: 47, hash: 0, macks: 0, repeat: 'on' };

  // StrHelper::ftoa: the value as a 32-bit float, 7 fraction digits TRUNCATED, trailing zeros trimmed (at least one)
  function ftoa(v) {
    const f = Math.fround(v); if (f === 0) return '0.0';
    const neg = f < 0, a = Math.abs(f), ip = Math.floor(a); let fr = a - ip, s = '';
    for (let i = 0; i < 7; i++) { fr *= 10; const d = Math.floor(fr + 1e-9); s += d; fr -= d; }
    s = s.replace(/0+$/, '') || '0';
    return (neg ? '-' : '') + ip + '.' + s;
  }
  // StrHelper::ftoa3: rounded to 3 decimals, trailing zeros and point trimmed
  const ftoa3 = v => (Math.round(Math.fround(v) * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  const validName = n => !/[[\]\\:,?*]/.test(n);

  function create(opts = {}) {
    const sched = opts.sched || ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
    const faults = opts.faults || {}, role = opts.role || 'repeater', board = opts.board || 'Seeed SenseCap Solar';
    const p = Object.assign({}, DEFAULTS, opts.prefs || {});
    let cb = () => {}, line = '', stopped = false, up = true;
    const ran = [], timers = [];
    const sim = { prefs: p, reboots: 0, onData: f => { cb = f; }, lines: () => ran.slice(), stop: () => { stopped = true; timers.forEach(c => c()); } };
    const later = (fn, ms) => timers.push(sched(() => { if (!stopped) fn(); }, ms));
    function print(s) {
      if (stopped || !up) return;
      let b = enc.encode(s);
      if (faults.garble && Math.random() < faults.garble) b = new Uint8Array([0x3e, 0x05, 0x00, 0x0d, 0xff, ...b]);
      cb(b);
    }
    const banner = () => print(`${role === 'room_server' ? 'Room' : 'Repeater'} ID: ${KEY.toUpperCase()}\r\n`);
    later(banner, 50);

    // CommonRadioPrefs::handleCommand first, then CommonCLI::handleCommand -- the same order and prefix tests
    function handle(c) {
      if (c === 'get radio') return `> ${ftoa(p.freq)},${ftoa3(p.bw)},${p.sf},${p.cr}`;
      if (c.startsWith('set radio ')) {
        const parts = c.slice(10).split(','), f = parseFloat(parts[0]) || 0, bw = parseFloat(parts[1]) || 0, sf = parseInt(parts[2], 10) || 0, cr = parseInt(parts[3], 10) || 0;
        if (f >= 150 && f <= 2500 && sf >= 5 && sf <= 12 && cr >= 5 && cr <= 8 && bw >= 7 && bw <= 500) { Object.assign(p, { freq: f, bw, sf, cr }); return 'OK - reboot to apply'; }
        return 'Error, invalid radio params';
      }
      if (c === 'get freq') return `> ${ftoa(p.freq)}`;
      if (/^get tx( |$)/.test(c)) return `> ${p.tx}`;
      if (c.startsWith('set tx ')) { p.tx = Math.max(-9, Math.min(30, parseInt(c.slice(7), 10) || 0)); return 'OK'; }
      if (c === 'get path.hash.mode') return `> ${p.hash}`;
      if (c.startsWith('set path.hash.mode ')) { const m = parseInt(c.slice(19), 10) || 0; if (m < 3) { p.hash = m; return 'OK'; } return 'Error, must be 0,1, or 2'; }
      if (c === 'get multi.acks') return `> ${p.macks}`;
      if (c.startsWith('set multi.acks ')) { p.macks = (parseInt(c.slice(15), 10) || 0) & 255; return 'OK'; }
      if (c.startsWith('reboot')) { reboot(); return ''; }
      if (c.startsWith('advert')) return 'OK - Advert sent';
      if (c.startsWith('clock')) return '20:50 - 15/5/2024 UTC';
      if (c.startsWith('neighbors')) return '-none-';
      if (c.startsWith('password ')) { p.password = c.slice(9, 9 + 15); return 'password now: ' + p.password; }
      if (c.startsWith('get ')) return get(c.slice(4));
      if (c.startsWith('set ')) return set(c.slice(4));
      if (c.startsWith('ver')) return 'v1.18.0 (Build: 15 Oct 2026)';
      if (c.startsWith('board')) return board;
      return 'Unknown command';
    }
    function get(k) {
      if (k.startsWith('flood.advert.interval')) return `> ${p.flood}`;
      if (k.startsWith('advert.interval')) return `> ${p.advert}`;
      if (k.startsWith('guest.password')) return `> ${p.guest}`;
      if (k.startsWith('name')) return `> ${p.name}`;
      if (k.startsWith('repeat')) return `> ${p.repeat}`;
      if (k.startsWith('lat')) return `> ${ftoa(p.lat)}`;
      if (k.startsWith('lon')) return `> ${ftoa(p.lon)}`;
      if (k.startsWith('owner.info')) return `> ${p.owner.replace(/\n/g, '|')}`;
      if (k.startsWith('public.key')) return `> ${KEY}`;
      if (k.startsWith('role')) return `> ${role}`;
      return `??: ${k}`;
    }
    function set(k) {
      if (k.startsWith('flood.advert.interval ')) { const h = parseInt(k.slice(22), 10) || 0; if ((h > 0 && h < 3) || h > 168) return 'Error: interval range is 3-168 hours'; p.flood = h; return 'OK'; }
      if (k.startsWith('advert.interval ')) { const m = parseInt(k.slice(16), 10) || 0; if ((m > 0 && m < 60) || m > 240) return 'Error: interval range is 60-240 minutes'; p.advert = Math.floor(m / 2) * 2; return 'OK'; }
      if (k.startsWith('guest.password ')) { p.guest = k.slice(15, 15 + 15); return 'OK'; }
      if (k.startsWith('name ')) { if (!validName(k.slice(5))) return 'Error, bad chars'; p.name = k.slice(5, 5 + 31); return 'OK'; }
      if (k.startsWith('repeat ')) { p.repeat = k.slice(7).startsWith('off') ? 'off' : 'on'; return p.repeat === 'off' ? 'OK - repeat is now OFF' : 'OK - repeat is now ON'; }
      if (k.startsWith('lat ')) { p.lat = parseFloat(k.slice(4)) || 0; return 'OK'; }
      if (k.startsWith('lon ')) { p.lon = parseFloat(k.slice(4)) || 0; return 'OK'; }
      if (k.startsWith('owner.info ')) { p.owner = k.slice(11, 11 + 119).replace(/\|/g, '\n'); return 'OK'; }
      if (k.startsWith('freq ')) { p.freq = parseFloat(k.slice(5)) || 0; return 'OK - reboot to apply'; }
      return 'unknown config: ' + k;
    }
    // reboot: the USB port drops at once and the node comes back ~2 s later with its banner
    function reboot() { sim.reboots++; later(() => { up = false; if (sim.onDrop) sim.onDrop(); }, 20); later(() => { up = true; banner(); }, 2000); }

    sim.write = bytes => {
      if (stopped || !up) return;
      const s = typeof bytes === 'string' ? bytes : dec.decode(bytes);
      for (const ch of s) {
        if (faults.silent) continue;   // a companion node: binary frames only, no text CLI
        if (ch !== '\n') { line += ch; print(ch); }
        if (ch === '\r' || line.length >= 159) {
          const cmd = line.replace(/\r$/, ''); line = '';
          print('\n'); ran.push(cmd);
          const reply = handle(cmd);
          if (reply) later(() => print(`  -> ${reply}\r\n`), 5);
        }
      }
    };
    return sim;
  }

  root.KellyMeshCliSim = { create, ftoa, ftoa3, DEFAULTS, KEY };
})(typeof window !== 'undefined' ? window : globalThis);
