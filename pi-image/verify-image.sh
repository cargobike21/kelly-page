#!/bin/bash
# Boot a built Kelly Page image in QEMU and check it like a new user would.
#   sudo ./verify-image.sh out/kellypage-<ver>-arm64-lite.img.xz
# Needs: qemu-system-arm (qemu-system-aarch64), qemu-user-static, qemu-utils, expect, sshpass, curl, internet.
# Checks the shipped image (no host keys / token / Wi-Fi / build-machine names), then boots a COPY and checks the
# forced password change at the first SSH login, fresh host keys, kelly-bridge running, the page served, the root
# filesystem grown to the (4 GB) disk, sudo needing a password, no failed units.
#
# QEMU can't run Raspberry Pi OS's own kernel usefully: its raspi3b board resets / panics ~11 s into every boot (the
# stock Pi OS image too) and the Pi kernel has no virtio. So the copy gets Debian's generic arm64 kernel (chroot
# install; initramfs built by the image's own initramfs-tools) and boots on QEMU's "virt" board. Everything after
# the kernel -- systemd, cloud-init, the first boot, SSH, Kelly -- is the image's own.
set -uo pipefail
XZ="$(readlink -f "$1")"
W=/var/tmp/kellypage-verify
NEWPASS="Kelly-verify-$RANDOM$RANDOM"
PORT=2222; WEB=18025
rm -rf "$W"; mkdir -p "$W/root"
echo "-- unpacking $(basename "$XZ")"
xz -dc "$XZ" > "$W/sd.img"
SHIPPED=$(stat -c%s "$W/sd.img")

LOOP=$(losetup -fP --show "$W/sd.img")
mount -o ro "${LOOP}p2" "$W/root"
echo "-- in the image as shipped"
echo "   ssh host keys: $(ls "$W"/root/etc/ssh/ssh_host_* 2>/dev/null | wc -l) (want 0)"
echo "   machine-id: $(cat "$W/root/etc/machine-id") (want uninitialized)"
echo "   bridge token: '$(sed -n 's/^KELLY_BRIDGE_TOKEN=//p' "$W/root/etc/kelly-bridge.env")' (want empty)"
echo "   device key: $(ls -A "$W/root/var/lib/kellypage/.kelly-ident" 2>/dev/null | wc -l) file(s) (want 0: made on the Pi's first start)"
echo "   wifi configs: $(ls "$W"/root/etc/NetworkManager/system-connections/ 2>/dev/null | wc -l) (want 0)"
echo "   root fs: $(df -h "$W/root" | awk 'NR==2{print $3 " used, " $4 " free"}')"
chk() { if eval "$2"; then echo "   PASS $1"; else echo "   FAIL $1"; fi; }
chk "auto-update script is executable"  "[ -x '$W/root/usr/local/sbin/kellypage-autoupdate' ] && [ -f '$W/root/usr/local/lib/kellypage/kpu1.py' ]"
chk "auto-update timer enabled"          "[ -L '$W/root/etc/systemd/system/timers.target.wants/kellypage-autoupdate.timer' ]"
chk "auto-update service unit present"   "[ -f '$W/root/etc/systemd/system/kellypage-autoupdate.service' ]"
chk "release key rel-2026a pinned"       "grep -q '\"rel-2026a\"' '$W/root/etc/kellypage/release-keys.json'"
chk "auto-update ships OFF (ENABLED=0)"  "grep -qx 'ENABLED=0' '$W/root/etc/kellypage/autoupdate.conf'"
for pat in "${VERIFY_PERSONAL:-}" "$(hostname)"; do
  [ -n "$pat" ] || continue
  n=$(grep -rIl -e "$pat" "$W/root/etc" "$W/root/home" "$W/root/root" "$W/root/var/lib" "$W/root/opt" "$W/root/usr/local" 2>/dev/null | wc -l)
  echo "   files mentioning '$pat': $n (want 0)"
done
umount "$W/root"; losetup -d "$LOOP"

