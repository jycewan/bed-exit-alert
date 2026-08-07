require('dotenv').config();

const mqtt = require('mqtt');
const fetch = require('node-fetch');
const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const serviceAccount = require('./bexit-service-account-key.json');

// Environment / config — all values come from .env, nothing hardcoded.
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

const escalationDelayMs = Number(ESCALATION_DELAY_MS);
const pauseDurationMs = Number(PAUSE_DURATION_MS);

// Firebase
const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});
const db = getDatabase(firebaseApp);


// Per-bed state
//   pausedBeds:        bedId -> pause-expiry timestamp
//   escalationTimers:  "bedId:type" -> setTimeout handle (cleared on ack)
//   faultState:        bedId -> true while a SENSOR_FAULT is unresolved (cleared on next IDLE/OFF_MAT)
// Using "bedId:type" keys means a bed-exit escalation and a sensor-fault
// escalation for the SAME bed don't cancel each other out.
const pausedBeds = new Map();
const escalationTimers = new Map();
const faultState = new Map();
// "bedId:kind" -> Telegram message_id of the last Ack/Clear alert sent for
// that bed+kind, so a self-resolving event (device comes back ONLINE, mat
// fault clears on its own) can edit that same message instead of leaving
// its button dangling on an alert that's no longer true.
const sentAlertMessages = new Map();

// MQTT
const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  clientId: 'bridge-node-' + Math.floor(Math.random() * 10000),
  username: MQTT_USER,
  password: MQTT_PASS,
  rejectUnauthorized: false
});

client.on('connect', () => {
  console.log('✅ Bridge connected to HiveMQ Cloud!');
  // QoS 1: broker holds the message and retries delivery to us until we
  // ack it, instead of a fire-and-forget QoS 0 drop. This only guarantees
  // the broker->bridge hop - see the QoS note near the top of main.cpp for
  // why the device->broker hop (PubSubClient) can't make the same promise.
  client.subscribe('bed/+/exit', { qos: 1 }, (err) => {
    if (!err) console.log('📡 Listening for Bed Exit events on [bed/+/exit] (QoS 1)...');
    else console.error('Subscribe error:', err);
  });
  client.subscribe('bed/+/status', { qos: 1 }, (err) => {
    if (!err) console.log('📡 Listening for device status (LWT ONLINE/OFFLINE) on [bed/+/status] (QoS 1)...');
    else console.error('Subscribe error:', err);
  });
});

client.on('error', (err) => {
  console.error('❌ MQTT connection error:', err);
});

client.on('message', async (topic, message) => {
  const payload = message.toString().trim();
  const parts = topic.split('/'); // ['bed', bedId, 'exit' | 'status']
  const bedId = parts[1];
  const topicType = parts[2];

  console.log(`🚨 Event received on [${topic}]: ${payload}`);

  if (topicType === 'exit') {
    await handleExitTopic(bedId, payload);
  } else if (topicType === 'status') {
    await handleStatusTopic(bedId, payload);
  }
});

async function handleExitTopic(bedId, payload) {
  if (payload === 'STEPPED_ON_MAT' || payload === 'BED_EXIT') {
    // Respect an active pause window for this bed
    if (pausedBeds.has(bedId)) {
      const expiry = pausedBeds.get(bedId);
      if (Date.now() < expiry) {
        console.log(`⏳ Alert for Bed ${bedId} ignored (Paused)`);
        return;
      }
      pausedBeds.delete(bedId);
      clearPersistedPausedBed(bedId);
    }

    startEscalationTimer(bedId, 'exit',
      `⚠️ ESCALATION: bed exit alert for bed ${bedId} was not acknowledged in time`);

    await writeBedStatus(bedId, 'ALERT');

    const alertText = `bed exit alert resident on bed ${bedId} stepped on mat`;
    console.log(`📲 Sending Telegram alert for Bed ${bedId}...`);
    await sendAlertWithButtons(bedId, alertText, 'exit');

  } else if (payload === 'OFF_MAT') {
    // Coming back to OFF_MAT also clears any lingering fault state for this bed
    const hadFault = faultState.get(bedId);
    faultState.delete(bedId);
    clearEscalationTimer(bedId, 'fault');
    if (hadFault) {
      await autoResolveAlert(bedId, 'fault', `✅ sensor fault on bed ${bedId} cleared automatically (mat reporting normally again)`);
    }

    await writeBedStatus(bedId, 'IDLE');
    // No Telegram message here on purpose - OFF_MAT isn't actionable on its
    // own (nothing to ack, no button), it was just chat noise. The RTDB
    // write above still records it for anyone checking bed history/status.
    console.log(`ℹ️ Bed ${bedId} off mat, status reset to IDLE`);

  } else if (payload === 'SENSOR_FAULT') {
    // Only alert on the transition into fault, not on every repeated publish
    if (!faultState.get(bedId)) {
      faultState.set(bedId, true);

      // TODO(George): confirm fault should escalate on the same
      // ESCALATION_DELAY_MS tier as a bed exit, or needs its own delay.
      startEscalationTimer(bedId, 'fault',
        `⚠️ ESCALATION: sensor fault on bed ${bedId} was not acknowledged in time`);

      await writeBedStatus(bedId, 'FAULT');

      const faultText = `⚠️ sensor fault on bed ${bedId} — check wiring / EOL resistor connection`;
      console.log(`📲 Sending Telegram fault alert for Bed ${bedId}...`);
      await sendAlertWithButtons(bedId, faultText, 'fault');
    }
  }
}

