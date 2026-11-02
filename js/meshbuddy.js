/* meshbuddy.js -- LoRa Mesh > 🐕 Mesh Buddy tab: flash a RAK4631 + WisBlock GNSS tracker with the Mesh Buddy firmware
 * Kelly ships (firmware/mesh-buddy/, built from tools/mesh-buddy in the P25X repo) and set it up from THIS station's own
 * callsign -- over USB, in the browser (Web Serial: Chrome / Edge, on a secure page).
 *
 * window.KellyMeshBuddyUI(k) -> { init(), shown(), hidden() }   k from mesh.js: { $, esc, store, toast, settings,
 *   igate() -> the APRS iGate UI (findDevice), showPage(name) }. window.kellyMeshBuddy = the same object + test hooks.
 *
 * Flash = js/nrfdfu.js (adafruit-nrfutil's serial DFU, byte for byte): pick the tracker's port -> 1200-baud touch ->
 * the bootloader comes back as a NEW port (USB PID 0x002A; Kelly finds it if this site may already use it, else one
 * more click) -> the image (sha-256 checked against firmware.json first) -> the tracker reboots into Mesh Buddy.
 * Set up = MeshCore's USB text CLI (115200, CR, replies "  -> ..."): name "<CALL> <word>", mprs call / sym / comment /
 * status / route flood / every 0 / min / tlm, set radio, set tx, a new random admin password, get public.key, reboot.
 *
 * HAM ONLY (2026-10-31): the callsign is this Kelly's own (Admin > My station > Callsign), never typed here, and
 * must be a VK / ZL amateur call (KellyIgate.hamCall); the node's name always STARTS with it, so the iGate's checks
 * (igate.js hamNode, the bridge's ham_node) accept the tracker and nothing else. Store 'meshBuddy' = { form, units[] }
 * (a unit: key, call, name, at, pass -- the admin password, shown once and kept here so the owner can find it again).
 */
