/* Kelly Page -- entitlements: the ONE place that decides what this copy of Kelly may do.
 *
 * Every feature gate goes through here (KellyLicense.allows() is a thin alias). Three tiers:
 *   open        -- local to the user's own radio / own services: always allowed
 *   member      -- P25 data to a network gateway, bridges that relay P25 traffic, the club's internet services
 *   registered  -- radio programming and transmit-side changes (needs a registration token naming the feature)
 * plus 'never' (build.removed): a command whose code is left out of the public build; refused whatever the token says.
 *
 * What a denied feature does is the REFUSAL switch:
 *   'silent'  (the members' build) the caller gets its "nothing to do" value, the UI element is hidden (never greyed,
 *             never "locked"), and the only trace is a debug entry with a reason code -- KellyEnt.log, printed to the
 *             console with ?debug (or localStorage kelly.entDebug = 1) and carried in the support log.
 *   'message' (the public build) the same gates, but a hidden area shows a locked card "Available to registered P25X
 *             members. Register at kellypage.app", a gateway page stays in the menu and opens that card, and
 *             send() answers {ok:false, gated:true, reason} so the caller can toast it. The Python bridge says the same.
 * scripts/export_kelly_public.py rewrites REFUSAL like BUILD; the private build previews it with ?ent=message.
 *
 * Build: BUILD = 'private' (the members' build, everything allowed) or 'public' (scripts/export_kelly_public.py
 * rewrites this one line). The private build can preview the public behaviour with ?ent=public.
 * The demo radio is always fully featured: nothing it sends leaves the browser.
 *
 * Real enforcement is at the gateway (it answers only registered radios); this layer keeps the public app
 * clean and stops a non-member's Kelly spending airtime on requests that won't be answered.
 */
