/* Kelly Page -- Set up a node over USB (LoRa Mesh page; Phase 11 of docs/lora-mesh-gap-analysis.md, 2026-10-23).
 *
 * A MeshCore REPEATER or ROOM SERVER has a plain-text CLI on its USB serial port (a companion node doesn't: it speaks
 * binary frames, and is set up through the page's own link). Kelly reads its settings into a form with `ver`, `board`
 * and `get ...`, shows what would change, then writes only the changed fields, one command at a time, each checked
 * against its reply, and reads everything back to check. The MBUG preset (5.7) goes through the same diff.
 *
 * The CLI, pinned down from MeshCore v1.18.0 (repeater-v1.18.0 tag; js/meshclisim.js has the detail):
 *   115200 baud. A line ends at '\r' ('\n' is ignored). Every byte is echoed, then '\n', then "  -> <reply>\r\n".
 *   get X -> "> value" ("??: X" = this firmware hasn't got it). set X -> "OK..." or an error ("Error...", "ERR...",
 *   "unknown config: X"). get radio -> "> 923.125,62.5,8,5"; set radio takes freq,bw,sf,cr in one command and
 *   answers "OK - reboot to apply" (radio changes need a reboot; `get radio` shows the new values at once).
 *   The ADMIN password can't be read: `password X` sets it and answers "password now: X". `reboot` answers nothing.
 * nRF52 rules (RAK4631, SenseCAP Solar Node): never open at 1200 baud -- that's the "touch" that drops it into the
 * bootloader -- and no RTS toggling; DTR is set on nRF52 ports only (TinyUSB is silent without it), never on ESP32s.
 * Guards: frequency (with its bandwidth) inside 915-928 MHz; TX power capped per board (TX_CAPS); passwords are never
 * logged or kept (masked in the transcript, cleared after writing and on disconnect, never in settings or storage).
 * Flashing isn't built: a link to the official flasher and notes for our boards.
 * ▦ Show this node's QR (QR_REVIEW.md opp. 5, screen only): its contact/add QR from `get public.key` + its name, type 2
 * (repeater) / 3 (room server) / 4 (sensor) from `get role`. Read again after every write's read-back. Kelly NEVER sends
 * `get prv.key` (the node's private key), and the guest / admin passwords never go near the QR.
 *
 * 🌐 Over the bridge (2026-10-25): the same CLI through the Kelly bridge's /mesh WebSocket (the LoRa Mesh page's Mesh
 * bridge address, k.wsUrl()), for a node whose USB is on another machine: `kelly_bridge.py --mesh-serial PORT`, or
 * `--mesh-tcp HOST:PORT` to a serial-to-TCP tunnel (e.g. a Heltec V3 on another PC's COM port, HOST:5555). The bridge
 * only carries bytes; nothing toggles DTR/RTS from here. The page's own node link must not hold that bridge meanwhile.
 * Off unless ms.setup (LoRa Mesh > Mesh sounds & effects > "Node setup over USB").
 * KellyMeshSetup.core: the pure part (link, parse, plan, guards) for tests/meshsetup-tests.html.
 * window.KellyMeshSetup(k) -> { render, init, core }; k from mesh.js: { $, esc, ms, save, toast, addEvent, currentPage,
 *   wsUrl() -> the mesh bridge's ws(s)://…/mesh?token=… URL or '', bridgeBusy() -> true while the page's node link uses it }.
 */
