const crypto = require('crypto');
const pool = require('../db/pool');

// Auth de la API pública v1: API key por cliente (Authorization: Bearer xpk_…
// o X-Api-Key). Solo viaja el hash a BD; caché RAM corta para no pegar a BD en
// cada request. La key da acceso EXCLUSIVAMENTE a los datos de su cliente.

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // hash -> { clientId, isActive, expiresAt }

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Al rotar/revocar una key desde el panel, tirar la caché para que el cambio
// sea inmediato (la ruta de clients lo llama).
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

async function requireApiKey(req, res, next) {
  const raw = extractKey(req);
  if (!raw || !raw.startsWith('xpk_')) return unauthorized(res);

  const hash = hashKey(raw);
  const cached = cache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.clientId || !cached.isActive) return unauthorized(res);
    req.clientId = cached.clientId;
    req.apiKeyHash = hash;
    return next();
  }

  try {
    const [rows] = await pool.execute(
      'SELECT id, is_active FROM clients WHERE api_key_hash = ? LIMIT 1',
      [hash],
    );
    const row = rows[0] || null;
    cache.set(hash, {
      clientId: row?.id || null,
      isActive: Boolean(row?.is_active),
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    if (!row || !row.is_active) return unauthorized(res);
    req.clientId = row.id;
    req.apiKeyHash = hash;
    return next();
  } catch (err) {
    return res.status(500).json({ error: { code: 'internal', message: err.message } });
  }
}

module.exports = { requireApiKey, invalidateApiKeyCache, hashKey };
