#!/usr/bin/env bash
# Build the Mesh Buddy firmware (RAK4631) on a Linux box with PlatformIO (defaults: ~/pio-venv, ~/mprs-tracker).
#   bash build.sh [meshcore-dir]                          the public build (Kelly Page ships this one)
#   MPRS_ADMIN_PASS=... bash build.sh [meshcore-dir]      a private build with that admin password compiled in
# The public build has MeshCore's default admin password ("password"); Kelly Page's Mesh Buddy tab replaces it with a
# random one the moment it configures the tracker. A password never comes from this repo (.env RAK_BIKE_ADMIN_PASS).
# Output: <meshcore-dir>/.pio/build/RAK_4631_mesh_buddy/firmware.zip (adafruit-nrfutil DFU package) + firmware.uf2
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MC="${1:-$HOME/mprs-tracker/MeshCore-companion-v1.18.0}"
PIO="${PIO:-$HOME/pio-venv/bin/pio}"

mkdir -p "$MC/examples/mesh_buddy"
cp "$HERE/main.cpp" "$MC/examples/mesh_buddy/main.cpp"
# 1.2's GPS quality gate reads PDOP / HDOP / accuracy straight from MeshCore's RAK12500 driver object: drop the `static`
# on it and on its "found on I2C" flag (idempotent; only linkage changes, MeshCore's own code is untouched otherwise)
ESM="$MC/src/helpers/sensors/EnvironmentSensorManager.cpp"
sed -i -e 's/^static SFE_UBLOX_GNSS ublox_GNSS;/SFE_UBLOX_GNSS ublox_GNSS;/' -e 's/^static bool i2cGPSFlag = false;/bool i2cGPSFlag = false;/' "$ESM"
grep -q '^SFE_UBLOX_GNSS ublox_GNSS;' "$ESM" && grep -q '^bool i2cGPSFlag = false;' "$ESM" || { echo "EnvironmentSensorManager.cpp patch failed"; exit 1; }
INI="$MC/variants/rak4631/platformio.ini"
# the env block is rewritten on every build (between its two marker lines), so a password from one build never sticks
sed -i '/^; >>> mesh buddy/,/^; <<< mesh buddy/d' "$INI"
PASS_FLAG=""
if [ -n "${MPRS_ADMIN_PASS:-}" ]; then PASS_FLAG="  -D ADMIN_PASSWORD='\"\${sysenv.MPRS_ADMIN_PASS}\"'"; fi
cat >> "$INI" <<EOF
; >>> mesh buddy (P25X repo tools/mesh-buddy): the sensor firmware with examples/mesh_buddy/main.cpp
[env:RAK_4631_mesh_buddy]
extends = rak4631
build_flags =
  \${rak4631.build_flags}
  -I examples/simple_sensor
  -D ADVERT_NAME='"Mesh Buddy"'
  -D ADVERT_LAT=0.0
  -D ADVERT_LON=0.0
  -D LORA_FREQ=923.125
  -D LORA_BW=62.5
  -D LORA_SF=8
  -D LORA_CR=5
  -D ENABLE_ADVERT_ON_BOOT=1
$PASS_FLAG
build_src_filter = \${rak4631.build_src_filter}
  +<../examples/simple_sensor>
  -<../examples/simple_sensor/main.cpp>
  -<../examples/simple_sensor/UITask.cpp>
  +<../examples/mesh_buddy>
; <<< mesh buddy
EOF
cd "$MC"
"$PIO" run -e RAK_4631_mesh_buddy
ls -la .pio/build/RAK_4631_mesh_buddy/ | grep -E 'firmware\.(zip|uf2|hex)'
