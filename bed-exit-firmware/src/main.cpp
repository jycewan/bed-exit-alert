#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <WiFiManager.h>
#include <WiFiMulti.h>
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include "secrets.h"  // defines MQTT_USER, MQTT_PASS — gitignored, not committed

// PIN CONFIG
#define RGB_PIN        27
#define NUM_LEDS       1
#define SENSOR_PIN     4        // Supervised mat/pushbutton ADC input (R1 pull-up + R2 EOL resistor)
#define CONFIG_BTN_PIN 9        // Hold LOW at boot to reopen the setup portal WITHOUT erasing Wi-Fi.
                                 // Wire a pushbutton between this pin and GND (uses internal pull-up,
                                 // no external resistor needed). Pick any free GPIO on your board —
                                 // this just needs to not collide with SENSOR_PIN or the debounce circuit.
                                 // Confirmed against the ESP32-C5 datasheet: GPIO9 is NOT a strapping
                                 // pin on this chip (unlike the ESP32-C3, where GPIO9 IS the boot-mode
                                 // strap - that's a different chip's convention, not this one). C5 boot
                                 // mode strapping lives on GPIO26/27/28 instead. GPIO9 is an ordinary
                                 // GPIO here, safe to use for this button. Needs an external pushbutton
                                 // wired between this pin and GND - nothing on the devkit is connected
                                 // to it out of the box, and this is NOT the onboard BOOT button (that
                                 // one is wired to the chip's actual strapping pins for firmware
                                 // flashing and shouldn't be reused for this).

Adafruit_NeoPixel rgb(NUM_LEDS, RGB_PIN, NEO_GRB + NEO_KHZ800);

// Official Let's Encrypt ISRG Root X1 (Raw String Literal Format)
const char* HIVEMQ_CA_CERT = R"(-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----)";


// STABLE DEVICE IDENTITY — derived from the ESP32's factory-programmed eFuse
// MAC, never written to NVS and therefore immune to both a Bed ID rename
// (portal) and a FACTORY_RESET (prefs.clear() below). MQTT topics and the
// Firebase record for this physical device are keyed off THIS, not the
// human-editable Bed ID label - so renaming a bed no longer makes the
// bridge treat it as a brand new device and orphan the old dashboard entry.
// (The hex digits come straight out of the 48-bit eFuse MAC integer, not
// necessarily in the same byte order printed by WiFi.macAddress() - that
// doesn't matter here, it only needs to be unique and stable, which it is.)
char device_id[13]; // 12 hex chars + null terminator

void computeDeviceId() {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(device_id, sizeof(device_id), "%012llX", (unsigned long long)mac);
}

// DYNAMIC BED ID — stored in NVS (flash) via Preferences, independent of
// WiFiManager's own saved Wi-Fi credentials. This is what actually fixes
// "typed 01, got 101 back": previously the portal only ran (and only ever
// saved anything) on a fresh/reset Wi-Fi setup. Now the Bed ID is loaded
// from Preferences BEFORE the portal is built, so autoConnect() reconnecting
// silently no longer overwrites it back to a compiled-in default.
// NOTE: this is now purely a human-facing LABEL, published separately on a
// retained bed/{device_id}/label topic - it no longer appears in any MQTT
// topic or Firebase path itself, so renaming it can't orphan anything.
Preferences prefs;
char custom_bed_id[16] = "101"; // fallback ONLY if nothing has ever been saved
WiFiManagerParameter custom_bed_id_param("bed_id", "Bed Label (e.g. 101) - can be renamed anytime", custom_bed_id, 16);

// Backup Wi-Fi network - editable from the same portal as Bed ID, stored in
// NVS, optional (blank = no backup registered). Password field is masked
// via the raw HTML "type='password'" override on the constructor.
char custom_backup_ssid[33] = "";
char custom_backup_pass[65] = "";
WiFiManagerParameter custom_backup_ssid_param("backup_ssid", "Backup WiFi SSID (optional)", custom_backup_ssid, 33);
WiFiManagerParameter custom_backup_pass_param("backup_pass", "Backup WiFi Password", custom_backup_pass, 65, "type='password'");


// SUPERVISED SENSOR (EOL RESISTOR) CONFIG
const int THRESH_PRESSED_MAX = 600;     // adc <= this  -> PRESSED (shorted to GND)
const int THRESH_IDLE_MIN    = 1100;    // idle band
const int THRESH_IDLE_MAX    = 2200;
const int THRESH_FAULT_MIN   = 3000;    // adc >= this  -> FAULT (open loop)
const int SAMPLES_PER_READ   = 8;       // oversampling to smooth ADC noise


