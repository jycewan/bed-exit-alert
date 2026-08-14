const { db } = require('./firebase');

// Per-bed state
const pausedBeds = new Map();    // bedId -> pause-expiry timestamp
const faultState = new Map();    // bedId -> true while a SENSOR_FAULT is unresolved (cleared on next IDLE/OFF_MAT)
const exitState = new Map();     // bedId -> true while a bed-exit alert is unresolved, cleared ONLY on OFF_MAT
                                  // (not on ack - an ack silences the notification, it doesn't mean the
                                  // resident is back in bed; see the caregiver-driven-clearing note in
                                  // telegram-polling.js's handleCallbackQuery)
const offlineState = new Map();  // bedId -> true while an OFFLINE alert is unresolved, cleared on ONLINE
// deviceId -> human-facing label (formerly "Bed ID"), kept in memory so
// alert/escalation text can be built synchronously without a Firebase round
// trip per message. Populated by handleLabelTopic() in mqtt-handlers.js
// (live, retained bed/{deviceId}/label messages) and restoreDeviceLabels()
// (Firebase, at startup) - the retained MQTT message is the source of
// truth going forward, Firebase is just the crash-safe mirror of it.
const deviceLabels = new Map();
// "bedId:kind" -> ARRAY of Telegram message_ids for still-unresolved
// Ack/Clear alerts sent for that bed+kind. An array (not a single id)
// because a bed can retrigger the same alert kind more than once before
// any of them get resolved (repeated faults, repeated exits) - every one
// of those messages needs its button cleaned up eventually, not just
// whichever fired most recently.
const sentAlertMessages = new Map();

// Firebase RTDB write
async function writeBedStatus(bedId, state) {
  try {
    await db.ref(`beds/${bedId}/status`).set({ state, timestamp: Date.now() });
  } catch (err) {
    console.error(`❌ RTDB write failed for bed ${bedId}:`, err);
  }
}

// Crash-safety: mirror pausedBeds/sentAlertMessages to Firebase so a pm2
// restart (crash, redeploy, server reboot) doesn't silently drop an active
// pause window or lose track of a message that needs auto-resolving later.
// (escalationTimers gets the same treatment in escalation.js.)
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

async function persistSentAlertMessage(bedId, kind, messageIds) {
  try {
    await db.ref(`bridge/sentAlertMessages/${bedId}_${kind}`).set({ messageIds });
  } catch (err) {
    console.error(`❌ Failed to persist alert message ids for bed ${bedId} (${kind}):`, err);
  }
}

async function clearPersistedSentAlertMessage(bedId, kind) {
  try {
    await db.ref(`bridge/sentAlertMessages/${bedId}_${kind}`).remove();
  } catch (err) {
    console.error(`❌ Failed to clear persisted alert message id for bed ${bedId} (${kind}):`, err);
  }
}

// getLabel() is what every human-facing message (Telegram text, dashboard)
// should call instead of using a deviceId raw - falls back to the deviceId
// itself if this device has never published a label yet (e.g. brand new,
// or bridge restarted before the retained label message was redelivered).
function getLabel(deviceId) {
  return deviceLabels.get(deviceId) || deviceId;
}

async function persistLabel(deviceId, label) {
  try {
    await db.ref(`beds/${deviceId}/label`).set(label);
  } catch (err) {
    console.error(`❌ Failed to persist label for device ${deviceId}:`, err);
  }
}

// Run once at startup so getLabel() has something better than the raw
// deviceId to show immediately, before this device's retained label message
// (if any) gets redelivered on MQTT subscribe.
async function restoreDeviceLabels() {
  try {
    const snap = await db.ref('beds').get();
    if (snap.exists()) {
      for (const [deviceId, data] of Object.entries(snap.val())) {
        if (data.label) {
          deviceLabels.set(deviceId, data.label);
        }
      }
      console.log(`♻️ Restored ${deviceLabels.size} device label(s) from Firebase`);
    }
  } catch (err) {
    console.error('❌ Failed to restore device labels from Firebase:', err);
  }
}

// Telegram long-polling offset - persisted the same way pausedBeds/
// sentAlertMessages are, so a pm2 restart doesn't replay (or lose) button
// clicks that were already queued by Telegram's servers.
async function persistTelegramOffset(value) {
  try {
    await db.ref('bridge/telegramOffset').set({ value });
  } catch (err) {
    console.error('❌ Failed to persist Telegram offset:', err);
  }
}

async function loadTelegramOffset() {
  try {
    const snap = await db.ref('bridge/telegramOffset').get();
    return snap.exists() ? snap.val().value : 0;
  } catch (err) {
    console.error('❌ Failed to load Telegram offset, starting from 0:', err);
    return 0;
  }
}

// Run once at startup, before MQTT/Telegram start flowing, to rebuild
// pausedBeds from whatever was mid-flight when the process last exited.
async function restorePausedBeds() {
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
}

// Same idea as restorePausedBeds(), for the trackable Ack/Clear message ids
// that autoResolveAlert() needs to edit self-resolving alerts in place.
async function restoreSentAlertMessages() {
  try {
    const snap = await db.ref('bridge/sentAlertMessages').get();
    if (snap.exists()) {
      for (const [key, entry] of Object.entries(snap.val())) {
        const idx = key.lastIndexOf('_');
        const bedId = key.slice(0, idx);
        const kind = key.slice(idx + 1);
        // Backward-compatible with old single-messageId entries written
        // before this became an array (avoids losing/crashing on data
        // persisted by a previous version of the bridge).
        const ids = entry.messageIds || (entry.messageId ? [entry.messageId] : []);
        sentAlertMessages.set(`${bedId}:${kind}`, ids);
        console.log(`♻️ Restored ${ids.length} trackable alert message(s) for bed ${bedId} (${kind})`);
      }
    }
  } catch (err) {
    console.error('❌ Failed to restore sentAlertMessages from Firebase:', err);
  }
}

module.exports = {
  pausedBeds,
  faultState,
  exitState,
  offlineState,
  sentAlertMessages,
  deviceLabels,
  getLabel,
  persistLabel,
  restoreDeviceLabels,
  writeBedStatus,
  persistPausedBed,
  clearPersistedPausedBed,
  persistSentAlertMessage,
  clearPersistedSentAlertMessage,
  persistTelegramOffset,
  loadTelegramOffset,
  restorePausedBeds,
  restoreSentAlertMessages
};