async function handleStatusTopic(bedId, payload) {
  if (payload === 'OFFLINE') {
    // TODO(George): confirm OFFLINE should escalate on the same
    // ESCALATION_DELAY_MS tier as a bed exit, or needs its own delay.
    startEscalationTimer(bedId, 'offline',
      `⚠️ ESCALATION: bed ${bedId} device offline was not acknowledged`);

    await writeBedStatus(bedId, 'OFFLINE');

    const offlineText = `🔌 bed ${bedId} device is OFFLINE`;
    console.log(`📲 Sending Telegram offline alert for Bed ${bedId}...`);
    // Ack & Clear button so this stops re-escalating once seen. Acking
    // only silences the alert — it does NOT mean the device is back;
    // that's still driven by the device's own ONLINE message.
    await sendAlertWithButtons(bedId, offlineText, 'offline');

  } else if (payload === 'ONLINE') {
    clearEscalationTimer(bedId, 'offline');
    await autoResolveAlert(bedId, 'offline', `✅ bed ${bedId} device is back online (auto-cleared)`);

    const recoveryText = `✅ bed ${bedId} device is back online`;
    console.log(`ℹ️ Sending back-online update for Bed ${bedId}...`);
    await sendSimpleMessage(recoveryText);
  }
}

// Escalation — if nobody acks within ESCALATION_DELAY_MS, notify supervisor.
// "type" keeps exit / fault / offline escalations independent per bed.
// remainingMs/startedAt are only passed by restoreStateFromFirebase() when
// re-arming a timer after a restart - normal calls just use the defaults.
function startEscalationTimer(bedId, type, escalationText, remainingMs = escalationDelayMs, startedAt = Date.now()) {
  const key = `${bedId}:${type}`;
  if (escalationTimers.has(key)) return; // already pending, don't stack a duplicate

  persistEscalationTimer(bedId, type, escalationText, startedAt);

  const timer = setTimeout(async () => {
    escalationTimers.delete(key);
    await clearPersistedEscalationTimer(bedId, type);
    console.log(`🆘 No ack for Bed ${bedId} (${type}) within ${escalationDelayMs}ms — escalating to supervisor`);

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: SUPERVISOR_CHAT_ID, text: escalationText })
    });
    const data = await res.json();
    if (!data.ok) console.error('❌ Escalation send failed:', data.description);
    else console.log('✅ Escalation sent to supervisor');
  }, remainingMs);

  escalationTimers.set(key, timer);
}

function clearEscalationTimer(bedId, type) {
  const key = `${bedId}:${type}`;
  if (escalationTimers.has(key)) {
    clearTimeout(escalationTimers.get(key));
    escalationTimers.delete(key);
  }
  clearPersistedEscalationTimer(bedId, type); // idempotent no-op if nothing was persisted
}

// Firebase RTDB write
async function writeBedStatus(bedId, state) {
  try {
    await db.ref(`beds/${bedId}/status`).set({ state, timestamp: Date.now() });
  } catch (err) {
    console.error(`❌ RTDB write failed for bed ${bedId}:`, err);
  }
}

// Crash-safety: mirror pausedBeds/escalationTimers to Firebase so a pm2
// restart (crash, redeploy, server reboot) doesn't silently drop an active
// pause window or an in-flight escalation countdown. Every set/delete on
// the in-memory Maps below is paired with one of these.
async function persistPausedBed(bedId, expiry) {
  try {
    await db.ref(`bridge/pausedBeds/${bedId}`).set({ expiry });
  } catch (err) {
    console.error(`❌ Failed to persist pause for bed ${bedId}:`, err);
  }
}