const unsigned long DEBOUNCE_DELAY = 50; // ms - reading must be stable this long before acting


enum SensorState { STATE_IDLE, STATE_PRESSED, STATE_FAULT, STATE_UNKNOWN };


SensorState lastReadState = STATE_UNKNOWN; // most recent raw classification (pre-debounce)
SensorState currentState  = STATE_UNKNOWN; // debounced, "official" state
unsigned long lastDebounceTime = 0;
unsigned long lastMqttRetry = 0;


WiFiClientSecure wifiClient;
PubSubClient mqttClient(wifiClient);


// LED HELPERS
void setLedColor(uint8_t r, uint8_t g, uint8_t b) {
  rgb.setPixelColor(0, rgb.Color(r, g, b));
  rgb.show();
}


void setLedForState(SensorState s) {
  switch (s) {
    case STATE_PRESSED: setLedColor(255, 0, 255); break; // Magenta: exit event
    case STATE_IDLE:     setLedColor(0, 255, 0);   break; // Green: normal
    case STATE_FAULT:    setLedColor(255, 255, 255); break; // White: wiring/sensor fault
    default:              setLedColor(0, 255, 0);   break; // default to green if unknown
  }
}


// SENSOR READ + CLASSIFY
int readSensorRaw() {
  long sum = 0;
  for (int i = 0; i < SAMPLES_PER_READ; i++) {
    sum += analogRead(SENSOR_PIN);
    delayMicroseconds(200);
  }
  return (int)(sum / SAMPLES_PER_READ);
}


SensorState classify(int adcValue) {
  if (adcValue <= THRESH_PRESSED_MAX) return STATE_PRESSED;
  if (adcValue >= THRESH_FAULT_MIN)   return STATE_FAULT;
  if (adcValue >= THRESH_IDLE_MIN && adcValue <= THRESH_IDLE_MAX) return STATE_IDLE;
  return STATE_UNKNOWN; // landed in a dead zone between bands - treat as noise, ignore
}


// WIFI
unsigned long lastWifiRetry = 0;
WiFiMulti wifiMulti; // populated in setup() after WiFiManager provisioning - primary network + facility backup

void handleWifiConnection() {
  // wifiMulti.run() scans every registered network and (re)connects to
  // whichever is reachable - replaces plain WiFi.reconnect(), which only
  // ever retried the single primary network. Falls over automatically if
  // the primary AP goes down and a backup was registered in setup().
  if (wifiMulti.run() != WL_CONNECTED) {
    unsigned long now = millis();
    if (now - lastWifiRetry > 5000) {
      lastWifiRetry = now;
      Serial.println("WiFi disconnected - retrying across known networks...");
      setLedColor(255, 150, 0); // Yellow: reconnecting
    }
  }
}


// MQTT
void publishState(SensorState state); // forward declaration - defined below, called from handleMqttConnection on reconnect
void handleRemoteCommand(String payload); // forward declaration - defined below, called from mqttCallback

// Fired by PubSubClient whenever a message arrives on any topic we're
// subscribed to. Only the per-bed command topic is subscribed right now,
// so anything landing here is a remote command.
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  msg.reserve(length);
  for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];

  String topicStr(topic);
  if (topicStr.endsWith("/cmd")) {
    handleRemoteCommand(msg);
  }
}

