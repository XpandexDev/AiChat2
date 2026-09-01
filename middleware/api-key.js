const crypto = require('crypto');
const pool = require('../db/pool');

// Auth de la API pública v1: API keys por cliente (tabla client_api_keys —
// varias por cliente, con nombre y last_used). Solo viaja el hash a BD; caché
// RAM corta. La key da acceso EXCLUSIVAMENTE a los datos de su cliente.

const CACHE_TTL_MS = 60 * 1000;
const LAST_USED_THROTTLE_MS = 60 * 1000;
const cache = new Map();     // hash -> { clientId, keyId, isActive, expiresAt }
const lastTouched = new Map(); // keyId -> ts del último UPDATE de last_used_at

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Al crear/borrar keys desde el panel, tirar la caché para efecto inmediato.
function invalidateApiKeyCache() {
  cache.clear();
}

function extractKey(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-api-key'];
  if (header) return String(header).trim();
  return null;
}

function unauthorized(res) {
  return res.status(401).json({
    error: { code: 'unauthorized', message: 'API key ausente o inválida' },
  });
}

function touchLastUsed(keyId) {
  const last = lastTouched.get(keyId) || 0;
  if (Date.now() - last < LAST_USED_THROTTLE_MS) return;
  lastTouched.set(keyId, Date.now());
  pool.execute('UPDATE client_api_keys SET last_used_at = NOW() WHERE id = ?', [keyId])
    .catch(() => {});
}

async function requireApiKey(req, res, next) {
  const raw = extractKey(req);
  if (!raw || !raw.startsWith('xpk_')) return unauthorized(res);

  const hash = hashKey(raw);
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.clientId || !cached.isActive) return unauthorized(res);
    req.clientId = cached.clientId;
    req.apiKeyId = cached.keyId;
    req.apiKeyHash = hash;
    touchLastUsed(cached.keyId);
    return next();
  }

  try {
    const [rows] = await pool.execute(
      `SELECT k.id AS key_id, k.client_id, c.is_active
       FROM client_api_keys k JOIN clients c ON c.id = k.client_id
       WHERE k.key_hash = ? LIMIT 1`,
      [hash],
    );
    const row = rows[0] || null;
    cache.set(hash, {
      clientId: row?.client_id || null,
      keyId: row?.key_id || null,
      isActive: Boolean(row?.is_active),
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    if (!row || !row.is_active) return unauthorized(res);
    req.clientId = row.client_id;
    req.apiKeyId = row.key_id;
    req.apiKeyHash = hash;
    touchLastUsed(row.key_id);
    return next();
  } catch (err) {
    return res.status(500).json({ error: { code: 'internal', message: err.message } });
  }
}

module.exports = { requireApiKey, invalidateApiKeyCache, hashKey };
