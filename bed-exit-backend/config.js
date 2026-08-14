require('dotenv').config();

const {
  PORT,
  MQTT_HOST,
  MQTT_PORT,
  MQTT_USER,
  MQTT_PASS,
  FIREBASE_DATABASE_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SUPERVISOR_CHAT_ID,
  ESCALATION_DELAY_MS,
  PAUSE_DURATION_MS,
  ADMIN_USER,
  ADMIN_PASS
} = process.env;

// Fail loudly on startup if anything required is missing.
const required = {
  PORT, MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS,
  FIREBASE_DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  SUPERVISOR_CHAT_ID, ESCALATION_DELAY_MS, PAUSE_DURATION_MS,
  ADMIN_USER, ADMIN_PASS
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) {
  console.error(`❌ Missing required .env keys: ${missing.join(', ')}`);
  process.exit(1);
}

// Device IDs (the eFuse-MAC-derived hex string firmware now uses as its
// stable identity - see device_id in main.cpp) enter this system from two
// untrusted-ish sources: MQTT topic parsing and Express route params. Both
// get validated against this before being used in Firebase paths, MQTT
// topics, or Telegram callback data - underscore would break callback_data
// parsing, slashes would alter Firebase/MQTT paths. Kept permissive enough
// (still allows plain digits) to not break any bed that hasn't been
// reflashed with the device_id firmware yet and is still publishing under
// its old numeric Bed ID.
const BED_ID_PATTERN = /^[A-Za-z0-9-]{1,15}$/;

// The human-editable label (formerly "Bed ID", set via the WiFiManager
// portal or the dashboard's Rename button) is published separately on
// bed/{deviceId}/label and never enters a Firebase/MQTT *path* or
// callback_data - but it IS rendered into the admin dashboard's innerHTML
// unescaped (see admin-routes.js), so it still needs a whitelist to rule
// out stored XSS from a spoofed/compromised publisher on that topic. Spaces
// allowed since it's meant to be a human-friendly name (e.g. "Room 4 - Bed
// 1"), unlike BED_ID_PATTERN. Capped at 15, not 32 - custom_bed_id on the
// firmware side is a fixed char[16] buffer (see main.cpp), so anything
// longer would just get silently truncated on the device; matching the
// limit here means a rejection shows up immediately in the dashboard
// instead of as a confusing mismatch after the fact.
const LABEL_PATTERN = /^[A-Za-z0-9 _-]{1,15}$/;

module.exports = {
  PORT,
  MQTT_HOST,
  MQTT_PORT,
  MQTT_USER,
  MQTT_PASS,
  FIREBASE_DATABASE_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SUPERVISOR_CHAT_ID,
  ESCALATION_DELAY_MS: Number(ESCALATION_DELAY_MS),
  PAUSE_DURATION_MS: Number(PAUSE_DURATION_MS),
  ADMIN_USER,
  ADMIN_PASS,
  BED_ID_PATTERN,
  LABEL_PATTERN
};
