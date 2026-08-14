# Bed Exit Alert System

A privacy-preserving bed-exit monitoring system for assisted-living residents. A supervised floor pressure mat beside the bed detects when a resident's feet touch the floor and notifies a caregiver via Telegram — with escalation, wiring-fault detection, and offline-device alerting — **without continuous visual monitoring or restraining/tracking the resident's movement.**

**Status:** functional end-to-end pipeline, in active use.

---

## Features

- **Bed-exit detection** — a supervised (end-of-line resistor) floor mat circuit distinguishes `PRESSED` / `IDLE` / `FAULT` (wiring/sensor fault, not just "no signal"), with oversampling + software debounce against ADC noise.
- **Telegram alerting with in-chat acknowledgement** — every alert ships with **Ack & Pause** / **Ack & Clear** buttons. Alert-clearing is deliberately caregiver-driven, not sensor-driven: a mat going idle can't confirm the resident is actually back in bed, so it never silently clears an active alert on its own.
- **Supervisor escalation** — an unacknowledged alert (exit, sensor fault, or device offline) escalates to a separate supervisor chat after a configurable delay. Self-resolving alerts (device reconnects, fault clears) auto-edit the original message instead of leaving a stale button dangling.
- **Stable device identity, independent of naming** — each ESP32 has a fixed identity derived from its own hardware (eFuse MAC), so renaming a bed's label — or even factory-resetting the device — never orphans its Firebase/dashboard history under a "new" device. See [Device Identity vs. Bed Label](#-device-identity-vs-bed-label).
- **Remote fleet management** — a web dashboard lists every bed device and can rename, reopen the setup portal, force a WiFi reconnect, push new backup WiFi credentials, or factory-reset/delete a device — all without physical access, as long as the device is currently online.
- **WiFi redundancy** — automatic failover between a primary and an optional backup network (`WiFiMulti`), settable from the device's own portal, remotely from the dashboard, or as a compiled-in fallback.
- **Crash-safe bridge state** — active pause windows, pending escalation timers, and in-flight Telegram message tracking are all mirrored to Firebase and restored on startup, so a process restart (crash, redeploy, `pm2` restart) never silently drops in-flight state. Escalations that were already overdue while the bridge was down fire immediately on restart instead of vanishing.
- **TLS everywhere** — both the device→broker and bridge→broker MQTT legs are certificate-verified (ISRG Root X1 / Let's Encrypt), not just one side.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Firmware** | C++ (Arduino framework), ESP32-C5, PlatformIO |
| **Firmware libraries** | PubSubClient (MQTT), WiFiManager (captive-portal provisioning), Adafruit NeoPixel (status LED), WiFiMulti |
| **Bridge runtime** | Node.js, Express |
| **Messaging** | HiveMQ Cloud (MQTT broker over TLS) via the `mqtt` npm client |
| **Database** | Firebase Realtime Database (`firebase-admin`) |
| **Alerting** | Telegram Bot API (long-polling) |
| **Process management** | pm2 (recommended for the bridge) |
| **Other** | `express-rate-limit` (admin route throttling), `dotenv`, Basic Auth |

---

## How It Works

```
Supervised floor mat (beside bed)
        │
ESP32-C5 firmware (main.cpp)
        │ MQTT over TLS
HiveMQ Cloud (broker)
        │
bridge.js (Node.js, runs under pm2)
        │
   ├── Firebase Realtime Database (status + label mirror)
   └── Telegram Bot API (caregiver + supervisor alerts)

Admin browser ── HTTPS + Basic Auth ──> bridge.js "Bed Devices" dashboard
```

A resident stepping onto the mat publishes `STEPPED_ON_MAT`. The bridge sends a Telegram alert; if nobody acknowledges within `ESCALATION_DELAY_MS`, it escalates to the supervisor chat.

### Device Identity vs. Bed Label

Every device publishes and is tracked under a **`device_id`** — a 12-character hex string derived from the ESP32's factory-programmed eFuse MAC. It's computed fresh every boot, never written to flash, and therefore can't be changed by a rename *or* a factory reset. All MQTT topics (`bed/{device_id}/exit|status|cmd|label`) and Firebase paths (`beds/{device_id}`) are keyed off this.

The **Bed Label** (what a caregiver actually sees — e.g. "Room 4 - Bed 1") is just a display string, published separately, retained, on `bed/{device_id}/label`. It can be changed two ways, and the device is always the single source of truth for it:
- physically, via the device's own setup portal, or
- remotely, via the dashboard's **Rename** button, which sends a `SET_LABEL` command — this only takes effect if the device is currently online, since nothing routes around the device itself owning its own label.

This split is what lets a bed be renamed — or a device be re-provisioned for a different bed after a factory reset — without ever orphaning its alert/escalation history.

### Remote commands (`bed/{device_id}/cmd`)

Only reachable while the device already has connectivity — none of these help if its WiFi is fully down; that still needs physical access to the config button.

| Command | Effect |
|---|---|
| `OPEN_PORTAL` | Reboot into the setup portal without erasing WiFi |
| `FORCE_RECONNECT` | Drop WiFi to force an immediate retry |
| `SET_BACKUP_WIFI:ssid:password` | Save + register a new backup network live, no reboot |
| `SET_LABEL:newlabel` | Save + republish the Bed Label live, no reboot |
| `FACTORY_RESET` | Erase saved WiFi + Bed Label + backup WiFi, reboot into the setup portal as if freshly flashed (irreversible; `device_id` itself survives, since it's hardware-derived, not stored) |

### "Bed Devices" admin dashboard (`GET /admin`)

Lists every device that's ever reported, each with buttons for Rename, Open Portal, Force Reconnect, Set Backup WiFi, and Delete. **Delete** sends `FACTORY_RESET` (best-effort — only lands if the device is online) and clears the bed's Firebase record, in-memory bridge state, *and* the device's retained MQTT status/label messages, so a deleted bed can't reappear on a later bridge restart via a stale retained-message redelivery.

---

## Prerequisites

- **Node.js** v18+ and npm
- **PlatformIO** (CLI or the VS Code extension), with the **pioarduino** community platform fork — the official `espressif32` platform doesn't yet support the ESP32-C5
- An **ESP32-C5 DevKitC-1** board (or adjust `platformio.ini` for your board)
- A **HiveMQ Cloud** cluster (or any MQTT broker reachable over TLS)
- A **Firebase** project with Realtime Database enabled, plus a service account key
- A **Telegram bot** (via [@BotFather](https://t.me/BotFather)) and two chat IDs: one for the caregiver group, one for supervisor escalations

---

## Installation & Quick Start

### Firmware

```bash
cd bed-exit-firmware
```

Create `src/secrets.h` (gitignored, never commit this):

```cpp
#pragma once
#define MQTT_HOST "your-cluster-id.s1.eu.hivemq.cloud"
#define MQTT_PORT 8883
const char* MQTT_USER = "your-mqtt-username";
const char* MQTT_PASS = "your-mqtt-password";
```

Flash the board:

```bash
pio run --target upload --target monitor
```

On first boot (or after a factory reset), the device opens a `BedAlert-Setup` WiFi access point — connect to it to set the WiFi network and initial Bed Label. To reopen the portal on an already-provisioned board without erasing WiFi, hold the config button (wired to `CONFIG_BTN_PIN`) at boot, or send it an `OPEN_PORTAL` command from the dashboard.

### Bridge

```bash
cd bed-exit-backend
npm install
```

Create `.env` (gitignored, never commit this) — see [Environment Configuration](#️-environment-configuration) below for the full key list.

Place your Firebase service-account key JSON file in `bed-exit-backend/`, named to match whatever `firebase.js` requires it as.

Run it:

```bash
npm run dev      # nodemon, for local development
npm start         # plain node, for production
pm2 start bridge.js --name bexit-bridge   # recommended for a long-running deployment
```

Then visit `http://<bridge-host>:<PORT>/admin` to open the Bed Devices dashboard (HTTP Basic Auth via `ADMIN_USER`/`ADMIN_PASS`).

---

## Environment Configuration

All of the following are **required** — the bridge fails fast on startup if any are missing.

| Key | Description | Example |
|---|---|---|
| `PORT` | HTTP port for the bridge's Express server (health check + admin dashboard) | `3000` |
| `MQTT_HOST` | HiveMQ Cloud (or other broker) hostname | `xxxx.s1.eu.hivemq.cloud` |
| `MQTT_PORT` | Broker TLS port | `8883` |
| `MQTT_USER` / `MQTT_PASS` | Broker credentials | — |
| `FIREBASE_DATABASE_URL` | Realtime Database URL | `https://your-project-default-rtdb.firebaseio.com` |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | — |
| `TELEGRAM_CHAT_ID` | Caregiver group chat ID — receives alerts + Ack buttons | — |
| `SUPERVISOR_CHAT_ID` | Supervisor chat ID — receives escalations only, no buttons | — |
| `ESCALATION_DELAY_MS` | How long an alert can go unacknowledged before escalating | `120000` (2 min) |
| `PAUSE_DURATION_MS` | How long "Ack & Pause" silences further alerts for that bed | `1800000` (30 min) |
| `ADMIN_USER` / `ADMIN_PASS` | Basic Auth credentials for the `/admin` dashboard | — |

---

## Hardware

- ESP32-C5 DevKitC-1 (dual 2.4 GHz / 5 GHz WiFi)
- RS PRO Pressure Mat Surface, 250 mA, 25 V DC
- Supervised sensor circuit: external R1 pull-up + R2 end-of-line resistor, for open-loop/wiring-fault detection (not just presence/absence)

---

## Known Issues / Design Notes

- **QoS 1 is subscribe-only.** `PubSubClient` (the firmware's MQTT library) doesn't support true QoS 1 on publish — only QoS 0. The bridge subscribes at QoS 1, which only guarantees the broker→bridge hop, not device→broker. A real fix means swapping to a QoS-1-capable client library (e.g. `AsyncMqttClient`) — a known, deliberate open item.
- **No HiveMQ ACL on the command topic yet.** Anyone with valid broker credentials could currently publish to any device's `bed/{id}/cmd` topic directly. The `/admin` dashboard and its HTTP endpoints are protected by Basic Auth, but the underlying MQTT topic itself isn't yet restricted — HiveMQ Cloud's free tier only allows one topic filter per credential set, so a full fix needs either a paid tier or a credential-splitting workaround.
- **No hardware failsafe for simultaneous WiFi + power loss during an exit event**, by design — a standalone battery-powered local alarm was considered and deliberately rejected as the wrong fit for assisted living (dignity/privacy prioritized over last-line-of-defense redundancy in a low-acuity setting). Accepted residual risk, covered operationally by routine staff check-ins.
- **Alert-clearing is caregiver-driven, not sensor-driven, by design.** A single floor mat can't distinguish "resident returned to bed" from "resident is elsewhere." `OFF_MAT` never auto-clears an active exit alert.
- **`SENSOR_FAULT` / `OFFLINE` reuse the same escalation delay tier as a bed exit** — still an open question for stakeholder sign-off on whether these need their own delay.
- **Telegram as the caregiver notification channel** — its suitability for a care-facility deployment from a compliance standpoint (e.g. IEC 60601) is flagged but not yet reviewed; needs stakeholder input before any production deployment.
- **Renaming a bed only takes effect while the device is online**, by design — see [Device Identity vs. Bed Label](#-device-identity-vs-bed-label) for why the dashboard doesn't write labels directly.

---

## Contributing

1. Fork the repo and create a feature branch off `main`.
2. Keep firmware and bridge changes in their respective directories (`bed-exit-firmware/`, `bed-exit-backend/`) and update this README if you change setup steps, env vars, or the MQTT topic/command contract between them.
3. Run `npm run lint` in `bed-exit-backend/` before committing.
4. Open a PR with a clear description of what changed and why — for anything touching alerting/escalation logic, include the failure scenario you're addressing.