async function clearPersistedPausedBed(bedId) {
  try {
    await db.ref(`bridge/pausedBeds/${bedId}`).remove();
  } catch (err) {
    console.error(`❌ Failed to clear persisted pause for bed ${bedId}:`, err);
  }
}

async function persistEscalationTimer(bedId, type, text, startedAt) {
  try {
    await db.ref(`bridge/escalationTimers/${bedId}_${type}`).set({ text, startedAt, delayMs: escalationDelayMs });
  } catch (err) {
    console.error(`❌ Failed to persist escalation timer for bed ${bedId} (${type}):`, err);
  }
}

async function clearPersistedEscalationTimer(bedId, type) {
  try {
    await db.ref(`bridge/escalationTimers/${bedId}_${type}`).remove();
  } catch (err) {
    console.error(`❌ Failed to clear persisted escalation timer for bed ${bedId} (${type}):`, err);
  }
}

async function persistSentAlertMessage(bedId, kind, messageId) {
  try {
    await db.ref(`bridge/sentAlertMessages/${bedId}_${kind}`).set({ messageId });
  } catch (err) {
    console.error(`❌ Failed to persist alert message id for bed ${bedId} (${kind}):`, err);
  }
}

async function clearPersistedSentAlertMessage(bedId, kind) {
  try {
    await db.ref(`bridge/sentAlertMessages/${bedId}_${kind}`).remove();
  } catch (err) {
    console.error(`❌ Failed to clear persisted alert message id for bed ${bedId} (${kind}):`, err);
  }
}

// Run once at startup, before MQTT/Telegram start flowing, to rebuild the
// in-memory Maps from whatever was mid-flight when the process last exited.
async function restoreStateFromFirebase() {
  try {
    const snap = await db.ref('bridge/pausedBeds').get();
    if (snap.exists()) {
      const now = Date.now();
      for (const [bedId, entry] of Object.entries(snap.val())) {
        if (entry.expiry > now) {
          pausedBeds.set(bedId, entry.expiry);
          console.log(`♻️ Restored pause for bed ${bedId} (${Math.round((entry.expiry - now) / 1000)}s remaining)`);
        } else {
          await clearPersistedPausedBed(bedId); // stale entry, clean it up
        }
      }
    }
  } catch (err) {
    console.error('❌ Failed to restore pausedBeds from Firebase:', err);
  }

  try {
    const snap = await db.ref('bridge/escalationTimers').get();
    if (snap.exists()) {
      const now = Date.now();
      for (const [key, entry] of Object.entries(snap.val())) {
        const idx = key.lastIndexOf('_');
        const bedId = key.slice(0, idx);
        const type = key.slice(idx + 1);
        const deadline = entry.startedAt + (entry.delayMs || escalationDelayMs);
        const remaining = deadline - now;

        if (remaining <= 0) {
          // Deadline already passed while the bridge was down - fire it now
          // instead of silently dropping a real overdue escalation.
          console.log(`🆘 Restored escalation for bed ${bedId} (${type}) was already overdue - firing now`);
          await clearPersistedEscalationTimer(bedId, type);
          const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: SUPERVISOR_CHAT_ID, text: entry.text })
          });
          const resData = await res.json();
          if (!resData.ok) console.error('❌ Overdue escalation send failed:', resData.description);
        } else {
          startEscalationTimer(bedId, type, entry.text, remaining, entry.startedAt);
          console.log(`♻️ Restored escalation timer for bed ${bedId} (${type}), firing in ${Math.round(remaining / 1000)}s`);
        }
      }
    }
  } catch (err) {
    console.error('❌ Failed to restore escalationTimers from Firebase:', err);
  }

  try {
    const snap = await db.ref('bridge/sentAlertMessages').get();
    if (snap.exists()) {
      for (const [key, entry] of Object.entries(snap.val())) {
        const idx = key.lastIndexOf('_');
        const bedId = key.slice(0, idx);
        const kind = key.slice(idx + 1);
        sentAlertMessages.set(`${bedId}:${kind}`, entry.messageId);
        console.log(`♻️ Restored trackable alert message for bed ${bedId} (${kind})`);
      }
    }
  } catch (err) {
    console.error('❌ Failed to restore sentAlertMessages from Firebase:', err);
  }
}

