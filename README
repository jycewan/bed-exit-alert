# Bed-Exit Alert System

A privacy-preserving bed-exit alert system for assisted-living residents. A floor pressure mat beside the bed detects when a resident's feet touch the floor and notifies a caregiver via Telegram — without continuous visual monitoring, and without restraining or tracking the resident's movement.

**Status:** functional end-to-end pipeline

---

## How it works

```
Floor pressure mat (beside bed)
        |
ESP32-C5 firmware (main.cpp)
        | MQTT over TLS
HiveMQ Cloud (broker)
        |
bridge.js (Node.js, runs under pm2)
        |
   ├── Firebase Realtime Database (status mirror)
   └── Telegram (caregiver + supervisor alerts)
```

A resident stepping onto the floor mat publishes `STEPPED_ON_MAT`. The bridge sends a Telegram alert with **Ack & Pause** / **Ack & Clear** buttons. If nobody acknowledges within a configurable delay, it escalates to a supervisor. Alert-clearing is caregiver-driven, not sensor-driven — a single mat can't confirm the resident actually returned to bed, so releasing the mat never auto-clears an active alert.

---

## Firmware (`main.cpp`) — ESP32-C5 DevKitC-1

- **Sensor:** supervised EOL-resistor circuit on GPIO4, classified into three ADC-band states — `PRESSED` / `IDLE` / `FAULT` (open-loop / wiring fault) — with oversampling and software debounce.
- **Provisioning:** WiFiManager captive portal (`BedAlert-Setup`) for first-time WiFi + Bed ID setup. Bed ID persists in NVS independently of WiFi credentials.
- **WiFi redundancy:** `WiFiMulti` — registers the primary network plus an optional backup network (settable via the portal or remotely) and automatically fails over.
- **TLS:** validated against the ISRG Root X1 CA cert (Let's Encrypt), synced via NTP before the TLS handshake. NTP sync is time-bounded (~15s) so a dead network route can't hang boot forever.
- **Status LED:** red = booting, blue = setup portal active, yellow = connecting, green = idle/online, magenta = pressed, white = sensor fault.
- **Remote commands** (`bed/{id}/cmd` topic, only reachable while the device already has connectivity):
  - `OPEN_PORTAL` — reboot into the setup portal without erasing WiFi
  - `FORCE_RECONNECT` — drop WiFi to force an immediate retry
  - `SET_BACKUP_WIFI:ssid:password` — save + register a new backup network live, no reboot
  - `FACTORY_RESET` — erase saved WiFi + Bed ID + backup WiFi, reboot into the setup portal as if freshly flashed (irreversible)
- **Reconnect resync:** on every successful (re)connect, the device immediately republishes its current sensor state — so Firebase/the bridge never stay stuck showing a stale `OFFLINE` status after a reconnect that didn't happen to coincide with a real sensor transition.
- **MQTT Last Will and Testament:** on unclean disconnect (power loss, WiFi drop), HiveMQ publishes `OFFLINE` on the device's behalf to `bed/{id}/status`.

## Bridge (`bridge.js`) — Node.js, HiveMQ ↔ Firebase ↔ Telegram

- Subscribes to `bed/+/exit` and `bed/+/status` at QoS 1.
- Per-bed FSM: `STEPPED_ON_MAT` → alert + escalation timer; `SENSOR_FAULT` → alert + escalation timer; `OFFLINE` → alert + escalation timer; `OFF_MAT` → status reset (no chat noise — not actionable on its own).
- **Self-resolving alerts auto-clear:** if a device comes back `ONLINE`, or a `SENSOR_FAULT` clears on its own, the original Telegram alert is edited in place (button removed, message updated) instead of being left dangling.
- **Escalation:** unacknowledged alerts notify a separate supervisor chat after a configurable delay. Supervisor messages are plain notifications with no buttons — acking only ever happens in the main caregiver chat, so there's one source of truth.
- **Crash-safe:** active pauses, pending escalation timers, and trackable alert messages are all mirrored to Firebase and restored on startup — a pm2 restart mid-flight won't silently drop them. Any escalation that was already overdue while the bridge was down fires immediately on restart instead of vanishing.
- **Admin dashboard** (`GET /admin`, HTTP Basic Auth via `ADMIN_USER`/`ADMIN_PASS`): lists every bed that's ever reported, with buttons per bed for Open Portal, Force Reconnect, Set Backup WiFi, and Delete (sends `FACTORY_RESET` + wipes the bed's Firebase/in-memory state).
- **Express endpoints:** `GET /status` (health check), `POST /bed/:id/cmd` (remote command), `DELETE /bed/:id` (factory-reset + delete).