void handleMqttConnection() {
  if (WiFi.status() != WL_CONNECTED) return; // nothing to do until WiFi is back

  if (!mqttClient.connected()) {
    setLedColor(255, 150, 0); // Yellow: connecting
    unsigned long now = millis();


    if (now - lastMqttRetry > 5000) {
      lastMqttRetry = now;
      char statusTopic[32];
      snprintf(statusTopic, sizeof(statusTopic), "bed/%s/status", device_id);


      char clientId[32];
      snprintf(clientId, sizeof(clientId), "esp32-c5-bed-%s", device_id);


      Serial.print("Connecting to HiveMQ Cloud as ");
      Serial.println(clientId);


      if (mqttClient.connect(clientId, MQTT_USER, MQTT_PASS, statusTopic, 1, true, "OFFLINE")) {
        Serial.println("Connected to HiveMQ Cloud");
        mqttClient.publish(statusTopic, "ONLINE", true);
        setLedForState(currentState); // reflect actual sensor state, not just "connected"

        // Republish current sensor state right away on every (re)connect.
        // Without this, if the state didn't change while we were offline
        // (e.g. mat was IDLE before power loss and is still IDLE after),
        // nothing would re-trigger publishState() and the bridge/Firebase
        // would stay stuck showing "OFFLINE" until the next real transition
        // - which could be a long time. This guarantees fresh truth the
        // moment connectivity is restored, not just an "ONLINE" marker.
        if (currentState != STATE_UNKNOWN) {
          publishState(currentState);
        }

        char cmdTopic[32];
        snprintf(cmdTopic, sizeof(cmdTopic), "bed/%s/cmd", device_id);
        mqttClient.subscribe(cmdTopic);

        // Republish the current label (retained) on every (re)connect, not
        // just once - this is how the bridge learns/updates the human-facing
        // name for this device_id without it ever appearing in a topic path.
        // Retained + republished on reconnect means even a bridge restart
        // that happens between two device reconnects still picks it up.
        char labelTopic[32];
        snprintf(labelTopic, sizeof(labelTopic), "bed/%s/label", device_id);
        mqttClient.publish(labelTopic, custom_bed_id, true);
      } else {
        Serial.print("MQTT connection failed. State: ");
        Serial.println(mqttClient.state());
        setLedColor(255, 0, 0); // Red: connection error
      }
    }
  } else {
    mqttClient.loop();
  }
}


void publishState(SensorState state) {
  char exitTopic[32];
  snprintf(exitTopic, sizeof(exitTopic), "bed/%s/exit", device_id);

  setLedForState(state);

  const char* payload = nullptr;
  switch (state) {
    case STATE_PRESSED: payload = "STEPPED_ON_MAT"; break;
    case STATE_IDLE:    payload = "OFF_MAT";        break;
    case STATE_FAULT:   payload = "SENSOR_FAULT";   break;
    default: return; // STATE_UNKNOWN never reaches here
  }

  // Guard + check the actual return value instead of printing success
  // unconditionally - a silent failure here (e.g. dropped connection
  // mid-publish) previously looked identical to a real success in the logs.
  if (!mqttClient.connected()) {
    Serial.print("Publish skipped (MQTT not connected): ");
    Serial.println(payload);
    return;
  }

  bool ok = mqttClient.publish(exitTopic, payload);
  if (ok) {
    Serial.print("Event Published: ");
    Serial.println(payload);
  } else {
    Serial.print("Event Publish FAILED: ");
    Serial.println(payload);
  }
}