// Telegram helpers
async function sendAlertWithButtons(bedId, messageText, kind = 'exit') {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const pauseMinutesLabel = Math.round(pauseDurationMs / 60000);

  // Fault and offline alerts are "something is broken", not "normal
  // movement" — pausing would silence a real problem, so only offer
  // Ack & Clear for those. Only a real bed-exit gets the pause option.
  const buttons = (kind === 'fault' || kind === 'offline')
    ? [{ text: 'Ack & Clear', callback_data: `clear_${bedId}_${kind}` }]
    : [
        { text: `⏸️ Ack & Pause (${pauseMinutesLabel}m)`, callback_data: `pause_${bedId}_exit` },
        { text: 'Ack & Clear',                              callback_data: `clear_${bedId}_exit` }
      ];

  const keyboard = { inline_keyboard: [buttons] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: messageText, reply_markup: keyboard })
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('❌ Telegram send failed:', data.description);
  } else {
    console.log('✅ Telegram alert sent');
    sentAlertMessages.set(`${bedId}:${kind}`, data.result.message_id);
    persistSentAlertMessage(bedId, kind, data.result.message_id);
  }
}

// Edits a previously-sent Ack/Clear alert in place when the situation
// resolves ON ITS OWN (device reconnects, fault clears) rather than via a
// caregiver tapping a button — otherwise that message sits forever showing
// a live button for a problem that's already gone. No-op if there's no
// tracked message for this bed+kind (e.g. bridge restarted since it sent,
// or it was already resolved via a manual ack).
async function autoResolveAlert(bedId, kind, resolutionText) {
  const key = `${bedId}:${kind}`;
  const messageId = sentAlertMessages.get(key);
  if (!messageId) return;
  sentAlertMessages.delete(key);
  await clearPersistedSentAlertMessage(bedId, kind);

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, text: resolutionText })
  });
  // Separate call to drop the reply_markup (editMessageText can't touch it) -
  // removes the now-stale Ack/Clear button so nobody taps it after the fact.
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  });
}

async function sendSimpleMessage(messageText) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: messageText })
  });
  const data = await res.json();
  if (!data.ok) console.error('❌ Telegram send failed:', data.description);
}