---

## Setup

### Firmware
1. PlatformIO + the **pioarduino** community fork (required for ESP32-C5 — the official `espressif32` platform doesn't support it).
2. Create `secrets.h` (gitignored, not committed) next to `main.cpp`:
   ```cpp
   #define MQTT_USER "..."
   #define MQTT_PASS "..."
   #define MQTT_HOST "your-cluster.hivemq.cloud"
   #define MQTT_PORT 8883
   // optional fallback backup WiFi (the portal can also set this live)
   #define BACKUP_WIFI_SSID "..."
   #define BACKUP_WIFI_PASS "..."
   ```
3. Flash, then either join `BedAlert-Setup` on first boot, or hold the config button (wired to `CONFIG_BTN_PIN`) to reopen the portal on an already-provisioned board.

### Bridge
1. `npm install` in the bridge directory.
2. Create `.env` (gitignored, not committed):
   ```
   PORT=3000
   MQTT_HOST=your-cluster.hivemq.cloud
   MQTT_PORT=8883
   MQTT_USER=...
   MQTT_PASS=...
   FIREBASE_DATABASE_URL=...
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   SUPERVISOR_CHAT_ID=...
   ESCALATION_DELAY_MS=120000
   PAUSE_DURATION_MS=1800000
   ADMIN_USER=...
   ADMIN_PASS=...
   ```
3. Place your Firebase service account key as `bexit-service-account-key.json` (gitignored, not committed) alongside `bridge.js`.
4. Run under pm2: `pm2 start bridge.js --name bexit-bridge` — this only needs to be set up once per machine, regardless of how many ESP32s connect to it.
5. Visit `http://<bridge-host>:<PORT>/admin` from a device on the same network to manage beds.

---

## Known issues / things to know before continuing

- **QoS 1 is subscribe-only.** `PubSubClient` (the MQTT library the firmware uses) doesn't support true QoS 1 on publish — only QoS 0. The bridge subscribes at QoS 1, but that only guarantees the broker→bridge hop, not device→broker. A real fix means swapping to a QoS-1-capable client library (e.g. `AsyncMqttClient`), which hasn't been done — flagged as a deliberate open item, not a silent gap.
- **No HiveMQ ACL on the command topic yet.** Anyone with valid MQTT broker credentials could currently publish to any bed's `bed/{id}/cmd` topic. The `/admin` dashboard and its HTTP endpoints are protected by Basic Auth, but the underlying MQTT topic itself is not yet restricted. HiveMQ Cloud's free tier only allows one topic filter per credential set, so a full fix needs either a paid tier or a credential-splitting workaround.
- **No hardware failsafe for simultaneous WiFi + power loss during an exit event**, by design — a standalone battery-powered local alarm was considered and deliberately rejected (wrong fit for assisted living: dignity/privacy prioritized over last-line-of-defense redundancy for a low-acuity setting). This is an accepted residual risk, covered operationally by routine staff check-ins.
- **Alert-clearing is caregiver-driven, not sensor-driven, by design.** A single floor mat cannot distinguish "resident returned to bed" from "resident is elsewhere." `OFF_MAT` never auto-clears an active exit alert.
- **Escalation delay tier for `SENSOR_FAULT`/`OFFLINE`** currently reuses `ESCALATION_DELAY_MS` (same as a bed exit) — still an open question for stakeholder sign-off on whether these should have their own delay.
- **IEC 60601 compliance relevance for using Telegram** as the caregiver notification channel in a care-facility deployment is flagged but not yet reviewed — needs stakeholder input before any production deployment.

---

## Hardware

- ESP32-C5 DevKitC-1 (dual 2.4GHz/5GHz WiFi)
- RS PRO Pressure Mat Surface, 250mA, 25V DC
- Supervised sensor circuit: R1 (external used) pull-up + R2 end-of-line resistor for open-loop/sensor fault detection 
