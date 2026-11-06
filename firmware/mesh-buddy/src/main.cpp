/* Mesh Buddy -- a MeshPRS tracker: a RAK4631 + WisBlock GNSS (RAK12500 on I2C or RAK1910 on UART, found at boot) that sends MeshPRS
 * Position frames (MeshPRS/spec/MeshPRS-Spec.md, 1.0 Candidate, wire version 1) on #meshprs. Built on MeshCore
 * companion-v1.18.0's own sensor firmware (examples/simple_sensor: never repeats other stations, USB + remote admin CLI,
 * GPS, advert with the live position) -- this file replaces only its main.cpp and adds the beacon. Build: build.sh.
 *
 * Frame (spec §5.1, §9.3): hdr 0x50 (version 1, K set, gating 0) | subtype 0 | seq | source base-40 BE 6 | node key
 * prefix 4 | lat i24 LE | lon i24 LE | symbol 2 | pflags (ALT; CSE only when moving >= 5 km/h) | alt i16 | course u8 |
 * speed u8 | comment (every 10th beacon only, so N stays <= 29 the rest of the time). GRP_DATA, data type 0xFF4D,
 * channel #meshprs (key sha256("#meshprs")[0:16], hash 0xBA). Unscoped flood with 2-byte path hashes, or zero-hop.
 *
 * Beacon timing: `every` > 0 = a fixed interval (testing); `every` 0 = smart beaconing (spec §5.5: moved > move_m,
 * heading changed > turn_deg at >= 5 km/h, or max_s since the last one; never sooner than min_s). Nothing is ever
 * sent more often than every 30 s (the spec floor) and nothing without a GOOD GPS fix (below).
 *
 * GPS quality gate (1.2; the 2026-10-31 rides put a test tracker kilometres off when the sky view was poor): a position is
 * used -- for a beacon, for smart-beaconing distance/course, and in MeshCore's own advert -- only when there are >= sats
 * satellites and, on a u-blox (RAK12500), the fix is 3D with PDOP <= pdop, HDOP <= hdop and the receiver's own
 * horizontal accuracy estimate <= hacc metres; no sample-to-sample jump faster than 250 km/h; height changing no faster
 * than climb m/s (default 2.0) over the last >= 30 s (1.3: a bike can't, a drifting fix does); and that has held for 3
 * samples in a row (6 s). Otherwise positions are held: nothing is beaconed and the advert carries the last good
 * position (for up to 10 min, then none). Telemetry and status still go out (Fix bit = a good fix, A4 = raw sats).
 *   mprs gps              the live DOP / accuracy and whether it passes   mprs pdop|hdop <x>  mprs hacc <m>  mprs sats <n>
 *   mprs climb <m/s>      the climb limit (default 2.0; raise it, or "off", for a car in the mountains or an aircraft)
 *                         (0 = back to the default, "off" = that check off)
 *
 * USB serial / remote admin CLI, on top of MeshCore's own ("get name", "gps", "set freq" ...):
 *   mprs                  status          mprs on | off            mprs now           (one beacon now, if there's a fix)
 *   mprs call VK4XXX-12    mprs sym /b     mprs comment <text>      mprs every <s>     (0 = smart)
 *   mprs route zerohop | flood            mprs min <s>  mprs max <s>  mprs move <m>  mprs turn <deg>
 *   mprs status <text>    (spec §8.4 plain status, APRS ">text"; empty = none)   mprs statusmin <min>   mprs statusnow
 *   mprs tlm              telemetry now-values    mprs tlm on | off | now | defs | wait | nowait
 *   (1.6: parked, routine telemetry waits for a position that drew an echo and goes right after it; 3 h at most)
 * Status: once after the first position, then every statusmin (default 720 = 12 h, never under 360 -- spec §8.4: an
 *   unchanged status is sent rarely). A NEW status (after boot, a changed text, statusnow) is sent again 75 s later as a
 *   retry (spec §8.4: 60-90 s, header retry field 1, same seq); a routine repeat isn't. Smart beaconing min 120 s, the spec §5.5 default; a mobile in
 *   patchy coverage MAY use 60 s (decision 0027). Defaults: comment "MeshCore kellypage.app", status "Hop count" (sent with H: the iGate adds the hops, ">Hop count 2").
 * Position retry (1.3, spec §5.7, decision 0030): a position whose 20 s echo window closes with no repeater echo is sent
 *   once more, same bytes and seq, retry field 1, 20-30 s later -- flood only, 5 s gap, skipped if a newer position went or
 *   the next beacon may be due within 10 s. Other frames wait while a position's echo window is open.   mprs retry on|off
 * Track history (1.3, spec §5.8, subtype 0x0A): positions missed first time AND on retry (up to 8, none over 30 min) are
 *   sent in one frame once a later frame is echoed (back in coverage): per entry age (s, our own millis), lat, lon, alt.
 *   The iGate gates each as a timestamped APRS position.   mprs hist on|off   ("mprs retry" / "mprs hist" = counters)
 * Watchdog (1.3): the nRF52 WDT, 60 s, fed from loop(); the boot log and the "mprs gps" / "mprs tlm" replies say
 *   RST=WATCHDOG when it caused the last reset.
 * Definitions (1.7): the four go 60 s apart (decision 0033's burst limit), at boot and every 12 h.
 * Telemetry (spec §7, decision 0027's layout, A2 per 0031 -- see sendTlm): battery, hops to the iGate (filled in there), echo % (a repeater
 *   re-sending our own flooded frame, caught in logRx before the duplicate check), satellites, MCU temperature, 8 state
 *   bits. Values every 30 min moving / 60 min parked (+ on a LowBt / Hot change); definitions at boot and every 12 h.
 */
#include "SensorMesh.h"
#include <math.h>
#include <stddef.h>

#ifdef DISPLAY_CLASS
  #include "UITask.h"
  static UITask ui_task(display);
#endif

#if ENV_INCLUDE_GPS && defined(RAK_BOARD) && !defined(RAK_WISMESH_TAG)   // = EnvironmentSensorManager.cpp's own test
  #define RAK_WISBLOCK_GPS
  // MeshCore's RAK12500 driver object and its "found on I2C" flag (EnvironmentSensorManager.cpp; build.sh drops their
  // `static` so the DOP / accuracy can be read here -- the driver itself only exposes lat/lon/alt/sats)
  #include <SparkFun_u-blox_GNSS_Arduino_Library.h>
  extern SFE_UBLOX_GNSS ublox_GNSS;
  extern bool i2cGPSFlag;
#endif

#define MESH_BUDDY_VERSION "1.7"

// Defaults for a NEW install (a saved /mprs config wins). No callsign: a Mesh Buddy sends nothing until its owner sets
// one (Kelly Page's Mesh Buddy tab does it from the station's own callsign), so a public build carries nobody's identity.
#ifndef MPRS_CALL
  #define MPRS_CALL  ""
#endif
#ifndef MPRS_EVERY
  #define MPRS_EVERY 0           // smart beaconing (spec §5.5); "mprs every 30" = a fixed 30 s for bench tests
#endif
#ifndef MPRS_FLOOD
  #define MPRS_FLOOD 1           // flooded, so repeaters carry it (and the echo check works); "mprs route zerohop" for tests
#endif

#ifndef MPRS_COMMENT
  #define MPRS_COMMENT "MeshCore kellypage.app"   // 22 of 23; fits the 27 a moving position leaves for the comment
#endif
#ifndef MPRS_STATUS
  #define MPRS_STATUS  "Hop count"    // each iGate adds the hops it heard it over: ">Hop count 2" (decision 0031)
#endif

