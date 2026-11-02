/* Kelly Page -- KF file container: radio configs (and their catalogue / requests) over the P25X
 * SSTV link (js/sstv.js, mime 10). Same format as the dashboard's "Radio configs" section in
 * gateway/server.js (kfEncode / kfDecode) -- keep the two in step:
 *   'K' 'F' 01 | kind | method | size(4 BE) | crc32(4 BE) | model(len8) | name(len8, utf-8) | note(len8, utf-8) | body
 *   kind 1 = file, 2 = list (JSON), 3 = request (JSON {op: 'list', model} / {op: 'get', id})
 *   method 0 = stored, 1 = zlib deflate (CompressionStream 'deflate' = Node zlib.deflate)
 * Short forms (SHORT frames, js/sstv.js -- one frame, no START/END), first byte 0x80 | kind:
 *   request  83 | op code (OPS index, 0 = the op is in the JSON) | JSON of the other fields (none = no bytes)
 *   others   8k | method (0 stored, 2 raw deflate) | body           (no model/name/note, size or CRC-32:
 *            the frame's CRC-16 covers it)
 *   OPS is append-only and shared with the dashboard's KF_OPS -- never reorder or reuse a code.
 * size + crc32 are of the ORIGINAL bytes and are checked after inflating, so decode() only ever
 * returns a file that is byte-for-byte what was sent (the link's own CRC-32 covers the container).
 * Pure: no DOM, no radio.
 */
(function () {
  'use strict';
  const MIME = 'application/x-kelly-kf';
  const KIND = { FILE: 1, LIST: 2, REQUEST: 3 };
  const OPS = ['', 'list', 'get', 'wx', 'wxsub', 'radar', 'cam', 'web', 'wxobs', 'aprsnear', 'meshnear', 'meshboard', 'meshsub', 'bbs', 'rtty',
    'share', 'upd', 'updseg', 'calls', 'directory', 'aliases', 'tracks', 'insights', 'heard', 'calllist', 'grid', 'dams', 'fires', 'spacewx', 'tle',
    'igwl', 'igwlput', 'igpos', 'hdir', 'hdirput', 'igcm', 'igcmput', 'auth'];
  const MODELS = ['TM9100', 'TP9100', 'TM9400', 'TP9400', 'TP9900'];
  const enc = new TextEncoder(), dec = new TextDecoder();
  const canZip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  const deflate = bytes => pipe(bytes, new CompressionStream('deflate'));
  const inflate = bytes => pipe(bytes, new DecompressionStream('deflate'));
  const inflateRaw = bytes => pipe(bytes, new DecompressionStream('deflate-raw'));

  function str(v, max) {
    let b = enc.encode(String(v || ''));
    if (b.length > max) { b = b.slice(0, max); while (b.length && (b[b.length - 1] & 0xC0) === 0x80) b = b.slice(0, -1); }   // don't split a UTF-8 char
    return [b.length, ...b];
  }

  async function encode({ kind, model = '', name = '', note = '', body }) {
    const crc = KellySstv.crc32(body);
    let method = 0, payload = body;
    if (canZip) { const z = await deflate(body); if (z.length < body.length) { method = 1; payload = z; } }
    const head = [0x4B, 0x46, 1, kind, method, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255,
      (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255, ...str(model, 16), ...str(name, 120), ...str(note, 120)];
    const out = new Uint8Array(head.length + payload.length);
    out.set(head, 0); out.set(payload, head.length);
    return out;
  }

  // A request in the short form: {op, ...fields} -> 83 | op code | JSON of the fields.
  function shortRequest(obj) {
    const { op, ...rest } = obj, code = Math.max(0, OPS.indexOf(op));
    const args = code ? rest : obj, json = Object.keys(args).length ? enc.encode(JSON.stringify(args)) : new Uint8Array(0);
    const out = new Uint8Array(2 + json.length);
    out[0] = 0x80 | KIND.REQUEST; out[1] = code; out.set(json, 2);
    return out;
  }
  async function decodeShort(buf) {
    const kind = buf[0] & 0x7F;
    let body;
    if (kind === KIND.REQUEST) {
      const code = buf[1], rest = buf.length > 2 ? JSON.parse(dec.decode(buf.slice(2))) : {};
      body = enc.encode(JSON.stringify(code ? { ...rest, op: OPS[code] } : rest));
    } else if (buf[1] === 0) body = buf.slice(2);
    else if (buf[1] === 2) { if (!canZip) throw new Error("this browser can't decompress -- update it"); body = await inflateRaw(buf.slice(2)); }
    else throw new Error(`unknown packing ${buf[1]}`);
    return { kind, model: '', name: '', note: '', body, wire: buf.length, short: true };
  }

  async function decode(buf) {
    if (buf.length >= 2 && buf[0] & 0x80) return decodeShort(buf);
    if (buf.length < 16 || buf[0] !== 0x4B || buf[1] !== 0x46 || buf[2] !== 1) throw new Error('not a Kelly file');
    const kind = buf[3], method = buf[4];
    const size = ((buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8]) >>> 0, crc = ((buf[9] << 24) | (buf[10] << 16) | (buf[11] << 8) | buf[12]) >>> 0;
    let o = 13;
    const s = () => { const n = buf[o]; const v = dec.decode(buf.slice(o + 1, o + 1 + n)); o += 1 + n; return v; };
    const model = s(), name = s(), note = s();
    if (o > buf.length) throw new Error('file header cut short');
    const raw = buf.slice(o);
    let body;
    if (method === 0) body = raw;
    else if (method === 1) { if (!canZip) throw new Error("this browser can't decompress -- update it"); body = await inflate(raw); }
    else throw new Error(`unknown packing ${method}`);
    if (body.length !== size || KellySstv.crc32(body) !== crc) throw new Error(`content check failed (${body.length} of ${size} bytes) -- not saved`);
    return { kind, model, name, note, body, wire: buf.length };
  }

  // The radio's model family from Kelly's MODEL report ("TM9155" -> TM9100), or from a Tait programming
  // file's extension (.m91p TM9100, .p91p TP9100, .m94p TM9400, .p94p TP9400, .p99p TP9900), or ''.
  function family(model) {
    const m = /^(T[MP])9([149])/.exec(String(model || '').toUpperCase());
    if (m) return `${m[1]}9${m[2]}00`;
    const x = /\.([MP])9([149])P$/.exec(String(model || '').toUpperCase());
    return x ? `T${x[1]}9${x[2]}00` : '';
  }

  window.KellyFiles = { MIME, KIND, MODELS, OPS, canZip, encode, decode, family, shortRequest,
    // a full-form request carries this copy's version (kv) and whether it can install a delta in place (kd),
    // so the gateway knows who needs an update and what to send (Kelly updates). The SHORT path (app.js
    // rfSendContainer) sends them only now and then -- the gateway remembers them per radio. .req = the
    // request itself, for that path.
    request: async obj => {
      const req = { kv: String(window.KELLY_VERSION || ''), kd: typeof window.showDirectoryPicker === 'function' ? 1 : 0, ...obj };
      const out = await encode({ kind: KIND.REQUEST, body: enc.encode(JSON.stringify(req)) });
      out.req = req;
      return out;
    },
    json: body => JSON.parse(dec.decode(body)) };
})();
