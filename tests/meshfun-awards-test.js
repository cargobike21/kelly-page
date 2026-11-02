// Mesh Quest season 2 (js/meshfun.js on js/award-engine.js + js/hc-core.js): the meshQuest -> meshQuest2 migration,
// Handshakes (ladder, 10 a day), the self set, demo, the daily mission swap, CQ Hunter, Repeater Admin, board v2.
// AWARDS_REVIEW.md sections 2, 4, 6, 8 and review/07-build-contract.md.
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" kelly-page/tests/meshfun-awards-test.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const JS = path.join(__dirname, '..', 'js');
let pass = 0, fail = 0;
const t = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra)); } };

const DAY = 86400000, T0 = Date.UTC(2026, 9, 20, 2, 0, 0);   // 2026-10-20 12:00 AEST
const key = i => (i.toString(16).padStart(4, '0')).repeat(16);   // 64 hex
const MYKEY = 'f'.repeat(64);

// one sandbox per "browser": hc-core + award-engine + meshfun, a fake clock, timers we flush by hand
function world(o) {
  o = o || {};
  const timers = [];
  const sb = { console, timers, __now: T0, setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, setInterval: () => 0,
    navigator: {}, matchMedia: () => ({ matches: true }) };
  vm.createContext(sb); sb.window = sb; sb.self = sb;
  vm.runInContext('(() => { const real = Date.now; Date.now = () => globalThis.__now || real(); })()', sb);
  for (const f of ['hc-core.js', 'award-engine.js', 'meshfun.js']) vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f });
  const mem = o.mem || {}, writes = [];
  const store = { get: (k, d) => (k in mem ? JSON.parse(mem[k]) : d), set: (k, v) => { writes.push(k); mem[k] = JSON.stringify(v); } };
  const nodes = new Map(), dir = o.dir || {}, sent = [], toasts = [];
  const settings = Object.assign({ myCall: 'VK4XXX', sound: false, fx: false }, o.settings || {});
  let fun;
  const k = {
    $: () => null, $$: () => [], esc: s => String(s), settings, store, toast: (...a) => toasts.push(a), addEvent: () => {}, dirty: () => {}, save: () => { k.saved = (k.saved || 0) + 1; },
    ms: { quest: false, dev: o.dev || 'meshcore', sfx: {}, link: 'serial' }, isDemo: () => false, online: () => true, myNum: () => 1, myPos: () => ({ lat: -27.5, lon: 152.9 }),
    caps: () => ({ trace: true, dm: true }), devLabel: () => (o.dev === 'meshtastic' ? 'Meshtastic' : 'MeshCore'), node: num => nodes.get(num >>> 0), nodes: () => nodes.values(), nodeName: num => (nodes.get(num) || {}).longName || String(num),
    hwOf: () => '', distKm: (a, b) => Math.hypot(a.lat - b.lat, a.lon - b.lon) * 111, bearing: () => 0, kfRequest: async req => { sent.push(req); return 'x1'; },
    currentPage: () => 'mesh', fmtAgo: () => '', showPage: () => {}, audioCtx: () => null,
    hamOf: n => sb.KellyHC.hamStatus({ net: 'meshcore', key: n.key && !String(n.key).startsWith('num:') ? n.key : null, keyless: !n.key || String(n.key).startsWith('num:'), name: n.longName || n.name, type: n.type != null ? n.type : n.role,
      dir: dir[n.key] || null, demo: !!n.demo }, { me: { call: settings.gwCall || settings.myCall, keys: fun ? fun.selfKeys() : [] }, demo: !!n.demo || sb.KellyAwards.demo() }),
  };
  fun = sb.KellyMeshFun(k);
  const flush = () => { while (timers.length) { try { timers.shift()(); } catch (e) { console.log('timer threw', e.message); } } };
  const add = (num, name, type, extra) => { const n = Object.assign({ num, key: key(num), longName: name, role: type, type, hops: 0 }, extra || {}); nodes.set(num, n); return n; };
  return { sb, k, fun, mem, writes, store, nodes, dir, sent, toasts, settings, flush, add, P: () => fun.profile(), at: ms => { sb.__now = ms; } };
}
const cnt = o => Object.keys(o || {}).length;