#define MPRS_DATA_TYPE   0xFF4D
#define MPRS_FLOOR_S     30
#define MPRS_STATUS_RETRY_MS 75000UL   // spec §8.4: one status retry 60-90 s later
#define MPRS_GAP_MS      5000UL        // at least this long between any two of our frames
// 1.7: the four telemetry definitions go 60 s apart, not back to back (MeshPRS decision 0033: a burst of at most 3
// floods; 1.6 sent 4 definitions + a value frame 6 s apart at every power-on). Other frames may go in between.
#define MPRS_DEFS_GAP_MS 60000UL
#define MPRS_MAX_BLOB    100
#define MPRS_TLM_START_MS 60000UL      // telemetry starts a minute after boot
#define MPRS_TLM_MOVE_MIN 30            // slow on purpose: every flooded frame is re-sent by each repeater that hears it
#define MPRS_TLM_PARK_MIN 60
// 1.6: parked, a routine telemetry frame waits for a position (or its retry) that drew an echo -- sent right after it, on
// a link just shown to work. 2026-11-06 parked indoors at work: 0 of ~9 hourly telemetry frames arrived (no retry), while
// 4 positions did by their retry. If no echo comes, it goes anyway this long after it was due. LowBt / Hot never wait.
#define MPRS_TLM_LINK_MS  90000UL       // "just": an echo this recent
#define MPRS_TLM_WAIT_MS  (3UL * 3600000UL)
#define MPRS_DEFS_MS     (12UL * 3600000UL)  // definitions at boot, then every 12 h (spec §7.3: at most every 6 h)
#define MPRS_STATUS_MIN_MIN 360            // an unchanged status no more often than every 6 h (spec §8.4)
#define MPRS_ECHO_WAIT_MS 20000UL      // listen this long for repeaters re-sending a beacon
#define MPRS_CFG_FILE    "/mprs"
#define MPRS_CFG_MAGIC   0x4D505232   // 'MPR2' (v2 added the status; an older saved config is replaced by the defaults)
#define MPRS_CFG_V2_SIZE 120          // a 1.0/1.1 config: everything up to status_min (the GPS limits came in 1.2)
#define GPS_PDOP_DEF     50           // x0.1: PDOP <= 5.0
#define GPS_HDOP_DEF     30           // x0.1: HDOP <= 3.0
#define GPS_HACC_DEF     50           // metres
#define GPS_SATS_DEF     5
#define GPS_SETTLE       3            // good samples in a row (2 s apart) before a fix is used
#define GPS_JUMP_MS      70.0         // m/s between two samples (250 km/h) = a bad fix
#define GPS_CLIMB_DEF    20           // x0.1 m/s: height changing faster than 2.0 m/s over >= 30 s = a bad fix
#define GPS_CLIMB_WIN_MS 30000UL      // the climb check looks back at least this far (one sample every 2 s)
#define GPS_ADVERT_KEEP_MS 600000UL   // the advert keeps the last good position this long
#define MPRS_RETRY_MIN_MS 20000UL     // spec §5.7: a position with no echo in 20 s is retried 20-30 s later (40-50 s after it)
#define MPRS_RETRY_SPAN_MS 10000UL
#define MPRS_RETRY_SKIP_MS 10000UL    // ...unless the next beacon may be due within 10 s
#define MPRS_HIST_MAX    8            // spec §5.8: positions kept for the track history
#define MPRS_HIST_AGE_MS 1800000UL    // ...none older than 30 min when it is sent
#define MB_WDT_S         60           // hardware watchdog: a loop() that stops for this long reboots the tracker
static const uint8_t MPRS_KEY[16] = { 0x65, 0x0f, 0xa1, 0xfd, 0x5d, 0x2c, 0x0b, 0xc0, 0x14, 0x49, 0xa9, 0x64, 0xa1, 0x30, 0xea, 0x1c };
static const char ALPHA40[] = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.";

struct MprsCfg {
  uint32_t magic;
  uint8_t on, flood, turn_deg, notlm;   // notlm: was padding, so an older saved config has telemetry on
  uint16_t every_s, min_s, max_s, move_m;
  char call[10], sym[3], comment[24];
  char status[63];       // spec §8.4 plain status (code 8), 0-62 characters; empty = none
  uint16_t status_min;   // how often it is sent, minutes
  // 1.2: GPS quality limits. 0 = the default (an older config's padding / unread bytes are 0), 255 / 65535 = check off
  uint8_t pdop10, hdop10, min_sats;
  uint8_t climb10;       // 1.3 (was padding, so an older config has 0 = the default): x0.1 m/s, 255 = check off
  uint16_t hacc_m;
  // 1.3: appended (no spare byte was left above). An older, shorter saved config leaves these 0 = on, as notlm does
  uint8_t noretry, nohist;   // spec §5.7 position retry / §5.8 track history switched off
  uint8_t notlmwait;         // 1.6, appended: 1 = parked telemetry doesn't wait for a position echo (older config: 0 = waits)
};
static_assert(offsetof(MprsCfg, pdop10) == MPRS_CFG_V2_SIZE - 2, "1.1 config layout moved");
static_assert(offsetof(MprsCfg, noretry) == 124, "1.2 config layout moved (1.3 fields must follow hacc_m)");

// -- hardware watchdog and reset reason (1.3) ----------------------------------------------------------------------------
// 2026-11-04 19:09 the tracker went silent after a bad GPS climb until it was re-plugged (a hang, maybe the u-blox on I2C).
// The nRF52840 WDT, fed at the top of every loop(), reboots it after MB_WDT_S without a feed. MeshCore companion-v1.18.0
// starts no WDT of its own for the RAK4631 (only HAS_EXTERNAL_WATCHDOG boards, and the RAK4631 isn't one). Once started
// the WDT can't be stopped and it survives a soft reset -- including the 1200-baud touch into the Adafruit bootloader for
// serial DFU -- but that bootloader feeds every enabled reload register in its DFU loop (Adafruit_nRF52_Bootloader,
// bootloader.c, "feed wdt in bootloader if enabled", 2018-11-19), so DFU is safe. A watchdog reset stops the WDT, so an
// older firmware flashed over this one at worst reboots once, ~60 s after start, and then runs without it.
// CONFIG: SLEEP = run (it counts while the CPU idles: a hang in a wait still trips it); HALT = pause (a debugger can stop).
#ifdef NRF52_PLATFORM
  #include <nrf_soc.h>
  #include <nrf_sdm.h>
  static uint32_t mb_resetreas = 0;
  // read before anything clears it (MeshCore's own early capture uses the same priority; neither clears it here)
  static void __attribute__((constructor(101))) mb_capture_reset() { mb_resetreas = NRF_POWER->RESETREAS; }
  static bool mbWatchdogReset() { return (mb_resetreas & POWER_RESETREAS_DOG_Msk) != 0; }
  static const char* mbResetName() {
    uint32_t r = mb_resetreas;
    if (r & POWER_RESETREAS_DOG_Msk) return "WATCHDOG";
    if (r & POWER_RESETREAS_LOCKUP_Msk) return "CPU lockup";
    if (r & POWER_RESETREAS_SREQ_Msk) return "soft reset (reboot / DFU)";
    if (r & POWER_RESETREAS_RESETPIN_Msk) return "reset pin";
    if (r & POWER_RESETREAS_OFF_Msk) return "wake from power off";
  #ifdef POWER_RESETREAS_VBUS_Msk
    if (r & POWER_RESETREAS_VBUS_Msk) return "wake on USB power";
  #endif
    return "power on";
  }
  static void mbClearResetReason() {   // RESETREAS keeps its bits until cleared: clear them so the next boot's reason is its own
    uint8_t sd = 0;
    sd_softdevice_is_enabled(&sd);
    if (sd) sd_power_reset_reason_clr(0xFFFFFFFF); else NRF_POWER->RESETREAS = 0xFFFFFFFF;
  }
  static void mbWatchdogStart() {
    if (NRF_WDT->RUNSTATUS & 1) { Serial.println("Watchdog: already running (kept through a soft reset), feeding it"); return; }
    NRF_WDT->CONFIG = 1;                               // bit 0 SLEEP = 1 run while asleep; bit 3 HALT = 0 pause under a debugger
    NRF_WDT->CRV = (uint32_t)MB_WDT_S * 32768UL - 1;   // timeout = (CRV + 1) / 32768 s
    NRF_WDT->RREN = 1;                                 // reload register RR[0] only
    NRF_WDT->TASKS_START = 1;
    Serial.printf("Watchdog: on, %d s\n", MB_WDT_S);
  }
  static void mbWatchdogFeed() {   // every enabled reload register (one started before a soft reset may have others)
    uint32_t en = NRF_WDT->RREN;
    for (int i = 0; i < 8; i++) if (en & (1UL << i)) NRF_WDT->RR[i] = 0x6E524635UL;   // the reload value
  }
