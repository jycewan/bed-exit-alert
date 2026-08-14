const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const state = require('./state');
const escalation = require('./escalation');
const { requireAdminAuth } = require('./auth');
const { db } = require('./firebase');
const { client } = require('./mqtt-client');

const router = express.Router();

// Throttles brute-force attempts against Basic Auth and caps how fast
// remote commands can be fired at a device - Basic Auth alone has no
// built-in attempt limit, and safeEqual (auth.js) only protects against
// *timing* attacks, not raw throughput ones.
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

// Health check / manual status endpoint - intentionally not behind admin
// auth or rate limiting, same as before the split (used for uptime checks).
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    mqttConnected: client.connected,
    pausedBeds: Object.fromEntries(state.pausedBeds),
    pendingEscalations: [...escalation.escalationTimers.keys()]
  });
});

// Admin dashboard - one page listing every bed that has ever reported
// status, each with buttons for OPEN_PORTAL / FORCE_RECONNECT / set backup
// WiFi. Pulls the bed list straight from Firebase (beds/*), so any device
// that has ever published shows up automatically - nothing to hardcode
// when you add a second (or Nth) ESP32.
router.get('/admin', adminLimiter, requireAdminAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bed Devices</title>
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
<h2>Bed Devices</h2>
<table id="beds"><thead><tr><th>Bed</th><th>Status</th><th>Last update</th><th>Actions</th></tr></thead><tbody></tbody></table>

<script>
async function loadBeds() {
  const res = await fetch('/admin/api/beds');
  const beds = await res.json();
  const tbody = document.querySelector('#beds tbody');
  tbody.innerHTML = '';
  for (const bed of beds) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td>\${bed.label}<br><small style="color:#888">\${bed.id}</small></td>
      <td class="status-\${bed.state}">\${bed.state}</td>
      <td>\${new Date(bed.timestamp).toLocaleString()}</td>
      <td>
        <input placeholder="new label" id="label-\${bed.id}" size="12" value="\${bed.label}">
        <button onclick="renameBed('\${bed.id}')">Rename</button>
        <br>
        <button onclick="sendCmd('\${bed.id}','OPEN_PORTAL')">Open Portal</button>
        <button onclick="sendCmd('\${bed.id}','FORCE_RECONNECT')">Reconnect</button>
        <br>
        <input placeholder="backup SSID" id="ssid-\${bed.id}" size="12">
        <input placeholder="password" id="pass-\${bed.id}" type="password" size="10">
        <button onclick="setBackupWifi('\${bed.id}')">Set Backup WiFi</button>
        <br>
        <button onclick="deleteBed('\${bed.id}','\${bed.label}')" style="color:#c00;margin-top:4px">Delete (factory reset)</button>
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

async function renameBed(bedId) {
  const label = document.getElementById('label-' + bedId).value.trim();
  if (!label) { alert('Enter a new label'); return; }
  const res = await fetch(\`/bed/\${bedId}/cmd\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'SET_LABEL', label })
  });
  const data = await res.json();
  if (!data.ok) {
    alert('Rename failed: ' + data.error);
    return;
  }
  // The device is what actually owns this rename (see main.cpp's SET_LABEL
  // handler) - this only takes effect once it republishes its retained
  // label, which is near-instant if it's online right now but won't happen
  // at all if it's offline, so this isn't a guarantee, just a request sent.
  alert('Rename sent - updates within a few seconds if bed ' + bedId + ' is online.');
  setTimeout(loadBeds, 2000);
}

async function deleteBed(bedId, bedLabel) {
  const confirmed = confirm(
    'Delete bed ' + bedLabel + ' (' + bedId + ')?\\n\\n' +
    'This sends FACTORY_RESET to the device (wipes its saved WiFi + Bed Label - ' +
    'it will need to be re-provisioned via its boot portal) and removes it ' +
    'from this dashboard.\\n\\nThis cannot be undone. Continue?'
  );
  if (!confirmed) return;

  await fetch(\`/bed/\${bedId}\`, { method: 'DELETE' });
  alert('Bed ' + bedLabel + ' deleted');
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
// which state.writeBedStatus() already keeps current for every bed that has
// ever published an event.
router.get('/admin/api/beds', adminLimiter, requireAdminAuth, async (req, res) => {
  try {
    const snap = await db.ref('beds').get();
    // Flattened here rather than changing writeBedStatus()'s write shape -
    // beds/{id}/status stays its own nested node (so other future readers
    // can request just the status subtree), this route just reshapes it
    // for what the dashboard actually expects: bed.state, bed.timestamp.
    const beds = snap.exists()
      ? Object.entries(snap.val()).map(([id, data]) => ({
          id,
          label: data.label || id, // no label reported yet (e.g. bridge restarted before a retained label redelivery) - fall back to the device ID itself
          state: data.status?.state,
          timestamp: data.status?.timestamp
        }))
      : [];
    res.json(beds);
  } catch (err) {
    console.error('❌ Failed to read beds from Firebase:', err);
    res.status(500).json({ error: 'Failed to load beds' });
  }
});

// Lets a supervisor trigger a remote command on a bed device from any
// device with network access (not just physical presence at the ESP32) -
// as long as the target device is already online. :id is the stable
// device_id (see main.cpp), which is what's shown under the label on the
// dashboard - not the human-editable Bed Label. See the command handling
// notes in main.cpp's handleRemoteCommand() for what each command does and
// its limits (nothing here helps if the device's WiFi is fully down).
//   POST /bed/A1B2C3D4E5F6/cmd  { "command": "OPEN_PORTAL" }
//   POST /bed/A1B2C3D4E5F6/cmd  { "command": "FORCE_RECONNECT" }
//   POST /bed/A1B2C3D4E5F6/cmd  { "command": "SET_BACKUP_WIFI", "ssid": "...", "password": "..." }
//   POST /bed/A1B2C3D4E5F6/cmd  { "command": "SET_LABEL", "label": "Room 4 - Bed 1" }
//
// SET_LABEL is what the dashboard's Rename button uses - it's a live remote
// command (see main.cpp's SET_LABEL handler), not a direct Firebase write.
// The device stays the single source of truth for its own label the same
// way it always has (see handleLabelTopic in mqtt-handlers.js): this route
// never touches beds/{id}/label itself, it just asks the device to update
// and republish. That's deliberate - a route that wrote the label straight
// to Firebase would let the dashboard and the device disagree about the
// bed's name the next time the device reconnects and republishes ITS
// (unchanged) value, silently reverting the rename. Routing every rename
// through the device, whether from its own portal or from here, is what
// keeps that from happening. Means: this only works while bed is online.
//
// Protected by the same admin basic auth as the dashboard above. Still
// open: the underlying MQTT command topic itself has no HiveMQ ACL, so
// anyone with valid broker credentials (not just this endpoint) could
// still publish to it directly - see the README's known-issues note.
router.post('/bed/:id/cmd', adminLimiter, requireAdminAuth, (req, res) => {
  const bedId = req.params.id;
  if (!config.BED_ID_PATTERN.test(bedId)) {
    return res.status(400).json({ ok: false, error: 'Invalid bed ID' });
  }
  const { command, ssid, password, label } = req.body || {};

  let payload;
  if (command === 'OPEN_PORTAL' || command === 'FORCE_RECONNECT' || command === 'FACTORY_RESET') {
    payload = command;
  } else if (command === 'SET_BACKUP_WIFI') {
    if (!ssid || !password) {
      return res.status(400).json({ ok: false, error: 'SET_BACKUP_WIFI requires both ssid and password' });
    }
    payload = `SET_BACKUP_WIFI:${ssid}:${password}`;
  } else if (command === 'SET_LABEL') {
    if (!label || !config.LABEL_PATTERN.test(label)) {
      return res.status(400).json({ ok: false, error: 'SET_LABEL requires a valid label (letters, numbers, spaces, - and _, max 15 chars)' });
    }
    payload = `SET_LABEL:${label}`;
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
router.delete('/bed/:id', adminLimiter, requireAdminAuth, async (req, res) => {
  const bedId = req.params.id;
  if (!config.BED_ID_PATTERN.test(bedId)) {
    return res.status(400).json({ ok: false, error: 'Invalid bed ID' });
  }

  client.publish(`bed/${bedId}/cmd`, 'FACTORY_RESET', { qos: 1 });

  // The device publishes its status (ONLINE/OFFLINE, incl. the LWT) and
  // label RETAINED, so HiveMQ keeps serving the last one it saw forever -
  // to anyone who (re)subscribes, including this bridge on its own next
  // restart. Without this, deleting a bed only removed it from Firebase for
  // as long as until the next pm2 restart: resubscribing to bed/+/status
  // and bed/+/label immediately redelivers the deleted device's last
  // retained messages, and the bridge dutifully writes them straight back
  // into Firebase - resurrecting a bed that was just deleted. Publishing an
  // empty payload with retain:true is the standard MQTT way to tell the
  // broker "delete whatever retained message is on this topic now" - it's
  // not a real status/label update, mqtt-handlers.js treats an empty
  // payload here as a no-op.
  client.publish(`bed/${bedId}/status`, '', { qos: 1, retain: true });
  client.publish(`bed/${bedId}/label`, '', { qos: 1, retain: true });

  state.pausedBeds.delete(bedId);
  state.faultState.delete(bedId);
  state.deviceLabels.delete(bedId);
  for (const type of ['exit', 'fault', 'offline']) {
    escalation.clearEscalationTimer(bedId, type); // also clears its Firebase mirror
    state.sentAlertMessages.delete(`${bedId}:${type}`);
    state.clearPersistedSentAlertMessage(bedId, type);
  }
  state.clearPersistedPausedBed(bedId);

  try {
    await db.ref(`beds/${bedId}`).remove();
    console.log(`🗑️ Deleted bed ${bedId} (factory-reset command sent + Firebase record removed)`);
    res.json({ ok: true, bedId });
  } catch (err) {
    console.error(`❌ Failed to delete Firebase record for bed ${bedId}:`, err);
    res.status(500).json({ ok: false, error: 'Failed to delete bed record' });
  }
});

module.exports = router;
