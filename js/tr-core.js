/* Kelly Page -- LoRa Mesh > 🔭 Trace Route: the shared contract (2026-10-24, unreleased). Pure: no DOM, no storage.
 * Every part of the tab (tr-engine, tr-sim, tr-picker, tr-viz, tr-sound, tr-history) codes against THIS file and the
 * context `c` from js/tr-ui.js -- see TRACE_ROUTE_PLAN.md. Change it only in the integration step; a part that needs
 * more asks for it.
 *
 * What MeshCore can do (companion firmware v1.18 / main, checked 2026-10-24 -- detail in TRACE_ROUTE_PLAN.md):
 *   trace      CMD_SEND_TRACE_PATH 36, sent DIRECT along a hash list we choose. Each listed node that forwards
 *              (repeaters, room servers; a companion only with client-repeat on) appends the SNR it heard. When the list
 *              is used up, our node hears it and pushes 0x89 with every SNR + the final one (us). So a round trip is
 *              [route out.., target, route back..]. No flood traces exist (Mesh.cpp sendFlood refuses TRACE). One RTT,
 *              no per-hop times; silence on failure -- nobody says which hop dropped it.
 *   discover   CMD_SEND_PATH_DISCOVERY_REQ 52: a FLOOD base-telemetry request; the target answers with a path return
 *              -> push 0x8D with our route to them AND theirs back (hashes only, no SNR). Answered by companions whose
 *              base telemetry is open to us and by repeaters / rooms only when we're logged in (their ACL). The
 *              companion keeps ONE pending discovery (a second cancels the first). A companion's base telemetry is
 *              OFF by default (NodePrefs telemetry_mode_base = 0, deny), so most companions never answer.
 *   ping       a short DM (tries: 1) and its ACK -- proves a companion is reachable both ways; the route there is the
 *              contact's out path (learned from the ACK's path return when it went by flood). It lands in their inbox,
 *              so it's only ever chosen by the user (never by 'auto'), and only for companions.
 *   path       (Telemetry polling, js/tr-telem.js) a companion's route checked by trace: along its route to the last
 *              repeater before it and back (TR.pathList), since the companion itself won't forward -- every repeater hop
 *              gets an SNR, the companion's own hop doesn't. A direct neighbour has no repeaters: nothing to trace.
 *   hash size  Kelly traces with 2-byte hashes only (MBUG SEQ guidelines). A 1-byte hop is used only when it matches
 *              exactly ONE repeater / room server Kelly knows (then sent as 2 bytes of its key) -- a shared or unknown
 *              byte would be a guess (MeshCore FAQ 3.6: "collision makes traceroute ... harder"). route2() below.
 *
 * TraceRun -- what the engine emits. A fresh frozen object every time it changes (never mutate one):
 *   id         'tr-1', 'tr-2' ...                        target  node id (StationNode.id)       targetName  string
 *   targetRole 'repeater' | 'room' | 'companion' | 'sensor' | null
 *   method     'trace' | 'discover' | 'ping' | 'path'   (what this run is doing NOW; 'auto' requests may move trace -> discover -> trace)
 *   via        'live' (a real companion) | 'sim-link' (the MeshCore Demo link, js/meshcoresim.js) | 'demo' (tr-sim.js)
 *   demo       bool   via !== 'live'
 *   status     'pending' | 'success' | 'timeout' | 'no-path' | 'error' | 'cancelled'      (STATUS below)
 *   phase      'queued' | 'sending' | 'outbound' | 'returning' | 'done'   ('outbound'/'returning' while pending are the
 *              engine's ESTIMATE from hop timings -- live MeshCore only says "sent" and later "here's the answer")
 *   attempt    1, 2 ...    tries   most attempts this run may make
 *   hashSize   1 | 2 | 3   pathSource  'learned' (contact's out path) | 'reverse' (reverse of how its packets reached
 *              us) | 'discovered' (a discovery answer this run) | 'direct' (no repeaters) | null
 *   out        [Hop]  source -> target. out[0] is always me, out[last] is the target.
 *   back       [Hop]  target -> source. back[0] is the target, back[last] is me. [] until known.
 *   t0         ms since 1970 the run was asked for      sentAt  ms | null      endedAt  ms | null
 *   rttMs      round trip, ms | null (success only)       timeoutMs  the engine's give-up time from sentAt
 *   snrMin, snrAvg  dB | null  over every hop's SNR (success trace only)
 *   pathKey    out hop hashes joined '.' ('' direct) -- equal keys = the same route
 *   changed    true | false | null   pathKey differs from the last success to this target (null: no earlier one)
 *   error      plain-English reason | null              note  plain-English line for the status bar | null
 * Hop: { id (node id or 'h:<hash>' or 'me'), hash (hex | null for me), name, role, lat, lon, known (a real station,
 *   not a guessed hash), snr (dB this hop HEARD the packet at; null for out[0], and for every hop of a discovery),
 *   estMs (expected ms after sentAt the packet reaches this hop -- for animation while pending) }
 *
 * StationNode (c.nodes()) -- one per station the companion knows (or the demo world):
 *   { id: full key hex (or 'num:<n>' if no key), num, key | null, name, role, roleId (0-4), lat, lon, lastHeard ms | null,
 *     snr dB | null (last heard), rssi | null, hops number | null (known hop count), outPath { sz, h: [hex] } | null,
 *     inbound { sz, h: [hex], t } | null (how its packets last reached us), fav bool (the companion's favourite flag),
 *     km number | null (from us), canTrace bool, canDiscover bool, canPing bool (a companion with a key),
 *     why string | null (why not / what to expect), sends { size 1|2|3, strength 'certain'|'likely' } | null (the path hash
 *     size the station STARTS packets with, when Kelly has seen it use the wrong one -- from js/mchashcheck.js) }
 *
 * Bus events (bus.on(name, fn) -> unsubscribe). The bus is KellyPJ.createBus() -- one throwing handler never stops others.
 *   'run'      TraceRun     every change of a run (queued, sent, phase, retry, result)        emitted by the engine only
 *   'done'     TraceRun     once per run, when status leaves 'pending'                         emitted by the engine only
 *   'limit'    LimitState   the rate limiter's state changed (after each run, every 5 s while blocked)   engine only
 *   'select'   { node: id, from: 'picker'|'viz'|'history'|'map' }   the user picked a station   anyone
 *   'nodes'    -            the station list changed (re-read c.nodes())                       shell only
 *   'visible'  bool         tab shown / hidden (also browser tab hidden) -- pause when false   shell only
 *   'demo'     bool         demo mode on / off                                                 shell only
 *   'link'     { online, via } the radio link changed                                          shell only
 * LimitState: { ok bool, reason string | null, nextAt ms | null (when the next run may go), perTarget: { [id]: nextAt },
 *   used: { tenMin, hour, flood10 }, caps: { tenMin, hour, flood10, targetGapMs, discoverGapMs } }
 *
 * window.KellyTR (UMD) = { STATUS, PHASES, ROLES, SNR, snrClass, snrColor, snrNorm, hopMs, pathKey, roleOf, runOf, freeze, route2,
 *   pathShape, pathList }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory((() => { try { return require('./pj-air.js'); } catch { return null; } })());
  else root.KellyTR = factory(root.KellyPJAir || null);
})(typeof self !== 'undefined' ? self : this, function (AIR) {
  'use strict';

  const STATUS = ['pending', 'success', 'timeout', 'no-path', 'error', 'cancelled'];
  const PHASES = ['queued', 'sending', 'outbound', 'returning', 'done'];
  // MeshCore advert / contact type -> role name (0 = unknown node)
  const ROLES = { 0: null, 1: 'companion', 2: 'repeater', 3: 'room', 4: 'sensor' };
  const roleOf = id => ROLES[id] ?? null;

  // SNR bands for LoRa at SF8 (demod floor ~ -10 dB): the colours are Packet Journey's palette (pj-core PALETTE)
  const SNR = [
    { min: 6, cls: 'great', label: 'strong', color: '#39ff88' },     // PJ chat green
    { min: 0, cls: 'good', label: 'good', color: '#00e5ff' },         // PJ advert cyan
    { min: -6, cls: 'fair', label: 'weak', color: '#ffb020' },        // PJ path amber
    { min: -Infinity, cls: 'poor', label: 'marginal', color: '#ff3b5c' },   // PJ unknown red
  ];
  const band = snr => snr == null || !isFinite(snr) ? null : SNR.find(b => snr >= b.min);
  const snrClass = snr => (band(snr) || { cls: 'none' }).cls;
  const snrColor = snr => (band(snr) || { color: '#8aa0b8' }).color;
  // 0 (at the -12 dB floor) .. 1 (+12 dB or better) -- for beam width, brightness, pitch
  const snrNorm = snr => snr == null || !isFinite(snr) ? 0.35 : Math.max(0, Math.min(1, (snr + 12) / 24));

  // expected ms for one direct hop of an n-byte packet: its airtime + the forwarding node's retransmit delay
  // (Mesh::getDirectRetransmitDelay is a random 0..~5 airtimes; ~2 is typical) -- an estimate for animation only
  function hopMs(bytes, radio) {
    const r = radio && radio.sf ? radio : { sf: 8, bwKHz: 62.5, cr: 5 };
    const air = AIR && AIR.airtimeMs ? AIR.airtimeMs(bytes, r) : null;
    return Math.round((air || 400) * 3);
  }
  const pathKey = hashes => (hashes || []).map(h => String(h).toLowerCase()).join('.');

  // route { sz, h: [hex] } + the full keys of the repeaters / room servers Kelly knows -> a route with every hop as 2 bytes:
  // { route: { sz: 2, h }, upgraded: n (1-byte hops made 2-byte) } | { reason, hop }. 2- and 3-byte hops keep their first
  // 2 bytes (still a prefix of the same key); a 1-byte hop needs exactly one matching key.
  function route2(route, keys) {
    const ks = (keys || []).filter(Boolean).map(k => String(k).toLowerCase()), out = [];
    let upgraded = 0;
    for (const x of (route && Array.isArray(route.h) ? route.h : []).map(h => String(h).toLowerCase())) {
      if (x.length >= 4) { out.push(x.slice(0, 4)); continue; }
      const m = ks.filter(k => k.startsWith(x));
      if (m.length === 1) { out.push(m[0].slice(0, 4)); upgraded++; continue; }
      return { hop: x, reason: m.length ? `hop ${x.toUpperCase()} is a 1-byte hash shared by ${m.length} repeaters -- Kelly won't guess which one` : `hop ${x.toUpperCase()} is a 1-byte hash that matches no repeater Kelly knows` };
    }
    return { route: { sz: 2, h: out }, upgraded };
  }

  // A 'path' run (Telemetry polling's route check to a companion, which doesn't forward): the list sent is
  // [r1..rk, rk-1..r1], turning at the last repeater. Its answer (snrs = dB heard at each listed hop, final = us) -> the
  // shape a trace answer has, with the companion's own hop (and rk's turn) unmeasured: { out, back, snrTowards, snrBack }
  function pathShape(outH, snrs, final) {
    const k = outH.length, s = snrs || [];
    return { out: outH.slice(), back: outH.slice().reverse(), snrTowards: [...s.slice(0, k), null], snrBack: [null, ...s.slice(k, 2 * k - 1), final ?? null] };
  }
  const pathList = outH => [...outH, ...outH.slice(0, -1).reverse()];

  const freeze = o => Object.freeze(o);
  // a TraceRun with every field present, from a partial one (the engine builds on this so nothing is ever undefined)
  function runOf(p) {
    return freeze(Object.assign({ id: '', target: '', targetName: '', targetRole: null, method: 'trace', via: 'live', demo: false,
      status: 'pending', phase: 'queued', attempt: 1, tries: 1, hashSize: 1, pathSource: null, out: [], back: [],
      t0: Date.now(), sentAt: null, endedAt: null, rttMs: null, timeoutMs: 0, snrMin: null, snrAvg: null, pathKey: '', changed: null,
      error: null, note: null }, p, { out: (p.out || []).map(freeze), back: (p.back || []).map(freeze) }));
  }

  return { STATUS, PHASES, ROLES, SNR, snrClass, snrColor, snrNorm, hopMs, pathKey, roleOf, runOf, freeze, route2, pathShape, pathList };
});
