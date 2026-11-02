/* Kelly Page -- PBBS page: the P25X packet bulletin board over P25 packet data.
 *
 * The board lives on the P25X gateway (dashboard pbbs.js, linked to the packet network through a
 * LinBPQ node by pbbs-bpq.js). Kelly asks over the Radio-files path (KF kind 3 {op: 'bbs', c}) and the
 * gateway answers KF kind 4 {app: 'bbs', c} -- keep this in step with the protocol block at the top of
 * gateway/pbbs.js:
 *   hdr   {since}            -> {hi, me, bbs, rows: [[n, P/B, to, at, from, ts s, size, subj, flags, file?]], gone, more}
 *                               flags 1 = read by the addressee, 2 = from the packet network, 4 = sent by me,
 *                               8 = has a file, file = [name, bytes]; bbs.fileMax = biggest file the board takes
 *   read  {n: [..]}          -> {msgs: [[n, body | null]]}
 *   send  {t, to, at, subj, body} -> {n, bid, out: local | packet}
 *         with a file: the request IS the file -- KF kind 1 model BBSFILE, name = the file's name, body =
 *         'B' 'F' 01 | metaLen(2 BE) | meta JSON {t, to, at, subj, body} | file  -> {c: 'sent', ..., file: [name, bytes]}
 *   file  {n}                -> KF kind 1 model BBSFILE (the file; note {"n":12}) -- app.js rfReceived hands it to
 *                               fileReceived; an error comes back as kind 4 {c: 'file', n, error}
 *   kill  {n}                -> {n}
 *   push  {c: 'mail', rows}  new personal mail (Kelly parked in Transparent home); otherwise the gateway
 *                            texts "<call> BBS: new mail ..." and onP25Text below starts a sync
 * Headers are kept (store 'pbbs'); bodies are fetched when a message is opened, then kept too.
 *
 * Two ways to use it: the mailbox (tabs, categories, reader, composer) and the Terminal -- a classic
 * BBS prompt (L, LB, R n, SP, SB, K, H...) that types its answers at 300/1200/9600 baud with the Bell
 * 202 modem sound (1200/2200 Hz AFSK of the actual characters), so the mailbox actions double as
 * lessons in the commands. Effects: the path strip animates each request/answer, new mail gets the
 * "YOU HAVE MAIL" fanfare, unread mail flashes the nav badge.
 *
 * Files: attach one in the composer (or type D n at the prompt to download a message's file). Between Kelly
 * and the gateway a file is plain binary in a KF container (zlib, every byte CRC-checked); the gateway turns
 * it into 7PLUS parts for the packet network and joins 7PLUS files that arrive from it, so other packet
 * stations decode it with their own 7PLUS program. Downloaded files stay in memory for the session.
 *
 * window.KellyPbbsUI(ctx) -> { init, render, shown, gatewayReply, fileReceived, ownsXid, kfEvent, onP25Text }; ctx from app.js.
 */
