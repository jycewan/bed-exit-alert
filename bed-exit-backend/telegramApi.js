const config = require('./config');

// Thin, stateless wrappers around the Telegram Bot HTTP API. No knowledge
// of bed state / escalation / alert-tracking lives here on purpose - that
// belongs to the callers (alerts.js, escalation.js, telegram-polling.js),
// this module just moves bytes.
const BASE_URL = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

async function sendMessage(chatId, text, replyMarkup) {
  const res = await fetch(`${BASE_URL}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  });
  return res.json();
}

async function editMessageText(chatId, messageId, text, replyMarkup) {
  const res = await fetch(`${BASE_URL}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {})
    })
  });
  return res.json();
}

async function answerCallbackQuery(callbackQueryId, text, showAlert) {
  const res = await fetch(`${BASE_URL}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: !!showAlert })
  });
  return res.json();
}

async function getUpdates(offset) {
  const res = await fetch(`${BASE_URL}/getUpdates?offset=${offset}&timeout=30`);
  return res.json();
}

module.exports = { sendMessage, editMessageText, answerCallbackQuery, getUpdates };