#else
  static bool mbWatchdogReset() { return false; }
  static const char* mbResetName() { return "unknown"; }
  static void mbClearResetReason() { }
  static void mbWatchdogStart() { }
  static void mbWatchdogFeed() { }
#endif

StdRNG fast_rng;
SimpleMeshTables tables;

class MyMesh : public SensorMesh {
public:
  MyMesh(mesh::MainBoard& board, mesh::Radio& radio, mesh::MillisecondClock& ms, mesh::RNG& rng, mesh::RTCClock& rtc, mesh::MeshTables& tables)
     : SensorMesh(board, radio, ms, rng, rtc, tables) {
    // defaults for a NEW install (a saved /prefs.json wins): the SEQ MeshCore network (MBUG), GPS on, live position in adverts
    getNodePrefs()->freq = 923.125f; getNodePrefs()->bw = 62.5f; getNodePrefs()->sf = 8; getNodePrefs()->cr = 5;
    getNodePrefs()->path_hash_mode = 1;            // 2-byte path hashes, as SEQ uses
    getNodePrefs()->gps_enabled = 1;
    getNodePrefs()->advert_loc_policy = ADVERT_LOC_SHARE;
    getNodePrefs()->advert_interval = 30;          // a zero-hop advert every 60 min (the firmware's minimum), plus one at boot
    getNodePrefs()->flood_advert_interval = 0;
  }

  void beginTracker(FILESYSTEM* fs) {
    fs_ = fs;
    memset(&cfg, 0, sizeof(cfg));
    bool ok = false;
    if (fs_->exists(MPRS_CFG_FILE)) {
      File f = fs_->open(MPRS_CFG_FILE);
      // a 1.1 config is shorter (no GPS limits): its missing bytes stay 0 = the defaults
      if (f) { int got = f.read((uint8_t*)&cfg, sizeof(cfg)); ok = got >= MPRS_CFG_V2_SIZE && cfg.magic == MPRS_CFG_MAGIC; f.close(); }
    }
    if (!ok) {
      memset(&cfg, 0, sizeof(cfg));
      cfg.magic = MPRS_CFG_MAGIC; cfg.on = 1; cfg.flood = MPRS_FLOOD; cfg.every_s = MPRS_EVERY;
      cfg.min_s = 120; cfg.max_s = 1800; cfg.move_m = 500; cfg.turn_deg = 15;   // spec §5.5 defaults (500 m: decision 0034)
      strcpy(cfg.call, MPRS_CALL); strcpy(cfg.sym, "/b");   // APRS "/b" = bicycle
      strcpy(cfg.comment, MPRS_COMMENT);
      strcpy(cfg.status, MPRS_STATUS); cfg.status_min = 720;
    }
    if (cfg.status_min < MPRS_STATUS_MIN_MIN) cfg.status_min = 720;   // a config saved by 1.0 had 30 min
    channel.hash[0] = 0;
    memset(channel.secret, 0, sizeof(channel.secret));
    memcpy(channel.secret, MPRS_KEY, 16);
    mesh::Utils::sha256(channel.hash, PATH_HASH_SIZE, channel.secret, 16);   // = 0xBA
    // spec §9.3: a sender that can't keep its counter across reboots MUST start at a random value
    uint8_t r; fast_rng.random(&r, 1); seq = r;
    Serial.printf("Mesh Buddy " MESH_BUDDY_VERSION ": %s %s, channel #meshprs hash %02X, %s\n", cfg.call[0] ? cfg.call : "(no callsign: sends nothing)",
                  cfg.sym, channel.hash[0], cfg.on ? "on" : "off");
  }

  // -- GPS quality gate ---------------------------------------------------------------------------------------------
  uint8_t limSats() { return cfg.min_sats == 255 ? 0 : cfg.min_sats ? cfg.min_sats : GPS_SATS_DEF; }
  float limPdop() { return cfg.pdop10 == 255 ? 1e9f : (cfg.pdop10 ? cfg.pdop10 : GPS_PDOP_DEF) / 10.0f; }
  float limHdop() { return cfg.hdop10 == 255 ? 1e9f : (cfg.hdop10 ? cfg.hdop10 : GPS_HDOP_DEF) / 10.0f; }
  float limHacc() { return cfg.hacc_m == 65535 ? 1e9f : cfg.hacc_m ? cfg.hacc_m : GPS_HACC_DEF; }
  float limClimb() { return cfg.climb10 == 255 ? 1e9f : (cfg.climb10 ? cfg.climb10 : GPS_CLIMB_DEF) / 10.0f; }

  // read the u-blox's own quality figures for the current fix (RAK12500 only; a RAK1910 has sats + the jump check).
  // PDOP, fix type and hAcc come from the NAV-PVT the driver polls every loop anyway; HDOP needs a NAV-DOP poll.
  void readQuality(bool raw) {
    q_ublox = false;
#ifdef RAK_WISBLOCK_GPS
    if (i2cGPSFlag) {
      q_ublox = true;
      q_type = ublox_GNSS.getFixType(2);
      q_pdop = ublox_GNSS.getPDOP(2) / 100.0f;
      q_hacc = ublox_GNSS.getHorizontalAccEst(2) / 1000.0f;
      if (raw) q_hdop = ublox_GNSS.getHorizontalDOP(50) / 100.0f;
    }
#endif
  }
  // why this sample fails the gate, or NULL if it passes
  const char* poorReason(bool raw, double lat, double lon, uint32_t now) {
    if (!raw) return "no fix";
    if (sats < limSats()) return "few sats";
    if (q_ublox) {
      if (q_type < 3) return "not 3D";
      if (q_pdop > limPdop()) return "PDOP";
      if (q_hdop > limHdop()) return "HDOP";
      if (q_hacc > limHacc()) return "accuracy";
    }
    if (prev_raw_at && now - prev_raw_at < 10000 && dist_m(prev_raw_lat, prev_raw_lon, lat, lon) / ((now - prev_raw_at) / 1000.0) > GPS_JUMP_MS)
      return "jump";
    if (climbRate(now) > limClimb()) return "climb";   // 2026-11-04 19:00: +1150 m in 9 min at 30 km/h, gated as good
    return NULL;
  }
  // height change rate (m/s) between now and the oldest kept raw sample at least GPS_CLIMB_WIN_MS old; 0 if none yet
  float climbRate(uint32_t now) {
    if (!alt_n) return 0;
    for (int i = 0; i < alt_n; i++) {
      int k = (alt_head - alt_n + i + ALT_RING) % ALT_RING;   // oldest first
      uint32_t dt = now - alt_ring_at[k];
      if (dt >= GPS_CLIMB_WIN_MS && dt < GPS_CLIMB_WIN_MS + 20000UL) return fabs(raw_alt - alt_ring[k]) / (dt / 1000.0f);
    }
    return 0;
  }
  void keepAlt(uint32_t now) {   // one raw height per sample; a gap in the fix starts the window again
    if (alt_n && now - alt_ring_at[(alt_head + ALT_RING - 1) % ALT_RING] > 10000UL) alt_n = 0;
    alt_ring[alt_head] = raw_alt; alt_ring_at[alt_head] = now;
    alt_head = (alt_head + 1) % ALT_RING; if (alt_n < ALT_RING) alt_n++;
  }
  // MeshCore's advert (and its LPP GPS reading) take sensors.node_lat/lon, which the driver refreshes from every fix,
  // good or bad: put the last GOOD position back after each sensors.loop() (loop() runs this before the mesh's next pass)
  void publishGood() {
    bool keep = good_at && millis() - good_at < GPS_ADVERT_KEEP_MS;
    sensors.node_lat = keep ? good_lat : 0; sensors.node_lon = keep ? good_lon : 0; sensors.node_altitude = keep ? good_alt : 0;
  }

