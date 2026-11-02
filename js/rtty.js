/* Kelly Page -- RTTY page: an old-school teleprinter over P25 packet data, with a real HF RTTY sound-card modem.
 *
 * The round table lives on the P25X gateway (dashboard rtty.js). Kelly asks over the Radio-files path (KF kind 3
 * {op: 'rtty', c}) and the gateway answers KF kind 4 {app: 'rtty', c} -- keep in step with the protocol block at the
 * top of gateway/rtty.js:
 *   join  {ch, since}         -> {c: 'joined', ch, me, chans: [[id, name, n, local]], rows, hi, gone, ops, until, motd, sprint, qsl, site}
 *   tx    {ch, text, since}   -> {c: 'sent', ch, seq, at, n, rows, hi, gone, qsl, until}   (+ hf: 1 for HF copy on channel HF)
 *   get   {ch, since}         -> {c: 'rows', ...}
 *   qrt / board / news {n?} / post {ch, t, to, subj, since} / spots
 *   push  {c: 'rx', ch, rows, hi, gone, qsl}     row = [seq, ts s, from, text, flags, site]; qsl = [[with, pts, ch, ts s, sprint]]
 * Over P25 an over is plain ASCII; the Baudot is Kelly's (js/baudot.js): every line is printed at the chosen baud
 * with the real FSK of its 5-bit codes and the clatter of a teleprinter (typebars, carriage return, line feed, bell,
 * the motor), so what you hear is what the line would have sounded like on HF. Art travels as tokens (js/rttyart.js).
 *
 * HF modem: the PC's sound card in and out -- decode real HF RTTY off the rig (AFC, squelch, crossed-ellipse tuning
 * scope, waterfall: click to tune) and key the rig's audio for HF overs (VOX on the rig; the licence is yours).
 * "Share my copy" posts decoded lines to the gateway's HF channel (receive-only relay; off by default).
 *
 * Game layer: js/rttyfun.js (RTTY Quest) gets events through F() -- a game bug never breaks the teleprinter.
 * window.KellyRttyUI(ctx) -> { init, render, shown, gatewayReply, kfEvent, ownsXid }; ctx from app.js.
 */
