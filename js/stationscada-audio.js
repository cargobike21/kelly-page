/* Kelly Page -- Station SCADA sound engine. Every sound is made with the Web Audio API (no files):
 *   tx    rising chirp   (a LoRa up-chirp, the way CSS modulation sweeps)
 *   rx    falling chirp
 *   usb   a soft click   (rate-limited: a busy serial link is a ticking, not a buzz)
 *   alarm two-tone alert, three times, for a NEW alarm only
 *   cw    Morse at 20 WPM, 700 Hz, with a callback per element so the TX LED keys in time
 * Starts MUTED (browser autoplay rules); the mute + volume are remembered in localStorage (try/catch: a private
 * window or blocked storage just forgets).
 *
 * StationScadaAudio(getCtx) -> { play(kind), cw(text, onKey), muted, volume, setMuted(b), setVolume(0..1), enabled }
 *   getCtx = Kelly's audioCtx() (one shared AudioContext, resumed on use)
 */
(function () {
  'use strict';
  const KEY = 'kelly.stationScadaSound';
  const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
    Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
    5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '/': '-..-.', '?': '..--..', '.': '.-.-.-' };

  window.StationScadaAudio = function (getCtx) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
    const a = { muted: saved.muted !== false, volume: saved.volume == null ? 0.5 : +saved.volume, enabled: { tx: true, rx: true, usb: true, alarm: true } };
    let master = null, last = {};
    const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ muted: a.muted, volume: a.volume })); } catch { /* storage off: session only */ } };
    function out() {
      const ctx = getCtx(); if (!ctx) return null;
      if (!master || master.context !== ctx) { master = ctx.createGain(); master.connect(ctx.destination); }
      master.gain.value = a.volume * 0.6;
      return ctx;
    }
    // one enveloped oscillator sweep
    function tone(ctx, { f0, f1 = f0, dur, type = 'sine', gain = 0.3, at = 0 }) {
      const t = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur / 4)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
    }
    function click(ctx) {
      const len = Math.floor(ctx.sampleRate * 0.004), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      f.type = 'bandpass'; f.frequency.value = 3200; f.Q.value = 2; g.gain.value = 0.35;
      s.buffer = buf; s.connect(f); f.connect(g); g.connect(master); s.start();
    }
    const GAP = { tx: 90, rx: 90, usb: 140, alarm: 1500 };
    function play(kind) {
      if (a.muted || !a.enabled[kind]) return;
      const now = performance.now(); if (now - (last[kind] || 0) < (GAP[kind] || 0)) return; last[kind] = now;
      const ctx = out(); if (!ctx) return;
      if (kind === 'tx') tone(ctx, { f0: 420, f1: 1650, dur: 0.16, type: 'sawtooth', gain: 0.09 });
      else if (kind === 'rx') tone(ctx, { f0: 1500, f1: 380, dur: 0.16, type: 'triangle', gain: 0.18 });
      else if (kind === 'usb') click(ctx);
      else if (kind === 'alarm') for (let i = 0; i < 3; i++) { tone(ctx, { f0: 880, dur: 0.18, type: 'square', gain: 0.08, at: i * 0.45 }); tone(ctx, { f0: 660, dur: 0.18, type: 'square', gain: 0.08, at: i * 0.45 + 0.2 }); }
    }
    // Morse: unit = 1200 / wpm ms. Plays even when muted? No -- muted keys the LED only (onKey still fires).
    function cw(text, onKey, wpm = 20) {
      const unit = 1200 / wpm, els = [];
      let t = 0;
      for (const word of String(text).toUpperCase().split(/\s+/).filter(Boolean)) {
        for (const ch of word) { const code = MORSE[ch]; if (!code) continue; for (const s of code) { const d = s === '.' ? unit : 3 * unit; els.push([t, d]); t += d + unit; } t += 2 * unit; }
        t += 4 * unit;
      }
      const ctx = !a.muted ? out() : null;
      for (const [st, d] of els) {
        if (ctx) tone(ctx, { f0: 700, dur: d / 1000, type: 'sine', gain: 0.22, at: st / 1000 });
        if (onKey) { setTimeout(() => onKey(true), st); setTimeout(() => onKey(false), st + d); }
      }
      return t;   // ms until it's done
    }
    a.play = play; a.cw = cw;
    a.setMuted = m => { a.muted = !!m; persist(); if (!a.muted) out(); };
    a.setVolume = v => { a.volume = Math.max(0, Math.min(1, +v)); persist(); if (master) master.gain.value = a.volume * 0.6; };
    return a;
  };
})();