  // called from loop(): sample the GPS every 2 s (quality gate, speed / course), and beacon when it's due
  void trackerLoop() {
    publishGood();
    if ((long)(millis() - next_sample) < 0) return;
    next_sample = millis() + 2000;
    uint32_t now = millis();
    LocationProvider* loc = sensors.getLocationProvider();
    bool raw = loc && sensors.isGPSDetected() && loc->isValid();
    double lat = raw ? loc->getLatitude() / 1000000.0 : 0, lon = raw ? loc->getLongitude() / 1000000.0 : 0;
    if (lat == 0 && lon == 0) raw = false;
    sats = loc ? loc->satellitesCount() : 0;
    raw_alt = raw ? loc->getAltitude() / 1000.0f : 0;
    readQuality(raw);
    const char* why = poorReason(raw, lat, lon, now);
    if (raw) { prev_raw_lat = lat; prev_raw_lon = lon; prev_raw_at = now; keepAlt(now); }
    good_run = why ? 0 : min(good_run + 1, 255);
    bool was = fix;
    fix = good_run >= GPS_SETTLE;
    if (fix) { good_lat = lat; good_lon = lon; good_alt = loc->getAltitude() / 1000.0; good_at = now; }
    else if (raw) held_s += 2;
    if (why) last_why = why;
    if (fix != was || (!fix && raw && why && strcmp(why, logged_why))) {
      Serial.printf("GPS %s: %s, %d sats, PDOP %.1f HDOP %.1f acc %.0f m%s\n", fix ? "good" : "poor -- positions held", fix ? "ok" : last_why,
                    sats, q_pdop, q_hdop, q_hacc, q_ublox ? "" : " (no u-blox: sats + jump only)");
      logged_why = fix ? "" : last_why;
    }
    publishGood();
    // speed and course over the last >= 10 s of fixes (the GNSS's own heading isn't exposed by the provider)
    if (fix) {
      if (have_ref && now - ref_at >= 10000) {
        double d = dist_m(ref_lat, ref_lon, lat, lon), dt = (now - ref_at) / 1000.0;
        speed_kmh = d / dt * 3.6;
        if (speed_kmh >= 5) course_deg = bearing(ref_lat, ref_lon, lat, lon);
        ref_lat = lat; ref_lon = lon; ref_at = now;
      } else if (!have_ref) { ref_lat = lat; ref_lon = lon; ref_at = now; have_ref = true; }
    }

    if (!cfg.on || !cfg.call[0]) return;   // no callsign yet: nothing goes on air
    closeEcho(now, false);
    // >= 5 s since any of our own frames, and no position (or its retry) still waiting for its echo: another frame would
    // cut its 20 s window short, and a cut-short window says nothing about whether it got through (spec §5.7)
    bool quiet = (!last_tx_at || now - last_tx_at >= MPRS_GAP_MS) && !posWindow();

    // spec §5.7: one retry of a position that drew no echo, 40-50 s after it -- unless a newer one may be due within 10 s
    if (rt_pending && (long)(now - rt_at) >= 0 && quiet) {
      rt_pending = false;
      if (beaconSoon(now)) { Serial.printf("MeshPRS retry of seq %u skipped: the next beacon may be due within 10 s\n", pos_buf[2]); keepMissed(); }
      else {
        pos_buf[0] = (pos_buf[0] & 0xFC) | 1;   // retry field 1; every other byte, seq included, as sent
        if (sendFrame(pos_buf, pos_len, K_RETRY)) { rt_sent++; Serial.printf("MeshPRS position retry seq %u (no echo in 20 s)\n", pos_buf[2]); }
        else keepMissed();
      }
      return;
    }
    // spec §5.8: back in coverage (a frame of ours was echoed): the positions that never got out, in one track history
    if (hist_due && quiet) { hist_due = false; sendHistory(now); return; }

    // telemetry definitions (spec §7.3): a minute after boot, then every 12 h; one frame per tick, 5 s apart
    if (!cfg.notlm && quiet && now >= MPRS_TLM_START_MS) {
      if (!defs_next && (!defs_sent_at || now - defs_sent_at >= MPRS_DEFS_MS)) defs_next = 1;
      if (defs_next && (!def_at || now - def_at >= MPRS_DEFS_GAP_MS)) {
        if (sendTlmDef(defs_next)) { def_at = now; if (++defs_next > 4) { defs_next = 0; defs_sent_at = now; } }
        return;
      }
    }
    // the status: once after the first position, then every status_min, never right on top of another frame. Checked
    // BEFORE the beacon-interval wait below (v2 had it after, so with a 30 s beacon it never went out)
    if (cfg.status[0] && sent_count && quiet
        && (!status_count || now - status_sent_at >= (uint32_t)cfg.status_min * 60000UL)) { sendStatus(!status_count); return; }
    // one retry of the status 75 s later (spec §8.4: 60-90 s, same bytes and seq, retry field 1; losses cluster, so not
    // sooner) -- the gateway collapses both copies to one APRS-IS line (§10.2). The 2026-10-31 ride lost 2 of 4 statuses.
    if (st_len && now - status_sent_at >= MPRS_STATUS_RETRY_MS && quiet) {
      st_buf[0] = (st_buf[0] & 0xFC) | 1;
      if (sendFrame(st_buf, st_len)) Serial.printf("MeshPRS status retry seq %u\n", st_buf[2]);
      st_len = 0; return;
    }
    // telemetry values: every 30 min moving, 60 min parked, and soon after LowBt / Hot changes (spec §7, decision 0027)
    if (!cfg.notlm && quiet && now >= MPRS_TLM_START_MS) {
      bool lb = lowBat(), ht = hot();
      bool alert = (lb != tlm_lowbt || ht != tlm_hot) && now - tlm_sent_at >= 120000UL;
      bool moving = fix && speed_kmh >= 5;
      uint32_t every = (moving ? MPRS_TLM_MOVE_MIN : MPRS_TLM_PARK_MIN) * 60000UL;
      bool due = !tlm_count || alert || now - tlm_sent_at >= every;
      if (due && tlm_count && !alert && !moving && !cfg.notlmwait && cfg.flood) {   // 1.6: parked, wait for a good link
        bool link = link_ok_at && now - link_ok_at <= MPRS_TLM_LINK_MS;
        if (!link && now - tlm_sent_at < every + MPRS_TLM_WAIT_MS) {
          if (!tlm_waiting) { tlm_waiting = true; Serial.println("MeshPRS telemetry due: waiting for a position echo (parked)"); }
          due = false;
        }
      }
      if (due) { tlm_waiting = false; sendTlm(); return; }
    }
    if (!fix || !quiet) return;
    uint32_t since = sent_count ? (now - last_sent_at) / 1000 : 0xFFFFFFFF;
    uint16_t floor_s = cfg.every_s ? max((uint16_t)MPRS_FLOOR_S, cfg.every_s) : max((uint16_t)MPRS_FLOOR_S, cfg.min_s);
    if (since < floor_s) return;
    bool due;
    if (cfg.every_s) due = true;
    else {
      due = !sent_count || since >= cfg.max_s || dist_m(last_lat, last_lon, lat, lon) > cfg.move_m;
      if (!due && speed_kmh >= 5 && last_course >= 0) {
        double dc = fabs(course_deg - last_course); if (dc > 180) dc = 360 - dc;
        due = dc > cfg.turn_deg;
      }
    }
    if (due) beacon(lat, lon);
  }