// ---------------------------------------------------------------- 1 migration
{
  const old = { v: 1, xp: 900, badges: { first: 1, s3: 2, radmin: 3, qso: 4, hw5: 5, dx10: 6, social: 7, gold: 8, n10: 9 }, seenBadges: {},
    recs: { dx: { v: 31.2 }, dxa: { v: 55 }, gold: { v: 22 }, rtt: { v: 1.4 }, best: { v: 9.5 }, hops: { v: 4 }, day: { v: 12 }, deep: { v: -16 } },
    log: { 11: { name: 'VK4ABC Bob', qso: 2, first: T0 - 30 * DAY, last: T0 - 2 * DAY, dev: 'MeshCore' }, 12: { name: 'VK4DEF', qso: 1, dev: 'Meshtastic' },
      13: { name: 'VK4RAB Rpt', qso: 1, dev: 'MeshCore' }, 14: { name: 'VK4QQ', qso: 0, dev: 'MeshCore' }, 15: { name: 'VK4XXX home', qso: 3, dev: 'MeshCore' } },
    grids: { QG62: 1 }, hw: { a: 1 }, devs: { MeshCore: 1 }, streak: { n: 2, best: 5, last: '' }, stats: { sent: 3, rx: 9, cq: 1, qsos: 7, acks: 2, traces: 1, bridged: 1, tokens: 1 } };
  const oldJson = JSON.stringify(old);
  const w = world({ mem: { meshQuest: oldJson } });
  const p = w.P();
  t('mig: nothing written at load', !w.writes.length, w.writes);
  t('mig: unchanged badges carry over', p.badges.first && p.badges.s3 && p.badges.radmin && cnt(p.badges) === 3, p.badges);
  t('mig: the rest are classic', ['qso', 'hw5', 'dx10', 'social', 'gold', 'n10'].every(id => p.classic[id]), p.classic);
  t('mig: classicXp = old xp', p.classicXp === 900);
  t('mig: new xp = carried badges\' XP', p.xp === 10 + 30 + 40, p.xp);
  t('mig: records carry, gold/rtt/dx/dxa/best classic', p.recs.hops && p.recs.day && p.recs.deep && !p.recs.dx && !p.recs.gold && !p.recs.rtt && !p.recs.best
    && ['dx', 'dxa', 'gold', 'rtt', 'best'].every(r => p.classicRecs[r]), { recs: Object.keys(p.recs), classic: Object.keys(p.classicRecs) });
  t('mig: Hardware Zoo retired (no live badge)', !w.sb.KellyMeshFun.BADGES.some(b => b.id === 'hw5'));
  t('mig: backfill MeshCore ham QSOs only', p.mutual.VK4ABC && p.mutual.VK4ABC.bf && !p.mutual.VK4DEF && !p.mutual.VK4RAB && !p.mutual.VK4QQ && !p.mutual.VK4XXX, Object.keys(p.mutual));
  t('mig: grids reset (hams only now)', cnt(p.grids) === 0);
  w.fun.online(); w.flush();
  t('mig: meshQuest2 written with the first real event', w.writes.includes('meshQuest2') && !w.writes.includes('meshQuest'), w.writes);
  t('mig: holder is classic, tokens stat not carried', !p.stats.tokens);
  // events never write meshQuest
  w.add(20, 'VK4XYZ', 1); w.dir[key(20)] = { c: 'VK4XYZ', t: 1 };
  w.fun.heard(w.nodes.get(20)); w.flush();
  t('mig: meshQuest never written again', w.mem.meshQuest === oldJson && !w.writes.includes('meshQuest'));
  // a second load reads meshQuest2, doesn't migrate again
  const w2 = world({ mem: { meshQuest: oldJson, meshQuest2: w.mem.meshQuest2 } });
  t('mig: second load keeps meshQuest2', w2.P().classicXp === 900 && w2.P().log[20], Object.keys(w2.P().log));
  // no old profile at all
  const w3 = world({});
  t('mig: fresh profile', w3.P().xp === 0 && w3.P().classicXp === 0 && cnt(w3.P().classic) === 0);
  // backfill counts for the ladder: 5 backfilled -> Social Butterfly, but no window awards
  const log5 = {}; ['VK4AAA', 'VK4BBB', 'VK4CCC', 'VK4DDD', 'VK4EEE'].forEach((c, i) => { log5[30 + i] = { name: c, qso: 1, dev: 'MeshCore', first: T0 - DAY }; });
  const w4 = world({ mem: { meshQuest: JSON.stringify({ xp: 10, badges: {}, log: log5 }) } });
  w4.fun.online();
  t('mig: backfill earns the ladder (social) on the first check', w4.P().badges.social && w4.P().badges.shake, Object.keys(w4.P().badges));
  t('mig: backfill earns no window award', !w4.P().badges.card && !w4.P().badges.welcome);
}

