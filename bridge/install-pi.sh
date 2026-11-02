#!/bin/bash
# Kelly Page -- Raspberry Pi installer (Raspberry Pi OS Lite / Debian, headless).
#
#   sudo bash "Kelly Page/bridge/install-pi.sh"            run from the unzipped release
#   sudo bash "Kelly Page/bridge/install-pi.sh" --moxa     also install the MOXA UPort firmware
#   sudo bash "Kelly Page/bridge/install-pi.sh" --ble      also scan Bluetooth LE for the BLE Presence page
#        --ble hci1 / --ble hci0,hci1   other adapters (a USB dongle);  --ble-zone Shack   this Pi's zone name
#   sudo bash "Kelly Page/bridge/install-pi.sh" --ble-node --server HOST:8025 --node shed --token T [--adapter hci0]
#        a remote BLE scanner node only (no radio here): scans and forwards to the Kelly bridge at HOST
#   sudo bash "Kelly Page/bridge/install-pi.sh" --mesh-serial /dev/serial/by-id/usb-RAKwireless_...-if00
#        a LoRa node on USB as well (MeshCore companion / Meshtastic) for the LoRa Mesh page; --mesh-serial none = drop it
#   sudo bash "Kelly Page/bridge/install-pi.sh" --mesh-ble AA:BB:CC:DD:EE:FF [--mesh-ble-pin 123456]
#        a MeshCore companion over Bluetooth instead (kelly_mesh_ble.py; its PIN is on its screen, else 123456)
#
# Copies Kelly to /opt/kelly-page and runs the IP bridge as a service that starts by itself
# whenever a USB serial lead is plugged in (and stops when it's unplugged -- the bridge can't
# start without its port). Re-run it with a newer release to upgrade; the token, BLE and LoRa node choices are kept.
# nRF52 LoRa boards (RAK4631, SenseCAP / XIAO, Nordic) never become /dev/kelly-radio: they are mesh nodes, not radio
# leads, and the last USB serial device plugged in used to take the name.
# Setup recipe first proven by hand on a Pi 4 (Debian 13), 2026-10-12.
set -e

MOXA=no; BLE=""; BLE_ZONE=""; NODE=no; N_SERVER=""; N_ID=""; N_TOKEN=""; N_ADAPTER="hci0"; MESH=""; MESH_BLE=""; MESH_BLE_PIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --moxa) MOXA=yes ;;
    --ble) if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then BLE="$2"; shift; else BLE="hci0"; fi ;;
    --ble-zone) BLE_ZONE="$2"; shift ;;
    --ble-node) NODE=yes ;;
    --server) N_SERVER="$2"; shift ;;
    --node) N_ID="$2"; shift ;;
    --token) N_TOKEN="$2"; shift ;;
    --adapter) N_ADAPTER="$2"; shift ;;
    --mesh-serial) MESH="$2"; shift ;;
    --mesh-ble) MESH_BLE="$2"; shift ;;
    --mesh-ble-pin) MESH_BLE_PIN="$2"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run this with sudo:   sudo bash \"$0\""
  exit 1
fi
RUN_AS="${SUDO_USER:-}"
if [ -z "$RUN_AS" ] || [ "$RUN_AS" = root ]; then
  echo "Run this from your own login with sudo, not as root."
  exit 1
fi
SRC="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$SRC/index.html" ] || [ ! -f "$SRC/bridge/kelly_bridge.py" ]; then
  echo "Can't find Kelly Page next to this script ($SRC). Unzip the whole release first."
  exit 1
fi

echo "== Kelly Page installer =="
echo "-- Installing the serial-port library (needs internet, can take a few minutes)"
apt-get update -q >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3 python3-serial python3-cryptography >/dev/null
if [ "$MOXA" = yes ]; then
  echo "-- Installing the MOXA UPort firmware"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q firmware-misc-nonfree >/dev/null
fi

echo "-- Copying Kelly Page to /opt/kelly-page"
rm -rf /opt/kelly-page.new
cp -a "$SRC" /opt/kelly-page.new
rm -rf /opt/kelly-page
mv /opt/kelly-page.new /opt/kelly-page
chown -R root:root /opt/kelly-page

