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
  PAUSE_DURATION_MS
} = process.env;

// Fail loudly on startup if anything required is missing.
const required = {
  PORT, MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS,
  FIREBASE_DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  SUPERVISOR_CHAT_ID, ESCALATION_DELAY_MS, PAUSE_DURATION_MS
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
//   pausedBeds:     bedId -> pause-expiry timestamp
//   escalationTimers: bedId -> setTimeout handle (cleared on any ack)
const pausedBeds = new Map();
const escalationTimers = new Map();

// MQTT
const client = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
  clientId: 'bridge-node-' + Math.floor(Math.random() * 10000),
  username: MQTT_USER,
  password: MQTT_PASS,
  rejectUnauthorized: false
});

client.on('connect', () => {
  console.log('✅ Bridge connected to HiveMQ Cloud!');
  client.subscribe('bed/+/exit', (err) => {
    if (!err) console.log('📡 Listening for Bed Exit events on [bed/+/exit]...');
    else console.error('Subscribe error:', err);
  });
});

client.on('error', (err) => {
  console.error('❌ MQTT connection error:', err);
});

client.on('message', async (topic, message) => {
  const payload = message.toString().trim();
  const bedId = topic.split('/')[1]; // e.g. '101' from 'bed/101/exit'

  console.log(`🚨 Event received on [${topic}]: ${payload}`);

  if (payload === 'STEPPED_ON_MAT' || payload === 'BED_EXIT') {
    // Respect an active pause window for this bed
    if (pausedBeds.has(bedId)) {
      const expiry = pausedBeds.get(bedId);
      if (Date.now() < expiry) {
        console.log(`⏳ Alert for Bed ${bedId} ignored (Paused)`);
        return;
      }
      pausedBeds.delete(bedId);
    }

    // Don't stack a new escalation timer if one's already pending for this bed
    if (!escalationTimers.has(bedId)) {
      startEscalationTimer(bedId);
    }

    await writeBedStatus(bedId, 'ALERT');

    const alertText = `bed exit alert resident on bed ${bedId} stepped on mat`;
    console.log(`📲 Sending Telegram alert for Bed ${bedId}...`);
    await sendAlertWithButtons(bedId, alertText);

  } else if (payload === 'OFF_MAT') {
    await writeBedStatus(bedId, 'IDLE');

    const statusText = `off mat status reset idle for bed ${bedId}`;
    console.log(`ℹ️ Sending off-mat status update for Bed ${bedId}...`);
    await sendSimpleMessage(statusText);
  }
});

// Escalation — if nobody acks within ESCALATION_DELAY_MS, notify supervisor
function startEscalationTimer(bedId) {
  const timer = setTimeout(async () => {
    escalationTimers.delete(bedId);
    console.log(`🆘 No ack for Bed ${bedId} within ${escalationDelayMs}ms — escalating to supervisor`);

    const escalationText = `⚠️ ESCALATION: bed exit alert for bed ${bedId} was not acknowledged in time`;
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: SUPERVISOR_CHAT_ID, text: escalationText })
    });
    const data = await res.json();
    if (!data.ok) console.error('❌ Escalation send failed:', data.description);
    else console.log('✅ Escalation sent to supervisor');
  }, escalationDelayMs);

  escalationTimers.set(bedId, timer);
}

function clearEscalationTimer(bedId) {
  if (escalationTimers.has(bedId)) {
    clearTimeout(escalationTimers.get(bedId));
    escalationTimers.delete(bedId);
  }
}

// Firebase RTDB write
async function writeBedStatus(bedId, state) {
  try {
    await db.ref(`beds/${bedId}/status`).set({ state, timestamp: Date.now() });
  } catch (err) {
    console.error(`❌ RTDB write failed for bed ${bedId}:`, err);
  }
}

// Telegram helpers
async function sendAlertWithButtons(bedId, messageText) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const pauseMinutesLabel = Math.round(pauseDurationMs / 60000);
  const keyboard = {
    inline_keyboard: [[
      { text: `⏸️ Ack & Pause (${pauseMinutesLabel}m)`, callback_data: `pause_${bedId}` },
      { text: 'Ack & Clear',                              callback_data: `clear_${bedId}` }
    ]]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: messageText, reply_markup: keyboard })
  });
  const data = await res.json();
  if (!data.ok) console.error('❌ Telegram send failed:', data.description);
  else console.log('✅ Telegram alert sent');
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
  const data = query.data; // e.g. "pause_101" or "clear_101"
  const user = query.from.first_name || query.from.username || 'Caregiver';
  const messageId = query.message.message_id;
  const chatId = query.message.chat.id;
  const [action, bedId] = data.split('_');

  // Any ack — pause or clear — cancels the pending supervisor escalation
  clearEscalationTimer(bedId);

  let popupText = '';
  let updatedMessage = '';
  const pauseMinutesLabel = Math.round(pauseDurationMs / 60000);

  if (action === 'pause') {
    pausedBeds.set(bedId, Date.now() + pauseDurationMs);
    popupText = `Alert acknowledged. Bed ${bedId} paused for ${pauseMinutesLabel} minutes.`;
    updatedMessage = `acknowledged bed exit alert for bed ${bedId} by ${user} (paused ${pauseMinutesLabel}m) at ${new Date().toLocaleTimeString()}`;
  } else if (action === 'clear') {
    pausedBeds.delete(bedId);
    popupText = `Alert acknowledged and cleared for Bed ${bedId}.`;
    updatedMessage = `acknowledged bed exit alert for bed ${bedId} by ${user} at ${new Date().toLocaleTimeString()}`;
  }

  await writeBedStatus(bedId, 'IDLE');

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

app.listen(PORT, () => {
  console.log(`🖥️  Bridge HTTP server listening on http://localhost:${PORT}`);
});