  bool beacon(double lat, double lon) {
    uint8_t b[64]; int n = 0;
    b[n++] = 0x50;              // version 1, G 0, K 1, gating 0, retry 0
    b[n++] = 0x00;              // Position
    b[n++] = seq;
    if (!call40(cfg.call, &b[n])) { Serial.println("MeshPRS: bad callsign"); return false; }
    n += 6;
    memcpy(&b[n], self_id.pub_key, 4); n += 4;
    put24(b, n, deg_raw(lat, 90)); put24(b, n, deg_raw(lon, 180));
    b[n++] = cfg.sym[0]; b[n++] = cfg.sym[1];
    bool moving = speed_kmh >= 5;
    b[n++] = 0x01 | (moving ? 0x02 : 0);           // ALT always; CSE only when moving
    int alt = (int)lround(sensors.node_altitude);
    alt = max(-32768, min(32767, alt));
    b[n++] = alt & 0xFF; b[n++] = (alt >> 8) & 0xFF;
    if (moving) { b[n++] = (uint8_t)((int)lround(course_deg * 256.0 / 360.0) & 0xFF); b[n++] = (uint8_t)min(255L, lround(speed_kmh)); }
    if (cfg.comment[0] && sent_count % 10 == 0) { int l = strlen(cfg.comment); memcpy(&b[n], cfg.comment, l); n += l; }   // every 10th (spec §5.1)
    if (rt_pending) {   // spec §5.7: a newer position replaces a retry still waiting; the old one goes to the history
      rt_pending = false;
      Serial.printf("MeshPRS retry of seq %u skipped: a newer position goes now\n", pos_buf[2]);
      keepMissed();
    }
    if (!sendFrame(b, n, K_POS)) return false;
    memcpy(pos_buf, b, n); pos_len = n;   // kept for the one retry (spec §5.7) and, if both are missed, the history (§5.8)
    pos_lat = deg_raw(lat, 90); pos_lon = deg_raw(lon, 180); pos_alt = (int16_t)alt; pos_at = millis();
    last_lat = lat; last_lon = lon; last_course = moving ? course_deg : -1; last_sent_at = millis(); sent_count++; last_n = n;
    Serial.printf("MeshPRS #%lu seq %u N=%d %s: %.5f %.5f alt %d m%s, %d sats\n", (unsigned long)sent_count, seq, n, cfg.flood ? "flood" : "zero-hop",
                  lat, lon, alt, moving ? " moving" : "", sats);
    seq++;
    return true;
  }

  // spec §8.4: Emergency / Status, code 8 = plain status -> APRS ">text". Header + code + text, no position (N = 14 + text)
  bool sendStatus(bool retry) {   // retry: a new status, so it's sent again 75 s later
    if (!cfg.status[0]) return false;
    uint8_t b[80]; int n = 0;   // 13 + 1 + up to 62 (was 64: a 62-character status overran it)
    b[n++] = 0x50; b[n++] = 0x09; b[n++] = seq;
    if (!call40(cfg.call, &b[n])) return false;
    n += 6;
    memcpy(&b[n], self_id.pub_key, 4); n += 4;
    b[n++] = 0x18;   // code 8 plain status + H (decision 0031): each iGate adds " <hops>" it saw, e.g. ">Hop count 2"
    int l = strlen(cfg.status); memcpy(&b[n], cfg.status, l); n += l;
    if (!sendFrame(b, n)) return false;
    if (retry) { memcpy(st_buf, b, n); st_len = n; }   // kept for the one retry
    status_sent_at = millis(); status_count++;
    Serial.printf("MeshPRS status seq %u N=%d %s: >%s\n", seq, n, cfg.flood ? "flood" : "zero-hop", cfg.status);
    seq++;   // one counter for every subtype (spec §9.3)
    return true;
  }

  // GRP_DATA on #meshprs, data type 0xFF4D; unscoped flood with the node's path hash size, or zero-hop
  bool sendFrame(const uint8_t* b, int n, uint8_t kind = K_OTHER) {
    if (n > MPRS_MAX_BLOB) return false;
    uint8_t data[3 + MPRS_MAX_BLOB];
    data[0] = MPRS_DATA_TYPE & 0xFF; data[1] = MPRS_DATA_TYPE >> 8; data[2] = n;
    memcpy(&data[3], b, n);
    mesh::Packet* pkt = createGroupDatagram(PAYLOAD_TYPE_GRP_DATA, channel, data, 3 + n);
    if (!pkt) { Serial.println("MeshPRS: no packet free"); return false; }
    closeEcho(millis(), true);   // the previous frame's window ends when the next goes out
    pkt->calculatePacketHash(tx_hash);   // payload only, so a repeater's copy (longer path) hashes the same
    if (cfg.flood) sendFlood(pkt, (uint32_t)0, (uint8_t)(getNodePrefs()->path_hash_mode + 1));   // unscoped (spec §12.2)
    else sendZeroHop(pkt);
    last_tx_at = millis();
    // listen for repeaters re-sending this frame (flood only): proof the first hop worked, and its SNR
    if (cfg.flood) { memcpy(bcn_hash, tx_hash, MAX_HASH_SIZE); bcn_at = last_tx_at; bcn_open = true; bcn_echo = false; bcn_snr = -99; bcn_count = 0; bcn_kind = kind; }
    return true;
  }

  // -- position retry (spec §5.7) and track history (spec §5.8, subtype 0x0A) ---------------------------------------
  // a position or its retry is still inside its 20 s echo window
  bool posWindow() { return bcn_open && (bcn_kind == K_POS || bcn_kind == K_RETRY); }
  // the next beacon may be due within 10 s: a moving (or fixed-interval) tracker is due once its minimum interval is up
  bool beaconSoon(uint32_t now) {
    if (!sent_count || !(cfg.every_s || speed_kmh >= 5)) return false;
    uint16_t floor_s = cfg.every_s ? max((uint16_t)MPRS_FLOOR_S, cfg.every_s) : max((uint16_t)MPRS_FLOOR_S, cfg.min_s);
    return (long)(last_sent_at + floor_s * 1000UL - (now + MPRS_RETRY_SKIP_MS)) <= 0;
  }
  // the last position sent (pos_*) got out neither first time nor on retry: keep it for the next track history
  void keepMissed() {
    if (cfg.nohist || !pos_len) return;
    if (hist_n && hist[hist_n - 1].at == pos_at) return;   // already kept
    if (hist_n == MPRS_HIST_MAX) { memmove(&hist[0], &hist[1], sizeof(hist[0]) * (MPRS_HIST_MAX - 1)); hist_n--; }   // oldest out
    hist[hist_n].lat = pos_lat; hist[hist_n].lon = pos_lon; hist[hist_n].alt = pos_alt; hist[hist_n].at = pos_at;
    hist_n++; hist_kept++;
    Serial.printf("MeshPRS seq %u missed (no echo): kept for the track history (%d waiting)\n", pos_buf[2], hist_n);
  }
  // one track history frame: symbol, hflags (ALT), count, then per entry age u16 s, lat i24, lon i24, alt i16 -- oldest
  // first. 8 entries with K = 97 bytes, inside MPRS_MAX_BLOB. Ages are millis() differences: no wall clock needed (0023)
  bool sendHistory(uint32_t now) {
    int k = 0;
    for (int i = 0; i < hist_n; i++) if (now - hist[i].at <= MPRS_HIST_AGE_MS) hist[k++] = hist[i];   // drop > 30 min
    hist_n = k;
    if (!hist_n || cfg.nohist || !cfg.flood) { hist_n = 0; return false; }
    uint8_t b[MPRS_MAX_BLOB]; int n = head(b, 0x0A);
    if (!n) return false;
    b[n++] = cfg.sym[0]; b[n++] = cfg.sym[1];
    b[n++] = 0x01;          // hflags: ALT; no ambiguity; not messaging-capable
    b[n++] = (uint8_t)hist_n;
    uint32_t prev_age = 0xFFFFFFFF;
    for (int i = 0; i < hist_n; i++) {
      uint32_t age = (now - hist[i].at) / 1000;
      if (age >= prev_age) age = prev_age - 1;   // spec: ages strictly falling (positions are >= 30 s apart anyway)
      if (age < 1) age = 1;
      prev_age = age;
      b[n++] = age & 0xFF; b[n++] = (age >> 8) & 0xFF;
      put24(b, n, hist[i].lat); put24(b, n, hist[i].lon);
      b[n++] = hist[i].alt & 0xFF; b[n++] = (hist[i].alt >> 8) & 0xFF;
    }
    if (!sendFrame(b, n, K_HIST)) return false;
    Serial.printf("MeshPRS track history seq %u N=%d: %d missed positions, oldest %lus ago\n", seq, n, hist_n, (unsigned long)((now - hist[0].at) / 1000));
    hist_sent++; hist_entries += hist_n; hist_n = 0;
    seq++;   // a new frame (spec §5.8), not a retry
    return true;
  }