(function () {
  'use strict';
  // the upload container's body (= dashboard pbbs.js packFile): 'B' 'F' 01 | metaLen(2 BE) | meta JSON | file
  function packFile(meta, data) {
    const j = new TextEncoder().encode(JSON.stringify(meta)), out = new Uint8Array(5 + j.length + data.length);
    out.set([0x42, 0x46, 1, j.length >> 8, j.length & 255], 0); out.set(j, 5); out.set(data, 5 + j.length);
    return out;
  }
  window.KellyPbbsUI = function (k) {
    const { $, esc, settings, store, toast, addEvent, dirty } = k;
    // auto check off by default: new mail is pushed to a parked Kelly, so polling would only spend airtime
    const ps = settings.pbbs = Object.assign({ baud: 1200, afsk: true, jingle: true, auto: 0 }, settings.pbbs || {});
    const save = () => k.saveSoon('settings');
    const ANSWER_MS = 120000, AIR_BPS = 380;
    const B0 = () => ({ hi: 0, rows: [], bodies: {}, read: {}, bbs: null, me: '', at: 0, sent: 0, got: 0, airDay: '', air: 0 });
    const b = Object.assign(B0(), store.get('pbbs', {}) || {});
    const ui = { tab: 'mail', cat: '', sel: null, ask: null, queue: [], err: '', tried: 0, compose: null, fresh: new Set(), flow: '' };
    // The demo radio gets its own make-believe board (demoGateway below), held in memory only.
    let mode = 'real';
    function ensureMode() {
      const m = k.demo() ? 'demo' : 'real';
      if (m === mode) return;
      mode = m;
      for (const x of Object.keys(b)) delete b[x];
      Object.assign(b, B0(), m === 'real' ? store.get('pbbs', {}) || {} : {});
      ui.sel = null; ui.ask = null; ui.queue = []; ui.err = '';
      for (const n of Object.keys(files)) { URL.revokeObjectURL(files[n].url); delete files[n]; }
    }
    const persist = () => {
      if (mode === 'demo') return;
      const keep = new Set(b.rows.slice(0, 400).map(r => r.n));
      b.rows = b.rows.slice(0, 400);
      for (const n of Object.keys(b.bodies)) if (!keep.has(+n)) delete b.bodies[n];
      let size = JSON.stringify(b.bodies).length;
      for (const r of [...b.rows].reverse()) { if (size < 800000) break; if (b.bodies[r.n]) { size -= b.bodies[r.n].length; delete b.bodies[r.n]; } }
      store.set('pbbs', b);
    };
    const base = c => String(c || '').toUpperCase().split('-')[0];
    const me = () => base(b.me || k.myCall());
    const bbsCall = () => (b.bbs && b.bbs.call) || 'P25X';
    const isRead = r => !!b.read[r.n] || (r.t === 'P' && r.readFlag && base(r.to) === me());
    const isMyMail = r => r.t === 'P' && base(r.to) === me();
    const unreadMail = () => b.rows.filter(r => isMyMail(r) && !isRead(r));
    const fromRow = a => ({ n: a[0], t: a[1], to: a[2], at: a[3], from: a[4], ts: a[5] * 1000, size: a[6], subj: a[7], readFlag: !!(a[8] & 1), pkt: !!(a[8] & 2), mine: !!(a[8] & 4),
      ...(a[8] & 8 && Array.isArray(a[9]) ? { file: { name: String(a[9][0]), size: +a[9][1] || 0 } } : {}) });
    // ---- files: downloaded ones live in memory for the session (n -> {name, data, url})
    const files = {};
    const FILE_MAX0 = 64 * 1024;
    const fileMax = () => (b.bbs && b.bbs.fileMax) || FILE_MAX0;
    const kB = n => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' };
    const mimeOf = name => MIME[(String(name).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
    const isImage = name => mimeOf(name).startsWith('image/');
    // A picture too big for the air -> a JPEG under `max` bytes: the longest side steps down from 1280 px and the
    // quality from 0.8 until it fits (JPEG, not WebP: packet stations at the far end of a 7PLUS file can open it).
    const PHOTO_TARGET = 40 * 1024;   // ~1.8 min on P25 at 380 B/s
    async function shrinkImage(file, max) {
      const bmp = await createImageBitmap(file);
      try {
        for (const side of [1280, 1024, 800, 640, 480, 360, 240]) {
          const s = Math.min(1, side / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);   // white behind any transparency
          for (const q of [0.8, 0.65, 0.5, 0.4]) {
            const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', q));
            if (blob && blob.size <= max) return { data: new Uint8Array(await blob.arrayBuffer()), w, h };
          }
        }
        throw new Error('still too big at 240 px');
      } finally { if (bmp.close) bmp.close(); }
    }
    function saveFile(n) {
      const f = files[n]; if (!f) return;
      const a = document.createElement('a');
      a.href = f.url; a.download = f.name; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 500);
    }
    function keepFile(n, name, data) {
      if (files[n] && files[n].url) URL.revokeObjectURL(files[n].url);
      files[n] = { name, data, url: URL.createObjectURL(new Blob([data], { type: mimeOf(name) })) };
    }
    const air = n => { const day = new Date().toDateString(); if (b.airDay !== day) { b.airDay = day; b.air = 0; } b.air += n; };
    const secs = (bytes, bps) => Math.max(1, Math.round(bytes / bps));
    const dd = ts => { const d = new Date(ts); return `${d.getDate()}-${d.toLocaleString('en', { month: 'short' })}`; };

    // ------------------------------------------------------------------ sound
    // Bell 202 AFSK (mark 1200 Hz, space 2200 Hz), the characters' own bits with start/stop -- what
    // 1200-baud packet sounded like on the speaker. Capped at ~2.5 s per burst; local effect only.
    function afsk(text, baud) {
      if (!settings.sound || !ps.afsk || !text || baud > 1200 || !baud) return;
      try {
        const ac = k.audioCtx(), t0 = ac.currentTime + 0.03, bit = 1 / baud;
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.connect(g); g.connect(ac.destination);
        const chars = text.slice(0, Math.floor(2.5 * baud / 10)), dur = chars.length * 10 * bit;
        g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.045 * settings.soundVol, t0 + 0.02);
        g.gain.setValueAtTime(0.045 * settings.soundVol, t0 + dur - 0.02); g.gain.linearRampToValueAtTime(0, t0 + dur);
        let t = t0;
        for (const ch of chars) {
          const c = ch.charCodeAt(0) & 0xFF, bits = [0, ...Array.from({ length: 8 }, (_, i) => (c >> i) & 1), 1];
          for (const v of bits) { o.frequency.setValueAtTime(v ? 1200 : 2200, t); t += bit; }
        }
        o.start(t0); o.stop(t0 + dur + 0.05);
      } catch {}
    }
    // "You have mail": a bright arpeggio and a bell, then a short packet burst.
    function fanfare() {
      if (!settings.sound || !ps.jingle) return;
      try {
        const ac = k.audioCtx(), t0 = ac.currentTime + 0.05;
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
          const o = ac.createOscillator(), g = ac.createGain(), t = t0 + i * 0.09;
          o.type = i === 4 ? 'sine' : 'triangle'; o.frequency.value = f; o.connect(g); g.connect(ac.destination);
          const len = i === 4 ? 0.9 : 0.22, v = (i === 4 ? 0.16 : 0.12) * settings.soundVol;
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0008, t + len);
          o.start(t); o.stop(t + len + 0.05);
        });
        setTimeout(() => afsk(`${bbsCall()} BBS MAIL`, 1200), 900);
      } catch {}
    }
    function blip(up) {   // a tiny chirp as a request leaves / an answer lands
      if (!settings.sound || !ps.afsk) return;
      try {
        const ac = k.audioCtx(), t = ac.currentTime + 0.01, o = ac.createOscillator(), g = ac.createGain();
        o.type = 'square'; o.connect(g); g.connect(ac.destination);
        o.frequency.setValueAtTime(up ? 1200 : 2200, t); o.frequency.setValueAtTime(up ? 2200 : 1200, t + 0.05);
        g.gain.setValueAtTime(0.03 * settings.soundVol, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.12);
        o.start(t); o.stop(t + 0.14);
      } catch {}
    }

    // ------------------------------------------------------------------ terminal
    // Output types at the chosen baud (10 bits a character, like async packet on a TNC) -- click it to
    // finish at once. Lines: {text, cls}; capped at 600 lines.
    const term = { q: [], cur: null, timer: null, last: 0, carry: 0, lines: 0 };
    const termEl = () => $('#pb-term');
    function out(text, cls = '') { term.q.push({ text: String(text) + '\n', cls }); pump(); }
    function pump() {
      if (term.timer) return;
      const step = () => {
        const el = termEl(); if (!el) { term.timer = null; return; }
        const end = el.scrollHeight - el.scrollTop - el.clientHeight < 40;   // scrolled up to read: new output doesn't pull you down
        const baud = +ps.baud || 0, instant = !baud || document.hidden || k.currentPage() !== 'pbbs' || !settings.fx;
        const now = performance.now(), dt = term.last ? now - term.last : 16; term.last = now;
        let budget = instant ? Infinity : term.carry + (baud / 10) * dt / 1000;
        while (budget >= 1 && (term.cur || term.q.length)) {
          if (!term.cur) {
            const item = term.q.shift();
            const span = document.createElement('span'); if (item.cls) span.className = item.cls; el.appendChild(span);
            term.cur = { item, span, i: 0 };
            if (!instant && item.text.trim()) afsk(item.text, baud);
          }
          const c = term.cur, take = Math.min(c.item.text.length - c.i, budget === Infinity ? 1e9 : Math.floor(budget));
          c.span.textContent += c.item.text.slice(c.i, c.i + take); c.i += take; budget -= take;
          if (c.i >= c.item.text.length) { term.cur = null; term.lines += (c.item.text.match(/\n/g) || []).length; }
        }
        term.carry = budget === Infinity ? 0 : budget;
        while (term.lines > 600 && el.firstChild) { term.lines -= ((el.firstChild.textContent || '').match(/\n/g) || []).length; el.removeChild(el.firstChild); }
        if (end) el.scrollTop = el.scrollHeight;
        if (term.cur || term.q.length) term.timer = setTimeout(step, 30); else { term.timer = null; term.last = 0; term.carry = 0; }
      };
      term.timer = setTimeout(step, 0);
    }
    function flushTerm() { const keep = ps.baud; ps.baud = 0; clearTimeout(term.timer); term.timer = null; pump(); setTimeout(() => { ps.baud = keep; }, 0); }
    const prompt = () => `de ${bbsCall()}>`;
    const pad = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length));
    function listLines(rows) {
      if (!rows.length) return ['No messages.'];
      return ['Msg#  TR  Size To     @BBS   From    Date   Title',
        ...rows.map(r => `${String(r.n).padStart(5)}${r.file ? '+' : ' '}${r.t}${r.t === 'B' ? '$' : isRead(r) ? 'Y' : 'N'} ${String(r.size + (r.file ? r.file.size : 0)).padStart(5)} ${pad(r.to, 6)} ${pad(r.at ? '@' + r.at : '', 6)} ${pad(r.from, 7)} ${dd(r.ts)} ${r.subj}`)];
    }
    const HELP = [
      'P25X PBBS commands (the classic set -- type one at the prompt):',
      '  L          list your new mail       LM   list all your mail',
      '  LB [CAT]   list bulletins (WX, SALE, NEWS...)   LL n  list the last n',
      '  R n        read message n           K n  kill (delete) message n',
      '  SP CALL    send personal mail       SP CALL @ BBS   via the packet network',
      '  SB CAT     send a bulletin          SB CAT @ WW     to the world',
      '  D n        download message n\'s file (attach one in ✍️ New message)',
      '  SYNC       check the gateway for new messages (over P25)',
      '  CLS        clear the screen         H    this help',
      'Message text ends with /EX on a line by itself (or Ctrl-Z) -- just like 1985.'];
    let tsend = null;   // an SP/SB in progress at the prompt: {t, to, at, step: 'title' | 'text', subj, lines}
    function command(line) {
      out(`${tsend ? '' : prompt() + ' '}${line}`, 'pb-echo');
      if (tsend) {
        if (tsend.step === 'title') { tsend.subj = line.trim() || '(no subject)'; tsend.step = 'text'; out('Enter Message Text (end with /EX or Ctrl-Z)', 'pb-sys'); return; }
        if (/^\/ex\s*$/i.test(line) || line === '\x1a') { const s = tsend; tsend = null; sendMsg({ t: s.t, to: s.to, at: s.at, subj: s.subj, body: s.lines.join('\n') }); return; }
        tsend.lines.push(line); return;
      }
      const [v0, ...a] = line.trim().split(/\s+/), v = (v0 || '').toUpperCase();
      const mineRows = () => b.rows.filter(isMyMail);
      if (!v) return;
      if (v === 'H' || v === '?' || v === 'HELP') HELP.forEach(l => out(l));
      else if (v === 'L') { const r = mineRows().filter(x => !isRead(x)); listLines(r).forEach(l => out(l)); cachedNote(); }
      else if (v === 'LM') { listLines(mineRows()).forEach(l => out(l)); cachedNote(); }
      else if (v === 'LB') { const c = (a[0] || '').toUpperCase(); listLines(b.rows.filter(r => r.t === 'B' && (!c || r.to === c)).slice(0, 40)).forEach(l => out(l)); cachedNote(); }
      else if (v === 'LL') listLines(b.rows.slice(0, Math.min(100, +a[0] || 20))).forEach(l => out(l));
      else if (v === 'R') { const n = +a[0]; if (!n) out('R needs a message number -- e.g. R 12', 'pb-err'); else openMsg(n, true); }
      else if (v === 'K') { const n = +a[0]; if (!n) out('K needs a message number', 'pb-err'); else killMsg(n); }
      else if (v === 'D' || v === 'YD') { const n = +a[0]; if (!n) out('D needs a message number -- e.g. D 12 (L shows a + on messages with a file)', 'pb-err'); else fetchFile(n, true); }
      else if (v === 'SP' || v === 'SB') {
        const rest = a.join(' ').toUpperCase(), m = rest.match(/^([A-Z0-9-]+)(?:\s*@\s*([A-Z0-9#.-]+))?$/);
        if (!m) { out(`${v} needs ${v === 'SP' ? 'a callsign' : 'a category'} -- e.g. ${v === 'SP' ? 'SP VK4XYZ' : 'SB WX @ QLD'}`, 'pb-err'); return; }
        tsend = { t: v === 'SB' ? 'B' : 'P', to: m[1], at: m[2] || '', step: 'title', lines: [] };
        out('Enter Title (only):', 'pb-sys');
      } else if (v === 'SYNC' || v === 'F' || v === 'N') sync(false);
      else if (v === 'CLS') { termEl().innerHTML = ''; term.lines = 0; }
      else if (v === 'B' || v === 'BYE') { out(`73 de ${bbsCall()} -- (Kelly keeps the board open; this is where you'd disconnect)`, 'pb-sys'); }
      else out(`Unknown command "${v}" -- H for help`, 'pb-err');
    }
    function cachedNote() { out(b.at ? `(Kelly's copy from ${k.fmtAgo(b.at)} -- SYNC asks the gateway)` : '(nothing from the gateway yet -- type SYNC)', 'pb-dim'); }
    function printMsg(r, body) {
      out(`From: ${r.from}\nTo: ${r.to}${r.at ? ' @ ' + r.at : ''}\nType/Status: ${r.t}${r.t === 'B' ? '$' : 'Y'}\nDate/Time: ${new Date(r.ts).toLocaleString('en-AU', { hour12: false })}\nTitle: ${r.subj}\n`, 'pb-hdr');
      out(body);
      if (r.file) out(`[File: ${r.file.name}, ${r.file.size} bytes -- D ${r.n} downloads it${r.pkt ? '; it crossed the packet network as 7PLUS' : ''}]`, 'pb-sys');
      out(`[End of Message #${r.n} from ${r.from}]`, 'pb-dim');
    }

    // ------------------------------------------------------------------ requests
    // One request on the air at a time (the radio's packet link); the rest wait in ui.queue.
    function ask(obj, label, onAnswer) {
      ui.queue.push({ obj, label, onAnswer });
      next();
    }
    async function next() {
      ensureMode();
      if (ui.ask || !ui.queue.length) return;
      if (mode === 'demo') {   // answered here, with the same timing shape as the air
        const q = ui.queue.shift(), xid = -Date.now();
        ui.err = ''; ui.ask = { ...q, at: Date.now(), xid }; flow('up'); air(JSON.stringify(q.obj).length + 40); dirty('pbbs');
        const up = q.obj.file ? q.obj.file.data.length : 0, down = q.obj.c === 'file' ? ((b.rows.find(r => r.n === q.obj.n) || {}).file || {}).size || 0 : 0;
        setTimeout(() => { if (ui.ask && ui.ask.xid === xid) kfEvent({ kind: 'tx-done' }); }, 1300 + Math.min(4000, up / 20));
        setTimeout(() => {
          if (!ui.ask || ui.ask.xid !== xid) return;
          const a = demoGateway(q.obj);
          if (a && a.demoFile) fileReceived({ name: a.demoFile.name, note: JSON.stringify({ n: q.obj.n }), body: a.demoFile.data });
          else gatewayReply({ app: 'bbs', ...a });
        }, 2600 + Math.min(4000, up / 20) + Math.min(5000, down / 15));
        return;
      }
      if (!k.radioConnected()) { ui.err = 'Connect the radio first -- Admin › Connect'; ui.queue = []; dirty('pbbs'); return; }
      if (k.rfBusy()) { setTimeout(next, 3000); return; }
      const q = ui.queue.shift();
      ui.err = '';
      ui.ask = { ...q, at: Date.now() };   // held across the await: a redraw meanwhile mustn't ask again
      flow('up');
      let xid;
      if (q.obj.file) {   // a send with a file: the upload container is the request
        const { file, ...meta } = q.obj;
        const body = packFile({ t: meta.t, to: meta.to, at: meta.at, subj: meta.subj, body: meta.body }, file.data);
        xid = await k.kfSendFile({ kind: 1, model: 'BBSFILE', name: file.name, body }, q.label);
        air(file.data.length + 200);
      } else {
        xid = await k.kfRequest({ op: 'bbs', ...q.obj }, q.label);
        air(JSON.stringify(q.obj).length + 40);
      }
      if (!xid) { ui.ask = null; ui.err = 'Could not send the request'; flow(''); dirty('pbbs'); return; }
      ui.ask.xid = xid;
      dirty('pbbs');
    }
    function done() { ui.ask = null; flow(''); dirty('pbbs'); setTimeout(next, 800); }
    function kfEvent(e) {
      if (!ui.ask) return;
      if (e.kind === 'tx-done') {
        ui.ask.delivered = Date.now(); blip(true); flow('wait');
        const xid = ui.ask.xid;
        // a file download takes its own airtime on top of the usual answer wait
        const fsize = ui.ask.obj.c === 'file' ? ((b.rows.find(r => r.n === ui.ask.obj.n) || {}).file || {}).size || 0 : 0;
        setTimeout(() => { if (ui.ask && ui.ask.xid === xid) { ui.err = 'The gateway took the request but never answered -- try again'; out(ui.err, 'pb-err'); done(); } }, ANSWER_MS + fsize / AIR_BPS * 1500);
      } else if (e.kind === 'tx-failed') { ui.err = e.cancelled ? '' : 'No answer from the P25X gateway'; if (ui.err) out(`*** ${ui.err}`, 'pb-err'); done(); }
      dirty('pbbs');
    }
    function gatewayReply(j) {
      ensureMode();
      air(JSON.stringify(j).length);
      blip(false); flow('down'); setTimeout(() => flow(''), 1600);
      if (j.c === 'mail') { gotMail((j.rows || []).map(fromRow), 'push'); return; }
      const a = ui.ask; ui.ask = null;
      if (j.error) { ui.err = j.error; out(`*** ${j.error}`, 'pb-err'); toast('📟', 'P25X PBBS', j.error, 'bad'); }
      else if (a && a.onAnswer) { try { a.onAnswer(j); } catch (e) { console.error('pbbs', e); } }
      else if (j.c === 'hdr') onHdr(j, true);
      dirty('pbbs');
      setTimeout(next, 800);
    }
    // A message's file from the gateway (KF kind 1 model BBSFILE -- already size- and CRC-checked by KF.decode).
    function fileReceived(f) {
      ensureMode();
      let n = 0; try { n = +JSON.parse(f.note || '{}').n || 0; } catch {}
      const a = ui.ask;
      if (a && a.obj.c === 'file' && (!n || a.obj.n === n)) { ui.ask = null; n = n || a.obj.n; }
      air(f.body.length);
      blip(false); flow('down'); setTimeout(() => flow(''), 1600);
      if (!n) return;
      keepFile(n, f.name || `file-${n}.bin`, f.body);
      const r = b.rows.find(x => x.n === n);
      if (r && !isRead(r)) { b.read[n] = 1; persist(); }
      out(`${f.name}: ${f.body.length} bytes received from ${bbsCall()}, every byte checked. Saved.`, 'pb-sys');
      toast('📎', `${f.name} downloaded`, `${kB(f.body.length)} from #${n} -- every byte checked`, 'good', () => saveFile(n));
      addEvent('data', `PBBS: file ${f.name} (${f.body.length} B) from #${n}`);
      saveFile(n);
      dirty('pbbs');
      setTimeout(next, 800);
    }

    // ------------------------------------------------------------------ demo gateway
    // The gateway's answers (= dashboard pbbs.js kellyOp) from a small make-believe board, for the demo
    // radio: a few bulletins from the packet world, one mail, and another mail 25 s after the first look.
    let demoDb = null;
    function demoGateway(o) {
      const meC = me() || 'VK4KEL', now = Date.now(), H = 3600e3;
      if (!demoDb) {
        const m = (t, to, at, from, h, subj, body, pkt) => ({ t, to, at, from, ts: now - h * H, subj, body, pkt, read: false });
        demoDb = { next: 1, msgs: [
          m('B', 'NEWS', 'VK', 'VK4BPQ', 70, 'Packet is alive and well in VK4', 'The LinBPQ network now links nodes from Cairns to the Gold Coast.\nTelnet, RF and now P25 users all share one mail system.\n\nde VK4BPQ', 1),
          m('B', 'SALE', 'AUS', 'VK2ABC', 50, 'FS: Tait TM8110 x2, UHF', 'Two TM8110s, UHF, 25 W, with looms and mics.\n$150 each or $280 the pair. Pick up Newcastle or post at cost.\nReply by packet mail.', 1),
          m('B', 'DX', 'WW', 'G4XYZ', 30, 'VK9L Lord Howe DXpedition next month', 'The VK9L team will be QRV on 40-10 m CW/SSB/FT8, plus a 2 m packet node.\nQSL via LoTW.', 1),
          m('B', 'NET', '', 'P25X', 20, 'Thursday P25X net, 7:30 pm', 'The weekly P25X net is on Thursday at 7:30 pm on every P25X repeater.\nCheck in with your callsign -- Kelly Page users, try sending a PBBS mail during the net!', 0),
          m('B', 'WX', 'QLD', 'VK4WX', 6, 'SEQ: storms likely this afternoon', 'Severe thunderstorms are likely over South East Queensland after 2 pm.\nLarge hail and damaging winds possible. Secure antennas!', 1),
          m('P', meC, '', 'VK4XYZ', 3, 'Sked on 40 m Saturday?', `Hi ${meC},\n\nAre you around for a sked on 7.090 Saturday 0800?\nI'll be portable with the FT-891.\n\n73 de VK4XYZ`, 1),
        ] };
        // two with files: a picture (shows in the reader) and a node list that came in as 7PLUS
        const te = new TextEncoder();
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#07101c"/>`
          + [[60, 120, 'VK4RBX'], [150, 60, 'VK4RMC'], [250, 110, 'VK4RGX'], [110, 40, 'VK4RES']].map(([x, y, c]) => `<line x1="150" y1="60" x2="${x}" y2="${y}" stroke="#00e5ff" stroke-width="2" stroke-dasharray="6 4"/><circle cx="${x}" cy="${y}" r="7" fill="#39ff88"/><text x="${x + 10}" y="${y + 4}" fill="#e6f1ff" font-family="monospace" font-size="12">${c}</text>`).join('')
          + `<text x="12" y="168" fill="#ff2bd6" font-family="monospace" font-size="12">P25X: Digital Voice. Total Data.</text></svg>`;
        const nodes = 'VK4 packet nodes (demo list)\r\n\r\nVK4RBX-10  Ipswich     LinBPQ  telnet + P25\r\nVK4BPQ-7   Brisbane    LinBPQ  RF 145.175\r\nVK4TTT-1   Toowoomba   JNOS    RF 147.575\r\n';
        demoDb.msgs.push(m('B', 'TECH', '', 'VK4XXX', 12, 'P25X network map', 'The repeaters and how they link, as a picture.\nOpen it, then Download.', 0));
        demoDb.msgs[demoDb.msgs.length - 1].file = { name: 'p25x-map.svg', data: te.encode(svg) };
        demoDb.msgs.push(m('B', 'NET', 'AUS', 'VK4BPQ', 9, 'VK4 packet node list', 'Current node list attached.\n\n[vk4nodes.txt: sent through the packet network as 1 7PLUS part and joined by the P25X gateway]', 1));
        demoDb.msgs[demoDb.msgs.length - 1].file = { name: 'vk4nodes.txt', data: te.encode(nodes) };
        demoDb.msgs.sort((x, y) => x.ts - y.ts);
        demoDb.msgs.forEach(x => { x.n = demoDb.next++; });
        setTimeout(() => {
          const x = { n: demoDb.next++, t: 'P', to: meC, at: '', from: 'VK4ABC', ts: Date.now(), subj: 'Coffee at the hamfest?', body: `G'day ${meC}!\n\nAre you coming to the hamfest on Sunday? Coffee's on me.\nBring the TM9100 -- I want to see Kelly's PBBS on the big screen.\n\n73`, pkt: 0, read: false };
          demoDb.msgs.push(x);
          if (mode === 'demo') gatewayReply({ app: 'bbs', c: 'mail', rows: [row(x)] });
        }, 25000);
      }
      function row(x) {
        const r = [x.n, x.t, x.to, x.at, x.from, Math.round(x.ts / 1000), x.body.length, x.subj, (x.read ? 1 : 0) | (x.pkt ? 2 : 0) | (base(x.from) === meC ? 4 : 0) | (x.file ? 8 : 0)];
        if (x.file) r.push([x.file.name, x.file.data.length]);
        return r;
      }
      const vis = x => x.t === 'B' || base(x.to) === meC || base(x.from) === meC;
      const live = demoDb.msgs.filter(x => !x.killed);
      const bbs = { call: 'P25X', name: 'P25X PBBS (demo)', welcome: 'Welcome to the P25X PBBS demo -- packet mail and bulletins over P25. Type H in the terminal for the classic commands.', cats: ['ALL', 'NEWS', 'WX', 'SALE', 'NET', 'DX', 'CLUB', 'TECH'], dists: ['WW', 'AUS', 'VK', 'QLD'], fileMax: FILE_MAX0 };
      if (o.c === 'hdr') return { c: 'hdr', at: now, bbs, me: meC, hi: demoDb.next - 1, rows: live.filter(x => x.n > (o.since || 0) && vis(x)).sort((a, z) => z.n - a.n).map(row), gone: [], more: false };
      if (o.c === 'read') return { c: 'msgs', msgs: o.n.map(n => { const x = live.find(y => y.n === n); if (x && vis(x)) { if (base(x.to) === meC) x.read = true; return [n, x.body]; } return [n, null]; }) };
      if (o.c === 'send') {
        if (o.file && o.file.data.length > bbs.fileMax) return { c: 'send', error: `That file is ${kB(o.file.data.length)} -- the board takes up to ${kB(bbs.fileMax)}` };
        const x = { n: demoDb.next++, t: o.t, to: o.to, at: o.at, from: meC, ts: now, subj: o.subj, body: o.body, pkt: 0, file: o.file ? { name: o.file.name, data: o.file.data } : null };
        demoDb.msgs.push(x);
        return { c: 'sent', n: x.n, bid: `${x.n}_P25X`, out: o.at ? 'packet' : 'local', to: x.to, at: x.at, ...(x.file ? { file: [x.file.name, x.file.data.length] } : {}) };
      }
      if (o.c === 'file') { const x = live.find(y => y.n === o.n); if (!x || !vis(x) || !x.file) return { c: 'file', n: o.n, error: `#${o.n} has no file for you` }; return { demoFile: x.file }; }
      if (o.c === 'kill') { const x = live.find(y => y.n === o.n); if (!x) return { c: 'kill', error: `No message #${o.n}` }; x.killed = 1; return { c: 'killed', n: x.n }; }
      return { c: o.c, error: 'Unknown request' };
    }

    // ------------------------------------------------------------------ actions
    function sync(auto) {
      if (ui.ask && ui.ask.obj.c === 'hdr') return;
      ui.tried = Date.now();
      if (!auto) out(`${prompt()} SYNC`, 'pb-echo'), out(`Asking ${bbsCall()} for messages since #${b.hi} over P25...`, 'pb-sys');
      ask({ c: 'hdr', since: b.hi }, b.hi ? `PBBS: new messages since #${b.hi}` : 'PBBS: the board', j => onHdr(j, auto));
    }
    function onHdr(j, auto) {
      const first = !b.at;
      b.bbs = j.bbs || b.bbs; b.me = j.me || ''; b.at = Date.now();
      const rows = (j.rows || []).map(fromRow), have = new Map(b.rows.map(r => [r.n, r]));
      const fresh = rows.filter(r => !have.has(r.n));
      for (const r of rows) have.set(r.n, Object.assign(have.get(r.n) || {}, r));
      for (const n of j.gone || []) { have.delete(n); delete b.bodies[n]; }
      b.rows = [...have.values()].sort((x, y) => y.n - x.n);
      b.hi = Math.max(b.hi, j.hi || 0);
      b.got += fresh.length;
      persist();
      fresh.forEach(r => ui.fresh.add(r.n)); setTimeout(() => { fresh.forEach(r => ui.fresh.delete(r.n)); dirty('pbbs'); }, 4000);
      const mail = fresh.filter(r => isMyMail(r) && !isRead(r)), bulls = fresh.filter(r => r.t === 'B');
      if (!b.me) out(`*** The gateway doesn't know your callsign yet, so personal mail can't reach you. Make a voice call, or ask the sysop.`, 'pb-err');
      if (first && b.bbs && b.bbs.welcome) out(b.bbs.welcome, 'pb-sys');
      out(`${fresh.length ? `${fresh.length} new: ${mail.length} mail, ${bulls.length} bulletin${bulls.length === 1 ? '' : 's'}` : 'No new messages'}${j.more ? ' (more on the gateway -- SYNC again)' : ''}. Latest is #${b.hi}.`, 'pb-sys');
      if (mail.length) gotMail(mail, 'sync');
      else if (bulls.length && !auto) toast('📢', `${bulls.length} new bulletin${bulls.length === 1 ? '' : 's'}`, bulls.slice(0, 3).map(r => r.subj).join(' · '), 'good', () => { k.showPage('pbbs'); ui.tab = 'bull'; dirty('pbbs'); });
      else if (!fresh.length && !auto) toast('📟', 'No new messages', `${bbsCall()} · latest #${b.hi}`, '');
      addEvent('data', `PBBS: ${fresh.length} new message(s) (${mail.length} mail) from ${bbsCall()}`);
      if (j.more) setTimeout(() => sync(true), 1500);
    }
    function gotMail(rows, how) {
      if (how === 'push') {
        const have = new Map(b.rows.map(r => [r.n, r]));
        rows.forEach(r => { if (!have.has(r.n)) { have.set(r.n, r); ui.fresh.add(r.n); } });
        b.rows = [...have.values()].sort((x, y) => y.n - x.n); b.hi = Math.max(b.hi, ...rows.map(r => r.n)); persist();
        out(`*** Mail for you from ${rows.map(r => r.from).join(', ')} -- pushed by ${bbsCall()}`, 'pb-sys');
      }
      const f = rows[0];
      fanfare();
      showMailFx(rows.length, f);
      toast('📬', rows.length > 1 ? `${rows.length} new mails` : `Mail from ${f.from}`, f.subj, 'good', () => { k.showPage('pbbs'); ui.tab = 'mail'; openMsg(f.n); });
      addEvent('data', `PBBS: mail from ${rows.map(r => r.from).join(', ')}`);
      dirty('pbbs');
    }
    function openMsg(n, toTerm) {
      const r = b.rows.find(x => x.n === n);
      ui.sel = n;
      if (!r && !toTerm) { dirty('pbbs'); return; }
      if (r && !isRead(r)) { b.read[n] = 1; persist(); }
      if (b.bodies[n] != null) { if (toTerm) printMsg(r, b.bodies[n]); dirty('pbbs'); return; }
      // fetch it, plus up to two more unread mails with no body yet (one trip on the air)
      const extra = b.rows.filter(x => x.n !== n && isMyMail(x) && !isRead(x) && b.bodies[x.n] == null).slice(0, 2).map(x => x.n);
      if (toTerm) out(`Fetching #${n} from ${bbsCall()} over P25...`, 'pb-sys');
      ask({ c: 'read', n: [n, ...extra] }, `PBBS: reading #${n}`, j => {
        for (const [m, body] of j.msgs || []) {
          if (body == null) { if (m === n) out(`Message #${m} isn't on the board (or isn't yours).`, 'pb-err'); continue; }
          b.bodies[m] = body;
          const rr = b.rows.find(x => x.n === m);
          if (m === n) { if (rr && toTerm) printMsg(rr, body); else if (!rr) out(body); }
        }
        persist();
      });
      dirty('pbbs');
    }
    // Download a message's file (or save it again if this session already has it)
    function fetchFile(n, toTerm) {
      const r = b.rows.find(x => x.n === n);
      if (files[n]) { if (toTerm) out(`${files[n].name}: saved again (Kelly already has it).`, 'pb-sys'); saveFile(n); return; }
      if (!r || !r.file) { out(`#${n} has no file${r ? '' : " (or Kelly hasn't seen it -- SYNC)"}.`, 'pb-err'); return; }
      if (ui.queue.some(q => q.obj.c === 'file' && q.obj.n === n) || (ui.ask && ui.ask.obj.c === 'file' && ui.ask.obj.n === n)) return;
      out(`Downloading ${r.file.name} (${kB(r.file.size)}, up to ~${secs(r.file.size + 200, AIR_BPS)} s) from ${bbsCall()} over P25...`, 'pb-sys');
      ask({ c: 'file', n }, `PBBS: downloading ${r.file.name}`, null);
      dirty('pbbs');
    }
    function killMsg(n) {
      out(`Killing #${n}...`, 'pb-sys');
      ask({ c: 'kill', n }, `PBBS: kill #${n}`, j => {
        b.rows = b.rows.filter(r => r.n !== j.n); delete b.bodies[j.n]; persist();
        if (ui.sel === j.n) ui.sel = null;
        out(`Msg #${j.n} killed.`, 'pb-sys'); toast('🗑️', `#${j.n} killed`, '', 'good');
      });
    }
    function sendMsg(m) {
      const bytes = (m.body || '').length + (m.subj || '').length + (m.file ? m.file.data.length : 0);
      out(`Sending to ${m.to}${m.at ? ' @ ' + m.at : ''}${m.file ? ` with ${m.file.name}` : ''} -- ${kB(bytes)}, ${m.file ? 'up to ' : ''}~${secs(bytes + 60, AIR_BPS)} s over P25...`, 'pb-sys');
      launch();
      const req = { c: 'send', t: m.t, to: m.to.toUpperCase(), at: (m.at || '').toUpperCase(), subj: m.subj, body: m.body, ...(m.file ? { file: m.file } : {}) };
      ask(req, `PBBS: ${m.t === 'B' ? 'bulletin' : 'mail'} to ${m.to}${m.file ? ` + ${m.file.name}` : ''}`, j => {
        b.sent++;
        const r = { n: j.n, t: m.t, to: j.to || m.to.toUpperCase(), at: j.at || '', from: me() || 'ME', ts: Date.now(), size: (m.body || '').length, subj: m.subj, mine: true, readFlag: false, pkt: false,
          ...(m.file ? { file: { name: (j.file && j.file[0]) || m.file.name, size: m.file.data.length } } : {}) };
        b.rows = [r, ...b.rows.filter(x => x.n !== r.n)]; b.bodies[r.n] = m.body; b.read[r.n] = 1; persist();
        if (m.file) keepFile(r.n, r.file.name, m.file.data);
        ui.fresh.add(r.n);
        out(`Message: ${j.n} Bid: ${j.bid} -- ${j.out === 'packet' ? `queued for the packet network via BPQ${m.file ? ' (the file goes as 7PLUS parts)' : ''}` : 'on the P25X board'}. 73!`, 'pb-sys');
        toast('🚀', `Sent as #${j.n}`, j.out === 'packet' ? `On its way to ${r.to} @ ${r.at} through the packet network` : `On the ${bbsCall()} board`, 'good');
        if (j.out === 'packet') flow('world');
      });
    }

    // ------------------------------------------------------------------ effects
    function flow(dir) { ui.flow = dir; const p = $('#pb-path'); if (p) p.dataset.flow = dir; }
    function launch() {
      if (!settings.fx) return;
      const btn = $('#pbc-send'), host = document.body;
      if (!btn) return;
      const r = btn.getBoundingClientRect(), el = document.createElement('div');
      el.className = 'pb-rocket'; el.textContent = '✉️';
      el.style.left = `${r.left + r.width / 2}px`; el.style.top = `${r.top}px`;
      host.appendChild(el); setTimeout(() => el.remove(), 1600);
    }
    function showMailFx(count, f) {
      const fx = $('#pb-mailfx'); if (!fx) return;
      $('#pb-mailfx-sub').textContent = `${count > 1 ? count + ' new mails · ' : ''}from ${f.from}: ${f.subj}`;
      fx.hidden = false; fx.classList.remove('go'); void fx.offsetWidth; fx.classList.add('go');
      clearTimeout(showMailFx.t); showMailFx.t = setTimeout(() => { fx.hidden = true; }, 6500);
    }

    // ------------------------------------------------------------------ compose
    function compose(pre = {}) {
      const c = $('#pb-compose'); if (!c) return;
      c.hidden = false;
      $('#pbc-t').value = pre.t || 'P';
      $('#pbc-to').value = pre.to || '';
      $('#pbc-at').innerHTML = `<option value="">${esc(bbsCall())} board only (stays on P25X)</option>` + ((b.bbs && b.bbs.dists) || ['WW', 'AUS', 'VK', 'QLD']).map(d => `<option value="${esc(d)}">@ ${esc(d)} -- packet network</option>`).join('');
      $('#pbc-at').value = pre.at || '';
      $('#pbc-subj').value = pre.subj || '';
      $('#pbc-body').value = pre.body || '';
      ui.cfile = null; ui.cfileErr = ''; ui.cfileNote = ''; $('#pbc-file').value = '';
      composeUi();
      setTimeout(() => (pre.to ? $('#pbc-body') : $('#pbc-to')).focus(), 50);
    }
    function composeUi() {
      const t = $('#pbc-t').value, cats = (b.bbs && b.bbs.cats) || ['ALL', 'NEWS', 'WX', 'SALE'];
      $('#pbc-to-l').textContent = t === 'B' ? 'Category' : 'To (callsign)';
      $('#pbc-to').placeholder = t === 'B' ? 'ALL' : 'VK4XYZ';
      $('#pbc-cats').hidden = t !== 'B';
      $('#pbc-cats').innerHTML = cats.map(c => `<button type="button" class="pb-chip ${$('#pbc-to').value.toUpperCase() === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
      const cf = ui.cfile;
      $('#pbc-fname').textContent = cf ? `📎 ${cf.name} · ${kB(cf.data.length)}${ui.cfileNote ? ` (${ui.cfileNote})` : ''}${$('#pbc-at').value ? ' · goes on as 7PLUS' : ''}`
        : ui.cfileErr ? `⚠️ ${ui.cfileErr}` : `Photos (shrunk to fit), logs, code plugs... up to ${kB(fileMax())} -- over the packet network it travels as 7PLUS`;
      $('#pbc-fname').classList.toggle('on', !!cf); $('#pbc-fname').classList.toggle('bad', !cf && !!ui.cfileErr); $('#pbc-fclear').hidden = !cf && !ui.cfileErr;
      const bytes = $('#pbc-body').value.length + $('#pbc-subj').value.length + 60 + (cf ? cf.data.length : 0), max = bytes / 30;
      const bar = (lbl, bps, cls) => { const s = secs(bytes, bps); return `<div class="pb-air ${cls}"><span>${lbl}</span><i style="--w:${Math.max(2, Math.min(100, bytes / bps / max * 100))}%"></i><b>${s < 90 ? s + ' s' : (s / 60).toFixed(1) + ' min'}</b></div>`; };
      $('#pbc-air').innerHTML = bar('P25 data', AIR_BPS, 'p25') + bar('1200 Bd packet', 120, 'k12') + bar('300 Bd HF packet', 30, 'k3');
      $('#pbc-bytes').textContent = `${bytes - 60} B`;
    }
    function composeSend() {
      const t = $('#pbc-t').value, to = $('#pbc-to').value.trim().toUpperCase() || (t === 'B' ? 'ALL' : ''), subj = $('#pbc-subj').value.trim(), body = $('#pbc-body').value.replace(/\r/g, '');
      if (!to) { toast('✍️', 'Who is it to?', 'A callsign for mail, a category for a bulletin', 'bad'); return; }
      if (t === 'B' ? !/^[A-Z0-9]{1,8}$/.test(to) : !/^[A-Z0-9]{3,7}(-\d{1,2})?$/.test(to)) { toast('✍️', t === 'B' ? 'Pick a category' : 'That callsign does not look right', to, 'bad'); return; }
      const file = ui.cfile;
      if (!subj || (!body.trim() && !file)) { toast('✍️', file ? 'Add a title' : 'Add a title and some text', '', 'bad'); return; }
      if (!file && ui.cfileErr && !confirm(`Your file wasn't attached:\n\n${ui.cfileErr}\n\nSend the message without it?`)) return;
      out(`${prompt()} ${t === 'B' ? 'SB' : 'SP'} ${to}${$('#pbc-at').value ? ' @ ' + $('#pbc-at').value : ''}`, 'pb-echo');
      out(`Title: ${subj}`, 'pb-dim'); out(body.split('\n').slice(0, 3).join('\n') + (body.split('\n').length > 3 ? '\n...' : '') + (file ? `\n[+ ${file.name}, ${file.data.length} bytes]` : '') + '\n/EX', 'pb-dim');
      sendMsg({ t, to, at: $('#pbc-at').value, subj, body, ...(file ? { file } : {}) });
      ui.cfile = null; ui.cfileErr = ""; ui.cfileNote = "";
      $('#pb-compose').hidden = true;
    }

    // ------------------------------------------------------------------ render
    function render() {
      const page = $('#page-pbbs'); if (!page) return;
      ensureMode();
      const um = unreadMail().length;
      const badge = $('#nb-pbbs');
      if (badge) { badge.textContent = um > 99 ? '99+' : um || ''; badge.classList.toggle('show', um > 0); badge.classList.toggle('pb-flash', um > 0); }
      if (k.currentPage() !== 'pbbs') return;
      $('#pb-bbs').textContent = b.bbs ? `${b.bbs.call} · ${b.bbs.name}` : 'P25X PBBS';
      $('#pb-when').textContent = b.at ? `checked ${k.fmtAgo(b.at)}` : 'not checked yet';
      $('#pb-welcome').textContent = (b.bbs && b.bbs.welcome) || 'Packet mail and bulletins over P25 -- press Check mail to dial in.';
      const asking = ui.ask ? (ui.ask.delivered ? '📡 Answering…' : '📡 Asking…') : '📡 Check mail';
      $('#pb-sync').textContent = asking; $('#pb-sync').disabled = !!ui.ask && ui.ask.obj.c === 'hdr';
      $('#pb-err').hidden = !ui.err; $('#pb-err').textContent = ui.err;
      $('#pb-q').textContent = ui.ask ? `${ui.ask.label}${ui.queue.length ? ` · ${ui.queue.length} waiting` : ''}` : '';
      const p = $('#pb-path'); p.dataset.flow = ui.flow; p.classList.toggle('pb-world', b.rows.some(r => r.pkt));
      const bulls = b.rows.filter(r => r.t === 'B'), pk = b.rows.filter(r => r.pkt).length;
      $('#pb-stats').innerHTML = [['📬', um, 'unread mail'], ['📢', bulls.length, 'bulletins'], ['🌍', pk, 'from packet'], ['📤', b.sent, 'sent'],
        ['⚡', `${(AIR_BPS / 120).toFixed(1)}×`, 'vs 1200 Bd'], ['📶', b.airDay === new Date().toDateString() ? `${(b.air / 1000).toFixed(1)} kB` : '0 kB', 'on air today']]
        .map(([i, v, l]) => `<div class="pb-stat"><i>${i}</i><b>${v}</b><span>${l}</span></div>`).join('');
      // tabs
      const mailRows = b.rows.filter(isMyMail), sentRows = b.rows.filter(r => r.mine || base(r.from) === me());
      $('#pb-tabs').innerHTML = [['mail', '📬 Mail', unreadMail().length], ['bull', '📢 Bulletins', bulls.filter(r => !isRead(r)).length], ['sent', '📤 Sent', 0]]
        .map(([t, l, n]) => `<button data-tab="${t}" class="${ui.tab === t ? 'on' : ''}">${l}${n ? ` <b class="pb-n">${n}</b>` : ''}</button>`).join('');
      const cats = [...new Set(bulls.map(r => r.to))].sort();
      $('#pb-cats').hidden = ui.tab !== 'bull';
      $('#pb-cats').innerHTML = ['', ...cats].map(c => { const n = bulls.filter(r => (!c || r.to === c) && !isRead(r)).length;
        return `<button class="pb-chip ${ui.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${c || 'All'}${n ? ` <b>${n}</b>` : ''}</button>`; }).join('');
      const rows = ui.tab === 'mail' ? mailRows : ui.tab === 'sent' ? sentRows : bulls.filter(r => !ui.cat || r.to === ui.cat);
      $('#pb-list').innerHTML = rows.slice(0, 150).map(r => `<li data-n="${r.n}" class="${isRead(r) ? '' : 'unread'} ${ui.sel === r.n ? 'sel' : ''} ${ui.fresh.has(r.n) ? 'fresh' : ''}">
        <span class="pb-ico">${r.t === 'B' ? '📢' : isRead(r) ? '📭' : '📬'}</span>
        <span class="pb-txt"><b>${esc(r.subj)}</b><small>#${r.n} · ${esc(ui.tab === 'sent' ? 'to ' + r.to + (r.at ? '@' + r.at : '') : r.t === 'B' ? r.to + ' · ' + r.from : r.from)} · ${k.fmtAgo(r.ts)} · ${r.size} B${r.file ? ` · <em class="pb-clip">📎 ${esc(r.file.name)}</em>` : ''}${r.pkt ? ' · <em class="pb-pkt">🌍 packet</em>' : ''}</small></span>
        ${isRead(r) ? '' : '<span class="pb-dot"></span>'}</li>`).join('')
        || `<li class="empty dim">${b.at ? (ui.tab === 'mail' ? 'No mail for you -- yet.' : ui.tab === 'sent' ? 'Nothing sent from this Kelly yet.' : 'No bulletins.') : 'Press 📡 Check mail to dial in to the board.'}</li>`;
      // reader
      const r = b.rows.find(x => x.n === ui.sel), body = r ? b.bodies[r.n] : null;
      $('#pb-reader').innerHTML = !r ? `<div class="pb-empty"><i>📟</i><p>Pick a message, or type <code>H</code> in the terminal below to learn the classic commands.</p></div>` :
        `<div class="pb-mh"><div><span>From</span><b>${esc(r.from)}</b></div><div><span>To</span><b>${esc(r.to)}${r.at ? ' @ ' + esc(r.at) : ''}</b></div>
          <div><span>Type</span><b>${r.t === 'B' ? 'Bulletin' : 'Personal'}${r.pkt ? ' · from the packet network' : ''}</b></div><div><span>Date</span><b>${new Date(r.ts).toLocaleString('en-AU', { hour12: false })}</b></div>
          <div class="pb-mt"><span>Title</span><b>${esc(r.subj)}</b></div></div>
         <pre class="pb-body">${body != null ? esc(body) : ui.ask && ui.ask.obj.c === 'read' ? '<span class="pb-loading">Fetching over P25…</span>' : '<span class="dim">Not fetched yet.</span>'}</pre>
         ${r.file ? (() => {
           const have = files[r.n], busy = !!(ui.ask && ui.ask.obj.c === 'file' && ui.ask.obj.n === r.n), queued = ui.queue.some(q => q.obj.c === 'file' && q.obj.n === r.n);
           return `${have && isImage(have.name) ? `<img class="pb-prev" src="${esc(have.url)}" alt="${esc(have.name)}">` : ''}
           <div class="pb-file ${busy ? 'busy' : ''}"><i>${isImage(r.file.name) ? '🖼️' : '📎'}</i>
             <span class="pb-fi"><b>${esc(r.file.name)}</b><small>${kB(r.file.size)}${r.pkt ? ' · came through the packet network as 7PLUS' : ''} · ${have ? 'downloaded, every byte checked' : busy ? '<span class="pb-loading">downloading over P25…</span>' : queued ? 'waiting its turn' : `up to ~${secs(r.file.size + 200, AIR_BPS)} s over P25`}</small></span>
             ${have ? '<button class="btn small" data-act="savefile">💾 Save again</button>' : busy || queued ? '' : `<button class="btn primary small" data-act="fetchfile">📡 Download</button>`}</div>`;
         })() : ''}
         <div class="row gap wrap">${body == null && !(ui.ask && ui.ask.obj.c === 'read') ? `<button class="btn primary small" data-act="fetch">📡 Fetch (${r.size} B, ~${secs(r.size + 40, AIR_BPS)} s)</button>` : ''}
           <button class="btn small" data-act="reply">↩️ Reply</button>${r.mine || isMyMail(r) || base(r.from) === me() ? '<button class="btn ghost small" data-act="kill">🗑️ Kill</button>' : ''}
           <button class="btn ghost small" data-act="term">🖥️ Read in terminal</button></div>`;
      $('#pb-prompt').textContent = tsend ? (tsend.step === 'title' ? 'Title:' : 'Text:') : prompt();
      $('#pb-baud').value = String(ps.baud); $('#pb-afsk').checked = !!ps.afsk; $('#pb-jingle').checked = !!ps.jingle; $('#pb-auto').value = String(ps.auto);
      // auto check -- by the last TRY, so a failing gateway isn't asked on every redraw
      if (ps.auto && k.radioConnected() && !ui.ask && Date.now() - Math.max(ui.tried, b.at) > ps.auto * 60000) sync(true);
    }
    // the badge + auto check also run when the page is closed
    setInterval(() => {
      if (ps.auto && k.radioConnected() && k.parked() && !ui.ask && !k.rfBusy() && Date.now() - Math.max(ui.tried, b.at) > ps.auto * 60000) sync(true);
      const n = unreadMail().length, t = document.title.replace(/^📬 \(\d+\) /, '');
      document.title = n ? `📬 (${n}) ${t}` : t;
    }, 60000);

    function init() {
      $('#pb-sync').onclick = () => sync(false);
      $('#pb-new').onclick = () => compose();
      $('#pb-auto').onchange = () => { ps.auto = +$('#pb-auto').value; save(); };
      $('#pb-tabs').onclick = e => { const t = e.target.closest('[data-tab]'); if (t) { ui.tab = t.dataset.tab; dirty('pbbs'); } };
      $('#pb-cats').onclick = e => { const c = e.target.closest('[data-cat]'); if (c) { ui.cat = c.dataset.cat; dirty('pbbs'); } };
      $('#pb-list').onclick = e => { const li = e.target.closest('[data-n]'); if (li) openMsg(+li.dataset.n); };
      $('#pb-reader').onclick = e => {
        const a = e.target.closest('[data-act]'), r = b.rows.find(x => x.n === ui.sel); if (!a || !r) return;
        if (a.dataset.act === 'fetch') openMsg(r.n);
        if (a.dataset.act === 'fetchfile') fetchFile(r.n);
        if (a.dataset.act === 'savefile') saveFile(r.n);
        if (a.dataset.act === 'term') { out(`${prompt()} R ${r.n}`, 'pb-echo'); openMsg(r.n, true); $('#pb-term').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        if (a.dataset.act === 'kill' && confirm(`Kill message #${r.n}? It goes from the board for everyone.`)) killMsg(r.n);
        if (a.dataset.act === 'reply') {
          const quote = (b.bodies[r.n] || '').split('\n').slice(0, 6).map(l => '> ' + l).join('\n');
          compose(r.t === 'B' ? { t: 'P', to: base(r.from), subj: `Re: ${r.subj}`.slice(0, 60), body: quote ? `${quote}\n\n` : '' }
            : { t: 'P', to: base(r.mine ? r.to : r.from), at: r.pkt ? '' : r.at, subj: (/^re:/i.test(r.subj) ? r.subj : `Re: ${r.subj}`).slice(0, 60), body: quote ? `${quote}\n\n` : '' });
        }
      };
      $('#pb-baud').onchange = () => { ps.baud = +$('#pb-baud').value; save(); };
      $('#pb-afsk').onchange = () => { ps.afsk = $('#pb-afsk').checked; save(); if (ps.afsk) afsk('CQ CQ DE KELLY', 1200); };
      $('#pb-jingle').onchange = () => { ps.jingle = $('#pb-jingle').checked; save(); if (ps.jingle) fanfare(); };
      $('#pb-term').onclick = () => flushTerm();
      $('#pb-cmd').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value; e.target.value = ''; command(v); dirty('pbbs'); }
        else if (e.key === 'z' && e.ctrlKey && tsend) { e.preventDefault(); e.target.value = ''; command('\x1a'); dirty('pbbs'); }
      });
      $('#pb-mailfx').onclick = () => { $('#pb-mailfx').hidden = true; k.showPage('pbbs'); ui.tab = 'mail'; const f = unreadMail()[0]; if (f) openMsg(f.n); };
      // composer
      $('#pbc-t').onchange = composeUi; $('#pbc-to').oninput = composeUi; $('#pbc-body').oninput = composeUi; $('#pbc-subj').oninput = composeUi;
      $('#pbc-cats').onclick = e => { const c = e.target.closest('[data-cat]'); if (c) { $('#pbc-to').value = c.dataset.cat; composeUi(); } };
      $('#pbc-at').onchange = composeUi;
      $('#pbc-file').onchange = async e => {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        ui.cfile = null; ui.cfileErr = ''; ui.cfileNote = '';
        const name = f.name.replace(/[^\x20-\x7e]/g, '_').slice(-60);
        if (!f.size) ui.cfileErr = `${name} is empty`;
        else if (f.size <= fileMax()) ui.cfile = { name, data: new Uint8Array(await f.arrayBuffer()) };
        else if (/^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i.test(f.name)) {
          // a photo straight off a phone is MBs: shrink it to fit the air (it's what P25 can carry)
          $('#pbc-fname').textContent = `📷 Shrinking ${name} (${kB(f.size)}) to fit the air…`;
          try {
            const r = await shrinkImage(f, Math.min(fileMax(), PHOTO_TARGET));
            ui.cfile = { name: name.replace(/\.[^.]*$/, '') + '.jpg', data: r.data };
            ui.cfileNote = `shrunk from ${kB(f.size)} to ${r.w}×${r.h}`;
          } catch (err) { ui.cfileErr = `${name} is ${kB(f.size)} and this browser can't shrink it (${err.message}) -- save it as a smaller JPEG first`; }
        } else ui.cfileErr = `${name} is ${kB(f.size)} -- the board takes files up to ${kB(fileMax())} (every byte goes over the air)`;
        if (ui.cfileErr) { e.target.value = ''; toast('📎', 'File not attached', ui.cfileErr, 'bad'); }
        else if (!$('#pbc-subj').value.trim()) $('#pbc-subj').value = ui.cfile.name.slice(0, 60);
        composeUi();
      };
      $('#pbc-fclear').onclick = () => { ui.cfile = null; ui.cfileErr = ''; ui.cfileNote = ''; $('#pbc-file').value = ''; composeUi(); };
      $('#pbc-cancel').onclick = () => { $('#pb-compose').hidden = true; };
      $('#pbc-send').onclick = composeSend;
      $('#pb-compose').onclick = e => { if (e.target.id === 'pb-compose') $('#pb-compose').hidden = true; };
      out(`*** KELLY PAGE PBBS TERMINAL ***`, 'pb-sys');
      out(`Connected to ${bbsCall()} via P25. H for help, SYNC to check for messages.`, 'pb-dim');
    }
    function shown() { dirty('pbbs'); if (!b.at || Date.now() - Math.max(b.at, ui.tried) > 10 * 60000) { if (k.radioConnected()) setTimeout(() => sync(true), 800); } }
    // A gateway text "<call> BBS: new mail ..." (radio not parked when the mail came in): fetch the headers.
    function onP25Text(m) {
      if (m && /\bBBS: (new mail|\d+ new mails)\b/.test(m.text || '') && !ui.ask) setTimeout(() => sync(true), 3000);
    }
    return { init, render, shown, gatewayReply, fileReceived, kfEvent, onP25Text, compose, ownsXid: xid => !!(ui.ask && ui.ask.xid === xid) };   // compose: the RTTY page opens a mail to the other op
  };
  window.KellyPbbsUI.packFile = packFile;   // tests: the exact upload Kelly sends
})();
