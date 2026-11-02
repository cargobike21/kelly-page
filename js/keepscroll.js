/* Kelly Page -- keep the scroll place when a page redraws (2026-10-23).
 *
 * Most pages redraw by rebuilding a section with innerHTML. A scrolling box inside that section (a PBBS message body,
 * a list, a log) is then a NEW element and starts at the top again, so reading anything long jumped back every time
 * the page redrew -- several times a second on a busy page. Rather than patch ~60 boxes one by one, this watches:
 *   - every scroll on any element (capture listener) remembers that box: where it is, and how to find it again
 *     (its tag/class path down from the nearest ancestor with an id)
 *   - after each batch of DOM changes (MutationObserver: runs before the browser paints), a remembered box that was
 *     replaced is found again by its path, and the new one is scrolled to the old place
 * Only when it's the same content (the old box's opening text is still in the new one, or the other way round), so a
 * different message still opens at the top, and only when the new box is still at 0 -- a render that scrolled it
 * itself (a log kept at the bottom) wins. Boxes the user scrolled back to the top are forgotten.
 */
(function () {
  'use strict';
  const MAX = 60, PROBE = 120;
  const boxes = new Map();   // path -> { el, top, left }

  const sig = el => `${el.tagName}.${typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(c => !/^(on|sel|fresh|unread|busy|run|ok|bad|show|open|active)$/.test(c)).sort().join('.') : ''}`;
  // [id of the nearest ancestor with one, then (signature, index among same-signature siblings) down to the box]
  function pathOf(el) {
    const steps = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.id) return { id: n.id, steps: steps.reverse() };
      const p = n.parentElement; if (!p) return null;
      const s = sig(n);
      steps.push([s, [...p.children].filter(c => sig(c) === s).indexOf(n)]);
    }
    return null;
  }
  function find(path) {
    let n = document.getElementById(path.id);
    for (const [s, i] of path.steps) { if (!n) return null; n = [...n.children].filter(c => sig(c) === s)[i]; }
    return n || null;
  }
  const keyOf = path => path.id + '>' + path.steps.map(x => x.join('#')).join('>');

  function sameContent(a, b) {
    const ta = a.textContent || '', tb = b.textContent || '';
    if (ta === tb) return true;
    const pa = ta.trim().slice(0, PROBE), pb = tb.trim().slice(0, PROBE);
    return !!pa && !!pb && (tb.includes(pa) || ta.includes(pb));
  }

  document.addEventListener('scroll', e => {
    const el = e.target;
    if (!(el instanceof Element) || el === document.documentElement || el === document.body) return;
    for (const [k, b] of boxes) if (b.el === el) {   // known box: update in place
      if (!el.scrollTop && !el.scrollLeft) boxes.delete(k); else { b.top = el.scrollTop; b.left = el.scrollLeft; }
      return;
    }
    if (!el.scrollTop && !el.scrollLeft) return;
    const path = pathOf(el); if (!path) return;
    const k = keyOf(path);
    boxes.delete(k); boxes.set(k, { el, path, top: el.scrollTop, left: el.scrollLeft });
    if (boxes.size > MAX) boxes.delete(boxes.keys().next().value);
  }, { capture: true, passive: true });

  function restore() {
    for (const [k, b] of boxes) {
      if (b.el.isConnected) continue;
      const n = find(b.path);
      if (!n || n === b.el) continue;
      if (!sameContent(b.el, n)) { boxes.delete(k); continue; }   // different content now: let it start at the top
      if (!n.scrollTop && !n.scrollLeft) { n.scrollTop = b.top; n.scrollLeft = b.left; }
      b.el = n;
    }
  }
  const start = () => new MutationObserver(() => { if (boxes.size) restore(); }).observe(document.body, { childList: true, subtree: true });
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  window.KellyKeepScroll = { boxes, restore };   // tests
})();
