const mqtt = require('mqtt');
const config = require('./config');
const { processMqttMessage } = require('./mqtt-handlers');

// rejectUnauthorized left at its default (true) so the bridge<->HiveMQ leg
// is actually certificate-verified, matching the ESP32 side's setCACert()
// pin - it was previously disabled here, which meant only ONE side of the
// pipeline was checking who it was talking to. If this bridge ever fails
// to connect with a self-signed-cert error, that's a real misconfiguration
// to fix at the HiveMQ end, not something to silence here.
const client = mqtt.connect(`mqtts://${config.MQTT_HOST}:${config.MQTT_PORT}`, {
  clientId: 'bridge-node-' + Math.floor(Math.random() * 10000),
  username: config.MQTT_USER,
  password: config.MQTT_PASS
});

client.on('connect', () => {
  console.log('✅ Bridge connected to HiveMQ Cloud!');
  // QoS 1: broker holds the message and retries delivery to us until we
  // ack it, instead of a fire-and-forget QoS 0 drop. This only guarantees
  // the broker->bridge hop - see the QoS note in main.cpp for why the
  // device->broker hop (PubSubClient) can't make the same promise.
  client.subscribe('bed/+/exit', { qos: 1 }, (err) => {
    if (!err) console.log('📡 Listening for Bed Exit events on [bed/+/exit] (QoS 1)...');
    else console.error('Subscribe error:', err);
  });
  client.subscribe('bed/+/status', { qos: 1 }, (err) => {
    if (!err) console.log('📡 Listening for device status (LWT ONLINE/OFFLINE) on [bed/+/status] (QoS 1)...');
    else console.error('Subscribe error:', err);
  });
  // Retained: subscribing here immediately redelivers every device's most
  // recent label, not just future changes - that's what lets a rename made
  // while the bridge was down still get picked up on the next restart.
  client.subscribe('bed/+/label', { qos: 1 }, (err) => {
    if (!err) console.log('📡 Listening for device labels on [bed/+/label] (QoS 1, retained)...');
    else console.error('Subscribe error:', err);
  });
});

client.on('error', (err) => {
  console.error('❌ MQTT connection error:', err);
});

// Restoration gate: while state is still being restored from Firebase at
// startup, any MQTT message that arrives gets queued instead of processed
// immediately, then drained in order once drainQueueAndGoLive() is called.
// Without this, a bed-exit event arriving in the first moment after a pm2
// restart could be processed against empty/not-yet-restored state (e.g.
// missing an already-paused window, or double-firing an escalation restore
// is about to re-arm). This is NOT a delivery guarantee for messages that
// arrive before the client even connects - that's the QoS 0 / clean-session
// gap documented separately - it only protects the brief in-process window
// between "connected and subscribed" and "restore finished."
let restoring = true;
const queuedMessages = [];

client.on('message', (topic, message) => {
  const payload = message.toString().trim();
  if (restoring) {
    queuedMessages.push({ topic, payload });
    return;
  }
  processMqttMessage(topic, payload);
});

async function drainQueueAndGoLive() {
  restoring = false;
  console.log(`♻️ Draining ${queuedMessages.length} MQTT message(s) queued during restore...`);
  for (const { topic, payload } of queuedMessages) {
    await processMqttMessage(topic, payload);
  }
  queuedMessages.length = 0;
}

module.exports = { client, drainQueueAndGoLive };