(function () {
  'use strict';
  const VID = 0x239A, PID_BOOT = 0x002A, FW_DIR = 'firmware/mesh-buddy/';
  const PRESETS = { seq: { label: 'SEQ / MBUG (923.125 MHz, 62.5 kHz, SF8, CR 4/5)', f: 923.125, bw: 62.5, sf: 8, cr: 5 }, custom: { label: 'My local mesh (enter its settings)' } };
  const SYMS = [['/b', '🚲 Bicycle'], ['/p', '🐕 Dog'], ['/>', '🚗 Car'], ['/<', '🏍️ Motorbike'], ['/[', '🚶 Walker / hiker'], ['/k', '🛻 Ute / truck'], ['/R', '🚐 Caravan / RV'], ['/s', '⛵ Boat'], ['/j', '🚙 Jeep / 4WD']];
  // Mesh Buddy's mascot: a border collie (inline SVG, no file to fetch)
  const COLLIE = '<svg class="mb-collie" viewBox="0 0 64 64" width="34" height="34" role="img" aria-label="Border collie" style="vertical-align:-8px"><g stroke="#8a8f99" stroke-width="1.2" stroke-linejoin="round"><path d="M9 5 L25 17 L13 31 Z" fill="#1b1b1f"/><path d="M55 5 L39 17 L51 31 Z" fill="#1b1b1f"/><path d="M12 20 Q32 4 52 20 Q60 38 48 52 Q32 62 16 52 Q4 38 12 20 Z" fill="#1b1b1f"/></g><path d="M9 5 L14 9 L11 12 Z M55 5 L50 9 L53 12 Z" fill="#f4f1ea"/><path d="M29.5 11 Q32 9.5 34.5 11 L36 33 Q45 39 44.5 48 Q32 60 19.5 48 Q19 39 28 33 Z" fill="#f4f1ea"/><circle cx="22" cy="29" r="3.3" fill="#c98a3a"/><circle cx="22" cy="29" r="1.6" fill="#111"/><circle cx="42" cy="29" r="3.3" fill="#c98a3a"/><circle cx="42" cy="29" r="1.6" fill="#111"/><ellipse cx="32" cy="42" rx="4.6" ry="3.2" fill="#111"/><path d="M32 45 V49 M27.5 49.5 Q32 53 36.5 49.5" stroke="#111" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M30 51 Q32 57.5 34 51 Z" fill="#e8768a"/></svg>';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const printable = (s, n) => String(s || '').replace(/[^\x20-\x7E]|[|~]/g, '').slice(0, n);

  window.KellyMeshBuddyUI = function (k) {
    const { $, esc, store, toast, settings } = k;
    const I = () => window.KellyIgate, D = () => window.KellyDfu, SEC = () => window.KellySecure;
    const saved = store.get('meshBuddy', null) || {};
    const S = { form: Object.assign({ ssid: 12, word: 'Buddy', sym: '/b', comment: 'Mesh Buddy', status: '', preset: 'seq', f: 923.125, bw: 62.5, sf: 8, cr: 5, tx: 22, patchy: false, tlm: true, newPass: true }, saved.form || {}),
      units: Array.isArray(saved.units) ? saved.units : [], busy: false, log: [], step: '', pct: null, result: null, pick: null, fw: null };
    let root = null;
    const save = () => store.set('meshBuddy', { form: S.form, units: S.units.slice(-20) });

    // ------------------------------------------------------------------ the station's identity (never typed here)
    const myCall = () => String(settings.myCall || '').trim().toUpperCase();
    const callSsid = () => `${myCall()}-${S.form.ssid}`;
    const nodeName = () => `${myCall()} ${printable(S.form.word, 31 - myCall().length - 1).trim() || 'Buddy'}`.trim();
    function identityProblem() {
      const c = myCall();
      if (!c) return 'Set your callsign first: Admin › My station › Callsign. Mesh Buddy uses it -- it is never typed here.';
      if (!I() || !I().hamCall(c)) return `${c} isn't a VK or ZL amateur callsign (6 characters at most) -- Mesh Buddy only goes on air with one.`;
      if (!I().hamNode(callSsid(), nodeName())) return `The name "${nodeName()}" wouldn't pass the iGate's amateur check.`;
      return '';
    }
    function serialProblem() {
      if (SEC() && !SEC().can('serial')) return SEC().why('serial');
      if (!navigator.serial || !window.isSecureContext) return 'USB flashing needs Chrome or Edge on a secure page (https://, localhost or a file).';
      return '';
    }

    // ------------------------------------------------------------------ USB helpers
    async function openPort(port, baud) {
      await port.open({ baudRate: baud });
      const reader = port.readable.getReader(), writer = port.writable.getWriter();
      let buf = [], pending = null, closed = false;
      (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) { buf.push(...value); if (pending) { const p = pending; pending = null; p(); } } } } catch (e) { /* closed */ } closed = true; if (pending) { const p = pending; pending = null; p(); } })();
      const io = {
        write: u => writer.write(Uint8Array.from(u)),
        sleep,
        read: ms => new Promise(r => {
          if (buf.length || closed) { const o = Uint8Array.from(buf); buf = []; return r(o.length ? o : null); }
          const t = setTimeout(() => { pending = null; r(null); }, ms);
          pending = () => { clearTimeout(t); const o = Uint8Array.from(buf); buf = []; r(o.length ? o : null); };
        }),
        drain: () => { const o = Uint8Array.from(buf); buf = []; return o; },
        async close() { try { await reader.cancel(); } catch (e) {} try { reader.releaseLock(); } catch (e) {} try { writer.releaseLock(); } catch (e) {} try { await port.close(); } catch (e) {} },
      };
      return io;
    }
    const isBoot = p => { const i = p.getInfo ? p.getInfo() : {}; return i.usbVendorId === VID && i.usbProductId === PID_BOOT; };
    const isApp = p => { const i = p.getInfo ? p.getInfo() : {}; return i.usbVendorId === VID && i.usbProductId !== PID_BOOT; };
    async function waitPort(test, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const ps = (await navigator.serial.getPorts()).filter(test); if (ps.length) return ps[ps.length - 1]; await sleep(400); }
      return null;
    }
    // a click the user must make (Web Serial lets a page ask for a NEW port only from a click)
    function askClick(label, why) {
      return new Promise(res => { S.pick = { label, why, res }; draw(); });
    }

    // ------------------------------------------------------------------ the CLI (MeshCore USB text CLI)
    async function cli(io, cmd, ms = 3000) {
      io.drain();
      await io.write(new TextEncoder().encode(cmd + '\r'));
      let text = '';
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const got = await io.read(300);
        if (got) text += new TextDecoder().decode(got);
        const m = /->\s?([^\r\n]*)\r?\n/.exec(text);
        if (m) return m[1].trim();
      }
      throw new Error(`no answer to "${cmd.split(' ').slice(0, 2).join(' ')}" -- is this a Mesh Buddy / MeshCore tracker?`);
    }
    const randomPass = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', r = new Uint8Array(12); crypto.getRandomValues(r); return [...r].map(x => a[x % a.length]).join(''); };

    async function setup(port) {
      const f = S.form, io = await openPort(port, 115200);
      try {
        try { await port.setSignals({ dataTerminalReady: true, requestToSend: false }); } catch (e) {}
        step('Talking to the tracker…'); await sleep(1800); io.drain();
        const ver = await cli(io, 'mprs');
        if (!/^Mesh Buddy /.test(ver)) throw new Error(`this tracker isn't running Mesh Buddy (it said "${ver.slice(0, 40)}") -- use ⚡ Flash first`);
        logl(`✔ ${ver.split(' ').slice(0, 3).join(' ')} answered`);
        const P = f.preset === 'seq' ? PRESETS.seq : f;
        const cmds = [
          [`set name ${nodeName()}`, 'name'], [`mprs call ${callSsid()}`, 'callsign'], [`mprs sym ${f.sym}`, 'symbol'],
          [`mprs comment ${printable(f.comment, 23)}`, 'comment'], [`mprs status ${printable(f.status, 62)}`, 'status'],
          ['mprs route flood', 'flooded beacons'], ['mprs every 0', 'smart beaconing'], [`mprs min ${f.patchy ? 60 : 120}`, `at most every ${f.patchy ? 60 : 120} s`],
          [`mprs tlm ${f.tlm ? 'on' : 'off'}`, `telemetry ${f.tlm ? 'on' : 'off'}`],
          [`set radio ${P.f},${P.bw},${P.sf},${P.cr}`, `radio ${P.f} MHz, ${P.bw} kHz, SF${P.sf}, CR 4/${P.cr}`], [`set tx ${f.tx}`, `${f.tx} dBm`],
        ];
        for (const [c, what] of cmds) { const r = await cli(io, c); if (/^(err|bad|unknown)/i.test(r)) throw new Error(`the tracker refused ${what}: ${r}`); logl(`✔ ${what}`); }
        let pass = null;
        if (f.newPass) { pass = randomPass(); const r = await cli(io, `password ${pass}`); if (!r.includes(pass)) throw new Error('the new admin password was not confirmed'); logl('✔ new admin password'); }
        const key = ((await cli(io, 'get public.key')).match(/[0-9A-Fa-f]{64}/) || [''])[0].toLowerCase();
        if (!key) throw new Error('could not read the tracker\'s node key');
        const done = await cli(io, 'mprs');
        logl(`✔ ${done}`);
        await io.write(new TextEncoder().encode('reboot\r'));
        logl('↻ rebooting -- it sends an advert as it starts');
        const old = S.units.find(u => u.key === key);
        const unit = { key, call: callSsid(), name: nodeName(), at: Date.now(), pass: pass || (old && old.pass) || null };
        S.units = S.units.filter(u => u.key !== key).concat([unit]); save();
        S.result = unit;
      } finally { await io.close(); }
    }

    // ------------------------------------------------------------------ flash
    // XHR, not fetch: Kelly is also opened as a file, and fetch() can't read file:// pages
    const load = (n, type) => new Promise((res, rej) => {
      const x = new XMLHttpRequest(); x.open('GET', FW_DIR + n + '?v=' + Date.now()); x.responseType = type;
      x.onload = () => (x.status === 200 || x.status === 0) && x.response ? res(x.response) : rej(new Error(`couldn't load ${n} from this Kelly`));
      x.onerror = () => rej(new Error(`couldn't load ${n} -- open Kelly through its bridge (https://) to flash`)); x.send();
    });
    async function fetchFirmware() {
      const meta = await load('firmware.json', 'json');
      const get = async n => new Uint8Array(await load(n, 'arraybuffer'));
      const bin = await get(meta.bin), dat = await get(meta.dat);
      const hex = async u => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (bin.length !== meta.size || await hex(bin) !== meta.sha256 || await hex(dat) !== meta.datSha256) throw new Error('the firmware file in this Kelly is damaged (size / sha-256) -- not flashing it');
      return { meta, bin, dat };
    }
    async function flash(port) {
      const fw = await fetchFirmware();
      logl(`✔ ${fw.meta.name} ${fw.meta.version} checked (${(fw.bin.length / 1024).toFixed(0)} KB, sha-256 ok)`);
      let boot = isBoot(port) ? port : null;
      if (!boot) {
        step('Asking the tracker to start its bootloader…');
        try { await port.open({ baudRate: 1200 }); await sleep(100); await port.close(); } catch (e) { throw new Error(`couldn't open the tracker's port (${e.message}) -- close any other program using it (Kelly's LoRa Mesh connection, a terminal)`); }
        await sleep(1500);
        boot = await waitPort(isBoot, 6000)
          || await askClick('🔌 Choose the bootloader port', 'The tracker restarted into its bootloader as a new USB port. Click and pick it (it may show as a new COM port or "nRF52 bootloader").').then(() => S.chosen);
      }
      if (!boot || !isBoot(boot)) throw new Error('that isn\'t the tracker\'s bootloader port');
      const io = await openPort(boot, 115200);
      try {
        await D().flash(io, fw.bin, fw.dat, p => {
          if (p.phase === 'erase') step(`Erasing (about ${Math.round(p.ms / 1000)} s)…`, 0);
          else if (p.phase === 'write') step('Writing Mesh Buddy…', Math.round(100 * p.done / p.total));
          else step('Done -- starting Mesh Buddy', 100);
        });
      } finally { await io.close(); }
      logl(`✔ flashed ${fw.meta.name} ${fw.meta.version}`);
      step('Waiting for Mesh Buddy to start…');
      await sleep(2500);
      return await waitPort(isApp, 12000)
        || await askClick('🔌 Choose the tracker\'s port again', 'Mesh Buddy is running; pick its port once more so Kelly can set it up.').then(() => S.chosen);
    }

    async function run(withFlash) {
      if (S.busy) return;
      const p = identityProblem() || serialProblem();
      if (p) { toast('🐕', 'Mesh Buddy', p, 'bad'); return; }
      S.busy = true; S.log = []; S.result = null; S.pct = null; draw();
      try {
        const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VID }] });
        let app = port;
        if (withFlash) app = await flash(port);
        if (!app) throw new Error('the tracker didn\'t come back -- unplug it, plug it in again and use ⚙️ Set up only');
        await setup(app);
        step('✅ Your Mesh Buddy is ready', 100);
        toast('🐕', 'Mesh Buddy ready', `${callSsid()} -- now add it to your iGate list`, 'good');
      } catch (e) {
        const msg = e && e.name === 'NotFoundError' ? 'No port chosen.' : (e && e.message) || String(e);
        logl(`✖ ${msg}`); step('Stopped');
        if (!(e && e.name === 'NotFoundError')) toast('🐕', 'Mesh Buddy', msg, 'bad');
      } finally { S.busy = false; S.pick = null; draw(); }
    }

    // ------------------------------------------------------------------ drawing
    function step(t, pct) { S.step = t; if (pct !== undefined) S.pct = pct; drawProgress(); }
    function logl(t) { S.log.push(t); drawProgress(); }
    function drawProgress() {
      const el = root && root.querySelector('#mb-prog'); if (!el) return;
      el.innerHTML = `<div class="mb-step">${esc(S.step || '')}</div>${S.pct != null ? `<div class="mb-bar"><i style="width:${S.pct}%"></i></div>` : ''}<div class="mb-log mono small">${S.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>`;
    }
    const opt = (v, l, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`;
    function draw() {
      if (!root) return;
      const f = S.form, idp = identityProblem(), sp = serialProblem(), custom = f.preset === 'custom';
      root.innerHTML = `<div class="mb card">
        <div class="mb-head"><div><h2>${COLLIE} Mesh Buddy</h2><div class="small dim">A MeshCore GPS tracker that puts you on aprs.fi through MeshPRS iGates. RAK4631 + WisBlock GNSS -- <a href="mesh-buddy-guide.html" target="_blank">build guide ↗</a></div></div>
          <span class="tag">firmware 1.1 in this Kelly</span></div>
        ${idp ? `<div class="mb-warn">🔒 ${esc(idp)}</div>` : `<div class="mb-id"><span class="dim small">Goes on air as</span> <b class="mono">${esc(callSsid())}</b> <span class="dim small">named</span> <b>${esc(nodeName())}</b> <span class="small dim">-- your callsign from Admin › My station, so only you can be gated as you</span></div>`}
        ${sp ? `<div class="mb-warn">🔌 ${esc(sp)}</div>` : ''}
        <div class="mb-form">
          <label class="fld"><span>SSID</span><select id="mb-ssid">${Array.from({ length: 15 }, (_, i) => opt(i + 1, `-${i + 1}${i + 1 === 12 ? ' (tracker)' : i + 1 === 9 ? ' (mobile)' : i + 1 === 7 ? ' (handheld)' : ''}`, f.ssid)).join('')}</select></label>
          <label class="fld"><span>Name after the callsign</span><input id="mb-word" maxlength="20" value="${esc(f.word)}" placeholder="Bike"></label>
          <label class="fld"><span>Symbol on aprs.fi</span><select id="mb-sym">${SYMS.map(([y, l]) => opt(y, l, f.sym)).join('')}</select></label>
          <label class="fld grow"><span>Comment (every 10th beacon, 23 max)</span><input id="mb-comment" maxlength="23" value="${esc(f.comment)}"></label>
          <label class="fld grow"><span>Status line (optional, 62 max)</span><input id="mb-status" maxlength="62" value="${esc(f.status)}" placeholder="e.g. Mesh Buddy via MeshPRS"></label>
        </div>
        <div class="mb-form">
          <label class="fld grow"><span>Radio</span><select id="mb-preset">${Object.entries(PRESETS).map(([v, p]) => opt(v, p.label, f.preset)).join('')}</select></label>
          ${custom ? `<label class="fld"><span>MHz (915-928)</span><input id="mb-f" type="number" step="0.001" min="915" max="928" value="${esc(f.f)}"></label>
          <label class="fld"><span>kHz</span><select id="mb-bw">${[62.5, 125, 250, 500].map(b => opt(b, b, f.bw)).join('')}</select></label>
          <label class="fld"><span>SF</span><select id="mb-sf">${[7, 8, 9, 10, 11, 12].map(x => opt(x, x, f.sf)).join('')}</select></label>
          <label class="fld"><span>CR 4/</span><select id="mb-cr">${[5, 6, 7, 8].map(x => opt(x, x, f.cr)).join('')}</select></label>` : ''}
          <label class="fld"><span>Power</span><select id="mb-tx">${[22, 20, 17, 14, 10].map(x => opt(x, `${x} dBm`, f.tx)).join('')}</select></label>
        </div>
        <div class="mb-checks small">
          <label><input type="checkbox" id="mb-patchy"${f.patchy ? ' checked' : ''}> Patchy coverage: beacon up to every 60 s (fills gaps on aprs.fi, twice the airtime; MeshPRS spec §5.5)</label>
          <label><input type="checkbox" id="mb-tlm"${f.tlm ? ' checked' : ''}> Telemetry: battery, repeater echo, satellites, temperature</label>
          <label><input type="checkbox" id="mb-pass"${f.newPass ? ' checked' : ''}> Give it a new random admin password (shown below when done)</label>
        </div>
        <div class="row gap wrap mb-go">
          <button class="btn primary" id="mb-flash"${S.busy || idp || sp ? ' disabled' : ''}>⚡ Flash Mesh Buddy and set it up</button>
          <button class="btn" id="mb-setup"${S.busy || idp || sp ? ' disabled' : ''}>⚙️ Set up only (already has Mesh Buddy)</button>
          <span class="small dim">Plug the tracker into this computer by USB first, with both antennas on. A new kit comes with Meshtastic -- flashing replaces it.</span>
        </div>
        ${S.pick ? `<div class="mb-pick"><p class="small">${esc(S.pick.why)}</p><button class="btn primary" id="mb-pick">${esc(S.pick.label)}</button></div>` : ''}
        <div id="mb-prog" class="mb-prog"></div>
        ${S.result ? resultHtml(S.result) : ''}
        ${S.units.length ? `<details class="mb-units"><summary class="small">My Mesh Buddies (${S.units.length})</summary>${S.units.slice().reverse().map(u => `<div class="small mono">${esc(u.call)} · ${esc(u.name)} · ${esc(u.key.slice(0, 8))} · ${new Date(u.at).toLocaleDateString()}${u.pass ? ` · admin <span class="mb-secret" title="admin password">${esc(u.pass)}</span>` : ''}</div>`).join('')}</details>` : ''}
      </div>`;
      drawProgress(); bind();
    }
    function resultHtml(u) {
      return `<div class="mb-done"><h3>✅ ${esc(u.call)} is ready</h3>
        <p class="small">Node key <span class="mono">${esc(u.key.slice(0, 16))}…</span>. Take it outside for its first GPS fix (a minute or two), then:</p>
        <div class="row gap wrap"><button class="btn primary" id="mb-igate">➕ Add it to my iGate list</button>
        ${u.pass ? `<span class="small">Admin password: <b class="mono mb-secret">${esc(u.pass)}</b> <button class="btn small ghost" id="mb-copy">📋 Copy</button> -- for logging in to it over the air; Kelly keeps it under "My Mesh Buddies".</span>` : ''}</div></div>`;
    }
    function bind() {
      const f = S.form, on = (id, ev, fn) => { const el = root.querySelector(id); if (el) el.addEventListener(ev, fn); };
      const set = (key, conv = v => v) => e => { f[key] = e.target.type === 'checkbox' ? e.target.checked : conv(e.target.value); save(); draw(); };
      on('#mb-ssid', 'change', set('ssid', v => +v)); on('#mb-word', 'change', set('word', v => printable(v, 20).trim()));
      on('#mb-sym', 'change', set('sym')); on('#mb-comment', 'change', set('comment', v => printable(v, 23)));
      on('#mb-status', 'change', set('status', v => printable(v, 62))); on('#mb-preset', 'change', set('preset'));
      on('#mb-f', 'change', set('f', v => Math.min(928, Math.max(915, +v || 923.125)))); on('#mb-bw', 'change', set('bw', v => +v));
      on('#mb-sf', 'change', set('sf', v => +v)); on('#mb-cr', 'change', set('cr', v => +v)); on('#mb-tx', 'change', set('tx', v => +v));
      on('#mb-patchy', 'change', set('patchy')); on('#mb-tlm', 'change', set('tlm')); on('#mb-pass', 'change', set('newPass'));
      on('#mb-flash', 'click', () => run(true)); on('#mb-setup', 'click', () => run(false));
      on('#mb-pick', 'click', async () => { const p = S.pick; S.pick = null; try { S.chosen = await navigator.serial.requestPort({ filters: [{ usbVendorId: VID }] }); } catch (e) { S.chosen = null; } draw(); p.res(); });
      on('#mb-igate', 'click', () => { const u = S.result; if (!u) return; k.showPage('igate'); setTimeout(() => { const g = k.igate(); if (g && g.findDevice) g.findDevice(u.key.slice(0, 8)); }, 300); });
      on('#mb-copy', 'click', () => { if (S.result && S.result.pass && navigator.clipboard) navigator.clipboard.writeText(S.result.pass).then(() => toast('📋', 'Copied', 'Admin password copied', 'good')); });
    }

    const api = {
      init() { root = $('#mb-root'); if (!root) return; draw(); window.kellyMeshBuddy = api; },
      shown() { draw(); },
      hidden() {},
      // tests
      state: () => ({ form: S.form, busy: S.busy, step: S.step, pct: S.pct, log: S.log.slice(), result: S.result, units: S.units, pick: !!S.pick, call: callSsid(), name: nodeName(), problem: identityProblem() || serialProblem() }),
      run,
    };
    return api;
  };
})();