// ---------------------------------------------------------------- 2 Handshakes: ladder, cap, self, type
{
  const w = world({});
  const mk = (i, call, verified) => { const n = w.add(100 + i, `${call} op`, 1); if (verified) w.dir[n.key] = { c: call, t: 1 }; return n; };
  const calls = Array.from({ length: 12 }, (_, i) => `VK4H${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`);
  const ns = calls.map((c, i) => mk(i, c, true));
  let xp0 = w.P().xp;
  w.fun.mutual({ key: ns[0].key, num: ns[0].num, type: 1, how: 'ack' });
  t('shake: first Handshake stored by callsign', w.P().mutual[calls[0]] && w.P().mutual[calls[0]].key === ns[0].key && w.P().mutual[calls[0]].tier === 'verified', w.P().mutual);
  t('shake: badge + 20 XP', w.P().badges.shake && w.P().xp - xp0 === 20 + 30, w.P().xp - xp0);
  xp0 = w.P().xp;
  w.fun.mutual({ key: ns[0].key, num: ns[0].num, type: 1, how: 'message' });
  t('shake: the same ham again: no XP, n++', w.P().xp === xp0 && w.P().mutual[calls[0]].n === 2);
  for (let i = 1; i < 5; i++) w.fun.mutual({ key: ns[i].key, num: ns[i].num, type: 1, how: 'path-return' });
  t('shake: Social Butterfly at 5 hams', w.P().badges.social && cnt(w.P().mutual) === 5);
  for (let i = 5; i < 10; i++) w.fun.mutual({ key: ns[i].key, num: ns[i].num, type: 1, how: 'ack' });
  t('shake: Club Net at 10', w.P().badges.mutual10);
  t('shake: 10 scored today', w.P().aw.today.n.shake === 10, w.P().aw.today.n);
  xp0 = w.P().xp;
  w.fun.mutual({ key: ns[10].key, num: ns[10].num, type: 1, how: 'ack' });
  t('cap: the 11th Handshake today stores but earns no XP', cnt(w.P().mutual) === 11 && w.P().xp === xp0, w.P().xp - xp0);
  w.at(T0 + DAY);
  xp0 = w.P().xp;
  w.fun.mutual({ key: ns[11].key, num: ns[11].num, type: 1, how: 'discover' });
  t('cap: tomorrow it scores again', w.P().xp - xp0 >= 20 && w.P().mutual[calls[11]].disc, w.P().xp - xp0);
  t('shake: Open Door from a discovery', w.P().badges.found);
  // a repeater / room never makes a Handshake
  const rpt = w.add(300, 'VK4ZZZ rpt', 2); w.dir[rpt.key] = { c: 'VK4ZZZ', t: 2 };
  w.fun.mutual({ key: rpt.key, num: rpt.num, type: 2, how: 'ack' });
  t('type: a repeater is no Handshake', !w.P().mutual.VK4ZZZ);
  // no proof how -> nothing
  w.fun.mutual({ key: ns[11].key, num: ns[11].num, type: 1, how: 'trace' });
  t('how: a trace proves nothing', w.P().mutual[calls[11]].n === 1);
  // self: my second node (connected once) and my own call never score
  const mine = w.add(400, 'Kim mobile', 1); w.dir[mine.key] = { c: 'VK4XQ', t: 1 };
  w.fun.connected(mine.key);
  w.fun.mutual({ key: mine.key, num: mine.num, type: 1, how: 'ack' });
  t('self: a connected node never scores', !w.P().mutual.VK4XQ && w.fun.isSelf(mine.key));
  const named = w.add(401, 'VK4XXX portable', 1);
  w.fun.mutual({ key: named.key, num: named.num, type: 1, how: 'ack' });
  t('self: a node carrying my own call never scores', !w.P().mutual.VK4XXX);
  const xh = w.P().aw.ever.heard ? cnt(w.P().aw.ever.heard) : 0;
  w.fun.heard(mine); w.fun.heard(named);
  t('self: my own nodes are never "hams heard"', (w.P().aw.ever.heard ? cnt(w.P().aw.ever.heard) : 0) === xh);
  w.fun.notMine(mine.key); w.at(T0 + DAY + 1000);
  t('self: "not mine" takes it out of the self set', !w.fun.isSelf(mine.key));
  // a name-only (probable) ham counts, but only 3 new ones a day
  const w2 = world({});
  const pr = ['VK4PAA', 'VK4PBB', 'VK4PCC', 'VK4PDD'].map((c, i) => w2.add(500 + i, c, 1));
  pr.forEach(n => w2.fun.mutual({ key: n.key, num: n.num, type: 1, how: 'ack' }));
  t('probable: 3 new name-only hams a day', cnt(w2.P().mutual) === 3, Object.keys(w2.P().mutual));
}

