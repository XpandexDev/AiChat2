const crypto = require('crypto');

// Helpers de token de sesión compartidos por el auth admin y el de cliente.
// Mismo patrón que modules/auth/service.js: token raw de 64 hex, hash sha256
// (nunca se guarda el raw), TTL configurable.

const TOKEN_BYTES = 32; // → 64 hex chars
const DEFAULT_TTL_DAYS = 7;

function generateRawToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function expiresAt(ttlDays = DEFAULT_TTL_DAYS) {
  return new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
}

module.exports = { generateRawToken, hashToken, expiresAt, DEFAULT_TTL_DAYS };
