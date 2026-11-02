/* Kelly Page service worker (Phase 13: install Kelly on a phone; registered by js/pwa.js on https or localhost only).
 *
 * The cache is named after js/version.js (KELLY_VERSION + KELLY_BUILT), which the browser re-checks with this file:
 * a release rewrites version.js, so the worker updates and the old cache is dropped.
 *   app shell (same-origin .html/.js/.css/images/sounds): served from the cache, refreshed behind (stale-while-
 *     revalidate), so a bench push of one file shows on the next reload even without a version change
 *   the page itself: network first, the cached copy when offline (stored without its query, so no ?token= is kept)
 *   never cached: the bridge's APIs and sockets (/api/*, /ws, /mesh, /ble, /ble-node), anything carrying a token,
 *     other origins (fonts, map tiles -- js/meshtiles.js keeps its own tile cache), non-GET, range requests
 */
self.window = self;   // version.js writes window.KELLY_VERSION
importScripts('js/version.js');
const CACHE = `kelly-${self.KELLY_VERSION || '0'}-${self.KELLY_BUILT || 'dev'}`;
const BASE = new URL('./', self.location).pathname;   // '/' on the bridge; a sub-folder elsewhere
const STATIC = /\.(html|js|css|svg|png|webmanifest|wav|mp3|ogg|woff2?|gif|webp|avif|ico)$/i;
const LIVE = /^(api\/|ws$|mesh$|ble$|ble-node$)/;   // the bridge's own endpoints, relative to BASE
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'assets/icons/kelly-192.png', 'assets/icons/kelly-512.png'];

const keyOf = url => new URL(url.pathname, url.origin).href;   // query dropped
function cacheable(req, url) {
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('range')) return false;
  if (!url.pathname.startsWith(BASE) || LIVE.test(url.pathname.slice(BASE.length)) || /[?&]token=/.test(url.search)) return false;
  return true;
}
const keep = r => r && r.ok && r.status === 200 && r.type === 'basic';

// install: the shell plus everything index.html loads (its script / stylesheet / icon tags), each on its own so one
// missing file doesn't stop the rest
self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open(CACHE), urls = new Set(SHELL);
  try {
    const html = await (await fetch('index.html', { cache: 'no-cache' })).text();
    for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"#?]+)"/g))
      if (!/^(?:[a-z]+:|\/\/)/i.test(m[1]) && STATIC.test(m[1])) urls.add(m[1]);
  } catch { /* offline while installing: the shell list only */ }
  await Promise.allSettled([...urls].map(async u => { const r = await fetch(u, { cache: 'no-cache' }); if (keep(r)) await c.put(keyOf(new URL(u, self.location)), r); }));
  await self.skipWaiting();   // the open page keeps the code it has; the next load gets this version
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('kelly-') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.mode === 'navigate' && /[?&]nosw\b/.test(url.search)) return;   // ?nosw: js/pwa.js is removing us -- write nothing
  const page = req.mode === 'navigate' && req.method === 'GET' && url.origin === self.location.origin
    && (url.pathname === BASE || url.pathname === `${BASE}index.html`);
  if (page) {   // network first; offline -> the cached page (a token in the address is fine: it never reaches the cache)
    e.respondWith((async () => {
      const c = await caches.open(CACHE), key = keyOf(new URL('index.html', self.location));
      try { const r = await fetch(req); if (keep(r)) e.waitUntil(c.put(key, r.clone())); return r; }
      catch (er) { return (await c.match(key)) || Response.error(); }
    })());
    return;
  }
  if (!cacheable(req, url) || !STATIC.test(url.pathname)) return;   // the browser handles it as if there were no worker
  e.respondWith((async () => {
    const c = await caches.open(CACHE), key = keyOf(url), hit = await c.match(key);
    const fresh = fetch(req).then(r => { if (keep(r)) return c.put(key, r.clone()).then(() => r); return r; });
    if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
    return fresh;
  })());
});