// Telegram long-polling for button clicks (Ack & Pause / Ack & Clear)
let offset = 0;
async function pollTelegramUpdates() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`
    );
    const data = await res.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
    }
  } catch (err) {
    console.error('Polling error:', err.message);
  }
  setTimeout(pollTelegramUpdates, 1000);
}

async function handleCallbackQuery(query) {
  const data = query.data; // e.g. "pause_101_exit" or "clear_101_fault"
  const user = query.from.first_name || query.from.username || 'Caregiver';
  const messageId = query.message.message_id;
  const chatId = query.message.chat.id;
  const [action, bedId, kind] = data.split('_');

  // Any ack — pause or clear — cancels the pending supervisor escalation
  // for THAT alert type only (an exit ack shouldn't silence a pending fault escalation).
  clearEscalationTimer(bedId, kind);
  sentAlertMessages.delete(`${bedId}:${kind}`); // manually acked - nothing left to auto-resolve later
  clearPersistedSentAlertMessage(bedId, kind);
  if (kind === 'fault') faultState.delete(bedId);

  let popupText = '';
  let updatedMessage = '';
  const pauseMinutesLabel = Math.round(pauseDurationMs / 60000);
  const label = kind === 'fault' ? 'sensor fault' : kind === 'offline' ? 'device offline' : 'bed exit alert';

  if (action === 'pause') {
    const expiry = Date.now() + pauseDurationMs;
    pausedBeds.set(bedId, expiry);
    await persistPausedBed(bedId, expiry);
    popupText = `Alert acknowledged. Bed ${bedId} paused for ${pauseMinutesLabel} minutes.`;
    updatedMessage = `acknowledged ${label} for bed ${bedId} by ${user} (paused ${pauseMinutesLabel}m) at ${new Date().toLocaleTimeString()}`;
  } else if (action === 'clear') {
    pausedBeds.delete(bedId);
    await clearPersistedPausedBed(bedId);
    popupText = `Alert acknowledged and cleared for Bed ${bedId}.`;
    updatedMessage = `acknowledged ${label} for bed ${bedId} by ${user} at ${new Date().toLocaleTimeString()}`;
  }

  // An offline ack only silences the alert — it must NOT stamp the bed
  // as IDLE while the device is still unreachable; that would overwrite
  // the real OFFLINE status until the device's own ONLINE message arrives.
  if (kind !== 'offline') {
    await writeBedStatus(bedId, 'IDLE');
  }

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: query.id, text: popupText, show_alert: true })
  });

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: updatedMessage })
  });
}

pollTelegramUpdates();

// Express — health check / manual status endpoint
const app = express();
app.use(express.json());

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    mqttConnected: client.connected,
    pausedBeds: Object.fromEntries(pausedBeds),
    pendingEscalations: [...escalationTimers.keys()]
  });
});

// Basic auth gate for anything admin-facing (the dashboard + the command
// endpoint it drives). Browsers cache the credentials per-origin after the
// first prompt, so the dashboard's own fetch() calls to /bed/:id/cmd go
// through without a second login. This closes the "no auth at all" gap
// flagged earlier on /bed/:id/cmd - the missing HiveMQ ACL on the
// underlying MQTT topic is still a separate, unaddressed gap (see note
// below on that route).
function requireAdminAuth(req, res, next) {
  const auth = { login: ADMIN_USER, password: ADMIN_PASS };
  const b64 = (req.headers.authorization || '').split(' ')[1] || '';
  const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
  if (user === auth.login && pass === auth.password) return next();
  res.set('WWW-Authenticate', 'Basic realm="bexit-admin"');
  res.status(401).send('Authentication required');
}

// Admin dashboard - one page listing every bed that has ever reported
// status, each with buttons for OPEN_PORTAL / FORCE_RECONNECT / set backup
// WiFi. Pulls the bed list straight from Firebase (beds/*), so any device
// that has ever published shows up automatically - nothing to hardcode
// when you add a second (or Nth) ESP32.
app.get('/admin', requireAdminAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bexit admin</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 24px auto; padding: 0 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
  button { margin-right: 4px; padding: 4px 8px; }
  input { padding: 4px; margin-right: 4px; }
  .status-ALERT { color: #c00; font-weight: bold; }
  .status-FAULT { color: #c60; font-weight: bold; }
  .status-OFFLINE { color: #888; font-weight: bold; }
  .status-IDLE { color: #2a2; }
</style>
</head>
<body>
<h2>bexit — bed devices</h2>
<table id="beds"><thead><tr><th>Bed ID</th><th>Status</th><th>Last update</th><th>Actions</th></tr></thead><tbody></tbody></table>

<script>
async function loadBeds() {
  const res = await fetch('/admin/api/beds');
  const beds = await res.json();
  const tbody = document.querySelector('#beds tbody');
  tbody.innerHTML = '';
  for (const bed of beds) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${bed.id}</td>
      <td class="status-\${bed.state}">\${bed.state}</td>
      <td>\${new Date(bed.timestamp).toLocaleString()}</td>
      <td>
        <button onclick="sendCmd('\${bed.id}','OPEN_PORTAL')">Open Portal</button>
        <button onclick="sendCmd('\${bed.id}','FORCE_RECONNECT')">Reconnect</button>
        <br>
        <input placeholder="backup SSID" id="ssid-\${bed.id}" size="12">
        <input placeholder="password" id="pass-\${bed.id}" type="password" size="10">
        <button onclick="setBackupWifi('\${bed.id}')">Set Backup WiFi</button>
        <br>
        <button onclick="deleteBed('\${bed.id}')" style="color:#c00;margin-top:4px">Delete (factory reset)</button>
      </td>\`;
    tbody.appendChild(tr);
  }
}

async function sendCmd(bedId, command) {
  await fetch(\`/bed/\${bedId}/cmd\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command })
  });
  alert(command + ' sent to bed ' + bedId);
}

async function deleteBed(bedId) {
  const confirmed = confirm(
    'Delete bed ' + bedId + '?\\n\\n' +
    'This sends FACTORY_RESET to the device (wipes its saved WiFi + Bed ID - ' +
    'it will need to be re-provisioned via its boot portal) and removes it ' +
    'from this dashboard.\\n\\nThis cannot be undone. Continue?'
  );
  if (!confirmed) return;

  await fetch(\`/bed/\${bedId}\`, { method: 'DELETE' });
  alert('Bed ' + bedId + ' deleted');
  loadBeds();
}

async function setBackupWifi(bedId) {
  const ssid = document.getElementById('ssid-' + bedId).value;
  const password = document.getElementById('pass-' + bedId).value;
  if (!ssid || !password) { alert('Enter both SSID and password'); return; }
  await fetch(\`/bed/\${bedId}/cmd\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'SET_BACKUP_WIFI', ssid, password })
  });
  alert('Backup WiFi sent to bed ' + bedId);
}

loadBeds();
setInterval(loadBeds, 10000); // refresh every 10s so status/offline changes show up without a manual reload
</script>
</body>
</html>`);
});

