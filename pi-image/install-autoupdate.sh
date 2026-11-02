#!/bin/bash
# Put the signed auto-update onto a Pi that is ALREADY RUNNING Kelly Page (an image built before auto-update existed).
# Idempotent: run it again any time. New images already have all of this (customise.sh).
#
#   scp -r pi-image kelly@kellypage.local:        (or just the pi-image folder from the repo)
#   ssh kelly@kellypage.local 'sudo bash pi-image/install-autoupdate.sh --enable --channel beta'
#
#   --enable           ENABLED=1 (without it an existing setting is kept; a fresh install is ENABLED=0)
#   --disable          ENABLED=0
#   --channel stable|beta   (without it an existing choice is kept; a fresh install is stable)
#
# Installs: kellypage-autoupdate, kpu1.py, the pinned release key(s), the systemd service + timer, and the current
# kellypage-update (with --rollback) and kellypage-setup. Needs python3-cryptography (Kelly's device key needs it too).
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exec sudo bash "$0" "$@"; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="$HERE/rootfs"
ENABLE="" CHANNEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --enable) ENABLE=1 ;;
    --disable) ENABLE=0 ;;
    --channel) shift; CHANNEL="${1:-}" ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done
case "$CHANNEL" in ""|stable|beta) ;; *) echo "--channel must be stable or beta"; exit 2 ;; esac
for f in usr/local/sbin/kellypage-autoupdate usr/local/lib/kellypage/kpu1.py etc/kellypage/release-keys.json \
         etc/kellypage/autoupdate.conf etc/systemd/system/kellypage-autoupdate.service \
         etc/systemd/system/kellypage-autoupdate.timer usr/local/bin/kellypage-update usr/local/bin/kellypage-setup; do
  [ -f "$R/$f" ] || { echo "missing $R/$f -- run this from the repo's kelly-page/pi-image folder"; exit 1; }
done
python3 -c "import cryptography" 2>/dev/null || { echo "python3-cryptography is missing: sudo apt install python3-cryptography"; exit 1; }

# strip any CR a Windows copy may have added to the scripts
for f in usr/local/sbin/kellypage-autoupdate usr/local/lib/kellypage/kpu1.py usr/local/bin/kellypage-update \
         usr/local/bin/kellypage-setup etc/systemd/system/kellypage-autoupdate.service etc/systemd/system/kellypage-autoupdate.timer; do
  mode=0644; [ "${f#usr/local/}" != "$f" ] && mode=0755
  install -d -o root -g root -m 0755 "$(dirname "/$f")"   # e.g. /usr/local/lib/kellypage doesn't exist on a hand-built Pi
  tr -d '\r' < "$R/$f" > "/$f.new"
  chown root:root "/$f.new"; chmod "$mode" "/$f.new"
  mv -f "/$f.new" "/$f"
done
install -d -o root -g root -m 0755 /etc/kellypage
install -o root -g root -m 0644 "$R/etc/kellypage/release-keys.json" /etc/kellypage/release-keys.json
if [ ! -f /etc/kellypage/autoupdate.conf ]; then
  install -o root -g root -m 0644 "$R/etc/kellypage/autoupdate.conf" /etc/kellypage/autoupdate.conf
fi
C=/etc/kellypage/autoupdate.conf
[ -z "$ENABLE" ] || sed -i "s|^ENABLED=.*|ENABLED=$ENABLE|" "$C"
[ -z "$CHANNEL" ] || sed -i "s|^CHANNEL=.*|CHANNEL=$CHANNEL|" "$C"
grep -q '^ENABLED=' "$C" || echo "ENABLED=0" >> "$C"
grep -q '^CHANNEL=' "$C" || echo "CHANNEL=stable" >> "$C"
python3 -c "import sys; sys.path.insert(0,'/usr/local/lib/kellypage'); import kpu1; print('pinned keys:', ', '.join(sorted(kpu1.load_keys('/etc/kellypage/release-keys.json'))))"
find /usr/local -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
mkdir -p /var/lib/kellypage
systemctl daemon-reload
systemctl enable --now kellypage-autoupdate.timer
echo "== Auto-update installed: $(grep -h '^ENABLED=\|^CHANNEL=' "$C" | paste -sd' ')"
systemctl list-timers kellypage-autoupdate.timer --no-pager | head -3
echo "Try it now (no install): sudo kellypage-autoupdate --force --check ;  log: journalctl -u kellypage-autoupdate"
