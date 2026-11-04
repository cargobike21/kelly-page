/* Kelly Page -- RTTY Quest: the RTTY page's game layer (window.KellyRttyFun(ctx) -> { event, board, render }).
 *
 * rtty.js feeds it events through F() (try/catch -- a game bug never breaks the teleprinter):
 *   send/tx {text, ch, n} · rx {r, ch, named} · qsl {call, pts, ch, sprint, ts} · join · bell · art · banner · qslcard
 *   news · tape · adif · log {call, name, qth} · macro · capture · hfon · hfcopy {n} · hfline {prefixes} · hftx · hfshare · pbbspost
 * Points that matter (the club board, sprints) are the GATEWAY's -- QSOs it confirmed. This file is the personal
 * side: XP + ranks named after the old telegraph and teleprinter trades, 34 trophies, three daily missions seeded by
 * date + call, records, the P25X RTTY Award (Bronze / Silver / Gold / Worked All P25X, printable certificate).
 * XP for sending is capped (15 overs a day) -- airtime is shared. Profile in store 'rttyQuest'; the demo plays on a
 * throwaway one. Celebrations play once (a bell, a burst, a banner) -- nothing loops (kelly-page/CLAUDE.md).
 */
(function () {
  'use strict';
  const RANKS = [[0, 'Messenger'], [100, 'Tape Puncher'], [250, 'Keyboard Operator'], [500, 'Teleprinter Operator'], [900, 'Telegraphist'], [1500, 'Senior Telegraphist'],
    [2400, 'Traffic Handler'], [3600, 'Chief Operator'], [5200, 'Wire Chief'], [7500, 'Machine Master'], [10000, 'Golden Teletype']];
  const REPEATERS = ['VK4RSA', 'VK4RBX', 'VK4ZR', 'VK4RMC', 'VK4RAR', 'VK4RGX', 'VK4RES', 'VK4RET', 'VK4RTQ'];
  // [id, icon, name, how, test(profile)]
  const TROPHIES = [
    ['first_cq', '📣', 'First CQ', 'Call CQ on any channel', p => p.s.cq >= 1],
    ['first_qso', '🤝', 'First contact', 'A QSO confirmed by the gateway', p => p.s.qsos >= 1],
    ['qso10', '🔟', 'Ten on the roll', '10 confirmed QSOs', p => p.s.qsos >= 10],
    ['qso50', '📜', 'Fifty-QSO tape', '50 confirmed QSOs', p => p.s.qsos >= 50],
    ['qso100', '💯', 'Century', '100 confirmed QSOs', p => p.s.qsos >= 100],
    ['qso500', '🏛️', 'Wire service', '500 confirmed QSOs', p => p.s.qsos >= 500],
    ['calls10', '👥', 'Round table', 'QSOs with 10 different stations', p => n(p.s.calls) >= 10],
    ['calls25', '🌐', 'Well connected', 'QSOs with 25 different stations', p => n(p.s.calls) >= 25],
    ['linked', '🔗', 'Linked up', 'A QSO with a station on another repeater', p => p.s.xrep >= 1],
    ['reps5', '🗼', 'Five towers', 'Work stations on 5 different P25X repeaters', p => n(p.s.sites) >= 5],
    ['wap25x', '👑', 'Worked All P25X', 'Work stations on all nine P25X repeaters', p => REPEATERS.every(r => p.s.sites[r])],
    ['local', '📍', 'Local hero', '5 QSOs on LOCAL', p => p.s.localQ >= 5],
    ['net', '🎙️', 'Checked in', 'Send an over on NET', p => p.s.net >= 1],
    ['sprint1', '🏁', 'Sprinter', 'A QSO in the weekly P25X Sprint', p => p.s.sprintQ >= 1],
    ['sprint5', '⚡', 'Sprint five', '5 QSOs in one sprint', p => Object.values(p.s.sprintBy || {}).some(v => v >= 5)],
    ['podium', '🥇', 'On the podium', 'Top three in a sprint (gateway results)', p => !!p.s.podium],
    ['night', '🦉', 'Night owl', 'A QSO between midnight and 5 am', p => p.s.nightQ >= 1],
    ['early', '🌅', 'Early bird', 'A QSO between 5 and 7 am', p => p.s.earlyQ >= 1],
    ['ragchew', '☕', 'Ragchewer', '10 overs back and forth with one station in a day', p => p.s.ragchew >= 1],
    ['bell', '🔔', 'Bell ringer', 'Ring the bell (BEL) on a channel', p => p.s.bells >= 1],
    ['artist', '🎨', 'RTTY artist', 'Send 3 pieces of RTTY art', p => p.s.art >= 3],
    ['banner', '🪧', 'Banner day', 'Send a banner', p => p.s.banners >= 1],
    ['qslcard', '🪪', 'Card sender', 'Send an RTTY QSL card', p => p.s.qslcards >= 1],
    ['ryry', '〰️', 'RYRY', 'Send a RYRY test', p => p.s.ryry >= 1],
    ['fox', '🦊', 'Quick brown fox', 'Send THE QUICK BROWN FOX...', p => p.s.fox >= 1],
    ['news', '🗞️', 'Wire reader', 'Print 5 PBBS bulletins on the news printer', p => p.s.news >= 5],
    ['pbbs', '📟', 'For the record', 'Copy a channel to the PBBS', p => p.s.pbbspost >= 1],
    ['log25', '📒', 'Logbook keeper', '25 QSOs in your logbook', p => p.s.logged >= 25],
    ['adif', '💾', 'Paperwork', 'Export your log as ADIF', p => p.s.adif >= 1],
    ['tape', '🎞️', 'Tape library', 'Save a paper tape', p => p.s.tape >= 1],
    ['hfcopy', '📻', 'Off the air', 'Copy 100 characters of real HF RTTY', p => p.s.hfChars >= 100],
    ['dxcopy', '🌏', 'DX copy', 'Copy callsigns from 5 different prefixes on HF', p => p.s.prefixes >= 5],
    ['hftx', '📡', 'On HF', 'Key your HF rig from the teleprinter', p => p.s.hfTx >= 1],
    ['streak7', '🔥', 'Week on the wire', 'Send an over 7 days running', p => streak(p) >= 7],
  ];
  // daily missions: [id, text, counter, need]
  const MISSIONS = [['cq', 'Call CQ on MAIN', 'cq', 1], ['qso2', 'Make 2 QSOs', 'qso', 2], ['xrep', 'Work a station on another repeater', 'xrep', 1], ['bell', 'Ring the bell', 'bell', 1],
    ['art', 'Send a piece of RTTY art', 'art', 1], ['news', 'Print a PBBS bulletin on the news printer', 'news', 1], ['net', 'Check in on NET', 'net', 1], ['log', 'Log a QSO with name and QTH', 'logfull', 1],
    ['ryry', 'Send a RYRY test', 'ryry', 1], ['hf', 'Copy 40 characters off HF', 'hf', 40], ['banner', 'Send a banner', 'banner', 1], ['five', 'Exchange 5 overs with one station', 'pair', 5], ['overs', 'Send 5 overs', 'overs', 5]];
  const XP = { over: 5, qso: 25, newcall: 25, xrep: 15, trophy: 50, mission: 40, art: 10, news: 5, log: 5, hf: 1 };
  const n = o => Object.keys(o || {}).length;
  const today = () => new Date().toISOString().slice(0, 10);
  function streak(p) { let c = 0; for (let i = 0; i < 400; i++) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); if (p.days[d]) c++; else if (i) break; } return c; }

  window.KellyRttyFun = function (k) {
    const { esc, store, toast } = k;
    const P0 = () => ({ xp: 0, trophies: {}, days: {}, s: { cq: 0, qsos: 0, calls: {}, sites: {}, xrep: 0, localQ: 0, net: 0, sprintQ: 0, sprintBy: {}, podium: 0, nightQ: 0, earlyQ: 0, ragchew: 0,
      bells: 0, art: 0, banners: 0, qslcards: 0, ryry: 0, fox: 0, news: 0, pbbspost: 0, logged: 0, adif: 0, tape: 0, hfChars: 0, prefixes: 0, hfTx: 0, overs: 0, longest: 0, bestDay: 0, lastSite: {} },
      daily: { d: '', cnt: {}, done: {}, xpTx: 0, xpHf: 0, xpArt: 0, xpNews: 0, pairs: {}, qsos: 0 } });
    let real = deep(P0(), store.get('rttyQuest', {}) || {}), demo = P0();
    const p = () => (k.demo() ? demo : real);
    function deep(a, b) { for (const [x, v] of Object.entries(b || {})) a[x] = v && typeof v === 'object' && !Array.isArray(v) && a[x] && typeof a[x] === 'object' ? deep(a[x], v) : v; return a; }
    const save = () => { if (!k.demo()) store.set('rttyQuest', real); };
    const fresh = new Set();
    function day(q) {
      if (q.daily.d !== today()) q.daily = { d: today(), cnt: {}, done: {}, xpTx: 0, xpHf: 0, xpArt: 0, xpNews: 0, pairs: {}, qsos: 0 };
      return q.daily;
    }
    // three missions a day, the same all day for this call
    function missions(q) {
      let h = 2166136261; for (const c of `${today()}|${k.me()}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
      const pool = [...MISSIONS], out = [];
      while (out.length < 3) { h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0; out.push(pool.splice(h % pool.length, 1)[0]); }
      return out;
    }
    const rankOf = xp => { let i = 0; while (i + 1 < RANKS.length && xp >= RANKS[i + 1][0]) i++; return i; };
    function gain(q, x, why) {
      const before = rankOf(q.xp); q.xp += x;
      const after = rankOf(q.xp);
      if (after > before) celebrate('level', `LEVEL ${after + 1} -- ${RANKS[after][1].toUpperCase()}`, `${q.xp} XP · ${why}`);
    }
    function cnt(q, key, by = 1) {
      const d = day(q); d.cnt[key] = (d.cnt[key] || 0) + by;
      for (const [id, text, c, need] of missions(q)) if (c === key && !d.done[id] && d.cnt[key] >= need) { d.done[id] = 1; gain(q, XP.mission, 'mission'); celebrate('mission', `MISSION DONE`, text); }
    }
    function check(q) {
      for (const [id, icon, name, how, test] of TROPHIES) {
        if (q.trophies[id]) continue;
        let ok = false; try { ok = test(q); } catch {}
        if (ok) { q.trophies[id] = Date.now(); fresh.add(id); setTimeout(() => { fresh.delete(id); k.dirty('rtty'); }, 6000); gain(q, XP.trophy, name); celebrate('trophy', `${icon} ${name.toUpperCase()}`, how); }
      }
    }
    // one-shot celebration: a burst of type slugs, a bell, a toast
    function celebrate(kind, title, sub) {
      toast(kind === 'level' ? '🎖️' : kind === 'mission' ? '🎯' : '🏆', title, sub, 'good', () => k.showTab('quest'));
      const s = k.sound(); if (s) { const t = s.ac.currentTime + 0.1; s.bell(t, 0.25); if (kind !== 'mission') { s.bell(t + 0.25, 0.25); s.bell(t + 0.5, 0.3); } }
      if (!k.settings.fx || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const b = document.createElement('div'); b.className = `rt-burst rt-burst-${kind}`;
      b.innerHTML = `<b>${esc(title)}</b>${'RYRY73DEK'.split('').map((c, i) => `<i style="--a:${i * 40}deg">${c}</i>`).join('')}`;
      document.body.appendChild(b); setTimeout(() => b.remove(), 2600);
    }
    const isCall = (t, c) => new RegExp(`\\b${c}\\b`).test(t);
    function event(ev, d) {
      const q = p(), dd = day(q), t = String((d && d.text) || '').toUpperCase();
      q.days[today()] = q.days[today()] || 0;
      if (ev === 'tx') {
        q.days[today()] = 1; q.s.overs++; q.s.longest = Math.max(q.s.longest, t.length); cnt(q, 'overs');
        if (dd.xpTx < 15) { dd.xpTx++; gain(q, XP.over, 'over'); }
        if (/\bCQ\b/.test(t)) { q.s.cq++; if (d.ch === 'MAIN') cnt(q, 'cq'); }
        if (/(RY){4,}/.test(t)) { q.s.ryry++; cnt(q, 'ryry'); }
        if (/QUICK BROWN FOX/.test(t)) q.s.fox++;
        if (/\x07/.test(t)) { q.s.bells++; cnt(q, 'bell'); }
        if (d.ch === 'NET') { q.s.net++; cnt(q, 'net'); }
        for (const c of t.match(/\b(?:[A-Z]{1,2}|\d[A-Z])\d[A-Z]{1,4}\b/g) || []) if (c !== k.me()) { dd.pairs[c] = (dd.pairs[c] || 0) + 1; pairCheck(q, c); }
      } else if (ev === 'rx') {
        const r = d.r; if (r.site) q.s.lastSite[r.from] = r.site;
        if (isCall(String(r.text).toUpperCase(), k.me())) { dd.pairs[r.from] = (dd.pairs[r.from] || 0) + 1; pairCheck(q, r.from); }
      } else if (ev === 'qsl') {
        const isNew = !q.s.calls[d.call];
        q.s.qsos++; q.s.calls[d.call] = (q.s.calls[d.call] || 0) + 1; dd.qsos++; q.s.bestDay = Math.max(q.s.bestDay, dd.qsos); cnt(q, 'qso');
        gain(q, XP.qso * (d.sprint ? 2 : 1), 'QSO'); if (isNew) gain(q, XP.newcall, 'new station');
        if (d.pts >= 2 && !d.sprint || d.pts >= 4) { q.s.xrep++; cnt(q, 'xrep'); gain(q, XP.xrep, 'two repeaters'); }
        const site = q.s.lastSite[d.call]; if (site) q.s.sites[site] = 1;
        if (d.ch === 'LOCAL') q.s.localQ++;
        if (d.sprint) { q.s.sprintQ++; const id = new Date(d.ts).toISOString().slice(0, 10); q.s.sprintBy[id] = (q.s.sprintBy[id] || 0) + 1; }
        const h = new Date(d.ts).getHours(); if (h < 5) q.s.nightQ++; else if (h < 7) q.s.earlyQ++;
      } else if (ev === 'art') { q.s.art++; cnt(q, 'art'); if (dd.xpArt < 3) { dd.xpArt++; gain(q, XP.art, 'art'); } }
      else if (ev === 'banner') { q.s.banners++; cnt(q, 'banner'); }
      else if (ev === 'qslcard') q.s.qslcards++;
      else if (ev === 'news') { q.s.news++; cnt(q, 'news'); if (dd.xpNews < 5) { dd.xpNews++; gain(q, XP.news, 'news'); } }
      else if (ev === 'pbbspost') q.s.pbbspost++;
      else if (ev === 'log') { q.s.logged++; gain(q, XP.log, 'log'); if (d.name && d.qth) cnt(q, 'logfull'); }
      else if (ev === 'adif') q.s.adif++;
      else if (ev === 'tape') q.s.tape++;
      else if (ev === 'hfcopy') { q.s.hfChars += d.n; cnt(q, 'hf', d.n); if (dd.xpHf < 50) { dd.xpHf += 1; gain(q, XP.hf, 'HF copy'); } }
      else if (ev === 'hfline') q.s.prefixes = Math.max(q.s.prefixes, d.prefixes || 0);
      else if (ev === 'hftx') q.s.hfTx++;
      else return;
      check(q); save(); k.dirty('rtty');
    }
    function pairCheck(q, c) { const v = day(q).pairs[c] || 0; cnt(q, 'pair', 0); const d = day(q); d.cnt.pair = Math.max(d.cnt.pair || 0, v); for (const [id, text, key, need] of missions(q)) if (key === 'pair' && !d.done[id] && v >= need) { d.done[id] = 1; gain(q, XP.mission, 'mission'); celebrate('mission', 'MISSION DONE', text); } if (v >= 10 && !q.s.ragchewDay) { q.s.ragchew++; q.s.ragchewDay = today(); } if (q.s.ragchewDay && q.s.ragchewDay !== today()) q.s.ragchewDay = ''; }
    let boardJ = null;
    function board(j) {
      boardJ = j; const q = p();
      if (j.last && j.last.rows && j.last.rows.slice(0, 3).some(r => r[0] === k.me())) { q.s.podium = 1; check(q); save(); }
    }
    // ---- the award: confirmed QSOs from the logbook (gateway QSLs), stations and the repeaters they were on
    function award(info) {
      const q = p(), conf = (info.log || []).filter(e => e.confirmed), calls = new Set(conf.map(e => e.call)), reps = n(q.s.sites);
      const tiers = [['Bronze', 10, 0], ['Silver', 25, 3], ['Gold', 50, 6], ['Worked All P25X', 9, 9]];
      return { calls: calls.size, reps, tiers: tiers.map(([name, c, r]) => ({ name, c, r, ok: name === 'Worked All P25X' ? REPEATERS.every(x => q.s.sites[x]) : calls.size >= c && reps >= r })) };
    }
    function certificate(tier, a) {
      const w = window.open('', '_blank'); if (!w) { toast('🪪', 'Pop-up blocked', 'Allow pop-ups for Kelly to print the certificate', 'bad'); return; }
      const call = esc(k.me() || 'NOCALL'), date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>P25X RTTY Award ${esc(tier)} -- ${call}</title><style>
        body{margin:0;background:#f3ead2;font-family:'Courier New',monospace;color:#2b2620;display:flex;justify-content:center;padding:30px}
        .c{width:900px;max-width:100%;border:14px double #7a1f12;padding:40px 50px;text-align:center;background:#fbf5e3;box-shadow:0 0 0 4px #e3d4a8 inset}
        h1{font-size:44px;letter-spacing:.2em;margin:0 0 6px;color:#7a1f12} h2{font-size:26px;margin:4px 0 26px;letter-spacing:.3em}
        .call{font-size:64px;font-weight:700;letter-spacing:.12em;margin:18px 0} p{font-size:18px;line-height:1.6} .tape{letter-spacing:.35em;color:#8a7b62;margin:22px 0}
        .s{margin-top:30px;font-size:15px;color:#5a5040} button{margin-top:20px;font:inherit;padding:8px 18px} @media print{button{display:none}body{padding:0}}
      </style></head><body><div class="c"><div class="tape">RYRYRYRYRYRYRYRYRYRYRYRYRY</div><h1>P25X RTTY AWARD</h1><h2>${esc(tier.toUpperCase())}</h2>
      <p>THIS CERTIFIES THAT</p><div class="call">${call}</div>
      <p>HAS MADE RTTY CONTACT WITH <b>${a.calls}</b> STATIONS ON <b>${a.reps}</b> P25X REPEATER${a.reps === 1 ? '' : 'S'},<br>EVERY ONE CONFIRMED BY THE P25X GATEWAY.</p>
      <div class="tape">DE P25X -- QSL -- 73</div><p>${esc(date.toUpperCase())}</p><div class="s">P25X: Digital Voice. Total Data.<br>Kelly Page · RTTY over P25 data</div>
      <button>Print</button></div></body></html>`);
      w.document.close();
      w.document.querySelector('button').addEventListener('click', () => w.print());   // no inline handler: the pop-up inherits Kelly's CSP
    }
    // ---- render
    function render(el, info) {
      if (!el) return;
      const q = p(), d = day(q), ri = rankOf(q.xp), cur = RANKS[ri], nx = RANKS[ri + 1];
      const pct = nx ? Math.round((q.xp - cur[0]) / (nx[0] - cur[0]) * 100) : 100, a = award(info), sp = info.sprint && info.sprint.next;
      const got = TROPHIES.filter(t => q.trophies[t[0]]).length;
      const bj = boardJ || info.board;
      el.innerHTML = `
        <div class="rt-q-top">
          <div class="card rt-rank"><div class="rt-rank-n">LEVEL ${ri + 1}</div><div class="rt-rank-t">${esc(cur[1])}</div>
            <div class="rt-xp"><i style="width:${pct}%"></i></div><div class="dim small">${q.xp} XP${nx ? ` · ${nx[0] - q.xp} to ${esc(nx[1])}` : ' · the top of the trade'}</div>
            <div class="rt-rank-s"><span>🔥 ${streak(q)} day streak</span><span>🏆 ${got}/${TROPHIES.length}</span><span>🤝 ${q.s.qsos} QSOs</span></div></div>
          <div class="card rt-miss"><h3>🎯 Today's missions</h3>${missions(q).map(([id, text, c, need]) => { const v = Math.min(need, d.cnt[c] || 0); return `<div class="rt-m${d.done[id] ? ' done' : ''}"><span>${d.done[id] ? '✅' : '⬜'} ${esc(text)}</span><b>${v}/${need}</b><i style="width:${Math.round(v / need * 100)}%"></i></div>`; }).join('')}
            <div class="dim small">New missions at midnight · +${XP.mission} XP each</div></div>
          <div class="card rt-sprintc"><h3>🏁 P25X RTTY Sprint</h3>${sp ? (sp.live ? `<div class="rt-big">LIVE NOW</div><div>on <b>${esc(info.sprint.ch)}</b> till ${new Date(sp.end * 1000).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })} -- every QSO counts double</div>`
            : `<div class="rt-big">${(() => { const s = sp.start * 1000 - Date.now(), h = Math.floor(s / 3600e3); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor(s / 60e3) % 60}m`; })()}</div><div>${new Date(sp.start * 1000).toLocaleString('en-AU', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false })} on <b>${esc(info.sprint.ch)}</b>, an hour, QSOs double</div>`) : '<div class="dim">No sprint scheduled</div>'}
            ${bj && bj.last ? `<div class="rt-pod">${bj.last.rows.slice(0, 3).map((r, i) => `<span>${['🥇', '🥈', '🥉'][i]} <b>${esc(r[0])}</b> ${r[2]}</span>`).join('')}<small>last sprint ${esc(bj.last.id)}</small></div>` : ''}</div>
        </div>
        <div class="grid two">
          <div class="card"><div class="card-h"><h3>📋 Club board</h3><button class="btn small" data-qa="board">⟳ Refresh</button></div>
            <p class="dim small">Points from QSOs the gateway confirmed: 1 a QSO, 2 across two repeaters, doubled in the sprint.</p>
            <table class="rt-tbl"><thead><tr><th>#</th><th>Call</th><th>Pts</th><th>QSOs</th><th>Worked</th><th>Rptrs</th><th>Month</th><th>🔥</th></tr></thead><tbody>${bj && bj.rows ? bj.rows.map((r, i) => `<tr class="${r[0] === k.me() ? 'me' : ''}"><td>${i + 1}</td><td><b class="rt-call" data-call="${esc(r[0])}">${esc(r[0])}</b></td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td><td>${r[5]}</td><td>${r[6]}</td></tr>`).join('') : '<tr><td colspan="8" class="dim">Refresh to fetch the board from the gateway (one small request).</td></tr>'}</tbody></table></div>
          <div class="card"><h3>🎖️ P25X RTTY Award</h3><p class="dim small">Confirmed QSOs only. You have <b>${a.calls}</b> station${a.calls === 1 ? '' : 's'} on <b>${a.reps}</b> repeater${a.reps === 1 ? '' : 's'}.</p>
            ${a.tiers.map(t => `<div class="rt-aw${t.ok ? ' ok' : ''}"><b>${t.ok ? '🏅' : '🔒'} ${esc(t.name)}</b><span>${t.name === 'Worked All P25X' ? 'stations on all nine repeaters' : `${t.c} stations${t.r ? `, ${t.r} repeaters` : ''}`}</span>${t.ok ? `<button class="btn small" data-cert="${esc(t.name)}">🖨️ Certificate</button>` : ''}</div>`).join('')}
            <h3 style="margin-top:14px">📈 Records</h3><div class="rt-recs">${[['Stations worked', n(q.s.calls)], ['Repeaters worked', n(q.s.sites)], ['Overs sent', q.s.overs], ['Longest over', `${q.s.longest} ch`], ['Best day', `${q.s.bestDay} QSOs`], ['HF copied', `${q.s.hfChars} ch`], ['HF prefixes', q.s.prefixes], ['Sprint QSOs', q.s.sprintQ]].map(([l, v]) => `<div><b>${esc(String(v))}</b><span>${esc(l)}</span></div>`).join('')}</div></div>
        </div>
        <div class="card"><h3>🏆 Trophies <span class="dim small">${got} of ${TROPHIES.length}</span></h3><div class="rt-tro">${TROPHIES.map(([id, icon, name, how]) => `<div class="rt-t${q.trophies[id] ? ' got' : ''}${fresh.has(id) ? ' new' : ''}" title="${esc(how)}"><i>${q.trophies[id] ? icon : '🔒'}</i><b>${esc(name)}</b><small>${esc(how)}</small></div>`).join('')}</div></div>
        <div class="card"><h3>🗓️ Ranks</h3><div class="rt-ranks">${RANKS.map(([x, name], i) => `<span class="${i <= ri ? 'on' : ''}">${i + 1}. ${esc(name)} <small>${x} XP</small></span>`).join('')}</div>
          <p class="dim small">XP: ${XP.over} an over (15 a day -- airtime is shared), ${XP.qso} a confirmed QSO (double in the sprint), +${XP.newcall} a new station, +${XP.xrep} across repeaters, ${XP.mission} a mission, ${XP.trophy} a trophy.</p></div>`;
      el.onclick = e => {
        const b = e.target.closest('[data-qa]'); if (b && b.dataset.qa === 'board') k.askBoard();
        const c = e.target.closest('[data-cert]'); if (c) certificate(c.dataset.cert, a);
      };
    }
    return { event, board, render, profile: p };
  };
})();