// Bed list backing the dashboard - reads straight from beds/* in Firebase,
// which writeBedStatus() already keeps current for every bed that has ever
// published an event.
app.get('/admin/api/beds', requireAdminAuth, async (req, res) => {
  try {
    const snap = await db.ref('beds').get();
    const beds = snap.exists()
      ? Object.entries(snap.val()).map(([id, data]) => ({ id, ...data }))
      : [];
    res.json(beds);
  } catch (err) {
    console.error('❌ Failed to read beds from Firebase:', err);
    res.status(500).json({ error: 'Failed to load beds' });
  }
});

// Lets a supervisor trigger a remote command on a bed device from any
// device with network access (not just physical presence at the ESP32) -
// as long as the target device is already online. See the command handling
// notes in main.cpp's handleRemoteCommand() for what each command does and
// its limits (nothing here helps if the device's WiFi is fully down).
//   POST /bed/101/cmd  { "command": "OPEN_PORTAL" }
//   POST /bed/101/cmd  { "command": "FORCE_RECONNECT" }
//   POST /bed/101/cmd  { "command": "SET_BACKUP_WIFI", "ssid": "...", "password": "..." }
//
// Protected by the same admin basic auth as the dashboard above. Still
// open: the underlying MQTT command topic itself has no HiveMQ ACL, so
// anyone with valid broker credentials (not just this endpoint) could
// still publish to it directly - see the earlier HiveMQ ACL note.
app.post('/bed/:id/cmd', requireAdminAuth, (req, res) => {
  const bedId = req.params.id;
  const { command, ssid, password } = req.body || {};

  let payload;
  if (command === 'OPEN_PORTAL' || command === 'FORCE_RECONNECT' || command === 'FACTORY_RESET') {
    payload = command;
  } else if (command === 'SET_BACKUP_WIFI') {
    if (!ssid || !password) {
      return res.status(400).json({ ok: false, error: 'SET_BACKUP_WIFI requires both ssid and password' });
    }
    payload = `SET_BACKUP_WIFI:${ssid}:${password}`;
  } else {
    return res.status(400).json({ ok: false, error: `Unknown command: ${command}` });
  }

  client.publish(`bed/${bedId}/cmd`, payload, { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ Failed to publish command to bed ${bedId}:`, err);
      return res.status(502).json({ ok: false, error: 'Publish failed' });
    }
    console.log(`📤 Sent command "${command}" to bed ${bedId}`);
    res.json({ ok: true, bedId, command });
  });
});

// Deletes a bed from the dashboard. Sends FACTORY_RESET to the device
// first (best-effort - if it's offline, the command has nowhere to land,
// but the cleanup below still happens; the device just keeps its old
// config until someone physically re-provisions it later, same as before
// this endpoint existed) then wipes every trace of the bed from Firebase
// and the in-memory Maps, so it disappears from the dashboard list.
app.delete('/bed/:id', requireAdminAuth, async (req, res) => {
  const bedId = req.params.id;

  client.publish(`bed/${bedId}/cmd`, 'FACTORY_RESET', { qos: 1 });

  pausedBeds.delete(bedId);
  faultState.delete(bedId);
  for (const type of ['exit', 'fault', 'offline']) {
    clearEscalationTimer(bedId, type); // also clears its Firebase mirror
    sentAlertMessages.delete(`${bedId}:${type}`);
    clearPersistedSentAlertMessage(bedId, type);
  }
  clearPersistedPausedBed(bedId);

  try {
    await db.ref(`beds/${bedId}`).remove();
    console.log(`🗑️ Deleted bed ${bedId} (factory-reset command sent + Firebase record removed)`);
    res.json({ ok: true, bedId });
  } catch (err) {
    console.error(`❌ Failed to delete Firebase record for bed ${bedId}:`, err);
    res.status(500).json({ ok: false, error: 'Failed to delete bed record' });
  }
});

app.listen(PORT, () => {
  console.log(`🖥️  Bridge HTTP server listening on http://localhost:${PORT}`);
});

// Rebuild pausedBeds/escalationTimers from Firebase before anything else
// starts acting on live MQTT traffic - best-effort, runs in parallel with
// the MQTT connection above rather than blocking startup on it.
restoreStateFromFirebase();