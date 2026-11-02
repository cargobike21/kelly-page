/* Kelly Page -- LoRa Mesh > 🔭 Trace Route > 📊 Telemetry polling: the pure part (2026-10-25, unreleased). No DOM, no
 * storage, no radio: the grant messages, the grant state machine and the poll schedule. js/tr-telem.js runs it.
 *
 * Who enforces what (MeshCore companion firmware, examples/companion_radio/MyMesh.cpp onContactRequest, main 2026-10-15):
 *   the DEVICE  answers a telemetry request only from a contact (the request is sealed with the pair's shared secret),
 *               and with base mode 1 only from a contact whose flag 0x02 is set (mode 2 = every contact, 0 = nobody).
 *               So "who can poll my telemetry" is really the flag on our own node: approving sets it, revoking clears
 *               it, and it holds whether or not Kelly is running. Kelly also sets base mode 1 when a grant is made.
 *   the APP     the request / approve / decline / revoke handshake, "who I can poll", never sending a poll without a
 *               grant, the interval and the airtime budget. None of that exists in the firmware.
 * Base telemetry only (2026-10-25): battery voltage + the MCU's temperature where the board has one.
 *
 * The messages: CLI-data DMs (txt_type 1) between the two Kellys -- encrypted with the pair's own keys (no new crypto),
 * kept out of the chat, and NOT ACKed by the firmware, so every message but ACK gets an ACK from the other Kelly:
 *   KT1 REQ  <id> <sender fp> <receiver fp> <offer 0|1>   may I poll your telemetry? (offer 1: you may poll mine, already set)
 *   KT1 OK   <id> <sender fp> <receiver fp>               yes: my node now answers you (id = the REQ's)
 *   KT1 NO   <id>                                         no (id = the REQ's)
 *   KT1 REV  <id>                                         I've taken back your access to my telemetry -- stop polling me
 *   KT1 DROP <id>                                         I no longer poll you -- clear my flag (or withdraw my request)
 *   KT1 ACK  <id>                                         got that message
 * fp = the first 16 hex of a public key. REQ and OK carry both, so each side confirms the key it holds for the other and
 * that the other holds its own: the DM decrypting already proves the pair's keys match, this pins which keys they are.
 * NO / REV / DROP only ever narrow access, so they need no fingerprints.
 *
 * Grant (one per peer key): { key, name, out, in, outId, inReq: { id, offer, at } | null, offered (our REQ offered ours),
 *   theyOffered (their REQ offered theirs), mutual (a verified message from them: each holds the other's key), at }
 *   out  'none' | 'asking' | 'granted' | 'declined'    may WE poll THEM
 *   in   'none' | 'pending' | 'granted'                may THEY poll US (granted = our node's flag 0x02 is set for them)
 * reduce(grant, event) -> { grant, effects: [{ do: 'flag', on } | { do: 'mode' } | { do: 'send', op, id, offer? }
 *   | { do: 'stop' } | { do: 'note', icon, title, text, kind }] } -- tr-telem.js carries the effects out.
 *
 * window.KellyTRGrants (UMD) = { PREFIX, OPS, fp, newId, encode, parse, verify, blank, reduce, summary, battPct, INTERVALS,
 *   DEFAULT_MIN, MIN_MIN, HIST_CAP, due, pushHist, health }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KellyTRGrants = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PREFIX = 'KT1', OPS = ['REQ', 'OK', 'NO', 'REV', 'DROP', 'ACK'];
  const fp = key => String(key || '').toLowerCase().slice(0, 16);
  const newId = rnd => { const r = rnd || Math.random; return Array.from({ length: 6 }, () => Math.floor(r() * 16).toString(16)).join(''); };
  const HEX16 = /^[0-9a-f]{16}$/, ID = /^[0-9a-f]{4,8}$/;

  // { op, id, from?, to?, offer? } -> 'KT1 ...'
  function encode(m) {
    if (!m || !OPS.includes(m.op) || !ID.test(m.id || '')) throw new Error('bad grant message');
    if (m.op === 'REQ') return `${PREFIX} REQ ${m.id} ${fp(m.from)} ${fp(m.to)} ${m.offer ? 1 : 0}`;
    if (m.op === 'OK') return `${PREFIX} OK ${m.id} ${fp(m.from)} ${fp(m.to)}`;
    return `${PREFIX} ${m.op} ${m.id}`;
  }
  // a DM's text -> the message, or null when it isn't one of ours (or is malformed)
  function parse(text) {
    const w = String(text || '').replace(/\0+$/, '').trim().split(/\s+/);
    if (w[0] !== PREFIX || !OPS.includes(w[1]) || !ID.test(w[2] || '')) return null;
    const m = { op: w[1], id: w[2] };
    if (m.op === 'REQ' || m.op === 'OK') {
      if (!HEX16.test(w[3] || '') || !HEX16.test(w[4] || '')) return null;
      m.from = w[3]; m.to = w[4];
      if (m.op === 'REQ') { if (w[5] !== '0' && w[5] !== '1') return null; m.offer = w[5] === '1'; }
    }
    return m;
  }
  // REQ / OK: the sender's fp must be the key OUR node holds for them, and the receiver's fp our own key -> null | reason
  function verify(m, senderKey, myKey) {
    if (!m) return 'not a grant message';
    if (m.op !== 'REQ' && m.op !== 'OK') return null;
    if (!senderKey || m.from !== fp(senderKey)) return 'the sender\'s key does not match the key your node holds for them';
    if (!myKey || m.to !== fp(myKey)) return 'they hold a different key for you (an old contact card?) -- swap contacts again';
    return null;
  }

  const blank = (key, name) => ({ key: String(key).toLowerCase(), name: name || '', out: 'none', in: 'none', outId: null, inReq: null,
    offered: false, theyOffered: false, mutual: false, at: 0 });

  // the state machine. ev: { type, now, ...}:
  //   ask { id, offer }  approve  decline  revokeIn  dropOut  (the user)
  //   got { msg }  (a VERIFIED message from them; ACKs are handled by the outbox, not here)
  function reduce(g0, ev) {
    const g = Object.assign({}, g0), fx = [], now = ev.now || Date.now(), name = g.name || 'them';
    const send = (op, id, extra) => fx.push(Object.assign({ do: 'send', op, id }, extra || {}));
    const note = (icon, title, text, kind) => fx.push({ do: 'note', icon, title, text, kind: kind || 'info' });
    g.at = now;
    switch (ev.type) {
      case 'ask':   // may I poll you? (offer: and you may poll me -- set on our node right away)
        if (g.out === 'granted') break;
        g.out = 'asking'; g.outId = ev.id; g.offered = !!ev.offer;
        if (ev.offer && g.in !== 'granted') {
          if (g.in === 'pending' && g.inReq) { send('OK', g.inReq.id); g.inReq = null; }   // they asked us first: offering ours answers it
          g.in = 'granted'; fx.push({ do: 'flag', on: true }, { do: 'mode' });
        }
        send('REQ', ev.id, { offer: !!ev.offer });
        break;
      case 'approve':
        if (g.in !== 'pending' || !g.inReq) break;
        g.in = 'granted'; fx.push({ do: 'flag', on: true }, { do: 'mode' });
        send('OK', g.inReq.id); g.inReq = null;
        break;
      case 'decline':
        if (g.in !== 'pending' || !g.inReq) break;
        send('NO', g.inReq.id);
        if (g.inReq.offer && g.theyOffered && g.out === 'granted') { g.out = 'none'; g.theyOffered = false; fx.push({ do: 'stop' }); }   // their offer was for a swap
        g.in = 'none'; g.inReq = null;
        break;
      case 'revokeIn':   // they may no longer poll us: the flag goes at once (the device stops answering), then tell them
        if (g.in === 'none') break;
        if (g.in === 'pending' && g.inReq) { send('NO', g.inReq.id); g.inReq = null; g.in = 'none'; break; }
        g.in = 'none'; fx.push({ do: 'flag', on: false }); send('REV', ev.id);
        break;
      case 'dropOut':   // we no longer poll them (or withdraw our request)
        if (g.out === 'none' || g.out === 'declined') { g.out = 'none'; break; }
        g.out = 'none'; g.outId = null; g.theyOffered = false; fx.push({ do: 'stop' }); send('DROP', ev.id);
        break;
      case 'got': {
        const m = ev.msg; g.mutual = true;   // it decrypted and (REQ / OK) its keys checked out
        if (m.op === 'REQ') {
          if (m.offer && g.out !== 'granted') { g.out = 'granted'; g.theyOffered = true; g.outId = null;
            note('📊', `${name} lets you poll their telemetry`, 'They offered it with their request -- start polling on the Trace Route tab.'); }
          if (g.in === 'granted') { send('OK', m.id); break; }   // already allowed (their Kelly lost its record): just say yes again
          g.in = 'pending'; g.inReq = { id: m.id, offer: !!m.offer, at: now };
          note('📊', `${name} asks to poll your telemetry`, 'Approve or decline on LoRa Mesh > Trace Route > Telemetry polling.', 'warn');
        } else if (m.op === 'OK') {
          if (g.out === 'asking' || g.out === 'declined' || g.out === 'none') { g.out = 'granted'; g.outId = null; note('📊', `${name} approved`, 'You can poll their telemetry now.', 'ok'); }
        } else if (m.op === 'NO') {
          if (g.out === 'asking') {
            g.out = 'declined'; g.outId = null; note('📊', `${name} declined`, 'They did not grant telemetry access.', 'warn');
            if (g.offered && g.in === 'granted') { g.in = 'none'; fx.push({ do: 'flag', on: false }); }   // our offer was for a swap
          }
          g.offered = false;
        } else if (m.op === 'REV') {
          if (g.out !== 'none') { g.out = 'none'; g.outId = null; g.theyOffered = false; fx.push({ do: 'stop' }); note('📊', `${name} revoked your access`, 'Polling them has stopped.', 'warn'); }
        } else if (m.op === 'DROP') {
          if (g.in === 'granted') { g.in = 'none'; fx.push({ do: 'flag', on: false }); note('📊', `${name} stopped polling you`, 'Their access to your telemetry is cleared on your node.'); }
          else if (g.in === 'pending') { g.in = 'none'; g.inReq = null; }
        }
        break;
      }
      default: break;
    }
    return { grant: g, effects: fx };
  }

  // CayenneLPP (meshcore.js parseLpp) -> what a poll shows. Channel 1 = the node itself (TELEM_CHANNEL_SELF).
  function summary(list) {
    const s = { battV: null, tempC: null, pct: null, extra: [] };
    for (const x of list || []) {
      if (x.ch === 1 && x.name === 'voltage' && s.battV == null) s.battV = x.value;
      else if (x.ch === 1 && x.name === 'temperature' && s.tempC == null) s.tempC = x.value;
      else s.extra.push(x);
    }
    s.pct = battPct(s.battV);
    return s;
  }
  // a single LiPo cell, rough (3.3 V empty .. 4.2 V full, the usual curve); null if it doesn't look like one
  function battPct(v) {
    if (v == null || !isFinite(v) || v < 2.5 || v > 4.5) return null;
    const P = [[3.3, 0], [3.5, 8], [3.6, 20], [3.7, 40], [3.8, 60], [3.9, 75], [4.0, 85], [4.1, 94], [4.2, 100]];
    if (v <= P[0][0]) return 0; if (v >= 4.2) return 100;
    for (let i = 1; i < P.length; i++) if (v <= P[i][0]) { const [a, pa] = P[i - 1], [b, pb] = P[i]; return Math.round(pa + (v - a) / (b - a) * (pb - pa)); }
    return 100;
  }

  // the schedule: minutes between polls. Each poll is a telemetry request + a route trace, from the same airtime budget as
  // every Trace Route run (10 / 10 min, 30 / hour), so the floor keeps one peer from eating it.
  const INTERVALS = [5, 10, 15, 30, 60], DEFAULT_MIN = 15, MIN_MIN = 5, HIST_CAP = 96;
  // polls { key: { on, every (min), nextAt } }, grants { key: Grant } -> the key most overdue that may go now, or null
  function due(polls, grants, now) {
    let best = null, bestAt = Infinity;
    for (const [key, p] of Object.entries(polls || {})) {
      const g = grants && grants[key];
      if (!p || !p.on || !g || g.out !== 'granted') continue;
      const at = p.nextAt || 0;
      if (at <= now && at < bestAt) { best = key; bestAt = at; }
    }
    return best;
  }
  const pushHist = (h, e, cap) => { const a = (h || []).concat([e]); return a.length > (cap || HIST_CAP) ? a.slice(a.length - (cap || HIST_CAP)) : a; };
  // route health over a history: { polls, answered, traced, changes, rate (0..1 | null) }
  function health(h) {
    const a = h || [], ans = a.filter(e => e.ok).length, tr = a.filter(e => e.trace && e.trace.ok).length;
    let changes = 0, last = null;
    for (const e of a) if (e.route != null) { if (last != null && e.route !== last) changes++; last = e.route; }
    return { polls: a.length, answered: ans, traced: tr, changes, rate: a.length ? ans / a.length : null };
  }

  return { PREFIX, OPS, fp, newId, encode, parse, verify, blank, reduce, summary, battPct, INTERVALS, DEFAULT_MIN, MIN_MIN, HIST_CAP, due, pushHist, health };
});