# Bluetooth LE (the BLE Presence page / a scanner node): BlueZ + bleak, Bluetooth on and unblocked, the user in the
# bluetooth group (BlueZ's D-Bus policy), then a self-test: adapter health and a 6 s scan.
ble_setup() {
  echo "-- Setting up Bluetooth LE (BlueZ + bleak)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q bluez python3-bleak rfkill >/dev/null
  usermod -aG bluetooth "$RUN_AS" 2>/dev/null || true
  rfkill unblock bluetooth 2>/dev/null || true
  systemctl enable --now bluetooth >/dev/null 2>&1 || true
  for a in $(echo "$1" | tr ',' ' '); do
    [ "$a" = sim ] && continue
    btmgmt -i "$a" power on >/dev/null 2>&1 || true
    echo "   self-test on $a:"
    sudo -u "$RUN_AS" python3 - "$a" <<'PY' || echo "   (self-test failed -- see above)"
import asyncio, sys
sys.path.insert(0, "/opt/kelly-page/bridge")
import kelly_ble as K
a = sys.argv[1]
h = K.health(a)
print(f"   {a}: {'OK' if h['ok'] else 'NEEDS ATTENTION'}" + (f", {h['tempC']} C" if 'tempC' in h else "") + (f", {', '.join(h['throttle'])}" if h.get('throttle') else ""))
for f in h["fix"]:
    print("     fix: " + f)
seen = []
async def scan():
    s = K.Scanner(a, seen.append, log=lambda *_: None)
    t = asyncio.ensure_future(s.run())
    await asyncio.sleep(6)
    t.cancel()
    if s.error:
        print("     scanner: " + s.error)
asyncio.run(scan())
print(f"   heard {len(seen)} adverts from {len({r['a'] for r in seen})} devices in 6 s")
PY
  done
  if grep -q "Raspberry Pi" /proc/device-tree/model 2>/dev/null && echo "$1" | grep -q hci0; then
    echo "   Note: the Pi's own Bluetooth shares its radio with Wi-Fi -- for a busy site, scan with a USB dongle (--ble hci1)."
  fi
}

# ---- a remote scanner node: no radio, no page -- just kelly_ble_node.py as a service
if [ "$NODE" = yes ]; then
  if [ -z "$N_SERVER" ] || [ -z "$N_ID" ] || [ -z "$N_TOKEN" ]; then
    echo "--ble-node needs --server HOST:8025 --node ID --token TOKEN (the BLE page > Adapters & nodes > Add makes the token)."
    exit 1
  fi
  ble_setup "$N_ADAPTER"
  timedatectl set-ntp true 2>/dev/null || true     # node timestamps matter: absences are judged by them
  umask 077
  printf 'KELLY_BLE_NODE_TOKEN=%s\n' "$N_TOKEN" > /etc/kelly-ble-node.env
  umask 022
  cat > /etc/systemd/system/kelly-ble-node.service <<EOF
[Unit]
Description=Kelly BLE scanner node ($N_ID -> $N_SERVER)
After=network-online.target bluetooth.service
Wants=network-online.target bluetooth.service

[Service]
EnvironmentFile=/etc/kelly-ble-node.env
ExecStart=/usr/bin/python3 /opt/kelly-page/bridge/kelly_ble_node.py --server $N_SERVER --node $N_ID --adapter $N_ADAPTER
User=$RUN_AS
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable kelly-ble-node.service >/dev/null 2>&1
  systemctl restart kelly-ble-node.service
  sleep 5
  echo
  echo "== Done: BLE scanner node '$N_ID' =="
  journalctl -u kelly-ble-node.service -n 6 --no-pager -o cat
  echo "It shows in Kelly's BLE Presence page > Adapters & nodes. Logs: journalctl -u kelly-ble-node -f"
  exit 0
fi

# The token keeps strangers on your network from keying your radio. Kept across upgrades.
TOKEN=""
if [ -f /etc/kelly-bridge.env ]; then
  TOKEN="$(sed -n 's/^KELLY_BRIDGE_TOKEN=//p' /etc/kelly-bridge.env)"
fi
if [ -z "$TOKEN" ]; then
  TOKEN="$(tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' </dev/urandom | head -c 10)"