// ---------------------------------------------------------------- 3 window awards: card, advert, directory, welcome, intro
{
  const w = world({});
  const n1 = w.add(600, 'VK4WAA', 1); w.dir[n1.key] = { c: 'VK4WAA', t: 1 };
  w.fun.outreach('card', { how: 'qr' });
  w.fun.outreach('dirAdd', { key: n1.key });
  w.fun.outreach('dir', { mineListed: true, firstOf: { VK4WAA: Math.floor((T0 - 3 * DAY) / 1000) } });
  w.at(T0 + 3600000);
  w.fun.mutual({ key: n1.key, num: n1.num, type: 1, how: 'ack' });
  const e = w.P().mutual.VK4WAA;
  t('window: card, dir add and welcome attributed', e.card && e.dirw && e.wel && e.via === 'dir', e);
  t('window: Calling Card, Welcome Wagon, In the Book', w.P().badges.card && w.P().badges.welcome && w.P().badges.listed, Object.keys(w.P().badges));
  // a ham already in the log before the card was handed out isn't attributed to it
  const w2 = world({});
  const n2 = w2.add(601, 'VK4WBB', 1); w2.fun.heard(n2);
  w2.at(T0 + 1000); w2.fun.outreach('card', { how: 'copy' });
  w2.at(T0 + 2000); w2.fun.mutual({ key: n2.key, num: n2.num, type: 1, how: 'ack' });
  t('window: known before the card -> no card credit', !w2.P().mutual.VK4WBB.card);
  // advert window 24 h
  w2.fun.outreach('advert', { mode: 'flood' });
  const n3 = w2.add(602, 'VK4WCC', 1);
  w2.at(T0 + 2000 + 25 * 3600000); w2.fun.mutual({ key: n3.key, num: n3.num, type: 1, how: 'ack' });
  t('window: advert older than 24 h -> no advok', !w2.P().mutual.VK4WCC.adv);
  // share: only a ham we already shook hands with; a new ham B in direct range within 7 days
  w2.fun.outreach('share', { key: n2.key });
  t('intro: share of a Handshake ham recorded', !!w2.P().out.share[n2.key]);
  w2.fun.outreach('share', { key: key(999) });
  t('intro: share of a stranger ignored', !w2.P().out.share[key(999)]);
  const n4 = w2.add(603, 'VK4WDD', 1, { hops: 0 });
  w2.fun.mutual({ key: n4.key, num: n4.num, type: 1, how: 'message' });
  t('intro: B direct within 7 d -> intro', w2.P().mutual.VK4WDD.intro);
  const n5 = w2.add(604, 'VK4WEE', 1, { hops: 2 });
  w2.at(T0 + 2 * DAY + 5000); w2.fun.mutual({ key: n5.key, num: n5.num, type: 1, how: 'message' });
  t('intro: B not in direct range -> no intro', !w2.P().mutual.VK4WEE.intro);
  // still there: a Handshake 30+ days after the first
  w2.at(T0 + 40 * DAY); w2.fun.mutual({ key: n2.key, num: n2.num, type: 1, how: 'ack' });
  t('still: 30 d later marks still', w2.P().mutual.VK4WBB.still);
  // rpt3 hashes: 2-byte only
  const w3 = world({});
  [['aa11', 2], ['bb22', 2], ['c3', 1], ['dd44', 2]].forEach(([h, sz], i) => { const n = w3.add(700 + i, `VK4R${'ABCD'[i]}X op`.replace('VK4R', 'VK4T'), 1, { hops: 2, outPath: { sz, h: ['0000'.slice(0, sz * 2), h] } }); w3.dir[n.key] = { c: `VK4T${'ABCD'[i]}X`, t: 1 }; w3.fun.mutual({ key: n.key, num: n.num, type: 1, how: 'ack' }); });
  t('rpt3: 1-byte hash not used', !w3.P().mutual.VK4TCX.rpt && w3.P().badges.rpt3, Object.values(w3.P().mutual).map(e => e.rpt));
}