// REMOTE COMMANDS (bed/{id}/cmd) — lets a supervisor act on this device
// without being physically present, AS LONG AS it's already reachable over
// MQTT. None of these help if Wi-Fi is fully down - there's no way to
// receive a command with no connection. That case still needs the
// physical CONFIG_BTN_PIN.
//   "OPEN_PORTAL"              -> reboot into the setup portal (same as holding the button)
//   "FORCE_RECONNECT"          -> drop Wi-Fi now, let wifiMulti retry immediately
//   "SET_BACKUP_WIFI:ssid:pw"  -> save + register a new backup network live, no reboot
//   "SET_LABEL:newlabel"       -> save + republish the Bed Label live, no reboot - this is
//                                 what lets the admin dashboard rename a bed WITHOUT anyone
//                                 touching the physical device's boot portal (see admin-routes.js).
//                                 Same offline caveat as every command here: if this device
//                                 isn't reachable over MQTT right now, nothing happens.
//   "FACTORY_RESET"            -> erase saved Wi-Fi + Bed Label + backup Wi-Fi, reboot into
//                                 the boot portal as if freshly flashed. Irreversible -
//                                 whatever bed this was assigned to has to be re-provisioned
//                                 by hand at the device afterward. device_id is NOT stored in
//                                 the "bexit" NVS namespace this wipes - it's re-derived from
//                                 the eFuse MAC every boot, so this device keeps reporting
//                                 under the same Firebase/MQTT identity it always has, just
//                                 with the label reset to the "101" default until relabeled.
void handleRemoteCommand(String payload) {
  payload.trim();

  if (payload == "OPEN_PORTAL") {
    Serial.println("Remote command: OPEN_PORTAL - restarting into config portal");
    prefs.begin("bexit", false);
    prefs.putBool("force_portal", true); // consumed + cleared at next boot
    prefs.end();
    delay(200);
    ESP.restart();

  } else if (payload == "FACTORY_RESET") {
    Serial.println("Remote command: FACTORY_RESET - erasing Wi-Fi + Bed ID + backup Wi-Fi, restarting");
    WiFi.disconnect(true, true); // erases the Wi-Fi credentials WiFiManager itself reads/writes
    prefs.begin("bexit", false);
    prefs.clear(); // wipes bed_id, backup_ssid, backup_pass, force_portal in one go
    prefs.end();
    delay(200);
    ESP.restart(); // autoConnect() will find no saved Wi-Fi and open the boot portal on its own

  } else if (payload == "FORCE_RECONNECT") {
    Serial.println("Remote command: FORCE_RECONNECT - dropping Wi-Fi to force retry");
    WiFi.disconnect();

  } else if (payload.startsWith("SET_BACKUP_WIFI:")) {
    String rest = payload.substring(strlen("SET_BACKUP_WIFI:"));
    int sep = rest.indexOf(':');
    if (sep > 0) {
      String ssid = rest.substring(0, sep);
      String pass = rest.substring(sep + 1);

      prefs.begin("bexit", false);
      prefs.putString("backup_ssid", ssid);
      prefs.putString("backup_pass", pass);
      prefs.end();

      ssid.toCharArray(custom_backup_ssid, sizeof(custom_backup_ssid));
      pass.toCharArray(custom_backup_pass, sizeof(custom_backup_pass));
      wifiMulti.addAP(custom_backup_ssid, custom_backup_pass); // takes effect immediately, no reboot needed

      Serial.print("Remote command: SET_BACKUP_WIFI - backup network updated to ");
      Serial.println(ssid);
    } else {
      Serial.println("Remote command: SET_BACKUP_WIFI - malformed payload (expected ssid:password), ignored");
    }

  } else if (payload.startsWith("SET_LABEL:")) {
    String newLabel = payload.substring(strlen("SET_LABEL:"));
    newLabel.trim();
    // sizeof(custom_bed_id) is 16 (matches the portal field's own buffer) -
    // strictly less than, so there's always room for the null terminator.
    if (newLabel.length() > 0 && newLabel.length() < sizeof(custom_bed_id)) {
      newLabel.toCharArray(custom_bed_id, sizeof(custom_bed_id));

      prefs.begin("bexit", false);
      prefs.putString("bed_id", custom_bed_id);
      prefs.end();

      // Republish retained immediately rather than waiting for the next
      // reconnect - this is what makes the dashboard's rename feel live
      // instead of "changed, but only takes effect whenever this device
      // happens to reconnect next."
      char labelTopic[32];
      snprintf(labelTopic, sizeof(labelTopic), "bed/%s/label", device_id);
      mqttClient.publish(labelTopic, custom_bed_id, true);

      Serial.print("Remote command: SET_LABEL - bed label updated to ");
      Serial.println(custom_bed_id);
    } else {
      Serial.println("Remote command: SET_LABEL - empty or too-long label, ignored");
    }

  } else {
    Serial.print("Remote command: unrecognized payload ignored: ");
    Serial.println(payload);
  }
}