fi
# BLE: --ble this time, or what an earlier install chose
OLD_BLE_ARGS=""
[ -f /etc/kelly-bridge.env ] && OLD_BLE_ARGS="$(sed -n 's/^KELLY_BLE_ARGS=//p' /etc/kelly-bridge.env)"
BLE_ARGS="$OLD_BLE_ARGS"
[ -n "$BLE" ] && BLE_ARGS="--ble $BLE${BLE_ZONE:+ --ble-zone $(echo "$BLE_ZONE" | tr -cd 'A-Za-z0-9_-')}"
# LoRa node: --mesh-serial this time, or what an earlier install chose ("none" drops it)
OLD_MESH_ARGS=""
[ -f /etc/kelly-bridge.env ] && OLD_MESH_ARGS="$(sed -n 's/^KELLY_MESH_ARGS=//p' /etc/kelly-bridge.env)"
MESH_ARGS="$OLD_MESH_ARGS"
[ -n "$MESH" ] && MESH_ARGS="--mesh-serial $(echo "$MESH" | tr -cd 'A-Za-z0-9_./:-')"
[ "$MESH" = none ] && MESH_ARGS=""
[ -n "$MESH_BLE" ] && MESH_ARGS="--mesh-ble $(echo "$MESH_BLE" | tr -cd 'A-Fa-f0-9:')"
# the Bluetooth node's pairing PIN: --mesh-ble-pin this time, or what an earlier install chose (env, not the command line)
MESH_BLE_PIN_OLD=""
[ -f /etc/kelly-bridge.env ] && MESH_BLE_PIN_OLD="$(sed -n 's/^KELLY_MESH_BLE_PIN=//p' /etc/kelly-bridge.env)"
MESH_BLE_PIN="$(echo "${MESH_BLE_PIN:-$MESH_BLE_PIN_OLD}" | tr -cd '0-9')"
umask 077
printf 'KELLY_BRIDGE_TOKEN=%s\nKELLY_BLE_ARGS=%s\nKELLY_MESH_ARGS=%s\nKELLY_MESH_BLE_PIN=%s\n' "$TOKEN" "$BLE_ARGS" "$MESH_ARGS" "$MESH_BLE_PIN" > /etc/kelly-bridge.env
umask 022
[ -n "$BLE_ARGS" ] && ble_setup "$(echo "$BLE_ARGS" | awk '{print $2}')"
# a MeshCore node over Bluetooth: BlueZ + bleak + the bluetooth group (the bridge registers its own pairing agent)
if echo "$MESH_ARGS" | grep -q -- --mesh-ble && [ -z "$BLE_ARGS" ]; then
  echo "-- Setting up Bluetooth for the LoRa node (BlueZ + bleak)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q bluez python3-bleak rfkill >/dev/null
  usermod -aG bluetooth "$RUN_AS" 2>/dev/null || true
  rfkill unblock bluetooth 2>/dev/null || true
  systemctl enable --now bluetooth >/dev/null 2>&1 || true
fi

usermod -aG dialout "$RUN_AS"

echo "-- Setting up the bridge service"
# Any USB serial lead -> /dev/kelly-radio, and plugging one in starts the bridge. Not an nRF52 LoRa board
# (USB vendor 239a RAK/Adafruit, 2886 Seeed, 1915 Nordic): those are mesh nodes (--mesh-serial), never the radio.
cat > /etc/udev/rules.d/99-kelly-radio.rules <<'EOF'
SUBSYSTEM=="tty", KERNEL=="ttyUSB[0-9]*|ttyACM[0-9]*", ENV{ID_VENDOR_ID}!="239a|2886|1915", SYMLINK+="kelly-radio", GROUP="dialout", MODE="0660", TAG+="systemd", ENV{SYSTEMD_WANTS}+="kelly-bridge.service"
EOF

cat > /etc/systemd/system/kelly-bridge.service <<EOF
[Unit]
Description=Kelly Page IP bridge (USB serial radio <-> WebSocket, page on :8025)
BindsTo=dev-kelly\\x2dradio.device
After=dev-kelly\\x2dradio.device network-online.target

[Service]
EnvironmentFile=/etc/kelly-bridge.env
ExecStart=/usr/bin/python3 /opt/kelly-page/bridge/kelly_bridge.py --serial /dev/kelly-radio --baud 19200 --bind 0.0.0.0 --port 8025 --keeper-local \$KELLY_BLE_ARGS \$KELLY_MESH_ARGS
User=$RUN_AS
Group=dialout
$( [ -n "$BLE_ARGS" ] && printf '%s\n%s' '# BLE Inspector: raw HCI advertising reports (read-only; btmon needs the same)' 'AmbientCapabilities=CAP_NET_RAW' )
Restart=on-failure
RestartSec=5