  // header for a frame of `sub`: 0x50 (v1, K), subtype, seq, callsign, key prefix -> 13 bytes, or 0 if the call is bad
  int head(uint8_t* b, uint8_t sub) {
    b[0] = 0x50; b[1] = sub; b[2] = seq;
    if (!call40(cfg.call, &b[3])) { Serial.println("MeshPRS: bad callsign"); return 0; }
    memcpy(&b[9], self_id.pub_key, 4);
    return 13;
  }

  // -- telemetry (spec §7, subtype 0x03): the mobile tracker layout of decision 0027 -----------------------------------
  //   A1 Battery V  = raw*0.005+3      A2 Hops: not sent -- mask bit 5 (H) has each iGate fill in the repeater hops it
  //   heard this frame over (0 = direct; decision 0031)                         A3 Echo% of our last 10 flooded frames
  //   A4 Sats                          A5 Temp degC  = raw*0.5-40 (the MCU die, a little above the air in the case)
  //   B1 Charge (external power)  B2 LowBt (< 3.50 V, clears > 3.60)  B3 Fix  B4 Move (>= 5 km/h)  B5 Echo (last frame)
  //   B6 Fld (flooding)  B7 Rbt (booted < 10 min ago)  B8 Hot (> 50 degC, clears < 45)
  static uint8_t clamp8(long v) { return (uint8_t)max(0L, min(255L, v)); }
  bool lowBat() {
    if (board.isExternalPowered()) return false;
    uint16_t mv = board.getBattMilliVolts();
    return tlm_lowbt ? mv < 3600 : mv < 3500;
  }
  bool hot() { float t = board.getMCUTemperature(); return tlm_hot ? t > 45 : t > 50; }
  uint8_t echoPct() { return echo_n ? (uint8_t)lround(100.0 * __builtin_popcount(echo_ring) / echo_n) : 0; }

  void tlmValues(uint8_t a[5], uint8_t& bits) {
    uint16_t mv = board.getBattMilliVolts();
    float t = board.getMCUTemperature();
    a[0] = clamp8(lround((mv - 3000) / 5.0));
    a[1] = 0;   // A2: filled in by the iGate (H), never sent
    a[2] = echoPct();
    a[3] = clamp8(sats);
    a[4] = clamp8(lround((t + 40) * 2));
    bool lb = lowBat(), ht = hot();
    bits = (board.isExternalPowered() ? 0x80 : 0) | (lb ? 0x40 : 0) | (fix ? 0x20 : 0) | (fix && speed_kmh >= 5 ? 0x10 : 0)
         | (last_echo ? 0x08 : 0) | (cfg.flood ? 0x04 : 0) | (millis() < 600000UL ? 0x02 : 0) | (ht ? 0x01 : 0);
  }

  bool sendTlm() {
    uint8_t b[32], a[5], bits; int n = head(b, 0x03);
    if (!n) return false;
    tlmValues(a, bits);
    b[n++] = 0x00;   // kind: values
    b[n++] = 0xBD;   // mask: A1, A3-A5 + H (the iGate's hop count in the A2 slot) + the digital byte
    b[n++] = a[0]; memcpy(&b[n], &a[2], 3); n += 3;
    b[n++] = bits;
    if (!sendFrame(b, n)) return false;
    tlm_sent_at = millis(); tlm_count++; tlm_lowbt = (bits & 0x40) != 0; tlm_hot = (bits & 0x01) != 0;
    Serial.printf("MeshPRS telemetry seq %u: T#%03u,%03u,hops,%03u,%03u,%03u,", seq, seq, a[0], a[2], a[3], a[4]);
    for (int i = 7; i >= 0; i--) Serial.print((bits >> i) & 1);
    Serial.println();
    seq++;
    return true;
  }

  // kinds 1-4: PARM, UNIT, EQNS, BITS (names fit APRS's 7,7,6,6,5 / 6,5,4,4,4,3,3,3 limits)
  bool sendTlmDef(uint8_t kind) {
    char text[80];
    if (kind == 1) strcpy(text, "Battery,Hops,Echo%,Sats,Temp,Charge,LowBt,Fix,Move,Echo,Fld,Rbt,Hot");
    else if (kind == 2) strcpy(text, "V,hops,%,sats,degC,on,low,yes,yes,yes,yes,yes,yes");
    else if (kind == 3) strcpy(text, "0,0.005,3,0,1,0,0,1,0,0,1,0,0,0.5,-40");
    else {
      char title[24]; snprintf(title, sizeof(title), "%s tracker", getNodeName());
      snprintf(text, sizeof(text), "11111111,%s", title);
    }
    uint8_t b[MPRS_MAX_BLOB]; int n = head(b, 0x03);
    if (!n) return false;
    b[n++] = kind;
    int l = strlen(text); memcpy(&b[n], text, l); n += l;
    if (!sendFrame(b, n)) return false;
    Serial.printf("MeshPRS telemetry def seq %u kind %u N=%d: %s\n", seq, kind, n, text);
    seq++;
    return true;
  }

  // a frame's echo window closes 20 s after it was sent (or when the next goes out): it joins the last-10 record
  void closeEcho(uint32_t now, bool force) {
    if (!bcn_open || (!force && now - bcn_at < MPRS_ECHO_WAIT_MS)) return;
    bcn_open = false;
    echo_ring = ((echo_ring << 1) | (bcn_echo ? 1 : 0)) & 0x3FF;
    if (echo_n < 10) echo_n++;
    last_echo = bcn_echo; last_echo_snr = bcn_snr;
    if (bcn_echo) Serial.printf("MeshPRS echo: %u repeater copies, best SNR %.2f dB; %u%% of the last %u\n", bcn_count, bcn_snr, echoPct(), echo_n);
    else Serial.printf("MeshPRS echo: none heard%s; %u%% of the last %u\n", force ? " (window cut short by the next frame)" : "", echoPct(), echo_n);
    // spec §5.7 / §5.8: what a missing echo means depends on what the frame was
    if (!bcn_echo && bcn_kind == K_POS && !force) {              // a full 20 s with no echo: retry once, 20-30 s from now
      if (cfg.noretry) keepMissed();
      else { uint8_t r; fast_rng.random(&r, 1); rt_at = now + MPRS_RETRY_MIN_MS + (uint32_t)r * MPRS_RETRY_SPAN_MS / 255; rt_pending = true; }
    }
    if (!bcn_echo && bcn_kind == K_RETRY) keepMissed();           // the retry got no echo either
    if (bcn_echo && bcn_kind == K_RETRY) rt_echoed++;
    if (bcn_echo && (bcn_kind == K_POS || bcn_kind == K_RETRY)) link_ok_at = now;   // 1.6: parked telemetry goes now
    if (bcn_echo && hist_n) hist_due = true;                       // back in coverage: send the history next
  }

protected:
  // every received packet, BEFORE the duplicate check (Dispatcher.cpp checkRecv): a flood copy of our own last frame
  // means a repeater heard it. pkt->getSNR() is the repeater -> us direction.
  void logRx(mesh::Packet* pkt, int len, float score) override {
    if (!bcn_open || pkt->getPayloadType() != PAYLOAD_TYPE_GRP_DATA || !pkt->isRouteFlood()) return;
    uint8_t h[MAX_HASH_SIZE]; pkt->calculatePacketHash(h);
    if (memcmp(h, bcn_hash, MAX_HASH_SIZE)) return;
    float s = pkt->getSNR();
    if (!bcn_echo || s > bcn_snr) bcn_snr = s;
    bcn_echo = true; bcn_count++;
  }

  void onSensorDataRead() override { }
  int querySeriesData(uint32_t start_secs_ago, uint32_t end_secs_ago, MinMaxAvg dest[], int max_num) override { return 0; }

