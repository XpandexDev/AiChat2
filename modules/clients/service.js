const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../../db/pool');

const BCRYPT_ROUNDS = 12;

const SELECT_FIELDS = `
  id, name, email, phone, description, is_active,
  tags, webhook_incoming_url, webhook_secret, pairing_token,
  password_hash, bot_enabled, schedule_enabled, timezone, auto_reply_text,
  api_key_prefix, api_key_created_at, events_webhook_url, events_webhook_secret,
  created_by, created_at, updated_at
`;

function rowToClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    description: row.description,
    isActive: Boolean(row.is_active),
    tags: parseTags(row.tags),
    webhookIncomingUrl: row.webhook_incoming_url,
    webhookSecretConfigured: Boolean(row.webhook_secret),
    pairingToken: row.pairing_token,
    passwordConfigured: Boolean(row.password_hash),
    apiKeyPrefix: row.api_key_prefix || null,
    apiKeyCreatedAt: row.api_key_created_at || null,
    eventsWebhookUrl: row.events_webhook_url || null,
    eventsWebhookSecret: row.events_webhook_secret || null,
    botEnabled: Boolean(row.bot_enabled),
    scheduleEnabled: Boolean(row.schedule_enabled),
    timezone: row.timezone,
    autoReplyText: row.auto_reply_text,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- API keys del cliente (API pública v1) — varias por cliente, con nombre ---
// La key EN CLARO solo viaja en la respuesta de creación; en BD hash + prefijo.
async function listApiKeys(clientId) {
  const [rows] = await pool.execute(
    `SELECT id, name, key_prefix, last_used_at, created_at
     FROM client_api_keys WHERE client_id = ? ORDER BY created_at DESC`,
    [clientId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.key_prefix,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  }));
}

async function createApiKey(clientId, name) {
  const clean = String(name || '').trim().slice(0, 80) || 'key';
  const raw = `xpk_${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 12);
  const [result] = await pool.execute(
    'INSERT INTO client_api_keys (client_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)',
    [clientId, clean, hash, prefix],
  );
  return { id: result.insertId, apiKey: raw, name: clean, prefix };
}

async function deleteApiKey(clientId, keyId) {
  const [result] = await pool.execute(
    'DELETE FROM client_api_keys WHERE id = ? AND client_id = ?',
    [keyId, clientId],
  );
  return result.affectedRows > 0;
}

// --- Webhook de EVENTOS salientes por cliente ---
async function getEventsWebhook(clientId) {
  const [rows] = await pool.execute(
    'SELECT events_webhook_url, events_webhook_secret FROM clients WHERE id = ?',
    [clientId],
  );
  const r = rows[0] || null;
  return r ? { url: r.events_webhook_url, secret: r.events_webhook_secret } : null;
}

// Fija la URL; si no hay secret aún (o regenerate=true) genera uno nuevo.
// El secret se guarda en claro: hace falta para FIRMAR (HMAC) cada entrega.
async function setEventsWebhook(clientId, url, regenerateSecret = false) {
  const cleanUrl = String(url || '').trim() || null;
  const current = await getEventsWebhook(clientId);
  let secret = current?.secret || null;
  if (cleanUrl && (!secret || regenerateSecret)) {
    secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  }
  if (!cleanUrl) secret = null; // quitar URL = desactivar eventos
  await pool.execute(
    'UPDATE clients SET events_webhook_url = ?, events_webhook_secret = ? WHERE id = ?',
    [cleanUrl, secret, clientId],
  );
  return { url: cleanUrl, secret };
}

function generatePairingToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 hex chars
}

function parseTags(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}

function normalizeTags(input) {
  if (input == null) return null;
  if (!Array.isArray(input)) return [];
  return input
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 50);
}

async function listClients({ activeOnly = false } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  const [rows] = await pool.query(
    `SELECT ${SELECT_FIELDS} FROM clients ${where} ORDER BY id DESC`,
  );
  return rows.map(rowToClient);
}

async function getClient(id) {
  const [rows] = await pool.execute(
    `SELECT ${SELECT_FIELDS} FROM clients WHERE id = ?`,
    [id],
  );
  return rowToClient(rows[0]);
}

// Devuelve el cliente incluyendo el webhook_secret raw — solo uso interno (validación
// del endpoint público /api/webhooks/chatbot). Nunca exponer en la API REST.
async function getClientWithSecrets(id) {
  const [rows] = await pool.execute(
    'SELECT id, webhook_incoming_url, webhook_secret, is_active FROM clients WHERE id = ?',
    [id],
  );
  return rows[0] || null;
}

async function createClient(input, createdBy) {
  const name = String(input?.name || '').trim();
  if (!name) {
    const e = new Error('name es requerido');
    e.code = 'VALIDATION';
    throw e;
  }
  const email = input?.email ? String(input.email).trim() : null;
  const phone = input?.phone ? String(input.phone).trim() : null;
  const description = input?.description != null ? String(input.description) : null;
  const isActive = input?.isActive === false ? 0 : 1;
  const tags = normalizeTags(input?.tags);
  const webhookUrl = input?.webhookIncomingUrl ? String(input.webhookIncomingUrl).trim() : null;
  const webhookSecret = input?.webhookSecret ? String(input.webhookSecret) : null;

  if (webhookUrl) validateUrl(webhookUrl);

  const pairingToken = generatePairingToken();

  const [result] = await pool.execute(
    `INSERT INTO clients
      (name, email, phone, description, is_active, tags, webhook_incoming_url, webhook_secret, pairing_token, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, email, phone, description, isActive, tags ? JSON.stringify(tags) : null, webhookUrl, webhookSecret, pairingToken, createdBy || null],
  );
  return getClient(result.insertId);
}