echo "-- test copy: 4 GB disk + Debian's generic arm64 kernel (chroot)"
qemu-img resize -q -f raw "$W/sd.img" 4G
# the kernel and its modules need room: grow the root partition by 600 MB now (the first boot grows the rest)
read -r START SIZE < <(sfdisk -d "$W/sd.img" | awk -F'[=,]' '/sd.img2/{gsub(/ /,"",$2); gsub(/ /,"",$4); print $2, $4}')
echo "$START,$(( SIZE + 1228800 ))" | sfdisk --no-reread --no-tell-kernel -q -N 2 "$W/sd.img" >/dev/null
LOOP=$(losetup -fP --show "$W/sd.img")
e2fsck -fy "${LOOP}p2" >/dev/null 2>&1; resize2fs "${LOOP}p2" >/dev/null 2>&1
mount "${LOOP}p2" "$W/root"; mount "${LOOP}p1" "$W/root/boot/firmware"
for m in dev dev/pts proc sys; do mount --bind "/$m" "$W/root/$m"; done
RL="$(readlink "$W/root/etc/resolv.conf")"
rm -f "$W/root/etc/resolv.conf"; cat /etc/resolv.conf > "$W/root/etc/resolv.conf"
printf '#!/bin/sh\nexit 101\n' > "$W/root/usr/sbin/policy-rc.d"; chmod 755 "$W/root/usr/sbin/policy-rc.d"
# Pi OS builds its initramfs with MODULES=dep, which in a chroot means "the build host's drivers": no virtio
sed -i 's/^MODULES=.*/MODULES=most/' "$W/root/etc/initramfs-tools/initramfs.conf"
printf 'virtio_pci\nvirtio_blk\nvirtio_net\n' >> "$W/root/etc/initramfs-tools/modules"
chroot "$W/root" /bin/sh -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends linux-image-arm64' \
  >"$W/kernel.log" 2>&1 || { echo "!! kernel install failed: $W/kernel.log"; tail -5 "$W/kernel.log"; }
