/* Kelly Page -- install on a phone / desktop (Phase 13). Registers sw.js and offers "Install Kelly".
 *
 * Only on a secure page (https from the bridge's --tls, or localhost): a service worker can't run anywhere else, and
 * file:// or plain-http Kelly carries on exactly as before. Never for the Pi keeper (&keeper): it's a headless tab.
 * ?nosw unregisters the worker and clears its caches (a bench escape hatch).
 *
 * Android / desktop Chrome + Edge: the browser's own install prompt, kept for an "Install Kelly" bar (dismissed = gone
 * for 30 days). iPhone / iPad: no prompt exists, so a one-time hint says Share > Add to Home Screen.
 * window.KellyPwa = { canInstall(), install(), standalone() } for a menu item later.
 */
(function () {
  'use strict';
  const q = location.search, store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const secure = window.isSecureContext && /^https?:$/.test(location.protocol);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let prompt = null, bar = null;

  if (/[?&]nosw\b/.test(q)) {
    // after load, so the worker that served this page has finished writing to its cache
    addEventListener('load', async () => {
      try {
        if ('serviceWorker' in navigator) await Promise.all((await navigator.serviceWorker.getRegistrations()).map(r => r.unregister()));
        if (window.caches) await Promise.all((await caches.keys()).filter(k => k.startsWith('kelly-')).map(k => caches.delete(k)));
      } catch { /* nothing to remove */ }
    });
  } else if (secure && 'serviceWorker' in navigator && !/[?&]keeper\b/.test(q)) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('Kelly offline copy', e.message)));
  }

  function show(html, onGo) {
    if (bar || standalone() || /[?&](keeper|nosplash)\b/.test(q)) return;
    bar = document.createElement('div');
    bar.id = 'kelly-install';
    bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Install Kelly');
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9000;'
      + 'display:flex;gap:10px;align-items:center;max-width:calc(100vw - 32px);padding:8px 10px 8px 12px;border-radius:12px;'
      + 'background:var(--panel-solid,#0d152a);color:var(--text,#e8f1ff);border:1px solid var(--line2,#2c3e68);'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.5);font:600 14px/1.3 var(--ui,system-ui,sans-serif)';
    bar.innerHTML = `<img src="assets/icons/kelly-192.png" alt="" width="28" height="28" style="border-radius:7px">
      <span style="flex:1">${html}</span>
      ${onGo ? '<button type="button" data-go style="min-height:44px;padding:0 14px;border-radius:8px;border:0;background:var(--cyan,#00e5ff);color:#04101c;font:inherit;cursor:pointer">Install</button>' : ''}
      <button type="button" data-x aria-label="Not now" style="min-width:44px;min-height:44px;border:0;background:none;color:inherit;font:inherit;font-size:18px;cursor:pointer">✕</button>`;
    bar.querySelector('[data-x]').onclick = () => { store.set('kellyInstallLater', String(Date.now())); hide(); };
    if (onGo) bar.querySelector('[data-go]').onclick = onGo;
    document.body.appendChild(bar);
  }
  function hide() { if (bar) bar.remove(); bar = null; }
  const later = () => Date.now() - (+store.get('kellyInstallLater') || 0) < 30 * 86400000;

  async function install() {
    if (!prompt) return false;
    const p = prompt; prompt = null; hide();
    p.prompt();
    const r = await p.userChoice.catch(() => null);
    return !!(r && r.outcome === 'accepted');
  }

  addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); prompt = e;
    if (!later()) show('Install Kelly as an app on this device', install);
  });
  addEventListener('appinstalled', () => { prompt = null; hide(); });
  // iOS Safari: installable only by hand, and only Safari can do it
  if (secure && /iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone() && !store.get('kellyIosHint'))
    addEventListener('load', () => setTimeout(() => { store.set('kellyIosHint', '1'); show('Install Kelly: tap Share, then <b>Add to Home Screen</b>'); }, 4000));

  window.KellyPwa = { canInstall: () => !!prompt, install, standalone };
})();
