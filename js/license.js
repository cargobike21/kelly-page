/* Kelly Page -- licensing hook.
 *
 * ENFORCED NOW: a hard build expiry. This copy works through EXPIRES_ON (local time) and stops at
 * the midnight after it -- allows() refuses everything and the page shows an "expired" notice
 * (app.js showExpired), leaving only "Save my config" so the set-up carries to the new version.
 * Change EXPIRES_ON per release; bridge/kelly_bridge.py carries the same date -- keep them in step.
 * A clock wound back after expiry is caught by remembering the latest date this browser has seen
 * (localStorage, outside the kelly.* keys so a factory reset doesn't clear it). It is a client-side
 * check: deters casual use past the date, not a determined user with the source.
 *
 * Feature gates are NOT here any more: KellyLicense.allows(feature) is an alias of KellyEnt.allowed(feature)
 * (js/entitlements.js, loaded first). The public build (KellyEnt.build === 'public') has no expiry at all;
 * registration tokens there carry their own expiry.
 */
(function (root) {
  'use strict';
  const EXPIRES_ON = [2027, 4, 30];   // year, month (1-12), day -- the last day this build works
  const WARN_DAYS = 14;                // start reminding this many days before
  const SEEN_KEY = 'kp-seen';
  const [y, m, d] = EXPIRES_ON;
  const expiresAt = new Date(y, m - 1, d + 1, 0, 0, 0).getTime();   // local midnight after the last day
  const NO_EXPIRY = !!(root.KellyEnt && root.KellyEnt.build === 'public');

  function now() {
    // Never earlier than the latest time this browser has seen (a wound-back clock).
    let seen = 0;
    try { seen = +localStorage.getItem(SEEN_KEY) || 0; } catch (e) { /* storage off */ }
    const t = Math.max(Date.now(), seen);
    try { if (t > seen) localStorage.setItem(SEEN_KEY, String(t)); } catch (e) { /* storage off */ }
    return t;
  }

  const KellyLicense = {
    buildMode: 'development',
    expiresAt,
    expiresText: new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
    expired() { return !NO_EXPIRY && now() >= expiresAt; },
    daysLeft() { return Math.max(0, Math.ceil((expiresAt - now()) / 86400000)); },
    warn() { return !NO_EXPIRY && !this.expired() && this.daysLeft() <= WARN_DAYS; },
    status(serial) {
      if (NO_EXPIRY) return { licensed: true, mode: 'public', serial: serial || null, note: serial ? `Radio serial ${serial}` : 'Connect a radio to read its serial number' };
      if (this.expired()) return { licensed: false, mode: 'expired', serial: serial || null, note: `This build expired on ${this.expiresText}` };
      return { licensed: true, mode: this.buildMode, serial: serial || null,
        note: `${serial ? `Development build -- would be licensed to radio serial ${serial}` : 'Connect a radio to read its serial number'} · works until ${this.expiresText}` };
    },
    allows(feature) { return !this.expired() && (!feature || !root.KellyEnt || root.KellyEnt.allowed(feature)); },
  };
  root.KellyLicense = KellyLicense;
})(window);
