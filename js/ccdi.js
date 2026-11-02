/* Kelly Page -- Tait CCDI / CCR protocol codec.
 *
 * Pure (no DOM, no I/O): frame building, checksums, the line parser, message
 * decoders and the full command catalogue for the serial command interface of Tait
 * TM9100 / TM9400 / TP9400 radios: CCDI (the radio's command mode: commands to it,
 * replies and unsolicited messages from it) and CCR (computer-controlled radio mode,
 * where the computer sets frequencies, tones and P25 parameters directly).
 * Where this code differs from what the radio's documentation suggests, it follows
 * what real radios did on the bench (dated notes below).
 *
 * Loaded as a classic script (window.CCDI) so the page works from file://;
 * tests/ccdi-tests.html exercises it.
 */
(function (root) {
  'use strict';

  const hex2 = n => (n & 0xFF).toString(16).toUpperCase().padStart(2, '0');
  const pad = (v, n) => String(v).padStart(n, '0');

  // Checksum: the sum of every character before it, negated, low byte as two hex digits.
  function checksum(s) {
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i) & 0xFF;
    return hex2(-sum);
  }

  // A frame: one ident letter, two hex digits of parameter length, the parameters, the checksum, CR.
  function frame(ident, params = '') {
    params = String(params);
    if (params.length > 255) throw new Error(`parameters too long (${params.length} > 255)`);
    const body = ident + hex2(params.length) + params;
    return body + checksum(body) + '\r';
  }

  const textToHex = s => Array.from(new TextEncoder().encode(s), b => hex2(b)).join('');
  function hexToBytes(h) {
    const out = [];
    for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return new Uint8Array(out);
  }
  function hexToText(h) {
    const b = hexToBytes(h);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return null; }
  }
  const isPrintable = s => s != null && /^[\x20-\x7E -￿\r\n\t]*$/.test(s);

  // ------------------------------------------------------------------ tables
  const MODELS = {   // model reply: type digit, then model, then tier digits
    '1': 'Conventional', '11': 'Conventional Portable', '111': 'Tait Orca Elan', '112': 'Tait Orca Excel',
    '113': 'Tait Orca Eclipse', '114': 'Tait Orca 5010', '116': 'Tait Orca 5020', '117': 'Tait Radio Modem',
    '118': 'Tait Orca 5015', '13': 'Conventional Mobile', '131': 'TM8105/TM8115', '132': 'TM8110',
    '141': 'TP8115', '142': 'TP8120', '143': 'TP8110', '2': 'Trunked radio',
    '3': 'NA Signalling Conventional', '31': 'NA Sig. Conv. Portable', '314': 'Tait Orca 5011', '316': 'Tait Orca 5021',
    '4': 'Dual Mode Radio', '41': 'Dual Mode Portable', '42': 'Dual Mode Mobile', '421': 'TM8200',
    '5': 'P25 Digital', '51': 'P25 Digital Mobile', '511': 'TM9100', '52': 'P25 Digital Portable', '521': 'TP9100',
    '53': 'P25 Mobile Phase 2', '531': 'TM9400', '532': 'TM9480 (P25/MPT)', '54': 'P25 Portable Phase 2',
    '541': 'TP9400', '542': 'TP9480 (P25/MPT)', '6': 'DMR Digital', '61': 'DMR Digital Mobile', '611': 'TM9300',
    '62': 'DMR Digital Portable', '621': 'TP9300',
  };
  const RUTYPE = { '1': 'Conventional', '2': 'Trunked', '3': 'NA Signalling Conv.', '4': 'Analog conv/trunked', '5': 'P25', '6': 'DMR' };

  const ERRORS = {   // error replies
    '001': 'Unsupported command', '002': 'Checksum error', '003': 'Parameter error',
    '005': 'Radio not ready (sent before the prompt)', '006': 'Command not accepted (radio not configured for it, or busy)',
  };
  const CCR_NAK = { '01': 'Invalid command', '02': 'Checksum error', '03': 'Parameter error', '05': 'Radio busy', '06': 'Command not accepted' };

  const KEYS = {     // keycodes in key-action progress messages (type 23)
    '00': 'PTT', '01': 'Hookswitch', '02': 'On/Off', '03': 'Up', '04': 'Down', '05': 'F1', '06': 'F2', '07': 'F3',
    '08': 'F4', '09': 'F5', '0A': 'F6', '0B': '0', '0C': '1', '0D': '2', '0E': '3', '0F': '4', '10': '5', '11': '6',
    '12': '7', '13': '8', '14': '9', '15': '*', '16': '#', '1E': 'Soft L', '1F': 'Soft R',
  };
  // FUNCTION 3 does NOT take the keycode above: it takes a decimal key index (hex letters =
  // parameter error). Measured on a TM9100 with keypress PROGRESS on, which reports the key
  // actually pressed: 00-16 on 2026-10-08 (also explains the TP9400's "sent 15, got 2"), and
  // 17-24 on 2026-10-11 -- digits 4-9, * and # DO have indexes (17-22, 23, 24); 25+ press nothing.
  // (We first assumed the range stopped at 16 -- it doesn't: every key can be simulated.)
  const KEY_INDEX = {
    '00': '00', '01': '01', '02': '02', '03': '03', '04': '04', '05': '05', '06': '06', '07': '07', '08': '08', '09': '09',
    '0A': '10', '1E': '11', '1F': '12', '0B': '13', '0C': '14', '0D': '15', '0E': '16',
    '0F': '17', '10': '18', '11': '19', '12': '20', '13': '21', '14': '22', '15': '23', '16': '24',
  };
  const KEY_ACTION = { '0': 'down', '1': 'up', '2': 'short press', '3': 'long press' };

  const PROGRESS = { // progress message types
    '00': 'Call answered', '02': 'Tx inhibited', '03': 'Emergency mode initiated', '04': 'Emergency mode terminated',
    '05': 'Receiver busy', '06': 'Receiver not busy', '07': 'PTT pressed', '08': 'PTT released',
    '16': 'Selcall retry', '17': 'Radio stunned', '18': 'Radio revived', '19': 'FFSK data received',
    '1C': 'Selcall auto-acknowledge', '1D': 'SDM auto-acknowledge', '1E': 'SDM GPS data received', '1F': 'Radio restarted',
    '20': 'Single in-band tone received', '21': 'Channel change', '22': 'Channel change', '23': 'Key action',
    '25': 'Duress ACK received', '26': 'Radio status updated', '27': 'Repeater status changed', '30': 'NAC decoded',
    '31': 'Channel name', '36': 'External message NOT sent', '37': 'External message accepted',
  };
  const CHAN_KIND = { '0': 'single channel', '1': 'scan/vote group', '2': 'captured in scan group', '3': 'temporary channel', '9': 'channel invalid' };
  const RESTART_MODE = { '0': 'Command mode', '1': 'FFSK Transparent', '3': 'P25 Transparent' };

  const RING_CAT = { '0': 'Selcall', '1': 'Undefined', '2': 'Type 99', '4': 'P25', '~': 'continuation' };
  const RING_T1 = { '0': 'Voice call', '2': 'Status call', '3': 'Interrogation', '4': 'SDM', '6': 'Remote monitor', '7': 'P25 service' };
  const RING_T3 = { '0': 'Individual', '1': 'Group', '2': 'Super group', '3': 'Unknown', '4': 'External message' };
  const RING_T4 = { '0': 'Services', '1': 'Call alert', '2': 'Radio check', '3': 'Radio inhibit', '4': 'Radio uninhibit',
    '5': 'Radio unit monitor', '6': 'Message', '7': 'Status query', '8': 'Status update', '9': 'Emergency alarm', 'A': 'P25 acknowledgement' };

  const SERVICES = { 1: 'Call alert', 2: 'Radio check',
    6: 'Message', 7: 'Status query', 8: 'Status update', 9: 'Emergency alarm' };

  const CCTM = { '047': 'PA temperature', '063': 'Averaged RSSI', '064': 'Raw RSSI', '318': 'Forward power', '319': 'Reverse power' };
  const VERSION_REC = { '00': 'Model name', '01': 'Software version', '02': 'Database version', '03': 'FPGA version' };

  const P25_DUID = { '00': 'HDU', '03': 'TDU', '05': 'LDU1', '07': 'TSBK', '0A': 'LDU2', '0C': 'PDU', '0F': 'TDULC' };

  // ------------------------------------------------------------ CCDI builders
  // Each returns the full wire string (incl. checksum + CR).
  const cmd = {
    raw: (ident, params) => frame(ident, params),

    // cancel (c): 0 call, 1 delete SDMs, 3 idle display
    cancel: (type = '0') => frame('c', String(type)),

    // diagnostics (w): only answered once diagnostic mode is on (f 06 1)
    diag: (fn, sub, qual = '') => frame('w', pad(fn, 2) + pad(sub, 2) + qual),
    diagTestTone: on => frame('w', '0000' + (on ? '1' : '0')),
    diagTestToneBer: on => frame('w', '0001' + (on ? '1' : '0')),
    diagFrequencies: () => frame('w', '0002'),
    diagSignal: (rssi, ber, fec, interval100ms = 10) =>
      frame('w', '0003' + (rssi ? 1 : 0) + (ber ? 1 : 0) + (fec ? 1 : 0) + pad((interval100ms & 0xFFFF).toString(16).toUpperCase(), 4)),

    // dial (d): selcall, DTMF, external data, calls, P25 services
    selcall: num => frame('d', '0' + num),
    dtmf: num => frame('d', '1' + num),
    extSave: hex => frame('d', '20-' + hex),
    extSend: (target, hex) => frame('d', `21-${target}-${hex}`),
    individualCall: suid => frame('d', '4' + suid),
    groupCall: gid => frame('d', '5' + gid),
    service: (type, suid, param) => frame('d', `6${type},${suid}` + (param != null && param !== '' ? `,${param}` : '')),
    callAlert: suid => cmd.service(1, suid),
    radioCheck: suid => cmd.service(2, suid),
    presetMessage: (suid, n) => cmd.service(6, suid, n),
    statusQuery: suid => cmd.service(7, suid),
    statusUpdate: (suid, n) => cmd.service(8, suid, n),
    emergencyAlarm: suid => cmd.service(9, suid),

    // function (f): function number, then subfunction and qualifier digits
    func: (fn, sub = '', qual = '') => frame('f', `${fn}${sub}${qual}`),
    enterCCR: () => frame('f', '00'),
    volumeControl: on => frame('f', '01' + (on ? 1 : 0)),
    volume: lvl => frame('f', '02' + Math.max(0, Math.min(25, lvl | 0))),
    selcallRing: on => frame('f', '03' + (on ? 1 : 0)),
    progressMsgs: on => frame('f', '04' + (on ? 1 : 0)),
    keypressMsgs: on => frame('f', '04' + (on ? 2 : 3)),
    nacMsgs: on => frame('f', '04' + (on ? 5 : 4)),
    channelProgress: on => frame('f', '05' + (on ? 1 : 0)),
    reportChannel: () => frame('f', '052'),
    diagMode: on => frame('f', '06' + (on ? 1 : 0)),   // 1 enables (f03061A0 switches it on); ignore anything that says 0
    txPower: lvl => frame('f', '07' + lvl),             // 0 off,1 vlow,2 low,3 med,4 high,9 programmed
    sdmOutput: on => frame('f', '10' + (on ? 1 : 0)),
    sdmCallerIdEncode: on => frame('f', '11' + (on ? 1 : 0)),
    sdmCallerIdDecode: on => frame('f', '12' + (on ? 1 : 0)),
    emergency: q => frame('f', '2' + q),                 // 0 on, 1 stealth, 2 off, 3 duress ACK
    key: (code, dur = 1) => frame('f', '3' + (KEY_INDEX[String(code).toUpperCase()] || code) + dur), // keycode -> index; dur 0 off, 1-8 x/8 s, 9 held
    userControls: q => frame('f', '4' + q),              // 0 all off, 1 input off, 2 normal
    rxMute: on => frame('f', '5' + (on ? 1 : 0)),
    subaudibleValidate: on => frame('f', '7' + (on ? 1 : 0)),
    monitor: on => frame('f', '8' + (on ? 1 : 0)),
    tx: on => frame('f', '9' + (on ? 1 : 0)),
    talkgroup: tg => frame('f', 'C0' + tg),
    dataSap: sap => frame('f', 'D0' + sap),
    dataDest: addr => frame('f', 'D1' + addr),
    dataConfirmed: on => frame('f', 'D2' + (on ? 1 : 0)),

    // go to channel (g): channel, or zone + channel; 'f' forces it
    goToChannel: (ch, zone, forced) => {
      const p = (zone != null && zone !== '') ? pad(zone, 2) + pad(ch, 4) : String(ch);
      return frame('g', p + (forced ? 'f' : ''));
    },

    // location (l): type 0 send, 1 ack emergency, 2 poll, 3 logs; ID type 0 individual, 2 broadcast, 3 from the radio's list
    location: (type, idType, id = '') => frame('l', `${type}${idType}${id}`),
    sendPosition: (id, idType = 0) => cmd.location(0, idType, id),
    ackEmergency: id => cmd.location(1, 0, id),
    pollLocation: id => cmd.location(2, 0, id),
    locationLogs: id => cmd.location(3, 0, id),

    // query (q)
    query: (type = '0', data = '') => frame('q', `${type}${data}`),
    model: () => frame('q', '0'),
    getSdm: () => frame('q', '1'),
    opTime: (which = 0, hours = 1) => frame('q', `2${which}${hours ? 1 : 0}`),
    versions: () => frame('q', '3'),
    serial: () => frame('q', '4'),
    cctm: code => frame('q', '5' + pad(code, 3)),
    gps: () => frame('q', '6'),

    // send SDM (s): lead-in, 8-character data identity, optional return address
    sendSdm: (leadIn20ms, ident8, returnAddr8) =>
      frame('s', hex2(leadIn20ms) + String(ident8).padEnd(8, '*').slice(0, 8) +
        (returnAddr8 ? '\x08' + String(returnAddr8).padEnd(8, '0').slice(0, 8) : '\x00')),

    // transparent mode (t): escape character + modulation ('' = FFSK default, '0' FFSK, 'H' P25)
    transparent: (esc = '+', mode = 'H') => frame('t', esc + mode),
  };

  // External data message (DIAL type 2), chunked with Save parts when it
  // would overflow one command (160 bytes of message in all).
  function externalMessage(target, text) {
    const hex = typeof text === 'string' ? textToHex(text) : Array.from(text, hex2).join('');
    if (hex.length > 320) throw new Error('message longer than 160 bytes');
    const sendHead = `21-${target}-`;
    const room = Math.floor((175 - sendHead.length) / 2) * 2;
    if (hex.length <= room) return [cmd.extSend(target, hex)];
    const saveRoom = Math.floor((175 - 3) / 2) * 2;
    const out = [];
    let rest = hex;
    while (rest.length > room) {
      const take = Math.min(saveRoom, rest.length - 2);   // always leave data for the Send part
      out.push(cmd.extSave(rest.slice(0, take)));
      rest = rest.slice(take);
    }
    out.push(cmd.extSend(target, rest));
    return out;
  }

  // ------------------------------------------------------------- CCR builders
  const ccr = {
    rxFreq: hz => frame('R', String(Math.round(hz))),
    txFreq: hz => frame('T', String(Math.round(hz))),
    bandwidth: idx => frame('H', String(idx)),             // 1 narrow, 2 medium, 3 wide
    volume: lvl => frame('J', pad(Math.max(0, Math.min(255, lvl | 0)), 3)),
    rxCtcss: hz => frame('A', pad(Math.round(hz * 10), 4)),
    txCtcss: hz => frame('B', pad(Math.round(hz * 10), 4)),
    rxDcs: code => frame('C', pad(code, 3)),
    txDcs: code => frame('D', pad(code, 3)),
    selcall: seq => frame('S', seq),
    selcallParams: (toneSet, period, notify) => frame('I', `${toneSet}${period}${notify}`),
    ani: (pos, seq = '') => frame('N', `${pos}${pos == 0 ? '' : seq}`),
    monitor: on => frame('M', on ? 'D' : 'E'),
    power: idx => frame('P', String(idx)),                 // 1-4
    pulse: () => frame('Q', 'P'),
    unitId: id => frame('U', 'A' + pad(id, 7)),
    talkgroup: tg => frame('U', 'B' + pad(tg, 5)),
    modulation: m => frame('U', 'C' + m),                  // 1 C4FM, 2 CQPSK, 3 wide, 4 TSM NB
    rxNac: nac => frame('U', 'D' + String(nac).toUpperCase().padStart(3, '0')),
    txNac: nac => frame('U', 'E' + String(nac).toUpperCase().padStart(3, '0')),
    signalReport: (on, ms) => frame('U', 'Y' + (on ? 1 : 0) + (on && ms ? pad(Math.max(500, ms).toString(16).toUpperCase(), 4) : '')),
    p25: (id, args = '') => frame('U', 'Z' + id + args),
    exit: () => frame('E', ''),
  };

  // ---------------------------------------------------------------- decoding
  // Splits a byte stream (as a latin-1 string) into prompts and CR-terminated
  // lines. '.' is only a prompt between messages -- inside one it is data
  // (versions like "03.06"). In transparent mode everything is raw data.
  class Parser {
    constructor(onEvent) { this.onEvent = onEvent; this.buf = ''; this.inMsg = false; this.transparent = false; }
    reset() { this.buf = ''; this.inMsg = false; }
    push(chunk) {
      if (this.transparent) { this.onEvent({ kind: 'data', data: chunk, ts: Date.now() }); return; }
      for (const c of chunk) {
        if (!this.inMsg) {
          if (c === '.') this.onEvent({ kind: 'prompt', ts: Date.now() });
          else if (c === '\r' || c === '\n' || c === '\0') { /* spacing */ }
          else { this.inMsg = true; this.buf = c; }
        } else if (c === '\r' || c === '\n') {
          this.inMsg = false;
          const line = this.buf; this.buf = '';
          this.onEvent(decodeLine(line));
        } else {
          this.buf += c;
          if (this.buf.length > 600) { this.onEvent({ kind: 'junk', raw: this.buf, ts: Date.now() }); this.reset(); }
        }
      }
    }
  }

  // Frame-level split + validation, no meaning attached.
  function splitFrame(line) {
    const m = /^(.)([0-9A-Fa-f]{2})/.exec(line);
    if (!m) return null;
    const size = parseInt(m[2], 16);
    const params = line.substr(3, size);
    const cks = line.substr(3 + size, 2);
    return {
      ident: m[1], size, params, cks,
      lengthOk: line.length === 5 + size,
      checksumOk: params.length === size && cks.toUpperCase() === checksum(line.substr(0, 3 + size)),
    };
  }

  function decodeLine(line) {
    const ev = { kind: 'message', raw: line, ts: Date.now() };
    // Diagnostic output lines are free text, not frames
    let m;
    if ((m = /^D:(\d{3}):([\d.]+):(\d+)/.exec(line))) {
      return Object.assign(ev, { type: 'diag-signal', name: 'Diag signal', valid: true,
        rssi: m[1] === '000' ? null : -parseInt(m[1], 10), ber: parseFloat(m[2]), fec: parseInt(m[3], 10) });
    }
    if ((m = /^TxRx:([\d.]+):([\d.]+)/.exec(line))) {
      return Object.assign(ev, { type: 'diag-freq', name: 'Channel frequencies', valid: true, txMHz: parseFloat(m[1]), rxMHz: parseFloat(m[2]) });
    }
    const f = splitFrame(line);
    if (!f) return Object.assign(ev, { kind: 'junk', name: 'Unframed line', valid: false });
    Object.assign(ev, { ident: f.ident, size: f.size, params: f.params, valid: f.checksumOk && f.lengthOk });
    const d = DECODERS[f.ident];
    if (d) { try { d(f.params, ev); } catch (e) { ev.decodeError = String(e); } }
    else ev.name = `Unknown '${f.ident}'`;
    return ev;
  }

  function parseCaller(s) {
    // P25 voice/service RINGs give the caller as 6 hex digits (e.g. "007A1A");
    // "dest-caller" when the call wasn't addressed to us.
    const conv = id => {
      if (/^[0-9A-Fa-f]{6}$/.test(id) && /[A-Fa-f]/.test(id)) return parseInt(id, 16);
      if (/^[0-9A-Fa-f]{6}$/.test(id) && CCDI.callerIdFormat !== 'decimal') return parseInt(id, 16);
      if (/^\d+$/.test(id)) return parseInt(id, 10);
      return null;
    };
    const parts = s.split('-').filter(Boolean);
    if (parts.length >= 2) return { dest: conv(parts[0]), caller: conv(parts[1]), callerRaw: parts[1], destRaw: parts[0] };
    return { caller: s ? conv(s) : null, callerRaw: s };
  }

  const DECODERS = {
    m(p, ev) {
      ev.type = 'model'; ev.name = 'MODEL';
      ev.rutype = p[0]; ev.rumodel = p[1]; ev.rutier = p[2]; ev.version = p.slice(3);
      ev.model = MODELS[p.slice(0, 3)] || MODELS[p.slice(0, 2)] || RUTYPE[p[0]] || 'Unknown model';
      ev.family = RUTYPE[p[0]] || '';
      ev.summary = `${ev.model} -- CCDI ${ev.version}`;
    },
    n(p, ev) { ev.type = 'serial'; ev.name = 'RADIO SERIAL'; ev.serial = p; ev.summary = `Serial ${p}`; },
    v(p, ev) {
      ev.type = 'version'; ev.name = 'RADIO VERSION'; ev.record = p.slice(0, 2); ev.value = p.slice(2);
      ev.label = VERSION_REC[ev.record] || `Record ${ev.record}`; ev.summary = `${ev.label}: ${ev.value}`;
    },
    e(p, ev) {
      ev.type = 'error'; ev.name = 'ERROR'; ev.etype = p[0]; ev.errnum = p.slice(1, 3);
      // Type 2 is undocumented as far as we know; a TP9400 (3.01) returns e03202 for CCTM 318/319 -- feature not on this radio.
      ev.text = p[0] === '1' ? 'Fatal system error' : p[0] === '2' ? `Not available on this radio (error ${p})` : (ERRORS[p.slice(0, 3)] || `Error ${p}`);
      ev.unsupported = p[0] === '2' || p.slice(0, 3) === '001';
      ev.summary = ev.text;
    },
    j(p, ev) {
      ev.type = 'cctm'; ev.name = 'CCTM RESULT'; ev.cctm = p.slice(0, 3); ev.result = p.slice(3);
      ev.label = CCTM[ev.cctm] || `CCTM ${ev.cctm}`;
      const n = parseInt(ev.result, 10);
      if (ev.cctm === '063' || ev.cctm === '064') { ev.value = n / 10; ev.unit = 'dBm'; }
      else if (ev.cctm === '047') { ev.value = n; ev.unit = ev.result.length >= 3 && n > 150 ? 'mV' : '°C'; }
      else { ev.value = n; ev.unit = 'mV'; }
      ev.summary = `${ev.label}: ${ev.value} ${ev.unit}`;
    },
    s(p, ev) {
      ev.type = 'sdm'; ev.name = 'GET SDM'; ev.sdm = p;
      // A TP9400 answers QUERY GPS (q6) with a binary Tait-SDM-format 's' (e.g. 82 00 00 with no fix).
      ev.binary = /[^\x20-\x7E]/.test(p);
      if (ev.binary) ev.sdmHex = Array.from(p, c => hex2(c.charCodeAt(0))).join(' ');
      // First byte = Tait AVL report header 1TTT AEss: ss 00 new fix, 01 no fix (old data),
      // 10 GPS not operational, 11 format error (same decode as scripts/p25x_sdm.py AVL_STATUS).
      if (ev.binary && p.length && (p.charCodeAt(0) & 0x80)) {
        ev.gpsStatus = ['new fix', 'no fix (old data)', 'GPS not operational', 'format error'][p.charCodeAt(0) & 3];
        ev.noFix = (p.charCodeAt(0) & 3) !== 0;
      }
      ev.summary = !p ? 'No SDM buffered' : ev.binary ? `SDM (binary) ${ev.sdmHex}${ev.gpsStatus ? ` -- ${ev.gpsStatus}` : ''}` : `SDM: ${p}`;
    },
    p(p, ev) {
      ev.type = 'progress'; ev.name = 'PROGRESS'; ev.ptype = p.slice(0, 2).toUpperCase();
      ev.label = PROGRESS[ev.ptype] || `Progress ${ev.ptype}`;
      const rest = p.slice(2);
      switch (ev.ptype) {
        case '21': case '22':
          ev.chanKind = rest[0]; ev.chanKindText = CHAN_KIND[rest[0]] || rest[0];
          ev.chanRaw = rest.slice(1);
          if (ev.chanRaw.length === 6) { ev.zone = parseInt(ev.chanRaw.slice(0, 2), 10); ev.channel = parseInt(ev.chanRaw.slice(2), 10); }
          else if (ev.chanRaw) ev.channel = parseInt(ev.chanRaw, 10);
          ev.summary = `Channel ${ev.zone != null ? `Z${ev.zone} ` : ''}${ev.channel ?? '?'} (${ev.chanKindText})`;
          break;
        case '23':
          ev.key = rest.slice(0, 2).toUpperCase(); ev.keyName = KEYS[ev.key] || ev.key; ev.action = KEY_ACTION[rest[2]] || rest[2];
          ev.summary = `Key ${ev.keyName} ${ev.action}`; break;
        case '1C': case '1D': ev.ack = rest[0] === '1'; ev.summary = `${ev.label}: ${ev.ack ? 'acknowledged' : 'no ack'}`; break;
        case '1F': ev.restartMode = RESTART_MODE[rest[0]] || rest[0]; ev.summary = `Radio restarted -> ${ev.restartMode}`; break;
        case '26':
          ev.para1 = rest[0]; ev.para2 = rest.slice(1);
          ev.summary = rest[0] === '1' ? `Ignition ${ev.para2 === '1' ? 'on' : 'off'}` : `Terminal status ${ev.para2}`; break;
        case '30': ev.nacValid = rest[0] === '1'; ev.nac = rest.slice(1); ev.summary = `NAC ${ev.nac} ${ev.nacValid ? '(valid)' : '(not ours)'}`; break;
        case '31': ev.nameValid = rest[0] === '1'; ev.chanName = ev.nameValid ? rest.slice(1) : ''; ev.summary = ev.nameValid ? `Channel name "${ev.chanName}"` : 'Channel name invalid'; break;
        default: ev.para = rest; ev.summary = ev.label + (rest ? ` (${rest})` : '');
      }
    },
    r(p, ev) {
      ev.type = 'ring'; ev.name = 'RING'; ev.category = p[0];
      if (p[0] === '~') { ev.continuation = true; ev.data = p.slice(1); ev.summary = 'RING continuation'; finishExt(ev); return; }
      ev.t1 = p[1]; ev.t2 = p[2]; ev.t3 = p[3]; ev.t4 = p[4]; ev.status = p.slice(5, 7);
      ev.callKind = RING_T1[ev.t1] || ev.t1; ev.emergency = ev.t2 === '1'; ev.target = RING_T3[ev.t3] || ev.t3;
      ev.service = RING_T4[ev.t4] || ev.t4; ev.statusValue = ev.status === 'FF' ? null : parseInt(ev.status, 10);
      const rest = p.slice(7);
      if (ev.t3 === '4') {
        ev.external = true;
        if (rest.startsWith('-')) {
          const parts = rest.slice(1).split('-');
          ev.srcIp = parts[0]; ev.srcPort = +parts[1]; ev.dstPort = +parts[2]; ev.data = parts.slice(3).join('');
        } else {
          const parts = rest.split('-');
          ev.dest = parseInt(parts[0], 10); ev.caller = parseInt(parts[1], 10); ev.data = parts.slice(2).join('');
        }
        finishExt(ev);
        ev.summary = `External message from ${ev.caller ?? ev.srcIp}${ev.fragmented ? ' (part 1)' : ''}`;
      } else {
        Object.assign(ev, parseCaller(rest));
        ev.summary = `${RING_CAT[ev.category] || ''} ${ev.callKind}${ev.t1 === '7' ? ` / ${ev.service}` : ` (${ev.target})`}` +
          `${ev.caller != null ? ` from ${ev.caller}` : ''}${ev.statusValue != null ? ` value ${ev.statusValue}` : ''}${ev.emergency ? ' EMERGENCY' : ''}`;
      }
    },
    l(p, ev) {
      ev.type = 'location'; ev.name = 'LOCATION'; ev.callType = p[0];
      ev.emergency = p[0] === '1'; ev.id = parseInt(p.slice(1, 9), 10); ev.locType = p[9]; ev.location = p.slice(10);
      ev.fix = parseNmea(ev.location);
      ev.summary = `Location from ${ev.id}${ev.emergency ? ' (EMERGENCY)' : ''}${ev.fix ? ` ${ev.fix.lat.toFixed(5)}, ${ev.fix.lon.toFixed(5)}` : ''}`;
    },
    // ---- CCR replies: '+' acks (incl. UY signal / position reports), '-' naks, 'M' mode, 'Q' pulse, 'V' selcall decode
    '+'(p, ev) {
      ev.type = 'ccr-ack'; ev.name = 'CCR ACK'; ev.ccr = true; ev.ackFor = p[0];
      if (p.startsWith('UY')) {
        ev.type = 'ccr-signal'; ev.name = 'CCR signal report';
        const h = (a, n) => parseInt(p.substr(a, n), 16);
        ev.gpsState = ['no data', 'new valid', 'old valid', 'invalid'][+p[2]] || p[2];
        ev.rssi = -((0xFFFF - h(3, 4)) / 10); ev.ber = h(7, 4) / 100; ev.qos = h(11, 4) / 100;
        const lat = h(15, 4) + (h(19, 4) + h(23, 4) / 10000) / 60, lon = h(29, 4) + (h(33, 4) + h(37, 4) / 10000) / 60;
        const latRef = String.fromCharCode(h(27, 2) || 78), lonRef = String.fromCharCode(h(41, 2) || 69);
        // 1 new / 2 old valid data -- but a radio with no GPS (TM9100, 2026-10-08) reports 2 with all-zero
        // coordinates, which is not a fix
        if ((+p[2] === 1 || +p[2] === 2) && (lat || lon)) ev.fix = { lat: latRef === 'S' ? -lat : lat, lon: lonRef === 'W' ? -lon : lon };
        ev.summary = `RSSI ${ev.rssi.toFixed(1)} dBm, BER ${ev.ber}%, QoS ${ev.qos}%`;
      } else if (p.startsWith('UZ')) {
        ev.type = 'ccr-p25'; ev.name = 'CCR P25 reply'; ev.p25Cmd = p[2]; ev.data = p.slice(3);
        if (p[2] === 'C' && ev.data.length >= 18) {
          ev.frameTime = ev.data.slice(0, 8); ev.msgNo = parseInt(ev.data.slice(8, 12), 16); ev.dir = ev.data[12] === '1' ? 'Tx' : 'Rx';
          ev.nac = ev.data.slice(13, 16); ev.duid = ev.data.slice(16, 18).toUpperCase(); ev.duidName = P25_DUID[ev.duid] || `DUID ${ev.duid}`;
          ev.block = ev.data.slice(18);
          if (ev.duid === '07') ev.tsbk = decodeTsbk(ev.block);
          ev.summary = `${ev.dir} ${ev.duidName} NAC ${ev.nac}${ev.tsbk ? ` ${ev.tsbk.name}` : ''}`;
        } else ev.summary = `P25 ${p[2]}: ${ev.data}`;
      } else ev.summary = `Accepted '${p[0]}'`;
    },
    '-'(p, ev) {
      ev.type = 'ccr-nak'; ev.name = 'CCR NAK'; ev.ccr = true; ev.reason = p.slice(0, 2); ev.nakFor = p[2] || '';
      ev.text = CCR_NAK[ev.reason] || `Reason ${ev.reason}`; ev.summary = `Rejected '${ev.nakFor}': ${ev.text}`;
    },
    M(p, ev) {
      ev.ccr = true;
      if (p === 'R') { ev.type = 'ccr-entered'; ev.name = 'CCR mode active'; ev.summary = 'CCR mode entered'; }
      else if (p === 'P') { ev.type = 'ccr-ptt-timeout'; ev.name = 'PTT time-out warning'; ev.summary = 'Transmit time-out in 10 s'; }
      else { ev.type = 'ccr-msg'; ev.name = 'CCR M'; ev.summary = p; }
    },
    Q(p, ev) { ev.ccr = true; ev.type = 'ccr-pulse'; ev.name = 'CCR pulse'; ev.configured = p === 'P'; ev.summary = p === 'P' ? 'Pulse: configured' : 'Pulse: defaults only (no Rx freq set)'; },
    V(p, ev) { ev.ccr = true; ev.type = 'ccr-selcall'; ev.name = 'Selcall decode'; ev.sequence = p; ev.summary = `Selcall ${p}`; },
  };

  function finishExt(ev) {
    ev.data = ev.data || '';
    ev.fragmented = ev.data.endsWith('~');
    if (ev.fragmented) ev.data = ev.data.slice(0, -1);
    ev.text = hexToText(ev.data);
    if (!isPrintable(ev.text)) ev.text = null;
  }

  // ------------------------------------------------------------------- NMEA
  function nmeaCoord(v, h) {
    if (!v) return NaN;
    const dot = v.indexOf('.');
    const degLen = (dot < 0 ? v.length : dot) - 2;
    const val = parseFloat(v.slice(0, degLen)) + parseFloat(v.slice(degLen)) / 60;
    return (h === 'S' || h === 'W') ? -val : val;
  }
  function parseNmea(s) {
    if (!s) return null;
    s = s.replace(/\s+/g, '');
    const i = s.indexOf('$');
    if (i < 0) return null;
    const f = s.slice(i).split('*')[0].split(',');
    const t = f[0].slice(3);
    if (t === 'RMC') {
      const lat = nmeaCoord(f[3], f[4]), lon = nmeaCoord(f[5], f[6]);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      return { lat, lon, valid: f[2] === 'A', speedKmh: f[7] ? parseFloat(f[7]) * 1.852 : null,
        heading: f[8] ? parseFloat(f[8]) : null, time: f[1], date: f[9], sentence: 'RMC' };
    }
    if (t === 'GGA') {
      const lat = nmeaCoord(f[2], f[3]), lon = nmeaCoord(f[4], f[5]);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      return { lat, lon, valid: f[6] !== '0', sats: +f[7], altM: parseFloat(f[9]), time: f[1], sentence: 'GGA' };
    }
    return null;
  }

  // ------------------------------------------------------------------- TSBK
  // TIA-102.AABC opcodes (MFID 00), outbound/inbound names. 12 bytes:
  // LB|P|opcode(6), MFID, 8 bytes args, CRC-16.
  const TSBK_OSP = {
    0x00: 'GRP_V_CH_GRANT', 0x02: 'GRP_V_CH_GRANT_UPDT', 0x03: 'GRP_V_CH_GRANT_UPDT_EXP', 0x04: 'UU_V_CH_GRANT',
    0x05: 'UU_ANS_REQ', 0x06: 'UU_V_CH_GRANT_UPDT', 0x08: 'TELE_INT_CH_GRANT', 0x0A: 'TELE_INT_ANS_REQ',
    0x14: 'SN-DATA_CHN_GNT', 0x15: 'SN-DATA_PAGE_REQ', 0x16: 'SN-DATA_CHN_ANN_EXP', 0x18: 'STS_UPDT', 0x1A: 'STS_Q',
    0x1C: 'MSG_UPDT', 0x1D: 'RAD_MON_CMD', 0x1F: 'CALL_ALRT', 0x20: 'ACK_RSP_FNE', 0x21: 'QUE_RSP', 0x24: 'EXT_FNCT_CMD',
    0x27: 'DENY_RSP', 0x28: 'GRP_AFF_RSP', 0x29: 'SCCB_EXP', 0x2A: 'GRP_AFF_Q', 0x2B: 'LOC_REG_RSP', 0x2C: 'U_REG_RSP',
    0x2D: 'U_REG_CMD', 0x2E: 'AUTH_CMD', 0x2F: 'U_DE_REG_ACK', 0x30: 'SYNC_BCST', 0x31: 'AUTH_DMD', 0x32: 'AUTH_FNE_RESP',
    0x33: 'IDEN_UP_TDMA', 0x34: 'IDEN_UP_VU', 0x35: 'TIME_DATE_ANN', 0x36: 'ROAM_ADDR_CMD', 0x37: 'ROAM_ADDR_UPDT',
    0x38: 'SYS_SRV_BCST', 0x39: 'SCCB', 0x3A: 'RFSS_STS_BCST', 0x3B: 'NET_STS_BCST', 0x3C: 'ADJ_STS_BCST', 0x3D: 'IDEN_UP',
  };
  function decodeTsbk(hex) {
    hex = (hex || '').replace(/\s+/g, '');
    if (hex.length < 20) return null;
    const b = hexToBytes(hex);
    const op = b[0] & 0x3F, mfid = b[1];
    const u24 = i => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2], u16 = i => (b[i] << 8) | b[i + 1];
    const t = { lastBlock: !!(b[0] & 0x80), protected: !!(b[0] & 0x40), opcode: op, mfid,
      name: mfid === 0 ? (TSBK_OSP[op] || `OP 0x${hex2(op)}`) : `MFID ${hex2(mfid)} OP 0x${hex2(op)}`, fields: {} };
    if (mfid !== 0) return t;
    switch (op) {
      case 0x00: t.fields = { serviceOptions: hex2(b[2]), channel: u16(3), group: u16(5), source: u24(7) }; break;
      case 0x02: t.fields = { channelA: u16(2), groupA: u16(4), channelB: u16(6), groupB: u16(8) }; break;
      case 0x04: t.fields = { channel: u16(2), target: u24(4), source: u24(7) }; break;
      case 0x18: t.fields = { status: b[2], userStatus: b[3], target: u24(4), source: u24(7) }; break;   // two octets (relay: 'status 3/0')
      case 0x1C: t.fields = { message: u16(2), target: u24(4), source: u24(7) }; break;
      case 0x1F: t.fields = { target: u24(4), source: u24(7) }; break;
      case 0x28: t.fields = { response: b[2] & 0x03, announceGroup: u16(5), group: u16(5), target: u24(7) }; break;
      case 0x2C: t.fields = { response: (b[2] >> 4) & 0x03, systemId: ((b[2] & 0x0F) << 8) | b[3], sourceId: u24(4), source: u24(7) }; break;
      case 0x2F: t.fields = { wacn: (u24(3) >> 4), systemId: ((b[5] & 0x0F) << 8) | b[6], source: u24(7) }; break;
      case 0x3A: t.fields = { lra: b[2], systemId: ((b[3] & 0x0F) << 8) | b[4], rfss: b[5], site: b[6], channel: u16(7) }; break;
      case 0x3B: t.fields = { lra: b[2], wacn: (u24(3) >> 4), systemId: ((b[5] & 0x0F) << 8) | b[6], channel: u16(7) }; break;
      case 0x3C: t.fields = { lra: b[2], systemId: ((b[3] & 0x0F) << 8) | b[4], rfss: b[5], site: b[6], channel: u16(7) }; break;
      default: t.fields = { args: hex.slice(4, 20).toUpperCase() };
    }
    return t;
  }

  // ------------------------------------------------ P25 TSBKs to send via CCR (UZG)
  // CCDI refuses P25 services on some codeplugs (TM9100: e03006) but CCR's P25 API sends any
  // TSBK -- a status update built here was acked by the P25X Reflector (2026-10-08).
  // Layouts match scripts/p25x_sdm.py's builders. CRC-16 = CCITT 0x1021, init 0, inverted.
  function crc16P25(bytes) {
    let r = 0;
    for (const x of bytes) for (let i = 7; i >= 0; i--) { const fb = ((r >> 15) & 1) ^ ((x >> i) & 1); r = (r << 1) & 0xFFFF; if (fb) r ^= 0x1021; }
    return r ^ 0xFFFF;
  }
  const u24b = v => [(v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
  const i32b = v => [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
  const tsbkHex = b10 => { const c = crc16P25(b10); return [...b10, c >> 8, c & 0xFF].map(hex2).join(''); };
  const tsbk = {   // each returns the 24 hex characters UZG takes
    statusUpdate: (dst, src, status, user = 0) => tsbkHex([0x98, 0, status & 0xFF, user & 0xFF, ...u24b(dst), ...u24b(src)]),
    messageUpdate: (dst, src, n) => tsbkHex([0x9C, 0, (n >> 8) & 0xFF, n & 0xFF, ...u24b(dst), ...u24b(src)]),
    statusQuery: (dst, src) => tsbkHex([0x9A, 0, 0, 0, ...u24b(dst), ...u24b(src)]),
    callAlert: (dst, src) => tsbkHex([0x9F, 0, 0, 0, ...u24b(dst), ...u24b(src)]),
    radioCheck: (dst, src) => tsbkHex([0xA4, 0, 0, 0, ...u24b(src), ...u24b(dst)]),   // ext function 0000, arg = requester
  };

  // ------------------------------------------- Kelly frames (P25 Transparent pipe)
  // Same format as scripts/p25x_kelly.py -- keep the two in step. The P25X Reflector picks
  // these out of a radio's Transparent data (A5 4B; DNP3 is 05 64, SSTV A5 53):
  //   A5 4B | type | len | payload (<= 240) | CRC-16 LE (DNP3 block CRC over type..payload)
  //   TEXT payload: destination ID (3, BE) + UTF-8 text
  //   POS  payload: lat, lon (4 each, BE signed, 1e-6 deg) + APRS symbol (2) + comment
  // A Tait radio holds Transparent bytes until it sees a CR, so build() ends frames in \r.
  function crcDnp3(bytes) {
    let c = 0;
    for (const x of bytes) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xA6BC : c >>> 1; }
    return (~c) & 0xFFFF;
  }
  const KellyFrame = {
    T_TEXT: 1, T_POS: 2, T_MSG: 4, T_ACK: 5, T_STATUS: 6, T_PRESET: 7, T_HELLO: 8, T_WELCOME: 9, T_LOCPOLL: 10, T_LOC: 11, T_MODBUS: 14, MAX: 240,
    build(type, payload) {
      if (payload.length > 240) throw new Error(payload.length + ' bytes -- the limit is 240');
      const body = [type, payload.length, ...payload], c = crcDnp3(body);
      return String.fromCharCode(0xA5, 0x4B, ...body, c & 0xFF, c >> 8) + '\r';
    },
    text(dst, text) { return this.build(1, [...u24b(dst), ...new TextEncoder().encode(text)]); },
    // call (optional) = the station's APRS callsign-SSID -> type 3 (POSC), honoured by the dashboard.
    pos(lat, lon, symbol = '/-', comment = '', call = '') {
      const sym = (symbol + '--').slice(0, 2).split('').map(ch => ch.charCodeAt(0) & 0x7F);
      const head = [...i32b(Math.round(lat * 1e6)), ...i32b(Math.round(lon * 1e6)), ...sym], text = [...new TextEncoder().encode(comment)];
      const c = String(call || '').toUpperCase().slice(0, 10).split('').map(ch => ch.charCodeAt(0) & 0x7F);
      return c.length ? this.build(3, [...head, c.length, ...c, ...text]) : this.build(2, [...head, ...text]);
    },
    // Transparent home (scripts/p25x_kelly.py): src 0 = "the sender" (the relay reads the ID off the call).
    msg(dst, src, seq, text) { return this.build(4, [...u24b(dst), ...u24b(src), seq & 0xFF, ...new TextEncoder().encode(text)]); },
    ack(dst, src, seq) { return this.build(5, [...u24b(dst), ...u24b(src), seq & 0xFF]); },
    status(dst, src, seq, code, preset = false, label = '') { return this.build(preset ? 7 : 6, [...u24b(dst), ...u24b(src), seq & 0xFF, code & 0xFF, ...new TextEncoder().encode(label).slice(0, 40)]); },
    hello(mode, nonce) { return this.build(8, [mode & 0xFF, (nonce >> 8) & 0xFF, nonce & 0xFF]); },
    welcome(dst, nonce) { return this.build(9, [...u24b(dst), (nonce >> 8) & 0xFF, nonce & 0xFF]); },
    // Locate: ask the gateway to poll a radio's GPS (method 0 auto, 1 Tait SDM, 2 LRRP); it answers with LOC.
    locpoll(target, method = 0, seq = 0) { return this.build(10, [...u24b(target), method & 0xFF, seq & 0xFF]); },
    // Modbus TCP over P25 (type 14 -- 13 is CR, which makes the radio send early): dst + device + one Modbus
    // TCP ADU (MBAP 7 + PDU). The gateway forwards it to that device and answers with its response ADU.
    modbus(dst, device, adu) { return this.build(14, [...u24b(dst), device & 0xFF, ...adu]); },
    // BLE telemetry (type 15, radio -> gateway; the relay publishes MQTT p25x/ble/<radio>/<sensor>). Payload
    // byte-stuffed (0D -> 7D 2D, 7D -> 7D 5D); seq bumped until length + CRC hold no CR either. Unstuffed:
    // 01 | seq | clock (4, BE unix s) | items: 01 sensor q age(2) value(4, BE signed / scale) = a reading,
    // 02 sensor type len name = a sensor's name, 00 = padding. = scripts/p25x_kelly.py telem_frame -- keep in step.
    TELEM_Q: { temp: [1, 0.01], hum: [2, 0.01], batt: [3, 1], batt_mv: [4, 1], volt: [5, 0.001], pressure: [6, 0.01], co2: [7, 1],
      present: [8, 1], rssi: [9, 1], door: [10, 1], window: [11, 1], opening: [12, 1], motion: [13, 1], lux: [14, 0.01],
      moisture: [15, 0.01], power: [16, 0.01], current: [17, 0.001], smoke: [18, 1], count: [19, 1], pm25: [20, 1], pm10: [21, 1],
      dew: [22, 0.01], tvoc: [23, 1] },
    TELEM_TYPES: ['other', 'person', 'radio', 'gobox', 'vehicle', 'asset', 'sensor', 'pet'],   // append only
    stuff(b) { const o = []; for (const x of b) { if (x === 0x0D || x === 0x7D) o.push(0x7D, x ^ 0x20); else o.push(x); } return o; },
    unstuff(b) { const o = []; for (let i = 0; i < b.length; i++) { if (b[i] === 0x7D && i + 1 < b.length) o.push(b[++i] ^ 0x20); else o.push(b[i]); } return o; },
    // items: ['reading', sensor, field, value, ageS] / ['name', sensor, typeName, name]
    telem(seq, clock, items) {
      const body = [];
      for (const it of items) {
        if (it[0] === 'reading') {
          const [, sensor, field, value, age] = it, [code, scale] = this.TELEM_Q[field];
          body.push(1, sensor & 0xFF, code, ...[Math.min(0xFFFF, Math.max(0, Math.round(age)))].flatMap(a => [a >> 8, a & 0xFF]), ...i32b(Math.round(value / scale)));
        } else {
          const nb = [...new TextEncoder().encode(it[3])].slice(0, 24), t = Math.max(0, this.TELEM_TYPES.indexOf(it[2]));
          body.push(2, it[1] & 0xFF, t, nb.length, ...nb);
        }
      }
      for (let bump = 0; bump < 256; bump++) {
        const p = this.stuff([1, (seq + bump) & 0xFF, ...i32b(clock >>> 0), ...body]);
        if (p.length === 0x0D) p.push(0);
        const f = this.build(15, p);
        if (!f.slice(0, -1).includes('\r')) return f;
      }
      throw new Error('no CR-free TELEM frame');
    },
    telemDecode(p) {
      p = this.unstuff(p);
      if (p.length < 6 || p[0] !== 1) return null;
      const out = { type: 'telem', seq: p[1], clock: ((p[2] << 24) >>> 0) + (p[3] << 16) + (p[4] << 8) + p[5], readings: [], names: [] };
      const byCode = {}; for (const [f, [c, s]] of Object.entries(this.TELEM_Q)) byCode[c] = [f, s];
      for (let i = 6; i < p.length;) {
        if (p[i] === 0) i++;
        else if (p[i] === 1 && i + 9 <= p.length) {
          const q = byCode[p[i + 2]], raw = (p[i + 5] << 24) | (p[i + 6] << 16) | (p[i + 7] << 8) | p[i + 8];
          if (q) out.readings.push({ sensor: p[i + 1], field: q[0], value: Math.round(raw * q[1] * 1e6) / 1e6, age: (p[i + 3] << 8) | p[i + 4] });
          i += 9;
        } else if (p[i] === 2 && i + 4 <= p.length && i + 4 + p[i + 3] <= p.length) {
          out.names.push({ sensor: p[i + 1], dtype: this.TELEM_TYPES[p[i + 2]] || 'other', name: new TextDecoder().decode(new Uint8Array(p.slice(i + 4, i + 4 + p[i + 3]))) });
          i += 4 + p[i + 3];
        } else break;
      }
      return out;
    },
    // Every complete frame in a byte array (data out of a P25 PDU, or the serial pipe).
    scan(bytes) {
      const out = [], dec = new TextDecoder();
      for (let i = 0; i + 6 <= bytes.length; i++) {
        if (bytes[i] !== 0xA5 || bytes[i + 1] !== 0x4B) continue;
        const len = bytes[i + 3], end = i + 4 + len + 2;
        if (end > bytes.length) break;
        const body = bytes.slice(i + 2, i + 4 + len);
        if (crcDnp3(body) !== (bytes[end - 2] | (bytes[end - 1] << 8))) continue;
        const t = body[0], p = body.slice(2), s32 = j => (p[j] << 24) | (p[j + 1] << 16) | (p[j + 2] << 8) | p[j + 3], g24 = j => (p[j] << 16) | (p[j + 1] << 8) | p[j + 2];
        if (t === 1 && p.length >= 3) out.push({ type: 'text', dst: (p[0] << 16) | (p[1] << 8) | p[2], text: dec.decode(new Uint8Array(p.slice(3))) });
        else if ((t === 2 || t === 3) && p.length >= 10) {
          let rest = p.slice(10), call = '';
          if (t === 3 && rest.length >= 1 + rest[0]) { call = String.fromCharCode(...rest.slice(1, 1 + rest[0])); rest = rest.slice(1 + rest[0]); }
          out.push({ type: 'pos', lat: s32(0) / 1e6, lon: s32(4) / 1e6, symbol: String.fromCharCode(p[8], p[9]), call, comment: dec.decode(new Uint8Array(rest)) });
        }
        else if (t === 4 && p.length >= 7) out.push({ type: 'msg', dst: g24(0), src: g24(3), seq: p[6], text: dec.decode(new Uint8Array(p.slice(7))) });
        else if (t === 5 && p.length >= 7) out.push({ type: 'ack', dst: g24(0), src: g24(3), seq: p[6] });
        else if ((t === 6 || t === 7) && p.length >= 8) out.push({ type: t === 6 ? 'status' : 'preset', dst: g24(0), src: g24(3), seq: p[6], code: p[7], label: dec.decode(new Uint8Array(p.slice(8))) });
        else if (t === 8 && p.length >= 3) out.push({ type: 'hello', mode: p[0], nonce: (p[1] << 8) | p[2] });
        else if (t === 9 && p.length >= 5) out.push({ type: 'welcome', dst: g24(0), nonce: (p[3] << 8) | p[4] });
        else if (t === 10 && p.length >= 5) out.push({ type: 'locpoll', target: g24(0), method: p[3], seq: p[4] });
        else if (t === 11 && p.length >= 9) {   // LOC: dst, target, seq, status (0 fix, 1 no reply, 2 can't poll, 3 polling), flags [+ fix 13] + note
          let fix = null, rest = p.slice(9);
          if ((p[8] & 1) && rest.length >= 13) {
            const sp = (rest[8] << 8) | rest[9];
            fix = { lat: s32(9) / 1e6, lon: s32(13) / 1e6, speedKmh: sp === 0xFFFF ? null : sp / 10, ageS: (rest[10] << 8) | rest[11], source: ['other', 'sdm', 'lrrp'][rest[12]] || 'other' };
            rest = rest.slice(13);
          }
          out.push({ type: 'loc', dst: g24(0), target: g24(3), seq: p[6], status: p[7], fix, note: dec.decode(new Uint8Array(rest)) });
        }
        // BULLETIN (gateway -> every radio): dst (FFFFFF), id (2), priority (1 = urgent), minutes to expiry (2, 0 = never), text
        else if (t === 14 && p.length >= 12) out.push({ type: 'modbus', dst: g24(0), device: p[3], adu: p.slice(4) });
        else if (t === 15) { const tm = KellyFrame.telemDecode(p); if (tm) out.push(tm); }
        else if (t === 12 && p.length >= 8) out.push({ type: 'bulletin', dst: g24(0), id: (p[3] << 8) | p[4], urgent: !!(p[5] & 1), expiresMin: (p[6] << 8) | p[7], text: dec.decode(new Uint8Array(p.slice(8))) });
        i = end - 1;
      }
      return out;
    },
  };

  // --------------------------------------- P25 data calls out of CCR progress (UZC1)
  // UZC1 reports each PDU block separately (DUID 0C); an Rx line always carries 18 octets,
  // a header's last 6 being stale. Header: format (0x16 confirmed, 0x15 unconfirmed, 0x03
  // response), SAP, MFID, LLID, blocks, pad. Confirmed blocks: 2 octets serial/CRC-9 + 16
  // data; unconfirmed: 12 data. User data ends in pad + CRC-32.
  class PduAssembler {
    constructor() { this.cur = {}; }
    feed(dir, hex) {
      const b = Array.from(hexToBytes(hex)), fmt = b[0] & 0x1F;
      // An unconfirmed call's first data block is its 12-octet secondary header -- format 0x15 and a
      // valid CRC-16, so it looks exactly like a new header (it dropped every TP9400 GPS beacon).
      const cur = this.cur[dir], secondary = cur && !cur.confirmed && cur.blocks.length === 0;
      if (!secondary && [0x16, 0x15, 0x03].includes(fmt) && b.length >= 12 && crc16P25(b.slice(0, 10)) === ((b[10] << 8) | b[11])) {
        const h = { dir, format: fmt, confirmed: fmt === 0x16, response: fmt === 0x03, sap: b[1] & 0x3F,
          llid: (b[3] << 16) | (b[4] << 8) | b[5], n: b[6] & 0x7F, pad: b[7] & 0x1F, blocks: [] };
        if (h.response || !h.n) { h.user = []; this.cur[dir] = null; return h; }
        this.cur[dir] = h; return null;
      }
      const c = this.cur[dir];
      if (!c) return null;
      c.blocks.push(c.confirmed ? b.slice(2, 18) : b.slice(0, 12));
      if (c.blocks.length < c.n) return null;
      this.cur[dir] = null;
      const data = [].concat(...c.blocks);
      c.user = data.slice(0, Math.max(0, data.length - 4 - c.pad));
      return c;
    }
  }
  // What a completed PDU carries. Tait's compact extended addressing puts <source LLID>
  // <0xC0 | inner SAP> first: inner SAP 0x00 = Transparent-mode serial bytes, 0x32 (F2) =
  // Tait SDM location beacon (= scripts/p25x_sdm.py decode_tait_gps_fix / decode_tait_avl_report /
  // find_tait_location -- keep in step). The fix is 12 octets of BCD digits behind marker bits
  // (Tait's AVL report; SDRTrunk's Tait1200GPSMessage has the same layout), not binary integers.
  function decodeTaitFix(b) {
    if (b.length < 12) return null;
    if (!(b[0] & 0x80 && b[1] & 0x80 && b[2] & 0x80) || (b[3] & 0xC0) !== 0x80 || (b[7] & 0xE0) !== 0xA0
      || (b[11] & 0xC0) !== 0x80 || !(b[4] & 0x08) || !(b[8] & 0x08)) return null;
    const two = x => ((x >> 4) & 7) * 10 + (x & 15);
    const hh = two(b[0]), mi = two(b[1]), ss = two(b[2]), day = two(b[11]);
    const latD = [b[3] & 15, b[4] >> 4, b[4] & 7, b[5] >> 4, b[5] & 15, b[6] >> 4, b[6] & 15];
    const lonD = [b[7] & 15, b[8] >> 4, b[8] & 7, b[9] >> 4, b[9] & 15, b[10] >> 4, b[10] & 15];
    if (![b[0] & 15, b[1] & 15, b[2] & 15, b[11] & 15, ...latD, ...lonD].every(d => d <= 9)) return null;
    if (hh > 23 || mi > 59 || ss > 59 || day < 1 || day > 31) return null;
    const minutes = d => d[2] * 10 + d[3] + d[4] / 10 + d[5] / 100 + d[6] / 1000;
    const lat = latD[0] * 10 + latD[1] + minutes(latD) / 60;
    const lon = (b[7] & 0x10 ? 100 : 0) + lonD[0] * 10 + lonD[1] + minutes(lonD) / 60;
    if (lat > 90 || lon > 180) return null;
    const out = { lat: b[3] & 0x20 ? lat : -lat, lon: b[3] & 0x10 ? lon : -lon, utc: `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, day };
    const now = new Date();
    for (const back of [0, 1]) {   // the fix's day of month is today's (UTC), or yesterday's just after 00:00 UTC
      const d = new Date(now.getTime() - back * 86400000);
      if (d.getUTCDate() === day) { out.ageS = Math.round((now - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day, hh, mi, ss)) / 1000); break; }
    }
    return out;
  }
  const AVL_STATUS = ['new fix', 'no fix (old data)', 'GPS not operational', 'format error'];
  function decodeTaitAvl(r) {
    if (r.length < 3 || !(r[0] & 0x80)) return null;
    const n = ((r[0] >> 4) & 7) === 1 ? 4 : 2;   // report type 1 carries all 8 radio-ID digits
    const out = { status: r[0] & 3, statusText: AVL_STATUS[r[0] & 3], emergency: !!(r[0] & 0x04) };
    if (out.status <= 1) {
      const fix = decodeTaitFix(r.slice(1 + n, 13 + n));
      if (fix) {
        Object.assign(out, fix);
        const sp = r.slice(13 + n, 15 + n);
        if (sp.length === 2 && sp.every(x => (x >> 4) < 10 && (x & 15) < 10)) out.speedKmh = ((sp[0] >> 4) * 100 + (sp[0] & 15) * 10 + (sp[1] >> 4) + (sp[1] & 15) / 10) * 1.852;
      }
    }
    return out;
  }
  // u = de-blocked user data, 12-octet secondary header first; SDM type 0x73 at 12, the AVL report at 25.
  function findTaitLocation(u) {
    let rep = null;
    if (u.length >= 28 && u[12] === 0x73) rep = decodeTaitAvl(u.slice(25));
    if (!rep || (rep.status <= 1 && rep.lat == null)) {
      rep = null;
      for (let i = 3; i + 12 <= u.length; i++) { const f = decodeTaitFix(u.slice(i, i + 12)); if (f) { rep = decodeTaitAvl(u.slice(i - 3)) || f; break; } }
    }
    return rep;
  }

  // Tait SDM (F2 01 00 <len> 00 <text> = a text, F2 01 01 = a receipt). Unconfirmed
  // transparent calls carry a 12-octet secondary header (format 0x15) naming the source.
  function decodePdu(c) {
    const u = c.user || [], src3 = i => (u[i] << 16) | (u[i + 1] << 8) | u[i + 2];
    const base = { dir: c.dir, dst: c.llid, confirmed: c.confirmed, response: c.response };
    if (c.response) return Object.assign(base, { kind: 'ack' });
    if (c.sap === 0x1F && u.length >= 4 && (u[3] & 0xC0) === 0xC0) {
      const inner = u[3] & 0x3F, src = src3(0);
      if (inner === 0x32 && u[4] === 0x01 && u[5] === 0x00) return Object.assign(base, { kind: 'text', src, text: new TextDecoder().decode(new Uint8Array(u.slice(8, 8 + u[6]))) });
      if (inner === 0x32 && u[4] === 0x01 && u[5] === 0x01) return Object.assign(base, { kind: 'receipt', src });
      if (inner === 0x00) return Object.assign(base, { kind: 'transparent', src, data: u.slice(4), frames: KellyFrame.scan(u.slice(4)) });
      return Object.assign(base, { kind: 'sdm', src, inner });
    }
    if (!c.confirmed && u.length >= 12 && (u[0] & 0x1F) === 0x15) {
      const inner = u[1] & 0x3F, src = src3(3);
      if (inner === 0x00) return Object.assign(base, { kind: 'transparent', src, data: u.slice(12), frames: KellyFrame.scan(u.slice(12)) });
      if (inner === 0x1E) return Object.assign(base, { kind: 'gps-beacon', src, inner, loc: findTaitLocation(u) });
      return Object.assign(base, { kind: 'sdm', src, inner });
    }
    return Object.assign(base, { kind: 'data', sap: c.sap });
  }
  // LDU1 link control (UZC1 DUID 05): LCF 00 = group voice (TG + source), 03 = unit-to-unit.
  function decodeLc(hex) {
    const b = hexToBytes(hex);
    if (b.length < 9) return null;
    const u24 = i => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2], so = b[2];
    if (b[0] === 0x00) return { kind: 'group', tg: (b[4] << 8) | b[5], src: u24(6), emergency: !!(so & 0x80), encrypted: !!(so & 0x40) };
    if (b[0] === 0x03) return { kind: 'individual', dst: u24(3), src: u24(6), emergency: !!(so & 0x80), encrypted: !!(so & 0x40) };
    return { kind: 'other', lcf: b[0] };
  }

  // ------------------------------------------------- full command catalogue
  // Drives the Developer page's command builder: every CCDI and CCR command
  // Kelly knows, with typed parameters. danger: true -> typed confirmation.
  const n = (key, label, min, max, def) => ({ key, label, type: 'number', min, max, def });
  const s = (key, label, def = '', max = 200) => ({ key, label, type: 'text', def, max });
  const o = (key, label, options, def) => ({ key, label, type: 'select', options, def: def ?? options[0][0] });
  const b = (key, label, def = true) => ({ key, label, type: 'bool', def });
  const PW = [['4', 'High'], ['3', 'Medium'], ['2', 'Low'], ['1', 'Very low'], ['0', 'Off (Tx inhibit)'], ['9', 'Programmed default']];

  const CATALOG = [
    // ---- QUERY
    { id: 'q-model', group: 'Query', name: 'Model + CCDI version', build: () => cmd.model(), expect: 'm' },
    { id: 'q-ver', group: 'Query', name: 'Software versions', build: () => cmd.versions(), expect: 'v', multi: true },
    { id: 'q-serial', group: 'Query', name: 'Serial number', build: () => cmd.serial(), expect: 'n' },
    { id: 'q-sdm', group: 'Query', name: 'Get buffered SDM', build: () => cmd.getSdm(), expect: 's' },
    { id: 'q-op', group: 'Query', name: 'Operating time', params: [o('which', 'Counter', [['0', 'Operating time'], ['1', 'High-power Tx time'], ['2', 'Low-power Tx time']]), o('unit', 'Units', [['1', 'Hours'], ['0', 'Milliseconds']])], build: p => cmd.opTime(p.which, p.unit === '1') },
    { id: 'q-cctm', group: 'Query', name: 'CCTM measurement', params: [o('code', 'Measurement', [['047', 'PA temperature'], ['063', 'Averaged RSSI'], ['064', 'Raw RSSI'], ['318', 'Forward power'], ['319', 'Reverse power']])], build: p => cmd.cctm(p.code), expect: 'j', multi: true },
    { id: 'q-gps', group: 'Query', name: 'GPS position', build: () => cmd.gps(), expect: 'l' },
    // ---- CHANNEL
    { id: 'g-chan', group: 'Channel', name: 'Go to channel', params: [n('ch', 'Channel', 1, 9999, 1), s('zone', 'Zone (blank = current)', ''), b('forced', 'Force (even while transmitting)', false)], build: p => cmd.goToChannel(p.ch, p.zone, p.forced) },
    { id: 'f-chrep', group: 'Channel', name: 'Report current channel', build: () => cmd.reportChannel(), expect: 'p' },
    { id: 'f-chprog', group: 'Channel', name: 'Channel-change progress messages', params: [b('on', 'Enabled')], build: p => cmd.channelProgress(p.on) },
    // ---- AUDIO / RF
    { id: 'f-volctl', group: 'Audio & RF', name: 'CCDI volume control', params: [b('on', 'Enabled')], build: p => cmd.volumeControl(p.on) },
    { id: 'f-vol', group: 'Audio & RF', name: 'Set volume (0-25)', params: [n('lvl', 'Level', 0, 25, 12)], build: p => cmd.volume(p.lvl) },
    { id: 'f-mute', group: 'Audio & RF', name: 'Rx audio mute', params: [b('on', 'Muted')], build: p => cmd.rxMute(p.on) },
    { id: 'f-mon', group: 'Audio & RF', name: 'Monitor (squelch override)', params: [b('on', 'On')], build: p => cmd.monitor(p.on) },
    { id: 'f-sub', group: 'Audio & RF', name: 'Validate CTCSS/DCS on FFSK data', params: [b('on', 'Validate')], build: p => cmd.subaudibleValidate(p.on) },
    { id: 'f-pwr', group: 'Audio & RF', name: 'Transmit power', params: [o('lvl', 'Level', PW)], build: p => cmd.txPower(p.lvl) },
    { id: 'f-tx', group: 'Audio & RF', name: 'Force Tx / Rx (no Tx timer!)', params: [b('on', 'Transmit')], build: p => cmd.tx(p.on), danger: true },
    // ---- CALLS
    { id: 'd-grp', group: 'Calls', name: 'P25 group call', params: [n('id', 'Group ID', 0, 65535, 1)], build: p => cmd.groupCall(p.id) },
    { id: 'd-ind', group: 'Calls', name: 'P25 individual call', params: [n('id', 'Unit ID', 1, 16777214, 1)], build: p => cmd.individualCall(p.id) },
    { id: 'd-sel', group: 'Calls', name: 'Selcall dial', params: [s('num', 'Digits (0-9 A-F - V)', '12345', 32)], build: p => cmd.selcall(p.num) },
    { id: 'd-dtmf', group: 'Calls', name: 'DTMF dial', params: [s('num', 'Digits (0-9 A-D * # -)', '12345', 32)], build: p => cmd.dtmf(p.num) },
    { id: 'c-cancel', group: 'Calls', name: 'Cancel', params: [o('type', 'Cancel', [['0', 'Cancel call / emergency'], ['1', 'Delete queued SDMs'], ['3', 'Return to idle display']])], build: p => cmd.cancel(p.type) },
    // ---- P25 SERVICES
    { id: 's-alert', group: 'P25 services', name: 'Call alert', params: [n('id', 'Target unit', 1, 16777214, 1)], build: p => cmd.callAlert(p.id) },
    { id: 's-check', group: 'P25 services', name: 'Radio check', params: [n('id', 'Target unit', 1, 16777214, 1)], build: p => cmd.radioCheck(p.id) },
    { id: 's-msg', group: 'P25 services', name: 'Preset message (1-16)', params: [n('id', 'Target unit', 1, 16777214, 1), n('n', 'Message number', 1, 16, 1)], build: p => cmd.presetMessage(p.id, p.n) },
    { id: 's-stq', group: 'P25 services', name: 'Status query', params: [n('id', 'Target unit', 1, 16777214, 1)], build: p => cmd.statusQuery(p.id) },
    { id: 's-stu', group: 'P25 services', name: 'Status update (1-16)', params: [n('id', 'Target unit', 1, 16777214, 1), n('n', 'Status number', 1, 16, 1)], build: p => cmd.statusUpdate(p.id, p.n) },
    { id: 's-emerg', group: 'P25 services', name: 'Emergency alarm', params: [n('id', 'Target unit', 1, 16777214, 1)], build: p => cmd.emergencyAlarm(p.id), danger: true },
    // ---- DATA
    { id: 'd-ext', group: 'Data', name: 'External data message (text)', params: [n('id', 'Target unit (conventional SUID)', 1, 16777214, 1), s('text', 'Text (<=160 bytes)', 'hello from Kelly', 160)], build: p => externalMessage(p.id, p.text) },
    { id: 'd-exthex', group: 'Data', name: 'External data message (hex)', params: [s('target', 'Target (SUID, or ip-port on trunked)', '1'), s('hex', 'Data (ASCII hex)', '6869', 170)], build: p => cmd.extSend(p.target, p.hex.toUpperCase()) },
    { id: 'd-extsave', group: 'Data', name: 'External message SAVE part', params: [s('hex', 'Data (ASCII hex)', '6869', 172)], build: p => cmd.extSave(p.hex.toUpperCase()) },
    { id: 'f-sap', group: 'Data', name: 'P25 data SAP (0-63)', params: [n('sap', 'SAP', 0, 63, 0)], build: p => cmd.dataSap(p.sap) },
    { id: 'f-dest', group: 'Data', name: 'P25 data destination', params: [n('addr', 'Address (0 = none)', 0, 16777215, 0)], build: p => cmd.dataDest(p.addr) },
    { id: 'f-conf', group: 'Data', name: 'P25 data confirmed', params: [b('on', 'Confirmed')], build: p => cmd.dataConfirmed(p.on) },
    { id: 's-sdm', group: 'Data', name: 'SEND_SDM (GPS poll)', params: [n('lead', 'Lead-in (x20 ms)', 1, 255, 10), s('ident', 'Data identity (8, * = wildcard)', '00008001', 8), s('ret', 'Return address (blank = dispatch)', '', 8)], build: p => cmd.sendSdm(p.lead, p.ident, p.ret) },
    { id: 'f-sdmout', group: 'Data', name: 'SDM output on reception', params: [b('on', 'Enabled')], build: p => cmd.sdmOutput(p.on) },
    { id: 'f-sdmenc', group: 'Data', name: 'SDM caller-ID encode', params: [b('on', 'Enabled')], build: p => cmd.sdmCallerIdEncode(p.on) },
    { id: 'f-sdmdec', group: 'Data', name: 'SDM caller-ID decode', params: [b('on', 'Enabled')], build: p => cmd.sdmCallerIdDecode(p.on) },
    { id: 't-trans', group: 'Data', name: 'Enter Transparent mode', params: [s('esc', 'Escape character', '+', 1), o('mode', 'Modulation', [['H', 'P25'], ['0', 'FFSK']])], build: p => cmd.transparent(p.esc || '+', p.mode), danger: true },
    // ---- LOCATION
    { id: 'l-send', group: 'Location', name: 'Send my position', params: [o('idType', 'To', [['0', 'Individual'], ['2', 'Broadcast / group'], ['3', 'As in radio database']]), s('id', 'ID', '')], build: p => cmd.location(0, p.idType, p.idType === '3' ? '0' : p.id) },
    { id: 'l-poll', group: 'Location', name: 'Poll radio location', params: [n('id', 'Unit ID', 1, 16777214, 1)], build: p => cmd.pollLocation(p.id) },
    { id: 'l-ack', group: 'Location', name: 'Acknowledge emergency', params: [n('id', 'Unit ID', 1, 16777214, 1)], build: p => cmd.ackEmergency(p.id) },
    { id: 'l-logs', group: 'Location', name: 'Consolidated location logs', params: [s('id', 'Unit ID (or "local")', 'local')], build: p => cmd.locationLogs(p.id) },
    // ---- P25 SETTINGS
    { id: 'f-tg', group: 'P25 settings', name: 'Change talkgroup', params: [n('tg', 'Talkgroup', 0, 65535, 1)], build: p => cmd.talkgroup(p.tg) },
    { id: 'f-emerg', group: 'P25 settings', name: 'Emergency mode', params: [o('q', 'Action', [['0', 'Activate'], ['1', 'Activate (stealth)'], ['2', 'Deactivate'], ['3', 'Send duress ACK']])], build: p => cmd.emergency(p.q), danger: true },
    // ---- RADIO / UI
    { id: 'f-key-sim', group: 'Front panel', name: 'Simulate key press', params: [o('code', 'Key', Object.entries(KEYS).filter(([k]) => k in KEY_INDEX).map(([k, v]) => [k, v])), o('dur', 'Duration', [['1', '1/8 s'], ['2', '2/8 s'], ['4', '1/2 s'], ['8', '1 s'], ['9', 'Hold ON'], ['0', 'Release (OFF)']], '1')], build: p => cmd.key(p.code, p.dur) },
    { id: 'f-ui', group: 'Front panel', name: 'User controls', params: [o('q', 'Mode', [['2', 'Enabled (normal)'], ['1', 'Disable input only'], ['0', 'Disable all ("CCDI BUSY")']])], build: p => cmd.userControls(p.q) },
    { id: 'f-prog', group: 'Messages', name: 'PROGRESS messages', params: [b('on', 'Enabled')], build: p => cmd.progressMsgs(p.on) },
    { id: 'f-kp', group: 'Messages', name: 'Key-press progress messages', params: [b('on', 'Enabled')], build: p => cmd.keypressMsgs(p.on) },
    { id: 'f-nac', group: 'Messages', name: 'NAC progress messages', params: [b('on', 'Enabled')], build: p => cmd.nacMsgs(p.on) },
    { id: 'f-ring', group: 'Messages', name: 'Selcall RING output', params: [b('on', 'Enabled')], build: p => cmd.selcallRing(p.on) },
    // ---- DIAGNOSTICS
    { id: 'f-diag', group: 'Diagnostics', name: 'CCDI diagnostic mode', params: [b('on', 'Enabled')], build: p => cmd.diagMode(p.on) },
    { id: 'w-freq', group: 'Diagnostics', name: 'Show channel Tx/Rx frequencies', build: () => cmd.diagFrequencies() },
    { id: 'w-sig', group: 'Diagnostics', name: 'Stream RSSI / BER / FEC', params: [b('rssi', 'RSSI'), b('ber', 'BER'), b('fec', 'Vocoder FEC'), n('iv', 'Interval (x100 ms)', 1, 600, 10)], build: p => cmd.diagSignal(p.rssi, p.ber, p.fec, p.iv) },
    { id: 'w-tone', group: 'Diagnostics', name: 'Transmit 1011 Hz test tone', params: [b('on', 'Transmit'), b('ber', 'With 5% BER', false)], build: p => p.ber ? cmd.diagTestToneBer(p.on) : cmd.diagTestTone(p.on), danger: true },
    { id: 'f-ccr', group: 'Diagnostics', name: 'Enter CCR mode', build: () => cmd.enterCCR(), danger: true },

    // ---- CCR (only valid once in CCR mode)
    { id: 'R', ccr: true, group: 'CCR', name: 'Rx frequency', params: [n('hz', 'Frequency (Hz)', 1e6, 999999999, 438000000)], build: p => ccr.rxFreq(p.hz) },
    { id: 'T', ccr: true, group: 'CCR', name: 'Tx frequency', params: [n('hz', 'Frequency (Hz)', 1e6, 999999999, 438000000)], build: p => ccr.txFreq(p.hz) },
    { id: 'H', ccr: true, group: 'CCR', name: 'Bandwidth', params: [o('bw', 'Bandwidth', [['1', 'Narrow'], ['2', 'Medium'], ['3', 'Wide']])], build: p => ccr.bandwidth(p.bw) },
    { id: 'J', ccr: true, group: 'CCR', name: 'Volume (0-255)', params: [n('v', 'Level', 0, 255, 128)], build: p => ccr.volume(p.v) },
    { id: 'A', ccr: true, group: 'CCR', name: 'Rx CTCSS', params: [n('hz', 'Tone Hz (0 = off)', 0, 254.1, 0)], build: p => ccr.rxCtcss(p.hz) },
    { id: 'B', ccr: true, group: 'CCR', name: 'Tx CTCSS', params: [n('hz', 'Tone Hz (0 = off)', 0, 254.1, 0)], build: p => ccr.txCtcss(p.hz) },
    { id: 'C', ccr: true, group: 'CCR', name: 'Rx DCS', params: [s('code', 'Octal code (000 = off)', '000', 3)], build: p => ccr.rxDcs(p.code) },
    { id: 'D', ccr: true, group: 'CCR', name: 'Tx DCS', params: [s('code', 'Octal code (000 = off)', '000', 3)], build: p => ccr.txDcs(p.code) },
    { id: 'S', ccr: true, group: 'CCR', name: 'Encode selcall', params: [s('seq', 'Tones', '12345', 33)], build: p => ccr.selcall(p.seq) },
    { id: 'I', ccr: true, group: 'CCR', name: 'Selcall parameters', params: [o('t', 'Tone set', [['0', 'CCIR'], ['1', 'EIA'], ['2', 'EEA'], ['3', 'ZVEI-I'], ['4', 'ZVEI-II'], ['5', 'ZVEI-III'], ['6', 'PZVEI'], ['7', 'NATEL'], ['8', 'DZVEI']]), o('p', 'Tone period', [['1', '20 ms'], ['2', '33 ms'], ['3', '40 ms'], ['4', '50 ms'], ['5', '60 ms'], ['6', '70 ms'], ['7', '100 ms']]), n('l', 'Notify tones', 0, 9, 5)], build: p => ccr.selcallParams(p.t, p.p, p.l) },
    { id: 'N', ccr: true, group: 'CCR', name: 'ANI', params: [o('pos', 'Position', [['0', 'Off'], ['1', 'Leading'], ['2', 'Trailing'], ['3', 'Both']]), s('seq', 'Tones (5-8)', '12345', 8)], build: p => ccr.ani(p.pos, p.seq) },
    { id: 'M', ccr: true, group: 'CCR', name: 'Monitor', params: [b('on', 'Monitor (mute off)')], build: p => ccr.monitor(p.on) },
    { id: 'P', ccr: true, group: 'CCR', name: 'Tx power', params: [o('p', 'Power', [['4', 'High'], ['3', 'Medium'], ['2', 'Low'], ['1', 'Very low']])], build: p => ccr.power(p.p) },
    { id: 'Q', ccr: true, group: 'CCR', name: 'Pulse (ping)', build: () => ccr.pulse(), expect: 'Q' },
    { id: 'UA', ccr: true, group: 'CCR', name: 'Set radio unit ID (radio resets)', params: [n('id', 'Unit ID', 1, 9999999, 1)], build: p => ccr.unitId(p.id), danger: true },
    { id: 'UB', ccr: true, group: 'CCR', name: 'Set talkgroup', params: [n('tg', 'Talkgroup', 0, 65535, 1)], build: p => ccr.talkgroup(p.tg) },
    { id: 'UC', ccr: true, group: 'CCR', name: 'P25 modulation', params: [o('m', 'Modulation', [['1', 'C4FM'], ['2', 'CQPSK'], ['3', 'Wide pulse'], ['4', 'TSM NB']])], build: p => ccr.modulation(p.m) },
    { id: 'UD', ccr: true, group: 'CCR', name: 'Rx NAC', params: [s('nac', 'NAC (hex)', '293', 3)], build: p => ccr.rxNac(p.nac) },
    { id: 'UE', ccr: true, group: 'CCR', name: 'Tx NAC', params: [s('nac', 'NAC (hex)', '293', 3)], build: p => ccr.txNac(p.nac) },
    { id: 'UY', ccr: true, group: 'CCR', name: 'Signal & position reporting', params: [b('on', 'Enabled'), n('ms', 'Interval ms (>=500)', 500, 65535, 1000)], build: p => ccr.signalReport(p.on, p.ms) },
    { id: 'UZA', ccr: true, group: 'CCR P25 API', name: 'Test mode (needed by every other UZ command)', params: [b('on', 'Enabled')], build: p => ccr.p25('A', p.on ? '1' : '0') },
    { id: 'UZB', ccr: true, group: 'CCR P25 API', name: 'Modulation mode', params: [o('m', 'Mode', [['1', 'P25'], ['0', 'Analog'], ['2', 'Analog dual-mode']])], build: p => ccr.p25('B', p.m) },
    { id: 'UZC', ccr: true, group: 'CCR P25 API', name: 'P25 progress (raw frames)', params: [b('on', 'Enabled')], build: p => ccr.p25('C', p.on ? '1' : '0') },   // 1 enables (TM9100, 2026-10-08)
    { id: 'UZD', ccr: true, group: 'CCR P25 API', name: 'Test tone', params: [o('t', 'Tone', [['0', 'Clear'], ['1', '1011 Hz'], ['2', 'Cal'], ['3', 'Silence']])], build: p => ccr.p25('D', p.t), danger: true },
    { id: 'UZE', ccr: true, group: 'CCR P25 API', name: 'Radio info', build: () => ccr.p25('E') },
    { id: 'UZF', ccr: true, group: 'CCR P25 API', name: 'Get P25 settings', build: () => ccr.p25('F') },
    { id: 'UZG', ccr: true, group: 'CCR P25 API', name: 'Send custom TSBK', params: [s('hex', '24 hex chars', '', 24)], build: p => ccr.p25('G', p.hex.toUpperCase()), danger: true },
    { id: 'UZH', ccr: true, group: 'CCR P25 API', name: 'Send custom LDU1', params: [s('hex', '22 hex chars', '', 22)], build: p => ccr.p25('H', p.hex.toUpperCase()), danger: true },
    { id: 'UZK', ccr: true, group: 'CCR P25 API', name: 'Transmission', params: [b('on', 'Start')], build: p => ccr.p25('K', p.on ? '1' : '0'), danger: true },
    { id: 'UZN', ccr: true, group: 'CCR P25 API', name: 'Version info', params: [o('w', 'Item', [['0', 'Serial number'], ['1', 'Software'], ['2', 'Boot loader'], ['3', 'FPGA'], ['4', 'Hardware']])], build: p => ccr.p25('N', p.w) },
    { id: 'UZO', ccr: true, group: 'CCR P25 API', name: 'Mute radio', params: [b('on', 'Force mute')], build: p => ccr.p25('O', p.on ? '1' : '0') },
    { id: 'E', ccr: true, group: 'CCR', name: 'Exit CCR (radio reboots)', build: () => ccr.exit(), danger: true },
  ];

  const CCDI = {
    checksum, frame, textToHex, hexToText, hexToBytes, hex2,
    cmd, ccr, externalMessage, Parser, decodeLine, splitFrame, parseNmea, decodeTsbk,
    tsbk, KellyFrame, PduAssembler, decodePdu, decodeLc, crc16P25, crcDnp3, findTaitLocation, decodeTaitFix,
    MODELS, ERRORS, KEYS, KEY_INDEX, PROGRESS, RING_T1, RING_T3, RING_T4, SERVICES, CCTM, P25_DUID, CATALOG,
    callerIdFormat: 'auto',
    // Turn a typed short form ("q0", "f041") into a full frame.
    autoFrame(text) {
      text = text.replace(/\r?\n$/, '');
      if (!text) return '';
      const f = splitFrame(text);
      if (f && f.lengthOk && f.checksumOk) return text + '\r';
      return frame(text[0], text.slice(1));
    },
  };
  root.CCDI = CCDI;
  if (typeof module !== 'undefined') module.exports = CCDI;
})(typeof window !== 'undefined' ? window : globalThis);
