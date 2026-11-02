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
 * horizontal accuracy estimate <= hacc metres; no sample-to-sample jump faster than 250 km/h; and that has held for 3
 * samples in a row (6 s). Otherwise positions are held: nothing is beaconed and the advert carries the last good
 * position (for up to 10 min, then none). Telemetry and status still go out (Fix bit = a good fix, A4 = raw sats).
 *   mprs gps              the live DOP / accuracy and whether it passes   mprs pdop|hdop <x>  mprs hacc <m>  mprs sats <n>
 *                         (0 = back to the default, "off" = that check off)
 *
 * USB serial / remote admin CLI, on top of MeshCore's own ("get name", "gps", "set freq" ...):
 *   mprs                  status          mprs on | off            mprs now           (one beacon now, if there's a fix)
 *   mprs call VK4XXX-12    mprs sym /b     mprs comment <text>      mprs every <s>     (0 = smart)
 *   mprs route zerohop | flood            mprs min <s>  mprs max <s>  mprs move <m>  mprs turn <deg>
 *   mprs status <text>    (spec §8.4 plain status, APRS ">text"; empty = none)   mprs statusmin <min>   mprs statusnow
 *   mprs tlm              telemetry now-values    mprs tlm on | off | now | defs
 * Status: once after the first position, then every statusmin (default 720 = 12 h, never under 360 -- spec §8.4: an
 *   unchanged status is sent rarely). A NEW status (after boot, a changed text, statusnow) is sent again 75 s later as a
 *   retry (spec §8.4: 60-90 s, header retry field 1, same seq); a routine repeat isn't. Smart beaconing min 120 s, the spec §5.5 default; a mobile in
 *   patchy coverage MAY use 60 s (decision 0027). Defaults: comment "LoRa MESHCORE", status "MeshPRS gateway via Kelly Page".
 * Telemetry (spec §7, decision 0027's mobile layout -- see sendTlm): battery, repeater echo SNR and echo % (a repeater
 *   re-sending our own flooded frame, caught in logRx before the duplicate check), satellites, MCU temperature, 8 state
 *   bits. Values every 10 min moving / 30 min parked (+ on a LowBt / Hot change); definitions at boot and every 12 h.
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

#define MESH_BUDDY_VERSION "1.2"

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
  #define MPRS_COMMENT "Mesh Buddy"
#endif
#ifndef MPRS_STATUS
  #define MPRS_STATUS  ""             // none until the owner sets one
#endif

#define MPRS_DATA_TYPE   0xFF4D
#define MPRS_FLOOR_S     30
#define MPRS_STATUS_RETRY_MS 75000UL   // spec §8.4: one status retry 60-90 s later
#define MPRS_GAP_MS      5000UL        // at least this long between any two of our frames
#define MPRS_MAX_BLOB    100
#define MPRS_TLM_START_MS 60000UL      // telemetry starts a minute after boot
#define MPRS_TLM_MOVE_MIN 10
#define MPRS_TLM_PARK_MIN 30
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
#define GPS_ADVERT_KEEP_MS 600000UL   // the advert keeps the last good position this long
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
  uint8_t pdop10, hdop10, min_sats, pad_;
  uint16_t hacc_m;
};
static_assert(offsetof(MprsCfg, pdop10) == MPRS_CFG_V2_SIZE - 2, "1.1 config layout moved");

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
      cfg.min_s = 120; cfg.max_s = 1800; cfg.move_m = 100; cfg.turn_deg = 15;   // spec §5.5 defaults, except min (spec 60 s)
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
    return NULL;
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
    readQuality(raw);
    const char* why = poorReason(raw, lat, lon, now);
    if (raw) { prev_raw_lat = lat; prev_raw_lon = lon; prev_raw_at = now; }
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
    bool quiet = !last_tx_at || now - last_tx_at >= MPRS_GAP_MS;   // >= 5 s since any of our own frames

    // telemetry definitions (spec §7.3): a minute after boot, then every 6 h; one frame per tick, 5 s apart
    if (!cfg.notlm && quiet && now >= MPRS_TLM_START_MS) {
      if (!defs_next && (!defs_sent_at || now - defs_sent_at >= MPRS_DEFS_MS)) defs_next = 1;
      if (defs_next) { if (sendTlmDef(defs_next)) { if (++defs_next > 4) { defs_next = 0; defs_sent_at = now; } } return; }
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
    // telemetry values: every 10 min moving, 30 min parked, and soon after LowBt / Hot changes (spec §7, decision 0027)
    if (!cfg.notlm && quiet && now >= MPRS_TLM_START_MS) {
      bool lb = lowBat(), ht = hot();
      bool alert = (lb != tlm_lowbt || ht != tlm_hot) && now - tlm_sent_at >= 120000UL;
      uint32_t every = (fix && speed_kmh >= 5 ? MPRS_TLM_MOVE_MIN : MPRS_TLM_PARK_MIN) * 60000UL;
      if (!tlm_count || alert || now - tlm_sent_at >= every) { sendTlm(); return; }
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
    if (!sendFrame(b, n)) return false;
    last_lat = lat; last_lon = lon; last_course = moving ? course_deg : -1; last_sent_at = millis(); sent_count++; last_n = n;
    Serial.printf("MeshPRS #%lu seq %u N=%d %s: %.5f %.5f alt %d m%s, %d sats\n", (unsigned long)sent_count, seq, n, cfg.flood ? "flood" : "zero-hop",
                  lat, lon, alt, moving ? " moving" : "", sats);
    seq++;
    return true;
  }

  // spec §8.4: Emergency / Status, code 8 = plain status -> APRS ">text". Header + code + text, no position (N = 14 + text)
  bool sendStatus(bool retry) {   // retry: a new status, so it's sent again 75 s later
    if (!cfg.status[0]) return false;
    uint8_t b[64]; int n = 0;
    b[n++] = 0x50; b[n++] = 0x09; b[n++] = seq;
    if (!call40(cfg.call, &b[n])) return false;
    n += 6;
    memcpy(&b[n], self_id.pub_key, 4); n += 4;
    b[n++] = 0x08;
    int l = strlen(cfg.status); memcpy(&b[n], cfg.status, l); n += l;
    if (!sendFrame(b, n)) return false;
    if (retry) { memcpy(st_buf, b, n); st_len = n; }   // kept for the one retry
    status_sent_at = millis(); status_count++;
    Serial.printf("MeshPRS status seq %u N=%d %s: >%s\n", seq, n, cfg.flood ? "flood" : "zero-hop", cfg.status);
    seq++;   // one counter for every subtype (spec §9.3)
    return true;
  }

  // GRP_DATA on #meshprs, data type 0xFF4D; unscoped flood with the node's path hash size, or zero-hop
  bool sendFrame(const uint8_t* b, int n) {
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
    if (cfg.flood) { memcpy(bcn_hash, tx_hash, MAX_HASH_SIZE); bcn_at = last_tx_at; bcn_open = true; bcn_echo = false; bcn_snr = -99; bcn_count = 0; }
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
  //   A1 Battery V  = raw*0.005+3      A2 EchoSNR dB = raw*0.25-32 (0 = no echo)   A3 Echo% of our last 10 flooded frames
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
    a[1] = last_echo ? max((uint8_t)1, clamp8(lround((last_echo_snr + 32) * 4))) : 0;
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
    b[n++] = 0x9F;   // mask: A1-A5 + the digital byte
    memcpy(&b[n], a, 5); n += 5;
    b[n++] = bits;
    if (!sendFrame(b, n)) return false;
    tlm_sent_at = millis(); tlm_count++; tlm_lowbt = (bits & 0x40) != 0; tlm_hot = (bits & 0x01) != 0;
    Serial.printf("MeshPRS telemetry seq %u: T#%03u,%03u,%03u,%03u,%03u,%03u,", seq, seq, a[0], a[1], a[2], a[3], a[4]);
    for (int i = 7; i >= 0; i--) Serial.print((bits >> i) & 1);
    Serial.println();
    seq++;
    return true;
  }

  // kinds 1-4: PARM, UNIT, EQNS, BITS (names fit APRS's 7,7,6,6,5 / 6,5,4,4,4,3,3,3 limits)
  bool sendTlmDef(uint8_t kind) {
    char text[80];
    if (kind == 1) strcpy(text, "Battery,EchoSNR,Echo%,Sats,Temp,Charge,LowBt,Fix,Move,Echo,Fld,Rbt,Hot");
    else if (kind == 2) strcpy(text, "V,dB,%,sats,degC,on,low,yes,yes,yes,yes,yes,yes");
    else if (kind == 3) strcpy(text, "0,0.005,3,0,0.25,-32,0,1,0,0,1,0,0,0.5,-40");
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
    else Serial.printf("MeshPRS echo: none heard; %u%% of the last %u\n", echoPct(), echo_n);
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
      snprintf(reply, 160, "GPS %s (%s): %d sats >= %u, %s PDOP %.1f <= %.1f HDOP %.1f <= %.1f acc %.0f <= %.0f m; held %lus",
               fix ? "GOOD" : "POOR", fix ? "ok" : last_why, sats, limSats(), q_ublox ? (q_type >= 3 ? "3D" : "2D/none") : "no u-blox",
               q_pdop, limPdop(), q_hdop, limHdop(), q_hacc, limHacc(), (unsigned long)held_s);
      return true;
    }
    else if (!strcmp(a, "pdop") || !strcmp(a, "hdop")) {
      uint8_t x = !strcmp(v, "off") ? 255 : (uint8_t)max(0L, min(250L, lround(atof(v) * 10)));
      if (x && x != 255 && x < 10) { strcpy(reply, "DOP limit 1.0-25.0, 0 = default, off"); return true; }
      if (a[0] == 'p') cfg.pdop10 = x; else cfg.hdop10 = x;
    }
    else if (!strcmp(a, "hacc")) cfg.hacc_m = !strcmp(v, "off") ? 65535 : (uint16_t)max(0, min(5000, atoi(v)));
    else if (!strcmp(a, "sats")) cfg.min_sats = !strcmp(v, "off") ? 255 : (uint8_t)max(0, min(20, atoi(v)));
    else if (!strcmp(a, "statusmin")) cfg.status_min = max(MPRS_STATUS_MIN_MIN, min(1440, atoi(v)));
    else if (!strcmp(a, "statusnow")) { save = false; strcpy(reply, sendStatus(true) ? "sent" : "no status set"); return true; }
    else if (!strcmp(a, "tlm")) {
      if (!strcmp(v, "on")) cfg.notlm = 0;
      else if (!strcmp(v, "off")) cfg.notlm = 1;
      else if (!strcmp(v, "now")) { save = false; strcpy(reply, sendTlm() ? "sent" : "send failed"); return true; }
      else if (!strcmp(v, "defs")) { save = false; defs_next = 1; strcpy(reply, "definitions queued"); return true; }
      else {
        save = false;
        uint8_t t[5], bits; tlmValues(t, bits);
        char bs[9]; for (int i = 0; i < 8; i++) bs[i] = (bits >> (7 - i)) & 1 ? '1' : '0'; bs[8] = 0;
        snprintf(reply, 160, "tlm %s: %u mV, echo %s %.2f dB, %u%% of %u, %d sats, %.1f C, bits %s (Chg LowBt Fix Move Echo Fld Rbt Hot); sent %lu",
                 cfg.notlm ? "OFF" : "ON", board.getBattMilliVolts(), last_echo ? "yes" : "no", last_echo_snr, echoPct(), echo_n, sats,
                 board.getMCUTemperature(), bs, (unsigned long)tlm_count);
        return true;
      }
    }
    else if (!strcmp(a, "route")) { if (!strcmp(v, "flood")) cfg.flood = 1; else if (!strcmp(v, "zerohop")) cfg.flood = 0; else { strcpy(reply, "route zerohop | flood"); return true; } }
    else { strcpy(reply, "mprs [on|off|now|call|sym|comment|status|statusmin|statusnow|every|min|max|move|turn|route|tlm|gps|pdop|hdop|hacc|sats]"); return true; }
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
  uint32_t last_tx_at = 0, bcn_at = 0, tlm_sent_at = 0, tlm_count = 0, defs_sent_at = 0;
  uint32_t next_sample = 0, last_sent_at = 0, sent_count = 0, ref_at = 0, status_sent_at = 0, status_count = 0;
  double ref_lat = 0, ref_lon = 0, last_lat = 0, last_lon = 0, speed_kmh = 0, course_deg = 0, last_course = -1;
  // GPS quality gate: the last sample's u-blox figures, the run of good samples, the last good (published) position
  bool q_ublox = false;
  uint8_t q_type = 0;
  int good_run = 0;
  float q_pdop = 0, q_hdop = 0, q_hacc = 0;
  double prev_raw_lat = 0, prev_raw_lon = 0, good_lat = 0, good_lon = 0, good_alt = 0;
  uint32_t prev_raw_at = 0, good_at = 0, held_s = 0;
  const char* last_why = "no fix";
  const char* logged_why = "";

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
  delay(1000);
  board.begin();
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
