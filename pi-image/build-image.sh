#!/bin/bash
# Build the Kelly Page Raspberry Pi image: the official Raspberry Pi OS Lite (64-bit) with Kelly Page installed,
# headless, slimmed, shrunk and xz-compressed for Raspberry Pi Imager.
#
#   sudo ./build-image.sh KellyPage-0.4.35-....zip [--url-base https://host/kellypage/] [--out DIR] [--work DIR]
#                         [--base FILE.img.xz | --base latest]
#
#   KellyPage-*.zip   the release zip from scripts/package_kelly.py (the same zip users get)
#   --url-base        where you'll publish the .img.xz: goes into the Imager os_list JSON (default: a placeholder)
#   --base            the Pi OS Lite image: default = the pinned one below (downloaded + checked);
#                     "latest" = whatever raspberrypi.com serves today (checked against its own .sha256)
#
# Needs a Debian / Ubuntu / Kali box (WSL2 is fine) with root, loop devices, and qemu-user-static + binfmt for arm64:
#   apt install qemu-user-static binfmt-support parted e2fsprogs zerofree xz-utils fdisk curl
# Output in --out (default ./out): kellypage-<ver>-arm64-lite.img.xz, .sha256, kellypage-os-list.json, build report.
#
# Method: the official Lite image, modified offline (loop mount + chroot), never booted. So every Pi still does
# Raspberry Pi OS's own first boot: fresh SSH host keys, a new machine-id, the root partition grown to the card,
# and cloud-init applying Imager's OS customisation (Wi-Fi, user, hostname).
set -euo pipefail

PINNED_URL="https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-10-06/2026-10-06-raspios-trixie-arm64-lite.img.xz"
PINNED_SHA="483db18a48da399b5b7022ffae9a07bc6d99daab30e593aedac09b69ff422843"
GROW_MB=1024                      # room for the chroot work; shrunk back off at the end

HERE="$(cd "$(dirname "$0")" && pwd)"
ZIP=""; URL_BASE="https://example.org/kellypage/"; OUT="$PWD/out"; WORK="/var/tmp/kellypage-build"; BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url-base) URL_BASE="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --work) WORK="$2"; shift ;;
    --base) BASE="$2"; shift ;;
    -*) echo "unknown option $1"; exit 1 ;;
    *) ZIP="$1" ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[ -f "$ZIP" ] || { echo "usage: sudo $0 KellyPage-<ver>-....zip [--url-base URL] [--out DIR]"; exit 1; }
for t in losetup parted sfdisk e2fsck resize2fs zerofree xz curl sha256sum chroot python3; do
  command -v $t >/dev/null || { echo "missing: $t"; exit 1; }
