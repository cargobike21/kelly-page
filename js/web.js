/* Kelly Page -- P25X Web: a text web browser over P25 packet data (2026-10-17, test).
 *
 * The gateway fetches the page and cuts it down to text (dashboard web-lite.js: headings, paragraphs,
 * lists, numbered links [n]), then sends it one ~1.5 kB screen at a time -- ~1 kB packed, 2-3 s on air,
 * 5-9 s from the tap (measured over a TM9100, 2026-10-17). Kelly asks over the Radio-files
 * path, KF kind 3 {op: 'web', ...} -> kind 4 {app: 'web', url, title, status, page, pages, links, reader,
 * text} | {app: 'web', error}. Keep in step with the request comment above handle() in web-lite.js:
 *   {url, page?, reader?, fresh?}   open a page (or another screen of it; fresh = skip the gateway's 10 min cache)
 *   {q}                             search (DuckDuckGo lite, Marginalia if DDG is checking for robots)
 *   {link: n, from: url}            follow link n of that page -- the link table stays on the gateway
 * Screens already received are kept here (store 'web'), so Back and Prev screen cost no air.
 *
 * window.KellyWebUI(ctx) -> { init, render, shown, gatewayReply, ownsXid, kfEvent }; ctx from app.js.
 */
(function () {
  'use strict';
  const ANSWER_MS = 60000, SEND_MS = 90000, BUSY_MS = 30000, KEEP_DOCS = 12, KEEP_BYTES = 400000;
  const PICKS = [
    ['📰', 'NPR text', 'text.npr.org'], ['🗞️', 'CNN lite', 'lite.cnn.com'], ['🇦🇺', 'ABC News', 'https://www.abc.net.au/news', true],
    ['📡', 'WIA', 'https://www.wia.org.au/'], ['💻', 'Hacker News', 'news.ycombinator.com'],
    ['🎲', 'Random Wikipedia', 'https://en.wikipedia.org/wiki/Special:Random'],
  ];

  window.KellyWebUI = function (k) {
    const { $, esc, store, toast, dirty } = k;
    const S0 = () => ({ docs: [], cur: null, back: [], marks: [], reader: false, day: '', air: 0, screens: 0 });
    const w = Object.assign(S0(), store.get('web', {}) || {});
    const ui = { ask: null, err: '', fresh: false, t: null };
    let mode = '';

    function save() {
      while (w.docs.length > KEEP_DOCS || (w.docs.length > 1 && JSON.stringify(w.docs).length > KEEP_BYTES)) w.docs.pop();
      store.set('web', w);
    }
    const key = (url, reader) => `${reader ? 1 : 0}|${url}`;
    const doc = (url, reader) => w.docs.find(d => d.key === key(url, reader));
    const curDoc = () => (w.cur ? doc(w.cur.url, w.cur.reader) : null);
    function today() { const d = new Date().toDateString(); if (w.day !== d) { w.day = d; w.air = 0; w.screens = 0; } }

    // ------------------------------------------------------------------ asking the gateway
    // One request on the air at a time; a new tap while one is out replaces nothing (the button says so).
    async function ask(obj, label) {
      if (ui.ask) { toast('⏳', 'Still waiting for the last page', 'One page at a time on the radio', ''); return; }
      ensureMode();
      ui.err = '';
      if (mode === 'demo') {
        const xid = -Date.now();
        ui.ask = { obj, label, at: Date.now(), xid };
        setTimeout(() => { if (ui.ask && ui.ask.xid === xid) kfEvent({ kind: 'tx-done' }); }, 1300);
        setTimeout(() => { if (ui.ask && ui.ask.xid === xid) gatewayReply(demoGateway(obj)); }, 3600);
        tick(); dirty('web'); return;
      }
      if (!k.radioConnected()) { ui.err = 'Connect the radio first -- Admin › Connect'; dirty('web'); return; }
      ui.ask = { obj, label, at: Date.now() };   // held across the await so a redraw can't ask twice
      // The link stays busy a few seconds after each answer (closing that transfer): wait for it, like PBBS does
      while (k.rfBusy() && Date.now() - ui.ask.at < BUSY_MS) { ui.ask.queued = true; dirty('web'); await new Promise(r => setTimeout(r, 700)); }
      ui.ask.queued = false;
      if (k.rfBusy()) { ui.ask = null; ui.err = 'The radio is busy with another transfer -- try again in a moment'; dirty('web'); return; }
      const xid = await k.kfRequest({ op: 'web', ...obj }, label);
      if (!xid) { ui.ask = null; ui.err = 'Could not send the request'; dirty('web'); return; }
      ui.ask.xid = xid;
      setTimeout(() => {   // never got out (radio not parked for data, or the channel stayed busy): don't wait forever
        if (ui.ask && ui.ask.xid === xid && !ui.ask.delivered) {
          ui.ask = null; ui.err = 'The request never got out -- is the radio parked in P25 Transparent, and the channel free?'; dirty('web');
        }
      }, SEND_MS);
      tick(); dirty('web');
    }
    function tick() {   // the "waiting n s" counter; stops when the answer is in
      clearTimeout(ui.t);
      if (!ui.ask) return;
      dirty('web');
      ui.t = setTimeout(tick, 1000);
    }
    function kfEvent(e) {
      if (!ui.ask) return;
      if (e.kind === 'tx-done') {
        ui.ask.delivered = Date.now();
        const xid = ui.ask.xid;
        setTimeout(() => { if (ui.ask && ui.ask.xid === xid) { ui.ask = null; ui.err = 'The gateway took the request but no page came back -- try again'; dirty('web'); } }, ANSWER_MS);
      } else if (e.kind === 'tx-failed') {
        ui.ask = null; ui.err = e.cancelled ? '' : 'The request did not reach the P25X gateway';
      }
      dirty('web');
    }
    function gatewayReply(j, r) {   // r = the finished transfer (its packed bytes are what crossed the air)
      const a = ui.ask; ui.ask = null; clearTimeout(ui.t);
      today();
      const bytes = r && r.data ? r.data.length : Math.round(JSON.stringify(j).length * 0.6);
      w.air += bytes;
      if (j.error) { ui.err = j.error; save(); dirty('web'); return; }
      let d = doc(j.url, j.reader);
      if (!d || d.pages !== j.pages || (a && a.obj.fresh)) {   // new page, or it changed on the site
        if (d) w.docs.splice(w.docs.indexOf(d), 1);
        d = { key: key(j.url, j.reader), url: j.url, reader: !!j.reader, title: j.title || j.url, pages: j.pages, links: j.links, status: j.status, s: {} };
        w.docs.unshift(d);
      } else { w.docs.splice(w.docs.indexOf(d), 1); w.docs.unshift(d); }
      d.s[j.page] = j.text; d.at = Date.now();
      w.screens++;
      const was = w.cur;
      if (!was || was.url !== j.url || was.reader !== !!j.reader) {   // a different page: the old one goes on the back stack
        if (was && !(a && a.back)) { w.back.push(was); if (w.back.length > 30) w.back.shift(); }
      }
      w.cur = { url: j.url, reader: !!j.reader, page: j.page };
      ui.last = { secs: a ? (Date.now() - a.at) / 1000 : 0, bytes, page: j.page };
      ui.arrive = true;
      save(); dirty('web');
      const el = $('#wb-screen'); if (el) el.scrollTop = 0;
    }

    // ------------------------------------------------------------------ actions
    function looksLikeUrl(s) { return /^[a-z]+:\/\//i.test(s) || (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s)); }
    function go(input, reader = w.reader) {
      const s = String(input || '').trim();
      if (!s) return;
      if (/^\d{1,4}$/.test(s) && w.cur) return follow(+s);
      if (looksLikeUrl(s)) return open(s, 0, reader);
      ask({ q: s.slice(0, 200) }, `web search: ${s.slice(0, 40)}`);
    }
    function open(url, page = 0, reader = w.reader, opts = {}) {
      const d = doc(url, reader);
      if (d && d.s[page] != null && !opts.fresh) {   // already here: no air at all
        const was = w.cur;
        if (was && (was.url !== url || was.reader !== reader) && !opts.back) { w.back.push(was); if (w.back.length > 30) w.back.shift(); }
        w.cur = { url, reader, page }; ui.err = ''; ui.last = { secs: 0, bytes: 0, page, memory: true }; ui.arrive = true;
        save(); dirty('web'); return;
      }
      ask({ url, ...(page ? { page } : {}), ...(reader ? { reader: true } : {}), ...(opts.fresh ? { fresh: true } : {}) }, `web: ${url.slice(0, 50)}`)
        .then(() => { if (ui.ask && opts.back) ui.ask.back = true; });
    }
    function follow(n) {
      const d = curDoc();
      if (!d) return;
      if (n < 1 || n > d.links) { ui.err = `There is no link ${n} on this page`; dirty('web'); return; }
      ask({ link: n, from: d.url, ...(w.reader ? { reader: true } : {}) }, `web: link ${n}`);
    }
    function screen(delta) {
      const d = curDoc(); if (!d) return;
      const p = w.cur.page + delta;
      if (p < 0 || p >= d.pages) return;
      open(d.url, p, d.reader);
    }
    function back() {
      const prev = w.back.pop();
      if (!prev) return;
      open(prev.url, prev.page || 0, prev.reader, { back: true });
    }

    // ------------------------------------------------------------------ demo radio: a tiny make-believe web
    function demoGateway(o) {
      const site = {
        'https://kelly.demo/': ['Kelly demo web', '# P25X Web\n\nThis is the demo radio, so these pages come from Kelly itself. On a real radio the P25X gateway fetches any web page and sends it here as text, one screen at a time.\n\n* What is P25X Web?[1]\n* Project 25 in one screen[2]\n* Search the web: type words in the address bar[3]\n'],
        'https://kelly.demo/about': ['What is P25X Web?', '# What is P25X Web?\n\nThe gateway reads the page for you and keeps only the words: headings, paragraphs, lists and links. Pictures, scripts, menus and adverts never touch the air.\n\nA screen is about 1.5 kB of text -- about 1 kB on air, 2-3 seconds. Tap a link number to follow it[1]. Screens you have already seen come from memory with no air at all.\n'],
        'https://kelly.demo/p25': ['Project 25', '# Project 25\n\nProject 25 (P25 or APCO-25) is a suite of standards for interoperable digital land mobile radio. It carries voice and data -- like this page -- over a 12.5 kHz channel.\n\n* Back to the start[1]\n'],
      };
      const links = { 'https://kelly.demo/': ['https://kelly.demo/about', 'https://kelly.demo/p25', 'https://kelly.demo/'],
        'https://kelly.demo/about': ['https://kelly.demo/'], 'https://kelly.demo/p25': ['https://kelly.demo/'] };
      let url = o.url ? (looksLikeUrl(o.url) && !/^https?:/.test(o.url) ? `https://${o.url}` : o.url) : null;
      if (o.link) url = (links[o.from] || [])[o.link - 1];
      if (o.q) return { app: 'web', url: `https://kelly.demo/search?q=${encodeURIComponent(o.q)}`, title: `${o.q} -- demo search`, status: 200, page: 0, pages: 1, links: 0, reader: false,
        text: `# Results for "${o.q}"\n\nThe demo radio can't search the real web. Connect your radio and the gateway asks DuckDuckGo for you.\n` };
      if (!site[url]) return { app: 'web', error: url ? `The demo radio only has kelly.demo pages -- connect your radio for ${url}` : 'There is no such link' };
      const [title, text] = site[url];
      return { app: 'web', url, title, status: 200, page: 0, pages: 1, links: (links[url] || []).length, reader: false, text };
    }
    function ensureMode() {
      const m = k.demo() ? 'demo' : 'real';
      if (m === mode) return;
      mode = m;
      if (m === 'demo' && !w.cur) w.cur = null;
    }

    // ------------------------------------------------------------------ drawing
    // Text from web-lite.js: "# " headings, "* " list items, " | " table cells, [n] links, [alt] picture names.
    function screenHtml(text) {
      return text.split('\n').map(line => {
        let h = esc(line).replace(/\[(\d{1,4})\]/g, '<button class="wb-l" data-l="$1" title="Follow link $1">$1</button>');
        const m = line.match(/^(#{1,6}) /);
        if (m) return `<span class="wb-h wb-h${m[1].length}">${h.slice(m[1].length + 1)}</span>`;
        if (line.startsWith('* ')) return `<span class="wb-li">${h.slice(2)}</span>`;
        return h;
      }).join('\n');
    }
    function render() {
      ensureMode();
      today();
      const d = curDoc(), busy = !!ui.ask;
      $('#wb-go').disabled = busy;
      $('#wb-go').textContent = busy ? '⏳ Waiting…' : '🌐 Go';
      $('#wb-back').disabled = busy || !w.back.length;
      $('#wb-prev').disabled = busy || !d || w.cur.page <= 0;
      $('#wb-next').disabled = busy || !d || w.cur.page >= d.pages - 1;
      $('#wb-reload').disabled = busy || !d;
      $('#wb-reader').checked = !!w.reader;
      const marked = d && w.marks.some(m => m.url === d.url);
      $('#wb-mark').textContent = marked ? '★' : '☆';
      $('#wb-mark').classList.toggle('on', !!marked);
      $('#wb-mark').disabled = !d;
      // status line
      let st;
      if (busy) {
        const s = Math.round((Date.now() - ui.ask.at) / 1000);
        st = `<span class="wb-wait">${ui.ask.queued ? '⏳ Waiting for the radio' : ui.ask.delivered ? '📡 Gateway is fetching the page' : '📡 Sending the request'}… ${s} s</span>`;
      } else if (ui.err) st = `<span class="wb-err">⚠️ ${esc(ui.err)}</span>`;
      else if (d && ui.last) st = ui.last.memory ? `💾 From memory -- no air used` : `✅ ${(ui.last.bytes / 1000).toFixed(1)} kB in ${ui.last.secs.toFixed(1)} s`;
      else st = mode === 'demo' ? 'Demo radio: try the kelly.demo pages below' : 'Type a web address or some search words';
      $('#wb-status').innerHTML = st;
      $('#wb-air').textContent = `Today: ${w.screens} screen${w.screens === 1 ? '' : 's'} · ${(w.air / 1000).toFixed(1)} kB`;
      // the page
      const scr = $('#wb-screen');
      if (d) {
        const p = w.cur.page, text = d.s[p];
        $('#wb-title').textContent = d.title;
        $('#wb-url').textContent = d.url.replace(/^https?:\/\//, '') + (d.reader ? '  · reader' : '');
        $('#wb-pos').textContent = `Screen ${p + 1} of ${d.pages} · ${d.links} link${d.links === 1 ? '' : 's'}`;
        const html = text != null ? screenHtml(text) : '<span class="dim">This screen isn\'t here yet.</span>';
        if (scr.dataset.k !== `${d.key}#${p}`) {
          scr.innerHTML = html; scr.dataset.k = `${d.key}#${p}`;
          if (ui.arrive) { scr.classList.remove('wb-in'); void scr.offsetWidth; scr.classList.add('wb-in'); }
        }
      } else {
        $('#wb-title').textContent = 'P25X Web';
        $('#wb-url').textContent = '';
        $('#wb-pos').textContent = '';
        if (scr.dataset.k !== 'home') {
          scr.dataset.k = 'home';
          scr.innerHTML = `<span class="wb-h wb-h1">Web pages as text, over P25</span>\n\nThe P25X gateway reads the page and sends only the words, one screen at a time -- about 1 kB and a few seconds of air a screen. Pictures, scripts and adverts never touch the air.\n\n<span class="wb-li">Type a web address (<b>text.npr.org</b>) or some search words and press Go</span>\n<span class="wb-li">Tap a <button class="wb-l" disabled>3</button> to follow a link, or type its number</span>\n<span class="wb-li">Next screen › reads on; screens you've seen come back from memory with no air</span>\n<span class="wb-li"><b>Reader</b> keeps just the article on news sites</span>\n\n<span class="dim">Sites built with JavaScript (the new BOM site, for one) come through as menus only -- use Kelly's Weather page for the weather.</span>`;
        }
      }
      ui.arrive = false;
      // quick picks + bookmarks
      const picks = mode === 'demo' ? [['🏠', 'Demo start', 'https://kelly.demo/']] : PICKS;
      $('#wb-picks').innerHTML = picks.map(([i, n, u, r]) => `<button class="wb-chip" data-u="${esc(u)}"${r ? ' data-r="1"' : ''}>${i} ${esc(n)}</button>`).join('')
        + w.marks.map((m, i) => `<span class="wb-chip wb-mk"><button data-u="${esc(m.url)}"${m.reader ? ' data-r="1"' : ''}>⭐ ${esc(m.title.slice(0, 32))}</button><button class="wb-x" data-x="${i}" title="Remove">×</button></span>`).join('');
      // pages kept on this computer
      $('#wb-kept').innerHTML = w.docs.length ? w.docs.slice(0, KEEP_DOCS).map(x => {
        const n = Object.keys(x.s).length;
        return `<li><button data-u="${esc(x.url)}"${x.reader ? ' data-r="1"' : ''}>${esc(x.title.slice(0, 60))}</button><span class="dim small">${n}/${x.pages} screen${x.pages === 1 ? '' : 's'} · ${k.fmtAgo(x.at)}</span></li>`;
      }).join('') : '<li class="dim small">Pages you read are kept here, so going back costs no air.</li>';
    }
    function shown() { setTimeout(() => { const a = $('#wb-addr'); if (a && !w.cur) a.focus(); }, 50); dirty('web'); }

    function init() {
      $('#wb-form').onsubmit = e => { e.preventDefault(); go($('#wb-addr').value); };
      $('#wb-back').onclick = back;
      $('#wb-prev').onclick = () => screen(-1);
      $('#wb-next').onclick = () => screen(1);
      $('#wb-reload').onclick = () => { const d = curDoc(); if (d) open(d.url, w.cur.page, d.reader, { fresh: true }); };
      $('#wb-reader').onchange = e => { w.reader = e.target.checked; save(); dirty('web'); };
      $('#wb-mark').onclick = () => {
        const d = curDoc(); if (!d) return;
        const i = w.marks.findIndex(m => m.url === d.url);
        if (i >= 0) w.marks.splice(i, 1); else w.marks.push({ url: d.url, title: d.title, reader: d.reader });
        save(); dirty('web');
      };
      $('#wb-screen').onclick = e => { const b = e.target.closest('.wb-l'); if (b && !b.disabled) follow(+b.dataset.l); };
      const pick = e => {
        const x = e.target.closest('[data-x]');
        if (x) { w.marks.splice(+x.dataset.x, 1); save(); dirty('web'); return; }
        const b = e.target.closest('[data-u]');
        if (b) { $('#wb-addr').value = b.dataset.u.replace(/^https:\/\//, ''); open(b.dataset.u.includes('://') ? b.dataset.u : `https://${b.dataset.u}`, 0, !!b.dataset.r || w.reader); }
      };
      $('#wb-picks').onclick = pick;
      $('#wb-kept').onclick = pick;
      document.addEventListener('keydown', e => {   // ← → read on, when the page is open and no box has the keys
        if (k.currentPage() !== 'web' || /INPUT|TEXTAREA|SELECT/.test((e.target || {}).tagName || '')) return;
        if (e.key === 'ArrowRight') screen(1); else if (e.key === 'ArrowLeft') screen(-1);
      });
      if (w.cur && !curDoc()) w.cur = null;
    }

    return { init, render, shown, gatewayReply, kfEvent, ownsXid: xid => !!(ui.ask && ui.ask.xid === xid) };
  };
})();