// ---------------------------------------------------------------- 4 hams-only scoring, km cap, QSO, trace, ack
{
  const w = world({});
  const rpt = w.add(800, 'Mt Coot-tha rpt', 2, { lat: -27.0, lon: 152.9, hops: 0 });
  w.fun.heard(rpt);
  t('hams only: a repeater heard is no ham, no grid, no dx', cnt((w.P().aw.ever || {}).heard) === 0 && cnt(w.P().grids) === 0 && !w.P().recs.dx && w.P().log[800]);
  const far = w.add(801, 'VK4FAR', 1, { lat: -26.4, lon: 152.9, hops: 0 }); w.dir[far.key] = { c: 'VK4FAR', t: 1 };
  w.fun.heard(far);
  t('km cap: a direct ham claims at most 40 km', w.P().recs.dx && Math.abs(w.P().recs.dx.v - 40) < 0.01, w.P().recs.dx);
  t('hams only: grid + ham heard', cnt(w.P().grids) === 1 && cnt(w.P().aw.ever.heard) === 1);
  // QSO: DM both ways with a ham; channel mention from a keyless sender is not a QSO
  const q = w.add(802, 'VK4QSO', 1); w.dir[q.key] = { c: 'VK4QSO', t: 1 };
  w.fun.sent({ to: 802, text: 'hi' }, true); w.fun.text({ from: 802, text: 'hi back' }, true);
  t('qso: DM QSO with a ham counts', cnt(w.P().aw.ever.qso) === 1 && w.P().badges.qso);
  w.nodes.set(803, { num: 803, longName: 'VK4CHN' });   // keyless channel sender
  w.fun.sent({ to: 0, text: 'CQ CQ' }, false); w.fun.text({ from: 803, text: 'VK4XXX de VK4CHN' }, false);
  t('qso: channel mention from a keyless sender: no QSO', cnt(w.P().aw.ever.qso) === 1);
  // rx XP: first 20 a day
  const x0 = w.P().xp; for (let i = 0; i < 25; i++) w.fun.text({ from: 900 + i, text: 'x' }, false);
  t('rx: +2 XP for the first 20 a day only', w.P().xp - x0 <= 40 + 40 + 60, w.P().xp - x0);   // (missions may add)
  t('rx: cap counter', w.P().aw.today.n.rx === 20 || w.P().aw.today.n.rx >= 20, w.P().aw.today.n);
  // trace: XP once per target per day; never your own node
  const x1 = w.P().xp; w.fun.trace({ to: 800, towards: [1, 2, 800] }); const x2 = w.P().xp; w.fun.trace({ to: 800, towards: [1, 2, 800] });
  t('trace: second trace to the same target today: no XP', x2 > x1 && w.P().xp === x2 && w.P().stats.traces === 2, [x1, x2, w.P().xp]);
  const own = w.add(804, 'my rpt', 2); w.fun.connected(own.key); w.fun.trace({ to: 804, towards: [1, 804] });
  t('trace: your own node never counts', w.P().stats.traces === 2);
  // ack: XP for the first per ham per day
  const a0 = w.P().xp; w.fun.ack({ to: 802, state: 'delivered' }); const a1 = w.P().xp; w.fun.ack({ to: 802, state: 'delivered' });
  t('ack: first per ham per day', a1 - a0 >= 5 && w.P().xp === a1 && w.P().stats.acks === 2, [a0, a1, w.P().xp]);
  // bridge: no XP
  const b0 = w.P().xp; w.fun.bridge(); t('bridge: trophy, no per-message XP', w.P().xp - b0 === 40 && w.P().badges.bridge); const b1 = w.P().xp; w.fun.bridge(); t('bridge: second bridge no XP', w.P().xp === b1);
  // golden: hams only, once per station per day, goldshake
  const g = w.add(805, 'VK4GLD', 1); w.dir[g.key] = { c: 'VK4GLD', t: 1 };
  w.fun.golden({ key: g.key, num: 805, km: 25, how: 'ack', name: 'VK4GLD' });
  t('golden: Golden Handshake + gold + Handshake', w.P().badges.goldshake && w.P().badges.gold && w.P().badges.gold25 && w.P().mutual.VK4GLD);
  const g0 = w.P().xp; w.fun.golden({ key: g.key, num: 805, km: 25.01, how: 'ack', name: 'VK4GLD' });
  t('golden: same station same day: no XP', w.P().xp === g0, w.P().xp - g0);
  const gr = w.P().recs.gold.v; w.fun.golden({ key: rpt.key, num: 800, km: 90, how: 'trace', name: 'rpt' });
  t('golden: a repeater never scores gold', w.P().recs.gold.v === gr);
  w.fun.twoWay({ key: rpt.key, num: 800, rtt: 900, how: 'trace' });
  t('rtt: hams only', !w.P().recs.rtt);
  w.fun.twoWay({ key: g.key, num: 805, rtt: 1200, how: 'ack' });
  t('rtt: a ham sets it', w.P().recs.rtt && w.P().recs.rtt.v === 1.2);
}