cp "$(ls "$W"/root/boot/vmlinuz-*-arm64 | tail -1)" "$W/vmlinuz"
cp "$(ls "$W"/root/boot/initrd.img-*-arm64 | tail -1)" "$W/initrd"
rm -f "$W/root/usr/sbin/policy-rc.d" "$W/root/etc/resolv.conf"
[ -n "$RL" ] && ln -s "$RL" "$W/root/etc/resolv.conf"
rm -rf "$W"/root/var/lib/apt/lists/*
echo uninitialized > "$W/root/etc/machine-id"; rm -f "$W"/root/etc/ssh/ssh_host_*   # as shipped again
CMDLINE="$(sed -e 's/console=serial0,115200/console=ttyAMA0,115200/' -e 's/console=tty1//' "$W/root/boot/firmware/cmdline.txt")"
for m in sys proc dev/pts dev boot/firmware ""; do umount "$W/root/$m"; done
losetup -d "$LOOP"

echo "-- booting (QEMU virt, cortex-a72 x4, 2 GB)"
qemu-system-aarch64 -M virt -cpu cortex-a72 -smp 4 -m 2G -kernel "$W/vmlinuz" -initrd "$W/initrd" -append "$CMDLINE" \
  -drive file="$W/sd.img",if=virtio,format=raw \
  -netdev user,id=n0,hostfwd=tcp::$PORT-:22,hostfwd=tcp::$WEB-:8025 -device virtio-net-pci,netdev=n0 \
  -device virtio-rng-pci -display none -serial file:"$W/console.log" -monitor none -daemonize -pidfile "$W/qemu.pid"
[ -n "${KEEP:-}" ] || trap 'kill $(cat "$W/qemu.pid") 2>/dev/null' EXIT    # KEEP=1: leave the VM up afterwards
T0=$(date +%s)
until ssh-keyscan -p $PORT -T 5 localhost 2>/dev/null | grep -q ssh-ed25519; do
  sleep 15
  [ $(( $(date +%s) - T0 )) -gt 1800 ] && { echo "!! no SSH after 30 min -- see $W/console.log"; exit 1; }
done
echo "   SSH up after $(( $(date +%s) - T0 )) s"
sleep 30

echo "-- first login: kelly / kellypage must force a password change"
cat > "$W/first.exp" <<EOF
set timeout 120
spawn ssh -p $PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no kelly@localhost
expect "password:"; send "kellypage\r"
expect {
  -re "(?i)(must change|expired)" { puts "\nFORCED-CHANGE-SEEN" }
  timeout { puts "\nNO-FORCED-CHANGE"; exit 1 }
}
expect -re "(?i)current.*password:"; send "kellypage\r"
expect -re "(?i)new password:"; send "$NEWPASS\r"
expect -re "(?i)retype.*password:"; send "$NEWPASS\r"
expect eof
EOF
expect "$W/first.exp" > "$W/first.log" 2>&1
grep -q FORCED-CHANGE-SEEN "$W/first.log" && echo "   PASS forced password change" || { echo "   FAIL forced password change"; cat "$W/first.log"; }

for pw in kellypage wrong-password; do
  if sshpass -p "$pw" ssh -p $PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
       -o ConnectTimeout=20 kelly@localhost true 2>/dev/null; then echo "   FAIL password '$pw' still logs in"
  else echo "   PASS password '$pw' refused"; fi
done
echo "-- checks over SSH with the new password"
SSH="sshpass -p $NEWPASS ssh -p $PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no kelly@localhost"
echo "$NEWPASS" > "$W/newpass"
# let the first boot finish (cloud-init, then Kelly's units) before judging it
$SSH 'for i in $(seq 60); do s=$(systemctl is-system-running); [ "$s" = starting ] || break; sleep 10; done
  echo "   boot: $s after $(cut -d. -f1 /proc/uptime) s; jobs left: $(systemctl list-jobs --no-legend | wc -l)"' 2>/dev/null
$SSH 'echo "   hostname: $(hostname)"
  echo "   kelly-bridge: $(systemctl is-active kelly-bridge) (restarts $(systemctl show -p NRestarts --value kelly-bridge))"
  echo "   page on :8025: HTTP $(curl -s -o /dev/null -w %{http_code} http://localhost:8025/)"
  echo "   root fs: $(df -h / | awk "NR==2{print \$2}") (disk 4 GB)"
  echo "   host keys made: $(stat -c %y /etc/ssh/ssh_host_ed25519_key.pub | cut -c1-19), booted $(uptime -s)"
  echo "   machine-id: $(cut -c1-8 /etc/machine-id)..."
  echo "   sudo: $(sudo -n true 2>/dev/null && echo "NO password needed (bad)" || echo "asks for the password (good)")"
  echo "   swap: $(awk "NR>1{print \$1, \$3 \" kB\"}" /proc/swaps | paste -sd" ")"
  echo "   groups kellypage: $(id -nG kellypage)"
  echo "   auto-update timer: $(systemctl is-enabled kellypage-autoupdate.timer) / $(systemctl is-active kellypage-autoupdate.timer)"
  echo "   failed units: $(systemctl --failed --no-legend | awk "{print \$2}" | paste -sd" ")"
  echo "   firstboot: $(systemctl is-active kellypage-firstboot) / $(ls /var/lib/kellypage 2>/dev/null | paste -sd" ")"' 2>/dev/null
echo "   page from outside (port-forwarded): HTTP $(curl -s -o /dev/null -w %{http_code} http://localhost:$WEB/)"
echo "   page title: $(curl -s http://localhost:$WEB/ | grep -o '<title>[^<]*' | head -1 | cut -c8-)"
echo "   motd:"; $SSH 'run-parts /etc/update-motd.d 2>/dev/null | tail -8' 2>/dev/null | sed 's/token=[a-z0-9]*/token=<set>/; s/^/     /'
echo "-- done (shipped image $(( SHIPPED / 1048576 )) MB; console log $W/console.log)"