// SETUP
void setup() {
  Serial.begin(115200);
  delay(1000); // give native USB CDC time to start
  Serial.println("\n--- ESP32-C5 BED ALERT SYSTEM STARTING (supervised EOL sensor) ---");

  computeDeviceId(); // fixed hardware identity - independent of anything in NVS
  Serial.print("Device ID (fixed): ");
  Serial.println(device_id);


  rgb.begin();
  rgb.setBrightness(40);
  setLedColor(255, 0, 0); // Red: booting


  // IMPORTANT: plain INPUT, no internal pull-up - the external R1/R2 network biases the pin.
  pinMode(SENSOR_PIN, INPUT);
  analogReadResolution(12);       // 0-4095
  analogSetAttenuation(ADC_11db); // allow full 0-3.3V input range

  pinMode(CONFIG_BTN_PIN, INPUT_PULLUP);


  // Load the previously saved Bed ID from flash BEFORE building the portal,
  // so the field shows what's actually saved, and so a silent Wi-Fi
  // reconnect (no portal run) leaves it untouched instead of resetting it.
  prefs.begin("bexit", false); // namespace "bexit", read-write
  String savedId = prefs.getString("bed_id", "101");
  savedId.toCharArray(custom_bed_id, sizeof(custom_bed_id));

  String savedBackupSsid = prefs.getString("backup_ssid", "");
  String savedBackupPass = prefs.getString("backup_pass", "");
  savedBackupSsid.toCharArray(custom_backup_ssid, sizeof(custom_backup_ssid));
  savedBackupPass.toCharArray(custom_backup_pass, sizeof(custom_backup_pass));

  // Set by a remote OPEN_PORTAL command (see handleRemoteCommand); consume
  // it here so it doesn't force the portal open on every future boot too.
  bool remoteForcePortal = prefs.getBool("force_portal", false);
  if (remoteForcePortal) prefs.putBool("force_portal", false);
  prefs.end();   // closed before radio init starts (see NVS-contention note in project log)

  WiFiManager wm;
  // wm.resetSettings(); // keep commented out so it remembers Wi-Fi!


  // Read-only status block shown at the top of the portal page: current
  // saved Wi-Fi network + current Bed ID. wm.getWiFiSSID() reads what's
  // saved in flash without needing to actually be connected.
  String statusHtml = "<p style='margin-bottom:12px'><b>Currently saved Wi-Fi:</b> "
                       + (wm.getWiFiSSID().length() ? wm.getWiFiSSID() : String("(none saved)"))
                       + "<br><b>Current Bed Label:</b> " + String(custom_bed_id)
                       + "<br><b>Device ID (fixed):</b> " + String(device_id) + "</p>";
  WiFiManagerParameter statusDisplay(statusHtml.c_str());
  
  custom_bed_id_param.setValue(custom_bed_id, 16);
  custom_backup_ssid_param.setValue(custom_backup_ssid, 33);
  custom_backup_pass_param.setValue(custom_backup_pass, 65);
  
  wm.addParameter(&statusDisplay);
  wm.addParameter(&custom_bed_id_param);
  wm.addParameter(&custom_backup_ssid_param);
  wm.addParameter(&custom_backup_pass_param);


  wm.setAPCallback([](WiFiManager *myWiFiManager) {
    setLedColor(0, 0, 255); // Blue: AP setup mode active
  });

  // Authoritative "the ESP32 actually received and saved this" signal -
  // fires only when a submission genuinely reaches and is processed by the
  // device, independent of whatever the browser/phone shows. A phone
  // roaming off the no-internet BedAlert-Setup AP mid-request can show its
  // own "done" page without the ESP32 ever getting the data - this
  // callback is the only trustworthy confirmation, since it comes from the
  // device itself rather than the client.
  bool configWasSaved = false;
  wm.setSaveConfigCallback([&configWasSaved]() {
    configWasSaved = true;
    Serial.println(">>> Config actually received and saved by ESP32 <<<");
    setLedColor(0, 255, 255); // Cyan: confirmed save, distinct from every other status color
    delay(1500); // held long enough to actually see it before the board moves on
  });

  wm.setAPStaticIPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
  wm.setConfigPortalTimeout(300); // was 180 - 3 minutes was too tight to reliably connect + submit


  // Hold the config button during boot to reopen the portal WITHOUT
  // erasing saved Wi-Fi — lets you change Bed ID (or Wi-Fi, if you also
  // want to) on a board that's already set up, instead of the old
  // "uncomment resetSettings(), reflash, re-enter Wi-Fi every time" dance.
  bool forcePortal = (digitalRead(CONFIG_BTN_PIN) == LOW) || remoteForcePortal;


  bool connected;
  if (forcePortal) {
    Serial.println("Config button held at boot - opening setup portal (Wi-Fi kept)");
    setLedColor(0, 0, 255); // Blue: setup mode, matches AP callback color

    connected = wm.startConfigPortal("BedAlert-Setup");

  } else {
    connected = wm.autoConnect("BedAlert-Setup");
  }

  // Persist any submitted custom params BEFORE checking whether Wi-Fi
  // actually connected. configWasSaved firing already means the ESP32
  // itself received and parsed the POST - that's a done deal regardless of
  // what happens next. Previously this NVS write only ran on the connected
  // path below, so submitting just a Bed ID change (leaving the Wi-Fi
  // fields blank/unchanged) while the AP happened to have a transient
  // hiccup reconnecting would hit "connected == false" and restart the
  // board WITHOUT ever writing bed_id to flash - the portal showed the
  // cyan "saved" confirmation, but the change silently never made it to
  // NVS, and the next boot came back showing the old value. Saving here,
  // ahead of the restart branch, means a submission that was genuinely
  // received can no longer be lost to an unrelated Wi-Fi reconnect failure.
  if (configWasSaved) {
    prefs.begin("bexit", false);

    strcpy(custom_bed_id, custom_bed_id_param.getValue());
    if (savedId != custom_bed_id) {
      prefs.putString("bed_id", custom_bed_id);
      Serial.print("Bed ID saved to flash: ");
      Serial.println(custom_bed_id);
    }

    strcpy(custom_backup_ssid, custom_backup_ssid_param.getValue());
    strcpy(custom_backup_pass, custom_backup_pass_param.getValue());
    if (savedBackupSsid != custom_backup_ssid || savedBackupPass != custom_backup_pass) {
      prefs.putString("backup_ssid", custom_backup_ssid);
      prefs.putString("backup_pass", custom_backup_pass);
      Serial.println("Backup WiFi credentials saved to flash");
    }
    prefs.end();
  }

  if (!connected) {
    if (configWasSaved) {
      Serial.println("Config was saved (and already written to flash above), but WiFi connection with those credentials failed. Restarting...");
    } else {
      Serial.println("Portal timed out with no submission received - restarting to try again.");
    }
    delay(3000);
    ESP.restart();
  }


  // Register networks for automatic failover: the primary one WiFiManager
  // just connected to (wm.getWiFiPass() reads the password it already has
  // cached - nothing new stored in source), plus an optional facility
  // backup network defined in secrets.h. If BACKUP_WIFI_SSID/PASS aren't
  // defined there, this just runs with the one (primary) network - no
  // build error either way.
  wifiMulti.addAP(WiFi.SSID().c_str(), wm.getWiFiPass().c_str());
  if (strlen(custom_backup_ssid) > 0) {
    wifiMulti.addAP(custom_backup_ssid, custom_backup_pass);
    Serial.println("Backup WiFi network registered for failover (from portal)");
  }
#if defined(BACKUP_WIFI_SSID) && defined(BACKUP_WIFI_PASS)
  wifiMulti.addAP(BACKUP_WIFI_SSID, BACKUP_WIFI_PASS); // secrets.h fallback - still supported alongside the portal field
  Serial.println("Backup WiFi network registered for failover (from secrets.h)");
#endif


  // Synchronize ESP32 clock with Internet time via NTP (REQUIRED for TLS).
  // Bounded wait instead of an infinite one: if this network is up but has
  // no real internet route, the old loop would hang here forever and the
  // board would never finish booting - not even far enough to reach the
  // config portal on a later reset. Give it ~15s, then proceed regardless;
  // the ESP32's SNTP client keeps retrying in the background, so time (and
  // therefore TLS) still self-heals once a real route appears.
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("Synchronizing time for SSL...");
  time_t now = time(nullptr);
  unsigned long ntpStart = millis();
  const unsigned long NTP_TIMEOUT_MS = 15000;
  while (now < 8 * 3600 * 2 && (millis() - ntpStart) < NTP_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
    now = time(nullptr);
  }
  if (now < 8 * 3600 * 2) {
    Serial.println("\nNTP sync timed out - proceeding without confirmed time (TLS may fail until it catches up in the background)");
  } else {
    Serial.println("\nTime synchronized!");
  }


  wifiClient.setCACert(HIVEMQ_CA_CERT);
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);


  setLedColor(0, 255, 0); // Green: booted, waiting on first classified reading
}


// LOOP
void loop() {
  handleWifiConnection();
  handleMqttConnection();


  int raw = readSensorRaw();
  SensorState reading = classify(raw);


  // Dead-zone reading (noise / transition). Also reset the debounce
  // candidate/timer here, not just skip - otherwise a noisy sample sitting
  // between two valid same-state readings doesn't reset the 50ms window,
  // so the debounce no longer guarantees a truly continuous stable read.
  if (reading == STATE_UNKNOWN) {
    lastReadState = STATE_UNKNOWN;
    lastDebounceTime = millis();
    return;
  }


  if (reading != lastReadState) {
    lastDebounceTime = millis();
  }


  if ((millis() - lastDebounceTime) > DEBOUNCE_DELAY) {
    if (reading != currentState) {
      currentState = reading;


      Serial.print("[");
      Serial.print(millis());
      Serial.print("ms] raw=");
      Serial.print(raw);
      Serial.print(" -> state=");
      switch (currentState) {
        case STATE_IDLE:    Serial.println("IDLE");    break;
        case STATE_PRESSED: Serial.println("PRESSED"); break;
        case STATE_FAULT:   Serial.println("FAULT");   break;
        default: break;
      }


      publishState(currentState);
    }
  }


  lastReadState = reading;
}