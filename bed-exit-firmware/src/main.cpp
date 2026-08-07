#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <WiFiManager.h>
#include <WiFiMulti.h>
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>


// PIN CONFIG
#define RGB_PIN        27
#define NUM_LEDS       1
#define SENSOR_PIN     4        // Supervised mat/pushbutton ADC input (R1 pull-up + R2 EOL resistor)
#define CONFIG_BTN_PIN 9        // Hold LOW at boot to reopen the setup portal WITHOUT erasing Wi-Fi.
                                 // Wire a pushbutton between this pin and GND (uses internal pull-up,
                                 // no external resistor needed). Pick any free GPIO on your board —
                                 // this just needs to not collide with SENSOR_PIN or the debounce circuit.

Adafruit_NeoPixel rgb(NUM_LEDS, RGB_PIN, NEO_GRB + NEO_KHZ800);

#include "secrets.h"  // defines MQTT_USER, MQTT_PASS — gitignored, not committed

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


// DYNAMIC BED ID — stored in NVS (flash) via Preferences, independent of
// WiFiManager's own saved Wi-Fi credentials. This is what actually fixes
// "typed 01, got 101 back": previously the portal only ran (and only ever
// saved anything) on a fresh/reset Wi-Fi setup. Now the Bed ID is loaded
// from Preferences BEFORE the portal is built, so autoConnect() reconnecting
// silently no longer overwrites it back to a compiled-in default.
Preferences prefs;
char custom_bed_id[16] = "101"; // fallback ONLY if nothing has ever been saved
WiFiManagerParameter custom_bed_id_param("bed_id", "Bed ID (e.g. 101)", custom_bed_id, 16);

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
      snprintf(statusTopic, sizeof(statusTopic), "bed/%s/status", custom_bed_id);


      char clientId[32];
      snprintf(clientId, sizeof(clientId), "esp32-c5-bed-%s", custom_bed_id);


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
        snprintf(cmdTopic, sizeof(cmdTopic), "bed/%s/cmd", custom_bed_id);
        mqttClient.subscribe(cmdTopic);
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
  snprintf(exitTopic, sizeof(exitTopic), "bed/%s/exit", custom_bed_id);

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
//   "FACTORY_RESET"            -> erase saved Wi-Fi + Bed ID + backup Wi-Fi, reboot into
//                                 the boot portal as if freshly flashed. Irreversible -
//                                 whatever bed this was assigned to has to be re-provisioned
//                                 by hand at the device afterward.
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


  WiFiManager wm;
  // wm.resetSettings(); // keep commented out so it remembers Wi-Fi!


  // Read-only status block shown at the top of the portal page: current
  // saved Wi-Fi network + current Bed ID. wm.getWiFiSSID() reads what's
  // saved in flash without needing to actually be connected.
  String statusHtml = "<p style='margin-bottom:12px'><b>Currently saved Wi-Fi:</b> "
                       + (wm.getWiFiSSID().length() ? wm.getWiFiSSID() : String("(none saved)"))
                       + "<br><b>Current Bed ID:</b> " + String(custom_bed_id) + "</p>";
  WiFiManagerParameter statusDisplay(statusHtml.c_str());
  wm.addParameter(&statusDisplay);
  wm.addParameter(&custom_bed_id_param);
  wm.addParameter(&custom_backup_ssid_param);
  wm.addParameter(&custom_backup_pass_param);


  wm.setAPCallback([](WiFiManager *myWiFiManager) {
    setLedColor(0, 0, 255); // Blue: AP setup mode active
  });


  wm.setAPStaticIPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
  wm.setConfigPortalTimeout(180);


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


  if (!connected) {
    Serial.println("Failed to connect or setup timed out. Restarting...");
    delay(3000);
    ESP.restart();
  }


  // Only overwrite the saved Bed ID if the portal actually ran and the
  // field differs from what's saved — an autoConnect() silent reconnect
  // never touches custom_bed_id_param, so this is a no-op in that case.
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


  // Dead-zone reading (noise / transition) - ignore entirely, don't disturb debounce timer
  if (reading == STATE_UNKNOWN) {
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