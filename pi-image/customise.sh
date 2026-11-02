#!/bin/bash
# Runs INSIDE the image (chroot, qemu-aarch64) from build-image.sh -- never on a real machine.
# /tmp/kp/kelly.zip = the Kelly Page release; rootfs/ has already been copied over /.
# Prints "REMOVED <pkg>" / "ADDED <pkg>" lines for the build report.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8
log() { echo "[customise] $*"; }
dpkg-query -W -f='${Package}\n' | sort > /tmp/kp/pkgs-before

log "packages: Kelly's (pyserial, bleak, cryptography for the device key, BlueZ)"
apt-get update -q
apt-get install -y -q --no-install-recommends python3-serial python3-bleak python3-cryptography bluez rfkill avahi-daemon

log "packages: purging what a headless Kelly box never uses"
# compilers / debugger / kernel headers (nothing is built on the Pi), MKV tools, Raspberry Pi Connect, the sq OpenPGP CLI
# (apt verifies with sqv, kept), man-db, and Wi-Fi firmware for PCIe / USB chips no Pi has on board
# (Atheros ath10k-12k, MediaTek, Marvell Libertas). Kept: brcm80211 + cypress (the Pi's own Wi-Fi),
# realtek (USB Ethernet adapters and USB Bluetooth dongles), bluez-firmware.
WANT="build-essential gcc g++ cpp gcc-14 g++-14 cpp-14 gcc-14-aarch64-linux-gnu g++-14-aarch64-linux-gnu cpp-14-aarch64-linux-gnu
      gdb mkvtoolnix rpi-connect-lite sq man-db manpages manpages-dev dkms
      firmware-atheros firmware-mediatek firmware-libertas"
WANT="$WANT $(dpkg-query -W -f='${Package}\n' 'linux-headers-*' 2>/dev/null | tr '\n' ' ')"
PURGE=""
for p in $WANT; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "ok installed" && PURGE="$PURGE $p"; done
apt-get purge -y -q $PURGE
apt-get autoremove --purge -y -q

log "user: pi -> kelly (password kellypage, must be changed at first login; sudo asks for it)"
if id pi >/dev/null 2>&1; then
  usermod -l kelly -c "Kelly Page" -s /bin/bash pi
  groupmod -n kelly pi
fi
usermod -d /home/kelly kelly
if [ -d /home/pi ]; then mv /home/pi /home/kelly; fi
if [ ! -d /home/kelly ]; then cp -rT /etc/skel /home/kelly; fi
chown -R kelly:kelly /home/kelly
for g in adm dialout cdrom audio users sudo video plugdev input gpio spi i2c netdev render bluetooth; do
  getent group "$g" >/dev/null && usermod -aG "$g" kelly
done
echo 'kelly:kellypage' | chpasswd
chage -d 0 kelly
rm -f /etc/sudoers.d/010_pi-nopasswd
# cloud-init's default user is now kelly, unlocked, and sudo with a password (it re-applies these on first boot)
sed -i -e '/default_user:/,/shell:/{s/name: pi$/name: kelly/;s/lock_passwd: True/lock_passwd: False/;s/gecos: .*/gecos: Kelly Page/;s/sudo: .*/sudo: ["ALL=(ALL) ALL"]/}' /etc/cloud/cloud.cfg
grep -A6 'default_user:' /etc/cloud/cloud.cfg | grep -q 'name: kelly' || { echo "cloud.cfg default_user edit failed"; exit 1; }
# no console "rename the user" wizard, no "user not set up" SSH banner: kelly is ready. Masked, not disabled:
# cloud-init.target pulls it in too, and headless it would wait on tty8 forever, holding up cloud-final and Kelly.
systemctl mask userconfig.service
rm -f /etc/ssh/sshd_config.d/rename_user.conf

log "Kelly Page -> /opt/kelly-page, service user kellypage"
rm -rf /tmp/kp/x /opt/kelly-page
python3 -m zipfile -e /tmp/kp/kelly.zip /tmp/kp/x
mv "/tmp/kp/x/Kelly Page" /opt/kelly-page
chown -R root:root /opt/kelly-page
id kellypage >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/kellypage --create-home \
  --shell /usr/sbin/nologin --comment "Kelly Page bridge" kellypage
usermod -aG dialout,bluetooth kellypage
chmod 0750 /var/lib/kellypage
getent shadow kelly | cut -d: -f2 > /var/lib/kellypage/shipped-hash
chmod 0600 /var/lib/kellypage/shipped-hash
chown root:kellypage /etc/kelly-bridge.env
chmod 0640 /etc/kelly-bridge.env
chmod 0755 /usr/local/bin/kellypage-* /usr/local/sbin/kellypage-* /usr/local/lib/kellypage/* /etc/update-motd.d/60-kellypage
# signed automatic updates (off until the owner says yes in kellypage-setup). The updater only needs python3-cryptography
# (installed above). release-keys.json pins the release public key(s): keep the file root-owned, read-only.
chown root:root /etc/kellypage /etc/kellypage/release-keys.json /etc/kellypage/autoupdate.conf
chmod 0755 /etc/kellypage
chmod 0644 /etc/kellypage/release-keys.json /etc/kellypage/autoupdate.conf
grep -q '^ENABLED=0$' /etc/kellypage/autoupdate.conf || { echo "autoupdate.conf must ship ENABLED=0"; exit 1; }
grep -q '"rel-2026a"' /etc/kellypage/release-keys.json || { echo "release-keys.json is missing rel-2026a"; exit 1; }
python3 -c "import sys; sys.path.insert(0,'/usr/local/lib/kellypage'); import kpu1; kpu1.load_keys('/etc/kellypage/release-keys.json')"
find /usr/local -name __pycache__ -prune -exec rm -rf {} +

log "system: hostname kellypage, en_AU / en_US, SSH + services on"
echo kellypage > /etc/hostname
sed -i 's/\braspberrypi\b/kellypage/g' /etc/hosts
grep -q kellypage /etc/hosts || echo "127.0.1.1	kellypage" >> /etc/hosts
sed -i -e 's/^\([a-z]\)/# \1/' -e 's/^# *\(en_AU.UTF-8 UTF-8\)/\1/' -e 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen
locale-gen
update-locale LANG=en_AU.UTF-8
systemctl enable ssh.service avahi-daemon.service bluetooth.service kelly-bridge.service kellypage-firstboot.service kellypage-autoupdate.timer

log "slimming: docs, man pages, translations, caches"
find /usr/share/doc -mindepth 1 ! -name copyright ! -type d -delete
find /usr/share/doc -mindepth 1 -type d -empty -delete
rm -rf /usr/share/man/* /usr/share/info/* /usr/share/lintian/*
find /usr/share/locale -mindepth 1 -maxdepth 1 ! -name 'en' ! -name 'en_AU' ! -name 'en_US' ! -name locale.alias -exec rm -rf {} +
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/*.bin /var/cache/debconf/*-old /var/lib/dpkg/*-old
rm -rf /root/.cache /root/.bash_history /home/kelly/.bash_history /home/kelly/.cache /var/lib/kellypage/.cache
find /usr -name __pycache__ -path '*/kelly-page/*' -prune -exec rm -rf {} +

dpkg-query -W -f='${Package}\n' | sort > /tmp/kp/pkgs-after
comm -23 /tmp/kp/pkgs-before /tmp/kp/pkgs-after | sed 's/^/REMOVED /'
comm -13 /tmp/kp/pkgs-before /tmp/kp/pkgs-after | sed 's/^/ADDED /'
log "done"
