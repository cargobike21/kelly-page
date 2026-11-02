// Kelly Page -- secure context helper (Phase 8, HTTPS). Pure, no DOM; load before transport.js.
//
// Browsers only give GPS, the camera, Web Bluetooth, service workers (offline / install) and the Cache API to a
// "secure context": https://, or http://localhost. Kelly opened from a Pi or another computer over plain http:// on
// the LAN or tailnet isn't one, so those features must say why they're greyed out instead of failing quietly.
//
//   KellySecure.secure              true when this page is a secure context
//   KellySecure.can(feature)        true if that feature can run here ('gps', 'camera', 'bluetooth', 'serial',
//                                   'offline', 'install', 'cache', 'wakelock', 'clipboard'; anything else -> secure)
//   KellySecure.why(feature)        '' when it can, else one plain sentence: what's missing and the fix
//   KellySecure.wsUrl(url)          a bridge WebSocket URL fit for this page: ws:// -> wss:// when the page is
//                                   https (else the browser blocks it as mixed content); ws://localhost is left alone
//                                   unless it's this page's own host (the bridge is then serving https itself)
//   KellySecure.httpUrl(url)        the same for an http:// API address (http -> https)
//   KellySecure.make(root)          the same API for another window-like object (tests)
(function (glob) {
  'use strict';
  function make(root) {
    const loc = root.location || { protocol: 'file:', host: '', hostname: '' };
    const secure = !!root.isSecureContext;
    const HELP = 'open Kelly over https -- see bridge/HTTPS.md (or use it on this computer at http://localhost:8025)';

    // what each feature needs beyond a secure context: the browser API, and a short name for the sentence
    const NEEDS = {
      gps: ['GPS', () => !!(root.navigator && root.navigator.geolocation)],
      camera: ['The camera', () => !!(root.navigator && root.navigator.mediaDevices && root.navigator.mediaDevices.getUserMedia)],
      bluetooth: ['Bluetooth', () => !!(root.navigator && root.navigator.bluetooth)],
      serial: ['USB serial', () => !!(root.navigator && root.navigator.serial)],
      offline: ['Offline mode', () => !!(root.navigator && root.navigator.serviceWorker)],
      install: ['Installing Kelly as an app', () => !!(root.navigator && root.navigator.serviceWorker)],
      cache: ['Offline storage', () => !!root.caches],
      wakelock: ['Keeping the screen on', () => !!(root.navigator && root.navigator.wakeLock)],
      clipboard: ['Copy to clipboard', () => !!(root.navigator && root.navigator.clipboard)],
    };
    const isLoop = h => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(h);

    function can(feature) {
      if (!secure) return false;
      const n = NEEDS[feature];
      try { return n ? n[1]() : true; } catch (e) { return false; }
    }
    function why(feature) {
      if (can(feature)) return '';
      const name = (NEEDS[feature] || ['This feature'])[0];
      if (!secure) return `${name} needs a secure page, and this one is plain http:// -- ${HELP}.`;
      return feature === 'bluetooth' || feature === 'serial'
        ? `${name} isn't in this browser -- use Chrome or Edge on a computer or Android.`
        : `${name} isn't available in this browser.`;
    }
    // ws://host -> wss://host on an https page; a loopback bridge on another port keeps ws:// (browsers allow it)
    function wsUrl(url) {
      const u = String(url || '');
      if (loc.protocol !== 'https:' || !/^ws:\/\//i.test(u)) return u;
      const m = /^ws:\/\/([^/?#]+)/i.exec(u), host = m ? m[1] : '';
      if (isLoop(host.replace(/:\d+$/, '')) && host.toLowerCase() !== String(loc.host).toLowerCase()) return u;
      return 'wss://' + u.slice(5);
    }
    function httpUrl(url) {
      const u = String(url || '');
      return /^http:\/\//i.test(u) ? wsUrl('ws://' + u.slice(7)).replace(/^ws/i, 'http') : u;
    }

    return { secure, can, why, wsUrl, httpUrl, HELP, make };
  }
  const api = make(glob);
  if (typeof module === 'object' && module.exports) module.exports = api;
  glob.KellySecure = api;
})(typeof window !== 'undefined' ? window : globalThis);
