/* Kelly Page -- transports. Each one moves a latin-1 string of bytes to and
 * from the radio and calls onData(str) / onState(state, detail).
 *
 *   SerialTransport  Chrome/Edge Web Serial straight to the radio's COM port
 *   SocketTransport  WebSocket to bridge/kelly_bridge.py (serial-over-IP, TCP)
 *   DemoTransport    a simulated Tait TP9400 that speaks real CCDI frames
 */
(function (root) {
  'use strict';
  const C = root.CCDI;
  const toBytes = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF; return u; };
  const fromBytes = u => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return s; };

  class Base {
    constructor() { this.onData = () => {}; this.onState = () => {}; this.connected = false; }
    get label() { return 'transport'; }
  }

  // ---------------------------------------------------------------- serial
  class SerialTransport extends Base {
    static get supported() { return 'serial' in navigator; }
    constructor(opts) { super(); this.opts = opts; this.port = null; this.reader = null; this.closing = false; }
    get label() {
      const i = this.port && this.port.getInfo ? this.port.getInfo() : {};
      return `Serial ${this.opts.baud}${i.usbVendorId ? ` (USB ${i.usbVendorId.toString(16).padStart(4, '0')}:${(i.usbProductId || 0).toString(16).padStart(4, '0')})` : ''}`;
    }
    async open() {
      if (!SerialTransport.supported) throw new Error('Web Serial needs Chrome or Edge (desktop).');
      const granted = this.opts.reuse ? await navigator.serial.getPorts() : [];
      // match {vid, pid}: the remembered USB radio only (Kelly reconnecting by itself -- no click, so no picker)
      const m = this.opts.match, mine = m ? granted.find(p => { const i = p.getInfo(); return i.usbVendorId === m.vid && i.usbProductId === m.pid; }) : granted[0];
      this.port = mine || await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.opts.baud, dataBits: 8, stopBits: 1, parity: 'none',
        flowControl: this.opts.flow === 'hardware' ? 'hardware' : 'none', bufferSize: 4096 });
      this.connected = true; this.closing = false;
      this.onState('open', this.label);
      this.readLoop();
      navigator.serial.addEventListener('disconnect', this._onUnplug = e => { if (e.target === this.port) this.close('unplugged'); });
    }
    async readLoop() {
      while (this.port && this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) this.onData(fromBytes(value));
          }
        } catch (e) { if (!this.closing) this.onState('error', e.message); }
        finally { try { this.reader.releaseLock(); } catch {} }
      }
      // a fatal error (the USB lead's chip reset, the device lost) leaves port.readable null with the port still
      // "open": close it properly, so Kelly sees the link drop and reconnects instead of sitting there deaf
      if (this.port && !this.closing) this.close('serial link lost');
    }
    async write(str) {
      if (!this.port || !this.port.writable) throw new Error('not connected');
      const w = this.port.writable.getWriter();
      try { await w.write(toBytes(str)); } finally { w.releaseLock(); }
    }
    async close(why = 'closed') {
      this.closing = true;
      try { if (this.reader) await this.reader.cancel(); } catch {}
      try { if (this.port) await this.port.close(); } catch {}
      if (this._onUnplug) navigator.serial.removeEventListener('disconnect', this._onUnplug);
      this.port = null; this.connected = false; this.onState('closed', why);
    }
  }

  // ------------------------------------------------------------- websocket
  class SocketTransport extends Base {
    constructor(opts) { super(); this.opts = opts; this.ws = null; }
    get label() { return `IP ${this.opts.url}`; }
    open() {
      return new Promise((resolve, reject) => {
        // an https page can't open ws:// (mixed content): js/secure.js makes it wss://
        const ws = new WebSocket(window.KellySecure ? KellySecure.wsUrl(this.opts.url) : this.opts.url);
        ws.binaryType = 'arraybuffer';
        let opened = false;
        ws.onopen = () => { opened = true; this.ws = ws; this.connected = true; this.onState('open', this.label); resolve(); };
        ws.onmessage = ev => {
          if (typeof ev.data === 'string') {
            // bridge control messages are JSON text frames: {"bridge": "..."}
            try { const j = JSON.parse(ev.data); if (j.bridge) { this.onState('bridge', j); return; } } catch {}
            this.onData(ev.data);
          } else this.onData(fromBytes(new Uint8Array(ev.data)));
        };
        ws.onerror = () => { if (!opened) reject(new Error(`cannot reach bridge at ${this.opts.url}`)); };
        ws.onclose = ev => { this.connected = false; this.ws = null; if (opened) this.onState('closed', ev.reason || 'bridge closed'); };
      });
    }
    async write(str) { if (!this.ws) throw new Error('not connected'); this.ws.send(toBytes(str)); }
    async close() { if (this.ws) this.ws.close(1000, 'client closed'); }
  }

  // ------------------------------------------------------------------ demo
  // A make-believe TP9400 for trying the page without a radio. Every reply is
  // a correctly-framed CCDI message, so it exercises the real parser.
  const DEMO_UNITS = [
    { id: 1050002, call: 'VK4XXX', lat: -27.6261, lon: 152.7660, kind: 'car' },
    { id: 5059102, call: 'VK4ZR', lat: -27.6115, lon: 152.7353, kind: 'home' },
    { id: 5059101, call: 'VK4ZB', lat: -27.4698, lon: 153.0251, kind: 'portable' },
    { id: 5059001, call: 'VK4RBX', lat: -27.6245, lon: 152.7684, kind: 'repeater' },
    { id: 5051234, call: 'VK4XYZ', lat: -27.4560, lon: 152.9300, kind: 'car' },
  ];
  const DEMO_TEXTS = ['Net starting in 5 on TG 101', 'Running late, 10 min', 'Signal report please?', 'Coffee time at the repeater site',
    'Arrived at Mt Coot-tha', 'Monitoring TG 101', 'Kelly says woof', '73 all, QRT for the night'];

  class DemoTransport extends Base {
    constructor(opts = {}) {
      super(); this.opts = opts; this.timers = []; this.mode = 'command';
      this.st = { zone: 1, channel: 12, volume: 12, rssi: -95, tx: false, ccr: false, units: DEMO_UNITS.map(u => Object.assign({ hdg: Math.random() * 360 }, u)) };
    }
    get label() { return 'Demo radio (simulated TP9400)'; }
    async open() {
      this.connected = true; this.onState('open', this.label);
      this.emit('.');
      this.every(1500, () => { this.st.rssi += (Math.random() - 0.5) * 6; this.st.rssi = Math.max(-121, Math.min(-55, this.st.rssi)); });
      this.every(9000, () => this.randomTraffic());
      this.every(6000, () => this.moveUnits());
    }
    async close() { this.timers.forEach(clearInterval); this.timers = []; this.connected = false; this.onState('closed', 'demo stopped'); }
    every(ms, fn) { this.timers.push(setInterval(() => this.connected && fn(), ms)); }
    emit(s, delay = 0) { setTimeout(() => this.connected && this.onData(s), delay); }
    say(ident, params, delay = 40) { this.emit(C.frame(ident, params) + '.', delay); }
    hexId(id) { return id.toString(16).toUpperCase().padStart(6, '0'); }

    async write(str) {
      for (const line of str.split('\r').filter(Boolean)) {
        if (this.mode === 'transparent') { if (/\+\+\+/.test(line)) { this.mode = 'command'; this.emit('.', 2100); } continue; }
        const f = C.splitFrame(line);
        if (!f) continue;
        if (!f.checksumOk) { this.emit('.' + C.frame(this.st.ccr ? '-' : 'e', this.st.ccr ? '02' + f.ident : '002') + (this.st.ccr ? '' : '.'), 30); continue; }
        if (this.st.ccr) { this.ccr(f); continue; }
        this.emit('.', 15);
        this.handle(f.ident, f.params);
      }
    }
    ccr(f) {
      const p = f.params;
      if (f.ident === 'E') { this.st.ccr = false; this.emit(C.frame('+', 'E'), 20); this.say('p', '1F0', 1800); return; }
      if (f.ident === 'Q') { this.emit(C.frame('Q', 'P'), 20); return; }
      if (f.ident === 'U' && p === 'ZE') { this.emit(C.frame('+', 'UZE' + '1A1B0F00' + '1A1B0F00' + '04' + '00' + '80' + '02'), 20); return; }
      if (f.ident === 'U' && p.startsWith('ZN')) { this.emit(C.frame('+', 'UZN' + p[2] + ['99000001', 'TP9400 3.18.04', 'BL 1.07', 'FPGA 2.11', 'HW 0102'][+p[2]]), 20); return; }
      this.emit(C.frame('+', f.ident), 20);
    }
    handle(id, p) {
      const st = this.st;
      switch (id) {
        case 'q':
          if (p === '' || p === '0') this.say('m', '541' + '03.06');
          else if (p === '3') { this.say('v', '00TPAB4E-H200_0101', 40); this.say('v', '01DEMO-3.18.04', 80); this.say('v', '0200.17', 120); this.say('v', '032.11', 160); }
          else if (p === '4') this.say('n', '99000001');
          else if (p === '1') this.say('s', '');
          else if (p.startsWith('2')) this.say('j', '000' + (p[2] === '1' ? '1234' : '4442400000'));
          else if (p === '5047') { this.say('j', '04731', 40); this.say('j', '047512', 90); }
          else if (p === '5063' || p === '5064') this.say('j', p.slice(1) + Math.round(st.rssi * 10));
          else if (p === '5318') this.say('j', '318' + (st.tx ? 389 + Math.round(Math.random() * 20) : 0));
          else if (p === '5319') this.say('j', '319' + (st.tx ? 21 + Math.round(Math.random() * 5) : 0));
          else if (p === '6') this.sayLocation(DEMO_UNITS[0].id, DEMO_UNITS[0], 0);
          break;
        case 'f':
          if (p === '00') { st.ccr = true; this.emit(C.frame('M', 'R'), 60); }
          else if (p === '052') this.chan();
          else if (p.startsWith('02')) st.volume = +p.slice(2);
          else if (p === '91') { st.tx = true; }
          else if (p === '90') { st.tx = false; }
          else if (p === '20' || p === '21') this.say('p', '03');
          else if (p === '22') this.say('p', '04');
          else if (p.startsWith('3')) {
            const key = p.slice(1, 3);
            if (key === '03' || key === '04') { st.channel = Math.max(1, st.channel + (key === '03' ? 1 : -1)); this.chan(); }
          }
          break;
        case 'g': {
          const forced = p.endsWith('f'); const q = forced ? p.slice(0, -1) : p;
          if (q.length === 6) { st.zone = +q.slice(0, 2); st.channel = +q.slice(2); } else st.channel = +q;
          this.chan(); break;
        }
        case 'd':
          if (p.startsWith('21-') || p.startsWith('20-')) this.say('p', '37', 120);
          if (p.startsWith('6')) {
            const [type, target] = p.slice(1).split(',');
            if (['1', '2', '6', '8'].includes(type) && +target !== 0)
              this.say('r', '4700AFF' + this.hexId(+target), 1800 + Math.random() * 1500);   // P25 ack from the target
            if (type === '7') this.say('r', '47008' + '0' + (1 + Math.floor(Math.random() * 6)) + this.hexId(+target), 2000);
          }
          if (p.startsWith('2')) { /* data message */ }
          break;
        case 'l':
          if (p[0] === '2') { const u = st.units.find(x => x.id === +p.slice(2)) || st.units[1]; this.sayLocation(u.id, u, 0, 1500); }
          break;
        case 't': this.mode = 'transparent'; break;
        default: break;
      }
    }
    chan() {
      this.say('p', '210' + String(this.st.zone).padStart(2, '0') + String(this.st.channel).padStart(4, '0'), 60);
      const names = ['P25X Ipswich', 'Repeater East', 'Mt Coot-tha', 'Simplex 438.000', 'Springbrook', 'Toowoomba'];
      this.say('p', '311' + names[this.st.channel % names.length], 110);
    }
    sayLocation(id, u, emergency = 0, delay = 60) {
      const now = new Date();
      const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, '');
      const ddmmyy = now.toISOString().slice(8, 10) + now.toISOString().slice(5, 7) + now.toISOString().slice(2, 4);
      const lat = Math.abs(u.lat), lon = Math.abs(u.lon);
      const latS = String(Math.floor(lat)).padStart(2, '0') + ((lat % 1) * 60).toFixed(4).padStart(7, '0');
      const lonS = String(Math.floor(lon)).padStart(3, '0') + ((lon % 1) * 60).toFixed(4).padStart(7, '0');
      const spd = u.kind === 'car' ? (20 + Math.random() * 40) / 1.852 : 0;
      const rmc = `$GPRMC,${hhmmss},A,${latS},${u.lat < 0 ? 'S' : 'N'},${lonS},${u.lon < 0 ? 'W' : 'E'},${spd.toFixed(1)},${u.hdg.toFixed(1)},${ddmmyy},,`;
      this.say('l', `${emergency}${String(id).padStart(8, '0')}0${rmc}`, delay);
    }
    moveUnits() {
      for (const u of this.st.units) {
        if (u.kind !== 'car' && u.kind !== 'portable') continue;
        u.hdg = (u.hdg + (Math.random() - 0.5) * 40 + 360) % 360;
        const step = u.kind === 'car' ? 0.004 : 0.0006;
        u.lat += Math.cos(u.hdg * Math.PI / 180) * step; u.lon += Math.sin(u.hdg * Math.PI / 180) * step;
      }
      const u = this.st.units[Math.floor(Math.random() * this.st.units.length)];
      this.sayLocation(u.id, u);
    }
    randomTraffic() {
      if (this.st.ccr) return;
      const u = this.st.units[1 + Math.floor(Math.random() * (this.st.units.length - 1))];
      const roll = Math.random();
      if (roll < 0.45) {                      // a voice over on the talkgroup
        this.say('p', '05', 0);
        this.say('r', '40010FF' + this.hexId(u.id), 300);
        this.st.rssi = -70 - Math.random() * 25;
        this.say('p', '06', 3500 + Math.random() * 4000);
      } else if (roll < 0.65) {               // status update
        this.say('r', '47008' + '0' + (1 + Math.floor(Math.random() * 8)) + this.hexId(u.id), 0);
      } else if (roll < 0.85) {               // a text (external data message)
        const hex = C.textToHex(DEMO_TEXTS[Math.floor(Math.random() * DEMO_TEXTS.length)]);
        this.say('r', `47040FF${DEMO_UNITS[0].id}-${u.id}-${hex}`, 0);
      } else if (roll < 0.95) {               // preset message
        this.say('r', '47006' + '0' + (1 + Math.floor(Math.random() * 9)) + this.hexId(u.id), 0);
      } else this.say('r', '47001FF' + this.hexId(u.id), 0);   // call alert
    }
  }

  root.KellyTransports = { SerialTransport, SocketTransport, DemoTransport, DEMO_UNITS };
})(window);