// ---------------------------------------------------------------- 5 CQ Hunter (B2)
{
  const w = world({});
  w.fun.answered(0); w.fun.answered(1234);
  t('cq: the old answered(num) gives nothing', !(w.P().stats.answered > 0));
  w.fun.answered({ call: 'VK4CQA', verified: true });
  t('cq: verified caller credited at once', w.P().stats.answered === 1 && w.P().badges.hunt);
  w.fun.answered({ call: 'VK4CQA', verified: true });
  t('cq: once per caller per day', w.P().stats.answered === 1);
  w.fun.answered({ call: 'VK4CQB', verified: false });
  t('cq: unverified waits', w.P().stats.answered === 1 && w.P().cqPend.VK4CQB);
  const n = w.add(900, 'VK4CQB', 1); w.dir[n.key] = { c: 'VK4CQB', t: 1 };
  w.at(T0 + 3600000); w.fun.mutual({ key: n.key, num: 900, type: 1, how: 'message' });
  t('cq: credited when the caller makes two-way contact within 24 h', w.P().stats.answered === 2 && !w.P().cqPend.VK4CQB);
  w.fun.answered({ call: 'VK4CQC' }); w.at(T0 + 2 * DAY); const n2 = w.add(901, 'VK4CQC', 1); w.dir[n2.key] = { c: 'VK4CQC', t: 1 };
  w.fun.mutual({ key: n2.key, num: 901, type: 1, how: 'message' });
  t('cq: too late (> 24 h): no credit', w.P().stats.answered === 2);
  w.fun.answered({ call: 'VK4XXX', verified: true });
  t('cq: my own call never', w.P().stats.answered === 2);
}

// ---------------------------------------------------------------- 6 Repeater Admin / Hero
{
  const w = world({});
  const r = w.add(950, 'VK4RXX rpt', 2); w.dir[r.key] = { c: 'VK4XXX', t: 2 };   // listed under MY callsign
  const other = w.add(951, 'Someone rpt', 2); w.dir[other.key] = { c: 'VK4OTH', t: 2 };
  w.fun.repeater({ key: other.key, name: 'Someone rpt', admin: true, sent: 5000, uptimeS: 10 });
  t('rpt: someone else\'s repeater does not count', !w.P().stats.rptStatus && !w.P().badges.radmin);
  t('rpt: an admin login puts it in the self set', w.fun.isSelf(other.key));
  w.fun.repeater({ key: r.key, name: 'VK4RXX rpt', admin: true, defaultPw: true, sent: 5000, uptimeS: 10 });
  t('rpt: default password does not count', !w.P().stats.rptStatus);
  w.fun.repeater({ key: r.key, name: 'VK4RXX rpt', admin: true, defaultPw: false, sent: 1500, uptimeS: 10 });
  t('rpt: own repeater counts (Admin + Hero)', w.P().badges.radmin && w.P().badges.rhero);
  w.fun.repeater({ key: r.key, name: 'VK4RXX rpt', admin: false, sent: 1600, uptimeS: 20 });
  t('rpt: a guest login adds nothing', w.P().rpts[r.key].total === 1500);
}

// ---------------------------------------------------------------- 7 daily missions: mutual <-> hamheard swap, no #Public CQ
{
  const defs = vm.runInNewContext('0');   // keep lint quiet
  const MISS = world({}).sb.KellyMeshFun.MISSIONS;
  t('missions: no cq / dmack mission any more', !MISS.some(m => m.id === 'cq' || m.id === 'dmack'), MISS.map(m => m.id));
  let found = false;
  for (let d = 0; d < 60 && !found; d++) {
    const at = T0 + d * DAY;
    const a = world({}); a.at(at); a.fun.online();
    const b = world({}); b.at(at);
    ['VK4MAA', 'VK4MBB', 'VK4MCC'].forEach((c, i) => { const n = b.add(1000 + i, c, 1); b.dir[n.key] = { c, t: 1 }; b.fun.mutual({ key: n.key, num: n.num, type: 1, how: 'ack' }); });
    b.P().mis.day = ''; b.fun.online();
    const la = a.P().mis.list.map(m => m.id), lb = b.P().mis.list.map(m => m.id);
    if (lb.includes('mutual')) {
      found = true;
      t('missions: no-Handshake profile gets hamheard in the mutual slot', la.includes('hamheard') && !la.includes('mutual'), la);
      t('missions: same deck otherwise (deterministic)', JSON.stringify(la.map(x => x === 'hamheard' ? 'mutual' : x)) === JSON.stringify(lb), [la, lb]);
      const c = world({ dev: 'meshtastic' }); c.at(at);
      ['VK4MAA', 'VK4MBB', 'VK4MCC'].forEach((cs, i) => { c.P().mutual[cs] = { key: key(1000 + i), first: at, last: at, n: 1, tier: 'verified' }; });
      c.fun.online();
      t('missions: not MeshCore -> hamheard even with 3 Handshakes', c.P().mis.list.some(m => m.id === 'hamheard'), c.P().mis.list);
    }
  }
  t('missions: a day with the mutual slot was found in 60 days', found);
  void defs;
}

