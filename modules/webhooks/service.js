const axios = require('axios');
const pool = require('../../db/pool');

// Phase 2: la config de webhook vive por cliente en `clients.webhook_*`.
// Nada de estado en memoria.

async function getClientWebhookConfig(clientId) {
  if (!clientId) return null;
  const [rows] = await pool.execute(
    'SELECT webhook_incoming_url, webhook_secret, is_active FROM clients WHERE id = ?',
    [clientId],
  );
  if (rows.length === 0) return null;
  return {
    incomingUrl: rows[0].webhook_incoming_url || '',
    secret: rows[0].webhook_secret || '',
    isActive: Boolean(rows[0].is_active),
  };
}

// Cliente para enriquecer el payload del webhook (datos de contacto + estado)
async function getClientForPayload(clientId) {
  if (!clientId) return null;
  const [rows] = await pool.execute(
    `SELECT id, name, email, phone, is_active,
            webhook_incoming_url, webhook_secret
     FROM clients WHERE id = ?`,
    [clientId],
  );
  if (rows.length === 0) return null;
  return rows[0];
}

// Compara el header x-webhook-secret con el secret del cliente cuyo client_id
// llega resuelto. Si el cliente no tiene secret configurado, deniega siempre
// (mejor a fail-open).
function checkClientSecret(req, clientSecret) {
  if (!clientSecret) return false;
  return req.header('x-webhook-secret') === clientSecret;
}

function validateUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

function formatError(error) {
  const code = error?.code ? String(error.code) : '';
  const message = error?.message ? String(error.message) : '';
  const status = error?.response?.status ? String(error.response.status) : '';

  let detail = '';
  if (error?.response?.data) {
    if (typeof error.response.data === 'string') {
      detail = error.response.data.slice(0, 180);
    } else {
      try { detail = JSON.stringify(error.response.data).slice(0, 180); } catch { detail = ''; }
    }
  }

  const base = [code, message].filter(Boolean).join(' - ') || 'sin detalle';
  const statusPart = status ? ` (HTTP ${status})` : '';
  const detailPart = detail ? ` | body: ${detail}` : '';
  return `${base}${statusPart}${detailPart}`;
}

// Forward incoming WhatsApp payload to the URL configured on the client.
// Enriquece el payload con datos del cliente (nombre + teléfono de contacto)
// y el connectedNumber (línea WA real que recibió el mensaje), para que n8n
// pueda enrutar por número conectado o por cliente.
//
// Returns { to, text } if the webhook responded with an auto-reply, else null.
// Throws on network / non-2xx errors.
async function forwardIncoming(clientId, payload, extras = {}) {
  const client = await getClientForPayload(clientId);
  if (!client) return null;
  if (!client.webhook_incoming_url) return null;
  if (!client.is_active) return null;

  const enrichedPayload = {
    ...payload,
    client: {
      id: client.id,
      name: client.name,
      phone: client.phone,           // teléfono de contacto del cliente (de la BD)
      email: client.email,
    },
    connectedNumber: extras.connectedNumber || null,  // número WA que recibió el mensaje
  };

  const headers = {};
  if (client.webhook_secret) headers['x-webhook-secret'] = client.webhook_secret;

  const response = await axios.post(client.webhook_incoming_url, enrichedPayload, {
    headers,
    timeout: 60000,
  });

  if (response?.data?.to && response?.data?.text) {
    const out = { to: String(response.data.to), text: String(response.data.text) };
    // Señal de handoff: si n8n la incluye, la propagamos sin romper el contrato
    // {to,text}. El handoff SIEMPRE acompaña un texto (el "te atiende una persona").
    if (response.data.handoff === true || response.data.handoff === 'true') {
      out.handoff = true;
      out.handoff_motivo = response.data.handoff_motivo ? String(response.data.handoff_motivo) : null;
      out.handoff_resumen = response.data.handoff_resumen ? String(response.data.handoff_resumen) : null;
    }
    return out;
  }
  return null;
}

async function testIncoming(url, secret) {
  const headers = {};
  if (secret) headers['x-webhook-secret'] = secret;
  const payload = {
    type: 'webhook_test',
    source: 'whatsapp-web',
    timestamp: new Date().toISOString(),
    message: 'Prueba manual desde panel',
  };
  const response = await axios.post(url, payload, { headers, timeout: 60000 });
  return { status: response.status };
}

module.exports = {
  getClientWebhookConfig,
  checkClientSecret,
  validateUrl,
  formatError,
  forwardIncoming,
  testIncoming,
};
