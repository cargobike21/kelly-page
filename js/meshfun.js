/* Kelly Page -- Mesh Quest (2026-10-17; season 2 = the awards review, 2026-10-24, kelly-page/AWARDS_REVIEW.md): the LoRa
 * Mesh page's game layer. Records, trophies, XP and levels named after the Australian licence grades, three daily
 * missions, a mesh logbook (CSV), and a club leaderboard over P25 packet data (KF {op: 'meshboard', v: 2} -> the P25X
 * gateway, server.js kfMeshBoard).
 *
 * Season 2 rules (AWARDS_REVIEW.md sections 2-4, 6, 8; review/07-build-contract.md):
 *   - every score goes through ONE award engine (js/award-engine.js KellyAwards.create): only licensed hams count
 *     (HC.hamStatus via k.hamOf / KellyHamCalls.hamOf -- without Ham Contacts nothing scores), counted by OWNER
 *     (callsign), one scoring event per ham per UTC day, daily caps, and the self set (every node this Kelly has
 *     connected) never scores -- except Repeater Admin / Hero and Multi-mesh;
 *   - a Handshake = two-way contact with a ham's companion (a DM from them we decrypted, our DM ✓✓, a path return, a
 *     path discovery answered): mutual() -> p.mutual[CALL], +20 XP each new one, 10 scoring a day; the contact trophies
 *     sit under "needs contacts";
 *   - the profile lives in store 'meshQuest2'; the old 'meshQuest' is read once (migration: unchanged badges carry
 *     over, the rest are "classic", old XP = classicXp) and never written again;
 *   - demo (k.isDemo() / KellyAwards.demo()) plays on a throwaway profile: nothing saved, no board send.
 *   - the "who did we already know" snapshots behind the card / advert windows (contact-key prefixes) stay LOCAL in
 *     store 'meshQuestKnown' -- never in 'meshQuest2', which statesync.js copies to the Kelly bridge (QR_REVIEW.md S21).
 *     outreach('card', { how: 'scan', key }) = we read THEIR card (QR / picture) and added it: the same Calling Card
 *     window as handing ours out, their key left out of the snapshot; a scan scores nothing by itself.
 *
 * js/mesh.js feeds it events -- heard(node), text(msg, dm), sent(msg, dm), ack(msg), trace(tr), bridge(), online(),
 * pos(), gw(), mutual(x), outreach(kind, info), answered({call, verified, at}), golden(g) / twoWay(g) (js/meshpaths.js),
 * token(t) / gave() (js/meshgold.js), repeater(x) (js/meshrepeaters.js), drive(x) (js/meshdrive.js) -- each wrapped in
 * try/catch there, so nothing in here can break the mesh. Only live traffic counts.
 * Sending earns XP for the first SEND_XP_DAY messages a day only: the mesh is shared airtime.
 *
 * window.KellyMeshFun(k) -> { heard, text, sent, ack, trace, bridge, answered, online, pos, gw, golden, twoWay, token,
 *   gave, repeater, drive, mutual, outreach, connected, notMine, isSelf, selfKeys, hamOf, creditKm, engine, boardReply,
 *   kfEvent, ownsXid, render, init, grid, cardinal, play, profile, scores };
 * window.KellyMeshFun.grid(lat, lon, len) = Maidenhead locator.
 */
