/* Kelly Page -- P25X SSTV: small digital pictures over the radio's P25 Transparent pipe,
 * to/from the P25X dashboard. Not analogue SSTV. Same protocol as scripts/p25x_sstv.py
 * (Station) and gateway/server.js (SSTV section) -- keep the three
 * in step:
 *   A5 53 | type | xid | seq (2, BE) | len | payload (<= 240) | CRC-16 LE (DNP3 CRC over type..payload)
 *   START  payload: size(4) nchunks(2) chunk(1) mime(1) width(2) height(2) crc32(4) callsign
 *          [00 | to(3) | dest(3) | from(3)]  optional address trailer, radio IDs -- see parseStart
 *   DATA   seq = chunk index;  END  seq = nchunks ("tell me what's missing")
 *   NACK   payload: missing chunk indexes (2 each), 0xFFFF = START missing;  ACK  complete + CRC-32 good
 *          ACK payload (optional): flags, bit 0 = "this end takes SHORT requests" (the gateway sets it)
 *   SHORT  a whole small message in one frame -- no START/END, no ACK when the answer is quick:
 *          seq = mime id (high byte) | flags (low: bit 0 to(3) follows, bit 1 from(3) follows),
 *          payload = [to] [from] data. Kelly -> gateway: a request with from = its own ID (a no-argument
 *          request = 14 B = one uplink call on a TM9100); the gateway's answer is a SHORT with to = the
 *          radio and the request's xid (or a transfer on that xid, or an ACK if it is slow), which is the
 *          request's delivery receipt. No answer in ACK_TIMEOUT_MS -> the request goes again.
 * The sender bursts up to 500 B per radio transmission and leaves a gap; the receiver
 * answers each END with NACK or ACK. Pure protocol: no DOM, no radio -- app.js owns the
 * Transparent session and passes write()/feed() in.
 */