(function (root) {
  'use strict';
  const BUILD = 'public';
  const REFUSAL = 'message';      // 'silent' | 'message' -- see above
  const REFUSAL_TEXT = 'Available to registered P25X members. Register at kellypage.app';

  // feature -> tier. Unknown features are open (and logged once), so a typo never breaks an open feature.
  const FEATURES = {
    'p25.gateway': 'member',       // every KF request / upload and Kelly frame to the gateway
    'p25.text.gw': 'member',       // texts and P25 services addressed to a gateway identity
    'p25.loc': 'member',           // position send / poll over P25
    'p25.sstv': 'member',          // SSTV pictures over P25
    'p25.transparent': 'member',   // raw Transparent-mode data (developer page, DNP3 over RF)
    'p25.park': 'member',          // Transparent home: parking + HELLO / ACK
    'p25.updates': 'member',       // Kelly updates over P25
    'bridge.mesh2p25': 'member',   // LoRa mesh -> P25
    'bridge.p252mesh': 'member',   // P25 -> LoRa mesh
    'bridge.ble2p25': 'member',    // BLE alerts / telemetry -> P25
    'relay.mqtt.p25': 'member',    // republishing received P25 traffic to MQTT
    'svc.club': 'member',          // the club's internet services (club list URL, mesh bridge at the gateway)
    'build.removed': 'never',      // a radio command this build doesn't have: refused in every build, whatever the token says
    'radio.testtx': 'registered',  // test tones, selcall / DTMF from the catalogue
    'ccr.tx': 'registered',        // CCR transmit frequency / tones / NAC / unit ID / test mode
    'tait.program': 'registered',  // code plug read / write (add-on)
  };
  const params = (() => { try { return new URLSearchParams(root.location ? root.location.search : ''); } catch (e) { return new URLSearchParams(''); } })();
  const lsGet = k => { try { return root.localStorage ? root.localStorage.getItem(k) : null; } catch (e) { return null; } };
  const entQ = params.get('ent');
  const mode = BUILD === 'public' || entQ === 'public' || entQ === 'message' ? 'public' : 'private';
  const refusal = entQ === 'message' || REFUSAL === 'message' ? 'message' : 'silent';
  let debug = params.has('debug') || lsGet('kelly.entDebug') === '1';

  let demo = false;              // the demo radio is connected
  let revoked = false;           // set by registration.js from the signed revocation list
  let serial = null;             // the connected radio's serial (CCDI q4), for a token's optional ser binding
  const serialOk = (list, s) => Array.isArray(list) && list.some(x => String(x).trim().toUpperCase() === String(s).trim().toUpperCase());   // = enttoken.js serialAllowed
  let token = null;              // verified registration token payload (step 13), or null
  const gateways = new Set();    // radio IDs that are network gateways (settings.relayId + token net.gw)
  const listeners = [];
  const LOG_MAX = 200;
  const log = [];
  const warnedUnknown = new Set();

  function note(feature, reason, where) {
    const e = { t: Date.now(), feature, reason, where: where || '' };
    log.push(e); if (log.length > LOG_MAX) log.shift();
    if (debug && root.console) console.debug(`[ent] ${reason} ${feature}${where ? ' @' + where : ''}`);
  }

  // Why a feature is refused, or null when it's allowed.
  function reason(feature) {
    const tier = FEATURES[feature];
    if (!tier) {
      if (!warnedUnknown.has(feature)) { warnedUnknown.add(feature); note(feature, 'ENT_UNKNOWN_FEATURE'); }
      return null;
    }
    if (tier === 'open') return null;
    if (tier === 'never') return 'ENT_NOT_IN_BUILD';
    if (root.KellyLicense && root.KellyLicense.expired && root.KellyLicense.expired()) return 'ENT_EXPIRED';
    if (mode === 'private') return null;
    if (demo) return null;
    if (!token) return 'ENT_NO_TOKEN';
    if (revoked) return 'ENT_REVOKED';                           // this token / device is on kellypage.app's revocation list
    if (token.exp && token.exp * 1000 < Date.now()) return 'ENT_EXPIRED';
    if (token.ser !== undefined && serial && !serialOk(token.ser, serial)) return 'ENT_SERIAL';   // bound to other radio(s); unknown serial = not checked yet
    if (!(token.feat || []).includes(feature)) return 'ENT_NO_FEATURE';
    return null;
  }

  const KellyEnt = {
    build: BUILD,
    mode,
    REFUSAL: refusal,
    REFUSAL_TEXT,
    FEATURES,
    log,

    allowed(feature) { return reason(feature) === null; },

    // allowed() with a debug note when refused: use at a gate (where = a short call-site name).
    check(feature, where) {
      const why = reason(feature);
      if (why) note(feature, why, where);
      return !why;
    },

    // True when a refused feature should say so (public build with REFUSAL 'message'): callers toast instead of staying quiet.
    get messaging() { return refusal === 'message' && mode === 'public'; },

    // What a refused caller gets back. Silent = today's {ok:true, gated:true} "nothing to do"; message =
    // {ok:false, gated:true, reason:<member text>}. `code` is the debug reason either way.
    refused(feature, extra) {
      const code = reason(feature) || 'ENT_NO_FEATURE';
      return Object.assign(this.messaging ? { ok: false, gated: true, reason: REFUSAL_TEXT, code } : { ok: true, gated: true, code }, extra || {});
    },

    // The fallback when refused, else undefined: `const r = KellyEnt.gate('p25.gateway', 0, 'wx'); if (r !== undefined) return r;`
    gate(feature, fallback, where) { return this.check(feature, where) ? undefined : fallback; },

    tier(feature) { return FEATURES[feature] || 'open'; },

    // ---- context set by the app
    setDemo(on) { const was = demo; demo = !!on; if (was !== demo) fire(); },
    setGateway(id) { gateways.clear(); if (id) gateways.add(String(+id)); for (const g of (token && token.net && token.net.gw) || []) gateways.add(String(+g)); },
    isGateway(id) { return id != null && gateways.has(String(+id)); },
    setToken(payload) { token = payload || null; this.setGateway([...gateways][0]); fire(); },
    setRevoked(on) { on = !!on; if (on !== revoked) { revoked = on; fire(); } },
    setSerial(s) { s = s ? String(s) : null; if (s !== serial) { serial = s; fire(); } },
    setDebug(on) { debug = !!on; try { root.localStorage.setItem('kelly.entDebug', on ? '1' : '0'); } catch (e) { /* storage off */ } },
    on(event, fn) { if (event === 'change') listeners.push(fn); },

    // ---- CCDI / CCR: the feature a radio-bound command needs, or null (open). wire = a framed command.
    // Escapes, CR flushes, CANCEL, PTT release and emergency never need anything.
    ccdiFeature(wire) {
      if (typeof wire !== 'string' || wire.length < 3) return null;
      const id = wire[0];
      const n = parseInt(wire.slice(1, 3), 16);
      if (!(n >= 0)) return null;
      const p = wire.slice(3, 3 + n);
      switch (id) {
        case 'd': {                                           // DIAL
          const t = p[0];
          if (t === '0' || t === '1') return 'radio.testtx';   // selcall / DTMF
          if (t === '2' && p[1] === '1') {                     // external message send: 21-<target>-<hex>
            const target = p.slice(3).split('-')[0];
            return this.isGateway(target) ? 'p25.text.gw' : null;
          }
          if (t === '6') {                                     // P25 services: 6<type>,<suid>[,param]
            const [ty, suid] = p.slice(1).split(',');
            if (ty === '3' || ty === '4' || ty === '5') {      // services aimed at another radio's transmitter
              return 'build.removed';                           // (unreachable in the members' build)
            }
            if (ty === '9') return null;                        // emergency alarm: never gated
            return this.isGateway(suid) ? 'p25.text.gw' : null;
          }
          return null;                                         // 20 save part, 4 individual, 5 group call
        }
        case 'l': return p[0] === '1' ? null : 'p25.loc';      // location: send / poll / logs; 1 = ack emergency
        case 'w': return p.startsWith('0000') || p.startsWith('0001') ? 'radio.testtx' : null;
        case 's': return 'p25.text.gw';                        // SEND_SDM
        case 'T': case 'B': case 'D': return 'ccr.tx';         // CCR transmit frequency / CTCSS / DCS
        case 'S': return 'radio.testtx';                       // CCR selcall encode
        case 'U': {
          const u = p[0];
          if (u === 'A' || u === 'C' || u === 'E') return 'ccr.tx';                 // unit ID, modulation, TX NAC
          if (u === 'Z') {
            const z = p[1];
            if (z === 'A' && p[2] === '1') return 'ccr.tx';                         // test mode (lifts the TX timeout)
            if (z === 'G' || z === 'H' || z === 'D') return 'p25.transparent';      // raw TSBK / LDU1 / data
          }
          return null;
        }
        default: return null;
      }
    },

    // ---- UI: hide every [data-ent] element whose feature isn't allowed (and show it again when it is).
    hideUi(rootEl) {
      const doc = root.document;
      if (!doc) return;
      const scope = rootEl || doc;
      const msg = this.messaging;
      for (const el of scope.querySelectorAll('[data-ent]')) {
        const ok = el.getAttribute('data-ent').split(/\s+/).every(f => !f || this.allowed(f));
        if (ok) { el.removeAttribute('data-ent-hidden'); el.removeAttribute('data-ent-locked'); unlock(el); continue; }
        if (msg && el.matches('button[data-page]')) {      // message mode: the menu entry stays and opens the locked card
          el.removeAttribute('data-ent-hidden'); el.setAttribute('data-ent-locked', ''); continue;
        }
        el.setAttribute('data-ent-hidden', '');            // [data-ent-hidden] { display: none !important } in kelly.css
        if (msg && el.matches('.page, .card') && !(el.parentElement && el.parentElement.closest('[data-ent-hidden]'))) lock(el);
        else unlock(el);
      }
    },

    // For Admin and the support log: no secrets, just the state.
    state() {
      return { build: BUILD, mode, demo, member: mode === 'private' || !!token,
        call: token ? token.sub : null, exp: token ? token.exp : null, features: token ? token.feat || [] : [] };
    },
    dump() { return log.map(e => `${new Date(e.t).toISOString()} ${e.reason} ${e.feature}${e.where ? ' @' + e.where : ''}`).join('\n'); },
  };

  // ---- 'message' mode: a hidden .card / .page gets a locked placeholder sibling (removed again when allowed)
  const locks = new WeakMap();
  function lock(el) {
    if (locks.has(el)) return;
    const doc = el.ownerDocument, isPage = el.matches('.page');
    const ph = doc.createElement(isPage ? 'section' : 'div');
    ph.className = isPage ? 'page ent-locked-page' : 'card ent-locked';
    if (isPage && el.id) ph.id = el.id + '-locked';
    ph.setAttribute('data-ent-placeholder', '');
    ph.innerHTML = '<div class="ent-locked-b"><div class="ent-locked-ic" aria-hidden="true">&#128274;</div>'
      + '<div class="ent-locked-t">Available to registered P25X members.</div>'
      + '<div class="ent-locked-s">Register at <a href="https://kellypage.app" target="_blank" rel="noopener">kellypage.app</a>, '
      + 'then add your registration in <a href="#" data-ent-reg>Admin &rsaquo; Register this station</a>.</div></div>';
    el.parentNode.insertBefore(ph, el.nextSibling);
    locks.set(el, ph);
  }
  function unlock(el) { const ph = locks.get(el); if (ph) { ph.remove(); locks.delete(el); } }

  function fire() { for (const fn of listeners) { try { fn(KellyEnt.state()); } catch (e) { /* a listener's fault, not ours */ } } }

  root.KellyEnt = KellyEnt;
  if (typeof module !== 'undefined' && module.exports) module.exports = KellyEnt;
})(typeof window !== 'undefined' ? window : globalThis);
