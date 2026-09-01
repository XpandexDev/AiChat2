const crypto = require('crypto');
const axios = require('axios');
const pool = require('../../db/pool');

// Webhook de EVENTOS salientes por cliente. Entrega firmada (HMAC-SHA256 del
// body con el secret del cliente) con reintentos en backoff. Cola en RAM,
// best-effort: un reinicio pierde los reintentos pendientes (documentado).
//
// Cabeceras de cada entrega:
//   X-AiChat-Event:     <tipo>            (p.ej. message.received)
//   X-AiChat-Signature: sha256=<hex>      (HMAC del body con el secret whsec_…)
//   X-AiChat-Delivery:  <uuid del evento>
//
// Verificación en el receptor: hmac_sha256(secret, rawBody) === firma.

const RETRY_DELAYS_MS = [0, 30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const CONFIG_TTL_MS = 60 * 1000;
const MAX_PENDING = 500;

const configCache = new Map(); // clientId -> { value: {url, secret}, expiresAt }
let pendingCount = 0;

async function getConfig(clientId) {
  const cached = configCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const [rows] = await pool.execute(
      'SELECT events_webhook_url AS url, events_webhook_secret AS secret FROM clients WHERE id = ?',
      [clientId],
    );
    const value = rows[0]?.url ? { url: rows[0].url, secret: rows[0].secret } : null;
    configCache.set(clientId, { value, expiresAt: Date.now() + CONFIG_TTL_MS });
    return value;
  } catch {
    return null;
  }
}

// El panel invalida al guardar la URL para efecto inmediato.
function invalidateEventsConfig(clientId = null) {
  if (clientId) configCache.delete(clientId);
  else configCache.clear();
}

function sign(secret, body) {
  return `sha256=${crypto.createHmac('sha256', String(secret || '')).update(body).digest('hex')}`;
}

async function attemptDelivery(config, event, body, attempt) {
  try {
    await axios.post(config.url, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-AiChat-Event': event.type,
        'X-AiChat-Signature': sign(config.secret, body),
        'X-AiChat-Delivery': event.id,
      },
      timeout: 10000,
      maxRedirects: 3,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    pendingCount -= 1;
  } catch (err) {
    const next = attempt + 1;
    if (next < RETRY_DELAYS_MS.length) {
      setTimeout(() => {
        attemptDelivery(config, event, body, next).catch(() => { pendingCount -= 1; });
      }, RETRY_DELAYS_MS[next]).unref?.();
    } else {
      pendingCount -= 1;
      console.error(`events: entrega agotada (${event.type} → cliente ${event.clientId}): ${err.message}`);
    }
  }
}

/**
 * Encola un evento para el webhook del cliente (si lo tiene configurado).
 * Fire-and-forget: JAMÁS bloquea ni rompe el flujo del mensaje.
 */
function dispatchEvent(clientId, type, data) {
  if (!clientId || !type) return;
  getConfig(clientId).then((config) => {
    if (!config || !config.url) return;
    if (pendingCount >= MAX_PENDING) return; // protección: no acumular sin límite
    pendingCount += 1;
    const event = {
      id: crypto.randomUUID(),
      type,
      clientId,
      timestamp: new Date().toISOString(),
      data,
    };
    const body = JSON.stringify(event);
    attemptDelivery(config, event, body, 0).catch(() => { pendingCount -= 1; });
  }).catch(() => {});
}

module.exports = { dispatchEvent, invalidateEventsConfig };