done
ls /proc/sys/fs/binfmt_misc/ | grep -q aarch64 || { echo "no arm64 binfmt: apt install qemu-user-static binfmt-support"; exit 1; }
ZIP="$(readlink -f "$ZIP")"
mkdir -p "$OUT" "$WORK/dl"
OUT="$(readlink -f "$OUT")"
VER="$(python3 -c "import re,sys,zipfile; print(re.search(r\"KELLY_VERSION = '([^']+)'\", zipfile.ZipFile(sys.argv[1]).read('Kelly Page/js/version.js').decode()).group(1))" "$ZIP")"
NAME="kellypage-$VER-arm64-lite"
REPORT="$OUT/$NAME-build-report.txt"
echo "== Kelly Page $VER image ==" | tee "$REPORT"

# ---- 1. the base image, checked
if [ -z "$BASE" ] || [ "$BASE" = latest ]; then
  if [ "$BASE" = latest ]; then
    URL="$(curl -sIL -o /dev/null -w '%{url_effective}' https://downloads.raspberrypi.com/raspios_lite_arm64_latest)"
    SHA="$(curl -sfL "$URL.sha256" | awk '{print $1}')"
  else URL="$PINNED_URL"; SHA="$PINNED_SHA"; fi
  BASE="$WORK/dl/$(basename "$URL")"
  [ -f "$BASE" ] || curl -fL --progress-bar -o "$BASE" "$URL"
  echo "$SHA  $BASE" | sha256sum -c - >/dev/null || { echo "base image checksum mismatch: $BASE"; exit 1; }
fi
echo "Base: $(basename "$BASE") (sha256 $(sha256sum "$BASE" | cut -c1-16)...)" | tee -a "$REPORT"

# ---- 2. unpack, grow for the work
IMG="$WORK/$NAME.img"
echo "-- unpacking"
xz -dc "$BASE" > "$IMG"
truncate -s +${GROW_MB}M "$IMG"
parted -s "$IMG" resizepart 2 100%

MNT="$WORK/mnt"; mkdir -p "$MNT"
LOOP=""
cleanup() {
  set +e
  for m in dev/pts dev proc sys run boot/firmware ""; do mountpoint -q "$MNT/$m" && umount -l "$MNT/$m"; done
  [ -n "$LOOP" ] && losetup -d "$LOOP"
}
trap cleanup EXIT
LOOP="$(losetup -fP --show "$IMG")"
e2fsck -fy "${LOOP}p2" >/dev/null || true
resize2fs "${LOOP}p2" >/dev/null
mount "${LOOP}p2" "$MNT"
mount "${LOOP}p1" "$MNT/boot/firmware"
for m in dev dev/pts proc sys run; do mount --bind "/$m" "$MNT/$m"; done

# ---- 3. overlay + chroot customise
echo "-- customising (chroot, emulated arm64: several minutes)"
cp -a "$MNT/etc/resolv.conf" "$WORK/resolv.conf.orig" 2>/dev/null || true
RESOLV_LINK="$(readlink "$MNT/etc/resolv.conf" || true)"
rm -f "$MNT/etc/resolv.conf"; cat /etc/resolv.conf > "$MNT/etc/resolv.conf"
printf '#!/bin/sh\nexit 101\n' > "$MNT/usr/sbin/policy-rc.d"; chmod 755 "$MNT/usr/sbin/policy-rc.d"
# the overlay: LF line endings whatever the checkout did, root-owned
( cd "$HERE/rootfs" && find . -type f ) | while read -r f; do
  install -D -o root -g root -m 0644 "$HERE/rootfs/$f" "$MNT/$f"
  sed -i 's/\r$//' "$MNT/$f"
done
mkdir -p "$MNT/tmp/kp"
cp "$ZIP" "$MNT/tmp/kp/kelly.zip"
sed 's/\r$//' "$HERE/customise.sh" > "$MNT/tmp/kp/customise.sh"
chroot "$MNT" /bin/bash /tmp/kp/customise.sh 2>&1 | tee "$WORK/customise.log" | grep -v '^\(REMOVED\|ADDED\) ' || true
grep -q '^\[customise\] done' "$WORK/customise.log" || { echo "customise.sh failed -- see $WORK/customise.log"; exit 1; }

# boot partition: hostname for cloud-init (Imager's own OS customisation replaces this file)
sed -i 's/^#hostname: raspberrypi/hostname: kellypage/' "$MNT/boot/firmware/user-data"

# ---- 4. scrub: nothing of this build machine, nothing per-Pi
rm -f "$MNT/usr/sbin/policy-rc.d" "$MNT/etc/resolv.conf"
if [ -n "$RESOLV_LINK" ]; then ln -s "$RESOLV_LINK" "$MNT/etc/resolv.conf"; else cp -a "$WORK/resolv.conf.orig" "$MNT/etc/resolv.conf"; fi
rm -rf "$MNT/tmp/kp" "$MNT"/tmp/* "$MNT"/var/tmp/*
rm -f "$MNT"/etc/ssh/ssh_host_*                         # regenerated on each Pi's first boot
echo uninitialized > "$MNT/etc/machine-id"             # = systemd's "first boot" marker (an empty file isn't)
rm -f "$MNT/var/lib/dbus/machine-id" "$MNT/var/lib/systemd/random-seed" "$MNT/var/lib/systemd/credential.secret"
find "$MNT/var/log" -type f -exec truncate -s 0 {} +
rm -rf "$MNT"/var/log/journal/* "$MNT/root/.bash_history" "$MNT/root/.cache" "$MNT/root/.wget-hsts" "$MNT/root/.lesshst"
rm -rf "$MNT"/var/lib/cloud/* 2>/dev/null || true
for m in dev/pts dev proc sys run boot/firmware; do umount "$MNT/$m"; done
LEFT="$(grep -rIl -e "$(hostname)" -e "${SUDO_USER:-nobody-here}" "$MNT/etc" "$MNT/home" "$MNT/root" "$MNT/var/lib/kellypage" 2>/dev/null | grep -v -e /etc/passwd -e /etc/group -e /etc/shadow -e /etc/gshadow || true)"
[ -z "$LEFT" ] || { echo "!! build-machine names found in: $LEFT"; exit 1; }
umount "$MNT"

# ---- 5. shrink: fs to its minimum, zero the free space, partition and file cut to fit
echo "-- shrinking"
# right after the unmount the partition can still be busy for a moment (udev probing it): wait for a clean check
sync; udevadm settle 2>/dev/null || true
for i in 1 2 3 4 5 6; do
  e2fsck -fy "${LOOP}p2" >"$WORK/fsck.log" 2>&1; rc=$?
  [ $rc -le 1 ] && break
  sleep 3
done
[ $rc -le 1 ] || { echo "e2fsck failed (rc $rc):"; cat "$WORK/fsck.log"; exit 1; }
resize2fs -M "${LOOP}p2" >/dev/null
# + 64 MB, so the first boot can write keys and logs before Pi OS grows the partition to the card
MIN="$(dumpe2fs -h "${LOOP}p2" 2>/dev/null | awk -F: '/^Block count/{gsub(/ /,"",$2); print $2}')"
resize2fs "${LOOP}p2" $(( MIN + 16384 )) >/dev/null 2>&1
e2fsck -fy "${LOOP}p2" >/dev/null || true
zerofree "${LOOP}p2"
BLOCKS="$(dumpe2fs -h "${LOOP}p2" 2>/dev/null | awk -F: '/^Block count/{gsub(/ /,"",$2); print $2}')"
BSIZE="$(dumpe2fs -h "${LOOP}p2" 2>/dev/null | awk -F: '/^Block size/{gsub(/ /,"",$2); print $2}')"
losetup -d "$LOOP"; LOOP=""
START="$(sfdisk -d "$IMG" | awk -F'[=,]' '/img2/{gsub(/ /,"",$2); print $2}')"
SECTORS=$(( (BLOCKS * BSIZE + 511) / 512 ))
echo "$START,$SECTORS" | sfdisk --no-reread --no-tell-kernel -q -N 2 "$IMG" >/dev/null
truncate -s $(( (START + SECTORS) * 512 )) "$IMG"

# ---- 6. compress, checksum, Imager os_list
echo "-- compressing (xz -9)"
rm -f "$OUT/$NAME.img.xz"
xz -9 -T0 -c "$IMG" > "$OUT/$NAME.img.xz"
( cd "$OUT" && sha256sum "$NAME.img.xz" > "$NAME.img.xz.sha256" )
python3 - "$OUT" "$NAME" "$IMG" "$URL_BASE" "$VER" > "$OUT/kellypage-os-list.json" <<'PY'
import datetime, hashlib, json, os, sys
out, name, img, base, ver = sys.argv[1:]
xz = os.path.join(out, name + ".img.xz")
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
print(json.dumps({"os_list": [{
    "name": f"Kelly Page {ver} (Raspberry Pi OS Lite 64-bit)",
    "description": "Kelly Page for Tait radios, LoRa mesh and Bluetooth -- headless; open http://kellypage.local:8025",
    "url": base.rstrip("/") + "/" + name + ".img.xz",
    "icon": base.rstrip("/") + "/kellypage-icon.png",
    "website": base,
    "release_date": datetime.date.today().isoformat(),
    "extract_size": os.path.getsize(img),
    "extract_sha256": sha(img),
    "image_download_size": os.path.getsize(xz),
    "image_download_sha256": sha(xz),
    "init_format": "cloudinit-rpi",
    "devices": ["pi5-64bit", "pi4-64bit", "pi3-64bit"],
}]}, indent=2))
PY

# ---- 7. report
{
  echo
  echo "Uncompressed: $(( $(stat -c%s "$IMG") / 1048576 )) MB   ($NAME.img)"
  echo "Compressed:   $(( $(stat -c%s "$OUT/$NAME.img.xz") / 1048576 )) MB   ($NAME.img.xz)"
  echo "Base image:   $(( $(xz -l --robot "$BASE" | awk '/^totals/{print $5}') / 1048576 )) MB uncompressed, $(( $(stat -c%s "$BASE") / 1048576 )) MB .xz"
  echo
  echo "Packages removed:"; grep '^REMOVED ' "$WORK/customise.log" | cut -d' ' -f2 | paste -sd' ' | fold -s -w 110 | sed 's/^/  /'
  echo "Packages added:";   grep '^ADDED ' "$WORK/customise.log" | cut -d' ' -f2 | paste -sd' ' | fold -s -w 110 | sed 's/^/  /'
  echo "Also removed: /usr/share/doc (copyright notices kept), man pages, info, lintian, translations other than en/en_AU/en_US,"
  echo "  the apt package lists + cache, logs, SSH host keys, machine-id (reset to 'uninitialized'), cloud-init state,"
  echo "  the swap file (zram only). Kept: Pi Wi-Fi (brcm/cypress), Realtek, BlueZ firmware, both kernels (Pi 3/4 + Pi 5)."
} | tee -a "$REPORT"
rm -f "$IMG"
echo
echo "Done: $OUT/$NAME.img.xz"
