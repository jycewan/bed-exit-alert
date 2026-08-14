const config = require('./config');
const state = require('./state');
const alerts = require('./alerts');
const escalation = require('./escalation');

async function processMqttMessage(topic, payload) {
  const parts = topic.split('/'); // ['bed', deviceId, 'exit' | 'status' | 'label']
  const bedId = parts[1]; // stable device_id (see main.cpp) - kept as "bedId" here since that's what it threads through as everywhere downstream
  const topicType = parts[2];

  if (!config.BED_ID_PATTERN.test(bedId)) {
    console.error(`❌ Ignoring message on [${topic}] - device ID "${bedId}" fails validation`);
    return;
  }

  console.log(`🚨 Event received on [${topic}]: ${payload}`);

  // Wrapped so a transient failure downstream (Telegram API timeout, DNS
  // blip, etc.) gets logged and the bridge keeps running, instead of
  // becoming an unhandled rejection that kills the whole process - the
  // one thing this system can't afford to do silently.
  try {
    if (topicType === 'exit') {
      await handleExitTopic(bedId, payload);
    } else if (topicType === 'status') {
      await handleStatusTopic(bedId, payload);
    } else if (topicType === 'label') {
      await handleLabelTopic(bedId, payload);
    }
  } catch (err) {
    console.error(`❌ Error handling [${topic}] = ${payload}:`, err);
  }
}

// Human-facing rename, published retained by the device on every (re)connect
// (see main.cpp). Deliberately does NOT touch any Firebase/MQTT *path* or
// callback_data - only the display label - so a rename can never orphan the
// device's history the way the old bedId-as-path-segment scheme did.
async function handleLabelTopic(deviceId, payload) {
  // Empty payload = the retained-message tombstone admin-routes.js publishes
  // on bed deletion (publishing empty+retain is the standard MQTT way to
  // clear a retained message) - not a real label, nothing to validate or do.
  if (payload === '') return;

  if (!config.LABEL_PATTERN.test(payload)) {
    console.error(`❌ Ignoring label for device ${deviceId} - "${payload}" fails validation`);
    return;
  }

  const previousLabel = state.deviceLabels.get(deviceId);
  state.deviceLabels.set(deviceId, payload);
  await state.persistLabel(deviceId, payload);

  if (previousLabel && previousLabel !== payload) {
    console.log(`🏷️ Device ${deviceId} relabeled: "${previousLabel}" -> "${payload}"`);
  } else if (!previousLabel) {
    console.log(`🏷️ Device ${deviceId} labeled "${payload}"`);
  }
}

async function handleExitTopic(bedId, payload) {
  // Only STEPPED_ON_MAT is sent by current firmware.
  if (payload === 'STEPPED_ON_MAT') {
    // Respect an active pause window for this bed
    if (state.pausedBeds.has(bedId)) {
      const expiry = state.pausedBeds.get(bedId);
      if (Date.now() < expiry) {
        console.log(`⏳ Alert for Bed ${bedId} ignored (Paused)`);
        return;
      }
      state.pausedBeds.delete(bedId);
      state.clearPersistedPausedBed(bedId);
    }

    await state.writeBedStatus(bedId, 'ALERT');

    // Only send a fresh Telegram alert on the transition into an exit
    // episode. Without this, a reconnect-triggered republish of the same
    // still-pressed mat (or an MQTT redelivery) sends a second alert and
    // orphans the first message's buttons. Deliberately NOT cleared on
    // ack (see exitState declaration in state.js) - only OFF_MAT means the
    // episode is actually over.
    if (!state.exitState.get(bedId)) {
      state.exitState.set(bedId, true);

      const label = state.getLabel(bedId);
      escalation.startEscalationTimer(bedId, 'exit',
        `⚠️ ESCALATION: bed exit alert for bed ${label} was not acknowledged in time`);

      const alertText = `bed exit alert resident on bed ${label} stepped on mat`;
      console.log(`📲 Sending Telegram alert for Bed ${bedId}...`);
      await alerts.sendAlertWithButtons(bedId, alertText, 'exit');
    }

  } else if (payload === 'OFF_MAT') {
    // Coming back to OFF_MAT also clears any lingering fault state for this bed
    const hadFault = state.faultState.get(bedId);
    state.faultState.delete(bedId);
    escalation.clearEscalationTimer(bedId, 'fault');
    if (hadFault) {
      await alerts.autoResolveAlert(bedId, 'fault', `✅ sensor fault on bed ${state.getLabel(bedId)} cleared automatically (mat reporting normally again)`);
    }

    // Clears the dedup flag only - deliberately does NOT auto-resolve/edit
    // any active exit alert message, and deliberately does NOT cancel a
    // pending escalation timer either. A single mat can't confirm a
    // resident is safely back in bed, only that weight left the mat; both
    // "this alert is resolved" and "nobody needs to review what happened"
    // have to stay caregiver-driven (via Ack & Clear), not automatic just
    // because the mat went idle.
    state.exitState.delete(bedId);

    await state.writeBedStatus(bedId, 'IDLE');
    // No Telegram message here on purpose - OFF_MAT isn't actionable on its
    // own (nothing to ack, no button), it was just chat noise. The RTDB
    // write above still records it for anyone checking bed history/status.
    console.log(`ℹ️ Bed ${bedId} off mat, status reset to IDLE`);

  } else if (payload === 'SENSOR_FAULT') {
    // Only alert on the transition into fault, not on every repeated publish
    if (!state.faultState.get(bedId)) {
      state.faultState.set(bedId, true);

      const label = state.getLabel(bedId);
      // TODO(George): confirm fault should escalate on the same
      // ESCALATION_DELAY_MS tier as a bed exit, or needs its own delay.
      escalation.startEscalationTimer(bedId, 'fault',
        `⚠️ ESCALATION: sensor fault on bed ${label} was not acknowledged in time`);

      await state.writeBedStatus(bedId, 'FAULT');

      const faultText = `⚠️ sensor fault on bed ${label} — check wiring / EOL resistor connection`;
      console.log(`📲 Sending Telegram fault alert for Bed ${bedId}...`);
      await alerts.sendAlertWithButtons(bedId, faultText, 'fault');
    }
  }
}

async function handleStatusTopic(bedId, payload) {
  if (payload === 'OFFLINE') {
    await state.writeBedStatus(bedId, 'OFFLINE'); // keep the RTDB timestamp fresh even on repeat pings

    // Only alert on the transition into offline - a flapping connection or
    // repeated retained LWT publish shouldn't re-send a brand new Telegram
    // alert once the caregiver has already acked this offline episode.
    if (!state.offlineState.get(bedId)) {
      state.offlineState.set(bedId, true);

      const label = state.getLabel(bedId);
      escalation.startEscalationTimer(bedId, 'offline',
        `⚠️ ESCALATION: bed ${label} device offline was not acknowledged`);

      const offlineText = `🔌 bed ${label} device is OFFLINE`;
      console.log(`📲 Sending Telegram offline alert for Bed ${bedId}...`);
      await alerts.sendAlertWithButtons(bedId, offlineText, 'offline');
    }

  } else if (payload === 'ONLINE') {
    const wasOffline = state.offlineState.get(bedId);
    state.offlineState.delete(bedId);
    escalation.clearEscalationTimer(bedId, 'offline');

    if (wasOffline) {
      const label = state.getLabel(bedId);
      await alerts.autoResolveAlert(bedId, 'offline', `✅ bed ${label} device is back online (auto-cleared)`);
      console.log(`ℹ️ Bed ${bedId} back online - offline alert auto-cleared`);
    }
  }
}
module.exports = { processMqttMessage };
