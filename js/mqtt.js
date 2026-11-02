/* Kelly Page -- minimal MQTT 3.1.1 publisher over WebSocket (QoS 0 only).
 * Enough to push radio events into a broker that has a websockets listener
 * (e.g. Mosquitto "listener 9001 / protocol websockets"). No subscribe.
 */
(function (root) {
  'use strict';
  const enc = new TextEncoder();
  const str = s => { const b = enc.encode(s); return [b.length >> 8, b.length & 0xFF, ...b]; };
  const remLen = n => { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; out.push(d); } while (n > 0); return out; };

  class KellyMqtt {
    constructor() { this.ws = null; this.connected = false; this.onState = () => {}; this.ping = null; }
    connect({ url, clientId, username, password, keepalive = 60 }) {
      return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(url, ['mqtt']); } catch (e) { reject(e); return; }
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
          let flags = 0x02; const payload = [...str(clientId || 'kelly-' + Math.random().toString(16).slice(2, 8))];
          if (username) { flags |= 0x80; payload.push(...str(username)); }
          if (password) { flags |= 0x40; payload.push(...str(password)); }
          const vh = [...str('MQTT'), 4, flags, keepalive >> 8, keepalive & 0xFF];
          ws.send(new Uint8Array([0x10, ...remLen(vh.length + payload.length), ...vh, ...payload]));
        };
        ws.onmessage = ev => {
          const b = new Uint8Array(ev.data);
          if (b[0] === 0x20) {
            if (b[3] === 0) {
              this.ws = ws; this.connected = true; this.onState('connected');
              this.ping = setInterval(() => { try { ws.send(new Uint8Array([0xC0, 0])); } catch {} }, keepalive * 500);
              resolve();
            } else reject(new Error(`broker refused connection (code ${b[3]})`));
          }
        };
        ws.onerror = () => reject(new Error('cannot reach MQTT broker'));
        ws.onclose = () => { clearInterval(this.ping); this.connected = false; this.ws = null; this.onState('closed'); };
      });
    }
    publish(topic, message, retain = false) {
      if (!this.connected) return false;
      const body = [...str(topic), ...enc.encode(typeof message === 'string' ? message : JSON.stringify(message))];
      this.ws.send(new Uint8Array([0x30 | (retain ? 1 : 0), ...remLen(body.length), ...body]));
      return true;
    }
    disconnect() { if (this.ws) { try { this.ws.send(new Uint8Array([0xE0, 0])); } catch {} this.ws.close(); } }
  }
  root.KellyMqtt = KellyMqtt;
})(window);
