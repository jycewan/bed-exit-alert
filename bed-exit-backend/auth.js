const crypto = require('crypto');
const config = require('./config');

// Constant-time string compare - pads to equal length first so the
// timingSafeEqual call itself never throws on a length mismatch (which
// would otherwise leak length via the exception path), then also checks
// the real lengths match. Avoids leaking how many leading characters of
// the guess were correct via response-time differences.
function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  const len = Math.max(aBuf.length, bBuf.length, 1);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  aBuf.copy(aPadded);
  bBuf.copy(bPadded);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aPadded, bPadded);
}

// Basic auth gate for anything admin-facing (the dashboard + the command
// endpoints it drives). Browsers cache the credentials per-origin after the
// first prompt, so the dashboard's own fetch() calls to /bed/:id/cmd go
// through without a second login. The missing HiveMQ ACL on the underlying
// MQTT command topic is still a separate, unaddressed gap - this only
// covers the HTTP surface.
function requireAdminAuth(req, res, next) {
  const b64 = (req.headers.authorization || '').split(' ')[1] || '';
  const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
  if (safeEqual(user || '', config.ADMIN_USER) && safeEqual(pass || '', config.ADMIN_PASS)) return next();
  res.set('WWW-Authenticate', 'Basic realm="bexit-admin"');
  res.status(401).send('Authentication required');
}

module.exports = { safeEqual, requireAdminAuth };
