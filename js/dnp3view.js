/* Kelly Page -- DNP3 teaching views shared by the DNP3 Demo's two plants (window.KellyDnp3View). Needs js/dnp3.js.
 *
 *   decodeHtml(hex, label, esc)        the byte-by-byte decode (hex cells + field table) the Packet Inspector shows
 *   explain(hex, who, points)          "What just happened?" -- one frame in plain English, naming points from the
 *                                      plant's point list ({ bi, ai, ctr, bo, ao } each [{ name, code?, unit?, scale? }])
 *   sequence(rows, esc)                SVG ladder diagram, master on the left, outstation on the right. rows (oldest
 *                                      first) = [{ who: 'M'|'O', at, arrive?, lost?, why?, text, size }]
 */
(function () {
  'use strict';
  const D = window.DNP3;

  function decodeHtml(hex, label, esc) {
    const r = D.inspect(hex), b = r.bytes;
    const cells = Array.from(b, (x, i) => { const f = r.fields[r.byteField[i]] || {}; return `<span class="hb t-${f.tag || 'x'}" data-f="${r.byteField[i]}" title="${esc(f.label || '')}">${x.toString(16).padStart(2, '0')}</span>`; }).join('');
    const rows = r.fields.map((f, i) => `<tr class="t-${f.tag}" data-f="${i}"><td>${r.byteField.indexOf(i)}</td><td>${f.layer}</td><td>${esc(f.label)}</td><td class="v">${esc(f.value)}</td><td>${esc(f.note)}</td></tr>`).join('');
    const objs = r.app ? r.app.objects.map(o => `<span class="d3-tag ${o.time !== 'none' ? 't' : ''}" title="${esc(o.name)}">g${o.g}v${o.v} · ${o.time === 'abs' ? 'carries a timestamp' : o.time === 'rel' ? 'relative timestamp' : o.time === 'is' ? 'is a time value' : 'no timestamp'}</span>`).join(' ') : '';
    return `<p class="d3-sum"><b>${esc(r.summary || '')}</b><br><small class="dim">${esc(label || '')} · ${b.length} octets · about ${D.airSeconds(b.length).toFixed(2)} s on a P25 data channel</small></p>
      ${r.error ? `<p class="d3-lock">⚠ ${esc(r.error)}</p>` : ''}<div class="d3-objs">${objs}</div><div class="d3-hex">${cells}</div>
      <table class="d3-tbl d3-fields"><thead><tr><th>@</th><th>Layer</th><th>Field</th><th>Value</th><th>Meaning</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ------------------------------------------------------------------ plain English
  const list = a => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const CLS = { 1: 'Class 0 (every current value -- an integrity poll)', 2: 'Class 1 events', 3: 'Class 2 events', 4: 'Class 3 events' };
  function pname(points, kind, i) {
    const p = points && points[kind] && points[kind][i];
    if (!p) return `${{ bi: 'binary input', ai: 'analog input', ctr: 'counter', bo: 'binary output', ao: 'analog output' }[kind]} ${i}`;
    return p.code ? `${p.code} ${p.name}` : p.name;
  }
  function pval(points, kind, i, raw) {
    const p = points && points[kind] && points[kind][i];
    if (kind === 'bi') return raw ? 'ON' : 'OFF';
    if (!p || !p.scale || kind === 'ctr') return String(raw);
    const v = raw / p.scale; return `${v.toFixed(p.scale >= 100 ? 2 : p.scale >= 10 ? 1 : 0)}${p.unit ? ' ' + p.unit : ''}`;
  }
  function changes(app, points) {
    const ev = [], st = { bi: 0, ai: 0, ctr: 0, ao: 0 };
    for (const o of app.objects) {
      const kind = o.g === 2 ? 'bi' : o.g === 32 ? 'ai' : o.g === 22 ? 'ctr' : null;
      if (kind) for (const p of o.points) ev.push({ kind, index: p.index, value: p.value });
      if (o.g === 1) st.bi += o.points.length; if (o.g === 30) st.ai += o.points.length; if (o.g === 20) st.ctr += o.points.length; if (o.g === 40) st.ao += o.points.length;
    }
    const say = ev.slice(0, 3).map(e => e.kind === 'bi' ? `${pname(points, 'bi', e.index)} went ${pval(points, 'bi', e.index, e.value)}` : `${pname(points, e.kind, e.index)} is now ${pval(points, e.kind, e.index, e.value)}`);
    const kinds = [['bi', 'binary input'], ['ai', 'analog'], ['ctr', 'counter']].map(([k, w]) => [plural(ev.filter(e => e.kind === k).length, w + ' change'), ev.some(e => e.kind === k)]).filter(x => x[1]).map(x => x[0]);
    const stat = [st.bi && plural(st.bi, 'binary input'), st.ai && plural(st.ai, 'analog'), st.ctr && plural(st.ctr, 'counter'), st.ao && plural(st.ao, 'setpoint')].filter(Boolean);
    return { ev, say, kinds, stat };
  }
  function ctrlText(app, points) {
    const out = [];
    for (const o of app.objects) {
      if (o.g === 12) for (const p of o.points) out.push({ what: `${pname(points, 'bo', p.index)} (${D.CROB_NAMES[p.code] || D.ctrlCodeName(p.code)})`, status: p.status });
      if (o.g === 41) for (const p of o.points) { const a = points && points.ao && points.ao[p.index]; out.push({ what: `${pname(points, 'ao', p.index)} = ${p.value}${a && a.unit ? ' ' + a.unit : ''}`, status: p.status }); }
    }
    return out;
  }
  function explain(hex, who, points) {
    let r; try { r = D.inspect(hex); } catch { return 'A frame Kelly could not decode.'; }
    const from = who === 'M' ? 'The master' : who === 'O' ? 'The outstation' : 'A station on air';
    if (!r.ok && !r.app) return `${from} sent a damaged frame (${r.error}) -- the other end throws it away and the master will time out and retry.`;
    if (!r.app) return `${from} sent a link-layer frame (${r.link.fnName || 'link'}) -- housekeeping below DNP3's application layer, no data.`;
    if (r.transport && !r.transport.fir) return `${from} sent the next piece of a message too big for one frame; the far end glues the pieces back together.`;
    const a = r.app, fc = a.fc, F = D.FC;
    if (fc === F.READ) {
      const cls = a.objects.filter(o => o.g === 60).map(o => CLS[o.v]).filter(Boolean);
      if (cls.length) return `The master asked for ${list(cls)}.${cls.length === 4 ? ' Events first, then every current value: that is an integrity poll, used at start-up and every few minutes to make sure nothing was missed.' : ' Only things that changed come back, so an event poll is small -- that is what makes polling work on a slow radio channel.'}`;
      if (a.objects.some(o => o.g === 50)) return 'The master asked to read the outstation\'s clock (g50v1).';
      return `The master asked to read ${list(a.objects.map(o => `group ${o.g}`))}.`;
    }
    if (fc === F.RESPONSE || fc === F.UNSOLICITED_RESPONSE) {
      const c = changes(a, points), ctl = ctrlText(a, points);
      let s = fc === F.UNSOLICITED_RESPONSE ? 'The outstation didn\'t wait to be asked: an UNSOLICITED report' : 'The outstation replied';
      if (ctl.length) s += ` to the control: ${list(ctl.map(x => `${x.what} -- ${D.CROB_STATUS[x.status] || 'status ' + x.status}`))}.` + (ctl.some(x => x.status === 15) ? ' BLOCKED means the plant\'s interlocks said no.' : ctl.some(x => x.status === 2) ? ' NO SELECT: an OPERATE must follow a matching SELECT.' : '');
      else if (c.ev.length) s += ` with ${list(c.kinds)}${c.say.length ? ': ' + c.say.join('; ') + (c.ev.length > 3 ? '; ...' : '') : ''}.`;
      else if (c.stat.length) s += ` with the current value of ${list(c.stat)}.`;
      else if (a.objects.some(o => o.g === 52)) s += ` to the delay measurement: it took ${a.objects.find(o => o.g === 52).points[0].value} ms to answer.`;
      else if (a.objects.some(o => o.g === 50)) s += ' with its clock time.';
      else s += fc === F.UNSOLICITED_RESPONSE ? ' with nothing in it (a start-up "hello").' : ': nothing new to report.';
      if (a.ac.con) s += ' It set CON: the master must CONFIRM before the outstation can delete those events.';
      const iin = (a.iin || 0), I = D.IIN;
      if (iin & (1 << I.EVENT_OVERFLOW)) s += ' ⚠ IIN2.3 EVENT BUFFER OVERFLOW: events were thrown away while nobody was listening.';
      if (iin & (1 << I.NEED_TIME)) s += ' IIN1.4 says its clock needs setting.';
      if (iin & (1 << I.DEVICE_TROUBLE)) s += ' IIN1.6 DEVICE TROUBLE is set.';
      if (iin & (1 << I.LOCAL_CONTROL)) s += ' IIN1.5: the station is in LOCAL, remote controls will be refused.';
      return s;
    }
    if (fc === F.CONFIRM) return a.ac.uns ? 'The master confirmed the unsolicited report, so the outstation can forget those events.' : 'The master confirmed -- the outstation can now delete the events it just sent.';
    if (fc === F.SELECT || fc === F.OPERATE || fc === F.DIRECT_OPERATE || fc === F.DIRECT_OPERATE_NR) {
      const ctl = ctrlText(a, points).map(x => x.what);
      if (fc === F.SELECT) return `Step 1 of select-before-operate: the master SELECTed ${list(ctl)}. The outstation checks the point and the interlocks and arms it, but nothing moves yet.`;
      if (fc === F.OPERATE) return `Step 2: the master sent OPERATE for ${list(ctl)} -- the same object, the next sequence number, inside the select timeout -- so now the plant really does it.`;
      return `The master sent DIRECT OPERATE for ${list(ctl)}: one step, no select. Quicker on a slow link, but nothing stops a corrupted or mistaken command.${fc === F.DIRECT_OPERATE_NR ? ' NO ACK: the outstation won\'t even reply.' : ''}`;
    }
    if (fc === F.ENABLE_UNSOLICITED) return 'The master told the outstation it may report changes by itself (unsolicited), without waiting for a poll.';
    if (fc === F.DISABLE_UNSOLICITED) return 'The master told the outstation to stop sending unsolicited reports and wait to be polled.';
    if (fc === F.DELAY_MEASURE) return 'Time sync step 1: the master asked how long the outstation takes to answer, so it can work out the one-way delay.';
    if (fc === F.WRITE) return a.objects.some(o => o.g === 50) ? 'Time sync step 2: the master wrote its clock (plus the measured delay) into the outstation.' : a.objects.some(o => o.g === 80) ? 'The master cleared the outstation\'s DEVICE RESTART flag (IIN1.7) -- "I know you restarted".' : 'The master wrote to the outstation.';
    if (fc === F.COLD_RESTART || fc === F.WARM_RESTART) return `The master told the outstation to restart (${fc === F.COLD_RESTART ? 'cold' : 'warm'}).`;
    return `${from} sent ${a.fcName}.`;
  }

  // ------------------------------------------------------------------ ladder diagram
  function sequence(rows, esc) {
    if (!rows.length) return '<p class="dim">No traffic yet.</p>';
    const W = 640, X = { M: 120, O: 520 }, H = 38, top = 34, h = top + rows.length * H + 10, t0 = rows[0].at;
    const o = [`<svg class="dv-seq" viewBox="0 0 ${W} ${h}" role="img" aria-label="Sequence diagram of DNP3 traffic">`,
      `<text class="hd" x="${X.M}" y="18" text-anchor="middle">MASTER</text><text class="hd" x="${X.O}" y="18" text-anchor="middle">OUTSTATION</text>`,
      `<path class="life" d="M${X.M} 26 V${h} M${X.O} 26 V${h}"/>`];
    rows.forEach((r, i) => {
      const y = top + i * H, from = X[r.who === 'O' ? 'O' : 'M'], to = X[r.who === 'O' ? 'M' : 'O'], dir = Math.sign(to - from);
      const travel = r.arrive ? Math.max(0, r.arrive - r.at) : 0, dy = Math.min(H - 14, 6 + travel / 120), end = r.lost ? (from + to) / 2 : to;
      const cls = r.lost ? 'lost' : r.who === 'O' ? 'up' : 'dn';
      o.push(`<g class="${cls}"><text class="tm" x="6" y="${y + 4}">+${((r.at - t0) / 1000).toFixed(1)} s</text>`);
      o.push(`<path d="M${from} ${y} L${end - dir * 6} ${y + dy * (end === to ? 1 : 0.5)}"/>`);
      o.push(r.lost ? `<text class="x" x="${end}" y="${y + dy * 0.5 + 5}" text-anchor="middle">✖</text>` : `<path class="hd" d="M${to} ${y + dy} l${-dir * 9} -5 v10 z"/>`);
      o.push(`<text class="lb" x="${(from + to) / 2}" y="${y - 3}" text-anchor="middle">${esc(r.text)}${r.size ? ` · ${r.size} B` : ''}${travel ? ` · ${(travel / 1000).toFixed(2)} s` : ''}${r.lost ? ` · ${esc(r.why || 'lost')}` : ''}</text></g>`);
    });
    o.push('</svg>');
    return o.join('');
  }

  // a short name for a frame's function, for lists and the ladder
  function shortName(hex) {
    try {
      const r = D.inspect(hex); if (!r.app) return r.link && r.link.fnName ? 'LINK ' + r.link.fnName : 'frame';
      const a = r.app, n = a.fcName.replace('UNSOLICITED RESPONSE', 'UNSOLICITED').replace('DIRECT OPERATE (no response)', 'DIRECT OP NR');
      const cls = a.objects.filter(o => o.g === 60).map(o => o.v - 1);
      if (a.fc === D.FC.READ && cls.length) return cls.length === 4 ? 'READ integrity' : `READ class ${cls.join(',')}`;
      return n;
    } catch { return 'frame'; }
  }

  window.KellyDnp3View = { decodeHtml, explain, sequence, shortName };
})();
