# Signed releases (KPU1) and Pi auto-update

Trust comes from an offline Ed25519 **release key** (`rel-2026a`), not from the host a file is served from. The public
half is pinned in the Pi image (`/etc/kellypage/release-keys.json`); the private seed lives only in a file on the release signer's PC
(`KELLY_RELEASE_KEY_FILE` in `.env` points at it, default `%USERPROFILE%\.kellypage\release-key`). It is never a Worker
secret, never in `.env`, never in git. This is separate from the registration-token key (`kp-2026a`).

## KPU1 manifest

A manifest is one line of ASCII:

```
KPU1.<b64url(JSON payload)>.<b64url(Ed25519 signature)>
```

The signature is over the ASCII bytes `"KPU1." + <payload segment>` (everything before the last dot), keyed by `kid`.
b64url = URL-safe base64, no padding. The payload (signer writes compact JSON, sorted keys; verifiers read the
segment as-is):

| field | meaning |
|---|---|
| `v` | `1` |
| `kid` | signing key id (`rel-2026a`). A kid not in the pinned file is rejected |
| `product` | `kellypage-pi` (what Pis install) or `kellypage-zip` (the same zip, for PC users) |
| `version` | dotted numeric, e.g. `0.4.41` |
| `min_from` | oldest installed version allowed to jump straight to this one (`""` = any) |
| `channel` | `stable` or `beta` |
| `files` | `[{name, url, sha256, size}]`, `url` must be https; the Pi installs the first `.zip` |
| `notes_url` | release notes link (may be empty) |
| `at` | signing time, UTC ISO 8601 |
| `expires` | optional, unix seconds. The Pi refuses the manifest after it (`sign_release.py --expires-days`, default 365). With no `expires`, a manifest whose `at` is older than 400 days is refused. Stops an old signed manifest being replayed forever |

`release-keys.json` is `{"keys": {"<kid>": "<64 hex raw Ed25519 public key>", ...}}`, several kids allowed so a key can
be rotated: ship an image/update pinning the new kid alongside the old, sign with the new, later drop the old.

Code: `rootfs/usr/local/lib/kellypage/kpu1.py` (shared by signer and Pi; needs only `python3-cryptography`, already on
the image for the device key -- no extra package, and no OpenSSL DER wrapping needed).

## Pi policy (`kellypage-autoupdate`)

Signature valid under a pinned kid; `product == kellypage-pi`; `channel` equals the Pi's `CHANNEL`; version not lower
than installed (equal = up to date); installed >= `min_from`; version not in `/var/lib/kellypage/bad-versions`; zip
size matches and sha256 matches; manifest not expired (see `expires`). Then `kellypage-update <zip>` (restores itself
if the bridge won't start; a failed install is recorded in `bad-versions` too). Then the installed `KELLY_VERSION`
must equal the manifest's `version` (a signed manifest pointing at a different zip is rolled back), then a health
check (kelly-bridge active and HTTP answering on 127.0.0.1:8025 within 90 s). Unhealthy or version mismatch:
`kellypage-update --rollback` and the version goes into `bad-versions`. The lock file is `/run/kellypage/autoupdate.lock`
(the service's `RuntimeDirectory=kellypage`; opened `O_NOFOLLOW`). Exit codes are in the script header (0 ok, 1 fetch, 2 refused,
3 install failed, 4 unhealthy and restored, 5 rollback failed, 9 busy).

Default manifest URL: `https://downloads.kellypage.app/kellypage-pi-<channel>.kpu1`.

## Releasing (the release signer, on the PC)

1. Build the zip as usual (`scripts/package_kelly.py`), bench-test it.
2. `python scripts/sign_release.py --channel stable --min-from 0.4.30 --previous <last manifest> _scratch\kelly-release\KellyPage-0.4.41-....zip`
   writes `kellypage-pi-stable.kpu1` next to the zip. The version is read from `Kelly Page/js/version.js` inside the
   zip (`--version` is optional and must match it). It refuses a version not greater than `--previous`, and a key file
   whose public key differs from `KELLY_RELEASE_PUB`. Re-sign at least yearly (`--expires-days`).
3. `python scripts/sign_release.py --verify kellypage-pi-stable.kpu1 <zip>` checks it against the pinned keys.
4. Upload the zip, then the `.kpu1`, to the `downloads.kellypage.app` bucket (manifest last, so Pis never see a
   manifest whose zip isn't there yet). Use `kellypage-pi-beta.kpu1` with `--channel beta` for early releases.
5. Optional: attach the same zip + `.kpu1` to a GitHub Release as a mirror; Pis can be pointed at it with
   `MANIFEST_URL=` in `autoupdate.conf`. Nothing about trust changes, because the signature is what is checked.

Tests: `.venv\Scripts\python.exe -m unittest discover -s kelly-page/pi-image/tests -v` (test seed only).