// ---------------------------------------------------------------- 8 demo: throwaway profile, nothing saved, no board send
{
  const base = world({}); base.fun.online(); base.flush();
  const before = base.mem.meshQuest2;
  const w = world({ mem: { meshQuest2: before } });
  w.sb.KellyAwards.addDemo(() => true);
  const n = w.add(1100, 'VK4DMO', 1);
  w.fun.mutual({ key: n.key, num: n.num, type: 1, how: 'ack', demo: true });
  w.fun.heard(n); w.fun.online(); w.flush();
  t('demo: plays on the throwaway profile', w.P().mutual.VK4DMO && w.fun.isDemo());
  t('demo: nothing saved', w.mem.meshQuest2 === before && !w.writes.length, w.writes);
  w.fun.askBoard();
  t('demo: board send refused', w.sent.length === 0 && w.toasts.some(a => /Demo/.test(a[1])));
  const r = world({}); const rn = r.add(1101, 'VK4DMP', 1);
  r.fun.mutual({ key: rn.key, num: rn.num, type: 1, how: 'ack', demo: true });
  t('demo: a demo Handshake never reaches a real profile', !r.P().mutual.VK4DMP);
}

// ---------------------------------------------------------------- 8b 'listed' carries firstOf; demo 'yours' never scores
{
  const w = world({});
  w.fun.outreach('listed', { key: MYKEY, firstOf: { VK4NEW: Math.floor((T0 - DAY) / 1000) } });
  const n = w.add(1150, 'VK4NEW', 1); w.dir[n.key] = { c: 'VK4NEW', t: 1 };
  w.fun.mutual({ key: n.key, num: n.num, type: 1, how: 'ack' });
  t('listed: In the Book + firstOf feeds Welcome Wagon', w.P().badges.listed && w.P().mutual.VK4NEW.wel && w.P().badges.welcome);
  const d = world({}); d.sb.KellyAwards.addDemo(() => true); const y = d.add(1151, 'VK4YRS', 1);
  d.fun.mutual({ key: y.key, num: y.num, type: 1, how: 'ack', demo: true, yours: true });
  t('demo: the station marked yours never scores', !d.P().mutual.VK4YRS);
}

// ---------------------------------------------------------------- 8c render smoke test: every tab draws without throwing
{
  const el = () => ({ innerHTML: '', textContent: '', hidden: false, style: {}, classList: { toggle() {}, add() {}, remove() {} }, dataset: {} });
  const els = {};
  const w = world({});
  w.k.$ = sel => els[sel] || (els[sel] = el());
  w.k.ms.quest = true;
  const n = w.add(1160, 'VK4RND', 1); w.dir[n.key] = { c: 'VK4RND', t: 1 };
  w.k.ms.quest = false; w.fun.heard(n); w.fun.mutual({ key: n.key, num: n.num, type: 1, how: 'ack' }); w.k.ms.quest = true;
  w.P().classic = { hw5: 1, qso: 2 }; w.P().classicXp = 500; w.P().classicRecs = { best: { v: 9 } };
  w.k.ms.quest = false; w.fun.boardReply({ v: 2, season: 2, you: 'VK4XXX', rank: 1, of: 1, rows: [{ call: 'VK4XXX', xp: 1, lv: 0, cxp: 2, dx: 10, dxa: 0, hops: 0, hams: 1, shakes: 1, grids: 0, b: 1, st: 1, day: 1, gold: 0, tok: 0, at: 1 }], club: { hams: ['VK4XXX', 1] } }); w.k.ms.quest = true;
  w.fun.heard(n); w.flush();
  let ok = true, html = {};
  for (const tb of ['missions', 'records', 'trophies', 'board', 'log']) {
    try { w.store.set('meshQuestTab', tb); const f2 = w.sb.KellyMeshFun(Object.assign({}, w.k)); f2.render(); html[tb] = els['#mq-body'].innerHTML; } catch (e) { ok = false; console.log('render', tb, e.stack); }
  }
  t('render: all tabs draw', ok);
  t('render: trophies show needs contacts + classic', /Needs contacts/.test(html.trophies) && /mq-classic/.test(html.trophies) && /Hardware Zoo/.test(html.trophies) && /infrastructure/.test(html.trophies));
  t('render: board v2 labels', /on trust/.test(html.board) && /claimed/.test(html.board) && /Season 2/.test(html.board));
  t('render: classic XP + classic records', /Classic XP/.test(html.records) && /Classic records/.test(html.records));
}

