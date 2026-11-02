# Kelly Page for Raspberry Pi

A ready-to-go Raspberry Pi image with Kelly Page already installed. Flash it, plug in
Ethernet, power up, and Kelly is at **http://kellypage.local:8025** on your network.
Kelly Page is free software for hams.

**Works on:** Raspberry Pi 5, 4, 400, 3B / 3B+, Zero 2 W (any 64-bit Pi). 8 GB or bigger SD card.

## 1. Flash it

1. Install **Raspberry Pi Imager** (raspberrypi.com/software).
2. Either:
   - **Add the Kelly Page list to Imager:** Imager → *App Options* (bottom left) → *Content repository* →
     *Use custom URL* → paste the `kellypage-os-list.json` link → *Choose OS* now shows **Kelly Page**; or
   - **Use the file:** download `kellypage-<version>-arm64-lite.img.xz`, then *Choose OS* → *Use custom* → pick it.
     (Optional: check it with the `.sha256` file next to it.)
3. Choose your SD card and write it.

**Wi-Fi:** Ethernet works with nothing set. For Wi-Fi, click *Edit settings* (OS customisation) when
Imager asks, tick *Configure wireless LAN*, and enter your network name, password and **country (AU)**.
While you're there you can also set your own username and password: then use those to log in instead
of `kelly`, and the shared `kelly` login is switched off automatically. If you change the hostname,
Kelly is at `http://<your-hostname>.local:8025` instead.

## 2. First login

Give it 2-3 minutes on the first boot (it grows itself to fill the card and makes its own security keys), then:

```
ssh kelly@kellypage.local
```

Password: **`kellypage`**. You'll be made to change it straight away: type `kellypage` once more
(the current password), then your new one twice. It logs you out. Log back in with the new password.

Next comes a short setup: your callsign, your LoRa node and Bluetooth scanning. Enter keeps the default
each time. Run it again whenever you like:

```
sudo kellypage-setup
```

Change your password again any time with `passwd`.

> Windows: `ssh` works from PowerShell or Command Prompt. If `kellypage.local` isn't found, use the Pi's IP
> address from your router's device list.

## 3. Open Kelly

Every login shows Kelly's address, with this Pi's own **token** on the end:

```
http://kellypage.local:8025/?connect=ip&token=abcd2345ef
```

Open it in **Chrome or Edge** on any computer on your network and bookmark it. The token stops strangers on
your network from keying your radio, so keep it to yourself. For your phone, `kellypage-qr` shows the same
address as a QR code.

## 4. Plug in your gear

- **Tait radio:** plug the USB programming / data lead in. Kelly picks it up by itself, with no restart.
  The page works without a radio too.
- **MeshCore / Meshtastic LoRa node on USB:** RAK4631, SenseCAP and XIAO nRF52 boards are found
  automatically. For anything else (a Heltec, say), plug it in, run `sudo kellypage-setup` and pick it from
  the list.
- **MeshCore node over Bluetooth, or a Wi-Fi node:** `sudo kellypage-setup` and choose that option.
- **Bluetooth LE presence (beacons, sensors):** answer *y* to *Scan Bluetooth* in `sudo kellypage-setup`.

Kelly's own settings (callsign on the radio pages, contacts, iGate, and so on) are kept in your browser, as on a
PC. Nothing personal is on the image when you get it.

## 5. Keep it up to date

Each Kelly release stops talking to the radio on a set date (the login message warns you), so update when a
new one comes out. Copy the release zip over, then:

```
scp KellyPage-0.4.36-....zip kelly@kellypage.local:
ssh kelly@kellypage.local
sudo kellypage-update KellyPage-0.4.36-....zip
```

(`sudo kellypage-update https://.../KellyPage-....zip` downloads it for you.) If the new version doesn't start,
the old one is put back. `sudo kellypage-update --rollback` puts the previous version back by hand. Updating the Pi
itself: `sudo apt update && sudo apt full-upgrade`.

### Automatic updates (off by default)

`sudo kellypage-setup` asks "Install new Kelly Page releases automatically?" (or set `ENABLED=1` in
`/etc/kellypage/autoupdate.conf`; `CHANNEL=stable|beta` there too). Once a day (random delay up to 6 h) the Pi fetches
a signed manifest from `downloads.kellypage.app` (outbound HTTPS only), checks the signature against the release key
pinned in `/etc/kellypage/release-keys.json`, refuses downgrades, wrong channel and versions that failed here before,
verifies the zip's size and SHA-256, installs with `kellypage-update`, then waits up to 90 s for Kelly to answer on
`127.0.0.1:8025`. If it doesn't, the previous version is restored and the bad one is listed in
`/var/lib/kellypage/bad-versions`. Look: `journalctl -u kellypage-autoupdate`; try now: `sudo kellypage-autoupdate --force`
(`--check` only reports). Format, policy and how a release is signed and uploaded: `RELEASE-SIGNING.md`.

A Pi that is already running (flashed before this existed) gets it with the repo's `pi-image` folder copied over:

```
scp -r pi-image kelly@kellypage.local:
ssh -t kelly@kellypage.local 'sudo bash pi-image/install-autoupdate.sh --enable --channel beta'
```

(`--channel stable` for the tested track; leave `--enable` off to install it switched off. Safe to run again.)

## If something's wrong

| | |
|---|---|
| Page won't load | `systemctl status kelly-bridge`, then `journalctl -u kelly-bridge -n 30` |
| Radio not seen | `ls -l /dev/kelly-radio` (is the lead seen?); unplug and plug back in |
| `kellypage.local` not found | Use the IP address shown at login or in your router |
| Forgot your password | Re-flash the card (nothing on it you can't set up again in two minutes) |

## What's on the image

Raspberry Pi OS Lite (64-bit, Debian 13 "trixie"), trimmed for a headless Kelly box: no compilers, man pages,
docs or foreign-language files, and no disk swap file (compressed RAM swap instead). Kelly Page lives in
`/opt/kelly-page` and runs as the `kelly-bridge` service under its own `kellypage` user. Its settings are in
`/etc/kelly-bridge.env`. Need a man page back? Delete `/etc/dpkg/dpkg.cfg.d/01-kellypage-slim` and reinstall
the package.

---

*Building the image (club maintainers):* `sudo ./build-image.sh KellyPage-<ver>-....zip --url-base https://<where-it-will-live>/`
on a Debian/Ubuntu box or WSL2 with `qemu-user-static`. See the top of `build-image.sh`. Upload the `.img.xz`,
`kellypage-os-list.json` and a `kellypage-icon.png` (40×40) to that URL.
