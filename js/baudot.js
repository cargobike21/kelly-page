/* Kelly Page -- Baudot (ITA2 / US-TTY) and RTTY FSK, pure: no DOM, no Web Audio (UMD, so tests run anywhere).
 *
 *   Baudot.encode(text, {variant, usos})  -> [{code, i}]   5-bit codes with the LTRS/FIGS shifts it needs; i = the
 *                                             index of the character in `text` it prints (-1 for a shift / sync code)
 *   new Baudot.Decoder({variant, usos})   .push(code) -> the character it prints ('' for a shift / NUL)
 *   Baudot.modulate(codes, opts)          -> {samples: Float32Array, at: [sample offset of each code's start bit]}
 *                                             phase-continuous AFSK: start bit (space), 5 data bits LSB first,
 *                                             1.5 stop bits (mark); idle mark before and after
 *   new Baudot.Demod(opts)                .process(Float32Array) -> [codes]; .scope (x/y pairs), .level, .tuned
 *                                             two quadrature mixers + a one-bit boxcar (a matched filter), a normalised
 *                                             mark-minus-space detector (works at any input level), squelch, and
 *                                             an async receiver that samples each bit in the middle
 *   opts: {rate, baud 45.45, mark 2125, shift 170, reverse, stop 1.5, amp, lead s, tail s}
 *
 * Amateur RTTY: 45.45 baud (60 WPM), 170 Hz shift, mark 2125 Hz / space 2295 Hz in the audio (LSB on the rig);
 * "reverse" swaps them. US-TTY figures (BEL on FIGS-S, $ on FIGS-D...) are the amateur default; ITA2 is the
 * international one. USOS = unshift on space: after a space the receiver goes back to letters.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Baudot = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NUL = 0x00, LF = 0x02, SP = 0x04, CR = 0x08, FIGS = 0x1B, LTRS = 0x1F;
  //           0     1    2     3    4    5    6    7    8     9    10   11   12   13   14   15   16   17   18   19   20   21   22   23   24   25   26   27  28   29   30   31
  const L = ['', 'E', '\n', 'A', ' ', 'S', 'I', 'U', '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K', 'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q', 'O', 'B', 'G', '', 'M', 'X', 'V', ''];
  const F_US = ['', '3', '\n', '-', ' ', '\x07', '8', '7', '\r', '$', '4', "'", ',', '!', ':', '(', '5', '"', ')', '2', '#', '6', '0', '1', '9', '?', '&', '', '.', '/', ';', ''];
  const F_ITA2 = ['', '3', '\n', '-', ' ', "'", '8', '7', '\r', '', '4', '\x07', ',', '!', ':', '(', '5', '+', ')', '2', '', '6', '0', '1', '9', '?', '&', '', '.', '/', '=', ''];
  const figsOf = v => (v === 'ita2' ? F_ITA2 : F_US);
  const indexOf = tbl => { const m = {}; tbl.forEach((c, i) => { if (c && !(c in m)) m[c] = i; }); return m; };
  const LI = indexOf(L), FI_US = indexOf(F_US), FI_ITA2 = indexOf(F_ITA2);
  // characters Baudot can't print, the nearest it can
  const SUBST = { '[': '(', ']': ')', '{': '(', '}': ')', '<': '(', '>': ')', '_': '-', '*': '#', '@': 'AT', '%': 'PCT', '|': '/', '\\': '/', '~': '-', '`': "'", '^': "'", '\t': ' ' };

  // What Baudot can show of a text: upper case, substitutes, nothing unprintable (for the screen and the counter)
  function printable(text, variant) {
    const FI = variant === 'ita2' ? FI_ITA2 : FI_US;
    let out = '';
    for (let ch of String(text || '').toUpperCase().replace(/\r\n?/g, '\n')) {
      if (ch in LI || ch in FI) { out += ch; continue; }
      if (SUBST[ch]) { for (const c of SUBST[ch]) if (c in LI || c in FI) out += c; }
    }
    return out;
  }
  function encode(text, { variant = 'us', usos = true, sync = true } = {}) {
    const FI = variant === 'ita2' ? FI_ITA2 : FI_US, out = [];
    let shift = 'L';
    if (sync) out.push({ code: LTRS, i: -1 });
    const src = String(text || '').toUpperCase().replace(/\r\n?/g, '\n');
    for (let i = 0; i < src.length; i++) {
      let ch = src[i];
      const chars = ch in LI || ch in FI ? [ch] : (SUBST[ch] ? [...SUBST[ch]] : []);
      for (ch of chars) {
        if (ch === '\n') { out.push({ code: CR, i }, { code: LF, i }); continue; }
        if (ch === ' ') { out.push({ code: SP, i }); if (usos) shift = 'L'; continue; }
        if (ch in LI) { if (shift !== 'L') { out.push({ code: LTRS, i: -1 }); shift = 'L'; } out.push({ code: LI[ch], i }); }
        else if (ch in FI) { if (shift !== 'F') { out.push({ code: FIGS, i: -1 }); shift = 'F'; } out.push({ code: FI[ch], i }); }
      }
    }
    return out;
  }
  class Decoder {
    constructor({ variant = 'us', usos = true } = {}) { this.variant = variant; this.usos = usos; this.shift = 'L'; }
    push(code) {
      code &= 31;
      if (code === LTRS) { this.shift = 'L'; return ''; }
      if (code === FIGS) { this.shift = 'F'; return ''; }
      if (code === NUL) return '';
      if (code === SP) { if (this.usos) this.shift = 'L'; return ' '; }
      if (code === CR || code === LF) return code === CR ? '\r' : '\n';
      return (this.shift === 'F' ? figsOf(this.variant) : L)[code] || '';
    }
  }

  // ---------------------------------------------------------------- modulator
  function tones({ mark = 2125, shift = 170, reverse = false } = {}) {
    const space = mark + shift;
    return reverse ? { mark: space, space: mark } : { mark, space };
  }
  function modulate(codes, { rate = 48000, baud = 45.45, mark = 2125, shift = 170, reverse = false, stop = 1.5, amp = 0.5, lead = 0.25, tail = 0.15 } = {}) {
    const t = tones({ mark, shift, reverse }), spb = rate / baud;
    const bits = [], at = [];
    // the bit stream as [level, duration in bits]
    const seg = [];
    seg.push([1, lead * baud]);
    for (const c of codes) {
      const code = typeof c === 'number' ? c : c.code;
      at.push(null);   // filled below
      seg.push(['s', 0]);   // marker: a code starts here
      seg.push([0, 1]);
      for (let b = 0; b < 5; b++) seg.push([(code >> b) & 1, 1]);
      seg.push([1, stop]);
    }
    seg.push([1, tail * baud]);
    let total = 0; for (const [v, d] of seg) if (v !== 's') total += d;
    const n = Math.ceil(total * spb), samples = new Float32Array(n);
    let pos = 0, phase = 0, k = 0, ci = 0;
    const ramp = Math.round(rate * 0.004);   // 4 ms fade in / out: no click
    for (const [v, d] of seg) {
      if (v === 's') { at[ci++] = Math.round(pos); continue; }
      const end = Math.min(n, Math.round(pos + d * spb)), w = 2 * Math.PI * (v ? t.mark : t.space) / rate;
      for (; k < end; k++) { phase += w; if (phase > 6.283185307) phase -= 6.283185307; samples[k] = amp * Math.sin(phase); }
      pos += d * spb;
      bits.push(v);
    }
    for (let i = 0; i < ramp && i < n; i++) { const g = i / ramp; samples[i] *= g; samples[n - 1 - i] *= g; }
    return { samples, at, rate, spb };
  }

  // ---------------------------------------------------------------- demodulator
  class Demod {
    constructor({ rate = 48000, baud = 45.45, mark = 2125, shift = 170, reverse = false, squelch = 0.4, afc = true } = {}) {
      this.rate = rate; this.squelch = squelch; this.afcOn = afc; this.set({ baud, mark, shift, reverse });
    }
    set({ baud = this.baud, mark = this.markF0, shift = this.shiftHz, reverse = this.reverse } = {}) {
      this.baud = baud; this.markF0 = mark; this.shiftHz = shift; this.reverse = reverse;
      const t = tones({ mark, shift, reverse });
      this.t = t; this.afc = 0; this.afcN = 0; this.z0 = null;
      this.wm = 2 * Math.PI * t.mark / this.rate; this.ws = 2 * Math.PI * t.space / this.rate;
      this.spb = this.rate / baud;
      this.N = Math.max(8, Math.round(this.spb));   // one bit: a matched filter for a steady tone
      this.buf = new Float32Array(this.N * 5); this.bi = 0;   // I/Q of mark, I/Q of space, the input's power
      this.sum = new Float64Array(5);
      this.pm = 0; this.ps = 0; this.n = 0;
      this.state = 'idle'; this.cnt = 0; this.markRun = 0; this.code = 0; this.bit = 0;
      this.purity = 0; this.level = 0; this.tuned = 0; this.errors = 0;
      // band-pass filters for the crossed-ellipse tuning scope
      this.bm = bp(t.mark, this.rate, Math.max(12, t.mark / (shift * 0.45))); this.bs = bp(t.space, this.rate, Math.max(12, t.space / (shift * 0.45)));   // narrow enough that mark draws flat and space tall
      // the receiver's RTTY filter: a band-pass around both tones (shift + a few baud wide), two sections
      const fc = (t.mark + t.space) / 2, q = fc / (shift + 5 * baud);
      this.pre1 = bp(fc, this.rate, q); this.pre2 = bp(fc, this.rate, q);
      this.scope = []; this.dec = 0;
    }
    process(x) {
      const out = [], N = this.N, buf = this.buf, s = this.sum;
      const step = Math.max(1, Math.round(this.rate / 6000));
      for (let k = 0; k < x.length; k++) {
        const v = this.pre2(this.pre1(x[k])) * 1.4;
        this.pm += this.wm; if (this.pm > 6.283185307) this.pm -= 6.283185307;
        this.ps += this.ws; if (this.ps > 6.283185307) this.ps -= 6.283185307;
        const mi = v * Math.cos(this.pm), mq = v * Math.sin(this.pm), si = v * Math.cos(this.ps), sq = v * Math.sin(this.ps);
        const o = this.bi * 5, pw = v * v;
        s[0] += mi - buf[o]; s[1] += mq - buf[o + 1]; s[2] += si - buf[o + 2]; s[3] += sq - buf[o + 3]; s[4] += pw - buf[o + 4];
        buf[o] = mi; buf[o + 1] = mq; buf[o + 2] = si; buf[o + 3] = sq; buf[o + 4] = pw;
        this.bi = (this.bi + 1) % N;
        const m = Math.hypot(s[0], s[1]) / N, sp = Math.hypot(s[2], s[3]) / N, tot = m + sp, ms = Math.max(s[4], 0) / N;
        // squelch on purity: the share of the input's power that is in the two tones (1 = a clean FSK signal,
        // small = noise or voice) -- level-independent, so it never creeps shut on a long over
        const purity = ms > 1e-8 ? Math.min(1, 2 * (m * m + sp * sp) / ms) : 0;
        this.level = Math.sqrt(ms); this.purity += (purity - this.purity) / N;   // smoothed over a bit: a bit edge doesn't shut it
        const open = ms > 1e-7 && this.purity > 0.2 + 0.5 * this.squelch;
        // AFC: the stronger tone's phasor turns at minus the tuning error; follow it whenever something tone-like is
        // there (a lower bar than the squelch, so a signal 25-50 Hz off still gets pulled in), +-80 Hz at most
        if (this.afcOn && ++this.afcN >= (N >> 2)) {
          this.afcN = 0;
          const mk = m >= sp, z = mk ? [s[0], s[1]] : [s[2], s[3]];
          if (this.z0 && this.z0[2] === mk && this.purity > 0.26) {
            const re = z[0] * this.z0[0] + z[1] * this.z0[1], im = z[1] * this.z0[0] - z[0] * this.z0[1];
            const err = -Math.atan2(im, re) * this.rate / (2 * Math.PI * (N >> 2));
            this.afc = Math.max(-80, Math.min(80, this.afc + 0.08 * err));
            this.wm = 2 * Math.PI * (this.t.mark + this.afc) / this.rate; this.ws = 2 * Math.PI * (this.t.space + this.afc) / this.rate;
          }
          this.z0 = [z[0], z[1], mk];
        }   // noise alone measures <= 0.23, a weak signal >= 0.5 (2026-10-18)
        const d = (m - sp) / (tot + 1e-9);   // -1 = space, +1 = mark, at any level
        this.tuned = this.tuned * 0.999 + (open ? Math.abs(d) : 0) * 0.001;
        if (++this.dec >= step) {
          this.dec = 0;
          const a = this.bm(v), b = this.bs(v);
          if (this.scope.length < 1200) this.scope.push(a, b);
        } else { this.bm(v); this.bs(v); }
        const bit = open ? (d > 0 ? 1 : 0) : 1;   // no signal = idle mark
        // async receiver
        if (this.state === 'idle') {
          if (bit) this.markRun++;
          else if (this.markRun > this.spb * 0.5) { this.state = 'start'; this.cnt = 0; }
          if (!bit) this.markRun = 0;
        } else {
          this.cnt++;
          const t = this.cnt / this.spb;
          if (this.state === 'start' && t >= 0.5) { if (bit) { this.state = 'idle'; this.markRun = 1; } else { this.state = 'data'; this.bit = 0; this.code = 0; } }
          else if (this.state === 'data' && t >= 1.5 + this.bit) { this.code |= bit << this.bit; if (++this.bit === 5) this.state = 'stop'; }
          else if (this.state === 'stop' && t >= 6.5) {
            if (bit) out.push(this.code); else this.errors++;
            this.state = 'idle'; this.markRun = bit ? this.spb : 0;
          }
        }
      }
      return out;
    }
    takeScope() { const s = this.scope; this.scope = []; return s; }
  }
  // a two-pole band-pass (RBJ cookbook), as a closure
  function bp(f, rate, q) {
    const w = 2 * Math.PI * f / rate, al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return v => { const y = b0 * v + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; return y; };
  }

  // the bit pattern of a code, start + 5 data + stop, for the tape / chart (1 = mark = a hole)
  const holes = code => [0, 1, 2, 3, 4].map(b => (code >> b) & 1);
  const charTime = (baud = 45.45, stop = 1.5) => (6 + stop) / baud;   // seconds per code
  const wpm = (baud = 45.45, stop = 1.5) => Math.floor(60 / (charTime(baud, stop) * 6) + 1e-6);   // 45.45 Bd = "60 WPM" (60.6)   // 6 codes a word

  return { encode, printable, Decoder, modulate, Demod, tones, holes, charTime, wpm, L, F_US, F_ITA2, LTRS, FIGS, CR, LF, SP, NUL };
});