async function regeneratePairingToken(id) {
  const current = await getClient(id);
  if (!current) return null;
  const newToken = generatePairingToken();
  await pool.execute('UPDATE clients SET pairing_token = ? WHERE id = ?', [newToken, id]);
  return getClient(id);
}

async function findByPairingToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [rows] = await pool.execute(
    `SELECT ${SELECT_FIELDS} FROM clients WHERE pairing_token = ? LIMIT 1`,
    [token],
  );
  return rowToClient(rows[0]);
}

async function updateClient(id, input) {
  const current = await getClient(id);
  if (!current) return null;

  const fields = [];
  const params = [];

  if (input?.name !== undefined) {
    const name = String(input.name || '').trim();
    if (!name) {
      const e = new Error('name no puede estar vacío');
      e.code = 'VALIDATION';
      throw e;
    }
    fields.push('name = ?'); params.push(name);
  }
  if (input?.email !== undefined) {
    fields.push('email = ?');
    params.push(input.email ? String(input.email).trim() : null);
  }
  if (input?.phone !== undefined) {
    fields.push('phone = ?');
    params.push(input.phone ? String(input.phone).trim() : null);
  }
  if (input?.description !== undefined) {
    fields.push('description = ?');
    params.push(input.description != null ? String(input.description) : null);
  }
  if (input?.isActive !== undefined) {
    fields.push('is_active = ?'); params.push(input.isActive ? 1 : 0);
  }
  if (input?.tags !== undefined) {
    const tags = normalizeTags(input.tags);
    fields.push('tags = ?'); params.push(tags ? JSON.stringify(tags) : null);
  }
  if (input?.webhookIncomingUrl !== undefined) {
    const url = input.webhookIncomingUrl ? String(input.webhookIncomingUrl).trim() : null;
    if (url) validateUrl(url);
    fields.push('webhook_incoming_url = ?'); params.push(url);
  }
  if (input?.webhookSecret !== undefined) {
    fields.push('webhook_secret = ?');
    params.push(input.webhookSecret ? String(input.webhookSecret) : null);
  }

  if (fields.length === 0) return current;

  params.push(id);
  await pool.execute(`UPDATE clients SET ${fields.join(', ')} WHERE id = ?`, params);
  return getClient(id);
}

// Asigna/resetea la contraseña del panel del cliente (la pone el admin).
// Al cambiarla, cierra todas las sesiones de panel abiertas del cliente.
async function setClientPassword(id, plainPassword) {
  const pwd = String(plainPassword || '');
  if (pwd.length < 8) {
    const e = new Error('La contraseña debe tener al menos 8 caracteres');
    e.code = 'VALIDATION';
    throw e;
  }
  const current = await getClient(id);
  if (!current) return null;
  const hash = await bcrypt.hash(pwd, BCRYPT_ROUNDS);
  await pool.execute('UPDATE clients SET password_hash = ? WHERE id = ?', [hash, id]);
  await pool.execute('DELETE FROM client_sessions WHERE client_id = ?', [id]).catch(() => {});
  return getClient(id);
}

async function deleteClient(id) {
  // Las sesiones de WA se borran por ON DELETE CASCADE. El caller (routes)
  // se encarga de cerrar/limpiar los ficheros de auth en disco antes.
  const [result] = await pool.execute('DELETE FROM clients WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

function validateUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      const e = new Error('webhookIncomingUrl debe empezar por http:// o https://');
      e.code = 'VALIDATION';
      throw e;
    }
  } catch (err) {
    if (err.code === 'VALIDATION') throw err;
    const e = new Error('webhookIncomingUrl inválida');
    e.code = 'VALIDATION';
    throw e;
  }
}

module.exports = {
  listApiKeys,
  createApiKey,
  deleteApiKey,
  getEventsWebhook,
  setEventsWebhook,
  listClients,
  getClient,
  getClientWithSecrets,
  createClient,
  updateClient,
  deleteClient,
  regeneratePairingToken,
  findByPairingToken,
  setClientPassword,
};