(function () {
  'use strict';
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWX';
  function grid(lat, lon, len = 6) {
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return '';
    let x = Math.min(359.9999, lon + 180), y = Math.min(179.9999, lat + 90);
    let s = A[Math.floor(x / 20)] + A[Math.floor(y / 10)];
    x %= 20; y %= 10; s += `${Math.floor(x / 2)}${Math.floor(y)}`;
    if (len >= 6) { x %= 2; y %= 1; s += (A[Math.floor(x * 12)] + A[Math.floor(y * 24)]).toLowerCase(); }
    return s;
  }
  const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const cardinal = rad => CARD[Math.round(((rad * 180 / Math.PI + 360) % 360) / 22.5) % 16];

  // Levels: the Australian licence grades, then the mesh's own
  const LEVELS = [[0, 'Listener', '🎧'], [100, 'Foundation', '🟢'], [300, 'Standard', '🔵'], [700, 'Advanced', '🟣'], [1500, 'DX Hunter', '🎯'],
    [3000, 'Mesh Elmer', '🧙'], [6000, 'Mesh Legend', '👑'], [12000, 'Hall of Fame', '🏆']];
  const lvOf = xp => { let i = 0; while (i + 1 < LEVELS.length && xp >= LEVELS[i + 1][0]) i++; return i; };
  const SEND_XP_DAY = 10;
  const QSO_WINDOW = 10 * 60000;
  const DAY = 86400000;
  const MUTUAL_MAX = 500, OUT_MAX = 200, OUT_DAYS = 30, DIRFIRST_MAX = 500, ADMIN_MAX = 50, CQPEND_MAX = 50;
  const SHAKE_XP = 20, CARD_WIN = 14 * DAY, ADV_WIN = DAY, INTRO_WIN = 7 * DAY, WELCOME_WIN = 14 * DAY, STILL_AFTER = 30 * DAY, CQ_WIN = DAY;
  const PROOFS = { message: 'a direct message from them', ack: 'your direct message delivered (✓✓)', reverse: 'a reply over the path back',
    'path-return': 'a path return from them', discover: 'a path discovery answered' };

  // Trophies: prog(p) -> [now, goal]. ct = needs contacts (the "needs contacts" heading), inf = infrastructure
  const cnt = o => Object.keys(o || {}).length;
  const rec = (p, key) => (p.recs[key] || {}).v || 0;
  const ever = (p, kind) => (p.aw && p.aw.ever && p.aw.ever[kind]) || {};     // the engine's owners(kind) for profile p
  const rptSent = p => Object.values(p.rpts || {}).reduce((a, r) => Math.max(a, r.total || 0), 0);   // the busiest of your repeaters
  const hamCount = p => cnt(ever(p, 'heard'));
  const mu = p => Object.values(p.mutual || {});
  const muN = (p, f) => mu(p).filter(f).length;
  const strong = e => e.tier === 'verified' || e.src === 'mine' || e.src === 'dir' || e.src === 'p25';
  const distinct = (p, f) => new Set(mu(p).map(f).filter(Boolean)).size;
  const BADGES = [
    ['first', '👋', 'First Contact', 'Receive your first mesh message', 10, p => [p.stats.rx, 1]],
    ['hello', '📡', 'Hello Mesh', 'Send your first message', 10, p => [p.stats.sent, 1]],
    ['cq', '📣', 'CQ CQ CQ', 'Call CQ on the mesh -- on a ham channel or zero-hop, please, not a #Public flood', 15, p => [p.stats.cq, 1]],
    ['qso', '🗨️', 'Mesh QSO', 'A direct message both ways with a ham within 10 minutes', 30, p => [cnt(ever(p, 'qso')), 1]],
    ['qso10', '🗣️', 'Rag Chewer', 'Mesh QSOs with 10 different hams', 80, p => [cnt(ever(p, 'qso')), 10]],
    ['dx10', '🎯', '10 km Club', 'Hear a ham 10 km away, direct (no hops)', 30, p => [rec(p, 'dx'), 10]],
    ['dx25', '🏹', '25 km Club', 'Hear a ham 25 km away, direct', 60, p => [rec(p, 'dx'), 25]],
    ['dx50', '🏔️', '50 km Club', 'Hear a ham 50 km away, direct', 120, p => [rec(p, 'dx'), 50]],
    ['dx100', '💯', 'Century', 'Hear a ham 100 km away, direct', 250, p => [rec(p, 'dx'), 100]],
    ['dx200', '🚀', '200 km Club', 'Hear a ham 200 km away, direct -- legendary', 500, p => [rec(p, 'dx'), 200]],
    ['dxa50', '🛰️', 'Long Haul', 'Hear a ham 50 km away over the mesh (any hops)', 60, p => [rec(p, 'dxa'), 50]],
    ['hop3', '🔁', 'Hop Scotch', 'Hear a ham 3 hops away', 25, p => [rec(p, 'hops'), 3]],
    ['hop6', '🦘', 'Hop Legend', 'Hear a ham 6 hops away', 80, p => [rec(p, 'hops'), 6]],
    ['deep', '🌊', 'Out of the Noise', 'Decode a packet at -15 dB SNR or weaker', 60, p => [p.recs.deep && p.recs.deep.v <= -15 ? 1 : 0, 1]],
    ['n10', '🕸️', 'Networker', 'Hear 10 different hams', 20, p => [hamCount(p), 10]],
    ['n50', '🧭', 'Collector', 'Hear 50 different hams', 60, p => [hamCount(p), 50]],
    ['n150', '🗺️', 'Cartographer', 'Hear 150 different hams', 150, p => [hamCount(p), 150]],
    ['ham5', '📻', 'Ham Spotter', 'Hear 5 licensed hams on the mesh', 40, p => [hamCount(p), 5]],
    ['g5', '🔲', 'Grid Hunter', 'Hear hams in 5 grid squares', 40, p => [cnt(p.grids), 5]],
    ['g15', '🧩', 'Grid Master', 'Hear hams in 15 grid squares', 120, p => [cnt(p.grids), 15]],
    ['day20', '🐝', 'Busy Day', 'Hear 20 different hams in one day', 50, p => [rec(p, 'day'), 20]],
    ['trace', '🛰️', 'Pathfinder', 'Get a traceroute answer from another station', 20, p => [p.stats.traces, 1]],
    ['trace3', '🧗', 'Explorer', 'A traceroute through 3 or more hops', 50, p => [p.stats.trace3 || 0, 1]],
    ['hunt', '🎯', 'CQ Hunter', 'Answer a ham calling CQ -- it counts once they make two-way contact with you within a day, or at once when the P25X gateway knows their call', 20, p => [cnt(ever(p, 'cq')), 1]],
    ['hunt10', '🏹', 'Pile-up Buster', 'Answer 10 different hams calling CQ', 80, p => [cnt(ever(p, 'cq')), 10]],
    ['bridge', '🌉', 'Bridge Builder', 'Bridge a message between the mesh and P25', 40, p => [p.stats.bridged, 1]],
    ['wx', '🌡️', 'Weather Watcher', 'Hear a node sending weather (temperature) data', 15, p => [p.stats.wx || 0, 1]],
    ['mobile', '🚗', 'Mobile Mesh', 'Hear a node on the move', 20, p => [p.stats.mobile || 0, 1]],
    ['night', '🦉', 'Night Owl', 'A mesh message between midnight and 4 am', 20, p => [p.stats.night || 0, 1]],
    ['dawn', '🐓', 'Dawn Patrol', 'A mesh message between 5 and 6 am', 20, p => [p.stats.dawn || 0, 1]],
    ['s3', '🔥', 'On a Roll', 'On the mesh 3 days in a row', 30, p => [p.streak.best, 3]],
    ['s7', '☄️', 'Week Warrior', 'On the mesh 7 days in a row', 80, p => [p.streak.best, 7]],
    ['s30', '🌋', 'Unstoppable', 'On the mesh 30 days in a row', 300, p => [p.streak.best, 30]],
    ['sweep', '🧹', 'Clean Sweep', 'Finish all three daily missions in a day', 40, p => [p.stats.sweeps || 0, 1]],
    ['multi', '🔷', 'Multi-mesh', 'Connect two kinds of LoRa device (Meshtastic, MeshCore, LoRa APRS)', 30, p => [cnt(p.devs), 2]],
    ['marathon', '⏱️', 'Marathon', 'Stay on the mesh for 2 hours in one go', 30, p => [p.stats.marathon || 0, 1]],
    ['cloud', '☁️', 'Cloud Peek', 'Ask the P25X gateway for the mesh near you, over P25', 15, p => [p.stats.gw || 0, 1]],
    ['total', '💾', 'Total Data', 'Send your scores to the club leaderboard over P25 packet data', 25, p => [p.stats.board || 0, 1]],
    // the Golden Packet TOKEN (js/meshgold.js): one signed packet the club passes station to station
    ['holder', '🪙', 'Golden Packet Holder', 'Hold the club\'s Golden Packet token -- handed to you over the mesh, signed by the giver\'s node', 150, p => [p.stats.tokens || 0, 1]],
    ['giver', '🤲', 'Pass It On', 'Hand a Golden Packet token on to another station', 75, p => [p.stats.tokGiven || 0, 1]],
    // your own repeaters (admin login) carrying the club's traffic: packets they've sent, added up across reboots
    ['radmin', '🔑', 'Repeater Admin', 'Log in to YOUR OWN MeshCore repeater over the air and read its status. It counts when the repeater is listed under your callsign in the P25X ham directory, or you have marked it as yours -- and not with the stock default password (change that first, so nobody else can take your repeater over)', 40, p => [p.stats.rptStatus || 0, 1], { inf: 1 }],
    ['rhero', '🗼', 'Repeater Hero', 'Your own repeater has carried 1,000 packets for the mesh (no default password)', 100, p => [rptSent(p), 1000], { inf: 1 }],
    ['rhero10k', '🏔️', 'Mountain Top', 'Your own repeater has carried 10,000 packets for the mesh', 250, p => [rptSent(p), 10000], { inf: 1 }],
    ['rhero100k', '🛰️', 'Backbone', 'Your own repeater has carried 100,000 packets for the mesh', 600, p => [rptSent(p), 100000], { inf: 1 }],
    // Drive mode (js/meshdrive.js): pings a repeater heard
    ['wardriver', '🚗', 'Wardriver', 'Drive mode: 10 pings heard by a repeater', 60, p => [p.stats.driveHeard || 0, 10], { inf: 1 }],
    // ---- needs contacts: two-way contact with hams (a Handshake), AWARDS_REVIEW.md section 4
    ['ack', '✅', 'Delivered!', 'Get a direct message delivered (✓✓)', 15, p => [p.stats.acks, 1], { ct: 1 }],
    ['shake', '🤝', 'Handshake', 'Two-way contact with a ham: you each have the other on your radio (proved by a ✓✓, a DM from them, a path return or a path discovery)', 30, p => [cnt(p.mutual), 1], { ct: 1 }],
    ['social', '🦋', 'Social Butterfly', 'Two-way contact with 5 different hams', 60, p => [cnt(p.mutual), 5], { ct: 1 }],
    ['mutual10', '🕸️', 'Club Net', 'Two-way contact with 10 different hams', 120, p => [cnt(p.mutual), 10], { ct: 1 }],
    ['mutual25', '📇', 'Mesh Rolodex', 'Two-way contact with 25 different hams -- at least 10 of them listed in the P25X directory, known by P25, or set by you', 300, p => [Math.min(cnt(p.mutual), 15 + Math.min(10, muN(p, strong))), 25], { ct: 1 }],
    ['mutual50', '🧙', 'Mesh Elmer\'s Book', 'Two-way contact with 50 different hams -- at least 25 of them listed in the P25X directory, known by P25, or set by you', 600, p => [Math.min(cnt(p.mutual), 25 + Math.min(25, muN(p, strong))), 50], { ct: 1 }],
    ['card', '🪪', 'Calling Card', 'A ham made two-way contact within 14 days of you handing out your contact card (copy, download or QR)', 40, p => [muN(p, e => e.card), 1], { ct: 1 }],
    ['card5', '🃏', 'Card Shark', '5 hams made two-way contact within 14 days of you handing out your card', 100, p => [muN(p, e => e.card), 5], { ct: 1 }],
    ['advok', '📢', 'Heard and Answered', 'A new ham made two-way contact within 24 hours of your advert', 30, p => [muN(p, e => e.adv), 1], { ct: 1 }],
    ['listed', '📒', 'In the Book', 'Your node is listed in the P25X ham directory', 25, p => [p.stats.listed || 0, 1], { ct: 1 }],
    ['dirwork', '📖', 'By the Book', 'Two-way contact with 5 hams you added from the P25X ham directory', 50, p => [muN(p, e => e.dirw), 5], { ct: 1 }],
    ['found', '🔍', 'Open Door', 'A ham let you discover a path to them (path discovery answered)', 25, p => [muN(p, e => e.disc), 1], { ct: 1 }],
    ['found5', '🚪', 'Welcome Mat', 'Path discovery answered by 5 different hams', 60, p => [muN(p, e => e.disc), 5], { ct: 1 }],
    ['intro', '🧑‍🤝‍🧑', 'Introducer', '5 times: you shared a ham you already have two-way contact with (📣 Share), and within 7 days a new ham within direct range of you made two-way contact with you', 25, p => [muN(p, e => e.intro), 5], { ct: 1 }],
    ['rpt3', '🗼', 'Across the Repeaters', 'Two-way contacts reached through 3 different home repeaters (2- or 3-byte path hashes)', 50, p => [distinct(p, e => e.rpt), 3], { ct: 1 }],
    ['grid3', '🔲', 'Grid Neighbours', 'Two-way contacts in 3 different grid squares', 50, p => [distinct(p, e => e.grid), 3], { ct: 1 }],
    ['grid6', '🧩', 'Regional Net', 'Two-way contacts in 6 grid squares', 120, p => [distinct(p, e => e.grid), 6], { ct: 1 }],
    ['welcome', '🎉', 'Welcome Wagon', 'Two-way contact with a ham within 14 days of their callsign joining the P25X ham directory', 40, p => [muN(p, e => e.wel), 1], { ct: 1 }],
    ['welcome5', '🏡', 'Mesh Elmer', 'Welcome 5 new hams to the P25X ham directory', 150, p => [muN(p, e => e.wel), 5], { ct: 1 }],
    ['still', '♻️', 'Still There', '10 hams still making two-way contact with you 30 days or more after the first time', 60, p => [muN(p, e => e.still), 10], { ct: 1 }],
    ['gold', '🥇', 'Golden Packet', 'Prove a two-way exchange with a ham 20 km away (it answered YOUR packet)', 60, p => [rec(p, 'gold'), 20], { ct: 1 }],
    ['gold25', '🏅', 'Gold Standard', 'A golden packet over 25 km', 120, p => [rec(p, 'gold'), 25], { ct: 1 }],
    ['gold50', '👑', 'Golden Mountain', 'A golden packet over 50 km', 250, p => [rec(p, 'gold'), 50], { ct: 1 }],
    ['gold100', '🌟', 'Golden Century', 'A golden packet over 100 km -- two-way, the hard way', 500, p => [rec(p, 'gold'), 100], { ct: 1 }],
    ['goldshake', '🤝', 'Golden Handshake', 'A golden packet with a ham 20 km or more away that you\'ve swapped contacts with', 80, p => [p.stats.goldshake || 0, 1], { ct: 1 }],
  ].map(([id, ic, name, desc, xp, prog, f]) => Object.assign({ id, ic, name, desc, xp, prog }, f || {}));
  const BADGE = Object.fromEntries(BADGES.map(b => [b.id, b]));
  // season 1 trophies, for the "classic" shelf: the old names / descriptions (Hardware Zoo is retired)
  const CLASSIC_META = {
    qso: ['🤝', 'Mesh QSO', 'A direct message both ways within 10 minutes'], qso10: ['🗣️', 'Rag Chewer', '10 mesh QSOs'],
    dx10: ['🎯', '10 km Club', 'Hear a node 10 km away, direct'], dx25: ['🏹', '25 km Club', 'Hear a node 25 km away, direct'],
    dx50: ['🏔️', '50 km Club', 'Hear a node 50 km away, direct'], dx100: ['💯', 'Century', 'Hear a node 100 km away, direct'],
    dx200: ['🚀', '200 km Club', 'Hear a node 200 km away, direct'], dxa50: ['🛰️', 'Long Haul', 'Hear a node 50 km away over the mesh'],
    hop3: ['🔁', 'Hop Scotch', 'Hear a node 3 hops away'], hop6: ['🦘', 'Hop Legend', 'Hear a node 6 hops away'],
    n10: ['🕸️', 'Networker', 'Hear 10 different nodes'], n50: ['🧭', 'Collector', 'Hear 50 different nodes'], n150: ['🗺️', 'Cartographer', 'Hear 150 different nodes'],
    ham5: ['📻', 'Ham Spotter', 'Hear 5 licensed hams on the mesh'], g5: ['🔲', 'Grid Hunter', 'Hear nodes in 5 grid squares'], g15: ['🧩', 'Grid Master', 'Hear nodes in 15 grid squares'],
    hw5: ['🧰', 'Hardware Zoo', 'Hear 5 different kinds of node hardware (retired)'], day20: ['🐝', 'Busy Day', 'Hear 20 nodes in one day'],
    trace: ['🛰️', 'Pathfinder', 'Get a traceroute answer'], trace3: ['🧗', 'Explorer', 'A traceroute through 3 or more hops'],
    ack: ['✅', 'Delivered!', 'Get a direct message delivered (✓✓)'], hunt: ['🎯', 'CQ Hunter', 'Answer a station calling CQ'], hunt10: ['🏹', 'Pile-up Buster', 'Answer 10 stations calling CQ'],
    social: ['🦋', 'Social Butterfly', 'Message 5 different nodes directly'], bridge: ['🌉', 'Bridge Builder', 'Bridge a message between the mesh and P25'],
    gold: ['🥇', 'Golden Packet', 'A two-way exchange with a station far away'], gold25: ['🏅', 'Gold Standard', 'A golden packet over 25 km'],
    gold50: ['👑', 'Golden Mountain', 'A golden packet over 50 km'], gold100: ['🌟', 'Golden Century', 'A golden packet over 100 km'],
    holder: ['🪙', 'Golden Packet Holder', 'Held the club\'s Golden Packet token'], giver: ['🤲', 'Pass It On', 'Handed a Golden Packet token on'],
  };
  // badges whose rules didn't change carry straight over into season 2 (AWARDS_REVIEW.md section 8); the rest are classic
  const CARRY = ['first', 'hello', 'cq', 's3', 's7', 's30', 'night', 'dawn', 'sweep', 'multi', 'marathon', 'cloud', 'total', 'deep', 'wx', 'mobile',
    'radmin', 'rhero', 'rhero10k', 'rhero100k', 'wardriver'];
  const CLASSIC_RECS = ['gold', 'rtt', 'dx', 'dxa', 'best'];   // may have come from repeaters or your own nodes; best = retired

  // Daily missions: three a day, picked by the date alone, so everyone in the club gets the same three (a mission a
  // device can't do -- traceroute on MeshCore / LoRa APRS -- is skipped, and the next one in the day's order steps in).
  // The 'mutual' slot is offered only to a MeshCore profile with 3+ Handshakes; everyone else gets 'hamheard' there.
  const MISSIONS = [
    { id: 'newnodes', ic: '🕸️', ev: 'dayNode', goals: [3, 5, 8], t: g => `Hear ${g} different hams today` },
    { id: 'far', ic: '🎯', ev: 'km', max: true, goals: [5, 10, 20], t: g => `Hear a ham ${g} km or more away` },
    { id: 'mutual', ic: '🤝', ev: 'shake', goals: [1, 2], alt: 'hamheard', t: g => `Make two-way contact with ${g} ham${g > 1 ? 's' : ''} (a ✓✓, a DM from them or a path return)` },
    { id: 'trace', ic: '🛰️', ev: 'trace', goals: [1], need: 'trace', t: () => 'Get a traceroute answer' },
    { id: 'ham', ic: '📻', ev: 'ham', goals: [1], t: () => 'Hear a licensed ham on the mesh' },
    { id: 'chat', ic: '💬', ev: 'rxch', goals: [3, 5, 10], t: g => `Receive ${g} channel messages` },
    { id: 'pos', ic: '📍', ev: 'pos', goals: [1], t: () => 'Share your position on the mesh', hot: 'pos' },
    { id: 'qso', ic: '🗨️', ev: 'qso', goals: [1], need: 'dm', t: () => 'Make a mesh QSO with a ham (a direct message both ways)' },
    { id: 'hops', ic: '🔁', ev: 'hops', max: true, goals: [2, 3], t: g => `Hear a ham ${g} or more hops away` },
    { id: 'grid', ic: '🔲', ev: 'grid', goals: [1], t: () => 'Hear a ham in a grid square you haven\'t had yet' },
    { id: 'answer', ic: '🎯', ev: 'answer', goals: [1, 2], t: g => g > 1 ? `Answer ${g} hams calling CQ` : 'Answer a ham calling CQ' },
  ];
  const ALT = { hamheard: { id: 'hamheard', ic: '📻', ev: 'hamhop', goals: [1], t: () => 'Hear a ham 2 or more hops away' } };
  const missionDef = id => MISSIONS.find(x => x.id === id) || ALT[id];
  const REC_META = {
    dx: { ic: '🏆', name: 'Longest direct contact (hams)', unit: 'km', fmt: v => v.toFixed(1), better: (a, b) => a > b + 0.05 },
    dxa: { ic: '🛰️', name: 'Longest over the mesh (hams)', unit: 'km', fmt: v => v.toFixed(1), better: (a, b) => a > b + 0.05 },
    hops: { ic: '🔁', name: 'Most hops away', unit: 'hops', fmt: v => String(v), better: (a, b) => a > b },
    deep: { ic: '🌊', name: 'Weakest signal decoded', unit: 'dB SNR', fmt: v => v.toFixed(1), better: (a, b) => a < b - 0.05 },
    day: { ic: '🐝', name: 'Most hams in one day', unit: 'hams', fmt: v => String(v), better: (a, b) => a > b },
    gold: { ic: '🥇', name: 'Golden packet (longest two-way)', unit: 'km', fmt: v => v.toFixed(1), better: (a, b) => a > b + 0.05, ct: 1 },
    rtt: { ic: '⚡', name: 'Fastest round trip (two-way, hams)', unit: 's', fmt: v => v.toFixed(1), better: (a, b) => a < b - 0.05, ct: 1 },
    tok: { ic: '🪙', name: 'Longest Golden Packet hand-off', unit: 'km', fmt: v => v.toFixed(1), better: (a, b) => a > b + 0.05 },
  };
  const OLD_REC_META = { dx: ['🏆', 'Longest direct contact', 'km'], dxa: ['🛰️', 'Longest over the mesh', 'km'], gold: ['🥇', 'Golden packet', 'km'],
    rtt: ['⚡', 'Fastest round trip', 's'], best: ['📶', 'Best signal heard (retired)', 'dB SNR'] };
  // a record only gets the full-screen celebration once it's a real one (not the first node of the day)
  const CELEBRATE_FROM = { dx: 3, dxa: 5, hops: 3, deep: -10, day: 10, gold: 2, rtt: 5, tok: 2 };
  const LOWER_BETTER = { deep: 1, rtt: 1 };

  function blank() {
    return { v: 2, xp: 0, badges: {}, seenBadges: {}, recs: {}, log: {}, grids: {}, devs: {}, days: {}, streak: { n: 0, best: 0, last: '' },
      mis: { day: '', list: [] }, stats: { sent: 0, rx: 0, cq: 0, qsos: 0, acks: 0, traces: 0, bridged: 0 }, sendXp: { day: '', n: 0 }, lastRx: {}, lastTx: {}, qsoAt: {}, board: null,
      mutual: {}, out: { card: [], local: [], flood: [], dirAdds: {}, share: {} }, dirFirst: {}, cqPend: {}, adminKeys: {}, classic: {}, classicXp: 0, classicRecs: {} };
  }
  const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const utcDay = t => new Date(t).toISOString().slice(0, 10);
  const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = seed => () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const lowKey = x => (x == null ? '' : String(x).trim().toLowerCase());
  const HCx = () => window.KellyHC || null;
  const normCall = c => { const H = HCx(); if (H && H.normCall) return H.normCall(c); const s = String(c || '').toUpperCase().trim().split(/[-/ ]/)[0]; return s || null; };
  const NOT_HAM = Object.freeze({ ham: false, tier: 'none', call: null, owner: null, cls: 'unknown', self: false, src: null, why: 'Ham Contacts did not load, so nothing scores', demo: false });

  // season 1 'meshQuest' -> season 2 'meshQuest2' (AWARDS_REVIEW.md section 8). Pure: old profile in, new profile out.
  function migrate(old, o) {
    o = o || {};
    const p = blank(), now = o.now || Date.now();
    if (!old || typeof old !== 'object') return p;
    p.classicXp = Math.max(0, Math.round(old.xp || 0));
    for (const [id, t] of Object.entries(old.badges || {})) {
      if (!t) continue;
      if (CARRY.includes(id) && BADGE[id]) { p.badges[id] = t; p.seenBadges[id] = 1; } else p.classic[id] = t;
    }
    p.xp = Object.keys(p.badges).reduce((a, id) => a + BADGE[id].xp, 0);
    for (const [key, r] of Object.entries(old.recs || {})) {
      if (!r || typeof r !== 'object') continue;
      if (CLASSIC_RECS.includes(key)) p.classicRecs[key] = r; else if (REC_META[key]) p.recs[key] = r;
    }
    if (old.streak) p.streak = Object.assign(p.streak, old.streak);
    for (const f of ['devs', 'rpts', 'log']) if (old[f] && typeof old[f] === 'object') p[f] = JSON.parse(JSON.stringify(old[f]));
    const s = old.stats || {};
    for (const f of ['sent', 'rx', 'cq', 'night', 'dawn', 'sweeps', 'wx', 'mobile', 'marathon', 'gw', 'board', 'rptStatus', 'driveHeard', 'drivePings', 'pos']) if (s[f] != null) p.stats[f] = s[f];
    // backfill: a MeshCore QSO with a ham callsign was a two-way proof. Counts for the ladders, never the window awards.
    const H = HCx(), RPT = /^VK\dR[A-Z]{2}$/;
    for (const L of Object.values(old.log || {})) {
      if (!L || !(L.qso > 0) || (L.dev && L.dev !== 'MeshCore')) continue;
      const c = H && H.callFromName ? H.callFromName(L.name) : (/\b((?:VK|ZL|AX)\d[A-Z]{1,4})\b/.exec(String(L.name || '').toUpperCase()) || [])[1];
      const call = normCall(c);
      if (!call || !/^(VK|ZL|AX)/.test(call) || RPT.test(call) || (H && ((H.NOT_CALLS || []).includes(call) || (H.CLUB_CALLS || []).includes(call)))) continue;
      if (o.myCall && call === o.myCall) continue;
      if (p.mutual[call] || cnt(p.mutual) >= MUTUAL_MAX) continue;
      p.mutual[call] = { key: null, first: L.first || now, last: L.last || L.first || now, how: 'backfill', n: L.qso, via: null, rpt: null, grid: L.grid ? L.grid.slice(0, 4) : null, tier: 'probable', src: 'name', bf: 1 };
    }
    if (o.myKey) p.selfKeys = { [lowKey(o.myKey)]: now };
    p.migrated = now;
    return p;
  }

  window.KellyMeshFun = function (k) {
    const { $, $$, esc, settings, store, toast, addEvent, dirty } = k, ms = k.ms;
    if (ms.quest == null) ms.quest = true;
    // demo: the mesh demo link, the sim transport, #hc-demo / #tr-demo, PJ demo, ?demo -- any of them
    const isDemo = () => {
      try { if (window.KellyAwards && window.KellyAwards.demo()) return true; } catch { /* */ }
      try { return !!((k.awardsDemo && k.awardsDemo()) || (k.isDemo && k.isDemo())); } catch { return false; }
    };
    const myCall = () => normCall(settings.gwCall || settings.myCall || '') || '';
    let real = store.get('meshQuest2', null);
    if (!real) {   // first run of season 2: built once from season 1, which is never written again
      let old = null; try { old = store.get('meshQuest', null); } catch { /* */ }
      let myKey = null; try { myKey = k.myKey ? k.myKey() : null; } catch { /* */ }
      real = migrate(old, { myCall: myCall(), myKey });   // saved with the first real (non-demo) event, never at load
    }
    real = Object.assign(blank(), real);
    for (const [key, v] of Object.entries(blank())) if (real[key] == null) real[key] = v;
    for (const [key, v] of Object.entries(blank().out)) if (real.out[key] == null) real.out[key] = v;
    let demoP = null;
    const P = () => isDemo() ? (demoP = demoP || blank()) : real;
    // the snapshots of contact-key prefixes the card / advert windows check: local only (store 'meshQuestKnown', never
    // synced -- QR_REVIEW.md S21); an older profile's copies move here at load
    let known = (() => { try { const v = store.get('meshQuestKnown', null); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })(), demoKnown = {};
    let moved = false;
    for (const f of ['card', 'adv']) { const o = real.out[`${f}Known`]; if (o !== undefined) { if (o && !known[f]) known[f] = o; delete real.out[`${f}Known`]; moved = true; } }
    const KN = () => (isDemo() ? demoKnown : known);
    const saveKnown = () => { if (isDemo()) return; try { store.set('meshQuestKnown', known); } catch { /* full: memory only */ } };
    if (moved) saveKnown();
    // the award engine: ham test, self set, one per ham per day, daily caps -- every score goes through it
    const hamOf = n => { const H = window.KellyHamCalls; try { if (n && !n.net && !n.key && k.devLabel && k.devLabel() === 'LoRa APRS') n = Object.assign({}, n, { net: 'aprs', aprsCall: n.longName || n.idLabel, aprsSym: n.sym }); return (H && H.hamOf && H.hamOf(n)) || NOT_HAM; } catch { return NOT_HAM; } };
    const KA = window.KellyAwards;
    const eng = KA && KA.create ? KA.create({ P, hamOf: n => (k.hamOf ? k.hamOf(n) : hamOf(n)) || NOT_HAM }) : {   // award-engine.js missing: nothing scores
      count: (kind, other) => Object.freeze({ r: NOT_HAM, counts: false, first: false, score: false, owner: null, why: 'the award engine did not load' }),
      cap: () => false, owners: () => ({}), isSelf: () => false, selfKeys: () => [], connected() {}, notMine() {}, addSelf: () => () => {}, creditKm: km => km };
    eng.addSelf(() => Object.keys(P().adminKeys || {}));   // a repeater you've logged in to as admin is yours: it never scores
    const fresh = (kind, owner) => { const e = eng.owners(kind)[owner]; return !e || utcDay(e.last) !== utcDay(Date.now()); };
    const saveSoon = (() => { let t; return () => { if (isDemo()) return; clearTimeout(t); t = setTimeout(() => { if (isDemo()) return; prune(); try { store.set('meshQuest2', real); } catch { /* */ } }, 2000); }; })();
    function prune() {
      const days = Object.keys(real.days).sort(); while (days.length > 60) delete real.days[days.shift()];
      const log = Object.entries(real.log); if (log.length > 1500) { log.sort((a, b) => (a[1].last || 0) - (b[1].last || 0)); for (const [num] of log.slice(0, log.length - 1500)) delete real.log[num]; }
      const cut = Date.now() - QSO_WINDOW * 3; for (const o of [real.lastRx, real.lastTx, real.qsoAt]) for (const [x, t] of Object.entries(o)) if (t < cut) delete o[x];
      pruneP(real);
    }
    const capObj = (o, n, f) => { const ks = Object.keys(o); if (ks.length > n) ks.sort((a, b) => f(o[a]) - f(o[b])).slice(0, ks.length - n).forEach(x => delete o[x]); };
    function pruneP(p) {
      const old = Date.now() - OUT_DAYS * DAY;
      capObj(p.mutual, MUTUAL_MAX, e => e.last || 0);
      for (const f of ['card', 'local', 'flood']) { const l = (p.out[f] || []).filter(t => t >= old); p.out[f] = l.slice(-OUT_MAX); }
      for (const f of ['dirAdds', 'share']) { const o = p.out[f] || (p.out[f] = {}); for (const [x, t] of Object.entries(o)) if (t < old) delete o[x]; capObj(o, OUT_MAX, t => t); }
      capObj(p.dirFirst, DIRFIRST_MAX, t => t);
      for (const [c, t] of Object.entries(p.cqPend)) if (Date.now() - t > CQ_WIN) delete p.cqPend[c];
      capObj(p.cqPend, CQPEND_MAX, t => t); capObj(p.adminKeys, ADMIN_MAX, t => t);
    }
    const quiet = () => !ms.quest;
    const fxOn = () => !!(ms.fx && settings.fx) && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tab = store.get('meshQuestTab', 'missions'), boardAsk = null, sessionAt = 0;
    // a mesh.js node record (or what we know of it) for the ham test
    const nodeOf = (num, key) => {
      let n = null; try { n = num != null && k.node ? k.node(num) : null; } catch { /* */ }
      if (!n && key && k.nodes) { try { n = [...k.nodes()].find(x => x.key && lowKey(x.key) === lowKey(key)) || null; } catch { /* */ } }
      return n;
    };
    const withKey = (n, num) => n ? (n.key ? n : Object.assign({}, n, { key: `num:${n.num != null ? n.num : num}` })) : (num != null ? { num, key: `num:${num}` } : null);

    // ---------------------------------------------------------------- sounds (WebAudio, nothing on air)
    function play(kind) {
      if (!settings.sound || !ms.sound || ms.sfx[kind] === false) return;
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      try {
        const ctx = k.audioCtx(), t0 = ctx.currentTime + 0.02, vol = settings.soundVol ?? 0.7;
        const tone = (type, f, t, d, peak, f1 = f, lp = 0) => {
          const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
          o.frequency.setValueAtTime(f, t); if (f1 !== f) o.frequency.exponentialRampToValueAtTime(f1, t + d * 0.9);
          g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * vol), t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
          let out = o.connect(g);
          if (lp) { const f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = lp; out = out.connect(f2); }
          out.connect(ctx.destination); o.start(t); o.stop(t + d + 0.05);
        };
        const noise = (t, d, peak, hp = 5000) => {
          const n = Math.floor(ctx.sampleRate * d), buf = ctx.createBuffer(1, n, ctx.sampleRate), x = buf.getChannelData(0);
          for (let i = 0; i < n; i++) x[i] = (Math.random() * 2 - 1) * (1 - i / n);
          const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = buf; f.type = 'highpass'; f.frequency.value = hp;
          g.gain.value = peak * vol; s.connect(f).connect(g).connect(ctx.destination); s.start(t);
        };
        switch (kind) {
          case 'mission':   // the coin
            tone('square', 988, t0, 0.08, 0.06); tone('square', 1319, t0 + 0.08, 0.4, 0.06); break;
          case 'badge':     // sparkle up + bell
            [784, 988, 1175, 1568, 1976].forEach((f, i) => tone('triangle', f, t0 + i * 0.055, 0.3, 0.1));
            tone('sine', 2637, t0 + 0.32, 0.9, 0.05); tone('sine', 3951, t0 + 0.4, 0.8, 0.025); break;
          case 'level':     // arpeggio run, then a big chord
            [262, 330, 392, 523, 659, 784, 1047].forEach((f, i) => tone('square', f, t0 + i * 0.065, 0.13, 0.045));
            [523, 659, 784, 1047].forEach(f => tone('sawtooth', f, t0 + 0.5, 1.1, 0.035, f, 3000)); noise(t0 + 0.5, 0.6, 0.06); break;
          case 'record': {  // brass fanfare: ta-ta-ta TAAA, then the chord with a cymbal
            const brass = (f, t, d) => { tone('sawtooth', f, t, d, 0.06, f, 2400); tone('sawtooth', f * 1.004, t, d, 0.04, f * 1.004, 2400); };
            brass(392, t0, 0.13); brass(392, t0 + 0.15, 0.13); brass(392, t0 + 0.3, 0.13);
            [523, 659, 784].forEach(f => brass(f, t0 + 0.46, 1.2)); tone('sine', 131, t0 + 0.46, 1.0, 0.12); noise(t0 + 0.46, 1.0, 0.09, 6000);
            [1047, 1319, 1568, 2093].forEach((f, i) => tone('triangle', f, t0 + 1.0 + i * 0.07, 0.4, 0.05)); break;
          }
          case 'club':      // club record: the fanfare twice, up a fourth
            play('record'); setTimeout(() => { [698, 880, 1047].forEach(f => tone('sawtooth', f, ctx.currentTime, 1.4, 0.05, f, 2600)); noise(ctx.currentTime, 1.2, 0.1, 6000); }, 1350); break;
        }
      } catch { /* audio not unlocked yet */ }
    }

    // ---------------------------------------------------------------- XP, trophies, records, missions
    let floatSum = 0, floatT = 0;
    function addXp(n, why) {
      if (!n) return;
      const p = P(), before = lvOf(p.xp); p.xp += n;
      floatSum += n; clearTimeout(floatT); floatT = setTimeout(() => { floatXp(floatSum, why); floatSum = 0; }, 250);
      const after = lvOf(p.xp);
      if (after > before && !quiet()) celebrate({ kind: 'level', title: 'LEVEL UP!', big: `${LEVELS[after][2]} ${LEVELS[after][1]}`, sub: `You reached ${LEVELS[after][1]} with ${p.xp} XP${LEVELS[after + 1] ? ` · next: ${LEVELS[after + 1][1]} at ${LEVELS[after + 1][0]} XP` : ' · the top of the mesh!'}` });
      dirty('mesh'); saveSoon();
    }
    function floatXp(n, why) {
      if (!fxOn() || k.currentPage() !== 'mesh') return;
      const host = $('#mq-float'); if (!host) return;
      const el = document.createElement('b'); el.textContent = `+${n} XP${why ? ` · ${why}` : ''}`; host.appendChild(el);
      setTimeout(() => el.remove(), 1800);
      const bar = $('#mq-xpbar'); if (bar) { bar.classList.remove('bump'); void bar.offsetWidth; bar.classList.add('bump'); }
    }
    function checkBadges() {
      const p = P();
      for (const b of BADGES) {
        if (p.badges[b.id]) continue;
        const [now, goal] = b.prog(p);
        if (now >= goal) {
          p.badges[b.id] = Date.now();
          addEvent('data', `Mesh Quest trophy: ${b.name}`);
          if (!quiet()) { pop(`<span class="mq-pop-ic">${b.ic}</span><div><small>🎖️ TROPHY UNLOCKED</small><b>${esc(b.name)}</b><span>${esc(b.desc)} · +${b.xp} XP</span></div>`, 'badge'); play('badge'); }
          addXp(b.xp);
        }
      }
    }
    function setRec(key, v, extra) {
      const p = P(), meta = REC_META[key], old = p.recs[key], d = dayKey();
      if (old && !meta.better(v, old.v)) return false;
      // base = the value last celebrated: GPS jitter creeping a record up 50 m at a time stays quiet until it's
      // a real step (0.5 km or 2 %); most-hams-in-a-day celebrates once a day, not on every ham after that
      const base = old ? old.base ?? old.v : v;
      p.recs[key] = Object.assign({ v, at: Date.now(), day: d, dev: k.devLabel(), base, celebDay: old && old.celebDay }, extra || {});
      if (!old) return true;
      const worthy = LOWER_BETTER[key] ? v <= CELEBRATE_FROM[key] : v >= CELEBRATE_FROM[key];
      const step = key === 'dx' || key === 'dxa' || key === 'tok' ? v - base >= Math.max(0.5, base * 0.02) : key === 'deep' ? base - v >= 0.5
        : key === 'rtt' ? base - v >= 0.2 : v > base;
      const once = key !== 'day' || old.celebDay !== d;
      if (!worthy || !step || !once) return true;
      p.recs[key].base = v; p.recs[key].celebDay = d;
      const from = key === 'day' ? old.v : base;
      addEvent('data', `Mesh Quest record: ${meta.name} ${meta.fmt(v)} ${meta.unit}${extra && extra.who ? ` (${extra.who})` : ''}`);
      addXp(key === 'day' ? 10 : 50, 'record');
      if (!quiet()) celebrate({ kind: 'record', title: 'NEW PERSONAL RECORD!', label: `${meta.ic} ${meta.name}`, from, to: v, fmt: meta.fmt, unit: meta.unit,
        sub: `${extra && extra.who ? esc(extra.who) : ''}${extra && extra.hops != null && key !== 'hops' ? ` · ${extra.hops === 0 ? 'direct' : extra.hops + ' hops'}` : ''}${extra && extra.snr != null && key !== 'deep' ? ` · SNR ${extra.snr.toFixed(1)} dB` : ''} · beat ${meta.fmt(from)} ${esc(meta.unit)}`,
        dx: (key === 'dx' || key === 'dxa' || key === 'gold') && extra && extra.lat != null ? p.recs[key] : null });
      return true;
    }
    const mutualOk = p => cnt(p.mutual) >= 3 && (ms.dev === 'meshcore' || k.devLabel() === 'MeshCore');
    function today() {
      const p = P(), d = dayKey();
      const day = p.days[d] || (p.days[d] = { hams: [], rx: 0, sent: 0 });
      if (!day.hams) day.hams = [];
      if (p.mis.day !== d) {
        const caps = k.caps(), r = rng(hash(`p25x-mesh-${d}`));   // the date only: the whole club gets the same three
        // shuffle ALL missions (and roll every goal) the same way for everyone, then skip the ones this device can't do;
        // the 'mutual' slot becomes 'hamheard' in place for a profile that can't do it yet (the deck order doesn't move)
        const deck = MISSIONS.map(m => ({ m, goal: 0 })), list = [];
        for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
        for (const x of deck) x.goal = x.m.goals[Math.floor(r() * x.m.goals.length)];
        const swapIn = !mutualOk(p);
        for (const x of deck) {
          if (list.length >= 3 || (x.m.need && !caps[x.m.need])) continue;
          if (x.m.alt && swapIn) list.push({ id: x.m.alt, goal: ALT[x.m.alt].goals[0], v: 0, done: 0 });
          else list.push({ id: x.m.id, goal: x.goal, v: 0, done: 0 });
        }
        p.mis = { day: d, list, swept: 0 };
      }
      return day;
    }
    function mission(ev, val = 1) {
      const p = P(); today();
      for (const m of p.mis.list) {
        const def = missionDef(m.id); if (!def || def.ev !== ev || m.done) continue;
        m.v = def.max ? Math.max(m.v, val) : m.v + val;
        if (m.v >= m.goal) {
          m.done = Date.now();
          if (!quiet()) { pop(`<span class="mq-pop-ic">${def.ic}</span><div><small>🎯 MISSION COMPLETE</small><b>${esc(def.t(m.goal))}</b><span>+40 XP</span></div>`, 'mission'); play('mission'); confetti(60); }
          addXp(40, 'mission');
        }
      }
      if (!p.mis.swept && p.mis.list.length && p.mis.list.every(m => m.done)) {
        p.mis.swept = Date.now(); p.stats.sweeps = (p.stats.sweeps || 0) + 1;
        if (!quiet()) celebrate({ kind: 'level', title: 'CLEAN SWEEP!', big: '🧹 3 / 3', sub: 'All of today\'s missions done · +60 XP bonus · new missions tomorrow' });
        addXp(60, 'sweep');
      }
      dirty('mesh');
    }
    function activity() {   // the streak: a day counts when your node is on the mesh
      const p = P(), d = dayKey();
      if (p.streak.last === d) return;
      const y = dayKey(Date.now() - 86400000);
      p.streak.n = p.streak.last === y ? p.streak.n + 1 : 1; p.streak.last = d; p.streak.best = Math.max(p.streak.best, p.streak.n);
      if (p.streak.n > 1 && !quiet()) { pop(`<span class="mq-pop-ic">🔥</span><div><small>DAY STREAK</small><b>${p.streak.n} days in a row!</b><span>+${5 * Math.min(p.streak.n, 7)} XP · come back tomorrow to keep it alive</span></div>`, 'streak'); play('mission'); }
      addXp(5 * Math.min(p.streak.n, 7), 'streak');
    }

    // ---------------------------------------------------------------- events from mesh.js
    // a node heard: the logbook takes every node; scores (hams heard, grids, distance, hops, Busy Day) take hams only
    function heard(n) {
      if (!n || n.viaMqtt || n.num === k.myNum()) return;
      const p = P(), now = Date.now(), day = today(), key = String(n.num), name = k.nodeName(n.num);
      const self = !!(n.key && eng.isSelf(n.key));
      const c = eng.count('heard', withKey(n, n.num), 'heard'), ham = c.counts && !!c.r.ham, owner = c.owner;
      let L = p.log[key];
      if (!L) L = p.log[key] = { name, first: now, msgs: 0, qso: 0 };
      Object.assign(L, { name, last: now, ham, call: c.r.call || null, dev: k.devLabel() });
      if (self) L.self = 1;
      if (n.hops != null) L.hops = L.hops == null ? n.hops : Math.min(L.hops, n.hops);
      if (n.snr != null) L.snr = L.snr == null ? n.snr : Math.max(L.snr, n.snr);
      if (c.first) addXp(25, 'new ham');
      if (ham) {
        if (!day.hams.includes(owner)) { day.hams.push(owner); if (day.hams.length > 500) day.hams.shift(); mission('dayNode'); setRec('day', day.hams.length, {}); }
        mission('ham');
        if (n.hops != null && n.hops >= 2) mission('hamhop');
        if (n.hops != null && n.hops > 0) { mission('hops', n.hops); setRec('hops', n.hops, { who: name, num: n.num }); }
      }
      if (!self && n.snr != null && n.snr > -40) setRec('deep', n.snr, { who: name, num: n.num, hops: n.hops });
      if (n.temp != null) p.stats.wx = 1;
      if ((n.speed && n.speed > 1) || (n.trail && n.trail.length >= 4)) p.stats.mobile = 1;
      const me = k.myPos();
      if (ham && n.lat != null && n.lon != null && (n.lat || n.lon) && me) {
        const raw = k.distKm(me, n), g = grid(n.lat, n.lon, 4);
        L.grid = grid(n.lat, n.lon, 6);
        if (raw < 2000) {   // beyond that it's a bad position, not LoRa
          const km = eng.creditKm(n.key || `num:${n.num}`, raw, n.hops || 0);   // a direct node can claim at most 40 km
          if (km != null) {
            L.km = Math.max(L.km || 0, km); L.brg = cardinal(k.bearing(me, n));
            mission('km', km);
            const extra = { who: name, num: n.num, lat: n.lat, lon: n.lon, snr: n.snr, hops: n.hops, myLat: me.lat, myLon: me.lon };
            if (n.hops === 0) setRec('dx', km, extra);
            if (n.hops != null) setRec('dxa', km, extra);
          }
        }
        if (g && !p.grids[g]) {
          p.grids[g] = now; mission('grid');
          if (cnt(p.grids) > 1 && !quiet()) { pop(`<span class="mq-pop-ic">🔲</span><div><small>NEW GRID SQUARE</small><b>${g}</b><span>${esc(name)} · ${cnt(p.grids)} squares so far · +20 XP</span></div>`, 'grid'); play('mission'); }
          addXp(20, 'grid');
        }
      }
      checkBadges(); saveSoon();
    }
    function text(msg, dm) {
      const p = P(), day = today(), now = Date.now(), from = String(msg.from), hr = new Date().getHours();
      p.stats.rx++; day.rx++;
      if (!p.log[from] && k.node(msg.from)) heard(k.node(msg.from));   // its first message can beat its first 'heard'
      if (p.log[from]) p.log[from].msgs = (p.log[from].msgs || 0) + 1;
      if (!dm) mission('rxch');
      if (hr < 4) p.stats.night = 1; if (hr === 5) p.stats.dawn = 1;
      if (eng.cap('rx')) addXp(2);   // the first 20 a day
      p.lastRx[from] = now;
      const mine = (settings.myCall || '').toUpperCase();
      const mentioned = !dm && mine && new RegExp(`\\b${mine.replace(/[^A-Z0-9]/g, '')}\\b`, 'i').test(msg.text || '');
      if ((dm || mentioned) && now - ((dm ? p.lastTx[from] : p.lastTx.ch) || 0) < QSO_WINDOW) qso(msg.from);
      checkBadges(); saveSoon();
    }
    // a mesh QSO: only with a ham (a keyless channel sender is never one), counted by ham
    function qso(num) {
      const p = P(), key = String(num), now = Date.now();
      if (now - (p.qsoAt[key] || 0) < QSO_WINDOW * 3) return;   // one QSO per conversation
      const node = withKey(nodeOf(num), num), c0 = eng.count('qso', node, 'qso', { dry: true });
      if (!c0.counts) return;
      const c = eng.count('qso', node, 'qso');
      p.qsoAt[key] = now; p.stats.qsos++;
      const L = p.log[key]; if (L) L.qso = (L.qso || 0) + 1;
      mission('qso');
      const xp = c.score ? 15 : 0;
      if (!quiet()) { pop(`<span class="mq-pop-ic">🗨️</span><div><small>MESH QSO</small><b>${esc(k.nodeName(num))}</b><span>${cnt(eng.owners('qso'))} ham${cnt(eng.owners('qso')) === 1 ? '' : 's'} worked${xp ? ` · +${xp} XP` : ' · already counted today'}</span></div>`, 'qso'); play('badge'); confetti(40); }
      addXp(xp, 'QSO');
    }
    function sent(msg, dm) {
      const p = P(), day = today(), d = dayKey(), now = Date.now();
      p.stats.sent++; day.sent++;
      if (p.sendXp.day !== d) p.sendXp = { day: d, n: 0 };
      if (p.sendXp.n < SEND_XP_DAY) { p.sendXp.n++; addXp(3); }
      if (/\bCQ\b/i.test(msg.text || '')) p.stats.cq++;   // the CQ CQ CQ trophy only: no daily mission pushes a CQ
      if (dm) {
        const to = String(msg.to); p.lastTx[to] = now;
        if (now - (p.lastRx[to] || 0) < QSO_WINDOW) qso(msg.to);
      } else p.lastTx.ch = now;
      checkBadges(); saveSoon();
    }
    // ✓✓: the Delivered! trophy for any delivery; XP only for the first one per ham per day
    function ack(msg) {
      if (!msg || msg.state !== 'delivered' || msg.ackCounted) return;
      msg.ackCounted = 1; const p = P(); p.stats.acks++;
      const c = eng.count('ack', withKey(nodeOf(msg.to), msg.to), 'ack');
      if (c.score) addXp(5, 'delivered');
      checkBadges(); saveSoon();
    }
    // a traceroute answer: Pathfinder / Explorer count any station but your own, XP once per target per day
    function trace(tr) {
      if (!tr) return;
      const p = P(), num = tr.to != null ? tr.to : tr.num;
      const c = eng.count('trace', withKey(nodeOf(num), num), 'trace', { anyStation: true });
      if (!c.counts) { checkBadges(); return; }
      p.stats.traces++;
      if (tr.towards && tr.towards.length - 2 >= 3) p.stats.trace3 = 1;
      if (c.score) { mission('trace'); addXp(15, 'traceroute'); }
      checkBadges(); saveSoon();
    }
    function bridge() { const p = P(); p.stats.bridged++; checkBadges(); saveSoon(); }   // the trophy only: no XP per bridged message
    // A Handshake (AWARDS_REVIEW.md section 4): x = {key, num, name, type, how, at, demo?}. Companions (type 1) only.
    function mutual(x) {
      if (!x || !PROOFS[x.how]) return;
      if (x.demo && !isDemo()) return;   // the Ham Contacts demo world never reaches the real profile
      if (x.yours) return;               // the demo world's station marked "yours": the no-score case
      const p = P(), at = Number(x.at) || Date.now(), n0 = nodeOf(x.num, x.key);
      const ty = Number(x.type != null ? x.type : n0 ? (n0.type != null ? n0.type : n0.role) : 0);
      if (ty !== 1) return;
      const key = lowKey(x.key || (n0 && n0.key)); if (!key) return;
      const node = Object.assign({}, n0 || {}, { key, num: x.num != null ? x.num : n0 && n0.num, longName: x.name || (n0 && n0.longName) || '', type: 1 });
      if (x.demo) node.demo = true;
      const c0 = eng.count('shake', node, x.how, { dry: true });
      if (!c0.counts || !c0.r.ham) return;
      const call = c0.owner, r = c0.r; let e = p.mutual[call];
      const isNew = !e;
      const c = isNew ? eng.count('shake', node, x.how) : c0;
      if (isNew) {
        e = p.mutual[call] = { key, first: at, last: at, how: x.how, n: 1, via: null, rpt: null, grid: null, tier: r.tier, src: r.src };
        attribute(p, e, node, at, call);
      } else {
        if (e.bf && !e.key) e.key = key;   // a backfilled one, now seen for real: no window awards (it's not new)
        if (key !== e.key) e.key = key;    // a second node of the same ham: one ham, the latest key
        e.last = Math.max(e.last || 0, at); e.n = (e.n || 0) + 1;
        if (r.tier === 'verified') e.tier = 'verified';
        if (!e.src || r.src === 'dir' || r.src === 'p25') e.src = r.src;
        if (at - (e.first || at) >= STILL_AFTER) e.still = 1;
      }
      if (x.how === 'discover') e.disc = 1;
      fillRoute(e, node);
      const dk = dayKey(at);
      if (e.day !== dk) { e.day = dk; mission('shake'); }
      if (isNew) {
        const xp = c.score ? SHAKE_XP : 0;
        addEvent('data', `Mesh Quest Handshake: ${call} (${PROOFS[x.how] || x.how})`);
        if (!quiet()) { pop(`<span class="mq-pop-ic">🤝</span><div><small>HANDSHAKE · TWO-WAY CONTACT</small><b>${esc(call)}</b><span>${esc(PROOFS[x.how] || 'two-way contact')} · ${cnt(p.mutual)} ham${cnt(p.mutual) === 1 ? '' : 's'}${xp ? ` · +${xp} XP` : ' · today\'s 10 are done: it still counts for trophies'}</span></div>`, 'qso'); play('badge'); confetti(50); }
        addXp(xp, 'Handshake');
      }
      // a CQ answered earlier: the caller came back with two-way contact within a day
      const pend = p.cqPend[call]; if (pend && at - pend <= CQ_WIN && at >= pend) { delete p.cqPend[call]; creditCq(r, call); }
      checkBadges(); saveSoon();
    }
    // the window awards on a NEW Handshake: how the ham may have found us (honest time windows, never "they imported it")
    function attribute(p, e, node, at, call) {
      const o = p.out, before = arr => arr.filter(t => t <= at).pop();
      const knownAt = (t, snap) => { if (snap && snap.t === t && Array.isArray(snap.k)) return snap.k.includes(e.key.slice(0, 16)); const L = p.log[String(node.num)]; return !!(L && L.first < t); };
      const dirT = o.dirAdds[e.key];
      if (dirT && dirT <= at && e.tier === 'verified') { e.dirw = 1; e.via = 'dir'; }
      const cardT = before(o.card); if (cardT && at - cardT <= CARD_WIN && !knownAt(cardT, KN().card)) { e.card = 1; e.via = e.via || 'card'; }
      const advT = Math.max(before(o.local) || 0, before(o.flood) || 0); if (advT && at - advT <= ADV_WIN && !knownAt(advT, KN().adv)) { e.adv = 1; e.via = e.via || 'advert'; }
      if (node.hops === 0 && Object.values(o.share).some(t => t <= at && at - t <= INTRO_WIN)) { e.intro = 1; e.via = e.via || 'share'; }
      const f = p.dirFirst[call]; if (f && e.tier === 'verified' && at >= f * 1000 && at - f * 1000 <= WELCOME_WIN) e.wel = 1;
    }
    function fillRoute(e, node) {
      const op = node.outPath;
      if (op && Array.isArray(op.h)) { if (!op.h.length) e.rpt = e.rpt || 'direct'; else if (op.sz === 2 || op.sz === 3) e.rpt = String(op.h[op.h.length - 1]).toLowerCase(); }
      else if (node.hops === 0 && !e.rpt) e.rpt = 'direct';
      if (node.lat != null && node.lon != null && (node.lat || node.lon)) e.grid = grid(node.lat, node.lon, 4) || e.grid;
    }
    // Ham Contacts outreach (bus events via mesh.js): timestamps only -- adverts, cards and shares never score on their own
    function outreach(kind, info) {
      info = info || {};
      const p = P(), at = Number(info.at) || Date.now(), o = p.out;
      // who we already had (local only, S21); a scanned card's own key is left out: we added it just now, because of the card
      const skip = kind === 'card' && info.how === 'scan' ? lowKey(info.key) : '';
      const snap = () => { try { const ks = k.contactKeys ? k.contactKeys() : null; return ks ? { t: at, k: [...ks].map(x => lowKey(x)).filter(x => x && x !== skip).slice(0, 300).map(x => x.slice(0, 16)) } : null; } catch { return null; } };
      if (kind === 'card') { o.card.push(at); KN().card = snap(); saveKnown(); }
      else if (kind === 'advert') { const m = info.mode === 'flood' ? 'flood' : info.mode === 'local' ? 'local' : null; if (m) { o[m].push(at); KN().adv = snap(); saveKnown(); } }
      else if (kind === 'share') {   // Share Contact for ham A: only one you already have two-way contact with
        const key = lowKey(info.key); if (key && mu(p).some(e => e.key === key)) o.share[key] = at;
      }
      else if (kind === 'dirAdd') { const key = lowKey(info.key); if (key) o.dirAdds[key] = at; }
      else if (kind === 'listed' || kind === 'dir') {   // 'listed' {key, firstOf}: our own entry in a live verified list; 'dir' {mineListed, firstOf}
        if (kind === 'listed' || info.mineListed) p.stats.listed = 1;
        for (const [c, t] of Object.entries(info.firstOf || {})) { const call = normCall(c), v = Number(t); if (call && v > 0 && !(p.dirFirst[call] <= v)) p.dirFirst[call] = v; }
      }
      pruneP(p); checkBadges(); saveSoon();
    }
    // A golden packet (js/meshpaths.js): now only a Golden Handshake -- g = {key, num, km (already capped), how, name, ham}
    function golden(g) {
      if (!g || g.km == null) return;
      const p = P(), st = g.ham ? Object.assign({}, g.ham, { key: g.key }) : withKey(nodeOf(g.num, g.key), g.num);
      const c0 = eng.count('golden', st, g.how, { dry: true });
      if (!c0.counts || !c0.r.ham) return;
      if (g.key && PROOFS[g.how] && !p.mutual[c0.owner]) mutual({ key: g.key, num: g.num, name: g.name, type: 1, how: g.how, at: g.at });
      const c = eng.count('golden', st, g.how);
      p.stats.golds = (p.stats.golds || 0) + 1;
      if (p.mutual[c.owner]) p.stats.goldshake = 1;
      const hops = g.out && (g.out.h || g.out.nums) ? (g.out.h || g.out.nums).length : null;
      const first = !p.recs.gold;
      const isRec = setRec('gold', g.km, { who: g.name, hops, lat: g.them && g.them.lat, lon: g.them && g.them.lon, myLat: g.me && g.me.lat, myLon: g.me && g.me.lon, gold: g });
      const xp = first ? 100 : c.score ? 25 : 0;   // once per station per day
      addXp(xp, 'golden packet');
      if ((first || !isRec) && !quiet()) {   // a beaten record celebrates in setRec; the first ever and the rest here
        pop(`<span class="mq-pop-ic">🥇</span><div><small>${first ? 'YOUR FIRST GOLDEN PACKET!' : 'GOLDEN PACKET'}</small><b>${esc(g.name || c.owner)} · ${g.km.toFixed(1)} km two-way</b><span>a Golden Handshake${xp ? ` · +${xp} XP` : ' · already counted today'}</span></div>`, 'qso', 9000, () => k.showGolden && k.showGolden(g));
        play(first ? 'record' : 'badge'); confetti(first ? 160 : 70, first ? 2 : 0);
      }
      checkBadges(); saveSoon();
    }
    // any proven two-way exchange (js/meshpaths.js): the round-trip record, hams only
    function twoWay(g) {
      if (!g || !(g.rtt > 0) || g.rtt > 600000) return;
      const st = g.ham ? Object.assign({}, g.ham, { key: g.key }) : withKey(nodeOf(g.num, g.key), g.num);
      const c = eng.count('rtt', st, g.how, { dry: true }); if (!c.counts || !c.r.ham) return;
      setRec('rtt', g.rtt / 1000, { who: g.name, num: g.num, how: g.how }); saveSoon();
    }
    // the Golden Packet TOKEN (js/meshgold.js), once per hand-off the ledger accepted: t = {id, seq, fromName, km, snr, hops}
    function token(t) {
      const p = P(), first = !p.stats.tokens; p.stats.tokens = (p.stats.tokens || 0) + 1;
      if (t.km != null) setRec('tok', t.km, { who: t.fromName, hops: t.hops, snr: t.snr });
      if (first || t.newGiver !== false) addXp(first ? 60 : 30, 'Golden Packet token');   // meshgold.js fires this only once the ledger gave trophies; XP once per distinct giver
      if (!quiet()) {
        pop(`<span class="mq-pop-ic">🪙</span><div><small>${first ? 'YOU HOLD THE GOLDEN PACKET!' : 'GOLDEN PACKET TOKEN'}</small><b>Token #${t.id} from ${esc(t.fromName || '?')}</b><span>hand-off ${t.seq}${t.km != null ? ` · ${t.km.toFixed(1)} km` : ''} · pass it on · +${first ? 60 : 30} XP</span></div>`, 'qso', 9000,
          () => { k.showPage('mesh'); setTimeout(() => $('#mg-card') && $('#mg-card').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); });
        play(first ? 'record' : 'badge'); confetti(first ? 120 : 50, first ? 1 : 0);
      }
      checkBadges(); saveSoon();
    }
    function gave(x) { const p = P(); p.stats.tokGiven = (p.stats.tokGiven || 0) + 1; if (!x || x.newReceiver !== false) addXp(20, 'passed the Golden Packet on'); checkBadges(); saveSoon(); }   // XP once per distinct receiver
    // a status read from a repeater (js/meshrepeaters.js): x = {key, name, admin, sent, uptimeS, defaultPw}. It counts only
    // when it's YOUR repeater (listed under your callsign in the P25X directory, or marked yours) and the login didn't use
    // the stock default password. Its sent counter restarts at a reboot, so the running total adds each read's increase.
    let pwWarned = {};
    function ownRepeater(x) {
      const me = myCall(); if (!me) return false;
      const r = (k.hamOf ? k.hamOf({ key: x.key, longName: x.name || '', type: 2 }) : hamOf({ key: x.key, longName: x.name || '', type: 2 })) || NOT_HAM;
      return (r.src === 'dir' || r.src === 'mine') && (r.owner === me || r.call === me);
    }
    function repeater(x) {
      if (!x || !x.key) return;
      const p = P();
      if (x.admin) p.adminKeys[lowKey(x.key)] = Date.now();   // logged in as admin: in the self set, never a scoring station
      if (x.admin && x.defaultPw && !pwWarned[x.key] && !quiet()) {
        pwWarned[x.key] = 1;
        toast('🔑', `${x.name || 'This repeater'} still has the default admin password`, 'Change it first (anyone could take it over) -- Repeater Admin / Hero don\'t count it until you do', 'warn');
      }
      if (!x.admin || x.defaultPw || !ownRepeater(x)) { checkBadges(); saveSoon(); return; }
      p.stats.rptStatus = 1;
      if (x.sent >= 0) {
        const rp = p.rpts || (p.rpts = {}), r = rp[x.key] || (rp[x.key] = { total: 0, sent: null, up: null });
        r.total += r.sent == null || x.uptimeS < r.up || x.sent < r.sent ? x.sent : x.sent - r.sent;
        Object.assign(r, { sent: x.sent, up: x.uptimeS, name: x.name || r.name, at: Date.now() });
      }
      checkBadges(); saveSoon();
    }
    // a Drive mode ping closed (js/meshdrive.js): x = {heard: repeaters that repeated it}. XP capped per day like sending.
    function drive(x) {
      const p = P(), d = dayKey();
      p.stats.drivePings = (p.stats.drivePings || 0) + 1;
      if (x && x.heard > 0) {
        p.stats.driveHeard = (p.stats.driveHeard || 0) + 1;
        if (!p.driveXp || p.driveXp.day !== d) p.driveXp = { day: d, n: 0 };
        if (p.driveXp.n < SEND_XP_DAY) { p.driveXp.n++; addXp(2); }
      }
      checkBadges(); saveSoon();
    }
    // CQ Hunter: mesh.js calls this ONLY after the answer was actually sent. a = {call, verified, at}. Credited at once
    // when the gateway's P25-verified Mesh callers list vouches for the call, else once that call gives a Handshake in 24 h.
    function answered(a) {
      if (!a || typeof a !== 'object') return;   // the old answered(num) on a click (B2): nothing
      const p = P(), call = normCall(a.call), at = Number(a.at) || Date.now();
      if (!call || call === myCall()) return;
      if (a.verified) {
        const RPT = /^VK\dR[A-Z]{2}$/, H = HCx(), infra = RPT.test(call) || !!(H && (H.CLUB_CALLS || []).includes(call));
        creditCq(Object.freeze({ ham: !infra, tier: 'verified', call, owner: call, cls: infra ? 'infra' : 'station', self: false, src: 'p25', why: `${call} on the gateway's P25-checked callers list`, demo: isDemo() }), call);
      } else {
        p.cqPend[call] = at;   // credited by mutual() if this call makes two-way contact within a day
      }
      pruneP(p); checkBadges(); saveSoon();
    }
    function creditCq(r, call) {
      if (!fresh('cq', call)) return;
      const c = eng.count('cq', r, 'answer'); if (!c.counts) return;
      const p = P(); p.stats.answered = (p.stats.answered || 0) + 1;
      mission('answer'); if (c.score) addXp(10, 'answered a call');
    }
    function online() {
      const p = P(); p.devs[k.devLabel()] = 1; sessionAt = Date.now(); today(); activity(); checkBadges(); saveSoon();
      if (!quiet() && p.mis.list.some(m => !m.done)) setTimeout(() => pop(`<span class="mq-pop-ic">🎮</span><div><small>MESH QUEST</small><b>${p.mis.list.filter(m => !m.done).length} mission${p.mis.list.filter(m => !m.done).length === 1 ? '' : 's'} waiting today</b><span>${esc(LEVELS[lvOf(p.xp)][1])} · ${p.xp} XP${p.streak.n > 1 ? ` · 🔥 ${p.streak.n}-day streak` : ''}</span></div>`, 'hello', 6000, () => { setTab('missions'); $('#mq-card') && $('#mq-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); }), 2500);
    }
    function pos() { P().stats.pos = (P().stats.pos || 0) + 1; mission('pos'); saveSoon(); }
    function gw() { P().stats.gw = 1; checkBadges(); saveSoon(); }
    setInterval(() => { if (sessionAt && k.online() && Date.now() - sessionAt > 2 * 3600000 && !P().stats.marathon) { P().stats.marathon = 1; checkBadges(); saveSoon(); } if (!k.online()) sessionAt = 0; }, 60000);
    // the self set (the engine's): mesh.js calls connected(myKey) whenever its own node's key is known
    function connected(key) { if (!key) return; eng.connected(key); try { window.KellyHamCalls && window.KellyHamCalls.bump && window.KellyHamCalls.bump(); } catch { /* */ } saveSoon(); }
    function notMine(key) { if (!key) return; eng.notMine(key); try { window.KellyHamCalls && window.KellyHamCalls.bump && window.KellyHamCalls.bump(); } catch { /* */ } dirty('mesh'); saveSoon(); }

    // ---------------------------------------------------------------- club leaderboard over P25 packet data (season 2)
    function scores() {
      const p = P();
      return { op: 'meshboard', v: 2, call: (settings.myCall || '').toUpperCase().slice(0, 12), xp: p.xp, lv: lvOf(p.xp), cxp: p.classicXp || 0,
        dx: Math.round(rec(p, 'dx') * 10), dxa: Math.round(rec(p, 'dxa') * 10), hops: rec(p, 'hops'), hams: hamCount(p), shakes: cnt(p.mutual),
        grids: cnt(p.grids), b: cnt(p.badges), st: p.streak.best, day: rec(p, 'day'), gold: Math.round(rec(p, 'gold') * 10), tok: p.stats.tokens || 0 };
    }
    async function askBoard() {
      if (isDemo()) { toast('🎮', 'Demo scores stay on this PC', 'Connect a real node to play for the club leaderboard', 'bad'); return; }
      if (!(settings.myCall || '').trim()) { toast('🥇', 'Kelly needs your callsign first', 'Admin › your callsign -- the leaderboard is by call', 'bad'); return; }
      const xid = await k.kfRequest(scores(), 'sending your Mesh Quest scores to the club leaderboard');
      boardAsk = xid ? { xid, at: Date.now() } : null; dirty('mesh');
    }
    function kfEvent(e) {
      if (!boardAsk) return;
      if (e.kind === 'tx-done') boardAsk.delivered = Date.now();
      else if (e.kind === 'tx-failed') { boardAsk = null; if (!e.cancelled) toast('🥇', 'No answer from the P25X gateway', '', 'bad'); }
      dirty('mesh');
    }
    function boardReply(j) {
      boardAsk = null;
      const you = j && j.you ? normCall(j.you) : null;
      if (you && settings.gwCall !== you) {   // the gateway's own callsign for this radio: it's "me" for the ham test
        settings.gwCall = you; try { k.save && k.save(); } catch { /* */ }
        try { window.KellyHamCalls && window.KellyHamCalls.bump && window.KellyHamCalls.bump(); } catch { /* */ }
      }
      if (j.error) { toast('🥇', 'Club leaderboard', j.error, 'bad'); dirty('mesh'); return; }
      const p = real; p.board = { at: j.at || Date.now(), got: Date.now(), v: j.v || 1, season: j.season || null, you, rank: j.rank, of: j.of, rows: j.rows || [], club: j.club || {}, newClub: j.newClub || [] };
      p.stats.board = 1; checkBadges();
      const nc = p.board.newClub;
      if (nc.length && !quiet()) {
        const names = { dx: 'longest direct contact', dxa: 'longest over the mesh', hops: 'most hops', hams: 'most hams heard', shakes: 'most Handshakes', grids: 'most grid squares', xp: 'most XP', gold: 'longest golden packet', tok: 'most Golden Packet tokens held' };
        celebrate({ kind: 'club', title: 'CLUB RECORD!', big: `🥇 ${esc(you || (settings.myCall || '').toUpperCase())}`, sub: `You now hold the club record for ${nc.map(x => names[x] || x).join(', ')} -- every Kelly on the P25X network will see it.` });
      } else {
        toast('🥇', `Club leaderboard: you're #${j.rank} of ${j.of}`, `${p.board.rows.length} on the board`, 'good', () => { k.showPage('mesh'); setTab('board'); });
        if (j.rank && j.rank <= 3 && !quiet()) { play('badge'); confetti(90); }
      }
      addEvent('network', `Mesh Quest club leaderboard: #${j.rank} of ${j.of}`);
      setTab('board'); saveSoon(); dirty('mesh');
    }

    // ---------------------------------------------------------------- FX: pop-ups, confetti, celebrations
    function pop(html, cls, ms_ = 6000, onclick) {
      let host = $('#mq-pops'); if (!host) { host = document.createElement('div'); host.id = 'mq-pops'; document.body.appendChild(host); }
      const el = document.createElement('div'); el.className = `mq-pop ${cls}`; el.innerHTML = `<i class="mq-shine"></i>${html}`;
      el.onclick = () => { if (onclick) onclick(); else { k.showPage('mesh'); setTimeout(() => $('#mq-card') && $('#mq-card').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); } el.classList.add('out'); setTimeout(() => el.remove(), 400); };
      host.appendChild(el); while (host.children.length > 3) host.firstChild.remove();
      setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms_);
    }
    let confRaf = 0;
    const parts = [];
    function confetti(n = 120, bursts = 0) {
      if (!fxOn()) return;
      let cv = $('#mq-confetti');
      if (!cv) { cv = document.createElement('canvas'); cv.id = 'mq-confetti'; document.body.appendChild(cv); }
      if (!confRaf) { cv.width = innerWidth; cv.height = innerHeight; }
      const W = cv.width, H = cv.height, g = cv.getContext('2d');
      const cols = ['#39ff88', '#00e5ff', '#ff2bd6', '#ffb020', '#ffd166', '#a78bfa', '#ffffff'];
      for (let i = 0; i < n; i++) parts.push({ x: W * (0.2 + Math.random() * 0.6), y: H * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 15 - 4,
        r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4, s: 5 + Math.random() * 6, c: cols[Math.floor(Math.random() * cols.length)], life: 1, shape: Math.random() < 0.3 ? 'o' : 'r' });
      for (let b = 0; b < bursts; b++) {   // fireworks: rings of sparks
        const bx = W * (0.15 + Math.random() * 0.7), by = H * (0.15 + Math.random() * 0.3), c = cols[b % cols.length], delay = b * 18;
        for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2, v = 5 + Math.random() * 3; parts.push({ x: bx, y: by, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 0, vr: 0, s: 3, c, life: 1, shape: 'spark', wait: delay }); }
      }
      if (confRaf) return;
      const step = () => {
        g.clearRect(0, 0, W, H);
        for (const q of parts) {
          if (q.wait > 0) { q.wait--; continue; }
          q.x += q.vx; q.y += q.vy; q.vy += q.shape === 'spark' ? 0.12 : 0.35; q.vx *= 0.985; q.r += q.vr; q.life -= q.shape === 'spark' ? 0.014 : 0.006;
          g.globalAlpha = Math.max(0, Math.min(1, q.life * 1.6)); g.fillStyle = q.c;
          if (q.shape === 'spark') { g.shadowBlur = 10; g.shadowColor = q.c; g.beginPath(); g.arc(q.x, q.y, q.s * q.life + 0.5, 0, 7); g.fill(); g.shadowBlur = 0; }
          else { g.save(); g.translate(q.x, q.y); g.rotate(q.r); if (q.shape === 'o') { g.beginPath(); g.arc(0, 0, q.s / 2.4, 0, 7); g.fill(); } else g.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2); g.restore(); }
        }
        const keep = parts.filter(q => q.life > 0 && q.y < H + 30);
        parts.length = 0; parts.push(...keep);
        if (parts.length) confRaf = requestAnimationFrame(step); else { confRaf = 0; g.clearRect(0, 0, W, H); }
      };
      confRaf = requestAnimationFrame(step);
    }
    const queue = []; let showing = false;
    function celebrate(c) { queue.push(c); if (!showing) nextCelebration(); }
    function nextCelebration() {
      const c = queue.shift(); if (!c) { showing = false; return; }
      showing = true;
      play(c.kind === 'club' ? 'club' : c.kind === 'record' ? 'record' : 'level');
      if (!fxOn()) {   // no flashing: a plain toast says the same thing
        toast(c.kind === 'level' ? '⬆️' : '🏆', c.title, c.to != null ? `${c.label}: ${c.fmt(c.to)} ${c.unit}` : c.big.replace(/<[^>]+>/g, ''), 'good', () => k.showPage('mesh'));
        setTimeout(nextCelebration, 1500); return;
      }
      const el = document.createElement('div'); el.className = `mq-over ${c.kind}`;
      el.innerHTML = `<div class="mq-rays"></div><div class="mq-ccard"><small>${esc(c.title)}</small>${c.label ? `<em>${esc(c.label)}</em>` : ''}`
        + `<b class="mq-big">${c.to != null ? `<span data-count>${c.fmt(c.from)}</span> <i>${esc(c.unit)}</i>` : c.big}</b><p>${c.sub || ''}</p>`
        + `<div class="row gap" style="justify-content:center">${c.dx ? '<button class="btn primary small" data-dx>🗺️ Show it on the map</button>' : ''}<button class="btn ghost small" data-ok>Awesome!</button></div></div>`;
      document.body.appendChild(el);
      confetti(c.kind === 'level' ? 140 : 180, c.kind === 'level' ? 2 : c.kind === 'club' ? 7 : 4);
      if (c.to != null) {   // count up from the old record to the new one
        const span = el.querySelector('[data-count]'), t0 = performance.now(), D = 1400;
        const run = now => { const f = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - f, 3); span.textContent = c.fmt(c.from + (c.to - c.from) * e); if (f < 1) requestAnimationFrame(run); else span.parentElement.classList.add('done'); };
        requestAnimationFrame(run);
      }
      let gone = false;
      const close = () => { if (gone) return; gone = true; el.classList.add('out'); setTimeout(() => { el.remove(); nextCelebration(); }, 450); };
      el.onclick = e => { const dx = e.target.closest('[data-dx]'); if (dx && c.dx) { k.showPage('mesh'); setTimeout(() => c.dx.gold && k.showGolden ? k.showGolden(c.dx.gold) : k.showDx(c.dx), 200); } close(); };
      setTimeout(close, c.kind === 'club' ? 9000 : 6500);
    }

    // ---------------------------------------------------------------- render
    function setTab(t) { tab = t; store.set('meshQuestTab', t); if (t === 'trophies') { const p = P(); for (const id of Object.keys(p.badges)) p.seenBadges[id] = 1; saveSoon(); } dirty('mesh'); }
    const fmtDate = t => t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '';
    let lastSig = '', shownTab = null, calmT = 0;
    function render() {
      const card = $('#mq-card'); if (!card) return;
      card.hidden = !ms.quest; if (!ms.quest) return;
      const p = P(), d = today(), lv = lvOf(p.xp), L0 = LEVELS[lv], L1 = LEVELS[lv + 1], demo = isDemo();
      const frac = L1 ? (p.xp - L0[0]) / (L1[0] - L0[0]) : 1;
      // the quick buttons blink while a mission wants them
      const open = new Set(p.mis.list.filter(m => !m.done).map(m => (missionDef(m.id) || {}).hot).filter(Boolean));
      $$('[data-mesh-quick]').forEach(b => { const q = b.dataset.meshQuick; b.classList.toggle('mq-hot', open.has('pos') && q === 'pos'); });
      const unseen = Object.keys(p.badges).filter(id => !p.seenBadges[id]).length;
      const boardStale = !p.board || Date.now() - p.board.got > 86400000;
      const sig = [demo, p.xp, cnt(p.badges), unseen, JSON.stringify(p.mis.list), tab, p.board && p.board.got, cnt(p.log), cnt(p.grids), JSON.stringify(p.recs), p.streak.n, boardAsk && (boardAsk.delivered || 1), d.hams.length, (k.myPos() || {}).lat, cnt(p.mutual), hamCount(p), p.classicXp].join('|');
      if (sig === lastSig) return; lastSig = sig;
      const me = k.myPos(), myGrid = me ? grid(me.lat, me.lon, 6) : '';
      $('#mq-lv').innerHTML = `<span class="mq-hex lv${lv}">${L0[2]}</span><div><small>LEVEL ${lv + 1}${demo ? ' · DEMO, NOT KEPT' : ' · SEASON 2'}</small><b>${esc(L0[1])}</b></div>`;
      $('#mq-xpfill').style.width = `${Math.round(frac * 100)}%`;
      $('#mq-xptxt').textContent = (L1 ? `${p.xp} XP · ${L1[0] - p.xp} to ${L1[1]}` : `${p.xp} XP · top level!`) + (p.classicXp ? ` · ${p.classicXp} classic XP` : '');
      $('#mq-chips').innerHTML = [
        ['🔥', p.streak.n || 0, 'day streak', p.streak.n > 1 ? 'hot' : ''],
        ['🤝', cnt(p.mutual), 'Handshakes', ''],
        ['🔲', myGrid || '—', 'your grid', ''],
        ['🎖️', `${cnt(p.badges)}/${BADGES.length}`, 'trophies', unseen ? 'new' : ''],
        ['🎯', `${p.mis.list.filter(m => m.done).length}/${p.mis.list.length}`, 'missions', ''],
      ].map(([ic, v, l, c]) => `<div class="mq-chip ${c}"><span>${ic}</span><b>${esc(String(v))}</b><small>${l}</small></div>`).join('');
      $$('#mq-tabs button').forEach(b => {
        b.classList.toggle('on', b.dataset.mq === tab);
        b.classList.toggle('mq-hot', (b.dataset.mq === 'trophies' && unseen > 0) || (b.dataset.mq === 'board' && boardStale && !demo) || (b.dataset.mq === 'missions' && p.mis.list.some(m => !m.done) && tab !== 'missions'));
      });
      const body = $('#mq-body');
      // the card re-draws on nearly every packet heard: only a tab just opened gets its entrance, re-draws stay still
      // (replaying every slide-in / sparkle on each packet was a constant flicker -- 2026-10-17)
      const opened = tab !== shownTab; shownTab = tab;
      card.classList.toggle('mq-calm', !opened);
      if (opened) { clearTimeout(calmT); calmT = setTimeout(() => card.classList.add('mq-calm'), 1600); }
      if (tab === 'missions') body.innerHTML = renderMissions(p);
      else if (tab === 'records') body.innerHTML = renderRecords(p);
      else if (tab === 'trophies') body.innerHTML = renderTrophies(p);
      else if (tab === 'board') body.innerHTML = renderBoard(p);
      else body.innerHTML = renderLog(p);
    }
    function renderMissions(p) {
      const left = (() => { const t = new Date(); t.setHours(24, 0, 0, 0); const m = Math.round((t - Date.now()) / 60000); return `${Math.floor(m / 60)} h ${m % 60} min`; })();
      return `<div class="mq-missions">${p.mis.list.map((m, i) => {
        const def = missionDef(m.id) || { ic: '?', t: () => m.id }, f = Math.min(1, m.v / m.goal);
        return `<div class="mq-mission${m.done ? ' done' : ''}" style="animation-delay:${i * 0.08}s"><span class="mq-mic">${def.ic}</span><div class="grow"><b>${esc(def.t(m.goal))}</b>`
          + `<div class="mq-prog"><i style="width:${Math.round(f * 100)}%"></i></div><small>${def.max ? `${m.v ? (m.v % 1 ? m.v.toFixed(1) : m.v) : 0} / ${m.goal}` : `${Math.min(m.v, m.goal)} / ${m.goal}`} · +40 XP</small></div>`
          + `${m.done ? '<span class="mq-stamp">DONE</span>' : ''}</div>`;
      }).join('')}</div><p class="small dim">New missions in ${left}. Finish all three for a +60 XP bonus. Everyone in the club gets the same three missions each day. `
        + `Only licensed hams count -- not repeaters, rooms or sensors, and never your own nodes. Sending earns XP for your first ${SEND_XP_DAY} messages a day: the mesh is shared airtime, so be kind to it.</p>`;
    }
    function renderRecords(p) {
      const tiles = Object.entries(REC_META).map(([key, m], i) => {
        const r = p.recs[key], fresh_ = r && Date.now() - r.at < 86400000;
        return `<div class="mq-rec${r && r.lat != null ? ' map' : ''}${fresh_ ? ' fresh' : ''}" data-rec="${key}" style="animation-delay:${i * 0.06}s">${fresh_ ? '<em class="mq-new">NEW</em>' : ''}${m.ct ? '<em class="mq-tag ct">needs contacts</em>' : ''}<span>${m.ic}</span><small>${esc(m.name)}</small>`
          + `<b>${r ? esc(m.fmt(r.v)) : '—'} <i>${r ? esc(m.unit) : ''}</i></b><p>${r ? [r.who ? esc(r.who) : '', r.hops != null && key !== 'hops' ? (r.hops === 0 ? 'direct' : r.hops + ' hops') : '', r.snr != null && key !== 'deep' ? `${r.snr.toFixed(1)} dB` : '', fmtDate(r.at), r.dev ? esc(r.dev) : ''].filter(Boolean).join(' · ') : 'not set yet'}</p>${r && r.lat != null ? '<u>🗺️ show on map</u>' : ''}</div>`;
      });
      const more = [['🤝', 'Handshakes', cnt(p.mutual)], ['🗨️', 'Hams worked (QSO)', cnt(ever(p, 'qso'))], ['🔲', 'Grid squares', cnt(p.grids)], ['📻', 'Hams heard', hamCount(p)], ['🕸️', 'Nodes in your log', cnt(p.log)], ['🔥', 'Best streak', `${p.streak.best} d`], ['📤', 'Messages sent', p.stats.sent]]
        .concat(p.classicXp ? [['🏛️', 'Classic XP (season 1)', p.classicXp]] : [])
        .map(([ic, l, v]) => `<div class="mq-mini"><span>${ic}</span><b>${esc(String(v))}</b><small>${l}</small></div>`).join('');
      const cr = Object.entries(p.classicRecs || {}).filter(([key, r]) => r && r.v != null && OLD_REC_META[key]).map(([key, r]) => { const m = OLD_REC_META[key]; return `<div class="mq-mini mq-classic"><span>${m[0]}</span><b>${esc(Number(r.v).toFixed(1))} ${esc(m[2])}</b><small>${esc(m[1])} · classic</small></div>`; }).join('');
      return `<div class="mq-recs">${tiles.join('')}</div><div class="mq-minis">${more}</div>`
        + (cr ? `<h3 class="mq-h3">🏛️ Classic records (season 1)</h3><div class="mq-minis">${cr}</div><p class="small dim">Season 1 records could come from repeaters or your own nodes, so they're kept here as classics and aren't on the club board.</p>` : '')
        + `<p class="small dim">Direct = heard with no hops (your node to theirs, nothing in between). Distances count hams only and need both positions: set yours in GPS › Fixed position. A distance is capped by the path (40 km a hop when its repeaters' positions aren't known). Only live traffic counts -- not nodes loaded from your node's memory, and not nodes relayed over MQTT.</p>`;
    }
    function renderTrophies(p) {
      const item = (b, got, pr, i, extra) => {
        const f = Math.min(1, pr[0] / pr[1]), tag = b.inf ? '<em class="mq-tag inf">infrastructure</em>' : '';
        return `<div class="mq-trophy${got ? ' got' : ''}${got && Date.now() - got < 86400000 ? ' fresh' : ''}" style="animation-delay:${Math.min(i, 20) * 0.03}s" title="${esc(b.desc)}">${tag}<span>${got ? b.ic : '🔒'}</span><b>${esc(b.name)}</b><small>${esc(b.desc)}</small>`
          + (got ? `<em>${fmtDate(got)} · +${b.xp} XP</em>` : `<div class="mq-prog"><i style="width:${Math.round(f * 100)}%"></i></div><em>${Math.floor(Math.min(pr[0], pr[1]) * 10) / 10} / ${pr[1]}</em>`) + (extra || '') + '</div>';
      };
      const group = list => list.map(b => ({ b, got: p.badges[b.id], pr: b.prog(p) })).sort((x, y) => (y.got ? 1 : 0) - (x.got ? 1 : 0) || (y.pr[0] / y.pr[1]) - (x.pr[0] / x.pr[1]));
      const main = group(BADGES.filter(b => !b.ct)), ct = group(BADGES.filter(b => b.ct));
      const classic = Object.entries(p.classic || {}).filter(([id, t]) => t && (CLASSIC_META[id] || BADGE[id]));
      const rt = p.recs.rtt, rttTile = `<div class="mq-trophy${rt ? ' got' : ''}" title="A record, not a trophy: your fastest proven two-way exchange with a ham"><span>${rt ? '⚡' : '🔒'}</span><b>Fastest round trip</b><small>Record: your fastest two-way exchange with a ham (an ACK, path return or discovery)</small><em>${rt ? `${rt.v.toFixed(1)} s · ${esc(rt.who || '')}` : 'not set yet'}</em></div>`;
      return `<div class="mq-trophies">${main.map((x, i) => item(x.b, x.got, x.pr, i)).join('')}`
        + `<h3 class="mq-th">🤝 Needs contacts <small>-- two-way contact with hams: you each have the other on your radio</small></h3>`
        + ct.map((x, i) => item(x.b, x.got, x.pr, i)).join('') + rttTile
        + (classic.length ? `<h3 class="mq-th">🏛️ Classic <small>-- season 1 trophies, kept for good; the new rules earn them again</small></h3>`
          + classic.map(([id, t], i) => { const m = CLASSIC_META[id] || [BADGE[id].ic, BADGE[id].name, BADGE[id].desc]; return `<div class="mq-trophy got mq-classic" style="animation-delay:${Math.min(i, 20) * 0.03}s" title="${esc(m[2])}"><em class="mq-tag classic">classic</em><span>${m[0]}</span><b>${esc(m[1])}</b><small>${esc(m[2])}</small><em>${fmtDate(t)}</em></div>`; }).join('') : '')
        + '</div>';
    }
    function renderBoard(p) {
      const b = real.board, mine = (settings.myCall || '').toUpperCase(), gwc = settings.gwCall || '', demo = isDemo();
      const btn = `<button class="btn primary${!b || Date.now() - b.got > 86400000 ? ' mq-hot' : ''}" id="mq-board-go" ${boardAsk || demo ? 'disabled' : ''}>${boardAsk ? (boardAsk.delivered ? '📡 Gateway answering…' : '📡 Sending…') : '📡 Send my scores &amp; get the leaderboard (via P25)'}</button>`;
      const head = `<p class="small dim">Season 2. Your scores go to the P25X gateway over P25 packet data (about 200 bytes) and the club leaderboard comes back the same way. No internet needed: it's all on the club's radios. Rows are by the callsign the gateway knows for your radio${gwc ? ` (<b>${esc(gwc)}</b>)` : mine ? ` (you've set <b>${esc(mine)}</b>)` : ' -- set yours in Admin first'}. XP is on trust (each Kelly reports its own) and Handshakes are claimed, not checked with the other ham.${demo ? ' <b>Demo scores never go to the board.</b>' : ''}</p><div class="row gap wrap">${btn}${b ? `<span class="small dim">Updated ${k.fmtAgo(b.got)}${b.rank ? ` · you're #${b.rank} of ${b.of}` : ''}</span>` : ''}</div>`;
      if (!b) return head + '<div class="mq-empty">🥇<p>No season 2 leaderboard yet -- send your scores to see where you stand.</p></div>';
      const me = b.you || gwc || mine;
      const rows = b.rows.map(r => Array.isArray(r) ? { call: r[0], xp: r[1], dx: r[2], nodes: r[3], grids: r[4], b: r[5], lv: r[6] } : r)
        .map(r => ({ call: String(r.call || ''), xp: +r.xp || 0, lv: +r.lv || 0, cxp: +r.cxp || 0, dx: (+r.dx || 0) / 10, hams: r.hams != null ? +r.hams : null, shakes: r.shakes != null ? +r.shakes : null, grids: +r.grids || 0, b: +r.b || 0 }));
      const podium = [1, 0, 2].map(i => rows[i] ? `<div class="mq-pod p${i + 1}${rows[i].call === me ? ' me' : ''}"><span>${['🥇', '🥈', '🥉'][i]}</span><b>${esc(rows[i].call)}</b><small>${rows[i].xp} XP · ${esc((LEVELS[rows[i].lv] || LEVELS[0])[1])}</small><i></i></div>` : '<div class="mq-pod empty"></div>').join('');
      const club = b.club || {}, cr = (key, label, f) => club[key] ? `<div class="mq-mini${club[key][0] === me ? ' me' : ''}"><span>${label}</span><b>${esc(f(club[key][1]))}</b><small>${esc(club[key][0])}</small></div>` : '';
      return head + `<div class="mq-podium">${podium}</div>`
        + `<table class="mq-table"><thead><tr><th>#</th><th>Call</th><th>Level</th><th title="each Kelly reports its own">XP (on trust)</th><th>Hams heard</th><th title="not checked with the other ham">Handshakes (claimed)</th><th>Best DX</th><th>Grids</th><th>🎖️</th><th title="season 1 XP, never ranked">Classic XP</th></tr></thead><tbody>`
        + rows.map((r, i) => `<tr class="${r.call === me ? 'me' : ''}" style="animation-delay:${i * 0.05}s"><td>${i + 1}</td><td><b>${esc(r.call)}</b></td><td>${(LEVELS[r.lv] || LEVELS[0])[2]} ${esc((LEVELS[r.lv] || LEVELS[0])[1])}</td><td>${r.xp}</td><td>${r.hams ?? '—'}</td><td>${r.shakes ?? '—'}</td><td>${r.dx ? `${r.dx.toFixed(1)} km` : '—'}</td><td>${r.grids}</td><td>${r.b}</td><td class="dim">${r.cxp || ''}</td></tr>`).join('')
        + '</tbody></table><h3 class="mq-h3">🏛️ Club records (season 2)</h3><div class="mq-minis">'
        + cr('dx', '🏆 Direct DX', v => `${(v / 10).toFixed(1)} km`) + cr('dxa', '🛰️ Mesh DX', v => `${(v / 10).toFixed(1)} km`) + cr('hops', '🔁 Hops', v => String(v))
        + cr('hams', '📻 Hams heard', v => String(v)) + cr('shakes', '🤝 Handshakes', v => String(v)) + cr('grids', '🔲 Grids', v => String(v))
        + cr('gold', '🥇 Golden packet', v => `${(v / 10).toFixed(1)} km`) + cr('tok', '🪙 Tokens held', v => String(v)) + '</div>';
    }
    function renderLog(p) {
      const rows = Object.entries(p.log).sort((a, b) => (b[1].last || 0) - (a[1].last || 0)).slice(0, 150);
      return `<div class="row gap wrap" style="justify-content:space-between"><span class="small dim">${cnt(p.log)} node${cnt(p.log) === 1 ? '' : 's'} heard live · ${hamCount(p)} ham${hamCount(p) === 1 ? '' : 's'} · ${cnt(p.mutual)} Handshake${cnt(p.mutual) === 1 ? '' : 's'} · ${cnt(p.grids)} grid square${cnt(p.grids) === 1 ? '' : 's'}</span><button class="btn ghost small" id="mq-csv" ${rows.length ? '' : 'disabled'}>⬇ Export CSV</button></div>`
        + (rows.length ? `<div class="mq-logwrap"><table class="mq-table"><thead><tr><th>Node</th><th>Grid</th><th>Best km</th><th>Hops</th><th>Best SNR</th><th>Msgs</th><th>QSOs</th><th>First</th><th>Last</th></tr></thead><tbody>`
          + rows.map(([num, l]) => `<tr data-lnode="${num}"><td><b>${esc(l.name || num)}</b>${l.ham ? ' <span class="mesh-ham">HAM</span>' : ''}${l.self ? ' <span class="mq-tag">yours</span>' : ''}${l.call && p.mutual[l.call] ? ' <span title="two-way contact">🤝</span>' : ''}</td><td>${esc(l.grid || '')}</td><td>${l.km != null ? `${l.km.toFixed(1)}${l.brg ? ` ${l.brg}` : ''}` : ''}</td><td>${l.hops == null ? '' : l.hops === 0 ? 'direct' : l.hops}</td><td>${l.snr != null ? l.snr.toFixed(1) : ''}</td><td>${l.msgs || ''}</td><td>${l.qso || ''}</td><td>${fmtDate(l.first)}</td><td>${l.last ? k.fmtAgo(l.last) : ''}</td></tr>`).join('')
          + '</tbody></table></div>' : '<div class="mq-empty">📒<p>Your mesh log fills up as your node hears other nodes.</p></div>');
    }
    function csv() {
      const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`, p = P();
      const callIn = s => { const m = /\b([A-Z]{1,2}\d[A-Z]{1,4})\b/i.exec(s || ''); return m ? m[1].toUpperCase() : ''; };
      const lines = [['node_id', 'name', 'callsign', 'p25_radio', 'licensed', 'two_way', 'grid', 'best_km', 'bearing', 'min_hops', 'best_snr', 'messages', 'qsos', 'first_heard', 'last_heard', 'device'].join(',')]
        .concat(Object.entries(p.log).map(([num, l]) => { const c = l.call || callIn(l.name); return [num, q(l.name), c, (c && k.p25Of && (k.p25Of(l.name) || {}).id) || '', l.ham ? 1 : 0, c && p.mutual[c] ? 1 : 0, l.grid || '', l.km != null ? l.km.toFixed(2) : '', l.brg || '', l.hops ?? '', l.snr ?? '', l.msgs || 0, l.qso || 0,
          l.first ? new Date(l.first).toISOString() : '', l.last ? new Date(l.last).toISOString() : '', q(l.dev)].join(','); }));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
      a.download = `kelly-mesh-log-${(settings.myCall || 'kelly').toUpperCase()}-${dayKey()}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    function init() {
      $('#mq-tabs').onclick = e => { const b = e.target.closest('[data-mq]'); if (b) setTab(b.dataset.mq); };
      $('#mq-body').onclick = e => {
        if (e.target.closest('#mq-board-go')) return askBoard();
        if (e.target.closest('#mq-csv')) return csv();
        const r = e.target.closest('[data-rec]'); if (r) { const x = P().recs[r.dataset.rec]; if (x && x.gold && k.showGolden) k.showGolden(x.gold); else if (x && x.lat != null) k.showDx(x); return; }
        const ln = e.target.closest('[data-lnode]'); if (ln) k.focusNode(+ln.dataset.lnode);
      };
      $('#mq-lv').onclick = () => { if (fxOn()) { confetti(50); play('mission'); } };   // a little toy
      const q = $('#ms-quest'); if (q) { q.checked = !!ms.quest; q.onchange = () => { ms.quest = q.checked; k.save(); lastSig = ''; dirty('mesh'); }; }
    }

    return { heard, text, sent, ack, trace, bridge, answered, online, pos, gw, golden, twoWay, token, gave, repeater, drive, boardReply, kfEvent, ownsXid: xid => !!(boardAsk && boardAsk.xid === xid), render, init,
      mutual, outreach, connected, notMine, isSelf: key => eng.isSelf(key), selfKeys: () => eng.selfKeys(), hamOf, creditKm: (key, km, hops, chainKm) => eng.creditKm(key, km, hops, chainKm), engine: eng,
      grid, cardinal, play, profile: P, scores, askBoard, isDemo };
  };
  window.KellyMeshFun.grid = grid;
  window.KellyMeshFun.cardinal = cardinal;
  window.KellyMeshFun.migrate = migrate;
  window.KellyMeshFun.BADGES = BADGES;
  window.KellyMeshFun.MISSIONS = MISSIONS;
})();
