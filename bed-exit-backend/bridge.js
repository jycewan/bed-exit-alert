const express = require('express');
const config = require('./config');
const state = require('./state');
const escalation = require('./escalation');
const telegramPolling = require('./telegram-polling');
const adminRoutes = require('./admin-routes');
const mqttClient = require('./mqtt-client');

const app = express();
app.use(express.json());
app.use(adminRoutes);

const httpServer = app.listen(config.PORT, () => {
  console.log(`🖥️  Bridge HTTP server listening on http://localhost:${config.PORT}`);
});
httpServer.on('error', (err) => {
  // Under pm2, exiting nonzero on a real server error (e.g. EADDRINUSE) is
  // preferable to limping along with MQTT/Telegram alive but the admin
  // dashboard and /status health check unreachable - pm2 will restart it
  // and the failure is visible in the logs instead of silently degraded.
  console.error('❌ HTTP server error:', err);
  process.exit(1);
});

// Rebuild pausedBeds/escalationTimers/sentAlertMessages and the Telegram
// polling offset from Firebase before anything else starts acting on live
// MQTT/Telegram traffic. MQTT messages that arrive while this is running
// are queued by mqtt-client.js and drained here once restoration finishes,
// in the order they arrived. Telegram polling likewise only starts after
// this completes.
async function startup() {
  await state.restorePausedBeds();
  await escalation.restoreEscalationTimers();
  await state.restoreSentAlertMessages();
  await state.restoreDeviceLabels();

  await mqttClient.drainQueueAndGoLive();

  const offset = await state.loadTelegramOffset();
  telegramPolling.setOffset(offset);
  console.log(`♻️ Resuming Telegram polling from offset ${offset}`);
  telegramPolling.pollTelegramUpdates();
}

startup();
