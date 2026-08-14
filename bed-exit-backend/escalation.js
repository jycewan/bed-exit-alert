const config = require('./config');
const { db } = require('./firebase');
const telegramApi = require('./telegramApi');

// Escalation — if nobody acks within ESCALATION_DELAY_MS, notify supervisor.
// "type" keeps exit / fault / offline escalations independent per bed, so a
// bed-exit escalation and a sensor-fault escalation for the SAME bed don't
// cancel each other out.
const escalationTimers = new Map(); // "bedId:type" -> setTimeout handle (cleared on ack)

async function persistEscalationTimer(bedId, type, text, startedAt) {
  try {
    await db.ref(`bridge/escalationTimers/${bedId}_${type}`).set({ text, startedAt, delayMs: config.ESCALATION_DELAY_MS });
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

async function sendSupervisorEscalation(text) {
  const data = await telegramApi.sendMessage(config.SUPERVISOR_CHAT_ID, text);
  if (!data.ok) console.error('❌ Escalation send failed:', data.description);
  else console.log('✅ Escalation sent to supervisor');
}

// remainingMs/startedAt are only passed by restoreEscalationTimers() when
// re-arming a timer after a restart - normal calls just use the defaults.
function startEscalationTimer(bedId, type, escalationText, remainingMs = config.ESCALATION_DELAY_MS, startedAt = Date.now()) {
  const key = `${bedId}:${type}`;
  if (escalationTimers.has(key)) return; // already pending, don't stack a duplicate

  persistEscalationTimer(bedId, type, escalationText, startedAt);

  const timer = setTimeout(async () => {
    escalationTimers.delete(key);
    await clearPersistedEscalationTimer(bedId, type);
    console.log(`🆘 No ack for Bed ${bedId} (${type}) within ${config.ESCALATION_DELAY_MS}ms — escalating to supervisor`);
    try {
      await sendSupervisorEscalation(escalationText);
    } catch (err) {
      console.error(`❌ Escalation send threw for bed ${bedId} (${type}):`, err);
    }
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

// Run once at startup to rebuild escalationTimers from whatever was
// mid-flight when the process last exited. Any escalation that was already
// overdue while the bridge was down fires immediately instead of vanishing.
async function restoreEscalationTimers() {
  try {
    const snap = await db.ref('bridge/escalationTimers').get();
    if (snap.exists()) {
      const now = Date.now();
      for (const [key, entry] of Object.entries(snap.val())) {
        const idx = key.lastIndexOf('_');
        const bedId = key.slice(0, idx);
        const type = key.slice(idx + 1);
        const deadline = entry.startedAt + (entry.delayMs || config.ESCALATION_DELAY_MS);
        const remaining = deadline - now;

        if (remaining <= 0) {
          console.log(`🆘 Restored escalation for bed ${bedId} (${type}) was already overdue - firing now`);
          await clearPersistedEscalationTimer(bedId, type);
          await sendSupervisorEscalation(entry.text);
        } else {
          startEscalationTimer(bedId, type, entry.text, remaining, entry.startedAt);
          console.log(`♻️ Restored escalation timer for bed ${bedId} (${type}), firing in ${Math.round(remaining / 1000)}s`);
        }
      }
    }
  } catch (err) {
    console.error('❌ Failed to restore escalationTimers from Firebase:', err);
  }
}

module.exports = {
  escalationTimers,
  startEscalationTimer,
  clearEscalationTimer,
  restoreEscalationTimers
};