(function () {
  'use strict';
  const T = { START: 1, DATA: 2, END: 3, NACK: 4, ACK: 5, SHORT: 6 };
  const NAMES = { 1: 'START', 2: 'DATA', 3: 'END', 4: 'NACK', 5: 'ACK', 6: 'SHORT' };
  // SHORT_TRIES: a SHORT request goes at most this many times (ACK_TIMEOUT_MS apart) before it fails
  const SHORT_TO = 1, SHORT_FROM = 2, SHORT_TRIES = 4, ACK_TAKES_SHORT = 1;
  const NEED_START = 0xFFFF, MAXP = 240, BURST_MAX = 500, HDR = 7;
  // GAP_MS: after a burst's estimated airtime. 300 = a 500 B write every ~1.43 s, when the radio has
  // nearly drained the last one (its buffer is 600 B): ~350 B/s up, was ~290 at 600 (link test 2026-10-11).
  // MAX_ROUNDS: END retries in a row with no answer at all before giving up. MAX_STALL: NACK rounds in a
  // row that don't shrink the missing list. A transfer still getting chunks through keeps going -- the
  // old "8 rounds total" gave up on VK4ZGW's code plug with 8 chunks to go, still shrinking (2026-10-16).
  const GAP_MS = 300, ACK_TIMEOUT_MS = 7000, MAX_ROUNDS = 8, MAX_STALL = 6, RX_QUIET_MS = 2000;
  // BACKOFF_MS: after the channel clears, wait a random 0-3 s more, so radios that waited through the
  // same over don't all key up together (a capacity study).
  const BACKOFF_MS = 3000;
  // 10 = a KF file container (radio configs, js/kfiles.js) -- not a picture
  const MIMES = { 1: 'image/webp', 2: 'image/jpeg', 3: 'image/png', 10: 'application/x-kelly-kf' };
  const MIME_ID = { 'image/webp': 1, 'image/jpeg': 2, 'image/png': 3, 'application/x-kelly-kf': 10 };

  function crc16(bytes) {   // the DNP3 block CRC (poly 0x3D65 reflected, inverted)
    let c = 0;
    for (const x of bytes) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xA6BC : c >>> 1; }
    return (~c) & 0xFFFF;
  }
  const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  function frame(type, xid, seq, payload = []) {
    const body = [type, xid & 0xFF, (seq >> 8) & 0xFF, seq & 0xFF, payload.length, ...payload];
    const c = crc16(body);
    return Uint8Array.from([0xA5, 0x53, ...body, c & 0xFF, c >> 8]);
  }
  function parse(fr) {
    if (fr.length < HDR + 2 || fr[0] !== 0xA5 || fr[1] !== 0x53) return null;
    const n = fr[6];
    if (fr.length !== HDR + n + 2 || crc16(fr.slice(2, HDR + n)) !== (fr[HDR + n] | (fr[HDR + n + 1] << 8))) return null;
    return { type: fr[2], xid: fr[3], seq: (fr[4] << 8) | fr[5], payload: fr.slice(HDR, HDR + n) };
  }
  const u32 = v => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF], u16 = v => [(v >> 8) & 0xFF, v & 0xFF];
  const u24 = v => [(v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
  function startPayload(t) {
    const call = Array.from(String(t.call || '').slice(0, 16), ch => ch.charCodeAt(0) & 0x7F);
    const adr = t.to || t.dest || t.from ? [0, ...u24(t.to || 0), ...u24(t.dest || 0), ...u24(t.from || 0)] : [];
    return [...u32(t.data.length), ...u16(t.chunks.length), MAXP, MIME_ID[t.mime] || 1, ...u16(t.w), ...u16(t.h), ...u32(t.crc), ...call, ...adr];
  }
  // Address trailer (optional): to = who takes and answers this hop (0 = anyone), dest = the radio
  // it's finally for (the gateway forwards it there), from = the radio that sent it.
  function parseStart(p) {
    const r32 = i => ((p[i] << 24) | (p[i + 1] << 16) | (p[i + 2] << 8) | p[i + 3]) >>> 0, r16 = i => (p[i] << 8) | p[i + 1];
    const r24 = i => (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
    let z = p.indexOf(0, 16); if (z < 0) z = p.length;
    const adr = z + 10 <= p.length;
    return { size: r32(0), nchunks: r16(4), chunk: p[6], mime: MIMES[p[7]] || 'image/webp', w: r16(8), h: r16(10), crc: r32(12),
      call: String.fromCharCode(...p.slice(16, z)),
      to: adr ? r24(z + 1) : 0, dest: adr ? r24(z + 4) : 0, from: adr ? r24(z + 7) : 0 };
  }
  // SHORT frame: [to] [from] data, <= SHORT_MAX bytes in all
  const SHORT_MAX = MAXP;
  function shortFrame(xid, mime, { to = 0, from = 0 } = {}, data = []) {
    const flags = (to ? SHORT_TO : 0) | (from ? SHORT_FROM : 0);
    return frame(T.SHORT, xid, ((MIME_ID[mime] || 0) << 8) | flags, [...(to ? u24(to) : []), ...(from ? u24(from) : []), ...data]);
  }
  function parseShort(f) {
    const p = f.payload, flags = f.seq & 0xFF; let o = 0;
    const r24 = () => { const v = (p[o] << 16) | (p[o + 1] << 8) | p[o + 2]; o += 3; return v; };
    const to = flags & SHORT_TO ? r24() : 0, from = flags & SHORT_FROM ? r24() : 0;
    return { mime: MIMES[f.seq >> 8] || '', to, from, data: p.slice(o) };
  }
  const airtimeMs = n => 250 + Math.ceil((n + 16) / 12) * 20.4;

  // Byte stream (serial pipe or P25 PDU data) -> complete frames; resyncs on A5 53.
  class Splitter {
    constructor() { this.buf = []; }
    push(bytes) {
      for (const b of bytes) this.buf.push(b);
      const out = [];
      for (;;) {
        let i = 0; while (i + 1 < this.buf.length && !(this.buf[i] === 0xA5 && this.buf[i + 1] === 0x53)) i++;
        if (i) this.buf.splice(0, i);
        if (this.buf.length < HDR) break;
        const total = HDR + this.buf[6] + 2;
        if (this.buf.length < total) break;
        const f = parse(Uint8Array.from(this.buf.slice(0, total)));
        if (!f) { this.buf.splice(0, 1); continue; }   // bad CRC: step past this A5 and resync
        this.buf.splice(0, total); out.push(f);
      }
      if (this.buf.length > 4096) this.buf.splice(0, this.buf.length - 4096);
      return out;
    }
  }

  // One end of a picture link. write(Uint8Array) sends one burst; canWrite gates it (Kelly can
  // only transmit while its Transparent session is open). onEvent({kind, ...}) reports
  // progress: tx-progress / tx-done / tx-failed / rx-progress / rx-done / need-answer.
  class Link {
    // channelBusy(): true while the radio channel is in use (someone talking) -- nothing is sent then,
    // and answer timers pause, so a long over doesn't make a transfer give up.
    // me(): our own radio ID (0 = not known yet: take every picture) -- a picture addressed to
    // another radio (its START's "to") is ignored, frames and END included, so we never answer it.
    constructor({ write, onEvent, now = () => Date.now(), channelBusy = () => false, me = () => 0 }) {
      this.write = write; this.onEvent = onEvent || (() => {}); this.now = now; this.channelBusy = channelBusy; this.me = me;
      this.queue = []; this.tx = new Map(); this.rx = new Map();
      this.nextBurstAt = 0; this.heardAt = 0; this.canWrite = false;
      this.splitter = new Splitter();
    }
    // to / dest / from: the address trailer (see parseStart); none = the pre-addressing format.
    sendImage(data, { mime = 'image/webp', w = 0, h = 0, call = '', to = 0, dest = 0, from = 0 } = {}) {
      const used = new Set([...this.tx.keys(), ...this.rx.keys()]);
      const free = []; for (let x = 1; x < 256; x++) if (!used.has(x)) free.push(x);
      const xid = free[Math.floor(Math.random() * free.length)] || 1;
      const chunks = []; for (let i = 0; i < data.length; i += MAXP) chunks.push(Array.from(data.slice(i, i + MAXP)));
      const t = { xid, data, chunks, mime, w, h, call, to, dest, from, crc: crc32(data), state: 'sending', sent: new Set(), rounds: 0, resent: 0,
        started: this.now(), finished: null, endAt: null };
      this.tx.set(xid, t);
      // pri 0 = answers / END retries, 1 = chunks the other side asked for again, 2 = a new picture:
      // resends must never wait behind a later picture (2026-10-10: two pictures queued at once
      // starved each other's resends until both failed).
      this.queue.push({ pri: 2, fr: frame(T.START, xid, 0, startPayload(t)) });
      chunks.forEach((c, i) => this.queue.push({ pri: 2, fr: frame(T.DATA, xid, i, c) }));
      this.queue.push({ pri: 2, fr: frame(T.END, xid, chunks.length) });
      return xid;
    }
    // One small message in a single SHORT frame (see the header). The record looks like a one-chunk
    // transfer to the app's event handlers: tx-done = the other side has it, tx-failed = no answer.
    sendShort(data, { mime = 'application/x-kelly-kf', to = 0, from = 0 } = {}) {
      const used = new Set([...this.tx.keys(), ...this.rx.keys()]);
      const free = []; for (let x = 1; x < 256; x++) if (!used.has(x)) free.push(x);
      const xid = free[Math.floor(Math.random() * free.length)] || 1;
      const fr = shortFrame(xid, mime, { to, from }, Array.from(data));
      this.tx.set(xid, { xid, data, chunks: [Array.from(data)], mime, w: 0, h: 0, call: '', to, dest: 0, from, crc: crc32(data), short: true, fr,
        state: 'sending', sent: new Set(), rounds: 0, resent: 0, tries: 0, started: this.now(), finished: null, endAt: null });
      this.queue.push({ pri: 2, fr });
      return xid;
    }
    // Our SHORT request has been answered (a SHORT, a START or an ACK on its xid).
    shortDone(xid) {
      const t = this.tx.get(xid);
      if (!t || !t.short || t.state === 'done' || t.state === 'failed') return;
      t.state = 'done'; t.finished = this.now(); t.sent.add(0);
      this.queue = this.queue.filter(q => q.fr !== t.fr);
      this.onEvent({ kind: 'tx-done', t });
    }
    // Stop every picture we're sending (stuck transfer): mark them failed, drop their frames.
    // cancelled = false: Kelly ended them (its session closed with them unfinished), not the user.
    cancel(cancelled = true) {
      const now = this.now(); let n = 0;
      for (const t of this.tx.values()) if (t.state === 'sending' || t.state === 'waiting') { t.state = 'failed'; t.finished = now; n++; this.onEvent({ kind: 'tx-failed', t, cancelled }); }
      this.queue = this.queue.filter(q => q.pri === 0 && (() => { const f = parse(q.fr); return f && !this.tx.has(f.xid); })());
      return n;
    }
    // A picture of ours still going out or waiting for its answer?
    sending() { for (const t of this.tx.values()) if (t.state === 'sending' || t.state === 'waiting') return true; return false; }
    feed(bytes) { for (const f of this.splitter.push(bytes)) this.onFrame(f); }
    onFrame(f) {
      this.heardAt = this.now();
      const { type, xid, seq, payload } = f;
      if (type === T.ACK || type === T.NACK) {
        const t = this.tx.get(xid);
        if (!t || t.state === 'done' || t.state === 'failed') return;
        if (type === T.ACK && payload.length && payload[0] & ACK_TAKES_SHORT) this.onEvent({ kind: 'peer', short: true });
        if (type === T.ACK && t.short) { this.shortDone(xid); return; }
        if (type === T.ACK) { t.state = 'done'; t.finished = this.now(); this.onEvent({ kind: 'tx-done', t }); return; }
        if (t.short) return;
        const missing = []; for (let i = 0; i + 1 < payload.length; i += 2) missing.push((payload[i] << 8) | payload[i + 1]);
        t.rounds++; t.tries = 0;
        if (t.best === undefined || missing.length < t.best) { t.best = missing.length; t.stall = 0; }
        else if (++t.stall > MAX_STALL) { t.state = 'failed'; t.finished = this.now(); this.onEvent({ kind: 'tx-failed', t }); return; }
        t.state = 'sending';
        if (missing.includes(NEED_START)) this.queue.push({ pri: 1, fr: frame(T.START, xid, 0, startPayload(t)) });
        for (const i of missing) if (i < t.chunks.length) { this.queue.push({ pri: 1, fr: frame(T.DATA, xid, i, t.chunks[i]) }); t.resent++; }
        this.queue.push({ pri: 1, fr: frame(T.END, xid, t.chunks.length) });
        this.onEvent({ kind: 'tx-progress', t, note: `resending ${missing.length} chunk(s)` });
        return;
      }
      if (type === T.SHORT) { this.onShort(f); return; }
      let r = this.rx.get(xid);
      if (!r) { r = { xid, info: null, chunks: new Map(), state: 'receiving', started: this.now(), last: 0, image: null }; this.rx.set(xid, r); }
      r.last = this.now();
      if (type === T.START) {
        const info = parseStart(payload), me = +this.me() || 0;
        const ignore = !!(info.to && me && info.to !== me);
        // ...or a START after the transfer finished: a new one reusing the xid (a sender re-sends END, never START)
        if (ignore !== !!r.ignored || r.state === 'done') { r.chunks.clear(); r.state = 'receiving'; r.started = this.now(); r.data = null; }
        r.ignored = ignore;
        if (ignore) return;                       // someone else's picture (another Kelly to the gateway, or a forward)
        r.info = info;
        if (info.to) this.shortDone(xid);         // the answer to our SHORT request, too big for one frame
      }
      if (r.ignored) return;
      if (type === T.DATA) r.chunks.set(seq, Array.from(payload));
      else if (type === T.END) this.onEnd(r, seq);
      if (type !== T.END) this.onEvent({ kind: 'rx-progress', r });
    }
    // A SHORT frame: only ever taken when addressed to us by ID (requests to the gateway, answers to
    // other radios on the same repeater, and anything while our own ID isn't known are ignored).
    onShort(f) {
      const s = parseShort(f), me = +this.me() || 0;
      if (!s.to || !me || s.to !== me) return;
      const now = this.now(), old = this.rx.get(f.xid);
      this.shortDone(f.xid);
      // the same answer again (it crossed our retry): already handled
      if (old && old.short && old.state === 'done' && now - old.finished < 60000 && old.data.length === s.data.length && crc32(old.data) === crc32(s.data)) return;
      const r = { xid: f.xid, short: true, info: { mime: s.mime, size: s.data.length, nchunks: 1, to: s.to, from: s.from, call: '', w: 0, h: 0 },
        chunks: new Map([[0, Array.from(s.data)]]), state: 'done', started: now, finished: now, last: now, data: Uint8Array.from(s.data) };
      this.rx.set(f.xid, r);
      this.onEvent({ kind: 'rx-done', r });
    }
    onEnd(r, nchunks) {
      const { xid, info } = r;
      const answer = fr => { this.queue.push({ pri: 0, fr }); if (!this.canWrite) this.onEvent({ kind: 'need-answer', r }); };
      if (r.state === 'done') { answer(frame(T.ACK, xid, 0)); return; }
      const missing = info ? [] : [NEED_START];
      for (let i = 0; i < nchunks; i++) if (!r.chunks.has(i)) missing.push(i);
      const nack = list => answer(frame(T.NACK, xid, 0, list.slice(0, MAXP / 2).flatMap(u16)));
      if (missing.length) { this.onEvent({ kind: 'rx-progress', r, note: `${missing.length} missing` }); nack(missing); return; }
      const data = Uint8Array.from([].concat(...[...Array(nchunks).keys()].map(i => r.chunks.get(i))));
      if (data.length !== info.size || crc32(data) !== info.crc) { r.chunks.clear(); nack([...Array(nchunks).keys()]); return; }
      r.state = 'done'; r.finished = this.now(); r.data = data;
      this.onEvent({ kind: 'rx-done', r });
      answer(frame(T.ACK, xid, 0));
    }
    // Every ~200 ms: END resends while waiting for an answer, housekeeping, then send a burst.
    tick() {
      const now = this.now(), busy = this.channelBusy();
      for (const t of this.tx.values()) {
        if (busy && t.state === 'waiting' && t.endAt) { t.endAt = now; continue; }   // the channel's in use: the other side can't answer yet
        if (t.short) {
          if (t.state === 'waiting' && t.endAt && now - t.endAt > ACK_TIMEOUT_MS) {
            if (++t.tries >= SHORT_TRIES) { t.state = 'failed'; t.finished = now; this.onEvent({ kind: 'tx-failed', t }); continue; }
            t.endAt = null; t.state = 'sending'; t.resent++; this.queue.push({ pri: 0, fr: t.fr });
          }
          continue;
        }
        if (t.state === 'waiting' && t.endAt && now - t.endAt > ACK_TIMEOUT_MS) {
          if ((t.tries = (t.tries || 0) + 1) > MAX_ROUNDS) { t.state = 'failed'; t.finished = now; this.onEvent({ kind: 'tx-failed', t }); continue; }
          t.endAt = now; this.queue.push({ pri: 0, fr: frame(T.END, t.xid, t.chunks.length) });
        }
      }
      for (const [xid, r] of this.rx) if (now - r.last > 300000) this.rx.delete(xid);
      for (const [xid, t] of this.tx) if (t.finished && now - t.finished > 600000) this.tx.delete(xid);
      this.pump();
    }
    pump() {
      const now = this.now();
      if (!this.canWrite || !this.queue.length) return;
      if (this.channelBusy()) { this.backoffDue = true; return; }
      if (this.backoffDue) { this.backoffDue = false; this.nextBurstAt = Math.max(this.nextBurstAt, now + Math.random() * BACKOFF_MS); return; }
      if (now < this.nextBurstAt) return;
      this.queue.sort((a, b) => a.pri - b.pri);
      if (this.queue[0].pri !== 0 && now - this.heardAt < RX_QUIET_MS) return;   // the other side is talking
      const parts = []; let len = 0;
      while (this.queue.length && len + this.queue[0].fr.length <= BURST_MAX) {
        const fr = this.queue.shift().fr; parts.push(fr); len += fr.length;
        const f = parse(fr), t = f && this.tx.get(f.xid);
        if (t && f.type === T.DATA) t.sent.add(f.seq);
        if (t && (f.type === T.END || (f.type === T.SHORT && t.short))) { t.endAt = now; if (t.state === 'sending') t.state = 'waiting'; }
        if (t) this.onEvent({ kind: 'tx-progress', t });
      }
      if (!parts.length) return;
      const burst = new Uint8Array(len); let o = 0; for (const p of parts) { burst.set(p, o); o += p.length; }
      this.write(burst);
      this.nextBurstAt = now + airtimeMs(len) + GAP_MS;
    }
    // Anything still to do over the air? (open transfers or frames waiting to go out)
    busy() {
      if (this.queue.length) return true;
      for (const t of this.tx.values()) if (t.state === 'sending' || t.state === 'waiting') return true;
      return false;
    }
  }

  window.KellySstv = { T, NAMES, NEED_START, MAXP, BURST_MAX, SHORT_MAX, MIME_ID, frame, parse, startPayload, parseStart, shortFrame, parseShort, crc16, crc32, airtimeMs, Splitter, Link };
})();
