/* Kelly Page -- a timer that keeps time in a background tab (2026-10-31).
 * Chrome throttles a hidden tab's own timers to about once a minute (intensive throttling, after 5 min hidden), so a
 * 1 s setInterval in the APRS iGate fired a minute late and every MeshPRS frame was past its 15 s hold ('expired') --
 * a whole ride went missing while the owner's PC Kelly tab sat behind other windows. A dedicated worker's timers aren't
 * throttled like that, and its message wakes the page at once, so the loop runs on the worker's clock instead.
 *   window.KellyBgTick(fn, ms) -> stop()   like setInterval(fn, ms); falls back to setInterval without workers
 */
(function () {
  'use strict';
  const SRC = 'const t=new Map();onmessage=e=>{const[d,id,ms]=e.data;'
    + 'if(d==="on")t.set(id,setInterval(()=>postMessage(id),ms));else{clearInterval(t.get(id));t.delete(id);}};';
  const timers = new Map();   // id -> { fn, ms, iv (setInterval id while on the fallback) }
  let worker = null, seq = 0;
  const fallback = t => { if (t.iv == null) t.iv = setInterval(t.fn, t.ms); };
  function getWorker() {
    if (worker !== null) return worker;
    try {
      worker = new Worker(URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' })));
      worker.onmessage = e => { const t = timers.get(e.data); if (t) t.fn(); };
      worker.onerror = () => { worker = false; timers.forEach(fallback); };
    } catch { worker = false; }
    return worker;
  }
  window.KellyBgTick = function (fn, ms) {
    const id = ++seq, t = { fn: () => { try { fn(); } catch (e) { console.warn('KellyBgTick', e); } }, ms, iv: null };
    timers.set(id, t);
    const w = getWorker();
    if (w) w.postMessage(['on', id, ms]); else fallback(t);
    return () => { timers.delete(id); if (worker) worker.postMessage(['off', id]); if (t.iv != null) clearInterval(t.iv); };
  };
})();