(function () {
  'use strict';
  window.KellyRttyUI = function (k) {
    const { $, $$, esc, settings, store, toast, addEvent, dirty } = k;
    const B = window.Baudot, ART = window.KellyArt;
    const MACROS = [
      ['CQ', 'CQ CQ CQ DE {MYCALL} {MYCALL} {MYCALL}\nCQ CQ CQ DE {MYCALL} {MYCALL} {MYCALL} PSE K'],
      ['ANS', '{CALL} {CALL} DE {MYCALL} {MYCALL} {MYCALL} KN'],
      ['QSO', '{CALL} DE {MYCALL} {GREET} OM ES TNX FER THE CALL.\nUR RST {RST} {RST}. NAME HR {NAME} {NAME}. QTH {QTH} {QTH}.\nHW CPY? {CALL} DE {MYCALL} KN'],
      ['BTU', 'BTU {CALL} DE {MYCALL} KN'],
      ['BRAG', 'RIG HR IS {RIG}. RTTY OVER P25X ON KELLY PAGE -- {QTH}, GRID {GRID}.\n{CALL} DE {MYCALL} KN'],
      ['73', '{CALL} TNX FER THE FB QSO {HISNAME}. 73 ES GUD DX.\n{CALL} DE {MYCALL} SK'],
      ['QRZ', 'QRZ? QRZ? DE {MYCALL} K'],
      ['RYRY', 'RYRYRYRYRYRYRYRYRYRYRYRYRYRYRYRYRYRY\nTHE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 1234567890\nDE {MYCALL} TEST'],
      ['TEST', '{CALL} 599 {NR} {NR} {MYCALL}'],
      ['TU', 'TU {CALL} 599 {NR} QRZ DE {MYCALL}'],
      ['QSL', '[QSL:{CALL}:{RST}]'],
      ['ID', 'DE {MYCALL} {MYCALL}'],
    ];
    const DEF = { ch: 'MAIN', machine: 'paper', baud: 45.45, shift: 170, mark: 2125, reverse: false, variant: 'us', usos: true, stop: 1.5,
      tones: 0.5, mech: 0.7, motor: 0.35, bellMine: true, noise: 0, cols: 72, poll: 0, name: '', qth: '', grid: '', rig: 'TAIT TM9100',
      hfShare: false, hfIn: '', hfOut: '', afc: true, sq: 0.4, hfTx: false, macros: null };
    const rs = settings.rtty = Object.assign({}, DEF, settings.rtty || {});
    if (!Array.isArray(rs.macros) || rs.macros.length !== 12) rs.macros = MACROS.map(([l, t]) => ({ l, t }));
    const save = () => k.saveSoon('settings');
    const ANSWER_MS = 90000, AIR_BPS = 380, LINE_MAX = 300, ROWS_KEEP = 150;
    const S0 = () => ({ chs: {}, log: [], tape: '', joined: null, me: '', chans: null, ops: [], sprint: null, motd: '', board: null, news: [], spots: null, nr: 1, mySeq: {}, air: 0, airDay: '', site: '' });
    const st = Object.assign(S0(), store.get('rtty', {}) || {});
    const ui = { tab: 'tty', ask: null, queue: [], err: '', unseen: {}, his: { call: '', name: '', qth: '', rstS: '599', rstR: '599', notes: '' }, demo: null, printedCh: null, motdShown: false, logEdit: null };
    let mode = 'real';
    let fun = null;   // RTTY Quest (js/rttyfun.js), made in init
    const F = (ev, d) => { try { if (fun) fun.event(ev, d || {}); } catch (e) { console.warn('rtty fun', e); } };
    function ensureMode() {
      const m = k.demo() ? 'demo' : 'real';
      if (m === mode) return;
      mode = m;
      for (const x of Object.keys(st)) delete st[x];
      Object.assign(st, S0(), m === 'real' ? store.get('rtty', {}) || {} : {});
      ui.ask = null; ui.queue = []; ui.err = ''; ui.printedCh = null; ui.demo = null;
      paperReset();
    }
    function persist() {
      if (mode === 'demo') return;
      for (const c of Object.values(st.chs)) if (c.rows.length > ROWS_KEEP) c.rows = c.rows.slice(-ROWS_KEEP);
      st.log = st.log.slice(-3000); st.tape = st.tape.slice(-4000);
      const keys = Object.keys(st.mySeq); if (keys.length > 400) for (const x of keys.slice(0, keys.length - 400)) delete st.mySeq[x];
      store.set('rtty', st);
    }
    const me = () => String(st.me || k.myCall() || (mode === 'demo' ? 'VK4KEL' : '')).toUpperCase();
    const chOf = id => st.chs[id] || (st.chs[id] = { hi: 0, rows: [] });
    const air = n => { const d = new Date().toDateString(); if (st.airDay !== d) { st.airDay = d; st.air = 0; } st.air += n; };
    const kB = n => n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
    const pad2 = n => String(n).padStart(2, '0');
    const utc = (ts = Date.now()) => { const d = new Date(ts); return `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`; };
    const hm = ts => new Date(ts).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
    const CALL_RE = /\b(?:[A-Z]{1,2}|\d[A-Z])\d[A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?\b/g;
    const charT = () => (6 + rs.stop) / (+rs.baud || 45.45);

    // ================================================================== sound
    // One graph on Kelly's shared AudioContext: FSK tones -> analyser (waterfall) -> out; mechanics + motor -> out.
    let ac = null, g = null;
    function audio() {
      if (!settings.sound) return null;
      try {
        ac = k.audioCtx(); if (!ac) return null;
        if (!g) {
          g = { out: ac.createGain(), tone: ac.createGain(), mech: ac.createGain(), motor: ac.createGain(), an: ac.createAnalyser() };
          g.an.fftSize = 4096; g.an.smoothingTimeConstant = 0.2;
          g.tone.connect(g.an); g.an.connect(g.out); g.mech.connect(g.out); g.motor.connect(g.out); g.out.connect(ac.destination);
          const n = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = n.getChannelData(0);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
          g.noise = n;
        }
        g.out.gain.value = settings.soundVol; g.tone.gain.value = rs.tones * 0.6; g.mech.gain.value = rs.mech; g.motor.gain.value = rs.motor;
        return ac;
      } catch { return null; }
    }
    function burst(t, { f = 2400, q = 3, len = 0.025, vol = 0.5, type = 'bandpass', sweep = 0 }) {
      const s = ac.createBufferSource(), fl = ac.createBiquadFilter(), v = ac.createGain();
      s.buffer = g.noise; fl.type = type; fl.frequency.setValueAtTime(f, t); if (sweep) fl.frequency.exponentialRampToValueAtTime(sweep, t + len); fl.Q.value = q;
      v.gain.setValueAtTime(vol, t); v.gain.exponentialRampToValueAtTime(0.0005, t + len);
      s.connect(fl); fl.connect(v); v.connect(g.mech); s.start(t, Math.random() * 0.8, len + 0.02);
    }
    function thunk(t, f = 160, len = 0.03, vol = 0.25) {
      const o = ac.createOscillator(), v = ac.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.6, t + len);
      v.gain.setValueAtTime(vol, t); v.gain.exponentialRampToValueAtTime(0.0005, t + len); o.connect(v); v.connect(g.mech); o.start(t); o.stop(t + len + 0.02);
    }
    function bell(t, vol = 0.35) {   // a struck bell: inharmonic partials, long decay
      for (const [m, a] of [[1, 1], [2.76, 0.45], [5.4, 0.2], [8.9, 0.08]]) {
        const o = ac.createOscillator(), v = ac.createGain(); o.frequency.value = 1180 * m;
        v.gain.setValueAtTime(vol * a, t); v.gain.exponentialRampToValueAtTime(0.0003, t + 1.4 / Math.sqrt(m)); o.connect(v); v.connect(g.mech); o.start(t); o.stop(t + 1.5);
      }
    }
    // what one code sounds like as the machine prints it
    function mech(t, kind) {
      if (!g || rs.mech <= 0) return;
      const r = Math.random();
      if (kind === 'key') { burst(t, { f: 1900 + r * 1400, q: 2.5, len: 0.022, vol: 0.55 }); thunk(t + 0.004, 150 + r * 60, 0.025, 0.18); }
      else if (kind === 'space') { burst(t, { f: 1200, q: 2, len: 0.016, vol: 0.22 }); }
      else if (kind === 'shift') { burst(t, { f: 700, q: 3, len: 0.03, vol: 0.25 }); thunk(t, 110, 0.04, 0.12); }
      else if (kind === 'cr') { burst(t, { f: 1600, q: 1.2, len: 0.26, vol: 0.3, sweep: 380 }); thunk(t + 0.26, 85, 0.07, 0.45); burst(t + 0.26, { f: 900, q: 2, len: 0.03, vol: 0.4 }); }
      else if (kind === 'lf') { burst(t, { f: 950, q: 4, len: 0.02, vol: 0.35 }); burst(t + 0.035, { f: 1050, q: 4, len: 0.02, vol: 0.28 }); }
      else if (kind === 'bell') bell(t);
      else if (kind === 'margin') bell(t, 0.12);
    }
    // The motor: a low hum and the gearing's whirr, up while the machine prints, off a few seconds after
    const motor = { on: false, nodes: null, off: null };
    function motorOn() {
      clearTimeout(motor.off); motor.off = setTimeout(motorOff, 4000);
      if (motor.on || !g || rs.motor <= 0) return;
      motor.on = true;
      const t = ac.currentTime, o = ac.createOscillator(), lp = ac.createBiquadFilter(), v = ac.createGain(), n = ac.createBufferSource(), bp = ac.createBiquadFilter(), nv = ac.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(20, t); o.frequency.linearRampToValueAtTime(58, t + 0.9);   // spin-up
      lp.type = 'lowpass'; lp.frequency.value = 260; v.gain.setValueAtTime(0, t); v.gain.linearRampToValueAtTime(0.09, t + 0.9);
      n.buffer = g.noise; n.loop = true; bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 1.5; nv.gain.setValueAtTime(0, t); nv.gain.linearRampToValueAtTime(0.05, t + 1.2);
      o.connect(lp); lp.connect(v); v.connect(g.motor); n.connect(bp); bp.connect(nv); nv.connect(g.motor);
      o.start(t); n.start(t);
      motor.nodes = { o, n, v, nv };
      led('motor', true);
    }
    function motorOff() {
      if (!motor.on) return;
      motor.on = false; led('motor', false);
      try { const t = ac.currentTime, x = motor.nodes; x.v.gain.linearRampToValueAtTime(0, t + 0.8); x.nv.gain.linearRampToValueAtTime(0, t + 0.8); x.o.frequency.linearRampToValueAtTime(12, t + 0.8); x.o.stop(t + 0.9); x.n.stop(t + 0.9); } catch {}
      motor.nodes = null;
    }

    // ================================================================== the teleprinter
    // A FIFO of items; each is printed a line at a time: the line's Baudot codes go out as one FSK buffer and each
    // character lands on the paper when its code has been "received" -- the same clock as the audio.
    const P = { q: [], busy: false, col: 0, lineEl: null, txtEl: null, timer: null, segs: null, dec: null, cur: null, lastActive: 0, audioEnd: 0, shift: 'L', lit: 1 };
    const paperEl = () => $('#rt-paper');
    function paperReset() { const p = paperEl(); if (p) p.innerHTML = ''; P.q = []; P.busy = false; P.lineEl = null; P.col = 0; clearTimeout(P.timer); P.timer = null; }
    function newLine(cls, who, seq) {
      const p = paperEl(); if (!p) return;
      const d = document.createElement('div'); d.className = `rt-ln rt-${cls || 'rx'}`; if (seq) d.dataset.seq = seq;
      if (who) { const w = document.createElement('span'); w.className = 'rt-who'; w.textContent = who; d.appendChild(w); }
      const t = document.createElement('span'); t.className = 'rt-txt'; d.appendChild(t);
      p.appendChild(d); P.lineEl = d; P.txtEl = t; P.col = 0;
      while (p.childElementCount > 500) p.removeChild(p.firstChild);
    }
    // finished line: callsigns become clickable (capture HIS CALL), my call is highlighted
    function finishLine() {
      const t = P.txtEl; if (!t || t.dataset.done) return;
      t.dataset.done = 1;
      const mine = me();
      t.innerHTML = esc(t.textContent).replace(CALL_RE, c => `<b class="rt-call${c === mine ? ' rt-mine' : ''}" data-call="${c}">${c}</b>`).replace(/\x07/g, '<i class="rt-bel">🔔</i>');
    }
    function print(text, opt = {}) {
      P.q.push({ text: String(text || ''), ...opt });
      if (!P.busy) nextItem();
    }
    function instantNow() { return !+rs.baud || document.hidden || k.currentPage() !== 'rtty'; }
    function nextItem() {
      const it = P.q.shift();
      if (!it) { P.busy = false; led('rx', false); led('tx', false); return; }
      P.busy = true; P.lastActive = Date.now(); anim();
      const ph = $('#rt-paper .rt-empty'); if (ph && !it.empty) ph.remove();   // the "nothing yet" note goes once anything prints
      if (P.q.length >= 4) it.instant = true;   // a long queue catches up: the older overs drop onto the paper at once
      if (it.sys) { newLine('sys'); if (it.empty) P.lineEl.classList.add('rt-empty'); P.txtEl.textContent = it.text; finishLine(); scroll(); setTimeout(nextItem, 0); return; }
      const vars = { from: it.from || me(), date: new Date().toISOString().slice(0, 10), time: `${utc()}Z` };
      let full = ART ? ART.expand(it.text, vars) : it.text;
      full = full.replace(/^\n+/, '');
      const lines = (rs.machine === 'ascii' ? full.toUpperCase().replace(/[^\x20-\x7e\n\x07]/g, '') : B.printable(full, rs.variant)).split('\n');
      it.segs = lines.map(l => l);
      it.si = 0; P.cur = it;
      newLine(it.cls, it.who, it.seq);
      led(it.cls === 'tx' ? 'tx' : 'rx', true);
      P.dec = new B.Decoder({ variant: rs.variant, usos: rs.usos });
      nextSeg(true);
    }
    function nextSeg(first) {
      const it = P.cur;
      if (it.si >= it.segs.length) {
        // the over's closing CR LF left an empty line: the next over starts its own (with its header)
        if (P.lineEl && P.lineEl.classList.contains('rt-cont') && !P.txtEl.textContent) { P.lineEl.remove(); P.lineEl = P.txtEl = null; }
        else finishLine();
        P.cur = null; P.timer = setTimeout(nextItem, 120); return;
      }
      const line = it.segs[it.si++];
      const codes = B.encode(`${line}\n`, { variant: rs.variant, usos: rs.usos, sync: first });
      if (rs.noise && it.cls !== 'tx' && it.cls !== 'sys') for (const c of codes) if (Math.random() < (rs.noise === 2 ? 0.03 : 0.008)) c.code ^= 1 << Math.floor(Math.random() * 5);   // RTTY "hits"
      const instant = instantNow() || it.instant;
      if (instant) { for (const c of codes) printCode(c.code, null); scroll(); nextSeg(false); return; }
      const a = audio(), ct = charT();
      let t0, at;
      if (a) {
        t0 = Math.max(a.currentTime + 0.04, P.audioEnd);
        const m = B.modulate(codes, { rate: a.sampleRate, baud: +rs.baud, mark: rs.mark, shift: rs.shift, reverse: rs.reverse, stop: rs.stop, amp: 0.5, lead: first ? 0.2 : 0, tail: 0 });
        if (rs.tones > 0) {
          const buf = a.createBuffer(1, m.samples.length, a.sampleRate); buf.copyToChannel(m.samples, 0);
          const s = a.createBufferSource(); s.buffer = buf; s.connect(g.tone); s.start(t0);
        }
        at = m.at.map(x => t0 + x / a.sampleRate);
        P.audioEnd = t0 + m.samples.length / a.sampleRate;
        motorOn();
        const td = new B.Decoder({ variant: rs.variant, usos: rs.usos }); td.shift = P.dec.shift;   // the shift each code will print in
        codes.forEach((c, i) => { const ch = td.push(c.code); mech(at[i] + ct, ch === '\x07' ? 'bell' : kindOf(c.code)); });
      } else { t0 = performance.now() / 1000 + 0.02; at = codes.map((c, i) => t0 + i * ct); }
      const clock = () => (a ? a.currentTime : performance.now() / 1000);
      let i = 0;
      const step = () => {
        const now = clock();
        if (instantNow()) { while (i < codes.length) printCode(codes[i++].code, null); }
        while (i < codes.length && now >= at[i] + ct) { printCode(codes[i].code, at[i]); i++; }
        // the current code's bit, for the LEDs and the tuning scope
        if (i < codes.length && now >= at[i]) { const b = Math.floor((now - at[i]) / (ct / (6 + rs.stop))); P.lit = b === 0 ? 0 : b <= 5 ? (codes[i].code >> (b - 1)) & 1 : 1; }
        else P.lit = 1;
        P.lastActive = Date.now();
        if (i >= codes.length) { scroll(); P.timer = setTimeout(() => nextSeg(false), 10); return; }
        scroll();
        P.timer = setTimeout(step, 25);
      };
      P.timer = setTimeout(step, 10);
    }
    const kindOf = c => (c === B.SP ? 'space' : c === B.CR ? 'cr' : c === B.LF ? 'lf' : c === B.LTRS || c === B.FIGS ? 'shift' : 'key');
    function printCode(code, t) {
      const ch = P.dec.push(code);
      P.shift = P.dec.shift; ledShift();
      tapePunch(code);
      if (!P.txtEl) newLine(P.cur ? P.cur.cls : 'rx');
      if (ch === '\x07') { P.txtEl.textContent += '\x07'; return; }   // the bell itself was scheduled with the line's sound
      if (ch === '\r') return;
      if (ch === '\n') { finishLine(); newLine(P.cur ? P.cur.cls : 'rx'); P.lineEl.classList.add('rt-cont'); return; }
      if (!ch) return;
      if (P.col >= rs.cols) { finishLine(); newLine(P.cur ? P.cur.cls : 'rx'); P.lineEl.classList.add('rt-cont'); if (t != null && g) mech(ac.currentTime, 'cr'); }
      P.txtEl.textContent += ch; P.col++;
      if (P.col === rs.cols - 8 && t != null && g) mech(ac.currentTime, 'margin');   // the margin bell, eight from the end
      chartLit(code);
    }
    function scroll() { const p = paperEl(); if (!p) return; if (p.scrollHeight - p.scrollTop - p.clientHeight < 140) p.scrollTop = p.scrollHeight; }
    // print a channel's stored history at once (no sound) -- after a reload or a channel change
    function reprint(ch) {
      paperReset();
      const c = chOf(ch);
      const rows = c.rows.slice(-40);
      if (!rows.length) print(`--- ${ch}: nothing yet. Type your over below and hit Enter. ---`, { sys: true, empty: true });
      for (const r of rows) print(r.text, { cls: clsOf(r), who: whoOf(r), seq: r.seq, instant: true, from: r.from });
      ui.printedCh = ch; ui.unseen[ch] = 0;
    }
    const clsOf = r => (r.mine ? 'tx' : r.flags & 1 ? 'gw' : r.flags & 2 ? 'hf' : 'rx');
    const whoOf = r => `${r.from}${r.site ? ` · ${r.site}` : ''} · ${hm(r.ts)}`;

    // ================================================================== paper tape (the last 400 codes as punched holes)
    const tape = { codes: [] };
    function tapePunch(code) { tape.codes.push(code); if (tape.codes.length > 400) tape.codes.shift(); tape.dirty = true; }
    function drawTape() {
      const cv = $('#rt-tape'); if (!cv || !tape.dirty || !cv.offsetParent) return; tape.dirty = false;
      const w = cv.width = cv.clientWidth * (devicePixelRatio || 1), h = cv.height = 54 * (devicePixelRatio || 1), x = cv.getContext('2d'), s = h / 7.2;
      x.fillStyle = '#e9d9a8'; x.fillRect(0, 0, w, h);
      const n = Math.floor(w / s), codes = tape.codes.slice(-n);
      codes.forEach((c, i) => {
        const cx = (i + 0.5) * s;
        x.fillStyle = '#8b7b55'; x.beginPath(); x.arc(cx, s * 3.6, s * 0.16, 0, 7); x.fill();   // the sprocket hole, between channels 2 and 3
        [0, 1, 2, 3, 4].forEach(b => { if ((c >> b) & 1) { const y = s * (b < 2 ? 1.6 + b : 2.6 + b); x.fillStyle = '#1b160d'; x.beginPath(); x.arc(cx, y, s * 0.36, 0, 7); x.fill(); } });
      });
    }

    // ================================================================== LEDs, chart, scope, waterfall
    function led(id, on) { const e = $(`#rt-led-${id}`); if (e) e.classList.toggle('on', !!on); }
    function ledShift() { led('ltrs', P.shift === 'L'); led('figs', P.shift === 'F'); }
    function chartLit(code) { const e = $('#rt-chart'); if (!e || !e.offsetParent) return; const o = e.querySelector('.lit'); if (o) o.classList.remove('lit'); const c = e.querySelector(`[data-code="${code}"]`); if (c) c.classList.add('lit'); }
    const scope = { v: 1, raf: 0, hfPts: null };
    function anim() { if (!scope.raf) scope.raf = requestAnimationFrame(frame); }
    function frame() {
      scope.raf = 0;
      const active = P.busy || hf.on || Date.now() - P.lastActive < 1500;
      led('mark', P.busy && P.lit === 1); led('space', P.busy && P.lit === 0);
      for (const id of ['rt-xy', 'rt-hfxy']) drawXy($(`#${id}`));
      for (const id of ['rt-wf', 'rt-hfwf']) drawWf($(`#${id}`));
      drawTape();
      if (active && !document.hidden) anim();   // only while something is printing or the HF receiver is on
    }
    function drawXy(cv) {
      if (!cv || !cv.offsetParent) return;
      const w = cv.width, h = cv.height, x = cv.getContext('2d'), R = w * 0.4;
      x.fillStyle = 'rgba(2, 10, 6, .28)'; x.fillRect(0, 0, w, h);
      x.strokeStyle = 'rgba(57, 255, 136, .18)'; x.lineWidth = 1; x.beginPath(); x.moveTo(w / 2, 6); x.lineTo(w / 2, h - 6); x.moveTo(6, h / 2); x.lineTo(w - 6, h / 2); x.stroke();
      x.strokeStyle = '#39ff88'; x.shadowColor = '#39ff88'; x.shadowBlur = 6; x.lineWidth = 1.6; x.beginPath();
      const pts = hf.on && cv.id === 'rt-hfxy' && hf.pts ? hf.pts : null;
      if (pts && pts.length > 4) {
        let mx = 1e-6; for (let i = 0; i < pts.length; i++) mx = Math.max(mx, Math.abs(pts[i]));
        for (let i = 0; i < pts.length; i += 2) { const px = w / 2 + pts[i] / mx * R, py = h / 2 - pts[i + 1] / mx * R; i ? x.lineTo(px, py) : x.moveTo(px, py); }
      } else if (P.busy) {
        scope.v += ((P.lit ? 1 : -1) - scope.v) * 0.35;   // mark = a flat ellipse, space = a tall one -- the classic cross
        const ax = R * (0.55 + 0.45 * scope.v), ay = R * (0.55 - 0.45 * scope.v), sk = 0.12 + Math.random() * 0.05;
        for (let i = 0; i <= 64; i++) { const a = i / 64 * 6.2832; const px = w / 2 + Math.cos(a) * ax, py = h / 2 - Math.sin(a) * Math.max(R * sk, ay); i ? x.lineTo(px, py) : x.moveTo(px, py); }
      }
      x.stroke(); x.shadowBlur = 0;
    }
    function drawWf(cv) {
      if (!cv || !cv.offsetParent) return;
      const an = hf.on && cv.id === 'rt-hfwf' ? hf.an : (g && g.an);
      if (!an) return;
      const w = cv.width, h = cv.height, x = cv.getContext('2d');
      const bins = new Uint8Array(an.frequencyBinCount); an.getByteFrequencyData(bins);
      const hz = ac.sampleRate / an.fftSize, lo = 1200, hi = 3200;
      x.drawImage(cv, 0, 1);   // scroll down a row
      const row = x.createImageData(w, 1);
      for (let i = 0; i < w; i++) {
        const v = bins[Math.round((lo + (hi - lo) * i / w) / hz)] / 255;
        const r = Math.min(255, v * 2.2 * 255 - 150), gg = Math.min(255, v * 1.6 * 255), b = Math.min(255, 70 + v * 300);
        row.data.set([Math.max(0, r), Math.max(0, gg), Math.max(0, b), 255], i * 4);
      }
      x.putImageData(row, 0, 0);
      // the tuned mark and space
      const t = B.tones({ mark: rs.mark + (hf.on && hf.dem ? hf.dem.afc : 0), shift: rs.shift, reverse: rs.reverse });
      x.fillStyle = 'rgba(255, 209, 102, .9)';
      for (const f of [t.mark, t.space]) x.fillRect(Math.round((f - lo) / (hi - lo) * w), 0, 1, 4);
    }

    // ================================================================== requests (one on the air at a time)
    function ask(obj, label, onAnswer) { ui.queue.push({ obj, label, onAnswer }); next(); dirty('rtty'); }
    async function next() {
      ensureMode();
      if (ui.ask || !ui.queue.length) return;
      if (mode === 'demo') {
        const q = ui.queue.shift(), xid = -Date.now();
        ui.ask = { ...q, at: Date.now(), xid }; air(JSON.stringify(q.obj).length + 40); led('p25', true); dirty('rtty');
        setTimeout(() => { if (ui.ask && ui.ask.xid === xid) gatewayReply({ app: 'rtty', ...demoGateway(q.obj) }); }, 2200 + Math.random() * 1500);
        return;
      }
      if (!k.radioConnected()) { ui.err = 'Connect the radio first -- Admin › Connect'; ui.queue = []; print(`*** ${ui.err}`, { sys: true }); dirty('rtty'); return; }
      if (k.rfBusy()) { setTimeout(next, 2500); return; }
      const q = ui.queue.shift();
      ui.err = ''; ui.ask = { ...q, at: Date.now() };
      led('p25', true);
      const xid = await k.kfRequest({ op: 'rtty', ...q.obj }, q.label);
      air(JSON.stringify(q.obj).length + 60);
      if (!xid) { ui.ask = null; ui.err = 'Could not send the request'; led('p25', false); print(`*** ${ui.err}`, { sys: true }); dirty('rtty'); return; }
      ui.ask.xid = xid; dirty('rtty');
    }
    function done() { ui.ask = null; led('p25', false); dirty('rtty'); setTimeout(next, 600); }
    function kfEvent(e) {
      if (!ui.ask) return;
      if (e.kind === 'tx-done') {
        ui.ask.delivered = Date.now();
        const xid = ui.ask.xid;
        setTimeout(() => { if (ui.ask && ui.ask.xid === xid) { ui.err = 'The gateway took it but never answered'; print(`*** ${ui.err} -- try again`, { sys: true }); done(); } }, ANSWER_MS);
      } else if (e.kind === 'tx-failed') { ui.err = e.cancelled ? '' : 'No answer from the P25X gateway'; if (ui.err) print(`*** ${ui.err}`, { sys: true }); if (ui.ask.obj.c === 'tx') markUnsent(ui.ask.obj); done(); }
      dirty('rtty');
    }
    function gatewayReply(j) {
      ensureMode();
      air(JSON.stringify(j).length + 60);
      if (j.c === 'rx') { onRows(j.ch, j); return; }   // a push: doesn't answer the request in flight
      const a = ui.ask; ui.ask = null; led('p25', false);
      if (j.error) {
        ui.err = j.error; print(`*** ${j.error}`, { sys: true }); toast('⌨️', 'P25X RTTY', j.error, 'bad');
        if (a && a.obj.c === 'tx') markUnsent(a.obj);
      } else if (a && a.onAnswer) { try { a.onAnswer(j); } catch (e) { console.error('rtty', e); } }
      else if (j.c === 'joined' || j.c === 'rows' || j.c === 'sent') onRows(j.ch, j);
      dirty('rtty');
      setTimeout(next, 600);
    }
    function markUnsent(obj) { const ln = [...$$('#rt-paper .rt-tx')].pop(); if (ln) ln.classList.add('rt-unsent'); F('unsent', obj); }

    // ================================================================== channel traffic
    function onRows(ch, j) {
      ch = ch || rs.ch;
      const c = chOf(ch), mine = me(), have = new Set(c.rows.map(r => r.seq));
      const fresh = [];
      for (const a of j.rows || []) {
        const r = { seq: a[0], ts: a[1] * 1000, from: a[2], text: a[3], flags: a[4] || 0, site: a[5] || '' };
        if (have.has(r.seq)) continue;
        r.mine = !!st.mySeq[r.seq] || (r.from === mine && !(r.flags & 1));
        c.rows.push(r); have.add(r.seq); if (!r.mine) fresh.push(r);
      }
      c.rows.sort((x, y) => x.seq - y.seq);
      c.hi = Math.max(c.hi || 0, j.hi || 0, ...c.rows.map(r => r.seq));
      for (const s of j.gone || []) { const i = c.rows.findIndex(r => r.seq === s); if (i >= 0) c.rows.splice(i, 1); const el = $(`#rt-paper [data-seq="${s}"]`); if (el) el.classList.add('rt-gone'); }
      if (j.ops) st.ops = j.ops;
      if (j.until) st.joined = { ch, until: j.until * 1000 };
      persist();
      const showing = ch === rs.ch && ui.printedCh === ch;
      for (const r of fresh) {
        if (showing) print(r.text, { cls: clsOf(r), who: whoOf(r), seq: r.seq, from: r.from, instant: j.c === 'joined' });   // a join's backlog lands at once; live overs print at speed
        else ui.unseen[ch] = (ui.unseen[ch] || 0) + 1;
        const named = mine && new RegExp(`\\b${mine}\\b`).test(String(r.text).toUpperCase());
        if (named && rs.bellMine) {   // SELCAL: my call on the paper rings the bell, wherever Kelly is
          if (audio() && g) { bell(ac.currentTime + 0.05, 0.4); bell(ac.currentTime + 0.45, 0.3); }
          if (k.currentPage() !== 'rtty' || document.hidden) toast('🔔', `${r.from} is calling you on RTTY ${ch}`, String(r.text).slice(0, 90), 'good', () => { k.showPage('rtty'); });
        } else if (k.currentPage() !== 'rtty') toast('⌨️', `RTTY ${ch}: ${r.from}`, String(r.text).slice(0, 90), '', () => k.showPage('rtty'));
        F('rx', { r, ch, named });
      }
      if (fresh.length) { addEvent('data', `RTTY ${ch}: ${fresh.length} over(s) from ${[...new Set(fresh.map(r => r.from))].join(', ')}`); if (k.currentPage() !== 'rtty') bumpBadge(fresh.length); }
      for (const q of j.qsl || []) gotQsl(q);
      dirty('rtty');
    }
    function bumpBadge(n) { ui.badge = (ui.badge || 0) + n; const b = $('#nb-rtty'); if (b) { b.textContent = ui.badge > 99 ? '99+' : ui.badge; b.classList.add('show'); } }
    function join(ch, quiet) {
      ch = String(ch || rs.ch).toUpperCase();
      if (ui.ask && ui.ask.obj.c === 'join' && ui.ask.obj.ch === ch) return;
      if (!quiet) print(`--- QRV ${ch}: tuning in to the P25X gateway over P25... ---`, { sys: true });
      ask({ c: 'join', ch, since: chOf(ch).hi || 0 }, `RTTY: join ${ch}`, j => {
        st.me = j.me || st.me; st.chans = j.chans || st.chans; st.motd = j.motd || st.motd; st.sprint = j.sprint || st.sprint; st.site = j.site || st.site;
        if (!j.me) print('*** The gateway does not know your callsign yet -- you can read, but make a voice call first so it can put your call on your overs.', { sys: true });
        if (st.motd && !ui.motdShown) { ui.motdShown = true; print(st.motd, { cls: 'gw', who: 'P25X · MOTD' }); }
        onRows(j.ch, j);
        print(`--- ${j.ch}: ${(j.ops || []).length ? `heard in the last hour: ${j.ops.join(' ')}` : 'quiet in the last hour -- call CQ!'} ---`, { sys: true });
        F('join', { ch: j.ch });
      });
    }
    function poll() { ask({ c: 'get', ch: rs.ch, since: chOf(rs.ch).hi || 0 }, `RTTY: new overs on ${rs.ch}`, j => onRows(j.ch, j)); }
    function switchCh(ch) {
      ch = String(ch).toUpperCase();
      if (ch === rs.ch && st.joined && st.joined.ch === ch && st.joined.until > Date.now()) return;
      rs.ch = ch; save(); reprint(ch); join(ch); dirty('rtty');
    }

    // ================================================================== sending
    const greet = () => { const h = new Date().getHours(); return h < 12 ? 'GM' : h < 18 ? 'GA' : 'GE'; };
    function fillVars(t) {
      const his = ui.his;
      return String(t).replace(/\{(MYCALL|CALL|NAME|QTH|GRID|RIG|RST|NR|GREET|TIME|DATE|HISNAME)\}/g, (a, v) => ({
        MYCALL: me() || 'NOCALL', CALL: his.call || 'QRZ', NAME: rs.name || 'OP', QTH: rs.qth || 'QLD', GRID: rs.grid || 'QG62', RIG: rs.rig || 'KELLY PAGE',
        RST: his.rstS || '599', NR: String(st.nr).padStart(3, '0'), GREET: greet(), TIME: `${utc()}Z`, DATE: new Date().toISOString().slice(0, 10), HISNAME: his.name || 'OM',
      })[v]);
    }
    function sendOver(raw, opt = {}) {
      ensureMode();
      const usedNr = /\{NR\}/.test(raw);
      let text = fillVars(raw).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) return false;
      if (text.length > LINE_MAX) { toast('⌨️', 'That over is too long', `${text.length} characters -- ${LINE_MAX} at most; send it in two`, 'bad'); return false; }
      if (usedNr) { st.nr++; }
      text = text.toUpperCase();
      print(text, { cls: 'tx', who: `${me() || 'ME'} · ${hm(Date.now())}`, from: me() });
      if (hf.on && rs.hfTx) hfTransmit(text);
      if (opt.hfOnly) return true;
      const ch = rs.ch;
      ask({ c: 'tx', ch, text, since: chOf(ch).hi || 0 }, `RTTY: over on ${ch}`, j => {
        st.mySeq[j.seq] = 1;
        const c = chOf(ch); c.rows.push({ seq: j.seq, ts: j.at * 1000, from: me(), text, flags: 0, site: st.site, mine: true });
        onRows(ch, j);
        if (j.n === 0) print(`--- sent; nobody else listening on ${ch} just now. It waits there for the next station. ---`, { sys: true });
        F('tx', { text, ch, n: j.n });
      });
      F('send', { text, ch });
      persist();
      return true;
    }

    // ================================================================== QSOs + logbook
    function gotQsl(q) {
      const [call, pts, ch, ts, sprint] = q, when = ts * 1000, day = new Date(when).toISOString().slice(0, 10);
      let e = st.log.find(x => x.call === call && new Date(x.ts).toISOString().slice(0, 10) === day && x.band === 'P25X');
      if (!e) { e = { id: `q${when}${call}`, ts: when, call, name: '', qth: '', rstS: '599', rstR: '599', band: 'P25X', ch, notes: '', auto: true }; st.log.push(e); }
      e.confirmed = true; e.pts = pts; e.sprint = !!sprint;
      persist();
      print(`*** QSO CONFIRMED BY THE GATEWAY: ${me()} <> ${call} ON ${ch} -- ${pts} POINT${pts > 1 ? 'S' : ''}${sprint ? ' (SPRINT)' : ''} ***`, { sys: true });
      toast('✅', `QSO with ${call} confirmed`, `+${pts} point${pts > 1 ? 's' : ''}${sprint ? ' · sprint' : ''} · in your logbook`, 'good', () => { k.showPage('rtty'); ui.tab = 'log'; dirty('rtty'); });
      if (audio() && g) { bell(ac.currentTime + 0.05, 0.3); bell(ac.currentTime + 0.3, 0.3); bell(ac.currentTime + 0.55, 0.38); }
      F('qsl', { call, pts, ch, sprint: !!sprint, ts: when });
    }
    function logQso() {
      const h = ui.his; if (!h.call) { toast('📒', 'Who was it?', 'Type or click a callsign first', 'bad'); return; }
      st.log.push({ id: `m${Date.now()}`, ts: Date.now(), call: h.call, name: h.name, qth: h.qth, rstS: h.rstS, rstR: h.rstR, band: hf.on ? 'HF' : 'P25X', ch: hf.on ? `${(rs.mark / 1000).toFixed(3)} kHz audio` : rs.ch, notes: h.notes });
      persist(); toast('📒', `${h.call} logged`, `${st.log.length} QSOs in your logbook`, 'good');
      F('log', { call: h.call, name: h.name, qth: h.qth }); dirty('rtty');
    }
    function worked(call) { return st.log.filter(x => x.call === call); }
    function adif() {
      const f = (n, v) => (v == null || v === '' ? '' : `<${n}:${String(v).length}>${v}`);
      const rows = st.log.map(e => { const d = new Date(e.ts); return [f('CALL', e.call), f('QSO_DATE', d.toISOString().slice(0, 10).replace(/-/g, '')), f('TIME_ON', d.toISOString().slice(11, 16).replace(':', '')),
        f('MODE', 'RTTY'), f('RST_SENT', e.rstS), f('RST_RCVD', e.rstR), f('NAME', e.name), f('QTH', e.qth), f('STATION_CALLSIGN', me()),
        e.band === 'P25X' ? f('COMMENT', `P25X RTTY ${e.ch || ''} over P25 data${e.confirmed ? ' (gateway-confirmed)' : ''}`) : f('COMMENT', `HF RTTY ${e.ch || ''}`), f('NOTES', e.notes), '<EOR>'].join(' '); });
      return `Kelly Page RTTY logbook\n<ADIF_VER:5>3.1.4 <PROGRAMID:10>Kelly Page <EOH>\n${rows.join('\n')}\n`;
    }
    function download(name, text, type = 'text/plain') {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
    }

    // ================================================================== HF modem (sound card)
    const hf = { on: false, stream: null, src: null, proc: null, sink: null, dem: null, dec: null, an: null, line: '', lastAt: 0, chars: 0, pts: null, shareT: null, outEl: null, outDest: null, prefixes: new Set() };
    async function hfStart() {
      try {
        const a = k.audioCtx(); if (!a) throw new Error('No audio on this browser');
        ac = a; if (a.state === 'suspended') await a.resume();
        hf.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: rs.hfIn ? { exact: rs.hfIn } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        hf.src = a.createMediaStreamSource(hf.stream);
        hf.an = a.createAnalyser(); hf.an.fftSize = 4096; hf.an.smoothingTimeConstant = 0.2; hf.src.connect(hf.an);
        hf.dem = new B.Demod({ rate: a.sampleRate, baud: +rs.baud || 45.45, mark: rs.mark, shift: rs.shift, reverse: rs.reverse, squelch: rs.sq, afc: rs.afc });
        hf.dec = new B.Decoder({ variant: rs.variant, usos: rs.usos });
        hf.proc = a.createScriptProcessor(4096, 1, 1); hf.sink = a.createGain(); hf.sink.gain.value = 0;
        hf.src.connect(hf.proc); hf.proc.connect(hf.sink); hf.sink.connect(a.destination);
        hf.proc.onaudioprocess = e => {
          const codes = hf.dem.process(e.inputBuffer.getChannelData(0));
          hf.pts = hf.dem.takeScope();
          for (const c of codes) hfChar(hf.dec.push(c));
        };
        hf.on = true; anim(); hfScreen(`--- HF receiver on: ${rs.baud} Bd, ${rs.shift} Hz shift, mark ${rs.mark} Hz${rs.reverse ? ', reverse' : ''}. Tune the rig so the crossed ellipses stand up straight. ---`, 'sys');
        hfDevices();
        F('hfon', {});
      } catch (e) { toast('🎙️', 'HF receiver did not start', e.message, 'bad'); hfStop(); }
      dirty('rtty');
    }
    function hfStop() {
      try { if (hf.proc) { hf.proc.onaudioprocess = null; hf.proc.disconnect(); } if (hf.src) hf.src.disconnect(); if (hf.stream) hf.stream.getTracks().forEach(t => t.stop()); } catch {}
      Object.assign(hf, { on: false, stream: null, src: null, proc: null, an: null, pts: null });
      hfFlush(); dirty('rtty');
    }
    function hfRetune() { if (hf.dem) hf.dem.set({ baud: +rs.baud || 45.45, mark: rs.mark, shift: rs.shift, reverse: rs.reverse }); if (hf.dem) { hf.dem.squelch = rs.sq; hf.dem.afcOn = rs.afc; } if (hf.dec) { hf.dec.variant = rs.variant; hf.dec.usos = rs.usos; } }
    let hfEl = null;
    function hfScreen(text, cls) { const s = $('#rt-hfscreen'); if (!s) return; const d = document.createElement('div'); d.className = `rt-hl rt-${cls}`; d.textContent = text; s.appendChild(d); hfEl = null; while (s.childElementCount > 400) s.removeChild(s.firstChild); s.scrollTop = s.scrollHeight; }
    function hfChar(ch) {
      if (!ch || ch === '\r') return;
      const s = $('#rt-hfscreen');
      if (ch === '\n' || hf.line.length >= 68) { hfFlush(); if (ch === '\n') return; }
      if (s && !hfEl) { hfEl = document.createElement('div'); hfEl.className = 'rt-hl rt-hf'; s.appendChild(hfEl); }
      if (hfEl) { const end = s.scrollHeight - s.scrollTop - s.clientHeight < 60; hfEl.textContent += ch; if (end) s.scrollTop = s.scrollHeight; }
      hf.line += ch; hf.chars++; hf.lastAt = Date.now();
      clearTimeout(hf.shareT); hf.shareT = setTimeout(hfFlush, 4000);
      if (hf.chars % 20 === 0) F('hfcopy', { n: 20 });
    }
    // a finished HF line: clickable calls, prefixes for the DX trophy, and (if shared) up to the gateway's HF channel
    function hfFlush() {
      const line = hf.line.trim(); hf.line = '';
      if (hfEl) { hfEl.innerHTML = esc(hfEl.textContent).replace(CALL_RE, c => `<b class="rt-call" data-call="${c}">${c}</b>`); hfEl = null; }
      if (!line) return;
      for (const c of line.match(CALL_RE) || []) { const p = c.match(/^(\d?[A-Z]{1,2})/); if (p) hf.prefixes.add(p[1]); }
      F('hfline', { line, prefixes: hf.prefixes.size });
      const good = (line.match(/[A-Z0-9 ]/g) || []).length / line.length;
      if (rs.hfShare && line.length >= 10 && good > 0.8 && /\b[A-Z]{2,}\b/.test(line)) {
        ask({ c: 'tx', ch: 'HF', text: line, hf: 1, since: chOf('HF').hi || 0 }, 'RTTY: HF copy to the gateway', j => { onRows('HF', j); F('hfshare', {}); });
      }
    }
    async function hfDevices() {
      try {
        const ds = await navigator.mediaDevices.enumerateDevices();
        const opt = (kind, cur) => `<option value="">Default</option>` + ds.filter(d => d.kind === kind).map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || d.kind)}</option>`).join('');
        if ($('#rt-hfin')) $('#rt-hfin').innerHTML = opt('audioinput', rs.hfIn);
        if ($('#rt-hfout')) $('#rt-hfout').innerHTML = opt('audiooutput', rs.hfOut);
      } catch {}
    }
    // HF transmit: the audio for the rig (VOX keys it). Diddles (LTRS) first so the far end's machine syncs.
    async function hfTransmit(text) {
      try {
        const a = k.audioCtx(); if (!a) return;
        const full = ART ? ART.expand(text, { from: me(), date: new Date().toISOString().slice(0, 10), time: `${utc()}Z` }) : text;
        const codes = [B.LTRS, B.LTRS, B.LTRS, B.LTRS].map(c => ({ code: c, i: -1 })).concat(B.encode(`\n${full}\n`, { variant: rs.variant, usos: rs.usos }));
        const m = B.modulate(codes, { rate: a.sampleRate, baud: +rs.baud || 45.45, mark: rs.mark, shift: rs.shift, reverse: rs.reverse, stop: rs.stop, amp: 0.7, lead: 0.6, tail: 0.3 });
        const buf = a.createBuffer(1, m.samples.length, a.sampleRate); buf.copyToChannel(m.samples, 0);
        const s = a.createBufferSource(); s.buffer = buf;
        if (!hf.outDest) { hf.outDest = a.createMediaStreamDestination(); hf.outEl = new Audio(); hf.outEl.srcObject = hf.outDest.stream; }
        if (rs.hfOut && hf.outEl.setSinkId) { try { await hf.outEl.setSinkId(rs.hfOut); } catch {} }
        await hf.outEl.play().catch(() => {});
        s.connect(hf.outDest); s.start();
        led('hftx', true); setTimeout(() => led('hftx', false), m.samples.length / a.sampleRate * 1000);
        hfScreen(`>>> TX ${full.replace(/\n/g, ' / ').slice(0, 120)}`, 'tx');
        F('hftx', { len: full.length });
      } catch (e) { toast('📻', 'HF transmit failed', e.message, 'bad'); }
    }

    // ================================================================== demo gateway (= dashboard rtty.js kellyOp, make-believe)
    function demoGateway(o) {
      const meC = me() || 'VK4KEL', now = Date.now();
      if (!ui.demo) {
        const D = ui.demo = { seq: 0, rows: {}, mentions: {}, qsos: new Set(), pushes: 0, board: [['VK4ABC', 42, 19, 11, 4, 12, 6], ['VK4XYZ', 31, 15, 9, 3, 8, 3], ['VK2RTY', 22, 11, 8, 2, 5, 2], ['VK4TTY', 9, 5, 4, 1, 3, 1]] };
        const add = (ch, from, text, flags = 0, site = 'VK4RBX', ago = 0) => { const r = [++D.seq, Math.round((now - ago) / 1000), from, text, flags, site]; (D.rows[ch] || (D.rows[ch] = [])).push(r); return r; };
        add('MAIN', 'VK4ABC', 'CQ CQ CQ DE VK4ABC VK4ABC VK4ABC PSE K', 0, 'VK4RBX', 900e3);
        add('MAIN', 'VK4XYZ', 'VK4ABC DE VK4XYZ GE BILL. UR 599. NAME SUE QTH THE GAP. BTU VK4ABC DE VK4XYZ KN', 0, 'VK4RMC', 840e3);
        add('MAIN', 'VK4ABC', 'R R SUE FB. WX HR FINE ES WARM. RIG IS A TM9100 ON THE KELLY PAGE TELEPRINTER. 73 VK4XYZ DE VK4ABC SK', 0, 'VK4RBX', 780e3);
        add('MAIN', 'P25X', '*** P25X RTTY SPRINT: SUNDAY 7:30 PM ON CONTEST. EVERY QSO COUNTS DOUBLE ***', 1, '', 600e3);
        add('NET', 'VK4TTY', 'QST QST THE P25X DIGITAL NET IS ON THURSDAY 7:30 PM. CHECK IN WITH CALL ES NAME. DE VK4TTY NCS', 0, 'VK4RES', 3600e3);
        add('HF', 'VK4XYZ', 'CQ TEST DE JA1RTY JA1RTY TEST', 2, 'VK4RMC', 1200e3);
        add('HF', 'VK4XYZ', 'VK2RTY 599 012 012', 2, 'VK4RMC', 1180e3);
        // the round table carries on while the demo's open
        D.chatter = setInterval(() => {
          if (mode !== 'demo' || ++D.pushes > 8) { clearInterval(D.chatter); return; }
          const lines = [['VK2RTY', 'QRZ? QRZ? DE VK2RTY K', 'VK4RGX'], ['VK4XYZ', 'ANYONE FOR A QUICK RYRY TEST? RYRYRYRYRYRYRYRY DE VK4XYZ', 'VK4RMC'], ['VK4ABC', '[ART:TOWER]', 'VK4RBX'], ['VK4TTY', 'QST: THE PBBS HAS A NEW WX BULLETIN -- TRY THE NEWS PRINTER. DE VK4TTY', 'VK4RES']];
          const [from, text, site] = lines[(D.pushes - 1) % lines.length];
          const r = add('MAIN', from, text, 0, site);
          if (rs.ch === 'MAIN') gatewayReply({ app: 'rtty', c: 'rx', ch: 'MAIN', rows: [r], hi: D.seq, gone: [], qsl: [] });
        }, 45000);
      }
      const D = ui.demo, add = (ch, from, text, flags = 0, site = 'VK4RBX') => { const r = [++D.seq, Math.round(Date.now() / 1000), from, text, flags, site]; (D.rows[ch] || (D.rows[ch] = [])).push(r); return r; };
      const chans = [['MAIN', 'P25X round table', 4, 0], ['LOCAL', 'Local repeater', 1, 1], ['NET', 'Net', 0, 0], ['CONTEST', 'Contest', 0, 0], ['HF', 'HF copy', 1, 0]];
      const sprint = { on: true, ch: 'CONTEST', next: (() => { const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7)); d.setHours(19, 30, 0, 0); if (d < Date.now()) d.setDate(d.getDate() + 7); return { id: d.toISOString().slice(0, 10), start: Math.round(d / 1000), end: Math.round(d / 1000) + 3600, live: false }; })(), tally: [] };
      const ch = String(o.ch || 'MAIN').toUpperCase(), rows = D.rows[ch] || [];
      const after = s => rows.filter(r => r[0] > (s || 0) && r[2] !== meC).slice(-30);
      const until = Math.round(now / 1000) + 7200;
      if (o.c === 'join') return { c: 'joined', ch, me: meC, chans, rows: after(o.since).slice(-15), hi: D.seq, gone: [], ops: [...new Set(rows.slice(-6).map(r => r[2]))], until, motd: 'P25X RTTY (DEMO) -- QRV. Call CQ and somebody will come back to you.', sprint, qsl: [], site: 'VK4RBX' };
      if (o.c === 'get') return { c: 'rows', ch, rows: after(o.since), hi: D.seq, gone: [], ops: [], qsl: [], until };
      if (o.c === 'qrt') return { c: 'qrt' };
      if (o.c === 'tx') {
        const text = String(o.text).toUpperCase(), r = add(ch, meC, text);
        const qsl = [];
        for (const c of text.match(CALL_RE) || []) if (c !== meC) {
          D.mentions[`${meC}>${c}`] = Date.now();
          if (D.mentions[`${c}>${meC}`] && !D.qsos.has(c)) { D.qsos.add(c); qsl.push([c, c === 'VK4XYZ' ? 2 : 1, ch, Math.round(Date.now() / 1000), 0]); }
        }
        // somebody comes back
        const reply = /\bCQ\b/.test(text) ? ['VK4ABC', `${meC} ${meC} DE VK4ABC VK4ABC VK4ABC KN`, 'VK4RBX']
          : /\bVK4ABC\b/.test(text) && !D.qsos.has('VK4ABC') ? null
            : /\bVK4ABC\b/.test(text) ? ['VK4ABC', `R R ${meC} TNX FER THE QSO. 73 ES CUL ON THE SPRINT. ${meC} DE VK4ABC SK`, 'VK4RBX'] : null;
        const answerQso = /\bVK4ABC\b/.test(text) && !/\bCQ\b/.test(text) && !D.mentions[`VK4ABC>${meC}x`];
        if (reply || answerQso) setTimeout(() => {
          if (mode !== 'demo') return;
          const [from, t2, site] = reply || ['VK4ABC', `${meC} DE VK4ABC FB OM. UR RST 599 599. NAME BILL BILL. QTH IPSWICH. HW? ${meC} DE VK4ABC KN`, 'VK4RBX'];
          D.mentions[`${from}>${meC}`] = Date.now(); if (!reply) D.mentions[`VK4ABC>${meC}x`] = 1;
          const r2 = add(ch, from, t2, 0, site), q2 = [];
          if (D.mentions[`${meC}>${from}`] && !D.qsos.has(from)) { D.qsos.add(from); q2.push([from, 1, ch, Math.round(Date.now() / 1000), 0]); }
          if (rs.ch === ch) gatewayReply({ app: 'rtty', c: 'rx', ch, rows: [r2], hi: D.seq, gone: [], qsl: q2 });
        }, 9000 + Math.random() * 4000);
        return { c: 'sent', ch, seq: r[0], at: r[1], n: 3, rows: [], hi: D.seq, gone: [], qsl, until };
      }
      if (o.c === 'board') { const mine = [meC, D.qsos.size * 1, D.qsos.size, D.qsos.size, 1, D.qsos.size, 1]; const rows2 = [...D.board, mine].sort((a, b) => b[1] - a[1]); return { c: 'board', rows: rows2, me: meC, mine, sprint, last: { id: '2026-10-11', rows: [['VK4ABC', 9, 18], ['VK4XYZ', 7, 14], ['VK2RTY', 4, 8]] } }; }
      if (o.c === 'news' && o.n) return { c: 'print', n: o.n, cat: 'WX', from: 'VK4WX', ts: Math.round(now / 1000) - 7200, subj: 'SEQ: storms likely this afternoon', body: 'SEVERE THUNDERSTORMS ARE LIKELY OVER SOUTH EAST QUEENSLAND AFTER 2 PM.\nLARGE HAIL AND DAMAGING WINDS POSSIBLE. SECURE ANTENNAS!\n\nDE VK4WX' };
      if (o.c === 'news') return { c: 'news', rows: [[12, 'WX', 'VK4WX', Math.round(now / 1000) - 7200, 'SEQ: storms likely this afternoon', 160], [11, 'NET', 'P25X', Math.round(now / 1000) - 86400, 'Thursday P25X net, 7:30 pm', 240], [9, 'DX', 'G4XYZ', Math.round(now / 1000) - 3 * 86400, 'VK9L Lord Howe DXpedition next month', 300]] };
      if (o.c === 'post') return { c: 'posted', n: 13, to: o.t === 'P' ? o.to : 'RTTY' };
      if (o.c === 'spots') return { c: 'spots', on: true, rows: [[Math.round(now / 1000) - 120, 14085.0, 'VK9XX', 'JA1ABC', 'RTTY CQ UP 1'], [Math.round(now / 1000) - 600, 21085.5, 'ZL7TTY', 'VK2RTY', 'RTTY 599'], [Math.round(now / 1000) - 900, 7042.0, 'JA1RTY', 'VK4XYZ', 'RTTY TEST']] };
      return { c: o.c, error: 'Unknown request' };
    }

    // ================================================================== other tabs
    function news(n) {
      if (n) ask({ c: 'news', n }, `RTTY: bulletin #${n} for the news printer`, j => {
        print(`QST QST QST DE ${j.from}\nBULLETIN NR ${j.n} ${j.cat}  ${new Date(j.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z\n${j.subj}\n\n${j.body}\n\nEND OF BULLETIN NR ${j.n}`, { cls: 'gw', who: `PBBS #${j.n} · news printer` });
        ui.tab = 'tty'; F('news', { n: j.n }); dirty('rtty');
      });
      else ask({ c: 'news' }, 'RTTY: PBBS bulletins for the news printer', j => { st.news = j.rows || []; persist(); dirty('rtty'); });
    }
    function board() { ask({ c: 'board' }, 'RTTY: the club board', j => { st.board = j; st.sprint = j.sprint || st.sprint; persist(); if (fun) fun.board(j); dirty('rtty'); }); }
    function spots() { ask({ c: 'spots' }, 'RTTY: DX cluster spots', j => { st.spots = j; persist(); dirty('rtty'); }); }
    function postCopy() {
      const c = chOf(rs.ch), since = (c.rows[Math.max(0, c.rows.length - 60)] || {}).seq - 1 || 0;
      if (!c.rows.length) { toast('📟', 'Nothing to post', 'The channel is empty', 'bad'); return; }
      ask({ c: 'post', ch: rs.ch, t: 'B', subj: `RTTY ${rs.ch} copy ${new Date().toISOString().slice(0, 10)}`, since }, `RTTY: ${rs.ch} copy to the PBBS`, j => {
        print(`--- ${rs.ch} copy posted to the PBBS as bulletin #${j.n} (RTTY). ---`, { sys: true }); toast('📟', `Posted to the PBBS #${j.n}`, 'Category RTTY', 'good'); F('pbbspost', {});
      });
    }
    // contest calendar: the big worldwide RTTY contests by their usual rule (check the sponsor's rules)
    function fullWeekend(y, m, nth) {   // nth full Sat+Sun weekend of the month (nth = -1: the last); returns the Saturday
      const sats = []; for (let d = 1; d <= 31; d++) { const x = new Date(Date.UTC(y, m, d)); if (x.getUTCMonth() !== m) break; if (x.getUTCDay() === 6 && new Date(Date.UTC(y, m, d + 1)).getUTCMonth() === m) sats.push(x); }
      return nth < 0 ? sats[sats.length + nth] : sats[nth - 1];
    }
    function contests() {
      const y = new Date().getUTCFullYear(), out = [];
      const C = [['ARRL RTTY Roundup', 0, 1, 18, 30], ['CQ WPX RTTY', 1, 2, 0, 48], ['CQ WW RTTY DX', 8, -1, 0, 48], ['JARTS WW RTTY', 9, 3, 0, 48]];
      for (const yy of [y, y + 1]) for (const [name, m, nth, h, len] of C) { const s = fullWeekend(yy, m, nth); if (!s) continue; const start = s.getTime() + h * 3600e3; if (start + len * 3600e3 > Date.now()) out.push({ name, start, end: start + len * 3600e3 }); }
      return out.sort((a, b) => a.start - b.start).slice(0, 5);
    }

    // ================================================================== render
    function render() {
      ensureMode();
      const badge = $('#nb-rtty');
      if (k.currentPage() !== 'rtty') return;
      if (badge && ui.badge) { ui.badge = 0; badge.textContent = ''; badge.classList.remove('show'); }
      $$('#rt-tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
      $$('#page-rtty .rt-pane').forEach(p => { p.hidden = p.dataset.pane !== ui.tab; });
      // status strip
      const joined = st.joined && st.joined.until > Date.now();
      if (ui.wantJoin && (k.radioConnected() || mode === 'demo')) { ui.wantJoin = false; if (!joined && !(ui.ask && ui.ask.obj.c === 'join')) setTimeout(() => join(rs.ch, true), 400); }
      $('#rt-status').innerHTML = joined ? `<b>QRV ${esc(st.joined.ch)}</b> · listening till ${hm(st.joined.until)}` : '<b>QRT</b> · not listening';
      $('#rt-status').className = `tag ${joined ? 'good' : ''}`;
      const chs = st.chans || [['MAIN', 'P25X round table', 0, 0], ['LOCAL', 'Local repeater', 0, 1], ['NET', 'Net', 0, 0], ['CONTEST', 'Contest', 0, 0], ['HF', 'HF copy', 0, 0]];
      $('#rt-chans').innerHTML = chs.map(([id, name, n, local]) => `<button class="rt-chip${id === rs.ch ? ' on' : ''}" data-ch="${esc(id)}" title="${esc(name)}${local ? ' -- only stations on your repeater' : ''}">${local ? '📍' : id === 'HF' ? '📻' : '#'}${esc(id)}${n ? `<small>${n}👂</small>` : ''}${ui.unseen[id] ? `<em>${ui.unseen[id]}</em>` : ''}</button>`).join('');
      $('#rt-ops').innerHTML = (st.ops || []).length ? `On ${esc(rs.ch)}: ${st.ops.map(c => `<b class="rt-call" data-call="${esc(c)}">${esc(c)}</b>`).join(' ')}` : '';
      const sp = st.sprint && st.sprint.next;
      $('#rt-sprint').innerHTML = sp ? (sp.live ? `🏁 <b>SPRINT LIVE</b> on ${esc(st.sprint.ch)} till ${hm(sp.end * 1000)}` : `🏁 Next sprint ${new Date(sp.start * 1000).toLocaleString('en-AU', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} on ${esc(st.sprint.ch)}`) : '';
      const parked = mode === 'demo' || k.parked();
      $('#rt-park').hidden = parked || !k.radioConnected();
      $('#rt-q').textContent = ui.ask ? `📡 ${ui.ask.label}${ui.ask.delivered ? ' -- waiting for the gateway' : ''}${ui.queue.length ? ` (+${ui.queue.length})` : ''}` : (st.air ? `${kB(st.air)} on P25 today` : '');
      // keyboard
      $('#rt-macros').innerHTML = rs.macros.map((m, i) => `<button class="btn small rt-fk" data-mac="${i}" title="${esc(m.t)}"><small>F${i + 1}</small>${esc(m.l)}</button>`).join('');
      txCount();
      // QSO panel
      const h = ui.his, w = h.call ? worked(h.call) : [];
      $('#rt-wb').innerHTML = h.call ? (w.length ? `🔁 Worked ${w.length}× -- last ${new Date(w[w.length - 1].ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}${w.some(x => x.confirmed) ? ' ✅' : ''}` : '🆕 New one -- not in your log yet') : '';
      // settings mirror
      for (const [id, key] of [['#rt-machine', 'machine'], ['#rt-baud', 'baud'], ['#rt-shift', 'shift'], ['#rt-variant', 'variant'], ['#rt-noise', 'noise'], ['#rt-poll', 'poll']]) { const e = $(id); if (e && document.activeElement !== e) e.value = String(rs[key]); }
      $('#rt-printer').className = `rt-printer rt-m-${rs.machine}`;
      if (ui.tab === 'log') renderLog();
      if (ui.tab === 'news') renderNews();
      if (ui.tab === 'ref') renderRef();
      if (ui.tab === 'quest' && fun) fun.render($('#rt-quest'), { board: st.board, sprint: st.sprint, me: me(), log: st.log });
      if (ui.tab === 'art') renderArt();
      if (ui.tab === 'hf') { $('#rt-hfgo').textContent = hf.on ? '⏹ Stop receiver' : '🎙️ Start receiver'; $('#rt-hfgo').classList.toggle('primary', !hf.on); $('#rt-hfstate').textContent = hf.on ? `Receiving · AFC ${hf.dem ? (hf.dem.afc >= 0 ? '+' : '') + hf.dem.afc.toFixed(0) : 0} Hz · ${hf.chars} characters copied` : 'Off'; }
      if (ui.printedCh !== rs.ch) reprint(rs.ch);
    }
    function txCount() {
      const t = $('#rt-tx'); if (!t) return;
      const text = fillVars(t.value), n = text.length, bd = +rs.baud || 45.45;
      const nos = Math.round(B.encode(B.printable(ART ? ART.expand(text, {}) : text, rs.variant)).length * charT());
      $('#rt-count').innerHTML = n ? `${n}/${LINE_MAX} · <span title="How long this over prints on the teleprinter">⌨️ ${nos} s at ${bd} Bd</span> · <span title="Airtime on P25">📡 ≈ ${Math.max(1, Math.round((n + 120) / AIR_BPS))} s on P25</span>` : `${B.wpm(bd, rs.stop)} WPM · ${bd} Bd · ${rs.shift} Hz shift`;
      $('#rt-count').classList.toggle('bad', n > LINE_MAX);
    }
    function renderLog() {
      const rows = [...st.log].reverse();
      $('#rt-logn').textContent = `${st.log.length} QSO${st.log.length === 1 ? '' : 's'} · ${new Set(st.log.map(x => x.call)).size} stations · ${st.log.filter(x => x.confirmed).length} confirmed`;
      $('#rt-logrows').innerHTML = rows.slice(0, 400).map(e => `<tr data-id="${esc(e.id)}"><td>${new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ')}Z</td><td><b class="rt-call" data-call="${esc(e.call)}">${esc(e.call)}</b></td><td>${esc(e.name || '')}</td><td>${esc(e.qth || '')}</td><td>${esc(e.rstS || '')}/${esc(e.rstR || '')}</td><td>${esc(e.band)}${e.ch ? ` ${esc(e.ch)}` : ''}</td><td>${e.confirmed ? `✅${e.pts ? ` ${e.pts}` : ''}${e.sprint ? ' 🏁' : ''}` : ''}</td><td>${esc(e.notes || '')}</td><td><button class="btn ghost small" data-logdel="${esc(e.id)}" title="Delete">✕</button></td></tr>`).join('') || '<tr><td colspan="9" class="dim">No QSOs yet. Call CQ, or answer one -- the gateway confirms a QSO when you both name each other.</td></tr>';
    }
    function renderNews() {
      $('#rt-news').innerHTML = (st.news || []).map(r => `<li><button class="btn small" data-news="${r[0]}">🖨️ Print</button><span><b>#${r[0]} ${esc(r[1])}</b> ${esc(r[4])}<small>${esc(r[2])} · ${new Date(r[3] * 1000).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} · ${kB(r[5])} · ≈ ${Math.max(2, Math.round(r[5] / AIR_BPS + 4))} s on P25 · ${Math.round(B.printable(' '.repeat(r[5])).length * charT() / 60)} min on the printer</small></span></li>`).join('') || '<li class="dim">Fetch the list -- PBBS bulletins print here like the old wire-service RTTY news.</li>';
    }
    function renderArt() {
      const g2 = $('#rt-gallery'); if (!g2 || g2.dataset.done) return;
      g2.dataset.done = 1;
      g2.innerHTML = (ART ? ART.list : []).map(a => `<div class="rt-art"><pre>${esc(a.lines.join('\n').replace(/\{FROM\}/g, me() || 'VK4KEL'))}</pre><div class="row gap"><b>${esc(a.name)}</b><span class="dim small mono">[ART:${a.id}] · ${`[ART:${a.id}]`.length} B on air</span></div>
        <div class="row gap"><button class="btn small" data-artprint="${a.id}">🖨️ Print here</button><button class="btn small primary" data-artsend="${a.id}">📡 Send on channel</button></div></div>`).join('');
    }
    function renderRef() {
      const c = $('#rt-chart'); if (c && !c.dataset.done) {
        c.dataset.done = 1;
        c.innerHTML = `<div class="rt-ch-h"><span>Code</span><span>Holes 12345</span><span>LTRS</span><span>FIGS</span></div>` + Array.from({ length: 32 }, (_, i) => {
          const name = v => ({ '\n': 'LF', '\r': 'CR', ' ': 'SP', '\x07': 'BEL', '': '' }[v] ?? v);
          return `<div data-code="${i}"><span class="mono">${i.toString(2).padStart(5, '0').split('').reverse().join('')}</span><span class="rt-holes">${B.holes(i).map(b => (b ? '●' : '·')).join('')}</span><b>${esc(i === 31 ? 'LTRS' : i === 27 ? 'FIGS' : i === 0 ? 'NUL' : name(B.L[i]))}</b><b>${esc(i === 31 ? 'LTRS' : i === 27 ? 'FIGS' : i === 0 ? 'NUL' : name((rs.variant === 'ita2' ? B.F_ITA2 : B.F_US)[i]))}</b></div>`;
        }).join('');
      }
      const cal = $('#rt-contests');
      if (cal) cal.innerHTML = contests().map(x => `<li><b>${esc(x.name)}</b> ${new Date(x.start).toUTCString().slice(0, 16)} ${new Date(x.start).toISOString().slice(11, 16)}Z -- ${Math.round((x.end - x.start) / 3600e3)} h${x.start < Date.now() ? ' <span class="tag good">ON NOW</span>' : ` · in ${Math.ceil((x.start - Date.now()) / 864e5)} days`}</li>`).join('') + '<li class="dim small">Dates by each contest\'s usual weekend -- check the sponsor\'s rules before you plan.</li>';
      const sp = $('#rt-spots');
      if (sp) sp.innerHTML = st.spots && st.spots.rows && st.spots.rows.length ? st.spots.rows.map(r => `<tr><td>${new Date(r[0] * 1000).toISOString().slice(11, 16)}Z</td><td class="mono">${(+r[1]).toFixed(1)}</td><td><b class="rt-call" data-call="${esc(r[2])}">${esc(r[2])}</b></td><td>${esc(r[3])}</td><td>${esc(r[4])}</td></tr>`).join('')
        : `<tr><td colspan="5" class="dim">${st.spots ? (st.spots.on ? 'No RTTY spots right now.' : 'The gateway\'s DX cluster feed is off -- ask the sysop (Tools › P25X RTTY).') : 'Fetch the spots: RTTY activity worldwide, from a DX cluster via the gateway.'}</td></tr>`;
    }

    // ================================================================== bindings
    function init() {
      const root = $('#page-rtty'); if (!root) return;
      if (window.KellyRttyFun) fun = window.KellyRttyFun({ $, esc, store, toast, settings, me, demo: () => mode === 'demo', dirty, contests,
        sound: () => (audio() && g ? { ac, out: g.mech, bell } : null), askBoard: () => board(), showTab: t => { ui.tab = t; dirty('rtty'); } });
      $('#rt-tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (!b) return; ui.tab = b.dataset.tab; if (ui.tab === 'hf') hfDevices(); if (ui.tab === 'quest' && !st.board) setTimeout(board, 300); dirty('rtty'); };
      $('#rt-chans').onclick = e => { const b = e.target.closest('[data-ch]'); if (b) switchCh(b.dataset.ch); };
      $('#rt-join').onclick = () => join(rs.ch);
      $('#rt-qrt').onclick = () => ask({ c: 'qrt' }, 'RTTY: QRT', () => { st.joined = null; persist(); print('--- QRT. The gateway stops sending you overs. 73 ---', { sys: true }); });
      $('#rt-poll-now').onclick = poll;
      $('#rt-tx').addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (sendOver($('#rt-tx').value)) { $('#rt-tx').value = ''; txCount(); } }
      });
      $('#rt-tx').addEventListener('input', txCount);
      $('#rt-send').onclick = () => { if (sendOver($('#rt-tx').value)) { $('#rt-tx').value = ''; txCount(); } };
      $('#rt-bell').onclick = () => { if (sendOver('\x07 BELL DE {MYCALL}')) F('bell', {}); };
      $('#rt-macros').onclick = e => { const b = e.target.closest('[data-mac]'); if (b) macro(+b.dataset.mac, e.shiftKey); };
      document.addEventListener('keydown', e => {
        if (k.currentPage() !== 'rtty' || !/^F([1-9]|1[0-2])$/.test(e.key)) return;
        e.preventDefault(); macro(+e.key.slice(1) - 1, e.shiftKey);
      });
      $('#rt-macedit').onclick = () => {
        const i = +prompt(`Edit which macro? 1-12\n${rs.macros.map((m, j) => `F${j + 1} ${m.l}`).join('   ')}`, '1') - 1;
        if (!(i >= 0 && i < 12)) return;
        const l = prompt(`F${i + 1} label`, rs.macros[i].l); if (l == null) return;
        const t = prompt(`F${i + 1} text -- {MYCALL} {CALL} {NAME} {QTH} {GRID} {RIG} {RST} {NR} {GREET} {TIME} {DATE} {HISNAME}; \\n = new line`, rs.macros[i].t.replace(/\n/g, '\\n')); if (t == null) return;
        rs.macros[i] = { l: l.slice(0, 8).toUpperCase(), t: t.replace(/\\n/g, '\n') }; save(); dirty('rtty');
      };
      // click a callsign anywhere = HIS CALL
      root.addEventListener('click', e => {
        const c = e.target.closest('[data-call]'); if (!c) return;
        setHis(c.dataset.call); F('capture', {});
      });
      for (const [id, key] of [['#rt-his', 'call'], ['#rt-hisname', 'name'], ['#rt-hisqth', 'qth'], ['#rt-rsts', 'rstS'], ['#rt-rstr', 'rstR'], ['#rt-notes', 'notes']]) $(id).addEventListener('input', e => { ui.his[key] = key === 'call' ? e.target.value.toUpperCase().trim() : e.target.value; if (key === 'call') dirty('rtty'); });
      $('#rt-log').onclick = logQso;
      $('#rt-mail').onclick = () => { if (!ui.his.call) return; k.pbbsCompose({ t: 'P', to: ui.his.call.split('/')[0], subj: 'Our RTTY QSO', body: `Hi ${ui.his.name || ''},\n\nTNX for the RTTY QSO on P25X ${rs.ch}.\n\n73 de ${me()}` }); };
      $('#rt-clearhis').onclick = () => setHis('');
      $('#rt-post').onclick = postCopy;
      $('#rt-clear').onclick = () => { paperReset(); print('--- paper torn off ---', { sys: true }); };
      $('#rt-paper').addEventListener('dblclick', () => { P.q.forEach(x => { x.instant = true; }); if (P.cur) P.cur.instant = true; });
      // settings
      const bind = (id, key, conv = v => v, after) => { const e = $(id); if (!e) return; e.value = String(rs[key]); e.onchange = () => { rs[key] = conv(e.value); save(); if (after) after(); dirty('rtty'); }; };
      bind('#rt-machine', 'machine'); bind('#rt-baud', 'baud', Number, hfRetune); bind('#rt-shift', 'shift', Number, hfRetune); bind('#rt-variant', 'variant', String, hfRetune);
      bind('#rt-noise', 'noise', Number); bind('#rt-poll', 'poll', Number);
      for (const [id, key] of [['#rt-v-tones', 'tones'], ['#rt-v-mech', 'mech'], ['#rt-v-motor', 'motor']]) { const e = $(id); e.value = rs[key]; e.oninput = () => { rs[key] = +e.value; save(); audio(); if (key === 'motor' && !rs.motor) motorOff(); }; }
      for (const [id, key] of [['#rt-usos', 'usos'], ['#rt-bellmine', 'bellMine'], ['#rt-hfshare', 'hfShare'], ['#rt-afc', 'afc'], ['#rt-hftx', 'hfTx'], ['#rt-reverse', 'reverse']]) { const e = $(id); if (!e) continue; e.checked = !!rs[key]; e.onchange = () => { rs[key] = e.checked; save(); hfRetune(); dirty('rtty'); }; }
      for (const [id, key] of [['#rt-myname', 'name'], ['#rt-myqth', 'qth'], ['#rt-mygrid', 'grid'], ['#rt-myrig', 'rig']]) { const e = $(id); e.value = rs[key]; e.onchange = () => { rs[key] = e.value.toUpperCase().slice(0, 30); e.value = rs[key]; save(); }; }
      // logbook
      $('#rt-adif').onclick = () => { download(`kelly-rtty-${me() || 'log'}-${new Date().toISOString().slice(0, 10)}.adi`, adif()); F('adif', {}); };
      $('#rt-csv').onclick = () => download(`kelly-rtty-${me() || 'log'}.csv`, ['utc,call,name,qth,rst_sent,rst_rcvd,band,channel,confirmed,points,notes', ...st.log.map(e => [new Date(e.ts).toISOString(), e.call, e.name, e.qth, e.rstS, e.rstR, e.band, e.ch, e.confirmed ? 1 : 0, e.pts || '', e.notes].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'), 'text/csv');
      $('#rt-logrows').onclick = e => { const b = e.target.closest('[data-logdel]'); if (b && confirm('Delete this QSO from your logbook?')) { st.log = st.log.filter(x => x.id !== b.dataset.logdel); persist(); dirty('rtty'); } };
      // news, art, tape, ref
      $('#rt-newsget').onclick = () => news();
      $('#rt-news').onclick = e => { const b = e.target.closest('[data-news]'); if (b) news(+b.dataset.news); };
      $('#rt-gallery').onclick = e => {
        const p = e.target.closest('[data-artprint]'), s = e.target.closest('[data-artsend]');
        if (p) { ui.tab = 'tty'; dirty('rtty'); print(`[ART:${p.dataset.artprint}]`, { cls: 'sys2', who: 'local print', from: me() }); }
        if (s) { ui.tab = 'tty'; dirty('rtty'); if (sendOver(`[ART:${s.dataset.artsend}]`)) F('art', { id: s.dataset.artsend }); }
      };
      $('#rt-bantext').oninput = () => { $('#rt-banprev').textContent = ART.banner($('#rt-bantext').value).join('\n'); };
      $('#rt-bansend').onclick = () => { const t = $('#rt-bantext').value.trim(); if (!t) return; ui.tab = 'tty'; dirty('rtty'); if (sendOver(`[BANNER:${t.toUpperCase().slice(0, 33)}]`)) F('banner', {}); };
      $('#rt-banprint').onclick = () => { const t = $('#rt-bantext').value.trim(); if (!t) return; ui.tab = 'tty'; dirty('rtty'); print(`[BANNER:${t}]`, { cls: 'sys2', who: 'local print' }); };
      $('#rt-qslsend').onclick = () => { if (!ui.his.call) { toast('🪪', 'Who is the QSL for?', 'Click or type HIS CALL first', 'bad'); return; } ui.tab = 'tty'; dirty('rtty'); if (sendOver(`[QSL:${ui.his.call}:${ui.his.rstS || '599'}]`)) F('qslcard', {}); };
      $('#rt-tapesave').onclick = () => { const txt = [...$$('#rt-paper .rt-txt')].map(x => x.textContent).join('\n'); download(`kelly-rtty-tape-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.txt`, txt); F('tape', {}); };
      $('#rt-tapepng').onclick = () => { const cv = $('#rt-tape'); if (!cv) return; tape.dirty = true; drawTape(); const a = document.createElement('a'); a.href = cv.toDataURL('image/png'); a.download = 'kelly-rtty-tape.png'; a.click(); F('tape', {}); };
      $('#rt-tapeload').onchange = async e => {
        const f = e.target.files[0]; e.target.value = ''; if (!f) return;
        const t = B.printable((await f.text()).slice(0, 4000), rs.variant);
        $('#rt-tx').value = t.slice(0, LINE_MAX); txCount(); ui.tab = 'tty'; dirty('rtty');
        toast('📜', 'Tape loaded into the keyboard', `${t.length} characters${t.length > LINE_MAX ? ` -- the first ${LINE_MAX} (one over)` : ''}. Enter sends it.`, 'good');
      };
      $('#rt-spotsget').onclick = spots;
      // HF
      $('#rt-hfgo').onclick = () => (hf.on ? hfStop() : hfStart());
      $('#rt-hfin').onchange = e => { rs.hfIn = e.target.value; save(); if (hf.on) { hfStop(); hfStart(); } };
      $('#rt-hfout').onchange = e => { rs.hfOut = e.target.value; save(); };
      $('#rt-mark').value = rs.mark; $('#rt-mark').onchange = e => { rs.mark = Math.max(300, Math.min(3000, +e.target.value || 2125)); save(); hfRetune(); };
      $('#rt-sq').value = rs.sq; $('#rt-sq').oninput = e => { rs.sq = +e.target.value; save(); hfRetune(); };
      $('#rt-hfwf').onclick = e => {   // click the waterfall on the mark tone
        const r = e.target.getBoundingClientRect(), f = 1200 + 2000 * (e.clientX - r.left) / r.width;
        rs.mark = Math.round(rs.reverse ? f - rs.shift : f); $('#rt-mark').value = rs.mark; save(); hfRetune(); toast('🎯', `Mark ${rs.mark} Hz`, `Space ${rs.mark + rs.shift} Hz`, '');
      };
      $('#rt-hfsend').onclick = () => { const t = $('#rt-hftext').value.trim(); if (!t) return; if (!hf.on) { toast('📻', 'Start the receiver first', 'HF transmit uses the same sound card', 'bad'); return; } hfTransmit(fillVars(t).toUpperCase()); $('#rt-hftext').value = ''; };
      $('#rt-hfclear').onclick = () => { $('#rt-hfscreen').innerHTML = ''; };
      setInterval(() => { if (rs.poll && k.currentPage() === 'rtty' && !document.hidden && st.joined && !ui.ask && !k.parked()) poll(); }, Math.max(30, rs.poll || 60) * 1000);
      setInterval(() => { if (k.currentPage() === 'rtty' && hf.on) dirty('rtty'); }, 2000);
      paperReset(); ledShift();
    }
    function setHis(call) {
      ui.his = { call: String(call || '').toUpperCase(), name: '', qth: '', rstS: '599', rstR: '599', notes: '' };
      const last = call ? worked(ui.his.call).pop() : null;
      if (last) { ui.his.name = last.name || ''; ui.his.qth = last.qth || ''; }
      $('#rt-his').value = ui.his.call; $('#rt-hisname').value = ui.his.name; $('#rt-hisqth').value = ui.his.qth; $('#rt-rsts').value = '599'; $('#rt-rstr').value = '599'; $('#rt-notes').value = '';
      dirty('rtty');
    }
    function macro(i, toBuffer) {
      const m = rs.macros[i]; if (!m) return;
      if (toBuffer) { const t = $('#rt-tx'); t.value = `${t.value}${t.value && !/\s$/.test(t.value) ? ' ' : ''}${fillVars(m.t)}`; t.focus(); txCount(); return; }
      const t = $('#rt-tx').value.trim();
      if (sendOver(t ? `${t} ${m.t}` : m.t)) { $('#rt-tx').value = ''; txCount(); F('macro', { l: m.l }); }
    }
    function shown() {
      ensureMode();
      ui.badge = 0;
      if (ui.printedCh !== rs.ch) reprint(rs.ch);
      ui.wantJoin = true;   // render() joins once the radio is connected (the page can be shown before it is)
      dirty('rtty');
    }
    return { init, render, shown, gatewayReply, kfEvent, ownsXid: xid => !!(ui.ask && ui.ask.xid === xid), me, st: () => st, print, demoGateway };
  };
})();