(function (root) {
  'use strict';
  const BAUD = 115200, enc = new TextEncoder();
  const BWS = [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500];
  const BAND = [915, 928];   // MHz: the Australian LIPD class licence band MeshCore uses here (AU915)
  // TX power cap (dBm) by the `board` answer. All three of ours are an SX1262 straight to the antenna, whose top
  // setting is 22. A board we don't know may have a power amplifier after the chip (then the setting isn't the output).
  const TX_CAPS = [[/^Heltec V3/i, 22, 'Heltec V3'], [/^RAK ?4631/i, 22, 'RAK4631'], [/SenseCap Solar/i, 22, 'SenseCAP Solar Node']];
  const TX_CAP_UNKNOWN = 17, TX_MIN = -9;
  const MBUG = { freq: 923.125, bw: 62.5, sf: 8, cr: 5, hash: 1, flood: 83, macks: 1 };
  const HASH = { 0: '1 byte', 1: '2 bytes (MBUG)', 2: '3 bytes' };
  // what's read, in order: form key, command, value parse
  const READS = [['name', 'get name', s => s], ['owner', 'get owner.info', s => s], ['radio', 'get radio', parseRadio], ['tx', 'get tx', toInt],
    ['guestPw', 'get guest.password', s => s], ['lat', 'get lat', toNum], ['lon', 'get lon', toNum], ['advert', 'get advert.interval', toInt],
    ['flood', 'get flood.advert.interval', toInt], ['hash', 'get path.hash.mode', toInt], ['macks', 'get multi.acks', toInt]];
  function toInt(s) { return /^-?\d+$/.test(s.trim()) ? parseInt(s, 10) : null; }
  function toNum(s) { const v = parseFloat(s); return Number.isFinite(v) ? v : null; }
  function parseRadio(s) {
    const p = s.split(',').map(x => x.trim()); if (p.length !== 4) return null;
    const r = { freq: +p[0], bw: +p[1], sf: +p[2], cr: +p[3] };
    return Object.values(r).every(Number.isFinite) ? r : null;
  }
  // a `get` answer -> its value, undefined = the firmware hasn't got that setting, null = not an answer at all
  function parseGet(reply) {
    if (reply == null) return null;
    if (/^\?\?:/.test(reply)) return undefined;
    const m = /^> ?(.*)$/s.exec(reply); return m ? m[1] : null;
  }
  const isOk = r => /^OK\b/.test(r || '');
  const bytes = s => enc.encode(s).length;
  const ctl = s => /[\x00-\x1f\x7f]/.test(s);
  function txCap(board) {
    const c = TX_CAPS.find(([re]) => re.test(board || ''));
    return c ? { dbm: c[1], why: `${c[2]}: its SX1262 tops out at ${c[1]} dBm` } : { dbm: TX_CAP_UNKNOWN, why: `a board Kelly doesn't know (${board || '?'}): ${TX_CAP_UNKNOWN} dBm until we know whether it has a power amplifier` };
  }
  const fmtNum = v => String(Math.round(v * 1e6) / 1e6);
  const fmtRadio = r => `${fmtNum(r.freq)} MHz · BW ${fmtNum(r.bw)} kHz · SF${r.sf} · CR4/${r.cr}`;
  const inBand = r => r.freq - r.bw / 2000 >= BAND[0] - 1e-9 && r.freq + r.bw / 2000 <= BAND[1] + 1e-9;

  // ---------------------------------------------------------------- the line link
  // CliLink(write) -> { push(bytes), cmd(text, {mask, timeout}) -> Promise<reply>, onLog }
  // One command at a time. A reply counts only after the node has echoed THIS command (a late answer to the last one is
  // dropped). Timeout: echo seen but no "->" line = '' (reboot answers nothing); no echo = an error.
  function CliLink(write) {
    const dec = new TextDecoder();
    let buf = '', w = null, chain = Promise.resolve();
    const link = { onLog: null, closed: false };
    const log = (dir, text) => { if (link.onLog) link.onLog(dir, text); };
    function line(l) {
      if (!w) return;
      if (!w.echo) { if (l.trim() && l.trimEnd().endsWith(w.cmd.trimEnd())) w.echo = true; return; }
      if (l.startsWith('  -> ')) { const r = l.slice(5).trimEnd(); log('<', w.mask ? (w.maskReply ? w.maskReply(r) : '••••') : r); w.done(r); }
    }
    link.push = b => {
      buf += typeof b === 'string' ? b : dec.decode(b, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r/g, ''); buf = buf.slice(i + 1); line(l); }
      if (buf.length > 4096) buf = buf.slice(-512);   // a companion node's binary frames never end a line
    };
    link.cmd = (text, o = {}) => {
      const run = () => new Promise((res, rej) => {
        if (link.closed) { rej(new Error('not connected')); return; }
        if (/[\r\n]/.test(text) || text.length > 158) { rej(new Error('command too long or has a line break')); return; }
        let t;
        w = { cmd: text, echo: false, mask: !!o.mask, maskReply: o.maskReply, done: r => { clearTimeout(t); w = null; res(r); } };
        const me = w;
        t = setTimeout(() => { if (w !== me) return; w = null; if (me.echo) { log('<', '(no answer)'); res(''); } else rej(new Error('no answer')); }, o.timeout || 3000);
        log('>', o.mask || text);
        Promise.resolve(write(enc.encode(text + '\r'))).catch(e => { if (w === me) { clearTimeout(t); w = null; rej(e); } });
      });
      const p = chain.then(run, run); chain = p.catch(() => {}); return p;
    };
    return link;
  }

  // ---------------------------------------------------------------- read, plan, write
  // read(link) -> { info: { fw, board, role, key (64 hex | null) }, cur: { name, owner, freq, bw, sf, cr, tx, guestPw, lat, lon, advert, flood, hash, macks } }
  // A setting this firmware hasn't got stays undefined in cur (and is never written).
  async function read(link) {
    let fw;
    try { fw = await link.cmd('ver'); } catch { fw = null; }
    if (!fw) throw new Error('No answer on its text console. Is it a repeater or room server? A companion node has no console: set it up through the link at the top of the page.');
    if (!/^v?\d/.test(fw)) { fw = await link.cmd('ver'); if (!/^v?\d/.test(fw || '')) throw new Error(`"ver" answered "${fw}": not a MeshCore repeater or room server`); }
    const info = { fw, board: await link.cmd('board'), role: parseGet(await link.cmd('get role')) || '?' };
    // its PUBLIC key, for the ▦ QR (never prv.key)
    const pk = parseGet(await link.cmd('get public.key'));
    info.key = pk && /^[0-9a-f]{64}$/i.test(pk.trim()) ? pk.trim().toLowerCase() : null;
    const cur = {};
    for (const [key, cmd, conv] of READS) {
      const secret = key === 'guestPw';
      const r = await link.cmd(cmd, secret ? { mask: cmd, maskReply: x => x.startsWith('>') ? '> ••••' : x } : {});
      const v = parseGet(r);
      if (v === undefined) continue;
      const val = v === null ? null : conv(v);
      if (val === null) throw new Error(`"${cmd}" answered "${secret ? '…' : r}"`);
      if (key === 'radio') Object.assign(cur, val); else cur[key] = val;
    }
    return { info, cur };
  }
  // `get role` -> the MeshCore contact type for its QR (this console is a repeater's or a room server's)
  const qrType = role => /room/i.test(role || '') ? 3 : /sensor/i.test(role || '') ? 4 : 2;
  const diffNum = (a, b, tol) => a == null || b == null ? a !== b : Math.abs(a - b) > tol;
  // plan(cur, want, board) -> { rows: [{ key, label, from, to, cmd, mask?, expect(reply), reboot? }], errors: { key: msg } }
  // Only what changed; each changed field checked against the guards. want.adminPw '' = leave it.
  function plan(cur, want, board) {
    const rows = [], errors = {}, has = k => cur[k] !== undefined;
    const add = (key, label, from, to, cmd, extra = {}) => rows.push(Object.assign({ key, label, from, to, cmd, expect: isOk }, extra));
    const str = (key, label, max, setCmd) => {
      if (!has(key) || want[key] == null || want[key] === cur[key]) return;
      const v = want[key];
      if (ctl(v)) errors[key] = 'No line breaks or control characters';
      else if (bytes(v) > max) errors[key] = `Too long: ${max} bytes at most`;
      add(key, label, cur[key], v, `${setCmd} ${v}`);
    };
    if (has('name') && want.name != null && want.name !== cur.name) {
      if (!want.name.trim()) errors.name = 'A node needs a name';
      else if (/[[\]\\:,?*]/.test(want.name)) errors.name = 'MeshCore refuses [ ] \\ : , ? * in a name';
    }
    str('name', 'Name', 31, 'set name');
    str('owner', 'Owner info', 119, 'set owner.info');
    if (has('freq') && ['freq', 'bw', 'sf', 'cr'].some(k => want[k] != null && diffNum(+want[k], cur[k], k === 'freq' ? 5e-4 : 1e-3))) {
      const r = { freq: +want.freq, bw: +want.bw, sf: +want.sf, cr: +want.cr };
      if (![r.freq, r.bw, r.sf, r.cr].every(Number.isFinite)) errors.radio = 'Fill in all four radio settings';
      else if (!inBand(r)) errors.radio = `Refused: ${fmtNum(r.freq)} MHz with ${fmtNum(r.bw)} kHz bandwidth isn't inside ${BAND[0]}-${BAND[1]} MHz`;
      else if (!BWS.some(b => Math.abs(b - r.bw) < 1e-3)) errors.radio = `Bandwidth must be one of ${BWS.join(', ')} kHz`;
      else if (!(Number.isInteger(r.sf) && r.sf >= 5 && r.sf <= 12)) errors.radio = 'Spreading factor 5-12';
      else if (!(Number.isInteger(r.cr) && r.cr >= 5 && r.cr <= 8)) errors.radio = 'Coding rate 5-8 (4/5 .. 4/8)';
      add('radio', 'Radio', fmtRadio(cur), Number.isFinite(r.freq) ? fmtRadio(r) : '?', `set radio ${fmtNum(r.freq)},${fmtNum(r.bw)},${r.sf},${r.cr}`, { reboot: true });
    }
    const int = (key, label, ok, msg, cmd, show = v => v) => {
      if (!has(key) || want[key] == null || want[key] === '' || +want[key] === cur[key]) return;
      const v = +want[key];
      if (!Number.isInteger(v) || !ok(v)) errors[key] = msg;
      add(key, label, show(cur[key]), show(v), `${cmd} ${v}`);
    };
    const cap = txCap(board);
    int('tx', 'TX power', v => v >= TX_MIN && v <= cap.dbm, `${TX_MIN} to ${cap.dbm} dBm (${cap.why})`, 'set tx', v => `${v} dBm`);
    if (want.adminPw) {
      const v = want.adminPw;
      if (ctl(v) || v !== v.trim()) errors.adminPw = 'No spaces at the ends, no line breaks';
      else if (bytes(v) > 15) errors.adminPw = '15 characters at most';
      // the node echoes the new password: checked, never shown
      add('adminPw', 'Admin password', '••••', 'new', `password ${v}`, { mask: 'password ••••', expect: r => r === 'password now: ' + v });
    }
    if (has('guestPw') && want.guestPw != null && want.guestPw !== cur.guestPw) {
      const v = want.guestPw;
      if (ctl(v) || v !== v.trim()) errors.guestPw = 'No spaces at the ends, no line breaks';
      else if (bytes(v) > 15) errors.guestPw = '15 characters at most';
      add('guestPw', 'Guest password', cur.guestPw ? '••••' : '(none)', v ? 'new' : '(none)', `set guest.password ${v}`, { mask: 'set guest.password ••••' });
    }
    for (const [key, label, lim] of [['lat', 'Latitude', 90], ['lon', 'Longitude', 180]]) {
      if (!has(key) || want[key] == null || want[key] === '' || !diffNum(+want[key], cur[key], 5e-6)) continue;
      const v = +want[key];
      if (!Number.isFinite(v) || Math.abs(v) > lim) errors[key] = `-${lim} to ${lim}`;
      add(key, label, fmtNum(cur[key]), Number.isFinite(v) ? fmtNum(v) : '?', `set ${key} ${fmtNum(v)}`);
    }
    int('advert', 'Local advert every', v => v === 0 || (v >= 60 && v <= 240), '0 (off) or 60-240 minutes', 'set advert.interval', v => v ? `${v} min` : 'off');
    int('flood', 'Flood advert every', v => v === 0 || (v >= 3 && v <= 168), '0 (off) or 3-168 hours', 'set flood.advert.interval', v => v ? `${v} h` : 'off');
    int('hash', 'Path hash size', v => v >= 0 && v <= 2, '0, 1 or 2', 'set path.hash.mode', v => HASH[v] || v);
    int('macks', 'Multi-acks', v => v === 0 || v === 1, 'off or on', 'set multi.acks', v => v ? 'on' : 'off');
    return { rows, errors };
  }
  // write(link, rows, onRow) -> { ok, done }: stops at the first command whose reply isn't the expected one
  async function write(link, rows, onRow) {
    let done = 0;
    for (const r of rows) {
      let reply, err;
      try { reply = await link.cmd(r.cmd, r.mask ? { mask: r.mask } : {}); } catch (e) { err = e.message; }
      const ok = !err && r.expect(reply);
      if (onRow) onRow(r, ok, err || (r.mask ? (ok ? 'OK' : 'refused') : reply || '(no answer)'));
      if (!ok) return { ok: false, done };
      done++;
    }
    return { ok: true, done };
  }
  // the written rows read back: the keys whose new value didn't stick ([] = all checked)
  function verify(rows, want, cur) {
    const bad = [];
    for (const r of rows) {
      if (r.key === 'adminPw') continue;   // can't be read: its reply was the check
      if (r.key === 'radio') { if (['freq', 'bw', 'sf', 'cr'].some(k => diffNum(+want[k], cur[k], k === 'freq' ? 5e-4 : 1e-3))) bad.push(r.key); continue; }
      const a = want[r.key], b = cur[r.key];
      if (typeof b === 'number' ? diffNum(+a, b, r.key === 'lat' || r.key === 'lon' ? 5e-6 : 0) : a !== b) bad.push(r.key);
    }
    return bad;
  }
  const preset = want => Object.assign({}, want, MBUG);
  const core = { BAUD, BAND, BWS, MBUG, TX_CAPS, TX_CAP_UNKNOWN, READS, CliLink, parseGet, parseRadio, txCap, read, plan, write, verify, preset, inBand, fmtRadio, qrType };

  // ---------------------------------------------------------------- the card
  function KellyMeshSetup(k) {
    const { $, esc, ms } = k;
    const ui = { sig: '', link: null, kind: '', info: null, cur: null, want: null, busy: '', err: '', note: '', results: null, log: [], reboot: false, close: null };
    // js/secure.js (Phase 8) says whether Web Serial can run here and, if not, why (k.secure: a KellySecure.make() for tests)
    const SEC = () => k.secure || root.KellySecure;
    const canSerial = () => SEC() ? SEC().can('serial') : !!(root.navigator && navigator.serial) && !!root.isSecureContext;
    const whyNoSerial = () => (SEC() && SEC().why('serial')) || 'This browser has no Web Serial: use Chrome or Edge on a PC, or the Demo node.';
    const logLine = (dir, text) => { ui.log.push(`${dir} ${text}`); if (ui.log.length > 60) ui.log.shift(); const pre = $('#msu-log'); if (pre) pre.textContent = ui.log.join('\n'); };

    async function connect(kind) {
      if (ui.link) await disconnect();
      ui.err = ''; ui.note = ''; ui.results = null; ui.reboot = false; ui.log = [];
      try {
        if (kind === 'demo') {
          const S = root.KellyMeshCliSim; if (!S) throw new Error('The demo node (js/meshclisim.js) isn\'t loaded');
          const sim = S.create();
          const link = CliLink(b => sim.write(b));
          sim.onData(b => link.push(b)); sim.onDrop = () => dropped('It restarted. Connect again in a few seconds to check it.');
          ui.close = async () => sim.stop(); ui.link = link;
        } else if (kind === 'bridge') {
          const url = k.wsUrl ? k.wsUrl() : '';
          if (!url) throw new Error('No Mesh bridge address: set it on the LoRa Mesh page (Link: Bridge), e.g. 100.64.0.10:8026?token=…');
          if (k.bridgeBusy && k.bridgeBusy()) throw new Error('The LoRa Mesh node link is using that bridge: Disconnect it first');
          const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
          await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`No answer from the bridge at ${url.replace(/([?&]token=)[^&]+/, '$1…')}`)), 6000);
            ws.onopen = () => { clearTimeout(t); res(); };
            ws.onerror = () => { clearTimeout(t); rej(new Error(`Can't reach the bridge at ${url.replace(/([?&]token=)[^&]+/, '$1…')} -- check the address and token, and that it runs with --mesh-serial or --mesh-tcp`)); };
          });
          const raw = async b => { if (ws.readyState !== WebSocket.OPEN) throw new Error('The bridge link closed'); ws.send(b); };
          const link = CliLink(raw);
          ws.onmessage = e => { if (typeof e.data !== 'string') link.push(new Uint8Array(e.data)); };   // text = bridge notices
          ws.onclose = () => dropped('The bridge link closed (or the node restarted).');
          ui.close = async () => { ws.onclose = null; try { ws.close(); } catch {} };
          ui.link = link;
          await raw(enc.encode('\r'));
          await new Promise(r => setTimeout(r, 400));
        } else {
          if (!canSerial()) throw new Error(whyNoSerial());
          if (BAUD === 1200) throw new Error('1200 baud would drop an nRF52 into its bootloader');
          const port = await navigator.serial.requestPort();
          await port.open({ baudRate: BAUD });
          // nRF52 TinyUSB only talks once DTR is set (the SenseCAP Solar Node was silent without it, 2026-10-23); setting
          // it is no reset there. ESP32 boards (CP2102 / native USB) are left alone: DTR/RTS is their reset circuit.
          if ([0x239a, 0x2886, 0x1915].includes(port.getInfo().usbVendorId)) await port.setSignals({ dataTerminalReady: true });
          let alive = true, reader;
          const raw = async b => { const wr = port.writable.getWriter(); try { await wr.write(b); } finally { wr.releaseLock(); } };
          const link = CliLink(raw);
          (async () => { while (alive && port.readable) { reader = port.readable.getReader(); try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) link.push(value); } } catch { } finally { reader.releaseLock(); } } if (alive) dropped('The USB link dropped (unplugged, or it restarted).'); })();
          ui.close = async () => { alive = false; try { await reader?.cancel(); } catch {} try { await port.close(); } catch {} };
          ui.link = link;
          // a bare CR ends anything half-typed from before (it answers "Unknown command", which nobody is waiting for)
          await raw(enc.encode('\r'));
          await new Promise(r => setTimeout(r, 400));
        }
        ui.kind = kind; ui.link.onLog = logLine;
        await reread();
        if (k.addEvent) k.addEvent('network', `Node setup: connected to ${ui.cur.name || 'a node'} over ${kind === 'demo' ? 'the demo link' : kind === 'bridge' ? 'the bridge' : 'USB'}`);
      } catch (e) {
        if (e && e.name === 'NotFoundError') { await disconnect(); draw(); return; }   // chooser closed
        const m = e && e.name === 'InvalidStateError' ? 'That port is already open (is it the page\'s own node link?)' : (e && e.message) || String(e);
        await disconnect(); ui.err = m; draw();
      }
    }
    async function reread() {
      ui.busy = 'Reading its settings…'; draw();
      try {
        const r = await read(ui.link);
        ui.info = r.info; ui.cur = r.cur; ui.want = Object.assign({}, r.cur, { adminPw: '' });
      } catch (e) { ui.err = e.message; }
      ui.busy = ''; draw();
    }
    function dropped(why) { if (!ui.link) return; ui.link.closed = true; ui.link = null; ui.close = null; wipe(); ui.note = why; draw(); }
    function wipe() { ui.info = null; ui.cur = null; ui.want = null; ui.results = null; }   // passwords go with the form
    async function disconnect() { const c = ui.close; if (ui.link) ui.link.closed = true; ui.link = null; ui.close = null; wipe(); ui.reboot = false; if (c) try { await c(); } catch {} }

    async function doWrite() {
      const p = plan(ui.cur, ui.want, ui.info && ui.info.board);
      if (!p.rows.length || Object.keys(p.errors).length) return;
      const radio = p.rows.find(r => r.key === 'radio');
      if (radio && !confirm(`Change the radio to ${radio.to}?\n\nIt takes effect at the next reboot. A wrong radio setting takes the node off the mesh until it's fixed here over USB.`)) return;
      ui.busy = `Writing ${p.rows.length} change${p.rows.length > 1 ? 's' : ''}…`; ui.results = p.rows.map(r => ({ key: r.key, label: r.label, to: r.to, state: '…' })); draw();
      const res = await write(ui.link, p.rows, (r, ok, reply) => { const x = ui.results.find(y => y.key === r.key); x.state = ok ? 'ok' : 'bad'; x.reply = reply; drawDiff(); });
      const want = ui.want;
      ui.busy = 'Reading it back…'; drawDiff();
      let bad = [];
      try { const r = await read(ui.link); ui.info = r.info; ui.cur = r.cur; bad = verify(p.rows.slice(0, res.done), want, r.cur); } catch (e) { ui.err = e.message; }
      ui.want = Object.assign({}, ui.cur || {}, { adminPw: '' });
      ui.busy = '';
      ui.note = !res.ok ? `Stopped at the first refusal: ${res.done} of ${p.rows.length} written.` : bad.length ? `Written, but these didn't read back the same: ${bad.join(', ')}.` : `${res.done} written and read back: all checked.`;
      if (res.ok && radio) ui.reboot = true;
      if (k.addEvent) k.addEvent('network', `Node setup: ${ui.note} (${p.rows.map(r => r.label).join(', ')})`);
      draw();
    }
    let qrUi = null;
    function showQr() {
      const i = ui.info; if (!i || !i.key || !root.KellyMeshQR) return;
      qrUi = qrUi || root.KellyMeshQR.ui({ toast: k.toast });
      return qrUi.show({ title: `▦ ${(ui.cur && ui.cur.name) || 'This node'}`, contact: { key: i.key, type: qrType(i.role), name: (ui.cur && ui.cur.name) || '' },
        note: 'Scan it to add this node as a contact. Its passwords are never in a QR code.' });
    }
    async function reboot() {
      if (!confirm('Restart the node now? Its USB link drops while it restarts.')) return;
      ui.busy = 'Restarting…'; draw();
      try { await ui.link.cmd('reboot', { timeout: 1500 }); } catch { }
      if (ui.link) { await disconnect(); ui.note = 'It restarted. Connect again in a few seconds to check it.'; }
      ui.busy = ''; draw();
    }

    // ---------------------------------------------------------------- drawing
    const fld = (key, label, input, hint = '') => `<label class="fld msu-f" data-k="${key}"><span>${label}</span>${input}${hint ? `<small class="dim">${hint}</small>` : ''}<small class="msu-e" data-e="${key}"></small></label>`;
    const val = key => esc(ui.want[key] == null ? '' : ui.want[key]);
    const inp = (key, attrs = '') => `<input data-f="${key}" value="${val(key)}" ${attrs}>`;
    const sel = (key, opts) => `<select data-f="${key}">${opts.map(([v, t]) => `<option value="${v}"${String(ui.want[key]) === String(v) ? ' selected' : ''}>${t}</option>`).join('')}</select>`;
    const has = key => ui.cur && ui.cur[key] !== undefined;
    function formHtml() {
      const cap = txCap(ui.info.board), c = ui.cur;
      const bws = BWS.includes(+ui.want.bw) ? BWS : [...BWS, +ui.want.bw].sort((a, b) => a - b);
      let h = '<div class="msu-form">';
      if (has('name')) h += fld('name', 'Name', inp('name', 'maxlength="31"'));
      if (has('owner')) h += fld('owner', 'Owner info', inp('owner', 'maxlength="119" placeholder="callsign, how to reach you"'), '| starts a new line');
      if (has('freq')) h += `<fieldset class="msu-radio"><legend>Radio</legend>${fld('freq', 'MHz', inp('freq', 'type="number" step="0.001" min="915" max="928"'))}${fld('bw', 'BW kHz', sel('bw', bws.map(b => [b, b])))}${fld('sf', 'SF', sel('sf', [5, 6, 7, 8, 9, 10, 11, 12].map(v => [v, v])))}${fld('cr', 'CR', sel('cr', [5, 6, 7, 8].map(v => [v, '4/' + v])))}<small class="msu-e" data-e="radio"></small></fieldset>`;
      if (has('tx')) h += fld('tx', 'TX power dBm', inp('tx', `type="number" step="1" min="${TX_MIN}" max="${cap.dbm}"`), `Cap ${cap.dbm}: ${esc(cap.why)}`);
      h += fld('adminPw', 'Admin password', `<input data-f="adminPw" type="password" autocomplete="new-password" maxlength="15" value="${val('adminPw')}" placeholder="unchanged">`, 'Blank leaves it. It can\'t be read back.');
      if (has('guestPw')) h += fld('guestPw', 'Guest password', `<input data-f="guestPw" type="password" autocomplete="off" maxlength="15" value="${val('guestPw')}" placeholder="none">`);
      if (has('lat')) h += fld('lat', 'Latitude', inp('lat', 'type="number" step="0.0001"'), 'MeshCore adverts it exactly');
      if (has('lon')) h += fld('lon', 'Longitude', inp('lon', 'type="number" step="0.0001"'));
      if (has('advert')) h += fld('advert', 'Local advert, min', inp('advert', 'type="number" step="1" min="0" max="240"'), '0 = off, or 60-240');
      if (has('flood')) h += fld('flood', 'Flood advert, hours', inp('flood', 'type="number" step="1" min="0" max="168"'), '0 = off, or 3-168');
      if (has('hash')) h += fld('hash', 'Path hash size', sel('hash', [0, 1, 2].map(v => [v, HASH[v]])));
      if (has('macks')) h += fld('macks', 'Multi-acks', sel('macks', [[0, 'off'], [1, 'on']]));
      h += '</div>';
      const warn = [];
      if (has('freq') && !inBand(c)) warn.push(`It's set to ${esc(fmtRadio(c))}: outside ${BAND[0]}-${BAND[1]} MHz. The MBUG preset puts it on the SEQ settings.`);
      if (has('tx') && c.tx > cap.dbm) warn.push(`Its TX power (${c.tx} dBm) is over Kelly's cap for this board (${cap.dbm} dBm).`);
      const missing = READS.map(r => r[0]).filter(x => x === 'radio' ? !has('freq') : !has(x));
      if (missing.length) warn.push(`This firmware hasn't got: ${missing.join(', ')} (left alone).`);
      return (warn.length ? `<div class="msu-warn">${warn.map(w => `<p>⚠️ ${w}</p>`).join('')}</div>` : '') + h;
    }
    function flashHtml() {
      return `<details class="msu-flash"><summary>⚡ Flash firmware</summary>
        <p class="small">Kelly doesn't flash nodes. Use the official <a href="https://flasher.meshcore.co.uk/" target="_blank" rel="noopener">MeshCore flasher</a> (Chrome or Edge), pick the board and <b>Repeater</b> or <b>Room Server</b>, then come back here to set it up.</p>
        <ul class="small">
          <li><b>Heltec V3</b> (ESP32-S3): the flasher talks to it over USB by itself (esptool inside). If it won't connect, hold PRG, tap RST, let go of PRG and try again. By hand: <code>esptool.py --chip esp32s3 write_flash 0x0 &lt;firmware&gt;-merged.bin</code>.</li>
          <li><b>RAK4631</b> (nRF52840): the flasher, or <code>adafruit-nrfutil dfu serial --package &lt;firmware&gt;.zip -p COMx -b 115200 --singlebank --touch 1200</code>. Its bootloader has no UF2 drive, so don't wait for one.</li>
          <li><b>SenseCAP Solar Node P1-Pro</b> (nRF52840): double-press its reset button and a USB drive called <b>XIAO-BOOT</b> appears. Copy the <code>.uf2</code> onto it; it restarts by itself when the copy is done.</li>
        </ul>
        <p class="small dim">Going from companion to repeater (or back) can need an erase first: the flasher has one. A freshly flashed node starts on the firmware's own radio settings (869.618 MHz in v1.18.0, not ours): set the radio here straight away.</p></details>`;
    }
    function draw() {
      const body = $('#msu-body'); if (!body) return;
      $('#msu-tag').textContent = ui.link ? (ui.kind === 'demo' ? 'demo node' : ui.kind === 'bridge' ? 'bridge' : 'USB') : 'not connected';
      let h = '';
      if (!ui.link) {
        h += `<p class="small dim">For a <b>repeater</b> or <b>room server</b> plugged into this PC: Kelly reads its settings, shows what would change, and writes only that. A companion node is set up through the link at the top of the page instead.</p>
          <div class="row gap wrap"><button class="btn primary" id="msu-usb"${canSerial() && !ui.busy ? '' : ' disabled'}>🔌 Connect over USB</button><button class="btn" id="msu-bridge"${ui.busy ? ' disabled' : ''} title="The node's USB on another machine, through the Kelly bridge (--mesh-serial / --mesh-tcp) at the LoRa Mesh bridge address">🌐 Over the bridge</button><button class="btn ghost" id="msu-demo"${ui.busy ? ' disabled' : ''}>🧪 Demo node</button></div>`
          + (canSerial() ? '' : `<p class="small msu-warn">${esc(whyNoSerial())}</p>`);
      } else {
        const i = ui.info;
        h += `<div class="msu-who row gap wrap"><span class="rp-chip ok">${ui.kind === 'demo' ? '🧪 Demo' : ui.kind === 'bridge' ? '🌐 Bridge' : '🔌 USB'}</span>${i ? `<b>${esc(ui.cur.name || '?')}</b><span class="small dim">${esc(i.board)} · ${esc(i.fw)} · ${esc(i.role.replace('_', ' '))}</span>` : ''}
          <span class="grow"></span>${i && i.key && root.KellyMeshQR ? '<button class="btn ghost small" id="msu-qr" title="Its contact QR: public key, name and type (never a password)">▦ Show this node\'s QR</button>' : ''}<button class="btn ghost small" id="msu-read"${ui.busy ? ' disabled' : ''}>↻ Read again</button><button class="btn ghost small" id="msu-off">Disconnect</button></div>`;
        if (i && ui.cur) h += formHtml() + `<div class="row gap wrap msu-btns"><button class="btn ghost" id="msu-mbug"${ui.busy ? ' disabled' : ''} title="923.125 MHz / 62.5 kHz / SF8 / CR4/5, 2-byte path hashes, flood advert every 83 h, multi-acks on">🗺️ MBUG preset</button><button class="btn ghost" id="msu-undo"${ui.busy ? ' disabled' : ''}>Undo my edits</button></div><div id="msu-diff"></div>`;
      }
      if (ui.busy) h += `<p class="rp-busy">${esc(ui.busy)}</p>`;
      if (ui.err) h += `<p class="rp-err">${esc(ui.err)}</p>`;
      if (ui.note) h += `<p class="small msu-note">${esc(ui.note)}</p>`;
      if (ui.link && ui.reboot) h += `<p class="small msu-warn">Radio changes take effect after a restart. <button class="btn small" id="msu-reboot">⟳ Restart it now</button></p>`;
      if (ui.link || ui.log.length) h += `<details class="msu-logd"><summary class="small">Console</summary><pre id="msu-log" class="rp-log">${esc(ui.log.join('\n'))}</pre></details>`;
      h += flashHtml();
      const open = body.querySelector('.msu-flash') && body.querySelector('.msu-flash').open, logOpen = body.querySelector('.msu-logd') && body.querySelector('.msu-logd').open;
      body.innerHTML = h;
      if (open) body.querySelector('.msu-flash').open = true;
      if (logOpen && body.querySelector('.msu-logd')) body.querySelector('.msu-logd').open = true;
      drawDiff();
    }
    // the changes panel: live from the form, redrawn on every edit without touching the form itself
    function drawDiff() {
      const box = $('#msu-diff'); if (!box || !ui.cur) return;
      const p = plan(ui.cur, ui.want, ui.info && ui.info.board);
      document.querySelectorAll('#msu-body [data-e]').forEach(e => { e.textContent = p.errors[e.dataset.e] || ''; });
      document.querySelectorAll('#msu-body .msu-f').forEach(e => e.classList.toggle('bad', !!p.errors[e.dataset.k]));
      const res = ui.results;
      if (res) {
        box.innerHTML = `<h4 class="rp-h">Written</h4><table class="msu-diff"><tr><th>Setting</th><th>New</th><th>Answer</th></tr>${res.map(r => `<tr class="${r.state === 'ok' ? 'ok' : r.state === 'bad' ? 'bad' : ''}"><td>${esc(r.label)}</td><td>${esc(r.to)}</td><td>${r.state === 'ok' ? '✓ ' : r.state === 'bad' ? '✗ ' : ''}${esc(r.reply || '…')}</td></tr>`).join('')}</table>`
          + (ui.busy ? '' : '<button class="btn ghost small" id="msu-done">OK</button>');
        return;
      }
      if (!p.rows.length) { box.innerHTML = '<p class="small dim">No changes.</p>'; return; }
      const nerr = Object.keys(p.errors).length;
      box.innerHTML = `<h4 class="rp-h">Changes to write <small class="dim">one command each, checked against its answer</small></h4><table class="msu-diff"><tr><th>Setting</th><th>Now</th><th>New</th></tr>${p.rows.map(r => `<tr class="${p.errors[r.key] ? 'bad' : ''}"><td>${esc(r.label)}${r.reboot ? ' <small class="dim">(after a restart)</small>' : ''}</td><td>${esc(r.from)}</td><td>${esc(r.to)}</td></tr>`).join('')}</table>`
        + `<div class="row gap wrap"><button class="btn primary" id="msu-write"${nerr || ui.busy ? ' disabled' : ''}>✍️ Write ${p.rows.length} change${p.rows.length > 1 ? 's' : ''}</button>${nerr ? `<span class="small bad">Fix ${nerr === 1 ? 'the field' : 'the fields'} in red first.</span>` : ''}</div>`;
    }

    function render() {
      const box = $('#msu-card'); if (!box) return;
      const on = !!ms.setup;
      if ($('#ms-setup')) $('#ms-setup').checked = on;
      box.hidden = !on;
      const sig = String(on);
      if (sig === ui.sig) return; ui.sig = sig;
      if (!on && ui.link) disconnect();
      if (on) draw();
    }
    function init() {
      const box = $('#msu-card'); if (!box) return;
      const t = $('#ms-setup'); if (t) t.addEventListener('change', e => { ms.setup = e.target.checked; if (k.save) k.save(); render(); });
      const body = $('#msu-body');
      const edit = e => {
        const f = e.target.dataset && e.target.dataset.f; if (!f || !ui.want) return;
        const v = e.target.value, num = ['freq', 'bw', 'sf', 'cr', 'tx', 'lat', 'lon', 'advert', 'flood', 'hash', 'macks'].includes(f);
        ui.want[f] = num ? (v === '' ? '' : +v) : v;
        ui.results = null; drawDiff();
      };
      body.addEventListener('input', edit); body.addEventListener('change', edit);
      body.addEventListener('click', e => {
        const id = e.target.id;
        if (id === 'msu-usb') connect('usb');
        else if (id === 'msu-demo') connect('demo');
        else if (id === 'msu-bridge') connect('bridge');
        else if (id === 'msu-off') { disconnect().then(draw); ui.note = ''; ui.err = ''; }
        else if (id === 'msu-read') { ui.err = ''; ui.note = ''; ui.results = null; reread(); }
        else if (id === 'msu-mbug') { ui.want = preset(ui.want); ui.results = null; ui.note = 'MBUG preset: check the changes below, then write them. MBUG also asks repeaters for owner info (a contact) and a rough position.'; draw(); }
        else if (id === 'msu-undo') { ui.want = Object.assign({}, ui.cur, { adminPw: '' }); ui.results = null; ui.note = ''; draw(); }
        else if (id === 'msu-write') doWrite();
        else if (id === 'msu-done') { ui.results = null; ui.note = ''; draw(); }
        else if (id === 'msu-reboot') reboot();
        else if (id === 'msu-qr') showQr();
      });
    }
    return { render, init, core, state: () => ui };
  }

  KellyMeshSetup.core = core;
  root.KellyMeshSetup = KellyMeshSetup;
})(typeof window !== 'undefined' ? window : globalThis);
