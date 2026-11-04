/* kellypage.app/mesh launcher (mesh.html): browser check + MeshCore contact QR. Its own file, not inline, for the CSP. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var ua = navigator.userAgent || '';
  var iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var hasSerial = 'serial' in navigator, hasBle = 'bluetooth' in navigator;
  var show = function (id, html) { var e = $(id); e.innerHTML = html; e.hidden = false; };

  if (iOS) {
    show('b-warn', '<b>iPhone / iPad:</b> this browser cannot connect to a MeshCore node. Use the MeshCore app and import contacts by QR (below).');
    $('c-ios').hidden = false;
    $('open').textContent = 'Open Kelly anyway (to browse the directory and make QR codes)';
  } else if (!hasSerial && !hasBle) {
    // Firefox / desktop Safari: neither API exists
    show('b-bad', '<b>This browser cannot connect to a node.</b> Use <b>Chrome or Edge</b> on a desktop computer, or Chrome on Android. (Firefox and Safari do not support Web Serial or Web Bluetooth.) You can still open Kelly to browse the directory and make QR codes.');
  } else if (hasSerial && hasBle) {
    show('b-ok', 'This browser can connect by <b>USB (Web Serial)</b> and <b>Bluetooth</b>.');
  } else if (hasSerial) {
    show('b-ok', 'This browser can connect by <b>USB (Web Serial)</b>. Bluetooth is not available here -- for a Bluetooth node use Chrome on Android.');
  } else {
    show('b-ok', 'This browser can connect by <b>Bluetooth</b>. USB (Web Serial) is not available here -- on a desktop use Chrome or Edge.');
  }
  if (!iOS && (hasSerial || hasBle) && !window.isSecureContext) show('b-warn', 'Open this page over <b>https://</b>: browsers only allow USB and Bluetooth on secure pages.');

  $('q-go').onclick = function () {
    var msg = $('q-msg'), box = $('qr'); box.innerHTML = ''; msg.textContent = '';
    var Q = window.KellyMeshQR;
    if (!Q) { msg.textContent = 'The QR code module did not load -- reload the page.'; return; }
    try {
      var link = Q.contactLink({ name: $('q-name').value.trim(), key: $('q-key').value.trim().toLowerCase(), type: +$('q-type').value });
      msg.textContent = 'Scan it in the MeshCore app: Contacts > Add contact > Scan QR.';
      Q.svg(link, { ecl: 'Q', quiet: 4, mm: 40 }).then(function (s) { box.innerHTML = s; }, function (e) { msg.textContent = String(e && e.message || e); });
    } catch (e) { msg.textContent = String(e && e.message || e); }
  };
})();
