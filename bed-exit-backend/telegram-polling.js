const config = require('./config');
const telegramApi = require('./telegramApi');
const state = require('./state');
const escalation = require('./escalation');

let offset = 0;

function setOffset(value) {
  offset = value;
}

async function pollTelegramUpdates() {
  try {
    const data = await telegramApi.getUpdates(offset);

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        }
      }
      await state.persistTelegramOffset(offset);
    }
  } catch (err) {
    console.error('Polling error:', err.message);
  }
  setTimeout(pollTelegramUpdates, 1000);
}

async function handleCallbackQuery(query) {
  const data = query.data;
  const user = query.from.first_name || query.from.username || 'Caregiver';
  const messageId = query.message.message_id;
  const chatId = query.message.chat.id;

  const segments = data.split('_');
  if (segments.length !== 3) {
    console.error(`❌ Unrecognized callback_data format: "${data}" — ignoring`);
    await telegramApi.answerCallbackQuery(query.id, 'Unrecognized action', true);
    return;
  }
  const [action, bedId, kind] = segments;
  if (action !== 'pause' && action !== 'clear') {
    console.error(`❌ Unknown callback action: "${action}" — ignoring`);
    await telegramApi.answerCallbackQuery(query.id, 'Unrecognized action', true);
    return;
  }

  escalation.clearEscalationTimer(bedId, kind);

  const kindLabel = kind === 'fault' ? 'sensor fault' : kind === 'offline' ? 'device offline' : 'bed exit alert';
  const bedLabel = state.getLabel(bedId);

  // Any earlier, still-unresolved alerts of this same bed+kind (from a
  // retrigger before this one was acked) get cleaned up here too - the
  // caregiver acking the alert in front of them should resolve the whole
  // backlog for that bed+kind, not just the one message they happened to
  // tap. The message they're actually looking at (messageId) is edited
  // below with the real ack text; older ones just get their button pulled.
  const trackedIds = state.sentAlertMessages.get(`${bedId}:${kind}`) || [];
  state.sentAlertMessages.delete(`${bedId}:${kind}`);
  state.clearPersistedSentAlertMessage(bedId, kind);
  for (const id of trackedIds) {
    if (id !== messageId) {
      await telegramApi.editMessageText(chatId, id, `(superseded - see newer ${kindLabel} alert for bed ${bedLabel})`, { inline_keyboard: [] });
    }
  }

  if (kind === 'fault') state.faultState.delete(bedId);

  let popupText = '';
  let updatedMessage = '';
  const pauseMinutesLabel = Math.round(config.PAUSE_DURATION_MS / 60000);

  if (action === 'pause') {
    const expiry = Date.now() + config.PAUSE_DURATION_MS;
    state.pausedBeds.set(bedId, expiry);
    await state.persistPausedBed(bedId, expiry);
    popupText = `Alert acknowledged. Bed ${bedLabel} paused for ${pauseMinutesLabel} minutes.`;
    updatedMessage = `acknowledged ${kindLabel} for bed ${bedLabel} by ${user} (paused ${pauseMinutesLabel}m) at ${new Date().toLocaleTimeString()}`;
  } else if (action === 'clear') {
    state.pausedBeds.delete(bedId);
    await state.clearPersistedPausedBed(bedId);
    popupText = `Alert acknowledged and cleared for Bed ${bedLabel}.`;
    updatedMessage = `acknowledged ${kindLabel} for bed ${bedLabel} by ${user} at ${new Date().toLocaleTimeString()}`;
  }

  await telegramApi.answerCallbackQuery(query.id, popupText, true);
  await telegramApi.editMessageText(chatId, messageId, updatedMessage);
}

module.exports = { pollTelegramUpdates, setOffset };