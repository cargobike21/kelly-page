# Kelly over HTTPS

Browsers only let a page use **GPS, the camera, Bluetooth and offline mode** (service workers, installing
Kelly as an app) when the page is a *secure context*: `https://`, or `http://localhost`. So Kelly on the
computer running the bridge (`http://localhost:8025`) has them all, but a phone opening a Pi or another computer
as `http://192.168.x.x:8025` or `http://100.x.x.x:8025` has none of them. Kelly greys those features out and
says why (`js/secure.js`).

Plain http stays the default. Two ways to turn https on:

## 1. Tailscale certificate (best)

On a machine already on the tailnet (MagicDNS and HTTPS enabled for the tailnet in the admin console):

```sh
sudo tailscale cert kelly.<tailnet>.ts.net          # writes kelly.<tailnet>.ts.net.crt + .key
python3 kelly_bridge.py --serial /dev/kelly-radio --bind 0.0.0.0 --token s3cret \
    --tls-cert kelly.<tailnet>.ts.net.crt --tls-key kelly.<tailnet>.ts.net.key
```

Then open `https://kelly.<tailnet>.ts.net:8025/` on any device on the tailnet -- a real Let's Encrypt
certificate, no warning. The certificate lasts 90 days: run `tailscale cert` again (a monthly cron job) and
restart the bridge. The key file must be readable by the user the bridge runs as.

**Or let Tailscale do the TLS** and leave the bridge on plain http:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:8025
```

Then open `https://kelly.<tailnet>.ts.net/` (no port). Tailscale renews the certificate itself. **But**
the bridge then sees every visitor as `127.0.0.1` -- "this machine" -- so they skip the token on `/mesh`,
`/ble` and the share store, reach the localhost-only APIs, and on a Pi with `--keeper-local` count as the
keeper (the hand-over breaks). Use it only where everyone on the tailnet may use the radio, and not on the Pi
install; there, use the certificate files above.

## 2. Self-signed certificate (no Tailscale)

```sh
python3 kelly_bridge.py --serial /dev/kelly-radio --bind 0.0.0.0 --token s3cret --tls self
```

The first start makes a certificate with the `openssl` program (Debian and Pi OS have it; on Windows Git
for Windows ships one) and keeps it in `~/.kelly-tls/` (`--tls-dir` to move it). It names `localhost`, this
machine's hostname and its current IP addresses -- if the IP changes, delete the folder and restart. It's
remade after about two years.

Open `https://<pi-address>:8025/` and the browser warns "Your connection is not private". Accept it once
per device (Advanced > Proceed). GPS, the camera and Bluetooth then work. **Second best:** Chrome won't run
offline mode or install Kelly from a self-signed page unless the certificate is installed as trusted on that
device -- use option 1 for those.

## Keeping plain http too

With `--tls ...` the bridge's `--port` serves https only. The Pi's keeper (`kelly_keeper.py`) and the
gateway's localhost calls use plain `http://localhost:8025`, so on the Pi add `--tls-port 8443`: then 8025
stays plain http and 8443 serves the same Kelly over https.

## Connecting a phone

`sudo python3 /opt/kelly-page/bridge/kelly_bridge.py --connect-qr` prints the address to open Kelly at from a phone as a
QR code in the terminal (the installer shows it at the end too). It takes the ports and TLS settings from the
installed `kelly-bridge` service (drop-ins included) and the token from `/etc/kelly-bridge.env` (sudo) or
`~/kelly-address.txt`. Kelly's own QR code comes from `GET /api/connect`:

    {urls: [{url, label, kind: 'lan' | 'mdns' | 'tailscale', https}], port, tlsPort, hasToken, token?}

LAN addresses first (the one the request came in on leads, then the default route's interface), then
`<hostname>.local`, then Tailscale; https before http. Docker / bridge / veth interfaces and link-local are left
out. Each `url` is a base address (Kelly adds `?connect=ip&token=` itself). `token` is in the answer only for a
caller that sent the right `?token=`, or a page on this machine (no `Origin`, a file:// page's `null`, or a
localhost page) -- every answer carries CORS, so another web site open in a browser here gets no token.

A phone's Kelly catches up on the mesh messages the always-on Kelly or the bridge's own session collected first:
`GET /api/mesh-texts?token=T[&since=ms]` (with `--mesh-gateway`; the /ws token from anywhere, no token from this
machine) -> `{texts: [{id, dm, ch, chName, sender, prefix?, to?, toName?, text, at, snr?, hops?, out?}], self,
channels}`. Texts sent through the bridge (a Kelly's on /mesh, or `/api/mesh-send`) are kept too, `out: true`. The
last 500 are kept across restarts in `--mesh-texts` (default `~/.kelly-mesh-texts.json`, mode 600).

## The bridge addresses inside Kelly

On an https page Kelly turns a configured `ws://host:port` bridge address into `wss://` by itself (a browser
blocks `ws://` from an https page). That bridge must then be serving TLS too. A `ws://localhost:<port>`
address on a different port is left alone -- browsers allow that one.