[Install]
WantedBy=dev-kelly\\x2dradio.device
EOF

# Kelly keeper: Kelly itself running on the Pi (headless Chromium), so the radio stays on the network
# with every PC switched off. It steps aside whenever someone opens Kelly from a computer. Needs the
# station's Kelly settings: a config file saved from Kelly (Admin > Save config) copied to ~/kelly-config.xml.
HOME_DIR="$(getent passwd "$RUN_AS" | cut -d: -f6)"
KEEPER_CFG="$HOME_DIR/kelly-config.xml"
KEEPER=no
if [ -f "$KEEPER_CFG" ]; then
  echo "-- Setting up Kelly on the Pi itself (headless browser, a few minutes the first time)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q chromium-headless-shell >/dev/null
  cat > /etc/systemd/system/kelly-keeper.service <<EOF
[Unit]
Description=Kelly keeper (Kelly Page on the radio while nobody else is using it)
BindsTo=kelly-bridge.service
After=kelly-bridge.service

[Service]
EnvironmentFile=/etc/kelly-bridge.env
ExecStart=/usr/bin/python3 /opt/kelly-page/bridge/kelly_keeper.py --port 8025 --config $KEEPER_CFG
User=$RUN_AS
Restart=always
RestartSec=10

[Install]
WantedBy=kelly-bridge.service
EOF
  KEEPER=yes
elif [ -f /etc/systemd/system/kelly-keeper.service ]; then
  systemctl disable --now kelly-keeper.service >/dev/null 2>&1 || true
fi

udevadm control --reload-rules
systemctl daemon-reload
systemctl enable kelly-bridge.service >/dev/null 2>&1
[ "$KEEPER" = yes ] && systemctl enable kelly-keeper.service >/dev/null 2>&1
udevadm trigger --subsystem-match=tty --action=add
sleep 2
if systemctl is-active --quiet kelly-bridge.service; then
  systemctl restart kelly-bridge.service        # pick up the newly copied files on an upgrade
  [ "$KEEPER" = yes ] && systemctl restart kelly-keeper.service
fi

HOST="$(hostname)"
IP="$(hostname -I | awk '{print $1}')"
ADDR_FILE="$(getent passwd "$RUN_AS" | cut -d: -f6)/kelly-address.txt"
cat > "$ADDR_FILE" <<EOF
Kelly Page on this Raspberry Pi -- open one of these in Chrome or Edge and bookmark it:

  http://$HOST.local:8025/?connect=ip&token=$TOKEN
  http://$IP:8025/?connect=ip&token=$TOKEN

The IP bridge address (Admin > IP bridge), if you ever type it in by hand:
  ws://$HOST.local:8025/ws?token=$TOKEN
EOF
chown "$RUN_AS" "$ADDR_FILE"

echo
echo "== Done =="
if [ -e /dev/kelly-radio ]; then
  if systemctl is-active --quiet kelly-bridge.service; then
    echo "Radio lead found ($(readlink -f /dev/kelly-radio)) and Kelly's bridge is running."
  else
    echo "Radio lead found, but the bridge didn't start. Show this to whoever helps you:"
    journalctl -u kelly-bridge.service -n 10 --no-pager
  fi
else
  echo "No USB serial lead plugged in yet. Plug it in: the bridge starts by itself."
fi
if [ "$KEEPER" = yes ]; then
  echo "Kelly also runs on the Pi itself, so your radio stays on the network with your PC off."
  echo "It steps aside whenever you open Kelly from a computer."
else
  echo "To keep Kelly on the network with your PC off: save your settings in Kelly (Admin > Save config),"
  echo "copy the file to the Pi as kelly-config.xml, and run this installer again."
fi
echo
cat "$ADDR_FILE"
echo "(Saved in $ADDR_FILE -- see it again any time with:  cat ~/kelly-address.txt)"
echo
echo "== Your phone =="
# the address a phone on your WiFi opens Kelly at, as a QR code (kelly_qr.py; again any time: sudo python3 ... --connect-qr)
python3 /opt/kelly-page/bridge/kelly_bridge.py --connect-qr || true
echo "(Show this again any time with:  sudo python3 /opt/kelly-page/bridge/kelly_bridge.py --connect-qr)"