  bool handleCustomCommand(uint32_t sender_timestamp, char* command, char* reply) override {
    if (strncmp(command, "mprs", 4) != 0 || (command[4] && command[4] != ' ')) return false;
    const char* a = command[4] ? command + 5 : "";
    char* v = (char*)strchr(a, ' '); if (v) *v++ = 0; else v = (char*)"";
    bool save = true;
    if (!*a) {
      save = false;
      uint32_t ago = sent_count ? (millis() - last_sent_at) / 1000 : 0;
      snprintf(reply, 160, "Mesh Buddy " MESH_BUDDY_VERSION " %s %s %s %s every %s fix %s %d sats; sent %lu (last %lus ago N=%d) seq %u spd %.0f",
               cfg.on ? "ON" : "OFF", cfg.call[0] ? cfg.call : "NOCALL", cfg.sym, cfg.flood ? "flood" : "zerohop",
               cfg.every_s ? String(cfg.every_s).c_str() : "smart", fix ? "yes" : "NO", sats, (unsigned long)sent_count, (unsigned long)ago, last_n, seq, speed_kmh);
      return true;
    }
    if (!strcmp(a, "on")) cfg.on = 1;
    else if (!strcmp(a, "off")) cfg.on = 0;
    else if (!strcmp(a, "now")) { save = false; strcpy(reply, fix && beacon(sensors.node_lat, sensors.node_lon) ? "sent" : "no GPS fix yet"); return true; }
    else if (!strcmp(a, "call")) { uint8_t t[6]; String c(v); c.toUpperCase(); if (c.length() > 9 || !call40(c.c_str(), t)) { strcpy(reply, "bad callsign"); return true; } strcpy(cfg.call, c.c_str()); }
    else if (!strcmp(a, "sym")) { if (strlen(v) != 2) { strcpy(reply, "symbol is 2 characters, e.g. /b"); return true; } strcpy(cfg.sym, v); }
    else if (!strcmp(a, "comment")) { int l = 0; for (const char* p = v; *p && l < 23; p++) if (*p >= 0x20 && *p <= 0x7E && *p != '|' && *p != '~') cfg.comment[l++] = *p; cfg.comment[l] = 0; }
    else if (!strcmp(a, "every")) { int s = atoi(v); cfg.every_s = s <= 0 ? 0 : max(MPRS_FLOOR_S, min(3600, s)); }
    else if (!strcmp(a, "min")) cfg.min_s = max(MPRS_FLOOR_S, min(3600, atoi(v)));
    else if (!strcmp(a, "max")) cfg.max_s = max(60, min(7200, atoi(v)));
    else if (!strcmp(a, "move")) cfg.move_m = max(20, min(5000, atoi(v)));
    else if (!strcmp(a, "turn")) cfg.turn_deg = max(5, min(90, atoi(v)));
    else if (!strcmp(a, "status")) { int l = 0; for (const char* p = v; *p && l < 62; p++) if (*p >= 0x20 && *p <= 0x7E && *p != '|' && *p != '~') cfg.status[l++] = *p; cfg.status[l] = 0; status_count = 0; }   // sent again soon
    else if (!strcmp(a, "gps")) {
      save = false;
      snprintf(reply, 160, "GPS %s (%s): %d sats>=%u, %s PDOP %.1f<=%.1f HDOP %.1f<=%.1f acc %.0f<=%.0fm climb %.1f<=%.1fm/s; held %lus%s",
               fix ? "GOOD" : "POOR", fix ? "ok" : last_why, sats, limSats(), q_ublox ? (q_type >= 3 ? "3D" : "2D/none") : "no u-blox",
               q_pdop, limPdop(), q_hdop, limHdop(), q_hacc, limHacc(), climbRate(millis()), limClimb(), (unsigned long)held_s,
               mbWatchdogReset() ? "; RST=WATCHDOG" : "");
      return true;
    }
    else if (!strcmp(a, "pdop") || !strcmp(a, "hdop")) {
      uint8_t x = !strcmp(v, "off") ? 255 : (uint8_t)max(0L, min(250L, lround(atof(v) * 10)));
      if (x && x != 255 && x < 10) { strcpy(reply, "DOP limit 1.0-25.0, 0 = default, off"); return true; }
      if (a[0] == 'p') cfg.pdop10 = x; else cfg.hdop10 = x;
    }
    else if (!strcmp(a, "hacc")) cfg.hacc_m = !strcmp(v, "off") ? 65535 : (uint16_t)max(0, min(5000, atoi(v)));
    else if (!strcmp(a, "climb")) {
      uint8_t x = !strcmp(v, "off") ? 255 : (uint8_t)max(0L, min(250L, lround(atof(v) * 10)));
      if (x && x != 255 && x < 5) { strcpy(reply, "climb limit 0.5-25.0 m/s, 0 = default 2.0, off"); return true; }
      cfg.climb10 = x;
    }
    else if (!strcmp(a, "sats")) cfg.min_sats = !strcmp(v, "off") ? 255 : (uint8_t)max(0, min(20, atoi(v)));
    else if (!strcmp(a, "statusmin")) cfg.status_min = max(MPRS_STATUS_MIN_MIN, min(1440, atoi(v)));
    else if (!strcmp(a, "statusnow")) { save = false; strcpy(reply, sendStatus(true) ? "sent" : "no status set"); return true; }
    else if (!strcmp(a, "tlm")) {
      if (!strcmp(v, "on")) cfg.notlm = 0;
      else if (!strcmp(v, "off")) cfg.notlm = 1;
      else if (!strcmp(v, "wait")) cfg.notlmwait = 0;      // 1.6: parked, wait for a position echo (default)
      else if (!strcmp(v, "nowait")) cfg.notlmwait = 1;
      else if (!strcmp(v, "now")) { save = false; strcpy(reply, sendTlm() ? "sent" : "send failed"); return true; }
      else if (!strcmp(v, "defs")) { save = false; defs_next = 1; strcpy(reply, "definitions queued"); return true; }
      else {
        save = false;
        uint8_t t[5], bits; tlmValues(t, bits);
        char bs[9]; for (int i = 0; i < 8; i++) bs[i] = (bits >> (7 - i)) & 1 ? '1' : '0'; bs[8] = 0;
        snprintf(reply, 160, "tlm %s: %u mV, echo %s %.2f dB, %u%% of %u, %d sats, %.1f C, bits %s (Chg LowBt Fix Move Echo Fld Rbt Hot); sent %lu%s%s",
                 cfg.notlm ? "OFF" : "ON", board.getBattMilliVolts(), last_echo ? "yes" : "no", last_echo_snr, echoPct(), echo_n, sats,
                 board.getMCUTemperature(), bs, (unsigned long)tlm_count, cfg.notlmwait ? "; nowait" : tlm_waiting ? "; waiting" : "; wait",
                 mbWatchdogReset() ? "; RST=WATCHDOG" : "");
        return true;
      }
    }
    else if (!strcmp(a, "route")) { if (!strcmp(v, "flood")) cfg.flood = 1; else if (!strcmp(v, "zerohop")) cfg.flood = 0; else { strcpy(reply, "route zerohop | flood"); return true; } }
    else if (!strcmp(a, "retry") || !strcmp(a, "hist")) {   // spec §5.7 position retry / §5.8 track history (saved; on by default)
      uint8_t& off = a[0] == 'r' ? cfg.noretry : cfg.nohist;
      if (!strcmp(v, "on")) off = 0;
      else if (!strcmp(v, "off")) { off = 1; if (a[0] == 'r') rt_pending = false; else { hist_n = 0; hist_due = false; } }
      else {
        save = false;
        snprintf(reply, 160, "retry %s: %lu sent, %lu echoed%s; hist %s: %d waiting, %lu kept, %lu frames / %lu entries sent%s",
                 cfg.noretry ? "OFF" : "ON", (unsigned long)rt_sent, (unsigned long)rt_echoed, rt_pending ? ", 1 due" : "",
                 cfg.nohist ? "OFF" : "ON", hist_n, (unsigned long)hist_kept, (unsigned long)hist_sent, (unsigned long)hist_entries,
                 cfg.flood ? "" : " (zero-hop: no echoes, so neither runs)");
        return true;
      }
    }
    else { strcpy(reply, "mprs [on|off|now|call|sym|comment|status|statusmin|statusnow|every|min|max|move|turn|route|tlm|gps|pdop|hdop|hacc|climb|sats|retry|hist]"); return true; }
    if (save) {
      fs_->remove(MPRS_CFG_FILE);
      File f = fs_->open(MPRS_CFG_FILE, FILE_O_WRITE);
      if (f) { f.write((uint8_t*)&cfg, sizeof(cfg)); f.close(); }
    }
    strcpy(reply, "OK");
    return true;
  }

private:
  MprsCfg cfg;
  mesh::GroupChannel channel;
  FILESYSTEM* fs_ = NULL;
  uint8_t seq = 0;
  bool fix = false, have_ref = false;
  int sats = 0, last_n = 0, st_len = 0;
  uint8_t st_buf[64], tx_hash[MAX_HASH_SIZE], bcn_hash[MAX_HASH_SIZE], defs_next = 0, echo_n = 0;
  bool bcn_open = false, bcn_echo = false, last_echo = false, tlm_lowbt = false, tlm_hot = false;
  float bcn_snr = -99, last_echo_snr = -99;
  uint16_t echo_ring = 0, bcn_count = 0;
  uint32_t last_tx_at = 0, bcn_at = 0, tlm_sent_at = 0, tlm_count = 0, defs_sent_at = 0, link_ok_at = 0, def_at = 0;
  bool tlm_waiting = false;
  uint32_t next_sample = 0, last_sent_at = 0, sent_count = 0, ref_at = 0, status_sent_at = 0, status_count = 0;
  double ref_lat = 0, ref_lon = 0, last_lat = 0, last_lon = 0, speed_kmh = 0, course_deg = 0, last_course = -1;
  // GPS quality gate: the last sample's u-blox figures, the run of good samples, the last good (published) position
  bool q_ublox = false;
  uint8_t q_type = 0;
  int good_run = 0;
  float q_pdop = 0, q_hdop = 0, q_hacc = 0;
  double prev_raw_lat = 0, prev_raw_lon = 0, good_lat = 0, good_lon = 0, good_alt = 0;
  uint32_t prev_raw_at = 0, good_at = 0, held_s = 0;
  // the climb check: raw heights of the last ALT_RING samples (2 s apart)
  static const int ALT_RING = 30;
  float alt_ring[ALT_RING] = {0}, raw_alt = 0;
  uint32_t alt_ring_at[ALT_RING] = {0};
  int alt_head = 0, alt_n = 0;
  const char* last_why = "no fix";
  const char* logged_why = "";
  // the frame whose echo window is open: what it was decides what a missing echo means (spec §5.7, §5.8)
  enum { K_OTHER = 0, K_POS = 1, K_RETRY = 2, K_HIST = 3 };
  uint8_t bcn_kind = K_OTHER;
  // the last position sent, for its one retry and the track history; a retry waiting until rt_at
  uint8_t pos_buf[64]; int pos_len = 0;
  int32_t pos_lat = 0, pos_lon = 0; int16_t pos_alt = 0; uint32_t pos_at = 0;
  bool rt_pending = false, hist_due = false;
  uint32_t rt_at = 0, rt_sent = 0, rt_echoed = 0, hist_kept = 0, hist_sent = 0, hist_entries = 0;
  struct Missed { int32_t lat, lon; uint32_t at; int16_t alt; };   // 16 bytes each, 128 for all 8
  Missed hist[MPRS_HIST_MAX];
  int hist_n = 0;

