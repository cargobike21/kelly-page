// js/registration.js Turnstile: the widget loads only on the hosted copy (https://kellypage.app), never elsewhere; the token is
// sent as `turnstile` in the register body and reset after each attempt. Node: node tests/turnstile-test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0; const fails = [];
const t = (name, ok, got) => { if (ok) pass++; else { fails.push(name); console.log(`FAIL ${name}${got !== undefined ? '  got ' + JSON.stringify(got) : ''}`); } };
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function page(origin, health) {
  const log = { scripts: [], fetches: [], bodies: [], renders: [], resets: 0 };
  const win = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { origin, search: '' }, log };
  win.window = win; win.self = win; win.globalThis = win;
  win.document = { head: { appendChild(s) { log.scripts.push(s.src); win.turnstile = { render(el, o) { log.renders.push(o); win.__opts = o; return 'w1'; }, reset() { log.resets++; } }; setTimeout(() => s.onload(), 0); } },
    createElement: () => ({}) };
  win.fetch = async (url, init) => {
    log.fetches.push(url);
    if (/\/api\/health/.test(url)) return { ok: true, json: async () => health };
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (/challenge/.test(url)) return { ok: true, json: async () => ({ nonce: 'n1' }) };
    log.bodies.push(body);
    return { ok: !win.__fail, status: win.__fail ? 403 : 200, json: async () => (win.__fail ? { error: 'turnstile failed' } : { status: 'pending' }) };
  };
  const ctx = vm.createContext(win);
  Object.assign(ctx, { TextEncoder, TextDecoder, Date, setInterval: () => 0, setTimeout, console });
  vm.runInContext(read('js/enttoken.js'), ctx);
  ctx.KellyIdent = { get: async () => ({ pub: 'PUB', kind: 'x', fp: 'F' }), sign: async () => new Uint8Array(64) };
  ctx.KellyEnt = { setToken() {} };
  vm.runInContext(read('js/registration.js'), ctx);
  return ctx;
}

(async () => {
  // off-origin: nothing loads, nothing is fetched, no turnstile field
  for (const origin of ['file://', 'http://localhost:8025', 'https://pi.local:8443', 'https://kellypage.app.evil.example', 'http://kellypage.app']) {
    const c = page(origin, {});
    const el = { hidden: true };
    const on = await c.KellyReg.turnstileInit(el);
    t(`${origin}: no widget, no script, no fetch`, on === false && c.log.scripts.length === 0 && c.log.fetches.length === 0 && el.hidden === true, c.log);
    await c.KellyReg.register('VK9TST', [5051234], '');
    t(`${origin}: register body has no turnstile`, c.log.bodies.length === 1 && !('turnstile' in c.log.bodies[0]), c.log.bodies);
  }

  // hosted: key from /api/health when given, the script loaded once, token in the body, reset after the attempt
  let c = page('https://kellypage.app', { ok: true, kid: 'kp-2026a', turnstile: 'hosted', sitekey: '0x4AAAAAAHealthKey' });
  let el = { hidden: true };
  t('hosted: widget renders', (await c.KellyReg.turnstileInit(el)) === true && el.hidden === false);
  t('hosted: explicit-render script loaded from challenges.cloudflare.com', c.log.scripts.length === 1 && c.log.scripts[0] === 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', c.log.scripts);
  t('hosted: the health sitekey is used', c.log.renders[0].sitekey === '0x4AAAAAAHealthKey', c.log.renders);
  await c.KellyReg.turnstileInit(el);
  t('hosted: a second init does not load or render again', c.log.scripts.length === 1 && c.log.renders.length === 1);
  let err = ''; try { await c.KellyReg.register('VK9TST', [5051234], ''); } catch (e) { err = e.message; }
  t('hosted: register without a token asks for the check and sends nothing', /human check/i.test(err) && c.log.bodies.length === 0, err);
  c.__opts.callback('TOKEN-1');
  await c.KellyReg.register('VK9TST', [5051234], '');
  t('hosted: the token is in the register body as `turnstile`', c.log.bodies.length === 1 && c.log.bodies[0].turnstile === 'TOKEN-1', c.log.bodies);
  t('hosted: the widget is reset after the attempt (single-use)', c.log.resets === 1);
  err = ''; try { await c.KellyReg.register('VK9TST', [5051234], ''); } catch (e) { err = e.message; }
  t('hosted: the used token is not sent again', /human check/i.test(err) && c.log.bodies.length === 1, err);
  c.__opts.callback('TOKEN-2'); c.__fail = true;
  err = ''; try { await c.KellyReg.register('VK9TST', [5051234], ''); } catch (e) { err = e.message; }
  t('hosted: a failed check says so and resets', err === 'Human check failed, please try again' && c.log.resets === 2, err);

  // the Worker's real /api/health shape: {ok, kid, turnstile: 'hosted', sitekey?}
  c = page('https://kellypage.app', { ok: true, kid: 'kp-2026a', turnstile: 'hosted', sitekey: '0x4AAAAAAFlatKey' });
  await c.KellyReg.turnstileInit({ hidden: true });
  t('hosted: flat health shape (turnstile string + sitekey) -> that site key', c.log.renders[0] && c.log.renders[0].sitekey === '0x4AAAAAAFlatKey', c.log.renders);
  c = page('https://kellypage.app', { ok: true, kid: 'kp-2026a', turnstile: 'required' });
  await c.KellyReg.turnstileInit({ hidden: true });
  t('hosted: flat health without sitekey -> built-in key', c.log.renders[0] && c.log.renders[0].sitekey === '0x4AAAAAAFwGleuq7Rjpi0dH', c.log.renders);
  c = page('https://kellypage.app', { ok: true, turnstile: 'off' });
  t('hosted: flat health mode off -> no widget', (await c.KellyReg.turnstileInit({ hidden: true })) === false && c.log.scripts.length === 0);

  // hosted but the service has the check off: no widget at all
  c = page('https://kellypage.app', { ok: true, turnstile: 'off' });
  t('hosted + mode off: no widget, no script', (await c.KellyReg.turnstileInit({ hidden: true })) === false && c.log.scripts.length === 0);

  // hosted, health unreachable: the built-in key
  c = page('https://kellypage.app', {});
  c.fetch = async () => { throw new Error('offline'); }; c.window.fetch = c.fetch;
  await c.KellyReg.turnstileInit({ hidden: true });
  t('hosted + health down: falls back to the built-in site key', c.log.renders[0] && c.log.renders[0].sitekey === '0x4AAAAAAFwGleuq7Rjpi0dH', c.log.renders);

  console.log(fails.length ? `RESULT: FAIL (${fails.length})` : `RESULT: ALL PASS (${pass})`);
  process.exit(fails.length ? 1 : 0);
})();
