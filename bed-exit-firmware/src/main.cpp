#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <WiFiManager.h>
#include <Adafruit_NeoPixel.h>

// Onboard WS2812 RGB LED for ESP32-C5-DevKitC-1
#define RGB_PIN        27       
#define NUM_LEDS       1
#define BUTTON_PIN     4        // RS PRO NO Pressure Mat / Pushbutton Pin
#define CABLE_CHECK_PIN 5       // Cable loop check pin

Adafruit_NeoPixel rgb(NUM_LEDS, RGB_PIN, NEO_GRB + NEO_KHZ800);

// HiveMQ Broker Configuration
const char* MQTT_HOST      = "afed9081031241018181094db4d36505.s1.eu.hivemq.cloud";
const int   MQTT_PORT      = 8883;
const char* MQTT_USER      = "jycewan";
const char* MQTT_PASS      = "bexittest";

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

// Dynamic Bed ID (Captive Portal Storage)
char custom_bed_id[16] = "101";
WiFiManagerParameter custom_bed_id_param("bed_id", "Bed ID (e.g. 101)", custom_bed_id, 16);

// State Tracking
bool lastReading = HIGH;
bool currentState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long DEBOUNCE_DELAY = 50;
unsigned long lastMqttRetry = 0;

WiFiClientSecure wifiClient;
PubSubClient mqttClient(wifiClient);

void setLedColor(uint8_t r, uint8_t g, uint8_t b) {
  rgb.setPixelColor(0, rgb.Color(r, g, b));
  rgb.show();
}

void handleMqttConnection() {
  if (!mqttClient.connected()) {
    setLedColor(255, 150, 0); // 🟡 Yellow: Connecting to MQTT
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
        Serial.println("✅ Connected to HiveMQ Cloud!");
        mqttClient.publish(statusTopic, "ONLINE", true);
        setLedColor(0, 255, 0); // 🟢 Green: Fully Connected
      } else {
        Serial.print("❌ MQTT Connection Failed. State: ");
        Serial.println(mqttClient.state());
        setLedColor(255, 0, 0); // 🔴 Red: Connection Error
      }
    }
  } else {
    mqttClient.loop();
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000); // Give Native USB CDC time to start
  Serial.println("\n--- ESP32-C5 BED ALERT SYSTEM STARTING ---");
  
  rgb.begin();
  rgb.setBrightness(40);
  setLedColor(255, 0, 0); // 🔴 Red: Booting up

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  
  // Power Pin for Hardware Cable Check
  pinMode(CABLE_CHECK_PIN, OUTPUT);
  digitalWrite(CABLE_CHECK_PIN, HIGH);

  WiFiManager wm;
  // wm.resetSettings(); // 👈 Keep commented out so it remembers Wi-Fi!
  wm.addParameter(&custom_bed_id_param); 

  wm.setAPCallback([](WiFiManager *myWiFiManager) {
    setLedColor(0, 0, 255); // 🔵 Blue: Access Point Setup Mode Active
  });

  // Set static IP and timeout fixes to prevent captive portal freezes
  wm.setAPStaticIPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
  wm.setConfigPortalTimeout(180); 

  // Connect or start AP
// 1. Connect or start AP (This line waits until Wi-Fi connects)
  if (!wm.autoConnect("BedAlert-Setup")) {
    Serial.println("Failed to connect or setup timed out. Restarting...");
    delay(3000);
    ESP.restart();
  }

//Time sync below
  // Save the Bed ID entered in the form
  strcpy(custom_bed_id, custom_bed_id_param.getValue());

  // Synchronize ESP32 clock with Internet time via NTP (REQUIRED for TLS)
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("Synchronizing time for SSL...");
  time_t now = time(nullptr);
  while (now < 8 * 3600 * 2) {
    delay(500);
    Serial.print(".");
    now = time(nullptr);
  }
  Serial.println("\n✅ Time synchronized!");

  // Configure TLS Certificate & Broker
  wifiClient.setCACert(HIVEMQ_CA_CERT);
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(512); 
}

void loop() {
  handleMqttConnection();

  bool reading = digitalRead(BUTTON_PIN);

  if (reading != lastReading) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > DEBOUNCE_DELAY) {
    if (reading != currentState) {
      currentState = reading;
      
      char exitTopic[32];
      snprintf(exitTopic, sizeof(exitTopic), "bed/%s/exit", custom_bed_id);

      // 🚨 FLOOR MAT / PUSHBUTTON LOGIC (Active-LOW when pressed)
      if (currentState == LOW) {
        // Resident stepped ON floor mat (Button Pressed -> GND)
        setLedColor(255, 0, 255); // 🟣 Magenta LED: Exit Event
        mqttClient.publish(exitTopic, "STEPPED_ON_MAT");
        Serial.println("🚨 Event Published: STEPPED_ON_MAT");
      } else {
        // Resident stepped OFF floor mat (Button Released -> HIGH)
        setLedColor(0, 255, 0); // 🟢 Green LED: Normal State
        mqttClient.publish(exitTopic, "OFF_MAT");
        Serial.println("🟢 Event Published: OFF_MAT");
      }
    }
  }

  lastReading = reading;
}