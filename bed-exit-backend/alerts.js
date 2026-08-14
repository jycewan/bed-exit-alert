const config = require('./config');
const telegramApi = require('./telegramApi');
const state = require('./state');

// Telegram helpers — sending/editing the caregiver-facing Ack/Clear alerts.
// (escalation.js sends the plain supervisor notifications separately.)
async function sendAlertWithButtons(bedId, messageText, kind = 'exit') {
  const pauseMinutesLabel = Math.round(config.PAUSE_DURATION_MS / 60000);

  const buttons = (kind === 'fault' || kind === 'offline')
    ? [{ text: 'Ack & Clear', callback_data: `clear_${bedId}_${kind}` }]
    : [
        { text: `⏸️ Ack & Pause (${pauseMinutesLabel}m)`, callback_data: `pause_${bedId}_exit` },
        { text: 'Ack & Clear',                              callback_data: `clear_${bedId}_exit` }
      ];

  const keyboard = { inline_keyboard: [buttons] };

  const data = await telegramApi.sendMessage(config.TELEGRAM_CHAT_ID, messageText, keyboard);
  if (!data.ok) {
    console.error('❌ Telegram send failed:', data.description);
  } else {
    console.log('✅ Telegram alert sent');
    // Array, not a single ID: a bed can retrigger the same alert kind
    // multiple times before any of them get resolved (repeated faults,
    // repeated exits), and every one of those messages needs its button
    // cleaned up eventually - not just whichever fired most recently.
    const key = `${bedId}:${kind}`;
    const messageIds = state.sentAlertMessages.get(key) || [];
    messageIds.push(data.result.message_id);
    state.sentAlertMessages.set(key, messageIds);
    state.persistSentAlertMessage(bedId, kind, messageIds);
  }
}

// Edits every previously-sent, still-unresolved Ack/Clear alert for this
// bed+kind in place when the situation resolves ON ITS OWN (device
// reconnects, fault clears) rather than via a caregiver tapping a button -
// otherwise older messages from repeated retriggers sit forever showing a
// live button for a problem that's already gone. No-op if nothing is
// tracked for this bed+kind (e.g. bridge restarted since it sent, or it
// was already resolved via a manual ack).
async function autoResolveAlert(bedId, kind, resolutionText) {
  const key = `${bedId}:${kind}`;
  const messageIds = state.sentAlertMessages.get(key);
  if (!messageIds || messageIds.length === 0) return;
  state.sentAlertMessages.delete(key);
  await state.clearPersistedSentAlertMessage(bedId, kind);

  for (const messageId of messageIds) {
    await telegramApi.editMessageText(config.TELEGRAM_CHAT_ID, messageId, resolutionText, { inline_keyboard: [] });
  }
}

async function sendSimpleMessage(messageText) {
  const data = await telegramApi.sendMessage(config.TELEGRAM_CHAT_ID, messageText);
  if (!data.ok) console.error('❌ Telegram send failed:', data.description);
}

module.exports = { sendAlertWithButtons, autoResolveAlert, sendSimpleMessage };