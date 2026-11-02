// mesh.html (kellypage.app/mesh launcher): no third-party URLs, the browser-support banners for each kind of browser, the
// QR maker. Runs the page's inline script against a tiny fake DOM. Node 22+.
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'mesh.html'), 'utf8');
let pass = 0; const fails = [];
const t = (name, ok, got) => { if (ok) pass++; else { fails.push(name); console.log(`FAIL ${name}${got !== undefined ? '  got ' + JSON.stringify(got) : ''}`); } };

// no third-party scripts / fonts / CDNs / trackers: every src/href/url() is a relative file of this site
const urls = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map(m => m[1]).concat([...html.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]));
t('no absolute or protocol-relative URLs in src/href/url()', urls.every(u => !/^([a-z]+:)?\/\//i.test(u) && !/^https?:/i.test(u)), urls);
t('the scripts are this site\'s own (js/meshqr.js + inline)', [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).join() === 'js/meshqr.js');
t('no @import, no fetch, no XHR, no analytics', !/@import|fetch\(|XMLHttpRequest|gtag|analytics|googletag/i.test(html));
t('opens Kelly on LoRa Mesh > Ham Contacts', /href="index\.html#mesh-contacts"/.test(html));
const mesh = fs.readFileSync(path.join(__dirname, '..', 'js', 'mesh.js'), 'utf8');
t('mesh.js opens the Ham Contacts tab for #mesh-contacts', /location\.hash === '#mesh-contacts'\) setTimeout\(\(\) => showMeshTab\('contacts'\)/.test(mesh));

const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
function run(nav, secure = true) {
  const els = {};
  const get = id => els[id] || (els[id] = { id, hidden: true, innerHTML: '', textContent: '', value: '', onclick: null });
  const sandbox = { document: { getElementById: get }, navigator: nav, window: null, console };
  sandbox.window = sandbox; sandbox.isSecureContext = secure;
  vm.runInNewContext(script, sandbox);
  return { els, get, sandbox };
}
const text = e => (e.hidden ? '' : e.innerHTML);
let r = run({ userAgent: 'Mozilla/5.0 Chrome/130', platform: 'Win32', maxTouchPoints: 0, serial: {}, bluetooth: {} });
t('Chrome/Edge desktop: green banner, USB and Bluetooth', /Web Serial/.test(text(r.get('b-ok'))) && /Bluetooth/.test(text(r.get('b-ok'))) && r.get('b-bad').hidden && r.get('c-ios').hidden);
r = run({ userAgent: 'Mozilla/5.0 Firefox/130', platform: 'Win32', maxTouchPoints: 0 });
t('Firefox: told to use Chrome or Edge on desktop or Android', /Chrome or Edge/.test(text(r.get('b-bad'))) && /Firefox and Safari/.test(text(r.get('b-bad'))), text(r.get('b-bad')));
r = run({ userAgent: 'Mozilla/5.0 (Macintosh) Version/17 Safari/605', platform: 'MacIntel', maxTouchPoints: 0 });
t('desktop Safari: same advice', /Chrome or Edge/.test(text(r.get('b-bad'))));
r = run({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604', platform: 'iPhone', maxTouchPoints: 5 });
t('iPhone: MeshCore app + QR import, iOS card shown', /MeshCore app/.test(text(r.get('b-warn'))) && r.get('c-ios').hidden === false && /Scan QR/.test(html));
r = run({ userAgent: 'Mozilla/5.0 (Macintosh) Safari', platform: 'MacIntel', maxTouchPoints: 5 });
t('iPad (Mac UA with touch): treated as iOS', r.get('c-ios').hidden === false);
r = run({ userAgent: 'Chrome Android', platform: 'Linux armv8l', maxTouchPoints: 5, bluetooth: {} });
t('Android Chrome without Serial: Bluetooth banner', /Bluetooth/.test(text(r.get('b-ok'))) && !/USB \(Web Serial\)<\/b>\./.test(text(r.get('b-ok'))));
r = run({ userAgent: 'Chrome', platform: 'Win32', maxTouchPoints: 0, serial: {} }, false);
t('an insecure page is told to use https', /https/.test(text(r.get('b-warn'))));

// the QR maker (js/meshqr.js builds the link; drawing is the browser's)
const Q = require('../js/meshqr.js');
r = run({ userAgent: 'Chrome', platform: 'Win32', maxTouchPoints: 0, serial: {}, bluetooth: {} });
r.sandbox.KellyMeshQR = Object.assign({}, Q, { svg: async (l) => `<svg data-link="${l}"></svg>` });
r.get('q-name').value = 'VK4ABC Home'; r.get('q-key').value = 'AB'.repeat(32); r.get('q-type').value = '1';
r.get('q-go').onclick();
setTimeout(() => {
  t('QR maker: a meshcore://contact/add link, key lower-cased', /data-link="meshcore:\/\/contact\/add\?name=VK4ABC\+Home&public_key=(ab){32}&type=1"/.test(r.get('qr').innerHTML), r.get('qr').innerHTML);
  r.get('q-key').value = 'nothex'; r.get('q-go').onclick();
  t('QR maker: a bad key says so, no QR', r.get('q-msg').textContent.length > 0 && r.get('qr').innerHTML === '', r.get('q-msg').textContent);
  console.log(`${pass} passed, ${fails.length} failed`);
  console.log(fails.length ? `RESULT: FAIL (${fails.join(', ')})` : 'RESULT: ALL PASS');
  process.exit(fails.length ? 1 : 0);
}, 50);