// ---------------------------------------------------------------- 9 board v2
{
  const w = world({});
  const n = w.add(1200, 'VK4BRD', 1); w.dir[n.key] = { c: 'VK4BRD', t: 1 };
  w.fun.heard(n); w.fun.mutual({ key: n.key, num: n.num, type: 1, how: 'ack' });
  const s = w.fun.scores();
  const want = ['op', 'v', 'call', 'xp', 'lv', 'cxp', 'dx', 'dxa', 'hops', 'hams', 'shakes', 'grids', 'b', 'st', 'day', 'gold', 'tok'];
  t('board: v2 request has exactly the contract\'s fields', JSON.stringify(Object.keys(s).sort()) === JSON.stringify(want.slice().sort()), Object.keys(s));
  t('board: v2 values', s.op === 'meshboard' && s.v === 2 && s.call === 'VK4XXX' && s.hams === 1 && s.shakes === 1 && s.cxp === 0, s);
  w.fun.askBoard();
  t('board: sent over KF', w.sent.length === 1 && w.sent[0].v === 2);
  w.fun.boardReply({ v: 2, season: 2, you: 'VK4XXX', rank: 1, of: 3, rows: [{ call: 'VK4XXX', xp: 100, lv: 0, cxp: 900, dx: 0, hams: 1, shakes: 1, grids: 0, b: 2 }] });
  t('board: reply stores you as gwCall and saves', w.settings.gwCall === 'VK4XXX' && w.k.saved >= 1 && w.P().board.season === 2);
  w.fun.boardReply({ error: 'update Kelly to post to season 2', you: 'VK4XXXB' });
  t('board: an error reply still takes the gateway call', w.settings.gwCall === 'VK4XXXB');
}

// ---------------------------------------------------------------- 3b QR: a scanned card (how 'scan'), and S21 (no key prefixes in the synced profile)
{
  const w = world({});
  const n = w.add(700, 'VK4WSC', 1), other = key(701);
  w.k.contactKeys = () => [n.key, other];   // we just added them from their card, so they are in the contacts already
  w.fun.outreach('card', { how: 'scan', key: n.key, at: T0 });
  t('scan: the card window opens (a timestamp)', w.P().out.card.includes(T0), w.P().out.card);
  t('scan: scores nothing by itself', !w.P().xp && !cnt(w.P().mutual), w.P().xp);
  w.at(T0 + 3600000); w.fun.mutual({ key: n.key, num: n.num, type: 1, how: 'ack' });
  t('scan: their Handshake within the window -> Calling Card', w.P().mutual.VK4WSC && w.P().mutual.VK4WSC.card && w.P().badges.card, w.P().mutual.VK4WSC);
  w.flush();
  const synced = w.mem.meshQuest2 || '', local = JSON.parse(w.mem.meshQuestKnown || '{}');
  t('S21: the synced profile holds no contact-key prefixes', !!synced && !/Known/.test(synced) && !synced.includes(other.slice(0, 16)), synced.slice(0, 200));
  t('S21: the snapshot is kept locally (meshQuestKnown), the scanned key left out', local.card && local.card.k.includes(other.slice(0, 16)) && !local.card.k.includes(n.key.slice(0, 16)), local);
  // a copied card: a station already in the contacts when it went out gets no Calling Card
  const w2 = world({});
  const m = w2.add(710, 'VK4WSD', 1);
  w2.k.contactKeys = () => [m.key];
  w2.fun.outreach('card', { how: 'copy', at: T0 });
  w2.at(T0 + 3600000); w2.fun.mutual({ key: m.key, num: m.num, type: 1, how: 'ack' });
  t('copy: a contact we already had -> no card credit', w2.P().mutual.VK4WSD && !w2.P().mutual.VK4WSD.card, w2.P().mutual.VK4WSD);
  // an older profile that still carries the snapshots: moved out of meshQuest2 at load
  const w3 = world({ mem: { meshQuest2: JSON.stringify({ out: { card: [T0], local: [T0], flood: [], dirAdds: {}, share: {}, cardKnown: { t: T0, k: ['abcdabcdabcdabcd'] }, advKnown: { t: T0, k: ['1234123412341234'] } } }) } });
  t('S21 migration: gone from the profile', !('cardKnown' in w3.P().out) && !('advKnown' in w3.P().out), Object.keys(w3.P().out));
  const l3 = JSON.parse(w3.mem.meshQuestKnown || '{}');
  t('S21 migration: kept locally', l3.card && l3.card.k[0] === 'abcdabcdabcdabcd' && l3.adv && l3.adv.k[0] === '1234123412341234', l3);
  t('statesync never carries meshQuestKnown', !require('fs').readFileSync(require('path').join(JS, 'statesync.js'), 'utf8').includes('meshQuestKnown'));
}

console.log(`meshfun-awards-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
