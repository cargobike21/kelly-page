// Ham Contacts: the contract (js/hc-core.js) + service (js/hc-service.js) over the demo backend (js/hc-demo.js), in Node.
// Run: ELECTRON_RUN_AS_NODE=1 "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" kelly-page/tests/hc-service-test.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const J = f => path.join(__dirname, '..', f);
const win = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder, URLSearchParams, Math, Date, Uint8Array, DataView, Promise };
win.window = win; win.self = win;
vm.createContext(win);
for (const f of ['vendor/tweetnacl-1.0.3/nacl-fast.min.js', 'js/meshqr.js', 'js/hc-core.js', 'js/hc-service.js', 'js/hc-demo.js']) vm.runInContext(fs.readFileSync(J(f), 'utf8'), win, { filename: f });
const HC = win.KellyHC, nacl = win.nacl, ed = HC.naclEd(nacl);
let pass = 0, fail = 0;
const t = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}`, extra === undefined ? '' : extra); } };
const mem = new Map(), store = { get: (k, d) => (mem.has(k) ? JSON.parse(mem.get(k)) : d), set: (k, v) => mem.set(k, JSON.stringify(v)) };

(async () => {
  // ---- core
  t('callFromName', HC.callFromName('VK4XXX Tracker') === 'VK4XXX' && HC.callFromName('bob vk4xyz') === 'VK4XYZ' && HC.callFromName('Ipswich Rptr') === null);
  t('label', HC.label('Bob node', 'VK4XYZ') === 'VK4XYZ · Bob node' && HC.label('VK4XYZ Bob', 'VK4XYZ') === 'VK4XYZ Bob');
  t('parseCard empty', (() => { try { HC.parseCard('', { ed }); return false; } catch (e) { return /nothing/.test(e.message); } })());
  t('parseCard junk', (() => { try { HC.parseCard('hello there', { ed }); return false; } catch (e) { return /no contact card/.test(e.message); } })());
  t('parseCard channel', (() => { try { HC.parseCard('meshcore://channel/add?name=x&secret=00', { ed }); return false; } catch (e) { return /not a contact/.test(e.message); } })());
  const q = HC.parseCard(`meshcore://contact/add?name=VK4ZZQ%20Test&public_key=${'ab'.repeat(32)}&type=1`, { ed });
  t('parseCard app QR', q.kind === 'contact' && !q.verified && q.call === 'VK4ZZQ');
  t('parseCard zero key', (() => { try { HC.parseCard(`meshcore://contact/add?public_key=${'0'.repeat(64)}&type=1`, { ed }); return false; } catch (e) { return /public key/.test(e.message); } })());

  // ---- demo world + service
  const bus = HC.createBus(), ev = [];
  ['contacts', 'heard', 'state', 'op', 'advert'].forEach(e => bus.on(e, p => ev.push([e, p])));
  const world = win.KellyHamDemo({ nacl });
  const svc = win.KellyHamContactsService({ backend: world.backend, bus, store, ed, myCall: () => 'VK4ZZA', demo: true });
  world.start(svc);
  await new Promise(r => setTimeout(r, 200));
  const st = svc.state();
  t('state online', st.link.online && st.link.via === 'demo' && st.maxContacts === 32 && st.count >= 9, st);   // 9 + Laidley Rptr (auto-add takes repeaters)
  t('heard pending', svc.heard().length >= 3 && svc.heard().every(r => r.pending && !r.onRadio), svc.heard().length);
  t('contact record', svc.contacts().every(r => Object.isFrozen(r) && HC.okKey(r.key) && r.onRadio));

  // a signed demo card verifies; tampering breaks it
  const card = world.cardOf('VK4ZZF Redbank');
  const c1 = HC.parseCard(`Hi, here's mine\n${card}\n73 de VK4ZZF`, { ed });
  t('signed card', c1.verified && c1.call === 'VK4ZZF' && c1.callFrom === 'name' && /^meshcore:\/\/contact\/add\?name=VK4ZZF\+Redbank&public_key=[0-9a-f]{64}&type=1$/.test(c1.qr), c1.qr);
  t('qr form reads back, unsigned', (q2 => q2.key === c1.key && !q2.verified && q2.name === c1.name)(HC.parseCard(c1.qr, { ed })));
  const bad = card.slice(0, -4) + (card.slice(-4) === '6b61' ? '6b62' : '6b61');
  t('tampered card refused', (() => { try { HC.parseCard(bad, { ed }); return false; } catch (e) { return /signature/.test(e.message); } })());
  t('no verifier refused', (() => { try { HC.parseCard(card, {}); return false; } catch (e) { return /cannot check/.test(e.message); } })());

  // add a card, add it again, add a heard one, remove, reset path, fav (retry past the 3 % demo faults)
  const retry = async fn => { let r; for (let i = 0; i < 5; i++) { r = await fn(); if (r.ok || r.code !== 'timeout') return r; } return r; };
  let r = await retry(() => svc.add(card));
  t('add card', r.ok && !!svc.contacts().find(x => x.key === c1.key), r);
  r = await svc.add(card);
  t('add again = already', r.ok && r.value.already, r);
  const h = svc.heard()[0];
  r = await retry(() => svc.add(h.key));
  t('add heard', r.ok && !!svc.contacts().find(x => x.key === h.key), r);
  r = await svc.add('garbage');
  t('add invalid', !r.ok && r.code === 'invalid', r);
  r = await svc.add(world.cardOf ? `meshcore://contact/add?name=x&public_key=${world.me.key}&type=1` : '');
  t('add own node refused', !r.ok && r.code === 'invalid', r);
  const k0 = svc.contacts()[0].key;
  r = await retry(() => svc.resetPath(k0)); t('resetPath', r.ok, r);
  r = await retry(() => svc.setFav(k0, true)); t('setFav', r.ok && svc.get(k0).fav, r);
  t('telemetry base starts deny', svc.state().telemetryBase === 0);
  r = await retry(() => svc.allowDiscover(k0, true)); t('allowDiscover', r.ok && r.value.raised && svc.get(k0).letsDiscover && svc.state().telemetryBase === 1, r);
  r = await retry(() => svc.setTelemetryBase(2)); t('telemetry base 2', r.ok && svc.state().telemetryBase === 2, r);
  r = await retry(() => svc.allowDiscover(svc.contacts()[2].key, true)); t('allowDiscover never lowers 2', r.ok && !r.value.raised && svc.state().telemetryBase === 2, r);
  r = await retry(() => svc.remove(k0)); t('remove', r.ok && !svc.get(k0) || (svc.get(k0) && !svc.get(k0).onRadio), r);
  // share / introduce: zero-hop, rate-limited
  const k1 = svc.contacts()[0].key;
  r = await retry(() => svc.share(k1)); t('share', r.ok && /zero-hop/.test(r.msg), r);
  r = await svc.share(k1); t('share rate-limited', !r.ok && r.code === 'rate', r);
  r = await svc.share('ee'.repeat(32)); t('share unknown refused', !r.ok && r.code === 'refused');
  // the 3rd remove restarts the demo radio: Kelly waits it out, then confirms the contact is gone
  const kA = svc.contacts()[1].key, kB = svc.contacts()[2].key;
  r = await retry(() => svc.remove(kA)); t('remove 2', r.ok && !r.value.restarted, r);
  const t0 = Date.now(); r = await retry(() => svc.remove(kB));
  t('remove that restarts the radio', r.ok && r.value.restarted && /restarted itself/.test(r.msg) && Date.now() - t0 > 3000 && svc.state().link.online && !svc.contacts().find(x => x.key === kB), r);
  r = await svc.remove('ff'.repeat(32)); t('remove unknown refused', !r.ok && r.code === 'refused', r);
  const p1 = svc.resetPath(svc.contacts()[1].key), p2 = svc.resetPath(svc.contacts()[1].key);
  t('busy per key', (await p2).code === 'busy' && (await p1) !== null);

  // adverts: the second local one inside the gap is refused
  // counted BEFORE it goes, so a demo lost answer (3 %) is not retried -- a lost OK must not let a second flood out
  r = await svc.advert('local'); t('advert local', r.ok || r.code === 'timeout', r);
  r = await svc.advert('local'); t('advert rate-limited', !r.ok && r.code === 'rate' && /airtime/.test(r.error), r);
  t('advertWait > 0', svc.advertWait('local') > 0);
  r = await svc.advert('sideways'); t('advert bad mode', !r.ok && r.code === 'invalid');

  // auto-add
  r = await retry(() => svc.setAutoAdd({ all: true })); t('autoAdd on', r.ok && svc.state().autoAdd && svc.state().autoAdd.all, r);
  r = await retry(() => svc.setAutoAdd({ all: false, types: { companion: true } })); t('autoAdd types', r.ok && svc.state().autoAdd.types.companion && !svc.state().autoAdd.all, r);

  // my card + signing my directory entry
  r = await retry(() => svc.myCard());
  t('myCard: the two standard forms', r.ok && r.value.call === 'VK4ZZA' && HC.parseCard(r.value.link, { ed }).verified && HC.parseCard(r.value.qr, { ed }).key === world.me.key && !('text' in r.value) && !('url' in r.value), r);
  const e = { k: world.me.key, c: 'VK4ZZA', n: world.me.name, t: 1, at: Math.floor(Date.now() / 1000), x: 0 };
  r = await retry(() => svc.signEntry(e));
  t('signEntry', r.ok && HC.verifyEntry(r.value, ed).ok, r);
  r = await svc.signEntry({ ...e, k: 'ab'.repeat(32) }); t('signEntry other key refused', !r.ok && r.code === 'refused');
  const forged = { ...r.value }; t('entry tamper', !HC.verifyEntry({ ...(await retry(() => svc.signEntry(e))).value, c: 'VK4ZZB' }, ed).ok && !!forged);

  // awards: a directory add tags both 'op' events with from: 'dir'; other adds don't
  {
    const kz = world.keyOf('VK4ZZK Beaudesert'), n0 = ev.length;
    r = await retry(() => svc.add({ key: kz, type: 1, name: 'VK4ZZK Beaudesert', from: 'dir' }));
    const ops = ev.slice(n0).filter(([e]) => e === 'op').map(([, p]) => p);
    t('dir add: op start + done carry from dir and the key', r.ok && ops.some(o => o.phase === 'start' && o.from === 'dir' && o.key === kz) && ops.some(o => o.phase === 'done' && o.from === 'dir' && o.key === kz && o.result.ok), ops);
    const n1 = ev.length;
    await svc.add({ key: world.keyOf('VK4ZZJ Caboolture'), type: 1, name: 'VK4ZZJ Caboolture' });
    const ops2 = ev.slice(n1).filter(([e]) => e === 'op').map(([, p]) => p);
    t('other add: no from', ops2.length >= 1 && ops2.every(o => !('from' in o)), ops2);
  }

  // awards: the demo world's scripted Handshakes ('mutual' via o.emit) and the station that is yours
  {
    const muts = [];
    const w2 = win.KellyHamDemo({ nacl, myCall: 'vk4xyz', emit: (e, p) => muts.push([e, p]) });
    const s2 = win.KellyHamContactsService({ backend: w2.backend, bus: HC.createBus(), store, ed, myCall: () => 'VK4ZZA', demo: true });
    const yours = w2.stations.find(x => x.yours);
    t('yours: one station named with myCall, on the radio, a companion', w2.stations.filter(x => x.yours).length === 1 && yours.name === 'VK4XYZ Home node' && yours.on && yours.type === 1 && HC.callFromName(yours.name) === 'VK4XYZ');
    t('yours: VK4XXX without a callsign', win.KellyHamDemo({ nacl }).stations.find(x => x.yours).name === 'VK4XXX Home node' && win.KellyHamDemo({ nacl, myCall: 'VK4ZZA' }).stations.find(x => x.yours).name === 'VK4XXX Home node');
    t('poke before start: nothing', w2.poke(yours.key, 'ack') === null);
    w2.start(s2);
    const zzb = w2.stations.find(x => x.name === 'VK4ZZB Springfield'), zze = w2.stations.find(x => x.name === 'VK4ZZE Toowoomba'), rpt = w2.stations.find(x => x.name === 'Ipswich Rptr');
    const a1 = w2.poke(zzb.key, 'ack'), a2 = w2.poke(yours.key, 'message');
    t('poke a scripted ham', a1 && a1.name === 'VK4ZZB Springfield' && a1.yours === false, a1);
    t('poke yours', a2 && a2.yours === true, a2);
    t('poke again within a minute: nothing', w2.poke(zzb.key, 'ack') === null);
    t('a ham who has not added you: nothing', w2.poke(zze.key, 'ack') === null && w2.poke(rpt.key, 'ack') === null && w2.poke('ab'.repeat(32), 'ack') === null);
    t('no answer straight away', muts.length === 0);
    await new Promise(res => setTimeout(res, 6500));
    const m1 = muts.find(([, p]) => p.key === zzb.key), m2 = muts.find(([, p]) => p.key === yours.key);
    t('answers arrive as mutual events', muts.length === 2 && muts.every(([e]) => e === 'mutual'), muts);
    t('mutual payload', m1 && m1[1].name === zzb.name && m1[1].type === 1 && m1[1].how === 'ack' && m1[1].demo === true && Math.abs(m1[1].at - Date.now()) < 8000 && !m1[1].yours, m1);
    t('mutual from yours: how message, flagged yours', m2 && m2[1].how === 'message' && m2[1].demo === true && m2[1].yours === true, m2);
    const a3 = w2.poke(zzb.key === yours.key ? zzb.key : w2.stations.find(x => x.name === 'VK4ZZC Mobile').key, 'ack');
    w2.stop();
    await new Promise(res => setTimeout(res, 6500));
    t('stop cancels a pending answer', !!a3 && muts.length === 2, muts.length);
  }

  // QR swap: svc.add(input, { direct: true }) -> the backend's addKey gets direct (a zero-hop route); not without it.
  // A NEW_ADVERT from a key -> KellyHamCalls.advertSeen(key) (a QR-claimed name is confirmed); a contact-list read is not one.
  {
    const got = [], seenAd = [];
    const b2 = Object.assign({}, world.backend, { addKey: x => { got.push(x); return world.backend.addKey(x); } });
    const s2 = win.KellyHamContactsService({ backend: b2, bus: HC.createBus(), store, ed, myCall: () => 'VK4ZZA', demo: true });
    const retryAdd = async (...a) => { let x; for (let i = 0; i < 6; i++) { x = await s2.add(...a); if (x.ok || x.code !== 'timeout') break; } return x; };
    const kq = 'c1'.repeat(32), kq2 = 'c2'.repeat(32);
    let x = await retryAdd({ key: kq, type: 1, name: 'VK4ZZS Swap' }, { direct: true });
    t('add direct: ok', x.ok, x);
    t('add direct: addKey got direct: true', got.length && got[got.length - 1].key === kq && got[got.length - 1].direct === true, got);
    x = await retryAdd({ key: kq2, type: 2, name: 'Swap Rptr' });
    t('add without it: no direct, type kept', got.length && got[got.length - 1].key === kq2 && !('direct' in got[got.length - 1]) && got[got.length - 1].type === 2, got);
    const prevCalls = win.KellyHamCalls;
    win.KellyHamCalls = { advertSeen: k => seenAd.push(k), callOf: () => null };
    s2._node({ key: kq, longName: 'VK4ZZS Swap', role: 1 }, false);
    t('a contact-list read is not an advert', !seenAd.length);
    s2._node({ key: kq, longName: 'VK4ZZS Swap', role: 1 }, false, { read: true });
    t('a quiet re-read is not an advert', !seenAd.length);
    // real firmware: a key it already holds (just added from a QR) advertises as PUSH_ADVERT, not NEW_ADVERT (F3)
    s2._node({ key: kq, longName: 'VK4ZZS Swap', role: 1 }, false, { advert: true });
    t('a known contact\'s PUSH_ADVERT -> advertSeen(key)', seenAd.length === 1 && seenAd[0] === kq, seenAd);
    seenAd.length = 0;
    s2._node({ key: 'C1'.repeat(32), longName: 'VK4ZZS Swap', role: 1, hops: 0 }, true);
    t('a NEW_ADVERT -> advertSeen(key)', seenAd.length === 1 && seenAd[0] === kq, seenAd);
    win.KellyHamCalls = { advertSeen: () => { throw new Error('boom'); }, callOf: () => null };
    let threw = false; try { s2._node({ key: kq2, longName: 'Swap Rptr', role: 2 }, true); } catch { threw = true; }
    t('a throwing advertSeen never breaks the service', !threw);
    win.KellyHamCalls = prevCalls;
  }

  // stale contact cleanup (= kelly_bridge.py prune): N days, repeaters 2N, never a favourite / no last-heard / own key
  {
    const NOW = 1_761_900_000, D = 86400, key = i => i.toString(16).padStart(2, '0').repeat(32);
    let clock = NOW;
    const held = [
      { key: key(1), longName: 'old companion', role: 1, lastHeard: (NOW - 10 * D) * 1000 },
      { key: key(2), longName: 'old fav', role: 1, fav: true, flags: 1, lastHeard: (NOW - 30 * D) * 1000 },
      { key: key(3), longName: 'repeater 10 d', role: 2, lastHeard: (NOW - 10 * D) * 1000 },
      { key: key(4), longName: 'repeater 20 d', role: 2, lastHeard: (NOW - 20 * D) * 1000 },
      { key: key(5), longName: 'fresh', role: 1, lastHeard: (NOW - 2 * D) * 1000 },
      { key: key(6), longName: 'never heard', role: 1, lastHeard: 0 },
      { key: key(7), longName: 'gone already', role: 3, lastHeard: (NOW - 40 * D) * 1000 },
    ];
    const removed = [];
    const fb = { via: () => 'live', online: () => true, why: () => '', me: () => ({ key: key(9), name: 'me' }), maxContacts: () => 350,
      autoAdd: async () => ({ all: false, bits: 7, maxHops: 0 }), nodes: () => [], nodeByKey: () => null,
      clock: async () => clock, listContacts: async () => held.slice(),
      remove: async k => { if (k === key(7)) throw new Error('not found'); removed.push(k); } };
    const mem2 = new Map(), st2 = { get: (k, d) => (mem2.has(k) ? JSON.parse(mem2.get(k)) : d), set: (k, v) => mem2.set(k, JSON.stringify(v)) };
    const s3 = win.KellyHamContactsService({ backend: fb, bus: HC.createBus(), store: st2, ed, myCall: () => 'VK4ZZA' });
    t('cleanup off by default', s3.state().cleanup.on === false && s3.state().cleanup.days === 7);
    let r3 = await s3.cleanup();
    t('cleanup: old companion + 20 d repeater go, oldest first', r3.ok && removed.join() === [key(4), key(1)].join() && r3.value.removed === 2, [r3, removed]);
    t('cleanup: favourite, fresh, never-heard, 10 d repeater stay', ![2, 3, 5, 6].some(i => removed.includes(key(i))));
    t('cleanup result saved', s3.state().cleanup.removed === 2 && s3.state().cleanup.last > 0 && JSON.parse(mem2.get('hcCleanup')).removed === 2);
    s3.cleanupSettings({ on: true, days: 30 });
    t('cleanup settings saved', JSON.parse(mem2.get('hcCleanup')).on === true && s3.state().cleanup.days === 30);
    clock = 1_600_000_000; removed.length = 0;
    r3 = await s3.cleanup();
    t('cleanup skipped when the node clock is not set', !r3.ok && /clock/.test(r3.error || r3.msg) && !removed.length, r3);
  }

  // room
  t('room warn', svc.room(30).ok === false && /at most 32/.test(svc.room(30).warn));

  // disconnect mid-op -> offline, never hangs
  const pend = svc.refresh(); world.stop();
  r = await pend; t('disconnect settles offline', !r.ok && r.code === 'offline', r);
  r = await svc.add(card); t('offline refused', !r.ok && r.code === 'offline');
  t('no private key anywhere', !JSON.stringify([...mem.values()]).includes(HC.hex(world.me.kp.secretKey).slice(0, 40)));

  console.log(`RESULT: ${fail ? 'FAIL' : 'ALL PASS'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('RESULT: FAIL', e); process.exit(1); });