  static int32_t deg_raw(double x, double span) {     // spec §5.1: round half away from zero, clamp to i24
    int32_t v = (int32_t)floor(fabs(x) * 8388608.0 / span + 0.5);
    return x >= 0 ? min(v, (int32_t)8388607) : -min(v, (int32_t)8388608);
  }
  static void put24(uint8_t* b, int& n, int32_t v) { b[n++] = v & 0xFF; b[n++] = (v >> 8) & 0xFF; b[n++] = (v >> 16) & 0xFF; }
  static bool call40(const char* s, uint8_t out[6]) {   // spec §4.1: base-40, first character least significant, big-endian
    int len = strlen(s); if (len < 1 || len > 9) return false;
    uint64_t v = 0;
    for (int i = len - 1; i >= 0; i--) { const char* p = strchr(ALPHA40, s[i]); if (!p || !s[i]) return false; v = v * 40 + (p - ALPHA40); }
    for (int i = 5; i >= 0; i--) { out[i] = v & 0xFF; v >>= 8; }
    return true;
  }
  static double dist_m(double a1, double o1, double a2, double o2) {
    const double R = 6371008.8, k = M_PI / 180;
    double dl = (a2 - a1) * k, dn = (o2 - o1) * k, x = sin(dl / 2) * sin(dl / 2) + cos(a1 * k) * cos(a2 * k) * sin(dn / 2) * sin(dn / 2);
    return 2 * R * asin(min(1.0, sqrt(x)));
  }
  static double bearing(double a1, double o1, double a2, double o2) {
    const double k = M_PI / 180;
    double y = sin((o2 - o1) * k) * cos(a2 * k), x = cos(a1 * k) * sin(a2 * k) - sin(a1 * k) * cos(a2 * k) * cos((o2 - o1) * k);
    return fmod(atan2(y, x) / k + 360, 360);
  }
};

MyMesh the_mesh(board, radio_driver, *new ArduinoMillis(), fast_rng, rtc_clock, tables);

void halt() { while (1) ; }

static char command[160];

void setup() {
  Serial.begin(115200);
  mbWatchdogStart();   // first, so a hang anywhere from here on reboots the tracker
  delay(1000);
  board.begin();
  Serial.printf("Mesh Buddy " MESH_BUDDY_VERSION ": last reset = %s\n", mbResetName());
  mbClearResetReason();
#ifdef HAS_EXTERNAL_WATCHDOG
  external_watchdog.begin();
#endif
#ifdef DISPLAY_CLASS
  if (display.begin()) { display.startFrame(); display.print("Please wait..."); display.endFrame(); }
#endif
  if (!radio_init()) { halt(); }
  fast_rng.begin(radio_driver.getRngSeed());

  FILESYSTEM* fs;
  InternalFS.begin();
  fs = &InternalFS;
  IdentityStore store(InternalFS, "");
  if (!store.load("_main", the_mesh.self_id)) {
    the_mesh.self_id = radio_new_identity();
    int count = 0;
    while (count < 10 && (the_mesh.self_id.pub_key[0] == 0x00 || the_mesh.self_id.pub_key[0] == 0xFF)) { the_mesh.self_id = radio_new_identity(); count++; }
    store.save("_main", the_mesh.self_id);
  }
  Serial.print("Node key: ");
  mesh::Utils::printHex(Serial, the_mesh.self_id.pub_key, PUB_KEY_SIZE); Serial.println();

  command[0] = 0;
  sensors.begin();
  the_mesh.begin(fs);
  the_mesh.beginTracker(fs);
#ifdef DISPLAY_CLASS
  ui_task.begin(the_mesh.getNodePrefs(), FIRMWARE_BUILD_DATE, FIRMWARE_VERSION);
#endif
#if ENABLE_ADVERT_ON_BOOT == 1
  the_mesh.sendSelfAdvertisement(16000, false);   // zero-hop: the home node learns the key (the iGate binding needs it)
#endif
}

void loop() {
  mbWatchdogFeed();
  int len = strlen(command);
  if (len >= (int)sizeof(command)) { command[0] = 0; len = 0; }
  while (Serial.available() && len < (int)sizeof(command) - 1) {
    char c = Serial.read();
    if (c != '\n') { command[len++] = c; command[len] = 0; }
    Serial.print(c);
  }
  if (len == sizeof(command) - 1) { command[sizeof(command) - 2] = '\r'; command[sizeof(command) - 1] = 0; }
  if (len > 0 && command[len - 1] == '\r') {
    command[len - 1] = 0;
    char reply[160];
    reply[0] = 0;
    the_mesh.handleCommand(NULL, 0, command, reply);
    if (reply[0]) { Serial.print("  -> "); Serial.println(reply); }
    command[0] = 0;
  }
  board.loop();
  the_mesh.loop();
  sensors.loop();
  the_mesh.trackerLoop();
#ifdef DISPLAY_CLASS
  ui_task.loop();
#endif
  rtc_clock.tick();
#ifdef HAS_EXTERNAL_WATCHDOG
  external_watchdog.loop();
#endif
}
